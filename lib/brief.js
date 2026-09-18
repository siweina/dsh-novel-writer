/**
 * dsh-novel-writer — 开写包（v5.0.0 写作能力层）
 *
 * 一次调用装配"写这一章需要的全部材料"：上一章结尾原文与钩子、本章大纲方向行、相关人物卡、
 * 未回收伏笔（含"埋了多久"）、世界观用语规范、六维基线、原著锚段与句式骨架、上一章风格结论、
 * 本章禁用清单与写作计划——替代模型分别调用 novel_chapters / novel_read / novel_outline /
 * novel_plot / novel_settings / novel_style_check 的 6~8 次往返。
 *
 * v5.0.0 设计约束：
 * - 纯本地、零新增依赖、零网络：除 metricChaptersCached 自带的逐章指标缓存外不写任何文件
 *   （为此刻意不复用 core.readPlots 的 v0.8.0 位置迁移写入，见 readPlotsReadOnly）。
 * - 除"作品目录不存在"外绝不抛错：任何材料缺失都降级为空值并在 degraded 说明原因。
 * - 取消信号（exec.signal）触发的 AbortError 一律向上传播，不当作降级吞掉。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bookDir,
  buildStyleAnchorPackage,
  buildTolerance,
  creationDir,
  CREATION_FILES,
  findChapter,
  isAbort,
  legacyPlotsFile,
  metricChaptersCached,
  MIN_BASELINE_CHAPTERS,
  normalizePlotEntry,
  normalizeSettingList,
  parseChapterNumber,
  plotKeywords,
  plotsFile,
  readTextFile,
  readSettings,
  sanitizeSegment,
  scanChapters
} from "./core.js";
import { computeBaselineFromPerChapter, judgeAgainstBaseline } from "./style-metrics.js";

// v5.0.0：两档预算——compact 给"够用"，full 给"备齐"（characters: 0 语义为"不截断"）。
// 注意 skeletons 的上限受 buildStyleAnchorPackage 自身产出（最多 4 条）限制，full 的 8 只是"不额外截断"。
const BRIEF_BUDGETS = {
  compact: { anchorChars: 300, anchors: 2, skeletons: 3, characters: 5 },
  full: { anchorChars: 600, anchors: 5, skeletons: 8, characters: 0 }
};

// v5.0.0：引擎侧 priority 归一——脏数据/未登记一律 medium（与 plotKeywords 同层兜底）
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
// v5.0.0：人物"已退场"判据（限定词表，宁可漏报不可误报——误报会让模型把活人写死）
const OFFSTAGE_RE = /退场|已死|死亡|身亡|殉|不再出场|下线|殁/;
// v5.0.0：创作资料里【用户…设定】段的行首标签不是人名，避免被当成人物卡登记
const NON_CHARACTER_LABELS = new Set(["角色设定", "世界观", "不允许的事件", "主线目的", "题材偏好", "额外要求", "用户原创设定", "用户角色设定"]);

function clip(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function errText(e) {
  return String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 120);
}

// v5.0.0：取消信号判定统一走 core.isAbort（取消不是"材料取不到"，必须继续向上抛）

/**
 * v5.0.0：只读版伏笔读取。
 * 与 core.readPlots 同口径（新位置 → 旧位置回退 → normalizePlotEntry），唯一差别是**不做** v0.8.0 的
 * "旧位置迁移到新位置"写入——开写包承诺只读，只有 metricChaptersCached 的缓存写是允许的。
 */
async function readPlotsReadOnly(root, book) {
  for (const file of [plotsFile(root, book), legacyPlotsFile(root, book)]) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (Array.isArray(parsed?.entries)) return parsed.entries.map(normalizePlotEntry).filter(Boolean);
    } catch { /* 不存在/损坏 → 试下一个位置 */ }
  }
  return [];
}

/** v5.0.0：读创作资料中的某个文件；未初始化/读不到返回 null（不抛错）。 */
async function readCreationFile(root, book, key, exec) {
  try {
    return await readTextFile(join(creationDir(root, book), CREATION_FILES[key]), exec);
  } catch (e) {
    if (isAbort(e)) throw e;
    return null;
  }
}

/**
 * v5.0.0：解析创作资料的"编号行"——剧情大纲的方向行与钩子记录都是 `- <章号> <文本>` 形态
 * （见 core.createOutlineTool 的 chapter/hook 两个 action）。比 core 的 /^[-*] (\d+)/ 略宽容：
 * 额外容忍 `- 第3章 …` / `- 3、…` 这类手写变体，但要求章号后有分隔符+正文，避免误吞普通列表行。
 * 同章号只取第一条（与 core 的"行首锚定 + 不重复追加"口径一致）。
 */
function parseNumberedLines(text) {
  const map = new Map();
  if (typeof text !== "string" || text === "") return map;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*第?(\d+)[章回话]?[.、:：\s]+(.*)$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || map.has(n)) continue;
    map.set(n, m[2].trim());
  }
  return map;
}

/**
 * v5.0.0：目标章文件尚不存在时按"本书现有命名格式"推导文件名（只推导，不落盘）。
 * 优先沿用最后一章那种"纯章号文件名"（第NN章.md / 01.md）的形态与数字宽度；形态带标题等不规则时，
 * 回退 novel_new_chapter 的默认命名 `第NN章.md`。
 */
function deriveChapterFileName(chapters, number) {
  const plain = /^(第?)(\d+)(章|回|话)?(\.(?:md|markdown|txt))$/i;
  for (let i = chapters.length - 1; i >= 0; i -= 1) {
    const m = plain.exec(chapters[i].file);
    if (!m) continue;
    return m[1] + String(number).padStart(m[2].length, "0") + (m[3] ?? "") + m[4];
  }
  return "第" + String(number).padStart(2, "0") + "章.md";
}

/** v5.0.0：伏笔"最早提及章号"——chapter / mentionedIn / lastMentioned 三处取最小值；都没有则 null。 */
function plotFirstChapter(entry) {
  const nums = [];
  const direct = parseChapterNumber(String(entry.chapter ?? ""));
  if (typeof direct === "number") nums.push(direct);
  for (const item of Array.isArray(entry.mentionedIn) ? entry.mentionedIn : []) {
    const n = parseChapterNumber(String(item));
    if (typeof n === "number") nums.push(n);
  }
  const last = parseChapterNumber(String(entry.lastMentioned ?? ""));
  if (typeof last === "number") nums.push(last);
  return nums.length > 0 ? Math.min(...nums) : null;
}

/** v5.0.0：统计若干"针"在正文中的出现次数（人名相关性用；单字针不可靠，调用方保证长度 ≥ 2）。 */
function countMentions(text, needles) {
  let n = 0;
  for (const needle of needles) {
    if (typeof needle !== "string" || needle.length < 2) continue;
    let idx = text.indexOf(needle);
    while (idx !== -1) {
      n += 1;
      idx = text.indexOf(needle, idx + needle.length);
    }
  }
  return n;
}

/**
 * v5.0.0：plotKeywords 的"不截断"版本——刻意与 core.plotKeywords 逐字同规则（4/3/2 字、非停用字占比 ≥60%），
 * 唯一差别是**不做** slice(0, 8)。原因：plotKeywords 只返回最长的 8 个词，内容稍长的伏笔其 2/3 字关键词
 * 会被整批截掉，"已回收伏笔 ∩ 本章方向行"于是漏检（实测："青石板下的铜钥匙能打开地窖" 的 8 个槽位全被
 * 四字词占满，与方向行仅共享"地窖/钥匙"两字词时完全匹配不到）。
 */
function plotKeywordsAll(content) {
  const text = String(content).replace(/[^\u4e00-\u9fff]/g, "");
  // v5.0.0：去掉字串里重复的 "一"（进 Set 后本就无影响，属笔误）
  const stop = new Set("的了是在我有和就都不一个这那与及或但是因为所以如果然后而且比如什么怎么自己她们他们你们我们咱们没有不是别莫未".split(""));
  const keywords = [];
  for (const length of [4, 3, 2]) {
    for (let i = 0; i + length <= text.length; i += 1) {
      const sub = text.slice(i, i + length);
      const nonStop = [...sub].filter((ch) => !stop.has(ch)).length;
      if (nonStop >= Math.ceil(length * 0.6)) keywords.push(sub);
    }
  }
  return [...new Set(keywords)];
}

/** v5.0.0：解析创作资料人物设定的 `- 名字：简介` 行（模板段标题以（开头，天然不匹配）。
 *  v5.0.0 修正：**没有冒号也要认**。`novel_outline action=character` 在只给名字不给简介时写出的正是
 *  `- 名字`（见 core.js 的 line = "- " + name + (description ? "：" + description : "")），
 *  旧正则强制要求冒号，等于把插件自己写出来的人物卡静默丢掉（开写包人物卡少一张，无从察觉）。
 *  误报风险由下游兜住：没有任何出场/大纲命中的"人物"不会进 characters（见下方 mentions/inOutline 过滤）。 */
function parseCharacterLines(text) {
  const out = [];
  if (typeof text !== "string" || text === "") return out;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*([^：:\n]{1,24})(?:[：:]\s*(.*))?$/);
    if (!m) continue;
    const name = m[1].trim();
    if (name === "" || NON_CHARACTER_LABELS.has(name)) continue;
    out.push({ name, description: (m[2] ?? "").trim() });
  }
  return out;
}

/**
 * v5.0.0：合并设定表 worldview 条目为开写包要的 `{ basis, bannedWords, recommended, speechStyle }`。
 * worldview 条目本身还有 ritual（仪式规范），但返回结构只约定这四个键，故把 ritual 并进 basis 文本
 * （读起来就是"文化基准 + 仪式规范"的一段话），不丢信息也不擅自加键。
 */
function mergeWorldview(entries) {
  const basisParts = [];
  const bannedWords = [];
  const recommended = {};
  const speechStyle = {};
  for (const e of entries) {
    for (const s of [e.basis, e.description, e.ritual, e.notes]) {
      if (typeof s === "string" && s.trim() !== "") basisParts.push(s.trim());
    }
    for (const w of Array.isArray(e.bannedWords) ? e.bannedWords : []) {
      if (!bannedWords.includes(w)) bannedWords.push(w);
    }
    if (e.recommended && typeof e.recommended === "object") Object.assign(recommended, e.recommended);
    const sp = e.speechStyle;
    if (!sp || typeof sp !== "object") continue;
    for (const [key, value] of Object.entries(sp)) {
      if (Array.isArray(value)) {
        const cur = Array.isArray(speechStyle[key]) ? speechStyle[key] : [];
        for (const x of value.map(String)) if (!cur.includes(x)) cur.push(x);
        speechStyle[key] = cur;
      } else if (value && typeof value === "object") {
        speechStyle[key] = { ...(speechStyle[key] && typeof speechStyle[key] === "object" ? speechStyle[key] : {}), ...value };
      } else if (value !== void 0 && value !== null && String(value) !== "") {
        speechStyle[key] = String(value);
      }
    }
  }
  const basis = [...new Set(basisParts)].join("；");
  if (basis === "" && bannedWords.length === 0 && Object.keys(recommended).length === 0 && Object.keys(speechStyle).length === 0) return null;
  return { basis, bannedWords, recommended, speechStyle };
}

/**
 * 装配"开写包"。
 *
 * @param {string} root 书库根目录
 * @param {string} book 书名（已 sanitize，直接当目录名用）
 * @param {string} chapterArg 目标章标识；"next"/"" 表示下一章（= 当前最大章号 + 1，文件可能尚不存在）
 * @param {{budget?: "compact"|"full", featState?: object}} [opts] budget 默认 compact；
 *        featState 传入时用其 styleTolerance 覆盖上一章六维判定容差（与 novel_style_check 同口径）
 * @param {object} [exec] DSH 执行上下文（透传 exec.signal；函数内不依赖其它字段）
 * @returns {Promise<object>} 开写包（字段见文件头说明）
 */
export async function buildChapterBrief(root, book, chapterArg, opts, exec) {
  const budget = BRIEF_BUDGETS[opts?.budget === "full" ? "full" : "compact"];
  const baseRoot = typeof root === "string" && root.trim() !== "" ? root : ".";
  const safeBook = sanitizeSegment(book, "book");
  const degraded = [];

  // v5.0.0：唯一的合法抛错——作品目录不存在（scanChapters 自带可读中文报错，此处不吞）
  const dir = bookDir(baseRoot, safeBook);
  const chapters = await scanChapters(dir);
  const numbered = chapters.filter((c) => typeof c.number === "number");
  const maxNumber = numbered.reduce((max, c) => Math.max(max, c.number), 0);

  const targetArg = String(chapterArg ?? "").trim();
  const wantNext = /^(next|下一章)$/i.test(targetArg);
  if (!wantNext && targetArg === "") degraded.push("未指定 chapter 参数，本次按下一章（第 " + (maxNumber + 1) + " 章）装配");

  // v5.0.0：创作资料的大纲方向行 / 钩子记录（用于目标章方向、标题与上一章钩子）
  const outlineText = await readCreationFile(baseRoot, safeBook, "outline", exec);
  const hooksText = await readCreationFile(baseRoot, safeBook, "hooks", exec);
  const outlineMap = parseNumberedLines(outlineText);
  const hooksMap = parseNumberedLines(hooksText);

  // ---------- ① 目标章解析 ----------
  let targetChapter = null;
  let targetNumber = null;
  let ambiguousTarget = false;
  if (wantNext || targetArg === "") {
    targetNumber = maxNumber + 1;
    targetChapter = numbered.find((c) => c.number === targetNumber) ?? null;
    if (targetChapter === null) degraded.push("下一章（第 " + targetNumber + " 章）尚未创建，文件名按本书现有命名格式推导");
  } else {
    try {
      targetChapter = findChapter(chapters, targetArg) ?? null;
    } catch (e) {
      // v5.0.0：findChapter 对"同章号多文件"会抛错拒绝猜测——开写包不改判，降级为"目标不确定"
      ambiguousTarget = true;
      degraded.push("目标章无法确定：" + errText(e));
    }
    if (targetChapter) {
      targetNumber = targetChapter.number ?? parseChapterNumber(targetChapter.file) ?? null;
    } else if (!ambiguousTarget) {
      const asNumber = parseChapterNumber(targetArg);
      if (typeof asNumber === "number") {
        targetNumber = asNumber;
        degraded.push("第 " + asNumber + " 章文件尚不存在，本次按“将写此章”装配（文件名按本书现有命名格式推导）");
      } else {
        degraded.push("在作品 " + safeBook + " 中找不到章节「" + clip(targetArg, 20) + "」");
      }
    }
  }
  const isNext = targetChapter === null && targetNumber !== null;
  const chapter = targetChapter
    ? {
        file: targetChapter.file,
        number: targetChapter.number ?? targetNumber,
        // v5.0.0：文件名没带标题时回落到大纲方向行（与"下一章"的标题来源保持一致）
        title: targetChapter.title !== "" ? targetChapter.title : clip(outlineMap.get(targetNumber) ?? "", 60)
      }
    : targetNumber !== null
      ? { file: deriveChapterFileName(chapters, targetNumber), number: targetNumber, title: clip(outlineMap.get(targetNumber) ?? "", 60) }
      : null;

  // ---------- ② 上一章（anchor 的来源） ----------
  let prevChapter = null;
  if (targetNumber !== null) {
    prevChapter = numbered.filter((c) => c.number < targetNumber).sort((a, b) => b.number - a.number)[0] ?? null;
  } else {
    prevChapter = numbered.slice().sort((a, b) => b.number - a.number)[0] ?? null;
    if (prevChapter) degraded.push("目标章号不确定，上一章按全书最后一章（第 " + prevChapter.number + " 章）取");
  }
  if (prevChapter === null) degraded.push("没有上一章（全书暂无更早章节）：anchor 与上一章钩子为空");

  // ---------- ③ 逐章文本（锚包与六维测量的共同输入，只读一遍） ----------
  const texts = [];
  const textByFile = new Map();
  for (const c of chapters) {
    let text = "";
    try {
      text = await readTextFile(join(dir, c.file), exec);
    } catch (e) {
      if (isAbort(e)) throw e;
      degraded.push("读取章节失败：" + c.file + "（" + errText(e) + "）");
    }
    texts.push({ file: c.file, text });
    textByFile.set(c.file, text);
  }
  const prevText = prevChapter ? textByFile.get(prevChapter.file) ?? "" : "";
  const anchor = prevText === "" ? "" : prevText.slice(-budget.anchorChars).trim();

  // ---------- ④ 上一章钩子 ----------
  let previousHook = "";
  if (prevChapter && typeof prevChapter.number === "number") {
    const line = hooksMap.get(prevChapter.number);
    if (line !== void 0) previousHook = line;
    else if (hooksText === null) degraded.push("无钩子记录（创作资料未初始化）：上一章钩子为空");
    else degraded.push("钩子记录里没有第 " + prevChapter.number + " 章的钩子（上一章钩子未回填）");
  }

  // ---------- ⑤ 本章大纲方向行 ----------
  let outlineDirection = "";
  if (targetNumber !== null) {
    const direction = outlineMap.get(targetNumber);
    if (direction !== void 0) outlineDirection = direction;
    else if (outlineText === null) degraded.push("创作资料未初始化（无剧情大纲文件）：本章大纲方向为空");
    else degraded.push("剧情大纲里没有第 " + targetNumber + " 章的方向行（可 novel_outline action=chapter 补写）");
  } else {
    degraded.push("目标章号不确定，无法定位本章大纲方向行");
  }

  // ---------- ⑥ 原著锚段 / 句式骨架（复用 buildStyleAnchorPackage，不自己抽段） ----------
  // v5.0.0 修正：锚段/骨架必须取自**其它章**（与 novel_fix_plan 的锚段口径一致）。
  // 目标是已存在的章（改稿场景）时把本章自身排除——否则"照着原著范本改"可能照着正在改的这一段，
  // 把待修的病句当成标杆。chapter="next" 时目标章不存在，等价于不排除。
  const anchorChapters = targetChapter ? chapters.filter((c) => c.file !== targetChapter.file) : chapters;
  const anchorTexts = targetChapter ? texts.filter((t) => t.file !== targetChapter.file) : texts;
  let anchors = [];
  let skeletons = [];
  try {
    const pkg = await buildStyleAnchorPackage(baseRoot, safeBook, anchorChapters, exec, anchorTexts);
    anchors = (pkg.anchors ?? []).slice(0, budget.anchors);
    skeletons = (pkg.skeletons ?? []).slice(0, budget.skeletons);
  } catch (e) {
    if (isAbort(e)) throw e;
    degraded.push("原著锚段/句式骨架不可用：" + errText(e));
  }
  if (anchorChapters.length > 0 && anchors.length === 0 && skeletons.length === 0) {
    degraded.push("原著锚段与句式骨架为空（抽样要求段落 ≥ 40 字，本书正文不满足）");
  }

  // ---------- ⑦ 六维基线（复用 metricChaptersCached 的逐章缓存，不重读全文） ----------
  let perChapter = [];
  if (texts.length > 0) {
    try {
      perChapter = await metricChaptersCached(baseRoot, safeBook, texts);
    } catch (e) {
      if (isAbort(e)) throw e;
      degraded.push("六维逐章测量失败：" + errText(e));
    }
  }
  // v5.0.0：目标章已存在时把它排除出基线语料（与 novel_style_check 同口径）；"下一章"尚未存在，
  // 全部现有章都是它的参照系。
  const baselineCorpus = targetChapter ? perChapter.filter((pc) => pc.file !== targetChapter.file) : perChapter.slice();
  let baseline = null;
  if (baselineCorpus.length > 0) baseline = computeBaselineFromPerChapter(baselineCorpus);
  else if (perChapter.length === 0) degraded.push("六维基线不可用：全书没有正文达 40 字以上的章节（书太短或章节为空）");
  else degraded.push("六维基线不可用：除目标章外没有可测章节（书只有 1 章）");

  // ---------- ⑧ 上一章风格结论（由缓存的逐章指标现算；插件未把 style_check 结论落盘） ----------
  let lastVerdict = "";
  if (prevChapter) {
    const prevMetrics = perChapter.find((pc) => pc.file === prevChapter.file);
    const others = perChapter.filter((pc) => pc.file !== prevChapter.file);
    if (!prevMetrics || !prevMetrics.metrics) {
      degraded.push("上一章风格结论不可得：上一章无六维指标（正文不足 40 字）");
    } else if (others.length === 0) {
      degraded.push("上一章风格结论不可得：除上一章外没有其它可测章节，无法对照");
    } else if (others.length < MIN_BASELINE_CHAPTERS) {
      // v5.0.0 修正：与 novel_fix_plan 同门槛。只有 1 章基线时 σ 不可估计（会被钳到 0.15μ），
      // 结论必然"凭空出带"——宁可不给结论，也不给一个改稿台不会认的结论。
      degraded.push("上一章风格结论不可得：除上一章外只有 " + others.length + " 章可测（至少需要 " + MIN_BASELINE_CHAPTERS + " 章才能估计作者自身波动）");
    } else {
      const base = computeBaselineFromPerChapter(others);
      // v5.0.0 修正：容差改用 core.buildTolerance（与 novel_fix_plan 同一实现、同一个小样本下限），
      // 否则同一章会出现"改稿台说超带、开写包说正常"的矛盾结论。
      // opts.featState 的用户自定义风格容差（state.styleTolerance）只覆盖对应维度。
      const tolerance = buildTolerance(base, others.length, null, opts?.featState?.styleTolerance);
      const judge = judgeAgainstBaseline(prevMetrics.metrics, base, tolerance);
      lastVerdict = "第 " + (prevChapter.number ?? "?") + " 章六维对照：" + judge.summary + "（由逐章指标缓存现算）";
    }
  }

  // ---------- ⑨ 伏笔：未回收（带 distance）+ 已回收（并入 avoid） ----------
  const plotEntries = await readPlotsReadOnly(baseRoot, safeBook);
  const openEntries = plotEntries.filter((p) => p.status !== "done");
  const doneEntries = plotEntries.filter((p) => p.status === "done");
  if (plotEntries.length === 0) {
    degraded.push("无伏笔记录（.novel-writer/plots/" + safeBook + ".json 不存在、损坏或为空）：未回收伏笔清单为空");
  }
  const unknownChapterPlots = [];
  const openPlots = openEntries.map((p) => {
    const first = plotFirstChapter(p);
    if (first === null) unknownChapterPlots.push(p.id);
    const priority = Object.prototype.hasOwnProperty.call(PRIORITY_RANK, String(p.priority)) ? String(p.priority) : "medium";
    const item = {
      id: p.id,
      content: p.content,
      priority,
      type: p.type ?? "",
      firstChapter: first,
      // v5.0.0：distance = 当前最大章号 − 最早提及章号（"埋了多久没回收"）；章号缺失时按全书起算
      distance: first === null ? maxNumber : Math.max(maxNumber - first, 0)
    };
    if (first === null) item.firstChapterKnown = false;
    if (p.note !== void 0) item.note = p.note;
    if (p.payoffCondition !== void 0) item.payoffCondition = p.payoffCondition;
    if (Array.isArray(p.relatedCharacters) && p.relatedCharacters.length > 0) item.relatedCharacters = p.relatedCharacters;
    if (Array.isArray(p.locations) && p.locations.length > 0) item.locations = p.locations;
    return item;
  });
  if (unknownChapterPlots.length > 0) {
    degraded.push("有 " + unknownChapterPlots.length + " 条未回收伏笔未记录章号（#" + unknownChapterPlots.slice(0, 5).join("、#") + "）：firstChapter 省略（不写 null，避免违反宿主契约）、distance 按全书章数（" + maxNumber + "）计");
  }
  openPlots.sort((a, b) => {
    const ra = PRIORITY_RANK[a.priority] ?? 1;
    const rb = PRIORITY_RANK[b.priority] ?? 1;
    if (ra !== rb) return ra - rb;
    if (b.distance !== a.distance) return b.distance - a.distance;
    return String(a.id).localeCompare(String(b.id));
  });

  // ---------- ⑩ 设定表：worldview + 人物卡 ----------
  const settings = await readSettings(baseRoot, safeBook);
  const worldviewList = normalizeSettingList(settings.worldview);
  const settingCharacters = normalizeSettingList(settings.characters).filter((c) => c.name.length >= 2);
  const hasAnySetting = settings.characters.length + settings.locations.length + settings.items.length + settings.timeline.length + settings.worldview.length > 0;
  if (!hasAnySetting) degraded.push("设定表为空（.novel-writer/settings/" + safeBook + ".json 不存在或未登记条目）");
  const worldview = mergeWorldview(worldviewList);
  if (worldview === null) {
    degraded.push(worldviewList.length === 0
      ? "设定表无 worldview 条目：不提供世界观用语规范与禁词"
      : "worldview 条目缺少 basis/禁词/语用规范内容：判定为无可用规范");
  }

  // v5.0.0：人物卡三源合并——设定表 character 表 + 创作资料 主要/次要人物设定.md
  const cardMap = new Map();
  const cardOf = (name) => {
    if (!cardMap.has(name)) {
      cardMap.set(name, { name, role: "设定表", description: "", traits: "", relationships: "", alias: [] });
    }
    return cardMap.get(name);
  };
  for (const c of settingCharacters) {
    const card = cardOf(c.name);
    if (c.description) card.description = c.description;
    if (c.traits) card.traits = c.traits;
    if (c.relationships) card.relationships = c.relationships;
    for (const a of c.alias ?? []) if (a.length >= 2) card.alias.push(a);
    if (OFFSTAGE_RE.test([c.status, c.notes, c.description, c.traits].filter(Boolean).join(" "))) card.offstage = true;
  }
  for (const [key, role] of [["characters-main", "主要"], ["characters-minor", "次要"]]) {
    const text = await readCreationFile(baseRoot, safeBook, key, exec);
    for (const item of parseCharacterLines(text)) {
      const card = cardOf(item.name);
      if (role === "主要") card.role = "主要";
      else if (card.role === "设定表") card.role = "次要";
      if (!card.description && item.description) card.description = item.description;
      if (OFFSTAGE_RE.test(item.description)) card.offstage = true;
    }
  }
  if (cardMap.size === 0) {
    degraded.push("设定表与创作资料均无人物卡：本章相关人物无法判断，characters 为空");
  }

  const characters = [];
  for (const card of cardMap.values()) {
    const needles = [card.name, ...card.alias];
    const mentions = countMentions(prevText, needles);
    const inOutline = needles.some((n) => n.length >= 2 && outlineDirection.includes(n));
    if (mentions === 0 && !inOutline) continue;
    const sources = [];
    if (mentions > 0) sources.push("上一章出场");
    if (inOutline) sources.push("大纲方向");
    const out = { name: card.name, role: card.role, description: card.description, mentions, sources };
    if (card.traits) out.traits = card.traits;
    if (card.relationships) out.relationships = card.relationships;
    if (card.alias.length > 0) out.alias = card.alias;
    if (card.offstage === true) out.offstage = true;
    characters.push(out);
  }
  characters.sort((a, b) => {
    if (b.mentions !== a.mentions) return b.mentions - a.mentions;
    const sa = a.sources.includes("上一章出场") ? 0 : 1;
    const sb = b.sources.includes("上一章出场") ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name, "zh");
  });
  const shownCharacters = budget.characters > 0 ? characters.slice(0, budget.characters) : characters;

  // ---------- ⑪ 本章禁用清单 ----------
  const avoid = [];
  // ① 已回收伏笔 ∩ 本章大纲方向行（"这条已经收过了，别再埋"）
  //    判据：伏笔内容的关键词与方向行有交集；长词（≥3 字）命中一条即算，短词（2 字）需≥2 条命中，
  //    以免中文二字碎片把无关伏笔全捞进来。短词命中里排除"已登记人名/其碎片"——人物名重合只说明
  //    这条伏笔牵涉这些人，不能说明本章方向在重埋它（实测：只共享"林晚/沈砚"时会误报）。
  const knownNames = [...cardMap.values()].flatMap((c) => [c.name, ...c.alias]);
  if (outlineDirection !== "") {
    let recycledHits = 0;
    for (const p of doneEntries) {
      if (recycledHits >= 5) break;
      const hits = [...new Set([...plotKeywords(p.content), ...plotKeywordsAll(p.content)])].filter((k) => outlineDirection.includes(k));
      const longHits = hits.filter((k) => k.length >= 3);
      const shortHits = hits.filter((k) => k.length === 2 && !knownNames.some((n) => n.length >= 2 && n.includes(k)));
      if (longHits.length === 0 && shortHits.length < 2) continue;
      recycledHits += 1;
      avoid.push({
        kind: "已回收伏笔",
        detail: "伏笔 #" + p.id + " 已回收（" + clip(p.content, 30) + "）——与本章方向行重合词：" + [...longHits, ...shortHits].slice(0, 3).join("、") + "；这条已经收过了，别再当新伏笔埋"
      });
    }
  }
  // ② 世界观禁词（前 10 条；有替代词时一并给出）
  if (worldview) {
    for (const word of worldview.bannedWords.slice(0, 10)) {
      const rep = typeof worldview.recommended[word] === "string" ? worldview.recommended[word] : "";
      avoid.push({ kind: "禁词", detail: word + (rep ? "（建议改用：" + rep + "）" : "（worldview 禁用词）") });
    }
  }
  // ③ 已退场角色（设定表 status/notes 或次要人物设定里的"不再出场/已死"标记，最多 5 条）
  let offstageShown = 0;
  for (const card of cardMap.values()) {
    if (card.offstage !== true || offstageShown >= 5) continue;
    offstageShown += 1;
    avoid.push({ kind: "已退场角色", detail: card.name + "（设定标注退场/死亡）：本章不要再让 TA 出场或说话" });
  }

  // ---------- ⑫ 写作计划（全部由上面已有字段派生，不编造剧情） ----------
  const prevLabel = prevChapter
    ? "第 " + (prevChapter.number ?? "?") + " 章" + (prevChapter.title ? "《" + prevChapter.title + "》" : "")
    : "";
  const previousState = prevChapter
    ? "上一章：" + prevLabel + (previousHook !== "" ? "；结尾钩子：" + previousHook : anchor !== "" ? "；正文已在 anchor（末 " + budget.anchorChars + " 字），钩子未回填" : "；正文为空")
    : "无上一章（本章为全书开篇）";
  const goal = outlineDirection !== ""
    ? "按大纲方向行写：" + outlineDirection
    : previousHook !== ""
      ? "大纲未给方向，承接上一章钩子推进：" + previousHook
      : prevChapter
        ? "大纲未给方向、上一章钩子未回填：从上一章结尾（anchor）自然接续"
        : "全书开篇且无大纲方向：按创作设定开篇";

  // v5.0.0 修正（降本）：清单从"催办单"改成"提醒单"——只有真要调用工具的两条被降级为按需/建议。
  // 实测背景：清单里的"跑 novel_style_check 自检 / 回填钩子"会被模型当成必做步骤，每章固定多出 3 次调用，
  // 而每次调用都要重发整章正文；锚段被要求"按味道与形状写"则会让句式趋同（僵化）。
  const checklist = ["读一遍【anchors 锚段】校准语感——**不要照 skeletons 造句、不要套它们的句式模板**（骨架只在写不出该类型句子时参考）；baseline 数字只做写完后的校验"];
  if (previousHook !== "") checklist.push("本章开头接住上一章钩子：" + clip(previousHook, 30));
  else if (prevChapter) checklist.push("本章开头承接上一章结尾（原文见 anchor）");
  if (outlineDirection !== "") checklist.push("按本章大纲方向行推进：" + clip(outlineDirection, 40));
  for (const p of openPlots.filter((x) => x.priority === "high").slice(0, 3)) {
    checklist.push("未回收伏笔 #" + p.id + "（high，已埋 " + p.distance + " 章）：写得到就顺势推进/回收，写不到也要提一句：" + clip(p.content, 24));
  }
  const recycled = avoid.filter((a) => a.kind === "已回收伏笔");
  if (recycled.length > 0) checklist.push("别重复埋已回收的伏笔（见 avoid 的「已回收伏笔」）：" + recycled.length + " 条与本章方向行重合");
  const bannedShown = avoid.filter((a) => a.kind === "禁词").slice(0, 5).map((a) => a.detail.split("（")[0]);
  if (bannedShown.length > 0) checklist.push("避免使用：" + bannedShown.join("、"));
  const offstage = avoid.filter((a) => a.kind === "已退场角色");
  if (offstage.length > 0) checklist.push("已退场角色不要再出场：" + offstage.slice(0, 3).map((a) => a.detail.split("（")[0]).join("、"));
  if (shownCharacters.length > 0) {
    // v5.0.0：已退场人物直接标在人物清单里——避免"相关人物"与"不要再出场"两条提示互相打架
    const names = shownCharacters.slice(0, 5).map((c) => c.name + (c.offstage === true ? "（已退场，勿写其出场）" : "")).join("、");
    checklist.push("本章相关人物：" + names + "——对照其说话方式与关系");
  }
  if (baseline) {
    checklist.push("写完**建议**跑一次 novel_style_check；只有相似度明显偏低、或某维偏离超过 2 倍容差时才逐句修正——单一维度轻微出带属正常波动（1.5σ 带宽下常见），**不要为对齐数字改文**");
  }
  checklist.push("收尾按需，不必每章全套：确属本章新埋的伏笔才 novel_plot add；钩子与摘要在章节稳定后再回填（novel_outline hook / novel_summary）");

  return {
    book: safeBook,
    chapter,
    isNext,
    anchor,
    previousHook,
    outlineDirection,
    characters: shownCharacters,
    openPlots,
    worldview,
    baseline,
    anchors,
    skeletons,
    lastVerdict,
    avoid,
    plan: { previousState, goal, checklist },
    degraded: [...new Set(degraded)]
  };
}
