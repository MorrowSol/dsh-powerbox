/* ===== dsh-powerbox · client/toolkit-page.js =====
 * 「设置 → 工具箱」页（唯一的 toolkit 设置栏）：
 *   上：四个功能的开关，2x2 紧凑网格；开关行本身是选择器（点击选中，
 *       开关按钮只负责开/关，点击事件 stopPropagation），描述走悬浮
 *       title 与下方设置面板的说明行；
 *   下：选中功能的说明 + 它自己的设置页（如有），全宽。功能数量增长时
 *       网格自然向下扩展，不引入任何横向选择条。
 *
 * 开关写入走 flags.js 的 api（官方 settings 表单通道的 volatile 字段
 * `features`）；各功能设置页通过 `TK.pages.<key> = { render(slotProps) }`
 * 注册（client/permission-extras.js 与 client/sidebar-layout.js），本页统一
 * 承载。文案走 ctx.locale 的 NS 'toolkit' 字典。
 * 由 scripts/build-client.mjs 拼接进 client.js，共享外层的 React / E / TK。
 */

	{
		const NS = 'toolkit';
		const zh = {
			nav: '工具箱',
			title: '工具箱',
			hint: '宿主侧（评审接管、权限放宽）立即生效；界面侧最迟约 10 秒生效。',
			on: '已启用',
			off: '已停用',
			switchesTitle: '功能开关（点击功能名查看其设置）',
			noSettings: '此功能没有单独的设置项。',
			offNote: '该功能已停用，以下设置暂不生效；打开开关后恢复。',
			'name.permission-extras': '自定义权限',
			'desc.permission-extras': '在 workspace-write 之外，按工作区添加附加可写目录（bash 与文件工具同时生效）。关闭后写权限回到官方工作区行为。',
			'name.plannotator': '计划评审面板',
			'desc.plannotator': '用内嵌面板接管 Agent 的计划评审请求（可批注、多计划切换）。关闭后使用原生评审卡片；已在途的评审仍可在面板中继续决策。',
			'name.workspace-activity': '工作区活动指示',
			'desc.workspace-activity': '工作区折叠时若有会话正在运行，把左侧栏的文件夹图标画成活动状态（蓝色 + 脉冲圆点）。',
			'name.sidebar-layout': '侧边栏按钮布局',
			'desc.sidebar-layout': '控制左侧栏各插件按钮的排列方式、顺序与可见性。关闭后恢复 shell 默认布局。',
		};
		const en = {
			nav: 'Toolbox',
			title: 'Toolbox',
			hint: 'Host-side effects apply immediately; UI-side within ~10s.',
			on: 'On',
			off: 'Off',
			switchesTitle: 'Feature switches (click a feature to see its settings)',
			noSettings: 'This feature has no dedicated settings.',
			offNote: 'This feature is currently off — the settings below are not applied until you turn it on.',
			'name.permission-extras': 'Permission extras',
			'desc.permission-extras': 'Per-workspace extra writable directories on top of workspace-write (bash and file tools alike). When off, permissions fall back to the stock workspace-write behavior.',
			'name.plannotator': 'Embedded plan review',
			'desc.plannotator': 'Takes over plan-review requests with an embedded panel (annotations, multi-plan tabs). When off, the native review card is used; in-flight reviews stay decidable.',
			'name.workspace-activity': 'Workspace activity',
			'desc.workspace-activity': 'Marks collapsed workspace rows whose sessions are still running (blue pulsing dot on the folder icon).',
			'name.sidebar-layout': 'Sidebar button layout',
			'desc.sidebar-layout': 'Controls the arrangement, order, and visibility of plugin buttons in the left sidebar. When off, the shell default layout is restored.',
		};

		const PAGE_CSS = `
.tkp-page{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.tkp-title{margin:0;font-size:16px;font-weight:600}
.tkp-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.tkp-sectionLabel{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600}
/* 开关区：一行 = 名称 + 开关，紧凑 2x2；整行是选择器（点击选中下方面板），
   描述见 title 悬浮与下方面板说明行 */
.tkp-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.tkp-row{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:7px 10px 7px 12px;background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-2));cursor:pointer;user-select:none;transition:border-color .12s,box-shadow .12s}
.tkp-row:hover{border-color:var(--dsw-alias-border-l2)}
.tkp-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.tkp-rowActive,.tkp-rowActive:hover{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary) inset}
.tkp-name{flex:1;min-width:0;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tkp-nameOff{color:var(--dsw-alias-label-tertiary)}
.tkp-switch{position:relative;flex:none;width:36px;height:20px;border-radius:10px;border:0;cursor:pointer;background:var(--dsw-alias-border-l2);transition:background .15s}
.tkp-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.tkp-switch:hover{filter:brightness(1.06)}
.tkp-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s}
.tkp-switch[aria-checked="true"] .tkp-knob{left:18px}
/* 设置区：官方设置页风格——无卡片，标题行 + 0.5px 发丝线分行的全宽行 */
.tkp-panel{padding:2px 0 0}
.tkp-panelHead{padding-bottom:12px;margin-bottom:2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.tkp-panelNameLine{display:flex;align-items:center;gap:8px}
.tkp-panelName{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em}
.tkp-panelState{flex:none;font-size:11px;line-height:18px;padding:0 10px;border-radius:999px;color:#15803d;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.35)}
.tkp-panelStateOff{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2)}
.tkp-panelDesc{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.tkp-offNote{margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.tkp-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;padding:6px 0}
.tkp-refresh{display:flex;align-items:center;gap:10px;margin-top:8px;padding:8px 8px 8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary);animation:tkp-fade .15s ease}
.tkp-refreshBtn{flex:none;margin-left:auto;height:26px;padding:0 12px;border:0;border-radius:6px;font:inherit;font-size:12px;font-weight:500;cursor:pointer;background:var(--dsw-alias-label-primary,#111827);color:var(--dsw-alias-bg-base,#fff);transition:opacity .15s}
.tkp-refreshBtn:hover{opacity:.85}
@keyframes tkp-fade{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
`;

		/** 2x2 开关格的一格：整行 = 选择器（点击选中），开关只负责开/关。 */
		function FeatureRow({ t, api, feature, on, selected, onSelect, onToggle }) {
			const name = t('name.' + feature.key) || feature.name.zh;
			const desc = t('desc.' + feature.key) || feature.desc.zh;
			const state = on ? t('on') : t('off');
			return E('div', {
				className: 'tkp-row' + (selected ? ' tkp-rowActive' : ''),
				title: desc,
				role: 'button',
				tabIndex: 0,
				'aria-pressed': selected,
				onClick: onSelect,
				onKeyDown: function (ev) {
					if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(); }
				},
			},
				E('span', { className: 'tkp-name' + (on ? '' : ' tkp-nameOff') }, name),
				E('button', {
					type: 'button',
					className: 'tkp-switch',
					role: 'switch',
					'aria-checked': on,
					'aria-label': name + ' — ' + state,
					title: name + '：' + desc,
					onClick: function (ev) { ev.stopPropagation(); onToggle(!on); },
				},
					E('span', { className: 'tkp-knob' })),
			);
		}

		function ToolkitPage({ api, t, slotProps }) {
			const [snapshot, setSnapshot] = React.useState(function () { return api.dict(); });
			React.useEffect(function () {
				return api.onChange(function () { setSnapshot(api.dict()); });
			}, [api]);
			// 选中状态：默认第一个功能；点击任意开关行切换（与开关启停无关，
			// 停用的功能也能查看其说明与设置）。
			const [sel, setSel] = React.useState(TK.FEATURES[0] ? TK.FEATURES[0].key : null);
			const selected = TK.FEATURES.some(function (f) { return f.key === sel; }) ? sel : (TK.FEATURES[0] ? TK.FEATURES[0].key : null);
			const feature = TK.FEATURES.find(function (f) { return f.key === selected; }) || null;
			const on = feature ? snapshot[feature.key] !== false : false;
			const name = feature ? (t('name.' + feature.key) || feature.name.zh) : '';
			const desc = feature ? (t('desc.' + feature.key) || feature.desc.zh) : '';
			// 切换保存成功后提示「刷新页面生效」，带一键刷新；5s 后自动收起。
			const [refreshHint, setRefreshHint] = React.useState(false);
			const hintTimer = React.useRef(null);
			function toggleFeature(f, next) {
				api.set(f, next).then(function (ok) {
					if (!ok) return;
					setRefreshHint(true);
					if (hintTimer.current) clearTimeout(hintTimer.current);
					hintTimer.current = setTimeout(function () { setRefreshHint(false); }, 5000);
				});
			}
			return E('div', { className: 'tkp-page' },
				E('style', null, PAGE_CSS),
				E('h3', { className: 'tkp-title' }, t('title')),
				E('p', { className: 'tkp-hint' }, t('hint')),
				E('p', { className: 'tkp-sectionLabel' }, t('switchesTitle')),
				E('div', { className: 'tkp-grid' },
					TK.FEATURES.map(function (f) {
						return E(FeatureRow, {
							key: f.key, t, api, feature: f,
							on: snapshot[f.key] !== false,
							selected: f.key === selected,
							onSelect: function () { setSel(f.key); },
							onToggle: function (next) { toggleFeature(f.key, next); },
						});
					}),
				),
				refreshHint ? E('div', { className: 'tkp-refresh' },
					E('span', { className: 'tkp-refreshText' }, '已保存 · 刷新页面后完全生效'),
					E('button', {
						type: 'button',
						className: 'tkp-refreshBtn',
						onClick: function () { window.location.reload(); },
					}, '立即刷新'),
				) : null,
				E('div', { className: 'tkp-panel' },
					E('div', { className: 'tkp-panelHead' },
						E('div', { className: 'tkp-panelNameLine' },
							E('p', { className: 'tkp-panelName' }, name),
							E('span', { className: 'tkp-panelState' + (on ? '' : ' tkp-panelStateOff') }, on ? t('on') : t('off'))),
						E('p', { className: 'tkp-panelDesc' }, desc),
						!on ? E('p', { className: 'tkp-offNote' }, t('offNote')) : null),
					feature && TK.pages[feature.key]
						? TK.pages[feature.key].render(slotProps)
						: E('div', { className: 'tkp-empty' }, t('noSettings')),
				),
			);
		}

		function apply(ctx, api) {
			const slots = ctx.get('slots');
			if (slots === undefined) return;
			ctx.effect(function () { ctx.locale.register(NS, { zh, en }); }, 'toolkit: dictionaries');
			const t = ctx.locale.bind(NS);
			slots.inject('settings.section', function () {
				return slots.register({
					name: 'settings.section',
					id: TK.entryId,
					order: 10,
					locale: NS,
					label: function () { return t('nav'); },
				}, function (slotProps) { return E(ToolkitPage, { api, t, slotProps }); });
			});
		}

		TK.features['toolkit-page'] = { mount: function (ctx, api) { return apply(ctx, api); } };
	}
