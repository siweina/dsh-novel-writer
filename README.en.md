# 📚 dsh-novel-writer — Novel Writing Assistant

English | [**中文**](./README.md)

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/siweina/dsh-novel-writer.svg?style=flat-square)](https://github.com/siweina/dsh-novel-writer/releases)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

A novel-writing assistant plugin for **DeepSeek Harness (DSH)**: chapter library management, sentence-pattern analysis, emotion purification & quantification, style checking, plot tracking, settings management, worldview/pragmatics detection, **local semantic search (0 token)**, batch import, and AI-assisted continuation writing. Zero third-party dependencies on host.

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

After installing, **restart the web app** to activate (host registers 14 tools + state/reveal routes; browser mounts the "Writing Assistant" sidebar toggle panel).

---

## v2.0.0 New: Local Semantic Engine (0 token)

- 🧠 **Built-in Chinese semantic model** (bge-small-zh-v1.5 quantized, 23MB, shipped with the plugin): 512-dim vectors, local CPU inference, **zero API cost**;
- 🔍 **novel_semantic_search**: search the whole book with natural language for semantically related passages (foreshadowing/emotional scenes/settings), even without matching keywords;
- 📊 **Semantic style comparison**: novel_style_check adds a semantic-similarity dimension beyond rule-based fingerprints;
- 💭 **Semantic implicit emotion**: emotion prototype sentences scan the book index to find "imagery passages outside the word list";
- 🪶 Lazy loading + automatic fallback to pure-rule mode (never breaks existing features).

---

## Features

1. **Chapter library**: chapters in `novels/<book>/第N章.md` (or .txt/.markdown); auto encoding detection (UTF-8/UTF-16/GBK).
2. **Sentence-pattern analysis**: 9 categories, arrangement patterns, rhythm, emotion curve, style fingerprint + guidance, with cache & report export.
3. **Emotion purification**: strong/weak emotion-word grading, pollution-source detection, caveat warning + AI re-verification, cleanDominant true baseline.
4. **Emotion quantification** (v1.6.0): Valence mapping + sliding window → variance V / delta Δ / conflict index C; implicit imagery carriers + explicit-implicit conflict; complexity score + composite emotion pairs.
5. **Style check**: chapter vs book → similarity + deviation list + advice.
6. **Plot tracking**: foreshadowing/plot-hook registry (open/done), typed fields + auto mention tracking.
7. **Settings management**: five tables — characters / locations / items / timeline / worldview.
8. **Worldview & pragmatics detection**: auto cultural-baseline detection with confidence; speechStyle title/honorifics/rituals/tone norms.
9. **Genre & theme detection**: primary/secondary themes + genre, low-frequency noise filtered.
10. **Chapter summaries**: per-chapter digest + key events for long-book continuation.
11. **Continuity audit**: settings conflicts + pragmatics conflicts with replacement suggestions.
12. **Batch import**: auto-detect book names & chapter numbers, classified import.
13. **Continuation writing**: read-first workflow; keeps style/foreshadowing/worldview consistent.
14. **Per-tool UI toggles**: "Writing Assistant" sidebar panel (master + per-tool + feature toggles).

---

## Provided Tools (14)

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
| `novel_plot` | Plot/foreshadowing tracker |
| `novel_settings` | Settings management (+worldview) |
| `novel_summary` | Chapter summaries |
| `novel_continuity_check` | Continuity audit |
| `novel_semantic_search` | **Semantic search** (v2.0.0, local embedding, 0 token) |

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

Under `<library-root>/.novel-writer/`: `plots` / `settings` / `summaries` / `analysis` / `audits` / `embedding` (semantic index cache).

---

## License

[MIT](./LICENSE)
