import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatObservation, summaryLine, artifactsOf, nextStepFor, clip } from '../observation-format.mjs'

test('成功结果：状态/摘要/产物，且非编辑类不给下一步', () => {
  const line = formatObservation({ name: 'bash', isError: false, text: 'total 12\nsrc/app.ts\nok' })
  assert.match(line, /^\[观测\] 状态=成功 摘要=src\/app\.ts/)
  assert.match(line, /产物=src\/app\.ts/)
  assert.doesNotMatch(line, /下一步=/)
})

test('失败结果：状态=失败 + 下一步', () => {
  const line = formatObservation({ name: 'edit', isError: true, errorMessage: 'old_string was not found', text: '' })
  assert.match(line, /状态=失败/)
  assert.match(line, /下一步=重新 read/)
})

test('跳过 total N 这类无信息行', () => {
  assert.equal(summaryLine('total 0\nreal line'), 'real line')
})

test('产物最多 2 个、去重', () => {
  assert.deepEqual(artifactsOf('a/b.ts a/b.ts c/d.js e/f.py'), ['a/b.ts', 'c/d.js'])
})

test('长摘要被截断且带省略号', () => {
  const long = 'x'.repeat(300)
  assert.equal(clip(long, 20).length, 20)
  assert.ok(clip(long, 20).endsWith('…'))
})

test('成功且编辑类给验证提示', () => {
  assert.match(nextStepFor('edit', '', false), /测试或检查/)
})
