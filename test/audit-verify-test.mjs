/**
 * test/audit-verify-test.mjs —— v7.2.0 对抗性审计「复核取证」回归套件。
 *
 * `verifyAuditClaims` 是整个设计的灵魂：独立 AI 交回来的每一条声明都要**逐字复核**，
 * 因为它完全可能编造原文、抄错行号、或多打一个空格。这里钉住四件事：
 *   ① 行号 + 原文都对 → accepted；
 *   ② 行号错、但原文确实在别处 → corrected（foundLine 是真实行号，不是抄回来的行号）；
 *   ③ 原文全章都不存在 → rejected，且 reason 明说「编造」；
 *   ④ 归一空白后仍能匹配（多一个空格不许被判废）；
 * 另外钉住输入容错（空/非数组不抛）与 score 口径（accepted + corrected 占比）。
 *
 * 纯函数、零 IO：不需要临时书库。
 *
 * 运行：node test/audit-verify-test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { verifyAuditClaims } = await import("../lib/audit.js");

const TEXT = [
  "他推开门，走了进去。",       // 1
  "她把茶盏放在桌上。",         // 2
  "窗外下起了雨。",             // 3
  "他抬头看了一眼天色。",       // 4
  "她仰头把半杯白酒灌了下去。", // 5
  "屋里只剩下风声。"            // 6
].join("\n");


// ---------------------------------------------------------------------------
// ① accepted
// ---------------------------------------------------------------------------
test("行号与原文都正确 → accepted，记录 line 与归一后的 text", () => {
  const res = verifyAuditClaims({
    claims: [{ contract: "plot", line: 1, text: "他推开门，走了进去。", why: "设定写他不该进门" }],
    text: TEXT
  });
  assert.equal(res.total, 1);
  assert.equal(res.accepted.length, 1);
  assert.equal(res.corrected.length, 0);
  assert.equal(res.rejected.length, 0);
  assert.equal(res.score, 100);
  assert.equal(res.accepted[0].contract, "plot");
  assert.equal(res.accepted[0].line, 1);
  assert.equal(res.accepted[0].text, "他推开门，走了进去。");
});

// ---------------------------------------------------------------------------
// ② corrected
// ---------------------------------------------------------------------------
test("行号错但原文在第 5 行 → corrected，foundLine === 5", () => {
  const res = verifyAuditClaims({
    claims: [{ contract: "plot", line: 2, text: "她仰头把半杯白酒灌了下去。", why: "设定写她不喝酒" }],
    text: TEXT
  });
  assert.equal(res.total, 1);
  assert.equal(res.corrected.length, 1);
  assert.equal(res.accepted.length, 0);
  assert.equal(res.rejected.length, 0);
  assert.equal(res.corrected[0].foundLine, 5);
  assert.equal(res.corrected[0].line, 2, "原声明行号要保留，便于对照");
  assert.equal(res.corrected[0].reason, "行号已修正");
  assert.equal(res.score, 100);
});

// ---------------------------------------------------------------------------
// ③ rejected（编造）
// ---------------------------------------------------------------------------
test("原文在全文都不存在 → rejected，reason 含「编造」", () => {
  const res = verifyAuditClaims({
    claims: [{ contract: "banned", line: 3, text: "他拔出长剑斩断了桌角。", why: "越界" }],
    text: TEXT
  });
  assert.equal(res.total, 1);
  assert.equal(res.rejected.length, 1);
  assert.equal(res.accepted.length, 0);
  assert.equal(res.corrected.length, 0);
  assert.match(res.rejected[0].reason, /编造/);
  assert.equal(res.score, 0);
});

// ---------------------------------------------------------------------------
// ④ 空白归一
// ---------------------------------------------------------------------------
test("声明里多一个空格 → 归一空白后仍 accepted", () => {
  const res = verifyAuditClaims({
    claims: [{ contract: "lexicon", line: 5, text: "她仰头  把半杯白酒灌了下去。", why: "必用词场景" }],
    text: TEXT
  });
  assert.equal(res.accepted.length, 1, "多打的空格不应把真证据判废");
  assert.equal(res.rejected.length, 0);
  // 回填 text 用归一空白后的形态（\s+ → 单个空格）。
  assert.equal(res.accepted[0].text, "她仰头 把半杯白酒灌了下去。");
});

// ---------------------------------------------------------------------------
// ⑤ 非法输入不抛
// ---------------------------------------------------------------------------
test("claims 为空/非数组 → 不抛，total 0、score 0、reason 说明没有声明", () => {
  for (const claims of [null, undefined, [], "不是数组", 42, {}]) {
    const res = verifyAuditClaims({ claims, text: TEXT });
    assert.equal(res.total, 0);
    assert.equal(res.score, 0);
    assert.deepEqual(res.accepted, []);
    assert.deepEqual(res.corrected, []);
    assert.deepEqual(res.rejected, []);
    assert.match(res.reason, /没有待复核的声明/);
  }
});

// ---------------------------------------------------------------------------
// ⑥ 编造率 → score
// ---------------------------------------------------------------------------
test("3 条声明里 2 条编造 → score 约为 33（±1）", () => {
  const res = verifyAuditClaims({
    claims: [
      { contract: "plot", line: 1, text: "他推开门，走了进去。", why: "真实证据" },
      { contract: "plot", line: 2, text: "天上掉下一把金钥匙。", why: "编造一" },
      { contract: "banned", line: 4, text: "远处传来火车的汽笛。", why: "编造二" }
    ],
    text: TEXT
  });
  assert.equal(res.total, 3);
  assert.equal(res.accepted.length, 1);
  assert.equal(res.corrected.length, 0);
  assert.equal(res.rejected.length, 2);
  assert.ok(Math.abs(res.score - 33) <= 1, "score 实际为 " + res.score);
});

// ---------------------------------------------------------------------------
// ⑦ 去重（同一 contract+text 只保留第一条）
// ---------------------------------------------------------------------------
test("同一 contract+text 的重复声明只保留第一条", () => {
  const res = verifyAuditClaims({
    claims: [
      { contract: "plot", line: 1, text: "他推开门，走了进去。", why: "第一次" },
      { contract: "plot", line: 1, text: "他推开门，走了进去。", why: "重复" },
      { contract: "slop", line: 1, text: "他推开门，走了进去。", why: "不同契约不算重复" }
    ],
    text: TEXT
  });
  assert.equal(res.total, 2);
  assert.equal(res.accepted.length, 2);
  assert.equal(res.accepted[0].why, "第一次");
});

// ---------------------------------------------------------------------------
// ⑧ 非法行号 / 空原文
// ---------------------------------------------------------------------------
test("行号越界或原文为空 → rejected（reason 行号或原文缺失）", () => {
  const res = verifyAuditClaims({
    claims: [
      { contract: "plot", line: 99, text: "他推开门，走了进去。", why: "行号越界" },
      { contract: "plot", line: 1, text: "", why: "原文为空" },
      { contract: "plot", line: "1", text: "她把茶盏放在桌上。", why: "行号不是整数" },
      { contract: "plot", line: 0, text: "窗外下起了雨。", why: "0 起行号" }
    ],
    text: TEXT
  });
  assert.equal(res.total, 4);
  assert.equal(res.rejected.length, 4);
  assert.ok(res.rejected.every((item) => /行号或原文缺失/.test(item.reason)));
  assert.equal(res.score, 0);
});
