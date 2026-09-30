/* ===== dsh-powerbox · client/flags.js =====
 * 工具箱开关的浏览器侧读写（所有 client/ 模块共用一个 api 实例）。
 *
 * 通道与原 dsh-permission-extras 的设置页完全一致（dsh 0.1.7+ 官方 settings
 * 表单模型，volatile 字段）：`remote.settings.describe()` 找 ns === toolkit 的
 * 表单读 `value.features`；`mutate(toolkit, [{op, path:['features', key]}],
 * revision)` 写回 → settings 服务落 profile patch → loader 校验后原地更新
 * 引用并向宿主发 `loader/volatile-update`。宿主执法点每次调用现场查表，
 * 所以宿主侧开关立即生效；客户端侧由本模块 10s 轮询 + 窗口聚焦时刷新。
 *
 * 失败语义：describe/mutate 不可用时 api.on() 一律返回 true（fail-open，
 * 与合并前的四个独立插件行为一致），set() 只在本地置位并告警。
 * 由 scripts/build-client.mjs 拼接进 client.js，共享外层的 React / E / TK。
 */

	/** 四个功能的展示清单（工具箱设置页与此处共用一份）。 */
	TK.FEATURES = [
		{
			key: 'permission-extras',
			name: { zh: '自定义权限', en: 'Permission extras' },
			desc: {
				zh: '「自定义权限」预设：在 workspace-write 之外，按工作区添加附加可写目录（bash 与文件工具同时生效）。关闭后写权限回到官方工作区行为。',
				en: 'Adds per-workspace extra writable directories on top of workspace-write. When off, permissions fall back to the stock workspace-write behavior.',
			},
		},
		{
			key: 'plannotator',
			name: { zh: '计划评审面板', en: 'Embedded plan review' },
			desc: {
				zh: '用内嵌面板接管 Agent 的计划评审请求（可批注、多计划切换）。关闭后使用原生评审卡片；已在途的评审仍可在面板中继续决策。',
				en: 'Takes over plan-review requests with an embedded panel (annotations, multi-plan tabs). When off, the native review card is used; in-flight reviews stay decidable.',
			},
		},
		{
			key: 'workspace-activity',
			name: { zh: '工作区活动指示', en: 'Workspace activity' },
			desc: {
				zh: '工作区折叠时若有会话正在运行，把左侧栏的文件夹图标画成活动状态（蓝色 + 脉冲圆点）。',
				en: 'Marks collapsed workspace rows whose sessions are still running (blue pulsing dot on the folder icon).',
			},
		},
		{
			key: 'sidebar-layout',
			name: { zh: '侧边栏按钮布局', en: 'Sidebar button layout' },
			desc: {
				zh: '控制左侧栏各插件按钮的排列方式、顺序与可见性（「设置 → 侧边栏按钮」页编辑）。关闭后恢复 shell 默认布局。',
				en: 'Controls the arrangement, order, and visibility of plugin buttons in the left sidebar (edited on its own settings page). When off, the shell default layout is restored.',
			},
		},
	];

	/**
	 * 创建工具箱开关客户端。
	 * @param ctx 插件上下文（需要 remote.settings）。
	 * @returns api：on / dict / set / refresh / start / stop / onChange。
	 */
	TK.createFlags = function (ctx) {
		var remoteSettings = ctx.get('remote.settings') || (ctx.remote && ctx.remote.settings);
		var usable = remoteSettings !== undefined && remoteSettings !== null && typeof remoteSettings.describe === 'function' && typeof remoteSettings.mutate === 'function';
		if (!usable) console.warn('toolkit: remote.settings 不可用，工具箱开关退回只读全开');
		var listeners = new Set();
		var dict = {};
		var revision = null;
		var stopPoll = null;
		var onFocus = null;

		function notify() {
			for (var listener of listeners) {
				try { listener(dict); } catch (e) { console.warn('toolkit: flag listener failed', e); }
			}
		}

		function applyForms(value) {
			/* settings.describe 的真实响应形状是 { namespaces: [{ns, value, revision}] }
			   （与 permission-extras 的目录通道一致，实测可写）。旧实现读
			   `forms` 形状永远落空 → dict 恒为 {} → 开关恒显启用且写入失败。 */
			var list = Array.isArray(value) ? value : Array.isArray(value && value.namespaces) ? value.namespaces : [];
			var form = null;
			for (var i = 0; i < list.length; i += 1) {
				if (list[i] && list[i].ns === TK.entryId) { form = list[i]; break; }
			}
			if (!form) return false;
			if (typeof form.revision === 'number') revision = form.revision;
			var next = form.value && form.value.features && typeof form.value.features === 'object' ? form.value.features : {};
			var changed = JSON.stringify(next) !== JSON.stringify(dict);
			dict = next;
			return changed;
		}

		function refresh() {
			if (!usable) return Promise.resolve(false);
			return remoteSettings.describe().then(function (response) {
				if (!response || response.ok !== true) throw new Error((response && response.error && response.error.message) || 'settings.describe 失败');
				if (applyForms(response.value)) notify();
				return true;
			}, function () { return false; });
		}

		var api = {
			/** 开关查询：缺省（无记录 / 通道不可用）= 启用。 */
			on: function (name) { return dict[name] !== false; },
			/** 当前开关快照（设置页渲染用）。 */
			dict: function () { return Object.assign({}, dict); },
			/** 立即向宿主 describe 一次（窗口聚焦等场景）。 */
			refresh: refresh,
			/** 订阅变化（同步通知 + 首次订阅时补发一次当前值）。 */
			onChange: function (listener) {
				listeners.add(listener);
				return function () { listeners.delete(listener); };
			},
			/** 翻转开关：本地乐观置位 → mutate 落库 → 失败回滚并告警。
			 *  注意必须写显式布尔（set false），不能用 unset——unset 删除键后会
			 *  落回「缺省启用」语义，等于没关。 */
			set: function (name, enabled) {
				var want = !!enabled;
				if (!usable) return Promise.resolve(false);
				var previous = dict;
				dict = Object.assign({}, dict, { [name]: want });
				notify();
				var ops = [{ op: 'set', path: ['features', name], value: want }];
				return remoteSettings.mutate(TK.entryId, ops, revision).then(function (response) {
					if (!response || response.ok !== true) throw new Error((response && response.error && response.error.message) || 'settings.mutate 失败');
					if (typeof response.value === 'number') revision = response.value;
					return refresh().then(function () { return true; });
				}, function (error) {
					console.warn('toolkit: 开关写入失败', error);
					dict = previous;
					notify();
					return false;
				});
			},
			/** 启动轮询（10s + 窗口聚焦时刷新）。 */
			start: function () {
				refresh();
				if (stopPoll !== null) return;
				if (typeof ctx.interval === 'function') {
					stopPoll = ctx.interval(function () { refresh(); }, 10000);
				} else {
					var timer = setInterval(function () { refresh(); }, 10000);
					stopPoll = function () { clearInterval(timer); };
				}
				if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
					onFocus = function () { refresh(); };
					window.addEventListener('focus', onFocus);
				}
			},
			stop: function () {
				if (stopPoll !== null) { stopPoll(); stopPoll = null; }
				if (onFocus !== null && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
					window.removeEventListener('focus', onFocus);
					onFocus = null;
				}
			},
		};
		return api;
	};
