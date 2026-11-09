// 20261109：归一化提前到 tools/pre-execute（prepend），抢在 dsh-sandbox 校验
// sandbox_permissions / justification 之前；tools/execute 保留为兜底。
// Fresh entry PATH + release URL：绕开运行中宿主的 ESM 缓存。
export { name, inject, apply } from './tool-call-normalizer.mjs?release=20261109-normalize'
