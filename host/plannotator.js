/**
 * dsh-plannotator-embedded — host half.
 *
 * Takes over plan-mode reviews: when the exit_plan_mode tool asks its
 * plan-review user question, this plugin claims the request (prepended
 * listener) and parks it as a pending review instead of letting the native
 * chat card answer it. The browser panel polls `pending` over a
 * package-private Connection RPC channel and submits the user's decision.
 *
 * Multiple reviews may be parked at once (concurrent sessions, several plans
 * in one session, subagent sessions): every review is stored under its own
 * `reviewId` and a decision names the exact one it answers, so one review can
 * never silently replace another.
 *
 * Fallback: if no browser has been alive recently (heartbeat via the same
 * channel), the request is passed through to the native flow so a closed
 * WebUI can never deadlock the model.
 *
 * New-DSH note: `HostConnectionService.register()` mounts the channel route
 * through `ctx.webServer` resolved on the *connection row's own context*
 * (the reader binding does not survive the `.rpc` shadow), so the `connection`
 * row itself must declare `webServer`. This package's bundle patch
 * (cordis.patch.yml) overrides that row with `inject: [webRuntime, webServer]`.
 * Consumer-side inject only needs `connection`.
 */

const CHANNEL = '/plannotator';
const CLIENT_STALE_MS = 3000;

function ok(value) {
	return { ok: true, value };
}

function fail(code, message) {
	return { ok: false, error: { code, message, details: {} } };
}

/**
 * Map a panel decision to the exit_plan_mode answer shape.
 * - approve: select the approve option; `custom` MUST stay undefined.
 * - feedback: empty selection plus the notes as `custom` (keep-planning).
 * - dismiss: throw the ASK_CANCELLED UserQuestionError the tool understands.
 * @param {{id: string, approve: string}} q normalized question face
 * @param {'approve'|'feedback'|'dismiss'} decision
 * @param {string} feedback
 */
export function answerFor(q, decision, feedback) {
	if (decision === 'approve') {
		return { answers: [{ id: q.id, selected: [q.approve] }] };
	}
	if (decision === 'feedback') {
		return { answers: [{ id: q.id, selected: [], custom: feedback }] };
	}
	const error = new Error('The user dismissed the plan review to answer in chat instead');
	error.name = 'UserQuestionError';
	error.code = 'ASK_CANCELLED';
	throw error;
}

/** Find the plan-review question inside a user-questions request. */
export function findPlanReview(request) {
	if (request === null || typeof request !== 'object' || !Array.isArray(request.questions)) return null;
	for (const item of request.questions) {
		if (item && typeof item === 'object' && item.intent && item.intent.kind === 'plan-review') return item;
	}
	return null;
}

/**
 * Extract the owning session identity and lineage from a user-questions
 * request so the browser can label each plan with its session.
 *
 * `agent.session.id` is the live session identity (the two are on the same
 * axis); `agent.id` is the client-safe fallback. Everything else is
 * best-effort: a request without a live agent, or a live session without a
 * header, yields nulls instead of throwing.
 *
 * @param {object} request user-questions request event.
 * @param {(session: object) => (object | undefined)} [titleOf] optional title lookup (`ctx.sessionTitle.get`).
 * @returns {{sessionId: string|null, sessionTitle: string|null, cwd: string|null, parentSessionId: string|null, origin: 'subagent'|null, delegationDepth: number|null}}
 */
export function reviewSessionOf(request, titleOf) {
	const agent = request && typeof request === 'object' ? request.agent : undefined;
	const session = agent && typeof agent === 'object' ? agent.session : undefined;
	const sessionId = session && typeof session.id === 'string'
		? session.id
		: (agent && typeof agent.id === 'string' ? agent.id : null);
	const header = session && typeof session === 'object' && session.header && typeof session.header === 'object'
		? session.header
		: null;
	let sessionTitle = null;
	if (session && typeof titleOf === 'function') {
		try {
			const snapshot = titleOf(session);
			if (snapshot && typeof snapshot.title === 'string' && snapshot.title !== '') sessionTitle = snapshot.title;
		} catch (error) {
			sessionTitle = null;
		}
	}
	return {
		sessionId,
		sessionTitle,
		cwd: header && typeof header.cwd === 'string' ? header.cwd : null,
		parentSessionId: header && typeof header.parentSession === 'string' ? header.parentSession : null,
		origin: header && header.origin === 'subagent' ? 'subagent' : null,
		delegationDepth: header && typeof header.delegationDepth === 'number' ? header.delegationDepth : null,
	};
}

/**
 * Keyed store of plan reviews awaiting a decision.
 *
 * `add` guarantees a unique `reviewId` (a same-millisecond collision gets a
 * numeric suffix), `list` is FIFO by `createdAt`, and `take` removes exactly
 * one review — the property the previous single-slot implementation lacked.
 *
 * @returns {{nextId: (now?: number) => string, add: (review: object, resolver: Function) => object, list: () => object[], take: (reviewId: string) => ({review: object, resolver: Function} | null), size: () => number}}
 */
export function createReviewQueue() {
	const byId = new Map();
	let seq = 0;

	function nextId(now) {
		seq += 1;
		const stamp = (typeof now === 'number' ? now : Date.now()).toString(36);
		return `pttr-${stamp}-${seq.toString(36)}`;
	}

	function add(review, resolver) {
		const base = review && typeof review.reviewId === 'string' && review.reviewId !== ''
			? review.reviewId
			: nextId();
		let reviewId = base;
		let suffix = 2;
		while (byId.has(reviewId)) {
			reviewId = `${base}-${suffix}`;
			suffix += 1;
		}
		const stored = Object.assign({}, review, {
			reviewId,
			createdAt: review && typeof review.createdAt === 'number' ? review.createdAt : Date.now(),
		});
		byId.set(reviewId, { review: stored, resolver });
		return stored;
	}

	function list() {
		return Array.from(byId.values())
			.map(function (entry) { return entry.review; })
			.sort(function (a, b) { return a.createdAt - b.createdAt; });
	}

	function take(reviewId) {
		if (typeof reviewId !== 'string' || reviewId === '') return null;
		const entry = byId.get(reviewId);
		if (entry === undefined) return null;
		byId.delete(reviewId);
		return entry;
	}

	function size() {
		return byId.size;
	}

	return { nextId, add, list, take, size };
}

export const inject = ['connection'];

/**
 * 插件入口（工具箱合并版）。
 * @param ctx 插件上下文（需要 connection / sessionTitle 服务）。
 * @param {{featureOn?: (name: string) => boolean}} [opts] 工具箱开关：
 *   `featureOn('plannotator')` 为 false 时监听器一律 `next()` 放行原生评审卡片；
 *   已被接管的在途评审不受影响（RPC 通道保持在线，面板可继续决策）。
 */
export function apply(ctx, opts = {}) {
	const featureOn = typeof opts.featureOn === 'function' ? opts.featureOn : () => true;
	// 合并包里本模块与其它三个功能同宿主挂载：connection 不在场时整体静默跳过
	// （真实 profile 里 connection 由本行 inject 声明，不会缺失；这里只为测试
	// 与异常环境兜底）。
	if (ctx.connection === undefined) return;
	let lastSeen = 0;
	const queue = createReviewQueue();
	const titleOf = function (session) {
		try {
			const service = ctx.get('sessionTitle');
			return service && typeof service.get === 'function' ? service.get(session) : undefined;
		} catch (error) {
			return undefined;
		}
	};

	ctx.connection.rpc.handle(CHANNEL, async (endpoint, payload) => {
		lastSeen = Date.now();
		if (endpoint === 'hello') {
			return ok({ alive: true });
		}
		if (endpoint === 'pending') {
			// enabled：工具箱开关的当前值（向后兼容字段；旧客户端会忽略）。
			return ok({ reviews: queue.list(), enabled: featureOn('plannotator') });
		}
		if (endpoint === 'decide') {
			const a = payload && typeof payload === 'object' ? payload : {};
			const decision = typeof a.decision === 'string' ? a.decision : '';
			const feedback = typeof a.feedback === 'string' ? a.feedback : '';
			const reviewId = typeof a.reviewId === 'string' ? a.reviewId : '';
			let entry = null;
			if (reviewId !== '') {
				entry = queue.take(reviewId);
				if (entry === null) return fail('no-pending', `plan review ${reviewId} is no longer waiting for a decision`);
			} else if (queue.size() === 1) {
				// Compatibility with a client that predates reviewId: answer the sole pending review.
				entry = queue.take(queue.list()[0].reviewId);
			}
			if (entry === null) return fail('no-pending', 'no plan review is waiting for a decision');
			entry.resolver({ decision, feedback, reviewId: entry.review.reviewId });
			return ok({ accepted: true, reviewId: entry.review.reviewId });
		}
		return fail('unknown-endpoint', `unknown plannotator endpoint: ${String(endpoint)}`);
	});

	ctx.on('user-questions/request', async (request, next) => {
		const q = findPlanReview(request);
		if (q === null) return next();
		// 工具箱开关：关闭时不再接管新的计划评审（现场查表；在途评审照常可决策）。
		if (!featureOn('plannotator')) return next();
		if (Date.now() - lastSeen > CLIENT_STALE_MS) {
			console.log('plannotator: client not alive, delegating plan review to native flow');
			return next();
		}
		const options = Array.isArray(q.options) ? q.options : [];
		let declineLabel = null;
		for (const o of options) {
			if (o && typeof o.label === 'string' && o.label !== q.intent.approve) {
				declineLabel = o.label;
				break;
			}
		}
		const sessionInfo = reviewSessionOf(request, titleOf);
		const review = {
			question: typeof q.question === 'string' ? q.question : '',
			header: typeof q.header === 'string' ? q.header : 'Plan review',
			plan: typeof q.detail === 'string' ? q.detail : '',
			approveLabel: q.intent.approve,
			declineLabel,
			createdAt: Date.now(),
			sessionId: sessionInfo.sessionId,
			sessionTitle: sessionInfo.sessionTitle,
			cwd: sessionInfo.cwd,
			parentSessionId: sessionInfo.parentSessionId,
			origin: sessionInfo.origin,
			delegationDepth: sessionInfo.delegationDepth,
		};
		try {
			return await new Promise((resolve, reject) => {
				const signal = request && typeof request === 'object' ? request.signal : undefined;
				const reviewIdRef = { current: null };
				let settled = false;
				const settle = (fn, value) => {
					if (settled) return;
					settled = true;
					if (signal) signal.removeEventListener('abort', onAbort);
					if (reviewIdRef.current !== null) queue.take(reviewIdRef.current);
					fn(value);
				};
				const onAbort = () => {
					settle(reject, new Error('plannotator: plan review aborted'));
				};
				const onDecide = (raw) => {
					const decision = raw && (raw.decision === 'approve' || raw.decision === 'feedback') ? raw.decision : 'dismiss';
					const feedback = raw && typeof raw.feedback === 'string' ? raw.feedback : '';
					try {
						settle(resolve, answerFor({ id: q.id, approve: q.intent.approve }, decision, feedback));
					} catch (error) {
						settle(reject, error);
					}
				};
				if (signal && signal.aborted) {
					onAbort();
					return;
				}
				if (signal) signal.addEventListener('abort', onAbort, { once: true });
				const stored = queue.add(review, onDecide);
				reviewIdRef.current = stored.reviewId;
				console.log(`plannotator: takeover plan review ${stored.reviewId}${stored.sessionId ? ` (session ${stored.sessionId})` : ''}`);
			});
		} catch (error) {
			console.error(`plannotator: review ended: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	}, { prepend: true });
}
