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
cache/lean-config-schema.json →  ~/.dsh/cache/lean-config-schema.json
```

## 依赖

- DeepSeek Harness **0.1.7+**（本预设使用 `@deepseek-ai/dsh-agent-preset` 声明格式）
- 30+ 个官方插件 `@deepseek-ai/dsh-*`，由 DSH 本体提供
- `dsh-lean-batch` 的 peerDependencies：`@deepseek-ai/cordis >=4.0.0-rc`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-ptc-runtime`
- 可选 MCP 工具：`@playwright/mcp`、`github-mcp-server`、`rea-agent`、`uvx`

## 安装

1. 按上面的结构把各目录放到对应位置
2. **必须修改** `preset/lean.patch.yml` 中的占位路径：

   ```text
   /Users/USER/...   →   你本机的实际路径
   ```

   共 15 处（历史 `.bak-*` 中同样存在），全部位于 MCP server 的 `command` 与 `env` 段
   （`uvx`、`github-mcp-server`、`rea-agent`、`node`、`PATH`、缓存目录等）。
   如果不用这些 MCP 工具，可整段删除，不影响预设核心行为。

3. 激活补丁：`setBundleEnabled('@local/dsh-agent-preset-lean', true)`
4. `preset/package.json` 的 `test` 脚本含 macOS 应用路径，按你的安装位置调整

## 工具曝光策略

- **首轮**：`bash`、`str_replace_editor`、`read`、`rule_load`、`tool_gateway`
- 首次工具调用后目录收敛到 `residentTools` 白名单
- 其余工具（skill / 记忆 / subagent / workflow / goal / 后台任务 / web 搜索 / 压缩 / plan-mode / MCP）仍然全部装配、随时可用，但 schema 不进顶层；模型通过 `tool_gateway` 的 `list/search` 发现、`call` 调用

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

- 所有本机绝对路径 `/Users/zhangjiazhi` 替换为 `/Users/USER`（248 处 / 21 文件）
- 未包含 `research-*/`、`_archive-*/`、`.maintenance/`（内部会话原始日志，含内网地址等）
- 复核结果：token / API key / 私钥 / 内网 IP / 邮箱 / 明文密码 **均为 0 命中**

## 许可

派生自 `anchored-flash`（MIT）。`plugins/dsh-lean-batch` 标注 MIT。本仓库未附带原始 LICENSE 文件，如需再分发请自行补齐上游许可声明。
