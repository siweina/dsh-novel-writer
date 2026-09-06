// 句式模式分析引擎测试（v0.6.0：九类 + 去噪 + 相似度；v3.9.1：祈使/否定/分块/人称回归）
import { analyzeText, classifySentence, fingerprintSimilarity, styleDiffs, splitBlocks, splitSentences, valenceSeries } from "../lib/analysis.js";

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
  // v3.7.0 ⑥：补全九类（statement/question/exclamation/ellipsis 此前未覆盖）
  ["他拿起桌上的杯子，喝了一口水。", "statement"],
  ["你明天还会来吗？", "question"],
  ["多安静啊！", "exclamation"],
  ["……", "ellipsis"],
  // v3.9.1 #7：祈使硬词（无 吧/！ 也判祈使）；祈使先于感叹——感叹只留给无祈使词的 !/！ 句
  ["别走。", "imperative"],
  ["请坐。", "imperative"],
  ["别走！", "imperative"],
  ["站住！", "imperative"],
  ["走吧。", "imperative"],
  ["太美了！", "exclamation"],
];
for (const [text, expect] of checks) {
  const got = classifySentence(text).type;
  if (got !== expect) { ok = false; console.log("✗", expect, "<=", text, "实际:", got); }
}
console.log("九类分类抽查:", ok ? "PASS" : "FAIL");

// 情感去噪：情感词表不含单字词，无需搭配排除（"叹气"本就不会产生 anger）；"不害怕"不计（v3.9.1 #6/#5）
const t1 = "她叹了口气，笑着说：\"没事。\" 她一点都不害怕，反而觉得很温暖。";
const r1 = analyzeText(t1);
const angerCount = r1.emotion.scores.find((s) => s.emotion === "anger").count;
const fearCount = r1.emotion.scores.find((s) => s.emotion === "fear").count;
console.log("情感去噪: anger(叹气不算):", angerCount, "| fear(不害怕不计):", fearCount, angerCount === 0 && fearCount === 0 ? "PASS" : "FAIL");
if (angerCount !== 0 || fearCount !== 0) ok = false;

// v3.9.1 #4：文末 \n\n 不再把全文并成一块（空行两侧都需有内容才算分段）
const blockA = splitBlocks("第一行。\n第二行。\n\n");
const blockB = splitBlocks("第一行。\n第二行。\n");
console.log("splitBlocks 文末空行:", JSON.stringify(blockA), "|", JSON.stringify(blockB), blockA.length === 2 && blockB.length === 2 ? "PASS" : "FAIL");
if (blockA.length !== 2 || blockB.length !== 2) ok = false;

// v3.9.1 #5：否定统一判定（negatedAt）——emotionOf / DUTIR 兜底 / valenceSeries 三处一致
const neg1 = analyzeText("不要害怕。不再担心。");
const negFear = neg1.emotion.scores.find((s) => s.emotion === "fear").count;
const val1 = valenceSeries("不开心。");
const val2 = valenceSeries("不害怕。");
const negOk = negFear === 0 && val1.posWords === 0 && !val1.series.some((v) => v > 0) && val2.negWords === 0;
console.log("v3.9.1 否定: fear=", negFear, "| 不开心 series/pos:", JSON.stringify(val1.series), val1.posWords, "| 不害怕 negWords:", val2.negWords, negOk ? "PASS" : "FAIL");
if (!negOk) ok = false;

// v3.9.1 #8：剩余单字第一人称统计 我/俺/咱 三者
const fpRes = analyzeText("俺不想去。咱走吧。");
console.log("第一人称(俺/咱)密度:", fpRes.style.firstPersonDensity, fpRes.style.firstPersonDensity > 0 ? "PASS" : "FAIL");
if (!(fpRes.style.firstPersonDensity > 0)) ok = false;

// v3.9.1 #11：implicit 透出加权计数 negHits/posHits/ambHits（与比率同源）
const impRes = analyzeText("雨打芭蕉，他攥紧拳头。").emotion.quantification.implicit;
console.log("implicit 加权计数: negHits=", impRes.negHits, "posHits=", impRes.posHits, "ambHits=", impRes.ambHits,
  typeof impRes.negHits === "number" && typeof impRes.posHits === "number" && typeof impRes.ambHits === "number" && impRes.negHits > 0 ? "PASS" : "FAIL");
if (!(typeof impRes.negHits === "number" && typeof impRes.posHits === "number" && typeof impRes.ambHits === "number") || !(impRes.negHits > 0)) ok = false;

// v3.9.1 #10：maxSentences 前缀截断 → guidance 尾注（不新增顶层字段）
const truncRes = analyzeText(Array(25).fill("雨下了一整夜。她站在窗前，心里想着明天的事。").join(""), { maxSentences: 5 });
console.log("maxSentences 截断: totalSentences=", truncRes.totalSentences, "guidance 含提示:", truncRes.guidance.includes("采样上限"), truncRes.totalSentences === 5 && truncRes.guidance.includes("采样上限") ? "PASS" : "FAIL");
if (truncRes.totalSentences !== 5 || !truncRes.guidance.includes("采样上限")) ok = false;

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
