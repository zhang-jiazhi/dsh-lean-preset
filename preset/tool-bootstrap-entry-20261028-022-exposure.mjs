// 20261028-022-exposure: dsh 0.2.2 moved tool admission out of the
// system-prompt/assemble waterfall (`tools.resolve()` runs first, the payload has
// no `tools`), so the bootstrap filter crashed on `assembled.tools.map`.
// Narrowing now goes through `ctx.tools.restrict({ deny })` at turn/step
// boundaries, and dev_tool_search indexes a shared unrestricted catalog
// snapshot (catalog-cache.mjs). Fresh entry PATH + release URL so a running host
// does not keep the previous tool-bootstrap graph.
export { name, inject, apply } from './tool-bootstrap.mjs?release=20261028-022-exposure'
