/**
 * 审查 #27 回归套件 —— 语义索引分块 ID 必须是**章内局部序号**。
 *
 * ## 被钉住的契约
 *
 * `lib/embedding.js` 的 `chunkText()` 会给每个语义段落生成 `id`，`buildIndexIncremental()`
 * 用 `id` 找旧条目、用 `textHash(text)` 判断内容是否变化（`old.th === th` 才复用向量）。
 *
 * 旧实现把 `id` 写成 `chapter + "#" + chunks.length`——`chunks.length` 是**本次切块累积的
 * 数组长度**，在"一次传入含多章标题的整段文本"时就是**全书全局下标**。后果：
 *   · 第 1 章增删一段 → 后面每一章每一块的 id 全部偏移；
 *   · `old.th === th` 只有在 id 也相同时才会被查到，于是**没改过的后续章节整批失效**，
 *     `buildIndexIncremental` 退化为对全书重跑 WASM 推理（大书几分钟）。
 *
 * 修复后：id = `chapter + "#" + 该章的局部序号`（每进入一个新 chapter，序号从 0 重新计），
 * 第 1 章的改动不再波及第 2 章。
 *
 * ## 怎么量"重算块数"（不依赖模型是否可用）
 *
 * 给旧索引条目喂一个**共享的哨兵向量**（引用相同），复用路径直接 `vec: old.vec`（引用相等），
 * 重算路径会 `downsample()` 生成**新数组**；模型不可用时重算块干脆被 `filter(Boolean)` 剔除。
 * 两种环境都能数出来：
 *   `重算块数 = chunks.length - 复用块数`
 * 所以本套在"有模型 / 没模型"的机器上都给出同一个结论，不 skip。
 *
 * 运行：node test/embedding-chunk-test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 隔离：失败路径的 logEvent("engine", …) 不得写进用户真实日志目录
const ROOT = join(tmpdir(), "dsh-embedding-chunk-" + process.pid + "-" + Date.now().toString(36));
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
process.env.DSH_NOVEL_WRITER_STATE = join(ROOT, "state.json");
process.on("exit", () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

const embedding = await import("../lib/embedding.js");

// ---------------------------------------------------------------------------
// 夹具：两章、每段以空行分隔（空行即 flush → 一段一块），段落均不足 150 字
// ---------------------------------------------------------------------------
const P = {
  a1: "他推开门，晨风卷着灰尘扑了进来。",
  a2: "屋里的桌椅还摆着，只是落了薄薄一层灰。",
  a3: "他把窗撑开，回头看了一眼空荡的灶台。",
  a4: "灶台边还留着半截没烧完的柴，他弯腰把它捡起来。",
  b1: "街口的面摊已经支起来了，热气慢慢往上升。",
  b2: "她把手揣进袖子里，站在檐下等了很久。",
  b3: "摊主掀开锅盖，白汽里飘出一股葱花的味道。"
};

const BASE_LINES = [
  "第1章 开端",
  P.a1, "",
  P.a2, "",
  P.a3, "",
  "第2章 转折",
  P.b1, "",
  P.b2, ""
];
/** 在第 1 章末尾加一段（会顶掉旧实现里第 2 章的全部 id） */
const CH1_EDITED_LINES = [
  "第1章 开端",
  P.a1, "",
  P.a2, "",
  P.a3, "",
  P.a4, "",
  "第2章 转折",
  P.b1, "",
  P.b2, ""
];
/** 在第 2 章末尾加一段（题面字面判据） */
const CH2_EDITED_LINES = [
  "第1章 开端",
  P.a1, "",
  P.a2, "",
  P.a3, "",
  "第2章 转折",
  P.b1, "",
  P.b2, "",
  P.b3, ""
];

const baseChunks = embedding.chunkText(BASE_LINES.join("\n"));
const ch1Chunks = baseChunks.filter((c) => c.chapter === "第1章 开端");
const ch2Chunks = baseChunks.filter((c) => c.chapter === "第2章 转折");

/** 与 embedding.js 内部 textHash 同口径（sha1 前 16 位十六进制） */
function textHash(text) {
  return createHash("sha1").update(String(text)).digest("hex").slice(0, 16);
}
/** 旧索引条目：共享同一个哨兵向量 → 复用与否可用引用相等区分 */
const SENTINEL_VEC = Object.freeze(Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0)));
function oldIndexFrom(chunks) {
  return chunks.map((c) => ({ id: c.id, text: c.text, th: textHash(c.text), vec: SENTINEL_VEC }));
}
/**
 * 跑一次增量构建，数"重算块数"：
 *   复用 → out 里保留 `vec === SENTINEL_VEC` 的条目；
 *   重算 → 生成新数组（有模型）或该条目缺失（无模型）。
 */
async function measureRecompute(chunks, oldItems) {
  const out = await embedding.buildIndexIncremental(chunks, oldItems);
  const reused = out.filter((it) => it.vec === SENTINEL_VEC).length;
  return { out, reused, recomputed: chunks.length - reused };
}

// ===========================================================================
// ① 分块 ID 形状：章内局部序号
// ===========================================================================
test("① chunkText 的 id 是章内局部序号（第 2 章从 #0 重新开始）", () => {
  assert.equal(ch1Chunks.length, 3, "第 1 章应为 3 块，实际：" + ch1Chunks.map((c) => c.id).join(","));
  assert.equal(ch2Chunks.length, 2, "第 2 章应为 2 块，实际：" + ch2Chunks.map((c) => c.id).join(","));

  assert.deepEqual(ch1Chunks.map((c) => c.id), ["第1章 开端#0", "第1章 开端#1", "第1章 开端#2"]);
  // 旧实现这里是 "第2章 转折#3" / "第2章 转折#4"（接着第 1 章往下数）
  assert.deepEqual(
    ch2Chunks.map((c) => c.id),
    ["第2章 转折#0", "第2章 转折#1"],
    "第 2 章的序号必须从 0 开始，不能接第 1 章的下标"
  );

  const allIds = baseChunks.map((c) => c.id);
  assert.equal(new Set(allIds).size, allIds.length, "块 ID 必须唯一：" + allIds.join(","));
  for (const c of baseChunks) {
    assert.equal(typeof c.text, "string");
    assert.ok(c.text.length > 0, "块文本不得为空");
  }
});

// ===========================================================================
// ② 稳定性的核心：改一章，另一章的 id 一个都不许漂
// ===========================================================================
test("② 第 1 章加一段：第 2 章块 ID / 文本哈希不变（旧实现会整批失效）", () => {
  const edited = embedding.chunkText(CH1_EDITED_LINES.join("\n"));
  const editedIds = new Set(edited.map((c) => c.id + "\u0000" + textHash(c.text)));
  for (const c of ch2Chunks) {
    assert.ok(
      editedIds.has(c.id + "\u0000" + textHash(c.text)),
      "第 1 章改动后第 2 章的块必须原样存在，实际丢了：" + c.id
    );
  }
  // 第 1 章原有的三块也保持原样（只多了一块新的）
  for (const c of ch1Chunks) {
    assert.ok(editedIds.has(c.id + "\u0000" + textHash(c.text)), "第 1 章原有块必须稳定：" + c.id);
  }
  assert.equal(edited.length, baseChunks.length + 1, "只应多出一块");
});

test("③ 第 2 章加一段：第 1 章块 ID / 文本哈希不变（题面字面判据）", () => {
  const edited = embedding.chunkText(CH2_EDITED_LINES.join("\n"));
  const editedIds = new Set(edited.map((c) => c.id + "\u0000" + textHash(c.text)));
  for (const c of ch1Chunks) {
    assert.ok(
      editedIds.has(c.id + "\u0000" + textHash(c.text)),
      "第 2 章改动后第 1 章的块必须原样存在，实际丢了：" + c.id
    );
  }
});

// ===========================================================================
// ④ 落到 buildIndexIncremental：重算块数必须只有"新增的那一块"
// ===========================================================================
test("④ 第 1 章加一段 → 第 2 章全部复用，重算块数 = 1", async () => {
  const oldItems = oldIndexFrom(baseChunks);
  const edited = embedding.chunkText(CH1_EDITED_LINES.join("\n"));
  const { out, reused, recomputed } = await measureRecompute(edited, oldItems);

  assert.equal(recomputed, 1, "重算块数应为 1（只有新增段），实际 " + recomputed + "，复用 " + reused);
  for (const c of ch2Chunks) {
    assert.ok(
      out.some((it) => it.id === c.id && it.vec === SENTINEL_VEC),
      "第 2 章的块必须复用旧向量，而不是重跑推理：" + c.id
    );
  }
  // 未复用的块（不论模型可用与否都能数出来）：只允许是新增的那一段
  const notReused = edited.filter((c) => !out.some((it) => it.id === c.id && it.vec === SENTINEL_VEC));
  assert.equal(notReused.length, 1, "未复用的只能是新增段，实际：" + notReused.map((c) => c.id).join(","));
  assert.equal(notReused[0].text, P.a4, "未复用的块文本应为新增段，实际：" + String(notReused[0]?.text).slice(0, 20));
});

test("⑤ 第 2 章加一段 → 第 1 章全部复用，重算块数 = 1", async () => {
  const oldItems = oldIndexFrom(baseChunks);
  const edited = embedding.chunkText(CH2_EDITED_LINES.join("\n"));
  const { out, reused, recomputed } = await measureRecompute(edited, oldItems);

  assert.equal(recomputed, 1, "重算块数应为 1（只有新增段），实际 " + recomputed + "，复用 " + reused);
  for (const c of ch1Chunks) {
    assert.ok(
      out.some((it) => it.id === c.id && it.vec === SENTINEL_VEC),
      "第 1 章的块必须复用旧向量，而不是重跑推理：" + c.id
    );
  }
});

// ===========================================================================
// ⑥ 同一章名重复出现（合卷/多卷同名章）时，局部序号也不能撞号
// ===========================================================================
test("⑥ 同名章重复出现时块 ID 仍唯一（不得给不同段落喂同一个旧向量）", () => {
  const text = [
    "番外 一",
    P.a1, "",
    P.a2, "",
    "番外 一",
    P.b1, "",
    P.b2, ""
  ].join("\n");
  const chunks = embedding.chunkText(text);
  const ids = chunks.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "同名章的块 ID 撞号了：" + ids.join(","));
  assert.equal(ids.filter((id) => id.startsWith("番外 一#")).length, 4, "四块都应落在「番外 一」名下：" + ids.join(","));
});
