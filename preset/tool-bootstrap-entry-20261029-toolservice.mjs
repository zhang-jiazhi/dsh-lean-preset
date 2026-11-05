// 20261029-toolservice: dsh 0.2.2 changed tool admission to tools.resolve()
// + ctx.tools.restrict(). tool-bootstrap intentionally has no inject:['tools'],
// so reading ctx.tools threw "cannot get property tools without inject" and
// left the catalog snapshot empty. Read ctx.get('tools') instead, refresh the
// snapshot at each step end so dynamically registered tools are visible, and
// keep the 0.2.1/test assembly-payload narrowing branch. Fresh entry PATH +
// release URL so a running host does not keep the previous graph.
export { name, inject, apply } from './tool-bootstrap.mjs?release=20261029-toolservice'
