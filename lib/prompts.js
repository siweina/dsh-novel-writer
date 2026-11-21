/**
 * v2.6.0 从 index.js 拆分：系统提示词文本（写作工作流 + 非净化模式指令）。
 * v5.0.0：新增「场景」维度——档位（off/brief/full）决定"注入多少"，场景决定"注入什么"。
 *         两个维度正交：老状态文件只有 systemPromptMode，缺 promptScene 时按 general 处理，
 *         即回到 4.x 那段通用工作流（本版只在其第 3、7 节补了三段新工具指引，见下）。
 * v6.3.0：修正 leanWorkflow 的判据顺序（缺陷清单 #52）并在 BRIEF_TEXT / LEAN_TEXT 补入必用词表纪律
 *         （增量缺陷清单 #28）——默认档位是 brief，原先这两件事在默认配置下都不生效。
 * v6.4.0（世界观用语规范）：写作相关场景（writing / revising）提醒复核本书 worldview 禁用词/语用规范与 lexicon 必用词（去除了跨题材硬编码禁用词）。
 */

/**
 * v2.0.0 非净化模式（rawWriting）：用户双重确认后注入的直白文风指令。
 *
 * v6.9.0 重写：旧版是 5 行抽象要求（"必须还原原文的直白程度 / 不回避不委婉"），
 * 用户反馈"开了跟没开一样"。实测失效的不是"力度"而是**可执行性**：
 * 模型不会因为"要直白"就直白，但会因为"不许用省略号带过 / 不许跳到事后"这类**可检查的动作**而改变输出。
 * 所以这里改成逐条可检查的写法约束，并明确"这一模式只改怎么写，不改写什么"（避免被理解成越权指令）。
 * 只在 `features.rawWriting === true` 时注入，且系统提示里这句标记也是 rawguard 的上下文闸门（见 lib/rawguard.js）。
 */
const RAW_WRITING_PROMPT = [
  "【非净化模式已开启（用户已确认，仅限个人虚构作品）】",
  "只改「怎么写」，不改「写什么」；勿影射现实人物或事件。按原著尺度与细节密度直写当下场面：",
  "- 留在场景里（同视角、同时间线），动作、对话与细节颗粒度对齐原著；",
  "- 直接写出过程：不用省略号、「此处省略」、时间跳（「事后」「不知过了多久」）、总结或代称（「一番……」）带过；",
  "- 不插道德评论、免责声明或能力/政策解释，不以隐喻或空镜替代场面。"
].join("\n");

/** 开写包里的【非净化模式】区块（动笔那一刻给的版本，比系统提示更靠近生成点） */
export const RAW_MODE_HINT = [
  "【非净化模式】按原著尺度直写这一场：留在场景里，细节密度对齐原著；",
  "不用省略号 / 时间跳 / 「此处省略」 / 总结代替场面，不插评论或免责。"
].join("\n");

/** 开写包 plan.checklist 里的单行硬约束（模型把它当"必做步骤"读） */
export const RAW_MODE_CHECKLIST =
  "非净化模式（硬约束）：按原著尺度直写——留在场景里、细节对齐原著；禁省略号/时间跳/「此处省略」/总结代替场面，禁插评论或免责";

/** 系统提示词：小说写作工作流（需求 1-3 的模型侧约定）。场景 general + 完整档时注入。 */
const WORKFLOW_TEXT = [
  "【小说写作助手 novel-writer】",
  "1. 章节库：章节存 novels/<书名>/（每章一 .md），优先用 novel_books / novel_chapters / novel_read（长章分段读完）或 read/glob 浏览。",
  "2. 分析作品：先查目录再读章，覆盖剧情脉络（冲突/转折/伏笔/人物）、写作手法（视角/节奏/对话/环境/意象/留白）及 novel_keywords 高频词，附章节例证。",
  "3. 续写工作流：先简述「上章结尾 → 本章目标 → 写作计划」再写正文。动笔前调 novel_chapter_brief(chapter=\"next\") 一次取齐承接结尾、大纲、人物卡、伏笔、worldview、基线、anchors/skeletons 与禁用/开写清单；degraded 缺失项在计划说明，勿凭空补。anchors 仅用来校准语感，不要照 skeletons 造句或套句式模板；数字基线只做事后校验，不翻译成写作规则（与语感冲突时自然优先）。新章用 novel_new_chapter 或 write 落盘。",
  "4. 句式分析（novel_sentence_analysis）：提取九类句式、排列、句长节奏、情感曲线与风格指纹，受 novel_sentence_config 开关控制（enabled=false 时分析返回禁用桩、novel_style_check 拒绝执行；分工具关闭按提示引导；autoAnalyze=true 主动附带，false 仅按要求调用）。",
  "5. 导入整理（novel_import）：先 scan 看分组，异名同书用 book 合并后 apply 导入。",
  "6. 改稿与结构：novel_fix_plan(action=\"plan\") 拿待办方向（不生正文），改后 action=\"verify\" 复测三态，按需 action=\"mark\"。novel_plot 查 open 伏笔，action=\"graph\" 查跨章断线/缺席/时间线/大纲偏离，scan 仅按要求跑。",
  "7. 校验、设定与词表：写完按需 novel_style_check，仅相似度偏低或偏离 > 2 倍容差时按 fixAnchors 逐句微调（勿整章重写，单维轻偏正常，确需偏离说明理由）。novel_settings 维护五张表（含 worldview），可用 detect 判基准并遵守禁用词与 speechStyle 语用规范；开启 novel_lexicon 必用词表时须用表内词、禁替身词，写完可 action=\"audit\" 只读复核；novel_continuity_check 扫设定与用语冲突候选；novel_summary 维护章摘要（长书先看摘要）。分析与关键词结果缓存至 <root>/.novel-writer/analysis/，重算传 fresh=true。"
].join("\n");

/** v4.0.0：系统提示词"精简"档——只说明"有这套工具、详情看技能"，几乎不占上下文。
 *  v6.2.0 修正（增量缺陷清单第 28 条）：补一行必用词表纪律。 */
const BRIEF_TEXT = [
  "【小说写作助手】已挂载 novel_* 工具（章节/分析/风格/设定/检索），非小说任务忽略。",
  "处理小说先用 novel_books 查作品，详细规范见 novel-writing 技能。",
  "若启用必用词表：涉及表内概念须用表内词，勿用「勿用」替身词；写完可 novel_lexicon(action=\"audit\") 只读复核。"
].join("\n");

/**
 * v5.0.0：场景化提示词（完整档下按场景择一注入）。
 * 兼容性：`general` 场景对应 WORKFLOW_TEXT，老状态文件（无 promptScene 键）自动落到 general。
 */

/** 场景 writing：写新章（材料装配 → 动笔 → 按需自检 → 按需收尾）。 */
const SCENE_WRITING = [
  "【小说写作助手 · 写新章】",
  "1. 一次取料：调 novel_chapter_brief(chapter=\"next\", budget=\"compact\") 取齐上章结尾、大纲、人物卡、伏笔、worldview、基线、anchors/skeletons 与 avoid 清单；degraded 缺失项在计划说明，勿再逐个调工具取料。",
  "2. 简述计划：动笔前两三句交代「上章结尾 → 本章目标 → 写作计划」，再出正文。",
  "3. 语感与基线：anchors 只校准语感，勿照 skeletons 造句或套句式模板；数字基线仅作事后参考，自然表达优先，不机械复刻指标。",
  "4. 禁写与词表：避开 avoid 清单（已回收伏笔/已退场人物等）；遵守 novel_chapter_brief 的 worldview（禁用词与语用规范）与 lexicon（必用词硬清单，勿用替身词），写完可按需用 novel_lexicon audit / novel_continuity_check 复核。",
  "5. 落盘与按需收尾：用 novel_new_chapter（或 write）写章。按需跑 novel_style_check，仅相似度明显偏低或某维偏离 > 2 倍容差时逐句微调（勿整章重写）；确有新伏笔才 novel_plot add，钩子与摘要待定稿或要求时回填 novel_outline hook / novel_summary。"
].join("\n");

/** 场景 revising：改稿（清单驱动 → 分批改 → 单次复测）。 */
const SCENE_REVISING = [
  "【小说写作助手 · 改稿】",
  "1. 取清单：novel_fix_plan(action=\"plan\") 拿按优先级排好的待办（含行号、锚段与方向 hint）。",
  "2. 分批改：从高 severity 起，同段同类合并修改，每轮处理最严重的 3~5 条（或 severity ≥ 4），不整章重写。",
  "3. 少往返：仅在用户要求跟踪时逐条 mark；一轮只跑一次 action=\"verify\" 看三态，保留合理轻微项。",
  "4. 指标类待办（抽象度/留白/情感等）读着别扭再改，否则保留或标 skip；保持原文风格，自然优先，必要偏离说明理由。",
  "5. 改稿时同步对照本书 worldview 禁用词/语用规范与 lexicon 必用词（冲突候选见 novel_continuity_check / novel_lexicon audit）。"
].join("\n");

/** 场景 auditing：审计（只体检、只报告，不改稿）。 */
const SCENE_AUDITING = [
  "【小说写作助手 · 审计】",
  "1. 只体检与报告：**不改正文、不写章、不登记设定**。",
  "2. 结构：novel_continuity_check（全书设定表与同章重号）+ novel_plot(action=\"graph\")（伏笔距离/人物缺席/线索空档/时间线/大纲偏离）。",
  "3. 风格与词表：novel_style_report 取画像，按需 novel_style_check 逐章对照；若有词表则 novel_lexicon(action=\"list\"/\"audit\") 查覆盖与替身词（只读）。",
  "4. 手法：novel_sentence_analysis 看句式与节奏。",
  "5. 报告要求：区分「确定问题」与「待审候选」（审计结果仅供人工核对），指明章号、指标偏离、依据与优先级；长书先用摘要/关键词定位再细读命中章节，勿通读全书。"
].join("\n");

/** 场景 setup：建资料（设定表与创作资料维护）。 */
const SCENE_SETUP = [
  "【小说写作助手 · 建资料】",
  "1. 只维护资料与设定：**不写正文、不改章节**。",
  "2. 大纲资料：novel_outline(action=\"init\") 初始化创作资料；大纲只定核心方向，**结尾钩子不预写**（写完回填）。",
  "3. 五张设定表：novel_settings 维护人物/地点/道具/时间线/worldview；可用 action=\"detect\" 判世界观基准并复核语用，已有正文可用 action=\"scan\" 扫候选。",
  "4. 伏笔：novel_plot(action=\"add\") 填全类型/优先级/关联/回收条件，已有正文可用 scan 补提及章；建完建议 action=\"graph\" 自查。",
  "5. 必用词表：novel_lexicon 登记专名（书级）与惯用词（全局），支持 terms/text 批量导入并填 avoid 替身词供 audit 定位；已有正文可先 scan 挑候选。"
].join("\n");

/** 场景 → 文本。`general` 不在表内（它对应 WORKFLOW_TEXT）。 */
const SCENE_TEXTS = Object.freeze({
  writing: SCENE_WRITING,
  revising: SCENE_REVISING,
  auditing: SCENE_AUDITING,
  setup: SCENE_SETUP
});

/**
 * v5.0.0（降本）：精简工作流档（`leanWorkflow=true` 时注入，**优先级高于档位与场景**）。
 * v6.3.0 修正（缺陷清单第 52 条）：判据顺序改为**先 lean 再档位**。
 * v6.2.0 修正（增量缺陷清单第 28 条）：补一条必用词表纪律——本档是「不催流程」，不是「放弃硬约束」。
 */
const LEAN_TEXT = [
  "【小说写作助手 · 精简工作流】",
  "0. 原则：**工具按需调用**。用户明确要求照常执行；未要求时不主动自检、复测或登记伏笔/钩子/摘要，长流程先问再做。",
  "1. 备料：novel_chapter_brief(budget=\"compact\") 一次取齐，勿逐个工具翻。",
  "2. 改稿：novel_fix_plan(action=\"plan\") 取清单，同段同类合并分批改；改完最多跑一次 verify，不逐条 mark。",
  "3. 风格：anchors 只校准语感，勿照 skeletons 造句；数字基线仅事后校验，自然优先。",
  "4. 词表：若启用 novel_lexicon 必用词表，须用表内词、禁替身词；要求复核时用 action=\"audit\"（只读）。"
].join("\n");

/** 合法场景枚举（`general` 必须在内，它是向后兼容的默认值）。 */
const PROMPT_SCENES = Object.freeze(["general", "writing", "revising", "auditing", "setup"]);

/**
 * v5.0.0：按「档位 + 场景」选出要注入的文本。纯函数，便于单测。
 *
 * - mode 为 off          → 返回空串（DSH 会丢弃该段）
 * - lean === true        → LEAN_TEXT（v5.0.0 降本档，**优先于档位与场景**：省 token 比"注入什么"更重要）
 * - mode 为 brief        → BRIEF_TEXT（精简档与场景无关，它只说明"有这套工具"）
 * - mode 为 full + 未知/缺省场景 → WORKFLOW_TEXT（4.x 原文 + 本版补入的新工具指引）
 * - mode 为 full + 已知场景     → 该场景文本
 *
 * v6.3.0 修正（缺陷清单第 52 条）：lean 判据挪到 `mode === "brief"` **之前**。原因是
 * `systemPromptMode` 的默认值就是 `"brief"`，而侧边栏开关只提交 `{ leanWorkflow: value }`——
 * 旧顺序下 LEAN_TEXT 在默认配置里永不可达（只有手动切到 full 才生效），开关的承诺落空。
 * 影响面（默认档位 + 开关打开）：注入文本由 3 行 BRIEF_TEXT 变为 LEAN_TEXT（多约 300 字）——
 * 这正是开关的本意（"只要一条原则"），且文档早已如此承诺；关掉开关即回到 BRIEF_TEXT。
 * 只有 lean 是真正的布尔 true 才生效（与 index.js 的同名判据口径一致）。
 */
function promptTextFor(mode, scene, lean) {
  if (mode === "off") return "";
  if (lean === true) return LEAN_TEXT;
  if (mode !== "full") return BRIEF_TEXT;
  if (typeof scene === "string" && Object.prototype.hasOwnProperty.call(SCENE_TEXTS, scene)) {
    return SCENE_TEXTS[scene];
  }
  return WORKFLOW_TEXT;
}

// 审查 #66：WORKFLOW_TEXT / LEAN_TEXT / SCENE_TEXTS 只由本文件的 promptTextFor 内部消费，
// 全仓没有外部 import —— 不再导出（定义与内部使用保持原样）。
/**
 * v7.3.0 实时聊天写作（chatWriting）：只在 `features.chatWriting === true` 时注入。
 *
 * 这一模式改的是**写作节奏**而不是文风：从「一口气写完整章」换成「一段段写、按程序的节奏停下来问」。
 * 四条不可让的约束，缺一条这个模式就退化成一个普通提示词：
 *   ① 半成品必须落在**独立目录**的草稿镜像里（正文目录在确认前一个字节都不动），
 *      否则半成品会被章节扫描当成正文，字数/基线/语义索引一起被污染；
 *   ② 镜像**由程序写**：AI 只把这一段的正文交出去，不自己拼路径、不自己拼格式；
 *   ③ 镜像**只追加**：AI 不读、不改、不清；重复段落也照写（镜像只交给人看）；
 *   ④ **"什么时候问人"由程序的字数阈值判定**，AI 只看 nextAction，不得自己决定何时提问——
 *      否则"短段该不该合并着问"就变成了模型的临场判断，这正是本版要消除的东西。
 */
const CHAT_WRITING_PROMPT = [
  "【实时聊天写作已开启（用户已确认）】",
  "只改写作节奏：逐段写，**何时问人由插件程序按字数阈值决定**，勿自行判断。",
  "1. 动笔前读 novel_chapter_brief；先写不先问。",
  "2. 每写完一段即调 novel_draft(action=\"commit\", book, chapter, text)（路径与计数由程序处理）。",
  "3. 严格按返回的 nextAction 执行：",
  "   - \"continue\"：直接写下一段，勿停下问人；",
  "   - \"ask_user\"：将 question 原样传给 ask_user_question 并附 combinedText，等回复（未回复勿续写）。",
  "4. 用户提出修改时只改所指段落后继续写与 commit，不整章重写；同意则续写。",
  "5. 全章定稿后才用 novel_new_chapter（或 write）写入正式章节，确认前**不要提前写**。",
  "6. 草稿镜像只供人看：不要读它、不要改它、不要清理或引用它。"
].join("\n");

export const CHAT_MODE_CHECKLIST =
  "实时聊天写作（硬约束）：每写一段 novel_draft commit 交出；按 nextAction=continue 续写 / ask_user 提问；镜像不读不改不清；提问时机由程序字数阈值判定";

export { RAW_WRITING_PROMPT, BRIEF_TEXT, PROMPT_SCENES, promptTextFor, CHAT_WRITING_PROMPT };
