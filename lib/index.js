/**
 * dsh-novel-writer — 宿主端入口（v4.0.1）
 *
 * 仅保留插件协议导出（apply/inject/name）与 16 个 novel_* 工具注册；
 * 辅助函数、常量、HTTP 路由与状态读写已移至 lib/core.js（单文件体积上限要求）。
 */

import { copyFile, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { analyzeText, CATEGORY_ORDER, fingerprintSimilarity, styleDiffs } from "./analysis.js";
import { computeBaselineFromPerChapter, judgeAgainstBaseline, measureStyleMetrics, METRIC_LABELS, METRIC_ORDER } from "./style-metrics.js";
import { computeVibe, semanticStyleDistances } from "./vibe.js";
import { CULTURE_MARKERS, DEFAULT_BANNED_WORDS, SPEECH_STYLE_RULES } from "./lexicons/markers.js";
import { RAW_WRITING_PROMPT, WORKFLOW_TEXT, BRIEF_TEXT } from "./prompts.js";
import * as embedding from "./embedding.js";
import { PLUGIN_VERSION, CACHE_VERSION, VIBE_POS_PROTOTYPES, VIBE_NEG_PROTOTYPES, resolveAmbiguousCarriers, CHAPTER_EXTENSIONS, READ_LIMIT, READ_MAX_CHARS, LEADING_NUMBER, CJK_DIGITS, cjkToNumber, parseChapterNumber, normalizeChapterKey, cleanChapterTitle, CJK_STOP_CHARS, EN_STOP_WORDS, assert, requiredString, optionalString, optionalInt, sanitizeSegment, sessionCwd, resolveRoot, novelsDir, bookDir, scanChapters, readTextFile, decodeTextBuffer, chapterStats, findChapter, extractKeywords, tallyCjkRun, IMPORT_NOISE, numberToCjk, nextFreeChapterFile, bookNameFromFileName, bookNameFromContent, collectTextFiles, formatImport, SENTENCE_ANALYSIS_DEFAULTS, ALL_TOOLS, TOOL_LABELS, SORTED_MARKER_WORDS, sortedMarkerWords, scanWordHits, detectCulture, detectGenre, detectTheme, FEATURE_DEFAULTS, featureEnabled, enrichSemanticImplicit, semanticFeatureEnabled, cropEmotion, toolEnabled, assertToolEnabled, stateFilePath, styleConfigPath, readStyleEnabled, readSentenceState, readSentenceStateSync, writeQueues, atomicWriteJson, txQueues, withFileTx, stateWriteChain, clampStyleTolerance, writeSentenceState, effectiveSentenceAnalysis, isLoopbackRequest, isAllowedRequest, writeJson, BODY_TOO_LARGE, readJsonBody, openInExplorer, makeStateRoutes, EMOTION_CODE, buildBriefLine, formatSentenceAnalysis, syncCreationProfileFiles, bookStatsCache, bookStats, listBookNames, CREATION_DIR, CREATION_FILES, CREATION_TEMPLATE_TITLES, creationDir, buildCreationUserSection, upsertCreationSection, upsertCreationUserSection, buildCreationCharacterSection, createOutlineTool, novelDataDir, metricChaptersCached, bookAnalysisCached, writeBookSemanticCache, plotsFile, legacyPlotsFile, readPlots, writePlots, plotKeywords, normalizePlotEntry, settingsFile, readSettings, noteRoot, writeSettings, normalizeSettingEntry, normalizeSettingList, readBookAllText, buildStyleAnchorPackage, parseEvidenceCounts, extractTopKeywords, summariesFile, readSummaries, cleanSummaryEntry, TIME_JUMP_WORDS, detectChapterBridge, formatBooks, formatChapters, formatRead, formatKeywords, cleanOutput } from "./core.js";

const name = "novel-writer";
const inject = ["tools", "systemPrompt"];
function registerNovelImport(ctx, config) {
  ctx.tools.register({
    name: "novel_import",
    description: "批量导入原稿件：扫描文件夹自动识别书名/章号并分组，可复制/移动到 novels/<书名>/ 分类存放（scan 预览 / apply 执行）。",
    parameters: {
      type: "object",
      properties: {
        src: { type: "string", description: "待导入的原稿件文件夹路径（可含多本小说的章节文本，支持子文件夹）。" },
        mode: { type: "string", enum: ["scan", "apply"], description: "scan=只分析并返回分组建议（默认，不写盘）；apply=按分组执行导入。" },
        book: { type: "string", description: "apply 时可选：强制把所有（或 files 指定的）文件归入该书名，用于合并异名同书，或把未分类文件指定归属。" },
        files: { type: "array", items: { type: "string" }, description: "apply 时可选：只处理这些文件（相对 src 的路径）。省略则处理全部扫描到的文件。" },
        move: { type: "boolean", description: "apply 时是否移动原文件（默认 false=复制，源文件保留）。" },
        recursive: { type: "boolean", description: "是否递归扫描子文件夹。默认 true。" },
        root: { type: "string", description: "章节库根目录（含 novels 子目录）。" }
      },
      required: ["src"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          src: { type: "string" },
          mode: { type: "string" },
          groups: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                book: { type: "string" },
                from: { type: "string", enum: ["file", "content", "forced", "unclassified"] }, // v3.7.0：未分类组 from 标签（前轮漏加枚举，宿主拒绝整个工具输出）
                maybe: { type: "array", items: { type: "string" }, description: "可能同书的其他分组名（供 AI 判断是否用 book 合并）。" },
                files: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      file: { type: "string" },
                      chapter: { type: "integer" },
                      title: { type: "string" }
                    },
                    required: ["file"]
                  }
                }
              },
              required: ["book", "files"]
            }
          },
          skipped: { type: "array", items: { type: "string" } },
          imported: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                book: { type: "string" },
                file: { type: "string" },
                path: { type: "string" }
              },
              required: ["book", "file", "path"]
            }
          }
        },
        required: ["src", "mode", "groups", "skipped", "imported"]
      },
      render: (_args, value) => [{ type: "text", text: formatImport(value) }]
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_import");
      const src = requiredString(args, "src");
      const mode = args?.mode === "apply" ? "apply" : "scan";
      const forcedBook = optionalString(args, "book");
      const onlyFiles = Array.isArray(args?.files) && args.files.length > 0
        ? new Set(args.files.map((f) => String(f).replace(/\\/g, "/").replace(/^\.?\//, "")))
        : null;
      const move = args?.move === true;
      const recursive = args?.recursive !== false;
      const root = resolveRoot(config, args, exec);
      const files = await collectTextFiles(src, recursive);
      const skipped = [];
      const rows = [];
      for (const rel of files) {
        const norm = rel.replace(/\\/g, "/");
        if (onlyFiles !== null && !onlyFiles.has(norm)) continue;
        const full = join(src, rel);
        let info;
        try {
          info = await stat(full);
        } catch {
          continue;
        }
        if (!info.isFile()) continue;
        const fileName = basename(rel);
        let text = "";
        try {
          text = await readTextFile(full, exec);
        } catch {
          skipped.push(rel);
          continue;
        }
        if (text.trim() === "") {
          skipped.push(rel);
          continue;
        }
        rows.push({
          file: rel,
          chapter: parseChapterNumber(fileName),
          nameFromFile: bookNameFromFileName(fileName),
          nameFromContent: bookNameFromContent(text)
        });
      }
      // 分组：forcedBook > 文件名候选 > 内容候选 > 未分类。
      const groupMap = new Map();
      const groupFrom = new Map();
      for (const row of rows) {
        const isChapterFile = row.chapter !== void 0 || row.nameFromContent !== void 0;
        let book;
        let from;
        if (forcedBook !== void 0) {
          book = forcedBook;
          from = "forced";
        } else if (isChapterFile && row.nameFromFile !== void 0) {
          book = row.nameFromFile;
          from = "file";
        } else if (isChapterFile && row.nameFromContent !== void 0) {
          book = row.nameFromContent;
          from = "content";
        } else {
          book = "未分类";
          from = "unclassified"; // v3.7.0 ③：未分类不再标注"来自文件头内容"（误导）
        }
        if (!groupMap.has(book)) {
          groupMap.set(book, []);
          groupFrom.set(book, from);
        }
        groupMap.get(book).push(row);
      }
      const groups = [];
      for (const [book, rows2] of groupMap) {
        rows2.sort((a, b) => (a.chapter ?? Number.MAX_SAFE_INTEGER) - (b.chapter ?? Number.MAX_SAFE_INTEGER) || a.file.localeCompare(b.file));
        groups.push({
          book,
          from: groupFrom.get(book),
          files: rows2.map((r) => ({
            file: r.file,
            ...r.chapter === void 0 ? {} : { chapter: r.chapter },
            ...r.nameFromContent === void 0 ? {} : { title: r.nameFromContent }
          }))
        });
      }
      // v0.6.0：异名同书提示——组名包含关系或字符重合率高时列为"可能同书"
      for (const group of groups) {
        const maybe = [];
        for (const other of groups) {
          if (other === group || other.book === group.book) continue;
          const a = String(group.book).replace(/\s/g, "");
          const b = String(other.book).replace(/\s/g, "");
          if (a.length < 2 || b.length < 2) continue;
          const contained = a.includes(b) || b.includes(a);
          const setA = new Set(a);
          const setB = new Set(b);
          let common = 0;
          for (const ch of setA) if (setB.has(ch)) common += 1;
          const overlap = common / Math.max(setA.size, setB.size, 1);
          if (contained || overlap >= 0.6) maybe.push(other.book);
        }
        if (maybe.length > 0) group.maybe = maybe;
      }
      const imported = [];
      if (mode === "apply") {
        for (const group of groups) {
          if (group.book === "未分类") {
            // v3.9.0：未分类文件不再静默丢弃——计入 skipped 并说明原因
            for (const row of group.files) skipped.push(row.file + "（未分类，未导入——请用 book 参数指定归属书名后重试）");
            continue;
          }
          const safeBook = sanitizeSegment(group.book, "book");
          const destDir = join(novelsDir(root), safeBook);
          await mkdir(destDir, { recursive: true });
          for (const row of group.files) {
            const srcFull = join(src, row.file);
            // v3.5.0 #19：目标同名已存在 → 自动改名，不静默覆盖、move 模式不丢源
            // v3.9.0：统一按扩展名处理（.markdown/.docx 等不再丢失扩展名）；章号冲突改用空闲章号
            // v3.9.0 复查：异形同号也算占用（第一章 vs 第01章 文件名不同但章号相同 → 改名，不再产生重复章号）
            const rawName = basename(row.file);
            const rawNum = parseChapterNumber(rawName);
            let destFile = rawName;
            if (rawNum !== void 0) {
              let occupied = false;
              try {
                for (const ex of readdirSync(destDir)) {
                  if (parseChapterNumber(ex) === rawNum) { occupied = true; break; }
                }
              } catch { /* 目录不可读按重名处理 */ }
              if (occupied) destFile = nextFreeChapterFile(destDir, rawName);
            } else if (existsSync(join(destDir, rawName))) {
              destFile = nextFreeChapterFile(destDir, rawName);
            }
            const destFull = join(destDir, destFile);
            await copyFile(srcFull, destFull);
            if (move) await rm(srcFull, { force: true });
            imported.push({ book: safeBook, file: destFile, path: destFull });
          }
        }
      }
      if (mode === "apply" && imported.length > 0) await noteRoot(root); // v3.9.0：apply 导入后记录书库根
      return { src, mode, groups, skipped, imported };
    }
  });
}
function registerStyleConfigRoute(ctx, config) {
  try {
    ctx.inject(["webServer"], (wctx) => {
      const routes = makeStateRoutes(config?.allowLanState === true, config);
      wctx.effect?.(() => {
        const disposers = routes.map((route) => wctx.webServer.register(route));
        return () => {
          for (const dispose of disposers) dispose();
        };
      }, "dsh-novel-writer: state routes");
    });
  } catch {
    /* 非 cordis 环境：跳过路由，工具仍可用 */
  }
}
function registerNovelSentenceAnalysis(ctx, config) {
  ctx.tools.register({
    name: "novel_sentence_analysis",
    description: "句式模式分析：统计某部作品（或单章）的句式分布（陈述/环境/心理/对话/疑问/反问/感叹/祈使/省略留白九类）、句式排列规律（转移、高频模板、段首段尾、按章节的压缩节奏序列）、段落结构、句长分布、情感曲线、风格指纹与节奏建议，用于快速掌握作者的写作习惯、主观情感并参考其叙事节奏。受 UI 开关控制，可先用 novel_sentence_config 查看状态。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名。" },
        chapter: { type: "string", description: "可选。只分析该章节；省略则分析全书。" },
        top: { type: "integer", description: "返回的高频句式模板数量。默认 8。" },
        maxSentences: { type: "integer", description: "采样句数上限（超长文本保护，默认 20000）。" },
        curveSegments: { type: "integer", description: "情感曲线分段数（1-50，默认 20）。" },
        fresh: { type: "boolean", description: "true=强制重新分析（忽略缓存）。默认 false。" },
        brief: { type: "boolean", description: "可选。true=返回精简摘要（brief 字段）。" },
        root: { type: "string", description: "章节库根目录。" }
      },
      required: ["book"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string" },
          scope: { type: "string" },
          chapter: { type: "string" },
          enabled: { type: "boolean" },
          message: { type: "string" },
          totalChars: { type: "integer" },
          totalSentences: { type: "integer" },
          autoAnalyze: { type: "boolean" },
          categories: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string", enum: [...CATEGORY_ORDER] },
                label: { type: "string" },
                count: { type: "integer" },
                ratio: { type: "number" },
                avgLength: { type: "number" },
                examples: { type: "array", items: { type: "string" } }
              },
              required: ["type", "label", "count", "ratio", "avgLength", "examples"]
            }
          },
          transitions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                from: { type: "string" },
                to: { type: "string" },
                count: { type: "integer" }
              },
              required: ["from", "to", "count"]
            }
          },
          motifs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                pattern: { type: "string" },
                count: { type: "integer" }
              },
              required: ["pattern", "count"]
            }
          },
          paragraphs: {
            type: "object",
            additionalProperties: false,
            properties: {
              total: { type: "integer" },
              avgSentences: { type: "number" },
              opening: { type: "array", items: { type: "object", additionalProperties: false, properties: { type: { type: "string" }, count: { type: "integer" } }, required: ["type", "count"] } },
              closing: { type: "array", items: { type: "object", additionalProperties: false, properties: { type: { type: "string" }, count: { type: "integer" } }, required: ["type", "count"] } },
              dialogueOnly: { type: "integer" },
              psychologyOnly: { type: "integer" },
              mixed: { type: "integer" },
              narrationOnly: { type: "integer" }, // v4.0.0：纯叙述段数（dialogueOnly+psychologyOnly+mixed+narrationOnly===total）
              exchanges: { type: "integer" }
            },
            required: ["total", "avgSentences", "opening", "closing", "dialogueOnly", "psychologyOnly", "mixed", "exchanges"]
          },
          lengths: {
            type: "object",
            additionalProperties: false,
            properties: {
              avg: { type: "number" },
              median: { type: "number" },
              shortRatio: { type: "number" },
              mediumRatio: { type: "number" },
              longRatio: { type: "number" },
              distribution: { type: "array", items: { type: "object", additionalProperties: false, properties: { range: { type: "string" }, count: { type: "integer" } }, required: ["range", "count"] } }
            },
            required: ["avg", "median", "shortRatio", "mediumRatio", "longRatio", "distribution"]
          },
          style: {
            type: "object",
            additionalProperties: false,
            properties: {
              dialogueRatio: { type: "number" },
              psychologyRatio: { type: "number" },
              environmentRatio: { type: "number" },
              questionRatio: { type: "number" },
              exclamationRatio: { type: "number" },
              shortSentenceRatio: { type: "number" },
              longSentenceRatio: { type: "number" },
              subjectivityIndex: { type: "integer" },
              emotionDensity: { type: "number" },
              avgSentenceLength: { type: "number" },
              firstPersonDensity: { type: "number" }
            },
            required: ["dialogueRatio", "psychologyRatio", "environmentRatio", "questionRatio", "exclamationRatio", "shortSentenceRatio", "longSentenceRatio", "subjectivityIndex", "emotionDensity", "avgSentenceLength", "firstPersonDensity"]
          },
          emotion: {
            type: "object",
            additionalProperties: false,
            properties: {
              dominant: { type: "string" },
              cleanDominant: { type: "string" },
              confidence: { type: "string" },
              caveat: { type: "string" },
              aiAction: { type: "string" },
              pollution: { type: "object", additionalProperties: true },
              cleanScores: { type: "array", items: { type: "object", additionalProperties: true } },
              quantification: { type: "object", additionalProperties: true },
              scores: { type: "array", items: { type: "object", additionalProperties: false, properties: { emotion: { type: "string" }, label: { type: "string" }, count: { type: "number" }, words: { type: "array", items: { type: "string" } } }, required: ["emotion", "label", "count", "words"] } },
              intensity: { type: "number" },
              topWords: { type: "array", items: { type: "object", additionalProperties: false, properties: { word: { type: "string" }, count: { type: "integer" }, emotion: { type: "string" } }, required: ["word", "count", "emotion"] } },
              curve: { type: "array", items: { type: "object", additionalProperties: false, properties: { segment: { type: "integer" }, dominant: { type: "string" }, label: { type: "string" }, intensity: { type: "number" } }, required: ["segment", "dominant", "label", "intensity"] } }
            },
            required: ["dominant", "scores", "intensity", "topWords", "curve"]
          },
          reportFile: { type: "string" },
          // v3.2.0：精简摘要（brief 模式）
          brief: { type: "string" },
          cache: { type: "string", enum: ["hit", "miss"] },
          cachedAt: { type: "string" },
          chapterPatterns: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                chapter: { type: "string" },
                sequence: { type: "string" }
              },
              required: ["chapter", "sequence"]
            }
          },
          guidance: { type: "string" },
          fingerprint: { type: "string" },
          density: {
            type: "object",
            additionalProperties: false,
            properties: {
              actionVerbsPer1000: { type: "number" },
              actionChainRatio: { type: "number" },
              actionChainExamples: { type: "array", items: { type: "string" } },
              objectNounsPer1000: { type: "number" },
              sensePer1000: { type: "number" },
              sense: { type: "object", additionalProperties: true }
            }
          }
        },
        required: ["book", "scope", "enabled", "totalChars", "totalSentences"]
      },
      render: (_args, value) => [{ type: "text", text: formatSentenceAnalysis(value) }]
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_sentence_analysis");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const chapterArg = optionalString(args, "chapter");
      const top = optionalInt(args, "top", 1, 50, 8);
      const maxSentences = optionalInt(args, "maxSentences", 100, 100000, 20000);
      const curveSegments = optionalInt(args, "curveSegments", 1, 50, 20);
      const fresh = args?.fresh === true;
      const root = resolveRoot(config, args, exec);
      const state = await readSentenceState();
      const effective = effectiveSentenceAnalysis(config, state);
      const dir = bookDir(root, book);
      const chapters = await scanChapters(dir);
      assert(chapters.length > 0, `作品 "${book}" 下没有章节文件`);
      let selected;
      let scope;
      if (chapterArg !== void 0) {
        selected = [findChapter(chapters, chapterArg)];
        assert(selected[0] !== void 0, `在作品 "${book}" 中找不到章节 "${chapterArg}"`);
        scope = selected[0].file;
      } else {
        selected = chapters;
        scope = `全书 ${chapters.length} 章`;
      }
      // v4.0.0 修正：关闭判定上移到指纹循环之前——enabled 只依赖 config/state，
      // 旧版先对每章 open/stat/read 8KB/sha1 算完指纹再丢弃（功能关闭时全书 n 次系统调用白做）
      if (!effective.enabled) {
        return {
          book,
          scope,
          enabled: false,
          // v3.9.5 修正：补齐 output schema 必填的 totalChars(=0，非字节数)——此前缺键导致宿主校验失败且渲染“共 undefined 字”
          totalChars: 0,
          totalSentences: 0,
          message: "句式模式分析当前已关闭。可在 Web GUI 侧边栏「句式分析」面板开启，或用 novel_sentence_config 设置 enabled=true。"
        };
      }
      // v3.9.5 修正：缓存指纹改用“每章前 8KB 内容哈希 + 大小”，不再只信 stat(mtime+size)
      //（内容同大小且 mtime 未变时旧指纹不失效；命中路径仍不整章读盘，仅读前缀）
      const scopeKeyParts = [];
      for (const chapter of selected) {
        try {
          const fh = await open(join(dir, chapter.file), "r");
          try {
            const st = await fh.stat();
            const head = Buffer.alloc(Math.min(st.size, 8192));
            const { bytesRead } = await fh.read(head, 0, head.length, 0);
            scopeKeyParts.push(chapter.file + ":" + createHash("sha1").update(head.subarray(0, bytesRead)).digest("hex").slice(0, 12) + ":" + st.size);
          } finally {
            await fh.close();
          }
        } catch {
          scopeKeyParts.push(chapter.file + ":?:?");
        }
      }
      // v0.8.0：分析结果缓存 + 报告导出（书库统一数据目录 <root>/.novel-writer/analysis）
      const cacheDir = join(novelDataDir(root), "analysis");
      // v3.9.5 修正：缓存键纳入 top/maxSentences/curveSegments 与 enabled/autoAnalyze——参数不同不再命中旧结果
      const cacheKey = createHash("sha1").update(book + "|" + scope + "|" + scopeKeyParts.join(",") + "|top=" + top + "|max=" + maxSentences + "|curve=" + curveSegments + "|en=" + (effective.enabled ? 1 : 0) + "|auto=" + (effective.autoAnalyze ? 1 : 0)).digest("hex").slice(0, 20);
      const reportFile = join(cacheDir, book + "-" + cacheKey + ".json");
      let cachedHit = null;
      if (!fresh) {
        try {
          const cached = JSON.parse(await readFile(reportFile, "utf8"));
          // v3.5.0 #22：缓存带算法版本校验——升级后旧的情感/句式缓存不再命中（防双计旧结果）
          if (cached && cached.ver !== CACHE_VERSION) throw new Error("cache stale");
          cachedHit = cached;
        } catch { /* 缓存缺失/损坏，重新分析 */ }
      }
      if (cachedHit) {
        // v3.9.0 复查修正：先 enrich（缓存自带 semanticImplicit → 早退零读盘）再裁剪——emotionComplexity 关闭时也不会触发全量重读
        // v3.9.1 修复：单章分析传 scope，语义隐性情感只算本章——旧版越界缓存（全书记录）命中后会自动重算修正
        const siBefore = cachedHit?.emotion?.quantification?.semanticImplicit;
        await enrichSemanticImplicit(state, root, book, cachedHit, exec, chapterArg !== void 0 ? selected[0].file : void 0);
        // v3.9.1 修复：越界旧缓存被重算（对象被替换）→ 写回缓存，避免每次命中重复重算
        const siAfter = cachedHit?.emotion?.quantification?.semanticImplicit;
        // v3.9.5 修正：删除后同样写回（siAfter 为 undefined 时也要落盘，避免每次命中重复重算/残留）
        // v4.0.0 修正：条件改为"任一方向变化都写回"——旧版 siBefore && ... 在"缓存里原本没有
        // semanticImplicit、本次新算出"时恒假，新结果永远不落盘 → 每次命中都重跑全书索引+原型推理
        if (siBefore !== siAfter) {
          try { await atomicWriteJson(reportFile, { ...cachedHit, cachedAt: new Date().toISOString(), ver: CACHE_VERSION }); } catch { /* 缓存修正写回失败不阻塞 */ }
        }
        if (!featureEnabled(state, "emotionCaveat") && cachedHit.emotion) {
          cachedHit.emotion = cropEmotion(cachedHit.emotion);
        }
        if (!featureEnabled(state, "emotionComplexity") && cachedHit.emotion?.quantification) {
          delete cachedHit.emotion.quantification;
        }
        if (args?.brief === true && cachedHit.categories && cachedHit.lengths && cachedHit.emotion) {
          cachedHit.brief = buildBriefLine(cachedHit, scope);
        }
        // v3.5.0 H2：缓存命中剥离内部 ver 键（契约：output schema 无 ver）
        const { ver: _ver, ...rest } = cachedHit;
        // v4.0.0 修正：命中路径同样过 cleanOutput——resolveAmbiguousCarriers 新写入的 posSim/negSim
        // 可能为 -0，宿主 lossless JSON 校验会整次拒绝
        return cleanOutput({ ...rest, book, scope, cache: "hit", reportFile, cachedAt: cachedHit.cachedAt ?? new Date().toISOString() });
      }
      // 缓存未命中（或 fresh）→ 此时才读章节文本
      let text = "";
      const chapterTexts = [];
      for (const chapter of selected) {
        const chapterText = await readTextFile(join(dir, chapter.file), exec);
        text += chapterText;
        if (chapterArg === void 0) chapterTexts.push({ chapter: chapter.file, text: chapterText });
      }
      const options = { top, maxSentences, curveSegments };
      if (chapterTexts.length > 0) options.chapterTexts = chapterTexts;
      const result = {
        book,
        scope,
        enabled: true,
        autoAnalyze: effective.autoAnalyze,
        ...analyzeText(text, options)
      };
      // v2.1.0：意象歧义语义裁决（本地 embedding，词表未裁决的变色龙词 → 与正/负原型句比相似度）
      try {
        const implicit = result.emotion?.quantification?.implicit;
        if (implicit && Array.isArray(implicit.ambiguous) && implicit.ambiguous.length > 0 && semanticFeatureEnabled(state, "semanticImplicit") && (await embedding.isAvailable())) {
          const resolved = await resolveAmbiguousCarriers(implicit);
          if (resolved) result.emotion.quantification.implicit = resolved;
        }
      } catch { /* 语义裁决失败不阻塞 */ }
      // v3.9.0 复查修正：先 enrich 后写缓存——缓存文件必须含 semanticImplicit，命中路径才能早退复用（否则每次命中仍全量读盘重建索引）
      // v3.9.1 修复：单章分析传 scope，语义隐性情感只算本章（此前整书检索，把别章命中混入本章报告）
      await enrichSemanticImplicit(state, root, book, result, exec, chapterArg !== void 0 ? selected[0].file : void 0);
      try {
        await mkdir(cacheDir, { recursive: true });
        await atomicWriteJson(reportFile, { ...result, cachedAt: new Date().toISOString(), ver: CACHE_VERSION });
      } catch { /* 缓存写失败不影响结果 */ }
      if (!featureEnabled(state, "emotionCaveat") && result.emotion) {
        result.emotion = cropEmotion(result.emotion);
      }
      if (!featureEnabled(state, "emotionComplexity") && result.emotion?.quantification) {
        delete result.emotion.quantification;
      }
      if (args?.brief === true && result.categories && result.lengths && result.emotion) {
        result.brief = buildBriefLine(result, scope);
      }
      // v4.0.0 修正：本工具未过 cleanOutput，stats 里的 -0 会被宿主 lossless JSON 校验整次拒绝
      return cleanOutput({ ...result, cache: "miss", reportFile, cachedAt: new Date().toISOString() });
    }
  });
}
function registerNovelSentenceConfig(ctx, config) {
  ctx.tools.register({
    name: "novel_sentence_config",
    description: "查看或修改句式模式分析的开关状态：enabled（分析功能是否可用）、autoAnalyze（分析作品时是否主动使用）。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"], description: "get=查看；set=修改。" },
        enabled: { type: "boolean", description: "写作助手功能总开关。" },
        autoAnalyze: { type: "boolean", description: "分析作品时是否主动使用句式分析。" },
        tools: { type: "object", additionalProperties: true, description: "各工具开关（如 { novel_plot: false }），键必须是 novel_* 工具名。" },
        features: { type: "object", additionalProperties: true, description: "功能开关（emotionCaveat=情感净化预警 / genreTheme=题材与流派检测 / webnovelVibe=网文信号 / rawWriting=非净化直白模式 / semanticEmbedding=本地语义增强），如 { emotionCaveat: false }。注意：rawWriting=true 会跳过 UI 的双重确认+承诺输入流程，仅应在用户明确要求时开启。" },
        styleTolerance: { type: "object", additionalProperties: true, description: "风格基线容差（每维 { low: -20, high: 20 }，low 为负/高为正；空对象 {} 清除恢复推荐——宿主不支持 null 类型，清除一律用空对象）。" },
        creationProfile: { type: "object", additionalProperties: true, description: "原创模式设定（worldview/characters/forbidden/mainConflict/genre/extra 字符串键，留空项省略；空对象 {} 清除全部交给模型——宿主不支持 null 类型）。" },
        creationProfiles: { type: "object", additionalProperties: true, description: "按书专属原创设定（键=书名，值=同上结构；空对象 {} 清除全部书的专属设定——宿主不支持 null 类型）。" }
      },
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          enabled: { type: "boolean" },
          autoAnalyze: { type: "boolean" },
          source: { type: "string" },
          updated: { type: "boolean" },
          tools: { type: "object", additionalProperties: true, description: "各工具当前开关状态。" },
          features: { type: "object", additionalProperties: true, description: "各功能开关状态（emotionCaveat/genreTheme/emotionComplexity/semanticEmbedding）。" },
          embedding: { type: "object", additionalProperties: true, description: "语义嵌入引擎状态（available/error）。" },
          styleTolerance: { type: "object", additionalProperties: true, description: "风格基线容差（用户自定义 ±%；未设置=空对象 {}，此时使用推荐）。" },
          creationProfile: { type: "object", additionalProperties: true, description: "原创模式设定（用户在侧边栏填写的创作意图；未设置=空对象 {}）。" },
          creationProfiles: { type: "object", additionalProperties: true, description: "按书专属原创设定（键=书名，值=设定对象；未设置=空对象 {}）。" }
        },
        required: ["file", "enabled", "autoAnalyze", "tools", "features", "embedding", "styleTolerance", "creationProfile"]
      },
      render: (_args, value) => {
        const toolLines = ALL_TOOLS.map((name) => `  - ${TOOL_LABELS[name] ?? name} (${name}): ${value.tools?.[name] === false ? "关闭" : "开启"}`);
        const featLines = Object.entries(value.features ?? {}).map(([name, on]) => `  - 功能 ${name}: ${on === false ? "关闭" : "开启"}`);
        return [{
          type: "text",
          text: `<path>${value.file}</path>
<type>novel-sentence-config</type>
<content>
写作助手功能: ${value.enabled ? "已启用" : "已关闭"}
自动分析(autoAnalyze): ${value.autoAnalyze ? "开" : "关"}
来源: ${value.source}
${value.updated === true ? "(已保存到 state 文件)" : ""}

各工具开关：
${toolLines.join("\n")}

功能开关：
${featLines.join("\n")}
</content>`
        }];
      }
    },
    async execute(args) {
      await assertToolEnabled(config, "novel_sentence_config");
      const action = args?.action === "set" ? "set" : "get";
      const state = await readSentenceState();
      // v4.0.0 修正：删除未使用的 effective（下方 after 才是返回值来源）
      let updated = false;
      let current = state;
      if (action === "set") {
        const patch = {};
        if (typeof args?.enabled === "boolean") patch.enabled = args.enabled;
        if (typeof args?.autoAnalyze === "boolean") patch.autoAnalyze = args.autoAnalyze;
        if (args?.tools !== null && typeof args?.tools === "object") {
          const toolsPatch = {};
          for (const name of ALL_TOOLS) {
            if (typeof args.tools[name] === "boolean") toolsPatch[name] = args.tools[name];
          }
          // v3.5.0 M13：novel_sentence_config 禁止被关（关了自己就无法再开——死锁）
          delete toolsPatch.novel_sentence_config;
          if (Object.keys(toolsPatch).length > 0) patch.tools = toolsPatch;
        }
        if (args?.features !== null && typeof args?.features === "object") {
          const featPatch = {};
          for (const name of ["emotionCaveat", "genreTheme", "emotionComplexity", "semanticEmbedding", "semanticSearch", "semanticStyle", "semanticImplicit", "rawWriting", "webnovelVibe"]) {
            if (typeof args.features[name] === "boolean") featPatch[name] = args.features[name];
          }
          if (Object.keys(featPatch).length > 0) patch.features = featPatch;
        }
        // v3.0.0：风格基线容差（±%：允许低于/高于基线的百分比；null 清除恢复默认）
        if (args?.styleTolerance !== void 0) {
          if (args.styleTolerance === null) patch.styleTolerance = null;
          // v3.1.0：空对象 {} = 清除（DSH schema 不支持 type 数组/剥离 null，空 object 是合规的“传了但清空”）
          else if (args.styleTolerance !== null && typeof args.styleTolerance === "object" && Object.keys(args.styleTolerance).length === 0) patch.styleTolerance = null;
          else if (args.styleTolerance !== null && typeof args.styleTolerance === "object") {
            patch.styleTolerance = clampStyleTolerance(args.styleTolerance); // v3.9.0：与 POST /state 共用同一钳制
          }
        }
        // v3.1.0：原创模式设定（世界观/角色/禁忌/主线/题材/额外要求；null/空对象清除）
        if (args?.creationProfile !== void 0) {
          if (args.creationProfile === null) patch.creationProfile = null;
          else if (args.creationProfile !== null && typeof args.creationProfile === "object" && Object.keys(args.creationProfile).length === 0) patch.creationProfile = null;
          else if (args.creationProfile !== null && typeof args.creationProfile === "object") patch.creationProfile = args.creationProfile;
        }
        // v3.1.0：按书专属设定（整体替换该书条目；空对象清除全部）
        if (args?.creationProfiles !== void 0) {
          if (args.creationProfiles === null || (typeof args.creationProfiles === "object" && Object.keys(args.creationProfiles).length === 0)) patch.creationProfiles = null;
          else if (typeof args.creationProfiles === "object") patch.creationProfiles = args.creationProfiles;
        }
        if (Object.keys(patch).length > 0) {
          current = await writeSentenceState(patch);
          updated = true;
        }
      }
      const after = effectiveSentenceAnalysis(config, current);
      const styleFileOn = readStyleEnabled();
      // v4.0.0 修正：source 与生效逻辑同源——生效读的是 config.sentenceAnalysis.stylePattern，
      // 旧版判空读顶层 config.stylePattern，配了 {sentenceAnalysis:{stylePattern:true}} 仍显示"默认值"
      const source = current?.exists === true
        ? "state 文件（GUI 开关）"
        : (styleFileOn ? "v0.4.0 兼容文件 novel-writer.json" : (config?.sentenceAnalysis?.enabled !== void 0 || config?.sentenceAnalysis?.stylePattern !== void 0 || config?.stylePattern !== void 0 ? "插件 config" : "默认值"));
      const tools = {};
      for (const name of ALL_TOOLS) tools[name] = toolEnabled(current, name);
      const features = {};
      for (const name of Object.keys(FEATURE_DEFAULTS)) features[name] = featureEnabled(current, name);
      // v3.0.0：风格基线容差（±%）
      // v3.7.0：宿主不支持 null 类型——未设置输出空对象 {}（语义：使用推荐）
      const styleTolerance = current?.styleTolerance !== null && typeof current?.styleTolerance === "object" ? current.styleTolerance : {};
      // v3.1.0：原创模式设定
      const creationProfile = current?.creationProfile !== null && typeof current?.creationProfile === "object" ? current.creationProfile : {}; // v3.7.0：未设置输出空对象（宿主不支持 null）
      const creationProfiles = current?.creationProfiles !== null && typeof current?.creationProfiles === "object" ? current.creationProfiles : {};
      // v2.0.0：语义引擎状态（懒探测——不加载模型，仅文件检查 + 已加载状态）
      const embStatus = embedding.status();
      const embAvailable = featureEnabled(current, "semanticEmbedding") ? (embStatus.loaded || embStatus.modelPresent) : false;
      const embError = featureEnabled(current, "semanticEmbedding") ? embStatus.error ?? "" : "semanticEmbedding 已关闭";
      // v3.5.0 #20：工具侧清空/变更设定后同样同步创作资料 md（路由侧已有，此处补齐一致性）
      if (updated && args?.creationProfiles !== void 0) {
        const syncRoot = (typeof config?.root === "string" && config.root.length > 0) ? config.root : current.lastRoot;
        if (syncRoot) {
          try { await syncCreationProfileFiles(syncRoot, args.creationProfiles, current.creationProfiles); } catch { /* 文件同步失败不影响设定保存 */ }
        }
      }
            return { file: stateFilePath(), enabled: after.enabled, autoAnalyze: after.autoAnalyze, source, updated, tools, features, styleTolerance, creationProfile, creationProfiles, embedding: { available: embAvailable, loaded: embStatus.loaded, error: embError } };
    }
  });
}
function registerNovelStyleCheck(ctx, config) {
  ctx.tools.register({
    name: "novel_style_check",
    description: "风格自检：对比某章节与全书其他章节的风格指纹（句式分布/句长/情绪），输出相似度与偏差清单。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名。" },
        chapter: { type: "string", description: "要检查的章节（章号/文件名/标题）。" },
        root: { type: "string", description: "章节库根目录。" }
      },
      required: ["book", "chapter"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string" },
          chapter: { type: "string" },
          baselineScope: { type: "string" },
          similarity: { type: "number" },
          verdict: { type: "string", enum: ["high", "medium", "low"] },
          diffs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                dimension: { type: "string" },
                diff: { type: "number" },
                note: { type: "string" }
              },
              required: ["dimension", "diff", "note"]
            }
          },
          chapterFingerprint: { type: "string" },
          baselineFingerprint: { type: "string" },
          advice: { type: "string" },
          semantic: { type: "object", additionalProperties: true },
          // v3.0.0：文笔六维基线对照（enabled=false 时仅 note）
          metric: { type: "object", additionalProperties: true },
          // v3.8.0：跑偏时附原著锚段（对照修正用）
          fixAnchors: { type: "array", items: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, text: { type: "string" } }, required: ["label", "text"] } }
        },
        required: ["book", "chapter", "baselineScope", "similarity", "verdict", "diffs", "chapterFingerprint", "baselineFingerprint", "advice", "semantic"]
      },
      render: (_args, value) => {
        const verdictLabel = value.verdict === "high" ? "高度一致" : value.verdict === "medium" ? "大体一致" : "偏离明显";
        const lines = [`<path>novels/${value.book}</path>`, "<type>novel-style-check</type>", "<content>", ""];
        lines.push(`检查章节: ${value.chapter}`);
        lines.push(`对比基线: ${value.baselineScope}`);
        lines.push(`风格相似度: ${(value.similarity * 100).toFixed(1)}% (${verdictLabel})`);
        if (value.diffs.length === 0) {
          lines.push("偏差: 无明显偏差");
        } else {
          lines.push("偏差清单:");
          for (const d of value.diffs) lines.push(`  - ${d.dimension}: ${d.note} (${d.diff > 0 ? "+" : ""}${d.diff})`);
        }
        if (value.semantic && value.semantic.note) lines.push(`语义对比: ${value.semantic.note}` + (typeof value.semantic.similarity === "number" ? `（${(value.semantic.similarity * 100).toFixed(1)}%）` : ""));
        if (Array.isArray(value.fixAnchors) && value.fixAnchors.length > 0) {
          lines.push("", "【对照修正·原著锚段】逐句对比本章对应写法，只修跑偏部分，不得整章重写：");
          for (const a of value.fixAnchors) lines.push("  [" + a.label + "] " + a.text);
        }
        lines.push(`本章指纹: ${value.chapterFingerprint}`);
        lines.push(`基线指纹: ${value.baselineFingerprint}`);
        // v3.0.0：文笔六维基线对照
        if (value.metric && value.metric.enabled) {
          lines.push("", "文笔六维对照（μ=全书其他章基线，±%为相对偏差）：");
          for (const v of value.metric.verdicts || []) {
            const mark = v.status === "out" ? "⚠ 出带" : v.status === "warn" ? "△ 提醒" : "✓ 在带";
            lines.push(`  ${v.label}: 本章 ${v.value} vs 基线 ${v.mu}（${v.devPct > 0 ? "+" : ""}${v.devPct}%，${mark}）`);
          }
          if (value.metric.outCount > 0) lines.push("  ⚠ " + value.metric.summary + "——请对照基线修正后再续写");
        } else if (value.metric && !value.metric.enabled) {
          lines.push("", "文笔六维对照: " + (value.metric.note || "不可用"));
        }
        lines.push("", "【建议】");
        lines.push(value.advice);
        lines.push("", "</content>");
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_style_check");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const chapterArg = requiredString(args, "chapter");
      const root = resolveRoot(config, args, exec);
      const dir = bookDir(root, book);
      const state = await readSentenceState();
      const effective = effectiveSentenceAnalysis(config, state);
      assert(effective.enabled, "写作助手功能（句式模式分析）当前已关闭，可在侧边栏「写作助手功能」面板开启后再做风格自检。");
      const chapters = await scanChapters(dir);
      assert(chapters.length > 1, `book "${book}" 只有 ${chapters.length} 章，无法做风格对比（至少需要 2 章）`);
      const target = findChapter(chapters, chapterArg);
      assert(target !== void 0, `在作品 "${book}" 中找不到章节 "${chapterArg}"`);
      const others = chapters.filter((ch) => ch.file !== target.file);
      const targetText = await readTextFile(join(dir, target.file), exec);
      // v3.0.0：收集其他章逐章文本（六维基线带按章测 μ/σ）
      const baselineChapters = [];
      let baselineText = "";
      for (const ch of others) {
        const chText = await readTextFile(join(dir, ch.file), exec);
        baselineChapters.push({ file: ch.file, text: chText });
        baselineText += chText;
      }
      // v2.6.0：基线（全书除本章）分析复用缓存，大书避免重复 analyzeText
      // v4.0.0 修正：缓存文件名不再含目标章名——旧版每检查一章就在 analysis/ 留一个近似全书大小的
      // JSON（<书>__base_第NN章.md-full.json），永不清理且几乎只被同一章重复命中；改为每书一个文件，
      // 靠内容哈希 th 失效（baselineText 变了自然 miss 重算）
      const baseline = (await bookAnalysisCached(root, book + "__base", baselineText, null)).analysis;
      const chapter = analyzeText(targetText, {});
      const similarity = fingerprintSimilarity(baseline, chapter);
      // v3.8.0：偏差时附原著锚段（对照修正用，不整章重写）
      let fixAnchors = [];
      try {
        const pkgA = await buildStyleAnchorPackage(root, book, others, exec, baselineChapters); // 复用已读基线章文本
        // v4.0.0 修正：跨桶轮转取锚段——pick 顺序是 对话×2→心理×1→描写×2，旧版 slice(0,2)
        // 恒取到两条"对话"锚，心理/描写锚永远进不了 fixAnchors（跑偏维度无从对照）
        const byLabel = new Map();
        for (const a of pkgA.anchors) if (!byLabel.has(a.label)) byLabel.set(a.label, a);
        fixAnchors = [...byLabel.values()].slice(0, 3);
        if (fixAnchors.length < 3) {
          for (const a of pkgA.anchors) {
            if (fixAnchors.length >= 3) break;
            if (!fixAnchors.includes(a)) fixAnchors.push(a);
          }
        }
      } catch { /* 锚段失败不影响判定 */ }
      const diffs = styleDiffs(baseline, chapter);
      const verdict = similarity >= 0.9 ? "high" : similarity >= 0.75 ? "medium" : "low";
      let advice = "";
      if (diffs.length === 0) {
        advice = "本章与全书风格高度一致，可以放心续写。";
      } else {
        // v3.7.0 ⑦：方向全映射（原只认"偏高"，"偏长/偏低/偏短"一律输出"略少"）
      const noteMap = { "偏高": "略多", "偏低": "略少", "偏长": "略长", "偏短": "略短" };
      // v3.8.0：跑偏不整章重写——对照 fixAnchors（原著锚段）逐句修正跑偏维度
      advice = "续写风格偏差：" + diffs.slice(0, 4).map((d) => d.dimension + (noteMap[d.note] || d.note)).join("、") + "。请对照 fixAnchors 中的原著锚段，逐句对比本章对应写法，只修改跑偏的部分（句式/修饰/节奏），不要整章重写；若为情节需要（如章节情绪转折），说明原因后可接受，但不要持续漂移。";
      }
      // v2.0.0：语义级风格对比（本地 embedding，可选增强；开关开且模型可用时生效）
      let semantic = null;
      let indexSaveFailed = false; // v4.0.0：索引缓存写失败标记（catch 外也要可读）
      // v4.0.0 修正：复用上方已读的 state（同一次调用里两次 readSentenceState 可能取到不同快照）
      if (semanticFeatureEnabled(state, "semanticStyle") && (await embedding.isAvailable())) {
        try {
          const allTexts = [targetText, baselineText];
          const allChunks = [];
          for (let i = 0; i < allTexts.length; i += 1) {
            if (!allTexts[i]) continue;
            for (const p of embedding.chunkText(allTexts[i])) allChunks.push({ ...p, id: String(i) + "|" + p.id });
          }
          const styleCacheKey = book + "__style_" + String(chapterArg).replace(/[\\/:*?"<>|]/g, "_");
          // v2.5.0 修复轮 4：内容指纹失效重建——章节更新后旧缓存不再命中，避免语义对比静默失效（不靠版本号）
          // v2.6.0：增量构建——指纹变化时只对新/变化的段落做推理，其余复用旧向量
          const { items: cachedIndex, fp: cachedFp } = embedding.loadIndexMeta(root, styleCacheKey);
          const indexFp = embedding.fingerprint(allChunks);
          let index = cachedIndex;
          if (!index || index.length === 0 || cachedFp !== indexFp) {
            index = await embedding.buildIndexIncremental(allChunks, cachedIndex);
            // v4.0.0：saveIndex 失败返回 false（不再静默丢弃；第 4 个参数已废弃，由 embedding 内部重算指纹）
            indexSaveFailed = embedding.saveIndex(root, styleCacheKey, index) === false;
          }
          // 目标章段落向量 vs 其他章段落向量，平均余弦作为语义风格相似度
          // v4.0.0 修正：index 与 allChunks 同源（id 带 "0|"/"1|" 前缀），直接用前缀分类，
          // 去掉 targetChunks/baseChunks 的 some 二重过滤（大书上万段时是 10^8 级比较）
          const targetVecs = index.filter((it) => it.id.startsWith("0|"));
          const baseVecs = index.filter((it) => !it.id.startsWith("0|"));
          if (targetVecs.length > 0 && baseVecs.length > 0) {
            let sum = 0, count = 0;
            // v3.9.5 修正：基准向量等距抽样（旧实现 slice(0,20) 只覆盖全书开头约 20 段，大书结果偏置）
            const baseSample = baseVecs.length <= 20 ? baseVecs : (function () {
              const out = [];
              const step = (baseVecs.length - 1) / 19;
              for (let si = 0; si < 20; si += 1) out.push(baseVecs[Math.round(si * step)]);
              return out;
            })();
            for (const tv of targetVecs) {
              for (const bv of baseSample) { sum += embedding.cosine(tv.vec, bv.vec); count += 1; }
            }
            const semSim = count > 0 ? sum / count : 0;
            semantic = {
              similarity: Math.round(semSim * 1000) / 1000,
              note: semSim >= 0.55 ? "语义风格高度一致" : semSim >= 0.45 ? "语义风格中等一致" : "语义风格存在差异，注意写法口吻",
              enabled: true
            };
          } else {
            // v2.0.0 修复：样本不足时也返回对象（schema 要求 semantic 为 object）
            semantic = { enabled: false, note: "语义对比样本不足（目标章或基准章为空）" };
          }
        } catch (e) { semantic = { enabled: false, note: "语义对比失败：" + String(e).slice(0, 80) }; }
        // v4.0.0：索引缓存写入失败不再静默——在语义备注里追加一次提示（下次调用会重建，不阻塞本次结果）
        if (indexSaveFailed && semantic) semantic.note = (semantic.note || "") + "（语义索引缓存写入失败，下次会重建）";
      } else {
        semantic = { enabled: false, note: "语义增强未启用（纯规则模式）" };
      }
      // v3.0.0：文笔六维基线对照（新章 vs 其他章 μ/σ，支持用户容差）
      let metric = null;
      try {
        // v3.0.0：全书每章测量缓存（一个文件）→ 排除目标章后现算基线（O(n) 秒级）
        const allCh = others.map((ch) => ({ file: ch.file, text: baselineChapters.find((bc) => bc.file === ch.file)?.text ?? "" })).concat([{ file: target.file, text: targetText }]);
        const perCh = await metricChaptersCached(root, book, allCh);
        const excluding = perCh.filter((pc) => pc.file !== target.file);
        const b = { baseline: computeBaselineFromPerChapter(excluding), chapterCount: excluding.length };
        if (b.chapterCount > 0) {
          const targetMetrics = measureStyleMetrics(targetText).metrics;
          // v3.0.0：容差 = 全书推荐值（原著章节波动 1.5σ）为底，用户自定义只覆盖对应维度（未设置的维度保持全书推荐，不受排除目标章后样本少的影响）
          const allBaseline = computeBaselineFromPerChapter(perCh);
          const tol = {};
          for (const tk of METRIC_ORDER) {
            const rt = typeof allBaseline[tk]?.recTol === "number" ? allBaseline[tk].recTol : 15;
            tol[tk] = { low: -rt, high: rt };
          }
          if (state.styleTolerance && typeof state.styleTolerance === "object") {
            for (const tk of METRIC_ORDER) {
              const ut = state.styleTolerance[tk];
              if (ut && typeof ut.low === "number" && typeof ut.high === "number") tol[tk] = { low: ut.low, high: ut.high };
            }
          }
          const judge = judgeAgainstBaseline(targetMetrics, b.baseline, tol);
          metric = { enabled: true, baseline: b.baseline, metrics: targetMetrics, verdicts: judge.verdicts, outCount: judge.outCount, summary: judge.summary };
        } else metric = { enabled: false, note: "基线章节不足（至少需要 1 个其他章节）" };
      } catch (e) { metric = { enabled: false, note: "六维测量失败：" + String(e).slice(0, 80) }; }
      // v4.0.0 修正：advice 与六维判定统一口径——旧版 advice 在六维算完之前定稿，
      // 指纹无偏差但六维出带时同一份输出既说"可以放心续写"又标"⚠ 需修正"，模型很可能采纳前者
      if (metric && metric.enabled && metric.outCount > 0) {
        const outDims = (metric.verdicts || []).filter((v) => v.status === "out").map((v) => v.label).slice(0, 4).join("/");
        const dimNote = metric.summary + (outDims ? "（" + outDims + "）" : "");
        advice = diffs.length === 0
          ? "句式指纹与全书高度一致，但" + dimNote + "——请对照 fixAnchors 中的原著锚段修正出带维度后再续写。"
          : advice + "另：" + dimNote + "。";
      }
      return cleanOutput({
        book,
        chapter: target.file,
        baselineScope: others.length === 1 ? others[0].file : `全书除本章外的 ${others.length} 章`,
        similarity,
        verdict,
        diffs,
        semantic,
        metric,
        chapterFingerprint: chapter.fingerprint,
        baselineFingerprint: baseline.fingerprint,
        fixAnchors,
        advice
      });
    }
  });
}
function registerNovelStyleReport(ctx, config) {
  ctx.tools.register({
    name: "novel_style_report",
    description: "风格画像报告：聚合 6 维测量数据（指纹/词汇/题材/情感/氛围 12 轴/语义距离）供 AI 判断风格。",
    parameters: {
      type: "object",
      additionalProperties: true,
      properties: {
        book: { type: "string", description: "书名（novels 下的子目录名）" },
        root: { type: "string", description: "章节库根目录（含 novels 子目录）。" },
        action: { type: "string", description: "report=生成测量报告（默认）；get=读取已保存的 AI 风格判断" },
        brief: { type: "boolean", description: "true=返回精简摘要（一句话结论），省略=完整报告。" },
        aiJudgment: { type: "string", description: "AI 的风格气质判断结论：后插件将测量数据与判断存入 style-reports 供后续使用" }
      },
      required: ["book"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          book: { type: "string" },
          chars: { type: "integer" },
          report: { type: "string" },
          dimensions: { type: "object", additionalProperties: true },
          semantic: { type: "array", items: { type: "object", additionalProperties: true } },
          saved: { type: "object", additionalProperties: true },
          savedJudgment: { type: "string" },
          message: { type: "string" },
          // v3.9.5：声明实际返回字段（此前仅靠 additionalProperties:true 放行，模型侧契约看不到）
          baseline: { type: "object", additionalProperties: true },
          baselineChapterCount: { type: "integer" },
          brief: { type: "string" },
          anchors: { type: "array", items: { type: "object", additionalProperties: true } },
          skeletons: { type: "array", items: { type: "object", additionalProperties: true } }
        },
        required: ["book", "report"]
      },
      render: (_args, value) => {
        const lines = [value.report || ""];
        if (Array.isArray(value.anchors) && value.anchors.length > 0) {
          lines.push("", "【风格锚·原著段落（续写照样例写，数字只做事后校验）】");
          for (const a of value.anchors) lines.push("  [" + a.label + "] " + a.text);
        }
        if (Array.isArray(value.skeletons) && value.skeletons.length > 0) {
          lines.push("", "【句式骨架（按此形状造句）】");
          for (const sk of value.skeletons) lines.push("  [" + sk.type + "] " + sk.text);
        }
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_style_report");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const root = resolveRoot(config, args, exec);
      const action = args?.action === "get" ? "get" : "report";
      const reportDir = join(root, ".novel-writer", "style-reports");
      const reportFile = join(reportDir, book + ".json");
      if (action === "get") {
        try {
          const saved = JSON.parse(await readFile(reportFile, "utf8"));
          return {
            book,
            savedJudgment: saved.judgment || "",
            saved: { savedAt: saved.savedAt, chars: saved.chars, vibe: saved.vibe },
            report: "已保存的风格判断（" + (saved.savedAt || "未知时间") + "）：\n" + (saved.judgment || "（无）"),
            message: "读取已保存的 AI 风格判断"
          };
        } catch {
          return { book, report: "尚未保存该作品的风格判断。请先调用 novel_style_report 生成报告，并结合报告给出 aiJudgment 回传保存。", message: "无已保存判断" };
        }
      }
      const { text, chapters, texts } = await readBookAllText(root, book, exec, { withTexts: true });
      // v3.8.0：风格锚包（原著代表性段落 + 句式骨架——生成端照样例写，勿只依赖数字基线）
      const anchorPkg = await buildStyleAnchorPackage(root, book, chapters, exec, text); // 复用 readBookAllText 已读全文
      const featState = await readSentenceState();
      // v2.6.0：复用全书分析缓存（大书不再每次重算 analyzeText/detectCulture/流派题材）
      const analysisCache = await bookAnalysisCached(root, book, text, featState);
      const { analysis, detection } = analysisCache;
      // 语义增强：意象歧义裁决 + 隐性情感（embedding 可用时）
      try {
        const semOn = semanticFeatureEnabled(featState, "semanticImplicit");
        const embOk = semOn && (await embedding.isAvailable());
        // v4.0.0：缓存里的语义结果先挂回 analysis——enrichSemanticImplicit 命中即早退（不再重跑 29 次原型推理 + 全索引检索）
        if (semOn && analysisCache.semantic && analysis.emotion?.quantification) {
          analysis.emotion.quantification.semanticImplicit = analysisCache.semantic;
        }
        // v4.0.0：意象歧义裁决结果同样复用缓存（同一内容指纹下结果确定）——旧版每次命中都重跑 N 次上下文向量推理
        let implicitResolved = embOk ? analysisCache.implicitResolved : null;
        if (implicitResolved && analysis.emotion?.quantification) {
          analysis.emotion.quantification.implicit = implicitResolved;
        } else {
          const imp = analysis.emotion?.quantification?.implicit;
          if (imp && Array.isArray(imp.ambiguous) && imp.ambiguous.length > 0 && embOk) {
            const resolved = await resolveAmbiguousCarriers(imp);
            // 只缓存真正裁决过的结果（早退/推理失败时无 resolved 数组 → 下次重试，不写盘）
            if (resolved && Array.isArray(resolved.resolved)) {
              implicitResolved = resolved;
              analysis.emotion.quantification.implicit = resolved;
            }
          }
        }
        await enrichSemanticImplicit(featState, root, book, { emotion: analysis.emotion }, exec);
        // v4.0.0：语义结果写回全书分析缓存（含内容指纹）；功能关闭/引擎不可用时写回即清除旧语义残留
        if (analysis.emotion?.quantification) {
          const semanticNow = analysis.emotion.quantification.semanticImplicit;
          if (semanticNow !== analysisCache.semantic || implicitResolved !== analysisCache.implicitResolved) {
            await writeBookSemanticCache(analysisCache, semanticNow, implicitResolved);
          }
        }
      } catch { /* 语义增强失败不影响报告 */ }
      const result = {
        book,
        chars: text.replace(/\s/g, "").length,
        culture: detection.culture,
        confidence: detection.confidence,
        scores: detection.scores,
        evidence: detection.evidence
      };
      if (featureEnabled(featState, "genreTheme")) {
        result.genre = detection.genre;
        result.theme = detection.theme;
      }
      const emotion = analysis.emotion;
      // v3.9.5 修正：webnovelVibe 关闭时与 settings detect 语义一致（传空文本，不扫网文词信号）
      const vibe = computeVibe(result, emotion, featureEnabled(featState, "webnovelVibe") ? text : "");
      result.vibe = vibe;
      // v3.0.0：文笔六维基线带（v3.9.5：直接复用 readBookAllText 已读的逐章文本，不再二次全量读盘）
      try {
        const perCh = await metricChaptersCached(root, book, texts);
        result.baseline = computeBaselineFromPerChapter(perCh);
        result.baselineChapterCount = perCh.length;
      } catch { result.baseline = {}; result.baselineChapterCount = 0; } // v4.0.0：null 违反输出 schema {type:"object"}，宿主会拒绝整次调用
      // 语义距离（embedding 可用时）
      let semantic = [];
      try {
        if (semanticFeatureEnabled(featState, "semanticStyle") && (await embedding.isAvailable())) {
          const emb = await import("./embedding.js");
          semantic = await semanticStyleDistances(text, emb, { root, book });
        }
      } catch { /* 语义距离失败不影响报告 */ }
      // 组装报告文本
      const q = emotion.quantification || {};
      const implicit = q.implicit || {};
      const kw = extractTopKeywords(text, 8);
      const lines = [];
      lines.push("【风格画像报告】《" + book + "》");
      lines.push("");
      lines.push("一、文风指纹（怎么写）");
      lines.push("  " + (analysis.fingerprint || ""));
      lines.push("  平均句长 " + (analysis.lengths?.avg ?? "-") + " 字 | 短句 " + Math.round((analysis.lengths?.shortRatio ?? 0) * 100) + "% | 长句 " + Math.round((analysis.lengths?.longRatio ?? 0) * 100) + "% | 主观性 " + (analysis.style?.subjectivityIndex ?? "-"));
      lines.push("");
      lines.push("二、高频词汇（用什么词）");
      lines.push("  " + (kw.length > 0 ? kw.join(" / ") : "（无）"));
      lines.push("");
      lines.push("三、题材流派（写了什么）");
      lines.push("  文化基准：" + (CULTURE_MARKERS[detection.culture]?.label ?? "未知") + "（" + Math.round(detection.confidence * 100) + "%）");
      if (result.genre?.dominant) lines.push("  流派：" + result.genre.dominant);
      if (result.theme?.dominant) lines.push("  题材：" + result.theme.dominant + (result.theme.secondary ? "/" + result.theme.secondary : ""));
      // v4.0.0 修正：用 scores 全量计数（evidence 每文化只留前 8 个词，旧版"词群 N 次"被截断成偏小值）
      const wF = result.scores?.western ?? parseEvidenceCounts(result.evidence?.western || []);
      const mF = result.scores?.modern ?? parseEvidenceCounts(result.evidence?.modern || []);
      lines.push("  词群：西方" + wF + " 次 / 现代" + mF + " 次");
      lines.push("");
      lines.push("四、情感（什么心情）");
      lines.push("  表面 " + (emotion.dominant || "-") + " → 真实 " + (emotion.cleanDominant || "-") + "（置信度 " + (emotion.confidence || "-") + "）");
      lines.push("  趋势 Δ=" + (q.stats?.delta ?? 0) + " | 撕裂度 V=" + (q.stats?.variance ?? 0) + " | 矛盾 C=" + (q.stats?.conflict ?? 0));
      lines.push("  意象：负 " + Math.round((implicit.negative ?? 0) * 100) + "% / 正 " + Math.round((implicit.positive ?? 0) * 100) + "% / 歧义 " + Math.round((implicit.ambiguousRatio ?? 0) * 100) + "%");
      // v4.0.0 修正：distribution 基数最多 56 个键（原型表扩容后），按计数降序只取前 8 个再拼接，
      // 避免报告行过长；被截断时标注总类数
      const siDist = Object.entries(q.semanticImplicit?.distribution || {}).sort(function (a, b) { return (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])); });
      const siText = siDist.length > 0
        ? siDist.slice(0, 8).map(function (kv) { return kv[0] + "×" + kv[1]; }).join(" ") + (siDist.length > 8 ? " …（共 " + siDist.length + " 类）" : "")
        : "（无）";
      lines.push("  隐性情绪：" + siText);
      lines.push("");
      lines.push("五、氛围光谱（什么味道，0~1，共 12 轴）");
      // v2.6.0：按全角宽度对齐（中文名占 2 格），数字右对齐——任意终端/窗口不乱
      const displayWidth = (s) => [...s].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
      for (const ax of vibe.axes) {
        const bar = "█".repeat(Math.round(ax.score * 12)).padEnd(12, "░");
        lines.push("  " + ax.name + " ".repeat(Math.max(0, 8 - displayWidth(ax.name))) + " " + bar + " " + ax.score.toFixed(2).padStart(5));
      }
      lines.push("");
      lines.push("六、语义风格距离（embedding 测量，越接近 1 越像该类）");
      if (semantic.length > 0) {
        for (const s of semantic.slice(0, 8)) lines.push("  " + s.name + " " + s.score.toFixed(2));
        const gap = semantic.length >= 2 ? semantic[0].score - semantic[1].score : 1;
        if (gap < 0.02) lines.push("  ⚠ 判别度低：各风格原型距离接近（差距 <0.02），无明显风格归属——请结合题材/情感/氛围维度综合判断，勿直接引用该表贴标签");
      } else lines.push("  （语义引擎不可用，跳过）");
      lines.push("");
      lines.push("七、文笔六维基线带（v3.0.0，按章节测 μ±σ，原创/续写风格基线）");
      if (result.baseline && result.baselineChapterCount > 0) {
        for (const k of METRIC_ORDER) {
          const b = result.baseline[k];
          lines.push("  " + METRIC_LABELS[k] + " μ=" + b.mu + " σ=" + b.sigma + "（带 " + b.low + " ~ " + b.high + "，推荐容差 ±" + (b.recTol ?? 15) + "%）");
        }
        lines.push("  用途：新章六维应落在带内；novel_style_check 默认按推荐容差（原著章节波动 1.5σ）判定");
      } else lines.push("  （测量失败）");
      lines.push("");
      lines.push("── 以上全部为插件测量数据，不包含任何风格判断 ──");
      lines.push("【风格锚包】anchors/skeletons 字段含原著代表性段落与句式骨架——续写时照样例写，数字基线只做事后校验。");
      lines.push("请结合六个维度判断本书的风格气质、读者感受与写法特征。");
      const reportText = lines.join("\n");
      const saved = {};
      let judgment = "";
      // AI 判断回传：存盘供后续使用
      if (typeof args?.aiJudgment === "string" && args.aiJudgment.trim().length > 0) {
        judgment = args.aiJudgment.trim();
        try {
          await mkdir(reportDir, { recursive: true });
          await writeFile(reportFile, JSON.stringify({
            book,
            savedAt: new Date().toISOString(),
            chars: result.chars,
            judgment,
            fingerprint: analysis.fingerprint,
            culture: result.culture,
            genre: result.genre?.dominant ?? null,
            theme: result.theme?.dominant ?? null,
            emotion: emotion.cleanDominant ?? null,
            vibe: Object.fromEntries(vibe.axes.map((a) => [a.name, a.score])),
            semantic
          }, null, 2), "utf8");
          saved.savedAt = new Date().toISOString();
          saved.judgment = judgment;
        } catch (e) {
          saved.error = String(e).slice(0, 120);
        }
      }
      const promptLine = judgment
        ? "\n✅ 风格判断已保存：" + (saved.savedAt || "（存盘失败）")
        : "\n📌 请结合上述六个维度数据判断本书的风格气质、读者感受与写法特征，";
      // v3.9.1 修复：brief=true 时真正精简输出（此前仅附加 brief 字段、report 仍全文+锚包，未达省 token 目的）
      const briefMode = args?.brief === true;
      // v4.0.0 修正：空基线（无有效章节）只有 mu:0 且无 recTol → 旧版输出"推荐容差 undefined%"并谎报 μ=0
      if (briefMode && result.baseline && result.baselineChapterCount > 0) {
        // v3.9.1 优化：按 METRIC_ORDER 顺序输出、用中文标签（与完整报告一致）
        const dims = METRIC_ORDER.filter(function (k) { return result.baseline[k] && typeof result.baseline[k].mu === "number" && typeof result.baseline[k].recTol === "number"; });
        result.brief = "全书 " + result.chars + " 字：六维基线 μ=" + dims.map(function (k) { return METRIC_LABELS[k] + ":" + result.baseline[k].mu.toFixed(1); }).join(" ") + "；推荐容差 " + dims.map(function (k) { return result.baseline[k].recTol + "%"; }).slice(0, 3).join("/") + "…。";
      } else if (briefMode) {
        // v3.9.5 修正：基线测量失败时 brief 仍输出简报（此前会静默退回全文却声称“简报已生成”）
        result.brief = "全书 " + result.chars + " 字（六维基线测量不可用，建议用完整报告查看）。";
      }
      if (judgment) await noteRoot(root); // v3.9.0：判断保存记录书库根
      const briefReport = briefMode && result.brief
        ? "【风格画像·精简】《" + book + "》\n" + result.brief + promptLine + "\n（brief=true：完整六维/氛围/锚包请省略 brief 重新调用）"
        : "";
      return cleanOutput({
        book,
        chars: result.chars,
        brief: result.brief ?? void 0,
        // v3.0.0：文笔六维基线带（novel_style_check 对照用）
        baseline: result.baseline ?? null,
        baselineChapterCount: result.baselineChapterCount ?? 0,
        report: briefReport !== "" ? briefReport : reportText + promptLine + (judgment ? "" : "然后将判断结论通过 aiJudgment 参数回传，插件会存入 .novel-writer/style-reports/ 供后续续写参考。"),
        dimensions: briefMode ? void 0 : { fingerprint: analysis.fingerprint, culture: result.culture, genre: result.genre?.dominant, theme: result.theme?.dominant, emotion: emotion.cleanDominant, vibe: Object.fromEntries(vibe.axes.slice(0, 12).map((a) => [a.name, a.score])) },
        semantic: briefMode ? void 0 : semantic.map((s, i) => ({ ...s, discrim: i === 0 && semantic.length >= 2 ? Math.round((semantic[0].score - semantic[1].score) * 1000) / 1000 : null })),
        ...(judgment ? { saved: { savedAt: saved.savedAt, ...(saved.error ? { error: saved.error } : {}) }, savedJudgment: judgment } : {}),
        ...(briefMode ? {} : { anchors: anchorPkg.anchors, skeletons: anchorPkg.skeletons }),
        message: judgment ? (saved?.error ? "风格画像报告已生成，但判断保存失败：" + saved.error : "风格画像报告已生成，判断结果已保存") : (briefMode ? "风格画像简报已生成（精简）" : "风格画像报告已生成（仅测量数据，判断请由 AI 完成并回传保存）")
      });
    }
  });
}
function registerNovelSettings(ctx, config) {
  ctx.tools.register({
    name: "novel_settings",
    description: "设定管理（五张表：人物/地点/道具/时间线/世界观用语规范），list/add/update/delete/scan 按 category 维护，detect 自动判断文化基准。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名。" },
        category: { type: "string", enum: ["character", "location", "item", "timeline", "worldview"], description: "表类别（character/location/item/timeline/worldview；list/add/update/delete/scan 需要；detect 固定 worldview）。" },
        action: { type: "string", enum: ["list", "add", "update", "delete", "scan", "detect"], description: "list=查看；add=登记；update=修改；delete=删除；scan=扫描章节提取候选；detect=自动判断世界观文化基准（worldview 专用）。" },
        name: { type: "string", description: "条目名（人物名/地名/道具名；timeline 用 day 字段）。" },
        description: { type: "string", description: "可选：描述。" },
        traits: { type: "string", description: "character 专用：性格/外貌特征。" },
        relationships: { type: "string", description: "character 专用：人际关系。" },
        alias: { type: "array", items: { type: "string" }, description: "character 专用：别名。" },
        firstSeen: { type: "string", description: "可选：首次出现的章节。" },
        owner: { type: "string", description: "item 专用：当前持有者。" },
        status: { type: "string", description: "item 专用：状态（如 在琉璃处/已遗失）。" },
        lastSeen: { type: "string", description: "item 专用：最近出现的章节。" },
        day: { type: "string", description: "timeline 专用：时间点标识（add 时作为条目名登记；update/delete 用 name=旧标识 定位，改名时同时传 day=新标识）。" },
        event: { type: "string", description: "timeline 专用：事件。" },
        chapter: { type: "string", description: "timeline 专用：对应章节。" },
        notes: { type: "string", description: "可选：备注。" },
        basis: { type: "string", description: "worldview 专用：判断依据/文化基准说明。" },
        ritual: { type: "string", description: "worldview 专用：仪式规范（如'点烛不烧香'）。" },
        speechStyle: { type: "object", additionalProperties: true, description: "worldview 专用：说话方式规范（title 称谓/honorBad 客套禁词/ritualBadPatterns 仪式禁式/tone 语气·整体为 JSON 对象）。" },
        bannedWords: { type: "array", items: { type: "string" }, description: "worldview 专用：禁用词表（如欧式背景禁 上香/老夫）。" },
        recommended: { type: "object", additionalProperties: true, description: "worldview 专用：替代词映射（如 { \"上香\": \"点烛\" }）。" },
        root: { type: "string", description: "章节库根目录。" }
      },
      required: ["book"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string" },
          category: { type: "string" },
          action: { type: "string" },
          characters: { type: "array", items: { type: "object", additionalProperties: true } },
          locations: { type: "array", items: { type: "object", additionalProperties: true } },
          items: { type: "array", items: { type: "object", additionalProperties: true } },
          timeline: { type: "array", items: { type: "object", additionalProperties: true } },
          worldview: { type: "array", items: { type: "object", additionalProperties: true } },
          culture: { type: "string" },
          confidence: { type: "number" },
          scores: { type: "object", additionalProperties: true },
          evidence: { type: "object", additionalProperties: true },
          total: { type: "integer" },
          genre: { type: "object", additionalProperties: true },
          theme: { type: "object", additionalProperties: true },
          candidates: { type: "array", items: { type: "string" } },
          message: { type: "string" },
          vibe: { type: "object", additionalProperties: true }
        },
        required: ["book", "category", "action"]
      },
      render: (_args, value) => {
        const lines = [`<path>novels/${value.book}</path>`, "<type>novel-settings</type>", "<content>", ""];
        if (value.message) lines.push(value.message);
        const categoryLabel = { character: "人物卡", location: "地点卡", item: "道具清单", timeline: "时间线", worldview: "世界观/用语规范" }[value.category] ?? value.category;
        // v4.0.0 修正：按 category 取对应表（旧版 ?? 链因 list/scan 恒返回全部五张表而永不前进）
        const listKeyOf = { character: "characters", location: "locations", item: "items", timeline: "timeline", worldview: "worldview" }[value.category];
        const list = (listKeyOf && Array.isArray(value[listKeyOf]) ? value[listKeyOf] : null) ?? value.characters ?? value.locations ?? value.items ?? value.timeline ?? value.worldview ?? [];
        lines.push(`${categoryLabel}（${list.length} 条）：`);
        for (const e of list) {
          // v3.7.0 ⑧：无 day 不拼接 "undefined"
          const dayPart = e.day ? e.day + (e.event ? " " + e.event : "") : (e.event || "");
          const extra = [e.traits, e.description, e.relationships, e.owner, e.status, e.lastSeen, dayPart, e.basis, e.ritual, Array.isArray(e.bannedWords) ? "禁用词:" + e.bannedWords.join("/") : "", e.recommended ? "替代:" + Object.entries(e.recommended).map(([k, v]) => k + "→" + v).join("/") : ""].filter(Boolean).join(" | ");
          lines.push(`  - ${e.name}${extra ? "：" + extra : ""}${e.chapter ? "（" + e.chapter + "）" : ""}`);
        }
        if (value.culture && value.evidence) {
          lines.push(`判断结果：${value.message ?? value.culture}（西${value.scores?.western ?? 0} / 东${value.scores?.eastern ?? 0}）`);
          lines.push("证据：" + (value.evidence.western ?? []).slice(0, 5).join(" ") + " | " + (value.evidence.eastern ?? []).slice(0, 5).join(" "));
        }
        if (Array.isArray(value.candidates) && value.candidates.length > 0) {
          lines.push("", "扫描候选（供登记）：");
          for (const cand of value.candidates) lines.push("  ? " + cand);
        }
        if (value.vibe && Array.isArray(value.vibe.axes) && value.vibe.axes.length > 0) {
          lines.push("", "🎭 氛围光谱（v2.1.0）：");
          for (const ax of value.vibe.axes.slice(0, 5)) {
            const bar = "█".repeat(Math.round((ax.score ?? 0) * 12)).padEnd(12, "░");
            lines.push("  " + ax.name.padEnd(5) + " " + bar + " " + (ax.score ?? 0).toFixed(2));
          }
          if (value.vibe.conclusion) lines.push("  结论：" + value.vibe.conclusion + "（置信度 " + value.vibe.confidence + "）");
          if (value.vibe.evidence && value.vibe.evidence.length > 0) lines.push("  证据：" + value.vibe.evidence.join(" | "));
        }
        lines.push("", "</content>");
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_settings");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const isDetect = args?.action === "detect";
      const category = isDetect ? "worldview" : ["character", "location", "item", "timeline", "worldview"].includes(args?.category) ? args.category : "character";
      const action = ["add", "update", "delete", "scan", "detect"].includes(args?.action) ? args.action : "list";
      const root = resolveRoot(config, args, exec);
      // v3.9.5 修正：读-改-写事务化——并发 add/update/delete/scan 不再基于同一旧快照互相整表覆盖（丢更新）
      const settingsDataFile = settingsFile(root, book);
      return await withFileTx(settingsDataFile, async function () {
      const data = await readSettings(root, book);
      let message = "";
      const categoryLabel = { character: "人物卡", location: "地点卡", item: "道具清单", timeline: "时间线", worldview: "世界观/用语规范" }[category] ?? category;
      const listKey = { character: "characters", location: "locations", item: "items", timeline: "timeline", worldview: "worldview" }[category];
      const list = data[listKey];
      if (action === "add") {
        const name = optionalString(args, "name") ?? optionalString(args, "day");
        assert(name !== void 0, "novel_settings add 需要 name（timeline 用 day）参数");
        const entry = { name };
        // v3.7.0 ⑤：timeline 的 day 字段与 name 同步（update 双查/渲染都用 day，缺失会显示 undefined）
        if (category === "timeline") entry.day = name;
        for (const key of ["description", "traits", "relationships", "firstSeen", "owner", "status", "lastSeen", "event", "chapter", "notes", "basis", "ritual"]) {
          if (args?.[key] !== void 0) entry[key] = String(args[key]);
        }
        if (Array.isArray(args?.alias)) entry.alias = args.alias.map(String);
        if (Array.isArray(args?.bannedWords)) entry.bannedWords = args.bannedWords.map(String);
        if (args?.recommended !== void 0 && args.recommended !== null && typeof args?.recommended === "object") entry.recommended = { ...args.recommended };
        if (args?.ritual !== void 0) entry.ritual = String(args.ritual);
        if (category === "worldview") {
          // v4.0.0 修正：补 null 判断（typeof null === "object" 时旧版会写入空 speechStyle，
          // 反而跳过下方按 basis 自动推导语用规范的分支）
          if (args?.speechStyle !== void 0 && args.speechStyle !== null && typeof args?.speechStyle === "object") {
            // 显式传入的 speechStyle 优先
            entry.speechStyle = { ...args.speechStyle };
          } else {
            // v3.9.5 修正：自动语用规范改为“单一判定、一次赋值”。旧实现是两块独立逻辑：
            // 先按裸“中/东”正则把“中世纪”误判为 eastern 写入 speechStyle+ritual，
            // 第二块又按“欧/教堂”覆盖为 western，而 ritual 已写入 eastern 值 → 两字段来源分裂。
            const basisText = String(args?.basis ?? "");
            const eastHint = /中式|东方|中原|中土|古装|古风|客栈|老爷|少侠|江湖|茶楼|媒婆|太监|衙门|香客/.test(basisText);
            const westHint = /west|西方|欧式|西式|教廷|教堂|神甫|公爵|骑士|城堡|女巫|庄园|圣器|牧师|弥撒/.test(basisText);
            const detected = eastHint ? { culture: "eastern" } : westHint ? { culture: "western" } : detectCulture(basisText);
            if (detected.culture === "eastern") {
              entry.speechStyle = {
                title: SPEECH_STYLE_RULES.eastern.titleGuideline,
                honorBad: SPEECH_STYLE_RULES.eastern.honorBad,
                honorGood: { ...SPEECH_STYLE_RULES.eastern.honorGood },
                ritualBadPatterns: SPEECH_STYLE_RULES.eastern.ritualBadPatterns.map((x) => x.source),
                ritualGoodNote: SPEECH_STYLE_RULES.eastern.ritualGoodNote,
                tone: SPEECH_STYLE_RULES.eastern.toneGuideline
              };
              if (!entry.ritual) entry.ritual = SPEECH_STYLE_RULES.eastern.ritualGoodNote;
            } else if (detected.culture === "western") {
              entry.speechStyle = {
                title: SPEECH_STYLE_RULES.western.titleGuideline,
                honorBad: SPEECH_STYLE_RULES.western.honorBad,
                honorGood: { ...SPEECH_STYLE_RULES.western.honorGood },
                ritualBadPatterns: SPEECH_STYLE_RULES.western.ritualBadPatterns.map((x) => x.source),
                ritualGoodNote: SPEECH_STYLE_RULES.western.ritualGoodNote,
                tone: SPEECH_STYLE_RULES.western.toneGuideline
              };
              if (!entry.ritual) entry.ritual = SPEECH_STYLE_RULES.western.ritualGoodNote;
            }
          }
        }
        list.push(entry);
        message = `已登记 ${categoryLabel}：${name}`;
        await writeSettings(root, book, data);
        // v1.0.2：add 返回单条
        const result = { book, category, action, message };
        result[listKey] = [normalizeSettingEntry(entry)];
        return result;
      } else if (action === "update" || action === "delete") {
        const name = optionalString(args, "name") ?? optionalString(args, "day");
        assert(name !== void 0, `novel_settings ${action} 需要 name（timeline 用 day）参数`);
        // v3.5.0 M10：timeline 条目 name=day 值——update 按新 day 传时双查（name 或 day 字段）
        // v4.0.0 修正：脏条目（null/标量）守卫——旧版 e.name 在坏数据上直接 TypeError 打挂整个工具
        const index = list.findIndex((e) => e && typeof e === "object" && (e.name === name || (category === "timeline" && e.day === name)));
        assert(index !== -1, category === "timeline"
          ? `${categoryLabel}中不存在「${name}」。timeline 的定位标识是登记时的 day（add 时与 name 同值）：update/delete 请传 name=旧标识；改名时同时传 name=旧标识 与 day=新标识。`
          : `${categoryLabel}中不存在「${name}」`);
        if (action === "delete") {
          list.splice(index, 1);
          message = `已删除 ${categoryLabel}：${name}`;
        } else {
          const oldDay = category === "timeline" ? list[index].day : void 0; // v3.9.0：改名同步前记录旧 day
          for (const key of ["description", "traits", "relationships", "firstSeen", "owner", "status", "lastSeen", "event", "chapter", "notes", "basis", "ritual", "day"]) {
            if (args?.[key] !== void 0) list[index][key] = String(args[key]);
          }
          // v3.9.0：timeline 的 day 变更时同步 name（否则身份字段分裂：{name:第1天, day:第2天} 渲染/归一歧义）
          if (category === "timeline" && args?.day !== void 0) {
            // name 与旧 day 相同（add 时同步的别名）→ 跟随新 day
            if (list[index].name === oldDay) list[index].name = String(args.day);
            else if (!list[index].name) list[index].name = String(args.day);
          }
          // v3.5.0 #13：speechStyle 对象字段（update 也要支持）
          if (args?.speechStyle !== void 0 && args.speechStyle !== null && typeof args.speechStyle === "object") {
            list[index].speechStyle = { ...(list[index].speechStyle ?? {}), ...args.speechStyle };
          }
          if (Array.isArray(args?.alias)) list[index].alias = args.alias.map(String);
          if (Array.isArray(args?.bannedWords)) list[index].bannedWords = args.bannedWords.map(String);
          if (args?.recommended !== void 0 && args.recommended !== null && typeof args?.recommended === "object") list[index].recommended = { ...args.recommended };
          message = `已更新 ${categoryLabel}：${name}`;
        }
        await writeSettings(root, book, data);
        // v1.0.2：update 返回单条
        if (action === "update") {
          // v3.9.0：改名后 lastSettingName 可能已失效（name 跟随 day 变更）——直接用索引取
          const updated = list[index];
          const result = { book, category, action, message };
          result[listKey] = updated ? [normalizeSettingEntry(updated)] : [];
          return result;
        }
      } else if (action === "scan") {
        // v3.9.5 修正：scan 真正按 category 分派候选（旧实现注释承诺“道具含 owner”扫描，实际任何类别都只返回人物候选）
        const dir = bookDir(root, book);
        const chapters = await scanChapters(dir);
        let text = "";
        for (const chapter of chapters) text += await readTextFile(join(dir, chapter.file), exec);
        const known = new Set(normalizeSettingList(list).map((e) => e.name));
        const pick = (cands) => cands.filter(([n, count]) => count >= 2 && !known.has(n)).map(([n, count]) => n + "（" + count + "次）").slice(0, 15);
        let candidates = [];
        let kindLabel = "人物候选";
        if (category === "character") {
          const nameCounts = new Map();
          // v4.0.0 修正：量词改懒惰（"琉璃说道" 不再被吃成"琉璃说"）
          for (const m of text.matchAll(/([\u4e00-\u9fff]{2,3}?)(?:说|道|问|喊|叫|笑|叹|点头|摇头)/g)) {
            const n = m[1];
            // v3.5.0 #23：伪人名过滤（与 novel_keywords 一致）——代词/功能词开头的不是名字
            if (/^[他她我你它又再还这那谁]./.test(n)) continue;
            if (!["那个", "这个", "什么", "怎么", "自己", "她们", "他们", "你们", "我们"].includes(n)) {
              nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
            }
          }
          candidates = pick([...nameCounts.entries()]);
        } else if (category === "location") {
          const locCounts = new Map();
          for (const m of text.matchAll(/(?:回到|来到|走进|离开|路过|奔向|赶赴|躲进|藏进|出了|进了)([\u4e00-\u9fff]{2,5})(?=[的里中前后处。，,！？!?]|$)/g)) {
            const n = m[1];
            if (!/^(自己|他们|她们|我们|你们|这个|那个|什么)/.test(n)) locCounts.set(n, (locCounts.get(n) ?? 0) + 1);
          }
          candidates = pick([...locCounts.entries()]);
          kindLabel = "地点候选";
        } else if (category === "item") {
          const itemCounts = new Map();
          for (const m of text.matchAll(/(?:一把|一柄|一顶|一枚|一件|一块|一条|一盏|一封|一叠|几件|抓起|拿起|握紧|掏出|收好|放下)([\u4e00-\u9fff]{2,6})/g)) {
            const n = m[1];
            if (!/^(自己|他们|她们|我们|你们|这个|那个|什么|一点)/.test(n)) itemCounts.set(n, (itemCounts.get(n) ?? 0) + 1);
          }
          candidates = pick([...itemCounts.entries()]);
          kindLabel = "道具候选";
        } else {
          // timeline/worldview 不适用“正文高频词”式扫描：时间线建议用 add 登记（day 作标识），世界观用 detect
          candidates = [];
          kindLabel = category === "timeline" ? "时间线候选（建议用 add 登记时间点）" : "世界观候选（建议用 detect 自动判断）";
        }
        message = `扫描全书，提取 ${candidates.length} 个${kindLabel}`;
        const result = { book, category, action, candidates, message };
        result.characters = normalizeSettingList(data.characters);
        result.locations = normalizeSettingList(data.locations);
        result.items = normalizeSettingList(data.items);
        result.timeline = normalizeSettingList(data.timeline);
        result.worldview = normalizeSettingList(data.worldview);
        return result;
      } else if (action === "detect") {
        const dir = bookDir(root, book);
        const chapters = await scanChapters(dir);
        let text = "";
        for (const chapter of chapters) text += await readTextFile(join(dir, chapter.file), exec);
        const detection = detectCulture(text);
        const result = { book, category: "worldview", action, ...detection };
        // v1.5.0：题材/流派检测受功能开关控制（关=只输出文化基准）
        const featState = await readSentenceState();
        let genreNote = "";
        let themeNote = "";
        if (featureEnabled(featState, "genreTheme")) {
          const genre = detectGenre(text);
          const theme = detectTheme(text);
          result.genre = genre;
          result.theme = theme;
          genreNote = genre.dominant ? "｜流派：" + genre.dominant : "";
          themeNote = theme.dominant ? "｜题材：" + theme.dominant + (theme.secondary ? "/" + theme.secondary : "") : "";
        }
        result.worldview = normalizeSettingList(data.worldview);
        result.message = `自动判断：${CULTURE_MARKERS[detection.culture]?.label ?? "无法判断（词表未命中）"}（置信度 ${Math.round(detection.confidence * 100)}%）${genreNote}${themeNote}`;
        // v2.1.0：气质聚合层（氛围光谱 10 轴，纯规则加权 0 token）
        try {
          const analysis = analyzeText(text, {});
          // 语义层裁决意象歧义（受 semanticImplicit 开关与 embedding 可用性双重门控，v3.9.5 修正）
          try {
            const imp = analysis.emotion?.quantification?.implicit;
            if (imp && Array.isArray(imp.ambiguous) && imp.ambiguous.length > 0 && semanticFeatureEnabled(featState, "semanticImplicit") && (await embedding.isAvailable())) {
              analysis.emotion.quantification.implicit = await resolveAmbiguousCarriers(imp);
            }
          } catch { /* 裁决失败用规则版 */ }
          // v2.2.0：网文信号（动作/套路词群 + 题材联动 + 情感密度）受功能开关控制
          const vibeText = featureEnabled(featState, "webnovelVibe") ? text : "";
          result.vibe = computeVibe(result, analysis.emotion, vibeText);
        } catch (e) {
          result.vibe = { axes: [], top: [], conclusion: "气质聚合失败: " + String(e).slice(0, 60), confidence: 0, evidence: [] };
        }
        return result;
      }
      // v3.7.0 ⑨：total 在 list（默认）返回块——schema 契约（上轮误加进 scan 分支）
      const result = { book, category, action };
      result.total = data.characters.length + data.locations.length + data.items.length + data.timeline.length + data.worldview.length;
      result.characters = normalizeSettingList(data.characters);
      result.locations = normalizeSettingList(data.locations);
      result.items = normalizeSettingList(data.items);
      result.timeline = normalizeSettingList(data.timeline);
      result.worldview = normalizeSettingList(data.worldview);
      if (message) result.message = message;
      return result;
      });
    }
  });
}
function registerNovelSummary(ctx, config) {
  ctx.tools.register({
    name: "novel_summary",
    description: "章节摘要（模型生成、插件存储）：读摘要回忆剧情、避免重读。add/update/get/list/delete 按章节管理。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名。" },
        action: { type: "string", enum: ["list", "get", "add", "update", "delete"], description: "list=全部摘要（默认）；get=取某章；add=新增/覆盖摘要；update=修改；delete=删除。" },
        chapter: { type: "string", description: "章节标识（章号/文件名/标题）。" },
        summary: { type: "string", description: "add/update 时：本章摘要（200-500 字，覆盖剧情走向/关键事件/结尾状态）。" },
        keyEvents: { type: "array", items: { type: "string" }, description: "可选：关键事件列表。" },
        keySettings: { type: "array", items: { type: "string" }, description: "可选：本章出现的关键设定/信息。" },
        root: { type: "string", description: "章节库根目录。" }
      },
      required: ["book"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string" },
          action: { type: "string" },
          summaries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                chapter: { type: "string" },
                summary: { type: "string" },
                keyEvents: { type: "array", items: { type: "string" } },
                keySettings: { type: "array", items: { type: "string" } },
                updatedAt: { type: "string" }
              },
              required: ["chapter", "summary"]
            }
          },
          message: { type: "string" }
        },
        required: ["book", "action", "summaries"]
      },
      render: (_args, value) => {
        const lines = [`<path>novels/${value.book}</path>`, "<type>novel-summary</type>", "<content>", ""];
        if (value.message) lines.push(value.message);
        for (const s of value.summaries) {
          lines.push(`【${s.chapter}】`);
          lines.push(s.summary);
          if (Array.isArray(s.keyEvents) && s.keyEvents.length > 0) lines.push("关键事件：" + s.keyEvents.join("；"));
          if (Array.isArray(s.keySettings) && s.keySettings.length > 0) lines.push("关键设定：" + s.keySettings.join("；"));
          lines.push("");
        }
        lines.push("</content>");
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_summary");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const action = ["get", "add", "update", "delete"].includes(args?.action) ? args.action : "list";
      const root = resolveRoot(config, args, exec);
      // v3.9.5 修正：读-改-写事务化——并发 add/update/delete 不再基于同一旧快照互相整表覆盖（丢更新）
      const summaryDataFile = summariesFile(root, book);
      return await withFileTx(summaryDataFile, async function () {
      const summaries = await readSummaries(root, book);
      let message = "";
      if (action !== "list") {
        const chapterArg = optionalString(args, "chapter");
        assert(chapterArg !== void 0, `novel_summary ${action} 需要 chapter 参数`);
        // v3.7.0 ③：归一比较（存"第02章.md"后按"2"也能查到）
        const normArg = normalizeChapterKey(chapterArg);
        const index = summaries.findIndex((s) => normalizeChapterKey(s.chapter) === normArg);
        if (action === "get") {
          // v4.0.0 修正：get 与 list 共用白名单清洗（旧版透传磁盘原文，脏键会让宿主拒绝整次调用）
          const found = index !== -1 ? [summaries[index]] : [];
          return { book, action, summaries: found.map(cleanSummaryEntry).filter(Boolean) };
        }
        if (action === "delete") {
          // v3.9.5 修正：不存在时不再假报“已删除”并空写盘
          assert(index !== -1, `尚未保存 ${chapterArg} 的摘要，无需删除`);
          summaries.splice(index, 1);
          message = `已删除 ${chapterArg} 的摘要`;
        } else {
          const summary = optionalString(args, "summary");
          assert(summary !== void 0, `novel_summary ${action} 需要 summary 参数`);
          const entry = {
            chapter: normalizeChapterKey(chapterArg), // v3.7.0 ③：存归一键（2/第2章/第02章.md 同键）
            summary,
            keyEvents: Array.isArray(args?.keyEvents) ? args.keyEvents.map(String) : void 0,
            keySettings: Array.isArray(args?.keySettings) ? args.keySettings.map(String) : void 0,
            updatedAt: new Date().toISOString() // v4.0.0 修正：只在真正写入时取时间戳（旧版 list/get/delete 路径也算了但没用）
          };
          if (index !== -1) summaries[index] = entry;
          else summaries.push(entry);
          message = `已保存 ${chapterArg} 的摘要`;
        }
        await mkdir(dirname(summariesFile(root, book)), { recursive: true });
        await atomicWriteJson(summariesFile(root, book), { book, summaries });
        await noteRoot(root); // v3.9.0：summary 写操作记录书库根
        // v1.0.2：add/update 返回单条确认（不再返回全量列表）
        if (action === "add" || action === "update") {
          // v4.0.0 修正：复用 cleanSummaryEntry（与 get/list 同一套白名单）
          const single = cleanSummaryEntry(summaries[index !== -1 ? index : summaries.length - 1]);
          return { book, action, message, summaries: single ? [single] : [] };
        }
      }
            // v3.5.0 #30：按章号数值排序
      summaries.sort((a, b) => (parseChapterNumber(a.chapter) ?? 999) - (parseChapterNumber(b.chapter) ?? 999) || String(a.chapter).localeCompare(String(b.chapter)));
      const clean = summaries.map(cleanSummaryEntry).filter(Boolean);
      return { book, action, summaries: clean, ...message ? { message } : {} };
      });
    }
  });
}
function registerNovelContinuityCheck(ctx, config) {
  ctx.tools.register({
    name: "novel_continuity_check",
    description: "连贯性审计：对照设定表扫描全书，输出矛盾候选（数字口径/人物缺场/别名/重复）供修正。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名。" },
        // v3.2.0：衔接模式——检查该章 vs 上一章（时间跳变/语义距离/人物延续/钩子承接）
        chapter: { type: "string", description: "衔接检查模式：指定章节（章号/文件名/标题），对比其与上一章的开头衔接。" },
        outline: { type: "boolean", description: "大纲对照模式：对比创作资料剧情大纲方向行与正文关键词重合率，提示可能走偏。" },
        ooc: { type: "boolean", description: "OOC 哨兵模式：对比每章角色附近文本情绪值 vs 全书基线，提示偏离。" },
        root: { type: "string", description: "章节库根目录。" }
      },
      required: ["book"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string" },
          // v3.2.0：衔接/OOC/大纲对照模式返回值
          action: { type: "string" },
          chapter: { type: "string" },
          candidates: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string" },
                detail: { type: "string" },
                chapters: { type: "array", items: { type: "string" } }
              },
              required: ["type", "detail"]
            }
          },
          reportFile: { type: "string" },
          advice: { type: "string" }
        },
        required: ["book", "candidates", "advice"]
      },
      render: (_args, value) => {
        const lines = [`<path>novels/${value.book}</path>`, "<type>novel-continuity-check</type>", "<content>", ""];
        if (value.candidates.length === 0) {
          lines.push("未发现明显矛盾候选。");
        } else {
          lines.push(`矛盾候选 ${value.candidates.length} 条（供人工判断）：`);
          for (const cand of value.candidates) {
            lines.push(`  - [${cand.type}] ${cand.detail}${Array.isArray(cand.chapters) && cand.chapters.length > 0 ? "（涉及：" + cand.chapters.join("、") + "）" : ""}`);
          }
        }
        lines.push("", "【建议】" + value.advice, "", "</content>");
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_continuity_check");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const root = resolveRoot(config, args, exec);
      const dir = bookDir(root, book);
      const chapters = await scanChapters(dir);
      assert(chapters.length > 0, `作品 "${book}" 下没有章节文件`);
      // v3.9.5 修正：chapter/outline/ooc 三种哨兵模式互斥——旧实现多模式同传时静默只跑优先级最高者
      const sentinelModes = [args?.chapter !== void 0 && String(args.chapter) !== "", args?.outline === true, args?.ooc === true].filter(Boolean).length;
      assert(sentinelModes <= 1, "novel_continuity_check 的 chapter / outline / ooc 三种模式互斥：一次只能传一种，本次已拒绝（请拆分调用）");
      // v3.2.0：单章衔接检查模式
      const bridgeChapter = args?.chapter !== void 0 ? String(args.chapter) : "";
      if (bridgeChapter !== "") {
        const target = findChapter(chapters, bridgeChapter);
        assert(target !== void 0, `在作品 "${book}" 中找不到章节 "${bridgeChapter}"（可用 novel_chapters 查看章节列表）`);
        const ti = chapters.findIndex((c) => c.file === target.file);
        if (ti <= 0) return { book, action: "衔接", candidates: [], advice: "第一章无上一章可比对——衔接检查从第二章起可用。" };
        const prev = chapters[ti - 1];
        const bridge = await detectChapterBridge(root, book, prev.file, target.file, exec);
        return {
          book,
          action: "衔接",
          chapter: target.file,
          candidates: bridge,
          advice: bridge.length === 0
            ? "未发现明显衔接问题：时间线、人物延续与钩子承接均正常。"
            : "发现 " + bridge.length + " 处衔接风险点——按提示补过渡/承接后重查。"
        };
      }
      const candidates = [];
      // v3.2.0：大纲 vs 实际偏离检查
      // v4.0.0 修正：移到全书读取之前——大纲模式不用 chapterTexts，旧版先无条件读完全书再进分支，
      // 且分支内又对每章整读一遍再 slice(0,600)（同一章读两遍，第一遍纯浪费）
      if (args?.outline === true) {
        const outlinePath = join(root, "novels", "创作资料", book, "剧情大纲.md");
        try {
          const outlineText = await readTextFile(outlinePath, exec);
          const directionLines = outlineText.split("\n").filter(function (l) { return /^- \d+ /.test(l); });
          if (directionLines.length === 0) return { book, action: "大纲对照", candidates: [], advice: "创作资料大纲没有方向行——先 novel_outline chapter 补每章方向" };
          const out = [];
          for (const l of directionLines) {
            const num = parseInt(l.match(/^- (\d+)/)[1], 10);
            const direction = l.replace(/^- \d+ /, "").trim();
            if (direction.length < 4) continue;
            // v4.0.0 修正：统一用 scanChapters 的章号口径（旧版取文件名首段数字，"第1卷03章.md" 会错配）
            const ch = chapters.find(function (c) { return c.number === num; });
            if (!ch) continue;
            const text = (await readTextFile(join(dir, ch.file), exec)).slice(0, 600);
            const grams = new Set();
            for (let i = 0; i < direction.length - 1; i += 1) grams.add(direction.slice(i, i + 2));
            let hit = 0;
            for (const g of grams) if (text.includes(g)) hit += 1;
            const ratio = grams.size > 0 ? hit / grams.size : 0;
            if (ratio < 0.12) out.push({ type: "大纲·可能偏离", detail: "第 " + num + " 章方向「" + direction.slice(0, 20) + "…」与正文开头关键词重合率仅 " + Math.round(ratio * 100) + "%——该章可能偏离大纲，建议核对", chapters: [ch.file] });
          }
          return { book, action: "大纲对照", candidates: out, advice: out.length === 0 ? "各章与大纲方向基本一致。" : "发现 " + out.length + " 章可能与大纲方向偏离——逐条核对（偏离不一定是错，但要有意为之）。" };
        } catch {
          return { book, action: "大纲对照", candidates: [], advice: "该书无创作资料（novels/创作资料/<书>/剧情大纲.md）——先 novel_outline init + chapter 补大纲方向" };
        }
      }
      const settings = await readSettings(root, book);
      const chapterTexts = [];
      for (const chapter of chapters) {
        chapterTexts.push({ file: chapter.file, text: await readTextFile(join(dir, chapter.file), exec) });
      }
      // v3.2.0：角色 OOC 哨兵（情绪基线偏离）
      if (args?.ooc === true) {
        // v4.0.0 修正：复用上方已读的 settings（旧版 settings2 同一次调用里把同一文件读第二遍）；
        // 并过滤脏条目（null/缺 name 会让 c.name 抛 TypeError）
        const characters = (Array.isArray(settings.characters) ? settings.characters : []).filter(function (c) { return c && typeof c === "object" && typeof c.name === "string" && c.name.length >= 2; });
        if (characters.length === 0) return { book, action: "OOC", candidates: [], advice: "未登记角色（novel_settings character）——先登记角色才能检测情绪偏离" };
        const { valenceStats } = await import("./analysis.js");
        const per = {};
        for (const ch of chapterTexts) {
          for (const c of characters) {
            const name = c.name;
            const around = [];
            let pos = -1;
            while ((pos = ch.text.indexOf(name, pos + 1)) !== -1 && around.length < 5) {
              around.push(ch.text.slice(Math.max(0, pos - 120), pos + 120));
            }
            if (around.length === 0) continue;
            const vs = valenceStats(around.join(" "));
            (per[name] = per[name] || []).push({ file: ch.file, val: vs.meanValence ?? 0 });
          }
        }
        const out = [];
        for (const name of Object.keys(per)) {
          const list = per[name];
          if (list.length < 2) continue;
          const vals = list.map(function (x) { return x.val; });
          const mu = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
          const variance = vals.reduce(function (s, x) { return s + (x - mu) * (x - mu); }, 0) / vals.length;
          const sigma = Math.sqrt(variance) || 0.05;
          // v3.2.0：小样本（≤4 章）σ 会被离群值撑大，改用固定阈值 0.3
          const thr = list.length <= 4 ? 0.3 : 2 * sigma;
          for (const item of list) {
            if (Math.abs(item.val - mu) > thr) {
              // v4.0.0 修正：文案与阈值判定共用同一条件（旧版用 thr === 0.3 浮点相等，2σ 恰为 0.3 时贴错标签）
              out.push({ type: "OOC·情绪偏离", detail: "角色「" + name + "」在 " + item.file + " 的情绪值 " + item.val.toFixed(2) + " 偏离其全书均值 " + mu.toFixed(2) + "（阈值 " + (list.length <= 4 ? "小样本固定 0.3" : "全书 2σ") + "）——若有重大剧情触发情绪变化可忽略，否则可能 OOC", chapters: [item.file] });
            }
          }
        }
        return { book, action: "OOC", candidates: out, advice: out.length === 0 ? "登记角色情绪基线未见异常。" : "发现 " + out.length + " 处角色情绪偏离——先确认是否有剧情触发，无触发则可能 OOC。" };
      }
      // 1) 数字写法差异（亿/千万/百万 口径）
      const numberForms = new Map();
      for (const { file, text } of chapterTexts) {
        for (const m of text.matchAll(/\d+\s*(?:万亿|千万|百万|十万|[万亿千百])|[一二三四五六七八九十]{1,2}(?:万亿|千万|百万|十万|[万亿千百])/g)) {
          const form = m[0].replace(/\s/g, "");
          // 只保留"带单位"的数量表达；过滤纯数字（五十/二十九）、连词（万一）、约数（七八）
          if (!/[万亿千百]$/.test(form)) continue;
          if (/^[十百千万亿]$/.test(form)) continue;
          if (!numberForms.has(form)) numberForms.set(form, []);
          if (!numberForms.get(form).includes(file)) numberForms.get(form).push(file);
        }
      }
      if (numberForms.size >= 2) {
        // v4.0.0 修正：先归一化到数值，只对"同值不同写法"生成候选（旧版任意两两配对 → N(N-1)/2 条垃圾候选）
        const unitValue = { 万亿: 1e12, 千万: 1e7, 百万: 1e6, 十万: 1e5, 亿: 1e8, 万: 1e4, 千: 1e3, 百: 1e2, 十: 1e1 };
        const cnDigit = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
        const cnSmall = function (s) {
          if (s === "十") return 10;
          const idx = s.indexOf("十");
          if (idx === -1) return Object.prototype.hasOwnProperty.call(cnDigit, s) ? cnDigit[s] : null;
          const tens = idx === 0 ? 1 : cnDigit[s[idx - 1]];
          const ones = idx === s.length - 1 ? 0 : cnDigit[s[idx + 1]];
          if (tens === undefined || ones === undefined) return null;
          return tens * 10 + ones;
        };
        const formValue = function (form) {
          const m = /^(\d+|[零一二两三四五六七八九十]{1,2})(万亿|千万|百万|十万|[万亿千百])$/.exec(form);
          if (!m) return null;
          const unit = unitValue[m[2]];
          if (!unit) return null;
          const base = /^\d+$/.test(m[1]) ? Number(m[1]) : cnSmall(m[1]);
          return base === null ? null : base * unit;
        };
        const byValue = new Map();
        for (const [form, chs] of numberForms.entries()) {
          const v = formValue(form);
          if (v === null) continue;
          if (!byValue.has(v)) byValue.set(v, []);
          byValue.get(v).push({ form, chs });
        }
        let emitted = 0;
        for (const group of byValue.values()) {
          if (group.length < 2 || emitted >= 20) continue;
          for (let i = 0; i < group.length && emitted < 20; i += 1) {
            for (let j = i + 1; j < group.length && emitted < 20; j += 1) {
              candidates.push({ type: "数字口径", detail: "「" + group[i].form + "」与「" + group[j].form + "」指同一数量但写法不一致，请统一口径", chapters: [...new Set(group[i].chs.concat(group[j].chs))] });
              emitted += 1;
            }
          }
        }
      }
      // 2) 登记人物出现分布（缺失章节提示）
      // v4.0.0 修正：过滤脏条目（null/缺 name 时 character.name 抛 TypeError）
      for (const character of (Array.isArray(settings.characters) ? settings.characters : []).filter((c) => c && typeof c === "object" && typeof c.name === "string" && c.name !== "")) {
        const absent = chapterTexts.filter(({ file, text }) => !text.includes(character.name)).map(({ file }) => file);
        if (absent.length === chapterTexts.length) {
          // v4.0.0 修正：与"缺场"分支同口径截断（旧版把全书章节名全部塞进候选，几百章时输出/报告爆长）
          candidates.push({ type: "人物缺失", detail: `设定表人物「${character.name}」在全书章节中均未出现，请确认是否已出场`, chapters: absent.slice(0, 5) });
        } else if (absent.length > 0 && chapterTexts.length > 1) {
          candidates.push({ type: "人物缺场", detail: `设定表人物「${character.name}」未出现在 ${absent.length} 个章节中（如无出场必要可忽略）`, chapters: absent.slice(0, 5) });
        }
        if (Array.isArray(character.alias) && character.alias.length > 0) {
          const used = chapterTexts.filter(({ text }) => character.alias.some((al) => text.includes(al))).map(({ file }) => file);
          if (used.length === 0) {
            candidates.push({ type: "别名未用", detail: `人物「${character.name}」登记的别名 ${character.alias.join("、")} 在全书未出现`, chapters: [] });
          }
        }
      }
      // 3) 设定表重复条目
      for (const key of ["characters", "locations", "items"]) {
        // v4.0.0 修正：脏条目守卫（同 normalizeSettingList）
        const names = normalizeSettingList(settings[key]).map((e) => e.name);
        const dup = names.filter((n, i) => names.indexOf(n) !== i);
        if (dup.length > 0) candidates.push({ type: "设定重复", detail: `${key} 中存在重复条目：${[...new Set(dup)].join("、")}`, chapters: [] });
      }
      // v0.9.0 用语风格扫描：对照 worldview 禁用词表（无登记则用默认欧式基准）
      // v3.9.5 修正：bannedWords 与 speechStyle 各自取“最近登记且含该字段”的条目——
      // 旧逻辑 reverse().find(speechStyle) ?? [0] 会让后登记的 speechStyle 条目遮蔽先登记的 bannedWords 自定义词表
      const worldviewList = Array.isArray(settings.worldview) ? settings.worldview : [];
      // v4.0.0 修正：显式登记 bannedWords: []（"我不要任何禁用词"）与"未登记"区分开——
      // 优先取最近的非空词表，退而取显式空词表；两者都没有才走默认/检测
      const bannedEntry = worldviewList.slice().reverse().find((e) => e && Array.isArray(e.bannedWords) && e.bannedWords.length > 0)
        ?? worldviewList.slice().reverse().find((e) => e && Array.isArray(e.bannedWords));
      const speechEntry = worldviewList.slice().reverse().find((e) => e && e.speechStyle);
      const worldviewEntry = speechEntry ?? bannedEntry ?? worldviewList[0];
      // v3.7.0 ⑥：eastern/中式世界观且未配置 bannedWords 时用反向默认（禁西式词）——不再按欧式默认扫描中式词（老夫/上香被误报"与欧式不符"）
      const entryHasBanned = !!bannedEntry;
      let styleRule = entryHasBanned ? bannedEntry : DEFAULT_BANNED_WORDS;
      if (!entryHasBanned) {
        // v3.7.0 ⑥：未登记 worldview 时按正文检测文化基准（中式书不再被欧式默认词表误报老夫/上香）
        const detCulture = detectCulture(chapterTexts.map(({ text }) => text).join("\n")).culture;
        if (detCulture === "eastern" || /东方|中式|eastern|古代/i.test(String(worldviewEntry?.name ?? ""))) {
          // v4.0.0 修正：直接复用 SPEECH_STYLE_RULES.eastern——旧版硬编码复制了一份词表且不完整
          //（缺 Thank you / if you please），词表更新后会漂移
          styleRule = {
            culture: "东方/中式古代（默认）",
            bannedWords: SPEECH_STYLE_RULES.eastern.honorBad.slice(),
            recommended: { ...SPEECH_STYLE_RULES.eastern.honorGood }
          };
        } else if (detCulture === "modern") {
          // 现代都市无文化禁用词——跳过扫描
          styleRule = { culture: "现代都市（默认）", bannedWords: [], recommended: {} };
        }
      }
      // v4.0.0 修正：文案跟随实际生效的词表来源——旧版一律用 worldviewEntry.name，
      // 词表来自默认/检测时会输出"「老夫」与当前文化基准「欧式宫廷」不符"这类自相矛盾的提示
      const ruleCultureName = entryHasBanned ? (String(bannedEntry.name ?? "") || styleRule.culture) : styleRule.culture;
      const speechCultureName = (speechEntry && String(speechEntry.name ?? "")) || ruleCultureName;
      for (const word of styleRule.bannedWords) {
        const hits = chapterTexts.filter(({ text }) => text.includes(word)).map(({ file }) => file);
        if (hits.length > 0) {
          const rec = styleRule.recommended?.[word] ? `（建议改为「${styleRule.recommended[word]}」）` : "";
          candidates.push({
            type: "用语冲突",
            detail: `「${word}」×${hits.length}章 与当前文化基准「${ruleCultureName}」不符${rec}${worldviewEntry ? "" : "（未登记 worldview，使用默认基准；可用 novel_settings detect 自动判断）"}`,
            chapters: hits
          });
        }
      }
      // v1.0.0 语用扫描：词级之上盯"说话方式"（称谓/客套/仪式通配）
      const speech = worldviewEntry?.speechStyle;
      if (speech && Array.isArray(speech.honorBad)) {
        const honorHits = new Map();
        for (const { file, text } of chapterTexts) {
          for (const word of speech.honorBad) {
            if (text.includes(word)) {
              if (!honorHits.has(word)) honorHits.set(word, []);
              if (!honorHits.get(word).includes(file)) honorHits.get(word).push(file);
            }
          }
        }
        for (const [word, files] of honorHits) {
          const rec = speech.honorGood?.[word] ? `（建议改「${speech.honorGood[word]}」）` : "";
          candidates.push({ type: "语用冲突·客套", detail: `「${word}」×${files.length}章 属于「${speechCultureName}」禁用表达${rec}`, chapters: files }); // v4.0.0：标注语用规范条目名
        }
      }
      if (speech && Array.isArray(speech.ritualBadPatterns)) {
        for (const pattern of speech.ritualBadPatterns) {
          // v3.5.0 #16：用户登记的非法正则/超长模式不崩工具——编译失败或 >200 字符直接跳过
          let regex = null;
          try { if (typeof pattern === "string" && pattern.length <= 200) regex = new RegExp(pattern, "g"); } catch { regex = null; }
          if (!regex) continue;
          const ritualHits = [];
          for (const { file, text } of chapterTexts) {
            if (regex.test(text)) ritualHits.push(file);
            regex.lastIndex = 0;
          }
          if (ritualHits.length > 0) {
            candidates.push({
              type: "语用冲突·仪式",
              detail: `检测到仪式类表达（规范：${speech.ritualGoodNote || "见 worldview 设定"}）`,
              chapters: ritualHits
            });
          }
        }
      }
      if (speech && typeof speech.title === "string") {
        // v3.9.5 修正：仅当称谓规范明确把“小姐”列为禁用（如欧式“不用'小姐XXX'式称谓”）才扫描 XX小姐——
        // 旧逻辑 title 含“小姐”即扫，中式默认规范（“小姐…可用”）会被系统性误报
        if (/不用.{0,8}小姐|小姐.{0,8}(禁用|不用)|禁用.{0,8}小姐|不称.{0,6}小姐/.test(speech.title)) {
          let count = 0;
          const titleHits = [];
          for (const { file, text } of chapterTexts) {
            const m = text.match(/[A-Za-z\u4e00-\u9fff]+小姐/g);
            if (m) { count += m.length; if (!titleHits.includes(file)) titleHits.push(file); }
          }
          if (count > 0) candidates.push({ type: "语用冲突·称谓", detail: `「XX小姐」×${count} 与称谓规范不符（${speech.title}）`, chapters: titleHits });
        }
      }
      const advice = candidates.length === 0
        ? "设定表与章节基本一致。建议继续登记新章节出现的新人物/新地点。"
        : "以上为规则候选，请逐条人工判断：确认为矛盾则更新设定表（novel_settings update）或修正正文；非矛盾（如回忆/刻意缺席）可忽略。";
      // 落盘审计报告
      const auditDir = join(novelDataDir(root), "audits");
      const reportFile = join(auditDir, book + "-" + createHash("sha1").update(book + "|" + chapters.map((x) => x.file).join(",")).digest("hex").slice(0, 16) + ".json");
      try {
        await mkdir(auditDir, { recursive: true });
        await atomicWriteJson(reportFile, { book, generatedAt: new Date().toISOString(), candidates });
      } catch { /* 落盘失败不阻塞 */ }
      return { book, candidates, reportFile, advice };
    }
  });
}
function registerNovelPlot(ctx, config) {
  ctx.tools.register({
    name: "novel_plot",
    description: "伏笔/剧情线登记表：维护某部作品的伏笔与剧情钩子（open 待回收 / done 已回收）。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名。" },
        action: { type: "string", enum: ["list", "add", "update", "done", "delete", "scan"], description: "list=查看；add=登记新伏笔；update=修改；done=标记已回收；delete=删除；scan=扫描章节文本，自动更新伏笔提及章节。" },
        id: { type: "string", description: "伏笔 id（update/done/delete 时需要）。" },
        content: { type: "string", description: "add/update 时：伏笔内容描述。" },
        chapter: { type: "string", description: "可选：伏笔出现的章节。" },
        note: { type: "string", description: "可选：备注（如何回收/何时回收）。" },
        type: { type: "string", enum: ["剧情", "设定", "道具", "人物", "其他"], description: "可选：伏笔类型（add/update）。" },
        priority: { type: "string", enum: ["high", "medium", "low"], description: "可选：优先级（add/update）。" },
        relatedCharacters: { type: "array", items: { type: "string" }, description: "可选：关联人物（add/update）。" },
        locations: { type: "array", items: { type: "string" }, description: "可选：关联地点（add/update）。" },
        payoffCondition: { type: "string", description: "可选：回收条件（add/update）。" },
        root: { type: "string", description: "章节库根目录。" }
      },
      required: ["book"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string" },
          action: { type: "string" },
          entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                chapter: { type: "string" },
                note: { type: "string" },
                type: { type: "string" },
                priority: { type: "string" },
                relatedCharacters: { type: "array", items: { type: "string" } },
                locations: { type: "array", items: { type: "string" } },
                payoffCondition: { type: "string" },
                mentionedIn: { type: "array", items: { type: "string" } },
                lastMentioned: { type: "string" },
                status: { type: "string", enum: ["open", "done"] },
                createdAt: { type: "string" },
                updatedAt: { type: "string" }
              },
              required: ["id", "content", "status"]
            }
          },
          message: { type: "string" }
        },
        required: ["book", "action", "entries"]
      },
      render: (_args, value) => {
        const lines = [`<path>novels/${value.book}</path>`, "<type>novel-plot</type>", "<content>", ""];
        if (value.message) lines.push(value.message);
        const open = value.entries.filter((e) => e.status === "open");
        const done = value.entries.filter((e) => e.status === "done");
        lines.push(`未回收伏笔 ${open.length} 条：`);
        if (open.length === 0) lines.push("  （无）");
        for (const e of open) {
          const tags = [e.type, e.priority, e.chapter ? "出自 " + e.chapter : "", e.payoffCondition ? "回收:" + e.payoffCondition : "", e.lastMentioned ? "最近提及:" + e.lastMentioned : ""].filter(Boolean).join(" | ");
          lines.push(`  - [${e.id}] ${e.content}${tags ? "（" + tags + "）" : ""}${e.note ? "｜" + e.note : ""}`);
        }
        if (done.length > 0) {
          lines.push(`已回收 ${done.length} 条：`);
          for (const e of done) lines.push(`  - [${e.id}] ${e.content}`);
        }
        lines.push("", "</content>");
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_plot");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const action = ["add", "update", "done", "delete", "scan"].includes(args?.action) ? args.action : "list";
      const root = resolveRoot(config, args, exec);
      // v3.9.5 修正：读-改-写事务化——并发 add/update/done/delete 不再基于同一旧快照互相整表覆盖（丢更新）
      const plotDataFile = plotsFile(root, book);
      return await withFileTx(plotDataFile, async function () {
      let entries = await readPlots(root, book);
      let lastPlotId = void 0; // v1.0.2：add/update 单条返回用
      const now = new Date().toISOString();
      let message = "";
      if (action === "add") {
        const content = optionalString(args, "content");
        assert(content !== void 0, "novel_plot add 需要 content 参数");
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const entry = {
          id,
          content,
          chapter: optionalString(args, "chapter"),
          note: optionalString(args, "note"),
          type: ["剧情", "设定", "道具", "人物", "其他"].includes(args?.type) ? args.type : void 0,
          priority: ["high", "medium", "low"].includes(args?.priority) ? args.priority : void 0,
          relatedCharacters: Array.isArray(args?.relatedCharacters) ? args.relatedCharacters.map(String) : void 0,
          locations: Array.isArray(args?.locations) ? args.locations.map(String) : void 0,
          payoffCondition: optionalString(args, "payoffCondition"),
          status: "open",
          createdAt: now,
          updatedAt: now
        };
        entries.push(entry);
        lastPlotId = id;
        message = `已登记伏笔 #${id}`;
      } else if (action === "scan") {
        // v0.8.0：扫描章节文本，更新 open 伏笔的提及章节
        const scanChapter = optionalString(args, "chapter");
        const dir = bookDir(root, book);
        const chapters = await scanChapters(dir);
        assert(chapters.length > 0, `作品 "${book}" 下没有章节文件`);
        const targets = scanChapter !== void 0 ? [findChapter(chapters, scanChapter)] : chapters;
        assert(targets[0] !== void 0, `找不到章节 "${scanChapter}"`);
        let mentioned = 0;
        // v4.0.0 修正：plotKeywords 只依赖伏笔内容，进章循环前预计算一次——
        // 旧版放在"章 × 条目"双层循环内层，重算 章数 × open 条数 次；同时过滤脏条目（null/标量）
        const kwById = new Map();
        for (const entry of entries) {
          if (!entry || typeof entry !== "object" || entry.status !== "open") continue;
          kwById.set(entry, plotKeywords(String(entry.content ?? "")));
        }
        for (const chapter of targets) {
          const chapterText = await readTextFile(join(dir, chapter.file), exec);
          for (const entry of entries) {
            if (!entry || typeof entry !== "object" || entry.status !== "open") continue;
            const keywords = kwById.get(entry) || [];
            if (keywords.length > 0 && keywords.some((k) => chapterText.includes(k))) {
              const mentionedIn = Array.isArray(entry.mentionedIn) ? entry.mentionedIn : [];
              if (!mentionedIn.includes(chapter.file)) {
                entry.mentionedIn = mentionedIn.concat(chapter.file);
                entry.lastMentioned = chapter.file;
                entry.updatedAt = now;
                mentioned += 1;
              }
            }
          }
        }
        message = `扫描 ${targets.length} 章，更新 ${mentioned} 条伏笔的提及记录`;
      } else if (action === "update" || action === "done" || action === "delete") {
        const id = optionalString(args, "id");
        assert(id !== void 0, `novel_plot ${action} 需要 id 参数`);
        lastPlotId = id;
        // v4.0.0 修正：脏条目守卫——旧版 e.id 在坏数据（null/字符串元素）上抛 TypeError 打挂整个工具
        const index = entries.findIndex((e) => e && typeof e === "object" && e.id === id);
        assert(index !== -1, `伏笔 #${id} 不存在（可用 novel_plot 查看列表）`);
        if (action === "delete") {
          entries.splice(index, 1);
          message = `已删除伏笔 #${id}`;
        } else if (action === "done") {
          entries[index].status = "done";
          entries[index].updatedAt = now;
          message = `已标记伏笔 #${id} 为已回收`;
        } else {
          if (args?.content !== void 0) entries[index].content = String(args.content);
          if (args?.note !== void 0) entries[index].note = String(args.note);
          if (args?.chapter !== void 0) entries[index].chapter = String(args.chapter);
          if (["剧情", "设定", "道具", "人物", "其他"].includes(args?.type)) entries[index].type = args.type;
          if (["high", "medium", "low"].includes(args?.priority)) entries[index].priority = args.priority;
          if (Array.isArray(args?.relatedCharacters)) entries[index].relatedCharacters = args.relatedCharacters.map(String);
          if (Array.isArray(args?.locations)) entries[index].locations = args.locations.map(String);
          if (args?.payoffCondition !== void 0) entries[index].payoffCondition = String(args.payoffCondition);
          entries[index].updatedAt = now;
          message = `已更新伏笔 #${id}`;
        }
      }
      // v3.5.0 M8：list（只读）不写盘——读操作不做多余 I/O、只读挂载不失败
      if (action !== "list") {
        await writePlots(root, book, entries);
        try { await writeSentenceState({ lastRoot: root }); } catch { /* 记录失败不影响伏笔功能 */ }
      }
            // v3.5.0 #17：旧/手改数据缺 createdAt 兜底（undefined.localeCompare 会 TypeError）
      // v3.5.0 #17：先清洗（过滤脏条目/补默认值）再排序——排序不再碰 null
      const cleanEntries = entries.map(normalizePlotEntry).filter(Boolean);
      cleanEntries.sort((a, b) => (a.status === b.status ? String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) : a.status === "open" ? -1 : 1));
      entries = cleanEntries;
      // v1.0.2：add/update 返回单条确认
      if (action === "add" || action === "update") {
        const target = entries.find((e) => e.id === lastPlotId);
        return { book, action, entries: target ? [normalizePlotEntry(target)] : [], ...message ? { message } : {} };
      }
      return { book, action, entries: entries.map(normalizePlotEntry).filter(Boolean), ...message ? { message } : {} };
      });
    }
  });
}
function registerNovelSemanticSearch(ctx, config) {
  ctx.tools.register({
    name: "novel_semantic_search",
    description: "语义检索（本地 embedding，0 token）：自然语言检索全书语义相关段落，无关键词也能命中。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        book: { type: "string", description: "书名。" },
        query: { type: "string", description: "要检索的语义描述，如「与血统秘密相关的段落」「女主压抑克制的时刻」。自然语言越具体越好。" },
        top: { type: "integer", description: "返回条数（默认 5，最大 10）。" },
        root: { type: "string", description: "章节库根目录（含 novels 子目录）。" }
      },
      required: ["book", "query"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string" },
          query: { type: "string" },
          available: { type: "boolean" },
          cache: { type: "string", enum: ["hit", "built"] },
          indexSize: { type: "integer" },
          results: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                chapter: { type: "string" },
                text: { type: "string" },
                score: { type: "number" }
              },
              required: ["id", "chapter", "text", "score"]
            }
          },
          message: { type: "string" }
        },
        required: ["book", "query", "available", "results", "message"]
      },
      render: (_args, value) => {
        // v2.0.0 修复：DSH 要求 render 返回 content 数组（[{type:"text",text}]），字符串会导致 commit 崩溃
        const head = `《${value.book}》语义检索「${value.query}」`;
        if (!value.available) return [{ type: "text", text: head + "（不可用）\n" + (value.message ?? "") }];
        const lines = value.results.map((r) => `- [${r.score}] ${r.chapter}: ${r.text}`);
        return [{ type: "text", text: head + `（命中 ${value.results.length} 段，索引 ${value.indexSize} 段）\n` + lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_semantic_search");
      // v3.9.5 修正：参数校验移到 try 外——缺参/空参等调用错误不再被宽 catch 伪装成“语义引擎不可用”
      const book = String(args?.book ?? "");
      assert(book !== "", "novel_semantic_search 需要 book 参数");
      const query = String(args?.query ?? "");
      assert(query !== "", "novel_semantic_search 需要 query 参数");
      const top = Math.min(Math.max(Number(args?.top) || 5, 1), 10);
      const root = resolveRoot(config, args, exec);
      try {
      const state = await readSentenceState();
      if (!semanticFeatureEnabled(state, "semanticSearch")) {
        return { book, query, available: false, results: [], message: "「语义检索」已关闭：请在侧边栏「写作助手功能」→ 小模型页开启，或用 novel_sentence_config 设置 semanticSearch:true。" };
      }
      const ready = await embedding.isAvailable();
      if (!ready) {
        return { book, query, available: false, results: [], message: "语义引擎不可用：" + (embedding.engine?.error ?? "模型加载失败") + "。插件已回退纯规则模式，不影响其他功能。 【解决：确认 lib/models/ 含 bge-small-zh 模型文件；首次使用需自动加载，稍后重试】" };
      }
      const dir = bookDir(root, book);
      const chapters = await scanChapters(dir);
      const chunks = [];
      for (const chapter of chapters) {
        const text = await readTextFile(join(dir, chapter.file), exec);
        // v2.6.0：章节标记直接用文件名（同 enrichSemanticImplicit）
        for (const p of embedding.chunkText(text)) chunks.push({ ...p, id: chapter.file + "|" + p.id, chapter: chapter.file });
      }
      // v2.5.0 修复轮 4：内容指纹失效重建——章节更新后旧缓存不再命中（不靠版本号）
      // v2.6.0：增量构建——指纹变化时只对新/变化的段落做推理，其余复用旧向量
      const { items: cachedIndex, fp: cachedFp } = embedding.loadIndexMeta(root, book);
      const indexFp = embedding.fingerprint(chunks);
      let index = cachedIndex;
      let cache = "hit";
      let indexSaveFailed = false;
      if (!index || index.length === 0 || cachedFp !== indexFp) {
        index = await embedding.buildIndexIncremental(chunks, cachedIndex);
        cache = "built";
        // v4.0.0：saveIndex 失败返回 false（不再静默丢弃；第 4 个参数已废弃，由 embedding 内部重算指纹）
        indexSaveFailed = embedding.saveIndex(root, book, index) === false;
      }
      const results = await embedding.search(query, index, top);
      // v4.0.0 修正：部分段落推理失败时不再谎报"全部成功"——报出实际段数，下次增量自动补齐
      const partialNote = index.length < chunks.length ? "（部分段落失败，下次自动补齐 " + index.length + "/" + chunks.length + "）" : "";
      // v4.0.0 修正：cosine 可能产出 -0，宿主会拒绝，统一过 cleanOutput
      return cleanOutput({
        book, query, available: true, cache, indexSize: index.length,
        results: results.map((r) => ({ id: r.id, chapter: r.chapter || String(r.id).split("|")[0] || "全书", text: String(r.text || "").replace(/\r/g, "").slice(0, 200), score: Math.round(r.score * 10000) / 10000 })),
        // v3.6.0：清洗 \r（CR 分行文本摘要不出现乱码）
        message: (cache === "hit" ? "使用本地语义索引（缓存）" : "首次建索引完成，已缓存") + partialNote + (indexSaveFailed ? "；索引缓存写入失败（下次会重建）" : "")
      });
      } catch (e) {
        // v2.0.0 终极防御：任何异常只返回错误信息，绝不裸抛（防杀宿主）
        return { book: String(args?.book ?? ""), query: String(args?.query ?? ""), available: false, results: [], message: "语义检索安全降级：" + String(e).slice(0, 120) + "（不影响其他工具）" };
      }
    }
  });
}
function registerNovelBooks(ctx, config) {
  ctx.tools.register({
    name: "novel_books",
    description: "列出小说章节库中的全部作品（novels 文件夹下的子目录），含章节数与总字数。",
    parameters: {
      type: "object",
      properties: {
        root: { type: "string", description: "章节库根目录（含 novels 子目录）。" }
      },
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          root: { type: "string" },
          books: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                chapters: { type: "integer" },
                chars: { type: "integer" }
              },
              required: ["name", "chapters", "chars"]
            }
          }
        },
        required: ["root", "books"]
      },
      render: (_args, value) => [{
        type: "text",
        text: formatBooks(value)
      }]
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_books");
      const root = resolveRoot(config, args, exec);
      const dir = novelsDir(root);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return { root, books: [] };
      }
      const books = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // v3.5.0 #27：点号目录（.git/备份）不算作品
        if (entry.name.startsWith(".")) continue;
        // v3.1.0：粗大纲/创作资料目录（novels/创作资料/<书>/）不算作品
        if (entry.name === "创作资料") continue;
        const bookPath = join(dir, entry.name);
        let chapters;
        try {
          chapters = await scanChapters(bookPath);
        } catch {
          continue;
        }
        let chars = 0;
        for (const chapter of chapters) {
          try {
            chars += (await chapterStats(bookPath, chapter, exec)).chars;
          } catch { /* 跳过无法统计的章节 */ }
        }
        books.push({ name: entry.name, chapters: chapters.length, chars });
      }
      books.sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));
      return { root, books };
    }
  });
}
function registerNovelChapters(ctx, config) {
  ctx.tools.register({
    name: "novel_chapters",
    description: "列出某部作品的全部章节：章号、标题、字数、行数、更新时间。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名（novels 下的子目录名）。" },
        root: { type: "string", description: "章节库根目录。" }
      },
      required: ["book"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string" },
          chapters: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                file: { type: "string" },
                number: { type: "integer" },
                title: { type: "string" },
                chars: { type: "integer" },
                lines: { type: "integer" },
                updated: { type: "string" }
              },
              required: ["file", "title", "chars", "lines", "updated"]
            }
          }
        },
        required: ["book", "chapters"]
      },
      render: (_args, value) => [{
        type: "text",
        text: formatChapters(value)
      }]
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_chapters");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const root = resolveRoot(config, args, exec);
      const dir = bookDir(root, book);
      const chapters = await scanChapters(dir);
      const result = [];
      for (const chapter of chapters) {
        const stats = await chapterStats(dir, chapter, exec);
        result.push({
          file: chapter.file,
          ...chapter.number === void 0 ? {} : { number: chapter.number },
          title: chapter.title,
          chars: stats.chars,
          lines: stats.lines,
          updated: stats.updated
        });
      }
      return { book, chapters: result };
    }
  });
}
function registerNovelRead(ctx, config) {
  ctx.tools.register({
    name: "novel_read",
    description: "阅读某部作品的某个章节，返回带行号的正文（含字数统计）。可用 offset/limit 分段读取长章节。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名。" },
        chapter: { type: "string", description: "章节标识：章号（如 1 或 01）、文件名（第01章.md）或标题子串。" },
        offset: { type: "integer", description: "起始行号，从 1 开始。默认 1。" },
        limit: { type: "integer", description: `最多返回行数。默认 ${READ_LIMIT}。` },
        root: { type: "string", description: "章节库根目录。" }
      },
      required: ["book", "chapter"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string" },
          chapter: { type: "string" },
          file: { type: "string" },
          path: { type: "string" },
          offset: { type: "integer" },
          totalLines: { type: "integer" },
          chars: { type: "integer" },
          truncated: { type: "boolean" },
          lines: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                number: { type: "integer" },
                text: { type: "string" }
              },
              required: ["number", "text"]
            }
          }
        },
        required: ["book", "chapter", "file", "path", "offset", "totalLines", "chars", "truncated", "lines"]
      },
      render: (_args, value) => [{
        type: "text",
        text: formatRead(value)
      }]
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_read");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const chapterArg = requiredString(args, "chapter");
      const offset = optionalInt(args, "offset", 1, Number.MAX_SAFE_INTEGER, 1);
      const limit = optionalInt(args, "limit", 1, READ_LIMIT, READ_LIMIT);
      const root = resolveRoot(config, args, exec);
      const dir = bookDir(root, book);
      const chapters = await scanChapters(dir);
      const chapter = findChapter(chapters, chapterArg);
      assert(chapter !== void 0, `在作品 "${book}" 中找不到章节 "${chapterArg}"（可用 novel_chapters 查看章节列表）`);
      const filePath = join(dir, chapter.file);
      const text = await readTextFile(filePath, exec);
      const allLines = text.split(/\r?\n/);
      const totalLines = allLines.length;
      // v4.0.0 修正：删除恒假的 totalLines === 0 分支（split 至少返回 1 个元素，空文件也得到 [""]）
      assert(offset <= totalLines, `offset ${offset} 超出范围（"${chapter.file}" 共 ${totalLines} 行）`);
      let chars = 0;
      const lines = [];
      let hitCharCap = false;
      for (let i = offset - 1; i < allLines.length && lines.length < limit; i += 1) {
        // v3.5.0 #11：单行超长裁剪（防首行超长绕过上限）
        let line = allLines[i];
        if (line.length > 3000) line = line.slice(0, 3000) + "…（行过长已裁剪）";
        // v3.9.0：先判断后累加——截断行不计入；换行只算「与上一已返回行之间」的（与 lines.join("\n") 口径一致，截断在中间时末尾换行不再多算）
        const addChars = line.length + (lines.length > 0 ? 1 : 0);
        if (chars + addChars > READ_MAX_CHARS && lines.length > 0) {
          hitCharCap = true;
          break;
        }
        chars += addChars;
        lines.push({ number: i + 1, text: line });
      }
      // v3.5.0 #10：truncated 真实判定——字符上限/行数上限/未到文件尾任一即截断
      const truncated = hitCharCap || (offset - 1 + lines.length) < totalLines;
      return {
        book,
        chapter: chapter.file,
        file: chapter.file,
        path: filePath,
        offset,
        totalLines,
        chars,
        truncated,
        lines
      };
    }
  });
}
function registerNovelKeywords(ctx, config) {
  ctx.tools.register({
    name: "novel_keywords",
    description: "统计某部作品（或单个章节）中出现频率较高的关键词：中文相邻二字/三字词组与英文词（novel_keywords 输出不含单字）。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名。" },
        chapter: { type: "string", description: "可选。只统计该章节；省略则统计全书。" },
        top: { type: "integer", description: "返回的关键词数量。默认 20。" },
        root: { type: "string", description: "章节库根目录。" }
      },
      required: ["book"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string" },
          scope: { type: "string" },
          totalChars: { type: "integer" },
          keywords: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                word: { type: "string" },
                count: { type: "integer" },
                kind: { type: "string", enum: ["cjk-bigram", "cjk-trigram", "name-candidate", "word"] }
              },
              required: ["word", "count", "kind"]
            }
          },
          reportFile: { type: "string" }
        },
        required: ["book", "scope", "totalChars", "keywords"]
      },
      render: (_args, value) => [{
        type: "text",
        text: formatKeywords(value)
      }]
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_keywords");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const chapterArg = optionalString(args, "chapter");
      const top = optionalInt(args, "top", 1, 100, 20);
      const root = resolveRoot(config, args, exec);
      const dir = bookDir(root, book);
      const chapters = await scanChapters(dir);
      assert(chapters.length > 0, `作品 "${book}" 下没有章节文件`);
      let selected;
      let scope;
      if (chapterArg !== void 0) {
        selected = [findChapter(chapters, chapterArg)];
        assert(selected[0] !== void 0, `在作品 "${book}" 中找不到章节 "${chapterArg}"`);
        scope = selected[0].file;
      } else {
        selected = chapters;
        scope = `全书 ${chapters.length} 章`;
      }
      let text = "";
      let totalChars = 0;
      for (const chapter of selected) {
        const chapterText = await readTextFile(join(dir, chapter.file), exec);
        totalChars += chapterText.length;
        // v4.0.0 修正：章节之间加分隔符——旧版直接首尾相接，上一章末尾与下一章开头会被当成
        // 相邻二字/三字组统计，产出正文里根本不存在的"词"（totalChars 仍按各章实际字数累加）
        text += (text === "" ? "" : "\n\n") + chapterText;
      }
      const result = {
        book,
        scope,
        totalChars,
        keywords: extractKeywords(text, top)
      };
      // v0.8.0：关键词结果落盘到书库统一数据目录（与设定同文件夹）
      try {
        const reportDir = join(novelDataDir(root), "analysis");
        // v4.0.0 修正：报告文件名指纹改用内容哈希——旧版只用 text.length，同长度改稿会静默覆盖旧报告
        const reportFile = join(reportDir, book + "-keywords-" + createHash("sha1").update(book + "|" + scope + "|" + text).digest("hex").slice(0, 12) + ".json");
        await mkdir(reportDir, { recursive: true });
        await atomicWriteJson(reportFile, { ...result, generatedAt: new Date().toISOString(), ver: CACHE_VERSION });
        result.reportFile = reportFile;
      } catch { /* 落盘失败不阻塞 */ }
      return result;
    }
  });
}
function registerNovelOutline(ctx, config) {
  ctx.tools.register(createOutlineTool(config));
}
function registerNovelNewChapter(ctx, config) {
  ctx.tools.register({
    name: "novel_new_chapter",
    description: "为某部作品创建新章节文件（默认自动取下一个章号）。可指定标题与初始正文。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名。" },
        chapter: { type: "integer", description: "可选。显式指定章号；省略则取现有最大章号 + 1。" },
        title: { type: "string", description: "可选。章节标题，会写入 Markdown 一级标题。" },
        content: { type: "string", description: "可选。章节初始正文。" },
        root: { type: "string", description: "章节库根目录。" }
      },
      required: ["book"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string" },
          number: { type: "integer" },
          file: { type: "string" },
          path: { type: "string" },
          chars: { type: "integer" },
          // v3.7.0：强制风格基线——创建章节时自动附全书六维基线摘要（模型动笔前必得数据）
          baseline: { type: "string" },
          reminder: { type: "string" },
          // v3.8.0：风格锚包——原著代表性段落 + 句式骨架（照样例写，数字只做校验）
          anchors: { type: "array", items: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, text: { type: "string" } }, required: ["label", "text"] } },
          skeletons: { type: "array", items: { type: "object", additionalProperties: false, properties: { type: { type: "string" }, text: { type: "string" } }, required: ["type", "text"] } }
        },
        required: ["book", "number", "file", "path", "chars"]
      },
      render: (_args, value) => {
        const lines = [`<path>${value.path}</path>`, "<type>novel-chapter-created</type>", "<content>", `已创建 第${String(value.number).padStart(2, "0")}章（${value.chars} 字）`];
        if (value.baseline) { lines.push("", "【风格基线 μ】" + value.baseline); }
        if (Array.isArray(value.anchors) && value.anchors.length > 0) {
          lines.push("", "【风格锚·原著段落】动笔照此味道写（数字基线只做事后校验）：");
          for (const a of value.anchors) lines.push("  [" + a.label + "] " + a.text);
        }
        if (Array.isArray(value.skeletons) && value.skeletons.length > 0) {
          lines.push("", "【句式骨架】按此形状造句：");
          for (const sk of value.skeletons) lines.push("  [" + sk.type + "] " + sk.text);
        }
        if (value.reminder) lines.push("", value.reminder);
        lines.push("</content>");
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_new_chapter");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const explicit = optionalInt(args, "chapter", 1, 99999, void 0);
      const title = optionalString(args, "title");
      const content = optionalString(args, "content");
      const root = resolveRoot(config, args, exec);
      const dir = bookDir(root, book);
      await mkdir(dir, { recursive: true });
      let chapters = [];
      try {
        chapters = await scanChapters(dir);
      } catch { /* 空目录 */ }
      let number = explicit;
      if (number === void 0) {
        const maxNumber = chapters.reduce((max, c) => c.number !== void 0 ? Math.max(max, c.number) : max, 0);
        number = maxNumber + 1;
      }
      const fileName = `第${String(number).padStart(2, "0")}章.md`;
      const filePath = join(dir, fileName);
      // v3.5.0 #2/M14：防覆盖——章号归一化查重（第1章/第一章/第01章 视为同号，避免同号重复章并存）
      // v4.0.0 修正：复用上方已扫描的 chapters——目录刚 mkdir，重扫一次纯冗余，且第二次不在 try 内会抛裸 ENOENT
      const sameNo = chapters.find(function (c) { return (c.number ?? -1) === number; });
      if (sameNo) {
        throw new Error(`第 ${number} 章已存在（${sameNo.file}）——不会覆盖旧稿；如需更新请先确认或使用其他章号`);
      }
      const parts = [];
      if (title !== void 0) parts.push(`# ${title}`, "");
      if (content !== void 0) parts.push(content, "");
      const text = parts.join("\n");
      try {
        // v3.9.5 修正：wx(O_EXCL) 原子写入——查重-写入非原子，并发同号创建不再静默互相覆盖
        await writeFile(filePath, text, { encoding: "utf8", flag: "wx", signal: exec.signal });
      } catch (e) {
        if (e && e.code === "EEXIST") {
          throw new Error(`第 ${number} 章刚被并发创建（${fileName}），本次写入已放弃；请重试或指定其他章号`);
        }
        throw e;
      }
      // v3.7.0：强制风格基线——创建章节时自动计算全书六维基线附在返回中（即使模型没先调 novel_style_report，也能拿到基线）
      let baselineLine = "";
      let anchorPkg = { anchors: [], skeletons: [] };
      let bTexts = [];
      let anchorTexts = [];
      try {
        const allChs = await scanChapters(dir);
        for (const ch of allChs) {
          // v4.0.0 修正：测量集合纳入新章——与 style_report 的"全章集合"一致，顺序无关的指纹才能互相命中
          //（旧版排除新章，缓存键与 style_report/style_check 都不同，三者交替调用全部 miss）
          const chText = ch.file === fileName ? text : await readTextFile(join(dir, ch.file), exec);
          bTexts.push({ file: ch.file, text: chText });
          // 锚包仍只用既有章节（新章是刚创建的稿子，不能当"原著样例"）
          if (ch.file !== fileName) anchorTexts.push({ file: ch.file, text: chText });
        }
        if (bTexts.length > 0) {
          const perCh = await metricChaptersCached(root, book, bTexts);
          // 基线排除新章本身（新章不参与自己的基线）；无其他章节时不输出"μ=0"的假基线
          const excluding = perCh.filter(function (pc) { return pc.file !== fileName; });
          if (excluding.length > 0) {
            const bl = computeBaselineFromPerChapter(excluding);
            baselineLine = METRIC_ORDER.map(function (k) { return METRIC_LABELS[k] + " " + (bl[k] && typeof bl[k].mu === "number" ? bl[k].mu : "-"); }).join(" / ");
          }
        }
      } catch { /* 基线计算失败不影响章节创建 */ }
      try {
        anchorPkg = await buildStyleAnchorPackage(root, book, chapters, exec, anchorTexts); // 复用基线计算已读文本
      } catch { /* 锚包失败不影响创建 */ }
      const reminder = "本章已创建（第" + String(number).padStart(2, "0") + "章）。【风格基线强制流程】① 动笔前：对照上方 baseline 六维 μ，并按 anchors/skeletons 原著样例的味道与句式骨架写（数字只做校验，样例才是写法）；② 写完：必须调用 novel_style_check 对照——verdict 低于 high 或出带时，按返回的 fixAnchors 原著锚段逐句修正跑偏部分，不得整章重写；属情节需要则说明原因。";
      await noteRoot(root); // v3.9.0：新章创建记录书库根
      return cleanOutput({ book, number, file: fileName, path: filePath, chars: text.length, baseline: baselineLine, reminder, anchors: anchorPkg.anchors, skeletons: anchorPkg.skeletons });
    }
  });
}
function apply(ctx, config = {}) {
  registerNovelBooks(ctx, config);
  registerNovelChapters(ctx, config);
  registerNovelRead(ctx, config);
  registerNovelKeywords(ctx, config);
  registerNovelNewChapter(ctx, config);
  registerNovelImport(ctx, config);
  registerNovelSentenceAnalysis(ctx, config);
  registerNovelSentenceConfig(ctx, config);
  registerNovelStyleCheck(ctx, config);
  registerNovelPlot(ctx, config);
  registerNovelSettings(ctx, config);
  registerNovelStyleReport(ctx, config);
  registerNovelSummary(ctx, config);
  registerNovelContinuityCheck(ctx, config);
  registerNovelSemanticSearch(ctx, config);
  registerNovelOutline(ctx, config);
  // 注册 UI 开关状态路由（可选注入，headless 自动跳过）
  registerStyleConfigRoute(ctx, config);
  // v4.0.0：系统提示词三档注入（关闭 / 精简 / 完整）——沿用 DSH 官方"动态 section"写法（参照 yexi-by/dsh-unrestricted、masknull/dsh-session-prompt）：
  // text 为函数，返回空串时 DSH 自动丢弃该段（dsh-system-prompt: filter(text.length > 0)），因此"关闭"档 = 完全不注入。
  // 档位存在 state 文件里，由侧边栏首页开关写入；组装提示词时实时读取，下一轮对话生效，无需重启。
  ctx.systemPrompt.section({
    name: "novel-writing",
    order: 150,
    text: () => {
      try {
        const mode = readSentenceStateSync().systemPromptMode;
        if (mode === "off") return "";
        if (mode === "full") return WORKFLOW_TEXT;
      } catch { /* 读不到开关时按精简档处理 */ }
      return BRIEF_TEXT;
    }
  });
  // v3.1.0 原创模式：不做动态 section（DSH 0.1.1-rc.2 对 section 返回 null 会导致对话失败——改为 novel_outline init 时把用户原创设定预填进 创作设定.md，经工具链注入）
  // v2.0.0 非净化模式：动态 section（text 为函数，组装提示词时实时读开关）
  ctx.systemPrompt.section({
    name: "novel-writing:raw-writing",
    order: 151,
    text: () => {
      try {
        const st = readSentenceStateSync();
        if (st.features?.rawWriting === true) return RAW_WRITING_PROMPT;
      } catch { /* 读不到开关则不注入 */ }
      return "";
    }
  });
}
export { apply, inject, name };
