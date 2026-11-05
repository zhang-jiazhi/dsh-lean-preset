import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply, parseRules } from '../rules-hybrid.mjs'
import { apply as bootstrap } from '../tool-bootstrap.mjs'
import { runtimeRequire } from './runtime-helper.mjs'

const resolve = runtimeRequire.resolve
const { Session, SESSION_FORMAT_VERSION } = await import(pathToFileURL(resolve('@deepseek-ai/dsh-session')).href)
let nextId = 0
const fresh = () => Session.create(`hybrid-test-${++nextId}`)
const restore = s => Session.fromRestore(s.id, structuredClone(s.snapshotEvents()), structuredClone(s.header), s.inheritedEventCount, 'detached')
const fork = parent => {
  const seed = parent.snapshotEvents()
  const id = `hybrid-fork-${++nextId}`
  return Session.create(id, seed, { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: true, origin: 'subagent', parentSession: parent.id, agentPreset: 'lean', delegationDepth: 1 }, seed.length)
}
const sample = `# Rules\n\n## 0. 核心\n\n- CORE_V1: preserve scope.\n\n## 1. 红线\n\n> 适用：Git 写操作\n\n- GIT_BODY_V1: preserve hooks.\n\n## 2. 证据优先级\n\n> 适用：核对证据\n\n- EVIDENCE_BODY_V1: inspect inputs.\n\n## 4. 会话记录\n\n> 适用：交接与恢复\n\n- RECORD_BODY_V1: keep useful outcomes.\n\n## 5. 编码\n\n> 适用：代码修改\n\n- CODING_BODY_V1: use focused tests.\n\n## 6. 排障\n\n> 适用：故障定位\n\n- DEBUG_BODY_V1: compare hypotheses.\n`

async function fixture(t, content = sample, services = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lean-hybrid-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'AGENTS.md')
  await writeFile(file, content)
  const hooks = new Map()
  const tools = new Map()
  const warnings = []
  const ctx = { on: (name, fn) => hooks.set(name, fn), tools: { register: tool => tools.set(tool.name, tool) }, get: name => services[name], logger: { warn: text => warnings.push(text) } }
  apply(ctx, { rulesFile: file })
  const agent = (session = fresh(), pending = []) => ({ session, inbox: { nextStep: pending, append(target, value) { assert.equal(target, 'next-step'); pending.push(value) }, clear() { pending.length = 0 } } })
  const pre = (a, incoming = [], options = {}) => hooks.get('agent/pre-step')({ agent: a, ...options }, async () => ({ kind: 'enter', messages: incoming }))
  const commit = (a, messages) => {
    for (const message of messages) {
      const event = a.session.append('user/message', message, { surfaceOp: 'append' })
      hooks.get('session/event')(a.session, event)
    }
  }
  const load = (a, sections) => tools.get('rule_load').execute({ sections }, { agent: a })
  return { file, dir, hooks, tools, warnings, agent, pre, commit, load, set: text => writeFile(file, text) }
}
const textOf = messages => messages.flatMap(message => typeof message.content === 'string' ? [{ text: message.content }] : (message.content ?? [])).map(block => block.text ?? '').join('\n')
const meta = message => message.source.rules

test('version data never rides the bounded notice summary', async t => {
  const f = await fixture(t)
  const messages = (await f.pre(f.agent())).messages
  const source = messages[0].source
  assert.equal(source.form, 'notice')
  assert.ok(source.summary.length > 0 && source.summary.length <= 120)
  assert.doesNotMatch(source.summary, /[{}]|revision/)
  assert.equal(source.rules.version, 1)
  assert.match(source.rules.revision, /^[a-f0-9]{64}$/)
  const loaded = await f.load(f.agent(), ['5'])
  assert.match(loaded.text, /^Loaded/)
})

test('parser separates applicability metadata and ignores headings inside fences', () => {
  const parsed = parseRules(sample + '\n```md\n## 99. Example\n```\n')
  assert.equal(parsed.length, 6)
  assert.equal(parsed[1].trigger, 'Git 写操作')
  assert.doesNotMatch(parsed[1].body, /适用/)
  assert.match(parsed.at(-1).body, /## 99\. Example/)
  assert.throws(() => parseRules('## 0. A\ntext\n## 0. B\ntext'), /duplicate/)
  assert.throws(() => parseRules('## 0. Empty\n'), /Empty/)
})

test('first unpromoted request has core and a short catalog, never topic bodies', async t => {
  const f = await fixture(t)
  const a = f.agent()
  const result = await f.pre(a)
  assert.equal(result.messages.length, 1)
  assert.match(textOf(result.messages), /CORE_V1/)
  assert.match(textOf(result.messages), /5\. 编码：代码修改/)
  assert.match(textOf(result.messages), /rule_load/)
  assert.doesNotMatch(textOf(result.messages), /(?:GIT|CODING|DEBUG)_BODY_V1/)
  assert.equal(meta(result.messages[0]).kind, 'core')
  assert.equal(meta(result.messages[0]).entries[0].number, 0)
  f.commit(a, result.messages)
  assert.deepEqual((await f.pre(a)).messages, [])
})

test('a prepared but uncommitted core is offered again after cancellation', async t => {
  const f = await fixture(t)
  const a = f.agent()
  assert.equal((await f.pre(a)).messages.length, 1)
  assert.equal((await f.pre(a)).messages.length, 1)
})

test('a FAILED compaction never re-injects core or drops loaded topics', async t => {
  const f = await fixture(t)
  const a = f.agent()
  f.commit(a, (await f.pre(a)).messages)
  const loaded = await f.load(a, ['5'])
  assert.match(loaded.text, /^Loaded/)
  f.commit(a, a.inbox.nextStep)
  a.inbox.clear()
  // A retry with no checkpoint leaves the transcript in place, so nothing about
  // the rule state may change. `compaction/end` fires with an `error` and no
  // `compaction/summary` on this path.
  const failed = a.session.append('compaction/end', { error: 'isContextWindowExceededError is not defined' })
  f.hooks.get('session/event')(a.session, failed)
  for (let step = 0; step < 3; step += 1) assert.deepEqual((await f.pre(a)).messages, [])
  // The topic version survived too: re-loading the same body is a no-op rather
  // than a second delivery of the identical chapter.
  assert.match((await f.load(a, ['5'])).text, /Already loaded unchanged/)
  // A real checkpoint still re-arms both, in the same session.
  f.hooks.get('session/event')(a.session, a.session.append('compaction/end', {}))
  const after = await f.pre(a)
  assert.equal(after.messages.length, 1)
  assert.match(textOf(after.messages), /CORE_V1/)
})

test('repeated requests and turns never re-inject core; only compaction does', async t => {
  const f = await fixture(t)
  const a = f.agent()
  f.commit(a, (await f.pre(a)).messages)
  // Many later steps of the same session: core stays put and the file is never
  // re-sent, which is the whole point of once-per-session injection.
  for (let step = 0; step < 5; step += 1) assert.deepEqual((await f.pre(a)).messages, [])
  const first = a.session.append('compaction/end', {})
  f.hooks.get('session/event')(a.session, first)
  const afterCompaction = await f.pre(a)
  assert.equal(afterCompaction.messages.length, 1)
  assert.match(textOf(afterCompaction.messages), /CORE_V1/)
  f.commit(a, afterCompaction.messages)
  for (let step = 0; step < 3; step += 1) assert.deepEqual((await f.pre(a)).messages, [])
  const coreCount = () => a.session.ownEvents().filter(event =>
    event.type === 'user/message' && event.data.source?.kind === 'plugin:lean-rules' && event.data.source.rules?.kind === 'core').length
  assert.equal(coreCount(), 2)
})

test('claimed core messages count as visible without a duplicate injection', async t => {
  const f = await fixture(t)
  const a = f.agent()
  const initial = await f.pre(a)
  const result = await f.pre(a, initial.messages)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].id, initial.messages[0].id)
})

test('unchanged core survives real Session restore; a fork starts independently', async t => {
  const f = await fixture(t)
  const a = f.agent()
  f.commit(a, (await f.pre(a)).messages)
  assert.equal((await f.pre(f.agent(restore(a.session)))).messages.length, 0)
  assert.equal((await f.pre(f.agent(fork(a.session)))).messages.length, 1)
})

test('a mid-session core edit never re-injects the block, and unused topics stay unloaded', async t => {
  const f = await fixture(t)
  const a = f.agent()
  f.commit(a, (await f.pre(a)).messages)
  await f.set(sample.replace('CODING_BODY_V1', 'CODING_BODY_V2'))
  assert.equal((await f.pre(a)).messages.length, 0)
  // Both edits land in one write: the core change must not re-inject the block,
  // while the coding topic still loads on demand when it is asked for.
  await f.set(sample.replace('CODING_BODY_V1', 'CODING_BODY_V2').replace('CORE_V1', 'CORE_V2'))
  assert.equal((await f.pre(a)).messages.length, 0)
  assert.match((await f.load(a, ['5'])).text, /^Loaded/)
  assert.match(textOf(a.inbox.nextStep), /CODING_BODY_V2/)
})

test('an untouched catalog is not refreshed after the session injection', async t => {
  const f = await fixture(t)
  const a = f.agent()
  f.commit(a, (await f.pre(a)).messages)
  await f.set(sample.replace('适用：代码修改', '适用：代码与接口修改'))
  assert.equal((await f.pre(a)).messages.length, 0)
})

test('topics load by title or number, and pending versions deduplicate concurrently', async t => {
  const f = await fixture(t)
  const a = f.agent()
  await Promise.all([f.load(a, ['5', '编码']), f.load(a, ['编码'])])
  assert.equal(a.inbox.nextStep.length, 1)
  assert.deepEqual(meta(a.inbox.nextStep[0]).entries.map(entry => entry.number), [5])
  assert.match(textOf(a.inbox.nextStep), /CODING_BODY_V1/)
  assert.doesNotMatch(textOf(a.inbox.nextStep), /CORE_V1|DEBUG_BODY_V1/)
  assert.match((await f.load(a, ['5'])).text, /Already loaded unchanged/)
  a.inbox.clear()
  assert.match((await f.load(a, ['5'])).text, /^Loaded/)
})

test('durable topic receipts survive restore; legacy receipts do not hide new versions', async t => {
  const f = await fixture(t)
  const a = f.agent()
  await f.load(a, ['5'])
  f.commit(a, a.inbox.nextStep)
  a.inbox.clear()
  assert.match((await f.load(f.agent(restore(a.session)), ['5'])).text, /Already loaded unchanged/)
  assert.match((await f.load(f.agent(fork(a.session)), ['5'])).text, /^Loaded/)
  const legacy = f.agent()
  legacy.session.append('user/message', { id: 'legacy', role: 'user', content: [{ type: 'text', text: 'legacy' }], source: { kind: 'plugin', plugin: 'rule-search', form: 'notice', summary: JSON.stringify({ sections: [5] }) } }, { surfaceOp: 'append' })
  assert.match((await f.load(legacy, ['5'])).text, /^Loaded/)
})

test('a pending receipt from another rule path does not suppress loading', async t => {
  const f = await fixture(t)
  const a = f.agent()
  await f.load(a, ['5'])
  const wrongPath = structuredClone(a.inbox.nextStep[0])
  const data = meta(wrongPath)
  data.path += '.other'
  wrongPath.source.rules = { ...wrongPath.source.rules, path: data.path }
  const other = f.agent(fresh(), [wrongPath])
  assert.match((await f.load(other, ['5'])).text, /^Loaded/)
  assert.equal(other.inbox.nextStep.length, 2)
})

test('loaded topics update automatically, but untouched topics remain absent', async t => {
  const f = await fixture(t)
  const a = f.agent()
  f.commit(a, (await f.pre(a)).messages)
  await f.load(a, ['5'])
  f.commit(a, a.inbox.nextStep)
  a.inbox.clear()
  await f.set(sample.replace('CODING_BODY_V1', 'CODING_BODY_V2').replace('DEBUG_BODY_V1', 'DEBUG_BODY_V2'))
  const updated = await f.pre(a)
  assert.equal(updated.messages.length, 1)
  assert.equal(meta(updated.messages[0]).kind, 'topics')
  assert.match(textOf(updated.messages), /CODING_BODY_V2/)
  assert.doesNotMatch(textOf(updated.messages), /DEBUG_BODY_V2|CORE_V1/)
  f.commit(a, updated.messages)
  assert.match((await f.load(a, ['5'])).text, /Already loaded unchanged/)
  assert.equal((await f.pre(a)).messages.length, 0)
})

test('updated claimed topic content is not appended twice', async t => {
  const f = await fixture(t)
  const a = f.agent()
  f.commit(a, (await f.pre(a)).messages)
  await f.load(a, ['5'])
  f.commit(a, a.inbox.nextStep)
  a.inbox.clear()
  await f.set(sample.replace('CODING_BODY_V1', 'CODING_BODY_V2'))
  await f.load(a, ['5'])
  const claimed = a.inbox.nextStep.splice(0)
  const result = await f.pre(a, claimed)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].id, claimed[0].id)
})

test('removed loaded topics produce a removal receipt, not stale success', async t => {
  const f = await fixture(t)
  const a = f.agent()
  f.commit(a, (await f.pre(a)).messages)
  await f.load(a, ['5'])
  f.commit(a, a.inbox.nextStep)
  a.inbox.clear()
  await f.set(sample.replace(/## 5\. 编码[\s\S]*?(?=## 6\.)/, ''))
  const result = await f.pre(a)
  assert.match(textOf(result.messages), /第 5 章已从该规则文件移除/)
  f.commit(a, result.messages)
  assert.match((await f.load(a, ['5'])).text, /No rule section matches/)
  assert.equal((await f.pre(a)).messages.length, 0)
})

test('compaction restores core and lets needed topics be loaded again', async t => {
  const f = await fixture(t)
  const a = f.agent()
  f.commit(a, (await f.pre(a)).messages)
  await f.load(a, ['5'])
  f.commit(a, a.inbox.nextStep)
  a.inbox.clear()
  const event = a.session.append('compaction/end', {})
  f.hooks.get('session/event')(a.session, event)
  const result = await f.pre(a)
  assert.match(textOf(result.messages), /CORE_V1/)
  assert.doesNotMatch(textOf(result.messages), /CODING_BODY/)
  f.commit(a, result.messages)
  assert.match((await f.load(a, ['5'])).text, /^Loaded/)
  const restored = f.agent(restore(a.session))
  assert.equal((await f.pre(restored)).messages.length, 0)
  assert.match((await f.load(restored, ['5'])).text, /^Loaded/)
})

test('an unused session needs no read; a post-compaction failure is reported once and recovery re-injects core', async t => {
  const f = await fixture(t)
  const a = f.agent()
  f.commit(a, (await f.pre(a)).messages)
  await rm(f.file)
  // Core is already injected and no topic is tracked, so nothing re-reads the
  // file and no failure is reported for a session that does not need it.
  assert.equal((await f.pre(a)).messages.length, 0)
  f.hooks.get('session/event')(a.session, a.session.append('compaction/end', {}))
  const result = await f.pre(a)
  assert.equal(meta(result.messages[0]).kind, 'error')
  f.commit(a, result.messages)
  assert.equal((await f.pre(a)).messages.length, 0)
  await f.set(sample)
  const recovered = await f.pre(a)
  assert.match(textOf(recovered.messages), /CORE_V1/)
  f.commit(a, recovered.messages)
  assert.equal((await f.pre(a)).messages.length, 0)
})

test('malformed source never claims successful core injection', async t => {
  const f = await fixture(t, '## 1. Topic\n- no core\n')
  const a = f.agent()
  assert.equal(meta((await f.pre(a)).messages[0]).kind, 'error')
  await f.set('## 0. Core\n- A\n## 0. Duplicate\n- B\n')
  assert.match((await f.tools.get('rule_search').execute({})).text, /unavailable.*duplicate/)
  await f.set(Buffer.from([0xff]))
  assert.match((await f.load(a, ['1'])).text, /failed/)
  await f.set('x'.repeat(1024 * 1024 + 1))
  assert.match((await f.tools.get('rule_search').execute({})).text, /exceeds 1 MiB/)
})

test('rejected, failed or aborted pre-steps do not append rules', async t => {
  const f = await fixture(t)
  const a = f.agent()
  const reject = { kind: 'reject', reason: 'fixture' }
  assert.equal(await f.hooks.get('agent/pre-step')({ agent: a }, async () => reject), reject)
  const failure = new Error('upstream')
  await assert.rejects(f.hooks.get('agent/pre-step')({ agent: a }, async () => { throw failure }), error => error === failure)
  assert.equal((await f.pre(a, [], { signal: AbortSignal.abort() })).messages.length, 0)
})

test('cap, unknown selectors and automatic core remain explicit', async t => {
  const f = await fixture(t)
  const a = f.agent()
  const result = await f.load(a, ['0', '1', '2', '4', '5', 'missing'])
  assert.match(result.text, /Core section 0 is loaded automatically/)
  assert.match(result.text, /Exceeds the 3-section limit, not loaded: 编码/)
  assert.match(result.text, /No rule section matches: missing/)
  assert.deepEqual(meta(a.inbox.nextStep[0]).entries.map(entry => entry.number), [1, 2, 4])
  const b = f.agent()
  await f.load(b, ['0'])
  assert.equal(b.inbox.nextStep.length, 0)
  assert.match((await f.load(b, [])).text, /requires sections/)
  assert.deepEqual(f.tools.get('rule_load').parameters.properties.sections.items, { type: 'string' })
})

test('search uses Chinese, aliases and applicability without returning topic bodies', async t => {
  const f = await fixture(t)
  for (const [query, title] of [['coding', '5 编码'], ['排障', '6 排障'], ['record', '4 会话记录'], ['Git', '1 红线']]) {
    const { text } = await f.tools.get('rule_search').execute({ query })
    assert.match(text, /^Matching rule sections/)
    assert.ok(text.includes(title))
    assert.doesNotMatch(text, /_BODY_V1/)
  }
  assert.match((await f.tools.get('rule_search').execute({ query: 'no-such-topic' })).text, /No rule sections match/)
})

test('project hints cover root through cwd and retain their task-instruction meaning', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lean-project-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cwd = join(dir, 'src')
  await mkdir(join(dir, '.git'))
  await mkdir(cwd)
  await writeFile(join(dir, 'AGENTS.md'), 'root')
  await writeFile(join(cwd, 'CLAUDE.local.md'), 'local')
  const fs = { resolve: async (file, { cwd }) => resolvePath(cwd, file), stat: async file => ({ type: (await stat(file)).isFile() ? 'file' : 'directory' }) }
  const f = await fixture(t, sample, { fs })
  const s = Session.create('project-rules', [], { version: SESSION_FORMAT_VERSION, id: 'project-rules', createdAt: Date.now(), isSeeded: false, cwd })
  const result = await f.pre(f.agent(s))
  assert.match(textOf(result.messages), /项目规则文件/)
  assert.ok(textOf(result.messages).includes(join(dir, 'AGENTS.md')))
  assert.ok(textOf(result.messages).includes(join(cwd, 'CLAUDE.local.md')))
  assert.doesNotMatch(textOf(result.messages), /not task instructions|task itself never depends/)
})

test('bootstrap filtering preserves the first-request core plugin message', async t => {
  const f = await fixture(t)
  const a = f.agent()
  const hooks = new Map()
  bootstrap({ on: (name, fn) => hooks.set(name, fn), logger: { warn() {} } }, { bootstrapTools: ['bash', 'str_replace_editor', 'rule_load', 'dev_tool_search'], suppressedContextSources: ['agent-instructions', 'skill-catalog'] })
  const coreFirst = await hooks.get('agent/pre-step')({ agent: a }, () => f.pre(a))
  assert.match(textOf(coreFirst.messages), /CORE_V1/)
  const filterFirst = await f.hooks.get('agent/pre-step')({ agent: a }, () => hooks.get('agent/pre-step')({ agent: a }, async () => ({ kind: 'enter', messages: [] })))
  assert.match(textOf(filterFirst.messages), /CORE_V1/)
})

test('the global rule file is not advertised again as a project file', async t => {
  const fs = { resolve: async (file, { cwd }) => resolvePath(cwd, file), stat: async file => ({ type: (await stat(file)).isFile() ? 'file' : 'directory' }) }
  const f = await fixture(t, sample, { fs })
  const id = 'global-is-project'
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false, cwd: f.dir })
  const result = await f.pre(f.agent(session))
  assert.match(textOf(result.messages), /CORE_V1/)
  assert.doesNotMatch(textOf(result.messages), /项目规则文件/)
})

test('production AgentLoop sends core on request one and only the selected topic on request two', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  const runtimeRequire = createRequire(resolve('@deepseek-ai/dsh-session'))
  const runtimeResolve = runtimeRequire.resolve
  const runtime = specifier => import(pathToFileURL(runtimeResolve(specifier)).href)
  const { entryListSchema } = await runtime('@deepseek-ai/cordis-plugin-include')
  // 同上：读生效配置 lean.patch.yml（cordis patch 形态），不再读已停用的
  // agent.cordis.yml。
  const rows = runtimeRequire('js-yaml').load(await readFile(new URL('../lean.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema })
  const plugins = rows.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-lean').config.plugins
  const bootstrapConfig = plugins.find(row => row.id === 'tool-bootstrap').config
  const entry = plugins.find(row => row.id === 'rule-search').name
  // The assertion that matters is that the mountable entry named by the LIVE
  // config imports and behaves; the exact filename changes whenever the ESM
  // cache has to be bypassed, so derive it from the config instead of pinning it.
  assert.match(entry, /^@local\/dsh-agent-preset-lean\/rules-hybrid-entry.*\.mjs$/)
  const configured = await import(new URL(`../${entry.replace('@local/dsh-agent-preset-lean/', '')}`, import.meta.url).href)
  assert.equal(plugins.find(row => row.id === 'instruction-hint').disabled, true)
  assert.equal(plugins.find(row => row.id === 'agent-instructions').disabled, true)
  for (const field of ['bootstrapTools', 'residentTools', 'compactionTools']) assert(bootstrapConfig[field].includes('rule_load'))
  assert(bootstrapConfig.bootstrapTools.includes('tool_gateway'))
  const { Context } = await runtime('@deepseek-ai/cordis')
  const { LlmAdapter } = await runtime('@deepseek-ai/dsh-llm')
  const { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } = await import('./runtime-helper.mjs')
  const ctx = new Context()
  const requests = []
  class CaptureAdapter extends LlmAdapter {
    async *stream(options) {
      requests.push({ messages: structuredClone(options.messages), tools: structuredClone(options.tools) })
      if (requests.length === 1) {
        const block = { type: 'tool-call', id: 'load-coding', name: 'rule_load', arguments: JSON.stringify({ sections: ['5'] }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'done' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  try {
    await mountAgentLoopTestDependencies(ctx)
    ctx.llm.registerAdapter(['hybrid-test'], new CaptureAdapter())
    const names = [...bootstrapConfig.bootstrapTools]
    const available = new Set([...names, ...bootstrapConfig.residentTools, ...bootstrapConfig.compactionTools, 'unrelated_tool'])
    available.delete('rule_load')
    for (const name of available) ctx.tools.register({
      name, description: name,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      execute: async () => ({ text: 'unused' }),
    })
    await ctx.plugin({ name: 'test-bootstrap', apply: bootstrap }, bootstrapConfig)
    await ctx.plugin({ name: 'test-hybrid-rules', inject: configured.inject, apply: configured.apply }, { rulesFile: f.file })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create('hybrid-production', { provider: 'hybrid-test', model: 'fixture' })
    const prompt = id => ({ id, role: 'user', content: [{ type: 'text', text: 'Work on this coding task.' }], source: { kind: 'plugin', plugin: 'hybrid-test', form: 'notice', summary: 'test input' } })
    agent.followup(prompt('first-input'))
    await agent.whenIdle()
    assert.equal(requests.length, 2)
    const first = textOf(requests[0].messages)
    const second = textOf(requests[1].messages)
    assert.match(first, /CORE_V1/)
    assert.doesNotMatch(first, /CODING_BODY_V1|DEBUG_BODY_V1/)
    assert.deepEqual(requests[0].tools.map(tool => tool.name).sort(), names.sort())
    assert.match(second, /CODING_BODY_V1/)
    assert.doesNotMatch(second, /DEBUG_BODY_V1/)
    assert.equal(second.split('CORE_V1').length - 1, 1)
    assert.equal(second.split('CODING_BODY_V1').length - 1, 1)
    const expectedPersona = typeof bootstrapConfig.bootstrapPersona === 'string'
      ? bootstrapConfig.bootstrapPersona
      : 'You are a helpful software engineer assistant.'
    assert.ok(requests[0].messages.some(message => message.role === 'system' && textOf([message]).includes(expectedPersona)))
    agent.followup(prompt('second-input'))
    await agent.whenIdle()
    assert.equal(requests.length, 3)
    assert.equal(textOf(requests[2].messages).split('CORE_V1').length - 1, 1)
    assert.equal(textOf(requests[2].messages).split('CODING_BODY_V1').length - 1, 1)
    const coreEvents = agent.session.ownEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'plugin:lean-rules' && meta(event.data).kind === 'core')
    assert.equal(coreEvents.length, 1)
  } finally { await ctx.fiber.dispose() }
})
