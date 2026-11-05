// A fresh module path and release URL bypass the host's ESM cache.
// 20260923-review: exact-name unlock needs no query; combined search does not
// suggest another unlock after processing toolNames.
export { name, inject, apply } from './dev-tool-search.mjs?release=20260923-review'
