// 20261025-defer: opt-in provider-side deferred loading for non-resident
// unlocked tools. DeepSeek Messages (toolUpdate addition-only) honors the
// deferLoading flag; OpenAI-compatible completions routes strip it and keep
// full schemas. Fresh entry PATH + release URL so a running host does not keep
// the prior tool-bootstrap graph.
export { name, inject, apply } from './tool-bootstrap.mjs?release=20261025-defer'
