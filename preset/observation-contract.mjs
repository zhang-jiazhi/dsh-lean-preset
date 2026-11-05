/**
 * lean-observation-contract — 给每次工具结果**追加**一行结构化观测。
 *
 *   [观测] 状态=成功|失败 摘要=… 产物=… 下一步=…
 *
 * 约束：只追加一个 text block，不改写原结果；已有标记则跳过；图片结果不处理；
 *       handler 内部任何异常都退化为原 decision（绝不影响工具调用本身）。
 *
 * 2026-11-02 建立；来源：外部预设对比（ECC 的 Observation Design）。
 */
import { formatObservation, MARKER } from './observation-format.mjs?release=20261102c'

export const name = 'lean-observation-contract'
export const inject = ['tools']

// 结果正文本身就是“可原样复制”的内容，或已有自己的结构化摘要：不追加。
// read 是 P0 修正点：追加会让模型把 `[观测]` 当成文件最后一行复制进 edit/new_string。
const SKIP_TOOLS = new Set([
  'read',
  'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code',
  'workflow', 'workflow_ptc', 'list_agents',
])

const collectText = (blocks) => blocks
  .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
  .map((block) => block.text)
  .join('\n')

export function apply(ctx) {
  // 默认关闭：收益（步数）与成本（每工具调用 +20~80 tokens）都未量化。
  // 显式设置 DSH_OBSERVATION=on 才启用；见 2026-11-02 对抗审查结论。
  if (process.env.DSH_OBSERVATION !== 'on') return
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
      const isError = result.isError === true || result.error !== undefined
      // 成功结果里 read/subagent 的正文可能被原样复制，跳过；
      // 失败结果仍要标注，否则模型拿不到“下一步”。
      if (SKIP_TOOLS.has(exec.name) && !isError) return decision
      const content = decision.content ?? result.content
      if (!Array.isArray(content)) return decision
      if (content.some((block) => block && block.type === 'image')) return decision

      const text = collectText(content).trim()
      if (text.includes(MARKER)) return decision

      const line = formatObservation({
        name: exec.name,
        isError,
        errorMessage: result.error?.message ?? '',
        text,
      })
      return { kind: 'accept', content: [...content, { type: 'text', text: line }] }
    } catch {
      // 观测是辅助信息：任何异常都不能影响工具结果本身。
      return decision
    }
  })
}
