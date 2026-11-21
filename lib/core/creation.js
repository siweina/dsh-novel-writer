/**
 * dsh-novel-writer — core/creation.js（Layer 3B：创作资料目录/大纲工具与章节衔接检测）
 *
 * 严格 DAG 3B 层：只依赖 Node 内置、../log.js、../embedding.js、./state.js、./text.js 与 Layer 3A 的 ./stores.js，不依赖 http。
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logEvent } from "../log.js";
import * as embedding from "../embedding.js";
import {
  requiredString, sanitizeSegment, isAbort, resolveRoot, bookDir,
  semanticFeatureEnabled, assertToolEnabled, readSentenceState, noteRoot
} from "./state.js";
import { OUTLINE_LINE_RE, MAX_CHAPTER_NUMBER, parseChapterNumber, scanChapters, readTextFile } from "./text.js";
import { readSettings, normalizeCreationProfile, readBookCreationProfile, listBookCreationProfiles } from "./stores.js";

export const CREATION_DIR = "创作资料";
export const CREATION_FILES = {
  bible: "创作设定.md", "characters-main": "主要人物设定.md", "characters-minor": "次要人物设定.md",
  outline: "剧情大纲.md", hooks: "钩子记录.md", status: "创作状态卡.md"
};
const CREATION_TEMPLATE_TITLES = new Set(["# 创作设定", "# 主要人物设定", "# 次要人物设定", "# 剧情大纲", "# 钩子记录", "# 创作状态卡"]);
export function creationDir(root, book) {
  return join(root, "novels", CREATION_DIR, sanitizeSegment(book, "book"));
}
async function buildCreationUserSection(root, book, opts = {}) {
  // v3.1.0：字段值单行化（多行文本 → 空格），保证段内无空行、与 upsert 的空行边界配合
  const norm = function (s) { return String(s).replace(/\s*\n+\s*/g, " ").trim(); };
  var segs = [];
  try {
    // v3.1.0：按书专属设定优先（书库 settings/<book>.json > 遗留 state.creationProfiles），无该书专属时回退全局默认
    var cp = await readBookCreationProfile(root, book, { state: opts?.state, fallbackGlobal: true });
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
function upsertCreationSection(text, section, marker) {
  // 段边界 = 下一个标题（标题前可有空行/缩进）/ 下一个【…】段 / 文件尾（防吞掉段后手写内容）
  // v4.3.0 修正：旧前瞻 (?=\n# |\n\n|\s*$) 把「空行」当成段尾，段内一旦有空行就只覆盖到第一个空行——
  // remove 残留（"- 额外：B" 留在文件里）、replace 新旧两段并存（标记出现两次）。
  // 改为只认真正的段尾标记（# 标题 / 【…】段 / 文件尾）。`\r?\n\s*` 前缀是必需的：下一个标题前常有空行，
  // 若按字面写成 (?=\n# ) 则 "\n\n# 主要人物设定" 匹配不上，惰性量词会一路吞掉手写内容；
  // 同时容忍 CRLF（用户用记事本编辑过创作资料）。marker 转义：避免未来引入带正则元字符的标记时炸开。
  const escaped = String(marker).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(?:\\r?\\n){0,2}" + escaped + "[\\s\\S]*?(?=\\r?\\n\\s*#|\\r?\\n\\s*【|\\s*$)");
  const has = text.includes(marker);
  if (section === "") {
    if (!has) return text;
    const t = text.replace(re, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    return t;
  }
  if (has) {
    // v4.0.0 修正：改用函数式替换，避免用户文本里的 "$1"/"$&" 等美元替换模式被展开
    return text.replace(re, function () { return "\n\n" + section.trimEnd(); });
  }
  return text.trimEnd() + "\n\n" + section;
}
function upsertCreationUserSection(text, section) {
  return upsertCreationSection(text, section, "【用户原创设定】");
}
async function buildCreationCharacterSection(root, book, opts = {}) {
  const norm = function (s) { return String(s).replace(/\s*\n+\s*/g, " ").trim(); };
  try {
    var cp = await readBookCreationProfile(root, book, { state: opts?.state, fallbackGlobal: true });
    if (cp && typeof cp === "object" && typeof cp.characters === "string" && cp.characters.trim()) {
      return "【用户角色设定】（侧边栏填写，必须遵守）\n- 角色设定：" + norm(cp.characters) + "\n";
    }
  } catch { /* 读不到则视为无 */ }
  return "";
}
// v6.2.1 修正：读创作资料的**唯一入口**——只有"文件不存在"才回落到模板，其余读失败一律上抛。
// 旧版三处写动作（character/chapter/hook）都写成 `try { readTextFile } catch { 模板 }` 再整文件写回：
// readTextFile 会因「编码无法识别」「exec.signal 取消」「EACCES/EMFILE」抛错，这些都被当成"文件不存在"，
// 于是用户手写的剧情大纲 / 钩子记录 / 人物设定被静默清成一行新条目，工具还回"已补 / 已登记"。
async function readCreationFileOr(f, fallback, exec) {
  try {
    return await readTextFile(f, exec);
  } catch (e) {
    // 取消不是"读不到"：原样上抛，绝不降级成模板后写盘（否则取消会变成对用户文件的一次覆盖）
    if (isAbort(e)) throw e;
    // v6.6.0：这一支随后会把错误上抛（调用方自己会报出真因），此处只补一条可定位的痕迹，
    // 便于在事件日志里把「某次写动作在哪个文件上因何种错误中止」与调用方的失败对上
    if (e?.code !== "ENOENT") {
      logEvent("silent_skip", { file: f, level: "warn", detail: "创作资料读取失败（已上抛，未回落到模板）：" + String(e?.message ?? e) });
    }
    // 下面这行的条件与上一段相同是**刻意的**：原有控制流一行未动，本版只加日志、不改错误处理
    if (e?.code !== "ENOENT") throw e;
    return fallback;
  }
}
export async function syncCreationProfileFiles(root, patchProfiles, nextProfiles) {
  if (!root) return;
  let resolvedPatch = patchProfiles;
  let resolvedNext = nextProfiles;
  if (typeof patchProfiles === "string") {
    const singleBook = patchProfiles.trim();
    if (singleBook === "") return;
    const normSingle = normalizeCreationProfile(nextProfiles);
    resolvedPatch = { [singleBook]: normSingle };
    resolvedNext = normSingle ? { [singleBook]: normSingle } : {};
  } else if (resolvedNext === void 0 && resolvedPatch && typeof resolvedPatch === "object" && Object.keys(resolvedPatch).length > 0) {
    resolvedNext = await listBookCreationProfiles(root);
  }
  const base = join(root, "novels", CREATION_DIR);
  // v3.5.0 #20：清除全部（patch 为空对象 {} 或 nextProfiles 为 null）→ 扫描全部创作资料目录，逐本移除用户段 + 空壳清理
  const clearAll = (resolvedPatch && typeof resolvedPatch === "object" && Object.keys(resolvedPatch).length === 0) || resolvedNext === null;
  if (clearAll && !(resolvedPatch && Object.keys(resolvedPatch).length > 0)) {
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
  // 删除的键（patch 中 null / 空设定）：移除用户段
  if (resolvedPatch && typeof resolvedPatch === "object") {
    for (const book of Object.keys(resolvedPatch)) {
      if (resolvedPatch[book] === null || resolvedPatch[book] === void 0 || normalizeCreationProfile(resolvedPatch[book]) === null) {
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
        } catch {
          // v6.6.0：移除已删书目的用户段失败 → 面板说"已保存"，而 .md 里的旧段还在（静默不一致）
          logEvent("config", { book, level: "warn", detail: "移除创作资料用户段失败（面板设定与 .md 文件不一致）" });
        }
      }
    }
  }
  // 现存书（有有效设定）：创建/更新创作设定.md
  if (resolvedNext && typeof resolvedNext === "object") {
    let baseState = {};
    try { baseState = await readSentenceState(); } catch { baseState = {}; }
    const syncState = { ...baseState, creationProfiles: resolvedNext };
    for (const book of Object.keys(resolvedNext)) {
      const v = resolvedNext[book];
      if (!v || typeof v !== "object" || Object.keys(v).length === 0) continue;
      try {
        const dir = join(base, sanitizeSegment(book, "book"));
        await mkdir(dir, { recursive: true });
        const userSection = await buildCreationUserSection(root, book, { state: syncState });
        const f = join(dir, CREATION_FILES.bible);
        if (!existsSync(f)) {
          await writeFile(f, "# 创作设定\n\n（世界观规则 / 主线冲突 / 分卷目的 / 禁忌）\n\n" + userSection, "utf8");
        } else {
          const cur = await readFile(f, "utf8");
          const next = upsertCreationUserSection(cur, userSection);
          if (next !== cur) await writeFile(f, next, "utf8");
        }
        // v3.1.0：主要人物设定.md 同步【用户角色设定】段（方案 A：角色设定各归其位）
        const cs = await buildCreationCharacterSection(root, book, { state: syncState });
        const cf2 = join(dir, CREATION_FILES["characters-main"]);
        if (cs !== "") {
          if (!existsSync(cf2)) {
            await writeFile(cf2, "# 主要人物设定\n\n（目标→动机→弱点→说话方式→关系）\n\n" + cs, "utf8");
          } else {
            const ccur = await readFile(cf2, "utf8");
            const cnext = upsertCreationSection(ccur, cs, "【用户角色设定】");
            if (cnext !== ccur) await writeFile(cf2, cnext, "utf8");
          }
        } else if (existsSync(cf2)) {
          const ccur = await readFile(cf2, "utf8");
          const cnext = upsertCreationSection(ccur, "", "【用户角色设定】");
          if (cnext !== ccur) await writeFile(cf2, cnext, "utf8");
        }
      } catch {
        // v6.6.0：写创作资料 .md 失败（权限/占用/磁盘）→ 用户填的原创设定没进文件，
        // 而工具/面板已经回了"已保存"——这类"看起来成功"的写失败必须留痕
        logEvent("config", { book, level: "warn", detail: "创作资料写入失败（该书的设定未同步到 .md 文件）" });
      }
    }
  }
}
/** 逐行用 OUTLINE_LINE_RE 取章号（去重、保序）；非方向行直接忽略。core 内部复用该正则的唯一入口。 */
function outlineNumbers(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = OUTLINE_LINE_RE.exec(line);
    if (m === null) continue;
    const n = parseInt(m[1], 10);
    if (Number.isInteger(n) && !out.includes(n)) out.push(n);
  }
  return out;
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
          // v4.3.0 修正：删掉从不产出的 files（七个 action 没有一个返回它），补上 read 真实返回的 file
          properties: { book: { type: "string" }, action: { type: "string" }, message: { type: "string" }, content: { type: "string" }, file: { type: "string" } }
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
        const outlineState = await readSentenceState();
        const userSection = await buildCreationUserSection(root, book, { state: outlineState });
        const files = [
          ["bible", "# 创作设定\n\n（世界观规则 / 主线冲突 / 分卷目的 / 禁忌）\n\n" + userSection],
          ["characters-main", "# 主要人物设定\n\n（目标→动机→弱点→说话方式→关系）\n"],
          ["characters-minor", "# 次要人物设定\n\n（谁/作用/特征；不再出场标注）\n"],
          ["outline", "# 剧情大纲\n\n（每章方向行，写完回填钩子到钩子记录）\n"],
          ["hooks", "# 钩子记录\n\n（每章结尾钩子：状态/悬念/时间场景）\n"],
          ["status", "# 创作状态卡\n\n（进度/上一章结尾/时间线/活跃角色/下章方向/未回填钩子）\n"]
        ];
        // v7.3.3 修（M5）：写入前先统一检查六个目标路径没有被同名目录占位。旧版 existsSync 对目录也返回 true，
        // 于是「文件名被同名目录占位」的那些文件被静默跳过，init 仍回「已初始化（6 个文件）」，
        // 随后 read 才在 readFile 上炸 EISDIR（用户看到的是「初始化成功」却读不出内容）。
        // 放在写入循环之前：宁可一个文件都不写，也不要写到一半才报错。
        for (const [key] of files) {
          const f = join(dir, CREATION_FILES[key]);
          let occupiedByDir = false;
          try { occupiedByDir = (await stat(f)).isDirectory(); } catch (e) { if (e?.code !== "ENOENT") throw e; }
          if (occupiedByDir) {
            throw new Error("创作资料初始化失败：" + CREATION_FILES[key] + " 被同名目录占位（" + f + "）——请删除或重命名该目录后重试；init 不会写入被目录占位的路径");
          }
        }
        for (const [key, content] of files) {
          const f = join(dir, CREATION_FILES[key]);
          if (!existsSync(f)) {
            await writeFile(f, content, "utf8");
          } else if (key === "bible") {
            // v3.1.0：设定陈旧化修复——bible 已存在时只更新【用户原创设定】段（保留用户手写部分；无设定则移除旧段）
            const cur = await readTextFile(f, exec);
            const next = upsertCreationUserSection(cur, userSection);
            if (next !== cur) await writeFile(f, next, "utf8");
          }
          // v3.1.0：主要人物设定.md 角色段同步——首次创建（写模板后）与已存在（upsert）统一执行，角色设定不丢
          if (key === "characters-main") {
            const cs2 = await buildCreationCharacterSection(root, book, { state: outlineState });
            const ccur2 = await readTextFile(f, exec);
            const cnext2 = upsertCreationSection(ccur2, cs2, "【用户角色设定】");
            if (cnext2 !== ccur2) await writeFile(f, cnext2, "utf8");
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
        try {
          content = await readTextFile(f, exec);
        } catch (e) {
          // v6.6.0：**读不到 ≠ 没初始化**。旧版把任何读失败（损坏 / EACCES / 编码无法识别 / 取消）
          // 都说成「创作资料尚未初始化，请先 novel_outline init」——用户照做也修不好，真因彻底丢失。
          // 口径与 readCreationFileOr 一致（同文件上方）：取消先放行，只有 ENOENT 才是「尚未初始化」。
          if (isAbort(e)) throw e;
          if (e?.code === "ENOENT") throw new Error("创作资料尚未初始化，请先 novel_outline init（或在创作文件夹自行创建）", { cause: e });
          logEvent("config", { book, file: CREATION_FILES[key], level: "warn", detail: "创作资料读取失败（不是「尚未初始化」）：" + String(e?.message ?? e) });
          throw new Error("创作资料读取失败：" + f + "：" + String(e?.message ?? e).slice(0, 200), { cause: e });
        }
        // 强制机制：读状态卡/大纲时检查未回填钩子
        let remind = "";
        if (key === "status" || key === "outline") {
          try {
            // v3.1.0：大纲章节号从大纲文件提取（status 文件只有快照，不含章节行）
            const outlineContent = key === "status" ? await readTextFile(join(dir, CREATION_FILES.outline), exec) : content;
            const hooks = await readTextFile(join(dir, CREATION_FILES.hooks), exec);
            // v7.1.0 修正（审查 #52）：方向行解析统一走 OUTLINE_LINE_RE（与 graph/fixplan 同一口径，
            // 不再各写一份互相漏字：旧版 core 只认行首 `- 数字`，graph 还漏了「节」）。
            const outlined = outlineNumbers(outlineContent);
            const hooked = outlineNumbers(hooks);
            // v4.3.0 修正：只对**磁盘上确实存在**的章节报"未回填钩子"。
            // 旧版拿"大纲里出现过的章号"直接比对钩子记录，而大纲按设计会预先列出下一批章节方向
            // （如已写 1-5 章、大纲已有 `- 6 第6章方向…`），于是把尚未动笔的第 6 章也算成"写完却没回填"，
            // 提示与事实不符（实测：雨夜灯只有 5 章，却提示"未回填钩子章节：6"）。
            // 扫描失败时退回旧口径（宁多提醒，不漏提醒）。
            let existing = null;
            try {
              const scanned = await scanChapters(bookDir(root, book));
              existing = new Set(scanned
                .map((c) => c.number)
                .filter((n) => typeof n === "number"));
            } catch (e) {
              // v6.6.0：扫描失败 → 退回旧口径，但「章节扫不到」与「章还没写」在提醒文案上一模一样
              // 注意 cause：scanChapters 会把 ENOENT 包成友好错误（code 落在 cause 上，见其 catch），
              // 只看 e.code 会把最常见的「书目录还不存在」记成故障 ✗（实测的假阳性）
              if (e?.code !== "ENOENT" && e?.cause?.code !== "ENOENT") {
                logEvent("silent_skip", { book, level: "warn", detail: "章节扫描失败（未回填钩子提醒退回旧口径）：" + String(e?.message ?? e) });
              }
              /* 章节扫描失败：退回旧口径（宁多提醒，不漏提醒） */
            }
            const missing = outlined.filter((n) => !hooked.includes(n) && (existing === null || existing.has(n)));
            if (missing.length > 0) remind = "\n\n⚠ 未回填钩子章节：" + missing.join("、") + "——写完的章节必须回填钩子（novel_outline hook），下一章开头从钩子接续";
          } catch (e) {
            // v7.3.3 修（#11/M7）：取消先放行——旧版把 AbortError 当成「未初始化」吞掉，工具成功返回、
            // 只是少了「未回填钩子」提醒；取消还会被写进 silent_skip 事件日志（M7）。放行早于 logEvent。
            if (isAbort(e)) throw e;
            // v6.6.0：这里把任何读失败都当成「未初始化」而静默不提醒——非 ENOENT（损坏/权限/取消）必须留痕
            if (e?.code !== "ENOENT") {
              logEvent("silent_skip", { book, level: "warn", detail: "钩子记录/剧情大纲读取失败（未回填钩子提醒跳过）：" + String(e?.message ?? e) });
            }
            /* 未初始化 */
          }
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
        // v6.2.1：读失败只在 ENOENT 时回落模板（旧版把任何读失败都当"文件不存在"，随后整文件覆盖）
        const cur = await readCreationFileOr(f, (role === "main" ? "# 主要人物设定\n" : "# 次要人物设定\n") + "\n", exec);
        if (!existsSync(f)) await mkdir(dir, { recursive: true });
        const cur2 = cur.startsWith("# 主") || cur.startsWith("# 次") ? cur : "# " + (role === "main" ? "主要人物设定\n" : "次要人物设定\n") + "\n" + cur;
        const line = "- " + name + (description ? "：" + description : "") + "\n";
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
        if (isNaN(number) || number < 1 || number > MAX_CHAPTER_NUMBER) throw new Error(`chapter 需要 1~${MAX_CHAPTER_NUMBER} 的正整数 number`);
        const f = join(dir, CREATION_FILES.outline);
        // v6.2.1：同上——只有 ENOENT 才用空模板，读失败宁可报错也不覆盖用户手写的大纲
        const cur = await readCreationFileOr(f, "# 剧情大纲\n\n", exec);
        if (!existsSync(f)) await mkdir(dir, { recursive: true });
        const cur2 = cur.startsWith("# 剧") ? cur : "# 剧情大纲\n\n" + cur;
        const line = "- " + number + " " + title + "\n";
        // v7.1.0 修正（审查 #52）：判重必须**行首锚定**。旧版 `cur2.includes("- " + number + " ")`
        // 把正文里任何形如「- 3 」的片段（例：「他数了 - 3 秒钟」）都当成"第 3 章已在纲"，
        // 于是真的方向行永远补不进去（静默漏写）。只认行首 `- N` / `* N` 方向行。
        const alreadyOutlined = outlineNumbers(cur2).includes(number);
        if (alreadyOutlined) {
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
        if (isNaN(number) || number < 1 || number > MAX_CHAPTER_NUMBER) throw new Error(`hook 需要 1~${MAX_CHAPTER_NUMBER} 的正整数 number`);
        if (body === "") throw new Error("hook 需要 body（本章结尾状态/悬念/时间场景）");
        const f = join(dir, CREATION_FILES.hooks);
        // v6.2.1：同上——只有 ENOENT 才用空模板，读失败宁可报错也不覆盖用户手写的钩子记录
        const cur = await readCreationFileOr(f, "# 钩子记录\n\n", exec);
        if (!existsSync(f)) await mkdir(dir, { recursive: true });
        const cur2 = cur.startsWith("# 钩") ? cur : "# 钩子记录\n\n" + cur;
        const oneLineBody = String(body ?? "").replace(/^- \d+ /, "");
        const hookLine = "- " + number + " " + oneLineBody;
        const lines = cur2.replace(/\r\n?/g, "\n").split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        let replaced = false;
        const nextLines = [];
        for (const l of lines) {
          const hm = OUTLINE_LINE_RE.exec(l);
          if (hm !== null && parseInt(hm[1], 10) === number) {
            if (!replaced) { nextLines.push(hookLine); replaced = true; }
            continue;
          }
          nextLines.push(l);
        }
        if (!replaced) nextLines.push(hookLine);
        const next = nextLines.join("\n") + "\n";
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

const TIME_JUMP_WORDS = {
  hard: ["第二天", "第三天", "第四天", "第五天", "三天后", "四天后", "五天后", "六天后", "七天后", "十天后", "数天后", "一周后", "两周后", "半个月后", "一个月后", "两个月后", "三个月后", "半年后", "一年后", "两年后", "三年后", "多年后", "数日后", "几天后", "几天前", "几年后", "不久后", "很久以后"],
  soft: ["次日", "翌日", "次日清晨", "次日黄昏", "隔天", "深夜", "黎明", "清晨", "黄昏", "午夜", "当天晚上", "当晚"]
};
export async function detectChapterBridge(root, book, prevFile, currFile, exec) {
  const out = [];
  // v4.3.0 修正：入口统一净化书名——本函数内原本三处用原始 book 拼路径（章节读取两处 + readSettings），
  // 而同类入口（bookDir/creationDir/readBookAllText）都已净化：书名带非法路径字符时，
  // 前几项检查会读到不存在的路径并被外层 catch 吞成"0 候选"，看起来像"衔接正常"。
  const safeBook = sanitizeSegment(book, "book");
  try {
    const prevText = await readTextFile(join(root, "novels", safeBook, prevFile), exec);
    const currText = await readTextFile(join(root, "novels", safeBook, currFile), exec);
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
    } catch {
      // v6.6.0：语义检查没跑 ≠ 衔接没问题——旧版这一项被跳过时，候选列表里没有任何痕迹
      logEvent("engine", { book: safeBook, chapter: currFile, detail: "衔接·语义距离检查失败（本次跳过该项）" });
    }
    // ③ 人物延续（settings character 表；v3.5.0 #6：正确数据源 readSettings，勿用 UI state）
    try {
      const st = await readSettings(root, safeBook);
      const chars = ((st && st.characters) || []).filter((c) => c && typeof c === "object" && typeof c.name === "string" && c.name.length >= 2);
      const prevNames = chars.filter((c) => prevTail.includes(c.name)).map((c) => c.name);
      const currNames = chars.filter((c) => currHead.includes(c.name)).map((c) => c.name);
      if (prevNames.length > 0 && currNames.length === 0) {
        out.push({ type: "衔接·人物断线", detail: "上章结尾出场人物（" + prevNames.slice(0, 3).join("/") + "）本章开头 800 字均未出现——角色线可能断掉，建议让至少一人承接", chapters: [prevFile, currFile] });
      }
    } catch (e) {
      // v6.6.0：设定表读不到 → 人物延续检查静默跳过，与「这本书没登记过人物」无法区分
      // （readSettings 非 strict 时自己也会留痕；这里补的是**本次检查**的定位信息）
      if (e?.code !== "ENOENT") {
        logEvent("silent_skip", { book: safeBook, chapter: currFile, level: "warn", detail: "衔接·人物延续检查读取设定表失败（该项跳过）：" + String(e?.message ?? e) });
      }
      /* 设定表未登记跳过 */
    }
    // ④ 承接卡（上一章钩子文本 vs 本章开头 bigram 重叠）
    try {
      // v4.3.0 修正：改用 CREATION_DIR/CREATION_FILES 常量（原为手写 join(root,"novels","创作资料",book,"钩子记录.md")，
      // 与 creationDir() 是同一路径的两份实现，改名/改结构时必然漏改一处）
      const hooksPath = join(creationDir(root, safeBook), CREATION_FILES.hooks);
      const hooks = await readTextFile(hooksPath, exec);
      // v7.3.3 修（M6）：钩子行解析统一走 OUTLINE_LINE_RE（与 novel_outline read / graph / fixplan 同口径）。
      // 旧版硬编码 `/^- \d+ /`：同一份 `* 1 …` 钩子文件，novel_outline read 认得并提示「未回填钩子章节」，
      // 这里却一行都取不到 → 0 条「衔接·钩子未接」，两个工具对同一份数据给出相反结论。
      const hookLines = [];
      for (const line of hooks.split(/\r?\n/)) {
        const hm = OUTLINE_LINE_RE.exec(line);
        if (hm === null) continue;
        const hn = parseInt(hm[1], 10);
        if (Number.isInteger(hn)) hookLines.push({ number: hn, text: hm[2] });
      }
      // v3.2.0：取上一章（prevFile）对应的钩子，不取最后一行（钩子记录乱序时防比对错章）
      // v4.0.0 修正：统一章号口径——旧版取文件名首段数字，"第1卷03章.md" 会比对到错误的钩子
      const prevNum = parseChapterNumber(prevFile);
      const prevHook = hookLines.find((h) => h.number === prevNum);
      if (prevHook) {
        const lastHook = prevHook.text;
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
    } catch (e) {
      // v7.3.3 修（#11/M7）：取消先放行——旧版把 AbortError 当成「没有创作资料」吞掉，检查静默跳过、
      // 返回值与不取消时完全相同（取消被伪装成成功），还会写进 silent_skip 事件日志（M7）。放行早于 logEvent。
      if (isAbort(e)) throw e;
      // v6.6.0：钩子记录读不到 → 承接检查静默跳过，与「没有创作资料」无法区分（取消也会落到这里）
      if (e?.code !== "ENOENT") {
        logEvent("silent_skip", { book: safeBook, chapter: currFile, level: "warn", detail: "衔接·钩子未接检查读取钩子记录失败（该项跳过）：" + String(e?.message ?? e) });
      }
      /* 无创作资料跳过 */
    }
  } catch (e) {
    // v6.2.1 修正：取消放行——旧版把 AbortError 也渲染成一条「衔接·检查跳过」候选，
    // 用户看到的是"检查跳过"而不是"已取消"（isAbort 是全插件唯一取消判据，详见其定义处注释）。
    if (isAbort(e)) throw e;
    // v4.3.0 修正：读取失败不再静默返回空数组——"文件读不到"与"衔接没有问题"在输出上原本无法区分
    // （整类检查被吞掉，用户会以为检查通过）。透出一条同构候选（带 type/chapters，render 可渲染）。
    out.push({
      type: "衔接·检查跳过",
      detail: "无法读取章节文本（" + safeBook + "：" + prevFile + " → " + currFile + "）：" + String(e?.message ?? e).slice(0, 120) + "——时间/人物/钩子类衔接检查本次全部跳过",
      chapters: [prevFile, currFile]
    });
  }
  return out;
}
