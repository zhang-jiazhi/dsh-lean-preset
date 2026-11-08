// A new module URL lets a new standing mount bypass earlier ESM cache entries.
// 20260924-failed-compaction: only a real checkpoint (no `error` on
// `compaction/end`) re-arms the once-per-session core injection and drops
// loaded topic versions. A retry used to re-send the whole core block; measured
// 42 such re-sends beyond the `1 + successful compactions` expectation over the
// real sessions.
export { name, inject, apply } from './rules-hybrid.mjs?release=20260924-failed-compaction'
