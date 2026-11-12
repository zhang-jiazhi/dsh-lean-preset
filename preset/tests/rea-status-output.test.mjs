import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { projectReaStatus } from '../rea-status-output.mjs'
import { apply as gateway } from '../tool-gateway.mjs'
import { markGatewayEligible } from '../gateway-policy.mjs?release=20261106-fixes'
import { runtime, mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from './runtime-helper.mjs'

const name = 'mcp__rea__binary_session'
const exec = { callId: 'status-call', agent: { session: { id: 'rea-output-fixture' } } }

function fixture() {
  const status = {
    open: false, cleanup_pending: false,
    capabilities: [{ provider: { id: 'native', name: 'Native', version: '1' }, groups: [{ available: true, operations: Array.from({ length: 400 }, (_, i) => `operation_${i}`) }] }],
    analysis_provider_binding: null,
    analysis_provider_candidates: [{ provider: { id: 'ghidra' }, selected: false, availability: { status: 'available', diagnostics: { verbose: 'x'.repeat(10000) } }, target_support: { status: 'unknown', reason: 'No target is open.' } }],
    tool_availability: { client_requirements: { missing_required: [] }, groups: [{ names: ['read_bytes'], available: false, reason: 'target_required', remediation: 'open_binary' }] },
    server_identity: { package: { version: '6.7.0' }, catalog: { digest: 'a'.repeat(64) } },
    client_features: { roots: false },
  }
  const record = { result: status }
  const value = { content: [{ type: 'text', text: JSON.stringify(record) }] }
  const result = { isError: false, value, content: [{ type: 'text', text: 'Host spill preview; use the full result reference.\n'.repeat(250) }] }
  const saved = []
  const ctx = { get: key => key === 'spillStore' ? {
    async saveText(input) {
      saved.push(input)
      return { locator: '/fixture/rea-status.json', bytes: Buffer.byteLength(input.content), retrievalHint: 'Use read with offset/limit.' }
    },
  } : undefined }
  return { status, record, value, result, saved, ctx }
}

test('large REA status is summarized from uncut canonical value and retained losslessly', async () => {
  const f = fixture()
  const out = await projectReaStatus(f.ctx, exec, name, f.result)
  const text = out.content[0].text
  assert.ok(text.length < 5000)
  assert.equal(out.value, f.value, 'canonical data is not altered')
  const summary = JSON.parse(text)
  assert.equal(summary.status.open, false)
  assert.equal(summary.status.analysis_provider_candidates[0].availability.status, 'available')
  assert.deepEqual(summary.status.server_identity, f.status.server_identity)
  assert.equal(summary.status.tool_availability.unavailable_reasons[0].reason, 'target_required')
  assert.equal(f.saved.length, 1)
  assert.deepEqual(JSON.parse(f.saved[0].content).parsed_result, f.record)
  assert.deepEqual(JSON.parse(f.saved[0].content).original_value, f.value)
  assert.equal(summary.full_result.sha256, createHash('sha256').update(f.saved[0].content).digest('hex'))
  assert.equal(f.saved[0].owner.sessionId, exec.agent.session.id)
})

test('full_output, failures, analysis tools and image results bypass summarization', async () => {
  const f = fixture()
  assert.equal(await projectReaStatus(f.ctx, exec, name, f.result, true), f.result)
  assert.equal(await projectReaStatus(f.ctx, exec, 'mcp__rea__analyze_function', f.result), f.result)
  const failure = { ...f.result, isError: true }
  assert.equal(await projectReaStatus(f.ctx, exec, name, failure), failure)
  const image = { ...f.result, content: [{ type: 'image', attachment: {} }] }
  assert.equal(await projectReaStatus(f.ctx, exec, name, image), image)
  assert.equal(f.saved.length, 0)
})

test('storage failures retain the original output with an explicit notice', async () => {
  const f = fixture()
  const ctx = { get: () => ({ saveText: async () => { throw new Error('ENOSPC') } }) }
  const out = await projectReaStatus(ctx, exec, name, f.result)
  assert.deepEqual(out.content[0], f.result.content[0])
  assert.match(out.content[1].text, /ENOSPC.*Original output retained/)
  assert.equal(out.value, f.value)
})

test('missing storage, unfamiliar or conflicting JSON stays unchanged', async () => {
  const f = fixture()
  assert.equal(await projectReaStatus({ get() {} }, exec, name, f.result), f.result)
  const unfamiliar = { isError: false, value: { content: [{ type: 'text', text: 'not JSON' }] }, content: [] }
  assert.equal(await projectReaStatus(f.ctx, exec, name, unfamiliar), unfamiliar)
  const conflict = { ...f.result, value: { ...f.value, structuredContent: { result: { ...f.status, open: true } } } }
  assert.equal(await projectReaStatus(f.ctx, exec, name, conflict), conflict)
  assert.equal(f.saved.length, 0)
})

test('small status and summaries that cannot fit the budget keep full output', async () => {
  const f = fixture()
  const small = { isError: false, value: { content: [{ type: 'text', text: '{"result":{"open":false}}' }] }, content: [] }
  assert.equal(await projectReaStatus(f.ctx, exec, name, small), small)
  f.value.content[0].text = JSON.stringify({ result: { ...f.status, server_identity: { unsupported_field: 'x'.repeat(10000) } } })
  assert.equal(await projectReaStatus(f.ctx, exec, name, f.result), f.result)
  assert.equal(f.saved.length, 0)
})

test('an already compact Host preview is never expanded', async () => {
  const f = fixture()
  const compact = { ...f.result, content: [{ type: 'text', text: 'Full result is retained at an existing Host reference.' }] }
  assert.equal(await projectReaStatus(f.ctx, exec, name, compact), compact)
  assert.equal(f.saved.length, 0)
})

test('native gateway single and batch calls summarize without rerunning the MCP operation', async () => {
  const { Context } = await runtime('@deepseek-ai/cordis')
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create('rea-gateway-projection')
  const f = fixture()
  let runs = 0
  const tool = {
    name, description: 'REA status fixture', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'] }, render: (_args, value) => value.content },
    execute: async () => { runs += 1; return f.value },
  }
  ctx.tools.register(tool)
  markGatewayEligible(tool, undefined, agent)
  gateway({ tools: ctx.tools, get: f.ctx.get })
  const call = async args => (await ctx.tools.execute({
    calls: [{ id: `rea-outer-${runs}`, name: 'tool_gateway', arguments: JSON.stringify(args) }],
    agent, signal: new AbortController().signal,
  })).results[0].result
  const single = await call({ action: 'call', name, input: {} })
  assert.equal(single.isError, false, single.content[0]?.text)
  assert.ok(JSON.parse(single.content[0].text).full_result)
  const batch = await call({ action: 'call', calls: [{ name }] })
  assert.equal(batch.isError, false)
  assert.ok(JSON.parse(batch.content[1].text).full_result)
  assert.equal(batch.meta.gatewayCalls[0].status, 'ok')
  const full = await call({ action: 'call', name, full_output: true })
  assert.equal(full.content[0].text, f.value.content[0].text)
  assert.equal(runs, 3, 'each external call runs once; projection is not a second query')
  assert.equal(f.saved.length, 2)
})
