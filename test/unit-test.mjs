// v3.2.0 单元测试：style-metrics 核心函数（切句/留白/recTol/judge）
import { measureStyleMetrics, computeBaselineFromPerChapter, judgeAgainstBaseline, METRIC_ORDER } from "../lib/style-metrics.js";
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };
// ① 普通句留白指数不高（v3.0 回归：未完句判定）
const m1 = measureStyleMetrics("她走了。他来了。雨停了。").metrics;
ok("留白指数正常（非 100）", m1.gapIndex < 60, "gap=" + m1.gapIndex);
ok("留白有省略号更高", measureStyleMetrics("她走了……他来了。").metrics.gapIndex > m1.gapIndex);
// ①b v3.9.1 #1：连续句末标点并入同句（不再拆成孤立标点残片）；未完句/留白判定保持可用
ok("连续叹号=1 句", measureStyleMetrics("太好了！！！").detail.sentenceCount === 1, "n=" + measureStyleMetrics("太好了！！！").detail.sentenceCount);
ok("连续问号=1 句", measureStyleMetrics("真的？？").detail.sentenceCount === 1, "n=" + measureStyleMetrics("真的？？").detail.sentenceCount);
ok("。。。跨句=2 句", measureStyleMetrics("他哭了。。。她笑了。").detail.sentenceCount === 2, "n=" + measureStyleMetrics("他哭了。。。她笑了。").detail.sentenceCount);
ok("纯省略号句保留", measureStyleMetrics("她走了……\n他来了。").detail.sentenceCount === 2, "n=" + measureStyleMetrics("她走了……\n他来了。").detail.sentenceCount);
// ①c v3.9.1 #2：修饰密度 X地 排除名词词素（原地/当地/土地…），真状语 X地 仍计
ok("名词X地不计修饰", measureStyleMetrics("他站在原地。当地政府连夜开会。土地已经荒了。").detail.advMods === 0, "advMods=" + measureStyleMetrics("他站在原地。当地政府连夜开会。土地已经荒了。").detail.advMods);
ok("状语X地仍计修饰", measureStyleMetrics("她慢慢地走。").detail.advMods === 1, "advMods=" + measureStyleMetrics("她慢慢地走。").detail.advMods);
// ② recTol：1.5σ / mu=0 回退 15 / 上限 100
// v3.9.1 #2：基线样本用真状语"慢慢地走"（"原地"已不算修饰词，用它会让 modifier 维 mu=0）
const b = computeBaselineFromPerChapter([{ file: "a", metrics: m1 }, { file: "b", metrics: measureStyleMetrics("她慢慢地走。她回头看了一眼。").metrics }]);
const allOk = Object.values(b).every(v => typeof v.recTol === "number" && isFinite(v.recTol) && v.recTol >= 10 && v.recTol <= 100);
ok("recTol 全部合法（10~100）", allOk);
const noHedge = computeBaselineFromPerChapter([{ file: "x", metrics: measureStyleMetrics("他站在窗边。窗外是夜晚。").metrics }]);
ok("mu=0 维度 recTol 回退 15", noHedge.hedgeDensity.recTol === 15 && noHedge.gapIndex.recTol === 15);
// ③ judge：容差内 ok / 出带 out
const j1 = judgeAgainstBaseline(m1, { complexity: b.complexity, modifierDensity: b.modifierDensity, abstractDensity: b.abstractDensity, actionDensity: b.actionDensity, hedgeDensity: b.hedgeDensity, gapIndex: b.gapIndex }, { complexity: { low: -100, high: 100 } });
const jv = Array.isArray(j1) ? j1 : (j1.verdicts || []);
  const cv = jv.find(v => v.metric === "complexity");
ok("judge 返回维度（mu=0 跳过）", jv.length >= 3 && jv.length <= 6, "len=" + jv.length);
ok("judge 自定义容差生效", cv && cv.tolerance.low === -100 && cv.tolerance.high === 100);
const jn = judgeAgainstBaseline(m1, { complexity: { mu: 2, sigma: 0.5, recTol: NaN } }, { complexity: { low: -10, high: 10 } });
  const jnv = Array.isArray(jn) ? jn : (jn.verdicts || []);
  ok("judge 容差 NaN 兜底", jnv.find(v => v.metric === "complexity").tolerance.low === -10);
// ④ 六维完整性
ok("六维齐全", METRIC_ORDER.length === 6);
console.log(`\n单元测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);