// Fresh entry PATH + release URL：预设是热加载的，同路径 .mjs 会命中 Node ESM 缓存。
// 20261102c：跳过 read 与 subagent 类结果、去掉死代码、format 也带 release 版本。
export { name, inject, apply } from './observation-contract.mjs?release=20261102c'
