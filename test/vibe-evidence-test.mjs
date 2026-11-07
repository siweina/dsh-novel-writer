/**
 * 氛围光谱的**证据与联动门禁**（审查 #13 / #16 / #43）。
 *
 * 为什么这个测试必须存在：
 *   ① #13：`emotion.caveat` 是"这组测量不可靠"的告警，旧版却把它当一条正面证据
 *      （evidenceCount +1 → confidence +0.07）。同一个文本加 caveat 反而更可信。
 *   ② #16：`THEME_AXIS_LINK` 里的「怪谈」对不上 markers.js 的题材键「规则怪谈」。
 *      该条只在 dominant 恰好含"怪谈"时靠子串命中；当「规则怪谈」只是**次要题材**时整条落空。
 *      另：本文件附一条源码元测，扫描联动表所有题材 token，防止以后再登记一个不存在的键。
 *   ③ #43：signals 只留前 4 条，而题材联动信号排在末尾——基础信号一多，联动说明就被切掉
 *      （分值已加、说明消失，报告读者会以为题材联动没生效）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { computeVibe } from "../lib/vibe.js";
import { THEME_MARKERS } from "../lib/lexicons/markers.js";

const NIGHTMARE_TEXT = "黑暗里有什么在逼近，他觉得诡异，毛骨悚然，不祥的低语从墙后传来。";
const ABSURD_TEXT = "离谱，无语，吐槽，这什么鬼，还有这种操作，简直笑死。";

function makeEmotion(overrides = {}) {
  return {
    dominant: "fear",
    cleanDominant: "fear",
    caveat: null,
    quantification: {
      implicit: { negative: 0.5, positive: 0.1, ambiguousRatio: 0.4, totalHits: 3, negHits: 3, posHits: 1 },
      semanticImplicit: { distribution: { fear: 1 } },
      stats: { delta: -0.1, variance: 0.2 }
    },
    scores: [{ emotion: "fear", count: 3 }],
    ...overrides
  };
}

function makeDetect(themes, dominant = "校园") {
  return {
    evidence: { western: [], modern: [] },
    scores: { western: 0, modern: 0 },
    theme: { dominant, themes: themes.map((theme) => ({ theme })) },
    genre: { dominant: "" }
  };
}

/** 某轴是否带「题材联动」信号（signal label 以"题材联动"开头）。 */
const linkSignalOf = (vibe, axisKey) => {
  const axis = vibe.axes.find((a) => a.key === axisKey);
  return axis ? axis.signals.find((s) => String(s.label).startsWith("题材联动")) : undefined;
};

test("#13 caveat 不得当正面证据：加 caveat 后的置信度必须不高于加之前", () => {
  const detect = makeDetect(["规则怪谈"]);
  const before = computeVibe(detect, makeEmotion(), NIGHTMARE_TEXT).confidence;
  // 旧行为（红）：0.42 > 0.35 —— caveat 反而把置信度抬高 +0.07
  const after = computeVibe(detect, makeEmotion({ caveat: "样本被污染，情感词稀缺" }), NIGHTMARE_TEXT).confidence;
  assert.ok(before > 0, "夹具本身没有置信度，断言无意义");
  assert.ok(after <= before, "caveat 反而抬高了置信度：" + before + " → " + after);
  assert.ok(after < before, "caveat 应扣分（而非中性）：" + before + " → " + after);
});

test("#16 题材联动：规则怪谈作为次要题材时必须命中噩梦轴", () => {
  // 旧行为（红）：linkThemes 用 includes("怪谈") 精确比对 themes → 次要题材「规则怪谈」落空
  const detect = makeDetect(["规则怪谈"], "校园"); // dominant 故意不含"怪谈"
  const vibe = computeVibe(detect, makeEmotion(), NIGHTMARE_TEXT);
  const link = linkSignalOf(vibe, "nightmare");
  assert.ok(link, "「规则怪谈」作为次要题材时未触发噩梦轴联动（signals=" + JSON.stringify(vibe.axes.find((a) => a.key === "nightmare")?.signals) + "）");
  assert.ok(Number(link.s) > 0, "联动信号分值为 0");
});

test("#16（元测）联动表里的每个题材 token 都能在 markers.js 的题材键里解析", () => {
  const src = readFileSync(new URL("../lib/vibe.js", import.meta.url), "utf8");
  const start = src.indexOf("const THEME_AXIS_LINK");
  assert.ok(start >= 0, "找不到 THEME_AXIS_LINK（测试锚点失效，需同步更新）");
  const end = src.indexOf("\n];", start);
  assert.ok(end > start, "找不到 THEME_AXIS_LINK 结尾（测试锚点失效）");
  const block = src.slice(start, end);
  const tokens = [];
  for (const m of block.matchAll(/themes:\s*\[([^\]]*)\]/g)) {
    for (const q of m[1].matchAll(/"([^"]+)"/g)) tokens.push(q[1]);
  }
  assert.ok(tokens.length > 0, "联动表没有解析出任何题材 token");
  const keys = Object.keys(THEME_MARKERS);
  // 允许三种解析方式：精确键 / token 是键的子串（如「总裁」→「豪门总裁」）/
  // 键是 token 的子串（如「规则怪谈」→「怪谈」）。与 linkThemes 的
  // `themes.includes(t) || theme.includes(t)` 语义对齐，避免以后再把不存在的 token 写进表里。
  for (const t of tokens) {
    assert.ok(
      keys.some((k) => k === t || k.includes(t) || t.includes(k)),
      "联动题材「" + t + "」在 markers.js 的题材键里找不到（该条会静默不生效）"
    );
  }
});

test("#43 题材联动信号不得被 signals 的 4 条上限截掉", () => {
  // 该夹具在噩梦轴上会先产出 ≥4 条基础信号（clean/意象/趋势/语义/网文词群…），
  // 旧版 slice(0,4) 会把末尾的"题材联动"整条丢掉。
  const detect = makeDetect(["规则怪谈"], "校园");
  const vibe = computeVibe(detect, makeEmotion(), NIGHTMARE_TEXT);
  const nightmare = vibe.axes.find((a) => a.key === "nightmare");
  assert.ok(nightmare, "夹具没有噩梦轴，断言无意义");
  assert.ok(nightmare.signals.length > 0, "噩梦轴没有任何信号");
  assert.ok(linkSignalOf(vibe, "nightmare"), "signals 里看不到题材联动那条：" + JSON.stringify(nightmare.signals));
  // 没有联动的轴仍按原顺序展示（本次修复只做"联动优先"，不重排其它信号）
  const absurd = computeVibe(makeDetect(["校园"], "校园"), makeEmotion(), ABSURD_TEXT).axes.find((a) => a.key === "absurd");
  assert.ok(absurd && absurd.signals.length > 0, "对照轴没有信号");
  assert.ok(!absurd.signals.some((s) => String(s.label).startsWith("题材联动")), "无联动题材却出现了联动信号");
});
