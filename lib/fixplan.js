/**
 * v5.0.0 改稿台（fixplan.js）——把风格诊断从「一堆数据」变成「按优先级排好的待办清单」。
 *
 * 与既有引擎的分工：
 * - novel_style_check 给的是「数据」：diffs + fixAnchors + verdict + 六维 verdicts；
 *   模型拿到后还得自己组织成行动。本模块直接给「行动」：items（谁、在哪、差多少、往哪改、多难改）。
 * - 本文件只做「规则计算 + 定位 + 排序 + 落盘」，**不生成任何改写后的正文句子**。
 *   hint 只给方向（如「这句抽象词过密，改成具体动作或物件」）——生成正文是宿主模型的事。
 *
 * 三类导出：
 * - buildFixPlan  生成/刷新清单（保留人工 done/skip 状态）
 * - verifyFixPlan 读回清单 + 对当前正文重算 → resolved / pending / new
 * - markFixItem   人工标记单项 done / skip
 *
 * 关键实现约束（见下各处注释）：
 * - locate 行号宁可粗（整段）也不能给错：指标类问题只归因到「段落区间」，
 *   字面类问题（禁用词/语用）才用逐行 includes 精确定位。
 * - 不误报是硬要求：无基线、无 worldview、无伏笔、无法判定章号时一律**跳过该类检查**，
 *   而不是退化成默认词表兜底。
 * - 降级 ≠ 取消：任何 catch 降级分支都要先放行 AbortError（core.isAbort），
 *   否则一次被取消的调用会返回"成功但清单为空"。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  atomicWriteJson,
  bookDir,
  buildStyleAnchorPackage,
  buildTolerance,
  detectChapterBridge,
  findChapter,
  isAbort,
  metricChaptersCached,
  MIN_BASELINE_CHAPTERS,
  novelDataDir,
  normalizeChapterKey,
  parseChapterNumber,
  readPlots,
  readSentenceState,
  readSettings,
  readTextFile,
  sanitizeSegment,
  scanChapters,
  withFileTx
} from "./core.js";
import {
  computeBaselineFromPerChapter,
  judgeAgainstBaseline,
  measureStyleMetrics,
  METRIC_LABELS,
  METRIC_ORDER
} from "./style-metrics.js";

// ─────────────────────────────────────────────────────────────────────────────
// v5.0.0 常量与阈值
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v5.0.0：伏笔「未回收」判定阈值 = 20 章。取 20 的三条理由：
 * ① 中文网文的常见节奏是「三章一小钩、十章一中线、一卷一主线」，20 章≈一个中卷的跨度；
 * ② 低于 20 章时，「刚埋下还没到回收点」与「作者忘了这条线」在文本上无法区分，报出来必是噪声；
 * ③ novel_plot 的 lastMentioned 记录的是「最近一次被提及的章节」，20 章内被提及过即视为仍在线上。
 */
const PLOT_STALE_CHAPTERS = 20;

/** v5.0.0：基线章节数少于 3 时 σ 不可靠（小样本），容差下限抬到 25%，避免「只有两章的书」互相误报。
 *  容差公式与常量已上移到 core.js（buildTolerance / MIN_BASELINE_CHAPTERS）——开写包要用同一口径。 */

/**
 * v5.0.0 修正（降本）：同一维度最多归因 1 个段落（原为多个）。
 * 同一维度归因多个段落会让清单成倍膨胀：模型面对同质待办会倾向「逐段改写」，
 * 一次改稿动辄刷出十几条，既贵（每条都要重发整章上下文），又会让全章语气被抹成同一种（越改越僵）。
 * 只报该维度**最严重**的那 1 段，其余段落的量由 summary 的计数体现——要看全章分布时读计数即可。
 */
const MAX_PARAGRAPH_ITEMS_PER_METRIC = 1;

/**
 * v5.0.0 修正（降本）：单次清单的条数上限（超出按排序截断，summary 会披露截断数）。
 * 清单是「先改最要紧的」，不是「一次改完」：上限压低后模型不会去追长尾——
 * 被截断的部分在 summary 备注里如实披露，改完这几条重跑清单，下一批自然浮现。
 */
const DEFAULT_MAX_ITEMS = 12;

/** v5.0.0：参与段落级指标归因的最小段长——与 computeBaseline 的「<40 字章节不参与基线」口径一致。 */
const MIN_PARA_CHARS = 40;

/**
 * v5.0.0：指标类判定所需的最小基线章节数 = 2。
 * 只有 1 个基线章节时，「波动」无从估计（σ 会被钳到 0.15μ），任何写法差异都会被判成出带——
 * 实测：两章都正常的书，仅因一句「的」的多少就会报「抽象度过高」。故单章基线直接跳过指标类检查。
 * 常量定义在 core.js（与开写包的 lastVerdict 共用同一门槛）。
 */

/**
 * v5.0.0：每维的**绝对**最小偏差门槛（低于此值不出条）——不误报的第二道闸。
 * 六维都是「每千字计数」或「平均小句数」，μ 很小时相对偏差可以轻松破百（μ=2 的书，一章 5 就是 +150%），
 * 但读者根本感知不到。下列数值是「小到读不出来」的量级：
 * complexity 是平均每句小句数（0.3 ≈ 每 3 句多一个小句）；其余四维是每千字点数（8 ≈ 每 125 字 1 个）；
 * gapIndex 是每千字留白点数（12 ≈ 每 83 字 1 点）。低于门槛的维度按「无量级差异」忽略。
 */
const METRIC_MIN_DELTA = {
  complexity: 0.3,
  modifierDensity: 8,
  abstractDensity: 8,
  actionDensity: 8,
  hedgeDensity: 4,
  gapIndex: 12
};

/** v5.0.0：六维 → type 映射。四类"写法维度"统一归入「句式偏离」，抽象度/留白各成一类。 */
const METRIC_TYPE = {
  complexity: "句式偏离",
  modifierDensity: "句式偏离",
  actionDensity: "句式偏离",
  hedgeDensity: "句式偏离",
  abstractDensity: "抽象度过高",
  gapIndex: "留白异常"
};

/** v5.0.0：type → ASCII slug（用于稳定 id，避免中文出现在 id 里）。 */
const TYPE_SLUG = {
  句式偏离: "sentence",
  抽象度过高: "abstract",
  留白异常: "gap",
  禁用词: "banned",
  语用不符: "pragmatic",
  衔接缺失: "bridge",
  伏笔未回收: "plot",
  情感过直: "emotion"
};

/**
 * v5.0.0：维度偏离方向 → 改写**方向**（不是句子）。key = 维度；值 = { high, low }，按偏离方向取。
 * 全部是「怎么改」的动作描述，不含任何可直接粘贴进正文的成句文本。
 */
const METRIC_DIRECTION = {
  complexity: {
    high: "把长句拆开：并列小句改成独立句，或把从句提到句首",
    low: "一味短句会让叙述发干：该用逗号/分号把相关小句串起来的地方串起来"
  },
  modifierDensity: {
    high: "删掉多余的「的/地」修饰，把定语换成动作或可见细节",
    low: "该具体的地方补一个限定修饰（谁的、哪来的、什么材质）"
  },
  abstractDensity: {
    high: "这句抽象词过密，改成具体动作或物件",
    low: "该收束的地方用一句抽象概括点题，别一路只写事"
  },
  actionDensity: {
    high: "动作密度过高，补一两句停顿/环境让节奏喘口气",
    low: "叙述停在静态描写或心理上，补一个可见的动作把场景推进"
  },
  hedgeDensity: {
    high: "「似乎/仿佛/大概」这类模糊语过多，确定的地方就写确定",
    low: "叙述过于斩钉截铁，可用一处推测语留出人物的不确定"
  },
  gapIndex: {
    high: "省略号/破折号过于密集或未完句太多：把该说完的句子补完，收掉多余的留白",
    low: "此处需要留白：删掉解释性的半句，让情绪停在断口上"
  }
};

/**
 * v5.0.0 修正（降本）：指标类 hint 的**软化后缀**——只加在「抒情/心理/留白段落本来就这么写」的三个维度上。
 * 抽象度过高不该一律改：抒情与心理段落本就偏抽象；留白异常（省略号/破折号）常是刻意的节奏手段；
 * hedgeDensity（似乎/仿佛/大概）更是限知视角下的正常写法。这三类若一律按「待改」处理，
 * 模型会把全章语气统一成同一种（实测反馈：越改越僵），故只提示「读起来确实别扭才改」并给出 skip 出口。
 * 其余维度（complexity / modifierDensity / actionDensity）是明确的句式问题，不加此句，保持指令的直接性。
 */
const METRIC_HINT_SOFT = { abstractDensity: true, gapIndex: true, hedgeDensity: true };
const METRIC_HINT_SOFT_SUFFIX = "（仅当这里读起来确实别扭才改；抒情、心理、留白段落属正常写法，可标记 skip 保留。）";

/** v5.0.0 修正（降本）：取该维度的软化后缀（不属于上述三类则返回空串，hint 文案保持原样）。 */
function softSuffix(metric) {
  return METRIC_HINT_SOFT[metric] ? METRIC_HINT_SOFT_SUFFIX : "";
}

/**
 * v5.0.0：「情感过直」判定词表——程度副词 + 情绪词紧邻出现（中间只允许 0-2 字）。
 * 刻意只在「全章命中 ≥ 3 次」时才报：单次出现多半是正常行文（「她非常高兴地答应了」）。
 * 词表只覆盖"情绪被直接点名"的典型写法，不追求高召回（宁可少报，见文件头「不误报是硬要求」）。
 */
// v5.0.0：词表里曾同时列 "异常" 与 "异常地"，而正则交替左优先——"异常地" 永远匹配不到，属死条目（已删）。
// "异常地难过" 仍能经 "异常" + 允许的 1 个 "地" + "难过" 命中，行为不变。
const EMOTION_DEGREE_WORDS = ["非常", "十分", "极其", "极为", "无比", "格外", "特别", "相当", "异常", "万分", "分外"];
const EMOTION_WORDS = [
  "难过", "悲伤", "伤心", "痛苦", "悲哀", "高兴", "开心", "快乐", "愤怒", "生气", "恼怒",
  "恐惧", "害怕", "惊恐", "绝望", "失落", "孤独", "委屈", "激动", "紧张", "焦虑", "厌恶",
  "厌倦", "幸福", "甜蜜", "兴奋", "震惊", "愧疚", "羞愧", "心疼", "心酸", "沉重", "低落"
];
const EMOTION_DIRECT_RE = new RegExp(
  "(" + EMOTION_DEGREE_WORDS.join("|") + ")[的地得]?[^，。！？…\\n]{0,2}(" + EMOTION_WORDS.join("|") + ")",
  "g"
);
/** v5.0.0：全章至少命中这么多次「程度副词+情绪词」才认为本章情感直给（低于此视为正常行文，不报）。 */
const EMOTION_DIRECT_MIN_HITS = 3;

// ─────────────────────────────────────────────────────────────────────────────
// v5.0.0 通用工具（行号、段落索引、id、落盘）
// ─────────────────────────────────────────────────────────────────────────────

/** v5.0.0：清单落盘路径——<root>/.novel-writer/audits/fix-plan-<book>-<归一化章键>.json */
function planFilePath(root, book, chapterKey) {
  return join(novelDataDir(root), "audits", "fix-plan-" + book + "-" + chapterKey + ".json");
}

/** v5.0.0：章键归一（normalizeChapterKey）+ 路径安全清洗（chapterArg 可能含非法字符）。 */
function chapterKeyOf(chapterArg) {
  return sanitizeSegment(normalizeChapterKey(chapterArg), "chapter");
}

/** v5.0.0：稳定 id —— 「类型 + lineStart」派生（同一文本重复调用必得同一 id）。 */
function makeItemId(type, key, lineStart, lineEnd) {
  const slug = TYPE_SLUG[type] || "misc";
  const hash = createHash("sha1").update(type + "|" + key + "|" + lineStart + "|" + lineEnd).digest("hex").slice(0, 8);
  return "fix-" + slug + "-" + lineStart + "-" + hash;
}

/**
 * v5.0.0：行号索引。行号口径 1-based，与 novel_read/formatRead 一致；
 * 换行先归一到 \n（\r\n / \r 都算一个换行），这样「字符偏移 → 行号」与「行数组」永远同一个坐标系。
 */
function buildParagraphIndex(text) {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
  const rawLines = normalized.split("\n");
  const paras = [];
  let cur = null;
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i];
    const lineNo = i + 1;
    if (line.trim() === "") {
      if (cur) { paras.push(cur); cur = null; }
      continue;
    }
    if (!cur) cur = { lineStart: lineNo, lineEnd: lineNo, lines: [] };
    cur.lineEnd = lineNo;
    cur.lines.push(line);
  }
  if (cur) paras.push(cur);
  for (const p of paras) p.text = p.lines.join("\n").trim();
  return { text: normalized, rawLines, paras };
}

/** v5.0.0：字符偏移 → 行号（用于正则命中定位；偏移基于归一化后的 \n 文本）。 */
function lineOfOffset(rawLines, offset) {
  let acc = 0;
  for (let i = 0; i < rawLines.length; i += 1) {
    const len = rawLines[i].length;
    if (offset < acc + len) return i + 1;
    acc += len + 1; // +1 = 换行符
  }
  return rawLines.length;
}

/** v5.0.0：逐行找首个包含 needle 的行号（找不到返回 0）。字面类问题用它做**精确**定位。 */
function firstLineContaining(rawLines, needle) {
  if (!needle) return 0;
  for (let i = 0; i < rawLines.length; i += 1) {
    if (rawLines[i].includes(needle)) return i + 1;
  }
  return 0;
}

/** v5.0.0：取某行的原文（截 80 字）作为 excerpt；行号越界返回 ""。 */
function lineExcerpt(rawLines, lineNo) {
  if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > rawLines.length) return "";
  return rawLines[lineNo - 1].trim().slice(0, 80);
}

/** v5.0.0：组装一个 item（返回对象严格只含约定的 9 个字段；key/state 只在落盘文件里追加）。 */
function makeItem(type, key, locate, current, target, anchor, severity, effort, hint) {
  return {
    id: makeItemId(type, key, locate.lineStart, locate.lineEnd),
    type,
    locate: {
      lineStart: locate.lineStart,
      lineEnd: locate.lineEnd,
      excerpt: String(locate.excerpt ?? "").slice(0, 80)
    },
    current,
    target,
    anchor: anchor || "",
    severity: Math.max(1, Math.min(5, Math.round(severity))),
    effort: Math.max(1, Math.min(3, Math.round(effort))),
    hint
  };
}

/** v5.0.0：排序规则 —— severity 降序 → effort 升序 → lineStart 升序。 */
function sortItems(items) {
  return items.slice().sort((a, b) =>
    b.severity - a.severity ||
    a.effort - b.effort ||
    a.locate.lineStart - b.locate.lineStart ||
    String(a.id).localeCompare(String(b.id))
  );
}

/** v5.0.0：按 σ 距离给严重度（σ 越大越离谱：≥3σ → 5，≥2σ → 4，其余出带 → 3）。 */
function severityFromSigma(sigma) {
  const s = Math.abs(Number(sigma) || 0);
  if (s >= 3) return 5;
  if (s >= 2) return 4;
  return 3;
}

/** v5.0.0：读清单文件（不存在/损坏 → null，不抛错）。 */
async function readPlanFile(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// v5.0.0 容差口径说明（实现见 core.buildTolerance，本文件与开写包共用同一实现）：
// - 与 novel_style_check 的差别：用**排除本章后的基线**自身的推荐容差 recTol（作者自身章节波动的 1.5σ），
//   而不是「含本章的全书基线」——含本章时一个故意写坏的章节会把 σ 抬到 90%+，导致它自己反而不出带（改稿台就哑了）。
// - 小样本（基线 < 3 章）抬高下限到 25%，避免「只有两章的书」互相误报。

/** v5.0.0：按维度挑一条原著锚段（对照修正用；取不到返回 ""）。 */
function pickAnchor(anchors, metric) {
  if (!Array.isArray(anchors) || anchors.length === 0) return "";
  const prefer = metric === "hedgeDensity" ? ["心理", "描写", "对话"] : ["描写", "对话", "心理"];
  for (const label of prefer) {
    const hit = anchors.find((a) => a && a.label === label && typeof a.text === "string" && a.text.trim() !== "");
    if (hit) return hit.text;
  }
  const first = anchors.find((a) => a && typeof a.text === "string" && a.text.trim() !== "");
  return first ? first.text : "";
}

/**
 * v5.0.0：worldview 规则取值——与 novel_continuity_check（index.js）同口径：
 * bannedWords 与 speechStyle 各自取「最近登记且含该字段」的条目（后登记的 speechStyle 不得遮蔽先登记的禁用词表）。
 */
function worldviewRules(settings) {
  const list = Array.isArray(settings?.worldview) ? settings.worldview.filter((e) => e && typeof e === "object") : [];
  const reversed = list.slice().reverse();
  // v5.0.0：显式登记 bannedWords: []（用户明确"没有禁用词"）与"未登记"区分开
  const bannedEntry = reversed.find((e) => Array.isArray(e.bannedWords) && e.bannedWords.length > 0) ?? reversed.find((e) => Array.isArray(e.bannedWords)) ?? null;
  const speechEntry = reversed.find((e) => e.speechStyle && typeof e.speechStyle === "object") ?? null;
  return { bannedEntry, speechEntry };
}

// ─────────────────────────────────────────────────────────────────────────────
// v5.0.0 各类问题的判定（每类都遵循：判定不出 → 跳过，绝不猜）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v5.0.0：指标类问题（句式偏离 / 抽象度过高 / 留白异常）。
 * 归因策略：先看章级 judge 哪些维度出带；对每个出带维度，逐段跑 measureStyleMetrics，
 * 只收「该段自身也出带」的段落（复用 judgeAgainstBaseline，判定口径与章级完全一致），
 * 按 σ 距离取前几名。一个出带段落都没有时，退化成一条「全章层面」的 item（lineStart=lineEnd=0）。
 */
function collectMetricItems(judge, baseline, tol, index, anchors, notes) {
  const items = [];
  if (!judge || !baseline) return items;
  const { paras } = index;
  for (const v of judge.verdicts || []) {
    if (v.status !== "out") continue;
    const type = METRIC_TYPE[v.metric];
    if (!type) continue;
    // v5.0.0：量级门槛——相对偏差出带但绝对差值太小（读不出来）时忽略，避免「正常文本被报」的假阳性
    const minDelta = METRIC_MIN_DELTA[v.metric] ?? 0;
    const absDelta = typeof v.value === "number" && typeof v.mu === "number" ? Math.abs(v.value - v.mu) : Infinity;
    if (absDelta < minDelta) {
      if (notes) notes.push(METRIC_LABELS[v.metric] + " 虽出带但差值 " + (Math.round(absDelta * 100) / 100) + " < 门槛 " + minDelta + "，已按「无量级差异」忽略");
      continue;
    }
    const dir = (typeof v.value === "number" && typeof v.mu === "number" && v.value < v.mu) ? "low" : "high";
    const guide = METRIC_DIRECTION[v.metric]?.[dir] || "按基线方向微调该维度";
    const sev = severityFromSigma(v.sigma);
    const current = v.metric + " " + v.value;
    const target = typeof v.mu === "number" && v.mu > 0 ? baseline[v.metric].low + "~" + baseline[v.metric].high : "";
    const anchor = pickAnchor(anchors, v.metric);
    const devText = v.devPct === null || v.devPct === undefined ? "基线为 0，按绝对尺度判定" : (v.devPct > 0 ? "+" : "") + v.devPct + "%";
    const hits = [];
    for (const p of paras) {
      if (p.text.length < MIN_PARA_CHARS) continue;
      let m;
      try { m = measureStyleMetrics(p.text).metrics; } catch { continue; }
      if (typeof m[v.metric] !== "number" || !isFinite(m[v.metric])) continue;
      // v5.0.0：段落必须**与全章同向**偏离才算「这段是主要贡献者」——
      // 否则会出现「全章留白偏高，却指向一段根本不带省略号的文字」这种自相矛盾的定位（实测踩过）。
      if (dir === "high" ? !(m[v.metric] > v.mu) : !(m[v.metric] < v.mu)) continue;
      // 段落必须自己也出带
      let sub;
      try { sub = judgeAgainstBaseline(m, baseline, tol); } catch { continue; }
      const sv = (sub.verdicts || []).find((x) => x.metric === v.metric);
      if (!sv || sv.status !== "out") continue;
      hits.push({ p, value: m[v.metric], sigma: Math.abs(Number(sv.sigma) || 0) });
    }
    hits.sort((a, b) => b.sigma - a.sigma || String(a.p.lineStart).localeCompare(String(b.p.lineStart)));
    const top = hits.slice(0, MAX_PARAGRAPH_ITEMS_PER_METRIC);
    if (top.length > 0) {
      for (const h of top) {
        items.push(makeItem(
          type,
          v.metric,
          { lineStart: h.p.lineStart, lineEnd: h.p.lineEnd, excerpt: h.p.text.slice(0, 80) },
          current,
          target,
          anchor,
          sev,
          2, // v5.0.0：段落级问题只需改这一段 → 最容易改
          METRIC_LABELS[v.metric] + "偏离：全章 " + v.value + "（基线 " + v.mu + "，偏差 " + devText + "），本段 " + h.value + "。" + guide + "。只改这一段的写法，不要整章重写。" +
          softSuffix(v.metric)
        ));
      }
    } else {
      items.push(makeItem(
        type,
        v.metric,
        { lineStart: 0, lineEnd: 0, excerpt: "" },
        current,
        target,
        anchor,
        Math.max(1, sev - 1), // v5.0.0：无段落归因 → 无具体落点，严重度降一档
        3,
        METRIC_LABELS[v.metric] + "偏离：全章 " + v.value + "（基线 " + v.mu + "，偏差 " + devText + "）。" + guide + "。" +
        "该维度没有单段显著偏离，属**全章层面**的问题（本章各段写法普遍如此）——请按上面方向通读本章相关段落处理，不要只改一句。" +
        softSuffix(v.metric)
      ));
    }
  }

  // v5.0.0 修正（P1）：judge.verdicts **不含**「全书基线 μ=0」的维度——它们被 judgeAgainstBaseline 记进
  // skippedDims（相对判定不成立）。但恰恰是这些维度最该报警：作者全书从没用过省略号（gapIndex 基线恒为 0），
  // 某一章突然滥用省略号（实测 87.59）时，此前只遍历 verdicts 会**整类静默跳过**——最该报的场景反而漏了。
  // 这里对跳过的维度改按「绝对量级」兜底：只看是否超过 METRIC_MIN_DELTA。不给行号是刻意的：
  // 基线里该维度没有段落分布可比，按「宁可粗也不给错的行号」退化为全章层面。
  const skipped = (judge.skippedDims || []).filter((sk) => sk && METRIC_TYPE[sk.metric]);
  let skippedReported = 0;
  for (const sk of skipped) {
    const value = typeof sk.value === "number" ? sk.value : 0;
    const minDelta = METRIC_MIN_DELTA[sk.metric] ?? 0;
    if (Math.abs(value) < minDelta) continue; // 未过量级门槛 → 正常行文，不报（与 verdicts 分支同一道闸）
    skippedReported += 1;
    const dir = value > 0 ? "high" : "low";
    const guide = METRIC_DIRECTION[sk.metric]?.[dir] || "按基线方向微调该维度";
    items.push(makeItem(
      METRIC_TYPE[sk.metric],
      sk.metric,
      { lineStart: 0, lineEnd: 0, excerpt: "" },
      sk.metric + " " + value,
      "", // 基线 μ=0 → 相对容差带无意义（与 verdicts 分支里 target 的口径一致）
      pickAnchor(anchors, sk.metric),
      4, // 无 σ 可比，取固定严重度：全书从未出现过的写法突然大量出现，属明确异常
      3,
      METRIC_LABELS[sk.metric] + "异常：全书基线该维度恒为 0（从未出现过），本章却达到 " + value + "（量级门槛 " + minDelta + "）。" + guide + "。" +
      "该维度没有基线段落分布可比，属**全章层面**的问题——请通读本章相关段落处理，不要只改一句。" +
      softSuffix(sk.metric)
    ));
  }
  if (skipped.length > 0 && notes) {
    // 口径与 novel_style_check 对齐：跳过的维度必须披露，不能一边跳过一边宣称没问题
    notes.push("有 " + skipped.length + " 个维度全书基线恒为 0、不做相对判定（" + skipped.map((s) => s.label + "=" + s.value).join("、") + "）" +
      (skippedReported > 0 ? "；其中 " + skippedReported + " 个超过量级门槛，已按绝对量级报出" : "；均未超过量级门槛，按正常行文处理"));
  }
  return items;
}

/** v5.0.0：禁用词（worldview.bannedWords 是字符串数组，逐个在正文里扫）。 */
function collectBannedItems(bannedEntry, index) {
  const items = [];
  if (!bannedEntry || !Array.isArray(bannedEntry.bannedWords)) return items;
  const { rawLines } = index;
  const seen = new Set();
  for (const raw of bannedEntry.bannedWords) {
    const word = String(raw ?? "").trim();
    if (word === "" || seen.has(word)) continue; // 空串/重复词跳过（防脏数据刷屏）
    seen.add(word);
    const hits = [];
    for (let i = 0; i < rawLines.length; i += 1) if (rawLines[i].includes(word)) hits.push(i + 1);
    if (hits.length === 0) continue;
    const lineNo = hits[0];
    const rec = bannedEntry.recommended && typeof bannedEntry.recommended === "object" ? bannedEntry.recommended[word] : void 0;
    const culture = String(bannedEntry.name ?? "").trim() || "当前世界观";
    items.push(makeItem(
      "禁用词",
      "word:" + word,
      { lineStart: lineNo, lineEnd: lineNo, excerpt: lineExcerpt(rawLines, lineNo) },
      "命中「" + word + "」" + hits.length + " 处（首个在第 " + lineNo + " 行）",
      rec ? "改用「" + rec + "」" : "避免使用该词",
      "",
      4,
      rec ? 1 : 2,
      "「" + word + "」与世界观用语规范「" + culture + "」冲突（登记为禁用词）。" +
      (rec ? "设定表登记的替代词是「" + rec + "」，直接换词即可，不要改动句子结构。" : "请改用符合该世界观的表达；若确属情节需要（如外来人物口吻），保留但需有上下文支撑。")
    ));
  }
  return items;
}

/**
 * v5.0.0：语用不符（speechStyle：honorBad 客套禁词 / ritualBadPatterns 仪式禁式 / title 称谓规范）。
 * title 只在规范**明确禁用「小姐」**时才扫 XX小姐——与 novel_continuity_check 同口径，
 * 否则中式默认规范「小姐…可用」会被系统性误报（v3.9.5 修正过的坑，这里沿用）。
 */
function collectPragmaticItems(speechEntry, index) {
  const items = [];
  if (!speechEntry || !speechEntry.speechStyle) return items;
  const speech = speechEntry.speechStyle;
  const { text, rawLines } = index;
  const culture = String(speechEntry.name ?? "").trim() || "当前世界观";

  if (Array.isArray(speech.honorBad)) {
    const seen = new Set();
    for (const raw of speech.honorBad) {
      const word = String(raw ?? "").trim();
      if (word === "" || seen.has(word)) continue;
      seen.add(word);
      const lineNo = firstLineContaining(rawLines, word);
      if (lineNo === 0) continue;
      const rec = speech.honorGood && typeof speech.honorGood === "object" ? speech.honorGood[word] : void 0;
      items.push(makeItem(
        "语用不符",
        "honor:" + word,
        { lineStart: lineNo, lineEnd: lineNo, excerpt: lineExcerpt(rawLines, lineNo) },
        "客套禁词「" + word + "」（第 " + lineNo + " 行）",
        rec ? "改用「" + rec + "」" : "避免该类客套表达",
        "",
        4,
        rec ? 1 : 2,
        "「" + word + "」属「" + culture + "」说话方式规范里明确不用的客套表达（honorBad）。" +
        (rec ? "设定表登记的替代说法是「" + rec + "」。" : "请换成该世界观下人物的自然说法。") +
        "这是说法层面的替换，不要顺手改剧情。"
      ));
    }
  }

  if (Array.isArray(speech.ritualBadPatterns)) {
    for (const pattern of speech.ritualBadPatterns) {
      // v5.0.0：用户登记的非法正则/超长模式不崩工具（与 index.js 同一守卫）
      let regex = null;
      try { if (typeof pattern === "string" && pattern.length > 0 && pattern.length <= 200) regex = new RegExp(pattern, "g"); } catch { regex = null; }
      if (!regex) continue;
      let m = null;
      try { m = regex.exec(text); } catch { m = null; }
      if (!m) continue;
      const lineNo = lineOfOffset(rawLines, m.index);
      const sample = String(m[0]).slice(0, 20);
      items.push(makeItem(
        "语用不符",
        "ritual:" + pattern,
        { lineStart: lineNo, lineEnd: lineNo, excerpt: lineExcerpt(rawLines, lineNo) },
        "仪式禁式「" + sample + "」（第 " + lineNo + " 行）",
        "按仪式规范改写该处动作",
        "",
        4,
        2,
        "该处命中仪式类禁式（规范：" + (String(speech.ritualGoodNote ?? "").trim() || "见 worldview 设定") + "）。" +
        "请按规范改掉这个仪式动作/器物的写法；若这是反派或异文化人物的刻意行为，保留但要让读者看出是刻意的。"
      ));
    }
  }

  if (typeof speech.title === "string" && /不用.{0,8}小姐|小姐.{0,8}(禁用|不用)|禁用.{0,8}小姐|不称.{0,6}小姐/.test(speech.title)) {
    for (let i = 0; i < rawLines.length; i += 1) {
      const hit = rawLines[i].match(/[A-Za-z\u4e00-\u9fff]+小姐/g);
      if (!hit) continue;
      const lineNo = i + 1;
      items.push(makeItem(
        "语用不符",
        "title:sister",
        { lineStart: lineNo, lineEnd: lineNo, excerpt: lineExcerpt(rawLines, lineNo) },
        "称谓「" + String(hit[0]).slice(0, 12) + "」（第 " + lineNo + " 行）",
        "改用规范要求的称谓形式",
        "",
        3,
        2,
        "称谓规范要求：" + speech.title + "。请把「XX小姐」这类称谓换成规范里的形式（如 Miss+名）；" +
        "同一称谓在本章出现多处时，这里只标了第一处，请全章统一。"
      ));
      break; // v5.0.0：同一章只报一条称谓问题（第一处），细节里提示全章统一
    }
  }
  return items;
}

/** v5.0.0：情感过直——章内「程度副词+情绪词」命中 ≥ 3 次才报，且只在含命中的段落上定位。 */
function collectEmotionItems(index) {
  const items = [];
  const { rawLines, paras } = index;
  const perPara = [];
  let total = 0;
  for (const p of paras) {
    let count = 0;
    const re = new RegExp(EMOTION_DIRECT_RE.source, "g");
    let m;
    while ((m = re.exec(p.text)) !== null) {
      count += 1;
      if (re.lastIndex === m.index) re.lastIndex += 1; // 防零宽死循环（词表不会命中零宽，纯保险）
    }
    if (count > 0) { perPara.push({ p, count }); total += count; }
  }
  if (total < EMOTION_DIRECT_MIN_HITS) return items; // v5.0.0：低于阈值视为正常行文，不报
  perPara.sort((a, b) => b.count - a.count || a.p.lineStart - b.p.lineStart);
  for (const h of perPara.slice(0, 2)) {
    items.push(makeItem(
      "情感过直",
      "emotion:direct",
      { lineStart: h.p.lineStart, lineEnd: h.p.lineEnd, excerpt: h.p.text.slice(0, 80) },
      "情绪直陈 " + h.count + " 处（全章 " + total + " 处）",
      "",
      "",
      3,
      2,
      "这段把情绪直接说出来了（程度副词+情绪词）。改成用具体动作、身体反应或环境细节去承载同一种情绪，" +
      "让读者自己读出来；全章这类直陈共 " + total + " 处，建议一并压到 1 处以内。"
    ));
  }
  return items;
}

/** v5.0.0：衔接缺失——直接复用 detectChapterBridge（上一章 → 本章）的候选，转成 items。 */
async function collectBridgeItems(root, book, chapters, target, index, exec) {
  const items = [];
  const ti = chapters.findIndex((c) => c.file === target.file);
  if (ti <= 0) return items; // 第一章没有上一章可比对
  const prev = chapters[ti - 1];
  let cands = [];
  try {
    cands = await detectChapterBridge(root, book, prev.file, target.file, exec);
  } catch (e) {
    if (isAbort(e)) throw e; // v5.0.0：取消不是"检查失败"，继续上抛（见 core.isAbort）
    // v5.0.0：检查本身失败也必须让用户看见（不能静默等于"衔接正常"）
    cands = [{ type: "衔接·检查跳过", detail: "衔接检查执行失败：" + String(e?.message ?? e).slice(0, 120) }];
  }
  const { rawLines } = index;
  for (const c of cands) {
    const ctype = String(c?.type ?? "衔接");
    const detail = String(c?.detail ?? "");
    // 候选详情里的「XXX」往往就是命中的词（如「三天后」），用它做精确行定位；取不到就退回全章层面
    const quoted = (detail.match(/「([^」]{1,12})」/) || [])[1] || "";
    const lineNo = quoted ? firstLineContaining(rawLines, quoted) : 0;
    const severity = ctype.includes("时间跳跃") ? 4 : ctype.includes("检查跳过") ? 2 : 3;
    const effort = ctype.includes("时间跳跃") || ctype.includes("时间过渡") || ctype.includes("钩子未接") ? 1 : ctype.includes("检查跳过") ? 3 : 2;
    const direction = ctype.includes("时间跳跃")
      ? "在上一章结尾与本章开头之间补 1 句时间流逝/过渡（天色、季节、路程、状态的推移），不要把跳跃留给读者自行补全。"
      : ctype.includes("时间过渡")
        ? "软跳可接受：确认时间线读起来连贯即可，必要时补半句交代。"
        : ctype.includes("人物断线")
          ? "让上一章结尾在场的人物在本章开头有个承接动作或一句台词，再切到新场景。"
          : ctype.includes("语义距离")
            ? "本章开头补一句承上：点明与上一章结尾同一场景/同一情绪的接续关系。"
            : ctype.includes("钩子未接")
              ? "本章开头回应上一章结尾留下的悬念（哪怕只是人物提到它），确认是故意另起线再说明。"
              : "先排除读取/配置问题（章节文件、创作资料是否可读），再重跑衔接检查。";
    items.push(makeItem(
      "衔接缺失",
      "bridge:" + ctype,
      lineNo > 0 ? { lineStart: lineNo, lineEnd: lineNo, excerpt: lineExcerpt(rawLines, lineNo) } : { lineStart: 0, lineEnd: 0, excerpt: "" },
      ctype,
      "补过渡/承接句（1 句即可）",
      "",
      severity,
      effort,
      (detail.endsWith("。") || detail.endsWith("！") || detail.endsWith("？") ? detail : detail + "。") +
      (lineNo > 0 ? "" : "（该项没有可精确定位的行，属本章开头的整体衔接问题）") + direction
    ));
  }
  return items;
}

/** v5.0.0：从伏笔条目里取「最近一次提及」的章号（lastMentioned 存的是文件名，chapter 存登记时的章号）。 */
function plotMentionNumber(entry) {
  for (const raw of [entry?.lastMentioned, entry?.chapter]) {
    if (raw === void 0 || raw === null || String(raw).trim() === "") continue;
    const n = parseChapterNumber(String(raw));
    if (typeof n === "number" && isFinite(n)) return n;
  }
  return void 0;
}

/**
 * v5.0.0：伏笔未回收——openPlots 中「最近提及章号」距本章 ≥ PLOT_STALE_CHAPTERS(20) 章。
 * 无法解析章号（缺失/不是章号格式）的一律跳过：宁可漏报，也不把「距离未知」当成「超过阈值」。
 * 注意 readPlots 的条目没有 distance 字段（distance 是本模块按章号现推的派生量）。
 */
async function collectPlotItems(root, book, target, opts) {
  const items = [];
  const threshold = Number.isInteger(opts?.plotStaleChapters) && opts.plotStaleChapters > 0 ? opts.plotStaleChapters : PLOT_STALE_CHAPTERS;
  const baseNum = typeof target.number === "number" ? target.number : void 0;
  if (typeof baseNum !== "number") return items; // 章号解析不出 → 无法判距离
  let entries = [];
  try { entries = await readPlots(root, book); } catch { return items; }
  for (const entry of entries) {
    if (!entry || entry.status === "done") continue;
    const refNum = plotMentionNumber(entry);
    if (typeof refNum !== "number") continue;
    const distance = baseNum - refNum;
    if (distance < threshold) continue;
    const refLabel = String(entry.lastMentioned || entry.chapter || "第 " + refNum + " 章");
    const content = String(entry.content ?? "").replace(/\s+/g, " ").trim();
    const isHigh = entry.priority === "high";
    items.push(makeItem(
      "伏笔未回收",
      "plot:" + String(entry.id ?? content.slice(0, 12)),
      // v5.0.0：伏笔是跨章问题，正文里没有"哪一行"可指——按约定给 0/0，并在 hint 里说明是全章/跨章层面
      { lineStart: 0, lineEnd: 0, excerpt: "" },
      "未回收 " + distance + " 章（最近提及：" + refLabel + "）",
      "在近几章内回收或登记新进展",
      "",
      distance >= 40 || isHigh ? 4 : 3,
      3,
      "伏笔「" + content.slice(0, 40) + (content.length > 40 ? "…" : "") + "」自 " + refLabel + " 之后已过 " + distance +
      " 章仍未回收（阈值 " + threshold + " 章）。这是**跨章层面**的问题，正文里没有具体行可指——" +
      "请在本章或近 2 章内给它一个回收动作，或用 novel_plot update 登记本回收条件/新进展；确属长线伏笔可说明后忽略。"
    ));
  }
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// v5.0.0 主计算
// ─────────────────────────────────────────────────────────────────────────────

/** v5.0.0：空/不可用结果（保持字段齐全，调用方无需分支）。 */
function emptyResult(book, chapterArg, planFile, summary, chapterMeta) {
  return {
    book,
    chapter: chapterMeta || { file: String(chapterArg ?? ""), number: null, title: "" },
    items: [],
    summary,
    planFile
  };
}

/**
 * v5.0.0：核心计算。persist=false（verifyFixPlan 用）时只算不落盘。
 * 返回 { book, chapter, items（严格 9 字段）, summary, planFile, notes }
 */
async function computeFixPlan(root, book, chapterArg, opts, exec, persist) {
  const o = opts && typeof opts === "object" ? opts : {};
  const safeBook = sanitizeSegment(book, "book");
  // v5.0.0：先用原参数算一个**回退**文件名（早退路径不落盘，这个路径只作提示文字）。
  const fallbackKey = chapterKeyOf(chapterArg);
  let chapterKey = fallbackKey;
  let planFile = planFilePath(root, safeBook, fallbackKey);
  const dir = bookDir(root, safeBook);

  let chapters;
  try {
    chapters = await scanChapters(dir);
  } catch (e) {
    // v5.0.0：目录读不到（书名打错/未建目录）不抛裸错，但 summary 必须说清楚，
    // 不能让它看起来像「本章没有问题」——那会让用户以为已经检查通过。
    const reason = String(e?.message ?? e).slice(0, 200);
    return { ...emptyResult(safeBook, chapterArg, planFile, "无法读取作品目录，未做任何检查：" + reason), notes: [] };
  }
  if (chapters.length === 0) {
    return { ...emptyResult(safeBook, chapterArg, planFile, "作品「" + safeBook + "」下还没有章节文件（novels/" + safeBook + "/ 为空），无可检查内容。"), notes: [] };
  }

  let target;
  try {
    target = findChapter(chapters, chapterArg);
  } catch (e) {
    // findChapter 在「同章号多文件」时会拒绝（v4.3.1 P0 行为）——照实透出，用户才能改名/指定文件名
    return { ...emptyResult(safeBook, chapterArg, planFile, "无法确定要检查哪一章：" + String(e?.message ?? e).slice(0, 200)), notes: [] };
  }
  if (!target) {
    return {
      ...emptyResult(
        safeBook,
        chapterArg,
        planFile,
        "在作品「" + safeBook + "」中找不到章节「" + chapterArg + "」（可用 novel_chapters 查看章节列表）。",
        { file: String(chapterArg), number: null, title: "" }
      ),
      notes: []
    };
  }

  const chapterMeta = { file: target.file, number: typeof target.number === "number" ? target.number : null, title: String(target.title ?? "") };
  // v5.0.0 修正：清单文件名改用**解析后的章文件**归一，而不是调用方原样传的 chapterArg。
  // chapter="1" 与 chapter="第01章.md" 与 chapter="码头等船" 指向同一章；按原参数命名会落成多份清单，
  // 之后 verify/mark 换个写法就"看不到"刚生成的那一份（表现为清单神秘消失）。
  chapterKey = chapterKeyOf(target.file);
  planFile = planFilePath(root, safeBook, chapterKey);
  const targetText = await readTextFile(join(dir, target.file), exec);
  const others = chapters.filter((c) => c.file !== target.file);
  const baselineChapters = [];
  for (const ch of others) {
    try {
      baselineChapters.push({ file: ch.file, text: await readTextFile(join(dir, ch.file), exec) });
    } catch (e) {
      if (isAbort(e)) throw e; // v5.0.0：取消上抛，不当作"单章读失败"
      // v5.0.0：单章读失败不拖垮整次计算（该章不参与基线，summary 里披露数量差）
    }
  }

  const index = buildParagraphIndex(targetText);
  const notes = [];
  const items = [];
  // v5.0.0：章节正文过短（空章/占位章）不做指标类判定——空文本的六维全是 0，与基线一比必然"处处出带"，
  // 报出来是纯噪声（"全章 complexity 0"对作者毫无行动价值）。
  const tooShort = targetText.trim().length < MIN_PARA_CHARS;

  // ① 指标类（句式偏离 / 抽象度过高 / 留白异常）
  let judge = null;
  let baseline = null;
  let tol = {};
  try {
    const allCh = baselineChapters.concat([{ file: target.file, text: targetText }]);
    const perCh = await metricChaptersCached(root, safeBook, allCh);
    const excluding = perCh.filter((pc) => pc.file !== target.file);
    if (tooShort) {
      notes.push("本章正文不足 " + MIN_PARA_CHARS + " 字，指标类检查已跳过");
    } else if (excluding.length >= MIN_BASELINE_CHAPTERS) {
      baseline = computeBaselineFromPerChapter(excluding);
      let stateTolerance = null;
      try {
        const st = await readSentenceState();
        stateTolerance = st && typeof st.styleTolerance === "object" ? st.styleTolerance : null;
      } catch { stateTolerance = null; }
      tol = buildTolerance(baseline, excluding.length, o, stateTolerance);
      const targetMetrics = measureStyleMetrics(targetText).metrics;
      judge = judgeAgainstBaseline(targetMetrics, baseline, tol);
    } else if (excluding.length === 0) {
      notes.push("无基线：本章是全书唯一可测量的章节，指标类检查已跳过");
    } else {
      notes.push("基线只有 " + excluding.length + " 章（至少需要 " + MIN_BASELINE_CHAPTERS + " 章），无法估计作者自身波动，指标类检查已跳过");
    }
  } catch (e) {
    notes.push("六维测量失败，指标类检查已跳过：" + String(e?.message ?? e).slice(0, 80));
  }

  let anchors = [];
  if (baseline) {
    try {
      const pkg = await buildStyleAnchorPackage(root, safeBook, others, exec, baselineChapters);
      anchors = Array.isArray(pkg?.anchors) ? pkg.anchors : [];
    } catch (e) {
      if (isAbort(e)) throw e; // v5.0.0：取消上抛（锚段要逐章读正文，是取消最常打到的位置）
      anchors = [];
    } // 锚段失败不影响判定
  }

  items.push(...collectMetricItems(judge, baseline, tol, index, anchors, notes));

  // ② 设定表相关（禁用词 / 语用不符）——无设定表整类跳过（不做默认词表兜底，避免误报）
  let settings = null;
  try { settings = await readSettings(root, safeBook); } catch { settings = null; }
  const { bannedEntry, speechEntry } = worldviewRules(settings);
  if (bannedEntry) items.push(...collectBannedItems(bannedEntry, index));
  else notes.push("未登记 worldview 禁用词表，禁用词检查已跳过");
  if (speechEntry) items.push(...collectPragmaticItems(speechEntry, index));
  else notes.push("未登记 worldview.speechStyle，语用检查已跳过");

  // ③ 情感过直（纯文本判定，不依赖设定表）
  items.push(...collectEmotionItems(index));

  // ④ 衔接缺失（上一章 → 本章）
  items.push(...(await collectBridgeItems(root, safeBook, chapters, target, index, exec)));

  // ⑤ 伏笔未回收
  const plotItems = await collectPlotItems(root, safeBook, target, o);
  items.push(...plotItems);
  if (plotItems.length === 0) notes.push("无超过 " + (Number.isInteger(o?.plotStaleChapters) && o.plotStaleChapters > 0 ? o.plotStaleChapters : PLOT_STALE_CHAPTERS) + " 章未回收的伏笔");

  // ⑥ 排序 + 截断
  const maxItems = Number.isInteger(o?.maxItems) && o.maxItems > 0 ? o.maxItems : DEFAULT_MAX_ITEMS;
  const sorted = sortItems(items);
  const kept = sorted.slice(0, maxItems);
  if (sorted.length > kept.length) notes.push("待办超过 " + maxItems + " 条，已按严重度从高到低截断 " + (sorted.length - kept.length) + " 条（清单上限固定，先处理保留下来的高优先级项）");

  // ⑦ 摘要（落盘模式下附带「上次清单里已人工标记的条目数」——否则重新生成后看不到进度）
  let preservedCount = 0;
  if (persist !== false) {
    const prevPlan = await readPlanFile(planFile);
    const prevById = new Map((prevPlan?.items ?? []).map((it) => [it.id, it]));
    for (const it of kept) {
      const old = prevById.get(it.id);
      if (old && (old.state === "done" || old.state === "skip")) preservedCount += 1;
    }
  }
  const counts = new Map();
  for (const it of kept) counts.set(it.type, (counts.get(it.type) || 0) + 1);
  const countText = [...counts.entries()].map(([t, n]) => t + " ×" + n).join("、");
  const baselineScope = baseline ? "全书除本章外的 " + (baselineChapters.length) + " 章" : "无基线";
  const summary = (kept.length === 0
    ? "改稿台：未发现需要处理的项（0 项待办）。基线：" + baselineScope + "。"
    : "改稿台：共 " + kept.length + " 项待办（严重度降序 → 难度升序）。" + countText + "。基线：" + baselineScope + "。"
      + (preservedCount > 0 ? "其中 " + preservedCount + " 项此前已人工标记 done/skip（状态已保留）。" : ""))
    + (notes.length > 0 ? " 备注：" + notes.join("；") + "。" : "");

  const result = {
    book: safeBook,
    chapter: chapterMeta,
    items: kept,
    summary,
    planFile,
    notes,
    baselineScope
  };

  // ⑧ 落盘（保留人工 done/skip 状态；withFileTx + atomicWriteJson 保证并发安全）
  if (persist !== false) {
    try {
      await mkdir(dirname(planFile), { recursive: true });
      await withFileTx(planFile, async () => {
        const prev = await readPlanFile(planFile);
        const prevById = new Map((prev?.items ?? []).map((it) => [it.id, it]));
        const records = kept.map((it) => {
          const old = prevById.get(it.id);
          const state = old && (old.state === "done" || old.state === "skip") ? old.state : "open";
          return { ...it, state, stateAt: state === "open" ? null : (old?.stateAt ?? null) };
        });
        await atomicWriteJson(planFile, {
          tool: "novel_fix_plan",
          version: "5.0.0",
          book: safeBook,
          chapter: chapterMeta,
          chapterKey,
          generatedAt: new Date().toISOString(),
          baselineScope,
          summary,
          notes,
          items: records
        });
      });
    } catch (e) {
      const why = String(e?.message ?? e).slice(0, 120);
      notes.push("清单落盘失败：" + why + "（本次结果仅内存返回）");
      // v5.0.0 修正：落盘失败必须透出到 summary。summary 在上面（落盘之前）就已拼好，而 buildFixPlan
      // 只返回 book/chapter/items/summary/planFile —— 失败原因只进 notes 会被整条丢弃，
      // 调用方拿到的是「成功 + 一个并不存在的 planFile 路径」，要到后续 mark/verify 才暴露。
      result.summary = result.summary + "（注意：清单落盘失败，" + why + "；planFile 指向的文件不存在，verify/mark 将无法使用）";
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// v5.0.0 对外 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v5.0.0：生成/刷新改稿清单。
 * @param {string} root 章节库根目录
 * @param {string} book 书名
 * @param {string} chapterArg 章节（章号/文件名/标题）
 * @param {object} [opts] { tolerance, maxItems, plotStaleChapters }
 * @param {object} [exec] 宿主执行上下文（转发 signal / cwd）
 * @returns {Promise<{book:string, chapter:{file:string,number:number|null,title:string}, items:Array, summary:string, planFile:string}>}
 */
export async function buildFixPlan(root, book, chapterArg, opts, exec) {
  const r = await computeFixPlan(root, book, chapterArg, opts, exec, true);
  return { book: r.book, chapter: r.chapter, items: r.items, summary: r.summary, planFile: r.planFile };
}

/**
 * v5.0.0：对当前正文重算，并与上次落盘的清单逐项比对。
 * 匹配分两轮：① id 精确命中（文本未动时）；② 同 type 未配对项（行号已变但问题同类）→ 仍判 pending。
 * 状态口径：resolved=该问题在当前正文中查不到了；pending=仍在；new=本次新检出。
 * 人工标记（done/skip）不改变判定，只写进 detail，避免"标了完成但问题还在"被静默吞掉。
 */
export async function verifyFixPlan(root, book, chapterArg, opts, exec) {
  const safeBook = sanitizeSegment(book, "book");
  // v5.0.0 修正：先算再读。computeFixPlan 返回的 planFile 用的是**已解析章文件**归一后的名字
  // （见 computeFixPlan 内注释），所以这里必须以它的返回值为准，否则
  // verify(chapter="码头等船") 会去读 plan(chapter="1") 没写过的那份文件，误报"尚未生成清单"。
  const fresh = await computeFixPlan(root, safeBook, chapterArg, opts, exec, false);
  const planFile = fresh.planFile;
  const saved = await readPlanFile(planFile);
  const oldItems = saved?.items ?? [];
  const nowItems = fresh.items ?? [];
  const nowById = new Map(nowItems.map((it) => [it.id, it]));
  const usedNow = new Set();
  const checked = [];

  // 第一轮：id 精确命中
  const unmatchedOld = [];
  for (const o of oldItems) {
    if (nowById.has(o.id)) {
      usedNow.add(o.id);
      // v5.0.0 修正：人工标记必须在这里也显示。正文没动时 id 必然精确命中，第二轮（按 type 兜底）
      // 根本不会走到——旧实现只在第二轮拼 mark，于是"标了 done 但问题还在"在复测里看不出被标过。
      const marked = o.state === "done" || o.state === "skip" ? "（人工标记 " + o.state + "）" : "";
      checked.push({ id: o.id, type: o.type, status: "pending", detail: "问题仍存在：" + nowById.get(o.id).current + marked });
    } else {
      unmatchedOld.push(o);
    }
  }
  // 第二轮：同 type + 同 key 兜底（正文行号变了但问题同类 → 仍算 pending，只在 detail 里说明位置变化）
  for (const o of unmatchedOld) {
    const cand = nowItems.find((n) =>
      !usedNow.has(n.id) &&
      n.type === o.type &&
      String(n.current ?? "") === String(o.current ?? "")
    ) || nowItems.find((n) => !usedNow.has(n.id) && n.type === o.type);
    const mark = o.state === "done" || o.state === "skip" ? "（人工标记 " + o.state + "）" : "";
    if (cand) {
      usedNow.add(cand.id);
      checked.push({
        id: o.id,
        type: o.type,
        status: "pending",
        detail: "问题仍存在（位置/数值已变化 → 现为第 " + (cand.locate?.lineStart ?? 0) + " 行：" + cand.current + "）" + mark
      });
    } else {
      checked.push({
        id: o.id,
        type: o.type,
        status: "resolved",
        detail: "当前正文中已检不出该问题（已修复或该处文本已改动）" + mark
      });
    }
  }
  // 第三轮：本次新增
  for (const n of nowItems) {
    if (usedNow.has(n.id)) continue;
    checked.push({ id: n.id, type: n.type, status: "new", detail: "本次新检出：" + n.current });
  }

  const resolved = checked.filter((c) => c.status === "resolved").length;
  const pending = checked.filter((c) => c.status === "pending").length;
  const added = checked.filter((c) => c.status === "new").length;
  const summary = saved === null
    ? "未找到已落盘的改稿清单（" + planFile + "）——本次按当前正文现算：" + pending + " 项待办、" + added + " 项新检出。请先调用 buildFixPlan 生成清单。"
    : "复测结果：已解决 " + resolved + " 项 / 仍待处理 " + pending + " 项 / 新检出 " + added + " 项。";

  return { book: fresh.book, chapter: saved?.chapter ?? fresh.chapter, checked, summary };
}

/**
 * v5.0.0：人工标记单项状态（done=已改 / skip=跳过不改），写回清单文件。
 * @returns {Promise<{ok:boolean, item:object}>}
 */
export async function markFixItem(root, book, chapterArg, itemId, state, opts, exec) {
  if (state !== "done" && state !== "skip") {
    throw new Error('markFixItem 的 state 只能是 "done"（已改）或 "skip"（跳过不改），收到：' + String(state));
  }
  if (typeof itemId !== "string" || itemId.trim() === "") {
    throw new Error("markFixItem 的 itemId 不能为空（可用 buildFixPlan/verifyFixPlan 返回的 id）");
  }
  const safeBook = sanitizeSegment(book, "book");
  // v5.0.0 修正：与 buildFixPlan 同口径——把 chapterArg 解析成具体章文件后再归一，
  // 否则用"章标题"标记、用"章号"生成的清单会互相看不见。
  let chapterKey = chapterKeyOf(chapterArg);
  try {
    const chapters = await scanChapters(bookDir(root, safeBook));
    const t = findChapter(chapters, chapterArg);
    if (t && typeof t.file === "string" && t.file !== "") chapterKey = chapterKeyOf(t.file);
  } catch {
    // 目录读不到 / 章号重号：回退到归一化原参数（下面读不到清单会给出明确报错）
  }
  const planFile = planFilePath(root, safeBook, chapterKey);
  const id = itemId.trim();
  let savedItem = null;
  await withFileTx(planFile, async () => {
    const plan = await readPlanFile(planFile);
    if (!plan) {
      throw new Error("尚未生成改稿清单（" + planFile + "）——请先调用 buildFixPlan，再标记条目状态。");
    }
    const idx = plan.items.findIndex((it) => it && it.id === id);
    if (idx < 0) {
      throw new Error("改稿清单中找不到 itemId=\"" + id + "\"（清单共 " + plan.items.length + " 项，可能已重新生成）——请重新 buildFixPlan 后再标记。");
    }
    const at = new Date().toISOString();
    plan.items[idx] = { ...plan.items[idx], state, stateAt: at };
    plan.updatedAt = at;
    await atomicWriteJson(planFile, plan);
    savedItem = plan.items[idx];
  });
  return { ok: true, item: savedItem };
}
