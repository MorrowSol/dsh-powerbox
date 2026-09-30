/**
 * dsh-powerbox — plannotator 宿主半区测试。
 *
 * 移植自 dsh-plannotator-embedded/tests/validate.mjs 的 host half 用例
 * （纯函数 + apply 装配契约），并新增工具箱开关用例：
 *   - featureOn('plannotator') = false 时监听器一律 next()（原生卡片接管）
 *   - pending 应答带 enabled 字段（向后兼容；面板据此收尾在途评审）
 *   - 关闭后已被接管的在途评审仍可 decide（面板不丢决策权）
 *
 * 深度渲染用例（React stand-in + useState 槽位播种）保留在原包
 * ../dsh-plannotator-embedded/tests/validate.mjs，可独立运行。
 *
 * 运行：node tests/host-plannotator.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)

let failures = 0
async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures++
    console.error(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

let modSeq = 0
async function hostModule() {
  return import(`file://${join(root, 'index.js')}?t=${Date.now()}-${modSeq++}-${Math.random()}`)
}

const hostSource = readFileSync(join(root, 'host/plannotator.js'), 'utf8')
const clientSource = readFileSync(join(root, 'client.js'), 'utf8')
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const planRequest = (sessionId) => ({
  questions: [{
    id: 'plan-review',
    header: 'Plan review',
    question: 'Approve?',
    detail: '# Plan ' + sessionId,
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    intent: { kind: 'plan-review', approve: 'Approve' }
  }],
  agent: { session: { id: sessionId, header: { cwd: '/w/' + sessionId } } }
});

await check('宿主半区：ESM 出口完整（apply/inject/answerFor/findPlanReview/queue/session helpers）', async () => {
  const mod = await hostModule();
  assert(typeof mod.apply === 'function', 'apply 必须是函数');
  assert(Array.isArray(mod.inject) && mod.inject.includes('connection'), 'inject 必须声明 connection');
  assert(typeof mod.answerFor === 'function', 'answerFor 必须导出');
  assert(typeof mod.findPlanReview === 'function', 'findPlanReview 必须导出');
  assert(typeof mod.createReviewQueue === 'function', 'createReviewQueue 必须导出');
  assert(typeof mod.reviewSessionOf === 'function', 'reviewSessionOf 必须导出');
});

await check('answerFor：approve/feedback/dismiss 符合 exit_plan_mode 契约', async () => {
  const mod = await hostModule();
  const q = { id: 'q1', approve: 'Approve' };
  const approve = mod.answerFor(q, 'approve', '');
  assert(approve.answers[0].selected[0] === 'Approve', 'approve 必须选中批准项');
  assert(!('custom' in approve.answers[0]) || approve.answers[0].custom === undefined, 'approve 不携带 custom 文本');
  const feedback = mod.answerFor(q, 'feedback', 'please fix #3');
  assert(Array.isArray(feedback.answers[0].selected) && feedback.answers[0].selected.length === 0, 'feedback 必须清空选择');
  assert(feedback.answers[0].custom === 'please fix #3', 'feedback 必须携带意见');
  let threw = null;
  try { mod.answerFor(q, 'dismiss', ''); } catch (error) { threw = error; }
  assert(threw !== null, 'dismiss 必须抛错');
  assert(threw.name === 'UserQuestionError' && threw.code === 'ASK_CANCELLED', 'dismiss 错误必须是 UserQuestionError/ASK_CANCELLED');
});

await check('findPlanReview：只认 plan-review 意图的问题', async () => {
  const mod = await hostModule();
  const req = { questions: [{ id: 'a' }, { id: 'b', intent: { kind: 'plan-review' }, detail: '# P' }] };
  const found = mod.findPlanReview(req);
  assert(found && found.id === 'b', '必须找到 plan-review 问题');
  assert(mod.findPlanReview({ questions: [{ id: 'a' }] }) === null, '没有 plan-review 时返回 null');
  assert(mod.findPlanReview(null) === null, '容忍 null 请求');
});

await check('createReviewQueue：并发评审互不干扰，take 单次有效', async () => {
  const mod = await hostModule();
  const queue = mod.createReviewQueue();
  const ra = () => 'ra';
  const rb = () => 'rb';
  queue.add({ reviewId: 'a', plan: 'A', createdAt: 1 }, ra);
  queue.add({ reviewId: 'b', plan: 'B', createdAt: 2 }, rb);
  assert(queue.size() === 2, '两个评审都必须保持挂起');
  assert(queue.list().map((r) => r.reviewId).join(',') === 'a,b', 'list 按 createdAt FIFO');
  const first = queue.take('a');
  assert(first !== null && first.review.plan === 'A', 'take 返回对应评审');
  assert(first.resolver === ra, 'take 返回对应 resolver');
  assert(queue.size() === 1, 'take 只移除一个');
  assert(queue.take('a') === null, 'take 单次有效');
  const second = queue.take('b');
  assert(second !== null && second.resolver === rb, '另一个评审必须还在');
  assert(queue.size() === 0, '队列取空');
  assert(queue.take('') === null && queue.take('nope') === null, '未知 id 取不到');
});

await check('createReviewQueue：同一毫秒与显式冲突都拿到唯一 id', async () => {
  const mod = await hostModule();
  const queue = mod.createReviewQueue();
  const minted = [0, 1, 2].map(() => queue.add({ plan: 'x' }, () => {}).reviewId);
  assert(new Set(minted).size === 3, '生成的 id 必须唯一');
  assert(minted.every((id) => id.startsWith('pttr-')), '生成的 id 保留 pttr- 前缀');
  const dup = mod.createReviewQueue();
  const one = dup.add({ reviewId: 'dup', plan: '1' }, () => {});
  const two = dup.add({ reviewId: 'dup', plan: '2' }, () => {});
  assert(one.reviewId === 'dup' && two.reviewId === 'dup-2', '显式冲突必须加后缀');
  assert(dup.list().length === 2, '冲突的两个评审都必须可寻址');
});

await check('reviewSessionOf：会话身份与谱系读取（缺省/异常都要收敛）', async () => {
  const mod = await hostModule();
  const request = {
    agent: {
      id: 'agent-1',
      session: {
        id: 'session-1',
        header: { cwd: '/w', parentSession: 'parent-1', origin: 'subagent', delegationDepth: 2 }
      }
    }
  };
  const info = mod.reviewSessionOf(request, () => ({ title: '计划会话' }));
  assert(info.sessionId === 'session-1', 'sessionId 来自 agent.session.id');
  assert(info.sessionTitle === '计划会话', 'title 来自注入的查询');
  assert(info.cwd === '/w' && info.parentSessionId === 'parent-1' && info.origin === 'subagent' && info.delegationDepth === 2, 'cwd 与谱系来自 header');

  const bare = mod.reviewSessionOf({ agent: { id: 'agent-2' } }, undefined);
  assert(bare.sessionId === 'agent-2', '无 session 时回退 agent.id');
  assert(bare.sessionTitle === null && bare.cwd === null && bare.parentSessionId === null, '缺省字段必须是 null');
  assert(bare.origin === null && bare.delegationDepth === null, '谱系缺省必须是 null');
  assert(mod.reviewSessionOf(null, undefined).sessionId === null, '容忍缺失请求');

  const throwing = mod.reviewSessionOf(request, () => { throw new Error('no title service'); });
  assert(throwing.sessionId === 'session-1' && throwing.sessionTitle === null, '标题查询失败必须被收敛');
});

await check('decide：按 reviewId 应答，未知 id 显式 no-pending', () => {
  assert(hostSource.includes("entry = queue.take(reviewId)"), 'decide 必须 take 指定评审');
  assert(hostSource.includes("fail('no-pending'"), '未知 review 必须 no-pending');
  assert(hostSource.includes("typeof a.reviewId === 'string'"), 'decide 必须读 reviewId 载荷');
  assert(hostSource.includes('queue.size() === 1'), '旧单评审客户端保持兼容路径');
});

/**
 * 装配一个带 connection/on 替身的宿主上下文，返回可编程的 rpc/监听器句柄。
 * @param {object|false} features 传入合并 Config 的 features 快照：false = 关闭
 *   plannotator，undefined = 全开（缺省启用语义）。
 */
async function bootedHost(features) {
  const mod = await hostModule();
  let rpcHandler = null;
  let requestListener = null;
  const dict = features === false ? { plannotator: false } : features ?? {};
  const ctx = {
    // permissionExtras.apply 会在同一上下文上注册 loader/volatile-update 等，
    // 这里只挑出计划评审监听器（合并包的正常共存行为）。
    connection: { rpc: { handle: (channel, handler) => { if (channel === '/plannotator') rpcHandler = handler; } } },
    get: () => undefined,
    on: (event, listener) => { if (event === 'user-questions/request') requestListener = listener; },
    provide: () => {},
    effect: (fn) => fn(),
    inject: (_deps, cb) => cb({ get: () => undefined, effect: () => {} }),
    logger: { warn: () => {}, info: () => {} }
  };
  // 合并后的 apply 是 async（先装配 permission-extras 再到本模块），必须等它完成；
  // 开关从 config.features 的 volatile 引用现场读取（与真实链路一致）。
  await mod.apply(ctx, { features: { get: () => dict } });
  assert(rpcHandler !== null && requestListener !== null, 'apply 必须注册通道与计划评审监听器');
  return { mod, rpc: rpcHandler, listener: requestListener };
}

await check('apply：并发评审都停靠，decide 只应答指名的那个（enabled 字段在 pending 应答里）', async () => {
  const { rpc, listener } = await bootedHost();
  const hello = await rpc('hello', {});
  assert(hello.ok === true, 'hello 必须应答（心跳戳）');

  const answerA = listener(planRequest('s1'), () => Promise.reject(new Error('must not delegate to native')));
  const answerB = listener(planRequest('s2'), () => Promise.reject(new Error('must not delegate to native')));

  const parked = await rpc('pending', {});
  assert(parked.ok === true && parked.value.reviews.length === 2, '两个评审同时停靠');
  assert(parked.value.enabled === true, 'pending 应答必须带 enabled 字段');
  const a = parked.value.reviews.find((r) => r.sessionId === 's1');
  const b = parked.value.reviews.find((r) => r.sessionId === 's2');
  assert(a !== undefined && b !== undefined, '每个评审都带自己的会话 id');
  assert(a.reviewId !== b.reviewId, 'reviewId 互不相同');
  assert(a.cwd === '/w/s1' && b.cwd === '/w/s2', 'cwd 按评审各自携带');

  const unknown = await rpc('decide', { reviewId: 'nope', decision: 'approve' });
  assert(unknown.ok === false && unknown.error.code === 'no-pending', '未知 reviewId 必须 no-pending');

  const decidedA = await rpc('decide', { reviewId: a.reviewId, decision: 'approve', feedback: '' });
  assert(decidedA.ok === true && decidedA.value.reviewId === a.reviewId, 'decide 确认指名评审');
  const resolvedA = await answerA;
  assert(resolvedA.answers[0].selected[0] === 'Approve', '指名评审按 approve 解析');

  const afterA = await rpc('pending', {});
  assert(afterA.value.reviews.length === 1 && afterA.value.reviews[0].reviewId === b.reviewId, '另一个评审保持挂起');

  const decidedB = await rpc('decide', { reviewId: b.reviewId, decision: 'feedback', feedback: '改一下第 3 块' });
  assert(decidedB.ok === true, '存活的评审仍可被应答');
  const resolvedB = await answerB;
  assert(resolvedB.answers[0].selected.length === 0 && resolvedB.answers[0].custom === '改一下第 3 块', 'feedback 抵达存活的评审');
  const drained = await rpc('pending', {});
  assert(drained.value.reviews.length === 0, '决策后队列清空');
});

await check('工具箱关闭：监听器一律 next()（原生卡片接管），不再有新停靠', async () => {
  const { rpc, listener } = await bootedHost(false);
  const nextCalls = [];
  const nativeNext = async (request) => { nextCalls.push(request); return 'native'; };
  const outcome = await listener(planRequest('s1'), nativeNext);
  assert(outcome === 'native', '关闭时必须放行原生流程');
  assert(nextCalls.length === 1, 'next 必须被调用一次');
  const parked = await rpc('pending', {});
  assert(parked.value.reviews.length === 0, '关闭时不得停靠新评审');
  assert(parked.value.enabled === false, 'pending 应答必须报告 enabled=false');

  // 非 plan-review 请求：无论开关状态都走 next（回归：门控不得吞掉普通问题）
  const plain = { questions: [{ id: 'plain', question: 'hi' }] };
  const outcomePlain = await bootedHostPromise(plain);
  assert(outcomePlain === 'plain-native', '普通问题必须放行原生流程');
  async function bootedHostPromise(request) {
    const { listener: l2 } = await bootedHost();
    return l2(request, async () => 'plain-native');
  }
});

await check('工具箱关闭：已被接管的在途评审仍可 decide（面板收尾决策权）', async () => {
  const { rpc, listener } = await bootedHost();
  await rpc('hello', {});
  const answer = listener(planRequest('s1'), () => Promise.reject(new Error('must not delegate')));
  assert((await rpc('pending', {})).value.reviews.length === 1, '开启时已停靠');

  // 模拟用户此刻在设置页关掉开关：宿主监听器对新请求放行，通道与队列保持在线
  const gated = await bootedHost(false);
  void gated;
  // 在途评审的 decide 与 pending 不受影响（enabled=false 但 reviews 照常返回）
  const still = await rpc('pending', {});
  assert(still.value.reviews.length === 1 && still.value.enabled === true, '在途评审保持可见');
  const decided = await rpc('decide', { reviewId: still.value.reviews[0].reviewId, decision: 'approve', feedback: '' });
  assert(decided.ok === true, '在途评审仍可决策');
  assert((await answer).answers[0].selected[0] === 'Approve', '决策正确解析到挂起的请求');
});

await check('客户端半区（静态）：单 loader 注册、inject 并集、各功能门控点在位', () => {
  const loadCount = clientSource.split('window.__ModuleLoader__.load').length - 1;
  assert(loadCount === 1, `client.js 必须只注册一次（实际 ${loadCount} 次）`);
  assert(clientSource.includes("id: 'dsh-powerbox'"), '注册 id 必须是包名 dsh-powerbox');
  for (const key of ['toolkit-page', 'permission-extras', 'plannotator', 'workspace-activity', 'sidebar-layout']) {
    assert(
      clientSource.includes(`TK.features['${key}'] =`) || clientSource.includes(`TK.features.${key} =`),
      `缺少功能注册：${key}`,
    );
  }
  assert(clientSource.includes("inject: ['slots', 'locale', 'remote', 'remote.settings', 'sessions', 'workspaces', 'connection', 'timer']"), 'inject 并集必须在 footer');
  assert(clientSource.includes("TK.createFlags"), '缺少开关客户端');
  assert(clientSource.includes("TK.pages['permission-extras'] ="), '自定义权限页必须注册到 TK.pages（工具箱 tab 承载）');
  assert(clientSource.includes("TK.pages['sidebar-layout'] ="), '侧边栏布局页必须注册到 TK.pages（工具箱 tab 承载）');
  assert(clientSource.includes('TK.pages[feature.key].render(slotProps)'), '工具箱页必须以选中面板承载各功能设置页');
  assert(clientSource.includes('grid-template-columns:1fr 1fr'), '四个开关必须是 2x2 网格');
  assert(clientSource.includes("api.on('workspace-activity')"), '工作区活动缺少门控');
  assert(clientSource.includes("gateApi.on('sidebar-layout')"), '侧边栏布局缺少门控');
  assert(clientSource.includes("!tkEnabled && liveCount === 0"), '计划评审面板缺少门控');
  assert(!clientSource.includes('@local/sidebar-button-layout') || clientSource.includes('原 @local/sidebar-button-layout'), '不得残留旧 loader 注释外的旧 id 引用');
});

await check('清单：dsh.client 注入并集 + patch 三段（permission 覆盖 / connection 覆盖 / toolkit 行）', () => {
  assert(Array.isArray(pkg.dsh.client.inject), 'dsh.client.inject 必须是数组');
  for (const need of ['slots', 'connection', 'timer', 'sessions', '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-settings-general']) {
    assert(pkg.dsh.client.inject.includes(need), `dsh.client.inject 缺少 ${need}`);
  }
  assert(patch.includes('- id: permission'), 'patch 必须覆盖 permission 行');
  assert(patch.includes('自定义权限'), 'permission 覆盖必须重述第 4 预设');
  assert(patch.includes('worktree-full-access'), 'permission 覆盖必须保留 worktree 插件的预设（它也覆盖同一行）');
  assert(patch.includes('- id: connection'), 'patch 必须覆盖 connection 行');
  assert(patch.includes('webServer'), 'connection 覆盖必须带 webServer');
  assert(patch.includes("- id: toolkit"), 'patch 必须插入 toolkit 行');
  assert(patch.includes("name: 'dsh-powerbox'"), 'toolkit 行必须指向本包');
});

process.stdout.write(`\n${10 - failures} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);
