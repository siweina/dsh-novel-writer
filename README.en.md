# 📚 dsh-novel-writer — an on-device writing workstation for novel writers

English | [中文](./README.md)

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![npm downloads](https://img.shields.io/npm/dm/dsh-novel-writer.svg?style=flat-square&color=green)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg?style=flat-square)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.1.1--rc.2-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)
[![siweina/dsh-novel-writer MCP server](https://glama.ai/mcp/servers/siweina/dsh-novel-writer/badges/score.svg)](https://glama.ai/mcp/servers/siweina/dsh-novel-writer)

**22 on-device tools covering the whole fiction loop: gather context before writing → quantify & self-check → work a prioritised fix list → audit cross-chapter health → diagnose and clean up.**
Ships with a bundled 24 MB Chinese semantic model (`bge-small-zh-v1.5`, local WASM inference) — **zero API cost, manuscripts never leave the machine, measures & guides without ghostwriting**.
Built for **DeepSeek Harness (DSH)** (with a unified 4-tab sidebar & main-column UI); the engine also runs as a built-in **stdio MCP server** for Claude Desktop / Cursor, or launches the **standalone Web UI (`--ui`) / Antigravity Sidecar Aux Pane plugin** outside DSH.

[Website](https://siweina.github.io/dsh-novel-writer/) · [Technical docs (22 tools)](https://siweina.github.io/dsh-novel-writer/tools/) · [Core capabilities](#core-capabilities) · [Install & quick start](#install--quick-start) · [22 tools](#provided-tools-22) · [MCP server](#mcp-server-outside-dsh) · [Config & security bounds](#configuration-data-layout--security-bounds) · [Changelog](./CHANGELOG.md)

---

## Core Capabilities

- **Pre-writing context assembly (`novel_chapter_brief` & creation files)**: gathers 16 inputs in one read-only call — previous-chapter hand-off, hook, chapter outline direction, relevant character cards, open plot threads with chapter spans, worldview wording/banned-word rules, required lexicon, six-metric style baseline, reference passages, and writing checklist — reporting anything missing in `degraded`. Paired with `novel_outline`, five settings tables (`novel_settings`), and the book + global required lexicon (`novel_lexicon`).
- **Quantified style anti-drift (6-metric baseline & scene-band comparison)**: tracks syntactic complexity, modifier density, abstraction, action density, hedging, and gap index (`μ±σ`), alongside 9 sentence patterns, emotion quantification, and a 12-axis vibe spectrum. Supports **scene-band baseline comparison** (`dialogue` / `action` / `narrative` bands classified via quote ratio plus dedicated conflict/pacing signals decoupled from everyday verbs, comparing against same-band peers when ≥ 3 chapters exist and automatically falling back to the full baseline otherwise) plus per-book yardstick chapter selection so AI continuations cannot drag the baseline.
- **Prioritised revision (`novel_fix_plan` & strict reconciliation)**: converts diagnostics into to-dos sorted by severity → effort → line (capped at 12 by default), with line-anchored quotes, current vs. target band, rewrite direction, and original reference anchors (direction only, never ghostwrites prose), plus `plan` / `verify` / `mark` re-checking.
- **External JSON genre packs & visual Pack Studio (5 built-in / editor / `[DSH-PACK v1]` share & `.json` import/export)**: ships 5 built-in JSON genre packs (`western-fantasy`, `eastern-xianxia`, `modern-urban`, `mystery-thriller`, `scifi-cyberpunk`) and hot-reloads custom packs from `<library-root>/.novel-writer/packs/*.json` (up to 2-level `extends`, ReDoS validation, and symlink escape guards). The Web UI Pack Studio lets you create, fork, or edit custom packs, copy readable `[DSH-PACK v1]` share envelopes, export `.json` files directly, and safely import via paste or `.json` file with a dry-run preview inspecting prompt-facing fields, rejected regexes, and ID conflicts (remaining 100% offline). Coordinates with `novel_settings`, `novel_plot { action: "graph" }`, `novel_continuity_check`, and `novel_semantic_search`.
- **Redesigned 4-tab Web UI workbench & safe maintenance (presets / genre packs / scene-band views)**: consolidates the UI into four tabs (`Workbench` / `AI & Tools` / `Health & Reports` / `Maintenance & Advanced`) with tool search, 5-group filtering + 1-click scenario presets (`all` / `writing` / `revising` / `auditing` / `setup`, keeping `novel_sentence_config` permanently visible to prevent lockout), a Genre Packs manager view, and a Scene-band baseline view alongside yardstick selection, scene-scoped prompts, threshold-paced live-chat draft mirroring (`novel_draft`), `rawWriting` mode, 13-location per-book cleanup with recycle-bin restore (`novel_delete_book`), and share-safe redacted diagnostics (`novel_diagnose`).

> **Scope note for non-Chinese users**: lexicons, pragmatics rules, sentence-pattern heuristics, report text, and the bundled semantic model are tuned specifically for Chinese fiction; non-Chinese prose is not supported.

---

## Install & Quick Start

### 1. Install (DSH plugin)

```sh
dsh plugin add dsh-novel-writer                     # Option 1: npm (recommended; add --profile <name> if needed)
dsh plugin add github:siweina/dsh-novel-writer#main # Option 2: GitHub
```

Requires **Node.js ≥ 22.13** (external MCP and standalone CLI require built-in `node:sqlite`; DSH Desktop bundles Node 24 and is unaffected) and **DSH ≥ 0.1.1-rc.2**. Restart DSH after installing to see the **Writing Assistant** entry in the left sidebar (official DSH 0.2.0+ seats, with automatic fallback on older hosts). Without DSH, use the [MCP server](#mcp-server-outside-dsh).

### 2. One complete chapter loop

Place chapter files inside `novels/<book>/` (e.g. `01.md`, `02.md`) and prompt in order:

| Step | What you ask | Tool | What you get |
|---|---|---|---|
| 1. **Gather** | "gather material for the next chapter" | `novel_chapter_brief` | All 16 context inputs in one read-only call (`degraded` lists gaps) |
| 2. **Write** | "write chapter N" | `novel_new_chapter` · prose | New chapter file with baseline μ & reference anchors (calibrate feel, don't template) |
| 3. **Check** | "check chapter N" | `novel_style_check` · `novel_sentence_analysis` | Similarity + deviation list + six-metric comparison (`✓` in band / `⚠` out) |
| 4. **Revise** | "turn chapter N into a fix list" | `novel_fix_plan` | Ordered to-dos with line numbers, target bands & anchors; run `verify` after edits |
| 5. **Audit** | "show me the book's structure" | `novel_plot { action: "graph" }` | Plot spans, character absences, thread gaps & outline-vs-body drift |

<details>
<summary>Sample output: Chapter brief & Fix plan (translated; runtime output is in Chinese)</summary>

```text
[Chapter Brief: novel_chapter_brief] Target: Chapter 8 (inferred file: 08.md)
  Previous hand-off: ... (last 300/600 chars) | Open plot thread: [mu5kjla...] Amber gear pocket watch (high | planted ch. 1, 6 chapters ago)
  Characters: Lin Zhao / Shen Yan | Worldview wording: light candles, no incense (avoid: incense -> candle; double-hour -> hour)
  Style baseline: complexity mu=2.42  modifierDensity mu=22.2 ... (sampled: 7 chapters excluding target)
  Reference anchors: [dialogue] ... [psychology] ... | Degraded note: no hook recorded for Chapter 7

[Fix Plan: novel_fix_plan] 13 to-do items (sorted by severity desc -> effort asc)
  - [Abstraction too high] severity 5 / effort 2 (line 5)  id: fix-abstract-5-c2c156d4
      Current: 47.9  Target: 0.55~6.95 | Quote: "She vaguely felt a hard-to-describe sense..."
      Direction: Heavy abstract wording; replace with concrete actions or physical objects.
      Reference anchor: "She turned the watch over in her palm; half of her father's name remained on the worn back."
```

</details>

---

## Provided Tools (22)

> Full parameter schemas, return contracts, and computation notes live in the [online tool docs](https://siweina.github.io/dsh-novel-writer/tools/).

| Category | Tool | Description |
|---|---|---|
| **Library & chapters** | `novel_books` | List all books and basic statistics in the library |
| | `novel_chapters` | List a book's chapters with character and line counts |
| | `novel_read` | Read a chapter paginated by `offset` and `limit` |
| | `novel_new_chapter` | Create a new chapter file with an attached baseline summary |
| | `novel_import` | Batch scan, group by book/chapter, and import manuscripts |
| | `novel_draft` | Append-only draft mirror for *Live chat writing* paced by a char threshold |
| **Brief & revision** | `novel_chapter_brief` | Read-only chapter brief gathering 16 inputs before writing (with scene reference bands & genre-pack linkage) |
| | `novel_fix_plan` | Priority-ordered revision to-do list using scene-band baselines & genre-pack slop exemptions (`plan` / `verify` / `mark`) |
| | `novel_outline` | Maintain the five creation markdown files (bible / characters / outline / hooks / status) |
| | `novel_summary` | Read and write per-chapter summaries for long-form continuity |
| **Style & semantics** | `novel_style_report` | Six-metric baseline, per-scene reference bands, lexicon, genre, emotion quantification & 12-axis vibe spectrum |
| | `novel_style_check` | Compare a chapter against scene-band or selected baseline (rule + semantic + fix anchors) |
| | `novel_sentence_analysis` | 9 sentence patterns, purified emotion curve, rhythm fingerprint & guidance |
| | `novel_keywords` | Extract high-frequency bigrams, trigrams, name candidates & English terms |
| | `novel_semantic_search` | Natural-language passage search using local ONNX embeddings |
| **Settings & continuity** | `novel_settings` | Manage 5 settings tables, culture detection, and `packs` / `worldview.pack` genre packs |
| | `novel_lexicon` | Book + global required lexicon registry, brief injection & draft wording audit |
| | `novel_plot` | Track foreshadowing threads and render the cross-chapter structure graph |
| | `novel_continuity_check` | Continuity audit with bridge, character OOC & outline-drift sentinels |
| **Config & maintenance** | `novel_sentence_config` | View/update master, 22-tool, 11-feature, tolerance & prompt-scene settings |
| | `novel_diagnose` | Five health checks + local event log aggregation into a share-safe redacted bundle |
| | `novel_delete_book` | Preview and clean 13 book-scoped locations via a restorable recycle bin |

---

## MCP Server (Outside DSH)

The package ships a local **stdio MCP server** (`mcp/server.mjs`) for Claude Desktop, Cursor, and any standard MCP host:

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

- Because the package name (`dsh-novel-writer`) differs from the binary (`dsh-novel-writer-mcp`), keep `-p dsh-novel-writer`;
- Root resolution priority: `--root` > `DSH_NOVEL_WRITER_ROOT` > current working directory;
- Pass `--preset <all|writing|revising|auditing|setup>` to filter `tools/list` by scenario (intersected with `state.json`, keeping `novel_sentence_config` always visible);
- Both `root` arguments and `novel_import.src` are confined to the configured root by default (pass `--allow-external-src` to import outside it). See [mcp/README.md](./mcp/README.md).

**Standalone Web UI & Antigravity Sidecar Plugin (outside DSH)**:

```sh
npm run ui                                                          # Launch standalone 4-tab Web UI from repo
node mcp/server.mjs --ui --ui-port 3789 --root /path/to/your/novels # Launch with optional --ui-port
node tools/install-antigravity-ui.mjs --apply                       # Install Antigravity Sidecar Aux Pane plugin
```

- **Audience & guardrails**: Standalone Web UI / Antigravity Aux Pane exposes the full local control panel (including all switches, 18+ mode, and book deletion / recycle-bin purge) for **single-user personal loopback use** (`127.0.0.1` + `Host`/`Origin` checks — do not reverse-proxy or expose it to a LAN or other users). Both 18+ mode (countdown + typed pledge) and irreversible recycle-bin purge (typed book/entry name) enforce in-panel explicit text confirmation rather than relying on `window.confirm`, which sandboxed webviews may block.

---

## Configuration, Data Layout & Security Bounds

**Plugin configuration** (in your DSH config):

```yaml
- id: novel-writer
  config:
    root: 'D:/my-novel-library'
    allowLanState: false   # true = allow state writes over LAN (delete-book remains loopback-only)
```

**Directory layout**:
- `novels/<book>/` stores chapter manuscripts alongside per-book creation markdown files (bible, character cards, outline, hooks, status card — managed via `novel_outline`);
- `<library-root>/.novel-writer/cache.sqlite` (WAL mode) stores recomputable derived caches (`chapter_metrics`, `analysis_cache`, 128-dim `embedding_*` blobs, and the persistent 512-dim `audit_vectors` LRU) — **never stores prose**, self-heals on corruption, and is **safe to delete anytime** (recomputed on demand);
- `<library-root>/.novel-writer/` keeps all core authoring data as plain human-readable JSON: `plots`, `settings/<book>.json` (holding both the five settings tables and book-local `creationProfile` to prevent cross-library collisions, synced with `novel_settings` / creation markdowns and transparently migrating/cleaning legacy `state.json` entries), `packs` (custom JSON genre rule packs), `summaries`, `audits` (`fix-plan-*.json`), `style-reports`, `baseline`, `lexicon` (`_global.json` is global), `drafts`, legacy cache fallback dirs (`analysis`, `embedding`), and `trash` (recycle-bin entries occupy disk until explicitly `purge`d);
- `~/.dsh/dsh-novel-writer/` holds global toggle `state.json` (overridable via `DSH_NOVEL_WRITER_STATE`; concurrent file transactions use cross-process atomic `.lock` files) and rotated local event logs `logs/events.jsonl` (512 KB × 3 files).

**Dependencies, permissions & bounds**:
- **Runtime dependencies**: `onnxruntime-web` and `@huggingface/tokenizers`; browser UI reuses host `react` (`peerDependencies`). Zero lifecycle scripts.
- **Network & subprocesses**: sole outbound request is GitHub Releases API update checking (3 s timeout, 24 h cache, sends no library data); sole subprocess call opens the OS file manager via direct argv (no shell); registers 13 loopback-protected HTTP routes (shared by DSH host and standalone Web UI).
- **Two-tier log privacy**: `events.jsonl` stays strictly on the local machine (free-text fields clamped to `≤160` chars); share output from `novel_diagnose` or the UI "copy diagnostic bundle" button strips all free text wholesale and maps errors to fixed codes so it can be pasted safely into public issues.
- **Failure bounds**: falls back cleanly to rule-only mode if the semantic engine is unavailable; corrupt caches/state never claim "uninitialized". Known caveat: replacing a chapter `.md`/`.markdown`/`.txt` file with a directory of the same name makes `scanChapters` skip it (recording a `silent_skip` log entry rather than surfacing it in `degraded`).

---

## License

[MIT](./LICENSE)

🔗 [Website](https://siweina.github.io/dsh-novel-writer/) · [Technical docs](https://siweina.github.io/dsh-novel-writer/tools/) · [Changelog](./CHANGELOG.md) · [MCP manual](./mcp/README.md) · [GitHub](https://github.com/siweina/dsh-novel-writer) · [npm](https://www.npmjs.com/package/dsh-novel-writer)
