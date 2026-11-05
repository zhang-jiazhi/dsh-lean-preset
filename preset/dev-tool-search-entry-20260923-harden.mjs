// A fresh module path and release URL bypass the host's ESM cache.
// 20260923-harden: index lists workflow / present; str_replace_editor entry no
// longer promises multi-replacement it does not have.
export { name, inject, apply } from './dev-tool-search.mjs?release=20260923-harden'
