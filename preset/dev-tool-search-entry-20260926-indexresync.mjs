// A fresh module path and release URL bypass the host's ESM cache.
// 20260926-indexresync：索引/描述与配置重新同步 —— 描述常驻清单补入 send_message
// （9-25 已常驻），索引撤下 send_message 与已停用的 mcp__computer-use__* /
// mcp__blender__*（tests/index-consistency.test.mjs 此前 2 红，修后全绿）。
export { name, inject, apply } from './dev-tool-search.mjs?release=20260926-indexresync'
