import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeText, buildGuidance, chapterEmotionStats, classifySentence, compressSequence,
  compositeEmotionPairs, densityOf, emotionComplexity, emotionalQuantification,
  fingerprintSimilarity, implicitEmotionScan, splitBlocks, splitSentences, styleDiffs
} from "../lib/analysis.js";
import { chunkText } from "../lib/embedding.js";
import { semanticStyleDiagnostics, semanticStyleDistances } from "../lib/vibe.js";
// v7.3.3：套话 / 向量审计 / 单章症状的换行口径回归（#14 / M12 / #20）
import { scanSlop } from "../lib/lexicons/slop.js";
import { checkOutlineFulfillment } from "../lib/vector-audit.js";
import { diagnoseChapterSymptoms } from "../lib/chapter-diagnose.js";

const paragraph = "甲句一。\n甲句二。\n\n乙句一。\n乙句二。";
const extraBlank = "甲句一。\n甲句二。\n\n\n乙句一。\n乙句二。";
assert.deepEqual(splitBlocks(extraBlank), splitBlocks(paragraph));
assert.equal(splitBlocks(extraBlank).length, 2);
assert.deepEqual(splitBlocks("甲句一。\n甲句二。\n\n\n"), ["甲句一。", "甲句二。"]);

function emotionCount(text, emotion) {
  return analyzeText(text).emotion.scores.find((entry) => entry.emotion === emotion).count;
}
assert.equal(emotionCount("她无比幸福。", "joy"), 1.5);
assert.deepEqual(analyzeText("她无比幸福。").emotion.topWords.map((entry) => entry.word), ["幸福"]);
assert.equal(emotionCount("她令人高兴。", "joy"), 1);
assert.equal(emotionCount("她悲痛欲绝。", "sorrow"), 1);
assert.equal(emotionCount("她幸福又欣慰。", "joy"), 2);

for (const text of [
  "小心前面的陷阱！", "小心前面的陷阱。", "赶紧离开这个危险的地方！",
  "赶紧离开这个危险的地方。"
]) assert.equal(classifySentence(text).type, "imperative", text);
for (const [text, type] of [
  ["马上就到了。", "statement"],
  ["注意到他了。", "statement"],
  ["注意力非常集中！", "exclamation"],
  ["小心翼翼地走！", "exclamation"],
  ["大家小心翼翼地走！", "exclamation"],
  ["赶紧走了很远的地方。", "statement"],
  ["别人走了。", "statement"],
  ["快乐的日子。", "statement"]
]) assert.equal(classifySentence(text).type, type, text);

for (const text of [
  "他看见门上写着“危险”。", "他看见门上写着‘危险’。",
  "纸条上印着：“禁止入内”。"
]) assert.equal(classifySentence(text).type, "statement", text);
assert.equal(classifySentence("他说：“危险！”").type, "dialogue");
assert.equal(classifySentence("“你真的要走吗？”他低声问。 ").type, "dialogue");

const shortChapter = "他死了。\n\n她笑了。";
assert.deepEqual(chunkText(shortChapter), []);
assert.deepEqual(chunkText(shortChapter, { chapter: "第01章.md" }).map((entry) => entry.text), ["他死了。", "她笑了。"]);
assert.ok(chunkText(shortChapter, { chapter: "第01章.md" }).every((entry) => entry.chapter === "第01章.md"));
assert.equal(chunkText(shortChapter, { chapter: "全书" }).length, 2);

const first = await semanticStyleDistances("正文", null);
assert.equal(first.reason, "no-engine");
assert.equal(first.diagnostics.reason, "no-engine");
assert.equal(first.diagnostics.count, 0);
const second = await semanticStyleDistances("正文", { embed: async () => [1], chunkText: () => [] });
assert.equal(second.diagnostics.reason, "no-chunks");
assert.equal(first.diagnostics.reason, "no-engine");
assert.equal(semanticStyleDiagnostics().reason, "no-chunks");
assert.equal(JSON.stringify(second), "[]");

const testRoot = mkdtempSync(join(tmpdir(), "dsh-analysis-regression-"));
const priorState = process.env.DSH_NOVEL_WRITER_STATE;
try {
  process.env.DSH_NOVEL_WRITER_STATE = join(testRoot, "state.json");
  mkdirSync(join(testRoot, "novels", "回归"), { recursive: true });
  writeFileSync(join(testRoot, "novels", "回归", "第01章.md"), "她走到门前，看见门上写着‘危险’。\n\n他死了。", "utf8");
  const { apply } = await import("../lib/index.js");
  const registry = [];
  const ctx = {
    tools: { register: (def) => { registry.push(def); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    inject: (_names, cb) => cb({ webServer: { register: () => () => {} }, effect: (fn) => fn() })
  };
  apply(ctx, { root: testRoot, sentenceAnalysis: { enabled: true }, allowLanState: true });
  const defs = Object.fromEntries(registry.map((def) => [def.name, def]));
  const exec = { agent: { session: { header: { cwd: testRoot } } } };
  await defs.novel_sentence_config.execute({ action: "set", features: { semanticEmbedding: false } }, exec);
  const report = await defs.novel_style_report.execute({ book: "回归", root: testRoot }, exec);
  assert.equal(report.semanticDiagnostics.reason, "not-run");
  assert.equal(report.semanticDiagnostics.count, 0);
  assert.ok(defs.novel_style_report.output.schema.properties.semanticDiagnostics);
} finally {
  if (priorState === undefined) delete process.env.DSH_NOVEL_WRITER_STATE;
  else process.env.DSH_NOVEL_WRITER_STATE = priorState;
  rmSync(testRoot, { recursive: true, force: true });
}

// ── v6.1.0 缺陷清单回归（第 25/26/27/28/29/32/33/35 条）────────────────────────

// 第 25 条：分章节奏序列必须与主路径同口径——不得把 Markdown 标题 / 分割线算成句子。
// 插件创建的章节首行恒为 "# 标题"，旧版直接 splitSentences(item.text) 每章必多一段假句。
const mdChapter = "# 第01章 夜雨\n\n雨下了一整夜。\n\n她走了。\n";
const mdAnalysis = analyzeText(mdChapter, { chapterTexts: [{ chapter: "第01章", text: mdChapter }] });
assert.equal(mdAnalysis.totalSentences, 2);
assert.equal(mdAnalysis.chapterPatterns[0].sequence, "S×2");
const hrChapter = "# 第01章\n\n雨下了一整夜。\n\n---\n\n她走了。\n";
const hrAnalysis = analyzeText(hrChapter, { chapterTexts: [{ chapter: "第01章", text: hrChapter }] });
assert.equal(hrAnalysis.totalSentences, 2);
assert.equal(hrAnalysis.chapterPatterns[0].sequence, "S×2");

// 第 26 条：DUTIR 兜底词在同一句内重复出现必须按出现次数计分（旧版只计 1 次）。
const joyCount = (text) => analyzeText(text).emotion.scores.find((entry) => entry.emotion === "joy").count;
assert.equal(joyCount("他一帆风顺，一帆风顺。"), 2);
assert.equal(joyCount("他心花怒放，心花怒放，心花怒放。"), 3);
assert.equal(joyCount("他一鸣惊人，一鸣惊人。"), 2);
assert.equal(joyCount("他久旱逢甘雨，久旱逢甘雨。"), 2);
assert.equal(joyCount("他开心，开心。"), 2); // 主词表同句重复（口径应一致）
assert.deepEqual(
  analyzeText("他一帆风顺，一帆风顺。").emotion.topWords.map((entry) => [entry.word, entry.count]),
  [["一帆风顺", 2]]
);

// 第 27 条：topWords 记「出现次数」、scores 记「副词加权分」——两者不可交叉核对，
// 但各自口径必须如注释所述（weighted=1.6 vs count=2 是刻意保留，见 analysis.js 该处注释）。
const weightedSorrow = analyzeText("她有点悲伤，悲伤。");
assert.equal(weightedSorrow.emotion.scores.find((entry) => entry.emotion === "sorrow").count, 1.6);
assert.deepEqual(weightedSorrow.emotion.topWords.map((entry) => [entry.word, entry.count]), [["悲伤", 2]]);

// 第 28 条：implicit 三比率同分母 + 第三项派生 → 和恒为 1（旧版各自取两位小数可得 1.01）
const ratioSum = (text) => {
  const scan = implicitEmotionScan(text);
  return scan.negative + scan.positive + scan.ambiguousRatio;
};
assert.equal(ratioSum("雨夜雨夜沉默灯火"), 1);
assert.equal(ratioSum("雨打芭蕉。"), 1);
assert.equal(ratioSum(""), 0);

// 第 29 条：零情感词 ≠ 「仅弱词」——无数据必须报 low，不得报 medium
const noEmotion = analyzeText("他拿起杯子，喝了一口水。");
assert.equal(noEmotion.emotion.intensity, 0);
assert.equal(noEmotion.emotion.confidence, "low");
assert.match(noEmotion.emotion.caveat, /未检出任何情感词/);
assert.equal(analyzeText("她有点高兴。").emotion.confidence, "medium"); // 仅弱词仍是 medium
assert.equal(analyzeText("她无比幸福。").emotion.confidence, "high");

// 第 32 条：示例/动作链截断按码点，不得留下孤立代理项
const emojiExample = analyzeText("啊".repeat(41) + "\u{1F600}" + "结尾。").categories.find((c) => c.count > 0).examples[0];
assert.ok(emojiExample.includes("\u{1F600}"), emojiExample);
assert.ok(!/[\uD800-\uDBFF]$/.test(emojiExample), emojiExample);
assert.ok(!/^[\uDC00-\uDFFF]/.test(emojiExample), emojiExample);
const emojiChain = analyzeText("\u{1F600}".repeat(3) + "他拿起杯子推开门走出去。").density.actionChainExamples;
assert.deepEqual(emojiChain, ["\u{1F600}\u{1F600}\u{1F600}他拿起杯子推开门走出去。"]);
assert.ok(emojiChain.every((line) => !/[\uD800-\uDBFF]$/.test(line)));

// 第 33 条：公开 API 入参防御一致（旧版多处直接抛 TypeError）
assert.deepEqual(splitSentences(null), []);
assert.deepEqual(splitSentences(undefined), []);
assert.deepEqual(splitBlocks(null), []);
assert.equal(densityOf(null).actionVerbsPer1000, 0);
assert.equal(densityOf(undefined).actionChainRatio, 0);
assert.equal(fingerprintSimilarity(null, null), 0);
assert.deepEqual(styleDiffs(null, null), []);
assert.deepEqual(compositeEmotionPairs([[{}]]), []);
assert.deepEqual(compositeEmotionPairs(null), []);
assert.equal(compressSequence(null), "");
assert.ok(buildGuidance(null, null, null).includes("句式分布："));
assert.ok(emotionalQuantification("x", [{ chapter: "a", counts: { joy: 1 } }]).complexity);
assert.ok(emotionalQuantification("x", [{ chapter: "a", counts: { joy: 1 } }], null).compare);

// 第 35 条：只有一种情感时不得报出 0 占比的次要情感与假冲突
assert.equal(chapterEmotionStats({ sorrow: 5 }).secondary, "");
assert.equal(chapterEmotionStats({ sorrow: 5 }).secondaryRatio, 0);
const singleEmotion = emotionComplexity([{ chapter: "a", counts: { sorrow: 5 } }]);
assert.equal(singleEmotion.conflict, "");
assert.equal(singleEmotion.secondaryRatio, 0);
assert.equal(emotionComplexity([]).conflict, ""); // 空分支口径一致（旧版此处 secondary:"neutral"）
assert.equal(emotionComplexity([]).secondary, "");
assert.equal(chapterEmotionStats({ sorrow: 5, joy: 3 }).secondary, "joy"); // 真有次要情感时照常给出
assert.equal(emotionComplexity([{ chapter: "a", counts: { sorrow: 5, joy: 3 } }]).conflict, "sorrow↔joy");

// 第 30 / 31 条（注释与命名，无行为断言，防回归）：DUTIR 上限仍为 8，长词表条目可命中
assert.equal(joyCount("他久旱逢甘雨。"), 1); // 5 字 DUTIR 词（旧上限 4 时恒不命中）

// v6.9.0 词表审查修复回归：
// ① DUTIR_TO_EMOTION 不把「恶」映射为 anger
assert.equal(emotionCount("这味道真令人恶心。", "anger"), 0);

// ② negatedAt 单字否定词前缀防误判（淹没/苏莫）
const suMo = analyzeText("苏莫大吃一惊。").emotion.scores.find((e) => e.emotion === "surprise")?.count ?? 0;
assert.ok(suMo > 0, "苏莫中的「莫」不得把「大吃一惊」当成被否定情绪反转");

// ─────────────────────────────────────────────────────────────────────────────
// v7.3.3 修（#14）：scanSlop 入口归一 CRLF / CR —— 三种换行的 lines / hit.line / densityPer1000 必须一致
// ─────────────────────────────────────────────────────────────────────────────
{
  // 5 行正文：命中落在第 1/3/5 行；章末类 ending_preach 只在最后 2 行允许（第 5 行）
  const base = "他眼中闪过一丝慌乱。\n她走了。\n全场哗然，不知道的是，一切才刚刚开始。\n他停下。\n命运的齿轮转动。";
  const expectedHits = [["eye_cliche", 1], ["shock_crowd", 3], ["ending_preach", 5]];
  const results = {};
  for (const [tag, nl] of [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]]) {
    const text = base.replace(/\n/g, nl);
    const r = scanSlop(text);
    results[tag] = r;
    // 旧行为（红）：CRLF 密度 56.6（分子/分母含 \r）、纯 CR lines=1 且所有 hit.line 塌成 1
    assert.equal(r.lines, 5, tag + "：行数必须是 5（纯 CR 旧版为 1）：" + r.lines);
    assert.deepEqual(r.hits.map((h) => [h.category, h.line]), expectedHits, tag + "：命中行号必须与 novel_read 一致：" + JSON.stringify(r.hits.map((h) => [h.category, h.line])));
    assert.equal(r.densityPer1000, 61.2, tag + "：密度按归一后的长度算（三种换行同值）：" + r.densityPer1000);
  }
  assert.deepEqual(
    results.LF.hits.map((h) => h.line),
    results.CR.hits.map((h) => h.line),
    "纯 CR 与 LF 的行号必须完全一致"
  );

  // M12：chapter-diagnose 的章末判定在三种换行下必须同结论（旧版纯 CR 时整章 1 行 → 章末类命中被行区间过滤掉）
  const endingBase = "他推开门走出去。\n\n夜色渐深。\n\n她在门口停住。\n\n多年以后，她还是站在门口。\n";
  for (const [tag, nl] of [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]]) {
    const symptoms = diagnoseChapterSymptoms(endingBase.replace(/\n/g, nl));
    assert.deepEqual(symptoms.map((x) => x.key), ["ending_preach"], tag + "：章末升华必须稳定检出（旧版纯 CR 为 0 条）：" + JSON.stringify(symptoms.map((x) => x.key)));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v7.3.3 修（#20）：checkOutlineFulfillment 的 opts.maxClauses 必须真正生效
// ─────────────────────────────────────────────────────────────────────────────
{
  const direction = "甲甲，乙乙，丙丙，丁丁，戊戊，己己，庚庚，辛辛"; // 8 条合法子句
  const text = "他没有说话，只是把灯芯挑亮了一点，屋里于是又亮了一些，墙上的影子也跟着晃动。".repeat(6);
  const embed = async () => [1, 0, 0, 0, 0, 0, 0, 0];
  const base = { embed, isAvailable: async () => true };
  // 旧行为（红）：传 2 / 10 都恒得 6 条
  assert.equal((await checkOutlineFulfillment(direction, text, base)).clauses, 6, "默认仍取 6 条（DEFAULTS 不变）");
  assert.equal((await checkOutlineFulfillment(direction, text, { ...base, maxClauses: 2 })).clauses, 2, "maxClauses=2 必须生效");
  assert.equal((await checkOutlineFulfillment(direction, text, { ...base, maxClauses: 10 })).clauses, 8, "maxClauses 大于子句数时取全部（8）");
  assert.equal((await checkOutlineFulfillment(direction, text, { ...base, maxClauses: 0 })).clauses, 6, "非法值（0）回退默认");
  assert.equal((await checkOutlineFulfillment(direction, text, { ...base, maxClauses: 2.5 })).clauses, 6, "非法值（小数）回退默认");
}

console.log("Analysis regression tests passed");
