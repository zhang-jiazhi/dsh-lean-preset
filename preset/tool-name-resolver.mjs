/**
 * Resolve case-sensitive unlocks identically in discovery and assembly.
 *
 * 20260930-recall: auto-resolution moved HERE from the discovery tool.
 * It used to live only in dev-tool-search.mjs, which meant discovery could
 * announce an unlock that tool-bootstrap.mjs (the actual assembly) would never
 * grant — the two sides resolve from this same module precisely to avoid that
 * class of lie. Anything that decides "this name resolves" must be shared.
 */

/**
 * Per-call unlock budget (20261024-unlockbudget).
 *
 * A bare MCP server name or a trailing `*` expands to a whole family in ONE
 * string. Measured on 326 real lean unlock calls: the median unlock adds ~972
 * schema chars, but on 2026-10-22 `toolNames: ["mcp__rea"]` expanded to 207
 * tools / 832,137 chars (about 208k tokens) and every later request of that
 * session carried the whole block — 4 requests were 16.7% of all tool-schema
 * chars in three weeks of lean sessions. One short string must not be able to
 * buy an unbounded per-request prefix.
 *
 * Group expansions therefore have to fit this budget or they are DEFERRED
 * WHOLE (never partially, never alphabetically truncated): a partial family is
 * both useless (the task needs specific members) and still expensive. Exact
 * names are always honoured — naming one tool is informed intent, and the
 * discovery tool reports the cost of anything large.
 *
 * Discovery (dev-tool-search.mjs) and assembly (tool-bootstrap.mjs) both
 * resolve through THIS function, so the budget has to live here: assembly
 * replays raw tool/call arguments, and a cap that only hid names from the model
 * would leave the real catalog unbounded.
 */
export const UNLOCK_BUDGET = { maxTools: 64, maxChars: 60000 }

/**
 * Coarse bucket for schema cost. Discovery sees `registry.schemas(scope)` and
 * assembly sees `SystemPromptAssembly.tools`; both are ToolSchema, but a
 * one-byte serialization difference must never flip which tools fit. Bucketing
 * at 200 chars absorbs that difference while staying within 1% of the true
 * size on any realistic family (inflation matters: rounding every 700-char
 * tool up to a 2,000 bucket would have pushed a legitimate 47-tool Playwright
 * family over a 60k budget).
 */
const SIZE_BUCKET = 200
const bucketOf = (value) => Math.round(Math.max(0, Number(value) || 0) / SIZE_BUCKET) * SIZE_BUCKET

/**
 * Model-visible schema cost, using an explicit projection so two call sites
 * holding different tool objects cannot disagree about the same tool.
 */
export function schemaChars(tool) {
  if (tool === null || typeof tool !== 'object') return 0
  try {
    return JSON.stringify({
      name: tool.name ?? '',
      description: tool.description ?? '',
      parameters: tool.parameters ?? null,
    }).length
  } catch {
    return 0
  }
}

/**
 * Build the `sizeOf` callback both call sites pass to `resolveToolNames`.
 * Lazy on purpose: the common request unlocks nothing, so nothing is serialized;
 * only the members of an actual group expansion are measured, once each.
 */
export function schemaSizer(tools) {
  const byName = new Map()
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool && typeof tool.name === 'string') byName.set(tool.name, tool)
  }
  const cache = new Map()
  return (name) => {
    if (cache.has(name)) return cache.get(name)
    const chars = schemaChars(byName.get(name))
    cache.set(name, chars)
    return chars
  }
}

/** 832137 -> "832k"; used in model-facing budget messages. */
export const formatChars = (value) => (value >= 1000 ? `${Math.round(value / 1000)}k` : String(value))

/** Dice coefficient over character bigrams — catches transpositions
 *  (memory_serach → memory_search) that exact-part matching misses. */
const bigramDice = (a, b) => {
  const bigrams = (s) => {
    const set = new Set()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const sa = bigrams(a.toLowerCase())
  const sb = bigrams(b.toLowerCase())
  if (sa.size === 0 || sb.size === 0) return 0
  let shared = 0
  for (const gram of sa) if (sb.has(gram)) shared += 1
  return (2 * shared) / (sa.size + sb.size)
}

const nameParts = (value) => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/**
 * Resolve a name the model guessed but that is not in the catalog.
 *
 * Returns null whenever the choice is not clearly unambiguous — a wrong pick
 * costs more than a suggestion round (an MCP family can contain both read and
 * write variants). Rules:
 *   · non-MCP: unique prefix (exa → exa_search), or a similarity that clearly
 *     leads (absolute gap ≥0.08, relative ≥1.15, or a very high 0.75);
 *   · MCP: only when ≥2 distinguishing words are shared and the leader is
 *     strictly ahead — a single shared generic word ("issue") must NOT pick a
 *     tool, or a typo could silently select a write-side tool;
 *   · never for wildcards.
 */
export function autoResolveName(missing, catalogNames) {
  if (typeof missing !== 'string' || missing.length === 0) return null
  if (missing.endsWith('*')) return null

  if (missing.startsWith('mcp__')) {
    const segments = missing.split('__')
    if (segments.length < 3) return null
    const family = catalogNames.filter((candidate) => candidate.startsWith(`mcp__${segments[1]}__`))
    const wanted = new Set(nameParts(segments.slice(2).join('_')))
    const scored = family
      .map((candidate) => ({
        candidate,
        overlap: nameParts(candidate.split('__').slice(2).join('_')).filter((part) => wanted.has(part)).length,
      }))
      .filter((entry) => entry.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || a.candidate.localeCompare(b.candidate))
    if (scored.length === 0) return null
    if (scored[0].overlap < 2) return null
    if (scored.length === 1) return { name: scored[0].candidate, reason: '族内共享词' }
    if (scored[0].overlap > scored[1].overlap) return { name: scored[0].candidate, reason: '族内共享词最多' }
    return null
  }

  const others = catalogNames.filter((candidate) => !candidate.startsWith('mcp__') && candidate !== missing)
  const prefixed = others.filter((candidate) => candidate.startsWith(missing))
  if (prefixed.length === 1) return { name: prefixed[0], reason: '唯一前缀' }
  const scored = others
    .map((candidate) => ({ candidate, dice: bigramDice(missing, candidate) }))
    .sort((a, b) => b.dice - a.dice || a.candidate.localeCompare(b.candidate))
  const best = scored[0]
  const second = scored[1]
  if (best === undefined || best.dice < 0.6) return null
  if (second === undefined) return { name: best.candidate, reason: '唯一候选' }
  const absolute = best.dice - second.dice
  const relative = second.dice === 0 ? Infinity : best.dice / second.dice
  if (absolute >= 0.08 || relative >= 1.15 || best.dice >= 0.75) {
    return { name: best.candidate, reason: '最接近' }
  }
  return null
}

/**
 * Resolve unlock names against the real catalog, in one shared place.
 *
 * `options.sizeOf(name)` returns the model-visible schema chars of one tool
 * (both call sites build it with `schemaSizer`). Without it only the tool-count
 * cap applies; the production call sites always pass it.
 *
 * Returns `deferred`: group expansions (`mcp__server`, `mcp__server__*`,
 * `dev_*`) that matched real tools but do not fit the per-group budget on their
 * own. Nothing from a deferred group is unlocked, so a caller that ignores the
 * field still never exceeds the budget.
 */
export function resolveToolNames(rawNames, catalogNames, options = {}) {
  const names = Array.isArray(catalogNames) ? catalogNames : []
  const available = new Set(names)
  const budgetOptions = options && typeof options === 'object' ? options.budget : undefined
  const budget = { ...UNLOCK_BUDGET, ...(budgetOptions && typeof budgetOptions === 'object' ? budgetOptions : {}) }
  const sizeOf = options && typeof options.sizeOf === 'function' ? options.sizeOf : null
  const size = (name) => (sizeOf === null ? 0 : bucketOf(sizeOf(name)))
  const costOf = (list) => list.reduce((total, name) => total + size(name), 0)

  const resolved = new Set()
  const missing = new Set()
  const autoResolved = []
  const deferred = []

  for (const raw of rawNames) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    // Exact catalog members win even when their name resembles an MCP group.
    // Naming one specific tool is informed intent: never budget it away.
    if (available.has(raw)) {
      resolved.add(raw)
      continue
    }
    let prefix
    if (raw.endsWith('*')) prefix = raw.slice(0, -1)
    // A complete MCP name has another "__" delimiter, not a bare server name.
    else if (/^mcp__[A-Za-z0-9_-]+$/.test(raw) && raw.slice(5).includes('__') === false) prefix = `${raw}__`
    const hits = prefix === undefined ? [] : names.filter((name) => name.startsWith(prefix))
    if (hits.length > 0) {
      const pending = hits.filter((name) => resolved.has(name) === false)
      const addTools = pending.length
      const addChars = costOf(pending)
      // Per GROUP, never cumulative across the call: assembly resolves the union of
      // every unlock name a session ever recorded, so a cumulative budget would
      // defer family #3 in a long session and shrink its catalog mid-flight — the
      // exact churn this preset works to avoid. Per-group also keeps the decision
      // independent of how many calls the model split the work into.
      if (addTools <= budget.maxTools && addChars <= budget.maxChars) {
        for (const name of pending) resolved.add(name)
      } else {
        // Whole group or nothing: a partial family is useless to the model and
        // still contaminates every later request with unused schemas.
        deferred.push({ from: raw, names: pending, tools: addTools, chars: addChars, budget })
      }
      continue
    }
    // 20260930-recall: not resolvable as written — try an unambiguous near-miss
    // in THIS module so discovery and assembly always agree on the outcome.
    const auto = autoResolveName(raw, names)
    if (auto !== null) {
      resolved.add(auto.name)
      autoResolved.push({ from: raw, to: auto.name, reason: auto.reason })
      continue
    }
    missing.add(raw)
  }
  return { resolved: [...resolved], missing: [...missing], autoResolved, deferred, budget }
}
