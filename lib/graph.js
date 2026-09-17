/**
 * dsh-novel-writer — 结构视图（story graph；v5.0.0 新增，独立文件）
 *
 * 解决的问题：伏笔表 / 人物设定 / 时间线 / 剧情大纲在插件里都是**离散静态表**，
 * 没有任何跨章计算。长篇崩掉通常不是某章文笔差，而是"线断了、人丢了、伏笔忘了"。
 * 本模块把四张表与全部章节正文做一次跨章计算，产出：
 *   plotLifecycle  伏笔埋设—跨度（未回收伏笔埋了多久）
 *   characterMatrix 人物 × 章节出场矩阵 + 连续缺席区间
 *   threadActivity 由伏笔关联人物/地点聚出的"剧情线"及其活跃章号、跨度、最大空档
 *   timelineOrder  时间线登记顺序 vs 章号顺序是否一致
 *   planVsActual   创作资料大纲"方向行"与实际正文的关键词重合率
 *
 * 硬约束（与插件其余部分一致）：
 * - 纯 Node ESM、零新依赖、无网络请求、不调用任何 LLM；
 * - **只读**：不落盘、不写缓存。因此伏笔表**不走** core.readPlots（它在"新位置缺失 +
 *   旧位置存在"时会迁移写盘），这里用 plotsFile/legacyPlotsFile 两个纯路径函数 + readFile 自行解析；
 * - 除"book 目录不存在"外**零抛错**：缺表 / 缺大纲 / 缺摘要 / 空书 / 单章读失败
 *   → 对应字段给空数组或按空正文处理，并在 degraded 里写中文原因。
 *   唯一例外是调用方主动取消（AbortError，见 core.isAbort）——取消必须上抛，
 *   否则宿主会把"已取消"当成一次成功但内容为空的结构视图。
 *
 * 全部新增逻辑统一用 `// v5.0.0：` 前缀标注。
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bookDir,
  scanChapters,
  readTextFile,
  readSettings,
  readSummaries,
  creationDir,
  CREATION_FILES,
  plotsFile,
  legacyPlotsFile,
  extractKeywords,
  plotKeywords,
  normalizePlotEntry,
  normalizeSettingEntry,
  parseChapterNumber,
  isAbort,
  CJK_STOP_CHARS
} from "./core.js";

// v5.0.0：连续缺席判定阈值——主要人物连续缺席 ≥ 5 章才算一条 absences（调用方可经 opts 覆盖）
const DEFAULT_ABSENCE_THRESHOLD = 5;
// v5.0.0：剧情线标签最多取几个共享实体（人物/地点）拼接
const THREAD_LABEL_MAX = 2;
// v5.0.0：内容聚类时"共享关键词"的最小长度——二字片段区分度太低，不做跨条目连线
const CONTENT_LINK_MIN_LEN = 3;
// v5.0.0：方向行关键词上限（extractKeywords/相邻二字片段共用的截断口径）
const DIRECTION_KEYWORD_MAX = 12;

// ───────────────────────────── 通用小工具 ─────────────────────────────

function describeError(e) {
  // v5.0.0：统一降级文案里的错误描述（Error / 字符串 / 任意抛出品都能读）
  if (e && typeof e.message === "string" && e.message !== "") return e.message;
  return String(e);
}

function uniqueStrings(list) {
  // v5.0.0：有序去重（保留首次出现顺序），用于别名/实体名归一
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const value = String(item ?? "").trim();
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function round3(value) {
  // v5.0.0：重合率取 3 位小数（要求 2~4 位之间）
  return Math.round(value * 1000) / 1000;
}

function assertBook(book) {
  // v5.0.0：书名参数错误属于调用错误（不在"仅书目录不存在才抛"的降级口径内），仍给中文提示
  const value = typeof book === "string" ? book.trim() : "";
  if (value === "") throw new Error("buildStoryGraph 需要非空的书名（book 参数）");
  return value;
}

function emptyGraph(book, degraded, summary) {
  // v5.0.0：字段名与正常返回完全一致的空结构（降级路径专用，保证调用方 schema 不炸）
  return {
    book,
    totalChapters: 0,
    plotLifecycle: [],
    characterMatrix: { characters: [], rows: [], absences: [] },
    threadActivity: [],
    timelineOrder: [],
    planVsActual: [],
    summary: summary ?? "《" + book + "》结构视图为空。",
    degraded
  };
}

// ───────────────────────────── 章节层 ─────────────────────────────

function assignChapterNumbers(chapters) {
  // v5.0.0：章号口径与 core.parseChapterNumber 一致（scanChapters 已给出 number）；
  // 解析不出章号的文件按扫描顺序占位编号，否则它们会被"全书最大章号"口径整段吞掉。
  const list = [];
  const unresolved = [];
  for (let i = 0; i < chapters.length; i += 1) {
    const c = chapters[i];
    const hasNumber = typeof c.number === "number";
    if (!hasNumber) unresolved.push(c.file);
    list.push({ file: c.file, title: c.title ?? "", number: hasNumber ? c.number : i + 1 });
  }
  return { list, unresolved };
}

async function loadChapterTexts(dir, chapters, exec, degraded) {
  // v5.0.0：一次读完所有章节正文（后面四块计算全都基于它）。单章读失败（编码/权限/被占用）
  // 只把该章按空正文处理并记 degraded，绝不打断整次结构视图。
  const out = [];
  for (const c of chapters) {
    let text = "";
    try {
      text = await readTextFile(join(dir, c.file), exec);
    } catch (e) {
      if (isAbort(e)) throw e; // v5.0.0：取消不是"读取失败"，必须继续向上抛（见 core.isAbort）
      degraded.push("第 " + c.number + " 章（" + c.file + "）读取失败，本次按空正文处理：" + describeError(e));
    }
    out.push({ file: c.file, title: c.title, number: c.number, text });
  }
  return out;
}

// ───────────────────────────── 伏笔层 ─────────────────────────────

async function readPlotsReadOnly(root, book) {
  // v5.0.0：只读解析伏笔表。刻意不复用 core.readPlots——那个函数在新位置缺失、旧位置存在时
  // 会把旧文件迁移写到新位置（本模块承诺不落盘）。读取顺序与新→旧一致。
  const candidates = [plotsFile(root, book), legacyPlotsFile(root, book)];
  let found = false;
  let broken = false;
  for (const file of candidates) {
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue; // 文件不存在：试下一个位置
    }
    found = true;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.entries)) return { entries: parsed.entries, found: true, broken: false };
    } catch {
      broken = true; // 文件在但坏了：继续试下一个位置，最后按空表 + degraded 处理
    }
  }
  return { entries: [], found, broken };
}

function plotKeywordSets(content) {
  // v5.0.0：复用 core.plotKeywords（与 novel_plot scan 的"提及"口径同源：2~4 字连续片段，最多 8 个）
  const keywords = plotKeywords(String(content ?? ""));
  return {
    strong: keywords.filter((k) => k.length >= 3),
    weak: keywords.filter((k) => k.length === 2)
  };
}

function textMentionsPlot(text, sets) {
  // v5.0.0：某章正文是否"提及"该伏笔——长词（≥3 字）命中 1 个即算；短词（2 字）需命中 ≥2 个。
  // 原因：plotKeywords 会产出"的青铜"这类碎片，只认单个二字片段会大量假命中。
  if (!text) return false;
  if (sets.strong.some((k) => text.includes(k))) return true;
  let weakHit = 0;
  for (const k of sets.weak) {
    if (text.includes(k)) weakHit += 1;
    if (weakHit >= 2) return true;
  }
  return false;
}

function buildPlotLifecycle(openEntries, texts, maxChapter, degraded) {
  // v5.0.0：未回收伏笔的埋设章 + 已过章数。
  // firstChapter = 最早提及章号：正文关键词命中 ∪ mentionedIn（novel_plot scan 写入的文件名）∪ chapter 字段，
  // 三者取最小；全都没有则 firstChapter/distance 记 null（并在 degraded 说明，不编造数字）。
  const items = [];
  openEntries.forEach((entry, index) => {
    const sets = plotKeywordSets(entry.content);
    const mentioned = new Set();
    for (const ch of texts) {
      if (textMentionsPlot(ch.text, sets)) mentioned.add(ch.number);
    }
    if (Array.isArray(entry.mentionedIn)) {
      for (const file of entry.mentionedIn) {
        const n = parseChapterNumber(String(file));
        if (typeof n === "number") mentioned.add(n);
      }
    }
    if (typeof entry.chapter === "string" && entry.chapter.trim() !== "") {
      const n = parseChapterNumber(entry.chapter);
      if (typeof n === "number") mentioned.add(n);
    }
    const chapters = [...mentioned].sort((a, b) => a - b);
    const firstChapter = chapters.length > 0 ? chapters[0] : null;
    const distance = firstChapter !== null && maxChapter > 0 ? maxChapter - firstChapter : null;
    if (sets.strong.length === 0 && sets.weak.length === 0) {
      degraded.push("伏笔 #" + entry.id + " 的内容里没有可匹配的中文片段：正文关键词命中为空，firstChapter 只能靠登记字段推断");
    }
    if (firstChapter === null) {
      degraded.push("伏笔 #" + entry.id + "（" + String(entry.content).slice(0, 16) + "…）在正文与登记字段里都找不到提及章号：firstChapter/distance 不可知，输出里整键省略");
    }
    items.push({
      index,
      entry,
      chapters,
      firstChapter,
      distance,
      tokens: uniqueStrings([...(Array.isArray(entry.relatedCharacters) ? entry.relatedCharacters : []), ...(Array.isArray(entry.locations) ? entry.locations : [])]),
      contentKeywords: plotKeywords(String(entry.content ?? "")).filter((k) => k.length >= CONTENT_LINK_MIN_LEN)
    });
  });
  // v5.0.0：列表按"埋设章升序（未知排最后）、其次 id"排序——读图时先看最早的线索
  items.sort((a, b) => {
    const av = a.firstChapter === null ? Number.MAX_SAFE_INTEGER : a.firstChapter;
    const bv = b.firstChapter === null ? Number.MAX_SAFE_INTEGER : b.firstChapter;
    return av - bv || String(a.entry.id).localeCompare(String(b.entry.id));
  });
  return items;
}

// ───────────────────────────── 人物层 ─────────────────────────────

function collectCharacters(rawCharacters, degraded) {
  // v5.0.0：人物来自 settings.characters；用 core.normalizeSettingEntry 兜脏数据（[null]/[123] 手改坏表）。
  // 名字/别名不足 2 字的一律跳过——单字名在正文里几乎必然假命中（与 detectChapterBridge 的过滤口径一致）。
  const list = [];
  const seen = new Set();
  for (const raw of rawCharacters) {
    const entry = normalizeSettingEntry(raw);
    if (!entry) continue;
    const name = String(entry.name ?? "").trim();
    if (name === "" || seen.has(name)) continue;
    if (name.length < 2) {
      degraded.push("人物「" + name + "」名字不足 2 字，已跳过出场统计（单字名在正文里假命中率过高）");
      continue;
    }
    const aliases = uniqueStrings(Array.isArray(entry.alias) ? entry.alias : []).filter((a) => a.length >= 2);
    const droppedAlias = uniqueStrings(Array.isArray(entry.alias) ? entry.alias : []).filter((a) => a.length < 2);
    if (droppedAlias.length > 0) degraded.push("人物「" + name + "」的别名 " + droppedAlias.join("、") + " 不足 2 字，已忽略");
    seen.add(name);
    list.push({ name, aliases, firstSeen: typeof entry.firstSeen === "string" ? entry.firstSeen : "" });
  }
  return list;
}

function characterPresent(text, character) {
  // v5.0.0：出场判定 = 正文出现人物名**或其别名**（settings.characters[].alias）
  if (!text) return false;
  if (text.includes(character.name)) return true;
  return character.aliases.some((alias) => text.includes(alias));
}

function computeAbsences(rows, characters, threshold) {
  // v5.0.0：连续缺席区间。两条口径必须同时成立：
  // ① 只统计"首次出场之后"的区间——出场前的章不是缺席（否则后出场的人物会被报成长缺席）；
  // ② 到书末仍未再出场时，区间的 to 用最后一章章号。
  // length = 该区间内连续缺席的**章数**（按章序计数；章号不连续时与 to−from 不等）。
  const out = [];
  for (const character of characters) {
    const present = rows.map((row) => row.present.includes(character.name));
    const first = present.indexOf(true);
    if (first === -1) continue; // 全书未出场：不算缺席（degraded 里单独提示）
    let run = 0;
    let runStart = -1;
    for (let i = first + 1; i < rows.length; i += 1) {
      if (!present[i]) {
        if (run === 0) runStart = i;
        run += 1;
        continue;
      }
      if (run >= threshold) out.push({ name: character.name, from: rows[runStart].number, to: rows[i - 1].number, length: run });
      run = 0;
    }
    if (run >= threshold) out.push({ name: character.name, from: rows[runStart].number, to: rows[rows.length - 1].number, length: run });
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name), "zh") || a.from - b.from);
  return out;
}

// ───────────────────────────── 剧情线层 ─────────────────────────────

function clusterPlots(plots) {
  // v5.0.0：把伏笔聚成"线"。三层启发式，按可靠性从高到低：
  // ① relatedCharacters / locations 有交集（用户显式登记，最可靠）；
  // ② 两条内容共享 ≥3 字的关键词片段（没有登记关联字段时的退路）；
  // ③ 某条的登记实体名出现在另一条的内容里（A 登记了"林昭"，B 的内容提到"林昭"）。
  // 用并查集保证传递闭包；聚不出来就每条独立成线。
  const n = plots.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    let cur = x;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]];
      cur = parent[cur];
    }
    return cur;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const ti = plots[i].tokens;
      const tj = plots[j].tokens;
      if (ti.length > 0 && tj.length > 0 && ti.some((t) => tj.includes(t))) {
        union(i, j);
        continue;
      }
      const ki = plots[i].contentKeywords;
      const kj = plots[j].contentKeywords;
      if (ki.length > 0 && kj.length > 0 && ki.some((k) => kj.includes(k))) {
        union(i, j);
        continue;
      }
      const contentI = String(plots[i].entry.content ?? "");
      const contentJ = String(plots[j].entry.content ?? "");
      if (ti.some((t) => contentJ.includes(t)) || tj.some((t) => contentI.includes(t))) {
        union(i, j);
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(i);
    groups.set(root, list);
  }
  return [...groups.values()];
}

function rankEntities(list) {
  // v5.0.0：实体/关键词排序——先长后短（长片段区分度高），同长按中文拼音序（结果稳定可复现）
  return list.slice().sort((a, b) => b.length - a.length || a.localeCompare(b, "zh"));
}

function threadLabel(indices, plots) {
  // v5.0.0：线的名字。优先"多条共享的人物/地点"（≥2 条出现的），其次本簇登记过的任意实体，
  // 再次多条共享的内容关键词，最后退化为首条伏笔内容前 16 字。
  const tokenCount = new Map();
  for (const i of indices) {
    for (const token of plots[i].tokens) tokenCount.set(token, (tokenCount.get(token) ?? 0) + 1);
  }
  const sharedTokens = [...tokenCount.entries()].filter(([, c]) => c >= 2).map(([t]) => t);
  if (sharedTokens.length > 0) return rankEntities(sharedTokens).slice(0, THREAD_LABEL_MAX).join("·");
  const allTokens = [...tokenCount.keys()];
  if (allTokens.length > 0) return rankEntities(allTokens).slice(0, THREAD_LABEL_MAX).join("·");
  const kwCount = new Map();
  for (const i of indices) {
    for (const k of plots[i].contentKeywords) kwCount.set(k, (kwCount.get(k) ?? 0) + 1);
  }
  const sharedKw = [...kwCount.entries()].filter(([, c]) => c >= 2).map(([k]) => k);
  if (sharedKw.length > 0) return rankEntities(sharedKw).slice(0, THREAD_LABEL_MAX).join("·");
  const first = String(plots[indices[0]]?.entry.content ?? "").trim();
  return first.length > 16 ? first.slice(0, 16) + "…" : first;
}

function buildThreadActivity(plots) {
  // v5.0.0：每条线的活跃章号（簇内成员提及章的并集）、跨度 length、最大空档 gap。
  // length/gap 与 plotLifecycle.distance 同口径——都是"章号之差"不是"章数"：
  // 只活跃 1 章的线 length=0、gap=0；活跃于 1/2/3/7 章的线 gap=4。
  const groups = clusterPlots(plots);
  const threads = groups.map((indices) => {
    const chapters = uniqueStrings(indices.flatMap((i) => plots[i].chapters).map(String))
      .map(Number)
      .sort((a, b) => a - b);
    let gap = 0;
    for (let i = 1; i < chapters.length; i += 1) gap = Math.max(gap, chapters[i] - chapters[i - 1]);
    return {
      thread: threadLabel(indices, plots),
      chapters,
      length: chapters.length > 0 ? chapters[chapters.length - 1] - chapters[0] : 0,
      gap
    };
  });
  // v5.0.0：有线号的按首次活跃章升序（无活跃线索的排最后），同序按线名——便于"先看最早的线"
  threads.sort((a, b) => {
    const av = a.chapters.length > 0 ? a.chapters[0] : Number.MAX_SAFE_INTEGER;
    const bv = b.chapters.length > 0 ? b.chapters[0] : Number.MAX_SAFE_INTEGER;
    return av - bv || a.thread.localeCompare(b.thread, "zh");
  });
  return threads;
}

// ───────────────────────────── 时间线层 ─────────────────────────────

function buildTimelineOrder(rawTimeline) {
  // v5.0.0：时间线来自 settings.timeline（登记顺序 = 数组顺序）。
  // number = chapter 字段解析出的章号（缺失/解析不出记 null）；issue 只在"章号小于此前已登记过的最大章号"时给出，
  // 也就是"登记顺序与章号升序不一致"（章号相同的并列不算不一致）。
  const rows = [];
  for (const raw of rawTimeline) {
    const entry = normalizeSettingEntry(raw);
    if (!entry) continue;
    const chapter = typeof entry.chapter === "string" ? entry.chapter : entry.chapter != null ? String(entry.chapter) : "";
    const day = String(entry.day ?? entry.name ?? "");
    const event = String(entry.event ?? entry.description ?? "");
    let number = null;
    if (chapter.trim() !== "") {
      const parsed = parseChapterNumber(chapter);
      if (typeof parsed === "number") number = parsed;
    }
    // v5.0.0：章号解析不出来的条目**省略 number 键**（而不是写 null）——宿主契约里
    // "未知值"必须省略字段，写 null 到了工具层会被 dropNullDeep 删键；
    // 两处口径必须一致，否则该键时而存在时而不存在（见 index.js timelineOrder 契约）。
    const row = { day, event, chapter, issue: "" };
    if (number !== null) row.number = number;
    rows.push(row);
  }
  let maxSoFar = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (typeof row.number !== "number") continue;
    if (row.number < maxSoFar) row.issue = "章号顺序与登记顺序不一致";
    else maxSoFar = row.number;
  }
  return rows;
}

// ───────────────────────────── 大纲对照层 ─────────────────────────────

function pushBigrams(run, out) {
  // v5.0.0：中文连续段的相邻二字片段（全虚词的片段没有区分度，丢掉）
  for (let i = 0; i + 2 <= run.length; i += 1) {
    const gram = run.slice(i, i + 2);
    if ([...gram].every((ch) => CJK_STOP_CHARS.has(ch))) continue;
    out.push(gram);
  }
}

function directionKeywords(direction) {
  // v5.0.0：方向行关键词。主路径复用 core.extractKeywords（与全书关键词口径一致）；
  // 但 extractKeywords 只保留"出现次数 > 1"的词，十几字的方向行几乎必然产出空集，
  // 因此产出不足 2 个时退化为"方向行的相邻二字片段"——与 novel_continuity_check 的大纲对照同口径
  // （那边同样用 direction 的 bigram 命中率判偏离，只是阈值写死 0.12）。
  const primary = uniqueStrings(extractKeywords(direction, DIRECTION_KEYWORD_MAX).map((k) => k.word));
  if (primary.length >= 2) return primary.slice(0, DIRECTION_KEYWORD_MAX);
  const grams = [];
  let run = "";
  for (const ch of direction) {
    if (/[\u4e00-\u9fff]/.test(ch)) {
      run += ch;
      continue;
    }
    pushBigrams(run, grams);
    run = "";
  }
  pushBigrams(run, grams);
  return uniqueStrings(primary.concat(grams)).slice(0, DIRECTION_KEYWORD_MAX);
}

async function buildPlanVsActual(root, book, texts, degraded, exec) {
  // v5.0.0：读创作资料大纲（creationDir + CREATION_FILES.outline），逐行解析方向行「- N 方向…」，
  // 与该章正文做关键词重合率。overlap = 命中的方向行关键词数 / 方向行关键词总数（3 位小数）。
  let outlineText;
  try {
    outlineText = await readTextFile(join(creationDir(root, book), CREATION_FILES.outline), exec);
  } catch (e) {
    if (isAbort(e)) throw e; // v5.0.0：取消必须上抛——否则调用方拿到"成功但全空"的结构视图
    degraded.push("无创作资料大纲（novels/创作资料/" + book + "/" + CREATION_FILES.outline + "）：计划对照为空——先 novel_outline init + chapter 补方向行");
    return { rows: [], unwritten: 0, noKeywords: 0 };
  }
  const lines = outlineText.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[-*]\s+\d{1,4}\s+\S/.test(l));
  if (lines.length === 0) {
    degraded.push("创作资料大纲里没有方向行（形如「- 12 本章方向…」）：计划对照为空——用 novel_outline chapter 补每章方向");
    return { rows: [], unwritten: 0, noKeywords: 0 };
  }
  const rows = [];
  let unwritten = 0;
  let noKeywords = 0;
  for (const line of lines) {
    const number = parseInt((line.match(/^[-*]\s+(\d{1,4})/) || [])[1], 10);
    const direction = line.replace(/^[-*]\s+\d{1,4}\s*/, "").trim();
    if (!Number.isInteger(number)) continue;
    const chapter = texts.find((t) => t.number === number);
    if (!chapter) {
      unwritten += 1; // 大纲按设计会预先列出尚未动笔的章节，无正文则无法算重合率
      continue;
    }
    const keywords = directionKeywords(direction);
    if (keywords.length === 0) {
      noKeywords += 1;
      rows.push({ number, direction, overlap: 0, keywords: [] });
      continue;
    }
    const hit = keywords.filter((k) => chapter.text.includes(k));
    rows.push({ number, direction, overlap: round3(hit.length / keywords.length), keywords: hit });
  }
  if (unwritten > 0) degraded.push("有 " + unwritten + " 条大纲方向行对应的章节还没有正文文件，未计算重合率（大纲通常会预先列出下一批章节）");
  if (noKeywords > 0) degraded.push("有 " + noKeywords + " 条大纲方向行提取不出关键词（过短或无中文），重合率按 0 记");
  return { rows, unwritten, noKeywords };
}

// ───────────────────────────── 概览文案 ─────────────────────────────

function buildSummary(d) {
  // v5.0.0：给人看的一句话概览 + 风险提示（degraded 只报"少了什么数据"，这里报"数据说了什么"）
  const parts = [];
  parts.push("《" + d.book + "》全书 " + d.totalChapters + " 章");
  parts.push("未回收伏笔 " + d.plotLifecycle.length + " 条（已回收 " + d.doneCount + " 条）");
  parts.push("人物 " + d.characterMatrix.characters.length + " 名，连续缺席区间 " + d.characterMatrix.absences.length + " 处");
  const maxGap = d.threadActivity.reduce((max, t) => Math.max(max, t.gap), 0);
  parts.push("剧情线 " + d.threadActivity.length + " 条，最大空档 " + maxGap + " 章");
  const issues = d.timelineOrder.filter((t) => t.issue !== "").length;
  parts.push("时间线 " + d.timelineOrder.length + " 条" + (issues > 0 ? "（" + issues + " 条章号顺序与登记顺序不一致）" : ""));
  if (d.planVsActual.length > 0) {
    const avg = d.planVsActual.reduce((s, r) => s + r.overlap, 0) / d.planVsActual.length;
    const low = d.planVsActual.filter((r) => r.overlap < 0.2).length;
    parts.push("大纲方向 " + d.planVsActual.length + " 条，平均重合率 " + Math.round(avg * 100) + "%" + (low > 0 ? "（" + low + " 章低于 20%，可能偏离方向）" : ""));
  } else {
    parts.push("大纲方向未计算");
  }
  if (d.degraded.length > 0) parts.push("降级 " + d.degraded.length + " 项（见 degraded）");

  const risks = [];
  const gapThread = d.threadActivity.filter((t) => t.gap > 0).sort((a, b) => b.gap - a.gap)[0];
  if (gapThread) risks.push("空档最大的是「" + gapThread.thread + "」（活跃于第 " + gapThread.chapters.join("、") + " 章，空档 " + gapThread.gap + " 章）");
  const absence = d.characterMatrix.absences.slice().sort((a, b) => b.length - a.length)[0];
  if (absence) risks.push("「" + absence.name + "」连续缺席 第 " + absence.from + "–" + absence.to + " 章（" + absence.length + " 章未出场）");
  const oldest = d.plotLifecycle.filter((p) => typeof p.distance === "number").sort((a, b) => b.distance - a.distance)[0];
  if (oldest) risks.push("埋得最久的是 #" + oldest.id + "（第 " + oldest.firstChapter + " 章埋下，已过 " + oldest.distance + " 章仍未回收）");

  let text = parts.join("；") + "。";
  if (risks.length > 0) text += "【风险】" + risks.join("；") + "。";
  if (d.totalChapters === 0) text += "（作品目录下没有章节文件，跨章字段无数据可算）";
  return text;
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function assembleGraph(ctx) {
  const { root, book, dir, opts, exec, degraded } = ctx;

  // ① 章节：扫描 + 逐章读正文。后面四块全部建立在它之上。
  const scanned = await scanChapters(dir);
  const { list: chapters, unresolved } = assignChapterNumbers(scanned);
  if (chapters.length === 0) degraded.push("作品目录下没有章节文件（" + dir + "）：跨章字段（人物矩阵/线活跃度/计划对照）只能为空");
  if (unresolved.length > 0) {
    degraded.push("有 " + unresolved.length + " 个章节文件名解析不出章号（" + unresolved.slice(0, 3).join("、") + (unresolved.length > 3 ? "…" : "") + "）：按扫描顺序占位编号，可能与真实章号冲突");
  }
  const texts = await loadChapterTexts(dir, chapters, exec, degraded);
  const totalChapters = chapters.length;
  const maxChapter = texts.reduce((max, t) => Math.max(max, t.number), 0);

  // ② 设定表：人物（含别名）+ 时间线。读不到不算错，只降级。
  let settings = { characters: [], locations: [], items: [], timeline: [], worldview: [] };
  let settingsReadable = true;
  try {
    settings = await readSettings(root, book);
  } catch (e) {
    settingsReadable = false;
    degraded.push("设定表读取失败（.novel-writer/settings/" + book + ".json）：人物矩阵与时间线为空——" + describeError(e));
  }
  const rawCharacters = Array.isArray(settings.characters) ? settings.characters : [];
  const rawTimeline = Array.isArray(settings.timeline) ? settings.timeline : [];
  if (settingsReadable && rawCharacters.length === 0) degraded.push("设定表未登记人物（novel_settings character）：人物出场矩阵与连续缺席区间为空");
  if (settingsReadable && rawTimeline.length === 0) degraded.push("设定表未登记时间线（novel_settings timeline）：时间线顺序为空");

  // ③ 摘要：本视图只读正文，这里只做"有没有"的提示（不拿模型生成的摘要当正文证据）
  try {
    const summaries = await readSummaries(root, book);
    if (!Array.isArray(summaries) || summaries.length === 0) {
      degraded.push("无章节摘要（novel_summary）：不影响其余字段，但无法用摘要交叉印证剧情进度");
    }
  } catch (e) {
    degraded.push("章节摘要读取失败：" + describeError(e));
  }

  // ④ 伏笔表：只读解析（不迁移落盘）。
  const plotData = await readPlotsReadOnly(root, book);
  if (plotData.broken) degraded.push("伏笔表 JSON 解析失败（" + plotsFile(root, book) + "）：按空表处理，请检查文件是否被手改坏");
  else if (!plotData.found) degraded.push("未登记伏笔（" + plotsFile(root, book) + " 不存在）：伏笔生命周期与剧情线活跃度为空");
  else if (plotData.entries.length === 0) degraded.push("伏笔表为空（0 条记录）：伏笔生命周期与剧情线活跃度为空");
  const plotEntries = plotData.entries.map(normalizePlotEntry).filter(Boolean);
  const openEntries = plotEntries.filter((e) => e.status === "open");
  const doneCount = plotEntries.filter((e) => e.status === "done").length;

  // ⑤ 伏笔生命周期（只含 open；done 只进 summary 的条数）
  const plots = buildPlotLifecycle(openEntries, texts, maxChapter, degraded);
  const plotLifecycle = plots.map((p) => {
    const out = {
      id: String(p.entry.id),
      content: String(p.entry.content),
      priority: String(p.entry.priority ?? ""),
      type: String(p.entry.type ?? ""),
      status: "open"
    };
    // v5.0.0 修正（P3）：章号未知时**整键省略**，而不是置 null。
    // 理由：本函数在 index.js 的 output.schema 里把这两个字段声明为 type:"number"（宿主 schema 不支持
    // type 数组，无法写 ["number","null"]），值类型校验对 null 判定为不匹配；此前只有调用方的
    // dropNullDeep 兜住，任何**直接调用本函数**的路径（例如以后新增的 web 路由）会产出违反自身契约的值。
    // 未知就在这里省掉，dropNullDeep 退化为纯保险。
    if (typeof p.firstChapter === "number") out.firstChapter = p.firstChapter;
    if (typeof p.distance === "number") out.distance = p.distance;
    // 注意：这里刻意**不加** firstChapterKnown 之类的补充键——plotLifecycle 的 item 在 index.js 里是
    // additionalProperties:false，多一个未声明键就会让整次调用不合契约。不可知这件事由 degraded 说明。
    return out;
  });

  // ⑥ 人物矩阵
  const absenceThreshold = Number.isInteger(opts?.absenceThreshold) && opts.absenceThreshold > 0
    ? opts.absenceThreshold
    : DEFAULT_ABSENCE_THRESHOLD;
  const characters = collectCharacters(rawCharacters, degraded);
  const rows = texts.map((t) => ({
    chapter: t.file, // v5.0.0：chapter 用文件名（全书唯一标识，与伏笔 mentionedIn 的口径一致），number 是章号
    number: t.number,
    present: characters.filter((c) => characterPresent(t.text, c)).map((c) => c.name)
  }));
  const absences = computeAbsences(rows, characters, absenceThreshold);
  for (const c of characters) {
    const presentRows = rows.filter((r) => r.present.includes(c.name));
    if (presentRows.length === 0) {
      degraded.push("人物「" + c.name + "」全书未出场（登记了但正文里找不到名字或别名）");
      continue;
    }
    // v5.0.0：顺手用 firstSeen 做一次交叉核对——登记的首现章与正文实际首现章不一致时给出提示，
    // 避免"设定表说第 5 章登场、正文到第 8 章才出现"这类人丢了的问题被埋掉。以"注："开头，与缺数据的降级原因区分。
    if (c.firstSeen !== "") {
      const declared = parseChapterNumber(c.firstSeen);
      if (typeof declared === "number" && declared !== presentRows[0].number) {
        degraded.push("注：人物「" + c.name + "」登记的首现章（" + c.firstSeen + "）与正文实际首现（第 " + presentRows[0].number + " 章）不一致，建议核对 firstSeen 或补写初登场");
      }
    }
  }
  const characterMatrix = { characters: characters.map((c) => c.name), rows, absences };

  // ⑦ 剧情线活跃度（基于 open 伏笔；已回收的不参与聚类，条数只进 summary）
  const threads = buildThreadActivity(plots);
  const threadActivity = threads.map((t) => ({ thread: t.thread, chapters: t.chapters, length: t.length, gap: t.gap }));

  // ⑧ 时间线顺序
  const timelineOrder = buildTimelineOrder(rawTimeline);

  // ⑨ 大纲方向 vs 正文
  const plan = await buildPlanVsActual(root, book, texts, degraded, exec);

  const result = {
    book,
    totalChapters,
    plotLifecycle,
    characterMatrix,
    threadActivity,
    timelineOrder,
    planVsActual: plan.rows,
    summary: "",
    degraded
  };
  result.summary = buildSummary({ ...result, doneCount });
  return result;
}

/**
 * 结构视图主入口（只读）。
 *
 * @param {string} root 章节库根目录（含 novels/ 与 .novel-writer/）
 * @param {string} book 书名（novels/ 下的子目录名）
 * @param {{ absenceThreshold?: number }} [opts] 可选：连续缺席阈值（默认 5 章）
 * @param {{ signal?: AbortSignal }} [exec] 宿主执行上下文（只用于转发取消信号）
 * @returns {Promise<object>} 见文件头字段说明；除"book 目录不存在"外不抛错
 */
export async function buildStoryGraph(root, book, opts, exec) {
  const safeBook = assertBook(book);
  const dir = bookDir(root, safeBook);
  if (!existsSync(dir)) {
    // v5.0.0：唯一允许抛错的路径——目录都不存在时后面的每张表都会"合法地空"，报"空视图"是误导
    throw new Error("书库中未找到作品目录：" + dir + "（检查书名是否精确匹配——可用 novel_books 查看全部作品名；或确认 novels/ 下已创建该书目录）");
  }
  const degraded = [];
  try {
    return await assembleGraph({ root, book: safeBook, dir, opts, exec, degraded });
  } catch (e) {
    // v5.0.0：取消优先于降级——本函数"永不抛错"只针对数据/IO 事故，不含调用方主动中止。
    if (isAbort(e)) throw e;
    // v5.0.0：兜底降级。章节已确认存在的情况下仍抛错只可能是异常数据/IO 事故，
    // 这里返回空结构 + 中文原因，保证调用方（novel_plot graph）永远拿得到同一套字段。
    degraded.push("结构视图计算中断（" + describeError(e) + "）：以下空字段不代表书中确实没有内容，请检查该书目录与 .novel-writer 数据");
    return emptyGraph(safeBook, degraded, "《" + safeBook + "》结构视图计算失败：" + describeError(e));
  }
}
