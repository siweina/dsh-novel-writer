# 📚 dsh-novel-writer — Novel Writing Assistant

English | [**中文**](./README.md)

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/siweina/dsh-novel-writer.svg?style=flat-square)](https://github.com/siweina/dsh-novel-writer/releases)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

A novel-writing assistant plugin for **DeepSeek Harness (DSH)** (v3.0.0): chapter library management, sentence-pattern analysis, emotion purification & quantification, **6-dimension writing-metric baseline band**, 12-axis vibe spectrum, **style portrait report**, plot & settings management, local semantic search (0 token), webnovel signal detection, batch import, and AI-assisted continuation writing. Zero third-party dependencies on host. **Requires Node ≥ 22.3.**

> **A note to non-Chinese users**: This plugin is designed specifically for Chinese-language novel analysis and writing — its core capabilities (sentence-pattern analysis, emotion quantification, imagery detection) and its built-in semantic model are all built and tuned for Chinese text. Fully supporting English or other languages alongside Chinese is beyond my current capability. I sincerely apologize for any inconvenience this may cause.

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

After installing, **restart the web app** to activate (host registers 15 tools + state/reveal/update-check routes; browser mounts the "Writing Assistant" sidebar panel).

---

## Features

1. **6-dimension writing-metric baseline band** (v3.0.0 core, `novel_style_report` / `novel_style_check`): sentence complexity / modifier density / abstractness / action density / uncertainty / gap (whitespace) index. Per-chapter μ±σ forms the book's baseline band; new chapters are judged dimension by dimension (in-band ✓ / half-band △ / out-of-band ⚠). **Themes, plots and characters stay free — the band governs writing style only, never content.**
2. **Recommended tolerance (ready to use)**: each dimension auto-suggests a tolerance of **1.5× the book's chapter σ** (rounded to 5%, capped at ±10%~100%); users can also set custom per-dimension ±% in the "Writing Assistant → Style Baseline" panel (signs fixed by position, inputs accept 0–100 only).
3. **Style portrait report** (`novel_style_report`): 6-dimension measurement — style fingerprint / high-frequency lexicon / genre-theme / emotion quantification / 12-axis vibe spectrum / semantic style distance. **Measurement-judgment separation**: the plugin only reports numbers, never labels; AI judgment can be saved back.
4. **12-axis vibe spectrum**: nightmare / angst / heartwarming / fluff / tearjerker / dark / mystery / blaze / absurd / lonesome / aesthetic / sensual — with traceable evidence, 0 token.
5. **Local semantic engine**: bge-small-zh Chinese model (24MB, shipped with the plugin) local CPU inference — natural-language search over the whole book (with chapter location), semantic style comparison, semantic implicit emotion; lazy loading + graceful fallback.
6. **Sentence-pattern analysis**: 9 categories, arrangement patterns, rhythm, emotion curve, style fingerprint + guidance, with cache & report export.
7. **Emotion purification & quantification**: strong/weak emotion-word grading, pollution detection, caveat warning + AI re-verification; Valence sliding window → variance V / delta Δ / conflict index C.
8. **Writing toolkit**: plot tracking / five settings tables / chapter summaries / continuity audit / batch import / style check / continuation writing / update check.
9. **Per-tool UI toggles**: "Writing Assistant" sidebar panel (master + grouped tool toggles + feature toggles + style baseline tolerance), data-dir usage & semantic-engine status display.

---

## Provided Tools (15)

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
| `novel_style_check` | Style check (rule + semantic + **6-dim baseline**) |
| `novel_style_report` | Style portrait (6-dim measurement + **baseline band**) |
| `novel_plot` | Plot/foreshadowing tracker |
| `novel_settings` | Settings management (+worldview) |
| `novel_summary` | Chapter summaries |
| `novel_continuity_check` | Continuity audit |
| `novel_semantic_search` | Semantic search (local embedding, 0 token) |

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

## License

[MIT](./LICENSE)
