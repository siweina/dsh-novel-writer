# 📚 dsh-novel-writer — 小说写作助手

[**English**](./README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/siweina/dsh-novel-writer.svg?style=flat-square)](https://github.com/siweina/dsh-novel-writer/releases)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

为 **DeepSeek Harness (DSH)** 打造的小说写作助手插件：章节库管理、句式模式分析、情感净化与量化、风格自检、伏笔登记、设定管理、世界观/语用检测、**本地语义检索（0 token）**、批量导入与 AI 续写辅助。宿主端零第三方依赖，浏览器端仅依赖 Web GUI 自带的 react。

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

安装后**重启 web 应用**生效（宿主端注册 14 个工具与 state/reveal 路由，浏览器端挂载侧边栏「写作助手功能」开关面板）。

---

## v2.0.0 新增：本地语义引擎（0 token）

- 🧠 **内置中文语义模型**（bge-small-zh-v1.5 quantized，23MB，随插件分发）：512 维向量，本地 CPU 推理，**零 API 费用**；
- 🔍 **novel_semantic_search**：用自然语言搜全书语义相关段落（伏笔/情感场景/设定提及），即使原文没有相同关键词也能命中；
- 📊 **语义级风格对比**：novel_style_check 在规则指纹之外新增语义相似度维度；
- 💭 **语义隐性情感**：情感原型句扫全书索引，发现"词表外疑似意象段落"；
- 🪶 懒加载 + 失败自动回退纯规则（不影响任何既有功能）。

---

## 功能

1. **章节库管理**：章节存放于 `novels/<书名>/第N章.md`（或 .txt/.markdown），编码自动探测（UTF-8/UTF-16/GBK）。
2. **句式模式分析**：九类句式分布、排列规律、句长节奏、情感曲线、风格指纹与节奏建议，带缓存与报告导出。
3. **情感净化**：强/弱情绪词分级、污染源检测、caveat 预警 + AI 复核闭环、cleanDominant 真实基调。
4. **情感量化**（v1.6.0）：Valence 效价映射 + 滑动窗口 → 方差 V / 斜率 Δ / 矛盾指数 C；隐性意象载体 + 显隐冲突；复杂度评分 + 复合情感共现。
5. **风格自检**：章节 vs 全书 → 相似度 + 偏差清单 + 续写建议。
6. **伏笔登记表**：open/done 状态、字段化登记、章节提及自动追踪。
7. **设定管理**：人物/地点/道具/时间线/世界观 五张表。
8. **世界观与语用检测**：自动判断文化基准（西/东/混合）+ 置信度；speechStyle 称谓/客套/仪式/语气规范。
9. **题材与流派检测**：主副题材 + 流派识别，低频噪音自动过滤。
10. **章节摘要**：每章摘要 + 关键事件，长书续写先读摘要。
11. **连贯性审计**：设定矛盾 + 语用冲突候选，带建议替换。
12. **批量导入**：原稿件自动识别书名与章节号分类导入。
13. **续写辅助**：先读后写、保持文风/伏笔/世界观一致。
14. **全工具 UI 开关**：侧边栏「写作助手功能」面板（总开关 + 每工具开关 + 功能开关）。

---

## 提供的工具（14 个）

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
| `novel_plot` | 伏笔/剧情线登记表 |
| `novel_settings` | 设定管理（人物/地点/道具/时间线/世界观） |
| `novel_summary` | 章节摘要（长书续写辅助） |
| `novel_continuity_check` | 连贯性审计（设定矛盾+语用冲突候选） |
| `novel_semantic_search` | **语义检索**（v2.0.0，本地 embedding，0 token） |

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

`<书库根>/.novel-writer/`：`plots`（伏笔）/ `settings`（设定）/ `summaries`（摘要）/ `analysis`（分析报告）/ `audits`（审计）/ `embedding`（语义索引缓存）。

---

## 许可证

[MIT](./LICENSE)
