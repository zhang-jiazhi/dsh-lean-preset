/**
 * shell-parent-capture — private alias for the host `ctx.shell` service.
 *
 * The isolated shell group below needs a reference to the host executor so its
 * wrapper can delegate foreground/background execution without re-implementing
 * the shell seam. This plugin captures that reference under a preset-private
 * service name before the group isolates `shell`.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'shell-parent-capture'

/** The host shell service must exist before this alias can be created. */
export const inject = ['shell']

export function apply(ctx) {
  // Read the host executor from the service store rather than through
  // `ctx.shell`, whose per-context proxy would delegate back to this plugin.
  const shell = ctx.reflect.get('shell')
  if (shell === undefined || shell === null || typeof shell.resolve !== 'function') {
    throw new TypeError(`${name}: host shell service is not available`)
  }

  ctx.effect(() => ctx.reflect.provide('leanShellParent', { shell }))
}
