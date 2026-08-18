# 📚 dsh-novel-writer — 小说写作助手

[**English**](./README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/siweina/dsh-novel-writer.svg?style=flat-square)](https://github.com/siweina/dsh-novel-writer/releases)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

为 **DeepSeek Harness (DSH)** 打造的小说写作助手插件：章节库管理、句式模式分析、风格自检、伏笔登记、设定管理、世界观/语用检测、情感净化、批量导入与 AI 续写辅助。宿主端零第三方依赖（仅 Node 内置模块），浏览器端仅依赖 Web GUI 自带的 react。

---

## 安装

**方式一：npm（推荐）**

```sh
npm install dsh-novel-writer
# 或
dsh plugin --profile web add dsh-novel-writer
```

**方式二：从 GitHub 安装**

```sh
dsh plugin --profile web add github:siweina/dsh-novel-writer#main
```

安装后**重启 web 应用**生效（宿主端注册 13 个工具与 state/reveal 路由，浏览器端挂载侧边栏「写作助手功能」开关面板）。

---

## 功能

1. **章节库管理**：章节存放于 `novels/<书名>/第N章.md`（或 .txt/.markdown），章号支持任意位置与中文数字（第一章/第十四章），编码自动探测（UTF-8/UTF-16/GBK）。
2. **句式模式分析**：`novel_sentence_analysis` 输出九类句式分布、排列规律、句长节奏、情感曲线、风格指纹与节奏建议，带分析缓存与报告导出。
3. **情感净化**（v1.5.0）：情绪词分级（强情绪词=真实基调 / 弱情绪词=感官刺激类用词易污染）；污染源检测（刺激/战斗/恐怖场景密度超标 → 可信度降级 low + caveat 预警 + aiAction 强制 AI 复核原文）；cleanDominant 剔除污染词后的真实主导情绪。
4. **情感量化引擎**（v1.6.0）：Valence 效价映射（约 150 词七维查表）+ 滑动窗口（每 100 字）→ 方差 V（撕裂度）/ 斜率 Δ（趋势）/ 矛盾指数 C（同窗交织 vs 分段喜悲）；隐性意象载体（雨/黄昏/枯枝等 28 组）+ 显隐冲突（强颜欢笑检测）；复杂度评分（熵+多样性+冲突，high/medium/low 恒有值）+ 复合情感共现（悲喜交加）。模型读数字零成本理解复杂情感，受 emotionComplexity 开关控制。
4. **风格自检**：`novel_style_check` 章节 vs 全书 → 余弦相似度 + 句式/句长/情绪偏差清单 + 续写建议。
5. **伏笔登记表**：`novel_plot` 维护伏笔/剧情钩子（open/done），字段化 + 章节提及自动追踪。
6. **设定管理**：`novel_settings` 五张表——人物/地点/道具/时间线/世界观（用语+语用规范）。
7. **世界观与语用检测**：`detect` 自动判断文化基准（西/东/混合）+ 置信度；`speechStyle` 称谓规范/客套禁词/仪式禁式/语气；中式与欧式语用规范双向支持（v1.0.1）。
8. **题材与流派检测**（v1.5.0）：`detect` 输出题材（骨）+ 流派（皮），低频噪音自动过滤（count<5 省略）、泛化词清理。
9. **章节摘要**：`novel_summary` 每章摘要 + 关键事件，长书续写先读摘要。
10. **连贯性审计**：`novel_continuity_check` 设定矛盾 + 语用冲突（客套/仪式/称谓）候选，带建议替换。
11. **批量导入**：`novel_import` 原稿件自动识别书名与章节号分类导入。
12. **续写辅助**：先读后写、保持文风/伏笔/世界观一致，`novel_new_chapter` 创建新章节。
13. **全工具 UI 开关**：侧边栏「写作助手功能」面板统一管理（总开关 + 每工具独立开关 + 功能开关 emotionCaveat/genreTheme）。

---

## 提供的工具

| 工具 | 说明 |
|------|------|
| `novel_books` | 列出章节库全部作品 |
| `novel_chapters` | 列出某作品章节清单 |
| `novel_read` | 阅读某章正文（分段） |
| `novel_keywords` | 关键词：二字组/三字组/疑似人名 |
| `novel_new_chapter` | 创建新章节文件 |
| `novel_import` | 原稿件批量导入/分类 |
| `novel_sentence_analysis` | 句式模式分析（九类/情感净化/曲线/指纹） |
| `novel_sentence_config` | 查看/修改工具与功能开关 |
| `novel_style_check` | 风格自检（相似度+偏差清单） |
| `novel_plot` | 伏笔/剧情线登记表 |
| `novel_settings` | 设定管理（人物/地点/道具/时间线/世界观） |
| `novel_summary` | 章节摘要（长书续写辅助） |
| `novel_continuity_check` | 连贯性审计（设定矛盾+语用冲突候选） |

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

`<书库根>/.novel-writer/`：`plots`（伏笔）/ `settings`（设定）/ `summaries`（摘要）/ `analysis`（分析报告）/ `audits`（审计报告）。

---

## 许可证

[MIT](./LICENSE)
