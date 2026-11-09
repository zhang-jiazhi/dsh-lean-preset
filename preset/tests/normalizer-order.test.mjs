// The normalizer must win the ordering race against tools/pre-execute rules
// (dsh-sandbox validates sandbox_permissions / justification there).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runtime } from './runtime-helper.mjs'
import { apply as normalize } from '../tool-call-normalizer.mjs'

const { Context } = await runtime('@deepseek-ai/cordis')

test('empty justification is dropped before a pre-execute validator sees it', async () => {
  const ctx = new Context()
  normalize({ on: (name, fn, options) => ctx.on(name, fn, options), logger: { warn() {} } })
  const seen = []
  // Registered AFTER the normalizer, mimicking dsh-sandbox's later listener.
  ctx.on('tools/pre-execute', async (exec, next) => {
    seen.push({ ...exec.arguments })
    if (exec.arguments?.sandbox_permissions !== undefined && !String(exec.arguments?.justification ?? '').trim()) {
      throw new Error('invalid justification: expected a non-empty sentence')
    }
    return next()
  })
  const exec = { name: 'bash', arguments: { command: 'ls', sandbox_permissions: 'workspace-write', justification: '' } }
  await ctx.waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].sandbox_permissions, undefined, 'escalation must be stripped before dsh-sandbox validates it')
  assert.equal(seen[0].justification, undefined)
  assert.equal(seen[0].command, 'ls')
  assert.equal(seen[0].description, 'Run ls', 'the bash description backfill still applies')
})

test('a subagent route with empty strings reaches the validator clean', async () => {
  const ctx = new Context()
  normalize({ on: (name, fn, options) => ctx.on(name, fn, options), logger: { warn() {} } })
  const seen = []
  ctx.on('tools/pre-execute', async (exec, next) => { seen.push({ ...exec.arguments }); return next() })
  const exec = { name: 'subagent', arguments: { description: 'd', prompt: 'p', provider: '', model: '', reasoning_effort: '' } }
  await ctx.waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
  assert.deepEqual(seen, [{ description: 'd', prompt: 'p' }])
})
