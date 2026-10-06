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

console.log("Analysis regression tests passed");
