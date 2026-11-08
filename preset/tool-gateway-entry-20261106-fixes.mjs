// 20261106-fixes：批量调用保留每项原始 content（图片不再消失）并明确标记
// 部分失败；负向清单改为 workflow / goal / job 走 gateway，subagent 按会话阶段
// 说明；eligibility 按调用 Agent 判定。
// Fresh entry PATH + release URL：绕开运行中宿主的 ESM 缓存。
export { name, inject, apply } from './tool-gateway.mjs?release=20261106-fixes'
