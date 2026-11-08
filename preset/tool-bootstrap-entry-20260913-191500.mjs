// A NEW entry PATH (not just a new query) is required: Node keys its ESM cache by
// resolved URL, so rewriting the same entry file keeps serving the old module
// graph. This path + the versioned re-export URL below are both fresh.
// 20260913-191500: explicit Agent Team requests pre-unlock the Team tool set on
// the turn's FIRST request. The arming signal is the durable
// `agent/inbox/spliced` event, because dsh-agent-loop runs
// inbox.claim() -> systemPrompt.assemble() -> session.append('user/message'):
// at assembly time the instruction is in neither the inbox nor the log, so
// reading only logged user/message silently missed the whole first turn.
// Sticky across follow-up turns, compaction and resume.
export { name, inject, apply } from './tool-bootstrap.mjs?release=20260913-191500'
