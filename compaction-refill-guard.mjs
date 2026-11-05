/** LEAN-local guard around the public compaction service, not the host engine. */
export const name = 'lean-compaction-refill-guard'
export const inject = ['compaction']
export const RAPID_REFILL_LIMIT = 3
export const MIN_TOOL_BATCHES = 3
// 20261017-audit-p2: a summary that is not smaller than the region it replaces
// cannot make progress. October's a4cf5d had 11 consecutive such failures in
// one turn (and 32 total): each retry paid a full summarization request and
// blocked the step for minutes without shrinking the context.
export const MAX_SUMMARY_STALLS = 3

export class RapidRefillError extends Error {
  constructor() {
    super('LEAN rapid-refill guard: context refilled after fewer than 3 tool batches three times. Automatic compaction stopped before another summary; narrow tool output or start a fresh turn.')
    this.name = 'RapidRefillError'
    this.code = 'LEAN_COMPACTION_RAPID_REFILL'
  }
}

export class NoProgressError extends Error {
  constructor(count = MAX_SUMMARY_STALLS) {
    super(`LEAN compaction-progress guard: the summarizer returned a summary that was not smaller than the region ${count} times in a row. Automatic compaction stopped for this turn; narrow tool output or start a fresh turn/session.`)
    this.name = 'NoProgressError'
    this.code = 'LEAN_COMPACTION_NO_PROGRESS'
  }
}

const isTinySummaryError = error =>
  typeof error?.message === 'string' && error.message.includes('summary is not smaller than the shadowed content')

export function apply(ctx) {
  // `ctx.compaction` is a READ proxy: writes never reach the underlying
  // instance, and the engine's own automatic hook calls `this.compactIfNeeded`
  // directly. `ctx.get` returns the real instance, so an own-property override
  // here is what that internal `this` call actually resolves to.
  const engine = ctx.get('compaction')
  if (engine === undefined) throw new Error(`${name}: compaction service is not available`)
  const states = new WeakMap()
  const operations = new WeakMap()
  const stateFor = session => {
    let state = states.get(session)
    if (!state) {
      state = { compacted: false, rapid: 0, batches: 0, resultStep: null, summaryStalls: 0, blocked: null }
      states.set(session, state)
    }
    return state
  }
  const replace = (method, wrap) => {
    const descriptor = Object.getOwnPropertyDescriptor(engine, method)
    const original = engine[method]
    if (typeof original !== 'function') throw new TypeError(`${name}: compaction.${method} is missing`)
    const replacement = wrap(original.bind(engine))
    ctx.effect(() => {
      engine[method] = replacement
      return () => {
        if (engine[method] !== replacement) return
        if (descriptor) Object.defineProperty(engine, method, descriptor)
        else delete engine[method]
      }
    })
  }

  replace('compactIfNeeded', original => async (agent, trigger, signal) => {
    signal.throwIfAborted()
    const session = agent.session
    if (operations.has(session)) throw new Error(`${name}: overlapping automatic compaction`)
    const state = stateFor(session)
    if (state.blocked) throw state.blocked
    const operation = { recorded: false }
    operations.set(session, operation)
    try { return await original(agent, trigger, signal) }
    finally { operations.delete(session) }
  })

  replace('compactRegion', original => async (start, end, agent, signal) => {
    signal?.throwIfAborted()
    const operation = operations.get(agent.session)
    if (!operation) return original(start, end, agent, signal)
    const state = stateFor(agent.session)
    const rapid = state.compacted && state.batches < MIN_TOOL_BATCHES ? state.rapid + 1 : 0
    if (!operation.recorded && rapid >= RAPID_REFILL_LIMIT) {
      state.blocked = new RapidRefillError()
      throw state.blocked
    }
    let result
    try {
      result = await original(start, end, agent, signal)
    } catch (error) {
      // A "summary not smaller" error means this region cannot make progress.
      // The engine may retry it (and the next turn may retry the same region);
      // stop after three consecutive occurrences instead of paying a full
      // summarization request per retry. Any other error resets the streak.
      if (isTinySummaryError(error)) {
        state.summaryStalls += 1
        if (state.summaryStalls >= MAX_SUMMARY_STALLS) state.blocked = new NoProgressError(state.summaryStalls)
      } else {
        state.summaryStalls = 0
      }
      throw error
    }
    state.summaryStalls = 0
    // One pressure invocation may retry summaries. Count it once, and only
    // after durable success, without changing the engine's retry budget.
    if (!operation.recorded) {
      state.compacted = true
      state.rapid = rapid
      state.batches = 0
      state.resultStep = null
      operation.recorded = true
    }
    return result
  })

  replace('compactNow', original => async (agent, ...args) => {
    const result = await original(agent, ...args)
    if (result !== null) states.delete(agent.session)
    return result
  })

  ctx.on('session/event', (session, event) => {
    if (!session.isOwnSeq(event.seq)) return
    // A new turn only exists because the user (or a followup) supplied fresh
    // input, and dsh-agent-loop's recovery path ends the failed turn before
    // any retry. turn/start is therefore the ONE dependable recovery point: if
    // the breaker survived it, every later turn would abort on its first step
    // and the session would be permanently unusable. turn/end is NOT a
    // recovery point - clearing there would let a failing turn refill itself.
    if (event.type === 'turn/start') { states.delete(session); return }
    const state = states.get(session)
    if (!state) return
    if (event.type === 'turn/end') { state.resultStep = null; return }
    const key = `${event.data.turn}:${event.data.step}`
    if (event.type === 'tool/result') state.resultStep = key
    if (event.type === 'step/end' && state.resultStep === key) {
      state.batches = Math.min(MIN_TOOL_BATCHES, state.batches + 1)
      state.resultStep = null
    }
  })

  // BasicCompactionEngine catches summary errors and continues. Check both
  // sides of next() so hook ordering never swallows this circuit breaker.
  const guardBoundary = async ({ agent, signal }, next) => {
    signal.throwIfAborted()
    if (states.get(agent.session)?.blocked) throw states.get(agent.session).blocked
    const result = await next()
    signal.throwIfAborted()
    if (states.get(agent.session)?.blocked) throw states.get(agent.session).blocked
    return result
  }
  ctx.on('agent/pre-step', guardBoundary)
  ctx.on('agent/request-error', guardBoundary)
  ctx.on('agent/disposed', ({ agent }) => { states.delete(agent.session); operations.delete(agent.session) })
}
