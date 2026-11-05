// A fresh module path and release URL bypass the host's ESM cache.
// 20260926-suggest：missing 解锁输出加近似名建议（实测 36/228 次解锁失败
// 全是可当轮纠正的"像真名的猜测"或 server 未连上；closest 名单把失败轮
// 变成同 call 纠正，省一整轮往返）。
export { name, inject, apply } from './dev-tool-search.mjs?release=20260926-suggest'
