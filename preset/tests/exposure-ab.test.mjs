import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as bootstrap } from '../tool-bootstrap.mjs'
import { runtime } from './runtime-helper.mjs'

const { Session, SESSION_FORMAT_VERSION } = await runtime('@deepseek-ai/dsh-session')

const definitions = ['bash', 'tool_gateway', 'browser_click', 'spawn_teammate', 'send_message', 'read'].map(name => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] },
  execute: async () => ({}),
}))

const config = {
  bootstrapTools: ['bash', 'tool_gateway'],
  residentTools: ['bash', 'tool_gateway', 'send_message'],
  compactionTools: ['bash', 'tool_gateway', 'send_message'],
  subagentResidentTools: ['bash', 'tool_gateway'],
  subagentCompactionTools: ['bash', 'tool_gateway'],
}

class FakeTools {
  constructor(defs = definitions) {
    this.defs = defs
    this.registrations = new Map()
  }

  register(definition, options = {}) {
    this.registrations.set(definition.name, options)
    return () => this.registrations.delete(definition.name)
  }

  view(scope) {
    const visible = scope === 'empty'
      ? new Map()
      : new Map(this.defs.map(definition => [definition.name, definition]))
    const registrations = new Map([...visible].map(([name]) => [
      name,
      { definition: this.defs.find(definition => definition.name === name), when: this.registrations.get(name)?.when },
    ]))
    return { visible, registrations, knownNames: new Set(visible.keys()), restrictableNames: new Set(visible.keys()) }
  }

  schemas() {
    return this.defs
  }

  definitions(scope, toolSet) {
    return [...(toolSet === undefined ? this.view(scope).visible : toolSet.view(scope)).values()]
  }

  executable(name, scope, toolSet) {
    if (toolSet !== undefined) return toolSet.view(scope).get(name)
    return this.view(scope).visible.get(name)
  }

  restrict() {
    return () => {}
  }

  async execute({ calls, agent, toolSet }) {
    const call = calls[0]
    const definition = toolSet.view(agent).get(call.name)
    if (definition === undefined) {
      return { results: [{ callId: call.id, result: { isError: true, error: { message: `unknown tool "${call.name}"` }, content: [{ type: 'text', text: `unknown tool "${call.name}"` }] } }], additionalContexts: [], concluded: false }
    }
    return { results: [{ callId: call.id, result: { content: [{ type: 'text', text: `called ${definition.name}` }] } }], additionalContexts: [], concluded: false }
  }

  async resolve() {
    return { dispose() {}, view: () => new Map(this.defs.map(definition => [definition.name, definition])) }
  }
}

async function runScenario() {
  const tools = new FakeTools()
  const id = `exposure-resolve-${Date.now()}-${Math.random()}`
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    isSeeded: false,
    agentPreset: 'lean',
  })
  const agent = { session, ctx: { tools } }
  const hooks = new Map()
  bootstrap({
    on: (name, hook) => hooks.set(name, hook),
    logger: { warn() {} },
    get: name => name === 'tools'
      ? tools
      : name === 'agents'
        ? { get: () => agent, list: () => [agent] }
        : undefined,
  }, { ...config })

  for (const definition of definitions) tools.register(definition)

  const visible = async () => {
    const resolved = await tools.resolve({ agent, signal: new AbortController().signal })
    const names = [...resolved.view(agent).keys()].sort()
    assert.deepEqual(tools.definitions(agent, resolved).map(definition => definition.name).sort(), names)
    const blocked = await tools.execute({
      calls: [{ id: 'hidden-call', name: 'browser_click', arguments: '{}' }],
      agent,
      toolSet: resolved,
    })
    assert.equal(blocked.results[0].result.isError, true)
    assert.equal(tools.executable('browser_click', agent), undefined)
    assert.equal(tools.executable('bash', agent)?.name, 'bash')
    return names
  }

  hooks.get('session/event')?.(session, { type: 'agent/inbox/spliced' })
  const initial = await visible()

  session.append('assistant/message', {
    role: 'assistant',
    content: [{ type: 'text', text: 'ready' }],
  }, { surfaceOp: 'append' })
  hooks.get('session/event')?.(session, session.ownEvents().at(-1))
  hooks.get('session/event')?.(session, { type: 'turn/start' })
  const promoted = await visible()

  const teamPrompt = {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '请使用 Agent Team 子代理协作' }],
  }
  session.append('user/message', teamPrompt, { surfaceOp: 'append' })
  hooks.get('session/event')?.(session, { type: 'agent/inbox/spliced', data: { inserted: [teamPrompt] } })
  const team = await visible()

  return { initial, promoted, team }
}

test('resolve exposure narrows the catalog by phase and Team arming', async () => {
  const scenario = await runScenario()
  assert.deepEqual(scenario.initial, ['bash', 'tool_gateway'])
  assert.deepEqual(scenario.promoted, ['bash', 'tool_gateway'])
  assert.deepEqual(scenario.team, ['bash', 'send_message', 'spawn_teammate', 'tool_gateway'])
})

test('resolve exposure isolates two Agent policies on one ToolsService', async () => {
  const tools = new FakeTools()
  for (const definition of definitions) tools.register(definition)
  const make = (id, resident) => {
    const session = Session.create(id, [], {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: Date.now(),
      isSeeded: false,
      agentPreset: 'lean',
    })
    const agent = { session, ctx: { tools } }
    const hooks = new Map()
    bootstrap({
      on: (name, hook) => hooks.set(name, hook),
      logger: { warn() {} },
      get: name => name === 'tools'
        ? tools
        : name === 'agents'
          ? { get: () => agent, list: () => [agent] }
          : undefined,
    }, {
      ...config,
      residentTools: ['bash', 'tool_gateway', resident],
      compactionTools: ['bash', 'tool_gateway', resident],
    })
    return { session, agent, hooks }
  }
  const left = make('resolve-isolation-left', 'browser_click')
  const right = make('resolve-isolation-right', 'read')
  const visible = async agent => {
    const resolved = await tools.resolve({ agent, signal: new AbortController().signal })
    return [...resolved.view(agent).keys()].sort()
  }
  for (const side of [left, right]) side.hooks.get('session/event')?.(side.session, { type: 'agent/inbox/spliced' })
  for (const side of [left, right]) {
    side.session.append('assistant/message', { role: 'assistant', content: [{ type: 'text', text: 'ready' }] }, { surfaceOp: 'append' })
    side.hooks.get('session/event')?.(side.session, side.session.ownEvents().at(-1))
    side.hooks.get('session/event')?.(side.session, { type: 'turn/start' })
  }
  assert.deepEqual(await visible(left.agent), ['bash', 'browser_click', 'tool_gateway'])
  assert.deepEqual(await visible(right.agent), ['bash', 'read', 'tool_gateway'])
})

test('no-Agent executable fails closed except the PTC run_code transport', async () => {
  const runCode = {
    name: 'run_code',
    description: 'ptc transport',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({}),
  }
  const defs = [...definitions, runCode]
  const rootTools = new FakeTools(defs)
  const scopedTools = new FakeTools(defs)
  for (const definition of defs) rootTools.register(definition)
  const id = `resolve-no-agent-${Date.now()}`
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    isSeeded: false,
    agentPreset: 'lean',
  })
  const agent = { session, ctx: { tools: scopedTools } }
  const hooks = new Map()
  bootstrap({
    on: (name, hook) => hooks.set(name, hook),
    logger: { warn() {} },
    get: name => name === 'tools'
      ? rootTools
      : name === 'agents'
        ? { get: () => agent, list: () => [agent] }
        : undefined,
  }, { ...config })
  hooks.get('session/event')?.(session, { type: 'agent/inbox/spliced' })
  const resolved = await rootTools.resolve({ agent, signal: new AbortController().signal })
  const names = [...resolved.view(agent).keys()]
  assert.ok(names.includes('run_code'))
  assert.ok(names.includes('bash'))
  assert.ok(!names.includes('browser_click'))
  assert.equal(rootTools.executable('bash'), undefined)
  assert.equal(rootTools.executable('browser_click'), undefined)
  assert.equal(rootTools.executable('run_code')?.name, 'run_code')
  assert.equal(scopedTools.executable('bash')?.name, 'bash')
  assert.equal(scopedTools.executable('browser_click'), undefined)
  assert.equal(scopedTools.executable('run_code')?.name, 'run_code')
})

test('a Team-spawned child gets send_message but no Team management tools', async () => {
  const tools = new FakeTools()
  for (const definition of definitions) tools.register(definition)
  const parentSession = Session.create('team-parent', [], {
    version: SESSION_FORMAT_VERSION,
    id: 'team-parent',
    createdAt: Date.now(),
    isSeeded: false,
    agentPreset: 'lean',
  })
  const childSession = Session.create('team-child', [], {
    version: SESSION_FORMAT_VERSION,
    id: 'team-child',
    createdAt: Date.now(),
    isSeeded: false,
    agentPreset: 'lean',
    parentSession: parentSession.id,
    delegationDepth: 1,
    origin: 'subagent',
  })
  childSession.append('subagent/descriptor', { provider: 'spawn' })
  const parent = { session: parentSession, ctx: { tools } }
  const child = { session: childSession, ctx: { tools } }
  const agents = new Map([[parentSession.id, parent], [childSession.id, child]])
  const hooks = new Map()
  const install = (agent) => bootstrap({
    on: (name, hook) => hooks.set(`${agent.session.id}:${name}`, hook),
    logger: { warn() {} },
    get: name => name === 'tools'
      ? tools
      : name === 'agents'
        ? { get: id => agents.get(id), list: () => [...agents.values()] }
        : undefined,
  }, { ...config })
  install(parent)
  install(child)
  const teamPrompt = {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '请使用 Agent Team 子代理协作' }],
  }
  parentSession.append('user/message', teamPrompt, { surfaceOp: 'append' })
  hooks.get(`team-parent:session/event`)?.(parentSession, { type: 'agent/inbox/spliced', data: { inserted: [teamPrompt] } })
  hooks.get(`team-child:session/event`)?.(childSession, { type: 'agent/inbox/spliced' })
  const resolved = await tools.resolve({ agent: child, signal: new AbortController().signal })
  const names = [...resolved.view(child).keys()].sort()
  assert.ok(names.includes('send_message'))
  assert.ok(!names.includes('spawn_teammate'))
  assert.ok(!names.includes('team_task_create'))
})
