// Fresh entry PATH for the discovery tool: a same-path *.mjs stays ESM-cached
// for the life of the host, so the lean.patch.yml row points here instead of
// dev-tool-search.mjs directly.
//
// 20260923-165050: the Usage line no longer says to search first and unlock
// "then". Passing `query` and `toolNames` in the SAME call is both supported
// (execute handles both fields in one run: unlock lines, then matches) and is
// now the documented path — it saves the model a full round per unlock.
export { name, inject, apply } from './dev-tool-search.mjs?release=20260923-165050'
