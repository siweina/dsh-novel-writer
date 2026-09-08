/**
 * v2.0.0 本地语义嵌入引擎（embedding.js）——WASM 直连版（终极安全方案）
 * - 使用 onnxruntime-web（WASM 后端）在宿主进程内推理：内存安全，不可能 segfault/杀进程；
 * - 无子进程、无原生 .node 绑定（避免宿主 ABI 冲突）；
 * - 懒加载 + 自动降级：模型加载失败自动回退纯规则。
 */
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// v2.6.0 审查修复：zstd 条件获取，不可用时索引缓存回退纯 JSON（插件照常加载，不崩）
// v3.9.1 注释修正：Node 实际在 v23.8.0 才引入 zlib 的 zstd（并非 22.3）；22.3–23.7 及更旧版本自动回退纯 JSON 是安全设计
let zstdCompressSync = null;
let zstdDecompressSync = null;
try {
  const zlib = require("node:zlib");
  if (typeof zlib.zstdCompressSync === "function") {
    zstdCompressSync = zlib.zstdCompressSync;
    zstdDecompressSync = zlib.zstdDecompressSync;
  }
} catch { /* 旧 Node：回退纯 JSON 缓存 */ }
const MODEL_DIR = path.join(__dirname, "models");
const MODEL_NAME = "bge-small-zh-v1.5"; // v3.5.0 #55：索引缓存模型标识（换模型旧缓存作废）
const EMBED_DIM = 128; // v3.5.0 #55：缓存向量维度（降采样后）；v3.9.1：512→128 是每 4 取 1 的有损降采样，无信息量保持保证——只作维度压缩/缓存瘦身，别当作无损语义保持
const EMBEDDING_CACHE_ROOT = ".novel-writer";

let enginePromise = null;
let engine = { available: false, error: null, tokenizer: null, session: null, ort: null, failedAt: null };
// v4.0.0：缓存链路最近一次失败原因（status() 输出，用于诊断"每次都提示重建 / 索引写不进盘"）
let lastCacheError = null;
// v4.0.0：失败冷却时长（原为 isAvailable 内联字面量 30*1000，现下沉到 initEngine 供所有入口共享）
const ENGINE_RETRY_COOLDOWN_MS = 30 * 1000;

/** 模型文件是否随包存在（纯文件探测）。 */
function modelPresent() {
  // v2.0.0 瘦身版：quantized 优先（fp32 已移除）
  // v4.0.0 修正：initEngine 硬依赖 tokenizer_config.json（读取处无 try 包裹），旧版不探测它——
  // 缺该文件时 status().modelPresent 仍为 true、isAvailable 走完整加载才失败，用户按报错提示查模型文件查不出真因
  return (
    (fs.existsSync(path.join(MODEL_DIR, "onnx", "model_quantized.onnx")) || fs.existsSync(path.join(MODEL_DIR, "onnx", "model.onnx"))) &&
    fs.existsSync(path.join(MODEL_DIR, "tokenizer.json")) &&
    fs.existsSync(path.join(MODEL_DIR, "tokenizer_config.json"))
  );
}

/** 懒加载模型（单例，WASM 推理）。 */
function initEngine() {
  // v4.0.0 修正：冷却判断下沉到 initEngine——embed/embedMany/search/detectImplicitEmotions 都只走这里，
  // 旧版唯一解锁点在 isAvailable()，直接调 embed 的入口（resolveAmbiguousCarriers / detectChapterBridge 等）首次失败后永不恢复
  if (enginePromise && engine.failedAt && Date.now() - engine.failedAt > ENGINE_RETRY_COOLDOWN_MS) {
    enginePromise = null;
    engine.failedAt = null;
  }
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    try {
      const [tokMod, ort] = await Promise.all([
        import("@huggingface/tokenizers"),
        import("onnxruntime-web")
      ]);
      // v2.0.0 修复：wasm 目录用 require.resolve 动态定位（npm 安装时 onnxruntime-web 可能被 hoist 到顶层 node_modules）
      const ortMain = require.resolve("onnxruntime-web", { paths: [__dirname] });
      const dist = path.dirname(ortMain);
      // v4.0.0 修正：旧版把它同时存进 engine.wasmPaths（全项目只写不读），去掉该字段，直接用局部值
      ort.env.wasm.wasmPaths = pathToFileURL(dist + path.sep).href;
      ort.env.wasm.numThreads = 1;
      // v2.0.0 瘦身版：官方轻量 @huggingface/tokenizers（WASM，294KB，零依赖）替代 transformers.js
      const tj = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, "tokenizer.json"), "utf8"));
      const tc = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, "tokenizer_config.json"), "utf8"));
      const tokenizer = new tokMod.Tokenizer(tj, tc);
      const modelFile = fs.existsSync(path.join(MODEL_DIR, "onnx", "model_quantized.onnx")) ? "model_quantized.onnx" : "model.onnx";
      const session = await ort.InferenceSession.create(path.join(MODEL_DIR, "onnx", modelFile), { executionProviders: ["wasm"] });
      engine.tokenizer = tokenizer;
      engine.session = session;
      engine.ort = ort;
      engine.available = true;
      engine.error = null;
      engine.failedAt = null;
    } catch (e) {
      engine.available = false;
      engine.error = String(e).slice(0, 300);
      // v3.9.1：失败粘性修复——记录失败时刻，isAvailable() 冷却 30s 后自动重试
      engine.failedAt = Date.now();
    }
    return engine;
  })();
  return enginePromise;
}

/** 状态探测（不触发加载）。 */
function status() {
  // v4.0.0：附带 lastCacheError（索引读写最近一次失败原因，无失败为 null）；既有字段不变
  return { modelPresent: modelPresent(), loaded: engine.available, error: engine.error, lastCacheError };
}

/** 可用性（懒加载后返回；失败不抛）。失败不是永久态：冷却 30s 后允许一次重载尝试。 */
async function isAvailable() {
  if (!modelPresent()) return false;
  // v4.0.0 修正：冷却/重试逻辑已下沉到 initEngine（所有入口共享），此处只保留 modelPresent 门控
  await initEngine();
  return engine.available;
}

/** 嵌入单段文本 → 512 维归一化向量。 */
async function embed(text) {
  const s = await initEngine();
  if (!s.available) return null;
  // v2.5.0 修复轮 6：空/纯空白输入防护（空输入会产生无意义向量）
  const raw = String(text ?? "");
  if (raw.trim() === "") return null;
  const enc = s.tokenizer.encode(raw.slice(0, 4000));
  // v2.5.0 修复轮 6：token 级截断（bge 上限 512 token）——字符截断下 4000 个中文字符≈2000+ token
  // 远超模型上限会导致 OrtRun() 报错（超长 query 首次必现"语义引擎不可用"）
  const ids = Array.from(enc.ids).slice(0, 512);
  const mask = Array.from(enc.attention_mask).slice(0, 512);
  const ort = s.ort;
  const iids = new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]);
  const attn = new ort.Tensor("int64", BigInt64Array.from(mask, BigInt), [1, mask.length]);
  const tids = new ort.Tensor("int64", BigInt64Array.from(ids.map(() => 0), BigInt), [1, ids.length]);
  const out = await s.session.run({ input_ids: iids, attention_mask: attn, token_type_ids: tids });
  const dim = out.last_hidden_state.dims[2];
  // v4.0.0 修正：旧版 Array.from(整个 [1,seq,512] 张量) 只为取前 dim 个数——最长 512×512 个元素被物化后立刻丢弃 99.8%（单次约 2MB，建索引时是 GB 级临时分配）
  const cls = Array.from(out.last_hidden_state.data.subarray(0, dim));
  let norm = Math.sqrt(cls.reduce((sum, x) => sum + x * x, 0));
  if (!norm || !Number.isFinite(norm)) norm = 1;
  return cls.map((x) => x / norm);
}

/** 批量嵌入（并发 4；失败块整体重试一轮，偶发 WASM 抖动不落永久缺失）。 */
async function embedMany(chunks) {
  const out = new Array(chunks.length);
  const failed = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < chunks.length) {
      const i = cursor; cursor += 1;
      // v3.5.0 #53：单块容错——一块 embed 抛错（WASM 抖动/超长）不拖垮整本书索引
      try {
        const vec = await embed(chunks[i].text);
        if (vec) {
          out[i] = { id: chunks[i].id, text: chunks[i].text, vec };
        } else {
          // v4.0.0 修正：embed 返回 null 属确定性跳过（空/纯空白文本），不再进重试队列白跑一轮推理
          out[i] = null;
        }
      } catch {
        out[i] = null;
        failed.push(i);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  // v3.9.1：第一轮抛错的块，第二轮再 embed 一次；仍失败才保留 null 由 filter 剔除（v4.0.0：仅重试抛错块）
  const retry = failed.slice();
  if (retry.length > 0) {
    let rc = 0;
    const retryWorker = async () => {
      while (rc < retry.length) {
        const i = retry[rc]; rc += 1;
        try {
          const vec = await embed(chunks[i].text);
          out[i] = vec ? { id: chunks[i].id, text: chunks[i].text, vec } : null;
        } catch { out[i] = null; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, retry.length) }, retryWorker));
  }
  return out.filter(Boolean);
}

/** 余弦相似度（长度防御）。 */
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  // v4.0.0 修正：向量含 NaN/Infinity 时 na/nb 也是 NaN（na === 0 为假）→ 旧版返回 NaN 进入 sort 比较器，排序不确定且结果里带 NaN
  if (!Number.isFinite(dot) || !Number.isFinite(na) || !Number.isFinite(nb)) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * v4.0.0：索引向量主维度（众数）——旧版只看 index[0]?.vec?.length，首条维度异常时 qvCache 与其余条目不等长、
 * cosine 恒返回 0 且无任何提示（cosine 要求等长）。维度混排属防御场景，取众数即可正确覆盖绝大多数条目。
 */
function dominantVecDim(index) {
  const counts = new Map();
  for (const item of index || []) {
    const len = item?.vec?.length ?? 0;
    counts.set(len, (counts.get(len) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [len, count] of counts) if (count > bestCount) { best = len; bestCount = count; }
  return best;
}

/**
 * v4.0.0：向量 → 索引 Top-k（search / detectImplicitEmotions 共用）。
 * 只回 {id,chapter,text,score}——旧版 {...item} 会为全部 N 条各浅拷贝一个对象（含 128 维 vec 引用）后才 slice(0,k)；
 * 调用方（index.js 语义检索结果映射、detectImplicitEmotions）均只取这四个字段。
 * v3.9.1：落库索引已统一 128 维；此处保留 512/128 双维防御（cosine 要求等长，否则恒返回 0），query 为 512 维模型直出时与 128 维索引匹配需降采样。
 */
function rankIndex(qv, index, k) {
  if (!qv || !Array.isArray(index) || index.length === 0) return [];
  const dim = dominantVecDim(index);
  const qvCache = dim === qv.length ? qv : downsample(qv);
  return index
    .map((item) => ({ id: item.id, chapter: item.chapter ?? null, text: item.text, score: cosine(qvCache, item.vec) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, k);
}

/** 语义检索（query 维度跟随索引；v3.9.1：落库索引已统一 128 维，仅对内存中可能出现的 512 维索引做防御性兼容）。 */
async function search(query, index, k = 5) {
  const qv = await embed(query);
  if (!qv || !index || index.length === 0) return [];
  return rankIndex(qv, index, k);
}

/**
 * v2.0.0 语义隐性情感：情感原型句（规则词表之外，找"语义相近但无关键词"的段落）。
 * 每个原型是一句典型情感场景，与全书段落向量做余弦，高分段=疑似该情感的隐性表达。
 */
const IMPLICIT_EMOTION_PROTOTYPES = Object.freeze([
  // 乐（正向）
  { emotion: "温暖", text: "炉火的光映在脸上，她缩进柔软的毯子里，心里涌起一阵久违的踏实。" },
  { emotion: "甜蜜", text: "他递过来的那杯茶还冒着热气，她捧着它，嘴角不知不觉弯了起来。" },
  { emotion: "释然", text: "她把那封早就写好的信烧掉，长长地呼出一口气，肩上的重量忽然轻了。" },
  { emotion: "幸福", text: "孩子趴在膝头睡着了，她低头看着，光线正好，一切都安静而圆满。" },
  // 好（正向亲近）
  { emotion: "温柔", text: "他轻轻抚过她的发梢，声音放得很轻很软，怕惊到她。" },
  { emotion: "眷恋", text: "她抚摸着旧物的纹路，仿佛还能触到那只手留下的温度。" },
  { emotion: "仰慕", text: "他说话的时候，她一直安静地听着，眼睛里的光越来越亮。" },
  // 怒（负向）
  { emotion: "压抑的愤怒", text: "他的手指攥得发白，指节咯咯作响，脸上的肌肉却绷得一动不动。" },
  { emotion: "隐忍", text: "她把到嘴边的话又咽了回去，扯出一个笑，假装什么都没发生。" },
  // 哀（负向）
  { emotion: "悲伤", text: "她把相册合上，指尖停在最后一页，很久很久没有动。" },
  { emotion: "孤独", text: "空荡荡的房间里只有她一个人，安静得可怕，没有人会来。" },
  { emotion: "怅惘", text: "窗外雨停了，她盯着空荡的街口，像是还等着谁从那里出现。" },
  { emotion: "失落", text: "名单上没有她的名字，她看了三遍，然后轻轻把纸折好放回口袋。" },
  { emotion: "心碎", text: "那句话落地之后，她所有的话都堵在喉咙里，只剩下点头的力气。" },
  // 惧（负向）
  { emotion: "恐惧", text: "黑暗中有什么东西在逼近，她浑身发冷，心跳到了嗓子眼。" },
  { emotion: "焦虑", text: "她反复摩挲着衣角，坐立不安，每隔几秒就往门口看一眼。" },
  { emotion: "不安", text: "总觉得哪里不对，却又说不上来，后背一阵阵地发凉。" },
  // 恶（负向）
  { emotion: "厌恶", text: "那气味飘过来，她胃里一阵翻涌，别过了脸。" },
  // 惊（中性偏负）
  { emotion: "震惊", text: "她手里的杯子掉在地上，碎片溅开，她却盯着那张纸一动不动。" },
  // 文学隐性情感（情绪词之外的行为意象）
  { emotion: "疏离", text: "他转身离开，背影渐渐消失在走廊尽头，再也没有回头。" },
  { emotion: "决绝", text: "她头也不回地走了，再也没有看他一眼，这一次是真的结束了。" },
  { emotion: "不舍", text: "她站在门口，忍不住回头望了又望，脚却迈不出去。" },
  { emotion: "无奈", text: "她苦笑了一下，摇了摇头，什么也没说，转身默默收拾东西。" },
  { emotion: "脆弱", text: "烛火摇曳，她抱住自己蜷缩在角落，轻声啜泣，怕被人听见。" },
  { emotion: "苦涩", text: "他把酒喝完，杯子放回桌上时，笑声还在，眼里却没有光了。" },
  // v3.5.0 M7b：4 轴独立原型标签（不占现有情感标签）
  { emotion: "甜宠", text: "他把她圈在怀里，低声哄着，她笑着躲了躲，心里甜得发软。" },
  { emotion: "悬疑", text: "走廊尽头的门虚掩着，地板上有一串陌生的脚印，她屏住呼吸凑近。" },
  { emotion: "唯美", text: "暮色把远山染成淡紫，水面浮着细碎的光，她沿着长堤慢慢走，风很轻。" },
  { emotion: "情欲", text: "灯光昏黄，他俯身靠近，指尖轻轻划过她的锁骨，呼吸渐渐滚烫。" }
]);

// v4.0.0：原型句是常量文本，向量进程内缓存一次即可——旧版每次调用都重新嵌入 28 个原型（实测索引仅 2 条时纯原型嵌入开销 521ms），
// 该函数在 semanticImplicit 开启时每次分析/报告都会执行
const prototypeVecCache = new Map();

/** v4.0.0：取原型向量（命中缓存直接返回；embed 失败不缓存，留待下次重试）。 */
async function prototypeVector(text) {
  const key = String(text ?? "");
  if (prototypeVecCache.has(key)) return prototypeVecCache.get(key);
  const vec = await embed(key);
  if (vec) prototypeVecCache.set(key, vec);
  return vec;
}

/**
 * v2.0.0 语义隐性情感检测：用情感原型句扫全书索引，聚合出"词表外疑似意象段落"。
 * @param index 全书语义索引（[{id, chapter, text, vec}]，128 维）
 * @param topPerEmotion 每个情感原型取前 N 段（默认 2）
 * @returns { hits: [{id, chapter, text, top, score}], distribution: {情感: 段数} }
 */
async function detectImplicitEmotions(index, topPerEmotion = 2) {
  if (!index || index.length === 0) return { hits: [], distribution: {} };
  const seen = new Map();
  for (const proto of IMPLICIT_EMOTION_PROTOTYPES) {
    let hits = [];
    try {
      const qv = await prototypeVector(proto.text);
      hits = qv ? rankIndex(qv, index, topPerEmotion) : [];
    } catch { continue; }
    for (const h of hits) {
      if (!seen.has(h.id)) seen.set(h.id, { id: h.id, chapter: h.chapter ?? "全书", text: h.text, scores: {} });
      const entry = seen.get(h.id);
      if (h.score > 0.3) entry.scores[proto.emotion] = h.score;
    }
  }
  const entries = [...seen.values()]
    .map((entry) => {
      const sorted = Object.entries(entry.scores).sort((a, b) => b[1] - a[1]);
      if (sorted.length === 0) return null;
      return { id: entry.id, chapter: entry.chapter, text: entry.text, top: sorted[0][0], score: Math.round(sorted[0][1] * 10000) / 10000 };
    })
    .filter(Boolean);
  // v4.0.0 修正：distribution 改用"阈值过滤后的全部命中"统计——旧版先按分数截前 10 再统计，基数最多 10，
  // 报告里"隐性情绪分布"被当成全书口径，且分数偏高的泛化原型会挤掉低频情感（hits 仍只展示前 10 条）。
  // 键按计数降序插入：index.js 的"隐性情绪：A×3 B×1"展示行按插入顺序读，最频繁的情感排在最前。
  const distCounts = new Map();
  for (const hit of entries) distCounts.set(hit.top, (distCounts.get(hit.top) ?? 0) + 1);
  const distribution = {};
  const distPairs = [...distCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [label, n] of distPairs) distribution[label] = n;
  const hits = entries.sort((a, b) => b.score - a.score).slice(0, 10);
  return { hits, distribution };
}

/** 索引落盘缓存路径（按书）。 */
function cachePath(root, book) {
  const safe = String(book).replace(/[\\/:*?"<>|]/g, "_");
  return path.join(root, EMBEDDING_CACHE_ROOT, "embedding", safe + ".json");
}

/** 内容指纹（sha1，id+text）：章节内容/章节集变化 → 指纹变化 → 索引自动重建（不依赖版本号）。 */
function fingerprint(chunks) {
  const h = createHash("sha1");
  for (const c of chunks || []) {
    h.update(String(c.id));
    h.update("\u0000");
    h.update(String(c.text));
    h.update("\u0001");
  }
  return h.digest("hex");
}

/** 单段文本哈希（增量索引对比用，短 sha1）。 */
function textHash(text) {
  return createHash("sha1").update(String(text)).digest("hex").slice(0, 16);
}

/**
 * v3.9.1 共享降采样：512 维模型直出 → 128 维（每 4 维取 1），随后做一次 L2 归一化。
 * 降采样只压缩维度、不保证保留完整语义信息（有损）；对已是 128 维的旧缓存/复用向量只做归一化，不二次降采样。
 * 注意：不应把 128 维缓存视为损坏——旧缓存 128 维合法。
 */
function downsample(vec) {
  const raw = Array.isArray(vec) ? vec : [];
  let v = raw.length > 128 ? raw.filter((_, i) => i % 4 === 0) : raw;
  // v4.0.0 修正：filter(i%4) 只有 512 维输入才等于 128；其余长度必须显式归一到 EMBED_DIM，
  // 否则落盘 dim 与实际向量长度不符 → 缓存每次被判损坏、每次全量重建（旧版潜伏 bug）
  if (v.length !== EMBED_DIM) {
    if (raw.length === 0) return [];
    v = Array.from({ length: EMBED_DIM }, function (_, i) { return raw[Math.min(raw.length - 1, Math.floor((i * raw.length) / EMBED_DIM))]; });
  }
  let norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  if (!norm || !Number.isFinite(norm)) norm = 1;
  return v.map((x) => x / norm);
}

// v4.0.0：索引文件进程内读缓存（键 = 路径 + mtimeMs + size）——同一轮工具调用会多次 loadIndexMeta（语义检索/风格对比/隐性情感），
// 旧版每次都 readFileSync + zstd 解压整个索引（大书数十 MB）；saveIndex 写盘后显式失效
let indexReadCache = { key: null, data: null };

/** 读取索引缓存文件（v2.6.0：zstd 压缩存储；旧版纯 JSON 自动兼容）。 */
function readIndexData(root, book) {
  const p = cachePath(root, book);
  let st = null;
  // 无缓存属正常路径（首次建索引），不记 lastCacheError
  try { st = fs.statSync(p); } catch { return null; }
  const key = p + "|" + st.mtimeMs + "|" + st.size;
  if (indexReadCache.key === key) return indexReadCache.data;
  try {
    const buf = fs.readFileSync(p);
    let data = null;
    if (zstdDecompressSync) {
      try { data = JSON.parse(zstdDecompressSync(buf).toString("utf8")); } catch { /* 非 zstd 旧格式 → 按纯 JSON 读 */ }
    }
    if (data === null) {
      try { data = JSON.parse(buf.toString("utf8")); } catch (e) { lastCacheError = String(e).slice(0, 200); data = null; }
    }
    indexReadCache = { key, data };
    return data;
  } catch (e) {
    lastCacheError = String(e).slice(0, 200); // v4.0.0：不再完全静默（status().lastCacheError 可读）
    return null;
  }
}

/** 保存索引（v2.6.0：统一 128 维 + 4 位小数降精度 + zstd 压缩，体积约 1/10）。v3.9.1：正文截断上限 200 字（与检索返回一致）。
 * v4.0.0：第四参数 fp 已废弃（调用方多传的实参会被忽略）——内容指纹改为按实际写入条目内部重算，见下方说明。 */
function saveIndex(root, book, index) {
  try {
    const dir = path.dirname(cachePath(root, book));
    fs.mkdirSync(dir, { recursive: true });
    const compact = index.map((item) => {
      const vec = downsample(item.vec);
      return {
        id: item.id,
        t: item.text.slice(0, 200),
        th: item.th ?? textHash(item.text),
        ch: item.chapter ?? null,
        v: vec.map((x) => Math.round(x * 10000) / 10000)
      };
    });
    // v4.0.0 修正：落盘用常量而非字面量（否则改 MODEL_NAME 后新写的缓存当场失效）
    // v4.0.0 修正：残缺索引（部分段 embed 失败被 filter 剔除）不再按"全量内容指纹"落盘——改为用实际写入条目重算指纹：
    // 完整时与调用侧 fingerprint(chunks) 逐字节一致（id/text 与顺序均不变），残缺/空索引时必然不同 →
    // 下次调用 cachedFp !== indexFp 成立、走增量补齐（旧版把残缺索引当完整缓存永久复用，缺失段直到全书内容变化都不会被索引）
    const allHaveText = index.length > 0 && index.every((it) => typeof it?.text === "string");
    const actualFp = allHaveText ? fingerprint(index) : fingerprint([]);
    const json = JSON.stringify({ model: MODEL_NAME, dim: EMBED_DIM, fp: actualFp, items: compact });
    const payload = Buffer.from(json, "utf8");
    fs.writeFileSync(cachePath(root, book), zstdCompressSync ? zstdCompressSync(payload) : payload);
    indexReadCache = { key: null, data: null }; // v4.0.0：写盘后让读缓存失效（下次 loadIndexMeta 重新读盘）
    return true;
  } catch (e) {
    lastCacheError = String(e).slice(0, 200); // v4.0.0：写盘失败不再完全静默（status().lastCacheError 可读）
    return false;
  }
}

/** 读取索引缓存 + 内容指纹（旧格式无 fp 时 fp=null，视为失效需重建；不靠版本号失效）。v3.9.1：逐向量长度校验（任一 vec 维度与 EMBED_DIM 不符即视为缓存损坏；旧 128 维缓存合法，不被误杀）。 */
function loadIndexMeta(root, book) {
  try {
    const data = readIndexData(root, book);
    if (!data) return { items: null, fp: null };
    // v3.5.0 #55：缓存校验 model/dim——换模型/维度变化时旧缓存作废（触发重建），防 cosine 恒 0
    if (data.model !== MODEL_NAME || data.dim !== EMBED_DIM) return { items: null, fp: null };
    if (!Array.isArray(data.items)) return { items: null, fp: null };
    for (const item of data.items) {
      if (!Array.isArray(item?.v) || item.v.length !== EMBED_DIM) return { items: null, fp: null };
    }
    return {
      items: data.items.map((item) => ({ id: item.id, text: item.t, th: item.th ?? null, vec: item.v, chapter: item.ch ?? null })),
      fp: data.fp ?? null
    };
  } catch { return { items: null, fp: null }; }
}

/**
 * v2.6.0 增量构建索引：按段落 id + 文本哈希复用旧向量，只对新/变化的段落做推理。
 * 输出统一 128 维（新向量降采样），与缓存/检索维度一致。
 * @param {Array<{id,text}>} chunks 当前全部段落
 * @param {Array<{id,text,th,vec}>|null} oldItems 旧索引条目（loadIndexMeta 的 items）
 */
async function buildIndexIncremental(chunks, oldItems) {
  const oldById = new Map((oldItems || []).map((it) => [it.id, it]));
  const out = new Array(chunks.length);
  const todo = [];
  for (let i = 0; i < chunks.length; i++) {
    const ch = chunks[i];
    const old = oldById.get(ch.id);
    const th = textHash(ch.text);
    if (old && old.th === th && Array.isArray(old.vec) && old.vec.length > 0) {
      out[i] = { id: ch.id, text: ch.text, th, vec: old.vec, chapter: ch.chapter ?? old.chapter ?? null };
    } else {
      todo.push(i);
    }
  }
  if (todo.length > 0) {
    // v2.6.0 审查修复：embedMany 失败项被 filter 掉会缩短数组——按 id 匹配，杜绝向量错位（张冠李戴）
    const vecs = await embedMany(todo.map((i) => chunks[i]));
    const vecById = new Map(vecs.map((v) => [v.id, v]));
    for (const i of todo) {
      const v = vecById.get(chunks[i].id);
      if (v) {
        out[i] = {
          id: chunks[i].id,
          text: chunks[i].text,
          th: textHash(chunks[i].text),
          vec: downsample(v.vec),
          chapter: chunks[i].chapter ?? null
        };
      }
    }
  }
  return out.filter(Boolean);
}

/**
 * 识别章节标题行（返回标题文本或 null）：
 * - 支持 Markdown 前缀（# ～ ######）与首尾空白；
 * - 支持 第1章/第 1 章/第一章/第1节/第一卷/Chapter 1/序章/序言/楔子/引子/尾声/终章/番外；
 * - 整行 ≤40 字才视为标题（正文长句/对话引用不误判，v2.6.0 审查修复保留）。
 */
function extractChapterTitle(line) {
  const t = String(line).trim();
  if (t.length > 40) return null;
  const stripped = t.replace(/^#{1,6}\s+/, "");
  if (
    /^第[\s　零一二三四五六七八九十百千两０-９\d]{1,8}[\s　]*[章节回卷部]/.test(stripped) ||
    /^Chapter\s+\d+/i.test(stripped) ||
    /^(序章|序言|楔子|引子|尾声|终章|番外)/.test(stripped)
  ) {
    // v3.7.0 ⑪：以句号/问号结尾的正文句（"第二章内容已更新。"）不当标题
    if (/[。！？!?；;，,]$/.test(stripped)) return null;
    return stripped.slice(0, 30);
  }
  return null;
}

/** 全文 → 语义段落（按空行/150 字切块，带章节标记）。 */
function chunkText(text) {
  // v4.0.0 修正：统一剥离 CRLF 的 \r——旧版 \r 进入 chunk 文本并参与 textHash/fingerprint，
  // 同一内容换行风格从 CRLF 变 LF 就会导致整书索引全量失效重建
  const raw = String(text).replace(/\r\n?/g, "\n");
  const chunks = [];
  const lines = raw.split(/\n/);
  let current = "";
  let chapter = "全书";
  const push = (text0) => {
    const t = String(text0).trim();
    // v2.6.0 审查修复：短章节（不足 8 字）不吞掉——章节内有内容即保留；无标题的"全书"模式仍按 8 字过滤噪音
    if (t.length >= 8 || (chapter !== "全书" && t.length > 0)) {
      chunks.push({ id: chapter + "#" + chunks.length, chapter, text: t });
    }
  };
  const flush = () => { push(current); current = ""; };
  for (const line of lines) {
    // v2.6.0 审查修复：识别章节标题（Markdown/序章类/全角数字/长句防误判）——标题行不进正文、章节切换时切分段落（不跨章）
    const title = extractChapterTitle(line);
    if (title !== null) {
      flush();
      chapter = title;
      continue;
    }
    // v2.6.0 审查修复：单行超长（PDF/网页复制的无换行文本）按 150 字片段切分，避免整行成一段导致 embed 截断
    const pieces = line.length > 150 ? line.match(/.{1,150}/g) : [line];
    for (const piece of pieces) {
      current += piece;
      // v4.0.0 修正：旧版「累加后判断」会带着上一行余量（最多 149 字）再加一个 150 字片段才 flush，
      // 实测单块最长 298 字（与"按 150 字切块"口径不符）；改为先切满 150 字再保留余量，块长恒定 ≤150
      while (current.length >= 150) {
        push(current.slice(0, 150));
        current = current.slice(150);
      }
    }
    if (line.trim() === "") flush();
  }
  flush();
  return chunks;
}

// v4.0.0 死代码清理：删除零调用的 loadIndex()（与 loadIndexMeta 的校验逻辑逐行重复，且丢弃 th 字段——一旦被喂给
// buildIndexIncremental 会让 old.th === th 恒假、增量退化为全量重算）与 reset()（全项目对 embedding.loadIndex / embedding.reset
// 无静态或动态调用；删除后 engine 字面量也不再有两处重复维护）。导出仅保留外部真实使用的符号：
// vibe.js 用 IMPLICIT_EMOTION_PROTOTYPES；index.js 用 status/isAvailable/embed/cosine/search/saveIndex/loadIndexMeta/
// fingerprint/buildIndexIncremental/chunkText/detectImplicitEmotions/engine。embedMany/textHash/cachePath/MODEL_DIR 保留为内部函数。
export { status, isAvailable, embed, cosine, search, saveIndex, loadIndexMeta, fingerprint, buildIndexIncremental, chunkText, detectImplicitEmotions, IMPLICIT_EMOTION_PROTOTYPES, engine };
