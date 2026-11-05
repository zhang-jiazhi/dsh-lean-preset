import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as bootstrap } from '../tool-bootstrap.mjs'
import { apply as discovery } from '../dev-tool-search.mjs'

import { runtime } from './runtime-helper.mjs'
const { Session, SESSION_FORMAT_VERSION } = await runtime('@deepseek-ai/dsh-session')
const resident = ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'ask_user_question', 'dev_tool_search', 'exit_plan_mode']
const catalog = [...resident, 'str_replace_editor', 'memory_search', 'mcp__github__get_issue', 'mcp__github__list_issues', 'unrelated_tool'].map(name => ({ name, description: name }))
let nextId = 0
const fresh = () => Session.create(`lean-regression-${++nextId}`)
const fork = parent => {
  const id = `lean-regression-${++nextId}`
  const seed = parent.snapshotEvents()
  return Session.create(id, seed, {
    version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: true,
    origin: 'subagent', parentSession: parent.id, delegationDepth: (parent.header.delegationDepth ?? 0) + 1, agentPreset: 'lean',
  }, seed.length)
}
const restore = s => Session.fromRestore(s.id, structuredClone(s.snapshotEvents()), structuredClone(s.header), s.inheritedEventCount, 'detached')
const toolCall = (s, names) => s.append('tool/call', {
  turn: 1, step: 1, callId: `call-${s.seq}`, name: names ? 'dev_tool_search' : 'bash',
  arguments: JSON.stringify(names ? { toolNames: names } : { command: 'true' }),
})
const fixture = (overrides = {}) => {
  const hooks = new Map()
  const warnings = []
  bootstrap({ on: (name, fn) => hooks.set(name, fn), logger: { warn: text => warnings.push(text) } }, {
    bootstrapTools: ['bash', 'str_replace_editor'], residentTools: resident,
    compactionTools: resident, includeSubagents: true, promoteOn: 'either',
    ...overrides,
  })
  const assembly = (session, tools = catalog) => hooks.get('system-prompt/assemble')(null, { agent: { session } }, async () => ({
    tools, sections: [{ name: 'plan:policy', text: 'active plan' }],
    contexts: [{ name: 'sandbox:policy', text: 'sandbox' }, { name: 'memory:snapshot', text: 'drop' }],
  }))
  return {
    assembly, warnings, hooks,
    names: async (session, tools) => (await assembly(session, tools)).tools.map(tool => tool.name).sort(),
    observe: (session, event) => hooks.get('session/event')(session, event),
    dispose: session => hooks.get('session/disposed')(session),
  }
}
const TEAM_EXPECTED = ['spawn_teammate', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update', 'wait_agent', 'send_message', 'list_agents', 'interrupt_agent']
const sorted = names => [...names].sort()
const unlockedParent = () => { const s = fresh(); toolCall(s, ['memory_search', 'mcp__github__*']); return s }

// Use the actual durable fork/restore boundary rather than firstLiveSeq.
test('fork starts with two tools despite parent unlocks', async () => {
  const child = fork(unlockedParent())
  assert.deepEqual(await fixture().names(child), ['bash', 'str_replace_editor'])
  assert.deepEqual(child.ownEvents().map(e => e.type), ['session/end-seed'])
})
test('parent compaction does not become child compaction', async () => {
  const parent = unlockedParent()
  parent.append('compaction/end', {})
  assert.deepEqual(await fixture().names(fork(parent)), ['bash', 'str_replace_editor'])
})
test('fork promotes using its own call without parent unlocks', async () => {
  const child = fork(unlockedParent()), f = fixture()
  await f.names(child)
  f.observe(child, toolCall(child))
  assert.deepEqual(await f.names(child), sorted(resident))
})
test('subagentResidentTools narrows the promoted child catalog', async () => {
  const hooks = new Map()
  bootstrap({ on: (name, fn) => hooks.set(name, fn), logger: { warn() {} } }, {
    bootstrapTools: ['bash', 'str_replace_editor'],
    residentTools: resident,
    subagentResidentTools: resident.filter(name => name !== 'exit_plan_mode'),
    compactionTools: resident,
    subagentCompactionTools: resident.filter(name => name !== 'exit_plan_mode'),
    includeSubagents: true,
    promoteOn: 'either',
  })
  const child = fork(unlockedParent())
  const assemble = async session => (await hooks.get('system-prompt/assemble')(
    null,
    { agent: { session } },
    async () => ({ tools: catalog, sections: [], contexts: [] }),
  )).tools.map(tool => tool.name).sort()
  // Bootstrap first, then promote on the child's own call.
  assert.deepEqual(await assemble(child), ['bash', 'str_replace_editor'])
  hooks.get('session/event')(child, toolCall(child))
  assert.deepEqual(await assemble(child), sorted(resident.filter(name => name !== 'exit_plan_mode')))
})
test('the plan:policy section does not change the promoted tool catalog', async () => {
  const f = fixture(), session = fresh()
  // Promote on the session's own durable call.
  f.observe(session, toolCall(session))
  const assemble = sections => f.hooks.get('system-prompt/assemble')(
    null,
    { agent: { session } },
    async () => ({ tools: catalog, sections, contexts: [] }),
  )
  const plain = await assemble([])
  const plan = await assemble([{ name: 'plan:policy', text: 'active plan' }])
  assert.deepEqual(plan.tools, plain.tools)
})

test('keptSections restores plugin guidance only after promotion', async () => {
  const f = fixture({ keptSections: ['tool:read'] })
  const session = fresh()
  const guidance = [{ name: 'tool:read', text: 'Use the read tool — not shell commands like cat — to inspect text files.' }]
  const assemble = async sections => (await f.hooks.get('system-prompt/assemble')(
    null,
    { agent: { session } },
    async () => ({ tools: catalog, sections, contexts: [] }),
  )).sections
  // Bootstrap request stays byte-identical to the Minimal anchor.
  assert.deepEqual((await assemble([...guidance, { name: 'tool:bash', text: 'shell guidance' }])).map(s => s.name), ['deployment:persona-prefix'])
  f.observe(session, toolCall(session))
  // Promoted requests carry the allowlisted section and nothing else.
  const promoted = await assemble([...guidance, { name: 'tool:bash', text: 'shell guidance' }])
  assert.deepEqual(promoted.map(s => s.name), ['deployment:persona-prefix', 'tool:read'])
  assert.match(promoted[1].text, /Use the read tool/)
  // An empty allowlist (the default) keeps the pre-existing Minimal prompt.
  const gated = fixture()
  const plain = await gated.hooks.get('system-prompt/assemble')(null, { agent: { session } }, async () => ({ tools: catalog, sections: guidance, contexts: [] }))
  assert.deepEqual(plain.sections.map(s => s.name), ['deployment:persona-prefix'])
})

test('own unlock survives restore and cache disposal', async () => {
  const child = fork(unlockedParent()), f = fixture()
  toolCall(child)
  await f.names(child)
  f.observe(child, toolCall(child, ['memory_search']))
  assert.deepEqual(await f.names(child), sorted([...resident, 'memory_search']))
  const resumed = restore(child)
  assert.ok(resumed.firstLiveSeq > resumed.inheritedEventCount)
  assert.deepEqual(await fixture().names(resumed), sorted([...resident, 'memory_search']))
  f.dispose(child)
  assert.deepEqual(await f.names(resumed), sorted([...resident, 'memory_search']))
})
test('nested fork resets parent and grandparent state', async () => {
  const child = fork(unlockedParent())
  toolCall(child, ['unrelated_tool'])
  assert.deepEqual(await fixture().names(fork(child)), ['bash', 'str_replace_editor'])
})
test('unseeded sessions retain independent promotion', async () => {
  const s = fresh(), f = fixture()
  assert.deepEqual(await f.names(s), ['bash', 'str_replace_editor'])
  f.observe(s, toolCall(s))
  assert.deepEqual(await f.names(s), sorted(resident))
})
test('own compaction resets phase but preserves own unlock', async () => {
  const child = fork(unlockedParent()), f = fixture()
  toolCall(child, ['unrelated_tool'])
  await f.names(child)
  f.observe(child, child.append('compaction/end', {}))
  // Same catalog before and after compaction and after re-promotion: the
  // provider prefix cache survives and nothing has to be unlocked again.
  assert.deepEqual(await f.names(child), sorted([...resident, 'unrelated_tool']))
  f.observe(child, toolCall(child))
  assert.deepEqual(await f.names(child), sorted([...resident, 'unrelated_tool']))
})
test('missing bootstrap member warns and keeps the narrowed catalog', async () => {
  const f = fixture()
  assert.deepEqual(await f.names(fresh(), catalog.filter(t => t.name !== 'str_replace_editor')), ['bash'])
  assert.ok(f.warnings.some(message => /required phase tools missing/.test(message)))
})
test('missing optional compaction tool keeps restricted catalog', async () => {
  const s = fresh(), f = fixture()
  s.append('compaction/end', {})
  assert.deepEqual(await f.names(s, catalog.filter(t => t.name !== 'read')), sorted(resident.filter(n => n !== 'read')))
})
test('unexpected filter error propagates instead of returning catalog', async () => {
  await assert.rejects(fixture().names({ get id() { throw new Error('broken session') } }), /filter|broken session/)
})
test('downstream assembly failure propagates unchanged', async () => {
  const error = new Error('downstream failure')
  await assert.rejects(fixture().hooks.get('system-prompt/assemble')(null, { agent: { session: fresh() } }, async () => { throw error }), e => e === error)
})
test('plan and policy contexts survive restricted assembly', async () => {
  const a = await fixture().assembly(fresh())
  assert.deepEqual(a.sections.map(i => i.name), ['deployment:persona-prefix', 'plan:policy'])
  assert.deepEqual(a.contexts.map(i => i.name), ['sandbox:policy'])
})
const searchTool = (schemas = () => catalog) => {
  let tool
  discovery({ tools: { register: value => { tool = value }, schemas } })
  return tool
}
test('toolNames schema preserves item type', () => {
  assert.deepEqual(searchTool().parameters.properties.toolNames.items, { type: 'string' })
})
test('unknown names and unmatched patterns do not report success', async () => {
  const { text } = await searchTool().execute({ toolNames: ['nonexistent', 'missing_*'] }, {})
  assert.doesNotMatch(text, /Unlocked for the next request/)
  assert.match(text, /No tools.*match/i)
  assert.match(text, /nonexistent/)
  assert.match(text, /missing_\*/)
})
test('exact, prefix and bare MCP unlocks report resolved tools', async () => {
  for (const pattern of ['mcp__github__*', 'mcp__github']) {
    const { text } = await searchTool().execute({ toolNames: ['memory_search', pattern, 'nonexistent'] }, {})
    assert.match(text, /Unlocked for the next request.*memory_search/)
    assert.match(text, /mcp__github__get_issue/)
    assert.match(text, /mcp__github__list_issues/)
    assert.match(text, /No tools.*match.*nonexistent/i)
  }
})
test('catalog failure never claims success', async () => {
  const { text } = await searchTool(() => { throw new Error('catalog offline') }).execute({ toolNames: ['memory_search'] }, {})
  assert.doesNotMatch(text, /Unlocked for the next request/)
  assert.match(text, /catalog offline/)
})
test('Chinese joined search remains AND matched', async () => {
  const schemas = [{ name: 'browser_screenshot', description: 'browser screenshot' }, { name: 'browser_navigate', description: 'browser navigation' }]
  const { text } = await searchTool(() => schemas).execute({ query: '\u6d4f\u89c8\u5668\u622a\u56fe' }, {})
  assert.match(text, /browser_screenshot/)
  assert.doesNotMatch(text, /browser_navigate/)
})

// --- Agent Team explicit-request routing (2026-09-13) -------------------------
// Regression: a prompt that explicitly names the Agent Team subagent must expose
// the team tools on the turn's FIRST request. Before the fix they were reachable
// only through dev_tool_search, so the first call was inevitably the resident
// `subagent` and the model obeyed only after the user repeated the instruction.
const teamCatalog = [...catalog, ...TEAM_EXPECTED.map(name => ({ name, description: name }))]
const userPrompt = (s, text) => s.append('user/message', {
  content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: `msg-${s.seq}`,
}, { surfaceOp: 'append' })
const pluginReminder = (s, text) => s.append('user/message', {
  content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'instruction-hint' }, role: 'user', id: `plugin-${s.seq}`,
}, { surfaceOp: 'append' })

test('explicit Agent Team prompt exposes team tools on the first request', async () => {
  const s = fresh()
  userPrompt(s, '\u7528 AGENT TEAM \u5b50\u4ee3\u7406\u5b8c\u6210\u8fd9\u4e2a\u4efb\u52a1')
  const names = await fixture().names(s, teamCatalog)
  assert.ok(names.includes('spawn_teammate'), 'spawn_teammate must be in the first request catalog')
  assert.ok(names.includes('wait_agent'))
  assert.ok(names.includes('send_message'))
})

test('an ordinary prompt keeps the lean bootstrap catalog', async () => {
  const s = fresh()
  userPrompt(s, '\u628a README \u91cd\u5199\u4e00\u4e0b')
  assert.deepEqual(await fixture().names(s, teamCatalog), ['bash', 'str_replace_editor'])
})

test('a plugin-injected reminder never arms Team routing', async () => {
  const s = fresh()
  userPrompt(s, '\u628a README \u91cd\u5199\u4e00\u4e0b')
  pluginReminder(s, 'Agent Team tools exist; use them when asked')
  assert.deepEqual(await fixture().names(s, teamCatalog), ['bash', 'str_replace_editor'])
})

test('Team routing survives promotion and is incremental', async () => {
  const s = fresh()
  userPrompt(s, 'use the agent team')
  const f = fixture()
  await f.names(s, teamCatalog)
  f.observe(s, toolCall(s))
  const names = await f.names(s, teamCatalog)
  assert.ok(names.includes('spawn_teammate'), 'team tools must survive promotion')
  assert.deepEqual(names, sorted([...resident, ...TEAM_EXPECTED]))
})

test('a catalog without the Agent Team plugin stays silent', async () => {
  const s = fresh()
  userPrompt(s, 'use the AGENT TEAM subagent')
  const f = fixture()
  assert.deepEqual(await f.names(s, catalog), ['bash', 'str_replace_editor'])
  assert.deepEqual(f.warnings, [], 'absent team tools must not warn')
})

test('Team mode stays armed across follow-up turns that never repeat the phrase', async () => {
  const s = fresh()
  userPrompt(s, '\u7528 AGENT TEAM \u5b50\u4ee3\u7406\u505a\u8fd9\u4ef6\u4e8b')
  const f = fixture()
  assert.ok((await f.names(s, teamCatalog)).includes('spawn_teammate'))
  // A team task is multi-turn: the next instruction is typically just "继续".
  userPrompt(s, '\u7ee7\u7eed')
  assert.ok((await f.names(s, teamCatalog)).includes('spawn_teammate'),
    'a follow-up turn must not drop the team tools')
  assert.ok((await f.names(s, teamCatalog)).includes('wait_agent'))
})

test('Team mode survives restore from the durable log', async () => {
  const s = fresh()
  userPrompt(s, 'use the agent team')
  const restored = restore(s)
  assert.ok((await fixture().names(restored, teamCatalog)).includes('spawn_teammate'),
    'a cold re-scan must re-derive Team mode from the durable user message')
})

test('a forked child does not inherit the parent Team arming', async () => {
  const parent = fresh()
  userPrompt(parent, 'use the agent team')
  assert.deepEqual(await fixture().names(fork(parent), teamCatalog), ['bash', 'str_replace_editor'])
})

// The REAL first-turn ordering (measured on a live session): dsh-agent-loop runs
// inbox.claim() -> systemPrompt.assemble() -> session.append('user/message'). So
// at assembly time the instruction is in NEITHER the inbox NOR the log; only the
// earlier `agent/inbox/spliced` event carries it. A fixture that appends
// user/message first cannot catch an assembly-time regression.
const inboxSplice = (s, text) => s.append('agent/inbox/spliced', {
  target: 'next-turn', start: 0,
  inserted: [{ role: 'user', id: `m-${s.seq}`, source: { kind: 'user' }, content: [{ type: 'text', text }] }],
})
const pluginSplice = (s, text) => s.append('agent/inbox/spliced', {
  target: 'next-turn', start: 0,
  inserted: [{ role: 'user', id: `p-${s.seq}`, source: { kind: 'plugin', plugin: 'instruction-hint' }, content: [{ type: 'text', text }] }],
})

test('Team tools appear on the FIRST request with the real claim-before-log ordering', async () => {
  const s = fresh()
  // No user/message exists yet — exactly the state the assembly hook runs in.
  inboxSplice(s, '\u7528 AGENT TEAM \u5b50\u4ee3\u7406\u5e76\u884c\u5ba1\u67e5')
  assert.deepEqual(s.ownEvents().map(e => e.type), ['agent/inbox/spliced'])
  const names = await fixture().names(s, teamCatalog)
  assert.ok(names.includes('spawn_teammate'),
    'the first request must already expose spawn_teammate (assembly runs before user/message is logged)')
  assert.equal(names.filter(n => TEAM_EXPECTED.includes(n)).length, TEAM_EXPECTED.length)
})

test('an ordinary first-turn instruction keeps the bootstrap pair', async () => {
  const s = fresh()
  inboxSplice(s, '\u628a README \u91cd\u5199\u4e00\u4e0b')
  assert.deepEqual(await fixture().names(s, teamCatalog), ['bash', 'str_replace_editor'])
})

test('a plugin-injected splice never arms Team routing', async () => {
  const s = fresh()
  pluginSplice(s, 'Agent Team tools exist; use them when asked')
  assert.deepEqual(await fixture().names(s, teamCatalog), ['bash', 'str_replace_editor'])
})

test('Team arming from a splice survives restore', async () => {
  const s = fresh()
  inboxSplice(s, 'use the agent team')
  assert.deepEqual(s.ownEvents().map(e => e.type), ['agent/inbox/spliced'])
  const restored = restore(s)
  assert.ok((await fixture().names(restored, teamCatalog)).includes('spawn_teammate'))
})

test('a fork must not inherit Team arming from a parent splice', async () => {
  const parent = fresh()
  inboxSplice(parent, 'use the agent team')
  assert.deepEqual(await fixture().names(fork(parent), teamCatalog), ['bash', 'str_replace_editor'])
})

// `bootstrapTools` used to be the only list key with no fallback: omitting it
// threw and the whole row failed to mount, while DEFAULT_BOOTSTRAP_TOOLS sat
// unused right above it. The fallback now matches every sibling key.
test('omitting bootstrapTools falls back to the Minimal pair', async () => {
  const hooks = new Map()
  bootstrap({ on: (name, fn) => hooks.set(name, fn), logger: { warn() {} } }, { residentTools: resident })
  const session = fresh()
  const assembled = await hooks.get('system-prompt/assemble')(null, { agent: { session } }, async () => ({
    tools: catalog, sections: [], contexts: [],
  }))
  assert.deepEqual(assembled.tools.map(tool => tool.name).sort(), ['bash', 'str_replace_editor'])
})

test('an empty config mounts on the default bootstrap pair', async () => {
  const hooks = new Map()
  bootstrap({ on: (name, fn) => hooks.set(name, fn), logger: { warn() {} } }, {})
  const session = fresh()
  const assembled = await hooks.get('system-prompt/assemble')(null, { agent: { session } }, async () => ({
    tools: catalog, sections: [], contexts: [],
  }))
  assert.deepEqual(assembled.tools.map(tool => tool.name).sort(), ['bash', 'str_replace_editor'])
})

// The fallback must not swallow a present-but-invalid value: an explicitly
// empty or malformed list is a config error, not a request for the default.
test('a present-but-invalid bootstrapTools still rejects the mount', () => {
  const ctx = () => ({ on() {}, logger: { warn() {} } })
  for (const value of [[], 'bash', ['bash', ''], [''], [1]]) {
    assert.throws(() => bootstrap(ctx(), { bootstrapTools: value }),
      /bootstrapTools must be a non-empty array of non-empty strings/,
      `expected ${JSON.stringify(value)} to be rejected`)
  }
})
