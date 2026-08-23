/**
 * dsh-novel-writer — 小说写作助手插件（v0.3.0：新增句式模式分析扩展）
 *   - novel_sentence_analysis 句式模式分析（句式分布/排列规律/段落结构/句长节奏/情感曲线/风格指纹）
 *   - novel_sentence_config    句式分析开关（Web GUI 侧边栏「句式分析」面板同步）
 *
 * 一个零第三方依赖的 cordis bundle 插件，为模型提供一套小说写作工具：
 *   - novel_books     列出章节库中的所有作品
 *   - novel_chapters  列出某部作品的章节清单（字数/行数/更新时间）
 *   - novel_read      阅读某个章节（带行号、字数统计、分段读取）
 *   - novel_keywords  确定性提取章节/全书高频关键词（中文词组+英文词）
 *   - novel_new_chapter 创建新章节文件
 *   - novel_sentence_analysis 句式模式分析（v0.3.0）
 *   - novel_sentence_config   句式分析开关（v0.3.0）
 *
 * 章节库约定：<root>/novels/<书名>/第N章.md（或 .txt/.markdown）
 * root 默认取会话工作区（session cwd），可通过插件 config.root 覆盖。
 *
 * 本文件只使用 Node 内置模块，不依赖任何 @deepseek-ai/* 运行时包，
 * 因此作为 file: 链接安装进 profile 后无需任何额外依赖下载。
 *
 * 注意：output.schema 必须使用标准 JSON Schema 子集（required 是对象层的
 * 字符串数组），与 tools.register() 的 assertSupportedJsonSchema 一致。
 */
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { analyzeText, CATEGORY_LABELS, CATEGORY_ORDER, fingerprintSimilarity, styleDiffs } from "./analysis.js";
import { createRequire } from "node:module";
import { checkForUpdate } from "./update-check.js";
import { computeBaseline, computeBaselineFromPerChapter, judgeAgainstBaseline, measureStyleMetrics, METRIC_LABELS, METRIC_ORDER } from "./style-metrics.js";

const require = createRequire(import.meta.url);
// v2.6.5：插件当前版本（更新检查用，自动跟随 package.json）
const PLUGIN_VERSION = require("../package.json").version;
import { computeVibe, semanticStyleDistances } from "./vibe.js";
import { CULTURE_MARKERS, GENRE_MARKERS, THEME_MARKERS, DEFAULT_BANNED_WORDS, SPEECH_STYLE_RULES } from "./lexicons/markers.js";
import { RAW_WRITING_PROMPT, WORKFLOW_TEXT } from "./prompts.js";

// v2.1.0：意象歧义语义裁决——变色龙词（如雨/烛火/火光）无触发语境命中时，
// 把上下文与正/负原型句比余弦，决定方向；仍不确定则保持歧义标记。
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
async function resolveAmbiguousCarriers(implicit, text) {
  const emb = await import("./embedding.js");
  if (!implicit.ambiguous || implicit.ambiguous.length === 0) return implicit;
  let posV = null, negV = null;
  try {
    posV = await emb.embed(VIBE_POS_PROTOTYPES.join("；"));
    negV = await emb.embed(VIBE_NEG_PROTOTYPES.join("；"));
  } catch { return implicit; }
  const resolvedList = [];
  let negAdd = 0, posAdd = 0, stillAmb = 0;
  for (const item of implicit.ambiguous) {
    try {
      const ctxV = await emb.embed(item.ctx);
      const posSim = emb.cosine(ctxV, posV);
      const negSim = emb.cosine(ctxV, negV);
      if (Math.abs(posSim - negSim) >= 0.05) {
        const dir = posSim > negSim ? "pos" : "neg";
        resolvedList.push({ ...item, verdict: dir, posSim: Math.round(posSim * 1000) / 1000, negSim: Math.round(negSim * 1000) / 1000 });
        if (dir === "neg") negAdd += 1; else posAdd += 1;
      } else {
        stillAmb += 1;
        resolvedList.push({ ...item, verdict: "undecided", posSim: Math.round(posSim * 1000) / 1000, negSim: Math.round(negSim * 1000) / 1000 });
      }
    } catch { stillAmb += 1; }
  }
  const oldNeg = implicit.negative ?? 0, oldPos = implicit.positive ?? 0;
  const negAdj = oldNeg + negAdd * 0.5, posAdj = oldPos + posAdd * 0.5;
  const newTotal = negAdj + posAdj;
  return {
    ...implicit,
    negative: newTotal === 0 ? 0 : Math.round((negAdj / newTotal) * 100) / 100,
    positive: newTotal === 0 ? 0 : Math.round((posAdj / newTotal) * 100) / 100,
    ambiguousRatio: newTotal === 0 ? 0 : Math.round((stillAmb / (newTotal + stillAmb)) * 100) / 100,
    ambiguous: stillAmb > 0 ? resolvedList.filter((r) => r.verdict === "undecided") : [],
    resolved: resolvedList.filter((r) => r.verdict !== "undecided")
  };
}
// v2.0.0 本地语义嵌入引擎（bge-small-zh ONNX，懒加载，不可用自动回退）
import * as embedding from "./embedding.js";

const name = "novel-writer";
const inject = ["tools", "systemPrompt"];

const CHAPTER_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
/** 单次 novel_read 返回的最大行数（模型上下文保护）。 */
const READ_LIMIT = 400;
/** 单次 novel_read 返回的最大字符数。 */
const READ_MAX_CHARS = 20000;
/** 文件名里出现的章节序号前缀正则：第01章 / 01 / 01-标题 / 1.标题 等。 */
const LEADING_NUMBER = /^第?(\d+)[章回话]?[\s._\-—]*/;
/** 中文数字字符 → 数值。 */
const CJK_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字（一~九十九，支持 十/百 组合）转阿拉伯数字；无法解析返回 void 0。 */
function cjkToNumber(text) {
  const s = String(text).trim();
  if (s === "") return void 0;
  let total = 0;
  let section = 0;
  let hasUnit = false;
  for (const ch of s) {
    if (ch === "十") {
      total += (section === 0 ? 1 : section) * 10;
      section = 0;
      hasUnit = true;
    } else if (ch === "百") {
      total += (section === 0 ? 1 : section) * 100;
      section = 0;
      hasUnit = true;
    } else if (ch in CJK_DIGITS) {
      section = CJK_DIGITS[ch];
    } else {
      return void 0;
    }
  }
  if (!hasUnit && section === 0) return void 0;
  return total + section;
}

/** 从文件名/章节标识中提取章节序号（阿拉伯或中文数字，可出现在任意位置）；失败返回 void 0。
 *  支持：第25章 / 25章 / 01-标题 / 1.标题 / 第一章 / 第十四章 / 第1话。 */
function parseChapterNumber(name) {
  const stem = String(name).replace(/\.[^.]+$/, "");
  const arabicMark = /第?(\d{1,4})[章回话]/.exec(stem);
  if (arabicMark) return Number(arabicMark[1]);
  const leading = LEADING_NUMBER.exec(stem);
  if (leading) return Number(leading[1]);
  const cjkMark = /第([零一二三四五六七八九十百两]+)[章回话]/.exec(stem);
  if (cjkMark) {
    const n = cjkToNumber(cjkMark[1]);
    if (n !== void 0) return n;
  }
  return void 0;
}

/** 清理章节标题：去掉"第N章/N章"标记、行首序号与常见分隔符。 */
function cleanChapterTitle(stem) {
  return stem
    .replace(/第?(\d{1,4})[章回话]/g, "")
    .replace(/第[零一二三四五六七八九十百两]+[章回话]/g, "")
    .replace(LEADING_NUMBER, "")
    .replace(/[_\-.]+/g, " ")
    .trim();
}

/** 中文虚词/功能字黑名单：不参与关键词统计。 */
const CJK_STOP_CHARS = new Set(
  "的了是在有和就都而于及与或这那之其以被把让向着过也还又但更最很从对为等啊吧呢吗嗯哦呀哈啦么个中上下前后左右来去出进到说想看要会能可没有不".split("")
);
/** 英文停用词。 */
const EN_STOP_WORDS = new Set(
  "the and of to in a an is are was were be been being it its this that these those i you he she they we my your his her their our me him them us as at by for with on from or but not no so if then than when where which who whom what how why all any both each few more most other some such only own same too very just can could will would shall should may might must do does did done have has had having about into over under again further once here there".split(/\s+/)
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function requiredString(args, key) {
  const value = args?.[key];
  assert(typeof value === "string" && value.trim() !== "", `参数 "${key}" 不能为空字符串`);
  return value.trim();
}
function optionalString(args, key) {
  const value = args?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function optionalInt(args, key, min, max, fallback) {
  const value = args?.[key];
  if (value === void 0) return fallback;
  assert(Number.isInteger(value) && value >= min && value <= max, `参数 "${key}" 必须是 ${min} 到 ${max} 之间的整数`);
  return value;
}
/** 清洗书名/章节名，防止路径穿越。 */
function sanitizeSegment(value, label) {
  const cleaned = value.replace(/[\\/]/g, "");
  assert(cleaned.length > 0 && !["", ".", ".."].includes(cleaned), `参数 ${label} 含非法路径字符`);
  return cleaned;
}
function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd();
}
/** 解析章节库根目录：调用级 root 参数 > 插件 config.root > 会话工作区。 */
function resolveRoot(config, args, exec) {
  const override = optionalString(args, "root");
  if (override !== void 0) return override;
  const configured = config?.root;
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
  return sessionCwd(exec);
}
function novelsDir(root) {
  return join(root, "novels");
}
function bookDir(root, book) {
  return join(novelsDir(root), sanitizeSegment(book, "book"));
}
/** 读取一部作品的章节文件列表（按序号排序），返回带元信息的条目。 */
async function scanChapters(bookPath) {
  const entries = await readdir(bookPath, { withFileTypes: true });
  const chapters = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!CHAPTER_EXTENSIONS.has(ext)) continue;
    chapters.push({
      file: entry.name,
      number: parseChapterNumber(entry.name),
      title: cleanChapterTitle(entry.name.slice(0, -ext.length)) || entry.name
    });
  }
  chapters.sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) || a.file.localeCompare(b.file));
  return chapters;
}
/** 读取文本文件并自动探测编码：UTF-8（含 BOM）、UTF-16 LE/BE（含 BOM 或无 BOM 启发式）、GBK/GB18030。
 *  无法识别编码时抛错，提示将文件另存为 UTF-8。仅使用 Node 内置能力（TextDecoder）。 */
async function readTextFile(filePath, exec) {
  const buf = await readFile(filePath, { signal: exec?.signal });
  return decodeTextBuffer(buf, filePath);
}

function decodeTextBuffer(buf, filePath) {
  // 1) BOM 检测
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8"); // UTF-8 BOM
  }
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le"); // UTF-16 LE BOM
    if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2)); // UTF-16 BE BOM
  }
  // 2) 无 BOM：先严格按 UTF-8 解码
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    /* 非 UTF-8，继续尝试 */
  }
  // 3) 0x00 字节分布启发式：高比例且集中在奇/偶位 → UTF-16 LE/BE
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0) {
      if (i % 2 === 0) evenNul += 1;
      else oddNul += 1;
    }
  }
  const nulRatio = (evenNul + oddNul) / Math.max(buf.length, 1);
  if (nulRatio > 0.05) {
    return evenNul >= oddNul
      ? new TextDecoder("utf-16le").decode(buf)
      : new TextDecoder("utf-16be").decode(buf);
  }
  // 4) 中文 Windows 常见的 GBK/GB18030（TextDecoder 原生支持 gbk）
  const gbk = new TextDecoder("gbk").decode(buf);
  if (!gbk.includes("\uFFFD")) return gbk;
  throw new Error(`cannot detect text encoding of "${filePath}": 不是有效的 UTF-8/UTF-16/GBK，请将文件另存为 UTF-8 编码`);
}

async function chapterStats(bookPath, chapter) {
  const info = await stat(join(bookPath, chapter.file));
  const text = await readTextFile(join(bookPath, chapter.file));
  return {
    chars: text.length,
    lines: text.length === 0 ? 0 : text.split(/\r?\n/).length,
    size: info.size,
    updated: info.mtime.toISOString()
  };
}
/** 解析"章节参数"：可以是文件名、章号或标题子串。 */
function findChapter(chapters, chapterArg) {
  const needle = String(chapterArg).trim();
  const asNumber = parseChapterNumber(needle);
  if (asNumber !== void 0) {
    const byNumber = chapters.find((c) => c.number === asNumber);
    if (byNumber) return byNumber;
  }
  const lower = needle.toLowerCase();
  const byFile = chapters.find((c) => c.file.toLowerCase() === lower);
  if (byFile) return byFile;
  const byTitle = chapters.find((c) => c.title.toLowerCase().includes(lower) || c.file.toLowerCase().includes(lower));
  if (byTitle) return byTitle;
  return void 0;
}
/** 简单中文分词：单字频率 + 相邻双字（二元组）频率。 */
function extractKeywords(text, top) {
  const cjkBigrams = new Map();
  const cjkTrigrams = new Map();
  const cjkChars = new Map();
  const enWords = new Map();
  const nameCandidates = new Map();
  const cjkRun = [];
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjkRun.push(ch);
    else if (cjkRun.length > 0) {
      tallyCjkRun(cjkRun, cjkChars, cjkBigrams, cjkTrigrams);
      cjkRun.length = 0;
    }
  }
  if (cjkRun.length > 0) tallyCjkRun(cjkRun, cjkChars, cjkBigrams, cjkTrigrams);
  for (const match of text.toLowerCase().matchAll(/[a-z]{2,}/g)) {
    const word = match[0];
    if (!EN_STOP_WORDS.has(word)) enWords.set(word, (enWords.get(word) ?? 0) + 1);
  }
  // 疑似人名/专名：2~3 字 + 动作/称谓（"露西亚说着""琉璃小姐"）
  const namePatterns = [
    /([\u4e00-\u9fff]{2,3})(?:说|道|问|喊|叫|想|笑|叹|答|喝|骂|念|哭|点头|摇头)/g,
    /([\u4e00-\u9fff]{2,3})(?:小姐|大人|先生|少爷|姑娘|殿下|老师|导师|婆婆|爷爷|奶奶|夫人|老爷|公子|长老|神甫|陛下|殿下|大人|小姐)/g
  ];
  for (const pattern of namePatterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name === "那个" || name === "这个" || name === "什么" || name === "怎么" || name === "自己" || name === "她们" || name === "他们" || name === "你们") continue;
      nameCandidates.set(name, (nameCandidates.get(name) ?? 0) + 1);
    }
  }
  const keywords = [];
  for (const [word, count] of cjkBigrams) {
    if (count > 1) keywords.push({ word, count, kind: "cjk-bigram" });
  }
  for (const [word, count] of cjkTrigrams) {
    if (count > 1) keywords.push({ word, count, kind: "cjk-trigram" });
  }
  for (const [word, count] of nameCandidates) {
    if (count >= 2) keywords.push({ word, count, kind: "name-candidate" });
  }
  for (const [word, count] of enWords) {
    if (count > 1) keywords.push({ word, count, kind: "word" });
  }
  keywords.sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
  return keywords.slice(0, top);
}
function tallyCjkRun(run, cjkChars, cjkBigrams, cjkTrigrams) {
  for (let i = 0; i < run.length; i += 1) {
    const ch = run[i];
    if (!CJK_STOP_CHARS.has(ch)) cjkChars.set(ch, (cjkChars.get(ch) ?? 0) + 1);
    if (i + 1 < run.length) {
      const bigram = run[i] + run[i + 1];
      const meaningful = !CJK_STOP_CHARS.has(run[i]) || !CJK_STOP_CHARS.has(run[i + 1]);
      if (meaningful) cjkBigrams.set(bigram, (cjkBigrams.get(bigram) ?? 0) + 1);
    }
    if (i + 2 < run.length) {
      const trigram = run[i] + run[i + 1] + run[i + 2];
      const nonStop = [run[i], run[i + 1], run[i + 2]].filter((ch) => !CJK_STOP_CHARS.has(ch)).length;
      if (nonStop >= 2) cjkTrigrams.set(trigram, (cjkTrigrams.get(trigram) ?? 0) + 1);
    }
  }
}

// ---- 原稿件导入 / 自动分类（v0.4.0 合并）----

/** 文件名中的噪音词（前缀/独立成段，不构成书名）。 */
const IMPORT_NOISE = new Set(["原稿件", "单章", "调教计划", "未命名", "新建文档", "草稿", "无题", "正文", "手稿"]);

/** 从文件名提取书名候选：去扩展名、章号标记、噪音词与分隔符。失败返回 void 0。 */
function bookNameFromFileName(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const parts = stem
    .replace(/第?(\d{1,4})[章回话]/g, " ")
    .replace(/第[零一二三四五六七八九十百两]+[章回话]/g, " ")
    .replace(LEADING_NUMBER, " ")
    .split(/[\s._\-—~]+/)
    .map((p) => p.trim())
    .filter((p) => p !== "" && !IMPORT_NOISE.has(p));
  const name = parts.join(" ").trim();
  return name === "" ? void 0 : name;
}

/** 从文件头内容提取书名候选：跳过噪音行，只认"含章号标记的标题行"；找不到返回 void 0（该文件落入"未分类"组）。 */
function bookNameFromContent(text) {
  const lines = String(text).split(/\r?\n/).slice(0, 12);
  for (const raw of lines) {
    const line = raw.replace(/^#+\s*/, "").replace(/^\uFEFF/, "").trim();
    if (line === "") continue;
    if (IMPORT_NOISE.has(line)) continue;
    const hasChapterMark = /第?(\d{1,4})[章回话]|第[零一二三四五六七八九十百两]+[章回话]/.test(line);
    if (hasChapterMark) {
      const cleaned = cleanChapterTitle(line);
      if (cleaned !== "") return cleaned;
    }
  }
  return void 0;
}

/** 递归收集 src 下的章节文本文件（相对路径）。 */
async function collectTextFiles(dir, recursive, out = [], prefix = "") {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : prefix + "/" + entry.name;
    if (entry.isDirectory()) {
      if (recursive) await collectTextFiles(join(dir, entry.name), recursive, out, rel);
    } else if (entry.isFile() && CHAPTER_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(rel);
    }
  }
  return out;
}

function formatImport(value) {
  const lines = [`<path>${value.src}</path>`, `<type>novel-import-${value.mode}</type>`, "<content>", ""];
  lines.push(`扫描结果：${value.groups.reduce((n, g) => n + g.files.length, 0)} 个文件 → ${value.groups.length} 组` +
    (value.skipped.length > 0 ? `（跳过 ${value.skipped.length} 个无法读取的文件）` : ""));
  for (const group of value.groups) {
    const from = group.from === "file" ? "文件名" : group.from === "content" ? "文件头内容" : "强制指定";
    lines.push("");
    lines.push(`[${group.book}] (来自${from}, ${group.files.length} 个文件)`);
    for (const f of group.files) {
      const ch = f.chapter === void 0 ? "?" : `第${f.chapter}章`;
      lines.push(`  - ${ch} ${f.file}`);
    }
  }
  if (value.imported.length > 0) {
    lines.push("");
    lines.push(`已导入 ${value.imported.length} 个文件：`);
    for (const item of value.imported) lines.push(`  - novels/${item.book}/${item.file}`);
  }
  lines.push("", "</content>");
  return lines.join("\n");
}

/** novel_import：扫描原稿件文件夹，自动识别书名/章号并分组，可一键导入章节库。 */
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
        root: { type: "string", description: "章节库根目录（含 novels 子目录）。默认取会话工作区。" }
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
                from: { type: "string", enum: ["file", "content", "forced"] },
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
          from = "content";
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
          if (group.book === "未分类") continue;
          const safeBook = sanitizeSegment(group.book, "book");
          const destDir = join(novelsDir(root), safeBook);
          await mkdir(destDir, { recursive: true });
          for (const row of group.files) {
            const srcFull = join(src, row.file);
            const destFull = join(destDir, basename(row.file));
            await copyFile(srcFull, destFull);
            if (move) await rm(srcFull, { force: true });
            imported.push({ book: safeBook, file: basename(row.file), path: destFull });
          }
        }
      }
      return { src, mode, groups, skipped, imported };
    }
  });
}

// ---- 句式模式分析扩展（v0.3.0 起，v0.5.0 合并版）----

/** 句式分析默认配置。 */
const SENTENCE_ANALYSIS_DEFAULTS = Object.freeze({ enabled: true, autoAnalyze: true });

/** v0.7.0：全部工具清单（每个工具都有独立 UI 开关，默认全开）。 */
const ALL_TOOLS = Object.freeze([
  "novel_books", "novel_chapters", "novel_read", "novel_keywords", "novel_new_chapter",
  "novel_import", "novel_sentence_analysis", "novel_sentence_config", "novel_style_check", "novel_plot",
  "novel_settings", "novel_summary", "novel_continuity_check", "novel_semantic_search", "novel_style_report",
  "novel_outline"
]);
const TOOL_LABELS = Object.freeze({
  novel_books: "作品列表", novel_chapters: "章节清单", novel_read: "阅读章节", novel_keywords: "关键词分析",
  novel_new_chapter: "新建章节", novel_import: "稿件导入", novel_sentence_analysis: "句式模式分析",
  novel_sentence_config: "开关配置", novel_style_check: "风格自检", novel_plot: "伏笔登记",
  novel_settings: "设定管理", novel_summary: "章节摘要", novel_continuity_check: "连贯性审计",
  novel_semantic_search: "语义检索", novel_style_report: "风格画像", novel_outline: "创作资料"
});

/** 自动判断文本的文化基准：统计中西词表命中，返回建议与证据。 */
function detectCulture(text) {
  const scores = { western: 0, eastern: 0, modern: 0 };
  const evidence = { western: [], eastern: [], modern: [] };
  for (const [culture, table] of Object.entries(CULTURE_MARKERS)) {
    for (const word of table.words) {
      const n = text.split(word).length - 1;
      if (n > 0) {
        scores[culture] += n;
        if (evidence[culture].length < 8) evidence[culture].push(word + "×" + n);
      }
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
/** v1.0.2 网文流派识别：统计各流派特征词命中，返回主导流派。 */
function detectGenre(text) {
  const hits = {};
  const evidence = {};
  for (const [genre, words] of Object.entries(GENRE_MARKERS)) {
    let count = 0;
    const found = [];
    for (const word of words) {
      const n = text.split(word).length - 1;
      if (n > 0) { count += n; if (found.length < 6) found.push(word + "×" + n); }
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

/** v1.0.2 题材检测：返回主导题材（骨）与副题材。 */
function detectTheme(text) {
  const hits = {};
  const evidence = {};
  for (const [theme, words] of Object.entries(THEME_MARKERS)) {
    let count = 0;
    const found = [];
    for (const word of words) {
      const n = text.split(word).length - 1;
      if (n > 0) { count += n; if (found.length < 6) found.push(word + "×" + n); }
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



/** v1.5.0 功能级开关（默认全开）：emotionCaveat=情感净化预警，genreTheme=题材/流派检测。 */
const FEATURE_DEFAULTS = Object.freeze({ emotionCaveat: true, genreTheme: true, emotionComplexity: true, semanticEmbedding: true, semanticSearch: true, semanticStyle: true, semanticImplicit: true, rawWriting: false });
function featureEnabled(state, name) {
  const features = state?.features ?? {};
  return features[name] !== false;
}

/** v2.0.0 语义隐性情感增强：规则意象表之外，用情感原型句扫全书索引找"词表外疑似意象段落"。 */
async function enrichSemanticImplicit(state, root, book, result, exec) {
  try {
    if (!semanticFeatureEnabled(state, "semanticImplicit")) return result;
    if (!(await embedding.isAvailable())) return result;
    const dir = bookDir(root, book);
    const chapters = await scanChapters(dir);
    const chunks = [];
    for (const chapter of chapters) {
      const text = await readTextFile(join(dir, chapter.file), exec);
      // v2.6.0：章节标记直接用文件名（chunkText 只认"第X章"标题行，无标题行时检索结果无法定位章节）
      for (const p of embedding.chunkText(text)) chunks.push({ ...p, id: chapter.file + "|" + p.id, chapter: chapter.file });
    }
    // v2.5.0 修复轮 4：内容指纹失效重建——章节更新后旧缓存不再命中（不靠版本号）
    // v2.6.0：增量构建——指纹变化时只对新/变化的段落做推理，其余复用旧向量
    const { items: cachedIndex, fp: cachedFp } = embedding.loadIndexMeta(root, book);
    const indexFp = embedding.fingerprint(chunks);
    let index = cachedIndex;
    if (!index || index.length === 0 || cachedFp !== indexFp) {
      index = await embedding.buildIndexIncremental(chunks, cachedIndex);
      embedding.saveIndex(root, book, index, indexFp);
    }
    const implicit = await embedding.detectImplicitEmotions(index);
    if (result.emotion?.quantification) {
      result.emotion.quantification.semanticImplicit = implicit;
    }
  } catch { /* 语义增强失败不影响规则结果 */ }
  return result;
}

/** v2.0.0 语义子开关：总开关 semanticEmbedding 关闭时子开关一律无效。 */
function semanticFeatureEnabled(state, name) {
  if (!featureEnabled(state, "semanticEmbedding")) return false;
  return featureEnabled(state, name);
}

function cropEmotion(emotion) {
  if (!emotion) return emotion;
  return {
    dominant: emotion.dominant,
    scores: emotion.scores,
    intensity: emotion.intensity,
    topWords: emotion.topWords,
    curve: emotion.curve
  };
}

/** 工具级开关是否开启（默认开；state.tools[name] === false 时关闭）。 */
function toolEnabled(state, name) {
  const tools = state?.tools ?? {};
  return tools[name] !== false;
}
/** 断言工具开关：关闭时抛出明确提示（模型可见）。 */
async function assertToolEnabled(config, name) {
  const state = await readSentenceState();
  assert(toolEnabled(state, name), `工具 ${name}（${TOOL_LABELS[name] ?? name}）当前已在「写作助手功能」UI 中关闭。可用 novel_sentence_config 或侧边栏面板重新开启。`);
}

/** 运行时状态文件路径（Web GUI 侧边栏「句式分析」开关落盘位置）。 */
function stateFilePath() {
  return join(homedir(), ".dsh", "dsh-novel-writer", "state.json");
}

/**
 * v0.4.0 兼容的持久化文件（$DSH_HOME/novel-writer.json，stylePattern 键）。
 * 合并版只读兼容它：老用户用 v0.4.0 设置过 stylePattern=true 时同样视为开启。
 */
function styleConfigPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "novel-writer.json");
}
/** 读取兼容文件中的 stylePattern 开关（true = 开启；缺失/损坏 = 关）。 */
function readStyleEnabled() {
  try {
    if (!existsSync(styleConfigPath())) return false;
    const parsed = JSON.parse(readFileSync(styleConfigPath(), "utf8"));
    return parsed?.stylePattern === true;
  } catch {
    return false;
  }
}

/** 读取 UI 开关状态；返回 { exists, enabled, autoAnalyze }（exists=false 表示从未设置过）。 */
async function readSentenceState() {
  try {
    const file = stateFilePath();
    if (!existsSync(file)) {
      return { exists: false, ...SENTENCE_ANALYSIS_DEFAULTS };
    }
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return {
      exists: true,
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : SENTENCE_ANALYSIS_DEFAULTS.enabled,
      autoAnalyze: typeof parsed.autoAnalyze === "boolean" ? parsed.autoAnalyze : SENTENCE_ANALYSIS_DEFAULTS.autoAnalyze,
      tools: parsed.tools !== null && typeof parsed.tools === "object" ? parsed.tools : {},
      features: parsed.features !== null && typeof parsed.features === "object" ? parsed.features : {},
      // v3.0.0：风格基线容差（±%：用户允许低于/高于基线的范围）
      styleTolerance: parsed.styleTolerance !== null && typeof parsed.styleTolerance === "object" ? parsed.styleTolerance : null,
      // v3.1.0：原创模式设定（用户填写的创作意图，留空项=让模型自行设定）
      creationProfile: parsed.creationProfile !== null && typeof parsed.creationProfile === "object" ? parsed.creationProfile : null,
      // v3.1.0：按书专属设定（书名为键；无该书时回退全局 creationProfile）
      creationProfiles: parsed.creationProfiles !== null && typeof parsed.creationProfiles === "object" ? parsed.creationProfiles : {},
      lastRoot: typeof parsed.lastRoot === "string" ? parsed.lastRoot : void 0
    };
  } catch {
    return { exists: false, ...SENTENCE_ANALYSIS_DEFAULTS };
  }
}

/** 写入 UI 开关状态（局部合并）。 */
/** 同步读取 state（供 systemPrompt 动态 section 用——组装提示词时是同步调用）。 */
function readSentenceStateSync() {
  try {
    const file = stateFilePath();
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      enabled: parsed.enabled !== false,
      autoAnalyze: parsed.autoAnalyze !== false,
      tools: parsed.tools !== null && typeof parsed.tools === "object" ? parsed.tools : {},
      features: parsed.features !== null && typeof parsed.features === "object" ? parsed.features : {},
      // v3.1.0：原创模式设定（同步版，供 novel_outline 预填）
      creationProfile: parsed.creationProfile !== null && typeof parsed.creationProfile === "object" ? parsed.creationProfile : null,
      // v3.1.0：按书专属设定（书名为键；无该书时回退全局 creationProfile）
      creationProfiles: parsed.creationProfiles !== null && typeof parsed.creationProfiles === "object" ? parsed.creationProfiles : {},
      lastRoot: typeof parsed.lastRoot === "string" ? parsed.lastRoot : void 0
    };
  } catch { return {}; }
}

async function writeSentenceState(patch) {
  const current = await readSentenceState();
  const next = {
    ...current,
    ...(typeof patch?.enabled === "boolean" ? { enabled: patch.enabled } : {}),
    ...(typeof patch?.autoAnalyze === "boolean" ? { autoAnalyze: patch.autoAnalyze } : {}),
    ...(patch?.tools !== null && typeof patch?.tools === "object" ? { tools: { ...(current.tools ?? {}), ...patch.tools } } : {}),
    ...(typeof patch?.lastRoot === "string" ? { lastRoot: patch.lastRoot } : {}),
    ...(patch?.features !== null && typeof patch?.features === "object" ? { features: { ...(current.features ?? {}), ...patch.features } } : {}),
    ...(patch?.styleTolerance !== null && typeof patch?.styleTolerance === "object" ? { styleTolerance: patch.styleTolerance } : {}),
    ...(patch?.styleTolerance === null ? { styleTolerance: null } : {}),
    ...(patch?.creationProfile !== null && typeof patch?.creationProfile === "object" ? { creationProfile: patch.creationProfile } : {}),
    ...(patch?.creationProfile === null ? { creationProfile: null } : {}),
    ...(patch?.creationProfiles !== null && typeof patch?.creationProfiles === "object" ? { creationProfiles: (function (merged) { for (const k of Object.keys(merged)) if (merged[k] === null || merged[k] === void 0) delete merged[k]; return merged; })({ ...(current.creationProfiles ?? {}), ...patch.creationProfiles }) } : {}),
    ...(patch?.creationProfiles === null ? { creationProfiles: {} } : {})
  };
  const file = stateFilePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/**
 * 生效配置优先级：
 *   state 文件（UI 开关）> v0.4.0 兼容文件 novel-writer.json > 插件 config > 默认开启。
 * 默认开启（延续 v0.3.0；提示词内含"僵硬时优先自然表达"风险约束）。
 */
function effectiveSentenceAnalysis(config, state) {
  const configured = config?.sentenceAnalysis ?? {};
  const styleFileOn = readStyleEnabled();
  const enabled = state?.exists === true
    ? (state.enabled ?? SENTENCE_ANALYSIS_DEFAULTS.enabled)
    : (styleFileOn ? true : configured.enabled ?? configured.stylePattern ?? SENTENCE_ANALYSIS_DEFAULTS.enabled);
  const autoAnalyze = state?.exists === true
    ? (state.autoAnalyze ?? SENTENCE_ANALYSIS_DEFAULTS.autoAnalyze)
    : (configured.autoAnalyze ?? SENTENCE_ANALYSIS_DEFAULTS.autoAnalyze);
  return { enabled, autoAnalyze };
}

/** 仅回环地址 + 同源标记的请求围栏（与官方配对路由一致）。 */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = request.headers?.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try { hostUrl = new URL(`http://${host}`); } catch { return false; }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (request.headers?.["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers?.origin;
  if (origin === void 0) return true;
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}

/**
 * 请求放行判定：loopback 总是放行；allowLan=true 时额外放行同源局域网请求
 * （仅校验 Host 与 origin 主机一致 + 非 cross-site）。
 */
function isAllowedRequest(request, allowLan) {
  if (isLoopbackRequest(request)) return true;
  if (allowLan !== true) return false;
  const host = request.headers?.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try { hostUrl = new URL(`http://${host}`); } catch { return false; }
  if (request.headers?.["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers?.origin;
  if (origin === void 0) return true;
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}

/** 写一个 JSON 响应。 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

/** 读取 JSON 请求体（上限 16KB）。 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) return void 0;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return void 0; }
}

/** 打开系统文件管理器定位到某目录（Windows: explorer /select）。 */
function openInExplorer(dir) {
  if (process.platform === "win32") {
    // v2.0.0 修复3：多方式尝试，保证在宿主环境能弹出资源管理器
    const ways = [
      // 方式1：cmd start（explorer 直接调用返回 code 1，必须经 start）
      (cb) => execFile("cmd", ["/c", "start", "", "explorer", "/select," + dir], cb),
      // 方式2：explorer 直接（部分环境可行）
      (cb) => execFile("explorer.exe", ["/select," + dir], cb),
      // 方式3：powershell Start-Process（最稳）
      (cb) => execFile("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", "Start-Process explorer.exe -ArgumentList '/select,\"" + dir + "\"'" ], cb)
    ];
    let attempt = 0;
    const next = () => {
      if (attempt >= ways.length) return;
      const way = ways[attempt++];
      try {
        way((err) => { if (err) next(); });
      } catch { next(); }
    };
    next();
  } else if (process.platform === "darwin") {
    execFile("open", [dir], () => {});
  } else {
    execFile("xdg-open", [dir], () => {});
  }
}

/** /api/dsh-novel-writer/state 路由：GET 读开关，POST 写开关；/reveal 打开文件夹。 */
function makeStateRoutes(allowLan, config) {
  const routePath = "/api/dsh-novel-writer/state";
  const revealPath = "/api/dsh-novel-writer/reveal";
  const handler = async (req, res) => {
    if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
    const method = req.method ?? "GET";
    if (method === "GET") {
      const state = await readSentenceState();
      // v0.8.0：修复 cordis 注入空字符串 root 时 ?? 不生效的问题
      const root = (typeof config?.root === "string" && config.root.length > 0) ? config.root : state.lastRoot;
      const dataDir = typeof root === "string" && root.length > 0 ? novelDataDir(root) : "";
      // v2.6.0：数据目录占用 + 语义引擎状态（status() 只探测文件、不触发模型加载）
      let dataDirSize = 0;
      try {
        if (dataDir !== "" && existsSync(dataDir)) {
          const walk = (d) => { let s = 0; for (const e of readdirSync(d, { withFileTypes: true })) { const fp = join(d, e.name); s += e.isDirectory() ? walk(fp) : statSync(fp).size; } return s; };
          dataDirSize = walk(dataDir);
        }
      } catch { /* 统计失败返回 0 */ }
      let embeddingStatus = null;
      try {
        const emb = await import("./embedding.js");
        embeddingStatus = emb.status ? emb.status() : null;
      } catch { /* 状态不可用 */ }
      return writeJson(res, 200, {
        enabled: state.enabled,
        autoAnalyze: state.autoAnalyze,
        tools: state.tools ?? {},
        features: state.features ?? {},
        // v3.0.0：风格基线容差（±%）
        styleTolerance: state.styleTolerance ?? null,
        // v3.1.0：原创模式设定
        creationProfile: state.creationProfile ?? null,
        // v3.1.0：按书专属设定
        creationProfiles: state.creationProfiles ?? {},
        // v3.1.0：书列表（原创模式设定库用）——novels 目录 ∪ 已预配置设定的书（含未建目录的新书）
        books: [...new Set([...(await listBookNames(root)), ...Object.keys(state.creationProfiles ?? {})])].sort(function (a, b) { return a.localeCompare(b, "zh"); }),
        dataDirSize,
        embeddingStatus,
        dataDir,
        plotsDir: dataDir !== "" ? join(dataDir, "plots") : "",
        dirs: dataDir !== "" ? {
          dataDir,
          plotsDir: join(dataDir, "plots"),
          settingsDir: join(dataDir, "settings"),
          summariesDir: join(dataDir, "summaries"),
          analysisDir: join(dataDir, "analysis"),
          auditsDir: join(dataDir, "audits"),
          embeddingDir: join(dataDir, "embedding"),
          stateFile: stateFilePath()
        } : null,
        file: stateFilePath()
      });
    }
    if (method === "POST") {
      const body = await readJsonBody(req);
      if (body === void 0 || typeof body !== "object" || Array.isArray(body)) return writeJson(res, 400, { error: "invalid JSON body" });
      try {
        const next = await writeSentenceState(body);
        // v3.1.0：保存设定 → 同步创建/更新该书创作资料（有书库根时；文件写失败不影响设定保存）
        const cpRoot = (typeof config?.root === "string" && config.root.length > 0) ? config.root : (next.lastRoot || null);
        if (cpRoot) await syncCreationProfileFiles(cpRoot, body?.creationProfiles, next.creationProfiles);
        return writeJson(res, 200, { ...next, file: stateFilePath() });
      } catch (error) {
        return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return writeJson(res, 405, { error: `method not allowed: ${method}` });
  };
  const revealHandler = async (req, res) => {
    if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
    if ((req.method ?? "GET") !== "POST") return writeJson(res, 405, { error: "method not allowed" });
    const body = await readJsonBody(req);
    const target = body?.target;
    const allowedTargets = ["data-dir", "plots-dir", "settings-dir", "summaries-dir", "analysis-dir", "audits-dir", "embedding-dir", "state-file"];
    if (!allowedTargets.includes(target)) return writeJson(res, 400, { error: 'unknown target (allowed: ' + allowedTargets.join(", ") + ')' });
    const state = await readSentenceState();
    // v0.8.0：空字符串 root 回退 lastRoot
    const root = (typeof config?.root === "string" && config.root.length > 0) ? config.root : state.lastRoot;
    if (typeof root !== "string" || root.length === 0) {
      return writeJson(res, 404, { error: "书库根未知：先在对话中调用一次 novel_plot / novel_settings（或配置插件 root），即可在 UI 中打开数据文件夹。" });
    }
    const dataDir = novelDataDir(root);
    const targetDir = {
      "data-dir": dataDir,
      "plots-dir": join(dataDir, "plots"),
      "settings-dir": join(dataDir, "settings"),
      "summaries-dir": join(dataDir, "summaries"),
      "analysis-dir": join(dataDir, "analysis"),
      "audits-dir": join(dataDir, "audits"),
      "embedding-dir": join(dataDir, "embedding"),
      "state-file": stateFilePath()
    }[target];
    const dir = target === "state-file" ? dirname(targetDir) : targetDir;
    try {
      await mkdir(dir, { recursive: true });
    } catch { /* 目录已存在或创建失败都不阻塞打开 */ }
    try {
      openInExplorer(dir);
      return writeJson(res, 200, { ok: true, path: dir });
    } catch (error) {
      return writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  // v2.6.5：更新检查路由（GitHub Releases API + 24h 缓存 + 3s 超时，全程静默）
  const updateCheckHandler = async (req, res) => {
    if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
    const result = await checkForUpdate(PLUGIN_VERSION, join(homedir(), ".dsh", "dsh-novel-writer"));
    return writeJson(res, 200, result);
  };
  return [
    { kind: "exact", path: routePath, handler },
    { kind: "exact", path: revealPath, handler: revealHandler },
    { kind: "exact", path: "/api/dsh-novel-writer/update-check", handler: updateCheckHandler }
  ];
}

/**
 * 注册 UI 开关状态路由。用可选注入 ctx.inject(["webServer"])：
 * headless 等没有 webServer 服务的 profile 自动跳过，不会导致插件加载失败。
 */
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

/** 句式类型短码（渲染用）。 */
const TYPE_CODE = { statement: "陈述", environment: "环境", psychology: "心理", dialogue: "对话", question: "疑问", "rhetoric-question": "反问", exclamation: "感叹", imperative: "祈使", ellipsis: "省略" };
const EMOTION_CODE = { joy: "喜", anger: "怒", sorrow: "哀", fear: "惧", surprise: "惊", neutral: "中性" };

function formatSentenceAnalysis(value) {
  if (value.enabled === false) {
    return `<path>novels/${value.book}</path>
<type>novel-sentence-analysis</type>
<content>
句式模式分析已关闭（${value.scope}，共 ${value.totalChars} 字）。
${value.message ?? ""}
（可用 novel_sentence_config 查看/开启）
</content>`;
  }
  const lines = [`<path>novels/${value.book}</path>`, "<type>novel-sentence-analysis</type>", "<content>", `统计范围: ${value.scope} (共 ${value.totalChars} 字 / ${value.totalSentences} 句)`, ""];
  lines.push("【句式分布】");
  for (const category of value.categories) {
    lines.push(`- ${category.label} ${(category.ratio * 100).toFixed(1)}% (${category.count} 句, 均长 ${category.avgLength})`);
  }
  lines.push("", "【句式排列】");
  const topTransitions = value.transitions.slice(0, 8).map((t) => `${TYPE_CODE[t.from] ?? t.from}→${TYPE_CODE[t.to] ?? t.to} ×${t.count}`).join("  ");
  lines.push(`- 高频转移: ${topTransitions || "-"}`);
  const topMotifs = value.motifs.slice(0, 5).map((m) => `${m.pattern.split("→").map((code) => TYPE_CODE[code] ?? code).join("→")} ×${m.count}`).join("  ");
  lines.push(`- 句式模板: ${topMotifs || "-"}`);
  lines.push(`- 段落: ${value.paragraphs.total} 段, 均 ${value.paragraphs.avgSentences} 句/段; 纯对话段 ${value.paragraphs.dialogueOnly}, 纯心理段 ${value.paragraphs.psychologyOnly}, 混合段 ${value.paragraphs.mixed}, 对话连珠 ${value.paragraphs.exchanges}`);
  const opening = value.paragraphs.opening.slice(0, 4).map((o) => `${TYPE_CODE[o.type] ?? o.type}×${o.count}`).join(" ");
  const closing = value.paragraphs.closing.slice(0, 4).map((o) => `${TYPE_CODE[o.type] ?? o.type}×${o.count}`).join(" ");
  lines.push(`- 段首句式: ${opening || "-"}; 段尾句式: ${closing || "-"}`);
  if (value.chapterPatterns && value.chapterPatterns.length > 0) {
    lines.push(`- 章节节奏（压缩序列 S=陈述 ENV=环境 PSY=心理 DLG=对话 Q=疑问 RQ=反问 EX=感叹 IMP=祈使 …=省略）:`);
    for (const item of value.chapterPatterns.slice(0, 12)) lines.push(`  ${item.chapter}: ${item.sequence}`);
  }
  lines.push("", "【句长与风格】");
  lines.push(`- 均长 ${value.lengths.avg}, 中位 ${value.lengths.median}; 短句 ${(value.lengths.shortRatio * 100).toFixed(1)}%, 长句 ${(value.lengths.longRatio * 100).toFixed(1)}%`);
  lines.push(`- 对话占比 ${(value.style.dialogueRatio * 100).toFixed(1)}%, 心理占比 ${(value.style.psychologyRatio * 100).toFixed(1)}%, 环境占比 ${(value.style.environmentRatio * 100).toFixed(1)}%, 反问+疑问 ${(value.style.questionRatio * 100).toFixed(1)}%, 感叹 ${(value.style.exclamationRatio * 100).toFixed(1)}%`);
  lines.push(`- 主观性指数 ${value.style.subjectivityIndex}/100, 情感密度 ${value.style.emotionDensity}/千字, 第一人称密度 ${value.style.firstPersonDensity}/千字`);
  lines.push("", "【主观情感】");
  lines.push(`- 主导情绪: ${EMOTION_CODE[value.emotion.dominant] ?? value.emotion.dominant} (强度 ${value.emotion.intensity}/千字)`);
  const emoWords = value.emotion.scores.filter((s) => s.count > 0).map((s) => `${EMOTION_CODE[s.emotion] ?? s.emotion}:${s.count}`).join(" ");
  lines.push(`- 情绪分布: ${emoWords || "无明显情绪词"}`);
  const curve = value.emotion.curve.map((point) => `${point.segment}:${EMOTION_CODE[point.dominant] ?? point.dominant}${point.intensity}`).join(" ");
  lines.push(`- 情感曲线: ${curve || "-"}`);
  lines.push("", "【节奏建议】");
  if (value.guidance) {
    for (const line of value.guidance.split("\n")) lines.push(`- ${line}`);
  }
  lines.push("", "【风格指纹】");
  lines.push(`- ${value.fingerprint}`);
  lines.push("", "【AI 解读提示】");
  lines.push("结合上述统计与 novel_keywords 词汇偏好，说明作者的句式习惯（对话/心理/环境驱动、长短句节奏、反问或感叹的修辞倾向）、");
  lines.push("句式排列规律（如“对话→陈述→心理”循环）与主观情感倾向，并给出具体例证。");
  lines.push("注意：句式模式是参考节奏而非模板套用——若机械复刻导致僵硬必须优先自然表达。");
  lines.push("", "</content>");
  return lines.join("\n");
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
        root: { type: "string", description: "章节库根目录。默认取会话工作区。" }
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
      let text = "";
      const chapterTexts = [];
      const scopeKeyParts = [];
      for (const chapter of selected) {
        const chapterText = await readTextFile(join(dir, chapter.file), exec);
        text += chapterText;
        if (chapterArg === void 0) chapterTexts.push({ chapter: chapter.file, text: chapterText });
        try {
          const info = await stat(join(dir, chapter.file));
          scopeKeyParts.push(chapter.file + ":" + info.mtimeMs + ":" + info.size);
        } catch {
          scopeKeyParts.push(chapter.file + ":?:?");
        }
      }
      if (!effective.enabled) {
        return {
          book,
          scope,
          enabled: false,
          totalChars: text.length,
          totalSentences: 0,
          message: "句式模式分析当前已关闭。可在 Web GUI 侧边栏「句式分析」面板开启，或用 novel_sentence_config 设置 enabled=true。"
        };
      }
      // v0.8.0：分析结果缓存 + 报告导出（书库统一数据目录 <root>/.novel-writer/analysis）
      const cacheDir = join(novelDataDir(root), "analysis");
      const cacheKey = createHash("sha1").update(book + "|" + scope + "|" + scopeKeyParts.join(",")).digest("hex").slice(0, 20);
      const reportFile = join(cacheDir, book + "-" + cacheKey + ".json");
      if (!fresh) {
        try {
          const cached = JSON.parse(await readFile(reportFile, "utf8"));
          if (!featureEnabled(state, "emotionCaveat") && cached.emotion) {
            cached.emotion = cropEmotion(cached.emotion);
          }
          if (!featureEnabled(state, "emotionComplexity") && cached.emotion?.quantification) {
            delete cached.emotion.quantification;
          }
          await enrichSemanticImplicit(state, root, book, cached, exec);
          return { ...cached, book, scope, cache: "hit", reportFile, cachedAt: cached.cachedAt ?? new Date().toISOString() };
        } catch { /* 缓存缺失/损坏，重新分析 */ }
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
          const resolved = await resolveAmbiguousCarriers(implicit, text);
          if (resolved) result.emotion.quantification.implicit = resolved;
        }
      } catch { /* 语义裁决失败不阻塞 */ }
      try {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(reportFile, JSON.stringify({ ...result, cachedAt: new Date().toISOString() }, null, 2), "utf8");
      } catch { /* 缓存写失败不影响结果 */ }
      if (!featureEnabled(state, "emotionCaveat") && result.emotion) {
        result.emotion = cropEmotion(result.emotion);
      }
      if (!featureEnabled(state, "emotionComplexity") && result.emotion?.quantification) {
        delete result.emotion.quantification;
      }
      await enrichSemanticImplicit(state, root, book, result, exec);
      return { ...result, cache: "miss", reportFile, cachedAt: new Date().toISOString() };
    }
  });
}

function registerNovelSentenceConfig(ctx, config) {
  ctx.tools.register({
    name: "novel_sentence_config",
    description: "查看或修改句式模式分析的开关状态：enabled（分析功能是否可用）、autoAnalyze（分析作品时是否主动使用）。GUI 开关位于 Web 侧边栏「句式分析」面板，本工具与其同步。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"], description: "get=查看（默认）；set=修改。" },
        enabled: { type: "boolean", description: "set 时指定：写作助手功能总开关。" },
        autoAnalyze: { type: "boolean", description: "set 时指定：分析作品时是否主动使用句式分析。" },
        tools: { type: "object", additionalProperties: true, description: "set 时指定：各工具开关（如 { novel_plot: false }），键必须是 novel_* 工具名。" },
        features: { type: "object", additionalProperties: true, description: "set 时指定：功能开关（emotionCaveat=情感净化预警 / genreTheme=题材与流派检测），如 { emotionCaveat: false }。" },
        styleTolerance: { type: "object", additionalProperties: true, description: "风格基线容差（每维 { low: -20, high: 20 }，low 为负/高为正；传空对象 {} 清除恢复推荐）。" },
        creationProfile: { type: "object", additionalProperties: true, description: "原创模式设定（worldview/characters/forbidden/mainConflict/genre/extra 字符串键，留空项省略；传空对象 {} 清除全部交给模型）。" },
        creationProfiles: { type: "object", additionalProperties: true, description: "按书专属原创设定（键=书名，值=同上结构；传空对象 {} 清除全部书的专属设定）。" }
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
          styleTolerance: { type: "object", additionalProperties: true, description: "风格基线容差（用户自定义 ±%；空对象=使用推荐）。" },
          creationProfile: { type: "object", additionalProperties: true, description: "原创模式设定（用户在侧边栏填写的创作意图；空对象=未设置）。" }
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
      const effective = effectiveSentenceAnalysis(config, state);
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
          if (Object.keys(toolsPatch).length > 0) patch.tools = toolsPatch;
        }
        if (args?.features !== null && typeof args?.features === "object") {
          const featPatch = {};
          for (const name of ["emotionCaveat", "genreTheme", "emotionComplexity", "semanticEmbedding", "semanticSearch", "semanticStyle", "semanticImplicit", "rawWriting"]) {
            if (typeof args.features[name] === "boolean") featPatch[name] = args.features[name];
          }
          if (Object.keys(featPatch).length > 0) patch.features = featPatch;
        }
        // v3.0.0：风格基线容差（±%：允许低于/高于基线的百分比；null 清除恢复默认）
        if (args?.styleTolerance !== void 0) {
          if (args.styleTolerance === null) patch.styleTolerance = null;
          // v3.1.0：空对象 {} = 清除（DSH schema 不支持 type 数组/剥离 null，空 object 是合规的“传了但清空”）
          else if (args.styleTolerance !== null && typeof args.styleTolerance === "object" && Object.keys(args.styleTolerance).length === 0) patch.styleTolerance = null;
          else if (args.styleTolerance !== null && typeof args.styleTolerance === "object") patch.styleTolerance = args.styleTolerance;
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
      const source = current?.exists === true
        ? "state 文件（GUI 开关）"
        : (styleFileOn ? "v0.4.0 兼容文件 novel-writer.json" : (config?.sentenceAnalysis || config?.stylePattern ? "插件 config" : "默认值"));
      const tools = {};
      for (const name of ALL_TOOLS) tools[name] = toolEnabled(current, name);
      const features = {};
      for (const name of Object.keys(FEATURE_DEFAULTS)) features[name] = featureEnabled(current, name);
      // v3.0.0：风格基线容差（±%）
      const styleTolerance = current?.styleTolerance !== null && typeof current?.styleTolerance === "object" ? current.styleTolerance : null;
      // v3.1.0：原创模式设定
      const creationProfile = current?.creationProfile !== null && typeof current?.creationProfile === "object" ? current.creationProfile : null;
      const creationProfiles = current?.creationProfiles !== null && typeof current?.creationProfiles === "object" ? current.creationProfiles : {};
      // v2.0.0：语义引擎状态（懒探测——不加载模型，仅文件检查 + 已加载状态）
      const embStatus = embedding.status();
      const embAvailable = featureEnabled(current, "semanticEmbedding") ? (embStatus.loaded || embStatus.modelPresent) : false;
      const embError = featureEnabled(current, "semanticEmbedding") ? embStatus.error ?? "" : "semanticEmbedding 已关闭";
      return { file: stateFilePath(), enabled: after.enabled, autoAnalyze: after.autoAnalyze, source, updated, tools, features, styleTolerance, creationProfile, creationProfiles, embedding: { available: embAvailable, loaded: embStatus.loaded, error: embError } };
    }
  });
}


/** v0.6.0 风格自检：某章节 vs 全书其余章节的指纹对比。 */
function registerNovelStyleCheck(ctx, config) {
  ctx.tools.register({
    name: "novel_style_check",
    description: "风格自检：对比某章节与全书其他章节的风格指纹（句式分布/句长/情绪），输出相似度与偏差清单，用于检查续写是否偏离作者文风。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名。" },
        chapter: { type: "string", description: "要检查的章节（章号/文件名/标题）。" },
        root: { type: "string", description: "章节库根目录。默认取会话工作区。" }
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
          metric: { type: "object", additionalProperties: true }
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
      const baseline = (await bookAnalysisCached(root, book + "__base_" + target.file, baselineText, null)).analysis;
      const chapter = analyzeText(targetText, {});
      const similarity = fingerprintSimilarity(baseline, chapter);
      const diffs = styleDiffs(baseline, chapter);
      const verdict = similarity >= 0.9 ? "high" : similarity >= 0.75 ? "medium" : "low";
      let advice = "";
      if (diffs.length === 0) {
        advice = "本章与全书风格高度一致，可以放心续写。";
      } else {
        advice = "续写时建议注意：" + diffs.slice(0, 4).map((d) => d.dimension + (d.note === "偏高" ? "略多" : "略少")).join("、") + "。若为情节需要（如章节情绪转折），可接受适度偏离，但不要持续漂移。";
      }
      // v2.0.0：语义级风格对比（本地 embedding，可选增强；开关开且模型可用时生效）
      let semantic = null;
      const scState = await readSentenceState();
      if (semanticFeatureEnabled(scState, "semanticStyle") && (await embedding.isAvailable())) {
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
            embedding.saveIndex(root, styleCacheKey, index, indexFp);
          }
          // 目标章段落向量 vs 其他章段落向量，平均余弦作为语义风格相似度
          const targetChunks = allChunks.filter((ch) => ch.id.startsWith("0|"));
          const baseChunks = allChunks.filter((ch) => !ch.id.startsWith("0|"));
          const targetVecs = index.filter((it) => targetChunks.some((tc) => tc.id === it.id));
          const baseVecs = index.filter((it) => baseChunks.some((bc) => bc.id === it.id));
          if (targetVecs.length > 0 && baseVecs.length > 0) {
            let sum = 0, count = 0;
            for (const tv of targetVecs) {
              for (const bv of baseVecs.slice(0, 20)) { sum += embedding.cosine(tv.vec, bv.vec); count += 1; }
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
      return {
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
        advice
      };
    }
  });
}

/** v3.1.0：保存设定时同步创作资料——设定库的书自动创建 novels/创作资料/<书>/创作设定.md（含【用户原创设定】段）；删除设定则移除段。文件写失败不影响设定保存。 */
async function syncCreationProfileFiles(root, patchProfiles, nextProfiles) {
  if (!root) return;
  const base = join(root, "novels", CREATION_DIR);
  // 删除的键（patch 中 null）：移除用户段
  if (patchProfiles && typeof patchProfiles === "object") {
    for (const book of Object.keys(patchProfiles)) {
      if (patchProfiles[book] === null || patchProfiles[book] === void 0) {
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
          // v3.1.1：空壳文件夹清理——所有文件只剩模板骨架（无模型内容）时整目录删除，避免空文件夹堆积
          const dir3 = join(base, sanitizeSegment(book, "book"));
          if (existsSync(dir3)) {
            let anyContent = false;
            for (const fname of Object.values(CREATION_FILES)) {
              const fp = join(dir3, fname);
              if (existsSync(fp)) {
                const c = await readFile(fp, "utf8");
                const meaningful = c.split("\n").map(function (l) { return l.trim(); }).filter(Boolean).filter(function (l) { return !l.startsWith("#") && !l.startsWith("（") && !l.startsWith("【"); });
                if (meaningful.length > 0) { anyContent = true; break; }
              }
            }
            if (!anyContent) await rm(dir3, { recursive: true, force: true });
          }
        } catch { /* 忽略 */ }
      }
    }
  }
  // 现存书（有有效设定）：创建/更新创作设定.md
  if (nextProfiles && typeof nextProfiles === "object") {
    for (const book of Object.keys(nextProfiles)) {
      const v = nextProfiles[book];
      if (!v || typeof v !== "object" || Object.keys(v).length === 0) continue;
      const dir = join(base, sanitizeSegment(book, "book"));
      try {
        await mkdir(dir, { recursive: true });
        const f = join(dir, CREATION_FILES.bible);
        if (!existsSync(f)) {
          await writeFile(f, "# 创作设定\n\n（世界观规则 / 主线冲突 / 分卷目的 / 禁忌）\n\n" + buildCreationUserSection(book), "utf8");
        } else {
          const cur = await readFile(f, "utf8");
          const next = upsertCreationUserSection(cur, buildCreationUserSection(book));
          if (next !== cur) await writeFile(f, next, "utf8");
        }
        // v3.1.0：主要人物设定.md 同步【用户角色设定】段（方案 A：角色设定各归其位）
        const cs = buildCreationCharacterSection(book);
        if (cs !== "") {
          const cf2 = join(dir, CREATION_FILES["characters-main"]);
          if (!existsSync(cf2)) {
            await writeFile(cf2, "# 主要人物设定\n\n（目标→动机→弱点→说话方式→关系）\n\n" + cs, "utf8");
          } else {
            const ccur = await readFile(cf2, "utf8");
            const cnext = upsertCreationSection(ccur, cs, "【用户角色设定】");
            if (cnext !== ccur) await writeFile(cf2, cnext, "utf8");
          }
        }
      } catch { /* 忽略 */ }
    }
  }
}

/** v3.1.0：列出书库中的作品名（novels 下目录，跳过创作资料；原创模式书选择器用）。 */
async function listBookNames(root) {
  try {
    const dir = join(root, "novels");
    const entries = await readdir(dir, { withFileTypes: true });
    const names = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "创作资料") continue;
      if (entry.name.startsWith(".")) continue;
      names.push(entry.name);
    }
    return names.sort((a, b) => a.localeCompare(b, "zh"));
  } catch {
    return [];
  }
}

/** v3.1.0：原创创作资料（novel_outline）——创作设定/人物/大纲/钩子/状态卡。 */
const CREATION_DIR = "创作资料";
const CREATION_FILES = {
  bible: "创作设定.md", "characters-main": "主要人物设定.md", "characters-minor": "次要人物设定.md",
  outline: "剧情大纲.md", hooks: "钩子记录.md", status: "创作状态卡.md"
};

function creationDir(root, book) {
  return join(root, "novels", CREATION_DIR, sanitizeSegment(book, "book"));
}

/** v3.1.0：构建【用户原创设定】段（读侧边栏 state；无设定返回空串）。 */
function buildCreationUserSection(book) {
  // v3.1.0：字段值单行化（多行文本 → 空格），保证段内无空行、与 upsert 的空行边界配合
  const norm = function (s) { return String(s).replace(/\s*\n+\s*/g, " ").trim(); };
  var segs = [];
  try {
    // v3.1.0：按书专属设定优先（用户书选择器指定），无该书专属时回退全局默认
    var st = readSentenceStateSync();
    var cp = book && st.creationProfiles && typeof st.creationProfiles === "object" && typeof st.creationProfiles[book] === "object" ? st.creationProfiles[book] : st.creationProfile;
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

/** v3.1.0：upsert 任意标记段（如【用户原创设定】【用户角色设定】）——存在则替换（保留手写部分），不存在则追加；section 为空串则移除旧段。 */
function upsertCreationSection(text, section, marker) {
  // 段边界 = 下一个标题 / 空行 / 文件尾（防吞掉段后手写内容）
  const re = new RegExp("(?:\\n\\n)?" + marker + "[\\s\\S]*?(?=\\n# |\\n\\n|\\s*$)");
  const has = text.includes(marker);
  if (section === "") {
    if (!has) return text;
    const t = text.replace(re, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    return t;
  }
  if (has) {
    return text.replace(re, "\n\n" + section.trimEnd());
  }
  return text.trimEnd() + "\n\n" + section;
}

/** v3.1.0：upsert【用户原创设定】段（兼容旧名）。 */
function upsertCreationUserSection(text, section) {
  return upsertCreationSection(text, section, "【用户原创设定】");
}

/** v3.1.0：构建【用户角色设定】段（只取用户填的“角色设定”项；未填返回空串）。 */
function buildCreationCharacterSection(book) {
  const norm = function (s) { return String(s).replace(/\s*\n+\s*/g, " ").trim(); };
  try {
    var st = readSentenceStateSync();
    var cp = book && st.creationProfiles && typeof st.creationProfiles === "object" && typeof st.creationProfiles[book] === "object" ? st.creationProfiles[book] : st.creationProfile;
    if (cp && typeof cp === "object" && typeof cp.characters === "string" && cp.characters.trim()) {
      return "【用户角色设定】（侧边栏填写，必须遵守）\n- 角色设定：" + norm(cp.characters) + "\n";
    }
  } catch { /* 读不到则视为无 */ }
  return "";
}

/** 状态卡内容：显示创作进度 + 未回填钩子提醒（强制机制，保证每章钩子都回填）。 */
async function readCreationStatus(root, book, exec) {
  const dir = creationDir(root, book);
  const f = join(dir, CREATION_FILES.status);
  try {
    const txt = await readTextFile(f, exec);
    // 检测未回填钩子（钩子记录有章节号但状态卡进度低于它？——直接比对大纲与钩子）
    return txt;
  } catch {
    return null;
  }
}

function createOutlineTool(config) {
  return {
    name: "novel_outline",
    description: "维护原创小说的创作资料（novels/创作资料/<书名>/）：创作设定/主要人物/次要人物/剧情大纲/钩子记录/创作状态卡的初始化、读取与更新。原创前必读状态卡与大纲，写完每章必回填钩子。",
    parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string", description: "书名（novels/创作资料 下的子目录名）。" },
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
          properties: { book: { type: "string" }, action: { type: "string" }, message: { type: "string" }, content: { type: "string" }, files: { type: "array" } }
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
        const files = [
          ["bible", "# 创作设定\n\n（世界观规则 / 主线冲突 / 分卷目的 / 禁忌）\n\n" + buildCreationUserSection(book)],
          ["characters-main", "# 主要人物设定\n\n（目标→动机→弱点→说话方式→关系）\n"],
          ["characters-minor", "# 次要人物设定\n\n（谁/作用/特征；不再出场标注）\n"],
          ["outline", "# 剧情大纲\n\n（每章方向行，写完回填钩子到钩子记录）\n"],
          ["hooks", "# 钩子记录\n\n（每章结尾钩子：状态/悬念/时间场景）\n"],
          ["status", "# 创作状态卡\n\n（进度/上一章结尾/时间线/活跃角色/下章方向/未回填钩子）\n"]
        ];
        for (const [key, content] of files) {
          const f = join(dir, CREATION_FILES[key]);
          if (!existsSync(f)) {
            await writeFile(f, content, "utf8");
          } else if (key === "bible") {
            // v3.1.0：设定陈旧化修复——bible 已存在时只更新【用户原创设定】段（保留用户手写部分；无设定则移除旧段）
            const cur = await readTextFile(f, exec);
            const next = upsertCreationUserSection(cur, buildCreationUserSection(book));
            if (next !== cur) await writeFile(f, next, "utf8");
          }
          // v3.1.0：主要人物设定.md 角色段同步——首次创建（写模板后）与已存在（upsert）统一执行，角色设定不丢
          if (key === "characters-main") {
            const cs2 = buildCreationCharacterSection(book);
            if (cs2 !== "") {
              const ccur2 = await readTextFile(f, exec);
              const cnext2 = upsertCreationSection(ccur2, cs2, "【用户角色设定】");
              if (cnext2 !== ccur2) await writeFile(f, cnext2, "utf8");
            }
          }
        }
        return { book, action, message: "创作资料已初始化（" + files.length + " 个文件）" };
      }

      if (action === "read") {
        const key = String(args?.file ?? "status");
        if (!CREATION_FILES[key]) throw new Error("未知文件：" + key + "（可用 bible/characters-main/characters-minor/outline/hooks/status）");
        const f = join(dir, CREATION_FILES[key]);
        let content = "";
        try { content = await readTextFile(f, exec); } catch { throw new Error("创作资料尚未初始化，请先 novel_outline init（或在创作文件夹自行创建）"); }
        // 强制机制：读状态卡/大纲时检查未回填钩子
        let remind = "";
        if (key === "status" || key === "outline") {
          try {
            // v3.1.0：大纲章节号从大纲文件提取（status 文件只有快照，不含章节行）
            const outlineContent = key === "status" ? await readTextFile(join(dir, CREATION_FILES.outline), exec) : content;
            const hooks = await readTextFile(join(dir, CREATION_FILES.hooks), exec);
            const outlined = (outlineContent.match(/^[-*] (\d+)/gm) || []).map((m) => parseInt(m.slice(2), 10));
            const hooked = (hooks.match(/^[-*] (\d+)/gm) || []).map((m) => parseInt(m.slice(2), 10));
            const missing = outlined.filter((n) => !hooked.includes(n));
            if (missing.length > 0) remind = "\n\n⚠ 未回填钩子章节：" + missing.join("、") + "——写完的章节必须回填钩子（novel_outline hook），下一章开头从钩子接续";
          } catch { /* 未初始化 */ }
        }
        return { book, action, file: key, content: content + remind };
      }

      if (action === "bible") {
        const content = requiredString(args, "content");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, CREATION_FILES.bible), content, "utf8");
        return { book, action, message: "创作设定已更新（" + content.length + " 字）" };
      }

      if (action === "character") {
        const role = args?.role === "main" ? "main" : "minor";
        const name = requiredString(args, "name");
        const description = String(args?.description ?? "").replace(/\s*\n+\s*/g, "；").trim(); // v3.1.0：换行转分号，防断行伪造条目
        const f = join(dir, CREATION_FILES[role === "main" ? "characters-main" : "characters-minor"]);
        let cur = "";
        try { cur = await readTextFile(f, exec); } catch { cur = "" + (role === "main" ? "# 主要人物设定\n" : "# 次要人物设定\n") + "\n"; await mkdir(dir, { recursive: true }); }
        const cur2 = cur.startsWith("# 主") || cur.startsWith("# 次") ? cur : "# " + (role === "main" ? "主要人物设定\n" : "次要人物设定\n") + "\n" + cur;
        const line = "- " + name + (description ? "：" + description : "") + "\n";
        if (cur2.includes("- " + name)) return { book, action, message: "人物“" + name + "”已存在（未重复登记）" };
        await mkdir(dir, { recursive: true });
        await writeFile(f, cur2.endsWith("\n") ? cur2 + line : cur2 + "\n" + line, "utf8");
        return { book, action, message: "已登记人物“" + name + "”到" + (role === "main" ? "主要" : "次要") + "人物设定" };
      }

      if (action === "chapter") {
        const number = parseInt(args?.number, 10);
        const title = String(args?.title ?? "").replace(/\s*\n+\s*/g, " ").trim(); // v3.1.0：单行化
        if (isNaN(number)) throw new Error("chapter 需要 number");
        const f = join(dir, CREATION_FILES.outline);
        let cur = "";
        try { cur = await readTextFile(f, exec); } catch { cur = "# 剧情大纲\n\n"; await mkdir(dir, { recursive: true }); }
        const cur2 = cur.startsWith("# 剧") ? cur : "# 剧情大纲\n\n" + cur;
        const line = "- " + number + " " + title + "\n";
        if (cur2.includes("- " + number + " ")) {
          return { book, action, message: "第 " + number + " 章已在纲（未重复追加）" };
        }
        await mkdir(dir, { recursive: true });
        await writeFile(f, cur2.endsWith("\n") ? cur2 + line : cur2 + "\n" + line, "utf8");
        return { book, action, message: "大纲已补：第 " + number + " 章 " + title };
      }

      if (action === "hook") {
        const number = parseInt(args?.number, 10);
        const body = String(args?.body ?? "").replace(/\s*\n+\s*/g, " ").trim(); // v3.1.0：单行化，防换行伪造钩子条目
        if (isNaN(number)) throw new Error("hook 需要 number");
        if (body === "") throw new Error("hook 需要 body（本章结尾状态/悬念/时间场景）");
        const f = join(dir, CREATION_FILES.hooks);
        let cur = "";
        try { cur = await readTextFile(f, exec); } catch { cur = "# 钩子记录\n\n"; await mkdir(dir, { recursive: true }); }
        const cur2 = cur.startsWith("# 钩") ? cur : "# 钩子记录\n\n" + cur;
        // 替换已有章钩子（更新），否则追加
        const re = new RegExp("- " + number + " [\\s\\S]*?(?=\\n- |\\n$)");
        const line = "- " + number + " " + body + "\n";
        const next = re.test(cur2) ? cur2.replace(re, line) : (cur2.endsWith("\n") ? cur2 + line : cur2 + "\n" + line);
        await mkdir(dir, { recursive: true });
        await writeFile(f, next, "utf8");
        return { book, action, message: "第 " + number + " 章钩子已回填" };
      }

      if (action === "status") {
        const content = requiredString(args, "content");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, CREATION_FILES.status), content, "utf8");
        return { book, action, message: "创作状态卡已刷新" };
      }

      throw new Error("未知 action：" + action);
    }
  };
}

/** v0.6.0 伏笔/剧情线登记表。 */
/** v0.8.0：书库统一数据目录（<root>/.novel-writer/），子目录：plots/settings/summaries/analysis/audits。 */
function novelDataDir(root) {
  return join(root, ".novel-writer");
}

/** v2.6.0：全书/基线分析结果缓存（按文本哈希命中、单文件覆盖；style_check/style_report 复用，大书不再重复 analyzeText）。
 *  @param {object|null} featState sentence state——null 时不计算/裁剪 genre/theme */

/**
 * v3.0.0：文笔六维每章测量缓存（每书一个文件，存每章测量值，不含文本）。
 * style_report 用全部章算基线；style_check 排除目标章后现算（O(n) 秒级，且只一个缓存文件）。
 * 指纹 = 章节文本拼接 sha1：任何章节变化自动失效重建。
 */
async function metricChaptersCached(root, book, chapters) {
  const dir = join(novelDataDir(root), "analysis");
  const file = join(dir, sanitizeSegment(book, "book") + "-chapters-metrics.json");
  const text = chapters.map((c) => c.text).join("\u0000");
  const th = createHash("sha1").update(text).digest("hex").slice(0, 16);
  try {
    const cached = JSON.parse(await readFile(file, "utf8"));
    if (cached && cached.th === th && Array.isArray(cached.perChapter)) return cached.perChapter;
  } catch { /* 无缓存/损坏 */ }
  const b = computeBaseline(chapters);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify({ th, perChapter: b.perChapter }, null, 2), "utf8");
  } catch { /* 缓存写失败不影响 */ }
  return b.perChapter;
}
async function bookAnalysisCached(root, keyName, text, featState) {
  const dir = join(novelDataDir(root), "analysis");
  const file = join(dir, sanitizeSegment(keyName, "book") + "-full.json");
  const th = createHash("sha1").update(text).digest("hex").slice(0, 16);
  let cached = null;
  try {
    cached = JSON.parse(await readFile(file, "utf8"));
  } catch { /* 无缓存/损坏 */ }
  if (cached && cached.th === th && cached.analysis) {
    const det = cached.detection || {};
    if (featState && !featureEnabled(featState, "genreTheme")) {
      det.genre = undefined;
      det.theme = undefined;
    }
    return { analysis: cached.analysis, detection: det };
  }
  const analysis = analyzeText(text, {});
  const detection = detectCulture(text);
  if (featState && featureEnabled(featState, "genreTheme")) {
    detection.genre = detectGenre(text);
    detection.theme = detectTheme(text);
  }
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify({ th, analysis, detection }), "utf8");
  } catch { /* 写缓存失败不影响结果 */ }
  return { analysis, detection };
}
function plotsFile(root, book) {
  return join(novelDataDir(root), "plots", sanitizeSegment(book, "book") + ".json");
}
function legacyPlotsFile(root, book) {
  return join(novelDataDir(root), sanitizeSegment(book, "book") + ".json");
}
async function readPlots(root, book) {
  const file = plotsFile(root, book);
  let parsed = null;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch { /* 新位置不存在 */ }
  if (!parsed) {
    // v0.8.0 迁移：旧位置 <root>/.novel-writer/<书>.json → plots/<书>.json
    try {
      parsed = JSON.parse(await readFile(legacyPlotsFile(root, book), "utf8"));
      if (Array.isArray(parsed?.entries)) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(parsed, null, 2), "utf8");
      }
    } catch { /* 无旧文件 */ }
  }
  return Array.isArray(parsed?.entries) ? parsed.entries : [];
}
async function writePlots(root, book, entries) {
  const file = plotsFile(root, book);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ book, entries }, null, 2), "utf8");
}

/** v0.8.0：从伏笔内容提取 2-4 字中文关键词（用于 scan 提及检测），跳过停用字。 */
function plotKeywords(content) {
  const text = String(content).replace(/[^\u4e00-\u9fff]/g, "");
  const stop = new Set("的了是在我有和就都不一一个这那与及或但是因为所以如果然后而且比如比如什么怎么自己她们他们你们我们咱们没有不是别莫未".split(""));
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

/** v0.7.0：清洗伏笔条目为 lossless JSON（剔除 undefined 字段，DSH 通道要求）。 */
function normalizePlotEntry(entry) {
  const out = { id: entry.id, content: entry.content, status: entry.status };
  for (const key of ["chapter", "note", "payoffCondition", "lastMentioned", "type", "priority"]) {
    if (entry[key] !== void 0 && entry[key] !== null) out[key] = String(entry[key]);
  }
  for (const key of ["relatedCharacters", "locations", "mentionedIn"]) {
    if (Array.isArray(entry[key])) out[key] = entry[key].map((x) => String(x));
  }
  if (entry.createdAt !== void 0) out.createdAt = entry.createdAt;
  if (entry.updatedAt !== void 0) out.updatedAt = entry.updatedAt;
  return out;
}


/** v0.8.0 设定管理（五张表：人物/地点/道具/时间线/世界观用语规范，worldview 于 v0.9.0 加入）。 */
function settingsFile(root, book) {
  return join(novelDataDir(root), "settings", sanitizeSegment(book, "book") + ".json");
}
async function readSettings(root, book) {
  try {
    const parsed = JSON.parse(await readFile(settingsFile(root, book), "utf8"));
    return {
      characters: Array.isArray(parsed.characters) ? parsed.characters : [],
      locations: Array.isArray(parsed.locations) ? parsed.locations : [],
      items: Array.isArray(parsed.items) ? parsed.items : [],
      timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
      worldview: Array.isArray(parsed.worldview) ? parsed.worldview : []
    };
  } catch {
    return { characters: [], locations: [], items: [], timeline: [], worldview: [] };
  }
}
async function writeSettings(root, book, data) {
  const file = settingsFile(root, book);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ book, ...data }, null, 2), "utf8");
}
function normalizeSettingEntry(entry) {
  const out = { name: String(entry.name) };
  for (const key of ["description", "traits", "relationships", "firstSeen", "notes", "owner", "status", "lastSeen", "day", "event", "chapter", "basis", "ritual"]) {
    if (entry[key] !== void 0 && entry[key] !== null) out[key] = String(entry[key]);
  }
  for (const key of ["alias", "bannedWords"]) {
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
    if (entry.speechStyle.honorGood !== void 0 && typeof entry.speechStyle.honorGood === "object") speech.honorGood = { ...entry.speechStyle.honorGood };
    if (Array.isArray(entry.speechStyle.ritualBadPatterns)) speech.ritualBadPatterns = entry.speechStyle.ritualBadPatterns.map((x) => String(x));
    if (typeof entry.speechStyle.ritualGoodNote === "string") speech.ritualGoodNote = entry.speechStyle.ritualGoodNote;
    out.speechStyle = speech;
  }
  return out;
}
async function readBookAllText(root, book, exec) {
  const dir = join(root, "novels", sanitizeSegment(book, "book"));
  if (!existsSync(dir)) throw new Error("书库中未找到作品：" + book);
  const chapters = await scanChapters(dir);
  let text = "";
  for (const chapter of chapters) text += await readTextFile(join(dir, chapter.file), exec);
  return { text, chapters };
}

// v2.5.0 风格画像报告：聚合 6 维测量数据（文风/词汇/题材/情感/氛围/语义距离），
// 插件只报数不下结论——风格气质判断交给大模型。
function registerNovelStyleReport(ctx, config) {
  ctx.tools.register({
    name: "novel_style_report",
    description: "风格画像报告：聚合 6 维测量数据（指纹/词汇/题材/情感/氛围 12 轴/语义距离）供 AI 判断风格，插件只报数不贴标签。",
    parameters: {
      type: "object",
      additionalProperties: true,
      properties: {
        book: { type: "string", description: "书名（novels 下的子目录名）" },
        root: { type: "string", description: "章节库根目录（含 novels 子目录）。默认取会话工作区。" },
        action: { type: "string", description: "report=生成测量报告（默认）；get=读取已保存的 AI 风格判断" },
        aiJudgment: { type: "string", description: "AI 的风格气质判断结论（可选）：传入后插件会把测量数据 + 判断结果一起存入 .novel-writer/style-reports/ 供后续续写/分析使用" }
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
          message: { type: "string" }
        },
        required: ["book", "report"]
      },
      render: (_args, value) => [{ type: "text", text: value.report }]
    },
    async execute(args, exec) {
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
      const { text, chapters } = await readBookAllText(root, book, exec);
      const featState = await readSentenceState();
      // v2.6.0：复用全书分析缓存（大书不再每次重算 analyzeText/detectCulture/流派题材）
      const { analysis, detection } = await bookAnalysisCached(root, book, text, featState);
      // 语义增强：意象歧义裁决 + 隐性情感（embedding 可用时）
      try {
        const imp = analysis.emotion?.quantification?.implicit;
        if (imp && Array.isArray(imp.ambiguous) && imp.ambiguous.length > 0 && (await embedding.isAvailable())) {
          analysis.emotion.quantification.implicit = await resolveAmbiguousCarriers(imp, text);
        }
        await enrichSemanticImplicit(featState, root, book, { emotion: analysis.emotion }, exec);
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
      const vibe = computeVibe(result, emotion, text);
      result.vibe = vibe;
      // v3.0.0：文笔六维基线带（按章节测量 μ/σ——原创/续写的风格基线）
      // v3.0.0：文笔六维基线带（并行读章 + 指纹缓存，大书不重复测量）
      let metricBaseline = null;
      try {
        const bdir = join(root, "novels", sanitizeSegment(book, "book"));
        const bchapters = await Promise.all(chapters.map(async (ch) => ({ file: ch.file, text: await readTextFile(join(bdir, ch.file), exec) })));
        const perCh = await metricChaptersCached(root, book, bchapters);
        result.baseline = computeBaselineFromPerChapter(perCh);
        result.baselineChapterCount = perCh.length;
      } catch { result.baseline = null; result.baselineChapterCount = 0; }
      // 语义距离（embedding 可用时）
      let semantic = [];
      try {
        if ((await embedding.isAvailable())) {
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
      const wF = parseEvidenceCounts(result.evidence?.western || []);
      const mF = parseEvidenceCounts(result.evidence?.modern || []);
      lines.push("  词群：西方" + wF + " 次 / 现代" + mF + " 次");
      lines.push("");
      lines.push("四、情感（什么心情）");
      lines.push("  表面 " + (emotion.dominant || "-") + " → 真实 " + (emotion.cleanDominant || "-") + "（置信度 " + (emotion.confidence || "-") + "）");
      lines.push("  趋势 Δ=" + (q.stats?.delta ?? 0) + " | 撕裂度 V=" + (q.stats?.variance ?? 0) + " | 矛盾 C=" + (q.stats?.conflict ?? 0));
      lines.push("  意象：负 " + Math.round((implicit.negative ?? 0) * 100) + "% / 正 " + Math.round((implicit.positive ?? 0) * 100) + "% / 歧义 " + Math.round((implicit.ambiguousRatio ?? 0) * 100) + "%");
      lines.push("  隐性情绪：" + (Object.keys(q.semanticImplicit?.distribution || {}).map((k) => k + "×" + q.semanticImplicit.distribution[k]).join(" ") || "（无）"));
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
      return {
        book,
        chars: result.chars,
        // v3.0.0：文笔六维基线带（novel_style_check 对照用）
        baseline: result.baseline ?? null,
        baselineChapterCount: result.baselineChapterCount ?? 0,
        report: reportText + promptLine + (judgment ? "" : "然后将判断结论通过 aiJudgment 参数回传，插件会存入 .novel-writer/style-reports/ 供后续续写参考。"),
        dimensions: { fingerprint: analysis.fingerprint, culture: result.culture, genre: result.genre?.dominant, theme: result.theme?.dominant, emotion: emotion.cleanDominant, vibe: Object.fromEntries(vibe.axes.slice(0, 12).map((a) => [a.name, a.score])) },
        semantic: semantic.map((s, i) => ({ ...s, discrim: i === 0 && semantic.length >= 2 ? Math.round((semantic[0].score - semantic[1].score) * 1000) / 1000 : null })),
        ...(judgment ? { saved: { savedAt: saved.savedAt, ...(saved.error ? { error: saved.error } : {}) }, savedJudgment: judgment } : {}),
        message: judgment ? "风格画像报告已生成，判断结果已保存" : "风格画像报告已生成（仅测量数据，判断请由 AI 完成并回传保存）"
      };
    }
  });
}

function parseEvidenceCounts(arr) {
  let n = 0;
  for (const item of arr || []) {
    const m = String(item).match(/^(?:.*?)(?:×|\u00d7)(\d+)$/);
    n += m ? parseInt(m[1], 10) : 1;
  }
  return n;
}

function extractTopKeywords(text, topN) {
  // v2.6.0：①超长文本等距抽样（头/中/尾各一段，避免全量匹配+全量排序）②复用 extractKeywords
  // （含三字组/疑似人名）③人名/三字词优先展示，并过滤被三字词包含的二字碎片——修复"薇薇安"被拆成"薇薇/薇安"
  const sampled = text.length > 300000
    ? text.slice(0, 100000) + text.slice(Math.floor(text.length / 2) - 50000, Math.floor(text.length / 2) + 50000) + text.slice(-100000)
    : text;
  const kws = extractKeywords(sampled, topN * 3);
  const rank = { "name-candidate": 0, "cjk-trigram": 1, "cjk-bigram": 2, word: 3 };
  const sorted = [...kws].sort((a, b) => rank[a.kind] - rank[b.kind] || b.count - a.count || a.word.localeCompare(b.word));
  const trigrams = sorted.filter((k) => k.kind === "cjk-trigram").map((k) => k.word);
  const seen = new Set();
  const out = [];
  for (const k of sorted) {
    if (seen.has(k.word)) continue;
    if (k.kind === "cjk-bigram" && trigrams.some((t) => t.includes(k.word))) continue;
    seen.add(k.word);
    out.push(k.word + "(" + k.count + ")");
    if (out.length >= topN) break;
  }
  return out;
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
        action: { type: "string", enum: ["list", "add", "update", "delete", "scan", "detect"], description: "list=查看（默认）；add=登记；update=修改；delete=删除；scan=扫描章节提取候选；detect=自动判断世界观文化基准（worldview 专用）。" },
        name: { type: "string", description: "条目名（人物名/地名/道具名；timeline 用 day 字段）。" },
        description: { type: "string", description: "可选：描述。" },
        traits: { type: "string", description: "character 专用：性格/外貌特征。" },
        relationships: { type: "string", description: "character 专用：人际关系。" },
        alias: { type: "array", items: { type: "string" }, description: "character 专用：别名。" },
        firstSeen: { type: "string", description: "可选：首次出现的章节。" },
        owner: { type: "string", description: "item 专用：当前持有者。" },
        status: { type: "string", description: "item 专用：状态（如 在琉璃处/已遗失）。" },
        lastSeen: { type: "string", description: "item 专用：最近出现的章节。" },
        day: { type: "string", description: "timeline 专用：时间点（如 穿越第1天/考核前10日）。" },
        event: { type: "string", description: "timeline 专用：事件。" },
        chapter: { type: "string", description: "timeline 专用：对应章节。" },
        notes: { type: "string", description: "可选：备注。" },
        basis: { type: "string", description: "worldview 专用：判断依据/文化基准说明。" },
        ritual: { type: "string", description: "worldview 专用：仪式规范（如'点烛不烧香'）。" },
        speechStyle: { type: "object", additionalProperties: true, description: "worldview 专用：说话方式规范（title 称谓/honorBad 客套禁词/ritualBadPatterns 仪式禁式/tone 语气·整体为 JSON 对象）。" },
        root: { type: "string", description: "章节库根目录。默认取会话工作区。" }
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
        const list = value.characters ?? value.locations ?? value.items ?? value.timeline ?? value.worldview ?? [];
        lines.push(`${categoryLabel}（${list.length} 条）：`);
        for (const e of list) {
          const extra = [e.traits, e.description, e.relationships, e.owner, e.status, e.lastSeen, e.day + (e.event ? " " + e.event : ""), e.basis, e.ritual, Array.isArray(e.bannedWords) ? "禁用词:" + e.bannedWords.join("/") : "", e.recommended ? "替代:" + Object.entries(e.recommended).map(([k, v]) => k + "→" + v).join("/") : ""].filter(Boolean).join(" | ");
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
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const isDetect = args?.action === "detect";
      const category = isDetect ? "worldview" : ["character", "location", "item", "timeline", "worldview"].includes(args?.category) ? args.category : "character";
      const action = ["add", "update", "delete", "scan", "detect"].includes(args?.action) ? args.action : "list";
      const root = resolveRoot(config, args, exec);
      const data = await readSettings(root, book);
      const now = new Date().toISOString();
      let message = "";
      const categoryLabel = { character: "人物卡", location: "地点卡", item: "道具清单", timeline: "时间线", worldview: "世界观/用语规范" }[category] ?? category;
      const listKey = { character: "characters", location: "locations", item: "items", timeline: "timeline", worldview: "worldview" }[category];
      let lastSettingName = void 0; // v1.0.2：add/update 单条返回用
      const list = data[listKey];
      if (action === "add") {
        const name = optionalString(args, "name") ?? optionalString(args, "day");
        assert(name !== void 0, "novel_settings add 需要 name（timeline 用 day）参数");
        const entry = { name };
        for (const key of ["description", "traits", "relationships", "firstSeen", "owner", "status", "lastSeen", "event", "chapter", "notes", "basis", "ritual"]) {
          if (args?.[key] !== void 0) entry[key] = String(args[key]);
        }
        if (Array.isArray(args?.alias)) entry.alias = args.alias.map(String);
        if (Array.isArray(args?.bannedWords)) entry.bannedWords = args.bannedWords.map(String);
        if (args?.recommended !== void 0 && typeof args?.recommended === "object") entry.recommended = { ...args.recommended };
        if (args?.ritual !== void 0) entry.ritual = String(args.ritual);
        if (category === "worldview" && args?.speechStyle === void 0) {
          const basisText = String(args?.basis ?? "");
          const detected = /中|东|中式|古装|古风|客栈|老爷|少侠|江湖/.test(basisText) ? { culture: "eastern" }
            : /west|欧|西式|教廷|教堂|神甫|公爵/.test(basisText) ? { culture: "western" }
            : detectCulture(basisText);
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
          }
        }
        if (args?.speechStyle !== void 0 && typeof args?.speechStyle === "object") {
          entry.speechStyle = { ...args.speechStyle };
        } else if (args?.category === "worldview" && args?.basis?.toString().includes("west")) {
          // 便捷：欧式基准自动带默认语用规范
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
        list.push(entry);
        lastSettingName = entry.name;
        message = `已登记 ${categoryLabel}：${name}`;
        await writeSettings(root, book, data);
        // v1.0.2：add 返回单条
        const result = { book, category, action, message };
        result[listKey] = [normalizeSettingEntry(entry)];
        return result;
      } else if (action === "update" || action === "delete") {
        const name = optionalString(args, "name") ?? optionalString(args, "day");
        assert(name !== void 0, `novel_settings ${action} 需要 name（timeline 用 day）参数`);
        const index = list.findIndex((e) => e.name === name);
        assert(index !== -1, `${categoryLabel}中不存在「${name}」`);
        if (action === "delete") {
          list.splice(index, 1);
          message = `已删除 ${categoryLabel}：${name}`;
        } else {
          for (const key of ["description", "traits", "relationships", "firstSeen", "owner", "status", "lastSeen", "event", "chapter", "notes", "basis", "ritual"]) {
            if (args?.[key] !== void 0) list[index][key] = String(args[key]);
          }
          if (Array.isArray(args?.alias)) list[index].alias = args.alias.map(String);
          if (Array.isArray(args?.bannedWords)) list[index].bannedWords = args.bannedWords.map(String);
          if (args?.recommended !== void 0 && typeof args?.recommended === "object") list[index].recommended = { ...args.recommended };
          message = `已更新 ${categoryLabel}：${name}`;
          lastSettingName = name;
        }
        await writeSettings(root, book, data);
        // v1.0.2：update 返回单条
        if (action === "update") {
          const updated = list.find((e) => e.name === lastSettingName);
          const result = { book, category, action, message };
          result[listKey] = updated ? [normalizeSettingEntry(updated)] : [];
          return result;
        }
      } else if (action === "scan") {
        // 规则候选：人物（XX说/道/问 高频 2-3 字），道具（含 owner 的常见物件词）
        const dir = bookDir(root, book);
        const chapters = await scanChapters(dir);
        let text = "";
        for (const chapter of chapters) text += await readTextFile(join(dir, chapter.file), exec);
        const nameCounts = new Map();
        for (const m of text.matchAll(/([\u4e00-\u9fff]{2,3})(?:说|道|问|喊|叫|笑|叹|点头|摇头)/g)) {
          const n = m[1];
          if (!["那个", "这个", "什么", "怎么", "自己", "她们", "他们", "你们", "我们"].includes(n)) {
            nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
          }
        }
        const known = new Set(list.map((e) => e.name));
        const candidates = [...nameCounts.entries()].filter(([n, count]) => count >= 2 && !known.has(n)).map(([n, count]) => n + "（" + count + "次）").slice(0, 15);
        message = `扫描全书，提取 ${candidates.length} 个人物候选`;
        const result = { book, category, action, candidates, message };
        result.characters = data.characters.map(normalizeSettingEntry);
        result.locations = data.locations.map(normalizeSettingEntry);
        result.items = data.items.map(normalizeSettingEntry);
        result.timeline = data.timeline.map(normalizeSettingEntry);
        result.worldview = data.worldview.map(normalizeSettingEntry);
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
        result.worldview = data.worldview.map(normalizeSettingEntry);
        result.message = `自动判断：${CULTURE_MARKERS[detection.culture]?.label ?? "无法判断（词表未命中）"}（置信度 ${Math.round(detection.confidence * 100)}%）${genreNote}${themeNote}`;
        // v2.1.0：气质聚合层（氛围光谱 10 轴，纯规则加权 0 token）
        try {
          const analysis = analyzeText(text, {});
          // 语义层裁决意象歧义（embedding 可用时），让 vibe 用更准的意象极性
          try {
            const imp = analysis.emotion?.quantification?.implicit;
            if (imp && Array.isArray(imp.ambiguous) && imp.ambiguous.length > 0 && (await embedding.isAvailable())) {
              analysis.emotion.quantification.implicit = await resolveAmbiguousCarriers(imp, text);
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
      const result = { book, category, action };
      result.characters = data.characters.map(normalizeSettingEntry);
      result.locations = data.locations.map(normalizeSettingEntry);
      result.items = data.items.map(normalizeSettingEntry);
      result.timeline = data.timeline.map(normalizeSettingEntry);
      result.worldview = data.worldview.map(normalizeSettingEntry);
      if (message) result.message = message;
      return result;
    }
  });
}

/** v0.8.0 章节摘要（模型生成内容，插件负责存储/读取）。 */
function summariesFile(root, book) {
  return join(novelDataDir(root), "summaries", sanitizeSegment(book, "book") + ".json");
}
async function readSummaries(root, book) {
  try {
    const parsed = JSON.parse(await readFile(summariesFile(root, book), "utf8"));
    return Array.isArray(parsed.summaries) ? parsed.summaries : [];
  } catch {
    return [];
  }
}
function registerNovelSummary(ctx, config) {
  ctx.tools.register({
    name: "novel_summary",
    description: "章节摘要（模型生成、插件存储）：阅读章节后把摘要存盘，续写长书时先读摘要回忆剧情，避免全文重读。add/update/get/list/delete 按章节管理。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名。" },
        action: { type: "string", enum: ["list", "get", "add", "update", "delete"], description: "list=全部摘要（默认）；get=取某章；add=新增/覆盖摘要；update=修改；delete=删除。" },
        chapter: { type: "string", description: "章节标识（章号/文件名/标题）。" },
        summary: { type: "string", description: "add/update 时：本章摘要（200-500 字，覆盖剧情走向/关键事件/结尾状态）。" },
        keyEvents: { type: "array", items: { type: "string" }, description: "可选：关键事件列表。" },
        keySettings: { type: "array", items: { type: "string" }, description: "可选：本章出现的关键设定/信息。" },
        root: { type: "string", description: "章节库根目录。默认取会话工作区。" }
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
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const action = ["get", "add", "update", "delete"].includes(args?.action) ? args.action : "list";
      const root = resolveRoot(config, args, exec);
      const summaries = await readSummaries(root, book);
      const now = new Date().toISOString();
      let message = "";
      if (action !== "list") {
        const chapterArg = optionalString(args, "chapter");
        assert(chapterArg !== void 0, `novel_summary ${action} 需要 chapter 参数`);
        const index = summaries.findIndex((s) => s.chapter === chapterArg);
        if (action === "get") {
          const found = index !== -1 ? [summaries[index]] : [];
          return { book, action, summaries: found.map((s) => ({ ...s })) };
        }
        if (action === "delete") {
          if (index !== -1) summaries.splice(index, 1);
          message = `已删除 ${chapterArg} 的摘要`;
        } else {
          const summary = optionalString(args, "summary");
          assert(summary !== void 0, `novel_summary ${action} 需要 summary 参数`);
          const entry = {
            chapter: chapterArg,
            summary,
            keyEvents: Array.isArray(args?.keyEvents) ? args.keyEvents.map(String) : void 0,
            keySettings: Array.isArray(args?.keySettings) ? args.keySettings.map(String) : void 0,
            updatedAt: now
          };
          if (index !== -1) summaries[index] = entry;
          else summaries.push(entry);
          message = `已保存 ${chapterArg} 的摘要`;
        }
        await mkdir(dirname(summariesFile(root, book)), { recursive: true });
        await writeFile(summariesFile(root, book), JSON.stringify({ book, summaries }, null, 2), "utf8");
        // v1.0.2：add/update 返回单条确认（不再返回全量列表）
        if (action === "add" || action === "update") {
          const single = summaries[index !== -1 ? index : summaries.length - 1];
          const cleanSingle = {
            chapter: String(single.chapter),
            summary: String(single.summary)
          };
          if (Array.isArray(single.keyEvents)) cleanSingle.keyEvents = single.keyEvents.map(String);
          if (Array.isArray(single.keySettings)) cleanSingle.keySettings = single.keySettings.map(String);
          if (single.updatedAt !== void 0) cleanSingle.updatedAt = single.updatedAt;
          return { book, action, message, summaries: [cleanSingle] };
        }
      }
      summaries.sort((a, b) => String(a.chapter).localeCompare(String(b.chapter)));
      const clean = summaries.map((s) => {
        const out = { chapter: String(s.chapter), summary: String(s.summary) };
        if (Array.isArray(s.keyEvents)) out.keyEvents = s.keyEvents.map(String);
        if (Array.isArray(s.keySettings)) out.keySettings = s.keySettings.map(String);
        if (s.updatedAt !== void 0) out.updatedAt = s.updatedAt;
        return out;
      });
      return { book, action, summaries: clean, ...message ? { message } : {} };
    }
  });
}

/** v0.8.0 连贯性审计：设定表 + 全书扫描 → 矛盾候选清单。 */
function registerNovelContinuityCheck(ctx, config) {
  ctx.tools.register({
    name: "novel_continuity_check",
    description: "连贯性审计：对照设定表扫描全书，输出矛盾候选（数字口径/人物缺场/别名/重复）供修正。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名。" },
        root: { type: "string", description: "章节库根目录。默认取会话工作区。" }
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
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const root = resolveRoot(config, args, exec);
      const dir = bookDir(root, book);
      const chapters = await scanChapters(dir);
      assert(chapters.length > 0, `作品 "${book}" 下没有章节文件`);
      const settings = await readSettings(root, book);
      const chapterTexts = [];
      for (const chapter of chapters) {
        chapterTexts.push({ file: chapter.file, text: await readTextFile(join(dir, chapter.file), exec) });
      }
      const candidates = [];
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
        const forms = [...numberForms.entries()];
        for (let i = 0; i < forms.length; i += 1) {
          for (let j = i + 1; j < forms.length; j += 1) {
            const [a, ca] = forms[i];
            const [b, cb] = forms[j];
            if (a !== b) {
              candidates.push({ type: "数字口径", detail: `「${a}」与「${b}」写法并存（可能指同一数量），请确认口径`, chapters: [...new Set(ca.concat(cb))] });
            }
          }
        }
      }
      // 2) 登记人物出现分布（缺失章节提示）
      for (const character of settings.characters) {
        const absent = chapterTexts.filter(({ file, text }) => !text.includes(character.name)).map(({ file }) => file);
        if (absent.length === chapterTexts.length) {
          candidates.push({ type: "人物缺失", detail: `设定表人物「${character.name}」在全书章节中均未出现，请确认是否已出场`, chapters: absent });
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
        const names = settings[key].map((e) => e.name);
        const dup = names.filter((n, i) => names.indexOf(n) !== i);
        if (dup.length > 0) candidates.push({ type: "设定重复", detail: `${key} 中存在重复条目：${[...new Set(dup)].join("、")}`, chapters: [] });
      }
      // v0.9.0 用语风格扫描：对照 worldview 禁用词表（无登记则用默认欧式基准）
      // v1.0.0：取最近登记且含 speechStyle 的 worldview（避免被旧/首条无 speechStyle 覆盖）
      const worldviewEntry = Array.isArray(settings.worldview)
        ? settings.worldview.slice().reverse().find((e) => e && e.speechStyle) ?? settings.worldview[0]
        : void 0;
      const styleRule = (worldviewEntry && Array.isArray(worldviewEntry.bannedWords) && worldviewEntry.bannedWords.length > 0) ? worldviewEntry : DEFAULT_BANNED_WORDS;
      const cultureName = (worldviewEntry && worldviewEntry.name) || styleRule.culture;
      for (const word of styleRule.bannedWords) {
        const hits = chapterTexts.filter(({ text }) => text.includes(word)).map(({ file }) => file);
        if (hits.length > 0) {
          const rec = styleRule.recommended?.[word] ? `（建议改为「${styleRule.recommended[word]}」）` : "";
          candidates.push({
            type: "用语冲突",
            detail: `「${word}」×${hits.length}章 与当前文化基准「${cultureName}」不符${rec}${worldviewEntry ? "" : "（未登记 worldview，使用默认基准；可用 novel_settings detect 自动判断）"}`,
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
          candidates.push({ type: "语用冲突·客套", detail: `「${word}」×${files.length}章 为中式客套，与当前世界观不符${rec}`, chapters: files });
        }
      }
      if (speech && Array.isArray(speech.ritualBadPatterns)) {
        for (const pattern of speech.ritualBadPatterns) {
          const regex = new RegExp(pattern, "g");
          const ritualHits = [];
          for (const { file, text } of chapterTexts) {
            if (regex.test(text)) ritualHits.push(file);
            regex.lastIndex = 0;
          }
          if (ritualHits.length > 0) {
            candidates.push({
              type: "语用冲突·仪式",
              detail: `检测到烧香/上香类仪式表达（${speech.ritualGoodNote || "应为点烛"}）`,
              chapters: ritualHits
            });
          }
        }
      }
      if (speech && typeof speech.title === "string") {
        // 称谓：登记了"小姐XXX"禁用规则则扫描（title 含"小姐"时）
        if (speech.title.includes("小姐") || speech.title.includes("不用")) {
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
        await writeFile(reportFile, JSON.stringify({ book, generatedAt: new Date().toISOString(), candidates }, null, 2), "utf8");
      } catch { /* 落盘失败不阻塞 */ }
      return { book, candidates, reportFile, advice };
    }
  });
}

function registerNovelPlot(ctx, config) {
  ctx.tools.register({
    name: "novel_plot",
    description: "伏笔/剧情线登记表：维护某部作品的伏笔与剧情钩子（open 待回收 / done 已回收），续写前查看可提醒模型回收伏笔、保持剧情连贯。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名。" },
        action: { type: "string", enum: ["list", "add", "update", "done", "delete", "scan"], description: "list=查看（默认）；add=登记新伏笔；update=修改；done=标记已回收；delete=删除；scan=扫描章节文本，自动更新每条 open 伏笔的提及章节（mentionedIn/lastMentioned）。" },
        id: { type: "string", description: "伏笔 id（update/done/delete 时需要）。" },
        content: { type: "string", description: "add/update 时：伏笔内容描述。" },
        chapter: { type: "string", description: "可选：伏笔出现的章节。" },
        note: { type: "string", description: "可选：备注（如何回收/何时回收）。" },
        type: { type: "string", enum: ["剧情", "设定", "道具", "人物", "其他"], description: "可选：伏笔类型（add/update）。" },
        priority: { type: "string", enum: ["high", "medium", "low"], description: "可选：优先级（add/update）。" },
        relatedCharacters: { type: "array", items: { type: "string" }, description: "可选：关联人物（add/update）。" },
        locations: { type: "array", items: { type: "string" }, description: "可选：关联地点（add/update）。" },
        payoffCondition: { type: "string", description: "可选：回收条件（add/update）。" },
        root: { type: "string", description: "章节库根目录。默认取会话工作区。" }
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
      const entries = await readPlots(root, book);
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
        for (const chapter of targets) {
          const chapterText = await readTextFile(join(dir, chapter.file), exec);
          for (const entry of entries) {
            if (entry.status !== "open") continue;
            const keywords = plotKeywords(entry.content);
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
        const index = entries.findIndex((e) => e.id === id);
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
      await writePlots(root, book, entries);
      try { await writeSentenceState({ lastRoot: root }); } catch { /* 记录失败不影响伏笔功能 */ }
      entries.sort((a, b) => (a.status === b.status ? a.createdAt.localeCompare(b.createdAt) : a.status === "open" ? -1 : 1));
      // v1.0.2：add/update 返回单条确认
      if (action === "add" || action === "update") {
        const target = entries.find((e) => e.id === lastPlotId);
        return { book, action, entries: target ? [normalizePlotEntry(target)] : [], ...message ? { message } : {} };
      }
      return { book, action, entries: entries.map(normalizePlotEntry), ...message ? { message } : {} };
    }
  });
}

// ---- 工具定义 ----


function registerNovelSemanticSearch(ctx, config) {
  ctx.tools.register({
    name: "novel_semantic_search",
    description: "语义检索（本地 embedding，0 token）：自然语言检索全书语义相关段落，无关键词也能命中。受「语义增强」开关控制。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        book: { type: "string", description: "书名。" },
        query: { type: "string", description: "要检索的语义描述，如「与血统秘密相关的段落」「女主压抑克制的时刻」。自然语言越具体越好。" },
        top: { type: "integer", description: "返回条数（默认 5，最大 10）。" },
        root: { type: "string", description: "章节库根目录（含 novels 子目录）。默认取会话工作区。" }
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
      try {
      const book = String(args?.book ?? "");
      assert(book !== "", "novel_semantic_search 需要 book 参数");
      const query = String(args?.query ?? "");
      assert(query !== "", "novel_semantic_search 需要 query 参数");
      const top = Math.min(Math.max(Number(args?.top) || 5, 1), 10);
      const root = resolveRoot(config, args, exec);
      const state = await readSentenceState();
      if (!semanticFeatureEnabled(state, "semanticSearch")) {
        return { book, query, available: false, results: [], message: "「语义检索」已关闭：请在侧边栏「写作助手功能」→ 小模型页开启，或用 novel_sentence_config 设置 semanticSearch:true。" };
      }
      const ready = await embedding.isAvailable();
      if (!ready) {
        return { book, query, available: false, results: [], message: "语义引擎不可用：" + (embedding.engine?.error ?? "模型加载失败") + "。插件已回退纯规则模式，不影响其他功能。" };
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
      if (!index || index.length === 0 || cachedFp !== indexFp) {
        index = await embedding.buildIndexIncremental(chunks, cachedIndex);
        cache = "built";
        embedding.saveIndex(root, book, index, indexFp);
      }
      const results = await embedding.search(query, index, top);
      return {
        book, query, available: true, cache, indexSize: index.length,
        results: results.map((r) => ({ id: r.id, chapter: r.chapter || String(r.id).split("|")[0] || "全书", text: r.text.slice(0, 200), score: Math.round(r.score * 10000) / 10000 })),
        message: cache === "hit" ? "使用本地语义索引（缓存）" : "首次建索引完成，已缓存"
      };
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
        root: { type: "string", description: "章节库根目录（含 novels 子目录）。默认取会话工作区。" }
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
            chars += (await chapterStats(bookPath, chapter)).chars;
          } catch { /* 跳过无法统计的章节 */ }
        }
        books.push({ name: entry.name, chapters: chapters.length, chars });
      }
      books.sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));
      return { root, books };
    }
  });
}

function formatBooks(value) {
  const lines = [`<path>${value.root}/novels</path>`, `<type>novel-library</type>`, `<content>`, ""];
  if (value.books.length === 0) lines.push("（暂无作品。请在 novels/<书名>/ 下存放章节文件，如 第01章.md）");
  for (const book of value.books) lines.push(`- ${book.name}: ${book.chapters} 章, ${book.chars} 字`);
  lines.push("", "</content>");
  return lines.join("\n");
}

function registerNovelChapters(ctx, config) {
  ctx.tools.register({
    name: "novel_chapters",
    description: "列出某部作品的全部章节：章号、标题、字数、行数、更新时间。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名（novels 下的子目录名）。" },
        root: { type: "string", description: "章节库根目录。默认取会话工作区。" }
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
        const stats = await chapterStats(dir, chapter);
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

function formatChapters(value) {
  const lines = [`<path>novels/${value.book}</path>`, `<type>novel-chapters</type>`, `<content>`, ""];
  if (value.chapters.length === 0) lines.push("（该作品下没有章节文件）");
  for (const chapter of value.chapters) {
    const number = chapter.number === void 0 ? "?" : String(chapter.number).padStart(2, "0");
    lines.push(`- 第${number}章 ${chapter.title} — ${chapter.chars} 字 / ${chapter.lines} 行 (${chapter.file}, 更新于 ${chapter.updated.slice(0, 10)})`);
  }
  lines.push("", "</content>");
  return lines.join("\n");
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
        root: { type: "string", description: "章节库根目录。默认取会话工作区。" }
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
      assert(offset <= totalLines || (totalLines === 0 && offset === 1), `offset ${offset} 超出范围（"${chapter.file}" 共 ${totalLines} 行）`);
      let chars = 0;
      const lines = [];
      for (let i = offset - 1; i < allLines.length && lines.length < limit; i += 1) {
        const line = allLines[i];
        chars += line.length + (i < allLines.length - 1 ? 1 : 0);
        if (chars > READ_MAX_CHARS && lines.length > 0) {
          return {
            book,
            chapter: chapter.file,
            file: chapter.file,
            path: filePath,
            offset,
            totalLines,
            chars: text.length,
            truncated: true,
            lines
          };
        }
        lines.push({ number: i + 1, text: line });
      }
      return {
        book,
        chapter: chapter.file,
        file: chapter.file,
        path: filePath,
        offset,
        totalLines,
        chars: text.length,
        truncated: lines.length < limit && offset + lines.length - 1 < totalLines,
        lines
      };
    }
  });
}

function formatRead(value) {
  const endLine = value.lines.length > 0 ? value.lines[value.lines.length - 1].number : value.offset - 1;
  const body = value.lines.map((line) => `${line.number}: ${line.text}`).join("\n");
  let footer;
  if (value.truncated) footer = `(输出截断。共 ${value.totalLines} 行 / ${value.chars} 字，已显示 ${value.offset}-${endLine} 行。用 offset=${endLine + 1} 继续阅读。)`;
  else if (endLine < value.totalLines) footer = `(共 ${value.totalLines} 行 / ${value.chars} 字，已显示 ${value.offset}-${endLine} 行。用 offset=${endLine + 1} 继续阅读。)`;
  else footer = `(本章共 ${value.totalLines} 行 / ${value.chars} 字)`;
  return `<path>${value.path}</path>
<type>novel-chapter</type>
<content>
${body === "" ? "" : `${body}\n`}
${footer}
</content>`;
}

function registerNovelKeywords(ctx, config) {
  ctx.tools.register({
    name: "novel_keywords",
    description: "统计某部作品（或单个章节）中出现频率较高的关键词：中文相邻二字词组、高频单字与英文词。用于分析作者的词汇偏好与意象母题。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名。" },
        chapter: { type: "string", description: "可选。只统计该章节；省略则统计全书。" },
        top: { type: "integer", description: "返回的关键词数量。默认 20。" },
        root: { type: "string", description: "章节库根目录。默认取会话工作区。" }
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
      for (const chapter of selected) {
        text += await readTextFile(join(dir, chapter.file), exec);
      }
      const result = {
        book,
        scope,
        totalChars: text.length,
        keywords: extractKeywords(text, top)
      };
      // v0.8.0：关键词结果落盘到书库统一数据目录（与设定同文件夹）
      try {
        const reportDir = join(novelDataDir(root), "analysis");
        const reportFile = join(reportDir, book + "-keywords-" + createHash("sha1").update(book + "|" + scope + "|" + text.length).digest("hex").slice(0, 12) + ".json");
        await mkdir(reportDir, { recursive: true });
        await writeFile(reportFile, JSON.stringify({ ...result, generatedAt: new Date().toISOString() }, null, 2), "utf8");
        result.reportFile = reportFile;
      } catch { /* 落盘失败不阻塞 */ }
      return result;
    }
  });
}

function formatKeywords(value) {
  const lines = [`<path>novels/${value.book}</path>`, `<type>novel-keywords</type>`, `<content>`, `统计范围: ${value.scope} (共 ${value.totalChars} 字)`, ""];
  if (value.keywords.length === 0) lines.push("（未提取到重复出现的关键词）");
  for (const keyword of value.keywords) {
    const kind = keyword.kind === "cjk-bigram" ? "词组" : keyword.kind === "cjk-trigram" ? "三字组" : keyword.kind === "name-candidate" ? "疑似人名" : "英文词";
    lines.push(`- ${keyword.word} × ${keyword.count} (${kind})`);
  }
  lines.push("", "</content>");
  return lines.join("\n");
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
        root: { type: "string", description: "章节库根目录。默认取会话工作区。" }
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
          chars: { type: "integer" }
        },
        required: ["book", "number", "file", "path", "chars"]
      },
      render: (_args, value) => [{
        type: "text",
        text: `<path>${value.path}</path>
<type>novel-chapter-created</type>
<content>
Created 第${String(value.number).padStart(2, "0")}章 (${value.chars} chars)
</content>`
      }]
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
      const parts = [];
      if (title !== void 0) parts.push(`# ${title}`, "");
      if (content !== void 0) parts.push(content, "");
      const text = parts.join("\n");
      await writeFile(filePath, text, { encoding: "utf8", signal: exec.signal });
      return { book, number, file: fileName, path: filePath, chars: text.length };
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
  ctx.systemPrompt.section({
    name: "novel-writing",
    order: 150,
    text: WORKFLOW_TEXT
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
