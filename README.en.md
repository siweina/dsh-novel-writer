# 📚 dsh-novel-writer — Novel Writing Assistant

English | [**中文**](./README.md)

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/siweina/dsh-novel-writer.svg?style=flat-square)](https://github.com/siweina/dsh-novel-writer/releases)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

A novel-writing assistant plugin for **DeepSeek Harness (DSH)** (v2.5.0): chapter library management, sentence-pattern analysis, emotion purification & quantification, **12-axis vibe spectrum**, **style portrait report**, plot & settings management, local semantic search (0 token), webnovel signal detection, batch import, and AI-assisted continuation writing. Zero third-party dependencies on host.

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

After installing, **restart the web app** to activate (host registers 15 tools + state/reveal routes; browser mounts the "Writing Assistant" sidebar toggle panel).

---

## Features

1. **Style portrait report** (`novel_style_report`, v2.5.0): 6-dimension measurement — style fingerprint / high-frequency lexicon / genre-theme / emotion quantification / 12-axis vibe spectrum / semantic style distance. **Measurement-judgment separation**: the plugin only reports numbers, never labels; AI judgment can be saved back to `.novel-writer/style-reports/` for consistent continuation writing.
2. **12-axis vibe spectrum** (v2.5.0): nightmare / angst / heartwarming / fluff / tearjerker / dark / mystery / blaze / absurd / lonesome / aesthetic / sensual — with traceable evidence, 0 token.
3. **Local semantic engine** (v2.0.0): bge-small-zh Chinese model (23MB, shipped with the plugin) local CPU inference — `novel_semantic_search` finds semantically related passages with natural language, semantic style comparison, semantic implicit emotion; lazy loading + graceful fallback.
4. **Sentence-pattern analysis**: 9 categories, arrangement patterns, rhythm, emotion curve, style fingerprint + guidance, with cache & report export.
5. **Emotion purification & quantification**: strong/weak emotion-word grading, pollution detection, caveat warning + AI re-verification; Valence sliding window → variance V / delta Δ / conflict index C + implicit imagery carriers.
6. **Worldview & pragmatics detection**: auto cultural-baseline detection with confidence; speechStyle title/honorifics/rituals/tone norms; genre & theme + webnovel signals (v2.2).
7. **Writing toolkit**: plot tracking / five settings tables (characters·locations·items·timeline·worldview) / chapter summaries / continuity audit / batch import / style check / continuation writing.
8. **Per-tool UI toggles**: "Writing Assistant" sidebar panel (master + grouped tool toggles + feature toggles), plain-language labels.

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
| `novel_style_check` | Style check (rule + semantic) |
| `novel_style_report` | **Style portrait report** (6-dim measurement) |
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
