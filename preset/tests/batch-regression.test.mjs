import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// Two layouts: the live install keeps local plugins under ~/.dsh/local-plugins,
// the published mirror vendors them under plugins/. Resolve whichever exists.
const batchModule = ['../../../local-plugins/dsh-lean-batch/lib/index.js', '../../plugins/dsh-lean-batch/lib/index.js']
  .map(relative => new URL(relative, import.meta.url))
  .find(url => existsSync(fileURLToPath(url)))
const { apply: batch, normalizeProgram, repairArguments, planGlob } = await import(batchModule.href)
import { stripTypeScriptTypes } from 'node:module'
import { apply as discovery } from '../dev-tool-search.mjs'
import { runtime } from './runtime-helper.mjs'

const capture = (apply, extra = {}) => {
  let tool
  apply({ ...extra, tools: { register: value => { tool = value }, ...extra.tools } })
  return tool
}
const batchTool = capture(batch)
const search = capture(discovery, { tools: { schemas: () => [batchTool, search] } })
const rows = text => [...text.matchAll(/^- ([^:]+):/gm)].map(match => match[1])

// 0.2 executor contract: a nested dispatch is a single-call batch, not the
// pre-0.2 {callId,name,...} shape (which made input.calls undefined).
const nested = input => {
  assert.ok(Array.isArray(input.calls), 'nested dispatch must use the calls[] contract')
  assert.equal(input.calls.length, 1)
  return { name: input.calls[0].name, arguments: JSON.parse(input.calls[0].arguments ?? '{}') }
}
const settle = result => ({ results: [{ result }] })

for (const query of ['程序化', '编排', '批量', '程序化批量编排', '程序化 批量 编排 工具', 'batch 程序化批量编排 工具']) {
  test(`Chinese batch discovery: ${query}`, async () => {
    const { text } = await search.execute({ query }, {})
    assert.equal(rows(text)[0], 'batch')
    assert.doesNotMatch(text, /^Unlocked/m)
  })
}

test('combined discovery does not ask for a second unlock', async () => {
  const { text } = await search.execute({ query: '程序化批量编排', toolNames: ['batch'] }, {})
  assert.match(text, /^Unlocked for the next request: batch$/m)
  assert.ok(rows(text).includes('batch'))
  assert.doesNotMatch(text, /Unlock with dev_tool_search/)
})

test('query-only discovery still explains how to unlock', async () => {
  const { text } = await search.execute({ query: '程序化批量编排' }, {})
  assert.match(text, /Unlock with dev_tool_search/)
})

test('exact-name unlock works without a query', async () => {
  const { text } = await search.execute({ toolNames: ['batch'] }, {})
  assert.equal(text, 'Unlocked for the next request: batch')
})

test('usage teaches name-only unlock and same-call search', () => {
  assert.match(search.description, /toolNames.*alone/)
  assert.match(search.description, /SAME call/)
})

test('MCP guidance uses exact bracket names and the canonical result envelope', () => {
  assert.match(batchTool.description, /tools\["mcp__playwright-mcp__browser_navigate"\]/)
  assert.match(batchTool.description, /bracket notation/)
  assert.match(batchTool.description, /structuredContent/)
  assert.match(batchTool.description, /b\.type === "text"/)
  assert.match(batchTool.description, /Do not enumerate/)
  assert.match(batchTool.description, /not a task description/)
  assert.match(batchTool.description, /do not substitute another provider/)
  assert.match(batchTool.description, /lossless JSON/)
  assert.match(batchTool.description, /When one batch already returns the requested aggregate/)
  assert.match(batchTool.description, /unanchored regex/)
  assert.match(batchTool.description, /set `timeoutMs` explicitly/)
  assert.match(batchTool.description, /ONE dev_tool_search call/)
})

test('batch description stays compact once unlocked', () => {
  // Every request after unlock carries it; 2026-09-23 it had grown to 5.2 KB.
  const bytes = Buffer.byteLength(JSON.stringify({ d: batchTool.description, p: batchTool.parameters }))
  assert.ok(bytes < 4300, `batch schema is ${bytes} bytes`)
})

test('bash inner calls get the installed required description filled in', () => {
  const bash = registered.get('bash')
  assert.ok(bash.parameters.required.includes('description'))
  assert.deepEqual(repairArguments('bash', bash, { command: 'ls' }), { command: 'ls', description: 'batch: bash' })
  assert.deepEqual(repairArguments('bash', bash, { command: 'ls', description: 'mine' }), { command: 'ls', description: 'mine' })
  assert.deepEqual(repairArguments('read', registered.get('read'), { file_path: '/x' }), { file_path: '/x' })
})

test('root-relative glob patterns mean the top level of path, as the installed tool runs rg', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lean-batch-glob-'))
  const other = mkdtempSync(join(tmpdir(), 'lean-batch-cwd-'))
  try {
    mkdirSync(join(dir, 'nested'))
    writeFileSync(join(dir, 'root.md'), 'root')
    writeFileSync(join(dir, 'nested', 'deep.md'), 'deep')
    // Same argv shape as dsh-tool-fs-search buildGlobCommand, spawned in the session cwd.
    const rg = (cwd, { pattern, path }) => spawnSync('rg', [
      '--files', `--glob=${pattern}`, '--no-ignore', '--hidden', ...(path === undefined ? [] : ['--', path]),
    ], { encoding: 'utf8', cwd }).stdout.trim().split('\n').filter(Boolean).sort()
    const call = (cwd, args) => {
      const { args: fixed, restore } = planGlob(args, cwd)
      const value = { root: fixed.path ?? '.', paths: rg(cwd, fixed) }
      return (restore === undefined ? value : restore(value)).paths.map(p => p.replace(/^\.\//, ''))
    }
    // Unrepaired baseline: the failure seen live (R2-multi, and `/*.md` with an absolute path).
    assert.deepEqual(rg(dir, { pattern: './*.md' }), [])
    assert.deepEqual(rg(other, { pattern: '/*.md', path: dir }), [])
    // Repaired: top level only, from any cwd, relative or absolute path.
    assert.deepEqual(call(dir, { pattern: './*.md' }), ['root.md'])
    assert.deepEqual(call(dir, { pattern: '/*.md', path: '.' }), ['root.md'])
    assert.deepEqual(call(dir, { pattern: '/*.md', path: dir }), [join(dir, 'root.md')])
    assert.deepEqual(call(other, { pattern: '/*.md', path: dir }), [join(dir, 'root.md')])
    assert.deepEqual(call(other, { pattern: './*.md', path: `${dir}/` }), [join(dir, 'root.md')])
    assert.deepEqual(call(dir, { pattern: '/*.md', path: 'nested' }), ['nested/deep.md'])
    // Untouched: recursive basename match and model-spelled absolute anchors.
    assert.deepEqual(call(other, { pattern: '*.md', path: dir }), [join(dir, 'nested', 'deep.md'), join(dir, 'root.md')])
    assert.deepEqual(planGlob({ pattern: `${dir}/*.md`, path: dir }, other).args.pattern, `${dir}/*.md`)
    assert.match(batchTool.description, /pattern: "\/\*\.md"` = top level of `path` only/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

// Capture production output contracts without executing file operations.
const registered = new Map()
const ctx = {
  tools: { register: tool => registered.set(tool.name, tool) },
  systemPrompt: { section() {}, getSectionOrder() { return 0 } },
  inject() {}, on() {}, fs: {}, shell: { sandboxMode: void 0 }, get: () => void 0,
}
const fs = await runtime('@deepseek-ai/dsh-tool-fs')
// 0.2.1: apply() consumes an ALREADY-RESOLVED config (`const resolved = config`)
// — a raw literal silently registers no tools (flat shape) or throws (empty).
// Resolve through the schema exactly like the host loader does.
fs.apply(ctx, fs.Config({ readLimit: 20000, readMaxLineLength: 2000, readMaxBytes: 100000, readStreamMinSize: 10000000 }))
const fsSearch = await runtime('@deepseek-ai/dsh-tool-fs-search')
fsSearch.applyGlobTool(ctx, { maxResults: 100 })
fsSearch.applyGrepTool(ctx, { maxMatches: 250 })
const bash = await runtime('@deepseek-ai/dsh-tool-bash')
bash.apply(ctx, {})

for (const name of ['read', 'grep', 'glob']) {
  test(`${name} guidance agrees with installed output schema`, () => {
    const line = batchTool.description.split('\n').find(line => line.includes('`' + name + '`  '))
    assert.ok(line)
    for (const key of Object.keys(registered.get(name).output.schema.properties)) {
      assert.ok(line.includes(key), `${name} description omits ${key}: ${line}`)
    }
    if (name === 'read') assert.doesNotMatch(line, /a STRING/)
    if (name === 'grep') assert.doesNotMatch(line, /matchCount|files:/)
  })
}

test('batch forwards typed values unchanged and records nested dispatches', async () => {
  const values = {
    bash: { stdout: { text: 'ok\n' }, exitCode: 0 },
    read: { path: 'a.md', offset: 1, lines: [{ number: 1, text: 'hello' }], totalLines: 1 },
    grep: { matches: [{ path: 'a.md', lineNumber: 1, line: 'hello' }] },
    'mcp__fixture-server__read': { content: [{ type: 'text', text: '7' }] },
  }
  const events = []
  const token = {}
  const schemas = Object.keys(values).map(name => ({ name }))
  const tool = capture(batch, {
    tools: {
      schemas: () => [...schemas, { name: 'batch' }, { name: 'locked' }],
      async execute(input) {
        const call = nested(input)
        return settle({ value: values[call.name] })
      },
    },
    ptcRuntime: {
      resolve: options => options,
      async run(options) {
        const tools = options.bindings[0].functions
        assert.equal(tools.locked, undefined)
        assert.equal(tools.batch, undefined)
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
        return { value: await new AsyncFunction('tools', options.program)(tools) }
      },
    },
  })
  const text = await tool.execute({ code: `
    const b = await tools.bash({}); const r = await tools.read({});
    const g = await tools.grep({}); const m = await tools["mcp__fixture-server__read"]({});
    return { output: b.stdout.text.trim(), text: r.lines.map(l => l.text).join("\\n"),
      matches: g.matches.length, mcp: m.content.filter(b => b.type === "text").map(b => b.text).join("\\n") };
  ` }, { callId: 'outer', rootCallId: 'root', token, agent: { session: {
    ownEvents: () => [{ type: 'request/header', data: { header: { tools: schemas } } }],
    append: (type, data) => events.push({ type, data }),
  } } })
  assert.deepEqual(JSON.parse(text.slice('Return value:\n'.length)), { output: 'ok', text: 'hello', matches: 1, mcp: '7' })
  // 2026-09-25：类型从自造的 tool/batch-dispatch* 改为 harness 内置的
  // tool/ptc-dispatch*，否则读取侧 fail-closed 会拒收整份历史（桌面版必现）。
  assert.equal(events.filter(e => e.type === 'tool/ptc-dispatch').length, 4)
  assert.equal(events.filter(e => e.type === 'tool/ptc-dispatch-start').length, 4)
})

// Mimics the Node PTC runtime closely enough for program-shape tests: types
// are stripped, the body runs as an async function, and arguments that are not
// lossless JSON reject inside the program exactly like makeNamespaces does.
const lossless = value => {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(lossless)
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value).every(lossless)
  return false
}
const fakeRuntime = {
  resolve: options => options,
  async run(options) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const raw = options.bindings[0].functions
    const tools = Object.create(null)
    for (const name of Object.keys(raw)) {
      tools[name] = args => lossless(args) ? raw[name](args) : Promise.reject(new Error('binding arguments must be lossless JSON'))
    }
    try {
      const code = stripTypeScriptTypes(`async function p() {\n${options.program}\n}`)
      const value = await new AsyncFunction('tools', `'use strict';\n${code.slice(code.indexOf('{') + 1, code.lastIndexOf('}'))}`)(tools)
      return { value }
    } catch (error) {
      return { error: { kind: 'exception', message: String(error?.message ?? error) } }
    }
  },
}
const mcpName = 'mcp__playwright-mcp__browser_evaluate'
const makeTool = (names, execute, registeredNames = names) => capture(batch, {
  tools: { schemas: () => registeredNames.map(name => ({ name, parameters: name === 'bash' ? registered.get('bash').parameters : undefined })), execute },
  ptcRuntime: fakeRuntime,
})
const run = (tool, code, names) => tool.execute({ code }, { callId: 'c', rootCallId: 'r', token: {}, agent: { session: {
  ownEvents: () => [{ type: 'request/header', data: { header: { tools: names.map(name => ({ name })) } } }],
  append() {},
} } })

test('dot-notation hyphenated MCP names are rewritten to bracket access', async () => {
  const seen = []
  const tool = makeTool([mcpName], async input => { const call = nested(input); seen.push(call.name); return settle({ value: { content: [{ type: 'text', text: 'TOTAL=7' }] } }) })
  const text = await run(tool, `const r = await tools.${mcpName}({ function: "() => 1" }); return r.content[0].text`, [mcpName])
  assert.equal(text, 'Return value:\n"TOTAL=7"')
  assert.deepEqual(seen, [mcpName])
  assert.equal(normalizeProgram('x = tools.count-1').endsWith('x = tools.count-1'), true)
})

test('function-valued arguments are sent as their source text', async () => {
  let args
  const tool = makeTool([mcpName], async input => { const call = nested(input); args = call.arguments; return settle({ value: { content: [] } }) })
  const text = await run(tool, `await tools["${mcpName}"]({ function: () => document.title, skip: undefined }); return 1`, [mcpName])
  assert.equal(text, 'Return value:\n1')
  assert.equal(typeof args.function, 'string')
  assert.match(args.function, /document\.title/)
  assert.equal('skip' in args, false)
})

test('a submitted but never-called function literal is invoked', async () => {
  const tool = makeTool(['bash'], async () => settle({ value: { stdout: { text: 'hi\n' }, exitCode: 0 } }))
  assert.equal(await run(tool, 'async () => { const r = await tools.bash({ command: "echo hi" }); return r.stdout.text.trim() }', ['bash']), 'Return value:\n"hi"')
  assert.equal(await run(tool, 'async (): Promise<number> => { const n: number = 2; return n }', ['bash']), 'Return value:\n2')
  assert.equal(await run(tool, 'async function main() { return 3 }', ['bash']), 'Return value:\n3')
  assert.equal(await run(tool, 'async function main() { return 4 }\nreturn await main()', ['bash']), 'Return value:\n4')
  assert.equal(await run(tool, '```js\nreturn 5\n```', ['bash']), 'Return value:\n5')
})

test('bash without description succeeds inside a program', async () => {
  let args
  const tool = makeTool(['bash'], async input => { const call = nested(input); args = call.arguments; return settle({ value: { stdout: { text: 'ok' }, exitCode: 0 } }) })
  assert.equal(await run(tool, 'return (await tools.bash({ command: "echo ok" })).stdout.text', ['bash']), 'Return value:\n"ok"')
  assert.equal(args.description, 'batch: bash')
})

test('unique MCP suffix aliases resolve, ambiguous or native-colliding ones do not', async () => {
  const other = 'mcp__playwright-persist__browser_evaluate'
  const nav = 'mcp__playwright-mcp__browser_navigate'
  const seen = []
  const exec = async input => { const call = nested(input); seen.push(call.name); return settle({ value: { content: [] } }) }
  const single = makeTool([nav], exec, [nav, 'browser_eval'])
  await run(single, 'await tools.browser_navigate({ url: "x" }); return 1', [nav])
  assert.deepEqual(seen, [nav])
  const ambiguous = makeTool([mcpName, other], exec)
  const text = await run(ambiguous, 'return await tools.browser_evaluate({})', [mcpName, other])
  assert.match(text, /Callable in this run: mcp__playwright-mcp__browser_evaluate, mcp__playwright-persist__browser_evaluate/)
  const colliding = makeTool([nav], exec, [nav, 'browser_navigate'])
  assert.match(await run(colliding, 'return await tools.browser_navigate({})', [nav]), /is not a function/)
})

test('failures report call accounting; empty runs explain how to return', async () => {
  const tool = makeTool(['bash'], async () => settle({ isError: true, error: { message: 'boom' } }))
  const text = await run(tool, 'await tools.bash({ command: "x" })', ['bash'])
  assert.match(text, /Error: batch run failed \(exception\): boom/)
  assert.match(text, /1 tool call\(s\), 1 failed before the failure/)
  const empty = await run(tool, 'const x = 1', ['bash'])
  assert.match(empty, /no output: nothing was returned or logged; 0 tool call\(s\), 0 failed\. End the program with `return <value>`/)
})

test('inner calls still running when the run times out are cancelled', async () => {
  let innerSignal
  const tool = capture(batch, {
    tools: {
      schemas: () => [{ name: mcpName }],
      execute: input => new Promise(resolve => {
        innerSignal = input.signal
        input.signal.addEventListener('abort', () => resolve(settle({ isError: true, error: { message: 'aborted' } })), { once: true })
      }),
    },
    ptcRuntime: {
      resolve: options => options,
      async run(options) {
        options.bindings[0].functions[mcpName]({}).catch(() => {})
        await new Promise(resolve => setTimeout(resolve, 5))
        return { error: { kind: 'timeout', message: 'execution deadline reached (5ms)' } }
      },
    },
  })
  const text = await run(tool, 'await new Promise(() => {})', [mcpName])
  assert.equal(innerSignal.aborted, true)
  assert.match(text, /Last call started: mcp__playwright-mcp__browser_evaluate\. Unfinished calls were cancelled/)
})

test('argument errors name the real signature and runtime frames are trimmed', async () => {
  const schema = { name: 'web_search', parameters: { type: 'object', properties: { queries: { type: 'array' }, limit: { type: 'integer' } }, required: ['queries'] } }
  const tool = capture(batch, {
    tools: { schemas: () => [schema], execute: async () => settle({ isError: true, error: { message: 'invalid arguments: missing required property "queries"' } }) },
    ptcRuntime: {
      resolve: options => options,
      async run(options) {
        try { await options.bindings[0].functions.web_search({ query: 'x' }) } catch (error) {
          return { error: { kind: 'exception', message: `ToolCallError: ${error.message}\n    at bindingFailure (file:///x/dsh-ptc-runtime-node/lib/process.js:902:22)\n    at Socket.emit (node:events:514:20)\n    at main (file:///program.ts:3:1)` } }
        }
      },
    },
  })
  const text = await run(tool, 'x', ['web_search'])
  assert.match(text, /expected web_search\(queries\*: array, limit: integer\)/)
  assert.doesNotMatch(text, /dsh-ptc-runtime|node:events/)
  assert.match(text, /at main \(file:\/\/\/program\.ts:3:1\)/)
})
