import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as bootstrap } from '../tool-bootstrap.mjs'
import { runtime, mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from './runtime-helper.mjs'

const { Context } = await runtime('@deepseek-ai/cordis')
const { LlmAdapter } = await runtime('@deepseek-ai/dsh-llm')
const { PtcExecutor } = await runtime('@deepseek-ai/dsh-tool-executor-ptc')

const definition = name => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: { schema: { type: 'object' }, render: () => [] },
  execute: async () => ({}),
})

const config = {
  bootstrapTools: ['bash', 'tool_gateway'],
  residentTools: ['bash', 'tool_gateway', 'read'],
  compactionTools: ['bash', 'tool_gateway', 'read'],
  subagentResidentTools: ['bash', 'tool_gateway'],
  subagentCompactionTools: ['bash', 'tool_gateway'],
  promoteOn: 'tool-call',
}

class Adapter extends LlmAdapter {
  constructor({ callTool = false } = {}) {
    super()
    this.callTool = callTool
    this.calls = 0
    this.requests = []
  }

  async *stream(options) {
    this.requests.push(structuredClone(options.tools))
    this.calls += 1
    if (this.callTool && this.calls === 1) {
      const block = { type: 'tool-call', id: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'true' }) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('real ToolsService isolates resolve state and hides a late registration', async t => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  for (const name of ['bash', 'tool_gateway', 'read', 'browser_click']) ctx.tools.register(definition(name))
  await ctx.plugin({ name: 'test-bootstrap', apply: bootstrap }, config)
  const leftAdapter = new Adapter({ callTool: true })
  const rightAdapter = new Adapter()
  ctx.llm.registerAdapter(['left-fixture'], leftAdapter)
  ctx.llm.registerAdapter(['right-fixture'], rightAdapter)
  const harness = await mountAgentLoopTestHarness(ctx)
  const left = await harness.create('real-resolve-left', { provider: 'left-fixture', model: 'fixture' })
  const right = await harness.create('real-resolve-right', { provider: 'right-fixture', model: 'fixture' })

  const prompt = id => ({ id, role: 'user', source: { kind: 'plugin', plugin: 'resolve-real-test' }, content: [{ type: 'text', text: 'start' }] })
  left.followup(prompt('left-start'))
  await left.whenIdle()
  right.followup(prompt('right-start'))
  await right.whenIdle()

  const visible = async agent => {
    const resolved = await ctx.tools.resolve({ agent, signal: new AbortController().signal })
    return [...resolved.view(agent).keys()].sort()
  }
  assert.deepEqual(leftAdapter.requests[0].map(tool => tool.name).sort(), ['bash', 'tool_gateway'])
  assert.deepEqual(rightAdapter.requests[0].map(tool => tool.name).sort(), ['bash', 'tool_gateway'])
  assert.deepEqual(await visible(left), ['bash', 'read', 'tool_gateway'])
  assert.deepEqual(await visible(right), ['bash', 'tool_gateway'])
  assert.equal(ctx.tools.executable('bash'), undefined)
  assert.equal(left.ctx.tools.executable('bash', left)?.name, 'bash')
  assert.equal(left.ctx.tools.executable('browser_click', left), undefined)

  // 2026-10-31: edit/write carry the read-evidence hint in the resolve view
  // (a `read` hint was measured as no-effect and reverted), while registry
  // definitions stay untouched for gateway catalogs and other Agents.
  const hinted = await ctx.tools.resolve({ agent: left, signal: new AbortController().signal })
  assert.equal(hinted.view(left).get('read').description, 'read')
  assert.equal(ctx.tools.schemas(left).find(tool => tool.name === 'read').description, 'read')

  ctx.tools.register(definition('late_tool'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await visible(left), ['bash', 'read', 'tool_gateway'])
  assert.deepEqual(await visible(right), ['bash', 'tool_gateway'])
  assert.equal(left.ctx.tools.executable('late_tool', left), undefined)
  assert.equal(right.ctx.tools.executable('late_tool', right), undefined)

  const ptc = new PtcExecutor({
    tools: ctx.tools,
    systemPrompt: { getSectionOrder: () => 0 },
    on: () => {},
    effect: () => () => {},
    logger: { warn() {} },
    get: name => name === 'ptcRuntime'
      ? { language: 'typescript', programFormat: 'function-body', executionInstructions: '', sandboxMode: 'read-only' }
      : ctx.get(name),
  }, {})
  assert.equal(ptc.describe().schemas[0].name, 'run_code')
  assert.equal(ptc.pipeline.get('run_code', left)?.name, 'run_code')
  const filtered = await ctx.tools.resolve({ agent: left, signal: new AbortController().signal })
  assert.equal(ptc.pipeline.get('bash', left, filtered)?.name, 'bash')
  assert.equal(ptc.pipeline.get('browser_click', left, filtered), undefined)
  assert.equal(ptc.pipeline.get('browser_click', left), undefined)
})
