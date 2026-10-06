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
// ⑤ v6.2.1 回归（清单 #36/#37/#38/#39/#40/#45）：每条都先构造「旧实现必错」的最小输入
// #36 对话行以闭合引号收尾且行末无句号 → 行末豁免必须生效，且不受 LF/CRLF/行尾空白影响
// 换行一律用 \u000a / \u000d 转义，避免源码里的真实换行符被"行继续"或转义吃掉
const QOPEN = "\u201c";
const QCLOSE = "\u201d";
const q1 = measureStyleMetrics(QOPEN + "你回来了" + QCLOSE + "\u000a" + "他走了。");
const q2 = measureStyleMetrics(QOPEN + "你回来了" + QCLOSE + "\u000d\u000a" + "他走了。");
const q3 = measureStyleMetrics(QOPEN + "你回来了" + QCLOSE + " \u000a" + "他走了。");
ok("#36 对话行行末豁免（引号收尾不计未完句）", q1.detail.unfinishedCount === 0 && q1.metrics.gapIndex === 0, "LF u=" + q1.detail.unfinishedCount + " gap=" + q1.metrics.gapIndex);
ok("#36 换行风格/行尾空白不改变判定", q1.metrics.gapIndex === q2.metrics.gapIndex && q2.metrics.gapIndex === q3.metrics.gapIndex, "LF/CRLF/空格=" + q1.metrics.gapIndex + "/" + q2.metrics.gapIndex + "/" + q3.metrics.gapIndex);
// 行末豁免只作用于"本句之后到行尾只剩引号/空白"。切句器只在行末/句末符处断开，
// 故"未完句"必然落在行尾；这里固定住"非行尾的引号句"这一边界：整行只有一句且以引号收尾 → 豁免。
const q4 = measureStyleMetrics("他开口了" + QOPEN + "你回来了" + QCLOSE + "\u000a");
ok("#36 行尾引号句（行内还有叙述）仍豁免", q4.detail.unfinishedCount === 0 && q4.detail.sentenceCount === 1, "u=" + q4.detail.unfinishedCount + " n=" + q4.detail.sentenceCount);
// v6.3.0（独立校验）：**句末符写在引号内**的中文对话行（「你来了。」）在 LF / CRLF / 行尾空格四种
// 写法下必须给出完全相同的句数、未完句数与缺口指数。此前 style-metrics 自带的那套正则分句对
// 「句末符 + 闭引号 + 空白 + 换行」会多切出一段（实测 LF=2 / CRLF=3 / 行尾三空格=3），
// 而 analysis.splitSentences 与 analyzeText.totalSentences 三态都是 2 —— 同一份代码里两个句数计数器打架，
// 且六维报告会随"文件是 LF 还是 CRLF"漂移。上面 q1~q4 用的引号句没有句末符，恰好绕过了这一形态。
const QD = "\u300c你来了。\u300d";
const four = [QD + "\u000a" + "他说。", QD + "\u000d\u000a" + "他说。", QD + "   \u000a" + "他说。", QD + "   \u000d\u000a" + "他说。"]
  .map(function (t) { const m = measureStyleMetrics(t); return m.detail.sentenceCount + "/" + m.detail.unfinishedCount + "/" + m.metrics.gapIndex; });
ok("#36 引号内含句末符时四态句数/未完句/缺口全等", new Set(four).size === 1 && four[0].startsWith("2/0/"), four.join(" | "));
// #37 纯省略号句必须保留（旧版 PURE_TERM_RE 含 "…" 把它当残片丢弃，sentenceCount=0，与 analysis 侧=1 相矛盾）
const pEll = measureStyleMetrics("……");
ok("#37 纯省略号句保留（真·纯省略号）", pEll.detail.sentenceCount === 1, "n=" + pEll.detail.sentenceCount);
const pMix = measureStyleMetrics("他走进屋，坐下。\n……\n他走了。");
ok("#37 省略号行计入句数（3 句）", pMix.detail.sentenceCount === 3, "n=" + pMix.detail.sentenceCount);
// #38 动词 + 虚词（在/把/被…）此前整词丢失：坐在/站在/躺在 = 0 而站着 = 1
const aSit = measureStyleMetrics("他坐在椅子上。").detail.actionCount;
const aStand = measureStyleMetrics("他站在窗边。").detail.actionCount;
const aLie = measureStyleMetrics("他躺在床上。").detail.actionCount;
const aZhe = measureStyleMetrics("他站着。").detail.actionCount;
ok("#38 坐在/站在/躺在床上均计动作", aSit === 1 && aStand === 1 && aLie === 1 && aZhe === 1, "坐=" + aSit + " 站=" + aStand + " 躺=" + aLie + " 着=" + aZhe);
ok("#38 把/被处置句仍计动作", measureStyleMetrics("他把门推开。").detail.actionCount === 1 && measureStyleMetrics("窗被风吹开。").detail.actionCount === 1);
// #39 程度副词 + 单字形容词不算动作（旧版"味道很香。"=1 而"他很胖。"=0）
ok("#39 很+单字形容词不计动作", measureStyleMetrics("味道很香。").detail.actionCount === 0 && measureStyleMetrics("他很胖。").detail.actionCount === 0, "香=" + measureStyleMetrics("味道很香。").detail.actionCount + " 胖=" + measureStyleMetrics("他很胖。").detail.actionCount);
ok("#39 得/地 后的动作仍计", measureStyleMetrics("他走得很急。").detail.actionCount >= 1 && measureStyleMetrics("他飞快地跑。").detail.actionCount >= 1);
// #45 σ 是总体标准差（÷n）：[1,2,3] → 0.816（样本标准差会是 1.0）
const sig3 = computeBaselineFromPerChapter([mkMetrics(1), mkMetrics(2), mkMetrics(3)]);
ok("#45 σ 为总体标准差（÷n）", sig3.complexity.sigmaMeasured === 0.816 && sig3.complexity.sigmaRaw === Math.sqrt(2 / 3), "σ=" + sig3.complexity.sigmaMeasured + " raw=" + sig3.complexity.sigmaRaw);
// #40 mu 舍成 0 后判定路径不再错位：真 μ=0.004/σ=0.012 → 用真 σ 阈值 0.018，v=0.017 应在带内（旧版走绝对尺度判 out）
const zeroMu = [{ file: "c", metrics: { complexity: 1, modifierDensity: 1, abstractDensity: 1, actionDensity: 1, hedgeDensity: 0.04, gapIndex: 1 } }];
for (let i = 1; i < 10; i += 1) zeroMu.push({ file: "c" + i, metrics: { complexity: 1, modifierDensity: 1, abstractDensity: 1, actionDensity: 1, hedgeDensity: 0, gapIndex: 1 } });
const zBase = computeBaselineFromPerChapter(zeroMu);
ok("#40 基线保留未舍入 muRaw/sigmaRaw", zBase.hedgeDensity.mu === 0 && zBase.hedgeDensity.muRaw === 0.004 && zBase.hedgeDensity.sigmaRaw > 0.011, "mu=" + zBase.hedgeDensity.mu + " muRaw=" + zBase.hedgeDensity.muRaw + " sigmaRaw=" + zBase.hedgeDensity.sigmaRaw);
const zIn = judgeAgainstBaseline({ hedgeDensity: 0.017 }, zBase).verdicts.find(v => v.metric === "hedgeDensity");
const zOut = judgeAgainstBaseline({ hedgeDensity: 0.02 }, zBase).verdicts.find(v => v.metric === "hedgeDensity");
ok("#40 mu 舍成 0 仍走相对判定（不误用绝对尺度）", zIn && zIn.basis === void 0 && zIn.devPct === 325 && zOut && zOut.devPct > zIn.devPct, "0.017 devPct=" + (zIn && zIn.devPct) + " basis=" + (zIn && zIn.basis) + " | 0.02 devPct=" + (zOut && zOut.devPct));
// #42 基线缺失 / 取值非数值的维度必须登记 skippedDims（旧版静默丢弃却宣称"全部维度在容差带内"）
const partialBase = Object.fromEntries(METRIC_ORDER.map(k => [k, { mu: 1, sigma: 0.5, recTol: 25 }]));
delete partialBase.hedgeDensity; // 缺该维基线（真·no-baseline）
const skip = judgeAgainstBaseline({ complexity: 1, modifierDensity: 1, abstractDensity: 1, actionDensity: 1, hedgeDensity: 50 }, partialBase);
ok("#42 未判定的维度进 skippedDims（no-value + no-baseline）", skip.skippedDims.length === 2 && skip.skippedDims.some(s => s.reason === "no-value") && skip.skippedDims.some(s => s.reason === "no-baseline"), "skipped=" + skip.skippedDims.length + " reasons=" + skip.skippedDims.map(s => s.reason).join(","));
ok("#42 summary 披露被跳过的维度", skip.summary.indexOf("未判定") !== -1 && skip.summary.indexOf("不确定性") !== -1, "summary=" + skip.summary);
console.log(`\n单元测试: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
