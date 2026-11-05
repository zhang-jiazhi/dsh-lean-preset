# dsh-lean-preset

DeepSeek Harness (DSH) 的 **Lean 预设**：核心规则与专项目录自动提供，其余能力通过 tool_gateway 按需加载。

派生自 `anchored-flash`（MIT）。设计目标是在同等 token 消耗下减少轮次、提高工具选择准确率、减少无意义探索。

## 依赖

- DeepSeek Harness **0.1.7+**（本预设使用 `@deepseek-ai/dsh-agent-preset` 声明格式）
- 30+ 个官方插件包，均为 `@deepseek-ai/dsh-*`，由 DSH 本体提供，无需单独安装
- 可选的 MCP 工具：`@playwright/mcp`、`github-mcp-server`、`rea-agent`、`uvx` 等
- `plugins/dsh-lean-batch` 的 peerDependencies：`@deepseek-ai/cordis >=4.0.0-rc`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-ptc-runtime`（均由 DSH 本体提供）

## 安装

1. 把本目录放到 `~/.dsh/.agent-presets/lean`
2. **必须修改** `lean.patch.yml` 中的占位路径：

   ```text
   /Users/USER/...   →   你本机的实际路径
   ```

   涉及 15 处，全部位于 MCP server 的 `command` 与 `env` 段（`uvx`、`github-mcp-server`、
   `rea-agent`、`node`、`PATH`、缓存目录等）。若这些 MCP 工具你不使用，可整段删除，
   不影响预设的核心行为。

3. 安装配套插件 `plugins/dsh-lean-batch`：

   ```bash
   cp -r plugins/dsh-lean-batch ~/.dsh/local-plugins/
   ```

   它提供工具索引里的 `batch` 工具（模型写一段程序，程序内经 `ctx.tools.execute()`
   调用本会话可见工具，中间结果不进对话）。不装它的话，`tool_gateway` 索引里的
   `batch` 会是死条目。

4. 通过 pluginManager 的 `setBundleEnabled('@local/dsh-agent-preset-lean', true)` 激活补丁
5. `package.json` 的 `test` 脚本内含 macOS 应用路径，按你的安装位置调整

## 目录说明

| 文件 | 作用 |
|---|---|
| `preset.yml` | 预设元信息（名称、描述、排序） |
| `lean.patch.yml` | 主配置：插件装配、工具曝光策略、MCP 接入 |
| `package.json` | DSH bundle 声明（`dsh.bundle.patch`） |
| `tool-bootstrap*.mjs` | 首轮工具集与晋升/压缩目录控制 |
| `tool-gateway*.mjs` | `tool_gateway` 的 search/describe/call 实现 |
| `tool-call-normalizer*.mjs` | 工具调用参数规范化（含 `~` 展开） |
| `rules-hybrid*.mjs` | 核心规则自动注入 + 专项目录按需加载 |
| `skills-on-demand*.mjs` | 技能按需加载 |
| `observation-contract*.mjs` | 观察契约 |
| `compaction-*.mjs` | 压缩阈值、epoch 与 refill 保护 |
| `custom-bash.mjs`、`shell-*.mjs` | bash 工具定制与输出规范化 |
| `instruction-hint.mjs`、`todo-anchor.mjs` | 提示与 todo 锚定 |
| `plugins/dsh-lean-batch/` | 配套插件：提供工具索引里的 `batch` 工具（见下） |

## 工具曝光策略

- **首轮**：`bash`、`str_replace_editor`、`read`、`rule_load`、`tool_gateway`
- 首次工具调用后目录收敛到 `residentTools` 白名单
- 其余工具（skill / 记忆 / subagent / workflow / goal / 后台任务 / web 搜索 / 压缩 / plan-mode / MCP）仍然全部装配、随时可用，但 schema 不进顶层；模型通过 `tool_gateway` 的 `list/search` 发现、`call` 调用

## 注意

- 同路径 `*.mjs` 会命中 Node ESM 缓存：修改源码后需重启宿主，或换新的入口路径 + release URL
- 已在运行的会话不受影响，它绑定创建时的 standing composition

## 许可

派生自 `anchored-flash`（MIT）。本仓库未附带原始 LICENSE 文件，如需再分发请自行补齐上游许可声明。
