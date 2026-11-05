// A fresh module path and release URL bypass the host's ESM cache.
// 20260925-familyunlock: Usage 行不再默认推荐整族解锁 —— 实测 201 个 lean 会话里
// 69.9% 的非驻留暴露从未被调用（920/1317），浪费集中在 `mcp__github__*`(218)、
// `mcp__computer-use__*`(58)、`dev_*`(54)。改写为"优先精确名 + 给出量化代价"。
export { name, inject, apply } from './dev-tool-search.mjs?release=20260925-familyunlock'
