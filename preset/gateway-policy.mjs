/**
 * Shared eligibility marker for the LEAN gateway.
 *
 * tool-bootstrap marks the definitions it intentionally hides for cache/context
 * purposes. tool-gateway only exposes marked definitions, so it cannot become a
 * generic bypass for tools another plugin restricted for security or
 * availability. Definitions carrying their own `when` condition stay excluded:
 * the gateway has no step-level modelSelection context to truthfully re-evaluate
 * them.
 */
const eligible = new WeakSet()
/**
 * Eligibility that depends on the CALLING Agent. LEAN hides a different catalog
 * per Agent (top-level vs a delegation child), so "hidden from the model" is a
 * per-Agent fact. A global marker made the child's gateway reject `subagent`
 * because the parent's resident list kept it out of the hidden set.
 */
const eligibleByAgent = new WeakMap()
const originalWhen = new WeakMap()

/** Mark one definition as intentionally gateway-visible (globally or for one Agent). */
export const markGatewayEligible = (definition, when, agent) => {
  if (definition === null || typeof definition !== 'object') return
  if (agent === undefined || agent === null) {
    eligible.add(definition)
  } else {
    let scoped = eligibleByAgent.get(agent)
    if (scoped === undefined) {
      scoped = new WeakSet()
      eligibleByAgent.set(agent, scoped)
    }
    scoped.add(definition)
  }
  if (typeof when === 'function') originalWhen.set(definition, when)
  else originalWhen.delete(definition)
}

/**
 * Drop a per-Agent mark when the tool becomes resident again (for example
 * `subagent` after promotion). Without this, a tool hidden during bootstrap
 * would stay gateway-reachable while also being directly visible, and the
 * gateway's own "resident tools are not gateway tools" rule would be false.
 */
export const unmarkGatewayEligible = (definition, agent) => {
  if (definition === null || typeof definition !== 'object') return
  if (agent === undefined || agent === null) return
  eligibleByAgent.get(agent)?.delete(definition)
}

/** Whether tool-bootstrap deliberately hid this definition from the given Agent. */
export const isGatewayEligible = (definition, agent) => {
  if (definition === null || typeof definition !== 'object') return false
  if (eligible.has(definition)) return true
  return agent !== undefined && agent !== null && eligibleByAgent.get(agent)?.has(definition) === true
}

/** The definition's original admission condition, if it had one. */
export const originalWhenFor = (definition) =>
  definition !== null && typeof definition === 'object' ? originalWhen.get(definition) : undefined
