# 📚 dsh-novel-writer — 给网文作者的本地写作工作台

[English](./README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![npm downloads](https://img.shields.io/npm/dm/dsh-novel-writer.svg?style=flat-square&color=green)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.3-339933.svg?style=flat-square)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.1.1--rc.2-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)
[![siweina/dsh-novel-writer MCP server](https://glama.ai/mcp/servers/siweina/dsh-novel-writer/badges/score.svg)](https://glama.ai/mcp/servers/siweina/dsh-novel-writer)

**18 个工具，覆盖「动笔前取材料 → 写完量化自检 → 改稿按优先级复测 → 跨章结构体检」整条流程。**
动笔前**一次调用取齐 16 项材料**（漏读一样就漂移）；改稿不再只丢给你一堆数字，而是**按严重度排好的待办**（带原句行号、当前值与目标值、原著锚段，**只给方向不代写**）；跨章层面能查「线断了、人丢了、伏笔忘了」。
句式 / 情感 / 语义全部**在本地算**：24MB 中文模型随包分发，**零 API 花费、正文不出本机**。
为 DeepSeek Harness（DSH）打造；同一套能力也可作为 **MCP 服务器**给 Claude Desktop / Cursor 使用。

🔗 **官网**：<https://siweina.github.io/dsh-novel-writer/> · **技术文档（18 个工具的参数与示例）**：<https://siweina.github.io/dsh-novel-writer/tools/>

[官网](https://siweina.github.io/dsh-novel-writer/) · [技术文档](https://siweina.github.io/dsh-novel-writer/tools/) · [安装](#安装) · [写作流程](#写作流程一条能走完的闭环) · [60 秒上手](#60-秒上手) · [看看输出](#看看输出长什么样) · [18 个工具](#提供的工具18-个) · [MCP 服务器](#mcp-服务器非-dsh-用户也能用)

---

## 写作流程（一条能走完的闭环）

| 步骤 | 你说什么 | 用哪个工具 | 拿到什么 |
|---|---|---|---|
| ① **取材料** | 「给下一章取材料」 | `novel_chapter_brief` | **一次调用**取齐 16 项输入：上一章结尾原文（承接口）/ 上一章钩子 / 本章大纲方向 / 相关人物卡 / 待回收伏笔（含**埋了多久**）/ 世界观用语规范与禁词 / 六维基线 / 原著锚段与句式骨架 / 上一章自检结论 / 禁用清单 / 开写清单——缺哪项、为什么、怎么补写在 `degraded` 里 |
| ② **动笔** | 「写第 N 章」 | `novel_new_chapter` · `write` | 新章文件（自动附基线 μ 摘要与原著锚包）；锚段只用来**校准语感**（不照骨架造句），数字只做事后校验 |
| ③ **自检** | 「自检这一章」 | `novel_style_check` · `novel_sentence_analysis` | 相似度 + 偏差清单 + 六维对照（带内 ✓ / 出带 ⚠）。**只有偏离明显（≥2 倍容差）或读起来确实别扭时才改**——单一维度轻微出带属正常波动，不要为对齐数字改文 |
| ④ **改稿** | 「把这章排成改稿清单」 | `novel_fix_plan` | 按「严重度 → 难度 → 行号」排序的待办（默认上限 **12 条**），每条带原句行号、当前值/目标值、锚段与改写方向；**分批改**（同段同类合并），改完最多 `verify` 一次 |
| ⑤ **跨章体检** | 「看看全书结构」 | `novel_plot { action: "graph" }` | 伏笔埋设跨度 / 人物连续缺席区间 / 剧情线最大空档 / 时间线顺序 / 大纲方向与正文的偏离 |

> **全程本地、只读优先**：开写包与结构视图**不写任何文件**；改稿台只写自己的清单文件、**从不改正文，也不代写正文**；语义检索与情感分析零 token。

> **省 token 模式（v5.1.0 新增）**：侧边栏「精简工作流」开关（或 `novel_sentence_config` 传 `leanWorkflow=true`）打开后只保留一条原则——**工具按需调用**：不主动跑自检、不复测清单、不登记伏笔/钩子/摘要；报告类工具未显式传 `brief` 时默认走精简输出（风格画像实测 181 字符 vs 完整 1725 字符）。
>
> **v5.1.0 成本与手感修复**：v5.0.0 曾把「写完必须自检 + 收尾三件」「改稿逐条 mark + 反复 verify」写成必做清单，一章从 3 次调用涨到 6 次、改稿要 30+ 次；同时"照骨架造句"与"任一维度出带必改"会让文章越改越僵。本版全部改回**按需**：写一章 **2 次调用起**，改稿清单上限 **40 → 12 条**、同一维度只报最严重的 1 段，并明确了**出带不等于缺陷**（抒情/心理/留白段读起来不别扭就保留，可用 `mark` 标 `skip`）。

## 它解决什么问题

| 你的困扰 | 这里给的答案 |
|---|---|
| "我续写的这段，读起来不像我自己写的" | **文笔六维基线**：从句法复杂度 / 修饰密度 / 抽象度 / 动作密度 / 不确定性 / 留白指数六个维度算出原著的 μ±σ，新章逐维对照，出带标 ⚠ |
| "AI 说文风变了，但说不清哪儿变了" | **风格自检**：相似度 + 偏差清单（哪类句式多了、句长偏了多少、主导情绪有没有换） |
| "动笔前要翻六七个工具，还老漏读一样" | **开写包**：一次调用取齐 16 项材料；取不到的在 `degraded` 里说明缺什么、怎么补——**漏读正是文风漂移与设定矛盾的头号来源** |
| "知道这章有问题，但不知道先改哪句" | **改稿台**：按「严重度 → 难度 → 行号」排好待办，每条给原句行号 / 当前值与目标值 / 原著锚段 / 改写方向；改完可三态复测 |
| "线断了、人丢了、伏笔忘了——写到后面才崩" | **结构视图**：跨章算出伏笔埋设跨度、人物连续缺席区间、剧情线最大空档、时间线顺序、大纲与正文的偏离 |
| "分析小说要花钱调 API" | 语义检索与情感分析**全本地推理**，零 token 花费 |
| "伏笔埋了忘了收" | **伏笔登记表**：add / list / scan / done，自动记录每条伏笔在哪些章被提到 |
| "人物设定前后打架" | **设定五张表 + 连贯性审计**（衔接 / OOC / 大纲走偏三件套） |
| "报告看不懂" | 全是**表格化数字 + 原文锚段**，可以直接截图分享 |

## 安装

**方式一：npm（推荐）**

```sh
dsh plugin --profile web add dsh-novel-writer
```

**方式二：从 GitHub 安装**

```sh
dsh plugin --profile web add github:siweina/dsh-novel-writer#main
```

**方式三：MCP（不用 DSH 也能用）** —— 见 [MCP 服务器](#mcp-服务器非-dsh-用户也能用)

要求 **Node ≥ 22.3**。安装后**重启 Web 应用**，侧边栏出现「写作助手功能」面板。

## 60 秒上手

```sh
mkdir -p novels/我的小说     # 把章节文件放进去（第01章.md、第02章.md …）
```

然后在对话里依次说（这就是完整的一章）：

1. **「给下一章取材料」** → `novel_chapter_brief` 一次给齐 16 项输入（等于替你跑了 6~8 个工具，且**不会漏读**）
2. **「写第 7 章」** → 照返回的锚段与骨架写；`novel_new_chapter` 建文件时还会附上基线 μ
3. **「自检第 7 章」** → `novel_style_check` 给出相似度、偏差清单与六维对照
4. **「把第 7 章排成改稿清单」** → `novel_fix_plan` 给出按优先级排好的待办；改完再 `verify` 复测三态

只想先看看家底，就说 **「用 novel_style_report 给我的小说做一次风格画像」**：

```text
全书 1329 字：六维基线 μ=句法复杂度:2.3 修饰密度:35.6 抽象度:0.5 动作密度:101.7 不确定性:2.1 留白指数:7.0
推荐容差 25%/35%/100%…
```

## 看看输出长什么样

**开写包**（`novel_chapter_brief`，动笔前一次调用）：

```text
目标：第 8 章《（无标题）》（尚未创建，文件名推导为 第08章.md）

【上一章结尾原文·承接口】…（上一章末尾 300 / 600 字，按 budget 档位）
【待回收伏笔】
  - [mu5kjla…] 琥珀色齿轮怀表的来历与停摆的指针（high｜第 1 章埋下，已过 6 章）
  - [mu5kjlb…] 海图上红铅笔圈的礁区坐标（high｜第 3 章埋下，已过 4 章）
【相关人物】- 林昭：守码头的女人，父亲失踪后回到旧宅　- 沈砚：随船出海的人
【世界观用语】欧式中世纪沿海城邦；点烛不烧香｜禁用：上香、烧香、时辰、老夫
【风格基线】complexity μ=2.42  modifierDensity μ=22.2  abstractDensity μ=10.06  actionDensity μ=122.45 …
【原著锚段·照这个味道写】[对话] …  [心理] …
【上一章自检】第 7 章六维对照：全部维度在容差带内 ✓
【本章禁用清单】- 禁词：上香（建议改用：点烛）　- 禁词：时辰（建议改用：钟点）
【开写清单】□ 先读锚段再动笔　□ 承接上一章结尾　□ …（共 8 步）
【降级/提示】- 钩子记录里没有第 7 章的钩子（上一章钩子未回填）
```

**改稿台**（`novel_fix_plan`，把诊断变成排好序的待办）：

```text
改稿台：共 13 项待办（严重度降序 → 难度升序）。抽象度过高 ×3、衔接缺失 ×1、禁用词 ×3、语用不符 ×5、句式偏离 ×1。
备注：留白指数 虽出带但差值 8.36 < 门槛 12，已按「无量级差异」忽略 ← 不误报的绝对量级闸

  - [抽象度过高] 严重度 5 / 难度 2（第 5 行）
      id：fix-abstract-5-c2c156d4
      现状：abstractDensity 47.9　目标：0.55~6.95
      原句：林昭大概说不清那种感觉。她隐隐觉得…
      方向：抽象度偏离：全章 47.9（基线 3.75，偏差 +1177.3%），本段 74.38。这句抽象词过密，改成具体动作或物件。
      锚段：林昭把它捏在掌心，翻过来看背面。背面刻着一行小字，被磨得只剩半边。她认出了父亲的名字。
  - [语用不符] 严重度 4 / 难度 2（第 15 行）
      现状：客套禁词「承蒙」（第 15 行）　目标：避免该类客套表达
      方向：「承蒙」属世界观说话方式规范里明确不用的客套表达（honorBad）。这是说法层面的替换，不要顺手改剧情。
```

**风格自检**（新章 vs 全书基线）：

```text
相似度 0.946 · verdict: high
偏差清单：心理占比略多 · 对话占比略少 · 短句占比略少 · 主导情绪由 anger 变为 joy
fixAnchors：3 条原著锚段（对话 / 心理 / 描写各一条，供逐句对照修正）
```

**语义检索**（自然语言，本地向量）：

```text
查询「与那盏没有点的灯有关的段落」→
  第02章.md  0.619  对街那盏灯，亮了。
  第01章.md  0.593  阿澈的目光越过老周的肩膀，落在对街那栋小楼上…
```

**段落结构**：共 34 段（对话 5 / 心理 0 / 混合 15 / 叙述 14）

## 为什么不用在线 AI 写作工具

| | 本插件 | 在线 AI 写作工具 | 通用文本分析库 |
|---|---|---|---|
| 正文是否离开本机 | **否** | 是 | 视实现 |
| 花费 | **0（本地推理）** | 按 token 计费 | 自建 |
| 中文小说专用 | **是** | 通用 | 否 |
| 风格基线（μ±σ） | **有** | 少见 | 无 |
| 与 DSH 集成 | **18 工具 + 侧边栏开关** | 无 | 无 |
| 非 DSH 用户可用 | **可以（MCP）** | 可以 | 需自己封装 |

> **致非中文用户**：本插件为中文小说分析写作而设计——句式、情感、意象等核心能力以及内置的语义模型，全部针对中文语料构建与调优。在深耕中文的同时兼顾英文等其他语言，确实超出了我目前的能力范围。若因此给您带来不便，我深感抱歉，恳请谅解。

---

## 功能

1. **写作台三件套**：`novel_chapter_brief` **开写包**——动笔前**一次调用**取齐材料（上一章承接口 / 本章方向 / 相关人物 / 待回收伏笔 / 用语规范 / 风格基线 / 锚段与骨架 / 禁用清单 / 开写清单，两档 `budget`：compact / full），取不到的材料进 `degraded` 并说明原因，只读不写盘；`novel_fix_plan` **改稿台**——把风格诊断变成按优先级排好的待办（原句行号定位 + 当前值与目标值 + 原著锚段 + 改写方向），`plan` / `verify` / `mark` 三态复测，**只给方向、不生成正文**；`novel_plot { action: "graph" }` **结构视图**——伏笔埋设跨度 / 人物连续缺席 / 剧情线空档 / 时间线顺序 / 大纲对照。另有**场景化提示词**（general / writing / revising / auditing / setup，`general` 即旧行为）。
2. **风格画像报告**（novel_style_report）：6 维测量报告——文风指纹 / 高频词汇 / 题材流派 / 情感量化 / 氛围光谱 12 轴 / 语义风格距离。**测量与判断分离**：插件只报数不贴标签，AI 判断可回传存盘（`.novel-writer/style-reports/`），续写保持风格一致。
3. **氛围光谱 12 轴**：噩梦感 / 焦虑压抑 / 温馨治愈 / 甜宠日常 / 催泪虐心 / 黑暗残酷 / 悬疑神秘 / 热血激昂 / 荒诞无厘头 / 孤独疏离 / 文艺唯美 / 情欲暧昧——证据链可追溯，0 token。
4. **本地语义引擎**：bge-small-zh 中文模型（24MB 随插件分发）本地 CPU 推理——`novel_semantic_search` 自然语言搜全书语义相关段落（带章节定位），语义级风格对比、语义隐性情感，懒加载 + 自动回退。
5. **句式模式分析**：九类句式分布、排列规律、句长节奏、情感曲线、风格指纹与节奏建议，带缓存与报告导出。
6. **情感净化 + 量化**：强/弱情绪词分级、污染源检测、caveat 预警 + AI 复核；Valence 滑动窗口 → 方差 V / 斜率 Δ / 矛盾指数 C + 隐性意象载体。
7. **世界观与语用检测**：文化基准自动判断（西/东/混合）+ 置信度；speechStyle 称谓/客套/仪式/语气规范；题材流派 + 网文信号。
8. **写作辅助全家桶**：伏笔登记表 / 设定五张表（人物·地点·道具·时间线·世界观）/ 章节摘要 / 连贯性审计 / 批量导入 / 风格自检 / 续写辅助。
9. **全工具 UI 开关**：侧边栏「写作助手功能」面板（总开关 + 工具开关分组 + 功能开关 + 提示词档位/场景/**精简工作流**），大白话文案，显示数据目录占用与语义引擎状态。
10. **风格基线**：文笔六维测量（句法复杂度/修饰密度/抽象度/动作密度/不确定性/留白指数）+ 按章节 μ±σ 基线带；`novel_style_report` 输出基线带，`novel_style_check` 对照新章偏差（带内 ✓ / 出带 ⚠）；侧边栏可自定义每维 ±% 容差（**推荐值 = 原著章节波动的 1.5 倍 σ**，自动取整、限 ±10%~100%；输入框留空即用推荐）——原创/续写时主题自由、写法保持在基线带内。
11. **写作哨兵三件套**：`novel_continuity_check` 扩展——①**衔接检查**（chapter 参数：时间硬跳/语义距离/人物延续/钩子承接四路检测，带原文引用）②**OOC 检测**（ooc 参数：角色情绪基线偏离）③**大纲走偏**（outline 参数：方向行 vs 正文关键词重合）；报告工具支持 **brief 精简模式**。
12. **原创模式与创作资料**：侧边栏填写创作设定（世界观/角色/禁忌/主线/题材/额外要求，留空=模型自定，多书独立设定库）；novel_outline 维护创作资料（创作设定/人物/剧情大纲/钩子记录/创作状态卡），原创强制「设定书→大纲→钩子」链，动态批次（10→20→30 章）防剧情跳跃与角色 OOC。
13. **体验与统计**：主面板**书库统计卡**（每本章数/总字数/近 7 天活跃字数，活跃🔥标绿）、**🎬 体验演示**（内置示例不落盘跑六维基线）、**📊 报告历史**（analysis/style-reports 列表浏览）；错误提示带解决步骤；工具说明压缩省 token。

---

## 提供的工具（18 个）

> 每个工具的参数、返回结构与示例，见[在线工具手册](https://siweina.github.io/dsh-novel-writer/tools/)。

| 工具 | 说明 |
|------|------|
| `novel_books` | 列出章节库全部作品 |
| `novel_chapters` | 列出某作品章节清单 |
| `novel_read` | 阅读某章正文（分段） |
| `novel_keywords` | 关键词：二字组/三字组/疑似人名 |
| `novel_new_chapter` | 创建新章节文件 |
| `novel_import` | 原稿件批量导入/分类 |
| `novel_sentence_analysis` | 句式模式分析（九类/情感净化/量化/曲线/指纹） |
| `novel_sentence_config` | 查看/修改工具与功能开关（含提示词场景） |
| `novel_style_check` | 风格自检（规则+语义双维度） |
| `novel_style_report` | **风格画像报告**（6 维测量 + AI 判断分离） |
| `novel_plot` | 伏笔/剧情线登记表；`action: "graph"` 结构视图（伏笔埋设跨度 / 人物连续缺席 / 剧情线空档 / 时间线顺序 / 大纲对照） |
| `novel_settings` | 设定管理（人物/地点/道具/时间线/世界观） |
| `novel_summary` | 章节摘要（长书续写辅助） |
| `novel_continuity_check` | 连贯性审计 + **衔接/OOC/大纲走偏哨兵** |
| `novel_semantic_search` | 语义检索（本地 embedding，0 token） |
| `novel_outline` | **创作资料管理**（创作设定/人物/大纲/钩子/状态卡） |
| `novel_chapter_brief` | **开写包**——动笔前一次调用取齐材料（上一章承接口/本章方向/相关人物/待回收伏笔/用语规范/风格基线/锚段与骨架/禁用清单/开写清单） |
| `novel_fix_plan` | **改稿台**——把风格诊断变成按优先级排好的待办（带行号定位与锚段），改完可复测；**只给方向不生成正文** |

---

## MCP 服务器（非 DSH 用户也能用）

包里自带一个 **stdio MCP 服务器**（`mcp/server.mjs`），把 18 个工具原样暴露给任何 MCP 客户端，
例如 Claude Desktop、Cursor。**它是跑在你自己电脑上的本地进程，不需要服务器、不需要联网、不需要常驻。**

```bash
npx -y -p dsh-novel-writer dsh-novel-writer-mcp --root /你的小说库路径
```

客户端配置示例（`claude_desktop_config.json` / Cursor `mcp.json`）：

```json
{
  "mcpServers": {
    "dsh-novel-writer": {
      "command": "npx",
      "args": ["-y", "-p", "dsh-novel-writer", "dsh-novel-writer-mcp", "--root", "/你的小说库路径"]
    }
  }
}
```

书库根目录优先级：`--root` > 环境变量 `DSH_NOVEL_WRITER_ROOT` > 当前工作目录。
细节见 [mcp/README.md](./mcp/README.md)。

---

## 配置

```yaml
- id: novel-writer
  config:
    root: 'D:/我的小说库'
    allowLanState: false   # true=局域网访问 GUI 时也允许保存开关
```

---

## 数据目录

`<书库根>/.novel-writer/`：`plots`（伏笔）/ `settings`（设定）/ `summaries`（摘要）/ `analysis`（分析报告）/ `audits`（连贯性审计 + 改稿清单 `fix-plan-*.json`）/ `embedding`（语义索引）/ `style-reports`（风格画像）。

---

## 依赖、权限与失败边界

**运行时依赖**（`npm install` 自动安装，均为公开包）：

- `onnxruntime-web` ^1.24.3 —— 本地 ONNX 推理（WASM 后端），用于语义检索与语义风格距离；
- `@huggingface/tokenizers` ^0.1.0 —— 中文分词（WASM）；
- peerDependency：`react` ^18.2.0（浏览器端复用 DSH Web GUI 自带的 React，不额外打包）。

**本地模型**：`lib/models/` 随包分发 bge-small-zh-v1.5 量化模型（约 24MB，ONNX）与分词器
（`tokenizer.json.gz`，加载时解压）。全部推理在本机 CPU 完成，**不上传任何文本**。

**权限与外部服务**：

- 文件系统：读写用户指定的书库根目录 `novels/` 与其数据目录 `<root>/.novel-writer/`，
  以及插件自身的开关文件 `~/.dsh/dsh-novel-writer/state.json`。**例外一处**：`novel_import` 的 `src`
  按设计可以指向任意目录（用于把别处的旧稿导入书库），`mode:"apply"` + `move:true` 会**删除源文件**——
  删改范围由调用方决定，请只在明确知道源目录内容时使用。**例外仅此一处**：MCP 服务器默认把这个 `src`
  也限制在书库根内（见下方 MCP 一节）。
- 内置技能：通过 `ctx.skills` 注册自带 `novel-writing` 技能（v4.3.0 起），只读取包内
  `skills/novel-writing/SKILL.md`，**不写入任何技能目录**、不需要改宿主配置；宿主没有 `skills` 服务时静默跳过。
- 本地 HTTP：在 DSH Web GUI 内注册 5 条路由（state / reveal / reports / demo / update-check），
  仅回环地址可访问；`allowLanState` 默认关闭，局域网访问默认拒绝。
- MCP 服务器（`mcp/server.mjs`）：工具参数里的 `root` 必须落在启动时 `--root` 指定的书库根之内，
  越界会被拒绝并回退；`novel_import` 的 `src` 默认也限根内，确需导入外部目录时用
  `--allow-external-src` 显式放开（v4.3.0 起）。单行报文上限 4 MiB，超限整行丢弃；stderr 默认只记一行错误摘要，
  不回显正文与堆栈（需要完整堆栈用 `DEBUG=1`）；长任务可用 `notifications/cancelled` 取消。详见
  [mcp/README.md 第 0 节](./mcp/README.md#0-安全边界v420-起)。
- 外部网络：唯一外呼是 GitHub Releases API（`api.github.com`）检查新版本——3 秒超时、24 小时缓存、
  失败静默降级；请求不含任何书籍内容。
- 子进程：无。唯一例外是打开系统文件管理器（Windows `explorer` / macOS `open` / Linux `xdg-open`），
  以数组参数直调、不经 shell。
- 生命周期脚本：无（无 preinstall / postinstall / prepare）。

**失败边界**：

- 语义引擎不可用（模型缺失或 WASM 初始化失败）时自动回退纯规则模式，其余功能不受影响；
- 分析结果落盘失败不阻塞工具返回；缓存损坏按"无缓存"处理并重建；
- 插件加载失败不影响 DSH 主进程：工具注册与提示词注入相互独立。

**兼容范围**：Node.js >= 22.3（`engines.node`）；DSH >= 0.1.1-rc.2（`dsh.engines.dsh`）。

---
## 许可证

[MIT](./LICENSE)

---

🔗 [官网](https://siweina.github.io/dsh-novel-writer/) · [技术文档](https://siweina.github.io/dsh-novel-writer/tools/) · [GitHub](https://github.com/siweina/dsh-novel-writer) · [npm](https://www.npmjs.com/package/dsh-novel-writer) · [MCP 服务器手册](./mcp/README.md)
