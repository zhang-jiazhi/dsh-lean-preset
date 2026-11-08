import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { runtime } from './runtime-helper.mjs'
import { markGatewayEligible } from '../gateway-policy.mjs?release=20261106-fixes'

const { Context } = await runtime('@deepseek-ai/cordis')

test('gateway calls a hidden tool through the real native executor and policy pipeline', async () => {
  const ctx = new Context()
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-tool-executor-native']) {
    const module = await runtime(`@deepseek-ai/${name}`)
    const plugin = module.default ?? { name: module.name, inject: module.inject, apply: module.apply }
    await ctx.plugin(plugin, {})
  }
  const tools = ctx.get('tools')
  tools.register({
    name: 'hidden_read',
    description: 'Read a hidden resource.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async () => ({ text: 'hidden result' }),
  })
  tools.register({
    name: 'hidden_image',
    description: 'Return a hidden image.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: () => [{ type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', width: 1, height: 1 } }],
    },
    execute: async () => ({ text: 'image' }),
  })
  markGatewayEligible(tools.view().visible.get('hidden_read'))
  markGatewayEligible(tools.view().visible.get('hidden_image'))
  const { apply } = await import(pathToFileURL(new URL('../tool-gateway.mjs', import.meta.url).pathname).href)
  apply({ tools })
  const gateway = tools.view().visible.get('tool_gateway')
  assert.ok(gateway)
  const result = await gateway.execute(
    { action: 'call', name: 'hidden_read', input: {} },
    { agent: undefined, signal: new AbortController().signal },
  )
  assert.equal(result.text, 'hidden result')
})


test('gateway reports hidden failures as tool errors through the native executor', async () => {
  const ctx = new Context()
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-tool-executor-native']) {
    const module = await runtime(`@deepseek-ai/${name}`)
    const plugin = module.default ?? { name: module.name, inject: module.inject, apply: module.apply }
    await ctx.plugin(plugin, {})
  }
  const tools = ctx.get('tools')
  tools.register({
    name: 'hidden_failure',
    description: 'Fail with a useful error.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: false },
      render: () => [{ type: 'text', text: 'unreachable' }],
    },
    execute: async () => { throw new Error('required parameter missing') },
  })
  markGatewayEligible(tools.view().visible.get('hidden_failure'))
  const { apply } = await import(pathToFileURL(new URL('../tool-gateway.mjs', import.meta.url).pathname).href)
  apply({ tools })
  const settled = await tools.execute({
    calls: [{ id: 'gateway-failure', name: 'tool_gateway', arguments: JSON.stringify({ action: 'call', name: 'hidden_failure', input: {} }) }],
    signal: new AbortController().signal,
  })
  const result = settled.results[0].result
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /required parameter missing/)
})

test('gateway preserves image content through the real executor', async () => {
  const ctx = new Context()
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-tool-executor-native']) {
    const module = await runtime(`@deepseek-ai/${name}`)
    const plugin = module.default ?? { name: module.name, inject: module.inject, apply: module.apply }
    await ctx.plugin(plugin, {})
  }
  const tools = ctx.get('tools')
  tools.register({
    name: 'hidden_image',
    description: 'Return a hidden image.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: () => [{ type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', width: 1, height: 1 } }],
    },
    execute: async () => ({ text: 'image' }),
  })
  markGatewayEligible(tools.view().visible.get('hidden_image'))
  const { apply } = await import(pathToFileURL(new URL('../tool-gateway.mjs', import.meta.url).pathname).href)
  apply({ tools })
  const gateway = tools.view().visible.get('tool_gateway')
  const result = await gateway.execute({ action: 'call', name: 'hidden_image', input: {} }, { agent: undefined, signal: new AbortController().signal })
  assert.deepEqual(result.content, [{ type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', width: 1, height: 1 } }])
})

test('a batch keeps image content and reports partial failure', async () => {
  const ctx = new Context()
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-tool-executor-native']) {
    const module = await runtime(`@deepseek-ai/${name}`)
    const plugin = module.default ?? { name: module.name, inject: module.inject, apply: module.apply }
    await ctx.plugin(plugin, {})
  }
  const tools = ctx.get('tools')
  tools.register({
    name: 'hidden_image',
    description: 'Return an image.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: () => [{ type: 'image', attachment: { attachmentId: 'img-batch', mediaType: 'image/png', width: 1, height: 1 } }],
    },
    execute: async () => ({ text: 'image' }),
  })
  tools.register({
    name: 'hidden_failure',
    description: 'Fail.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
    execute: async () => { throw new Error('required parameter missing') },
  })
  markGatewayEligible(tools.view().visible.get('hidden_image'))
  markGatewayEligible(tools.view().visible.get('hidden_failure'))
  const { apply } = await import(pathToFileURL(new URL('../tool-gateway.mjs', import.meta.url).pathname).href)
  apply({ tools })
  const gateway = tools.view().visible.get('tool_gateway')
  const result = await gateway.execute({
    action: 'call',
    calls: [{ name: 'hidden_image', input: {} }, { name: 'hidden_failure', input: {} }],
  }, { agent: undefined, signal: new AbortController().signal })
  assert.equal(result.content.some(block => block.type === 'image'), true, 'the image block survives the batch')
  assert.match(result.content[0].text, /BATCH PARTIAL FAILURE: 1\/2 calls failed/)
  const failure = result.content.find(block => block.type === 'text' && block.text.startsWith('## hidden_failure'))
  assert.match(failure.text, /ERROR: required parameter missing/)
  assert.match(result.text, /## hidden_image/)

  await assert.rejects(
    gateway.execute({
      action: 'call',
      calls: [{ name: 'hidden_failure', input: {} }, { name: 'hidden_failure', input: {} }],
    }, { agent: undefined, signal: new AbortController().signal }),
    /batch failed: all 2 call\(s\) failed/,
  )
})
