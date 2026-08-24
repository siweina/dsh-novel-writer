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
// v2.6.0 审查修复：Node <22.3 无 zstd——条件获取，不可用时索引缓存回退纯 JSON（插件照常加载，不崩）
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
const EMBED_DIM = 128; // v3.5.0 #55：缓存向量维度（降采样后）
const EMBEDDING_CACHE_ROOT = ".novel-writer";

let enginePromise = null;
let engine = { available: false, error: null, tokenizer: null, session: null, ort: null, wasmPaths: null };

/** 模型文件是否随包存在（纯文件探测）。 */
function modelPresent() {
  // v2.0.0 瘦身版：quantized 优先（fp32 已移除）
  return (fs.existsSync(path.join(MODEL_DIR, "onnx", "model_quantized.onnx")) || fs.existsSync(path.join(MODEL_DIR, "onnx", "model.onnx"))) && fs.existsSync(path.join(MODEL_DIR, "tokenizer.json"));
}

/** 懒加载模型（单例，WASM 推理）。 */
function initEngine() {
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
      engine.wasmPaths = pathToFileURL(dist + path.sep).href;
      ort.env.wasm.wasmPaths = engine.wasmPaths;
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
    } catch (e) {
      engine.available = false;
      engine.error = String(e).slice(0, 300);
    }
    return engine;
  })();
  return enginePromise;
}

/** 状态探测（不触发加载）。 */
function status() {
  return { modelPresent: modelPresent(), loaded: engine.available, error: engine.error };
}

/** 可用性（懒加载后返回；失败不抛）。 */
async function isAvailable() {
  if (!modelPresent()) return false;
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
  const data = Array.from(out.last_hidden_state.data);
  const cls = data.slice(0, dim);
  let norm = Math.sqrt(cls.reduce((sum, x) => sum + x * x, 0));
  if (!norm || !Number.isFinite(norm)) norm = 1;
  return cls.map((x) => x / norm);
}

/** 批量嵌入（并发 4）。 */
async function embedMany(chunks) {
  const out = new Array(chunks.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < chunks.length) {
      const i = cursor; cursor += 1;
      // v3.5.0 #53：单块容错——一块 embed 抛错（WASM 抖动/超长）不拖垮整本书索引
      try {
        const vec = await embed(chunks[i].text);
        out[i] = vec ? { id: chunks[i].id, text: chunks[i].text, vec } : null;
      } catch { out[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out.filter(Boolean);
}

/** 余弦相似度（长度防御）。 */
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 语义检索（query 维度跟随索引：首次直出 512 维 / 缓存命中 128 维）。 */
async function search(query, index, k = 5) {
  const qv = await embed(query);
  if (!qv || !index || index.length === 0) return [];
  // v2.5.0 修复轮 5：首次 built 的索引为 512 维（embedMany 直出），缓存命中为 128 维（saveIndex 降采样）——
  // query 必须与 index 同维度，否则 cosine(128,512) 长度不等恒返回 0（首次检索全 0 分、排序无意义）
  const dim = index[0]?.vec?.length ?? 0;
  const qvCache = dim === qv.length ? qv : qv.filter((_, i) => i % 4 === 0);
  return index
    .map((item) => ({ ...item, score: cosine(qvCache, item.vec) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, k);
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
      hits = await search(proto.text, index, topPerEmotion);
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
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  const distribution = {};
  for (const hit of entries) distribution[hit.top] = (distribution[hit.top] ?? 0) + 1;
  return { hits: entries, distribution };
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

/** 读取索引缓存文件（v2.6.0：zstd 压缩存储；旧版纯 JSON 自动兼容）。 */
function readIndexData(root, book) {
  const p = cachePath(root, book);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  if (zstdDecompressSync) {
    try { return JSON.parse(zstdDecompressSync(buf).toString("utf8")); } catch { /* 非 zstd 旧格式 → 按纯 JSON 读 */ }
  }
  try { return JSON.parse(buf.toString("utf8")); } catch { return null; }
}

/** 保存索引（v2.6.0：统一 128 维 + 4 位小数降精度 + zstd 压缩，体积约 1/10；fp=内容指纹）。 */
function saveIndex(root, book, index, fp = "") {
  try {
    const dir = path.dirname(cachePath(root, book));
    fs.mkdirSync(dir, { recursive: true });
    const compact = index.map((item) => {
      const vec = item.vec.length > 128 ? item.vec.filter((_, i) => i % 4 === 0) : item.vec;
      return {
        id: item.id,
        t: item.text.slice(0, 120),
        th: item.th ?? textHash(item.text),
        ch: item.chapter ?? null,
        v: vec.map((x) => Math.round(x * 10000) / 10000)
      };
    });
    const json = JSON.stringify({ model: "bge-small-zh-v1.5", dim: 128, fp, items: compact });
    const payload = Buffer.from(json, "utf8");
    fs.writeFileSync(cachePath(root, book), zstdCompressSync ? zstdCompressSync(payload) : payload);
    return true;
  } catch { return false; }
}

/** 读取索引缓存（不存在返回 null）。 */
function loadIndex(root, book) {
  try {
    const data = readIndexData(root, book);
    if (!data) return null;
    // v3.5.0 #55：与 loadIndexMeta 一致——model/dim 不符视为无缓存
    if (data.model !== MODEL_NAME || data.dim !== EMBED_DIM) return null;
    return data.items.map((item) => ({ id: item.id, text: item.t, vec: item.v, chapter: item.ch ?? null }));
  } catch { return null; }
}

/** 读取索引缓存 + 内容指纹（旧格式无 fp 时 fp=null，视为失效需重建；不靠版本号失效）。 */
function loadIndexMeta(root, book) {
  try {
    const data = readIndexData(root, book);
    if (!data) return { items: null, fp: null };
    // v3.5.0 #55：缓存校验 model/dim——换模型/维度变化时旧缓存作废（触发重建），防 cosine 恒 0
    if (data.model !== MODEL_NAME || data.dim !== EMBED_DIM) return { items: null, fp: null };
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
          vec: v.vec.length > 128 ? v.vec.filter((_, j) => j % 4 === 0) : v.vec,
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
    return stripped.slice(0, 30);
  }
  return null;
}

/** 全文 → 语义段落（按空行/150 字切块，带章节标记）。 */
function chunkText(text) {
  const raw = String(text);
  const chunks = [];
  const lines = raw.split(/\n/);
  let current = "";
  let chapter = "全书";
  const flush = () => {
    const t = current.trim();
    // v2.6.0 审查修复：短章节（不足 8 字）不吞掉——章节内有内容即保留；无标题的"全书"模式仍按 8 字过滤噪音
    if (t.length >= 8 || (chapter !== "全书" && t.length > 0)) {
      chunks.push({ id: chapter + "#" + chunks.length, chapter, text: t });
    }
    current = "";
  };
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
      if (current.length >= 150) flush();
    }
    if (line.trim() === "") flush();
  }
  flush();
  return chunks;
}

/** 显式释放（仅重置单例，WASM 内存由 GC 回收）。 */
function reset() { enginePromise = null; engine = { available: false, error: null, tokenizer: null, session: null, ort: null, wasmPaths: null }; }

export { status, isAvailable, embed, embedMany, cosine, search, saveIndex, loadIndex, loadIndexMeta, fingerprint, textHash, buildIndexIncremental, chunkText, reset, detectImplicitEmotions, IMPLICIT_EMOTION_PROTOTYPES, MODEL_DIR, cachePath };
