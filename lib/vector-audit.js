/**
 * v7.0.0（v2.1 Phase 2）：本地向量审计——「原地打转」与「大纲漏写」。
 *
 * 为什么值得做：词表和正则只能查"用词好不好"，查不出两类结构性偷懒——
 *   ① **原地打转**：为凑字数把同一处境换着词写三遍（词面不重复，逃过复读检测，但语义原地踏步）；
 *   ② **大纲漏写**：大纲三件事，前面水了两千八，最后一件事被一笔带过或忘掉，而字数与文风指标全合格。
 *
 * 三条纪律（都是踩过的坑）：
 *   ① **只在 novel_fix_plan 里跑**：实测单块 150 字嵌入约 47ms，万字章 3~5 秒。放进 brief / new_chapter /
 *      常规 style_check 会把这些"高频且必须快"的路径拖垮。
 *   ② **绝对余弦阈值没有区分度**：同一章相邻块余弦中位数 0.715、隔 20 块也有 0.632，只差 0.08；
 *      所以改判**章内稳健 z 分数**（相对本章自己的中位数/MAD），再叠加"词汇零新颖度"，两个条件同时成立才报。
 *   ③ **不用 128 维检索缓存**：`EMBED_DIM = 128` 是"每 4 维取 1"的有损降采样（源码注释原话
 *      「无信息量保持保证」），拿来判相似度只会更糊。这里一律用 `embed()` 的 512 维原向量，并按
 *      文本哈希做内存 LRU。
 *
 * v7.0.0 两个算法级修正（实测出来的真 bug，不是调参；对应 test/vector-audit-test.mjs ①~⑤、⑩、⑫）：
 *   · **novelty 参照系写反**：旧版拿"重复窗口"的二字组去比 **窗口之前的全文**，于是
 *     (a) 章首打转（fromBlock === 0）时参照系是空串，novelty 恒为 1.0 → 开篇原地打转 100% 漏检；
 *     (b) 新场景连写三遍时，这些词前文本来就没出现过，novelty 高达 0.85 → 照样放行。
 *     正确参照系是「重复部分」vs「首段 + 前文」：即"重复的那几块，相对它的起点有没有带来新信息"。
 *   · **总体 z 的自抑制悖论**：设全章 M 个相邻对、其中 k 个高相似对，把它们当"离群点"算总体标准差，
 *     会得到 z_max = sqrt((M - k) / k) ——纯数学结果：M < 10 时 k = 2 的 z_max ≤ 2.0（短章永不触发）；
 *     13 块里连续重复 4~5 段（k = 3/4）时 z_max = 1.73/1.32 < 2.0，**打转越严重反而越不报警**。
 *     故改用中位数 med 与 MAD×1.4826（稳健尺度，不被 k 拉大），并给短章加一条绝对余弦兜底。
 *
 * 本模块不生成任何正文句子，只输出"哪几段/哪条大纲没兑现"的定位与方向。
 */
import { createHash } from "node:crypto";
import * as embedding from "./embedding.js";
import { readAuditVectors, writeAuditVectors } from "./db.js";

/** 检索前缀（bge-zh 官方建议：短查询 → 长段落时加前缀，否则短句相似度不稳） */
export const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";

const DEFAULTS = Object.freeze({
  minChunks: 6,           // 块太少时连中位数/MAD 都不可估，宁可不判
  // --- 打转判定 ---
  robustZThreshold: 1.8,  // 稳健 z 阈值（经验值，可用真实语料标定；与 hotSimFloor 同时成立才算）
  hotSimFloor: 0.82,      // 热点对的绝对余弦下限（稳健 z 达标但绝对不像的不算）
  absThreshold: 0.80,     // robustSigma === 0（≥半数相邻对取值相同）时退回纯绝对余弦判定
  consecutivePairs: 2,    // 连续 2 对相邻块 = 连续 3 块（保留原语义）
  noveltyThreshold: 0.18, // 重复部分相对"首段 + 前文"的新二字组占比下限（经验值，可用真实语料标定）
  shortChapterBlocks: 11, // 短章兜底：< 11 块或 < 2500 字（且 ≤16 块）时小样本 z 波动大，改用绝对余弦兜底
  shortChapterChars: 2500,
  shortSimThreshold: 0.85,// 短章兜底的绝对余弦下限（比 hotSimFloor 更严，抵消"没有 z 把关"）
  // --- 大纲兑现 ---
  keywordHitRatio: 0.4,   // 字面兑现：子句二字组的命中比例下限
  keywordMinHits: 2,      // 字面兑现：至少命中这么多个二字组（防一个字/专名独大）
  simThreshold: 0.42,     // 大纲兑现的向量下限（与关键词命中取 OR）
  maxClauses: 6,
  cacheLimit: 400
});

// ---------- 内存 LRU（块文本 → 向量；按自定义 embedFn 与 model/dim 隔离）----------
const vecCache = new Map();
let customVecCaches = new WeakMap();

function defaultModelId() {
  if (typeof embedding.MODEL_ID === "string" && embedding.MODEL_ID !== "") return embedding.MODEL_ID;
  if (typeof embedding.MODEL_NAME === "string" && embedding.MODEL_NAME !== "") return embedding.MODEL_NAME;
  return "bge-small-zh-v1.5";
}

function getCacheStore(embedFn) {
  if (typeof embedFn === "function" && embedFn !== embedding.embed) {
    let store = customVecCaches.get(embedFn);
    if (!store) {
      store = new Map();
      customVecCaches.set(embedFn, store);
    }
    return store;
  }
  return vecCache;
}

function textCacheKey(text) {
  return createHash("sha1").update(String(text)).digest("hex").slice(0, 20);
}

// v8.2.0（#59）：内存 LRU 键绑定 scope.model 与 scope.dim，避免换模型/换维度命中错维缓存向量
function cacheKey(text, scope, prehashed) {
  const hash = prehashed || textCacheKey(text);
  const model = typeof scope?.model === "string" && scope.model !== "" ? scope.model : defaultModelId();
  const dim = Number.isInteger(scope?.dim) && scope.dim > 0 ? String(scope.dim) : "any";
  return `${model}:${dim}:${hash}`;
}

function cacheGet(store, key, expectedDim) {
  if (!store.has(key)) return null;
  const v = store.get(key);
  if (Number.isInteger(expectedDim) && expectedDim > 0 && v.length !== expectedDim) {
    store.delete(key);
    return null;
  }
  store.delete(key); // 触碰即刷新到队尾
  store.set(key, v);
  return v;
}

function cacheSet(store, key, vec) {
  if (store.has(key)) store.delete(key);
  if (store.size >= DEFAULTS.cacheLimit) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  store.set(key, vec);
}
/**
 * v7.3.1 修（#34）：**测试钩子，生产代码不调用**。
 *
 * 语义：清空「块文本 → 向量」的进程内 LRU。只有 `test/vector-audit-test.mjs` 在用例之间调它
 * （否则上一个用例的缓存向量会被下一个用例命中，隔离不成立）。生产路径没有任何调用点，
 * 也不该有：缓存本来就是要跨调用复用的，生产侧清空它只会白跑一遍 embedding。
 * 保留而不是删掉的原因：删了测试就得改成"每次拼一个唯一前缀"来绕缓存，
 * 那反而让测试测的东西离真实输入更远。
 */
export function __clearVectorCache() {
  vecCache.clear();
  customVecCaches = new WeakMap();
}

function isVector(v) {
  return (Array.isArray(v) || v instanceof Float32Array) && v.length > 0;
}

function resolveAuditCacheScope(opts, embedFn) {
  const root = typeof opts?.root === "string" && opts.root.trim() !== "" ? opts.root : "";
  const effectiveEmbed = typeof embedFn === "function" ? embedFn : opts?.embed;
  const hasCustomEmbed = typeof effectiveEmbed === "function" && effectiveEmbed !== embedding.embed;
  const model = typeof opts?.model === "string" && opts.model !== ""
    ? opts.model
    : defaultModelId();
  const dim = Number.isInteger(opts?.dim) && opts.dim > 0
    ? opts.dim
    : (hasCustomEmbed ? null : 512);
  const readOnly = opts?.readOnly === true;
  return { root, model, dim, readOnly };
}

async function embedCached(text, embedFn, opts = {}) {
  const scope = resolveAuditCacheScope(opts, embedFn);
  const store = getCacheStore(embedFn);
  const dbKey = textCacheKey(text);
  const memKey = cacheKey(text, scope, dbKey);
  const hit = cacheGet(store, memKey, scope.dim);
  if (hit) return hit;

  if (scope.root) {
    try {
      const dbHits = readAuditVectors(scope.root, [dbKey], scope.model, scope.dim, { readOnly: scope.readOnly });
      const dbVec = dbHits.get(dbKey);
      if (isVector(dbVec) && (!scope.dim || dbVec.length === scope.dim)) {
        cacheSet(store, memKey, dbVec);
        return dbVec;
      }
    } catch { /* SQLite 读取失败时继续现场推理 */ }
  }

  const vec = await embedFn(text);
  if (!isVector(vec)) return null;
  cacheSet(store, memKey, vec);
  if (scope.root && !scope.readOnly) {
    try {
      writeAuditVectors(scope.root, [{ vec_key: dbKey, model: scope.model, dim: vec.length, vec }]);
    } catch { /* 持久化失败不影响本次审计 */ }
  }
  return vec;
}

async function embedBatchCached(texts, embedFn, opts = {}) {
  const scope = resolveAuditCacheScope(opts, embedFn);
  const store = getCacheStore(embedFn);
  const entries = texts.map((text) => {
    const dbKey = textCacheKey(text);
    return { text, dbKey, memKey: cacheKey(text, scope, dbKey) };
  });
  const resolvedByKey = new Map();
  const missingDbKeys = [];
  const missingDbKeySet = new Set();
  const dbKeyToMemKey = new Map();

  for (const entry of entries) {
    if (resolvedByKey.has(entry.memKey)) continue;
    const hit = cacheGet(store, entry.memKey, scope.dim);
    if (hit) {
      resolvedByKey.set(entry.memKey, hit);
    } else if (!missingDbKeySet.has(entry.dbKey)) {
      missingDbKeySet.add(entry.dbKey);
      missingDbKeys.push(entry.dbKey);
      dbKeyToMemKey.set(entry.dbKey, entry.memKey);
    }
  }

  if (missingDbKeys.length > 0 && scope.root) {
    try {
      const dbHits = readAuditVectors(scope.root, missingDbKeys, scope.model, scope.dim, { readOnly: scope.readOnly });
      for (const [dbKey, vec] of dbHits) {
        const memKey = dbKeyToMemKey.get(dbKey);
        if (memKey && isVector(vec) && (!scope.dim || vec.length === scope.dim)) {
          cacheSet(store, memKey, vec);
          resolvedByKey.set(memKey, vec);
        }
      }
    } catch { /* SQLite 读取失败时继续现场推理 */ }
  }

  const toWrite = [];
  try {
    for (const entry of entries) {
      if (resolvedByKey.has(entry.memKey)) continue;
      let vec = null;
      try {
        vec = await embedFn(entry.text);
      } catch {
        vec = null;
      }
      if (!isVector(vec)) return null;
      cacheSet(store, entry.memKey, vec);
      resolvedByKey.set(entry.memKey, vec);
      toWrite.push({ vec_key: entry.dbKey, model: scope.model, dim: vec.length, vec });
    }
  } finally {
    if (toWrite.length > 0 && scope.root && !scope.readOnly) {
      try {
        writeAuditVectors(scope.root, toWrite);
      } catch { /* 持久化失败不影响本次审计 */ }
    }
  }

  return entries.map((entry) => resolvedByKey.get(entry.memKey));
}

// ---------- 纯工具 ----------
function normalizeText(t) {
  return String(t ?? "").replace(/\r\n?/g, "\n").replace(/[\u2028\u2029\u0085]/g, "\n");
}
/**
 * 切块前剥掉 Markdown 标题行（`## 第 3 章 雨夜`）。标题行会自成一块：既在块序列里插进一个
 * "零正文"块把相邻余弦基线拉低，又会被大纲兑现当成一个可能的落点。
 * 注意：只在喂给 chunkText 的那份文本上剥——块文本仍要在**未剥离**的 norm 里 indexOf 定位行号，
 * 否则剥掉行会让 lineFrom/lineTo 与原文错位（改稿台按行号定位）。
 */
const HEADING_LINE = /^#{1,6}[ \t]+[^\n]*\n?/gm;
function stripHeadingLines(text) {
  return String(text ?? "").replace(HEADING_LINE, "");
}
function lineOfIndex(text, idx) {
  let n = 1;
  const stop = Math.min(Math.max(0, idx), text.length);
  for (let i = 0; i < stop; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}
function mean(arr) {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}
function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
/** MAD（中位数绝对偏差）→ 稳健标准差估计；MAD_SCALE 让它在正态下与 σ 同尺度 */
const MAD_SCALE = 1.4826;
function robustSigma(arr, med) {
  if (arr.length === 0) return 0;
  return median(arr.map((x) => Math.abs(x - med))) * MAD_SCALE;
}
/** 中文二字组集合（去掉标点与空白）——"有没有新信息"的零依赖代理 */
function bigrams(s) {
  const out = new Set();
  const t = String(s ?? "").replace(/[^\u4e00-\u9fff]/g, "");
  for (let i = 0; i + 1 < t.length; i += 1) out.add(t.slice(i, i + 2));
  return out;
}
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** 语义块 → 原文行号（chunkText 会剥离 # 标题行并去掉单换行拼接，按去换行字符映射表回溯原始偏移与 1-based 行号） */
function locateBlocks(norm, blocks) {
  const src = String(norm ?? "");
  const compactChars = [];
  const origIndices = [];
  const origLines = [];
  let lineNo = 1;
  let lineStart = 0;
  while (lineStart <= src.length) {
    const nl = src.indexOf("\n", lineStart);
    const lineEnd = nl >= 0 ? nl : src.length;
    const line = src.slice(lineStart, lineEnd);
    if (!/^#{1,6}[ \t]+/.test(line)) {
      for (let i = lineStart; i < lineEnd; i += 1) {
        compactChars.push(src[i]);
        origIndices.push(i);
        origLines.push(lineNo);
      }
    }
    if (nl < 0) break;
    lineStart = nl + 1;
    lineNo += 1;
  }
  const compact = compactChars.join("");
  let compactCursor = 0;
  for (const b of blocks) {
    const text = String(b.text ?? "");
    const at = text === "" ? -1 : compact.indexOf(text, compactCursor);
    if (at >= 0) {
      b.index = origIndices[at];
      b.lineFrom = origLines[at];
      b.lineTo = origLines[at + text.length - 1];
      // v7.0.0 修正（缺陷 #25）：游标必须按整块长度推进，避免重复语料中后块命中前块内部。
      compactCursor = at + text.length;
    } else {
      const fallbackOrig = compactCursor < origIndices.length ? origIndices[compactCursor] : src.length;
      b.index = fallbackOrig;
      b.lineFrom = lineOfIndex(src, fallbackOrig);
      b.lineTo = lineOfIndex(src, Math.min(src.length, fallbackOrig + text.length));
    }
  }
  return blocks;
}

/**
 * 原地打转检测。
 * @param {string} text 单章正文
 * @param {object} [opts] 测试可注入 embed / isAvailable / 阈值
 * @returns {Promise<{checked:boolean, reason?:string, blocks:number, loops:Array}>}
 */
export async function detectSemanticLoop(text, opts = {}) {
  const safeOpts = opts && typeof opts === "object" ? opts : {};
  const cfg = { ...DEFAULTS, ...safeOpts };
  const embedFn = typeof safeOpts.embed === "function" ? safeOpts.embed : embedding.embed;
  const available = typeof safeOpts.isAvailable === "function" ? await safeOpts.isAvailable() : await embedding.isAvailable();
  if (!available) return { checked: false, reason: "语义引擎不可用（模型缺失或 WASM 初始化失败）", blocks: 0, loops: [] };
  const norm = normalizeText(text);
  const nn = norm.replace(/\s+/g, "").length;
  if (nn < 200) return { checked: false, reason: "正文过短（< 200 字），块太少无法估计分布", blocks: 0, loops: [] };
  const blocks = locateBlocks(norm, embedding.chunkText(stripHeadingLines(norm), { chapter: "" }));
  if (blocks.length < cfg.minChunks) {
    return { checked: false, reason: "语义块仅 " + blocks.length + " 块（少于 " + cfg.minChunks + " 块），分布不可估计", blocks: blocks.length, loops: [] };
  }
  // 向量化（失败/降级：缺一块就整体不做，避免用半套向量下结论）
  const vecs = await embedBatchCached(blocks.map((b) => b.text), embedFn, safeOpts);
  if (!vecs) return { checked: false, reason: "嵌入失败（本机推理异常），本次跳过向量审计", blocks: blocks.length, loops: [] };
  const sims = [];
  for (let i = 0; i + 1 < vecs.length; i += 1) sims.push(embedding.cosine(vecs[i], vecs[i + 1]));
  // v7.0.0 修正（算法级）：**不再用均值/总体标准差**。
  // 设全章 M 个相邻对、其中 k 个高相似对，把 k 个当离群点算总体 σ，可得 z_max = sqrt((M-k)/k)：
  //   M = 8, k = 2 → 1.73；M = 11, k = 4 → 1.32；M = 13, k = 4 → 1.50。
  // 也就是说"越像越不报""短章永不报"——这正是旧版漏检的根因。中位数与 MAD 不受 k 拉大（稳健尺度）。
  const med = median(sims);
  const sigma = robustSigma(sims, med);
  const shortChapter = blocks.length < cfg.shortChapterBlocks || (nn < cfg.shortChapterChars && blocks.length <= 16);
  const hot = sims.map((s) => {
    const z = sigma > 0 ? (s - med) / sigma : 0;
    // 正态章：稳健 z + 绝对余弦双条件
    const byRobust = sigma > 0
      ? (z >= cfg.robustZThreshold && s >= cfg.hotSimFloor)
      : (s >= cfg.absThreshold); // 退化（≥半数相邻对取值相同）：z 无意义，退回纯绝对值
    // 短章兜底：块少时 z 的样本太小，用更严的绝对余弦顶上（仍要过 novelty 检查）
    const byShort = shortChapter && s >= cfg.shortSimThreshold;
    const why = byRobust ? (sigma > 0 ? "robustZ" : "absolute") : "shortChapter";
    return { sim: s, z, pass: byRobust || byShort, why };
  });
  const loops = [];
  let i = 0;
  while (i < hot.length) {
    if (!hot[i].pass) { i += 1; continue; }
    let j = i;
    while (j + 1 < hot.length && hot[j + 1].pass) j += 1;
    const pairCount = j - i + 1;
    if (pairCount >= cfg.consecutivePairs) {
      const fromBlock = i;
      const toBlock = j + 1;
      // v7.0.0 修正（算法级）：参照系 =「首段 + 前文」，不是「窗口之前的全文」。
      // 判的是"重复的这几块，相对它的起点有没有带来新信息"：
      //   · fromBlock === 0 时 head 就是首块本身（旧版这里是空串 → novelty 恒 1.0 → 章首打转全漏）；
      //   · 新场景连写三遍时 head 含第一遍（旧版拿窗口之前的全文比，前文没这些词 → novelty 虚高放行）。
      const head = blocks.slice(0, fromBlock + 1).map((b) => b.text).join("");
      const repeatTail = blocks.slice(fromBlock + 1, toBlock + 1).map((b) => b.text).join("");
      const seen = bigrams(head);
      const win = bigrams(repeatTail);
      const novelty = win.size === 0 ? 1 : [...win].filter((g) => !seen.has(g)).length / win.size;
      if (novelty < cfg.noveltyThreshold) {
        const run = hot.slice(i, j + 1);
        const whys = [...new Set(run.map((x) => x.why))];
        const mode = whys.includes("robustZ") ? "robustZ" : whys.includes("shortChapter") ? "shortChapter" : "absolute";
        loops.push({
          fromBlock,
          toBlock,
          lineFrom: blocks[fromBlock].lineFrom,
          lineTo: blocks[toBlock].lineTo,
          sim: round2(mean(run.map((x) => x.sim))),
          z: round2(Math.max(...run.map((x) => x.z))),
          novelty: round2(novelty),
          mode,
          excerpt: blocks[fromBlock].text.slice(0, 40)
        });
      }
    }
    i = j + 1;
  }
  return {
    checked: true,
    blocks: blocks.length,
    loops
  };
}

// ---------- 大纲兑现 ----------
const CLAUSE_SPLIT = /[，,；;。、→>]+/;
const STOP_BIGRAM = new Set(["他们", "我们", "你们", "自己", "这个", "那个", "什么", "怎么", "因为", "所以", "但是", "然后", "起来", "下来", "出来"]);

// v7.3.3 修（#20）：真正支持 `opts.maxClauses`——旧实现 `splitClauses(direction)` 直接读 DEFAULTS，
// 于是调用方传 2 / 10 都恒得 6 条（`cfg.maxClauses` 只在别处用到，选项名存实亡）。
// 选择「支持」而不是「删掉选项」：它是 checkOutlineFulfillment 的公开 opts（JSDoc 写明「测试可注入」），
// 且「一条方向行最多核几段」是真实的成本旋钮（每多一条子句多一次查询嵌入）；删掉等于把一个
// 能用的成本开关变成静默无效果的假开关。非法值（非正整数）仍回退 DEFAULTS.maxClauses。
function splitClauses(direction, maxClauses) {
  const limit = Number.isInteger(maxClauses) && maxClauses > 0 ? maxClauses : DEFAULTS.maxClauses;
  return String(direction ?? "").split(CLAUSE_SPLIT).map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, limit);
}

/**
 * 大纲兑现核对：**关键词命中 || 向量相似 ≥ 阈值**（任一命中即算兑现，防误报）。
 *
 * v7.0.0 修正（缺陷 #7，P0）：查询向量推理失败时**不再**把它当成"最高相似度 0"去判漏写。
 * 旧实现 `catch { queryVec = null }` 之后 `best = 0` → 直接 `unfulfilled.push`，于是一次 WASM 瞬时异常
 * 就会让作者看到"大纲节点漏写"这条最重的假警报（最坏情况下整条大纲都显示漏写）。
 * 现在的三态口径：
 *   · 字面命中 / 向量达标 → 已兑现（不产出）；
 *   · 向量达标失败但查得到向量 → 漏写（unfulfilled，原语义不变）；
 *   · **查询向量拿不到** → 进 skipped（"未判定"），既不进 unfulfilled，也不冒充已兑现；
 * 若全部子句都因推理异常而无法判定，整体 `checked:false` 并给出 reason（没检查 ≠ 没问题）。
 *
 * @param {string} direction 本章大纲方向行
 * @param {string} text 单章正文
 * @param {object} [opts] 测试可注入 embed / isAvailable / simThreshold
 * @returns {Promise<{checked:boolean, reason?:string, clauses:number, unfulfilled:Array,
 *            skipped:Array<{clause:string, reason:string}>}>}
 */
export async function checkOutlineFulfillment(direction, text, opts = {}) {
  const safeOpts = opts && typeof opts === "object" ? opts : {};
  const cfg = { ...DEFAULTS, ...safeOpts };
  const clauses = splitClauses(direction, cfg.maxClauses);
  if (clauses.length === 0) return { checked: false, reason: "大纲方向行为空或过短，无可核对的子句", clauses: 0, unfulfilled: [], skipped: [] };
  const norm = normalizeText(text);
  if (norm.replace(/\s+/g, "").length < 200) return { checked: false, reason: "正文过短（< 200 字），不做大纲兑现核对", clauses: clauses.length, unfulfilled: [], skipped: [] };
  const embedFn = typeof safeOpts.embed === "function" ? safeOpts.embed : embedding.embed;
  const available = typeof safeOpts.isAvailable === "function" ? await safeOpts.isAvailable() : await embedding.isAvailable();
  if (!available) return { checked: false, reason: "语义引擎不可用（模型缺失或 WASM 初始化失败）", clauses: clauses.length, unfulfilled: [], skipped: [] };
  const body = stripHeadingLines(norm);
  const blocks = locateBlocks(norm, embedding.chunkText(body, { chapter: "" }));
  if (blocks.length === 0) return { checked: false, reason: "无法切出语义块", clauses: clauses.length, unfulfilled: [], skipped: [] };
  const vecs = await embedBatchCached(blocks.map((b) => b.text), embedFn, safeOpts);
  if (!vecs) return { checked: false, reason: "嵌入失败（本机推理异常），本次跳过大纲兑现核对", clauses: clauses.length, unfulfilled: [], skipped: [] };
  const bodyNoPunct = body.replace(/[^\u4e00-\u9fff]/g, "");
  const unfulfilled = [];
  // v7.0.0（#7）：查询向量推理失败的子句 → "未判定"列表（不是漏写，也不是已兑现）。
  const skipped = [];
  let judged = 0;
  for (const clause of clauses) {
    // v7.0.0 修正（算法级）：原来是 `grams.some(...)` —— **一词短路**：子句里任意 1 个二字组
    // （最典型的就是主角名「林风」）在正文出现，整条大纲就判"已兑现"。实测大纲
    // 「林风登上城楼点燃烽火号令三军」只要正文提过一次主角名就会被放过。
    // 改为**按比例**：命中数 ≥ max(keywordMinHits, ceil(grams.length × keywordHitRatio)) 才算字面兑现。
    // 这是权衡：不做"人名识别"（从子句里剔专名没有可靠依据，误杀专名的代价比漏报更大），
    // 而是整体抬高字面门槛——宁可多报漏写（人工一眼可排除），也不要因为一个主角名放过整条大纲。
    // 已知边界：二字组 ≤ 1 个的极短子句永远达不到 2 个命中，一律交给下面的向量分支判定。
    const grams = [...bigrams(clause)].filter((g) => !STOP_BIGRAM.has(g));
    const need = Math.max(cfg.keywordMinHits, Math.ceil(grams.length * cfg.keywordHitRatio));
    const matched = grams.filter((g) => bodyNoPunct.includes(g)).length;
    const keywordHit = grams.length > 0 && matched >= need;
    if (keywordHit) { judged += 1; continue; }
    let queryVec = null;
    let embedError = "";
    try {
      queryVec = await embedCached(QUERY_PREFIX + clause, embedFn, safeOpts);
    } catch (e) {
      queryVec = null;
      embedError = String(e?.message ?? e).slice(0, 80);
    }
    if (!queryVec) {
      // #7：拿不到查询向量 = 这条**没判定**。绝不落进 unfulfilled（那是"我们查过、正文里没有"的断言）。
      skipped.push({
        clause,
        reason: "该子句的查询向量推理失败" + (embedError ? "（" + embedError + "）" : "") + "，本次未做判定（不计入大纲漏写）"
      });
      continue;
    }
    let best = 0;
    for (const v of vecs) best = Math.max(best, embedding.cosine(queryVec, v));
    judged += 1;
    if (best >= cfg.simThreshold) continue;
    unfulfilled.push({ clause, bestSim: round2(best), keywordHit: false });
  }
  if (judged === 0) {
    // 每一条都失败：整体不可判定（调用方据此 skipScope，而不是把旧清单判成 resolved）。
    return {
      checked: false,
      reason: "全部 " + clauses.length + " 条大纲子句的查询向量推理失败（本机推理异常），本次不做大纲兑现判定",
      clauses: clauses.length,
      unfulfilled: [],
      skipped
    };
  }
  return { checked: true, clauses: clauses.length, unfulfilled, skipped };
}