// 20261024-unlockbudget: assembly replays the RAW tool/call unlock arguments, so
// the per-call unlock budget is applied on this side too (via the shared
// tool-name-resolver.mjs) — otherwise discovery would report a deferred family
// while the assembled catalog still carried all 207 schemas. Fresh entry PATH +
// versioned re-export URL so a running host picks up the new module graph.
export { name, inject, apply } from './tool-bootstrap.mjs?release=20261024-unlockbudget'
