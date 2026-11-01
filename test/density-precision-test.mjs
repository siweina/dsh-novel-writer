/**
 * 细节密度尺子的**精度门禁**（v7.0.0 · Phase -1「修尺子」）。
 *
 * 为什么这个测试必须存在：
 * `analysis.js` 的 `DENSITY_ACTION_VERBS` / `DENSITY_OBJECT_WORDS` / `DENSITY_SENSE`
 * 全都是**单字正则**。在真实书库上实测（七审独立审查）：「一点」贡献 2 个"动作动词"，
 * 「根本/要被」贡献"物件名词"，「一样/里面」贡献"视觉"，「痛苦/语气/力气」贡献"嗅觉"，
 * 「干净/麻烦」贡献"触觉"，「温柔」贡献"温度"。也就是说，此前所有基于这些量的结论
 * （感官通道占比、动作密度、动作链占比、Phase 0 验收指标）测的都是**词表**，不是文本。
 *
 * 于是本文件把"尺子准不准"变成可执行断言，四组：
 *   ① 陷阱句：只含虚词搭配的句子，**任何通道都必须为 0**（不许再被灌水）；
 *   ② 真信号：每种通道的真实描写句**必须至少命中 1 次**（不许把信号一起挡掉）；
 *   ③ 聚合锁定：固定语料的各通道计数**锁定为具体数值**——词表或豁免表一改就红，
 *      强制改的人回来复核精度（这是本仓库一贯的做法：数值变化即提醒）；
 *   ④ 豁免表元测：每条登记都必须**真的在该通道词表里命中**（死条目 = 以为挡住了其实没有）；
 *   ⑤ 动作链回归：示例必须是**完整句**（旧版 40 字截断）且**不再恒取全书开头三句**（旧版 length<3 填满即止）。
 *
 * 改词表时的纪律：先改 `lib/lexicons/collocation-guards.js`，跑本测试 → 红 → 看是"该挡没挡"
 * 还是"挡住真词"，再更新 ③ 的锁定值。**不要把锁定值随手改成新数**。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { densityOf, densityChannelCovers, METRIC_CALIBER } from "../lib/analysis.js";
import { DENSITY_GUARDED_BIGRAMS, DENSITY_GUARD_CHANNELS, guardedEntryCount } from "../lib/lexicons/collocation-guards.js";

const ZERO_SENSE = { visual: 0, auditory: 0, tactile: 0, olfactory: 0, temperature: 0 };

/** 只含虚词搭配的句子：这些字在词表里都有，但它们在这里**一个都不是信号** */
const TRAPS = [
  "这一点很重要，他根本不在意。",
  "他这样想着，语气很平静。",
  "关系很复杂，系统也出了问题。",
  "他痛苦地低下头，力气用尽，麻烦接踵而来。",
  "一样的情况，里面外面都没有人，面对现实吧。",
  "干干净净，温柔得很，接着他开始思考。"
];

test("① 陷阱句不得贡献任何密度（单字词表已被上下文豁免层抵消）", () => {
  for (const sentence of TRAPS) {
    const d = densityOf(sentence);
    assert.equal(d.actionVerbsPer1000, 0, "动作动词被虚词灌水：" + sentence);
    assert.equal(d.objectNounsPer1000, 0, "物件名词被虚词灌水：" + sentence);
    assert.deepEqual(d.sense, ZERO_SENSE, "感官通道被虚词灌水：" + sentence + " → " + JSON.stringify(d.sense));
  }
});

test("② 真信号必须仍然计入（豁免不能吃掉正文）", () => {
  const cases = [
    ["刺眼的强光晃得他睁不开眼，脸上映出暗红的色块。", "visual"],
    ["远处传来急促的钟声与低语，脚步声响成一片。", "auditory"],
    ["空气里有股铁锈味，混着药香与淡淡的腥甜。", "olfactory"],
    ["冰凉的金属贴着掌心，粗糙的木纹硌得指尖发麻。", "tactile"],
    ["滚烫的茶水泼出来，凉风灌进袖口，他打了个寒噤。", "temperature"]
  ];
  for (const [sentence, channel] of cases) {
    const d = densityOf(sentence);
    assert.ok(d.sense[channel] >= 1, "通道「" + channel + "」的真信号被误挡：" + sentence + " → " + JSON.stringify(d.sense));
  }
  // 动作与物件同样要有真命中：单字词表不能因为去噪而对动作句"失聪"
  const action = densityOf("他推开木门，抓起桌上的长刀，横在胸前。");
  assert.ok(action.actionVerbsPer1000 > 0, "动作动词全被误挡");
  assert.ok(action.objectNounsPer1000 > 0, "物件名词全被误挡");
});

test("③ 聚合锁定：固定语料的各通道计数（词表/豁免表一改就红，回来复核精度）", () => {
  const corpus = TRAPS.concat([
    "他认为这是理所当然的事。",
    "刺眼的强光晃得他睁不开眼，脸上映出暗红的色块。",
    "远处传来急促的钟声与低语，脚步声响成一片。",
    "空气里有股铁锈味，混着药香与淡淡的腥甜。",
    "冰凉的金属贴着掌心，粗糙的木纹硌得指尖发麻。",
    "滚烫的茶水泼出来，凉风灌进袖口，他打了个寒噤。"
  ]).join("");
  const d = densityOf(corpus);
  // 锁定的不是"好看的数字"，而是"当前词表 + 当前豁免表"的确定行为；
  // 改一张表就会变，这正是要人回头看的地方。
  assert.deepEqual(d.sense, { visual: 5, auditory: 6, tactile: 3, olfactory: 4, temperature: 3 }, "感官计数漂移：" + JSON.stringify(d.sense));
  assert.equal(d.actionVerbsPer1000, 4.5, "动作密度漂移：" + d.actionVerbsPer1000);
  assert.equal(d.objectNounsPer1000, 4.5, "物件密度漂移：" + d.objectNounsPer1000);
});

test("④ 豁免表元测：无死条目、每通道非空、总量受控", () => {
  assert.ok(guardedEntryCount() > 0, "豁免表为空——等于没有去噪");
  assert.deepEqual([...DENSITY_GUARD_CHANNELS].sort(), ["action", "auditory", "object", "olfactory", "tactile", "temperature", "visual"], "通道名与 densityOf 的 sense 键不一致");
  for (const channel of DENSITY_GUARD_CHANNELS) {
    const list = DENSITY_GUARDED_BIGRAMS[channel];
    assert.ok(list.length >= 3, "通道「" + channel + "」豁免条目过少（" + list.length + "），去噪基本没生效");
    const seen = new Set();
    for (const word of list) {
      assert.ok(!seen.has(word), "通道「" + channel + "」存在重复条目：" + word);
      seen.add(word);
      // 死条目：登记了，但这个词根本不在此通道词表里 → 什么都没挡住，却让人以为防住了
      assert.ok(densityChannelCovers(channel, word), "通道「" + channel + "」的死条目：「" + word + "」不命中该通道词表");
    }
  }
});

test("⑤ 动作链回归：示例是完整句，且不再恒取全书开头三句", () => {
  // v7.0.0：示例口径统一为 15~70 字（裁决 1），这里的句子必须够长，否则会被判"过短"筛掉
  const head = "他推开门板，抓起桌上的长刀，跨过门槛走进雨里。";
  const filler = "这是一句没有动作的说明文字，用来把后半段推远一点。";
  const tail = "他握紧长枪，一把扯开帐帘，翻身跃上那匹枣红战马。";
  const text = head + filler.repeat(6) + tail;
  const d = densityOf(text);
  assert.ok(d.actionChainExamples.length >= 2, "动作链示例数量异常：" + JSON.stringify(d.actionChainExamples));
  for (const ex of d.actionChainExamples) {
    assert.ok(text.includes(ex), "示例被截断（不是原文子串）：" + ex);
    assert.ok(Array.from(ex).length <= 70, "示例超长，说明没有按完整句抽样：" + ex);
    assert.ok(!ex.endsWith("…"), "示例以省略号结尾（旧版 40 字硬截断的痕迹）：" + ex);
  }
  // 旧版恒取开头三句：末段那句永远拿不到。修好后必须能取到靠后的句子。
  assert.ok(d.actionChainExamples.some((ex) => ex.includes("枣红战马")), "抽样仍然只取开头（末句未被选中）：" + JSON.stringify(d.actionChainExamples));
});

test("⑥ 口径标识可被消费者读到（报告里要标注新旧数值不可比）", () => {
  assert.equal(typeof METRIC_CALIBER, "string");
  assert.match(METRIC_CALIBER, /^v\d+\.\d+\.\d+$/, "口径标识格式应为 vX.Y.Z：" + METRIC_CALIBER);
});