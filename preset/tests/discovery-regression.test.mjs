import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as discovery, RELAXED_MATCH_LIMIT } from '../dev-tool-search.mjs'
import { apply as bootstrap } from '../tool-bootstrap.mjs'
import { resolveToolNames } from '../tool-name-resolver.mjs'

// Use the active runtime's Session directly; no cross-version testkit fallback.
import { runtime } from './runtime-helper.mjs'
const { Session, SESSION_FORMAT_VERSION } = await runtime('@deepseek-ai/dsh-session')
const resident = ['bash', 'dev_tool_search']
const initial = ['bash', 'str_replace_editor', 'dev_tool_search']
const github = [
  'mcp__github__get_issue',
  'mcp__github__list_issues',
  'mcp__github__get_issue__trace',
  'mcp__github__missing__trace',
]
const schemas = names => names.map(name => ({ name, description: name }))
const catalog = schemas([...resident, 'str_replace_editor', 'read', ...github, 'mcp__repo_tools__read', 'memory_search', 'dev_fixture', 'unrelated_tool'])
const sorted = names => [...new Set(names)].sort()
let nextId = 0
const fresh = () => Session.create(`lean-discovery-${++nextId}`)
const fork = parent => {
  const id = `lean-discovery-${++nextId}`
  const seed = parent.snapshotEvents()
  return Session.create(id, seed, {
    version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: true,
    origin: 'subagent', parentSession: parent.id,
    delegationDepth: (parent.header.delegationDepth ?? 0) + 1, agentPreset: 'lean',
  }, seed.length)
}
const restore = session => Session.fromRestore(
  session.id, structuredClone(session.snapshotEvents()), structuredClone(session.header),
  session.inheritedEventCount, 'detached',
)
const searchTool = (getSchemas = () => catalog) => {
  let tool
  discovery({ tools: { register: value => { tool = value }, schemas: getSchemas } })
  return tool
}
const fixture = () => {
  const hooks = new Map()
  bootstrap({ on: (name, fn) => hooks.set(name, fn), logger: { warn() {} } }, {
    bootstrapTools: initial, residentTools: resident,
    compactionTools: ['read'], includeSubagents: true, promoteOn: 'either',
  })
  const append = (session, type, data) => {
    const event = session.append(type, data)
    hooks.get('session/event')(session, event)
    return event
  }
  return {
    append,
    call: (session, args) => append(session, 'tool/call', {
      turn: 1, step: 1, callId: `call-${session.seq}`,
      name: args === undefined ? 'bash' : 'dev_tool_search',
      arguments: JSON.stringify(args ?? { command: 'true' }),
    }),
    dispose: session => hooks.get('session/disposed')(session),
    names: async (session, tools = catalog) => {
      const assembled = await hooks.get('system-prompt/assemble')(null, { agent: { session } }, async () => ({
        tools, sections: [], contexts: [], variables: {},
      }))
      return assembled.tools.map(tool => tool.name).sort()
    },
  }
}
const reported = text => text.match(/^Unlocked for the next request: (.+)$/m)?.[1].split(', ') ?? []
const rows = text => [...text.matchAll(/^- ([^:]+):/gm)].map(match => match[1])
const nextPage = text => {
  const match = text.match(/^Next page: dev_tool_search\((.+)\)\.$/m)
  return match ? JSON.parse(match[1]) : undefined
}

const unlockCases = [
  ['exact MCP name wins over a longer prefixed name', ['mcp__github__get_issue'], [github[0]]],
  ['MCP trailing wildcard expands the group', ['mcp__github__*'], github],
  ['bare MCP server expands the group', ['mcp__github'], github],
  ['bare MCP server permits a single underscore', ['mcp__repo_tools'], ['mcp__repo_tools__read']],
  ['non-MCP exact name remains supported', ['memory_search'], ['memory_search']],
  ['non-MCP trailing wildcard remains supported', ['dev_*'], ['dev_tool_search', 'dev_fixture']],
  ['unknown complete MCP name never widens to a prefix group', ['mcp__github__missing'], []],
  ['unknown names and unmatched patterns stay missing', ['unknown', 'mcp__absent', 'missing_*'], []],
  ['exact names, groups and wildcards are case-sensitive', ['mcp__GitHub__get_issue', 'mcp__GitHub', 'mcp__GitHub__*'], []],
  ['internal wildcards are not inferred', ['mcp__*__get_issue'], []],
  ['overlapping unlocks are deduplicated', ['memory_search', 'mcp__github__get_issue', 'memory_search', 'mcp__github__*'], ['memory_search', ...github]],
]

for (const [label, toolNames, expected] of unlockCases) {
  test(`discovery and next assembly agree: ${label}`, async () => {
    const session = fresh()
    const f = fixture()
    assert.deepEqual(await f.names(session), sorted(initial))
    f.call(session, { toolNames })
    const { text } = await searchTool().execute({ toolNames }, { agent: { session } })
    assert.deepEqual(reported(text), expected)
    assert.deepEqual(await f.names(session), sorted([...resident, ...expected]))
    const resolution = resolveToolNames(toolNames, catalog.map(tool => tool.name))
    assert.deepEqual(resolution.resolved, expected)
    if (expected.length === 0) assert.deepEqual(resolution.missing, toolNames)
  })
}

test('a FAILED compaction keeps the promoted catalog and the unlocks', async () => {
  const session = fresh()
  const f = fixture() // compactionTools is ['read'] here, deliberately != resident
  assert.deepEqual(await f.names(session), sorted(initial))
  f.call(session) // promote
  f.call(session, { toolNames: ['memory_search'] })
  const promoted = await f.names(session)
  assert.deepEqual(promoted, sorted([...resident, 'memory_search']))
  // `compaction/end` fires for a retry too, and a retry does not replace the
  // conversation. The catalog must not move: it sits at the head of every
  // request, so a spurious re-narrowing rewrites the provider prefix cache.
  f.append(session, 'compaction/end', { error: 'isContextWindowExceededError is not defined' })
  assert.deepEqual(await f.names(session), promoted)
  // A real checkpoint may narrow to the compaction work set plus own unlocks.
  f.append(session, 'compaction/end', {})
  assert.deepEqual(await f.names(session), sorted(['read', 'memory_search']))
})

test('a cold-resumed session does not treat a failed compaction as a boundary', async () => {
  const session = fresh()
  const f = fixture()
  f.call(session) // promote
  f.append(session, 'compaction/end', { error: 'boom' })
  // The incremental path and the cold scan must agree on this log.
  const resumed = restore(session)
  assert.deepEqual(await f.names(resumed), sorted(resident))
})

test('an exact catalog member resembling a bare MCP group still wins', async () => {
  const tools = [...catalog, ...schemas(['mcp__github'])]
  const toolNames = ['mcp__github']
  const session = fresh()
  const f = fixture()
  f.call(session, { toolNames })
  const { text } = await searchTool(() => tools).execute({ toolNames }, { agent: { session } })
  assert.deepEqual(reported(text), toolNames)
  assert.deepEqual(await f.names(session, tools), sorted([...resident, ...toolNames]))
})

test('mixed valid, missing and malformed unlocks have one deterministic result', async () => {
  const toolNames = ['', null, 42, 'mcp__github__get_issue', 'mcp__github__missing', 'mcp__github__missing']
  // 20260930-recall: resolveToolNames also reports which names it auto-resolved
  // (shared with tool-bootstrap so discovery and assembly cannot diverge).
  // 20261024-unlockbudget: the shared resolver also reports the per-call unlock
  // budget and which group expansions it deferred, so discovery can state the
  // real cost instead of silently unlocking 200+ schemas.
  const expected = {
    resolved: [github[0]], missing: ['mcp__github__missing'], autoResolved: [],
    deferred: [], budget: { maxTools: 64, maxChars: 60000 },
  }
  assert.deepEqual(resolveToolNames(toolNames, catalog.map(tool => tool.name)), expected)
  const session = fresh()
  const f = fixture()
  f.call(session, { toolNames })
  const { text } = await searchTool().execute({ toolNames }, { agent: { session } })
  assert.deepEqual(reported(text), expected.resolved)
  assert.match(text, /No tools match: mcp__github__missing$/m)
  assert.deepEqual(await f.names(session), sorted([...resident, github[0]]))
})

test('missing unlock names get same-call closest suggestions instead of a blind retry', async () => {
  const session = fresh()
  const f = fixture()
  f.call(session, { toolNames: ['mcp__github__get_issue_trace', 'mcp__absent__browse'] })
  const { text } = await searchTool().execute(
    { toolNames: ['mcp__github__get_issue_trace', 'mcp__absent__browse'] },
    { agent: { session } },
  )
  // 20260930-recall 改契：只差一个下划线的近失名（get_issue_trace vs
  // get_issue__trace，族内共享 3 个区分词）当轮就定下来，不再白付一轮。
  assert.match(text, /Unlocked for the next request: mcp__github__get_issue__trace/)
  assert.match(text, /Auto-resolved mcp__github__get_issue_trace → mcp__github__get_issue__trace/)
  // 真正定不下来的仍然只给建议、并说明原因。
  assert.match(text, /No tools match: mcp__absent__browse$/m)
  // An absent SERVER is a different failure: say so instead of pretending a typo.
  assert.match(text, /mcp__absent__browse: no absent tools are in the catalog/m)
  assert.match(text, /still be connecting or be disabled/)
})

test('an existing MCP family gives a catalog hint without suggesting namespace-only matches', async () => {
  for (const name of ['mcp__github__foobar', 'mcp__github__github']) {
    const { text } = await searchTool().execute({ toolNames: [name] }, {})
    assert.match(text, /the github family exists but no member shares those words/)
    assert.match(text, /query "github"/)
    assert.doesNotMatch(text, /closest to/)
  }
})

test('discovery instructions stay compact without losing unlock semantics', () => {
  const { description } = searchTool()
  assert.ok(description.length < 3000, `description has ${description.length} characters`)
  assert.match(description, /toolNames.*alone/)
  assert.match(description, /SAME call/)
  assert.match(description, /Prefer exact names/)
  assert.match(description, /next request/)
})

test('a one-letter query is rejected instead of returning the catalog', async () => {
  const { text } = await searchTool().execute({ query: 'e' }, {})
  assert.match(text, /Invalid query/)
  assert.equal(rows(text).length, 0)
})

test('long description tails do not create search matches', async () => {
  const tool = searchTool(() => [
    { name: 'batch', description: `程序化批量编排。${'填充'.repeat(300)} browser automation` },
    { name: 'browser_eval', description: 'Run JavaScript in the sidebar browser page.' },
  ])
  const browser = await tool.execute({ query: 'browser' }, {})
  assert.match(browser.text, /browser_eval/)
  assert.doesNotMatch(browser.text, /^- batch:/m)
  const batch = await tool.execute({ query: '编排' }, {})
  assert.match(batch.text, /^- batch:/m)
})

test('relaxed keyword matches are capped and ask for a narrower query', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `alpha_tool_${i}`, description: `alpha only ${i}` }))
  const tool = searchTool(() => many)
  const { text } = await tool.execute({ query: 'alpha beta' }, {})
  assert.equal(rows(text).length, RELAXED_MATCH_LIMIT)
  assert.match(text, /共 30 个命中/)
  assert.match(text, /补关键词/)
  assert.equal(nextPage(text), undefined)
})

test('named bundles unlock their family without exact tool names', async () => {
  const tool = searchTool(() => schemas([
    'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
    'browser_navigate', 'browser_snapshot', 'browser_act', 'browser_eval', 'browser_screenshot',
    'session_search', 'search_history', 'history_context', 'memory_search', 'unrelated_tool',
    'mcp__rea__binary_session', 'mcp__rea__open_binary', 'mcp__rea__search_procedures',
    'mcp__rea__binary_overview', 'mcp__rea__analyze_function', 'mcp__rea__close_binary',
    'mcp__rea__address_name',
  ]))
  const { text } = await tool.execute({ toolNames: ['terminal', 'history'] }, {})
  assert.match(text, /terminal_open/)
  assert.match(text, /session_search/)
  assert.match(text, /search_history/)
  assert.doesNotMatch(text, /terminal_list/)
  assert.doesNotMatch(text, /browser_navigate/)
  const browser = await tool.execute({ toolNames: ['browser'] }, {})
  assert.match(browser.text, /browser_navigate/)
  const rea = await tool.execute({ toolNames: ['rea'] }, {})
  assert.match(rea.text, /mcp__rea__binary_session/)
  assert.match(rea.text, /mcp__rea__close_binary/)
  assert.doesNotMatch(rea.text, /mcp__rea__address_name/)
})

test('a missing non-MCP name suggests catalog members sharing word parts', async () => {
  // 20260930-recall 改契：无歧义的近似名**当轮直接解锁**，不再只给建议
  // （原来"No tools match + 建议"要模型再付一轮才会成事，实测失败率 15.8%）。
  // memory_serach 与 memory_search 的 bigram Dice ≈0.83 且明显甩开第二名，
  // 属于可无歧义定下的一类。
  const { text } = await searchTool().execute({ toolNames: ['memory_serach'] }, {})
  assert.match(text, /Unlocked for the next request: memory_search/)
  assert.match(text, /Auto-resolved memory_serach → memory_search/)
})

test('an ambiguous non-MCP name still only suggests, never auto-unlocks', async () => {
  // 反例守门：前缀/相似度命中多个且彼此接近时，不得替模型挑一个，只能给建议。
  // 默认夹具里 memory_ 只有一个成员（memory_search），构不成歧义，所以这里
  // 显式给一个真歧义的目录：'memory' 唯一前缀不成立，且 memory_list 与
  // memory_save 的相似度并列（margin=0），两个条件都不满足。
  const ambiguous = schemas([...resident, 'memory_save', 'memory_search', 'memory_list'])
  const { text } = await searchTool(() => ambiguous).execute({ toolNames: ['memory'] }, {})
  assert.match(text, /No tools match: memory$/m)
  assert.match(text, /closest to memory: /)
  assert.doesNotMatch(text, /Unlocked for the next request/)
})

test('scoped discovery and assembly exclude unavailable tools', async () => {
  const session = fresh()
  const agent = { session }
  const visible = catalog.filter(tool => tool.name !== github[1])
  const tool = searchTool(scope => {
    assert.equal(scope, agent)
    return visible
  })
  const args = { toolNames: [github[0], github[1]], query: 'GITHUB' }
  const f = fixture()
  f.call(session, args)
  const { text } = await tool.execute(args, { agent })
  assert.deepEqual(reported(text), [github[0]])
  assert.deepEqual(rows(text), github.filter(name => name !== github[1]))
  assert.deepEqual(await f.names(session, visible), sorted([...resident, github[0]]))
})

test('pagination schema exposes bounded optional integers and defaults', () => {
  const { properties, required, additionalProperties } = searchTool().parameters
  assert.deepEqual(properties.toolNames.items, { type: 'string' })
  for (const [key, minimum, maximum, defaultValue] of [
    ['offset', 0, Number.MAX_SAFE_INTEGER, 0], ['limit', 1, 100, 25],
  ]) {
    assert.equal(properties[key].type, 'integer')
    assert.equal(properties[key].minimum, minimum)
    assert.equal(properties[key].maximum, maximum)
    assert.equal(properties[key].default, defaultValue)
    assert.ok(!required.includes(key))
  }
  assert.equal(additionalProperties, false)
})

test('default pagination covers every match once with replayable next-page arguments', async () => {
  const tools = schemas(Array.from({ length: 65 }, (_, i) => `page_tool_${i}`))
  const tool = searchTool(() => tools)
  let args = { query: 'page_tool' }
  const collected = []
  for (const [offset, size] of [[0, 25], [25, 25], [50, 15]]) {
    const { text } = await tool.execute(args, {})
    assert.deepEqual(rows(text), tools.slice(offset, offset + size).map(tool => tool.name))
    collected.push(...rows(text))
    args = nextPage(text)
    assert.deepEqual(args, offset < 50 ? { query: 'page_tool', offset: offset + size, limit: 25 } : undefined)
  }
  assert.deepEqual(collected, tools.map(tool => tool.name))
})

test('explicit page-size boundaries, last page and exact end offsets are stable', async () => {
  const tools = schemas(Array.from({ length: 102 }, (_, i) => `page_tool_${i}`))
  const tool = searchTool(() => tools)
  for (const [offset, limit, count, nextOffset] of [[0, 1, 1, 1], [0, 100, 100, 100], [100, 100, 2], [101, 1, 1], [102, 25, 0], [999, 25, 0], [Number.MAX_SAFE_INTEGER, 100, 0]]) {
    const { text } = await tool.execute({ query: 'page_tool', offset, limit }, {})
    assert.equal(rows(text).length, count)
    assert.deepEqual(rows(text), tools.slice(offset, offset + limit).map(tool => tool.name))
    assert.deepEqual(nextPage(text), nextOffset === undefined ? undefined : { query: 'page_tool', offset: nextOffset, limit })
    if (count === 0) assert.match(text, /No tools at offset .*102 total matches/)
  }
})

test('pagination slices filtered results rather than the full catalog', async () => {
  const tools = schemas(['other_0', 'hit_0', 'other_1', 'hit_1', 'hit_2', 'other_2'])
  const { text } = await searchTool(() => tools).execute({ query: 'HIT', offset: 1, limit: 1 }, {})
  assert.deepEqual(rows(text), ['hit_1'])
  assert.deepEqual(nextPage(text), { query: 'HIT', offset: 2, limit: 1 })
})

test('pagination rejects invalid numeric inputs without truncation or silent coercion', async () => {
  const tool = searchTool()
  for (const [key, values] of [
    ['offset', [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null]],
    ['limit', [0, -1, 101, 2.5, NaN, Infinity, '25', null]],
  ]) {
    for (const value of values) {
      const { text } = await tool.execute({ query: 'github', [key]: value }, {})
      assert.match(text, new RegExp(`Invalid ${key}:`))
      assert.deepEqual(rows(text), [])
      assert.equal(nextPage(text), undefined)
    }
  }
})

test('empty catalogs, zero matches and punctuation do not advertise another page', async () => {
  for (const [tools, query, message] of [[[], 'github', /No search results/], [catalog, 'zzzz_absent', /No search results/], [catalog, '!?', /No usable search tokens/]]) {
    const { text } = await searchTool(() => tools).execute({ query, offset: 25, limit: 5 }, {})
    assert.match(text, message)
    assert.deepEqual(rows(text), [])
    assert.equal(nextPage(text), undefined)
  }
})

test('combined search pagination does not narrow or discard unlock requests', async () => {
  for (const pagination of [{ offset: 0, limit: 1 }, { offset: 999, limit: 1 }, { limit: 0 }]) {
    const args = { query: 'github', toolNames: ['mcp__github'], ...pagination }
    const session = fresh()
    const f = fixture()
    f.call(session, args)
    const { text } = await searchTool().execute(args, { agent: { session } })
    assert.deepEqual(reported(text), github)
    assert.deepEqual(await f.names(session), sorted([...resident, ...github]))
  }
})

test('keyword-only search promotes but does not implicitly unlock its results', async () => {
  const args = { query: 'github', limit: 1 }
  const session = fresh()
  const f = fixture()
  f.call(session, args)
  const { text } = await searchTool().execute(args, { agent: { session } })
  assert.deepEqual(rows(text), [github[0]])
  assert.deepEqual(reported(text), [])
  assert.deepEqual(await f.names(session), sorted(resident))
})

test('exact MCP unlock survives real Session restore and cache disposal', async () => {
  const session = fresh()
  const f = fixture()
  await f.names(session)
  f.call(session, { toolNames: [github[0]] })
  const expected = sorted([...resident, github[0]])
  assert.deepEqual(await f.names(session), expected)
  const resumed = restore(session)
  assert.ok(resumed.firstLiveSeq > resumed.inheritedEventCount)
  assert.deepEqual(await fixture().names(resumed), expected)
  f.dispose(session)
  assert.deepEqual(await f.names(resumed), expected)
})

test('real Session forks isolate parent unlocks and preserve only child-owned exact names', async () => {
  const parent = fresh()
  const f = fixture()
  f.call(parent, { toolNames: [github[0]] })
  const child = fork(parent)
  assert.deepEqual(child.ownEvents().map(event => event.type), ['session/end-seed'])
  assert.deepEqual(await f.names(child), sorted(initial))
  f.call(child)
  assert.deepEqual(await f.names(child), sorted(resident))
  f.call(child, { toolNames: [github[1]] })
  const expected = sorted([...resident, github[1]])
  assert.deepEqual(await f.names(child), expected)
  assert.deepEqual(await f.names(parent), sorted([...resident, github[0]]))
  const resumed = restore(child)
  assert.deepEqual(await fixture().names(resumed), expected)
  f.dispose(parent)
  f.dispose(child)
  assert.deepEqual(await f.names(resumed), expected)
  const grandchild = fork(resumed)
  assert.deepEqual(await f.names(grandchild), sorted(initial))
  f.call(grandchild)
  assert.deepEqual(await f.names(grandchild), sorted(resident))
})

test('own compaction keeps own exact unlocks (stable catalog), including after restore', async () => {
  const parent = fresh()
  const f = fixture()
  f.call(parent, { toolNames: [github[1]] })
  const child = fork(parent)
  f.call(child, { toolNames: [github[0]] })
  const expected = sorted([...resident, github[0]])
  assert.deepEqual(await f.names(child), expected)
  f.append(child, 'compaction/end', {})
  // compactionTools here is ['read']: the compaction set plus the child's own
  // unlock, never the parent's, and no bootstrap-only tool.
  const compacted = sorted(['read', github[0]])
  assert.deepEqual(await f.names(child), compacted)
  const resumed = restore(child)
  const cold = fixture()
  assert.deepEqual(await cold.names(resumed), compacted)
  cold.call(resumed)
  assert.deepEqual(await cold.names(resumed), expected)
  assert.deepEqual(await fixture().names(restore(resumed)), expected)
})

test('a parent compaction is not inherited as the child compaction epoch', async () => {
  const parent = fresh()
  const f = fixture()
  f.call(parent, { toolNames: [github[0]] })
  f.append(parent, 'compaction/end', {})
  const child = fork(parent)
  assert.deepEqual(await f.names(child), sorted(initial))
  f.call(child)
  assert.deepEqual(await f.names(child), sorted(resident))
})
