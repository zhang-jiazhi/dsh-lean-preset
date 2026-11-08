# LEAN 桌面修复与复查 — 2026-09-27

## 目标与完成条件

修复已确认的桌面 CLI PATH、工具发现提示和测试环境耦合问题；保持现有常驻工具集合，使用 web 与桌面实际模块树通过回归，并复查活动配置、恢复状态和生效边界。未安装依赖，未修改宿主包，未重启 GUI。

## 已完成变更

- `shell-space-normalizer-017.mjs`：仅 macOS、仅 LEAN 私有 shell 的 resolve 边界，在继承 PATH 尾部追加实际存在且尚未包含的 `/opt/homebrew/bin`、`/usr/local/bin`。不改 process.env、命令字节或 execute spec，不覆盖显式请求 PATH（包括空值），不复制宿主凭据。使用新入口 `shell-space-normalizer-019.mjs` 和新的实现 import URL。
- `dev-tool-search.mjs`：已有 MCP 家族但无词项重叠时返回搜索引导；相似度不再把 `mcp`/服务命名空间算作操作词匹配。移除常驻说明中的历史统计和冗长论证，保留按需能力索引、exact-name 优先、合并 search/unlock、分页与次请求生效说明。使用新入口 `dev-tool-search-entry-20260927-maintenance.mjs`。
- 测试：统一经 `runtime-helper.mjs` 选取模块树，支持 `DSH_TEST_RUNTIME_ROOT`、`DSH_PROFILE_DIR`，默认保持 web；替换读取可变用户 provider 配置的测试为确定性行为夹具。补充 MCP 回退和 PATH 相关回归；更新 `tests/README.md`。
- web 配置：仅将 `- id: @local/dsh-preset-probe` 改为 `- id: '@local/dsh-preset-probe'`，修复 YAML 语法；desktop profile 文件未修改。
- `residentTools` 与 `compactionTools` 均保持原 16 项。未改 MCP 挂载层、压缩阈值、工具结果裁剪或规则/技能策略。

## 验证证据

基线：180 项，179 通过、1 失败（web YAML 语法）。新增失败用例在修复前复现 4 个失败；修复后再增加环境隔离/优先级覆盖。

终验在 LEAN 目录执行，先设置与基线相同的测试启动 PATH：

```sh
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
node --test --test-reporter=tap tests/*.test.mjs
ELECTRON_RUN_AS_NODE=1 \
DSH_TEST_RUNTIME_ROOT='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh' \
'/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' \
  --expose-internals --test --test-reporter=tap tests/*.test.mjs
```

- web DSH 0.1.7-rc.2 / Node 26.8.1：187/187，0 失败，0 跳过。
- 桌面 Electron 44.0.0 / Node 24.18.1：187/187，0 失败，0 跳过。
- 52 个顶层实现/测试 `.mjs` 语法检查；54 个静态相对 import 目标存在。
- 使用生产 `entryListSchema` / js-yaml 解析 LEAN、desktop、web 配置成功；与备份比较确认两组常驻集合未变。
- 活动逻辑复查：bootstrap/解锁持久化及作用域、成功/失败压缩边界、规则与技能恢复去重、todo/repeated-call 提醒预算与释放、batch 边界和目录索引一致性。受测范围内未发现额外阻断问题。
- 搜索说明的 JS 字符串长度：3392 → 2665，减少 727（约 21.4%）。未测 tokenizer token 数或账单节省。

一次未设置启动 PATH 的测试运行中，调用 rg 的 glob 测试失败；恢复与基线相同的启动环境后通过。这不代替 shell PATH 用例：后者显式重建最小 PATH，并通过 bash -c 验证 node/npm/rg 查找。

## 桌面生效与限制

通过已核对的 `pluginManager.setBundleEnabled('@local/dsh-agent-preset-lean', true)` 刷新已安装 bundle，结果 `application: applied`、`warnings: []`。新 LEAN scope 的 `dev_tool_search` 描述实测为 2665 字符，说明新实现已加载。临时 staging 探针不转正，验证后移除。

冷 transcript scope 查询得到 128 个 schemas，其中 GitHub 26、playwright-persist 23。冷 scope 不等于 Agent scope：`subagent` 等 Agent 动态能力不能用该查询是否出现来判定故障；未调用远程 MCP API。

**已有会话保留原修订。** 刷新后的本会话无 PATH 覆盖探测仍为 `/usr/bin:/bin:/usr/sbin:/sbin`，node/npm/rg 仍未找到。因此使用新修复需新建 LEAN 会话；旧会话临时可显式 export PATH。不强制迁移旧会话，不重启宿主。

未执行：新 GUI 会话完整交互、远程 MCP/API 业务调用、Windows/Linux 运行、真实计费或 web 驻留实验刷新。说明文本修改会改变新修订的 schema 字符串；虽常驻集合不变，后续 A/B/缓存评估仍应标记本次维护边界，不能宣称完全无实验影响。

## 回退点

原文件备份位于 `.maintenance/20260927-194819/`（私有目录）；`manifest.txt` 列出原 LEAN 文件，`web-cordis.patch.yml` 是修改前 web 配置。回退时先比对当前差异，仅恢复本次改动，避免覆盖之后的用户修改；移除本次新增入口/测试文件须确认仍未被后续版本使用。

若回退实现后要求新修订立即生效，也必须使用新的入口路径及 release import URL，不能依赖旧 ESM URL 重载；随后刷新 bundle、重新验证并新建会话。回退 web 的单行修复会恢复原 YAML 错误，除非确有需要不要恢复它。
