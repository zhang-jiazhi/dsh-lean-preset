// Fresh entry PATH, not just a fresh query: Node keys its ESM cache by resolved
// URL, so an edited same-path module keeps serving the old graph for the life of
// the host. Both this path and the versioned re-export URL below are new.
// 20260924-failed-compaction: a FAILED `compaction/end` (one carrying `error`,
// which never produces a `compaction/summary`) no longer resets the epoch. It
// used to re-narrow the catalog mid-conversation and make the model re-unlock
// tools it already had. Of the 48 failed compactions followed by another
// request, 15 changed the catalog; one session oscillated 20 -> 14 -> 20 six
// times. The catalog change is a correctness cost, not a cache cost (measured).
// The shared compaction-epoch.mjs import is versioned too, so this module graph
// cannot link against an older cached copy of that leaf.
export { name, inject, apply } from './tool-bootstrap.mjs?release=20260924-failed-compaction'
