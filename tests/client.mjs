/**
 * dsh-powerbox — 浏览器半区测试（Node 可跑的部分）。
 *
 *   1. flags.js 行为：tk api 的 on/set/onChange/start 与官方 settings 通道契约
 *      （describe 读 features、mutate set/unset path、revision 传递、fail-open）。
 *      flags.js 是纯脚本片段（共享外层 TK），用 new Function 提供命名空间后直接执行。
 *   2. 产物新鲜度：client.js 必须与 client/ 源文件同步（跑一遍拼接脚本后逐字节一致）。
 *   3. 工具箱页与各功能文件的结构性断言在 tests/host-plannotator.mjs（静态）。
 *
 * 深度渲染用例（React stand-in）保留在原各包 tests/，可独立运行。
 *
 * 运行：node tests/client.mjs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)

let passed = 0
const failures = []
async function test(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures.push(label)
    console.error(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 在受控命名空间里执行 flags.js，返回 TK（含 createFlags）。 */
function loadFlags() {
  const source = readFileSync(join(root, 'client/flags.js'), 'utf8')
  const TK = { entryId: 'toolkit', FEATURES: [] }
  const factory = new Function('TK', `${source}\n;return TK;`)
  return factory(TK)
}

/** settings 服务替身：describe/mutate 都可编程；mutate 会真实更新后续 describe 的值。 */
function makeRemote({ features, failDescribe = false, failMutate = false } = {}) {
  const mutations = []
  let revision = 7
  const store = { ...(features ?? {}) }
  const remote = {
    mutations,
    describe: async () => {
      if (failDescribe) throw new Error('describe boom')
      return { ok: true, value: { namespaces: [{ ns: 'toolkit', revision, value: { features: { ...store } } }] } }
    },
    mutate: async (ns, ops, rev) => {
      if (failMutate) throw new Error('mutate boom')
      mutations.push({ ns, ops, rev })
      for (const op of ops) {
        if (op.path[0] !== 'features') continue
        if (op.op === 'set') store[op.path[1]] = op.value
        else if (op.op === 'unset') delete store[op.path[1]]
      }
      revision += 1
      return { ok: true, value: revision }
    },
  }
  return remote
}

process.stdout.write('\n[flags: toolbox switch client]\n')

await test('start 后 describe 的 features 进 api：false 生效，缺省 = 启用', async () => {
  const TK = loadFlags()
  const remote = makeRemote({ features: { 'permission-extras': false } })
  const intervals = []
  const ctx = { get: (n) => (n === 'remote.settings' ? remote : undefined), interval: (fn) => { intervals.push(fn); return () => {} } }
  const api = TK.createFlags(ctx)
  assert.equal(api.on('permission-extras'), true, 'refresh 前缺省启用')
  api.start()
  await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0))
  assert.equal(api.on('permission-extras'), false, 'describe 的 false 必须生效')
  assert.equal(api.on('plannotator'), true, '未点名的功能保持启用')
  assert.deepEqual(api.dict(), { 'permission-extras': false })
})

await test('set：乐观置位 + mutate op/set 路径 + revision 传递 + 轮询刷新', async () => {
  const TK = loadFlags()
  const remote = makeRemote({ features: {} })
  const intervals = []
  const ctx = { get: (n) => (n === 'remote.settings' ? remote : undefined), interval: (fn) => { intervals.push(fn); return () => {} } }
  const api = TK.createFlags(ctx)
  api.start()
  await new Promise((r) => setTimeout(r, 0))
  const events = []
  api.onChange((dict) => events.push({ ...dict }))

  const okSet = await api.set('plannotator', false)
  assert.equal(okSet, true, '写入成功')
  assert.equal(remote.mutations.length, 1, '必须走 settings.mutate')
  const call = remote.mutations[0]
  assert.equal(call.ns, 'toolkit', 'ns 必须是 entry id')
  assert.equal(call.rev, 7, '必须携带 describe 拿到的 revision')
  assert.deepEqual(call.ops, [{ op: 'set', path: ['features', 'plannotator'], value: false }], '关闭 = 显式 set false（unset 会落回缺省启用）')
  assert.equal(api.on('plannotator'), false, '写入后本地立即生效')
  assert.equal(events.length >= 1, true, '订阅者必须被通知')

  const okBack = await api.set('plannotator', true)
  assert.equal(okBack, true)
  assert.deepEqual(remote.mutations[1].ops, [{ op: 'set', path: ['features', 'plannotator'], value: true }], '开启 = set true')
  assert.equal(api.on('plannotator'), true)
})

await test('mutate 失败：本地回滚并保持订阅者一致', async () => {
  const TK = loadFlags()
  const remote = makeRemote({ features: {}, failMutate: true })
  const ctx = { get: (n) => (n === 'remote.settings' ? remote : undefined), interval: (fn) => fn() && (() => {}) }
  const api = TK.createFlags(ctx)
  api.start()
  await new Promise((r) => setTimeout(r, 0))
  const ok = await api.set('plannotator', false)
  assert.equal(ok, false, '失败必须返回 false')
  assert.equal(api.on('plannotator'), true, '失败后必须回滚到开启')
})

await test('通道不可用：fail-open 全开，set 不抛错', async () => {
  const TK = loadFlags()
  const ctx = { get: () => undefined, interval: (fn) => () => {} }
  const api = TK.createFlags(ctx)
  assert.equal(api.on('anything'), true)
  const ok = await api.set('anything', false)
  assert.equal(ok, false)
  assert.equal(api.on('anything'), true)
})

await test('describe 失败：保留上次已知状态，不误关功能', async () => {
  const TK = loadFlags()
  const remote = makeRemote({ features: { 'workspace-activity': false }, failDescribe: false })
  const ctx = { get: (n) => (n === 'remote.settings' ? remote : undefined), interval: (fn) => () => {} }
  const api = TK.createFlags(ctx)
  api.start()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(api.on('workspace-activity'), false)
  // 之后 describe 开始失败：已知名不被误翻转
  remote.failDescribe = true
  await api.refresh()
  assert.equal(api.on('workspace-activity'), false, 'describe 失败不得清空已知名')
})

process.stdout.write('\n[build freshness]\n')

await test('client.js 与 client/ 源文件同步（重跑拼接脚本后逐字节一致）', () => {
  const before = readFileSync(join(root, 'client.js'), 'utf8')
  execFileSync(process.execPath, [join(root, 'scripts/build-client.mjs')], { cwd: root, stdio: 'pipe' })
  const after = readFileSync(join(root, 'client.js'), 'utf8')
  assert.equal(before, after, 'client.js 已过期：请重跑 node scripts/build-client.mjs')
})

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) process.exit(1)
