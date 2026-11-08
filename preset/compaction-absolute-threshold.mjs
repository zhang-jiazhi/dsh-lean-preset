/**
 * lean-compaction-absolute-threshold — make the compaction trigger an absolute
 * token budget instead of a fraction of whatever window the route happens to
 * have.
 *
 * WHY THIS IS A PLUGIN AND NOT `modelPolicies`:
 *
 * `compaction-basic` resolves its threshold as
 * `min(contextWindow * thresholdRatio, contextWindow - reserved - headroom)`,
 * and an exact `modelPolicies` entry is the only other knob. An exact-match
 * table cannot be kept correct here: providers are registered at RUNTIME by
 * plugins (this install's `relay-cn` route exists only because
 * `llm-relay` registers it, `proxy-api` likewise), so a table written
 * from `cordis.patch.yml` silently misses them. A missed route does not fail
 * loudly — it falls back to `thresholdRatio`, which is exactly the ratio
 * behavior this change exists to remove (on a 1M window, 0.6 means compaction
 * only fires at 600k tokens). Measured 2026-09-24: the static table written
 * from the patch file named `alibaba/deepseek-v4.1-flash`, while the route the
 * session actually used was `relay-cn/deepseek-v4.1-flash`.
 *
 * Instead, this plugin reads the LIVE context window per request through the
 * `llm` service and rewrites the policy that `compaction-basic` will resolve
 * for that exact route. Routes whose window is too small for an absolute
 * budget (the ratio must still leave a usable range, and the retained tail must
 * fit under the threshold) are left entirely alone, so their measured behavior
 * is unchanged.
 *
 * EVIDENCE FOR THE NUMBERS (15 lean sessions, 3375 requests, 45 compactions,
 * 2026-09-24):
 *   - average context per request 236k tokens; 77% of all input tokens were
 *     spent on requests above 200k, and 38% above 400k;
 *   - the pruner only runs when compaction is triggered, so at a 600k trigger
 *     large tool results were never pruned during normal work;
 *   - simulated net input (prices: cacheRead 0.1, input 1.0, output 3.0),
 *     INCLUDING every compaction's own recovery cost (summary call, one
 *     unavoidable prefix rewrite, and the measured re-unlock / re-read /
 *     catalog-change overhead):
 *       400k trigger -> 74% of today's cost,  300k -> 62%,  250k -> 55%,
 *       200k -> 50%,  150k -> 41%,  120k -> 38%,  100k -> 36%
 *     Marginal saving per extra compaction: 2.1M tokens-equivalent going
 *     400k->300k, 0.66M at 250k->200k, 0.19M at 150k->120k, and only 0.10M
 *     (≈ the compaction's own overhead) at 120k->100k. The knee is at ~150-200k.
 *   - this preset now takes 400k: the 150-200k knee minimises token cost, but
 *     every extra summary also costs a prefix rewrite and risks dropping detail,
 *     so 400k keeps 74% of the old 600k cost while halving the disruption. The
 *     fallback below matches what lean.patch.yml mounts.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'lean-compaction-absolute-threshold'

/** `compaction` is the service whose resolved policy is rewritten; `llm` names the live window. */
export const inject = ['compaction', 'llm']

/** Absolute trigger: compaction fires once the conversation exceeds this. */
const DEFAULT_THRESHOLD_TOKENS = 400_000

/** Verbatim tail kept after a compaction. */
const DEFAULT_RETAIN_TOKENS = 80_000

/**
 * Windows at or below this keep whatever the deployment configured.
 *
 * The engine derives the threshold from the window with the reserved completion
 * tokens already subtracted, so an absolute budget only makes sense while
 * `window - reserved` leaves room for both the budget and the tail. A 262k
 * window with a 128k request reservation (router-responses/model-a,
 * measured) already resolves to ~69k under the 0.6 default, and forcing 200k
 * there would be ABOVE the window's own budget: the policy would either be
 * rejected or never fire.
 */
const DEFAULT_MIN_WINDOW_TOKENS = 250_000

/** Hard bounds, so a bad config cannot disable or misfire compaction. */
const MAX_THRESHOLD = 600_000

/** Engine defaults, used only when the live config does not state them. */
const DEFAULT_BASE_RATIO = 0.6
const DEFAULT_BASE_HEADROOM = 65_536

const positiveInt = (value, fallback) => (Number.isSafeInteger(value) && value > 0 ? value : fallback)

/**
 * One route's desired policy, or undefined when the absolute budget does not
 * apply.
 *
 * SEMANTIC: this plugin only ever LOWERS the trigger, never raises it.
 *
 * The engine's own threshold for a route is
 * `min(window * thresholdRatio, window - reserved - headroom)`. Raising a
 * threshold above that would delay compaction past what the deployment tuned,
 * and on a small window it can push the trigger above the space the window has
 * at all. Comparing against the live value instead makes the rule
 * self-limiting: a 262k window already resolves to ~157k (or ~69k with a 128k
 * completion reservation), well under the 200k budget, so it is left exactly as
 * it was measured.
 *
 * @param {{ thresholdTokens: number, retainTokens: number, minWindowTokens: number, baseThresholdRatio: number, baseHeadroomTokens: number }} options - resolved config.
 * @param {number} contextWindow - the route's live context window.
 * @param {number} reservedTokens - completion tokens this route's request reserves.
 * @returns {{ thresholdRatio: number, retainTokens: number } | undefined} policy override.
 */
export function policyFor(options, contextWindow, reservedTokens, base = {}) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow < options.minWindowTokens) return undefined
  const reserved = Number.isSafeInteger(reservedTokens) && reservedTokens > 0 ? reservedTokens : 0
  const headroom = Number.isSafeInteger(base.headroomTokens) && base.headroomTokens >= 0 ? base.headroomTokens : DEFAULT_BASE_HEADROOM
  const ratio = Number.isFinite(base.thresholdRatio) && base.thresholdRatio > 0 ? base.thresholdRatio : DEFAULT_BASE_RATIO
  const windowRatioThreshold = Math.floor(contextWindow * ratio)
  const windowBudgetThreshold = contextWindow - reserved - headroom
  const currentThreshold = Math.min(windowRatioThreshold, windowBudgetThreshold)
  // Nothing to lower: the deployment's own trigger is already at or below the
  // absolute budget (or the window cannot hold that budget at all).
  if (!Number.isFinite(currentThreshold) || currentThreshold <= options.thresholdTokens) return undefined
  // The retained tail and the budget must both fit under the window's budget,
  // or the engine would reject the policy it is handed.
  if (windowBudgetThreshold - options.retainTokens < options.thresholdTokens) return undefined
  return { thresholdRatio: options.thresholdTokens / contextWindow, retainTokens: options.retainTokens }
}

export function apply(ctx, config = {}) {
  const thresholdTokens = Math.min(positiveInt(config.thresholdTokens, DEFAULT_THRESHOLD_TOKENS), MAX_THRESHOLD)
  const retainTokens = positiveInt(config.retainTokens, DEFAULT_RETAIN_TOKENS)
  const minWindowTokens = positiveInt(config.minWindowTokens, DEFAULT_MIN_WINDOW_TOKENS)
  if (retainTokens >= thresholdTokens) {
    throw new Error(`${name}: retainTokens (${String(retainTokens)}) must be below thresholdTokens (${String(thresholdTokens)})`)
  }
  const engine = ctx.get('compaction')
  if (engine === undefined) throw new Error(`${name}: compaction service is not available`)
  const options = { thresholdTokens, retainTokens, minWindowTokens }
  /** Resolved window per `${provider}/${model}`, so the lookup runs once per route. */
  const windows = new Map()
  /** Last ratio written per route, so an unchanged decision does not churn the config array. */
  const applied = new Map()

  /** The routed provider/model of this agent's latest durable request. */
  const targetOf = (agent) => {
    const header = agent?.session?.requestHeader?.()?.config
    if (header === undefined || typeof header.provider !== 'string' || typeof header.model !== 'string') return undefined
    if (header.provider.length === 0 || header.model.length === 0) return undefined
    return { provider: header.provider, model: header.model, maxTokens: header.maxTokens }
  }

  const windowFor = async (target, signal) => {
    const key = `${target.provider}\u0000${target.model}`
    let window = windows.get(key)
    if (window === undefined) {
      const info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal)
      window = info?.context?.contextWindow
      if (!Number.isSafeInteger(window) || window <= 0) return undefined
      windows.set(key, window)
    }
    return window
  }

  /**
   * Own-property override on the REAL instance: `ctx.compaction` is a read
   * proxy, but `compactIfNeeded` is documented as dynamically dispatched so
   * subclass overrides are honored at event time. The effect owns both the
   * install and the restore, and restores the exact previous descriptor, so a
   * sibling wrapper (compaction-refill-guard) is put back unchanged.
   */
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

  /**
   * Rewrite the resolved policy for the CURRENT route before the engine prices
   * the request. `modelPolicies` is read through `resolveTargetPolicy` on every
   * call, so swapping the array is enough — no engine internals are patched.
   *
   * Recomputed every step (the window lookup is cached per route, the arithmetic
   * is free) because a route's reserved completion tokens can change between
   * requests: a request that reserves more leaves less room for the budget.
   */
  const retune = async (agent, signal) => {
    const existing = engine.config.modelPolicies
    if (!Array.isArray(existing)) return
    const target = targetOf(agent)
    if (target === undefined) return
    const window = await windowFor(target, signal)
    if (window === undefined) return
    const base = {
      thresholdRatio: engine.config.thresholdRatio,
      headroomTokens: engine.config.headroomTokens,
    }
    const policy = policyFor(options, window, target.maxTokens, base)
    const key = `${target.provider}\u0000${target.model}`
    if (policy === undefined) {
      // The route keeps its own trigger; drop any stale override for it.
      if (!applied.has(key)) return
      applied.delete(key)
      engine.config = { ...engine.config, modelPolicies: existing.filter((entry) => entry.provider !== target.provider || entry.model !== target.model) }
      return
    }
    if (applied.get(key) === policy.thresholdRatio) return
    applied.set(key, policy.thresholdRatio)
    engine.config = {
      ...engine.config,
      modelPolicies: [
        { provider: target.provider, model: target.model, ...policy },
        ...existing.filter((entry) => entry.provider !== target.provider || entry.model !== target.model),
      ],
    }
  }

  replace('compactIfNeeded', original => async (agent, trigger, signal) => {
    // Only the pressure path is policy-driven; an explicit overflow recovery
    // must keep working with whatever the deployment configured.
    if (trigger === 'pressure') {
      try {
        await retune(agent, signal)
      } catch (error) {
        // A tuning failure must never stop compaction from running: the engine's
        // own threshold is still in force, so fall through to the original.
        ctx.logger?.warn?.(`${name}: could not resolve the routed context window: ${String(error?.message ?? error)}`)
      }
    }
    return original(agent, trigger, signal)
  })
}
