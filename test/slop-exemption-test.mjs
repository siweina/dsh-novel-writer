/**
 * v7.0.0：套话豁免的两条路径（题材静音 / 参照集高频习惯词）。
 *
 * 为什么单独一套：这两条是"宁可漏报不误报"的主动让步，必须钉住三件事——
 *   ① 题材静音**真的会触发**（此前的实现只认字符串，而调用方传的是设定对象 → 从未生效）；
 *   ② 豁免只作用于它该作用的类别，不许顺带把整章套话都静音；
 *   ③ 参照集里没出现过的 pattern 不许被豁免（否则等于把库关了）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildSlopExemptions, scanSlop, SLOP_CATEGORIES } from "../lib/lexicons/slop.js";

const STAT_TEXT = "他的力量提升了三倍，速度增加了近五成，修为突破到筑基期。";

test("① 题材静音：传设定**对象**也要生效（旧实现只认字符串，等于从未生效）", () => {
  const plain = scanSlop(STAT_TEXT, buildSlopExemptions("", {}));
  assert.ok(plain.total > 0, "前置条件不成立：这段文本本该命中数值播报");
  const muted = buildSlopExemptions("", { genre: { genre: "系统流", worldview: "签到系统，面板提示不断" } });
  assert.ok(muted.muteCategories.includes("stat_numeric"), "对象形式的题材设定应静音 stat_numeric：" + JSON.stringify([...muted.muteCategories]));
  assert.equal(scanSlop(STAT_TEXT, muted).total, 0, "静音后不应再报数值播报");
  // 字符串形式仍要兼容（旧调用方）
  assert.ok(buildSlopExemptions("", { genre: "系统流" }).muteCategories.includes("stat_numeric"));
  // 非系统流题材不许静音
  assert.equal(buildSlopExemptions("", { genre: { genre: "武侠" } }).muteCategories.length, 0, "武侠题材不该静音任何类别");
});

test("② 题材静音只影响 stat_numeric，不许连坐其它类别", () => {
  const text = STAT_TEXT + "他嘴角勾起一抹弧度，眼中闪过一丝不易察觉的光芒。";
  const muted = buildSlopExemptions("", { genre: { genre: "系统流" } });
  const hits = scanSlop(text, muted).hits;
  assert.ok(hits.length > 0, "其它类别（眼神/嘴角类）应照常命中");
  assert.ok(hits.every((h) => h.category !== "stat_numeric"), "stat_numeric 应被静音，实际仍有：" + JSON.stringify(hits.map((h) => h.category)));
});

test("③ 参照集高频习惯词豁免：只有真的在参照集里高频出现的 pattern 才被豁免", () => {
  const repeated = "他嘴角勾起一抹弧度。".repeat(60); // 约 600 字（门槛是 ≥500 字），同一句反复
  const ex = buildSlopExemptions([repeated], {});
  assert.ok(ex.exemptRules.length > 0, "参照集里高频出现的 pattern 应被登记为豁免");
  const word = ex.exemptRules[0];
  assert.equal(typeof word, "string");
  // 未出现在参照集里的 pattern 不许被豁免
  const eyeText = "他眼中闪过一丝不易察觉的光芒。";
  const hits = scanSlop(eyeText, ex).hits;
  assert.ok(hits.length > 0, "参照集没出现过的 pattern 仍应报出：" + JSON.stringify(ex.exemptRules));
});

test("④ 参照集太短（< 500 字）不做高频豁免——防止两三章就把库关掉", () => {
  const short = "他嘴角勾起一抹弧度。".repeat(6); // 约 72 字
  assert.equal(buildSlopExemptions([short], {}).exemptRules.length, 0);
});

test("⑤ 类别键都在 SLOP_CATEGORIES 里（文档引用的键必须真实存在）", () => {
  for (const key of Object.keys(SLOP_CATEGORIES)) assert.equal(typeof SLOP_CATEGORIES[key], "string");
  assert.ok(Object.hasOwn(SLOP_CATEGORIES, "stat_numeric"));
});