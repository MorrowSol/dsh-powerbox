/**
 * dsh-permission-extras — 客户端半（Client half）。
 *
 * 「设置 → 自定义权限」整页：按工作区维护「自定义权限」的附加可写目录。
 *
 * 数据通道是**官方 settings 表单**（profile entry `permission-extras` 的 volatile
 * 字段 `workspaces`），不是私有 RPC：
 * 本部署的宿主窗口并没有 `connection` 服务（`dsh-client-connection` 只有浏览器
 * 半边），插件无法注册私有 channel。dsh 0.1.7 起设置页枚举「各 profile entry 的
 * Config volatile 字段」，客户端用 `remote.settings` 读写：
 *   - 读：`describe()` → 找 ns === 'permission-extras' 的表单，取 `value.workspaces`
 *   - 写：`mutate('permission-extras', [{op:'set'|'unset', path:['workspaces', <工作区>]}], revision)`
 * 目录是否真实存在等校验由宿主在读入时规范化（旧 validate 钩子已随版本移除）。
 *
 * 说明：官方 `/permission` 弹窗与「设置 → 通用 → 权限」由预设表驱动，本插件在
 * host bundle 补丁里追加了第 4 个预设，因此两处会自动出现「自定义权限」，
 * 本文件不需要（也不应该）替换官方 UI。
 */

/* ===== dsh-powerbox · client/permission-extras.js =====
 * 原 dsh-permission-extras 客户端半区整体平移：
 * 「设置 → 自定义权限」整页（按工作区维护附加可写目录，走官方 settings 表单通道）。
 * 工具箱开关：功能关闭时本设置页不渲染（宿主执法点同时直通官方行为）。
 * 由 scripts/build-client.mjs 拼接进 client.js，共享外层的 React / E / TK。
 */

  {
    var SETTINGS_NS = TK.entryId

    var CSS = [
      /* Vercel / Linear 风：白卡片 + 柔和阴影 + 前景反色主按钮 + Lucide 线性图标
         间距体系：区块间 24 / 标签-控件 8 / 列表项内边距 12-16 */
      '.dpe-root{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.dpe-card{background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 2px 6px rgba(0,0,0,.03);padding:16px;display:flex;flex-direction:column;gap:24px}',
      '.dpe-field{display:flex;flex-direction:column;gap:8px}',
      '.dpe-label{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;cursor:default}',
      '.dpe-count{min-width:18px;height:18px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;text-align:center;font-weight:500}',
      '.dpe-info{display:inline-flex;cursor:help;color:var(--dsw-alias-label-tertiary);transition:color .15s}',
      '.dpe-info:hover{color:var(--dsw-alias-label-secondary)}',
      '.dpe-select,.dpe-input{height:40px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);padding:0 14px;font:inherit;font-size:14px;min-width:0;box-sizing:border-box;transition:border-color .15s,box-shadow .15s,background .15s}',
      '.dpe-select{appearance:none;-webkit-appearance:none;width:100%;flex:0 0 auto;padding-right:36px;text-overflow:ellipsis;background-image:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%239ca3af%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22m6 9 6 6 6-6%22/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center}',
      '.dpe-select option{font-size:14px;padding:10px}',
      '.dpe-select:hover,.dpe-input:hover{border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}',
      '.dpe-select:focus,.dpe-input:focus{outline:none;border-color:var(--dsw-alias-label-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-label-primary) 15%,transparent)}',
      '.dpe-select:disabled,.dpe-input:disabled{opacity:.5;cursor:default}',
      '.dpe-input{flex:1}',
      '.dpe-input::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-tertiary,#9ca3af) 75%,transparent)}',
      /* 连体输入组：与上方列表拉开 16px，区分「已有」与「新增」。
         主按钮用「前景反色」（浅色主题≈纯黑）作页面视觉锚点；主题里的
         brand-primary 偏浅，会把主操作衬得像禁用态。 */
      '.dpe-add{display:flex;align-items:stretch;margin-top:8px}',
      '.dpe-input{border-top-right-radius:0;border-bottom-right-radius:0}',
      '.dpe-add .dpe-btn{margin-left:-1px;border:1px solid transparent;border-top-left-radius:0;border-bottom-left-radius:0;min-width:96px;padding:0 20px;box-shadow:0 1px 2px rgba(0,0,0,.12)}',
      '.dpe-btn{flex:none;height:40px;border-radius:8px;padding:0 16px;font:inherit;font-size:14px;font-weight:500;cursor:pointer;transition:opacity .15s,background .15s,color .15s}',
      '.dpe-btn:disabled{cursor:default;opacity:.45}',
      '.dpe-btn-primary{background:var(--dsw-alias-label-primary,#111827);color:var(--dsw-alias-bg-base,#fff)}',
      '.dpe-btn-primary:hover:not(:disabled){opacity:.85}',
      '.dpe-btn-primary:active:not(:disabled){opacity:.72}',
      /* 目录列表：可见的浅灰容器（7% 前景色混合）+ 发丝边框；悬停加深；删除钮默认灰、悬停红 */
      '.dpe-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}',
      /* 统一规格：选择框 / 目录项 / 添加输入框全部 40px 高、左右 14px 内边距，
         文字左缘均在 15px（14 padding + 1 border）处对齐 */
      '.dpe-item{display:flex;align-items:center;gap:8px;height:32px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:0 10px 0 14px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#6b7280) 7%,transparent);transition:background .15s,border-color .15s}',
      '.dpe-item:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#6b7280) 11%,transparent);border-color:var(--dsw-alias-border-l2)}',
      '.dpe-path{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all;color:var(--dsw-alias-label-primary)}',
      '.dpe-remove{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .15s,background .15s}',
      '.dpe-remove:hover{color:var(--dsw-alias-state-error-primary,#dc2626);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 12%,transparent)}',
      '.dpe-error{color:var(--dsw-alias-state-error-primary,#dc2626);font-size:12px;line-height:18px}',
      '.dpe-empty,.dpe-busy{padding:12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:center}',
    ].join('')

    /**
     * settings namespace 通道：读 `describe()`、写 `mutate()`，都走官方通道。
     * @param remoteSettings `ctx.remote.settings`。
     * @returns {{read: Function, setRoots: Function}} 通道。
     */
    function createSettingsChannel(remoteSettings) {
      function describe() {
        return remoteSettings.describe().then(function (response) {
          if (!response || response.ok !== true) {
            throw new Error((response && response.error && response.error.message) || 'settings.describe 失败')
          }
          var namespaces = (response.value && response.value.namespaces) || []
          var found = null
          for (var i = 0; i < namespaces.length; i += 1) {
            if (namespaces[i] && namespaces[i].ns === SETTINGS_NS) found = namespaces[i]
          }
          if (found === null) {
            throw new Error(
              '宿主没有提供「' +
                SETTINGS_NS +
                '」的配置表单：宿主侧插件未加载、未启动或 dsh 版本过旧（需要 0.1.7+ 的 volatile 配置表单模型）。',
            )
          }
          var value = found.value && typeof found.value === 'object' ? found.value : {}
          var table = value.workspaces && typeof value.workspaces === 'object' ? value.workspaces : {}
          return { workspaces: table, revision: found.revision }
        })
      }

      /**
       * 写入某个工作区的附加目录。
       * @param {string} workspacePath 工作区路径（settings 的键）。
       * @param {string[]} roots 新的附加目录列表；空数组表示删除该工作区条目。
       * @param {number} revision describe() 拿到的 revision。
       * @returns {Promise<object>} 刷新后的视图。
       */
      function setRoots(workspacePath, roots, revision) {
        var ops =
          roots.length === 0
            ? [{ op: 'unset', path: ['workspaces', workspacePath] }]
            : [{ op: 'set', path: ['workspaces', workspacePath], value: { roots: roots } }]
        return remoteSettings.mutate(SETTINGS_NS, ops, revision).then(function (response) {
          if (!response || response.ok !== true) {
            throw new Error((response && response.error && response.error.message) || 'settings 写入失败')
          }
          return response.value
        })
      }

      return { read: describe, setRoots: setRoots }
    }

    /** 取可读错误文本。 */
    function messageOf(error) {
      return String(error && error.message ? error.message : error)
    }

    /** 设置页组件。 */
    function Section(props) {
      var channel = props.channel
      var useWorkspaces = props.useWorkspaces
      var state = React.useState({ status: 'loading', error: null, table: {}, revision: 0 })
      var snapshot = state[0]
      var setSnapshot = state[1]
      var pickState = React.useState('')
      var picked = pickState[0]
      var setPicked = pickState[1]
      var pathState = React.useState('')
      var path = pathState[0]
      var setPath = pathState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      var workspaces = []
      if (typeof useWorkspaces === 'function') {
        var workspaceSnapshot = useWorkspaces(function (value) {
          return value
        })
        if (workspaceSnapshot && Array.isArray(workspaceSnapshot.items)) workspaces = workspaceSnapshot.items
      }

      var reload = React.useCallback(
        function () {
          return channel
            .read()
            .then(function (next) {
              setSnapshot({ status: 'ready', error: null, table: next.workspaces, revision: next.revision })
            })
            .catch(function (error) {
              setSnapshot({ status: 'ready', error: messageOf(error), table: {}, revision: 0 })
            })
        },
        [channel, setSnapshot],
      )

      React.useEffect(
        function () {
          reload()
        },
        [reload],
      )

      // 默认选中第一个工作区；列表来自槽位标准 props，不需要额外往返。
      React.useEffect(
        function () {
          if (picked !== '' || workspaces.length === 0) return
          setPicked(workspaces[0].path)
        },
        [picked, workspaces, setPicked],
      )

      var failWith = React.useCallback(
        function (error) {
          setSnapshot(function (previous) {
            return { status: previous.status, table: previous.table, revision: previous.revision, error: messageOf(error) }
          })
        },
        [setSnapshot],
      )

      var write = React.useCallback(
        function (nextRoots, clearInput) {
          if (picked === '') return Promise.resolve()
          setBusy(true)
          return channel
            .setRoots(picked, nextRoots, snapshot.revision)
            .then(function () {
              if (clearInput) setPath('')
              return reload()
            })
            .catch(failWith)
            .then(function () {
              setBusy(false)
            })
        },
        [channel, picked, snapshot.revision, setBusy, setPath, reload, failWith],
      )

      var rootsFor = React.useCallback(
        function (workspacePath) {
          var entry = snapshot.table[workspacePath]
          var list = entry && Array.isArray(entry.roots) ? entry.roots : []
          return list.slice()
        },
        [snapshot.table],
      )

      var roots = picked === '' ? [] : rootsFor(picked)

      var onAdd = React.useCallback(
        function () {
          if (busy || picked === '') return
          var target = path.trim()
          if (target === '') return
          if (roots.indexOf(target) !== -1) {
            failWith('该目录已在列表中。')
            return
          }
          write(roots.concat([target]), true)
        },
        [busy, picked, path, roots, write, failWith],
      )

      var onRemove = React.useCallback(
        function (root) {
          if (busy || picked === '') return
          var next = []
          for (var i = 0; i < roots.length; i += 1) if (roots[i] !== root) next.push(roots[i])
          write(next, false)
        },
        [busy, picked, roots, write],
      )

      var onKeyDown = React.useCallback(
        function (event) {
          if (event.key === 'Enter') {
            event.preventDefault()
            onAdd()
          }
        },
        [onAdd],
      )

      var pickerOptions = [E('option', { key: '__none', value: '' }, '选择一个工作区')]
      var pickedLabel = ''
      for (var index = 0; index < workspaces.length; index += 1) {
        var workspace = workspaces[index]
        var optionLabel = (workspace.title ? workspace.title + ' — ' : '') + workspace.path
        if (workspace.path === picked) pickedLabel = optionLabel
        pickerOptions.push(
          E(
            'option',
            { key: String(workspace.workspaceId || workspace.path), value: workspace.path },
            optionLabel,
          ),
        )
      }

      var body
      if (snapshot.status === 'loading') {
        body = E('div', { className: 'dpe-busy' }, '读取中…')
      } else if (picked === '') {
        body = E('div', { className: 'dpe-empty' }, '还没有可用的工作区。请先在侧栏打开或创建一个工作区。')
      } else if (roots.length === 0) {
        body = E('div', { className: 'dpe-empty' }, '该工作区还没有附加目录：写操作仍然只允许工作区内与平台临时目录。')
      } else {
        var items = roots.map(function (root) {
          return E(
            'li',
            { key: root, className: 'dpe-item' },
            E('span', { className: 'dpe-path', title: root }, root),
            E(
              'button',
              {
                type: 'button',
                className: 'dpe-remove',
                disabled: busy,
                'aria-label': '移除',
                title: '移除',
                onClick: function () {
                  onRemove(root)
                },
              },
              E(
                'svg',
                {
                  width: 18,
                  height: 18,
                  viewBox: '0 0 24 24',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 2,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                  'aria-hidden': 'true',
                },
                E('path', { d: 'M3 6h18' }),
                E('path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }),
                E('path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }),
              ),
            ),
          )
        })
        body = E('ul', { className: 'dpe-list', 'aria-label': '已附加的可写目录' }, items)
      }

      var INFO_ICON = E(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        E('circle', { cx: 12, cy: 12, r: 10 }),
        E('path', { d: 'M12 16v-4' }),
        E('path', { d: 'M12 8h.01' }),
      )

      return E(
        'div',
        { className: 'dpe-root' },
        E(
          'div',
          { className: 'dpe-card' },
          /* 工作区：标签在上，选择框占满整行 */
          E(
            'div',
            { className: 'dpe-field' },
            E('span', { className: 'dpe-label', title: '附加目录按工作区分别保存' }, '工作区'),
            E(
              'select',
              {
                className: 'dpe-select',
                value: picked,
                title: pickedLabel,
                disabled: busy || workspaces.length === 0,
                onChange: function (event) {
                  setPicked(event.target.value)
                },
              },
              pickerOptions,
            ),
          ),
          /* 可写目录区块：标签行 + 列表 + 添加组同属一组（内部 16px 分界） */
          E(
            'div',
            { className: 'dpe-field' },
            E(
              'span',
              { className: 'dpe-label', title: '移除后立即恢复官方工作区写入范围' },
              '可写目录',
              roots.length > 0 ? E('span', { className: 'dpe-count' }, String(roots.length)) : null,
              E(
                'span',
                {
                  className: 'dpe-info',
                  title:
                    '⚙ 修改立即生效于下一次工具调用，无需重启；目录必须已存在。附加目录仅在会话权限为「自定义权限」时生效。\n' +
                    'ℹ bash 经 bwrap（或 Landlock）授予写入，文件写入/编辑工具使用同一份白名单；Seatbelt / Windows ACL 沙箱暂不支持附加目录。',
                },
                INFO_ICON,
              ),
            ),
            body,
            /* 添加组合框 */
            E(
              'div',
              { className: 'dpe-add' },
              E('input', {
                className: 'dpe-input',
                type: 'text',
                value: path,
                placeholder: '输入要附加的目录（绝对路径），如 /srv/data',
                disabled: busy || picked === '',
                onChange: function (event) {
                  setPath(event.target.value)
                },
                onKeyDown: onKeyDown,
              }),
              E(
                'button',
                {
                  type: 'button',
                  className: 'dpe-btn dpe-btn-primary',
                  disabled: busy || picked === '' || path.trim() === '',
                  onClick: onAdd,
                },
                busy ? '处理中…' : '+ 添加',
              ),
            ),
          ),
          snapshot.error
            ? E('div', { className: 'dpe-error', role: 'alert' }, snapshot.error)
            : null,
        ),
      )
    }

    /**
     * 设置页挂载（工具箱合并版）：不再独立注册 settings.section，改为把页面
     * 组件交给「工具箱」页以左侧 tab / 右侧内容的方式承载；功能关闭时由
     * 工具箱页隐藏对应 tab（宿主执法点同步直通）。
     */
    function apply(ctx, api) {
      var remoteSettings = ctx.get('remote.settings') || (ctx.remote && ctx.remote.settings)
      ctx.effect(function () {
        // 幂等注入：HMR 热替换模块时旧上下文可能不清理，先移除同名旧样式，
        // 避免新旧两份 <style> 叠加导致"改了没生效"的假象。
        var stale = document.head.querySelector('style[data-plugin="dsh-permission-extras"]')
        if (stale) stale.remove()
        var tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-permission-extras'
        tag.textContent = CSS
        document.head.append(tag)
        return function () {
          tag.remove()
        }
      }, 'permission-extras: stylesheet')
      if (remoteSettings === undefined || typeof remoteSettings.describe !== 'function') return
      var channel = createSettingsChannel(remoteSettings)
      TK.pages['permission-extras'] = {
        render: function (slotProps) {
          return E(Section, {
            channel: channel,
            close: slotProps && slotProps.close,
            useWorkspaces: slotProps && slotProps.useWorkspaces,
          })
        },
      }
    }

    TK.features['permission-extras'] = { mount: function (ctx, api) { return apply(ctx, api) } }
  }
