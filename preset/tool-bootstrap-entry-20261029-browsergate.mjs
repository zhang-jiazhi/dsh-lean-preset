// 20261029-browsergate: Playwright MCP tools are registered in an agent-scoped
// MCP child scope, which ctx.tools.restrict() cannot mask. Keep the provider
// auto-mounted, attach a step-time `when` condition to those tools, and let an
// explicit dev_tool_search unlock reveal them on the next step. Fresh entry PATH
// + release URL so a running host does not keep the previous module graph.
export { name, inject, apply } from './tool-bootstrap.mjs?release=20261029-browsergate'
