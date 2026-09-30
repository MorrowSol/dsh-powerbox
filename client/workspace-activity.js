/**
 * dsh-workspace-activity — 浏览器半区（本包的全部实现都在这里）。
 *
 * 解决的问题：侧边栏把工作区折叠后，里面正在执行的会话行不再渲染
 * （官方 ui-workspace 的派生层在折叠时把 `group.sessions` 置空），
 * 于是「这个工作区有会话在跑」这件事在折叠状态下从界面上消失了。
 *
 * 做法（三句话）：
 *   1. 从官方客户端服务读事实：`ctx.sessions.list`（会话列表快照，含 running）
 *      与 `ctx.workspaces.list`（工作区归属、归档集合）。
 *   2. 按官方口径算出「哪些工作区里有可见且正在跑的会话」，给对应的侧边栏
 *      工作区行打一个自有属性 `data-dsh-wsact="run"`。
 *   3. 由本包注入的 CSS 在 `aria-expanded="false"`（折叠）时把该行的文件夹
 *      图标改成蓝色 + 脉冲圆点的活动形态。
 *
 * 约束：不 import 任何 @deepseek-ai 包（只 require 无）、不改官方源码、
 * 不依赖官方 CSS module 的哈希类名、不注册任何槽位；判定「折叠」完全交给
 * CSS，因此展开/折叠不需要重跑 JS。所有副作用都挂在插件 fiber 上，
 * 卸载后 DOM 属性、样式标签、订阅与 observer 全部回收。
 *
 * 自检：加载后可在控制台执行 `__dshWorkspaceActivity.probe()` 打印本插件
 * 当前看到的工作区行、映射结果与标记状态（纯 JSON，不含任何 live 对象）。
 */
/* ===== dsh-powerbox · client/workspace-activity.js =====
 * 原 dsh-workspace-activity 客户端半区整体平移：
 * 工作区折叠时若有会话在跑，把文件夹图标画成第 4 态（蓝色 + 脉冲圆点）。
 * 工具箱开关：关闭时两个 effect 全部拆除（样式移除、退订、Observer 断开、
 * 标记清空），重新打开即重建。
 * 由 scripts/build-client.mjs 拼接进 client.js，共享外层的 React / E / TK。
 */

	{
		/** 打在工作区行上的自有标记属性；只在折叠时被 CSS 使用。 */
		var ATTR = 'data-dsh-wsact';
		/** 工作区行的候选集合：官方把 `aria-expanded` 只放在工作区分组行上。 */
		var SEL = '[role="treeitem"][aria-expanded]';
		/** 第 4 态的样式锚点：折叠 + 本包标记 + 行首图标槽。 */
		var MARK = '[role="treeitem"][aria-expanded="false"][' + ATTR + '="run"] > span:first-child';

		/**
		 * 第 4 态视觉：图标染成与官方「执行中」圆点同色的蓝（#5686fe，
		 * 主题变量 --dsw-static-deepseek-450），加一层圆形底晕，右下角一个
		 * 脉冲小圆点。`prefers-reduced-motion` 下不动画。
		 */
		var CSS = [
			MARK + '{position:relative;color:var(--dsw-static-deepseek-450,#5686fe)}',
			MARK + '::before{content:"";position:absolute;inset:0;border-radius:50%;background:rgba(86,134,254,.14);background:color-mix(in srgb,currentColor 14%,transparent)}',
			MARK + '::after{content:"";position:absolute;right:-1px;bottom:0;width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 0 1.5px var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#fff));animation:dsh-wsact-pulse 1.6s ease-in-out infinite}',
			'@keyframes dsh-wsact-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}',
			'@media (prefers-reduced-motion:reduce){' + MARK + '::after{animation:none}}',
		].join('');

		/** 折叠空白、去掉首尾空格的文本比较（工作区行标题用它对齐）。 */
		function normText(value) {
			return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
		}

		/** 同一原因只告警一次，避免 MutationObserver 把控制台刷爆。 */
		function warnOnce(seen, key, message) {
			if (seen.has(key)) return;
			seen.add(key);
			console.warn('[workspace-activity] ' + message);
		}

		/** 是否是「服务/快照源」：同时具备 getSnapshot 与 subscribe。 */
		function isSource(value) {
			return value !== null && value !== undefined && typeof value.getSnapshot === 'function' && typeof value.subscribe === 'function';
		}

		/**
		 * 一个 DOM 行是否是工作区分组行。
		 *
		 * 只认产品语义（role / aria-*）+ 结构（行首是含 svg 的图标槽），
		 * 不碰官方 CSS module 的哈希类名。排除项：
		 *   - 会话行（带 aria-selected）；
		 *   - 子会话谱系行（带 aria-level，且同样会用 aria-expanded）；
		 *   - 任何弹层/对话框内的行。
		 */
		function isWorkspaceRow(row) {
			if (row === null || row === undefined || typeof row.getAttribute !== 'function') return false;
			if (row.getAttribute('aria-selected') !== null) return false;
			if (row.getAttribute('aria-level') !== null) return false;
			if (typeof row.closest === 'function' && row.closest('[role="dialog"],[aria-modal="true"]') !== null) return false;
			var first = row.firstElementChild;
			if (first === null || first === undefined || first.tagName !== 'SPAN') return false;
			var glyph = first.firstElementChild;
			return glyph !== null && glyph !== undefined && String(glyph.tagName).toLowerCase() === 'svg';
		}

		/** 文档顺序收集工作区分组行（顺序即官方渲染顺序＝工作区顺序，未归组桶在最后）。 */
		function collectRows() {
			var found = document.querySelectorAll(SEL);
			var rows = [];
			for (var i = 0; i < found.length; i += 1) {
				if (isWorkspaceRow(found[i])) rows.push(found[i]);
			}
			return rows;
		}

		/**
		 * 子会话 descendants 索引，逐行照抄官方 ui-workspace 的
		 * `indexSubagentDescendants`：把每个 running 的子会话沿 parentId 链
		 * 累加到它的每一级父会话上，于是父会话能知道「有子孙在跑」。
		 */
		function indexSubagentDescendants(byId) {
			var indexed = new Map();
			var keys = Object.keys(byId);
			for (var k = 0; k < keys.length; k += 1) {
				var descendant = byId[keys[k]];
				if (descendant === undefined || descendant === null || descendant.origin !== 'subagent') continue;
				var seen = new Set();
				var cursor = descendant;
				while (cursor !== undefined && cursor !== null && cursor.origin === 'subagent' && cursor.parentId !== undefined && !seen.has(cursor.id)) {
					seen.add(cursor.id);
					var aggregate = indexed.get(cursor.parentId);
					if (aggregate === undefined) indexed.set(cursor.parentId, { count: 1, runningCount: descendant.running === true ? 1 : 0 });
					else {
						aggregate.count += 1;
						if (descendant.running === true) aggregate.runningCount += 1;
					}
					cursor = byId[cursor.parentId];
				}
			}
			return indexed;
		}

		/**
		 * 算「每个分组是否有活动会话」。
		 *
		 * 可见性口径与官方一致：子会话不进分组、归档的哪里都不显示、空的
		 * （blank）会话只有当前选中那一个可见。活动口径：自身 running，或
		 * 有 running 的子孙子会话（与官方状态圆点的「子孙在执行」一致）。
		 *
		 * @param list - `sessions.list` 快照（ids / byId / current）。
		 * @param snapshot - `workspaces.list` 快照（items / archivedSessionIds）。
		 * @returns Map，键为 workspaceId，未归组桶固定用 ''。
		 */
		function computeActivity(list, snapshot) {
			var byId = (list !== null && list !== undefined && list.byId !== null && list.byId !== undefined && typeof list.byId === 'object') ? list.byId : {};
			var ids = (list !== null && list !== undefined && Array.isArray(list.ids)) ? list.ids : [];
			var current = (list === null || list === undefined) ? undefined : list.current;
			var rawArchived = (snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.archivedSessionIds)) ? snapshot.archivedSessionIds : [];
			var archived = new Set(rawArchived);
			var items = (snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.items)) ? snapshot.items : [];
			var descendants = indexSubagentDescendants(byId);
			var isVisible = function (summary) {
				return summary !== undefined && summary !== null && summary.origin !== 'subagent' && !archived.has(summary.id) && (!summary.blank || summary.id === current);
			};
			var isActive = function (summary) {
				if (summary.running === true) return true;
				var aggregate = descendants.get(summary.id);
				return aggregate !== undefined && aggregate.runningCount > 0;
			};
			var activity = new Map();
			var accounted = new Set();
			for (var i = 0; i < items.length; i += 1) {
				var workspace = items[i];
				var members = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
				var hit = false;
				for (var m = 0; m < members.length; m += 1) {
					var summary = byId[members[m]];
					if (summary !== undefined && summary !== null) accounted.add(members[m]);
					if (isVisible(summary) && isActive(summary)) hit = true;
				}
				activity.set(workspace.workspaceId, hit);
			}
			var stray = false;
			for (var n = 0; n < ids.length; n += 1) {
				var loose = byId[ids[n]];
				if (loose === undefined || loose === null || accounted.has(loose.id) || !isVisible(loose)) continue;
				if (isActive(loose)) { stray = true; break; }
			}
			activity.set('', stray);
			return activity;
		}

		/**
		 * 把「哪些行该亮」对齐到实际 DOM 行。
		 *
		 * 顺序权威：官方按工作区顺序渲染分组、未归组桶排最后，所以行序 =
		 * 工作区序（末尾可选多一个未归组行）。写属性前先核对数量与行标题，
		 * 任何对不上就放弃这一行/这一轮（宁可漏标，不可错标）。
		 *
		 * @param rows - `collectRows()` 的结果。
		 * @param items - 工作区列表（`workspaces.list` 快照的 items）。
		 * @param activity - `computeActivity` 的结果。
		 * @param seen - 告警去重集合。
		 * @returns { applied: number, skipped: boolean } 便于自检与测试。
		 */
		function markRows(rows, items, activity, seen) {
			if (rows.length === 0) return { applied: 0, skipped: true };
			var withUngrouped = rows.length === items.length + 1;
			if (rows.length !== items.length && !withUngrouped) {
				warnOnce(seen, 'rows', 'found ' + rows.length + ' workspace rows for ' + items.length + ' workspaces; skipping this paint');
				return { applied: 0, skipped: true };
			}
			var applied = 0;
			for (var i = 0; i < rows.length; i += 1) {
				var row = rows[i];
				var key;
				if (i < items.length) {
					if (normText(row.textContent) !== normText(items[i].title)) {
						warnOnce(seen, 'title-' + items[i].workspaceId, 'row ' + i + ' text does not match workspace title; skipping that row');
						continue;
					}
					key = items[i].workspaceId;
				} else {
					key = '';
				}
				if (activity.get(key) === true) {
					if (row.getAttribute(ATTR) !== 'run') row.setAttribute(ATTR, 'run');
					applied += 1;
				} else if (row.getAttribute(ATTR) !== null) {
					row.removeAttribute(ATTR);
				}
			}
			return { applied: applied, skipped: false };
		}

		/**
		 * 造一个「重画」函数：读两份快照 → 找行 → 对齐 → 打/清标记。
		 * @param sessionList - sessions 列表快照源。
		 * @param workspaceList - workspaces 快照源。
		 * @param seen - 告警去重集合。
		 * @returns 无参的 paint 函数。
		 */
		function makePainter(sessionList, workspaceList, seen) {
			return function paint() {
				var snapshot = workspaceList.getSnapshot();
				if (snapshot === null || snapshot === undefined || !Array.isArray(snapshot.items)) return { applied: 0, skipped: true };
				var items = snapshot.items;
				var rows = collectRows();
				var activity = computeActivity(sessionList.getSnapshot(), snapshot);
				return markRows(rows, items, activity, seen);
			};
		}

		/**
		 * 自检探针：把本插件「现在看到什么」摊成纯 JSON。
		 * 供控制台排查（官方升级改变行结构时，这里一眼能看出断在哪一步）。
		 * @returns {{ workspaces: number, rows: number, applied: number, detail: Array }} 纯数据。
		 */
		function probe(sessionList, workspaceList, seen) {
			var snapshot = workspaceList.getSnapshot();
			var items = (snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.items)) ? snapshot.items : [];
			var rows = collectRows();
			var activity = computeActivity(sessionList.getSnapshot(), snapshot);
			var detail = [];
			for (var i = 0; i < rows.length; i += 1) {
				var key = i < items.length ? items[i].workspaceId : '';
				detail.push({
					index: i,
					key: String(key),
					title: normText(rows[i].textContent),
					expected: i < items.length ? normText(items[i].title) : '(未归组)',
					running: activity.get(key) === true,
					marked: rows[i].getAttribute(ATTR),
				});
			}
			return { workspaces: items.length, rows: rows.length, applied: markRows(rows, items, activity, seen).applied, detail: detail };
		}

		/**
		 * 挂载：样式 + 标记逻辑各是一份可回收副作用。
		 * `inject` 已声明依赖 sessions / workspaces，Cordis 会在两个服务就绪
		 * 后才激活本插件，服务被卸载时也会把本插件一起挂起。
		 *
		 * @param ctx - 客户端插件上下文（已注入 sessions、workspaces）。
		 */
		function apply(ctx, api) {
			if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
				console.warn('[workspace-activity] needs a browser with document and MutationObserver');
				return;
			}
			var sessionList = (ctx.sessions !== null && ctx.sessions !== undefined) ? ctx.sessions.list : undefined;
			var workspaceList = (ctx.workspaces !== null && ctx.workspaces !== undefined) ? ctx.workspaces.list : undefined;
			if (!isSource(sessionList) || !isSource(workspaceList)) {
				console.warn('[workspace-activity] sessions.list / workspaces.list are unavailable, so running sessions cannot be observed');
				return;
			}
			/** 原样式 effect：样式标签的建立与回收（幂等：热替换先移除旧标签）。 */
			function setupStyles() {
				const stale = document.head.querySelector('style[data-dsh-workspace-activity]');
				if (stale) stale.remove();
				var tag = document.createElement('style');
				tag.dataset.dshWorkspaceActivity = '';
				tag.textContent = CSS;
				document.head.append(tag);
				return function () { tag.remove(); };
			}
			/** 原标记 effect：订阅两份快照 + MutationObserver + 自检探针 + 首帧绘制。 */
			function setupMarks() {
				var seen = new Set();
				var paint = makePainter(sessionList, workspaceList, seen);
				var scheduled = false;
				var schedule = function () {
					if (scheduled) return;
					scheduled = true;
					Promise.resolve().then(function () {
						scheduled = false;
						paint();
					});
				};
				var offs = [sessionList, workspaceList].map(function (source) { return source.subscribe(schedule); });
				// 只监听 childList/subtree：不监听 attribute，避免自己写属性自激；
				// React 复用行元素时属性会保留，真被换掉时这里立刻补写。
				var observer = new MutationObserver(schedule);
				observer.observe(document.body, { childList: true, subtree: true });
				if (typeof window !== 'undefined') {
					window.__dshWorkspaceActivity = { probe: function () { return probe(sessionList, workspaceList, seen); } };
				}
				paint();
				return function () {
					for (var i = 0; i < offs.length; i += 1) {
						try { offs[i](); } catch (error) { console.warn('[workspace-activity] unsubscribe failed: ' + error.message); }
					}
					observer.disconnect();
					if (typeof window !== 'undefined') delete window.__dshWorkspaceActivity;
					var marked = document.querySelectorAll('[' + ATTR + ']');
					for (var m = 0; m < marked.length; m += 1) marked[m].removeAttribute(ATTR);
				};
			}
			// 工具箱开关：开启时建立（样式 + 标记），关闭时整体拆除；切换由 api 驱动。
			var cleanups = null;
			var sync = function () {
				var want = (api === undefined || api === null || typeof api.on !== 'function' || api.on('workspace-activity'));
				if (want && cleanups === null) {
					cleanups = [setupStyles(), setupMarks()];
				} else if (!want && cleanups !== null) {
					for (var i = 0; i < cleanups.length; i += 1) {
						try { cleanups[i](); } catch (error) { console.warn('[workspace-activity] teardown failed: ' + error.message); }
					}
					cleanups = null;
				}
			};
			sync();
			var offApi = (api !== undefined && api !== null && typeof api.onChange === 'function') ? api.onChange(sync) : undefined;
			// 插件卸载：退订 api 并强制拆除（无论开关当前状态）。
			return function () {
				if (typeof offApi === 'function') offApi();
				if (cleanups !== null) {
					for (var i = 0; i < cleanups.length; i += 1) {
						try { cleanups[i](); } catch (error) { console.warn('[workspace-activity] teardown failed: ' + error.message); }
					}
					cleanups = null;
				}
			};
		}

		TK.features['workspace-activity'] = { mount: function (ctx, api) { return apply(ctx, api); } };
	}
