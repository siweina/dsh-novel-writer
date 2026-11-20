/**
 * dsh-novel-writer — core/domain.js（Layer 3：语义裁决、文化题材与语用规则、基线锚包、伏笔/设定/词表/摘要/大纲）
 *
 * 严格 DAG 第三层：只依赖 Node 内置、./state.js、./text.js 与领域词表/度量/分析模块，不依赖 http。
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { analyzeText, actionChainCandidates, METRIC_CALIBER } from "../analysis.js";
import { classifyChapterScene, computeBaseline, measureStyleMetrics, METRIC_ORDER } from "../style-metrics.js";
import { libraryDbPath, readAnalysisCache, readChapterMetrics, writeAnalysisCache, writeChapterMetrics } from "../db.js";
import { CULTURE_MARKERS, GENRE_MARKERS, THEME_MARKERS, DEFAULT_BANNED_WORDS, SPEECH_STYLE_RULES } from "../lexicons/markers.js";
import { COLLISION_GUARDS } from "../lexicons/guards.js";
import { logEvent } from "../log.js";
import * as embedding from "../embedding.js";
import { normalizePack, resolvePackForBook } from "../packs.js";
import {
  CACHE_VERSION, assert, requiredString, sanitizeSegment, isAbort, resolveRoot,
  novelDataDir, bookDir, featureEnabled, semanticFeatureEnabled, assertToolEnabled,
  readSentenceState, readSentenceStateSync, writeSentenceState, atomicWriteJson, noteRoot, withFileTx
} from "./state.js";
import {
  OUTLINE_LINE_RE, MAX_CHAPTER_NUMBER, parseChapterNumber, scanChapters, readTextFile
} from "./text.js";

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
  const resolvedWeight = (negAdd + posAdd) * 0.5;
  const negW = Math.max(0, negHits0 + negAdd * 0.5);
  const posW = Math.max(0, posHits0 + posAdd * 0.5);
  const ambW = Math.max(0, ambHits0 - resolvedWeight);
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

/**
 * 该命中是否为**子串巧合**（应当忽略）。
 *
 * 判据极简且可审计：词**紧邻的前/后一个字**是否落在守卫表里。
 * 例：「这[里正]是」的前一字是「这」→ 巧合；「[在下]面」的后一字是「面」→ 巧合。
 *
 * 纪律：**错填会吃掉真命中**（静默漏报），所以守卫表只收有实证的字（见 lexicons/guards.js）。
 */
export function isGuardedArtifact(word, line, index) {
  const g = COLLISION_GUARDS[word];
  if (!g || typeof line !== "string" || !Number.isInteger(index) || index < 0) return false;
  // ① 单字邻接（最常见：这里+正是 / 在+下面 / 大+人物）
  if (Array.isArray(g.notBefore) && index > 0) {
    const before = line[index - 1];
    if (before && g.notBefore.includes(before)) return true;
  }
  if (Array.isArray(g.notAfter)) {
    const after = line[index + word.length];
    if (after && g.notAfter.includes(after)) return true;
  }
  // ② 多字序列（单字判不到的：如「老夫老妻」——匹配后紧跟的是「老」，而「老夫老矣」是真用法，
  //    故不能简单把「老」放进 notAfter，必须判完整的「老妻」序列）
  if (Array.isArray(g.notAfterSeq)) {
    for (const s of g.notAfterSeq) {
      if (typeof s === "string" && s !== "" && line.startsWith(s, index + word.length)) return true;
    }
  }
  if (Array.isArray(g.notBeforeSeq)) {
    for (const s of g.notBeforeSeq) {
      if (typeof s === "string" && s !== "" && index >= s.length && line.slice(index - s.length, index) === s) return true;
    }
  }
  return false;
}

const SORTED_MARKER_WORDS = new Map();
function sortedMarkerWords(words) {
  let cached = SORTED_MARKER_WORDS.get(words);
  if (cached === undefined) {
    cached = words.slice().sort(function (a, b) { return b.length - a.length; });
    SORTED_MARKER_WORDS.set(words, cached);
  }
  return cached;
}
function scanWordHits(text, words) {
  const used = new Uint8Array(text.length);
  const hits = [];
  for (const word of sortedMarkerWords(words)) {
    const wlen = word.length;
    // v4.3.0 修正：补空词条守卫——wlen===0 时 from = hit + 0 不推进，while 条件恒真 → 死循环。
    // 当前词表无空串，属"缺守卫"的潜在缺陷（词典/自定义词表一旦引入空串就是挂死）
    if (wlen <= 0) continue;
    let n = 0;
    let from = 0;
    while (from <= text.length - wlen) {
      const hit = text.indexOf(word, from);
      if (hit === -1) break;
      if (isGuardedArtifact(word, text, hit)) {
        from = hit + wlen;
        continue;
      }
      let blocked = false;
      for (let i = hit; i < hit + wlen; i += 1) {
        if (used[i] === 1) { blocked = true; break; }
      }
      if (!blocked) {
        n += 1;
        for (let i = hit; i < hit + wlen; i += 1) used[i] = 1;
      }
      from = hit + wlen;
    }
    if (n > 0) hits.push({ word, count: n });
  }
  return hits;
}
export function detectCulture(text) {
  const scores = { western: 0, eastern: 0, modern: 0 };
  const evidence = { western: [], eastern: [], modern: [] };
  // v3.5.0 M4：词表去重扫描（同表重复词如 城堡×2/便利店×2 不再双计）
  // v3.6.0：同文化子串最长匹配（"高潮迭起"命中后 "高潮" 不再重复计）
  // v4.0.0：改单遍 + 占用位图（重复词第二次扫描命中 0，与旧占位替换等价）
  for (const [culture, table] of Object.entries(CULTURE_MARKERS)) {
    for (const hit of scanWordHits(text, table.words)) {
      scores[culture] += hit.count;
      if (evidence[culture].length < 8) evidence[culture].push(hit.word + "×" + hit.count);
    }
  }
  const total = scores.western + scores.eastern + scores.modern;
  let culture = "unknown";
  let confidence = 0;
  if (total > 0) {
    // v1.0.2：modern 优先——现代词命中足够多时直接判现代（避免剧情西式词误导）
    const cultureTotal = scores.western + scores.eastern;
    if (scores.modern >= 5 && scores.modern >= Math.max(scores.western, scores.eastern, 1)) {
      culture = "modern";
      confidence = Math.min(0.95, 0.5 + scores.modern / (total * 2));
    } else if (cultureTotal > 0) {
      const ratio = scores.western / Math.max(scores.eastern, 1);
      if (ratio >= 2) { culture = "western"; confidence = Math.min(0.95, 0.5 + scores.western / (total * 2)); }
      else if (ratio <= 0.5) { culture = "eastern"; confidence = Math.min(0.95, 0.5 + scores.eastern / (total * 2)); }
      else { culture = "mixed"; confidence = 0.5; }
    } else {
      culture = "modern";
      confidence = Math.min(0.95, 0.5 + scores.modern / (total * 2));
    }
  }
  return { culture, confidence: Math.round(confidence * 100) / 100, scores, evidence, total };
}
export function detectGenre(text) {
  const hits = {};
  const evidence = {};
  // v3.7.0 引擎①：同流派子串最长匹配（"魔法师"不再被 魔法+法师+魔法师 计 3 次；先长后短 + 占位）
  // v4.0.0：单遍 + 占用位图
  for (const [genre, words] of Object.entries(GENRE_MARKERS)) {
    let count = 0;
    const found = [];
    for (const hit of scanWordHits(text, words)) {
      count += hit.count;
      if (found.length < 6) found.push(hit.word + "×" + hit.count);
    }
    if (count > 0) { hits[genre] = count; evidence[genre] = found; }
  }
  // v1.5.0：count < 5 视为噪音省略
  const filtered = Object.entries(hits).filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]);
  return {
    dominant: filtered[0]?.[0] ?? null,
    genres: filtered.slice(0, 3).map(([g, n]) => ({ genre: g, count: n })),
    evidence
  };
}
export function detectTheme(text) {
  const hits = {};
  const evidence = {};
  for (const [theme, words] of Object.entries(THEME_MARKERS)) {
    let count = 0;
    const found = [];
    // v3.5.0：同主题子串最长匹配（"高潮迭起"命中后 "高潮" 不再重复计；先长后短 + 占位）
    // v4.0.0：单遍 + 占用位图
    for (const hit of scanWordHits(text, words)) {
      count += hit.count;
      if (found.length < 6) found.push(hit.word + "×" + hit.count);
    }
    if (count > 0) { hits[theme] = count; evidence[theme] = found; }
  }
  // v1.5.0：count < 5 视为噪音省略
  const filtered = Object.entries(hits).filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]);
  return {
    dominant: filtered[0]?.[0] ?? null,
    secondary: filtered[1]?.[0] ?? null,
    themes: filtered.slice(0, 5).map(([t, n]) => ({ theme: t, count: n })),
    evidence
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
// v5.0.0：基线章节数少于 3 时 σ 不可靠（小样本），容差下限抬到 25%，避免「只有两章的书」互相误报。
export const MIN_BASELINE_CHAPTERS = 2;
export const SMALL_BASELINE_CHAPTERS = 3;
export const SMALL_BASELINE_TOL_PCT = 25;

/**
 * v5.0.0：六维容差带构造——**全插件唯一实现**（novel_fix_plan 与 novel_chapter_brief 共用）。
 *
 * 为什么必须共用：容差决定"多大偏差算出带"。若两条路径用不同公式，同一章会出现
 * 「改稿台说有问题、开写包说没问题」这种互相矛盾的结论，比单条结论错更伤信任。
 * 口径：以**排除本章后的基线**自身的推荐容差 recTol（作者自身章节波动的 1.5σ）为主；
 * 小样本（< 3 章）抬高下限；用户自定义容差（opts.tolerance 优先，其次侧边栏保存的 styleTolerance）只覆盖对应维度。
 */
export function buildTolerance(baseline, sampleCount, opts, stateTolerance) {
  const tol = {};
  if (!baseline) return tol;
  for (const key of METRIC_ORDER) {
    let rt = typeof baseline[key]?.recTol === "number" && baseline[key].recTol > 0 ? baseline[key].recTol : 15;
    if (sampleCount < SMALL_BASELINE_CHAPTERS) rt = Math.max(rt, SMALL_BASELINE_TOL_PCT);
    tol[key] = { low: -rt, high: rt };
  }
  // 用户自定义容差：opts.tolerance 优先，其次侧边栏「风格基线」保存的 styleTolerance（只覆盖对应维度）
  const custom = (opts && opts.tolerance) || stateTolerance;
  if (custom && typeof custom === "object") {
    for (const key of METRIC_ORDER) {
      const t = custom[key];
      if (t && typeof t.low === "number" && typeof t.high === "number") tol[key] = { low: t.low, high: t.high };
    }
  }
  return tol;
}

/**
 * 风格基线的**范围**：基线到底取哪些章。
 *
 * ## 为什么需要它（真实用户诉求）
 *
 * 用户提了 issue（siweina/dsh-novel-writer#1「风格漂移」）：AI 续写每章只参考上一章，
 * 从**第 2 章续写**起参考的就是 AI 自己的产物，于是文风逐代远离原著、滑向 AI 的固定腔调。
 * 而本插件此前的「六维基线」与「原著锚段」都是从**全书**（含 AI 写的新章）取样——
 * 书越长 AI 占比越高，**基准自己也在漂**：既检测不出对原著的偏移（全书是一起漂的），
 * 锚段也逐代变成 AI 自己的文风。基准本该是防漂移的锚，结果跟着漂。
 *
 * 用户说"这本身就很难定性"——这话是对的：文风本就该允许演变，插件无权判定"你漂移了"。
 * 所以这里不去判定漂移，而是换一个**可判定**的问题：
 * **相对你自己指定的标杆章，这一章偏了多少**。"哪些章算标杆"交给作者定。
 * （刻意**不猜**"哪些章是原作"——插件根本分不清：`novel_new_chapter` 建章时不留标记，
 * 存量书更没有，猜错比不猜更糟。让作者选，反而是最准的。）
 *
 * ## 语义（"只用"方案，用户已确认）
 *
 * - `all`（默认）：全书除目标章外的所有章 —— **等于旧行为**，存量书零迁移
 * - `custom`：**只用**选中的章。是"只用"，**不是**"优先+不够再补"——
 *   补进来的章不可控，很可能正是用户想排除的 AI 续写章，那就恰好违背了这个功能的目的
 * - **目标章永远排除**，即使它被选中：否则等于拿自己跟自己比，必然"完美符合"，
 *   **比不检查更糟**（会让作者以为"没问题"）。这个过滤旧版就有，改成自定义选择后必须保留
 * - 选择里已改名/删除的章跳过；若**全部失效**导致基线为空 → 回退 `all` 并置 `fellBack`
 *   （绝不返回空基线：空基线算出的 μ 是假的，会把"没基线"伪装成"全都在带内"）
 * - 样本少于 `SMALL_BASELINE_CHAPTERS` 章时，推荐容差由 `buildTolerance` 抬到
 *   至少 `SMALL_BASELINE_TOL_PCT`%——所以**单章也能当基线**，不会因 σ=0 把一切都报成偏差
 *
 * ## 单一裁决点（重要）
 *
 * 基线被多处消费：风格自检 / 开写包（六维基线与锚段）/ 改稿台 / 风格画像报告 / 建章信息行。
 * 上方 `buildTolerance` 的注释已写明理由：若两条路径口径不同，同一章会出现
 * 「改稿台说有问题、开写包说没问题」这种互相矛盾的结论——**比单条结论错更伤信任**。
 * 故所有消费方都必须走本函数，不要各自 filter。
 */
export const BASELINE_SCOPE_MODES = Object.freeze(["all", "custom"]);
/** 选中章节数上限：防一份被写坏/被恶意填的配置把基线撑到内存吃不消 */
export const BASELINE_SCOPE_MAX_CHAPTERS = 2000;

export function baselineDir(root) {
  return join(novelDataDir(root), "baseline");
}
export function baselineScopeFile(root, book) {
  return join(baselineDir(root), sanitizeSegment(book, "book") + ".json");
}
/**
 * 净化（UI 与工具入口共用）：
 * - `mode` 只认 all/custom，**其余一律回落 all**：宁可退回默认全覆盖，
 *   也不要因为一个拼错的 mode 把基线变成空集（空集的危害见上）
 * - `chapters`：去首尾空白、丢空串与非字符串、按出现顺序去重、单条截 220 字、总量上限 2000
 */
export function normalizeBaselineScope(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const mode = BASELINE_SCOPE_MODES.includes(src.mode) ? src.mode : "all";
  const seen = new Set();
  const chapters = [];
  for (const item of Array.isArray(src.chapters) ? src.chapters : []) {
    if (typeof item !== "string") continue;
    const file = item.trim().slice(0, 220);
    if (file === "" || seen.has(file)) continue;
    seen.add(file);
    chapters.push(file);
    if (chapters.length >= BASELINE_SCOPE_MAX_CHAPTERS) break;
  }
  return { mode, chapters };
}
/** 读本书的基线范围；无文件/损坏一律按默认 `all`（fail-safe：读不出来就退回全覆盖，不静默缩小） */
export async function readBaselineScope(root, book, exec) {
  try {
    const parsed = JSON.parse(await readTextFile(baselineScopeFile(root, book), exec));
    return normalizeBaselineScope(parsed);
  } catch (e) {
    // v7.3.3 修（#11/M7）：取消不是「读取失败」。旧版把 AbortError 也当损坏，先记一条 config warn
    // （「基线范围读取失败（按默认 all 处理）」）再返回默认 all——取消被伪装成成功，还会污染 novel_diagnose
    // 的 byKind 计数。放行必须早于 logEvent（isAbort 是全插件唯一取消判据，见其定义处注释）。
    if (isAbort(e)) throw e;
    // v6.6.0：无文件与损坏一律按默认 all（fail-safe），但对外两者无法区分——必须留痕。
    // 注意：本条是 JSON.parse 路径，解析错误的消息会**回显文件内容片段**，故只记固定标签，绝不带 e.message
    if (e?.code !== "ENOENT") {
      logEvent("config", { book, file: baselineScopeFile(root, book), level: "warn", detail: "基线范围读取失败（按默认 all 处理）" });
    }
    return { mode: "all", chapters: [] };
  }
}
export async function writeBaselineScope(root, book, scope) {
  const clean = normalizeBaselineScope(scope);
  const file = baselineScopeFile(root, book);
  await mkdir(dirname(file), { recursive: true });
  await atomicWriteJson(file, { ...clean, updatedAt: new Date().toISOString() });
  await noteRoot(root); // 与 settings/lexicon 写操作同口径：记录书库根，供 UI 定位数据目录
  return clean;
}
/** 展示用文案：`all` 沿用旧措辞（1 章时直接给章名），免得读取方按旧格式解析的代码失效 */
function describeBaselineScope(mode, items, extra, hasTarget) {
  if (mode === "all") {
    if (items.length === 1) return items[0].file + (extra ?? "");
    // v6.5.5 修正（独立验证代理的发现 4）：风格画像这一路**没有"本章"**（它传 targetFile=""），
    // 沿用「除本章外」会造成一句读不通的话（书里共 N 章却说"除本章外 N 章"）。
    // 无目标章时改说「全书 N 章」——该字段是本版新增的，没有按旧格式解析的历史读取方，安全。
    return (hasTarget ? "全书除本章外的 " : "全书 ") + items.length + " 章" + (extra ?? "");
  }
  return "自定义基线 " + items.length + " 章" + (extra ?? "");
}
/**
 * 解析出**实际参与基线的条目**。入参 `items` 只需每项带 `file` 字段
 * （各消费方传的东西不同：章节对象 / {file,text} / {file,metrics}，故这里只认 `file`）。
 *
 * 返回 `{ items, scope, mode, selected, missing, fellBack }`
 * - `items`：**已排除目标章**、可直接拿去算基线的条目（与入参同类型）
 * - `scope`：`baselineScope` 输出字段的文案（读取方按它显示"基线是什么"）
 * - `selected`：配置里选中的章数；`missing`：其中已不存在的章数
 * - `fellBack`：自定义选择失效而回退 `all` 时为 true（消费方应据此**披露**，
 *   否则用户会以为自己选的 10 章生效了，实际是全书）
 */
export async function resolveBaselineScope(root, book, items, targetFile, exec) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x && typeof x.file === "string");
  const target = String(targetFile ?? "");
  // 目标章无条件排除（即使被选中）：拿自己跟自己比必然"完美符合"
  const base = list.filter((x) => x.file !== target);
  const conf = await readBaselineScope(root, book, exec);
  if (conf.mode !== "custom" || conf.chapters.length === 0) {
    return { items: base, mode: "all", scope: describeBaselineScope("all", base, "", target !== ""), selected: 0, missing: 0, fellBack: false, reason: "" };
  }
  const want = new Set(conf.chapters);
  // v6.5.5 修正（独立测试代理抓到的真 bug）：`missing` 此前是
  //   conf.chapters.length - 入参里存在的选中章数
  // 于是**目标章被算成"已失效"**——它明明存在，只是作为被判定者按设计排除（callers 常常
  // 传的 items 已经不含目标章，这时它就被误记成失效）。文案会写出
  // 「自定义基线 1 章（选中 2 章，其中 1 章已失效）」，把"按设计排除"说成"章没了"——虚假信息。
  // 现在：missing 只统计**除目标章之外**、选中了却不在入参里的章（= 真的改名/删除/换书库）。
  const selectedOthers = conf.chapters.filter((f) => f !== target);
  const existsOthers = selectedOthers.filter((f) => list.some((x) => x.file === f)).length;
  const missing = Math.max(0, selectedOthers.length - existsOthers);
  // v7.3.1 修（#9）：删除 `presentSelected = list.filter(x => want.has(x.file)).length`。
  // 它算完从未被读（回退判据实际用的是下面的 selectedOthers.length，见下方 onlyTarget 的说明），
  // 而它把**目标章也算进 want**，与「按设计排除目标章」的口径相反——真拿去用会得出错误结论，
  // 所以选择「删掉」而不是「补用」：需要的两种回退原因已经由 selectedOthers 一次判准。
  const picked = base.filter((x) => want.has(x.file));
  if (picked.length === 0) {
    // 选中项全部无法参与基线 → 回退 all 并披露。
    // 不返回空基线：空基线会算出 μ=0 的假基线，把"没基线"伪装成"全都在带内"。
    // 两种原因要分开说（测试代理指出旧文案把"只选了本章"也说成"选择已失效"）：
    //   ① selectedOthers 里还有章但都失效 → 真的失效
    //   ② 选中的章**全是本章自身** → selectedOthers 为空，它在设计上就不能当自己的基线
    // ⚠️ 判据只能用 selectedOthers 是否为空：不能用"目标章是否出现在入参 items 里"——
    //    消费方常常已经把目标章从 items 里剔掉了（如 brief 传 chapters 全集、fixplan 传已筛集合），
    //    那样判会恒为 false（第一版就是这么写错的，测试代理的观察行抓到了）。
    const onlyTarget = selectedOthers.length === 0;
    return {
      items: base,
      mode: "all",
      scope: describeBaselineScope("all", base,
        onlyTarget ? "（选中的章只有本章自身，不能作为自己的基线，已回退全书）" : "（自定义选择已失效，已回退全书）", target !== ""),
      selected: conf.chapters.length,
      missing,
      fellBack: true,
      reason: onlyTarget ? "only-target" : "all-missing"
    };
  }
  // v6.5.5 措辞修正（独立测试代理第二轮）：这里**不能说"已失效"**。
  // resolver 只看得见调用方递进来的 items，而各消费方递的池子不同：
  //   · style_check / fixplan 递章节全集或已筛集合
  //   · brief 递的是 `perChapter`——`computeBaseline` 会把**正文不足 40 字**的章丢掉
  // 于是"存在但太短"的章也会落进这个差集。说成"已失效"就是把"章太短"谎报成"章没了"。
  // 改成中性的「未纳入基线」，并**如实列出两种原因**——这样无论调用方递什么池子，这句话都成立。
  // （精确的"文件是否存在"只有带 available 章节表的路由才判得准，那里的 missing 是准的。）
  const extra = "（选中 " + conf.chapters.length + " 章" +
    (missing > 0 ? "，其中 " + missing + " 章未纳入基线（已删除、或正文过短无法测量）" : "") + "）";
  return {
    items: picked,
    mode: "custom",
    scope: describeBaselineScope("custom", picked, extra),
    selected: conf.chapters.length,
    missing,
    fellBack: false,
    // v6.5.5：回退原因由**裁决点**给出，消费方不必猜、也不必去解析 scope 字符串。
    // 起因：改稿台原来只要 fellBack 就写「自定义选择已失效」，而另一种原因是
    // "选中的只有本章自身"——那句话在那条路径上是**错的**（文档复核指出后，选择在这里补字段而不是在
    // 各消费方各写一遍判断）。取值："" 正常生效 / "only-target" / "all-missing"。
    reason: ""
  };
}

/**
 * v7.0.0（v2.1 模块 2）：**参照集**裁决点——在基线范围之上再区分"向谁看齐"与"诊断谁"。
 *
 * 为什么必须分开：锚段/动作链/相对分位是"向原著看齐"（要从作者的标杆章取样）；
 * 而套话 Top、上一章症状是"诊断模型"（要从最近 AI 续写章取样）。两者共用"全书"时，
 * 书越长、续写占比越高，"原著颗粒度"就越像 AI 自己的味道（`brief.js` 注释里记过 issue #1 的漂移）。
 *
 * provenance 只有两档（不做 imported：`novel_import` 不落来源元数据，硬推断会产出假精度）：
 *   · custom         用户明确勾了标杆章
 *   · all-unverified 按全书（可能含续写章）——调用方需据此做披露
 */
export async function resolveReferenceSet(root, book, chapters, targetFile, exec) {
  const scope = await resolveBaselineScope(root, book, chapters, targetFile, exec);
  const provenance = scope.mode === "custom" && scope.fellBack !== true ? "custom" : "all-unverified";
  return { items: scope.items, provenance, scope };
}

/** 参照集疑似含续写章时的披露文案（数太少时不打扰：新书本来就没几章） */
export function describeReferenceProvenance(provenance, itemCount) {
  if (provenance === "custom") return "";
  if (!Number.isFinite(itemCount) || itemCount < 4) return "";
  return "参照集为全书（含已写续写章）：建议在侧边栏「风格基线范围」只勾选原著或最满意的标杆章，防止动作链与相对分位随续写漂移。";
}

/**
 * v7.0.0（v2.1 模块 2）：**诊断集**——只看目标章之前最近 1~3 章。
 * 有意义的是"模型最近写出来的东西"，不是全书平均，所以取最近的。
 * 自定义参照集时要把被勾成标杆的原著章剔掉：那是"要像它"，不是"它有病"。
 */
export function selectDiagnosisChapters(chapters, targetNumber, referenceFiles, limit = 3) {
  const list = (Array.isArray(chapters) ? chapters : []).filter((c) => c && typeof c.file === "string");
  const refSet = new Set(Array.isArray(referenceFiles) ? referenceFiles : []);
  const before = list
    .filter((c) => typeof c.number === "number" && Number.isFinite(targetNumber) && c.number < targetNumber)
    .filter((c) => !refSet.has(c.file))
    .sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
  return before.slice(0, Math.max(1, Math.min(3, limit)));
}

/** 分位数（最近秩，p 取 0~100；空数组返回 0）——不引入插值，避免"小数分位"在小样本上装精确 */
export function percentile(values, p) {
  const arr = (Array.isArray(values) ? values : []).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(((sorted.length - 1) * p) / 100)));
  return Math.round(sorted[idx] * 100) / 100;
}

/** 一组数的四分位摘要（键名与 chapter-diagnose 的 refStats 契约一致） */
function percentileSummary(values) {
  return {
    p10: percentile(values, 10),
    p50: percentile(values, 50),
    p85: percentile(values, 85),
    p95: percentile(values, 95)
  };
}

/**
 * v7.0.0（v2.1 模块 6）：把逐章测量聚成**参照集分位**，供症状判定做"相对判定"。
 * 只用相对分位、不用绝对常数：题材/视角/作者之间的差异比"好文本与坏文本"的差异还大，
 * 拍脑袋的常数要么永不触发、要么近一半误报（六审在真实书库上实测过）。
 *
 * @param {Array<{actionVerbsPer1000:number, objectNounsPer1000:number, sense:object, abstractDensity:number, bareDialogueRun:number}>} samples
 */
export function buildReferenceStats(samples) {
  const list = (Array.isArray(samples) ? samples : []).filter((s) => s && typeof s === "object");
  const pick = function (fn) {
    return list.map(fn).filter((v) => typeof v === "number" && Number.isFinite(v));
  };
  const channels = ["visual", "auditory", "tactile", "olfactory", "temperature"];
  const senseChannels = {};
  for (const ch of channels) {
    const summary = percentileSummary(pick((s) => (s.sense && typeof s.sense[ch] === "number" ? s.sense[ch] : void 0)));
    const densityVals = pick((s) => (
      s.sense && typeof s.sense[ch] === "number" && typeof s.chars === "number" && s.chars > 0
        ? Math.round((s.sense[ch] / s.chars) * 1000 * 100) / 100
        : void 0
    ));
    if (densityVals.length > 0) summary.p10Per1000 = percentile(densityVals, 10);
    senseChannels[ch] = summary;
  }
  const runs = pick((s) => s.bareDialogueRun);
  const charList = pick((s) => (typeof s.chars === "number" && s.chars > 0 ? s.chars : void 0));
  const out = {
    chapters: list.length,
    actionVerbsPer1000: percentileSummary(pick((s) => s.actionVerbsPer1000)),
    objectNounsPer1000: percentileSummary(pick((s) => s.objectNounsPer1000)),
    sensePer1000: percentileSummary(pick((s) => s.sensePer1000)),
    abstractDensity: percentileSummary(pick((s) => s.abstractDensity)),
    senseChannels,
    bareDialogueRun: {
      p50: percentile(runs, 50),
      p95: percentile(runs, 95),
      max: runs.length > 0 ? Math.max(...runs) : 0
    }
  };
  if (charList.length > 0) {
    out.avgChars = Math.round(charList.reduce((a, b) => a + b, 0) / charList.length);
  }
  return out;
}

/**
 * v7.0.0（v2.1 模块 3）：原著**典型颗粒度**动作链抽样。
 *
 * 三条取样纪律，每条都对应一个已踩过的坑：
 *   ① 只从 p60~p85 分位取：按"动词最多"降序取样本，等于专挑最密、最不典型的打斗句——
 *      开写包给出的示范永远比作者自己写得更密，作者只会觉得"我写不到"；
 *   ② 按目标章号确定性轮换（步长 7 > 每次取 3），相邻章天然不重叠，不需要额外记账；
 *   ③ 池子不足时不假装轮换：`L <= 3` 直接全量返回，`L === 0` 明确降级。
 *
 * @param {Array<string|{text:string}>} referenceTexts 参照集正文
 * @param {number} targetNumber 目标章号（用于轮换）
 */
export function buildActionChains(referenceTexts, targetNumber) {
  const list = Array.isArray(referenceTexts) ? referenceTexts : [];
  const seen = new Set();
  const all = [];
  for (const item of list) {
    const text = typeof item === "string" ? item : String(item?.text ?? "");
    for (const cand of actionChainCandidates(text)) {
      if (seen.has(cand.text)) continue;
      seen.add(cand.text);
      all.push(cand);
    }
  }
  if (all.length === 0) {
    return { chains: [], poolSize: 0, degraded: "参照集没有符合条件的完整动作句（15~70 字、≥2 个动作动词、≥1 个物件）——本章不带动作链示范" };
  }
  // 优先从零抽象词的纯物理动作句中取样（足够 ≥3 条时过滤掉夹带抽象总结词的句子；不足时回退全集）
  const zeroAbstract = all.filter((c) => measureStyleMetrics(c.text).metrics.abstractDensity === 0);
  const base = zeroAbstract.length >= 3 ? zeroAbstract : all;
  // v7.0.0 修正（审查实测 P0）：**旧版是"降序排序后取 0.6N~0.85N"，抽到的是倒数区间的稀疏句**
  // （p15~p40，正好是全书动作最少的那些），与"取 p60~p85 典型颗粒度"完全相反。
  // 现在改为按**动作密度**（动词数 / 码点长度）升序，再取 p60~p85 区间——
  // 用密度而不是绝对动词数，避免"长句靠长度堆够 2 个动词"混进中位数。
  const densityOfChain = (c) => {
    const len = Array.from(c.text).length;
    return len === 0 ? 0 : (c.verbs * 100) / len;
  };
  const sorted = base.slice().sort((a, b) => densityOfChain(a) - densityOfChain(b) || a.text.length - b.text.length);
  const lo = Math.floor(sorted.length * 0.6);
  const hi = Math.max(lo + 1, Math.ceil(sorted.length * 0.85));
  const pool = sorted.length <= 3 ? sorted : sorted.slice(lo, Math.min(hi, sorted.length));
  const L = pool.length;
  if (L <= 3) return { chains: pool.map((c) => c.text), poolSize: L };
  const n = Number(targetNumber);
  const start = (((Number.isFinite(n) ? n : 0) * 7) % L + L) % L;
  const chains = [];
  for (let i = 0; i < 3; i += 1) chains.push(pool[(start + i) % L].text);
  return { chains, poolSize: L };
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

export async function buildStyleAnchorPackage(root, book, chapters, exec, preloadedText) {
  // v4.3.0 修正：预读文本是必需契约（root/book/chapters 形参保留仅为兼容 index.js 的位置调用，函数内已不用）。
  // 选择"删除磁盘兜底 + assert"而不是"补测试覆盖"：唯一可达的兜底场景是 preloadedText === ""（整本书都是
  // 空章节文件），那时重读磁盘得到的同样是空文本——兜底本身不产生任何锚段，纯粹是一次无意义的全书双读；
  // 而它把"新调用点漏传预读"这种契约错误掩盖成"空锚包"（静默降级）。assert 必须放在 try 之外：
  // 放进去会被函数尾部的 catch 吞掉，又退化成静默失败。三个调用点（index.js style_check/style_report/new_chapter）
  // 均已显式传入，见 test 侧探针 fixB-13 的源码级核对。
  assert(typeof preloadedText === "string" || Array.isArray(preloadedText),
    "buildStyleAnchorPackage 契约：必须传入已读文本（string 全文 或 {file,text}[]），不再提供去磁盘兜底读取");
  const anchors = [];
  const skeletons = [];
  // v6.6.0：内部失败必须能被调用方**区分**于「正文本来就不满足抽样条件」（段落 ≥ 40 字）。
  // 旧版一律返回空锚包，开写包于是把系统的失败讲成「本书正文不满足抽样要求」✗。
  // 只在**失败路径**补一个 failed 标记：成功路径的返回结构（anchors / skeletons 两键）一字不动，
  // 既有消费方（brief / novel_style_check / novel_style_report / novel_new_chapter）都只读这两个键。
  let failed = false;
  try {
    // v3.8.0 性能：复用调用方已读文本（preloadedText=string 全文 / {file,text}[] 数组）——大书不再双读
    const allText = (typeof preloadedText === "string"
      ? preloadedText
      : preloadedText.map(function (x) { return x.text || ""; }).join("\n")).replace(/\r\n?/g, "\n");
    // v4.0.0：全书等距抽样（语义同 vibe.js sampleEvenly：超量时首尾保留、均匀取 max 条；max=1 取中位段）
    // 旧版 pick 从段首顺序取，锚段几乎全部来自序章/开头章，中后段文风样本拿不到
    const sampleEvenly = function (list, max) {
      if (!Array.isArray(list) || list.length === 0 || max <= 0) return [];
      if (list.length <= max) return list.slice();
      if (max === 1) return [list[Math.floor((list.length - 1) / 2)]];
      const out = [];
      const step = (list.length - 1) / (max - 1);
      for (let i = 0; i < max; i++) out.push(list[Math.round(i * step)]);
      return out;
    };
    const paras = allText.split(/\n+/).map(function (p) { return p.trim(); }).filter(function (p) { return p.length >= 40; });
    const pick = function (list, label, n) {
      for (const p of sampleEvenly(list, n)) anchors.push({ label: label, text: p.slice(0, 200) });
    };
    const dialogue = paras.filter(function (p) { return /["“]/.test(p) && p.length <= 200; });
    const psych = paras.filter(function (p) { return /想|觉得|心|怕|慌|记忆/.test(p) && !/["“]/.test(p) && p.length <= 200; });
    const desc = paras.filter(function (p) { return !/["“]/.test(p) && p.length >= 80 && p.length <= 200; });
    pick(dialogue, "对话", 2);
    pick(psych, "心理", 1);
    pick(desc, "描写", 2);
    if (anchors.length === 0) {
      for (const p of sampleEvenly(paras, 3)) anchors.push({ label: "原文", text: p.slice(0, 200) });
    }
    // v7.3.3 修（M1）：切句前先剥掉 Markdown 标题行（以 # 开头的行）——旧版直接对全文按句号切分，
    // 标题与紧随的正文粘成一句（实测 `# 第02章 雨夜` + 首句 → 「#第02章雨夜他沿着河岸慢慢走…」24 字，
    // 正好落进 20~45 的采样窗口）。novel_new_chapter 落盘的章节正是标题开头，短首句的书必然中招；
    // 本函数供 brief / style_check / new_chapter / style_report 共用，故骨架必须不含 `#`。
    const skeletonSource = allText.split(/\n+/).filter(function (line) { return !/^\s*#/.test(line); }).join("\n");
    const sentences = skeletonSource.split(/[。！？…]+/).map(function (s) { return s.replace(/\s+/g, "").trim(); }).filter(function (s) { return s.length >= 20 && s.length <= 45; });
    const seen = new Set();
    const uniqSentences = [];
    for (const s of sentences) {
      if (seen.has(s)) continue;
      seen.add(s);
      uniqSentences.push(s);
    }
    // v4.0.0：骨架同样全书等距抽样（去重后均匀取 4 条），不再只取开头句；条数上限与分类逻辑不变
    for (const s of sampleEvenly(uniqSentences, 4)) {
      let type = "陈述";
      if (/["“]/.test(s)) type = "对话";
      else if (/[？?]$/.test(s)) type = "疑问";
      else if (/想|觉得|仿佛|好像|似乎/.test(s)) type = "心理";
      skeletons.push({ type: type, text: s });
    }
    if (skeletons.length === 0) {
      // v7.3.3 修（M1）：兜底路径同样不得把标题行当骨架（否则主路径剥了 #、兜底路径又把 # 带回来）
      const firsts = sampleEvenly(allText.split(/\n+/).map(function (p) { return p.trim(); }).filter(function (p) { return p.length >= 15 && !/^#/.test(p); }), 4);
      for (const ft of firsts) skeletons.push({ type: "陈述", text: ft.slice(0, 60) });
    }
  } catch {
    failed = true;
    // v6.6.0：内部失败被吞成**空锚包**——调用方只看得到 anchors/skeletons 为空，
    // 与"这本书文本太短、本来就抽不出锚段"完全一样（开写包/改稿台的"原著锚段"就这样静默消失）
    logEvent("silent_skip", { book, level: "warn", detail: "原著锚段/句式骨架生成失败（返回空锚包，风格对照缺失）" });
  }
  // v4.0.0 修正：pick 合计请求 2 对话 + 1 心理 + 2 描写 = 5 条，旧版统一截到 4 条会把"描写"锚砍掉一条
  return failed
    ? { anchors: anchors.slice(0, 5), skeletons: skeletons.slice(0, 4), failed: true }
    : { anchors: anchors.slice(0, 5), skeletons: skeletons.slice(0, 4) };
}

export function plotsFile(root, book) {
  return join(novelDataDir(root), "plots", sanitizeSegment(book, "book") + ".json");
}
export function legacyPlotsFile(root, book) {
  return join(novelDataDir(root), sanitizeSegment(book, "book") + ".json");
}
export async function readPlots(root, book, opts) {
  const file = plotsFile(root, book);
  let parsed = null;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    // v6.6.0：新位置不可读（损坏 / EACCES）与「本书还没有伏笔」对外长得一样；
    // 本条是 JSON.parse 路径（消息会回显文件内容片段），故只记固定标签，绝不带 e.message
    if (e?.code !== "ENOENT") {
      logEvent("config", { book, file, level: "warn", detail: "伏笔表（新位置）读取失败（按无数据处理，将尝试旧位置）" });
    }
    /* 新位置不存在 */
  }
  if (!parsed) {
    // v0.8.0 迁移：旧位置 <root>/.novel-writer/<书>.json → plots/<书>.json
    try {
      parsed = JSON.parse(await readFile(legacyPlotsFile(root, book), "utf8"));
      if (Array.isArray(parsed?.entries) && opts?.readOnly !== true) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(parsed, null, 2), "utf8");
      }
    } catch (e) {
      // v6.6.0：旧位置同样按「无数据」吞掉——解析类错误的消息会回显文件内容，故只记固定标签
      if (e?.code !== "ENOENT") {
        logEvent("config", { book, file: legacyPlotsFile(root, book), level: "warn", detail: "伏笔表（旧位置）读取失败（按无数据处理，未做迁移）" });
      }
      /* 无旧文件 */
    }
  }
  return Array.isArray(parsed?.entries) ? parsed.entries : [];
}
export async function writePlots(root, book, entries) {
  const file = plotsFile(root, book);
  await mkdir(dirname(file), { recursive: true });
  await atomicWriteJson(file, { book, entries });
}
export function plotKeywords(content) {
  const text = String(content).replace(/[^\u4e00-\u9fff]/g, "");
  // v5.0.0：去掉字串里重复的 "一"（进 Set 后本就无影响，属笔误）
  const stop = new Set("的了是在我有和就都不一个这那与及或但是因为所以如果然后而且比如什么怎么自己她们他们你们我们咱们没有不是别莫未".split(""));
  const keywords = [];
  for (const length of [4, 3, 2]) {
    for (let i = 0; i + length <= text.length; i += 1) {
      const sub = text.slice(i, i + length);
      const nonStop = [...sub].filter((ch) => !stop.has(ch)).length;
      if (nonStop >= Math.ceil(length * 0.6)) keywords.push(sub);
    }
  }
  // 去重并按长度降序，最多取 8 个
  return [...new Set(keywords)].sort((a, b) => b.length - a.length).slice(0, 8);
}
export function normalizePlotEntry(entry) {
  // v3.5.0 #17：脏数据兜底——非对象或缺 id/content 直接跳过（不污染输出）
  if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || typeof entry.content !== "string") return null;
  const out = { id: entry.id, content: entry.content, status: entry.status === "done" ? "done" : "open" }; // v3.5.0 M12：status 归一（脏数据 in-progress 等一律 open，符合 schema enum）
  for (const key of ["chapter", "note", "payoffCondition", "lastMentioned", "type", "priority"]) {
    if (entry[key] !== void 0 && entry[key] !== null) out[key] = String(entry[key]);
  }
  for (const key of ["relatedCharacters", "locations", "mentionedIn"]) {
    if (Array.isArray(entry[key])) out[key] = entry[key].map((x) => String(x));
  }
  if (entry.createdAt != null) out.createdAt = String(entry.createdAt);
  if (entry.updatedAt != null) out.updatedAt = String(entry.updatedAt);
  return out;
}
export function settingsFile(root, book) {
  return join(novelDataDir(root), "settings", sanitizeSegment(book, "book") + ".json");
}
export async function readSettings(root, book, opts) {
  try {
    const parsed = JSON.parse(await readFile(settingsFile(root, book), "utf8"));
    return {
      characters: Array.isArray(parsed.characters) ? parsed.characters : [],
      locations: Array.isArray(parsed.locations) ? parsed.locations : [],
      items: Array.isArray(parsed.items) ? parsed.items : [],
      timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
      worldview: Array.isArray(parsed.worldview) ? parsed.worldview : []
    };
  } catch (e) {
    // v6.6.0：**读不到 ≠ 没登记**。ENOENT = "这本书还没登记过设定"（常态，不记）；
    // 其余（损坏/EACCES/IO）在非 strict 调用方那里被静默讲成"设定表为空"——必须留痕。
    //
    // v7.3.2 修（N13 根因）：**JSON.parse 的错误消息会回显文件内容片段**（Node 的 SRP 文本带上出错行附近
    // 的原文），而 strict 消费方（brief / fixplan / graph）会把它原样拼进降级说明或报告里——等于把
    // 设定表正文泄进「模型侧材料」和「可分享的诊断报告」。词表读取那边一直用固定文案，这里此前没有。
    // 现在：解析失败一律换成固定文案 + `code:"EPARSE"`，并把**原始错误只写进本地事件日志**（不出本机）。
    const isParse = e instanceof SyntaxError || e?.name === "SyntaxError";
    // 保留 SyntaxError **类型**（调用方与测试靠它区分「解析失败」与「权限/IO」），只把 message 换成固定文案；
    // code 另标 EPARSE，方便需要机器判定的调用方不再依赖字符串匹配。
    const safeError = isParse
      ? Object.assign(new SyntaxError("文件内容不是合法 JSON（解析失败）"), { code: "EPARSE" })
      : e;
    if (e?.code !== "ENOENT") {
      logEvent("config", { book: typeof book === "string" ? book : void 0, level: "warn", detail: "设定表读取失败（调用方会把它讲成「未登记」）：" + (e?.message ?? e) });
    }
    if (opts?.strict === true && e?.code !== "ENOENT") throw safeError;
    return { characters: [], locations: [], items: [], timeline: [], worldview: [] };
  }
}
export async function writeSettings(root, book, data) {
  const file = settingsFile(root, book);
  await mkdir(dirname(file), { recursive: true });
  const payload = { book, ...(data && typeof data === "object" ? data : {}) };
  if (Object.prototype.hasOwnProperty.call(data || {}, "creationProfile")) {
    const normalizedProfile = normalizeCreationProfile(payload.creationProfile);
    if (normalizedProfile === null) delete payload.creationProfile;
    else payload.creationProfile = normalizedProfile;
  } else {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      const existingProfile = normalizeCreationProfile(parsed?.creationProfile);
      if (existingProfile !== null) payload.creationProfile = existingProfile;
    } catch { /* 文件不存在或不可解析时无需保留旧 creationProfile */ }
  }
  await atomicWriteJson(file, payload);
  await noteRoot(root); // v3.9.0：settings 写操作统一记录书库根
}

const CREATION_PROFILE_FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CREATION_PROFILE_MAX_STRING = 10000;
const CREATION_PROFILE_MAX_ITEM = 1000;
const CREATION_PROFILE_MAX_ITEMS = 100;

export function normalizeCreationProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out = {};
  for (const key of Object.keys(input)) {
    if (typeof key !== "string" || key === "" || CREATION_PROFILE_FORBIDDEN_KEYS.has(key)) continue;
    const val = input[key];
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed !== "") out[key] = trimmed.length > CREATION_PROFILE_MAX_STRING ? trimmed.slice(0, CREATION_PROFILE_MAX_STRING) : trimmed;
    } else if (Array.isArray(val)) {
      const items = [];
      for (const item of val) {
        const s = typeof item === "string"
          ? item.trim()
          : (typeof item === "number" && Number.isFinite(item) ? String(item) : "");
        if (s !== "") items.push(s.length > CREATION_PROFILE_MAX_ITEM ? s.slice(0, CREATION_PROFILE_MAX_ITEM) : s);
        if (items.length >= CREATION_PROFILE_MAX_ITEMS) break;
      }
      if (items.length > 0) out[key] = items;
    } else if (typeof val === "boolean") {
      out[key] = val;
    } else if (typeof val === "number" && Number.isFinite(val)) {
      out[key] = val;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function resolveLegacyBookProfileFromState(state, book, safeBook, rawBookOpt) {
  const profiles = state?.creationProfiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return null;
  const candidates = [];
  for (const k of [rawBookOpt, book, safeBook]) {
    if (typeof k === "string" && k !== "" && !candidates.includes(k)) candidates.push(k);
  }
  for (const k of candidates) {
    if (Object.prototype.hasOwnProperty.call(profiles, k)) {
      const norm = normalizeCreationProfile(profiles[k]);
      if (norm !== null) return norm;
    }
  }
  return null;
}

export async function readBookCreationProfile(root, book, opts = {}) {
  const rawBook = typeof book === "string" ? book.trim() : "";
  let safeBook = "";
  if (rawBook !== "") {
    try { safeBook = sanitizeSegment(rawBook, "book"); } catch { safeBook = ""; }
  }
  if (typeof root === "string" && root.trim() !== "" && safeBook !== "") {
    try {
      const parsed = JSON.parse(await readFile(settingsFile(root, safeBook), "utf8"));
      const localProfile = normalizeCreationProfile(parsed?.creationProfile);
      if (localProfile !== null) return localProfile;
    } catch { /* 文件不存在或不可读时回退 legacy state */ }
  }
  const state = opts?.state !== void 0 ? opts.state : await readSentenceState();
  const legacyBookProfile = resolveLegacyBookProfileFromState(state, rawBook, safeBook, opts?.rawBook);
  if (legacyBookProfile !== null) return legacyBookProfile;
  if (opts?.fallbackGlobal === true) {
    return normalizeCreationProfile(state?.creationProfile);
  }
  return null;
}

export function readBookCreationProfileSync(root, book, opts = {}) {
  const rawBook = typeof book === "string" ? book.trim() : "";
  let safeBook = "";
  if (rawBook !== "") {
    try { safeBook = sanitizeSegment(rawBook, "book"); } catch { safeBook = ""; }
  }
  if (typeof root === "string" && root.trim() !== "" && safeBook !== "") {
    try {
      const file = settingsFile(root, safeBook);
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        const localProfile = normalizeCreationProfile(parsed?.creationProfile);
        if (localProfile !== null) return localProfile;
      }
    } catch { /* 文件不存在或不可读时回退 legacy state */ }
  }
  const state = opts?.state !== void 0 ? opts.state : readSentenceStateSync();
  const legacyBookProfile = resolveLegacyBookProfileFromState(state, rawBook, safeBook, opts?.rawBook);
  if (legacyBookProfile !== null) return legacyBookProfile;
  if (opts?.fallbackGlobal === true) {
    return normalizeCreationProfile(state?.creationProfile);
  }
  return null;
}

export async function listBookCreationProfiles(root, state) {
  const st = state !== void 0 ? state : await readSentenceState();
  const out = {};
  if (st?.creationProfiles && typeof st.creationProfiles === "object" && !Array.isArray(st.creationProfiles)) {
    for (const [key, val] of Object.entries(st.creationProfiles)) {
      if (typeof key !== "string" || key === "" || CREATION_PROFILE_FORBIDDEN_KEYS.has(key)) continue;
      const norm = normalizeCreationProfile(val);
      if (norm !== null) out[key] = norm;
    }
  }
  if (typeof root === "string" && root.trim() !== "") {
    const dir = join(novelDataDir(root), "settings");
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          const parsed = JSON.parse(await readFile(join(dir, entry.name), "utf8"));
          const norm = normalizeCreationProfile(parsed?.creationProfile);
          if (norm === null) continue;
          const bookName = typeof parsed?.book === "string" && parsed.book.trim() !== ""
            ? parsed.book.trim()
            : entry.name.slice(0, -5);
          if (bookName === "" || CREATION_PROFILE_FORBIDDEN_KEYS.has(bookName)) continue;
          out[bookName] = norm;
        } catch { /* 单文件损坏/不可读时跳过 */ }
      }
    } catch { /* settings 目录不存在或不可读时保留 legacy 结果 */ }
  }
  return out;
}

async function clearLegacyCreationProfileKeys(keys) {
  try {
    const st = await readSentenceState();
    const legacy = st?.creationProfiles;
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return;
    const validKeys = keys.filter((k) => typeof k === "string" && k !== "");
    if (validKeys.length === 0) return;
    const cleanupPatch = {};
    for (const k of validKeys) {
      if (Object.prototype.hasOwnProperty.call(legacy, k)) cleanupPatch[k] = null;
    }
    if (process.platform === "win32") {
      const lowerSet = new Set(validKeys.map((k) => k.toLowerCase()));
      for (const k of Object.keys(legacy)) {
        if (lowerSet.has(k.toLowerCase())) cleanupPatch[k] = null;
      }
    }
    if (Object.keys(cleanupPatch).length > 0) {
      await writeSentenceState({ creationProfiles: cleanupPatch });
    }
  } catch { /* 清理遗留键失败不覆盖已落盘的按书设定 */ }
}

export async function writeBookCreationProfile(root, book, profile) {
  assert(typeof root === "string" && root.trim() !== "", "参数 \"root\" 不能为空字符串");
  const rawBook = requiredString({ book }, "book");
  const safeBook = sanitizeSegment(rawBook, "book");
  const file = settingsFile(root, safeBook);
  const normalized = normalizeCreationProfile(profile);
  let wrote = false;
  await withFileTx(file, async () => {
    let existing = null;
    try {
      existing = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      if (e?.code !== "ENOENT") {
        const isParse = e instanceof SyntaxError || e?.name === "SyntaxError";
        if (isParse) throw Object.assign(new SyntaxError("文件内容不是合法 JSON（解析失败）"), { code: "EPARSE" });
        throw e;
      }
    }
    if (!existing && normalized === null) return;
    if (existing && normalized === null && !Object.prototype.hasOwnProperty.call(existing, "creationProfile")) return;
    const nextData = {
      book: typeof existing?.book === "string" && existing.book.trim() !== "" ? existing.book.trim() : rawBook,
      characters: Array.isArray(existing?.characters) ? existing.characters : [],
      locations: Array.isArray(existing?.locations) ? existing.locations : [],
      items: Array.isArray(existing?.items) ? existing.items : [],
      timeline: Array.isArray(existing?.timeline) ? existing.timeline : [],
      worldview: Array.isArray(existing?.worldview) ? existing.worldview : [],
      ...(normalized ? { creationProfile: normalized } : {})
    };
    await mkdir(dirname(file), { recursive: true });
    await atomicWriteJson(file, nextData);
    wrote = true;
  });
  if (wrote) await noteRoot(root);
  await clearLegacyCreationProfileKeys([rawBook, safeBook]);
  return normalized;
}

export async function clearAllBookCreationProfiles(root) {
  let modifiedAny = false;
  if (typeof root === "string" && root.trim() !== "") {
    const dir = join(novelDataDir(root), "settings");
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const file = join(dir, entry.name);
        await withFileTx(file, async () => {
          let parsed;
          try {
            parsed = JSON.parse(await readFile(file, "utf8"));
          } catch { return; }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
          if (!Object.prototype.hasOwnProperty.call(parsed, "creationProfile")) return;
          const nextData = { ...parsed };
          delete nextData.creationProfile;
          await atomicWriteJson(file, nextData);
          modifiedAny = true;
        });
      }
    } catch { /* settings 目录不存在或不可读时跳过 */ }
  }
  if (modifiedAny) await noteRoot(root);
  try {
    const st = await readSentenceState();
    if (st?.creationProfiles && typeof st.creationProfiles === "object" && Object.keys(st.creationProfiles).length > 0) {
      await writeSentenceState({ creationProfiles: null });
    }
  } catch { /* 清理遗留 state 失败不掩盖结果 */ }
}

export async function applyBookCreationProfilesPatch(root, patch) {
  if (patch === void 0) return { clearedAll: false, updated: [], deleted: [] };
  if (patch === null || (typeof patch === "object" && !Array.isArray(patch) && Object.keys(patch).length === 0)) {
    await clearAllBookCreationProfiles(root);
    return { clearedAll: true, updated: [], deleted: [] };
  }
  assert(typeof patch === "object" && !Array.isArray(patch), "参数 \"creationProfiles\" 必须是键值对象或 null");
  const updated = [];
  const deleted = [];
  for (const book of Object.keys(patch)) {
    if (typeof book !== "string" || book.trim() === "" || CREATION_PROFILE_FORBIDDEN_KEYS.has(book)) continue;
    const res = await writeBookCreationProfile(root, book, patch[book]);
    if (res === null) deleted.push(book);
    else updated.push(book);
  }
  return { clearedAll: false, updated, deleted };
}
export function normalizeSettingEntry(entry) {
  // v4.0.0 修正：脏数据守卫——settings JSON 被手改/半截写坏（[null]/[123]）时
  // 旧版 String(entry.name) 直接 TypeError，导致 list/add/update/scan/detect 整体失败
  if (!entry || typeof entry !== "object") return null;
  const out = { name: String(entry.name ?? "") };
  for (const key of ["description", "traits", "relationships", "firstSeen", "notes", "owner", "status", "lastSeen", "day", "event", "chapter", "basis", "ritual"]) {
    if (entry[key] !== void 0 && entry[key] !== null) out[key] = String(entry[key]);
  }
  if (typeof entry.pack === "string") {
    const pack = entry.pack.trim();
    if (pack !== "") out.pack = pack;
  }
  // v6.5.0：`allowWords`（本书用词豁免）必须进这个白名单——否则它写盘生效、静音也生效，
  // 但 add/list/scan/detect 的**返回体里看不到它**，用户无从核对自己到底豁免了什么
  // （独立核对子代理实测：写盘完整、审计静音正常，而返回值里只有条目名）。
  for (const key of ["alias", "bannedWords", "allowWords"]) {
    if (Array.isArray(entry[key])) out[key] = entry[key].map(String);
  }
  if (entry.recommended !== void 0 && entry.recommended !== null && typeof entry.recommended === "object") {
    out.recommended = { ...entry.recommended };
  }
  if (entry.speechStyle !== void 0 && entry.speechStyle !== null && typeof entry.speechStyle === "object") {
    const speech = {};
    if (typeof entry.speechStyle.title === "string") speech.title = entry.speechStyle.title;
    if (typeof entry.speechStyle.tone === "string") speech.tone = entry.speechStyle.tone;
    if (Array.isArray(entry.speechStyle.honorBad)) speech.honorBad = entry.speechStyle.honorBad.map(String);
    if (entry.speechStyle.honorGood !== void 0 && entry.speechStyle.honorGood !== null && typeof entry.speechStyle.honorGood === "object" && !Array.isArray(entry.speechStyle.honorGood)) speech.honorGood = { ...entry.speechStyle.honorGood };
    if (Array.isArray(entry.speechStyle.ritualBadPatterns)) speech.ritualBadPatterns = entry.speechStyle.ritualBadPatterns.map((x) => String(x));
    if (typeof entry.speechStyle.ritualGoodNote === "string") speech.ritualGoodNote = entry.speechStyle.ritualGoodNote;
    out.speechStyle = speech;
  }
  return out;
}
export function normalizeSettingList(list) {
  return (Array.isArray(list) ? list : []).map(normalizeSettingEntry).filter(Boolean);
}

// ============ v6.4.0（P0-2 / P0-4）：世界观用语规范的**单一裁决点** ============
/**
 * 文化基准提示词判定：看**登记文本**（basis / name / description / ritual / notes）落在哪一支。
 *
 * v4.0.0 起这段内联在 index.js 的「登记 worldview 时自动推导语用规范」分支里；
 * v6.4.0 抽到 core.js，让「登记时推导语用规范」与「resolveStyleRule 决定用哪张默认表」
 * 用的是**同一套判据**——否则两处会各判一次、结论还可能不一致。
 */
export function hintCulture(text) {
  const s = String(text ?? "");
  if (/中式|东方|中原|中土|古装|古风|客栈|老爷|少侠|江湖|茶楼|媒婆|太监|衙门|香客/.test(s)) {
    return { culture: "eastern", confidence: 1, scores: {}, evidence: {}, total: 0 };
  }
  if (/west|西方|欧式|西式|教廷|教堂|神甫|公爵|骑士|城堡|女巫|庄园|圣器|牧师|弥撒/i.test(s)) {
    return { culture: "western", confidence: 1, scores: {}, evidence: {}, total: 0 };
  }
  return detectCulture(s);
}

// v7.1.0 修正（审查 #55）：「用词豁免」是 v6.5.0 引入的**保留条目名**——它只承载 allowWords
// （逐词静音），不是"这本书的文化基准"的声明。旧版把它当 cultureName，审计文案会写成
// 「与当前文化基准「用词豁免」不符」，语义完全错位。这里显式过滤保留名（而不是"只要有
// allowWords 就过滤"：正常命名的文化条目也可能同时带 allowWords，仍应以它的名字为准）。
// 注意：过滤只作用于**展示名**；豁免本身（bannedWords/speechStyle 的静音）仍按原逻辑生效。
const RESERVED_CULTURE_ENTRY_NAMES = new Set(["用词豁免"]);
function cultureEntryName(entry) {
  const name = String(entry?.name ?? "");
  const trimmed = name.trim();
  return trimmed !== "" && !RESERVED_CULTURE_ENTRY_NAMES.has(trimmed) ? name : "";
}

/**
 * 世界观「用语规范」的唯一裁决点 —— 开写包与连贯性审计**都必须**调它。
 *
 * ## 为什么必须有它（v6.4.0 的核心修复）
 *
 * 此前两处**各拿一套词源**：
 *   - 开写包（决定模型看到什么）：只读用户登记的 `bannedWords`，**没有默认表兜底**
 *     → 用户登记了 worldview 但没显式填禁词时，模型看不到任何禁词
 *   - 连贯性审计（决定事后查出什么）：`用户登记 ?? DEFAULT_BANNED_WORDS`，**有默认表兜底**
 * 于是两道防线错开：该告诉模型的没告诉，能查出来的（在章节模式下）又没查。
 * 更糟的是那个 `??` 是**硬替换**：用户哪怕只登记 1 个词，含「掌柜/客栈/银两/衙门」的
 * 整张欧式默认表就被整份丢弃 —— **越精心配置，防护越弱**。
 *
 * 现在两处都调本函数，结构上不可能再分叉。
 *
 * ## 合并语义
 *
 *   bannedWords = 去重（用户登记 ∪ 文化基准对应的默认表）
 *   **显式登记 `bannedWords: []` 表示「我不要默认表」，此时不合并**
 *   （沿用 v4.0.0「显式空 ≠ 未登记」的语义，见 index.js 旧注释）
 *
 * 默认表随**文化基准**选，这是关键——不能无条件合并欧式表，否则中式书会被误报：
 *   western → `DEFAULT_BANNED_WORDS`（欧式表：老夫/上香/掌柜/客栈/银两/衙门/郎中…，见 `markers.js` 的 `groups`）
 *   eastern → `SPEECH_STYLE_RULES.eastern.honorBad`（**禁西式词**：Miss/先生/教堂/神甫…）
 *   modern  → 空（现代都市无文化禁用词）
 *   unknown → 落 western（历史默认），并在 `sources.cultureSource` 标成 `"default"`
 *
 * > ⚠️ 注释里**不要写死词数**：词表会增补（v6.4.0 就从 42 增到 69），
 * >    写死的数字必然腐烂——本文件此前四处「40 词」就是这么过期的。要查数量请读 `DEFAULT_BANNED_WORDS.bannedWords.length`。
 *
 * ## 文化基准的判定顺序
 *   ① 登记文本（任一 worldview 条目的 basis/name/description/ritual/notes）——
 *      登记是用户显式声明的，优先级最高，且不依赖正文长度
 *   ② 正文检测（`chapterTexts`，接受 `string[]` 或 `{text}[]`）——未登记时才用
 *   ③ 落默认欧式
 *
 * @param {object} settings 设定表（`readSettings` 的返回值；容忍 undefined/null）
 * @param {Array<string|{text?:string}>} [chapterTexts] 正文样本；**调用方应尽量传入**，
 *        否则未登记 worldview 的书无法按正文判出文化基准，会落成欧式默认
 * @returns {{culture:string, cultureSource:"worldview"|"detected"|"default", cultureName:string,
 *            bannedWords:string[], recommended:Record<string,string>, speechStyle:object|null,
 *            userBannedWords:string[], defaultEnabled:boolean,
 *            sources:{userCount:number, defaultCount:number, total:number, hint:string|null}}}
 */
export function resolveStyleRule(settings, chapterTexts = [], opts = {}) {
  const worldviewList = Array.isArray(settings?.worldview) ? settings.worldview.filter((e) => e && typeof e === "object") : [];
  const reversed = worldviewList.slice().reverse();

  // 题材规则包解析：opts.pack（对象或 ID）> worldview[].pack > 按书自定义包（<root>/.novel-writer/packs/<book>.json）
  let activePack = null;
  const optPack = opts?.pack;
  if (optPack && typeof optPack === "object" && !Array.isArray(optPack)) {
    const hasInlineRules = Array.isArray(optPack.bannedWords)
      || Array.isArray(optPack.allowWords)
      || Array.isArray(optPack.slopMuteCategories)
      || (optPack.speechStyle && typeof optPack.speechStyle === "object")
      || (optPack.recommended && typeof optPack.recommended === "object")
      || (typeof optPack.baseCulture === "string" && optPack.baseCulture.trim() !== "");
    if (hasInlineRules) {
      const normalized = normalizePack(
        { id: typeof optPack.id === "string" && optPack.id.trim() !== "" ? optPack.id.trim() : "inline-pack", ...optPack },
        { source: optPack.source || "inline" }
      );
      if (normalized.pack) activePack = normalized.pack;
    } else if (typeof optPack.id === "string" && optPack.id.trim() !== "") {
      activePack = resolvePackForBook({ packId: optPack.id.trim(), book: opts?.book, root: opts?.root });
    }
  } else {
    const packEntry = reversed.find((e) => typeof e.pack === "string" && e.pack.trim() !== "");
    const packId = typeof optPack === "string" && optPack.trim() !== ""
      ? optPack.trim()
      : packEntry
        ? packEntry.pack.trim()
        : "";
    activePack = resolvePackForBook({ packId, book: opts?.book, root: opts?.root });
  }

  // ① 用户登记的禁词表：取「最近一个含 bannedWords 字段」的条目（**含显式空数组**）
  //    —— 与语用规范解耦：后登记的 speechStyle 不得遮蔽先登记的 bannedWords（v3.9.5 修正的语义）
  // v7.3.1 修（#3）：旧版是「先找最近的非空条目，找不到再找最近的含字段条目」——顺序反了。
  // 于是先登记 `bannedWords: ["老爷"]`、后登记 `bannedWords: []`（显式"我不要默认表"）时，
  // `[]` 会被旧的非空条目遮蔽，默认禁用词表照样启用，「显式空数组 = 不要默认表」这条语义直接失效。
  // 现在严格按注释：**离现在最近的那个含 bannedWords 字段的条目说了算**，空数组也算数。
  const bannedEntry = reversed.find((e) => Array.isArray(e.bannedWords));
  // ② 语用规范：合并题材包（若命中）与**全部**用户条目的 speechStyle（用户条目后入覆盖标量、数组去重、对象浅合并）
  const speechEntry = reversed.find((e) => e.speechStyle && typeof e.speechStyle === "object");
  const speechSources = activePack && activePack.speechStyle
    ? [{ speechStyle: activePack.speechStyle }, ...worldviewList]
    : worldviewList;
  const speechStyle = (() => {
    const out = {};
    for (const e of speechSources) {
      const sp = e.speechStyle;
      if (!sp || typeof sp !== "object") continue;
      for (const [k, v] of Object.entries(sp)) {
        if (Array.isArray(v)) {
          const cur = Array.isArray(out[k]) ? out[k] : [];
          for (const x of v.map(String)) if (x !== "" && !cur.includes(x)) cur.push(x);
          if (cur.length > 0) out[k] = cur;
        } else if (v && typeof v === "object") {
          out[k] = { ...(out[k] && typeof out[k] === "object" ? out[k] : {}), ...v };
        } else if (v !== void 0 && v !== null && String(v) !== "") {
          out[k] = String(v);
        }
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  })();
  const userRecommended = {};
  for (const e of worldviewList) {
    if (e.recommended && typeof e.recommended === "object") Object.assign(userRecommended, e.recommended);
  }

  const userBannedWords = bannedEntry ? bannedEntry.bannedWords.map(String).filter((w) => w !== "") : [];
  // 显式 `bannedWords: []` = 「我不要默认表」；未登记 = 用默认表
  const defaultEnabled = !(bannedEntry && bannedEntry.bannedWords.length === 0);

  // ③ 文化基准：登记文本 → 题材包 baseCulture → 正文检测 → 默认欧式
  const hintParts = [];
  for (const e of worldviewList) {
    for (const s of [e.basis, e.name, e.description, e.ritual, e.notes]) {
      if (typeof s === "string" && s.trim() !== "") hintParts.push(s.trim());
    }
  }
  const texts = (Array.isArray(chapterTexts) ? chapterTexts : [])
    .map((t) => (typeof t === "string" ? t : t && typeof t.text === "string" ? t.text : ""))
    .filter((s) => s !== "");
  let culture = "unknown";
  let cultureSource = "default";
  let hint = null;
  if (hintParts.length > 0) {
    hint = hintCulture(hintParts.join("；"));
    if (hint.culture !== "unknown") { culture = hint.culture; cultureSource = "worldview"; }
  }
  if (culture === "unknown" && activePack && ["western", "eastern", "modern"].includes(activePack.baseCulture)) {
    culture = activePack.baseCulture;
    cultureSource = "pack";
  }
  if (culture === "unknown" && texts.length > 0) {
    const det = detectCulture(texts.join("\n"));
    if (det.culture !== "unknown") { culture = det.culture; cultureSource = "detected"; }
  }
  if (culture === "unknown") { culture = "western"; cultureSource = "default"; }

  // ④ 该文化基准对应的默认表（注意 eastern 是**禁西式词**，方向与 western 相反）
  // v6.4.0 修正：`mixed`（detectCulture 在东西方信号势均力敌时给出）此前落进 else 分支，
  // 于是 cultureName 显示成**默认欧式表的名字**，而 cultureSource 却是 "detected" ——
  // 审计文案会写成「与当前文化基准「欧式中世纪晚期（默认）」不符（未登记 worldview，基准由正文自动检测…）」，
  // 自相矛盾（独立验证子代理发现）。现在 mixed 单列一个诚实的名字；词表仍用欧式表
  // （混合稿更需要防中式渗透，且这个方向不会误伤中式词）。
  const base = culture === "eastern"
    ? { culture: "东方/中式古代（默认）", bannedWords: SPEECH_STYLE_RULES.eastern.honorBad.slice(), recommended: { ...SPEECH_STYLE_RULES.eastern.honorGood } }
    : culture === "modern"
      ? { culture: "现代都市（默认）", bannedWords: [], recommended: {} }
      : culture === "mixed"
        ? { culture: "东西方混合（正文检测）", bannedWords: DEFAULT_BANNED_WORDS.bannedWords.slice(), recommended: { ...DEFAULT_BANNED_WORDS.recommended } }
        : { culture: DEFAULT_BANNED_WORDS.culture, bannedWords: DEFAULT_BANNED_WORDS.bannedWords.slice(), recommended: { ...DEFAULT_BANNED_WORDS.recommended } };

  // ⑤ 合并（优先级：用户登记 worldview > 题材包 > 文化默认表；显式 bannedWords: [] 清空默认与包禁词）
  const packBannedWords = activePack && Array.isArray(activePack.bannedWords) ? activePack.bannedWords : [];
  const merged = [];
  for (const w of userBannedWords) if (!merged.includes(w)) merged.push(w);
  if (defaultEnabled) {
    for (const w of packBannedWords) if (!merged.includes(w)) merged.push(w);
    for (const w of base.bannedWords) if (!merged.includes(w)) merged.push(w);
  }
  // 替代词：用户登记 > 题材包 > 文化默认表
  const packRecommended = defaultEnabled && activePack && activePack.recommended && typeof activePack.recommended === "object"
    ? activePack.recommended
    : {};
  const recommended = { ...(defaultEnabled ? base.recommended : {}), ...packRecommended, ...userRecommended };

  // ⑥ v6.5.0：**逐词静音**（本书豁免）。
  //
  // 解决什么问题：词表是"猜"这本书的。但有些词在**这本书里就是对的**——
  // 修仙小说里的「修士」＝修行者（语料 308 次全是这个义）、中文历史小说里真有一座「教堂」。
  // 此前用户**没有任何办法**告诉插件"这个我知道"：只能每次手动忽略（下次还报）、
  // 或关掉整个用语检查（别的词也不查了）、或把词从表里删掉（**所有书**都不查了，影响面过大）。
  //
  // 静音只作用于**本书**（不提供全局静音）：全局静音会静默削弱所有书的覆盖，
  // 而人很难记得自己什么时候加过；按书静音最坏只是"这本书里漏"，看得见、摸得着。
  //
  // 过滤放在本函数（**单一裁决点**）而不是各消费方——这样开写包 / 审计 / 改稿台
  // 四个入口自动一致，不会出现"审计静音了但开写包还在警告"的分裂。
  const allow = new Set([
    ...(Array.isArray(opts?.allowWords) ? opts.allowWords : []),
    ...(activePack && Array.isArray(activePack.allowWords) ? activePack.allowWords : []),
    // 用户登记的豁免：worldview 条目上的 allowWords（并集）。
    // 复用既有表而不是新开一张，这样 `novel_settings add category=worldview name="用词豁免"
    // allowWords=["修士"]` 就能静音，且**没有登记过 worldview 的书**也能用（加这一条即可）。
    // 该条目的 name 不含文化标记词，故不会影响 hintCulture 的基准判定。
    ...worldviewList.flatMap((e) => (Array.isArray(e.allowWords) ? e.allowWords : []))
  ].map((w) => String(w ?? "").trim()).filter((w) => w !== ""));
  const bannedWords = allow.size > 0 ? merged.filter((w) => !allow.has(w)) : merged;
  const speechStyleFiltered = (() => {
    if (allow.size === 0 || !speechStyle) return speechStyle;
    const out = { ...speechStyle };
    if (Array.isArray(out.honorBad)) out.honorBad = out.honorBad.filter((w) => !allow.has(w));
    return out;
  })();

  const cultureName = cultureEntryName(bannedEntry) || cultureEntryName(speechEntry) || (activePack ? activePack.name : "") || base.culture;
  // 语用规范条目名：沿用 index.js 既有口径（speechEntry.name 优先，缺则回落题材包/cultureName）
  const speechCultureName = cultureEntryName(speechEntry) || (activePack && activePack.speechStyle ? activePack.name : "") || cultureName;
  const defaultCount = defaultEnabled
    ? (activePack ? new Set([...packBannedWords, ...base.bannedWords]).size : base.bannedWords.length)
    : 0;
  const result = {
    culture,
    cultureSource,
    cultureName,
    speechCultureName,
    bannedWords,
    recommended,
    speechStyle: speechStyleFiltered,
    userBannedWords,
    defaultEnabled,
    registered: worldviewList.length > 0,
    // v6.5.0：把静音结果一并回传——审计文案要能说清"为什么少报了几条"
    allowedWords: [...allow],
    sources: {
      userCount: userBannedWords.length,
      defaultCount,
      total: bannedWords.length,
      muted: merged.length - bannedWords.length,
      hint: hint ? hint.culture : null
    }
  };
  if (activePack) {
    result.pack = {
      id: activePack.id,
      name: activePack.name,
      source: activePack.source,
      baseCulture: activePack.baseCulture,
      slopMuteCategories: Array.isArray(activePack.slopMuteCategories) ? activePack.slopMuteCategories.slice() : []
    };
  }
  return result;
}

// ==================== v6.2.0：必用词表（lexicon） ====================
/**
 * 必用词表：把「某场景必须使用的专有名词 / 作者习惯用词」登记成表，
 * 动笔前由开写包与系统提示词形成**硬清单**（必须用表内词，不得换成通用说法），
 * 成稿后再用 novel_lexicon action=audit 扫覆盖率与「通用替身词」顶替位置。
 *
 * 两层存储（书级同名条目覆盖全局）：
 *   全局 <root>/.novel-writer/lexicon/_global.json —— 作者惯用词/跨书命名规范
 *   书级 <root>/.novel-writer/lexicon/<书名>.json  —— 本书专名
 * 条目字段：term(必填) / kind / scene / avoid[](通用替身) / aliases[](等价写法) / note / priority / enabled
 */
export const LEXICON_KINDS = Object.freeze(["专名", "偏好词", "称呼", "场景词", "口头禅", "其他"]);
export const GLOBAL_LEXICON_BOOK = "_global";
// v6.2.1：删除零引用的 LEXICON_SCOPES（附录 B 第 17 条）——作用层的合法性由 isGlobalLexiconScope
// 与各入口的 scope 判定直接表达，多一份常量只会与实际接受值漂移。作用层字符串："book" / "global"。

function lexiconDir(root) {
  return join(novelDataDir(root), "lexicon");
}
export function lexiconFile(root, book) {
  // 读侧容忍空书名（=只读全局层）；写侧仍要求显式书名（见 writeLexicon），避免"以为写本书、实际动了全局"
  const key = isGlobalLexiconScope(book) || String(book ?? "").trim() === "" ? GLOBAL_LEXICON_BOOK : sanitizeSegment(book, "book");
  return join(lexiconDir(root), key + ".json");
}
/** "_global" 是词表专用保留书号：全局层不属于任何一本书。 */
function isGlobalLexiconScope(book) {
  return String(book ?? "") === GLOBAL_LEXICON_BOOK;
}
/**
 * 批量录入行解析（三种写法都认）：
 *   星轨
 *   星轨 | 专名 | 战斗 | 轨道,轨迹 | 用于跃迁场面
 *   星轨<TAB>专名<TAB>战斗<TAB>轨道,轨迹<TAB>用于跃迁场面
 * `#` 开头为注释；返回 null 表示该行跳过。
 */
export function parseLexiconLine(line) {
  const raw = String(line ?? "").trim();
  if (raw === "" || raw.startsWith("#")) return null;
  const cut = raw.split(/\s*[|\t]\s*/).map(function (s) { return s.trim(); });
  if (cut.length === 0 || cut[0] === "") return null;
  const entry = { term: cut[0] };
  if (cut[1]) entry.kind = cut[1];
  if (cut[2]) entry.scene = cut[2];
  if (cut[3]) entry.avoid = cut[3].split(/[,，、\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (cut[4]) entry.note = cut[4];
  return entry;
}
/**
 * v6.2.1：判断"读不出内容"是文件不存在、内容不是合法 JSON，还是文件根本读不动。
 * 旧版 readLexiconFile 把读取失败与 ENOENT 混成同一个 `exists:false, entries:[]`，
 * 于是 UI 的 read→write（toggle / save / import）读到空表就写回空表——整层条目被静默清空。
 * 口径：ENOENT → 不标记损坏；其余一律 corrupt=true（fail-safe：读不出来就绝不覆盖，
 * 由 writeLexicon 的守卫拦住写操作），并用 parseFailed 区分「内容不是合法 JSON」与
 * 「文件读不动（EISDIR / EACCES / EMFILE…）」——两者的提示文案不同，
 * 免得把权限/IO 问题说成"文件损坏（不是合法 JSON）"。
 * v6.3.0 更正：原注释写"其余（EACCES/EMFILE…）仍照旧按 missing 处理"，与实现（非 ENOENT
 * 全部判 corrupt）恰好相反——这正是本套清单反复判定的"注释与实现不符"，故一并改齐。
 */
function classifyLexiconReadError(e) {
  if (e?.code === "ENOENT") return { corrupt: false, parseFailed: false, reason: "文件不存在" };
  const parseFailed = e instanceof SyntaxError || e?.name === "SyntaxError";
  return {
    corrupt: true,
    parseFailed,
    reason: String(e?.message ?? e).slice(0, 160)
  };
}
export async function readLexiconFile(root, book) {
  const file = lexiconFile(root, book);
  const bookKey = isGlobalLexiconScope(book) ? GLOBAL_LEXICON_BOOK : String(book ?? "");
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    // v6.2.1：区分「文件不存在」与「文件损坏」（见 classifyLexiconReadError 注释）
    const info = classifyLexiconReadError(e);
    // v6.6.0：文件存在却读不动（EACCES/EISDIR/EMFILE）= 损坏口径。旧版只把它写进返回体，
    // 于是"词表坏了"与"词表还没建"在日志里毫无区别（真因无处可查）。
    if (info.corrupt) logEvent("config", { file, book: bookKey, level: "warn", detail: "词表文件读取失败：" + info.reason });
    return { exists: false, corrupt: info.corrupt, corruptError: info.corrupt ? info.reason : void 0, file, book: bookKey, enabled: true, entries: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // v6.2.1：文件在磁盘上、但内容不是合法 JSON —— exists 仍为 true（文件确实存在），
    // corrupt=true + corruptError 让调用方拒绝覆盖，并把原因透到响应体/工具消息里
    // v6.6.0：解析失败同样留痕——用户报"词表不见了"时，日志要能区分"没建"与"建坏了"
    // v6.6.0：**不再把 JSON.parse 的原始 message 透出去**（诊断模块实现者实测并报告的隐私缺口）。
    //
    // 原因：Node 的 JSON.parse 报错会**回显文件开头若干字符**——实测
    //   `Unexpected token '这', "这是一段被误写成 json 的正文" is not valid JSON`
    // 而这条 message 原本经 corruptError → corruptFields 一路进了 novel_lexicon 的**返回体与面板**。
    // 也就是说：词表文件一旦被正文覆盖或写坏，**正文片段就会出现在工具输出里** ✗
    // 这与 v6.6.0「任何离开本机的内容都不含自由文本」的口径直接冲突。
    // 改成固定分类：只说"是什么错"，不说"错在哪段文字"（人要看内容可以自己打开那个文件）。
    const label = "内容不是合法 JSON（解析失败）";
    logEvent("config", { file, book: bookKey, level: "warn", detail: "词表文件不是合法 JSON（已拒绝覆盖）" });
    return { exists: true, corrupt: true, corruptError: label, file, book: bookKey, enabled: true, entries: [] };
  }
  return {
    exists: true,
    corrupt: false,
    file,
    book: bookKey,
    enabled: parsed?.enabled !== false,
    entries: normalizeLexiconList(parsed?.entries),
    updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : void 0
  };
}
/** 合成视图：全局在前、书级在后，同名以书级为准（全局层 enabled=false 时整层不参与）。 */
export async function readLexicon(root, book) {
  const global = await readLexiconFile(root, GLOBAL_LEXICON_BOOK);
  const hasBook = String(book ?? "").trim() !== "" && !isGlobalLexiconScope(book);
  const own = hasBook
    ? await readLexiconFile(root, book)
    : { exists: false, corrupt: false, file: "", book: "", enabled: true, entries: [], updatedAt: void 0 };
  const merged = new Map();
  if (global.enabled) for (const e of global.entries) merged.set(e.term, { ...e, scope: "global" });
  if (own.enabled) for (const e of own.entries) merged.set(e.term, { ...e, scope: "book" });
  return {
    entries: [...merged.values()],
    global,
    book: own,
    // v6.2.1：损坏标记上浮到合成视图，供工具/UI 显示"该层文件损坏"而不是"该层为空"
    corrupt: global.corrupt === true || own.corrupt === true,
    corruptFiles: [global, own].filter(function (f) { return f.corrupt === true; }).map(function (f) { return { file: f.file, error: f.corruptError ?? "" }; }),
    files: { global: global.file, book: own.file },
    counts: { global: global.entries.length, book: own.entries.length, effective: merged.size }
  };
}
export async function writeLexicon(root, book, data) {
  const safeBook = isGlobalLexiconScope(book) ? GLOBAL_LEXICON_BOOK : sanitizeSegment(book, "book");
  const file = lexiconFile(root, safeBook);
  // v6.2.1 修正（数据丢失）：写入前先确认目标文件可解析——调用方都是 read→改→write，
  // 一旦 read 把"损坏"当成"空表"，这次写就会把整层条目覆盖成空表（实测：坏 JSON 的 _global.json
  // 经一次 toggle 后被覆写成 entries:[]，原条目永久消失）。损坏时默认拒写并给出修复指引；
  // 只有显式 force=true（UI 二次确认覆盖 / 工具侧明确要求）才允许覆盖。args.overwrite 不是这里的语义。
  if (data?.force !== true) {
    const guard = await readLexiconFile(root, safeBook);
    if (guard.corrupt === true) {
      const err = new Error(
        "词表文件无法读取或内容不是合法 JSON，已拒绝覆盖以免丢掉原条目：" + file +
        "；原因：" + (guard.corruptError ?? "解析失败") +
        "【解决：先备份并手工修复该文件；确认要丢弃其内容时用 force/overwrite 覆盖写入】"
      );
      err.code = "ENOVELWRITEFAIL";
      err.corrupt = true;
      throw err;
    }
  }
  await mkdir(dirname(file), { recursive: true });
  const entries = normalizeLexiconList(data?.entries);
  const payload = { book: safeBook, enabled: data?.enabled !== false, entries, updatedAt: new Date().toISOString() };
  await atomicWriteJson(file, payload);
  await noteRoot(root); // 与 settings 写操作同口径：记录书库根，供 UI 定位数据目录
  return { file, enabled: payload.enabled, entries, count: entries.length };
}
/** 一条词条归一：term 为空一律丢弃（不污染词表）；数组字段接受字符串（逗号/顿号/空格分隔）。 */
export function normalizeLexiconEntry(raw) {
  if (raw === null || raw === void 0) return null;
  let entry = raw;
  if (typeof raw === "string") entry = parseLexiconLine(raw) ?? {};
  if (typeof entry !== "object" || Array.isArray(entry)) return null;
  const term = String(entry.term ?? entry.word ?? entry.name ?? "").trim();
  if (term === "" || term.length > 60) return null;
  const out = { term };
  const kind = String(entry.kind ?? "").trim();
  if (kind !== "") out.kind = kind.slice(0, 12);
  for (const key of ["scene", "note"]) {
    const value = entry[key];
    if (value !== null && value !== void 0 && String(value).trim() !== "") out[key] = String(value).trim().slice(0, 200);
  }
  for (const key of ["avoid", "aliases"]) {
    const list = Array.isArray(entry[key]) ? entry[key]
      : (typeof entry[key] === "string" ? entry[key].split(/[,，、\s]+/) : []);
    const cleaned = [...new Set(list.map(function (x) { return String(x).trim(); }).filter(function (x) { return x !== "" && x !== term; }))];
    if (cleaned.length > 0) out[key] = cleaned;
  }
  if (entry.priority === "high") out.priority = "high";
  if (entry.enabled === false) out.enabled = false;
  return out;
}
/** 同一 term 后写覆盖前写（书级覆盖全局也走这条），保持首次出现顺序。 */
export function normalizeLexiconList(list) {
  const out = [];
  const index = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const entry = normalizeLexiconEntry(raw);
    if (entry === null) continue;
    if (index.has(entry.term)) {
      out[index.get(entry.term)] = { ...out[index.get(entry.term)], ...entry };
      continue;
    }
    index.set(entry.term, out.length);
    out.push(entry);
  }
  return out;
}
/** 词条转一行文本（工具输出与 UI 共用口径）。 */
export function lexiconEntryLine(entry) {
  const bits = [entry.term];
  if (entry.kind) bits.push(entry.kind);
  if (entry.scene) bits.push("场景:" + entry.scene);
  if (Array.isArray(entry.avoid) && entry.avoid.length > 0) bits.push("勿用:" + entry.avoid.join("/"));
  if (Array.isArray(entry.aliases) && entry.aliases.length > 0) bits.push("等价:" + entry.aliases.join("/"));
  if (entry.note) bits.push(entry.note);
  if (entry.priority === "high") bits.push("★高优先");
  if (entry.enabled === false) bits.push("（已停用）");
  return bits.join("｜");
}
/** 合并追加：existing 中同 term 的条目按 patch 覆盖；返回新数组与统计。 */
export function mergeLexiconEntries(existing, incoming, opts) {
  const list = normalizeLexiconList(existing);
  const index = new Map(list.map(function (e, i) { return [e.term, i]; }));
  const added = [], updated = [], skipped = [];
  for (const raw of normalizeLexiconList(incoming)) {
    if (index.has(raw.term)) {
      const i = index.get(raw.term);
      if (opts?.overwrite === false) { skipped.push(raw.term); continue; }
      list[i] = { ...list[i], ...raw };
      updated.push(raw.term);
    } else {
      index.set(raw.term, list.length);
      list.push(raw);
      added.push(raw.term);
    }
  }
  return { entries: list, added, updated, skipped };
}
/** 按场景命中度 + 优先级排序供开写包取用：场景命中 > 高优先 > 书级 > 其余（保持登记顺序）。 */
export function selectLexiconForBrief(entries, outlineDirection, limit) {
  const direction = String(outlineDirection ?? "");
  const active = (Array.isArray(entries) ? entries : []).filter(function (e) { return e.enabled !== false; });
  const scored = active.map(function (e, i) {
    const sceneHit = e.scene !== void 0 && e.scene !== "" && direction !== "" && direction.includes(e.scene);
    const score = (sceneHit ? 4 : 0) + (e.priority === "high" ? 2 : 0) + (e.scope === "book" ? 1 : 0);
    return { entry: e, score, order: i };
  });
  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return a.order - b.order;
  });
  const cap = typeof limit === "number" && limit > 0 ? limit : scored.length;
  return { items: scored.slice(0, cap).map(function (x) { return x.entry; }), total: scored.length, truncated: scored.length > cap };
}
/** 按 kind 分组（无 kind 归入「其他」），组内保持原顺序。 */
export function groupLexiconByKind(entries) {
  const groups = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const key = e.kind !== void 0 && e.kind !== "" ? e.kind : "其他";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return [...groups.entries()].map(function ([kind, list]) { return { kind, entries: list }; });
}
function lexiconSnippet(line) {
  const text = String(line ?? "").trim();
  return text.length > 46 ? text.slice(0, 46) + "…" : text;
}
/**
 * 成稿用词审计（只读）：对给定正文统计
 *   covered —— 已用到的必用词（含 aliases 等价写法）及首次出现行
 *   missing —— 一次都没出现的必用词（按 场景命中/高优先 靠前）
 *   avoidHits —— 用了「通用替身词」的位置（行号 + 原句片段），说明该处本该用必用词
 */
export function auditLexicon(entries, text, outlineDirection) {
  const lines = String(text ?? "").split(/\r?\n/);
  const covered = [], missing = [], avoidHits = [];
  const { items } = selectLexiconForBrief(entries, outlineDirection, 0);
  // v7.1.0 修正（审查 #31）：**合法专名占位**提到词条循环之外，跨词条共享。
  // 旧版每个词条各分一份 lineSpans（只在循环内可见）：A 条目的必用词「灵芝草」占住的位置，
  // 到了 B 条目的替身词「草」那里完全不可见 → 正常的专名内部用字被报成"用了通用替身词"。
  const lineSpans = lines.map(() => []);
  for (const e of items) {
    const forms = [...new Set([e.term, ...(Array.isArray(e.aliases) ? e.aliases : [])])]
      .filter((f) => typeof f === "string" && f.length > 0)
      .sort((a, b) => b.length - a.length);
    let count = 0;
    let firstLine = 0;
    // 覆盖计数仍然只看**本词条**的占位：共享全局占位会让"短词落在另一条目的长词里"被漏计
    //（例：「草药」与「药」都登记、正文只有「草药」时，「药」明明出现了却被判 missing）。
    const ownSpans = lines.map(() => []);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const own = ownSpans[i];
      for (const form of forms) {
        let from = 0;
        while (from <= line.length - form.length) {
          const at = line.indexOf(form, from);
          if (at === -1) break;
          const end = at + form.length;
          // v7.1.0 修正（审查 #31）：**严格包含**判定（旧版是区间相交 at < s.end && end > s.start）。
          // 相交判定会把「草药」当成"已落在必用词「药」内部"从而漏报——替身词包含必用词时
          // 必须报。只有 s.start <= at && end <= s.end（整段落在合法专名内）才算正常用词。
          const overlapped = own.some((s) => s.start <= at && end <= s.end);
          if (!overlapped) {
            own.push({ start: at, end });
            lineSpans[i].push({ start: at, end }); // 全局占位：供下方 avoid 判定（跨词条互通）
            count += 1;
            if (firstLine === 0) firstLine = i + 1;
          }
          from = end;
        }
      }
    }
    if (count > 0) covered.push({ term: e.term, count, firstLine });
    else missing.push({ term: e.term, kind: e.kind ?? "", scene: e.scene ?? "", priority: e.priority === "high" ? "high" : "normal" });
  }
  // 替身词判定单独一遍：必须等**所有**词条的必用词占位都算完，跨词条保护才成立。
  for (const e of items) {
    for (const word of Array.isArray(e.avoid) ? e.avoid : []) {
      if (typeof word !== "string" || word.length === 0) continue;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const spans = lineSpans[i];
        let from = 0;
        while (from <= line.length - word.length) {
          const at = line.indexOf(word, from);
          if (at === -1) break;
          const end = at + word.length;
          // v7.1.0 修正（审查 #31）：同上，严格包含（替身词"包含"必用词时不得被当成合法专名）。
          const insideCoveredForm = spans.some((s) => s.start <= at && end <= s.end);
          if (!insideCoveredForm) {
            avoidHits.push({ term: e.term, word, line: i + 1, snippet: lexiconSnippet(line) });
          }
          from = end;
        }
      }
    }
  }
  const total = items.length;
  return {
    total,
    coveredCount: covered.length,
    missingCount: missing.length,
    coverage: total > 0 ? Math.round((covered.length / total) * 1000) / 10 : 100,
    covered,
    missing,
    avoidHits
  };
}

export function summariesFile(root, book) {
  return join(novelDataDir(root), "summaries", sanitizeSegment(book, "book") + ".json");
}
export async function readSummaries(root, book) {
  try {
    const parsed = JSON.parse(await readFile(summariesFile(root, book), "utf8"));
    return Array.isArray(parsed.summaries) ? parsed.summaries : [];
  } catch (e) {
    // v6.6.0：「本章还没有摘要」与「摘要文件读不动/损坏」在 list/get 里长得一样；
    // 本条是 JSON.parse 路径（消息会回显文件内容片段），故只记固定标签，绝不带 e.message
    if (e?.code !== "ENOENT") {
      logEvent("config", { book, file: summariesFile(root, book), level: "warn", detail: "章节摘要读取失败（按无摘要处理）" });
    }
    return [];
  }
}
export function cleanSummaryEntry(s) {
  if (!s || typeof s !== "object") return null;
  const out = { chapter: String(s.chapter ?? ""), summary: String(s.summary ?? "") };
  if (Array.isArray(s.keyEvents)) out.keyEvents = s.keyEvents.map(String);
  if (Array.isArray(s.keySettings)) out.keySettings = s.keySettings.map(String);
  if (s.updatedAt !== void 0 && s.updatedAt !== null) out.updatedAt = String(s.updatedAt);
  return out;
}

export const CREATION_DIR = "创作资料";
export const CREATION_FILES = {
  bible: "创作设定.md", "characters-main": "主要人物设定.md", "characters-minor": "次要人物设定.md",
  outline: "剧情大纲.md", hooks: "钩子记录.md", status: "创作状态卡.md"
};
const CREATION_TEMPLATE_TITLES = new Set(["# 创作设定", "# 主要人物设定", "# 次要人物设定", "# 剧情大纲", "# 钩子记录", "# 创作状态卡"]);
export function creationDir(root, book) {
  return join(root, "novels", CREATION_DIR, sanitizeSegment(book, "book"));
}
async function buildCreationUserSection(root, book, opts = {}) {
  // v3.1.0：字段值单行化（多行文本 → 空格），保证段内无空行、与 upsert 的空行边界配合
  const norm = function (s) { return String(s).replace(/\s*\n+\s*/g, " ").trim(); };
  var segs = [];
  try {
    // v3.1.0：按书专属设定优先（书库 settings/<book>.json > 遗留 state.creationProfiles），无该书专属时回退全局默认
    var cp = await readBookCreationProfile(root, book, { state: opts?.state, fallbackGlobal: true });
    if (cp && typeof cp === "object") {
      if (typeof cp.worldview === "string" && cp.worldview.trim()) segs.push("世界观：" + norm(cp.worldview));
      if (typeof cp.characters === "string" && cp.characters.trim()) segs.push("角色设定：" + norm(cp.characters));
      if (typeof cp.forbidden === "string" && cp.forbidden.trim()) segs.push("不允许的事件：" + norm(cp.forbidden));
      if (typeof cp.mainConflict === "string" && cp.mainConflict.trim()) segs.push("主线目的：" + norm(cp.mainConflict));
      if (typeof cp.genre === "string" && cp.genre.trim()) segs.push("题材偏好：" + norm(cp.genre));
      if (typeof cp.extra === "string" && cp.extra.trim()) segs.push("额外要求：" + norm(cp.extra));
    }
  } catch { /* 读不到则视为无设定 */ }
  if (segs.length === 0) return "";
  return "【用户原创设定】（侧边栏填写，必须遵守；未列出的维度由模型自行设定）\n" + segs.map(function (s) { return "- " + s; }).join("\n") + "\n";
}
function upsertCreationSection(text, section, marker) {
  // 段边界 = 下一个标题（标题前可有空行/缩进）/ 下一个【…】段 / 文件尾（防吞掉段后手写内容）
  // v4.3.0 修正：旧前瞻 (?=\n# |\n\n|\s*$) 把「空行」当成段尾，段内一旦有空行就只覆盖到第一个空行——
  // remove 残留（"- 额外：B" 留在文件里）、replace 新旧两段并存（标记出现两次）。
  // 改为只认真正的段尾标记（# 标题 / 【…】段 / 文件尾）。`\r?\n\s*` 前缀是必需的：下一个标题前常有空行，
  // 若按字面写成 (?=\n# ) 则 "\n\n# 主要人物设定" 匹配不上，惰性量词会一路吞掉手写内容；
  // 同时容忍 CRLF（用户用记事本编辑过创作资料）。marker 转义：避免未来引入带正则元字符的标记时炸开。
  const escaped = String(marker).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(?:\\r?\\n){0,2}" + escaped + "[\\s\\S]*?(?=\\r?\\n\\s*#|\\r?\\n\\s*【|\\s*$)");
  const has = text.includes(marker);
  if (section === "") {
    if (!has) return text;
    const t = text.replace(re, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    return t;
  }
  if (has) {
    // v4.0.0 修正：改用函数式替换，避免用户文本里的 "$1"/"$&" 等美元替换模式被展开
    return text.replace(re, function () { return "\n\n" + section.trimEnd(); });
  }
  return text.trimEnd() + "\n\n" + section;
}
function upsertCreationUserSection(text, section) {
  return upsertCreationSection(text, section, "【用户原创设定】");
}
async function buildCreationCharacterSection(root, book, opts = {}) {
  const norm = function (s) { return String(s).replace(/\s*\n+\s*/g, " ").trim(); };
  try {
    var cp = await readBookCreationProfile(root, book, { state: opts?.state, fallbackGlobal: true });
    if (cp && typeof cp === "object" && typeof cp.characters === "string" && cp.characters.trim()) {
      return "【用户角色设定】（侧边栏填写，必须遵守）\n- 角色设定：" + norm(cp.characters) + "\n";
    }
  } catch { /* 读不到则视为无 */ }
  return "";
}
// v6.2.1 修正：读创作资料的**唯一入口**——只有"文件不存在"才回落到模板，其余读失败一律上抛。
// 旧版三处写动作（character/chapter/hook）都写成 `try { readTextFile } catch { 模板 }` 再整文件写回：
// readTextFile 会因「编码无法识别」「exec.signal 取消」「EACCES/EMFILE」抛错，这些都被当成"文件不存在"，
// 于是用户手写的剧情大纲 / 钩子记录 / 人物设定被静默清成一行新条目，工具还回"已补 / 已登记"。
async function readCreationFileOr(f, fallback, exec) {
  try {
    return await readTextFile(f, exec);
  } catch (e) {
    // 取消不是"读不到"：原样上抛，绝不降级成模板后写盘（否则取消会变成对用户文件的一次覆盖）
    if (isAbort(e)) throw e;
    // v6.6.0：这一支随后会把错误上抛（调用方自己会报出真因），此处只补一条可定位的痕迹，
    // 便于在事件日志里把「某次写动作在哪个文件上因何种错误中止」与调用方的失败对上
    if (e?.code !== "ENOENT") {
      logEvent("silent_skip", { file: f, level: "warn", detail: "创作资料读取失败（已上抛，未回落到模板）：" + String(e?.message ?? e) });
    }
    // 下面这行的条件与上一段相同是**刻意的**：原有控制流一行未动，本版只加日志、不改错误处理
    if (e?.code !== "ENOENT") throw e;
    return fallback;
  }
}
export async function syncCreationProfileFiles(root, patchProfiles, nextProfiles) {
  if (!root) return;
  let resolvedPatch = patchProfiles;
  let resolvedNext = nextProfiles;
  if (typeof patchProfiles === "string") {
    const singleBook = patchProfiles.trim();
    if (singleBook === "") return;
    const normSingle = normalizeCreationProfile(nextProfiles);
    resolvedPatch = { [singleBook]: normSingle };
    resolvedNext = normSingle ? { [singleBook]: normSingle } : {};
  } else if (resolvedNext === void 0 && resolvedPatch && typeof resolvedPatch === "object" && Object.keys(resolvedPatch).length > 0) {
    resolvedNext = await listBookCreationProfiles(root);
  }
  const base = join(root, "novels", CREATION_DIR);
  // v3.5.0 #20：清除全部（patch 为空对象 {} 或 nextProfiles 为 null）→ 扫描全部创作资料目录，逐本移除用户段 + 空壳清理
  const clearAll = (resolvedPatch && typeof resolvedPatch === "object" && Object.keys(resolvedPatch).length === 0) || resolvedNext === null;
  if (clearAll && !(resolvedPatch && Object.keys(resolvedPatch).length > 0)) {
    try {
      const books4 = await readdir(base, { withFileTypes: true });
      for (const b4 of books4) {
        if (!b4.isDirectory()) continue;
        const bf = join(base, b4.name, CREATION_FILES.bible);
        if (existsSync(bf)) {
          const bcur = await readFile(bf, "utf8");
          const bnext = upsertCreationUserSection(bcur, "");
          if (bnext !== bcur) await writeFile(bf, bnext, "utf8");
        }
        const bcf = join(base, b4.name, CREATION_FILES["characters-main"]);
        if (existsSync(bcf)) {
          const ccur = await readFile(bcf, "utf8");
          const cnext = upsertCreationSection(ccur, "", "【用户角色设定】");
          if (cnext !== ccur) await writeFile(bcf, cnext, "utf8");
        }
        // 空壳清理（复用下方逻辑：目录仅 6 个文件且全骨架才删）
        const d4 = join(base, b4.name);
        let safe4 = true;
        const allowed4 = new Set(Object.values(CREATION_FILES));
        for (const e4 of await readdir(d4, { withFileTypes: true })) {
          if (!allowed4.has(e4.name) || !e4.isFile()) { safe4 = false; break; }
          const c4 = await readFile(join(d4, e4.name), "utf8");
          const meaningful4 = c4.split("\n").map(function (l) { return l.trim(); }).filter(Boolean).filter(function (l) { return !CREATION_TEMPLATE_TITLES.has(l) && !l.startsWith("（") && !l.startsWith("【"); });
          if (meaningful4.length > 0) { safe4 = false; break; }
        }
        if (safe4) await rm(d4, { recursive: true, force: true });
      }
    } catch { /* 目录不存在等 */ }
    return;
  }
  // 删除的键（patch 中 null / 空设定）：移除用户段
  if (resolvedPatch && typeof resolvedPatch === "object") {
    for (const book of Object.keys(resolvedPatch)) {
      if (resolvedPatch[book] === null || resolvedPatch[book] === void 0 || normalizeCreationProfile(resolvedPatch[book]) === null) {
        try {
          const f = join(base, sanitizeSegment(book, "book"), CREATION_FILES.bible);
          if (existsSync(f)) {
            const cur = await readFile(f, "utf8");
            const next = upsertCreationUserSection(cur, "");
            if (next !== cur) await writeFile(f, next, "utf8");
          }
          // v3.1.0：同时移除主要人物设定.md 的【用户角色设定】段
          const cf = join(base, sanitizeSegment(book, "book"), CREATION_FILES["characters-main"]);
          if (existsSync(cf)) {
            const ccur = await readFile(cf, "utf8");
            const cnext = upsertCreationSection(ccur, "", "【用户角色设定】");
            if (cnext !== ccur) await writeFile(cf, cnext, "utf8");
          }
          // v3.1.1/v3.5.0 #3：空壳文件夹清理——目录里只允许插件管理的 6 个文件、且全部只剩模板骨架时，才整目录删除（用户自建文件/有内容即保留，防连锅端）
          const dir3 = join(base, sanitizeSegment(book, "book"));
          if (existsSync(dir3)) {
            let safeToDelete = true;
            const allowedNames = new Set(Object.values(CREATION_FILES));
            const entries3 = await readdir(dir3, { withFileTypes: true });
            for (const e3 of entries3) {
              if (!allowedNames.has(e3.name)) { safeToDelete = false; break; }
              if (!e3.isFile()) { safeToDelete = false; break; }
              const c = await readFile(join(dir3, e3.name), "utf8");
              // v3.5.0 #3：仅精确模板标题可忽略（手写标题结构算用户内容）
const meaningful = c.split("\n").map(function (l) { return l.trim(); }).filter(Boolean).filter(function (l) { return !CREATION_TEMPLATE_TITLES.has(l) && !l.startsWith("（") && !l.startsWith("【"); });
              if (meaningful.length > 0) { safeToDelete = false; break; }
            }
            if (safeToDelete) await rm(dir3, { recursive: true, force: true });
          }
        } catch {
          // v6.6.0：移除已删书目的用户段失败 → 面板说"已保存"，而 .md 里的旧段还在（静默不一致）
          logEvent("config", { book, level: "warn", detail: "移除创作资料用户段失败（面板设定与 .md 文件不一致）" });
        }
      }
    }
  }
  // 现存书（有有效设定）：创建/更新创作设定.md
  if (resolvedNext && typeof resolvedNext === "object") {
    let baseState = {};
    try { baseState = await readSentenceState(); } catch { baseState = {}; }
    const syncState = { ...baseState, creationProfiles: resolvedNext };
    for (const book of Object.keys(resolvedNext)) {
      const v = resolvedNext[book];
      if (!v || typeof v !== "object" || Object.keys(v).length === 0) continue;
      const dir = join(base, sanitizeSegment(book, "book"));
      try {
        await mkdir(dir, { recursive: true });
        const userSection = await buildCreationUserSection(root, book, { state: syncState });
        const f = join(dir, CREATION_FILES.bible);
        if (!existsSync(f)) {
          await writeFile(f, "# 创作设定\n\n（世界观规则 / 主线冲突 / 分卷目的 / 禁忌）\n\n" + userSection, "utf8");
        } else {
          const cur = await readFile(f, "utf8");
          const next = upsertCreationUserSection(cur, userSection);
          if (next !== cur) await writeFile(f, next, "utf8");
        }
        // v3.1.0：主要人物设定.md 同步【用户角色设定】段（方案 A：角色设定各归其位）
        const cs = await buildCreationCharacterSection(root, book, { state: syncState });
        const cf2 = join(dir, CREATION_FILES["characters-main"]);
        if (cs !== "") {
          if (!existsSync(cf2)) {
            await writeFile(cf2, "# 主要人物设定\n\n（目标→动机→弱点→说话方式→关系）\n\n" + cs, "utf8");
          } else {
            const ccur = await readFile(cf2, "utf8");
            const cnext = upsertCreationSection(ccur, cs, "【用户角色设定】");
            if (cnext !== ccur) await writeFile(cf2, cnext, "utf8");
          }
        } else if (existsSync(cf2)) {
          const ccur = await readFile(cf2, "utf8");
          const cnext = upsertCreationSection(ccur, "", "【用户角色设定】");
          if (cnext !== ccur) await writeFile(cf2, cnext, "utf8");
        }
      } catch {
        // v6.6.0：写创作资料 .md 失败（权限/占用/磁盘）→ 用户填的原创设定没进文件，
        // 而工具/面板已经回了"已保存"——这类"看起来成功"的写失败必须留痕
        logEvent("config", { book, level: "warn", detail: "创作资料写入失败（该书的设定未同步到 .md 文件）" });
      }
    }
  }
}
/** 逐行用 OUTLINE_LINE_RE 取章号（去重、保序）；非方向行直接忽略。core 内部复用该正则的唯一入口。 */
function outlineNumbers(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = OUTLINE_LINE_RE.exec(line);
    if (m === null) continue;
    const n = parseInt(m[1], 10);
    if (Number.isInteger(n) && !out.includes(n)) out.push(n);
  }
  return out;
}
export function createOutlineTool(config) {
  return {
    name: "novel_outline",
    description: "维护原创小说的创作资料（novels/创作资料/<书名>/）：创作设定/主要人物/次要人物/剧情大纲/钩子记录/创作状态卡的初始化、读取与更新。",
    parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string", description: "书名（novels/创作资料 下的子目录名）。" },
          root: { type: "string", description: "章节库根目录。" },
          action: { type: "string", enum: ["init", "read", "bible", "character", "chapter", "hook", "status"], description: "init=初始化创作资料；read=读文件（bible/characters-main/characters-minor/outline/hooks/status）；bible=写入创作设定；character=登记/提升人物；chapter=补大纲方向行；hook=回填某章结尾钩子；status=刷新创作状态卡。" },
          file: { type: "string", description: "read 时指定（bible/characters-main/characters-minor/outline/hooks/status，省略=status）。" },
          content: { type: "string", description: "bible（创作设定全文）/ status（状态卡全文）时用。" },
          role: { type: "string", enum: ["main", "minor"], description: "character 时：main=主要人物 / minor=次要人物。" },
          name: { type: "string", description: "character 时：人物名。" },
          description: { type: "string", description: "character 时：人物简介（目标/动机/弱点/说话方式）。" },
          number: { type: "number", description: "chapter/hook 时：章节号。" },
          title: { type: "string", description: "chapter 时：本章标题/方向（一行）。" },
          body: { type: "string", description: "hook 时：本章结尾钩子（状态/悬念/时间场景）。" }
        },
        required: ["book", "action"]
    },
    output: {
        schema: {
          type: "object",
          additionalProperties: true,
          // v4.3.0 修正：删掉从不产出的 files（七个 action 没有一个返回它），补上 read 真实返回的 file
          properties: { book: { type: "string" }, action: { type: "string" }, message: { type: "string" }, content: { type: "string" }, file: { type: "string" } }
        },
        render: (_args, value) => {
          const lines = [`<path>novels/创作资料/${value.book}</path>`, "<type>novel-outline</type>", "<content>", ""];
          if (value.action === "read" && value.content) { lines.push(value.content); }
          else if (value.message) lines.push(value.message);
          lines.push("", "</content>");
          return [{ type: "text", text: lines.join("\n") }];
        }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_outline");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const action = args?.action ?? "read";
      const root = resolveRoot(config, args, exec);
      const dir = creationDir(root, book);

      if (action === "init") {
        await mkdir(dir, { recursive: true });
        const outlineState = await readSentenceState();
        const userSection = await buildCreationUserSection(root, book, { state: outlineState });
        const files = [
          ["bible", "# 创作设定\n\n（世界观规则 / 主线冲突 / 分卷目的 / 禁忌）\n\n" + userSection],
          ["characters-main", "# 主要人物设定\n\n（目标→动机→弱点→说话方式→关系）\n"],
          ["characters-minor", "# 次要人物设定\n\n（谁/作用/特征；不再出场标注）\n"],
          ["outline", "# 剧情大纲\n\n（每章方向行，写完回填钩子到钩子记录）\n"],
          ["hooks", "# 钩子记录\n\n（每章结尾钩子：状态/悬念/时间场景）\n"],
          ["status", "# 创作状态卡\n\n（进度/上一章结尾/时间线/活跃角色/下章方向/未回填钩子）\n"]
        ];
        // v7.3.3 修（M5）：写入前先统一检查六个目标路径没有被同名目录占位。旧版 existsSync 对目录也返回 true，
        // 于是「文件名被同名目录占位」的那些文件被静默跳过，init 仍回「已初始化（6 个文件）」，
        // 随后 read 才在 readFile 上炸 EISDIR（用户看到的是「初始化成功」却读不出内容）。
        // 放在写入循环之前：宁可一个文件都不写，也不要写到一半才报错。
        for (const [key] of files) {
          const f = join(dir, CREATION_FILES[key]);
          let occupiedByDir = false;
          try { occupiedByDir = (await stat(f)).isDirectory(); } catch (e) { if (e?.code !== "ENOENT") throw e; }
          if (occupiedByDir) {
            throw new Error("创作资料初始化失败：" + CREATION_FILES[key] + " 被同名目录占位（" + f + "）——请删除或重命名该目录后重试；init 不会写入被目录占位的路径");
          }
        }
        for (const [key, content] of files) {
          const f = join(dir, CREATION_FILES[key]);
          if (!existsSync(f)) {
            await writeFile(f, content, "utf8");
          } else if (key === "bible") {
            // v3.1.0：设定陈旧化修复——bible 已存在时只更新【用户原创设定】段（保留用户手写部分；无设定则移除旧段）
            const cur = await readTextFile(f, exec);
            const next = upsertCreationUserSection(cur, userSection);
            if (next !== cur) await writeFile(f, next, "utf8");
          }
          // v3.1.0：主要人物设定.md 角色段同步——首次创建（写模板后）与已存在（upsert）统一执行，角色设定不丢
          if (key === "characters-main") {
            const cs2 = await buildCreationCharacterSection(root, book, { state: outlineState });
            const ccur2 = await readTextFile(f, exec);
            const cnext2 = upsertCreationSection(ccur2, cs2, "【用户角色设定】");
            if (cnext2 !== ccur2) await writeFile(f, cnext2, "utf8");
          }
        }
        await noteRoot(root); // v3.9.0：outline 写操作记录书库根
        return { book, action, message: "创作资料已初始化（" + files.length + " 个文件）" };
      }

      if (action === "read") {
        const key = String(args?.file ?? "status");
        // v4.0.0 修正：改用 hasOwnProperty——旧版 CREATION_FILES["constructor"/"__proto__"] 命中原型链，
        // join(dir, 函数/对象) 抛裸 TypeError，而不是设计好的友好提示（read 的 file 参数是自由字符串）
        if (!Object.prototype.hasOwnProperty.call(CREATION_FILES, key)) throw new Error("未知文件：" + key + "（可用 bible/characters-main/characters-minor/outline/hooks/status）");
        const f = join(dir, CREATION_FILES[key]);
        let content = "";
        try {
          content = await readTextFile(f, exec);
        } catch (e) {
          // v6.6.0：**读不到 ≠ 没初始化**。旧版把任何读失败（损坏 / EACCES / 编码无法识别 / 取消）
          // 都说成「创作资料尚未初始化，请先 novel_outline init」——用户照做也修不好，真因彻底丢失。
          // 口径与 readCreationFileOr 一致（同文件上方）：取消先放行，只有 ENOENT 才是「尚未初始化」。
          if (isAbort(e)) throw e;
          if (e?.code === "ENOENT") throw new Error("创作资料尚未初始化，请先 novel_outline init（或在创作文件夹自行创建）", { cause: e });
          logEvent("config", { book, file: CREATION_FILES[key], level: "warn", detail: "创作资料读取失败（不是「尚未初始化」）：" + String(e?.message ?? e) });
          throw new Error("创作资料读取失败：" + f + "：" + String(e?.message ?? e).slice(0, 200), { cause: e });
        }
        // 强制机制：读状态卡/大纲时检查未回填钩子
        let remind = "";
        if (key === "status" || key === "outline") {
          try {
            // v3.1.0：大纲章节号从大纲文件提取（status 文件只有快照，不含章节行）
            const outlineContent = key === "status" ? await readTextFile(join(dir, CREATION_FILES.outline), exec) : content;
            const hooks = await readTextFile(join(dir, CREATION_FILES.hooks), exec);
            // v7.1.0 修正（审查 #52）：方向行解析统一走 OUTLINE_LINE_RE（与 graph/fixplan 同一口径，
            // 不再各写一份互相漏字：旧版 core 只认行首 `- 数字`，graph 还漏了「节」）。
            const outlined = outlineNumbers(outlineContent);
            const hooked = outlineNumbers(hooks);
            // v4.3.0 修正：只对**磁盘上确实存在**的章节报"未回填钩子"。
            // 旧版拿"大纲里出现过的章号"直接比对钩子记录，而大纲按设计会预先列出下一批章节方向
            // （如已写 1-5 章、大纲已有 `- 6 第6章方向…`），于是把尚未动笔的第 6 章也算成"写完却没回填"，
            // 提示与事实不符（实测：雨夜灯只有 5 章，却提示"未回填钩子章节：6"）。
            // 扫描失败时退回旧口径（宁多提醒，不漏提醒）。
            let existing = null;
            try {
              const scanned = await scanChapters(bookDir(root, book));
              existing = new Set(scanned
                .map((c) => c.number)
                .filter((n) => typeof n === "number"));
            } catch (e) {
              // v6.6.0：扫描失败 → 退回旧口径，但「章节扫不到」与「章还没写」在提醒文案上一模一样
              // 注意 cause：scanChapters 会把 ENOENT 包成友好错误（code 落在 cause 上，见其 catch），
              // 只看 e.code 会把最常见的「书目录还不存在」记成故障 ✗（实测的假阳性）
              if (e?.code !== "ENOENT" && e?.cause?.code !== "ENOENT") {
                logEvent("silent_skip", { book, level: "warn", detail: "章节扫描失败（未回填钩子提醒退回旧口径）：" + String(e?.message ?? e) });
              }
              /* 章节扫描失败：退回旧口径（宁多提醒，不漏提醒） */
            }
            const missing = outlined.filter((n) => !hooked.includes(n) && (existing === null || existing.has(n)));
            if (missing.length > 0) remind = "\n\n⚠ 未回填钩子章节：" + missing.join("、") + "——写完的章节必须回填钩子（novel_outline hook），下一章开头从钩子接续";
          } catch (e) {
            // v7.3.3 修（#11/M7）：取消先放行——旧版把 AbortError 当成「未初始化」吞掉，工具成功返回、
            // 只是少了「未回填钩子」提醒；取消还会被写进 silent_skip 事件日志（M7）。放行早于 logEvent。
            if (isAbort(e)) throw e;
            // v6.6.0：这里把任何读失败都当成「未初始化」而静默不提醒——非 ENOENT（损坏/权限/取消）必须留痕
            if (e?.code !== "ENOENT") {
              logEvent("silent_skip", { book, level: "warn", detail: "钩子记录/剧情大纲读取失败（未回填钩子提醒跳过）：" + String(e?.message ?? e) });
            }
            /* 未初始化 */
          }
        }
        return { book, action, file: key, content: content + remind };
      }

      if (action === "bible") {
        const content = requiredString(args, "content");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, CREATION_FILES.bible), content, "utf8");
        await noteRoot(root); // v3.9.0：outline 写操作记录书库根
        return { book, action, message: "创作设定已更新（" + content.length + " 字）" };
      }

      if (action === "character") {
        const role = args?.role === "main" ? "main" : "minor";
        const name = requiredString(args, "name");
        const description = String(args?.description ?? "").replace(/\s*\n+\s*/g, "；").trim(); // v3.1.0：换行转分号，防断行伪造条目
        const f = join(dir, CREATION_FILES[role === "main" ? "characters-main" : "characters-minor"]);
        // v6.2.1：读失败只在 ENOENT 时回落模板（旧版把任何读失败都当"文件不存在"，随后整文件覆盖）
        const cur = await readCreationFileOr(f, (role === "main" ? "# 主要人物设定\n" : "# 次要人物设定\n") + "\n", exec);
        if (!existsSync(f)) await mkdir(dir, { recursive: true });
        const cur2 = cur.startsWith("# 主") || cur.startsWith("# 次") ? cur : "# " + (role === "main" ? "主要人物设定\n" : "次要人物设定\n") + "\n" + cur;
        const line = "- " + name + (description ? "：" + description : "") + "\n";
        // v3.5.0 #33：行首锚定判重（"阿"不再误判"阿澈"已存在）
        if (new RegExp("^[-*] " + String(name).replace(/[.*+?^${}()|[\]\\]/g, function (ch) { return "\\" + ch; }) + "(：|$)", "m").test(cur2)) return { book, action, message: "人物\u201c" + name + "\u201d已存在（未重复登记）" };
        await mkdir(dir, { recursive: true });
        await writeFile(f, cur2.endsWith("\n") ? cur2 + line : cur2 + "\n" + line, "utf8");
        await noteRoot(root); // v3.9.0：outline 写操作记录书库根
        return { book, action, message: "已登记人物“" + name + "”到" + (role === "main" ? "主要" : "次要") + "人物设定" };
      }

      if (action === "chapter") {
        const number = parseInt(args?.number, 10);
        const title = String(args?.title ?? "").replace(/\s*\n+\s*/g, " ").trim(); // v3.1.0：单行化
        if (isNaN(number) || number < 1 || number > MAX_CHAPTER_NUMBER) throw new Error(`chapter 需要 1~${MAX_CHAPTER_NUMBER} 的正整数 number`);
        const f = join(dir, CREATION_FILES.outline);
        // v6.2.1：同上——只有 ENOENT 才用空模板，读失败宁可报错也不覆盖用户手写的大纲
        const cur = await readCreationFileOr(f, "# 剧情大纲\n\n", exec);
        if (!existsSync(f)) await mkdir(dir, { recursive: true });
        const cur2 = cur.startsWith("# 剧") ? cur : "# 剧情大纲\n\n" + cur;
        const line = "- " + number + " " + title + "\n";
        // v7.1.0 修正（审查 #52）：判重必须**行首锚定**。旧版 `cur2.includes("- " + number + " ")`
        // 把正文里任何形如「- 3 」的片段（例：「他数了 - 3 秒钟」）都当成"第 3 章已在纲"，
        // 于是真的方向行永远补不进去（静默漏写）。只认行首 `- N` / `* N` 方向行。
        const alreadyOutlined = new RegExp("^[ \\t]*[-*][ \\t]+" + number + "(?=[ \\t]|$)", "m").test(cur2);
        if (alreadyOutlined) {
          return { book, action, message: "第 " + number + " 章已在纲（未重复追加）" };
        }
        await mkdir(dir, { recursive: true });
        await writeFile(f, cur2.endsWith("\n") ? cur2 + line : cur2 + "\n" + line, "utf8");
        await noteRoot(root); // v3.9.0：outline 写操作记录书库根
        return { book, action, message: "大纲已补：第 " + number + " 章 " + title };
      }

      if (action === "hook") {
        const number = parseInt(args?.number, 10);
        const body = String(args?.body ?? "").replace(/\s*\n+\s*/g, " ").trim(); // v3.1.0：单行化，防换行伪造钩子条目
        if (isNaN(number)) throw new Error("hook 需要 number");
        if (body === "") throw new Error("hook 需要 body（本章结尾状态/悬念/时间场景）");
        const f = join(dir, CREATION_FILES.hooks);
        // v6.2.1：同上——只有 ENOENT 才用空模板，读失败宁可报错也不覆盖用户手写的钩子记录
        const cur = await readCreationFileOr(f, "# 钩子记录\n\n", exec);
        if (!existsSync(f)) await mkdir(dir, { recursive: true });
        const cur2 = cur.startsWith("# 钩") ? cur : "# 钩子记录\n\n" + cur;
        // v3.5.0 #34：行首锚定 + 文件尾无换行也能命中；body 单行化防伪造条目
        // v4.3.0 修正：删掉二次 replace(/\n+/g," ")——body 在上方已由 .replace(/\s*\n+\s*/g," ") 单行化，
        // 此处永无换行可替（死代码）；保留的 ^- \d+ 前缀剥离是承重的（调用方误传整行时会写成 "- 1 - 1 …"）
        const oneLineBody = String(body ?? "").replace(/^- \d+ /, "");
        const re = new RegExp("^- " + number + " [^\n]*(?:\n|$)", "m");
        const line = "- " + number + " " + oneLineBody + "\n";
        // v4.0.0 修正：改用函数式替换，避免钩子文本里的 "$&"/"$1" 等美元替换模式把旧行复制进新行
        const next = re.test(cur2) ? cur2.replace(re, function () { return line; }) : (cur2.endsWith("\n") ? cur2 + line : cur2 + "\n" + line);
        await mkdir(dir, { recursive: true });
        await writeFile(f, next, "utf8");
        await noteRoot(root); // v3.9.0：outline 写操作记录书库根
        return { book, action, message: "第 " + number + " 章钩子已回填" };
      }

      if (action === "status") {
        const content = requiredString(args, "content");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, CREATION_FILES.status), content, "utf8");
        await noteRoot(root); // v3.9.0：outline 写操作记录书库根
        return { book, action, message: "创作状态卡已刷新" };
      }

      throw new Error("未知 action：" + action);
    }
  };
}

const TIME_JUMP_WORDS = {
  hard: ["第二天", "第三天", "第四天", "第五天", "三天后", "四天后", "五天后", "六天后", "七天后", "十天后", "数天后", "一周后", "两周后", "半个月后", "一个月后", "两个月后", "三个月后", "半年后", "一年后", "两年后", "三年后", "多年后", "数日后", "几天后", "几天前", "几年后", "不久后", "很久以后"],
  soft: ["次日", "翌日", "次日清晨", "次日黄昏", "隔天", "深夜", "黎明", "清晨", "黄昏", "午夜", "当天晚上", "当晚"]
};
export async function detectChapterBridge(root, book, prevFile, currFile, exec) {
  const out = [];
  // v4.3.0 修正：入口统一净化书名——本函数内原本三处用原始 book 拼路径（章节读取两处 + readSettings），
  // 而同类入口（bookDir/creationDir/readBookAllText）都已净化：书名带非法路径字符时，
  // 前几项检查会读到不存在的路径并被外层 catch 吞成"0 候选"，看起来像"衔接正常"。
  const safeBook = sanitizeSegment(book, "book");
  try {
    const prevText = await readTextFile(join(root, "novels", safeBook, prevFile), exec);
    const currText = await readTextFile(join(root, "novels", safeBook, currFile), exec);
    const prevTail = prevText.slice(-600);
    const currHead = currText.slice(0, 800);
    if (!prevTail.trim() || !currHead.trim()) return out;
    // ① 时间跳跃
    const hardHit = TIME_JUMP_WORDS.hard.filter((w) => currHead.includes(w));
    const softHit = TIME_JUMP_WORDS.soft.filter((w) => currHead.includes(w));
    const prevHasTime = TIME_JUMP_WORDS.hard.some((w) => prevTail.includes(w)) || TIME_JUMP_WORDS.soft.some((w) => prevTail.includes(w));
    // v3.2.0：硬跳词（三天后/一周后…）直接报——跳跃本身就需要过渡确认；软跳词（次日/清晨…）仅在上章无时间锚时提示
    if (hardHit.length > 0) {
      out.push({ type: "衔接·时间跳跃", detail: "本章开头出现「" + hardHit.slice(0, 2).join("/") + "」（时间硬跳）——建议确认开头有过渡句（如“日子一天天过去”），否则补 1 句时间流逝", chapters: [prevFile, currFile] });
    } else if (softHit.length > 0 && !prevHasTime) {
      out.push({ type: "衔接·时间过渡", detail: "本章开头出现「" + softHit.slice(0, 2).join("/") + "」（软跳），可接受但建议确认时间线连贯", chapters: [prevFile, currFile] });
    }
    // ② 语义相似度（本地 embedding，0 token；受 semanticStyle 开关 + 引擎可用性双重门控）
    // v4.0.0 修正：补门控——旧版绕过语义总开关直接加载模型并推理两次，与其它语义入口（1913/2214/3019…）口径不一致
    try {
      const st = await readSentenceState();
      if (semanticFeatureEnabled(st, "semanticStyle") && (await embedding.isAvailable())) {
        const [vPrev, vCurr] = await Promise.all([embedding.embed(prevTail), embedding.embed(currHead)]);
        if (Array.isArray(vPrev) && Array.isArray(vCurr)) {
          const sim = embedding.cosine(vPrev, vCurr);
          if (sim < 0.3) out.push({ type: "衔接·语义距离", detail: "上章结尾与本章开头语义相似度 " + sim.toFixed(2) + "（偏低）——开头可能未承接上章场景，建议加承接句", chapters: [prevFile, currFile] });
          else if (sim < 0.45) out.push({ type: "衔接·语义距离", detail: "语义相似度 " + sim.toFixed(2) + "（一般）——建议确认本章开头与上章结尾的承接", chapters: [prevFile, currFile] });
        }
      }
    } catch {
      // v6.6.0：语义检查没跑 ≠ 衔接没问题——旧版这一项被跳过时，候选列表里没有任何痕迹
      logEvent("engine", { book: safeBook, chapter: currFile, detail: "衔接·语义距离检查失败（本次跳过该项）" });
    }
    // ③ 人物延续（settings character 表；v3.5.0 #6：正确数据源 readSettings，勿用 UI state）
    try {
      const st = await readSettings(root, safeBook);
      const chars = ((st && st.characters) || []).filter((c) => typeof c.name === "string" && c.name.length >= 2);
      const prevNames = chars.filter((c) => prevTail.includes(c.name)).map((c) => c.name);
      const currNames = chars.filter((c) => currHead.includes(c.name)).map((c) => c.name);
      if (prevNames.length > 0 && currNames.length === 0) {
        out.push({ type: "衔接·人物断线", detail: "上章结尾出场人物（" + prevNames.slice(0, 3).join("/") + "）本章开头 800 字均未出现——角色线可能断掉，建议让至少一人承接", chapters: [prevFile, currFile] });
      }
    } catch (e) {
      // v6.6.0：设定表读不到 → 人物延续检查静默跳过，与「这本书没登记过人物」无法区分
      // （readSettings 非 strict 时自己也会留痕；这里补的是**本次检查**的定位信息）
      if (e?.code !== "ENOENT") {
        logEvent("silent_skip", { book: safeBook, chapter: currFile, level: "warn", detail: "衔接·人物延续检查读取设定表失败（该项跳过）：" + String(e?.message ?? e) });
      }
      /* 设定表未登记跳过 */
    }
    // ④ 承接卡（上一章钩子文本 vs 本章开头 bigram 重叠）
    try {
      // v4.3.0 修正：改用 CREATION_DIR/CREATION_FILES 常量（原为手写 join(root,"novels","创作资料",book,"钩子记录.md")，
      // 与 creationDir() 是同一路径的两份实现，改名/改结构时必然漏改一处）
      const hooksPath = join(creationDir(root, safeBook), CREATION_FILES.hooks);
      const hooks = await readTextFile(hooksPath, exec);
      // v7.3.3 修（M6）：钩子行解析统一走 OUTLINE_LINE_RE（与 novel_outline read / graph / fixplan 同口径）。
      // 旧版硬编码 `/^- \d+ /`：同一份 `* 1 …` 钩子文件，novel_outline read 认得并提示「未回填钩子章节」，
      // 这里却一行都取不到 → 0 条「衔接·钩子未接」，两个工具对同一份数据给出相反结论。
      const hookLines = [];
      for (const line of hooks.split(/\r?\n/)) {
        const hm = OUTLINE_LINE_RE.exec(line);
        if (hm === null) continue;
        const hn = parseInt(hm[1], 10);
        if (Number.isInteger(hn)) hookLines.push({ number: hn, text: hm[2] });
      }
      // v3.2.0：取上一章（prevFile）对应的钩子，不取最后一行（钩子记录乱序时防比对错章）
      // v4.0.0 修正：统一章号口径——旧版取文件名首段数字，"第1卷03章.md" 会比对到错误的钩子
      const prevNum = parseChapterNumber(prevFile);
      const prevHook = hookLines.find((h) => h.number === prevNum);
      if (prevHook) {
        const lastHook = prevHook.text;
        // v3.2.0：去重字符命中率 <25% 才报（单字级，短钩子比 bigram 稳；语义接续但字面弱的不误报）
        const hookChars = new Set(lastHook.replace(/[，。！？、\s]/g, "").split(""));
        const headChars = new Set(currHead.slice(0, 300).split(""));
        let hit = 0;
        for (const c of hookChars) if (headChars.has(c)) hit += 1;
        const ratio = hookChars.size > 0 ? hit / hookChars.size : 1;
        if (ratio < 0.25 && lastHook.length > 4) {
          out.push({ type: "衔接·钩子未接", detail: "上一章钩子「" + lastHook.slice(0, 24) + "…」与本章开头字符命中率仅 " + Math.round(ratio * 100) + "%——开头可能没接上钩子（若本章确已接续请忽略此提示）", chapters: [prevFile, currFile] });
        }
      }
    } catch (e) {
      // v7.3.3 修（#11/M7）：取消先放行——旧版把 AbortError 当成「没有创作资料」吞掉，检查静默跳过、
      // 返回值与不取消时完全相同（取消被伪装成成功），还会写进 silent_skip 事件日志（M7）。放行早于 logEvent。
      if (isAbort(e)) throw e;
      // v6.6.0：钩子记录读不到 → 承接检查静默跳过，与「没有创作资料」无法区分（取消也会落到这里）
      if (e?.code !== "ENOENT") {
        logEvent("silent_skip", { book: safeBook, chapter: currFile, level: "warn", detail: "衔接·钩子未接检查读取钩子记录失败（该项跳过）：" + String(e?.message ?? e) });
      }
      /* 无创作资料跳过 */
    }
  } catch (e) {
    // v6.2.1 修正：取消放行——旧版把 AbortError 也渲染成一条「衔接·检查跳过」候选，
    // 用户看到的是"检查跳过"而不是"已取消"（isAbort 是全插件唯一取消判据，详见其定义处注释）。
    if (isAbort(e)) throw e;
    // v4.3.0 修正：读取失败不再静默返回空数组——"文件读不到"与"衔接没有问题"在输出上原本无法区分
    // （整类检查被吞掉，用户会以为检查通过）。透出一条同构候选（带 type/chapters，render 可渲染）。
    out.push({
      type: "衔接·检查跳过",
      detail: "无法读取章节文本（" + safeBook + "：" + prevFile + " → " + currFile + "）：" + String(e?.message ?? e).slice(0, 120) + "——时间/人物/钩子类衔接检查本次全部跳过",
      chapters: [prevFile, currFile]
    });
  }
  return out;
}
