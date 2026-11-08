// Fresh entry PATH, not just a fresh query: Node keys its ESM cache by resolved
// URL, so an edited same-path module keeps serving the old graph for the life of
// the host. Both this path and the versioned re-export URL below are new.
// 20260923-110853: unlock resolution is now shared with dev_tool_search through
// ./tool-name-resolver.mjs, so an exact MCP tool name resolves exactly and an
// unknown exact name no longer degrades into its prefix group.
export { name, inject, apply } from './tool-bootstrap.mjs?release=20260923-110853'
