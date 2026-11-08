import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../observation-contract.mjs'

const mount = (env = 'on') => {
  const handlers = {}
  const previous = process.env.DSH_OBSERVATION
  if (env === null) delete process.env.DSH_OBSERVATION
  else process.env.DSH_OBSERVATION = env
  apply({ on: (ev, fn) => { handlers[ev] = fn } })
  process.env.DSH_OBSERVATION = previous ?? ''
  const handler = handlers['tools/post-execute']
  if (handler === undefined) return undefined
  return (exec, result) => handler(exec, result, async () => ({ kind: 'accept' }))
}

const textOf = (decision) => decision.content?.at(-1)?.text ?? ''

test('默认关闭：未设置 DSH_OBSERVATION=on 时不注册任何处理器', () => {
  assert.equal(mount(null), undefined)
})

test('显式 on 时才注册', () => {
  assert.equal(typeof mount('on'), 'function')
})

test('read 成功结果不追加（P0 回归）', async () => {
  const run = mount()
  const d = await run({ name: 'read' }, { isError: false, content: [{ type: 'text', text: 'export const x = 1\n' }] })
  assert.equal(d.content, undefined)
})

test('read 失败结果仍追加下一步（P2 修复）', async () => {
  const run = mount()
  const d = await run({ name: 'read' }, { isError: true, content: [{ type: 'text', text: 'ENOENT: no such file' }] })
  assert.match(textOf(d), /状态=失败/)
  assert.match(textOf(d), /下一步=确认路径存在/)
})

test('subagent 成功结果不追加', async () => {
  const run = mount()
  const d = await run({ name: 'subagent' }, { isError: false, content: [{ type: 'text', text: '已修复 3 个文件' }] })
  assert.equal(d.content, undefined)
})

test('bash 成功结果追加观测行', async () => {
  const run = mount()
  const d = await run({ name: 'bash' }, { isError: false, content: [{ type: 'text', text: 'ok' }] })
  assert.match(textOf(d), /^\[观测\] 状态=成功 摘要=ok/)
})

test('图片结果不处理', async () => {
  const run = mount()
  const d = await run({ name: 'read_image' }, { isError: false, content: [{ type: 'image', data: 'x' }] })
  assert.equal(d.content, undefined)
})

test('已有标记时不重复追加', async () => {
  const run = mount()
  const text = 'ok\n[观测] 状态=成功 摘要=ok'
  const d = await run({ name: 'bash' }, { isError: false, content: [{ type: 'text', text }] })
  assert.equal(d.content, undefined)
})
