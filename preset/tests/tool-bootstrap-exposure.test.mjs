import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as bootstrap } from '../tool-bootstrap.mjs'
import { apply as gateway } from '../tool-gateway.mjs'
import { isGatewayEligible, originalWhenFor } from '../gateway-policy.mjs?release=20261106-fixes'
import { runtime } from './runtime-helper.mjs'

const { Session, SESSION_FORMAT_VERSION } = await runtime('@deepseek-ai/dsh-session')

test('a pre-registered scoped browser tool becomes gateway-eligible but stays out of the catalog', async () => {
  const definition = {
    name: 'mcp__playwright-mcp__browser_click',
    description: 'browser click',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({}),
  }
  const registration = { definition, when: undefined }
  let gatewayTool
  const view = scope => {
    const entries = scope === undefined ? [] : [[definition.name, definition]]
    return {
      visible: new Map(entries),
      registrations: new Map(scope === undefined ? [] : [[definition.name, registration]]),
      knownNames: new Set(entries.map(([name]) => name)),
      restrictableNames: new Set(entries.map(([name]) => name)),
    }
  }
  const tools = {
    register(tool) {
      if (tool.name === 'tool_gateway') gatewayTool = tool
      return () => {}
    },
    view,
    schemas() { return [definition] },
    restrict() { return () => {} },
  }
  const id = `pre-registered-${Date.now()}`
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
    on: (name, fn) => hooks.set(name, fn),
    logger: { warn() {} },
    get: name => name === 'tools' ? tools : name === 'agents' ? { get: () => agent, list: () => [agent] } : undefined,
  }, {
    bootstrapTools: ['bash', 'tool_gateway'],
    residentTools: ['bash', 'tool_gateway'],
    compactionTools: ['bash', 'tool_gateway'],
    subagentResidentTools: ['bash', 'tool_gateway'],
    subagentCompactionTools: ['bash', 'tool_gateway'],
  })
  hooks.get('session/event')?.(session, { type: 'agent/inbox/spliced' })
  hooks.get('session/event')?.(session, { type: 'turn/end' })
  // Eligibility is per calling Agent: this registration is hidden from the
  // lean agent, so that agent's gateway may serve it.
  assert.equal(isGatewayEligible(definition, agent), true)
  assert.equal(isGatewayEligible(definition), false)
  assert.equal(originalWhenFor(definition), undefined)
  gateway({ tools })
  const listed = await gatewayTool.execute({ action: 'search', query: 'browser_click' }, { agent })
  assert.match(listed.text, /mcp__playwright-mcp__browser_click/)
})

test('late Team registration is never gateway-eligible', async () => {
  const definition = {
    name: 'spawn_teammate',
    description: 'spawn a teammate',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({}),
  }
  const registration = { definition, when: undefined }
  const tools = {
    register() { return () => {} },
    view(scope) {
      const visible = scope === undefined
        ? new Map()
        : new Map([[definition.name, definition]])
      const registrations = scope === undefined
        ? new Map()
        : new Map([[definition.name, registration]])
      return { visible, registrations, knownNames: new Set(visible.keys()), restrictableNames: new Set(visible.keys()) }
    },
    schemas() { return [definition] },
    restrict() { return () => {} },
  }
  const id = `late-team-${Date.now()}`
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
    on: (name, fn) => hooks.set(name, fn),
    logger: { warn() {} },
    get: name => name === 'tools' ? tools : name === 'agents' ? { get: () => agent, list: () => [agent] } : undefined,
  }, {
    bootstrapTools: ['bash', 'tool_gateway'],
    residentTools: ['bash', 'tool_gateway'],
    compactionTools: ['bash', 'tool_gateway'],
    subagentResidentTools: ['bash', 'tool_gateway'],
    subagentCompactionTools: ['bash', 'tool_gateway'],
  })

  hooks.get('tools/change')?.()
  assert.equal(isGatewayEligible(definition), false)

  session.append('user/message', {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '请使用 Agent Team 子代理协作' }],
  }, { surfaceOp: 'append' })
  hooks.get('session/event')?.(session, session.ownEvents().at(-1))
  assert.equal(isGatewayEligible(definition), false)
})

test('a global tool restricted away from the agent catalog is not gateway-eligible', async () => {
  const definition = {
    name: 'restricted_global',
    description: 'hidden by another plugin',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({}),
  }
  const registration = { definition, when: undefined }
  const tools = {
    register() { return () => {} },
    view(scope) {
      if (scope !== undefined) return { visible: new Map(), registrations: new Map(), knownNames: new Set(), restrictableNames: new Set() }
      return {
        visible: new Map([[definition.name, definition]]),
        registrations: new Map([[definition.name, registration]]),
        knownNames: new Set([definition.name]),
        restrictableNames: new Set([definition.name]),
      }
    },
    schemas() { return [] },
    restrict() { return () => {} },
  }
  const id = `restricted-global-${Date.now()}`
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
    on: (name, fn) => hooks.set(name, fn),
    logger: { warn() {} },
    get: name => name === 'tools' ? tools : name === 'agents' ? { get: () => agent, list: () => [agent] } : undefined,
  }, {
    bootstrapTools: ['bash', 'tool_gateway'],
    residentTools: ['bash', 'tool_gateway'],
    compactionTools: ['bash', 'tool_gateway'],
    subagentResidentTools: ['bash', 'tool_gateway'],
    subagentCompactionTools: ['bash', 'tool_gateway'],
  })
  hooks.get('session/event')?.(session, { type: 'agent/inbox/spliced' })
  assert.equal(isGatewayEligible(definition), false)
})

test('tools/change re-reads the catalog so a late global tool still gets marked', async () => {
  const bash = {
    name: 'bash', description: 'shell',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({}),
  }
  const gatewayDefinition = {
    name: 'tool_gateway', description: 'gateway',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({}),
  }
  const late = {
    name: 'mcp__late__probe', description: 'registered after the first sync',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({}),
  }
  const registrations = new Map([
    [bash.name, { definition: bash, when: undefined }],
    [gatewayDefinition.name, { definition: gatewayDefinition, when: undefined }],
  ])
  // The agent scope materialised before the late plugin registered: it never
  // lists that name, so only the refreshed catalog can admit it.
  const agentRegistrations = new Map(registrations)
  const tools = {
    register() { return () => {} },
    view(scope) {
      const source = scope === undefined ? registrations : agentRegistrations
      const visible = new Map([...source].map(([name, entry]) => [name, entry.definition]))
      return { visible, registrations: source, knownNames: new Set(visible.keys()), restrictableNames: new Set(visible.keys()) }
    },
    schemas() { return [...registrations.values()].map(entry => entry.definition) },
    restrict() { return () => {} },
  }
  const id = `late-registration-${Date.now()}`
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
    on: (name, fn) => hooks.set(name, fn),
    logger: { warn() {} },
    get: name => name === 'tools' ? tools : name === 'agents' ? { get: () => agent, list: () => [agent] } : undefined,
  }, {
    bootstrapTools: ['bash', 'tool_gateway'],
    residentTools: ['bash', 'tool_gateway'],
    compactionTools: ['bash', 'tool_gateway'],
    subagentResidentTools: ['bash', 'tool_gateway'],
    subagentCompactionTools: ['bash', 'tool_gateway'],
  })
  hooks.get('session/event')?.(session, { type: 'turn/end' })
  assert.equal(isGatewayEligible(late, agent), false, 'the first sync cannot know about the late tool')

  registrations.set(late.name, { definition: late, when: undefined })
  hooks.get('tools/change')?.()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(isGatewayEligible(late, agent), true, 'tools/change must refresh the cached catalog before re-marking')
})
