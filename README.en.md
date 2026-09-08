# 📚 dsh-novel-writer — on-device style checkup for novel writers

English | [中文](./README.md)

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![npm downloads](https://img.shields.io/npm/dm/dsh-novel-writer.svg?style=flat-square&color=green)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.3-339933.svg?style=flat-square)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.1.1--rc.2-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

**16 tools that turn "my writing drifted" into numbers you can act on.**
Sentence, emotion and style-baseline analysis all run **on your machine**: a 24MB Chinese model ships with the package,
**zero API cost, your manuscript never leaves the device**. Built for DeepSeek Harness (DSH); the same engine is also
exposed as a **stdio MCP server** for Claude Desktop / Cursor.

## Install

`sh
dsh plugin --profile web add dsh-novel-writer
# or
npm install dsh-novel-writer
`

Requires **Node >= 22.3**. Restart the web app; a "写作助手功能" panel appears in the sidebar.

## MCP server

`sh
node /path/to/node_modules/dsh-novel-writer/mcp/server.mjs --root /path/to/your/novels
`

See [mcp/README.md](./mcp/README.md) for the Claude Desktop / Cursor config.

---

## Installation

**Option 1: npm (recommended)**

```sh
dsh plugin --profile web add dsh-novel-writer
# or
npm install dsh-novel-writer
```

**Option 2: From GitHub**

```sh
dsh plugin --profile web add github:siweina/dsh-novel-writer#main
```

After installing, **restart the web app** to activate (host registers 16 tools + state/reveal routes; browser mounts the "Writing Assistant" sidebar toggle panel).

---

## Features

1. **Style portrait report** (`novel_style_report`): 6-dimension measurement — style fingerprint / high-frequency lexicon / genre-theme / emotion quantification / 12-axis vibe spectrum / semantic style distance. **Measurement-judgment separation**: the plugin only reports numbers, never labels; AI judgment can be saved back to `.novel-writer/style-reports/` for consistent continuation writing.
2. **12-axis vibe spectrum**: nightmare / angst / heartwarming / fluff / tearjerker / dark / mystery / blaze / absurd / lonesome / aesthetic / sensual — with traceable evidence, 0 token.
3. **Local semantic engine**: bge-small-zh Chinese model (24MB, shipped with the plugin) local CPU inference — `novel_semantic_search` finds semantically related passages with natural language (with chapter location), semantic style comparison, semantic implicit emotion; lazy loading + graceful fallback.
4. **Sentence-pattern analysis**: 9 categories, arrangement patterns, rhythm, emotion curve, style fingerprint + guidance, with cache & report export.
5. **Emotion purification & quantification**: strong/weak emotion-word grading, pollution detection, caveat warning + AI re-verification; Valence sliding window → variance V / delta Δ / conflict index C + implicit imagery carriers.
6. **Worldview & pragmatics detection**: auto cultural-baseline detection with confidence; speechStyle title/honorifics/rituals/tone norms; genre & theme + webnovel signals.
7. **Writing toolkit**: plot tracking / five settings tables (characters·locations·items·timeline·worldview) / chapter summaries / continuity audit / batch import / style check / continuation writing.
8. **Per-tool UI toggles**: "Writing Assistant" sidebar panel (master + grouped tool toggles + feature toggles), plain-language labels, data-dir usage & semantic-engine status display.
9. **Style Baseline**: Six writing metrics (syntactic complexity / modifier density / abstraction / action density / hedging / gap index) + per-chapter μ±σ baseline band; `novel_style_report` outputs the band, `novel_style_check` compares new chapters (in-band ✓ / out-of-band ⚠); per-metric ±% tolerance configurable in the sidebar (**recommended = 1.5× σ of the book's chapter variance**, rounded, clamped to ±10%~100%; leave blank to use recommended) — free theme, writing style kept inside the band.
10. **Writing sentinels**: `novel_continuity_check` extended — ①**bridge check** (`chapter`: time jumps / semantic distance / character continuity / hook handoff, with quoted evidence) ②**OOC check** (`ooc`: per-character emotion baseline deviation) ③**outline drift** (`outline`: direction vs body keyword overlap); **brief mode** for report tools.
11. **Original mode & creation files**: fill in creation settings in the sidebar (worldview/characters/forbidden/main conflict/genre/extras, blank = model decides, per-book profile library); novel_outline maintains creation files (bible/characters/outline/hooks/status), enforcing the bible → outline → hook chain with dynamic batches (10→20→30 chapters) to prevent plot jumps and OOC.
12. **Experience & stats**: main panel **library stats** (per-book chapters/total chars/7-day active chars, 🔥 green), **🎬 demo** (built-in sample, no files, runs the 6-dim baseline), **📊 report history** (analysis/style-reports browsing); actionable error hints; slimmer tool descriptions.

---

## Provided Tools (16)

| Tool | Description |
|------|-------------|
| `novel_books` | List all books in library |
| `novel_chapters` | List a book's chapters |
| `novel_read` | Read a chapter (paginated) |
| `novel_keywords` | Keywords: bigram/trigram/name candidates |
| `novel_new_chapter` | Create new chapter file |
| `novel_import` | Batch import manuscripts |
| `novel_sentence_analysis` | Sentence-pattern analysis |
| `novel_sentence_config` | View/set tool & feature toggles |
| `novel_style_check` | Style check (rule + semantic) |
| `novel_style_report` | **Style portrait report** (6-dim measurement) |
| `novel_plot` | Plot/foreshadowing tracker |
| `novel_settings` | Settings management (+worldview) |
| `novel_summary` | Chapter summaries |
| `novel_continuity_check` | Continuity audit + **bridge/OOC/outline sentinels** |
| `novel_semantic_search` | Semantic search (local embedding, 0 token) |
| `novel_outline` | **Creation-file management** (bible/characters/outline/hooks/status) |

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

Under `<library-root>/.novel-writer/`: `plots` / `settings` / `summaries` / `analysis` / `audits` / `embedding` / `style-reports`.

---

## Dependencies, permissions and failure bounds

**Runtime dependencies** (installed by `npm install`; all public packages):

- `onnxruntime-web` ^1.24.3 — local ONNX inference (WASM backend) for semantic search and style distance;
- `@huggingface/tokenizers` ^0.1.0 — tokenization (WASM);
- peerDependency `react` ^18.2.0 — the browser half reuses the React shipped with the DSH Web GUI.

**Local model**: `lib/models/` ships the quantized bge-small-zh-v1.5 model (~24MB ONNX) and its tokenizer
(`tokenizer.json.gz`, decompressed on load). All inference runs on the local CPU; no text is uploaded.

**Permissions and external services**:

- Filesystem: only the user-chosen library root (`novels/`), its data directory (`<root>/.novel-writer/`)
  and the plugin state file (`~/.dsh/dsh-novel-writer/state.json`).
- Local HTTP: five routes registered inside the DSH Web GUI, loopback-only by default.
- Network: the only outbound call is the GitHub Releases API (`api.github.com`) for update checks —
  3s timeout, 24h cache, silent fallback; no manuscript content is sent.
- Subprocesses: none, except opening the OS file manager with an argv array.
- Lifecycle scripts: none.

**Failure bounds**: semantic engine failure falls back to pure rule mode; cache/disk failures never block
tool results; a plugin load failure cannot affect the DSH host process.

**Compatibility**: Node.js >= 22.3 (`engines.node`); DSH >= 0.1.1-rc.2 (`dsh.engines.dsh`).

---
## License

[MIT](./LICENSE)
