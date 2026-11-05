/**
 * @local/dsh-lean-batch — the LEAN preset's optional `batch` tool.
 *
 * Takes PTC's mechanism without PTC's carrier:
 *
 *  - Mechanism taken: a model-written program calls this session's visible
 *    tools, aggregates inside the program, and only the program's output
 *    returns to the conversation. Intermediate results never enter the
 *    transcript.
 *  - Carrier refused: this row never sets `tool-presentation`. The agent keeps
 *    `native` mode, so every visible tool keeps its own schema in context and
 *    this tool ships NO generated SDK text. The model already reads each
 *    tool's signature from those schemas, so the binding only needs one
 *    sentence of convention.
 *
 * Sub-calls go through `ctx.tools.execute()`, the registry's public entry: the
 * full pipeline (pre-execute gate, approval, guards, around-dispatch,
 * post-execute, finalization) runs for every inner call, exactly as it does
 * for a model-direct call. Setting `parent` marks them as nested, which is
 * what keeps them out of the ptc-mode collapse and lets their events land in
 * the session stream for replay.
 *
 * Execution itself is delegated to `ctx.ptcRuntime`, so the sandbox, elapsed
 * budget, output cap and heap cap are the runtime's own — this plugin owns no
 * execution substrate and asserts no security boundary of its own.
 */

import * as nodeModule from 'node:module'
import { isAbsolute, relative as relativePath, resolve as resolvePath } from 'node:path'

const { stripTypeScriptTypes } = nodeModule

/** Elapsed budget used when the model does not ask for one. */
const DEFAULT_TIMEOUT_MS = 120_000
/** Upper bound accepted from the model, matching the released Node runtime's cap. */
const MAX_TIMEOUT_MS = 600_000

/** Stable cordis plugin name. */
export const name = 'lean-batch'

/**
 * `ptcRuntime` is an injected dependency, not a hard mount requirement: on a
 * deployment that composes no PTC runtime this plugin stays pending, so the
 * hosting preset is never taken down by the missing service.
 */
export const inject = ['tools', 'ptcRuntime']

const DESCRIPTION = [
  // The first line is deliberately Chinese, and it is not decoration: the
  // index entry the model reads lives in dev_tool_search's description in
  // Chinese, so a model searches with THOSE words. An AND query over
  // 程序化/批量/编排 only lands on this tool if this tool says them too —
  // otherwise the only match is the index carrier itself (measured
  // 2026-09-23: the multi-tool probe returned dev_tool_search instead of
  // batch and the run failed). Keep these words in sync with the
  // UNLOCKABLE_INDEX entry.
  '程序化批量编排：写一段程序，在内部循环调用本会话可见的工具（tools.<name>(args)）。每次调用的结果留在程序内、不进对话，只有 console.log/return 的内容返回给你。',
  '',
  'Run one program that calls this session\'s visible tools; only the program\'s output reaches the conversation. `code` is an async TypeScript/JavaScript function body, not a task description: write top-level statements with `await`/`return`.',
  '',
  'Use it when the intermediate results are LARGE and you do NOT need to read them: the program aggregates inside, so only its output reaches the conversation. Measured on this deployment (2026-09-25): folding `add -> dev_stage_call x3 -> demote` went 5 steps / 25,152 chars down to 2 steps / 1,152 chars (-95% context), while folding 3 browser_eval whose results totalled 458 chars saved 7%. So the trigger is result SIZE, not call COUNT: many items or same-tool-type alone is not a reason. Do NOT use it when one composed call already finishes the work (measured: a 3-file extract costs 723 chars as one targeted `bash` versus 133,764 as three `read`, and batch costs 1,694 for that same job), nor when you must read each intermediate result to decide the next step.',
  '',
  'Calling tools: use the EXACT names and argument schemas in YOUR OWN catalog, e.g. `tools.bash({ command, description })`; for hyphenated MCP names use bracket notation: `tools["mcp__playwright-mcp__browser_navigate"]({ url: "http://localhost/" })`. When several similar MCP servers are visible, call the one you unlocked for this task; do not substitute another provider. Arguments must be lossless JSON (strings, numbers, booleans, arrays, plain objects): pass code as a string, never a function. Only tools already unlocked exist in `tools`; calling dev_tool_search INSIDE the program does not add tools to the same run, so unlock batch and every needed tool in ONE dev_tool_search call first. Do not enumerate `Object.keys(tools)` or run capability probes. Await state-changing calls sequentially.',
  '',
  'Output: `return` a JSON value and/or `console.log(...)`. A failed tool call throws `ToolCallError` (`err.toolName`); catch and retry it inside the program. When one batch already returns the requested aggregate, return it directly; do not add outer recomputation or verification calls unless the task asks for them. Large fan-outs (e.g. dozens of browser calls) should set `timeoutMs` explicitly.',
  '',
  'RETURN VALUES are structured tool values, NOT the rendered text of direct calls. Use these contracts without probing:',
  '  `bash`  → `{ kind: "foreground", stdout: { text, truncated }, stderr: { text }, exitCode, timedOut }`: use `r.stdout.text.trim()` and check `exitCode`. (`kind: "background" | "promoted"` returns a `jobId` instead.)',
  '  `glob`  → `{ root, paths }`: `r.paths`. `pattern: "/*.md"` = top level of `path` only, `"*.md"` = recursive basename match.',
  '  `read`  → `{ path, offset, lines: [{ number, text }], totalLines }`: text is `r.lines.map(l => l.text).join("\\n")` (NOT a string).',
  '  `grep`  → `{ matches: [{ path, lineNumber, line }] }`: count with `r.matches.length`.',
  '  MCP tools → `{ content: [...], structuredContent? }`: text is `r.content.filter(b => b.type === "text").map(b => b.text).join("\\n")`. Browser text may wrap the value in Markdown (`### Result` …); extract markers with an unanchored regex such as `/TOTAL=(\\d+)/` rather than `JSON.parse` on the whole text.',
  '  Other non-MCP tools (e.g. `cordis_inspect_query`) → the canonical object itself, often `r.data` or `r.structuredContent`; do not assume a `{ content }` envelope. If a property is undefined, inspect `r` with `console.log(Object.keys(r))` inside the program instead of guessing.',
  'For an undocumented value, inspect the first real result INSIDE this program and reuse it; never spend a separate call on shape discovery.',
].join('\n')

/**
 * REPL（persistent / in-memory executionMode）版文案。
 *
 * 宿主事实：REPL 不支持顶层 `return`（ptc-runtime-node/src/persistent.ts:289），
 * 完成值来自最后一个表达式的求值结果（PtcRunRequest.program 文档，types.ts:76）。
 * 所以只改会教坏模型的句子：输出改说"末表达式"，其余（工具调用约定、返回值
 * 形状）逐字保留。
 */
const DESCRIPTION_REPL = DESCRIPTION
  .replace('只有 console.log/return 的内容返回给你。', '只有 console.log/末表达式 的内容返回给你。')
  .replace(
    "Run one program that calls this session's visible tools; only the program's output reaches the conversation. `code` is an async TypeScript/JavaScript function body, not a task description: write top-level statements with `await`/`return`.",
    "Run one program that calls this session's visible tools; only the program's output reaches the conversation. `code` is a TypeScript REPL program, not a task description: write top-level statements with `await`; top-level `return` is NOT supported (it is a syntax error) — emit output with `console.log(...)` or a final lossless JSON expression.",
  )
  .replace('Output: `return` a JSON value and/or `console.log(...)`.', 'Output: end the program with a final JSON expression and/or `console.log(...)`.')
  .replace('When one batch already returns the requested aggregate, return it directly;', 'When one batch already produces the requested aggregate, emit it directly;')
  .replace('RETURN VALUES are structured tool values', 'RESULT VALUES are structured tool values')

/**
 * Resolve the gate that the hosting preset actually applied to this agent.
 *
 * `ctx.tools.schemas(scope)` is NOT that gate: a preset that narrows the
 * catalog at ASSEMBLY time (as the LEAN preset does with its residentTools
 * whitelist) leaves the registry untouched, so `schemas()` still returns every
 * registered tool. Building the program's bindings from `schemas()` therefore
 * handed a model that could see 4 tools a program that could call 218 — the
 * gate was bypassed entirely (measured 2026-09-23: total=218, web_search a
 * function, 26 github MCP tools, 47 browser MCP tools, 9 memory tools, 19
 * injector tools, none of them unlocked).
 *
 * The durable log already records the real answer: the agent loop appends a
 * `request/header` event carrying the tool catalog it handed the model, and it
 * re-appends on every change (`reason: "initial"` then `reason: "change"`).
 * Reading the LAST one restores exactly what the model is authorized to see,
 * with no knowledge of any particular preset's whitelist.
 *
 * @param {unknown} session - the calling agent's session, when one exists.
 * @param {ReadonlyArray<{name: string}>} fallback - catalog used when no header is recorded yet.
 * @returns {Set<string>} tool names the program may call.
 */
function authorizedToolNames(session, fallback) {
  const fallbackNames = fallback.map((schema) => schema.name)
  if (session === undefined || session === null) return new Set(fallbackNames)
  let events
  try {
    events = typeof session.ownEvents === 'function' ? session.ownEvents() : undefined
  } catch {
    return new Set(fallbackNames)
  }
  if (!Array.isArray(events)) return new Set(fallbackNames)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'request/header') continue
    const tools = event.data?.header?.tools
    if (!Array.isArray(tools)) continue
    const names = tools.map((tool) => (typeof tool?.name === 'string' ? tool.name : undefined)).filter((n) => n !== undefined)
    // An empty recorded catalog is not an authorization decision we can honor.
    if (names.length > 0) return new Set(names)
  }
  return new Set(fallbackNames)
}

/**
 * Resolve the elapsed budget the model asked for, clamped to the runtime's cap.
 * @param {unknown} requested - the model-supplied `timeoutMs`, if any.
 * @returns {number} a positive finite budget in milliseconds.
 */
function resolveTimeout(requested) {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_TIMEOUT_MS
  }
  return Math.min(requested, MAX_TIMEOUT_MS)
}

/**
 * Rewrite `tools.a-b-c` into `tools["a-b-c"]`.
 *
 * Hyphenated MCP names are not JS identifiers, so the dot form parses as a
 * subtraction chain and dies with a ReferenceError on the right-hand operand
 * ("mcp__browser_navigate is not defined", measured 2026-09-23 R5c). Nobody
 * means `tools.server__x - y` here, so any `__`-qualified member is rewritten.
 * @param {string} code - program text.
 * @returns {string} program text with bracket notation.
 */
function bracketHyphenatedNames(code) {
  return code.replace(/(^|[^\w$.])tools\.([A-Za-z_$][\w$]*(?:-[\w$]+)+)/g, (match, lead, member) => (
    // Only MCP-style `server__tool` names; `tools.x-1` stays arithmetic.
    member.includes('__') ? `${lead}tools[${JSON.stringify(member)}]` : match
  ))
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

/**
 * Turn a submitted-but-never-called function literal into a called one.
 *
 * `code: "async () => { ... }"` is a legal body that evaluates the arrow and
 * throws it away, so the run "completes with no output" and the model retries
 * (measured 2026-09-23 R5d). When the whole text is one function expression,
 * call it. Compiling with the AsyncFunction constructor only parses; nothing runs.
 * @param {string} code - program text.
 * @param {boolean} [repl] - REPL 模式：顶层 return 非法，末表达式的值才是完成值。
 * @returns {string} program text that actually executes.
 */
function invokeBareFunction(code, repl = false) {
  const trimmed = code.trim().replace(/;+$/, '')
  if (!/^(?:async\s+)?(?:function\b|\([^()]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/.test(trimmed)) return code
  try {
    // The runtime strips TypeScript types before running; do the same for this parse-only check.
    const plain = typeof stripTypeScriptTypes === 'function' ? stripTypeScriptTypes(`(${trimmed}\n)`) : `(${trimmed}\n)`
    // eslint-disable-next-line no-new
    new AsyncFunction(`return ${plain}`)
  } catch {
    return code
  }
  // REPL 顶层不能 `return`（persistent.ts:289），末表达式才是完成值。
  return repl ? `await (${trimmed}\n)()` : `return await (${trimmed}\n)()`
}

/**
 * Argument-lossless fixer, shared by both preludes below.
 *
 * The runtime rejects a function-valued argument before it leaves the sandbox
 * ("binding arguments must be lossless JSON", measured 2026-09-23 R5e: the
 * model passed `function: () => {...}` to browser_evaluate, whose schema wants
 * that function's SOURCE as a string). A function is never a valid tool
 * argument, so its source text is the only sensible meaning; `undefined`
 * object members are dropped the way JSON.stringify drops them.
 */
const ARGUMENT_FIXER = '((raw) => { const fix = (v) => typeof v === "function" ? String(v) : Array.isArray(v) ? v.map(fix) : v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, fix(x)])) : v; const out = Object.create(null); for (const k of Object.keys(raw)) out[k] = (a) => raw[k](fix(a)); return out })'

/**
 * function-body 模式的前置修正。`tools` 是函数体作用域里的普通绑定，可写。
 * 保留在程序第一行，用户代码的堆栈行号不变。
 */
const ARGUMENT_PRELUDE = `tools = ${ARGUMENT_FIXER}(tools); `

/**
 * REPL 模式的前置修正。
 *
 * 宿主用 `Object.defineProperty(repl.context, 'tools', { configurable: true, value })`
 * 暴露绑定，没有 writable（ptc-runtime-node/src/persistent-process.ts:108）；
 * REPL 里 `tools = ...` 在非严格模式下静默无效（本会话用 node:repl 复现：
 * 赋值后仍是原对象）。这里改用 defineProperty 替换这个 configurable 属性，
 * 既绕开只读赋值，又保持顶层末表达式作为完成值的语义（不包 IIFE，避免
 * 末表达式值被函数返回值吞掉）。
 */
const ARGUMENT_PRELUDE_REPL = `Object.defineProperty(globalThis, "tools", { configurable: true, value: ${ARGUMENT_FIXER}(globalThis.tools) }); `

/**
 * Program text as the runtime should see it.
 * @param {unknown} code - model-supplied `code`.
 * @param {'function-body' | 'repl'} [format] - host `ctx.ptcRuntime.programFormat`.
 * @returns {string} normalized program.
 */
export function normalizeProgram(code, format = 'function-body') {
  if (typeof code !== 'string') return ''
  // Models often wrap the program in a Markdown fence (same repair as
  // Cloudflare codemode's normalizeCode); a fence is a syntax error otherwise.
  const fenced = /^\s*```(?:js|javascript|ts|typescript|jsx|tsx)?[^\S\n]*\n([\s\S]*?)\n?```\s*$/.exec(code)
  const body = fenced === null ? code : fenced[1]
  const repl = format === 'repl'
  return (repl ? ARGUMENT_PRELUDE_REPL : ARGUMENT_PRELUDE) + invokeBareFunction(bracketHyphenatedNames(body), repl)
}

/**
 * Make a root-relative glob mean "top level of `path`".
 *
 * glob runs `rg --files --glob=<pattern> -- <path>` with the SESSION cwd as the
 * process cwd. Measured 2026-09-23 against ripgrep 15.2 and the installed tool:
 * `./*.md` never matches; `/*.md` matches only when `path` is omitted or `.`;
 * with an ABSOLUTE `path` no anchored pattern matches at all (unless cwd is
 * `/`). An anchored pattern does work when `path` is cwd-relative and the
 * pattern repeats that relative prefix (`path: "sub"`, `pattern: "sub/*.md"`,
 * including `../` prefixes). So the call is rewritten to that form and the
 * returned paths are mapped back to the absolute root the model asked for.
 * @param {{ pattern?: unknown, path?: unknown }} args - glob arguments.
 * @param {string | undefined} cwd - session cwd the tool runs rg in.
 * @returns {{ args: object, restore?: (value: any) => any }} rewritten call.
 */
export function planGlob(args, cwd) {
  const pattern = typeof args.pattern === 'string' ? args.pattern : undefined
  if (pattern === undefined) return { args }
  let rest
  if (pattern.startsWith('./')) rest = pattern.slice(2)
  else if (pattern.startsWith('/') && !pattern.startsWith('//')) rest = pattern.slice(1)
  else return { args }
  const given = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : undefined
  if (given === undefined || given === '.' || given === './') return { args: { ...args, pattern: `/${rest}` } }
  // An absolute pattern that already spells an absolute root is the model's
  // own anchoring; leave it alone rather than guessing.
  if (pattern.startsWith('/') && isAbsolute(given) && pattern.startsWith(`${given.replace(/\/+$/, '')}/`)) return { args }
  if (cwd === undefined || !isAbsolute(cwd)) return { args }
  const absolute = isAbsolute(given) ? given : resolvePath(cwd, given)
  const rel = relativePath(cwd, absolute)
  if (rel === '') return { args: { ...args, path: '.', pattern: `/${rest}` }, restore: isAbsolute(given) ? mapBack(cwd, given) : undefined }
  return {
    args: { ...args, path: rel, pattern: `${rel}/${rest}` },
    restore: isAbsolute(given) ? mapBack(cwd, given) : undefined,
  }
}

/** Map cwd-relative glob paths back to absolute ones under the requested root. */
function mapBack(cwd, root) {
  return (value) => {
    if (value === null || typeof value !== 'object' || !Array.isArray(value.paths)) return value
    return { ...value, root, paths: value.paths.map((p) => (typeof p === 'string' && !isAbsolute(p) ? resolvePath(cwd, p) : p)) }
  }
}

/**
 * Deterministically repair argument mistakes that carry no task meaning.
 *
 *  - A required `description` (bash) is a UI label for the call; inner calls
 *    are never shown as cards, so a missing one only fails validation
 *    (measured 2026-09-23 R2b). Supply one.
 * @param {string} toolName - canonical tool name.
 * @param {{ parameters?: { required?: string[], properties?: Record<string, { type?: string }> } }} schema - tool schema.
 * @param {unknown} args - model-supplied arguments.
 * @returns {unknown} arguments to dispatch.
 */
export function repairArguments(toolName, schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  let out = args
  const required = Array.isArray(schema?.parameters?.required) ? schema.parameters.required : []
  const describedAsString = schema?.parameters?.properties?.description?.type === 'string'
  if (required.includes('description') && describedAsString
    && (typeof out.description !== 'string' || out.description.trim() === '')) {
    out = { ...out, description: `batch: ${toolName}` }
  }
  return out
}

/**
 * Add short aliases for MCP tools whose `__<suffix>` is unambiguous.
 *
 * A model that writes `tools.browser_navigate` for the only visible
 * `mcp__<server>__browser_navigate` means that tool. The alias is skipped when
 * the suffix is shared by two visible servers or collides with ANY registered
 * tool name (e.g. a native `browser_navigate`), so it never changes which
 * provider runs.
 * @param {Record<string, Function>} functions - canonical bindings (mutated).
 * @param {Set<string>} registered - every registered tool name.
 */
function addSuffixAliases(functions, registered) {
  const bySuffix = new Map()
  for (const toolName of Object.keys(functions)) {
    const cut = toolName.lastIndexOf('__')
    if (!toolName.startsWith('mcp__') || cut < 0) continue
    const suffix = toolName.slice(cut + 2)
    if (suffix === '') continue
    bySuffix.set(suffix, bySuffix.has(suffix) ? null : toolName)
  }
  for (const [suffix, toolName] of bySuffix) {
    if (toolName === null || registered.has(suffix) || suffix in functions) continue
    functions[suffix] = functions[toolName]
  }
}

/**
 * Compact parameter signature: `name: type` with `*` marking required.
 * @param {{ parameters?: { properties?: Record<string, { type?: unknown }>, required?: string[] } }} schema - tool schema.
 * @returns {string} e.g. `queries*: array, limit: integer`.
 */
function signatureOf(schema) {
  const properties = schema?.parameters?.properties ?? {}
  const required = new Set(Array.isArray(schema?.parameters?.required) ? schema.parameters.required : [])
  return Object.entries(properties)
    .map(([key, prop]) => `${key}${required.has(key) ? '*' : ''}: ${Array.isArray(prop?.type) ? prop.type.join('|') : (prop?.type ?? 'any')}`)
    .join(', ')
}

/** Drop runtime-internal stack frames: they cost tokens and never help fix a program. */
function trimStack(message) {
  return message
    .split('\n')
    .filter((line) => !/^\s+at .*(?:dsh-ptc-runtime|node:internal|node:events|\(node:|<anonymous>)/.test(line))
    .join('\n')
}

/**
 * Render a settled run as the text the model receives.
 * @param {{ logs?: string[], value?: unknown, error?: { kind?: string, message?: string } }} result - runtime outcome.
 * @param {{ calls: number, failed: number, callable: string[], lastTool?: string }} [stats] - dispatch accounting for diagnostics.
 * @param {'function-body' | 'repl'} [format] - program format this run used.
 * @returns {string} transcript text.
 */
function renderRun(result, stats = { calls: 0, failed: 0, callable: [] }, format = 'function-body') {
  const sections = []
  const logs = Array.isArray(result.logs) ? result.logs : []
  if (logs.length > 0) sections.push(logs.join('\n'))
  const tally = `${String(stats.calls)} tool call(s), ${String(stats.failed)} failed`
  if (result.error !== undefined) {
    const kind = result.error.kind ?? 'failure'
    const message = trimStack(result.error.message ?? 'unknown')
    const lines = [`Error: batch run failed (${kind}): ${message}`, `(${tally} before the failure)`]
    if (kind === 'timeout') {
      lines.push(`Last call started: ${stats.lastTool ?? '(none)'}. Unfinished calls were cancelled; completed calls are not rolled back. Raise \`timeoutMs\` (max 600000) or split the work.`)
    }
    if (/is not a function|is not defined|of undefined/.test(message)) {
      lines.push(`Callable in this run: ${stats.callable.join(', ') || '(none)'}`)
    }
    sections.push(lines.join('\n'))
  } else if (result.value !== undefined) {
    sections.push(`${format === 'repl' ? 'Value' : 'Return value'}:\n${JSON.stringify(result.value, null, 2)}`)
  }
  if (sections.length === 0) {
    return format === 'repl'
      ? `(batch completed with no output: nothing was printed and the final expression was undefined; ${tally}. End the program with a final JSON expression or \`console.log(...)\`.)`
      : `(batch completed with no output: nothing was returned or logged; ${tally}. End the program with \`return <value>\`.)`
  }
  return sections.join('\n\n')
}

/**
 * Register the `batch` tool on the host.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context carrying `tools` and `ptcRuntime`.
 */
export function apply(ctx) {
  // programFormat 是宿主 runtime 的既定属性（ptc-runtime-node/src/index.ts:45：
  // in-memory → 'repl'，其余 → 'function-body'）。注册文案与执行共用同一判定。
  const programFormat = ctx.ptcRuntime?.programFormat === 'repl' ? 'repl' : 'function-body'
  ctx.tools.register({
    name: 'batch',
    description: programFormat === 'repl' ? DESCRIPTION_REPL : DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Short summary of what the program does.',
        },
        code: {
          type: 'string',
          description: programFormat === 'repl'
            ? 'TypeScript REPL program. Top-level `await` and declarations are available; top-level `return` is not. Output comes from `console.log(...)` or the final expression.'
            : 'Body of an async TypeScript/JavaScript function. Top-level `await` and `return` are available.',
        },
        timeoutMs: {
          type: 'number',
          description: `Elapsed budget in milliseconds (default ${String(DEFAULT_TIMEOUT_MS)}, max ${String(MAX_TIMEOUT_MS)}).`,
        },
      },
      required: ['description', 'code'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const runtime = ctx.ptcRuntime
      const schemas = ctx.tools.schemas(exec.agent)
      // Only tools the model itself was handed: see authorizedToolNames for why
      // the raw registry list is the wrong set to expose here.
      const authorized = authorizedToolNames(exec.agent?.session, schemas)

      const registered = new Set(schemas.map((schema) => schema.name))
      // Inner calls must not outlive the run. The runtime's deadline kills the
      // program process but never reaches calls already handed to the host, so
      // a timed-out fan-out kept navigating the browser while the model issued
      // its next call (R5b, 2026-09-23). Abort them when the run settles.
      const settled = new AbortController()
      const innerSignal = exec.signal === undefined ? settled.signal : AbortSignal.any([exec.signal, settled.signal])
      let dispatched = 0
      let lastTool
      let failed = 0
      /** @type {Record<string, (rawArgs: unknown) => Promise<unknown>>} */
      const functions = Object.create(null)
      for (const schema of schemas) {
        const toolName = schema.name
        // A program must not re-enter itself: recursion would multiply runs.
        if (toolName === 'batch') continue
        // Honour the preset's gate: an ungated program would let the model call
        // capabilities it never unlocked by writing one program.
        if (!authorized.has(toolName)) continue
        functions[toolName] = async (rawArgs) => {
          if (settled.signal.aborted) throw Object.assign(new Error('batch run already settled'), { toolName })
          dispatched += 1
          lastTool = toolName
          const subCallId = `${String(exec.callId)}:batch:${String(dispatched)}`
          let logged = repairArguments(toolName, schema, rawArgs === undefined ? {} : rawArgs)
          let restore
          if (toolName === 'glob' && logged !== null && typeof logged === 'object' && !Array.isArray(logged)) {
            ;({ args: logged, restore } = planGlob(logged, exec.agent?.session?.header?.cwd))
          }
          const session = exec.agent?.session
          // Sub-calls are recorded on the session stream, not just kept in the
          // program: without this, a replay would show one `batch` call and no
          // trace of what it actually did.
          //
          // [2026-09-25] 直接复用 PTC 桥的 `tool/ptc-dispatch*` 类型，而不是自造
          // `tool/batch-dispatch*`：自造类型不在任何构建的 KNOWN_SESSION_EVENT_TYPES
          // 里，读取侧的 fail-closed 闸门会因此拒绝**整份**历史（"unknown to this
          // harness"）。此前靠 `{ ignorable: true }` 豁免，但那只在写入端已打上
          // `dsh-session-ignorable-patch` 的 harness 上生效 —— 桌面版把 dsh 核心
          // 打进签名 asar（不可改），append() 仍会丢弃该标记，于是桌面版里跑一次
          // batch 就会把整份会话写成不可加载（2026-09-25 实测 session-7ce1abfd）。
          // PTC 类型是 harness 内置词汇，4 棵已装版本树（0.1.6-alpha.1 ~ 0.1.7-alpha.2）
          // 与桌面版 0.1.7-rc.2（59 个已知类型）都认；事件形状本来就和 PTC 一致，
          // 客户端（聊天/轨迹视图）也按 subCallId/parentCallId 通用渲染成子调用。
          // 不要再改回自带前缀或依赖 ignorable：那会把「能否加载历史」绑定到写入端实现。
          session?.append('tool/ptc-dispatch-start', {
            rootCallId: exec.rootCallId,
            parentCallId: exec.callId,
            subCallId,
            name: toolName,
            arguments: logged,
          })
          let settledBatch
          try {
            // 0.2 executor contract: one batch input carrying `calls[]`. The
            // pre-0.2 single-call shape left `input.calls` undefined, so every
            // nested call died with "Cannot read properties of undefined
            // (reading 'map')" (observed 2026-11-01).
            settledBatch = await ctx.tools.execute({
              calls: [{ id: subCallId, name: toolName, arguments: JSON.stringify(logged ?? {}) }],
              ...(exec.agent === undefined ? {} : { agent: exec.agent }),
              // No toolSet: the executor's per-step admission set is scoped to the
              // batch call itself and rejects the nested name ("unknown tool bash").
              // `authorized` above already enforces the preset's gate.
              signal: innerSignal,
            })
          } catch (cause) {
            // The executor wraps a failed sub-dispatch in a generic "Tool batch
            // execution failed" whose message hides the tool's own reason (e.g.
            // lean's guard). Surface the cause so the failure is actionable.
            const detail = cause?.cause?.message ?? cause?.message ?? 'unknown error'
            const error = new Error(`tool "${toolName}" could not run: ${detail}`)
            error.toolName = toolName
            error.cause = cause
            throw error
          }
          for (const context of settledBatch?.additionalContexts ?? []) exec.deferContext?.(context)
          if (settledBatch?.concluded === true) exec.concludeTurn?.()
          const result = settledBatch?.results?.[0]?.result
          if (result === undefined) {
            const error = new Error(`tool "${toolName}" produced no result`)
            error.toolName = toolName
            throw error
          }
          session?.append('tool/ptc-dispatch', {
            rootCallId: exec.rootCallId,
            parentCallId: exec.callId,
            subCallId,
            name: toolName,
            arguments: logged,
            isError: result.isError === true,
            ...(result.content === undefined ? {} : { content: result.content }),
          })
          if (result.isError) {
            failed += 1
            let message = result.error?.message ?? `tool "${toolName}" failed`
            // Name the real signature so the model fixes the call in one retry
            // instead of spending a run on shape discovery.
            if (/invalid arguments/i.test(message)) message += ` — expected ${toolName}(${signatureOf(schema)})`
            const error = new Error(message)
            error.toolName = toolName
            throw error
          }
          if (result.value === undefined) return null
          return restore === undefined ? result.value : restore(result.value)
        }
      }

      const callable = Object.keys(functions)
      addSuffixAliases(functions, registered)

      const cwd = exec.agent?.session?.header?.cwd
      let result
      try {
        result = await runtime.run(runtime.resolve({
        program: normalizeProgram(args.code, programFormat),
        bindings: [{
          global: 'tools',
          functions,
          errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
        }],
        signal: exec.signal,
        ...(cwd === undefined ? {} : { cwd }),
        timeoutMs: resolveTimeout(args.timeoutMs),
      }))
      } finally {
        settled.abort('batch run settled')
      }

      return renderRun(result, { calls: dispatched, failed, callable, lastTool }, programFormat)
    },
  })
}
