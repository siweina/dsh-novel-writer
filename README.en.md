# 📚 dsh-novel-writer — Novel Writing Assistant

English | [**中文**](./README.md)

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/siweina/dsh-novel-writer.svg?style=flat-square)](https://github.com/siweina/dsh-novel-writer/releases)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

A novel-writing assistant plugin for **DeepSeek Harness (DSH)** (v3.1.0): chapter library management, sentence-pattern analysis, emotion purification & quantification, **6-dimension writing-metric baseline band**, 12-axis vibe spectrum, **style portrait report**, **original-creation mode with per-book profile library**, plot & settings management, local semantic search (0 token), webnovel signal detection, batch import, and AI-assisted continuation writing. Zero third-party dependencies on host. **Requires Node ≥ 22.3.**

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

After installing, **restart the web app** to activate (host registers 16 tools + state/reveal/update-check routes; browser mounts the "Writing Assistant" sidebar panel).

---

## Features

1. **Original-creation mode (v3.1.0 core, per-book profile library)**: maintain creative intent per book in the sidebar — worldview / characters / forbidden events / main conflict / genre preference / extra requirements (6 dimensions); **books without a directory yet can be pre-configured**; saving auto-creates `novels/创作资料/<book>/创作设定.md`; a "default profile" covers new books; character settings sync into 《主要人物设定.md》.
2. **novel_outline (creation-material management, 1 of 16 tools)**: creation bible / main & minor characters / plot outline / hook log / status card (6 files, 7 actions); **enforced workflow** — read status+outline before writing, backfill the chapter-end hook after each chapter (auto reminder for missing hooks), dynamic batch sizing (10/20/30 chapters).
3. **6-dimension writing-metric baseline band**: sentence complexity / modifier density / abstractness / action density / uncertainty / gap index; per-chapter μ±σ band; recommended tolerance = 1.5σ (capped ±10%~100%); per-dimension verdicts (in-band ✓ / half-band △ / out-of-band ⚠). **Themes/plots/characters stay free — the band governs writing style only.**
4. **Style portrait report**: 6-dimension measurement — style fingerprint / high-frequency lexicon / genre-theme / emotion quantification / 12-axis vibe spectrum / semantic style distance. Measurement-judgment separation with save-back.
5. **Local semantic engine**: bge-small-zh Chinese model (24MB, shipped) local CPU inference — natural-language whole-book search (with chapter location), semantic style comparison, semantic implicit emotion; 0 token, lazy loading + graceful fallback.
6. **Sentence-pattern analysis**: 9 categories, arrangement patterns, rhythm, emotion curve, style fingerprint, with cache & export; emotion purification + Valence quantification (V / Δ / C).
7. **Writing toolkit**: plot tracking / five settings tables / chapter summaries / continuity audit / batch import / style check / update check.
8. **Per-tool UI toggles**: master + grouped tool toggles + feature toggles + style baseline tolerance + original-creation profile library; data-dir usage & semantic-engine status.

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
| `novel_style_check` | Style check (rule + semantic + **6-dim baseline**) |
| `novel_style_report` | Style portrait (6-dim measurement + **baseline band**) |
| `novel_plot` | Plot/foreshadowing tracker |
| `novel_settings` | Settings management (+worldview) |
| `novel_summary` | Chapter summaries |
| `novel_continuity_check` | Continuity audit |
| `novel_semantic_search` | Semantic search (local embedding, 0 token) |
| `novel_outline` | **Creation-material management** (bible/characters/outline/hooks/status) |

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
