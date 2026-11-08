# lean 维护说明 — 20261106-fixes / 20261107-observed

## 本次入口

`lean.patch.yml` 已指向：

- `tool-bootstrap-entry-20261106-fixes.mjs` → `tool-bootstrap.mjs?release=20261106-fixes`
- `tool-gateway-entry-20261107-observed3.mjs` → `tool-gateway.mjs?release=20261107-observed3`
- `tool-call-normalizer-entry-20261106-fixes.mjs` → `tool-call-normalizer.mjs?release=20261106-fixes`
- `compaction-absolute-threshold-entry-20261106-fixes.mjs` → `compaction-absolute-threshold.mjs?release=20261106-fixes`
- `rules-hybrid-entry-20261106-fixes.mjs` → `rules-hybrid.mjs?release=20261106-fixes`
- gateway 与 bootstrap 的 `gateway-policy.mjs` 引用仍统一为 `?release=20261106-fixes`；只更新 gateway 实现 URL，不生成第二套 eligibility 表。

## 实会话反馈优化（20261107）

- 晋升后保留宿主 `tool:subagent` / `tool:subagent_fork` 原生指引：有独立工作就继续做，只剩等待时结束当前 turn，子结果自动开启新 turn；不使用 sleep 或 Team 等待工具代替普通回执。
- gateway 的 Team 零命中提示不再把“已注册”说成“当前已列出”；混合检索分别说明 resident 与 Team 路由，不改变工具权限。
- 自动压力测试必须有足够的独立近期消息超过 retained-tail 下限。单条巨大旧消息加短回复可能整体被保留，从而没有安全压缩范围；手动 `/compact` 的 retain=0 不能替代自动路径验收。测试使用独立预设、20k/2k 阈值，正式 400k/80k 保持不变。

### 本轮验证与限制

- 主回归 372/372；增加真实 Cordis 压缩服务代理分发回归，以及测试副本、整消息 retained-tail 和启动返回值契约覆盖。
- 真实模型自动压缩在 turn 3 发生，无手动 `/compact`；统一 meter 的估算从 34997 降至 9300 tokens，旧标记保留。正式阈值没有降低，也没有用 400k 的真实负载作压力测试。
- 普通两层委派完成、叶子无工具调用；最后一次父会话 5 步、0 工具错误，原实测为 6 步、1 次 sleep 拒绝。N=1 仅作功能与方向观察，不承诺统计显著提速。
- 模型仍有等待类检索，并曾创建纯等待后台命令；本次不扩大 shell 守卫去误伤合法后台任务，不宣称这些模型侧浪费已完全消除。
- 实会话验证入口为 `tools/lean-live-smoke.mjs`，仅由可信 staging 调用；临时预设、会话、目录均须在收取 job_output 后清理，测试代码不注册正式工具。

是否热应用以宿主的 ChangeResult 为准。当前 alpha.3 desktop 对此 bundle 返回 `restart-required / unmanaged-plugin`，因此改文件或换入口不等于共享预设已更新；需重启应用。Node 还按 URL 缓存 ESM，所以实现变更必须同时换入口与 release URL。本轮实时验证使用从新磁盘声明注册的独立临时预设，不替换当前用户会话，完成后注销和删除。

## 首次从 pre-20261106 升级：必须受控重启

旧实现的 `tools.resolve` 包装器没有保存原始方法（原始方法被闭包捕获），只留下
`Symbol.for('@local/dsh-agent-preset-lean/resolve-filter')` 标记。新实现检测到该标记时会：

- 若旧包装器只是实例上的 own property、且原型上仍有原始方法 → 删除旧包装器并继续；
- 否则**不包装**旧闭包，并记录一条明确的 `warn`：

```text
anchored-tool-bootstrap: a pre-20261106 resolve wrapper is still installed and cannot be unwrapped in-process ...
RESTART the host to finish this upgrade; new sessions may fail with
"LEAN resolve exposure state is unavailable for this Agent" until then.
```

看到这条 warn 时，不要继续依赖“只换 shim 就能升级”的说法：请重启宿主。重启后旧模块图清空，新入口才真正生效。

## 重启后的验收

1. 宿主日志出现：

```text
anchored-tool-bootstrap: release 20261106-fixes active (resolve registry generation N)
N 是进程内的模块代号；新会话应大于旧会话的代号。
```

2. 新会话的 `tool_gateway` 描述中：

- family index 含 `workflow_*; goal tools (create_goal/get_goal/update_goal); jobs (job_list/job_output/job_kill)`；
- 不再出现 `subagent/workflow; goal/job. Call those directly.`；
- `subagent` 的说明是：顶层常驻、`subagent_fork` 顶层走 gateway、子会话两者都可经 gateway。

3. 预设测试：

```bash
cd ~/.dsh/.agent-presets/lean && npm test
```

4. 配置检查：

```bash
node ~/.dsh/bin/lean-config-keys.mjs
```

看到 `partial`/`no-coverage`/`schema-invalid` 都不是“通过”；只有 `ok` 才是完整通过。
当前缓存通常只能得到 `partial`（宿主 schema 自身 `complete=false`）。

5. 统计：

```bash
node ~/.dsh/bin/lean-usage-report.mjs --days 1
```

`--days` 按事件时间过滤；常驻目录取最新主会话的最新 `request/header`，并显示
`sessionScope`/`source`/`phase`/`toolCount`。旧报表里的“工具数最多 header”和
“整段历史调用”口径不再使用。

## 回退

把 `lean.patch.yml` 中本次更换的 `name:`（bootstrap / gateway / normalizer /
compaction / rules-hybrid）指回旧入口，然后重启宿主。不要只改入口路径而不重启：
旧 URL 可能仍在 ESM 缓存中。

## 仍然存在的设计限制

- `rules-hybrid.mjs` 的核心块（第 0 章）只在会话开始/压缩后注入一次；核心文件内容
  变化不会在每个 step 重新发送。专项规则可按 digest 更新；核心需要新会话、压缩或
  显式刷新入口（见 `rule_load` 的 `refreshCore`）。
- 批量 gateway 的**部分**失败外层仍是 success（宿主 `createSuccessResult` 忽略返回的
  `isError`）；结果文本带 `BATCH PARTIAL FAILURE: x/y`，全部失败才抛错。统计脚本
  按该标记单独计入批次失败。
