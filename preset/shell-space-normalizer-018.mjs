// Fresh entry PATH for the corrected shell wrapper. The previous entry pointed
// at a module whose command text was silently rewritten; Node would keep
// serving that cached graph from the same URL, so the fix needs a new path and
// a versioned implementation import below.
// 20260923-110853: the unconditional Unicode-space replacement is gone. The
// wrapper now forwards the caller's request and the resolved spec unchanged.
export { name, inject, apply } from './shell-space-normalizer-017.mjs?release=20260923-110853'
