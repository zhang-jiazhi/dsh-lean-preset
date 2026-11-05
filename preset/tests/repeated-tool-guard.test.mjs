import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, callSignature, DEFAULT_EXCLUDED_TOOLS, HARD_LIMIT } from '../repeated-tool-guard.mjs'
import { runtime, mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from './runtime-helper.mjs'

function fixture(config = {}) {
  const hooks = new Map()
  apply({ on: (name, hook) => hooks.set(name, hook) }, config)
  const sessions = []
  const session = () => {
    const value = { id: `repeat-${sessions.length + 1}`, isOwnSeq: seq => seq >= 0 }
    sessions.push(value)
    return value
  }
  const call = (s, name, args, seq = 0) => hooks.get('session/event')(s, { type: 'tool/call', seq, data: { turn: 1, step: 1, callId: `call-${seq}`, name, arguments: args } })
  const commit = (s, id) => hooks.get('session/event')(s, { type: 'user/message', seq: 0, data: { id } })
  const step = async s => hooks.get('agent/pre-step')({ agent: { session: s } }, async () => ({ kind: 'enter', messages: [{ id: 'existing', role: 'user', content: [] }] }))
  return { hooks, session, call, commit, step }
}

const ARGS = JSON.stringify({ command: 'rg -n secret /tmp/x' })

test('warns once on the third identical call, not on the fourth', async () => {
  const f = fixture(), s = f.session()
  f.call(s, 'bash', ARGS)
  f.call(s, 'bash', ARGS)
  assert.equal((await f.step(s)).messages.length, 1)
  f.call(s, 'bash', ARGS)
  const decision = await f.step(s)
  assert.equal(decision.messages.length, 2)
  const reminder = decision.messages.at(-1)
  assert.match(reminder.content[0].text, /called `bash` 3 times/)
  assert.doesNotMatch(reminder.content[0].text, /secret|rg -n/)
  assert.equal(reminder.source.kind, 'plugin:lean-repeated-tool-guard')
  assert.equal(decision.kind, 'enter')
  // Uncommitted, the same single reminder stays available - never a second copy.
  assert.equal((await f.step(s)).messages.at(-1).id, reminder.id)
  f.commit(s, reminder.id)
  f.call(s, 'bash', ARGS)
  assert.equal((await f.step(s)).messages.length, 1)
})

test('a different call, a different argument or a different session breaks the run', async () => {
  const f = fixture(), s = f.session()
  for (const args of [ARGS, ARGS]) f.call(s, 'bash', args)
  f.call(s, 'read', ARGS)
  assert.equal((await f.step(s)).messages.length, 1)
  f.call(s, 'read', ARGS)
  assert.equal((await f.step(s)).messages.length, 1)
  const other = f.session()
  for (let n = 0; n < 3; n++) f.call(other, 'read', ARGS)
  assert.equal((await f.step(other)).messages.length, 2)
  assert.equal((await f.step(s)).messages.length, 1)
})

test('key order and nested values are compared canonically', () => {
  assert.equal(callSignature('bash', '{"a":1,"b":{"y":2,"x":3}}'), callSignature('bash', '{"b":{"x":3,"y":2},"a":1}'))
  assert.notEqual(callSignature('bash', '{"a":1}'), callSignature('bash', '{"a":2}'))
  assert.notEqual(callSignature('bash', '{"a":1}'), callSignature('read', '{"a":1}'))
  assert.notEqual(callSignature('bash', 'not json'), callSignature('bash', '{}'))
  assert.match(callSignature('bash', 'not json'), /unparsable/)
})

test('polling helpers never count and never break the run', async () => {
  const f = fixture(), s = f.session()
  f.call(s, 'bash', ARGS)
  for (let n = 0; n < 5; n++) f.call(s, 'job_output', JSON.stringify({ id: n }))
  assert.equal((await f.step(s)).messages.length, 1)
  f.call(s, 'bash', ARGS)
  f.call(s, 'list_agents', '{}')
  f.call(s, 'bash', ARGS)
  assert.equal((await f.step(s)).messages.length, 2)
  assert.ok(DEFAULT_EXCLUDED_TOOLS.includes('job_output'))
})

test('a rejected or aborted step keeps the reminder available', async () => {
  const f = fixture(), s = f.session()
  for (let n = 0; n < 3; n++) f.call(s, 'bash', ARGS)
  const reject = await f.hooks.get('agent/pre-step')({ agent: { session: s } }, async () => ({ kind: 'reject' }))
  assert.deepEqual(reject, { kind: 'reject' })
  const decision = await f.step(s)
  assert.equal(decision.messages.length, 2)
  const id = decision.messages.at(-1).id
  // An uncommitted injection is not delivered twice, and only the committed
  // message consumes one slot of the per-turn budget.
  assert.equal((await f.step(s)).messages.length, 2)
  f.commit(s, id)
  for (let n = 0; n < 4; n++) f.call(s, 'bash', ARGS)
  assert.equal((await f.step(s)).messages.length, 1)
})

test('the per-turn budget is bounded at three reminders', async () => {
  const f = fixture(), s = f.session()
  let warnings = 0
  for (const tool of ['bash', 'read', 'grep', 'glob']) {
    for (let n = 0; n < 3; n++) f.call(s, tool, ARGS)
    const decision = await f.step(s)
    const reminder = decision.messages.at(-1)
    if (reminder.source?.kind === 'plugin:lean-repeated-tool-guard') {
      warnings += 1
      f.commit(s, reminder.id)
    }
  }
  assert.equal(warnings, HARD_LIMIT)
})

test('configured limits are clamped and turn boundaries reset the run', async () => {
  const f = fixture({ threshold: 99, maxWarningsPerTurn: 99 }), s = f.session()
  for (let n = 0; n < 3; n++) f.call(s, 'bash', ARGS)
  assert.equal((await f.step(s)).messages.length, 2)
  f.hooks.get('session/event')(s, { type: 'turn/end', seq: 0, data: { turn: 1 } })
  for (let n = 0; n < 2; n++) f.call(s, 'bash', ARGS)
  assert.equal((await f.step(s)).messages.length, 1)
  f.hooks.get('agent/disposed')({ agent: { session: s } })
  assert.equal((await f.step(s)).messages.length, 1)
})

// The unit fixture above asserts the reminder logic. This one proves the real
// AgentLoop actually delivers it: the model repeats one call, and the reminder
// must appear in the next request's messages and in the durable log.
test('the production loop delivers the reminder to the next request', { timeout: 10000 }, async () => {
  const { Context } = await runtime('@deepseek-ai/cordis')
  const { LlmAdapter } = await runtime('@deepseek-ai/dsh-llm')
  const ctx = new Context()
  const requests = []
  class Adapter extends LlmAdapter {
    async *stream(options) {
      requests.push({ messages: structuredClone(options.messages), tools: structuredClone(options.tools) })
      const n = requests.length
      const call = n <= 4
      const block = { type: 'tool-call', id: `call-${n}`, name: 'sample_echo', arguments: JSON.stringify({ text: 'same' }) }
      if (call) {
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
    ctx.llm.registerAdapter(['repeat-test'], new Adapter())
    ctx.tools.register({
      name: 'sample_echo', description: 'echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      execute: async () => ({ text: 'echoed' }),
    })
    await ctx.plugin({ name: 'test-repeated-guard', apply })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create('repeat-production', { provider: 'repeat-test', model: 'fixture' })
    agent.followup({ id: 'input', role: 'user', content: [{ type: 'text', text: 'work' }], source: { kind: 'plugin', plugin: 'test', form: 'notice', summary: 'input' } })
    await agent.whenIdle()
    assert.ok(requests.length >= 4, `expected at least four requests, saw ${requests.length}`)
    const textOf = messages => messages.flatMap(m => m.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
    // The reminder lands after the third identical call, so request four has it.
    assert.doesNotMatch(textOf(requests[2].messages), /identical arguments/)
    assert.match(textOf(requests[3].messages), /identical arguments/)
    const delivered = agent.session.ownEvents().filter(e => e.type === 'user/message' && e.data.source?.kind === 'plugin:lean-repeated-tool-guard')
    assert.equal(delivered.length, 1)
  } finally { await ctx.fiber.dispose() }
})
