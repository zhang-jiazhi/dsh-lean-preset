import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Resolve everything from the active Session tree. A separately installed
// testkit can import another Cordis/Symbol instance even at the same version.
// Desktop resolves from app.asar/dsh under Electron-as-Node; plain Node cannot
// traverse ASAR. The web profile tree was retired on 2026-10-24 (version trees
// purged, profile symlinks dangling) — the desktop asar is the only runtime and
// therefore the default; DSH_TEST_RUNTIME_ROOT still overrides for staged trees.
// Fail visibly for an invalid root: never fall back across trees.
const DESKTOP_RUNTIME_ROOT = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh'
export const runtimeRoot = process.env.DSH_TEST_RUNTIME_ROOT
  ?? process.env.DSH_PROFILE_DIR
  ?? DESKTOP_RUNTIME_ROOT
const profileResolve = createRequire(join(runtimeRoot, 'package.json')).resolve
export const runtimeRequire = createRequire(profileResolve('@deepseek-ai/dsh-session'))
export const runtime = name => import(pathToFileURL(runtimeRequire.resolve(name)).href)

export async function mountAgentLoopTestDependencies(ctx) {
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-tool-executor-native', 'dsh-agent']) {
    const module = await runtime(`@deepseek-ai/${name}`)
    const plugin = module.default ?? {
      name: module.name,
      inject: module.inject,
      apply: module.apply,
    }
    if (typeof plugin !== 'function' && (plugin === null || typeof plugin !== 'object')) {
      throw new TypeError(`test runtime plugin @deepseek-ai/${name} has no default/apply export`)
    }
    await ctx.plugin(plugin, {})
  }
}

export async function mountAgentLoopTestHarness(ctx) {
  const { default: AgentLoop } = await runtime('@deepseek-ai/dsh-agent-loop')
  await ctx.plugin(AgentLoop, { agents: [] })
  return {
    create: (id, options = {}, meta = {}) => ctx.agentLoop.create(id, options, meta),
    claim: (agent, target, turn) => agent.inbox.claim(target, turn),
  }
}

// Queue-only unit fixture. Integration tests above use the production Inbox,
// event commit path and AgentLoop; this stub is never used to mount that loop.
export function createInboxStub() {
  const queues = { 'next-step': [], 'next-turn': [] }
  const mutate = (id, ...replacement) => {
    for (const queue of Object.values(queues)) {
      const index = queue.findIndex(message => message.id === id)
      if (index >= 0) { queue.splice(index, 1, ...replacement); return true }
    }
    return false
  }
  return {
    get nextStep() { return queues['next-step'] },
    get nextTurn() { return queues['next-turn'] },
    clear() { for (const queue of Object.values(queues)) queue.splice(0) },
    append(target, message) { queues[target].push(message) },
    prepend(target, message) { queues[target].unshift(message) },
    replace(id, message) { return mutate(id, message) },
    remove(id) { return mutate(id) },
    splice(target, start, count, inserted) { return queues[target].splice(start, count, ...inserted) },
  }
}
