/**
 * 结构视图（lib/graph.js）的判定边界回归测试 —— v7.0.0 审查修复 #18 / #19 / #52 / #54。
 *
 * 这个文件只锁"跨章度量与聚类的边界"，不重复 e2e 的字段存在性检查：
 *   ① #18 空档风险：相邻连续章节的章号差天然是 1，`gap > 0` 会把**连续出场**误报成风险；
 *      正确门槛是 `gap > 1`（中间真的缺了章才报）。连续 1..5 章出场 → 不报；第 3 章缺席 → gap=2 → 报。
 *   ② #19 最久未回收伏笔：本章刚埋（distance=0）不得被说成"已过 0 章仍未回收"。
 *   ③ #52 大纲方向行：`- 第3节 方向` 必须能解析（与 brief.parseNumberedLines 的「章回话节」口径一致）。
 *   ④ #54 关键词聚类：1 字实体（"雪"）不得参与跨条目合并；2 字实体照常聚类（过滤不能过头）。
 *
 * 每个用例都用临时书库（mkdtemp），只读 buildStoryGraph，不触碰真实数据。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildStoryGraph } from "../lib/graph.js";

const INLINE_CONTENT = "青锋剑谱残页";

/** 造一个最小书库：章节正文 + （可选）伏笔表 / 设定表 / 创作资料大纲 */
async function makeLibrary(book, { chapters, plots, settings, outline }) {
  const root = await mkdtemp(join(tmpdir(), "dsh-graph-risk-"));
  const dir = join(root, "novels", book);
  await mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(chapters)) {
    await writeFile(join(dir, file), text, "utf8");
  }
  if (plots) {
    const plotDir = join(root, ".novel-writer", "plots");
    await mkdir(plotDir, { recursive: true });
    await writeFile(join(plotDir, book + ".json"), JSON.stringify({ entries: plots }), "utf8");
  }
  if (settings) {
    const settingsDir = join(root, ".novel-writer", "settings");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, book + ".json"), JSON.stringify(settings), "utf8");
  }
  if (outline) {
    const creationDir = join(root, "novels", "创作资料", book);
    await mkdir(creationDir, { recursive: true });
    await writeFile(join(creationDir, "剧情大纲.md"), outline, "utf8");
  }
  return root;
}

async function withLibrary(options, run) {
  const root = await makeLibrary(options.book, options);
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const EMPTY_SETTINGS = { characters: [], timeline: [] };

// ── ① #18 空档风险：gap > 1 才是"缺章" ─────────────────────────────────────

test("#18 连续 1..5 章都出场的线（gap=1）不得进入【风险】", async () => {
  const chapters = {};
  for (let n = 1; n <= 5; n += 1) {
    chapters["第0" + n + "章.md"] = "他取出" + INLINE_CONTENT + "，借着灯光细看。";
  }
  await withLibrary({
    book: "连续线",
    chapters,
    plots: [{ id: "p1", content: INLINE_CONTENT, status: "open", type: "道具" }],
    settings: EMPTY_SETTINGS
  }, async (root) => {
    const graph = await buildStoryGraph(root, "连续线", {});
    // 前提：这条线确实连续出现在 1..5 章（gap 是章号差，相邻章 = 1）
    assert.equal(graph.threadActivity.length, 1, JSON.stringify(graph.threadActivity));
    assert.deepEqual(graph.threadActivity[0].chapters, [1, 2, 3, 4, 5]);
    assert.equal(graph.threadActivity[0].gap, 1, "相邻章差值的最大值应为 1");
    // 旧行为：filter(t => t.gap > 0) 会命中 gap=1 → 输出"空档最大的是…（空档 1 章）"
    assert.ok(
      !graph.summary.includes("空档最大的是"),
      "连续出场（gap=1）被误报成空档风险：" + graph.summary
    );
  });
});

test("#18 第 3 章缺席（gap=2）才报空档风险", async () => {
  const chapters = {
    "第01章.md": "他取出" + INLINE_CONTENT + "，借着灯光细看。",
    "第02章.md": "他把" + INLINE_CONTENT + "塞回怀里。",
    "第03章.md": "他在灯下磨刀，一言不发。",
    "第04章.md": "她又展开" + INLINE_CONTENT + "。",
    "第05章.md": "他把" + INLINE_CONTENT + "交给掌柜。"
  };
  await withLibrary({
    book: "缺章线",
    chapters,
    plots: [{ id: "p1", content: INLINE_CONTENT, status: "open", type: "道具" }],
    settings: EMPTY_SETTINGS
  }, async (root) => {
    const graph = await buildStoryGraph(root, "缺章线", {});
    assert.equal(graph.threadActivity.length, 1, JSON.stringify(graph.threadActivity));
    assert.deepEqual(graph.threadActivity[0].chapters, [1, 2, 4, 5]);
    assert.equal(graph.threadActivity[0].gap, 2);
    assert.ok(graph.summary.includes("空档最大的是"), "gap=2 应当报空档风险：" + graph.summary);
    assert.ok(graph.summary.includes("空档 2 章"), "风险里应写明空档 2 章：" + graph.summary);
  });
});

// ── ② #19 distance === 0 不得进入"埋得最久" ─────────────────────────────────

test("#19 本章刚埋下（distance=0）的伏笔不得输出「已过 0 章仍未回收」", async () => {
  await withLibrary({
    book: "新伏笔",
    chapters: { "第01章.md": "他取出" + INLINE_CONTENT + "，在灯下摊开。" },
    plots: [{ id: "p1", content: INLINE_CONTENT, status: "open", type: "道具" }],
    settings: EMPTY_SETTINGS
  }, async (root) => {
    const graph = await buildStoryGraph(root, "新伏笔", {});
    assert.equal(graph.plotLifecycle.length, 1);
    assert.equal(graph.plotLifecycle[0].distance, 0, "单章书里刚埋的伏笔 distance 应为 0");
    assert.ok(!graph.summary.includes("已过 0 章"), "distance=0 被当成风险：" + graph.summary);
    assert.ok(!graph.summary.includes("埋得最久的是"), "distance=0 不应进入最久未回收：" + graph.summary);
  });
});

test("#19 有 distance>0 的旧伏笔时，最久风险仍正常输出（只排除 0）", async () => {
  await withLibrary({
    book: "新旧伏笔",
    chapters: {
      "第01章.md": "他第一次取出" + INLINE_CONTENT + "。",
      "第02章.md": "风停了。",
      "第03章.md": "天亮了。"
    },
    plots: [
      { id: "old", content: INLINE_CONTENT, status: "open", type: "道具" },
      { id: "new", content: "账本密信", status: "open" }
    ],
    settings: EMPTY_SETTINGS
  }, async (root) => {
    const graph = await buildStoryGraph(root, "新旧伏笔", {});
    const oldItem = graph.plotLifecycle.find((p) => p.id === "old");
    assert.equal(oldItem.distance, 2);
    assert.ok(graph.summary.includes("埋得最久的是 #old"), "仍有 distance>0 的旧伏笔时应照常提示：" + graph.summary);
  });
});

// ── ③ #52 大纲方向行：章 / 回 / 话 / 节 ─────────────────────────────────────

test("#52 「- 第3节 方向」能被大纲对照解析（与 brief 的章回话节口径一致）", async () => {
  await withLibrary({
    book: "节气书",
    chapters: {
      "第01章.md": "他推门进屋，壁炉里还有余温。",
      "第02章.md": "她在廊下追上了他，两人低声争执。",
      "第03章.md": "他摸黑翻进祠堂，取走牌位后的木匣。"
    },
    outline: [
      "# 剧情大纲",
      "",
      "- 第1章 推门进屋",
      "- 第2章 廊下争执",
      "- 第3节 夜探祠堂",
      ""
    ].join("\n")
  }, async (root) => {
    const graph = await buildStoryGraph(root, "节气书", {});
    const numbers = graph.planVsActual.map((row) => row.number).sort((a, b) => a - b);
    assert.deepEqual(numbers, [1, 2, 3], "「- 第3节 …」没有被解析：" + JSON.stringify(graph.planVsActual));
    const row3 = graph.planVsActual.find((row) => row.number === 3);
    assert.equal(row3.direction, "夜探祠堂");
  });
});

// ── ④ #54 聚类必须过滤 1 字实体 ─────────────────────────────────────────────

test("#54 两个条目各自只有 1 字实体「雪」→ 不得合并（单字不做子串匹配）", async () => {
  await withLibrary({
    book: "单字实体",
    chapters: {
      "第01章.md": "他在雪里挖出青锋剑谱残页。",
      "第02章.md": "她在雪里翻到账本密信。"
    },
    plots: [
      { id: "p1", content: "青锋剑谱", status: "open", relatedCharacters: ["雪"] },
      { id: "p2", content: "账本密信", status: "open", relatedCharacters: ["雪"] }
    ],
    settings: EMPTY_SETTINGS
  }, async (root) => {
    const graph = await buildStoryGraph(root, "单字实体", {});
    // 旧行为：tokens 里保留「雪」→ 两条共享 token → 并成 1 条线（跨条目假阳性合并）
    assert.equal(graph.threadActivity.length, 2, "1 字实体把两条不相干的线并成了一条：" + JSON.stringify(graph.threadActivity));
  });
});

test("#54 反证：2 字共享实体「林昭」仍能正常聚类（过滤只针对单字）", async () => {
  await withLibrary({
    book: "双字实体",
    chapters: {
      "第01章.md": "林昭在雪里挖出青锋剑谱残页。",
      "第02章.md": "林昭把账本密信藏进怀里。"
    },
    plots: [
      { id: "p1", content: "青锋剑谱", status: "open", relatedCharacters: ["林昭"] },
      { id: "p2", content: "账本密信", status: "open", relatedCharacters: ["林昭"] }
    ],
    settings: EMPTY_SETTINGS
  }, async (root) => {
    const graph = await buildStoryGraph(root, "双字实体", {});
    assert.equal(graph.threadActivity.length, 1, "2 字共享实体应当合并：" + JSON.stringify(graph.threadActivity));
  });
});
