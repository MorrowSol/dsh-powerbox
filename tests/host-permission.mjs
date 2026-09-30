/**
 * 宿主半「装配路径」的契约校验：用一个最小的 Cordis 上下文把 index.js 的
 * `apply()` 真正跑一遍，验证
 *   - `provide` 暴露 permissionExtras 服务
 *   - 四个 hook 全部就位（sandbox / fs / systemPrompt / settings）
 *   - 附加目录在「策略对象被上游重建」后依然生效（真实执行栈会 `{...policy, mode}`）
 *   - settings namespace 的装配与校验（客户端读写通道）
 *   - tools.register 注册的定义符合 ToolDefinition 契约（含必填的 output.render）
 *   - 关闭 effect 后所有包装都被还原
 *
 * 运行：node tests/apply.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalPath, Config, default as plugin, featureOnOf, isUnder, normalizeState, pruneMissingRoots } from '../index.js'

let passed = 0
const failures = []

/** cosmokit volatile 引用的最小替身：loader 提交后原地更新 `.get()` 的快照。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
function makeVolatileRef(initial = {}) {
  let current = structuredClone(initial)
  return Object.freeze({
    get: () => current,
    [VOLATILE_WRITE]: (value) => {
      current = structuredClone(value)
    },
  })
}

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  ok  ${name}\n`)
  } catch (error) {
    failures.push(name)
    process.stdout.write(`FAIL  ${name}\n      ${error && error.message ? error.message : String(error)}\n`)
  }
}

// ── 最小 Cordis 上下文 ───────────────────────────────────────────────────────

/**
 * 构造一个只实现本插件真正用到的能力的上下文。
 * @param {object} options 选项。
 * @returns {object} 含 ctx、服务替身与调用记录。
 */
function makeHarness(options = {}) {
  const services = options.services ?? {}
  const disposers = []
  const logs = []
  const scopes = []
  const events = []

  const context = {
    get: (name) => services[name],
    /** 真实 cordis 上下文携带 fiber（settings.configure 需要它指认宿主插件实例）。 */
    fiber: { id: 'test-fiber' },
    logger: {
      warn: (message) => logs.push(['warn', message]),
      info: (message) => logs.push(['info', message]),
    },
    provide(name, value) {
      if (services[name] !== undefined) throw new Error(`provide(${name}) 重复`)
      services[name] = value
      disposers.push(() => {
        delete services[name]
      })
    },
    effect(fn, label) {
      const dispose = fn()
      disposers.push(typeof dispose === 'function' ? dispose : () => {})
      logs.push(['effect', label])
    },
    on(event, callback) {
      events.push([event, callback])
      return () => {
        const at = events.findIndex((entry) => entry[0] === event && entry[1] === callback)
        if (at >= 0) events.splice(at, 1)
      }
    },
    inject(deps, callback) {
      const scope = {
        ...context,
        get: (name) => services[name],
        effect: context.effect,
      }
      scopes.push({ deps, label: `${deps.join(',')}` })
      callback(scope)
    },
  }
  return { ctx: context, services, disposers, logs, scopes, events }
}

/** sandboxPolicy 替身：resolve 返回策略，并按需记录 workspaceRoot 的调用。 */
function makeSandboxPolicy(workspaceRoot) {
  const calls = []
  return {
    sandboxPolicy: {
      defaultMode: 'workspace-write',
      workspaceRoot,
      resolve(request = {}) {
        calls.push(request)
        return { mode: 'workspace-write', workspaceRoot }
      },
    },
    policyCalls: calls,
  }
}

/** sandbox 替身：按 `dsh-sandbox-local` 的 bwrap 配置生成 argv（只有 workspace-write 才绑定工作区）。 */
function makeSandbox(workspaceRoot) {
  const extraArgs = []
  return {
    /** 记录包装层透传进来的 confine 第三参（dsh 0.1.7+ 是 AbortSignal）。 */
    extraArgs,
    confine(argv, policy, ...rest) {
      if (rest.length > 0) extraArgs.push(rest)
      const profile = ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--dev', '/dev']
      if (policy.mode === 'workspace-write') profile.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
      return {
        argv: [...profile, '--', ...argv],
        enforcement: 'full',
      }
    },
  }
}

/**
 * fs 替身：按 `dsh-fs-sandbox` 的真实结构模拟执法点 —— `writeText`/`editText`
 * 都先过 `checkedTarget`（判定写在它里面），再落到后端。
 * 默认可写根只含工作区（真实围栏还含 /tmp 与 os.tmpdir()，这里刻意收窄，
 * 否则 scratch 就在 /tmp 下、附加目录无论如何都会被放行，测不出区别）。
 */
function makeFs(workspaceRoot) {
  const writes = []
  const denied = () => Object.assign(new Error('file access denied under workspace-write mode'), { code: 'FS_SANDBOX_DENIED' })
  return {
    sandboxMode: 'workspace-write',
    written: writes,
    processPath: (target) => (typeof target === 'string' ? target : target?.path ?? ''),
    async resolve(path) {
      return { displayPath: canonicalPath(String(path)) }
    },
    async checkedTarget(target, policy) {
      const mode = policy?.mode ?? 'read-only'
      if (mode === 'danger-full-access') return target
      if (mode === 'read-only') throw denied()
      const fresh = await this.resolve(target.displayPath)
      const roots = [canonicalPath(policy.workspaceRoot ?? workspaceRoot), canonicalPath(join(tmpdir(), 'dpe-tmp'))]
      if (!roots.some((root) => isUnder(fresh.displayPath, root))) throw denied()
      return fresh
    },
    async writeText(target, content, expected, signal, policy) {
      const checked = await this.checkedTarget(target, policy)
      writes.push({ target: checked.displayPath, policy })
      return { ok: true }
    },
    async editText(target, edit, expected, signal, policy) {
      return this.writeText(target, edit, expected, signal, policy)
    },
  }
}

/** tools 替身：记录注册的定义。 */
function makeTools() {
  const registered = []
  return {
    registered,
    tools: {
      list: () => registered.map((value) => ({ value })),
      register(definition) {
        registered.push(definition)
        return () => {
          registered.pop()
        }
      },
    },
  }
}

/**
 * settings 替身：只实现本插件用到的 `configure` / `replace`。`replace` 按
 * 真实链路（settings → configEditor → loader）模拟：原地更新 config 引用，
 * 再向插件上下文发 `loader/volatile-update`。
 * @param {{workspaces: object}} config 传给 apply 的插件 config。
 * @param {() => void} emit 触发 loader/volatile-update 事件。
 */
function makeSettings(config, emit = () => {}) {
  const calls = []
  const api = {
    calls,
    failWith: undefined,
    configured: [],
    service: {
      configure(presentation, owner) {
        api.configured.push({ presentation, owner })
        return () => {}
      },
      async replace(ns, section) {
        calls.push({ op: 'replace', ns, section })
        if (api.failWith !== undefined) throw new Error(api.failWith)
        config.workspaces[VOLATILE_WRITE](structuredClone(section.workspaces ?? {}))
        emit()
      },
    },
  }
  return api
}

const scratch = mkdtempSync(join(tmpdir(), 'dpe-apply-'))
const workspaceDir = join(scratch, 'workspace')
const extraDir = join(scratch, 'extra')
mkdirSync(workspaceDir, { recursive: true })
mkdirSync(extraDir, { recursive: true })
const stateFile = join(scratch, 'state.json')

/**
 * 组装一个已 apply 的完整环境。
 * 每个用例使用独立的 DSH_HOME，避免状态文件在用例之间互相污染。
 */
async function boot(overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dpe-home-'))
  const services = {
    ...makeSandboxPolicy(canonicalPath(workspaceDir)),
    sandbox: makeSandbox(canonicalPath(workspaceDir)),
    fs: makeFs(canonicalPath(workspaceDir)),
    ...overrides.services,
  }
  const harness = makeHarness({ services })
  /** 触发 loader 的 volatile 提交事件（真实链路由 loader 发出）。 */
  harness.emitVolatileUpdate = () => {
    for (const [event, callback] of harness.events) {
      if (event === 'loader/volatile-update') callback([])
    }
  }
  const config = 'config' in overrides ? overrides.config : { workspaces: makeVolatileRef(overrides.workspaces ?? {}), features: makeVolatileRef(overrides.features ?? {}) }
  harness.config = config
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await plugin.apply(harness.ctx, config)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  harness.home = home
  return harness
}

process.stdout.write('\n[plugin shape]\n')

await test('默认导出是 Cordis 插件（name + apply）', () => {
  assert.equal(plugin.name, 'toolkit')
  assert.equal(typeof plugin.apply, 'function')
})

await test('apply 把状态文件放在 $DSH_HOME/permission-extras.json 下', async () => {
  const harness = await boot()
  assert.equal(harness.services.permissionExtras.file, join(harness.home, 'permission-extras.json'))
})

process.stdout.write('\n[services and hooks]\n')

await test('provide permissionExtras，且全部 hook 注册', async () => {
  const harness = await boot()
  assert.ok(harness.services.permissionExtras !== undefined, 'permissionExtras 服务必须暴露')
  const labels = harness.logs.filter((entry) => entry[0] === 'effect').map((entry) => entry[1])
  for (const needle of ['sandbox.confine', 'fs.checkedTarget']) {
    assert.ok(
      labels.some((label) => typeof label === 'string' && label.includes(needle)),
      `缺少 hook: ${needle}（实际：${labels.join(' | ')}）`,
    )
  }
  assert.ok(!labels.some((label) => String(label).includes('elevated')), '不应注册多余的 hook')
})

await test('附加目录按工作区隔离（不依赖任何策略对象）', async () => {
  const harness = await boot()
  const service = harness.services.permissionExtras
  await service.addRoot(canonicalPath(workspaceDir), extraDir)
  assert.deepEqual(service.extraRootsFor(canonicalPath(workspaceDir)), [canonicalPath(extraDir)])
  assert.deepEqual(service.extraRootsFor(workspaceDir), [canonicalPath(extraDir)], '非规范拼写也要命中')
  assert.deepEqual(service.extraRootsFor(join(scratch, 'other')), [], '工作区之间互相独立')
})

await test('sandbox.confine 对「被上游重建过」的策略对象仍插入 --bind', async () => {
  const harness = await boot()
  await harness.services.permissionExtras.addRoot(canonicalPath(workspaceDir), extraDir)
  const resolved = harness.services.sandboxPolicy.resolve({})
  // 真实执行栈就是这么干的：dsh-bash-sandbox 用 `{...policy, mode}` 交给 confine，
  // 任何挂在策略对象上的私有标记都会在这步丢掉 —— 回归点。
  const rebuilt = { mode: resolved.mode, workspaceRoot: resolved.workspaceRoot }
  const confined = harness.services.sandbox.confine(['bash', '-c', 'echo hi'], rebuilt)
  const separator = confined.argv.indexOf('--')
  const before = confined.argv.slice(0, separator)
  const at = before.indexOf(canonicalPath(extraDir))
  assert.ok(at > 0, `附加目录必须出现在沙箱参数里：${confined.argv.join(' ')}`)
  assert.deepEqual(before.slice(at - 1, at + 2), ['--bind', canonicalPath(extraDir), canonicalPath(extraDir)])
  assert.equal(before.filter((item) => item === '--bind').length, 2, '原工作区绑定 + 一个附加目录绑定')

  // 未登记的工作区：同一台沙箱上不得插入任何附加目录
  const other = harness.services.sandbox.confine(['bash', '-c', 'echo hi'], {
    mode: 'workspace-write',
    workspaceRoot: canonicalPath(join(scratch, 'other')),
  })
  assert.equal(other.argv.filter((item) => item === '--bind').length, 1, '只应有工作区自己的绑定')

  // read-only / danger-full-access 都不下发附加目录
  const readOnly = harness.services.sandbox.confine(['bash', '-c', 'echo hi'], { mode: 'read-only', workspaceRoot: canonicalPath(workspaceDir) })
  assert.equal(readOnly.argv.filter((item) => item === '--bind').length, 0, 'read-only 不得放宽')
})

await test('fs 写入：附加目录内放行，工作区外仍被围栏拒绝', async () => {
  const harness = await boot()
  await harness.services.permissionExtras.addRoot(canonicalPath(workspaceDir), extraDir)
  const fs = harness.services.fs
  const resolved = harness.services.sandboxPolicy.resolve({})
  // 真实工具先 `fs.resolve(path)`，再把解析结果对象交给 writeText
  const at = (path) => ({ displayPath: path })
  await fs.writeText(at(join(extraDir, 'a.txt')), 'x', undefined, undefined, resolved)
  await fs.writeText(at(join(workspaceDir, 'b.txt')), 'x', undefined, undefined, resolved)
  assert.equal(fs.written.length, 2)

  // 重建过的策略对象（同一回归点）：附加目录仍必须放行
  const rebuilt = { mode: resolved.mode, workspaceRoot: resolved.workspaceRoot }
  await fs.writeText(at(join(extraDir, 'c.txt')), 'x', undefined, undefined, rebuilt)
  assert.equal(fs.written.length, 3, '策略对象被重建后附加目录仍必须生效')

  // 没有登记该工作区 → 围栏照旧拒绝（不得因为表里有别的条目而放宽）
  await assert.rejects(
    () =>
      fs.writeText(at(join(extraDir, 'd.txt')), 'x', undefined, undefined, {
        mode: 'workspace-write',
        workspaceRoot: canonicalPath(join(scratch, 'other')),
      }),
    /denied/,
    '未登记的工作区必须仍然被拒绝',
  )
  // read-only 下不因附加目录放行
  await assert.rejects(
    () =>
      fs.writeText(at(join(extraDir, 'e.txt')), 'x', undefined, undefined, {
        mode: 'read-only',
        workspaceRoot: canonicalPath(workspaceDir),
      }),
    /denied/,
    'read-only 下不得因附加目录放行',
  )
})

process.stdout.write('\n[model tool]\n')

await test('tools.register 收到符合 ToolDefinition 契约的定义', async () => {
  const registered = makeTools()
  const harness = await boot({ services: { tools: registered.tools } })
  assert.equal(registered.registered.length, 1)
  const tool = registered.registered[0]
  assert.equal(tool.name, 'permission_extras')
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.parameters.action.required === true)
  assert.deepEqual(tool.parameters.action.enum, ['list', 'add', 'remove'])
  // ToolOutputDefinition.render 是必填项
  assert.equal(typeof tool.output.schema, 'object')
  assert.equal(typeof tool.output.render, 'function')
  const blocks = tool.output.render({ action: 'list' }, { action: 'list', workspacePath: workspaceDir, roots: [] })
  assert.equal(Array.isArray(blocks), true)
  assert.equal(blocks[0].type, 'text')
  assert.equal(typeof blocks[0].text, 'string')

  // 执行路径
  const exec = { agent: { session: { header: { cwd: workspaceDir } } } }
  const listed = await tool.execute({ action: 'list' }, exec)
  assert.deepEqual(listed, { action: 'list', workspacePath: canonicalPath(workspaceDir), roots: [] })
  const added = await tool.execute({ action: 'add', path: extraDir }, exec)
  assert.deepEqual(added.roots, [canonicalPath(extraDir)])
  const removed = await tool.execute({ action: 'remove', path: extraDir }, exec)
  assert.equal(removed.removed, true)
  await assert.rejects(() => tool.execute({ action: 'nope' }, exec), /未知 action/)
  await assert.rejects(() => tool.execute({ action: 'list' }, { agent: undefined }), /没有工作区目录/)
  void harness
})

process.stdout.write('\n[system prompt]\n')

await test('systemPrompt.context 只在该会话工作区确有附加目录时给文本', async () => {
  const contributions = []
  const harness = await boot({
    services: {
      ...makeSandboxPolicy(canonicalPath(workspaceDir)),
      sandbox: makeSandbox(canonicalPath(workspaceDir)),
      fs: makeFs(canonicalPath(workspaceDir)),
      systemPrompt: {
        getContextOrder(name) {
          assert.equal(name, 'SANDBOX_POLICY')
          return 42
        },
        context(contribution) {
          contributions.push(contribution)
          return () => {}
        },
      },
    },
  })
  assert.equal(contributions.length, 1)
  const contribution = contributions[0]
  assert.equal(contribution.name, 'permission:extras')
  assert.equal(contribution.order, 42)

  // 与官方 sandbox:policy 相同的取会话方式：context.agent.session
  const session = { id: 's1', header: { cwd: workspaceDir } }
  assert.equal(contribution.text({ agent: { session } }), '', '没有附加目录时不得注入文本')

  await harness.services.permissionExtras.addRoot(canonicalPath(workspaceDir), extraDir)
  const text = contribution.text({ agent: { session } })
  assert.ok(text.includes(canonicalPath(extraDir)), `应列出附加目录，实际：${text}`)
  // 另一个工作区的会话不应看到这条
  assert.equal(contribution.text({ agent: { session: { id: 's2', header: { cwd: join(scratch, 'other') } } } }), '')
  assert.equal(contribution.text({}), '')
  assert.equal(contribution.text({ agent: {} }), '')
})

process.stdout.write('\n[settings channel]\n')

await test('settings 在场时把缓存挂到 config 的 volatile 引用上，并关闭自动表单页', async () => {
  const config = { workspaces: makeVolatileRef({ [canonicalPath(workspaceDir)]: { roots: [canonicalPath(extraDir)] } }) }
  const settings = makeSettings(config, () => {})
  const harness = await boot({ config, services: { settings: settings.service } })
  assert.deepEqual(
    settings.configured,
    [{ presentation: { auto: false }, owner: harness.ctx.fiber }],
    '必须注册 auto:false 的页面策略（本插件自带整页设置）',
  )
  const service = harness.services.permissionExtras
  assert.equal(service.snapshot().source, 'settings')
  assert.deepEqual(service.extraRootsFor(canonicalPath(workspaceDir)), [canonicalPath(extraDir)], '缓存立即来自 config')
})

await test('外部提交（loader volatile 提交）后缓存跟着 config 走', async () => {
  const config = { workspaces: makeVolatileRef({}) }
  const settings = makeSettings(config, () => harness.emitVolatileUpdate())
  const harness = await boot({ config, services: { settings: settings.service } })
  const service = harness.services.permissionExtras
  assert.deepEqual(service.extraRootsFor(canonicalPath(workspaceDir)), [])
  // 模拟浏览器 mutate → settings 服务 → loader 提交：原地更新引用 + 发事件
  config.workspaces[VOLATILE_WRITE]({ [canonicalPath(workspaceDir)]: { roots: [canonicalPath(extraDir)] } })
  harness.emitVolatileUpdate()
  assert.deepEqual(service.extraRootsFor(canonicalPath(workspaceDir)), [canonicalPath(extraDir)])
  // 该工作区的附加目录要真的走到执法点（策略对象由上游重建，凭 workspaceRoot 命中）
  const policy = { ...harness.services.sandboxPolicy.resolve({}) }
  const confined = harness.services.sandbox.confine(['bash', '-c', 'echo hi'], policy)
  assert.ok(confined.argv.includes(canonicalPath(extraDir)), `写入授权必须进入沙箱参数：${confined.argv.join(' ')}`)
  // 其它工作区不受影响
  assert.deepEqual(service.extraRootsFor(join(scratch, 'other')), [])
})

await test('模型工具的写入走 settings.replace，不再写文件', async () => {
  const config = { workspaces: makeVolatileRef({}) }
  const settings = makeSettings(config, () => {})
  const tools = makeTools()
  const harness = await boot({ config, services: { settings: settings.service, tools: tools.tools } })
  const tool = tools.registered[0]
  const exec = { agent: { session: { header: { cwd: workspaceDir } } } }
  await tool.execute({ action: 'add', path: extraDir }, exec)
  const replace = settings.calls.find((entry) => entry.op === 'replace')
  assert.ok(replace !== undefined, 'settings 在场时必须走 settings.replace')
  assert.equal(replace.ns, 'toolkit')
  assert.deepEqual(replace.section.workspaces[canonicalPath(workspaceDir)].roots, [canonicalPath(extraDir)])
  assert.equal(existsSync(join(harness.home, 'permission-extras.json')), false, '不得再写回退文件')
  await tool.execute({ action: 'remove', path: extraDir }, exec)
  const last = settings.calls.filter((entry) => entry.op === 'replace').pop()
  assert.deepEqual(last.section.workspaces, {}, '删空后用户层不应残留该工作区')
  assert.deepEqual(config.workspaces.get(), {}, '替身 replace 已把引用更新为空表')
})

await test('settings.replace 失败时回滚内存表', async () => {
  const config = { workspaces: makeVolatileRef({}) }
  const settings = makeSettings(config, () => {})
  settings.failWith = 'settings 写入被拒绝'
  const harness = await boot({ config, services: { settings: settings.service } })
  const service = harness.services.permissionExtras
  await assert.rejects(() => service.addRoot(canonicalPath(workspaceDir), extraDir), /settings 写入被拒绝/)
  assert.deepEqual(service.extraRootsFor(canonicalPath(workspaceDir)), [], '失败后必须回滚')
})

await test('漂移自愈：外部写入失效目录后，插件写回干净表并收敛', async () => {
  const config = { workspaces: makeVolatileRef({}) }
  const settings = makeSettings(config, () => harness.emitVolatileUpdate())
  const harness = await boot({ config, services: { settings: settings.service } })
  const service = harness.services.permissionExtras
  // 模拟一次带失效目录的外部写入（浏览器侧无法 stat，这类值只有宿主能识别）
  config.workspaces[VOLATILE_WRITE]({ [canonicalPath(workspaceDir)]: { roots: ['/definitely/not/here'] } })
  harness.emitVolatileUpdate()
  await service.queue
  const heal = settings.calls.filter((entry) => entry.op === 'replace').pop()
  assert.ok(heal !== undefined, '应把干净表写回 settings')
  assert.deepEqual(heal.section.workspaces, {}, '失效目录必须被剔除')
  assert.deepEqual(service.extraRootsFor(canonicalPath(workspaceDir)), [])
  // 收敛：表已干净，再次事件不得触发新的写回
  const before = settings.calls.length
  harness.emitVolatileUpdate()
  await service.queue
  assert.equal(settings.calls.length, before, '干净表不应再触发写回')
})

await test('宿主未传 Config（无 workspaces 引用）时保留文件存储并警告', async () => {
  const settings = makeSettings({ workspaces: makeVolatileRef({}) }, () => {})
  const harness = await boot({ config: undefined, services: { settings: settings.service } })
  const service = harness.services.permissionExtras
  assert.equal(service.snapshot().source, 'file')
  assert.ok(
    harness.logs.some((entry) => entry[0] === 'warn' && String(entry[1]).includes('没有给本插件传入 Config')),
    `实际日志：${JSON.stringify(harness.logs)}`,
  )
})

await test('Config schema 拒绝形状非法的写入（新模型的第一道闸）', () => {
  const issues = (raw) => Config['~standard'].validate(raw).issues
  assert.ok(issues({ workspaces: { '/a': { roots: [1] } } }) !== undefined, 'roots 必须是字符串数组')
  assert.ok(issues({ workspaces: { '/a': 'zz' } }) !== undefined, '条目必须是对象')
  assert.ok(issues({ workspaces: [] }) !== undefined, 'workspaces 必须是对象')
  const ok = Config['~standard'].validate({ workspaces: { '/a': { roots: ['/b'] } } })
  assert.equal(ok.issues, undefined)
  assert.deepEqual(ok.value.workspaces.get(), { '/a': { roots: ['/b'] } })
})

await test('结构无效条目由 normalizeState 丢弃，失效目录由 pruneMissingRoots 裁掉', () => {
  const workspace = canonicalPath(workspaceDir)
  // 结构层：绝对路径、去重、未知字段、空 roots
  const state = normalizeState({ workspaces: { [workspace]: { roots: [extraDir, 'relative/path'], junk: 1 } } })
  assert.deepEqual(state.workspaces[workspace], { roots: [canonicalPath(extraDir)] }, '相对路径与未知字段被剥掉')
  assert.deepEqual(normalizeState({ workspaces: { [workspace]: { roots: [] } } }).workspaces, {}, '空 roots 条目整体删除')
  // 语义层：读路径继任旧 validate 钩子，失效目录（bwrap --bind 会失败）被裁掉
  const pruned = pruneMissingRoots(normalizeState({ workspaces: { [workspace]: { roots: [extraDir, '/definitely/not/here'] } } }))
  assert.deepEqual(pruned.workspaces[workspace].roots, [canonicalPath(extraDir)], '失效目录被裁掉，有效目录保留')
  const allGone = pruneMissingRoots(normalizeState({ workspaces: { [workspace]: { roots: ['/definitely/not/here'] } } }))
  assert.deepEqual(allGone.workspaces, {}, '全部失效时整条删除')
})

await test('confine 的额外参数（dsh 0.1.7+ 的 AbortSignal）被包装层透传', async () => {
  const harness = await boot()
  await harness.services.permissionExtras.addRoot(canonicalPath(workspaceDir), extraDir)
  const signal = { aborted: false }
  harness.services.sandbox.confine(['bash', '-c', 'echo hi'], { mode: 'workspace-write', workspaceRoot: canonicalPath(workspaceDir) }, signal)
  assert.ok(
    harness.services.sandbox.extraArgs.some((rest) => rest[0] === signal),
    '第三个参数必须原样透传给原始 confine',
  )
})

await test('没有 settings 提供方时退回文件存储，并记录一次警告', async () => {
  const harness = await boot()
  const service = harness.services.permissionExtras
  assert.equal(service.snapshot().source, 'file')
  assert.ok(
    harness.logs.some((entry) => entry[0] === 'warn' && String(entry[1]).includes('settings 服务不可用')),
    `实际日志：${JSON.stringify(harness.logs)}`,
  )
  await service.addRoot(canonicalPath(workspaceDir), extraDir)
  assert.equal(existsSync(join(harness.home, 'permission-extras.json')), true)
})

process.stdout.write('\n[state and teardown]\n')

await test('附加目录落盘到 $DSH_HOME/permission-extras.json', async () => {
  const harness = await boot()
  await harness.services.permissionExtras.addRoot(canonicalPath(workspaceDir), extraDir)
  const stored = JSON.parse(readFileSync(join(harness.home, 'permission-extras.json'), 'utf8'))
  assert.deepEqual(stored.workspaces[canonicalPath(workspaceDir)].roots, [canonicalPath(extraDir)])
  assert.equal(stored.version, 1)
  void harness
})

await test('state.json 损坏时以空表启动并记录一次警告', async () => {
  const brokenHome = mkdtempSync(join(tmpdir(), 'dpe-broken-'))
  writeFileSync(join(brokenHome, 'permission-extras.json'), '{ not json')
  const services = {
    ...makeSandboxPolicy(canonicalPath(workspaceDir)),
    sandbox: makeSandbox(canonicalPath(workspaceDir)),
    fs: makeFs(canonicalPath(workspaceDir)),
  }
  const harness = makeHarness({ services })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = brokenHome
  try {
    await plugin.apply(harness.ctx)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  assert.deepEqual(harness.services.permissionExtras.extraRootsFor(workspaceDir), [])
  assert.ok(harness.logs.some((entry) => entry[0] === 'warn' && String(entry[1]).includes('无法解析')))
  rmSync(brokenHome, { recursive: true, force: true })
})

await test('所有 effect 的 dispose 还原被包装的方法', async () => {
  const harness = await boot({
    services: {
      ...makeSandboxPolicy(canonicalPath(workspaceDir)),
      sandbox: makeSandbox(canonicalPath(workspaceDir)),
      fs: makeFs(canonicalPath(workspaceDir)),
    },
  })
  const confine = harness.services.sandbox.confine
  const checkedTarget = harness.services.fs.checkedTarget
  const writeText = harness.services.fs.writeText
  harness.disposers.forEach((dispose) => dispose())
  // 包装函数必须被换回原始实现：用 identity 检查（包装后的引用必然不同）
  assert.equal(typeof harness.services.sandbox.confine, 'function')
  assert.equal(typeof harness.services.fs.checkedTarget, 'function')
  assert.notEqual(harness.services.sandbox.confine, confine, 'dispose 后应还原原始 confine')
  assert.notEqual(harness.services.fs.checkedTarget, checkedTarget, 'dispose 后应还原原始 checkedTarget')
  assert.equal(harness.services.fs.writeText, writeText, '未包装的方法必须保持原引用')
  assert.equal(harness.services.permissionExtras, undefined, 'provide 的 disposer 应撤销服务')
})

process.stdout.write('\n[toolbox gate]\n')

await test('featureOnOf：缺省/异常一律 = 启用，false 才关闭', () => {
  assert.equal(featureOnOf(undefined)('permission-extras'), true, '无 config → 启用')
  assert.equal(featureOnOf({})('permission-extras'), true, '无 features 引用 → 启用')
  assert.equal(featureOnOf({ features: { get: () => ({}) } })('plannotator'), true, '空字典 → 启用')
  assert.equal(featureOnOf({ features: { get: () => ({ 'permission-extras': false }) } })('permission-extras'), false, 'false → 关闭')
  assert.equal(featureOnOf({ features: { get: () => ({ 'permission-extras': false }) } })('plannotator'), true, '只关闭被点名的功能')
  assert.equal(featureOnOf({ features: { get: () => { throw new Error('boom') } } })('permission-extras'), true, '查表异常 → 启用（fail-open）')
})

await test('工具箱关闭「自定义权限」：confine / checkedTarget 直通官方行为', async () => {
  const config = {
    workspaces: makeVolatileRef({}),
    features: makeVolatileRef({ 'permission-extras': false }),
  }
  const harness = await boot({ config })
  // 目录表照常可维护（重新打开即恢复，无需重挂插件）——只关执法点。
  await harness.services.permissionExtras.addRoot(canonicalPath(workspaceDir), extraDir)
  assert.deepEqual(harness.services.permissionExtras.extraRootsFor(canonicalPath(workspaceDir)), [canonicalPath(extraDir)])

  const resolved = harness.services.sandboxPolicy.resolve({})
  const rebuilt = { mode: resolved.mode, workspaceRoot: resolved.workspaceRoot }
  const confined = harness.services.sandbox.confine(['bash', '-c', 'echo hi'], rebuilt)
  assert.equal(confined.argv.filter((item) => item === '--bind').length, 1, '关闭时不得插入附加目录绑定')

  const fs = harness.services.fs
  const at = (path) => ({ displayPath: path })
  await fs.writeText(at(join(workspaceDir, 'ok.txt')), 'x', undefined, undefined, rebuilt)
  assert.equal(fs.written.length, 1)
  await assert.rejects(() => fs.writeText(at(join(extraDir, 'no.txt')), 'x', undefined, undefined, rebuilt), /denied/, '关闭时附加目录必须被围栏拒绝')
})

await test('工具箱关闭「自定义权限」：systemPrompt 不注入文本，工具明确拒绝', async () => {
  const contributions = []
  const tools = makeTools()
  const config = {
    workspaces: makeVolatileRef({}),
    features: makeVolatileRef({ 'permission-extras': false }),
  }
  const harness = await boot({
    config,
    services: {
      systemPrompt: { getContextOrder: () => 42, context: (c) => contributions.push(c) },
      tools: tools.tools,
    },
  })
  await harness.services.permissionExtras.addRoot(canonicalPath(workspaceDir), extraDir)
  const session = { id: 's1', header: { cwd: workspaceDir } }
  assert.equal(contributions[0].text({ agent: { session } }), '', '关闭时即使有登记目录也不注入文本')
  await assert.rejects(
    () => tools.registered[0].execute({ action: 'list' }, { agent: { session } }),
    /停用/,
    '关闭时工具必须明确拒绝而不是继续维护',
  )
})

await test('features 是 volatile 字段：运行期翻转立即改变执法点行为', async () => {
  const features = makeVolatileRef({ 'permission-extras': false })
  const config = { workspaces: makeVolatileRef({}), features }
  const harness = await boot({ config })
  await harness.services.permissionExtras.addRoot(canonicalPath(workspaceDir), extraDir)
  const rebuilt = { mode: 'workspace-write', workspaceRoot: canonicalPath(workspaceDir) }
  assert.equal(
    harness.services.sandbox.confine(['bash'], rebuilt).argv.filter((item) => item === '--bind').length,
    1,
    '初始关闭：只有工作区自己的绑定',
  )
  // 模拟浏览器 mutate → loader 原地更新引用（volatile 提交，不重挂插件）
  features[VOLATILE_WRITE]({ 'permission-extras': true })
  const reopened = harness.services.sandbox.confine(['bash'], rebuilt)
  assert.ok(reopened.argv.includes(canonicalPath(extraDir)), '重新打开后附加目录立即生效（现场查表）')
})

await test('Config schema：features 必须是布尔字典，非法形状被拒绝', () => {
  const issues = (raw) => Config['~standard'].validate(raw).issues
  assert.ok(issues({ features: { a: 'yes' } }) !== undefined, 'features 值必须是布尔')
  assert.ok(issues({ features: [] }) !== undefined, 'features 必须是对象')
  const ok = Config['~standard'].validate({ features: { 'permission-extras': false } })
  assert.equal(ok.issues, undefined, '布尔字典必须通过')
  const withWorkspaces = Config['~standard'].validate({
    workspaces: { '/a': { roots: ['/b'] } },
    features: { 'permission-extras': true },
  })
  assert.equal(withWorkspaces.issues, undefined, '两个 volatile 字段可以同时提交')
})

rmSync(scratch, { recursive: true, force: true })

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) process.exit(1)
