/**
 * 抽象度（abstractDensity）的**精度门禁**（v7.0.0 · 六维之一）。
 *
 * 为什么这个测试必须存在：
 * 旧版 `countAbstractWords` 是「4→3→2 字贪婪滑窗 + 末字在 ABSTRACT_SUFFIXES 里」的启发式，
 * 真实语料实测（不是构造出来的极端句）：
 *   · '沈砚摇头道：“不去。”林晚冷笑道：“由不得你。”掌柜低声道：“小心山道上的刀客。”'
 *     → abstractDensity = 97.56，而参照集 p95 只有 11.51（8.5 倍）——这是一段 100% 具象的动作句；
 *   · '他摸着刀柄，粗糙的手感和冰凉的触感让他清醒。' → 90.91，
 *     而「手感/触感」恰恰是本插件处方要求模型**多写**的具象词（计入抽象度 = 尺子与处方自相矛盾）。
 * 根因三条：后缀集里有「道」（把 XX道 对话标签当抽象词）、有「感」（把手感/触感当抽象词）、
 * 4 字窗口只查第 1/2 个字（中间夹停用字也整窗命中，还会把相邻的两个抽象词并成 1 个）。
 *
 * 本文件四组断言：
 *   ① 实测证据句必须回到低位（< 15，旧值 97.56 / 90.91）；
 *   ② 真抽象句必须仍然计入（防"改过头"：把抽象度整类打成 0 也叫修好了，但那是失聪）；
 *   ③ 标签豁免只作用于标签：「XX道」不计，但 天道/大道/中庸之道 照计、预感 照计；
 *   ④ 锁定值：固定混合语料的 abstractCount / abstractDensity 写死——词表或判据一改就红，
 *      强制改的人回来复核精度（本仓库一贯做法：数值变化即提醒）。
 *
 * 改词表时的纪律：先想清楚是「该挡没挡」还是「挡住真词」，再更新 ④ 的锁定值。
 * **不要把锁定值随手改成新数**；而且 v7.0.0 前后同一章的抽象度数值会变化（整体下降），
 * 跨版本数值不可直接比较。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { measureStyleMetrics } from "../lib/style-metrics.js";

const abs = (text) => measureStyleMetrics(text).metrics.abstractDensity;
const absCount = (text) => measureStyleMetrics(text).detail.abstractCount;

test("① 实测证据：对话标签句 / 具象感知句的抽象度必须 < 15（旧值 97.56 / 90.91）", () => {
  // 全句 100% 具象：三个对话标签 + 一条山道
  const dialogue =
    "沈砚摇头道：“不去。”林晚冷笑道：“由不得你。”掌柜低声道：“小心山道上的刀客。”";
  assert.ok(abs(dialogue) < 15, "对话标签句仍被算成抽象：" + abs(dialogue));

  // "手感/触感" 是处方要求多写的具象词，不能反过来抬高抽象度
  const sensory = "他摸着刀柄，粗糙的手感和冰凉的触感让他清醒。";
  assert.ok(abs(sensory) < 15, "具象感知词仍被算成抽象：" + abs(sensory));
});

test("② 真抽象句必须仍然计入（防止改过头：抽象度不能对抽象文本失聪）", () => {
  const abstractSentence = "他的痛苦来自于一种难以言说的孤独感与虚无感。";
  // 阈值取 10：既不锁死到小数，又足以证明"孤独感/虚无感"这类真抽象词还在计数里
  assert.ok(abs(abstractSentence) >= 10, "真抽象句被误挡：" + abs(abstractSentence));
  assert.ok(absCount(abstractSentence) >= 1, "真抽象句的 abstractCount 归零：" + absCount(abstractSentence));
});

test("③ 标签豁免只作用于对话标签：XX道 不计，但天道/大道/中庸之道照计", () => {
  // 前置标签（后接冒号）与**后置标签**（引语在前、XX道 在后）都必须不计。
  // 后置标签正是"只认冒号"判据修不掉的那种（贪婪窗口会落在"头道"这个两字残片上），
  // 所以本仓库改用「…道」白名单反转判定（见 lib/style-metrics.js 的 DAO_ABSTRACT_KEEP 注释）。
  assert.equal(absCount("他摇头道：不去。"), 0, "前置对话标签被计成抽象词");
  assert.equal(absCount("“不去。”沈砚摇头道。"), 0, "后置对话标签被计成抽象词（窗口残片漏网）");
  assert.equal(absCount("赵掌柜接口道：「明日动身。」"), 0, "「接口道」被计成抽象词");

  // 取舍写死：**具象路名「山道」不计**（「…道」白名单反转判定的直接后果：
  // 抽象义的「X道」是封闭小类，路名是开放类，只能让未登记者默认不计）。
  assert.equal(absCount("这条路通往山道尽头。"), 0, "具象路名「山道」被判为抽象词");

  // 防"整类豁免"：真抽象的「道」词必须还在
  assert.equal(absCount("天道无情，大道至简。"), 2, "天道/大道 被误豁免");
  assert.equal(absCount("中庸之道，处世之道，都讲一个分寸。"), 2, "「…之道」成语被误豁免");
});

test("④ 具象感知词不计；但「预感」这类真抽象「X感」必须仍算抽象", () => {
  assert.equal(absCount("粗糙的手感和冰凉的触感"), 0, "手感/触感被算成抽象词");
  // 逐条冒烟：停用表里的每个词都不得再贡献抽象计数（死条目 = 以为挡住了其实没有）
  const sensoryWords = [
    "手感", "触感", "质感", "痛感", "凉感", "光感", "口感", "体感",
    "温度", "速度", "角度", "力度", "厚度", "硬度", "亮度", "湿度"
  ];
  for (const word of sensoryWords) {
    assert.equal(absCount(word + "不错。"), 0, "具象感知词漏网：" + word);
  }
  // 不能整类豁免「X感」：预感 / 感觉 / 孤独感 是真抽象，必须照计
  assert.ok(absCount("他有一种奇怪的预感") > 0, "「预感」被整类豁免（抽象度失聪）");
  assert.ok(absCount("他有一种感觉。") > 0, "「感觉」被整类豁免");
  assert.ok(absCount("一种难以言说的孤独感。") > 0, "「孤独感」被整类豁免");
});

test("⑤ 空值与短文本不抛错", () => {
  const empty = measureStyleMetrics("");
  assert.equal(empty.detail.totalChars, 0);
  assert.equal(empty.detail.abstractCount, 0);
  assert.equal(empty.metrics.abstractDensity, 0);
  const short = measureStyleMetrics("短短一句。");
  assert.equal(typeof short.metrics.abstractDensity, "number");
  assert.ok(Number.isFinite(short.metrics.abstractDensity));
  // 半角/全角标点与换行都不该让判据崩掉
  assert.equal(absCount("他摇头道“不去”"), 0);
});

test("⑥ 锁定值：固定混合语料的 abstractDensity / abstractCount（改词表或判据就红）", () => {
  const corpus = [
    // 对话标签（旧版 4 处误计；含一条具象路名"山道"）
    "沈砚摇头道：“不去。”林晚冷笑道：“由不得你。”掌柜低声道：“小心山道上的刀客。”",
    // 具象感知（旧版 2 处误计）
    "他摸着刀柄，粗糙的手感和冰凉的触感让他清醒。",
    // 真抽象（必须保留）
    "他的痛苦来自于一种难以言说的孤独感与虚无感。",
    // 真抽象的「道」词 + 「…之道」成语（白名单必须放行）
    "天道无情，大道至简，中庸之道讲的是分寸。",
    // 4 字窗口跨词：旧版把"感情和理"并成 1 个，v7.0.0 补查 w[2] 后应计 2 个（感情 + 理性）
    "感情和理性在他心里打架。",
    // 纯动作句（不该有抽象词）
    "他推开门，跨过门槛，把刀横在胸前。"
  ].join("");
  const m = measureStyleMetrics(corpus);
  // 锁定的不是"好看的数字"，而是"当前词表 + 当前判据"的确定行为；改表就会变，这正是要回头看的地方。
  assert.equal(m.detail.totalChars, 134, "语料长度漂移（说明语料被改了，锁定值需一并复核）");
  assert.equal(m.detail.abstractCount, 7, "抽象词计数漂移：" + m.detail.abstractCount);
  assert.equal(m.metrics.abstractDensity, 52.24, "抽象度漂移：" + m.metrics.abstractDensity);
  // 量纲锁定：仍是 count / totalChars * 1000（保留两位小数）——改量纲会让历史报告全废
  assert.equal(m.metrics.abstractDensity, Math.round((m.detail.abstractCount / m.detail.totalChars) * 1000 * 100) / 100,
    "抽象度量纲不再是 count/totalChars*1000");
});