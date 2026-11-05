/**
 * observation-format.mjs — 观测行的纯函数实现（可单测，不依赖 DSH 运行时）。
 *
 * 输出格式（单行，≤220 字符）：
 *   [观测] 状态=成功|失败 摘要=… 产物=a b 下一步=…
 */

export const MARKER = '[观测]'
export const MAX_SUMMARY = 100
export const MAX_NEXT = 80
export const MAX_ARTIFACTS = 2

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
export const stripAnsi = (text) => String(text).replace(ANSI, '')
export const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** 取第一行有信息量的文本：跳过空行、`total N` 这类无信息行。 */
export function summaryLine(text) {
  for (const raw of String(text).split('\n')) {
    const line = stripAnsi(raw).trim()
    if (line === '') continue
    if (/^total\s+\d+$/i.test(line)) continue
    return line
  }
  return ''
}

const PATH_RE = /(?:^|[\s"'`(])((?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]{1,8})(?=$|[\s"'`),:;])/g

export function artifactsOf(text, limit = MAX_ARTIFACTS) {
  const seen = new Set()
  for (const match of String(text).matchAll(PATH_RE)) {
    const path = match[1]
    if (path.length > 80) continue
    seen.add(path)
    if (seen.size >= limit) break
  }
  return [...seen]
}

export function nextStepFor(name, text, isError) {
  if (isError) {
    const blob = String(text)
    if (/not a tty|stdin is not a tty|requires? (?:an? )?(?:interactive )?tty|interactive terminal/i.test(blob)) {
      return '需要交互终端，改用 terminal_*（tool_gateway 解锁）'
    }
    if (/file has not been read|file changed since it was read/i.test(blob)) return '先 read 目标文件再改'
    if (/old_string was not found/i.test(blob)) return '重新 read 该区域，逐字复制 old_string'
    if (name === 'read') return '确认路径存在；用 rg/find 或经 tool_gateway 的 glob/grep 定位后再 read'
    if (name === 'edit' || name === 'write' || name === 'str_replace_editor') return '先 read 再改；连续 3 次无新证据则停下汇报'
    return '按错误原文修正后重试；连续 3 次无新证据则停下汇报'
  }
  if (name === 'edit' || name === 'write' || name === 'str_replace_editor') return '改动后跑相关测试或检查'
  return ''
}

/** 生成观测行；内容不足时返回空串（调用方跳过追加）。 */
export function formatObservation({ name, isError, errorMessage = '', text = '' }) {
  const errorText = typeof errorMessage === 'string' ? errorMessage : ''
  const body = errorText !== '' ? errorText : text
  const summary = clip(summaryLine(body) || '（无文本输出）', MAX_SUMMARY)
  const artifacts = artifactsOf(text)
  const next = clip(nextStepFor(name, `${text}\n${errorText}`, isError), MAX_NEXT)
  return `${MARKER} 状态=${isError ? '失败' : '成功'} 摘要=${summary}`
    + (artifacts.length > 0 ? ` 产物=${artifacts.join(' ')}` : '')
    + (next !== '' ? ` 下一步=${next}` : '')
}
