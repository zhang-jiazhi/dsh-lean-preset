/**
 * Scoped skill discovery and versioned, non-waking instruction loading.
 * Identical delivered or pending text is reused; compaction clears visibility.
 * Resource files are not cached by this plugin. Only the selected skill body
 * enters context, so the full-catalog dsh-tool-skill row stays disabled.
 */

import { createHash, randomUUID } from 'node:crypto'
import { isFailedCompaction, ownSessionEvents } from './compaction-epoch.mjs?release=20260924-failed-compaction'

const contentDigest = text => createHash('sha256').update(text).digest('hex')

/** Only delivered instruction bodies or pending inbox items count as loaded. */
function acceptSkill(versions, message) {
  const source = message?.source
  if (source?.kind !== 'skill-invocation' || source.form !== 'instructions' || typeof source.name !== 'string') return
  if (message.content?.length !== 1 || message.content[0]?.type !== 'text' || typeof message.content[0].text !== 'string') return
  versions.set(source.name, contentDigest(message.content[0].text))
}

function observeSkill(versions, event) {
  if (event.type === 'compaction/end') {
    // A failed compaction did not drop the transcript, so the skill bodies are
    // still in place; clearing would make `skill_load` re-deliver them.
    if (isFailedCompaction(event)) return
    versions.clear()
  } else if (event.type === 'user/message') acceptSkill(versions, event.data)
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'skill-search'

/** The agent, tools, and skills services must exist before these tools can register. */
export const inject = ['agents', 'tools', 'skills']

const MAX_RESULTS = 20

/** Minimal JSON schema compiler for tool parameters (zero dependencies). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Register the two on-demand skill tools. */
export function apply(ctx) {
  const loaded = new WeakMap()
  const versionsFor = session => {
    let versions = loaded.get(session)
    if (!versions) {
      versions = new Map()
      for (const event of ownSessionEvents(session)) observeSkill(versions, event)
      loaded.set(session, versions)
    }
    return versions
  }
  ctx.on('session/event', (session, event) => {
    const versions = loaded.get(session)
    if (versions) observeSkill(versions, event)
  })
  ctx.on('session/disposed', session => { if (session) loaded.delete(session) })
  /**
   * Query tokenization. Unicode property escapes keep CJK characters — the
   * original `/[^a-z0-9_-]+/` split erased every Chinese token, so a Chinese
   * query produced `wanted = []` and the filter's `wanted.length === 0`
   * branch returned ALL skills unfiltered (measured 2026-09-03). The haystack
   * is intentionally NOT tokenized anymore: matching now runs as substring
   * inclusion over the raw lowercase text, which also fixes partial-word
   * matches the old token-equality approach rejected.
   */
  /** CJK→English aliases: Chinese queries need English keywords to reach
   * English skill names (e.g. 表格 → xlsx). Each alias's words are OR
   * alternatives for one query term; different terms stay AND. */
  const CJK_ALIASES = [
    ['浏览器', 'browser'], ['网页', 'web browser'], ['桌面', 'desktop'], ['屏幕', 'screen'],
    ['表格', 'xlsx spreadsheet excel'], ['文档', 'document docx word'],
    ['转换', 'convert'], ['图片', 'image picture photo'],
    ['游戏', 'game'], ['截图', 'screenshot screen'],
    ['网络', 'web crawl'], ['爬虫', 'crawl crawl4ai'],
    ['逆向', 'reverse decompile'], ['调试', 'debug'], ['终端', 'terminal'],
    ['生成图', 'image generate'], ['幻灯片', 'pptx slides'],
    ['海报', 'poster'], ['验证', 'verify verification'],
    ['澄清', 'clarify clarification ambiguous brainstorming'],
    ['工作树', 'worktree worktrees'], ['搜索', 'search find'],
  ]

  /** Split concatenated known CJK aliases without changing Latin tokenization. */
  const aliasTerms = [...CJK_ALIASES].sort((a, b) => b[0].length - a[0].length).map(([term]) => term)
  const splitAliases = (text) => {
    const raw = (text || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)
    const result = []
    for (const token of raw) {
      let rest = token
      while (rest.length > 0) {
        const at = aliasTerms
          .map((term) => [term, rest.indexOf(term)])
          .filter(([, index]) => index >= 0)
          .sort((a, b) => a[1] - b[1] || b[0].length - a[0].length)[0]
        if (at === undefined) {
          result.push(rest)
          break
        }
        const [term, index] = at
        if (index > 0) result.push(rest.slice(0, index))
        result.push(term)
        rest = rest.slice(index + term.length)
      }
    }
    return result
  }

  const expandTokenGroups = (raw) => {
    const groups = []
    for (const token of raw) {
      let candidates = null
      for (const [cjk, english] of CJK_ALIASES) {
        if (token === cjk || english.split(' ').includes(token)) {
          candidates = [cjk, ...english.split(' ')]
          break
        }
      }
      groups.push(candidates ?? [token])
    }
    return groups
  }

  ctx.tools.register({
    name: 'skill_search',
    description: 'Discover a specialized workflow when the task needs one and no suitable skill is already known. Returns matching names and applicability, not a checklist to load in full. Ordinary work with sufficient context needs no skill lookup. Use skill_load only for a relevant workflow, and reuse valid instructions already in context.',
    parameters: toJsonSchema({
      query: { type: 'string', required: true, description: 'search keywords (e.g. "pdf", "obsidian", "game review")' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      const raw = splitAliases(String(args.query ?? ''))
      const wanted = expandTokenGroups(raw)
      const scope = exec?.agent ?? ctx
      try {
        const all = await ctx.skills.list({
          scope,
          cwd: exec?.agent?.session?.header?.cwd,
          signal: exec?.signal,
        })
        const matches = all.filter((skill) => {
          if (wanted.length === 0) return false
          const haystack = `${skill.name} ${skill.description ?? ''} ${skill.whenToUse ?? ''}`.toLowerCase()
          return wanted.every((group) => group.some((candidate) => haystack.includes(candidate)))
        })
        const head = matches.slice(0, MAX_RESULTS)
        const lines = head.map((skill) => {
          const desc = (skill.description || '').split('\n')[0]
          return `- ${skill.name}: ${desc}`
        })
        if (lines.length === 0) return { text: `No skills match "${args.query}". Use skill_search with other keywords.` }
        const extra = matches.length > MAX_RESULTS ? `\n…(${matches.length - MAX_RESULTS} more)` : ''
        return { text: `Matching skills (${matches.length}):\n${lines.join('\n')}${extra}\n\nLoad one with skill_load (exact name).` }
      } catch (error) {
        // Provider faults are failures; only a normal no-match is successful.
        throw error
      }
    },
  })

  ctx.tools.register({
    name: 'skill_load',
    description: 'Load one task-relevant skill by an exact known name. Reuses identical instruction text already delivered or pending, reloads changed content, and permits reloading after compaction. Search only when the appropriate name is unknown; loading a skill is not an approval or task-completion checkpoint.',
    parameters: toJsonSchema({
      name: { type: 'string', required: true, description: 'exact skill name (kebab-case, from skill_search)' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      try {
        const agent = exec?.agent
        if (!agent?.session) throw new Error('skill_load requires an agent context.')
        const skill = await ctx.skills.get(args.name, {
          scope: agent,
          cwd: agent.session.header.cwd,
          signal: exec?.signal,
        })
        if (skill === undefined) {
          return { text: `No skill named "${args.name}". Run skill_search to list available skills.` }
        }
        const body = extractSkillBody(skill)
        if (body.length === 0) {
          return { text: `Skill "${args.name}" has no loadable body.` }
        }
        const skillName = skill.name ?? args.name
        const base = skill.resourceBase
        const origin = {
          provider: skill.provider ?? null,
          source: skill.source ?? null,
          path: skill.path ?? null,
          resourceKind: base?.kind ?? null,
          resourceLocation: base?.path ?? base?.url ?? base?.description ?? null,
        }
        const text = `技能 ${skillName} 的当前指引（替代此前同名技能版本；仅用于本任务适用部分）：\n来源：${JSON.stringify(origin)}\n\n${body}`
        const versions = new Map(versionsFor(agent.session))
        for (const message of agent.inbox?.nextStep ?? []) acceptSkill(versions, message)
        if (versions.get(skillName) === contentDigest(text)) {
          return { text: `Skill "${skillName}" is already loaded unchanged (delivered or pending); reuse its applicable instructions.` }
        }
        // Queue the skill content as a non-waking next-step context message,
        // exactly like dsh-tool-skill's invocation injection.
        const message = {
          id: `skill-load-${skillName}-${randomUUID()}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'skill-invocation', name: skillName, form: 'instructions' },
        }
        const queued = agent.inbox?.nextStep?.findLast(item =>
          item.id?.startsWith('skill-load-') && item.source?.kind === 'skill-invocation' &&
          item.source.form === 'instructions' && item.source.name === skillName)
        const replaced = queued && typeof agent.inbox.replace === 'function' && agent.inbox.replace(queued.id, message)
        if (!replaced) agent.inject(message)
        return { text: `Skill "${skillName}" loaded; use the applicable workflow and continue the original task.` }
      } catch (error) {
        // Preserve native error/cancellation classification and the original cause.
        throw error
      }
    },
  })
}

/** Extract the model-facing body of a loaded skill definition. */
function extractSkillBody(skill) {
  return typeof skill?.content === 'string' ? skill.content : ''
}
