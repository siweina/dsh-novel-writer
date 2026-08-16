# 📚 dsh-novel-writer — 小说写作助手 / Novel Writing Assistant

**中文** | [**English**](#english)

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/siweina/dsh-novel-writer.svg?style=flat-square)](https://github.com/siweina/dsh-novel-writer/releases)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

为 **DeepSeek Harness (DSH)** 打造的小说写作助手插件：章节库管理、句式模式分析、风格自检、伏笔登记、设定管理、批量导入与 AI 续写辅助。宿主端零第三方依赖（仅 Node 内置模块）。

A novel-writing assistant plugin for **DeepSeek Harness (DSH)**: chapter library management, sentence-pattern analysis, style checking, plot tracking, settings management, batch import, and AI-assisted continuation writing. Zero third-party dependencies on host (Node built-ins only).

---

## 安装 / Installation

**方式一：npm（推荐 / Recommended）**

```sh
npm install dsh-novel-writer
# 或 / or
dsh plugin --profile web add dsh-novel-writer
```

**方式二：从 GitHub 安装 / Install from GitHub**

```sh
dsh plugin --profile web add github:siweina/dsh-novel-writer#main
```

安装后**重启 web 应用**生效（Host 端注册 13 个工具 + state/reveal 路由，浏览器端挂载侧边栏「写作助手功能」开关面板）。

After installing, **restart the web app** to activate (Host registers 13 tools + state/reveal routes; browser mounts the "Writing Assistant" sidebar toggle panel).

---

## 功能 / Features

### 🇨🇳 中文

1. **章节库管理**：章节存放于 `novels/<书名>/第N章.md`（或 .txt/.markdown），章号支持任意位置与中文数字（第一章/第十四章），编码自动探测（UTF-8/UTF-16/GBK）。
2. **句式模式分析**：`novel_sentence_analysis` 输出九类句式分布、排列规律、句长节奏、情感曲线（喜怒哀惧惊）、风格指纹与节奏建议，带分析缓存与报告导出。
3. **风格自检**：`novel_style_check` 章节 vs 全书 → 余弦相似度 + 句式/句长/情绪偏差清单 + 续写建议。
4. **伏笔登记表**：`novel_plot` 维护伏笔/剧情钩子（open/done），字段化（类型/优先级/关联人物/回收条件）+ 章节提及自动追踪。
5. **设定管理**：`novel_settings` 四张表——人物卡/地点卡/道具清单/时间线，list/add/update/delete + scan 候选提取。
6. **章节摘要**：`novel_summary` 每章 200-500 字摘要 + 关键事件，长书续写先读摘要。
7. **连贯性审计**：`novel_continuity_check` 对照设定表扫描全书 → 数字口径/人物缺场/别名/重复条目矛盾候选。
8. **批量导入**：`novel_import` 原稿件文件夹自动识别书名与章节号，分类导入（异名同书提示、files 精确指定）。
9. **续写辅助**：先读后写、保持文风与伏笔一致，`novel_new_chapter` 创建新章节。
10. **全工具 UI 开关**：侧边栏「写作助手功能」面板统一管理（总开关 + 每工具独立开关）。

### 🇬🇧 English

1. **Chapter library**: chapters in `novels/<book>/第N章.md` (or .txt/.markdown); chapter numbers anywhere + Chinese numerals (第一章/第十四章); auto encoding detection (UTF-8/UTF-16/GBK).
2. **Sentence-pattern analysis** (`novel_sentence_analysis`): 9 categories, transition patterns, sentence-length rhythm, emotion curve (joy/anger/sorrow/fear/surprise), style fingerprint + guidance, with cache & report export.
3. **Style check** (`novel_style_check`): chapter vs book → cosine similarity + deviation list (syntax/length/emotion) + advice.
4. **Plot tracking** (`novel_plot`): foreshadowing/plot-hook registry (open/done), typed fields (priority/characters/payoff) + auto mention tracking.
5. **Settings management** (`novel_settings`): four tables — characters / locations / items / timeline, with scan candidates.
6. **Chapter summaries** (`novel_summary`): 200-500 char digest + key events per chapter, for long-book continuation.
7. **Continuity audit** (`novel_continuity_check`): scans book against settings → number-usage / missing-characters / unused-aliases / duplicate-entry candidates.
8. **Batch import** (`novel_import`): auto-detect book names & chapter numbers from a folder, classified import (same-book hints, file selection).
9. **Continuation writing**: read-first workflow keeping style & foreshadowing consistent; `novel_new_chapter` creates new chapters.
10. **Per-tool UI toggles**: "Writing Assistant" sidebar panel (master switch + per-tool switches).

---

## 提供的工具 / Provided Tools

| Tool | 中文说明 | English |
|------|----------|---------|
| `novel_books` | 列出章节库全部作品 | List all books in library |
| `novel_chapters` | 列出某作品章节清单 | List a book's chapters |
| `novel_read` | 阅读某章正文（分段） | Read a chapter (paginated) |
| `novel_keywords` | 关键词：二字组/三字组/疑似人名 | Keywords: bigram/trigram/name candidates |
| `novel_new_chapter` | 创建新章节文件 | Create new chapter file |
| `novel_import` | 原稿件批量导入/分类 | Batch import manuscripts |
| `novel_sentence_analysis` | 句式模式分析（九类/情感曲线/指纹） | Sentence-pattern analysis |
| `novel_sentence_config` | 查看/修改工具开关 | View/set tool toggles |
| `novel_style_check` | 风格自检（相似度+偏差清单） | Style check (similarity+diffs) |
| `novel_plot` | 伏笔/剧情线登记表 | Plot/foreshadowing tracker |
| `novel_settings` | 设定管理（人物/地点/道具/时间线） | Settings management |
| `novel_summary` | 章节摘要（长书续写辅助） | Chapter summaries |
| `novel_continuity_check` | 连贯性审计（设定矛盾候选） | Continuity audit |

---

## 配置 / Configuration

在 profile 的 `cordis.patch.yml` 中覆盖（`root` = 章节库根目录，默认会话工作区）：

```yaml
- id: novel-writer
  config:
    root: 'D:/我的小说库'
    allowLanState: false   # true=局域网访问 GUI 时也允许保存开关
```

---

## 数据目录 / Data Directory

`<书库根>/.novel-writer/` 下五个子目录：`plots`（伏笔）/ `settings`（设定）/ `summaries`（摘要）/ `analysis`（分析报告+关键词）/ `audits`（审计报告）。

Under `<library-root>/.novel-writer/`: `plots` / `settings` / `summaries` / `analysis` / `audits`.

---

<!-- ENGLISH -->

## English

`dsh-novel-writer` is a self-contained **DSH (Cordis) bundle plugin** for novel-writing assistance, with **no third-party dependencies** (Node built-ins only). See sections above for features, tools, install, config, and data layout. MIT licensed.
