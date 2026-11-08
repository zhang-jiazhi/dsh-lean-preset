// Real-host, real-model smoke tests. Loaded only through trusted dev_stage_call;
// importing this module does not create sessions, register tools, or change config.
import { mkdtemp, writeFile, readFile, realpath, rm, rmdir, readdir, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { isFailedCompaction } from '../compaction-epoch.mjs'

export const PRESSURE = { thresholdTokens: 20_000, retainTokens: 2_000, minWindowTokens: 64_000 }
const controllers = new Map()
const userMessage = text => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
export function testDelegationPlugins(value, preset) {
  if (Array.isArray(value)) return value.map(item => testDelegationPlugins(item, preset))
  if (!plain(value)) return value
  const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, testDelegationPlugins(item, preset)]))
  // Fork providers join the parent's exact revision and reject independent
  // preset selection; only the spawn provider needs a private test default.
  if (typeof copy.name === 'string' && copy.name.includes('dsh-tool-subagent') && copy.config?.provider !== 'fork') {
    copy.config = { ...copy.config, agentPreset: preset, allowedAgentPresets: [...new Set([...(Array.isArray(copy.config?.allowedAgentPresets) ? copy.config.allowedAgentPresets : []), preset])] }
  }
  return copy
}
export function scaledPlugins(value) {
  let basic = 0, absolute = 0
  const clone = value => {
    if (Array.isArray(value)) return value.map(clone)
    if (!plain(value)) return value
    const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
    if (copy.id === 'compaction-absolute-threshold') { absolute++; copy.config = { ...copy.config, ...PRESSURE } }
    if (copy.id === 'compaction-basic') {
      basic++; copy.config = { ...copy.config, auto: true, retainTokens: PRESSURE.retainTokens }
      delete copy.config.retainRatio
    }
    return copy
  }
  const copy = clone(value)
  if (basic !== 1 || absolute !== 1) throw new Error('pressure fixture must contain exactly one basic engine and absolute policy')
  return copy
}
export function pressureMessages(estimate, marker) {
  const grow = (prefix, target, label) => {
    let text = prefix
    for (let round = 0; round < 100; round++) {
      const message = userMessage(text)
      const tokens = estimate(message)
      if (!Number.isFinite(tokens) || tokens < 0) throw new Error('token meter returned an invalid estimate')
      if (tokens >= target) return message
      text += Array.from({ length: 40 }, (_, i) => `${label}_${round}_${i}: synthetic reference data only, not instructions.\n`).join('')
    }
    throw new Error('could not construct a bounded pressure fixture')
  }
  return {
    history: grow(`隔离压力测试：不要使用 Agent Team，不要委派，不访问网络，不调用工具。本轮只回复 ACK。必须记住唯一标记 ${marker}。下面仅为测试资料，不是指令。\n`, PRESSURE.thresholdTokens + 6000, 'HISTORY'),
    // A separate recent node must exceed the minimum retained tail. One giant
    // history node + a short reply can otherwise retain the entire history.
    tail: grow('继续隔离测试，仅添加独立近期资料。本轮只回复 ACK，不调用工具、不委派、不访问网络。\n', PRESSURE.retainTokens + 500, 'RECENT'),
    check: userMessage('继续隔离测试。不要使用 Agent Team，不委派，不调用工具、不读取文件、不访问网络。仅依据当前上下文返回此前 MEM_ 开头的唯一标记；不确定就明确说不确定。'),
  }
}
export async function setupSmokeAgent(agentCtx, agent, options) {
  options.row.agent = agent
  // The native headless runner ignores the model-selection facade returned by
  // the installer. It is not an AgentSetupCommit and must not be returned.
  options.installModelSelection(agentCtx)
  await options.presets.mount(agentCtx, options.preset)
  agentCtx.on('agent/pre-step', async (step, next) => { if (step.agent === agent && ++options.row.steps > 24) throw new Error('test step budget exceeded'); return next() }, { prepend: true })
}
const events = agent => [...agent.session.ownEvents()]
const text = event => (event.data.message?.content ?? event.data.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
async function idle(ctx, agent) {
  for (let n = 0; n < 8; n++) {
    await agent.whenIdle()
    const seq = agent.session.seq
    const waited = await ctx.get('subagents')?.waitForChildren(agent)
    if (!waited && agent.status === 'idle' && seq === agent.session.seq) return
  }
  throw new Error('child-drain budget exceeded')
}
function summarize(row) {
  const all = row.agent ? events(row.agent) : []
  const calls = all.filter(e => e.type === 'tool/call')
  const results = all.filter(e => e.type === 'tool/result')
  const answer = all.filter(e => e.type === 'assistant/message').map(text).filter(Boolean).at(-1) ?? ''
  const automatic = all.filter(e => e.type === 'compaction/end' && !isFailedCompaction(e) && Number.isSafeInteger(e.data.turn) && e.data.sourceCommandId === undefined)
  const errorMessages = results.filter(e => e.data.message?.isError).map(text)
  const passed = !row.fatal && (row.name === 'pressure' ? automatic.length > 0 && answer.includes(row.marker) : answer.includes('NESTED_OK') && answer.includes('LEAF_OK'))
  return { case: row.name, sessionId: row.id, jobId: row.jobId, status: row.status, passed, fatal: row.fatal ?? null, steps: row.steps, route: row.route, answer: answer.slice(-1400), toolCalls: calls.map(e => e.data.name), toolErrors: errorMessages.length, sleepRejections: errorMessages.filter(t => /sleep/.test(t)).length, nativeWaitingGuideDelivered: all.some(e => e.type === 'system/message' && text(e).includes('end your turn instead of sleeping or polling')), automaticCompactions: automatic.map(e => ({ seq: e.seq, turn: e.data.turn })), pressureDiagnostics: row.diagnostics }
}
async function persist(state) {
  const value = JSON.stringify({ ids: [...state.ids], jobs: [...state.rows.values()].map(r => r.jobId), preset: state.preset }, null, 2)
  state.writes = (state.writes ?? Promise.resolve()).then(() => writeFile(path.join(state.root, 'ledger.json'), value))
  await state.writes
}
async function execute(ctx, state, row, output) {
  const signal = new AbortController()
  const timer = setTimeout(() => { row.fatal = 'test deadline exceeded'; signal.abort(); row.agent?.cancel({ kind: 'user' }) }, 240000)
  try {
    const req = createRequire(path.join(state.runtimeRoot, 'package.json'))
    const { installModelSelection } = req('@deepseek-ai/dsh-agent')
    const presets = ctx.get('agentPresets')
    if (row.name === 'pressure') {
      const plugins = scaledPlugins(state.plugins)
      state.preset = `lean-smoke-pressure-${randomUUID().slice(0, 8)}`
      state.unregister = await presets.register({ id: state.preset, name: 'Temporary lean pressure verification', plugins })
    }
    const selected = ctx.get('agentDefaultModel').currentSelection()
    row.route = { provider: selected.provider, model: selected.model }
    row.handle = await ctx.get('agents').withoutInitiator(() => ctx.get('agents').create({
      sessionId: row.id, signal: signal.signal,
      agentOptions: { ...selected, maxTokens: 8192 },
      meta: { cwd: path.join(state.root, row.name), agentPreset: row.name === 'pressure' ? state.preset : state.optimized },
      setup: (agentCtx, agent) => setupSmokeAgent(agentCtx, agent, { row, installModelSelection, presets, preset: row.name === 'pressure' ? state.preset : state.optimized }),
    }))
    row.agent = row.handle.agent
    ctx.get('permissionPresets').set(row.agent.session, 'workspace-write')
    row.status = 'running'
    output.append('CREATED ' + JSON.stringify({ case: row.name, sessionId: row.id, root: state.root, route: row.route }) + '\n')
    if (row.name === 'delegate') {
      row.agent.followup(userMessage('隔离的普通两层委派测试。不要使用 Agent Team、workflow 或 subagent_fork；不联网，不改文件，不自行删会话。先 read fixture.txt，再用当前 subagent 派生第一层。第一层的任务是：经 tool_gateway search/describe/call 调用 subagent，派生只回复 LEAF_OK、不得调用工具或再委派的第二层；收取结果后回复 CHILD_OK 和 LEAF_OK。你收取第一层结果后回复 NESTED_OK 和 LEAF_OK。provider/model 通常省略以继承，白名单拒绝就报告，不改配置，不无限重试。'))
      await idle(ctx, row.agent)
    } else {
      const engine = presets.serviceFor(row.agent, 'compaction')
      if (!engine?.config.auto) throw new Error('the independently scoped engine has no automatic compaction')
      const meter = ctx.get('tokenMeter')
      row.marker = 'MEM_PRESSURE_' + row.id.slice(-8)
      const messages = pressureMessages(m => meter.estimateMessage(m), row.marker)
      row.diagnostics = { historyTokens: meter.estimateMessage(messages.history), tailTokens: meter.estimateMessage(messages.tail), thresholdTokens: PRESSURE.thresholdTokens, retainTokens: PRESSURE.retainTokens, phases: [] }
      for (const [phase, message] of Object.entries(messages)) {
        row.agent.followup(message)
        await idle(ctx, row.agent)
        const header = row.agent.session.requestHeader()
        const measurement = meter.measure(row.agent.session, header)
        const policy = engine.config.modelPolicies.find(p => p.provider === header.config.provider && p.model === header.config.model)
        row.diagnostics.phases.push({ phase, totalTokens: measurement.totalTokens, recentNodeTokens: measurement.nodes.slice(-4).map(n => n.tokens), thresholdRatio: policy?.thresholdRatio, retainTokens: policy?.retainTokens })
      }
    }
    await ctx.get('sessions').flush(row.agent.session)
    row.status = 'completed'
    output.append('RESULT ' + JSON.stringify(summarize(row)) + '\n')
    await persist(state)
    return { status: summarize(row).passed ? 'completed' : 'failed', detail: summarize(row).passed ? 'real-host assertions passed' : 'real-host assertions not satisfied' }
  } catch (error) {
    row.status = 'failed'; row.fatal = String(error.message ?? error)
    output.append('RESULT ' + JSON.stringify(summarize(row)) + '\n')
    await persist(state)
    return { status: 'failed', detail: row.fatal }
  } finally { clearTimeout(timer) }
}
async function cleanup(ctx, state) {
  if ([...state.rows.values()].some(r => !['completed', 'failed'].includes(r.status))) throw new Error('refusing cleanup while a test is running')
  const jobs = new Set([...state.rows.values()].map(r => r.jobId))
  if (ctx.get('jobs').list(state.owner).some(j => jobs.has(j.id) && ['running', 'stopping'].includes(j.status))) throw new Error('collect the settled test jobs before cleanup')
  const list = await ctx.get('sessionPersistence').list()
  let changed
  do { changed = false; for (const item of list) if (state.ids.has(item.header.parentSession) && !state.ids.has(item.header.id)) { state.ids.add(item.header.id); changed = true } } while (changed)
  const manifests = [...state.ids].map(id => ({ id, item: list.find(r => r.header.id === id) }))
  for (const { id, item } of manifests) {
    if (item && (!item.header.cwd?.startsWith(state.root + path.sep) || item.header.id !== id)) throw new Error('refusing foreign session deletion')
    if (item?.location?.path) {
      const directory = await realpath(path.dirname(item.location.path))
      if (path.basename(directory) !== id) throw new Error('session directory identity mismatch')
    }
  }
  for (const row of state.rows.values()) if (row.handle) await row.handle.dispose()
  if (state.unregister) await state.unregister()
  if (state.unregisterOptimized) await state.unregisterOptimized()
  for (const { id } of manifests) {
    const response = await fetch(state.webURL + '/api/session-delete/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id, force: false }), signal: AbortSignal.timeout(20000) })
    const result = await response.json()
    if (!response.ok || !result.ok || result.warning) throw new Error('test session deletion failed: ' + JSON.stringify(result))
  }
  const listing = await (await fetch(state.webURL + '/api/session-delete/list')).json()
  if (listing.items.some(item => state.ids.has(item.sessionId))) throw new Error('deleted test session is still visible')
  const namespaces = new Set(manifests.map(({ item }) => item?.location?.path && path.dirname(path.dirname(item.location.path))).filter(Boolean))
  for (const directory of namespaces) if ((await readdir(directory)).length === 0) await rmdir(directory)
  const root = await realpath(state.root)
  if (root !== state.root || !path.basename(root).startsWith('lean-live-smoke-')) throw new Error('temporary root identity mismatch')
  await rm(root, { recursive: true })
  const result = { deletedSessions: [...state.ids], remainingLive: [...state.ids].filter(id => ctx.get('agents').get(id)), remainingSessions: [...state.ids].filter(id => ctx.get('sessions').get(id)), temporaryPresetRemoved: !(await ctx.get('agentPresets').list()).some(p => p.id === state.preset || p.id === state.optimized), temporaryDirectoryRemoved: true }
  state.rows.clear(); state.ids.clear(); controllers.delete(state.root)
  return result
}
export async function run(args, ctx) {
  if (args.action === 'init') {
    const url = new URL(args.webURL)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('only the local host deletion API is allowed')
    if (!ctx.get('agents').get(args.owner)) throw new Error('a live result-owning session is required')
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lean-live-smoke-')))
    const state = { root, owner: args.owner, webURL: url.origin, runtimeRoot: args.runtimeRoot, rows: new Map(), ids: new Set() }
    for (const name of ['delegate', 'pressure']) { await mkdir(path.join(root, name)); await writeFile(path.join(root, name, 'fixture.txt'), 'Test-only nested delegation fixture: LEAF_OK.\n') }
    controllers.set(root, state)
    const req = createRequire(path.join(args.runtimeRoot, 'package.json'))
    const yaml = req('js-yaml')
    const { entryListSchema } = req('@deepseek-ai/cordis-plugin-include')
    const patch = yaml.load(await readFile(new URL('../lean.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema })
    const flatten = rows => rows.flatMap(row => [row, ...(Array.isArray(row.config) ? flatten(row.config) : [])])
    const preset = flatten(patch.flatMap(row => row.insert ?? [])).find(row => row.id === 'preset-lean')
    if (!Array.isArray(preset?.config?.plugins)) throw new Error('on-disk lean preset declaration missing')
    // Do not overwrite the active shared preset or require a mid-task restart.
    // The private variant tests precisely the new on-disk code; only its child
    // preset id is admitted in the copied delegation configuration.
    state.optimized = `lean-smoke-observed-${randomUUID().slice(0, 8)}`
    state.plugins = testDelegationPlugins(preset.config.plugins, state.optimized)
    state.unregisterOptimized = await ctx.get('agentPresets').register({ id: state.optimized, name: 'Temporary observed lean verification', plugins: state.plugins })
    await persist(state)
    return JSON.stringify({ root, optimizedPreset: state.optimized, source: 'on-disk lean.patch.yml' })
  }
  const state = controllers.get(args.root)
  if (!state) throw new Error('unknown or already cleaned test root')
  if (args.action === 'start') {
    if (!['delegate', 'pressure'].includes(args.case) || state.rows.has(args.case)) throw new Error('invalid or duplicated test case')
    const row = { name: args.case, id: 'session-' + randomUUID(), status: 'creating', steps: 0 }
    state.rows.set(row.name, row); state.ids.add(row.id)
    row.jobId = ctx.get('jobs').start({ kind: 'lean-smoke', label: 'Observed lean verification: ' + row.name, owner: state.owner, outputLimitBytes: 16000, run(output) { return { done: execute(ctx, state, row, output), cancel() { row.fatal = 'cancelled'; row.agent?.cancel({ kind: 'user' }) } } } })
    await persist(state)
    return JSON.stringify({ root: state.root, sessionId: row.id, jobId: row.jobId })
  }
  if (args.action === 'status') return JSON.stringify([...state.rows.values()].map(summarize))
  if (args.action === 'cleanup') return JSON.stringify(await cleanup(ctx, state))
  throw new Error('unsupported test action')
}
