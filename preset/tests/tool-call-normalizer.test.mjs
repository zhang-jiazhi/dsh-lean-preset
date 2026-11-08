import assert from 'node:assert/strict'
import { test } from 'node:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { apply, normalizeToolArguments } from '../tool-call-normalizer.mjs'

test('subagent empty route fields mean "inherit", not a validation error', () => {
  assert.deepEqual(
    normalizeToolArguments('subagent', { prompt: 'x', provider: '', model: '', reasoning_effort: '  ' }),
    { prompt: 'x' },
  )
  assert.deepEqual(
    normalizeToolArguments('subagent_fork', { prompt: 'x', provider: 'router', model: 'gpt-6', reasoning_effort: 'high' }),
    { prompt: 'x', provider: 'router', model: 'gpt-6', reasoning_effort: 'high' },
  )
  assert.deepEqual(normalizeToolArguments('list_subagent_models', { provider: '', model: '' }), {})
})

test('bash gets a description and never escalates without a justification', () => {
  assert.deepEqual(normalizeToolArguments('bash', { command: 'ls -la' }), {
    command: 'ls -la',
    description: 'Run ls -la',
  })
  // Valid escalation with an explicit reason is preserved.
  assert.deepEqual(normalizeToolArguments('bash', {
    command: 'mkdir x', description: 'Create directory', sandbox_permissions: 'workspace-write', justification: 'The task needs a workspace write.',
  }), {
    command: 'mkdir x', description: 'Create directory', sandbox_permissions: 'workspace-write', justification: 'The task needs a workspace write.',
  })
  // No justification: drop the optional escalation, run under the current sandbox.
  assert.deepEqual(normalizeToolArguments('bash', {
    command: 'mkdir x', description: 'Create directory', sandbox_permissions: 'workspace-write',
  }), {
    command: 'mkdir x', description: 'Create directory',
  })
  // Invalid enum and orphan justification are removed.
  assert.deepEqual(normalizeToolArguments('bash', {
    command: 'ls', justification: 'orphan', sandbox_permissions: 'root',
  }), {
    command: 'ls', description: 'Run ls',
  })
})

test('escalation is kept only when strictly wider than the standing mode', () => {
  const args = { command: 'ls', description: 'List files', sandbox_permissions: 'workspace-write', justification: 'Needs a workspace write.' }
  assert.equal(normalizeToolArguments('bash', args, 'read-only').sandbox_permissions, 'workspace-write')
  assert.equal(normalizeToolArguments('bash', args, 'workspace-write').sandbox_permissions, undefined)
  assert.equal(normalizeToolArguments('bash', args, 'danger-full-access').sandbox_permissions, undefined)
  assert.equal(normalizeToolArguments('bash', { ...args, sandbox_permissions: 'danger-full-access' }, 'workspace-write').sandbox_permissions, 'danger-full-access')
})

test('mutating file tools also never escalate without a justification', () => {
  assert.deepEqual(normalizeToolArguments('write', {
    file_path: '/tmp/a', content: 'x', sandbox_permissions: 'workspace-write',
  }), {
    file_path: '/tmp/a', content: 'x',
  })
  assert.deepEqual(normalizeToolArguments('edit', {
    file_path: '/tmp/a', old_string: 'a', new_string: 'b', justification: 'orphan',
  }), {
    file_path: '/tmp/a', old_string: 'a', new_string: 'b',
  })
})

test('leading ~ is expanded only when it is the whole path or first segment', () => {
  assert.equal(normalizeToolArguments('read', { file_path: '~/notes/a.md' }).file_path, join(homedir(), 'notes/a.md'))
  assert.equal(normalizeToolArguments('edit', { file_path: '~' }).file_path, homedir())
  assert.equal(normalizeToolArguments('bash', { command: 'pwd', workdir: '~/repo' }).workdir, join(homedir(), 'repo'))
  assert.equal(normalizeToolArguments('read', { file_path: 'project/~/a.md' }).file_path, 'project/~/a.md')
})

test('edit failures carry a read-before-edit recovery hint', async () => {
  const hooks = new Map()
  apply({ on: (name, fn) => hooks.set(name, fn) })
  const run = (name, text, isError = true) => hooks.get('tools/execute')(
    { name, arguments: {} },
    async () => ({ isError, content: [{ type: 'text', text }] }),
  )
  const notRead = await run('edit', 'Error: cannot modify "a.ts": file has not been read — read the file, then retry')
  assert.match(notRead.content.at(-1).text, /`read` tool/)
  const changed = await run('edit', 'Error: cannot edit "a.ts": file changed since it was read — re-read the file, then retry')
  assert.match(changed.content.at(-1).text, /call `read` again/)
  const oldString = await run('write', 'Error: old_string was not found in "a.ts"')
  assert.match(oldString.content.at(-1).text, /literal text/)
  const success = await run('edit', 'Edited a.ts', false)
  assert.equal(success.content.length, 1)
  const bash = await run('bash', 'Error: file has not been read')
  assert.equal(bash.content.length, 1)
})

test('bash TTY/timeout failures point at terminal/background alternatives', async () => {
  const hooks = new Map()
  apply({ on: (name, fn) => hooks.set(name, fn) })
  const run = text => hooks.get('tools/execute')(
    { name: 'bash', arguments: { command: 'python' } },
    async () => ({ isError: true, content: [{ type: 'text', text }] }),
  )
  const tty = await run('Error: stdin is not a tty')
  assert.match(tty.content.at(-1).text, /terminal_\*/)
  // lean has no dev_tool_search; naming it sends the model to an unmounted tool.
  assert.match(tty.content.at(-1).text, /tool_gateway action="search"/)
  assert.doesNotMatch(tty.content.at(-1).text, /dev_tool_search/)
  const timeout = await run('Error: command timed out')
  assert.match(timeout.content.at(-1).text, /run_in_background/)
  assert.match(timeout.content.at(-1).text, /tool_gateway action="call" name="job_output"/)
  const invalid = await run('Error: invalid timeoutMs: expected a positive number')
  assert.equal(invalid.content.length, 1)
  const success = await hooks.get('tools/execute')(
    { name: 'bash', arguments: { command: 'true' } },
    async () => ({ isError: false, content: [{ type: 'text', text: 'timeout is a word in output' }] }),
  )
  assert.equal(success.content.length, 1)
})

test('hints fall back to error.message when content is empty', async () => {
  const hooks = new Map()
  apply({ on: (name, fn) => hooks.set(name, fn) })
  const out = await hooks.get('tools/execute')(
    { name: 'edit', arguments: {} },
    async () => ({ isError: true, content: [], error: { message: 'file has not been read' } }),
  )
  assert.match(out.content.at(-1).text, /`read` tool/)
})

test('tools/execute hook replaces arguments before the tool body validates them', async () => {
  const hooks = new Map()
  apply({ on: (name, fn) => hooks.set(name, fn) })
  const exec = { name: 'subagent', arguments: { prompt: 'x', provider: '', model: '' } }
  let calls = 0
  const result = await hooks.get('tools/execute')(exec, async () => { calls += 1; return 'ok' })
  assert.equal(result, 'ok')
  assert.equal(calls, 1)
  assert.deepEqual(exec.arguments, { prompt: 'x' })
})
