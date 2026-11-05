import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { runtimeRequire } from './runtime-helper.mjs'

const yaml = runtimeRequire('js-yaml')
const { entryListSchema } = runtimeRequire('@deepseek-ai/cordis-plugin-include')
const patch = yaml.load(
  await readFile(new URL('../lean.patch.yml', import.meta.url), 'utf8'),
  { schema: entryListSchema },
)
const preset = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-lean')
const plugins = preset.config.plugins
const bootstrap = plugins.find(row => row.id === 'tool-bootstrap')
const planning = plugins.find(row => row.id === 'planning')

test('plan mode keeps exit_plan_mode in the promoted and post-compaction catalogs', () => {
  // dsh-plan-mode registers exit_plan_mode once at mount and only gates the
  // plan:policy system section; it never restricts tools. If either list drops
  // the tool, entering/leaving plan mode changes the request tool catalog.
  assert.ok(bootstrap.config.residentTools.includes('exit_plan_mode'))
  assert.ok(bootstrap.config.compactionTools.includes('exit_plan_mode'))
})

test('LEAN uses the official plan-mode row and catalog-stability rule', () => {
  assert.equal(planning.name, 'cordis:group')
  assert.equal(planning.isolate.planMode, true)
  const planMode = planning.config.find(row => row.id === 'plan-mode')
  assert.equal(planMode.name, '@deepseek-ai/dsh-plan-mode')
  assert.match(planMode.config.section, /tool catalog stays the same across modes/i)
})
