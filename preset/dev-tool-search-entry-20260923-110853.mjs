// Fresh entry PATH for the paginated, exact-first discovery tool. The resolver
// is shared with tool-bootstrap, so both must ship together.
// 20260923-110853: exact MCP names resolve exactly; search results are paged
// with offset/limit and a replayable next-page hint.
export { name, inject, apply } from './dev-tool-search.mjs?release=20260923-110853'
