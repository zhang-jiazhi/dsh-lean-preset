// Index↔composition consistency guard (2026-09-22).
//
// The dead-entry incident this guards against: UNLOCKABLE_INDEX promised tools
// that the mounted composition did not provide (mcp servers disabled in
// lean.patch.yml, names never registered by any plugin). A model that reads a
// promise and unlocks it burns one round on a guaranteed "No tools match".
//
// Static by design: the composition lives in standing mount, unavailable to a
// unit test. 20261017-audit-p0: keep this list in sync with the 0.2.1 live
// catalog; the previous 0.1.7 assumptions missed browser_/session_/terminal_. What IS checkable here is the source of both promises:
//   - every mcp__<server>__* promise maps to an ENABLED mcp-client row
//     (lean.patch.yml) — a disabled row must never be promised;
//   - truly dead/renamed names (dev_config_effective, sidebar_*, cordis_define…)
//     never appear in the index; live 0.2.1 families are allowed;
//   - host-layer whitelist stays explicit: anything the index promises that is
//     NOT declared in lean.patch.yml must be listed in HOST_LAYER_TOOLS with a
//     comment of who registers it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, readFile } from 'node:fs/promises'
import { runtimeRequire } from './runtime-helper.mjs'
import { UNLOCKABLE_INDEX } from '../dev-tool-search.mjs'

const { entryListSchema } = runtimeRequire('@deepseek-ai/cordis-plugin-include')
const allRows = (rows) => rows.flatMap(row => (row.config && Array.isArray(row.config) ? allRows(row.config) : [row]))
const indexText = UNLOCKABLE_INDEX.join('\n')

// MCP servers lean.patch.yml can expose, with their ENABLED state as mounted.
const patch = runtimeRequire('js-yaml').load(await readFile(new URL('../lean.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema })
const plugins = allRows(patch.flatMap(row => row.insert ?? [])).filter(row => row.id !== undefined)
const presetRows = allRows(patch.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-lean').config.plugins)
const mcpServers = new Map()
for (const row of presetRows) {
  if (row.name !== '@deepseek-ai/dsh-mcp-client') continue
  mcpServers.set(row.config.serverName, row.disabled !== true)
}

// Names published by host-layer bundles (not declared in lean.patch.yml), each
// verified against its registration point at 2026-09-22. `prefix` covers a
// whole family (memory_*, dev_*, mcp-playwright provider); `tools` lists names
// one by one.
const HOST_LAYER_TOOLS = [
  { tools: ['tavily_search', 'anysearch_search', 'exa_search', 'deepseek_search', 'deepseek_fetch'], registrar: '@local/example-search-aggregator (profiles/desktop bundle)' },
  { prefix: 'memory_', registrar: '@modusensus/dsh-mneme (desktop profile; memory_save/search/list/update/delete/forget/archive/get/runtime)' },
  { tools: ['spawn_teammate', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update', 'wait_agent', 'send_message', 'list_agents', 'interrupt_agent'], registrar: '@deepseek-ai/dsh-experimental-tool-agent-team' },
  { tools: ['batch'], registrar: '@local/dsh-lean-batch (local-plugins, runtime-injected)' },
  { prefix: 'dev_', registrar: 'dsh-super-injector (host bundle; dev_scaffold_plugin, dev_stage_*, …)' },
  // 20261017-audit-p0: 0.2.1 live families that were missing from the old index.
  { prefix: 'browser_', registrar: 'profiles/desktop @deepseek-ai/dsh-browser-use (sidebar browser provider)' },
  { prefix: 'session_', registrar: 'dsh-base session-query-sqlite (session_search / session_event_* / session_trace)' },
  { prefix: 'terminal_', registrar: 'dsh-base terminal-bash (terminal_open/send/read/signal/close/list)' },
  { prefix: 'translate_', registrar: '@dsh-external/dsh-immersive-translate (translate_text / translate_page)' },
  { prefix: 'job_', registrar: 'dsh-base tool-jobs (job_list / job_output / job_kill)' },
  { tools: ['create_worktree', 'working_directory', 'load_workspace_dependencies'], registrar: 'dsh-base working-directory / experimental-tool-worktree' },
  { tools: ['search_history', 'history_context', 'search_provider_status'], registrar: '@local/example-search-history + @local/example-search-aggregator' },
  { tools: ['list_subagent_models'], registrar: '@deepseek-ai/dsh-tool-subagent (model selection)' },
]

// Never-registered / renamed names. Their presence in the index is the bug.
// 20261017-audit-p0: terminal_open/send/read/signal/close/list are real in
// 0.2.1 and are now indexed; only the names that still do not exist stay here.
const DEAD_NAMES = [
  'sidebar_open', 'terminal_create', 'terminal_resize', 'terminal_wait_for',
  'dev_config_effective', 'cordis_define', 'cordis_run', 'cordis_stop',
]

test('every promised mcp server is exposed by an enabled row or a host provider', () => {
  // 20261017-audit-p0: the index now has only a generic `mcp__*` line; it does
  // not name a server, so this loop is intentionally empty until a concrete
  // server line comes back. The old whitelist of 'playwright-mcp' was wrong:
  // 0.2.1 exposes sidebar browser tools as `browser_*`, not that namespace.
  const promised = new Set([...indexText.matchAll(/mcp__([A-Za-z0-9_-]+)__\*/g)].map(m => m[1]))
  for (const server of promised) {
    assert.equal(mcpServers.get(server), true, `index promises mcp__${server}__* but its lean.patch.yml row is disabled or absent`)
  }
})

test('no dead or renamed name survives in the index', () => {
  for (const name of DEAD_NAMES) {
    assert.ok(!indexText.includes(name), `stale index entry still promises "${name}"`)
  }
})

test('cordis entry names match the 0.2.1 registrations', () => {
  assert.match(indexText, /cordis_inspect_list/)
  assert.match(indexText, /cordis_inspect_query/)
  assert.ok(!/cordis_inspect_\*/.test(indexText), 'wildcard hides the real names; name them explicitly')
})

test('promised non-mcp names are declared in lean.patch.yml or covered by a verified registrar', () => {
  // Only the name side of each index line ("names — description"): prose after
  // the em dash is not a promise, so it never enters the candidate set. MCP
  // tokens are removed whole — their splitting debris (persist__, …) is not a
  // name; the server-level check lives in its own test above.
  const nameSide = UNLOCKABLE_INDEX.map(line => line.split('—')[0]).join('\n').replace(/mcp__\S*/g, ' ')
  const promised = new Set([...nameSide.matchAll(/\b([a-z_][a-z0-9_]{3,})\b/g)].map(m => m[1]))
  const declared = new Set()
  for (const row of presetRows) {
    for (const value of Object.values(row.config ?? {})) {
      if (Array.isArray(value)) for (const name of value) if (typeof name === 'string') declared.add(name)
    }
  }
  // lean.patch.yml tool rows whose package registers the promised names; the
  // row must exist and be enabled (checked here), the names it covers are not
  // spelled in the row's config, so they join the covered set below.
  const rowNames = {
    'ralph': 'tool-ralph',
    'web_search': 'tool-web',
    'web_fetch': 'tool-web',
    'create_goal': 'tool-goal',
    'get_goal': 'tool-goal',
    'update_goal': 'tool-goal',
    'skill_search': 'skill-search',
    'skill_load': 'skill-search',
    'rule_search': 'rule-search',
    // 2026-10-30: str_replace_editor left bootstrapTools, so it is no longer a
    // declared list member; it stays mounted by the bootstrap-filesystem group
    // and is now gateway-eligible (reachable on demand). The index line still
    // promises it, so the row must exist and stay enabled.
    'str_replace_editor': 'str-replace-editor',
    'subagent_fork': 'tool-subagent-fork',
    'cordis_inspect_list': 'tool-cordis',
    'cordis_inspect_query': 'tool-cordis',
    'workflow': 'tool-workflow',
    'present': 'present',
  }
  for (const [tool, rowId] of Object.entries(rowNames)) {
    const row = presetRows.find(candidate => candidate.id === rowId)
    assert.ok(row, `row ${rowId} missing from lean.patch.yml`)
    assert.notEqual(row.disabled, true, `${tool} promised by the index but ${rowId} is disabled`)
  }
  const covered = new Set([...Object.keys(rowNames), ...HOST_LAYER_TOOLS.flatMap(entry => entry.tools ?? [])])
  const coveredByPrefix = HOST_LAYER_TOOLS.filter(entry => entry.prefix !== undefined).map(entry => entry.prefix)
  for (const candidate of promised) {
    if (declared.has(candidate) || covered.has(candidate)) continue
    if (coveredByPrefix.some(prefix => candidate.startsWith(prefix))) continue
    if (candidate.startsWith('mcp__')) continue // server assertions live in their own test
    // A DSH tool name either carries an underscore family prefix or is one of
    // the known bare names; anything else on the name side is prose.
    const isToolShaped = candidate.includes('_') || ['ralph', 'present', 'workflow', 'batch'].includes(candidate)
    if (!isToolShaped) continue
    assert.fail(`index promises unknown tool "${candidate}": register it, declare it in lean.patch.yml, or add it to HOST_LAYER_TOOLS with its registrar`)
  }
})

test('host whitelist entries name their registrar', () => {
  for (const entry of HOST_LAYER_TOOLS) {
    assert.ok(entry.registrar.includes('/') || entry.registrar.includes('('), `whitelist entry ${entry.tools?.[0] ?? entry.prefix} lacks a concrete registrar`)
  }
})

test('tool_gateway names itself and the resident/subagent sets stay aligned', async () => {
  const { apply } = await import('../tool-gateway.mjs')
  let tool
  apply({ tools: { register: value => { tool = value } } })
  assert.equal(tool.name, 'tool_gateway')
  assert.match(tool.description, /tool_gateway/)
  const bootstrap = presetRows.find(row => row.id === 'tool-bootstrap')
  assert.ok(bootstrap.config.bootstrapTools.includes('tool_gateway'))
  // First-request read keeps file inspection off the bash/str_replace_editor path.
  assert.ok(bootstrap.config.bootstrapTools.includes('read'))
  assert.ok(bootstrap.config.residentTools.includes('tool_gateway'))
  assert.ok(bootstrap.config.compactionTools.includes('tool_gateway'))
  const child = bootstrap.config.subagentResidentTools
  assert.deepEqual(
    [...child].sort(),
    bootstrap.config.residentTools.filter(name => name !== 'subagent' && name !== 'exit_plan_mode').sort(),
    'subagentResidentTools must be residentTools minus subagent/exit_plan_mode',
  )
  assert.deepEqual([...bootstrap.config.subagentCompactionTools].sort(), [...child].sort())
})

test('every local preset entry referenced by lean.patch.yml exists', async () => {
  for (const row of presetRows) {
    if (typeof row.name !== 'string') continue
    const local = /^@local\/dsh-agent-preset-lean\/(.+\.mjs)$/.exec(row.name)
    if (!local) continue
    await assert.doesNotReject(
      access(new URL(`../${local[1]}`, import.meta.url)),
      `entry ${row.name} is referenced but missing on disk`,
    )
  }
})
