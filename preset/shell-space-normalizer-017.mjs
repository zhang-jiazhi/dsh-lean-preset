/**
 * shell-space-normalizer (0.1.7 executor API) — isolated wrapper for the
 * `ctx.shell` service seam.
 *
 * Commands are opaque source text. Unicode spaces inside literals, paths,
 * escapes and heredocs must reach the executor unchanged. Fixing a malformed
 * separator belongs to the caller, not to an unconditional text replacement.
 *
 * 0.1.7 migration (2026-09-22):
 *   The host executor's shape changed. 0.1.6 exposed `run()` / `start()`;
 *   0.1.7 exposes `resolve()` / `execute()` / `onProcessDone()` / `confine()`
 *   on `SandboxBashExecutor`, and `@deepseek-ai/dsh-tool-bash` drives it as
 *   `ctx.shell.execute(ctx.shell.resolve(request))`.
 *
 *   The previous wrapper forwarded only run/start and had no `execute`, so
 *   every shell tool inside this isolated scope died with
 *   `ctx.shell.execute is not a function`. It now forwards the 0.1.7 surface
 *   preserving command bytes, cancellation and the resolved execution spec.
 *   20260927: resolve may add missing installed macOS CLI directories to env.PATH.
 *
 * Why a new file instead of editing in place:
 *   The preset's own docs note that a same-path `*.mjs` stays in Node's ESM
 *   cache for the life of the host process, so an in-place edit would only be
 *   visible after a host restart. A new entry path is picked up by the next
 *   standing mount without restarting anything.
 *
 * Scope:
 *   - Local to the `lean` preset; runs inside the `shell-normalized` group,
 *     which isolates the `shell` service.
 *   - `shell-parent-capture.mjs` stores the unwrapped host executor under the
 *     private `leanShellParent` service.
 */

import { statSync } from 'node:fs'

// GUI launches can inherit only Apple's system PATH. Extend that default at
// the private LEAN seam, not process.env or the host executor. Existing order
// and caller-supplied PATH (even empty) are authoritative. No shell rc is run.
function withExecutablePath(request) {
  if (process.platform !== 'darwin' || request.env?.PATH !== undefined) return request
  const inherited = process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'
  const entries = inherited.split(':')
  const missing = ['/opt/homebrew/bin', '/usr/local/bin'].filter(directory => {
    if (entries.includes(directory)) return false
    try { return statSync(directory).isDirectory() } catch { return false }
  })
  if (missing.length === 0) return request
  return { ...request, env: { ...request.env, PATH: [...entries, ...missing].join(':') } }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'shell-space-normalizer'

/** The captured host shell service must exist before this wrapper can run. */
export const inject = ['leanShellParent']

export function apply(ctx) {
  const parent = ctx.leanShellParent?.shell
  if (parent === undefined || parent === null || typeof parent.resolve !== 'function') {
    throw new TypeError(`${name}: leanShellParent.shell.resolve is not available`)
  }
  if (typeof parent.execute !== 'function') {
    throw new TypeError(
      `${name}: leanShellParent.shell.execute is not available — the host executor is not the 0.1.7 shape`,
    )
  }

  const wrapper = {
    get sandboxMode() {
      return parent.sandboxMode
    },
    resolve(request) {
      return parent.resolve(withExecutablePath(request))
    },
    execute(request, ...rest) {
      return parent.execute(request, ...rest)
    },
  }

  // Forward the remainder of the executor surface when the host exposes it.
  for (const method of ['onProcessDone', 'confine']) {
    if (typeof parent[method] === 'function') {
      wrapper[method] = (...args) => parent[method](...args)
    }
  }

  ctx.effect(() => ctx.reflect.provide('shell', wrapper))
}
