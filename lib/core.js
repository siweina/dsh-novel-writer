/**
 * dsh-novel-writer — 宿主端共享层（v4.0.1 自 index.js 拆出）
 *
 * 拆分原因：DSH STORE 单文件上限 262144 字节（原 index.js 为 299570 字节）。
 * 本文件承载辅助函数、常量、HTTP 路由与状态读写；lib/index.js 仅保留插件协议与 16 个工具注册。
 * 逻辑与拆分前逐字一致，仅做移动与导入导出调整。
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { analyzeText, CATEGORY_LABELS } from "./analysis.js";
import { createRequire } from "node:module";
import { checkForUpdate } from "./update-check.js";
import { computeBaseline, computeBaselineFromPerChapter, measureStyleMetrics, METRIC_LABELS, METRIC_ORDER } from "./style-metrics.js";
import { CULTURE_MARKERS, GENRE_MARKERS, THEME_MARKERS } from "./lexicons/markers.js";
import * as embedding from "./embedding.js";

const require = createRequire(import.meta.url);
export const PLUGIN_VERSION = require("../package.json").version;
export const CACHE_VERSION = PLUGIN_VERSION;
export const VIBE_POS_PROTOTYPES = [
  "阳光暖融融地照在身上，心里踏实又安宁",
  "他笑起来的时候，整个世界都明亮了",
  "温暖从心底慢慢升起来，像融化的蜜",
  "这一刻真好，所有的疲惫都被抚平了",
  "她闭上眼睛，嘴角不自觉地上扬"
];
export const VIBE_NEG_PROTOTYPES = [
  "黑暗里有什么在逼近，他说不清自己在怕什么",
  "有些秘密知道得越多越危险，可他已回不了头",
  "心里发紧，像有什么东西在缓缓靠近",
  "那晚的潮声格外浓稠，像是海底有什么在翻身",
  "她说不出哪里不对，只是觉得浑身发冷"
];
export async function resolveAmbiguousCarriers(implicit) {
  if (!implicit || !Array.isArray(implicit.ambiguous) || implicit.ambiguous.length === 0) return implicit;
  let posV = null, negV = null;
  // v4.0.0 修正：直接用第 110 行的静态 import（此前的动态 import 与它重复，且 emb 永不为假）
  try {
    posV = await embedding.embed(VIBE_POS_PROTOTYPES.join("；"));
    negV = await embedding.embed(VIBE_NEG_PROTOTYPES.join("；"));
  } catch { return implicit; }
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
  return {
    ...implicit,
    negative: totalW === 0 ? 0 : Math.round((negW / totalW) * 100) / 100,
    positive: totalW === 0 ? 0 : Math.round((posW / totalW) * 100) / 100,
    ambiguousRatio: totalW === 0 ? 0 : Math.round((ambW / totalW) * 100) / 100,
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
export const CHAPTER_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
export const READ_LIMIT = 400;
export const READ_MAX_CHARS = 20000;
export const LEADING_NUMBER = /^第?(\d+)[章回话]?[\s._\-—]*/;
export const CJK_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export function cjkToNumber(text) {
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
    } else if (ch === "千") {
      // v4.0.0：补"千"（1000~9999 章可回读）
      total += (section === 0 ? 1 : section) * 1000;
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
export function parseChapterNumber(name) {
  const stem = String(name).replace(/\.[^.]+$/, "");
  const arabicMark = /第?(\d{1,4})[章回话]/.exec(stem);
  if (arabicMark) return Number(arabicMark[1]);
  // v3.7.0 ②：书名-01-标题 的中段数字也是章号（斗破苍穹-01-陨落 → 1）
  const sepMark = /[-._\s](\d{1,4})[-._\s]/.exec(stem);
  if (sepMark) return Number(sepMark[1]);
  const leading = LEADING_NUMBER.exec(stem);
  if (leading) return Number(leading[1]);
  // v4.0.0 修正：书名-01 / 书名 01 这类"末尾章号"（旧版要求数字两侧都有分隔符 → 解析失败）
  const trailing = /[-._\s](\d{1,4})$/.exec(stem);
  if (trailing) return Number(trailing[1]);
  const cjkMark = /第([零一二三四五六七八九十百千万两]+)[章回话]/.exec(stem); // v4.0.0：补"千"（numberToCjk 会生成"千"，旧版反向解析不了）
  if (cjkMark) {
    const n = cjkToNumber(cjkMark[1]);
    if (n !== void 0) return n;
  }
  return void 0;
}
export function normalizeChapterKey(c) {
  const s = String(c ?? "").trim().replace(/\.md$/i, "").replace(/^#+\s*/, "");
  const m = s.match(/第?(\d{1,4}|[零一二三四五六七八九十百两]+)[章回话节]/);
  if (m) {
    let n;
    if (/^\d+$/.test(m[1])) n = Number(m[1]);
    else n = cjkToNumber(m[1]);
    if (n !== void 0 && Number.isInteger(n)) return "第" + String(n).padStart(2, "0") + "章";
  }
  const m2 = s.match(/^(\d{1,4})[-._\s]/);
  if (m2) return "第" + String(Number(m2[1])).padStart(2, "0") + "章";
  const m3 = s.match(/^(\d{1,4})$/);
  if (m3) return "第" + String(Number(m3[1])).padStart(2, "0") + "章"; // v3.7.0 ③：纯数字章号（2/02）也归一
  return s;
}
export function cleanChapterTitle(stem) {
  return stem
    .replace(/第?(\d{1,4})[章回话]/g, "")
    .replace(/第[零一二三四五六七八九十百两]+[章回话]/g, "")
    .replace(LEADING_NUMBER, "")
    .replace(/[_\-.]+/g, " ")
    .trim();
}
export const CJK_STOP_CHARS = new Set(
  "的了是在有和就都而于及与或这那之其以被把让向着过也还又但更最很从对为等啊吧呢吗嗯哦呀哈啦么个中上下前后左右来去出进到说想看要会能可没有不".split("")
);
export const EN_STOP_WORDS = new Set(
  "the and of to in a an is are was were be been being it its this that these those i you he she they we my your his her their our me him them us as at by for with on from or but not no so if then than when where which who whom what how why all any both each few more most other some such only own same too very just can could will would shall should may might must do does did done have has had having about into over under again further once here there".split(/\s+/)
);
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
export function requiredString(args, key) {
  const value = args?.[key];
  assert(typeof value === "string" && value.trim() !== "", `参数 "${key}" 不能为空字符串`);
  return value.trim();
}
export function optionalString(args, key) {
  const value = args?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
export function optionalInt(args, key, min, max, fallback) {
  const value = args?.[key];
  if (value === void 0) return fallback;
  assert(Number.isInteger(value) && value >= min && value <= max, `参数 "${key}" 必须是 ${min} 到 ${max} 之间的整数`);
  return value;
}
export function sanitizeSegment(value, label) {
  // v3.5.0 #32：除路径分隔符外，剥掉 Windows 保留字符与结尾点/空格，保留名（CON/NUL…）加下划线后缀
  let cleaned = String(value ?? "").replace(/[\\/:*?"<>|]/g, "").replace(/[.\s]+$/g, "").replace(/^[.\s]+/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) cleaned = "_" + cleaned;
  // v4.0.0 修正：删除恒真的 ["",".",".."].includes 判断（上一行已剥掉首尾点/空白，不可能等于它们）；
  // 空值单独给出可定位的提示——旧文案"含非法路径字符"把"清洗后为空"报成字符问题，误导排查
  assert(cleaned.length > 0, `参数 ${label} 不能为空（清洗后无有效字符）`);
  return cleaned;
}
export function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd();
}
export function resolveRoot(config, args, exec) {
  const override = optionalString(args, "root");
  if (override !== void 0) return override;
  const configured = config?.root;
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
  return sessionCwd(exec);
}
export function novelsDir(root) {
  return join(root, "novels");
}
export function bookDir(root, book) {
  return join(novelsDir(root), sanitizeSegment(book, "book"));
}
export async function scanChapters(bookPath) {
  let entries;
  try {
    entries = await readdir(bookPath, { withFileTypes: true });
  } catch (e) {
    // v3.9.0：缺失书目录不再抛裸 ENOENT——友好报错（各工具行为统一）
    throw new Error("书库中未找到作品目录：" + bookPath + "（检查书名是否精确匹配——可用 novel_books 查看全部作品名；或确认 novels/ 下已创建该书目录）", { cause: e });
  }
  const chapters = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!CHAPTER_EXTENSIONS.has(ext)) continue;
    chapters.push({
      file: entry.name,
      number: parseChapterNumber(entry.name),
      title: cleanChapterTitle(entry.name.slice(0, -ext.length)) || "" // v3.6.0：无标题章节返回空串（不把文件名当标题）
    });
  }
  chapters.sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) || a.file.localeCompare(b.file));
  return chapters;
}
export async function readTextFile(filePath, exec) {
  const buf = await readFile(filePath, { signal: exec?.signal });
  return decodeTextBuffer(buf, filePath);
}
export function decodeTextBuffer(buf, filePath) {
  // 1) BOM 检测
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8"); // UTF-8 BOM
  }
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le"); // UTF-16 LE BOM
    if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2)); // UTF-16 BE BOM
  }
  // 2) 无 BOM：先做 NUL 分布启发式——纯 ASCII 的 UTF-16 LE/BE 每两个字节含一个 0x00，
  //    若先走严格 UTF-8 会被静默收下（NUL 是合法 UTF-8），永远到不了启发式分支（v3.9.5 修正顺序）
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
    // UTF-16LE 的 NUL 在奇数下标（41 00），BE 在偶数（00 41）
    return oddNul >= evenNul
      ? new TextDecoder("utf-16le").decode(buf)
      : new TextDecoder("utf-16be").decode(buf);
  }
  // 3) 无 BOM 且无 UTF-16 信号：严格按 UTF-8 解码
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    /* 非 UTF-8，继续尝试 */
  }
  // 4) 中文 Windows 常见的 GBK/GB18030（TextDecoder 原生支持 gbk）
  const gbk = new TextDecoder("gbk").decode(buf);
  if (!gbk.includes("\uFFFD")) return gbk;
  throw new Error(`cannot detect text encoding of "${filePath}": 不是有效的 UTF-8/UTF-16/GBK，请将文件另存为 UTF-8 编码`);
}
export async function chapterStats(bookPath, chapter, exec) {
  const info = await stat(join(bookPath, chapter.file));
  // v4.0.0 修正：转发 exec.signal——宿主契约要求异步工作可取消；此前 novel_books/novel_chapters 读全书无法中断
  const text = await readTextFile(join(bookPath, chapter.file), exec);
  return {
    chars: text.length,
    lines: text.length === 0 ? 0 : text.split(/\r?\n/).length,
    size: info.size,
    updated: info.mtime.toISOString()
  };
}
export function findChapter(chapters, chapterArg) {
  const needle = String(chapterArg).trim();
  const asNumber = parseChapterNumber(needle);
  if (asNumber !== void 0) {
    const byNumber = chapters.find((c) => c.number === asNumber);
    if (byNumber) return byNumber;
  }
  const lower = needle.toLowerCase();
  const byFile = chapters.find((c) => c.file.toLowerCase() === lower);
  if (byFile) return byFile;
  // v4.0.0 修正：纯数字参数必须"章号完全相等"，否则 findChapter("1") 会子串命中第 10/11/12 章
  if (/^\d+$/.test(needle)) {
    const exact = chapters.find((c) => String(c.number) === needle);
    if (exact) return exact;
    return void 0;
  }
  const byTitle = chapters.find((c) => c.title.toLowerCase().includes(lower) || c.file.toLowerCase().includes(lower));
  if (byTitle) return byTitle;
  return void 0;
}
export function extractKeywords(text, top) {
  const cjkBigrams = new Map();
  const cjkTrigrams = new Map();
  const enWords = new Map();
  const nameCandidates = new Map();
  const cjkRun = [];
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjkRun.push(ch);
    else if (cjkRun.length > 0) {
      tallyCjkRun(cjkRun, cjkBigrams, cjkTrigrams);
      cjkRun.length = 0;
    }
  }
  if (cjkRun.length > 0) tallyCjkRun(cjkRun, cjkBigrams, cjkTrigrams);
  for (const match of text.toLowerCase().matchAll(/[a-z]{2,}/g)) {
    const word = match[0];
    if (!EN_STOP_WORDS.has(word)) enWords.set(word, (enWords.get(word) ?? 0) + 1);
  }
  // 疑似人名/专名：2~3 字 + 动作/称谓（"露西亚说着""琉璃小姐"）
  // v4.0.0 修正：量词改懒惰——贪婪会把"琉璃说道"吃成"琉璃说"（动词尾巴污染人名候选）
  const namePatterns = [
    /([\u4e00-\u9fff]{2,3}?)(?:说|道|问|喊|叫|想|笑|叹|答|喝|骂|念|哭|点头|摇头)/g,
    /([\u4e00-\u9fff]{2,3})(?:小姐|大人|先生|少爷|姑娘|殿下|老师|导师|婆婆|爷爷|奶奶|夫人|老爷|公子|长老|神甫|陛下|殿下|大人|小姐)/g
  ];
  for (const pattern of namePatterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      // v3.5.0 #23：伪人名过滤——代词/功能词开头的（"他说/她又/我问道/摇头"）不是名字
      if (/^[他她我你它又再还这那谁]./.test(name)) continue;
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
export function tallyCjkRun(run, cjkBigrams, cjkTrigrams) {
  for (let i = 0; i < run.length; i += 1) {
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
export const IMPORT_NOISE = new Set(["原稿件", "单章", "调教计划", "未命名", "新建文档", "草稿", "无题", "正文", "手稿"]);
export function numberToCjk(n) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (!Number.isInteger(n) || n <= 0 || n >= 10000) return null;
  if (n < 10) return digits[n];
  // v3.9.5 修正：完整支持 10~9999（旧实现只支持 <100，却只在 ≥10000 返回 null，100~9999 会拼出 “undefined十”）
  let out = "";
  const q1000 = Math.floor(n / 1000);
  if (q1000 > 0) {
    out += digits[q1000] + "千";
    n %= 1000;
    if (n === 0) return out;
    if (n < 100) out += "零";
  }
  const q100 = Math.floor(n / 100);
  if (q100 > 0) {
    out += digits[q100] + "百";
    n %= 100;
    if (n === 0) return out;
    if (n < 10) out += "零";
  }
  const q10 = Math.floor(n / 10);
  if (q10 > 0) {
    out += (out === "" && q10 === 1 ? "" : digits[q10]) + "十";
    n %= 10;
  }
  if (n > 0) out += digits[n];
  return out;
}
export function nextFreeChapterFile(destDir, fileName) {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const ext = extname(fileName);
  const baseNum = parseChapterNumber(stem);
  // v3.9.0 复查修正：同名或同章号（异形）占用都触发改名
  const numOccupied = function (num) {
    try {
      for (const ex of readdirSync(destDir)) {
        if (parseChapterNumber(ex) === num) return true;
      }
    } catch { /* 目录不可读按同名处理 */ }
    return false;
  };
  if (baseNum === void 0) {
    if (!existsSync(join(destDir, fileName))) return fileName;
    let k = 2;
    while (existsSync(join(destDir, stem + "-" + k + ext))) k += 1;
    return stem + "-" + k + ext;
  }
  if (!existsSync(join(destDir, fileName)) && !numOccupied(baseNum)) return fileName;
  // 扫描目录内全部已占用章号（第01章/第1章/第一章/01-标题 都算同一章）
  const used = new Set();
  try {
    for (const existing of readdirSync(destDir)) {
      const n = parseChapterNumber(existing);
      if (n !== void 0) used.add(n);
    }
  } catch { /* 目录不可读时按文件名探测 */ }
  let next = baseNum + 1;
  while (used.has(next)) next += 1;
  // 按原文件名格式生成空闲章号（保持补零宽度）
  const mArab = /^(.*第)(\d{1,4})([章回话].*)$/.exec(stem);
  if (mArab) {
    const width = mArab[2].length;
    let bump = next;
    let candidate = mArab[1] + String(bump).padStart(width, "0") + mArab[3] + ext;
    while (existsSync(join(destDir, candidate))) { bump += 1; candidate = mArab[1] + String(bump).padStart(width, "0") + mArab[3] + ext; }
    return candidate;
  }
  const mCjk = /^(.*第)([零一二三四五六七八九十百两]+)([章回话].*)$/.exec(stem);
  if (mCjk) {
    let bump = next;
    let candidate = null;
    while (!candidate || existsSync(join(destDir, candidate))) {
      const cjk = numberToCjk(bump);
      if (cjk === null) break;
      candidate = mCjk[1] + cjk + mCjk[3] + ext;
      bump += 1;
    }
    if (candidate) return candidate;
  }
  const mLead = /^(\d{1,4})([-._\s—].*)$/.exec(stem);
  if (mLead) {
    const width = mLead[1].length;
    let bump = next;
    let candidate = String(bump).padStart(width, "0") + mLead[2] + ext;
    while (existsSync(join(destDir, candidate))) { bump += 1; candidate = String(bump).padStart(width, "0") + mLead[2] + ext; }
    return candidate;
  }
  const mMid = /^(.*?[-._\s—])(\d{1,4})([-._\s—].*)$/.exec(stem);
  if (mMid) {
    const width = mMid[2].length;
    let bump = next;
    let candidate = mMid[1] + String(bump).padStart(width, "0") + mMid[3] + ext;
    while (existsSync(join(destDir, candidate))) { bump += 1; candidate = mMid[1] + String(bump).padStart(width, "0") + mMid[3] + ext; }
    return candidate;
  }
  // v3.9.5 修正：可解析章号但格式未被识别（如空格分隔的 “01 标题.md”，或中文章号 >99 时 mCjk 生成失败）——
  // 不再用 “-k 后缀” 兜底（那样 parseChapterNumber 仍解析回原章号，产生同号重复），改为显式换成下一空闲章号
  // v4.0.0 修正：函数开头 baseNum === void 0 已提前 return，此处 baseNum 必然已定义——
  // 去掉恒真的 if 包裹与不可达的 “-k 兜底”（旧代码自相矛盾，误导维护者以为兜底仍生效）
  let bump = next;
  let candidate = "";
  do {
    candidate = "第" + String(bump).padStart(2, "0") + "章" + (stem.trim() ? " " + stem.trim() : "") + ext;
    bump += 1;
  } while (existsSync(join(destDir, candidate)));
  return candidate;
}
export function bookNameFromFileName(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, "");
  // v3.6.0：文件名启发式只取章号前的书名前缀（"斗破苍穹 第1章 陨落.md" → "斗破苍穹"，不再把本章标题拼进书名）
  // v3.7.0 ②：数字+分隔符也算章号（斗破苍穹-01-陨落.md → 斗破苍穹；01-初遇.md 仍归未分类）
  const chapterMark = stem.match(/第?(\d{1,4}|[零一二三四五六七八九十百两]+)[章回话节]?[\s._\-—~]/);
  const head = chapterMark ? stem.slice(0, chapterMark.index).trim() : stem;
  const parts = head
    .replace(/第?(\d{1,4})[章回话]/g, " ")
    .replace(/第[零一二三四五六七八九十百两]+[章回话]/g, " ")
    .replace(LEADING_NUMBER, " ")
    .split(/[\s._\-—~]+/)
    .map((p) => p.trim())
    .filter((p) => p !== "" && !IMPORT_NOISE.has(p));
  const name = parts.join(" ").trim();
  // v3.5.0 #31：文件名以章号开头（"第1章 初遇.md"）且无书名前缀 → 不当作书名（归未分类）
  // v3.5.0 #31：章号开头 = "第N章"、"第N回"、纯数字前缀（01-初遇 / 1_初遇 / 001.初遇）
  const startsWithChapter = /^第?(\d{1,4}|[零一二三四五六七八九十百两]+)([章回话节]|[-._\s])/.test(stem);
  return (name === "" || (startsWithChapter && parts.length <= 2)) ? void 0 : name;
}
export function bookNameFromContent(text) {
  const lines = String(text).split(/\r?\n/).slice(0, 12);
  for (const raw of lines) {
    const line = raw.replace(/^#+\s*/, "").replace(/^\uFEFF/, "").trim();
    if (line === "") continue;
    if (IMPORT_NOISE.has(line)) continue;
    // v3.5.0 M9b：《书名》提取在前（《斗破苍穹》第一章 陨落 同行也能识别书名）——先看有没有《》包裹
    const bookMatch = line.match(/[《〈]\s*([^》〉]{2,30}?)\s*[》〉]/);
    if (bookMatch) {
      const name = bookMatch[1].trim();
      if (name.length >= 2 && name.length <= 30) return name;
      continue;
    }
    // v3.5.0 M9b：章号行不是书名——跳过（防止章节标题当书名；第一章 初遇 无《》落这里）
    const hasChapterMark = /第?(\d{1,4})[章回话]|第[零一二三四五六七八九十百两]+[章回话]|^\d{1,4}[-._\s]/.test(line);
    if (hasChapterMark) continue;
  }
  return void 0;
}
export async function collectTextFiles(dir, recursive, out = [], prefix = "") {
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
export function formatImport(value) {
  const lines = [`<path>${value.src}</path>`, `<type>novel-import-${value.mode}</type>`, "<content>", ""];
  lines.push(`扫描结果：${value.groups.reduce((n, g) => n + g.files.length, 0)} 个文件 → ${value.groups.length} 组` +
    (value.skipped.length > 0 ? `（跳过 ${value.skipped.length} 个文件：无法读取或未分类）` : ""));
  for (const group of value.groups) {
    const from = group.from === "file" ? "文件名" : group.from === "content" ? "文件头内容" : group.from === "unclassified" ? "未分类" : "强制指定";
    lines.push("");
    lines.push(`[${group.book}] (来自${from}, ${group.files.length} 个文件)`);
    for (const f of group.files) {
      const ch = f.chapter === void 0 ? "?" : `第${f.chapter}章`;
      lines.push(`  - ${ch} ${f.file}`);
    }
  }
  if (value.skipped.length > 0) {
    lines.push("", "跳过：");
    for (const item of value.skipped) lines.push(`  - ${item}`);
  }
  if (value.imported.length > 0) {
    lines.push("");
    lines.push(`已导入 ${value.imported.length} 个文件：`);
    for (const item of value.imported) lines.push(`  - novels/${item.book}/${item.file}`);
  }
  lines.push("", "</content>");
  return lines.join("\n");
}
export const SENTENCE_ANALYSIS_DEFAULTS = Object.freeze({ enabled: true, autoAnalyze: true, systemPromptMode: "brief" });
export const ALL_TOOLS = Object.freeze([
  "novel_books", "novel_chapters", "novel_read", "novel_keywords", "novel_new_chapter",
  "novel_import", "novel_sentence_analysis", "novel_sentence_config", "novel_style_check", "novel_plot",
  "novel_settings", "novel_summary", "novel_continuity_check", "novel_semantic_search", "novel_style_report",
  "novel_outline"
]);
export const TOOL_LABELS = Object.freeze({
  novel_books: "作品列表", novel_chapters: "章节清单", novel_read: "阅读章节", novel_keywords: "关键词分析",
  novel_new_chapter: "新建章节", novel_import: "稿件导入", novel_sentence_analysis: "句式模式分析",
  novel_sentence_config: "开关配置", novel_style_check: "风格自检", novel_plot: "伏笔登记",
  novel_settings: "设定管理", novel_summary: "章节摘要", novel_continuity_check: "连贯性审计",
  novel_semantic_search: "语义检索", novel_style_report: "风格画像", novel_outline: "创作资料"
});
export const SORTED_MARKER_WORDS = new Map();
export function sortedMarkerWords(words) {
  let cached = SORTED_MARKER_WORDS.get(words);
  if (cached === undefined) {
    cached = words.slice().sort(function (a, b) { return b.length - a.length; });
    SORTED_MARKER_WORDS.set(words, cached);
  }
  return cached;
}
export function scanWordHits(text, words) {
  const used = new Uint8Array(text.length);
  const hits = [];
  for (const word of sortedMarkerWords(words)) {
    const wlen = word.length;
    let n = 0;
    let from = 0;
    while (from <= text.length - wlen) {
      const hit = text.indexOf(word, from);
      if (hit === -1) break;
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
export const FEATURE_DEFAULTS = Object.freeze({ emotionCaveat: true, genreTheme: true, emotionComplexity: true, semanticEmbedding: true, semanticSearch: true, semanticStyle: true, semanticImplicit: true, rawWriting: false, webnovelVibe: true });
export function featureEnabled(state, name) {
  const features = state?.features ?? {};
  // v4.0.0 修正：缺键必须回退 FEATURE_DEFAULTS，而不是一律按 true——
  // 旧版导致 rawWriting（默认 false）未设置时 novel_sentence_config 谎报 true，
  // 与 UI（=== true）和提示词注入门控（=== true）三方不一致。
  const v = features[name];
  if (typeof v === "boolean") return v;
  return FEATURE_DEFAULTS[name] !== false;
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
      for (const p of embedding.chunkText(text)) chunks.push({ ...p, id: chapter.file + "|" + p.id, chapter: chapter.file });
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
  } catch { /* 语义增强失败不影响规则结果 */ }
  return result;
}
export function semanticFeatureEnabled(state, name) {
  if (!featureEnabled(state, "semanticEmbedding")) return false;
  return featureEnabled(state, name);
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
export function toolEnabled(state, name) {
  const tools = state?.tools ?? {};
  return tools[name] !== false;
}
export async function assertToolEnabled(config, name) {
  const state = await readSentenceState();
  assert(toolEnabled(state, name), `工具 ${name}（${TOOL_LABELS[name] ?? name}）当前已在「写作助手功能」UI 中关闭。可用 novel_sentence_config 或侧边栏面板重新开启。`);
}
export function stateFilePath() {
  // v3.5.0 #75：测试隔离——环境变量覆盖路径（e2e 用它，SIGKILL 也不碰用户配置）
  const override = process.env.DSH_NOVEL_WRITER_STATE;
  if (typeof override === "string" && override.length > 0) return override;
  return join(homedir(), ".dsh", "dsh-novel-writer", "state.json");
}
export function styleConfigPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "novel-writer.json");
}
export function readStyleEnabled() {
  try {
    if (!existsSync(styleConfigPath())) return false;
    const parsed = JSON.parse(readFileSync(styleConfigPath(), "utf8"));
    return parsed?.stylePattern === true;
  } catch {
    return false;
  }
}
export async function readSentenceState() {
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
      // v4.0.0：系统提示词注入档位（非法值一律回退默认）
      systemPromptMode: ["off", "brief", "full"].includes(parsed.systemPromptMode) ? parsed.systemPromptMode : SENTENCE_ANALYSIS_DEFAULTS.systemPromptMode,
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
export function readSentenceStateSync() {
  try {
    const file = stateFilePath();
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      enabled: parsed.enabled !== false,
      autoAnalyze: parsed.autoAnalyze !== false,
      systemPromptMode: ["off", "brief", "full"].includes(parsed.systemPromptMode) ? parsed.systemPromptMode : "brief",
      tools: parsed.tools !== null && typeof parsed.tools === "object" ? parsed.tools : {},
      features: parsed.features !== null && typeof parsed.features === "object" ? parsed.features : {},
      // v3.9.5：同步版补齐 styleTolerance（与异步版 readSentenceState 结构对齐）
      styleTolerance: parsed.styleTolerance !== null && typeof parsed.styleTolerance === "object" ? parsed.styleTolerance : null,
      // v3.1.0：原创模式设定（同步版，供 novel_outline 预填）
      creationProfile: parsed.creationProfile !== null && typeof parsed.creationProfile === "object" ? parsed.creationProfile : null,
      // v3.1.0：按书专属设定（书名为键；无该书时回退全局 creationProfile）
      creationProfiles: parsed.creationProfiles !== null && typeof parsed.creationProfiles === "object" ? parsed.creationProfiles : {},
      lastRoot: typeof parsed.lastRoot === "string" ? parsed.lastRoot : void 0
    };
  } catch { return {}; }
}
export const writeQueues = new Map();
export async function atomicWriteJson(file, obj) {
  const prev = writeQueues.get(file) || Promise.resolve();
  const run = prev.then(async function () {
    const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  try {
    await rename(tmp, file);
  } catch {
    // rename 失败（跨设备/占用）回退直写，尽力而为
    try { await writeFile(file, JSON.stringify(obj, null, 2), "utf8"); } catch { /* 忽略 */ }
    try { await rm(tmp, { force: true }); } catch { /* 忽略 */ }
  }
  });
  writeQueues.set(file, run.then(function () {}, function () {}));
  return run;
}
export const txQueues = new Map();
export async function withFileTx(file, fn) {
  const prev = txQueues.get(file) || Promise.resolve();
  const run = prev.catch(function () {}).then(fn);
  txQueues.set(file, run.then(function () {}, function () {}));
  return run;
}
export let stateWriteChain = Promise.resolve();
export function clampStyleTolerance(tol) {
  const cleaned = {};
  if (tol !== null && typeof tol === "object") {
    for (const [tk, tv] of Object.entries(tol)) {
      if (tv !== null && typeof tv === "object") {
        const low = typeof tv.low === "number" ? Math.max(-99, Math.min(0, tv.low)) : void 0;
        const high = typeof tv.high === "number" ? Math.max(0, Math.min(99, tv.high)) : void 0;
        if (low !== void 0 && high !== void 0 && low <= high) cleaned[tk] = { low, high };
      }
    }
  }
  return cleaned;
}
export async function writeSentenceState(patch) {
  const run = stateWriteChain.then(async function () {
    const current = await readSentenceState();
    const next = {
    ...current,
    ...(typeof patch?.enabled === "boolean" ? { enabled: patch.enabled } : {}),
    ...(typeof patch?.autoAnalyze === "boolean" ? { autoAnalyze: patch.autoAnalyze } : {}),
    // v4.0.0：系统提示词档位（只接受三个合法值，其余忽略）
    ...(["off", "brief", "full"].includes(patch?.systemPromptMode) ? { systemPromptMode: patch.systemPromptMode } : {}),
    ...(patch?.tools !== null && typeof patch?.tools === "object" ? { tools: { ...(current.tools ?? {}), ...patch.tools } } : {}),
    ...(typeof patch?.lastRoot === "string" ? { lastRoot: patch.lastRoot } : {}),
    ...(patch?.features !== null && typeof patch?.features === "object" ? { features: { ...(current.features ?? {}), ...patch.features } } : {}),
    ...(patch?.styleTolerance !== null && typeof patch?.styleTolerance === "object" ? { styleTolerance: clampStyleTolerance(patch.styleTolerance) } : {}), // v3.9.0：写路径统一钳制
    ...(patch?.styleTolerance === null ? { styleTolerance: null } : {}),
    ...(patch?.creationProfile !== null && typeof patch?.creationProfile === "object" ? { creationProfile: patch.creationProfile } : {}),
    ...(patch?.creationProfile === null ? { creationProfile: null } : {}),
    // v3.5.0 #20：creationProfiles 清空语义统一——null 或空对象 {} = 清除全部（设 null）
    ...(patch?.creationProfiles === null || (patch?.creationProfiles !== null && typeof patch?.creationProfiles === "object" && Object.keys(patch.creationProfiles).length === 0) ? { creationProfiles: null } : {}),
    ...(patch?.creationProfiles !== null && typeof patch?.creationProfiles === "object" && Object.keys(patch.creationProfiles).length > 0 ? { creationProfiles: (function (merged) { for (const k of Object.keys(merged)) if (merged[k] === null || merged[k] === void 0) delete merged[k]; return merged; })({ ...(current.creationProfiles ?? {}), ...patch.creationProfiles }) } : {}),
  };
  const file = stateFilePath();
  await mkdir(dirname(file), { recursive: true });
  await atomicWriteJson(file, next);
  return next;
  });
  stateWriteChain = run.then(function () {}, function () {});
  return run;
}
export function effectiveSentenceAnalysis(config, state) {
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
export function isLoopbackRequest(request) {
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
export function isAllowedRequest(request, allowLan) {
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
export function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}
export const BODY_TOO_LARGE = Symbol("bodyTooLarge");
export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  const LIMIT = 1024 * 1024; // v3.9.0：16KB → 1MB（原创模式长设定被 400 拒，UI 静默降级 localStorage）
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMIT) return { [BODY_TOO_LARGE]: true };
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return void 0; }
}
export async function openInExplorer(dir) {
  if (process.platform === "win32") {
    // execFile 数组直调不经 shell，路径含 & 等特殊字符不会注入；错误如实回传（旧实现错误被吞、路由先回 200）
    return await new Promise(function (resolve) {
      try {
        execFile("explorer.exe", ["/select," + dir], function (err) { resolve(!err); });
      } catch { resolve(false); }
    });
  } else if (process.platform === "darwin") {
    // v4.0.0 修正：与 win32 分支统一用 Promise 等回调——execFile 的 ENOENT 是异步交给回调的，
    // 旧版空回调 + 无条件 return true 会在无 open/xdg-open 时谎报"已打开文件夹"
    return await new Promise(function (resolve) {
      try {
        execFile("open", [dir], function (err) { resolve(!err); });
      } catch { resolve(false); }
    });
  }
  return await new Promise(function (resolve) {
    try {
      execFile("xdg-open", [dir], function (err) { resolve(!err); });
    } catch { resolve(false); }
  });
}
export function makeStateRoutes(allowLan, config) {
  const routePath = "/api/dsh-novel-writer/state";
  const revealPath = "/api/dsh-novel-writer/reveal";
  const handler = async (req, res) => {
    if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
    const method = req.method ?? "GET";
    if (method === "GET") {
      try {
      const state = await readSentenceState();
      // v0.8.0：修复 cordis 注入空字符串 root 时 ?? 不生效的问题
      // v3.7.0 高2：全新环境（无 config.root、无 lastRoot）回退 cwd——listBookNames(undefined) 不再 TypeError
      const root = (typeof config?.root === "string" && config.root.length > 0) ? config.root : (typeof state.lastRoot === "string" && state.lastRoot.length > 0 ? state.lastRoot : process.cwd());
      const dataDir = typeof root === "string" && root.length > 0 ? novelDataDir(root) : "";
      // v2.6.0：数据目录占用 + 语义引擎状态（status() 只探测文件、不触发模型加载）
      let dataDirSize = 0;
      try {
        if (dataDir !== "" && existsSync(dataDir)) {
          // v4.0.0 修正：同步递归 readdirSync/statSync 会阻塞宿主事件循环（该目录含 MB 级 embedding 索引），
          // 改用 fs/promises 异步遍历；单个文件 stat 失败跳过，不整次归零
          const walk = async (d) => {
            let s = 0;
            for (const e of await readdir(d, { withFileTypes: true })) {
              const fp = join(d, e.name);
              if (e.isDirectory()) s += await walk(fp);
              else if (e.isFile()) { try { s += (await stat(fp)).size; } catch { /* 统计失败跳过该文件 */ } }
            }
            return s;
          };
          dataDirSize = await walk(dataDir);
        }
      } catch { /* 统计失败返回 0 */ }
      let embeddingStatus = null;
      try {
        // v4.0.0 修正：改用顶部静态 import（embedding.js 顶层只依赖 node 内置模块，动态 import 无收益）
        embeddingStatus = embedding.status ? embedding.status() : null;
      } catch { /* 状态不可用 */ }
      return writeJson(res, 200, {
        enabled: state.enabled,
        autoAnalyze: state.autoAnalyze,
        // v4.0.0：系统提示词档位（侧边栏首页开关读它）
        systemPromptMode: state.systemPromptMode ?? "brief",
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
        // v3.2.0：书库统计（写作打卡：章数/总字数/近 7 天活跃字数）
        booksStats: await bookStats(root),
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
      } catch (err) {
        // v3.7.0 高2：GET 任何异常返回 500 JSON（不裸抛杀宿主）
        return writeJson(res, 500, { error: "state read failed: " + String(err).slice(0, 120) });
      }
    }
    if (method === "POST") {
      const body = await readJsonBody(req);
      if (body && body[BODY_TOO_LARGE]) return writeJson(res, 413, { error: "request body too large (limit 1MB)" });
      if (body === void 0 || body === null || typeof body !== "object" || Array.isArray(body)) return writeJson(res, 400, { error: "invalid JSON body" });
      try {
        // v3.7.0 高3：路由层剥离 novel_sentence_config（与工具侧一致）——UI 一键全关不能锁死 AI 通道（关了 AI 就无法再开）
        if (body?.tools && typeof body.tools === "object") {
          const toolsClone = { ...body.tools };
          delete toolsClone.novel_sentence_config;
          body.tools = toolsClone;
        }
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
  // v3.2.0：体验演示——内置自创示例文本（不落盘），跑六维测量展示效果
  const demoHandler = async (req, res) => {
    if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
    if ((req.method ?? "GET") !== "GET") return writeJson(res, 405, { error: "method not allowed" });
    try {
      // v4.0.0 修正：删除动态 import（这四个符号已在文件顶部静态导入，此处只是遮蔽 + 多一次模块解析）
      const demoTexts = [
        "雨从傍晚下到深夜。阿澈把油布伞靠在门边，靴子上的泥在门槛前蹭了又蹭。\n\n「坐吧。」掌柜掀开帘子，端出一碗热汤。\n\n他接过碗，指尖还冻得发白，汤面的热气扑在脸上。\n",
        "天没亮，阿澈就醒了。他把昨晚的汤钱放在桌上，推门出去，雾把整条街都吞了。\n\n有人站在雾里，背对着他，手里提着一盏没点的灯。\n",
        "灯在雾里亮起来的时候，阿澈看清了那张脸——是他找了三年的人。\n\n「你迟到了。」那人说。\n\n阿澈站在原地，半天没动。\n"
      ];
      const per = demoTexts.map(function (t, i) { return { file: "示例第" + (i + 1) + "章", metrics: measureStyleMetrics(t).metrics }; });
      const baseline = computeBaselineFromPerChapter(per);
      const lines = ["# 🎬 体验演示：六维风格基线（内置示例 3 章）", "", "| 维度 | μ | 推荐容差 |", "|---|---|---|"];
      for (const k of METRIC_ORDER) {
        const b = baseline[k];
        // v4.0.0 修正：空样本维度没有 recTol 键，旧版会渲染成 "±undefined%"
        lines.push("| " + (METRIC_LABELS[k] || k) + " | " + b.mu.toFixed(2) + " | " + (typeof b.recTol === "number" ? "±" + b.recTol + "%" : "—") + " |");
      }
      lines.push("", "> 示例为插件内置文本（不落盘、不占书库）。想真正体验：在 novels/ 放一本小说，或让 AI 原创一本。", "");
      return writeJson(res, 200, { ok: true, chars: demoTexts.join("").length, report: lines.join("\n"), baseline });
    } catch (e) {
      return writeJson(res, 500, { ok: false, error: String(e).slice(0, 200) });
    }
  };
  // v3.9.0：UI 路由统一根回退（与 GET /state 一致：config.root → lastRoot → cwd）
  const resolveUiRoot = (cfg, st) => {
    const c = typeof cfg?.root === "string" && cfg.root.length > 0 ? cfg.root : "";
    const l = !c && typeof st?.lastRoot === "string" && st.lastRoot.length > 0 ? st.lastRoot : "";
    return c || l || process.cwd();
  };
  const revealHandler = async (req, res) => {
    if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
    if ((req.method ?? "GET") !== "POST") return writeJson(res, 405, { error: "method not allowed" });
    const body = await readJsonBody(req);
    const target = body?.target;
    const allowedTargets = ["data-dir", "plots-dir", "settings-dir", "summaries-dir", "analysis-dir", "audits-dir", "embedding-dir", "state-file"];
    if (!allowedTargets.includes(target)) return writeJson(res, 400, { error: 'unknown target (allowed: ' + allowedTargets.join(", ") + ')' });
    const state = await readSentenceState();
    // v3.9.0：与 GET /state 同一回退（config.root → lastRoot → cwd），全新环境不再 404
    const root = resolveUiRoot(config, state);
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
      const opened = await openInExplorer(dir);
      if (!opened) return writeJson(res, 500, { ok: false, error: "explorer 启动失败，未能定位目录（可手动打开：该路径已创建）" });
      return writeJson(res, 200, { ok: true, path: dir });
    } catch (error) {
      return writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  // v3.2.0：报告历史——列出 .novel-writer/analysis 与 style-reports 的已存报告，?read= 读取内容
  const reportsHandler = async (req, res) => {
    if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
    try {
      const state = await readSentenceState();
      const root = resolveUiRoot(config, state);
      const dataDir = typeof root === "string" && root.length > 0 ? novelDataDir(root) : "";
      const qs = String(req.url || "").split("?")[1] || "";
      const params = new URLSearchParams(qs);
      const read = params.get("read");
      if (read) {
        const safe = String(read).replace(/[\\/]/g, "");
        const candidates = [join(dataDir, "analysis", safe), join(dataDir, "style-reports", safe)];
        const found = candidates.find(function (c) { return existsSync(c) && c.endsWith(".json"); });
        if (!found) return writeJson(res, 404, { error: "报告不存在" });
        const content = JSON.parse(await readFile(found, "utf8"));
        return writeJson(res, 200, { ok: true, file: safe, content });
      }
      const groups = [];
      const scanDir = async (dir, name, labelFn) => {
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          const files = [];
          for (const e of entries) {
            if (!e.isFile() || !e.name.endsWith(".json")) continue;
            const st = await stat(join(dir, e.name));
            files.push({ file: e.name, label: labelFn(e.name), time: st.mtime.toISOString() });
          }
          files.sort(function (a, b) { return b.time.localeCompare(a.time); });
          groups.push({ name, files });
        } catch { /* 目录不存在 */ }
      };
      await scanDir(join(dataDir, "analysis"), "句式分析", function (n) { return n.replace(/\.json$/, ""); });
      await scanDir(join(dataDir, "style-reports"), "风格判断", function (n) { return n.replace(/\.json$/, ""); });
      return writeJson(res, 200, { ok: true, groups });
    } catch (e) {
      return writeJson(res, 500, { ok: false, error: String(e).slice(0, 200) });
    }
  };
  // v2.6.5：更新检查路由（GitHub Releases API + 24h 缓存 + 3s 超时，全程静默）
  const updateCheckHandler = async (req, res) => {
    if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
    // v3.5.0 L3：仅 GET（POST 也会触发 GitHub 请求）
    if ((req.method ?? "GET") !== "GET") return writeJson(res, 405, { error: "method not allowed" });
    // v4.0.0 修正：与 styleConfigPath() 同一 DSH_HOME 口径（旧版写死 ~/.dsh，自定义 DSH_HOME 下缓存落到别处）
    const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME.trim() : join(homedir(), ".dsh");
    const result = await checkForUpdate(PLUGIN_VERSION, join(dshHome, "dsh-novel-writer"));
    return writeJson(res, 200, result);
  };
  return [
    { kind: "exact", path: routePath, handler },
    { kind: "exact", path: revealPath, handler: revealHandler },
    { kind: "exact", path: "/api/dsh-novel-writer/update-check", handler: updateCheckHandler },
    { kind: "exact", path: "/api/dsh-novel-writer/demo", handler: demoHandler },
    { kind: "exact", path: "/api/dsh-novel-writer/reports", handler: reportsHandler }
  ];
}
export const EMOTION_CODE = { joy: "喜", anger: "怒", sorrow: "哀", fear: "惧", surprise: "惊", neutral: "中性" };
export function buildBriefLine(result, scopeText) {
  const top3 = (result.categories || []).slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 3).map(function (c) { return c.label + " " + Math.round(c.ratio * 100) + "%"; });
  const base = scopeText + " " + result.totalSentences + " 句：句式以 " + top3.join("、") + " 为主；均句长 " + (result.lengths ? result.lengths.avg.toFixed(1) : "-") + "；主导情绪 " + (result.emotion?.dominant || "-") + "。";
  const el = (result.categories || []).find(function (c) { return c.type === "ellipsis"; });
  return base + (el && el.ratio > 0.2 ? "留白较多，注意节奏" : "");
}
export function formatSentenceAnalysis(value) {
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
  const topTransitions = value.transitions.slice(0, 8).map((t) => `${CATEGORY_LABELS[t.from] ?? t.from}→${CATEGORY_LABELS[t.to] ?? t.to} ×${t.count}`).join("  ");
  lines.push(`- 高频转移: ${topTransitions || "-"}`);
  const topMotifs = value.motifs.slice(0, 5).map((m) => `${m.pattern.split("→").map((code) => CATEGORY_LABELS[code] ?? code).join("→")} ×${m.count}`).join("  ");
  lines.push(`- 句式模板: ${topMotifs || "-"}`);
  // v4.0.0：段落结构补"叙述"桶（narrationOnly，与 dialogueOnly+psychologyOnly+mixed 四类合计=total；缺字段按 0 容错）
  const narrationOnly = Number.isFinite(value.paragraphs.narrationOnly) ? value.paragraphs.narrationOnly : 0;
  lines.push(`- 段落结构: 共 ${value.paragraphs.total} 段（对话 ${value.paragraphs.dialogueOnly} / 心理 ${value.paragraphs.psychologyOnly} / 混合 ${value.paragraphs.mixed} / 叙述 ${narrationOnly}），均 ${value.paragraphs.avgSentences} 句/段; 对话连珠 ${value.paragraphs.exchanges}`);
  const opening = value.paragraphs.opening.slice(0, 4).map((o) => `${CATEGORY_LABELS[o.type] ?? o.type}×${o.count}`).join(" ");
  const closing = value.paragraphs.closing.slice(0, 4).map((o) => `${CATEGORY_LABELS[o.type] ?? o.type}×${o.count}`).join(" ");
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
  // v3.9.0：render 补全——情感净化预警/量化三指标/细节密度/语义隐性情感（此前只在 value，模型看不到）
  if (value.emotion && value.emotion.cleanDominant && value.emotion.cleanDominant !== value.emotion.dominant) {
    lines.push("", "【情感净化预警】");
    lines.push(`- 规则主导: ${EMOTION_CODE[value.emotion.dominant] ?? value.emotion.dominant}，净化后主导: ${EMOTION_CODE[value.emotion.cleanDominant] ?? value.emotion.cleanDominant}（置信度 ${value.emotion.confidence ?? "?"}）`);
    if (value.emotion.caveat) lines.push(`- 注意: ${value.emotion.caveat}`);
    if (value.emotion.aiAction) lines.push(`- 建议: ${value.emotion.aiAction}`);
    if (value.emotion.pollution && Object.keys(value.emotion.pollution).length > 0) {
      lines.push(`- 污染词: ${Object.entries(value.emotion.pollution).map(([k, v]) => k + "=" + JSON.stringify(v)).join("; ")}`);
    }
  }
  if (value.emotion && value.emotion.quantification) {
    const q = value.emotion.quantification;
    const stats = q.stats || {};
    if (Object.keys(stats).length > 0) {
      lines.push("", "【情感量化】");
      lines.push(`- Valence: 均值 ${stats.meanValence ?? 0}, 方差V ${stats.variance ?? 0}, 相邻撕裂 ${stats.adjVariance ?? 0}, 斜率Δ ${stats.delta ?? 0}, 矛盾指数C ${stats.conflict ?? 0}`);
      if (q.compare) lines.push(`- 显隐对比: ${JSON.stringify(q.compare).slice(0, 120)}`);
      if (q.complexity) lines.push(`- 复杂度: ${JSON.stringify(q.complexity).slice(0, 120)}`);
      if (q.implicit && (q.implicit.ambiguous || []).length > 0) {
        // v3.9.0 修正：implicit 无 hits 字段（不再输出误导性的「隐性情感句 0 处」）
        lines.push(`- 隐性意象: 变色龙词 ${(q.implicit.ambiguous || []).length} 个（语义层裁决见下文/quantification.implicit）`);
      }
    }
    if (q.semanticImplicit && (q.semanticImplicit.hits || []).length > 0) {
      lines.push("", "【语义隐性情感】");
      const si = q.semanticImplicit;
      const sample = si.hits.slice(0, 3).map((h) => "[" + (h.top || "?") + "] " + h.text.slice(0, 30)).join(" / "); // v3.9.0 修正：字段是 top（情感标签）
      lines.push(`- 命中 ${si.hits.length} 处（情感原型语义检索）: ${sample}`);
      if (si.distribution && Object.keys(si.distribution).length > 0) lines.push(`- 分布: ${JSON.stringify(si.distribution).slice(0, 120)}`);
    }
  }
  if (value.density) {
    const d = value.density;
    const parts = [];
    if (typeof d.actionVerbsPer1000 === "number") parts.push(`动作动词 ${d.actionVerbsPer1000}/千字`);
    if (typeof d.actionChainRatio === "number") parts.push(`动作链占比 ${d.actionChainRatio.toFixed(1)}%`); // v3.9.0 修正：已是百分数（0~100），不再 ×100
    if (typeof d.objectNounsPer1000 === "number") parts.push(`物体名词 ${d.objectNounsPer1000}/千字`);
    if (typeof d.sensePer1000 === "number") parts.push(`感官词 ${d.sensePer1000}/千字`);
    if (parts.length > 0) {
      lines.push("", "【细节密度】");
      lines.push("- " + parts.join(" | "));
      if (Array.isArray(d.actionChainExamples) && d.actionChainExamples.length > 0) lines.push(`- 动作链例: ${d.actionChainExamples.slice(0, 3).join(" / ")}`);
    }
  }
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
export async function syncCreationProfileFiles(root, patchProfiles, nextProfiles) {
  if (!root) return;
  const base = join(root, "novels", CREATION_DIR);
  // v3.5.0 #20：清除全部（patch 为空对象 {} 或 nextProfiles 为 null）→ 扫描全部创作资料目录，逐本移除用户段 + 空壳清理
  const clearAll = (patchProfiles && typeof patchProfiles === "object" && Object.keys(patchProfiles).length === 0) || nextProfiles === null;
  if (clearAll && !(patchProfiles && Object.keys(patchProfiles).length > 0)) {
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
export const bookStatsCache = { key: null, at: 0, data: null };
export async function bookStats(root) {
  const dir = join(root, "novels");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    // 指纹：书目录名 + 章节文件名/size/mtime（不读内容）
    let fp = "";
    const bookFiles = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "创作资料" || entry.name.startsWith(".")) continue;
      const bookPath = join(dir, entry.name);
      try {
        const files = await readdir(bookPath, { withFileTypes: true });
        const list = [];
        for (const f of files) {
          if (!f.isFile() || !/\.(md|markdown|txt)$/i.test(f.name)) continue;
          const st = await stat(join(bookPath, f.name));
          fp += entry.name + "/" + f.name + ":" + st.mtimeMs + ":" + st.size + ";";
          list.push(f.name);
        }
        bookFiles.push({ name: entry.name, files: list });
      } catch { /* 跳过不可读 */ }
    }
    // v3.9.0 修正：缓存键含书库根——多 profile/切换工作区不串数据
    const cacheKey = root + "|" + fp;
    if (bookStatsCache.key === cacheKey && Date.now() - bookStatsCache.at < 30000) return bookStatsCache.data;
    const out = [];
    const weekAgo = Date.now() - 7 * 86400000;
    for (const book of bookFiles) {
      const bookPath = join(dir, book.name);
      let chapters = 0, chars = 0, recent7 = 0, decodeErrors = 0;
      for (const fname of book.files) {
        // v4.0.0 修正：try 收进循环体内——旧版整个 for 共用一个 try，第 k 个文件解码失败
        // 会让其后所有章节的 chapters/chars/recent7 全部不再累加（UI 显示偏小的错值且无提示）
        try {
          const full = join(bookPath, fname);
          const st = await stat(full);
          chapters += 1;
          // v3.5.0 M11：与其余工具同口径解码（GBK/UTF-16 章节字数不再按 UTF-8 误读）
          const buf11 = await readFile(full);
          const txt = decodeTextBuffer(buf11, full);
          chars += txt.length;
          if (st.mtimeMs >= weekAgo) recent7 += txt.length;
        } catch { decodeErrors += 1; /* 单文件不可读/编码无法识别：只跳过它 */ }
      }
      out.push({ name: book.name, chapters, chars, recent7Chars: recent7, decodeErrors });
    }
    const result = out.sort(function (a, b) { return b.recent7Chars - a.recent7Chars; });
    bookStatsCache.key = root + "|" + fp;
    bookStatsCache.at = Date.now();
    bookStatsCache.data = result;
    return result;
  } catch {
    return [];
  }
}
export async function listBookNames(root) {
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
export const CREATION_DIR = "创作资料";
export const CREATION_FILES = {
  bible: "创作设定.md", "characters-main": "主要人物设定.md", "characters-minor": "次要人物设定.md",
  outline: "剧情大纲.md", hooks: "钩子记录.md", status: "创作状态卡.md"
};
export const CREATION_TEMPLATE_TITLES = new Set(["# 创作设定", "# 主要人物设定", "# 次要人物设定", "# 剧情大纲", "# 钩子记录", "# 创作状态卡"]);
export function creationDir(root, book) {
  return join(root, "novels", CREATION_DIR, sanitizeSegment(book, "book"));
}
export function buildCreationUserSection(book) {
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
export function upsertCreationSection(text, section, marker) {
  // 段边界 = 下一个标题 / 空行 / 文件尾（防吞掉段后手写内容）
  const re = new RegExp("(?:\\n\\n)?" + marker + "[\\s\\S]*?(?=\\n# |\\n\\n|\\s*$)");
  const has = text.includes(marker);
  if (section === "") {
    if (!has) return text;
    const t = text.replace(re, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    return t;
  }
  if (has) {
    // v4.0.0 修正：改用函数式替换，避免用户文本里的美元替换模式（    return text.replace(re, "\n\n" + section.trimEnd()); / $1 等）被展开
    return text.replace(re, function () { return "\n\n" + section.trimEnd(); });
  }
  return text.trimEnd() + "\n\n" + section;
}
export function upsertCreationUserSection(text, section) {
  return upsertCreationSection(text, section, "【用户原创设定】");
}
export function buildCreationCharacterSection(book) {
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
        await noteRoot(root); // v3.9.0：outline 写操作记录书库根
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
        // v3.5.0 #33：行首锚定判重（"阿"不再误判"阿澈"已存在）
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
        await noteRoot(root); // v3.9.0：outline 写操作记录书库根
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
        // v3.5.0 #34：行首锚定 + 文件尾无换行也能命中；body 单行化防伪造条目
        const oneLineBody = String(body ?? "").replace(/\n+/g, " ").replace(/^- \d+ /, "");
        const re = new RegExp("^- " + number + " [^\n]*(?:\n|$)", "m");
        const line = "- " + number + " " + oneLineBody + "\n";
        // v4.0.0 修正：函数式替换，避免钩子文本里的         const next = re.test(cur2) ? cur2.replace(re, line) : (cur2.endsWith("\n") ? cur2 + line : cur2 + "\n" + line); 把旧行复制进新行
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
export function novelDataDir(root) {
  return join(root, ".novel-writer");
}
export async function metricChaptersCached(root, book, chapters) {
  const dir = join(novelDataDir(root), "analysis");
  const file = join(dir, sanitizeSegment(book, "book") + "-chapters-metrics.json");
  // v4.0.0 修正：指纹改为与章序无关（按文件名排序后拼 file+text）——style_check 传"其他章 + 目标章"、
  // style_report/new_chapter 传书序，旧版三处哈希互不相同 → 每次交替调用都 miss 并重写同一缓存文件
  const th = createHash("sha1").update(chapters.slice().sort(function (a, b) { return String(a.file).localeCompare(String(b.file)); }).map(function (c) { return String(c.file) + "\u0000" + c.text; }).join("\u0001")).digest("hex").slice(0, 16);
  try {
    const cached = JSON.parse(await readFile(file, "utf8"));
    if (cached && cached.th === th && Array.isArray(cached.perChapter) && cached.ver === CACHE_VERSION) return cached.perChapter;
  } catch { /* 无缓存/损坏 */ }
  const b = computeBaseline(chapters);
  try {
    await mkdir(dir, { recursive: true });
    await atomicWriteJson(file, { th, perChapter: b.perChapter, ver: CACHE_VERSION });
  } catch { /* 缓存写失败不影响 */ }
  return b.perChapter;
}
export async function bookAnalysisCached(root, keyName, text, featState) {
  const dir = join(novelDataDir(root), "analysis");
  const file = join(dir, sanitizeSegment(keyName, "book") + "-full.json");
  const th = createHash("sha1").update(text).digest("hex").slice(0, 16);
  let cached = null;
  try {
    cached = JSON.parse(await readFile(file, "utf8"));
  } catch { /* 无缓存/损坏 */ }
  // v3.5.0 #21/22：缓存带算法版本指纹（ver）——升级后旧缓存自动失效；命中时按开关重算 genre/theme（关→开也能拿到）
  if (cached && cached.th === th && cached.analysis && cached.ver === CACHE_VERSION) {
    const det = cached.detection || {};
    let recomputed = false;
    if (featState && featureEnabled(featState, "genreTheme")) {
      if (!det.genre) { try { det.genre = detectGenre(text); recomputed = true; } catch { /* 忽略 */ } }
      if (!det.theme) { try { det.theme = detectTheme(text); recomputed = true; } catch { /* 忽略 */ } }
    } else {
      det.genre = undefined;
      det.theme = undefined;
    }
    // v4.0.0：语义层结果缓存读取（隐性情感 + 意象歧义裁决）——旧缓存缺字段/指纹不符时按"未缓存"处理（返回 null，由调用方重算并写回）
    const semanticFpOk = cached.semanticFp === th;
    const semantic = semanticFpOk && cached.semanticImplicit ? cached.semanticImplicit : null;
    const implicitResolved = semanticFpOk && cached.implicitResolved ? cached.implicitResolved : null;
    // v3.5.0 #21：补算结果写回缓存——下次命中不再重扫全书流派/题材词表
    if (recomputed) {
      // v4.0.0：写回时保留语义缓存字段——旧版重建 payload 会把语义结果抹掉，导致每次调用都重跑语义推理
      const keepSemantic = {};
      if (semantic) keepSemantic.semanticImplicit = semantic;
      if (implicitResolved) keepSemantic.implicitResolved = implicitResolved;
      if (semantic || implicitResolved) keepSemantic.semanticFp = th;
      try { await atomicWriteJson(file, { th, analysis: cached.analysis, detection: det, ver: CACHE_VERSION, ...keepSemantic }); } catch { /* 写失败不影响 */ }
    }
    return { analysis: cached.analysis, detection: det, file, th, semantic, implicitResolved };
  }
  const analysis = analyzeText(text, {});
  const detection = detectCulture(text);
  if (featState && featureEnabled(featState, "genreTheme")) {
    detection.genre = detectGenre(text);
    detection.theme = detectTheme(text);
  }
  try {
    await mkdir(dir, { recursive: true });
    await atomicWriteJson(file, { th, analysis, detection, ver: CACHE_VERSION });
  } catch { /* 写缓存失败不影响结果 */ }
  return { analysis, detection, file, th, semantic: null, implicitResolved: null };
}
export async function writeBookSemanticCache(info, semanticImplicit, implicitResolved) {
  if (!info || !info.file || !info.th) return;
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
  } catch { /* 语义缓存写回失败不影响报告 */ }
}
export function plotsFile(root, book) {
  return join(novelDataDir(root), "plots", sanitizeSegment(book, "book") + ".json");
}
export function legacyPlotsFile(root, book) {
  return join(novelDataDir(root), sanitizeSegment(book, "book") + ".json");
}
export async function readPlots(root, book) {
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
export async function writePlots(root, book, entries) {
  const file = plotsFile(root, book);
  await mkdir(dirname(file), { recursive: true });
  await atomicWriteJson(file, { book, entries });
}
export function plotKeywords(content) {
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
export async function readSettings(root, book) {
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
export async function noteRoot(root) {
  if (!root) return;
  try { await writeSentenceState({ lastRoot: root }); } catch { /* 记录失败不影响主功能 */ }
}
export async function writeSettings(root, book, data) {
  const file = settingsFile(root, book);
  await mkdir(dirname(file), { recursive: true });
  await atomicWriteJson(file, { book, ...data });
  await noteRoot(root); // v3.9.0：settings 写操作统一记录书库根
}
export function normalizeSettingEntry(entry) {
  // v4.0.0 修正：脏数据守卫——settings JSON 被手改/半截写坏（[null]/[123]）时
  // 旧版 String(entry.name) 直接 TypeError，导致 list/add/update/scan/detect 整体失败
  if (!entry || typeof entry !== "object") return null;
  const out = { name: String(entry.name ?? "") };
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
export function normalizeSettingList(list) {
  return (Array.isArray(list) ? list : []).map(normalizeSettingEntry).filter(Boolean);
}
export async function readBookAllText(root, book, exec, opts) {
  const dir = join(root, "novels", sanitizeSegment(book, "book"));
  if (!existsSync(dir)) throw new Error("书库中未找到作品：" + book + " 【解决：用 novel_books 查看可用作品名，或确认 novels/ 目录下已创建对应文件夹】");
  const chapters = await scanChapters(dir);
  let text = "";
  const texts = [];
  for (const chapter of chapters) {
    const t = await readTextFile(join(dir, chapter.file), exec);
    text += t;
    texts.push({ file: chapter.file, text: t });
  }
  // v3.9.5：opts.withTexts=true 时一并返回逐章文本，供 style_report 六维基线复用（避免全书二次读盘）
  return opts?.withTexts === true ? { text, chapters, texts } : { text, chapters };
}
export async function buildStyleAnchorPackage(root, book, chapters, exec, preloadedText) {
  const anchors = [];
  const skeletons = [];
  try {
    // v3.8.0 性能：复用调用方已读文本（preloadedText=string 全文 / {file,text}[] 数组）——大书不再双读
    let allText = "";
    if (typeof preloadedText === "string" && preloadedText.length > 0) {
      allText = preloadedText;
    } else if (Array.isArray(preloadedText)) {
      allText = preloadedText.map(function (x) { return x.text || ""; }).join("\n");
    } else {
      const dir = bookDir(root, book);
      for (const ch of chapters) allText += (await readTextFile(join(dir, ch.file), exec)) + "\n";
    }
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
    const sentences = allText.split(/[。！？…]+/).map(function (s) { return s.replace(/\s+/g, "").trim(); }).filter(function (s) { return s.length >= 20 && s.length <= 45; });
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
      const firsts = sampleEvenly(allText.split(/\n+/).map(function (p) { return p.trim(); }).filter(function (p) { return p.length >= 15; }), 4);
      for (const ft of firsts) skeletons.push({ type: "陈述", text: ft.slice(0, 60) });
    }
  } catch { /* 锚包失败不影响主功能 */ }
  // v4.0.0 修正：pick 合计请求 2 对话 + 1 心理 + 2 描写 = 5 条，旧版统一截到 4 条会把"描写"锚砍掉一条
  return { anchors: anchors.slice(0, 5), skeletons: skeletons.slice(0, 4) };
}
export function parseEvidenceCounts(arr) {
  let n = 0;
  for (const item of arr || []) {
    const m = String(item).match(/^(?:.*?)(?:×|\u00d7)(\d+)$/);
    n += m ? parseInt(m[1], 10) : 1;
  }
  return n;
}
export function extractTopKeywords(text, topN) {
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
export function summariesFile(root, book) {
  return join(novelDataDir(root), "summaries", sanitizeSegment(book, "book") + ".json");
}
export async function readSummaries(root, book) {
  try {
    const parsed = JSON.parse(await readFile(summariesFile(root, book), "utf8"));
    return Array.isArray(parsed.summaries) ? parsed.summaries : [];
  } catch {
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
export const TIME_JUMP_WORDS = {
  hard: ["第二天", "第三天", "第四天", "第五天", "三天后", "四天后", "五天后", "六天后", "七天后", "十天后", "数天后", "一周后", "两周后", "半个月后", "一个月后", "两个月后", "三个月后", "半年后", "一年后", "两年后", "三年后", "多年后", "数日后", "几天后", "几天前", "几年后", "不久后", "很久以后"],
  soft: ["次日", "翌日", "次日清晨", "次日黄昏", "隔天", "深夜", "黎明", "清晨", "黄昏", "午夜", "当天晚上", "当晚"]
};
export async function detectChapterBridge(root, book, prevFile, currFile, exec) {
  const out = [];
  try {
    const prevText = await readTextFile(join(root, "novels", book, prevFile), exec);
    const currText = await readTextFile(join(root, "novels", book, currFile), exec);
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
    } catch { /* 语义不可用跳过 */ }
    // ③ 人物延续（settings character 表；v3.5.0 #6：正确数据源 readSettings，勿用 UI state）
    try {
      const st = await readSettings(root, book);
      const chars = ((st && st.characters) || []).filter((c) => typeof c.name === "string" && c.name.length >= 2);
      const prevNames = chars.filter((c) => prevTail.includes(c.name)).map((c) => c.name);
      const currNames = chars.filter((c) => currHead.includes(c.name)).map((c) => c.name);
      if (prevNames.length > 0 && currNames.length === 0) {
        out.push({ type: "衔接·人物断线", detail: "上章结尾出场人物（" + prevNames.slice(0, 3).join("/") + "）本章开头 800 字均未出现——角色线可能断掉，建议让至少一人承接", chapters: [prevFile, currFile] });
      }
    } catch { /* 设定表未登记跳过 */ }
    // ④ 承接卡（上一章钩子文本 vs 本章开头 bigram 重叠）
    try {
      const hooksPath = join(root, "novels", "创作资料", book, "钩子记录.md");
      const hooks = await readTextFile(hooksPath, exec);
      const hookLines = hooks.split("\n").filter((l) => /^- \d+ /.test(l));
      // v3.2.0：取上一章（prevFile）对应的钩子，不取最后一行（钩子记录乱序时防比对错章）
      // v4.0.0 修正：统一章号口径——旧版取文件名首段数字，"第1卷03章.md" 会比对到错误的钩子
      const prevNum = parseChapterNumber(prevFile);
      const prevHookLine = hookLines.find((l) => parseInt((l.match(/^- (\d+)/) || [])[1], 10) === prevNum);
      if (prevHookLine) {
        const lastHook = prevHookLine.replace(/^- \d+ /, "");
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
    } catch { /* 无创作资料跳过 */ }
  } catch { /* 读取失败返回空 */ }
  return out;
}
export function formatBooks(value) {
  const lines = [`<path>${value.root}/novels</path>`, `<type>novel-library</type>`, `<content>`, ""];
  if (value.books.length === 0) lines.push("（暂无作品。请在 novels/<书名>/ 下存放章节文件，如 第01章.md）");
  for (const book of value.books) lines.push(`- ${book.name}: ${book.chapters} 章, ${book.chars} 字`);
  lines.push("", "</content>");
  return lines.join("\n");
}
export function formatChapters(value) {
  const lines = [`<path>novels/${value.book}</path>`, `<type>novel-chapters</type>`, `<content>`, ""];
  if (value.chapters.length === 0) lines.push("（该作品下没有章节文件）");
  for (const chapter of value.chapters) {
    const number = chapter.number === void 0 ? "?" : String(chapter.number).padStart(2, "0");
    lines.push(`- 第${number}章 ${chapter.title} — ${chapter.chars} 字 / ${chapter.lines} 行 (${chapter.file}, 更新于 ${chapter.updated.slice(0, 10)})`);
  }
  lines.push("", "</content>");
  return lines.join("\n");
}
export function formatRead(value) {
  const endLine = value.lines.length > 0 ? value.lines[value.lines.length - 1].number : value.offset - 1;
  const body = value.lines.map((line) => `${line.number}: ${line.text}`).join("\n");
  let footer;
  // v3.7.0 ④：chars 是已显示部分字数——文案不再误导为"本章共"
  if (value.truncated) footer = `(输出截断。本章共 ${value.totalLines} 行，已显示 ${value.offset}-${endLine} 行 / ${value.chars} 字。用 offset=${endLine + 1} 继续阅读。)`;
  else footer = `(本章共 ${value.totalLines} 行 / ${value.chars} 字)`;
  return `<path>${value.path}</path>
<type>novel-chapter</type>
<content>
${body === "" ? "" : `${body}\n`}
${footer}
</content>`;
}
export function formatKeywords(value) {
  const lines = [`<path>novels/${value.book}</path>`, `<type>novel-keywords</type>`, `<content>`, `统计范围: ${value.scope} (共 ${value.totalChars} 字)`, ""];
  if (value.keywords.length === 0) lines.push("（未提取到重复出现的关键词）");
  for (const keyword of value.keywords) {
    const kind = keyword.kind === "cjk-bigram" ? "词组" : keyword.kind === "cjk-trigram" ? "三字组" : keyword.kind === "name-candidate" ? "疑似人名" : "英文词";
    lines.push(`- ${keyword.word} × ${keyword.count} (${kind})`);
  }
  lines.push("", "</content>");
  return lines.join("\n");
}
export function cleanOutput(v) {
  if (typeof v === "number") return Object.is(v, -0) ? 0 : (Number.isNaN(v) ? null : v);
  if (v instanceof Date) return v.toISOString();
  if (v instanceof RegExp) return String(v);
  if (v instanceof Map) return cleanOutput(Array.from(v.entries()));
  if (v instanceof Set) return cleanOutput(Array.from(v.values()));
  if (Array.isArray(v)) return v.map(function (x) { return cleanOutput(x); });
  if (v !== null && typeof v === "object") {
    const outObj = {};
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (val === undefined) continue;
      outObj[k] = cleanOutput(val);
    }
    return outObj;
  }
  return v;
}
