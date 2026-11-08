// Hot-update regression: lean.patch.yml imports the implementation through a
// release URL so a source edit reaches the next assembly without a host
// restart. That creates a second module instance. Before the fix, the wrapper
// installed by the first generation closed over a module-private WeakMap, so
// the new generation's Agents had no state for it and `tools.resolve()` threw
// "LEAN resolve exposure state is unavailable for this Agent".
//
// The fix shares the state table through a Symbol.for registry and lets the
// newer generation atomically replace the older wrapper.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runtime, mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from './runtime-helper.mjs'

const { Context } = await runtime('@deepseek-ai/cordis')
const { LlmAdapter } = await runtime('@deepseek-ai/dsh-llm')
const { Session, SESSION_FORMAT_VERSION } = await runtime('@deepseek-ai/dsh-session')

const INSTALL_KEY = Symbol.for('@local/dsh-agent-preset-lean/resolve-install')
const LEGACY_FILTER_KEY = Symbol.for('@local/dsh-agent-preset-lean/resolve-filter')

const definitions = ['bash', 'tool_gateway', 'read', 'browser_click'].map(name => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] },
  execute: async () => ({}),
}))

class FakeTools {
  constructor(tools) {
    this.defs = tools
    this.byName = new Map(tools.map(definition => [definition.name, definition]))
  }

  view(scope) {
    const visible = new Map(this.defs.map(definition => [definition.name, definition]))
    return {
      visible,
      registrations: new Map([...visible].map(([name, definition]) => [name, { definition, when: undefined }])),
      knownNames: new Set(visible.keys()),
      restrictableNames: new Set(visible.keys()),
    }
  }

  schemas() {
    return this.defs
  }

  async resolve() {
    return {
      dispose() {},
      view: scope => new Map(this.defs.map(definition => [definition.name, definition])),
    }
  }

  executable(name, scope, toolSet) {
    return toolSet === undefined ? this.byName.get(name) : toolSet.view(scope).get(name)
  }

  register() {
    return () => {}
  }

  restrict() {
    return () => {}
  }
}

const makeSession = id => Session.create(id, [], {
  version: SESSION_FORMAT_VERSION,
  id,
  createdAt: Date.now(),
  isSeeded: false,
  agentPreset: 'lean',
})

const makeContext = (tools, agents, hooks) => ({
  on: (name, hook) => hooks.set(name, hook),
  logger: { warn() {} },
  get: name => name === 'tools'
    ? tools
    : name === 'agents'
      ? { get: id => agents.get(id), list: () => [...agents.values()] }
      : undefined,
})

const config = {
  bootstrapTools: ['bash', 'tool_gateway'],
  residentTools: ['bash', 'tool_gateway'],
  compactionTools: ['bash', 'tool_gateway'],
  subagentResidentTools: ['bash', 'tool_gateway'],
  subagentCompactionTools: ['bash', 'tool_gateway'],
}

test('a new ?release= generation replaces the wrapper and shares resolve state', async () => {
  const tools = new FakeTools(definitions)
  const sessionA = makeSession('hot-reload-a')
  const sessionB = makeSession('hot-reload-b')
  const agentA = { session: sessionA, ctx: { tools } }
  const agentB = { session: sessionB, ctx: { tools } }
  const agents = new Map([[sessionA.id, agentA], [sessionB.id, agentB]])

  const hooksA = new Map()
  const generationA = await import('../tool-bootstrap.mjs?release=hot-reload-generation-a')
  generationA.apply(makeContext(tools, agents, hooksA), config)
  hooksA.get('session/event')(sessionA, { type: 'agent/inbox/spliced' })
  const recordA = tools[INSTALL_KEY]
  assert.ok(recordA, 'the first generation installs a wrapper record')

  const hooksB = new Map()
  const generationB = await import('../tool-bootstrap.mjs?release=hot-reload-generation-b')
  generationB.apply(makeContext(tools, agents, hooksB), config)
  hooksB.get('session/event')(sessionB, { type: 'agent/inbox/spliced' })
  const recordB = tools[INSTALL_KEY]
  assert.ok(recordB)
  assert.ok(recordB.generation > recordA.generation, 'the newer generation owns the wrapper')

  const namesOf = async agent => [...(await tools.resolve({ agent })).view(agent).keys()].sort()
  // Neither Agent may throw: A's state was written by generation A, B's by
  // generation B, and the wrapper installed by B reads the shared table.
  assert.deepEqual(await namesOf(agentA), ['bash', 'tool_gateway'])
  assert.deepEqual(await namesOf(agentB), ['bash', 'tool_gateway'])
})

class Adapter extends LlmAdapter {
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('a pre-20261106 prototype wrapper is detected and demands a real restart', async () => {
  class LegacyTools {
    async resolve() {
      throw new Error('LEAN resolve exposure state is unavailable for this Agent')
    }
    executable() { return undefined }
    view() { return { visible: new Map(), registrations: new Map(), knownNames: new Set(), restrictableNames: new Set() } }
    schemas() { return [] }
  }
  Object.defineProperty(LegacyTools.prototype, LEGACY_FILTER_KEY, { value: true, configurable: true })
  const tools = new LegacyTools()
  const warnings = []
  const infos = []
  const generation = await import('../tool-bootstrap.mjs?release=hot-reload-legacy-prototype')
  generation.apply({
    on: () => {},
    logger: { warn: message => warnings.push(message), info: message => infos.push(message) },
    get: name => (name === 'tools' ? tools : undefined),
  }, config)
  assert.ok(warnings.some(message => /pre-20261106 resolve wrapper/.test(message)), 'the legacy wrapper must be reported')
  assert.ok(warnings.some(message => /RESTART the host/.test(message)), 'the only safe migration is a restart')
  assert.equal(tools[INSTALL_KEY], undefined, 'the new generation must not wrap a closure it cannot read')
  assert.ok(infos.some(message => /release 20261106-fixes active/.test(message)), 'the mounted release must be visible')
})

test('a legacy instance wrapper over a reachable prototype method is detached', async () => {
  const tools = new FakeTools(definitions)
  // The old implementation used Object.defineProperty without `configurable`,
  // so the marker itself cannot be deleted after detaching the wrapper.
  Object.defineProperty(tools, LEGACY_FILTER_KEY, { value: true, configurable: false })
  tools.resolve = async () => { throw new Error('legacy wrapper must not run') }
  const session = makeSession('hot-reload-legacy-instance')
  const agent = { session, ctx: { tools } }
  const agents = new Map([[session.id, agent]])
  const hooks = new Map()
  const warnings = []
  const generation = await import('../tool-bootstrap.mjs?release=hot-reload-legacy-instance')
  generation.apply({
    ...makeContext(tools, agents, hooks),
    logger: { warn: message => warnings.push(message), info: () => {} },
  }, config)
  hooks.get('session/event')(session, { type: 'agent/inbox/spliced' })
  assert.ok(tools[INSTALL_KEY], 'the recovered method is wrapped by the new generation')
  assert.ok(warnings.some(message => /detached a recoverable pre-20261106 resolve wrapper/.test(message)))
  const names = [...(await tools.resolve({ agent })).view(agent).keys()].sort()
  assert.deepEqual(names, ['bash', 'tool_gateway'])
})

test('the real ToolsService serves an Agent created before and after the new generation', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  for (const definition of definitions) ctx.tools.register(definition)

  const generationA = await import('../tool-bootstrap.mjs?release=real-hot-reload-a')
  await ctx.plugin({ name: 'real-hot-reload-a', apply: generationA.apply }, config)
  ctx.llm.registerAdapter(['hot-reload-fixture'], new Adapter())
  const harness = await mountAgentLoopTestHarness(ctx)
  const prompt = id => ({ id, role: 'user', source: { kind: 'plugin', plugin: 'hot-reload-test' }, content: [{ type: 'text', text: 'start' }] })
  const first = await harness.create('real-hot-reload-first', { provider: 'hot-reload-fixture', model: 'fixture' })
  first.followup(prompt('first-start'))
  await first.whenIdle()

  const generationB = await import('../tool-bootstrap.mjs?release=real-hot-reload-b')
  await ctx.plugin({ name: 'real-hot-reload-b', apply: generationB.apply }, config)
  const second = await harness.create('real-hot-reload-second', { provider: 'hot-reload-fixture', model: 'fixture' })
  second.followup(prompt('second-start'))
  await second.whenIdle()

  const visible = async agent => [...(await ctx.tools.resolve({ agent, signal: new AbortController().signal })).view(agent).keys()].sort()
  // The wrapper installed by generation B must find the state written for the
  // first Agent (generation A) and the second (generation B); the old failure
  // was "LEAN resolve exposure state is unavailable for this Agent".
  assert.deepEqual(await visible(first), ['bash', 'tool_gateway'])
  assert.deepEqual(await visible(second), ['bash', 'tool_gateway'])
})
