/**
 * v6.6.5 情感复杂度「可采信性」回归套件 —— 钉住用户反馈「第一章的情感复杂度会直接爆掉」的真凶。
 *
 * ## 被钉住的契约（v6.6.5）
 *
 * `emotion.quantification.complexity`：
 *   · `level` ∈ {low, medium, high, unknown}；**不可采信时必须是 "unknown"**，不再给顶格 high
 *   · `reliable: boolean` —— 结论是否可采信
 *   · `reliabilityNote: string` —— 不可采信时的固定说明；可采信时为空串
 *   · `score` 保留数值（不置 null）
 * 触发「不可采信」的两类：
 *   · 污染：R18/生理 ≥ 1.5‰ 或 战斗/爽文 ≥ 3‰ 或 恐怖/疯狂 ≥ 3‰（既有阈值，本套件不重测）
 *   · 无数据：全文零情感词命中
 * 渲染层（lib/core.js 的【情感量化】段）：
 *   · 必须出现 `- 复杂度: <score>（<level>）熵 X/Y，多样性 N…`
 *   · `reliable === false` 时必须**另起一行**输出 reliabilityNote
 *
 * ## 真凶（为什么本套件里必须有渲染层断言）
 *
 * 旧版渲染是 `JSON.stringify(q.complexity).slice(0, 120)`，而 `reliable` / `reliabilityNote`
 * 排在对象**末尾** —— 120 字符必然截掉，「本项不可采信」永远到不了发给模型的文本。
 * 所以**只断言 value 层是不够的**：value 修好了、渲染层没修，用户看到的仍然是一个 high。
 * 本套件因此同时钉 value（①–⑤）与 render（⑥），并保留一条"旧渲染必然丢失警告"的机械证明。
 *
 * ## 隔离（本会话早前踩过的坑）
 *
 * `DSH_NOVEL_WRITER_STATE`、`DSH_HOME` 都指向临时目录，**书库根也用临时目录**（显式传
 * config.root + 每次调用传 args.root）。分析缓存落在 `<临时书库根>/.novel-writer/analysis/`，
 * 因此不会撞上用户真实缓存（CACHE_VERSION = PLUGIN_VERSION 意味着跨版本也不会失效）。
 * 每个夹具书都是独立目录 + `fresh: true`，不在同一本书上改文本重跑（那会命中旧缓存）。
 * 最后一条测试把用户**真实** state.json 与真实 logs/ 与开跑前对比。
 *
 * ## 期望值口径
 *
 * 一律现算：污染密度自己数字符/数词频，等级集合自己收集，不用实现里的数字当期望。
 * 唯一"照抄实现阈值"的是 0.6（high 档下界）—— 那是**为了证明本夹具在旧实现下真的会顶格 high**，
 * 见 ①-c 的注释。
 *
 * 运行：node test/emotion-reliability-test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// ===========================================================================
// 隔离夹具：先设 env，再动态 import（静态 import 会先于模块体求值）
// ===========================================================================

const ROOT = join(tmpdir(), "dsh-emotion-reliability-" + process.pid + "-" + Date.now().toString(36));
/** 书库根（含 novels/）——**临时**，不碰用户真实书库 */
const LIB = join(ROOT, "lib-root");
const STATE_DIR = join(ROOT, "state-dir");
const STATE = join(STATE_DIR, "state.json");
const REAL_STATE = join(homedir(), ".dsh", "dsh-novel-writer", "state.json");
const REAL_LOG_DIR = join(homedir(), ".dsh", "dsh-novel-writer", "logs");

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(LIB, "novels"), { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(join(ROOT, "dsh-home"), { recursive: true });
process.env.DSH_NOVEL_WRITER_STATE = STATE;
process.env.DSH_HOME = join(ROOT, "dsh-home");
process.on("exit", () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

// 隔离守卫：开跑前的真实用户侧快照
const guardBefore = { state: fileDigest(REAL_STATE), logs: dirDigest(REAL_LOG_DIR) };
function fileDigest(path) {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; }
}
function dirDigest(path) {
  try {
    return readdirSync(path).sort().map((name) => {
      try { return name + ":" + statSync(join(path, name)).size; } catch { return name + ":?"; }
    }).join("|");
  } catch { return null; }
}

const { apply } = await import("../lib/index.js");
const { emotionComplexity, emotionalQuantification } = await import("../lib/analysis.js");

// ===========================================================================
// 夹具文本
// ===========================================================================

/**
 * 污染夹具：R18/生理词**远超** 1.5‰ 阈值（目标每千字 80+ 次）。
 * 情感词本身分布很"丰富"（五类齐上、几乎均等）——正是这样才会算出顶格 score，
 * 也正是用户看到的那个「爆掉」的形态：结论很响，而它建立在被污染的词频上。
 */
const R18_WORDS = ["做爱", "呻吟", "高潮", "射精", "爱液", "淫荡", "裸体", "口交", "插入", "抽插"];
const POLLUTED_TEXT = [
  "# 第01章 雨夜",
  "",
  "她感到幸福，也感到愤怒；她悲伤，她恐惧，她震惊。",
  "做爱。呻吟。高潮。射精。爱液。淫荡。裸体。口交。",
  "她感到幸福，也感到愤怒；她悲伤，她恐惧，她震惊。",
  "呻吟。插入。抽插。做爱。高潮。",
  "她感到幸福，也感到愤怒；她悲伤，她恐惧，她震惊。",
  ""
].join("\n");

/** 无数据夹具：零情感词（结构完整、句读正常，只是没有任何情绪词）。 */
const NODATA_TEXT = [
  "# 第01章 晨间",
  "",
  "他拿起杯子，喝了一口水。",
  "她把窗推开，看了看天。",
  "他拿起杯子，喝了一口水。",
  "她把窗推开，看了看天。",
  ""
].join("\n");

/**
 * 正常夹具（防过度降级）：无污染、情感词分布正常，且刻意造出 low / medium / high 三档，
 * 用来证明「不是把所有书一刀切成 unknown」。
 *   单调：只有喜，熵≈0 → low
 *   混杂：喜 + 哀，主次接近 → medium
 *   均衡：五类各一 → high
 */
const NORMAL_LOW_TEXT = ["# 第01章 单调", "", "她无比幸福。", "她无比幸福。", "她无比幸福。", "她无比幸福。", ""].join("\n");
const NORMAL_MEDIUM_TEXT = ["# 第01章 混杂", "", "她心里踏实，觉得幸福。", "他想起往事，心里一阵心酸。", "她说起那年冬天，眼里带着温暖。", "他沉默了很久，终究还是觉得苦涩。", ""].join("\n");
const NORMAL_HIGH_TEXT = ["# 第01章 均衡", "", "她感到幸福。", "他满腔愤怒。", "她心里悲伤。", "他感到恐惧。", "她感到震惊。", ""].join("\n");
/** 仅弱词夹具（已知偏差用，见 ⑦）：弱词不进 clean → complexity 拿不到分章数据 */
const WEAK_ONLY_TEXT = ["# 第01章 弱词", "", "她有点高兴。", "他有些担心。", ""].join("\n");

const BOOKS = {
  污染书: POLLUTED_TEXT,
  无数据书: NODATA_TEXT,
  单调书: NORMAL_LOW_TEXT,
  混杂书: NORMAL_MEDIUM_TEXT,
  均衡书: NORMAL_HIGH_TEXT,
  弱词书: WEAK_ONLY_TEXT
};
for (const [book, text] of Object.entries(BOOKS)) {
  mkdirSync(join(LIB, "novels", book), { recursive: true });
  writeFileSync(join(LIB, "novels", book, "第01章.md"), text, "utf8");
}

// ===========================================================================
// 走真实 apply() 注册的真工具（不直连内部函数）
// ===========================================================================

const registry = [];
const ctx = {
  tools: { register: (def) => { registry.push(def); return () => {}; } },
  systemPrompt: { section: () => () => {} },
  inject: (names, cb) => cb({ webServer: { register: () => () => {} }, effect: (fn) => fn() })
};
apply(ctx, { root: LIB, sentenceAnalysis: { enabled: true, autoAnalyze: false } });
const defs = Object.fromEntries(registry.map((def) => [def.name, def]));
const exec = { agent: { session: { header: { cwd: LIB } } } };
// 语义引擎与本题无关：关掉以固定成本（也避免引擎缺失/存在造成的环境差异）
await defs.novel_sentence_config.execute({ action: "set", features: { semanticEmbedding: false } }, exec);

const ALL_LEVELS = ["low", "medium", "high", "unknown"];
const seenLevels = new Set();

/**
 * 跑一次真实分析并取渲染文本。
 * 一律 `fresh: true` + 每本书独立目录：绝不在同一本书上改文本重跑（会命中旧缓存，测到旧结果）。
 */
async function runAnalysis(book) {
  const out = await defs.novel_sentence_analysis.execute({ book, root: LIB, fresh: true }, exec);
  const text = (defs.novel_sentence_analysis.output.render({}, out) || []).map((part) => part.text ?? "").join("\n");
  const cx = out?.emotion?.quantification?.complexity;
  assert.ok(cx && typeof cx === "object", `${book}：没有 emotion.quantification.complexity（量化被裁掉了？）`);
  seenLevels.add(cx.level);
  return { out, text, cx, emotion: out.emotion };
}

/** 复杂度渲染行（真凶所在的那一行） */
function complexityLine(text) {
  const lines = String(text).split("\n");
  const index = lines.findIndex((line) => line.startsWith("- 复杂度: "));
  return { lines, index, line: index >= 0 ? lines[index] : null };
}

/** 自算：某组词在文本里的出现次数（含重叠计法 = 逐次 indexOf 前进一个词长，与实现同口径但不复用实现） */
function countOccurrences(text, words) {
  let total = 0;
  for (const word of words) {
    let from = 0;
    while (from <= text.length - word.length) {
      const at = text.indexOf(word, from);
      if (at === -1) break;
      total += 1;
      from = at + word.length;
    }
  }
  return total;
}

// ===========================================================================
// ① 污染场景：置信度 low → 复杂度必须 unknown（核心）
// ===========================================================================

test("① 污染场景：confidence=low 时 complexity 不得给出顶格 high", async () => {
  // 前置：自算污染密度，确认本夹具真的远超 1.5‰（不信实现给的数字）
  const hits = countOccurrences(POLLUTED_TEXT, R18_WORDS);
  const density = (hits / POLLUTED_TEXT.length) * 1000;
  assert.ok(hits >= 10, "夹具自身前提：R18 词命中应 ≥10 次，实际 " + hits);
  assert.ok(density >= 8, "夹具自身前提：自算 R18 密度应 ≥8‰（建议远超 1.5‰ 阈值），实际 " + density.toFixed(2) + "‰");

  const { cx, emotion, text } = await runAnalysis("污染书");

  // 实现侧的阈值判定也要真的触发（否则这条用例测的就不是污染通道）
  assert.equal(emotion.confidence, "low", "污染夹具应触发 confidence=low");
  assert.ok(emotion.pollution.r18Per1000 >= 1.5, "夹具应触发实现侧 r18Per1000 ≥1.5，实际 " + emotion.pollution.r18Per1000);

  // ── 核心：不可采信时不得给顶格 high ──
  assert.equal(cx.reliable, false, "污染场景 complexity.reliable 必须为 false（旧实现没有这个字段）");
  assert.equal(cx.level, "unknown", "污染场景 complexity.level 必须是 \"unknown\"（旧实现会给 \"high\" ✗）");
  assert.equal(typeof cx.reliabilityNote, "string");
  assert.ok(cx.reliabilityNote.length > 0, "污染场景 reliabilityNote 必须非空");
  assert.match(cx.reliabilityNote, /污染/, "reliabilityNote 必须说明污染（实测：" + cx.reliabilityNote + "）");
  assert.match(cx.reliabilityNote, /不可采信/, "reliabilityNote 必须写明「不可采信」（实测：" + cx.reliabilityNote + "）");

  // score 保留数值（契约：不置 null）——同时证明「本夹具在旧实现下确实会顶格」
  assert.equal(typeof cx.score, "number", "score 必须仍是数值（契约：不置 null）");
  assert.ok(Number.isFinite(cx.score), "score 必须是有限数，实际 " + cx.score);
  // 0.6 是实现的 high 档下界（照抄的唯一一个实现数字）：score ≥0.6 才说明"旧实现真的会给 high"，
  // 否则本夹具在旧实现下也只是 medium，钉不住用户报的那个 bug。
  assert.ok(cx.score >= 0.6, "夹具应能顶到 high 档（score ≥0.6）才谈得上「爆掉」，实际 score=" + cx.score);

  // ── 机械证明真凶：旧渲染的 120 字符截断必然丢掉警告 ──
  const serialized = JSON.stringify(cx);
  const legacy = serialized.slice(0, 120);
  assert.ok(serialized.length > 120, "夹具前提：序列化后应超过 120 字符");
  assert.ok(!legacy.includes("reliable"), "旧渲染 slice(0,120) 应确实截不到 reliable —— 这正是警告到不了模型的原因");
  assert.ok(!legacy.includes("不可采信"), "旧渲染 slice(0,120) 应确实截不到「不可采信」");
  console.log("    [证据] 污染复杂度 score=" + cx.score + " level=" + cx.level + "；旧渲染前 120 字符=" + JSON.stringify(legacy));
  assert.ok(text.length > 0, "渲染文本不应为空");
});

// ===========================================================================
// ② 无数据场景：零情感词 → unknown + score 0 + 说明「没测到 ≠ 情感简单」
// ===========================================================================

test("② 无数据场景：零情感词 → unknown / score 0 / 说明「没测到 ≠ 情感简单」", async () => {
  const { cx, emotion } = await runAnalysis("无数据书");

  // 前置：确认这份夹具真的一个情感词都没有（自算：clean 计数全 0 且强度 0）
  assert.equal(emotion.intensity, 0, "无数据夹具的情感密度应为 0，实际 " + emotion.intensity);
  const cleanTotal = emotion.cleanScores.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(cleanTotal, 0, "无数据夹具的 clean 情感计数应全为 0，实际合计 " + cleanTotal);
  assert.equal(emotion.confidence, "low", "零情感词应触发 confidence=low");

  assert.equal(cx.reliable, false, "无数据场景 complexity.reliable 必须为 false");
  assert.equal(cx.level, "unknown", "无数据场景 complexity.level 必须是 \"unknown\"（旧实现会给 \"low\" ✗）");
  assert.equal(cx.score, 0, "无数据场景 score 必须是 0，实际 " + cx.score);
  assert.equal(typeof cx.reliabilityNote, "string");
  assert.ok(cx.reliabilityNote.length > 0, "无数据场景 reliabilityNote 必须非空");
  // 契约要求说明「没测到 ≠ 情感简单」这层意思
  assert.match(cx.reliabilityNote, /没测到/, "note 必须说明「没测到」（实测：" + cx.reliabilityNote + "）");
  assert.match(cx.reliabilityNote, /情感简单/, "note 必须点明不等于「情感简单」（实测：" + cx.reliabilityNote + "）");
  assert.match(cx.reliabilityNote, /无数据可依/, "note 必须说明无数据可依（实测：" + cx.reliabilityNote + "）");
});

// ===========================================================================
// ③ 正常场景：不得过度降级（防「一刀切 unknown」）
// ===========================================================================

test("③ 正常场景：无污染且情感词正常 → reliable=true / note 空串 / level 非 unknown", async () => {
  const cases = [
    ["单调书", "low"],
    ["混杂书", "medium"],
    ["均衡书", "high"]
  ];
  const actual = [];
  for (const [book, expectedLevel] of cases) {
    const { cx, emotion } = await runAnalysis(book);
    // 前置：确认夹具无污染、有数据（否则这条测的就不是"正常"通道）
    assert.equal(emotion.pollution.r18Per1000, 0, book + " 夹具不应含 R18 词");
    assert.equal(emotion.pollution.battlePer1000, 0, book + " 夹具不应含战斗词");
    assert.equal(emotion.pollution.horrorPer1000, 0, book + " 夹具不应含恐怖词");
    assert.notEqual(emotion.confidence, "low", book + " 夹具不应落到 low 置信度（那说明夹具被污染/无数据）");

    assert.equal(cx.reliable, true, book + "：正常文本 reliable 必须为 true（不得一刀切成 unknown）");
    assert.equal(cx.reliabilityNote, "", book + "：可采信时 reliabilityNote 必须是空串，实际 " + JSON.stringify(cx.reliabilityNote));
    assert.notEqual(cx.level, "unknown", book + "：正常文本的 level 不得是 unknown");
    assert.ok(["low", "medium", "high"].includes(cx.level), book + "：level 必须是 low/medium/high，实际 " + cx.level);
    assert.equal(typeof cx.score, "number");
    actual.push([book, cx.level, cx.score]);
    assert.equal(cx.level, expectedLevel, book + "：夹具应落在 " + expectedLevel + " 档，实际 " + cx.level + "（score=" + cx.score + "）；若阈值变了请调整夹具而不是放宽断言");
  }
  // 三档都要能出现：这既防"全 unknown"，也防"全部塌成一档"
  const levels = new Set(actual.map((entry) => entry[1]));
  assert.deepEqual([...levels].sort(), ["high", "low", "medium"], "正常夹具应覆盖 low/medium/high 三档，实际 " + JSON.stringify(actual));
  console.log("    [正常场景] " + actual.map(([book, level, score]) => book + "=" + level + "(" + score + ")").join("  "));
});

// ===========================================================================
// ④ 渲染层：真凶所在（必须走真实工具路径）
// ===========================================================================

test("④ 渲染层（污染）：出现可读的「复杂度」行 + 另起一行输出 reliabilityNote", async () => {
  const { cx, text } = await runAnalysis("污染书");
  const { lines, index, line } = complexityLine(text);

  assert.ok(index >= 0, "渲染文本里必须出现「- 复杂度: 」这一行（【情感量化】段）\n实际渲染：\n" + text);

  // 可读行格式：- 复杂度: <score>（<level>）熵 X/Y，多样性 N…
  assert.match(
    line,
    /^- 复杂度: [0-9.]+（(?:low|medium|high|unknown)）熵 [0-9.]+\/[0-9.]+，多样性 \d+/,
    "复杂度行必须是可读行（score/level/熵/多样性），实际：" + JSON.stringify(line)
  );
  assert.ok(line.includes(`（${cx.level}）`), "复杂度行必须带 level（" + cx.level + "），实际：" + JSON.stringify(line));
  assert.ok(line.includes("熵 " + cx.entropy + "/" + cx.maxEntropy), "复杂度行必须带「熵 X/Y」，实际：" + JSON.stringify(line));

  // reliabilityNote 必须到达渲染文本，且**另起一行**（不在复杂度行里被挤掉）
  assert.ok(text.includes(cx.reliabilityNote), "渲染文本里必须出现 reliabilityNote 原文\n期望包含：" + cx.reliabilityNote + "\n实际渲染：\n" + text);
  const noteIndex = lines.findIndex((candidate) => candidate.trim() === cx.reliabilityNote);
  assert.ok(noteIndex >= 0, "reliabilityNote 必须单独成行（trim 后整行等于 note），实际渲染：\n" + text);
  assert.ok(noteIndex > index, "reliabilityNote 必须排在复杂度行之后，实际 note 行 " + noteIndex + "、复杂度行 " + index);
  // 「另起一行」按最严格口径钉住：紧邻的下一行就是它（中间不许夹别的内容，否则读者容易漏读）
  assert.equal(noteIndex, index + 1, "reliabilityNote 必须紧接在复杂度行的下一行，实际复杂度行 " + index + "、note 行 " + noteIndex);
  assert.match(lines[noteIndex], /不可采信/, "渲染出来的警告必须含「不可采信」，实际：" + JSON.stringify(lines[noteIndex]));
  assert.ok(!line.includes(cx.reliabilityNote), "警告不应挤在复杂度行里，而应另起一行");
  // 不可采信时，level 本身也要在渲染文本里显形（模型很可能只读这一行）
  assert.ok(line.includes("（unknown）"), "不可采信时复杂度行必须显示（unknown），实际：" + JSON.stringify(line));

  console.log("    [渲染] " + JSON.stringify(line));
  console.log("    [渲染] " + JSON.stringify(lines[noteIndex]));
});

test("④-d 渲染层反向断言：复杂度不得回退成 JSON 串（真凶的旧形态）", async () => {
  // 独立成条：这样「渲染回退成 JSON」这个失败点有自己的名字，
  // 不会被 ④ 里更早的格式断言掩盖（变异 A 下两条都要红）。
  for (const book of ["污染书", "无数据书", "混杂书"]) {
    const { cx, text } = await runAnalysis(book);
    const { line } = complexityLine(text);
    assert.ok(line, book + "：渲染文本缺「- 复杂度: 」行");
    assert.ok(!text.includes('"reliable":'), book + "：渲染文本不得出现 \"reliable\": 这类 JSON 片段");
    assert.ok(!text.includes('{"score"'), book + "：渲染文本不得出现 {\"score\" 这类 JSON 片段");
    assert.ok(!text.includes('\\"score\\"'), book + "：渲染文本不得出现转义后的 JSON 片段");
    assert.ok(!text.includes("[object Object]"), book + "：渲染文本不得出现 [object Object]");
    assert.ok(!/复杂度: undefined/.test(text), book + "：复杂度行不得是 undefined");
    // 旧渲染必然以 JSON 的左花括号开头；可读行必须以数字（score）开头
    assert.ok(!/^- 复杂度: \{/.test(line), book + "：复杂度行不得以 { 开头（那是 JSON.stringify 的形态），实际：" + JSON.stringify(line));
    assert.match(line, /^- 复杂度: [0-9]/, book + "：复杂度行应以 score 数字开头，实际：" + JSON.stringify(line));
    // 旧渲染的 120 字符截断必然丢掉 reliable / 警告：把这一点也钉住
    const legacy = JSON.stringify(cx).slice(0, 120);
    assert.ok(!text.includes(legacy), book + "：渲染文本不得出现旧渲染的 120 字符 JSON 片段");
  }
});

test("④-b 渲染层（正常）：可采信时不得多出警告行", async () => {
  const { cx, text } = await runAnalysis("混杂书");
  const { lines, index, line } = complexityLine(text);
  assert.ok(index >= 0, "正常文本也必须出现「复杂度」行");
  assert.ok(line.includes(`（${cx.level}）`), "复杂度行必须带 level");
  assert.ok(!line.includes("（unknown）"), "可采信时不得显示 unknown，实际：" + JSON.stringify(line));
  assert.ok(!text.includes("不可采信"), "可采信时渲染文本不得出现「不可采信」");
  // 精确到"下一行"：reliable=true 时复杂度行的下一行不得是任何警告（旧实现/误改都会在这里露馅）
  const next = lines[index + 1] ?? "";
  assert.ok(!/不可采信|无数据可依|请勿据此/.test(next), "可采信时复杂度行的下一行不得是警告行，实际：" + JSON.stringify(next));
  // 当前正常形态：下一行是空行，随后是下一段标题（【细节密度】等）——把它钉住，避免"警告被悄悄插进来"
  assert.equal(next.trim(), "", "可采信时复杂度行之后应是空行（段落分隔），实际：" + JSON.stringify(next));
});

test("④-c 渲染层（无数据）：unknown 必须出现在渲染文本里", async () => {
  const { cx, text } = await runAnalysis("无数据书");
  const { index, line } = complexityLine(text);
  assert.ok(index >= 0, "无数据文本也必须出现「复杂度」行");
  assert.match(line, /^- 复杂度: 0（unknown）/, "无数据时渲染行应为「- 复杂度: 0（unknown）…」，实际：" + JSON.stringify(line));
  assert.ok(text.includes(cx.reliabilityNote), "无数据时 reliabilityNote 也必须到达渲染文本");
});

// ===========================================================================
// ⑤ level 取值集合 + 字段类型（防止未来再冒出别的值）
// ===========================================================================

test("⑤ level 只可能是 low/medium/high/unknown，且 reliable/note 类型正确", async () => {
  // 先跑一遍全部夹具，收集真实工具路径上出现过的 level
  for (const book of Object.keys(BOOKS)) {
    const { cx } = await runAnalysis(book);
    assert.ok(ALL_LEVELS.includes(cx.level), book + "：level 越界，实测 " + JSON.stringify(cx.level));
    assert.equal(typeof cx.reliable, "boolean", book + "：reliable 必须是 boolean，实测 " + typeof cx.reliable);
    assert.equal(typeof cx.reliabilityNote, "string", book + "：reliabilityNote 必须是 string，实测 " + typeof cx.reliabilityNote);
    assert.equal(typeof cx.score, "number", book + "：score 必须是 number，实测 " + typeof cx.score);
  }

  // 直接调公开 API（不经过工具）也不能冒出第五种取值
  const synthetic = [
    [{ chapter: "a", counts: { joy: 2 } }],
    [{ chapter: "a", counts: { joy: 1, anger: 1, sorrow: 1, fear: 1, surprise: 1 } }],
    [{ chapter: "a", counts: {} }],
    []
  ];
  const reliabilities = [undefined, {}, { polluted: false, noData: false }, { polluted: true, pollutedBy: ["X"] }, { noData: true }];
  for (const perChapter of synthetic) {
    for (const reliability of reliabilities) {
      const cx = emotionComplexity(perChapter, reliability);
      assert.ok(ALL_LEVELS.includes(cx.level), "直接 API：level 越界 " + JSON.stringify(cx.level) + "（perChapter=" + JSON.stringify(perChapter) + "）");
      assert.equal(typeof cx.reliable, "boolean");
      assert.equal(typeof cx.reliabilityNote, "string");
      assert.equal(typeof cx.score, "number");
      assert.ok(Number.isFinite(cx.score), "score 必须有限（不得 null/NaN）：" + cx.score);
      // 不可采信 ⇔ level unknown 的双向蕴含（契约的核心不变式）
      assert.equal(cx.level === "unknown", cx.reliable === false, "level===unknown 必须与 reliable===false 等价，实测 level=" + cx.level + " reliable=" + cx.reliable);
    }
  }
  // 至少真的见过 unknown（否则上面这些断言可能全是 low/medium/high 的空转）
  assert.ok(seenLevels.has("unknown"), "全部夹具跑完仍没见过 unknown —— 不可采信通道没被覆盖到");
  console.log("    [取值集合] 真实工具路径出现过的 level：" + [...seenLevels].sort().join("/"));
});

// ===========================================================================
// ⑥ 间接覆盖：emotionalQuantification 的 reliability 透传
// ===========================================================================

test("⑥ emotionalQuantification 第 4 参（reliability）确实透传到 complexity", () => {
  const plain = emotionalQuantification("她感到幸福，也感到悲伤。", [{ chapter: "a", counts: { joy: 2, sorrow: 1 } }], []);
  assert.equal(plain.complexity.reliable, true, "不传 reliability 时默认可采信");
  assert.equal(plain.complexity.reliabilityNote, "", "可采信时 note 必须空串");

  const polluted = emotionalQuantification("她感到幸福，也感到悲伤。", [{ chapter: "a", counts: { joy: 2, sorrow: 1 } }], [], { polluted: true, pollutedBy: ["高密度 R18/生理描写（每千字 9）"] });
  assert.equal(polluted.complexity.reliable, false, "透传失败：reliability 没到 complexity");
  assert.equal(polluted.complexity.level, "unknown", "透传失败：level 没降级");
  assert.match(polluted.complexity.reliabilityNote, /污染/);
  assert.match(polluted.complexity.reliabilityNote, /高密度 R18/, "pollutedBy 的具体原因应写进 note");

  const noData = emotionalQuantification("他拿起杯子，喝了一口水。", [{ chapter: "a", counts: { joy: 1 } }], [], { noData: true });
  assert.equal(noData.complexity.reliable, false);
  assert.equal(noData.complexity.level, "unknown");
});

// ===========================================================================
// ⑦ 第三类不可采信：raw 有弱词、clean 一个强词都没有 → 同样必须 unknown
// ===========================================================================

test("⑦ 仅弱词命中（raw>0 / clean=0）→ 也必须 unknown + reliable=false", async () => {
  // v6.6.5 后半段契约（由文档负责人在实测中独立发现的同类残留）：
  // `stats.length === 0`（clean 计数为空）一律判不可采信。否则会得到
  // 「level: "low" + reliable: true，而 reliabilityNote 写着无数据可依」的自相矛盾 ✗。
  const { cx, emotion, text } = await runAnalysis("弱词书");
  // 弱词（高兴/担心）不是强情绪词 → clean 计数为 0 → complexity 走"无 clean 数据"分支
  const cleanTotal = emotion.cleanScores.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(cleanTotal, 0, "夹具前提：弱词不应进 clean 计数，实际 " + cleanTotal);
  assert.ok(emotion.intensity > 0, "夹具前提：raw 计数应 >0（这份文本不是零情感词，走的是 clean 分支而非 noData 分支），实际 " + emotion.intensity);
  assert.equal(emotion.confidence, "medium", "弱词文本的置信度应为 medium（既有口径，与本条无关）");

  assert.equal(cx.reliable, false, "无 clean 数据 ⇒ 不可采信，reliable 必须为 false");
  assert.equal(cx.level, "unknown", "无 clean 数据 ⇒ level 必须是 unknown（不得是 low）");
  assert.equal(cx.score, 0, "无 clean 数据 ⇒ score 应为 0，实际 " + cx.score);
  assert.match(cx.reliabilityNote, /无数据可依/, "note 必须说明无数据可依（实测：" + cx.reliabilityNote + "）");
  assert.match(cx.reliabilityNote, /没测到/, "note 必须说明「没测到」（实测：" + cx.reliabilityNote + "）");
  assert.match(cx.reliabilityNote, /情感简单/, "note 必须点明不等于「情感简单」（实测：" + cx.reliabilityNote + "）");

  // 渲染层同样要到模型眼前（否则又是一条"只写在 value 里"的警告）
  assert.ok(text.includes(cx.reliabilityNote), "弱词场景的 note 也必须到达渲染文本");
  const { line } = complexityLine(text);
  assert.ok(line.includes("（unknown）"), "渲染行必须显示 unknown，实际：" + JSON.stringify(line));
});

// ===========================================================================
// ⑦-b 契约一致性：reliabilityNote 是给模型看的纯文本，不得含 Markdown 星号
// ===========================================================================

test("⑦-b reliabilityNote 是纯文本：不得含 Markdown ** 标记", async () => {
  // 渲染层是纯文本（<content> 里直接拼），`**...**` 会以字面星号出现在模型眼前。
  const notes = [];
  for (const book of ["污染书", "无数据书", "弱词书"]) {
    const { cx } = await runAnalysis(book);
    notes.push([book, cx.reliabilityNote]);
  }
  const pollutedDirect = emotionComplexity([{ chapter: "a", counts: { joy: 1, sorrow: 1 } }], { polluted: true, pollutedBy: ["X"] });
  notes.push(["direct-polluted", pollutedDirect.reliabilityNote]);
  const noDataDirect = emotionComplexity([{ chapter: "a", counts: { joy: 1 } }], { noData: true });
  notes.push(["direct-noData", noDataDirect.reliabilityNote]);
  for (const [label, note] of notes) {
    assert.ok(!String(note).includes("**"), label + "：reliabilityNote 不得含 Markdown 星号，实测：" + JSON.stringify(note));
  }
});

// ===========================================================================
// ⑧ 隔离守卫（必须最后跑）
// ===========================================================================

test("⑧ 隔离守卫：用户真实 state.json / logs/ 与真实书库全程未被触碰", () => {
  assert.equal(process.env.DSH_NOVEL_WRITER_STATE, STATE, "本套件的 state 必须始终指向临时目录");
  assert.ok(STATE.startsWith(ROOT), "state 不在临时根内：" + STATE);
  assert.ok(LIB.startsWith(ROOT), "书库根不在临时根内：" + LIB);
  assert.equal(fileDigest(REAL_STATE), guardBefore.state, "用户真实 state.json 被改动了（隔离失效）！");
  assert.equal(dirDigest(REAL_LOG_DIR), guardBefore.logs, "用户真实 logs/ 被写入了（隔离失效）！");
  // 缓存必须落在临时书库根下（CACHE_VERSION=PLUGIN_VERSION，撞上用户缓存会测到旧结果）
  const cacheDir = join(LIB, ".novel-writer", "analysis");
  assert.ok(cacheDir.startsWith(ROOT), "分析缓存目录不在临时根内：" + cacheDir);
  let cacheFiles = [];
  try { cacheFiles = readdirSync(cacheDir); } catch { /* 没写缓存也正常（写盘失败被静默降级） */ }
  console.log("   [隔离] 真实 state.json：" + (guardBefore.state ? "存在且哈希未变" : "本来不存在、跑完仍不存在") +
    "｜真实 logs/：" + (guardBefore.logs === null ? "本来不存在、跑完仍不存在" : "清单未变") +
    "｜临时缓存 " + cacheFiles.length + " 份");
});
