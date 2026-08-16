/**
 * dsh-novel-writer — 小说写作助手插件
 *
 * 一个零第三方依赖的 cordis bundle 插件，为模型提供一套小说写作工具：
 *   - novel_books     列出章节库中的所有作品
 *   - novel_chapters  列出某部作品的章节清单（字数/行数/更新时间）
 *   - novel_read      阅读某个章节（带行号、字数统计、分段读取）
 *   - novel_keywords  确定性提取章节/全书高频关键词（中文词组+英文词）
 *   - novel_new_chapter 创建新章节文件
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { homedir } from "node:os";
import { TYPE_CODES, analyzePattern, buildGuidance, classifySentence, compressSequence, ratioMap, splitSentences } from "./pattern.js";

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

// ---- 原稿件导入 / 自动分类 ----

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

/** 从文件头内容提取书名候选：跳过噪音行，只认"含章号标记的标题行"（如"吸血鬼萝莉的魅魔系统 第一章"），
 *  清理章号后作为书名候选；找不到则返回 void 0（该文件将落入"未分类"组，由 AI 判断归属）。 */
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
    // 无章号标记的行不是章节标题行（可能是正文/随笔），跳过继续找
  }
  return void 0;
}

/** 扫描一个目录（递归）下的章节类文本文件，返回相对路径列表。 */
async function collectTextFiles(dir, recursive, out = [], prefix = "") {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (recursive) await collectTextFiles(join(dir, entry.name), recursive, out, rel);
    } else if (entry.isFile() && CHAPTER_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(rel);
    }
  }
  return out;
}

function registerNovelImport(ctx, config) {
  ctx.tools.register({
    name: "novel_import",
    description: "扫描一个存放大量原稿件文本的文件夹，自动识别并分类其中包含的小说章节：从文件名与文件头内容双通道提取书名候选与章号，聚合成分组建议；可执行复制/移动到章节库 novels/<书名>/ 分类存放。用于把混杂的多本小说稿件一键整理进书库。",
    parameters: {
      type: "object",
      properties: {
        src: { type: "string", description: "待导入的原稿件文件夹路径（可含多本小说的章节文本，支持子文件夹）。" },
        mode: { type: "string", enum: ["scan", "apply"], description: "scan=只分析并返回分组建议（默认，不写盘）；apply=按分组执行导入。" },
        book: { type: "string", description: "apply 时可选：强制把所有（或 files 指定的）文件归入该书名，用于合并异名同书（如\"萝莉/幼女\"两个书名候选实为同一本），或把\"未分类\"中的文件指定归属。" },
        files: {
          type: "array",
          items: { type: "string" },
          description: "apply 时可选：只处理这些文件（相对 src 的路径，如\"旧稿/第一章.txt\"）。省略则处理全部扫描到的文件。"
        },
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
          skipped: {
            type: "array",
            items: { type: "string" }
          },
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
      render: (_args, value) => [{
        type: "text",
        text: formatImport(value)
      }]
    },
    async execute(args, exec) {
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
        const nameFromFile = bookNameFromFileName(fileName);
        const nameFromContent = bookNameFromContent(text);
        rows.push({
          file: rel,
          chapter: parseChapterNumber(fileName),
          nameFromFile,
          nameFromContent
        });
      }
      // 分组：forcedBook > 文件名候选 > 内容候选 > 未分类。
      // 关键规则：只有"疑似章节文件"（文件名或内容含章号标记）才参与正常分组；
      // 无章号标记的文件（随笔/损坏/无关文档）一律归入"未分类"，由 AI 判断是否导入。
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
      groups.sort((a, b) => b.files.length - a.files.length || a.book.localeCompare(b.book));
      // apply：复制/移动到 novels/<book>/
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
            if (move) {
              await copyFile(srcFull, destFull);
              await rm(srcFull, { force: true });
            } else {
              await copyFile(srcFull, destFull);
            }
            imported.push({ book: safeBook, file: basename(row.file), path: destFull });
          }
        }
      }
      return { src, mode, groups, skipped, imported };
    }
  });
}

function formatImport(value) {
  const lines = [`<path>${value.src}</path>`, `<type>novel-import-${value.mode}</type>`, `<content>`, ""];
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
  assert(typeof value === "string" && value.trim() !== "", `invalid arguments: "${key}" must be a non-empty string`);
  return value.trim();
}
function optionalString(args, key) {
  const value = args?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function optionalInt(args, key, min, max, fallback) {
  const value = args?.[key];
  if (value === void 0) return fallback;
  assert(Number.isInteger(value) && value >= min && value <= max, `invalid arguments: "${key}" must be an integer between ${min} and ${max}`);
  return value;
}
/** 清洗书名/章节名，防止路径穿越。 */
function sanitizeSegment(value, label) {
  const cleaned = value.replace(/[\\/]/g, "");
  assert(cleaned.length > 0 && !["", ".", ".."].includes(cleaned), `invalid arguments: ${label} contains invalid path characters`);
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
  const cjkChars = new Map();
  const enWords = new Map();
  const cjkRun = [];
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjkRun.push(ch);
    else if (cjkRun.length > 0) {
      tallyCjkRun(cjkRun, cjkChars, cjkBigrams);
      cjkRun.length = 0;
    }
  }
  if (cjkRun.length > 0) tallyCjkRun(cjkRun, cjkChars, cjkBigrams);
  for (const match of text.toLowerCase().matchAll(/[a-z]{2,}/g)) {
    const word = match[0];
    if (!EN_STOP_WORDS.has(word)) enWords.set(word, (enWords.get(word) ?? 0) + 1);
  }
  const keywords = [];
  for (const [word, count] of cjkBigrams) {
    if (count > 1) keywords.push({ word, count, kind: "cjk-bigram" });
  }
  for (const [word, count] of enWords) {
    if (count > 1) keywords.push({ word, count, kind: "word" });
  }
  keywords.sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
  return keywords.slice(0, top);
}
function tallyCjkRun(run, cjkChars, cjkBigrams) {
  for (let i = 0; i < run.length; i += 1) {
    const ch = run[i];
    if (!CJK_STOP_CHARS.has(ch)) cjkChars.set(ch, (cjkChars.get(ch) ?? 0) + 1);
    if (i + 1 < run.length) {
      const bigram = run[i] + run[i + 1];
      const meaningful = !CJK_STOP_CHARS.has(run[i]) || !CJK_STOP_CHARS.has(run[i + 1]);
      if (meaningful) cjkBigrams.set(bigram, (cjkBigrams.get(bigram) ?? 0) + 1);
    }
  }
}

// ---- 工具定义 ----

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
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const chapterArg = requiredString(args, "chapter");
      const offset = optionalInt(args, "offset", 1, Number.MAX_SAFE_INTEGER, 1);
      const limit = optionalInt(args, "limit", 1, READ_LIMIT, READ_LIMIT);
      const root = resolveRoot(config, args, exec);
      const dir = bookDir(root, book);
      const chapters = await scanChapters(dir);
      const chapter = findChapter(chapters, chapterArg);
      assert(chapter !== void 0, `cannot find chapter "${chapterArg}" in book "${book}" (可用 novel_chapters 查看章节列表)`);
      const filePath = join(dir, chapter.file);
      const text = await readTextFile(filePath, exec);
      const allLines = text.split(/\r?\n/);
      const totalLines = allLines.length;
      assert(offset <= totalLines || (totalLines === 0 && offset === 1), `offset ${offset} is out of range for "${chapter.file}" (${totalLines} lines)`);
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
                kind: { type: "string", enum: ["cjk-bigram", "word"] }
              },
              required: ["word", "count", "kind"]
            }
          }
        },
        required: ["book", "scope", "totalChars", "keywords"]
      },
      render: (_args, value) => [{
        type: "text",
        text: formatKeywords(value)
      }]
    },
    async execute(args, exec) {
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const chapterArg = optionalString(args, "chapter");
      const top = optionalInt(args, "top", 1, 100, 20);
      const root = resolveRoot(config, args, exec);
      const dir = bookDir(root, book);
      const chapters = await scanChapters(dir);
      assert(chapters.length > 0, `book "${book}" has no chapter files`);
      let selected;
      let scope;
      if (chapterArg !== void 0) {
        selected = [findChapter(chapters, chapterArg)];
        assert(selected[0] !== void 0, `cannot find chapter "${chapterArg}" in book "${book}"`);
        scope = selected[0].file;
      } else {
        selected = chapters;
        scope = `全书 ${chapters.length} 章`;
      }
      let text = "";
      for (const chapter of selected) {
        text += await readTextFile(join(dir, chapter.file), exec);
      }
      return {
        book,
        scope,
        totalChars: text.length,
        keywords: extractKeywords(text, top)
      };
    }
  });
}

function formatKeywords(value) {
  const lines = [`<path>novels/${value.book}</path>`, `<type>novel-keywords</type>`, `<content>`, `统计范围: ${value.scope} (共 ${value.totalChars} 字)`, ""];
  if (value.keywords.length === 0) lines.push("（未提取到重复出现的关键词）");
  for (const keyword of value.keywords) {
    const kind = keyword.kind === "cjk-bigram" ? "词组" : "英文词";
    lines.push(`- ${keyword.word} × ${keyword.count} (${kind})`);
  }
  lines.push("", "</content>");
  return lines.join("\n");
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

/** 句式模式分析工具（stylePattern 开关开启时注册）。 */
function registerNovelStylePattern(ctx, config) {
  ctx.tools.register({
    name: "novel_style_pattern",
    description: "分析一部作品（或单章）的句式排列模式：把句子分为陈述/环境/心理/对话/疑问/反问/感叹七类，输出各类占比、高频句式组合与按章节的压缩排列序列，用于模仿原文的叙事节奏。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名。" },
        chapter: { type: "string", description: "可选。只分析该章节；省略则分析全书。" },
        top: { type: "integer", description: "返回的高频句式组合数量。默认 10。" },
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
          totalSentences: { type: "integer" },
          counts: {
            type: "object",
            additionalProperties: false,
            properties: {
              S: { type: "integer" }, ENV: { type: "integer" }, PSY: { type: "integer" },
              DLG: { type: "integer" }, Q: { type: "integer" }, RQ: { type: "integer" }, EX: { type: "integer" }
            },
            required: ["S", "ENV", "PSY", "DLG", "Q", "RQ", "EX"]
          },
          ratios: {
            type: "object",
            additionalProperties: false,
            properties: {
              S: { type: "integer" }, ENV: { type: "integer" }, PSY: { type: "integer" },
              DLG: { type: "integer" }, Q: { type: "integer" }, RQ: { type: "integer" }, EX: { type: "integer" }
            },
            required: ["S", "ENV", "PSY", "DLG", "Q", "RQ", "EX"]
          },
          topPatterns: {
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
          guidance: { type: "string" }
        },
        required: ["book", "scope", "totalSentences", "counts", "ratios", "topPatterns", "chapterPatterns", "guidance"]
      },
      render: (_args, value) => [{
        type: "text",
        text: formatStylePattern(value)
      }]
    },
    async execute(args, exec) {
      const styleOn = config?.stylePattern === true || readStyleEnabled();
      assert(styleOn, "句式模式仿写（novel_style_pattern）当前未开启：可在 Web 设置 > 插件配置 中打开 novel-writer 的 stylePattern 开关后重试。");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const chapterArg = optionalString(args, "chapter");
      const top = optionalInt(args, "top", 1, 50, 10);
      const root = resolveRoot(config, args, exec);
      const dir = bookDir(root, book);
      const chapters = await scanChapters(dir);
      assert(chapters.length > 0, `book "${book}" has no chapter files`);
      const selected = chapterArg !== void 0 ? [findChapter(chapters, chapterArg)] : chapters;
      assert(selected[0] !== void 0, `cannot find chapter "${chapterArg}" in book "${book}"`);
      const scope = chapterArg !== void 0 ? selected[0].file : `全书 ${chapters.length} 章`;
      const chapterPatterns = [];
      const allCodes = [];
      const allCounts = {};
      for (const code of TYPE_CODES) allCounts[code] = 0;
      for (const chapter of selected) {
        const text = await readFile(join(dir, chapter.file), { encoding: "utf8", signal: exec.signal });
        const local = analyzePattern(text, { top });
        for (const code of TYPE_CODES) allCounts[code] += local.counts[code];
        allCodes.push(...local.codes);
        chapterPatterns.push({
          chapter: chapter.file,
          sequence: local.sequence
        });
      }
      const topPatterns = (() => {
        const grams = new Map();
        for (let i = 0; i + 2 < allCodes.length; i += 1) {
          const key = allCodes.slice(i, i + 3).join("→");
          grams.set(key, (grams.get(key) ?? 0) + 1);
        }
        return [...grams.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, top)
          .map(([pattern, count]) => ({ pattern, count }));
      })();
      const ratios = ratioMap(allCounts, allCodes.length);
      const guidance = buildGuidance(ratios, topPatterns, chapterPatterns);
      return {
        book,
        scope,
        totalSentences: allCodes.length,
        counts: allCounts,
        ratios,
        topPatterns,
        chapterPatterns,
        guidance
      };
    }
  });
}

function formatStylePattern(value) {
  const typeName = { S: "陈述", ENV: "环境", PSY: "心理", DLG: "对话", Q: "疑问", RQ: "反问", EX: "感叹" };
  const lines = [
    `<path>novels/${value.book}</path>`,
    `<type>novel-style-pattern</type>`,
    `<content>`,
    `统计范围: ${value.scope}（共 ${value.totalSentences} 句）`,
    "",
    "句式分布: " + Object.entries(value.ratios)
      .filter(([, r]) => r > 0)
      .map(([code, r]) => `${typeName[code]}( ${code} ) ${r}%`)
      .join(" · "),
    "高频句式组合: " + (value.topPatterns.length > 0
      ? value.topPatterns.slice(0, 5).map((p) => `${p.pattern} ×${p.count}`).join("、")
      : "（样本过短）"),
    "",
    "章节节奏（S=陈述 ENV=环境 PSY=心理 DLG=对话 Q=疑问 RQ=反问 EX=感叹）:",
    ...value.chapterPatterns.slice(0, 12).map((c) => `  ${c.chapter}: ${c.sequence}`),
    "",
    "仿写建议:",
    ...value.guidance.split("\n").map((line) => `  ${line}`),
    "",
    "</content>"
  ];
  return lines.join("\n");
}

/** 系统提示词：小说写作工作流（需求 1-3 的模型侧约定）。 */
const WORKFLOW_TEXT = [
  "【小说写作助手 novel-writer】",
  "1. 章节库约定：小说章节存放在工作区 novels/<书名>/ 文件夹下，每章一个 Markdown 文件（如 第01章.md、第02章.md）。",
  "   优先使用 novel_books / novel_chapters / novel_read 工具浏览与阅读章节；也可以用 read/glob 等通用工具直接查看。",
  "2. 分析小说时（剧情 / 写作手法 / 关键词）：先 novel_books 找到作品，novel_chapters 了解章节结构，再 novel_read 逐章通读（长章节分段读完全文）。",
  "   分析至少覆盖三方面：剧情脉络（冲突、转折、悬念、伏笔、人物关系与目标）、写作手法（叙事视角、节奏、对话、环境与细节描写、比喻意象、留白）、",
  "   以及用 novel_keywords 提取的高频关键词（作者词汇偏好与意象母题），并说明这些手法/关键词在具体章节中的例证。",
  "3. 续写 / 辅助写作时：先通读最近的章节（保持人物、时间线、情节伏笔、文风与已提炼的关键词一致），再动笔。",
  "   新章节写入 novels/<书名>/ 文件夹：用 novel_new_chapter 创建章节文件，或直接用 write 工具写文件。",
  "4. 每次续写前先简述：上一章结尾状态 → 本章目标 → 写作计划，再给出正文。",
  "5. 导入/整理原稿件时：用 novel_import 扫描存放多本小说稿件的文件夹（src），先以 scan 模式查看分组建议，",
  "   若发现异名同书（如\"萝莉/幼女\"实为同一本），用 book 参数强制合并后以 apply 模式导入到 novels/<书名>/ 分类存放。"
].join("\n");

/**
 * stylePattern 开关的持久化：独立的配置文件（$DSH_HOME/novel-writer.json）。
 * Web 设置卡片通过 /novel-writer-config 路由读写它；工具执行时实时读取，
 * 因此 Web 里开关后立即生效（无需重启）。
 */
function styleConfigPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "novel-writer.json");
}
/** 读取持久化的 stylePattern 开关（true = 开启）。文件缺失/损坏一律视为关。 */
function readStyleEnabled() {
  try {
    if (!existsSync(styleConfigPath())) return false;
    const parsed = JSON.parse(readFileSync(styleConfigPath(), "utf8"));
    return parsed?.stylePattern === true;
  } catch {
    return false;
  }
}
/** 写入持久化的 stylePattern 开关。 */
function writeStyleEnabled(enabled) {
  const path = styleConfigPath();
  writeFileSync(path, JSON.stringify({ stylePattern: enabled === true }, null, 2) + "\n", "utf8");
}
/**
 * 在 web profile 注册 /novel-writer-config 配置路由（设置卡片的读写后端）。
 * 用可选注入：headless 等无 webServer 的 profile 直接跳过。
 */
function registerStyleConfigRoute(ctx) {
  ctx.inject(["webServer"], (wctx) => {
    wctx.webServer.register({
      kind: "exact",
      path: "/novel-writer-config",
      handler: (req, res) => {
        const send = (status, body) => {
          const payload = JSON.stringify(body);
          res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
          res.end(payload);
        };
        if (req.method === "GET") {
          send(200, { stylePattern: readStyleEnabled() });
          return;
        }
        if (req.method === "POST") {
          let raw = "";
          req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 4096) req.destroy();
          });
          req.on("end", () => {
            try {
              const body = JSON.parse(raw || "{}");
              if (typeof body.stylePattern !== "boolean") {
                send(400, { error: "stylePattern must be a boolean" });
                return;
              }
              writeStyleEnabled(body.stylePattern);
              send(200, { stylePattern: body.stylePattern });
            } catch {
              send(400, { error: "invalid JSON body" });
            }
          });
          return;
        }
        send(405, { error: "method not allowed" });
      }
    });
  });
}

/** 句式模式仿写提示词（stylePattern 开启时注入；含风险说明）。 */
const STYLE_GUIDANCE_TEXT = [
  "【句式模式仿写 novel_style_pattern（受 stylePattern 开关控制）】",
  "1. 该功能默认关闭；若调用 novel_style_pattern 返回「未开启」提示，说明用户未在 Web 设置 > 插件配置 中开启 stylePattern，此时不要强行模仿句式，按普通流程写作即可。",
  "2. 开启时：仿写/续写前，先用 novel_style_pattern 分析原文的句式排列：陈述/环境/心理/对话/疑问/反问/感叹七类句子的占比、高频组合与按章节的节奏序列。",
  "3. 写作时尽量贴近原文的句式节奏：陈述句密度、心理描写出现的时机与位置、反问句的使用频率、对话与叙事的穿插比例、环境描写的点缀节奏。",
  "4. 重要风险提示：句式模式是「参考节奏」，不是「模板套用」。若机械复刻导致句子僵硬、重复、模式化或失去自然感，必须优先回归自然表达；",
  "   适度偏离原文模式是允许且更优的选择。分析报告中的模式代码（S/ENV/PSY/DLG/Q/RQ/EX）只用来指导句式选择，不要直接出现在正文或报告里。"
].join("\n");

function apply(ctx, config = {}) {
  registerNovelBooks(ctx, config);
  registerNovelChapters(ctx, config);
  registerNovelRead(ctx, config);
  registerNovelKeywords(ctx, config);
  registerNovelNewChapter(ctx, config);
  registerNovelImport(ctx, config);
  ctx.systemPrompt.section({
    name: "novel-writing",
    order: 150,
    text: WORKFLOW_TEXT
  });
  // stylePattern 开关：默认关闭（规避机械套用导致文风僵硬的已知风险）。
  // 工具常注册，执行时实时读取开关状态（config.stylePattern 或 $DSH_HOME/novel-writer.json），
  // 因此 Web 设置 > 插件配置 里的开关改动即时生效，无需重启。
  registerNovelStylePattern(ctx, config);
  registerStyleConfigRoute(ctx);
  ctx.systemPrompt.section({
    name: "novel-writing-style",
    order: 151,
    text: STYLE_GUIDANCE_TEXT
  });
}

export { apply, inject, name };
