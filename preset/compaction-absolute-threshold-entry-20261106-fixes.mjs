// 20261106-fixes：策略改写只合并/撤销插件自己的字段（保留摘要路由等原配置）；
// “只降低”按路由的有效 thresholdRatio 判定；卸载时还原原 entry。
// Fresh entry PATH + release URL：绕开运行中宿主的 ESM 缓存。
export { name, inject, apply } from './compaction-absolute-threshold.mjs?release=20261106-fixes'
