/**
 * Epoch-aware promotion tracker shared by the bootstrap plugins of the
 * anchored presets. Copied verbatim from xiaobright/dsh-anchored-standard
 * (MIT; see NOTICE in this repository).
 *
 * A compaction rewrites the model-visible surface: the pre-compaction
 * conversation collapses into one synthetic summary message, and the
 * workspace-instruction baseline is re-injected from scratch. The first
 * post-compaction request is therefore a "second first request" — the same
 * first-token conditions the anchored presets exist to control. Promotion is
 * epoch-aware: only a durable promotion signal (`tool/call` and/or
 * `assistant/message`, per the caller's `promoteEvents`) recorded AFTER the
 * last `compaction/end` boundary counts as promoted. Before any compaction
 * the boundary is -1, which preserves the original one-shot semantics.
 *
 * State is memoized per session id and maintained incrementally through
 * `observe()`; a cold session scans its durable log once (so resume and
 * reload reconstruct the same phase), then O(1). Call `forget()` on
 * `session/disposed` so the memo does not outlive the sessions it describes.
 *
 * By default subagents (`delegationDepth > 0`) skip the bootstrap pair and enter
 * the lean resident phase on their first request. They still pass through the
 * resident/unlocked filter; only that child's own unlock log is considered.
 * Set `includeSubagents: true` to make subagents follow the same bootstrap/
 * anchor phase as top-level sessions.
 */

/**
 * Durable events of a session.
 *
 * MIGRATION STATUS (2026-09-15, target 0.1.6): `snapshotEvents` is deprecated
 * upstream — dsh-session marks it (and `eventAt`, `ownEvents`) with
 * "@deprecated Existing logic may remain unmigrated for now, but new calls are
 * prohibited" and points at the agent note
 * `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`.
 * That note is not published in the npm packages, and the intended replacement
 * seam (`ctx.sessionProjections`, dsh-session-projection) ships without an API
 * reference, so a rewrite here would be guesswork against an unverifiable
 * contract. The deprecated methods still exist and work in 0.1.6-alpha.1, which
 * is what makes deferring safe rather than broken.
 *
 * WHY IT CANNOT SIMPLY BE DROPPED: this read is the cold-start path — a resumed
 * session remounts the preset and must rebuild state (unlock set, team arming,
 * epoch) from the durable log, because historical events are not re-published to
 * `session/event` subscribers. Removing the read without a projection provider
 * would silently lose that state on every resume.
 *
 * A filter bug must not brick a session, so this returns an empty array rather
 * than throwing.
 */
export function sessionEvents(session) {
  if (session === undefined || session === null) return []
  try {
    const events = session.snapshotEvents()
    return Array.isArray(events) ? events : []
  } catch {
    return []
  }
}

/**
 * Whether one `compaction/end` actually replaced the conversation surface.
 *
 * The event fires on BOTH outcomes. Measured on the live store (2026-09-24,
 * 210 declared compactions across all sessions): 160 carry no `error` key at
 * all and always pair with a `compaction/summary`; 50 carry `error: <message>`
 * and NEVER produce a summary — the visible transcript is untouched and the
 * session simply retries. Restricted to the 28 real (non-test) sessions: 101
 * declared, 63 clean, 38 failed.
 *
 * Treating the failed half as a checkpoint boundary is not merely cosmetic. It
 * resets every piece of phase state the preset derives from a checkpoint: the
 * bootstrap epoch (this file), the once-per-session core-rule injection and
 * loaded-topic versions (rules-hybrid), and the loaded-skill versions
 * (skill-search). Over the real sessions the core block was re-sent 41 times
 * beyond the `1 + successful compactions` expectation (1,306 chars each,
 * ~330 tokens). `session-baa1e679` alone accounts for 21 of them.
 * It also re-narrows the tool catalog mid-conversation: of the 35 failed
 * compactions followed by another request, 13 changed the catalog (one session
 * oscillated 20 -> 14 -> 20 five times).
 *
 * The catalog change IS a cache cost whenever the new signature is novel to the
 * shared pool. Over the real sessions, pure-addition changes on the
 * cache-reusing routes kept only 0-10% of the prior cache (vs 97-99% on
 * unchanged steps) and paid a full re-read: 76,740-244,595 full-price input
 * tokens. An earlier controlled 4 -> 13 swap that looked penalty-free was an
 * artifact — that 13-tool signature had already been written by 151 other
 * sessions. A signature already present in the pool kept 41% of the cache
 * (n=15) while a never-seen signature kept 5% (n=29). Preventing catalog churn
 * is therefore worth more than a correctness argument alone would justify.
 *
 * Absence of the key is the success shape, so the test is `!== undefined`
 * rather than a truthiness check: a future `error: null` still means success.
 */
export function isFailedCompaction(event) {
  return event?.type === 'compaction/end' && event.data?.error !== undefined
}

/** Own durable events only; the Session owns the fork boundary. Same deprecated-read caveat as above. */
export function ownSessionEvents(session) {
  if (session === undefined || session === null) return []
  const events = session.ownEvents()
  if (!Array.isArray(events)) throw new TypeError('session.ownEvents() must return an array')
  return events
}

/** Build one epoch-aware promotion tracker. */
export function createEpochPromotion(promoteEvents, options = {}) {
  const includeSubagents = options.includeSubagents === true
  const promote = new Set(promoteEvents)
  /** sessionId -> { boundary, promoted } */
  const state = new Map()

  /** Scan a session's own durable log from scratch (cold start / resume). */
  const scan = (session) => {
    let boundary = -1
    let promoted = false
    // Own events only: a fork seed copies the parent's log, and a promotion
    // signal inherited from the parent must not promote the child.
    for (const event of ownSessionEvents(session)) {
      const seq = event?.seq
      // A failed compaction never replaced the surface, so the epoch must NOT
      // advance: the phase (and the catalog derived from it) has to look
      // exactly as it did before the attempt.
      if (event?.type === 'compaction/end') {
        if (isFailedCompaction(event)) continue
        boundary = seq
        promoted = false
        continue
      }
      if (promote.has(event?.type) && seq > boundary) promoted = true
    }
    const entry = { boundary, promoted }
    state.set(session.id, entry)
    return entry
  }

  return {
    /**
     * Current phase of the agent's session.
     * @param agent - the assembly/pre-step agent, or undefined outside an agent.
     * @returns { boundary, promoted } — `boundary` is the last compaction/end
     *   seq (-1 before any compaction); `promoted` is true when a durable
     *   promotion signal exists after that boundary.
     */
    status(agent) {
      if (agent === undefined) return { boundary: -1, promoted: true }
      const session = agent.session
      if (session === undefined) return { boundary: -1, promoted: true }
      // With includeSubagents disabled, subagents skip the bootstrap pair but
      // still receive only resident + their own explicitly unlocked tools.
      // This preset enables it, so children follow the normal bootstrap phase.
      if (!includeSubagents && (session.header?.delegationDepth ?? 0) > 0) return { boundary: -1, promoted: true }
      return state.get(session.id) ?? scan(session)
    },
    /** Incremental feed: call on every `session/event`. */
    observe(session, event) {
      const entry = state.get(session.id)
      if (entry === undefined) return
      const seq = event?.seq
      if (event?.type === 'compaction/end') {
        // Same rule as the cold scan above: only a real checkpoint is a
        // boundary. An errored compaction leaves phase state untouched.
        if (isFailedCompaction(event)) return
        state.set(session.id, { boundary: seq, promoted: false })
        return
      }
      if (promote.has(event?.type) && seq > entry.boundary && !entry.promoted) {
        state.set(session.id, { ...entry, promoted: true })
      }
    },
    /**
     * Drop one session's memoized phase (2026-09-04). Call from
     * `session/disposed`: without it this Map is append-only for the process
     * lifetime, and a long-lived host that delegates heavily accumulates one
     * dead entry per subagent — every `ralph` round leaves one behind. Phase is
     * always reconstructable from the durable log, so forgetting is safe: a
     * session that somehow reappears simply cold-scans once more.
     * @param sessionId - the disposed session's id.
     */
    forget(sessionId) {
      state.delete(sessionId)
    },
  }
}
