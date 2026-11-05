import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../shell-space-normalizer-020.mjs'

const mount = ({ defaultTimeoutMs = 120_000, jobs = true } = {}) => {
  const executed = []
  const parent = {
    sandboxMode: 'workspace-write',
    resolve: (request) => ({ command: request.command, timeoutMs: request.timeoutMs ?? defaultTimeoutMs }),
    execute: (spec) => { executed.push(spec); return { spec } },
  }
  const provided = {}
  apply({
    leanShellParent: { shell: parent },
    effect: (fn) => { fn(); return () => {} },
    reflect: { provide: (name, value) => { provided[name] = value } },
    get: (name) => (name === 'jobs' && jobs ? { registry: true } : undefined),
  })
  return { wrapper: provided.shell, parent, executed }
}

test('the default foreground wait is capped at 30 seconds', () => {
  const { wrapper } = mount()
  assert.equal(wrapper.resolve({ command: 'npm test' }).timeoutMs, 30_000)
  assert.equal(wrapper.resolve({ command: 'npm test', timeoutMs: 90_000 }).timeoutMs, 90_000)
})

test('a shorter executor default is preserved', () => {
  const { wrapper } = mount({ defaultTimeoutMs: 5_000 })
  assert.equal(wrapper.resolve({ command: 'npm test' }).timeoutMs, 5_000)
})

test('without a job registry the cap is skipped, so commands are not killed', () => {
  const { wrapper } = mount({ jobs: false })
  assert.equal(wrapper.resolve({ command: 'npm test' }).timeoutMs, 120_000)
})

test('the rest of the executor surface is forwarded', () => {
  const { wrapper, executed } = mount()
  assert.equal(wrapper.sandboxMode, 'workspace-write')
  wrapper.execute({ command: 'ls', timeoutMs: 30_000 })
  assert.deepEqual(executed, [{ command: 'ls', timeoutMs: 30_000 }])
})
