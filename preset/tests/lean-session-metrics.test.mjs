import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'

import {
  aggregateSessions,
  buildReport,
  buildSessionMetrics,
  collectSessions,
  findSessionFiles,
  groupEpochs,
  loadRecords,
  parseArgs,
  parseEvents,
  parseSessionLog,
  quantile,
  readSessionBytes,
  readSessionText,
  renderText,
  runCli,
  usageText,
  UsageError,
} from '../tools/lean-session-metrics.mjs'

/*
 * Synthetic fixtures only. No test here reads a real user session or the real
 * stats ledger: the event shapes below mirror the verified v4 log (see the tool
 * header) but every value is invented so the assertions are stable.
 */

const DAY = 24 * 60 * 60 * 1000
const BASE = Date.parse('2026-10-30T10:00:00Z')

const bashTool = { name: 'bash', description: 'run bash', parameters: { type: 'object' } }
const readTool = { name: 'read', description: 'read a file', parameters: { type: 'object' } }
const editTool = { name: 'edit', description: 'edit a file', parameters: { type: 'object' } }
const sendMessageTool = { name: 'send_message', description: 'message a teammate', parameters: { type: 'object' } }

const session = (id, preset, extra = {}) => ({
  type: 'session',
  seq: 1,
  time: BASE,
  data: {},
  version: 4,
  id,
  createdAt: extra.createdAt ?? BASE,
  cwd: '/tmp/synthetic',
  delegationDepth: extra.delegationDepth ?? 0,
  ...(preset === null ? {} : { agentPreset: preset }),
  ...('origin' in extra ? { origin: extra.origin } : {}),
})

const stepStart = (seq, turn, step) => ({ type: 'step/start', seq, time: BASE + seq, data: { turn, step } })
const header = (seq, reason, tools) => ({
  type: 'request/header',
  seq,
  time: BASE + seq,
  data: { reason, header: { config: { model: 'synthetic-model' }, tools } },
})
const assistant = seq => ({
  type: 'assistant/message',
  seq,
  time: BASE + seq,
  data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
})
const toolCall = (seq, callId, name, args = {}) => ({
  type: 'tool/call',
  seq,
  time: BASE + seq,
  data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
})
const toolResult = (seq, callId, text, isError = false) => ({
  type: 'tool/result',
  seq,
  time: BASE + seq,
  data: {
    message: {
      role: 'tool',
      toolCallId: callId,
      isError,
      content: [{ type: 'text', text }],
    },
  },
})

const gatewaySearchNoMatch = (seq, callId, query) => toolCall(seq, callId, 'tool_gateway', { action: 'search', query })

/** alpha: 3 steps, 2 headers, 7 tool calls (1 error), 4 gateway calls in 2 sequences. */
function alphaEvents() {
  return [
    session('session-alpha-0001', 'lean'),
    { type: 'turn/start', seq: 2, time: BASE + 2, data: { turn: 1 } },
    stepStart(3, 1, 1),
    header(4, 'initial', [bashTool, readTool]),
    assistant(5),
    toolCall(6, 'a1', 'bash', { command: 'ls' }),
    toolResult(7, 'a1', 'file.txt'),
    stepStart(8, 1, 2),
    assistant(9),
    toolCall(10, 'a2', 'read', { path: 'file.txt' }),
    toolResult(11, 'a2', 'contents'),
    stepStart(12, 1, 3),
    header(13, 'change', [bashTool, readTool, editTool]),
    assistant(14),
    gatewaySearchNoMatch(15, 'a3', 'zzz-nothing'),
    toolResult(16, 'a3', 'No gateway-eligible tools match "zzz-nothing". Try list.'),
    toolCall(17, 'a4', 'tool_gateway', { action: 'search', query: 'edit' }),
    toolResult(18, 'a4', '- edit: edit a file'),
    toolCall(19, 'a5', 'tool_gateway', { action: 'call', name: 'edit', input: { path: 'file.txt' } }),
    toolResult(20, 'a5', 'edited'),
    toolCall(25, 'a8', 'bash', { command: 'node missing.mjs' }),
    toolResult(26, 'a8', 'bash: node: command not found\n[exit code: 127]'),
    toolCall(21, 'a6', 'edit', { path: 'file.txt' }),
    toolResult(22, 'a6', 'Error: read before edit', true),
    toolCall(23, 'a7', 'tool_gateway', { action: 'list' }),
    toolResult(24, 'a7', 'gateway tools 1-2 of 2'),
    // Replayed duplicate of an already-materialised result (compaction/prune artefact).
    toolResult(70, 'a1', 'file.txt'),
    { type: 'turn/end', seq: 26, time: BASE + 26, data: { turn: 1, reason: { kind: 'turnEnd' } } },
  ]
}

/** beta: subagent with a different initial catalog, one step, no tool calls. */
function betaEvents() {
  return [
    session('session-beta-0002', 'lean', { origin: 'subagent', delegationDepth: 1 }),
    { type: 'turn/start', seq: 2, time: BASE + 2, data: { turn: 1 } },
    stepStart(3, 1, 1),
    header(4, 'initial', [bashTool, sendMessageTool]),
    assistant(5),
    { type: 'turn/end', seq: 6, time: BASE + 6, data: { turn: 1, reason: { kind: 'turnEnd' } } },
  ]
}

/** gamma: another preset, must be filtered out by --preset lean. */
function gammaEvents() {
  return [
    session('session-gamma-0003', 'standard'),
    stepStart(2, 1, 1),
    header(3, 'initial', [bashTool]),
    assistant(4),
  ]
}

/** delta: lean session whose log lost every header (degraded, still counted). */
function deltaEvents() {
  return [
    session('session-delta-0004', 'lean'),
    stepStart(2, 1, 1),
    assistant(3),
  ]
}

const alphaRecords = () => [
  { ts: BASE, seq: 5, sessionId: 'session-alpha-0001', model: 'm1', provider: 'p', inputTokens: 100, outputTokens: 10, cacheReadTokens: 7, cacheWriteTokens: 0, reasoningTokens: 0 },
  { ts: BASE, seq: 9, sessionId: 'session-alpha-0001', model: 'm1', provider: 'p', inputTokens: 200, outputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 0, reasoningTokens: 0 },
  { ts: BASE, seq: 14, sessionId: 'session-alpha-0001', model: 'm2', provider: 'p', inputTokens: 300, outputTokens: 30, cacheReadTokens: 700, cacheWriteTokens: 0, reasoningTokens: 0 },
  // seq 999 belongs to no assistant message: must be counted as unmatched, not silently dropped.
  { ts: BASE, seq: 999, sessionId: 'session-alpha-0001', model: 'm2', provider: 'p', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
]

const fixture = {
  root: null,
  sessionsRoot: null,
  recordsFile: null,
}

const writeSession = (dirName, events, { compressed = false } = {}) => {
  const dir = join(fixture.sessionsRoot, '--tmp-synthetic--', dirName)
  mkdirSync(dir, { recursive: true })
  const body = `${events.map(event => JSON.stringify(event)).join('\n')}\n`
  if (compressed) {
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(body, 'utf8')))
  } else {
    writeFileSync(join(dir, 'session.v4.jsonl'), body)
  }
  return dir
}

before(() => {
  fixture.root = mkdtempSync(join(tmpdir(), 'lean-session-metrics-'))
  fixture.sessionsRoot = join(fixture.root, 'sessions')
  fixture.recordsFile = join(fixture.root, 'records.jsonl')
  mkdirSync(fixture.sessionsRoot, { recursive: true })
  writeSession('session-alpha-0001', alphaEvents())
  writeSession('session-beta-0002', betaEvents())
  writeSession('session-gamma-0003', gammaEvents())
  writeSession('session-delta-0004', deltaEvents())
  // An unreadable log must be reported, not crash the scan.
  const broken = join(fixture.sessionsRoot, '--tmp-synthetic--', 'session-broken-0005')
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, 'session.v4.jsonl.zstd'), Buffer.from('not a zstd frame', 'utf8'))
  writeFileSync(
    fixture.recordsFile,
    `${[...alphaRecords(), { ts: BASE, seq: 4, sessionId: 'session-gamma-0003', model: 'm1', provider: 'p', inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }]
      .map(record => JSON.stringify(record))
      .join('\n')}\n`,
  )
})

after(() => {
  if (fixture.root !== null) rmSync(fixture.root, { recursive: true, force: true })
})

const options = extra => ({
  sessionsRoot: fixture.sessionsRoot,
  records: fixture.recordsFile,
  preset: 'lean',
  since: null,
  session: null,
  limit: null,
  top: 15,
  json: false,
  verbose: false,
  help: false,
  ...extra,
})

const loadAlpha = (records = alphaRecords()) => {
  const files = findSessionFiles(fixture.sessionsRoot)
  const file = files.find(candidate => candidate.includes('session-alpha-0001'))
  const parsed = parseEvents(readSessionText(file).text)
  return buildSessionMetrics({
    id: 'session-alpha-0001',
    file,
    events: parsed.events,
    malformedLines: parsed.malformedLines,
    encoding: 'plain',
    records: records.filter(record => record.sessionId === 'session-alpha-0001'),
  })
}

/* ------------------------------------------------------------------ CLI ---- */

test('parseArgs applies defaults and rejects malformed values', () => {
  const defaults = parseArgs([])
  assert.equal(defaults.preset, 'lean')
  assert.equal(defaults.json, false)
  assert.equal(defaults.sinceMs, null)

  const parsed = parseArgs(['--preset', 'lean', '--since', '2026-10-01', '--session', 'session-a', '--limit', '5', '--json'])
  assert.equal(parsed.since, '2026-10-01')
  assert.equal(parsed.sinceMs, new Date('2026-10-01T00:00:00').getTime())
  assert.equal(parsed.limit, 5)
  assert.equal(parsed.json, true)

  assert.equal(parseArgs(['--preset=lean']).preset, 'lean')
  assert.throws(() => parseArgs(['--since', '2026-13-40']), UsageError)
  assert.throws(() => parseArgs(['--limit', '0']), UsageError)
  assert.throws(() => parseArgs(['--nope']), UsageError)
  assert.throws(() => parseArgs(['--json=1']), UsageError)
  assert.throws(() => parseArgs(['--preset']), UsageError)
})

test('usageText documents every required flag', () => {
  const text = usageText()
  for (const flag of ['--preset', '--since', '--session', '--json', '--limit']) {
    assert.ok(text.includes(flag), `usage is missing ${flag}`)
  }
})

test('runCli --help exits 0 and --json returns the report object', () => {
  let help = ''
  const helped = runCli(['--help'], { stdout: text => { help = text } })
  assert.equal(helped.code, 0)
  assert.match(help, /lean-session-metrics/)

  let json = ''
  const run = runCli(['--json', '--sessions-root', fixture.sessionsRoot, '--records', fixture.recordsFile], {
    stdout: text => { json = text },
  })
  assert.equal(run.code, 0)
  assert.equal(run.output.aggregate.sessions, 3)
  assert.equal(JSON.parse(json).aggregate.sessions, 3)

  let stderr = ''
  const failed = runCli(['--nope'], { stderr: text => { stderr = text } })
  assert.equal(failed.code, 2)
  assert.match(stderr, /unknown option: --nope/)
})

/* --------------------------------------------------------------- parsing ---- */

test('parseEvents counts malformed and blank lines instead of dropping them silently', () => {
  const parsed = parseEvents('{"type":"session"}\n\nnot-json\n[1,2]\n')
  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.malformedLines, 2)
  assert.equal(parsed.blankLines, 2)
})

test('readSessionText reads plain logs and zstd frames', t => {
  const plain = readSessionText(findSessionFiles(fixture.sessionsRoot).find(file => file.includes('alpha')))
  assert.equal(plain.encoding, 'plain')
  assert.ok(plain.text.includes('"session"'))

  if (typeof zlib.zstdCompressSync !== 'function') {
    t.skip('node:zlib has no zstd support in this runtime; the CLI fallback is covered by the error path test')
    return
  }
  const compressed = join(fixture.root, 'compressed.v4.jsonl.zstd')
  writeFileSync(compressed, zlib.zstdCompressSync(Buffer.from('{"type":"turn/end"}\n', 'utf8')))
  const zstd = readSessionText(compressed)
  assert.match(zstd.encoding, /^zstd:/)
  assert.equal(parseEvents(zstd.text).events[0].type, 'turn/end')
})

test('readSessionText falls back to the zstd CLI when node:zlib has no zstd', t => {
  if (typeof zlib.zstdCompressSync !== 'function') {
    t.skip('needs a zstd frame to decompress')
    return
  }
  const file = join(fixture.root, 'cli-fallback.v4.jsonl.zstd')
  writeFileSync(file, zlib.zstdCompressSync(Buffer.from('{"type":"session","seq":1}\n', 'utf8')))
  let read
  try {
    read = readSessionText(file, { zstdDecompress: null })
  } catch (error) {
    t.skip(`zstd CLI unavailable: ${error.message}`)
    return
  }
  assert.equal(read.encoding, 'zstd:cli')
  assert.equal(parseEvents(read.text).events[0].type, 'session')
})

test('loadRecords groups by session, sorts by seq and counts bad lines', () => {
  const file = join(fixture.root, 'records-with-junk.jsonl')
  writeFileSync(file, [
    JSON.stringify({ sessionId: 's1', seq: 9, inputTokens: 1 }),
    'broken',
    JSON.stringify({ sessionId: 's1', seq: 2, inputTokens: 2 }),
    JSON.stringify({ sessionId: 's2', seq: 1, inputTokens: 3 }),
  ].join('\n'))
  const state = loadRecords(file)
  assert.equal(state.malformedLines, 1)
  assert.deepEqual(state.bySession.get('s1').map(record => record.seq), [2, 9])
  assert.equal(state.bySession.get('s2').length, 1)
})

test('compact and full event parsing produce identical metrics', () => {
  const file = findSessionFiles(fixture.sessionsRoot).find(candidate => candidate.includes('session-alpha-0001'))
  const records = alphaRecords().filter(record => record.sessionId === 'session-alpha-0001')
  const full = buildSessionMetrics({
    id: 'session-alpha-0001',
    file,
    events: parseEvents(readSessionText(file).text).events,
    records,
  })
  const compact = buildSessionMetrics({
    id: 'session-alpha-0001',
    file,
    events: parseSessionLog(readSessionBytes(file).buffer).events,
    records,
  })
  // The compact path is what the CLI uses; it must not change a single number.
  assert.deepEqual(compact, full)
})

test('parseSessionLog splits a decompressed Buffer on newline bytes only', () => {
  const body = `${JSON.stringify({ type: 'session', id: 'session-中文-0007', agentPreset: 'lean' })}\n${JSON.stringify({ type: 'tool/result', seq: 2, data: { message: { toolCallId: 'x', isError: false, content: [{ type: 'text', text: '编辑成功\n[exit code: 1]' }] } } })}\n`
  const parsed = parseSessionLog(Buffer.from(body, 'utf8'))
  assert.equal(parsed.events.length, 2)
  assert.equal(parsed.events[0].id, 'session-中文-0007')
  assert.equal(parsed.events[1].data.result.exitCode, 1)
  assert.equal(parsed.events[1].data.result.noMatch, false)
  assert.equal(parsed.malformedLines, 0)
})

/* --------------------------------------------------------- per-session ------ */

test('buildSessionMetrics counts turns, requests, tool calls and errors', () => {
  const alpha = loadAlpha()
  assert.equal(alpha.id, 'session-alpha-0001')
  assert.equal(alpha.origin, 'main')
  assert.equal(alpha.preset, 'lean')
  assert.equal(alpha.turns, 1)
  assert.equal(alpha.requests, 3)
  assert.equal(alpha.headers, 2)
  assert.deepEqual(alpha.headerReasons, { initial: 1, change: 1 })
  assert.equal(alpha.toolCalls, 8)
  assert.equal(alpha.resolvedResults, 8)
  assert.equal(alpha.toolErrors, 1)
  assert.equal(alpha.errorRate, 1 / 8)
  assert.deepEqual(alpha.firstTool.name, 'bash')
  assert.equal(alpha.firstTool.isError, false)
  assert.equal(alpha.toolCounts.tool_gateway, 4)
  assert.equal(alpha.toolCounts.bash, 2)
  assert.equal(alpha.toolErrorCounts.edit, 1)
})

test('buildSessionMetrics de-duplicates replayed tool results by callId', () => {
  const alpha = loadAlpha()
  assert.equal(alpha.duplicateResults, 1)
  assert.equal(alpha.toolResults, 8)
  assert.equal(alpha.resolvedResults, 8)
  assert.ok(alpha.degrade.includes('duplicate-result-events:1'))
})

test('buildSessionMetrics attributes requests to bootstrap vs promoted phase', () => {
  const alpha = loadAlpha()
  assert.equal(alpha.phase.initialToolCount, 2)
  assert.deepEqual(alpha.phase.initialTools, ['bash', 'read'])
  assert.equal(alpha.phase.initialModel, 'synthetic-model')
  // Steps 1-2 run on the initial catalog (a header appended in the same step
  // window still governs that step); step 3 runs after the `change` header.
  assert.equal(alpha.phase.bootstrapRequests, 2)
  assert.equal(alpha.phase.promotedRequests, 1)
  assert.equal(alpha.phase.unattributedRequests, 0)
  assert.equal(
    alpha.phase.initialSchemaChars,
    [bashTool, readTool].reduce((sum, tool) => sum + JSON.stringify(tool).length, 0),
  )
  assert.equal(alpha.phase.schemaCharsByTool.read, JSON.stringify(readTool).length)
})

test('buildSessionMetrics reports a session with no header as degraded data', () => {
  const file = findSessionFiles(fixture.sessionsRoot).find(candidate => candidate.includes('session-delta-0004'))
  const parsed = parseEvents(readSessionText(file).text)
  const delta = buildSessionMetrics({ id: 'session-delta-0004', file, events: parsed.events, records: [] })
  assert.equal(delta.phase.initialSignature, null)
  assert.equal(delta.requests, 1)
  assert.equal(delta.phase.unattributedRequests, 1)
  assert.ok(delta.degrade.includes('no-request-header'))
  assert.ok(delta.degrade.includes('requests-before-first-header:1'))
})

/* ------------------------------------------------------------- gateway ------ */

test('buildSessionMetrics breaks down gateway actions, errors and sequences', () => {
  const { gateway } = loadAlpha()
  assert.equal(gateway.calls, 4)
  assert.deepEqual(gateway.actions, { search: 2, describe: 0, call: 1, list: 1, other: 0 })
  // A no-match search is a normal result, not an isError failure.
  assert.equal(gateway.errors, 0)
  assert.deepEqual(gateway.errorKinds, {})
  assert.equal(gateway.noMatchSearches, 1)
  assert.equal(gateway.acquisitions, 1)
  assert.deepEqual(gateway.capabilities, { edit: 1 })
  // a4 follows the missed a3 search without anything in between.
  assert.equal(gateway.failedThenRetry, 1)
  // a3,a4,a5 are contiguous; a6 (edit) breaks the run; a7 opens a new one.
  assert.equal(gateway.sequences, 2)
  assert.deepEqual(gateway.sequenceLengths, [3, 1])
  assert.equal(gateway.avgSequenceLength, 2)
  assert.equal(gateway.callsPerAcquisition, 4)
  // The successful `call` is directly preceded by a gateway `search`.
  assert.equal(gateway.searchThenCall, 1)
  assert.equal(gateway.callWithoutSearch, 0)
})

test('buildSessionMetrics flags unknown-tool gateway calls', () => {
  const events = [
    session('session-gw-0006', 'lean'),
    stepStart(2, 1, 1),
    header(3, 'initial', [bashTool]),
    assistant(4),
    toolCall(5, 'g1', 'tool_gateway', { action: 'call', name: 'nope', input: {} }),
    toolResult(6, 'g1', 'Unknown tool "nope". Closest names: read. Use action="search" or action="list".', true),
    toolCall(7, 'g2', 'tool_gateway', { action: 'describe' }),
    toolResult(8, 'g2', 'Provide the exact tool name for action="describe".', true),
  ]
  const metrics = buildSessionMetrics({ id: 'session-gw-0006', file: 'synthetic', events, records: [] })
  assert.deepEqual(metrics.gateway.errorKinds, { 'unknown-tool': 1, 'missing-argument': 1 })
  assert.equal(metrics.gateway.acquisitions, 0)
  assert.equal(metrics.gateway.callsPerAcquisition, null)
})

test('buildSessionMetrics counts partial batch failures separately from isError', () => {
  const events = [
    session('session-gw-batch', 'lean'),
    stepStart(2, 1, 1),
    header(3, 'initial', [bashTool]),
    assistant(4),
    toolCall(5, 'b1', 'tool_gateway', { action: 'call', calls: [{ name: 'hidden_fail' }, { name: 'hidden_read' }] }),
    toolResult(6, 'b1', 'BATCH PARTIAL FAILURE: 1/2 calls failed (hidden_fail). Failed items are labeled ERROR above; retry only those.', false),
  ]
  const metrics = buildSessionMetrics({ id: 'session-gw-batch', file: 'synthetic', events, records: [] })
  assert.equal(metrics.gateway.errors, 0, 'the outer gateway result is a success')
  assert.equal(metrics.gateway.batchPartialFailures, 1)
  assert.equal(metrics.gateway.batchFailedItems, 1)
})

test('buildSessionMetrics separates shell exit codes from harness isError', () => {
  const alpha = loadAlpha()
  assert.equal(alpha.shell.calls, 2)
  assert.equal(alpha.shell.nonZeroExit, 1)
  assert.equal(alpha.shell.nonZeroExitRate, 0.5)
  assert.deepEqual(alpha.shell.exitCodes, { 127: 1 })
  // The failed command is NOT an isError tool result, so it must not inflate errorRate.
  assert.equal(alpha.toolErrorCounts.bash, undefined)
})

/* -------------------------------------------------------------- tokens ------ */

test('buildSessionMetrics joins token records on assistant/message seq and buckets by phase', () => {
  const { tokens } = loadAlpha()
  assert.equal(tokens.records, 4)
  assert.equal(tokens.matched, 3)
  assert.equal(tokens.unmatched, 1)
  assert.equal(tokens.input, 600)
  assert.equal(tokens.output, 60)
  assert.equal(tokens.cacheRead, 777)
  assert.deepEqual(tokens.byPhase, { bootstrap: 2, promoted: 1, unattributed: 0 })
  assert.equal(tokens.byModel.m1.records, 2)
  assert.equal(tokens.byModel.m2.input, 300)
  assert.ok(Math.abs(tokens.coverage - 1) < 1e-9)
  assert.ok(tokens.matched <= tokens.records)
})

/* --------------------------------------------------------------- epochs ----- */

test('groupEpochs keys epochs on the initial tool list and orders them by first appearance', () => {
  const report = buildReport(options())
  const epochs = report.aggregate.epochs
  assert.equal(epochs.length, 3)
  const bySignature = new Map(epochs.map(epoch => [epoch.signature, epoch]))
  const alphaEpoch = bySignature.get('bash,read')
  const betaEpoch = bySignature.get('bash,send_message')
  const noHeader = bySignature.get('(no-header)')
  assert.equal(alphaEpoch.sessions, 1, 'gamma is filtered out by --preset lean')
  assert.equal(betaEpoch.sessions, 1)
  assert.equal(noHeader.sessions, 1)
  assert.equal(alphaEpoch.toolCount, 2)
  assert.equal(betaEpoch.tools.join(','), 'bash,send_message')
  assert.deepEqual(epochs.map(epoch => epoch.label), ['E1', 'E2', 'E3'])
})

/* ------------------------------------------------------------ aggregate ----- */

test('quantile uses nearest-rank on the sorted sample', () => {
  assert.equal(quantile([], 50), null)
  assert.equal(quantile([5], 50), 5)
  assert.equal(quantile([1, 2, 3, 4], 50), 2)
  assert.equal(quantile([1, 2, 3, 4], 90), 4)
  assert.equal(quantile([4, 1, 3, 2], 25), 1)
})

test('aggregateSessions sums totals, splits origins and computes error rate', () => {
  const report = buildReport(options())
  const aggregate = report.aggregate
  assert.equal(aggregate.sessions, 3)
  assert.equal(aggregate.requests, 3 + 1 + 1)
  assert.equal(aggregate.toolCalls, 8)
  assert.equal(aggregate.toolErrors, 1)
  assert.equal(aggregate.resolvedResults, 8)
  assert.equal(aggregate.shellCalls, 2)
  assert.equal(aggregate.shellNonZeroExit, 1)
  assert.equal(aggregate.byOrigin.main.sessions, 2)
  assert.equal(aggregate.byOrigin.subagent.sessions, 1)
  assert.equal(aggregate.firstTool.bash, 1)
  assert.equal(aggregate.firstTool['(none)'], 2)
  assert.equal(aggregate.percentiles.requests.p50, 1)
  assert.equal(aggregate.percentiles.requests.max, 3)
  assert.equal(aggregate.dataQuality.sessionsWithoutHeader, 1)
  assert.equal(aggregate.dataQuality.duplicateResultEvents, 1)
  assert.equal(aggregate.gatewaySummary.calls, 4)
  assert.equal(aggregate.gatewaySummary.concentration.topSessionShare, 1)
})

test('collectSessions filters by preset, session prefix, since and limit', () => {
  const all = collectSessions(options({ preset: null }))
  assert.equal(all.sessions.length, 4, 'all readable sessions, including the non-lean one')
  assert.equal(all.unreadable.length, 1)

  const lean = collectSessions(options())
  assert.equal(lean.sessions.length, 3)
  assert.deepEqual(lean.skipped, { preset: 1, since: 0, session: 0 })

  const byPrefix = collectSessions(options({ session: 'session-beta' }))
  assert.equal(byPrefix.sessions.length, 1)
  assert.equal(byPrefix.sessions[0].id, 'session-beta-0002')
  assert.equal(byPrefix.skipped.session, 4)

  // A bare uuid prefix (without the `session-` prefix) selects the same session.
  const bare = collectSessions(options({ session: 'beta-0002' }))
  assert.equal(bare.sessions.length, 1)
  assert.equal(bare.sessions[0].id, 'session-beta-0002')

  const since = collectSessions(options({ since: '2030-01-01' }))
  assert.equal(since.sessions.length, 0)
  assert.equal(since.skipped.since, 3)

  const limited = collectSessions(options({ limit: 2 }))
  assert.equal(limited.sessions.length, 2)
  assert.equal(limited.totalMatched, 3)
  // --limit keeps the most recent sessions.
  assert.equal(limited.sessions[1].id, 'session-delta-0004')
})

/* --------------------------------------------------------------- render ----- */

test('renderText prints the sections and key figures', () => {
  const report = buildReport(options())
  const text = renderText(report, { top: 3 })
  for (const heading of ['== totals ==', '== first tool ==', '== epochs', '== gateway ==', '== data quality ==', '== sessions']) {
    assert.ok(text.includes(heading), `missing heading ${heading}`)
  }
  assert.match(text, /tool calls 8/)
  assert.match(text, /non-zero exit 1 \(50\.0%\)/)
  assert.match(text, /turns 2/)
  assert.match(text, /E1 sessions=/)
  assert.match(text, /token coverage: 60\.0%/)
})
