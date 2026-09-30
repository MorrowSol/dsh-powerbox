/**
 * @local/sidebar-button-layout — Client half.
 *
 * Controls how the buttons other plugins contribute to the left sidebar are
 * arranged: the sidebar-foot action row (`sidebar.footer.action`, the seat
 * where the usage-billing and worktree buttons currently collide on one flex
 * row and squeeze each other's labels out of view) and the global panel rows
 * (`sidebar.panellist`).
 *
 * Why CSS on stable DOM hooks: the shell renders list-slot entries as a flat
 * React fragment with no per-entry wrapper element, so a button can only be
 * addressed through its own component DOM (see ENTRY_SELECTORS; panel rows
 * carry `aria-label`). All layout is applied declaratively through ONE
 * <style> element rendered by the shell.overlay entry — this plugin never
 * mutates other components' DOM, and uninstalling it removes every rule.
 * Configuration persists in localStorage and is edited on the plugin's
 * settings.section page ("侧边栏按钮 / Sidebar Buttons").
 */
/* ===== dsh-powerbox · client/sidebar-layout.js =====
 * 原 @local/sidebar-button-layout 客户端半区整体平移：
 * 通过一条只作用于侧栏的 <style> 控制各插件按钮在左侧栏的排列
 * （底部按钮区 sidebar.footer.action + 全局面板行 sidebar.panellist），
 * 布局配置存 localStorage，在「设置 → 侧边栏按钮」页编辑。
 * 工具箱开关：关闭时样式条目与设置页都不渲染（shell 恢复默认布局）。
 * 由 scripts/build-client.mjs 拼接进 client.js，共享外层的 React / E / TK。
 */
{
  const h = React.createElement;
  const useSES = React.useSyncExternalStore;
  /** 工具箱开关引用（apply 时注入；组件在渲染里现场查表）。 */
  let gateApi = null;

    const NS = 'sbl';
    const STORAGE_KEY = 'dsh.sidebar-button-layout.v1';
    const FOOTER_SLOT = 'sidebar.footer.action';
    const PANEL_SLOT = 'sidebar.panellist';
    const FOOTER_GROUP = 'footer';
    const PANEL_GROUP = 'panels';

    /**
     * Per-entry CSS hooks. Keys are the list-slot registration ids; the live
     * footer DOM (verified 2026-09-30) is: footerActions > div[data-slot]
     * (display:contents，壳层自带) > 各按钮根元素。选择器按「后代」匹配，
     * display:contents 让按钮根元素成为 footerActions 的 flex 项，order 生效。
     * Extend this table to teach the plugin about new footer buttons.
     */
    const ENTRY_SELECTORS = {
      'usage-billing': ['[class*="triggerWrap"]', '[data-testid="billing-trigger"]'],
      'clutch-dsh-worktree-mode-action': ['[data-worktree-mode-action]'],
      'context-overview': ['button.lc-ov-entry'],
    };

    const zh = {
      nav: '侧边栏按钮',
      title: '侧边栏按钮布局',
      titleHint: '调整各插件按钮在左侧栏的顺序与可见性；点击「重置全部」一次恢复默认（含布局模式）。',
      modeLabel: '布局模式（底部按钮区）',
      modeAuto: '自动换行（推荐）',
      modeStacked: '竖排',
      modeRow: '单行（默认）',
      footerList: '底部按钮（“设置”上方一行）',
      panelList: '全局面板行',
      moveUp: '上移',
      moveDown: '下移',
      hide: '隐藏',
      show: '显示',
      resetAll: '重置全部',
      empty: '当前没有发现可控制的按钮。',
      probeOk: '已定位',
      probeMiss: '未匹配',
      probeNone: '无锚点',
      probeOkTitle: '该按钮的选择器当前能在侧栏 DOM 中定位到，排序/隐藏规则可生效。',
      probeMissTitle: '未能按选择器在侧栏 DOM 中定位到该按钮——排序/隐藏对它不生效。多为 DSH 或按钮插件更新后类名/结构变化导致。',
      probeNoneTitle: '该按钮当前没有渲染 DOM（或不具备稳定锚点），排序/隐藏暂时不生效；它出现后会被自动纳入控制。',
      actualKids: '侧栏实际子元素',
    };
    const en = {
      nav: 'Sidebar Buttons',
      title: 'Sidebar button layout',
      titleHint: 'Adjust the order and visibility of the plugin buttons in the left sidebar; “Reset all” restores the defaults (layout mode included) at once.',
      modeLabel: 'Layout mode (footer area)',
      modeAuto: 'Auto wrap (recommended)',
      modeStacked: 'Stacked',
      modeRow: 'Single row (default)',
      footerList: 'Footer buttons (the row above “Settings”)',
      panelList: 'Global panel rows',
      moveUp: 'Move up',
      moveDown: 'Move down',
      hide: 'Hide',
      show: 'Show',
      resetAll: 'Reset all',
      empty: 'No controllable buttons found.',
      probeOk: 'located',
      probeMiss: 'no match',
      probeNone: 'no anchor',
      probeOkTitle: 'The selectors currently locate this button in the sidebar DOM; ordering/hiding applies.',
      probeMissTitle: 'The selectors cannot locate this button in the sidebar DOM right now — ordering/hiding has no effect on it. Usually caused by class/structure changes after a DSH or plugin update.',
      probeNoneTitle: 'This button renders no DOM right now (or has no stable anchor) — ordering/hiding is inactive; it joins automatically once it appears.',
      actualKids: 'Actual sidebar children',
    };

    // ---------- persisted configuration ----------
    function defaultConfig() {
      return { mode: 'auto', footer: {}, panels: {} };
    }
    function loadConfig() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) return defaultConfig();
        const parsed = JSON.parse(raw);
        return {
          mode: parsed.mode === 'stacked' || parsed.mode === 'row' ? parsed.mode : 'auto',
          footer: parsed.footer && typeof parsed.footer === 'object' ? parsed.footer : {},
          panels: parsed.panels && typeof parsed.panels === 'object' ? parsed.panels : {},
        };
      } catch {
        return defaultConfig();
      }
    }
    let config = loadConfig();
    let version = 0;
    const listeners = new Set();
    function bump() {
      version += 1;
      for (const listener of listeners) {
        try { listener(); } catch { /* a dead subscriber must not block the rest */ }
      }
    }
    function commit() {
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* private mode etc. */ }
      bump();
    }
    function setMode(mode) {
      config = { ...config, mode };
      commit();
    }
    function updateItem(group, id, patch) {
      config = { ...config, [group]: { ...config[group], [id]: { ...config[group][id], ...patch } } };
      commit();
    }
    /** 一次重置全部：布局模式与所有按钮的顺序/可见性覆盖全部清除。 */
    function resetAll() {
      config = defaultConfig();
      commit();
    }
    /** 是否存在任何自定义（用于决定「重置全部」是否可点）。 */
    function hasOverrides() {
      return config.mode !== 'auto' || Object.keys(config.footer).length > 0 || Object.keys(config.panels).length > 0;
    }
    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
    function getSnapshot() {
      return version;
    }
    function useLayout() {
      useSES(subscribe, getSnapshot);
      return {
        config,
        footer: slotEntries[FOOTER_SLOT],
        panels: slotEntries[PANEL_SLOT],
        wrapperMode,
        footerChildCount,
        footerChildInfo,
      };
    }

    // ---------- live slot entry snapshots ----------
    const slotEntries = { [FOOTER_SLOT]: [], [PANEL_SLOT]: [] };
    /**
     * 底部按钮区是否被一个无类名 <div> 包装（实测：footerActions 的唯一子元素
     * 是一个 div，全部按钮都在它里面）。包装时用 display:contents 把按钮提升为
     * footerActions 的直接 flex 项，排序/隐藏才能生效；并把 DOM 位置映射锚定在
     * 包装层内（wrapper > *:nth-child）。每次槽位快照刷新时重测。
     */
    let wrapperMode = false;
    let footerChildCount = 0;
    let footerChildInfo = '';
    function detectWrapperMode() {
      try {
        const host = document.querySelector(FOOTER);
        const wrapped = !!(host && host.children.length >= 1 && host.children[0].tagName === 'DIV');
        wrapperMode = wrapped;
        const kids = host ? (wrapped ? host.children[0].children : host.children) : [];
        footerChildCount = kids.length;
        footerChildInfo = [...kids]
          .map((el) => {
            const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : '';
            const testid = el.getAttribute('data-testid');
            const label = el.getAttribute('aria-label');
            const worktree = el.hasAttribute('data-worktree-mode-action') ? '[data-worktree-mode-action]' : '';
            return el.tagName.toLowerCase() + cls + (testid ? `[data-testid=${testid}]` : '') + (label ? `[aria-label=${label}]` : '') + worktree;
          })
          .join(' , ');
      } catch {
        wrapperMode = false;
        footerChildCount = 0;
        footerChildInfo = '';
      }
      return wrapperMode;
    }
    function labelOf(options) {
      const label = options.label;
      return typeof label === 'function' ? label() : label;
    }
    function readEntries(ctx, key) {
      return ctx.slots.entriesOfSlot(key)
        .map((entry) => ({
          id: entry.options.id ?? '',
          order: entry.options.order ?? 0,
          label: labelOf(entry.options),
        }))
        // 与 renderSlot 的 DOM 排序完全一致（只按 order、稳定排序）——
        // 底部按钮的 nth-child 位置映射依赖这一点，平局时绝不加 id 比较。
        .sort((a, b) => a.order - b.order);
    }

    /** Display order shared by CSS generation and the settings page. */
    function displayIds(entries, group) {
      return entries
        .map((entry, i) => ({ id: entry.id, key: config[group]?.[entry.id]?.order ?? 1000 + i }))
        .sort((a, b) => a.key - b.key)
        .map((item) => item.id);
    }
    function moveItem(group, id, delta, entries) {
      const ids = displayIds(entries, group);
      const from = ids.indexOf(id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= ids.length) return;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      const next = {};
      ids.forEach((entryId, index) => {
        next[entryId] = { ...config[group]?.[entryId], order: index + 1 };
      });
      config = { ...config, [group]: next };
      commit();
    }

    // ---------- CSS generation ----------
    function escapeAttr(value) {
      return String(value).replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, ' ');
    }
    const FOOTER = '[class*="footerActions"]';
    const PANEL_LIST = '[class*="panelList"]';

    function footerCss(mode, entries, group, wrapper, childCount) {
      const lines = [];
      // 包装层归一化：无类名 div 包装不再占据布局（其子元素成为 footerActions
      // 的直接 flex 项），平铺结构下该规则不命中任何元素，两种结构都正确。
      lines.push(`${FOOTER} > div{display:contents}`);
      if (mode === 'auto') {
        // Both known entries declare width:100%, so wrap alone gives each a
        // full row while a lone button stays on the single shell row.
        lines.push(`${FOOTER}{flex-wrap:wrap;row-gap:4px}`);
      } else if (mode === 'stacked') {
        lines.push(`${FOOTER}{flex-direction:column}`);
        lines.push(`${FOOTER}>*{width:100%}`);
        lines.push(`${FOOTER} > div > *{width:100%}`);
      } // 'row': leave the shell layout untouched
      const orderOf = new Map(displayIds(entries, FOOTER_GROUP).map((id, i) => [id, i + 1]));
      // 未知按钮（无选择器注册）按 DOM 位置兜底——但只有在「条目数 === 实际
      // 子元素数」时才允许：某组件条件渲染 null（不占位）时位置映射会错位，
      // 宁可不控制也不能把隐藏/排序打到别的按钮上。
      const genericReady = childCount === entries.length;
      const genericAt = (i) => (wrapper ? `${FOOTER} > div > *:nth-child(${i + 1})` : `${FOOTER} > *:nth-child(${i + 1})`);
      entries.forEach((entry, i) => {
        const selectors = ENTRY_SELECTORS[entry.id];
        const target = selectors
          ? selectors.map((selector) => `${FOOTER} ${selector}`)
          : genericReady
            ? [genericAt(i)]
            : [];
        if (target.length === 0) return;
        if (group[entry.id]?.hidden) {
          for (const targetSelector of target) lines.push(`${targetSelector}{display:none!important}`);
          return;
        }
        for (const targetSelector of target) {
          lines.push(`${targetSelector}{order:${orderOf.get(entry.id) ?? 0}!important}`);
        }
      });
      // The collapsed rail keeps the shell's own centered icon row.
      lines.push(`[class*="collapsed"] ${FOOTER}{flex-direction:row;flex-wrap:nowrap;row-gap:0}`);
      lines.push(`[class*="collapsed"] ${FOOTER}>*{width:auto}`);
      lines.push(`[class*="collapsed"] ${FOOTER} > div > *{width:auto}`);
      return lines;
    }

    function panelCss(entries, group) {
      const lines = [];
      const orderOf = new Map(displayIds(entries, PANEL_GROUP).map((id, i) => [id, i + 1]));
      for (const entry of entries) {
        const attr = `[aria-label="${escapeAttr(entry.label ?? entry.id)}"]`;
        if (group[entry.id]?.hidden) {
          lines.push(`${PANEL_LIST} > button${attr}{display:none!important}`);
          continue;
        }
        lines.push(`${PANEL_LIST} > button${attr}{order:${orderOf.get(entry.id) ?? 0}!important}`);
      }
      return lines;
    }

    function StyleEntry() {
      // 工具箱开关：关闭时不输出任何 CSS（shell 恢复默认布局）。
      if (gateApi && typeof gateApi.on === 'function' && !gateApi.on('sidebar-layout')) return null;
      const layout = useLayout();
      // 渲染时现测包装层——此刻的 DOM 状态最可信；快照值仅作兜底。
      const wrapper = detectWrapperMode() || layout.wrapperMode;
      const css = [...footerCss(layout.config.mode, layout.footer, layout.config.footer, wrapper, footerChildCount), ...panelCss(layout.panels, layout.config.panels)].join('\n');
      return h('style', { 'data-sidebar-button-layout': '' }, css);
    }

    /**
     * 定位探针：该行的选择器当前是否真的能在侧栏 DOM 中命中。
     * 返回 true/false；null = 该按钮没有注册选择器（无从控制）。
     */
    function probeFooter(entry) {
      const selectors = ENTRY_SELECTORS[entry.id];
      if (!selectors) return null;
      return selectors.some((selector) => {
        try { return document.querySelector(`${FOOTER} ${selector}`) !== null; } catch { return false; }
      });
    }
    function probePanel(entry) {
      try {
        const attr = `[aria-label="${escapeAttr(entry.label ?? entry.id)}"]`;
        return document.querySelector(`${PANEL_LIST} > button${attr}`) !== null;
      } catch { return false; }
    }

    // ---------- settings page ----------
    const SECTION_CSS = `
.sbl-page{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.sbl-head{display:flex;align-items:center;gap:12px}
.sbl-title{margin:0;font-size:14px;font-weight:600;flex:1;min-width:0}
.sbl-reset{flex:none;height:26px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:24px;cursor:pointer;transition:color .12s,border-color .12s,background .12s}
.sbl-reset:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-3)}
.sbl-reset:disabled{cursor:default;opacity:.4}
.sbl-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.sbl-group{display:flex;flex-direction:column;gap:8px}
.sbl-groupLabel{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}
.sbl-modes{display:flex;flex-direction:row;flex-wrap:wrap;gap:6px}
.sbl-radio{position:relative;display:inline-flex;cursor:pointer}
.sbl-radio input{position:absolute;opacity:0;width:1px;height:1px}
.sbl-pill{padding:4px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;transition:all .12s}
.sbl-radio input:checked + .sbl-pill{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}
.sbl-radio input:focus-visible + .sbl-pill{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sbl-radio:hover .sbl-pill{border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}
.sbl-radio input:checked:hover + .sbl-pill{color:var(--dsw-alias-brand-primary)}
.sbl-rows{display:flex;flex-direction:column;gap:2px}
.sbl-row{display:flex;align-items:center;gap:8px;min-height:34px;border:1px solid transparent;border-radius:8px;padding:3px 8px}
.sbl-row:hover{background:var(--dsw-alias-bg-layer-3)}
.sbl-rowLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sbl-rowHidden .sbl-rowLabel{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}
.sbl-rowId{flex:none;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,monospace);font-size:11px}
.sbl-rowActions{flex:none;display:inline-flex;gap:2px}
.sbl-btn{width:26px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:24px;cursor:pointer;text-align:center;transition:background .12s,color .12s}
.sbl-btn:hover:not(:disabled){background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.sbl-btn:disabled{cursor:default;opacity:.3}
.sbl-btnShow{width:auto;padding:0 10px;font-size:12px}
.sbl-btnShow[aria-pressed="true"]{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}
.sbl-probe{flex:none;font-size:10px;line-height:16px;padding:0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.sbl-probeOk{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-tertiary));border-color:currentColor}
.sbl-probeMiss{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary));border-color:currentColor;font-weight:600}
.sbl-actual{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;word-break:break-all}
`;

    /**
     * 一行 = 一个按钮：↑ / ↓ / 隐藏(显示) + 定位探针徽标。`index` 是
     * **显示顺序**里的位置，由调用方（Section）按 displayIds 排好再传入，
     * 保证连点 ↑/↓ 始终有效。
     */
    function EntryRow({ t, entry, index, count, group, entries, matched, unsupported }) {
      const hidden = config[group]?.[entry.id]?.hidden === true;
      const badge =
        matched === true
          ? h('span', { className: 'sbl-probe sbl-probeOk', title: t('probeOkTitle') }, '✓ ' + t('probeOk'))
          : matched === false
            ? h('span', { className: 'sbl-probe sbl-probeMiss', title: t('probeMissTitle') }, '⚠ ' + t('probeMiss'))
            : unsupported
              ? h('span', { className: 'sbl-probe', title: t('probeNoneTitle') }, '— ' + t('probeNone'))
              : null;
      return h('div', { className: `sbl-row${hidden ? ' sbl-rowHidden' : ''}` },
        h('span', { className: 'sbl-rowLabel', title: entry.label ?? entry.id }, entry.label || entry.id),
        h('span', { className: 'sbl-rowId' }, entry.id),
        badge,
        h('span', { className: 'sbl-rowActions' },
          h('button', {
            type: 'button', className: 'sbl-btn', disabled: index === 0,
            'aria-label': t('moveUp'), title: t('moveUp'),
            onClick: () => moveItem(group, entry.id, -1, entries),
          }, '↑'),
          h('button', {
            type: 'button', className: 'sbl-btn', disabled: index === count - 1,
            'aria-label': t('moveDown'), title: t('moveDown'),
            onClick: () => moveItem(group, entry.id, 1, entries),
          }, '↓'),
          h('button', {
            type: 'button', className: 'sbl-btn sbl-btnShow', 'aria-pressed': hidden,
            title: hidden ? t('show') : t('hide'),
            onClick: () => updateItem(group, entry.id, { hidden: !hidden }),
          }, hidden ? t('show') : t('hide')),
        ),
      );
    }

    function Section({ t }) {
      // 工具箱开关：关闭时本设置页不渲染。
      if (gateApi && typeof gateApi.on === 'function' && !gateApi.on('sidebar-layout')) return null;
      const { config: cfg, footer, panels } = useLayout();
      const modes = [['auto', 'modeAuto'], ['stacked', 'modeStacked'], ['row', 'modeRow']];
      const canReset = hasOverrides();
      // 行按**显示顺序**渲染（displayIds：显式 order 优先，未设置按槽位顺序），
      // ↑/↓ 的 index 依据这个列表，连续移动始终生效。
      const list = (title, entries, group, probe, info) => {
        const ordered = displayIds(entries, group)
          .map((id) => entries.find((entry) => entry.id === id))
          .filter(Boolean);
        const matches = new Map(ordered.map((entry) => [entry.id, probe(entry)]));
        // 位置兜底只在「条目数 === 实际子元素数」时启用；没锚点又轮不到兜底的
        // 行（如某插件当前未渲染按钮）明确标出，而不是静默失灵。
        const genericActive = footerChildCount === ordered.length;
        return h('div', { className: 'sbl-group' },
          h('div', { className: 'sbl-groupLabel' }, title),
          ordered.length === 0
            ? h('p', { className: 'sbl-hint' }, t('empty'))
            : h('div', { className: 'sbl-rows' },
              ordered.map((entry, i) => h(EntryRow, {
                key: entry.id, t, entry, index: i, count: ordered.length, group, entries,
                matched: matches.get(entry.id),
                unsupported: matches.get(entry.id) === null && !genericActive,
              }))),
          info
            ? h('p', { className: 'sbl-actual' }, `${t('actualKids')}：${info || '…'}`)
            : null,
        );
      };
      return h('div', { className: 'sbl-page' },
        h('style', null, SECTION_CSS),
        h('div', { className: 'sbl-head' },
          h('h3', { className: 'sbl-title' }, t('title')),
          h('button', {
            type: 'button', className: 'sbl-reset', disabled: !canReset,
            title: t('titleHint'),
            onClick: resetAll,
          }, t('resetAll'))),
        h('p', { className: 'sbl-hint' }, t('titleHint')),
        h('div', { className: 'sbl-group' },
          h('div', { className: 'sbl-groupLabel' }, t('modeLabel')),
          h('div', { className: 'sbl-modes', role: 'radiogroup', 'aria-label': t('modeLabel') },
            modes.map(([value, key]) => h('label', { key: value, className: 'sbl-radio' },
              h('input', {
                type: 'radio', name: 'sbl-mode', checked: cfg.mode === value,
                onChange: () => setMode(value),
              }),
              h('span', { className: 'sbl-pill' }, t(key))))),
        ),
        list(t('footerList'), footer, FOOTER_GROUP, probeFooter, footerChildInfo),
        list(t('panelList'), panels, PANEL_GROUP, probePanel, null),
      );
    }

    // ---------- apply ----------
    function apply(ctx, api) {
      gateApi = api || null;
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sidebar-button-layout: dictionaries');
      // 包装层探测补测：apply 先于壳层渲染执行，此刻侧栏多半还没挂载；
      // 启动后延时补测几次，DOM 一出现即重生成正确的 nth-child 规则。
      ctx.effect(() => {
        const timers = [0, 300, 1200, 3000].map((delay) => setTimeout(() => {
          detectWrapperMode();
          bump();
        }, delay));
        return () => timers.forEach((timer) => clearTimeout(timer));
      }, 'sidebar-button-layout: wrapper detection');
      ctx.effect(() => {
        const refresh = () => {
          for (const key of Object.keys(slotEntries)) slotEntries[key] = readEntries(ctx, key);
          detectWrapperMode();
          bump();
        };
        refresh();
        const offs = Object.keys(slotEntries).map((key) => ctx.slots.subscribe(key, refresh));
        const offLocale = ctx.locale.subscribe(refresh);
        return () => {
          for (const off of offs) off();
          offLocale();
        };
      }, 'sidebar-button-layout: entry snapshots');
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'sidebar-button-layout-style',
        order: 9999,
        locale: NS,
      }, StyleEntry));
      // 设置页不再独立注册 settings.section，交给「工具箱」页以左侧 tab /
      // 右侧内容的方式承载；功能关闭时工具箱页隐藏对应 tab（Section 内部
      // 仍保留 gateApi 门控作为兜底）。
      TK.pages['sidebar-layout'] = {
        render: function () {
          return h(Section, { t });
        },
      };
    }

    TK.features['sidebar-layout'] = { mount: function (ctx, api) { return apply(ctx, api); } };
  }
