# 📚 dsh-novel-writer — 小说写作助手

[**English**](./README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/siweina/dsh-novel-writer.svg?style=flat-square)](https://github.com/siweina/dsh-novel-writer/releases)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

为 **DeepSeek Harness (DSH)** 打造的小说写作助手插件（v3.1.0）：章节库管理、句式分析、情感净化与量化、氛围光谱、**风格画像报告**、**文笔六维基线带**、伏笔设定管理、本地语义检索（0 token）、网文信号识别、**原创模式与创作资料管理（设定书/动态大纲/钩子回填）**、批量导入与 AI 续写辅助。宿主端零第三方依赖，浏览器端仅依赖 Web GUI 自带的 react。**要求 Node ≥ 22.3。**

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

安装后**重启 web 应用**生效（宿主端注册 15 个工具与 state/reveal 路由，浏览器端挂载侧边栏「写作助手功能」开关面板）。

---

## 功能

1. **风格画像报告**（novel_style_report）：6 维测量报告——文风指纹 / 高频词汇 / 题材流派 / 情感量化 / 氛围光谱 12 轴 / 语义风格距离。**测量与判断分离**：插件只报数不贴标签，AI 判断可回传存盘（`.novel-writer/style-reports/`），续写保持风格一致。
2. **氛围光谱 12 轴**：噩梦感 / 焦虑压抑 / 温馨治愈 / 甜宠日常 / 催泪虐心 / 黑暗残酷 / 悬疑神秘 / 热血激昂 / 荒诞无厘头 / 孤独疏离 / 文艺唯美 / 情欲暧昧——证据链可追溯，0 token。
3. **本地语义引擎**：bge-small-zh 中文模型（23MB 随插件分发）本地 CPU 推理——`novel_semantic_search` 自然语言搜全书语义相关段落（带章节定位），语义级风格对比、语义隐性情感，懒加载 + 自动回退。
4. **句式模式分析**：九类句式分布、排列规律、句长节奏、情感曲线、风格指纹与节奏建议，带缓存与报告导出。
5. **情感净化 + 量化**：强/弱情绪词分级、污染源检测、caveat 预警 + AI 复核；Valence 滑动窗口 → 方差 V / 斜率 Δ / 矛盾指数 C + 隐性意象载体。
6. **世界观与语用检测**：文化基准自动判断（西/东/混合）+ 置信度；speechStyle 称谓/客套/仪式/语气规范；题材流派 + 网文信号。
7. **写作辅助全家桶**：伏笔登记表 / 设定五张表（人物·地点·道具·时间线·世界观）/ 章节摘要 / 连贯性审计 / 批量导入 / 风格自检 / 续写辅助。
8. **全工具 UI 开关**：侧边栏「写作助手功能」面板（总开关 + 工具开关分组 + 功能开关），大白话文案，显示数据目录占用与语义引擎状态。
9. **风格基线（v3.1.0）**：文笔六维测量（句法复杂度/修饰密度/抽象度/动作密度/不确定性/留白指数）+ 按章节 μ±σ 基线带；`novel_style_report` 输出基线带，`novel_style_check` 对照新章偏差（带内 ✓ / 出带 ⚠）；侧边栏可自定义每维 ±% 容差（**推荐值 = 原著章节波动的 1.5 倍 σ**，自动取整、限 ±10%~100%；输入框留空即用推荐）——原创/续写时主题自由、写法保持在基线带内。

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
| `novel_sentence_analysis` | 句式模式分析（九类/情感净化/量化/曲线/指纹） |
| `novel_sentence_config` | 查看/修改工具与功能开关 |
| `novel_style_check` | 风格自检（规则+语义双维度） |
| `novel_style_report` | **风格画像报告**（6 维测量 + AI 判断分离） |
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

`<书库根>/.novel-writer/`：`plots`（伏笔）/ `settings`（设定）/ `summaries`（摘要）/ `analysis`（分析报告）/ `audits`（审计）/ `embedding`（语义索引）/ `style-reports`（风格画像）。

---

## 许可证

[MIT](./LICENSE)- **写作哨兵三件套（v3.2.0）**：`novel_continuity_check` 扩展——①**衔接检查**（chapter 参数：时间硬跳/语义距离/人物延续/钩子承接四路检测，带原文引用）②**OOC 检测**（ooc 参数：角色情绪基线偏离）③**大纲走偏**（outline 参数：方向行 vs 正文关键词重合）；报告工具支持 **brief 精简模式**；主面板新增**书库统计卡**（近 7 天活跃字数）、**🎬 体验演示**（内置示例不落盘）、**📊 报告历史**（analysis/style-reports 列表浏览）；错误提示带解决步骤；工具说明压缩省 token；单元测试 + GitHub Actions 自动打包。
- **原创模式**：侧边栏填写创作设定（世界观/角色/禁忌/主线/题材/额外要求，留空=模型自定）；novel_outline 维护创作资料（创作设定/人物/剧情大纲/钩子记录/创作状态卡），原创强制「设定书→大纲→钩子」链，动态批次（10→20→30 章）防剧情跳跃与角色 OOC。

