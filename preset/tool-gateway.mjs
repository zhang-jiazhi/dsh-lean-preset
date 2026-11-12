/**
 * Stable single-entry capability gateway for the LEAN preset (2026-10-29).
 *
 * The model sees one `tool_gateway` schema plus the fixed resident core. Every
 * on-demand tool (MCP/browser/skill/memory/subagent/…) is hidden from
 * `request.tools`, so unlocking a capability no longer changes the request
 * prefix. The gateway resolves a private catalog and delegates through the
 * public `ctx.tools.execute()` pipeline, preserving pre-execute policy,
 * approval, guards and post-execute handling.
 *
 * Deliberately dependency-free: preset-local modules can only resolve relative
 * files, so the definition is hand-built instead of importing `defineTool`.
 */

export const name = 'tool-gateway'

/** The tool registry must exist before this tool can register. */
export const inject = ['tools']

import { isGatewayEligible } from './gateway-policy.mjs?release=20261106-fixes'
import { projectReaStatus } from './rea-status-output.mjs?release=20261110-scoped2'

const GATEWAY_NAME = 'tool_gateway'
const MAX_LIST = 80
const MAX_SEARCH = 25
const MAX_LIST_CHARS = 5000
const MAX_SEARCH_CHARS = 3000
const MAX_DESCRIPTION = 180
/** Lean-local on-demand skills stay out of resident tools but remain gateway-reachable. */
const GATEWAY_ALWAYS = new Set(['skill_search', 'skill_load'])

const textOf = (value) => (typeof value === 'string' ? value : '')

const clip = (value, limit = MAX_DESCRIPTION) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`
}

/** Eligibility describes LEAN hiding, not admission by the current Agent scope. */
const eligibleRegistration = (name, registration, agent) => registration !== undefined
  && registration.when === undefined
  && (isGatewayEligible(registration.definition, agent) || GATEWAY_ALWAYS.has(name))

/** Never merge a global fallback over restrictions or a conditional scoped shadow. */
const catalogFor = (ctx, agent) => {
  const definitions = new Map()
  const direct = new Set()
  const conditional = new Set()
  const registrations = ctx.tools.view(agent).registrations
  if (!(registrations instanceof Map)) throw new Error('tool registry does not expose effective registrations')
  for (const [name, registration] of registrations) {
    if (name === GATEWAY_NAME) continue
    if (!isGatewayEligible(registration.definition, agent) && !GATEWAY_ALWAYS.has(name)) {
      direct.add(name)
      continue
    }
    // Conditions belong to this registration, not a shared definition object.
    // The gateway has no modelSelection with which to evaluate them truthfully.
    if (registration.when !== undefined) {
      conditional.add(name)
      continue
    }
    definitions.set(name, registration.definition)
  }
  return { definitions, direct, conditional }
}

/** Recheck admission after pre-execute/approval; a captured definition is not authority. */
const privateToolSet = (ctx, definitions, agent) => ({
  dispose() {},
  view(scope) {
    const admitted = new Map()
    if (scope !== agent) return admitted
    const current = ctx.tools.view(agent).registrations
    if (!(current instanceof Map)) return admitted
    for (const [name, definition] of definitions) {
      const registration = current.get(name)
      if (registration?.definition === definition && eligibleRegistration(name, registration, agent)) {
        admitted.set(name, definition)
      }
    }
    return admitted
  },
})

const canonicalResultAt = (settled, index) => {
  const result = Array.isArray(settled?.results) ? settled.results[index]?.result : undefined
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`tool result protocol error: missing canonical results[${index}].result; outcome unknown — inspect before retrying`)
  }
  return result
}

/** Preserve the hidden tool's canonical content, including image/file blocks. */
const resultValue = (settled) => {
  const result = canonicalResultAt(settled, 0)
  const content = Array.isArray(result.content) ? result.content : undefined
  const text = (content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  if (result.isError === true) {
    throw new Error(textOf(result.error?.message) || text || 'tool failed')
  }
  if (content !== undefined && content.length > 0) return { content, ...(text.length > 0 ? { text } : {}) }
  if (result.value !== undefined) return { text: JSON.stringify(result.value, null, 2) }
  return { text: '(tool completed with no output)' }
}

/**
 * Batch form of `action="call"` (2026-11-01, from dsh-superagent's
 * `orchestrator_route`, which takes 1–20 decisions in one call): one gateway
 * call runs several hidden tools in order and labels each result. Valid names
 * and inputs are the caller's job — validation happens before anything runs,
 * so a typo in the second item never leaves the first executed.
 *
 * The old version concatenated text only, so an image result (screenshot,
 * read_image) disappeared and a mixed batch reported uniform success. Each item
 * now keeps its ORIGINAL content blocks; a failure is labeled in place, and a
 * partly failed batch leads with an explicit "BATCH PARTIAL FAILURE" line. When
 * every item failed there is no content worth keeping, so the call throws and
 * error statistics see a real failure instead of a success text.
 */
const batchResult = (settled, names) => {
  const content = []
  const sections = []
  const failed = []
  const statuses = []
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    const label = `## ${name}`
    let result
    try {
      result = canonicalResultAt(settled, index)
    } catch (error) {
      const message = error.message
      const body = `ERROR: ${message}`
      failed.push({ name, message })
      statuses.push({ index, name, status: 'error', message })
      content.push({ type: 'text', text: `${label}\n${body}` })
      sections.push(`${label}\n${body}`)
      continue
    }
    if (result.isError === true) {
      const raw = (Array.isArray(result.content) ? result.content : [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      const message = textOf(result.error?.message) || raw || 'tool failed'
      failed.push({ name, message })
      statuses.push({ index, name, status: 'error', message })
      content.push({ type: 'text', text: `${label}\nERROR: ${message}` })
      sections.push(`${label}\nERROR: ${message}`)
      continue
    }
    statuses.push({ index, name, status: 'ok' })
    const blocks = Array.isArray(result.content) ? result.content : []
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    content.push({ type: 'text', text: label })
    if (blocks.length > 0) content.push(...blocks)
    const body = text
      || (result.value !== undefined
        ? JSON.stringify(result.value)
        : blocks.some((block) => block?.type !== 'text') ? '(non-text result)' : '(no output)')
    if (blocks.length === 0) content.push({ type: 'text', text: body })
    sections.push(`${label}\n${body}`)
  }
  if (failed.length === names.length) {
    throw new Error(`batch failed: all ${names.length} call(s) failed — ${failed.map((item) => `${item.name}: ${item.message}`).join('; ')}`)
  }
  if (failed.length === 0) return { text: sections.join('\n\n'), content, statuses }
  const summary = `BATCH PARTIAL FAILURE: ${failed.length}/${names.length} calls failed (${failed.map((item) => item.name).join(', ')}). Failed items are labeled ERROR above; retry only those.`
  return {
    content: [{ type: 'text', text: summary }, ...content],
    text: `${summary}\n\n${sections.join('\n\n')}`,
    statuses,
  }
}

const collectLines = (entries, limit, budget) => {
  const lines = []
  let chars = 0
  for (const [toolName, definition] of entries) {
    if (lines.length >= limit) break
    const line = `- ${toolName}: ${clip(definition?.description)}`
    if (lines.length > 0 && chars + line.length > budget) break
    lines.push(line)
    chars += line.length + 1
  }
  return { lines, shown: lines.length, omitted: Math.max(0, entries.length - lines.length) }
}

/** Paged listing: the char budget alone must never make the catalog unreachable. */
const listText = (definitions, offset = 0) => {
  const entries = [...definitions.entries()].sort(([a], [b]) => a.localeCompare(b))
  const total = entries.length
  if (total === 0) return 'No gateway-eligible tools registered.'
  const start = Math.min(Math.max(0, Math.trunc(offset) || 0), total)
  // An offset past the end must not print "278-277 of 277".
  if (start === total && total > 0) return `End of list: ${total} gateway tools. Call list without offset to start over.`
  const { lines, shown } = collectLines(entries.slice(start), MAX_LIST, MAX_LIST_CHARS)
  const end = start + shown
  const out = [`gateway tools ${start + 1}-${end} of ${total}`]
  out.push(...lines)
  if (end < total) out.push(`... (${total - end} more; call list with offset=${end})`)
  return out.join('\n')
}

/** Score one tool for a set of terms. Any term may match; name hits weigh most. */
const scoreTool = (toolName, definition, terms) => {
  const name = toolName.toLowerCase()
  const description = String(definition?.description ?? '').toLowerCase()
  let score = 0
  for (const term of terms) {
    const inName = name.includes(term)
    if (inName) {
      score += 3
      if (name === term) score += 6
      continue
    }
    if (description.includes(term)) score += 1
  }
  return score
}

/** Split a query into alternative term groups: commas separate, spaces hold one concept. */
const queryGroups = (query) =>
  query.toLowerCase().split(',').map(group => group.split(/\s+/).filter(Boolean)).filter(group => group.length > 0)

/**
 * Directly visible tools a zero-result query was reaching for. Observed real
 * sessions searched for resident/Team tools (`list_agents`, `send_message`,
 * `team agents`) that the gateway can never serve, then abandoned the gateway
 * entirely; naming them turns that dead end into one direct call.
 */
const directHitsFor = (direct, groups) => {
  const hits = new Set()
  for (const terms of groups) {
    for (const term of terms) {
      if (direct.has(term)) {
        hits.add(term)
        continue
      }
      for (const name of direct) {
        if (name.startsWith(`${term}_`) || (term.length >= 4 && name.includes(term))) hits.add(name)
      }
    }
  }
  return [...hits].sort()
}

/** Conditional names that the query was reaching for (`web_search`, …). */
const conditionalHitsFor = (conditional, groups) => {
  const terms = groups.flat()
  return [...conditional].filter(name => {
    const lower = name.toLowerCase()
    return terms.some(term => lower.includes(term))
  }).sort().slice(0, 3)
}

/** A failed search still has to end in an executable next step; list is the fallback. */
const noMatchText = (direct, query, groups, conditional = new Set()) => {
  const gated = conditionalHitsFor(conditional, groups)
  if (gated.length > 0) {
    const names = gated.map(name => `"${name}"`).join(', ')
    const verb = gated.length === 1 ? 'is' : 'are'
    return `No gateway-eligible tools match "${query}". ${names} ${verb} conditionally registered and cannot be called through the gateway — ${gated.length === 1 ? 'it appears' : 'they appear'} in your tool list only when ${gated.length === 1 ? 'its' : 'their'} condition holds.`
  }
  const hits = directHitsFor(direct, groups)
  // Registrations are not the resolved turn catalog. In particular a Team
  // registration remains known after an explicit "no Team" instruction.
  const team = new Set(hits.filter(name => TEAM_TOOLS.has(name)))
  for (const term of groups.flat()) if (TEAM_TOOLS.has(term)) team.add(term)
  const resident = hits.filter(name => !TEAM_TOOLS.has(name))
  if (resident.length === 0 && team.size === 0) return `No gateway-eligible tools match "${query}". Try list.`
  const out = [`No gateway-eligible tools match "${query}".`]
  if (resident.length > 0) {
    const shown = resident.slice(0, 6).join(', ')
    const rest = resident.length > 6 ? ` (+${resident.length - 6} more)` : ''
    const verb = resident.length === 1 ? 'is' : 'are'
    out.push(`${shown}${rest} ${verb} already visible in your tool list — call ${resident.length === 1 ? 'it' : 'them'} directly instead of using the gateway.`)
  }
  for (const toolName of [...team].slice(0, 3)) out.push(directToolText(toolName))
  return out.join(' ')
}

/** Prefer all-term matches for phrases, while keeping OR fallback for name lists. */
const searchText = (definitions, query, direct, conditional = new Set()) => {
  const groups = queryGroups(query)
  // Exact Team names are routing intent, not descriptive search terms. Native
  // subagent descriptions mention send_message; returning that delegate for a
  // send_message query would send an ordinary child back into a waiting loop.
  if (groups.length === 1) {
    const terms = groups[0]
    if (terms.join(' ') === 'wait agent') return noMatchText(direct, query, [['wait_agent']], conditional)
    if (terms.every(term => TEAM_TOOLS.has(term))) return noMatchText(direct, query, groups, conditional)
    const ordinaryWait = terms.includes('subagent') && terms.includes('wait') && (terms.includes('result') || terms.includes('status'))
    const namedCapability = [...definitions.keys()].some(name => terms.every(term => name.toLowerCase().includes(term)))
    if (ordinaryWait && !namedCapability) return ORDINARY_WAIT_HINT
  }
  const selected = new Map()
  for (const terms of groups) {
    const matches = []
    const strict = []
    const nameMatches = []
    for (const [toolName, definition] of definitions.entries()) {
      const score = scoreTool(toolName, definition, terms)
      if (score === 0) continue
      const name = toolName.toLowerCase()
      const description = String(definition?.description ?? '').toLowerCase()
      const allNameTermsMatch = terms.every(term => name.includes(term))
      const allTermsMatch = allNameTermsMatch || terms.every(term => description.includes(term) || name.includes(term))
      const item = { toolName, definition, score }
      matches.push(item)
      if (allTermsMatch) strict.push(item)
      if (allNameTermsMatch) nameMatches.push(item)
    }
    // If the query names tools directly, do not include other tools whose
    // descriptions merely mention those names (for example memory_get mentions
    // memory_list in its own usage guidance).
    const preferred = nameMatches.length > 0 ? nameMatches : strict.length > 0 ? strict : matches
    for (const item of preferred) {
      const previous = selected.get(item.toolName)
      if (previous === undefined || item.score > previous.score) selected.set(item.toolName, item)
    }
    // One incidental all-term description match must not hide real name matches:
    // "web search" listed only deepseek_fetch (description mentions both words)
    // while tavily_search / anysearch_search fell out (observed 2026-11-01).
    if (nameMatches.length === 0 && strict.length > 0 && strict.length < 3) {
      for (const item of matches) {
        if (item.score < 3) continue
        const previous = selected.get(item.toolName)
        if (previous === undefined || item.score > previous.score) selected.set(item.toolName, item)
      }
    }
  }
  if (selected.size === 0) return noMatchText(direct, query, groups, conditional)
  const scored = [...selected.values()]
  scored.sort((a, b) => b.score - a.score || a.toolName.localeCompare(b.toolName))
  const entries = scored.map(item => [item.toolName, item.definition])
  const { lines, omitted } = collectLines(entries, MAX_SEARCH, MAX_SEARCH_CHARS)
  if (omitted > 0) lines.push(`... (+${omitted} more; narrow the query)`)
  return lines.join('\n')
}

/** Nearest registered names for a mistyped/absent one, so recovery is one call. */
const suggestionsFor = (definitions, toolName) => {
  const terms = String(toolName).toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length > 1)
  if (terms.length === 0) return ''
  const scored = []
  for (const [name, definition] of definitions.entries()) {
    const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    const lower = name.toLowerCase()
    let score = 0
    for (const term of terms) {
      if (tokens.includes(term)) score += 4
      else if (tokens.some(token => token.length >= 3 && term.startsWith(token))) score += 2
      else if (lower.includes(term)) score += 1
    }
    if (score === 0) score = scoreTool(name, definition, terms)
    if (score > 0) scored.push([name, score])
  }
  scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return scored.slice(0, 3).map(([name]) => name).join(', ')
}

/** Actions themselves, so `name:"search"` gets a corrective hint instead of "unknown tool". */
const GATEWAY_ACTIONS = new Set(['search', 'describe', 'call', 'list'])

/**
 * Team tools are gated by session arming, not by the gateway catalog. Naming
 * them as "not gateway tools" without that condition sent a real Team Lead
 * session (2026-10-31, session-example) into a dead end: the tools were absent
 * from its catalog, the model tried `tool_gateway call list_agents`, and the
 * generic message told it "if it is visible, call it directly".
 */
const TEAM_TOOLS = new Set([
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

// The gateway can see registrations, not the caller's resolved catalog, so the
// wording stays conditional: "direct" here means "registered and not
// gateway-eligible", which is not the same as "listed for this turn" (a Team
// tool is registered even when the session never armed Team mode).
const ORDINARY_WAIT_HINT = 'For ordinary subagent results, continue useful work or end your turn; the runtime delivers the result in a new turn. Do not sleep, poll, or treat a subagent id as a job id.'
const directToolText = (toolName) => (TEAM_TOOLS.has(toolName)
  ? `"${toolName}" is a Team tool, not a gateway tool. Team tools are listed only when this session is a Team session; if it is not in your tool list right now, it is unavailable. Do not bypass that through the gateway.${toolName === 'wait_agent' || toolName === 'send_message' ? ' ' + ORDINARY_WAIT_HINT : ''}`
  : `"${toolName}" is not gateway-eligible. If it is visible in your tool list, call it directly; otherwise it is unavailable.`)

/** Argument keys the gateway accepts; anything else is a malformed call. */
const GATEWAY_ARG_KEYS = new Set(['action', 'name', 'input', 'calls', 'query', 'offset', 'full_output'])

/** Common keys the model emits when it translates this schema into Chinese. */
const ARG_ALIASES = new Map([
  ['操作', 'action'], ['动作', 'action'], ['行为', 'action'],
  ['名称', 'name'], ['工具', 'name'], ['工具名', 'name'], ['工具名称', 'name'],
  ['输入', 'input'], ['参数', 'input'], ['入参', 'input'],
  ['调用', 'calls'], ['查询', 'query'], ['偏移', 'offset'],
])

/**
 * Explain a malformed argument object instead of failing on its first key.
 * Full-width quotes (`“操作”`) never reach here — the host rejects the JSON
 * before any tool runs — so this only covers the parseable variant.
 */
const malformedArgumentsText = (args, unknown) => {
  const mapped = unknown.map(key => (ARG_ALIASES.has(key) ? `${key} → ${ARG_ALIASES.get(key)}` : key))
  const sample = JSON.stringify({ action: 'call', name: '<tool>', input: {} })
  return `unrecognized argument key(s): ${mapped.join(', ')}. `
    + `tool_gateway accepts only action / name / input / calls / query / offset / full_output, spelled in ASCII `
    + `(JSON strings use straight double quotes, not “ ”). Retry with e.g. ${sample}.`
}

const actionNameText = (toolName) => `"${toolName}" is a gateway action, not a tool name. Use action="${toolName}"${toolName === 'search' ? ' with a query' : toolName === 'call' ? ' with name and input' : ''} instead of passing it as name.`

/**
 * Top-level `required` properties the given input does not carry.
 * Union schemas (`oneOf`/`anyOf`/`allOf`) are skipped: their required sets are
 * conditional, and a false rejection would be worse than the generic error.
 */
const missingRequiredProperties = (schema, input) => {
  if (schema === null || typeof schema !== 'object') return []
  if (schema.oneOf !== undefined || schema.anyOf !== undefined || schema.allOf !== undefined) return []
  if (!Array.isArray(schema.required) || schema.required.length === 0) return []
  const given = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  return schema.required.filter(key => given[key] === undefined)
}

/**
 * A model sometimes serializes `input` twice and hands over a JSON string.
 * Parsing it is lossless and turns a wasted round into a working call; a
 * string that is not a JSON object still fails the normal validation.
 */
const normalizeInput = (input) => {
  if (typeof input !== 'string') return input
  try {
    const parsed = JSON.parse(input)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : input
  } catch {
    return input
  }
}

const unknownToolText = (definitions, toolName, hint, conditional = new Set()) => {
  if (conditional.has(toolName)) {
    return `"${toolName}" is conditionally registered and cannot be called through the gateway — it appears in your tool list only when its condition holds. ${hint}`
  }
  const near = suggestionsFor(definitions, toolName)
  return `Unknown tool "${toolName}".${near ? ` Closest names: ${near}.` : ''} ${hint}`
}

const definition = (ctx) => ({
  name: GATEWAY_NAME,
  description: [
    '`tool_gateway`: stable gateway for LEAN tools hidden from your tool list; search/call them here.',
    'NOT gateway tools — searching them only burns a round: your resident tools (bash/read/write/edit/todo_write/read_image/rule_load …); Team tools only when this session lists them (list_agents/send_message/spawn_teammate/interrupt_agent/wait_agent/team_task_*). `subagent` is resident at top level, `subagent_fork` is gateway-only there, and both are gateway-reachable from a delegation child — check your own tool list. Call every resident tool directly.',
    'ALWAYS SEARCH FIRST: call action="search" with a short family/keyword query before doing anything else. Do NOT call list first; use list only after search has no useful hit. Spaces join a concept; commas split alternatives. list is paged; follow the offset in its footer.',
    'If arguments are unknown, use action="describe" with name first, then action="call" with the exact name and input. The call still goes through normal approval and policy.',
    '',
    'Family index (approximate; action="list" is authoritative — anything absent is NOT reachable here):',
    // 0.2.2-rc.2: the browser-use playwright-mcp provider is disabled in the
    // desktop profile; the only mounted Playwright family is mcp-playwright's
    // persistent profile. Promising the disabled server cost a dead search.
    'browser_* sidebar browser; mcp__playwright-persist__* (logged-in profile) when unlocked; user_terminal_*; memory_*; session_* + search_history/history_context;',
    'terminal_*; search aggregator (tavily_search/anysearch_search/exa_search/deepseek_search/deepseek_fetch/search_provider_status);',
    'workflow_*; goal tools (create_goal/get_goal/update_goal); jobs (job_list/job_output/job_kill);',
    'dev_* (plugin build/inject/stage/patch/heal/reload/self-test); create_worktree; cua; apply_patch (one-call multi-file patch); batch; ralph; propose_action;',
    'grep, glob (content and filename search; moved out of the resident set); skill_search / skill_load (on-demand skills); load_workspace_dependencies; working_directory.',
    'REA: use the live mcp__rea__ catalog, not guessed IDA names or repeated doctor/setup. Large binary_session status is summarized with a complete result reference; full_output=true bypasses that summary.',
  ].join('\n'),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'describe', 'call', 'list'],
        description: 'Discovery first: search. Then describe if the input shape is unknown, then call.',
      },
      query: { type: 'string', description: 'Short family/keyword query for search.' },
      offset: { type: 'integer', minimum: 0, description: 'Paging offset for list (default 0); the footer prints the next offset.' },
      name: { type: 'string', description: 'Exact gateway-eligible tool name for describe/call.' },
      input: { type: 'object', additionalProperties: true, description: 'Arguments object for the hidden tool.' },
      full_output: { type: 'boolean', description: 'Bypass the LEAN REA status summary; Host spill limits still apply.' },
      calls: {
        type: 'array',
        maxItems: 8,
        description: 'Batch form of action="call": [{name, input}, …] runs several hidden tools in one step, in order.',
        items: { type: 'object', properties: { name: { type: 'string' }, input: { type: 'object' } }, required: ['name'] },
      },
    },
    required: ['action'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        content: { type: 'array', items: { type: 'object', additionalProperties: true } },
        statuses: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              index: { type: 'integer' }, name: { type: 'string' },
              status: { type: 'string', enum: ['ok', 'error'] }, message: { type: 'string' },
            },
            required: ['index', 'name', 'status'],
          },
        },
      },
    },
    // Partial batches retain success content; expose per-call outcomes in durable meta.
    presentationMeta: (_args, value) => value.statuses === undefined ? {} : { gatewayCalls: value.statuses },
    render: (_args, value) => (
      Array.isArray(value.content) && value.content.length > 0
        ? value.content
        : [{ type: 'text', text: value.text ?? '(tool completed with no output)' }]
    ),
  },
  async execute(args, exec) {
    // A long Chinese session can make the model translate the schema itself:
    // keys arrive as 操作/名称/输入 (and, before parsing, full-width quotes).
    // The bare "Unknown action" it used to get was unactionable; name the
    // contract instead so one retry fixes it.
    if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
      const unknown = Object.keys(args).filter(key => !GATEWAY_ARG_KEYS.has(key))
      if (unknown.length > 0) throw new Error(malformedArgumentsText(args, unknown))
    }
    const action = args?.action ?? (Array.isArray(args?.calls) ? 'call' : undefined)
    if (args?.full_output !== undefined && typeof args.full_output !== 'boolean') throw new Error('full_output must be a boolean.')
    if (Array.isArray(args?.calls) && action !== 'call') {
      throw new Error('calls only applies to action="call".')
    }
    const { definitions, direct, conditional } = catalogFor(ctx, exec?.agent)
    if (action === 'list') return { text: listText(definitions, args?.offset) }
    if (action === 'search') {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query.length === 0) throw new Error('Provide a non-empty query for search, or use action="list".')
      return { text: searchText(definitions, query, direct, conditional) }
    }
    if (action === 'describe') {
      const toolName = typeof args.name === 'string' ? args.name.trim() : ''
      if (toolName.length === 0) throw new Error('Provide the exact tool name for action="describe".')
      if (GATEWAY_ACTIONS.has(toolName)) throw new Error(actionNameText(toolName))
      const target = definitions.get(toolName)
      if (target === undefined) {
        if (direct.has(toolName)) throw new Error(directToolText(toolName))
        if (TEAM_TOOLS.has(toolName)) throw new Error(directToolText(toolName))
        throw new Error(unknownToolText(definitions, toolName, 'Use action="search" or action="list" first.', conditional))
      }
      return {
        text: JSON.stringify({
          name: toolName,
          description: target.description,
          parameters: target.parameters,
        }, null, 2),
      }
    }
    if (action !== 'call') throw new Error(`Unknown action: ${String(action)}`)

    if (Array.isArray(args.calls)) return callBatch(args.calls)

    const toolName = typeof args.name === 'string' ? args.name.trim() : ''
    if (toolName.length === 0) throw new Error('Provide the exact tool name for action="call".')
    if (toolName === GATEWAY_NAME) throw new Error('tool_gateway cannot call itself.')
    if (GATEWAY_ACTIONS.has(toolName)) throw new Error(actionNameText(toolName))
    if (!definitions.has(toolName)) {
      if (direct.has(toolName)) throw new Error(directToolText(toolName))
      if (TEAM_TOOLS.has(toolName)) throw new Error(directToolText(toolName))
      throw new Error(unknownToolText(definitions, toolName, 'Use action="search" or action="list" to find the exact name.', conditional))
    }
    const input = normalizeInput(args.input)
    if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
      throw new Error('input must be a JSON object.')
    }
    // A hidden tool's schema is invisible until `describe`, so a wrong field
    // name only surfaces as the executor's generic rejection. Naming every
    // missing property in one message turns the guess-and-retry loop into one
    // round: measured in session-example, where `update_goal` cost two failed
    // calls (`id`/`phase`, then `expected_revision`) before the third succeeded.
    const schema = definitions.get(toolName)?.parameters
    const missing = missingRequiredProperties(schema, input)
    if (missing.length > 0) {
      throw new Error(`invalid arguments for "${toolName}": missing required ${missing.map(key => `"${key}"`).join(', ')}. Required: ${schema.required.join(', ')}. Call action="describe" with name="${toolName}" for the exact schema.`)
    }
    const settled = await ctx.tools.execute({
      calls: [{
        id: `gateway-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: toolName,
        arguments: JSON.stringify(input ?? {}),
      }],
      agent: exec.agent,
      signal: exec.signal,
      toolSet: privateToolSet(ctx, definitions, exec.agent),
    })
    for (const context of settled?.additionalContexts ?? []) exec.deferContext(context)
    if (settled?.concluded === true) exec.concludeTurn()
    const projected = await projectReaStatus(ctx, exec, toolName, canonicalResultAt(settled, 0), args.full_output)
    return resultValue({ results: [{ result: projected }] })

    /** Validate every item first, then run them as one executor batch. */
    async function callBatch(items) {
      if (typeof args.name === 'string' && args.name.trim().length > 0) {
        throw new Error('Use either name+input or calls, not both.')
      }
      if (items.length === 0 || items.length > 8) throw new Error('calls must contain 1–8 items.')
      const prepared = items.map((item, index) => {
        const name = typeof item?.name === 'string' ? item.name.trim() : ''
        if (name.length === 0) throw new Error(`calls[${index}]: provide the exact tool name.`)
        if (name === GATEWAY_NAME) throw new Error('tool_gateway cannot call itself.')
        if (GATEWAY_ACTIONS.has(name)) throw new Error(actionNameText(name))
        if (!definitions.has(name)) {
          if (direct.has(name) || TEAM_TOOLS.has(name)) throw new Error(directToolText(name))
          throw new Error(unknownToolText(definitions, name, 'Use action="search" or action="list" to find the exact name.', conditional))
        }
        const input = normalizeInput(item?.input)
        if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
          throw new Error(`calls[${index}]: input must be a JSON object.`)
        }
        const schema = definitions.get(name)?.parameters
        const missing = missingRequiredProperties(schema, input)
        if (missing.length > 0) {
          throw new Error(`calls[${index}] "${name}": missing required ${missing.map(key => `"${key}"`).join(', ')}. Required: ${schema.required.join(', ')}. Call action="describe" with name="${name}" for the exact schema.`)
        }
        return { name, input }
      })
      const settled = await ctx.tools.execute({
        calls: prepared.map((item, index) => ({
          id: `gateway-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`,
          name: item.name,
          arguments: JSON.stringify(item.input ?? {}),
        })),
        agent: exec.agent,
        signal: exec.signal,
        toolSet: privateToolSet(ctx, definitions, exec.agent),
      })
      for (const context of settled?.additionalContexts ?? []) exec.deferContext(context)
      if (settled?.concluded === true) exec.concludeTurn()
      if (!Array.isArray(settled?.results)) return batchResult(settled, prepared.map(item => item.name))
      const projected = { results: [] }
      for (let index = 0; index < prepared.length; index += 1) {
        const entry = settled?.results?.[index]
        projected.results.push(entry?.result !== undefined && entry.result !== null && typeof entry.result === 'object'
          ? { ...entry, result: await projectReaStatus(ctx, exec, prepared[index].name, entry.result, args.full_output) }
          : entry)
      }
      return batchResult(projected, prepared.map(item => item.name))
    }
  },
})

/** Register one fixed-schema gateway; the private catalog is resolved per call. */
export function apply(ctx) {
  ctx.tools.register(definition(ctx))
}
