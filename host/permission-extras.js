/**
 * dsh-permission-extras — 宿主半（Host half）。
 *
 * 目标：在官方三个权限之外提供第四个「自定义权限」= `workspace-write` +
 * **按工作区独立的附加可写目录**。
 *
 * 设计要点（与 /plan 一致）：
 * 1. 不改动任何 shipped 包：附加目录通过**运行时包装已注册服务的方法**接进去。
 * 2. 只有两个执行钩子，且都装在**执法点**上：
 *    - `ctx.sandbox.confine(argv, policy)`：返回值里插入 bwrap `--bind <dir> <dir>` /
 *      landlock `--rw <dir>`（bash / 终端的内核级授权）；
 *    - `ctx.fs.checkedTarget(target, policy)`：目标落在附加目录内时放行
 *      （`writeText` / `editText` 都先过它，因此 `write` / `edit` /
 *      `str_replace_editor` 三条路径同时生效；否则 `dsh-fs-sandbox` 的进程内
 *      围栏只认 workspaceRoot + /tmp）。
 *    两个钩子都按 `policy.workspaceRoot` 现场查表，**不把附加目录挂在 policy
 *    对象上** —— 上游会重建策略对象（bash 就是 `{...policy, mode}`），任何挂在
 *    对象上的标记都会在那一步丢掉。
 * 3. 附加目录表按「工作区 = 该会话不可变 cwd 的 realpath」存放，与
 *   `sandboxPolicy.resolve()` 判定 workspaceRoot 的同一来源，因此同目录的
 *   会话共享、跨目录互不影响。
 * 4. 仅对 `workspace-write` 且当前工作区存在附加目录时生效：官方
 *   workspace-write / read-only / danger-full-access 的行为完全不变。
 *
 * 通道（三条路径，同一个内存表）：
 *   - 设置页：官方 settings 表单。dsh 0.1.7 起设置体系改为「profile entry 的
 *     Config volatile 字段」（旧 `settings.installSection` 已移除）：本插件的
 *     Config 声明了一个 volatile 的 `workspaces` 字段，客户端用
 *     `remote.settings.describe/mutate`（ns = profile entry id `permission-extras`）读写，
 *     loader 把提交提交进 profile patch 并原地更新引用后发 `loader/volatile-update`；
 *   - Agent：模型工具 `permission_extras`；
 *   - 兜底：没有 settings 提供方时落 `$DSH_HOME/permission-extras.json`。
 * 不注册私有 RPC channel：本部署宿主窗口没有 `connection` 服务（只有它的
 * 浏览器半边），`inject(['connection'])` 永远不会就绪。
 *
 * 服务：`ctx.permissionExtras`（`PermissionExtrasService`）。
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'

// ── 常量与标识 ──────────────────────────────────────────────────────────────

/** 持久化文件名（位于 $DSH_HOME 下，仅在 settings 不可用时使用）。 */
export const STATE_FILENAME = 'permission-extras.json'
/** 持久化格式版本。 */
export const STATE_VERSION = 1
/** 官方 settings 表单对应的 profile entry id（bundle 补丁里 insert 的 id）。 */
export const SETTINGS_NAMESPACE = 'permission-extras'
/** 包装幂等标记，避免重复包装 / 与第三方包装叠加。 */
const WRAPPED = Symbol.for('dsh-permission-extras/wrapped')

// ── 插件 Config（dsh 0.1.7+ 设置表单模型） ──────────────────────────────────
//
// dsh 0.1.7 起旧 `settings.installSection`（自定义 namespace + validate 钩子）被
// 移除，设置页改为枚举「每个 profile entry 的 Config volatile 字段」。这里把
// 整张 workspaces 表声明为一个 volatile 字段：
//   - 写入路径：客户端 `remote.settings.mutate('permission-extras', [
//     {op:'set'|'unset', path:['workspaces', <工作区>] }] , revision)`，落进
//     profile patch 的 `permission-extras` 行，loader 校验后原地更新引用；
//   - 读路径：`config.workspaces.get()` 拿到不可变快照（frozen）；
//   - 为什么必须用真实的 `@deepseek-ai/schemastery`：loader 的
//     `equalExceptVolatile` 只认 schemastery 的 schema（`~standard.vendor`），
//     否则每次仅 volatile 的变更都会被当成普通变更 → 整个插件重挂载；
//     且 `dsh-settings` 的表单投影用 `new z(schema.toJSON())` 复原 schema。
//     link: 安装的插件解析不到 harness 依赖，因此本插件自带同版本依赖
//     （见 package.json），由插件目录的 node_modules 解析。

/**
 * 插件 Config：`workspaces`（工作区路径 → {roots: [...]}）是唯一的 volatile 字段。
 * 形状非法的写入会被 loader 在提交前拒绝（schemastery 校验），不会进入运行时。
 */
export const Config = z.object({
  workspaces: z.dict(z.object({ roots: z.array(z.string()) })).volatile(),
})

// ── 路径工具（纯函数，便于单测） ────────────────────────────────────────────

/**
 * 与 `@deepseek-ai/dsh-sandbox` 的 `canonicalPath` 同语义：解析符号链接，
 * 目标不存在时把「最深存在的祖先」realpath 后再补回不存在的尾段
 * （否则 `/a/missing` 会塌缩成 `/a`，让包含判定把父目录当成目标本身）。
 * @param {string} path 任意路径。
 * @returns {string} 该路径的规范拼写。
 */
export function canonicalPath(path) {
  const parts = []
  let current = resolve(path)
  for (let depth = 0; depth < 256; depth += 1) {
    try {
      const real = realpathSync.native ? realpathSync.native(current) : realpathSync(current)
      return parts.length === 0 ? real : join(real, ...parts.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return parts.length === 0 ? current : join(current, ...parts.reverse())
      parts.push(basename(current))
      current = parent
    }
  }
  return resolve(path)
}

/** `child` 是否等于 `root` 或位于其下（路径边界安全）。 */
export function isUnder(child, root) {
  if (typeof child !== 'string' || typeof root !== 'string') return false
  if (child === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return child.startsWith(prefix)
}

/** 工作区键 = 会话 cwd / 目录 的规范路径。 */
export function workspaceKeyFor(path) {
  return canonicalPath(path)
}

/** 目录可用性校验；返回稳定错误码供 UI 原样展示。 */
export function checkDirectory(path) {
  if (typeof path !== 'string' || path.trim().length === 0) {
    return { ok: false, code: 'empty', message: '路径不能为空' }
  }
  if (!isAbsolute(path)) {
    return { ok: false, code: 'not-absolute', message: '请填写绝对路径（以 / 开头）' }
  }
  const canonical = canonicalPath(path)
  if (canonical === sep) {
    return { ok: false, code: 'too-broad', message: '不能把文件系统根目录 / 作为附加目录' }
  }
  let info
  try {
    info = statSync(canonical)
  } catch {
    return { ok: false, code: 'missing', message: `目录不存在：${canonical}` }
  }
  if (!info.isDirectory()) {
    return { ok: false, code: 'not-directory', message: `不是目录：${canonical}` }
  }
  return { ok: true, code: 'ok', path: canonical, message: '' }
}

// ── 持久化 ───────────────────────────────────────────────────────────────────

/** 解析 harness home：优先 $DSH_HOME，其次 ~/.dsh。 */
export function resolveHarnessHome(env = process.env) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return resolve(configured)
  return join(homedir(), '.dsh')
}

/** 空状态。 */
function emptyState() {
  return { version: STATE_VERSION, workspaces: {}, updatedAt: 0 }
}

/** 把任意读入值收敛成合法状态（坏数据只丢该条，不抛异常）。 */
export function normalizeState(raw) {
  const state = emptyState()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return state
  if (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) state.updatedAt = raw.updatedAt
  const table = raw.workspaces
  if (table === null || typeof table !== 'object' || Array.isArray(table)) return state
  for (const [key, value] of Object.entries(table)) {
    if (typeof key !== 'string' || key.length === 0 || !isAbsolute(key)) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const roots = Array.isArray(value.roots) ? value.roots : []
    const unique = []
    for (const root of roots) {
      if (typeof root !== 'string' || root.length === 0 || !isAbsolute(root)) continue
      const canonical = canonicalPath(root)
      if (canonical === sep || unique.includes(canonical)) continue
      unique.push(canonical)
    }
    if (unique.length > 0) state.workspaces[canonicalPath(key)] = { roots: unique }
  }
  return state
}

/** 读取状态文件；缺失/损坏 → 空状态 + 诊断文本。 */
export function readStateFile(file) {
  if (!existsSync(file)) return { state: emptyState(), problem: null }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { state: normalizeState(parsed), problem: null }
  } catch (error) {
    return {
      state: emptyState(),
      problem: `无法解析 ${file}（${error && error.message ? error.message : String(error)}），本轮以空表运行`,
    }
  }
}

/**
 * 语义裁剪：把「目录已不存在」的附加目录从表里去掉。
 *
 * 旧 `settings.installSection` 的 validate 钩子随 dsh 0.1.7 移除后，写入侧
 * 不再有宿主把关；失效的附加目录会让 bwrap `--bind` 直接失败（该工作区的
 * 所有 bash 命令都起不来），因此必须在读路径上裁掉，并由漂移自愈写回干净表。
 * 工作区键本身不做存在性检查：会话的 cwd 必然存在，而临时不可见的挂载点
 * 不应该导致整条配置被抹掉（键只用于查表，不产生内核参数）。
 *
 * @param {object} state normalizeState 之后的合法状态。
 * @returns {object} 裁剪后的状态（新对象，不改输入）。
 */
export function pruneMissingRoots(state) {
  const workspaces = {}
  for (const [workspacePath, entry] of Object.entries(state.workspaces)) {
    const roots = (entry?.roots ?? []).filter((root) => checkDirectory(root).ok)
    if (roots.length === 0) continue
    workspaces[workspacePath] = { roots }
  }
  return { ...state, workspaces }
}

/** 原子写（同目录临时文件 + rename）。 */
export function writeStateFile(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  const payload = `${JSON.stringify(state, null, 2)}\n`
  const temp = `${file}.${process.pid}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeFileSync(fd, payload, 'utf8')
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
}

// ── 附加目录表（内存缓存 + 串行落盘） ────────────────────────────────────────

/**
 * 按工作区维护附加可写目录的服务。
 *
 * 策略解析是同步的（host 工具层在每次工具调用里同步读取），因此注册表以内存
 * 缓存为准；每次变更先同步更新缓存、再持久化。
 *
 * 本部署里 host 侧**没有** `connection` 服务（只有它的浏览器半边），所以客户端
 * 不能走私有 RPC。状态因此挂在官方 settings namespace 上：客户端用
 * `remote.settings` 读写，Agent 用模型工具读写，两条路径都汇到这个同步缓存。
 */
export class PermissionExtrasService {
  /**
   * @param {object} options 构造参数。
   * @param {string} [options.file] 文件回退路径（没有 settings 提供方时使用）。
   * @param {{warn: Function, info: Function}} [options.logger] 日志。
   * @param {() => Promise<void>} [options.stateWriter] 外部状态写入器。
   */
  constructor(options = {}) {
    this.file = options.file ?? join(resolveHarnessHome(), STATE_FILENAME)
    this.logger = options.logger ?? { warn: () => {}, info: () => {} }
    const loaded = readStateFile(this.file)
    this.state = pruneMissingRoots(loaded.state)
    this.problem = loaded.problem
    if (this.problem !== null) this.logger.warn(`permission-extras: ${this.problem}`)
    /** @type {Promise<unknown>} 落盘串行队列。 */
    this.queue = Promise.resolve()
    /** 外部状态写入器；undefined 表示退回文件。 */
    this.stateWriter = options.stateWriter
    /** 当前状态来源，用于 UI 展示。 */
    this.stateSource = this.stateWriter === undefined ? 'file' : 'settings'
  }

  /**
   * 挂载外部状态源：settings 一旦在场就是**唯一权威**。
   *
   * 客户端把某个工作区的列表删空时，settings 的值就是空表，缓存必须跟着变空，
   * 因此这里不能用「旧缓存非空就保留」的兜底；文件只在没有 settings 提供方时使用。
   *
   * @param {{read: () => object|undefined, write: (state: object) => Promise<void>} | undefined} binding 绑定；undefined 表示退回文件。
   */
  attachState(binding) {
    if (binding === undefined) {
      this.stateWriter = undefined
      this.stateSource = 'file'
      return
    }
    this.state = normalizeState(binding.read())
    this.stateWriter = () => binding.write(this.state)
    this.stateSource = 'settings'
  }

  /** 当前状态的浅拷贝（供 UI 展示）。 */
  snapshot() {
    return {
      file: this.file,
      source: this.stateSource,
      updatedAt: this.state.updatedAt,
      workspaces: Object.entries(this.state.workspaces).map(([path, entry]) => ({
        path,
        roots: entry.roots.slice(),
      })),
    }
  }

  /**
   * 把当前内存表写回外部状态源（串行队列上执行，失败只记日志）。
   *
   * 用途：外部写入的原始表可能带有本插件才会发现的语义问题（目录不存在、
   * 非规范拼写、残留未知字段等）。`normalizeState` 在读入时已经把它们丢掉，
   * 这里负责把干净表写回持久层，避免「页面显示」与「执法点查表」长期不一致。
   */
  async flushState() {
    const writer = this.stateWriter
    if (writer === undefined) return
    const task = async () => {
      try {
        await writer()
        this.logger.info('permission-extras: settings 已更新')
      } catch (error) {
        this.logger.warn(`permission-extras: 写回失败：${error && error.message ? error.message : String(error)}`)
      }
    }
    this.queue = this.queue.then(task, task)
    await this.queue
  }

  /**
   * 某个工作区的附加目录（同步，策略解析路径使用）。
   * @param {string} workspacePath 工作区目录（会话 cwd）。
   * @returns {readonly string[]} 规范化的附加目录；无则空数组。
   */
  extraRootsFor(workspacePath) {
    if (typeof workspacePath !== 'string' || workspacePath.length === 0) return []
    const entry = this.state.workspaces[workspacePath] ?? this.state.workspaces[canonicalPath(workspacePath)]
    return entry === undefined ? [] : entry.roots.slice()
  }

  /**
   * 新增一个附加目录。
   * @param {string} workspacePath 工作区目录（会话 cwd）。
   * @param {string} dirPath 要附加的目录。
   * @returns {Promise<{workspacePath: string, roots: string[], removedContained: string[]}>} 变更结果。
   * @throws 当目录非法（错误对象带 `code`）。
   */
  async addRoot(workspacePath, dirPath) {
    const workspace = this.#requireWorkspace(workspacePath)
    const checked = checkDirectory(dirPath)
    if (!checked.ok) throw Object.assign(new Error(checked.message), { code: checked.code })
    const root = checked.path
    if (isUnder(canonicalPath(workspace), root)) {
      throw Object.assign(new Error(`${root} 已包含该工作区，无需附加`), { code: 'covers-workspace' })
    }
    const current = this.extraRootsFor(workspace)
    if (current.includes(root)) return { workspacePath: workspace, roots: current, removedContained: [] }
    // 新目录已覆盖的旧条目直接收敛掉，避免重复授权。
    const removedContained = current.filter((item) => isUnder(item, root))
    const roots = [...current.filter((item) => !removedContained.includes(item)), root]
    await this.#commit(workspace, roots)
    return { workspacePath: workspace, roots: roots.slice(), removedContained }
  }

  /**
   * 删除一个附加目录。
   * @param {string} workspacePath 工作区目录。
   * @param {string} dirPath 目录（按规范路径匹配）。
   * @returns {Promise<{workspacePath: string, roots: string[], removed: boolean}>} 变更结果。
   */
  async removeRoot(workspacePath, dirPath) {
    const workspace = this.#requireWorkspace(workspacePath)
    const root = canonicalPath(dirPath)
    const current = this.extraRootsFor(workspace)
    const roots = current.filter((item) => item !== root)
    const removed = roots.length !== current.length
    if (removed) await this.#commit(workspace, roots)
    return { workspacePath: workspace, roots: roots.slice(), removed }
  }

  /** 校验工作区路径（必须存在且是目录）。 */
  #requireWorkspace(workspacePath) {
    const checked = checkDirectory(workspacePath)
    if (!checked.ok) throw Object.assign(new Error(`工作区目录不可用：${checked.message}`), { code: 'bad-workspace' })
    return checked.path
  }

  /** 同步改缓存 + 持久化；持久化失败回滚缓存。 */
  async #commit(workspace, roots) {
    const previous = this.state.workspaces[workspace]
    const next = { version: STATE_VERSION, workspaces: { ...this.state.workspaces }, updatedAt: Date.now() }
    if (roots.length === 0) delete next.workspaces[workspace]
    else next.workspaces[workspace] = { roots: roots.slice() }
    this.state = next
    const writer = this.stateWriter
    const task = async () => {
      try {
        if (writer !== undefined) {
          // settings 通道：由 settings 服务校验并写入用户层。
          await writer()
          this.logger.info('permission-extras: settings 已更新')
        } else {
          writeStateFile(this.file, next)
          this.logger.info(`permission-extras: ${this.file} 已更新`)
        }
      } catch (error) {
        if (this.state === next) {
          const rolledBack = { version: STATE_VERSION, workspaces: { ...this.state.workspaces }, updatedAt: this.state.updatedAt }
          if (previous === undefined) delete rolledBack.workspaces[workspace]
          else rolledBack.workspaces[workspace] = previous
          this.state = rolledBack
        }
        throw error
      }
    }
    const settled = this.queue.then(task, task)
    // 队列自身必须保持已解决，否则一次失败会污染后续每一次变更；
    // 真正的失败通过 `settled` 抛给本次调用者。
    this.queue = settled.catch((error) => {
      this.logger.warn(`permission-extras: 写入 ${this.file} 失败：${error && error.message ? error.message : String(error)}`)
    })
    await settled
  }
}

// ── 运行时钩子 ───────────────────────────────────────────────────────────────
//
// 附加目录**不**随 policy 对象传递：真实执行栈会在边界处重建策略对象
// （`dsh-bash-sandbox` 就是 `const confined = this.confine(spec.command, {...policy, mode})`），
// 对象展开 / 结构化克隆都会丢掉私有标记（symbol 甚至不可枚举），于是 bash 侧拿不到
// 授权、内核按「工作区之外只读」拒绝（`Read-only file system`）。
//
// 因此所有钩子一律在**执法点**按 `policy.workspaceRoot` 现场查表：附加目录跟着
// 「工作区」走，而不是跟着某个对象实例走。

/**
 * 从本次调用的策略里取该工作区的附加目录。
 *
 * 只认 `workspace-write`：`read-only` 不接受任何放宽，`danger-full-access` 本就无需放宽。
 * 判定依据是策略里的 `workspaceRoot`（工作区绝对路径），因此在执法点现场查表 ——
 * 不依赖策略对象实例，也就不怕上游展开 / 重建策略。
 *
 * @param {object|undefined} policy 本次调用的文件效果策略（可能已被上游重建）。
 * @param {(workspacePath: string) => string[]} extrasFor 按工作区目录查附加目录。
 * @returns {string[]} 本次调用生效的附加目录（永不为 null）。
 */
export function extrasForPolicy(policy, extrasFor) {
  if (policy === null || typeof policy !== 'object') return []
  if (policy.mode !== 'workspace-write') return []
  const key = policy.workspaceRoot
  if (typeof key !== 'string' || key.length === 0) return []
  if (typeof extrasFor !== 'function') return []
  try {
    const extras = extrasFor(key)
    return Array.isArray(extras) ? extras : []
  } catch {
    // 附加目录只影响宽严，绝不影响基础约束：查表异常一律按「无附加目录」处理。
    return []
  }
}

/**
 * 包装 `ctx.sandbox.confine`：在 argv 的 `--` 分隔符前插入附加目录授权。
 *
 * bwrap：`--bind <dir> <dir>`；landlock：`--rw <dir>`；其它运行器
 * （seatbelt / windows-acl / 自定义 runner）记为不支持，**原样返回**
 * （绝不降级为不受限）。
 *
 * @param service `ctx.sandbox` 提供方。
 * @param extrasFor 按工作区目录查附加目录。
 * @param onUnsupported 不支持时的回调（每个提供方只报一次）。
 * @param {{isEnabled?: () => boolean}} [opts] 工具箱开关：返回 false 时包装直通原方法
 *   （= 官方 workspace-write），执法点现场查表，不做任何缓存。
 * @returns {() => void} 还原函数。
 */
export function patchSandboxConfine(service, extrasFor, onUnsupported = () => {}, opts = {}) {
  if (service === null || typeof service !== 'object') return () => {}
  const original = service.confine
  if (typeof original !== 'function') return () => {}
  if (original[WRAPPED] === true) return () => {}
  let reported = false
  const wrapped = function confine(argv, policy, ...rest) {
    // 工具箱开关：关闭时按官方原样执行（现场查表，不缓存判定结果）。
    if (typeof opts?.isEnabled === 'function' && !opts.isEnabled()) return original.call(service, argv, policy, ...rest)
    // dsh 0.1.7 起 confine 增加了第三个参数（AbortSignal），必须原样透传。
    const confined = original.call(service, argv, policy, ...rest)
    // 注意：调用方可能传的是 `{...policy, mode}` 这类重建对象，
    // 所以附加目录必须在这里按 workspaceRoot 现查，而不是从对象上读标记。
    const extras = extrasForPolicy(policy, extrasFor)
    if (extras.length === 0 || confined === null || typeof confined !== 'object' || !Array.isArray(confined.argv)) return confined
    const separator = confined.argv.indexOf('--')
    if (separator < 0) return confined
    const program = typeof confined.argv[0] === 'string' ? basename(confined.argv[0]) : ''
    let inserted
    if (program.includes('bwrap')) inserted = extras.flatMap((dir) => ['--bind', dir, dir])
    else if (program.includes('landlock')) inserted = extras.flatMap((dir) => ['--rw', dir])
    else {
      if (!reported) {
        reported = true
        onUnsupported(program === '' ? 'unknown runner' : program)
      }
      return confined
    }
    return { ...confined, argv: [...confined.argv.slice(0, separator), ...inserted, ...confined.argv.slice(separator)] }
  }
  wrapped[WRAPPED] = true
  service.confine = wrapped
  return () => {
    if (service.confine === wrapped) service.confine = original
  }
}

/**
 * 包装文件系统围栏后端的**执法点** `checkedTarget`：目标落在本工作区登记的
 * 附加目录内时，按 `danger-full-access` 分支的同一语义放行本次写入。
 *
 * 为什么改执法点而不是 `writeText`：`writeText` / `editText` 都是
 * `super.write…(await this.checkedTarget(target, policy), …)`，判定与
 * 「实际写入的那份目标」都由 `checkedTarget` 决定（`resolve` 现场重解析，
 * 防符号链接中途换向）。在执法点放行一次，`write` / `edit` /
 * `str_replace_editor` 三条写入路径同时生效。
 *
 * 只放宽到「本工作区显式登记的目录」：其余一律原样委派原方法，既有的
 * `FS_SANDBOX_DENIED` 语义与一次性的升级审批流程完全不变。
 *
 * @param service `ctx.fs` 提供方。
 * @param extrasFor 按工作区目录查附加目录。
 * @param {{isEnabled?: () => boolean}} [opts] 工具箱开关：返回 false 时包装直通原方法。
 * @returns {() => void} 还原函数。
 */
export function patchSandboxedFileSystem(service, extrasFor, opts = {}) {
  if (service === null || typeof service !== 'object') return () => {}
  const original = service.checkedTarget
  if (typeof original !== 'function') return () => {}
  if (original[WRAPPED] === true) return () => {}
  const wrapped = async function checkedTarget(target, policy) {
    // 工具箱开关：关闭时完全按原围栏执行（现场查表）。
    if (typeof opts?.isEnabled === 'function' && !opts.isEnabled()) return original.call(this, target, policy)
    try {
      const extras = extrasForPolicy(policy, extrasFor)
      if (extras.length > 0 && target !== null && typeof target === 'object' && typeof target.displayPath === 'string') {
        // 直接用 `displayPath`：围栏自己就是拿它去 `resolve` 再和 workspaceRoot 比的，
        // 因此它必然是宿主绝对路径（不经过 `processPath`，那是 FsTarget → 执行世界路径的映射）。
        const requested = canonicalPath(target.displayPath)
        if (extras.some((root) => isUnder(requested, root))) {
          // 与 danger-full-access 分支同构：交回这条路径的解析结果；
          // 但先确认解析后的规范路径仍在登记目录内，符号链接换向就退回原围栏。
          const fresh = await this.resolve(target.displayPath)
          const canonical = canonicalPath(fresh !== null && typeof fresh === 'object' && typeof fresh.displayPath === 'string' ? fresh.displayPath : requested)
          if (extras.some((root) => isUnder(canonical, root))) return fresh
        }
      }
    } catch {
      // 附加目录只影响宽严：任何异常都退回原围栏，由它给出标准的拒绝与升级提示。
    }
    return original.call(this, target, policy)
  }
  wrapped[WRAPPED] = true
  service.checkedTarget = wrapped
  return () => {
    if (service.checkedTarget === wrapped) service.checkedTarget = original
  }
}

// ── 模型可见性 ───────────────────────────────────────────────────────────────

/**
 * `sandbox:policy` 之外的附加说明：只在确实有附加目录时出现。
 * @param {readonly string[]} extras 附加目录。
 * @returns {string} 提示文本。
 */
export function renderExtraRoots(extras) {
  if (!Array.isArray(extras) || extras.length === 0) return ''
  return `当前会话的「自定义权限」额外允许写入这些目录（同样受工作区沙箱约束，工作区之外的其它路径仍不可写）：${JSON.stringify(extras)}。`
}

// ── 插件本体 ─────────────────────────────────────────────────────────────────

/**
 * 写一条带前缀的诊断（优先 Cordis 日志，其次 console）。
 * @param context 插件上下文。
 * @param {'warn'|'info'} level 级别。
 * @param {string} message 文本。
 */
function report(context, level, message) {
  const text = `permission-extras: ${String(message).replace(/^permission-extras: /, '')}`
  const logger = context?.logger
  const sink = logger !== undefined && typeof logger[level] === 'function' ? logger[level].bind(logger) : undefined
  if (sink !== undefined) {
    sink(text)
    return
  }
  const fallback = level === 'warn' ? console.warn : console.info
  fallback(text)
}

/** 工具参数 schema。 */
const TOOL_PARAMETERS = {
  action: {
    type: 'string',
    required: true,
    enum: ['list', 'add', 'remove'],
    description: 'list 查看当前工作区的附加目录；add 添加；remove 删除。',
  },
  path: {
    type: 'string',
    description: 'add/remove 时要附加或移除的目录绝对路径。list 时可省略。',
  },
}

/** 工具输出 schema。 */
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', required: true, enum: ['list', 'add', 'remove'] },
    workspacePath: { type: 'string', required: true },
    roots: { type: 'array', required: true, items: { type: 'string' } },
    removedContained: { type: 'array', items: { type: 'string' } },
    removed: { type: 'boolean' },
  },
}

/**
 * 工具结果的可见文本。
 * @param {object} args 调用参数。
 * @param {object} value 工具返回值。
 * @returns {Array<object>} ContentBlock 列表。
 */
function renderToolOutput(args, value) {
  const roots = Array.isArray(value?.roots) ? value.roots : []
  const action = typeof args?.action === 'string' ? args.action : 'list'
  if (args?.action === 'remove') {
    return [
      {
        type: 'text',
        text: value?.removed === true ? `已移除附加目录；当前清单：${JSON.stringify(roots)}` : `该目录不在清单中；当前清单：${JSON.stringify(roots)}`,
      },
    ]
  }
  const extra = Array.isArray(value?.removedContained) && value.removedContained.length > 0 ? `（已合并更细的条目：${JSON.stringify(value.removedContained)}）` : ''
  return [
    {
      type: 'text',
      text: `${action === 'add' ? '已添加' : '当前'}附加可写目录：${JSON.stringify(roots)}${extra}。仅在权限预设为「自定义权限」时生效。`,
    },
  ]
}

/**
 * 插件入口（工具箱合并版）。
 * @param context 插件上下文。
 * @param config 解析后的插件 Config（`workspaces` 是 volatile 引用，用 `.get()` 读快照）。
 * @param {{featureOn?: (name: string) => boolean}} [opts] 工具箱开关：
 *   `featureOn('permission-extras')` 为 false 时全部执法点/工具/提示直通官方行为，
 *   但目录维护表与设置页数据通道保持可用（重新打开即恢复，无需重挂插件）。
 */
export async function apply(context, config, opts = {}) {
  // settings 表单 ns = profile entry id。独立安装时是 'permission-extras'；
  // 工具箱合并版由外层传入 'toolkit'（index.js 的 ENTRY_ID）。
  const settingsNs = typeof opts.settingsNs === 'string' ? opts.settingsNs : SETTINGS_NAMESPACE
  const featureOn = typeof opts.featureOn === 'function' ? opts.featureOn : () => true
  const logger = {
    warn: (message) => report(context, 'warn', message),
    info: (message) => report(context, 'info', message),
  }
  // 说明：`report` 走 Cordis 的 `ctx.logger`（由日志插件注入）；不可用时退回 console。
  const service = new PermissionExtrasService({ logger })
  context.provide('permissionExtras', service)

  const extrasFor = (workspacePath) => service.extraRootsFor(workspacePath)

  // 1) bash / 终端内核级授权：在 confine 的 argv 里插入附加目录授权。
  //    执行栈会在边界处重建 policy 对象（`{...policy, mode}`），所以这里按
  //    policy.workspaceRoot 现场查表，而不是从 policy 上读附加目录集。
  context.inject(['sandbox'], (scope) => {
    const sandbox = scope.get('sandbox')
    if (sandbox === undefined) return
    scope.effect(
      () =>
        patchSandboxConfine(
          sandbox,
          extrasFor,
          (program) => {
            logger.warn(
              `permission-extras: 当前沙箱运行器 ${program} 不支持附加目录（仅 bwrap / landlock 支持）；命令仍按工作区受限运行。`,
            )
          },
          { isEnabled: () => featureOn('permission-extras') },
        ),
      'permission-extras: sandbox.confine',
    )
  })

  // 2) 文件工具围栏：在执法点 checkedTarget 放行附加目录内的写入
  //    （write / edit / str_replace_editor 共用这一条路径）。
  context.inject(['fs'], (scope) => {
    const fs = scope.get('fs')
    if (fs === undefined || fs.sandboxMode === undefined) return
    scope.effect(() => patchSandboxedFileSystem(fs, extrasFor, { isEnabled: () => featureOn('permission-extras') }), 'permission-extras: fs.checkedTarget')
  })

  // 3) 模型可见性：只在有附加目录时追加一行运行时上下文。
  //    与官方 dsh-sandbox-policy 的 `sandbox:policy` 贡献同一套取会话方式。
  context.inject(['systemPrompt'], (scope) => {
    const systemPrompt = scope.get('systemPrompt')
    if (systemPrompt === undefined) return
    systemPrompt.context({
      name: 'permission:extras',
      order: systemPrompt.getContextOrder('SANDBOX_POLICY'),
      text: (assembly) => {
        // 工具箱开关：关闭时模型侧不出现附加目录提示（执法点也已直通）。
        if (!featureOn('permission-extras')) return ''
        const session = assembly?.agent?.session
        const workspaceRoot = session?.header?.cwd
        if (typeof workspaceRoot !== 'string') return ''
        return renderExtraRoots(extrasFor(canonicalPath(workspaceRoot)))
      },
    })
  })
  // 4) 客户端通道：官方 settings 表单（profile entry `permission-extras` 的
  //    volatile 字段 `workspaces`）。
  //
  //    dsh 0.1.7 起 `settings.installSection`（自定义 namespace + validate 钩子）
  //    被移除，设置页改为枚举各 entry 的 Config volatile 字段。本插件在 Config
  //    里声明了 `workspaces`：客户端 `remote.settings.describe/mutate`（ns = entry
  //    id `permission-extras`）→ settings 服务写 profile patch → loader 校验并
  //    原地更新 config 引用 → 向本插件上下文发 `loader/volatile-update`。这里把
  //    内存表挂到 config 引用上：读 = `config.workspaces.get()` 规范化后的快照；
  //    写 = `settings.replace(ns, { workspaces })`（volatile 字段整体替换，
  //    不触碰本 entry 的普通配置）。
  //
  //    旧版由 `installSection` 的 validate 钩子在宿主把关「目录是否真实存在」；
  //    新模型没有这个钩子，改为读入时规范化丢弃 + 漂移自愈（见下）。
  /** settings 绑定（settings 在场时非空）；`refresh` 把内存表重新对齐到 config。 */
  let settingsBinding = null
  /** 读 config 引用里的原始 workspaces 表（无 settings/config 时 undefined）。 */
  const rawWorkspaces = () => {
    const ref = config?.workspaces
    return ref !== null && typeof ref === 'object' && typeof ref.get === 'function' ? ref.get() : undefined
  }
  /** 原始表 → 规范化 + 语义裁剪后的状态（丢掉不存在的目录、非规范拼写、未知字段）。 */
  const readTable = () => pruneMissingRoots(normalizeState({ workspaces: rawWorkspaces() ?? {} }))
  context.inject(['settings'], (scope) => {
    const settings = scope.get('settings')
    if (settings === undefined) {
      logger.warn('permission-extras: settings 服务不可用，附加目录只能由模型工具维护。')
      return
    }
    if (rawWorkspaces() === undefined) {
      logger.warn('permission-extras: 当前宿主没有给本插件传入 Config（workspaces 引用缺失），退回文件存储。')
      return
    }
    // 本插件自带整页设置（client.js 的 settings.section 槽位），关掉 shell 的自动表单页。
    if (typeof settings.configure === 'function') {
      scope.effect(() => settings.configure({ auto: false }, context.fiber), 'permission-extras: settings.configure')
    }
    settingsBinding = {
      refresh: () => {
        service.attachState({
          read: readTable,
          write: async (next) => {
            const replace = settings.replace
            if (typeof replace !== 'function') throw new Error('settings.replace 不可用')
            // 本插件独占该 entry 的 volatile 字段；settings 只替换表单字段，不碰普通配置。
            await replace.call(settings, settingsNs, { workspaces: next.workspaces })
          },
        })
      },
    }
    settingsBinding.refresh()
    logger.info(`permission-extras: settings 表单已接入（entry ${settingsNs} 的 volatile 字段 workspaces）`)
  })

  // 外部写入（浏览器 / 手改 patch / 旧数据迁移）落地后的对齐与自愈：
  // loader 原地更新 config 引用后会发 `loader/volatile-update`。
  let healing = false
  context.on('loader/volatile-update', () => {
    if (settingsBinding === null) return
    settingsBinding.refresh()
    if (healing) return
    const raw = rawWorkspaces()
    const normalized = readTable().workspaces
    if (JSON.stringify(raw) === JSON.stringify(normalized)) return
    // 原始表与规范化表不一致：说明有目录失效 / 拼写未规范化 / 残留未知字段，
    // 把干净表写回，防止脏数据永久留在 patch 里。
    healing = true
    service
      .flushState()
      .catch(() => {})
      .finally(() => {
        healing = false
      })
  })

  // 5) 模型侧工具：让 Agent 也能按工作区增删附加目录。
  context.inject(['tools'], (scope) => {
    const tools = scope.get('tools')
    if (tools === undefined) return
    scope.effect(
      () =>
        tools.register({
          name: 'permission_extras',
          description:
            '查看或修改当前工作区的「自定义权限」附加可写目录（仅在权限预设为「自定义权限」时对写操作生效）。',
          parameters: TOOL_PARAMETERS,
          output: {
            schema: TOOL_OUTPUT_SCHEMA,
            render: renderToolOutput,
          },
          async execute(args, exec) {
            // 工具箱开关：关闭时明确拒绝（执法点同样处于关闭态）。
            if (!featureOn('permission-extras')) {
              throw new Error('「自定义权限」已在工具箱设置中停用；请先在「设置 → 工具箱」重新启用。')
            }
            const workspacePath = exec?.agent?.session?.header?.cwd
            if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
              throw new Error('当前会话没有工作区目录（cwd），无法维护附加目录。')
            }
            const action = args?.action
            if (action === 'list') {
              return { action, workspacePath: canonicalPath(workspacePath), roots: service.extraRootsFor(canonicalPath(workspacePath)) }
            }
            if (action === 'add') {
              const result = await service.addRoot(workspacePath, args.path)
              return { action, workspacePath: result.workspacePath, roots: result.roots, removedContained: result.removedContained }
            }
            if (action === 'remove') {
              const result = await service.removeRoot(workspacePath, args.path)
              return { action, workspacePath: result.workspacePath, roots: result.roots, removed: result.removed }
            }
            const error = new Error(`未知 action：${String(action)}`)
            error.code = 'bad-action'
            throw error
          },
        }),
      'permission-extras: model tool',
    )
  })

  logger.info(`permission-extras: 附加目录表 ${service.file}`)
}
