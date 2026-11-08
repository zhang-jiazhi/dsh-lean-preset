/**
 * shell-space-normalizer 020 (2026-11-01) — adds the foreground wait cap.
 *
 * Absorbed from dsh-superagent: its worker/router presets cap the shell at
 * 5 seconds (`dsh-bash-sandbox: {timeoutMs: 5000, maxTimeoutMs: 5000}`) so a
 * long command is promoted to a background job and its end wakes the session
 * instead of holding the step. The desktop composition already mounts
 * `dsh-bash-sandbox` as the executor, so a preset cannot re-register `shell`
 * (mount fails with `service "shell" has been registered at
 * <SandboxBashExecutor>`). This seam is the one place lean can apply the same
 * policy: cap the resolved foreground wait at 30 s when the caller did not ask
 * for a specific `timeoutMs`. tool-bash then waits 30 s, prints
 * `[still running after 30000ms; moved to background job <id>]` and the job
 * keeps running; its end arrives as a message. An explicit model timeout is
 * honoured (up to the executor cap), so a deliberate long wait still works.
 *
 * Measured in session-example-b: 582 bash calls, p95 59.8 s, 42 calls > 30 s,
 * 30 > 60 s, 82.7 minutes of foreground waiting in one session.
 *
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
export const name = 'shell-space-normalizer-020'

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

  const FOREGROUND_WAIT_MS = 30_000
  /** A cap is only safe when a job registry can adopt the timed-out command. */
  const jobsAvailable = () => {
    try {
      return typeof ctx.get === 'function' && ctx.get('jobs') !== undefined
    } catch {
      return false
    }
  }
  /** Cap only the default wait: an explicit caller timeout is a deliberate choice. */
  const withForegroundWaitCap = (request) => {
    const spec = parent.resolve(withExecutablePath(request))
    if (request?.timeoutMs !== undefined) return spec
    if (spec === null || typeof spec !== 'object' || typeof spec.timeoutMs !== 'number') return spec
    if (spec.timeoutMs <= FOREGROUND_WAIT_MS) return spec
    // Without a job registry tool-bash kills the command at its timeout instead
    // of promoting it; capping then would truncate legitimate long commands.
    if (!jobsAvailable()) return spec
    try {
      return { ...spec, timeoutMs: FOREGROUND_WAIT_MS }
    } catch {
      return spec
    }
  }

  const wrapper = {
    get sandboxMode() {
      return parent.sandboxMode
    },
    resolve(request) {
      return withForegroundWaitCap(request)
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
