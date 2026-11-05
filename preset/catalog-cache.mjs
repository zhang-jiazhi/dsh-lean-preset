/**
 * Shared catalog cache for the lean preset (0.2.2 exposure split).
 *
 * Why this file exists
 * --------------------
 * dsh 0.2.2 resolves a step's tool set BEFORE system-prompt assembly
 * (`tools.resolve()` → `systemPrompt.assemble({ toolSet })`), and the payload
 * handed to the `system-prompt/assemble` waterfall no longer carries `tools`
 * at all. Narrowing therefore happens through `ctx.tools.restrict({ deny })`,
 * whose masks also hide the restricted tools from `tools.schemas(agent)` — the
 * very source `dev_tool_search` needs in order to search and unlock them.
 *
 * The fix is a per-session snapshot: tool-bootstrap lifts its own restriction
 * at `turn/start` (before any resolve), reads the full catalog once, re-applies
 * the restriction, and parks the snapshot here. `dev_tool_search` reads the
 * same snapshot instead of calling `schemas(agent)`, so the index keeps showing
 * every registered tool while the model only sees the admitted subset.
 *
 * Plain relative module, no external imports: preset files resolve from
 * ~/.dsh/.agent-presets/lean, where only `@local/dsh-agent-preset-lean` (the
 * link target) is reachable. Keep it dependency-free.
 */

/** sessionId -> array of { name, description, parameters } snapshots. */
const bySession = new Map()

/**
 * Record the catalog snapshot read for one session.
 * @param sessionId - durable Session id.
 * @param tools - model-facing schemas captured while unrestricted.
 */
export const rememberCatalog = (sessionId, tools) => {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return
  if (!Array.isArray(tools)) return
  bySession.set(sessionId, tools)
}

/**
 * Read the last recorded snapshot for one session.
 * @param sessionId - durable Session id.
 * @returns the snapshot, or undefined when none was recorded yet.
 */
export const catalogFor = (sessionId) => bySession.get(sessionId)

/**
 * Drop the snapshot when its session leaves the store.
 * @param sessionId - durable Session id.
 */
export const forgetCatalog = (sessionId) => {
  bySession.delete(sessionId)
}
