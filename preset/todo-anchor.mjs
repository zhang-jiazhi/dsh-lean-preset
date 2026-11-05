/**
 * lean-todo-anchor — keep the model's own task list in front of it at the two
 * moments it demonstrably stops looking at it.
 *
 * Both behaviours are ported from harnesses that hit the same failure:
 *
 *  1. POST-COMPACTION RE-ANCHOR (Claude Code re-injects its todo list with the
 *     post-compaction system reminder). A checkpoint summarises the trajectory,
 *     but the todo list is authoritative STATE that the summary may compress
 *     away or paraphrase; work then continues against a half-remembered plan.
 *     This preset's compaction is deliberately aggressive (thresholdRatio 0.2
 *     on a 1M window from 2026-09-24), so the risk grows with the win.
 *
 *  2. STALE-PLAN NUDGE (Claude Code's "todo list is empty / has changed"
 *     system reminders, ~86-111 tokens). Measured over 149 lean turns
 *     (2026-09-24): in the 22 turns that used `todo_write`, the median run of
 *     steps with no todo update was 19 and p90 was 67 — a long stretch of work
 *     driven by a plan the model itself has stopped revising. The nudge is one
 *     short message, at most twice a turn, and never blocks a call.
 *
 * Both messages are advisory: the decision stays `enter`, the catalog is
 * untouched, and no argument values or file contents ride along — only the
 * model's OWN todo text, which is already in its context.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'lean-todo-anchor'

/** No service dependency: this plugin only observes durable events. */
export const inject = []

/** Steps without a todo update before the stale-plan nudge. */
const DEFAULT_STALE_STEPS = 25

/** Reminders allowed per turn. */
const DEFAULT_MAX_PER_TURN = 2

/** Hard cap on both bounds, so a bad config cannot flood a turn. */
const HARD_STEP_CAP = 200

/** A reminder must never become the payload of a step. */
const MAX_TEXT_CHARS = 1200

/** Cap the list echo: a long list is exactly when a full echo costs most. */
const MAX_TODOS_ECHOED = 12

const STATUS_MARK = { completed: 'x', in_progress: '>', pending: ' ' }

/** Clamp a configured step count into 1..HARD_STEP_CAP. */
function boundSteps(value) {
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_STALE_STEPS
  return Math.min(value, HARD_STEP_CAP)
}

/** Clamp a configured reminder budget into 1..3. */
function boundWarnings(value) {
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_MAX_PER_TURN
  return Math.min(value, 3)
}

/**
 * Read one durable `todo/write` payload.
 *
 * The tool replaces the whole list every call, so the LAST write is the
 * current state; entries are narrowed to the wire shape and never trusted.
 * @param {unknown} data - the event's `data`.
 * @returns {Array<{ content: string, status: string }> | undefined} todos when shaped, else undefined.
 */
export function parseTodos(data) {
  const todos = data?.todos
  if (!Array.isArray(todos)) return undefined
  const out = []
  for (const item of todos) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.content !== 'string' || item.content.length === 0) continue
    const status = typeof item.status === 'string' ? item.status : 'pending'
    out.push({ content: item.content, status })
  }
  return out
}

/** Unfinished items only: a completed list needs no anchor. */
const openTodos = (todos) => (todos ?? []).filter((todo) => todo.status !== 'completed')

/** One bounded line per item, nothing else. */
function listTodoText(todos) {
  const shown = todos.slice(0, MAX_TODOS_ECHOED)
  const lines = shown.map((todo) => `- [${STATUS_MARK[todo.status] ?? ' '}] ${todo.content}`)
  if (todos.length > shown.length) lines.push(`- … ${String(todos.length - shown.length)} more`)
  return lines.join('\n')
}

/**
 * Stale nudge: the shortest text that still names the plan.
 *
 * The full list is already in context, so only the ACTIVE item is restated —
 * that is the one the model should be working on, and quoting the whole list
 * here would make the nudge grow with the plan instead of staying ~100 tokens.
 */
function staleText(steps, todos) {
  const active = todos.find((todo) => todo.status === 'in_progress')
  const remaining = openTodos(todos).length
  const lines = [`Your todo list has not been updated for ${String(steps)} steps.`]
  if (active !== undefined) lines.push(`Marked in progress: ${active.content}`)
  lines.push(`${String(remaining)} item(s) still open.`)
  lines.push('If the plan no longer matches the work, revise it with todo_write; otherwise continue.')
  return lines.join('\n').slice(0, MAX_TEXT_CHARS)
}

function anchorText(todos) {
  return [
    'Context was just compacted; the checkpoint may have compressed your plan away. Current todo list:',
    listTodoText(todos),
    '',
    'Continue from the in-progress item, and keep the list current with todo_write.',
  ].join('\n').slice(0, MAX_TEXT_CHARS)
}

/** Per-session reminder state, discarded when the session leaves the store. */
function stateFor(states, session) {
  let state = states.get(session)
  if (state === undefined) {
    state = { todos: undefined, steps: 0, warnings: 0, pending: null, anchored: false }
    states.set(session, state)
  }
  return state
}

export function apply(ctx, config = {}) {
  const staleSteps = boundSteps(config.staleSteps)
  const maxPerTurn = boundWarnings(config.maxAnchorsPerTurn)
  const states = new WeakMap()
  let counter = 0

  /** Fold one durable event into the session's state; returns nothing. */
  function observe(session, event) {
    const state = stateFor(states, session)
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      // The per-turn budget and any uncommitted reminder belong to the turn
      // that is over; the todo list itself is durable and survives.
      state.warnings = 0
      state.pending = null
      if (event.type === 'turn/start') state.steps = 0
      return
    }
    if (event.type === 'todo/write') {
      const todos = parseTodos(event.data)
      if (todos === undefined) return
      state.todos = todos
      state.steps = 0
      // A fresh list supersedes a queued nudge about the old one.
      if (state.pending?.kind === 'stale') state.pending = null
      return
    }
    if (event.type === 'compaction/end') {
      // `compaction/end` also fires for failed compactions; only a real
      // checkpoint replaces the conversation, so an errored one must not inject.
      if (event.data?.error !== undefined) return
      state.anchored = true
      return
    }
    if (event.type === 'assistant/message') {
      state.steps += 1
      return
    }
  }

  /** Cold scan for a resumed/forked session: own events only, same as the other guards. */
  function scan(session) {
    const state = { todos: undefined, steps: 0, warnings: 0, pending: null, anchored: false }
    states.set(session, state)
    for (const event of session.ownEvents()) observe(session, event)
    return state
  }

  const stateOf = (session) => states.get(session) ?? scan(session)

  /** Queue the one reminder this step should carry, if any. */
  function queue(state, session, step) {
    if (state.pending !== null) return
    const open = openTodos(state.todos)
    if (open.length === 0) return
    if (state.anchored) {
      // `anchored` is cleared by DELIVERY, not here: an aborted or rejected
      // step must not consume the anchor, because the checkpoint is already in
      // the conversation and nothing else would bring the plan back.
      state.pending = { id: `lean-todo-anchor-${String(step)}-${++counter}`, kind: 'anchor', text: anchorText(state.todos) }
      return
    }
    if (state.warnings >= maxPerTurn) return
    if (state.steps < staleSteps) return
    state.pending = { id: `lean-todo-stale-${String(step)}-${++counter}`, kind: 'stale', text: staleText(state.steps, state.todos) }
  }

  // ONE listener for both jobs: folding durable state, and acknowledging a
  // delivered reminder. Two listeners on the same event would also depend on
  // registration order, which the loader does not guarantee across rows.
  ctx.on('session/event', (session, event) => {
    if (session === undefined || event === undefined) return
    if (typeof session.isOwnSeq !== 'function' || !session.isOwnSeq(event.seq)) return
    if (event.type === 'user/message') {
      const state = stateOf(session)
      if (state.pending === null || event.data?.id !== state.pending.id) return
      // Delivered: charge the turn budget and pull the staleness clock back, so
      // the nudge just delivered cannot be re-offered on the very next step.
      state.warnings += 1
      state.steps = Math.max(0, state.steps - staleSteps)
      if (state.pending.kind === 'anchor') state.anchored = false
      state.pending = null
      return
    }
    observe(session, event)
  })

  ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    const state = stateOf(agent.session)
    queue(state, agent.session, step)
    const decision = await next()
    if (decision.kind !== 'enter' || state.pending === null) return decision
    // One injection per queued reminder: the committed message acknowledges it,
    // and a rejected or aborted step leaves it queued.
    return {
      ...decision,
      messages: [...decision.messages, {
        id: state.pending.id,
        role: 'user',
        content: [{ type: 'text', text: state.pending.text }],
        // v4 admits producer-owned kinds only; `plugin:<name>` is this
        // plugin's, and no consumer may mistake it for the user speaking.
        source: { kind: `plugin:${name}`, form: 'notice', summary: 'todo anchor' },
      }],
    }
  })

  ctx.on('session/disposed', (session) => {
    if (session !== undefined && session !== null) states.delete(session)
  })
}
