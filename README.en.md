# 📚 dsh-novel-writer — an on-device writing workstation for novel writers

English | [中文](./README.md)

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![npm downloads](https://img.shields.io/npm/dm/dsh-novel-writer.svg?style=flat-square&color=green)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.3-339933.svg?style=flat-square)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.1.1--rc.2-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)
[![siweina/dsh-novel-writer MCP server](https://glama.ai/mcp/servers/siweina/dsh-novel-writer/badges/score.svg)](https://glama.ai/mcp/servers/siweina/dsh-novel-writer)

**18 tools covering the whole loop: gather inputs before you write → quantify & self-check → work a prioritised fix list → audit the cross-chapter structure.**
One call before writing gathers **16 inputs** (missing one is how style drift starts); after you write, you don't just get numbers — you get a **priority-ordered to-do list** (line-anchored original text, current vs. target values, reference passages, **direction only, never ghost-written prose**); across chapters you can finally see "the thread snapped, a character vanished, a hook was forgotten".
Sentence, emotion and semantic analysis all run **on your machine**: a 24MB Chinese model ships with the package,
**zero API cost, your manuscript never leaves the device**. Built for DeepSeek Harness (DSH); the same engine is also
exposed as a **stdio MCP server** for Claude Desktop / Cursor.

[Install](#install) · [The writing loop](#the-writing-loop-end-to-end) · [60-second start](#60-second-start) · [See the output](#see-the-output) · [The 18 tools](#provided-tools-18) · [MCP server](#mcp-server-usable-outside-dsh)

---

## The writing loop (end to end)

| Step | What you say | Tool | What you get |
|---|---|---|---|
| ① **Gather** | "gather material for the next chapter" | `novel_chapter_brief` | **One call, 16 inputs**: previous chapter's closing text (hand-off) / its hook / this chapter's outline direction / relevant character cards / open plot threads with **how long they've been open** / worldview wording rules + banned words / six-metric baseline / reference passages & sentence skeletons / previous chapter's self-check / avoid-list / writing checklist — anything missing is reported in `degraded` with the reason and the fix |
| ② **Write** | "write chapter N" | `novel_new_chapter` · `write` | The new chapter file (with the baseline μ attached and the reference pack); write by the anchors' flavour, use the numbers only to verify afterwards |
| ③ **Self-check** | "check chapter N" | `novel_style_check` · `novel_sentence_analysis` | Similarity + deviation list + six-metric comparison (in band ✓ / out of band ⚠) + reference passages for the drifting dimensions (fix sentence by sentence, never rewrite the whole chapter) |
| ④ **Revise** | "turn chapter N into a fix list" | `novel_fix_plan` | A to-do list sorted by severity → effort → line: line-anchored original text, current/target values, anchors, rewrite direction; then `verify` re-checks three states (resolved / still there / new) and `mark` records your disposition |
| ⑤ **Audit** | "show me the book's structure" | `novel_plot { action: "graph" }` | Plot-thread spans / consecutive character absences / largest thread gap / timeline order / outline-vs-body drift |

> **Everything local, read-only by default**: the brief and the structure view **write no files at all**; the fix desk writes only its own list file, **never touches your prose and never writes prose for you**; semantic search and emotion analysis cost zero tokens.

## What problem does it solve

| Your pain | What you get here |
|---|---|
| "This passage I just wrote doesn't sound like me" | **Six-metric style baseline**: μ±σ of the original measured per chapter across syntactic complexity / modifier density / abstraction / action density / hedging / gap index; a new chapter is compared dimension by dimension and flagged ⚠ when out of band |
| "The AI says my style changed but can't say where" | **Style check**: similarity score + a deviation list (which sentence types increased, how far sentence length drifted, whether the dominant emotion changed) |
| "I have to poke six or seven tools before writing, and I still miss one" | **Chapter brief**: 16 inputs in one call; whatever can't be found is explained in `degraded` — **missing an input is the number one source of style drift and setting contradictions** |
| "I can see the chapter has problems but not which one to fix first" | **Fix plan**: to-dos sorted by severity → effort → line, each with line-anchored text, current vs. target values, a reference passage and a rewrite direction; re-checkable in three states after editing |
| "A thread snapped, a character vanished, a hook was forgotten — and it only shows up 50 chapters later" | **Structure view**: cross-chapter plot-thread spans, consecutive character-absence intervals, largest thread gap, timeline order, and outline-vs-body overlap |
| "Analysing a novel means paying for API calls" | Semantic search and emotion analysis run **fully local** — zero token cost |
| "I planted a plot thread and forgot to pay it off" | **Plot registry**: add / list / scan / done, automatically recording which chapters mention each thread |
| "Character settings contradict each other" | **Five settings tables + continuity audit** (bridge / OOC / outline drift) |
| "I can't read the report" | Everything is **tabulated numbers + quoted anchors from your own text** — screenshot-ready |

## Install

**Option 1: npm (recommended)**

```sh
dsh plugin --profile web add dsh-novel-writer
```

**Option 2: From GitHub**

```sh
dsh plugin --profile web add github:siweina/dsh-novel-writer#main
```

**Option 3: MCP (no DSH required)** — see [MCP server](#mcp-server-usable-outside-dsh)

Requires **Node >= 22.3**. After installing, **restart the web app**; a 「写作助手功能」 ("Writing Assistant") panel
appears in the sidebar.

## 60-second start

```sh
mkdir -p novels/my-novel     # put chapter files inside (第01章.md, 第02章.md, …)
```

Then ask, in order (this is one complete chapter):

1. **"gather material for the next chapter"** → `novel_chapter_brief` returns all 16 inputs in one call (it does the work of 6–8 tools, and **cannot miss one**)
2. **"write chapter 7"** → write by the returned anchors and skeletons; `novel_new_chapter` attaches the baseline μ
3. **"check chapter 7"** → `novel_style_check` returns similarity, a deviation list and the six-metric comparison
4. **"turn chapter 7 into a fix list"** → `novel_fix_plan` returns the prioritised to-dos; run `verify` afterwards to re-check the three states

To just look at the baseline first, ask **"run novel_style_report on my novel"** and you get:

```text
全书 1329 字：六维基线 μ=句法复杂度:2.3 修饰密度:35.6 抽象度:0.5 动作密度:101.7 不确定性:2.1 留白指数:7.0
推荐容差 25%/35%/100%…
```

(Report text is currently Chinese-only — see the note for non-Chinese users below.)

## See the output

**Chapter brief** (`novel_chapter_brief`, one call before writing):

```text
目标：第 8 章《（无标题）》（尚未创建，文件名推导为 第08章.md）

【上一章结尾原文·承接口】…（previous chapter's last 300 / 600 chars, per budget）
【待回收伏笔】
  - [mu5kjla…] 琥珀色齿轮怀表的来历与停摆的指针（high｜第 1 章埋下，已过 6 章）
【相关人物】- 林昭：守码头的女人，父亲失踪后回到旧宅
【世界观用语】欧式中世纪沿海城邦；点烛不烧香｜禁用：上香、烧香、时辰、老夫
【风格基线】complexity μ=2.42  modifierDensity μ=22.2  abstractDensity μ=10.06 …
【原著锚段·照这个味道写】[对话] …  [心理] …
【上一章自检】第 7 章六维对照：全部维度在容差带内 ✓
【本章禁用清单】- 禁词：上香（建议改用：点烛）
【开写清单】□ 先读锚段再动笔　□ 承接上一章结尾　□ …（共 8 步）
【降级/提示】- 钩子记录里没有第 7 章的钩子（上一章钩子未回填）
```

**Fix plan** (`novel_fix_plan`, diagnostics turned into an ordered to-do list):

```text
改稿台：共 13 项待办（严重度降序 → 难度升序）。抽象度过高 ×3、衔接缺失 ×1、禁用词 ×3、语用不符 ×5、句式偏离 ×1。
备注：留白指数 虽出带但差值 8.36 < 门槛 12，已按「无量级差异」忽略 ← the absolute-magnitude gate: no false positives

  - [抽象度过高] 严重度 5 / 难度 2（第 5 行）
      id：fix-abstract-5-c2c156d4
      现状：abstractDensity 47.9　目标：0.55~6.95
      原句：林昭大概说不清那种感觉。她隐隐觉得…
      方向：抽象度偏离：全章 47.9（基线 3.75，偏差 +1177.3%），本段 74.38。这句抽象词过密，改成具体动作或物件。
      锚段：林昭把它捏在掌心，翻过来看背面。背面刻着一行小字，被磨得只剩半边。她认出了父亲的名字。
```

**Style check** (new chapter vs. book baseline):

```text
相似度 0.946 · verdict: high
偏差清单：心理占比略多 · 对话占比略少 · 短句占比略少 · 主导情绪由 anger 变为 joy
fixAnchors：3 条原著锚段（对话 / 心理 / 描写各一条，供逐句对照修正）
```

**Semantic search** (natural language, local vectors):

```text
查询「与那盏没有点的灯有关的段落」→
  第02章.md  0.619  对街那盏灯，亮了。
  第01章.md  0.593  阿澈的目光越过老周的肩膀，落在对街那栋小楼上…
```

**Paragraph structure**: 34 paragraphs total (dialogue 5 / psychology 0 / mixed 15 / narration 14)

## Why not an online AI writing tool

| | This plugin | Online AI writing tools | Generic text-analysis libraries |
|---|---|---|---|
| Does the manuscript leave the device | **No** | Yes | Depends |
| Cost | **0 (local inference)** | Billed per token | Self-hosted |
| Purpose-built for Chinese fiction | **Yes** | Generic | No |
| Style baseline (μ±σ) | **Yes** | Rare | No |
| DSH integration | **18 tools + sidebar toggles** | None | None |
| Usable without DSH | **Yes (MCP)** | Yes | You wrap it yourself |

> **A note for non-Chinese users**: this plugin is designed for analysing and writing Chinese fiction — the sentence-pattern,
> emotion and imagery engines, and the bundled semantic model, are all built and tuned for Chinese corpora, and the report
> text itself is Chinese. Covering English and other languages *while* going deep on Chinese is genuinely beyond my current
> ability. I'm sorry for the inconvenience and hope you understand.

---

## Features

1. **The writing-desk trio**: `novel_chapter_brief` (**chapter brief**) — **one call** before you start writing gathers every input (previous-chapter hand-off / chapter direction / relevant characters / open plot threads / wording rules / style baseline / anchors & skeletons / avoid-list / checklist; two `budget` modes: compact / full); anything unavailable lands in `degraded` with the reason; read-only, writes nothing. `novel_fix_plan` (**fix plan**) — turns style diagnostics into a priority-ordered to-do list (line-anchored original text + current vs. target values + reference passages + rewrite direction) with `plan` / `verify` / `mark` and a three-state re-check, **direction only, never generates prose**. `novel_plot { action: "graph" }` (**structure view**) — plot-thread spans / consecutive character absences / thread gaps / timeline order / outline-vs-body overlap. Plus **scene-scoped prompts** (general / writing / revising / auditing / setup; `general` is the old behaviour).
2. **Style portrait report** (`novel_style_report`): 6-dimension measurement — style fingerprint / high-frequency lexicon / genre-theme / emotion quantification / 12-axis vibe spectrum / semantic style distance. **Measurement-judgment separation**: the plugin only reports numbers, never labels; AI judgment can be saved back to `.novel-writer/style-reports/` for consistent continuation writing.
3. **12-axis vibe spectrum**: nightmare / angst / heartwarming / fluff / tearjerker / dark / mystery / blaze / absurd / lonesome / aesthetic / sensual — with traceable evidence, 0 token.
4. **Local semantic engine**: bge-small-zh Chinese model (24MB, shipped with the plugin) local CPU inference — `novel_semantic_search` finds semantically related passages with natural language (with chapter location), semantic style comparison, semantic implicit emotion; lazy loading + graceful fallback.
5. **Sentence-pattern analysis**: 9 categories, arrangement patterns, rhythm, emotion curve, style fingerprint + guidance, with cache & report export.
6. **Emotion purification & quantification**: strong/weak emotion-word grading, pollution detection, caveat warning + AI re-verification; Valence sliding window → variance V / delta Δ / conflict index C + implicit imagery carriers.
7. **Worldview & pragmatics detection**: auto cultural-baseline detection with confidence; speechStyle title/honorifics/rituals/tone norms; genre & theme + webnovel signals.
8. **Writing toolkit**: plot tracking / five settings tables (characters·locations·items·timeline·worldview) / chapter summaries / continuity audit / batch import / style check / continuation writing.
9. **Per-tool UI toggles**: 「写作助手功能」 ("Writing Assistant") sidebar panel (master + grouped tool toggles + feature toggles), plain-language labels, data-dir usage & semantic-engine status display.
10. **Style Baseline**: Six writing metrics (syntactic complexity / modifier density / abstraction / action density / hedging / gap index) + per-chapter μ±σ baseline band; `novel_style_report` outputs the band, `novel_style_check` compares new chapters (in-band ✓ / out-of-band ⚠); per-metric ±% tolerance configurable in the sidebar (**recommended = 1.5× σ of the book's chapter variance**, rounded, clamped to ±10%~100%; leave blank to use recommended) — free theme, writing style kept inside the band.
11. **Writing sentinels**: `novel_continuity_check` extended — ①**bridge check** (`chapter`: time jumps / semantic distance / character continuity / hook handoff, with quoted evidence) ②**OOC check** (`ooc`: per-character emotion baseline deviation) ③**outline drift** (`outline`: direction vs body keyword overlap); **brief mode** for report tools.
12. **Original mode & creation files**: fill in creation settings in the sidebar (worldview/characters/forbidden/main conflict/genre/extras, blank = model decides, per-book profile library); novel_outline maintains creation files (bible/characters/outline/hooks/status), enforcing the bible → outline → hook chain with dynamic batches (10→20→30 chapters) to prevent plot jumps and OOC.
13. **Experience & stats**: main panel **library stats** (per-book chapters/total chars/7-day active chars, 🔥 green), **🎬 demo** (built-in sample, no files, runs the 6-dim baseline), **📊 report history** (analysis/style-reports browsing); actionable error hints; slimmer tool descriptions.

---

## Provided Tools (18)

| Tool | Description |
|------|-------------|
| `novel_books` | List all books in library |
| `novel_chapters` | List a book's chapters |
| `novel_read` | Read a chapter (paginated) |
| `novel_keywords` | Keywords: bigram/trigram/name candidates |
| `novel_new_chapter` | Create new chapter file |
| `novel_import` | Batch import manuscripts |
| `novel_sentence_analysis` | Sentence-pattern analysis |
| `novel_sentence_config` | View/set tool & feature toggles (incl. prompt scene) |
| `novel_style_check` | Style check (rule + semantic) |
| `novel_style_report` | **Style portrait report** (6-dim measurement) |
| `novel_plot` | Plot/foreshadowing tracker; `action: "graph"` structure view (plot-thread spans / consecutive character absences / thread gaps / timeline order / outline-vs-body overlap) |
| `novel_settings` | Settings management (+worldview) |
| `novel_summary` | Chapter summaries |
| `novel_continuity_check` | Continuity audit + **bridge/OOC/outline sentinels** |
| `novel_semantic_search` | Semantic search (local embedding, 0 token) |
| `novel_outline` | **Creation-file management** (bible/characters/outline/hooks/status) |
| `novel_chapter_brief` | **Chapter brief** — one call before writing gathers everything (previous-chapter hand-off / chapter direction / characters / open threads / wording rules / style baseline / anchors & skeletons / avoid-list / checklist) |
| `novel_fix_plan` | **Fix plan** — turns style diagnostics into a priority-ordered to-do list (line anchors + reference passages), re-checkable after edits; **direction only, never generates prose** |

---

## MCP server (usable outside DSH)

The package ships a **stdio MCP server** (`mcp/server.mjs`) that exposes all 18 tools to any MCP client,
e.g. Claude Desktop or Cursor. **It runs as a local process on your own machine — no server, no network, no daemon.**

```bash
npx -y -p dsh-novel-writer dsh-novel-writer-mcp --root /path/to/your/novels
```

Client config example (`claude_desktop_config.json` / Cursor `mcp.json`):

```json
{
  "mcpServers": {
    "dsh-novel-writer": {
      "command": "npx",
      "args": ["-y", "-p", "dsh-novel-writer", "dsh-novel-writer-mcp", "--root", "/path/to/your/novels"]
    }
  }
}
```

> The package name (`dsh-novel-writer`) and the bin name (`dsh-novel-writer-mcp`) differ, so `npx -y dsh-novel-writer`
> will **not** start the MCP server — always pass `-p dsh-novel-writer dsh-novel-writer-mcp`.

Library-root priority: `--root` > env `DSH_NOVEL_WRITER_ROOT` > current working directory.
`root` arguments must stay inside the configured root, and `novel_import`'s `src` is restricted to it as well unless you
start the server with `--allow-external-src`. Details: [mcp/README.md](./mcp/README.md).

---

## Configuration

```yaml
- id: novel-writer
  config:
    root: 'D:/my-novel-library'
    allowLanState: false   # true = allow state save from LAN GUI access
```

---

## Data Directory

Under `<library-root>/.novel-writer/`: `plots` / `settings` / `summaries` / `analysis` / `audits` (continuity audits + fix-plan lists) / `embedding` / `style-reports`.

---

## Dependencies, permissions and failure bounds

**Runtime dependencies** (installed by `npm install`; all public packages):

- `onnxruntime-web` ^1.24.3 — local ONNX inference (WASM backend) for semantic search and style distance;
- `@huggingface/tokenizers` ^0.1.0 — tokenization (WASM);
- peerDependency `react` ^18.2.0 — the browser half reuses the React shipped with the DSH Web GUI.

**Local model**: `lib/models/` ships the quantized bge-small-zh-v1.5 model (~24MB ONNX) and its tokenizer
(`tokenizer.json.gz`, decompressed on load). All inference runs on the local CPU; no text is uploaded.

**Permissions and external services**:

- Filesystem: reads/writes the user-chosen library root (`novels/`) and its data directory (`<root>/.novel-writer/`),
  plus the plugin state file (`~/.dsh/dsh-novel-writer/state.json`). **One exception**: `novel_import`'s `src` is by design
  allowed to point anywhere (that is how you import an old manuscript from elsewhere), and `mode:"apply"` + `move:true`
  **deletes the source files** — the scope of the deletion is decided by the caller, so only point it at a directory whose
  contents you know.
- Built-in skill: registers its own `novel-writing` skill through `ctx.skills` (since v4.3.0); it only reads the packaged
  `skills/novel-writing/SKILL.md`, **writes to no skill directory** and needs no host configuration; hosts without a `skills`
  service are skipped silently.
- Local HTTP: registers 5 routes inside the DSH Web GUI (state / reveal / reports / demo / update-check), loopback-only;
  `allowLanState` defaults to off, so LAN access is denied by default.
- MCP server (`mcp/server.mjs`): the `root` argument of every tool must fall inside the library root given to `--root`
  (out-of-root values are rejected and fall back); `novel_import`'s `src` is likewise root-limited unless you explicitly
  opt out with `--allow-external-src` (since v4.3.0).
- Network: the only outbound call is the GitHub Releases API (`api.github.com`) for update checks —
  3s timeout, 24h cache, silent fallback; no manuscript content is sent.
- Subprocesses: none, except opening the OS file manager with a plain argv array (no shell).
- Lifecycle scripts: none (no preinstall / postinstall / prepare).

**Failure bounds**: semantic engine failure falls back to pure rule mode; cache/disk failures never block
tool results; a plugin load failure cannot affect the DSH host process.

**Compatibility**: Node.js >= 22.3 (`engines.node`); DSH >= 0.1.1-rc.2 (`dsh.engines.dsh`).

---
## License

[MIT](./LICENSE)
