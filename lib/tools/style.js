/**
 * dsh-novel-writer — lib/tools/style.js（句式分析、风格自检、风格画像与改稿台工具）
 */

import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { analyzeText, CATEGORY_ORDER, fingerprintSimilarity, styleDiffs } from "../analysis.js";
import { computeBaselineFromPerChapter, computeSceneBaselines, enrichPerChapterScenes, judgeAgainstBaseline, measureStyleMetrics, METRIC_LABELS, METRIC_ORDER, MIN_SCENE_BAND_CHAPTERS, selectSceneBaseline } from "../style-metrics.js";
import { computeVibe, semanticStyleDistances } from "../vibe.js";
import { CULTURE_MARKERS } from "../lexicons/markers.js";
import { compareExplicitness, measureExplicitness } from "../explicit.js";
import { buildFixPlan, verifyFixPlan, markFixItem } from "../fixplan.js";
import { buildAuditBrief, runAuditContracts, verifyAuditClaims } from "../audit.js";
import { buildSlopExemptions, scanSlop, SLOP_CATEGORIES, topSlopCategories } from "../lexicons/slop.js";
import * as embedding from "../embedding.js";
import { logEvent } from "../log.js";
import { assert, assertToolEnabled, atomicWriteJson, bookAnalysisCached, bookDir, buildBriefLine, buildStyleAnchorPackage, buildTolerance, CACHE_VERSION, cleanOutput, effectiveSentenceAnalysis, enrichSemanticImplicit, extractTopKeywords, featureEnabled, findChapter, formatSentenceAnalysis, isAbort, metricChaptersCached, noteRoot, novelDataDir, optionalInt, optionalString, parseEvidenceCounts, readBookAllText, readSentenceState, readSettings, readTextFile, requiredString, resolveAmbiguousCarriers, resolveBaselineScope, resolveRoot, resolveStyleRule, sanitizeSegment, scanChapters, semanticFeatureEnabled, writeBookSemanticCache } from "../core.js";
import { cropEmotionByFeatures, dropNullDeep, isLeanWorkflow, pruneAnalysisReports, semanticGate, semanticSkipText } from "./shared.js";

function registerNovelSentenceAnalysis(ctx, config) {
  ctx.tools.register({
    name: "novel_sentence_analysis",
    description: "句式分析：九类句式、转移模板、句长、情感曲线与指纹(共缓存，受config控制)。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名" },
        chapter: { type: "string", description: "章节(省=全书)" },
        top: { type: "integer", description: "模板数(8)" },
        maxSentences: { type: "integer", description: "采样上限(20000)" },
        curveSegments: { type: "integer", description: "曲线段数(20)" },
        fresh: { type: "boolean", description: "重算" },
        brief: { type: "boolean", description: "精简摘要" },
        root: { type: "string", description: "书库根" }
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
            required: ["total", "avgSentences", "opening", "closing", "dialogueOnly", "psychologyOnly", "mixed", "narrationOnly", "exchanges"]
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
      // v4.3.0：brief=true 时 render 直接给精简摘要——core.js 的 formatSentenceAnalysis 从不读 value.brief，
      // 旧版仍把全量【句式分布】…【AI 解读提示】塞给模型，"省 token"名不副实
      render: (_args, value) => [{
        type: "text",
        text: typeof value.brief === "string" && value.brief !== ""
          ? `<path>novels/${value.book}</path>
<type>novel-sentence-analysis</type>
<content>
【句式分析·精简】${value.brief}
（brief=true：完整句式分布/情感量化/节奏建议请省略 brief 重新调用）
</content>`
          : formatSentenceAnalysis(value)
      }]
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
          // v6.6.0：读不出章节指纹 → 缓存键退化成 "?:?"（章节改了也不失效，可能命中旧报告）。
          // 这些文件刚被 scanChapters 列出，读失败基本是占用/权限，而不是"没有这一章"。
          logEvent("silent_skip", { book, file: chapter.file, detail: "章节指纹读取失败，缓存键退化为占位值（可能命中旧缓存）" });
          scopeKeyParts.push(chapter.file + ":?:?");
        }
      }
      // v0.8.0：分析结果缓存 + 报告导出（书库统一数据目录 <root>/.novel-writer/analysis）
      const cacheDir = join(novelDataDir(root), "analysis");
      // v3.9.5 修正：缓存键纳入 top/maxSentences/curveSegments 与 enabled/autoAnalyze——参数不同不再命中旧结果
      // v7.4.0（#12）：将 semanticImplicit 开关态纳入 cacheKey，避免开/关两态共用同一缓存导致 implicit 裁决串台
      const semOn = semanticFeatureEnabled(state, "semanticImplicit");
      const cacheKey = createHash("sha1").update(book + "|" + scope + "|" + scopeKeyParts.join(",") + "|top=" + top + "|max=" + maxSentences + "|curve=" + curveSegments + "|en=" + (effective.enabled ? 1 : 0) + "|auto=" + (effective.autoAnalyze ? 1 : 0) + "|sem=" + (semOn ? "1" : "0")).digest("hex").slice(0, 20);
      const reportFile = join(cacheDir, book + "-" + cacheKey + ".json");
      // v5.0.0（降本）：精简工作流开启且调用方未显式指定 brief 时，句式分析默认走简报（完整版约 2k 字符）。
      // 命中与未命中两条路径共用同一个判据，避免口径漂移。
      const sentenceBrief = args?.brief === true || (args?.brief === void 0 && isLeanWorkflow());
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
        // v4.3.0：与 novel_style_report 同一套判据（共用 semanticGate）——只有"用户明确关闭语义功能"
        // 才允许清缓存；"引擎瞬时不可用"必须保留并复用缓存里的 semanticImplicit
        const semGate = await semanticGate(state);
        let implicitChanged = false;
        try {
          const imp = cachedHit?.emotion?.quantification?.implicit;
          if (semGate.embOk && imp && Array.isArray(imp.ambiguous) && imp.ambiguous.length > 0 && !Array.isArray(imp.resolved)) {
            const resolved = await resolveAmbiguousCarriers(imp);
            if (resolved && Array.isArray(resolved.resolved)) {
              cachedHit.emotion.quantification.implicit = resolved;
              implicitChanged = true;
            }
          }
        } catch {
          logEvent("engine", { book, detail: "意象歧义语义裁决失败（报告中的歧义项保持未裁决）" });
        }
        await enrichSemanticImplicit(state, root, book, cachedHit, exec, chapterArg !== void 0 ? selected[0].file : void 0);
        // v4.3.0：引擎瞬时不可用时 enrichSemanticImplicit 会按"引擎不可用"清掉结果——这里把缓存值挂回，
        // 本次报告仍显示隐性情绪，且 siBefore===siAfter 使下面跳过写回（缓存不再被抹成 null）
        if (semGate.keepCached && siBefore && cachedHit?.emotion?.quantification && !cachedHit.emotion.quantification.semanticImplicit) {
          cachedHit.emotion.quantification.semanticImplicit = siBefore;
        }
        // v3.9.1 修复：越界旧缓存被重算（对象被替换）→ 写回缓存，避免每次命中重复重算
        const siAfter = cachedHit?.emotion?.quantification?.semanticImplicit;
        // v3.9.5 修正：删除后同样写回（siAfter 为 undefined 时也要落盘，避免每次命中重复重算/残留）
        // v4.0.0 修正：条件改为"任一方向变化都写回"——旧版 siBefore && ... 在"缓存里原本没有
        // semanticImplicit、本次新算出"时恒假，新结果永远不落盘 → 每次命中都重跑全书索引+原型推理
        if (siBefore !== siAfter || implicitChanged) {
          try { await atomicWriteJson(reportFile, { ...cachedHit, cachedAt: new Date().toISOString(), ver: CACHE_VERSION }); } catch { logEvent("cache", { file: reportFile, book, level: "warn", detail: "句式分析缓存修正写回失败（每次命中都会重跑语义修正）" }); }
        }
        // v4.3.0：emotionCaveat 与 emotionComplexity 各自独立生效（旧版 cropEmotion 连带剥掉 quantification）
        cachedHit.emotion = cropEmotionByFeatures(state, cachedHit.emotion);
        if (sentenceBrief && cachedHit.categories && cachedHit.lengths && cachedHit.emotion) {
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
        // v6.2.0 修正（旧清单第 11 条）：逐章拼接补分隔符——章末无换行时相邻章会粘成一段，
        // 污染段落/句数/风格指纹。口径与 core.readBookAllText（v4.3.0）和本文件 novel_keywords 一致。
        text += chapterText.endsWith("\n") ? chapterText : chapterText + "\n";
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
      } catch {
        // v6.6.0：裁决没跑成 → 报告里"变色龙词"保持未裁决，与"这本书没有歧义词"完全一样，留痕
        logEvent("engine", { book, detail: "意象歧义语义裁决失败（报告中的歧义项保持未裁决）" });
      }
      // v3.9.0 复查修正：先 enrich 后写缓存——缓存文件必须含 semanticImplicit，命中路径才能早退复用（否则每次命中仍全量读盘重建索引）
      // v3.9.1 修复：单章分析传 scope，语义隐性情感只算本章（此前整书检索，把别章命中混入本章报告）
      await enrichSemanticImplicit(state, root, book, result, exec, chapterArg !== void 0 ? selected[0].file : void 0);
      try {
        await mkdir(cacheDir, { recursive: true });
        // v4.3.0：未命中 / fresh 路径同样不得抹掉缓存里的语义结果。
        // 场景：调用方带 fresh:true 强制重算，而此刻语义引擎恰好不可用（用户并未关闭该功能）——
        // 旧版会把"算不出 semanticImplicit"的结果写回**同一个缓存文件**（缓存键不含 fresh），
        // 于是之前算好的语义结果被永久丢掉。此处把旧缓存里的同名字段并回**落盘副本**：
        // 缓存键含内容指纹，同键即同内容，旧值仍然有效；本次返回值不受任何影响（仍是"未算出"）。
        const persist = { ...result, cachedAt: new Date().toISOString(), ver: CACHE_VERSION };
        if (result.emotion?.quantification && !result.emotion.quantification.semanticImplicit && (await semanticGate(state)).keepCached) {
          try {
            const prev = JSON.parse(await readFile(reportFile, "utf8"));
            const prevSi = prev && prev.ver === CACHE_VERSION && prev.emotion && prev.emotion.quantification
              ? prev.emotion.quantification.semanticImplicit
              : void 0;
            if (prevSi) {
              persist.emotion = { ...result.emotion, quantification: { ...result.emotion.quantification, semanticImplicit: prevSi } };
            }
          } catch { /* 旧缓存不存在/损坏：无需并回 */ }
        }
        await atomicWriteJson(reportFile, persist);
        // v4.3.0：报告缓存上限——按书只保留最近 REPORT_CACHE_KEEP 份（旧版无上限，改稿即新增文件）
        await pruneAnalysisReports(cacheDir, book, "sentence");
      } catch {
        // v6.6.0：分析结果/报告没落盘 → 每次调用都全量重算（大书代价明显），而本次返回完全正常
        logEvent("cache", { file: reportFile, book, level: "warn", detail: "句式分析结果/报告落盘失败（后续每次都会重算）" });
      }
      // v4.3.0：两个情感开关独立生效（旧版 cropEmotion 连带剥掉 quantification，complexity 分支成死代码）
      result.emotion = cropEmotionByFeatures(state, result.emotion);
      if (sentenceBrief && result.categories && result.lengths && result.emotion) {
        result.brief = buildBriefLine(result, scope);
      }
      // v4.0.0 修正：本工具未过 cleanOutput，stats 里的 -0 会被宿主 lossless JSON 校验整次拒绝
      return cleanOutput({ ...result, cache: "miss", reportFile, cachedAt: new Date().toISOString() });
    }
  });
}

function registerNovelStyleCheck(ctx, config) {
  ctx.tools.register({
    name: "novel_style_check",
    description: "风格自检：对比单章与全书指纹输出偏差（改稿用 fix_plan，全书画像用 style_report）。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名" },
        chapter: { type: "string", description: "章节" },
        root: { type: "string", description: "书库根" }
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
          // v6.5.5：基线范围档位（"all" = 按全书，"custom" = 按用户选中的部分章）。
          // 必须登记进 schema：本输出 additionalProperties:false，多返回一个字段会被严格校验的宿主整条拒收。
          baselineMode: { type: "string", enum: ["all", "custom"] },
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
          fixAnchors: { type: "array", items: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, text: { type: "string" } }, required: ["label", "text"] } },
          // v6.9.0：非净化模式的直白度对照（未开启时该键不存在）
          explicitness: { type: "object", additionalProperties: true, description: "{ chapter:{chars,total,per1000,dialogueRatio}, baseline:{...}, ratio, verdict, items:[{id,label,count,samples[]}], note }——只在非净化模式开启时输出" },
          // v7.0.0：陈词套话扫描（与改稿台同源，含参照集高频词与题材豁免；0 命中时省略）
          slop: { type: "object", additionalProperties: true, description: "v7.0.0 陈词套话扫描（与改稿台同源，含参照集高频词与题材豁免）：{ total, densityPer1000, topCategories[], byCategory }；0 命中时省略" }
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
          // v5.1.0（降本）：抬头从"逐句对比…只修跑偏部分"改为条件式——只有确实跑偏时才用锚段对照，
          // 且明确"改那几处"，避免模型把正常波动也当成必须修的偏差。
          lines.push("", "【对照参考·原著锚段】若确实跑偏（偏离明显或读起来别扭），可对照这几段原著的写法只调整那几处，不要整章重写：");
          for (const a of value.fixAnchors) lines.push("  [" + a.label + "] " + a.text);
        }
        lines.push(`本章指纹: ${value.chapterFingerprint}`);
        lines.push(`基线指纹: ${value.baselineFingerprint}`);
        // v3.0.0：文笔六维基线对照
        if (value.metric && value.metric.enabled) {
          const sb = value.metric.sceneBand;
          const baseHint = sb && sb.usedSceneBand ? "同类场景带基线" : "全书其他章基线";
          lines.push("", `文笔六维对照（μ=${baseHint}，±%为相对偏差）：`);
          if (sb) {
            lines.push(`  场景带识别：${sb.label}（${sb.note}）`);
          }
          for (const v of value.metric.verdicts || []) {
            const mark = v.status === "out" ? "⚠ 出带" : v.status === "warn" ? "△ 提醒" : "✓ 在带";
            // v4.3.0：μ=0 的维度按绝对尺度判定（devPct 为 null），单独表述，不打印 "null%"
            const devText = v.devPct === null || v.devPct === void 0
              ? "基线为 0，按绝对尺度判定"
              : (v.devPct > 0 ? "+" : "") + v.devPct + "%";
            lines.push(`  ${v.label}: 本章 ${v.value} vs 基线 ${v.mu}（${devText}，${mark}）`);
          }
          // v5.1.0（防僵化）：删掉句尾「——请对照基线修正后再续写」——它与同一份输出里的建议段自相矛盾
          // （建议段说"轻微出带属正常波动，不必逐项消除"）；模型会听更早、更硬的那半句，于是反复打磨。
          if (value.metric.outCount > 0) lines.push("  ⚠ " + value.metric.summary);
          // v4.3.0：即使没有出带维度，也要披露"因基线为 0 未做相对判定"的维度（旧版一律不打印）
          else if ((value.metric.skippedDims || []).length > 0) lines.push("  · " + value.metric.summary);
        } else if (value.metric && !value.metric.enabled) {
          lines.push("", "文笔六维对照: " + (value.metric.note || "不可用"));
        }
        // v6.9.0：非净化模式的直白度对照
        if (value.explicitness) {
          const ex = value.explicitness;
          lines.push("", "直白度对照（非净化模式，启发式：只数「把场面绕过去」的写法，不是质量评分）：");
          lines.push(`  本章 ${ex.chapter.per1000} 处/千字 vs 原著 ${ex.baseline.per1000} 处/千字 · 对话段落占比 ${Math.round(ex.chapter.dialogueRatio * 100)}% vs ${Math.round(ex.baseline.dialogueRatio * 100)}%`);
          for (const it of (ex.items || []).slice(0, 4)) {
            const sample = Array.isArray(it.samples) && it.samples.length > 0 ? "：" + it.samples[0] : "";
            lines.push(`  · ${it.label} × ${it.count}${sample}`);
          }
          lines.push("  " + ex.note);
        }
        if (value.slop && value.slop.total > 0) {
          const catText = (value.slop.topCategories || []).map((c) => SLOP_CATEGORIES[c] || c).join("、");
          lines.push("", `陈词套话扫描：命中 ${value.slop.total} 处（${value.slop.densityPer1000} 处/千字${catText ? "，主要为：" + catText : ""}）——如需逐行定位可运行 novel_fix_plan`);
        }
        lines.push("", "【建议】");
        lines.push(value.advice);
        lines.push("", "</content>");
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_style_check");
      const rawBook = requiredString(args, "book");
      const book = sanitizeSegment(rawBook, "book");
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
      // v6.5.5：基线范围走**单一裁决点**——按全书（默认，等于旧行为）或按用户选中的部分章。
      // v7.4.0 修（#10）：先对全书候选章（排除目标章）调用 metricChaptersCached 得到 >=40 字可测量章节池，
      // 再传入 resolveBaselineScope 裁决范围与全书回退；这样自定义基线仅选中 <40 字短章时也能正确回退到其余可测长章。
      let baselineScopeOut = await resolveBaselineScope(root, book, chapters, target.file, exec);
      const targetText = await readTextFile(join(dir, target.file), exec);
      const allTexts = [];
      for (const ch of chapters) {
        allTexts.push({
          file: ch.file,
          text: ch.file === target.file ? targetText : await readTextFile(join(dir, ch.file), exec)
        });
      }
      const textByFile = new Map(allTexts.map((c) => [c.file, c.text]));
      let allPerCh = null;
      let metricErr = null;
      try {
        allPerCh = await metricChaptersCached(root, book, allTexts);
        const measurableCandidates = allPerCh.filter((pc) => pc.file !== target.file);
        const measuredScope = await resolveBaselineScope(root, book, measurableCandidates, target.file, exec);
        // 守卫 items.length > 0：全书其余章均不足 40 字时保留章池口径（"基线章节不足"另有说明，避免写出 0 章回退文案）
        if (measuredScope.items.length > 0) baselineScopeOut = measuredScope;
      } catch (e) {
        if (isAbort(e)) throw e;
        metricErr = e;
      }
      const others = baselineScopeOut.items;
      // v3.0.0：收集其他章逐章文本（六维基线带按章测 μ/σ）
      const baselineChapters = others.map((ch) => ({ file: ch.file, text: textByFile.get(ch.file) ?? "" }));
      let baselineText = "";
      for (const bc of baselineChapters) {
        // v6.2.0 修正（旧清单第 11 条）：同 text += 拼接口径，章间补换行（章末无换行时两章会粘成一句）
        baselineText += bc.text.endsWith("\n") ? bc.text : bc.text + "\n";
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
      } catch {
        // v6.6.0：锚段是"照着原著改"的唯一参照物，失败即无参照，而判定文案照常输出（看不出少东西）。
        // 注意：buildStyleAnchorPackage 内部失败已自行吞掉并返回空锚包，能抛到这里的基本是**契约错误**
        //（如漏传预读文本）——正是该函数头注释里说"不能被吞掉、否则又退化成静默失败"的那种。
        logEvent("silent_skip", { book, chapter: args?.chapter, level: "warn", detail: "原著锚段不可用（风格偏差时没有对照锚段）；若为契约错误请查该函数的 preloadedText 传参" });
      }
      const diffs = styleDiffs(baseline, chapter);
      const verdict = similarity >= 0.9 ? "high" : similarity >= 0.75 ? "medium" : "low";
      // v6.9.0：非净化模式——本章 vs 原著基线的"直白度"对照。
      // 只在开关打开时计算（纯规则，不调模型、不写盘）；它回答的正是"开了到底有没有变"。
      // 注意用 undefined 而不是 null：cleanOutput 只丢 undefined，null 会被当成一个"值"发给宿主。
      let explicitness;
      if (state?.features?.rawWriting === true) {
        try {
          explicitness = compareExplicitness(measureExplicitness(targetText), measureExplicitness(baselineText));
        } catch (e) {
          logEvent("silent_skip", { book, chapter: args?.chapter, level: "warn", detail: "直白度对照计算失败（本次不输出该区块）：" + String(e?.message ?? e).slice(0, 80) });
        }
      }
      let slop;
      try {
        const settings = await readSettings(root, book);
        const bookCreation = state?.creationProfiles && typeof state.creationProfiles === "object"
          ? (state.creationProfiles[book] ?? state.creationProfiles[rawBook])
          : void 0;
        const styleRuleForSlop = resolveStyleRule(settings, baselineChapters, { root, book });
        const slopRes = scanSlop(targetText, buildSlopExemptions(baselineChapters, {
          settings,
          genre: bookCreation ?? state?.creationProfile,
          extraMuteCategories: styleRuleForSlop?.pack?.slopMuteCategories
        }));
        if (slopRes.total > 0) {
          slop = { total: slopRes.total, densityPer1000: slopRes.densityPer1000, topCategories: topSlopCategories(slopRes.hits, 3), byCategory: slopRes.byCategory };
        }
      } catch { /* 套话扫描失败不影响主流程 */ }
      let advice = "";
      if (diffs.length === 0) {
        advice = "本章与全书风格高度一致，可以放心续写。";
      } else {
        // v3.7.0 ⑦：方向全映射（原只认"偏高"，"偏长/偏低/偏短"一律输出"略少"）
      const noteMap = { "偏高": "略多", "偏低": "略少", "偏长": "略长", "偏短": "略短" };
      // v3.8.0：跑偏不整章重写——对照 fixAnchors（原著锚段）逐句修正跑偏维度
      advice = "续写风格偏差：" + diffs.slice(0, 4).map((d) => d.dimension + (noteMap[d.note] || d.note)).join("、") + "。**先判断这是不是有意为之**：章节类型不同（抒情段 / 动作段 / 对话段）本来就会偏离全书均值——确属风格选择就保留；确实跑偏时，可对照 fixAnchors 中的原著锚段只调整那几处（句式/修饰/节奏），不要整章重写，也不要为对齐数字改文。";
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
            for (const p of embedding.chunkText(allTexts[i], { chapter: i === 0 ? target.file : "基线" })) allChunks.push({ ...p, id: String(i) + "|" + p.id });
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
      if (metricErr) {
        metric = { enabled: false, note: "六维测量失败：" + String(metricErr).slice(0, 80) };
      } else {
        try {
          const otherFiles = new Set(others.map((ch) => ch.file));
          const excluding = (allPerCh ?? []).filter((pc) => pc.file !== target.file && otherFiles.has(pc.file));
          if (excluding.length > 0) {
            const enrichedExcluding = enrichPerChapterScenes(excluding, textByFile);
            const targetMetrics = measureStyleMetrics(targetText).metrics;
            const scenePick = selectSceneBaseline({ text: targetText, metrics: targetMetrics }, enrichedExcluding);
            // v6.2.0 修正（旧清单第 12 条）：容差改调 core.buildTolerance——**全插件唯一实现**
            // （fixplan.js / brief.js 均调用，含 sampleCount<3 时 max(recTol,25%) 的小样本下限，
            // 并承接侧边栏 styleTolerance）。旧版用「含本章的全书基线」的 recTol 自算且无下限，
            // 同一章会出现「style_check 出带 / fix_plan 0 项待办」的互相矛盾结论。
            const tol = buildTolerance(scenePick.baseline, scenePick.items.length, null, state.styleTolerance);
            const judge = judgeAgainstBaseline(targetMetrics, scenePick.baseline, tol);
            metric = {
              enabled: true,
              baseline: scenePick.baseline,
              metrics: targetMetrics,
              verdicts: judge.verdicts,
              outCount: judge.outCount,
              skippedDims: judge.skippedDims,
              summary: judge.summary,
              sceneBand: {
                band: scenePick.band,
                label: scenePick.label,
                dialogueRatio: scenePick.dialogueRatio,
                ...(typeof scenePick.conflictDensity === "number" ? { conflictDensity: scenePick.conflictDensity } : {}),
                usedSceneBand: scenePick.usedSceneBand,
                peerCount: scenePick.peerCount,
                chapterCount: scenePick.chapterCount,
                note: scenePick.note
              }
            };
          } else metric = { enabled: false, note: "基线章节不足（至少需要 1 个其他章节）" };
        } catch (e) { metric = { enabled: false, note: "六维测量失败：" + String(e).slice(0, 80) }; }
      }
      // v4.0.0 修正：advice 与六维判定统一口径——旧版 advice 在六维算完之前定稿，
      // 指纹无偏差但六维出带时同一份输出既说"可以放心续写"又标"⚠ 需修正"，模型很可能采纳前者
      if (metric && metric.enabled && metric.outCount > 0) {
        const outDims = (metric.verdicts || []).filter((v) => v.status === "out").map((v) => v.label).slice(0, 4).join("/");
        const dimNote = metric.summary + (outDims ? "（" + outDims + "）" : "");
        advice = diffs.length === 0
          ? "句式指纹与全书高度一致；六维层面：" + dimNote + "——**单一维度出带属正常波动**（带宽 = 作者自身波动的 1.5σ），只有偏离达到 2 倍容差以上、或那一处读起来确实别扭时才需要调整，不要为对齐数字改写文本。"
          : advice + "另（六维）：" + dimNote + "——同上，轻微出带属正常波动，不必逐项消除。";
      }
      return cleanOutput({
        book,
        chapter: target.file,
        // v6.5.5：文案由单一裁决点给出（按全书 / 自定义 N 章），不再在这里手拼。
        // 旧版此处硬编码"全书除本章外的 N 章"——用户改成"按部分"后那句话就变成假话了。
        baselineScope: baselineScopeOut.scope,
        baselineMode: baselineScopeOut.mode,
        similarity,
        verdict,
        diffs,
        semantic,
        metric,
        // v6.9.0：非净化模式下的直白度对照（关闭时为 undefined → cleanOutput 丢弃该键）
        explicitness,
        slop,
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
    description: "全书6维风格画像(单章用style_check，技法用sentence_analysis)。",
    parameters: {
      type: "object",
      additionalProperties: true,
      properties: {
        book: { type: "string", description: "书名" },
        root: { type: "string", description: "书库根" },
        action: { type: "string", description: "report(默认)/get" },
        brief: { type: "boolean", description: "精简摘要" },
        aiJudgment: { type: "string", description: "AI风格判断" }
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
          semanticDiagnostics: { type: "object", additionalProperties: true },
          saved: { type: "object", additionalProperties: true },
          savedJudgment: { type: "string" },
          message: { type: "string" },
          // v3.9.5：声明实际返回字段（此前仅靠 additionalProperties:true 放行，模型侧契约看不到）
          baseline: { type: "object", additionalProperties: true },
          baselineChapterCount: { type: "integer" },
          // v6.5.5：基线范围文案（按全书 / 自定义 N 章）。本输出 additionalProperties:true，
          // 仍显式登记以便模型侧契约可见。
          baselineScope: { type: "string" },
          baselineMode: { type: "string", enum: ["all", "custom"] },
          sceneBaselines: { type: "object", additionalProperties: true },
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
        } catch (e) {
          // v6.6.0：**读不到 ≠ 没保存过**。文件损坏 / 无权限 / 内容不是合法 JSON 曾被一律说成
          // 「尚未保存该作品的风格判断」✗ —— 用户按提示重新生成再保存也修不好，因为文件其实就在那里。
          // 只有 ENOENT 才是「尚未保存」（这条友好文案是对的，必须保留）。
          if (e?.code === "ENOENT") {
            return { book, report: "尚未保存该作品的风格判断。请先调用 novel_style_report 生成报告，并结合报告给出 aiJudgment 回传保存。", message: "无已保存判断" };
          }
          // 注意：这是 JSON.parse 路径，解析错误的消息会**回显文件内容片段** → 绝不带 e.message，只记固定标签 + 文件名
          logEvent("config", { book, file: reportFile, level: "warn", detail: "已保存的风格判断读取失败（不是「尚未保存」，文件损坏或无权限）" });
          return {
            book,
            // 用户面文案**不复述**那句错误结论（「尚未保存」），只说事实：文件在，但读不出来
            report: "读取已保存的风格判断失败：该文件存在，但读不出来（损坏 / 无权限）。请检查该文件后重试，或删掉它再重新生成保存：" + reportFile,
            message: "已保存判断读取失败（文件存在但读不出来）"
          };
        }
      }
      const { text, chapters, texts } = await readBookAllText(root, book, exec, { withTexts: true });
      // v6.2.0 修正（旧清单第 13 条）：brief（精简）模式只需要 chars + 六维基线，判定必须排在
      // 锚包 / 全书分析 / 语义推理这些重活**之前**——旧版把重活全算完才决定"只回一行字"，
      // 而精简工作流默认就走 brief，"省 token 模式"每次付全量代价。传了 aiJudgment 时仍需
      // 完整数据来落盘判断（下面走原路径）。
      const briefMode = args?.brief === true || (args?.brief === void 0 && isLeanWorkflow());
      const briefText = (chars, baseline, count, scopeLabel) => {
        if (baseline && count > 0) {
          const dims = METRIC_ORDER.filter((k) => baseline[k] && typeof baseline[k].mu === "number" && typeof baseline[k].recTol === "number");
          // v6.5.5：字数仍是**全书**（这是画像的描述部分），但六维基线可能只来自用户选中的部分章——
          // 不标出来，读者会把"自定义 20 章的 μ"当成"全书的 μ"。
          return "全书 " + chars + " 字：" + (scopeLabel ? "六维基线（" + scopeLabel + "）" : "六维基线") +
            " μ=" + dims.map((k) => METRIC_LABELS[k] + ":" + baseline[k].mu.toFixed(1)).join(" ") +
            "；推荐容差 " + dims.map((k) => baseline[k].recTol + "%").slice(0, 3).join("/") + "…。";
        }
        return "全书 " + chars + " 字（六维基线测量不可用，建议用完整报告查看）。";
      };
      if (briefMode && !(typeof args?.aiJudgment === "string" && args.aiJudgment.trim().length > 0)) {
        const chars = text.replace(/\s/g, "").length;
        let briefBaseline = {};
        let briefChapterCount = 0;
        let briefScopeText = "";
        let briefScopeMode = "all";
        try {
          // v7.4.0 修（#10）：先对全书候选章（texts）调用 metricChaptersCached 得到 >=40 字可测量章节池，
          // 再传入 resolveBaselineScope 裁决范围与全书回退，避免自定义仅选短章时返回 0 章假基线。
          const rawBriefScope = await resolveBaselineScope(root, book, texts, "", exec);
          const allPerCh = await metricChaptersCached(root, book, texts);
          const measuredBriefScope = await resolveBaselineScope(root, book, allPerCh, "", exec);
          const effectiveBriefScope = measuredBriefScope.items.length > 0 ? measuredBriefScope : rawBriefScope;
          const perCh = measuredBriefScope.items;
          briefBaseline = computeBaselineFromPerChapter(perCh);
          briefChapterCount = perCh.length;
          briefScopeText = effectiveBriefScope.scope;
          briefScopeMode = effectiveBriefScope.mode;
        } catch (e) {
          if (isAbort(e)) throw e;
          briefBaseline = {}; briefChapterCount = 0;
        } // 与下方完整路径同口径：null 违反输出 schema
        const brief = briefText(chars, briefBaseline, briefChapterCount, briefScopeMode === "custom" ? briefScopeText : "");
        return cleanOutput({
          book,
          chars,
          brief,
          baseline: briefBaseline ?? null,
          baselineChapterCount: briefChapterCount,
          // v6.5.5 修正：精简路径此前同样漏返回（schema 声明了却不产出），补上
          baselineScope: briefScopeText,
          baselineMode: briefScopeMode,
          report: "【风格画像·精简】《" + book + "》\n" + brief + "\n📌 请结合上述六个维度数据判断本书的风格气质、读者感受与写法特征，" + "\n（brief=true：完整六维/氛围/锚包请省略 brief 重新调用）",
          message: "风格画像简报已生成（精简）"
        });
      }
      // v3.8.0：风格锚包（原著代表性段落 + 句式骨架——生成端照样例写，勿只依赖数字基线）
      const anchorPkg = await buildStyleAnchorPackage(root, book, chapters, exec, text); // 复用 readBookAllText 已读全文
      const featState = await readSentenceState();
      // v2.6.0：复用全书分析缓存（大书不再每次重算 analyzeText/detectCulture/流派题材）
      const analysisCache = await bookAnalysisCached(root, book, text, featState);
      const { analysis, detection } = analysisCache;
      // 语义增强：意象歧义裁决 + 隐性情感（embedding 可用时）
      try {
        // v4.3.0：门控抽成共用 semanticGate（判据不变）——novel_sentence_analysis 命中路径现在用同一判据
        // v4.3.0：引擎可用性单独探测——"用户关掉语义功能"（应清缓存）与"引擎瞬时不可用"（不该清）必须分开处理
        const semGate = await semanticGate(featState);
        const semOn = semGate.semOn;
        const embOk = semGate.embOk;
        // v4.0.0：缓存里的语义结果先挂回 analysis——enrichSemanticImplicit 命中即早退（不再重跑 29 次原型推理 + 全索引检索）
        if (semOn && analysisCache.semantic && analysis.emotion?.quantification) {
          analysis.emotion.quantification.semanticImplicit = analysisCache.semantic;
        }
        // v4.0.0：意象歧义裁决结果同样复用缓存（同一内容指纹下结果确定）——旧版每次命中都重跑 N 次上下文向量推理
        // v4.3.0：引擎瞬时不可用时沿用缓存值（旧版置 null 后写回缓存＝把已裁决结果抹掉）
        let implicitResolved = semOn ? analysisCache.implicitResolved : null;
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
        // v4.3.0：引擎瞬时不可用时 enrichSemanticImplicit 会按"引擎不可用"清掉结果——这里把缓存值挂回，
        // 使本次报告与缓存保持一致（引擎恢复后仍可复用，不必重扫全书）
        if (semGate.keepCached && analysisCache.semantic && analysis.emotion?.quantification && !analysis.emotion.quantification.semanticImplicit) {
          analysis.emotion.quantification.semanticImplicit = analysisCache.semantic;
        }
        // v4.0.0：语义结果写回全书分析缓存（含内容指纹）；功能关闭/引擎不可用时写回即清除旧语义残留
        // v4.3.0：区分两种"不可用"——用户关闭语义功能→照旧写回清除；引擎瞬时不可用→跳过写回，保留缓存
        // v4.3.0：该表达式原样抽为 semGate.keepCached === (semOn && !engineReady)，行为不变
        if (analysis.emotion?.quantification && !semGate.keepCached) {
          const semanticNow = analysis.emotion.quantification.semanticImplicit;
          if ((semanticNow ?? null) !== (analysisCache.semantic ?? null) || (implicitResolved ?? null) !== (analysisCache.implicitResolved ?? null)) {
            await writeBookSemanticCache(analysisCache, semanticNow, implicitResolved);
          }
        }
      } catch {
        // v6.6.0：语义增强失败 → 报告里没有"语义隐性情感/意象裁决"，与"这本书没有"完全一样
        logEvent("engine", { book, detail: "风格画像的语义增强失败（隐性情感与意象裁决缺失）" });
      }
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
      // v6.5.5：基线范围走单一裁决点（按全书 / 按用户选中的部分章）。风格画像的**描述性部分**
      // （词汇/题材/情感/氛围/语义）仍是全书口径——那些是"这本书是什么样"，不是"拿什么当基准"；
      // 只有名为 baseline 的这个字段是基准，故只有它跟着范围走。范围文案由 result.baselineScope 说明。
      try {
        // v7.4.0 修（#10）：先对全书候选章（texts）调用 metricChaptersCached 得到 >=40 字可测量章节池，
        // 再传入 resolveBaselineScope 裁决范围与全书回退，避免自定义仅选短章时返回 0 章假基线。
        const rawReportScope = await resolveBaselineScope(root, book, texts, "", exec);
        const allPerCh = await metricChaptersCached(root, book, texts);
        const measuredReportScope = await resolveBaselineScope(root, book, allPerCh, "", exec);
        const effectiveReportScope = measuredReportScope.items.length > 0 ? measuredReportScope : rawReportScope;
        const perCh = measuredReportScope.items;
        result.baseline = computeBaselineFromPerChapter(perCh);
        result.baselineChapterCount = perCh.length;
        result.baselineScope = effectiveReportScope.scope;
        result.baselineMode = effectiveReportScope.mode;
        if (!briefMode) {
          const enrichedPerCh = enrichPerChapterScenes(perCh, texts);
          result.sceneBaselines = computeSceneBaselines(enrichedPerCh);
        }
      } catch (e) {
        if (isAbort(e)) throw e;
        // v6.6.0：六维基线算不出来 → 报告里 baseline 是空对象（读起来像"这本书没有基线/章太少"），
        // 而真因是计算失败。空对象是为了满足输出 schema，不是为了隐瞒——所以真因要进日志。
        logEvent("silent_skip", { book, level: "warn", detail: "六维基线带计算失败（报告的 baseline 为空对象）" });
        result.baseline = {}; result.baselineChapterCount = 0;
      } // v4.0.0：null 违反输出 schema {type:"object"}，宿主会拒绝整次调用
      // 语义距离（embedding 可用时）
      let semantic = [];
      let semanticDiagnostics = { reason: "not-run", detail: "semanticStyle disabled", count: 0, at: Date.now() };
      try {
        if (semanticFeatureEnabled(featState, "semanticStyle")) {
          if (await embedding.isAvailable()) {
            const emb = await import("../embedding.js");
            semantic = await semanticStyleDistances(text, emb, { root, book });
            semanticDiagnostics = semantic.diagnostics;
          } else {
            semanticDiagnostics = { reason: "no-engine", detail: String(embedding.engine?.error || ""), count: 0, at: Date.now() };
          }
        }
      } catch (error) {
        semanticDiagnostics = { reason: "error", detail: String(error?.message || error).slice(0, 300), count: 0, at: Date.now() };
      }
      // 组装报告文本
      // v4.3.0：报告组装前套用与 novel_sentence_analysis 同一套开关裁剪——
      // 旧版无论 emotionCaveat / emotionComplexity 开关如何，都照常输出 raw↔clean 对照、Δ/V/C 与隐性情绪，
      // 与 SKILL.md「关闭后对应输出消失」的承诺相反。
      const caveatOn = featureEnabled(featState, "emotionCaveat");
      const complexityOn = featureEnabled(featState, "emotionComplexity");
      const emotionView = cropEmotionByFeatures(featState, emotion);
      const q = complexityOn ? (emotion.quantification || {}) : {};
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
      // v4.3.0：caveat 关 → 不输出 raw↔clean 对照；complexity 关 → 不输出 Δ/V/C、意象与隐性情绪
      if (caveatOn) {
        lines.push("  表面 " + (emotion.dominant || "-") + " → 真实 " + (emotion.cleanDominant || "-") + "（置信度 " + (emotion.confidence || "-") + "）");
      } else {
        lines.push("  主导情绪 " + (emotion.dominant || "-") + "（情感净化预警已关闭，本行仅给规则主导情绪）");
      }
      if (complexityOn) {
        lines.push("  趋势 Δ=" + (q.stats?.delta ?? 0) + " | 撕裂度 V=" + (q.stats?.variance ?? 0) + " | 矛盾 C=" + (q.stats?.conflict ?? 0));
        lines.push("  意象：负 " + Math.round((implicit.negative ?? 0) * 100) + "% / 正 " + Math.round((implicit.positive ?? 0) * 100) + "% / 歧义 " + Math.round((implicit.ambiguousRatio ?? 0) * 100) + "%");
        // v4.0.0 修正：distribution 基数最多 56 个键（原型表扩容后），按计数降序只取前 8 个再拼接，
        // 避免报告行过长；被截断时标注总类数
        const siDist = Object.entries(q.semanticImplicit?.distribution || {}).sort(function (a, b) { return (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])); });
        const siText = siDist.length > 0
          ? siDist.slice(0, 8).map(function (kv) { return kv[0] + "×" + kv[1]; }).join(" ") + (siDist.length > 8 ? " …（共 " + siDist.length + " 类）" : "")
          : "（无）";
        lines.push("  隐性情绪：" + siText);
        // v6.6.5：把「情感复杂度」也渲染出来 —— 此前渲染层**完全没有这一项** ✗，于是
        // `complexity.level = high` 只出现在结构化字段里，人类读渲染文本看不到它，
        // 更看不到它与 `confidence: "low"` 的矛盾（用户反馈「情感复杂度会直接爆掉」正是这么来的）。
        // 不可采信时**明确写出 level=unknown + 原因**，而不是让读者从数字里自己猜。
        const cx = q.complexity;
        if (cx && typeof cx === "object") {
          lines.push("  情感复杂度 " + (cx.score ?? 0) + "（" + (cx.level ?? "?") + "）"
            + "　熵 " + (cx.entropy ?? 0) + "/" + (cx.maxEntropy ?? 0) + "　多样性 " + (cx.diversity ?? 0)
            + (cx.conflict ? "　主次 " + cx.conflict + "（" + (cx.conflictStrength ?? 0) + "）" : ""));
          if (cx.reliable === false) lines.push("  " + String(cx.reliabilityNote ?? "⚠️ 本项不可采信，请勿据此下结论。"));
        }
      } else {
        lines.push("  情感量化已关闭（emotionComplexity=false，不输出 Δ/V/C 与量化派生项）");
      }
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
      } else lines.push("  " + semanticSkipText(semanticDiagnostics?.reason));
      lines.push("");
      // v6.5.5：报告正文也要写清**取样范围**——独立验证代理指出这一路此前只在 JSON 字段里有范围，
      // 正文的 μ/σ 数字看起来像"全书的"，而它可能是用户勾选的那几章算出来的（同一份文档里
      // 数字与范围分离，读者无从判断）。加在标题行后，读者一眼能看到基准来自哪里。
      lines.push("七、文笔六维基线带（v3.0.0，按章节测 μ±σ，原创/续写风格基线" +
        (result.baselineScope ? "；取样范围：" + result.baselineScope : "") + "）");
      if (result.baseline && result.baselineChapterCount > 0) {
        for (const k of METRIC_ORDER) {
          const b = result.baseline[k];
          lines.push("  " + METRIC_LABELS[k] + " μ=" + b.mu + " σ=" + b.sigma + "（带 " + b.low + " ~ " + b.high + "，推荐容差 ±" + (b.recTol ?? 15) + "%）");
        }
        lines.push("  用途：新章六维应落在带内；novel_style_check 默认按推荐容差（原著章节波动 1.5σ）判定");
        if (result.sceneBaselines && Array.isArray(result.sceneBaselines.availableBands) && result.sceneBaselines.availableBands.length >= 2) {
          lines.push("  分场景参考带（同类型章节 ≥" + MIN_SCENE_BAND_CHAPTERS + " 章时 style_check/fix_plan 优先按此带对照）：");
          for (const bandKey of result.sceneBaselines.availableBands) {
            const sb = result.sceneBaselines.bands?.[bandKey];
            if (!sb || !sb.baseline) continue;
            lines.push("    · " + sb.label + "（" + sb.chapterCount + " 章）：动作=" + sb.baseline.actionDensity.mu + " 句法=" + sb.baseline.complexity.mu + " 修饰=" + sb.baseline.modifierDensity.mu);
          }
        }
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
          // v4.3.0：改用 atomicWriteJson（本文件唯一直接 writeFile 目标文件的地方）——
          // 并发写同一本书的判断或进程中断会留下半截 JSON，后续 action:"get" 直接解析失败
          await atomicWriteJson(reportFile, {
            book,
            savedAt: new Date().toISOString(),
            chars: result.chars,
            judgment,
            fingerprint: analysis.fingerprint,
            culture: result.culture,
            genre: result.genre?.dominant ?? null,
            theme: result.theme?.dominant ?? null,
            emotion: emotionView.cleanDominant ?? null, // v4.3.0：caveat 关闭时不落净化值（与报告同口径）
            vibe: Object.fromEntries(vibe.axes.map((a) => [a.name, a.score])),
            semantic
          });
          saved.savedAt = new Date().toISOString();
        } catch (e) {
          saved.error = String(e).slice(0, 120);
        }
      }
      // v7.3.1 修（#17）：判据改看**落盘结果**（saved.savedAt 只在 atomicWriteJson 成功后赋值），
      // 而不是「有没有传 judgment」——旧版写盘失败仍渲染「✅ 已保存」，与同一返回体的 message 自相矛盾。
      const judgmentSaved = judgment !== "" && saved.savedAt !== void 0 && saved.error === void 0;
      const promptLine = judgment
        ? (judgmentSaved
          ? "\n✅ 风格判断已保存：" + saved.savedAt
          : "\n⚠️ 风格判断**未保存**：" + (saved.error || "落盘失败（原因未知）") + "——判断内容已生成并随本次返回，但没写进 .novel-writer/style-reports/；请检查该目录写权限后带 aiJudgment 重试。")
        : "\n📌 请结合上述六个维度数据判断本书的风格气质、读者感受与写法特征，";
      // v3.9.1 修复：brief=true 时真正精简输出（此前仅附加 brief 字段、report 仍全文+锚包，未达省 token 目的）
      // v5.0.0（降本）：精简工作流开启且调用方没显式指定 brief 时，默认走精简输出（省掉 2k+ 字符的报告全文）
      // v6.2.0：briefMode 的判定与简报文案已上移到重活之前（见函数开头），这里复用同一实现——
      // 走到此处只可能是「brief + 传了 aiJudgment」（要落盘完整判断），故仍需重建 brief 字段。
      // v6.5.5 修正：补第 4 个参（范围标签）——独立复核代理指出此处少传，导致
      // 「brief=true 且传了 aiJudgment」这条路径的简报丢掉「（自定义基线 N 章…）」，
      // 于是同一份工具在两条路径下对基线的说明不一致。
      if (briefMode) result.brief = briefText(result.chars, result.baseline, result.baselineChapterCount,
        result.baselineMode === "custom" ? result.baselineScope : "");
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
        // v6.5.5 修正：这两个键此前只赋在内部 result 上、没进返回对象——schema 里声明了却从不产出，
        // 成了死字段（独立复核代理实测 execute(...).baselineScope === undefined）。
        // 后果不只是字段缺失：完整报告的「七、文笔六维基线带」也不提范围，读报告的人无从知道
        // μ 是取自自定义子集还是全书。故这里必须真的返回。
        baselineScope: result.baselineScope,
        baselineMode: result.baselineMode,
        sceneBaselines: briefMode ? void 0 : result.sceneBaselines,
        report: briefReport !== "" ? briefReport : reportText + promptLine + (judgment ? "" : "然后将判断结论通过 aiJudgment 参数回传，插件会存入 .novel-writer/style-reports/ 供后续续写参考。"),
        // v4.3.0：emotion 取开关裁剪后的视图——caveat 关闭时 cleanDominant 已剥，cleanOutput 会丢掉该键
        dimensions: briefMode ? void 0 : { fingerprint: analysis.fingerprint, culture: result.culture, genre: result.genre?.dominant, theme: result.theme?.dominant, emotion: emotionView.cleanDominant, vibe: Object.fromEntries(vibe.axes.slice(0, 12).map((a) => [a.name, a.score])) },
        semantic: briefMode ? void 0 : semantic.map((s, i) => ({ ...s, discrim: i === 0 && semantic.length >= 2 ? Math.round((semantic[0].score - semantic[1].score) * 1000) / 1000 : null })),
        semanticDiagnostics: briefMode ? void 0 : semanticDiagnostics,
        ...(judgment ? { saved: { savedAt: saved.savedAt, ...(saved.error ? { error: saved.error } : {}) }, savedJudgment: judgment } : {}),
        ...(briefMode ? {} : { anchors: anchorPkg.anchors, skeletons: anchorPkg.skeletons }),
        message: judgment ? (saved?.error ? "风格画像报告已生成，但判断保存失败：" + saved.error : "风格画像报告已生成，判断结果已保存") : (briefMode ? "风格画像简报已生成（精简）" : "风格画像报告已生成（仅测量数据，判断请由 AI 完成并回传保存）")
      });
    }
  });
}

/**
 * v5.0.0：改稿台——把风格诊断从「数据」变成「按优先级排好的待办」，并支持改完复测。
 *
 * 与 novel_style_check 的分工：style_check 给判定与偏差清单（数据），本工具给行动（清单 + 复测三态）。
 * **边界**：hint 只给改写方向，绝不生成改写后的正文——生成是宿主模型的事。
 */
function registerNovelFixPlan(ctx, config) {
  ctx.tools.register({
    name: "novel_fix_plan",
    description: "改稿台(不生成正文)：plan待办/verify复测/mark标记/audit严格对账/audit_brief独立审计/audit_verify复核claims。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名" },
        chapter: { type: "string", description: "章节" },
        action: { type: "string", enum: ["plan", "verify", "mark", "audit", "audit_brief", "audit_verify"], description: "操作(默认plan)" },
        itemId: { type: "string", description: "待办id" },
        state: { type: "string", enum: ["done", "skip"], description: "状态" },
        claims: {
          type: "array",
          description: "audit_verify声明数组(逐条校验原文)",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              contract: { type: "string", description: "契约id(lexicon/banned/slop/loop/outline/ending/bare_dialogue/plot)" },
              line: { type: "number", description: "1-based行号" },
              text: { type: "string", description: "原文子串" },
              why: { type: "string", description: "原因(≤40字)" }
            },
            required: ["contract", "line", "text"]
          }
        },
        root: { type: "string", description: "书库根" }
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
          action: { type: "string" },
          chapter: { type: "object", additionalProperties: true, description: "{ file, number, title }" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                type: { type: "string" },
                locate: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    lineStart: { type: "number" },
                    lineEnd: { type: "number" },
                    excerpt: { type: "string" }
                  },
                  required: ["lineStart", "lineEnd", "excerpt"]
                },
                current: { type: "string" },
                target: { type: "string" },
                anchor: { type: "string" },
                severity: { type: "number" },
                effort: { type: "number" },
                hint: { type: "string" }
              },
              required: ["id", "type", "locate", "current", "target", "anchor", "severity", "effort", "hint"]
            }
          },
          checked: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                type: { type: "string" },
                status: { type: "string", enum: ["resolved", "pending", "new"] },
                detail: { type: "string" }
              },
              required: ["id", "type", "status", "detail"]
            }
          },
          planFile: { type: "string" },
          // v6.5.5：基线范围披露。**必须登记**——本输出 additionalProperties:false，
          // 而 buildFixPlan 现在会返回这两个键（此前它们只落在内部 result 上、从不产出，也没有声明）。
          baselineScope: { type: "string", description: "风格判定的取样范围：按全书 = 「全书除本章外的 N 章」；按部分 = 「自定义基线：可测 N 章（选中 M 章…）」；选择全部失效回退时文案里会注明" },
          baselineMode: { type: "string", enum: ["all", "custom"] },
          sceneBand: { type: "object", additionalProperties: true },
          // v7.2.0 对抗性审计三件套。**必须登记**：本输出 additionalProperties:false，
          // 未登记的键会让宿主整条拒收（这正是我们审查里反复踩到的坑）。
          auditReport: {
            type: "object",
            additionalProperties: false,
            properties: {
              file: { type: "string" },
              chapterNumber: { type: "number" },
              lines: { type: "number" },
              contracts: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: { id: { type: "string" }, label: { type: "string" }, ran: { type: "boolean" }, reason: { type: "string" } },
                  required: ["id", "label", "ran"]
                }
              },
              violations: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    contract: { type: "string" },
                    severity: { type: "number" },
                    title: { type: "string" },
                    line: { type: "number" },
                    text: { type: "string" },
                    detail: { type: "string" }
                  },
                  required: ["contract", "severity", "title", "line", "text", "detail"]
                }
              },
              summary: { type: "string" }
            },
            required: ["file", "lines", "contracts", "violations", "summary"]
          },
          auditBrief: {
            type: "object",
            additionalProperties: false,
            properties: {
              brief: { type: "string", description: "给独立 AI 的审计任务书（Markdown，末尾附正文）" },
              allowedContracts: { type: "array", items: { type: "string" } },
              protocol: { type: "object", additionalProperties: true, description: "机器可读的取证协议（契约清单、字段约束、复核规则）" }
            },
            required: ["brief", "allowedContracts"]
          },
          auditVerify: {
            type: "object",
            additionalProperties: false,
            properties: {
              total: { type: "number" },
              score: { type: "number", description: "可信证据占比（accepted+corrected）/total×100" },
              accepted: { type: "array", items: { type: "object", additionalProperties: true } },
              corrected: { type: "array", items: { type: "object", additionalProperties: true } },
              rejected: { type: "array", items: { type: "object", additionalProperties: true } },
              reason: { type: "string" }
            },
            required: ["total", "score", "accepted", "corrected", "rejected"]
          },
          ok: { type: "boolean" },
          item: { type: "object", additionalProperties: true },
          summary: { type: "string" }
        },
        required: ["book", "action", "summary"]
      },
      render: (_args, value) => {
        const out = [`<path>novels/${value.book}</path>`, "<type>novel-fix-plan</type>", "<content>", "", value.summary];
        // ── v7.2.0 对抗性审计：三条动作各自渲染。**都不给改写建议**，只给事实与证据。
        if (value.auditReport) {
          const r = value.auditReport;
          const skipped = (r.contracts || []).filter((c) => c.ran !== true);
          if (Array.isArray(r.violations) && r.violations.length > 0) {
            out.push("", `对账明细（${r.file}，共 ${r.lines} 行）——只列**能举证**的违约，不评价文笔：`);
            for (const v of r.violations) {
              const flags = v.severity >= 4 ? "硬违约" : "待确认";
              const loc = v.line > 0 ? `第 ${v.line} 行` : "全章层面";
              out.push(`  - [${v.contract}] ${v.title}（${loc}，严重度 ${v.severity}，${flags}）`);
              if (v.text) out.push(`      原文：${v.text}`);
              if (v.detail) out.push(`      依据：${v.detail}`);
            }
          } else {
            out.push("", "对账明细：没有发现**能举证**的违约。（不等于「文笔没问题」——只说明这几类契约没查出硬违约。）");
          }
          if (skipped.length > 0) {
            out.push("", "未跑的契约（**不是「查过没问题」**）：");
            for (const c of skipped) out.push(`  - ${c.label || c.id}：${c.reason || "不可用"}`);
          }
          out.push("", "说明：审计只报能举证的违约，不改正文、不评价文笔；「硬违约」与「待确认」的区别是后者可能是你有意为之（例如临时改了大纲）。");
          // v7.3.1 修（#12）：render 必须返回 content 数组——字符串进 session log 后，下一轮请求会在
          // dsh-llm-deepseek 里抛 TypeError（正常分支见下方 `return [{ type: "text", text: out.join("\\n") }]`）。
          return [{ type: "text", text: out.join("\n") }];
        }
        if (value.auditBrief) {
          out.push("", "【独立审计任务书】把下面**整段**交给一个没有写作上下文的 AI；它返回的 claims 用 action=audit_verify 复核。");
          out.push("", "--- 任务书开始 ---", value.auditBrief.brief || "", "--- 任务书结束 ---");
          out.push("", `允许的契约：${(value.auditBrief.allowedContracts || []).join(" / ")}`);
          // v7.3.1 修（#12）：同 audit 分支——返回 content 数组，不能返回裸字符串（宿主下一轮请求会崩）。
          return [{ type: "text", text: out.join("\n") }];
        }
        if (value.auditVerify) {
          const v = value.auditVerify;
          out.push("", `【证据复核】${v.total} 条声明 → 可信 ${(v.accepted || []).length + (v.corrected || []).length} 条（其中 ${(v.corrected || []).length} 条行号已修正），判废 ${(v.rejected || []).length} 条；可信度 ${v.score}%。`);
          if ((v.accepted || []).length > 0) {
            out.push("", "  ✅ 采纳：");
            for (const c of v.accepted) out.push(`    [${c.contract}] 第 ${c.line} 行：${c.text}`);
          }
          if ((v.corrected || []).length > 0) {
            out.push("", "  ✎ 行号已修正（原文确实在文中，只是行号报错）：");
            for (const c of v.corrected) out.push(`    [${c.contract}] 声明第 ${c.line} 行 → 实际第 ${c.foundLine} 行：${c.text}`);
          }
          if ((v.rejected || []).length > 0) {
            out.push("", "  ✗ 判废（**疑似编造证据**，不要采信）：");
            for (const c of v.rejected) out.push(`    [${c.contract}] 第 ${c.line} 行「${c.text || ""}」——${c.reason}`);
          }
          if (v.total === 0) out.push("", "（没有待复核的声明：audit_verify 需要 claims 数组，格式见 audit_brief 的取证协议。）");
          // v7.3.1 修（#12）：同 audit 分支——返回 content 数组，不能返回裸字符串（宿主下一轮请求会崩）。
          return [{ type: "text", text: out.join("\n") }];
        }
        if (Array.isArray(value.items) && value.items.length > 0) {
          out.push("", `待办 ${value.items.length} 条（按 严重度 → 难度 → 行号 排序）：`);
          // v5.0.0（降本）：明示"分批 + 单次复测"——旧版没有这句，模型会逐条改 + 逐条 mark + 反复 verify，
          // 实测一次改稿 30+ 次调用（每次重发整章），这也是"改稿比单写还贵"的直接原因。
          out.push("  处理建议：**分批改**（同一段落/同一类型的多条合并成一次修改），一轮处理最严重的 3~5 条即可；不必逐条 mark，改完最多 verify 一次。指标类（抽象度/留白/不确定性/情感过直）先判断再动手：抒情、心理、留白段属正常写法，读起来不别扭就保留。");
          for (const it of value.items) {
            const loc = it.locate.lineStart > 0 ? `第 ${it.locate.lineStart}${it.locate.lineEnd !== it.locate.lineStart ? "-" + it.locate.lineEnd : ""} 行` : "全章层面";
            // v5.0.0 修正：把 itemId 渲染出来。此前 mark 需要的 id 只存在于返回体/落盘文件里，
            // 模型要 mark 必须先自己去读 planFile 才能拿到 id——清单里直接给，少一步往返。
            out.push(`  - [${it.type}] 严重度 ${it.severity} / 难度 ${it.effort}（${loc}）`);
            if (it.id) out.push(`      id：${it.id}`);
            if (it.current) out.push(`      现状：${it.current}${it.target ? "　目标：" + it.target : ""}`);
            if (it.locate.excerpt) out.push(`      原句：${it.locate.excerpt}`);
            out.push(`      方向：${it.hint}`);
            if (it.anchor) out.push(`      锚段：${it.anchor}`);
          }
        }
        if (Array.isArray(value.checked) && value.checked.length > 0) {
          out.push("", "复测：");
          for (const c of value.checked) out.push(`  - [${c.status}] ${c.type}：${c.detail}`);
        }
        if (value.item) out.push("", `已标记 ${value.item.id ?? ""} → ${value.item.state ?? ""}`);
        if (value.planFile) out.push("", "清单文件：" + value.planFile);
        out.push("", "提示：hint 只是改写方向，正文由你（宿主模型）来写。", "</content>");
        return [{ type: "text", text: out.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_fix_plan");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const chapterArg = requiredString(args, "chapter");
      const action = ["plan", "verify", "mark", "audit", "audit_brief", "audit_verify"].includes(args?.action) ? args.action : "plan";
      const root = resolveRoot(config, args, exec);
      // ── v7.2.0 对抗性审计：三条动作都**不依赖六维引擎**（对账是对契约，不是对文风），
      // 也就不该被「写作助手总开关」挡住——总开关关着时仍能对账，这是它的价值之一。
      if (action === "audit" || action === "audit_brief" || action === "audit_verify") {
        const chapters = await scanChapters(bookDir(root, book));
        if (chapters.length === 0) throw new Error("书库中没有《" + book + "》的章节文件（可用 novel_books 确认书名）");
        const target = findChapter(chapters, chapterArg);
        if (!target) throw new Error("找不到章节：" + chapterArg + "（可用 novel_chapters 查看清单）");
        const chapterPath = join(bookDir(root, book), target.file);
        const chapterText = await readTextFile(chapterPath, exec);
        const chapter = { file: target.file, number: target.number, title: target.title };
        if (action === "audit") {
          // v7.2.0：把「语义增强」开关透传下去——关掉它时审计也必须跳过 loop/outline，
          // 不能绕过用户设置去跑本地嵌入推理（与改稿台 plan/verify 同口径）。
          const auditState = await readSentenceState();
          const r = await runAuditContracts({ root, book, chapterFile: target.file, text: chapterText, exec, options: { semanticEnabled: semanticFeatureEnabled(auditState) } });
          return dropNullDeep({ book, action, chapter, summary: r.summary, auditReport: r, ok: true });
        }
        if (action === "audit_brief") {
          const b = buildAuditBrief({ book, file: target.file, chapterNumber: target.number, chapterText });
          return dropNullDeep({
            book,
            action,
            chapter,
            summary: "审计任务书已生成。请交给一个**没有写作上下文的** AI 执行，把它返回的 claims 原样传给 action=audit_verify 复核（编造的行号/原文会被判废）。",
            auditBrief: b,
            ok: true
          });
        }
        const claims = Array.isArray(args?.claims) ? args.claims : [];
        const v = verifyAuditClaims({ claims, text: chapterText });
        const summary = v.total === 0
          ? "没有待复核的声明（audit_verify 需要 claims 数组，格式见 audit_brief 的取证协议）"
          : "证据复核：" + v.total + " 条声明，可信 " + (v.accepted.length + v.corrected.length) + " 条"
            + (v.corrected.length > 0 ? "（其中 " + v.corrected.length + " 条行号已修正）" : "")
            + "，判废 " + v.rejected.length + " 条（疑似编造证据）；可信度 " + v.score + "%";
        return dropNullDeep({ book, action, chapter, summary, auditVerify: v, ok: true });
      }
      // mark 只写落盘清单、不动正文，也不依赖六维引擎；plan/verify 依赖引擎，门禁与 novel_style_check 对齐
      if (action === "mark") {
        const itemId = requiredString(args, "itemId");
        const itemState = ["done", "skip"].includes(args?.state) ? args.state : void 0;
        // v5.0.0 修正：区分"没传"与"传了非法值"——旧文案在传了非法值时也说"需要 state 参数"，容易误判。
        assert(itemState !== void 0, args?.state === void 0
          ? 'novel_fix_plan mark 缺少 state 参数：只能是 "done"（已改）或 "skip"（跳过不改）'
          : 'novel_fix_plan mark 的 state 只能是 "done"（已改）或 "skip"（跳过不改），收到：' + JSON.stringify(args.state));
        const r = await markFixItem(root, book, chapterArg, itemId, itemState, {}, exec);
        return dropNullDeep({ book, action, summary: `已把待办 ${itemId} 标记为 ${itemState}（正文与判定不受影响，只记录处置状态）`, ok: r.ok, item: r.item });
      }
      const state = await readSentenceState();
      const effective = effectiveSentenceAnalysis(config, state);
      assert(effective.enabled, "写作助手功能（句式模式分析）当前已关闭，可在侧边栏「写作助手功能」面板开启后再用改稿台。");
      if (action === "verify") {
        const r = await verifyFixPlan(root, book, chapterArg, {}, exec);
        return dropNullDeep({ ...r, action });
      }
      const r = await buildFixPlan(root, book, chapterArg, {}, exec);
      return dropNullDeep({ ...r, action });
    }
  });
}

export {
  registerNovelSentenceAnalysis,
  registerNovelStyleCheck,
  registerNovelStyleReport,
  registerNovelFixPlan
};
