/**
 * lib/diagnose.js —— v6.6.0 的**诊断报告**：把日志与当前状态讲成人话。
 *
 * 为什么单独一个模块：`lib/log.js` 只负责"如实、脱敏地记下来"，而**作者不会去看 .jsonl**。
 * 真正的消费者是替他操作的 AI（经 `novel_diagnose` 工具）与维护者（收到用户附上的诊断包）。
 * 这个模块的职责就是把原始事件**聚合成结论**：发生了什么、有几次、最可能的原因、下一步做什么。
 *
 * 输出分两半：
 * - `report`：给人/模型读的中文报告（渲染用）
 * - 结构化字段：`root` / `dataDir` / `calls` / `issues` / `checklist`（读取方按需取用）
 *
 * **隐私**：本模块所有对外内容都走 `readLogEvents({ forShare: true })`——
 * 自由文本（note/detail/suggestion）在分享层已被整体剔除，所以报告里**不会有正文**
 * （也正因此，报告里不会出现原始错误消息文本；需要原文时看本地日志文件）。
 *
 * ============ v6.6.0 增强：四个体检维度（本次改动） ============
 *
 * 旧版只讲"日志里发生了什么"（工具调用/失败/降级）。但作者最常问的两句是
 * 「**语义检索好像不好用**」与「**某个功能好像没生效**」，而这两句的根因都不在日志里：
 * 前者是模型文件缺失/引擎初始化失败（**此前没有任何地方说**），后者是用户自己把开关关了
 * （工具只会回一句「已关闭」，不会告诉他是谁关的）。本次补齐：
 *   1. 语义引擎体检（`embedding.status()`，**不触发加载**）；
 *   2. 状态快照（`readSentenceStateSync()`：被关的工具/功能 + 总开关 + 容差）；
 *   3. 数据目录损坏检测（JSON 能否解析 / 0 字节 / 体积异常，**只读元数据**）；
 *   4. 按书的章节体检（书数/章数/总字数/命名异常/过短章，**只统计不读正文**）。
 *
 * ## ⚠️ 隐私红线（改这个文件之前先读这一条）
 *
 * 本模块的输出**会离开本机**：`novel_diagnose` 的报告会被 AI 转述，面板可以导出诊断包，
 * 用户会把它贴进 issue。所以返回值与报告里**只允许出现元数据**：
 * 工具名 / 书名 / 章名 / 状态 / 计数 / 耗时 / 路径 / 字节数 / 固定枚举标签 / 错误 code。
 *
 * **绝不允许**出现：章节正文、章节标题行之外的任何正文派生文本（摘要、词条、伏笔描述、
 * 设定文本、锚段、骨架），以及——**任何原始异常消息**。
 *
 * 最后一条最容易踩：`JSON.parse` 的报错**会把文件内容片段带进 message**
 * （Node 的 `Unexpected token 'x', "…" is not valid JSON` 会回显约 10 个字），
 * 而 `.novel-writer/` 下的 `summaries/`、`plots/`、`settings/` 正是**由正文派生**的。
 * 语义引擎的原始异常同样可能带绝对路径与系统信息。
 * 因此本文件里**所有错误一律归类成固定 code**（`classifyEngineError` /
 * `classifyCacheError` / 「无法解析为合法 JSON」），只输出 code 与中文短标签，永不输出原文。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
  novelDataDir, resolveRoot, readSentenceStateSync, ALL_TOOLS, toolEnabled,
  // v6.6.0：与**面板共用同一个书库根裁决点**（原来诊断自己按 cwd 猜，导致报告里的"书库根"
  // 与面板/工具实际用的不是同一个 —— 见 buildDiagnosis 里的修正说明）
  resolveUiRootInfo,
  featureEnabled, FEATURE_DEFAULTS, effectiveSentenceAnalysis, clampStyleTolerance,
  stateFilePath, novelsDir, bookDir, scanChapters, readTextFile, listBookNames
} from "./core.js";
import { readLogEvents, logStats, LOG_KINDS } from "./log.js";
import * as embedding from "./embedding.js";

/**
 * zstd 解压函数**条件获取**（与 embedding.js / vibe.js 同一写法与同一理由）：
 * `zlib.zstdDecompressSync` 是 Node ≥ 23.8 才有的，写成具名 import 会让旧 Node 在**链接期**
 * 直接崩（整个插件加载失败），所以只能在运行期探测。旧 Node 上压缩接口本来就是 null，
 * 于是那些缓存文件无法解压校验——此时只按魔数认定"这是压缩缓存"，**不判损坏**（宁可漏报不误报）。
 */
let zstdDecompressSync = null;
try { if (typeof zlib?.zstdDecompressSync === "function") zstdDecompressSync = zlib.zstdDecompressSync; } catch { /* 旧 Node：不校验压缩缓存 */ }

// ============ v6.6.0 增强：体检用的常量 ============

/** 插件数据目录下**应当存在**的 9 个子目录（novelDataDir(root) 的下一层） */
const DATA_SUBDIRS = Object.freeze([
  "analysis", "audits", "baseline", "embedding", "lexicon", "plots", "settings", "style-reports", "summaries"
]);
/** 各类清单在返回体/报告里最多列几条（一个坏掉的库不该把报告撑爆） */
const MAX_LIST = 12;
/** 「章节过短」阈值：<40 字的章（含只有标题的空壳章）会把六维基线与风格指纹拉偏 */
const SHORT_CHAPTER_CHARS = 40;
/** 单个 JSON 文件的解析上限：超过就只报体积、不整读（避免为一次诊断把 MB 级缓存读进内存） */
const MAX_PARSE_BYTES = 8 * 1024 * 1024;
/**
 * zstd 压缩体的解压上限（压缩后的大小）。
 *
 * ⚠️ 这条是**踩过坑才加的**：`.novel-writer/embedding/*.json` **不是文本 JSON**——
 * 索引缓存（embedding.js `saveIndex`）与风格原型缓存（vibe.js）在 Node ≥ 23.8 上都是
 * **zstd 压缩后直接落盘、扩展名仍叫 .json**。第一版检测器只做 `JSON.parse(readFileSync)`，
 * 于是在真实书库上把 15 个**健康**的缓存全报成「损坏」——正是这类"报告说坏了、其实没坏"
 * 最伤信任。现在按 zstd 魔数识别、按需解压再判，纯文本才走 JSON.parse。
 */
const MAX_DECOMPRESS_BYTES = 2 * 1024 * 1024;
/** zstd 帧魔数（`28 b5 2f fd`）：与其解析"是不是 JSON"，不如先判"是不是压缩体" */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
/** 压缩缓存不可解压时的**固定**原因标签（同隐私红线：绝不带原始 message） */
const LABEL_BROKEN_JSON = "无法解析为合法 JSON";
const LABEL_ZSTD_BROKEN = "zstd 缓存解压失败（写入被打断或文件被改坏）";
const LABEL_ZSTD_NOT_JSON = "zstd 解压后不是合法 JSON";
/** 章节字数统计的读取预算：超过就标记 partial（诊断必须便宜，绝不为它把整库读一遍） */
const SCAN_MAX_FILES = 2000;
const SCAN_MAX_CHARS = 8 * 1024 * 1024;
const MAX_BOOKS_LISTED = 40;

/**
 * 语义引擎失败的**归类表**（只出 code 与短标签，绝不出原始异常文本——见文件头隐私红线）。
 * 分类不是诊断的装饰：它决定给用户哪一条修法（缺文件 / 缺依赖 / WASM 起不来）。
 */
const ENGINE_ERROR_LABELS = Object.freeze({
  "runtime-missing": "运行时依赖没能加载（onnxruntime-web 或 @huggingface/tokenizers 未解析到）",
  "model-missing": "模型文件缺失（lib/models/ 下的 onnx 模型或 tokenizer）",
  "wasm-failed": "WASM 会话创建或推理失败",
  "unknown": "原因未能归类（原始文本按隐私设计不入报告）"
});
/** 索引缓存读写失败的归类表（同一套理由：原文可能是 "ENOSPC: no space left on device, write" 这种含路径的系统文本） */
const CACHE_ERROR_LABELS = Object.freeze({
  "no-space": "磁盘空间不足（ENOSPC）",
  "denied": "权限不足或被拒绝（EACCES/EPERM）",
  "locked": "文件被占用或重命名失败（缓存写不进去）",
  "corrupt": "缓存内容损坏或维度不符（会触发全量重建）",
  "unknown": "原因未能归类（原始文本按隐私设计不入报告）"
});

/** 把引擎原始异常归类成固定 code（空/无错误 → ""）。判定顺序有意义：先"依赖没装"再"文件没找到"。 */
function classifyEngineError(raw) {
  if (raw === void 0 || raw === null || String(raw).trim() === "") return "";
  const s = String(raw).toLowerCase();
  if (/cannot find (module|package)|err_module_not_found|could not resolve|not found in the package/.test(s)) return "runtime-missing";
  if (/enoent|no such file|not a valid file/.test(s)) return "model-missing";
  if (/onnxruntime|wasm|webassembly|inference|tensor|session|out of range|memory/.test(s)) return "wasm-failed";
  return "unknown";
}

/** 把缓存链路的原始异常归类成固定 code（空/无错误 → ""）。同样只看原文的**模式**，不外传原文。 */
function classifyCacheError(raw) {
  if (raw === void 0 || raw === null || String(raw).trim() === "") return "";
  const s = String(raw).toLowerCase();
  if (/enospc|no space left/.test(s)) return "no-space";
  if (/eacces|eperm|denied|read-only|readonly/.test(s)) return "denied";
  if (/ebusy|locked|being used|occupied|rename/.test(s)) return "locked";
  if (/dim|vector|向量|corrupt|损坏|length mismatch/.test(s)) return "corrupt";
  return "unknown";
}

/** 判定"这个路径像不像书库根"：结构与 core.looksLikeLibraryRoot 同口径（有 novels/ 或 .novel-writer/） */
function looksLikeRoot(path) {
  try {
    return existsSync(join(path, "novels")) || existsSync(join(path, ".novel-writer"));
  } catch {
    return false;
  }
}

/**
 * 数据目录体检：**只读元数据**——体积/文件数、每个 JSON 文件能否解析、0 字节、体积异常。
 *
 * ⚠️ 隐私红线（见文件头）：本函数只碰 `.novel-writer/` 下的**缓存/设定文件**，读到的内容
 * **只用于 JSON.parse 判定**，绝不进入返回值；也绝不去读 `novels/` 下的章节正文（那是
 * `inspectLibrary` 的事）。解析失败时**连原始异常文本都不记**——理由见文件头（JSON.parse
 * 的报错会回显文件内容片段，而 summaries/plots 是正文派生的）。
 *
 * 判定口径与 core.js 的词表守卫保持一致：文件**存在但解析不了**才是"损坏"（corrupt），
 * 文件不存在是另一回事（这里是 `missingSubdirs` / 0 字节）。
 */
function inspectDataDir(root) {
  const dir = novelDataDir(root);
  const out = {
    path: dir, exists: existsSync(dir), bytes: 0, files: 0, subdirs: [],
    expectedSubdirs: DATA_SUBDIRS.length, presentSubdirs: 0, missingSubdirs: [],
    checkedJson: 0, nonJsonFiles: 0, compressedJson: 0, compressedSkipped: 0,
    unreadableTotal: 0,
    corruptTotal: 0, emptyTotal: 0, oversizedTotal: 0,
    corruptFiles: [], emptyFiles: [], oversizedFiles: [], unreadableFiles: []
  };
  if (!out.exists) { out.missingSubdirs = DATA_SUBDIRS.slice(); return out; }
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { out.missingSubdirs = DATA_SUBDIRS.slice(); return out; }
  const dirNames = [];
  const looseFiles = [];
  for (const e of entries) {
    if (e.isDirectory()) dirNames.push(e.name);
    else if (e.isFile()) looseFiles.push(e.name);   // 数据目录根下的散落文件（正常应为空，故也扫一眼）
  }
  out.presentSubdirs = DATA_SUBDIRS.filter((n) => dirNames.includes(n)).length;
  out.missingSubdirs = DATA_SUBDIRS.filter((n) => !dirNames.includes(n));
  // `only` 用于"根目录下的散落文件"这一桶：只扫那几个名字，不再 readdir（已经在上面读过了）
  const buckets = dirNames.map((name) => ({ name, path: join(dir, name) }));
  if (looseFiles.length > 0) buckets.push({ name: ".", path: dir, only: looseFiles });
  const recordCorrupt = (full, rel, subdir, bytes, label) => {
    out.corruptTotal += 1;
    if (out.corruptFiles.length < MAX_LIST) out.corruptFiles.push({ file: full, rel, subdir, bytes, error: label });
  };
  for (const bucket of buckets) {
    const row = { name: bucket.name, bytes: 0, files: 0 };
    let names = bucket.only;
    if (names === void 0) { try { names = readdirSync(bucket.path); } catch { names = []; } }
    for (const f of names) {
      const full = join(bucket.path, f);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      row.bytes += st.size; row.files += 1;
      out.bytes += st.size; out.files += 1;
      const rel = (bucket.name === "." ? "" : bucket.name + "/") + f;
      if (st.size === 0) {
        // 0 字节 = 写入被打断/被外部程序清空；读它的调用方一律会当成"空表"，所以单独一类
        out.emptyTotal += 1;
        if (out.emptyFiles.length < MAX_LIST) out.emptyFiles.push({ file: full, rel, subdir: bucket.name, bytes: 0 });
        continue;
      }
      if (extname(f).toLowerCase() !== ".json") { out.nonJsonFiles += 1; continue; }
      if (st.size > MAX_PARSE_BYTES) {
        out.oversizedTotal += 1;
        if (out.oversizedFiles.length < MAX_LIST) out.oversizedFiles.push({ file: full, rel, subdir: bucket.name, bytes: st.size });
        continue;                                   // 大文件只报体积，不整读
      }
      let buf;
      try { buf = readFileSync(full); } catch {
        out.unreadableTotal += 1;
        if (out.unreadableFiles.length < MAX_LIST) out.unreadableFiles.push({ file: full, rel, subdir: bucket.name, bytes: st.size });
        continue;
      }
      const isZstd = buf.length >= 4 && buf[0] === ZSTD_MAGIC[0] && buf[1] === ZSTD_MAGIC[1] && buf[2] === ZSTD_MAGIC[2] && buf[3] === ZSTD_MAGIC[3];
      if (isZstd) {
        // 压缩缓存（embedding/*.json、*__style*.json）：**先按魔数认出它**，再决定要不要解压判定。
        // 不这么做就会把健康的缓存全报成"损坏"（见 MAX_DECOMPRESS_BYTES 的注释）。
        out.compressedJson += 1;
        if (zstdDecompressSync === null || st.size > MAX_DECOMPRESS_BYTES) { out.compressedSkipped += 1; continue; }
        let text = null;
        try {
          text = zstdDecompressSync(buf, { maxOutputLength: MAX_PARSE_BYTES }).toString("utf8");
        } catch (e) {
          // 解压后超过 8 MB：不判损坏（那是"缓存很大"，不是"缓存坏了"）
          if (e?.code === "ERR_BUFFER_TOO_LARGE") { out.compressedSkipped += 1; continue; }
          recordCorrupt(full, rel, bucket.name, st.size, LABEL_ZSTD_BROKEN);
          continue;
        }
        try { JSON.parse(text); } catch { recordCorrupt(full, rel, bucket.name, st.size, LABEL_ZSTD_NOT_JSON); }
        continue;
      }
      out.checkedJson += 1;
      try {
        JSON.parse(buf.toString("utf8"));           // 只判可解析性，结果立刻丢弃
      } catch {
        recordCorrupt(full, rel, bucket.name, st.size, LABEL_BROKEN_JSON);
      }
    }
    if (row.files > 0 || bucket.name !== ".") out.subdirs.push(row);
  }
  out.subdirs.sort((a, b) => b.bytes - a.bytes);
  return out;
}

/**
 * 语义引擎体检——**只做状态探测，不触发模型加载**。
 *
 * 用 `embedding.status()`：它是纯探测（existsSync 模型文件 + 读进程内存里的引擎状态），
 * 不会把 WASM 会话拉起来。诊断必须便宜且无副作用（不预热模型、不写缓存、不占内存）。
 *
 * 三件事必须讲清楚，否则报告会误导人：
 *   ① `loaded:false` **不等于坏**——模型是首次真正用到时才惰性加载的；
 *   ② 只有 `modelPresent:false` 或 `errorCode` 非空才是确定的问题；
 *   ③ `error` 是**进程内**上一次初始化失败的结果，重启宿主后会丢——所以另外统计日志里
 *      历史 `kind==="engine"` 事件（跨进程证据）。
 */
function inspectEngine(events) {
  const out = {
    modelDir: join(dirname(fileURLToPath(import.meta.url)), "models"),
    model: String(embedding.MODEL_NAME ?? ""),
    modelPresent: null, loaded: false,
    errorCode: "", errorLabel: "", lastCacheErrorCode: "", lastCacheErrorLabel: "",
    events: { count: 0, codes: [] }
  };
  let st = null;
  try { st = typeof embedding.status === "function" ? embedding.status() : null; } catch { st = null; }   // 探测失败不该让诊断失败
  if (st !== null && typeof st === "object") {
    out.modelPresent = st.modelPresent === true;
    out.loaded = st.loaded === true;
    out.errorCode = classifyEngineError(st.error);
    out.lastCacheErrorCode = classifyCacheError(st.lastCacheError);
  }
  out.errorLabel = out.errorCode === "" ? "" : ENGINE_ERROR_LABELS[out.errorCode];
  out.lastCacheErrorLabel = out.lastCacheErrorCode === "" ? "" : CACHE_ERROR_LABELS[out.lastCacheErrorCode];
  const codes = new Map();
  for (const ev of events) {
    if (ev.kind !== "engine") continue;
    out.events.count += 1;
    const code = String(ev.code ?? "(无 code)");
    codes.set(code, (codes.get(code) ?? 0) + 1);
  }
  out.events.codes = [...codes.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count).slice(0, 6);
  return out;
}

/**
 * **只返回字数**——正文绝不出这个函数（隐私红线的实现手段之一：返回值是 number，没有别的东西可泄漏）。
 * 用 `readTextFile`（core 的统一解码口径）而不是字节数：GBK/UTF-16 章节按 size 估算会偏大。
 */
async function countChapterChars(file) {
  const text = await readTextFile(file, null);
  return typeof text === "string" ? text.length : 0;
}

/**
 * 按书的章节体检。**只统计，不读正文内容**：
 *   · 书数/章数/文件名来自 `listBookNames` + `scanChapters`（只 readdir + 解析文件名）；
 *   · 字数由 `countChapterChars` 给出（只回一个数字）；
 *   · 返回值里**只有**书名、文件名、章数、字数、计数——不含任何正文/标题文本。
 *
 * 为什么要这一节：`<40 字` 的章与"解析不出章号"的文件在 `novel_chapters` 里都只表现为
 * "有一章"，但它们会（前者）把六维基线与风格指纹拉偏、（后者）让章序排到末尾且无法被
 * 章号定位——两类问题在别处都看不出来。
 */
async function inspectLibrary(root) {
  const out = {
    path: novelsDir(root), bookCount: 0, chapterCount: 0, chars: 0,
    books: [], badNameTotal: 0, shortTotal: 0, unreadableTotal: 0,
    emptyBookCount: 0, unreadableBookCount: 0,
    badNames: [], shortChapters: [], unreadableFiles: [],
    partial: false, scannedFiles: 0
  };
  let names = [];
  try { names = await listBookNames(root); } catch { names = []; }
  out.bookCount = names.length;
  for (const name of names) {
    const dir = bookDir(root, name);
    const row = { name, chapters: 0, chars: 0, badNames: 0, shortChapters: 0, unreadable: 0 };
    let chapters = [];
    try {
      chapters = await scanChapters(dir);
    } catch {
      out.unreadableBookCount += 1;   // 目录存在（listBookNames 列出来的）却读不动：权限/占用
      out.books.push(row);
      continue;
    }
    row.chapters = chapters.length;
    if (chapters.length === 0) out.emptyBookCount += 1;
    for (const ch of chapters) {
      if (!Number.isFinite(ch.number)) {
        row.badNames += 1; out.badNameTotal += 1;
        if (out.badNames.length < MAX_LIST) out.badNames.push({ book: name, file: ch.file });
      }
      if (out.scannedFiles >= SCAN_MAX_FILES || out.chars >= SCAN_MAX_CHARS) { out.partial = true; continue; }
      out.scannedFiles += 1;
      try {
        const n = await countChapterChars(join(dir, ch.file));
        row.chars += n; out.chars += n;
        if (n < SHORT_CHAPTER_CHARS) {
          row.shortChapters += 1; out.shortTotal += 1;
          if (out.shortChapters.length < MAX_LIST) out.shortChapters.push({ book: name, file: ch.file, chars: n });
        }
      } catch {
        row.unreadable += 1; out.unreadableTotal += 1;
        if (out.unreadableFiles.length < MAX_LIST) out.unreadableFiles.push({ book: name, file: ch.file });
      }
    }
    out.chapterCount += chapters.length;
    out.books.push(row);
  }
  out.books.sort((a, b) => b.chars - a.chars);
  return out;
}

/**
 * 开关与状态快照。
 *
 * 为什么这是本次增强里**最值钱**的一条：工具被关掉时，AI 只会收到一句「当前已在 UI 中关闭」，
 * 而**用户往往不记得是自己关的**——于是反复重试、以为插件坏了。这里把"哪些工具关了、
 * 哪些功能关了、总开关在哪一档"直接列出来，一句话就能对上。
 *
 * 已知口径差异（如实记下）：`readSentenceStateSync()` 在**无状态文件/解析失败**时返回
 * `{ leanWorkflow: false }`——**既没有 exists 也没有 enabled**（异步版 `readSentenceState()`
 * 有 exists）。所以这里自己补 `exists`（existsSync），并把"缺省 = 开启"的语义显式写出，
 * 避免把"读不到"误报成"关着"。
 */
function inspectSwitches(config) {
  const file = stateFilePath();
  const out = {
    stateFile: { path: file, exists: false },
    master: { enabled: true, autoAnalyze: true, source: "默认值（无 state.json）" },
    prompt: { systemPromptMode: "brief", promptScene: "general", leanWorkflow: false },
    tools: { registered: ALL_TOOLS.length, enabled: ALL_TOOLS.length, disabled: [] },
    features: { effective: {}, disabled: [] },
    styleTolerance: {},
    lastRoot: ""
  };
  try { out.stateFile.exists = existsSync(file); } catch { /* 路径不可判定：按不存在处理 */ }
  let state = null;
  try { state = readSentenceStateSync(); } catch { state = null; }   // 读不到就按"全部启用"计，诊断不该因状态读失败而失败
  if (state === null || typeof state !== "object") return out;
  const withExists = { ...state, exists: out.stateFile.exists };
  try {
    // 总开关走 core 的**单一裁决点**（config → state → 默认），不在这里重写一遍判断
    const eff = effectiveSentenceAnalysis(config, withExists);
    out.master = {
      enabled: eff.enabled !== false,
      autoAnalyze: eff.autoAnalyze !== false,
      source: out.stateFile.exists ? "state.json" : "config / 默认值（无 state.json）"
    };
  } catch { /* 裁决失败就保留"开启"默认 */ }
  out.prompt = {
    systemPromptMode: ["off", "brief", "full"].includes(state.systemPromptMode) ? state.systemPromptMode : "brief",
    promptScene: typeof state.promptScene === "string" && state.promptScene !== "" ? state.promptScene : "general",
    leanWorkflow: state.leanWorkflow === true
  };
  for (const name of ALL_TOOLS) {
    let on = true;
    try { on = toolEnabled(withExists, name) !== false; } catch { on = true; }
    if (!on) out.tools.disabled.push(name);
  }
  out.tools.enabled = ALL_TOOLS.length - out.tools.disabled.length;
  // 功能开关：已声明的全查一遍（缺失回退 FEATURE_DEFAULTS，与 core 同口径），外加用户自加的布尔键
  const declared = Object.keys(FEATURE_DEFAULTS);
  const extra = Object.keys(state.features ?? {}).filter((k) => !declared.includes(k)).slice(0, 20);
  for (const name of [...declared, ...extra]) {
    let on = true;
    try { on = featureEnabled(withExists, name) !== false; } catch { on = true; }
    out.features.effective[name] = on;
    if (!on) out.features.disabled.push(name);
  }
  // 容差：用 core 的 clampStyleTolerance 走同一套钳制，避免把用户手改的脏值原样带出来
  try { out.styleTolerance = clampStyleTolerance(state.styleTolerance ?? null); } catch { out.styleTolerance = {}; }
  out.lastRoot = typeof state.lastRoot === "string" ? state.lastRoot : "";
  return out;
}

/**
 * 从分享层事件里聚合出"发生了什么"。
 * 注意：事件已被剔除自由文本，所以这里只会看到 status/code/tool/kind/book 等结构性字段。
 */
function aggregate(events) {
  const calls = { total: 0, ok: 0, degraded: 0, failed: 0 };
  const byTool = new Map();
  // v6.6.0 增强：byKind 从"计数"升级为"计数 + 该类型下的 code 分布"。
  // 为什么需要：`silent_skip` / `cache` / `engine` 这几类的**代码**才是可行动信息，
  // 光知道"有 12 次 cache 事件"没法修；知道"12 次都是同一个 code"就能定位到具体文件。
  const byKind = new Map();
  const byCode = new Map();
  // v6.6.0：**按「工具 + 书名」聚合失败/降级**。
  // 为什么需要它：插件里大量用法错误是 `assert` 抛的普通 Error（**没有 code**），
  // 而这一类正是"使用者的操作错误"（书名写错、章号不存在…）。按书分组后，
  // 「同一本书同一个工具错了 5 次」这种**模式**才看得出来——而这正是单次调用的友好报错给不了的。
  // 书名在字段白名单里（可安全分享），所以这个分组在分享层依然可用。
  const problems = new Map();
  for (const ev of events) {
    const k = byKind.get(ev.kind) ?? { count: 0, codes: new Map() };
    k.count += 1;
    if (ev.code) k.codes.set(String(ev.code), (k.codes.get(String(ev.code)) ?? 0) + 1);
    byKind.set(ev.kind, k);
    if (ev.kind !== "tool_call") continue;
    calls.total += 1;
    if (ev.status === "failed") calls.failed += 1;
    else if (ev.status === "degraded") calls.degraded += 1;
    else calls.ok += 1;
    const name = String(ev.tool ?? "?");
    const row = byTool.get(name) ?? { tool: name, total: 0, ok: 0, degraded: 0, failed: 0, msTotal: 0, msCount: 0 };
    row.total += 1;
    if (ev.status === "failed") row.failed += 1;
    else if (ev.status === "degraded") row.degraded += 1;
    else row.ok += 1;
    if (Number.isFinite(ev.ms)) { row.msTotal += ev.ms; row.msCount += 1; }
    byTool.set(name, row);
    if (ev.code) byCode.set(ev.code, (byCode.get(ev.code) ?? 0) + 1);
    if (ev.status === "failed" || ev.status === "degraded") {
      const book = String(ev.book ?? "");
      const key = name + "\u0000" + book;
      const p = problems.get(key) ?? { tool: name, book, failed: 0, degraded: 0, codes: new Set(), chapters: new Set() };
      if (ev.status === "failed") p.failed += 1; else p.degraded += 1;
      if (ev.code) p.codes.add(String(ev.code));
      if (ev.chapter) p.chapters.add(String(ev.chapter));
      problems.set(key, p);
    }
  }
  return {
    calls,
    byTool: [...byTool.values()]
      .map((r) => {
        const { msCount, ...rest } = r;                       // msCount 只是中间量，不外传
        return { ...rest, msAvg: msCount > 0 ? Math.round(r.msTotal / msCount) : 0 };
      })
      .sort((a, b) => b.total - a.total).slice(0, 12),
    byKind: [...byKind.entries()]
      .map(([kind, v]) => ({ kind, count: v.count, codes: [...v.codes.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count).slice(0, 4) }))
      .sort((a, b) => b.count - a.count),
    topCodes: [...byCode.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    problems: [...problems.values()]
      .map((p) => ({ tool: p.tool, book: p.book, failed: p.failed, degraded: p.degraded, codes: [...p.codes].slice(0, 4), chapters: [...p.chapters].slice(0, 4) }))
      .sort((a, b) => (b.failed + b.degraded) - (a.failed + a.degraded))
      .slice(0, 10)
  };
}

/**
 * 由聚合结果推出"问题清单 + 建议"。每条都有级别、依据（计数）、以及**可执行动作**。
 *
 * 写作要求（沿用既有风格，别退化）：`suggestion` 必须是一句"照着做就行"的动作
 * （点哪个开关、跑哪个工具、删/改哪个文件），不能是"建议检查一下环境"这种空话。
 * 结构要求：**只能有 level/title/detail/suggestion 四个键**——`novel_diagnose` 的
 * output schema 里 issues[] 元素是 additionalProperties:false，多一个键就会被宿主拒收。
 */
function deriveIssues(ctx) {
  const issues = [];
  const { root, rootLooksOk, dataDir, calls, stats, book, switches, engine, library } = ctx;
  // 反复失败的模式（这是日志最有价值的产出：单次调用看不见的规律）
  const repeated = (ctx.aggregate?.problems ?? []).filter((p) => p.failed >= 2 || (p.failed + p.degraded) >= 3);
  if (repeated.length > 0) {
    const top = repeated[0];
    issues.push({
      level: "warn",
      title: "同一工具在同一本书上反复出问题：" + top.tool + (top.book ? "（《" + top.book + "》）" : "") +
        " 失败 " + top.failed + " 次" + (top.degraded ? "、降级 " + top.degraded + " 次" : ""),
      detail: "这类重复几乎总是指向一个**用法/环境**问题（书名写法、章号不存在、书库根不对、缺必要前置数据），而不是偶发抖动。" +
        (top.chapters.length > 0 ? "涉及章节：" + top.chapters.join("、") + "。" : ""),
      suggestion: "先看失败时工具返回的那句提示（自由文本没有写进日志，避免正文外泄）；" +
        "若提示是「找不到作品/章节」，核对书名与章号是否与 novel_books / novel_chapters 输出完全一致（注意首尾空格）。"
    });
  }
  if (!rootLooksOk) {
    issues.push({
      level: "error",
      title: "书库根可能不对",
      detail: "解析出的根目录下既没有 novels/ 也没有 .novel-writer/：面板会列不出书、工具会报「未找到作品目录」。",
      suggestion: "根必须是 novels 的**父目录**（填成 novels 目录本身会去找 novels/novels）。修法：在正确目录下做一次写操作（如 novel_import / novel_new_chapter）以刷新记录，或在 profile 里显式配置 config.root。"
    });
  }
  if (calls.failed > 0) {
    issues.push({
      level: "warn",
      title: "近期有工具调用失败：" + calls.failed + " 次",
      detail: "失败原因的类型计数见 topCodes（自由文本已剔除，原文请看本地日志文件）。",
      suggestion: "先看 topCodes 里出现最多的那个 code——同一 code 反复出现通常指向一个固定的用法问题（例如书名/章号写法不对）。"
    });
  }
  if (calls.degraded > 0) {
    issues.push({
      level: "info",
      title: "近期有降级调用：" + calls.degraded + " 次",
      detail: "降级意味着工具返回了 degraded 说明（某些检查被跳过），结果仍然可用但不完整。",
      suggestion: "用 novel_diagnose action=events 看具体是哪些工具、哪一类降级；常见原因是设定表/钩子记录未初始化或章节过短。"
    });
  }
  if (!dataDir.exists) {
    issues.push({
      level: "info",
      title: "还没有插件数据目录",
      detail: "尚未产生缓存/设定/词表等数据（首次使用属正常）。",
      suggestion: "无需处理；若你确实用过分析类工具，说明写入被拒（检查目录权限）。"
    });
  }
  if (stats.exists && stats.bytes > 300 * 1024) {
    issues.push({
      level: "info",
      title: "事件日志接近轮转上限",
      detail: "当前日志合计约 " + Math.round(stats.bytes / 1024) + " KB（上限 " + Math.round((512 * 3) / 1024) + " KB 左右）。",
      suggestion: "一般无需处理（会自动轮转并删除最旧）；想清理可用 novel_diagnose action=clear。"
    });
  }
  if (book) {
    const rows = ctx.aggregate.byTool.filter((r) => r.total > 0);
    if (rows.length === 0) {
      issues.push({
        level: "info",
        title: "窗口内没有与《" + book + "》相关的调用记录",
        detail: "可能是窗口设得太短，或该书确实近期没被操作过。",
        suggestion: "把 days 调大（如 30）再试。"
      });
    }
  }
  // ============ v6.6.0 增强：四个体检维度对应的问题与建议 ============
  // ---- ① 语义引擎（"语义检索好像不好用"的根因，此前没有任何地方说） ----
  const eng = engine ?? {};
  const engineEvents = eng.events?.count ?? 0;
  if (switches && switches.features?.effective?.semanticEmbedding === false) {
    issues.push({
      level: "info",
      title: "本地语义功能已在配置里整体关闭（features.semanticEmbedding=false）",
      detail: "它是语义检索 / 语义风格 / 隐式情绪增强的**总门控**：关掉它，这三个子功能即使各自开着也不生效，且不会报错。",
      suggestion: "要恢复：novel_sentence_config action=set features={\"semanticEmbedding\":true}（或在侧边栏「写作助手功能」里打开「本地语义」）。"
    });
  } else if (eng.modelPresent === false) {
    issues.push({
      level: "warn",
      title: "本地语义引擎的模型文件不在位",
      detail: "模型随包分发在插件的 lib/models/ 下（onnx 模型 + tokenizer）。文件缺失时语义检索/语义风格/隐式情绪一律**静默回退纯规则**，表现为“功能好像不好用”却不报错。",
      suggestion: "重新安装或覆盖升级插件包（包体不完整是最常见原因），确认 " + (eng.modelDir ?? "lib/models") + " 下同时存在 onnx/model_quantized.onnx（或 model.onnx）、tokenizer.json（或 tokenizer.json.gz）、tokenizer_config.json 三个文件。"
    });
  } else if (eng.errorCode) {
    issues.push({
      level: "warn",
      title: "语义引擎初始化失败（已回退纯规则）：" + eng.errorCode,
      detail: "分类：" + (eng.errorLabel ?? eng.errorCode) + "。原始异常文本按隐私设计不写入报告。注意本次报告**不触发模型加载**，所以这里看到的是本进程上一次尝试的结果，也可能是历史事件。",
      suggestion: "先跑一次 novel_semantic_search（任意 query）复现；仍失败按分类修：runtime-missing → 重装依赖/插件（onnxruntime-web 或 @huggingface/tokenizers 没装全）；model-missing → 补齐 lib/models/ 下的模型与 tokenizer；wasm-failed → 换用受支持的 Node/宿主版本后重启宿主再试。"
    });
  }
  if (eng.lastCacheErrorCode) {
    issues.push({
      level: "info",
      title: "语义索引缓存最近读写失败过：" + eng.lastCacheErrorCode,
      detail: "分类：" + (eng.lastCacheErrorLabel ?? eng.lastCacheErrorCode) + "。缓存写不进去不会让功能报错，只会让每次调用都重建索引（明显变慢）。",
      suggestion: "按分类修：no-space → 清理磁盘空间；denied → 给 " + (dataDir.path ?? ".novel-writer") + "/embedding 目录写权限（或去掉只读属性）；locked → 关掉占用该文件的程序后重跑一次 novel_sentence_analysis 重建缓存；corrupt → 删除该目录下对应书的缓存文件让插件重建。"
    });
  }
  if (engineEvents > 0) {
    const codes = (eng.events?.codes ?? []).map((c) => c.code + "×" + c.count).join("　");
    issues.push({
      level: "info",
      title: "日志里有 " + engineEvents + " 条语义引擎事件",
      detail: "这些是**跨进程**留下的证据（引擎状态本身在进程内存里，重启宿主就丢了）。code：" + codes,
      suggestion: "用 novel_diagnose action=events 配合 days 调大，看这些事件集中在哪个时间点；若与“语义检索没结果”同时发生，按上面的引擎分类处理。"
    });
  }
  // ---- ② 开关快照（工具被关掉时 AI 只收到「已关闭」，用户不知道是自己关的） ----
  const disabledTools = switches?.tools?.disabled ?? [];
  if (disabledTools.length > 0) {
    issues.push({
      level: "warn",
      title: "有 " + disabledTools.length + " 个工具已在配置里被关闭",
      detail: "被关的工具调用时会直接报「当前已在 UI 中关闭」（不是报错、更不是坏了）——如果你不记得关过，就是这里。关闭项：" + disabledTools.join("、"),
      suggestion: "要恢复：novel_sentence_config action=set tools={\"" + disabledTools[0] + "\":true}（其余同理），或在侧边栏「写作助手功能」面板里打开对应开关。"
    });
  }
  const disabledFeatures = switches?.features?.disabled ?? [];
  if (disabledFeatures.length > 0) {
    const onlyEmbedding = disabledFeatures.length === 1 && disabledFeatures[0] === "semanticEmbedding";
    if (!onlyEmbedding || eng.modelPresent !== false) {
      issues.push({
        level: "info",
        title: "有 " + disabledFeatures.length + " 个功能开关处于关闭",
        detail: "关闭项：" + disabledFeatures.join("、") + "。功能关闭是静默的：结果里少一块内容，但工具不会报错。",
        suggestion: "novel_sentence_config action=set features={\"" + disabledFeatures[0] + "\":true} 打开（或在侧边栏面板里切回），然后用对应工具重跑一次确认回来了。"
      });
    }
  }
  if (switches && switches.master?.enabled === false) {
    issues.push({
      level: "warn",
      title: "「写作助手」总开关（enabled）处于关闭状态",
      detail: "来源：" + (switches.master?.source ?? "?") + "。它会让句式和风格类分析整体短路：novel_style_check 与 novel_fix_plan 直接报「当前已关闭」，novel_sentence_analysis 返回 enabled:false 且不产出结果。",
      suggestion: "novel_sentence_config action=set enabled=true 打开；若你是用 profile 的 config.sentenceAnalysis.enabled=false 关的，那里也要一起改回来（state.json 存在时以 state.json 为准）。"
    });
  }
  if (switches && switches.stateFile?.exists === false) {
    issues.push({
      level: "info",
      title: "还没有状态文件（所有开关都是默认值）",
      detail: "状态文件：" + (switches.stateFile?.path ?? "?") + "。没有它时插件走默认值（句式分析开、自动分析开、语义全开），并非异常。",
      suggestion: "无需处理。若你以前设置过开关却看到这里为空，说明设置写到了别的 DSH_HOME/用户目录下——检查该路径是否存在、是否可写。"
    });
  }
  if (root?.lastRoot && root.lastRootLooksLikeLibraryRoot === false) {
    issues.push({
      level: "warn",
      title: "记录里的书库根（lastRoot）已失效",
      detail: "lastRoot 指向 " + root.lastRoot + "，那里既没有 novels/ 也没有 .novel-writer/。面板不会采用它（会被跳过），但每次解析根都会白跑一次。",
      suggestion: "在正确的书库根目录下做一次写操作（如 novel_new_chapter / novel_import）刷新 lastRoot，或在 profile 的 cordis.patch.yml 里给 config.root 硬钉一个根。"
    });
  }
  // ---- ③ 数据目录损坏 ----
  if (dataDir.corruptTotal > 0) {
    const rows = (dataDir.corruptFiles ?? []).map((f) => f.rel + "：" + f.error).join("；");
    issues.push({
      level: "error",
      title: "插件数据目录里有 " + dataDir.corruptTotal + " 个文件读不出内容（已损坏）",
      detail: "损坏文件（调用方读到的是空表，且词表类写操作会被拒绝以防清空原条目）：" + rows + (dataDir.corruptTotal > (dataDir.corruptFiles?.length ?? 0) ? " 等" : "") + "。判定口径与 core.js 的词表守卫一致：文件存在但读不出内容 = 损坏。原始异常文本按隐私设计不写入报告。",
      suggestion: "先备份 " + (dataDir.path ?? ".novel-writer") + "，再删除（或改名）上面列出的文件让插件重建；lexicon 层的损坏文件可用 novel_lexicon action=import force=true 覆盖重建（会丢弃原条目）；embedding 层的压缩缓存删掉只会让下次分析重建索引（慢一次，无损）。"
    });
  }
  if (dataDir.unreadableTotal > 0) {
    issues.push({
      level: "warn",
      title: "插件数据目录里有 " + dataDir.unreadableTotal + " 个文件读不出来（权限/占用）",
      detail: "读不出与「本来就没有」在调用方表现完全一样（都是空表），所以这类失败最容易无声无息：" + (dataDir.unreadableFiles ?? []).map((f) => f.rel).join("、"),
      suggestion: "检查文件权限（去只读属性）与占用情况（退出网盘同步/编辑器后重试）；确认 " + (dataDir.path ?? ".novel-writer") + " 在磁盘上可读写。"
    });
  }
  if (dataDir.emptyTotal > 0) {
    const rows = (dataDir.emptyFiles ?? []).map((f) => f.rel).join("、");
    issues.push({
      level: "warn",
      title: "插件数据目录里有 " + dataDir.emptyTotal + " 个 0 字节文件",
      detail: "0 字节通常意味着上一次写入中途被打断（进程被杀、磁盘满、跨设备 rename 失败）。调用方读它一律会当成“空表”，与真的没有数据无法区分。文件：" + rows,
      suggestion: "直接删除这些文件，让对应功能重新生成（缓存类无损；若是 settings/plots/summaries 下的，删了就丢该书的设定/伏笔/摘要，请先确认能否重建）。"
    });
  }
  if (dataDir.oversizedTotal > 0) {
    const rows = (dataDir.oversizedFiles ?? []).map((f) => f.rel + "（" + Math.round(f.bytes / 1024) + " KB）").join("、");
    issues.push({
      level: "info",
      title: "插件数据目录里有 " + dataDir.oversizedTotal + " 个超大文件（≥ 8 MB）",
      detail: "本次只记录了体积、**没有整读**它们（避免为一次诊断把 MB 级缓存读进内存）：" + rows,
      suggestion: "一般可忽略（embedding 索引会随书变长）；若它明显拖慢分析，删除该文件让插件重建即可（重建需要重新推理，会慢一次）。"
    });
  }
  // ---- ④ 按书的章节体检 ----
  if (library) {
    if (library.bookCount === 0) {
      issues.push({
        level: "warn",
        title: "novels/ 下没有作品目录",
        // v6.6.0 修正：这里原先写「书库根 <path>」✗ —— `library.path` 其实是**书目目录**
        //（书库根下的 novels/），把它叫"书库根"会让用户去改错地方（面板截图里就是这么误导的）。
        // v6.6.0 修正二：原来还无条件断言该目录「存在」✗ —— 而根解析错时它根本不存在（用户截图里
        // 「C:\…\desktop\novels 存在」就是假的）。改为**只陈述"里面没有书目录"**这个可确证的事实。
        detail: "书目目录 `" + (library.path ?? "") + "`（书库根下的 novels/）里没有书目录——面板会显示一本书都没有。",
        suggestion: "用 novel_import 把稿件导入（会自动建 novels/<书名>/），或手工在该目录下建书目录再放章节文件。"
      });
    } else if (library.emptyBookCount > 0) {
      const names = (library.books ?? []).filter((b) => b.chapters === 0).map((b) => b.name).join("、");
      issues.push({
        level: "info",
        title: "有 " + library.emptyBookCount + " 个作品目录里没有章节文件",
        detail: "空书目录在 novel_books 里会照常列出来，但打开后没有任何章节。" + (names ? "涉及：" + names : ""),
        suggestion: "把章节文件（.md/.markdown/.txt）放进对应目录，或删掉这个空目录；若你刚导入过，确认导入时选对了源文件夹。"
      });
    }
    if (library.badNameTotal > 0) {
      const rows = (library.badNames ?? []).map((b) => b.book + "/" + b.file).join("、");
      issues.push({
        level: "warn",
        title: "有 " + library.badNameTotal + " 个章节文件名解析不出章号",
        detail: "解析不出章号的章节会被排到书末、且**无法用章号定位**（novel_read chapter=3 读不到它）。文件：" + rows,
        suggestion: "把文件名改成「第01章 标题.md」这类格式（章/回/话/节 均可，支持“第01章”“01-标题”“书名-01-标题”）；或用 novel_import 重新导入这批文件，它会自动按章号改名并避让重号。"
      });
    }
    if (library.shortTotal > 0) {
      const rows = (library.shortChapters ?? []).map((b) => b.book + "/" + b.file + "（" + b.chars + " 字）").join("、");
      issues.push({
        level: "info",
        title: "有 " + library.shortTotal + " 个章节过短（< " + SHORT_CHAPTER_CHARS + " 字）",
        detail: "过短的章（空壳章、只有标题的占位章）会把六维基线与风格指纹拉偏，让后续的风格自检/开写包结论偏保守。文件：" + rows,
        suggestion: "补齐正文；若那是占位或草稿，把它移出 novels/<书名>/ 目录（六维基线只统计该书目录下的章节文件），或先写完再跑风格分析。"
      });
    }
    if (library.unreadableTotal > 0 || library.unreadableBookCount > 0) {
      const rows = (library.unreadableFiles ?? []).map((b) => b.book + "/" + b.file).join("、");
      issues.push({
        level: "warn",
        title: "有 " + (library.unreadableTotal + library.unreadableBookCount) + " 处章节/书目录读不出来",
        detail: "读不出的文件会被各工具静默跳过（字数少算、分析少一章）：" + (rows || "（书目录不可读：" + library.unreadableBookCount + " 个）"),
        suggestion: "检查这些文件的编码（支持 UTF-8/GBK/UTF-16）与文件权限：把编码统一存成 UTF-8，并确认文件没有被别的程序独占（Windows 下常见于网盘同步中）。"
      });
    }
    if (library.partial) {
      issues.push({
        level: "info",
        title: "章节字数统计未覆盖全部章节（读取预算用尽）",
        detail: "本次只读了 " + library.scannedFiles + " 个章节文件就停下了（上限 " + SCAN_MAX_FILES + " 个 / " + Math.round(SCAN_MAX_CHARS / 1024 / 1024) + " MB），书库太大时避免为一次诊断把整库读一遍。",
        suggestion: "无需处理；报告里的“总字数”按已读部分计，看单本字数请用 novel_chapters（它逐章给出准确字数）。"
      });
    }
  }
  if (issues.length === 0) {
    issues.push({ level: "info", title: "未发现异常", detail: "窗口内的调用都正常完成，书库根、数据目录、语义引擎与各开关都没发现问题。", suggestion: "无需处理。" });
  }
  // 展示顺序按级别排（error → warn → info）：报告的第一屏应当是最该动手的那几条。
  // 同级保持原有先后（Array.prototype.sort 在 Node 里稳定）。
  const rank = { error: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3));
}

/**
 * 生成诊断数据（结构化）。`forShare` 语义见 log.js：本函数的输出**总是**基于分享层事件，
 * 因此可以被安全地转述、贴进 issue。
 *
 * @param {object} config 插件配置（用于 root 解析）
 * @param {{book?:string, days?:number, action?:string}} args 工具参数
 * @param {object} exec
 */
export async function buildDiagnosis(config, args = {}, exec = null) {
  const days = Number.isFinite(args.days) && args.days > 0 ? Math.min(90, Math.trunc(args.days)) : 7;
  const book = typeof args.book === "string" && args.book.trim() !== "" ? args.book.trim() : "";
  const action = typeof args.action === "string" && args.action !== "" ? args.action : "report";

  // v6.6.0 修正（**我自己写出的口径分叉，被用户的面板截图抓出**）：
  //
  // 原来这里直接调 `resolveRoot(config, args, exec)`。它按 `args.root → config.root → sessionCwd(exec)` 解析，
  // 而**从不读 `lastRoot`** ✗。诊断路由调用时 `exec = null` → `sessionCwd(null)` 给出**进程的 cwd**，
  // 于是桌面端（cwd = `…\.dsh\profiles\desktop`）的报告会说「书库根可能不对」✗，
  // 而**面板与工具实际用的是 `lastRoot`（= F:\doment，完全正常）** ✗✗
  // —— 同一个插件里两个裁决点，报告与用户看到的东西对不上。这正是本仓库一路在别处严防的口径分叉。
  //
  // 现在与**面板共用同一个裁决点** `resolveUiRootInfo`（它按 `config.root → lastRoot → cwd` 解析，
  // 并会对"不像书库根的根"给出 warning）。显式传入的 `root` 仍然最优先（那是调用方明确要求的）。
  let root;
  let rootSource;
  const explicitRoot = typeof args.root === "string" && args.root.trim() !== "" ? args.root.trim() : "";
  const configuredRoot = typeof config?.root === "string" && config.root.trim() !== "" ? config.root.trim() : "";
  if (explicitRoot !== "") {
    root = explicitRoot;
    rootSource = "调用参数 root";
  } else if (configuredRoot !== "") {
    root = configuredRoot;
    rootSource = "插件配置 config.root";
  } else {
    let info = { root: "", source: "" };
    try { info = resolveUiRootInfo(config, readSentenceStateSync()) ?? info; } catch { /* 状态读不到就走下面的兜底 */ }
    if (typeof info.root === "string" && info.root !== "") {
      root = info.root;
      rootSource = info.source === "lastRoot" ? "lastRoot（宿主记住的书库根）"
        : info.source === "cwd" ? "cwd（会话工作目录兜底）"
        : String(info.source || "未知");
    } else {
      root = resolveRoot(config, args, exec);
      rootSource = "cwd（当前工作目录兜底）";
    }
  }
  const rootLooksOk = looksLikeRoot(root);

  const dataDir = inspectDataDir(root);
  const switches = inspectSwitches(config);
  const stats = logStats();
  const events = await readLogEvents({ days, limit: action === "events" ? 200 : 2000, forShare: true, book: book || void 0 });
  const agg = aggregate(events);
  const engine = inspectEngine(events);
  // 章节体检**总是**做（报告里固定有这一节）：它只 readdir + 读文件取 .length，
  // 且有 SCAN_MAX_* 读取预算兜底，不会为一次诊断把整库读一遍。
  const library = await inspectLibrary(root);
  const lastRoot = switches.lastRoot;
  const rootOut = {
    path: root, source: rootSource, looksLikeLibraryRoot: rootLooksOk,
    // v6.6.0：lastRoot 是"上一次写操作记住的根"，它失效时面板会静默跳过它——必须点名
    lastRoot, lastRootLooksLikeLibraryRoot: lastRoot === "" ? null : looksLikeRoot(lastRoot),
    // 以下都是**书库内容体检**的统计值（书数/章数/字数/命名异常/过短章）——不含任何正文
    booksPath: library.path,
    bookCount: library.bookCount, chapterCount: library.chapterCount, chars: library.chars,
    books: library.books.slice(0, MAX_BOOKS_LISTED), booksListed: Math.min(library.books.length, MAX_BOOKS_LISTED),
    emptyBookCount: library.emptyBookCount, unreadableBookCount: library.unreadableBookCount,
    badNameTotal: library.badNameTotal, shortTotal: library.shortTotal, unreadableTotal: library.unreadableTotal,
    badNames: library.badNames, shortChapters: library.shortChapters, unreadableFiles: library.unreadableFiles,
    scanPartial: library.partial, scannedFiles: library.scannedFiles
  };
  const issues = deriveIssues({ root: rootOut, rootLooksOk, dataDir, calls: agg.calls, stats, book, aggregate: agg, switches, engine, library });

  const checklist = [
    { item: "书库根与目录结构", state: rootLooksOk ? "checked" : "warn", note: rootLooksOk ? "根下存在 novels/ 或 .novel-writer/" : "根下既无 novels/ 也无 .novel-writer/" },
    { item: "书库内容体检（书数/章数/字数/命名）", state: "checked", note: "只统计书数、章数、字数、命名异常与过短章（共 " + library.chapterCount + " 章）；**不读正文内容**，读文件只取 length" + (library.partial ? "；本次读取预算用尽，部分章节字数未计" : "") },
    { item: "插件数据目录体检", state: dataDir.exists ? "checked" : "skipped", note: dataDir.exists ? "体积/文件数 + JSON 可解析性（含 zstd 压缩缓存解压校验）+ 0 字节/超大文件；只读元数据，不读正文" : "目录不存在" },
    { item: "语义引擎（本地 embedding）", state: "checked", note: "只做状态探测（模型文件是否在位、进程中是否已加载、上次错误归类）——**不触发模型加载**，所以“未加载”不等于坏" },
    { item: "开关与状态快照", state: "checked", note: switches.stateFile.exists ? "已读 state.json：被关的工具/功能、总开关、风格容差" : "无 state.json，全部走默认值（首次使用属正常，不是异常）" },
    { item: "近 " + days + " 天事件聚合", state: "checked", note: "按工具/类型/code 聚合，自由文本已在分享层剔除；读数上限 2000 条（事件更多时计数只覆盖最近 2000 条）" },
    { item: "事件原文", state: action === "events" ? "checked" : "off", note: "action=events 才返回明细（仍为分享层，无自由文本）" },
    { item: "章节内容 / 正文", state: "off", note: "本工具不读正文、也不把正文写进任何**离开本机**的内容；但别读成「本机日志里绝不含正文」——本机日志的自由文本至多保留一句（≤160 字），见 lib/log.js 文件头" },
    { item: "并发与性能画像", state: "off", note: "本工具不做压测；只给已记录到的耗时合计（byTool[].msTotal / msAvg）" }
  ];

  const result = {
    action,
    days,
    root: rootOut,
    dataDir: {
      path: dataDir.path, exists: dataDir.exists, bytes: dataDir.bytes, files: dataDir.files, subdirs: dataDir.subdirs.slice(0, 12),
      // v6.6.0：损坏检测。判定口径与 core.js 的 corrupt/corruptFiles 对齐：**文件存在但解析不了 = 损坏**；
      // 文件不存在是另一回事（missingSubdirs）。只读元数据，绝不读章节正文（这里也读不到）。
      expectedSubdirs: dataDir.expectedSubdirs, presentSubdirs: dataDir.presentSubdirs, missingSubdirs: dataDir.missingSubdirs,
      checkedJson: dataDir.checkedJson, nonJsonFiles: dataDir.nonJsonFiles,
      compressedJson: dataDir.compressedJson, compressedSkipped: dataDir.compressedSkipped,
      unreadableTotal: dataDir.unreadableTotal, unreadableFiles: dataDir.unreadableFiles,
      corruptTotal: dataDir.corruptTotal, emptyTotal: dataDir.emptyTotal, oversizedTotal: dataDir.oversizedTotal,
      corruptFiles: dataDir.corruptFiles, emptyFiles: dataDir.emptyFiles, oversizedFiles: dataDir.oversizedFiles
    },
    // `selfCallExcluded` 是一个**契约声明**，不是修饰：本函数的日志读数（events/calls/byTool/logStats）
    // 都是在**本次诊断调用自身那条审计记录落盘之前**取的——审计包装要等 execute 返回后才写。
    // 所以"与磁盘现算比对"的一方必须同样在调用**之前**读盘，或把 novel_diagnose 那条减掉；
    // 否则会差出恰好一条事件的字节数/计数（实测差 196 字节），看起来像 bug 其实是口径。
    log: { dir: stats.dir, bytes: stats.bytes, files: stats.files.length, kinds: LOG_KINDS.length, exists: stats.exists, selfCallExcluded: true },
    calls: agg.calls,
    byTool: agg.byTool,
    byKind: agg.byKind,
    topCodes: agg.topCodes,
    problems: agg.problems,
    issues,
    checklist,
    // v6.6.0：tools 从"两个计数"扩成"能力 + 开关快照"（schema 里 tools 是 additionalProperties:true，
    // 所以这些字段都在已声明的对象里，没有新增顶层键）
    tools: {
      registered: switches.tools.registered,
      enabled: switches.tools.enabled,
      disabled: switches.tools.disabled, disabledCount: switches.tools.disabled.length,
      features: switches.features.effective, disabledFeatures: switches.features.disabled,
      master: switches.master, prompt: switches.prompt, styleTolerance: switches.styleTolerance,
      stateFile: switches.stateFile,
      engine
    }
  };
  if (book) result.book = book;
  if (action === "events") result.events = events.slice(0, 200);
  return result;
}

/**
 * 把诊断数据渲染成中文报告（`novel_diagnose` 的 render 与面板都用它）。
 *
 * 两条渲染约定：
 *   ① **首行格式不变**（`【诊断报告】生成于 <ISO>`）——面板与文档都引用它；
 *   ② 小节号由 `section()` **动态分配**，所以"有没有 events 明细"不会让后面的小节号错位。
 * 报告里只出现元数据：书名/文件名（章名）/状态/计数/字节数/路径/code/固定标签——绝无正文。
 */
export function formatDiagnosis(value) {
  const lines = [];
  const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
  let sec = 0;
  const section = (title) => { lines.push(""); lines.push(CN[sec++] + "、" + title); };
  const pad = (s, n) => String(s ?? "").padEnd(n);
  const kb = (n) => Math.round((n ?? 0) / 1024);

  lines.push("【诊断报告】生成于 " + new Date().toISOString());

  // ---- 一、书库根 ----
  section("书库根");
  lines.push("  " + (value.root?.path ?? "(未知)") + "　来源：" + (value.root?.source ?? "?"));
  lines.push("  " + (value.root?.looksLikeLibraryRoot ? "✓ 结构正常（根下有 novels/ 或 .novel-writer/）" : "✗ 结构不对：根下既没有 novels/ 也没有 .novel-writer/"));
  if (value.root?.lastRoot) {
    lines.push("  lastRoot（上次写操作记住的根）：" + value.root.lastRoot +
      (value.root.lastRootLooksLikeLibraryRoot === false ? "　✗ 已失效（既无 novels/ 也无 .novel-writer/，面板会跳过它）" : "　✓ 可用"));
  }

  // ---- 二、书库内容体检（v6.6.0 新增；只统计，不读正文内容） ----
  section("书库内容体检（只统计，不读正文）");
  const lib = value.root ?? {};
  if ((lib.bookCount ?? 0) === 0) {
    lines.push("  novels/ 下没有作品目录" + (lib.booksPath ? "（" + lib.booksPath + "）" : "") + " —— 面板会显示一本书都没有。");
  } else {
    lines.push("  作品 " + lib.bookCount + " 部　章节 " + (lib.chapterCount ?? 0) + " 个　合计 " + (lib.chars ?? 0) + " 字" +
      (lib.scanPartial ? "（读取预算用尽，字数按已读的 " + (lib.scannedFiles ?? 0) + " 章计）" : ""));
    for (const b of lib.books ?? []) {
      lines.push("    " + pad(b.name, 18) + String(b.chapters).padStart(4) + " 章　" + String(b.chars).padStart(8) + " 字" +
        (b.badNames ? "　命名异常 " + b.badNames : "") + (b.shortChapters ? "　过短 " + b.shortChapters : "") + (b.unreadable ? "　读不出 " + b.unreadable : ""));
    }
    if ((lib.booksListed ?? 0) < (lib.bookCount ?? 0)) lines.push("    （仅列出字数最多的 " + lib.booksListed + " 部）");
  }
  if ((lib.badNameTotal ?? 0) > 0) {
    lines.push("  △ 解析不出章号的章节 " + lib.badNameTotal + " 个（章序排在书末、无法用章号定位）：");
    for (const b of lib.badNames ?? []) lines.push("      " + b.book + "/" + b.file);
    if (lib.badNameTotal > (lib.badNames?.length ?? 0)) lines.push("      …（仅列前 " + (lib.badNames?.length ?? 0) + " 个）");
  }
  if ((lib.shortTotal ?? 0) > 0) {
    lines.push("  · 过短章节（< " + SHORT_CHAPTER_CHARS + " 字，会拉偏六维基线）" + lib.shortTotal + " 个：");
    for (const b of lib.shortChapters ?? []) lines.push("      " + b.book + "/" + b.file + "（" + b.chars + " 字）");
    if (lib.shortTotal > (lib.shortChapters?.length ?? 0)) lines.push("      …（仅列前 " + (lib.shortChapters?.length ?? 0) + " 个）");
  }
  if ((lib.unreadableTotal ?? 0) > 0 || (lib.unreadableBookCount ?? 0) > 0) {
    lines.push("  △ 读不出来的章节 " + (lib.unreadableTotal ?? 0) + " 个、书目录 " + (lib.unreadableBookCount ?? 0) + " 个（会被各工具静默跳过）：");
    for (const b of lib.unreadableFiles ?? []) lines.push("      " + b.book + "/" + b.file);
  }
  if ((lib.emptyBookCount ?? 0) > 0) lines.push("  · 空书目录（无章节文件）" + lib.emptyBookCount + " 个");

  // ---- 三、插件数据目录（含损坏检测） ----
  section("插件数据目录");
  const dd = value.dataDir ?? {};
  if (dd.exists) {
    lines.push("  " + (dd.path ?? "") + "　合计 " + kb(dd.bytes) + " KB / " + (dd.files ?? 0) + " 个文件");
    for (const s of dd.subdirs ?? []) lines.push("    " + pad(s.name, 16) + kb(s.bytes) + " KB / " + s.files + " 个文件");
    if ((dd.missingSubdirs ?? []).length > 0) lines.push("    （尚未创建的子目录：" + dd.missingSubdirs.join("、") + "——用到时才建，属正常）");
    lines.push("  JSON 可解析性检查：已解析 " + (dd.checkedJson ?? 0) + " 个文本 JSON" +
      ((dd.compressedJson ?? 0) > 0 ? "；zstd 压缩缓存 " + dd.compressedJson + " 个" + ((dd.compressedSkipped ?? 0) > 0 ? "（其中 " + dd.compressedSkipped + " 个未解压校验：旧 Node 无 zstd 接口或压缩体 > 2 MB）" : "（已解压校验）") : "") +
      ((dd.nonJsonFiles ?? 0) > 0 ? "；非 .json 文件 " + dd.nonJsonFiles + " 个未解析" : "") +
      ((dd.oversizedTotal ?? 0) > 0 ? "；超大文件 " + dd.oversizedTotal + " 个只记体积、未整读" : ""));
    if ((dd.corruptTotal ?? 0) > 0) {
      lines.push("  ⚠ 损坏 " + dd.corruptTotal + " 个（文件存在但读不出内容：调用方会当成空表，词表类写操作会被拒绝）：");
      for (const f of dd.corruptFiles ?? []) lines.push("      " + f.rel + "（" + kb(f.bytes) + " KB）　原因：" + f.error);
      if (dd.corruptTotal > (dd.corruptFiles?.length ?? 0)) lines.push("      …（仅列前 " + (dd.corruptFiles?.length ?? 0) + " 个）");
    } else {
      lines.push("  ✓ 未发现损坏的缓存/数据文件");
    }
    if ((dd.unreadableTotal ?? 0) > 0) {
      lines.push("  ⚠ 读不出来的文件 " + dd.unreadableTotal + " 个（权限/占用）：" + (dd.unreadableFiles ?? []).map((f) => f.rel).join("、"));
    }
    if ((dd.emptyTotal ?? 0) > 0) {
      lines.push("  ⚠ 0 字节文件 " + dd.emptyTotal + " 个（写入中途被打断，读到会当成空表）：");
      for (const f of dd.emptyFiles ?? []) lines.push("      " + f.rel);
    }
    if ((dd.oversizedTotal ?? 0) > 0) {
      lines.push("  · 超大文件（≥ 8 MB）" + dd.oversizedTotal + " 个：" + (dd.oversizedFiles ?? []).map((f) => f.rel + "（" + kb(f.bytes) + " KB）").join("、"));
    }
  } else {
    lines.push("  （不存在）" + (dd.path ?? ""));
  }

  // ---- 四、语义引擎（v6.6.0 新增） ----
  section("语义引擎（本地 embedding，惰性加载）");
  const eng = value.tools?.engine ?? {};
  const semanticOn = value.tools?.features?.semanticEmbedding !== false;
  lines.push("  开关：本地语义总开关 " + (semanticOn ? "开" : "**关**（features.semanticEmbedding=false：语义检索/语义风格/隐式情绪全部不生效）"));
  lines.push("  模型：" + (eng.model ? eng.model + "　" : "") +
    (eng.modelPresent === false ? "✗ 文件不在位（" + (eng.modelDir ?? "lib/models") + "）" : eng.modelPresent === true ? "✓ 文件在位" : "？ 状态未取到"));
  lines.push("  运行时：" + (eng.loaded ? "✓ 本进程已加载" : "· 本进程尚未加载（首次真正用到时才惰性加载，**不代表坏**）"));
  if (eng.errorCode) lines.push("  ✗ 上次初始化失败：" + eng.errorCode + "（" + eng.errorLabel + "）——已回退纯规则，期间无报错");
  if (eng.lastCacheErrorCode) lines.push("  · 索引缓存上次读写失败：" + eng.lastCacheErrorCode + "（" + eng.lastCacheErrorLabel + "）——缓存写不进去只会让每次调用都重建索引");
  lines.push("  日志里的 engine 类事件：" + (eng.events?.count ?? 0) + " 条" +
    ((eng.events?.codes ?? []).length > 0 ? "（" + eng.events.codes.map((c) => c.code + "×" + c.count).join("　") + "）" : ""));

  // ---- 五、开关与状态（v6.6.0 新增） ----
  section("开关与状态");
  const sw = value.tools ?? {};
  lines.push("  状态文件：" + (sw.stateFile?.path ?? "?") + (sw.stateFile?.exists ? "　✓ 存在" : "　（不存在：全部走默认值）"));
  const lg = value.log ?? {};
  lines.push("  事件日志：" + (lg.exists ? (lg.dir ?? "?") + "　" + (lg.files ?? 0) + " 个文件 / " + kb(lg.bytes) + " KB" : "尚未产生（" + (lg.dir ?? "?") + "）") +
    "（读数不含本次诊断调用自身那条审计记录）");
  lines.push("  工具：" + (sw.registered ?? 0) + " 个注册 / " + (sw.enabled ?? 0) + " 个启用" +
    ((sw.disabledCount ?? 0) > 0 ? "　⚠ 已关闭 " + sw.disabledCount + " 个：" + (sw.disabled ?? []).join("、") : ""));
  const offFeatures = sw.disabledFeatures ?? [];
  lines.push("  功能开关：" + (offFeatures.length > 0 ? "⚠ 已关闭 " + offFeatures.length + " 个：" + offFeatures.join("、") : "全部开启"));
  lines.push("  总开关：句式分析 " + (sw.master?.enabled === false ? "**关**" : "开") + "　自动分析 " + (sw.master?.autoAnalyze === false ? "**关**" : "开") +
    "　提示词档位 " + (sw.prompt?.systemPromptMode ?? "?") + "　场景 " + (sw.prompt?.promptScene ?? "?") + "　精简工作流 " + (sw.prompt?.leanWorkflow ? "开" : "关") +
    "（来源：" + (sw.master?.source ?? "?") + "）");
  const tolKeys = Object.keys(sw.styleTolerance ?? {});
  lines.push("  风格容差：" + (tolKeys.length > 0 ? tolKeys.join("、") + "（共 " + tolKeys.length + " 项自定义）" : "未自定义（用推荐值）"));

  // ---- 六、近期调用 ----
  section("近 " + (value.days ?? 7) + " 天调用");
  const c = value.calls ?? {};
  lines.push("  共 " + (c.total ?? 0) + " 次：正常 " + (c.ok ?? 0) + " / 降级 " + (c.degraded ?? 0) + " / 失败 " + (c.failed ?? 0));
  if ((value.byTool ?? []).length > 0) {
    lines.push("  按工具：");
    for (const r of value.byTool) {
      lines.push("    " + pad(r.tool, 26) + r.total + " 次" + (r.degraded ? "，降级 " + r.degraded : "") + (r.failed ? "，失败 " + r.failed : "") +
        (r.msTotal ? "，合计 " + Math.round(r.msTotal) + " ms" + (r.msAvg ? "（均 " + r.msAvg + " ms）" : "") : ""));
    }
  }
  if ((value.byKind ?? []).length > 0) {
    lines.push("  按类型：" + value.byKind.map((k) => k.kind + "×" + k.count + ((k.codes ?? []).length > 0 ? "(" + k.codes.map((x) => x.code + "×" + x.count).join(",") + ")" : "")).join("　"));
  }
  if ((value.topCodes ?? []).length > 0) lines.push("  高频失败类型：" + value.topCodes.map((k) => (k.code || "(无 code)") + "×" + k.count).join("　"));
  if ((value.problems ?? []).length > 0) {
    lines.push("  反复出问题的组合（工具 × 书名）：");
    for (const p of value.problems) {
      lines.push("    " + pad(p.tool, 26) + (p.book ? "《" + p.book + "》" : "(未指定书)") +
        "　失败 " + p.failed + " / 降级 " + p.degraded +
        (p.chapters && p.chapters.length > 0 ? "　涉及：" + p.chapters.join("、") : ""));
    }
  }

  // ---- 七、问题与建议 ----
  section("问题与建议");
  for (const it of value.issues ?? []) {
    const tag = it.level === "error" ? "⚠ 阻断" : it.level === "warn" ? "△ 注意" : "· 提示";
    lines.push("  " + tag + "｜" + it.title);
    if (it.detail) lines.push("      " + it.detail);
    if (it.suggestion) lines.push("      → " + it.suggestion);
  }

  // ---- 八、事件明细（仅 action=events） ----
  if ((value.events ?? []).length > 0) {
    section("事件明细（分享层：自由文本已剔除）");
    for (const ev of value.events.slice(0, 40)) {
      lines.push("  " + String(ev.ts).slice(11, 19) + "  " + pad(ev.kind, 12) + pad(ev.tool ?? "-", 24) + (ev.status ?? "") + (ev.code ? " " + ev.code : "") + (Number.isFinite(ev.ms) ? " " + ev.ms + "ms" : ""));
    }
  }

  // ---- 末节：本次覆盖与未覆盖 ----
  section("本次覆盖与未覆盖");
  for (const it of value.checklist ?? []) {
    const mark = it.state === "checked" ? "[已查]" : it.state === "warn" ? "[异常]" : it.state === "off" ? "[未查]" : "[跳过]";
    lines.push("  " + mark + " " + it.item + (it.note ? "：" + it.note : ""));
  }
  lines.push("");
  lines.push("说明：本报告只含**元数据**（工具名/书名/章号/状态/耗时/计数），**不含任何正文**——报告走「分享层」，自由文本已整体剔除，可安全贴出。");
  lines.push("注意：本机日志文件（logs/events.jsonl）是**另一层**：它的自由文本字段（错误消息等）经收敛后**至多保留一句（≤160 字）**，因此本机日志里可能出现被错误消息回显的输入片段；该文件**不出本机**。报 bug 请用本报告或面板的「复制诊断包」，**不要**直接附上它。");
  return lines.join("\n");
}

export { LOG_KINDS };
