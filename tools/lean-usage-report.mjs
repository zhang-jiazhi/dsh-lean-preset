#!/usr/bin/env node
/**
 * lean-usage-report — lean 预设的常驻成本/使用率报表（只读）。
 *
 * 回答两个问题：
 *   1. 每个常驻工具的 schema 每请求花多少字符，实际被调用多少次？
 *   2. 历史会话里的工具错误集中在哪些文本上（用于判断提示/守卫是否值得改）？
 *
 * 数据来源：~/.dsh/sessions/**\/session.v4.jsonl.zstd（指定的 preset）。
 * 解析、header 签名（signature/schemaChars）与「按 callId 去重」的口径直接复用
 * lean/tools/lean-session-metrics.mjs，不在这里另立第二套。
 *
 * 口径（20261106 修正）：
 *   - 事件时间过滤：只有 `event.time >= CUTOFF`（--days 窗口）的 tool/call、tool/result 计数。
 *     没有 time 字段的旧事件按 0 处理 → 落在窗口外，不计入。--days 不再只筛文件 mtime。
 *   - 去重：同一 callId 的 tool/call、tool/result 只算第一次（历史重物化/replay 会重复写）。
 *     去重先于窗口判定：第一次出现的事件时间决定它是否在窗口内（重放副本不会把旧结果算成新使用）。
 *   - 常驻成本：取窗口内**最新会话**（按 session.createdAt）的**最新 request/header**（按 seq），
 *     不用「历史上工具数最多的 header」。header 的 phase 由「与该会话首个 header 的 signature
 *     是否相同」判定：相同 = bootstrap，不同 = promoted（reason 是原始字段 initial/change/...）。
 *     最新 header 若是 bootstrap，另取该会话最新的 promoted header 作为常驻成本，并在输出里标注。
 *     若最新会话本身是 subagent 会话，其目录只是主 agent 的子集，此时常驻成本按最新主会话计
 *     （resident.sessionScope=latest-main-session，最新会话的事实放在 resident.latestSession）。
 *   - 阶段归属：每个 tool/call 归属到 session 内 seq 之前最近的 request/header，
 *     再按该会话首个 header 的 signature 区分 bootstrap/promoted（与 metrics 的口径一致；
 *     实测 24 个会话 10725 次调用，与 metrics 的 step 窗口归属零差异）。
 *   - 错误率分母 = 窗口内去重后的 tool/result 数。
 *   - 批次部分失败：gateway 的 `BATCH PARTIAL FAILURE: x/y` 是 success 结果里的文本
 *     （宿主 native executor 不会把返回值的 isError 当失败）。单独计
 *     partialBatches/batchFailedItems，并给一个含批次的 failureRate；旧 errorRate 语义不变。
 *
 * 用法：
 *   node ~/.dsh/bin/lean-usage-report.mjs [--days 21] [--preset lean] [--json] [--sessions-root <dir>]
 *
 * 退出码：0 正常；1 没有可用会话；2 依赖的 metrics 模块不可用。
 */
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const HOME = homedir()
const LEAN_PATCH = join(HOME, '.dsh', '.agent-presets', 'lean', 'lean.patch.yml')
const METRICS_MODULE = join(HOME, '.dsh', '.agent-presets', 'lean', 'tools', 'lean-session-metrics.mjs')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
// --sessions-root 便于用合成日志验证窗口/去重/阶段口径（默认真实会话根）。
const SESSIONS = argOf('--sessions-root', join(HOME, '.dsh', 'sessions'))
const DAYS = Number(argOf('--days', '21'))
const PRESET = argOf('--preset', 'lean')
const JSON_OUT = argv.includes('--json')
const CUTOFF = Date.now() - DAYS * 86400_000

const ERROR_KEYS = [
  'file has not been read',
  'file changed since it was read',
  'old_string was not found',
  'old_string and new_string must differ',
  'not gateway-eligible',
  'Unknown tool',
  'sleep',
  'timed out',
  'No such file or directory',
  'is not a function',
  'permission denied',
]

let metrics
try {
  metrics = await import(pathToFileURL(METRICS_MODULE).href)
} catch (error) {
  console.error(`lean-usage-report: 无法加载 ${METRICS_MODULE}（${error.message ?? error}）`)
  console.error('  解析/签名/去重口径复用该模块；缺失时宁可失败，也不另维护一套冲突口径。')
  process.exit(2)
}
const { readSessionText, parseEvents, headerDerived } = metrics

const asNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const asString = (value) => (typeof value === 'string' ? value : '')
const phaseOfHeader = (header, firstHeader) => {
  if (header === null || firstHeader === null) return 'unattributed'
  return header.signature === firstHeader.signature ? 'bootstrap' : 'promoted'
}
/** session 内 seq 之前最近的 request/header（headers 已按 seq 升序）。 */
const governingHeader = (headers, seq) => {
  let found = null
  for (const header of headers) {
    if (header.seq <= seq) found = header
    else break
  }
  return found
}

const sessionFiles = []
const walkDir = (dir) => {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walkDir(p)
    // mtime 只是预筛：真正的窗口判定按事件时间（session 文件是追加写，mtime 早于窗口就不可能有窗口内事件）。
    else if (entry.name === 'session.v4.jsonl.zstd') {
      try { if (statSync(p).mtimeMs >= CUTOFF) sessionFiles.push(p) } catch {}
    }
  }
}
walkDir(SESSIONS)
sessionFiles.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

const calls = new Map()
const errors = new Map()
const errorKeys = new Map()
const byPhase = {
  bootstrap: { calls: 0, errors: 0 },
  promoted: { calls: 0, errors: 0 },
  unattributed: { calls: 0, errors: 0 },
}
let sessions = 0
let results = 0
let errorTotal = 0
/** Batch gateway calls whose outer result is a success but whose text marks partial failure. */
let partialBatches = 0
let batchFailedItems = 0
let outOfWindowCalls = 0
let outOfWindowResults = 0
let duplicateCalls = 0
let duplicateResults = 0
let latest = null
let latestMain = null

const resultIsError = (value) => {
  if (Array.isArray(value)) return value.some(resultIsError)
  if (value && typeof value === 'object') {
    if (value.isError === true || value.error !== undefined) return true
    for (const v of Object.values(value)) if (resultIsError(v)) return true
  }
  return false
}

for (const file of sessionFiles) {
  let text
  try { ({ text } = readSessionText(file)) } catch { continue }
  const { events } = parseEvents(text)
  const sessionEvent = events.find((event) => event.type === 'session')
  if (sessionEvent === undefined || sessionEvent.agentPreset !== PRESET) continue
  sessions += 1

  // request/header：signature / schemaChars 复用 metrics 的推导，避免第二套口径。
  const headers = []
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const tools = Array.isArray(event.data?.header?.tools) ? event.data.header.tools : []
    const derived = headerDerived(tools)
    headers.push({
      seq: asNumber(event.seq),
      time: asNumber(event.time),
      reason: asString(event.data?.reason) || '(missing)',
      toolCount: derived.toolNames.length,
      signature: derived.signature,
      schemaChars: derived.schemaChars,
      schemaCharsByTool: derived.schemaCharsByTool,
    })
  }
  headers.sort((a, b) => a.seq - b.seq)
  const firstHeader = headers[0] ?? null

  // tool/call：按 callId 去重（同 callId 只算第一次），再按事件时间切窗口。
  const callById = new Map()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = event.data ?? {}
    const callId = asString(data.callId)
    if (callId !== '' && callById.has(callId)) { duplicateCalls += 1; continue }
    const call = {
      callId,
      seq: asNumber(event.seq),
      time: asNumber(event.time),
      name: asString(data.name) || asString(data.toolName) || '?',
    }
    if (callId !== '') callById.set(callId, call)
    if (call.time < CUTOFF) { outOfWindowCalls += 1; continue }
    calls.set(call.name, (calls.get(call.name) ?? 0) + 1)
    byPhase[phaseOfHeader(governingHeader(headers, call.seq), firstHeader)].calls += 1
  }

  // tool/result：同 callId 只算第一次；错误统计与 errorRate 分母都只看窗口内结果。
  const resultById = new Map()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const data = event.data ?? {}
    const message = data.message ?? {}
    const callId = asString(message.toolCallId) || asString(data.toolCallId)
    if (callId !== '' && resultById.has(callId)) { duplicateResults += 1; continue }
    const record = { callId, seq: asNumber(event.seq), time: asNumber(event.time) }
    if (callId !== '') resultById.set(callId, record)
    if (record.time < CUTOFF) { outOfWindowResults += 1; continue }
    results += 1
    const body = data.message ?? data.result ?? data
    const bodyText = JSON.stringify(body)
    // The host's native executor reports a returned batch value as success.
    // Count the gateway's own partial-failure marker separately instead of
    // letting it disappear from the error rate.
    const batchFailure = /BATCH PARTIAL FAILURE: (\d+)\/(\d+) calls failed/.exec(bodyText)
    if (batchFailure !== null) {
      partialBatches += 1
      batchFailedItems += Number(batchFailure[1])
    }
    if (!resultIsError(body)) continue
    errorTotal += 1
    const call = callById.get(callId)
    const phase = phaseOfHeader(governingHeader(headers, call?.seq ?? record.seq), firstHeader)
    byPhase[phase].errors += 1
    const name = call?.name ?? '?'
    errors.set(name, (errors.get(name) ?? 0) + 1)
    for (const key of ERROR_KEYS) {
      if (bodyText.includes(key)) errorKeys.set(key, (errorKeys.get(key) ?? 0) + 1)
    }
  }

  // 常驻目录只认最新会话的最新 header；只保留这一个会话的 header 明细（内存友好）。
  // 另记最新主会话（origin != subagent）：subagent 会话的目录是子集，主 agent 的常驻成本看主会话。
  if (headers.length > 0) {
    const createdAt = asNumber(sessionEvent.createdAt)
    const candidate = {
      id: asString(sessionEvent.id) || file,
      createdAt,
      origin: asString(sessionEvent.origin) || null,
      headers,
      firstHeader,
    }
    if (latest === null || createdAt > latest.createdAt) latest = candidate
    if (candidate.origin !== 'subagent' && (latestMain === null || createdAt > latestMain.createdAt)) latestMain = candidate
  }
}

if (sessions === 0) {
  console.error(`lean-usage-report: 近 ${DAYS} 天没有 preset=${PRESET} 的会话（窗口按事件时间 ${new Date(CUTOFF).toISOString()} 起算）`)
  process.exit(1)
}

const describeHeader = (header, firstHeader) => ({
  phase: phaseOfHeader(header, firstHeader),
  reason: header.reason,
  toolCount: header.toolCount,
  at: new Date(header.time).toISOString(),
  seq: header.seq,
})

// 常驻成本：窗口内最新会话的最新 header；若它是 bootstrap，则另取最新 promoted header 并标注。
const residentOf = (candidate) => {
  const last = candidate.headers[candidate.headers.length - 1]
  const promoted = [...candidate.headers].reverse().find((header) => phaseOfHeader(header, candidate.firstHeader) === 'promoted') ?? null
  let chosen = last
  let source = 'latest-header'
  if (phaseOfHeader(last, candidate.firstHeader) === 'bootstrap') {
    if (promoted !== null) { chosen = promoted; source = 'promoted-fallback' } else source = 'bootstrap-only'
  }
  const rows = Object.entries(chosen.schemaCharsByTool)
    .map(([name, chars]) => ({ name, chars, calls: calls.get(name) ?? 0 }))
    .sort((a, b) => b.chars - a.chars)
  return {
    source,
    sessionId: candidate.id,
    sessionCreatedAt: new Date(candidate.createdAt).toISOString(),
    sessionOrigin: candidate.origin,
    phase: phaseOfHeader(chosen, candidate.firstHeader),
    reason: chosen.reason,
    seq: chosen.seq,
    at: new Date(chosen.time).toISOString(),
    tools: chosen.toolCount,
    chars: chosen.schemaChars,
    rows,
    // 兼容旧字段：原意是「这批 tools 的观测时间」，现在等于所选 header 的时间。
    latestSessionToolsAt: new Date(chosen.time).toISOString(),
    latestHeader: describeHeader(last, candidate.firstHeader),
    promotedHeader: promoted === null ? null : describeHeader(promoted, candidate.firstHeader),
  }
}
let resident = null
if (latest !== null) {
  // 窗口内最新会话如果只是 subagent 会话，它的目录是主 agent 的子集，不能代表 preset 的
  // 常驻成本：此时常驻成本按最新主会话算，并在 resident.latestSession 里保留最新会话的事实。
  const useMain = latest.origin === 'subagent' && latestMain !== null
  resident = residentOf(useMain ? latestMain : latest)
  resident.sessionScope = useMain ? 'latest-main-session' : 'latest-session'
  resident.latestSession = useMain ? residentOf(latest) : null
}

const totalCalls = [...calls.values()].reduce((a, b) => a + b, 0)
const errorRate = results === 0 ? 0 : (errorTotal / results) * 100
/** Outer isError plus batch partial failures; the plain errorRate keeps the old meaning. */
const failureRate = results === 0 ? 0 : ((errorTotal + partialBatches) / results) * 100
const sortedCalls = [...calls.entries()].sort((a, b) => b[1] - a[1])
const sortedErrors = [...errors.entries()].sort((a, b) => b[1] - a[1])
const sortedErrorKeys = [...errorKeys.entries()].sort((a, b) => b[1] - a[1])

const payload = {
  window: {
    days: DAYS,
    preset: PRESET,
    sessions,
    cutoff: new Date(CUTOFF).toISOString(),
    eventTimeFiltered: true,
    dedupedByCallId: true,
    excludedCalls: outOfWindowCalls,
    excludedResults: outOfWindowResults,
    duplicateCalls,
    duplicateResults,
  },
  totals: {
    calls: totalCalls,
    results,
    errors: errorTotal,
    errorRate: Number(errorRate.toFixed(2)),
    partialBatches,
    batchFailedItems,
    failureRate: Number(failureRate.toFixed(2)),
  },
  byPhase,
  calls: Object.fromEntries(sortedCalls),
  errors: Object.fromEntries(sortedErrors),
  errorKeys: Object.fromEntries(sortedErrorKeys),
  resident,
}

if (JSON_OUT) {
  console.log(JSON.stringify(payload, null, 2))
  process.exit(0)
}

console.log(`lean-usage-report: 近 ${DAYS} 天 preset=${PRESET} 会话 ${sessions} 个（窗口按事件时间 >= ${payload.window.cutoff} 切）`)
console.log(`调用 ${totalCalls} 次 / 结果 ${results} 个 / 错误 ${errorTotal} 个（${errorRate.toFixed(2)}%）`)
if (partialBatches > 0) {
  console.log(`  批次部分失败 ${partialBatches} 次 / ${batchFailedItems} 个子项（外层 isError=false，单列；含批次失败率 ${failureRate.toFixed(2)}%）`)
}
console.log(`  阶段：bootstrap 调用 ${byPhase.bootstrap.calls} / promoted 调用 ${byPhase.promoted.calls} / 未归属 ${byPhase.unattributed.calls}`)
console.log(`  去重：同 callId 重复 tool/call ${duplicateCalls} 次、tool/result ${duplicateResults} 个；窗口外调用 ${outOfWindowCalls} 次、结果 ${outOfWindowResults} 个（不计入）`)
console.log('')
const residentScope = resident?.sessionScope === 'latest-main-session' ? '最新主会话' : '最新会话'
console.log(`── 常驻成本（${residentScope}的最新 request/header）──`)
if (resident === null) {
  console.log('  没有可用的 request/header 快照')
} else {
  console.log(`  会话 ${resident.sessionId}${resident.sessionOrigin === null ? '' : `（${resident.sessionOrigin}）`}，created ${resident.sessionCreatedAt}`)
  console.log(`  最新 header：phase=${resident.latestHeader.phase} reason=${resident.latestHeader.reason} tools=${resident.latestHeader.toolCount} at=${resident.latestHeader.at}`)
  if (resident.source === 'promoted-fallback') {
    console.log(`  最新 header 是 bootstrap（装载阶段，不是常驻态），下列成本取该会话最新的 promoted header：phase=${resident.phase} reason=${resident.reason} tools=${resident.tools} at=${resident.at}（seq ${resident.seq}）`)
  } else if (resident.source === 'bootstrap-only') {
    console.log(`  该会话只有 bootstrap header（无 promoted）：常驻成本按装载阶段目录计算，phase=${resident.phase} reason=${resident.reason} tools=${resident.tools} at=${resident.at}`)
  } else {
    console.log(`  常驻成本按最新 header：phase=${resident.phase} reason=${resident.reason} tools=${resident.tools} at=${resident.at}（seq ${resident.seq}）`)
  }
  console.log(`  共 ${resident.tools} 个工具，合计 ${resident.chars} 字符/请求`)
  for (const row of resident.rows) {
    const pct = ((row.calls / (totalCalls || 1)) * 100).toFixed(2)
    console.log(`  ${String(row.chars).padStart(6)} 字符  ${String(row.calls).padStart(6)} 次 (${pct.padStart(5)}%)  ${row.name}`)
  }
  if (resident.latestSession !== null && resident.latestSession !== undefined) {
    const sub = resident.latestSession
    console.log(`  说明：窗口内最新会话是 subagent 会话 ${sub.sessionId}（created ${sub.sessionCreatedAt}），其最新 header tools=${sub.tools}、${sub.chars} 字符；子会话目录是主 agent 的子集，故常驻成本按最新主会话计。`)
  }
}
console.log('')
console.log('── 工具调用（top 25）──')
const totalPct = totalCalls === 0 ? 0 : 100 / totalCalls
for (const [name, count] of sortedCalls.slice(0, 25)) {
  console.log(`  ${String(count).padStart(6)} 次 (${((count * totalPct).toFixed(2)).padStart(5)}%)  ${name}`)
}
console.log('')
console.log('── 错误（top 12）──')
if (sortedErrors.length === 0) console.log('  无')
for (const [name, count] of sortedErrors.slice(0, 12)) {
  console.log(`  ${String(count).padStart(6)} 次  ${name}`)
}
console.log('')
console.log('── 错误文本归类 ──')
if (sortedErrorKeys.length === 0) console.log('  无')
for (const [key, count] of sortedErrorKeys) {
  console.log(`  ${String(count).padStart(6)} 次  ${key}`)
}
if (existsSync(LEAN_PATCH)) {
  console.log('')
  console.log(`（常驻名单来源：${LEAN_PATCH}；成本数字来自会话 request/header 实测）`)
}
