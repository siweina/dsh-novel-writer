# 📚 dsh-novel-writer — 给网文作者的本地章节体检

[English](./README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![npm downloads](https://img.shields.io/npm/dm/dsh-novel-writer.svg?style=flat-square&color=green)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.3-339933.svg?style=flat-square)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.1.1--rc.2-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)

**16 个工具，把"文风跑偏"变成可量化的数字。**
句式 / 情感 / 风格基线全部**在本地算**：24MB 中文模型随包分发，**零 API 花费、正文不出本机**。
为 DeepSeek Harness（DSH）打造；同一套能力也可作为 **MCP 服务器**给 Claude Desktop / Cursor 使用。

[安装](#安装) · [60 秒上手](#60-秒上手) · [看看输出](#看看输出长什么样) · [16 个工具](#提供的工具16-个) · [MCP 服务器](#mcp-服务器非-dsh-用户也能用)

---

## 它解决什么问题

| 你的困扰 | 这里给的答案 |
|---|---|
| "我续写的这段，读起来不像我自己写的" | **文笔六维基线**：从句法复杂度 / 修饰密度 / 抽象度 / 动作密度 / 不确定性 / 留白指数六个维度算出原著的 μ±σ，新章逐维对照，出带标 ⚠ |
| "AI 说文风变了，但说不清哪儿变了" | **风格自检**：相似度 + 偏差清单（哪类句式多了、句长偏了多少、主导情绪有没有换） |
| "分析小说要花钱调 API" | 语义检索与情感分析**全本地推理**，零 token 花费 |
| "伏笔埋了忘了收" | **伏笔登记表**：add / list / scan / done，自动记录每条伏笔在哪些章被提到 |
| "人物设定前后打架" | **设定五张表 + 连贯性审计**（衔接 / OOC / 大纲走偏三件套） |
| "报告看不懂" | 全是**表格化数字 + 原文锚段**，可以直接截图分享 |

## 安装

**方式一：npm（推荐）**

`sh
dsh plugin --profile web add dsh-novel-writer
`

**方式二：从 GitHub 安装**

`sh
dsh plugin --profile web add github:siweina/dsh-novel-writer#main
`

**方式三：MCP（不用 DSH 也能用）** —— 见 [MCP 服务器](#mcp-服务器非-dsh-用户也能用)

要求 **Node ≥ 22.3**。安装后**重启 Web 应用**，侧边栏出现「写作助手功能」面板。

## 60 秒上手

`sh
mkdir -p novels/我的小说     # 把章节文件放进去（第01章.md、第02章.md …）
`

然后在对话里说：**"用 novel_style_report 给我的小说做一次风格画像"**，你会拿到：

```text
全书 1329 字：六维基线 μ=句法复杂度:2.3 修饰密度:35.6 抽象度:0.5 动作密度:101.7 不确定性:2.1 留白指数:7.0
推荐容差 25%/35%/100%…
```

## 看看输出长什么样

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
| 与 DSH 集成 | **16 工具 + 侧边栏开关** | 无 | 无 |
| 非 DSH 用户可用 | **可以（MCP）** | 可以 | 需自己封装 |

> **致非中文用户**：本插件为中文小说分析写作而设计——句式、情感、意象等核心能力以及内置的语义模型，全部针对中文语料构建与调优。在深耕中文的同时兼顾英文等其他语言，确实超出了我目前的能力范围。若因此给您带来不便，我深感抱歉，恳请谅解。

---

## 功能

1. **风格画像报告**（novel_style_report）：6 维测量报告——文风指纹 / 高频词汇 / 题材流派 / 情感量化 / 氛围光谱 12 轴 / 语义风格距离。**测量与判断分离**：插件只报数不贴标签，AI 判断可回传存盘（`.novel-writer/style-reports/`），续写保持风格一致。
2. **氛围光谱 12 轴**：噩梦感 / 焦虑压抑 / 温馨治愈 / 甜宠日常 / 催泪虐心 / 黑暗残酷 / 悬疑神秘 / 热血激昂 / 荒诞无厘头 / 孤独疏离 / 文艺唯美 / 情欲暧昧——证据链可追溯，0 token。
3. **本地语义引擎**：bge-small-zh 中文模型（24MB 随插件分发）本地 CPU 推理——`novel_semantic_search` 自然语言搜全书语义相关段落（带章节定位），语义级风格对比、语义隐性情感，懒加载 + 自动回退。
4. **句式模式分析**：九类句式分布、排列规律、句长节奏、情感曲线、风格指纹与节奏建议，带缓存与报告导出。
5. **情感净化 + 量化**：强/弱情绪词分级、污染源检测、caveat 预警 + AI 复核；Valence 滑动窗口 → 方差 V / 斜率 Δ / 矛盾指数 C + 隐性意象载体。
6. **世界观与语用检测**：文化基准自动判断（西/东/混合）+ 置信度；speechStyle 称谓/客套/仪式/语气规范；题材流派 + 网文信号。
7. **写作辅助全家桶**：伏笔登记表 / 设定五张表（人物·地点·道具·时间线·世界观）/ 章节摘要 / 连贯性审计 / 批量导入 / 风格自检 / 续写辅助。
8. **全工具 UI 开关**：侧边栏「写作助手功能」面板（总开关 + 工具开关分组 + 功能开关），大白话文案，显示数据目录占用与语义引擎状态。
9. **风格基线**：文笔六维测量（句法复杂度/修饰密度/抽象度/动作密度/不确定性/留白指数）+ 按章节 μ±σ 基线带；`novel_style_report` 输出基线带，`novel_style_check` 对照新章偏差（带内 ✓ / 出带 ⚠）；侧边栏可自定义每维 ±% 容差（**推荐值 = 原著章节波动的 1.5 倍 σ**，自动取整、限 ±10%~100%；输入框留空即用推荐）——原创/续写时主题自由、写法保持在基线带内。
10. **写作哨兵三件套**：`novel_continuity_check` 扩展——①**衔接检查**（chapter 参数：时间硬跳/语义距离/人物延续/钩子承接四路检测，带原文引用）②**OOC 检测**（ooc 参数：角色情绪基线偏离）③**大纲走偏**（outline 参数：方向行 vs 正文关键词重合）；报告工具支持 **brief 精简模式**。
11. **原创模式与创作资料**：侧边栏填写创作设定（世界观/角色/禁忌/主线/题材/额外要求，留空=模型自定，多书独立设定库）；novel_outline 维护创作资料（创作设定/人物/剧情大纲/钩子记录/创作状态卡），原创强制「设定书→大纲→钩子」链，动态批次（10→20→30 章）防剧情跳跃与角色 OOC。
12. **体验与统计**：主面板**书库统计卡**（每本章数/总字数/近 7 天活跃字数，活跃🔥标绿）、**🎬 体验演示**（内置示例不落盘跑六维基线）、**📊 报告历史**（analysis/style-reports 列表浏览）；错误提示带解决步骤；工具说明压缩省 token。

---

## 提供的工具（16 个）

| 工具 | 说明 |
|------|------|
| `novel_books` | 列出章节库全部作品 |
| `novel_chapters` | 列出某作品章节清单 |
| `novel_read` | 阅读某章正文（分段） |
| `novel_keywords` | 关键词：二字组/三字组/疑似人名 |
| `novel_new_chapter` | 创建新章节文件 |
| `novel_import` | 原稿件批量导入/分类 |
| `novel_sentence_analysis` | 句式模式分析（九类/情感净化/量化/曲线/指纹） |
| `novel_sentence_config` | 查看/修改工具与功能开关 |
| `novel_style_check` | 风格自检（规则+语义双维度） |
| `novel_style_report` | **风格画像报告**（6 维测量 + AI 判断分离） |
| `novel_plot` | 伏笔/剧情线登记表 |
| `novel_settings` | 设定管理（人物/地点/道具/时间线/世界观） |
| `novel_summary` | 章节摘要（长书续写辅助） |
| `novel_continuity_check` | 连贯性审计 + **衔接/OOC/大纲走偏哨兵** |
| `novel_semantic_search` | 语义检索（本地 embedding，0 token） |
| `novel_outline` | **创作资料管理**（创作设定/人物/大纲/钩子/状态卡） |

---

## MCP 服务器（非 DSH 用户也能用）

包里自带一个 **stdio MCP 服务器**（`mcp/server.mjs`），把 16 个工具原样暴露给任何 MCP 客户端，
例如 Claude Desktop、Cursor。**它是跑在你自己电脑上的本地进程，不需要服务器、不需要联网、不需要常驻。**

```json
{
  "mcpServers": {
    "dsh-novel-writer": {
      "command": "node",
      "args": ["/绝对路径/mcp/server.mjs", "--root", "/你的小说库路径"]
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

`<书库根>/.novel-writer/`：`plots`（伏笔）/ `settings`（设定）/ `summaries`（摘要）/ `analysis`（分析报告）/ `audits`（审计）/ `embedding`（语义索引）/ `style-reports`（风格画像）。

---

## 依赖、权限与失败边界

**运行时依赖**（`npm install` 自动安装，均为公开包）：

- `onnxruntime-web` ^1.24.3 —— 本地 ONNX 推理（WASM 后端），用于语义检索与语义风格距离；
- `@huggingface/tokenizers` ^0.1.0 —— 中文分词（WASM）；
- peerDependency：`react` ^18.2.0（浏览器端复用 DSH Web GUI 自带的 React，不额外打包）。

**本地模型**：`lib/models/` 随包分发 bge-small-zh-v1.5 量化模型（约 24MB，ONNX）与分词器
（`tokenizer.json.gz`，加载时解压）。全部推理在本机 CPU 完成，**不上传任何文本**。

**权限与外部服务**：

- 文件系统：只读写用户指定的书库根目录 `novels/` 与其数据目录 `<root>/.novel-writer/`，
  以及插件自身的开关文件 `~/.dsh/dsh-novel-writer/state.json`；不访问其他路径。
- 本地 HTTP：在 DSH Web GUI 内注册 5 条路由（state / reveal / reports / demo / update-check），
  仅回环地址可访问；`allowLanState` 默认关闭，局域网访问默认拒绝。
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
