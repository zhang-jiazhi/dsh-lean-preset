// 20261103-022a3：alpha.3 适配（观察策略默认关闭 → 关闭 workspace 写拦截；
// keptSections 放行 tool:jobs；edit/write 提示改为不依赖宿主校验的措辞）。
export { name, inject, apply } from './tool-bootstrap.mjs?release=20261103-022a3'
