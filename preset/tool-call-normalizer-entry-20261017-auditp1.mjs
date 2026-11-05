// Fresh entry PATH + release URL: the preset is hot-loaded, but same-path .mjs
// stays in Node's ESM cache for the host lifetime.
// 20261017-audit-p1: normalize bash/subagent/path arguments in tools/execute,
// before each tool's defineTool schema validation.
export { name, inject, apply } from './tool-call-normalizer.mjs?release=20261017-auditp1'
