/**
 * test/lexicon-test.mjs —— v6.2.0「必用词表 / 优先用词」回归测试
 *
 * 覆盖四层：
 *   ① 解析与归一（批量行、脏数据守卫、自身词剔除）
 *   ② 数据层（书级 + 全局两层合并、书级覆盖、层开关、文件落盘）
 *   ③ 工具 novel_lexicon（add / import / list / update / delete / scan / audit / export / toggle + 输出契约）
 *   ④ 接线（开写包硬清单注入与开关门禁、场景命中排序、截断说明）
 *
 * 隔离：状态文件走 env 指向的临时目录（与 e2e 同口径），不碰真实 ~/.dsh。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import {
  ALL_TOOLS,
  GLOBAL_LEXICON_BOOK,
  auditLexicon,
  lexiconFile,
  mergeLexiconEntries,
  normalizeLexiconEntry,
  parseLexiconLine,
  readLexicon,
  selectLexiconForBrief,
  writeLexicon
} from "../lib/core.js";
import { buildChapterBrief } from "../lib/brief.js";

const testRoot = join(tmpdir(), "dsh-lexicon-test-" + process.pid + "-" + Date.now().toString(36));
process.env.DSH_NOVEL_WRITER_STATE = join(testRoot, "state-test.json");
process.on("exit", () => {
  try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

const registry = [];
const ctx = {
  tools: { register: (d) => { registry.push(d); return () => {}; } },
  systemPrompt: { section: () => () => {} },
  inject: () => {}
};
apply(ctx, { root: testRoot });
const defs = Object.fromEntries(registry.map((d) => [d.name, d]));
const exec = { agent: { session: { header: { cwd: testRoot } } } };
const BOOK = "词表书";

await mkdir(join(testRoot, "novels", BOOK), { recursive: true });
await writeFile(join(testRoot, "novels", BOOK, "第01章.md"), "他抬头看星轨。\n轨道在窗外交错。\n青铜灯亮着。\n", "utf8");

// ---------------------------------------------------------------------------
// ① 解析与归一
// ---------------------------------------------------------------------------
test("批量行解析：三种写法都认，注释与空行跳过", () => {
  assert.deepEqual(parseLexiconLine("星轨"), { term: "星轨" });
  const piped = parseLexiconLine("星轨 | 专名 | 战斗 | 轨道,轨迹 | 跃迁场面用");
  assert.equal(piped.term, "星轨");
  assert.equal(piped.kind, "专名");
  assert.equal(piped.scene, "战斗");
  assert.deepEqual(piped.avoid, ["轨道", "轨迹"]);
  assert.equal(piped.note, "跃迁场面用");
  const tabbed = parseLexiconLine("星轨\t专名\t战斗\t轨道\t备注");
  assert.equal(tabbed.kind, "专名");
  assert.deepEqual(tabbed.avoid, ["轨道"]);
  assert.equal(parseLexiconLine("   # 这是注释"), null);
  assert.equal(parseLexiconLine("   "), null);
});

test("词条归一：空词条丢弃、自身词从替身表剔除、脏数据不炸", () => {
  assert.equal(normalizeLexiconEntry(""), null);
  assert.equal(normalizeLexiconEntry({ term: "   " }), null);
  assert.equal(normalizeLexiconEntry(null), null);
  assert.equal(normalizeLexiconEntry(123), null);
  const entry = normalizeLexiconEntry({ term: "星轨", avoid: ["星轨", "轨道", "轨道"], aliases: "星路,星链", priority: "high", enabled: false });
  assert.deepEqual(entry.avoid, ["轨道"]);
  assert.deepEqual(entry.aliases, ["星路", "星链"]);
  assert.equal(entry.priority, "high");
  assert.equal(entry.enabled, false);
});

// ---------------------------------------------------------------------------
// ② 数据层：两层合并 + 书级覆盖 + 层开关
// ---------------------------------------------------------------------------
test("两层合并：书级同名条目覆盖全局；层开关关闭时该层不参与", async () => {
  await writeLexicon(testRoot, GLOBAL_LEXICON_BOOK, { entries: [{ term: "星轨", kind: "专名", note: "全局版" }, { term: "潮汐税", kind: "偏好词" }] });
  await writeLexicon(testRoot, BOOK, { entries: [{ term: "星轨", kind: "场景词", note: "本书版" }, { term: "青铜灯" }] });
  const lex = await readLexicon(testRoot, BOOK);
  assert.deepEqual(lex.counts, { global: 2, book: 2, effective: 3 });
  const star = lex.entries.find((e) => e.term === "星轨");
  assert.equal(star.scope, "book");
  assert.equal(star.kind, "场景词");
  assert.equal(star.note, "本书版");

  await writeLexicon(testRoot, GLOBAL_LEXICON_BOOK, { entries: [{ term: "星轨", kind: "专名" }, { term: "潮汐税" }], enabled: false });
  const off = await readLexicon(testRoot, BOOK);
  assert.equal(off.counts.effective, 2);
  assert.equal(off.entries.find((e) => e.term === "星轨").scope, "book");
  assert.equal(off.entries.some((e) => e.term === "潮汐税"), false);
  await writeLexicon(testRoot, GLOBAL_LEXICON_BOOK, { entries: [{ term: "星轨", kind: "专名" }, { term: "潮汐税" }], enabled: true });
});

test("合并追加：同名覆盖可关（overwrite=false 时进 skipped）", () => {
  const first = mergeLexiconEntries([{ term: "星轨", kind: "专名" }], [{ term: "星轨", kind: "偏好词" }, { term: "青铜灯" }], {});
  assert.deepEqual(first.added, ["青铜灯"]);
  assert.deepEqual(first.updated, ["星轨"]);
  assert.equal(first.entries.find((e) => e.term === "星轨").kind, "偏好词");
  const second = mergeLexiconEntries([{ term: "星轨" }], [{ term: "星轨", kind: "偏好词" }], { overwrite: false });
  assert.deepEqual(second.skipped, ["星轨"]);
  assert.equal(second.entries[0].kind, void 0);
});

// ---------------------------------------------------------------------------
// ③ 工具
// ---------------------------------------------------------------------------
test("novel_lexicon 已进 ALL_TOOLS 且在注册表内", () => {
  assert.ok(ALL_TOOLS.includes("novel_lexicon"));
  assert.ok(defs.novel_lexicon);
});

test("add / import / list：批量登记与两层查询", async () => {
  // 从空表起步（上面的数据层用例写过两层，这里复位以保证新增/更新的判定确定）
  await writeLexicon(testRoot, BOOK, { entries: [] });
  await writeLexicon(testRoot, GLOBAL_LEXICON_BOOK, { entries: [] });
  const add = await defs.novel_lexicon.execute(
    { action: "add", book: BOOK, terms: ["星轨", "青铜灯"], kind: "专名", avoid: ["轨道"], root: testRoot },
    exec
  );
  assert.deepEqual(add.added, ["星轨", "青铜灯"]);
  assert.deepEqual(add.updated, []);
  assert.equal(add.action, "add");
  assert.equal(typeof add.message, "string");

  const imp = await defs.novel_lexicon.execute(
    { action: "import", scope: "global", text: "北境哨塔|专名||哨所\n雾港\n# 注释行\n潮汐税|偏好词|税务|收税,人头税|向海神缴的税", root: testRoot },
    exec
  );
  assert.equal(imp.added.length, 3);

  const list = await defs.novel_lexicon.execute({ action: "list", book: BOOK, scope: "all", root: testRoot }, exec);
  assert.equal(list.counts.global, 3);
  assert.equal(list.counts.book, 2);
  assert.equal(list.counts.effective, 5);
  const tax = list.entries.find((e) => e.term === "潮汐税");
  assert.equal(tax.scope, "global");
  assert.deepEqual(tax.avoid, ["收税", "人头税"]);

  const filtered = await defs.novel_lexicon.execute({ action: "list", book: BOOK, query: "哨", root: testRoot }, exec);
  assert.equal(filtered.entries.length, 1);
  assert.equal(filtered.entries[0].term, "北境哨塔");
});

test("update / delete / toggle：改名、停用、删除、整层开关", async () => {
  const renamed = await defs.novel_lexicon.execute({ action: "update", book: BOOK, term: "青铜灯", newTerm: "青铜长明灯", note: "圣所照明", root: testRoot }, exec);
  assert.deepEqual(renamed.updated, ["青铜长明灯"]);
  const afterRename = await defs.novel_lexicon.execute({ action: "list", scope: "book", book: BOOK, root: testRoot }, exec);
  assert.ok(afterRename.entries.some((e) => e.term === "青铜长明灯"));

  const disabled = await defs.novel_lexicon.execute({ action: "update", book: BOOK, term: "星轨", enabled: false, root: testRoot }, exec);
  assert.equal(disabled.action, "update");
  const afterDisable = await defs.novel_lexicon.execute({ action: "list", scope: "book", book: BOOK, root: testRoot }, exec);
  assert.equal(afterDisable.entries.find((e) => e.term === "星轨").enabled, false);

  const removed = await defs.novel_lexicon.execute({ action: "delete", book: BOOK, terms: ["青铜长明灯"], root: testRoot }, exec);
  assert.deepEqual(removed.removed, ["青铜长明灯"]);
  await assert.rejects(
    () => defs.novel_lexicon.execute({ action: "delete", book: BOOK, root: testRoot }, exec),
    /terms|all=true/,
    "delete 未指定词条且未显式 all=true 时应拒绝（防误清空）"
  );

  const toggled = await defs.novel_lexicon.execute({ action: "toggle", book: BOOK, enabled: false, root: testRoot }, exec);
  assert.equal(toggled.enabled, false);
  const lexOff = await readLexicon(testRoot, BOOK);
  assert.equal(lexOff.counts.effective, 3, "本书层关闭后只剩全局 3 条");
  await defs.novel_lexicon.execute({ action: "toggle", book: BOOK, enabled: true, root: testRoot }, exec);
});

test("audit：覆盖率、未使用词、通用词顶替的行号定位（只读）", async () => {
  // 复位为可判定状态：书级 2 条（星轨启用 + 青铜灯）、全局 3 条
  await writeLexicon(testRoot, BOOK, {
    entries: [
      { term: "星轨", kind: "专名", avoid: ["轨道"] },
      { term: "青铜灯", kind: "专名", aliases: ["长明灯"] }
    ]
  });
  const before = await readFile(lexiconFile(testRoot, BOOK), "utf8");
  const audit = await defs.novel_lexicon.execute({ action: "audit", book: BOOK, chapter: "1", root: testRoot }, exec);
  const after = await readFile(lexiconFile(testRoot, BOOK), "utf8");
  assert.equal(before, after, "audit 必须只读：词表文件不得变化");

  assert.equal(audit.audit.total, 5);
  assert.equal(audit.audit.coveredCount, 2);
  assert.equal(audit.audit.coverage, 40);
  assert.equal(audit.audit.covered.find((c) => c.term === "星轨").firstLine, 1);
  assert.ok(audit.audit.missing.some((m) => m.term === "北境哨塔"));
  const hit = audit.audit.avoidHits.find((h) => h.word === "轨道");
  assert.equal(hit.term, "星轨");
  assert.equal(hit.line, 2);
  assert.ok(hit.snippet.includes("轨道"));
});

test("scan：从本书正文提取候选词并标注是否已登记", async () => {
  await writeFile(
    join(testRoot, "novels", BOOK, "第01章.md"),
    "星轨在头顶展开。星轨很亮。潮水退去，潮水又涌来。北境哨塔的钟响了。北境哨塔很远。\n",
    "utf8"
  );
  const scan = await defs.novel_lexicon.execute({ action: "scan", book: BOOK, limit: 20, root: testRoot }, exec);
  assert.ok(scan.candidates.length > 0);
  assert.ok(scan.candidates.every((c) => typeof c.term === "string" && Number.isInteger(c.count) && typeof c.exists === "boolean"));
  await writeFile(join(testRoot, "novels", BOOK, "第01章.md"), "他抬头看星轨。\n轨道在窗外交错。\n青铜灯亮着。\n", "utf8");
});

test("export：导出该层词条", async () => {
  const exported = await defs.novel_lexicon.execute({ action: "export", book: BOOK, root: testRoot }, exec);
  assert.equal(exported.entries.length, 2);
  assert.ok(exported.entries.every((e) => e.scope === "book"));
});

// ---------------------------------------------------------------------------
// ④ 接线：开写包注入 / 开关门禁 / 场景命中排序 / 截断
// ---------------------------------------------------------------------------
test("selectLexiconForBrief：场景命中 > 高优先 > 书级，截断给出 total", () => {
  const entries = [
    { term: "甲", kind: "其他", scope: "global" },
    { term: "乙", kind: "其他", scope: "book" },
    { term: "丙", kind: "其他", scope: "book", priority: "high" },
    { term: "丁", kind: "场景词", scene: "海战", scope: "global" },
    { term: "戊", kind: "其他", scope: "book", enabled: false }
  ];
  const picked = selectLexiconForBrief(entries, "本章是海战", 3);
  assert.deepEqual(picked.items.map((e) => e.term), ["丁", "丙", "乙"]);
  assert.equal(picked.total, 4, "已停用条目不计入 total");
  assert.equal(picked.truncated, true);
});

test("开写包：开关打开时注入硬清单，关闭时给降级说明且不注入", async () => {
  const on = await buildChapterBrief(testRoot, BOOK, "next", { budget: "compact", featState: { features: { lexiconFirst: true } } }, exec);
  assert.ok(on.lexicon, "开关打开且词表非空时必须注入 lexicon");
  assert.equal(on.lexicon.enabled, true);
  assert.ok(on.lexicon.groups.length > 0);
  assert.ok(on.lexicon.groups.flatMap((g) => g.terms).some((x) => x.term === "星轨" && Array.isArray(x.avoid)));
  assert.ok(on.plan.checklist.some((line) => line.includes("必用词优先")), "开写清单里必须有硬指令");

  const off = await buildChapterBrief(testRoot, BOOK, "next", { budget: "compact", featState: { features: { lexiconFirst: false } } }, exec);
  assert.equal(off.lexicon, null);
  assert.ok(off.degraded.some((d) => d.includes("必用词优先")), "关闭时应说明为什么不注入");
  assert.ok(!off.plan.checklist.some((line) => line.includes("必用词优先")));
});

test("开写包：词条多于 compact 上限时截断并说明（总量仍如实给出）", async () => {
  const bulk = Array.from({ length: 70 }, (_, i) => "批量词" + String(i).padStart(3, "0") + "|偏好词");
  await defs.novel_lexicon.execute({ action: "import", scope: "global", text: bulk.join("\n"), root: testRoot }, exec);
  const brief = await buildChapterBrief(testRoot, BOOK, "next", { budget: "compact", featState: { features: { lexiconFirst: true } } }, exec);
  assert.equal(brief.lexicon.shown, 60);
  assert.equal(brief.lexicon.truncated, true);
  assert.ok(brief.lexicon.total > 60);
  assert.ok(brief.degraded.some((d) => d.includes("只注入")), "截断时必须在 degraded 里说明");
  // 清掉批量词，避免污染后续断言
  await defs.novel_lexicon.execute({ action: "delete", scope: "global", all: true, root: testRoot }, exec);
  await defs.novel_lexicon.execute({ action: "import", scope: "global", text: "北境哨塔|专名\n雾港\n潮汐税|偏好词|税务|收税,人头税", root: testRoot }, exec);
});

test("auditLexicon：aliases 算命中，缺省场景顺序稳定", () => {
  const result = auditLexicon(
    [{ term: "青铜灯", aliases: ["长明灯"] }, { term: "星轨" }],
    "长明灯亮着。\n他抬头看星轨。\n"
  );
  assert.equal(result.coveredCount, 2);
  assert.equal(result.covered.find((c) => c.term === "青铜灯").count, 1);
  assert.equal(result.covered.find((c) => c.term === "星轨").firstLine, 2);
  assert.equal(result.missingCount, 0);
});

test("某层被单独关闭时：该层词条不注入，且开写包给出降级说明", async () => {
  await defs.novel_lexicon.execute({ action: "toggle", scope: "global", enabled: false, root: testRoot }, exec);
  const brief = await buildChapterBrief(testRoot, BOOK, "next", { budget: "compact", featState: { features: { lexiconFirst: true } } }, exec);
  assert.ok(brief.degraded.some((d) => d.includes("有层被关闭")), "层关闭必须在 degraded 里说明");
  const terms = brief.lexicon ? brief.lexicon.groups.flatMap((g) => g.terms.map((x) => x.term)) : [];
  assert.ok(terms.includes("星轨"), "本书层词条仍应注入");
  assert.ok(!terms.includes("北境哨塔"), "全局层词条不应注入");
  await defs.novel_lexicon.execute({ action: "toggle", scope: "global", enabled: true, root: testRoot }, exec);
});

test("开写包 render：模型可见文本必须含【必用词·优先使用】分区与「勿用」替身词", async () => {
  // v6.3.0（独立校验 ⚠3.3）：最高危的那条修复（v6.2.0 清单第 1 条——render 从未输出 lexicon
  // 分区，导致 checklist 里的硬指令指向一个不存在的分区、词表根本到不了模型）此前**零测试覆盖**：
  // e2e-test.mjs 与 v6.2.0 逐字节相同，其 render 断言清单只覆盖 new_chapter / style_check /
  // style_report / sentence_analysis，不含 novel_chapter_brief。也就是说任何后续重构把它改回
  // "不渲染"，CI 都不会拦。这里把最小契约钉死：分区标题 + 至少一个 avoid 替身词必须出现在
  // render 返回的模型可见文本里。
  const brief = await buildChapterBrief(testRoot, BOOK, "next", { budget: "compact", featState: { features: { lexiconFirst: true } } }, exec);
  assert.ok(brief.lexicon, "前置条件：词表非空且开关打开时必须注入 lexicon");
  const rendered = defs.novel_chapter_brief.output.render({}, brief);
  const text = (Array.isArray(rendered) ? rendered : [rendered]).map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n");
  assert.ok(text.includes("【必用词·优先使用】"), "render 必须输出【必用词·优先使用】分区标题");
  const avoidWords = brief.lexicon.groups.flatMap((g) => g.terms).flatMap((x) => (Array.isArray(x.avoid) ? x.avoid : []));
  assert.ok(avoidWords.length > 0, "前置条件：测试词表里应有 avoid 替身词");
  assert.ok(avoidWords.some((w) => text.includes(w)), "render 必须带上至少一个「勿用」替身词，实测替身词=" + avoidWords.join("/"));
  // 清单里的硬指令必须指向**真实存在**的分区（修前那句指向不存在的分区）
  assert.ok(brief.plan.checklist.some((line) => line.includes("必用词优先")), "开写清单里必须有硬指令");
  assert.ok(text.indexOf("【必用词·优先使用】") >= 0, "分区标题必须真的渲染出来");
});
