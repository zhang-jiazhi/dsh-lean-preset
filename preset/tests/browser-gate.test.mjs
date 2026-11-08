import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as bootstrap } from '../tool-bootstrap.mjs'
import { apply as gateway } from '../tool-gateway.mjs'
import { isGatewayEligible, originalWhenFor } from '../gateway-policy.mjs?release=20261106-fixes'
import { runtime } from './runtime-helper.mjs'

const { Session, SESSION_FORMAT_VERSION } = await runtime('@deepseek-ai/dsh-session')

/**
 * 2026-10-31: exposure is resolve-only. The 0.2.1 dynamic `when` gate is gone,
 * so these tests now assert the same guarantees through `tools.resolve()`:
 * a scoped tool registered for the provider never reaches the lean catalog, it
 * becomes gateway-eligible instead, non-lean Agents keep the full catalog, and
 * Team tools appear only for an Agent whose session armed Team mode.
 */

const definition = (name) => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] },
  execute: async () => ({}),
})

class FakeTools {
  constructor(defs) {
    this.defs = defs
    this.registrations = new Map()
    this.byName = new Map(defs.map(entry => [entry.name, entry]))
    this.guardHandler = undefined
  }

  guard(handler) {
    this.guardHandler = handler
    return () => { this.guardHandler = undefined }
  }

  register(tool) {
    this.registrations.set(tool.name, { definition: tool, when: undefined })
    this.byName.set(tool.name, tool)
    return () => {}
  }

  view(scope) {
    if (scope === 'empty') return { visible: new Map(), registrations: new Map(), knownNames: new Set(), restrictableNames: new Set() }
    if (scope === undefined) {
      const registrations = new Map()
      for (const [name, record] of this.registrations) registrations.set(name, record)
      return {
        visible: new Map(this.defs.map(entry => [entry.name, entry])),
        registrations,
        knownNames: new Set(this.defs.map(entry => entry.name)),
        restrictableNames: new Set(this.defs.map(entry => entry.name)),
      }
    }
    return {
      visible: new Map(this.defs.map(entry => [entry.name, entry])),
      registrations: new Map(),
      knownNames: new Set(this.defs.map(entry => entry.name)),
      restrictableNames: new Set(this.defs.map(entry => entry.name)),
    }
  }

  schemas() {
    return this.defs
  }

  async resolve() {
    return {
      dispose() {},
      view: scope => new Map(this.defs.map(entry => [entry.name, entry])),
    }
  }

  executable(name, scope, toolSet) {
    if (toolSet !== undefined) return toolSet.view(scope).get(name)
    return this.byName.get(name)
  }
}

const makeSession = (id, agentPreset = 'lean') => Session.create(id, [], {
  version: SESSION_FORMAT_VERSION,
  id,
  createdAt: Date.now(),
  isSeeded: false,
  agentPreset,
})

const harness = ({ defs, session, resident, extraConfig }) => {
  const tools = new FakeTools(defs)
  const agent = { session, ctx: { tools } }
  const hooks = new Map()
  bootstrap({
    on: (name, fn) => hooks.set(name, fn),
    logger: { warn() {} },
    get: name => name === 'tools'
      ? tools
      : name === 'agents'
        ? { get: () => agent, list: () => [agent] }
        : undefined,
  }, {
    bootstrapTools: ['bash', 'tool_gateway'],
    residentTools: resident ?? ['bash', 'tool_gateway'],
    compactionTools: resident ?? ['bash', 'tool_gateway'],
    subagentResidentTools: ['bash', 'tool_gateway'],
    subagentCompactionTools: ['bash', 'tool_gateway'],
    ...extraConfig,
  })
  return { tools, agent, hooks }
}

const sync = (hooks, session, event = { type: 'agent/inbox/spliced' }) => hooks.get('session/event')?.(session, event)
const promote = (harnessRef) => {
  const { hooks, agent } = harnessRef
  agent.session.append('assistant/message', { role: 'assistant', content: [{ type: 'text', text: 'ready' }] }, { surfaceOp: 'append' })
  hooks.get('session/event')?.(agent.session, agent.session.ownEvents().at(-1))
  hooks.get('session/event')?.(agent.session, { type: 'turn/start' })
}
const view = async ({ tools, agent }) => [...(await tools.resolve({ agent, signal: new AbortController().signal })).view(agent).keys()].sort()

test('a scoped MCP tool never reaches the lean catalog but stays gateway-reachable', async () => {
  const click = definition('mcp__playwright-mcp__browser_click')
  const f = harness({ defs: [definition('bash'), definition('tool_gateway'), click], session: makeSession('scoped-mcp') })
  f.tools.register(click)
  sync(f.hooks, f.agent.session)
  assert.deepEqual(await view(f), ['bash', 'tool_gateway'])
  assert.equal(isGatewayEligible(click, f.agent), true)
  assert.equal(originalWhenFor(click), undefined)
  let gatewayTool
  const register = f.tools.register.bind(f.tools)
  f.tools.register = (tool) => {
    if (tool.name === 'tool_gateway') gatewayTool = tool
    return register(tool)
  }
  gateway({ tools: f.tools })
  const listed = await gatewayTool.execute({ action: 'search', query: 'browser_click' }, { agent: f.agent })
  assert.match(listed.text, /mcp__playwright-mcp__browser_click/)
})

test('a delegation child reaches subagent through its own gateway', async () => {
  const subagent = definition('subagent')
  const childSession = Session.create('child-gateway', [], {
    version: SESSION_FORMAT_VERSION,
    id: 'child-gateway',
    createdAt: Date.now(),
    isSeeded: false,
    agentPreset: 'lean',
    parentSession: 'parent-gateway',
    delegationDepth: 1,
  })
  const f = harness({
    defs: [definition('bash'), definition('tool_gateway'), subagent],
    session: childSession,
    extraConfig: {
      subagentResidentTools: ['bash', 'tool_gateway'],
      subagentCompactionTools: ['bash', 'tool_gateway'],
    },
  })
  f.tools.register(subagent)
  sync(f.hooks, childSession)
  assert.deepEqual(await view(f), ['bash', 'tool_gateway'], 'the child resident list hides subagent')
  assert.equal(isGatewayEligible(subagent, f.agent), true)
  f.tools.execute = async () => ({
    results: [{ result: { content: [{ type: 'text', text: 'spawned' }] } }],
  })
  let gatewayTool
  const register = f.tools.register.bind(f.tools)
  f.tools.register = (tool) => {
    if (tool.name === 'tool_gateway') gatewayTool = tool
    return register(tool)
  }
  gateway({ tools: f.tools })
  const described = await gatewayTool.execute({ action: 'describe', name: 'subagent' }, { agent: f.agent })
  assert.match(described.text, /"name": "subagent"/)
  const called = await gatewayTool.execute(
    { action: 'call', name: 'subagent', input: {} },
    { agent: f.agent, signal: new AbortController().signal },
  )
  assert.equal(called.text, 'spawned')

  // The same registration is resident at top level, so the parent's gateway
  // must keep rejecting it (no accidental global eligibility).
  const parent = harness({
    defs: [definition('bash'), definition('tool_gateway'), subagent],
    session: makeSession('parent-gateway'),
    resident: ['bash', 'tool_gateway', 'subagent'],
  })
  parent.tools.register(subagent)
  sync(parent.hooks, parent.agent.session)
  promote(parent)
  assert.deepEqual(await view(parent), ['bash', 'subagent', 'tool_gateway'])
  assert.equal(isGatewayEligible(subagent, parent.agent), false)
})

test('a non-lean Agent is untouched by the resolve filter', async () => {
  const click = definition('mcp__playwright-mcp__browser_click')
  const f = harness({ defs: [definition('bash'), definition('tool_gateway'), click], session: makeSession('standard-agent', 'standard') })
  f.tools.register(click)
  // The plugin is not mounted for a standard Agent, so it never syncs state for
  // one; even if the patched resolve() is shared, the wrapper must leave the
  // admitted set untouched instead of narrowing it to LEAN's keep list.
  assert.deepEqual(await view(f), ['bash', 'mcp__playwright-mcp__browser_click', 'tool_gateway'])
})

test('resident core and the gateway are never gateway-eligible', async () => {
  const bash = definition('bash')
  const gw = definition('tool_gateway')
  const click = definition('mcp__playwright-mcp__browser_click')
  const f = harness({ defs: [bash, gw, click], session: makeSession('core-eligibility') })
  for (const tool of [bash, gw, click]) f.tools.register(tool)
  sync(f.hooks, f.agent.session)
  assert.equal(isGatewayEligible(bash, f.agent), false)
  assert.equal(isGatewayEligible(gw, f.agent), false)
  assert.equal(isGatewayEligible(click, f.agent), true)
})

test('Team tools appear in the resolve view only after an explicit Team intent', async () => {
  const spawn = definition('spawn_teammate')
  const send = definition('send_message')
  const f = harness({ defs: [definition('bash'), definition('tool_gateway'), spawn, send], session: makeSession('team-arm') })
  f.tools.register(spawn)
  f.tools.register(send)
  sync(f.hooks, f.agent.session)
  assert.deepEqual(await view(f), ['bash', 'tool_gateway'])

  const teamPrompt = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请使用 Agent Team 子代理协作' }] }
  f.agent.session.append('user/message', teamPrompt, { surfaceOp: 'append' })
  f.hooks.get('session/event')?.(f.agent.session, { type: 'agent/inbox/spliced', data: { inserted: [teamPrompt] } })
  f.hooks.get('session/event')?.(f.agent.session, { type: 'turn/start' })
  assert.deepEqual(await view(f), ['bash', 'send_message', 'spawn_teammate', 'tool_gateway'])
})

test('the Team Lead runtime snapshot arms Team mode from request one', async () => {
  const spawn = definition('spawn_teammate')
  const send = definition('send_message')
  const f = harness({ defs: [definition('bash'), definition('tool_gateway'), spawn, send], session: makeSession('team-lead') })
  f.tools.register(spawn)
  f.tools.register(send)

  // Exactly the shape dsh-experimental-tool-agent-team injects at session start.
  const leadSnapshot = {
    role: 'user',
    source: { kind: 'runtime-context', form: 'snapshot' },
    content: [{ type: 'text', text: 'Current runtime context.\n\nYou are the Team Lead named "lead".\nUse list_agents({}) to find your teammates.' }],
  }
  f.agent.session.append('user/message', leadSnapshot, { surfaceOp: 'append' })
  f.hooks.get('session/event')?.(f.agent.session, { type: 'agent/inbox/spliced', data: { inserted: [leadSnapshot] } })

  assert.deepEqual(await view(f), ['bash', 'send_message', 'spawn_teammate', 'tool_gateway'])
})

test('a runtime snapshot without the lead marker does not arm Team mode', async () => {
  const spawn = definition('spawn_teammate')
  const f = harness({ defs: [definition('bash'), definition('tool_gateway'), spawn], session: makeSession('runtime-plain') })
  f.tools.register(spawn)
  const snapshot = {
    role: 'user',
    source: { kind: 'runtime-context', form: 'snapshot' },
    content: [{ type: 'text', text: 'Current runtime context.\n\nCurrent working directory: /tmp.' }],
  }
  f.agent.session.append('user/message', snapshot, { surfaceOp: 'append' })
  f.hooks.get('session/event')?.(f.agent.session, { type: 'agent/inbox/spliced', data: { inserted: [snapshot] } })
  assert.deepEqual(await view(f), ['bash', 'tool_gateway'])
})

test('edit, write and bash schemas carry their hints after promotion', async () => {
  const defs = [definition('bash'), definition('tool_gateway'), definition('read'), definition('edit'), definition('write')]
  const f = harness({ defs, session: makeSession('tool-hints'), resident: ['bash', 'tool_gateway', 'read', 'edit', 'write'] })
  for (const tool of defs) f.tools.register(tool)
  sync(f.hooks, f.agent.session)
  promote(f)
  const resolved = await f.tools.resolve({ agent: f.agent, signal: new AbortController().signal })
  const view = resolved.view(f.agent)
  assert.match(view.get('edit').description, /Read the file with the `read` tool before editing/)
  assert.match(view.get('edit').description, /prefer `edit` over scripted rewrites/)
  assert.match(view.get('write').description, /Read the file before overwriting/)
  assert.match(view.get('bash').description, /`job_output` \/ `job_list` are gateway tools/)
  assert.equal(view.get('read').description, 'read')
  // Registry definitions stay untouched: the gateway catalog and other Agents
  // must keep reading the originals.
  for (const tool of defs) assert.equal(f.tools.schemas().find(entry => entry.name === tool.name).description, tool.description)
})

test('the workspace-write guard is installed per agent and blocks scripted edits', async () => {
  // guardNewFileWrites makes the fake paths count as existing files.
  const f = harness({
    defs: [definition('bash'), definition('tool_gateway')],
    session: makeSession('write-guard'),
    extraConfig: { guardNewFileWrites: true },
  })
  sync(f.hooks, f.agent.session)
  assert.equal(typeof f.tools.guardHandler, 'function')
  const exec = (command) => f.tools.guardHandler({
    name: 'bash',
    arguments: { command },
    agent: { session: { header: { cwd: '/Users/dev/project' } } },
  })
  assert.equal(exec('ls -la'), undefined)
  assert.match(exec('python3 - <<PY\nopen("src/x.ts", "w").write(s)\nPY'), /lean guard/)
  // Backgrounding does not exempt a workspace write, only the sleep rule.
  assert.match(f.tools.guardHandler({
    name: 'bash',
    arguments: { command: 'python3 - <<PY\nopen("src/x.ts", "w").write(s)\nPY', run_in_background: true },
    agent: { session: { header: { cwd: '/Users/dev/project' } } },
  }), /lean guard/)
  // Middle state: shell writes pass.
  assert.equal(exec('sed -i "s/a/b/" src/x.ts'), undefined)
  assert.equal(exec("cat > src/x.ts <<'EOF'\nx\nEOF"), undefined)
  assert.equal(f.tools.guardHandler({ name: 'read', arguments: {}, agent: {} }), undefined)
})

test('guardWorkspaceWrites: false keeps only the sleep rule', async () => {
  const f = harness({
    defs: [definition('bash'), definition('tool_gateway')],
    session: makeSession('write-guard-off'),
    extraConfig: { guardWorkspaceWrites: false, guardNewFileWrites: true },
  })
  sync(f.hooks, f.agent.session)
  assert.equal(f.tools.guardHandler({ name: 'bash', arguments: { command: 'python3 - <<PY\nopen("src/x.ts", "w").write(s)\nPY' }, agent: {} }), undefined)
  assert.match(f.tools.guardHandler({ name: 'bash', arguments: { command: 'sleep 30' }, agent: {} }), /不要用 `sleep` 等/)
})

test('guardShellWrites: true restores the strict shell rules', async () => {
  const f = harness({
    defs: [definition('bash'), definition('tool_gateway')],
    session: makeSession('shell-writes'),
    extraConfig: { guardShellWrites: true, guardNewFileWrites: true },
  })
  sync(f.hooks, f.agent.session)
  const exec = (command) => f.tools.guardHandler({
    name: 'bash',
    arguments: { command },
    agent: { session: { header: { cwd: '/Users/dev/project' } } },
  })
  assert.match(exec('sed -i "s/a/b/" src/x.ts'), /lean guard/)
  assert.match(exec("cat > src/x.ts <<'EOF'\nx\nEOF"), /lean guard/)
  assert.equal(exec('sed -i "s/a/b/" /tmp/x.ts'), undefined)
})

test('guardSleep: false keeps only the workspace-write rule', async () => {
  const f = harness({
    defs: [definition('bash'), definition('tool_gateway')],
    session: makeSession('sleep-guard-off'),
    extraConfig: { guardSleep: false, guardNewFileWrites: true },
  })
  sync(f.hooks, f.agent.session)
  assert.equal(f.tools.guardHandler({ name: 'bash', arguments: { command: 'sleep 30' }, agent: {} }), undefined)
  assert.match(
    f.tools.guardHandler({
      name: 'bash',
      arguments: { command: 'python3 - <<PY\nopen("src/x.ts", "w").write(s)\nPY' },
      agent: { session: { header: { cwd: '/Users/dev/project' } } },
    }),
    /lean guard/,
  )
})

test('the guard denies long sleeps and honours guardSleep: false', async () => {
  const f = harness({ defs: [definition('bash'), definition('tool_gateway')], session: makeSession('sleep-guard') })
  sync(f.hooks, f.agent.session)
  const sleep = f.tools.guardHandler({ name: 'bash', arguments: { command: 'sleep 30' }, agent: {} })
  assert.match(sleep, /不要用 `sleep` 等/)
  // A background job does not hold the step: the same command is fine.
  assert.equal(f.tools.guardHandler({
    name: 'bash',
    arguments: { command: 'sleep 30', run_in_background: true },
    agent: {},
  }), undefined)
  // Short pacing sleeps stay allowed.
  assert.equal(f.tools.guardHandler({ name: 'bash', arguments: { command: 'sleep 2' }, agent: {} }), undefined)
  const off = harness({
    defs: [definition('bash'), definition('tool_gateway')],
    session: makeSession('sleep-guard-off2'),
    extraConfig: { guardSleep: false },
  })
  sync(off.hooks, off.agent.session)
  assert.equal(off.tools.guardHandler({ name: 'bash', arguments: { command: 'sleep 30' }, agent: {} }), undefined)
})
