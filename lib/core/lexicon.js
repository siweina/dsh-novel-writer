/**
 * dsh-novel-writer — core/lexicon.js（Layer 3A：必用词表存储、合并、开写包取用与成稿审计）
 *
 * 严格 DAG 3A 层：只依赖 Node 内置、../log.js 与 ./state.js，不依赖同层其他 domain 模块与 http。
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logEvent } from "../log.js";
import { sanitizeSegment, novelDataDir, atomicWriteJson, noteRoot } from "./state.js";

// ==================== v6.2.0：必用词表（lexicon） ====================
/**
 * 必用词表：把「某场景必须使用的专有名词 / 作者习惯用词」登记成表，
 * 动笔前由开写包与系统提示词形成**硬清单**（必须用表内词，不得换成通用说法），
 * 成稿后再用 novel_lexicon action=audit 扫覆盖率与「通用替身词」顶替位置。
 *
 * 两层存储（书级同名条目覆盖全局）：
 *   全局 <root>/.novel-writer/lexicon/_global.json —— 作者惯用词/跨书命名规范
 *   书级 <root>/.novel-writer/lexicon/<书名>.json  —— 本书专名
 * 条目字段：term(必填) / kind / scene / avoid[](通用替身) / aliases[](等价写法) / note / priority / enabled
 */
export const LEXICON_KINDS = Object.freeze(["专名", "偏好词", "称呼", "场景词", "口头禅", "其他"]);
export const GLOBAL_LEXICON_BOOK = "_global";
// v6.2.1：删除零引用的 LEXICON_SCOPES（附录 B 第 17 条）——作用层的合法性由 isGlobalLexiconScope
// 与各入口的 scope 判定直接表达，多一份常量只会与实际接受值漂移。作用层字符串："book" / "global"。

function lexiconDir(root) {
  return join(novelDataDir(root), "lexicon");
}
export function lexiconFile(root, book) {
  // 读侧容忍空书名（=只读全局层）；写侧仍要求显式书名（见 writeLexicon），避免"以为写本书、实际动了全局"
  const trimmed = String(book ?? "").trim();
  const key = isGlobalLexiconScope(trimmed) || trimmed === "" ? GLOBAL_LEXICON_BOOK : sanitizeSegment(trimmed, "book");
  return join(lexiconDir(root), key + ".json");
}
/** "_global" 是词表专用保留书号：全局层不属于任何一本书。 */
function isGlobalLexiconScope(book) {
  return String(book ?? "").trim() === GLOBAL_LEXICON_BOOK;
}
/**
 * 批量录入行解析（三种写法都认）：
 *   星轨
 *   星轨 | 专名 | 战斗 | 轨道,轨迹 | 用于跃迁场面
 *   星轨<TAB>专名<TAB>战斗<TAB>轨道,轨迹<TAB>用于跃迁场面
 * `#` 开头为注释；返回 null 表示该行跳过。
 */
export function parseLexiconLine(line) {
  const raw = String(line ?? "").trim();
  if (raw === "" || raw.startsWith("#")) return null;
  const cut = raw.split(raw.includes("\t") ? "\t" : "|").map(function (s) { return s.trim(); });
  if (cut.length === 0 || cut[0] === "") return null;
  const entry = { term: cut[0] };
  if (cut[1]) entry.kind = cut[1];
  if (cut[2]) entry.scene = cut[2];
  if (cut[3]) entry.avoid = cut[3].split(/[,，、\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (cut[4]) entry.note = cut[4];
  return entry;
}
/**
 * v6.2.1：判断"读不出内容"是文件不存在、内容不是合法 JSON，还是文件根本读不动。
 * 旧版 readLexiconFile 把读取失败与 ENOENT 混成同一个 `exists:false, entries:[]`，
 * 于是 UI 的 read→write（toggle / save / import）读到空表就写回空表——整层条目被静默清空。
 * 口径：ENOENT → 不标记损坏；其余一律 corrupt=true（fail-safe：读不出来就绝不覆盖，
 * 由 writeLexicon 的守卫拦住写操作），并用 parseFailed 区分「内容不是合法 JSON」与
 * 「文件读不动（EISDIR / EACCES / EMFILE…）」——两者的提示文案不同，
 * 免得把权限/IO 问题说成"文件损坏（不是合法 JSON）"。
 * v6.3.0 更正：原注释写"其余（EACCES/EMFILE…）仍照旧按 missing 处理"，与实现（非 ENOENT
 * 全部判 corrupt）恰好相反——这正是本套清单反复判定的"注释与实现不符"，故一并改齐。
 */
function classifyLexiconReadError(e) {
  if (e?.code === "ENOENT") return { corrupt: false, parseFailed: false, reason: "文件不存在" };
  const parseFailed = e instanceof SyntaxError || e?.name === "SyntaxError";
  return {
    corrupt: true,
    parseFailed,
    reason: String(e?.message ?? e).slice(0, 160)
  };
}
export async function readLexiconFile(root, book) {
  const file = lexiconFile(root, book);
  const bookKey = isGlobalLexiconScope(book) ? GLOBAL_LEXICON_BOOK : String(book ?? "");
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    // v6.2.1：区分「文件不存在」与「文件损坏」（见 classifyLexiconReadError 注释）
    const info = classifyLexiconReadError(e);
    // v6.6.0：文件存在却读不动（EACCES/EISDIR/EMFILE）= 损坏口径。旧版只把它写进返回体，
    // 于是"词表坏了"与"词表还没建"在日志里毫无区别（真因无处可查）。
    if (info.corrupt) logEvent("config", { file, book: bookKey, level: "warn", detail: "词表文件读取失败：" + info.reason });
    return { exists: false, corrupt: info.corrupt, corruptError: info.corrupt ? info.reason : void 0, file, book: bookKey, enabled: true, entries: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // v6.2.1：文件在磁盘上、但内容不是合法 JSON —— exists 仍为 true（文件确实存在），
    // corrupt=true + corruptError 让调用方拒绝覆盖，并把原因透到响应体/工具消息里
    // v6.6.0：解析失败同样留痕——用户报"词表不见了"时，日志要能区分"没建"与"建坏了"
    // v6.6.0：**不再把 JSON.parse 的原始 message 透出去**（诊断模块实现者实测并报告的隐私缺口）。
    //
    // 原因：Node 的 JSON.parse 报错会**回显文件开头若干字符**——实测
    //   `Unexpected token '这', "这是一段被误写成 json 的正文" is not valid JSON`
    // 而这条 message 原本经 corruptError → corruptFields 一路进了 novel_lexicon 的**返回体与面板**。
    // 也就是说：词表文件一旦被正文覆盖或写坏，**正文片段就会出现在工具输出里** ✗
    // 这与 v6.6.0「任何离开本机的内容都不含自由文本」的口径直接冲突。
    // 改成固定分类：只说"是什么错"，不说"错在哪段文字"（人要看内容可以自己打开那个文件）。
    const label = "内容不是合法 JSON（解析失败）";
    logEvent("config", { file, book: bookKey, level: "warn", detail: "词表文件不是合法 JSON（已拒绝覆盖）" });
    return { exists: true, corrupt: true, corruptError: label, file, book: bookKey, enabled: true, entries: [] };
  }
  return {
    exists: true,
    corrupt: false,
    file,
    book: bookKey,
    enabled: parsed?.enabled !== false,
    entries: normalizeLexiconList(parsed?.entries),
    updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : void 0
  };
}
/** 合成视图：全局在前、书级在后，同名以书级为准（全局层 enabled=false 时整层不参与）。 */
export async function readLexicon(root, book) {
  const global = await readLexiconFile(root, GLOBAL_LEXICON_BOOK);
  const trimmed = String(book ?? "").trim();
  const hasBook = trimmed !== "" && !isGlobalLexiconScope(trimmed) && sanitizeSegment(trimmed, "book") !== GLOBAL_LEXICON_BOOK;
  const own = hasBook
    ? await readLexiconFile(root, trimmed)
    : { exists: false, corrupt: false, file: "", book: "", enabled: true, entries: [], updatedAt: void 0 };
  const merged = new Map();
  if (global.enabled) for (const e of global.entries) merged.set(e.term, { ...e, scope: "global" });
  if (own.enabled) for (const e of own.entries) merged.set(e.term, { ...e, scope: "book" });
  return {
    entries: [...merged.values()],
    global,
    book: own,
    // v6.2.1：损坏标记上浮到合成视图，供工具/UI 显示"该层文件损坏"而不是"该层为空"
    corrupt: global.corrupt === true || own.corrupt === true,
    corruptFiles: [global, own].filter(function (f) { return f.corrupt === true; }).map(function (f) { return { file: f.file, error: f.corruptError ?? "" }; }),
    files: { global: global.file, book: own.file },
    counts: { global: global.entries.length, book: own.entries.length, effective: merged.size }
  };
}
export async function writeLexicon(root, book, data) {
  const explicitGlobal = book === GLOBAL_LEXICON_BOOK;
  const safeBook = explicitGlobal ? GLOBAL_LEXICON_BOOK : sanitizeSegment(book, "book");
  if (!explicitGlobal && safeBook === GLOBAL_LEXICON_BOOK) {
    throw new Error(`书名「${String(book ?? "")}」清洗后会与全局词表保留名「${GLOBAL_LEXICON_BOOK}」冲突，已拒绝写入；写全局词表请显式传「${GLOBAL_LEXICON_BOOK}」`);
  }
  const file = lexiconFile(root, safeBook);
  // v6.2.1 修正（数据丢失）：写入前先确认目标文件可解析——调用方都是 read→改→write，
  // 一旦 read 把"损坏"当成"空表"，这次写就会把整层条目覆盖成空表（实测：坏 JSON 的 _global.json
  // 经一次 toggle 后被覆写成 entries:[]，原条目永久消失）。损坏时默认拒写并给出修复指引；
  // 只有显式 force=true（UI 二次确认覆盖 / 工具侧明确要求）才允许覆盖。args.overwrite 不是这里的语义。
  if (data?.force !== true) {
    const guard = await readLexiconFile(root, safeBook);
    if (guard.corrupt === true) {
      const err = new Error(
        "词表文件无法读取或内容不是合法 JSON，已拒绝覆盖以免丢掉原条目：" + file +
        "；原因：" + (guard.corruptError ?? "解析失败") +
        "【解决：先备份并手工修复该文件；确认要丢弃其内容时用 force/overwrite 覆盖写入】"
      );
      err.code = "ENOVELWRITEFAIL";
      err.corrupt = true;
      throw err;
    }
  }
  await mkdir(dirname(file), { recursive: true });
  const entries = normalizeLexiconList(data?.entries);
  const payload = { book: safeBook, enabled: data?.enabled !== false, entries, updatedAt: new Date().toISOString() };
  await atomicWriteJson(file, payload);
  await noteRoot(root); // 与 settings 写操作同口径：记录书库根，供 UI 定位数据目录
  return { file, enabled: payload.enabled, entries, count: entries.length };
}
/** 一条词条归一：term 为空一律丢弃（不污染词表）；数组字段接受字符串（逗号/顿号/空格分隔）。 */
export function normalizeLexiconEntry(raw) {
  if (raw === null || raw === void 0) return null;
  let entry = raw;
  if (typeof raw === "string") entry = parseLexiconLine(raw) ?? {};
  if (typeof entry !== "object" || Array.isArray(entry)) return null;
  const term = String(entry.term ?? entry.word ?? entry.name ?? "").trim();
  if (term === "" || term.length > 60) return null;
  const out = { term };
  const kind = String(entry.kind ?? "").trim();
  if (kind !== "") out.kind = kind.slice(0, 12);
  for (const key of ["scene", "note"]) {
    const value = entry[key];
    if (value !== null && value !== void 0 && String(value).trim() !== "") out[key] = String(value).trim().slice(0, 200);
  }
  for (const key of ["avoid", "aliases"]) {
    const list = Array.isArray(entry[key]) ? entry[key]
      : (typeof entry[key] === "string" ? entry[key].split(/[,，、\s]+/) : []);
    const cleaned = [...new Set(list.map(function (x) { return String(x).trim(); }).filter(function (x) { return x !== "" && x !== term; }))];
    if (cleaned.length > 0) out[key] = cleaned;
  }
  if (entry.priority === "high") out.priority = "high";
  if (entry.enabled === false) out.enabled = false;
  return out;
}
const LEXICON_PATCH_KEYS = ["kind", "scene", "note", "avoid", "aliases", "priority", "enabled"];
function parseRawLexiconPatch(raw) {
  if (raw === null || raw === void 0) return null;
  let entry = raw;
  if (typeof raw === "string") entry = parseLexiconLine(raw);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const term = String(entry.term ?? entry.word ?? entry.name ?? "").trim();
  if (term === "" || term.length > 60) return null;
  const patch = { term };
  for (const key of LEXICON_PATCH_KEYS) {
    if (entry[key] !== void 0) patch[key] = entry[key];
  }
  return patch;
}
function collapseRawLexiconPatches(list) {
  const out = [];
  const index = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const patch = parseRawLexiconPatch(raw);
    if (patch === null) continue;
    if (index.has(patch.term)) {
      const i = index.get(patch.term);
      out[i] = { ...out[i], ...patch };
      continue;
    }
    index.set(patch.term, out.length);
    out.push(patch);
  }
  return out;
}
/** 同一 term 后写覆盖前写（书级覆盖全局也走这条），保持首次出现顺序。 */
export function normalizeLexiconList(list) {
  const out = [];
  for (const patch of collapseRawLexiconPatches(list)) {
    const entry = normalizeLexiconEntry(patch);
    if (entry !== null) out.push(entry);
  }
  return out;
}
/** 词条转一行文本（工具输出与 UI 共用口径）。 */
export function lexiconEntryLine(entry) {
  const bits = [entry.term];
  if (entry.kind) bits.push(entry.kind);
  if (entry.scene) bits.push("场景:" + entry.scene);
  if (Array.isArray(entry.avoid) && entry.avoid.length > 0) bits.push("勿用:" + entry.avoid.join("/"));
  if (Array.isArray(entry.aliases) && entry.aliases.length > 0) bits.push("等价:" + entry.aliases.join("/"));
  if (entry.note) bits.push(entry.note);
  if (entry.priority === "high") bits.push("★高优先");
  if (entry.enabled === false) bits.push("（已停用）");
  return bits.join("｜");
}
/** 合并追加：existing 中同 term 的条目按 patch 覆盖；返回新数组与统计。 */
export function mergeLexiconEntries(existing, incoming, opts) {
  const list = normalizeLexiconList(existing);
  const index = new Map(list.map(function (e, i) { return [e.term, i]; }));
  const added = [], updated = [], skipped = [];
  for (const patch of collapseRawLexiconPatches(incoming)) {
    if (index.has(patch.term)) {
      const i = index.get(patch.term);
      if (opts?.overwrite === false) { skipped.push(patch.term); continue; }
      const merged = normalizeLexiconEntry({ ...list[i], ...patch });
      if (merged !== null) list[i] = merged;
      updated.push(patch.term);
    } else {
      const entry = normalizeLexiconEntry(patch);
      if (entry === null) continue;
      index.set(entry.term, list.length);
      list.push(entry);
      added.push(entry.term);
    }
  }
  return { entries: list, added, updated, skipped };
}
/** 按场景命中度 + 优先级排序供开写包取用：场景命中 > 高优先 > 书级 > 其余（保持登记顺序）。 */
export function selectLexiconForBrief(entries, outlineDirection, limit) {
  const direction = String(outlineDirection ?? "");
  const active = (Array.isArray(entries) ? entries : []).filter(function (e) { return e.enabled !== false; });
  const scored = active.map(function (e, i) {
    const sceneHit = e.scene !== void 0 && e.scene !== "" && direction !== "" && direction.includes(e.scene);
    const score = (sceneHit ? 4 : 0) + (e.priority === "high" ? 2 : 0) + (e.scope === "book" ? 1 : 0);
    return { entry: e, score, order: i };
  });
  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return a.order - b.order;
  });
  const cap = typeof limit === "number" && limit > 0 ? limit : scored.length;
  return { items: scored.slice(0, cap).map(function (x) { return x.entry; }), total: scored.length, truncated: scored.length > cap };
}
/** 按 kind 分组（无 kind 归入「其他」），组内保持原顺序。 */
export function groupLexiconByKind(entries) {
  const groups = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const key = e.kind !== void 0 && e.kind !== "" ? e.kind : "其他";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return [...groups.entries()].map(function ([kind, list]) { return { kind, entries: list }; });
}
function lexiconSnippet(line) {
  const text = String(line ?? "").trim();
  return text.length > 46 ? text.slice(0, 46) + "…" : text;
}
/**
 * 成稿用词审计（只读）：对给定正文统计
 *   covered —— 已用到的必用词（含 aliases 等价写法）及首次出现行
 *   missing —— 一次都没出现的必用词（按 场景命中/高优先 靠前）
 *   avoidHits —— 用了「通用替身词」的位置（行号 + 原句片段），说明该处本该用必用词
 */
export function auditLexicon(entries, text, outlineDirection) {
  const lines = String(text ?? "").split(/\r?\n/);
  const covered = [], missing = [], avoidHits = [];
  const { items } = selectLexiconForBrief(entries, outlineDirection, 0);
  // v7.1.0 修正（审查 #31）：**合法专名占位**提到词条循环之外，跨词条共享。
  // 旧版每个词条各分一份 lineSpans（只在循环内可见）：A 条目的必用词「灵芝草」占住的位置，
  // 到了 B 条目的替身词「草」那里完全不可见 → 正常的专名内部用字被报成"用了通用替身词"。
  const lineSpans = lines.map(() => []);
  for (const e of items) {
    const forms = [...new Set([e.term, ...(Array.isArray(e.aliases) ? e.aliases : [])])]
      .filter((f) => typeof f === "string" && f.length > 0)
      .sort((a, b) => b.length - a.length);
    let count = 0;
    let firstLine = 0;
    // 覆盖计数仍然只看**本词条**的占位：共享全局占位会让"短词落在另一条目的长词里"被漏计
    //（例：「草药」与「药」都登记、正文只有「草药」时，「药」明明出现了却被判 missing）。
    const ownSpans = lines.map(() => []);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const own = ownSpans[i];
      for (const form of forms) {
        let from = 0;
        while (from <= line.length - form.length) {
          const at = line.indexOf(form, from);
          if (at === -1) break;
          const end = at + form.length;
          // v7.1.0 修正（审查 #31）：**严格包含**判定（旧版是区间相交 at < s.end && end > s.start）。
          // 相交判定会把「草药」当成"已落在必用词「药」内部"从而漏报——替身词包含必用词时
          // 必须报。只有 s.start <= at && end <= s.end（整段落在合法专名内）才算正常用词。
          const overlapped = own.some((s) => s.start <= at && end <= s.end);
          if (!overlapped) {
            own.push({ start: at, end });
            lineSpans[i].push({ start: at, end }); // 全局占位：供下方 avoid 判定（跨词条互通）
            count += 1;
            if (firstLine === 0) firstLine = i + 1;
          }
          from = end;
        }
      }
    }
    if (count > 0) covered.push({ term: e.term, count, firstLine });
    else missing.push({ term: e.term, kind: e.kind ?? "", scene: e.scene ?? "", priority: e.priority === "high" ? "high" : "normal" });
  }
  // 替身词判定单独一遍：必须等**所有**词条的必用词占位都算完，跨词条保护才成立。
  for (const e of items) {
    for (const word of Array.isArray(e.avoid) ? e.avoid : []) {
      if (typeof word !== "string" || word.length === 0) continue;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const spans = lineSpans[i];
        let from = 0;
        while (from <= line.length - word.length) {
          const at = line.indexOf(word, from);
          if (at === -1) break;
          const end = at + word.length;
          // v7.1.0 修正（审查 #31）：同上，严格包含（替身词"包含"必用词时不得被当成合法专名）。
          const insideCoveredForm = spans.some((s) => s.start <= at && end <= s.end);
          if (!insideCoveredForm) {
            avoidHits.push({ term: e.term, word, line: i + 1, snippet: lexiconSnippet(line) });
          }
          from = end;
        }
      }
    }
  }
  const total = items.length;
  return {
    total,
    coveredCount: covered.length,
    missingCount: missing.length,
    coverage: total > 0 ? Math.round((covered.length / total) * 1000) / 10 : 100,
    covered,
    missing,
    avoidHits
  };
}
