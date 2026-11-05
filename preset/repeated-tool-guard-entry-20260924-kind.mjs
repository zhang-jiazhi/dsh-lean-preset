// Fresh entry PATH and query: the previous revision was imported from
// ./repeated-tool-guard.mjs, whose resolved URL the host has already cached, so
// an edited same-path module would keep serving the old graph. The change is
// the admitted v4 source kind (`plugin:<name>`, not `{ kind: 'plugin' }`).
export { name, apply } from './repeated-tool-guard.mjs?release=20260924-kind'
