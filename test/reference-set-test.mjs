/**
 * v7.0.0（v2.1 Phase 0）：参照集 / 分位统计 / 动作链抽样的**确定性**测试。
 *
 * 这一层的三个设计都各对应一个踩过的坑，所以每条都要能钉住：
 *   ① 分位数用最近秩、不插值——小样本上装精确比不精确更危险；
 *   ② 动作链只取参照集 p60~p85 分位：按"动词最多"降序取样等于专挑最不典型的打斗句，
 *      开写包给的示范永远比作者自己写得更密（四审 §3.5 提的正是这一点）；
 *   ③ 轮换按目标章号 +7 的步长：步长 > 每次取 3，相邻章天然不重叠，不需要额外记账；
 *      池子 ≤ 3 时不假装轮换（全量返回），池子 0 时明确降级而不是静默空手。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActionChains,
  buildReferenceStats,
  describeReferenceProvenance,
  percentile,
  selectDiagnosisChapters
} from "../lib/core.js";

test("percentile：最近秩、空数组返回 0、单元素返回自身", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  // 非数值一律剔除，不能被 NaN 污染
  assert.equal(percentile([1, "x", null, 3], 50), 3);
});

test("buildReferenceStats：分位摘要 + 五感官通道 + 站桩游程", () => {
  const samples = [
    { actionVerbsPer1000: 10, objectNounsPer1000: 5, sensePer1000: 20, abstractDensity: 2, bareDialogueRun: 2, sense: { visual: 3, auditory: 1, tactile: 0, olfactory: 0, temperature: 1 } },
    { actionVerbsPer1000: 20, objectNounsPer1000: 10, sensePer1000: 30, abstractDensity: 4, bareDialogueRun: 5, sense: { visual: 6, auditory: 2, tactile: 1, olfactory: 1, temperature: 2 } },
    { actionVerbsPer1000: 30, objectNounsPer1000: 15, sensePer1000: 40, abstractDensity: 6, bareDialogueRun: 9, sense: { visual: 9, auditory: 3, tactile: 2, olfactory: 2, temperature: 3 } }
  ];
  const s = buildReferenceStats(samples);
  assert.equal(s.chapters, 3);
  assert.equal(s.actionVerbsPer1000.p50, 20);
  assert.equal(s.actionVerbsPer1000.p95, 30);
  assert.equal(s.objectNounsPer1000.p10, 5);
  assert.equal(s.abstractDensity.p85, 6);
  assert.equal(s.bareDialogueRun.max, 9);
  assert.equal(s.bareDialogueRun.p50, 5);
  assert.equal(s.senseChannels.visual.p95, 9);
  assert.equal(s.senseChannels.tactile.p10, 0);
});

test("buildReferenceStats：空样本不产出 NaN，各分位归 0", () => {
  const s = buildReferenceStats([]);
  assert.equal(s.chapters, 0);
  for (const key of ["actionVerbsPer1000", "objectNounsPer1000", "sensePer1000", "abstractDensity"]) {
    for (const p of ["p10", "p50", "p85", "p95"]) {
      assert.equal(s[key][p], 0, key + "." + p + " 应为 0");
    }
  }
  assert.equal(s.bareDialogueRun.max, 0);
});

test("buildActionChains：只取完整句、等距优先中坚区间、按章号轮换不重叠", () => {
  // 构造 20 条**互不相同**的合格句（20~70 字、≥2 动作动词、≥1 物件）
  const verbSet = ["推", "拉", "抓", "握", "捏", "拍", "掀", "扯", "塞", "递"];
  const objectSet = ["门", "刀", "杯", "帘", "绳", "枪", "桌", "盖", "信", "袋"];
  const made = [];
  for (let i = 0; i < 20; i += 1) {
    const a = i % verbSet.length;
    const b = (i + 3) % verbSet.length;
    made.push("他" + verbSet[a] + objectSet[a] + "，又" + verbSet[b] + objectSet[b] + "，然后停在那里看着窗外的雨。");
  }
  const text = made.join("\n");
  const a = buildActionChains([text], 3);
  assert.equal(a.chains.length, 3);
  assert.ok(a.poolSize >= 3, "池子应至少有 3 条，实际 " + a.poolSize);
  for (const c of a.chains) {
    assert.ok(text.includes(c), "示例必须是原文子串（不得截断）：" + c);
    assert.ok(Array.from(c).length >= 20 && Array.from(c).length <= 70, "示例长度越界：" + c);
  }
  // 相邻章不重叠：步长 7 > 取 3，只要池子 > 3 就必须完全不相交
  const b = buildActionChains([text], 4);
  if (a.poolSize > 3) {
    const overlap = a.chains.filter((x) => b.chains.includes(x));
    assert.equal(overlap.length, 0, "相邻章出现重叠例句：" + JSON.stringify(overlap));
  }
});

test("buildActionChains：池子 ≤3 时全量返回且不报错；池子为空时明确降级", () => {
  const one = "他推开门，抓起桌上的长刀，横在胸前，然后转身离开这间屋子。";
  const small = buildActionChains([one], 1);
  assert.equal(small.chains.length, 1);
  assert.equal(small.poolSize, 1);

  const empty = buildActionChains(["很短。", "没有动作的说明文字，只是一句陈述。"], 1);
  assert.deepEqual(empty.chains, []);
  assert.equal(empty.poolSize, 0);
  assert.ok(empty.degraded && empty.degraded.includes("没有符合条件"), "空池必须给出降级说明（不许静默空手）");
});

test("buildActionChains：去重——同一句在多章出现只算一次", () => {
  const s = "他推开门，抓起桌上的长刀，横在胸前，然后转身离开这间屋子。";
  const dup = buildActionChains([s, s, s], 1);
  assert.equal(dup.poolSize, 1);
});

test("selectDiagnosisChapters：只取目标章之前、最近 1~3 章，且剔除参照集章", () => {
  const chapters = [
    { file: "第01章.md", number: 1 },
    { file: "第02章.md", number: 2 },
    { file: "第03章.md", number: 3 },
    { file: "第04章.md", number: 4 },
    { file: "第05章.md", number: 5 }
  ];
  const picked = selectDiagnosisChapters(chapters, 5, []);
  assert.deepEqual(picked.map((c) => c.number), [4, 3, 2]);
  // 自定义参照集：第 4、3 章是"标杆原著"，不能被当成病灶来源
  const withRef = selectDiagnosisChapters(chapters, 5, ["第04章.md", "第03章.md"]);
  assert.deepEqual(withRef.map((c) => c.number), [2, 1]);
  // 第一章没有"之前"
  assert.deepEqual(selectDiagnosisChapters(chapters, 1, []), []);
  // 目标章号不可知 → 不取（宁可空手，也不要拿全书平均冒充"最近"）
  assert.deepEqual(selectDiagnosisChapters(chapters, null, []), []);
});

test("describeReferenceProvenance：custom 不提示；all-unverified 且章数够才提示", () => {
  assert.equal(describeReferenceProvenance("custom", 10), "");
  assert.equal(describeReferenceProvenance("all-unverified", 3), "", "新书章少时不打扰");
  const note = describeReferenceProvenance("all-unverified", 6);
  assert.ok(note.includes("全书"), "披露里必须说明取样范围是全书：" + note);
  assert.ok(note.includes("风格基线范围"), "披露里必须给出可操作的下一步：" + note);
});

test("buildReferenceStats：样本带 chars 时产出 avgChars 与各通道 p10Per1000；buildActionChains 优先取零抽象句", () => {
  const samples = [
    { chars: 2000, actionVerbsPer1000: 15, objectNounsPer1000: 8, sensePer1000: 10, abstractDensity: 1, bareDialogueRun: 1, sense: { visual: 4, auditory: 2, tactile: 2, olfactory: 0, temperature: 1 } },
    { chars: 4000, actionVerbsPer1000: 20, objectNounsPer1000: 10, sensePer1000: 12, abstractDensity: 2, bareDialogueRun: 2, sense: { visual: 8, auditory: 4, tactile: 4, olfactory: 2, temperature: 2 } }
  ];
  const st = buildReferenceStats(samples);
  assert.equal(st.avgChars, 3000);
  assert.equal(st.senseChannels.tactile.p10Per1000, 1);

  const mixed = [
    "他推开木门，抓起桌上的长刀，心里感到一阵绝望与悲伤。",
    "他拉开抽屉，取出里面的铜钥匙，塞进怀里的布袋。",
    "她掀开竹帘，端起案上的青瓷茶碗，倒掉了冷茶。",
    "他握住刀柄，挑开地上的草席，露出一块青石板。"
  ].join("\n");
  const chains = buildActionChains([mixed], 1);
  assert.equal(chains.chains.length, 3);
  assert.ok(chains.chains.every((c) => !c.includes("绝望")), "零抽象候选够 3 条时应过滤含抽象词的动作句");
});