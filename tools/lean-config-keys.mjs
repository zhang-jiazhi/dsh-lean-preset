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
 *   2. 校验 schema 来源本身可信（dialect/profile/entries/complete），不可信就 schema-invalid
 *   3. 从 x-cordis.entries 取每个 entry 的 Config schema，按 $ref/$defs 递归校验
 *      lean.patch.yml 每个带对象 config 的插件行（顶层键 + 嵌套键 + required）
 *   4. 输出「传了但宿主 schema 不接受」的 unknown、以及 schema required 里缺的 missing
 *
 * 覆盖率口径：只有**真正完成校验**的行才计入 checked；有 schema 但无法判定键策略的行
 * （unknownConfig、接受任意键、$ref 断链）只算 unchecked。checked < configRows 时状态是
 * partial（不是 ok），零覆盖是 no-coverage —— 零覆盖不能当通过。
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
 * 退出码：0 通过（ok）；1 unknown-keys / missing-keys / no-coverage / partial；
 *         2 schema 缺失/不可解析/结构不可信（schema-invalid）/patch 不可解析。
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const HOME = homedir()
const DEFAULT_SCHEMA = join(HOME, '.dsh', 'cache', 'lean-config-schema.json')
const DEFAULT_PATCH = join(HOME, '.dsh', '.agent-presets', 'lean', 'lean.patch.yml')

const YAML_TAG = 'tag:yaml.org,2002:js'
/** 唯一认可的 schema dialect：`dsh --dump-config-schema` 产出的 2020-12 方言。 */
const DIALECT = 'https://json-schema.org/draft/2020-12/schema'
/** $ref 递归上限，防止 schema 自引用导致死循环。 */
const MAX_DEPTH = 12
/** 该 def 是 YAML !!js 表达式的惰性占位（配置值不是普通对象），检查键时忽略。 */
const LOADER_DEF = 'loaderExpression'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const refName = (ref) => (typeof ref === 'string' && ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : undefined)

/** Host version for the schema fingerprint. Env override first, then `dsh --version`. */
let cachedHostVersion
const hostVersion = () => {
  if (cachedHostVersion !== undefined) return cachedHostVersion
  const override = process.env.LEAN_CHECK_DSH_VERSION
  if (typeof override === 'string' && override.trim() !== '') {
    cachedHostVersion = override.trim()
    return cachedHostVersion
  }
  try {
    cachedHostVersion = execFileSync('dsh', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
  } catch {
    cachedHostVersion = ''
  }
  return cachedHostVersion
}

/** Source/version fingerprint of one schema cache file. */
const schemaFingerprint = (schemaPath, text) => {
  let mtimeMs = null
  try { mtimeMs = statSync(schemaPath).mtimeMs } catch {}
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
    mtime: mtimeMs === null ? null : new Date(mtimeMs).toISOString(),
    ageHours: mtimeMs === null ? null : Number(((Date.now() - mtimeMs) / 3_600_000).toFixed(1)),
  }
}

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

/** schema 来源/版本/结构校验：不可信的缓存不能作为「通过」的依据。 */
const validateSchemaSource = (schema) => {
  if (!isPlainObject(schema)) return ['schema 不是 JSON 对象']
  const problems = []
  if (schema.$schema !== DIALECT) {
    problems.push(`$schema 不是 ${DIALECT}（实际 ${typeof schema.$schema === 'string' && schema.$schema !== '' ? schema.$schema : '缺失'}）`)
  }
  const cordis = schema['x-cordis']
  if (!isPlainObject(cordis)) {
    problems.push('缺少 x-cordis 对象')
    return problems
  }
  if (!Array.isArray(cordis.entries)) problems.push('x-cordis.entries 不是数组')
  if (typeof cordis.profile !== 'string' || cordis.profile.trim() === '') problems.push('x-cordis.profile 为空')
  if (typeof cordis.complete !== 'boolean') problems.push('x-cordis.complete 不是布尔')
  if (schema.$defs !== undefined && !isPlainObject(schema.$defs)) problems.push('$defs 不是对象')
  return problems
}

/** 顺着 $ref 解析到实际节点；断链返回 ok:false。 */
const resolveNode = (node, defs) => {
  let current = node
  for (let hop = 0; hop <= 32; hop += 1) {
    if (!isPlainObject(current) || typeof current.$ref !== 'string') return { node: current, ok: true }
    const name = refName(current.$ref)
    if (name === undefined || defs[name] === undefined) return { node: null, ok: false }
    current = defs[name]
  }
  return { node: null, ok: false }
}

const declaredTypes = (node) => (Array.isArray(node.type) ? node.type : typeof node.type === 'string' ? [node.type] : [])
const isLoaderRef = (branch) => isPlainObject(branch) && refName(branch.$ref) === LOADER_DEF

/**
 * anyOf/oneOf 里哪些分支负责当前值：对象值只看 object 结构分支（properties /
 * additionalProperties / type 含 object），数组值只看 items / type array。
 * loaderExpression 这类标量占位分支直接忽略。
 */
const branchMatchesValue = (branch, value, defs) => {
  if (isLoaderRef(branch)) return false
  const { node, ok } = resolveNode(branch, defs)
  if (ok !== true || !isPlainObject(node)) return false
  // A strictly empty schema `{}` accepts ANY value. This is how the host
  // declares opaque plugin rows (preset.plugins.items: anyOf [{}, loader]);
  // it is not "unknown" like $defs.unknownConfig, which carries a $comment.
  if (Object.keys(node).length === 0) return true
  const types = declaredTypes(node)
  if (Array.isArray(value)) return types.includes('array') || node.items !== undefined
  if (types.length > 0 && !types.includes('object')) return false
  return node.properties !== undefined || node.additionalProperties !== undefined || types.includes('object')
}

const issue = (kind, path) => ({ kind, path })

/**
 * 递归校验 value 能否被 schema 解释：返回确定的问题（issues）与是否完成判定（decided）。
 * decided=false 表示这段 schema 无法判定接受哪些键（unknownConfig / 断链 / 深度超限），
 * 此时不能把该行计入 checked。
 */
const checkValue = (value, node, defs, path = '', depth = 0) => {
  const out = { issues: [], decided: true }
  // 标量没有「键」可查，键对比在这里必然完成。
  if (!isPlainObject(value) && !Array.isArray(value)) return out
  if (depth > MAX_DEPTH) return { issues: [], decided: false }
  const resolved = resolveNode(node, defs)
  if (resolved.ok !== true || !isPlainObject(resolved.node)) return { issues: [], decided: false }
  const schema = resolved.node
  if (Object.keys(schema).length === 0) return out

  // allOf：逐支检查，问题取并集；任一分支无法判定则整体未判定。
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const result = checkValue(value, branch, defs, path, depth + 1)
      out.issues.push(...result.issues)
      if (!result.decided) out.decided = false
    }
  }

  // anyOf/oneOf：只看与值结构匹配的分支，任一分支无问题即通过；否则取问题最少的分支。
  const combiner = Array.isArray(schema.anyOf) ? 'anyOf' : Array.isArray(schema.oneOf) ? 'oneOf' : null
  if (combiner !== null) {
    const candidates = schema[combiner].filter((branch) => branchMatchesValue(branch, value, defs))
    if (candidates.length === 0) return { issues: out.issues, decided: false }
    const results = candidates.map((branch) => checkValue(value, branch, defs, path, depth + 1))
    if (results.some((result) => result.issues.length === 0 && result.decided)) {
      return { issues: out.issues, decided: out.decided }
    }
    let best = results[0]
    for (const result of results) {
      if (result.issues.length < best.issues.length) best = result
    }
    return { issues: [...out.issues, ...best.issues], decided: out.decided && best.decided }
  }

  if (Array.isArray(value)) {
    if (schema.items === undefined || Array.isArray(schema.items)) return { issues: out.issues, decided: false }
    value.forEach((element, index) => {
      const result = checkValue(element, schema.items, defs, `${path}[${index}]`, depth + 1)
      out.issues.push(...result.issues)
      if (!result.decided) out.decided = false
    })
    return { issues: out.issues, decided: out.decided }
  }

  // properties 未声明且没有 additionalProperties 约束 => 该 schema 不表达键策略
  // （unknownConfig 的 $comment 就是这种：表示「未知配置」，不是「禁止字段」）。
  // 例外：本层只有 allOf 时，键策略已由各分支逐支判定，不算「无法判定」。
  const hadAllOf = Array.isArray(schema.allOf)
  const properties = isPlainObject(schema.properties) ? schema.properties : undefined
  const additional = schema.additionalProperties
  if (properties === undefined && additional === undefined && !hadAllOf) {
    return { issues: out.issues, decided: false }
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`
    if (properties !== undefined && Object.hasOwn(properties, key)) {
      const result = checkValue(child, properties[key], defs, childPath, depth + 1)
      out.issues.push(...result.issues)
      if (!result.decided) out.decided = false
      continue
    }
    if (additional === true) continue
    if (isPlainObject(additional)) {
      const result = checkValue(child, additional, defs, childPath, depth + 1)
      out.issues.push(...result.issues)
      if (!result.decided) out.decided = false
      continue
    }
    // allOf-only 节点自己没有键策略，未知键由各分支判定。
    if (hadAllOf && properties === undefined) continue
    // properties 未声明且 additionalProperties 不是 true/schema：宿主 schema 不接受该键。
    out.issues.push(issue('unknown', childPath))
  }
  for (const required of Array.isArray(schema.required) ? schema.required : []) {
    if (typeof required !== 'string') continue
    if (!Object.hasOwn(value, required)) {
      out.issues.push(issue('missing', path === '' ? required : `${path}.${required}`))
    }
  }
  return { issues: out.issues, decided: out.decided }
}

/** 这一层 schema 声明了哪些键（只用于报告「宿主接受」），无法判定时返回空数组。 */
const acceptedKeys = (node, defs) => {
  const { node: resolved, ok } = resolveNode(node, defs)
  if (ok !== true || !isPlainObject(resolved)) return []
  const combiner = Array.isArray(resolved.anyOf) ? 'anyOf' : Array.isArray(resolved.oneOf) ? 'oneOf' : null
  if (combiner !== null) {
    for (const branch of resolved[combiner]) {
      if (isLoaderRef(branch)) continue
      const { node: child } = resolveNode(branch, defs)
      if (isPlainObject(child) && isPlainObject(child.properties)) {
        if (child.additionalProperties === true) return ['*']
        return Object.keys(child.properties).sort()
      }
    }
    return []
  }
  if (isPlainObject(resolved.properties)) {
    if (resolved.additionalProperties === true) return ['*']
    return Object.keys(resolved.properties).sort()
  }
  return []
}

const buildSchemaMap = (schema) => {
  const defs = schema.$defs ?? {}
  const entries = schema['x-cordis']?.entries ?? []
  const map = new Map()
  for (const entry of entries) {
    if (entry.status !== 'schema' || typeof entry.name !== 'string') continue
    const name = refName(entry.configRef) ?? undefined
    if (name === undefined || defs[name] === undefined) continue
    if (!map.has(entry.name)) map.set(entry.name, { defName: name, node: defs[name] })
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
  const schemaText = readFileSync(schemaPath, 'utf8')
  let schema
  try {
    schema = JSON.parse(schemaText)
  } catch (error) {
    return { status: 'schema-unparsable', schemaPath, patchPath, message: String(error.message ?? error), hostVersion: hostVersion() }
  }
  const fingerprint = schemaFingerprint(schemaPath, schemaText)
  // 合法 JSON 不等于可信 schema：{} 曾经一路通过，把「零覆盖」当成「没问题」。
  const schemaProblems = validateSchemaSource(schema)
  if (schemaProblems.length > 0) {
    return {
      status: 'schema-invalid',
      schemaPath,
      patchPath,
      complete: false,
      schemaEntries: 0,
      hostVersion: hostVersion(),
      schema: { dialect: schema?.$schema ?? null, profile: schema?.['x-cordis']?.profile ?? null, complete: false, entries: 0, ...fingerprint },
      problems: schemaProblems,
      message: `schema 结构不可信：${schemaProblems.join('；')}`,
    }
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

  const defs = schema.$defs ?? {}
  const schemaMap = buildSchemaMap(schema)
  const rows = collectRows(patch, [])
  const configRows = rows.filter((row) => isPlainObject(row.config))
  const unknown = []
  const missing = []
  const unchecked = []
  const localPluginRows = []
  let checked = 0
  for (const row of configRows) {
    const entry = schemaMap.get(row.name)
    if (entry === undefined) {
      // Local preset plugins have no host Config schema by design. Name that
      // contract explicitly instead of lumping them into "no schema".
      const local = row.name.startsWith('@local/')
      if (local) localPluginRows.push(row.id)
      unchecked.push({ id: row.id, name: row.name, reason: local ? 'local plugin (no host schema)' : 'no schema' })
      continue
    }
    const { issues, decided } = checkValue(row.config, entry.node, defs)
    // allOf 多分支可能对同一路径各报一次，按路径去重。
    const unknownPaths = [...new Set(issues.filter((item) => item.kind === 'unknown').map((item) => item.path))].sort()
    const missingPaths = [...new Set(issues.filter((item) => item.kind === 'missing').map((item) => item.path))].sort()
    if (!decided) {
      unchecked.push({ id: row.id, name: row.name, reason: 'schema 无法判定接受的键' })
    } else {
      checked += 1
    }
    if (unknownPaths.length > 0) {
      unknown.push({
        id: row.id,
        name: row.name,
        keys: unknownPaths.filter((path) => !path.includes('.')),
        paths: unknownPaths,
        accepted: acceptedKeys(entry.node, defs),
      })
    }
    if (missingPaths.length > 0) {
      missing.push({ id: row.id, name: row.name, paths: missingPaths })
    }
  }
  const schemaComplete = schema['x-cordis'].complete === true
  const coverage = configRows.length === 0 ? 1 : checked / configRows.length
  let status
  if (configRows.length > 0 && checked === 0) status = 'no-coverage'
  else if (unknown.length > 0) status = 'unknown-keys'
  else if (missing.length > 0) status = 'missing-keys'
  else if (checked < configRows.length) status = 'partial'
  else status = 'ok'
  return {
    status,
    schemaPath,
    patchPath,
    // complete 只有在宿主 schema 自报完整、且本次确实完整覆盖时才成立。
    complete: schemaComplete && status === 'ok',
    schemaEntries: schemaMap.size,
    hostVersion: hostVersion(),
    schema: {
      dialect: schema.$schema,
      profile: schema['x-cordis'].profile,
      complete: schemaComplete,
      entries: schema['x-cordis'].entries.length,
      ...fingerprint,
    },
    localPlugins: { rows: localPluginRows.length, ids: localPluginRows },
    rows: rows.length,
    configRows: configRows.length,
    checked,
    coverage: Number(coverage.toFixed(4)),
    unknown,
    missing,
    uncheckedCount: unchecked.length,
    unchecked: unchecked.slice(0, 10),
    uncheckedReasons: unchecked.reduce((acc, row) => {
      acc[row.reason] = (acc[row.reason] ?? 0) + 1
      return acc
    }, {}),
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
const exitCodeOf = (status) => {
  if (status === 'ok') return 0
  if (status === 'unknown-keys' || status === 'missing-keys' || status === 'no-coverage' || status === 'partial') return 1
  return 2
}

if (argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(exitCodeOf(result.status))
}

if (result.status === 'schema-missing') {
  console.log(`lean-config-keys: 缺少 schema 缓存 ${result.schemaPath}`)
  console.log('  生成：复制 profile 到 $TMP/profiles/<name>（node_modules 用 symlink），再')
  console.log('  DSH_HOME=$TMP dsh --profile <name> --dump-config-schema > ~/.dsh/cache/lean-config-schema.json')
  process.exit(2)
}
if (result.status === 'patch-missing') {
  console.log(`lean-config-keys: 缺少 patch 文件 ${result.patchPath}`)
  process.exit(2)
}
if (result.status === 'schema-invalid') {
  console.log(`lean-config-keys: schema 缓存不可信，拒绝据此判定通过（${result.schemaPath}）`)
  for (const problem of result.problems) console.log(`  - ${problem}`)
  process.exit(2)
}
if (result.status === 'schema-unparsable' || result.status === 'patch-unparsable' || result.status === 'js-yaml-missing') {
  console.log(`lean-config-keys: 无法解析（${result.status}）${result.message ?? ''}`)
  process.exit(2)
}
console.log(`lean-config-keys: 宿主 ${result.hostVersion || '未知'}，schema 条目 ${result.schemaEntries} 个（profile ${result.schema.profile}），校验插件行 ${result.checked}/${result.configRows} 行（config 为对象）`)
console.log(`  schema 指纹 sha256:${String(result.schema.sha256 ?? '').slice(0, 12)}…，更新于 ${result.schema.mtime ?? '未知'}（${result.schema.ageHours ?? '?'} 小时前）`)
if (result.localPlugins.rows > 0) {
  console.log(`  本地插件 ${result.localPlugins.rows} 行无宿主 Config schema（按本地契约跳过：${result.localPlugins.ids.join(', ')}）`)
}
if (result.status === 'no-coverage') {
  console.log(`零覆盖：${result.configRows} 个带对象 config 的插件行一行都没校验，不能当通过`)
  for (const row of result.unchecked) console.log(`  未校验 ${row.id} (${row.name})：${row.reason}`)
  process.exit(1)
}
if (result.coverage < 1) console.log(`  部分覆盖 ${result.checked}/${result.configRows}（不是完整验收）：${result.uncheckedCount} 行无可用 schema`)
if (!result.schema.complete) {
  console.log(`  提示：schema 的 x-cordis.complete=false（部分条目 absent）${result.uncheckedCount > 0 ? '，这些行未计入 checked' : ''}`)
}
if (result.unknown.length > 0) {
  console.log(`发现 ${result.unknown.length} 行传了宿主 schema 不接受的键（schemastery 会静默丢弃）：`)
  for (const row of result.unknown) {
    console.log(`  ${row.id} (${row.name}): ${row.paths.join(', ')}`)
    console.log(`    宿主接受：${row.accepted.length > 0 ? row.accepted.join(', ') : '（未声明键）'}`)
  }
}
if (result.missing.length > 0) {
  console.log(`发现 ${result.missing.length} 行缺少 schema required 的必填键：`)
  for (const row of result.missing) console.log(`  ${row.id} (${row.name}): ${row.paths.join(', ')}`)
}
if (result.status === 'ok') {
  console.log('通过：lean.patch.yml 的配置键都在宿主 Config schema 内')
  process.exit(0)
}
process.exit(1)
}
