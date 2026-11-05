import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../dev-tool-search.mjs'

const makeTool = (catalog) => {
  let tool
  apply({ tools: { register: value => { tool = value }, schemas: () => catalog } })
  return tool
}
const catalog = Array.from({ length: 73 }, (_, i) => ({
  name: `mcp__fixture__search_record_${String(i).padStart(3, '0')}`,
  description: `Search fixture records. ${'Detailed result metadata. '.repeat(6)}`,
}))
const rows = text => [...text.matchAll(/^- ([^:]+):/gm)].map(m => m[1])
const next = text => {
  const match = text.match(/Next page: dev_tool_search\(([^\n]+)\)\./)
  return match ? JSON.parse(match[1]) : null
}

test('large discovery page stays below the existing 4096-character pruning threshold', async () => {
  const { text } = await makeTool(catalog).execute({ query: 'fixture', limit: 100 }, {})
  assert.ok(text.length < 4096, `page was ${text.length} characters`)
  assert.ok(rows(text).length > 0)
  assert.ok(next(text), 'budgeted results must provide a continuation')
})

test('budget pagination advances by returned rows without losing or duplicating names', async () => {
  const tool = makeTool(catalog), names = []
  let args = { query: 'fixture', limit: 100 }, pages = 0
  while (args) {
    const { text } = await tool.execute(args, {})
    const page = rows(text)
    assert.ok(page.length > 0)
    assert.ok(text.length < 4096)
    names.push(...page)
    const continuation = next(text)
    if (continuation) assert.equal(continuation.offset, args.offset === undefined ? page.length : args.offset + page.length)
    args = continuation
    assert.ok(++pages <= catalog.length)
  }
  assert.deepEqual(names, catalog.map(x => x.name))
  assert.ok(pages > 1)
})

test('successful unlock and unrelated query miss do not report an unlock failure', async () => {
  const { text } = await makeTool([{ name: 'skill_search', description: 'Search skills' }]).execute({
    toolNames: ['skill_search'], query: 'unrelated_fixture_topic',
  }, {})
  assert.match(text, /Unlocked for the next request: skill_search/)
  assert.match(text, /No search results/)
  assert.doesNotMatch(text, /No tools match/)
})

test('mixed unlock outcome preserves missing names and successful names', async () => {
  const { text } = await makeTool([{ name: 'skill_search' }]).execute({
    toolNames: ['skill_search', 'missing_fixture_tool'], query: 'unrelated_fixture_topic',
  }, {})
  assert.match(text, /Unlocked for the next request: skill_search/)
  assert.match(text, /No tools match: missing_fixture_tool/)
  assert.match(text, /No search results/)
})

test('pure search misses and unknown unlocks retain actionable errors', async () => {
  const tool = makeTool(catalog)
  assert.match((await tool.execute({ query: 'absent_fixture_topic' }, {})).text, /No search results/)
  const { text } = await tool.execute({ toolNames: ['mcp__absent__read'] }, {})
  assert.match(text, /No tools match: mcp__absent__read/)
  assert.doesNotMatch(text, /Unlocked for the next request/)
})

test('small requested pages preserve their limit and next offset', async () => {
  const { text } = await makeTool(catalog).execute({ query: 'fixture', offset: 5, limit: 3 }, {})
  assert.deepEqual(rows(text), catalog.slice(5, 8).map(x => x.name))
  assert.deepEqual(next(text), { query: 'fixture', offset: 8, limit: 3 })
})

test('unlock plus a budgeted query retains the complete explicit unlock feedback', async () => {
  const names = catalog.slice(0, 2).map(x => x.name)
  const { text } = await makeTool(catalog).execute({ query: 'fixture', limit: 100, toolNames: names }, {})
  assert.ok(text.includes(`Unlocked for the next request: ${names.join(', ')}`))
  assert.ok(text.length < 4096)
  assert.ok(next(text))
})

test('guidance discourages redundant unlocks and guessed tool names', () => {
  const { description } = makeTool([])
  assert.match(description, /Already available\? Call it directly/)
  assert.match(description, /never guess/)
  assert.match(description, /current task phase/)
})

test('an oversized catalog name cannot push a discovery page past the budget', async () => {
  const long = `mcp__fixture__${'x'.repeat(5000)}`
  const { text } = await makeTool([
    { name: long, description: 'fixture' },
    { name: 'fixture_ok', description: 'fixture' },
  ]).execute({ query: 'fixture', limit: 100 }, {})
  assert.ok(text.length < 4096, `page was ${text.length} characters`)
  assert.ok(rows(text).length > 0)
})

test('an oversized unlock batch reports bounds without echoing every name', async () => {
  const names = catalog.map(x => x.name)
  const { text } = await makeTool(catalog).execute({ query: 'fixture', limit: 100, toolNames: names }, {})
  assert.ok(text.length < 4096, `page was ${text.length} characters`)
  assert.match(text, /Unlocked for the next request: /)
  assert.match(text, /\(\+\d+ more\)/)
  assert.ok(next(text), 'bounded unlock feedback must still leave room for a continuation')
})

test('an oversized query is rejected with a bounded message', async () => {
  const { text } = await makeTool(catalog).execute({ query: `fixture ${'x'.repeat(5000)}` }, {})
  assert.ok(text.length < 4096, `page was ${text.length} characters`)
  assert.match(text, /Invalid query: keep it within 128 characters/)
  assert.doesNotMatch(text, /x{200}/)
})

test('a long unlock report plus long suggestion lists never truncates the continuation', async () => {
  const family = Array.from({ length: 40 }, (_, i) => ({
    name: `mcp__gh__fixture_${'x'.repeat(234)}_${String(i).padStart(3, '0')}`,
    description: 'fixture record',
  }))
  const valid = family.slice(0, 5).map(x => x.name)
  const missing = ['a', 'b', 'c'].map(suffix => `mcp__gh__fixture_${'y'.repeat(234)}_${suffix}`)
  const { text } = await makeTool(family).execute(
    { query: `fixture ${'x'.repeat(100)}`, limit: 100, toolNames: [...valid, ...missing] },
    {},
  )
  assert.ok(text.length < 4096, `page was ${text.length} characters`)
  assert.doesNotMatch(text, /omitted to stay within/, 'the page body must fit without the last-resort cut')
  const page = rows(text)
  assert.ok(page.length > 0, 'a page must always render at least one row')
  const header = /Matching tools \((\d+), showing (\d+)-(\d+)\)/.exec(text)
  assert.ok(header, 'the result header must survive')
  assert.equal(Number(header[2]), 1)
  assert.equal(Number(header[3]), page.length, 'the header must not claim more rows than rendered')
  assert.ok(next(text), 'the continuation must survive the budget')
})
