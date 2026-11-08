import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { apply } from '../shell-space-normalizer-020.mjs'

function mount(parent) {
  let shell
  apply({
    leanShellParent: { shell: parent },
    effect: fn => fn(),
    reflect: { provide: (name, value) => { assert.equal(name, 'shell'); shell = value } },
  })
  return shell
}

test('shell preserves literals, quoted text, escapes and heredocs byte-for-byte', () => {
  const shell = mount({
    resolve: request => request,
    execute: spec => execFileSync('/bin/bash', ['-c', spec.command]),
  })
  for (const [command, expected] of [
    ["printf '%s' 'A\u00a0B'", 'A\u00a0B'],
    ['printf "%s" "A\u3000B"', 'A\u3000B'],
    ["cat <<'EOF'\nA\u2009B\nEOF", 'A\u2009B\n'],
    ["printf '%s' A\\\u00a0B", 'A\u00a0B'],
    ["printf '%s' $'A\\xc2\\xa0B'", 'A\u00a0B'],
    ["printf '%s' plain", 'plain'],
  ]) {
    const actual = shell.execute(shell.resolve({ command }))
    assert.deepEqual(actual, Buffer.from(expected))
    assert.deepEqual(actual, execFileSync('/bin/bash', ['-c', command]))
  }
})

test('shell forwards identity, receiver, process methods, errors and cancellation', async () => {
  const signal = new AbortController().signal
  const request = Object.freeze({ command: "printf 'A\u00a0B'", signal, stdin: 'x', env: { A: 'b', PATH: '/caller/bin' } })
  const spec = Object.freeze({ ...request, timeoutMs: 123 })
  const handle = Promise.resolve({ done: Promise.resolve() })
  const parent = {
    sandboxMode: 'workspace-write',
    resolve(value) { assert.equal(this, parent); assert.equal(value, request); return spec },
    execute(value) { assert.equal(this, parent); assert.equal(value, spec); return handle },
    onProcessDone(value) { assert.equal(this, parent); return value },
    confine(value) { assert.equal(this, parent); return value },
  }
  const shell = mount(parent)
  assert.equal(shell.resolve(request), spec)
  assert.equal(shell.execute(spec), handle)
  assert.equal(shell.sandboxMode, parent.sandboxMode)
  assert.equal(shell.onProcessDone(signal), signal)
  assert.equal(shell.confine(signal), signal)
  const error = new Error('executor failed')
  parent.execute = () => Promise.reject(error)
  await assert.rejects(shell.execute(spec), value => value === error)
  assert.throws(() => mount({}), /resolve/)
  assert.throws(() => mount({ resolve() {} }), /execute/)
})
