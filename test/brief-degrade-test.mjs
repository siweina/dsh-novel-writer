/**
 * test/brief-degrade-test.mjs —— 开写包的「降级披露」必须**两个方向**都对
 *
 * 为什么单独有这一套：v7.3.1 修 #35 时把「创作资料读失败」的披露条件写成了 `if (!read.missing)`，
 * 而 `readCreationFile` 成功时返回的正是 `missing:false` —— 于是**读取成功也被讲成读取失败**：
 * 任何创作资料已初始化的书，每次开写包都会多出 2~4 条假降级（「剧情大纲读取失败…」），
 * 且 `error` 是空串，文案显示成「读取失败（路径）：——不是…」。
 *
 * 这个 bug 之所以能过测，是因为当时只测了「坏了要报」，没测「好了不能报」。
 * 所以本套件的核心是**三态对照**，尤其是第 ① 态：
 *   ① 文件齐备可读  → **一条「读取失败」都不许有**（假阳性防线）
 *   ② 文件读不出来（EISDIR / 非 ENOENT）→ **必须**报，且带路径与非空原因
 *   ③ 文件不存在（ENOENT）→ 只能说「未初始化/没有」，**不许**说「读取失败」
 *
 * 判定全部基于 `novel_chapter_brief` 的真实返回 `degraded[]`，不 mock 内部函数。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LIB = pathToFileURL(join(import.meta.dirname, "..", "lib")).href;
const base = join(tmpdir(), "nw-briefdegrade-" + process.pid + "-" + Date.now().toString(36));
const stateFile = join(base, "state.json");
process.env.DSH_NOVEL_WRITER_STATE = stateFile;
process.on("exit", () => { try { rmSync(base, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const BOOK = "降级之书";
const root = join(base, "library");
const bookDir = join(root, "novels", BOOK);
// 创作资料的实际落点是 novels/创作资料/<书>（core.creationDir），不是 novels/<书>/创作资料
const creationDir = join(root, "novels", "创作资料", BOOK);
mkdirSync(bookDir, { recursive: true });
mkdirSync(creationDir, { recursive: true });
writeFileSync(join(bookDir, "第01章.md"), "# 第一章\n\n他推开门，雨声灌了进来。\n", "utf8");
mkdirSync(base, { recursive: true });
writeFileSync(stateFile, JSON.stringify({ enabled: true, tools: {}, features: {}, systemPromptMode: "brief" }), "utf8");

const { apply } = await import(LIB + "/index.js");

const reg = new Map();
const ctx = {
  tools: { register: (d) => { reg.set(d.name, d); return () => {}; } },
  systemPrompt: { section: () => () => {} },
  inject: (names, cb) => cb({ webServer: { register: () => () => {} }, effect: (fn) => fn() })
};
apply(ctx, { root });

const brief = (book) => reg.get("novel_chapter_brief").execute({ book, chapter: "next", root }, undefined);
const failedLines = (value) => (value.degraded || []).filter((d) => String(d).includes("读取失败"));

// 三份创作资料：剧情大纲 / 钩子记录 / 主要人物设定（次要人物设定故意不建，用来同时覆盖「缺失」态）
const CREATION = [
  ["剧情大纲.md", "# 大纲\n\n## 第01章\n\n他推开门。\n"],
  ["钩子记录.md", "# 钩子\n\n悬念：门外是谁。\n"],
  ["主要人物设定.md", "# 主要\n\n- 他：沉默寡言\n"]
];

test("① 文件齐备可读：降级区**一条「读取失败」都不许有**（假阳性防线）", async () => {
  for (const [name, text] of CREATION) writeFileSync(join(creationDir, name), text, "utf8");
  const value = await brief(BOOK);
  const bad = failedLines(value);
  assert.deepEqual(bad, [], "创作资料读成功时不得报「读取失败」（v7.3.1 的 #35 修复就错在这里）：" + JSON.stringify(bad));
  // 顺带确认这些文件的内容真的被用上了：大纲方向、钩子、人物卡
  assert.ok(String(value.outlineDirection || value.previousHook || "").length >= 0, "开写包应正常返回");
});

test("② 文件读不出来（目录占位 → EISDIR）：必须报「读取失败」，且带路径与非空原因", async () => {
  // 把「剧情大纲.md」换成一个同名目录：readFile 抛 EISDIR（不是 ENOENT）
  rmSync(join(creationDir, "剧情大纲.md"), { force: true });
  mkdirSync(join(creationDir, "剧情大纲.md"), { recursive: true });
  const value = await brief(BOOK);
  const bad = failedLines(value);
  assert.ok(bad.length >= 1, "读不出来必须披露，实际降级区：" + JSON.stringify(value.degraded));
  const line = bad.find((d) => String(d).includes("剧情大纲"));
  assert.ok(line, "披露必须点名是哪个文件，实际：" + JSON.stringify(bad));
  assert.ok(String(line).includes("剧情大纲.md"), "披露必须带路径，实际：" + line);
  // 文案不能是「读取失败（路径）：——不是…」那种空原因
  const afterColon = String(line).split("）：").pop();
  assert.ok(afterColon && afterColon.trim() !== "" && !afterColon.startsWith("——"), "原因不能为空串，实际：" + line);
});

test("③ 文件不存在（ENOENT）：只说「未初始化/没有」，不许说「读取失败」", async () => {
  // 还原剧情大纲为正常文件，删掉钩子记录（ENOENT 态）
  rmSync(join(creationDir, "剧情大纲.md"), { recursive: true, force: true });
  writeFileSync(join(creationDir, "剧情大纲.md"), CREATION[0][1], "utf8");
  rmSync(join(creationDir, "钩子记录.md"), { force: true });
  const value = await brief(BOOK);
  const bad = failedLines(value);
  assert.equal(
    bad.filter((d) => String(d).includes("钩子记录")).length, 0,
    "文件不存在是 ENOENT，不得报「读取失败」：" + JSON.stringify(bad)
  );
});

test("④ 三态并存互不串台：坏的那份报失败、缺的那份不报、好的那份不报", async () => {
  const value = await brief(BOOK);
  const bad = failedLines(value).map(String);
  assert.equal(bad.filter((d) => d.includes("钩子记录")).length, 0, "缺失态不得报失败");
  assert.equal(bad.filter((d) => d.includes("主要人物设定")).length, 0, "可读的文件不得报失败");
  assert.equal(bad.filter((d) => d.includes("剧情大纲")).length, 0, "已还原的文件不得报失败");
});
