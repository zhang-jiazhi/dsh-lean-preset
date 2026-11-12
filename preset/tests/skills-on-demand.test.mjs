import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { apply } from '../skill-search.mjs'
import { runtimeRequire } from './runtime-helper.mjs'

const resolve = runtimeRequire.resolve
const runtimeResolve = createRequire(resolve('@deepseek-ai/dsh-session')).resolve
const { Session, SESSION_FORMAT_VERSION } = await import(pathToFileURL(resolve('@deepseek-ai/dsh-session')).href)
const { createInboxStub } = await import('./runtime-helper.mjs')
let nextId = 0
const fresh = () => Session.create(`skill-demand-${++nextId}`)
const restored = s => Session.fromRestore(s.id, structuredClone(s.snapshotEvents()), structuredClone(s.header), s.inheritedEventCount, 'detached')
const fork = parent => {
  const seed = parent.snapshotEvents()
  const id = `skill-fork-${++nextId}`
  return Session.create(id, seed, { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: true, origin: 'subagent', parentSession: parent.id }, seed.length)
}

function fixture() {
  const definitions = new Map([
    ['brainstorming', { name: 'brainstorming', description: '澄清影响交付的关键未知', content: '# Clarify\nCORE_SKILL_V1' }],
    ['browser-shot', { name: 'browser-shot', description: '浏览器截图', content: 'BROWSER_BODY' }],
    ['browser-nav', { name: 'browser-nav', description: '浏览器导航', content: 'NAV_BODY' }],
  ])
  const tools = new Map()
  const hooks = new Map()
  const calls = []
  const ctx = {
    on: (name, hook) => hooks.set(name, hook),
    tools: { register: tool => tools.set(tool.name, tool) },
    skills: {
      list: async options => { calls.push(['list', options]); return [...definitions.values()] },
      get: async (name, options) => { calls.push(['get', options]); return definitions.get(name) },
    },
  }
  apply(ctx)
  const agent = (session = fresh()) => {
    const inbox = createInboxStub()
    return { session, inbox, inject: message => inbox.append('next-step', message) }
  }
  const load = (a, name = 'brainstorming') => tools.get('skill_load').execute({ name }, { agent: a })
  const commit = a => {
    for (const message of [...a.inbox.nextStep]) {
      const event = a.session.append('user/message', message, { surfaceOp: 'append' })
      hooks.get('session/event')(a.session, event)
    }
    a.inbox.clear()
  }
  return { definitions, tools, hooks, calls, ctx, agent, load, commit }
}

test('skill discovery preserves AND matching and Chinese/English aliases without loading bodies', async () => {
  const f = fixture()
  const a = f.agent()
  for (const query of ['澄清', 'clarify', 'clarification', 'brainstorming']) {
    const result = await f.tools.get('skill_search').execute({ query }, { agent: a })
    assert.match(result.text, /- brainstorming:/)
    assert.doesNotMatch(result.text, /CORE_SKILL_V1/)
  }
  const result = await f.tools.get('skill_search').execute({ query: '浏览器截图' }, { agent: a })
  assert.match(result.text, /browser-shot/)
  assert.doesNotMatch(result.text, /browser-nav/)
  assert.equal(f.calls.filter(([method]) => method === 'get').length, 0)
  assert.equal(a.inbox.nextStep.length, 0)
  assert(f.calls.every(([, options]) => options.scope === a))
})

test('tool descriptions do not require discovery or loading for every ordinary task', () => {
  const f = fixture()
  assert.doesNotMatch(f.tools.get('skill_search').description, /FIRST|if a task looks like it matches/)
  assert.match(f.tools.get('skill_search').description, /Ordinary work with sufficient context needs no skill lookup/)
  assert.match(f.tools.get('skill_load').description, /not an approval or task-completion checkpoint/)
  assert.deepEqual(f.tools.get('skill_load').parameters.required, ['name'])
})

test('first load keeps the audited skill source and repeated pending text is reused', async () => {
  const f = fixture()
  const a = f.agent()
  assert.match((await f.load(a)).text, /loaded; use the applicable workflow/)
  assert.equal(a.inbox.nextStep.length, 1)
  assert.deepEqual(a.inbox.nextStep[0].source, { kind: 'skill-invocation', name: 'brainstorming', form: 'instructions' })
  assert.match(a.inbox.nextStep[0].content[0].text, /CORE_SKILL_V1/)
  assert.match((await f.load(a)).text, /already loaded unchanged/)
  assert.equal(a.inbox.nextStep.length, 1)
})

test('concurrent same-skill loads create only one pending instruction', async () => {
  const f = fixture()
  const a = f.agent()
  await Promise.all([f.load(a), f.load(a), f.load(a)])
  assert.equal(a.inbox.nextStep.length, 1)
})

test('cancellation releases a pending version and reload uses a distinct message id', async () => {
  const f = fixture()
  const a = f.agent()
  await f.load(a)
  const firstId = a.inbox.nextStep[0].id
  a.inbox.clear()
  assert.match((await f.load(a)).text, /loaded; use/)
  assert.notEqual(a.inbox.nextStep[0].id, firstId)
})

test('changed pending content replaces the stale item rather than queuing both versions', async () => {
  const f = fixture()
  const a = f.agent()
  await f.load(a)
  f.definitions.get('brainstorming').content = 'CORE_SKILL_V2'
  await f.load(a)
  assert.equal(a.inbox.nextStep.length, 1)
  assert.match(a.inbox.nextStep[0].content[0].text, /CORE_SKILL_V2/)
  assert.doesNotMatch(a.inbox.nextStep[0].content[0].text, /CORE_SKILL_V1/)
})

test('delivered text is reused; changed content is loaded as the new version', async () => {
  const f = fixture()
  const a = f.agent()
  await f.load(a)
  f.commit(a)
  assert.match((await f.load(a)).text, /already loaded unchanged/)
  assert.equal(a.inbox.nextStep.length, 0)
  f.definitions.get('brainstorming').content = 'CORE_SKILL_V2'
  assert.match((await f.load(a)).text, /loaded; use/)
  assert.match(a.inbox.nextStep[0].content[0].text, /CORE_SKILL_V2/)
})

test('changed resource origin reloads even when the instruction body is identical', async () => {
  const f = fixture()
  const a = f.agent()
  const definition = f.definitions.get('brainstorming')
  definition.path = '/fixture/one/SKILL.md'
  definition.resourceBase = { kind: 'directory', path: '/fixture/one' }
  await f.load(a)
  f.commit(a)
  definition.path = '/fixture/two/SKILL.md'
  definition.resourceBase = { kind: 'directory', path: '/fixture/two' }
  assert.match((await f.load(a)).text, /loaded; use/)
  assert.match(a.inbox.nextStep[0].content[0].text, /fixture\/two/)
  assert.doesNotMatch(a.inbox.nextStep[0].content[0].text, /fixture\/one/)
})

test('real Session restore reuses a delivered version and fork starts independently', async () => {
  const f = fixture()
  const a = f.agent()
  await f.load(a)
  f.commit(a)
  assert.match((await f.load(f.agent(restored(a.session)))).text, /already loaded unchanged/)
  assert.match((await f.load(f.agent(fork(a.session)))).text, /loaded; use/)
})

test('pending instructions remain deduplicated after Session restore', async () => {
  const f = fixture()
  const a = f.agent()
  await f.load(a)
  const b = f.agent(restored(a.session))
  b.inbox.append('next-step', structuredClone(a.inbox.nextStep[0]))
  assert.match((await f.load(b)).text, /already loaded unchanged/)
  assert.equal(b.inbox.nextStep.length, 1)
})

test('a FAILED compaction keeps a loaded skill; a real one allows a reload', async () => {
  const f = fixture()
  const a = f.agent()
  await f.load(a)
  f.commit(a)
  // No checkpoint was written, so the body is still in the transcript and a
  // second identical delivery would only burn context.
  f.hooks.get('session/event')(a.session, a.session.append('compaction/end', { error: 'isContextWindowExceededError is not defined' }))
  assert.match((await f.load(a)).text, /already loaded unchanged/)
  // A real checkpoint does drop the body, so reloading stays correct there.
  f.hooks.get('session/event')(a.session, a.session.append('compaction/end', {}))
  assert.match((await f.load(a)).text, /loaded; use/)
})

test('compaction allows needed skill instructions to be loaded again', async () => {
  const f = fixture()
  const a = f.agent()
  await f.load(a)
  f.commit(a)
  f.hooks.get('session/event')(a.session, a.session.append('compaction/end', {}))
  assert.match((await f.load(a)).text, /loaded; use/)
  assert.match((await f.load(f.agent(restored(a.session)))).text, /loaded; use/)
})

test('missing or empty skills and provider failures never claim a successful load', async () => {
  const f = fixture()
  const a = f.agent()
  assert.match((await f.load(a, 'not-installed')).text, /No skill named/)
  f.definitions.get('brainstorming').content = ''
  assert.match((await f.load(a)).text, /no loadable body/)
  f.ctx.skills.get = async () => { throw new Error('provider unavailable') }
  await assert.rejects(f.load(a), /provider unavailable/)
  assert.equal(a.inbox.nextStep.length, 0)
})

test('legacy unwrapped receipts refresh once and do not suppress updated instructions', async () => {
  const f = fixture()
  const a = f.agent()
  a.session.append('user/message', { id: 'legacy-skill', role: 'user', content: [{ type: 'text', text: '# Clarify\nCORE_SKILL_V1' }], source: { kind: 'skill-invocation', name: 'brainstorming', form: 'instructions' } }, { surfaceOp: 'append' })
  assert.match((await f.load(a)).text, /loaded; use/)
  f.commit(a)
  assert.match((await f.load(a)).text, /already loaded unchanged/)
})

test('production loop discovers a skill, loads it once and receives its changed version', { timeout: 10000 }, async t => {
  const runtime = name => import(pathToFileURL(runtimeResolve(name)).href)
  const runtimeRequire = createRequire(resolve('@deepseek-ai/dsh-session'))
  const { Context } = await runtime('@deepseek-ai/cordis')
  const { LlmAdapter } = await runtime('@deepseek-ai/dsh-llm')
  const { default: SkillRegistry } = await runtime('@deepseek-ai/dsh-skill')
  const { entryListSchema } = await runtime('@deepseek-ai/cordis-plugin-include')
  const { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } = await import('./runtime-helper.mjs')
  const { apply: bootstrap } = await import('../tool-bootstrap.mjs')
  const { apply: discovery } = await import('../dev-tool-search.mjs')
  const corePlugin = await import('../rules-hybrid-entry.mjs')
  // 读**生效**的配置（lean.patch.yml），而不是目录里那份 0.1.7 已不再加载的
  // agent.cordis.yml —— 否则测试验的是一份死配置，通过与否都不反映实际装配。
  // lean.patch.yml 是 cordis patch：顶层是 `- insert:`，预设本体在
  // preset-lean 的 config.plugins 里。
  const rows = runtimeRequire('js-yaml').load(await readFile(new URL('../lean.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema })
  const plugins = rows.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-lean').config.plugins
  const entry = plugins.find(row => row.id === 'skill-search').name
  // Same as the rule-search mount: the live config decides which entry is
  // loaded, and that filename is versioned to bypass the ESM cache.
  assert.match(entry, /^@local\/dsh-agent-preset-lean\/skills-on-demand-entry.*\.mjs$/)
  const skillPlugin = await import(new URL(`../${entry.replace('@local/dsh-agent-preset-lean/', '')}`, import.meta.url).href)
  const config = plugins.find(row => row.id === 'tool-bootstrap').config
  const dir = await mkdtemp(join(tmpdir(), 'skill-loop-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const rulesFile = join(dir, 'AGENTS.md')
  await writeFile(rulesFile, '# Rules\n\n## 0. Core\n\n- AUTO_CORE_SENTINEL\n\n## 5. Coding\n\n> 适用：代码修改\n\n- UNLOADED_TOPIC_BODY\n')
  const ctx = new Context()
  const requests = []
  class Adapter extends LlmAdapter {
    async *stream(options) {
      requests.push({ messages: structuredClone(options.messages), tools: structuredClone(options.tools) })
      const n = requests.length
      const name = n === 1 ? 'dev_tool_search' : [2, 3, 5].includes(n) ? 'skill_load' : null
      if (name) {
        const argumentsText = JSON.stringify(n === 1 ? { toolNames: ['skill_load'] } : { name: 'helper-skill' })
        const block = { type: 'tool-call', id: `call-${n}`, name, arguments: argumentsText }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: argumentsText }
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
  const textOf = request => request.messages.flatMap(message => typeof message.content === 'string' ? [{ text: message.content }] : (message.content ?? [])).map(block => block.text ?? '').join('\n')
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SkillRegistry)
    ctx.llm.registerAdapter(['skill-test'], new Adapter())
    const registerSkill = content => ctx.skills.register({ name: 'helper-skill', description: 'A narrowly scoped helper', content, source: 'runtime' })
    const remove = registerSkill('SKILL_BODY_V1')
    const dummyNames = new Set([...config.bootstrapTools, ...config.residentTools, ...config.compactionTools, 'unrelated-tool'])
    for (const name of ['rule_load', 'dev_tool_search', 'skill_load', 'skill_search']) dummyNames.delete(name)
    for (const name of dummyNames) ctx.tools.register({ name, description: name, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_args, value) => [{ type: 'text', text: value.text }] }, execute: async () => ({ text: 'unused' }) })
    await ctx.plugin({ name: 'test-bootstrap', apply: bootstrap }, config)
    await ctx.plugin({ name: 'test-core', inject: corePlugin.inject, apply: corePlugin.apply }, { rulesFile })
    await ctx.plugin({ name: 'test-skills', inject: skillPlugin.inject, apply: skillPlugin.apply })
    await ctx.plugin({ name: 'test-discovery', inject: ['tools'], apply: discovery })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create('skill-loop-production', { provider: 'skill-test', model: 'fixture' })
    const prompt = id => ({ id, role: 'user', content: [{ type: 'text', text: 'Use the helper when needed.' }], source: { kind: 'plugin', plugin: 'skill-test', form: 'notice', summary: 'input' } })
    agent.followup(prompt('first'))
    await agent.whenIdle()
    assert.equal(requests.length, 4)
    assert.match(textOf(requests[0]), /AUTO_CORE_SENTINEL/)
    assert.doesNotMatch(textOf(requests[0]), /SKILL_BODY|UNLOADED_TOPIC_BODY/)
    assert(!requests[0].tools.some(tool => tool.name === 'skill_load'))
    assert(requests[1].tools.some(tool => tool.name === 'skill_load'))
    assert.doesNotMatch(textOf(requests[1]), /SKILL_BODY/)
    assert.equal(textOf(requests[2]).split('SKILL_BODY_V1').length - 1, 1)
    assert.equal(textOf(requests[3]).split('SKILL_BODY_V1').length - 1, 1)
    remove()
    registerSkill('SKILL_BODY_V2')
    agent.followup(prompt('updated'))
    await agent.whenIdle()
    assert.equal(requests.length, 6)
    assert.equal(textOf(requests[5]).split('SKILL_BODY_V2').length - 1, 1)
    assert.equal(textOf(requests[5]).split('AUTO_CORE_SENTINEL').length - 1, 1)
    const receipts = agent.session.ownEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'skill-invocation')
    assert.equal(receipts.length, 2)
  } finally { await ctx.fiber.dispose() }
})
