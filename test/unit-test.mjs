// v3.2.0 单元测试：style-metrics 核心函数（切句/留白/recTol/judge）
import { measureStyleMetrics, computeBaselineFromPerChapter, judgeAgainstBaseline, METRIC_ORDER } from "../lib/style-metrics.js";
let pass = 0, fail = 0;
// v4.0.0：ok() 补第 3 参 detail 并打印——旧版形参只有 (name, cond)，调用方拼的 "gap=…"/"n=…"/"advMods=…" 全被静默丢弃，
// 失败时看不到任何数值，排障只能重跑探针。
const ok = (name, cond, detail) => {
  const suffix = detail ? "  [" + detail + "]" : "";
  if (cond) { pass++; console.log("  ✓ " + name + suffix); }
  else { fail++; console.log("  ✗ " + name + suffix); }
};
// ① 普通句留白指数不高（v3.0 回归：未完句判定）
const m1 = measureStyleMetrics("她走了。他来了。雨停了。").metrics;
ok("留白指数正常（非 100）", m1.gapIndex < 60, "gap=" + m1.gapIndex);
ok("留白有省略号更高", measureStyleMetrics("她走了……他来了。").metrics.gapIndex > m1.gapIndex);
// ①b v3.9.1 #1：连续句末标点并入同句（不再拆成孤立标点残片）；未完句/留白判定保持可用
// v4.0.0：先测量一次再断言——旧版每行都把同一个纯计算 measureStyleMetrics(...) 算第二遍，只为拼诊断串，算完即丢。
const mExcl = measureStyleMetrics("太好了！！！");
ok("连续叹号=1 句", mExcl.detail.sentenceCount === 1, "n=" + mExcl.detail.sentenceCount);
const mQues = measureStyleMetrics("真的？？");
ok("连续问号=1 句", mQues.detail.sentenceCount === 1, "n=" + mQues.detail.sentenceCount);
const mDots = measureStyleMetrics("他哭了。。。她笑了。");
ok("。。。跨句=2 句", mDots.detail.sentenceCount === 2, "n=" + mDots.detail.sentenceCount);
const mEll = measureStyleMetrics("她走了……\n他来了。");
ok("纯省略号句保留", mEll.detail.sentenceCount === 2, "n=" + mEll.detail.sentenceCount);
// ①c v3.9.1 #2：修饰密度 X地 排除名词词素（原地/当地/土地…），真状语 X地 仍计
const mNounDi = measureStyleMetrics("他站在原地。当地政府连夜开会。土地已经荒了。");
ok("名词X地不计修饰", mNounDi.detail.advMods === 0, "advMods=" + mNounDi.detail.advMods);
const mAdvDi = measureStyleMetrics("她慢慢地走。");
ok("状语X地仍计修饰", mAdvDi.detail.advMods === 1, "advMods=" + mAdvDi.detail.advMods);
// ② recTol：1.5σ / mu=0 回退 15 / 上限 100 / 下限 10%
// v4.0.0：旧版只断言 recTol ∈ [10,100] 与 mu=0→15，公式改成 2.0σ/0.5σ 或删掉 100 上限都照样全绿。
// 这里用合成 perChapter 定值断言四档：σ/μ 已知 → 期望整数容差（10% 下限需 opts.minSigmaRatio=0 才可达）。
const mkMetrics = (complexity) => ({ file: "f", metrics: { complexity, modifierDensity: 0, abstractDensity: 0, actionDensity: 0, hedgeDensity: 0, gapIndex: 0 } });
const tolOf = (vals, opts) => computeBaselineFromPerChapter(vals.map(mkMetrics), opts).complexity;
const tolA = tolOf([0.2, 0.3]); // μ=0.25 σ=0.05 → 1.5σ/μ=30%
ok("recTol=1.5σ/μ（[0.2,0.3] → 30）", tolA.recTol === 30, "recTol=" + tolA.recTol + " μ=" + tolA.mu + " σ=" + tolA.sigma);
const tolB = tolOf([0.1, 0.9]); // μ=0.5 σ=0.4 → 120% 被 100 封顶
ok("recTol 上限 100（[0.1,0.9] → 100）", tolB.recTol === 100, "recTol=" + tolB.recTol);
const tolC = tolOf([1, 1]); // σ=0 → 最小 σ 下限 0.15μ → 20%
ok("recTol 受最小 σ 下限（[1,1] → 20）", tolC.recTol === 20, "recTol=" + tolC.recTol + " σ=" + tolC.sigma);
const tolD = tolOf([1, 1.01], { minSigmaRatio: 0 }); // 波动极小 → 命中 10% 下限
ok("recTol 下限 10%（minSigmaRatio=0 → 10）", tolD.recTol === 10, "recTol=" + tolD.recTol);
const tolE = tolOf([0, 0]); // mu=0 回退 15（防 NaN）
ok("recTol mu=0 回退 15", tolE.recTol === 15, "recTol=" + tolE.recTol);
// v3.9.1 #2：基线样本用真状语"慢慢地走"（"原地"已不算修饰词，用它会让 modifier 维 mu=0）
const b = computeBaselineFromPerChapter([{ file: "a", metrics: m1 }, { file: "b", metrics: measureStyleMetrics("她慢慢地走。她回头看了一眼。").metrics }]);
const allOk = Object.values(b).every(v => typeof v.recTol === "number" && isFinite(v.recTol) && v.recTol >= 10 && v.recTol <= 100);
ok("recTol 全部合法（10~100）", allOk, "recTols=" + Object.values(b).map(v => v.recTol).join(","));
const noHedge = computeBaselineFromPerChapter([{ file: "x", metrics: measureStyleMetrics("他站在窗边。窗外是夜晚。").metrics }]);
ok("mu=0 维度 recTol 回退 15", noHedge.hedgeDensity.recTol === 15 && noHedge.gapIndex.recTol === 15, "hedge=" + noHedge.hedgeDensity.recTol + " gap=" + noHedge.gapIndex.recTol);
// ③ judge：容差内 ok / 出带 out
const j1 = judgeAgainstBaseline(m1, { complexity: b.complexity, modifierDensity: b.modifierDensity, abstractDensity: b.abstractDensity, actionDensity: b.actionDensity, hedgeDensity: b.hedgeDensity, gapIndex: b.gapIndex }, { complexity: { low: -100, high: 100 } });
// v4.0.0：judgeAgainstBaseline 恒返回 { verdicts, outOfBand, outCount, summary }（lib/style-metrics.js 末尾），
// 旧版 `Array.isArray(j1) ? j1 : …` 的真分支是死代码，直接取 verdicts。
const jv = j1.verdicts || [];
const cv = jv.find(v => v.metric === "complexity");
ok("judge 返回维度（mu=0 跳过）", jv.length >= 3 && jv.length <= 6, "len=" + jv.length);
ok("judge 自定义容差生效", cv && cv.tolerance.low === -100 && cv.tolerance.high === 100, cv ? "tol=" + JSON.stringify(cv.tolerance) : "complexity 缺失");
// v4.0.0：真 NaN 兜底——recTol 只在“没有自定义容差”时才生效；旧版同时传了 {low:-10,high:10}，
// recTol:NaN 根本走不到，断言其实只重复验证了自定义容差。这里不传第三参，断言回退 ±15。
const jn = judgeAgainstBaseline(m1, { complexity: { mu: 2, sigma: 0.5, recTol: NaN } });
const nv = (jn.verdicts || []).find(v => v.metric === "complexity");
ok("judge 容差 NaN 兜底 → ±15", nv && nv.tolerance.low === -15 && nv.tolerance.high === 15, nv ? "tol=" + JSON.stringify(nv.tolerance) : "complexity 缺失");
// v4.0.0：有效 recTol 必须被采用（NaN 分支的另一半：recTol=25 → ±25）
const jr = judgeAgainstBaseline(m1, { complexity: { mu: 2, sigma: 0.5, recTol: 25 } });
const rv = (jr.verdicts || []).find(v => v.metric === "complexity");
ok("judge 采用有效 recTol → ±25", rv && rv.tolerance.low === -25 && rv.tolerance.high === 25, rv ? "tol=" + JSON.stringify(rv.tolerance) : "complexity 缺失");
// ④ 六维完整性
ok("六维齐全", METRIC_ORDER.length === 6);
console.log(`\n单元测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
