// 20261109：隐藏工具 settled 结果缺失时不再抛 "tool produced no result"。
// gateway-policy 仍走 20261106-fixes，与 bootstrap 共用同一套 eligibility。
export { name, inject, apply } from './tool-gateway.mjs?release=20261109-observed4'
