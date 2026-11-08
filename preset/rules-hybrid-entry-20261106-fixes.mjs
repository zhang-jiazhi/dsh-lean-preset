// 20261106-fixes：rule_load 增加 refreshCore:true 的显式一次性刷新入口。
// 核心块仍只在会话开始/成功压缩后自动注入，不改成每步重发；编辑 AGENTS.md 后
// 需要立即生效时调用 rule_load({sections:["0"], refreshCore:true})。
// Fresh entry PATH + release URL：绕开运行中宿主的 ESM 缓存。
export { name, inject, apply } from './rules-hybrid.mjs?release=20261106-fixes'
