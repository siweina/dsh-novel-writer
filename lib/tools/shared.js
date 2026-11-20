/**
 * dsh-novel-writer — lib/tools/shared.js（工具层共享纯辅助函数）
 *
 * 严格单向底座：可被各领域工具模块引用，严禁导入其它 lib/tools/*.js 模块。
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import * as embedding from "../embedding.js";
import { assert, cropEmotion, featureEnabled, readSentenceStateSync, semanticFeatureEnabled } from "../core.js";

// ---- v4.3.0 修复：开关裁剪 / 候选截断 / 分析报告缓存上限 ----

/**
 * v4.3.0：按 emotionCaveat / emotionComplexity 两个**互不牵连**的开关裁剪情感块。
 * 旧版直接调 core.js 的 cropEmotion（其返回体只有 dominant/scores/intensity/topWords/curve），
 * 于是 emotionCaveat=false 会把 quantification 一并剥掉，紧随其后的
 * `if (!emotionComplexity && emotion.quantification)` 恒为假——"关净化预警"连带杀掉了"情感量化"。
 * core.js 不在本次改动白名单内，故在裁剪前留存 quantification，再单独按 emotionComplexity 决定去留。
 */
function cropEmotionByFeatures(state, emotion) {
  if (!emotion) return emotion;
  if (featureEnabled(state, "emotionCaveat")) {
    // 净化开关为开：只在量化开关关闭时剔除 quantification（不重建对象，避免丢字段）
    if (!featureEnabled(state, "emotionComplexity")) delete emotion.quantification;
    return emotion;
  }
  const quantification = emotion.quantification;
  const cropped = cropEmotion(emotion);
  if (featureEnabled(state, "emotionComplexity") && quantification !== void 0) cropped.quantification = quantification;
  return cropped;
}

// ---- v4.3.0：语义缓存判据统一 + 语义风格空表文案细分 ----

/**
 * v4.3.0：语义门控——把"用户明确关闭语义功能"与"语义引擎瞬时不可用"两种不可用分开。
 * 判据（与 novel_style_report 既有实现逐字一致）：keepCached === (semOn && !engineReady)。
 *   semOn       用户是否仍开启语义隐性情感（semanticImplicit，含 semanticEmbedding 总开关）
 *   engineReady 引擎此刻是否可用（瞬时态：模型加载失败 / 30s 冷却窗口内为 false，恢复后仍可用）
 *   embOk       本次可做新推理（semOn && engineReady）
 *   keepCached  命中缓存时必须原样复用缓存里的 semanticImplicit / implicitResolved，
 *               并且**不得**把"清空后的结果"写回缓存——只有"用户没关、引擎却暂时起不来"才为真。
 *               v4.3.0 之前 novel_sentence_analysis 的命中路径没有这个区分，只要引擎此刻不可用
 *               就把缓存里的 semanticImplicit 抹成 null，恢复后要重跑 29 次原型推理 + 全索引检索。
 */
async function semanticGate(state) {
  const semOn = semanticFeatureEnabled(state, "semanticImplicit");
  const engineReady = semOn ? await embedding.isAvailable() : false;
  return { semOn, engineReady, embOk: semOn && engineReady, keepCached: semOn && !engineReady };
}

/**
 * v4.3.0：语义风格距离为空时的报告文案——按 lib/vibe.js semanticStyleDistances() 挂在返回数组上的
 * **非枚举** reason 区分失败通道（实测取值：no-engine / no-chunks / proto-embed-failed /
 * chunk-embed-failed / error / ok，另有"函数未运行"时该属性缺失）。
 * 旧版一律打印"（语义引擎不可用，跳过）"：引擎其实可用、只是本书太短或原型向量失败时误导用户。
 * reason 缺失或无法识别 → 回退旧通用文案（保持健壮）。文案面向作者、保留"跳过"语义、不暴露技术细节。
 */
function semanticSkipText(reason) {
  switch (reason) {
    case "not-run": return "（语义风格距离未启用，已跳过）";
    case "no-engine": return "（语义引擎不可用，语义风格距离已跳过）";
    case "no-chunks": return "（本书文本太短，分不出语义段落，语义风格距离已跳过）";
    case "proto-embed-failed": return "（风格原型向量生成失败，语义风格距离已跳过）";
    case "chunk-embed-failed": return "（本书段落向量生成失败，语义风格距离已跳过）";
    case "error": return "（语义风格距离计算失败，已跳过）";
    case "ok": return "（本次未得到可比对的风格距离，已跳过）";
    default: return "（语义引擎不可用，跳过）"; // 原因缺失/未知：保持 v4.3.0 旧文案
  }
}

/** v4.3.0：连贯性审计候选的章节列表统一上限（人物缺失/缺场早已 slice(0,5)，其余几路漏了）。 */
const CANDIDATE_CHAPTER_LIMIT = 5;
/**
 * v4.3.0：截断候选章节列表并给出 disclosure 文案——旧版用语/客套/仪式/称谓四路把全书章节名
 * 全部塞进候选，几百章的书输出与落盘报告爆长（同函数内"人物缺失"已截断，口径不一致）。
 */
function capCandidateChapters(files) {
  const list = Array.isArray(files) ? files : [];
  return {
    chapters: list.slice(0, CANDIDATE_CHAPTER_LIMIT),
    note: list.length > CANDIDATE_CHAPTER_LIMIT ? `（共 ${list.length} 章，仅列前 ${CANDIDATE_CHAPTER_LIMIT}）` : ""
  };
}

/**
 * v4.3.0：分析报告缓存上限。缓存键含内容哈希与全部参数，每次改稿都会生成新文件，
 * 旧版既无 TTL 也无份数上限，<root>/.novel-writer/analysis 会无限膨胀。
 * 写入后按"书前缀"只保留最近 REPORT_CACHE_KEEP 份（按 mtime 降序，思路同 core.js reports 路由）。
 * 注意 <书>-full.json / <书>-chapters-metrics.json 是分析缓存（非报告），匹配不到、不会被删。
 */
const REPORT_CACHE_KEEP = 20;
async function pruneAnalysisReports(dir, book, kind) {
  try {
    const prefix = book + "-";
    const isReport = kind === "keywords"
      ? (name) => name.startsWith(prefix + "keywords-") && name.endsWith(".json")
      // v6.2.0 修正（旧清单第 10 条）：补「本前缀」校验——旧判据只看书名长度之后是不是 20 位十六进制，
      // 书名等长时会命中他书的报告文件，把两本书的缓存预算混在一起（删掉仍在用的缓存）。
      : (name) => name.startsWith(prefix) && /^[0-9a-f]{20}\.json$/.test(name.slice(prefix.length));
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !isReport(entry.name)) continue;
      try { files.push({ name: entry.name, mtime: (await stat(join(dir, entry.name))).mtimeMs }); } catch { /* 统计失败：忽略该文件 */ }
    }
    if (files.length <= REPORT_CACHE_KEEP) return;
    files.sort((a, b) => b.mtime - a.mtime);
    for (const stale of files.slice(REPORT_CACHE_KEEP)) {
      try { await rm(join(dir, stale.name), { force: true }); } catch { /* 删除失败留待下次清理 */ }
    }
  } catch { /* 目录不存在/不可读不阻塞主流程 */ }
}

/**
 * v5.0.0：把对象里值为 null/undefined 的键**整键丢弃**（递归，数组内的 null 元素也剔除）。
 *
 * 存在的理由：DSH 宿主的输出 schema **不支持 type 数组**（e2e 有硬断言"type 必须是单字符串"），
 * 因此"可能没有值"的数字字段无法写成 `type: ["number","null"]`；而契约校验里
 * `typeOk(null, "number") === false`，直接返回 null 会被判成违反输出契约。
 * 约定：**未知就省略该键**，而不是置 null —— 渲染层用 `?? "?"` 兜底显示。
 */
function dropNullDeep(value) {
  if (Array.isArray(value)) return value.map(dropNullDeep).filter((v) => v !== null && v !== void 0);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (v === null || v === void 0) continue;
      out[key] = dropNullDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * v5.0.0（降本）：精简工作流开关。true 时注入 LEAN_TEXT、报告类工具默认走精简输出。
 * 状态字段由 core.js 持久化（缺省/非法值一律 false），这里只做只读判断。
 */
function isLeanWorkflow() {
  try { return readSentenceStateSync()?.leanWorkflow === true; } catch { return false; }
}

// v7.3.5（③ 连带收口）：`deleteResultFor` 的默认值是为了满足「输出 schema additionalProperties:false
// 要求所有键常驻」，但它同时**掩盖了漏填**——7.3.4 那条「目标已达成」分支就是漏填了
// remaining/partial/skipped，静默回退成 { 0, 0 } / false / []，把「盘上还有内容」报成「什么都没剩」。
// 所以对**破坏性动作的返回体**（action="apply"）改成 fail-closed：必填键必须由调用方显式给出。
// 为什么只约束 apply：preview / list / restore / purge 的默认值语义就是"没有"（它们不产生副作用），
// 而 apply 的这几个键是**执行结果的账**，回退默认值等于说谎。
const APPLY_REPORT_REQUIRED_KEYS = ["targets", "totals", "warnings", "notTouched", "keys", "skipped", "partial", "failed", "remaining", "message"];
function deleteResultFor(action, patch) {
  if (action === "apply") {
    const provided = patch && typeof patch === "object" ? patch : {};
    const missing = APPLY_REPORT_REQUIRED_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(provided, key));
    assert(missing.length === 0, "deleteResultFor(\"apply\") 漏填必填键：" + missing.join(" / ")
      + "——这些键会静默回退成默认值（曾因此把「还有未选中内容」报成 remaining 0 / partial false）。"
      + "破坏性动作的执行账必须如实，请显式传全：" + APPLY_REPORT_REQUIRED_KEYS.join(" / "));
  }
  // 输出 schema 是 additionalProperties:false：所有键必须常驻（缺键＝违反输出契约），故给全默认值
  return {
    action,
    book: "",
    safeBook: "",
    found: false,
    blocked: false,
    blockedReason: "",
    targets: [],
    totals: { files: 0, bytes: 0 },
    warnings: [],
    notTouched: [],
    trash: [],
    trashId: "",
    trashDir: "",
    moved: 0,
    keys: [],
    skipped: [],
    partial: false,
    profileRemoved: false,
    profileRestored: false,
    restored: 0,
    conflicts: [],
    failed: [],
    remaining: { files: 0, bytes: 0 },
    purged: false,
    message: "",
    ...patch
  };
}

export {
  CANDIDATE_CHAPTER_LIMIT,
  REPORT_CACHE_KEEP,
  APPLY_REPORT_REQUIRED_KEYS,
  cropEmotionByFeatures,
  semanticGate,
  semanticSkipText,
  capCandidateChapters,
  pruneAnalysisReports,
  dropNullDeep,
  isLeanWorkflow,
  deleteResultFor
};
