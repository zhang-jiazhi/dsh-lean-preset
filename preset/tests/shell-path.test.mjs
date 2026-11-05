import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { apply } from '../shell-space-normalizer-020.mjs'

function mount() {
  let shell
  apply({
    leanShellParent: { shell: { resolve: value => value, execute: value => value } },
    effect: fn => fn(),
    reflect: { provide: (_name, value) => { shell = value } },
  })
  return shell
}

function withPath(path, fn) {
  const previous = process.env.PATH
  try { process.env.PATH = path; return fn() }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous }
}

const mac = { skip: process.platform !== 'darwin' }
const directories = ['/opt/homebrew/bin', '/usr/local/bin'].filter(existsSync)

test('macOS shell appends installed CLI directories without mutating the request', mac, () => {
  withPath('/usr/bin:/bin:/usr/sbin:/sbin', () => {
    const request = Object.freeze({ command: "printf 'A\u00a0B'", env: Object.freeze({ KEEP: 'value' }) })
    const spec = mount().resolve(request)
    assert.equal(spec.env.PATH, ['/usr/bin', '/bin', '/usr/sbin', '/sbin', ...directories].join(':'))
    assert.equal(spec.command, request.command)
    assert.equal(spec.env.KEEP, 'value')
    assert.equal(request.env.PATH, undefined)
  })
})

test('PATH supplementation preserves custom precedence and forwards no ambient credentials', mac, () => {
  withPath('/custom/bin:/usr/bin:/bin', () => {
    const key = 'LEAN_PATH_TEST_SECRET'
    const previous = process.env[key]
    process.env[key] = 'fixture-not-a-secret'
    try {
      const signal = new AbortController().signal
      const dshEnv = Object.freeze({ DSH_AGENT_ID: 'fixture' })
      const request = Object.freeze({ command: 'true', signal, dshEnv })
      const spec = mount().resolve(request)
      if (directories.length) {
        assert.equal(spec.env.PATH, ['/custom/bin', '/usr/bin', '/bin', ...directories].join(':'))
        assert.deepEqual(Object.keys(spec.env), ['PATH'])
      } else assert.equal(spec, request)
      assert.equal(spec.signal, signal)
      assert.equal(spec.dshEnv, dshEnv)
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })
})

test('caller PATH is authoritative, including deliberately empty PATH', () => {
  for (const PATH of ['', '/custom/bin']) {
    const request = Object.freeze({ command: 'true', env: Object.freeze({ PATH }) })
    assert.equal(mount().resolve(request), request)
  }
})

test('already complete inherited PATH stays ordered, unchanged and idempotent', mac, () => {
  withPath(['/custom/bin', ...directories, '/usr/bin', '/bin'].join(':'), () => {
    const request = { command: 'true' }
    const shell = mount()
    assert.equal(shell.resolve(request), request)
  })
})

test('minimal desktop PATH resolves installed node, npm and rg through bash -c', {
  skip: process.platform !== 'darwin' || !['node', 'npm', 'rg'].every(name => directories.some(dir => existsSync(`${dir}/${name}`))),
}, () => {
  withPath('/usr/bin:/bin:/usr/sbin:/sbin', () => {
    const spec = mount().resolve({ command: 'command -v node && command -v npm && command -v rg' })
    const text = execFileSync('/bin/bash', ['-c', spec.command], { env: { PATH: process.env.PATH, ...spec.env }, encoding: 'utf8' })
    assert.equal(text.trim().split('\n').length, 3)
  })
})
