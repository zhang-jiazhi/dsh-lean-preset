import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as gateway } from '../tool-gateway.mjs'
import { apply as skills } from '../skill-search.mjs'
import { markGatewayEligible } from '../gateway-policy.mjs?release=20261106-fixes'
import { runtime, mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from './runtime-helper.mjs'

const { Context } = await runtime('@deepseek-ai/cordis')

async function fixture() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create('gateway-admission-agent')
  gateway({ tools: ctx.tools })
  const tool = ctx.tools.view(agent).visible.get('tool_gateway')
  const call = (name, scope = agent) => tool.execute(
    { action: 'call', name, input: {} },
    { agent: scope, signal: new AbortController().signal },
  )
  return { ctx, harness, agent, tool, call }
}

function definition(execute = async () => ({ text: 'executed' })) {
  return {
    name: 'hidden_probe', description: 'admission probe',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute,
  }
}

test('an old eligibility mark cannot bypass an Agent restriction', async () => {
  const f = await fixture()
  let executed = 0
  const tool = definition(async () => { executed += 1; return { text: 'executed' } })
  f.ctx.tools.register(tool)
  markGatewayEligible(tool, undefined, f.agent)
  f.agent.ctx.tools.restrict({ deny: [tool.name] })
  assert.equal(f.ctx.tools.view(f.agent).registrations.has(tool.name), false)
  await assert.rejects(f.call(tool.name), /Unknown tool/)
  assert.equal(executed, 0)
})

test('a conditional scoped shadow never falls back to the global definition', async () => {
  const f = await fixture()
  let executed = 0
  const global = definition(async () => { executed += 1; return { text: 'global fallback' } })
  const scoped = definition()
  f.ctx.tools.register(global)
  f.agent.ctx.tools.register(scoped, { when: () => false })
  markGatewayEligible(global, undefined, f.agent)
  markGatewayEligible(scoped, () => false, f.agent)
  await assert.rejects(f.call(global.name), /conditional|when/)
  assert.equal(executed, 0)
})

test('shared definition conditions stay isolated regardless of marking order', async () => {
  for (const reverse of [false, true]) {
    const f = await fixture()
    const other = await f.harness.create('gateway-admission-other')
    const tool = definition()
    f.ctx.tools.register(tool)
    const when = () => false
    f.agent.ctx.tools.register(tool, { when })
    const marks = [[f.agent, when], [other, undefined]]
    if (reverse) marks.reverse()
    for (const [agent, condition] of marks) markGatewayEligible(tool, condition, agent)
    await assert.rejects(f.call(tool.name), /conditional|when/)
    assert.equal((await f.call(tool.name, other)).text, 'executed')
  }
})

test('admission is rechecked if pre-execute revokes the selected definition', async () => {
  const f = await fixture()
  let executed = 0
  const tool = definition(async () => { executed += 1; return { text: 'executed' } })
  f.ctx.tools.register(tool)
  markGatewayEligible(tool, undefined, f.agent)
  f.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === tool.name) f.agent.ctx.tools.restrict({ deny: [tool.name] })
    return next()
  })
  await assert.rejects(f.call(tool.name), /unknown tool|Unknown tool/)
  assert.equal(executed, 0)
})

test('undefined tool output remains a canonical native error', async () => {
  const f = await fixture()
  const tool = definition(async () => undefined)
  f.ctx.tools.register(tool)
  markGatewayEligible(tool, undefined, f.agent)
  await assert.rejects(f.call(tool.name), /invalid output/)
})

test('skill provider exceptions are native tool errors, not successful text', async () => {
  const f = await fixture()
  skills({
    on() {}, tools: f.ctx.tools,
    skills: {
      list: async () => { throw new Error('controlled list failure') },
      get: async () => { throw new Error('controlled read failure') },
    },
  })
  for (const [name, input, error] of [
    ['skill_search', { query: 'pdf' }, 'controlled list failure'],
    ['skill_load', { name: 'missing' }, 'controlled read failure'],
  ]) {
    const out = await f.ctx.tools.execute({
      calls: [{ id: name, name, arguments: JSON.stringify(input) }],
      agent: f.agent, signal: new AbortController().signal,
    })
    assert.equal(out.results[0].result.isError, true)
    assert.match(out.results[0].result.content[0].text, new RegExp(error))
  }
})
