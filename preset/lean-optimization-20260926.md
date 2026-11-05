# lean 预设与工具优化：本会话结论 + 待研究项

日期：2026-09-26
产出者：一个会话（含 3 名 agent-team 队友 T1/T2/T3 的调研 + 2 组真实 A/B）
用途：交接给另一个 harness 继续研究。**本文自包含，不需要原会话上下文。**

---

## ⚠️ 2026-09-26 晚补丁（本文写成之后发生的事实，先读本节再往下用）

1. **§5.3 的"profile 层挂载"修复已被撤销，勿照做。** rc.2 桌面 App 会在宿主级拉起
   预设声明的 MCP 服务端，profile 层再挂一份 → github / playwright-persist 各起两份
   进程（实测多付 ~260 MB RSS），且 mcp__*__* 工具命名空间有撞名风险。MCP 声明的
   单一事实来源**回归 lean.patch.yml**。备份：`cordis.patch.yml.bak-before-mcp-dedupe-20260926`。
2. **§5.3 的根因已改判，§7.D.12 的"两轮重启"悬案已结。** 预设层 MCP 静默失败的真因是
   **GUI 宿主 PATH 抽签**：launch-environment 偶发捕获 shell 环境失败时宿主只剩
   `/usr/bin:/bin:/usr/sbin:/sbin`，裸 `npx` 与 github shim 末端的 `#!/usr/bin/env node`
   全部 ENOENT，被 `failOnStartupError: false` 静默吞掉。修复 = `lean.patch.yml` 的
   mcp-playwright / mcp-github 两条 `config.env` 钉死确定性 PATH（web 端 launchd PATH
   与其兼容，覆盖无副作用）。**"为什么要两轮重启才生效"= PATH 抽签的随机性，不是装载
   时序**——§7.D.12 后半句"值得查"作废，不再研究。
3. **§7 待研究项的进一步裁决**（后续会话产出，验算与数据见 `research-20260926/`）：
   - **B.4（compactionTools 剪枝）→ 结构性放弃，不必再验证。** 压缩分支只存活 1 个请求
     （`promoteOn: either` 下，下一个 `tool/call` 或 `assistant/message` 立即再晋升），
     剪枝最多省 1 请求 × 每工具 144-331 token ≈ 2-5k；代价是制造第二个全新目录签名，
     让紧随的晋升请求在压缩后 ~8 万 token 的 ctx 上近全价重读（缓存存活 0-10%）。
     负收益，`tool-bootstrap.mjs:574-580` 注释的理由结构性成立。
   - **B.6（bootstrapTools := residentTools）→ 降级，不建议实验。** 晋升事件发生在请求 2，
     E 的上界 = 请求 2 的小 ctx；改动的代价是请求 1 恒带 14 个 schema（会话开头零缓存、
     纯全价）+ 失去 anchor 行为（issue #11 的 maxTokens 锚定）。除非 A.1 的 E 分布翻案。
   - **A.1 + A.3 + C.9 → 合并为零采集离线管道**（已建成：`research-20260926/ev-pipeline.py`）。
     "331 vs 227 vs 144"不是测量误差而是**异质性**：331 是 A/B 中 21 个（MCP 为主）工具的
     均值，144 是候选工具中位数。正确做法是放弃标量，用 projcache 的 per-tool schema
     token 向量做逐工具 EV；E 的逐会话分布同样可从既有 projcache/日志推导，无需新采集。
     ⚠️ **v2 管道补充的方向性发现**（详见 `research-20260926/findings-20260926b.md`）：
     目录变更事件合计只占全库 uncached 输入的 **13.8%**（unlock 归因仅 5.6%）——
     解锁策略继续深挖的绝对天花板就这么多；缓存命中率的大头（~86%）是任务内容的
     有机增长，后续提效看内容纪律（结果裁剪/重复读取），不看目录策略。
   - **A.2 → r 不必等计费数据。** r 就是所用路由的缓存读定价（公开价目可查；DeepSeek 系
     缓存命中价 ≈ 输入价 1/10，与旁证 r≈0.1 吻合），按实际启用路由逐个取官方价即可把
     全部结论转成绝对金额。
4. **索引失同步已修（20260926-indexresync）。** 守门测试 `tests/` 曾 2 红：① 描述的
   常驻清单仍为 13 名（漏 send_message）且索引把它列为"需解锁"——会诱导模型为已常驻
   工具白付一轮 `dev_tool_search`，恰好打击 §5.1 的头号改动；② `mcp-computer-use` /
   `mcp-blender` 停用后索引仍承诺对应族（9-22 正为此恢复过它们，**停用 server 必须同步
   撤索引行**，重新启用时加回）。已修：描述常驻清单补 send_message、索引撤下三处、
   新入口 `dev-tool-search-entry-20260926-indexresync.mjs`。`node --test tests/` 178 项全绿。
   **操作纪律新增一条：改 `residentTools`/MCP disabled 时必须同步改 `dev-tool-search.mjs`
   描述与索引，并跑 `node --test tests/`。**
5. `/tmp/lean-opt` 原始调研产出已拷入 `research-20260926/`（T1-T4 + work/），§8 的
   /tmp 清理风险已解除。
6. **在途 A/B（勿动 residentTools 前先读协议）**：web_search + web_fetch 已于
   2026-09-26 03:56 加入 residentTools/compactionTools（16 名），切点 marker 在
   `research-20260926/ev-pipeline-out/web-ab-cutoff.txt`，读数条件与回滚规则见
   `research-20260926/findings-20260926c.md` §2 与管道 `web_ab` 节。收数完成前
   不要再改常驻集，否则 A/B 作废。

---

## 0. 一句话现状

lean 的核心机制（bootstrap 4 → 晋升到 residentTools 白名单，其余按需 `dev_tool_search` 解锁）
**方向是对的**，但**"解锁策略"这一层之前没有被数据驱动地优化过**。本会话把它的成本结构测清楚了，
落地了 4 项改动，并留下 12 项待研究。

---

## 1. 机制（已查清，含文件:行）

| 问题 | 结论 |
|---|---|
| 晋升发生在哪一步？ | **不是"一步"，是每次 `system-prompt/assemble` 的读时推导**。信号：`tool/call` / `assistant/message`（`lean/tool-bootstrap.mjs:54-58`、`:536-548`）；压缩后需重新晋升（`compaction-epoch.mjs:108-136`） |
| 装配 vs 请求构造顺序 | `dsh-agent-loop/lib/index.js:920` 先 `assemble()`，`:1062` 用同一份 `assembly.tools` 构造请求 → **装配时刻可见的一切都进当次请求，无"下一轮才生效"的固有延迟** |
| 目录从哪取 | 每请求从**活 registry** 取（`dsh-tools:2722`、`dsh-system-prompt:319-345`）；但**配置在挂载时读一次**（`dsh-agent-preset:25` → `registry:489-528/662-670`） |
| 已有的"预置"实现 | `tool-bootstrap.mjs:361-595` 的**团队块**：意图正则 `:373-374` + sticky memo `:405/445-481` + 信号读 `agent/inbox/spliced` 与 `user/message` `:426-442` + `teamToolsFor` `:488-492`，在晋升/压缩/bootstrap 三分支全部并入 `:556/:582/:593-595` |
| 三个 keep 集 | 晋升：`residentTools ∪ expandUnlockedNames(unlockedFor(session)) ∪ teamTools`（`:556`）；压缩后：`compactionTools ∪ 同上`（`:582`）；bootstrap：`bootstrapTools ∪ teamTools`（`:593-595`） |
| 改 `lean.patch.yml` 要不要重启？ | **不要**（热加载），但**只对新会话生效**；且需 `pluginManager.setBundleEnabled` 重新协调（`plugin-manager:416`）——注意：本会话实测**只改磁盘文件不够**，需要一次完整重启才生效 |
| 改同目录 `*.mjs` | **命中 Node ESM 缓存**，必须**换入口文件名 + release URL**（本目录的既定做法，见多处注释） |
| MCP 服务端何时起 | **挂载即 spawn**（`dsh-mcp-client/lib/index.js:40` `new StdioClientTransport({command...})`、`:644 await generation.connect(transport)`），**与解锁无关**。`transport` 被写死 `z.const("stdio")`，**无 lazy/onDemand 选项**。MCP 服务端是**宿主级单例**（`:669` 实测 51 个会话目录只对应 3 个 MCP 进程，存活时长 == 宿主进程时长） |

---

## 2. 已测的成本参数（可直接引用，注意口径）

| 参数 | 值 | 来源/口径 |
|---|---|---|
| **携带成本** | **331 token/工具/请求** | 解锁 4→25 工具后每请求 4,416→11,366。(11366−4416)/21=330.95。**但只有一个前置样本** |
| 同上，独立实测均值 | **227** | T3 独立复测 |
| 同上，lean 会话里候选工具的真实 schema | **中位 144 / 均值 146.4**（n=2,567） | T2 从 projcache `contextHeaders.val.headers[].tools[].tokens` 量 |
| **解锁代价** | **= 解锁时刻的 ctx**（全价重读紧随其后的那一个请求） | 目录变更后首个请求 `uncached` ≈ 全部 ctx |
| 每次按需解锁的额外往返 | **+1 个请求** | A/B：预置组 15 请求 vs 按需组 28 请求 |
| 全量常驻 | 127 工具 / **37,548 token** | 实测 |
| 全库缓存命中 | 累计输入 **96.9% 走缓存读**（cacheRead 6,307,214,971 / uncached 202,901,719）；单步未命中占比中位 **1.87%** | 旁证 r≈0.1，但**无计费实证** |

**口径警告**：`331` 与 `144`/`227` 差 2.3 倍，**EV 的正负会因此翻转**。用哪个必须在结论里写明。
`precision`/`waste`/`micro 召回` **与 token 权重无关，是稳健的**；**EV 的绝对值与正负依赖它**。

---

## 3. 五条"优化直觉"的裁决（结论先行）

| # | 直觉 | 裁决 | 破衡 r |
|---|---|---|---|
| 1 | 开头一次解锁齐 | **方向对，幅度错**。"省 97%"是 **miss token 比值不是省钱比例**；r=0.1 时真金白银省 **87%**；计入往返后破衡 r 从 0.52 掉到 **0.17~0.36** | r\*=0.52（δ=1）/ 0.69（δ=0.5） |
| 2 | 越早越好 | **最稳健的一条**。单工具判据 `g > T·r/(1−r)`，r=0.1 时阈值 36.8 tok/req，而真实 ctx 增长 549~3,045 tok/req → **余量 15~83 倍，边际上恒成立** | r\*=0.62~0.90 |
| 3 | 省请求数 | **方向对，量级被漏算** | 计入往返后 0.17~0.36 |
| 4 | 预测集上限 K | **决定性成立** | r\*=**0.0108** |
| 5 | 折进晋升目录 | **最高价值，且已实现** | 不适用 |

### 3.1 第 4 条对"全量常驻"可以定案否决
`residentTools: ['*']` 破衡 r = **1.08%**，**低于任何真实缓存读价（最低 2%）**。
四种 r 全亏：r=0.02 → −3.23M；r=0.1 → −31.3M；r=0.2 → −66.4M。
**建议写成"已否决，破衡 r=1.08%"，不再列为候选。**

### 3.2 第 2 条与第 4 条不冲突（常见误读）
它们管**正交的两个变量**：解锁**时刻 t** vs 解锁**包大小 K**。
"把'早解锁'和'多解锁'合成一句话"才会打架。**真正的风险变量是精度 p，不是时间 t。**

### 3.3 第 5 条的正确表述（重要修正）
**「事件数→0」不成立** —— 晋升那 **1 次**目录变更**消不掉**。
可达成的上限是：**unlock 的额外事件与往返省得掉，晋升那 1 次免不了 → 最低事件数 = 1**。
但 **K 骑在那次晋升事件上 → 预置的边际事件成本 = 0**（本会话实测：首个 `request/header` 就已带 13 工具 = bootstrap 4 ∪ team 9，全会话只有 1 次目录变更）。

---

## 4. 数据驱动的"预测集该放什么、放几个"（T2，201 个真实 lean 会话 / 29,846 次 tool/call）

### 4.1 核心结论：broad top-N 会亏，K 应该极小
| 规则 | micro 召回 | precision | waste | EV/会话 |
|---|---|---|---|---|
| R0 只预置 `send_message`（N=1） | 18.3% | **44.8%** | 55.2% | **+16,167** |
| R0 历史 top-5 | 27.3% | 13.3% | 50.2% | +8,946 |
| R1 历史 top-5 | 11.0% | **5.5%** | 89.1% | 负 / 接近 0 |

- **R0 下 N=1 是 EV 与 precision 双料最优**（precision 是 N=5 的 3.4 倍）→ 现状已落在最优点
- **现状（R1）下 K\*≈2，上界 K=4；K≥5 无证据**
- **52.2% 的会话完全不用任何非驻留工具**；top-1 就 83.1% 纯浪费

### 4.2 唯一能提升 precision 的路子
**关键词分域 + 域内只取 top-m**，并**砍掉 6 个 0% 命中的域**（3D/桌面/记忆/目标/GitHub/批量——
其中 `3D` 触发 38 次、真实用到 **0 次**，还误匹配 UUID 里的 `3d`）。
保留 6 域：团队 62.1% / 技能 33.3% / 后台 23.5% / 浏览器 17.2% / 联网 17.1% / 插件 16.9%。
**效果：precision 20.0%（top-5 的 2.2 倍）、会话命中 41.7%、EV(B1) +9,074（top-5 仅 +2,547）。**
⚠️ **字面版"关键词→通配符整组"不可用**：K 均 40.5 工具、precision 2.4%。

### 4.3 短会话的前提方向是反的
成本 ∝ 长度（S=39 时 691/工具，S=2098 时 29,000/工具，**差 42 倍**），收益是一次固定解锁
→ **破衡命中率 P\* 随长度上升**。
- **S<5（9.5% 会话）：命中率 0.0%、94.7% 不用非驻留工具 → 绝不预置**
- 5≤S<300（80.5%）：K≈2–4 最划算
- S≥300：top-1 命中 6.2% 但 top-4 达 43.8% → **长会话必须靠关键词分域，不是加大 N**

---

## 5. 本会话实际落地的改动（4 项）

### 5.1 配置层：`compactionTools` 与 `residentTools` 各加 `send_message`
`~/.dsh/.agent-presets/lean/lean.patch.yml:111` / `:130`
依据：当前配置期 84 次按需解锁共 3,791,634 全价 token 失效，其中 `send_message` 独占 1,619,807
（42.7%，14 次事件，中位 ctx 118,527——**它总在会话后段被解锁用于汇报**）。其 schema 仅 140 token，
常驻代价 140×10,477 步×0.1 ≈ 146,678 → **净省 1,473,129**。
> 原注释「单次调用仅 0.2%」用的是**单请求上下文占比，漏掉了整段全价重读** —— 这是本会话发现的一个口径错误。

### 5.2 `dev_tool_search` 的 Usage 行改写（**最重要的行为层改动**）
`~/.dsh/.agent-presets/lean/dev-tool-search.mjs`（+574 字节）+ 新入口 shim
`dev-tool-search-entry-20260925-familyunlock.mjs`（`?release=20260925-familyunlock`）+ preset `:358` 指向新 shim。

**改前**（主动推荐整族解锁）：
> "Exact names work, and trailing `*` unlocks a whole group (`mcp__github__*`, `dev_*`)."

**改后**：
> **Prefer exact names; group patterns are a measured loss.** Trailing `*` unlocks a whole group, but
> every unlocked tool stays in the catalog for the rest of the session at ~330 tokens per request each.
> Measured across 201 lean sessions: 69.9% of non-resident tools that entered a catalog were never called
> (920 of 1317 tool-session pairs), and the waste concentrates in group unlocks — `mcp__github__*` 218,
> `mcp__computer-use__*` 58, `dev_*` 54. Unlock the specific tools you will actually call; paying one extra
> round for a second exact-name unlock is cheaper than carrying a family you do not use.

**依据（本会话实测）**：非驻留暴露 1,317 个「会话×工具」对中 **920 个（69.9%）从未被调用**；
溢出 schema 合计 **162,587 token**；按域：团队 282 / github **218** / computer-use **58** / dev **54** /
联网 23 / **浏览器 3 / cordis 2** → **浪费集中在组解锁，精确解锁的域几乎不浪费**。

⚠️ **改动生效但效果未做 A/B**。

### 5.3 桌面端 MCP 修复（`~/.dsh/profiles/desktop/cordis.patch.yml`）
> ⚠️ **本节结论已被 2026-09-26 晚补丁改判**（profile 层 insert 已撤销、根因改判 PATH 抽签），先读文首补丁节。以下为历史记录。
**症状**：桌面端目录里**一个 MCP 工具都没有**，`dev_tool_search` 搜不到也解锁不了
（连一直配置着的 `experimental-browser-use-playwright-mcp` 也没产出 `mcp__playwright-mcp__*`）。

**排查路线（供参考，避免重走）**：
- ✅ 确认桌面 App 读该文件（每次启动后 +4 秒重写它，且**完整保留**外部追加的块）
- ✅ 排除"配置没被读取"
- ❌ 排除"版本错配"：把 profile 的 `dsh-mcp-client@0.1.7-rc.1` 改名遮蔽、回落到 `alpha.2`，**仍零工具**
- ✅ **最终解**：在 profile 的 `cordis.patch.yml` 追加 `- insert:` 块，把 `mcp-github` 与 `mcp-playwright`
  两条**从 preset 一字不改照抄到 profile 层**（`serverName` 保持 `github` / `playwright-persist`，
  解锁后的工具名与网页端一致）→ 重启 App 后 **MCP 完全恢复**（搜到 144 个、解锁成功）

⚠️ **生效需要一次完整 App 重启，不是立刻**（本会话在重启后 20 秒查仍为空，需要再一轮重启才生效——精确机制未查明）。

### 5.4 停用 cua + blender（省 ~198 MB）
`lean.patch.yml:770`（`mcp-computer-use`）与 `:834`（`mcp-blender`）各加 `disabled: true`。
实测内存：github 77 / playwright 230 / cua 98 / blender 100 MB → 从 **~505 MB 降到 ~307 MB**。
（`mcp-serena` 与实验组 `computer-use`（`:805`）本来就 disabled。）
> **修正一处过时记录**：`lean.patch.yml:670` 原写「playwright+github+computer-use 全链路 6 个进程合计约
> 110 MB RSS」—— **实测约 337 MB，过时约 3 倍**（playwright 现在多了一层 `npm exec` 包装进程）。
> 已把 `:670`/`:677` 更新为实测值。

---

## 6. ⚠️ 本会话我犯的错（后来纠正了前提，别重走）

1. **把"批量编辑脚本提前退出"当成改动成功** —— 脚本在最后一条替换匹配失败时 `raise SystemExit(1)`，
   **文件从未写入**，但前面几条已打印 `✓`。**教训：写盘后才退出 + 写后回读验证。**
2. **回归测试跑的是另一个副本** —— `test/hardfail-server.mjs` 把客户端路径**硬编码到 `/tmp` 下的副本**，
   导致我改的 `lib/client.js` 从未被执行，白排查很久。**教训：先验证测试跑的是你改的代码。**
3. **把"复现脚本"直接当回归测试** —— 原脚本断言的是**缺陷行为**（等 `ballState==='done'`、
   断言"请求应持续增长"），修复后必然失败，且失败原因看起来像"修复没生效"。**必须反转成断言应然行为。**
4. **对整个排查链路的前提没质疑** —— 有两轮我把"桌面端与网页端共用宿主"当默认前提，
   在**错误的宿主**上查了半天（`dsh web` vs 桌面 App 自带宿主）。
   **教训：先确定"我观察的是哪一端"，再往下查。**
5. **让你在无诊断信息的情况下重启了 5 次** —— 只有第 4 次产生了信息增量。
   **正确顺序：先拿日志 → 再动配置 → 最后重启验证。**

---

## 7. 待研究项（12 项，交给另一个 harness）

### A. 需要真实数据才能定论的
1. **`E` 的逐会话分布缺失** —— 现在只有聚合量（3,791,634 / 274 会话）。**K 上限完全由 E 决定，差 15 倍**
   （E=13,838 → N=100/r=0.1 时 K_max=3.8；E=214,797 → 58.4）。
   **任何不写 E 的 K 上限数字都是空话。** 需要逐会话 E 的分布才能给全局最优 K。
2. **`r` 从未用计费数据验证** —— 所有结论只能表达为"破衡 r"。目前旁证只有 96.9% 缓存命中率。
   若拿到真实计费，可把全部结论转成绝对金额。
3. **token 口径需要统一** —— `331` vs `227` vs `144` 三个数差 2.3 倍，**EV 正负会翻转**。
   建议做一次受控实验（同一工具集，改变 residentTools 数量，测每请求 token 增量）拿到权威值。

### B. 已判定不可行 / 需推翻现有结论的
4. **`compactionTools` 剪枝（T3 建议，被代码阅读否证）** —— 它是**刻意**与 `residentTools` 相同
   （`tool-bootstrap.mjs:574-580` 注释：不同会导致压缩后目录 churn，而新签名只保住 0-10% 旧缓存）。
   **需要验证这个注释的理由在当前版本是否仍成立**；若成立，T3 的方案应彻底放弃。
5. **`dsh-mcp-client` 懒加载（"挂载只注册、首调才 spawn"）** —— preset `:673-676` 已记录不可行
   （`apply()` 里 `startConnection` 无条件执行并 await；且 standing composition 跨会话共享，
   按需启停会波及同预设的所有会话）。
   **但那个注释没考虑一个新角度：`dev_tool_search` 能搜到的前提就是"已注册"，而注册的前提是"已连接"
   —— 所以"懒加载"与"可搜索"在 stdio 型 MCP 上天然冲突。** 若要突破，需要 MCP 协议层或静态声明。
6. **`bootstrapTools := residentTools`（放弃 anchor）** —— 是让事件数真正→0 的唯一路径，
   **完全未实测**，有行为学代价（第一个请求就带全部 schema）。

### C. 尚未落地的行为优化
7. **关键词分域规则表落地（T2 §2.3）** —— precision 可从 12.6% 提到 20.0%。
   ⚠️ 但**入口工具是历史 top-1 而非人工选定**，上线前需人工复核；
   且**时间漂移**（团队类工具在最近 30% 会话普及率大幅下降）→ 历史排序会过时，需定期重算。
8. **"解锁 ∧ 调用"剪枝的 churn-free 版本** —— 思路：把 `unlockedFor(session)` 与实际调用过的集合取交，
   **在晋升与压缩两个分支上同样处理**（这样两分支目录一致、不产生 churn）。
   风险：模型可能解锁后在**下一步**才用，剪掉会逼它重新解锁（正是 `:574-580` 警告的失效模式）。
   **需要评估这个风险的实际发生率。**
9. **单工具准入判据自动化** ——
   > 工具值得常驻 ⟺ 每会话期望消除的失效 token > `331·N·r·δ/(1−r)`（r=0.1、N=38 → 阈值 1,398）
   回验 `send_message`：1,619,807/274 = 5,912 > 1,398 ✓ 与已有决定一致。
   可做成脚本，定期用最新语料重算这个清单。
10. **`dev_tool_search` 描述改写的 A/B** —— 改动已上线但**没有效果数据**。
    可测：新会话的**整族解锁次数**与**溢出率**是否下降。

### D. 明确排除的（不要重复研究）
11. **全量常驻 `residentTools: ['*']`** —— 破衡 r=1.08%，低于任何真实缓存价，**已否决**。
12. **桌面端 MCP 故障的"版本错配"假设** —— **已被否证**（遮蔽实验）。
    真实原因是"这些 MCP 没有声明在 profile 层"。⚠️ 但**精确机制未查明**：
    为什么挂到 profile 层才生效、为什么要两轮重启才生效 —— 这个值得查（可能是装载时序或 bundle 协调问题）。
    > ⚠️ **本条已被 2026-09-26 晚补丁整体改判**：真实根因是 GUI 宿主 PATH 抽签（见文首补丁节第 2 条），
    > profile 层挂载方案已撤销；"两轮重启"悬案已结，本条不再需要研究。

---

## 8. 关键文件与备份（本会话产生的）

```
~/.dsh/.agent-presets/lean/
  lean.patch.yml                              # :111/:130 send_message；:358 指向新 shim；
                                              # :670/:677 内存注释；:770/:834 停用 cua/blender
  lean.patch.yml.bak-before-disable-cua-blender-20260926-024959
  lean.patch.yml.bak-before-memfix-20260925-221810
  lean.patch.yml.bak-before-restore31-20260926-*
  lean.patch.yml.bak-before-revert-20260925-215031
  lean.patch.yml.bak-resident-ab-20260925-130609   # 13:06 基准（config A 之前）
  dev-tool-search.mjs                         # Usage 行改写（+574 字节）
  dev-tool-search.mjs.bak-before-familyunlock-20260925-161717
  dev-tool-search-entry-20260925-familyunlock.mjs

~/.dsh/profiles/desktop/
  cordis.patch.yml                            # 末尾 - insert: 块含 mcp-github-desktop / mcp-playwright-desktop
  cordis.patch.yml.bak-before-mcp-mount-20260925-221810
```

**调研原始产出**（T1/T2/T3 的完整报告，含验算脚本）：`/tmp/lean-opt/T1-mechanics.md`、`T2-prediction.md`、
`T3-model.md`、`T4-整合结论.md`；验算脚本在 `/tmp/lean-opt/work/`。
⚠️ `/tmp` 会被清理，**需要长期保留的话请先拷走**。
