import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, name, parseTodos } from '../todo-anchor.mjs'

const TODOS = [
  { content: 'wire the exporter', status: 'in_progress' },
  { content: 'add regression test', status: 'pending' },
  { content: 'read the spec', status: 'completed' },
]

function fixture(config = {}) {
  const hooks = new Map()
  apply({ on: (event, hook) => hooks.set(event, hook) }, config)
  let seq = 0
  const sessions = []
  const session = () => {
    const value = { id: `anchor-${sessions.length + 1}`, own: [], ownEvents() { return this.own }, isOwnSeq: () => true }
    sessions.push(value)
    return value
  }
  const emit = (s, type, data) => {
    const event = { type, seq: seq++, data }
    s.own.push(event)
    hooks.get('session/event')(s, event)
    return event
  }
  const write = (s, todos = TODOS) => emit(s, 'todo/write', { todos })
  const step = async (s, stepNumber = 1) => hooks.get('agent/pre-step')(
    { agent: { session: s }, step: stepNumber },
    async () => ({ kind: 'enter', messages: [{ id: 'existing', role: 'user', content: [] }] }),
  )
  const compact = (s, error) => emit(s, 'compaction/end', error === undefined ? {} : { error })
  const commit = (s, id) => emit(s, 'user/message', { id })
  return { hooks, session, emit, write, step, compact, commit }
}

const reminderOf = decision => (decision.messages.length > 1 ? decision.messages.at(-1) : undefined)

test('a failed compaction never anchors: only a real checkpoint does', async () => {
  const f = fixture(), s = f.session()
  f.write(s)
  f.emit(s, 'compaction/end', { error: 'isContextWindowExceededError is not defined' })
  assert.equal(reminderOf(await f.step(s)), undefined)
  f.compact(s)
  const reminder = reminderOf(await f.step(s))
  assert.equal(reminder.source.kind, `plugin:${name}`)
  assert.equal(reminder.source.form, 'notice')
  assert.match(reminder.content[0].text, /Context was just compacted/)
  assert.match(reminder.content[0].text, /wire the exporter/)
})

test('the anchor is delivered once and not repeated', async () => {
  const f = fixture(), s = f.session()
  f.write(s)
  f.compact(s)
  const reminder = reminderOf(await f.step(s, 5))
  assert.ok(reminder)
  f.commit(s, reminder.id)
  assert.equal(reminderOf(await f.step(s, 6)), undefined)
})

test('a stale plan is nudged after the configured run of steps, then the clock restarts', async () => {
  const f = fixture({ staleSteps: 3 }), s = f.session()
  f.write(s)
  for (let n = 0; n < 2; n++) f.emit(s, 'assistant/message', {})
  assert.equal(reminderOf(await f.step(s, 1)), undefined)
  f.emit(s, 'assistant/message', {})
  const reminder = reminderOf(await f.step(s, 2))
  assert.match(reminder.content[0].text, /has not been updated for 3 steps/)
  assert.match(reminder.content[0].text, /Marked in progress: wire the exporter/)
  assert.match(reminder.content[0].text, /2 item\(s\) still open/)
  f.commit(s, reminder.id)
  // The clock restarted: the very next step must not nudge again.
  assert.equal(reminderOf(await f.step(s, 3)), undefined)
})

test('a fresh todo list resets the run and cancels a queued nudge', async () => {
  const f = fixture({ staleSteps: 2 }), s = f.session()
  f.write(s)
  f.emit(s, 'assistant/message', {})
  f.emit(s, 'assistant/message', {})
  f.write(s, [{ content: 'only task', status: 'in_progress' }])
  assert.equal(reminderOf(await f.step(s, 1)), undefined)
})

test('a completed list is never nudged, and no list at all stays silent', async () => {
  const f = fixture({ staleSteps: 1 })
  const empty = f.session()
  for (let n = 0; n < 5; n++) f.emit(empty, 'assistant/message', {})
  assert.equal(reminderOf(await f.step(empty)), undefined)
  const done = f.session()
  f.write(done, [{ content: 'finished', status: 'completed' }])
  for (let n = 0; n < 5; n++) f.emit(done, 'assistant/message', {})
  assert.equal(reminderOf(await f.step(done)), undefined)
})

test('the per-turn budget is bounded, and a new turn restores it', async () => {
  // Within ONE turn the budget holds.
  const g = fixture({ staleSteps: 1, maxAnchorsPerTurn: 2 }), t = g.session()
  g.write(t)
  let inTurn = 0
  for (let n = 0; n < 5; n++) {
    g.emit(t, 'assistant/message', {})
    const reminder = reminderOf(await g.step(t, n))
    if (reminder !== undefined) {
      inTurn += 1
      g.commit(t, reminder.id)
    }
  }
  assert.equal(inTurn, 2)
  // The next turn gets its own budget: a new turn must not be silenced by the
  // previous one, or a long session would go un-anchored after two nudges.
  g.emit(t, 'turn/end', {})
  g.emit(t, 'turn/start', {})
  g.emit(t, 'assistant/message', {})
  g.emit(t, 'assistant/message', {})
  const reminder = reminderOf(await g.step(t, 9))
  assert.ok(reminder, 'a new turn must be able to nudge again')
})

test('an aborted step cannot consume the post-compaction anchor', async () => {
  const f = fixture(), s = f.session()
  f.write(s)
  f.compact(s)
  const rejected = await f.hooks.get('agent/pre-step')({ agent: { session: s }, step: 1 }, async () => ({ kind: 'reject', reason: 'x' }))
  assert.equal(rejected.kind, 'reject')
  // The checkpoint is in the conversation either way, so the plan must still
  // come back once a step actually runs.
  const reminder = reminderOf(await f.step(s, 2))
  assert.match(reminder.content[0].text, /Context was just compacted/)
})

test('a rejected step keeps the queued nudge available', async () => {
  const f = fixture({ staleSteps: 1 }), s = f.session()
  f.write(s)
  f.emit(s, 'assistant/message', {})
  const rejected = await f.hooks.get('agent/pre-step')({ agent: { session: s }, step: 1 }, async () => ({ kind: 'reject', reason: 'x' }))
  assert.equal(rejected.kind, 'reject')
  assert.ok(reminderOf(await f.step(s, 2)))
})

test('a cold-resumed session re-derives the plan and its staleness from own events', async () => {
  const f = fixture({ staleSteps: 2 }), s = f.session()
  f.write(s)
  f.emit(s, 'assistant/message', {})
  f.emit(s, 'assistant/message', {})
  // Same session object, empty in-memory state: nothing was memoized for it.
  const cold = f.session()
  cold.own = s.own
  const reminder = reminderOf(await f.step(cold, 1))
  assert.match(reminder.content[0].text, /wire the exporter/)
})

test('todo payloads are narrowed, and malformed ones are ignored', () => {
  assert.deepEqual(parseTodos({ todos: [{ content: 'a', status: 'pending' }] }), [{ content: 'a', status: 'pending' }])
  assert.equal(parseTodos({ todos: 'nope' }), undefined)
  assert.equal(parseTodos(undefined), undefined)
  assert.deepEqual(parseTodos({ todos: [{ content: '', status: 'pending' }, 'junk', { content: 'keep' }] }), [{ content: 'keep', status: 'pending' }])
})

test('another session never inherits this session state', async () => {
  const f = fixture({ staleSteps: 1 }), a = f.session(), b = f.session()
  f.write(a)
  for (let n = 0; n < 4; n++) f.emit(a, 'assistant/message', {})
  assert.equal(reminderOf(await f.step(b)), undefined)
})
