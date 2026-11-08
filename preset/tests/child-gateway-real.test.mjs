// Real-host regression for the child `subagent` dead end (2026-11-06).
//
// lean's child resident list drops `subagent`, but gateway eligibility used the
// UNION of the parent and child lists. `subagent` was therefore "core" and never
// marked eligible, so a child that asked the gateway for it got
// "not gateway-eligible" even though its own catalog hid it. Eligibility is now
// decided per calling Agent against that Agent's kept set.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as bootstrapPlugin from '../tool-bootstrap.mjs'
import * as gatewayPlugin from '../tool-gateway.mjs'
import { runtime, mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from './runtime-helper.mjs'

const { Context } = await runtime('@deepseek-ai/cordis')
const { LlmAdapter } = await runtime('@deepseek-ai/dsh-llm')

const definition = name => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: { schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text ?? name }] },
  execute: async () => ({ text: `called ${name}` }),
})

class Adapter extends LlmAdapter {
  constructor(callTool = false) {
    super()
    this.callTool = callTool
    this.calls = 0
  }

  async *stream() {
    this.calls += 1
    if (this.callTool && this.calls === 1) {
      const block = { type: 'tool-call', id: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'true' }) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const config = {
  bootstrapTools: ['bash', 'tool_gateway'],
  residentTools: ['bash', 'tool_gateway', 'subagent'],
  compactionTools: ['bash', 'tool_gateway', 'subagent'],
  subagentResidentTools: ['bash', 'tool_gateway'],
  subagentCompactionTools: ['bash', 'tool_gateway'],
  promoteOn: 'tool-call',
  guardWorkspaceWrites: false,
  guardSleep: false,
}

test('a real delegation child can call subagent through the gateway; the parent cannot', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  for (const name of ['bash', 'subagent']) ctx.tools.register(definition(name))
  await ctx.plugin({ name: 'child-gateway-bootstrap', inject: bootstrapPlugin.inject, apply: bootstrapPlugin.apply }, config)
  await ctx.plugin({ name: 'child-gateway-tool', inject: gatewayPlugin.inject, apply: gatewayPlugin.apply }, {})
  ctx.llm.registerAdapter(['parent-gateway-fixture'], new Adapter(true))
  ctx.llm.registerAdapter(['child-gateway-fixture'], new Adapter())
  const harness = await mountAgentLoopTestHarness(ctx)

  const prompt = id => ({ id, role: 'user', source: { kind: 'plugin', plugin: 'child-gateway-test' }, content: [{ type: 'text', text: 'start' }] })
  const parent = await harness.create('child-gateway-parent', { provider: 'parent-gateway-fixture', model: 'fixture' })
  parent.followup(prompt('parent-start'))
  await parent.whenIdle()
  const child = await harness.create('child-gateway-child', { provider: 'child-gateway-fixture', model: 'fixture' }, {
    origin: 'subagent',
    parentSession: parent.session.id,
    delegationDepth: 1,
  })
  child.followup(prompt('child-start'))
  await child.whenIdle()

  const visible = async agent => [...(await ctx.tools.resolve({ agent, signal: new AbortController().signal })).view(agent).keys()].sort()
  assert.deepEqual(await visible(child), ['bash', 'tool_gateway'], 'the child catalog hides subagent')
  assert.deepEqual(await visible(parent), ['bash', 'subagent', 'tool_gateway'], 'the parent keeps subagent resident')

  const gatewayTool = ctx.tools.view().visible.get('tool_gateway')
  assert.ok(gatewayTool)
  const call = agent => gatewayTool.execute(
    { action: 'call', name: 'subagent', input: {} },
    { agent, signal: new AbortController().signal },
  )
  const childResult = await call(child)
  assert.equal(childResult.text, 'called subagent')
  await assert.rejects(call(parent), /not gateway-eligible/)
})
