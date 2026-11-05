// New entry and import URL bypass cached implementations on new preset revisions.
// 20261017-audit-p0: the capability index now promises only families that the current
// 0.2.1 composition actually registers. The three MCP family lines (73 tools) were
// removed because the live catalog had no mcp__ tools at all — October unlock attempts
// spent 8 of 10 no-match rounds guessing those names. browser_*, session_*, terminal_*
// and the other live 0.2.1 families were added, and the description shrank from 3,034
// to 2,037 characters. The resident list and unlock semantics did not change.
export { name, inject, apply } from './dev-tool-search.mjs?release=20261017-auditp0'
