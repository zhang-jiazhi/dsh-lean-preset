// A fresh module path and release URL bypass the host's ESM cache.
// 20260926-rank：dev_tool_search 匹配结果按相关度排序（relevanceOf 计分，
// 同分保持目录序）。描述与 schema 零变化，不影响在途 web A/B；读数为
// 解锁失败率与"解锁后未用率"趋势（ev-pipeline 重跑自动累计）。
export { name, inject, apply } from './dev-tool-search.mjs?release=20260926-rank'
