// 20261106-fixes：跨代 resolve 状态改为 process-wide 共享表 + 原子换代；
// Team 否定指令与运行时 Team-Lead 身份分离；gateway eligibility 按调用 Agent
// 的 keep 集判定（子会话 subagent 可经 tool_gateway 委派）。
// Fresh entry PATH + release URL：Node 按解析后的 URL 缓存 ESM，同路径改动
// 不会进入正在运行的宿主。
export { name, inject, apply } from './tool-bootstrap.mjs?release=20261106-fixes'
