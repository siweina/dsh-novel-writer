# 📚 dsh-novel-writer — Novel Writing Assistant

English | [**中文**](./README.md)

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/siweina/dsh-novel-writer.svg?style=flat-square)](https://github.com/siweina/dsh-novel-writer/releases)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

A novel-writing assistant plugin for **DeepSeek Harness (DSH)**: chapter library management, sentence-pattern analysis, style checking, plot tracking, settings management, worldview/pragmatics detection, emotion purification, batch import, and AI-assisted continuation writing. Zero third-party dependencies on host (Node built-ins only).

---

## Installation

**Option 1: npm (recommended)**

```sh
npm install dsh-novel-writer
# or
dsh plugin --profile web add dsh-novel-writer
```

**Option 2: From GitHub**

```sh
dsh plugin --profile web add github:siweina/dsh-novel-writer#main
```

After installing, **restart the web app** to activate.

---

## Features

1. **Chapter library**: chapters in `novels/<book>/第N章.md` (or .txt/.markdown); auto encoding detection (UTF-8/UTF-16/GBK).
2. **Sentence-pattern analysis**: 9 categories, emotion curve, style fingerprint + guidance, with cache & report export.
3. **Emotion purification** (v1.5.0): strong/weak emotion-word grading (weak = physiological/pleasure words easily polluted); pollution-source detection (R18/battle/horror density thresholds → confidence downgrade + caveat warning + aiAction forcing AI re-verification); cleanDominant = true baseline after removing pollution.
4. **Style check**: chapter vs book → cosine similarity + deviation list + advice.
5. **Plot tracking**: foreshadowing/plot-hook registry with typed fields + auto mention tracking.
6. **Settings management**: five tables — characters / locations / items / timeline / worldview (usage + pragmatics norms).
7. **Worldview & pragmatics detection**: auto cultural-baseline detection with confidence; `speechStyle` title/honorifics/rituals/tone; both eastern & western pragmatics supported (v1.0.1).
8. **Genre & theme detection** (v1.5.0): `detect` outputs theme (bone) + genre (skin); low-frequency noise filtered (count<5), generalization words cleaned.
9. **Chapter summaries**: per-chapter digest + key events for long-book continuation.
10. **Continuity audit**: settings conflicts + pragmatics conflicts (honorifics/rituals/titles) with replacement suggestions.
11. **Batch import**: auto-detect book names & chapter numbers, classified import.
12. **Continuation writing**: read-first workflow; `novel_new_chapter` creates chapters.
13. **Per-tool UI toggles**: "Writing Assistant" sidebar panel (master + per-tool + feature toggles emotionCaveat/genreTheme).

---

## Provided Tools

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
| `novel_style_check` | Style check (similarity+diffs) |
| `novel_plot` | Plot/foreshadowing tracker |
| `novel_settings` | Settings management (+worldview) |
| `novel_summary` | Chapter summaries |
| `novel_continuity_check` | Continuity audit |

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

Under `<library-root>/.novel-writer/`: `plots` / `settings` / `summaries` / `analysis` / `audits`.

---

## License

[MIT](./LICENSE)
