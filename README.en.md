# 📚 dsh-novel-writer — Novel Writing Assistant

English | [**中文**](./README.md)

[![npm version](https://img.shields.io/npm/v/dsh-novel-writer.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/dsh-novel-writer)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/siweina/dsh-novel-writer.svg?style=flat-square&color=orange)](https://github.com/siweina/dsh-novel-writer/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/siweina/dsh-novel-writer.svg?style=flat-square)](https://github.com/siweina/dsh-novel-writer/releases)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b8bbe.svg?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

A novel-writing assistant plugin for **DeepSeek Harness (DSH)**: chapter library management, sentence-pattern analysis, style checking, plot tracking, settings management, worldview detection, batch import, and AI-assisted continuation writing. Zero third-party dependencies on host (Node built-ins only); browser side depends only on the Web GUI's built-in react.

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

After installing, **restart the web app** to activate (Host registers 13 tools + state/reveal routes; browser mounts the "Writing Assistant" sidebar toggle panel).

---

## Features

1. **Chapter library**: chapters in `novels/<book>/第N章.md` (or .txt/.markdown); chapter numbers anywhere + Chinese numerals (第一章/第十四章); auto encoding detection (UTF-8/UTF-16/GBK).
2. **Sentence-pattern analysis** (`novel_sentence_analysis`): 9 categories, transition patterns, sentence-length rhythm, emotion curve (joy/anger/sorrow/fear/surprise), style fingerprint + guidance, with cache & report export.
3. **Style check** (`novel_style_check`): chapter vs book → cosine similarity + deviation list (syntax/length/emotion) + advice.
4. **Plot tracking** (`novel_plot`): foreshadowing/plot-hook registry (open/done), typed fields (priority/characters/payoff) + auto mention tracking.
5. **Settings management** (`novel_settings`): five tables — characters / locations / items / timeline / **worldview (usage norms)**, with scan candidates.
6. **Worldview detection** (v0.9.0): `novel_settings category=worldview action=detect` scans the book and auto-judges the cultural baseline (western/eastern/mixed) with confidence and evidence; register banned words (`bannedWords`) and recommended replacements (`recommended`); `novel_continuity_check` auto-scans for mixed-culture anachronisms.
7. **Chapter summaries** (`novel_summary`): 200-500 char digest + key events per chapter, for long-book continuation.
8. **Continuity audit** (`novel_continuity_check`): scans book against settings → number-usage / missing-characters / unused-aliases / duplicate-entries / usage-conflicts candidates.
9. **Batch import** (`novel_import`): auto-detect book names & chapter numbers from a folder, classified import (same-book hints, file selection).
10. **Continuation writing**: read-first workflow keeping style & foreshadowing consistent; `novel_new_chapter` creates new chapters.
11. **Per-tool UI toggles**: "Writing Assistant" sidebar panel (master switch + per-tool switches).

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
| `novel_sentence_config` | View/set tool toggles |
| `novel_style_check` | Style check (similarity+diffs) |
| `novel_plot` | Plot/foreshadowing tracker |
| `novel_settings` | Settings management (+worldview) |
| `novel_summary` | Chapter summaries |
| `novel_continuity_check` | Continuity audit |

---

## Configuration

Override in the profile's `cordis.patch.yml` (`root` = library root directory, defaults to session workspace):

```yaml
- id: novel-writer
  config:
    root: 'D:/my-novel-library'
    allowLanState: false   # true = allow state save from LAN GUI access
```

---

## Data Directory

Five subdirectories under `<library-root>/.novel-writer/`: `plots` / `settings` / `summaries` / `analysis` / `audits`.

---

## License

[MIT](./LICENSE)
