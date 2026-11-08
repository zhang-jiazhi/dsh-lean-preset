// 20261024-unlockbudget: one short string (`mcp__rea`, `dev_*`) must not be able
// to buy an unbounded per-request tool block. Real measurement (326 lean unlock
// calls): median unlock adds ~972 schema chars, but `toolNames: ["mcp__rea"]`
// added 207 tools / 832,137 chars and every later request paid for it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as discovery } from '../dev-tool-search.mjs'
import { apply as bootstrap } from '../tool-bootstrap.mjs'
import { resolveToolNames, schemaChars, UNLOCK_BUDGET, formatChars } from '../tool-name-resolver.mjs'

import { runtime } from './runtime-helper.mjs'
const { Session } = await runtime('@deepseek-ai/dsh-session')

const RESULT_TEXT_BUDGET = 3800

/** A family whose members all cost about `chars` model-visible characters. */
const family = (server, count, chars) => Array.from({ length: count }, (_, index) => ({
  name: `mcp__${server}__tool_${String(index).padStart(3, '0')}`,
  description: 'x'.repeat(Math.max(0, chars - 90)),
}))

const catalog = [
  { name: 'bash', description: 'run a command' },
  { name: 'dev_tool_search', description: 'discover tools' },
]
const sizes = (tools) => new Map(tools.map(tool => [tool.name, schemaChars(tool)]))
/** Exactly what both production call sites pass. */
const options = (tools) => {
  const table = sizes(tools)
  return { sizeOf: name => table.get(name) ?? 0 }
}
const names = tools => tools.map(tool => tool.name)

test('a giant MCP family is deferred whole instead of unlocked', () => {
  const rea = family('rea', 207, 4020)
  const tools = [...catalog, ...rea]
  const result = resolveToolNames(['mcp__rea'], names(tools), options(tools))
  assert.deepEqual(result.resolved, [])
  assert.equal(result.deferred.length, 1)
  assert.equal(result.deferred[0].from, 'mcp__rea')
  assert.equal(result.deferred[0].tools, 207)
  assert.ok(result.deferred[0].chars > UNLOCK_BUDGET.maxChars)
  // Nothing from the family leaks into the resolved set, so assembly stays bounded.
  assert.deepEqual(result.missing, [])
})

test('a family that fits the budget still unlocks in one call', () => {
  // Real Playwright families: 47 tools / ~33k chars, 24 tools / ~17k chars.
  const playwright = family('playwright', 47, 700)
  const tools = [...catalog, ...playwright]
  const result = resolveToolNames(['mcp__playwright__*'], names(tools), options(tools))
  assert.equal(result.deferred.length, 0)
  assert.equal(result.resolved.length, 47)
})

test('an exact name is informed intent and is never budgeted away', () => {
  const monster = [{ name: 'mcp__rea__compare_web_captures', description: 'y'.repeat(180000) }]
  const tools = [...catalog, ...monster]
  const result = resolveToolNames(['mcp__rea__compare_web_captures'], names(tools), options(tools))
  assert.deepEqual(result.resolved, ['mcp__rea__compare_web_captures'])
  assert.deepEqual(result.deferred, [])
})

test('a deferred group does not consume the budget of the next group', () => {
  const rea = family('rea', 207, 4020)
  const github = family('github', 38, 660)
  const tools = [...catalog, ...rea, ...github]
  const result = resolveToolNames(['mcp__rea', 'mcp__github__*'], names(tools), options(tools))
  assert.deepEqual(result.resolved, names(github))
  assert.deepEqual(result.deferred.map(item => item.from), ['mcp__rea'])
})

test('each group is budgeted on its own, never cumulatively across the call', () => {
  // Assembly resolves the union of every unlock name a session ever recorded, so a
  // cumulative budget would defer family #3 of a long session and shrink its
  // catalog mid-flight. Two families that each fit must both survive one call.
  const first = family('first', 60, 900)
  const second = family('second', 40, 900)
  const tools = [...catalog, ...first, ...second]
  const both = resolveToolNames(['mcp__first__*', 'mcp__second__*'], names(tools), options(tools))
  assert.equal(both.resolved.length, 100)
  assert.deepEqual(both.deferred, [])
  // Same verdict whether the session recorded the two families in one call or two.
  const separately = resolveToolNames(['mcp__first__*'], names(tools), options(tools))
  const thenSecond = resolveToolNames(['mcp__first__*', 'mcp__second__*'], names(tools), options(tools))
  assert.deepEqual(separately.resolved.length, 60)
  assert.deepEqual(thenSecond, both)
})

test('a count cap still applies when schemas are tiny', () => {
  const tiny = family('tiny', 200, 120)
  const tools = [...catalog, ...tiny]
  const result = resolveToolNames(['mcp__tiny'], names(tools), options(tools))
  assert.deepEqual(result.resolved, [])
  assert.equal(result.deferred[0].tools, 200)
  const fits = family('fits', 60, 120)
  assert.equal(
    resolveToolNames(['mcp__fits'], names([...catalog, ...fits]), options([...catalog, ...fits])).resolved.length,
    60,
  )
})

let nextId = 0
const fresh = () => Session.create(`lean-unlock-budget-${++nextId}`)

const fixture = () => {
  const hooks = new Map()
  bootstrap({ on: (name, fn) => hooks.set(name, fn), logger: { warn() {} } }, {
    bootstrapTools: ['bash', 'dev_tool_search'],
    residentTools: ['bash', 'dev_tool_search'],
    compactionTools: ['bash'],
    includeSubagents: false,
    promoteOn: 'either',
  })
  return {
    call: (session, args) => {
      const event = session.append('tool/call', {
        turn: 1, step: 1, callId: `call-${session.seq}`,
        name: 'dev_tool_search', arguments: JSON.stringify(args),
      })
      hooks.get('session/event')(session, event)
    },
    names: async (session, tools) => {
      const assembled = await hooks.get('system-prompt/assemble')(null, { agent: { session } }, async () => ({
        tools, sections: [], contexts: [], variables: {},
      }))
      return assembled.tools.map(tool => tool.name).sort()
    },
  }
}

const searchTool = (tools) => {
  let tool
  discovery({ tools: { register: value => { tool = value }, schemas: () => tools } })
  return tool
}

const reported = text => text.match(/^Unlocked for the next request: (.+)$/m)?.[1].split(', ') ?? []

test('discovery and assembly both refuse the 207-tool family, and say why', async () => {
  const rea = family('rea', 207, 4020)
  const tools = [...catalog, ...rea]
  const session = fresh()
  const f = fixture()
  const before = await f.names(session, tools)
  assert.deepEqual(before, ['bash', 'dev_tool_search'])

  f.call(session, { toolNames: ['mcp__rea'] })
  const { text } = await searchTool(tools).execute({ toolNames: ['mcp__rea'] }, { agent: { session } })

  assert.deepEqual(reported(text), [])
  assert.match(text, /^Deferred mcp__rea: 207 tools/m)
  assert.match(text, /over this call's unlock budget \(64 tools \/ 60k chars\)/)
  assert.match(text, /members: mcp__rea__tool_000/)
  assert.ok(text.length <= RESULT_TEXT_BUDGET, `discovery text was ${text.length} chars`)
  // The assembly side replays the raw arguments and must reach the same verdict.
  assert.deepEqual(await f.names(session, tools), before)
})

test('a family that fits is unlocked by both sides, identically', async () => {
  const playwright = family('playwright', 47, 700)
  const tools = [...catalog, ...playwright]
  const session = fresh()
  const f = fixture()
  f.call(session, { toolNames: ['mcp__playwright'] })
  const { text } = await searchTool(tools).execute({ toolNames: ['mcp__playwright'] }, { agent: { session } })

  // The unlock report caps the rendered name list (RESULT_NAME_LIST_LIMIT), so the
  // honest check is the assembled catalog, not the length of the report line.
  assert.ok(reported(text).length > 0)
  assert.match(text, /\(\+28 more\)/)
  assert.doesNotMatch(text, /^Deferred /m)
  const assembled = await f.names(session, tools)
  assert.equal(assembled.length, 2 + 47)
  for (const tool of playwright) assert.ok(assembled.includes(tool.name))
})

test('an oversized tool is still unlockable by exact name, with its cost shown', async () => {
  const monster = { name: 'mcp__rea__compare_web_captures', description: 'y'.repeat(180000) }
  const tools = [...catalog, monster]
  const session = fresh()
  const f = fixture()
  f.call(session, { toolNames: ['mcp__rea__compare_web_captures'] })
  const { text } = await searchTool(tools).execute(
    { toolNames: ['mcp__rea__compare_web_captures'] },
    { agent: { session } },
  )
  assert.deepEqual(reported(text), ['mcp__rea__compare_web_captures'])
  assert.deepEqual(await f.names(session, tools), ['bash', 'dev_tool_search', 'mcp__rea__compare_web_captures'].sort())
  // Search rows carry the per-request price of expensive schemas (>= 8k chars).
  const page = await searchTool(tools).execute({ query: 'compare_web_captures' }, { agent: { session } })
  assert.match(page.text, /\[≈\d+k chars\/request\]/)
})

test('formatChars keeps the budget message compact', () => {
  assert.equal(formatChars(832137), '832k')
  assert.equal(formatChars(999), '999')
})

test('a long session never loses earlier families to a later unlock', async () => {
  // Regression for the cumulative-budget trap: assembly resolves the union of every
  // recorded unlock name, so three families totalling ~84k chars must all stay in
  // the catalog once each of them fits the per-group budget.
  const families = [family('alpha', 40, 700), family('beta', 40, 700), family('gamma', 40, 700)]
  const tools = [...catalog, ...families.flat()]
  const session = fresh()
  const f = fixture()
  const tool = searchTool(tools)
  for (const [index, members] of families.entries()) {
    const group = `mcp__${['alpha', 'beta', 'gamma'][index]}`
    f.call(session, { toolNames: [group] })
    const { text } = await tool.execute({ toolNames: [group] }, { agent: { session } })
    assert.doesNotMatch(text, /^Deferred /m)
    const assembled = await f.names(session, tools)
    assert.equal(assembled.length, 2 + 40 * (index + 1))
    for (const member of members) assert.ok(assembled.includes(member.name))
  }
})
