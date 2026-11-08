#!/usr/bin/env node
/**
 * lean-session-metrics — reproducible metrics for real DSH session logs.
 *
 * Reads the append-only session event log
 *   ~/.dsh/sessions/<encoded-cwd>/<sessionId>/session.v4.jsonl[.zstd]
 * and the token ledger
 *   ~/.dsh/stats-panel/records.jsonl
 * and emits per-session + aggregate metrics that A/B decisions can be based on.
 *
 * Zero dependencies: zstd decompression uses node:zlib when available and
 * falls back to the `zstd -dc` CLI; plain .jsonl logs are read directly.
 *
 * Measured conventions (verified against real logs, 2026-10-30):
 *   - `request/header.data.reason` observed values: initial | change | resume | series.
 *     A header is emitted per request series, NOT per model call, so the number of
 *     headers is not the number of requests.
 *   - `step/start` is one model round trip -> `requests` counts step/start events.
 *   - `tool/result.data.message.toolCallId` joins `tool/call.data.callId`.
 *     Log materialisation can repeat the same result event (once per
 *     compaction/prune replay), so results are de-duplicated by toolCallId and
 *     the first occurrence wins.
 *   - `stats-panel/records.jsonl.seq` joins `assistant/message.seq` (0 of 1820
 *     request/header seqs matched, 100% of sampled records matched a message).
 *     Tokens are therefore attributed per assistant message and bucketed into a
 *     phase by the header that governs the enclosing step.
 *   - A header belongs to the step/start it follows (observed seq delta 1-2), so
 *     phase attribution uses the header inside each step window and carries it
 *     forward; taking "the nearest header with a smaller seq" would mis-bucket
 *     the first step after every promotion.
 *   - `tool/result.message.isError` is a harness-level failure flag. A bash
 *     command that exits non-zero still returns a normal result; LEAN's
 *     custom-bash appends `[exit code: N]` only on non-zero exit, so
 *     `shell.nonZeroExit` is the closest measurement of real command failure.
 *   - A gateway `search` with no candidate is a normal result
 *     ("No gateway-eligible tools match …"), not an error: it is counted as
 *     `noMatchSearches`, and `failedThenRetry` counts a gateway call that
 *     immediately follows a miss or an isError.
 *   - Tool schema cost = sum of JSON.stringify(tool).length over
 *     `request/header.data.header.tools`; this reproduces the handoff figures
 *     8053 / 13385 / 12852 / 18184 exactly.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
// Namespace import keeps older runtimes importable; zstd support is probed at use.
import * as zlib from 'node:zlib'

export const TOOL_NAME = 'lean-session-metrics'
export const TOOL_VERSION = '1.0.0'
export const GATEWAY_TOOL = 'tool_gateway'
export const SESSION_LOG_NAME = 'session.v4.jsonl'
export const DEFAULT_SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')
export const DEFAULT_RECORDS = join(homedir(), '.dsh', 'stats-panel', 'records.jsonl')
const DEFAULT_PRESET = 'lean'
const MAX_WALK_DEPTH = 4

export class UsageError extends Error {}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const asArray = value => (Array.isArray(value) ? value : [])
const asNumber = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const asString = value => (typeof value === 'string' ? value : '')

/* ------------------------------------------------------------------ CLI ---- */

const FLAGS = new Map([
  ['--sessions-root', 'sessionsRoot'],
  ['--records', 'records'],
  ['--preset', 'preset'],
  ['--since', 'since'],
  ['--session', 'session'],
  ['--limit', 'limit'],
  ['--top', 'top'],
])

const BOOLEANS = new Map([
  ['--json', 'json'],
  ['--verbose', 'verbose'],
  ['--help', 'help'],
  ['-h', 'help'],
])

/** Parse argv into options. Unknown options throw UsageError (exit code 2). */
export function parseArgs(argv = []) {
  const options = {
    sessionsRoot: DEFAULT_SESSIONS_ROOT,
    records: DEFAULT_RECORDS,
    preset: DEFAULT_PRESET,
    since: null,
    session: null,
    limit: null,
    top: 15,
    json: false,
    verbose: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    if (raw === '--') break
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1
    const flag = eq === -1 ? raw : raw.slice(0, eq)
    const inline = eq === -1 ? undefined : raw.slice(eq + 1)
    if (BOOLEANS.has(flag)) {
      if (inline !== undefined) throw new UsageError(`${flag} does not take a value`)
      options[BOOLEANS.get(flag)] = true
      continue
    }
    if (!FLAGS.has(flag)) throw new UsageError(`unknown option: ${raw}`)
    const key = FLAGS.get(flag)
    const value = inline !== undefined ? inline : argv[index + 1]
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      throw new UsageError(`${flag} requires a value`)
    }
    if (inline === undefined) index += 1
    options[key] = value
  }
  if (options.since !== null) {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(options.since) ? new Date(`${options.since}T00:00:00`) : null
    if (parsed === null || Number.isNaN(parsed.getTime())) {
      throw new UsageError(`--since must be YYYY-MM-DD, got ${options.since}`)
    }
    options.sinceMs = parsed.getTime()
  } else {
    options.sinceMs = null
  }
  if (options.limit !== null) {
    const limit = Number(options.limit)
    if (!Number.isInteger(limit) || limit <= 0) throw new UsageError(`--limit must be a positive integer, got ${options.limit}`)
    options.limit = limit
  }
  const top = Number(options.top)
  if (!Number.isInteger(top) || top <= 0) throw new UsageError(`--top must be a positive integer, got ${options.top}`)
  options.top = top
  return options
}

export function usageText() {
  return [
    `${TOOL_NAME} ${TOOL_VERSION} — real DSH session metrics for the lean preset`,
    '',
    'Usage:',
    '  node tools/lean-session-metrics.mjs [options]',
    '',
    'Options:',
    '  --preset <name>        session preset to select (default: lean)',
    '  --since <YYYY-MM-DD>   only sessions created on/after this local date',
    '  --session <id|prefix>  only sessions whose directory/session id starts with this',
    '  --limit <N>            only the N most recent matching sessions',
    '  --json                 print the full report as JSON',
    '  --top <N>              rows per distribution table (default: 15)',
    '  --sessions-root <dir>  override ~/.dsh/sessions',
    '  --records <file>       override ~/.dsh/stats-panel/records.jsonl',
    '  --verbose              add raw per-session tool/schema detail',
    '  -h, --help             show this help',
    '',
    'Metric conventions are documented at the top of tools/lean-session-metrics.mjs.',
  ].join('\n')
}

/* --------------------------------------------------------------- reading ---- */

/**
 * Decompress a session log to bytes. Plain .jsonl is supported for tests.
 * `deps` exists so the CLI fallback can be exercised on runtimes that do have
 * node:zlib zstd support.
 */
export function readSessionBytes(file, deps = {}) {
  const zstdDecompress = 'zstdDecompress' in deps ? deps.zstdDecompress : zlib.zstdDecompressSync
  const runCli = deps.execFile ?? execFileSync
  const buffer = readFileSync(file)
  if (file.endsWith('.zstd')) {
    if (typeof zstdDecompress === 'function') {
      return { buffer: zstdDecompress(buffer), encoding: 'zstd:zlib' }
    }
    const text = runCli('zstd', ['-dc', file], { maxBuffer: 2 * 1024 * 1024 * 1024, encoding: 'utf8' })
    return { buffer: Buffer.from(text, 'utf8'), encoding: 'zstd:cli' }
  }
  if (file.endsWith('.jsonl')) return { buffer, encoding: 'plain' }
  throw new Error(`unsupported session log file: ${file}`)
}

/** Decompress a session log to UTF-8 text (kept for tests and small inputs). */
export function readSessionText(file, deps = {}) {
  const { buffer, encoding } = readSessionBytes(file, deps)
  return { text: buffer.toString('utf8'), encoding }
}

/** Parse JSONL into events; malformed lines are counted, never dropped silently. */
export function parseEvents(text) {
  const events = []
  let malformedLines = 0
  let blankLines = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      blankLines += 1
      continue
    }
    try {
      const value = JSON.parse(line)
      if (isObject(value)) events.push(value)
      else malformedLines += 1
    } catch {
      malformedLines += 1
    }
  }
  return { events, malformedLines, blankLines }
}

/**
 * Everything the metrics need from a header, computed once. Kept separate so a
 * compacted event can carry the derived values instead of the full schemas.
 */
export function headerDerived(tools) {
  const names = tools.map(tool => asString(tool?.name)).filter(Boolean)
  return {
    toolNames: names.slice().sort(),
    signature: signatureOf(tools),
    schemaChars: schemaCharsOf(tools),
    schemaCharsByTool: toolSchemaChars(tools),
  }
}

/**
 * Reduce one parsed log record to the fields the metrics read. The full event
 * can be tens of KB (replay state, MCP schemas, tool output); retaining it for
 * every line is what makes a whole-corpus scan cost ~1.6 GB.
 */
export function compactEvent(value) {
  const type = value.type
  const seq = value.seq
  const data = value.data ?? {}
  switch (type) {
    case 'session':
      return {
        type,
        id: value.id,
        createdAt: value.createdAt,
        cwd: value.cwd,
        agentPreset: value.agentPreset,
        delegationDepth: value.delegationDepth,
        origin: value.origin,
      }
    case 'agent-preset/selected':
      return { type, data: { agentPreset: data.agentPreset } }
    case 'request/header':
      return {
        type,
        seq,
        data: {
          reason: data.reason,
          header: {
            config: { model: data.header?.config?.model },
            derived: headerDerived(asArray(data.header?.tools)),
          },
        },
      }
    case 'step/start':
      return { type, seq }
    case 'turn/end':
      return { type, data: { reason: { kind: data.reason?.kind } } }
    case 'assistant/message':
      return { type, seq }
    case 'tool/call':
      return { type, seq, data: { callId: data.callId, name: data.name, arguments: data.arguments, turn: data.turn, step: data.step } }
    case 'tool/result': {
      const message = data.message ?? {}
      const text = messageText(message)
      const exit = /\[exit code: (-?\d+)\]/.exec(text)
      return {
        type,
        seq,
        data: {
          toolCallId: data.toolCallId,
          message: { toolCallId: message.toolCallId, isError: message.isError === true },
          result: {
            exitCode: exit === null ? null : Number(exit[1]),
            noMatch: /No gateway-eligible tools match/.test(text),
          },
        },
      }
    }
    default:
      return { type }
  }
}

/**
 * Parse a session log (UTF-8 string or decompressed Buffer) into compact events.
 * Malformed lines are counted, never dropped silently. Buffer input is split on
 * newline bytes so a 134 MB log never becomes a single JS string.
 */
export function parseSessionLog(input) {
  const events = []
  let malformedLines = 0
  let blankLines = 0
  const handle = line => {
    if (line.trim().length === 0) {
      blankLines += 1
      return
    }
    let value
    try {
      value = JSON.parse(line)
    } catch {
      malformedLines += 1
      return
    }
    if (!isObject(value)) {
      malformedLines += 1
      return
    }
    events.push(compactEvent(value))
  }
  if (Buffer.isBuffer(input)) {
    let start = 0
    for (let index = 0; index <= input.length; index += 1) {
      if (index !== input.length && input[index] !== 10) continue
      if (index > start) handle(input.toString('utf8', start, index))
      else blankLines += 1
      start = index + 1
    }
  } else {
    for (const line of input.split('\n')) handle(line)
  }
  return { events, malformedLines, blankLines }
}

/** Recursively collect session logs, preferring .zstd over a sibling .jsonl. */
export function findSessionFiles(root) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > MAX_WALK_DEPTH) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const names = new Set(entries.map(entry => entry.name))
    if (names.has(`${SESSION_LOG_NAME}.zstd`)) {
      found.push(join(dir, `${SESSION_LOG_NAME}.zstd`))
    } else if (names.has(SESSION_LOG_NAME)) {
      found.push(join(dir, SESSION_LOG_NAME))
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      walk(join(dir, entry.name), depth + 1)
    }
  }
  walk(root, 0)
  return found.sort()
}

/** Load records.jsonl into sessionId -> ascending-by-seq records (bad lines counted). */
export function loadRecords(file) {
  const bySession = new Map()
  let lines = 0
  let malformedLines = 0
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { bySession, lines, malformedLines, readable: false, error: error.message }
  }
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    lines += 1
    let record
    try {
      record = JSON.parse(line)
    } catch {
      malformedLines += 1
      continue
    }
    if (!isObject(record) || typeof record.sessionId !== 'string' || typeof record.seq !== 'number') {
      malformedLines += 1
      continue
    }
    if (!bySession.has(record.sessionId)) bySession.set(record.sessionId, [])
    bySession.get(record.sessionId).push(record)
  }
  for (const records of bySession.values()) records.sort((a, b) => a.seq - b.seq)
  return { bySession, lines, malformedLines, readable: true, error: null }
}

/* ------------------------------------------------------------- per session -- */

const signatureOf = tools => tools.map(tool => asString(tool?.name)).filter(Boolean).sort().join(',')

const schemaCharsOf = tools => tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0)

const toolSchemaChars = tools => {
  const out = {}
  for (const tool of tools) {
    const name = asString(tool?.name)
    if (name.length === 0) continue
    out[name] = (out[name] ?? 0) + JSON.stringify(tool).length
  }
  return out
}

const messageText = message => asArray(message?.content)
  .map(block => (block?.type === 'text' ? asString(block.text) : ''))
  .join('\n')

const resultIsError = message => message?.isError === true

const GATEWAY_ACTIONS = new Set(['search', 'describe', 'call', 'list'])

const parseArguments = raw => {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {}
  try {
    const value = JSON.parse(raw)
    return isObject(value) ? value : {}
  } catch {
    return null
  }
}

const gatewayErrorKind = (action, text) => {
  if (/No gateway-eligible tools match/.test(text)) return 'search-no-match'
  if (/Provide a non-empty query|Provide the exact tool name/.test(text)) return 'missing-argument'
  if (/Unknown tool "|is not gateway-eligible|cannot call itself/.test(text)) return 'unknown-tool'
  if (/Unknown action:/.test(text)) return 'unknown-action'
  return action === 'call' ? 'call-failed' : `${action || 'gateway'}-failed`
}

const emptyGateway = () => ({
  calls: 0,
  actions: { search: 0, describe: 0, call: 0, list: 0, other: 0 },
  errors: 0,
  errorKinds: {},
  noMatchSearches: 0,
  acquisitions: 0,
  sequences: 0,
  sequenceLengths: [],
  searchThenCall: 0,
  callWithoutSearch: 0,
  failedThenRetry: 0,
  capabilities: {},
  callsPerAcquisition: null,
  avgSequenceLength: null,
})

/**
 * Build one session's metrics from its event log plus the token ledger.
 * Every field is derived from events; nothing is inferred from the file path
 * except the session id (which is also read from the `session` event).
 */
export function buildSessionMetrics({ id, file, events, malformedLines = 0, encoding = 'unknown', records = [], now = null }) {
  const degrade = []
  const sessionEvent = events.find(event => event.type === 'session') ?? null
  const sessionId = asString(sessionEvent?.id) || id
  const declaredPreset = asString(sessionEvent?.agentPreset) || null
  const presetSwitches = events
    .filter(event => event.type === 'agent-preset/selected')
    .map(event => asString(event.data?.agentPreset))
    .filter(Boolean)
  const effectivePreset = presetSwitches.length > 0 ? presetSwitches[presetSwitches.length - 1] : declaredPreset
  if (sessionEvent === null) degrade.push('no-session-event')
  if (declaredPreset === null) degrade.push('no-preset-field')
  if (effectivePreset !== declaredPreset) degrade.push(`preset-switched:${declaredPreset}->${effectivePreset}`)
  if (malformedLines > 0) degrade.push(`malformed-lines:${malformedLines}`)

  // ---- headers: catalog snapshots (one per request series, not per request)
  const headers = []
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const data = event.data ?? {}
    // Compacted events carry the derived catalog metrics; full events compute them.
    const derived = data.header?.derived ?? headerDerived(asArray(data.header?.tools))
    headers.push({
      seq: asNumber(event.seq),
      reason: asString(data.reason) || '(missing)',
      toolCount: derived.toolNames.length,
      signature: derived.signature,
      toolNames: derived.toolNames,
      schemaChars: derived.schemaChars,
      schemaCharsByTool: derived.schemaCharsByTool,
      model: asString(data.header?.config?.model) || null,
    })
  }
  headers.sort((a, b) => a.seq - b.seq)
  const initialHeader = headers[0] ?? null
  if (initialHeader === null) {
    degrade.push('no-request-header')
  } else if (initialHeader.reason !== 'initial') {
    degrade.push(`first-header-reason:${initialHeader.reason}`)
  }
  const headerReasons = {}
  for (const header of headers) headerReasons[header.reason] = (headerReasons[header.reason] ?? 0) + 1

  // ---- requests / turns / steps
  let steps = 0
  const stepSeqs = []
  for (const event of events) {
    if (event.type !== 'step/start') continue
    steps += 1
    stepSeqs.push(asNumber(event.seq))
  }
  stepSeqs.sort((a, b) => a - b)
  const assistantMessages = events.filter(event => event.type === 'assistant/message')
  const turns = events.filter(event => event.type === 'turn/end').length
  const turnErrors = events.filter(event => event.type === 'turn/end' && event.data?.reason?.kind === 'error').length
  const compactions = events.filter(event => event.type === 'compaction/end').length
  if (steps === 0 && assistantMessages.length === 0 && headers.length > 0) degrade.push('no-model-steps')

  // ---- tool calls, de-duplicated by callId, joined to first result per callId
  const calls = new Map()
  let duplicateCalls = 0
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const callId = asString(event.data?.callId)
    if (callId.length === 0) {
      degrade.push('tool-call-without-id')
      continue
    }
    if (calls.has(callId)) {
      duplicateCalls += 1
      continue
    }
    calls.set(callId, {
      callId,
      seq: asNumber(event.seq),
      name: asString(event.data?.name) || '(missing)',
      arguments: event.data?.arguments,
      turn: asNumber(event.data?.turn),
      step: asNumber(event.data?.step),
    })
  }
  const results = new Map()
  let duplicateResults = 0
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const message = event.data?.message ?? {}
    const callId = asString(message.toolCallId) || asString(event.data?.toolCallId)
    if (callId.length === 0) {
      degrade.push('tool-result-without-id')
      continue
    }
    if (results.has(callId)) {
      duplicateResults += 1
      continue
    }
    results.set(callId, {
      seq: asNumber(event.seq),
      isError: resultIsError(message),
      text: messageText(message),
      // undefined means "not pre-computed"; null means "no exit marker seen".
      exitCode: event.data?.result?.exitCode,
      noMatch: event.data?.result?.noMatch,
    })
  }
  const orderedCalls = [...calls.values()].sort((a, b) => a.seq - b.seq)
  let pendingCalls = 0
  for (const call of orderedCalls) {
    const result = results.get(call.callId)
    if (result === undefined) {
      pendingCalls += 1
      call.isError = null
    } else {
      call.isError = result.isError
      call.resultText = result.text
      call.resultSeq = result.seq
      call.exitCode = result.exitCode
      call.noMatch = result.noMatch
    }
  }
  const resolved = orderedCalls.filter(call => call.isError !== null)
  const toolErrors = resolved.filter(call => call.isError === true).length
  if (pendingCalls > 0) degrade.push(`calls-without-result:${pendingCalls}`)
  if (duplicateResults > 0) degrade.push(`duplicate-result-events:${duplicateResults}`)
  if (duplicateCalls > 0) degrade.push(`duplicate-call-events:${duplicateCalls}`)

  const toolCounts = {}
  const toolErrorCounts = {}
  for (const call of orderedCalls) {
    toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1
    if (call.isError === true) toolErrorCounts[call.name] = (toolErrorCounts[call.name] ?? 0) + 1
  }
  const firstCall = orderedCalls[0] ?? null

  // `isError` is a harness-level failure flag: a bash command that exits 1 or
  // 127 still returns a normal result. LEAN's custom-bash appends a
  // `[exit code: N]` marker only for non-zero exits, so this is the closest
  // measurement of real command failure.
  let shellCalls = 0
  let shellNonZeroExit = 0
  const shellExitCodes = {}
  for (const call of orderedCalls) {
    if (call.name !== 'bash') continue
    shellCalls += 1
    const derived = call.exitCode
    const match = derived === undefined ? /\[exit code: (-?\d+)\]/.exec(asString(call.resultText)) : null
    const code = derived === undefined ? (match === null ? null : match[1]) : derived
    if (code === null) continue
    shellExitCodes[code] = (shellExitCodes[code] ?? 0) + 1
    if (code !== 0 && code !== '0') shellNonZeroExit += 1
  }

  // ---- phases: bucket each request by the header that governed it.
  // A header is appended right after the step/start it belongs to (observed
  // delta 1-2 seqs), so the governing header for step i is the first header
  // inside (steps[i], steps[i+1]); otherwise it carries over from step i-1.
  const headersInStepWindow = (from, to) => {
    let found = null
    for (const header of headers) {
      if (header.seq > from && (to === null || header.seq < to)) found = header
      if (to !== null && header.seq >= to) break
    }
    return found
  }
  const headerForSeq = seq => {
    let found = null
    for (const header of headers) {
      if (header.seq <= seq) found = header
      else break
    }
    return found
  }
  const governingByStep = []
  let carried = null
  for (let index = 0; index < stepSeqs.length; index += 1) {
    const next = index + 1 < stepSeqs.length ? stepSeqs[index + 1] : null
    const inside = headersInStepWindow(stepSeqs[index], next)
    if (inside !== null) carried = inside
    else if (index === 0) carried = headerForSeq(stepSeqs[0] - 1)
    governingByStep.push(carried)
  }
  /** Governing header for any event seq (assistant messages live inside a step window). */
  const governingFor = seq => {
    if (stepSeqs.length === 0) return headerForSeq(seq)
    let index = -1
    for (let cursor = 0; cursor < stepSeqs.length; cursor += 1) {
      if (stepSeqs[cursor] < seq) index = cursor
      else break
    }
    if (index === -1) return headerForSeq(seq)
    return governingByStep[index] ?? headerForSeq(seq)
  }
  const initialSignature = initialHeader?.signature ?? null
  const phase = {
    initialSignature,
    initialToolCount: initialHeader?.toolCount ?? null,
    initialTools: initialHeader?.toolNames ?? [],
    initialSchemaChars: initialHeader?.schemaChars ?? null,
    schemaCharsByTool: initialHeader?.schemaCharsByTool ?? {},
    initialModel: initialHeader?.model ?? null,
    bootstrapRequests: 0,
    promotedRequests: 0,
    unattributedRequests: 0,
  }
  for (let index = 0; index < stepSeqs.length; index += 1) {
    const header = governingByStep[index]
    if (header === null) phase.unattributedRequests += 1
    else if (initialSignature !== null && header.signature === initialSignature) phase.bootstrapRequests += 1
    else phase.promotedRequests += 1
  }
  if (phase.unattributedRequests > 0) degrade.push(`requests-before-first-header:${phase.unattributedRequests}`)

  // ---- gateway behaviour
  const gateway = emptyGateway()
  gateway.calls = orderedCalls.filter(call => call.name === GATEWAY_TOOL).length
  // Walk every tool call in seq order so "contiguous" means "no other tool call in between".
  let previousGateway = null
  let previousWasAdjacent = false
  let sequence = null
  const closeSequence = () => {
    if (sequence === null) return
    gateway.sequences += 1
    gateway.sequenceLengths.push(sequence.length)
    sequence = null
  }
  for (let index = 0; index < orderedCalls.length; index += 1) {
    const call = orderedCalls[index]
    if (call.name !== GATEWAY_TOOL) {
      closeSequence()
      previousWasAdjacent = false
      continue
    }
    const args = parseArguments(call.arguments)
    if (args === null) degrade.push('gateway-unparseable-arguments')
    const action = asString(args?.action) || '(missing)'
    if (GATEWAY_ACTIONS.has(action)) gateway.actions[action] += 1
    else gateway.actions.other += 1
    const adjacent = index > 0 && orderedCalls[index - 1].name === GATEWAY_TOOL
    if (!adjacent) {
      closeSequence()
      sequence = { length: 0, searched: false, endedWithSuccess: false }
    }
    sequence.length += 1
    if (action === 'search') sequence.searched = true

    // A search with no candidate is a normal (non-error) result in the gateway:
    // it is counted separately as a miss instead of an isError failure.
    const noMatch = action === 'search'
      && (call.noMatch === undefined ? /No gateway-eligible tools match/.test(asString(call.resultText)) : call.noMatch)
    if (noMatch) gateway.noMatchSearches += 1
    if (call.isError === true) {
      gateway.errors += 1
      const kind = gatewayErrorKind(action, asString(call.resultText))
      gateway.errorKinds[kind] = (gateway.errorKinds[kind] ?? 0) + 1
    }
    // Any gateway call issued right after a failed or missed one is a retry.
    if (previousGateway !== null && previousWasAdjacent && (previousGateway.isError === true || previousGateway.miss === true)) {
      gateway.failedThenRetry += 1
    }
    if (call.isError === false && action === 'call') {
      gateway.acquisitions += 1
      sequence.endedWithSuccess = true
      const capability = asString(args?.name) || '(missing)'
      gateway.capabilities[capability] = (gateway.capabilities[capability] ?? 0) + 1
      if (previousGateway !== null && previousWasAdjacent && previousGateway.action === 'search') {
        gateway.searchThenCall += 1
      } else {
        gateway.callWithoutSearch += 1
      }
    }
    previousGateway = { action, isError: call.isError, miss: noMatch }
    previousWasAdjacent = true
  }
  closeSequence()
  if (gateway.calls > 0) {
    gateway.callsPerAcquisition = gateway.acquisitions > 0 ? gateway.calls / gateway.acquisitions : null
    gateway.avgSequenceLength = gateway.sequences > 0 ? gateway.calls / gateway.sequences : null
  }

  // ---- tokens: seq joins assistant/message, phase by most recent header
  const tokens = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    records: 0, matched: 0, unmatched: 0, duplicateSeq: 0,
    byModel: {}, byPhase: { bootstrap: 0, promoted: 0, unattributed: 0 },
    coverage: assistantMessages.length > 0 ? 0 : null,
  }
  const messageSeqs = new Set(assistantMessages.map(event => asNumber(event.seq)))
  const seenRecordSeq = new Set()
  for (const record of records) {
    tokens.records += 1
    if (seenRecordSeq.has(record.seq)) tokens.duplicateSeq += 1
    seenRecordSeq.add(record.seq)
    const input = asNumber(record.inputTokens)
    const output = asNumber(record.outputTokens)
    const cacheRead = asNumber(record.cacheReadTokens)
    const cacheWrite = asNumber(record.cacheWriteTokens)
    const reasoning = asNumber(record.reasoningTokens)
    if (!messageSeqs.has(record.seq)) {
      tokens.unmatched += 1
      continue
    }
    tokens.matched += 1
    tokens.input += input
    tokens.output += output
    tokens.cacheRead += cacheRead
    tokens.cacheWrite += cacheWrite
    tokens.reasoning += reasoning
    const model = asString(record.model) || '(unknown)'
    tokens.byModel[model] ??= { records: 0, input: 0, output: 0, cacheRead: 0 }
    tokens.byModel[model].records += 1
    tokens.byModel[model].input += input
    tokens.byModel[model].output += output
    tokens.byModel[model].cacheRead += cacheRead
    const header = governingFor(record.seq)
    if (header === null) tokens.byPhase.unattributed += 1
    else if (initialSignature !== null && header.signature === initialSignature) tokens.byPhase.bootstrap += 1
    else tokens.byPhase.promoted += 1
  }
  if (tokens.records === 0 && assistantMessages.length > 0) degrade.push('no-token-records')
  if (tokens.unmatched > 0) degrade.push(`token-records-unmatched:${tokens.unmatched}`)
  tokens.coverage = assistantMessages.length > 0 ? tokens.matched / assistantMessages.length : null

  const createdAt = asNumber(sessionEvent?.createdAt)
    || (events.length > 0 ? asNumber(events[0].time) : (now ?? Date.now()))
  const origin = asString(sessionEvent?.origin) || (asNumber(sessionEvent?.delegationDepth) > 0 ? 'subagent' : 'main')

  return {
    id: sessionId,
    dirId: id,
    file,
    createdAt,
    createdAtIso: new Date(createdAt).toISOString(),
    cwd: asString(sessionEvent?.cwd) || null,
    origin,
    delegationDepth: asNumber(sessionEvent?.delegationDepth),
    preset: declaredPreset,
    effectivePreset,
    presetSwitches,
    encoding,
    malformedLines,
    degrade,
    turns,
    turnErrors,
    compactions,
    requests: steps,
    // One step == one model round trip in this harness, so steps and requests match.
    steps,
    assistantMessages: assistantMessages.length,
    headers: headers.length,
    headerReasons,
    toolCalls: orderedCalls.length,
    toolResults: results.size,
    duplicateResults,
    duplicateCalls,
    pendingCalls,
    resolvedResults: resolved.length,
    toolErrors,
    errorRate: resolved.length > 0 ? toolErrors / resolved.length : null,
    firstTool: firstCall === null ? null : { name: firstCall.name, isError: firstCall.isError, seq: firstCall.seq },
    toolCounts,
    toolErrorCounts,
    firstCallIsRead: firstCall?.name === 'read',
    shell: {
      calls: shellCalls,
      nonZeroExit: shellNonZeroExit,
      nonZeroExitRate: shellCalls > 0 ? shellNonZeroExit / shellCalls : null,
      exitCodes: shellExitCodes,
    },
    phase,
    gateway,
    tokens,
  }
}

/* -------------------------------------------------------------- aggregate --- */

/** Nearest-rank quantile on a numeric array (already unsorted input accepted). */
export function quantile(values, percentile) {
  const sorted = values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const rank = Math.ceil((percentile / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

const sumField = (sessions, read) => sessions.reduce((sum, session) => sum + (read(session) ?? 0), 0)

const statsOf = (values, label) => {
  const clean = values.filter(value => typeof value === 'number' && Number.isFinite(value))
  if (clean.length === 0) return { label, n: 0, mean: null, p50: null, p90: null, max: null, sum: 0 }
  const sum = clean.reduce((total, value) => total + value, 0)
  return {
    label,
    n: clean.length,
    sum,
    mean: sum / clean.length,
    p50: quantile(clean, 50),
    p90: quantile(clean, 90),
    max: Math.max(...clean),
  }
}

const mergeCounts = (target, source) => {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value
  return target
}

const epochLabel = index => `E${index + 1}`

/**
 * Group sessions by the tool-name list of their first request header.
 * Epochs are ordered by first appearance; the label is derived from data only.
 */
export function groupEpochs(sessions) {
  const groups = new Map()
  for (const session of sessions) {
    const signature = session.phase.initialSignature ?? '(no-header)'
    if (!groups.has(signature)) {
      groups.set(signature, {
        signature,
        toolCount: session.phase.initialToolCount,
        tools: session.phase.initialTools,
        schemaChars: session.phase.initialSchemaChars,
        sessions: [],
      })
    }
    groups.get(signature).sessions.push(session)
  }
  const epochs = [...groups.values()].sort((a, b) => {
    const firstA = Math.min(...a.sessions.map(session => session.createdAt))
    const firstB = Math.min(...b.sessions.map(session => session.createdAt))
    return firstA - firstB || b.sessions.length - a.sessions.length
  })
  return epochs.map((epoch, index) => {
    const createdAts = epoch.sessions.map(session => session.createdAt).sort((a, b) => a - b)
    return {
      label: epochLabel(index),
      signature: epoch.signature,
      toolCount: epoch.toolCount,
      tools: epoch.tools,
      schemaChars: epoch.schemaChars,
      sessions: epoch.sessions.length,
      firstSeen: new Date(createdAts[0]).toISOString(),
      lastSeen: new Date(createdAts[createdAts.length - 1]).toISOString(),
      ...summarizeSet(epoch.sessions),
    }
  })
}

function summarizeSet(sessions) {
  const withPhase = sessions
  return {
    sessions: sessions.length,
    origin: sessions.reduce((acc, session) => {
      acc[session.origin] = (acc[session.origin] ?? 0) + 1
      return acc
    }, {}),
    turns: sumField(withPhase, session => session.turns),
    requests: sumField(withPhase, session => session.requests),
    toolCalls: sumField(withPhase, session => session.toolCalls),
    resolvedResults: sumField(withPhase, session => session.resolvedResults),
    toolErrors: sumField(withPhase, session => session.toolErrors),
    errorRate: (() => {
      const resolved = sumField(withPhase, session => session.resolvedResults)
      return resolved > 0 ? sumField(withPhase, session => session.toolErrors) / resolved : null
    })(),
    bootstrapRequests: sumField(withPhase, session => session.phase.bootstrapRequests),
    promotedRequests: sumField(withPhase, session => session.phase.promotedRequests),
    shellCalls: sumField(withPhase, session => session.shell.calls),
    shellNonZeroExit: sumField(withPhase, session => session.shell.nonZeroExit),
    shellNonZeroExitRate: (() => {
      const calls = sumField(withPhase, session => session.shell.calls)
      return calls > 0 ? sumField(withPhase, session => session.shell.nonZeroExit) / calls : null
    })(),
    tokens: {
      records: sumField(withPhase, session => session.tokens.matched),
      input: sumField(withPhase, session => session.tokens.input),
      output: sumField(withPhase, session => session.tokens.output),
      cacheRead: sumField(withPhase, session => session.tokens.cacheRead),
    },
    sessionsWithTokens: withPhase.filter(session => session.tokens.matched > 0).length,
    gatewayCalls: sumField(withPhase, session => session.gateway.calls),
    firstTool: withPhase.reduce((acc, session) => {
      const name = session.firstTool?.name ?? '(none)'
      acc[name] = (acc[name] ?? 0) + 1
      return acc
    }, {}),
    firstToolFailed: withPhase.filter(session => session.firstTool?.isError === true).length,
    // The catalog is identical for every session sharing an epoch signature, so
    // the first session's per-tool split is the epoch's per-tool split.
    schemaCharsByTool: withPhase.find(session => session.phase.initialSchemaChars !== null)?.phase.schemaCharsByTool ?? {},
    toolCounts: withPhase.reduce((acc, session) => mergeCounts(acc, session.toolCounts), {}),
    toolErrorCounts: withPhase.reduce((acc, session) => mergeCounts(acc, session.toolErrorCounts), {}),
    perSession: {
      requests: statsOf(withPhase.map(session => session.requests), 'requests'),
      toolCalls: statsOf(withPhase.map(session => session.toolCalls), 'toolCalls'),
      tokensOutput: statsOf(withPhase.filter(session => session.tokens.matched > 0).map(session => session.tokens.output), 'outputTokens'),
    },
  }
}

export function aggregateSessions(sessions, options = {}) {
  const byOrigin = {}
  for (const origin of ['main', 'subagent']) {
    const subset = sessions.filter(session => session.origin === origin)
    if (subset.length > 0) byOrigin[origin] = summarizeSet(subset)
  }
  const withTokens = sessions.filter(session => session.tokens.matched > 0)
  const gatewayBySession = sessions
    .map(session => ({ id: session.id, calls: session.gateway.calls }))
    .filter(row => row.calls > 0)
    .sort((a, b) => b.calls - a.calls)
  const gatewayTotal = gatewayBySession.reduce((sum, row) => sum + row.calls, 0)

  return {
    ...summarizeSet(sessions),
    byOrigin,
    epochs: groupEpochs(sessions),
    percentiles: {
      requests: statsOf(sessions.map(session => session.requests), 'requests'),
      turns: statsOf(sessions.map(session => session.turns), 'turns'),
      toolCalls: statsOf(sessions.map(session => session.toolCalls), 'toolCalls'),
      errorRate: statsOf(sessions.map(session => session.errorRate).filter(value => value !== null), 'errorRate'),
      inputTokens: statsOf(withTokens.map(session => session.tokens.input), 'inputTokens'),
      outputTokens: statsOf(withTokens.map(session => session.tokens.output), 'outputTokens'),
      cacheReadTokens: statsOf(withTokens.map(session => session.tokens.cacheRead), 'cacheReadTokens'),
      schemaChars: statsOf(sessions.map(session => session.phase.initialSchemaChars).filter(value => value !== null), 'initialSchemaChars'),
    },
    gatewaySummary: (() => {
      const gateway = emptyGateway()
      const errorKinds = {}
      for (const session of sessions) {
        gateway.calls += session.gateway.calls
        mergeCounts(gateway.actions, session.gateway.actions)
        gateway.errors += session.gateway.errors
        mergeCounts(errorKinds, session.gateway.errorKinds)
        gateway.noMatchSearches += session.gateway.noMatchSearches
        gateway.acquisitions += session.gateway.acquisitions
        gateway.sequences += session.gateway.sequences
        gateway.sequenceLengths.push(...session.gateway.sequenceLengths)
        gateway.searchThenCall += session.gateway.searchThenCall
        gateway.callWithoutSearch += session.gateway.callWithoutSearch
        gateway.failedThenRetry += session.gateway.failedThenRetry
        mergeCounts(gateway.capabilities, session.gateway.capabilities)
      }
      gateway.errorKinds = errorKinds
      gateway.callsPerAcquisition = gateway.acquisitions > 0 ? gateway.calls / gateway.acquisitions : null
      gateway.avgSequenceLength = gateway.sequences > 0 ? gateway.calls / gateway.sequences : null
      gateway.maxSequenceLength = gateway.sequenceLengths.length > 0 ? Math.max(...gateway.sequenceLengths) : null
      gateway.sessionsUsingGateway = gatewayBySession.length
      gateway.concentration = {
        topSession: gatewayBySession[0] ?? null,
        topSessionShare: gatewayTotal > 0 && gatewayBySession[0] !== undefined ? gatewayBySession[0].calls / gatewayTotal : null,
        top3Share: gatewayTotal > 0
          ? gatewayBySession.slice(0, 3).reduce((sum, row) => sum + row.calls, 0) / gatewayTotal
          : null,
      }
      gateway.searchThenCallShare = gateway.acquisitions > 0 ? gateway.searchThenCall / gateway.acquisitions : null
      return gateway
    })(),
    dataQuality: {
      sessionsWithoutHeader: sessions.filter(session => session.phase.initialSignature === null).length,
      sessionsWithoutSteps: sessions.filter(session => session.requests === 0).length,
      sessionsWithoutTokens: sessions.filter(session => session.tokens.records === 0).length,
      sessionsWithUnmatchedTokens: sessions.filter(session => session.tokens.unmatched > 0).length,
      sessionsWithPresetSwitch: sessions.filter(session => session.presetSwitches.length > 0).length,
      sessionsSwitchedAway: sessions.filter(session => session.effectivePreset !== session.preset).length,
      malformedLines: sumField(sessions, session => session.malformedLines),
      duplicateResultEvents: sumField(sessions, session => session.duplicateResults),
      pendingCalls: sumField(sessions, session => session.pendingCalls),
      tokenRecordsMatched: sumField(sessions, session => session.tokens.matched),
      tokenRecordsUnmatched: sumField(sessions, session => session.tokens.unmatched),
      assistantMessages: sumField(sessions, session => session.assistantMessages),
      tokenCoverage: (() => {
        const messages = sumField(sessions, session => session.assistantMessages)
        return messages > 0 ? sumField(sessions, session => session.tokens.matched) / messages : null
      })(),
      degrade: sessions.reduce((acc, session) => {
        for (const reason of session.degrade) {
          const key = reason.split(':')[0]
          acc[key] = (acc[key] ?? 0) + 1
        }
        return acc
      }, {}),
    },
    options,
  }
}

/* --------------------------------------------------------------- collect ---- */

export function collectSessions(options = {}) {
  const opts = { ...parseArgs([]), ...options }
  // Derive the numeric bound from --since so direct collectSessions() callers
  // behave exactly like the CLI.
  opts.sinceMs = typeof opts.since === 'string' ? new Date(`${opts.since}T00:00:00`).getTime() : null
  const files = findSessionFiles(opts.sessionsRoot)
  const recordsState = loadRecords(opts.records)
  const unreadable = []
  const skipped = { preset: 0, since: 0, session: 0 }
  const sessions = []
  for (const file of files) {
    const dirId = file.split(/[\\/]/).slice(-2, -1)[0] ?? file
    // Accept both the full directory id (`session-abc…`) and the bare uuid prefix.
    const bareId = dirId.replace(/^session-/, '')
    if (opts.session !== null && !dirId.startsWith(opts.session) && !bareId.startsWith(opts.session)) {
      skipped.session += 1
      continue
    }
    let read
    try {
      read = readSessionBytes(file)
    } catch (error) {
      unreadable.push({ file, error: error.message })
      continue
    }
    const parsed = parseSessionLog(read.buffer)
    const sessionEvent = parsed.events.find(event => event.type === 'session') ?? null
    const declaredPreset = asString(sessionEvent?.agentPreset) || null
    if (opts.preset !== null && declaredPreset !== opts.preset) {
      skipped.preset += 1
      continue
    }
    const records = recordsState.bySession.get(asString(sessionEvent?.id) || dirId) ?? []
    const metrics = buildSessionMetrics({
      id: dirId,
      file,
      events: parsed.events,
      malformedLines: parsed.malformedLines,
      encoding: read.encoding,
      records,
    })
    if (opts.sinceMs !== null && metrics.createdAt < opts.sinceMs) {
      skipped.since += 1
      continue
    }
    sessions.push(metrics)
  }
  sessions.sort((a, b) => a.createdAt - b.createdAt)
  const limited = opts.limit !== null && sessions.length > opts.limit
    ? sessions.slice(sessions.length - opts.limit)
    : sessions
  return { sessions: limited, totalMatched: sessions.length, unreadable, skipped, recordsState, options: opts }
}

export function buildReport(options) {
  const collected = collectSessions(options)
  const report = {
    tool: TOOL_NAME,
    version: TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    filter: {
      preset: collected.options.preset,
      since: collected.options.since,
      session: collected.options.session,
      limit: collected.options.limit,
      sessionsRoot: collected.options.sessionsRoot,
      records: collected.options.records,
    },
    ledger: {
      readable: collected.recordsState.readable,
      lines: collected.recordsState.lines,
      malformedLines: collected.recordsState.malformedLines,
      sessions: collected.recordsState.bySession.size,
      error: collected.recordsState.error,
    },
    scan: {
      matched: collected.totalMatched,
      reported: collected.sessions.length,
      skipped: collected.skipped,
      unreadable: collected.unreadable,
    },
    aggregate: aggregateSessions(collected.sessions, {
      preset: collected.options.preset,
      since: collected.options.since,
    }),
    sessions: collected.sessions,
  }
  return report
}

/* ---------------------------------------------------------------- render ---- */

const fmt = (value, digits = 1) => {
  if (value === null || value === undefined) return 'n/a'
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value)
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(digits)
}

const pct = value => (value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`)

const sortedCounts = counts => Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

export function renderText(report, options = {}) {
  const top = options.top ?? 15
  const verbose = options.verbose === true
  const lines = []
  const aggregate = report.aggregate
  lines.push(`${TOOL_NAME} ${report.version}  generated ${report.generatedAt}`)
  lines.push(`preset=${report.filter.preset} since=${report.filter.since ?? '-'} session=${report.filter.session ?? '-'} limit=${report.filter.limit ?? '-'}`)
  lines.push(`sessions: ${report.scan.matched} matched / ${report.scan.reported} reported · skipped(${Object.entries(report.scan.skipped).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(' ') || 'none'}) · unreadable ${report.scan.unreadable.length}`)
  lines.push(`token ledger: ${report.ledger.readable ? `${report.ledger.lines} lines / ${report.ledger.sessions} sessions / malformed ${report.ledger.malformedLines}` : `unreadable (${report.ledger.error})`}`)
  lines.push('')
  lines.push('== totals ==')
  lines.push(`turns ${aggregate.turns} · requests ${aggregate.requests} · tool calls ${aggregate.toolCalls} · results ${aggregate.resolvedResults} · errors ${aggregate.toolErrors} (${pct(aggregate.errorRate)})`)
  lines.push(`bootstrap requests ${aggregate.bootstrapRequests} · promoted requests ${aggregate.promotedRequests}`)
  lines.push(`bash calls ${aggregate.shellCalls} · non-zero exit ${aggregate.shellNonZeroExit} (${pct(aggregate.shellNonZeroExitRate)})`)
  lines.push(`tokens (matched ${aggregate.sessionsWithTokens} sessions): input ${aggregate.tokens.input} · output ${aggregate.tokens.output} · cacheRead ${aggregate.tokens.cacheRead}`)
  lines.push(`token coverage: ${pct(aggregate.dataQuality.tokenCoverage)} of ${aggregate.dataQuality.assistantMessages} assistant messages · unmatched records ${aggregate.dataQuality.tokenRecordsUnmatched}`)
  lines.push('')
  lines.push('== per-session distribution ==')
  for (const key of ['requests', 'turns', 'toolCalls', 'errorRate', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'schemaChars']) {
    const stats = aggregate.percentiles[key]
    const kind = key === 'errorRate' ? pct : fmt
    lines.push(`  ${key.padEnd(16)} n=${String(stats.n).padEnd(4)} mean=${kind(stats.mean)} p50=${kind(stats.p50)} p90=${kind(stats.p90)} max=${kind(stats.max)} sum=${fmt(stats.sum)}`)
  }
  lines.push('')
  lines.push('== first tool ==')
  for (const [name, count] of sortedCounts(aggregate.firstTool)) {
    lines.push(`  ${name.padEnd(24)} ${count} (${pct(count / Math.max(1, aggregate.sessions))})`)
  }
  lines.push(`  first tool failed in ${aggregate.firstToolFailed} session(s)`)
  lines.push('')
  lines.push(`== tool calls (top ${top}) ==`)
  for (const [name, count] of sortedCounts(aggregate.toolCounts).slice(0, top)) {
    const errors = aggregate.toolErrorCounts[name] ?? 0
    lines.push(`  ${name.padEnd(24)} ${String(count).padStart(6)}  errors ${String(errors).padStart(5)} (${pct(count > 0 ? errors / count : null)})`)
  }
  lines.push('')
  lines.push('== origin ==')
  for (const [origin, summary] of Object.entries(aggregate.byOrigin)) {
    lines.push(`  ${origin.padEnd(10)} sessions=${summary.sessions} requests=${summary.requests} toolCalls=${summary.toolCalls} errors=${summary.toolErrors} (${pct(summary.errorRate)}) tokensOutput=${summary.tokens.output}`)
  }
  lines.push('')
  lines.push('== epochs (grouped by initial request tool list) ==')
  for (const epoch of aggregate.epochs) {
    const shortTools = epoch.tools.length > 8
      ? `${epoch.tools.slice(0, 8).join(',')},… (${epoch.tools.length})`
      : epoch.tools.join(',')
    lines.push(`  ${epoch.label} sessions=${String(epoch.sessions).padStart(3)} tools=${String(epoch.toolCount).padStart(3)} chars=${fmt(epoch.schemaChars)} ${epoch.firstSeen.slice(0, 10)}→${epoch.lastSeen.slice(0, 10)}`)
    lines.push(`      ${shortTools}`)
    lines.push(`      requests=${epoch.requests} toolCalls=${epoch.toolCalls} errors=${pct(epoch.errorRate)} reqP50=${fmt(epoch.perSession.requests.p50)} reqP90=${fmt(epoch.perSession.requests.p90)} tokens(out/in)=${epoch.tokens.output}/${epoch.tokens.input} withTokens=${epoch.sessionsWithTokens} gwCalls=${epoch.gatewayCalls}`)
  }
  lines.push('')
  lines.push('== gateway ==')
  const gateway = aggregate.gatewaySummary
  lines.push(`  calls ${gateway.calls} across ${gateway.sessionsUsingGateway} sessions · actions search=${gateway.actions.search} describe=${gateway.actions.describe} call=${gateway.actions.call} list=${gateway.actions.list} other=${gateway.actions.other}`)
  lines.push(`  errors ${gateway.errors} (${pct(gateway.calls > 0 ? gateway.errors / gateway.calls : null)}) · kinds ${JSON.stringify(gateway.errorKinds)}`)
  lines.push(`  acquisitions ${gateway.acquisitions} · callsPerAcquisition ${fmt(gateway.callsPerAcquisition, 2)} · sequences ${gateway.sequences} avgLength ${fmt(gateway.avgSequenceLength, 2)} maxLength ${fmt(gateway.maxSequenceLength)}`)
  lines.push(`  searchThenCall ${gateway.searchThenCall} (${pct(gateway.searchThenCallShare)} of acquisitions) · callWithoutSearch ${gateway.callWithoutSearch} · failedThenRetry ${gateway.failedThenRetry}`)
  lines.push(`  concentration: top session ${gateway.concentration.topSession?.id ?? 'n/a'} ${pct(gateway.concentration.topSessionShare)} · top3 ${pct(gateway.concentration.top3Share)}`)
  lines.push('')
  lines.push('== data quality ==')
  for (const [key, value] of Object.entries(aggregate.dataQuality)) {
    if (key === 'degrade') continue
    lines.push(`  ${key.padEnd(28)} ${typeof value === 'number' && key.endsWith('Coverage') ? pct(value) : fmt(value)}`)
  }
  lines.push(`  degrade ${JSON.stringify(aggregate.dataQuality.degrade)}`)
  lines.push('')
  lines.push(`== sessions (${report.sessions.length}, oldest first) ==`)
  for (const session of report.sessions) {
    const tokens = session.tokens.matched > 0 ? `tok=${session.tokens.input}/${session.tokens.output}` : 'tok=-'
    lines.push(`  ${session.createdAtIso.slice(0, 16)} ${session.id.slice(0, 20).padEnd(21)} ${session.origin.padEnd(8)} d${session.delegationDepth} turns=${String(session.turns).padStart(3)} req=${String(session.requests).padStart(4)} calls=${String(session.toolCalls).padStart(4)} err=${String(session.toolErrors).padStart(3)} first=${(session.firstTool?.name ?? '-').padEnd(16)} ${tokens} gw=${session.gateway.calls} b/p=${session.phase.bootstrapRequests}/${session.phase.promotedRequests} ${session.degrade.length > 0 ? `!${session.degrade.length}` : ''}`)
    if (verbose) {
      lines.push(`      initial tools(${session.phase.initialToolCount}): ${session.phase.initialTools.join(',')}`)
      lines.push(`      schemaChars ${session.phase.initialSchemaChars} · reasons ${JSON.stringify(session.headerReasons)}`)
      lines.push(`      tools ${JSON.stringify(session.toolCounts)}`)
    }
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ main ---- */

/** Run the CLI in-process. Returns {code, output} so tests need no child process. */
export function runCli(argv, { stdout = () => {}, stderr = () => {} } = {}) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`${error.message}\n\n${usageText()}`)
      return { code: 2, output: null }
    }
    throw error
  }
  if (options.help) {
    stdout(usageText())
    return { code: 0, output: null }
  }
  const report = buildReport(options)
  if (options.json) {
    const json = JSON.stringify(report, null, 2)
    stdout(json)
    return { code: 0, output: report }
  }
  stdout(renderText(report, options))
  return { code: 0, output: report }
}

const invokedDirectly = (() => {
  if (typeof process === 'undefined' || !Array.isArray(process.argv)) return false
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) return false
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const result = runCli(process.argv.slice(2), {
    stdout: text => process.stdout.write(`${text}\n`),
    stderr: text => process.stderr.write(`${text}\n`),
  })
  process.exitCode = result.code
}
