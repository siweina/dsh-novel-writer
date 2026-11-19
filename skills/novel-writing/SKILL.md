---
name: novel-writing
description: 中文网文写作助手（dsh-novel-writer）：章节读写、开写包取材料、六维风格基线与自检、改稿台、伏笔/设定/必用词表与本地语义检索。用户处理中文小说续写、改稿、文风分析或设定管理时使用。
whenToUse: 用户提到小说、网文、章节、续写、改稿、文风、句式分析、伏笔、设定表、人物卡、大纲、必用词表或用词审计时
---

# 小说写作助手 (novel-writing)

## 目录与数据约定

- **小说正文**：`novels/<书名>/`（每章一个 `.md`，如 `第01章.md`）；优先用 `novel_books` / `novel_chapters` / `novel_read` 浏览阅读，批量导入用 `novel_import`；分析与续写均用中文。
- **创作资料**：`novels/创作资料/<书名>/`（`创作设定.md`、`主要人物设定.md`、`次要人物设定.md`、`剧情大纲.md`、`钩子记录.md`、`创作状态卡.md`）；以 `创作设定.md`【用户原创设定】与 `主要人物设定.md`【用户角色设定】为准；大纲只定方向、不预写钩子，按字数分批推进。
- **插件数据**：`<书库根>/.novel-writer/`（伏笔、设定、双层词表、缓存、改稿计划、草稿镜像 `drafts/`、回收站 `trash/`）。

## 核心创作原则

- **自然表达优先**：读起来自然 > 指标好看，不为凑数字强改。
- **基线与量化仅作诊断**：六维基线（`baseline`）与情感量化（撕裂度、趋势、矛盾指数、隐性意象等）仅作诊断与写后复核信号，**绝不**当成机械写作指令或公式。
- **锚段校准语感、不套模板**：原著锚段（`anchors`）只用来找语感，不照句式骨架（`skeletons`）或动作链例句造句。
- **克制局部微调**：单维轻微出带（1.5σ 容差内常见）属正常波动；仅当明显失真、某维偏离 ≥2 倍容差或读着别扭时才局部修正，**绝不整章重写**。
- **只给方向不代写**：诊断与改稿台只给定位和方向，正文创作与改写由宿主模型完成。

## 一章标准闭环

1. **开写取材料**：先调 `novel_chapter_brief`（只读不写盘，一次取齐上章结尾 `anchor`、上章钩子、大纲方向、人物、未回收伏笔及 `distance`、世界观规范、必用词 `lexicon`、六维基线、锚段/骨架、`avoid` 禁用清单等；缺项在 `degraded` 说明而不抛错）。仅 `degraded` 缺关键项时，再用 `novel_read` / `novel_summary` / `novel_outline` / `novel_plot` / `novel_semantic_search` / `novel_keywords` 补读。
2. **计划与成章**：可简述「上章结尾 → 本章目标 → 剧情计划」；用 `novel_new_chapter` 建章（可传 `plan` 记录各事件子句的具象执行计划用于写后核对，该字段不写进正文）。开启实时聊天写作时改用 `novel_draft` 分段提交。
3. **按需自检改稿**：写完按需跑 `novel_style_check` 看相似度与六维对照；需要可执行待办或契约对账时跑 `novel_fix_plan`；按需跑 `novel_lexicon`（`audit`）与 `novel_continuity_check`。仅达判据时局部修改。
4. **按需收尾**：有新埋伏笔或重要新角色才调 `novel_plot add` / `novel_outline character`；`novel_outline hook` / `status` 与 `novel_summary add`（200–500 字摘要）可等章节稳定后批量回填。长书省 token 可开 `leanWorkflow`（优先于 `systemPromptMode` 与 `promptScene`，未传 `brief` 时报告默认精简）。

## 关键工具边界与特殊语义速查

- **`novel_fix_plan`（改稿台与严格对账）**：
  - `plan`（默认）：输出按严重度降序的段落级待办（`hint` 只给方向不代写；正常文本返回空列表，全章级 `lineStart=lineEnd=0`）。
  - `verify`：复测正文返回 `resolved` / `pending` / `new`（须同 `type` 且同稳定 `issueIdentity`）；`mark` 标记 `done` / `skip`（重跑保留）。
  - 严格对账：`audit`（只跑可机器判定的 8 条契约，附 1-based 行号与片段或 `line:0`，未跑写 `ran:false` + 原因，不评文笔）、`audit_brief`（生成无上下文审计任务书与带行号正文，不发网络请求）、`audit_verify`（校验 `claims` 原文连续子串存在性并给 `score`，不裁决是否违约）。
- **`novel_settings` vs `novel_lexicon` vs `novel_continuity_check`**：
  - `novel_settings`（`category="worldview"`）：管理本书禁词（`bannedWords`）、替代词（`recommended`）与语用规范（`speechStyle`：`title`、`honorBad`、`ritualBadPatterns`、`tone`）；可先 `detect` 文化基准，完全依本书自身设定执行，不套固定模板。
  - `novel_lexicon`（书级覆盖 `_global`）：管理必用专名/惯用词（含 `avoid` 通用替身词与 `aliases`）；`lexiconFirst` 开启且非空时由 `novel_chapter_brief` 注入。**`audit` 只审必用词覆盖率与替身词命中，不扫世界观禁词**。
  - `novel_continuity_check`：扫禁词命中、语用冲突（客套/仪式/称谓）、四路衔接（时间硬跳/语义距离/人物延续/钩子承接）、OOC 与大纲走偏（传 `chapter` 审单章，不传审全书/设定）。
- **`novel_plot` 与 `novel_outline` / `novel_summary`**：
  - `novel_plot` 含只读跨章结构视图 `action="graph"`：汇总未回收伏笔距离（`plotLifecycle`）、人物矩阵与连续缺席 ≥5 章提醒（`characterMatrix.absences`）、线索活跃度（`threadActivity`）、时间线顺序（`timelineOrder`）及大纲重合率（`planVsActual`）。
  - `novel_outline` 管设定、人物、批次大纲、钩子与状态卡；`novel_summary` 管单章摘要，长书先看摘要再按需细读。
- **`novel_sentence_analysis` & `novel_style_report`**：
  - 问「怎么写」用 `novel_sentence_analysis`，问「什么风格」用 `novel_style_report`（可存 `aiJudgment`），问「写得像不像」用 `novel_style_check`，三者共引擎缓存（`fresh=true` 重算）；长书传 `brief=true` 取摘要。基线与情感量化只作诊断参照。
  - **`caveat` 复核**：`novel_sentence_analysis` 返回非空 `caveat`（`confidence=low`）时，必须按 `aiAction` 用 `novel_read` 抽读 2–3 段原文核实真实基调，不得直信 `dominant`。
  - **`enabled=false` 差异**：`novel_sentence_analysis` 返回禁用桩（`enabled:false`、`totalChars:0` 等）；`novel_style_check` 直接抛错拒绝。应提示先开总开关（侧边栏或 `novel_sentence_config`），勿反复调用或绕过。
- **`novel_draft`（`features.chatWriting`）**：
  - 默认关闭；仅动作 `commit`，只向 `.novel-writer/drafts/<书>/<章键>__draft.md` 追加段落（与 `novels/<书>/` 物理隔离）。
  - AI **不读、不改、不清**草稿镜像，且**不由 AI 决定何时提问**：须按程序字数阈值返回的 `nextAction`（`continue` 继续写 / `ask_user` 才提问）执行；定稿由 `novel_new_chapter` 收口标记。
- **`rawWriting`（非净化模式）**：
  - 经用户明确要求并双重确认开启后生效；**只改「怎么写」，不改「写什么」**。同视角同时间线按 `rawMode` 目标带直接写出场面，不用省略号、跳场或事后概括，不插免责；写后用 `novel_style_check` 核对 `explicitness`，偏软才补写。
- **`novel_delete_book` 与 `novel_diagnose`**：
  - `novel_delete_book` 仅在用户明确要求删书/清数据时使用，**必须先 `preview` 说明范围、体积与保留项，经确认再 `apply`**（可用 `keys` 局部清理）。默认移入 `.novel-writer/trash/`（`restore` 移回不覆盖，仅 `purge` 彻底删除），不动 `_global` 与其他书。
  - `novel_diagnose` 读本地日志与目录状态输出排查报告（`report` / `events` / `clear`）；采用**分享层脱敏口径**（仅含元数据，绝不含正文）。
