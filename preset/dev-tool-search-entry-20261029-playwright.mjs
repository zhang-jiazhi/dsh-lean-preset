// 20261029-playwright: add the `playwright` bundle for the auto-mounted
// Playwright MCP family. The tools stay hidden until the bundle / exact name /
// wildcard is unlocked; a fresh entry + release URL bypasses ESM cache.
export { name, inject, apply, TOOL_BUNDLES, UNLOCKABLE_INDEX } from './dev-tool-search.mjs?release=20261029-playwright'
