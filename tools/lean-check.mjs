#!/usr/bin/env node
/**
 * lean-check — Lean 预设的静态体检（只读，不修改任何文件）。
 *
 * 覆盖四项检查：
 *   #7 技能工具名 lint：技能/规则里写死的工具名是否还在 Lean 的工具表里
 *   #12 预设一致性：lean.patch.yml 引用的本地插件文件是否存在、id 是否重复
 *   #1 静态回归断言：规则结构完整、无已知死工具名
 *   20261103-lean-opt：宿主 Config 键对比（lean-config-keys.mjs）——抓
 *     schemastery 静默丢弃的未知键（A1 的 modelSelectionSettings 类问题）。
 *     需要 schema 缓存（~/.dsh/cache/lean-config-schema.json），缺失时只提示跳过。
 *
 * 用法：node ~/.dsh/bin/lean-check.mjs [--json]
 * 退出码：0 全通过；1 有 error；2 只有 warning。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { check as checkConfigKeys } from './lean-config-keys.mjs'

const HOME = homedir()
const LEAN_DIR = join(HOME, '.dsh', '.agent-presets', 'lean')
const AGENTS_MD = join(HOME, '.dsh', 'AGENTS.md')
import { realpathSync } from 'node:fs'
const DEFAULT_SKILL_ROOTS = [
  join(HOME, '.agents', 'skills'),
  join(HOME, '.claude', 'skills'),
  join(HOME, '.codex', 'skills'),
]
// 测试可用 LEAN_CHECK_SKILLS 指定根目录（冒号分隔）；默认根目录按 realpath 去重，
// 因为 ~/.agents/skills 与 ~/.claude/skills 常常是同一份的软链接。
const SKILL_ROOTS = (process.env.LEAN_CHECK_SKILLS
  ? process.env.LEAN_CHECK_SKILLS.split(':')
  : DEFAULT_SKILL_ROOTS
).filter((dir) => existsSync(dir)).filter((dir, i, all) => {
  try { const real = realpathSync(dir); return all.findIndex((d) => { try { return realpathSync(d) === real } catch { return false } }) === i } catch { return true }
})
const PATCH = join(LEAN_DIR, 'lean.patch.yml')

const errors = []
const warnings = []
const info = []
const err = (m) => errors.push(m)
const warn = (m) => warnings.push(m)

// ── 工具表 ────────────────────────────────────────────────────────────────
// 宿主版本决定部分工具是否存在：alpha.3 起新增 apply_patch（默认关闭）。
function dshVersion() {
  if (process.env.LEAN_CHECK_DSH_VERSION) return process.env.LEAN_CHECK_DSH_VERSION
  try { return execFileSync('dsh', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim() } catch { return '' }
}
function versionAtLeast(current, floor) {
  const parse = (v) => String(v).trim().replace(/^dsh-v?/, '').split('-')
  const [ca, cb] = [parse(current), parse(floor)]
  const nums = (v) => v[0].split('.').map((n) => Number.parseInt(n, 10) || 0)
  const [a, b] = [nums(ca), nums(cb)]
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  if (ca[1] === undefined) return true
  if (cb[1] === undefined) return false
  const pa = ca[1].match(/^(.*?)(\d*)$/)
  const pb = cb[1].match(/^(.*?)(\d*)$/)
  if (pa[1] !== pb[1]) return pa[1] > pb[1]
  return Number.parseInt(pa[2] || '0', 10) >= Number.parseInt(pb[2] || '0', 10)
}
const VERSION = dshVersion()
const HAS_APPLY_PATCH = versionAtLeast(VERSION, '0.2.2-alpha.3')

const BASE_TOOLS = [
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'read_image', 'todo_write',
  'ask_user_question', 'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code',
  'workflow', 'skill', 'skill_load', 'skill_search', 'tool_gateway', 'rule_load', 'dev_tool_search',
  'exit_plan_mode', 'web_fetch', 'web_search', 'working_directory', 'job_list', 'job_output',
  'job_kill', 'list_agents', 'send_message', 'interrupt_agent', 'create_goal', 'update_goal', 'get_goal',
  'str_replace_editor', 'memory_search', 'workflow_ptc', 'terminal_bash', 'persistent_bash',
]

function knownTools() {
  const set = new Set(BASE_TOOLS)
  if (HAS_APPLY_PATCH) set.add('apply_patch')
  const index = join(LEAN_DIR, 'dev-tool-search.mjs')
  if (existsSync(index)) {
    const text = readFileSync(index, 'utf8')
    for (const m of text.matchAll(/\bname:\s*'([a-z][a-z0-9_]*)'/g)) set.add(m[1])
  }
  if (existsSync(PATCH)) {
    const text = readFileSync(PATCH, 'utf8')
    for (const m of text.matchAll(/residentTools:\s*\[([^\]]*)\]/g)) {
      for (const name of m[1].matchAll(/'([a-z][a-z0-9_]*)'/g)) set.add(name[1])
    }
  }
  return set
}

// 只把“看起来像动作”的 token 当工具名：动词前缀 + snake_case。
// 技能文档里的状态字段（partial_success、confirmation_required）不是工具，不能报。
const TOOL_VERB = /^(read|write|edit|str_replace|bash|glob|grep|search|list|get|create|update|delete|send|run|exec|load|open|close|fetch|call|job|skill|tool|subagent|workflow|memory|mcp__)/
const isToolLike = (token) => /^[a-z][a-z0-9_]{2,40}$/.test(token)
  && (BASE_TOOLS.includes(token) || token.startsWith('mcp__') || TOOL_VERB.test(token) || token.includes('_'))

// 只在“确认不存在于 Lean 工具表”的名单上判 error：这些是历史审计里出现过的
// ChatGPT/Cursor 风格工具名，Lean 从未提供。其余未知名降级为 info（--verbose 才打印），
// 避免把 MCP 工具（use_figma、js_repl）或字段名（*_id）误判成错误。
const KNOWN_DEAD = new Set([
  ...(HAS_APPLY_PATCH ? [] : ['apply_patch']), 'str_replace', 'read_file', 'write_file', 'edit_file',
  'run_command', 'execute_command', 'search_files', 'list_dir', 'shell_command',
])
const FIELD_SUFFIX = /(_id|_ids|_name|_type|_key|_at|_seconds|_status|_shape)$/

function unknownToolsIn(text, known) {
  const out = new Set()
  const dead = []
  for (const line of String(text).split('\n')) {
    // 用整行判定“这句话在讲怎么用工具”，避免只看反引号前 14 字符造成假阴性。
    if (!/(调用|使用|执行|通过|借助|改用|以\s*`|工具|tool|Tool|call\(|invoke|use\s+`)/.test(line)) continue
    for (const m of line.matchAll(/`([^`\n]{1,60})`/g)) {
      const token = m[1].trim()
      // 排除“状态/字段”语境：同一行出现 状态|字段|返回|status|field 且 token 紧跟其后。
      const before = line.slice(Math.max(0, m.index - 20), m.index)
      if (/(状态|字段|返回|status|field)\s*(为|是|=|:|：)?\s*$/i.test(before)) continue
      if (!isToolLike(token)) continue
      if (token.startsWith('mcp__') || token.endsWith('*')) continue
      if (known.has(token)) continue
      if (token.includes('_') === false) continue
      if (KNOWN_DEAD.has(token)) { dead.push(token); continue }
      if (FIELD_SUFFIX.test(token)) continue
      out.add(token)
    }
  }
  return { unknown: [...out], dead: [...dead] }
}

// ── 检查 1：技能工具名 ────────────────────────────────────────────────────
function checkSkills(known) {
  if (SKILL_ROOTS.length === 0) { warn('未找到任何技能目录'); return 0 }
  let scanned = 0
  for (const root of SKILL_ROOTS) {
    for (const name of readdirSync(root)) {
      const file = join(root, name, 'SKILL.md')
      if (!existsSync(file)) continue
      scanned += 1
      const { unknown, dead } = unknownToolsIn(readFileSync(file, 'utf8'), known)
      if (dead.length > 0) err(`技能 ${name}: 使用了 Lean 不存在的工具名 ${[...new Set(dead)].join(', ')}`)
      if (unknown.length > 0) info.push(`技能 ${name}: 未识别的疑似工具名 ${unknown.join(', ')}`)
    }
  }
  return scanned
}

// ── 检查 2：预设一致性 ────────────────────────────────────────────────────
function checkPreset(known) {
  if (!existsSync(PATCH)) { err(`预设文件缺失：${PATCH}`); return }
  const text = readFileSync(PATCH, 'utf8')
  const ids = [...text.matchAll(/^\s*-\s*id:\s*([A-Za-z0-9_.-]+)\s*(?:#.*)?$/gm)].map((m) => m[1])
  const seen = new Set()
  for (const id of ids) {
    if (seen.has(id)) err(`lean.patch.yml: 重复的插件 id "${id}"`)
    seen.add(id)
  }
  const refs = [...text.matchAll(/name:\s*'(@local\/dsh-agent-preset-lean\/[^']+)'/g)].map((m) => m[1])
  for (const ref of new Set(refs)) {
    const file = ref.replace('@local/dsh-agent-preset-lean/', '').split('?')[0]
    if (!existsSync(join(LEAN_DIR, file))) err(`lean.patch.yml 引用的文件不存在：${file}`)
  }
  const localRefs = [...text.matchAll(/name:\s*'(\.\/[^']+)'/g)].map((m) => m[1])
  for (const ref of new Set(localRefs)) {
    const file = ref.replace('./', '').split('?')[0]
    if (!existsSync(join(LEAN_DIR, file))) err(`lean.patch.yml 引用的文件不存在：${ref}`)
  }
  return { ids: ids.length, refs: new Set(refs).size }
}

// ── 检查 3：规则静态断言 ──────────────────────────────────────────────────
function checkRules(known) {
  if (!existsSync(AGENTS_MD)) { err(`规则文件缺失：${AGENTS_MD}`); return }
  const text = readFileSync(AGENTS_MD, 'utf8')
  for (let i = 0; i <= 8; i += 1) {
    if (!new RegExp(`^##\\s*${i}\\.\\s`, 'm').test(text)) err(`AGENTS.md 缺少第 ${i} 章`)
  }
  const { unknown, dead } = unknownToolsIn(text, known)
  if (dead.length > 0) errors.push(`AGENTS.md: 使用了 Lean 不存在的工具名 ${[...new Set(dead)].join(', ')}`)
  if (unknown.length > 0) info.push(`AGENTS.md: 未识别的疑似工具名 ${unknown.join(', ')}`)
  // apply_patch 在 alpha.2 及更早不存在，alpha.3 起成为默认关闭的内置工具。
  if (!HAS_APPLY_PATCH && text.includes('apply_patch')) {
    err(`AGENTS.md 仍引用当前版本不存在的工具：apply_patch（${VERSION || '版本未知'}）`)
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
// --skills-only / --preset-only 让测试与 CI 只跑单个子检查，避免把
// AGENTS.md / lean.patch.yml 的现状耦合进技能夹具的断言。
const argv = process.argv.slice(2)
const only = argv.find((a) => a === '--skills-only' || a === '--preset-only')
const runSkills = only === undefined || only === '--skills-only'
const runPreset = only === undefined || only === '--preset-only'
const runRules = only === undefined

const known = knownTools()
const scanned = runSkills ? checkSkills(known) : 0
const preset = runPreset ? checkPreset(known) : undefined
if (runRules) checkRules(known)

// 20261103-lean-opt：宿主 Config 键对比。schemastery 非严格，未知键被静默丢弃
// （A1 的 modelSelectionSettings 就是这样消失的）。需要 schema 缓存；缺失时只记
// info，不阻塞 CI。生成方式见 lean-config-keys.mjs 文件头。
// 20261106：schema 结构不可信 / 零覆盖 / 部分覆盖都不算通过，必须显式告警。
const configKeys = runPreset ? checkConfigKeys({ patchPath: PATCH }) : undefined
if (configKeys !== undefined) {
  const keyPathsOf = (row) => (Array.isArray(row.paths) && row.paths.length > 0 ? row.paths : row.keys ?? [])
  // unknown 与 missing 可能同时存在（status 只取优先级最高的那个），两个列表都要报。
  for (const row of configKeys.unknown ?? []) {
    warn(`配置键：${row.id} (${row.name}) 传了宿主不接受的键 ${keyPathsOf(row).join(', ')}${row.accepted.length > 0 ? `；宿主接受 ${row.accepted.join(', ')}` : ''}`)
  }
  for (const row of configKeys.missing ?? []) {
    warn(`配置键：${row.id} (${row.name}) 缺少 schema required 的必填键 ${keyPathsOf(row).join(', ')}`)
  }
  if (configKeys.status === 'no-coverage') {
    warn(`配置键：零覆盖——${configKeys.configRows} 个带对象 config 的插件行一行都没完成校验，不能当通过（schema 条目 ${configKeys.schemaEntries}）`)
  }
  if (configKeys.status === 'partial') {
    warn(`配置键：部分覆盖 ${configKeys.checked}/${configKeys.configRows}（不是完整验收），${configKeys.uncheckedCount} 行无可用 schema；未发现 unknown/missing。schema 自报 complete=${configKeys.schema?.complete === true}`)
  }
  if (configKeys.status === 'schema-invalid') {
    warn(`配置键：schema 缓存结构不可信（${(configKeys.problems ?? []).join('；') || configKeys.message}），本次结果不能作为通过依据`)
  }
}

const mode = process.argv.includes('--json')
if (mode) {
  console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings, info, skills: scanned, preset, configKeys }, null, 2))
} else {
  console.log(`lean-check: 宿主 ${VERSION || '未知'}（apply_patch ${HAS_APPLY_PATCH ? '存在，默认关闭' : '不存在'}）`)
  if (runSkills) console.log(`lean-check: 扫描技能 ${scanned} 个`)
  if (runPreset) console.log(`lean-check: 预设 id 行 ${preset?.ids ?? 0} 个（含 group）、本地引用 ${preset?.refs ?? 0} 个`)
  if (configKeys !== undefined) {
    if (configKeys.schema?.sha256) {
      const local = configKeys.localPlugins?.rows > 0 ? `；本地插件 ${configKeys.localPlugins.rows} 行按本地契约跳过` : ''
      console.log(`lean-check: schema 指纹 ${configKeys.hostVersion || '宿主版本未知'} / sha256:${String(configKeys.schema.sha256).slice(0, 12)}… / ${configKeys.schema.mtime ?? 'mtime 未知'}${local}`)
    }
    if (configKeys.status === 'ok') console.log(`lean-check: 配置键对比通过（${configKeys.checked}/${configKeys.configRows} 行，schema 条目 ${configKeys.schemaEntries}）`)
    else if (configKeys.status === 'unknown-keys') {
      const missingCount = configKeys.missing?.length ?? 0
      console.log(`lean-check: 配置键对比发现 ${configKeys.unknown.length} 行未知键${missingCount > 0 ? `、${missingCount} 行缺必填键` : ''}（见 WARN）`)
    }
    else if (configKeys.status === 'missing-keys') console.log(`lean-check: 配置键对比发现 ${configKeys.missing.length} 行缺必填键（见 WARN）`)
    else if (configKeys.status === 'partial') console.log(`lean-check: 配置键对比部分覆盖 ${configKeys.checked}/${configKeys.configRows}（不是完整验收，见 WARN）`)
    else if (configKeys.status === 'no-coverage') console.log(`lean-check: 配置键对比零覆盖（${configKeys.configRows} 行 config 一行未校验，见 WARN）`)
    else if (configKeys.status === 'schema-invalid') console.log('lean-check: 配置键对比不可信（schema-invalid，见 WARN）')
    else console.log(`lean-check: 配置键对比跳过（${configKeys.status}）`)
  }
  if (runSkills) console.log('提示：工具名检查只对已知死名单报 error；其他未知名用 --verbose 人工巡检')
  for (const w of warnings) console.log(`WARN  ${w}`)
  if (process.argv.includes('--verbose')) for (const i of info) console.log(`INFO  ${i}`)
  for (const e of errors) console.log(`ERROR ${e}`)
  if (errors.length > 0) console.log(`失败：${errors.length} 项 error`)
  else if (warnings.length > 0) console.log(`通过（${warnings.length} 项 warning，退出码 2）`)
  else console.log('通过')
}
process.exit(errors.length > 0 ? 1 : warnings.length > 0 ? 2 : 0)
