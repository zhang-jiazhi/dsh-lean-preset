// 20261106-fixes：bash TTY/timeout 提示改用 tool_gateway（lean 未挂载
// dev_tool_search），并保留 terminal_* / run_in_background 的下一步。
// Fresh entry PATH + release URL：绕开运行中宿主的 ESM 缓存。
export { name, inject, apply } from './tool-call-normalizer.mjs?release=20261106-fixes'
