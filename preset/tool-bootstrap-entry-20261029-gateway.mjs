// 20261029-gateway: stable core + tool_gateway. Dynamic registrations are hidden
// by a step-time `when` gate; the gateway resolves a private catalog and calls
// through ctx.tools.execute() so policy/approval/guards stay intact. Fresh
// entry PATH + release URL bypass the running host's ESM cache.
export { name, inject, apply } from './tool-bootstrap.mjs?release=20261029-gateway'
