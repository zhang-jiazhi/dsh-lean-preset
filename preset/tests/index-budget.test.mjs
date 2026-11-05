// Capability-index budget rendering guard (20260928-budgetindex).
//
// UNLOCKABLE_INDEX now renders through renderCapabilityIndex: a per-entry cap
// and a total budget with name-only degradation (ZCode skill-catalog pattern).
// The failure modes this guards against:
//   - a future index edit balloons one line (or the whole block) and silently
//     grows the per-request schema cost — the 2026-09-03 measurement showed
//     the index is cheap only while it stays small;
//   - degradation itself losing capabilities: entries name several tools on
//     one line ("；"-separated groups, multi-name " / " lists), so the
//     name-only fallback must split on "；" before cutting at " — ".
//
// Today's real index fits both budgets, so full mode must be byte-identical
// to the previous rendering (`entries.map(line => `- ${line}`)`) — that
// equivalence is what keeps the in-flight web A/B unaffected.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { INDEX_BUDGET_CHARS, INDEX_PER_ENTRY_CHARS, UNLOCKABLE_INDEX, renderCapabilityIndex } from '../dev-tool-search.mjs'

const legacyRender = (entries) => entries.map((line) => `- ${line}`)

test('real index fits both budgets and renders byte-identical to the legacy path', () => {
  const rendered = renderCapabilityIndex()
  assert.deepEqual(rendered, legacyRender(UNLOCKABLE_INDEX))
  assert.ok(rendered.every((line) => line.length - 2 <= INDEX_PER_ENTRY_CHARS))
  assert.ok(rendered.join('\n').length <= INDEX_BUDGET_CHARS)
})

test('every real index entry follows the names—description convention and survives degradation', () => {
  // Degradation only yields name lines for fragments that keep the
  // "names — description" convention (separator " — ", groups joined by
  // fullwidth "；"). A future entry written without it would be silently
  // dropped from the degraded block — flag it here instead.
  for (const entry of UNLOCKABLE_INDEX) {
    const nameFragments = entry.split('；').filter((fragment) => fragment.includes(' — '))
    assert.ok(nameFragments.length >= 1, `entry must keep the "names — description" convention: ${entry.slice(0, 60)}…`)
  }
  const fillers = Array.from({ length: 20 }, (_, i) => `tool_${i} — ${'filler '.repeat(14)}`)
  const text = renderCapabilityIndex([...UNLOCKABLE_INDEX, ...fillers]).join('\n')
  for (const entry of UNLOCKABLE_INDEX) {
    const firstName = entry.split('；')[0].split(' — ')[0].trim()
    assert.ok(text.includes(firstName), `degraded index must keep ${firstName}`)
  }
})

test('per-entry cap truncates an over-long entry with an ellipsis', () => {
  const long = 'x'.repeat(INDEX_PER_ENTRY_CHARS + 100)
  const rendered = renderCapabilityIndex([long, 'short — description'])
  assert.equal(rendered[0], `- ${'x'.repeat(INDEX_PER_ENTRY_CHARS - 1)}…`)
  assert.equal(rendered[1], '- short — description')
})

test('over-budget index degrades to name-only lines, keeping every named capability', () => {
  const entries = [
    `${'a'.repeat(INDEX_PER_ENTRY_CHARS)} — first capability description`,
    'create_goal / get_goal / update_goal — 长期目标；job_list / job_output / job_kill — 后台任务',
    'mcp__github__* — 26 个，GitHub API：issue / PR / review',
  ]
  // Force the budget branch: 20 filler entries of ~109 chars each (~2.2k total,
  // above INDEX_BUDGET_CHARS=2000) — the three real entries alone stay under.
  const many = [...entries, ...Array.from({ length: 20 }, (_, i) => `tool_${i} — ${'filler '.repeat(14)}`)]
  const rendered = renderCapabilityIndex(many)
  assert.ok(rendered.join('\n').length > 0)
  // Degraded lines carry no " — " separator: they are name-only.
  const text = rendered.join('\n')
  assert.ok(rendered.every((line) => !line.includes(' — ')), `degraded lines must be name-only, got: ${text}`)
  // Every named capability survives: the "；" split keeps job_* alongside goal_*.
  for (const name of ['create_goal / get_goal / update_goal', 'job_list / job_output / job_kill', 'mcp__github__*', 'tool_0', 'tool_19']) {
    assert.ok(text.includes(name), `degraded index must keep ${name}`)
  }
  assert.ok(!text.includes('first capability description'))
  assert.ok(!text.includes('filler'))
})

test('rendering is deterministic across calls', () => {
  assert.deepEqual(renderCapabilityIndex(), renderCapabilityIndex())
  assert.deepEqual(renderCapabilityIndex(['a — b', 'c — d；e — f']), renderCapabilityIndex(['a — b', 'c — d；e — f']))
})

test('degraded fallback drops empty fragments and whitespace-only names', () => {
  // The edge-case entry plus enough fillers to actually cross the budget:
  // "；；" yields an empty fragment, " — orphan separator" a nameless one,
  // "   — blank" a whitespace-only one — all must be dropped in name-only mode.
  const entries = [
    'real_tool — does things；； — orphan separator；   — blank',
    ...Array.from({ length: 20 }, (_, i) => `tool_${i} — ${'filler '.repeat(14)}`),
  ]
  const rendered = renderCapabilityIndex(entries)
  const text = rendered.join('\n')
  assert.ok(rendered.every((line) => line.length > 2), `no empty bullets expected, got: ${JSON.stringify(rendered)}`)
  assert.equal(text, '- real_tool\n' + Array.from({ length: 20 }, (_, i) => `- tool_${i}`).join('\n'))
})

test('apply() assembles the description through renderCapabilityIndex', async () => {
  const source = await readFile(new URL('../dev-tool-search.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes('...renderCapabilityIndex(),'), 'description assembly must use the budgeted renderer')
  assert.ok(!source.includes('UNLOCKABLE_INDEX.map((line)'), 'legacy unbounded rendering must be gone')
})
