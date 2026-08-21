# dsh-novel-writer — 小说写作助手插件（v2.0.0）

DSH（DeepSeek Harness）小说写作助手 bundle 插件。**v2.0.0 集成本地语义嵌入引擎（bge-small-zh-v1.5 ONNX，随插件分发，本地 CPU 推理，0 token 成本）**，在不增加任何 API 费用的前提下获得语义级能力。

## 工具清单（14 个，全部带独立 UI 开关）

novel_books / novel_chapters / novel_read / novel_keywords / novel_new_chapter / novel_import / novel_sentence_analysis / novel_sentence_config / novel_style_check / novel_plot / novel_settings（设定管理）/ novel_summary（章节摘要）/ novel_continuity_check（连贯性审计）/ **novel_semantic_search（语义检索，v2.0.0 新增）**

## v2.0.0 新增能力（语义层）

### 本地语义嵌入引擎（embedding.js）
- 模型：Xenova/bge-small-zh-v1.5（512 维中文向量，约 91MB），随插件分发，开箱即用；
- 运行时：**@huggingface/tokenizers**（官方轻量分词，294KB 零依赖）+ onnxruntime-web（WASM 推理），本地 CPU，0 token、0 API 费用；
- 懒加载：首次调用才加载（约 0.3s）；加载失败自动回退纯规则，不影响任何既有功能；
- 索引缓存：每书向量落盘 `.novel-writer/embedding/<书>.json`，重复检索秒开（47 万字约 3100 段，首次建索引约 20-30s，之后命中缓存）。

### 新工具：novel_semantic_search（语义检索）
用自然语言描述在全书中检索语义相关段落——找伏笔线索、情感场景、设定提及，**即使原文没有相同关键词也能命中**（如搜「压抑克制的时刻」能命中没有"压抑"二字的段落）。

### novel_style_check 升级：语义级风格对比
规则指纹相似度（句式/句长/情绪）之外，新增**语义相似度**（目标章 vs 全书其余部分向量余弦），双维度判定风格一致性。

### 功能开关：语义增强（semanticEmbedding）
- **默认开启（探测式）**：模型存在即自动启用；用户可在侧边栏「写作助手功能」面板关闭，关闭后语义检索返回提示、风格检查跳过语义维度；
- 关闭后插件完整回退到 v1.6.0 纯规则能力。

## 历史能力（v0.3 → v1.6 累积）
- 句式模式分析（九类句式分布/排列/段落/句长/情感曲线/风格指纹/密度）；
- 情感净化 + AI 复核（强/弱情绪词分级、污染预警 caveat、强制抽查）；
- 情感量化（Valence 滑动窗口：方差/斜率/矛盾指数 + 隐性意象 + 复杂度评分）；
- 世界观/流派/题材检测（modern/western/eastern + 15 流派 + 35 题材，主副题材）；
- 语用级审查（称谓/客套/仪式/语气，中西/现代禁用词）；
- 设定管理五张表 + 伏笔登记 + 章节摘要 + 连贯性审计 + 风格自检；
- 分析缓存与报告导出（`.novel-writer/analysis/`）。

## 功能开关（侧边栏「写作助手功能」面板）
- 总开关 enabled；autoAnalyze；14 个工具级开关；
- 功能级：emotionCaveat（情感净化预警）/ genreTheme（题材与流派检测）/ emotionComplexity（情感量化）/ **semanticEmbedding（语义增强，v2.0.0）**。

## 目录结构
```
dsh-novel-writer-v2.0.0/
├── lib/
│   ├── index.js        # 宿主端（14 工具 + state 路由 + 开关门禁）
│   ├── analysis.js     # 规则引擎（句式/情感净化/情感量化/题材）
│   ├── embedding.js    # 本地语义嵌入引擎（bge-small-zh ONNX）
│   ├── models/         # 模型文件（onnx/model.onnx 91MB + tokenizer）
│   └── client.js       # 浏览器端（侧边栏面板 + 全部开关）
├── node_modules/       # @huggingface/tokenizers + onnxruntime-web（随插件分发）
├── test/               # 引擎 + client + e2e 测试
└── skills/novel-writing/SKILL.md  # 模型使用指南
```

## v2.1.0 新增：氛围光谱 + 多方向意象表
- **氛围光谱（vibe）**：detect 输出 10 轴氛围坐标（噩梦感/焦虑压抑/温馨治愈/甜宠日常/催泪虐心/黑暗残酷/悬疑神秘/热血激昂/荒诞无厘头/孤独疏离）+ 组合结论 + 置信度 + 证据链——设定型气质（类克苏鲁等）以数值表达，不贴死标签；
- **多方向意象表**：变色龙词（雨/烛火/火光/夜/灯…）按语境触发词裁决方向，触发词未命中时用本地语义引擎与正/负原型句比余弦，仍不确定则双计分并标记歧义——修复"甜宠文误判负向 100%"类问题；
- **词表**：内置大连理工七类情感词表（27,413 词）供意象/情感扩展。

## v2.2.0 新增：网文信号层（vibe 三路补强）
- **动作/套路词群**：164 词（含 webnovel-writer genre-tropes 现成套路词：退婚/打脸/秒杀/追妻火葬场…），按 10 轴分组，封顶权重（每轴 ≤0.3）；
- **题材联动**：题材命中 → 相关轴加分（豪门总裁→甜宠、系统流→荒诞/热血、玄幻→热血…），仅当该轴已有基础信号时触发；
- **情感直给词密度**：joy/fear/sorrow/anger 词计数 → 对应轴密度加分；
- **防污染四道防线**：加信号不换引擎 / 低权重封顶 / 来源标注可审计 / features.webnovelVibe 开关可回退；三组回归（公版文学 8 本 + 手写样本 6 本 + 网文 6 本）验证无污染；
- **词表资源**：lib/lexicons/webnovel-tropes.md（现成套路模板）+ dutir_seven.json（大连理工 27,413 情感词）。

## v2.5.0 新增：风格画像报告（测量与判断分离）
- **novel_style_report（第 15 个工具）**：聚合 6 维测量数据（文风指纹/高频词汇/题材流派/情感量化/氛围光谱 12 轴/语义风格距离）输出结构化报告；
- **插件只报数不贴标签**：氛围光谱 12 轴（新增 文艺唯美/情欲暧昧），砍掉规则结论文案——判断交给大模型；
- **AI 判断回传存盘**：AI 结合报告给出风格气质判断 → aiJudgment 参数回传 → 存入 .novel-writer/style-reports/<书>.json，后续 action=get 读取，续写保持风格一致；
- **语义风格距离**：12 组风格原型句 × 全书向量（本地 embedding，0 token）——实测示例书：克苏鲁诡异 0.79/压抑致郁 0.79。

## 体积说明
**zip 约 31MB**（含本地语义模型与 WASM 运行时，解压后代码+模型约 130MB）；已移除 transformers.js/onnxruntime-node/sharp 全家桶（省 85%）。如磁盘紧张可在「语义增强」开关关闭后删除 `lib/models/` 与 `node_modules/`，插件回到纯规则模式。
