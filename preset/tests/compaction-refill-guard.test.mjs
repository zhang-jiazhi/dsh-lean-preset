import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, NoProgressError, RapidRefillError } from '../compaction-refill-guard.mjs'

function fixture() {
  const hooks = new Map()
  const disposers = []
  let calls = 0
  const engine = {
    retries: 1, noOp: false, fail: false, tiny: false,
    async compactIfNeeded(agent, trigger, signal) {
      assert.equal(this, engine)
      if (this.noOp) return null
      let result
      for (let n = 0; n < this.retries; n++) result = await this.compactRegion(0, 1, agent, signal)
      return result
    },
    async compactRegion() {
      assert.equal(this, engine)
      calls++
      if (this.fail) throw new Error('summary failed')
      if (this.tiny) throw new Error('summary is not smaller than the shadowed content (10 estimated framed tokens >= 9)')
      return { summarySeq: calls }
    },
    async compactNow() { return { summarySeq: ++calls } },
  }
  const original = { ...engine }
  apply({
    // Mirrors the real host: `ctx.compaction` is a read proxy, so the guard must
    // resolve the underlying instance through `ctx.get`.
    get: name => (name === 'compaction' ? engine : undefined),
    effect: fn => disposers.push(fn()),
    on: (name, fn) => hooks.set(name, fn),
  })
  const agent = () => ({ session: { isOwnSeq: seq => seq >= 0 } })
  const signal = new AbortController().signal
  let step = 0
  const event = (a, type, data, seq = 0) => hooks.get('session/event')(a.session, { type, data, seq })
  const batch = (a, results = 1) => {
    const data = { turn: 1, step: step++ }
    for (let i = 0; i < results; i++) event(a, 'tool/result', data)
    event(a, 'step/end', data)
  }
  const compact = (a, trigger = 'pressure') => engine.compactIfNeeded(a, trigger, signal)
  return { engine, original, hooks, disposers, agent, signal, event, batch, compact, calls: () => calls }
}

test('blocks the third rapid refill before another summary, across both triggers', async () => {
  const f = fixture(), a = f.agent()
  await f.compact(a)
  await f.compact(a, 'context-overflow')
  await f.compact(a)
  await assert.rejects(f.compact(a), RapidRefillError)
  assert.equal(f.calls(), 3)
})

test('three completed tool batches reset the refill streak; parallel tools count once', async () => {
  const f = fixture(), a = f.agent()
  await f.compact(a)
  await f.compact(a)
  f.batch(a, 20)
  f.batch(a, 20)
  await f.compact(a)
  f.batch(a)
  f.batch(a)
  f.batch(a)
  await f.compact(a)
  await f.compact(a)
  await f.compact(a)
  await assert.rejects(f.compact(a), RapidRefillError)
  assert.equal(f.calls(), 6)
})

test('blocks after three consecutive no-progress summaries and recovers on a new turn', async () => {
  const f = fixture(), a = f.agent()
  f.engine.tiny = true
  for (let n = 0; n < 3; n++) await assert.rejects(f.compact(a), /summary is not smaller/)
  await assert.rejects(f.compact(a), NoProgressError)
  assert.equal(f.calls(), 3)
  f.event(a, 'turn/start', {})
  f.engine.tiny = false
  await f.compact(a)
  assert.equal(f.calls(), 4)
})

test('a non-tiny summary failure resets the no-progress streak', async () => {
  const f = fixture(), a = f.agent()
  f.engine.tiny = true
  for (let n = 0; n < 2; n++) await assert.rejects(f.compact(a), /summary is not smaller/)
  f.engine.tiny = false
  f.engine.fail = true
  await assert.rejects(f.compact(a), /summary failed/)
  f.engine.fail = false
  f.engine.tiny = true
  for (let n = 0; n < 2; n++) await assert.rejects(f.compact(a), /summary is not smaller/)
  f.engine.tiny = false
  await f.compact(a)
})

test('single-invocation summary retries keep their original budget', async () => {
  const f = fixture(), a = f.agent()
  f.engine.retries = 4
  for (let n = 0; n < 3; n++) await f.compact(a)
  assert.equal(f.calls(), 12)
  await assert.rejects(f.compact(a), RapidRefillError)
  assert.equal(f.calls(), 12)
})

test('no-ops and failed summaries do not consume successful refill budget', async () => {
  const f = fixture(), a = f.agent()
  f.engine.noOp = true
  for (let n = 0; n < 5; n++) assert.equal(await f.compact(a), null)
  f.engine.noOp = false
  f.engine.fail = true
  for (let n = 0; n < 5; n++) await assert.rejects(f.compact(a), /summary failed/)
  f.engine.fail = false
  for (let n = 0; n < 3; n++) await f.compact(a)
  await assert.rejects(f.compact(a), RapidRefillError)
})

test('manual compaction and disposal reset; turn end does not', async () => {
  const f = fixture(), a = f.agent(), b = f.agent()
  for (let n = 0; n < 3; n++) await f.compact(a)
  await assert.rejects(f.compact(a), RapidRefillError)
  await f.compact(b)
  await f.engine.compactNow(a, f.signal)
  await f.compact(a)   // rapid 0 after the reset
  await f.compact(a)   // rapid 1
  f.event(a, 'turn/end', { turn: 1 })
  await f.compact(a)   // rapid 2
  await assert.rejects(f.compact(a), RapidRefillError)
  f.hooks.get('agent/disposed')({ agent: a })
  await f.compact(a)
})

// dsh-agent-loop ends the failed turn and propagates the error, so the loop
// stops instead of retrying. Without the turn/start recovery below, the
// breaker would outlive the turn that failed and make the session unusable
// forever, because every later turn aborts on its first step.
test('a blocked session recovers on the next user turn', async () => {
  const f = fixture(), a = f.agent()
  for (let n = 0; n < 3; n++) await f.compact(a)
  await assert.rejects(f.compact(a), RapidRefillError)
  f.event(a, 'turn/end', { turn: 1 })
  await assert.rejects(f.compact(a), RapidRefillError)
  f.event(a, 'turn/start', { turn: 2 })
  for (let n = 0; n < 3; n++) await f.compact(a)
  await assert.rejects(f.compact(a), RapidRefillError)
})

test('inherited events and unfinished or non-tool steps do not count as progress', async () => {
  const f = fixture(), a = f.agent()
  for (let n = 0; n < 3; n++) await f.compact(a)
  for (let n = 0; n < 4; n++) {
    f.event(a, 'tool/result', { turn: 1, step: n }, -1)
    f.event(a, 'step/end', { turn: 1, step: n })
  }
  f.event(a, 'tool/result', { turn: 1, step: 9 })
  await assert.rejects(f.compact(a), RapidRefillError)
})

test('cancelled calls preserve the exact reason without charging the guard', async () => {
  const f = fixture(), a = f.agent(), controller = new AbortController()
  const reason = new Error('stop')
  controller.abort(reason)
  await assert.rejects(f.engine.compactIfNeeded(a, 'pressure', controller.signal), error => error === reason)
  for (let n = 0; n < 3; n++) await f.compact(a)
  assert.equal(f.calls(), 3)
})

test('boundary checks propagate swallowed engine errors in either hook order', async () => {
  for (const event of ['agent/pre-step', 'agent/request-error']) {
    const f = fixture(), a = f.agent()
    for (let n = 0; n < 3; n++) await f.compact(a)
    const payload = { agent: a, signal: f.signal }
    const base = async next => {
      try { await f.compact(a) } catch { /* Mirrors the stock recovery hook. */ }
      return next()
    }
    const terminal = async () => ({ kind: 'enter', messages: [] })
    await assert.rejects(f.hooks.get(event)(payload, () => base(terminal)), RapidRefillError)
    await assert.rejects(base(() => f.hooks.get(event)(payload, terminal)), RapidRefillError)
  }
})

test('plugin teardown restores all original service methods', () => {
  const f = fixture()
  for (const dispose of f.disposers.reverse()) dispose()
  for (const method of ['compactIfNeeded', 'compactRegion', 'compactNow']) assert.equal(f.engine[method], f.original[method])
})
