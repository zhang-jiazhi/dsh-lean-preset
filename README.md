# dsh-lean-preset

DeepSeek Harness (DSH) 的 **Lean 预设**完整发布包：核心规则与专项目录自动提供，其余能力通过 `tool_gateway` 按需加载。

派生自 `anchored-flash`（MIT）。目标是在同等 token 消耗下减少轮次、提高工具选择准确率、减少无意义探索。

## 仓库结构

```text
preset/                      →  ~/.dsh/.agent-presets/lean/
  preset.yml
  lean.patch.yml               主配置：插件装配、工具曝光、MCP 接入
  package.json                 DSH bundle 声明
  *.mjs                        入口模块与基础实现
  tests/                       单元测试
  lean.patch.yml.bak-*         历史版本（保留用于回溯）

plugins/dsh-lean-batch/      →  ~/.dsh/local-plugins/dsh-lean-batch/
plugins/dsh-lean-tool-labels/ →  ~/.dsh/local-plugins/dsh-lean-tool-labels/

tools/                       →  ~/.dsh/bin/
  lean-check.mjs
  lean-config-keys.mjs
  lean-usage-report.mjs

AGENTS.md                    →  ~/.dsh/AGENTS.md
```

`cache/lean-config-schema.json` 不在仓库内：它是本机宿主 schema 快照，需要时本地生成
（`dsh --dump-config-schema > ~/.dsh/cache/lean-config-schema.json`），`lean-config-keys`
默认就读这个路径。

## 依赖

- DeepSeek Harness **0.2.2-alpha.3**（本快照在该版本实机验证；`0.1.7+` 的旧声明格式仍兼容）
- 30+ 个官方插件 `@deepseek-ai/dsh-*`，由 DSH 本体提供
- `dsh-lean-batch` 的 peerDependencies：`@deepseek-ai/cordis >=4.0.0-rc`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-ptc-runtime`
- 可选 MCP 工具：`@playwright/mcp`、`github-mcp-server`、`rea-agent`、`uvx`

## 安装

1. 按上面的结构把各目录放到对应位置
2. **必须修改** `preset/lean.patch.yml` 中的占位路径：

   ```text
   /Users/USER/...   →   你本机的实际路径
   ```

   当前 `lean.patch.yml` 内 14 处（历史 `.bak-*` 中同样存在），全部位于 MCP server 的 `command` 与 `env` 段
   （`uvx`、`github-mcp-server`、`rea-agent`、`node`、`PATH`、缓存目录等）。
   如果不用这些 MCP 工具，可整段删除，不影响预设核心行为。

3. 激活补丁：`setBundleEnabled('@local/dsh-agent-preset-lean', true)`
4. `preset/package.json` 的 `test` 脚本含 macOS 应用路径，按你的安装位置调整

## 工具曝光策略

- **首轮**：`bash`、`read`、`rule_load`、`tool_gateway`、`read_image`（`str_replace_editor` 已移出：它晋升后不可达，改为经网关按需取回）
- 首次工具调用后目录收敛到 `residentTools` 白名单
- 其余工具（skill / 记忆 / subagent / workflow / goal / 后台任务 / web 搜索 / 压缩 / plan-mode / MCP）仍然全部装配、随时可用，但 schema 不进顶层；模型通过 `tool_gateway` 的 `list/search` 发现、`call` 调用
- `grep` / `glob` 已移出常驻，需要时经 `tool_gateway` 调用；`apply_patch` 同样只在网关侧

## 配套插件

| 插件 | 作用 |
|---|---|
| `dsh-lean-batch` | 工具索引里的 `batch` 工具：模型写一段程序，程序内经 `ctx.tools.execute()` 调用本会话可见工具，中间结果不进对话。不装它时索引中的 `batch` 会是死条目 |
| `dsh-lean-tool-labels` | toolview 精简工具行标签（紧凑渲染） |

## 注意

- 同路径 `*.mjs` 会命中 Node ESM 缓存：改源码后需重启宿主，或换新入口路径 + release URL
- 已在运行的会话不受影响，它绑定创建时的 standing composition

## 脱敏说明

本仓库发布前已脱敏：

- 本机绝对路径 `/Users/<本机用户名>` 统一替换为 `/Users/USER`；中文私有目录改为 `projects`
- LaunchAgent 标识 `com.<本机用户名>.dsh-web` 替换为 `com.USER.dsh-web`
- 本机私有项目名、私有中转与供应商名、内部模型别名、本地会话 ID 全部改为中性占位：
  `cua-server`、`router` / `router-responses` / `router-alt` / `relay-primary` / `relay-cn` /
  `proxy-api`、`model-a` / `model-b`、`session-example-*`
- **不发布** `cache/lean-config-schema.json`：该文件是宿主 schema 快照，会列出本机安装的
  全部第三方与本地插件，且含本机 profile 名。需要时本地自行生成：
  `dsh --dump-config-schema > ~/.dsh/cache/lean-config-schema.json`
- 未包含 `research-*/`、`_archive-*/`、`.maintenance/`（内部会话原始日志，含内网地址等）
- 提交历史已重建为单个脱敏提交，历史版本中不再包含上述任何标识
- 复核结果：用户名 / 私有项目名 / 私有供应商 / 会话 ID / token / API key / 私钥 /
  内网 IP / 邮箱 / 明文密码 **在当前树与 git 历史中均为 0 命中**

> 占位名不是可用配置：`modelPolicies` 等处需替换为你自己注册的 provider / model，
> 否则该路由永远不会匹配（对第三方而言等同于关闭该条钉扎）。

## 许可

派生自 `anchored-flash`（MIT）。`plugins/dsh-lean-batch` 标注 MIT。本仓库未附带原始 LICENSE 文件，如需再分发请自行补齐上游许可声明。
