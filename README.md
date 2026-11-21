# 📚 dsh-novel-writer — 给网文作者的本地写作工作台

[English](./README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![npm downloads](https://img.shields.io/npm/dm/dsh-novel-writer.svg?style=flat-square&color=green)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg?style=flat-square)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.1.1--rc.2-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)
[![siweina/dsh-novel-writer MCP server](https://glama.ai/mcp/servers/siweina/dsh-novel-writer/badges/score.svg)](https://glama.ai/mcp/servers/siweina/dsh-novel-writer)

**22 个本地工具，贯通「动笔前取材料 → 写完量化自检 → 按优先级改稿 → 跨章结构体检 → 诊断与清理」完整创作闭环。**
随包附带 24 MB 中文语义模型（`bge-small-zh-v1.5`，WASM 本地推理）——**零 API 费用、正文不出本机、只测算与引导而不代写**。
为 **DeepSeek Harness（DSH）** 打造（四标签侧栏与主栏统一 UI）；亦支持通过内置 **stdio MCP 服务器**接入 Claude Desktop / Cursor，或通过 **`--ui` 独立 Web UI / Antigravity 侧边辅栏插件**脱离 DSH 使用完整工作台。

[官网](https://siweina.github.io/dsh-novel-writer/) · [技术文档（22 个工具）](https://siweina.github.io/dsh-novel-writer/tools/) · [核心能力](#核心能力) · [安装与快速上手](#安装与快速上手) · [22 个工具](#提供的工具22-个) · [MCP 服务器](#mcp-服务器非-dsh-用户) · [配置与安全边界](#配置数据目录与安全边界) · [架构地图](ARCHITECTURE.md) · [更新日志](./CHANGELOG.md)

> **模块地图与构建边界**：仓库模块划分与构建边界见 [`ARCHITECTURE.md`](ARCHITECTURE.md)；前端产物 `lib/client.js` 由 `client/` 源码构建生成（`npm run build`）。

---

## 核心能力

- **动笔前防漏读（开写包 & 创作资料）**：`novel_chapter_brief` 一次只读调用取齐 16 项写作输入——上章结尾承接、钩子、本章大纲方向、相关人物卡、待回收伏笔及埋设跨度、世界观语用禁词、必用词表、六维风格基线、原著锚段与开写清单；缺项会在 `degraded` 中明示原因与补全方式。配合 `novel_outline`、五张设定表（`novel_settings`）与书级/全局双层必用词表（`novel_lexicon`）统一管住设定。
- **文风量化防漂移（六维基线 & 场景分带对照）**：以句法复杂度、修饰密度、抽象度、动作密度、不确定性与留白指数刻画原著 `μ±σ` 基线，辅以九类句式节奏、情感波动曲线与 12 轴氛围光谱；支持按「对话文戏 / 动作冲突 / 叙事过渡」**场景分带基线对照**（以引号占比与独立冲突词/短句节奏划分，避免日常叙事动词误判；同带 ≥ 3 章优先按同带均值校验、不足自动回退全基线），并可在面板按书勾选标杆章节，避免 AI 续写把基准带偏，仅在偏离明显或读着别扭时才建议修改。
- **改稿按优先级推进（改稿台 & 严格对账）**：`novel_fix_plan` 把诊断问题转为按「严重度 → 难度 → 行号」排序的可执行待办（默认上限 12 条），每条附带原句行号、现状与目标区间、改写方向及原著对照锚段（只给方向不代写正文），支持分批修改后走 `plan` / `verify` / `mark` 三态复测闭环。
- **外置 JSON 题材包与可视化工作室（5 套内置 / 可视化编辑 / `[DSH-PACK v1]` 分享导入）**：随包提供 `western-fantasy` / `eastern-xianxia` / `modern-urban` / `mystery-thriller` / `scifi-cyberpunk` 5 套内置题材包，并支持 `<书库根>/.novel-writer/packs/*.json` 热加载自定义包（含最多 2 层继承、防 ReDoS 与防符号链接逃逸校验）；可在 Web UI 题材包工作室新建、从内置包「派生微调」或编辑自定义包，复制可读 `[DSH-PACK v1]` 分享信封、一键导出 `.json` 文件，以及通过粘贴文本或选择 `.json` 文件安全导入（导入前展示进提示词字段审阅、ReDoS 正则与重名/内置 ID 冲突预检，插件本身全程保持零联网）。`novel_settings`（`action: "packs"` / `worldview.pack`）、`novel_plot { action: "graph" }`、`novel_continuity_check` 与 `novel_semantic_search` 协同覆盖伏笔跨度、三路哨兵与本地离线语义检索。
- **重构四标签工作台与可控维护（工具预设 / 题材包 / 场景基线视图）**：Web UI 收敛为 `工作台` / `AI 与工具` / `体检与报告` / `维护与高级` 四大标签页，支持工具搜索、5 大功能分组过滤与一键场景预设（`all` / `writing` / `revising` / `auditing` / `setup`，按需裁剪上下文且 `novel_sentence_config` 防死锁常驻）、题材包管理视图（内置与自定义 JSON 包查看/绑定）、场景分带基线视图（三带对照与标杆选章），以及场景化提示词、按字数阈值停顿提问的草稿镜像（`novel_draft`）、`rawWriting` 模式、覆盖 13 处按书资料带回收站恢复的 `novel_delete_book` 和脱敏诊断 `novel_diagnose`。

> **语言范围说明**：词表、语用规范、句式规则与随包中文语义模型均面向中文小说语料构建与调优，目前不支持英文等非中文作品分析。

---

## 安装与快速上手

### 1. 安装（DSH 插件）

```sh
dsh plugin add dsh-novel-writer                     # 方式一：npm（推荐，指定配置加 --profile <名称>）
dsh plugin add github:siweina/dsh-novel-writer#main # 方式二：GitHub
```

要求 **Node.js ≥ 22.13**（外部 MCP / 独立 CLI 使用内置 `node:sqlite`；DSH 桌面端内置 Node 24，不受影响）、**DSH ≥ 0.1.1-rc.2**。安装后重启 DSH，左栏主导航会出现「写作助手功能」入口（DSH 0.2.0+ 走官方席位，老版本自动回退兼容挂载）。不用 DSH 可直接走 [MCP 服务器](#mcp-服务器非-dsh-用户)。

### 2. 一章完整闭环

将章节文件放入 `novels/<书名>/`（如 `第01章.md`、`第02章.md`），在对话里按顺序说：

| 步骤 | 你说什么 | 调用工具 | 拿到什么 |
|---|---|---|---|
| ① **取材料** | 「给下一章取材料」 | `novel_chapter_brief` | 一次取齐 16 项上下文，缺项写入 `degraded`（只读不写盘） |
| ② **动笔** | 「写第 N 章」 | `novel_new_chapter` · 写正文 | 新章文件（附基线 μ 与原著锚段校准语感，不照骨架套句） |
| ③ **自检** | 「自检第 N 章」 | `novel_style_check` · `novel_sentence_analysis` | 相似度 + 偏差清单 + 六维对照（带内 ✓ / 出带 ⚠） |
| ④ **改稿** | 「把这章排成改稿清单」 | `novel_fix_plan` | 带行号、目标值与锚段的有序待办；改完可 `verify` 复测 |
| ⑤ **体检** | 「看看全书结构」 | `novel_plot { action: "graph" }` | 伏笔跨度、人物缺席、剧情线空档与大纲走偏排查 |

<details>
<summary>看看代表输出：开写包与改稿台长什么样</summary>

```text
【开写包 novel_chapter_brief】目标：第 8 章（推导文件名 第08章.md）
  上一章承接口：…（末尾 300/600 字）｜待回收伏笔：[mu5kjla…] 齿轮怀表（high｜第 1 章埋下，已过 6 章）
  相关人物：林昭 / 沈砚｜世界观用语：点烛不烧香（禁用：上香 → 改用 点烛；时辰 → 改用 钟点）
  风格基线：complexity μ=2.42  modifierDensity μ=22.2 …（取样：全书除本章外 7 章）
  原著锚段：[对话] … [心理] …｜降级提示：钩子记录里没有第 7 章钩子

【改稿台 novel_fix_plan】共 13 项待办（严重度降序 → 难度升序）
  - [抽象度过高] 严重度 5 / 难度 2（第 5 行） id：fix-abstract-5-c2c156d4
      现状：47.9　目标：0.55~6.95｜原句：林昭大概说不清那种感觉…
      方向：抽象词过密，改成具体动作或物件。｜原著锚段：林昭把它捏在掌心，翻过来看背面…
```

</details>

---

## 提供的工具（22 个）

> 各工具完整参数、返回契约与计算细节见 [在线工具文档](https://siweina.github.io/dsh-novel-writer/tools/)。

| 分类 | 工具 | 说明 |
|---|---|---|
| **书库与章节** | `novel_books` | 列出章节库中全部作品与基础统计 |
| | `novel_chapters` | 列出指定作品的章节清单与字数 / 行数 |
| | `novel_read` | 按行号 `offset` / `limit` 分段阅读章节正文 |
| | `novel_new_chapter` | 创建新章节文件并自动附带风格基线摘要 |
| | `novel_import` | 批量扫描、按书名/章号归类并导入存量稿件 |
| | `novel_draft` | 「实时聊天写作」追加式草稿镜像（按字数阈值控制停顿提问） |
| **开写与改稿** | `novel_chapter_brief` | 开写包：动笔前一次取齐 16 项材料（含多场景参考带与题材包联动，只读） |
| | `novel_fix_plan` | 改稿台：结合场景分带基线与题材包豁免生成有序待办并三态复测（不改正文） |
| | `novel_outline` | 维护五份创作资料（设定 / 人物 / 大纲 / 钩子 / 状态卡） |
| | `novel_summary` | 读写章节摘要，辅助长篇续写记忆承接 |
| **文风与语义** | `novel_style_report` | 风格画像：六维基线、分场景参考带、高频词、题材、情感量化与 12 轴氛围光谱 |
| | `novel_style_check` | 风格自检：新章优先按场景分带对比标杆基线的相似度、偏差与锚段 |
| | `novel_sentence_analysis` | 句式分析：九类句式分布、情感净化、波动曲线与节奏建议 |
| | `novel_keywords` | 统计全书或单章高频二字组 / 三字组 / 疑似人名与英文词 |
| | `novel_semantic_search` | 基于本地 ONNX 向量模型的自然语言语义段落检索 |
| **设定与连贯性** | `novel_settings` | 五张设定表管理、文化识别与 `packs` 题材包查看 / `worldview.pack` 绑定 |
| | `novel_lexicon` | 书级 + 全局双层必用词表登记、开写注入与成稿用词审计 |
| | `novel_plot` | 伏笔登记与追踪；`action: "graph"` 输出全书结构视图 |
| | `novel_continuity_check` | 连贯性审计及衔接、角色 OOC、大纲走偏三路哨兵 |
| **配置与维护** | `novel_sentence_config` | 查看/修改总开关、22 工具开关、11 功能开关、容差与提示词档位 |
| | `novel_diagnose` | 五项健康体检与本机事件日志聚合，生成可安全分享的脱敏诊断报告 |
| | `novel_delete_book` | 按书预览与清理 13 处关联资料，默认移入回收站（支持选择性清理与恢复） |

---

## MCP 服务器（非 DSH 用户）

包内自带本地 **stdio MCP 服务器**（`mcp/server.mjs`），在 Claude Desktop / Cursor 等客户端的 `claude_desktop_config.json` 或 `mcp.json` 中配置即可：

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

- 包名（`dsh-novel-writer`）与可执行名（`dsh-novel-writer-mcp`）不同，请保留 `-p` 参数；
- 书库根目录优先级：`--root` > `DSH_NOVEL_WRITER_ROOT` > 当前工作目录；
- 可加 `--preset <all|writing|revising|auditing|setup>` 按场景裁剪 `tools/list`（与 `state.json` 取交集，始终保留 `novel_sentence_config` 防死锁）；
- 参数中的 `root` 与 `novel_import.src` 默认限制在书库根内（确需导入库外目录时传 `--allow-external-src`）。细节见 [mcp/README.md](./mcp/README.md)。

**独立 Web UI 与 Antigravity 侧栏（无需 DSH）**：

```sh
npm run ui                                                      # 仓库内一键启动独立四标签 Web UI
node mcp/server.mjs --ui --ui-port 3789 --root /你的小说库路径   # 指定端口启动（--ui-port 可选）
node tools/install-antigravity-ui.mjs --apply                   # 安装 Antigravity Sidecar Aux Pane 侧栏插件
```

- **权限范围与防误操作**：独立 Web UI / Antigravity 侧栏面向**本机个人单人使用**（严格绑定 `127.0.0.1` 回环并校验 `Host` / `Origin`，请勿反代或暴露给他人）；面板可直接调节全量开关、18+ 模式与按书删除/回收站，其中 18+ 模式（倒计时 + 输入承诺词）与回收站「彻底删除」（输入书名/条目名）均走面板内显式文字确认门禁，不依赖沙箱 webview 可能拦截的 `window.confirm`。

---

## 配置、数据目录与安全边界

**插件配置**（DSH 配置文件）：

```yaml
- id: novel-writer
  config:
    root: 'D:/我的小说库'
    allowLanState: false   # true=允许局域网通过面板保存状态（删书路由仍仅限回环）
```

**目录布局**：
- `novels/<书名>/` 存放章节正文，`novels/创作资料/<书名>/` 存放大纲、人物卡与钩子等 Markdown；
- `<书库根>/.novel-writer/cache.sqlite`（WAL 模式）：集中存储可重算的派生缓存（逐章六维 `chapter_metrics`、全书/原型分析 `analysis_cache`、128 维语义索引 `embedding_*` 与 512 维审计向量 LRU `audit_vectors`）；**绝不存放正文**，损坏自动重建，**随时可安全删除**；
- `<书库根>/.novel-writer/` 其余文件继续保持可读 JSON：伏笔（`plots`）、五张设定表与按书原创设定 `creationProfile`（`settings/<书名>.json`，避免跨书库同名冲突并与创作资料同步，透明兼容/清理旧版 `state.json` 遗留）、题材包（`packs`）、摘要（`summaries`）、审计与改稿清单（`audits`）、风格画像（`style-reports`）、基线范围（`baseline`）、必用词表（`lexicon`）、草稿镜像（`drafts`）、旧版兼容缓存目录（`analysis` / `embedding`）与回收站（`trash`——内容仍占磁盘直至显式 `purge`）；
- `~/.dsh/dsh-novel-writer/` 存放全局开关状态 `state.json`（可通过 `DSH_NOVEL_WRITER_STATE` 覆盖；多线程/多进程写入通过 `<file>.lock` 原子文件锁串行化）与本地日志 `logs/events.jsonl`（512 KB 轮转，保留 3 份）。

**依赖、权限与边界**：
- **运行时依赖**：`onnxruntime-web`、`@huggingface/tokenizers`，浏览器端复用宿主 `react`（peerDependency）；无生命周期脚本。
- **网络与子进程**：唯一外呼为 GitHub Releases API 版本检查（3 秒超时、24 小时缓存、不含任何书库信息）；唯一外部调用为数组直调系统文件管理器（不经 shell）；Web UI 注册 13 条回环保护路由（DSH 宿主与独立 Web UI 共用）。
- **日志隐私双层隔离**：本机 `events.jsonl` 仅驻留本地（自由文本至多保留收敛后的单句 `≤160` 字）；通过 `novel_diagnose` 或面板「复制诊断包」导出的分享内容会整体剔除自由文本并将错误归一为固定 `code`，可安全贴入公开 Issue。
- **容错降级**：语义引擎不可用时自动退回纯规则模式；缓存/状态损坏只影响当前只读重算或回退默认，绝不以「未初始化」误导；已知约束：若将某章 `.md`/`.markdown`/`.txt` 文件替换为同名目录，`scanChapters` 会跳过它并记 `silent_skip` 日志，但不进 `degraded`。

---

## 许可证

[MIT](./LICENSE)

🔗 [官网](https://siweina.github.io/dsh-novel-writer/) · [技术文档](https://siweina.github.io/dsh-novel-writer/tools/) · [更新日志](./CHANGELOG.md) · [MCP 手册](./mcp/README.md) · [GitHub](https://github.com/siweina/dsh-novel-writer) · [npm](https://www.npmjs.com/package/dsh-novel-writer)
