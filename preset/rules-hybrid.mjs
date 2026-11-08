/** Core rules before the first request; versioned topic rules on demand. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { isFailedCompaction, ownSessionEvents } from './compaction-epoch.mjs?release=20260924-failed-compaction'

export const name = 'lean-rules'
export const inject = ['tools']
const MAX_SOURCE_BYTES = 1024 * 1024
const MAX_MESSAGE_BYTES = 65536
const MAX_LOAD_SECTIONS = 3
// A `notice` summary is the collapsed row's one-line account, documented as a
// short string (`CONTEXT_SUMMARY_MAX_CHARS` = 120). Version data therefore lives
// in its own `rules` field instead: a JSON payload in `summary` is rendered
// verbatim in the transcript, which is what a reader was actually seeing.
// Measured 2026-09-13: the host persisted that 249-char payload unmodified, so
// this is a presentation fix, not a correctness one.
const NOTICE_SUMMARY = {
  core: '已注入核心规则与专项目录',
  topics: '已更新已加载的专项规则',
  error: '全局规则读取失败',
}
const digest = text => createHash('sha256').update(text).digest('hex')
const heading = section => `## ${section.number}. ${section.title}\n\n${section.body}`

/** Parse stable numbered sections; a leading applicability line is catalog metadata. */
export function parseRules(text) {
  const sections = []
  const numbers = new Set()
  let current
  let fence
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      current?.lines.push(line)
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
      continue
    }
    if (marker) {
      fence = marker[1]
      current?.lines.push(line)
      continue
    }
    const match = /^##\s+(\d+)\.\s+(.+)$/.exec(line)
    if (match) {
      const number = Number(match[1])
      if (!Number.isSafeInteger(number) || numbers.has(number)) throw new Error(`Invalid or duplicate rule section: ${match[1]}`)
      numbers.add(number)
      current = { number, title: match[2].trim(), lines: [] }
      sections.push(current)
    } else current?.lines.push(line)
  }
  return sections.map(({ lines, ...section }) => {
    const first = lines.findIndex(line => line.trim())
    const metadata = first < 0 ? null : /^>\s*适用[：:]\s*(.+)$/.exec(lines[first])
    const trigger = metadata?.[1].trim() ?? ''
    if (metadata) lines.splice(first, 1)
    const body = lines.join('\n').trim()
    if (!body) throw new Error(`Empty rule section: ${section.number}`)
    const value = { ...section, body, trigger }
    return { ...value, digest: digest(heading(value)), firstLine: body.split('\n')[0].replace(/^[-*]\s*/, '').slice(0, 100) }
  })
}

const ALIASES = [
  ['核心', 'core'], ['红线', 'red line'], ['证据', 'evidence'],
  ['输出', 'output'], ['记录', 'record notes session'], ['编码', 'coding code'],
  ['排障', 'debug troubleshooting'], ['本机', 'machine local'], ['第三方', 'third party'],
  ['规则', 'rule'], ['目录', 'index'], ['修改', 'change edit'], ['验证', 'verify'],
  ['恢复', 'resume recover'], ['直接执行', 'execute'], ['会话', 'session'],
]
const aliasTerms = ALIASES.map(([term]) => term).sort((a, b) => b.length - a.length)

/** Preserve AND matching, including joined Chinese topic names. */
function queryGroups(query) {
  const tokens = []
  for (let rest of query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)) {
    while (rest) {
      const hit = aliasTerms.map(term => [term, rest.indexOf(term)])
        .filter(([, at]) => at >= 0).sort((a, b) => a[1] - b[1] || b[0].length - a[0].length)[0]
      if (!hit) { tokens.push(rest); break }
      if (hit[1] > 0) tokens.push(rest.slice(0, hit[1]))
      tokens.push(hit[0])
      rest = rest.slice(hit[1] + hit[0].length)
    }
  }
  return tokens.map(token => {
    const alias = ALIASES.find(([term, words]) => term === token || words.split(' ').includes(token))
    return alias ? [alias[0], ...alias[1].split(' ')] : [token]
  })
}

/** Version payloads written before the split; a truncated one simply fails to parse. */
function legacyReceipt(summary) {
  if (typeof summary !== 'string' || !summary.startsWith('{')) return
  try { const value = JSON.parse(summary); return value?.version === 1 ? value : undefined } catch { return }
}

/** Only this plugin's versioned, path-scoped receipts establish loaded state. */
function receipt(source, file) {
  // Producer-owned kind (v4). The wrapper form is rewritten to this by the
  // V3→V4 migration, so persisted receipts from older sessions still match.
  if (source?.kind !== `plugin:${name}` || source.form !== 'notice') return
  const value = source.rules ?? legacyReceipt(source.summary)
  if (!value || value.version !== 1 || value.path !== file) return
  if (!['core', 'topics', 'error'].includes(value.kind)) return
  if (!/^[a-f0-9]{64}$/.test(value.revision) || !Array.isArray(value.entries)) return
  if (!value.entries.every(entry => Number.isSafeInteger(entry?.number) && entry.number >= 0 &&
    (entry.digest === null || (typeof entry.digest === 'string' && /^[a-f0-9]{64}$/.test(entry.digest))))) return
  return value
}

function accept(state, message, file) {
  const value = receipt(message?.source, file)
  if (!value) return
  if (value.kind === 'error') { state.error = value.revision; return }
  if (value.kind === 'core') { state.core = value.revision; state.error = null }
  for (const entry of value.entries) {
    if (entry.digest === null) state.versions.delete(entry.number)
    else state.versions.set(entry.number, entry.digest)
  }
}

function observe(state, event, file) {
  if (event.type === 'compaction/end') {
    // Only a real checkpoint dropped the transcript, so only a real checkpoint
    // re-arms the once-per-session core injection. A failed compaction (no
    // `compaction/summary`) leaves the same conversation in place; clearing
    // here re-sent the whole core block on the next step. Measured over the
    // real sessions: 41 such re-sends beyond the `1 + successful compactions`
    // expectation (1,306 chars each, ~330 tokens).
    if (isFailedCompaction(event)) return
    state.core = null
    state.error = null
    state.versions.clear()
  } else if (event.type === 'user/message') accept(state, event.data, file)
}

function message(file, kind, text, entries = [], revision = digest(text)) {
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error('Rule message exceeds 65536 bytes; shorten the selected rules')
  return {
    id: `${name}-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: `plugin:${name}`,
      form: 'notice',
      summary: NOTICE_SUMMARY[kind],
      rules: { version: 1, path: file, kind, revision, entries },
    },
  }
}

/** Preserve project-rule discovery without describing rules as optional environment notes. */
async function projectReferences(ctx, session, state, signal) {
  const fs = ctx.get?.('fs')
  const cwd = session.header?.cwd ?? process.cwd()
  if (state.project && state.project.fs === fs && state.project.cwd === cwd) return state.project.paths
  const paths = []
  if (fs) {
    const p = cwd.includes('\\') ? path.win32 : path.posix
    const info = async (dir, base) => fs.stat(await fs.resolve(p.join(dir, base), { cwd: dir, signal }), signal)
    const probe = async (dir, base) => {
      try { return await info(dir, base) } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
        throw error
      }
    }
    try {
      let root = cwd
      for (let dir = cwd; ; dir = p.dirname(dir)) {
        let found = false
        for (const marker of ['.git', '.hg', '.svn']) if (await probe(dir, marker)) { found = true; break }
        if (found) { root = dir; break }
        if (p.dirname(dir) === dir) break
      }
      const chain = []
      for (let dir = cwd; ; dir = p.dirname(dir)) {
        chain.unshift(dir)
        if (dir === root || p.dirname(dir) === dir) break
      }
      for (const dir of chain) for (const candidate of ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']) {
        if ((await probe(dir, candidate))?.type === 'file') paths.push(p.join(dir, candidate))
      }
    } catch (error) {
      if (signal?.aborted) throw error
      ctx.logger?.warn?.(`${name}: project instruction discovery: ${error.message}`)
    }
  }
  state.project = { fs, cwd, paths }
  return paths
}

/** Mount one rule source; durable messages, not attempted injections, confirm visibility. */
export function apply(ctx, config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('rules config must be an object')
  if (config.rulesFile !== undefined && (typeof config.rulesFile !== 'string' || !path.isAbsolute(config.rulesFile))) throw new TypeError('rulesFile must be an absolute path')
  const file = path.resolve(config.rulesFile ?? path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'AGENTS.md'))
  const states = new WeakMap()
  const stateFor = session => {
    let state = states.get(session)
    if (!state) {
      state = { core: null, error: null, versions: new Map(), project: null }
      for (const event of ownSessionEvents(session)) observe(state, event, file)
      states.set(session, state)
    }
    return state
  }
  const effective = (session, incoming = []) => {
    const original = stateFor(session)
    const state = { ...original, versions: new Map(original.versions) }
    for (const item of incoming) accept(state, item, file)
    return state
  }
  const load = async () => {
    const bytes = await readFile(file)
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Rules source exceeds 1 MiB')
    return parseRules(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  }
  const list = sections => sections.map(section =>
    `- ${section.number} ${section.title}${section.number === 0 ? ' [自动]' : ''}: ${section.trigger || section.firstLine}`).join('\n')

  ctx.on('session/event', (session, event) => {
    const state = states.get(session)
    if (state) observe(state, event, file)
  })
  ctx.on('session/disposed', session => { if (session) states.delete(session) })

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || !agent?.session || signal?.aborted) return decision
    const session = agent.session
    const state = effective(session, decision.messages ?? [])
    try {
      const added = []
      // Core is injected once per session and once more after compaction; it is
      // deliberately NOT refreshed on content change, so a mid-session edit to
      // AGENTS.md never re-sends the whole block. Only tracking that still
      // matters is what justifies reading the file again.
      const tracked = [...state.versions.keys()].filter(number => number !== 0)
      const needsCore = state.core === null || state.error !== null
      if (needsCore || tracked.length > 0) {
        const sections = await load()
        const core = sections.find(section => section.number === 0)
        if (!core) throw new Error('Missing core section: ## 0. 核心')
        signal?.throwIfAborted()
        if (needsCore) {
          const refs = (await projectReferences(ctx, session, stateFor(session), signal)).filter(ref => path.resolve(ref) !== file)
          signal?.throwIfAborted()
          const topics = sections.filter(section => section.number !== 0)
          const text = [
            `用户全局核心规则，来源：${file}。本消息给出本次会话的核心规则与专项目录。`,
            heading(core),
            '专项按需目录（仅列适用范围，正文尚未加载）：',
            topics.map(section => `- ${section.number}. ${section.title}${section.trigger ? `：${section.trigger}` : ''}`).join('\n') || '无专项章节。',
            '按任务直接调用 rule_load({"sections":["编号"]})，每次最多三章；无需先搜索或读取全文，未变的已加载章节直接复用。',
            ...(refs.length ? ['项目规则文件（按适用目录读取，更具体的约定优先）：', ...refs.map(ref => `- ${ref}`)] : []),
          ].join('\n\n')
          added.push(message(file, 'core', text, [{ number: 0, digest: core.digest }], digest(text)))
        }
        const updates = []
        const entries = []
        for (const number of tracked) {
          const section = sections.find(value => value.number === number)
          if (section?.digest === state.versions.get(number)) continue
          entries.push({ number, digest: section?.digest ?? null })
          updates.push(section ? heading(section) : `第 ${number} 章已从该规则文件移除，其先前内容不再适用。`)
        }
        if (updates.length) added.push(message(file, 'topics', `已加载的专项规则已更新，以下内容替代同编号的旧版本（${file}）：\n\n${updates.join('\n\n')}`, entries))
      }
      return added.length ? { ...decision, messages: [...decision.messages, ...added] } : decision
    } catch (error) {
      if (signal?.aborted) throw error
      const text = `全局规则读取异常（${file}）：${error.message}。本轮未确认磁盘规则已同步；恢复文件后会重新核对。`
      if (state.error === digest(text)) return decision
      ctx.logger?.warn?.(`${name}: ${error.message}`)
      return { ...decision, messages: [...decision.messages, message(file, 'error', text)] }
    }
  }, { prepend: true })

  const output = { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }, render: (_args, value) => [{ type: 'text', text: value.text }] }
  ctx.tools.register({
    name: 'rule_search',
    description: 'Search global rules by topic or keyword: 核心/红线/证据/输出/记录/编码/排障/本机/第三方, coding/debug/record. Returns an index, not full bodies. The core and topic index arrive automatically; use rule_load directly when a topic number is known.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Optional keywords; empty lists all sections.' } }, required: [], additionalProperties: false },
    output,
    async execute(args) {
      try {
        const sections = await load()
        if (!sections.length) return { text: `rule_search unavailable: no sections in ${file}.` }
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        const groups = queryGroups(query)
        const matches = sections.filter(section => {
          const haystack = `${section.title} ${section.trigger} ${section.body}`.toLowerCase()
          return groups.every(group => group.some(term => haystack.includes(term)))
        })
        const result = !query ? `Rule sections (${sections.length}) in ${file}:\n${list(sections)}`
          : matches.length ? `Matching rule sections (${matches.length}):\n${list(matches.slice(0, 30))}`
            : `No rule sections match "${query}".\nRule sections (${sections.length}):\n${list(sections)}`
        return { text: `${result}\nLoad topics with rule_load({"sections":["<number or title>"]}); section 0 is automatic.` }
      } catch (error) { return { text: `rule_search unavailable: ${error.message}` } }
    },
  })

  ctx.tools.register({
    name: 'rule_load',
    description: 'Load up to three task-relevant global rule sections by number or title. Core section 0 is automatic; pass refreshCore:true to re-inject it after editing the rules file. Unchanged delivered or pending versions are reused; changed content can reload. Rules remain below system, developer, direct user instructions and more-specific project rules.',
    parameters: {
      type: 'object',
      properties: {
        sections: { type: 'array', items: { type: 'string' }, description: 'Topic numbers or titles from the automatic index.' },
        refreshCore: { type: 'boolean', description: 'Re-inject core section 0 for the next request even if it was already delivered. Use after editing the rules file; it is a one-shot explicit refresh, not a per-step resend.' },
      },
      required: ['sections'],
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      const agent = exec?.agent
      if (!agent?.session || !agent.inbox) return { text: 'rule_load requires an agent context.' }
      const refreshCore = args.refreshCore === true
      const wanted = Array.isArray(args.sections) ? args.sections.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : []
      if (!wanted.length) return { text: 'rule_load requires sections (numbers or title keywords).' }
      try {
        const sections = await load()
        const selected = []
        const unmatched = []
        for (const item of wanted) {
          const hit = /^\d+$/.test(item) ? sections.find(section => section.number === Number(item))
            : sections.find(section => section.title.includes(item) || item.includes(section.title))
          if (!hit) unmatched.push(item)
          else if (!selected.includes(hit)) selected.push(hit)
        }
        const state = effective(agent.session, agent.inbox.nextStep ?? [])
        const core = selected.filter(section => section.number === 0)
        const topics = selected.filter(section => section.number !== 0)
        const pending = topics.filter(section => state.versions.get(section.number) !== section.digest)
        const skipped = topics.filter(section => state.versions.get(section.number) === section.digest)
        const loading = pending.slice(0, MAX_LOAD_SECTIONS)
        if (loading.length) {
          const text = `专项规则，来源：${file}；同编号内容替代先前版本。\n\n${loading.map(heading).join('\n\n')}`
          agent.inbox.append('next-step', message(file, 'topics', text, loading.map(section => ({ number: section.number, digest: section.digest }))))
        }
        const lines = []
        if (loading.length) lines.push(`Loaded for the next request: ${loading.map(section => section.title).join(', ')}.`)
        if (skipped.length) lines.push(`Already loaded unchanged (delivered or pending): ${skipped.map(section => section.title).join(', ')}.`)
        if (core.length && refreshCore) {
          // Explicit, one-shot refresh: the core block is NOT re-sent every
          // step, but a user/agent can ask for the current file content after an
          // edit without waiting for a new session or a compaction.
          const text = [
            `全局核心规则已按显式请求刷新，来源：${file}；本节替代本会话先前注入的核心块。`,
            heading(core[0]),
          ].join('\n\n')
          agent.inbox.append('next-step', message(file, 'core', text, [{ number: 0, digest: core[0].digest }], digest(text)))
          lines.push('Core section 0 was re-injected for the next request.')
        } else if (core.length) {
          lines.push('Core section 0 is loaded automatically; pass refreshCore:true to re-inject it after an edit.')
        }
        if (pending.length > MAX_LOAD_SECTIONS) lines.push(`Exceeds the ${MAX_LOAD_SECTIONS}-section limit, not loaded: ${pending.slice(MAX_LOAD_SECTIONS).map(section => section.title).join(', ')}.`)
        if (unmatched.length) lines.push(`No rule section matches: ${unmatched.join(', ')}.`)
        return { text: lines.join('\n') || 'Nothing to load.' }
      } catch (error) { return { text: `rule_load failed: ${error.message}` } }
    },
  })
}
