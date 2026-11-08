// Fresh entry PATH for the discovery tool: a same-path *.mjs stays ESM-cached
// for the life of the host, so the lean.patch.yml row points here instead of
// dev-tool-search.mjs directly.
//
// 20260923-163510: UNLOCKABLE_INDEX gains `batch` — the optional programmatic
// batch tool shipped by @local/dsh-lean-batch (runtime-injected, native
// presentation, no generated SDK). Also adds the CJK alias 批量→batch so a
// Chinese query reaches it. The index is inlined in this tool's own
// description, and tool-bootstrap does not import this module, so this row is
// the only entry that has to move.
export { name, inject, apply } from './dev-tool-search.mjs?release=20260923-163510'
