// 20261029-stable: one fixed-schema gateway for every on-demand LEAN tool.
// The resident core stays visible; dynamic registrations are hidden with the
// 0.2.2 step-time `when` gate and invoked through ctx.tools.execute() so
// policy/approval/guards still run. Fresh entry + release URL bypass ESM cache.
export { name, inject, apply } from './tool-gateway.mjs?release=20261029-stable'
