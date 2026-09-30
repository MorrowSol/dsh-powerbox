# dsh-powerbox

DeepSeek Harness（dsh）工作区四合一插件：自定义权限（附加可写目录）、计划评审内嵌面板、工作区活动指示、侧边栏按钮布局——带「设置 → 工具箱」页统一开关。

| 功能 key | 来源包 | 作用 |
| --- | --- | --- |
| `permission-extras` | dsh-permission-extras | 「自定义权限」预设：workspace-write 之上按工作区附加可写目录（bash confine 注入 + 文件围栏执法点放行） |
| `plannotator` | dsh-plannotator-embedded | 内嵌计划评审面板（批注、多计划切换、3s 心跳回退原生卡片） |
| `workspace-activity` | dsh-workspace-activity | 折叠工作区行的会话活动标记（第 4 态图标） |
| `sidebar-layout` | @local/sidebar-button-layout | 左侧栏各插件按钮的排列 / 顺序 / 可见性（一条 sidebar 作用域样式） |

## 环境要求

- dsh **>= 0.1.7**（依赖 volatile 配置表单模型）
- Node.js >= 20（仅构建 / 测试需要；安装本插件本身无需构建）

## 结构：四库分文件，外层统一引用

```
dsh-powerbox/
├── package.json           # 外层：dsh.client.inject = 四家并集；exports ./client → client.js
├── cordis.patch.yml       # 外层：permission 行覆盖（4 预设原样）+ connection 行覆盖（webServer）+ insert toolkit
├── index.js               # 外层宿主：Config（workspaces + features volatile）→ 依序调 host/ 四模块
├── host/                  # 宿主半区，一库一文件（真 ESM import，无拼接）
│   ├── permission-extras.js   # 原 index.js 主体；包装函数加 isEnabled 现场查表
│   ├── plannotator.js         # 原 index.js；监听器入口加开关；answerFor 等纯函数原样导出
│   ├── workspace-activity.js  # 空 apply（功能 100% 在浏览器侧，行是客户端模块的装载凭据）
│   └── sidebar-layout.js      # 空 apply（同上）
├── client/                # 浏览器半区，一库一文件（拼接契约：不写 import/export，注册 TK.features）
│   ├── flags.js               # 外层共享：TK.createFlags（describe/mutate features 字段，10s 轮询 + 聚焦刷新）
│   ├── toolkit-page.js        # 外层共享：「工具箱」设置页（上：2x2 开关网格；下：左 tab / 右内容承载各功能设置页）
│   ├── permission-extras.js   # 原 client.js 平移（ns 改 TK.entryId='toolkit'；页面经 TK.pages 由工具箱 tab 承载）
│   ├── plannotator.js         # 原 client.js 平移（App 读取宿主 pending 应答的 enabled 字段）
│   ├── workspace-activity.js  # 原 client.js 平移（两个 effect 改为 setup/teardown，由 api 驱动）
│   └── sidebar-layout.js      # 原 client.js 平移（StyleEntry 常驻 shell.overlay；Section 经 TK.pages 由工具箱 tab 承载）
├── scripts/build-client.mjs   # 无依赖拼接：prelude + flags + toolkit-page + 四库 + footer → client.js
├── client.js                  # 生成物（唯一浏览器入口；client-hmr 会热重载它）
└── tests/                     # host-permission.mjs / host-plannotator.mjs / client.mjs
```

为什么浏览器侧需要拼接：`@deepseek-ai/dsh-client-modules` 每包只装载一个客户端入口
（`./client` → 一个 URL，模块 id = 包名），浏览器 `require` 只解析共享模块表、不支持
相对文件。所以源码按库分文件维护，`node scripts/build-client.mjs` 按固定顺序拼成唯一
client.js。**改 client/ 下任何文件后必须重跑该脚本**；宿主侧（index.js / host/）是
真 ESM，直接 import 分文件，但改动后需重启 `dsh web`。

## 开关机制

`Config.features` 是 volatile 布尔字典（dsh 0.1.7+ 设置表单模型，与 `workspaces` 同一条
通道）：工具箱页 `remote.settings.mutate('toolkit', [{op:'set', path:['features', key],
value: <bool>}], revision)` → settings 服务落 profile patch → loader schemastery 校验后
原地更新引用 → `loader/volatile-update`。volatile 变更不重挂插件。

- **缺省 = 启用**（`features` 缺字段 / 引用缺失 / 查表异常一律视为开，合并后默认行为与
  四个独立插件完全一致）。
- **宿主侧即时**：两个执法点包装（`patchSandboxConfine` / `patchSandboxedFileSystem`）和
  计划评审监听器每次调用现场查表，关闭即直通官方行为。
- **客户端侧 ≤10s**：FlagClient 10s 轮询 + 窗口聚焦刷新；计划评审面板更快（宿主 pending
  应答带 `enabled` 字段，随 400ms 面板轮询到达）。
- **关闭语义**：
  - `plannotator`：新评审走原生卡片；已被接管的在途评审保留在面板中可继续决策
    （RPC 通道保持在线，否则挂起中的模型无人应答）。
  - `permission-extras`：目录表仍可维护、第 4 预设仍可见（选它 = 纯 workspace-write），
    但执法点 / systemPrompt 附加行 / 模型工具全部直通或拒绝。
  - `workspace-activity`：样式、订阅、Observer、标记全部拆除，重开即重建。
  - `sidebar-layout`：样式条目与「侧边栏按钮」设置页都不渲染，shell 恢复默认布局。

## 安装

**方式一：从 GitHub 克隆后本地安装（推荐）**

```bash
git clone https://github.com/MorrowSol/dsh-powerbox.git
cd dsh-powerbox
npm install          # 安装 schemasty 依赖（可选，仅宿主 Config 校验用）
```

然后在 dsh 里安装：打开 Web UI 的「设置 → 插件」，选择"安装本地插件"，指向本目录。

**方式二：从已在本机的目录安装**

插件的 `client.js` 是已构建好的产物，仓库内直接可用；如果你改了 `client/` 下的源码：

```bash
node scripts/build-client.mjs   # 重新拼接 client.js
```

改动宿主侧（`index.js` / `host/`）后在插件管理里关/开一次本插件即可生效。

## 构建与测试

```bash
node scripts/build-client.mjs     # 拼接 client/ 片段 → client.js（IIFE 包裹，杜绝跨片段 var 污染）
npm test                          # 全部 42 项：
node tests/host-permission.mjs    #   26 项：装配路径 + 执法点回归 + 工具箱门控
node tests/host-plannotator.mjs   #   10 项：评审契约 + 停靠/决策 + 关闭语义 + 静态检查
node tests/client.mjs             #    6 项：flags 通道契约 + 产物新鲜度
```

## 配置模型

- `features`：volatile 布尔字典（工具箱开关），缺省 = 启用；
- `workspaces`：volatile 字典（工作区路径 → 附加目录表）。

两者都走 dsh 官方 settings 通道（ns = profile entry id `toolkit`）：工具箱页
`remote.settings.mutate('toolkit', …)` → settings 服务落 profile patch → loader
schemastery 校验后原地更新引用 → `loader/volatile-update`，volatile 变更不重挂插件。

## 许可

[MIT](./LICENSE)

## 已知取舍

- **inject 并集变硬依赖**：`dsh.client.inject` / 模块 `inject` 取四家并集后，任一服务缺失
  会把四个功能一起挂起（原先是各自独立）。四个服务（slots / locale / remote / sessions /
  workspaces / connection / timer + 四个 ui 包）都是当前 profile 必备项。
- **共存窗口**：安装本包与移除旧包之间，plannotator 的 prepend 监听会短暂出现两份
  （双重抢占同一评审请求）。迁移期间不要发起计划评审即可，移除旧包后恢复唯一。
- `@local/sidebar-button-layout` 的布局明细（模式 / 顺序 / 隐藏）仍存 localStorage
  （`dsh.sidebar-button-layout.v1`），不受工具箱开关影响；开关只控制整体启用。
