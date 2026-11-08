import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PRESSURE, scaledPlugins, pressureMessages, testDelegationPlugins, setupSmokeAgent } from '../tools/lean-live-smoke.mjs'

test('smoke setup does not return a model-selection facade as an AgentSetupCommit', async () => {
  const ctx = { on() {} }, agent = {}, row = { steps: 0 }
  const value = await setupSmokeAgent(ctx, agent, { row, preset: 'test', presets: { async mount() {} }, installModelSelection: () => ({ select() {} }) })
  assert.equal(value, undefined)
  assert.equal(row.agent, agent)
})

test('only the private test copy admits its temporary child preset', () => {
  const source = [
    { name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', agentPreset: 'lean', allowedAgentPresets: ['lean', 'standard'], maxDepth: 10 } },
    { name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'fork', inheritParent: true, maxDepth: 10 } },
  ]
  const before = structuredClone(source)
  const copy = testDelegationPlugins(source, 'lean-private-test')
  assert.deepEqual(source, before)
  assert.equal(copy[0].config.agentPreset, 'lean-private-test')
  assert.deepEqual(copy[0].config.allowedAgentPresets, ['lean', 'standard', 'lean-private-test'])
  assert.equal(copy[0].config.maxDepth, 10)
  assert.deepEqual(copy[1], source[1], 'fork must not receive independent preset options')
})

test('scaled pressure configuration is detached and does not alter the production policy', () => {
  const original = [{ id: 'group', config: [
    { id: 'compaction-basic', config: { thresholdRatio: 0.6, retainRatio: 0.16, modelPolicies: [] } },
    { id: 'compaction-absolute-threshold', config: { thresholdTokens: 400000, retainTokens: 80000, minWindowTokens: 250000 } },
  ] }]
  const before = structuredClone(original)
  const copy = scaledPlugins(original)
  assert.deepEqual(original, before)
  assert.equal(copy[0].config[0].config.auto, true)
  assert.equal(copy[0].config[0].config.retainRatio, undefined)
  assert.equal(copy[0].config[0].config.retainTokens, PRESSURE.retainTokens)
  assert.deepEqual(copy[0].config[1].config, PRESSURE)
  assert.throws(() => scaledPlugins([]), /exactly one basic engine and absolute policy/)
})

test('pressure fixture has a separate recent node larger than the retained tail', () => {
  const estimate = message => JSON.stringify(message).length / 4
  const messages = pressureMessages(estimate, 'MEM_TEST_UNIQUE')
  assert.ok(estimate(messages.history) >= PRESSURE.thresholdTokens + 6000)
  assert.ok(estimate(messages.tail) >= PRESSURE.retainTokens + 500)
  assert.ok(estimate(messages.tail) < PRESSURE.thresholdTokens / 2)
  assert.ok(messages.history.content[0].text.includes('MEM_TEST_UNIQUE'))
  assert.ok(!messages.tail.content[0].text.includes('MEM_TEST_UNIQUE'))
  assert.ok(!messages.check.content[0].text.includes('MEM_TEST_UNIQUE'))
  for (const message of Object.values(messages)) assert.equal(message.source.kind, 'user')
})

test('invalid or non-growing meter estimates cannot create unbounded fixtures', () => {
  assert.throws(() => pressureMessages(() => NaN, 'MEM'), /invalid estimate/)
  assert.throws(() => pressureMessages(() => 0, 'MEM'), /bounded pressure fixture/)
})
