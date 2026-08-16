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
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, sep } from "node:path";

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
  "4. 每次续写前先简述：上一章结尾状态 → 本章目标 → 写作计划，再给出正文。"
].join("\n");

function apply(ctx, config = {}) {
  registerNovelBooks(ctx, config);
  registerNovelChapters(ctx, config);
  registerNovelRead(ctx, config);
  registerNovelKeywords(ctx, config);
  registerNovelNewChapter(ctx, config);
  ctx.systemPrompt.section({
    name: "novel-writing",
    order: 150,
    text: WORKFLOW_TEXT
  });
}

export { apply, inject, name };
