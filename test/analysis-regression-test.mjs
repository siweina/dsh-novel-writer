import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeText, classifySentence, splitBlocks } from "../lib/analysis.js";
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

console.log("Analysis regression tests passed");
