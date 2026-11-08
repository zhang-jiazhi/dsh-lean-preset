# dsh-lean-tool-labels — 工具行精简标签

把 lean 预设下 `rule_load` 与 `dev_tool_search` 的工具调用行，从通用行的**原始参数 JSON**换成**一行中文摘要**。

## 它解决什么

通用工具行对这两个工具只会把 `argsRaw` 原样铺开：`rule_load` 显示一串 `{"sections":["红线"]}`，`dev_tool_search` 显示 `{"query":"..."}`。信息密度低、扫读成本高。本插件注册 keyed `tool.call.toolview` 渲染器，给它们专属的紧凑行。

## 行为

| 工具 | 摘要内容 |
|---|---|
| `rule_load` | 加载的章节名，如"已加载：红线、证据优先级"；空则显示"无章节" |
| `dev_tool_search` | 检索词与结果条数的一句话概括 |

- 摘要**只由调用自身参数推导**，因此运行中的行已能正确显示，不需要等结果回填
- 折叠体内保留未截断的完整参数与完整结果
- 中英双语（跟随界面语言）
- 摘要为**纯函数**，可单测

**放置策略**：不改任何已发布 bundle。挂载宿主半（空 `apply` + `inject[]`）仅用于发布包的 client face，客户端半注册 `tool.call.toolview` 条目。

## 健壮性

宿主 slot 的 payload 在不完整状态（插件热重载中间态、宿主升级后 payload 形状变化）可能是 `null`；渲染阶段抛错会让**整块区域白屏**而不是只坏一行。因此取属性前统一做对象校验，并对 `JSON.stringify` 的循环引用做了兜底。

## 安装

```bash
dsh plugin --profile web add github:zhang-jiazhi/dsh-lean-tool-labels
```

安装后需重启 dsh。

## 结构

```
lib/index.js     宿主半：空 apply + inject[]（发布 client face 用）
lib/client.js    客户端半：tool.call.toolview 渲染器 + 摘要纯函数
cordis.patch.yml insert 行
test/client-smoke.mjs  51 条断言：zh/en 键集合一致、摘要全分支、参数解析容错
```

```bash
node test/client-smoke.mjs
```

## 注意

本插件针对 **lean 预设自带**的两个工具。其它预设下不注册渲染器，不影响通用行行为。

## License

MIT
