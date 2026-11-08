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
 * `base` must be the route's EFFECTIVE policy (its own exact entry merged over
 * the global config). Passing the global ratio would ignore a route that already
 * ticks lower than the budget and raise it to the plugin's ratio.
 *
 * @param {{ thresholdTokens: number, retainTokens: number, minWindowTokens: number }} options - resolved config.
 * @param {number} contextWindow - the route's live context window.
 * @param {number} reservedTokens - completion tokens this route's request reserves.
 * @param {{ thresholdRatio?: number, headroomTokens?: number }} base - effective route policy.
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
  /** Last fields written per route, so an unchanged decision does not churn the config array. */
  const applied = new Map()
  /**
   * Per-route snapshot of the fields this plugin may write, taken BEFORE the
   * first rewrite. `existed` is false when the route had no exact policy.
   *
   * Reverting is FIELD-LEVEL, not a whole-entry restore: an external change to
   * the summarization route (or any other field we do not own) made while the
   * plugin is active must survive both the "no longer needs tuning" revert and
   * plugin disposal. A field is restored only while its current value still
   * equals the value this plugin wrote.
   */
  const originals = new Map()

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
        // The policy edits live in `engine.config`, not in the method wrapper,
        // so unloading must undo them explicitly.
        restorePolicies()
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
   *
   * The entry this plugin writes is a MERGE over the route's original exact
   * policy: only `thresholdRatio` and `retainTokens` are ours, and `retainRatio`
   * is dropped because the engine rejects an entry carrying both retention
   * forms. Everything else (summarizationProvider/Model, headroomTokens,
   * maxTokens, retries) is preserved. The "only lower" comparison uses the
   * route's EFFECTIVE ratio, not the global one: a route already ticking at
   * 0.2 must not be raised to the plugin's ratio just because the global
   * default is higher.
   */
  const retune = async (agent, signal) => {
    const existing = engine.config.modelPolicies
    if (!Array.isArray(existing)) return
    const target = targetOf(agent)
    if (target === undefined) return
    const window = await windowFor(target, signal)
    if (window === undefined) return
    const key = `${target.provider}\u0000${target.model}`
    const sameRoute = (entry) => entry?.provider === target.provider && entry?.model === target.model
    const current = existing.find(sameRoute)
    if (!originals.has(key)) {
      originals.set(key, {
        existed: current !== undefined,
        thresholdRatio: current?.thresholdRatio,
        retainTokens: current?.retainTokens,
        retainRatio: current?.retainRatio,
        headroomTokens: current?.headroomTokens,
      })
    }
    const original = originals.get(key)
    const last = applied.get(key)
    // If the route's threshold no longer equals what this plugin wrote, an
    // external change owns it now: use the live value as the "only lower" base.
    const liveRatio = Number.isFinite(current?.thresholdRatio) && current.thresholdRatio > 0
      && (last === undefined || current.thresholdRatio !== last.thresholdRatio)
      ? current.thresholdRatio
      : undefined
    const originalRatio = Number.isFinite(original.thresholdRatio) && original.thresholdRatio > 0
      ? original.thresholdRatio
      : undefined
    const base = {
      thresholdRatio: liveRatio ?? originalRatio ?? engine.config.thresholdRatio,
      headroomTokens: Number.isSafeInteger(current?.headroomTokens) && current.headroomTokens >= 0
        ? current.headroomTokens
        : Number.isSafeInteger(original.headroomTokens) && original.headroomTokens >= 0
          ? original.headroomTokens
          : engine.config.headroomTokens,
    }
    const policy = policyFor(options, window, target.maxTokens, base)
    if (policy === undefined) {
      // The route's own effective trigger is already at or below the budget.
      // Nothing was written → leave it alone; otherwise undo only our fields.
      if (!applied.has(key)) {
        originals.delete(key)
        return
      }
      undoRoute(key)
      return
    }
    if (last !== undefined && last.thresholdRatio === policy.thresholdRatio && last.retainTokens === policy.retainTokens) return
    // Merge over the CURRENT entry, not the stale snapshot: external edits to
    // summarization/retries made since the plugin wrote are preserved.
    const next = {
      ...(current ?? {}),
      provider: target.provider,
      model: target.model,
      thresholdRatio: policy.thresholdRatio,
      retainTokens: policy.retainTokens,
    }
    delete next.retainRatio
    applied.set(key, { thresholdRatio: next.thresholdRatio, retainTokens: next.retainTokens })
    const modelPolicies = []
    let placed = false
    for (const entry of existing) {
      if (!placed && sameRoute(entry)) {
        modelPolicies.push(next)
        placed = true
      } else {
        modelPolicies.push(entry)
      }
    }
    if (!placed) modelPolicies.unshift(next)
    engine.config = { ...engine.config, modelPolicies }
  }

  /**
   * Undo the fields this plugin still owns for one route. A field changed by a
   * later external edit is left alone; other external fields are always kept.
   */
  const undoRoute = (key) => {
    const last = applied.get(key)
    if (last === undefined) return
    const existing = engine.config.modelPolicies
    if (!Array.isArray(existing)) {
      applied.delete(key)
      originals.delete(key)
      return
    }
    const separator = key.indexOf('\u0000')
    const provider = key.slice(0, separator)
    const model = key.slice(separator + 1)
    const index = existing.findIndex((entry) => entry?.provider === provider && entry?.model === model)
    const original = originals.get(key) ?? {}
    applied.delete(key)
    originals.delete(key)
    // The route entry was removed externally; our fields went with it.
    if (index < 0) return
    const current = existing[index]
    const next = { ...current }
    let owned = false
    if (current.thresholdRatio === last.thresholdRatio) {
      if (original.thresholdRatio === undefined) delete next.thresholdRatio
      else next.thresholdRatio = original.thresholdRatio
      owned = true
    }
    if (current.retainTokens === last.retainTokens) {
      delete next.retainTokens
      if (original.retainTokens !== undefined) next.retainTokens = original.retainTokens
      else if (original.retainRatio !== undefined) next.retainRatio = original.retainRatio
      owned = true
    }
    // Every field we wrote was replaced externally: keep the external entry.
    if (!owned) return
    const copy = existing.slice()
    const remaining = Object.keys(next).filter((field) => field !== 'provider' && field !== 'model')
    if (!original.existed && remaining.length === 0) copy.splice(index, 1)
    else copy[index] = next
    engine.config = { ...engine.config, modelPolicies: copy }
  }

  /** Undo every field this plugin still owns (used on disposal). */
  const restorePolicies = () => {
    for (const key of [...applied.keys()]) undoRoute(key)
    applied.clear()
    originals.clear()
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
