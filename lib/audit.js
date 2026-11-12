/**
 * v7.2.0 对抗性审计（lib/audit.js）——**只报能举证的违约**。
 *
 * 三个能力：
 *   ① `runAuditContracts`：只跑**可机器判定**的契约，每条违约带证据（1-based 行号 + 原文片段）；
 *   ② `buildAuditBrief`：给**另一个没有上下文的 AI** 生成审计任务书（中文）+ 机器可读 protocol；
 *   ③ `verifyAuditClaims`：复核它交回来的取证——行号可修正，原文不存在 = 编造证据（rejected）。
 *
 * ## 为什么不是「文学评论」
 *
 * 写作没有真值：一段文字「好不好」无法用机器判定，任何这类判断都只是模型口味。
 * 所以本模块的产出**只允许是违约**：契约必须可判定（词表命中 / 登记项缺失 / 结构性症状），
 * 每条违约必须能定位到行号与原文，`detail` 只写「事实 + 依据」，绝不写「应该怎么改」。
 * 同一原则也写进 `buildAuditBrief` 的任务书：独立 AI 不许提建议、不许评价文笔，举不出证据不许写。
 *
 * ## 契约取舍（本设计的关键取舍，别在后续版本里悄悄放宽）
 *
 * · `chapter-diagnose` 的症状里，只有 `ending_preach` / `bare_dialogue` 是**结构可判定**的，
 *   才转成违约；`abstract` / `action_thin` / `sense_mono` / `object_thin` / `slop` 属于
 *   「风格建议」（相对分位阈值、题材差异极大），**不进 audit**——它们不是违约，是口味。
 *   （`slop` 的**词表命中**仍由 `slop` 契约单独负责，那是词面事实，不是相对分位判断。）
 * · `outline` 的向量相似度是**启发式**：它报的是「关键词与向量都没达标」，不是「作者写错了」。
 *   本模块如实写成「未兑现」，并在 brief 里要求独立 AI 只引用原文、不得据此评价情节安排。
 * · `lexicon` 的替身词判定沿用 v7.1.0 的**严格包含**口径：替身词包含必用词时（如必用词「药」
 *   vs 替身「草药」）该处仍算用了替身词。这是已知取舍——否则「用「草药」代替「药」」会永久漏报。
 *
 * ## 隔离与可测性
 *
 * `options.deps` 仅供测试注入可替换依赖（生产调用不要传）。逐条契约独立 try/catch：
 * 任何一条抛错只让它自己 `ran:false`，不影响其它契约；取消（AbortError）一律向外重新抛。
 */
import { basename, join } from "node:path";
import {
  CREATION_FILES,
  OUTLINE_LINE_RE,
  auditLexicon,
  bookDir,
  countTextLines,
  creationDir,
  isAbort,
  normalizePlotEntry,
  parseChapterNumber,
  plotKeywords,
  readLexicon,
  readPlots,
  readSettings,
  readTextFile,
  resolveStyleRule,
  isGuardedArtifact
} from "./core.js";
import { splitBlocks } from "./analysis.js";
import { SLOP_CATEGORIES, buildSlopExemptions, scanSlop } from "./lexicons/slop.js";
import { checkOutlineFulfillment, detectSemanticLoop } from "./vector-audit.js";
import { diagnoseChapterSymptoms, maxBareDialogueRun } from "./chapter-diagnose.js";
import { isAvailable } from "./embedding.js";

// ===========================================================================
// 契约定义（顺序即 `contracts` 数组的固定顺序；id 是对外契约，改 id = 破坏调用方）
// ===========================================================================

/**
 * 每条契约一个 id。
 * `criterion` 同时用于任务书的一句话判据与 protocol（机器可读），只写**判据**，不写改法。
 */
const CONTRACT_DEFS = Object.freeze([
  Object.freeze({
    id: "lexicon",
    label: "必用词/替身词",
    criterion: "必用词（含 aliases 等价写法）本章一次都没出现，或出现了词表登记的「通用替身词」。"
  }),
  Object.freeze({
    id: "banned",
    label: "世界观禁用词",
    criterion: "正文使用了世界观用语规范登记的禁用词（本书 allowWords 登记的词已静音）。"
  }),
  Object.freeze({
    id: "slop",
    label: "套话",
    criterion: "命中套话词表的结构片段（8 类，按类别归并计数）。"
  }),
  Object.freeze({
    id: "loop",
    label: "原地打转",
    criterion: "连续语义块高度相似且几乎没有新信息（需语义引擎可用）。"
  }),
  Object.freeze({
    id: "outline",
    label: "大纲兑现",
    criterion: "本章大纲方向行的某个子句，在正文里关键词命中不足且向量相似低于阈值。"
  }),
  Object.freeze({
    id: "ending",
    label: "章末收束",
    criterion: "章末停在抽象感悟/预告上（结尾段无对话、具体动作少于 2 处，且命中抽象总结词或章末套话）。"
  }),
  Object.freeze({
    id: "bare_dialogue",
    label: "连续裸台词",
    criterion: "连续多段只有台词与「道/冷笑」，旁白不足 12 字且没有具体动作或器物接触。"
  }),
  Object.freeze({
    id: "plot",
    label: "伏笔登记",
    criterion: "仍 open 且登记章号早于本章的伏笔，本章命中其 ≥2 个关键词，但登记表没有记录本章提及。"
  })
]);

const CONTRACT_BY_ID = new Map(CONTRACT_DEFS.map((def) => [def.id, def]));

// ===========================================================================
// 通用小工具
// ===========================================================================

/** 取消不是「数据取不到」：与 core 同一判据，构造一个 name=AbortError 的错误。 */
function abortError() {
  const err = new Error("审计已取消（AbortError）");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(exec) {
  if (exec && exec.signal && exec.signal.aborted) throw abortError();
}

/** 任意输入 → 字符串（不抛异常；null/undefined → 空串）。 */
function toText(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return String(value);
  } catch {
    return "";
  }
}

/**
 * 一行原文 → 证据片段（去首尾空白、按码点截断）。
 * 去 trim 只动两端，截断也只取前缀——结果一定是该行的**连续子串**（verifyAuditClaims 依赖这点）。
 */
function snippetOf(line, max = 40) {
  const trimmed = toText(line).trim();
  if (trimmed === "") return "";
  const chars = Array.from(trimmed);
  return chars.length > max ? chars.slice(0, max).join("") : trimmed;
}

/** 文本内偏移 → 1-based 行号（0 偏移也返回 1）。 */
function lineOfIndex(text, index) {
  let line = 1;
  const stop = Math.min(Math.max(0, index), text.length);
  for (let i = 0; i < stop; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** 最后一个内容行的 1-based 行号（跳过空行 / Markdown 标题 / 分割线，与 chapter-diagnose 同口径）。 */
function lastContentLineNumber(text) {
  const lines = toText(text).split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    if (/^#{1,6}\s/.test(trimmed)) continue;
    if (/^[-_*=]{3,}$/.test(trimmed)) continue;
    return i + 1;
  }
  return 0;
}

/**
 * 段落块 → 1-based 起始行号（顺序定位，游标按整块长度推进）。
 * 用 `indexOf` 而不是逐行重建：`splitBlocks` 会 trim 每行、剥标题/分割线，重建容易错位。
 * 定位不到时给 0（宁可少一条证据，也不报一个假行号）。
 */
function blockLineNumbers(text, blocks) {
  const out = [];
  let cursor = 0;
  for (const block of blocks) {
    const raw = toText(block);
    const probe = Array.from(raw).slice(0, 40).join("");
    const at = probe === "" ? -1 : text.indexOf(probe, cursor);
    if (at >= 0) {
      out.push(lineOfIndex(text, at));
      cursor = at + raw.length;
    } else {
      out.push(0);
    }
  }
  return out;
}

// v7.3.1 修（#31）：删除 guardRangesOfLine 及整条 collocation-guards 导入（DENSITY_GUARD_CHANNELS /
// guardRanges / inRanges）。v7.2.0 把禁用词豁免改判到 isGuardedArtifact 之后，这个"六通道区间并集"
// 函数就再没有任何调用点，整条导入成了死引用。
// 注意：isGuardedArtifact 那条路**必须保留**（禁用词/改稿台/连贯性审计共用的实证碰撞表，见下方
// findBannedViolations 与 core.js:1293），这里删的只是"细节密度用的那张表"在审计层的残留。

function clampSeverity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

/**
 * 统一的违约形状：**只允许**这 6 个键。
 * 即使注入的依赖多返回了字段，也不许漏进 audit 输出（audit 的契约是「无建议性字段」）。
 */
function cleanViolation(contractId, raw) {
  const def = CONTRACT_BY_ID.get(contractId);
  const line = Number.isInteger(raw && raw.line) && raw.line >= 0 ? raw.line : 0;
  return {
    contract: contractId,
    severity: clampSeverity(raw && raw.severity),
    title: toText(raw && raw.title) || (def ? def.label : contractId),
    line,
    text: toText(raw && raw.text),
    detail: toText(raw && raw.detail)
  };
}

function compareViolations(a, b) {
  if (b.severity !== a.severity) return b.severity - a.severity;
  if (a.contract !== b.contract) return a.contract < b.contract ? -1 : 1;
  return a.line - b.line;
}

// ===========================================================================
// 伏笔 / 大纲小工具
// ===========================================================================

/** 伏笔登记表里「本章已提及」的判定：mentionedIn 允许章号、`第3章`、文件名等写法。 */
function plotMentioned(entry, chapterNumber, fileName) {
  const list = Array.isArray(entry && entry.mentionedIn) ? entry.mentionedIn : [];
  for (const item of list) {
    const raw = toText(item).trim();
    if (raw === "") continue;
    if (fileName !== "" && basename(raw) === fileName) return true;
    const byName = parseChapterNumber(basename(raw));
    if (Number.isInteger(byName) && byName === chapterNumber) return true;
    const digits = /(\d+)/.exec(raw);
    if (digits && Number(digits[1]) === chapterNumber) return true;
  }
  return false;
}

/** 读「剧情大纲.md」里本章的方向行；用 v7.1.0 的单一来源 OUTLINE_LINE_RE，不自拼正则。 */
async function readOutlineDirection(root, book, chapterNumber, deps, exec) {
  if (!Number.isInteger(chapterNumber)) return { ok: false, reason: "解析不出本章章号" };
  let content = "";
  try {
    content = await deps.readTextFile(join(creationDir(root, book), CREATION_FILES.outline), exec);
  } catch (e) {
    if (isAbort(e)) throw e;
    if (e && e.code === "ENOENT") return { ok: false, reason: "大纲里没有本章方向行" };
    throw e;
  }
  for (const line of toText(content).split(/\r?\n/)) {
    const m = OUTLINE_LINE_RE.exec(line);
    if (!m) continue;
    if (parseInt(m[1], 10) !== chapterNumber) continue;
    const direction = String(m[2] ?? "").trim();
    if (direction === "") return { ok: false, reason: "本章大纲方向行为空" };
    return { ok: true, direction };
  }
  return { ok: false, reason: "大纲里没有本章方向行" };
}

// ===========================================================================
// 各契约的实现（每个返回 { ran, reason?, violations? }）
// ===========================================================================

async function runLexiconContract(ctx) {
  const view = await ctx.deps.readLexicon(ctx.root, ctx.book);
  const entries = Array.isArray(view && view.entries) ? view.entries : [];
  if (entries.length === 0) {
    if (view && view.corrupt === true) {
      return { ran: false, reason: "必用词表文件损坏（无法读取或不是合法 JSON）" };
    }
    return { ran: false, reason: "未登记必用词表" };
  }

  // auditLexicon 是 core 里「必用词覆盖率 + 替身词」的单一实现：
  // 覆盖计数含 aliases；替身词按 v7.1.0 严格包含口径判定（见文件头注释）。
  const audited = ctx.deps.auditLexicon(entries, ctx.text, "");
  const violations = [];

  for (const item of Array.isArray(audited && audited.missing) ? audited.missing : []) {
    violations.push({
      contract: "lexicon",
      severity: 2,
      title: "必用词未出现",
      line: 0,
      text: "",
      detail: "必用词「" + toText(item && item.term) + "」本章未出现（0 次，含等价写法）"
    });
  }

  // 同一个「词条 + 替身词」只报一条（取首次出现的行）。
  const firstAvoid = new Map();
  for (const hit of Array.isArray(audited && audited.avoidHits) ? audited.avoidHits : []) {
    const key = toText(hit && hit.term) + "\u0000" + toText(hit && hit.word);
    if (!firstAvoid.has(key)) firstAvoid.set(key, hit);
  }
  for (const hit of firstAvoid.values()) {
    const line = Number.isInteger(hit && hit.line) && hit.line >= 1 ? hit.line : 0;
    violations.push({
      contract: "lexicon",
      severity: 3,
      title: "使用了通用替身词",
      line,
      text: line > 0 ? snippetOf(ctx.lines[line - 1]) : "",
      detail: "必用词「" + toText(hit && hit.term) + "」的通用替身词「" + toText(hit && hit.word) + "」出现（第 " + line + " 行）"
    });
  }
  return { ran: true, violations };
}

async function runBannedContract(ctx) {
  const settings = await ctx.deps.readSettings(ctx.root, ctx.book);
  const worldview = Array.isArray(settings && settings.worldview) ? settings.worldview : [];
  if (worldview.length === 0) {
    return { ran: false, reason: "未登记世界观条目（worldview）" };
  }
  // 唯一裁决点：allowWords（本书用词豁免）的静音在 resolveStyleRule 里已经生效，
  // 这里不重复实现「跳过 allowWords」——否则两张表会各静音一次、结论可能不一致。
  // 传入本章正文：worldview 未登记文化标记时，让文化基准按正文检测（与 index.js 的连贯性审计同口径）。
  const rule = ctx.deps.resolveStyleRule(settings, [{ file: ctx.file || "本章", text: ctx.text }], {});
  const words = Array.isArray(rule && rule.bannedWords) ? rule.bannedWords.filter((w) => toText(w) !== "") : [];
  const cultureName = toText(rule && rule.cultureName) || "未标注";
  // v7.2.0 修正（文档核验发现）：登记了 worldview 但禁用词表为空/全被 allowWords 静音时，
  // 不能报 "ran:true + 0 违约"——那读起来像"查过了、没问题"，而实际是**没材料可查**。
  // 与 lexicon 契约对"空材料"的处理保持一致：一律 ran:false + 原因。
  if (words.length === 0) {
    return { ran: false, reason: "当前文化基准（" + cultureName + "）没有可用的禁用词（世界观条目未登记 bannedWords，或已全部被 allowWords 豁免）" };
  }
  const violations = [];

  for (let i = 0; i < ctx.lines.length; i += 1) {
    const line = ctx.lines[i];
    if (line === "") continue;
    for (const word of words) {
      const needle = toText(word);
      if (needle === "") continue;
      let from = 0;
      while (from <= line.length - needle.length) {
        const at = line.indexOf(needle, from);
        if (at === -1) break;
        from = at + needle.length;
        // v7.2.0 修正：**改用 isGuardedArtifact**（guards.js 的实证碰撞表），与改稿台
        // （lib/fixplan.js）和连贯性审计（lib/index.js）同一张表。
        // 此前误用了细节密度的六通道搭配表，导致「这里正是…」含禁用词「里正」时，
        // 改稿台静音、审计却报 severity 4 硬违约——两套结论互相打脸。
        if (ctx.deps.isGuardedArtifact(needle, line, at)) continue;
        violations.push({
          contract: "banned",
          severity: 4,
          title: "使用世界观禁用词",
          line: i + 1,
          text: snippetOf(line),
          detail: "「" + needle + "」在当前文化基准「" + cultureName + "」的禁用词表里（命中第 " + (i + 1) + " 行）"
        });
        break; // 同一行同一词只报一条
      }
    }
  }
  return { ran: true, violations };
}

async function runSlopContract(ctx) {
  // v7.2.0 修正（文档核验发现）：改稿台是 `scanSlop(text, buildSlopExemptions(...))`，
  // 审计此前裸调 `scanSlop(text)` → 系统流/面板流被改稿台静音的数值播报，审计仍按套话报。
  // 现在至少把「题材静音（worldview）」这一层对齐；参照集高频词那一层审计不加载（见文件头局限说明），
  // 所以审计**只会比改稿台更严、不会更松**——这是刻意的。
  let slopOpts = null;
  try {
    const settings = await ctx.deps.readSettings(ctx.root, ctx.book);
    slopOpts = ctx.deps.buildSlopExemptions("", { settings });
  } catch {
    slopOpts = null; // 读设定失败：不豁免（宁可多报，也不静默放过）
  }
  const info = ctx.deps.scanSlop(ctx.text, slopOpts || undefined);
  const hits = Array.isArray(info && info.hits) ? info.hits : [];
  const groups = new Map();
  for (const hit of hits) {
    const category = toText(hit && hit.category);
    if (category === "") continue;
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(hit);
  }
  const violations = [];
  for (const [category, list] of groups) {
    const label = SLOP_CATEGORIES[category] ?? category;
    // 3~5：单处=3，≥3 处=4，≥6 处=5（同一类别在章内越密集越严重）。
    const severity = Math.min(5, 3 + (list.length >= 3 ? 1 : 0) + (list.length >= 6 ? 1 : 0));
    let first = list[0];
    for (const hit of list) {
      if (Number(hit && hit.line) < Number(first && first.line)) first = hit;
    }
    const line = Number.isInteger(first && first.line) && first.line >= 1 ? first.line : 0;
    violations.push({
      contract: "slop",
      severity,
      title: "套话·" + label,
      line,
      text: toText(first && first.text),
      detail: "类别 " + category + "（" + label + "） 命中 " + list.length + " 处"
    });
  }
  return { ran: true, violations };
}

async function runLoopContract(ctx) {
  // v7.2.0 修正：用户关掉「语义增强」时，改稿台是跳过的，审计不能绕过这个开关去跑嵌入推理。
  if (ctx.semanticEnabled === false) {
    return { ran: false, reason: "语义增强已关闭（features.semanticEmbedding），本契约未跑" };
  }
  if (!(await ctx.deps.isAvailable())) {
    return { ran: false, reason: "语义引擎不可用（模型缺失或 WASM 初始化失败）" };
  }
  const result = await ctx.deps.detectSemanticLoop(ctx.text);
  if (!result || result.checked !== true) {
    return { ran: false, reason: toText(result && result.reason) || "打转判定未完成（引擎不可用或正文过短）" };
  }
  const violations = [];
  for (const loop of Array.isArray(result.loops) ? result.loops : []) {
    const line = Number.isInteger(loop && loop.lineFrom) && loop.lineFrom >= 1 ? loop.lineFrom : 0;
    violations.push({
      contract: "loop",
      severity: 3,
      title: "疑似原地打转",
      line,
      text: toText(loop && loop.excerpt),
      detail: "第 " + toText(loop && loop.lineFrom) + "~" + toText(loop && loop.lineTo) + " 行连续语义块高度相似（平均余弦 "
        + toText(loop && loop.sim) + "，新信息占比 " + toText(loop && loop.novelty) + "）"
    });
  }
  return { ran: true, violations };
}

async function runOutlineContract(ctx) {
  const found = await ctx.outlineDirection();
  if (!found.ok) return { ran: false, reason: found.reason };
  // v7.2.0 修正：用户关掉「语义增强」时，改稿台是跳过的，审计不能绕过这个开关去跑嵌入推理。
  if (ctx.semanticEnabled === false) {
    return { ran: false, reason: "语义增强已关闭（features.semanticEmbedding），本契约未跑" };
  }
  if (!(await ctx.deps.isAvailable())) {
    return { ran: false, reason: "语义引擎不可用（模型缺失或 WASM 初始化失败）" };
  }
  const result = await ctx.deps.checkOutlineFulfillment(found.direction, ctx.text);
  if (!result || result.checked !== true) {
    return { ran: false, reason: toText(result && result.reason) || "大纲兑现核对未完成" };
  }
  const violations = [];
  for (const item of Array.isArray(result.unfulfilled) ? result.unfulfilled : []) {
    const clause = toText(item && item.clause);
    const sim = Number.isFinite(Number(item && item.bestSim)) ? Number(item.bestSim) : null;
    violations.push({
      contract: "outline",
      severity: 3,
      title: "大纲子句未兑现",
      line: 0,
      text: "",
      detail: "大纲子句「" + clause + "」在本章未兑现（关键词命中不足，且最高相似度 "
        + (sim === null ? "不可得" : sim) + " 低于阈值）"
    });
  }
  // skipped 是「推理失败、没判定」——不是违约（任务书口径），这里刻意不提。
  return { ran: true, violations };
}

/** 只调用一次 diagnoseChapterSymptoms（ending / bare_dialogue 共用），失败时两条契约各自 ran:false。 */
function diagnoseOnce(ctx) {
  if (!ctx.diagnosePromise) {
    ctx.diagnosePromise = Promise.resolve().then(() => ctx.deps.diagnoseChapterSymptoms(ctx.text, ctx.refStats));
  }
  return ctx.diagnosePromise;
}

async function runEndingContract(ctx) {
  const symptoms = await diagnoseOnce(ctx);
  const hit = Array.isArray(symptoms) ? symptoms.find((s) => s && s.key === "ending_preach") : null;
  if (!hit) return { ran: true, violations: [] };
  const line = lastContentLineNumber(ctx.text);
  return {
    ran: true,
    violations: [{
      contract: "ending",
      severity: 3,
      title: toText(hit.title) || "章末升华",
      line,
      text: line > 0 ? snippetOf(ctx.lines[line - 1]) : "",
      detail: "章末停在抽象感悟/预告上：结尾段没有对话、具体动作少于 2 处，且命中抽象总结词或章末套话"
    }]
  };
}

async function runBareDialogueContract(ctx) {
  const symptoms = await diagnoseOnce(ctx);
  const hit = Array.isArray(symptoms) ? symptoms.find((s) => s && s.key === "bare_dialogue") : null;
  if (!hit) return { ran: true, violations: [] };
  // 行号来自同一判定函数（maxBareDialogueRun）的段落游程，保证与症状同源。
  const run = maxBareDialogueRun(ctx.text);
  let line = 0;
  let snippet = "";
  let span = "";
  if (run && run.run > 0) {
    const blocks = splitBlocks(ctx.text);
    const lineNos = blockLineNumbers(ctx.text, blocks);
    line = lineNos[run.from - 1] ?? 0;
    snippet = line > 0 ? snippetOf(ctx.lines[line - 1]) : snippetOf(blocks[run.from - 1]);
    span = "第 " + run.from + "~" + run.to + " 段连续 " + run.run + " 段";
  } else {
    span = "存在连续多段";
  }
  return {
    ran: true,
    violations: [{
      contract: "bare_dialogue",
      severity: 3,
      title: toText(hit.title) || "站桩对话",
      line,
      text: snippet,
      detail: span + "只有台词与「道/冷笑」：旁白不足 12 字，且没有具体动作或器物接触"
    }]
  };
}

async function runPlotContract(ctx) {
  // 先读登记表：没有伏笔时给出 spec 约定的原因，而不是把「章号解析不出」当成结论。
  // 审计是只读路径：readOnly 阻止 readPlots 顺手把旧位置伏笔表迁移到新位置（那是写操作）。
  const raw = await ctx.deps.readPlots(ctx.root, ctx.book, { readOnly: true });
  const entries = (Array.isArray(raw) ? raw : []).map((entry) => normalizePlotEntry(entry)).filter(Boolean);
  if (entries.length === 0) return { ran: false, reason: "无伏笔记录" };
  if (!Number.isInteger(ctx.chapterNumber)) {
    return { ran: false, reason: "解析不出本章章号，无法核对伏笔登记" };
  }

  const violations = [];
  for (const entry of entries) {
    if (entry.status !== "open") continue;
    const registered = parseChapterNumber(String(entry.chapter ?? ""));
    if (!Number.isInteger(registered)) continue; // 没登记章号 → 无法比较，宁可不报
    if (registered >= ctx.chapterNumber) continue; // 只查「登记章号早于本章」的伏笔
    if (plotMentioned(entry, ctx.chapterNumber, ctx.file)) continue;

    const keywords = plotKeywords(entry.content);
    const hitKeywords = keywords.filter((keyword) => keyword !== "" && ctx.text.includes(keyword));
    if (hitKeywords.length < 2) continue;

    let line = 0;
    for (let i = 0; i < ctx.lines.length; i += 1) {
      if (hitKeywords.some((keyword) => ctx.lines[i].includes(keyword))) {
        line = i + 1;
        break;
      }
    }
    violations.push({
      contract: "plot",
      severity: 2,
      title: "伏笔疑似推进但登记表未更新",
      line,
      text: line > 0 ? snippetOf(ctx.lines[line - 1]) : "",
      detail: "本章疑似推进了伏笔 #" + entry.id + "，但登记表未更新（命中关键词：" + hitKeywords.slice(0, 3).join("、") + "）"
    });
  }
  return { ran: true, violations };
}

const CONTRACT_HANDLERS = Object.freeze({
  lexicon: runLexiconContract,
  banned: runBannedContract,
  slop: runSlopContract,
  loop: runLoopContract,
  outline: runOutlineContract,
  ending: runEndingContract,
  bare_dialogue: runBareDialogueContract,
  plot: runPlotContract
});

// ===========================================================================
// runAuditContracts
// ===========================================================================

/** 默认依赖（`options.deps` 仅测试注入用，键名与这里保持一致）。 */
const DEFAULT_DEPS = Object.freeze({
  readLexicon,
  auditLexicon,
  readSettings,
  resolveStyleRule,
  isGuardedArtifact,
  readPlots,
  readTextFile,
  scanSlop,
  buildSlopExemptions,
  detectSemanticLoop,
  checkOutlineFulfillment,
  diagnoseChapterSymptoms,
  isAvailable
});

/**
 * 严格对账：只跑可机器判定的契约。
 *
 * @param {object} opts
 * @param {string} opts.root 书库根
 * @param {string} opts.book 书名
 * @param {string} [opts.chapterFile] 章节文件名（用于 `file` / `chapterNumber`，未传 text 时也用它读正文）
 * @param {string} [opts.text] 本章正文（传了就不再读盘）
 * @param {object} [opts.exec] 宿主执行上下文（只用于取消信号与读盘）
 * @param {object|null} [opts.refStats] 参照集分位（传给 diagnoseChapterSymptoms；null = 只报结构性症状）
 * @param {object} [opts.options] `{ deps }` 仅测试注入
 * @returns {Promise<{
 *   file:string, chapterNumber:number|null, lines:number,
 *   contracts:Array<{id:string,label:string,ran:boolean,reason?:string}>,
 *   violations:Array<{contract:string,severity:number,title:string,line:number,text:string,detail:string}>,
 *   summary:string
 * }>}
 */
export async function runAuditContracts({ root, book, chapterFile, text, exec, refStats = null, options = {} } = {}) {
  if (typeof root !== "string" || root.trim() === "") throw new Error("缺少书库根目录（root）");
  if (typeof book !== "string" || book.trim() === "") throw new Error("缺少书名（book）");
  throwIfAborted(exec);

  const fileName = chapterFile ? basename(String(chapterFile)) : "";
  const chapterNumber = fileName ? (parseChapterNumber(fileName) ?? null) : null;
  let chapterText = typeof text === "string" ? text : null;
  if (chapterText === null) {
    if (fileName === "") throw new Error("缺少章节正文：请传入 text（正文）或 chapterFile（章节文件名）");
    chapterText = await readTextFile(join(bookDir(root, book), fileName), exec);
  }
  // CRLF → LF：行号不变，但让行内扫描/片段证据不带 \r。
  const normalized = chapterText.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  const overrides = options && typeof options.deps === "object" && options.deps !== null ? options.deps : {};
  const deps = { ...DEFAULT_DEPS, ...overrides };

  let directionPromise = null;
  const ctx = {
    root,
    book,
    file: fileName,
    chapterNumber,
    text: normalized,
    lines,
    refStats,
    exec,
    deps,
    semanticEnabled: options && options.semanticEnabled === false ? false : true,
    diagnosePromise: null,
    outlineDirection() {
      if (!directionPromise) {
        directionPromise = readOutlineDirection(root, book, chapterNumber, deps, exec);
      }
      return directionPromise;
    }
  };

  const contracts = [];
  const violations = [];
  for (const def of CONTRACT_DEFS) {
    throwIfAborted(exec);
    const handler = CONTRACT_HANDLERS[def.id];
    let outcome;
    try {
      outcome = await handler(ctx);
    } catch (e) {
      // 取消优先：任何 catch 降级分支都先放行 AbortError，别把取消伪装成「契约未跑」。
      if (isAbort(e) || (exec && exec.signal && exec.signal.aborted)) throw abortError();
      outcome = { ran: false, reason: toText(e && e.message) || String(e), violations: [] };
    }

    if (outcome && outcome.ran === false) {
      contracts.push({
        id: def.id,
        label: def.label,
        ran: false,
        reason: toText(outcome.reason) || "未说明原因"
      });
      continue;
    }
    contracts.push({ id: def.id, label: def.label, ran: true });
    const list = Array.isArray(outcome && outcome.violations) ? outcome.violations : [];
    for (const raw of list) violations.push(cleanViolation(def.id, raw));
  }

  violations.sort(compareViolations);

  // 「硬违约」= severity ≥ 4（世界观禁用词、高严重度套话等机器可直接举证的硬约束）；
  // severity ≤ 3 的是一般违约（必用词缺失、伏笔未登记、结构症状…）。
  const hard = violations.filter((v) => v.severity >= 4).length;
  const notRun = contracts.filter((c) => c.ran === false);
  let summary = "严格对账：" + violations.length + " 条违约（其中 " + hard + " 条硬违约）；" + notRun.length + " 项契约未跑";
  if (notRun.length > 0) {
    summary += "（" + notRun.map((c) => c.id + "：" + c.reason).join("；") + "）";
  }

  return {
    file: fileName,
    chapterNumber,
    lines: countTextLines(normalized),
    contracts,
    violations,
    summary
  };
}

// ===========================================================================
// buildAuditBrief
// ===========================================================================

/** 归一允许的契约清单：null/空 → 全部；未知 id 忽略；一个都不剩时退回全部。 */
function normalizeAllowedContracts(contracts) {
  if (!Array.isArray(contracts) || contracts.length === 0) return CONTRACT_DEFS.slice();
  const wanted = new Set(contracts.map((id) => toText(id)).filter((id) => id !== ""));
  const picked = CONTRACT_DEFS.filter((def) => wanted.has(def.id));
  return picked.length > 0 ? picked : CONTRACT_DEFS.slice();
}

/**
 * 生成「给另一个没有上下文的 AI」的审计任务书。
 *
 * 任务书里只写**判据与取证格式**，不写任何改法（见文件头「为什么不是文学评论」）。
 * `protocol` 是同一份约束的机器可读版本，供 verifyAuditClaims 与测试使用。
 *
 * @param {object} opts
 * @param {string} [opts.book]
 * @param {string} [opts.file]
 * @param {number} [opts.chapterNumber]
 * @param {string} [opts.chapterText] 会原样附在任务书末尾（```text 围栏）
 * @param {string[]|null} [opts.contracts] 允许的契约 id 子集；null/空 = 全部 8 条
 * @returns {{ brief:string, protocol:object, allowedContracts:string[] }}
 */
export function buildAuditBrief({ book, file, chapterNumber, chapterText, contracts = null } = {}) {
  const allowed = normalizeAllowedContracts(contracts);
  const allowedIds = allowed.map((def) => def.id);
  const bookName = toText(book);
  const fileName = toText(file);
  const text = typeof chapterText === "string" ? chapterText : "";
  // 行数口径与 runAuditContracts / novel_read 一致；CRLF 不影响行数。
  const lineCount = countTextLines(text.replace(/\r\n?/g, "\n"));
  const chapterLabel = Number.isInteger(chapterNumber) ? String(chapterNumber) : "未知";

  // 围栏长度按正文里最长的反引号串自适应（至少 3 个）：正文本身含 ``` 时，
  // 固定三连反引号会被正文提前闭合，章节原文就会漏进任务书的正文层。
  let fenceRun = 3;
  for (const run of text.match(/`+/g) || []) fenceRun = Math.max(fenceRun, run.length + 1);
  const fence = "`".repeat(fenceRun);
  const parts = [];
  parts.push("# 对抗性审计任务书");
  parts.push("");
  parts.push("## 一、身份与边界");
  parts.push("你是一名**审计员**，不是编辑。");
  parts.push("- 只报告**能举证**的违约：举不出证据的一条都不许写。");
  parts.push("- 不许改写正文，不许提改写建议，不许评价文笔、节奏、人物或情节好坏。");
  parts.push("- 你的产出只用来核对登记表与设置表，不是文学评论。");
  parts.push("");
  parts.push("## 二、任务");
  parts.push("对照下面允许的契约逐条核对本章正文。每一处报告都必须能定位到 1-based 行号，并引用该行原文的一段连续文字。");
  parts.push("靠推理、靠感觉、靠「这样写更好」的判断，一律不报。");
  parts.push("");
  parts.push("## 三、允许的契约");
  allowed.forEach((def, index) => {
    parts.push((index + 1) + ". `" + def.id + "`（" + def.label + "）：" + def.criterion);
  });
  parts.push("");
  parts.push("## 四、取证格式（严格 JSON）");
  parts.push("只输出一个 JSON 对象，形如：");
  parts.push(fence + "json");
  parts.push('{"claims":[{"contract":"plot","line":118,"text":"她仰头把半杯白酒灌了下去","why":"设定写她不喝酒"}]}');
  parts.push(fence);
  parts.push("- `contract`：必须是上面允许的契约 id 之一（" + allowedIds.join(" / ") + "）。");
  parts.push("- `line`：1-based 行号，范围 1.." + lineCount + "。");
  parts.push("- `text`：该行原文里**连续的一段**，不得改字、不得拼接、不得跨行。");
  parts.push("- `why`：不超过 40 字，只写违反了哪条设定/哪份登记，不写评价。");
  parts.push("- 没有可举证的违约时输出 `{\"claims\":[]}`。");
  parts.push("");
  parts.push("## 五、硬约束（违反会被判废）");
  parts.push("- `text` 必须能在该行里逐字找到；插件会逐条复核。");
  parts.push("- 行号错但原文确实在正文里：会自动修正行号（corrected）。");
  parts.push("- 原文在正文里根本不存在：判为**编造证据**（rejected），并计入废卷。");
  parts.push("- 不要输出任何解释、前言、结语或 Markdown 说明。");
  parts.push("");
  parts.push("## 六、输出");
  parts.push("只输出那个 JSON 对象本身。");
  parts.push("");
  parts.push("## 七、本次审计对象");
  parts.push("- 书：" + (bookName === "" ? "未提供" : bookName));
  parts.push("- 章节文件：" + (fileName === "" ? "未提供" : fileName));
  parts.push("- 章号：" + chapterLabel);
  parts.push("- 正文行数：" + lineCount);
  parts.push("- 允许的契约：" + allowedIds.join(" / "));
  parts.push("");
  parts.push("## 八、正文（行号从 1 开始，与 `line` 字段一一对应）");
  parts.push(fence + "text");
  parts.push(text);
  parts.push(fence);
  parts.push("");
  const brief = parts.join("\n");

  const protocol = {
    version: 1,
    book: bookName,
    file: fileName,
    chapterNumber: Number.isInteger(chapterNumber) ? chapterNumber : null,
    lineCount,
    contracts: allowed.map((def) => ({ id: def.id, label: def.label, criterion: def.criterion })),
    allowedContracts: allowedIds,
    claimFields: {
      contract: { type: "string", enum: allowedIds },
      line: { type: "integer", min: 1, max: lineCount, note: "1-based 行号" },
      text: { type: "string", note: "该行原文的连续子串；不得改字、拼接或跨行" },
      why: { type: "string", maxChars: 40 }
    },
    outputSchema: { claims: [{ contract: "string", line: "integer", text: "string", why: "string" }] },
    verifyRules: {
      textMustBeContinuousSubstring: true,
      lineIs1Based: true,
      normalizesWhitespace: true,
      correctsLineWhenTextFoundElsewhere: true,
      rejectsFabricatedText: true
    },
    output: "只输出一个 JSON 对象：{\"claims\":[{\"contract\":\"...\",\"line\":1,\"text\":\"...\",\"why\":\"...\"}]}"
  };

  return { brief, protocol, allowedContracts: allowedIds };
}

// ===========================================================================
// verifyAuditClaims
// ===========================================================================

/** 归一空白：`\s+` → 单个空格，并去掉首尾空白（回填 `text` 用它，与协议一致）。 */
function normalizeWhitespace(value) {
  return toText(value).replace(/\s+/g, " ").trim();
}

/**
 * 去掉全部空白后的形态：**只用于匹配的兜底**。
 *
 * 为什么需要它：独立 AI 复述原文时常多打/少打一个空格（「她仰头 把半杯白酒灌了下去」）。
 * 只做 `\s+`→单空格归一，声明里的额外空格仍留在原处 → 在该行里 `includes` 失败，
 * 一条证据确凿的声明会被误判成 corrected/rejected。匹配时两种形态都要试：
 *   ① 归一空白后包含（协议口径，优先）；
 *   ② 去掉全部空白后包含（容忍多打/少打空格）。
 * 回填的 `text` 始终用 ① 的形态（机器可读、稳定）。
 */
function compactWhitespace(value) {
  return toText(value).replace(/\s+/g, "");
}

/** 声明原文是否出现在某一行里（两种空白形态任一命中即算）。 */
function textInLine(line, normalizedText, compactText) {
  if (normalizeWhitespace(line).includes(normalizedText)) return true;
  return compactText !== "" && compactWhitespace(line).includes(compactText);
}

/**
 * 复核独立 AI 交回来的取证（**这是本设计的灵魂**）。
 *
 * 规则（严格）：
 *   · 行号/原文缺失 → rejected；
 *   · 该行原文（归一空白后）包含声明原文 → accepted；
 *   · 该行不包含，但全章其它行能找到（按行号升序取第一个）→ corrected（foundLine）；
 *   · 全章都找不到 → rejected，reason 明说「疑似编造证据」；
 *   · 同一 contract+text 的重复声明只保留第一条（text 为空的非法声明不做去重，避免把多条坏声明并成一条）。
 *
 * @param {object} opts
 * @param {Array<{contract?:string,line?:number,text?:string,why?:string}>} opts.claims
 * @param {string} opts.text 被审计的章节正文
 * @returns {{accepted:Array, corrected:Array, rejected:Array, total:number, score:number, reason?:string}}
 *   score = (accepted + corrected) / total × 100，四舍五入到整数；total = 0 时为 0。
 */
export function verifyAuditClaims({ claims, text } = {}) {
  if (!Array.isArray(claims) || claims.length === 0) {
    return {
      accepted: [],
      corrected: [],
      rejected: [],
      total: 0,
      score: 0,
      reason: "没有待复核的声明"
    };
  }

  const lines = toText(text).replace(/\r\n?/g, "\n").split("\n");
  const accepted = [];
  const corrected = [];
  const rejected = [];
  const seen = new Set();

  for (const claim of claims) {
    const raw = claim && typeof claim === "object" ? claim : {};
    const contract = toText(raw.contract);
    const normalized = normalizeWhitespace(raw.text);
    const claimedLine = Number.isInteger(raw.line) ? raw.line : 0;
    const base = {
      contract,
      line: claimedLine,
      text: normalized,
      why: toText(raw.why)
    };

    // 去重：同一 contract + 归一后原文只保留第一条（空原文声明不去重，见函数注释）。
    if (normalized !== "") {
      const key = contract + "\u0000" + normalized;
      if (seen.has(key)) continue;
      seen.add(key);
    }

    if (normalized === "" || !Number.isInteger(raw.line) || raw.line < 1 || raw.line > lines.length) {
      rejected.push({ ...base, reason: "行号或原文缺失" });
      continue;
    }

    const compact = compactWhitespace(normalized);
    if (textInLine(lines[raw.line - 1], normalized, compact)) {
      accepted.push({ ...base });
      continue;
    }

    let foundLine = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (i === raw.line - 1) continue;
      if (textInLine(lines[i], normalized, compact)) {
        foundLine = i + 1;
        break;
      }
    }
    if (foundLine > 0) {
      corrected.push({ ...base, foundLine, reason: "行号已修正" });
      continue;
    }
    rejected.push({ ...base, reason: "原文在正文中不存在（疑似编造证据）" });
  }

  const total = accepted.length + corrected.length + rejected.length;
  const score = total === 0 ? 0 : Math.round(((accepted.length + corrected.length) / total) * 100);
  return { accepted, corrected, rejected, total, score };
}
