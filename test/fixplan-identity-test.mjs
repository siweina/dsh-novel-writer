/**
 * v7.0.0 修复回归：改稿台 / 开写包的**身份稳定性**与时序话术。
 *
 * 覆盖缺陷：#21（无方向行必须登记跳过）、#22（AI 套话指纹基于类别）、#23（大纲漏写 id 不随行数漂移）、
 *            #24（伏笔未回收的兜底身份分支）、#17（伏笔三态话术）。
 *
 * 为什么单开这个文件：这五条的共同点是「跨两次调用的稳定性」——plan 一次、改一点正文、verify 再一次。
 * 单章内的确定性断言（向量算法等）在 vector-audit-test.mjs；这里只钉调用之间的连续性。
 * 每个用例用独立的临时书库根，互不污染，结束后删除（不写仓库目录）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildFixPlan, verifyFixPlan } from "../lib/fixplan.js";
import { buildChapterBrief } from "../lib/brief.js";

// ─────────────────────────────────────────────────────────────────────────────
// 夹具工具
// ─────────────────────────────────────────────────────────────────────────────

/** 建一个临时书库根；返回 { root, write, cleanup } */
function makeLibrary() {
  const root = mkdtempSync(join(tmpdir(), "fixplan-identity-"));
  return {
    root,
    write(rel, text) {
      const file = join(root, rel);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, text, "utf8");
    },
    read(rel) {
      return readFileSync(join(root, rel), "utf8");
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** 把落盘清单替换成指定 items（用于模拟「上一轮生成的清单」）。 */
function rewritePlan(planFile, items) {
  const saved = JSON.parse(readFileSync(planFile, "utf8"));
  saved.items = items;
  saved.detectedIds = items.map((it) => it.id);
  writeFileSync(planFile, JSON.stringify(saved, null, 2), "utf8");
}

const NORMAL = "雨停之后，她沿着河堤慢慢往回走。岸边的芦苇被风吹得伏下去，又立起来。她把伞收好，抖了抖水，抬头看了看天色。";
const NORMAL2 = "回到院子里，她先把湿鞋放在台阶上，再进屋点了灯。灯芯短，光只照亮半张桌子。";
const NEUTRAL = [
  "她把杯子放下，说了一句不相干的话，然后看向窗外。院子里的水洼映着天光，慢慢变暗。",
  "",
  "他看着她，把手里的笔搁下，没有说话，手指在桌面上轻轻敲了两下。",
  "",
  "风从窗缝里进来，灯影晃了晃，墙上的影子散开又聚拢。",
  ""
].join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// 缺陷 #22：AI 套话的身份指纹必须基于**类别**，而不是第一处命中原文
// ─────────────────────────────────────────────────────────────────────────────

test("#22 同类套话只改掉第一处：verify 必须是 pending 1 项，不能同时出现 resolved 与 new", async () => {
  const lib = makeLibrary();
  const BOOK = "套话指纹样本";
  try {
    // 两处命中同属 smirk_cliche（嘴角类），但**原文片段不同**：
    // 旧指纹取 hits[0].text，改掉第一处后片段会变成另一处 → 旧项 resolved + 新项 new。
    lib.write(join("novels", BOOK, "第01章.md"), NORMAL + NORMAL2);
    lib.write(join("novels", BOOK, "第02章.md"), [
      "她把杯子放下，说了一句不相干的话，然后看向窗外。",
      "",
      "他看着她，嘴角勾起，没有说话，手指在桌面上轻轻敲了两下。",
      "",
      "风从窗缝里进来，灯影晃了晃，墙上的影子散开又聚拢。",
      "",
      "她转过脸，似笑非笑，把桌上的纸推到一边，起身往门口走。",
      ""
    ].join("\n"));

    const plan = await buildFixPlan(lib.root, BOOK, "第02章", {}, undefined);
    const slop = plan.items.filter((it) => it.type === "AI套话");
    assert.equal(slop.length, 1, "同一类别应只归并成一条待办，实际：" + JSON.stringify(plan.items.map((i) => i.type)));
    assert.ok(/^类别：smirk_cliche/.test(slop[0].current), "顺带钉住类别进 current 的固定前缀（供指纹取回）：" + slop[0].current);
    assert.equal(slop[0].locate.excerpt, "嘴角勾起", "第一处命中原文（旧指纹的取值）");
    assert.equal(plan.items.length, 1, "夹具应只产出一条待办，便于按全局计数断言：" + JSON.stringify(plan.items.map((i) => i.type)));

    // 只改掉第一处（保留第二处）：新清单的 hits[0] 变成「似笑非笑」，行号也随之前移
    lib.write(join("novels", BOOK, "第02章.md"), [
      "她把杯子放下，说了一句不相干的话，然后看向窗外。",
      "",
      "他看着她，把手里的笔搁下，没有说话，手指在桌面上轻轻敲了两下。",
      "",
      "风从窗缝里进来，灯影晃了晃，墙上的影子散开又聚拢。",
      "",
      "她转过脸，似笑非笑，把桌上的纸推到一边，起身往门口走。",
      ""
    ].join("\n"));

    const verified = await verifyFixPlan(lib.root, BOOK, "第02章", {}, undefined);
    const resolved = verified.checked.filter((c) => c.status === "resolved").length;
    const pending = verified.checked.filter((c) => c.status === "pending").length;
    const added = verified.checked.filter((c) => c.status === "new").length;
    assert.equal(resolved, 0, "同一类套话不许被判成已解决：" + JSON.stringify(verified.checked));
    assert.equal(added, 0, "同一类套话不许被当成新检出：" + JSON.stringify(verified.checked));
    assert.equal(pending, 1, "应保留 1 项待处理：" + JSON.stringify(verified.checked));
    assert.equal(verified.checked[0].type, "AI套话");
    assert.ok(verified.checked[0].detail.includes("问题仍存在"), "detail 应说明问题仍存在：" + verified.checked[0].detail);
    assert.ok(verified.summary.includes("已解决 0 项"), "summary 口径：" + verified.summary);
    assert.ok(verified.summary.includes("新检出 0 项"), "summary 口径：" + verified.summary);
  } finally {
    lib.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 缺陷 #23：大纲漏写是「跨章属性」，id 不许随章内行数（空行）漂移
// ─────────────────────────────────────────────────────────────────────────────

test("#23 大纲漏写 id 与章内行数无关：只差空行数的同一章，同一子句的 id 必须相同", async () => {
  const lib = makeLibrary();
  const BOOK = "大纲ID样本";
  try {
    lib.write(join("novels", BOOK, "第01章.md"), NORMAL + NORMAL2);
    const chapterText = [
      "她把杯子放下，说了一句不相干的话，然后看向窗外。院子里的水洼映着天光，慢慢变暗，墙根下的青苔湿了一片，踩上去有些滑。",
      "",
      "他看着她，把手里的笔搁下，没有说话，手指在桌面上轻轻敲了两下，声音不大，却让屋里更静了。",
      "",
      "风从窗缝里进来，灯影晃了晃，墙上的影子散开又聚拢。她转过脸，把桌上的纸推到一边，起身往门口走，袖口扫过椅背。",
      "",
      "门轴响了一声，檐下的水珠断了线，落进台阶边的青苔里。院墙外有脚步声过去，很快又安静下来，只剩远处的水声。",
      "",
      "她站在门槛上停了一会儿，回头看了一眼屋里那盏灯，灯芯短了，光只照到桌子一半，另外半边落在暗处。",
      ""
    ].join("\n");
    lib.write(join("novels", BOOK, "第02章.md"), chapterText);
    lib.write(join("novels", "创作资料", BOOK, "剧情大纲.md"), "# 剧情大纲\n\n- 2 登上城楼点燃烽火号令三军\n");

    const first = await buildFixPlan(lib.root, BOOK, "第02章", {}, undefined);
    const miss1 = first.items.find((it) => it.type === "大纲漏写");
    assert.ok(miss1, "夹具应检出 1 条大纲漏写（子句完全未写）；实际：" + JSON.stringify(first.items.map((i) => i.type)));
    assert.equal(miss1.effort, 3, "effort 必须落在约定区间 1..3（旧版传 4）：" + miss1.effort);
    // 全章属性沿用本文件 0/0 约定（与伏笔未回收 / 衔接整体 / 指标全章一致）
    assert.deepEqual(miss1.locate, { lineStart: 0, lineEnd: 0, excerpt: "" }, "全章属性用 0/0 且不带 excerpt：" + JSON.stringify(miss1.locate));
    assert.ok(miss1.hint.includes("全章层面"), "0/0 项的 hint 必须说明是全章层面（e2e 契约）：" + miss1.hint);

    // 只在章首插入空行：行数变了、正文一字未改 → 同一子句的 id 必须一模一样
    lib.write(join("novels", BOOK, "第02章.md"), "\n\n" + chapterText);
    const second = await buildFixPlan(lib.root, BOOK, "第02章", {}, undefined);
    const miss2 = second.items.find((it) => it.type === "大纲漏写");
    assert.ok(miss2, "第二次也应检出大纲漏写：" + JSON.stringify(second.items.map((i) => i.type)));
    assert.equal(miss2.id, miss1.id, "空行变化不得改变 id（旧版 lineEnd 绑全章行数 → id 漂移）");
    assert.deepEqual(miss2.locate, miss1.locate, "定位也不该随行数变化");
  } finally {
    lib.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 缺陷 #21：没有大纲方向行 = 这一域没检查，verify 不许把旧「大纲漏写」判成 resolved
// ─────────────────────────────────────────────────────────────────────────────

test("#21 无方向行时 vector_outline 必须登记跳过：旧「大纲漏写」项复测保持 pending（不是 resolved）", async () => {
  const lib = makeLibrary();
  const BOOK = "无方向行样本";
  try {
    lib.write(join("novels", BOOK, "第01章.md"), NORMAL + NORMAL2);
    lib.write(join("novels", BOOK, "第02章.md"), NEUTRAL);
    // 故意不建创作资料/剧情大纲.md → readOutlineDirection 返回 ""

    const plan = await buildFixPlan(lib.root, BOOK, "第02章", {}, undefined);
    assert.equal(plan.items.length, 0, "无方向行时本次不应检出待办：" + JSON.stringify(plan.items.map((i) => i.type)));

    // 模拟上一轮留下的「大纲漏写」项（v5/v6 版本落盘的清单）
    const stale = {
      id: "fix-outline-miss-1-deadbeef",
      type: "大纲漏写",
      locate: { lineStart: 1, lineEnd: 1, excerpt: "登上城楼点燃烽火号令三军" },
      current: "大纲节点「登上城楼点燃烽火号令三军」未检出对应段落（最高相似度 0.2）",
      target: "让这条大纲有落点",
      anchor: "",
      severity: 4,
      effort: 3,
      hint: "先确认是不是真的漏写",
      state: "open",
      stateAt: null
    };
    rewritePlan(plan.planFile, [stale]);

    const verified = await verifyFixPlan(lib.root, BOOK, "第02章", {}, undefined);
    const entry = verified.checked.find((c) => c.id === stale.id);
    assert.ok(entry, "verify 必须回报清单里的旧项：" + JSON.stringify(verified.checked));
    assert.equal(entry.status, "pending", "没跑 ≠ 已解决：旧「大纲漏写」必须保持 pending：" + JSON.stringify(entry));
    assert.ok(entry.detail.includes("未找到本章大纲方向行"), "detail 要写明跳过原因（skipScope 的 reason）：" + entry.detail);
    assert.ok(verified.summary.includes("无法复测"), "summary 要披露无法复测：" + verified.summary);
    assert.ok(verified.summary.includes("大纲兑现"), "summary 要写明是哪一域：" + verified.summary);
  } finally {
    lib.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 缺陷 #24：`伏笔未回收` 的兜底身份分支（旧清单 id 漂移时仍能认作同一项）
// ─────────────────────────────────────────────────────────────────────────────

test("#24 伏笔未回收：旧项 id 与本次不同，也能按伏笔编号兜底匹配（pending，不是 resolved）", async () => {
  const lib = makeLibrary();
  const BOOK = "伏笔身份样本";
  try {
    lib.write(join("novels", BOOK, "第01章.md"), NORMAL + NORMAL2);
    lib.write(join("novels", BOOK, "第02章.md"), NEUTRAL);
    lib.write(join(".novel-writer", "plots", BOOK + ".json"), JSON.stringify({
      book: BOOK,
      entries: [{ id: "p1", content: "河堤上那盏旧灯是谁换的", status: "open", priority: "high", chapter: "第01章" }]
    }, null, 2));

    // plotStaleChapters: 1 → 第 1 章登记、目标第 2 章，distance=1 即算「未回收」
    const opts = { plotStaleChapters: 1 };
    const plan = await buildFixPlan(lib.root, BOOK, "第02章", opts, undefined);
    const plot = plan.items.find((it) => it.type === "伏笔未回收");
    assert.ok(plot, "夹具应检出 1 条伏笔未回收：" + JSON.stringify(plan.items.map((i) => i.type)));
    assert.ok(plot.current.includes("#p1"), "伏笔条目编号必须能在 current 里取回（兜底指纹用）：" + plot.current);

    // 模拟旧格式清单：同一伏笔，但 id 与本次不同
    rewritePlan(plan.planFile, [{ ...plot, id: "fix-plot-0-oldid000", state: "open", stateAt: null }]);
    const verified = await verifyFixPlan(lib.root, BOOK, "第02章", opts, undefined);
    const entry = verified.checked.find((c) => c.type === "伏笔未回收");
    assert.ok(entry, "verify 应回报伏笔项（可含 new/pending）：" + JSON.stringify(verified.checked));
    assert.notEqual(entry.id, plot.id, "本用例确实走的是「id 不同」的兜底路径");
    assert.equal(entry.status, "pending", "旧项 id 不同但伏笔编号相同 → 兜底命中，应保持 pending（旧版恒 resolved）");
  } finally {
    lib.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 缺陷 #17：开写包伏笔时序三态（后文才埋 / 本章计划埋 / 已埋 N 章）
// ─────────────────────────────────────────────────────────────────────────────

test("#17 伏笔三态话术：first>target 不许催提前埋；first===target 是「计划首次埋下」；first<target 才是「已埋 N 章」", async () => {
  const lib = makeLibrary();
  const BOOK = "伏笔三态样本";
  try {
    lib.write(join("novels", BOOK, "第01章.md"), NORMAL + NORMAL2);
    lib.write(join("novels", BOOK, "第02章.md"), NORMAL + NORMAL2);
    lib.write(join(".novel-writer", "plots", BOOK + ".json"), JSON.stringify({
      book: BOOK,
      entries: [
        { id: "p1", content: "河堤上那盏旧灯是谁换的", status: "open", priority: "high", chapter: "第01章" },
        { id: "p3", content: "门轴上的新油是谁抹的", status: "open", priority: "high", chapter: "第03章" },
        { id: "p5", content: "城楼上的烽火号令三军", status: "open", priority: "high", chapter: "第05章" }
      ]
    }, null, 2));

    // 目标第 3 章（尚未创建）：p1 已埋 2 章；p3 本章计划首次埋下；p5 后文才埋
    const brief = await buildChapterBrief(lib.root, BOOK, "第03章", { budget: "compact" }, undefined);
    const lines = brief.plan.checklist.filter((x) => x.includes("未回收伏笔"));
    const lineOf = (id) => lines.find((x) => x.includes("#" + id + "（"));
    const l1 = lineOf("p1");
    const l3 = lineOf("p3");
    const l5 = lineOf("p5");
    assert.ok(l1 && l3 && l5, "三条伏笔都应进清单：" + JSON.stringify(lines));

    // ① first < target：已埋 N 章 → 顺势推进/回收
    assert.ok(l1.includes("已埋 2 章"), "first<target 应写「已埋 N 章」：" + l1);
    assert.ok(l1.includes("推进/回收"), "first<target 应给推进/回收方向：" + l1);

    // ② first === target：本章计划首次埋下（不许说「已埋 0 章」）
    assert.ok(l3.includes("本章**计划**首次埋下"), "first===target 应写「本章计划首次埋下」：" + l3);
    assert.ok(!l3.includes("已埋 0 章"), "first===target 不许说「已埋 0 章」（旧缺陷）：" + l3);

    // ③ first > target：本章尚未埋下（后文才埋）→ 不许提前泄露
    assert.ok(l5.includes("本章尚未埋下"), "first>target 应写「本章尚未埋下」：" + l5);
    assert.ok(l5.includes("不要提前泄露"), "first>target 应明确不要提前泄露：" + l5);
    assert.ok(!l5.includes("本章将首次埋下"), "first>target 不许催「本章将首次埋下」（旧缺陷）：" + l5);

    // openPlots 上的 notYetPlanted 只该标在后文才埋的那条（字段语义不变）
    const flags = brief.openPlots.map((p) => [p.id, p.notYetPlanted === true]);
    assert.deepEqual(flags, [["p1", false], ["p3", false], ["p5", true]], "notYetPlanted 只属于 first>target 的那条：" + JSON.stringify(flags));
  } finally {
    lib.cleanup();
  }
});
