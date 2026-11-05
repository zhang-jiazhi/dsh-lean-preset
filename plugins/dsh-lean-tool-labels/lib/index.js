/**
 * @local/dsh-lean-tool-labels - host half.
 *
 * The labels are a native web-client contribution: the client face registers
 * keyed `tool.call.toolview` entries for the two tools the lean preset owns, so
 * their rows read as a short summary rather than the generic row's argument
 * JSON. This host half owns no services; it exists because the client module
 * graph is composed from mounted host plugins declaring `dsh.client`.
 */

/** Stable cordis plugin name. */
export const name = 'lean-tool-labels'

/** No host services required. */
export const inject = []

/**
 * No host-side work: rendering lives entirely in the client face.
 * @param {import('@deepseek-ai/cordis').Context} _ctx - host root context (unused).
 */
export function apply(_ctx) {}
