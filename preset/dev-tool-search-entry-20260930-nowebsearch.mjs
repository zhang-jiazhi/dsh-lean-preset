// New entry and import URL bypass cached implementations on new preset revisions.
// 20260930-nowebsearch: the built-in web_search is no longer registered (the preset's
// tool-web row now carries `search: false`), so its index line is gone with it —
// the index must never promise a tool the composition does not provide.
// Only the index text changed in this revision; nothing else moved.
export { name, inject, apply } from './dev-tool-search.mjs?release=20260930-nowebsearch'
