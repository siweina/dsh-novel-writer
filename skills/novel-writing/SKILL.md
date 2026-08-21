# 小说写作助手 (novel-writing)

## 章节库约定

- 所有小说章节存放在工作区 `novels/<书名>/` 文件夹下，每章一个 Markdown 文件，命名如 `第01章.md`、`第02章.md`。
- 优先使用专用工具 `novel_books` / `novel_chapters` / `novel_read` 浏览与阅读；也可用 `glob`/`read` 直接查看。

## 分析工作流

1. `novel_books` 找到用户的作品；
2. `novel_chapters` 查看章节结构与各章字数；
3. `novel_read` 逐章通读（长章节用 offset/limit 分段读完）；
4. `novel_keywords` 提取高频关键词（二字组/三字组/疑似人名/英文词）；
5. `novel_sentence_analysis` 做句式模式分析（九类分布、排列规律、情感曲线、章节节奏、风格指纹）；
6. 输出分析，至少覆盖三方面：
   - **剧情脉络**：冲突、转折、悬念、伏笔、人物关系与目标；
   - **写作手法**：叙事视角、节奏、对话、环境与细节描写、比喻意象、留白；
   - **关键词与意象**：结合 novel_keywords 的结果，指出作者反复使用的词汇与意象，并引用具体章节佐证。

## 句式模式分析（v0.5.0 合并 + v0.6.0 增强）

- 九类句式：陈述/环境/心理/对话/疑问/反问/感叹/祈使/省略留白；
- 情感曲线（喜/怒/哀/惧/惊）、句长节奏、段落结构、风格指纹、节奏建议（guidance）；
- **缓存**：结果自动缓存（返回 `reportFile` / `cache`），章节未变重复分析秒回，`fresh=true` 强制重算；
- 情感词典已去噪（"叹气"不算"气"、"不害怕"不计）、祈使/环境分类已增强。

## 风格自检（v0.6.0 新增）

- 写完新章节后调用 `novel_style_check`：本章 vs 全书其余章节 → 相似度 + 偏差清单 + 建议；
- 偏差明显时主动调整文风（对话/心理占比、句长、情绪），防止漂移。

## 设定管理（v0.8.0 新增）

- §BT§novel_settings§BT§：五张表（人物卡/地点卡/道具清单/时间线/世界观用语规范），list/add/update/delete/scan/detect；
- 登记新人物/新地点/道具去向，时间线记录"第几天/倒计时"；
- §BT§novel_continuity_check§BT§：续写前跑一次，输出设定矛盾候选（数字口径/人物缺场/别名/重复）。

## 章节摘要（v0.8.0 新增）

- 读完每章后调用 §BT§novel_summary§BT§ add 保存 200-500 字摘要 + 关键事件 + 关键设定；
- 续写长书时先 §BT§novel_summary§BT§ list 回忆剧情，再按需 §BT§novel_read§BT§ 细读。

## 伏笔登记表（v0.6.0 新增）

- `novel_plot`：list / add / update / done / delete 管理伏笔与剧情钩子；
- 续写前先 `novel_plot list` 查看未回收伏笔，续写中主动回收；
- 存储于 `<书库根>/.novel-writer/<书名>.json`。

## 续写工作流

1. 先通读最近的章节（必要时读完全书），保持：人物设定、时间线、情节伏笔、文风、已提炼的关键词一致；
2. `novel_plot list` 查看未回收伏笔；
3. 动笔前简述：上一章结尾状态 → 本章目标 → 写作计划；
4. 用 `novel_new_chapter` 创建新章节文件，或直接用 `write` 工具写入；
5. 正文用中文，保持与原文一致的叙事风格与细节密度；句式分析开启时参考指纹与节奏序列，僵硬时回归自然表达；
6. 写完后 `novel_style_check` 自检文风，`novel_plot add` 登记新伏笔。

## 注意事项

- 用户放入章节文件的方式不限：自己复制、AI 用 `write`/`edit` 创建，或用 novel_import 批量导入。
- 分析结果与续写正文都应使用中文呈现。

## 世界观用语规范（v0.10.0 新增）

- **文化基准自动判断**：§BT§novel_settings§BT§（category=worldview，action=detect）扫描全书，按中西词表命中自动判断文化基准（western/eastern/mixed/unknown）并给出证据与置信度；
- **用语规范登记**：detect 后可用 §BT§novel_settings§BT§ add（category=worldview）登记：name（基准名）、basis（判断依据）、bannedWords（禁用词表）、recommended（替代词映射）、ritual（仪式规范，如"点烛不烧香"）；
- **续写前检查**：动笔前先确认 worldview（detect 或人工指定），对照 bannedWords/recommended 用词，**并对照 speechStyle 检查说话方式**（称谓/客套/仪式/语气——不只管"词"，还管"怎么说话"）；
- **语用级检查（v1.0.0）**：worldview 的 speechStyle 定义 title（称谓规范）/ honorBad（中式客套禁词）/ ritualBadPatterns（仪式通配，如"上X柱香"）/ tone（语气）；novel_continuity_check 会输出「语用冲突·客套 / 语用冲突·仪式 / 语用冲突·称谓」三类候选；
- **示例**（欧式中世纪）：Miss+名（不用"XX小姐"）、不写"提点/承蒙/在下"、宗教点烛不烧香/不"上柱香"、对话口语化不文言；
- **自动化审计**：§BT§novel_continuity_check§BT§ 会自动扫描禁用词命中，输出「用语冲突」候选（含建议替换词）；
- **时代错置分类**（词表按此组织）：器物 / 称谓 / 计量 / 宗教仪式 / 市井风貌 / 服饰 / 食物 / 制度；
- **参考资料**（写作时校对）：
  - Medieval Wordbook（Madeleine Pelner Cosman）
  - The Writer's Complete Fantasy Reference
  - Fantasy Writers Phrase Book（Jackson Dean Chase）
  - 凌力谈历史小说语言：错用一个现代词会破坏整个历史氛围

## 情感可信度与 AI 复核（v1.5.0）

- novel_sentence_analysis 返回 emotion 含 `dominant`（raw）与 `cleanDominant`（仅强情绪词）与 `confidence`（high/medium/low）与 `caveat`（污染警告）与 `aiAction`（明确指令）；
- **当 `caveat` 非空（confidence=low，检测到高密度成人向/战斗/恐怖描写）时，你必须执行 `aiAction`**：用 §BT§novel_read§BT§ 抽查 2-3 段原文，复核真实情感基调后，在结论中同时给出"插件预警"与"AI 复核结果"，不得直接采信 dominant；
- 例如：某作品 raw 主导"喜"但 clean 主导"哀"且成人向词密度超标 → 插件报 low + 警告，AI 抽查后应判断"整体基调为哀伤，'喜'来自感官反应词"；
- 功能开关（侧边栏「写作助手功能」面板或 novel_sentence_config）：emotionCaveat（情感净化预警）/ genreTheme（题材与流派检测），关闭后对应输出消失。

## 情感量化解读（v1.6.0）

novel_sentence_analysis 的 emotion.quantification 是纯规则计算的数字（0 token 成本），请直接读取并按以下方式理解：

- **stats.variance（撕裂度 V）**：0~1。>0.3=情绪被反复撕扯（前半大喜后半大悲类）；<0.05=平静。
- **stats.adjVariance（相邻撕裂）**：相邻窗口情绪差平均，抓"上一秒哭下一秒笑"的急转弯。
- **stats.delta / deltaRobust（趋势 Δ）**：>+0.3 基调转好，<-0.3 基调转坏（滑向低谷），中间=拉锯。
- **stats.conflict（矛盾指数 C，0~1）**：同窗正负词交织程度。>0.5=极度矛盾（悲喜交加/又爱又恨），续写必须"反复横跳"不能平滑解决；≈0=单一情感或无矛盾。
- **implicit（隐性意象）**：雨/黄昏/枯枝等意象的负向占比。negative 高 + 显性 meanValence 正 → 表里不一（表面开心内心压抑）。
- **compare.explicitImplicitConflict**：true = 强颜欢笑类复杂情感，心理刻画必须分两层。
- **complexity.score（0~1）**：整体复杂度温度。high(≥0.6) 禁止贴单一情感标签。
- **composites**：全书高频复合情感对（悲喜交加×N 等）。

用法：把这些数字直接转化为写作指令（如"C=0.7 → 这段要矛盾螺旋，不能平滑"），不要为了判断情感去读整章原文。

## 语义隐性情感（v2.0.0）

novel_sentence_analysis 的 emotion.quantification.semanticImplicit（semanticEmbedding 开启且模型可用时输出）：
- **hits**：全书"词表外疑似意象段落"top 10——每条含情感标签（温暖/甜蜜/释然/幸福/温柔/眷恋/仰慕/压抑的愤怒/隐忍/悲伤/孤独/怅惘/失落/心碎/恐惧/焦虑/不安/厌恶/震惊/疏离/决绝/不舍/无奈/脆弱/苦涩，共 25 类原型）+ 余弦分数 + 章节；
- **distribution**：各情感命中段落数分布；
- 与规则意象表（雨/黄昏/攥紧衣角）互补：规则抓"已知载体"，语义抓"没有关键词但读起来就是那个情绪"的段落；
- 用法：写复杂心理时，可据此感知全文的隐性情感基调（如 distribution 显示"脆弱 2/焦虑 2/失落 1" → 这本书表面中性、内里压抑），不用读全文。

## 非净化模式（v2.0.0，用户双重确认后开启）

- 当 systemPrompt 注入【非净化模式已开启】或检测到 features.rawWriting=true 时：模仿作者文风续写**必须还原原文直白程度**（血腥/暴力/成人），不回避、不委婉、不用省略替代；
- 该模式由用户显式开启（双重确认 + 承诺输入），仅限个人创作用途；
- 未开启时照常按平台安全边界处理。

9. **风格画像报告（v2.5.0）**：分析/续写前先跑 novel_style_report——它输出 6 维测量数据（文风指纹/高频词汇/题材流派/情感量化/氛围光谱 12 轴/语义风格距离），**插件不贴标签**；AI 需结合数据给出风格气质判断，并通过 aiJudgment 参数回传（插件存入 .novel-writer/style-reports/，后续用 action=get 读取）。续写时参考已保存判断保持风格一致。
10. **网文信号层（v2.2.0）**：网文动作/套路词群（含 genre-tropes 现成词）、题材联动（豪门总裁→甜宠等）、情感直给词密度——三层信号只加分不换引擎，权重封顶防污染；三组回归（公版文学/手写样本/网文库）验证无污染。
