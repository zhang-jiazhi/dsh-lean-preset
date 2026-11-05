// A distinct entry and module URL avoid reusing an earlier loaded skill plugin.
// 20260924-failed-compaction: a failed compaction no longer clears loaded-skill
// versions, so a body still present in the transcript is not re-delivered.
export { name, inject, apply } from './skill-search.mjs?release=20260924-failed-compaction'
