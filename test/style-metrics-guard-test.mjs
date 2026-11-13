/**
 * 六维尺子与**公共搭配豁免层**的口径门禁（审查 #40 / #44 / #45 / #46 / #63）。
 *
 * 为什么这个测试必须存在：
 *   ① #46：`style-metrics.js` 的动作计数只认自己那 10 条 `ACTION_NON_VERB_BIGRAMS`，
 *      没接 `lib/lexicons/collocation-guards.js`（analysis.densityOf 早已接入）。实测
 *      「他直接走了。」actionCount=2（直+走）、「关系很好。」=1（关）、「他很开心。」=1（开）——
 *      同一份"动作密度"在句式报告与风格报告里测的不是同一件事。
 *   ② #40：全书某维 σ=0 时旧版直接进 skippedDims(reason:"mu-zero")，极值离群点被整体跳过。
 *   ③ #44：空数组基线只返回 {mu,sigma,low,high}，比非空输入少 6 个统计键。
 *   ④ #45：computeBaseline(null) / judgeAgainstBaseline(metrics,null) 直接抛 TypeError。
 *   ⑤ #63：单字「画」缺搭配守卫——「他刻画得很细。」「这笔画很贵。」被算成物件名词。
 *
 * 纪律：先按旧行为写断言（红），再改实现（绿）；锁定的数字若因修复变化，必须写明原因。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  measureStyleMetrics,
  computeBaseline,
  computeBaselineFromPerChapter,
  judgeAgainstBaseline,
  METRIC_ORDER
} from "../lib/style-metrics.js";
import { densityOf } from "../lib/analysis.js";
import { DENSITY_GUARDED_BIGRAMS } from "../lib/lexicons/collocation-guards.js";

const actionCount = (text) => measureStyleMetrics(text).detail.actionCount;

/** analysis.densityOf 的动作命中原始次数（per1000 只有 0.1 精度，短句可反推），用于跨模块口径对照。 */
const analysisActionCount = (text) => Math.round((densityOf(text).actionVerbsPer1000 * text.length) / 1000);

/** 物件命中的原始次数（objectNounsPer1000 按千字归一后只有 0.1 精度，短句可反推）。 */
const objectHits = (text) => Math.round((densityOf(text).objectNounsPer1000 * text.length) / 1000);

const mkMetrics = (n = 1) => ({
  complexity: n,
  modifierDensity: n,
  abstractDensity: n,
  actionDensity: n,
  hedgeDensity: n,
  gapIndex: n
});

test("#46 动作计数先剔除公共搭配豁免区间（与 analysis.densityOf 同一张表）", () => {
  // 旧行为（红）：2 / 1 / 1 —— 「直接」「关系」「开心」里的字被当成动作
  assert.equal(actionCount("他直接走了。"), 1, "「直接」里的直/接仍被计成动作（应只剩走）");
  assert.equal(actionCount("关系很好。"), 0, "「关系」里的关仍被计成动作");
  assert.equal(actionCount("他很开心。"), 0, "「开心」里的开仍被计成动作");

  // 真动作不得被豁免层吃掉（防"改过头"）
  assert.equal(actionCount("他走了。"), 1, "真动词「走」被误挡");
  assert.equal(actionCount("他推开门。"), 1, "真动词「推」被误挡");
  assert.equal(actionCount("他坐在椅子上。"), 1, "真动词「坐」被误挡");
  assert.equal(actionCount("他开始跑了。"), 1, "「开始」被挡后，真动作「跑」必须仍计");

  // 口径对照（只对"纯豁免陷阱"断言两模块一致）：修复前 style-metrics=2/1/1、analysis.densityOf=1/0/0。
  // 两套扫描器的合并策略仍不同（本模块会把"动词+宾语"吃成一个动作），所以不对真动作句强行拉平。
  for (const s of ["他直接走了。", "关系很好。", "他很开心。", "他开始跑了。"]) {
    assert.equal(actionCount(s), analysisActionCount(s), "六维动作计数与 analysis.densityOf 口径仍分裂：" + s);
  }

  // 豁免表里确有这些搭配（单一事实源，不是 style-metrics 本地另写一份）
  for (const w of ["直接", "关系", "开心", "开始", "离开"]) {
    assert.ok(DENSITY_GUARDED_BIGRAMS.action.includes(w), "公共豁免表缺少 action 搭配：" + w);
  }
});

test("#63 单字「画」补齐搭配守卫：非物件的画系搭配必须为 0，真画仍计 1", () => {
  // 旧行为（红）：142.9 / 333.3
  assert.equal(objectHits("他刻画得很细。"), 0, "「刻画」被算成物件名词");
  assert.equal(objectHits("这笔画很贵。"), 0, "「笔画」被算成物件名词（笔+画双误计）");
  // 防"整类豁免"：真正的画（一幅画/水墨画）必须保留
  assert.equal(objectHits("挂着一幅画。"), 1, "「一幅画」里的画必须仍计 1 个物件");
  assert.equal(objectHits("水墨画很贵。"), 1, "「水墨画」里的画必须仍计 1 个物件");
  assert.equal(objectHits("他喜欢看动画。"), 0, "「动画」是媒介，不应算物件");
  // 「墙上挂着一幅画。」的物件命中是 2 个（墙 + 画）——「墙」本身就在物件词表里，
  // 不能把这个 2 当成"画没被挡住"的反证；上面用去掉「墙」的同义句单独锁住"画=1"。
  assert.equal(objectHits("墙上挂着一幅画。"), 2, "墙 + 画 两个真物件不应被改动");
  // 守卫条目必须真的落在这张表里（防止只写注释不写配置）
  for (const w of ["画面", "书画", "刻画", "笔画", "漫画", "动画"]) {
    assert.ok(DENSITY_GUARDED_BIGRAMS.object.includes(w), "物件豁免表缺少画系搭配：" + w);
  }
});

test("#40 σ=0 时改用绝对容差判定，不再整体跳过（mu-zero 从 skippedDims 消失）", () => {
  const zero = { mu: 0, muRaw: 0, sigma: 0, sigmaRaw: 0, recTol: 15, low: 0, high: 0 };
  const base = Object.fromEntries(METRIC_ORDER.map((k) => [k, zero]));

  // 旧行为（红）：value=50 被 skip 成 mu-zero，verdicts 里没有这一维
  const high = judgeAgainstBaseline({ hedgeDensity: 50 }, base);
  const highVerdict = high.verdicts.find((v) => v.metric === "hedgeDensity");
  assert.ok(highVerdict, "|50| > recTol(15) 却未给 verdict（仍被整体跳过）");
  assert.equal(highVerdict.status, "out", "绝对容差超限未判 out");
  assert.equal(highVerdict.basis, "absolute", "绝对尺度判定应带 basis=absolute");
  assert.ok(!high.skippedDims.some((s) => s.reason === "mu-zero"), "skippedDims 里仍有 mu-zero");

  // 带内值也必须给出 verdict（"判过且没问题" ≠ "没判"）
  const low = judgeAgainstBaseline({ hedgeDensity: 5 }, base);
  const lowVerdict = low.verdicts.find((v) => v.metric === "hedgeDensity");
  assert.ok(lowVerdict, "带内值未给 verdict");
  assert.equal(lowVerdict.status, "ok");
  assert.ok(!low.skippedDims.some((s) => s.reason === "mu-zero"), "带内值仍被登记成 mu-zero 跳过");

  // 边界：恰好等于容差不算超限（判据是严格大于）
  const edge = judgeAgainstBaseline({ hedgeDensity: 15 }, base).verdicts.find((v) => v.metric === "hedgeDensity");
  assert.equal(edge.status, "warn", "15 恰在容差上，不应判 out");
});

test("#44 空数组基线的字段形状与非空输入一致（下游解构不再拿 undefined）", () => {
  const empty = computeBaselineFromPerChapter([]);
  const nonEmpty = computeBaselineFromPerChapter([{ file: "a", metrics: mkMetrics(1) }]);
  for (const key of METRIC_ORDER) {
    for (const field of Object.keys(nonEmpty[key])) {
      assert.ok(field in empty[key], "空基线缺字段 " + key + "." + field);
    }
    assert.equal(empty[key].recTol, 15, "空基线 recTol 应为默认容差 15");
    assert.equal(empty[key].muRaw, 0);
    assert.equal(empty[key].sigmaRaw, 0);
    assert.equal(empty[key].sigmaMeasured, 0);
    assert.equal(empty[key].sigmaUsed, 0);
    assert.equal(empty[key].sigmaClamped, false);
  }
});

test("#45 null 入参不抛错，且返回结构与正常路径一致", () => {
  // 旧行为（红）：computeBaseline(null) 抛 "chapters is not iterable"
  assert.doesNotThrow(() => computeBaseline(null));
  assert.deepEqual(computeBaseline(null), computeBaseline([]), "computeBaseline(null) 应与空数组完全一致");

  // 旧行为（红）：judgeAgainstBaseline(metrics, null) 抛 reading 'complexity'
  assert.doesNotThrow(() => judgeAgainstBaseline({ complexity: 1 }, null));
  const judged = judgeAgainstBaseline({ complexity: 1 }, null);
  for (const field of ["verdicts", "outOfBand", "outCount", "skippedDims", "summary"]) {
    assert.ok(field in judged, "无基线返回缺字段：" + field);
  }
  assert.deepEqual(judged.verdicts, [], "无基线时不应产出判定");
  assert.deepEqual(judged.skippedDims, [], "无基线是整体缺基线，不应逐维记 skipped");
  assert.ok(judged.summary.includes("无基线"), "summary 未说明无基线：" + judged.summary);

  // undefined 同样兜底
  assert.doesNotThrow(() => judgeAgainstBaseline({}, undefined));
});

test("#19 省略号口径一致：句末 ASCII `...` 与全角 `……` 同时计入「省略号」与「未完句」", () => {
  // 等长（25 字符）语料：只差句末省略号的写法，per1000 的分母完全相同
  const full = "她在窗边站了很久，没有开口说话，也没有回头望着……";
  const ascii = "她在窗边站了很久，没有开口说话，也没有回头望...";
  assert.equal(Array.from(full).length, 25, "语料 A 必须是 25 字符（否则分母不同，数值不可比）");
  assert.equal(Array.from(ascii).length, 25, "语料 B 必须与 A 等长：" + Array.from(ascii).length);
  const mf = measureStyleMetrics(full);
  const ma = measureStyleMetrics(ascii);
  assert.equal(mf.detail.ellipsis, 1);
  assert.equal(ma.detail.ellipsis, 1, "ASCII ... 本来就被算作省略号（这半边口径不变）");
  // 旧行为（红）：ellipsis 计了 `...`，unfinished 判据却不认 → gapIndex 少算一半（80 vs 120）
  assert.equal(ma.detail.unfinishedCount, 1, "ASCII ... 结尾必须算未完句：" + ma.detail.unfinishedCount);
  assert.equal(ma.metrics.gapIndex, mf.metrics.gapIndex, "两种省略号写法必须给出同一个 gapIndex：" + mf.metrics.gapIndex + " vs " + ma.metrics.gapIndex);
  // 反面：句中有 ... 但句末是句号 → 仍是完整句，不许因为出现 ... 就判「未完」
  assert.equal(measureStyleMetrics("她说过...后来还是走了。").detail.unfinishedCount, 0, "句末是句号时不得判未完句");
  // 破折号结尾（原有口径）不受影响
  assert.equal(measureStyleMetrics("她没有再说下去——").detail.unfinishedCount, 1, "破折号结尾仍算未完句");
});
