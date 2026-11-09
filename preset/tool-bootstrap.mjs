/**
 * Anchored tool bootstrap — `anchored-flash` 定制版
 *
 * 移植自 xiaobright/dsh-anchored-standard 的 preset/tool-bootstrap.mjs
 * （MIT；上游 NOTICE 见本仓库根目录 NOTICE 文件）。
 * 相对上游的本地定制：
 *
 *  1. residentTools 配置化：晋升后只保留 lean.patch.yml 白名单 +
 *     经 tool_gateway 调用的工具（核心常驻，动态工具在私有目录）。
 *  2. includeSubagents 可配置：默认 true（子代理也走锚定）；本预设
 *     显式保持 true，确保每个子代理从 bootstrap 工具对独立开始，
 *     不继承父会话的阶段或已解锁工具。
 *  3. persona/contexts 全程 Minimal：无论是否晋升，system prompt 都
 *     只有 bootstrapPersona 单句；runtime contexts 只保留 allowlist 中的
 *     非空策略事实，plan-mode 激活时保留非空的 plan:policy 段。
 *  4. bootstrapPersona 可配置：默认官方 Minimal 句。
 *  5. 暴露机制只保留 resolve（2026-10-31）：删除 0.2.1 的 gate 回退路径
 *     （step-time `when` 隐藏 + `restrict({deny})` 掩码 + lift 重试）。
 *     线上从未启用 gate；保留两套语义只会积累分叉。`exposureMode`
 *     因此不再是合法配置键。
 *
 * 保留的上游机制（社区实测验证，issues #6/#11/#19/#32）：
 *  - 首轮工具目录 = bootstrapTools（Minimal 真 schema：持久 bash +
 *    str_replace_editor；Windows 下 bash 由 custom-bash.mjs 提供）；
 *  - 晋升信号 = 首次持久 tool/call 或 assistant/message（promoteOn:
 *    either，先到者为准），状态从持久 session 事件推导，resume/reload
 *    保持；请求 #1 恒为 bootstrap 目录，请求 #2 起恒为 resident；
 *  - pre-step 注入剥离（suppressedContextSources，默认 skill-catalog +
 *    agent-instructions），晋升后恢复；用户主动的 skill 手势不过滤；
 *  - bootstrapMaxTokens 可选封顶：rc.6 prebuilt profile 包可能被
 *    adapterDefaults.maxTokens 覆盖（issue #11），不生效也无害；
 *  - compaction epoch：compaction/end 后回退受控阶段（bootstrap 对 +
 *    compactionTools 核心工作集），越过边界后重新晋升；
 *  - 工具目录过滤失败时明确报错，绝不回退到全目录；上下文消息过滤
 *    失败时保留消息并告警。非法配置在 preset 挂载时报错。
 */

import { createEpochPromotion, ownSessionEvents } from './compaction-epoch.mjs?release=20260924-failed-compaction'
import { resolveToolNames, schemaSizer } from './tool-name-resolver.mjs?release=20261024-unlockbudget'
import { catalogFor, forgetCatalog, rememberCatalog } from './catalog-cache.mjs?release=20261028-022-exposure'
import { markGatewayEligible, unmarkGatewayEligible } from './gateway-policy.mjs?release=20261106-fixes'
import { sleepGuardReason, writeGuardReason } from './write-guard.mjs?release=20261101-writeguard2'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-tool-bootstrap'

/**
 * Deliberately NO inject list: the listeners only touch services at event
 * time. Applying without an inject — combined with this row being FIRST in
 * lean.patch.yml — registers the plugin before dsh-agent-instructions and
 * dsh-tool-skill, and waterfall after-next transforms apply in reverse
 * registration order, so the first-request strip below is the LAST transform.
 * With an inject here those plugins register first and re-inject their
 * messages after the strip. The pre-step listener additionally registers with
 * `prepend: true` so the strip stays the outermost transform even against
 * host-plane listeners and future row reordering.
 */
export const inject = []

/**
 * Process-wide resolve registry, shared by every generation of this module.
 *
 * `lean.patch.yml` imports the implementation through a release URL so a source
 * edit reaches the next assembly without a host restart. That creates a SECOND
 * module instance: its `WeakMap` state table is fresh, while the `tools.resolve`
 * wrapper installed by the previous generation still closes over the OLD table.
 * The wrapper then found no state for the new Agent and threw
 * "LEAN resolve exposure state is unavailable", making a hot-updated session
 * unusable until the process restarted.
 *
 * The table therefore lives on `globalThis` behind a `Symbol.for` key, and the
 * wrapper records which generation installed it (`installMethod` below) so a
 * newer generation atomically restores the original method and installs its own
 * wrapper. Wrapper and table are always from the same generation, while the
 * table contents (plain Sets) stay readable across generations.
 */
const RESOLVE_REGISTRY_KEY = Symbol.for('@local/dsh-agent-preset-lean/resolve-registry')
const resolveRegistry = (() => {
  const shared = globalThis[RESOLVE_REGISTRY_KEY]
  if (shared !== undefined && typeof shared === 'object' && shared.byAgent instanceof WeakMap) return shared
  const created = { byAgent: new WeakMap(), agentByTools: new WeakMap(), generation: 0 }
  globalThis[RESOLVE_REGISTRY_KEY] = created
  return created
})()
/** Resolve-mode admission state, keyed by Agent. Shared across generations. */
const resolveStateByAgent = resolveRegistry.byAgent
/** Scoped ToolsService -> its owning Agent (null when ambiguous). Shared across generations. */
const resolveAgentByTools = resolveRegistry.agentByTools
/** This module instance's generation; bumped for every `?release=` import. */
const GENERATION = ++resolveRegistry.generation
/** Release tag imported by the matching entry file (also logged at mount). */
const RELEASE = '20261106-fixes'

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set([
  'bootstrapTools',
  'promoteOn',
  'bootstrapMaxTokens',
  'suppressedContextSources',
  'compactionTools',
  'residentTools',
  'subagentCompactionTools',
  'subagentResidentTools',
  'includeSubagents',
  'bootstrapPersona',
  'keptContextSources',
  'keptSections',
  'guardWorkspaceWrites',
  'guardSleep',
  'guardNewFileWrites',
  'guardShellWrites',
])

/**
 * Runtime-context contributions kept in EVERY phase (2026-09-04).
 *
 * Both branches below used to return `contexts: []` — the zero-injection
 * stance, aimed at `memory:snapshot` and the runtime-context block. But
 * `contexts` is not only bulk injection: it is also where the harness states
 * the three POLICY FACTS the model cannot otherwise observe, and each one it
 * loses is paid back as wasted rounds:
 *
 *  - `subagent:delegation` (dsh-subagent/child-agent.js) — "your permission
 *    scope was fixed when you were started and cannot be widened from inside
 *    this session … do not retry the denied operation". Stripped, a spawn
 *    child hits an auto-rejected approval, reads it as a transient failure,
 *    and retries an operation that CANNOT succeed. ralph multiplies it.
 *  - `approval:policy` (dsh-user-approval) — under `approvalPolicy: 'never'`
 *    (which delegation PINS for every child) this is the sentence that says
 *    escalation is pointless. Same wasted-retry failure mode.
 *  - `sandbox:policy` (dsh-sandbox-policy) — the current file-write boundary
 *    and, under workspace-write, the workspace root itself.
 *
 * Measured cost of all three: ~162 token, and only in the phase that needs
 * them (`subagent:delegation` renders empty text for a top-level session, so
 * a parent pays ~76). That is a fraction of ONE avoided retry round.
 *
 * Everything else — `memory:snapshot`, the runtime-context snapshot, any
 * future bulk contributor — is still dropped, so the zero-injection intent
 * is unchanged: this is an allowlist, not a switch back to full contexts.
 */
const DEFAULT_KEPT_CONTEXTS = ['subagent:delegation', 'approval:policy', 'sandbox:policy']

/**
 * Context sources stripped from the first request by default. Both are
 * automatic `agent/pre-step` injections: the available-skills reminder
 * (`skill-catalog`) and the AGENTS.md/CLAUDE.md workspace digest
 * (`agent-instructions`). True Minimal mounts neither plugin.
 */
const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/**
 * The default first-request catalog: the OFFICIAL Minimal preset's exact tool
 * pair — the persistent `bash` shell and `str_replace_editor`. Issue #11
 * measured this schema anchoring 5/5 at the adapter-default maxTokens while
 * every standard-family schema failed 11/11.
 *
 * Used when `bootstrapTools` is omitted, exactly like `residentTools` and the
 * other list keys. lean.patch.yml supplies its own wider set, so this fallback
 * only decides the behavior of a mount that does not configure the key; a
 * misconfigured-but-present list still throws rather than silently falling
 * back here.
 */
const DEFAULT_BOOTSTRAP_TOOLS = ['bash', 'str_replace_editor']

/**
 * Default post-promotion resident set when `residentTools` is not configured:
 * the bootstrap pair + the discovery tool. lean.patch.yml overrides this
 * with the session's whitelist (read/write/edit/glob/grep/memory/dtodo/
 * web_search/de_session/read_image/…).
 */
const DEFAULT_RESIDENT_TOOLS = ['bash', 'str_replace_editor', 'tool_gateway']

/**
 * The first-request persona text: the OFFICIAL Minimal preset's complete
 * system prompt sentence. Issue #11 measured the anchor with exactly this
 * system prompt; while bootstrapping, the sections are replaced with ONLY
 * this text (mimicking `complete: true`) and restored to the standard
 * assembly after promotion.
 */
const DEFAULT_BOOTSTRAP_PERSONA = 'You are a helpful software engineer assistant.'

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function stringListOrEmpty(value, field) {
  if (value === undefined) return []
  return stringList(value, field)
}

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

/**
 * Validate the suppressed context sources. Unlike the bootstrap tool lists,
 * an explicitly empty array is meaningful: it disables the context filter
 * while keeping the tool bootstrap.
 */
function sourceList(value, field, fallback) {
  if (value === undefined) return new Set(fallback)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return new Set(value)
}

/**
 * Validate the optional first-request output cap. `undefined` means NO cap:
 * the Minimal tool schema anchors at the adapter-default maxTokens, and the
 * cap's delivery is profile-package dependent (see the header note), so it is
 * opt-in rather than the default.
 */
function optionalPositiveInt(value, field) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

/**
 * The plan-mode carve-out: keep the `plan:policy` section ONLY when
 * dsh-plan-mode actually rendered text into it (user actively entered plan
 * mode). While inactive the section's text is the empty string, so this
 * returns [] and the assembled system prompt is byte-identical to the
 * pre-carve-out Minimal condition — the anchor is not perturbed unless the
 * user explicitly opts into plan mode.
 */
/**
 * Keep only the allowlisted runtime contexts that actually rendered text.
 * The harness already drops empty contributions when rendering, so filtering
 * on non-empty text here only makes the kept list honest in diagnostics —
 * a top-level session naturally carries no `subagent:delegation`.
 */
const keptContextsOf = (assembled, allowed) =>
  allowed.size === 0
    ? []
    : (Array.isArray(assembled?.contexts) ? assembled.contexts : []).filter(
        (context) =>
          context !== null &&
          typeof context === 'object' &&
          allowed.has(context.name) &&
          typeof context.text === 'string' &&
          context.text.trim().length > 0,
      )

const planPolicySections = (assembled) =>
  (Array.isArray(assembled?.sections) ? assembled.sections : []).filter(
    (section) =>
      section !== null &&
      typeof section === 'object' &&
      section.name === 'plan:policy' &&
      typeof section.text === 'string' &&
      section.text.trim().length > 0,
  )

/**
 * Allowlisted system sections, kept ONLY after promotion (2026-10-30).
 *
 * The Minimal persona replacement drops every `tool:*` guidance section a
 * plugin contributes. That is the anchor by design, but it also deleted the
 * `tool:read` guidance `dsh-tool-fs` renders ("Use the read tool — not shell
 * commands like cat — to inspect text files"). Measured on 200 real lean
 * sessions: 87.6% of sessions inspected files through bash and `edit` carried
 * a 10.4% error rate, of which 251 were `file has not been read` (82% of all
 * edit/write errors). The guidance exists in every other preset; lean was the
 * only place where the model never saw it.
 *
 * Bootstrap-phase requests stay byte-identical to the Minimal anchor: the
 * first request is orientation, not file surgery, and the anchor is the point
 * of that phase. Only the promoted catalog (where edit/write live) carries
 * the allowlisted sections.
 */
const keptSectionsOf = (assembled, allowed, promoted) =>
  !promoted || allowed.size === 0
    ? []
    : (Array.isArray(assembled?.sections) ? assembled.sections : []).filter(
        (section) =>
          section !== null &&
          typeof section === 'object' &&
          allowed.has(section.name) &&
          typeof section.text === 'string' &&
          section.text.trim().length > 0,
      )

/** Register the per-session bootstrap filters. */
export function apply(ctx, config) {  const source = config === undefined ? {} : config
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const unknown = Object.keys(source).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) {
    throw new TypeError(
      `${name}: unknown config key(s) ${unknown.join(', ')} — allowed keys: ${[...ALLOWED_KEYS].sort().join(', ')}`,
    )
  }
  // The .mjs graph is cached even when lean.patch.yml is hot-reloaded, so a
  // session needs a log line that says which implementation is actually live.
  try {
    ctx.logger?.info?.(`${name}: release ${RELEASE} active (resolve registry generation ${GENERATION})`)
  } catch {
    // Logger unavailable in fixtures; the version marker is best-effort.
  }
  const bootstrapTools = stringList(source.bootstrapTools ?? DEFAULT_BOOTSTRAP_TOOLS, 'bootstrapTools')
  const residentTools = stringList(source.residentTools ?? DEFAULT_RESIDENT_TOOLS, 'residentTools')
  // 20261017-audit-p0: subagents may need a smaller catalog than the top-level
  // agent (for example, `subagent` itself is unusable at maxDepth=1 and
  // `exit_plan_mode` has no plan-mode meaning in a child). Defaults keep the
  // pre-existing behavior; lean.patch.yml opts in explicitly.
  const subagentResidentTools = stringList(source.subagentResidentTools ?? residentTools, 'subagentResidentTools')
  const promoteEvents = parsePromoteOn(source.promoteOn)
  const bootstrapMaxTokens = optionalPositiveInt(source.bootstrapMaxTokens, 'bootstrapMaxTokens')
  const suppressedSources = sourceList(source.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)
  // Core work set exposed after a compaction, before re-promotion. Empty
  // means "no compaction recovery catalog": the session stays on the
  // bootstrap pair until a new promotion signal.
  const compactionTools = stringListOrEmpty(source.compactionTools, 'compactionTools')
  const subagentCompactionTools = source.subagentCompactionTools === undefined
    ? compactionTools
    : stringListOrEmpty(source.subagentCompactionTools, 'subagentCompactionTools')
  // Runtime-context allowlist (see DEFAULT_KEPT_CONTEXTS). An explicitly empty
  // array restores the previous `contexts: []` behaviour in every phase.
  const keptContexts = sourceList(source.keptContextSources, 'keptContextSources', DEFAULT_KEPT_CONTEXTS)
  // System-section allowlist applied AFTER promotion only (see keptSectionsOf).
  // Empty (the default) keeps the pre-2026-10-30 behaviour: Minimal persona plus
  // the plan:policy carve-out and nothing else.
  const keptSectionNames = sourceList(source.keptSections, 'keptSections', [])
  // Exposure is resolve-only (2026-10-31). The 0.2.1 "gate" mode — step-time
  // `when` hiding plus a `restrict({deny})` mask — was the fallback for the
  // pre-0.2.2 assembly interface. 0.2.2 resolves the step's tool set BEFORE
  // assembly, so the gate path could not narrow the first request and was only
  // ever reachable by configuring `exposureMode: gate`, which lean never did.
  // The whole fallback is deleted rather than left to rot; `exposureMode` is no
  // longer an accepted config key, so a stale copy fails loudly at mount.
  // Subagents follow the same bootstrap/anchor phase as top-level sessions.
  // Set false to treat subagents as already promoted: their first request
  // gets the resident core catalog (not the bootstrap pair) instead of an
  // extra anchoring round.
  const includeSubagents = source.includeSubagents !== false
  // First-request persona text; this same Minimal sentence is kept in every
  // phase. Empty string disables the replacement (keep standard).
  const bootstrapPersona = typeof source.bootstrapPersona === 'string' && source.bootstrapPersona.length > 0
    ? source.bootstrapPersona
    : DEFAULT_BOOTSTRAP_PERSONA

  // Workspace-write guard (2026-11-01, absorbed from dsh-superagent's noWait).
  // Prompt rules and schema hints did not stop bash file mutations, and those
  // writes bypass the fs read evidence that `edit` depends on. A guard is the
  // framework's order-independent denial point, so the refusal is enforced
  // rather than suggested. `guardWorkspaceWrites: false` restores the old
  // behaviour without editing code.
  const guardWorkspaceWrites = source.guardWorkspaceWrites !== false
  const guardSleep = source.guardSleep !== false
  // Creating a *new* workspace file cannot invalidate read evidence, so bash may
  // create it (2026-11-01: strict new-file blocking measured 20.1% of bash calls
  // in session-example, mostly one-off probe scripts). Set true to block those.
  const guardNewFileWrites = source.guardNewFileWrites === true
  // Middle state: `sed -i` / `cat >` / `tee` on existing files are allowed; only
  // scripted interpreter writes are blocked. `guardShellWrites: true` restores
  // the strict rules (18.7% of bash calls in the measured session).
  const guardShellWrites = source.guardShellWrites === true
  const guardedAgents = new WeakSet()
  const installWriteGuard = (agent) => {
    // Either switch alone is enough to install; each flag is checked per call,
    // so `guardWorkspaceWrites: false` does not silently disable the sleep rule.
    if (!guardWorkspaceWrites && !guardSleep) return
    const scoped = agent?.ctx?.tools
    if (scoped === undefined || scoped === null || typeof scoped.guard !== 'function') return
    if (guardedAgents.has(scoped)) return
    try {
      scoped.guard((execution) => {
        if (execution?.name !== 'bash' && execution?.name !== 'pwsh') return undefined
        const command = execution?.arguments?.command
        // A background job does not hold the step, so a long sleep inside one is
        // exactly the recommended pattern; only foreground waits are refused.
        const background = execution?.arguments?.run_in_background === true
        if (guardSleep && !background) {
          const sleepReason = sleepGuardReason(command)
          if (sleepReason !== undefined) return sleepReason
        }
        if (!guardWorkspaceWrites) return undefined
        const workspace = execution?.agent?.session?.header?.cwd
        return writeGuardReason(command, workspace, {
          allowNewFileWrites: !guardNewFileWrites,
          guardShellWrites,
        })
      })
      guardedAgents.add(scoped)
    } catch (error) {
      warnOnce(`${name}: workspace-write guard unavailable: ${String((error && error.message) || error)}`)
    }
  }

  const promotion = createEpochPromotion(promoteEvents, { includeSubagents })
  ctx.on('session/event', (session, event) => {
    promotion.observe(session, event)
    observeUnlock(session, event)
    observeUserPrompt(session, event)
    // 0.2.2 exposure sync points (see the exposure block below). `turn/start`
    // and `compaction/end` can change the phase and are safe places to re-read
    // an unrestricted catalog; `step/end` is past the tool batch, so unlocks
    // recorded during the step land before the next step resolves its set.
    const type = event?.type
    // The mask must be in place BEFORE the loop resolves the step's tool set.
    // Measured on 0.2.2-alpha.2: `turn/start` reaches session listeners after
    // the first step already resolved its set, so a turn/start-only sync leaves
    // request #1 on the full catalog (383 schemas observed). `agent/inbox/spliced`
    // lands when the user message arrives — before the loop opens the turn — and
    // `turn/end` covers the next turn's starting point.
    if (type === 'agent/inbox/spliced' || type === 'turn/end') syncExposure(session, true)
    else if (type === 'turn/start' || type === 'compaction/end') syncExposure(session, true)
    else if (type === 'step/end') syncExposure(session, true)
  })

  /**
   * Release both memos when a session leaves the store (2026-09-04).
   *
   * Both caches were append-only for the process lifetime. A desktop host runs
   * for days and every delegation creates a session: one `ralph` invocation at
   * maxRounds 64 leaves 64 dead entries behind, each holding a Set of tool
   * names plus its session id. Not a fast leak, but unbounded, and nothing
   * else ever removed an entry.
   *
   * Both memos derive from the durable log, so dropping them costs at most one
   * cold re-scan in the (impossible-by-contract) case of a disposed id coming
   * back. `session/disposed` fires once per announced session, including
   * publication rollback.
   *
   * Unlock state is session-local. Disposing a parent therefore cannot alter a
   * live child's tool catalog, and disposing a child cannot affect its parent.
   */
  ctx.on('session/disposed', (session) => {
    if (session === undefined || session === null) return
    promotion.forget(session.id)
    unlockedBySession.delete(session.id)
    teamStateBySession.delete(session.id)
    const disposedAgent = typeof ctx.get === 'function' ? ctx.get('agents')?.get?.(session.id) : undefined
    if (disposedAgent !== undefined && disposedAgent !== null) resolveStateByAgent.delete(disposedAgent)
    // Drop the catalog snapshot with the session: a lingering snapshot would
    // follow a reused id.
    forgetCatalog(session.id)
  })

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  /**
   * Tool names the model explicitly unlocked via `dev_tool_search` for one
   * session. Derived from durable `tool/call` events so resume/reload keeps
   * them. The event's `arguments` is the raw JSON string the model produced;
   * we parse it defensively and read the `toolNames` array.
   *
   * Memoized per session id (2026-09-03): the naive version re-scanned the
   * whole durable log on EVERY system-prompt assemble — O(events) per request
   * with a JSON.parse per unlock call, quadratic over a long session. The
   * cache mirrors compaction-epoch.mjs's state discipline: cold scan once,
   * then incremental updates from `session/event` (observeUnlock above).
   */
  const EMPTY_SET = new Set()
  /** sessionId -> Set<toolName> */
  const unlockedBySession = new Map()

  const absorbUnlock = (unlocked, event) => {
    if (event.type !== 'tool/call') return
    if (event.data?.name !== 'dev_tool_search') return
    let args
    try {
      args = JSON.parse(event.data.arguments)
    } catch {
      return
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return
    const names = args.toolNames
    if (Array.isArray(names)) for (const name of names) if (typeof name === 'string' && name.length > 0) unlocked.add(name)
  }

  const scanUnlocked = (session) => {
    const unlocked = new Set()
    // Own events only: a fork seed copies the parent's log; only unlocks the
    // child itself recorded may extend its catalog beyond the resident set.
    for (const event of ownSessionEvents(session)) absorbUnlock(unlocked, event)
    unlockedBySession.set(session.id, unlocked)
    return unlocked
  }

  /** Incremental feed: fold one durable event into the cached unlock set. */
  function observeUnlock(session, event) {
    const cached = unlockedBySession.get(session.id)
    if (cached !== undefined) absorbUnlock(cached, event)
  }

  const unlockedFor = (session) => {
    if (session === undefined || session === null) return EMPTY_SET
    return unlockedBySession.get(session.id) ?? scanUnlocked(session)
  }

  // LEAN's catalog is the configured set + tool_gateway; every other
  // registration is filtered out of `tools.resolve()` for this Agent (see the
  // resolve filter below), and the gateway's private catalog remains the only
  // path to on-demand capabilities. There is deliberately NO union-of-lists
  // "core" set: `subagent` is resident for the parent and hidden for the child,
  // so admission is decided per Agent by keepToolsFor().
  const GATEWAY_TOOL_NAME = 'tool_gateway'

  /**
   * Agent Team tool set (2026-09-13). These are registered by
   * dsh-experimental-tool-agent-team and are deliberately NOT resident: a team
   * task is bursty, so paying their ~1.7k token of schema every request is
   * waste. The failure this list fixes is not cost but ORDERING: with the team
   * absent from the catalog, a prompt that explicitly says "use the Agent Team
   * subagent" could not be obeyed on the first call — the model saw only the
   * resident `subagent`, used it, and reached the correct tool only after the
   * user repeated the instruction. Discovery-by-search is fine for unknown
   * needs and wrong for an explicit one, so an explicit request pre-unlocks the
   * whole set before the turn's FIRST request, with no extra round.
   */
  const TEAM_TOOL_NAMES = Object.freeze([
    'spawn_teammate',
    'team_task_create',
    'team_task_list',
    'team_task_get',
    'team_task_update',
    'wait_agent',
    'send_message',
    'list_agents',
    'interrupt_agent',
  ])
  /** Team tools a delegation child may use without arming its own Team mode. */
  const TEAM_SUBAGENT_TOOL_NAMES = Object.freeze(['send_message'])
  /** Explicit Team intent only: naming the Team or one of its tools. */
  const TEAM_INTENT_PATTERN =
    /(agent[\s_-]*team|teammate|spawn_teammate|team_task|智能体团队|代理团队|团队子代理|子代理团队|团队协作|专家团)/i
  /**
   * The Agent Team plugin's own lead declaration, injected as a
   * `runtime-context` snapshot at session start (2026-10-31).
   *
   * Measured in session-example (216 steps): the runtime snapshot told the
   * model "You are the Team Lead named lead … use list_agents/send_message",
   * but the catalog had no Team tools because the first user message was just
   * two file paths. The model then spent a round calling `tool_gateway` with
   * `list_agents` and got "not gateway-eligible", i.e. the prompt asked for a
   * capability the catalog withheld. This marker is the team plugin's own
   * statement that the session IS a team, so it arms Team mode from request #1.
   * Deliberately narrow: generic runtime reminders must NOT arm Team.
   */
  const TEAM_LEAD_RUNTIME_PATTERN = /You are the Team Lead named/i
  /**
   * Section injected only when the USER asked for Team mode. It never says
   * "本轮": the stance is sticky (see teamStateBySession), so the request may
   * have been several turns ago.
   */
  const TEAM_ROUTE_NOTE =
    '本会话已启用 Agent Team 子代理：组队与协作直接使用已给出的团队工具（spawn_teammate 及 team_task_* / wait_agent / send_message），不要改用普通 subagent。'

  /**
   * Per-session Team state, memoized like the unlock set.
   *
   * The three inputs are deliberately separate:
   *  - `identity`: the Team plugin's own runtime snapshot declares this session
   *    the Team Lead. It is a runtime fact, not a user request.
   *  - `stance`: the latest explicit USER statement: +1 = asked for Team,
   *    -1 = explicitly forbade it, 0 = no explicit stance yet.
   *  - effective = stance when stated, identity otherwise.
   *
   * The previous implementation latched on ANY keyword hit and never cleared.
   * "不要使用 Agent Team，不要开子代理，只做审查。" therefore ADDED the Team
   * tools and injected "本轮用户显式指定 Agent Team" — the exact opposite of the
   * instruction. A neutral follow-up ("继续") keeps the last explicit stance, so
   * a real multi-turn team task still survives; a later explicit prohibition
   * turns it off again.
   *
   * Only `source.kind === 'user'` sets the stance: plugin-injected reminders are
   * also `user/message` events and must never arm Team. The durable
   * `agent/inbox/spliced` event is also read because `dsh-agent-loop` runs
   * `inbox.claim()` → `systemPrompt.assemble()` → `session.append('user/message')`:
   * at assembly time the current instruction is in neither the inbox nor the log.
   *
   * Own events only, same reason as scanUnlocked: a fork seed copies the parent
   * log, and the parent's instruction must not arm the child.
   */
  const teamStateBySession = new Map()

  /** Clauses end at sentence or list punctuation; negation is only judged inside one. */
  const TEAM_CLAUSE_BREAK = /[。；;！!？?，,、\n]/

  /** Negation cues that turn a Team mention into a prohibition. */
  const TEAM_NEGATION_PATTERN =
    /(?:不要|不用|不需要|无需|不必|别(?=[用开启调走使])|勿|禁止|避免|不准|不许|停止|别再|不使用|不开|不启用|\bnot\b|\bdon'?t\b|\bdo\s+not\b|\bnever\b|\bwithout\b)/i

  /**
   * Post-negation: "Agent Team 不要使用" / "Agent Team should not be used".
   * Only the head of the same clause is inspected, so "用 Agent Team，不要用普通
   * subagent" does not negate the Team request.
   */
  const TEAM_POST_NEGATION_PATTERN =
    /^\s*(?:(?:请|就|也|都|先|立即|马上|全部|直接|is|are|should|must|can|to)\s*)*(?:不要|不用|不需要|不必|别(?=[用开启调走使])|勿|禁止|避免|不准|不许|停止|禁用|关闭|停用|不使用|不开|不启用|\bnot\b|\bdon'?t\b|\bdo\s+not\b|\bnever\b|\bwithout\b)/i

  /**
   * A short next clause that unambiguously continues the prohibition, e.g.
   * "Agent Team，不要使用，只做审查。" It must be a bare negation (optionally with
   * "使用/用"), NOT a prohibition of "普通 subagent".
   */
  const TEAM_NEXT_CLAUSE_NEGATION_PATTERN =
    /^\s*(?:(?:也|都|请|先|就|立即|马上)\s*)?(?:不要|不用|不需要|不必|别(?=[用开启调走使])|勿|禁止|避免|不准|不许|停止|禁用|关闭|停用)(?:\s*(?:再)?\s*(?:使用|用|开|开启|启用|调用|启动|走|继续|做|执行))?(?:\s*(?:它|这个|该功能|team|团队|teammate|agent[\s_-]*team))?\s*$/i

  /**
   * A prohibition that mentions only the delegation mechanism, without naming
   * the Team: "不要开子代理，只做审查。" The audit expects this to close an
   * already-armed Team mode, because Team tasks are delegation.
   */
  const DELEGATION_PROHIBITION_PATTERN =
    /(?:不要|不用|不需要|无需|不必|别(?=[用开启调走使])|勿|禁止|避免|不准|不许|停止|别再|\bnot\b|\bdon'?t\b|\bdo\s+not\b|\bnever\b|\bwithout\b)\s*(?:再)?\s*(?:使用|用|开|开启|启用|调用|启动|走|派|委派)?\s*(?:普通\s*)?(?:子代理|subagent|委派|delegate|teammate|团队|team|agent[\s_-]*team)/gi

  const TEAM_INTENT_GLOBAL = new RegExp(TEAM_INTENT_PATTERN.source, 'gi')

  const clauseEndAfter = (text, from) => {
    for (let index = from; index < text.length; index += 1) {
      if (TEAM_CLAUSE_BREAK.test(text[index])) return index
    }
    return text.length
  }

  const nextClauseAfter = (text, end) => {
    let start = end
    while (start < text.length && TEAM_CLAUSE_BREAK.test(text[start])) start += 1
    if (start >= text.length) return undefined
    return text.slice(start, clauseEndAfter(text, start))
  }

  /**
   * Polarity of the LAST explicit Team mention in one instruction, with
   * prefix, suffix and (bare) next-clause negation. A bare delegation
   * prohibition only decides when NO Team mention exists in the message:
   * "用 Agent Team，不要用普通 subagent" keeps Team armed, while
   * "不要开子代理" closes an armed session.
   */
  const teamStanceOf = (text) => {
    let stance = 0
    let sawMention = false
    for (const match of text.matchAll(TEAM_INTENT_GLOBAL)) {
      sawMention = true
      let clauseStart = 0
      for (let index = match.index - 1; index >= 0; index -= 1) {
        if (TEAM_CLAUSE_BREAK.test(text[index])) {
          clauseStart = index + 1
          break
        }
      }
      const suffixStart = match.index + match[0].length
      const clauseEnd = clauseEndAfter(text, suffixStart)
      const negated = TEAM_NEGATION_PATTERN.test(text.slice(clauseStart, match.index))
        || TEAM_POST_NEGATION_PATTERN.test(text.slice(suffixStart, clauseEnd))
        || TEAM_NEXT_CLAUSE_NEGATION_PATTERN.test(nextClauseAfter(text, clauseEnd) ?? '')
      stance = negated ? -1 : 1
    }
    if (sawMention) return stance
    for (const _match of text.matchAll(DELEGATION_PROHIBITION_PATTERN)) return -1
    return 0
  }

  const emptyTeamState = () => ({ identity: false, stance: 0 })

  const applyTeamSignal = (state, texts, runtimeTexts = []) => {
    for (const text of runtimeTexts) {
      if (!state.identity && TEAM_LEAD_RUNTIME_PATTERN.test(text)) state.identity = true
    }
    for (const text of texts) {
      const stance = teamStanceOf(text)
      if (stance !== 0) state.stance = stance
    }
  }

  const scanTeamState = (session) => {
    const state = emptyTeamState()
    for (const event of ownSessionEvents(session)) {
      applyTeamSignal(state, userTextsOfEvent(event), runtimeTextsOfEvent(event))
    }
    teamStateBySession.set(session.id, state)
    return state
  }

  /** Incremental feed: fold this event's user/runtime text into the cached state. */
  function observeUserPrompt(session, event) {
    const state = teamStateBySession.get(session.id) ?? scanTeamState(session)
    applyTeamSignal(state, userTextsOfEvent(event), runtimeTextsOfEvent(event))
  }

  const teamState = (session) => {
    if (session === undefined || session === null) return emptyTeamState()
    return teamStateBySession.get(session.id) ?? scanTeamState(session)
  }

  /** Effective Team mode: an explicit user stance overrides the runtime identity. */
  const teamArmed = (session) => {
    const state = teamState(session)
    return state.stance === 0 ? state.identity : state.stance > 0
  }

  /** The user (not the runtime snapshot) asked for Team mode. */
  const userAskedForTeam = (session) => teamState(session).stance > 0

  /** Prose of one message-shaped value, when it is a real user instruction. */
  const userTextOf = (message) => {
    if (message === null || typeof message !== 'object') return undefined
    if (message.role !== 'user') return undefined
    if (message.source?.kind !== 'user') return undefined
    const content = message.content
    if (!Array.isArray(content)) return undefined
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    return text.length > 0 ? text : undefined
  }

  /** A runtime-context snapshot (never a user instruction). */
  const runtimeTextOf = (message) => {
    if (message === null || typeof message !== 'object') return undefined
    if (message.role !== 'user') return undefined
    if (message.source?.kind !== 'runtime-context') return undefined
    const content = message.content
    if (!Array.isArray(content)) return undefined
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    return text.length > 0 ? text : undefined
  }

  /**
   * Every user instruction reachable from one durable event: a settled
   * `user/message`, or the messages a `agent/inbox/spliced` event inserted.
   * The splice arm is what makes the CURRENT turn visible before it is logged.
   */
  const userTextsOfEvent = (event) => {
    if (event?.type === 'user/message') {
      const text = userTextOf(event.data)
      return text === undefined ? [] : [text]
    }
    if (event?.type === 'agent/inbox/spliced') {
      const inserted = event.data?.inserted
      if (!Array.isArray(inserted)) return []
      const texts = []
      for (const message of inserted) {
        const text = userTextOf(message)
        if (text !== undefined) texts.push(text)
      }
      return texts
    }
    return []
  }

  /** Runtime-context snapshots reachable from one durable event (lead declaration). */
  const runtimeTextsOfEvent = (event) => {
    if (event?.type === 'user/message') {
      const text = runtimeTextOf(event.data)
      return text === undefined ? [] : [text]
    }
    if (event?.type === 'agent/inbox/spliced') {
      const inserted = event.data?.inserted
      if (!Array.isArray(inserted)) return []
      const texts = []
      for (const message of inserted) {
        const text = runtimeTextOf(message)
        if (text !== undefined) texts.push(text)
      }
      return texts
    }
    return []
  }

  /** A spawned child may message its Team parent, but a fork does not inherit that right. */
  const isSpawnedTeamChild = (session) => {
    if (session === undefined || session === null) return false
    const parentSessionId = session.parentSession ?? session.header?.parentSession
    if ((session.header?.delegationDepth ?? 0) <= 0 || parentSessionId === undefined) return false
    const spawned = ownSessionEvents(session).some((event) => event.type === 'subagent/descriptor' && event.data?.provider === 'spawn')
    if (!spawned) return false
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const parent = agents?.get?.(parentSessionId)
    return parent?.session !== undefined && teamArmed(parent.session)
  }

  const teamToolAllowed = (session, toolName) => {
    if (teamArmed(session)) return true
    return TEAM_SUBAGENT_TOOL_NAMES.includes(toolName) && isSpawnedTeamChild(session)
  }

  /**
   * Catalog names from one snapshot.
   *
   * 0.2.2 removed `tools` from the `system-prompt/assemble` payload: the step's
   * set is resolved BEFORE assembly (`tools.resolve()` → `assemble({ toolSet })`)
   * and a presentation transform "cannot add or remove callable tools". Every
   * name lookup below therefore reads the cached catalog snapshot instead of
   * the assembly.
   */
  const catalogNamesOf = (catalog) => (Array.isArray(catalog) ? catalog : []).map((tool) => tool.name)

  /**
   * Team tools this turn must expose. Filtered against the catalog so a
   * deployment without the Agent Team plugin stays silent instead of
   * warning about names it never had.
   */
  const teamToolsFor = (catalog, session) => {
    const available = new Set(catalogNamesOf(catalog))
    return TEAM_TOOL_NAMES.filter((toolName) => available.has(toolName) && teamToolAllowed(session, toolName))
  }

  /**
   * Expand raw unlock names against the catalog. Supports exact names,
   * trailing-wildcard names (`mcp__github__*`, `dev_*`), and bare MCP server
   * names (`mcp__github`) so the model can unlock a whole group in one
   * `dev_tool_search` call instead of listing every exact tool.
   *
   * 20261024-unlockbudget: assembly replays the RAW tool/call arguments, so the
   * per-call unlock budget has to be applied HERE as well — a cap enforced only
   * in discovery would hide a 207-tool family from the report while still
   * exposing all of it. Both sides size tools through the same schemaChars().
   */
  const expandUnlockedNames = (catalog, rawUnlocked) => {
    const tools = Array.isArray(catalog) ? catalog : []
    return resolveToolNames(rawUnlocked, catalogNamesOf(tools), { sizeOf: schemaSizer(tools) }).resolved
  }

  /**
   * Report phase-critical tools missing from the catalog.
   *
   * The anchor pair IS the lean guarantee, so a missing member is a composition
   * error worth shouting about — but it must NOT abort the exposure mask: the
   * earliest sync point runs before every tool row has finished registering, and
   * throwing there would leave the request on the full catalog (the exact
   * regression the mask exists to prevent). Warn once, keep narrowing.
   */
  const requireTools = (catalog, required) => {
    const available = new Set(catalogNamesOf(catalog))
    const missing = required.filter((toolName) => !available.has(toolName))
    if (missing.length > 0) {
      warnOnce(`${name}: required phase tools missing from the catalog — missing=${JSON.stringify(missing)}; keeping the narrowed catalog`)
    }
    return available
  }

  // ── Tool exposure, 0.2.2 interface (resolve-only, 2026-10-31) ─────────────
  //
  // Up to 0.2.1 the assemble filter decided the model's tool list by returning a
  // narrowed `tools` array. 0.2.2 moved that decision earlier: the loop calls
  // `tools.resolve({ agent, modelSelection, signal })` for the step, hands the
  // resulting ResolvedToolSet to `systemPrompt.assemble`, and recomputes
  // `tools` AFTER the waterfall from the registered tool providers. The
  // waterfall payload is `{ sections, contexts, variables }` only — reading
  // `assembled.tools` throws "Cannot read properties of undefined (reading
  // 'map')" on the first turn, which is exactly the 0.2.2 lean crash.
  //
  // The one admission mechanism is the `tools.resolve()` wrapper below: it
  // filters the step's resolved set per Agent against `keepToolsFor()` plus the
  // armed Team subset, and `executable()` fails closed for callers that arrive
  // without a step ToolSet. Because the wrapper runs inside resolution, there is
  // no mask to lift for `schemas(agent)`: the catalog snapshot in
  // catalog-cache.mjs is read through the unrestricted service view
  // (`tools.view()` / agent view), which never passes through `resolve()`.
  /** Tools one agent may see in the current phase. */
  const keepToolsFor = (agent, catalog) => {
    const session = agent?.session
    const status = promotion.status(agent)
    const teamTools = teamToolsFor(catalog, session)
    const isSubagent = (session?.header?.delegationDepth ?? 0) > 0
    const residentForPhase = isSubagent ? subagentResidentTools : residentTools
    const compactionForPhase = isSubagent ? subagentCompactionTools : compactionTools
    const unlocked = expandUnlockedNames(catalog, unlockedFor(session))
    if (status.promoted) return new Set([...residentForPhase, ...unlocked, ...teamTools])
    if (status.boundary >= 0) return new Set([...compactionForPhase, ...unlocked, ...teamTools])
    requireTools(catalog, bootstrapTools)
    return new Set([...bootstrapTools, ...teamTools])
  }

  /**
   * Tool-level hints appended to the model's schema (2026-10-31).
   *
   * Session-f3e29bde ran 277 steps with 29 inline `python - <<PY` file rewrites
   * and 13 edit/write calls: about 70% of its file mutations went through bash,
   * and one of them produced `file changed since it was read`. The AGENTS.md
   * rule states the requirement at session start, but at step 200 the schema is
   * still in front of the model while the rule is thousands of tokens back.
   * Appending the constraint to `edit`/`write` therefore targets the place the
   * model actually looks when choosing a tool. A `read` hint was tried and
   * reverted: an A/B (N=10 per arm, same task) showed identical first tool
   * (bash×10), requests, calls, errors and single-call ratio with and without
   * it, at +121 characters on the most expensive request (bootstrap catalog).
   * The edit/write pair costs ~190 characters, and only after promotion.
   *
   * 2026-11-03 (0.2.2-alpha.3): the host's fs-observation-policy is disabled by
   * default, so edit/write no longer enforce a prior read. Keep the practice
   * (AGENTS.md still requires it) but stop claiming a host check that no longer
   * exists.
   */
  const TOOL_DESCRIPTION_HINTS = new Map([
    ['edit', 'Read the file with the `read` tool before editing: it gives the exact current text, line numbers, and version. Shell dumps (`cat`/`sed -n`/`grep`) are easy to mis-copy; prefer `edit` over scripted rewrites (`sed -i`, python heredoc).'],
    ['write', 'Read the file before overwriting so you keep the parts you did not mean to change; prefer `edit` for targeted changes.'],
    // `job_output`/`job_list` are gateway-only in lean; without this sentence a
    // background job looks uncollectable (observed as a dead end after a sleep denial).
    ['bash', '`job_output` / `job_list` are gateway tools — call them through `tool_gateway` (action="call").'],
  ])
  /** Clones are cached per registration so the wrapper allocates once per tool. */
  const hintedDefinitions = new WeakMap()
  const withDescriptionHint = (definition) => {
    const hint = TOOL_DESCRIPTION_HINTS.get(definition?.name)
    if (hint === undefined || typeof definition?.description !== 'string') return definition
    const cached = hintedDefinitions.get(definition)
    if (cached !== undefined) return cached
    const hinted = { ...definition, description: `${definition.description}\n\n${hint}` }
    hintedDefinitions.set(definition, hinted)
    return hinted
  }

  /** Symbol slot holding the wrapper record for one method, on the patched object. */
  const RESOLVE_INSTALL_KEY = Symbol.for('@local/dsh-agent-preset-lean/resolve-install')
  const EXECUTABLE_INSTALL_KEY = Symbol.for('@local/dsh-agent-preset-lean/resolve-executable-install')
  /** Markers written by the pre-20261106 implementation. */
  const LEGACY_FILTER_KEY = Symbol.for('@local/dsh-agent-preset-lean/resolve-filter')
  const LEGACY_EXECUTABLE_KEY = Symbol.for('@local/dsh-agent-preset-lean/resolve-executable')

  /** The nearest object on the chain carrying a legacy (pre-20261106) marker. */
  const legacyOwnerOf = (target, key) => {
    let node = target
    while (node !== null && node !== undefined) {
      if (Object.prototype.hasOwnProperty.call(node, key)) return node
      node = Object.getPrototypeOf(node)
    }
    return undefined
  }

  /**
   * Detach a legacy wrapper ONLY when it is an own property that shadows a
   * still-reachable prototype method. The legacy implementation captured its
   * original in a closure and stored no reference, so a wrapper installed on the
   * prototype (the real-host case) cannot be unwrapped in-process.
   */
  const detachLegacyOwnWrapper = (tools, owner, marker, method) => {
    if (owner === undefined) return true
    // The old marker was defined non-configurable. Once the own wrapper is
    // gone, the marker is stale; ignore it instead of warning forever.
    if (!Object.prototype.hasOwnProperty.call(owner, method)) return true
    if (owner === Object.getPrototypeOf(tools)) return false
    const parent = Object.getPrototypeOf(owner)
    const inherited = parent?.[method]
    if (typeof inherited !== 'function' || inherited === owner[method]) return false
    delete owner[method]
    try { delete owner[marker] } catch { /* non-configurable: stale marker, handled above */ }
    return typeof owner[method] === 'function'
  }

  /** The nearest object on the prototype chain that owns this method's wrapper record. */
  const wrapperOwnerOf = (target, key) => {
    let node = target
    while (node !== null && node !== undefined) {
      if (Object.prototype.hasOwnProperty.call(node, key)) return node
      node = Object.getPrototypeOf(node)
    }
    return undefined
  }

  /**
   * Install or replace one generation's method wrapper.
   *
   * A wrapper from an older generation is restored first: nesting generations
   * would filter the same ToolSet twice, and the outer wrapper's state table
   * belongs to a module instance the host no longer calls into. A newer
   * generation always wins, so a stale plugin instance syncing after a hot
   * reload cannot downgrade the filter.
   */
  const installMethod = (target, key, method, wrap) => {
    if (target === undefined || target === null) return
    const ownRecord = Object.prototype.hasOwnProperty.call(target, key) ? target[key] : undefined
    if (ownRecord !== undefined) {
      if (ownRecord.generation >= GENERATION) return
      ownRecord.restore()
    }
    const original = target[method]
    if (typeof original !== 'function') return
    const hadOwn = Object.prototype.hasOwnProperty.call(target, method)
    const replacement = wrap(original)
    target[method] = replacement
    Object.defineProperty(target, key, {
      value: {
        generation: GENERATION,
        restore() {
          try { delete target[key] } catch { /* non-configurable, leave it */ }
          if (hadOwn) target[method] = original
          else delete target[method]
        },
      },
      configurable: true,
    })
  }

  const wrapResolve = (original) => async function (context) {
    const resolved = await original.call(this, context)
    const agent = context?.agent
    const state = resolveStateByAgent.get(agent)
    if (state === undefined) {
      const preset = agent?.session?.header?.agentPreset
      if (preset !== undefined && preset !== 'lean') return resolved
      throw new Error('LEAN resolve exposure state is unavailable for this Agent')
    }
    const allowed = new Set()
    for (const [toolName] of resolved.view(agent)) {
      const isTeam = state.teamNames.includes(toolName)
      if (toolName === 'run_code' || (isTeam ? state.teamAllowed.has(toolName) : state.keep.has(toolName))) allowed.add(toolName)
    }
    return Object.freeze({
      dispose: resolved.dispose,
      view: (scope) => {
        const current = resolved.view(scope)
        if (scope !== agent) return current
        return new Map([...current]
          .filter(([toolName]) => allowed.has(toolName))
          .map(([toolName, definition]) => [toolName, withDescriptionHint(definition)]))
      },
    })
  }

  const wrapExecutable = (originalExecutable) => function (name, scope, toolSet) {
    if (toolSet !== undefined) return originalExecutable.call(this, name, scope, toolSet)
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const explicitAgent = typeof scope === 'string' ? agents?.get?.(scope) : scope
    const ownerAgent = scope === undefined ? resolveAgentByTools.get(this) : undefined
    const agent = explicitAgent === undefined || explicitAgent === null ? ownerAgent : explicitAgent
    if (agent === undefined || agent === null) {
      // No step admission and no unambiguous Agent owner: never expose a
      // managed tool outside the resolve allow-set. run_code remains the
      // reserved PTC transport and is admitted by the executor itself.
      return name === 'run_code' ? originalExecutable.call(this, name, scope, toolSet) : undefined
    }
    const state = resolveStateByAgent.get(agent)
    if (state === undefined) {
      const preset = agent?.session?.header?.agentPreset
      if (preset !== undefined && preset !== 'lean') return originalExecutable.call(this, name, scope, toolSet)
      return name === 'run_code' ? originalExecutable.call(this, name, scope, toolSet) : undefined
    }
    const isTeam = state.teamNames.includes(name)
    const allowed = name === 'run_code' || (isTeam ? state.teamAllowed.has(name) : state.keep.has(name))
    return allowed ? originalExecutable.call(this, name, scope, toolSet) : undefined
  }

  /** Filter an admitted ToolSet once, instead of wrapping registrations. */
  const installResolveFilterOn = (tools, ownerAgent) => {
    if (tools === undefined || tools === null) return
    const hasResolve = typeof tools.resolve === 'function'
    const hasExecutable = typeof tools.executable === 'function'
    if (!hasResolve && !hasExecutable) return
    // A host that hot-reloaded from the pre-20261106 implementation still has
    // the old wrapper installed. The new generation must not wrap that closure
    // (it reads a private state table and throws); detect it and require the
    // controlled restart that actually clears the module graph.
    const legacyFilterOwner = legacyOwnerOf(tools, LEGACY_FILTER_KEY)
    const legacyExecutableOwner = legacyOwnerOf(tools, LEGACY_EXECUTABLE_KEY)
    if (legacyFilterOwner !== undefined || legacyExecutableOwner !== undefined) {
      const detachedFilter = detachLegacyOwnWrapper(tools, legacyFilterOwner, LEGACY_FILTER_KEY, 'resolve')
      const detachedExecutable = detachLegacyOwnWrapper(tools, legacyExecutableOwner, LEGACY_EXECUTABLE_KEY, 'executable')
      if (!detachedFilter || !detachedExecutable) {
        warnOnce(`${name}: a pre-20261106 resolve wrapper is still installed and cannot be unwrapped in-process (its original method is captured in a closure). RESTART the host to finish this upgrade; new sessions may fail with "LEAN resolve exposure state is unavailable for this Agent" until then.`)
        return
      }
      warnOnce(`${name}: detached a recoverable pre-20261106 resolve wrapper; a restart is still recommended for the rest of the process`)
    }
    if (ownerAgent !== undefined && ownerAgent !== null) {
      const current = resolveAgentByTools.get(tools)
      if (current === undefined) resolveAgentByTools.set(tools, ownerAgent)
      else if (current !== ownerAgent) resolveAgentByTools.set(tools, null)
    }
    const proto = Object.getPrototypeOf(tools)
    // A wrapper already installed anywhere on the chain is the patch point:
    // replacing it in place keeps the chain free of shadowing duplicates.
    const resolveTarget = wrapperOwnerOf(tools, RESOLVE_INSTALL_KEY)
      ?? (proto !== null && proto !== undefined && typeof proto.resolve === 'function' ? proto : tools)
    if (hasResolve || typeof resolveTarget.resolve === 'function') {
      installMethod(resolveTarget, RESOLVE_INSTALL_KEY, 'resolve', wrapResolve)
    }
    const executableTarget = wrapperOwnerOf(tools, EXECUTABLE_INSTALL_KEY)
      ?? (proto !== null && proto !== undefined && typeof proto.executable === 'function' ? proto : tools)
    if (hasExecutable || typeof executableTarget.executable === 'function') {
      installMethod(executableTarget, EXECUTABLE_INSTALL_KEY, 'executable', wrapExecutable)
    }
  }

  const installResolveFilter = () => {
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    installResolveFilterOn(tools)
  }

  /**
   * Reconcile one session's exposure mask.
   * @param session - durable Session.
   * @param refresh - lift the mask first to read an unrestricted catalog.
   */
  const syncExposure = (session, refresh) => {
    if (session === undefined || session === null) return
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const agent = agents?.get?.(session.id)
    if (agent === undefined || agent === null) return
    // This plugin deliberately has no `inject: ['tools']` (it must register
    // before dsh-agent-instructions/skill). `ctx.tools` therefore throws; the
    // service accessor is the supported read path, with the agent's scoped
    // registry as a fallback.
    const toolsService = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    try {
      const cached = catalogFor(session.id)
      let catalog = cached
      if (refresh === true || !Array.isArray(cached)) {
        catalog = (() => {
          try {
            if (toolsService !== undefined && typeof toolsService.schemas === 'function') {
              return toolsService.schemas(agent)
            }
            return typeof agent?.ctx?.tools?.schemas === 'function' ? agent.ctx.tools.schemas(agent) : []
          } catch {
            return []
          }
        })()
        rememberCatalog(session.id, catalog)
      }
      // The gateway the CURRENT caller cannot see is exactly what it may call
      // through the gateway. Eligibility is therefore marked per Agent against
      // this Agent's kept set, not against the union of every configured list:
      // `subagent` is resident at top level but deliberately absent from the
      // child list, and a union made the child's gateway reject it as
      // "not gateway-eligible" even though its own catalog hid it.
      const keep = keepToolsFor(agent, catalog)
      const markHiddenForAgent = (toolName, registration) => {
        if (toolName === GATEWAY_TOOL_NAME) return
        if (TEAM_TOOL_NAMES.includes(toolName)) return
        if (keep.has(toolName)) {
          // A phase change can make a hidden tool resident (`subagent` after
          // promotion). Its old mark must go, or the gateway would keep serving
          // a tool the model can already call directly.
          unmarkGatewayEligible(registration.definition, agent)
          return
        }
        markGatewayEligible(registration.definition, registration.when, agent)
      }
      // Only definitions that are visible in this agent's catalog after other
      // plugins' restrictions may be reached: a global tool hidden by an
      // unrelated plugin's `when` must stay unavailable, and a conditional tool
      // keeps its own condition for the gateway to re-evaluate.
      const visibleNames = new Set(catalogNamesOf(catalog))
      const globalView = toolsService !== undefined && typeof toolsService.view === 'function'
        ? toolsService.view()
        : undefined
      if (globalView !== undefined) {
        for (const [toolName, registration] of globalView.registrations) {
          if (!visibleNames.has(toolName)) continue
          markHiddenForAgent(toolName, registration)
        }
      }
      // The browser/MCP provider opens a child scope and registers tools after
      // some earlier sync points; mark those already-created registrations too.
      const agentView = toolsService !== undefined && typeof toolsService.view === 'function'
        ? toolsService.view(agent)
        : undefined
      if (agentView !== undefined) {
        for (const [toolName, registration] of agentView.registrations) {
          markHiddenForAgent(toolName, registration)
        }
      }
      installResolveFilterOn(agent?.ctx?.tools, agent)
      installWriteGuard(agent)
      resolveStateByAgent.set(agent, {
        keep,
        preset: session?.header?.agentPreset,
        teamNames: TEAM_TOOL_NAMES,
        teamAllowed: new Set(teamToolsFor(catalog, session)),
      })
    } catch (error) {
      warnOnce(`${name}: tool exposure sync failed: ${String((error && error.message) || error)}`)
    }
  }

  /**
   * Assemble the prompt for one step.
   *
   * Both phases share the same prompt shape (Minimal persona + non-empty
   * plan:policy + optional team route note, allowlisted runtime facts), so the
   * filter no longer branches: the phase only decides the tool set, which the
   * exposure mask above already applied.
   */
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      const session = context.agent?.session
      const promoted = context.agent === undefined || context.agent === null
        ? false
        : promotion.status(context.agent).promoted
      // 0.2.1 (and unit fixtures) hand the assemble waterfall a `tools` array;
      // 0.2.2 removed it and narrows inside `tools.resolve()` instead. Keep the
      // old transport working when it is present without affecting 0.2.2.
      if (Array.isArray(assembled?.tools)) {
        const catalog = assembled.tools
        const keep = keepToolsFor(context.agent, catalog)
        const teamTools = teamToolsFor(catalog, session)
        const teamSection = !userAskedForTeam(session) || teamTools.length === 0 ? [] : [{ name: 'lean:team-route', text: TEAM_ROUTE_NOTE }]
        return {
          ...assembled,
          tools: catalog.filter((tool) => keep.has(tool.name)),
          sections: [{ name: 'deployment:persona-prefix', text: bootstrapPersona }, ...planPolicySections(assembled), ...keptSectionsOf(assembled, keptSectionNames, promoted), ...teamSection],
          contexts: keptContextsOf(assembled, keptContexts),
        }
      }
      const catalog = catalogFor(session?.id)
      const teamTools = teamToolsFor(catalog, session)
      const teamSection = !userAskedForTeam(session) || teamTools.length === 0 ? [] : [{ name: 'lean:team-route', text: TEAM_ROUTE_NOTE }]
      return {
        ...assembled,
        sections: [{ name: 'deployment:persona-prefix', text: bootstrapPersona }, ...planPolicySections(assembled), ...keptSectionsOf(assembled, keptSectionNames, promoted), ...teamSection],
        contexts: keptContextsOf(assembled, keptContexts),
      }
    } catch (error) {
      // A filter bug must surface loudly, never silently widen the prompt.
      warnOnce(`${name}: bootstrap filter failed: ${String((error && error.message) || error)}`)
      throw error
    }
  })

  // Optionally cap the first model request's output budget while bootstrapping.
  // Unset (`bootstrapMaxTokens` omitted) means the adapter default flows — the
  // Minimal tool schema anchors at 256000 without a cap (issue #11).
  if (bootstrapMaxTokens !== undefined) {
    // Same registration discipline as the pre-step strip below: `prepend`
    // keeps this listener the OUTERMOST transform of the agent/request
    // waterfall for the same registration-order reasons (loader row
    // application is concurrent; row order alone does not decide listener
    // order — see issue #6 and upstream PR #13), so a later listener can
    // never override the first-round budget after we set it.
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      const agent = payload.agent
      if (promotion.status(agent).promoted) {
        // The next request's seed proposal carries the previous header's
        // maxTokens forward, so the injected cap must be stripped explicitly —
        // otherwise it would persist for the whole session.
        if (resolved.maxTokens === bootstrapMaxTokens) {
          const { maxTokens: _bootstrap, ...rest } = resolved
          return rest
        }
        return resolved
      }
      return {
        ...resolved,
        maxTokens: bootstrapMaxTokens,
      }
    }, { prepend: true })
  }

  // Strip first-step injected reminders (skill catalog, AGENTS.md) during
  // bootstrap. Because this listener is the first registered (see the inject
  // note, the row order in lean.patch.yml, and `prepend` below), the strip
  // is the final waterfall transform and actually removes what later
  // listeners inject.
  // A provider can register scoped tools after the session's initial sync.
  // Defer one full catalog sync to the next microtask so the newly registered
  // tools are marked gateway-eligible without disturbing the current step.
  let toolsChangeScheduled = false
  installResolveFilter()

  ctx.on('tools/change', () => {
    if (toolsChangeScheduled) return
    toolsChangeScheduled = true
    queueMicrotask(() => {
      toolsChangeScheduled = false
      const currentAgents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      // 20261109-toolschange：refresh=true。以前这里读缓存目录，`visibleNames`
      // 可能是注册前的快照，导致晚注册/重注册的工具被跳过、拿不到 eligibility
      // 标记 —— 模型既看不到、网关又说 not gateway-eligible，成了死角
      // （实测：job_output、mcp__ida__list_databases）。
      for (const agent of currentAgents?.list?.() ?? []) syncExposure(agent.session, true)
    })
  })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (promotion.status(agent).promoted || suppressedSources.size === 0) return decision
      if (!Array.isArray(decision.messages)) return decision
      const kept = decision.messages.filter((message) => {
        const kind = message?.source?.kind
        return typeof kind !== 'string' || !suppressedSources.has(kind)
      })
      return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
    } catch (error) {
      // A filter bug must never eat context: degrade to keeping every message.
      warnOnce(`${name}: pre-step context filter failed, keeping injected context: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
