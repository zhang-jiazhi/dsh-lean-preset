// Fresh entry PATH + versioned re-export URL: Node keys the ESM cache by
// resolved URL, so editing tool-bootstrap.mjs alone leaves the running host on
// the old graph. 20261017-audit-p0 adds `subagentResidentTools` /
// `subagentCompactionTools`; a preset that supplies either key would otherwise
// fail the unknown-config-key check and lose the whole tool-bootstrap row.
// Defaults keep the previous behavior when the keys are absent.
export { name, inject, apply } from './tool-bootstrap.mjs?release=20261017-auditp0'
