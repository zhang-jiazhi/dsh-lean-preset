// Fresh entry PATH + versioned re-export URL: the host otherwise keeps the
// already-imported compaction-refill-guard.mjs for its lifetime.
// 20261017-audit-p2 adds the consecutive "summary is not smaller than the
// shadowed content" circuit breaker (NoProgressError). Without the new URL a
// running host would keep retrying the same region for minutes.
export { name, inject, apply, RapidRefillError, NoProgressError, MAX_SUMMARY_STALLS } from './compaction-refill-guard.mjs?release=20261017-auditp2'
