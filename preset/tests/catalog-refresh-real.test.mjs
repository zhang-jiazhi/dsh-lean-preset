import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as bootstrap } from '../tool-bootstrap.mjs'
import { catalogFor } from '../catalog-cache.mjs?release=20261028-022-exposure'
import { isGatewayEligible } from '../gateway-policy.mjs?release=20261106-fixes'
import { runtime, mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from './runtime-helper.mjs'

const { Context } = await runtime('@deepseek-ai/cordis')
const definition = name => ({
  name, description: name, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}),
})

async function fixture() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  for (const name of ['bash', 'tool_gateway']) ctx.tools.register(definition(name))
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create('catalog-refresh-agent')
  const hooks = new Map()
  let projections = 0
  const schemas = ctx.tools.schemas
  ctx.tools.schemas = function (...args) { projections += 1; return schemas.apply(this, args) }
  bootstrap({
    get: ctx.get.bind(ctx), logger: { warn() {} },
    on(name, fn) { hooks.set(name, fn); return ctx.on(name, fn) },
  }, {
    bootstrapTools: ['bash', 'tool_gateway'], residentTools: ['bash', 'tool_gateway'],
    compactionTools: ['bash', 'tool_gateway'],
    subagentResidentTools: ['bash', 'tool_gateway'], subagentCompactionTools: ['bash', 'tool_gateway'],
  })
  const sync = (scope = agent, type = 'step/end') => hooks.get('session/event')(scope.session, { type })
  sync()
  return { ctx, agent, harness, sync, hooks, projections: () => projections }
}

test('unchanged step/turn phases reuse the schema snapshot', async () => {
  const f = await fixture()
  const initial = f.projections()
  for (const type of ['step/end', 'turn/start', 'turn/end', 'agent/inbox/spliced', 'compaction/end']) f.sync(f.agent, type)
  assert.equal(f.projections(), initial, 'phase-only synchronization must not deep-copy schemas')
})

test('a late global registration refreshes the catalog before the change microtask', async () => {
  const f = await fixture()
  const late = definition('late_global')
  f.ctx.tools.register(late)
  f.sync()
  assert.equal(catalogFor(f.agent.session.id).some(tool => tool.name === late.name), true)
  assert.equal(isGatewayEligible(late, f.agent), true)
  await new Promise(resolve => setImmediate(resolve))
  const settled = f.projections()
  f.sync()
  assert.equal(f.projections(), settled)
})

test('scoped registrations, replacement and restrictions update only effective catalogs', async () => {
  const f = await fixture()
  const other = await f.harness.create('catalog-refresh-other')
  const global = definition('shadowed')
  f.ctx.tools.register(global)
  const scoped = definition('shadowed')
  f.agent.ctx.tools.register(scoped)
  f.sync()
  f.sync(other)
  assert.equal(isGatewayEligible(scoped, f.agent), true)
  assert.equal(f.ctx.tools.view(other).registrations.get(global.name).definition, global)
  const late = definition('late_scoped')
  const remove = f.agent.ctx.tools.register(late)
  f.sync()
  f.sync(other)
  assert.equal(catalogFor(f.agent.session.id).some(tool => tool.name === late.name), true)
  assert.equal(catalogFor(other.session.id).some(tool => tool.name === late.name), false)
  remove()
  const blocked = definition('blocked_global')
  f.ctx.tools.register(blocked)
  f.agent.ctx.tools.restrict({ deny: [blocked.name] })
  f.sync()
  assert.equal(catalogFor(f.agent.session.id).some(tool => tool.name === late.name || tool.name === blocked.name), false)
})

test('a burst of tools/change is coalesced into one projection per Agent', async () => {
  const f = await fixture()
  await new Promise(resolve => setImmediate(resolve))
  const before = f.projections()
  for (let i = 0; i < 16; i += 1) f.ctx.tools.register(definition(`burst_${i}`))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.projections() - before, 1)
  assert.equal(catalogFor(f.agent.session.id).filter(tool => tool.name.startsWith('burst_')).length, 16)
})
