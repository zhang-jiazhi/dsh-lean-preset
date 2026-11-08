import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as gateway } from '../tool-gateway.mjs'
import { markGatewayEligible } from '../gateway-policy.mjs?release=20261106-fixes'

const fixture = () => {
  let tool
  const executed = []
  const definitions = new Map([
    ['hidden_read', {
      name: 'hidden_read',
      description: 'Read a hidden resource.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({ ok: true }),
    }],
    ['hidden_image', {
      name: 'hidden_image',
      description: 'Return a hidden image.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({ ok: true }),
    }],
    ['hidden_context', {
      name: 'hidden_context',
      description: 'Return injected context and conclude the turn.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({ ok: true }),
    }],
    ['skill_search', {
      name: 'skill_search',
      description: 'Search lean skills on demand.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({ ok: true }),
    }],
    ['skill_load', {
      name: 'skill_load',
      description: 'Load a lean skill on demand.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({ ok: true }),
    }],
  ])
  for (const definition of definitions.values()) markGatewayEligible(definition)
  const tools = {
    register(value) { tool = value },
    view() { return { visible: definitions } },
    async execute(input) {
      executed.push(input)
      const name = input.calls[0]?.name
      const image = name === 'hidden_image'
      return {
        results: [{
          result: {
            content: image
              ? [{ type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', width: 1, height: 1 } }]
              : [{ type: 'text', text: 'hidden result' }],
            value: { ok: true },
          },
        }],
        ...(name === 'hidden_context'
          ? { additionalContexts: [{ role: 'user', content: [{ type: 'text', text: 'injected' }] }], concluded: true }
          : {}),
      }
    },
  }
  gateway({ tools })
  return { tool, tools, definitions, executed }
}

test('gateway exposes a fixed schema and lists hidden tools', async () => {
  const f = fixture()
  assert.equal(f.tool.name, 'tool_gateway')
  assert.deepEqual(f.tool.parameters.properties.action.enum, ['search', 'describe', 'call', 'list'])
  // Search-first stays the absolute rule for unknown families; nothing in the
  // schema may advertise skipping it (user requirement, see handoff §4.6).
  assert.match(f.tool.description, /ALWAYS SEARCH FIRST: call action="search" with a short family\/keyword query before doing anything else/)
  assert.doesNotMatch(f.tool.description, /Exact name already known/)
  assert.doesNotMatch(f.tool.description, /no search needed/)
  assert.match(f.tool.parameters.properties.action.description, /^Discovery first: search\./)
  // The negative list must run ahead of the family index, or the model keeps
  // searching families the gateway can never serve.
  assert.match(f.tool.description, /NOT gateway tools/)
  assert.match(f.tool.description, /list_agents\/send_message\/spawn_teammate/)
  // Routing matches the live catalog: workflow/goal/job families live behind
  // the gateway; subagent is resident at top level and gateway-reachable in a
  // child. The old text claimed the opposite and sent the model to a dead end.
  assert.doesNotMatch(f.tool.description, /subagent\/workflow; goal\/job/)
  assert.match(f.tool.description, /workflow_\*; goal tools .*jobs \(job_list\/job_output\/job_kill\)/)
  assert.match(f.tool.description, /`subagent` is resident at top level, `subagent_fork` is gateway-only there, and both are gateway-reachable from a delegation child/)
  assert.ok(f.tool.description.indexOf('NOT gateway tools') < f.tool.description.indexOf('Family index'))
  assert.match(f.tool.description, /Family index/)
  assert.match(f.tool.description, /playwright/)
  assert.match((await f.tool.execute({ action: 'list' }, { agent: {} })).text, /hidden_read/)
  assert.match((await f.tool.execute({ action: 'search', query: 'hidden' }, { agent: {} })).text, /hidden_read/)
  assert.match((await f.tool.execute({ action: 'search', query: 'hidden read' }, { agent: {} })).text, /hidden_read/)
})

test('a search for directly visible tools names them instead of dead-ending', async () => {
  const f = fixture()
  const resident = name => ({
    name,
    description: `Resident ${name}.`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({}),
  })
  f.tools.view = () => ({
    visible: new Map([...f.definitions,
      ['bash', resident('bash')],
      ['list_agents', resident('list_agents')],
      ['team_task_list', resident('team_task_list')],
    ]),
  })
  const hit = await f.tool.execute({ action: 'search', query: 'list_agents team members' }, { agent: {} })
  assert.match(hit.text, /No gateway-eligible tools match/)
  assert.match(hit.text, /list_agents/)
  assert.match(hit.text, /team_task_list/)
  assert.match(hit.text, /Team tools are listed only when/)
  assert.doesNotMatch(hit.text, /already visible in your tool list/)
  assert.doesNotMatch(hit.text, /Try list/)
  assert.doesNotMatch(hit.text, /hidden_read/)

  const miss = await f.tool.execute({ action: 'search', query: 'quux_zzz' }, { agent: {} })
  assert.equal(miss.text, 'No gateway-eligible tools match "quux_zzz". Try list.')
})

test('searching absent Team wait tools explains ordinary result delivery without inventing visibility', async () => {
  const f = fixture()
  const delegate = { name: 'hidden_delegate', description: 'Child reports results with send_message.' }
  f.definitions.set(delegate.name, delegate)
  markGatewayEligible(delegate)
  for (const name of ['wait_agent', 'send_message']) {
    const hit = await f.tool.execute({ action: 'search', query: name }, { agent: {} })
    assert.match(hit.text, /Team tool/)
    assert.match(hit.text, /end your turn/)
    assert.match(hit.text, /subagent id as a job id/)
    assert.doesNotMatch(hit.text, /already visible|Try list/)
    assert.doesNotMatch(hit.text, /hidden_delegate/)
  }
})

test('observed ordinary waiting phrases recover without recommending polling tools', async () => {
  const f = fixture()
  for (const query of ['wait agent', 'wait_agent send_message', 'subagent wait result status']) {
    const hit = await f.tool.execute({ action: 'search', query }, { agent: {} })
    assert.match(hit.text, /end your turn/)
    assert.match(hit.text, /subagent id as a job id/)
    assert.doesNotMatch(hit.text, /Try list/)
  }
})

test('a real named wait capability is not hidden by ordinary waiting recovery', async () => {
  const f = fixture()
  const definition = { name: 'subagent_wait_result_status', description: 'An optional explicit status capability.' }
  f.definitions.set(definition.name, definition)
  markGatewayEligible(definition)
  const hit = await f.tool.execute({ action: 'search', query: 'subagent wait result status' }, { agent: {} })
  assert.match(hit.text, /subagent_wait_result_status/)
  assert.doesNotMatch(hit.text, /end your turn/)
})

test('mixed resident and gated Team searches keep the two routing claims separate', async () => {
  const f = fixture()
  f.definitions.set('bash', { name: 'bash', description: 'Run commands.' })
  const hit = await f.tool.execute({ action: 'search', query: 'bash, wait_agent' }, { agent: {} })
  assert.match(hit.text, /bash is already visible/)
  assert.match(hit.text, /"wait_agent" is a Team tool/)
  assert.doesNotMatch(hit.text, /wait_agent (?:is|are) already visible/)
})

test('call delegates through tools.execute with a private tool set', async () => {
  const f = fixture()
  const agent = { id: 'a' }
  const result = await f.tool.execute({ action: 'call', name: 'hidden_read', input: { path: 'x' } }, { agent, signal: new AbortController().signal })
  assert.equal(result.text, 'hidden result')
  assert.equal(f.executed.length, 1)
  assert.equal(f.executed[0].calls[0].name, 'hidden_read')
  assert.deepEqual(f.executed[0].calls[0].arguments, '{"path":"x"}')
  assert.equal(f.executed[0].agent, agent)
  assert.deepEqual([...f.executed[0].toolSet.view(agent).keys()], [...f.definitions.keys()])
  assert.equal(f.executed[0].toolSet.view({ id: 'other' }).size, 0)
})

test('one incidental phrase match does not hide real name matches', async () => {
  const f = fixture()
  const add = (name, description) => {
    const definition = {
      name,
      description,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({}),
    }
    f.definitions.set(name, definition)
    markGatewayEligible(definition)
  }
  add('deepseek_fetch', 'Fetch one page as markdown; 与搜索类分工：先用 tavily_search / exa_search 找到 URL。web search helper.')
  add('tavily_search', 'Search the web through Tavily.')
  const result = await f.tool.execute({ action: 'search', query: 'web search' }, { agent: {} })
  // The description-only match stays, and the name matches are not dropped.
  assert.match(result.text, /deepseek_fetch/)
  assert.match(result.text, /tavily_search/)
})

test('unknown names and self-calls fail without executing', async () => {
  const f = fixture()
  await assert.rejects(f.tool.execute({ action: 'call', name: 'missing' }, { agent: {} }), /Unknown tool/)
  await assert.rejects(f.tool.execute({ action: 'call', name: 'tool_gateway' }, { agent: {} }), /cannot call itself/)
  assert.equal(f.executed.length, 0)
})


test('describe returns the hidden tool parameter schema on demand', async () => {
  const f = fixture()
  const result = await f.tool.execute({ action: 'describe', name: 'hidden_read' }, { agent: {} })
  assert.match(result.text, /"name": "hidden_read"/)
  assert.match(result.text, /"parameters"/)
  // The name describe returned is callable as-is; the schema text stays silent
  // about whether a search has to precede it.
  const called = await f.tool.execute({ action: 'call', name: 'hidden_read', input: {} }, { agent: {}, signal: new AbortController().signal })
  assert.equal(called.text, 'hidden result')
  assert.equal(f.executed.length, 1)
})

test('additional contexts and concluded are forwarded to the outer tool execution', async () => {
  const f = fixture()
  const contexts = []
  let concluded = false
  const result = await f.tool.execute(
    { action: 'call', name: 'hidden_context', input: {} },
    { agent: {}, signal: new AbortController().signal, deferContext: context => contexts.push(context), concludeTurn: () => { concluded = true } },
  )
  assert.equal(result.text, 'hidden result')
  assert.equal(contexts.length, 1)
  assert.equal(concluded, true)
})

test('gateway errors preserve the inner failure message', async () => {
  const f = fixture()
  const original = f.tools.execute
  f.tools.execute = async () => ({ results: [{ result: { isError: true, error: { message: 'denied' }, content: [{ type: 'text', text: 'raw' }] } }] })
  try {
    await assert.rejects(
      f.tool.execute({ action: 'call', name: 'hidden_read', input: {} }, { agent: {}, signal: new AbortController().signal }),
      /denied/,
    )
  } finally {
    f.tools.execute = original
  }
})



test('unmarked and conditional tools are not exposed or callable', async () => {
  const f = fixture()
  const unmarked = { name: 'unmarked', description: 'not marked', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) }
  const conditional = { name: 'conditional', description: 'has when', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) }
  markGatewayEligible(conditional, () => true)
  f.tools.view = () => ({ visible: new Map([...f.definitions, ['unmarked', unmarked], ['conditional', conditional]]) })
  assert.doesNotMatch((await f.tool.execute({ action: 'list' }, { agent: {} })).text, /unmarked|conditional/)
  await assert.rejects(f.tool.execute({ action: 'call', name: 'unmarked' }, { agent: {} }), /not gateway-eligible/)
  // A conditional tool is not merely unknown: say why the gateway cannot serve it.
  await assert.rejects(f.tool.execute({ action: 'call', name: 'conditional' }, { agent: {} }), /conditionally registered/)
  await assert.rejects(f.tool.execute({ action: 'describe', name: 'conditional' }, { agent: {} }), /conditionally registered/)
  const search = await f.tool.execute({ action: 'search', query: 'conditional' }, { agent: {} })
  assert.match(search.text, /conditionally registered and cannot be called through the gateway/)
})

test('lean skill tools are gateway-reachable despite not being resident', async () => {
  const f = fixture()
  const list = await f.tool.execute({ action: 'list' }, { agent: {} })
  assert.match(list.text, /skill_search/)
  assert.match(list.text, /skill_load/)
  const search = await f.tool.execute({ action: 'search', query: 'skill' }, { agent: {} })
  assert.match(search.text, /skill_search|skill_load/)
  const result = await f.tool.execute({ action: 'call', name: 'skill_load', input: { name: 'x' } }, { agent: {}, signal: new AbortController().signal })
  assert.equal(result.text, 'hidden result')
  assert.equal(f.executed.at(-1).calls[0].name, 'skill_load')
})

test('image content is passed through instead of flattened to text', async () => {
  const f = fixture()
  const image = { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', width: 1, height: 1 } }
  const result = await f.tool.execute({ action: 'call', name: 'hidden_image', input: {} }, { agent: {}, signal: new AbortController().signal })
  assert.deepEqual(result.content, [image])
  assert.deepEqual(f.tool.output.render({ action: 'call' }, result), [image])
})

test('search prefers phrase precision and comma-separated alternatives', async () => {
  const definitions = new Map()
  for (const [name, description] of [
    ['terminal_list', 'List persistent terminal sessions.'],
    ['memory_list', 'List memory entries.'],
    ['memory_get', 'Fetch an entry. Use memory_list before reading by ID.'],
    ['list_mcp_resources', 'List resources from an MCP server.'],
  ]) {
    const definition = {
      name,
      description,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({}),
    }
    markGatewayEligible(definition)
    definitions.set(name, definition)
  }
  let tool
  gateway({ tools: { register(value) { tool = value }, view() { return { visible: definitions } } } })

  const phrase = await tool.execute({ action: 'search', query: 'terminal list' }, { agent: {} })
  assert.match(phrase.text, /terminal_list/)
  assert.doesNotMatch(phrase.text, /memory_list|list_mcp_resources/)

  const alternatives = await tool.execute({ action: 'search', query: 'terminal_list, memory_list' }, { agent: {} })
  assert.match(alternatives.text, /terminal_list/)
  assert.match(alternatives.text, /memory_list/)
  assert.doesNotMatch(alternatives.text, /memory_get|list_mcp_resources/)
})
test('multi-name queries fall back to OR matching', async () => {
  const f = fixture()
  const bySpace = await f.tool.execute({ action: 'search', query: 'hidden_read hidden_image' }, { agent: {} })
  assert.doesNotMatch(bySpace.text, /No gateway-eligible tools match/)
  assert.match(bySpace.text, /^- hidden_read: /m)
  assert.match(bySpace.text, /^- hidden_image: /m)
  const byComma = await f.tool.execute({ action: 'search', query: 'hidden_read,hidden_image' }, { agent: {} })
  assert.doesNotMatch(byComma.text, /No gateway-eligible tools match/)
  assert.match(byComma.text, /^- hidden_read: /m)
  assert.match(byComma.text, /^- hidden_image: /m)
})

test('unknown names suggest the closest registered tools', async () => {
  const f = fixture()
  await assert.rejects(f.tool.execute({ action: 'call', name: 'hidden_reads' }, { agent: {} }), /Closest names: hidden_read/)
})

test('a double-encoded JSON string input is parsed instead of wasting a round', async () => {
  const f = fixture()
  await f.tool.execute({ action: 'call', name: 'hidden_read', input: '{"path":"x"}' }, { agent: {} })
  assert.deepEqual(JSON.parse(f.executed[0].calls[0].arguments), { path: 'x' })
  await f.tool.execute({ action: 'call', calls: [{ name: 'hidden_read', input: '{"path":"y"}' }] }, { agent: {} })
  assert.deepEqual(JSON.parse(f.executed.at(-1).calls[0].arguments), { path: 'y' })
  await assert.rejects(
    f.tool.execute({ action: 'call', name: 'hidden_read', input: 'not json' }, { agent: {} }),
    /input must be a JSON object/,
  )
})

test('list pages through the whole catalog instead of hiding the tail', async () => {
  const definitions = new Map()
  for (let index = 0; index < 120; index += 1) {
    const name = `bulk_tool_${String(index).padStart(3, '0')}`
    const definition = {
      name,
      description: `Bulk tool ${index} for paging coverage.`,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({}),
    }
    markGatewayEligible(definition)
    definitions.set(name, definition)
  }
  let tool
  gateway({ tools: { register(value) { tool = value }, view() { return { visible: definitions } }, async execute() { return { results: [] } } } })
  const seen = new Set()
  let offset = 0
  for (let page = 0; page < 10; page += 1) {
    const text = (await tool.execute({ action: 'list', offset }, { agent: {} })).text
    assert.match(text, /^gateway tools \d+-\d+ of 120/)
    for (const line of text.split('\n')) {
      const match = line.match(/^- (bulk_tool_\d{3}):/)
      if (match) seen.add(match[1])
    }
    const next = text.match(/call list with offset=(\d+)/)
    if (!next) break
    offset = Number(next[1])
  }
  assert.equal(seen.size, 120)
  // An offset past the end says so instead of printing "121-120 of 120".
  const past = (await tool.execute({ action: 'list', offset: 120 }, { agent: {} })).text
  assert.match(past, /End of list: 120 gateway tools/)
})

test('a Team tool that is not in this turn catalog is named as team-gated, not merely unknown', async () => {
  const f = fixture()
  // Not in the gateway catalog and not in the direct (visible) set: exactly the
  // 2026-10-31 Team Lead session where `list_agents` was absent from the
  // catalog but the runtime context told the model to use it.
  await assert.rejects(
    () => f.tool.execute({ action: 'call', name: 'list_agents', input: {} }, { agent: {} }),
    /"list_agents" is a Team tool, not a gateway tool\. Team tools are listed only when this session is a Team session/,
  )
  await assert.rejects(
    () => f.tool.execute({ action: 'call', name: 'spawn_teammate', input: {} }, { agent: {} }),
    /is a Team tool, not a gateway tool/,
  )
})

test('passing an action as name gets a corrective hint instead of "unknown tool"', async () => {
  const f = fixture()
  await assert.rejects(
    () => f.tool.execute({ action: 'call', name: 'search', input: { query: 'x' } }, { agent: {} }),
    /"search" is a gateway action, not a tool name\. Use action="search" with a query/,
  )
  await assert.rejects(
    () => f.tool.execute({ action: 'describe', name: 'list' }, { agent: {} }),
    /"list" is a gateway action, not a tool name\. Use action="list"/,
  )
})

test('a call missing required schema properties names all of them at once', async () => {
  const goal = {
    name: 'update_goal',
    description: 'Update the current goal.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { goal_id: { type: 'string' }, action: { type: 'string' }, revision: { type: 'integer' } },
      required: ['goal_id', 'action', 'revision'],
    },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({ ok: true }),
  }
  const union = {
    name: 'union_tool',
    description: 'A tool whose required set is conditional.',
    parameters: { type: 'object', oneOf: [{ required: ['a'] }, { required: ['b'] }] },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({ ok: true }),
  }
  const definitions = new Map([['update_goal', goal], ['union_tool', union]])
  for (const definition of [goal, union]) markGatewayEligible(definition)
  let registered
  const executed = []
  gateway({
    tools: {
      register(value) { registered = value },
      view() { return { visible: definitions } },
      async execute(input) { executed.push(input); return { results: [{ result: { content: [{ type: 'text', text: 'ok' }] } }] } },
    },
  })

  // Exactly the session-example-b shape: `id`/`phase` instead of goal_id/action/revision.
  await assert.rejects(
    () => registered.execute({ action: 'call', name: 'update_goal', input: { id: 'goal-1', revision: 1, phase: 'complete' } }, { agent: {} }),
    /invalid arguments for "update_goal": missing required "goal_id", "action"\. Required: goal_id, action, revision\. Call action="describe" with name="update_goal"/,
  )
  assert.equal(executed.length, 0)
  // Union schemas are left to the executor instead of being rejected here.
  await registered.execute({ action: 'call', name: 'union_tool', input: { a: 1 } }, { agent: {} })
  assert.equal(executed.length, 1)
  // Complete input passes the pre-check.
  await registered.execute({ action: 'call', name: 'update_goal', input: { goal_id: 'g', action: 'complete', revision: 1 } }, { agent: {} })
  assert.equal(executed.length, 2)
})

test('the gateway keeps serving nested calls (batch programs no longer pass parent)', async () => {
  const f = fixture()
  const list = await f.tool.execute({ action: 'list' }, { agent: {}, parent: {} })
  assert.match(list.text, /gateway tools/)
})

test('action="call" with calls[] runs a validated batch in one step', async () => {
  const f = fixture()
  const batched = await f.tool.execute({
    action: 'call',
    calls: [{ name: 'hidden_read', input: {} }, { name: 'hidden_image', input: {} }],
  }, { agent: {} })
  assert.equal(f.executed.length, 1)
  assert.deepEqual(f.executed[0].calls.map(call => call.name), ['hidden_read', 'hidden_image'])
  assert.match(batched.text, /## hidden_read/)
  assert.match(batched.text, /## hidden_image/)

  // A bad item fails the whole batch before anything executes.
  f.executed.length = 0
  await assert.rejects(
    () => f.tool.execute({ action: 'call', calls: [{ name: 'hidden_read' }, { name: 'nope_zzz' }] }, { agent: {} }),
    /Unknown tool "nope_zzz"/,
  )
  assert.equal(f.executed.length, 0)

  await assert.rejects(
    () => f.tool.execute({ action: 'call', name: 'hidden_read', calls: [{ name: 'hidden_read' }] }, { agent: {} }),
    /Use either name\+input or calls, not both/,
  )
  await assert.rejects(
    () => f.tool.execute({ action: 'call', calls: [] }, { agent: {} }),
    /calls must contain 1–8 items/,
  )
  await assert.rejects(
    () => f.tool.execute({ action: 'search', query: 'read', calls: [{ name: 'hidden_read' }] }, { agent: {} }),
    /calls only applies to action="call"/,
  )
  // `calls` without an action is the batch form, not a search.
  f.executed.length = 0
  const implicit = await f.tool.execute({ calls: [{ name: 'hidden_read', input: {} }] }, { agent: {} })
  assert.match(implicit.text, /## hidden_read/)
  assert.equal(f.executed.length, 1)
})
