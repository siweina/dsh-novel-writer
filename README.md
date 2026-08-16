# dsh-novel-writer — 小说写作助手插件（v0.8.1：记忆层）

DSH（DeepSeek Harness）小说写作助手 bundle 插件。宿主端零第三方依赖（仅 Node 内置模块），
浏览器端仅依赖 Web GUI 自带的 react。
**v0.8.1 在 v0.7.0 基础上补全「记忆层」：四张设定表、章节摘要、连贯性审计、伏笔字段化与提及追踪、细节密度指标、统一数据目录、UI 路径可视化修复**：分析缓存与报告导出、风格自检、伏笔登记表、
关键词三字组/疑似人名、情感词典去噪、祈使句与环境分类改进、局域网开关可选放行。

## 工具清单（13 个，全部带独立 UI 开关）

novel_books / novel_chapters / novel_read / novel_keywords / novel_new_chapter / novel_import / novel_sentence_analysis / novel_sentence_config / novel_style_check / novel_plot / **novel_settings（设定管理）** / **novel_summary（章节摘要）** / **novel_continuity_check（连贯性审计）**

## v0.8.1 新增能力

- **novel_settings（四张表）**：人物卡/地点卡/道具清单/时间线，list/add/update/delete + scan 候选提取；
- **novel_summary**：模型生成、插件存储的每章摘要（长书续写先读摘要）；
- **novel_continuity_check**：对照设定表扫描全书 → 数字口径/人物缺场/别名/重复条目矛盾候选；
- **novel_plot 字段化**：type/priority/relatedCharacters/locations/payoffCondition/mentionedIn/lastMentioned + scan 自动提及追踪；
- **细节密度指标**：动作链密度/物件名词/感官词（千字归一）进 novel_sentence_analysis 与 novel_style_check；
- **统一数据目录**：§BT§<书库根>/.novel-writer/§BT§ 下 plots/ settings/ summaries/ analysis/ audits/（伏笔旧位置自动迁移；分析缓存与关键词报告落盘到 analysis/）；
- **UI 路径修复**：cordis 空字符串 root 回退 lastRoot、面板刷新按钮、打开/复制按钮不再禁用、显示 dataDir。

## v0.7.0 更新内容

- **10 个工具全部带独立 UI 开关**（侧边栏「写作助手功能」面板）：novel_books / novel_chapters / novel_read / novel_keywords / novel_new_chapter / novel_import / novel_sentence_analysis / novel_sentence_config / novel_style_check / novel_plot，默认全开；
- UI 更名：侧边栏入口/面板/横幅由「句式分析」改为「写作助手功能」；设置页卡片同步；
- novel_sentence_config 升级：支持 tools 参数（如 `{ novel_plot: false }`）与返回各工具开关状态；
- 关闭的工具调用时返回明确提示（模型可见）。
```
