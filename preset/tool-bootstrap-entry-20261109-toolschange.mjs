// 20261109：tools/change 重同步时 refresh=true，重读目录后再打 eligibility 标记，
// 避免晚注册/重注册的工具因缓存目录快照被跳过而变成"看不见也调不动"的死角。
// Fresh entry PATH + release URL：绕开运行中宿主的 ESM 缓存。
export { name, inject, apply } from './tool-bootstrap.mjs?release=20261109-toolschange'
