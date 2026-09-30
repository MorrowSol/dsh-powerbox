/**
 * dsh-powerbox — 宿主半区（外层组合）。
 *
 * 把工作区四个独立小插件合并为一个 bundle，一行双半区：
 *
 *   | 功能 key              | 来源包                     | 宿主模块                    | 客户端模块                     |
 *   | --------------------- | -------------------------- | --------------------------- | ------------------------------ |
 *   | permission-extras     | dsh-permission-extras      | host/permission-extras.js   | client/permission-extras.js    |
 *   | plannotator           | dsh-plannotator-embedded   | host/plannotator.js         | client/plannotator.js          |
 *   | workspace-activity    | dsh-workspace-activity     | host/workspace-activity.js  | client/workspace-activity.js   |
 *   | sidebar-layout        | @local/sidebar-button-layout | host/sidebar-layout.js    | client/sidebar-layout.js       |
 *
 * 外层只做三件事：声明合并后的 Config（含 `features` 工具箱开关）、把 `featureOn`
 * 查表函数下发给各宿主模块、re-export 各库纯函数供测试。客户端同理由 client.js
 * （scripts/build-client.mjs 拼接生成）按固定顺序挂载 client/ 下各库。
 *
 * 开关通道：`features` 是 volatile 字段（dsh 0.1.7+ 设置表单模型，与 `workspaces`
 * 同一条已验证通道）——客户端 `remote.settings.mutate('toolkit', …)` → settings 服务
 * 写 profile patch → loader schemastery 校验后原地更新引用 → `loader/volatile-update`。
 * volatile 变更不重挂插件，宿主执法点每次调用现场 `featureOn(key)` 查表，立即生效；
 * 客户端侧由 FlagClient 轮询 describe（≤10s）生效。
 */

import z from '@deepseek-ai/schemastery'
import * as permissionExtras from './host/permission-extras.js'
import * as plannotator from './host/plannotator.js'
import * as workspaceActivity from './host/workspace-activity.js'
import * as sidebarLayout from './host/sidebar-layout.js'

/** 合并后的 profile entry id（= settings 表单 ns = bundle patch insert 的 id）。 */
export const ENTRY_ID = 'toolkit'

/** 四个功能的开关键（客户端 FlagClient / 设置页使用同一份清单）。 */
export const FEATURE_KEYS = ['permission-extras', 'plannotator', 'workspace-activity', 'sidebar-layout']

/**
 * 合并 Config：
 * - `workspaces`：原 dsh-permission-extras 的 volatile 字段，原样保留；
 * - `features`：工具箱开关（工作区 → 功能是否启用的字典，缺省 = 启用）。
 * 两个字段都必须 volatile：运行期可改且不触发插件重挂。
 */
export const Config = z.object({
  workspaces: z.dict(z.object({ roots: z.array(z.string()) })).volatile(),
  features: z.dict(z.boolean()).volatile(),
})

/** 宿主 inject 并集：目前只有 plannotator 需要 connection（其余为作用域内 inject）。 */
export const inject = ['connection']

/**
 * 读工具箱开关的当前值。缺省（字段缺失 / 引用缺失 / 查表异常）一律 = 启用，
 * 保证合并后默认行为与四个独立插件完全一致。
 * @param {object|undefined} config loader 传入的 Config 引用。
 * @returns {(name: string) => boolean}
 */
export function featureOnOf(config) {
  return (name) => {
    try {
      const ref = config?.features
      const dict = ref !== null && typeof ref === 'object' && typeof ref.get === 'function' ? ref.get() : undefined
      return dict?.[name] !== false
    } catch {
      return true
    }
  }
}

/**
 * 一次性迁移：把旧 dsh-permission-extras 行（entry ns `permission-extras`）里的
 * workspaces 表导入本 entry。只在自身表为空且旧表非空时执行一次；旧包卸载后
 * describe 里不再有该 ns，天然跳过。
 * @param context 插件上下文。
 * @param config 合并 Config 引用。
 */
function importLegacyWorkspaces(context, config) {
  context.inject(['settings'], (scope) => {
    const settings = scope.get('settings')
    if (settings === undefined || typeof settings.describe !== 'function') return
    const own = config?.workspaces?.get?.()
    if (own !== undefined && Object.keys(own ?? {}).length > 0) return
    Promise.resolve()
      .then(() => settings.describe.call(settings))
      .then((forms) => {
        const list = Array.isArray(forms) ? forms : Array.isArray(forms?.forms) ? forms.forms : []
        const legacy = list.find((form) => form?.ns === 'permission-extras')
        const table = legacy?.value?.workspaces
        if (table === undefined || table === null || Object.keys(table).length === 0) return
        const replace = settings.replace
        if (typeof replace !== 'function') return
        return replace
          .call(settings, ENTRY_ID, { workspaces: table })
          .then(() => {
            const sink = context?.logger?.info?.bind(context.logger) ?? console.info
            sink('toolkit: 已从旧 permission-extras 行导入附加目录表')
          })
          .catch(() => {})
      })
      .catch(() => {})
  })
}

/**
 * 合并后的插件入口。
 * @param context 插件上下文。
 * @param config 解析后的合并 Config（两个 volatile 引用都用 `.get()` 读快照）。
 */
export async function apply(context, config) {
  const featureOn = featureOnOf(config)

  // 各库宿主模块（workspace-activity / sidebar-layout 为刻意的空 apply，保持四库对称）。
  //
  // 共存窗口（迁移期）：旧 dsh-permission-extras 仍安装时，`permissionExtras`
  // 服务名已被它注册，cordis 拒绝重复 provide。此时本包整体 activate 会失败。
  // 处理：捕获这一种错误 → 跳过与旧包冲突的两块（permission-extras 的全部
  // 执法点/工具与 plannotator 的接管监听），其余（工具箱页、工作区活动、
  // 侧边栏布局）照常生效；数据迁移照常执行（旧 ns 仍在场，describe 可见）。
  // 移除旧四个 bundle 并重启后，本包完整生效。
  let legacyDeferred = false
  try {
    await permissionExtras.apply(context, config, {
      featureOn,
      settingsNs: ENTRY_ID,
    })
    plannotator.apply(context, { featureOn })
  } catch (error) {
    if (typeof error?.message === 'string' && error.message.includes('has been registered')) {
      legacyDeferred = true
    } else {
      throw error
    }
  }
  if (legacyDeferred) {
    const sink = context?.logger?.warn?.bind(context.logger) ?? console.warn
    sink('toolkit: 检测到旧版独立插件仍在运行，permission-extras 与 plannotator 推迟到移除旧包并重启后生效（工具箱页 / 工作区活动 / 侧边栏布局已生效，数据迁移已启动）')
  }
  workspaceActivity.apply(context)
  sidebarLayout.apply(context)

  // 旧包数据迁移（见函数注释；设置服务在场时才可能执行）。
  importLegacyWorkspaces(context, config)
}

// 供测试与上层使用的纯函数 re-export（保持与原四个包相同的出口形状）。
export {
  STATE_FILENAME,
  STATE_VERSION,
  SETTINGS_NAMESPACE as PERMISSION_EXTRAS_NS,
  canonicalPath,
  extrasForPolicy,
  isUnder,
  normalizeState,
  patchSandboxConfine,
  patchSandboxedFileSystem,
  pruneMissingRoots,
  renderExtraRoots,
} from './host/permission-extras.js'
export {
  answerFor,
  findPlanReview,
  reviewSessionOf,
  createReviewQueue,
} from './host/plannotator.js'

/**
 * Cordis 插件形状（`Config` 供 loader / dsh-settings 的表单投影使用）。
 *
 * 注意 `inject` 必须出现在 default export 里：cordis 的 Fiber 用
 * `Inject.resolve(plugin.inject)` 建依赖授予表（named export 的 inject 只被
 * dsh loader 的挂起语义读取）。plannotator 的 apply 直接访问 `ctx.connection`，
 * 缺了它会在运行期抛 `cannot get property "connection" without inject`。
 */
export default { name: ENTRY_ID, apply, Config, inject }
