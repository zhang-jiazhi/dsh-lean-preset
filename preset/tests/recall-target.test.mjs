/**
 * 20260930-recall — enforce the recall target that motivated the change.
 *
 * The model wastes a whole turn whenever dev_tool_search comes back empty
 * ("No search results for ...") or merely says "No tools match: <guess>" with
 * nothing settled. This file pins the measured success rate so a future edit
 * cannot quietly regress it.
 *
 * Baseline (same corpus, module before the fix, old resolver) vs now:
 *   query path  : 8/33 zero-result  → 0/33
 *   unlock path : 4/10 same-call    → 9/10
 * The one remaining unlock case (mcp__github__get_issue) is deliberately NOT
 * auto-resolved: inside a real GitHub family a single shared generic word
 * ("issue") cannot distinguish issue_read from issue_write, and guessing there
 * is worse than a suggestion round.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as discovery } from '../dev-tool-search.mjs'

// Real tool names with descriptions close enough to the live catalog for the
// matcher to behave the same way (the matcher only reads name + description).
const CATALOG = [
  ['web_search', 'Search the web for current information. Returns an optional summary answer and a list of sources. Use for real-time facts and news.'],
  ['web_fetch', 'Fetch the text content of one specific URL. Use when you already have a link and need its full text.'],
  ['tavily_search', '用 Tavily 检索实时网页与新闻。适合：时效性事实、新闻事件、产品与公司动态、通用事实核查。'],
  ['anysearch_search', '用 AnySearch 检索。把查询路由到垂类数据源：股票行情、财报与估值、学术论文、法律条文、专利、CVE。'],
  ['exa_search', '用 Exa 做语义检索：输入一句理想页面的自然语言描述。适合找综述、对比文章、访谈、同类项目、数据集。'],
  ['memory_save', 'Persist one memory entry for future sessions.'],
  ['memory_search', 'Search the cross-session memory store for past context.'],
  ['memory_get', 'Read one memory entry by id.'],
  ['skill_search', '按关键词搜技能；命中后用 skill_load 加载单个技能全文。'],
  ['rule_search', '按关键词搜 DSH 全局规则章节（红线/证据/输出/记录/编码/排障）。'],
  ['create_goal', '创建一个长期目标并持续追踪。'],
  ['job_list', '列出后台任务；job_output 取输出，job_kill 终止。'],
  ['batch', '程序化批量编排：写一段程序在内部循环调用工具。'],
  ['dev_inject_plugin', '运行时注入任意本地 DSH 插件包。'],
  ['subagent_fork', '派生继承父会话上下文的子代理。'],
  ['browser_snapshot', 'Observe the visible browser and return its accessibility tree.'],
  ['browser_screenshot', 'Capture the sidebar page as a JPEG image.'],
  ['translate_page', '抓取一个网页并按段落做双语翻译，返回原文 + 译文对照。'],
  ['search_history', '跨会话检索历史会话的原文，可按工作区与时间过滤。'],
  ['mcp__github__issue_read', 'Get an issue from GitHub by number, with body and comments.'],
  ['mcp__github__list_issues', 'List issues in a GitHub repository.'],
  ['mcp__playwright-mcp__browser_navigate', 'Navigate the browser to a URL and return an accessibility snapshot.'],
].map(([name, description]) => ({ name, description }))

const tool = () => {
  let registered
  discovery({ tools: { register: (value) => { registered = value }, schemas: () => CATALOG } })
  return registered
}

const rowNames = (text) => [...text.matchAll(/^- ([A-Za-z0-9_*-]+):/gm)].map((match) => match[1])

// [query, the tool a model would actually want]
const QUERIES = [
  ['网页搜索', 'web_search'], ['搜索', 'web_search'], ['联网检索', 'tavily_search'],
  ['联网搜索新闻', 'tavily_search'], ['抓取网页正文', 'web_fetch'], ['读网页', 'web_fetch'],
  ['语义检索', 'exa_search'], ['找文章对比', 'exa_search'], ['记忆', 'memory_save'],
  ['跨会话记忆', 'memory_search'], ['技能', 'skill_search'], ['规则', 'rule_search'],
  ['目标', 'create_goal'], ['后台任务', 'job_list'], ['批量', 'batch'],
  ['插件注入', 'dev_inject_plugin'], ['子代理', 'subagent_fork'], ['浏览器', 'browser_snapshot'],
  ['截图', 'browser_screenshot'], ['web search', 'web_search'],
  ['web search fetch 网页 搜索', 'web_search'], ['search the web for news', 'web_search'],
  ['tavily anysearch exa', 'tavily_search'], ['github issue', 'mcp__github__'],
  ['playwright browser', 'mcp__playwright-mcp__'], ['memory save', 'memory_save'],
  ['skill search load', 'skill_search'], ['translate page', 'translate_page'],
  ['search history', 'search_history'], ['联网 检索 新闻 实时', 'tavily_search'],
  ['垂类 行情 财报', 'anysearch_search'], ['CVE 漏洞', 'anysearch_search'],
  ['读外文文档 翻译', 'translate_page'],
]

const UNLOCKS = ['exa_search', 'web_search', 'websearch', 'search_web', 'memory_serach', 'tavily', 'exa', 'mcp__github__*', 'skill_*', 'mcp__github__get_issue']

test('keyword search never comes back empty', async () => {
  const search = tool()
  const empty = []
  for (const [query] of QUERIES) {
    const { text } = await search.execute({ query, limit: 10 }, {})
    if (/No search results for|No usable search tokens/.test(text)) empty.push(query)
  }
  assert.deepEqual(empty, [], `these queries still return nothing: ${empty.join(', ')}`)
})

test('keyword search puts the wanted tool in the first page for most realistic phrasings', async () => {
  const search = tool()
  let matched = 0
  for (const [query, want] of QUERIES) {
    const { text } = await search.execute({ query, limit: 10 }, {})
    const names = rowNames(text)
    if (names.some((name) => (want.endsWith('__') ? name.startsWith(want) : name === want))) matched += 1
  }
  // 33 queries; the misses are cases where a sibling tool is an equally good
  // answer ("web search" for 联网检索, translate_page for 读网页).
  assert.ok(matched >= 26, `only ${matched}/${QUERIES.length} queries found the wanted tool`)
})

test('every unlock guess is either resolved in the same call or gets an actionable correction', async () => {
  const search = tool()
  let resolved = 0
  const dead = []
  for (const name of UNLOCKS) {
    const { text } = await search.execute({ toolNames: [name] }, {})
    if (/Unlocked for the next request:/.test(text)) resolved += 1
    else if (!/closest to|family exists|no .* tools are in the catalog/.test(text)) dead.push(name)
  }
  assert.deepEqual(dead, [], `no actionable path for: ${dead.join(', ')}`)
  assert.ok(resolved >= 9, `only ${resolved}/${UNLOCKS.length} unlocks settled in the same call`)
})

test('an unambiguous near-miss is announced, never silently substituted', async () => {
  const search = tool()
  const { text } = await search.execute({ toolNames: ['memory_serach'] }, {})
  assert.match(text, /Unlocked for the next request: memory_search/)
  assert.match(text, /Auto-resolved memory_serach → memory_search/)
})
