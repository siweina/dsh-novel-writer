# 更新日志（Changelog）

## [5.0.0] - 2026-09-17

**从「体检仪」到「写作台」——把测量能力往前挪到动笔之前。** 本版新增 **2 个工具（16 → 18）**、给 `novel_plot` 加上 `action:"graph"` 结构视图、新增与「档位」正交的「场景」提示词维度，并把测试里的工具数断言改为从单一事实源派生。既有工具的行为与返回结构不变；`general` 场景下的提示词与 4.x **逐字相同**。

### 一、新能力（3 项）

1. **`novel_chapter_brief` 开写包**（新增工具）
   **动机**：动笔前要用的材料（上一章结尾、本章方向、人物卡、待回收伏笔、用语规范、风格基线、锚段、禁用清单）此前分散在 **6~8 次工具调用**里，靠系统提示词叮嘱模型逐个去取——**漏读是文风漂移与设定矛盾的头号来源**。
   **做法**：把它压成**一次调用**装配齐，从结构上消灭漏读。返回 `anchor`（上一章结尾原文＝承接口）/ `previousHook` / `outlineDirection` / `characters` / `openPlots`（带 `distance`＝埋了多久没回收）/ `worldview` / `baseline` / `anchors` / `skeletons` / `lastVerdict` / `avoid`（本章禁用清单）/ `plan.checklist` / `degraded`（取不到的材料及原因）。**只读不写盘。**
   **边界**：优雅降级——没有大纲 / 没有伏笔 / 没有设定表 / 全书只有 1 章，一律返回空值并在 `degraded` 里说明原因，**绝不抛错**（唯一例外是书名目录不存在）。

2. **`novel_fix_plan` 改稿台**（新增工具）
   **动机**：`novel_style_check` 给的是「数据」（偏差清单 + 锚段 + verdict），模型拿到后还得自己组织成行动，容易挑着容易改的改、把结构性偏差留在原地。
   **做法**：把风格诊断从「数据」变成「**按优先级排好的待办**」——每条含原句位置（行号区间 + 原文）、当前值与目标值、可参照的原著锚段、改写方向。三个 action：`plan` 生成清单 / `verify` 对当前正文复测（`resolved` / `pending` / `new` 三态）/ `mark` 标记单项（`itemId` + `state: done|skip`）。排序规则：**严重度降序 → 难度升序 → 行号升序**。落盘 `<root>/.novel-writer/audits/fix-plan-<书>-<章号>.json`（原子写 + 文件事务，重跑保留人工标记）。
   **边界：只给方向、不生成正文**——生成是宿主模型的事，这是插件「零 token / 正文不出本机」的立身之本。覆盖 **8 类问题**：句式偏离 / 抽象度过高 / 留白异常 / 情感过直 / 禁用词 / 语用不符 / 衔接缺失 / 伏笔未回收（阈值 20 章）。行号归因是**段落级**：宁可粗（整段）也不给错的行号，定位不到时给全章层面并说明。**正常文本不产出任何条目**（防误报是硬要求）。

3. **`novel_plot { action: "graph" }` 结构视图**（不新增工具）
   **动机**：伏笔 / 人物 / 时间线此前是**离散静态表**，没有任何跨章计算；而长篇崩掉通常不是某章文笔差，而是**线断了、人丢了、伏笔忘了**。
   **做法**：输出 `plotLifecycle`（埋设章 + `distance`）、`characterMatrix`（人物 × 章节出场矩阵 + 连续缺席 ≥ 5 章，只算首次出场之后，别名也算出场）、`threadActivity`（按关联人物 / 地点聚类成「线」，算跨度与最大空档）、`timelineOrder`（登记顺序 vs 章号顺序）、`planVsActual`（大纲方向行 vs 正文关键词重合率）。**只读。**

### 二、工效改进与文档（3 项）

4. **场景化提示词**：新增与「档位」**正交**的「场景」维度——档位决定**注入多少**（`off` / `brief` / `full`，不变），场景决定**注入什么**（`general` 通用 / `writing` 写新章 / `revising` 改稿 / `auditing` 审计 / `setup` 建资料）。原先只有一段通用提示词（通用档实测 3047 字），模型每轮都要自己从里面挑出当前任务相关的那几条，既占上下文又容易挑错；场景档只讲当前那件事，实测 430–687 字。
   **向后兼容**：`general` 即 4.x 那段通用工作流，老状态文件（没有 `promptScene` 键）自动落到 `general`，**既有工作流不变**——本版只在其中补入三条新工具的入口指引（第 3 节【开写包】3 行、第 7 节【改稿台】2 行 +【结构视图】2 行，共 +7 行），其余各行与 4.x 逐字相同。可用 `novel_sentence_config` 读写，侧边栏面板也有对应的开关行。

5. **测试断言去硬编码**：`e2e` 与 `mcp` 测试里的工具数从「硬编码 16」改为从 `lib/core.js` 的 `ALL_TOOLS` **单一事实源**派生。旧写法每加一个工具都要改测试，而且**只能发现"少注册"、发现不了"多注册"**；现在双向比对，以后加工具只改 `ALL_TOOLS` 一处。

6. **README 重写定位与上手路径**（中英双语同步）：此前首屏还停在「本地章节体检」，新能力被压在功能列表第 13 条。现在改为**「本地写作工作台」**，新增一节 **「写作流程（一条能走完的闭环）」**——取材料 → 动笔 → 自检 → 改稿 → 跨章体检五步，每步给出「你说什么 / 用哪个工具 / 拿到什么」；痛点表补上三条新痛点（动笔前翻六七个工具还漏读、知道有问题但不知先改哪句、线索与人物写到后面才崩）；「看看输出」补上**开写包与改稿台的真实输出片段**；功能列表把三件套提到**第 1 条**。

### 三、本版刻意未做：工具合并

审计三个测量工具（`novel_style_check` / `novel_style_report` / `novel_sentence_analysis`）后确认：它们**没有可合并的冗余**——重叠发生在引擎与缓存层，且已正确共享，属好设计而非重复实现。真正的问题是**工具描述不互斥**（模型看不出该调哪个），因此本版不改工具划分，改为在站点文档补一张「该调哪个工具」对照表。

### 四、装机全量实测后的修补（4 处，版本号不变）

在本机重启后把 **18 个工具、全部 action 真实调用一遍**（含本地语义引擎、重号拒绝、空书降级、配置读写与还原），据此修掉 4 处小问题。同一次实测也反向确认了几处**原本以为有问题、实际无误**的写法：`items[]` 返回体确实恒为 9 字段（`state`/`stateAt` 只写落盘文件）、`graph` 的 `timelineOrder` 省略 `number` 键能被宿主正常接受、`fix_plan` 的绝对量级闸把「留白差值 8.36 < 门槛 12」正确忽略（不误报）。

| 现象 | 修法 |
|---|---|
| `novel_new_chapter` 的 `title` 只写进正文一级标题，文件名恒为 `第NN章.md`，而清单标题取自**文件名** → 用 title 建的章在 `novel_chapters` 里显示成空标题（`第07章  —`） | ① title 经 `sanitizeSegment` 清洗后**一并进文件名**（`第NN章 标题.md`，剥非法字符 + 截断 24 字；标题全是非法字符则退回不带标题的文件名，不因此拒绝创建）；② `novel_chapters` 增加**一级标题回退**（`firstHeadingTitle`），顺带修好手工创建的 `第NN章.md` |
| `novel_fix_plan` 的 `id` 只存在于返回体与落盘文件里，模型要 `mark` 必须先自己去读 `planFile` 才能拿到 | 清单渲染在每条待办的「类型/严重度/难度/位置」行下方增加一行 `id：fix-…` |
| `verify` 只在「按 type 兜底匹配」时拼「（人工标记 done/skip）」；正文没动时 id 必然精确命中，于是标了 done 反倒在复测里看不出来 | 第一轮（id 精确命中）也拼上人工标记，与文档既有描述一致 |
| `mark` 传了非法 `state` 时提示「需要 state 参数」，容易被误判成漏传参数 | 区分两种情形：未传 → 「缺少 state 参数：只能是 "done" 或 "skip"」；传了非法值 → 「state 只能是 "done" 或 "skip"，收到："finished"」 |

### 五、验证

- 五套自带测试全部通过：**unit 20 项、pattern、client、e2e、MCP**（协议 + 工具断言）。
- e2e 新增段覆盖**开写包、改稿台、结构视图**三者的**主路径与降级路径**；另有 `v500PostAuditFixes` 段覆盖上表四处修补（标题进文件名 + 非法字符剥离、文件名优先与 H1 回退、清单渲染带 id、verify 显示人工标记、state 报错区分「没传 / 非法值」）。
- 装机实测：18 个工具的全部 action 在真实宿主下逐一调用通过（含 `novel_plot action=graph` 带「章号不可解析」时间线条目、`novel_semantic_search` 本地 ONNX 引擎、同章号歧义拒绝、空书 8 条降级、`novel_sentence_config` 写后还原）。

## [4.3.1] - 2026-09-17

**P0 修复（用户报告）：同章号多文件时，其中一份被永久抢走、任何参数都读不到。** 本版只修这一个问题，并把它从"静默"变成"可诊断"。

### 一、P0：同章号多文件 → 一份永久不可达

**报告现象**（报告者版本 4.0.1）：某工具把一章拆成两个文件后，"调用写作插件就会把定位定位到新拆出来的文章，旧的文章就调动不了了——**两个显示的都是同一个文章但其实不是同一个**"。

**4.3.0 现场复现**（`novels/测试书/` 放三个文件）：

| 文件 | 说明 |
|---|---|
| `第03章 初遇.md` | 旧的第三章原文 |
| `第03章 重逢.md` | 新拆分出来的第三章 |
| `第3章 初遇.md` | 另存的同号同名文件 |

`novel_chapters` 列出 3 条，其中两条显示**完全同名**的"第03章 初遇"（只有括号里的文件名不同）。随后用各种参数读取：

| 传入参数 | 旧版实际读到 | 结果 |
|---|---|---|
| `"3"` | 排序靠前的那份 | 看运气 |
| `"第03章 重逢.md"`（**完整文件名 + 扩展名**） | **另一份** | ❌ 错 |
| `"第3章 初遇.md"`（另一份的完整文件名） | **另一份** | ❌ 错 |
| `"初遇"`（标题） | 排序靠前的那份 | 看运气 |

**`第3章 初遇.md` 的正文，用章号、完整文件名、标题三条路全部读不到** —— 永久不可达。摘要同样共用一个槽位（`novel_summary get` 两份文件返回同一条），`novel_continuity_check` 则报"未发现明显矛盾候选"。

**根因**（`lib/core.js`）：

1. `findChapter()` 的查找顺序是**先章号、后文件名**。参数里只要含"第3章"，`parseChapterNumber` 就先解析出章号 3 并命中 `chapters.find(c => c.number === 3)`；**精确文件名匹配那一行永远轮不到**，所以传完整文件名也会读到另一份。
2. `scanChapters()` 不去重，两份都进列表；排序 `(a.number)-(b.number) || a.file.localeCompare(b.file)` 决定谁排前面 —— **谁排前面谁赢，另一份彻底消失**。

**修法**：

1. **精确文件名优先**（含省略扩展名的文件名）——用户明确指定了文件名就必须听他的；
2. **章号命中多个文件时拒绝执行**，报错并列出全部候选文件，同时提示"把 chapter 写成其中一个文件名即可指定"（文件名匹配已在前一步生效，所以这条提示是可直接执行的）。

> **行为变化（请注意）**：同章号的书里，`novel_read` / `novel_sentence_analysis` / `novel_style_check` / `novel_continuity_check` / `novel_plot`（scan）/ `novel_keywords` 按**章号**定位时会由"静默返回其中一份"改为**报错**。这是刻意的：静默读错稿比报错危险得多。指定文件名（可省略扩展名）即可正常读取。

### 二、把"同章号"变成看得见的问题

- `novel_chapters`：列表末尾新增 `⚠️ 同章号多文件 N 组` 分组，逐组列出撞号的文件名与章号（旧版只有两条看不出区别的同名条目）
- `novel_continuity_check`：默认扫描新增 **「同章号多文件」** 候选，可直接当体检项用

### 三、4.0.1 → 4.3.0 的既有修复（本次复检确认，供报告者对照）

报告者版本 4.0.1 还有两个**会产生重号/串号**的独立缺陷，4.3.0 已修，本次逐函数对比确认：

| 项 | 4.0.1 | 4.3.0 |
|---|---|---|
| `parseChapterNumber("第０３章.md")` 全角章号 | **`undefined`（认不出）** | `3` |
| `nextFreeChapterFile` 的重号检查 | 看不见全角文件 → **会新建出同章号文件** | 看得见 → 自动避让到下一空闲章号 |
| `novel_new_chapter` 取 maxNumber | 跳过认不出的文件 → 生成重复章号 | 正确计入 |
| `novel_import` 的占用检查 | 同上失守 | 正确 |
| `normalizeChapterKey("第一千零一章")` | **`"第01章"`（与第 1 章撞键）** | `"第1001章"` |
| `normalizeChapterKey("第０１章")` | `"第０１章"`（当成独立一章） | `"第01章"` |

即：**4.3.0 堵住了"自己造出重号"的入口，4.3.1 补上"已经重号之后怎么读"。**

### 四、已知限制（本版未改）

- `novel_summary` 以 `normalizeChapterKey(章节参数)` 作为存储键，**同章号的两份文件仍共用同一个摘要槽位**（属既有设计，改动会波及既有摘要文件格式，未纳入本版）。
- 外部工具**直接落盘**的同号文件，插件无法在写入时阻止；本版的做法是"使用时拒绝并列出候选"。

### 五、验证

- 新增 e2e 回归段 `duplicateChapterRegression`：列表提示 / 文件名优先 / 省略扩展名命中 / 章号歧义拒绝且候选齐全 / 审计检出 / **无重号的书零误报**
- 全套自带测试通过：unit 20 项、pattern、client、e2e（含新回归段）、MCP 协议 67 项

## [4.3.0] - 2026-09-13

**全量缺陷整修（第二轮）**：对 v4.1.1 的 9 个源文件 + 测试 + 文档（约 11,600 行）逐行审计后，修复 **1 处 P0（会产生错误结果）+ 6 处 P1 + 21 处 P2 + 35 处 P3**，并完成 MCP 协议符合性与版本协商、更新检查状态、语义缓存与诊断文案、打包锁文件等收尾修复，以及 1 处联调期发现的提示误报修正。四套自带测试（unit / pattern / client / e2e）与 MCP 协议测试（67 项）全部通过。

> 本版把原内部迭代 **4.2.0** 与 **4.2.1** 合并发布（两者均未对外发布）；源码注释里的 `v4.3.0：` 标记即本版改动。

### 一、P0：会产生错误结果（1 处）

1. **同一份报告里两个"主导情感"互相矛盾**（`lib/analysis.js`）
   `cleanScoresOf` 仍用朴素 `indexOf` 逐词扫描，没有 v4.0.0 给 `emotionOf` 补的"最长匹配 + 区间消费"，
   于是「悲痛 ⊂ 悲痛欲绝」这类嵌套强词被双计：分章计数得 `{sorrow:2, anger:1}`、句级得 `{anger:1, sorrow:1}`，
   同一份 `novel_sentence_analysis` 输出里 `emotion.cleanDominant = anger` 与
   `quantification.complexity.dominant = sorrow` 同时出现（实测输入 `"悲痛欲绝，他却只觉得愤怒。"`，
   情感复杂度评分 0.42 → 修复后 0.57）。
   **修法**：把"收集 → 按词长降序 → 区间消费"抽成 `scanEmotionHits()`，`emotionOf` 与 `cleanScoresOf` 共用同一份实现，从结构上消除两处口径漂移。

### 二、P1：必修（6 处）

2. **中文章号解析漏「千」→ 摘要静默覆盖**（`lib/core.js`）
   `normalizeChapterKey` 的字符类缺「千」且未锚定，"第一千零一章" 会从"千"之后开始匹配、归一成 `第01章`
   （实测与 `第01章` **键碰撞 = true**），而 `parseChapterNumber("第一千零一章.md")` 得 1001 —— 同输入两种口径。
   `novel_summary` 以它作存储键，给第 1001 章写摘要会**覆盖第 1 章的摘要并回复"已保存"**。
   **修法**：5 处章号正则的字符类统一补「千万」（`normalizeChapterKey` / `cleanChapterTitle` /
   `nextFreeChapterFile` / `bookNameFromFileName` / `bookNameFromContent`）。

3. **祈使句判定整类失配**（`lib/analysis.js`）
   v4.0.0 给硬祈使词加的 `(?![\u4e00-\u9fa5])` 边界过严："放下刀！/ 小心点！/ 赶紧走！/ 给我滚！"
   整类被判成「感叹」（直接扭曲句式分布，并经 `subjectivityIndex` 抬高主观性指数）；同时"别人。" 仍被判祈使
   （CHANGELOG 曾宣称该类误判已归零，实为未收敛残留）。
   **修法**：在严格规则后补一条受限的宽松规则（硬词 + 0~3 字宾语/补语 + 命令语气收尾），排除句首同形副词
   「马上/立刻」与体标记（"注意到他了。"）；新增 `SINGLE_HARD_FALSE_POSITIVES` 黑名单
   （别人/快乐/请柬/滚烫/莫大…）；顺带修正 `caller` 捕获组导致黑名单取错位置的问题。

4. **六维基线 μ=0 的维度被静默跳过**（`lib/style-metrics.js`）
   某维基线均值为 0 时旧版直接 `continue`：新章该维无论多离谱都不产生判定，`summary` 却仍宣称
   "全部维度在容差带内 ✓"（实测 hedgeDensity / gapIndex 给到 50 被完全忽略，μ=0 的"零留白全书 + 满篇省略号新章"会被报成正常）。
   **修法**：σ>0 时改用绝对尺度判定（`|v| > 1.5σ` → out，`basis:"absolute"`、`devPct:null`），
   其余登记 `skippedDims` 并写进 summary；渲染层同步支持（不再打印 "null%"），无出带维度但有跳过维度时也会披露。

5. **`chunkText` 遇 U+2028/U+2029 抛 TypeError**（`lib/embedding.js`）
   `.` 不匹配这两个行分隔符，超长行 `match()` 返回 `null` → `for...of null` 抛
   `TypeError: pieces is not iterable`，使整本书的语义检索 / 隐性情感 / 语义风格对比同时降级；
   混在正常文本中的它们还会被静默丢弃（chunk 与原文不再逐字一致）。
   **修法**：归一化阶段把 `\u2028/\u2029/\u0085` 一并转成 `\n`；切块正则改 `/[\s\S]{1,150}/g` 并保留 `|| [line]` 兜底。

6. **内置技能 SKILL.md 从未被 DSH 加载**（`skills/novel-writing/SKILL.md` + `lib/index.js`）
   该文件既没有 YAML frontmatter（`dsh-skill-filesystem` 会直接忽略并 warn），包内 `skills/` 又不在宿主枚举的
   任何技能根下（`<project>/.dsh/skills`、`~/.dsh/skills`、`~/.agents/skills`…），插件也没注册 provider ——
   默认「精简」档提示词里那句"详细规范见 novel-writing 技能"实际上指向一个查不到的技能（实测工具报 unknown）。
   **修法**：补 frontmatter（name/description/whenToUse）；按官方 `dsh-skill-badge` 的写法在 `apply()` 中
   `ctx.inject(["skills"], …)` 自注册 provider（只读包内 SKILL.md、不写用户目录、不需改宿主配置，
   宿主没有 `skills` 服务时静默跳过）。**注意**：需重启 DSH 后技能才在会话目录中可见。

7. **MCP 服务器的 root/src 可越权读写**（`mcp/server.mjs`）
   工具参数里的 `root` 被原样放行——"只读写书库根目录"的承诺等于交给调用方决定；配合
   `novel_import{src, mode:"apply", move:true}` 可把盘上任意目录的 `.md/.markdown/.txt` 复制进书库再读出，
   `move` 还会删除源文件。README 原文"不访问其他路径"与实现不符。
   **修法**：`root` 必须落在启动参数 `--root` 指定的书库根之内（越界则回退并记 stderr）；
   `novel_import` 的 `src` 默认同样限根内，确需导入外部目录时用新增开关 `--allow-external-src`；
   README 的「权限与外部服务」段落改正为与实现一致的表述。

### 三、P2：逻辑错误 / 契约不一致 / 健壮性（21 处）

**`lib/analysis.js` + `lib/style-metrics.js`（13 处）**

8. `topWords` 与 `scores` 不同源（嵌套词重复计）：`"他悲痛欲绝，悲痛得说不出话。"` 旧版 scores.sorrow=2 而 topWords 合计 3 → 改为复用 `emotionOf` 的命中列表。
9. `adverbWeight` 用 6 字窗口做子串匹配且跨标点：`"老太太高兴。"` joy 1.5→1、`"策略让他高兴。"` 0.6→1、`"太阳高照她很高兴。"` 1.5→1 → 改为按标点截断取当前小句 + 单字副词需紧邻。
10. 否定白名单漏字：`X别 + 情感词`（别人/告别/级别…之外的 15 种组合）被整词丢弃 → 内联词素白名单补全。
11. **分句口径三处不一致**：`TERMINATORS` 缺半角 `?!`，同一句 `"你疯了?我没疯!他走了。"` analysis 得 1 句、style-metrics 得 3 句 → 常量统一为 `"。！？…!?"` 并由两个文件共用（`style-metrics.js` 从 `analysis.js` 导入）。
12. `splitBlocks` 的 `---` 分割线过滤只在"无空行"分支生效 → 提升到两分支之前（`"第一段。\n\n---\n\n第二段。"` 3 段 → 2 段）。
13. `delta` 与 `deltaRobust` 采样基不同却共用 ±0.3 阈值（同一文本 -0.305 vs -1.4）→ 统一到全窗口序列并返回 `deltaBasis`。
14. 空窗口被填成"效价 0"稀释 `adjVariance`（真实跳变 1.6 被算成 0.278）→ 加 `hasHit` 标记，只在相邻两窗均有命中时累加并按有效对数归一（新增 `adjPairs`）。
15. **implicit 三比率两套分母**（`negative+positive=1` 但 `ambiguousRatio` 用另一分母，渲染出"负 100% / 歧义 50%"）→ 统一三分口径；`explicitImplicitCompare` 改为按已裁决命中判定方向。
16. 修饰密度把"真的/的确/似的"当修饰语（`他的确走了。`=1、`他说的是真的。`=2）→ 命中后按 2-4 字整体做停用词排除。
17. 抽象度 `(?![\u4e00-\u9fff])` 使"抽象词只在后随非汉字时才计"（`她的感情很深。`=0 而加逗号=1）→ 去掉后随否定，改最长匹配 + 3-4 字优先，并排除 知道/味道/街道 等假阳性。
18. 动作密度词表混入名词/形容词且有 29 条重复（`他十分高兴。` actionCount=2、`他很胖。`=1）→ 去重（665→625 条）并清洗非动词条目。
19. 推荐容差"下限 10%"在默认参数下不可达（σ 被钳到 ≥0.15μ），且钳制值被当"作者自身波动"展示 → 新增 `sigmaMeasured` / `sigmaUsed` / `sigmaClamped` 三个字段（`sigma` 数值与三条既有断言均不变）。
20. `DI_NOUN_ENDINGS` 55 条里 16 条因 `endsWith("地")` 恒假而永不可达 → 按"地"的位置拆成两张表（39 + 16），39 条全部可达且假阳性消失。

**`lib/core.js`（12 处）**

21. **`atomicWriteJson` 双重失败被静默吞掉**（rename + 直写都失败仍回"已保存"）→ 改为抛 `ENOVELWRITEFAIL`（含 `rename=`/`write=` 原因），`POST /state` 转 500。
22. **无 BOM 的 UTF-16 永远识别不了**（中文正文 NUL 占比约 1.5%，过不了 5% 阈值，全落 GBK 分支抛错）→ 新增 UTF-16 结构启发式（严格 UTF-8 判定之后、GBK 之前），实测 6 编码 × 3 样本全绿；错误文案区分"缺 BOM 的 UTF-16"与真正无法识别。
23. **全角数字章号不可解析**（`第０１章.md` 与 `第01章.md` 可并存）→ 入口做定向宽度归一（只映射 `０-９－．／`，**不整串 NFKC**——那会把标题里的 `。` 变成 `.`）。
24. `upsertCreationSection` 段边界依赖"段内无空行"（用户手写一个空行就只删/改一半）→ 改为以「`#` 标题 / `【…】`段 / 文件尾」为界，remove/replace 双路径幂等。
25. `readBookAllText` 逐章拼接无分隔符（跨章句子粘连、指纹无谓失效）→ 补 `\n`。
26. 0 字节章节行数口径矛盾（`novel_chapters` 报 0 行 / `novel_read` 报 1 行）→ core 侧固化为 0 行并抽出 `countTextLines()`，`novel_read` 同步改用（断言用 `Math.max(totalLines,1)` 兜底，空章节仍可读）。
27. `bookNameFromFileName` 把"中文数字+空格"开头的书名丢掉（`三 体.md` → undefined）→ 章号判定必须有 章/回/话/节 或数字边界（"未分类"12 项回归全绿）。
28. `novel_outline` 输出 schema 声明了从不产出的 `files`、漏声明真实产出的 `file` → 修正。
29. `writeSentenceState` 把派生字段 `exists` 固化落盘 → 写盘前剔除（读取侧语义不变，首写返回值不再自相矛盾）。
30. `detectChapterBridge` 死代码 + 硬编码路径 + 未 `sanitizeSegment`（书名含特殊字符时两类检查静默消失）→ 清理并统一，读取失败透出"衔接·检查跳过"提示。
31. `buildStyleAnchorPackage` 的"无预读文本就去读盘"兜底在现有调用点永不执行 → 删除并在 try 之外 assert 契约。
32. `scanWordHits` 对空字符串词条会死循环（沙箱实测旧版挂死）→ 补 `if (wlen <= 0) continue;` 守卫。

**`lib/index.js`（12 处）**

33. **`emotionCaveat=false` 连带杀掉情感量化**（`cropEmotion` 返回体不含 `quantification`，紧随其后的 `emotionComplexity` 判断恒假）→ index.js 侧实现"裁剪前留存 → 按开关回挂"。
34. **`novel_style_report` 完全不遵守这两个开关**（关掉净化预警仍输出 raw↔clean 对照、Δ/V/C、隐性情绪，与 SKILL.md 承诺冲突）→ 报告、`dimensions`、落盘判断统一套开关裁剪。
35. 首次 `novel_sentence_config set` 返回值与刚落盘状态相反（首写报 enabled=true / source=默认值）→ 写后重读 state。
36. `novel_summary` 未清洗脏数据（`[null]` 让 list/get/add/update/delete 全部 TypeError）→ 读取后 `cleanSummaryEntry` 过滤。
37. 风格判断存盘绕过 `atomicWriteJson`（全文件唯一直接写目标文件处）→ 改原子写。
38. 语义引擎**瞬时**不可用会清掉已缓存的语义裁决结果（引擎恢复后要重跑 29 次原型推理）→ 区分"用户关闭（应清）"与"引擎波动（不该清）"。
39. 连贯性审计 4 处候选的章节列表未截断（300 章书上单条 detail 可带 300 个章名）→ 统一 `slice(0,5)` 并补"（共 N 章，仅列前 5）"。
40. 大纲模式的单一 `try` 把"章节读失败"误报成"该书无创作资料"→ try 缩到大纲读取，循环内单章 try/catch 计数并附"（跳过 N 章读取失败）"。
41. `brief:true` 对模型侧不省 token（render 从不读 `value.brief`）→ render 内识别 brief（1956 → 196 字）。
42. 数字口径扫描器字符类缺 `零/两`（"两万"配不上"20000"）→ 对齐为 `[零一二两三四五六七八九十]`。
43. 43 个"导入后零使用"的死导入 → 121 → 78 个符号（逐个 grep 确认）。
44. `analysis/` 报告缓存永不清理 → 按书保留最近 20 份（`REPORT_CACHE_KEEP`），`-full.json` / `-chapters-metrics.json` 不误删。

**`lib/client.js`（13 处）**

45. "刷新"白名单漏 `systemPromptMode`（刷新后三档开关显示旧值）→ 补字段 + stale 守卫。
46. localStorage 降级持久化写读不对称（宿主不可达时切"关闭"，刷新页面又变回"精简"）→ 写入补该字段。
47. 7 处 fetch 无超时/取消（宿主 `GET /state` 遍历大书库时永久 loading、开关全部 disabled 且无任何提示）→ 统一 `fetchWithTimeout`（8s，`AbortSignal.timeout` → `AbortController` → 退化三级特性检测）+ finally 复位 + 加载期渲染「正在读取开关状态…」。
48. 宿主可操作错误被丢弃（"报告不存在"/"request body too large (limit 1MB)"/"forbidden: loopback-only" 全被显示成"网络/路由不可用"）→ 新增 `hostError()` 透传。
49. 受控 `<select>` + confirm 取消分支不重渲染（DOM 停在 B 而表单仍是 A，设定可能存进另一本书）→ 取消分支显式触发同步。
50. CSS 挂在宿主不存在的属性上（`[data-dsh-frame]` / `[data-pane=…]` 在宿主 968 个源文件中 **0 命中**）→ 折叠规则改用真实的 `[data-sidebar-collapsed]`，删掉死选择器。
51. `creation.newed` 提示被同 tick 的 `openView` 清空（永不显示）→ 调整顺序。
52. `nwFlash` 分支不可达（`refreshedAt>0` 与 `revealErr===true` 互斥，v4.0.0 声称的"错误提示也闪烁"没落地）→ 错误分支独立拼 `nwFlashErr`。
53. 语言切换后面板文案不刷新 → langObserver 顺带触发重渲染，并真接 `ctx.locale` 服务（`inject` 里声明的 `locale` 不再白挂）。
54. 加载期可保存风格容差（空草稿把宿主已存容差清成 null）→ 输入与按钮补 `disabled: state.loading`，loading 时直接 return。
55. rev 竞态：在途 POST 与"刷新"回读互相覆盖 → 新增 `pendingWrites` 计数，有在途写入时刷新不回写。
56. 死代码：`ALL_TOOLS` 死变量、`state.file` 写了 4 处从不读取（改为"数据目录"卡里的 state 文件入口，宿主已支持 reveal `state-file`）、10 个从未渲染的 i18n 词条、设置卡片从未使用的 `props.toggle`。
57. `test/client-test.mjs` 的 `createRoot` 桩使 React 组件体从不执行 → 实现最小可执行 React 子集，面板/视图/弹窗/设置卡真正渲染（3 组件 / 92 vnode / 12 次渲染）。

**`lib/vibe.js` + `lib/embedding.js` + `lib/update-check.js` + `lib/lexicons/markers.js`（13 处）**

58. **题材联动"加成"实为减分**（写进加权平均，轴均值 > bonus 时被拉低：absurd −0.011、mystery −0.017，可翻转 top3）→ 改为输出期加法 `clamp01(均值+bonus)`；实测"纯标签 Δ=0、有证据 Δ=+bonus"。
59. `__styleproto.json` 缓存键不含 model/dim 且不自愈（换模型/缓存半损坏后 12 个原型全被静默跳过、永不重建，UI 却报"语义引擎不可用"）→ payload 增写 `{model,dim}`，失配删缓存重算 + 只 warn 一次，并加失败通道 `results.reason`。
60. 4 个题材 token 永不命中（现言/替身/仙侠/奇幻 与 `THEME_MARKERS` 键值域不交集）→ 改真实键名 / 由证据词覆盖。
61. "西方词群 N 次"被 8 词证据上限截断（真值 36 报成 24）→ 优先用 `detect.scores`。
62. nightmare/mystery 轴级题材推送绕过证据门控（纯标签 Δ +0.175/+0.334）→ 移到证据后并与 `linkThemes` 同源门控（Δ=0）。
63. 同词两种计数口径（重叠 n-gram vs 非重叠 indexOf，"甜甜甜甜甜甜" 5 vs 3）→ `countHits` 改重叠计数。
64. `fingerprint` 无定界编码（不同分块集合指纹相同，实测 `a\u0000b|c` 与 `a|b\u0000c` 碰撞）→ 长度前缀定界（碰撞 2/6 → 0/6）。
65. `STYLE_PROTOTYPES` 无消费者却导出 → 去掉 export。
66. `sampleEvenly(arr,1)` 返回 `[undefined]` → 取中位段。
67. **失败负缓存会覆盖成功缓存**（成功记录过期后一次离线就把 `latestVersion` 覆盖成 `{error:true}`，5 分钟内无法区分"已是最新"与"检查失败"）→ 负缓存独立成 `update-check-error.json`。
68. 版本校验 `/\d/` 过弱（`tag_name:"第4版"` 会被当成功写入 24h 缓存）→ 严格整串校验（`v4.3.0` / `dsh-novel-writer-v3.9.6` / `release-3.9.6` / rc / `+build` 仍接受）。
69. markers 词表重复项（城堡/便利店/朋友圈/点赞）→ 去重（`scanWordHits` 位图消费本就不双计，属卫生问题）。

**`mcp/server.mjs` + 打包 + 文档（18 处）**

70. **`render` 快速路径 16/16 不可达**（插件 16 个 `render` 全返回 `[{type:"text",text}]` 数组，MCP 只认字符串）→ MCP 客户端终于收到精修文本而非整包 JSON。
71. 非法 JSON 行未回 `-32700` Parse error → 补帧后继续读流。
72. `notifications/*` 无条件静默（带 id 的请求永不结算，实测 60s 超时）→ 有 id 回 `-32600`，无 id 仍静默；`notifications/cancelled` 现在真取消（stub exec 注入 `AbortSignal`）。
73. 批量请求零覆盖 → 新增 batch 断言（3 请求 → 2 响应、逐帧校验 `jsonrpc`/id）。
74. readline 无行长上限 + 忽略写背压（超大报文/写满管道无界涨内存）→ 自实现按 `\n` 切分 + 4 MiB 行长上限（超限整行丢弃）+ `drain` 背压。
75. stderr 可能泄漏正文（非法行前 200 字符 + 完整堆栈含绝对路径）→ 只记长度/摘要，堆栈仅 `DEBUG=1`。
76. 插件加载失败直接 `exit(1)`、无 JSON-RPC 错误帧 → stderr 写明原因与逃生口，新增 `--ignore-plugin-load-error`（initialize 正常、tools/list 空清单、其余 `-32603`）。
77. `mcp-test.mjs` 只在开头断言一次游离响应、不校验 `jsonrpc` → 收尾补断言（测试 35 → **60 项**）。
78. `mcp/README.md` 数字与说明失实（33 项 → 60 项、漏"疑似人名"、教用户跑不随包发布的 test/）→ 改正并新增「0. 安全边界」章节。
79. `package-lock.json` 版本停在 3.9.5 且混入 npmmirror registry → 改为 4.3.0 + 统一 npmjs；随后已联网完整重生成并补齐根包 bin 字段（见第九节）。
80. `package.json` 的 `files` 缺 `smithery.yaml`（CHANGELOG 的承诺不成立）且 `lib/client.js` 冗余 → 修正。
81. `server.json` 未声明 `runtimeHint` / `packageArguments`（包名 ≠ bin 名，`npx -y dsh-novel-writer` 命不中服务器）→ 补齐，并补两个环境变量。
82. `cordis.patch.yml` 注释过时（v4.0.0 / 旧入口名）→ 更新（insert 结构一字未动）。
83. `README.en.md` 与中文版不同步（两段重复安装说明、缺痛点对照表/60 秒上手/输出示例/对比表/MCP 示例/致非中文用户）→ 以中文版为源对齐（142 → 231 行）。

### 四、P3：死代码、无效代码与文档一致性（35 处，节选）

- **死代码/无效代码**：`client.js` 的 `ALL_TOOLS`、`state.file`、10 个未渲染 i18n 词条、`nwFlash` 不可达分支、不可达的 `createRoot` 桩路径；`analysis.js` 两轮无人消费的句级 dominant 循环、`quoted`/`block`/`windowCount`/`hitWindowCount`/`weightedTotal` 五个只写不读的字段；`core.js` 的 `findChapter` 纯数字死分支、`detectChapterBridge` 二次单行化、`buildStyleAnchorPackage` 不可达读盘兜底、`writeSentenceState` 的派生键落盘；`vibe.js` 的 `freqIn`（父代理裁决修复其唯一调用点后成为死函数，已删）与 4 个永不命中的题材 token；`index.js` 的 43 个死导入；`style-metrics.js` 的 16 条不可达地名后缀；`mcp/server.mjs` 的 render 字符串快速路径。以上每项都用全仓库 grep 取证。
- **口径修正**：DUTIR 词表 853 条 ≥5 字词条（含 9-15 字成语）因窗口上限写死 4 而永不命中 → 提到 8（性能增量 1.3%）；`sampleText` 在截断/未截断两条路径不同源 → 统一；`ACTION_VERBS` 29 条重复；`markers.js` 4 条重复；注释与实现不符 4 处（黑暗猎奇分流、`×`/`\u00d7` 冗余交替、`saveIndex` JSDoc、震惊★归属两张表矛盾）。
- **文档一致性**：`mcp/README.md` 断言数、缺失参数、`npx` 命令可达性；`README.en.md` 结构同步；`cordis.patch.yml` 注释；`package.json` files 冗余；`server.json` 字段完整性。

### 五、MCP 协议符合性（2 条，按规范原文修正）

1. **未知工具改回协议错误 `-32602`**。依据 MCP《Tools → Error Handling》，*Unknown tools* 属 Protocol Error，
   规范示例即 `{"code": -32602, "message": "Unknown tool: invalid_tool_name"}`。更早的内部迭代曾以"声明版本是 2024-11-05"
   为由保留 `isError` 内容响应——现改为规范行为，可读提示移到 `error.data.hint` / `availableToolCount`；
   同步修正 `test/mcp-test.mjs` 断言与 `mcp/README.md`（原「两处已知偏差」章节改为「规范符合性说明」）。
2. **批量请求（batching）改为按协商版本门控**。JSON-RPC batching 自 MCP `2025-06-18` 起被移除：
   协商到该版本及以后 → 回 `-32600`；协商到 `2024-11-05` / `2025-03-26` → 保留实现（向后兼容旧客户端）。

### 六、协议版本协商（新增；原实现违反生命周期规范）

服务端此前固定回 `protocolVersion: "2024-11-05"`，而规范要求"客户端请求的版本若受支持，服务端 **MUST** 原样回"。
现支持 `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05`：受支持则原样回，否则回最新支持版本。
`test/mcp-test.mjs` 新增 6 条断言（含"请求不受支持的版本 → 回最新"与"2025-11-25 会话下批量被拒"），**60 → 67 项**。

### 七、更新检查可区分「已是最新 / 检查失败」

`checkForUpdate()` 返回体升级为稳定形状：新增 `ok` / `stale` / `lastSuccess` / `checkedAt`；
**失败但有过成功记录时仍返回历史的 `latestVersion`/`releaseUrl`**（此前一律 `null`，调用方无法区分"已是最新"与"检查失败"）。
成功记录与失败负缓存继续分文件存放（成功记录绝不被失败覆盖），24h / 5min / 3s 超时语义不变。
侧边栏在 `ok === false` 时显示一行灰字「更新检查失败（上次成功：…）」（新增中英词条各 2 条），不影响面板其它功能。

### 八、语义分析两条残留缺陷

- **`novel_sentence_analysis` 的缓存命中路径不再抹掉语义裁决结果**：更早的内部迭代只修了 `novel_style_report` 一侧，
  句式分析的命中路径仍会在"引擎瞬时不可用"时把缓存里的 `semanticImplicit` 抹成 null，引擎恢复后必须重跑
  29 次原型推理 + 全索引检索。现把判据抽成共用的 `semanticGate()`，两条路径逐字一致：
  只有"用户明确关闭语义功能"才清缓存。
- **语义风格对比为空时不再一律写"语义引擎不可用"**：`vibe.js` 的 `semanticStyleDistances()` 会在返回的空数组上
  挂一个非枚举 `reason`（`no-engine` / `no-chunks` / `proto-embed-failed` / `chunk-embed-failed` / `error` / `ok`）；
  `novel_style_report` 现按 `reason` 输出区分文案（引擎不可用 / 本书太短 / 原型向量失败 / 段落向量失败 / 计算失败 /
  空表），`reason` 缺失或未知时逐字回退原文案。

### 九、打包与文档

- **`package-lock.json` 已联网重新生成**（`npm install --package-lock-only`，无联网重生成是更早内部迭代的遗留限制）：
  版本 3.9.5 → **4.3.0**、registry 统一为 `registry.npmjs.org`、补齐根包的 `bin` 字段；
  依赖树 22 个节点（onnxruntime-web 1.24.3 / @huggingface/tokenizers 0.1.3）。换行风格保持该文件原有的 CRLF。
- **11 个零消费者导出明确为"有意公开的 API"**：在 `lib/analysis.js` 头部写明名单与理由（纯函数，
  供 MCP 侧与使用方脚本复用），不再按"疑似死代码"处理；如需收缩公开面请留到下一个大版本。

### 十、窄边界处理结果

- ✅ **`fresh:true` / 未命中路径不再抹掉缓存里的语义结果**：本次若因"引擎瞬时不可用"（用户并未关闭语义功能）
  而没算出 `semanticImplicit`，会把旧缓存里的同名字段并回**落盘副本**。缓存键含内容指纹，同键即同内容，
  旧值仍然有效；**本次返回值不受任何影响**（仍是"未算出"，对外输出零变化）。用户关闭该功能时照旧按需求清空。
- ✅ **`stale` 语义精算**：改为 `!ok && lastSuccess !== null`（即"确实有历史数据可陈旧"，从未成功过时为 false）。
  任何现有消费方都不读 `stale`（侧边栏只看 `ok` 与 `lastSuccess`），对功能无影响，只是语义更准。
- ✅ **联调期发现的提示误报：`novel_outline` 的「未回填钩子章节」不再把"大纲已规划但尚未动笔"的章节算进去**。
  该提示原本拿"大纲里出现过的章号"直接比对钩子记录，而大纲按设计会预先列出下一批章节方向
  （实测：雨夜灯只写到第 5 章、大纲里已有 `- 6 第6章方向…`，却提示「未回填钩子章节：6」）。现改为只对
  **磁盘上确实存在**的章节报缺钩子；章节扫描失败时退回旧口径（宁多提醒、不漏提醒）。
  实测四场景：计划未写→不提示；写了没回填→正常提示；多处缺钩子→按大纲顺序全部列出；大纲列了不存在的章号→不提示。
- ⏸ **"引擎可用但 enrich 重算失败"保持现状（有意不修）**：它与"越界旧缓存按本章重算后确实没有隐性情感"
  **在现有代码上不可区分**——后者正是 v3.9.1 修过的正确行为（必须写回清空，否则每次命中都重复重算，
  且缓存里留下错误作用域的值）。要区分两者必须给 `enrichSemanticImplicit` 增加失败通道（跨 `lib/core.js`），
  属行为变更，按"不影响功能与准确性才修"的原则不做。

### 十一、行为变更与升级注意（**同一本书的新旧报告不可直接比较**）

| 范围 | 变化 |
|---|---|
| 情感/句式 | 嵌套强词不再双计（`悲痛欲绝` sorrow 2→1）；单字副词误命中修正（老太太/策略/太阳）；三类启发式收紧；半角 `?!` 参与分句 → 句数、句式占比、情感强度指标会变 |
| 段落/节奏 | `---` 分割线不再算一段；`deltaRobust` 采样基改为全窗口；`adjVariance` 不再被空窗口稀释（通常上升）；implicit 三比率统一三分分母（negative/positive 下降） |
| 六维基线 | μ=0 维度改用绝对尺度判定并披露 `skippedDims`；新增 `sigmaMeasured/sigmaUsed/sigmaClamped`（数值不变）；修饰密度/抽象度/动作密度口径修正 → **基线需重新生成一次** |
| 氛围 12 轴 | 题材联动改为正向加成（有证据 +bonus、纯标签 0）；nightmare/mystery 轴级标签门控；"西方词群 N 次"变真值；震惊★归 mystery → **带题材的书新旧轴分不可比**；无题材标签的书 12 轴与 confidence 完全不变 |
| 缓存 | 语义索引（`chunkText`/`fingerprint` 变更）与风格原型缓存（payload 变更）**首次运行会重建一次**，其后正常 |
| 编码/章号 | 无 BOM 的 UTF-16 现在可读；全角数字章号可解析（`第０１章` = `第01章`）；`剑来 03.md`、`斗破苍穹.01.md` 现在解析出书名 `剑来`/`斗破苍穹`（与末尾章号口径对齐） |
| 状态文件 | 不再写入派生键 `exists`；`novel_sentence_config` 首次保存即回 `source=state 文件（GUI 开关）` |
| 安全边界 | MCP 的 `root` 必须落在 `--root` 之内、`novel_import` 的 `src` 默认限根内（`--allow-external-src` 放开） |

**升级后建议**：重新生成一次文笔六维基线（`novel_style_report`）；带题材的书重新出一次氛围光谱；其余功能无需改动。

### 十二、验证结果

（下列结果均在最终代码上实测；两次内部迭代的验证记录合并于此。）

验证

```
语法   lib/*.js + mcp/server.mjs        → 0 失败
单元   test/unit-test.mjs               → 20 通过 / 0 失败
句式   test/pattern-test.mjs            → ALL PATTERN TESTS PASSED
客户端 test/client-test.mjs             → CLIENT OK
端到端 test/e2e-test.mjs                → ALL E2E TESTS PASSED
MCP    test/mcp-test.mjs                → 通过 67 项 / 0 失败（更早内部迭代为 60 项）
P0/P1  5 支独立探针（重跑）              → 全部通过
本版新增探针                          → update-check 6 场景 51 断言 / 语义缓存 11 断言 / 文案 12 断言 / fresh 缓存保护与 stale 语义 8 断言 全过
桌面 zip 解压后重跑全部套件              → 0 失败`n```n`n**安装到本机后的运行态现场验收**（DSH 0.1.5-rc.1 + 已安装副本 4.3.0）：`n`n- 运行期 `currentVersion = 4.3.0`；`update-check` 新字段 ok/stale/lastSuccess/checkedAt 均已生效`n- 内置技能 `novel-writing` 出现在会话技能目录并可被加载（修复前为 unknown）`n- 5 条路由：4×200 + reveal 400（缺参数，预期）`n- 真实书库工具冒烟全通过：books / chapters / sentence_analysis / style_report / style_check / semantic_search / plot / settings / continuity_check / outline`n- 边界用例现场复现：章号键 `第01章` 与 `第1001章` 并存（不再静默覆盖）、`放下刀！/小心点！/赶紧走！` 等 5 句判祈使且感叹 0%、含 200 字 U+2028 行的书正常建索引与检索、μ=0 维度按新文案披露、MCP 越界 root/src 被拦截`n- 另跑：MCP 协议 67 项、端到端 e2e、fixJ 等 9 支探针，全部通过`n```
```

验证结果（2026-09-13，构建副本）

```
语法：lib/*.js 与 mcp/server.mjs  node --check        → 0 失败
单元测试  node test/unit-test.mjs                     → 单元测试: 20 通过 / 0 失败
句式测试  node test/pattern-test.mjs                  → ALL PATTERN TESTS PASSED
客户端    node test/client-test.mjs                   → CLIENT OK（面板真实渲染 3 组件 / 92 vnode / 12 次视图渲染）
端到端    node test/e2e-test.mjs                      → ALL E2E TESTS PASSED
MCP 协议  node test/mcp-test.mjs                      → 通过 60 项，失败 0 项（原 35 项）
P0/P1 探针（5 支，独立于测试套件）                     → 全部通过（含修复前对照）
```

每个修复项都由独立的只读探针做过"修复前 → 修复后"对照，`mcp-test` 的 6 项新断言额外做了**反向验证**（临时打桩使断言真的失败后还原）；所有探针脚本与原始输出留档在包外。
## [4.1.1] - 2026-09-08

**修复渲染 + 上架官方 MCP Registry**：

- 修复 README.md / README.en.md / mcp/README.md 中代码围栏被误写成单反引号（`` `sh ``）的问题——
  此前安装段与 MCP 段会整段渲染成正文，Release 说明里也出现过同样的 `# MCP 客户端` 巨型标题；
- MCP 启动命令修正为实测可用的 `npx -y -p dsh-novel-writer dsh-novel-writer-mcp`：
  bin 名（`dsh-novel-writer-mcp`）与包名（`dsh-novel-writer`）不同，直接 `npx dsh-novel-writer-mcp` 会 404；
- `mcp/README.md` 去掉测试机器残留的绝对路径示例，改为 npx 与包内路径两种通用写法；
- 新增 `mcpName`（package.json）、`server.json`、`.github/workflows/publish-mcp.yml`：
  用 GitHub OIDC 免密钥发布到官方 MCP Registry，服务器名 `io.github.siweina/dsh-novel-writer`；
- 仓库根目录新增 `smithery.yaml`（供 Smithery 目录直接读取仓库配置收录；该文件随下一个版本进压缩包）。

功能与工具行为无任何变化。

## [4.1.0] - 2026-09-08

**新增：stdio MCP 服务器**——把 16 个工具原样暴露给任何 MCP 客户端（Claude Desktop / Cursor 等），
非 DSH 用户也能用。本地进程、零依赖、零联网，书库路径支持 --root / DSH_NOVEL_WRITER_ROOT / cwd。

- 新增 `mcp/server.mjs`（手写 JSON-RPC 2.0，stub ctx 启动插件并捕获 16 个工具定义）；
- 新增 `mcp/README.md`（客户端配置示例、工具清单、环境变量）；
- 新增 `test/mcp-test.mjs`（35 项断言：握手 / 工具列表 / 真实调用 / 错误隔离 / stdout 纯净）；
- package.json 增加 `bin.dsh-novel-writer-mcp` 与 files 中的 `mcp`；
- README 首屏重写（定位「给网文作者的本地章节体检」、痛点对照表、真实输出示例、对比表）。

验证：mcp-test 35/35；既有四套测试全绿；AST 扫描 0 语法错误 / 0 未定义引用。

## [4.0.1] - 2026-09-08

本版本为 **DSH STORE 上架契约合规版本**，不改变任何功能行为：

- manifest 补齐 repository / homepage / bugs，指向 canonical GitHub 仓库；
- 声明 DSH 兼容范围 dsh.engines.dsh = ">=0.1.1-rc.2"（Node 兼容沿用 engines.node）；
- 两个超出商店单文件上限（262144 字节）的数据文件改为 gzip 随包分发、加载时解压：
  tokenizer.json 439125 → 105433 字节；dutir_seven.json 382936 → 157713 字节；
- lib/index.js（299570 字节）拆分为 lib/index.js（166460）+ lib/core.js（123353）：
  仅移动声明与调整导入导出，16 个工具、2 个提示词段、5 条路由与全部行为逐字不变；
- README / README.en 补充「依赖、权限与失败边界」章节（运行时依赖、外部服务、权限边界、失败降级）。

验证：四套测试全绿；AST 扫描 0 语法错误、0 未定义引用；拆分冒烟 16 工具 / 2 段 / 5 路由 / 工具可调用。

## [4.0.0] - 2026-09-08

本次为**全量缺陷整修版本**。基于对 v3.9.5 的逐行审计（11 份报告、约 216 条问题），
按"致命缺陷 / 统计口径 / 死代码 / 性能 / 浏览器端 / 测试与发布"六组全部修复，
并追加完成原"已知限制"中的 4 项；四套自带测试由"假绿"升级为真实断言并全部通过。

### 一、修复统计

| 范围 | 负责范围 | 修复处数 |
|---|---|---|
| 致命缺陷组 | analysis.js / index.js / embedding.js / client.js | 17 |
| analysis.js + vibe.js + style-metrics.js | 统计口径 / 死代码 / 性能 / DUTIR | 28 |
| index.js | 口径 / 死代码 / 性能 | 41 |
| embedding.js + update-check.js | 索引缓存 / 语义引擎 / 更新检查 | 17 |
| client.js | 浏览器端缺陷 / 死代码 / 性能 | 33 |
| test/*.mjs + release.yml + SKILL.md | 测试加固 / CI / 文档 | 25 |
| 追加修复（第二轮） | vibe.js / analysis.js / index.js | 4 项 |
| 跨区域裁决 | prompts.js 语义对齐、版本号、收尾 | 5 |
| **新增功能** | 系统提示词三档开关（关闭/精简/完整） | index.js / client.js / prompts.js |
| **合计** | | **约 170 处** |

### 二、致命缺陷（会直接产出错误结果）

1. **情感否定把"别"当否定词**（analysis.js）：特别高兴/特别害怕 被整词丢弃。修后
   特别高兴 joy 0 → 1.5，别害怕 仍正确判为否定。
2. **祈使句判定误伤**（analysis.js）：裸 /吧/ 与硬词表无边界，酒吧/别人/马上/快乐/滚烫/莫大
   全被判祈使，导致句式分布与六维基线失真。修后误判归零，请坐/快睡吧/别走/站住 仍正确。
3. **情感曲线尾部伪造全零段**（analysis.js）：25 段文本 20 分段时出现 7 个 intensity=0 的
   "假平缓段"。修后 0 个。
4. **novel_settings 列表永远显示人物卡**（index.js）：按 category 取对应表。
5. **brief 报告输出"推荐容差 undefined%"并谎报 μ=0**（index.js）：空基线时走"测量不可用"分支。
6. **findChapter 子串回退读错章**（index.js）：findChapter("1") 不再命中第 10/11/12 章。
7. **章节号解析**（index.js）：书名-01 / 书名 07 / 第一千零一章 均可解析（1 / 7 / 1001）。
8. **嵌入降采样维度与落盘声明脱钩**（embedding.js）：非 512 维输入落盘后缓存被判损坏、
   每次全量重建。修后任意输入归一到 128 维且回读正常；落盘改用 MODEL_NAME / EMBED_DIM 常量。
9. **组合情感标签 3/7 永不命中**（analysis.js）：键序统一后"又爱又恨/哀怒交加/惊喜交加"可达。
10. **String.replace 替换串未转义**（index.js）：设定/钩子文本含 $& 时旧段被复制，改为函数式替换。
11. **baseline: null 违反输出 schema**（index.js）：改为空对象，避免宿主拒绝整次调用。
12. **数字口径两两配对**（index.js）：归一化后只对"同值不同写法"生成候选，并限 20 条。
13. **-0 触发宿主 lossless JSON 拒绝**（index.js / analysis.js）：输出统一过 cleanOutput、
    round() 归一化负零，工具不再"首次失败、重试成功"。
14. **浏览器端 rev 竞态**（client.js）：update-check 后台写入不再参与竞态计数，
    已关闭的开关不再被显示为"全部开启"。

### 三、统计口径（节选）

- 效价词表嵌套双计（悲痛欲绝 negWords 2 → 1）；隐性载体跨表/表内重叠双计（细雨 0.6 → 1）。
- implicit 单位混用（加权和与次数相加）：ambiguousRatio 0.27 → 0.13，另存 weightedTotal。
- topWords 未做否定过滤（害怕 count 2 → 1）。
- chapterDrift 改按章计算（meanEntropy 0 → 0.347，swinging 正确为 true；单章回退段级并标 basis）。
- 句长双口径对齐（10/24/40）；top 参数钳制（-1/0 → 返回最高频 1 条）。
- 截断采样口径统一（intensity 18.18 → 181.82，与单独分析一致）。
- "不太高兴"极性修正（joy 0.6 → 0）；弱副词不再覆盖强副词。
- 烛火 fragile 生效；"震惊"原型补映射（契约告警消失）。
- 单字词条（谜/抚）参与计分；容差 0/null 语义区分；留白指数量纲校准（112.5 → 93.75）。
- DUTIR 兜底由"仅二字组"改为 2–4 字最长优先 + 区间消费（3–4 字词命中 9/40 → 39/40，二字词无退化）。

### 四、死代码与无效代码

- 删除零调用函数：embedding.js 的 loadIndex / reset，analysis.js 的 matchAmbiguousCarriers /
  dutirEmotionOf；删除 semResolver 死分支、global 恒真分支、恒真/恒假条件多处。
- 删除未使用导入（writeFileSync / sep / statSync）、未使用变量（effective / now / ch）、
  未使用 catch 绑定、重复 engine 字面量、多余导出（embedding 导出精简为 13 个）。
- 修复 DUTIR 63% 词条不可达、单字词死词条、3 条不可达标签、无效兜底、恒真守卫等"看着没问题
  实则无效"的代码。

### 五、性能

- 词表扫描改单遍位图：4 万字 32.7ms → 4.3ms（7.6×，等价性 54 组 0 差异）。
- 语义结果命中路径回写缓存：第三次命中 934ms → 1ms。
- 六维测量缓存改为章序无关：style_report / style_check / new_chapter 互相命中。
- plot scan 预计算 plotKeywords；大纲模式不再全书读两遍；enabled=false 提前返回（300 章 26ms → 2ms）。
- GET /state 改异步遍历；densityOf 正则提升到模块级（127ms → 45ms）；原型向量缓存（544ms → 1ms）；
  嵌入张量改 subarray（8.24ms → 0.03ms）；失败负缓存（更新检查不再重复打 GitHub）。

### 六、浏览器端（client.js）

侧边栏入口挂载守卫与插入锚点、refresh 竞态、保存回写守卫、宿主错误信息透传、
saveFailed 清理、删除按钮条件、容差提示文案、工具计数与列表同源、useEffect 依赖、
observer 生命周期、createRoot 泄漏、setTimeout 清理等 33 处。

### 七、测试与发布流程

- 测试断言真实化：unit 14 → 20 条并落退出码；pattern 相似度检查真正生效；client 真正挂载 DOM；
  e2e 补 required/调用点断言、schema 校验器补 5 类宿主规则、状态隔离防回归、import apply 写盘路径、
  enabled=false 双行为、插件运行期告警即失败。
- release.yml：打包排除 node_modules（发布包体积 47MB → 约 17MB）；push（所有分支）与 PR 均跑测试，
  发布 job 用 needs: test 卡住；删除过时排除项。
- SKILL.md / prompts.js 补正"总开关 enabled=false"的准确语义（analysis 返回禁用桩、style_check 抛错）。

### 八、追加修复（第二轮，同日）

1. **题材联动门控补全**（vibe.js）：原门控只对噩梦轴生效，且用"累计归一化分"判定——通用信号
   （疑问句、雨、哈哈等）也会让 6 个轴白拿题材加成；另一侧有实词证据时反而漏给。现改为
   push 增 isEvidence 标记 + AXIS_EVIDENCE_WORDS 内容证据词表 + evidenceBase 门控。
   实测：纯标签 6/6 不联动；通用信号修前 6/6 白给 → 修后 0/6；有正文实词 6/6 联动；
   单提 1 词不触发、2 词起生效；各轴分数与修前逐位一致、无 NaN。
2. **情感词"套娃"重复计数**（analysis.js）：emotionOf 主词表改"最长匹配 + 区间消费"。
   实测：悲痛欲绝 sorrow 2 → 1、咬牙切齿 anger 2 → 1、特别悲痛欲绝 3 → 1.5；
   高兴/不太高兴/别害怕/副词强弱/否定/DUTIR 全部无回归。
3. **风格报告语义结果写回缓存 + 锚包全书等距抽样**（index.js）：
   - 语义隐性情感与歧义裁决结果写入分析缓存（含全书内容指纹），命中即复用。
     实测：第 1 次 4834ms → 第 2 次 6ms（约 805×），缓存文件含 semanticImplicit / semanticFp / implicitResolved。
   - 锚段与句式骨架改为全书等距抽样（旧版从开头顺序取）。实测 30 章书：锚段来源章 [1, 28, 14]，
     覆盖首章与中后段；条数契约（对话 2 / 心理 1 / 描写 2、骨架 4）不变。
4. **段落结构补"叙述"桶**（analysis.js + index.js）：新增 paragraphs.narrationOnly，
   使 dialogueOnly + psychologyOnly + mixed + narrationOnly === total 恒成立；
   output schema 同步新增该字段（严格模式），渲染改为"段落结构: 共 N 段（对话 X / 心理 Y / 混合 Z / 叙述 W）"。
   实测 61 段：60 混合 + 1 叙述 = 61。
5. **rawWriting 默认值三方不一致**（index.js）：featureEnabled() 对缺键一律返回 true，
   与 FEATURE_DEFAULTS.rawWriting = false 矛盾，导致 novel_sentence_config 工具在用户从未开启时
   谎报 rawWriting: true（UI 与提示词注入门控都按 false 处理）。实测：空状态由 true → false；
   显式开启 → true 且提示段注入 150 字符；再关闭 → false 且不注入；其余默认仍为 true。

### 九、新增功能：系统提示词三档开关（关闭 / 精简 / 完整）

侧边栏首页新增一个三档分段按钮，控制插件往系统提示词里注入多少内容（沿用 DSH 官方"动态 section"写法，
参照 yexi-by/dsh-unrestricted 与 masknull/dsh-session-prompt）：

| 档位 | 注入内容 | 实测长度 |
|---|---|---|
| 关闭 | 完全不注入（返回空串，DSH 自动丢弃该段） | 0 字符 |
| 精简（默认） | 一句话：有 novel_* 工具、详情见 novel-writing 技能 | 134 字符 |
| 完整 | 原 v3.9.5 的完整工作流说明（行为不变） | 2437 字符 |

- 档位保存在插件 state 文件（与其它开关同一份），GET/POST /api/dsh-novel-writer/state 读写；
  非法值一律忽略并回退"精简"；无 state 文件时默认"精简"。
- 组装提示词时实时读取，**改完下一轮对话即生效**，无需重启。
- 与"总开关 enabled"互不干扰：总开关管工具与句式分析，本开关只管系统提示词注入量。

### 十、行为变更与升级注意

1. **统计口径变更会导致旧缓存失效**：analysis 报告、风格画像、语义索引会在升级后首次调用时重建
   （语义索引因 chunkText 分块修正必然重建一次）。旧缓存文件不会被自动删除，只失效。
2. 插件版本号由 3.9.5 → 4.0.0，缓存键随之更新（PLUGIN_VERSION 取自 package.json）。
3. 发布包不再包含 node_modules（依赖按 README 说明自动安装）。
4. 题材联动、情感计数、段落结构三项的口径变化会让同一本书的新旧报告数值不完全可比，
   建议升级后重新生成一次基线。
5. **系统提示词默认档位为"精简"**：升级后每轮上下文里只多一行字（134 字符），不再是原来的 2437 字符；
   需要完整工作流说明的人，请在侧边栏首页把开关切到"完整"。

### 十一、已知限制（保留）

- 题材证据词表（AXIS_EVIDENCE_WORDS）为启发式，可能漏词或误命中，扩展只需改该表。
- 语义缓存的指纹不含模型/引擎版本；跨进程同时写同一本书的分析缓存时后写覆盖（原子 rename 不损坏）。
- 锚包按段落下标均匀抽样，长章节权重略高；骨架分类规则未动。
- narrationOnly 取"余项"口径（若坚持"仅全陈述句段"会破坏四类合计恒等式）。
- 引号内弱心理标记（明白/觉得）会把整句归为心理；isImperative 每句重建正则（微秒级）。

### 十二、验证结果

- 四套测试：unit 20/0（exit 0）、pattern ALL PASSED（exit 0）、client CLIENT OK（exit 0）、
  e2e ALL E2E TESTS PASSED（exit 0）。
- AST 全量静态扫描：0 语法错误、0 未定义引用；死代码项 44 → 22（剩余为跨文件使用的导出）。
- 针对性探针：原 13 项回归全过 + 追加 4 项前后对比全过（门控矩阵 6/6、嵌套双计 2→1、
  缓存 805×、锚段覆盖首章与中后段、narrationOnly 恒等式成立）。
- 系统提示词三档开关：实测 off=0 字符 / brief=134 / full=2437（与旧版逐字节一致）；
  GET 与 POST /state 读写正常，非法值被忽略；切换后 section 立即生效；client-test 真实挂载面板通过。
- 改动范围：16 个文件（lib 10 + 测试 4 + release.yml + SKILL.md + package.json + cordis.patch.yml）
  + 新增 CHANGELOG.md；node_modules 未改动；文件总数与 v3.9.5 一致（1234 + CHANGELOG）。

### 十三、审计与修复报告索引

F:\doment\_audit\ 下 11 份审计报告 + 7 份修复报告：
analysis-1/2.md、embedding.md、index-1/2/3/4.md、client-1/2.md、cross.md、tests.md、
fix-A-analysis.md、fix-B-index.md、fix-C-embedding.md、fix-D-client.md、fix-E-tests.md、
fix-P-A.md、fix-P-B.md。
