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
const originalWhen = new WeakMap()

/** Mark one definition as intentionally gateway-visible. */
export const markGatewayEligible = (definition, when) => {
  if (definition === null || typeof definition !== 'object') return
  eligible.add(definition)
  if (typeof when === 'function') originalWhen.set(definition, when)
  else originalWhen.delete(definition)
}

/** Whether tool-bootstrap deliberately hid this definition from the model. */
export const isGatewayEligible = (definition) =>
  definition !== null && typeof definition === 'object' && eligible.has(definition)

/** The definition's original admission condition, if it had one. */
export const originalWhenFor = (definition) =>
  definition !== null && typeof definition === 'object' ? originalWhen.get(definition) : undefined
