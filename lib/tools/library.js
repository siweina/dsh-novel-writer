/**
 * dsh-novel-writer — lib/tools/library.js（书库管理、阅读、关键词、导入与按书删除工具）
 */

import { copyFile, mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { applyBookDelete, DELETE_DATA_SUBDIRS, formatBookDelete, listTrash, planBookDelete, purgeTrash, restoreTrash } from "../bookdelete.js";
import { logEvent } from "../log.js";
import { assert, assertToolEnabled, atomicWriteJson, bookDir, bookNameFromContent, bookNameFromFileName, CACHE_VERSION, chapterStats, cleanOutput, collectTextFiles, countTextLines, extractKeywords, findChapter, formatBooks, formatChapters, formatImport, formatKeywords, formatRead, isAbort, nextFreeChapterFile, noteRoot, novelDataDir, novelsDir, optionalInt, optionalString, parseChapterNumber, READ_LIMIT, READ_MAX_CHARS, readTextFile, requiredString, resolveRoot, sanitizeSegment, scanChapters } from "../core.js";
import { deleteResultFor, pruneAnalysisReports } from "./shared.js";

function registerNovelBooks(ctx, config) {
  ctx.tools.register({
    name: "novel_books",
    description: "列书库全部作品及章数/字数（只读）。",
    parameters: {
      type: "object",
      properties: {
        root: { type: "string", description: "书库根" }
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
      } catch (e) {
        // v6.6.0：novels/ 读不动 → 对外是「暂无作品」，与「书库里本来就没有书」长得一模一样
        if (e?.code !== "ENOENT") {
          logEvent("silent_skip", { root, path: dir, level: "warn", detail: "作品目录读取失败（作品列表按空处理）：" + String(e?.message ?? e) });
        }
        return { root, books: [] };
      }
      const books = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // v3.5.0 #27：点号目录（.git/备份）不算作品
        if (entry.name.startsWith(".")) continue;
        // v3.1.0：粗大纲/创作资料目录（novels/创作资料/<书>/）不算作品
        if (entry.name === "创作资料") continue;
        const bookPath = join(dir, entry.name);
        let chapters;
        try {
          chapters = await scanChapters(bookPath);
        } catch {
          // v6.6.0：目录刚由 readdir 列出，scanChapters 却失败＝真读不动。旧版 continue 掉这本书，
          // 于是"读不到"与"这本书不存在"在作品列表里长得一模一样（作者会以为书丢了）
          logEvent("silent_skip", { book: entry.name, level: "warn", detail: "作品章节扫描失败，该书已从作品列表中省略" });
          continue;
        }
        let chars = 0;
        for (const chapter of chapters) {
          try {
            chars += (await chapterStats(bookPath, chapter, exec)).chars;
          } catch (e) {
            // v7.0.1 修正（审查 #32）：chapterStats 会把 exec.signal 透传给 readTextFile——
            // 取消必须上抛。旧版裸 catch 吞掉 AbortError，取消后返回一份 chars=0 的"成功"作品列表。
            if (isAbort(e)) throw e;
            /* 跳过无法统计的章节 */
          }
        }
        books.push({ name: entry.name, chapters: chapters.length, chars });
      }
      books.sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));
      return { root, books };
    }
  });
}

function registerNovelChapters(ctx, config) {
  ctx.tools.register({
    name: "novel_chapters",
    description: "列作品全部章节与字数（只读，含撞号提示）。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名" },
        root: { type: "string", description: "书库根" }
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
        const stats = await chapterStats(dir, chapter, exec);
        const row = {
          file: chapter.file,
          // v6.2.0 修正（旧清单第 19 条）：未知章号必须**省略键**——旧版的条件展开被下一行无条件的
          // `number: chapter.number` 覆盖（死代码），于是「番外.md/楔子.md」这类文件在返回体里带出
          // `number: undefined`（宿主契约不接受 undefined）；与 graph.js / novel_read 的既定口径也不一致。
          // v5.0.0 修正：文件名没标题时回退读正文一级标题（如工具创建的「第07章.md」），
          // 否则用 novel_new_chapter 的 title 建的章在清单里显示为空标题。
          title: chapter.title || stats.heading || "",
          chars: stats.chars,
          lines: stats.lines,
          updated: stats.updated
        };
        if (typeof chapter.number === "number") row.number = chapter.number;
        result.push(row);
      }
      return { book, chapters: result };
    }
  });
}

function registerNovelRead(ctx, config) {
  ctx.tools.register({
    name: "novel_read",
    description: "读某章带行号正文（支持分段，只读）。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名" },
        chapter: { type: "string", description: "章号/文件名/标题" },
        offset: { type: "integer", description: "起始行(默认1)" },
        limit: { type: "integer", description: `行数(默认${READ_LIMIT})` },
        root: { type: "string", description: "书库根" }
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
          hitLineCap: { type: "boolean" },
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
        required: ["book", "chapter", "file", "path", "offset", "totalLines", "chars", "truncated", "hitLineCap", "lines"]
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
      const allLines = text.replace(/\r\n?/g, "\n").split("\n");
      // v4.3.0：行数口径与 core.js 的 chapterStats 统一（countTextLines：空文件 0 行）。
      // 旧版直接取 split 长度 → 空文件报 1 行，与 novel_chapters 的 0 行自相矛盾。
      // 断言用 Math.max(totalLines,1) 兜底，保证空章节仍可按 offset=1 读到那条空行（行为不变）。
      const totalLines = countTextLines(text);
      assert(offset <= Math.max(totalLines, 1), `offset ${offset} 超出范围（"${chapter.file}" 共 ${totalLines} 行）`);
      let chars = 0;
      const lines = [];
      let hitCharCap = false;
      let hitLineCap = false;
      for (let i = offset - 1; i < allLines.length && lines.length < limit; i += 1) {
        // v3.5.0 #11：单行超长裁剪（防首行超长绕过上限）
        let line = allLines[i];
        if (line.length > 3000) {
          line = line.slice(0, 3000) + "…（行过长已裁剪）";
          hitLineCap = true;
        }
        // v3.9.0：先判断后累加——截断行不计入；换行只算「与上一已返回行之间」的（与 lines.join("\n") 口径一致，截断在中间时末尾换行不再多算）
        const addChars = line.length + (lines.length > 0 ? 1 : 0);
        if (chars + addChars > READ_MAX_CHARS && lines.length > 0) {
          hitCharCap = true;
          break;
        }
        chars += addChars;
        lines.push({ number: i + 1, text: line });
      }
      // v3.5.0 #10 / v7.4.0（#42）：truncated 真实判定——字符上限/单行裁剪/行数上限/未到文件尾任一即截断
      const truncated = hitCharCap || hitLineCap || (offset - 1 + lines.length) < totalLines;
      return {
        book,
        chapter: chapter.file,
        file: chapter.file,
        path: filePath,
        offset,
        totalLines,
        chars,
        truncated,
        hitLineCap,
        lines
      };
    }
  });
}

function registerNovelKeywords(ctx, config) {
  ctx.tools.register({
    name: "novel_keywords",
    description: "统计全书/单章高频词（二三字词与英文，不含单字）。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名" },
        chapter: { type: "string", description: "章节(省=全书)" },
        top: { type: "integer", description: "数量(默认20)" },
        root: { type: "string", description: "书库根" }
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
      let totalChars = 0;
      for (const chapter of selected) {
        const chapterText = await readTextFile(join(dir, chapter.file), exec);
        totalChars += chapterText.length;
        // v4.0.0 修正：章节之间加分隔符——旧版直接首尾相接，上一章末尾与下一章开头会被当成
        // 相邻二字/三字组统计，产出正文里根本不存在的"词"（totalChars 仍按各章实际字数累加）
        text += (text === "" ? "" : "\n\n") + chapterText;
      }
      const result = {
        book,
        scope,
        totalChars,
        keywords: extractKeywords(text, top)
      };
      // v0.8.0：关键词结果落盘到书库统一数据目录（与设定同文件夹）
      try {
        const reportDir = join(novelDataDir(root), "analysis");
        // v4.0.0 修正：报告文件名指纹改用内容哈希——旧版只用 text.length，同长度改稿会静默覆盖旧报告
        const reportFile = join(reportDir, book + "-keywords-" + createHash("sha1").update(book + "|" + scope + "|" + text).digest("hex").slice(0, 12) + ".json");
        await mkdir(reportDir, { recursive: true });
        await atomicWriteJson(reportFile, { ...result, generatedAt: new Date().toISOString(), ver: CACHE_VERSION });
        // v4.3.0：关键词报告同样按书保留最近 REPORT_CACHE_KEEP 份（缓存键含内容哈希，改稿即新增文件）
        await pruneAnalysisReports(reportDir, book, "keywords");
        result.reportFile = reportFile;
      } catch {
        // v6.6.0 / v7.4.0（#45）：关键词报告未落盘，返回体亦不含 reportFile（不影响本次关键词返回，留痕说明）
        logEvent("cache", { book, level: "warn", detail: "关键词报告落盘失败（本次返回未含 reportFile，结果未持久化）" });
      }
      return result;
    }
  });
}

function registerNovelImport(ctx, config) {
  ctx.tools.register({
    name: "novel_import",
    description: "批量导入原稿到novels/<书名>/(scan预览/apply执行)。",
    parameters: {
      type: "object",
      properties: {
        src: { type: "string", description: "原稿目录" },
        mode: { type: "string", enum: ["scan", "apply"], description: "模式" },
        book: { type: "string", description: "强制书名" },
        files: { type: "array", items: { type: "string" }, description: "指定相对路径" },
        move: { type: "boolean", description: "移动(默认复制)" },
        recursive: { type: "boolean", description: "递归子目录" },
        root: { type: "string", description: "书库根" }
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
                from: { type: "string", enum: ["file", "content", "forced", "unclassified"] }, // v3.7.0：未分类组 from 标签（前轮漏加枚举，宿主拒绝整个工具输出）
                maybe: { type: "array", items: { type: "string" }, description: "可能同书的其他分组名（供 AI 判断是否用 book 合并）。" },
                files: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      file: { type: "string" },
                      chapter: { type: "integer" },
                      // v6.2.0 修正（旧清单第 15 条）：字段原名 title，装的却是「书名候选」（bookNameFromContent），
                      // 模型易误当本章章节标题——改名为语义相符的 bookNameCandidate（全库仅此处产出、无其他读取方）。
                      bookNameCandidate: { type: "string" }
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
      render: (_args, value) => {
        // v7.0.1 修正（审查 #38）：把书库根传给 formatImport，<path> 才能相对化；
        // 绝对路径一律不进模型上下文。render 拿不到 execute 里解析后的 root，这里按同一优先级取：
        // 显式 root → config.root（都没有就让 formatImport 降级成 basename——安全优先）。
        const rootArg = optionalString(_args, "root")
          ?? (typeof config?.root === "string" && config.root.trim() !== "" ? config.root.trim() : void 0);
        return [{ type: "text", text: formatImport(value, rootArg) }];
      }
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
      // v6.2.0 修正（旧清单第 14 条）：src 不存在/不是目录时显式报错——collectTextFiles 会把 readdir
      // 异常吞成 []（core.js），旧版于是「成功但 0 本书」，与 core 的「跳过 N 个文件：无法读取或未分类」文案不符。
      let srcInfo;
      try {
        srcInfo = await stat(src);
      } catch {
        throw new Error(`导入源目录不存在或不可读：${src} 【解决：确认路径；书库外的目录需宿主允许（--allow-external-src）】`);
      }
      assert(srcInfo.isDirectory(), `导入源必须是文件夹，不是文件：${src}`);
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
          // v6.2.0 修正（旧清单第 14 条）：stat 失败不再静默跳过——计入 skipped 并汇报
          skipped.push(rel + "（无法读取文件信息）");
          continue;
        }
        if (!info.isFile()) { skipped.push(rel + "（不是文件）"); continue; }
        const fileName = basename(rel);
        let text = "";
        try {
          text = await readTextFile(full, exec);
        } catch (e) {
          // v7.0.1 修正（审查 #32）：取消（AbortError）不是"这个文件读不了"——旧版裸 catch 把它
          // 计进 skipped 后继续，长任务取消被伪装成"成功但跳过 N 个文件"（宿主以为扫描跑完了）。
          if (isAbort(e)) throw e;
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
          from = "unclassified"; // v3.7.0 ③：未分类不再标注"来自文件头内容"（误导）
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
            // v6.2.0 修正（旧清单第 15 条）：键名由 title 改为 bookNameCandidate（见 schema 注释）
            ...r.nameFromContent === void 0 ? {} : { bookNameCandidate: r.nameFromContent }
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
          if (group.book === "未分类") {
            // v3.9.0：未分类文件不再静默丢弃——计入 skipped 并说明原因
            for (const row of group.files) skipped.push(row.file + "（未分类，未导入——请用 book 参数指定归属书名后重试）");
            continue;
          }
          const safeBook = sanitizeSegment(group.book, "book");
          const destDir = join(novelsDir(root), safeBook);
          await mkdir(destDir, { recursive: true });
          for (const row of group.files) {
            const srcFull = join(src, row.file);
            // v3.5.0 #19：目标同名已存在 → 自动改名，不静默覆盖、move 模式不丢源
            // v3.9.0：统一按扩展名处理（.markdown/.docx 等不再丢失扩展名）；章号冲突改用空闲章号
            // v3.9.0 复查：异形同号也算占用（第一章 vs 第01章 文件名不同但章号相同 → 改名，不再产生重复章号）
            const rawName = basename(row.file);
            const rawNum = parseChapterNumber(rawName);
            let destFile = rawName;
            if (rawNum !== void 0) {
              let occupied = false;
              try {
                for (const ex of readdirSync(destDir)) {
                  if (parseChapterNumber(ex) === rawNum) { occupied = true; break; }
                }
              } catch { /* 目录不可读按重名处理 */ }
              if (occupied) destFile = nextFreeChapterFile(destDir, rawName);
            } else if (existsSync(join(destDir, rawName))) {
              destFile = nextFreeChapterFile(destDir, rawName);
            }
            const destFull = join(destDir, destFile);
            await copyFile(srcFull, destFull);
            if (move) await rm(srcFull, { force: true });
            imported.push({ book: safeBook, file: destFile, path: destFull });
          }
        }
      }
      if (mode === "apply" && imported.length > 0) await noteRoot(root); // v3.9.0：apply 导入后记录书库根
      return { src, mode, groups, skipped, imported };
    }
  });
}

// ============ v6.8.0：按书删除（issue #2） ============
const DELETE_ACTIONS = Object.freeze(["preview", "apply", "list", "restore", "purge"]);

/**
 * 工具与面板路由共用的**唯一**执行链路（口径不分叉：面板点「删除」与 AI 调工具走同一条路）。
 *
 * 为什么五种 action 挤在一个工具里而不是拆成五个：用户的心智模型是"删这一本书"，
 * 预览/执行/恢复是同一件事的不同阶段；拆开会让 AI 在"先预览再执行"时选错工具。
 */

/**
 * v7.3.3 修（#9）：`planBookDelete` 只把「有文件的目录」算作 found / 可清理项，于是
 *   ① 只有空目录时预览 found=false、apply 报「没找到任何内容」；
 *   ② 「空正文目录 + 其它文件」时 apply 只搬文件，空目录留在盘上。
 * （v7.3.4 更正：这里原写「本版只允许改 index.js（bookdelete.js 由他人维护）」——那是 7.3.3 当时的临时约束，
 * 现在已经不成立：空目录清理的实现已经在 bookdelete.js 里，本函数只做"纯空目录"这一条捷径。）
 *   · 预览/执行把「存在但空的目录（chapters/creation 等 kind=dir）」也算作可清理内容；
 *   · apply 成功后移除**本次选中**的空目录（rmdir 只能删空目录，不递归）。
 * 为什么不用递归 rm：空目录与「运行中又有文件写进来」之间存在竞态，rmdir 在非空时失败正是保护。
 */
function isEmptyDirTarget(target) {
  return target && target.kind === "dir" && target.exists === true && target.files === 0;
}
function emptyDirTargetsOf(plan) {
  return plan.targets.filter(isEmptyDirTarget);
}
function pickBookDeleteKeys(plan) {
  // 预览的"可清理项全选"：有文件的位置 + 存在但空的目录（后者只做 rmdir，不进回收站）
  return plan.targets.filter((t) => t.exists && (t.files > 0 || isEmptyDirTarget(t))).map((t) => t.key);
}
async function removeEmptyDirTargets(selectedEmpty) {
  const removed = [];
  const failed = [];
  // v7.3.4 修（④-②a）：ENOENT 过去是裸 `continue`——既不计 removed 也不计 failed。
  // 于是「选中的空目录在预览后、apply 前就都不在了」这一情形下，removed 与 failed 同时为空，
  // 调用方会回一句「空目录未能移除（见失败项）」，而 failed 是 [] —— 文案与数据自相矛盾。
  // 现在单独记 alreadyGone（语义是「目标已达成，只是不是这次达成的」），文案据此说清楚。
  const alreadyGone = [];
  for (const target of selectedEmpty) {
    try {
      // 只删真空目录：内容在预览后才写进来的，rmdir 会 ENOTEMPTY → 记为失败而不是连内容一起删
      await rmdir(target.path);
      removed.push(target.key);
    } catch (e) {
      if (e?.code === "ENOENT") { alreadyGone.push(target.key); continue; }
      failed.push({ path: target.path, code: String(e?.code ?? ""), error: String(e?.message ?? e).slice(0, 160) });
    }
  }
  return { removed, failed, alreadyGone };
}
/**
 * v7.3.3 修（#9 交叉）：apply 侧（bookdelete.applyBookDelete）与纯空目录分支可能对**同一路径**各记一条失败
 * （典型：目录里还有子目录 → ENOTEMPTY）。失败项按 path 去重，保留信息更全的那条（有 code、error 更长）。
 */
function dedupeFailedByPath(failed) {
  const byPath = new Map();
  const score = (item) => (typeof item?.code === "string" && item.code !== "" ? 2 : 0) + (typeof item?.error === "string" ? item.error.length : 0);
  for (const item of Array.isArray(failed) ? failed : []) {
    if (!item || typeof item !== "object") continue;
    const key = String(item.path ?? "");
    const prev = byPath.get(key);
    if (prev === void 0 || score(item) > score(prev)) byPath.set(key, item);
  }
  return [...byPath.values()];
}
async function deleteBookDispatch(root, args) {
  const action = DELETE_ACTIONS.includes(args?.action) ? args.action : "preview";
  if (action === "list") {
    const trash = await listTrash({ root });
    return deleteResultFor("list", {
      found: trash.length > 0,
      trash,
      message: "回收站共 " + trash.length + " 项" + (trash.length === 0 ? "（还没有删过书）" : "")
    });
  }
  if (action === "restore" || action === "purge") {
    const trashId = requiredString(args, "trashId");
    if (action === "purge") {
      const r = await purgeTrash({ root, trashId });
      return deleteResultFor("purge", {
        trashId,
        purged: r.purged,
        totals: { files: r.files, bytes: r.bytes },
        message: "已彻底删除回收站条目 " + trashId + "（" + r.files + " 个文件，不可恢复）"
      });
    }
    const r = await restoreTrash({ root, trashId });
    return deleteResultFor("restore", {
      book: r.book,
      trashId,
      restored: r.restored,
      profileRestored: r.profileRestored,
      conflicts: r.conflicts,
      failed: r.failed,
      message: "从回收站恢复《" + r.book + "》" + r.restored + " 项" + (r.profileRestored ? "（含设定库条目）" : "")
    });
  }
  const book = requiredString(args, "book");
  const plan = await planBookDelete({ root, book });
  // v7.3.3 修（#9）：存在但空的目录也算"找到了这本书的内容"（否则纯空目录永远删不掉）
  const emptyDirs = emptyDirTargetsOf(plan);
  const foundWithEmptyDirs = plan.found || emptyDirs.length > 0;
  if (action === "preview") {
    const keys = pickBookDeleteKeys(plan);
    return deleteResultFor("preview", {
      book: plan.book,
      safeBook: plan.safeBook,
      found: foundWithEmptyDirs,
      blocked: plan.blocked,
      blockedReason: plan.blockedReason,
      targets: plan.targets,
      totals: plan.totals,
      warnings: plan.warnings,
      notTouched: plan.notTouched,
      // 预览默认全选：调用方（面板/AI）拿它当"可清理项"的初始勾选状态。
      // v7.3.3 修（#9）：空目录同样列进可清理项（它确实会占用 novels/<书> 这个位置，让 novel_books 一直列出一本空书）。
      keys,
      message: plan.blocked
        ? "不能删除《" + plan.book + "》：" + plan.blockedReason
        : "预览：《" + plan.book + "》共 " + plan.totals.files + " 个文件"
          + (emptyDirs.length > 0 ? "、空目录 " + emptyDirs.length + " 处" : "")
          + "，分布在 " + keys.length + " 处（可用 keys 只清理其中几处）（磁盘未改动）"
    });
  }
  // action === "apply"：keys 省略 = 全选（删整本书）；给了就只清理选中的位置
  const rawKeys = args?.keys;
  if (rawKeys !== void 0 && rawKeys !== null && !Array.isArray(rawKeys)) {
    // 与 bookdelete.selectTargets 同口径（这里提前拦，避免后面按"没选中"报错而看不出真因）
    throw new Error("参数 \"keys\" 必须是数组（要清理的位置 key 列表，取自 preview 的 targets[].key）");
  }
  const KNOWN_BOOK_DELETE_KEYS = new Set([
    "chapters", "creation", "data:drafts", "profile", "legacy",
    ...DELETE_DATA_SUBDIRS.map((s) => "data:" + s)
  ]);
  const wantedKeys = rawKeys === void 0 || rawKeys === null
    ? null
    : [...new Set(rawKeys.map((k) => String(k === void 0 || k === null ? "" : k).trim()).filter((k) => k !== ""))];
  if (wantedKeys !== null) {
    const unknownKeys = wantedKeys.filter((k) => !KNOWN_BOOK_DELETE_KEYS.has(k) && !plan.targets.some((t) => t.key === k));
    if (unknownKeys.length > 0) {
      throw new Error("参数 \"keys\" 含未知位置：" + unknownKeys.join("、")
        + "——可选值为 preview 返回的 targets[].key（" + [...KNOWN_BOOK_DELETE_KEYS].join(" / ") + "）");
    }
  }
  const contentTargets = plan.targets.filter((t) => t.exists && t.files > 0);
  const selectedContent = wantedKeys === null ? contentTargets : contentTargets.filter((t) => wantedKeys.includes(t.key));
  const selectedEmpty = wantedKeys === null ? emptyDirs : emptyDirs.filter((t) => wantedKeys.includes(t.key));
  if (plan.blocked) throw new Error("无法删除《" + plan.book + "》：" + plan.blockedReason);
  if (selectedContent.length === 0 && selectedEmpty.length === 0) {
    // v7.3.4 修（④-②a'）：选了 keys、但这几处**在预览之后就已经都不存在**时，不该报参数错误——
    // 用户想要的结果已经达成了。旧实现会抛「keys 至少要选中一处可清理的内容」，看起来像自己用错了参数。
    const wantedStillExists = wantedKeys === null ? false : plan.targets.some((t) => wantedKeys.includes(t.key) && t.exists);
    if (wantedKeys !== null && wantedKeys.length > 0 && !wantedStillExists) {
      logEvent("config", {
        book: plan.book,
        action: "delete_apply",
        files: 0,
        bytes: 0,
        count: 0,
        path: "",
        failures: 0,
        removedEmptyDirs: 0,
        level: "info",
        detail: "目标在预览后已不存在（未做任何写盘动作）"
      });
      // v7.3.5 修（③）/ v7.4.0（#23）：未选中残留统计兼顾有文件目标与现存空目录（creation / data:drafts 等）
      const leftContentGone = wantedKeys === null
        ? []
        : plan.targets.filter((t) => t.exists && (t.files > 0 || isEmptyDirTarget(t)) && !wantedKeys.includes(t.key));
      const remainingGone = {
        files: leftContentGone.reduce((sum, t) => sum + (Number.isFinite(t.files) ? t.files : 0), 0),
        bytes: leftContentGone.reduce((sum, t) => sum + (Number.isFinite(t.bytes) ? t.bytes : 0), 0)
      };
      const skippedGone = leftContentGone.map((t) => t.key);
      const partialGone = skippedGone.length > 0;
      const warningsGone = plan.warnings.slice();
      if (partialGone) {
        const leftEmptyGone = leftContentGone.filter(isEmptyDirTarget).length;
        const leftDetailGone = remainingGone.files > 0
          ? remainingGone.files + " 个文件 / " + remainingGone.bytes + " 字节" + (leftEmptyGone > 0 ? "，及 " + leftEmptyGone + " 个空目录" : "")
          : leftEmptyGone + " 个空目录";
        warningsGone.push("另有 " + skippedGone.length + " 处内容按选择保留（" + leftDetailGone + "）");
      }
      return deleteResultFor("apply", {
        book: plan.book,
        safeBook: plan.safeBook,
        found: plan.found,
        blocked: false,
        blockedReason: "",
        // v7.3.5：新增的 fail-closed 断言要求 apply 返回体把这几项显式写全（不再靠默认值兜底）
        targets: [],
        totals: { files: 0, bytes: 0 },
        keys: wantedKeys.slice(),
        skipped: skippedGone,
        partial: partialGone,
        failed: [],
        warnings: warningsGone,
        notTouched: plan.notTouched,
        remaining: remainingGone,
        message: "《" + plan.book + "》选中的位置（" + wantedKeys.join(" / ") + "）在预览后已不存在——目标已达成，本次没有做任何写盘动作"
      });
    }
    throw new Error("参数 \"keys\" 至少要选中一处可清理的内容（本书当前可清理："
      + (pickBookDeleteKeys(plan).join(" / ") || "无") + "）");
  }
  // 纯空目录：没有文件可搬，直接删空目录（不生成回收站条目——空目录里没有可恢复的内容）
  // v7.3.4 修（④-②b）：这条提前返回此前有三处失真——
  //   ① `remaining` 写死 { files: 0, bytes: 0 }：只选空目录、书里还有非空目录时会谎报"删干净了"；
  //   ② 不带 `skipped` / `partial`：用户按 keys 只选一部分时，看不出「另有内容按选择保留」；
  //   ③ 整条绕开了 applyBookDelete，于是 `logEvent("config", { action: "delete_apply" })` 不执行
  //      —— `novel_diagnose` 里看不到这次删除（一次真实的写盘动作却没有审计记录）。
  // 现在按同一套语义补齐，并显式记日志（files/bytes/count 为 0，因为确实没搬任何文件）。
  if (selectedContent.length === 0) {
    const { removed, failed, alreadyGone } = await removeEmptyDirTargets(selectedEmpty);
    const uniqueFailed = dedupeFailedByPath(failed);
    // 剩余内容 = 未选中的有文件目标 + 未选中的现存空目录
    const leftContent = wantedKeys === null
      ? []
      : plan.targets.filter((t) => t.exists && (t.files > 0 || isEmptyDirTarget(t)) && !wantedKeys.includes(t.key));
    const remaining = {
      files: leftContent.reduce((sum, t) => sum + (Number.isFinite(t.files) ? t.files : 0), 0),
      bytes: leftContent.reduce((sum, t) => sum + (Number.isFinite(t.bytes) ? t.bytes : 0), 0)
    };
    const skippedKeys = leftContent.map((t) => t.key);
    const partial = skippedKeys.length > 0;
    const warnings = plan.warnings.slice();
    if (uniqueFailed.length > 0) warnings.push("有 " + uniqueFailed.length + " 个空目录没能移除（见失败项）");
    if (partial) {
      const leftEmptyCount = leftContent.filter(isEmptyDirTarget).length;
      const leftDetail = remaining.files > 0
        ? remaining.files + " 个文件 / " + remaining.bytes + " 字节" + (leftEmptyCount > 0 ? "，及 " + leftEmptyCount + " 个空目录" : "")
        : leftEmptyCount + " 个空目录";
      warnings.push("按 keys 只处理了 " + (removed.length + alreadyGone.length) + " 个空目录；另有 " + skippedKeys.length + " 处内容按选择保留（" + leftDetail + "）");
    }
    else if (remaining.files > 0) warnings.push("清理后仍有 " + remaining.files + " 个文件残留，可用 action=preview 复查具体位置");
    const goneNote = alreadyGone.length > 0 ? "（其中 " + alreadyGone.join(" / ") + " 在预览后已不存在，视为目标已达成）" : "";
    let message;
    if (removed.length > 0) {
      message = "已移除《" + plan.book + "》的空目录：" + removed.join(" / ") + "（目录里没有文件，未生成回收站条目）" + goneNote;
    } else if (alreadyGone.length > 0 && uniqueFailed.length === 0) {
      message = "《" + plan.book + "》选中的空目录在预览后已不存在（" + alreadyGone.join(" / ") + "）——目标已达成，无需处理";
    } else if (uniqueFailed.length > 0) {
      message = "《" + plan.book + "》的空目录未能移除（见失败项）";
    } else {
      message = "《" + plan.book + "》没有需要移除的空目录";
    }
    logEvent("config", {
      book: plan.book,
      action: "delete_apply",
      files: 0,
      bytes: 0,
      count: 0,
      path: "",
      failures: uniqueFailed.length,
      removedEmptyDirs: removed.length + alreadyGone.length,
      level: uniqueFailed.length > 0 ? "warn" : "info",
      detail: "只清理空目录（未搬任何文件，未生成回收站条目）" + goneNote
    });
    return deleteResultFor("apply", {
      book: plan.book,
      safeBook: plan.safeBook,
      found: true,
      blocked: false,
      blockedReason: "",
      targets: selectedEmpty.map((t) => ({ key: t.key, label: t.label, kind: t.kind, path: t.path, rel: t.rel, exists: true, files: 0, bytes: 0, sample: [] })),
      totals: { files: 0, bytes: 0 },
      warnings,
      notTouched: plan.notTouched,
      keys: removed.concat(alreadyGone),
      skipped: skippedKeys,
      partial,
      failed: uniqueFailed,
      remaining,
      message
    });
  }
  const applyKeys = wantedKeys === null ? null : wantedKeys.filter((k) => plan.targets.some((t) => t.key === k));
  const result = await applyBookDelete({ root, book, plan: { ...plan, found: foundWithEmptyDirs }, keys: applyKeys });
  // v7.3.3 修（#9 交叉）：applyBookDelete 现在内部负责清空目录（rmdir 本次选中的空目录），
  // 这里**不要**再调一次 removeEmptyDirTargets——否则 rmdir 失败（ENOTEMPTY）会被两个实现各记一条。
  // 只做一道防御：失败项按 path 去重（同一路径只报一条，保留信息更全的那条）。
  if (Array.isArray(result.failed) && result.failed.length > 1) {
    result.failed = dedupeFailedByPath(result.failed);
  }
  return result;
}

/**
 * v6.8.0：`novel_delete_book` —— 第 21 个工具，对应 issue #2「按书删除正文及全部关联资料」。
 *
 * 默认 **preview**（只算不动盘），`action:"apply"` 才执行——删书是不可撤销的破坏性操作，
 * 默认值必须是安全的那一侧。默认**移入回收站**（`<数据目录>/trash/<书>-<时间戳>/`），
 * 需要真省空间时用 `purge` 彻底删掉某个回收站条目。
 */
function registerNovelDeleteBook(ctx, config) {
  const targetSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      key: { type: "string", description: "位置标识（chapters/creation/data:<子目录>/legacy/profile）" },
      label: { type: "string", description: "给人看的位置名" },
      kind: { type: "string", description: "dir=整个目录；files=只移走匹配文件；state=只摘设定库条目" },
      path: { type: "string", description: "绝对路径" },
      rel: { type: "string", description: "相对书库根的路径" },
      exists: { type: "boolean", description: "该位置是否存在" },
      files: { type: "integer", description: "文件数" },
      bytes: { type: "integer", description: "字节数" },
      sample: { type: "array", items: { type: "string" }, description: "样例文件名（最多 4 个）" }
    },
    required: ["key", "label", "kind", "path", "rel", "exists", "files", "bytes", "sample"]
  };
  ctx.tools.register({
    name: "novel_delete_book",
    description: "按书删/清(含回收站)：默认preview预览；apply移入回收站(keys选部分)；restore恢复；purge彻底删。不动全局/设置/日志。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        book: { type: "string", description: "书名" },
        action: {
          type: "string",
          enum: ["preview", "apply", "list", "restore", "purge"],
          description: "操作"
        },
        trashId: { type: "string", description: "回收站id" },
        keys: {
          type: "array",
          items: { type: "string", description: "key" },
          description: "只清指定targets[].key(apply)"
        },
        root: { type: "string", description: "书库根" }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string" },
          book: { type: "string" },
          safeBook: { type: "string" },
          found: { type: "boolean", description: "是否找到这本书的任何内容" },
          blocked: { type: "boolean", description: "书名命中保留名（全局词表 / 创作资料 / 点号目录）而拒绝删除" },
          blockedReason: { type: "string" },
          targets: { type: "array", items: targetSchema, description: "将清理的位置清单（一处一行）" },
          totals: { type: "object", additionalProperties: false, properties: { files: { type: "integer" }, bytes: { type: "integer" } }, required: ["files", "bytes"] },
          warnings: { type: "array", items: { type: "string" }, description: "需要用户留意的提示（同名清洗冲突、只有资料没有正文、失败项等）" },
          notTouched: { type: "array", items: { type: "string" }, description: "明确不受影响的东西（全局词表/插件设置/日志/其他书）" },
          trash: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                book: { type: "string" },
                createdAt: { type: "string" },
                files: { type: "integer" },
                bytes: { type: "integer" },
                items: { type: "integer" },
                restorable: { type: "boolean", description: "有 manifest 才能一键恢复" },
                path: { type: "string" }
              },
              required: ["id", "book", "createdAt", "files", "bytes", "items", "restorable", "path"]
            },
            description: "action=list 时的回收站条目"
          },
          trashId: { type: "string", description: "本次生成的回收站条目 id（恢复时用它）" },
          trashDir: { type: "string", description: "回收站目录绝对路径" },
          moved: { type: "integer", description: "实际移走的项数" },
          keys: { type: "array", items: { type: "string" }, description: "本次实际清理的位置 key（preview 时是可清理项全选）" },
          skipped: { type: "array", items: { type: "string" }, description: "按 keys 选择而**保留**的位置" },
          partial: { type: "boolean", description: "是否只清理了一部分（有位置被保留）" },
          profileRemoved: { type: "boolean", description: "是否同时移除了设定库里的本书条目" },
          profileRestored: { type: "boolean", description: "restore 时是否恢复了设定库条目" },
          restored: { type: "integer", description: "restore 成功项数" },
          conflicts: { type: "array", items: { type: "string" }, description: "restore 时原位置已有同名内容而跳过（绝不覆盖）" },
          failed: {
            type: "array",
            items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, code: { type: "string" }, error: { type: "string" } }, required: ["path", "code", "error"] },
            description: "逐项失败原因（被占用/无权限）"
          },
          remaining: { type: "object", additionalProperties: false, properties: { files: { type: "integer" }, bytes: { type: "integer" } }, required: ["files", "bytes"], description: "执行后复查的残留" },
          purged: { type: "boolean", description: "purge 是否成功" },
          message: { type: "string", description: "一句话结论" }
        },
        required: ["action", "book", "safeBook", "found", "blocked", "blockedReason", "targets", "totals", "warnings", "notTouched", "trash", "trashId", "trashDir", "moved", "keys", "skipped", "partial", "profileRemoved", "profileRestored", "restored", "conflicts", "failed", "remaining", "purged", "message"]
      },
      render: (_args, value) => [{ type: "text", text: formatBookDelete(value) }]
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_delete_book");
      const root = resolveRoot(config, args, exec);
      const value = await deleteBookDispatch(root, args);
      return cleanOutput(value);
    }
  });
}

export {
  registerNovelBooks,
  registerNovelChapters,
  registerNovelRead,
  registerNovelKeywords,
  registerNovelImport,
  registerNovelDeleteBook,
  deleteBookDispatch
};
