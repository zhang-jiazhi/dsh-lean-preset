// Fresh entry PATH, not just a fresh query: Node keys its ESM cache by resolved
// URL, so an edited same-path module keeps serving the old graph for the life of
// the host. Both this path and the versioned re-export URL below are new.
// 20260924-compaction-catalog: after a compaction the catalog is the compaction
// work set PLUS the session's own unlocks — identical to the promoted catalog —
// so the tool list does not shrink and regrow across the checkpoint and the
// model is not made to unlock the same tools twice (a correctness cost; the
// catalog change was measured NOT to invalidate the provider prefix cache).
export { name, inject, apply } from './tool-bootstrap.mjs?release=20260924-compaction-catalog'
