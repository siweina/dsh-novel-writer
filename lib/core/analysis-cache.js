/**
 * dsh-novel-writer — core/analysis-cache.js（Layer 3B：语义裁决、隐性情感增强与逐章/全书分析缓存）
 *
 * 严格 DAG 3B 层：只依赖 Node 内置、../analysis.js、../style-metrics.js、../db.js、../log.js、
 * ../embedding.js、./state.js、./text.js 与 Layer 3A 的 ./rules.js，不依赖 http。
 */

import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { analyzeText, METRIC_CALIBER } from "../analysis.js";
import { classifyChapterScene, measureStyleMetrics } from "../style-metrics.js";
import { libraryDbPath, readAnalysisCache, readChapterMetrics, writeAnalysisCache, writeChapterMetrics } from "../db.js";
import { logEvent } from "../log.js";
import * as embedding from "../embedding.js";
import {
  CACHE_VERSION, sanitizeSegment, isAbort, novelDataDir, bookDir,
  featureEnabled, semanticFeatureEnabled, atomicWriteJson
} from "./state.js";
import { scanChapters, readTextFile } from "./text.js";
import { detectCulture, detectGenre, detectTheme } from "./rules.js";

const VIBE_POS_PROTOTYPES = [
  "阳光暖融融地照在身上，心里踏实又安宁",
  "他笑起来的时候，整个世界都明亮了",
  "温暖从心底慢慢升起来，像融化的蜜",
  "这一刻真好，所有的疲惫都被抚平了",
  "她闭上眼睛，嘴角不自觉地上扬"
];
const VIBE_NEG_PROTOTYPES = [
  "黑暗里有什么在逼近，他说不清自己在怕什么",
  "有些秘密知道得越多越危险，可他已回不了头",
  "心里发紧，像有什么东西在缓缓靠近",
  "那晚的潮声格外浓稠，像是海底有什么在翻身",
  "她说不出哪里不对，只是觉得浑身发冷"
];
export async function resolveAmbiguousCarriers(implicit) {
  if (!implicit || !Array.isArray(implicit.ambiguous) || implicit.ambiguous.length === 0) return implicit;
  let posV = null, negV = null;
  // v4.0.0 修正：直接用顶部静态 import（此前的动态 import 与它重复，且 emb 永不为假）
  try {
    posV = await embedding.embed(VIBE_POS_PROTOTYPES.join("；"));
    negV = await embedding.embed(VIBE_NEG_PROTOTYPES.join("；"));
  } catch {
    // v6.6.0：原型句嵌入失败＝语义引擎不可用/模型加载失败。裁决静默退回规则版，而调用方
    // 只看得到"没有 resolved 数组"——与"本来就没有歧义项"表现完全一样，必须留痕。
    logEvent("engine", { source: "core.resolveAmbiguousCarriers", detail: "语义原型句嵌入失败，歧义裁决退回规则版" });
    return implicit;
  }
  if (!posV || !negV) return implicit;
  const resolvedList = [];
  let negAdd = 0, posAdd = 0, stillAmb = 0;
  for (const item of implicit.ambiguous) {
    try {
      const ctxV = await embedding.embed(item.ctx);
      const posSim = embedding.cosine(ctxV, posV);
      const negSim = embedding.cosine(ctxV, negV);
      if (Math.abs(posSim - negSim) >= 0.05) {
        const dir = posSim > negSim ? "pos" : "neg";
        resolvedList.push({ ...item, verdict: dir, posSim: Math.round(posSim * 1000) / 1000, negSim: Math.round(negSim * 1000) / 1000 });
        if (dir === "neg") negAdd += 1; else posAdd += 1;
      } else {
        stillAmb += 1;
        resolvedList.push({ ...item, verdict: "undecided", posSim: Math.round(posSim * 1000) / 1000, negSim: Math.round(negSim * 1000) / 1000 });
      }
    } catch (e) {
      // v4.0.0 修正：单条 embed 失败也必须回填进 resolvedList——旧版只加计数，
      // 该项既不在 resolved 也不在 ambiguous 里，报告里静默少一个歧义项（占比却被抬高）
      // v6.6.0：单条推理失败是"引擎正在坏"的最早信号（原因只写进该项的 error 字段，没人会看）
      logEvent("engine", { source: "core.resolveAmbiguousCarriers", detail: "歧义项上下文嵌入失败：" + (e?.message ?? e) });
      stillAmb += 1;
      resolvedList.push({ ...item, verdict: "undecided", error: String(e).slice(0, 60) });
    }
  }
  // v3.9.5 修正：以加权命中计数重算（上游 implicit 现带 negHits/posHits/ambHits），
  // 不再把 0~1 占比当“次数”直接相加——旧逻辑在 hits 多而歧义词少时会把负向占比抬到荒谬水平
  const negHits0 = Number.isFinite(implicit.negHits) ? implicit.negHits : Number.isFinite(implicit.totalHits) && implicit.negative > 0 ? implicit.negative * implicit.totalHits : 0;
  const posHits0 = Number.isFinite(implicit.posHits) ? implicit.posHits : Number.isFinite(implicit.totalHits) && implicit.positive > 0 ? implicit.positive * implicit.totalHits : 0;
  const ambHits0 = Number.isFinite(implicit.ambHits) ? implicit.ambHits : 0;
  const negW = Math.max(0, negHits0 + negAdd * 0.5);
  const posW = Math.max(0, posHits0 + posAdd * 0.5);
  const ambW = Math.max(0, ambHits0 - (negAdd + posAdd));
  const totalW = negW + posW + ambW;
  // v6.3.0 修正（旧清单 #28 同款，与 analysis.js 同一改法）：三项此前各自独立四舍五入到两位小数，
  // 和可以 >1——negW=4/posW=1/ambW=1 时得 0.67+0.17+0.17=1.01，而 lib/index.js 的「意象」行会把
  // negative/positive/ambiguousRatio 直接按百分比渲染给模型（「负 67% / 正 17% / 歧义 17%」，101% 用户可见）。
  // 现改为：先算 negative（照常四舍五入），第三项按"余量"派生，三项之和恒 = 1（无命中时三项均为 0）。
  const negative = totalW === 0 ? 0 : Math.round((negW / totalW) * 100) / 100;
  let positive = totalW === 0 ? 0 : Math.round((posW / totalW) * 100) / 100;
  let ambiguousRatio = totalW === 0 ? 0 : Math.round((ambW / totalW) * 100) / 100;
  if (totalW > 0) {
    if (ambW === 0) {
      // 只有已裁决命中（无歧义）：余量必须落在 positive，否则 0.125+0.875 会渲染成 0.13+0.88=1.01
      // （analysis.js 的同款修法把余量派生给 ambiguousRatio；此处歧义项必须为 0，故余量归 positive）。
      positive = Math.max(0, Math.round((1 - negative) * 100) / 100);
    } else {
      ambiguousRatio = Math.max(0, Math.round((1 - negative - positive) * 100) / 100);
    }
  }
  return {
    ...implicit,
    negative,
    positive,
    ambiguousRatio,
    negHits: Math.round(negW * 1000) / 1000,
    posHits: Math.round(posW * 1000) / 1000,
    ambHits: Math.round(ambW * 1000) / 1000,
    // v4.0.0 修正：口径同步——negative/positive 已改三分（分母含 ambW），totalHits 必须跟着更新，
    // 否则 totalHits !== negHits + posHits（上游 analysis.js 是两分口径）
    totalHits: Math.round((negW + posW) * 1000) / 1000,
    ambiguous: stillAmb > 0 ? resolvedList.filter((r) => r.verdict === "undecided") : [],
    resolved: resolvedList.filter((r) => r.verdict !== "undecided")
  };
}

export async function enrichSemanticImplicit(state, root, book, result, exec, scope) {
  try {
    if (!semanticFeatureEnabled(state, "semanticImplicit")) {
      // v3.9.5 修正：功能关闭时清除缓存/结果中遗留的 semanticImplicit（兑现“关闭后该输出消失”契约）
      if (result?.emotion?.quantification?.semanticImplicit) delete result.emotion.quantification.semanticImplicit;
      return result;
    }
    if (!(await embedding.isAvailable())) {
      // v3.9.5 修正：引擎不可用时同样清除旧语义结果，避免陈旧越界数据残留
      if (result?.emotion?.quantification?.semanticImplicit) delete result.emotion.quantification.semanticImplicit;
      return result;
    }
    // v3.9.0 修正：缓存已带 semanticImplicit（miss 路径算好写盘的）→ 直接复用，不再重建索引全量读盘
    const existed = result?.emotion?.quantification?.semanticImplicit;
    if (existed) {
      const hits = Array.isArray(existed.hits) ? existed.hits : [];
      // v3.9.1 范围校验：单章分析时命中必须全部落在本章；全书分析（scope=undefined）不做约束
      const inScope = scope === void 0 || hits.length === 0 || hits.every((h) => h.chapter === scope);
      if (inScope) return result;
      delete result.emotion.quantification.semanticImplicit; // 越界旧缓存 → 重算修正
    }
    const dir = bookDir(root, book);
    const chapters = await scanChapters(dir);
    // v3.9.1：单章范围只读该章文本（避免整书读盘与检索越界）；全书照旧
    const targets = scope === void 0 ? chapters : chapters.filter((c) => c.file === scope);
    if (targets.length === 0) return result;
    const chunks = [];
    for (const chapter of targets) {
      const text = await readTextFile(join(dir, chapter.file), exec);
      // v2.6.0：章节标记直接用文件名（chunkText 只认"第X章"标题行，无标题行时检索结果无法定位章节）
      for (const p of embedding.chunkText(text, { chapter: chapter.file })) chunks.push({ ...p, id: chapter.file + "|" + p.id, chapter: chapter.file });
    }
    // v2.5.0 修复轮 4：内容指纹失效重建——章节更新后旧缓存不再命中（不靠版本号）
    // v2.6.0：增量构建——指纹变化时只对新/变化的段落做推理，其余复用旧向量
    const { items: cachedIndex, fp: cachedFp } = embedding.loadIndexMeta(root, book);
    let index;
    if (scope !== void 0) {
      // v3.9.1 单章范围：复用全书缓存中本章向量（增量只补缺失段），不写盘——避免污染全书指纹缓存
      const cachedForScope = (cachedIndex || []).filter((it) => it.chapter === scope);
      index = await embedding.buildIndexIncremental(chunks, cachedForScope);
    } else {
      const indexFp = embedding.fingerprint(chunks);
      index = cachedIndex;
      if (!index || index.length === 0 || cachedFp !== indexFp) {
        index = await embedding.buildIndexIncremental(chunks, cachedIndex);
        // v4.0.0：saveIndex 失败返回 false（C 已改为内部按实际写入条目重算指纹，第 4 个参数废弃）
        // 这里没有 message 通道，用中性前缀告警一次（不带 [novel-writer] 前缀，避免被 e2e 告警护栏误判）
        if (embedding.saveIndex(root, book, index) === false) {
          console.warn("[novel-writer-index] 索引缓存写入失败，下次调用会重建：" + (embedding.status?.().lastCacheError ?? "未知原因"));
        }
      }
    }
    const implicit = await embedding.detectImplicitEmotions(index);
    if (result.emotion?.quantification) {
      result.emotion.quantification.semanticImplicit = implicit;
    }
  } catch (e) {
    // v6.2.1 修正：取消必须放行（isAbort 注释：任何 catch 降级分支都必须先用它放行）。
    // 本 try 覆盖 readTextFile（转发 exec.signal）与整段 embedding 推理——吞掉取消会让调用方
    // 拿到一份"成功但字段缺失"的报告，把用户的中止伪装成完成。
    if (isAbort(e)) throw e;
    /* 语义增强失败不影响规则结果 */
    // v6.6.0：语义失败会让报告"少一块隐性情感"，而输出与"这本书没有隐性情感"完全一样——留痕
    logEvent("engine", { book, root, source: "core.enrichSemanticImplicit", detail: "语义增强失败（隐性情感/意象裁决缺失）：" + (e?.message ?? e) });
  }
  return result;
}
export function cropEmotion(emotion) {
  if (!emotion) return emotion;
  return {
    dominant: emotion.dominant,
    scores: emotion.scores,
    intensity: emotion.intensity,
    topWords: emotion.topWords,
    curve: emotion.curve
  };
}

function chapterMetricHash(text) {
  return createHash("sha1").update(text).digest("hex");
}

function legacyChaptersFingerprint(chapters) {
  return createHash("sha1").update(
    chapters.slice()
      .sort(function (a, b) { return String(a.file).localeCompare(String(b.file)); })
      .map(function (c) { return String(c.file) + "\u0000" + c.text; })
      .join("\u0001")
  ).digest("hex").slice(0, 16);
}

function parseSqliteChapterRow(row) {
  if (!row || typeof row !== "object") return null;
  let metrics = null;
  try {
    metrics = JSON.parse(row.metrics_json);
  } catch {
    return null;
  }
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  let scene = null;
  if (typeof row.scene_json === "string" && row.scene_json !== "") {
    try {
      const parsedScene = JSON.parse(row.scene_json);
      if (parsedScene && typeof parsedScene === "object" && !Array.isArray(parsedScene)) {
        scene = parsedScene;
      }
    } catch {
      scene = null;
    }
  }
  return { metrics, scene };
}

export async function metricChaptersCached(root, book, chapters, opts = {}) {
  const safeBook = sanitizeSegment(book, "book");
  const readOnly = opts?.readOnly === true;
  const caliber = METRIC_CALIBER;
  const list = Array.isArray(chapters) ? chapters : [];
  const qualifying = [];
  for (const ch of list) {
    if (!ch || typeof ch.text !== "string" || ch.text.trim().length < 40) continue;
    qualifying.push({
      file: ch.file,
      chapterKey: String(ch.file ?? ""),
      text: ch.text,
      contentHash: chapterMetricHash(ch.text),
      size: ch.text.length
    });
  }

  let dbCache = { rows: [], byChapter: new Map() };
  try {
    dbCache = readChapterMetrics(root, safeBook, { readOnly: true });
  } catch (e) {
    if (isAbort(e)) throw e;
    dbCache = { rows: [], byChapter: new Map() };
  }

  // v4.0.0 修正：指纹改为与章序无关（按文件名排序后拼 file+text）——style_check 传"其他章 + 目标章"、
  // style_report/new_chapter 传书序，旧版三处哈希互不相同 → 每次交替调用都 miss 并重写同一缓存文件
  if (dbCache.rows.length === 0) {
    const legacyFile = join(novelDataDir(root), "analysis", safeBook + "-chapters-metrics.json");
    if (existsSync(legacyFile)) {
      try {
        const cached = JSON.parse(await readFile(legacyFile, "utf8"));
        const th = legacyChaptersFingerprint(list);
        if (cached && cached.th === th && Array.isArray(cached.perChapter) && cached.ver === CACHE_VERSION) {
          const legacyByFile = new Map();
          for (const pc of cached.perChapter) {
            if (pc && typeof pc === "object" && pc.metrics && typeof pc.metrics === "object" && !Array.isArray(pc.metrics)) {
              legacyByFile.set(String(pc.file ?? ""), pc);
            }
          }
          const perChapter = [];
          const rowsToWrite = [];
          let validLegacy = true;
          for (const item of qualifying) {
            const legacy = legacyByFile.get(item.chapterKey);
            if (!legacy) {
              validLegacy = false;
              break;
            }
            const scene = legacy.scene?.band
              ? legacy.scene
              : classifyChapterScene({ text: item.text, metrics: legacy.metrics });
            perChapter.push({ file: item.file, metrics: legacy.metrics, scene });
            rowsToWrite.push({
              chapter: item.chapterKey,
              content_hash: item.contentHash,
              size: item.size,
              caliber,
              metrics_json: legacy.metrics,
              scene_json: scene
            });
          }
          if (validLegacy) {
            if (!readOnly && rowsToWrite.length > 0) {
              try {
                writeChapterMetrics(root, safeBook, rowsToWrite, true);
              } catch (e) {
                if (isAbort(e)) throw e;
                logEvent("cache", { file: libraryDbPath(root), book: safeBook, level: "warn", detail: "逐章六维测量缓存写入失败（后续每次都会重算）" });
              }
            }
            return perChapter;
          }
        }
      } catch (e) {
        if (isAbort(e)) throw e;
        /* 无缓存/损坏 */
      }
    }
  }

  const perChapter = [];
  const rowsToWrite = [];
  const keepChapters = new Set();
  let needsWrite = false;

  for (const item of qualifying) {
    keepChapters.add(item.chapterKey);
    const existing = dbCache.byChapter.get(item.chapterKey);
    let metrics = null;
    let scene = null;
    let matchedRow = false;
    let preserveUpdatedAt = false;

    if (
      existing
      && existing.caliber === caliber
      && existing.content_hash === item.contentHash
      && existing.size === item.size
    ) {
      const parsed = parseSqliteChapterRow(existing);
      if (parsed) {
        metrics = parsed.metrics;
        scene = parsed.scene;
        matchedRow = true;
        if (!scene?.band) {
          scene = classifyChapterScene({ text: item.text, metrics });
          needsWrite = true;
        } else {
          preserveUpdatedAt = Number.isFinite(existing.updated_at);
        }
      }
    }

    if (!matchedRow) {
      metrics = measureStyleMetrics(item.text).metrics;
      scene = classifyChapterScene({ text: item.text, metrics });
      needsWrite = true;
    }

    perChapter.push({ file: item.file, metrics, scene });
    rowsToWrite.push({
      chapter: item.chapterKey,
      content_hash: item.contentHash,
      size: item.size,
      caliber,
      metrics_json: metrics,
      scene_json: scene,
      ...(preserveUpdatedAt ? { updated_at: existing.updated_at } : {})
    });
  }

  if (!needsWrite && dbCache.rows.some((r) => !keepChapters.has(r.chapter))) {
    needsWrite = true;
  }

  if (!readOnly && needsWrite) {
    try {
      writeChapterMetrics(root, safeBook, rowsToWrite, true);
    } catch (e) {
      if (isAbort(e)) throw e;
      // v6.6.0：写不进去 → 之后每次调用都重算逐章六维（慢，且结果看上去完全正常）。
      // "缓存反复写失败"正是单次调用看不出来、只有日志能暴露的那类问题。
      logEvent("cache", { file: libraryDbPath(root), book: safeBook, level: "warn", detail: "逐章六维测量缓存写入失败（后续每次都会重算）" });
    }
  }

  return perChapter;
}

function resolveBookCacheKeyAndBook(keyName) {
  const safeKey = sanitizeSegment(keyName, "book");
  const cacheBook = safeKey.endsWith("__base") && safeKey.length > 6 ? safeKey.slice(0, -6) : safeKey;
  return { safeKey, cacheBook, cacheKey: "book_full:" + safeKey };
}

export async function bookAnalysisCached(root, keyName, text, featState, opts = {}) {
  const { safeKey, cacheBook, cacheKey } = resolveBookCacheKeyAndBook(keyName);
  const readOnly = opts?.readOnly === true;
  const caliber = METRIC_CALIBER;
  const dir = join(novelDataDir(root), "analysis");
  const file = join(dir, safeKey + "-full.json");
  const th = createHash("sha1").update(text).digest("hex").slice(0, 16);
  let cached = null;
  let hitFromSqlite = false;
  try {
    const dbRow = readAnalysisCache(root, cacheKey, {
      kind: "book_full",
      fingerprint: th,
      caliber,
      readOnly: true
    });
    if (dbRow && dbRow.payload && dbRow.payload.analysis) {
      cached = dbRow.payload;
      hitFromSqlite = true;
    }
  } catch (e) {
    if (isAbort(e)) throw e;
    cached = null;
  }
  if (!cached) {
    try {
      const legacy = JSON.parse(await readFile(file, "utf8"));
      if (legacy && legacy.th === th && legacy.analysis && legacy.ver === CACHE_VERSION) {
        cached = legacy;
      }
    } catch { /* 无缓存/损坏 */ }
  }
  // v3.5.0 #21/22：缓存带算法版本指纹（ver）——升级后旧缓存自动失效；命中时按开关重算 genre/theme（关→开也能拿到）
  if (cached && cached.th === th && cached.analysis) {
    const det = cached.detection ? { ...cached.detection } : {};
    let recomputed = false;
    if (featState && featureEnabled(featState, "genreTheme")) {
      if (!det.genre) { try { det.genre = detectGenre(text); recomputed = true; } catch { logEvent("silent_skip", { file, detail: "流派识别失败（缓存补算路径，该维度缺省）" }); } }
      if (!det.theme) { try { det.theme = detectTheme(text); recomputed = true; } catch { logEvent("silent_skip", { file, detail: "题材识别失败（缓存补算路径，该维度缺省）" }); } }
    } else {
      det.genre = undefined;
      det.theme = undefined;
    }
    // v4.0.0：语义层结果缓存读取（隐性情感 + 意象歧义裁决）——旧缓存缺字段/指纹不符时按"未缓存"处理（返回 null，由调用方重算并写回）
    const semanticFpOk = cached.semanticFp === th;
    const semantic = semanticFpOk && cached.semanticImplicit ? cached.semanticImplicit : null;
    const implicitResolved = semanticFpOk && cached.implicitResolved ? cached.implicitResolved : null;
    // v3.5.0 #21：补算结果写回缓存——下次命中不再重扫全书流派/题材词表
    if (!readOnly && (recomputed || !hitFromSqlite)) {
      // v4.0.0：写回时保留语义缓存字段——旧版重建 payload 会把语义结果抹掉，导致每次调用都重跑语义推理
      const keepSemantic = {};
      if (semantic) keepSemantic.semanticImplicit = semantic;
      if (implicitResolved) keepSemantic.implicitResolved = implicitResolved;
      if (semantic || implicitResolved) keepSemantic.semanticFp = th;
      try {
        writeAnalysisCache(root, {
          cache_key: cacheKey,
          kind: "book_full",
          book: cacheBook,
          fingerprint: th,
          caliber,
          payload: { th, analysis: cached.analysis, detection: det, ver: CACHE_VERSION, ...keepSemantic }
        });
      } catch {
        logEvent("cache", { file: libraryDbPath(root), level: "warn", detail: "全书分析缓存写回失败（流派/题材补算结果没落盘，下次仍要重算）" });
      }
    }
    return { analysis: cached.analysis, detection: det, file, root, cacheKey, book: cacheBook, th, caliber, readOnly, semantic, implicitResolved };
  }
  const analysis = analyzeText(text, {});
  const detection = detectCulture(text);
  if (featState && featureEnabled(featState, "genreTheme")) {
    detection.genre = detectGenre(text);
    detection.theme = detectTheme(text);
  }
  if (!readOnly) {
    try {
      writeAnalysisCache(root, {
        cache_key: cacheKey,
        kind: "book_full",
        book: cacheBook,
        fingerprint: th,
        caliber,
        payload: { th, analysis, detection, ver: CACHE_VERSION }
      });
    } catch {
      // v6.6.0：全书分析缓存写不进去 → 每次调用都重算（大书代价明显），而本次返回完全正常
      logEvent("cache", { file: libraryDbPath(root), level: "warn", detail: "全书分析缓存写入失败（后续每次都会重算全书分析）" });
    }
  }
  return { analysis, detection, file, root, cacheKey, book: cacheBook, th, caliber, readOnly, semantic: null, implicitResolved: null };
}
export async function writeBookSemanticCache(info, semanticImplicit, implicitResolved) {
  if (!info || !info.th) return;
  if (info.readOnly === true) return;
  if (typeof info.root === "string" && info.root !== "" && typeof info.cacheKey === "string" && info.cacheKey !== "") {
    const caliber = info.caliber || METRIC_CALIBER;
    const cacheBook = info.book || (info.cacheKey.startsWith("book_full:") ? info.cacheKey.slice("book_full:".length) : "");
    try {
      const existing = readAnalysisCache(info.root, info.cacheKey, {
        kind: "book_full",
        fingerprint: info.th,
        caliber,
        readOnly: true
      });
      let payload = existing?.payload && typeof existing.payload === "object" ? { ...existing.payload } : null;
      if (!payload || payload.th !== info.th) {
        payload = { th: info.th, analysis: info.analysis, detection: info.detection, ver: CACHE_VERSION };
      }
      if (semanticImplicit) payload.semanticImplicit = semanticImplicit; else delete payload.semanticImplicit;
      if (implicitResolved) payload.implicitResolved = implicitResolved; else delete payload.implicitResolved;
      if (semanticImplicit || implicitResolved) payload.semanticFp = info.th; else delete payload.semanticFp;
      writeAnalysisCache(info.root, {
        cache_key: info.cacheKey,
        kind: "book_full",
        book: cacheBook,
        fingerprint: info.th,
        caliber,
        payload
      });
    } catch {
      // v6.6.0：语义结果没写回缓存 → 下次命中仍要重跑全书索引 + 原型推理（用户只觉得"某个功能有点慢"）
      logEvent("cache", { file: libraryDbPath(info.root), book: cacheBook, level: "warn", detail: "语义结果写回分析缓存失败（下次会重跑全书语义推理）" });
    }
    return;
  }
  if (!info.file) return;
  try {
    let payload = null;
    try { payload = JSON.parse(await readFile(info.file, "utf8")); } catch { /* 缓存被删/损坏 → 重建 */ }
    if (!payload || payload.th !== info.th || payload.ver !== CACHE_VERSION) {
      payload = { th: info.th, analysis: info.analysis, detection: info.detection, ver: CACHE_VERSION };
    }
    if (semanticImplicit) payload.semanticImplicit = semanticImplicit; else delete payload.semanticImplicit;
    if (implicitResolved) payload.implicitResolved = implicitResolved; else delete payload.implicitResolved;
    if (semanticImplicit || implicitResolved) payload.semanticFp = info.th; else delete payload.semanticFp;
    await mkdir(dirname(info.file), { recursive: true });
    await atomicWriteJson(info.file, payload);
  } catch {
    // v6.6.0：语义结果没写回缓存 → 下次命中仍要重跑全书索引 + 原型推理（用户只觉得"某个功能有点慢"）
    logEvent("cache", { file: info.file, level: "warn", detail: "语义结果写回分析缓存失败（下次会重跑全书语义推理）" });
  }
}
