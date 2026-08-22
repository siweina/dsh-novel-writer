# 📚 dsh-novel-writer — 小说写作助手

[**English**](./README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/siweina/dsh-novel-writer.svg?style=flat-square)](https://github.com/siweina/dsh-novel-writer/releases)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

为 **DeepSeek Harness (DSH)** 打造的小说写作助手插件（v3.0.0）：章节库管理、句式分析、情感净化与量化、**文笔六维基线带**、氛围光谱、**风格画像报告**、伏笔设定管理、本地语义检索（0 token）、网文信号识别、批量导入与 AI 续写辅助。宿主端零第三方依赖，浏览器端仅依赖 Web GUI 自带的 react。**要求 Node ≥ 22.3。**

> **致非中文用户**：本插件为中文小说分析写作而设计——句式、情感、意象等核心能力以及内置的语义模型，全部针对中文语料构建与调优。在深耕中文的同时兼顾英文等其他语言，确实超出了我目前的能力范围。若因此给您带来不便，我深感抱歉，恳请谅解。

---

## 安装

**方式一：npm（推荐）**

```sh
dsh plugin --profile web add dsh-novel-writer
# 或
npm install dsh-novel-writer
```

**方式二：从 GitHub 安装**

```sh
dsh plugin --profile web add github:siweina/dsh-novel-writer#main
```

安装后**重启 web 应用**生效（宿主端注册 15 个工具与 state/reveal/update-check 路由，浏览器端挂载侧边栏「写作助手功能」开关面板）。

---

## 功能

1. **文笔六维基线带**（v3.0.0 核心，novel_style_report / novel_style_check）：六维量化指标——句法复杂度 / 修饰密度 / 抽象度 / 动作密度 / 不确定性 / 留白指数；每章测 μ±σ 形成原著基线带，新章逐维对照判定（带内 ✓ / 半带 △ / 出带 ⚠）。**主题/情节/人物完全自由——基线只管写法层面，不碰内容。**
2. **推荐容差（上手即用）**：基线带每维自动给出推荐容差 = 原著章节波动的 **1.5 倍 σ**（取整到 5%，限 ±10%~100%）；用户也可在侧边栏「写作助手功能 → 风格基线」按维度自定义 ±% 容差（正负号按位置固定，输入框只收 0~100 数字）。
3. **风格画像报告**（novel_style_report）：6 维测量——文风指纹 / 高频词汇 / 题材流派 / 情感量化 / 氛围光谱 12 轴 / 语义风格距离。**测量与判断分离**：插件只报数不贴标签，AI 判断可回传存盘。
4. **氛围光谱 12 轴**：噩梦感 / 焦虑压抑 / 温馨治愈 / 甜宠日常 / 催泪虐心 / 黑暗残酷 / 悬疑神秘 / 热血激昂 / 荒诞无厘头 / 孤独疏离 / 文艺唯美 / 情欲暧昧——证据链可追溯，0 token。
5. **本地语义引擎**：bge-small-zh 中文模型（24MB 随插件分发）本地 CPU 推理——自然语言搜全书语义相关段落（带章节定位），语义级风格对比、语义隐性情感，懒加载 + 自动回退。
6. **句式模式分析**：九类句式分布、排列规律、句长节奏、情感曲线、风格指纹与节奏建议，带缓存与报告导出。
7. **情感净化 + 量化**：强/弱情绪词分级、污染源检测、caveat 预警 + AI 复核；Valence 滑动窗口 → 方差 V / 斜率 Δ / 矛盾指数 C。
8. **写作辅助全家桶**：伏笔登记表 / 设定五张表 / 章节摘要 / 连贯性审计 / 批量导入 / 风格自检 / 续写辅助 / 更新检查。
9. **全工具 UI 开关**：侧边栏「写作助手功能」面板（总开关 + 工具开关 + 功能开关 + 风格基线容差），显示数据目录占用与语义引擎状态。

---

## 提供的工具（15 个）

| 工具 | 说明 |
|------|------|
| `novel_books` | 列出章节库全部作品 |
| `novel_chapters` | 列出某作品章节清单 |
| `novel_read` | 阅读某章正文（分段） |
| `novel_keywords` | 关键词：二字组/三字组/疑似人名 |
| `novel_new_chapter` | 创建新章节文件 |
| `novel_import` | 原稿件批量导入/分类 |
| `novel_sentence_analysis` | 句式模式分析（九类/净化/量化/曲线/指纹） |
| `novel_sentence_config` | 查看/修改工具与功能开关 |
| `novel_style_check` | 风格自检（规则+语义+**文笔六维对照**） |
| `novel_style_report` | 风格画像报告（6 维测量 + **六维基线带**） |
| `novel_plot` | 伏笔/剧情线登记表 |
| `novel_settings` | 设定管理（人物/地点/道具/时间线/世界观） |
| `novel_summary` | 章节摘要（长书续写辅助） |
| `novel_continuity_check` | 连贯性审计（设定矛盾+语用冲突候选） |
| `novel_semantic_search` | 语义检索（本地 embedding，0 token） |

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

`<书库根>/.novel-writer/`：`plots`（伏笔）/ `settings`（设定）/ `summaries`（摘要）/ `analysis`（分析报告+基线）/ `audits`（审计）/ `embedding`（语义索引）/ `style-reports`（风格画像）。

---

## 许可证

[MIT](./LICENSE)
