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

// ---------- 内存 LRU（块文本 → 512 维向量）----------
const vecCache = new Map();
function cacheKey(text) {
  return createHash("sha1").update(String(text)).digest("hex").slice(0, 20);
}
function cacheGet(key) {
  if (!vecCache.has(key)) return null;
  const v = vecCache.get(key);
  vecCache.delete(key); // 触碰即刷新到队尾
  vecCache.set(key, v);
  return v;
}
function cacheSet(key, vec) {
  if (vecCache.size >= DEFAULTS.cacheLimit) {
    const oldest = vecCache.keys().next();
    if (!oldest.done) vecCache.delete(oldest.value);
  }
  vecCache.set(key, vec);
}
/** 仅供测试：清空缓存 */
export function __clearVectorCache() {
  vecCache.clear();
}

async function embedCached(text, embedFn) {
  const key = cacheKey(text);
  const hit = cacheGet(key);
  if (hit) return hit;
  const vec = await embedFn(text);
  if (Array.isArray(vec) && vec.length > 0) cacheSet(key, vec);
  return Array.isArray(vec) && vec.length > 0 ? vec : null;
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

/** 语义块 → 原文行号（块是原文子串；按顺序推进游标，避免重复段落都指向第一处） */
function locateBlocks(norm, blocks) {
  let cursor = 0;
  for (const b of blocks) {
    const probe = String(b.text ?? "").slice(0, 40) || String(b.text ?? "");
    const at = probe === "" ? -1 : norm.indexOf(probe, cursor);
    if (at >= 0) {
      b.index = at;
      cursor = at + probe.length;
    } else {
      b.index = cursor;
    }
    b.lineFrom = lineOfIndex(norm, b.index);
    b.lineTo = lineOfIndex(norm, b.index + String(b.text ?? "").length);
  }
  return blocks;
}

/**
 * 原地打转检测。
 * @param {string} text 单章正文
 * @param {object} [opts] 测试可注入 embed / isAvailable / 阈值
 * @returns {Promise<{checked:boolean, reason?:string, blocks:number, loops:Array, degraded?:string}>}
 */
export async function detectSemanticLoop(text, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const embedFn = typeof opts.embed === "function" ? opts.embed : embedding.embed;
  const available = typeof opts.isAvailable === "function" ? await opts.isAvailable() : await embedding.isAvailable();
  if (!available) return { checked: false, reason: "语义引擎不可用（模型缺失或 WASM 初始化失败）", blocks: 0, loops: [] };
  const norm = normalizeText(text);
  const nn = norm.replace(/\s+/g, "").length;
  if (nn < 200) return { checked: false, reason: "正文过短（< 200 字），块太少无法估计分布", blocks: 0, loops: [] };
  const blocks = locateBlocks(norm, embedding.chunkText(stripHeadingLines(norm), { chapter: "" }));
  if (blocks.length < cfg.minChunks) {
    return { checked: false, reason: "语义块仅 " + blocks.length + " 块（少于 " + cfg.minChunks + " 块），分布不可估计", blocks: blocks.length, loops: [] };
  }
  // 向量化（失败/降级：缺一块就整体不做，避免用半套向量下结论）
  const vecs = [];
  for (const b of blocks) {
    let v = null;
    try {
      v = await embedCached(b.text, embedFn);
    } catch {
      v = null;
    }
    if (!v) return { checked: false, reason: "嵌入失败（本机推理异常），本次跳过向量审计", blocks: blocks.length, loops: [] };
    vecs.push(v);
  }
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
    loops,
    ...(loops.length === 0 ? {} : { degraded: "" })
  };
}

// ---------- 大纲兑现 ----------
const CLAUSE_SPLIT = /[，,；;。、→>]+/;
const STOP_BIGRAM = new Set(["他们", "我们", "你们", "自己", "这个", "那个", "什么", "怎么", "因为", "所以", "但是", "然后", "起来", "下来", "出来"]);

function splitClauses(direction) {
  return String(direction ?? "").split(CLAUSE_SPLIT).map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, DEFAULTS.maxClauses);
}

/**
 * 大纲兑现核对：**关键词命中 || 向量相似 ≥ 阈值**（任一命中即算兑现，防误报）。
 * @param {string} direction 本章大纲方向行
 * @param {string} text 单章正文
 * @param {object} [opts] 测试可注入 embed / isAvailable / simThreshold
 * @returns {Promise<{checked:boolean, reason?:string, clauses:number, unfulfilled:Array}>}
 */
export async function checkOutlineFulfillment(direction, text, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const clauses = splitClauses(direction);
  if (clauses.length === 0) return { checked: false, reason: "大纲方向行为空或过短，无可核对的子句", clauses: 0, unfulfilled: [] };
  const norm = normalizeText(text);
  if (norm.replace(/\s+/g, "").length < 200) return { checked: false, reason: "正文过短（< 200 字），不做大纲兑现核对", clauses: clauses.length, unfulfilled: [] };
  const embedFn = typeof opts.embed === "function" ? opts.embed : embedding.embed;
  const available = typeof opts.isAvailable === "function" ? await opts.isAvailable() : await embedding.isAvailable();
  if (!available) return { checked: false, reason: "语义引擎不可用（模型缺失或 WASM 初始化失败）", clauses: clauses.length, unfulfilled: [] };
  const blocks = locateBlocks(norm, embedding.chunkText(stripHeadingLines(norm), { chapter: "" }));
  if (blocks.length === 0) return { checked: false, reason: "无法切出语义块", clauses: clauses.length, unfulfilled: [] };
  const vecs = [];
  for (const b of blocks) {
    let v = null;
    try {
      v = await embedCached(b.text, embedFn);
    } catch {
      v = null;
    }
    if (!v) return { checked: false, reason: "嵌入失败（本机推理异常），本次跳过大纲兑现核对", clauses: clauses.length, unfulfilled: [] };
    vecs.push(v);
  }
  const bodyNoPunct = norm.replace(/[^\u4e00-\u9fff]/g, "");
  const unfulfilled = [];
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
    if (keywordHit) continue;
    let queryVec = null;
    try {
      queryVec = await embedCached(QUERY_PREFIX + clause, embedFn);
    } catch {
      queryVec = null;
    }
    let best = 0;
    if (queryVec) for (const v of vecs) best = Math.max(best, embedding.cosine(queryVec, v));
    if (best >= cfg.simThreshold) continue;
    unfulfilled.push({ clause, bestSim: round2(best), keywordHit: false });
  }
  return { checked: true, clauses: clauses.length, unfulfilled };
}