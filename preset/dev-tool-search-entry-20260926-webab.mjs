// A fresh module path and release URL bypass the host's ESM cache.
// 20260926-webab：web_search / web_fetch 常驻 A/B（配置 A）—— 描述常驻清单
// 补足 16 名、UNLOCKABLE_INDEX 撤下 web 行（常驻不进索引的同步纪律）。
// A/B 读数与回滚规则：research-20260926/findings-20260926c.md + ev-pipeline.json web_ab。
export { name, inject, apply } from './dev-tool-search.mjs?release=20260926-webab'
