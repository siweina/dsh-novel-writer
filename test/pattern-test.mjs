// 句式模式分析引擎测试（v0.5.0 合并版：九类 + 压缩序列 + guidance）
import { analyzeText, classifySentence, compressSequence, buildGuidance, splitSentences, CATEGORY_ORDER, TYPE_CODE } from "../lib/analysis.js";

const SAMPLE = `雨下了一整夜。她站在窗前，心里想着明天的事。
“你真的要走吗？”他低声问。
她沉默了很久，终于开口：“嗯。”
他走了。门关上的声音很轻，却像重锤砸在她心上。
难道这就是结局？她不禁这样想。
她忽然觉得胸口发闷，眼泪毫无预兆地落了下来。
窗外风急，雨打芭蕉。
多安静啊！
快睡吧，明天还要上班。
……
`;

const sentences = splitSentences(SAMPLE);
console.log("句子总数:", sentences.length);

const checks = [
  ["雨下了一整夜。", "statement"],
  ["窗外风急，雨打芭蕉。", "environment"],
  ["她心里一紧，想起当年那场大火。", "psychology"],
  ["「小姐，先歇下吧。」", "dialogue"],
  ["“你真的要走吗？”", "dialogue"],
  ["难道这就是结局？", "rhetoric-question"],
  ["你怎么能这样对我？", "rhetoric-question"],
  ["多安静啊！", "exclamation"],
  ["快睡吧，明天还要上班。", "imperative"]
];
let ok = true;
for (const [text, expect] of checks) {
  const got = classifySentence(text).type;
  const pass = got === expect;
  if (!pass) ok = false;
  console.log((pass ? "✓" : "✗"), expect.padEnd(20), "<=", text.slice(0, 18), "实际:", got);
}

const result = analyzeText(SAMPLE, { top: 8 });
console.log("\n总句数:", result.totalSentences, "| 分类:", CATEGORY_ORDER.map((t) => TYPE_CODE[t] + ":" + result.categories.find((c) => c.type === t).count).join(" "));
console.log("chapterPatterns:", JSON.stringify(result.chapterPatterns));
console.log("guidance:", result.guidance.split("\n").slice(0, 2).join(" / "));
console.log("fingerprint:", result.fingerprint.slice(0, 80));
console.log("情感主导:", result.emotion.dominant, "| 环境占比:", result.style.environmentRatio);
console.log("\n压缩序列:", compressSequence(result.categories.map((c) => TYPE_CODE[c.type])));

// 采样上限
const big = SAMPLE.repeat(300);
const capped = analyzeText(big, { maxSentences: 500 });
console.log("\nmaxSentences=500 采样:", capped.totalSentences, "(<=500:", capped.totalSentences <= 500, ")");

console.log("\n" + (ok ? "ALL PATTERN TESTS PASSED" : "SOME TESTS FAILED"));
process.exit(ok ? 0 : 1);
