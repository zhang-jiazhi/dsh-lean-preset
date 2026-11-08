#!/usr/bin/env node
/**
 * lean-config-keys — 用宿主 alpha.3 的真实 Config schema 校验 lean.patch.yml 的配置键。
 *
 * 动机：schemastery 的 Config 是**非严格**的，插件不认识的键会被静默丢弃。
 * 0.2.2-alpha.3 把 subagent 的 `modelSelectionSettings` 拆成
 * `modelSelection` + `modelDiscovery`，旧键不报错、只是能力消失（list_subagent_models
 * 不注册、provider/model 路由参数消失）。lean-check 原有的三类检查都看不到这类问题。
 *
 * 做法：
 *   1. 读 `--dump-config-schema` 的输出（默认缓存到 ~/.dsh/cache/lean-config-schema.json）
 *   2. 从 x-cordis.entries 取每个 entry 的 Config schema properties
 *   3. 解析 lean.patch.yml 每个带 config 的插件行的键
 *   4. 输出「传了但宿主 schema 不接受」的键（warning 级，不是 error）
 *
 * 用法：
 *   node ~/.dsh/bin/lean-config-keys.mjs [--schema <path>] [--patch <path>] [--json]
 *
 * 缓存 schema 的生成方式（CLI 不能直接读 desktop 正式 profile）：
 *   复制 profile 到 $TMP/profiles/<name>（node_modules 用 symlink），然后
 *   DSH_HOME=$TMP dsh --profile <name> --dump-config-schema > ~/.dsh/cache/lean-config-schema.json
 *   注意该命令可能因第三方包缺 peer 返回非 0（stderr 有 error），但 stdout 仍是有效 schema；
 *   本脚本只信 stdout，并在 complete=false 时提示。
 *
 * 退出码：0 通过；1 发现未知键；2 schema 文件缺失/不可解析。
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const HOME = homedir()
const DEFAULT_SCHEMA = join(HOME, '.dsh', 'cache', 'lean-config-schema.json')
const DEFAULT_PATCH = join(HOME, '.dsh', '.agent-presets', 'lean', 'lean.patch.yml')

const YAML_TAG = 'tag:yaml.org,2002:js'

const loadYaml = () => {
  const candidates = [
    join(HOME, '.dsh', 'profiles', 'desktop', 'package.json'),
    join(HOME, '.dsh', 'profiles', 'web', 'package.json'),
  ]
  let yaml
  for (const anchor of candidates) {
    if (!existsSync(anchor)) continue
    try { yaml = createRequire(anchor)('js-yaml'); break } catch {}
  }
  if (yaml === undefined) {
    try { yaml = createRequire(import.meta.url)('js-yaml') } catch {}
  }
  return yaml
}

/** 递归收集一个 JSON Schema 节点在「当前层」接受的键；'*' 表示接受任意键。 */
const collectKeys = (node, defs, out) => {
  if (node === null || typeof node !== 'object') return
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/$defs/')) {
    const def = defs[node.$ref.slice('#/$defs/'.length)]
    if (def !== undefined) collectKeys(def, defs, out)
  }
  if (node.properties !== undefined && typeof node.properties === 'object') {
    for (const key of Object.keys(node.properties)) out.add(key)
  }
  for (const branch of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(node[branch])) for (const child of node[branch]) collectKeys(child, defs, out)
  }
  if (node.additionalProperties === true) out.add('*')
  // 一个 object 分支完全没有 properties 且未禁止额外键 => 无法判断接受哪些键。
  if (node.type === 'object' && node.properties === undefined && node.additionalProperties !== false) out.add('*')
}

const buildSchemaMap = (schema) => {
  const defs = schema.$defs ?? {}
  const entries = schema['x-cordis']?.entries ?? []
  const map = new Map()
  for (const entry of entries) {
    if (entry.status !== 'schema' || typeof entry.name !== 'string') continue
    const ref = entry.configRef ?? ''
    const defName = ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : undefined
    const def = defName === undefined ? undefined : defs[defName]
    if (def === undefined) continue
    const keys = new Set()
    collectKeys(def, defs, keys)
    if (keys.size === 0) continue
    const prev = map.get(entry.name)
    if (prev === undefined) map.set(entry.name, keys)
    else for (const key of keys) prev.add(key)
  }
  return map
}

/** 遍历 patch 的插件行：带 id/name 且 config 为对象的行。 */
const collectRows = (node, out) => {
  if (Array.isArray(node)) {
    for (const child of node) collectRows(child, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  if (typeof node.id === 'string' && typeof node.name === 'string') {
    out.push({ id: node.id, name: node.name, config: node.config })
  }
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === 'object') collectRows(value, out)
  }
  return out
}

export const check = ({ schemaPath = DEFAULT_SCHEMA, patchPath = DEFAULT_PATCH } = {}) => {
  if (!existsSync(schemaPath)) {
    return { status: 'schema-missing', schemaPath, patchPath }
  }
  if (!existsSync(patchPath)) {
    return { status: 'patch-missing', schemaPath, patchPath }
  }
  let schema
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  } catch (error) {
    return { status: 'schema-unparsable', schemaPath, patchPath, message: String(error.message ?? error) }
  }
  const yaml = loadYaml()
  if (yaml === undefined) {
    return { status: 'js-yaml-missing', schemaPath, patchPath }
  }
  const tag = new yaml.Type(YAML_TAG, { kind: 'scalar', construct: (data) => data })
  const dialect = yaml.CORE_SCHEMA.extend([tag])
  let patch
  try {
    patch = yaml.load(readFileSync(patchPath, 'utf8'), { schema: dialect })
  } catch (error) {
    return { status: 'patch-unparsable', schemaPath, patchPath, message: String(error.message ?? error) }
  }

  const schemaMap = buildSchemaMap(schema)
  const rows = collectRows(patch, [])
  const unknown = []
  const unchecked = []
  let checked = 0
  for (const row of rows) {
    const config = row.config
    if (config === null || typeof config !== 'object' || Array.isArray(config)) continue
    const allowed = schemaMap.get(row.name)
    if (allowed === undefined) { unchecked.push({ id: row.id, name: row.name, reason: 'no schema' }); continue }
    if (allowed.has('*')) { unchecked.push({ id: row.id, name: row.name, reason: 'accepts any key' }); continue }
    checked += 1
    const extra = Object.keys(config).filter((key) => !allowed.has(key))
    if (extra.length > 0) unknown.push({ id: row.id, name: row.name, keys: extra, accepted: [...allowed].sort() })
  }
  return {
    status: unknown.length > 0 ? 'unknown-keys' : 'ok',
    schemaPath,
    patchPath,
    complete: schema['x-cordis']?.complete !== false,
    schemaEntries: schemaMap.size,
    rows: rows.length,
    checked,
    unknown,
    uncheckedCount: unchecked.length,
    unchecked: unchecked.slice(0, 10),
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const result = check({ schemaPath: argOf('--schema', DEFAULT_SCHEMA), patchPath: argOf('--patch', DEFAULT_PATCH) })

if (argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.status === 'ok' ? 0 : result.status === 'unknown-keys' ? 1 : 2)
}

if (result.status === 'schema-missing') {
  console.log(`lean-config-keys: 缺少 schema 缓存 ${result.schemaPath}`)
  console.log('  生成：复制 profile 到 $TMP/profiles/<name>（node_modules 用 symlink），再')
  console.log('  DSH_HOME=$TMP dsh --profile <name> --dump-config-schema > ~/.dsh/cache/lean-config-schema.json')
  process.exit(2)
}
if (result.status === 'schema-unparsable' || result.status === 'patch-unparsable' || result.status === 'js-yaml-missing') {
  console.log(`lean-config-keys: 无法解析（${result.status}）${result.message ?? ''}`)
  process.exit(2)
}
console.log(`lean-config-keys: 宿主 schema 条目 ${result.schemaEntries} 个，校验插件行 ${result.checked}/${result.rows} 个`)
if (!result.complete) console.log('  提示：schema 的 x-cordis.complete=false（部分条目 absent），未覆盖的行见下方')
if (result.unknown.length === 0) {
  console.log('通过：lean.patch.yml 的配置键都在宿主 Config schema 内')
  if (result.uncheckedCount > 0) console.log(`  ${result.uncheckedCount} 行未校验（无 schema 或接受任意键），例如 ${result.unchecked.map((row) => row.id).join(', ')}`)
  process.exit(0)
}
console.log(`发现 ${result.unknown.length} 行传了宿主 schema 不接受的键（schemastery 会静默丢弃）：`)
for (const row of result.unknown) {
  console.log(`  ${row.id} (${row.name}): ${row.keys.join(', ')}`)
  console.log(`    宿主接受：${row.accepted.join(', ')}`)
}
process.exit(1)
}
