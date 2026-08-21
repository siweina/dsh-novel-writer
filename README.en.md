# dsh-novel-writer — Novel Writing Assistant Plugin (v2.5.0)

A DSH (DeepSeek Harness) bundle plugin. **Ships a local semantic embedding engine (bge-small-zh-v1.5 ONNX, bundled, CPU inference, 0 token cost)** — semantic capabilities without any API fees.

## Tools (15, each with an independent UI switch)
novel_books / novel_chapters / novel_read / novel_keywords / novel_new_chapter / novel_import / novel_sentence_analysis / novel_sentence_config / novel_style_check / novel_plot / novel_settings / novel_summary / novel_continuity_check / novel_semantic_search (new in v2.0.0) / **novel_style_report (new in v2.5.0)**

## v2.0.0 — Semantic Layer
- **Local engine** (lib/embedding.js): Xenova/bge-small-zh-v1.5 (quantized), 512-dim Chinese vectors, ~23MB, bundled; @huggingface/tokenizers + onnxruntime-web (WASM), local CPU, 0 token / 0 API cost;
- **Lazy load** (~0.3s first call); automatic fallback to pure-rule mode if unavailable;
- **Index cache**: per-book vectors at `.novel-writer/embedding/<book>.json` — repeated searches are instant;
- **novel_semantic_search**: natural-language search across the whole book (foreshadowing clues, emotional scenes, setting mentions) — matches by meaning even when keywords differ;
- **novel_style_check upgrade**: adds semantic similarity (target chapter vs rest of book) alongside rule-based fingerprint similarity;
- **Switch: semanticEmbedding** — default ON (probe-based: auto-enabled when the model is present); turn it off in the sidebar「写作助手功能」panel to fully return to rule-only mode.

## History (v0.3 → v1.6)
Sentence-pattern analysis; emotion purification + AI review (strong/weak lexicon, pollution caveat); emotion quantification (Valence sliding window: variance/slope/conflict + implicit imagery + complexity score); worldview/genre/theme detection (modern/western/eastern + 15 genres + 35 themes); pragmatic-style review; settings tables (5) + foreshadowing registry + summaries + continuity audit + style check; analysis cache & report export (`.novel-writer/analysis/`).

## v2.5.0: Style Portrait Report (measurement/judgment separation)
- **novel_style_report** (15th tool): aggregates 6 measurement dimensions (style fingerprint / keywords / theme / emotion quantification / 12-axis vibe / semantic style distances);
- Plugin only reports numbers, never labels — style judgment is left to the LLM; AI judgment can be saved via `aiJudgment` (stored in .novel-writer/style-reports/) and read with `action=get`;
- Vibe spectrum: 12 axes (added 文艺唯美 Aesthetic / 情欲暧昧 Sensual), rule-based conclusions removed;
- Semantic style distances: 12 style prototype sets × book vector (local embedding, 0 token).

## Size
~95MB total (23MB quantized model + 70MB runtime); zip 31MB. If disk is tight, disable the semantic switch and delete `lib/models/` + `node_modules/` to go back to rule-only.
