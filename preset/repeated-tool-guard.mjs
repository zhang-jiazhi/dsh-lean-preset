/**
 * Bounded repeated-call reminder.
 *
 * A model that re-sends the same tool with the same arguments is usually
 * waiting for a different result, not asking a new question. This plugin
 * counts consecutive identical durable `tool/call` events and adds ONE short
 * reminder at the threshold, at most three times per turn.
 *
 * It never blocks a call, never rewrites a result, and never repeats argument
 * values in the reminder. Counting follows durable order rather than result
 * completion, so parallel calls and retries cannot reorder or double-count
 * the sequence. Polling helpers are ignored instead of counted, so waiting on
 * a background job is not mistaken for a loop.
 */

/** Tool name used by loader diagnostics. */
export const name = 'lean-repeated-tool-guard'

/** Polling helpers whose repetition is expected and carries no new information. */
export const DEFAULT_EXCLUDED_TOOLS = [
  'job_output',
  'job_list',
  'list_agents',
  'wait_agent',
  'team_task_list',
  'team_task_get',
]

/** Hard ceiling for both the threshold and the per-turn reminder budget. */
export const HARD_LIMIT = 3

/** A reminder must stay short enough to never become the payload of a step. */
const MAX_REMINDER_CHARS = 400

let reminderSeq = 0

/** Clamp a configured count into 1..HARD_LIMIT, falling back to the limit. */
function bound(value, fallback) {
  if (!Number.isSafeInteger(value) || value < 1) return fallback
  return Math.min(value, HARD_LIMIT)
}

/** Canonical form with recursively sorted keys, so key order cannot fake a change. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Identity of one call: tool name plus canonical arguments, never the raw text. */
export function callSignature(toolName, argumentsText) {
  if (typeof argumentsText !== 'string') return `${toolName}:<unparsable>`
  try {
    return `${toolName}:${canonical(JSON.parse(argumentsText))}`
  } catch {
    return `${toolName}:<unparsable>`
  }
}

/** Reminder text: names the tool and the count, never the argument values. */
function reminderText(toolName, count) {
  return [
    `You have now called \`${toolName}\` ${count} times in a row with identical arguments.`,
    'The same call cannot return a different answer. Change an argument, use a different tool,',
    'or stop and report what you already know to the user instead of repeating this call.',
  ].join(' ').slice(0, MAX_REMINDER_CHARS)
}

function stateFor(states, session) {
  let state = states.get(session)
  if (state === undefined) {
    state = { signature: null, count: 0, warnings: 0, pending: null }
    states.set(session, state)
  }
  return state
}

export function apply(ctx, config = {}) {
  const threshold = bound(config.threshold, HARD_LIMIT)
  const maxWarnings = bound(config.maxWarningsPerTurn, HARD_LIMIT)
  const excluded = new Set(Array.isArray(config.excludedTools) ? config.excludedTools : DEFAULT_EXCLUDED_TOOLS)
  const states = new WeakMap()
  const reset = session => { states.delete(session) }

  ctx.on('session/event', (session, event) => {
    // Fork and restore inherit the parent's calls; only this session's own
    // committed calls describe the loop the model is actually in.
    if (!session.isOwnSeq(event.seq)) return
    if (event.type === 'turn/start' || event.type === 'turn/end') return reset(session)
    const state = stateFor(states, session)
    if (event.type === 'tool/call') {
      const { name: toolName, arguments: argumentsText } = event.data
      // Excluded tools neither count nor break the run: polling between two
      // identical calls still leaves those calls consecutive.
      if (excluded.has(toolName)) return
      const signature = callSignature(toolName, argumentsText)
      state.count = signature === state.signature ? state.count + 1 : 1
      state.signature = signature
      // The run broke, so a reminder queued for the previous run describes a
      // loop the model already left; injecting it would misreport the tool.
      if (state.count === 1) state.pending = null
      // Warn once at the threshold, not on every later repetition. Keep the
      // budget per turn so a turn cannot be flooded with reminders.
      if (state.count === threshold && state.warnings < maxWarnings && state.pending === null) {
        state.pending = { id: `lean-repeat-${event.data.turn}-${event.data.step}-${++reminderSeq}`, toolName, count: state.count }
      }
      return
    }
    // Delivery is acknowledged only by the committed message, so a rejected or
    // aborted step can offer the same reminder again.
    if (event.type === 'user/message' && state.pending !== null && event.data?.id === state.pending.id) {
      state.warnings += 1
      state.pending = null
    }
  })

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const state = states.get(agent.session)
    if (state === undefined || state.pending === null) return next()
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    // One injection per queued reminder: the required messages may be rebuilt
    // per step, and the committed message is what acknowledges delivery.
    return {
      ...decision,
      messages: [...decision.messages, {
        id: state.pending.id,
        role: 'user',
        content: [{ type: 'text', text: reminderText(state.pending.toolName, state.pending.count) }],
        // v4 sessions only admit producer-owned kinds (`plugin:<name>`); the old
        // `{ kind: 'plugin', plugin }` wrapper fails admission at append time.
        source: { kind: `plugin:${name}`, form: 'notice', summary: `repeated ${state.pending.toolName} call` },
      }],
    }
  })

  // The reminder is advisory: it never turns a step into a rejection. Turn
  // boundaries already reset through the durable `turn/end` event above, and
  // `agent/turn-stopping` carries only `{ turn, signal }`.
  ctx.on('agent/disposed', ({ agent }) => { reset(agent.session) })
}
