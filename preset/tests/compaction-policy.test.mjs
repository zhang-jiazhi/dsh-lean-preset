// Absolute compaction threshold: math, wiring, and the reason it is a plugin.
//
// The route catalogue in the profile is NOT authoritative: providers register
// at runtime (this install's `relay-cn` route comes from `llm-relay`,
// `proxy-api` from another row), so a `modelPolicies` table written from
// `cordis.patch.yml` misses them and silently keeps the ratio default. The
// first test pins that fact; the rest pin the plugin that replaces the table.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { runtimeRequire as require } from './runtime-helper.mjs'
import { apply, policyFor } from '../compaction-absolute-threshold.mjs'

const { entryListSchema } = require('@deepseek-ai/cordis-plugin-include')
const yaml = require('js-yaml')

const OPTIONS = { thresholdTokens: 200_000, retainTokens: 60_000, minWindowTokens: 250_000 }
/** The engine's own defaults, as the live config states them in lean.patch.yml. */
const BASE = { thresholdRatio: 0.6, headroomTokens: 65_536 }

test('a provider registered only at runtime receives a policy without a profile row', async () => {
  const provider = 'fixture-runtime-only'
  const f = fixture({ provider })
  f.engine.config.modelPolicies = [{ provider: 'fixture-static', model: '*', thresholdRatio: 0.6 }]
  apply(f.ctx, { thresholdTokens: 200_000, retainTokens: 60_000 })
  await f.engine.compactIfNeeded(f.agent, 'pressure', undefined)
  const policy = f.engine.config.modelPolicies.find(entry => entry.provider === provider)
  assert.equal(policy.thresholdRatio * 1_000_000, 200_000)
  assert.equal(policy.retainTokens, 60_000)
  assert.ok(f.engine.config.modelPolicies.some(entry => entry.provider === 'fixture-static'))
})

test('policyFor turns the threshold into an absolute budget on a large window', () => {
  assert.deepEqual(policyFor(OPTIONS, 1_000_000, 0, BASE), { thresholdRatio: 0.2, retainTokens: 60_000 })
  // The threshold is absolute, so windows above the budget keep the SAME token
  // threshold rather than a growing one: 1.048576M -> still 200k.
  assert.equal(policyFor(OPTIONS, 1_048_576, 0, BASE).thresholdRatio * 1_048_576, 200_000)
  assert.equal(policyFor(OPTIONS, 1_050_000, 0, BASE).thresholdRatio * 1_050_000, 200_000)
})

test('policyFor respects the reserved completion tokens the engine subtracts', () => {
  // 1M window, 128000 reserved: the budget fits, so it is lowered to 200k.
  assert.equal(policyFor(OPTIONS, 1_000_000, 128_000, BASE).thresholdRatio * 1_000_000, 200_000)
  // 1M window, 393216 reserved (router-alt/deepseek-flash measured): the budget
  // still fits, and stays the absolute 200k rather than shrinking to 0.2*window.
  assert.equal(policyFor(OPTIONS, 1_000_000, 393_216, BASE).thresholdRatio * 1_000_000, 200_000)
  // A window whose reservation plus tail leaves less than the budget is REFUSED
  // rather than lowered: the policy would not fit under the window's own budget.
  assert.equal(policyFor(OPTIONS, 300_000, 100_000, BASE), undefined)
  // Only LOWERS: on a 300k window the engine's own trigger is
  // min(180000, 300000 - 30000 - 65536) = 180000, already below the 200k budget,
  // so this route is left exactly as the deployment tuned it.
  assert.equal(policyFor(OPTIONS, 300_000, 30_000, BASE), undefined)
  // ...but a window whose own trigger is ALREADY under the budget keeps it.
  assert.equal(policyFor({ ...OPTIONS, thresholdTokens: 210_000 }, 300_000, 30_000, BASE), undefined)
})

test('policyFor leaves small or impossible windows alone', () => {
  // 262144 is below minWindowTokens: this route keeps the measured ratio path.
  assert.equal(policyFor(OPTIONS, 262_144, 0, BASE), undefined)
  assert.equal(policyFor(OPTIONS, 249_999, 0, BASE), undefined)
  // Only ever LOWERS: a 262k window with a 128k completion reservation already
  // resolves to ~69k, and 200k would RAISE it past what the window can hold.
  assert.equal(policyFor(OPTIONS, 262_144, 128_000, BASE), undefined)
  // proxy-api/grok-4.6 declares maxTokens == contextWindow: compaction can
  // never fire there (the engine throws "leaving no message budget"), which is
  // a routing-config fact this plugin must not paper over with a bogus policy.
  assert.equal(policyFor(OPTIONS, 500_000, 500_000, BASE), undefined)
  assert.equal(policyFor(OPTIONS, 0, 0, BASE), undefined)
  assert.equal(policyFor(OPTIONS, Number.NaN, 0, BASE), undefined)
  // A window whose own trigger is already below the budget is untouched: this is
  // the "never raise" rule that keeps measured small-window behavior intact.
  assert.equal(policyFor(OPTIONS, 400_000, 0, { thresholdRatio: 0.5, headroomTokens: 65_536 }), undefined)
})

function fixture({ contextWindow = 1_000_000, provider = 'relay-cn', model = 'deepseek-v4.1-flash', maxTokens = 393_216, resolveFails = false } = {}) {
  const calls = []
  const effects = []
  const warnings = []
  const engine = {
    config: { thresholdRatio: 0.6, headroomTokens: 65_536, maxTokens: 65_536, retainRatio: 0.16, modelPolicies: [] },
    compactIfNeeded: async (...args) => { calls.push(args); return null },
    compactRegion: async () => ({}),
  }
  const ctx = {
    get: (name) => (name === 'compaction' ? engine : undefined),
    // Mirrors the real host: the effect RUNS immediately and returns the restore.
    effect: (fn) => { const restore = fn(); effects.push(restore); return restore },
    logger: { warn: (message) => warnings.push(message) },
    llm: {
      resolveModelInfo: async (wantProvider, wantModel) => {
        if (resolveFails) throw new Error('unknown provider')
        assert.equal(wantProvider, provider)
        assert.equal(wantModel, model)
        return { provider, id: model, name: model, context: { contextWindow } }
      },
    },
  }
  const agent = { session: { requestHeader: () => ({ config: { provider, model, maxTokens } }) } }
  return { ctx, engine, agent, calls, effects, warnings }
}

test('the pressure path rewrites the routed model policy before the engine prices it', async () => {
  const f = fixture()
  const original = f.engine.compactIfNeeded
  apply(f.ctx, { thresholdTokens: 200_000, retainTokens: 60_000 })
  assert.notEqual(f.engine.compactIfNeeded, original, 'compactIfNeeded must be wrapped')
  await f.engine.compactIfNeeded(f.agent, 'pressure', undefined)
  assert.equal(f.calls.length, 1)
  // The wrapper forwards the original argument list unchanged.
  assert.equal(f.calls[0][0], f.agent)
  assert.equal(f.calls[0][1], 'pressure')
  const policy = f.engine.config.modelPolicies.find((entry) => entry.provider === 'relay-cn')
  assert.ok(policy, 'the routed provider must receive a policy even though no profile row declares it')
  assert.equal(policy.model, 'deepseek-v4.1-flash')
  assert.equal(policy.thresholdRatio * 1_000_000, 200_000)
  assert.equal(policy.retainTokens, 60_000)
})

test('an overflow recovery is never retuned, and a small window is left alone', async () => {
  const overflow = fixture()
  apply(overflow.ctx, {})
  await overflow.engine.compactIfNeeded(overflow.agent, 'context-overflow', undefined)
  assert.deepEqual(overflow.engine.config.modelPolicies, [])
  assert.equal(overflow.calls.length, 1)

  const small = fixture({ contextWindow: 262_144, provider: 'router-responses', model: 'model-a', maxTokens: 128_000 })
  apply(small.ctx, {})
  await small.engine.compactIfNeeded(small.agent, 'pressure', undefined)
  assert.deepEqual(small.engine.config.modelPolicies, [], 'a 262k route keeps the ratio behavior it was measured under')
  assert.equal(small.warnings.length, 0)
  assert.equal(small.calls.length, 1)
})

test('a failing window lookup never blocks compaction and is reported', async () => {
  const f = fixture({ resolveFails: true })
  apply(f.ctx, {})
  await f.engine.compactIfNeeded(f.agent, 'pressure', undefined)
  assert.equal(f.calls.length, 1, 'the engine must still run')
  assert.deepEqual(f.engine.config.modelPolicies, [])
  assert.match(f.warnings[0], /could not resolve the routed context window/)
})

test('the same route is resolved once, and a new route is retuned', async () => {
  const f = fixture()
  let lookups = 0
  const inner = f.ctx.llm.resolveModelInfo
  f.ctx.llm.resolveModelInfo = async (...args) => { lookups += 1; return inner(...args) }
  apply(f.ctx, {})
  for (let n = 0; n < 4; n++) await f.engine.compactIfNeeded(f.agent, 'pressure', undefined)
  assert.equal(lookups, 1, 'the window is a property of the route, not of the step')
})

test('disposal restores the original method, and a bad config is rejected', async () => {
  const f = fixture()
  const original = f.engine.compactIfNeeded
  apply(f.ctx, {})
  assert.equal(f.effects.length, 1)
  assert.notEqual(f.engine.compactIfNeeded, original, 'the effect owns the install')
  f.effects[0]()
  assert.equal(f.engine.compactIfNeeded, original)
  assert.throws(() => apply(f.ctx, { thresholdTokens: 10_000, retainTokens: 60_000 }), /must be below thresholdTokens/)
})

test('the preset mounts the plugin with the analysed numbers', async () => {
  const patch = yaml.load(await readFile(new URL('../lean.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema })
  const flatten = (rows) => rows.flatMap((row) => (row.config && Array.isArray(row.config) ? [row, ...flatten(row.config)] : [row]))
  const preset = flatten(patch.flatMap((entry) => entry.insert ?? [])).find((row) => row.id === 'preset-lean')
  const all = flatten(preset.config.plugins)
  const row = all.find((candidate) => candidate.id === 'compaction-absolute-threshold')
  assert.ok(row, 'compaction-absolute-threshold row missing from lean.patch.yml')
  assert.equal(row.disabled, undefined)
  assert.equal(row.config.thresholdTokens, 400_000)
  assert.equal(row.config.retainTokens, 80_000)
  assert.equal(row.config.minWindowTokens, 250_000)
  // 20261017-audit-p0: the preset may pin a summarization route (the 2026-10-02
  // model-a fix), but it must NOT pin a threshold: those are resolved at
  // runtime from the real window by compaction-absolute-threshold, and a static
  // table silently misses runtime-registered providers.
  const basic = all.find((candidate) => candidate.id === 'compaction-basic')
  for (const policy of basic.config.modelPolicies ?? []) {
    assert.equal(policy.thresholdRatio, undefined, 'static modelPolicies must not pin a threshold')
    assert.equal(policy.thresholdTokens, undefined, 'static modelPolicies must not pin a threshold')
    assert.ok(policy.summarizationProvider && policy.summarizationModel, 'static modelPolicies may only pin summarization')
  }
  // Compaction still fires well below the 600k ratio trigger, so the guard stays.
  assert.ok(all.some((candidate) => candidate.id === 'compaction-refill-guard'))
})

test('the compaction catalog equals the promoted catalog, so the prefix never changes', async () => {
  const patch = yaml.load(await readFile(new URL('../lean.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema })
  const flatten = (rows) => rows.flatMap((row) => (row.config && Array.isArray(row.config) ? [row, ...flatten(row.config)] : [row]))
  const preset = flatten(patch.flatMap((entry) => entry.insert ?? [])).find((row) => row.id === 'preset-lean')
  const bootstrap = flatten(preset.config.plugins).find((row) => row.id === 'tool-bootstrap')
  const { residentTools, compactionTools, bootstrapTools } = bootstrap.config
  // The post-compaction branch builds `compactionTools ∪ unlocks ∪ team`; the
  // promoted branch builds `residentTools ∪ unlocks ∪ team`. The tool list sits
  // at the head of every request, so ANY difference between these sets is a
  // prefix-cache invalidation AND a catalog the model must re-learn. They must
  // therefore be the same set, and no bootstrap-only tool may disappear again
  // at re-promotion.
  assert.deepEqual([...compactionTools].sort(), [...residentTools].sort(), 'compactionTools must equal residentTools')
  // 2026-10-30: str_replace_editor left the bootstrap list (measured zero
  // first-step uses in 185 sessions and unreachable after promotion), so the
  // bootstrap catalog is now a subset of the resident one. Any name that
  // reappears here must be checked against the resident/compaction sets.
  const onlyBootstrap = bootstrapTools.filter((name) => !residentTools.includes(name))
  assert.deepEqual(onlyBootstrap, [], 'expected no bootstrap-only tool')
  for (const name of onlyBootstrap) {
    assert.ok(!compactionTools.includes(name), `${name} must not appear in the compaction catalog`)
  }
})

test('the module defaults match what the preset mounts', async () => {
  // A config-less mount must not fall back to a DIFFERENT documented policy:
  // the defaults and the mounted config have to be the same numbers.
  const source = await readFile(new URL('../compaction-absolute-threshold.mjs', import.meta.url), 'utf8')
  const preset = yaml.load(await readFile(new URL('../lean.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema })
  const flatten = (rows) => rows.flatMap((row) => (row.config && Array.isArray(row.config) ? [row, ...flatten(row.config)] : [row]))
  const root = flatten(preset.flatMap((entry) => entry.insert ?? [])).find((row) => row.id === 'preset-lean')
  const row = flatten(root.config.plugins).find((candidate) => candidate.id === 'compaction-absolute-threshold')
  assert.equal(Number(source.match(/DEFAULT_THRESHOLD_TOKENS = ([\d_]+)/)[1].replaceAll('_', '')), row.config.thresholdTokens)
  assert.equal(Number(source.match(/DEFAULT_RETAIN_TOKENS = ([\d_]+)/)[1].replaceAll('_', '')), row.config.retainTokens)
})

test('400k lowers the 1M trigger to exactly 400k and leaves smaller routes alone', () => {
  const OPTIONS_400K = { thresholdTokens: 400_000, retainTokens: 80_000, minWindowTokens: 250_000 }
  // The live default route (1M window) is rewritten to an exact 400k budget.
  assert.equal(policyFor(OPTIONS_400K, 1_000_000, 0, BASE).thresholdRatio * 1_000_000, 400_000)
  assert.equal(policyFor(OPTIONS_400K, 1_000_000, 393_216, BASE).thresholdRatio * 1_000_000, 400_000)
  assert.equal(policyFor(OPTIONS_400K, 1_048_576, 0, BASE).thresholdRatio * 1_048_576, 400_000)
  assert.equal(policyFor(OPTIONS_400K, 1_000_000, 0, BASE).retainTokens, 80_000)
  // Routes whose own trigger is already below 400k keep the measured ratio path:
  // raising them would delay compaction past what the deployment tuned.
  assert.equal(policyFor(OPTIONS_400K, 262_144, 0, BASE), undefined)
  assert.equal(policyFor(OPTIONS_400K, 262_144, 128_000, BASE), undefined)
  assert.equal(policyFor(OPTIONS_400K, 512_000, 65_536, BASE), undefined)
  // A window that cannot fit the budget plus the tail is refused, not lowered.
  assert.equal(policyFor(OPTIONS_400K, 470_000, 0, BASE), undefined)
})
