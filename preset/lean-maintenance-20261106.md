# lean 维护说明 — 20261110-catalog / 20261110-scoped2

## 本次入口

`lean.patch.yml` 已指向：

- `tool-bootstrap-entry-20261110-catalog.mjs` → `tool-bootstrap.mjs?release=20261110-catalog`
- `tool-gateway-entry-20261110-scoped2.mjs` → `tool-gateway.mjs?release=20261110-scoped2`
- `skills-on-demand-entry-20261110-errors.mjs` → `skill-search.mjs?release=20261110-errors`
- `tool-call-normalizer-entry-20261109-normalize.mjs` → `tool-call-normalizer.mjs?release=20261109-normalize`
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
anchored-tool-bootstrap: release 20261110-catalog active (resolve registry generation N)
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
- 批量 gateway 的**部分**失败外层仍是 success，保留成功内容和图片；结果文本带
  `BATCH PARTIAL FAILURE: x/y`，全部失败才抛错。逐调用 `statuses` 同时写入
  `meta.gatewayCalls`，统计不能只看外层 `isError`。返回 value 中增加 `isError`
  并不能改变宿主的成功/失败语义。

## 20261109 记录的复核纠正

20261110 改用事件时间和真实 ASAR 注册表复核，不再把文件 mtime 当错误发生时间：

- 之前归入“今日 53 次”的会话是长历史会话；其空 provider、justification 错误实际
  发生于 9 月。空 provider 的校验发生在子工具正文，不能归因为 sandbox 的
  pre-execute 时序；当前 tools/execute 归一化已经覆盖空路由字段。
- 正常空技能目录仍返回 canonical `result`。11-09 三次 `tool produced no result`
  的历史 executor/envelope 尚未定位；“空目录不返回 result”的说法被真实实验否定。
- 真实 `tools.view(agent)` 动态合并当前 global/scoped 注册。旧 false 也能标记
  晚注册和同名重注册；true 修的是目录快照陈旧，原“scope 永远缺晚 global”的
  mock 不符合当前宿主，已纠正并补真实接口覆盖。
- pre-execute 的沙箱参数归一化保持不变；它早于 tools/execute 的执行顺序和
  非更宽升级/空 justification 的防护继续受 normalizer 回归约束。

## 20261110 修复与验证

- 网关只取调用 Agent 的有效 registrations，不再合并 global fallback；条件读取
  当前 registration.when，不使用跨 Agent 共享 definition 的 originalWhen 作授权。
  私有 ToolSet 在执行时再次核对 registration/definition，覆盖审批前后撤销竞态。
- 单/批调用共用 canonical result 解码。缺失 result 是协议错误，明确 outcome unknown，
  不诱导盲目重跑有副作用的调用；技能服务真实异常保留 native failure。
- schema 快照按 per-Agent registration identity + tools/change revision 失效。
  变更即时失效、微任务合并刷新；相位/解锁仍每次重算 keep，不再每步深拷贝 schema。
- REA 只压缩成功的 `binary_session` 完整状态 JSON，不改分析证据、图片或错误。
  从未截断的 canonical value 提取状态，完整 payload 和原始 value 通过现有 spillStore
  私有保存；摘要带 SHA-256、locator 和读取提示，预算 8k 字符。未知格式、已有短预览
  或无存储服务保持原文，保存失败明确提示并保留原文。`full_output: true` 绕过
  LEAN 摘要，但不取消宿主 spill 限制；保留/清理由现有 spillStore 管理。
- 真实 ASAR 修复前回归：6 项中 5 项失败（scope deny、同名条件遮蔽、跨 Agent 条件、
  pre-execute 撤销、技能异常误报）；修复后全部通过。缓存回归证明首次投影后 5 个
  无变更 step/turn 同步不会再投影，late/scoped/remove/restrict 与 burst 刷新仍有效。
- 同条件合成目录基准：383 工具、参数 JSON 1150B、5 波预热/21 波采样，无注册变更。
  step/end 同步 p50：1 Agent 2.918→0.103ms，8 Agent 23.570→0.663ms，
  32 Agent 93.983→2.606ms；8 Agent 的 schema 投影 168→0、view 调用 504→168。
  这是合成基准，不是线上模型延迟。
- 真实 REA 样本 + 当前 spillStore 验证：inline 49930→6438 字符；未截断源为
  54311 字符，完整原始 value/payload 和 server identity 校验一致，文件 0600、
  SHA-256 校验通过。N=1，不代表所有目标/版本的压缩率，也未执行目标分析。
- 只更改本地预设及回归，发布副本未改。当前运行中的 20261109 模块不会因文件写入
  自动换代；新入口可加载不等于在线已激活，受控重启后的入口核验仍需单独完成。

## 20261112 与 0.2.2-rc.2 的匹配核对

- 实际宿主：`@deepseek-ai/dsh-desktop 0.2.2-rc.2`、`dsh-tools 0.2.2-rc.2`；
  进程启动晚于应用更新时间，当前会话已装载 20261110 三条入口，`broken=null`、
  `leakedServices=[]`。完整回归 **397/397**（rc.2 ASAR）。
- 目录：注册 364 个工具（REA 207、github 26、playwright-persist 23…），常驻 13 项全在。
  同一会话 20 个 `request/header` 中工具数上限 23，未出现目录泄漏；
  rc.2 仍未实现 `deferLoading`（仅类型声明），gateway 方案继续成立。
- 真实失配（已修）：桌面 profile 自 2026-11-01 停用 browser-use 的
  `experimental-browser-use-playwright-mcp`，live 目录只剩
  `mcp__playwright-persist__*`（23）。但 gateway family index 与
  `TOOL_BUNDLES.playwright` 仍写 `mcp__playwright-mcp__*`（24），搜索/解锁会
  得到空结果。现在两者都指向实际 serverName（`mcp__playwright-persist__`）。
- rc.2 新增 `dsh-terminal-panel` 的 `user_terminal_list/read`；已补入能力索引和
  `HOST_LAYER_TOOLS`（gateway 侧只列家族名，不加常驻、不改权限）。
- 新增静态回归：bundle 名字必须落在**预设层**启用的 MCP server 前缀下，且 gateway
  文本不得提已禁用的 server；禁用清单同时扫描预设层与 profile 层
  （`DSH_PROFILE_DIR` 缺省 `~/.dsh/profiles/desktop`，文件不存在时跳过）。
  变异验证：把 gateway 索引改回旧名，两条回归都报错；改回即通过。
- 对抗审核发现的缺口（已修）：首版只扫描预设层，而本次真实故障源（browser-use
  provider）是在 profile 层停用的。仅靠“必须包含 mcp__playwright-persist__”的正向断言
  能拦住回退，但拦不住“另一台在 profile 停用的 server 被写进索引”。
- 未改的取舍：`keptSections` 仍只保留 jobs/apply_patch/subagent*；rc.2 的
  `tool:pty`、`tool:pty-panel`、`tool:schedule` 属隐藏工具的说明，常驻会增加
  每步开销，故不入白名单。
- 注意：`dev-tool-search` 插件当前**未挂载**（live 目录无 `dev_tool_search`），
  `TOOL_BUNDLES`/`UNLOCKABLE_INDEX` 只影响测试与静态契约；真正对模型生效的是
  gateway 描述。新入口 `tool-gateway-entry-20261112-rc2.mjs` 需重启后生效。
