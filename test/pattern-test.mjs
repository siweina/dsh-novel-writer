// 句式模式分析引擎测试（v0.6.0：九类 + 去噪 + 相似度）
import { analyzeText, classifySentence, fingerprintSimilarity, styleDiffs, splitSentences } from "../lib/analysis.js";

const SAMPLE = `雨下了一整夜。她站在窗前，心里想着明天的事。
“你真的要走吗？”他低声问。
难道这就是结局？她不禁这样想。
窗外风急，雨打芭蕉。
多安静啊！
快睡吧，明天还要上班。
……
`;

let ok = true;
const checks = [
  ["窗外风急，雨打芭蕉。", "environment"],
  ["她心里一紧，想起当年那场大火。", "psychology"],
  ["「小姐，先歇下吧。」", "dialogue"],
  ["难道这就是结局？", "rhetoric-question"],
  ["快睡吧，明天还要上班。", "imperative"],   // v0.6.0：命令动词开头 + 吧
];
for (const [text, expect] of checks) {
  const got = classifySentence(text).type;
  if (got !== expect) { ok = false; console.log("✗", expect, "<=", text, "实际:", got); }
}
console.log("九类分类抽查:", ok ? "PASS" : "FAIL");

// 情感去噪："叹气"不算"气"；"不害怕"不计
const t1 = "她叹了口气，笑着说：\"没事。\" 她一点都不害怕，反而觉得很温暖。";
const r1 = analyzeText(t1);
const angerCount = r1.emotion.scores.find((s) => s.emotion === "anger").count;
const fearCount = r1.emotion.scores.find((s) => s.emotion === "fear").count;
console.log("情感去噪: anger(叹气不算):", angerCount, "| fear(不害怕不计):", fearCount, angerCount === 0 && fearCount === 0 ? "PASS" : "FAIL");
if (angerCount !== 0 || fearCount !== 0) ok = false;

// 相似度与偏差
const r2 = analyzeText(SAMPLE);
const sim = fingerprintSimilarity(r1, r2);
console.log("指纹相似度(不同文本):", sim, sim >= 0 && sim <= 1 ? "PASS" : "FAIL");
console.log("styleDiffs(自比):", styleDiffs(r1, r1).length === 0 ? "PASS" : "FAIL");
if (styleDiffs(r1, r1).length !== 0) ok = false;

// 情感曲线分段可调
const r3 = analyzeText(SAMPLE.repeat(20), { curveSegments: 5 });
console.log("curveSegments=5 曲线段数:", r3.emotion.curve.length, r3.emotion.curve.length === 5 ? "PASS" : "FAIL");
if (r3.emotion.curve.length !== 5) ok = false;

console.log("\n" + (ok ? "ALL PATTERN TESTS PASSED" : "SOME TESTS FAILED"));
process.exit(ok ? 0 : 1);
