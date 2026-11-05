#!/usr/bin/env node
/**
 * lean-usage-report — lean 预设的常驻成本/使用率报表（只读）。
 *
 * 回答两个问题：
 *   1. 每个常驻工具的 schema 每请求花多少字符，实际被调用多少次？
 *   2. 历史会话里的工具错误集中在哪些文本上（用于判断提示/守卫是否值得改）？
 *
 * 数据来源：~/.dsh/sessions/**\/session.v4.jsonl.zstd（近 N 天、指定 preset）。
 * 常驻成本取最近一个会话晋升后 request/header 里的真实 tools JSON 长度，
 * 而不是源码估算。
 *
 * 用法：
 *   node ~/.dsh/bin/lean-usage-report.mjs [--days 21] [--preset lean] [--json]
 *
 * 退出码：0 正常；1 没有可用会话。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = homedir()
const SESSIONS = join(HOME, '.dsh', 'sessions')
const LEAN_PATCH = join(HOME, '.dsh', '.agent-presets', 'lean', 'lean.patch.yml')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
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

const sessionFiles = []
const walkDir = (dir) => {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walkDir(p)
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
let sessions = 0
let results = 0
let errorTotal = 0
let latestPromotedTools = null
let latestToolsAt = 0

const resultIsError = (value) => {
  if (Array.isArray(value)) return value.some(resultIsError)
  if (value && typeof value === 'object') {
    if (value.isError === true || value.error !== undefined) return true
    for (const v of Object.values(value)) if (resultIsError(v)) return true
  }
  return false
}

for (const file of sessionFiles) {
  let raw
  try { raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 }) } catch { continue }
  const pending = new Map()
  let sessionResults = 0
  let sessionIsLean = false
  let sessionMaxTools = null
  let sessionMaxAt = 0
  for (const line of raw.toString('utf8').split('\n')) {
    if (line.length === 0) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'session') {
      sessionIsLean = event.agentPreset === PRESET
      if (!sessionIsLean) break
    } else if (event.type === 'tool/call') {
      const data = event.data ?? {}
      const name = data.name ?? data.toolName ?? '?'
      calls.set(name, (calls.get(name) ?? 0) + 1)
      pending.set(data.callId ?? data.id, name)
    } else if (event.type === 'tool/result') {
      sessionResults += 1
      const data = event.data ?? {}
      const body = data.message ?? data.result ?? data
      if (resultIsError(body)) {
        errorTotal += 1
        const message = body.message ?? body
        const callId = data.message?.toolCallId ?? message.toolCallId ?? data.callId ?? data.id
        const name = pending.get(callId) ?? '?'
        errors.set(name, (errors.get(name) ?? 0) + 1)
        const text = JSON.stringify(body)
        for (const key of ERROR_KEYS) {
          if (text.includes(key)) errorKeys.set(key, (errorKeys.get(key) ?? 0) + 1)
        }
      }
    } else if (event.type === 'request/header') {
      const tools = event.data?.header?.tools
      if (Array.isArray(tools) && tools.length > (sessionMaxTools?.length ?? 0)) {
        sessionMaxTools = tools
        sessionMaxAt = statSync(file).mtimeMs
      }
    }
  }
  if (sessionIsLean) {
    sessions += 1
    results += sessionResults
    // 降序遍历：第一个会话就是最近的 lean 会话，它的晋升后目录最有代表性。
    if (latestPromotedTools === null && sessionMaxTools !== null) {
      latestPromotedTools = sessionMaxTools
      latestToolsAt = sessionMaxAt
    }
  }
  pending.clear()
}

if (sessions === 0) {
  console.error(`lean-usage-report: 近 ${DAYS} 天没有 preset=${PRESET} 的会话`)
  process.exit(1)
}

// 常驻成本：最近一个会话晋升后的 tools 列表（gateway 工具不在其中）。
const costRows = []
let residentChars = 0
if (latestPromotedTools !== null) {
  for (const tool of latestPromotedTools) {
    const chars = JSON.stringify(tool).length
    residentChars += chars
    costRows.push({ name: tool.name, chars, calls: calls.get(tool.name) ?? 0 })
  }
}

const totalCalls = [...calls.values()].reduce((a, b) => a + b, 0)
const errorRate = results === 0 ? 0 : (errorTotal / results) * 100
const sortedCalls = [...calls.entries()].sort((a, b) => b[1] - a[1])
const sortedErrors = [...errors.entries()].sort((a, b) => b[1] - a[1])
const sortedErrorKeys = [...errorKeys.entries()].sort((a, b) => b[1] - a[1])

const payload = {
  window: { days: DAYS, preset: PRESET, sessions },
  totals: { calls: totalCalls, results, errors: errorTotal, errorRate: Number(errorRate.toFixed(2)) },
  calls: Object.fromEntries(sortedCalls),
  errors: Object.fromEntries(sortedErrors),
  errorKeys: Object.fromEntries(sortedErrorKeys),
  resident: latestPromotedTools === null
    ? null
    : {
        tools: latestPromotedTools.length,
        chars: residentChars,
        latestSessionToolsAt: new Date(latestToolsAt).toISOString(),
        rows: costRows.sort((a, b) => b.chars - a.chars),
      },
}

if (JSON_OUT) {
  console.log(JSON.stringify(payload, null, 2))
  process.exit(0)
}

console.log(`lean-usage-report: 近 ${DAYS} 天 preset=${PRESET} 会话 ${sessions} 个`)
console.log(`调用 ${totalCalls} 次 / 结果 ${results} 个 / 错误 ${errorTotal} 个（${errorRate.toFixed(2)}%）`)
console.log('')
console.log('── 常驻成本（最近一个会话晋升后的真实 tools schema）──')
if (latestPromotedTools === null) {
  console.log('  没有可用的 request/header 快照')
} else {
  console.log(`  共 ${latestPromotedTools.length} 个工具，合计 ${residentChars} 字符/请求`)
  const totalPct = totalCalls === 0 ? 0 : 100 / totalCalls
  for (const row of payload.resident.rows) {
    const pct = ((row.calls / (totalCalls || 1)) * 100).toFixed(2)
    console.log(`  ${String(row.chars).padStart(6)} 字符  ${String(row.calls).padStart(6)} 次 (${pct.padStart(5)}%)  ${row.name}`)
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
