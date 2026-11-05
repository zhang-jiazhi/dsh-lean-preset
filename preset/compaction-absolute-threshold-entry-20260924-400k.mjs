// Fresh entry PATH, not just a fresh query: Node keys its ESM cache by resolved
// URL, so an edited same-path module keeps serving the old graph for the life of
// the host. Both this path and the versioned re-export URL below are new.
// 20260924-400k: the preset's trigger moves from 200k to 400k and the verbatim
// tail from 60k to 80k. The 150-200k knee still minimises token cost, but every
// extra summary also pays a prefix rewrite and risks dropping detail, so 400k
// keeps ~74% of the old 600k ratio cost while halving the disruption. The
// module's own DEFAULT_* constants now match what lean.patch.yml mounts, so a
// config-less mount cannot silently fall back to a different documented policy.
export { name, inject, apply } from './compaction-absolute-threshold.mjs?release=20260924-400k'
