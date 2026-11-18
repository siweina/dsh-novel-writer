/**
 * test/v740-audit-fixes-test.mjs —— v7.4.0（v7.3.5 源码审计 78 项修复）回归套件（第 38 个测试套件）
 *
 * 覆盖分组：
 *   A. 章节、草稿镜像与开写包（#1, #2, #3, #4, #5, #6, #7, #8, #10）
 *   B. 分析缓存、向量行号、正则安全与工具契约（#9, #11, #12, #13, #14, #15, #16, #17, #18, #42, #46, #47, #48, #49, #50, #51, #52, #53, #55, #58）
 *   C. 删书、诊断、日志、状态与 HTTP 路由（#19, #20, #21, #22, #23, #24, #25, #26, #27, #28, #29, #30, #56, #57, #73, #75）
 *   D. MCP 与客户端回归（#38, #39, #40, #60, #76, #77, #78）
 *
 * 隔离：
 *   - 在动态 import 任何 lib/* 模块之前，将 DSH_NOVEL_WRITER_STATE 与 DSH_HOME 重定向至 os.tmpdir()；
 *   - 所有临时书库均建在 os.tmpdir() 下，test.after 与 process.on("exit") 彻底清理并恢复环境变量；
 *   - 末尾核验用户真实 ~/.dsh/dsh-novel-writer/{state.json,logs} 零改动。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PREV_STATE_ENV = process.env.DSH_NOVEL_WRITER_STATE;
const PREV_HOME_ENV = process.env.DSH_HOME;

const REAL_STATE = join(homedir(), ".dsh", "dsh-novel-writer", "state.json");
const REAL_LOG_DIR = join(homedir(), ".dsh", "dsh-novel-writer", "logs");
function digestFile(file) {
  try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch { return "absent"; }
}
function digestDir(dir) {
  try { return readdirSync(dir).sort().map((n) => n + ":" + digestFile(join(dir, n))).join("|"); } catch { return "absent"; }
}
const realBefore = { state: digestFile(REAL_STATE), logs: digestDir(REAL_LOG_DIR) };

const TMP_BASE = realpathSync.native(mkdtempSync(join(tmpdir(), "dsh-v740-fixes-" + process.pid + "-")));
const STATE_FILE = join(TMP_BASE, "state.json");
const DSH_HOME_DIR = join(TMP_BASE, "dsh-home");
mkdirSync(DSH_HOME_DIR, { recursive: true });
process.env.DSH_NOVEL_WRITER_STATE = STATE_FILE;
process.env.DSH_HOME = DSH_HOME_DIR;

function restoreEnvAndCleanup() {
  if (PREV_STATE_ENV === void 0) delete process.env.DSH_NOVEL_WRITER_STATE;
  else process.env.DSH_NOVEL_WRITER_STATE = PREV_STATE_ENV;
  if (PREV_HOME_ENV === void 0) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_HOME_ENV;
  try { rmSync(TMP_BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 忽略清理错误 */ }
}
process.on("exit", restoreEnvAndCleanup);
test.after(() => {
  restoreEnvAndCleanup();
});

const DEFAULT_BASE_STATE = {
  enabled: true,
  autoAnalyze: true,
  systemPromptMode: "off",
  promptScene: "general",
  leanWorkflow: false,
  tools: {},
  features: {
    semanticStyle: false,
    semanticImplicit: false,
    semanticEmbedding: false,
    semanticSearch: false,
    chatWriting: false
  }
};
function resetStateFile(extra = {}) {
  const next = {
    ...DEFAULT_BASE_STATE,
    ...extra,
    features: { ...DEFAULT_BASE_STATE.features, ...(extra.features || {}) },
    tools: { ...DEFAULT_BASE_STATE.tools, ...(extra.tools || {}) }
  };
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), "utf8");
}
resetStateFile();

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PLUGIN = await import("../lib/index.js");
const CORE = await import("../lib/core.js");
const DIAG = await import("../lib/chapter-diagnose.js");
const VEC = await import("../lib/vector-audit.js");
const AUDIT = await import("../lib/audit.js");
const DIAGNOSE = await import("../lib/diagnose.js");
const FIXPLAN = await import("../lib/fixplan.js");
const LOG = await import("../lib/log.js");
const BOOKDELETE = await import("../lib/bookdelete.js");
const TRASH = await import("../lib/trash.js");
const EMB = await import("../lib/embedding.js");

let libSeq = 0;
function freshLib(tag) {
  libSeq += 1;
  const root = join(TMP_BASE, `lib-${tag}-${libSeq}`);
  mkdirSync(join(root, "novels"), { recursive: true });
  return root;
}

function createHarness(root, extraConfig = {}) {
  const registry = [];
  const routes = [];
  const ctx = {
    tools: { register: (d) => { registry.push(d); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    inject: (_names, cb) => cb({
      webServer: { register: (r) => { routes.push(r); return () => {}; } },
      effect: (fn) => fn()
    })
  };
  PLUGIN.apply(ctx, { root, sentenceAnalysis: { enabled: true, autoAnalyze: true }, allowLanState: false, ...extraConfig });
  const defs = Object.fromEntries(registry.map((d) => [d.name, d]));
  const exec = { agent: { session: { header: { cwd: root } } } };
  const routeOf = (path) => routes.find((r) => r.path === path);
  return { defs, exec, routes, routeOf };
}

function mkRes() {
  return { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = String(b ?? ""); } };
}
function mkReq(path, method = "GET", bodyPayload, extraHeaders) {
  const req = {
    method,
    url: path,
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:51783", ...(extraHeaders || {}) }
  };
  if (bodyPayload !== void 0) {
    const chunk = Buffer.isBuffer(bodyPayload) ? bodyPayload : Buffer.from(String(bodyPayload));
    req[Symbol.asyncIterator] = async function* () { yield chunk; };
  }
  return req;
}

const STAT_SLOP_TEXT = "他的力量提升了三倍，速度增加了近五成，修为突破到筑基期。他盯着墙角看了半天。";
const LONG_PARA_A = "夜雨沿着瓦檐淌下，把院墙下的青石板泡得发亮。他蹲在廊柱边，将油纸包拆开一条缝，用指腹抹去表面的水珠，再把铜牌收入袖袋里。";
const LONG_PARA_B = "茶馆二楼靠窗的方桌空了半张，掌柜拎着紫铜长嘴壶走过来，壶口冒出细白的水汽，将账簿边角熏得微微卷起。";
const LONG_PARA_C = "巷子深处响起三下竹梆，紧接着铁锁落地的闷响传过半条长街，巡夜的灯笼在转角处停住，把人影拉长到门坎前。";

// ===========================================================================
// A. 章节、草稿镜像与开写包
// ===========================================================================

test("A1 (#1): maxBareDialogueRun / diagnoseChapterSymptoms 检出含感知动词的站桩对话", () => {
  const text = [
    "“你当真不肯走？”她看着他。",
    "“走去哪里？”他盯着她。",
    "“城外码头。”她听着话。",
    "“船早就开了。”他望着远方。",
    "“那便等明天。”她想着心事。",
    "“随你吧。”他凝视着她。"
  ].join("\n\n");
  const run = DIAG.maxBareDialogueRun(text);
  assert.equal(run.run, 6, "纯感知/心理动词旁白应全部算入站桩游程");
  assert.equal(run.from, 1);
  assert.equal(run.to, 6);
  const syms = DIAG.diagnoseChapterSymptoms(text, null);
  assert.ok(syms.some((s) => s.key === "bare_dialogue"), "diagnoseChapterSymptoms 应检出 bare_dialogue");

  // 对照：真实具象动作/物件接触必须打断游程
  const withAction = [
    "“你当真不肯走？”她看着他。",
    "“走去哪里？”他盯着她。",
    "“喝口热茶。”她摩挲着瓷杯沿。",
    "“船早就开了。”他望着远方。",
    "“那便等明天。”她想着心事。",
    "“随你吧。”他凝视着她。"
  ].join("\n\n");
  const splitRun = DIAG.maxBareDialogueRun(withAction);
  assert.equal(splitRun.run, 3, "真实器物接触必须打断站桩游程");
});

test("A2 (#2): nextFreeChapterFile 双章号文件名改写首个章号标记避免冲突", () => {
  const dir = join(freshLib("nextfree"), "novels", "双章号书");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "第01章.md"), "a\n", "utf8");
  writeFileSync(join(dir, "第02章.md"), "b\n", "utf8");

  const arabNext = CORE.nextFreeChapterFile(dir, "第01章 第02节.md");
  assert.equal(arabNext, "第03章 第02节.md");
  assert.equal(CORE.parseChapterNumber(arabNext), 3, "改名后的首个章号必须等于新分配章号 3");

  const cjkNext = CORE.nextFreeChapterFile(dir, "第一章 第二节.md");
  assert.equal(cjkNext, "第三章 第二节.md");
  assert.equal(CORE.parseChapterNumber(cjkNext), 3);
});

test("A3 (#3): parseDraftSegments 与 novel_new_chapter 定稿镜像截断及无前序分段兜底", async () => {
  const root = freshLib("draft-mirror");
  const book = "镜像书";
  const { defs, exec, routeOf } = createHarness(root);
  const draftRoute = routeOf("/api/dsh-novel-writer/draft");
  assert.ok(draftRoute, "应注册 /draft 路由");

  resetStateFile({ features: { chatWriting: true } });
  try {
    // 1) 已有分段后再定稿：定稿标记不得并入最后一段 text 与 totalChars
    await defs.novel_draft.execute({ action: "commit", book, chapter: "1", text: "第一段初稿内容。", root }, exec);
    await defs.novel_new_chapter.execute({ book, chapter: 1, title: "雨夜", content: "第一段初稿内容（定稿）。", root }, exec);
    const mirror1 = readFileSync(CORE.resolveDraftTarget(root, book, "1").file, "utf8");
    const segs1 = CORE.parseDraftSegments(mirror1);
    assert.equal(segs1.length, 1);
    assert.equal(segs1[0].text, "第一段初稿内容。");
    assert.ok(!segs1[0].text.includes("定稿落盘"), "定稿头不得混入最后一段正文");

    const res1 = mkRes();
    await draftRoute.handler(mkReq(`/api/dsh-novel-writer/draft?book=${encodeURIComponent(book)}&chapter=1`), res1);
    assert.equal(res1.status, 200);
    const body1 = JSON.parse(res1.body);
    assert.equal(body1.segments.length, 1);
    assert.equal(body1.totalChars, "第一段初稿内容。".length);

    // 2) 无前序分段直接 novel_new_chapter：parseDraftSegments 与 /draft 仍可解析出正文
    await defs.novel_new_chapter.execute({ book, chapter: 2, title: "晴晨", content: "第二章直接定稿正文。", root }, exec);
    const mirror2 = readFileSync(CORE.resolveDraftTarget(root, book, "2").file, "utf8");
    const segs2 = CORE.parseDraftSegments(mirror2);
    assert.equal(segs2.length, 1);
    assert.equal(segs2[0].index, 1);
    assert.ok(segs2[0].text.includes("第二章直接定稿正文。"));
    assert.ok(!segs2[0].text.includes("定稿落盘"));

    const res2 = mkRes();
    await draftRoute.handler(mkReq(`/api/dsh-novel-writer/draft?book=${encodeURIComponent(book)}&chapter=2`), res2);
    assert.equal(res2.status, 200);
    const body2 = JSON.parse(res2.body);
    assert.equal(body2.exists, true);
    assert.equal(body2.segments.length, 1);
    assert.ok(body2.totalChars > 0);
  } finally {
    resetStateFile();
  }
});

test("A4 (#4): 按书 creationProfiles[book] 在 brief / style_check / fix_plan 豁免 stat_numeric", async () => {
  const root = freshLib("book-genre-slop");
  const book = "网游按书";
  const dir = join(root, "novels", book);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "第01章.md"), LONG_PARA_A + "\n\n" + LONG_PARA_B + "\n", "utf8");
  writeFileSync(join(dir, "第02章.md"), LONG_PARA_C + "\n\n" + LONG_PARA_A + "\n", "utf8");
  writeFileSync(join(dir, "第03章.md"), Array(5).fill(STAT_SLOP_TEXT).join("\n\n") + "\n\n“把铜牌递给我。”他推开木门拿起桌上的茶杯。\n", "utf8");

  const { defs, exec } = createHarness(root);

  // 对照基线：全局与按书均未配系统流题材 → 三处都必须报出 stat_numeric
  resetStateFile();
  try {
    const checkBefore = await defs.novel_style_check.execute({ book, chapter: "3", root }, exec);
    assert.ok((checkBefore.slop?.byCategory?.stat_numeric ?? 0) > 0, "未配题材时 style_check 应报 stat_numeric");

    const planBefore = await defs.novel_fix_plan.execute({ book, chapter: "3", action: "plan", root }, exec);
    assert.ok(planBefore.items.some((it) => it.type === "AI套话" && String(it.current).includes("stat_numeric")), "未配题材时 fix_plan 应报 stat_numeric");

    const briefBefore = await defs.novel_chapter_brief.execute({ book, chapter: "4", root }, exec);
    assert.ok((briefBefore.symptomPrescriptions || []).some((sp) => sp.key === "slop"),
      "未配题材时 brief 应对近章报出 slop 症状处方：" + JSON.stringify(briefBefore.symptomPrescriptions));

    // 仅设置按书 creationProfiles[book] = { genre: "系统流网游" }（全局 creationProfile 留空）
    resetStateFile({ creationProfile: null, creationProfiles: { [book]: { genre: "系统流网游" } } });

    const checkAfter = await defs.novel_style_check.execute({ book, chapter: "3", root }, exec);
    assert.equal(checkAfter.slop?.byCategory?.stat_numeric ?? 0, 0, "按书设定系统流后 style_check 应豁免 stat_numeric");

    const planAfter = await defs.novel_fix_plan.execute({ book, chapter: "3", action: "plan", root }, exec);
    assert.equal(planAfter.items.some((it) => it.type === "AI套话" && String(it.current).includes("stat_numeric")), false, "按书设定系统流后 fix_plan 应豁免 stat_numeric");

    const briefAfter = await defs.novel_chapter_brief.execute({ book, chapter: "4", root }, exec);
    assert.equal((briefAfter.symptomPrescriptions || []).some((sp) => sp.key === "slop"), false,
      "按书设定系统流后 brief 不应再给 slop 处方：" + JSON.stringify(briefAfter.symptomPrescriptions));
  } finally {
    resetStateFile();
  }
});

test("A5 (#5): 建章取消上抛 AbortError 且基线读取异常不泄漏未选章锚段", async () => {
  const root = freshLib("new-chap-scope-leak");
  const { defs, exec } = createHarness(root);

  // 1) custom 仅选 第01章.md，另有未选 第00章 未选.md（含明显特征段落）与坏编码 第02章 坏编码.md
  const book = "范围隔离书";
  const dir = join(root, "novels", book);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "第00章 未选.md"), "未选中章的独有标记段落：老掌柜把红漆木匣塞进地窖最深处的暗格里，上面压了一块青砖，谁也没告诉。\n", "utf8");
  writeFileSync(join(dir, "第01章.md"), LONG_PARA_A + "\n", "utf8");
  writeFileSync(join(dir, "第02章 坏编码.md"), Buffer.from([0x80, 0x81, 0x82, 0xff, 0x83, 0x84]));
  await CORE.writeBaselineScope(root, book, { mode: "custom", chapters: ["第01章.md"] });

  const created = await defs.novel_new_chapter.execute({ book, chapter: 3, content: "第三章正文。\n", root }, exec);
  assert.equal(created.anchors.length, 0, "基线读盘异常后 anchors 不得泄漏未选中章节");
  assert.equal(created.skeletons.length, 0, "基线读盘异常后 skeletons 不得泄漏未选中章节");
  assert.equal("baseline" in created, false);
  assert.equal("baselineScope" in created, false);
  assert.equal("baselineMode" in created, false);

  // 2) 读基线章时触发 AbortError 必须原样上抛
  const abortBook = "建章取消书";
  const abortDir = join(root, "novels", abortBook);
  mkdirSync(abortDir, { recursive: true });
  writeFileSync(join(abortDir, "第01章.md"), LONG_PARA_A + "\n", "utf8");
  const live = new AbortController();
  let signalReads = 0;
  const abortExec = { agent: { session: { header: { cwd: root } } } };
  Object.defineProperty(abortExec, "signal", {
    get() { signalReads += 1; return signalReads >= 3 ? AbortSignal.abort() : live.signal; }
  });
  await assert.rejects(
    defs.novel_new_chapter.execute({ book: abortBook, chapter: 2, content: "第二章正文。\n", root }, abortExec),
    (err) => CORE.isAbort(err)
  );
});

test("A6 (#6 & #10): 自定义基线仅选 <40 字短章时在 brief / style_report / style_check / fix_plan 均正确回退全书长章", async () => {
  const root = freshLib("short-custom-fallback");
  const book = "短章回退书";
  const dir = join(root, "novels", book);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "第01章.md"), "只有十来个字的短章。\n", "utf8");
  writeFileSync(join(dir, "第02章.md"), LONG_PARA_A + "\n\n" + LONG_PARA_B + "\n", "utf8");
  writeFileSync(join(dir, "第03章.md"), LONG_PARA_C + "\n\n" + LONG_PARA_A + "\n", "utf8");
  writeFileSync(join(dir, "第04章.md"), LONG_PARA_B + "\n\n" + LONG_PARA_C + "\n", "utf8");
  await CORE.writeBaselineScope(root, book, { mode: "custom", chapters: ["第01章.md"] });

  const { defs, exec } = createHarness(root);

  // 1) novel_chapter_brief (#6)
  const briefRes = await defs.novel_chapter_brief.execute({ book, chapter: "4", root }, exec);
  assert.equal(briefRes.referenceProvenance, "all-unverified", "仅选短章时 brief 参照集应回退 all-unverified");
  assert.ok((briefRes.degraded || []).some((d) => d.includes("已回退按全书")), "brief degraded 应披露基线回退");
  assert.ok(briefRes.baseline && briefRes.baseline.complexity?.mu > 0, "brief baseline 应回退全书长章算出有效均值");

  // 2) novel_style_report (#10，brief 与完整路径)
  const repBrief = await defs.novel_style_report.execute({ book, brief: true, root }, exec);
  assert.equal(repBrief.baselineMode, "all");
  assert.equal(repBrief.baselineChapterCount, 3);
  assert.match(repBrief.baselineScope, /回退全书/);
  assert.ok(repBrief.baseline.complexity?.mu > 0);

  const repFull = await defs.novel_style_report.execute({ book, root }, exec);
  assert.equal(repFull.baselineMode, "all");
  assert.equal(repFull.baselineChapterCount, 3);
  assert.match(repFull.baselineScope, /回退全书/);
  assert.ok(repFull.baseline.complexity?.mu > 0);

  // 3) novel_style_check (#10)
  const chk = await defs.novel_style_check.execute({ book, chapter: "4", root }, exec);
  assert.equal(chk.baselineMode, "all");
  assert.match(chk.baselineScope, /回退全书/);
  assert.equal(chk.metric?.enabled, true, "style_check 六维基线应回退全书长章并启用");

  // 4) novel_fix_plan (#10)
  const plan = await defs.novel_fix_plan.execute({ book, chapter: "4", action: "plan", root }, exec);
  assert.ok(!String(plan.baselineScope).startsWith("无基线"), "fix_plan 不得报错无基线");
  assert.match(plan.baselineScope, /全书/);
  assert.match(plan.baselineScope, /回退全书/);
});

test("A7 (#7): 纯 \\r 换行兼容（countTextLines / firstHeadingTitle / buildStyleAnchorPackage / novel_read）", async () => {
  assert.equal(CORE.countTextLines("甲\r乙\r丙"), 3);

  const root = freshLib("cr-eol");
  const book = "回车书";
  const dir = join(root, "novels", book);
  mkdirSync(dir, { recursive: true });
  const crContent = "# 纯回车标题\r"
    + "他沿着河岸慢慢走了很长一段路，手里一直攥着那盏已经熄灭多时的旧铜灯，直到石桥尽头。\r"
    + "桥洞下水声回荡，夜风吹得苇草贴着水面伏下去，远处传来船桨拍水的轻响。\r"
    + "他停在石栏前看了一会儿水里的倒影，把铜灯挂回腰间，转身踏上了通往城门的小道。";
  writeFileSync(join(dir, "第01章.md"), crContent, "utf8");

  const { defs, exec } = createHarness(root);
  const chaps = await defs.novel_chapters.execute({ book, root }, exec);
  assert.equal(chaps.chapters[0].title, "纯回车标题", "firstHeadingTitle 应按 \\r 截断，不把正文拼入标题");
  assert.equal(chaps.chapters[0].lines, 4);

  const pkg = await CORE.buildStyleAnchorPackage(root, book, chaps.chapters, exec, crContent);
  assert.ok(pkg.anchors.length > 0, "纯 \\r 文本应抽出原著锚段");
  assert.ok(pkg.skeletons.length > 0, "纯 \\r 首行带 # 标题时不应整章被过滤导致骨架为空");
  assert.ok(pkg.skeletons.every((s) => !s.text.includes("#")), "骨架中不应混入 # 标题");

  const readRes = await defs.novel_read.execute({ book, chapter: "1", root }, exec);
  assert.equal(readRes.totalLines, 4);
  assert.equal(readRes.lines.length, 4);
  assert.equal(readRes.lines[0].text, "# 纯回车标题");
});

test("A8 (#8): parseChapterNumber 拒绝 第一万章-1.md / 第零章-1.md / 第0章.md", () => {
  assert.equal(CORE.parseChapterNumber("第一万章-1.md"), void 0);
  assert.equal(CORE.parseChapterNumber("第零章-1.md"), void 0);
  assert.equal(CORE.parseChapterNumber("第0章.md"), void 0);
  assert.equal(CORE.parseChapterNumber("第01章.md"), 1);
  assert.equal(CORE.parseChapterNumber("第一千章.md"), 1000);
});

// ===========================================================================
// B. 分析缓存、向量行号、正则安全与工具契约
// ===========================================================================

test("B1 (#9): locateBlocks / detectSemanticLoop 在单换行折行与 # 标题下给出准确 1-based 行号", async () => {
  VEC.__clearVectorCache();
  const MARKERS = ["壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾"];
  const fakeEmbed = (text) => {
    const t = String(text).startsWith(VEC.QUERY_PREFIX) ? String(text).slice(VEC.QUERY_PREFIX.length) : String(text);
    const idx = MARKERS.indexOf(t.trim()[0]);
    const v = new Array(16).fill(0);
    v[idx >= 0 ? idx : 15] = 1;
    return v;
  };
  const makeWrapped = (marker, body) => `${marker}${body}第一折行。\n${marker}${body}第二折行。`;
  const repeatPara = "玖他在檐下站了很久反复看着石阶上的水渍什么都没有说也迟迟没有迈出下一步。\n玖手指一直在袖口里来回摩挲着却始终没有迈出那半步。";
  const singleNewlineText = [
    "# 第一章 标题",
    makeWrapped("壹", "青石巷口落了半夜急雨，屋檐下铜铃被风吹得乱响。"),
    makeWrapped("贰", "茶铺掌柜擦亮柜台上的铜秤，把账簿摊开在油灯下。"),
    makeWrapped("叁", "巷尾传来三下竹梆，巡夜人提着昏黄灯笼穿过长街。"),
    makeWrapped("肆", "院墙根积起半尺深的水洼，倒映着灰暗天色与残瓦。"),
    makeWrapped("伍", "灶膛里余火早就熄灭，锅盖边缘凝着一圈冷白盐霜。"),
    makeWrapped("陆", "茶客低头数完三枚铜板，袖口沾满泥浆却一言不发。"),
    makeWrapped("柒", "远处城楼号角隐约响过一阵，很快又被狂风压了下去。"),
    makeWrapped("捌", "石桥边系着一条旧木船，缆绳在浑浊水面上一沉一浮。"),
    repeatPara,
    repeatPara,
    repeatPara,
    repeatPara
  ].join("\n\n");

  const res = await VEC.detectSemanticLoop(singleNewlineText, { embed: fakeEmbed, isAvailable: () => true });
  assert.equal(res.checked, true, "应成功运行向量审计：" + JSON.stringify(res));
  assert.ok(res.loops.length >= 1, "应检出后段原地打转：" + JSON.stringify(res));
  const loop = res.loops[0];
  // 标题 1 行 + 8 个双行段落（各带空行即 8*3=24 行）→ 第一个 repeatPara 从第 26 行开始
  assert.ok(loop.lineFrom >= 25, `单换行折行 + # 标题后 loop.lineFrom 应落在第 25 行以后而非第 1 行，实际 ${loop.lineFrom}`);
  assert.ok(loop.lineTo >= loop.lineFrom);

  // 纯单换行（全文无任何空行，每两行/三行跨 \n 合并为 150 字语义块）
  VEC.__clearVectorCache();
  const padTo = (s, len) => s + "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸".repeat(5).slice(0, len - s.length);
  const pureSingleLines = ["# 纯单换行标题"];
  for (let i = 0; i < 8; i += 1) {
    const mk = MARKERS[i];
    pureSingleLines.push(padTo(`${mk}第${i + 1}段上半行先写门口灯笼摇晃与雨丝斜打在青石阶上，`, 75));
    pureSingleLines.push(padTo(`${mk}第${i + 1}段下半行再写长街尽头传来的声音与门环轻响。`, 75));
  }
  const rep50 = "玖他在廊柱下站着不动反复看着青石板上的雨水倒影迟迟没有迈出下一步手指在袖口里来回摩挲着却未开口说话。";
  assert.equal(rep50.length, 50);
  for (let j = 0; j < 9; j += 1) pureSingleLines.push(rep50);
  const pureRes = await VEC.detectSemanticLoop(pureSingleLines.join("\n"), { embed: fakeEmbed, isAvailable: () => true });
  assert.equal(pureRes.checked, true, "纯单换行排版应成功切块运行：" + JSON.stringify(pureRes));
  assert.ok(pureRes.loops.length >= 1, "纯单换行排版应检出后段原地打转：" + JSON.stringify(pureRes));
  assert.ok(pureRes.loops[0].lineFrom >= 18, `纯单换行排版后段循环 lineFrom 不得塌缩到第 1 行，实际 ${pureRes.loops[0].lineFrom}`);
});

test("B2 (#11): novel_style_report 语义关闭时连续命中不重写 <book>-full.json", async () => {
  const root = freshLib("style-report-cache");
  const book = "不重写缓存书";
  const dir = join(root, "novels", book);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "第01章.md"), LONG_PARA_A + "\n\n" + LONG_PARA_B + "\n", "utf8");
  writeFileSync(join(dir, "第02章.md"), LONG_PARA_C + "\n\n" + LONG_PARA_A + "\n", "utf8");

  resetStateFile();
  const { defs, exec } = createHarness(root);
  await defs.novel_style_report.execute({ book, root }, exec);
  const fullFile = join(CORE.novelDataDir(root), "analysis", `${book}-full.json`);
  assert.ok(existsSync(fullFile), "首次应生成 <book>-full.json");
  const mtime1 = statSync(fullFile).mtimeMs;

  await delay(40);
  await defs.novel_style_report.execute({ book, root }, exec);
  const mtime2 = statSync(fullFile).mtimeMs;
  assert.equal(mtime2, mtime1, "语义关闭时命中缓存不得重写 <book>-full.json");
});

test("B3 (#12): novel_sentence_analysis 缓存按 semanticImplicit 开关隔离", async () => {
  const root = freshLib("sa-sem-cache");
  const book = "语义开关隔离书";
  const dir = join(root, "novels", book);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "第01章.md"), "窗外雪花飘落，风声呼啸，月光冷清，灯影摇曳。她站在廊下没有说话。\n", "utf8");

  const { defs, exec } = createHarness(root);
  try {
    resetStateFile({ features: { semanticImplicit: false, semanticEmbedding: true } });
    const off1 = await defs.novel_sentence_analysis.execute({ book, root }, exec);
    assert.equal(off1.cache, "miss");
    const off2 = await defs.novel_sentence_analysis.execute({ book, root }, exec);
    assert.equal(off2.cache, "hit");
    assert.equal(off2.reportFile, off1.reportFile);

    resetStateFile({ features: { semanticImplicit: true, semanticEmbedding: true } });
    const on1 = await defs.novel_sentence_analysis.execute({ book, root }, exec);
    assert.equal(on1.cache, "miss", "切换 semanticImplicit=true 后必须 miss，不得串用关态缓存");
    assert.notEqual(on1.reportFile, off1.reportFile, "开关态不同应对应不同 cacheKey");
    const on2 = await defs.novel_sentence_analysis.execute({ book, root }, exec);
    assert.equal(on2.cache, "hit");
    assert.equal(on2.reportFile, on1.reportFile);

    // 切回关态后命中原关态缓存且不残留 semanticImplicit/resolved
    resetStateFile({ features: { semanticImplicit: false, semanticEmbedding: true } });
    const off3 = await defs.novel_sentence_analysis.execute({ book, root }, exec);
    assert.equal(off3.cache, "hit");
    assert.equal(off3.reportFile, off1.reportFile);
    assert.equal(off3.emotion?.quantification?.semanticImplicit, void 0);
    assert.equal(off3.emotion?.quantification?.implicit?.resolved, void 0);
  } finally {
    resetStateFile();
  }
});

test("B4 (#13 & #53): validatePattern 拦截复杂 ReDoS 并补全 code:\"redos\"，放行转义与字符类", () => {
  const r1 = CORE.validatePattern(".+.+.+.+.+.+b");
  assert.equal(r1.ok, false);
  assert.equal(r1.level, "reject");
  assert.equal(r1.code, "redos");

  const r2 = CORE.validatePattern("(?:[a-z]|a)+$");
  assert.equal(r2.ok, false);
  assert.equal(r2.level, "reject");
  assert.equal(r2.code, "redos");

  const r3 = CORE.validatePattern("a{1,}a{1,}b");
  assert.equal(r3.ok, false);
  assert.equal(r3.level, "reject");
  assert.equal(r3.code, "redos");

  const ok1 = CORE.validatePattern("(a\\+b)+");
  assert.equal(ok1.ok, true);
  assert.equal(ok1.level, "ok");

  const ok2 = CORE.validatePattern("([+*])+");
  assert.equal(ok2.ok, true);
  assert.equal(ok2.level, "ok");
});

test("B5 (#14, #15, #16, #17, #18): 设定/大纲/伏笔校验与归一化修复", async () => {
  // #15 normalizeSettingEntry honorGood: null
  const norm = CORE.normalizeSettingEntry({ name: "测试规范", speechStyle: { honorGood: null, title: "大人" } });
  assert.equal(Object.hasOwn(norm.speechStyle, "honorGood"), false, "honorGood:null 不得展开为空对象");
  assert.equal(norm.speechStyle.title, "大人");

  const root = freshLib("settings-outline-plot");
  const book = "校验书";
  const { defs, exec } = createHarness(root);

  // #14 timeline day trim
  await defs.novel_settings.execute({ book, category: "timeline", action: "add", day: "第1天", event: "出发", root }, exec);
  const up1 = await defs.novel_settings.execute({ book, category: "timeline", action: "update", name: "第1天", day: " 第2天 ", root }, exec);
  assert.equal(up1.timeline[0].day, "第2天");
  assert.equal(up1.timeline[0].name, "第2天");
  const up2 = await defs.novel_settings.execute({ book, category: "timeline", action: "update", name: "第2天", event: "抵达", root }, exec);
  assert.equal(up2.timeline[0].event, "抵达");
  await assert.rejects(
    defs.novel_settings.execute({ book, category: "timeline", action: "update", name: "第2天", day: "   ", root }, exec),
    /不能为空/
  );

  // #16 outline init 在 characters 清空后清理旧【用户角色设定】区块
  try {
    resetStateFile({ creationProfiles: { [book]: { worldview: "测试世界观", characters: "主角冷静果断" } } });
    await defs.novel_outline.execute({ book, action: "init", root }, exec);
    const mainCharsFile = join(CORE.creationDir(root, book), CORE.CREATION_FILES["characters-main"]);
    assert.ok(readFileSync(mainCharsFile, "utf8").includes("【用户角色设定】"));

    resetStateFile({ creationProfiles: { [book]: { worldview: "测试世界观", characters: "" } } });
    await defs.novel_outline.execute({ book, action: "init", root }, exec);
    assert.equal(readFileSync(mainCharsFile, "utf8").includes("【用户角色设定】"), false, "清空 characters 后重新 init 应移除旧用户角色设定区");
  } finally {
    resetStateFile();
  }

  // #17 outline chapter 拒负数和 0
  await assert.rejects(defs.novel_outline.execute({ book, action: "chapter", number: -5, title: "负章", root }, exec), /正整数/);
  await assert.rejects(defs.novel_outline.execute({ book, action: "chapter", number: 0, title: "零章", root }, exec), /正整数/);
  const outlineContent = readFileSync(join(CORE.creationDir(root, book), CORE.CREATION_FILES.outline), "utf8");
  assert.equal(outlineContent.includes("-5"), false);

  // #18 plot update 拒空白 content
  const addedPlot = await defs.novel_plot.execute({ book, action: "add", content: "初始伏笔内容", root }, exec);
  const pid = addedPlot.entries[0].id;
  await assert.rejects(defs.novel_plot.execute({ book, action: "update", id: pid, content: "   ", root }, exec), /不能为空/);
  const listAfter = await defs.novel_plot.execute({ book, action: "list", root }, exec);
  assert.equal(listAfter.entries[0].content, "初始伏笔内容");
});

test("B6 (#42, #46, #47, #48, #49, #50, #51, #52, #55, #58): 工具契约与异常边界", async () => {
  const root = freshLib("contracts-b");
  const { defs, exec } = createHarness(root);

  // #46 novel_sentence_analysis schema
  const saProps = defs.novel_sentence_analysis.output.schema.properties;
  assert.equal(Object.hasOwn(saProps, "chapter"), false, "output schema 不得含孤儿字段 chapter");
  assert.ok(saProps.paragraphs.required.includes("narrationOnly"), "paragraphs.required 必须包含 narrationOnly");

  // #42 novel_read >3000 字单行裁剪置 hitLineCap: true & truncated: true，同时公开契约与 formatRead 页脚对齐
  const readSchema = defs.novel_read.output.schema;
  assert.ok(Object.hasOwn(readSchema.properties, "hitLineCap"), "novel_read output schema 必须声明 hitLineCap");
  assert.ok(readSchema.required.includes("hitLineCap"), "novel_read output required 必须含 hitLineCap");

  const readBook = "长行书";
  mkdirSync(join(root, "novels", readBook), { recursive: true });
  writeFileSync(join(root, "novels", readBook, "第01章.md"), "甲".repeat(3500), "utf8");
  writeFileSync(join(root, "novels", readBook, "第02章.md"), "乙".repeat(3500) + "\n第二行正文。\n", "utf8");
  writeFileSync(join(root, "novels", readBook, "第03章.md"), "普通单行正文。", "utf8");

  const readRes = await defs.novel_read.execute({ book: readBook, chapter: "1", root }, exec);
  assert.equal(readRes.truncated, true, "单行 >3000 字裁剪后 truncated 必须为 true");
  assert.equal(readRes.hitLineCap, true, "单行 >3000 字裁剪后 hitLineCap 必须为 true");
  assert.ok(readRes.lines[0].text.includes("行过长已裁剪"));
  const renderedEndClip = defs.novel_read.output.render({}, readRes)[0].text;
  assert.equal(renderedEndClip.includes("用 offset="), false, "已达末行且仅单行裁剪时不得给出越界 offset=2 提示");
  assert.ok(renderedEndClip.includes("单行超 3000 字已裁剪"), "单行裁剪到达末尾应如实说明原因");

  const readMultiClip = await defs.novel_read.execute({ book: readBook, chapter: "2", offset: 1, limit: 1, root }, exec);
  assert.equal(readMultiClip.truncated, true);
  assert.equal(readMultiClip.hitLineCap, true);
  const renderedMultiClip = defs.novel_read.output.render({}, readMultiClip)[0].text;
  assert.ok(renderedMultiClip.includes("用 offset=2 继续阅读"), "仍有后续行时应保留 offset=2 续读提示");
  assert.ok(renderedMultiClip.includes("超 3000 字裁剪行"));

  const readNormal = await defs.novel_read.execute({ book: readBook, chapter: "3", root }, exec);
  assert.equal(readNormal.truncated, false);
  assert.equal(readNormal.hitLineCap, false);

  // #49 / #50 / #51 novel_lexicon
  const lexBook = "词表契约书";
  mkdirSync(join(root, "novels", lexBook), { recursive: true });
  writeFileSync(join(root, "novels", lexBook, "第01章.md"), "他拔出宝剑，又望了一眼青霜剑。\n", "utf8");
  await defs.novel_lexicon.execute({ book: lexBook, action: "add", terms: ["青霜剑"], root }, exec);
  // #49 顶层字符串 avoid / aliases
  const lexUp = await defs.novel_lexicon.execute({
    book: lexBook,
    action: "update",
    term: "青霜剑",
    avoid: "宝剑,飞剑",
    aliases: "神剑、仙剑 灵剑",
    root
  }, exec);
  assert.deepEqual(lexUp.entries[0].avoid, ["宝剑", "飞剑"]);
  assert.deepEqual(lexUp.entries[0].aliases, ["神剑", "仙剑", "灵剑"]);

  // #50 & #51 损坏词表层
  const lexPath = CORE.lexiconFile(root, lexBook);
  writeFileSync(lexPath, "{corrupt-json", "utf8");
  await assert.rejects(
    defs.novel_lexicon.execute({ book: lexBook, action: "update", term: "青霜剑", note: "新备注", root }, exec),
    (err) => err?.code === "ENOVELWRITEFAIL"
  );
  await assert.rejects(
    defs.novel_lexicon.execute({ book: lexBook, action: "delete", term: "青霜剑", root }, exec),
    (err) => err?.code === "ENOVELWRITEFAIL"
  );
  assert.equal(readFileSync(lexPath, "utf8"), "{corrupt-json", "拒写时必须保留损坏文件原貌");

  const scanCorrupt = await defs.novel_lexicon.execute({ book: lexBook, action: "scan", root }, exec);
  assert.equal(scanCorrupt.corrupt, true, "scan 必须披露损坏状态");
  assert.ok(Array.isArray(scanCorrupt.corruptFiles) && scanCorrupt.corruptFiles.length >= 1);

  const cleared = await defs.novel_lexicon.execute({ book: lexBook, action: "delete", all: true, force: true, root }, exec);
  assert.equal(cleared.corrupt, void 0);
  assert.equal(cleared.counts.book, 0);

  // #51 scope="global" 无 book 时 add / update / delete 一致性
  const gAdd = await defs.novel_lexicon.execute({ scope: "global", action: "add", terms: ["全局惯用词"], avoid: "俗词", root }, exec);
  assert.equal(gAdd.counts.global, 1);
  const gUp = await defs.novel_lexicon.execute({ scope: "global", action: "update", term: "全局惯用词", aliases: "等价词", root }, exec);
  assert.deepEqual(gUp.entries[0].aliases, ["等价词"]);
  const gDel = await defs.novel_lexicon.execute({ scope: "global", action: "delete", term: "全局惯用词", root }, exec);
  assert.equal(gDel.counts.global, 0);

  // #52 novel_plot scan 覆盖非 "open" 脏状态
  const plotBook = "脏伏笔书";
  mkdirSync(join(root, "novels", plotBook), { recursive: true });
  writeFileSync(join(root, "novels", plotBook, "第01章.md"), "他在密室里找到了那枚玄铁令牌。\n", "utf8");
  mkdirSync(dirname(CORE.plotsFile(root, plotBook)), { recursive: true });
  writeFileSync(CORE.plotsFile(root, plotBook), JSON.stringify({
    book: plotBook,
    entries: [{ id: "dirty1", content: "玄铁令牌来历", status: "pending", createdAt: "2026-01-01T00:00:00.000Z" }]
  }), "utf8");
  const scannedPlot = await defs.novel_plot.execute({ book: plotBook, action: "scan", root }, exec);
  assert.equal(scannedPlot.entries[0].status, "open");
  assert.deepEqual(scannedPlot.entries[0].mentionedIn, ["第01章.md"]);

  // #55 novel_continuity_check OOC 跳过无情感词章
  const oocBook = "OOC无情感书";
  mkdirSync(join(root, "novels", oocBook), { recursive: true });
  await defs.novel_settings.execute({ book: oocBook, category: "character", action: "add", name: "林澈", root }, exec);
  writeFileSync(join(root, "novels", oocBook, "第01章.md"), "林澈推开木门坐在桌前喝了一杯水，拿过名册核对了数字。\n", "utf8");
  writeFileSync(join(root, "novels", oocBook, "第02章.md"), "林澈十分欢喜欣慰，心中满是喜悦与感动，笑容止不住。\n", "utf8");
  const oocRes = await defs.novel_continuity_check.execute({ book: oocBook, ooc: true, root }, exec);
  assert.equal(oocRes.candidates.length, 0, "无情感词章不进效价样本，不应触发 OOC 误报");

  // #58 runBannedContract 区分设定损坏与未登记
  const auditCorruptBook = "坏设定审计书";
  mkdirSync(join(root, "novels", auditCorruptBook), { recursive: true });
  mkdirSync(dirname(CORE.settingsFile(root, auditCorruptBook)), { recursive: true });
  writeFileSync(CORE.settingsFile(root, auditCorruptBook), "{bad-settings", "utf8");
  const repCorrupt = await AUDIT.runAuditContracts({ root, book: auditCorruptBook, chapterFile: "第01章.md", text: "正文内容。\n" });
  const bannedCorrupt = repCorrupt.contracts.find((c) => c.id === "banned");
  assert.equal(bannedCorrupt.ran, false);
  assert.match(bannedCorrupt.reason, /设定表读取失败/);

  const auditEmptyBook = "空设定审计书";
  mkdirSync(join(root, "novels", auditEmptyBook), { recursive: true });
  writeFileSync(CORE.settingsFile(root, auditEmptyBook), JSON.stringify({ book: auditEmptyBook, characters: [], locations: [], items: [], timeline: [], worldview: [] }), "utf8");
  const repEmpty = await AUDIT.runAuditContracts({ root, book: auditEmptyBook, chapterFile: "第01章.md", text: "正文内容。\n" });
  const bannedEmpty = repEmpty.contracts.find((c) => c.id === "banned");
  assert.equal(bannedEmpty.ran, false);
  assert.equal(bannedEmpty.reason, "未登记世界观条目（worldview）");

  // #47 & #48 语义索引空书与 fix_plan anchor（当本地模型可用时执行真实路径）
  if (await EMB.isAvailable()) {
    resetStateFile({ features: { semanticSearch: true, semanticEmbedding: true } });
    try {
      const emptySemBook = "空语义书";
      mkdirSync(join(root, "novels", emptySemBook), { recursive: true });
      const semRes = await defs.novel_semantic_search.execute({ book: emptySemBook, query: "剑", root }, exec);
      assert.equal(semRes.available, true);
      assert.equal(semRes.indexSize, 0);
      assert.equal(semRes.message.includes("写入失败"), false, "空书不得误报索引缓存写入失败");

      const fpBook = "锚空书";
      mkdirSync(join(root, "novels", fpBook), { recursive: true });
      mkdirSync(CORE.creationDir(root, fpBook), { recursive: true });
      writeFileSync(join(CORE.creationDir(root, fpBook), CORE.CREATION_FILES.outline), "# 剧情大纲\n\n- 1 主角前往星际舰桥销毁人工智能主机并夺取逃生舱\n", "utf8");
      const distinct = [
        "他推开木门走进窄巷，长刀靠在青砖墙边，靴底还带着泥点。",
        "风从巷口灌进堂屋，桌面上的油灯晃了几下，灯芯结起黑灰。",
        "掌柜数出三枚铜钱推过柜台，指尖沾着半干的墨渍。",
        "巷尾传来更夫的梆子声，三长两短，混着远处铁器碰响。",
        "他低头检查护手上的裂痕，手指顺着刀背抹掉雨水。",
        "厨房灶台的水开了又凉，锅盖边缘泛出一圈白盐渍。",
        "院墙外的芭蕉叶被雨砸得垂下来，积水顺着石阶往下流。",
        "对面茶楼二楼拉上了木窗，只有一截灯笼留在屋檐下。"
      ];
      const rep = "他在院里站了半晌，反复数着井台边青苔上的裂纹，迟迟没有迈出一步。";
      writeFileSync(join(root, "novels", fpBook, "第01章.md"), [...distinct, rep, rep, rep, rep].join("\n\n"), "utf8");
      const plan = await FIXPLAN.buildFixPlan(root, fpBook, "1", { persist: false });
      const loopItem = plan.items.find((it) => it.type === "原地打转");
      const missItem = plan.items.find((it) => it.type === "大纲漏写");
      assert.ok(loopItem, "应检出原地打转");
      assert.ok(missItem, "应检出大纲漏写");
      assert.equal(loopItem.anchor, "", "原地打转 anchor 应为空串");
      assert.equal(missItem.anchor, "", "大纲漏写 anchor 应为空串");
    } finally {
      resetStateFile();
    }
  }
});

// ===========================================================================
// C. 删书、诊断、日志、状态与 HTTP 路由
// ===========================================================================

test("C1 (#19): restoreTrash / listTrash 畸形 manifest 与缺路径项不销毁回收站", async () => {
  const root = freshLib("trash-malformed");
  const trashBase = TRASH.trashDirPathOf(CORE.novelDataDir(root));

  for (const [idx, payload] of ["{}", "null", '"bad"', "[]"].entries()) {
    const id = `malformed-${idx}-20261118-000000`;
    const dir = join(trashBase, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), payload, "utf8");
    writeFileSync(join(dir, "keep.txt"), "重要备份", "utf8");

    const listed = await BOOKDELETE.listTrash({ root });
    const entry = listed.find((e) => e.id === id);
    assert.ok(entry);
    assert.equal(entry.restorable, false, `畸形清单 ${payload} 不得标记为 restorable`);

    await assert.rejects(BOOKDELETE.restoreTrash({ root, trashId: id }), /清单/);
    assert.ok(existsSync(join(dir, "keep.txt")), `畸形清单 ${payload} 恢复拒绝后备份文件必须仍在`);
  }

  const missingPathId = "missing-path-20261118-000000";
  const missingDir = join(trashBase, missingPathId);
  mkdirSync(missingDir, { recursive: true });
  writeFileSync(join(missingDir, "keep.txt"), "重要备份", "utf8");
  writeFileSync(join(missingDir, "manifest.json"), JSON.stringify({
    schema: 1,
    book: "缺路径书",
    items: [{ from: "", to: join(missingDir, "keep.txt") }]
  }), "utf8");
  const resMissing = await BOOKDELETE.restoreTrash({ root, trashId: missingPathId });
  assert.equal(resMissing.restored, 0);
  assert.equal(resMissing.failed.length, 1);
  assert.ok(existsSync(join(missingDir, "keep.txt")), "缺路径失败项不得销毁回收站目录");

  // #19 补充：结构合法但语义矛盾的「items: [] + 盘内有真实备份」条目不得标 restorable:true 或删目录
  const halfId = "half-empty-20261118-000000";
  const halfDir = join(trashBase, halfId);
  const halfFile = join(halfDir, "novels", "半截书", "第01章.md");
  mkdirSync(dirname(halfFile), { recursive: true });
  writeFileSync(join(halfDir, "manifest.json"), JSON.stringify({ items: [] }), "utf8");
  writeFileSync(halfFile, "这是唯一的备份正文", "utf8");

  const halfListed = await BOOKDELETE.listTrash({ root });
  const halfEntry = halfListed.find((e) => e.id === halfId);
  assert.ok(halfEntry);
  assert.equal(halfEntry.restorable, false, "items:[] 但目录有备份文件时必须标 restorable:false");
  assert.equal(halfEntry.files, 1, "listTrash 必须按实际载荷统计文件数而非轻信 manifest.files");
  await assert.rejects(BOOKDELETE.restoreTrash({ root, trashId: halfId }), /清单/);
  assert.ok(existsSync(halfFile), "半截清单拒恢复后备份正文必须完好保留");
  assert.ok(existsSync(halfDir), "半截清单拒恢复后条目目录必须保留");

  // #19 补充：非空清单但目录内存在未在清单登记的孤儿文件（恢复已登记项后仍阻断删目录）
  const orphanId = "orphan-left-20261118-000000";
  const orphanDir = join(trashBase, orphanId);
  const recordedSrc = join(orphanDir, "novels", "孤儿书", "第01章.md");
  const unrecordedFile = join(orphanDir, "novels", "孤儿书", "孤儿章.md");
  mkdirSync(dirname(recordedSrc), { recursive: true });
  writeFileSync(recordedSrc, "已登记章节", "utf8");
  writeFileSync(unrecordedFile, "未登记但真实存在的备份", "utf8");
  writeFileSync(join(orphanDir, "manifest.json"), JSON.stringify({
    schema: 1,
    book: "孤儿书",
    items: [{ from: join(root, "novels", "孤儿书", "第01章.md"), to: recordedSrc, key: "chapters", files: 1, bytes: 15 }]
  }), "utf8");
  const resOrphan = await BOOKDELETE.restoreTrash({ root, trashId: orphanId });
  assert.equal(resOrphan.restored, 1, "已登记文件应正常恢复");
  assert.ok(resOrphan.failed.some((f) => f.code === "EORPHAN"), "未登记孤儿备份应记 EORPHAN 并阻止删除条目目录");
  assert.ok(existsSync(join(root, "novels", "孤儿书", "第01章.md")));
  assert.ok(existsSync(unrecordedFile), "未登记备份文件绝不能被随目录销毁");
  const postOrphanListed = await BOOKDELETE.listTrash({ root });
  const postOrphanEntry = postOrphanListed.find((e) => e.id === orphanId);
  assert.ok(postOrphanEntry && postOrphanEntry.restorable === false && postOrphanEntry.files === 1);

  // #19 正例：仅含设定库条目的合法删除（items:[], profile:{key,value}, 0 文件）必须仍可恢复且恢复后清理空条目
  resetStateFile({ creationProfiles: { "纯设定书": { worldview: "赛博修仙" } } });
  try {
    const profileDel = await BOOKDELETE.applyBookDelete({ root, book: "纯设定书" });
    const profListed = await BOOKDELETE.listTrash({ root });
    const profEntry = profListed.find((e) => e.id === profileDel.trashId);
    assert.ok(profEntry, "纯设定库删除条目应可见");
    assert.equal(profEntry.restorable, true, "合法的纯设定库条目应标 restorable:true");
    assert.equal(profEntry.files, 0, "manifest.json 不得计入文件数");
    const profRestored = await BOOKDELETE.restoreTrash({ root, trashId: profileDel.trashId });
    assert.equal(profRestored.profileRestored, true);
    assert.equal(existsSync(profileDel.trashDir), false, "合法设定库条目恢复完毕后应清空目录");
    const stAfter = await CORE.readSentenceState();
    assert.equal(stAfter.creationProfiles?.["纯设定书"]?.worldview, "赛博修仙");
  } finally {
    resetStateFile();
  }
});

test("C2 (#20): fake/../OtherBook 与 fake/../lexicon/_global 不命中他书或全局词表", async () => {
  const root = freshLib("delete-traversal");
  const dataDir = CORE.novelDataDir(root);
  mkdirSync(join(dataDir, "lexicon"), { recursive: true });
  const otherLegacy = join(dataDir, "OtherBook.json");
  const globalLex = join(dataDir, "lexicon", "_global.json");
  writeFileSync(otherLegacy, JSON.stringify({ book: "OtherBook", entries: [] }), "utf8");
  writeFileSync(globalLex, JSON.stringify({ book: "_global", enabled: true, entries: [{ term: "留存词" }] }), "utf8");

  const p1 = await BOOKDELETE.planBookDelete({ root, book: "fake/../OtherBook" });
  const allPaths1 = p1.targets.flatMap((t) => t.items || []);
  assert.equal(allPaths1.some((p) => p.includes("OtherBook.json")), false, "穿越 book 参数不得命中 OtherBook.json");
  await assert.rejects(BOOKDELETE.applyBookDelete({ root, book: "fake/../OtherBook" }), /没找到/);
  assert.ok(existsSync(otherLegacy));

  const p2 = await BOOKDELETE.planBookDelete({ root, book: "fake/../lexicon/_global" });
  const allPaths2 = p2.targets.flatMap((t) => t.items || []);
  assert.equal(allPaths2.some((p) => p.includes("_global.json")), false, "穿越 book 参数不得将 _global.json 列入预览");
  assert.ok(existsSync(globalLex));
});

test("C3 (#21): Windows 下大小写不一致删书不遗留 plots/ 与 creationProfiles", async (t) => {
  if (process.platform !== "win32") {
    t.skip("仅在 Windows 大小写不敏感文件系统验证");
    return;
  }
  const root = freshLib("win-ci-delete");
  mkdirSync(join(root, "novels", "MyBook"), { recursive: true });
  writeFileSync(join(root, "novels", "MyBook", "第01章.md"), "正文\n", "utf8");
  mkdirSync(join(root, "novels", "创作资料", "MyBook"), { recursive: true });
  writeFileSync(join(root, "novels", "创作资料", "MyBook", "创作设定.md"), "# 设定\n", "utf8");
  mkdirSync(join(CORE.novelDataDir(root), "plots"), { recursive: true });
  writeFileSync(join(CORE.novelDataDir(root), "plots", "MyBook.json"), "[]", "utf8");
  writeFileSync(join(CORE.novelDataDir(root), "MyBook.json"), "[]", "utf8");

  resetStateFile({ creationProfiles: { MyBook: { worldview: "测试" }, OtherKeep: { worldview: "保留" } } });
  try {
    const { defs, exec } = createHarness(root);
    const applied = await defs.novel_delete_book.execute({ book: "mybook", action: "apply", root }, exec);
    assert.equal(applied.remaining.files, 0);
    assert.equal(existsSync(join(CORE.novelDataDir(root), "plots", "MyBook.json")), false, "plots/MyBook.json 不得遗留");
    assert.equal(existsSync(join(CORE.novelDataDir(root), "MyBook.json")), false, "legacy MyBook.json 不得遗留");
    assert.equal(existsSync(join(root, "novels", "MyBook")), false);
    const st = await CORE.readSentenceState();
    assert.equal(Object.hasOwn(st.creationProfiles || {}, "MyBook"), false, "creationProfiles.MyBook 不得遗留");
    assert.ok(st.creationProfiles?.OtherKeep, "其他书设定应保留");
  } finally {
    resetStateFile();
  }
});

test("C4 (#22, #23, #56, #73, #75): 空草稿目录可删、keys trim、已消失目标达成、选择性空目录统计、日志白名单与私有导出清理", async () => {
  // #73 & #75
  assert.ok(LOG.ALLOWED_KEYS.includes("removedEmptyDirs"));
  assert.equal(LOG.ALLOWED_KEYS.includes("phase"), false);
  assert.equal(LOG.ALLOWED_KEYS.includes("trashId"), false);
  assert.equal("TRASH_DIRNAME" in TRASH, false);
  assert.equal("trashIdPrefixFor" in BOOKDELETE, false);
  assert.equal("resolveBookFolder" in BOOKDELETE, false);

  const root = freshLib("empty-drafts-and-keys");
  const { defs, exec } = createHarness(root);

  // #22 空草稿目录可发现也可清理
  const draftBook = "空草稿书";
  mkdirSync(CORE.draftBookDir(root, draftBook), { recursive: true });
  const pvDraft = await defs.novel_delete_book.execute({ book: draftBook, action: "preview", root }, exec);
  assert.equal(pvDraft.found, true);
  assert.ok(pvDraft.keys.includes("data:drafts"));
  const apDraft = await defs.novel_delete_book.execute({ book: draftBook, action: "apply", root }, exec);
  assert.equal(existsSync(CORE.draftBookDir(root, draftBook)), false);
  assert.ok(apDraft.keys.includes("data:drafts"));

  // #23a keys trim
  const trimBook = "空格键书";
  mkdirSync(join(root, "novels", trimBook), { recursive: true });
  const apTrim = await defs.novel_delete_book.execute({ book: trimBook, action: "apply", keys: [" chapters "], root }, exec);
  assert.deepEqual(apTrim.keys, ["chapters"]);
  assert.equal(existsSync(join(root, "novels", trimBook)), false);

  // #23b 预览后消失的 data:summaries 进入"已达成"分支
  const goneDataBook = "外部删摘要书";
  mkdirSync(join(root, "novels", goneDataBook), { recursive: true });
  const sumFile = CORE.summariesFile(root, goneDataBook);
  mkdirSync(dirname(sumFile), { recursive: true });
  writeFileSync(sumFile, "{}", "utf8");
  rmSync(sumFile, { force: true });
  const apGone = await defs.novel_delete_book.execute({ book: goneDataBook, action: "apply", keys: ["data:summaries"], root }, exec);
  assert.match(apGone.message, /目标已达成/);
  assert.equal(apGone.partial, true, "novels/<书> 仍以空目录存在，应如实标 partial=true");
  assert.deepEqual(apGone.skipped, ["chapters"]);

  // #23c & #56 两处空目录选择性删除：准确报 skipped/partial，且 delete_apply 日志含 removedEmptyDirs
  const twoEmptyBook = "双空目录书";
  mkdirSync(join(root, "novels", twoEmptyBook), { recursive: true });
  mkdirSync(CORE.creationDir(root, twoEmptyBook), { recursive: true });
  const logBeforeLen = existsSync(LOG.logFilePath()) ? readFileSync(LOG.logFilePath(), "utf8").length : 0;
  const apOne = await defs.novel_delete_book.execute({ book: twoEmptyBook, action: "apply", keys: ["chapters"], root }, exec);
  assert.equal(apOne.partial, true);
  assert.deepEqual(apOne.skipped, ["creation"]);
  assert.equal(existsSync(CORE.creationDir(root, twoEmptyBook)), true);

  const appended = readFileSync(LOG.logFilePath(), "utf8").slice(logBeforeLen);
  const delLog = appended
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((ev) => ev && ev.action === "delete_apply" && ev.book === twoEmptyBook);
  assert.ok(delLog, "应记录 delete_apply 日志");
  assert.equal(delLog.removedEmptyDirs, 1, "events.jsonl 应保留 removedEmptyDirs 计数");
});

test("C5 (#24, #25, #57): diagnose 递归 drafts/<book>/、损坏 state.json 不覆盖 config、按书排除全局调用", async () => {
  const root = freshLib("diagnose-fixes");
  const { defs, exec } = createHarness(root);

  // #24 drafts/<book>/ 统计与损坏 JSON 检测
  const draftDir = CORE.draftBookDir(root, "诊断草稿书");
  mkdirSync(draftDir, { recursive: true });
  writeFileSync(join(draftDir, "1__draft.md"), "草稿正文内容", "utf8");
  writeFileSync(join(draftDir, "1__state.json"), "{broken-draft-state", "utf8");
  const d24 = await DIAGNOSE.buildDiagnosis({ root }, { root }, exec);
  const draftSub = d24.dataDir.subdirs.find((s) => s.name === "drafts");
  assert.ok(draftSub && draftSub.files === 2 && draftSub.bytes > 0, "drafts 子目录应统计到二级文件");
  assert.ok(d24.dataDir.corruptTotal >= 1);
  assert.ok(d24.dataDir.corruptFiles.some((f) => f.rel.startsWith("drafts/")));

  // #57 按书诊断不把无书名全局调用算入本书 calls / byTool
  await defs.novel_books.execute({ root }, exec);
  const d57 = await defs.novel_diagnose.execute({ book: "从未调用过的新书", days: 7, root }, exec);
  assert.equal(d57.calls.total, 0, "全局无书名调用不得算进本书 calls");
  assert.deepEqual(d57.byTool, []);
  assert.ok(d57.issues.some((it) => it.title.includes("没有与《从未调用过的新书》相关的调用记录")));

  // #25 state.json 损坏时不覆盖 config，checklist 与 issues 同源标 warn
  writeFileSync(STATE_FILE, "{broken-state-json", "utf8");
  try {
    const d25 = await DIAGNOSE.buildDiagnosis({ root, sentenceAnalysis: { enabled: false, autoAnalyze: false } }, { root }, exec);
    assert.equal(d25.tools.stateFile.exists, true);
    assert.equal(d25.tools.stateFile.readable, false);
    assert.equal(d25.tools.master.enabled, false, "state.json 损坏时不得覆盖 config.sentenceAnalysis.enabled=false");
    assert.notEqual(d25.tools.master.source, "state.json");
    const stateCheck = d25.checklist.find((c) => c.item === "开关与状态快照");
    assert.equal(stateCheck?.state, "warn");
    assert.ok(d25.issues.some((it) => it.level === "warn" && it.title.includes("状态文件损坏")), "issues 应包含 state.json 损坏 warn 条目");
  } finally {
    resetStateFile();
  }
});

test("C6 (#26, #27): continuity_check 空白 chapter 不入衔接模式；sentence_config 空白 config.root 走 resolveUiRootInfo", async () => {
  const root = freshLib("blank-inputs");
  const book = "空白参数书";
  const dir = join(root, "novels", book);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "第01章.md"), "“你好。”他说。\n", "utf8");
  writeFileSync(join(dir, "第02章.md"), "“再见。”她答。\n", "utf8");

  // #26
  const { defs, exec } = createHarness(root);
  const cont = await defs.novel_continuity_check.execute({ book, chapter: "   ", root }, exec);
  assert.equal(cont.action, void 0, "空白 chapter 不得进入单章衔接模式");
  assert.ok(Array.isArray(cont.checklist) && cont.checklist.length > 0, "空白 chapter 应走全书审计并返回 checklist");
  const contOoc = await defs.novel_continuity_check.execute({ book, chapter: "   ", ooc: true, root }, exec);
  assert.equal(contOoc.action, "OOC", "空白 chapter 与 ooc=true 同时传时不应被误判为互斥冲突");

  // #27 config.root 为纯空白时应走 resolveUiRootInfo 回退到有效 cwd 书库根，不创建 "   " 目录
  const cfgRoot = freshLib("blank-config-root");
  const book27 = "配置解析书";
  mkdirSync(join(cfgRoot, "novels"), { recursive: true });
  resetStateFile({ lastRoot: join(cfgRoot, "不存在的过期根") });
  const hBlank = createHarness(cfgRoot, { root: "   " });
  const oldCwd = process.cwd();
  process.chdir(cfgRoot);
  try {
    await hBlank.defs.novel_sentence_config.execute({
      action: "set",
      creationProfiles: { [book27]: { worldview: "赛博朋克测试" } }
    }, { agent: { session: { header: { cwd: cfgRoot } } } });
    assert.equal(existsSync(join(cfgRoot, "   ")), false, "绝不能用未 trim 的空白串建目录");
    assert.ok(existsSync(join(CORE.creationDir(cfgRoot, book27), CORE.CREATION_FILES.bible)), "应写入 resolveUiRootInfo 解析的 cwd 书库根");
  } finally {
    process.chdir(oldCwd);
    resetStateFile();
  }
});

test("C7 (#28, #29, #30): clampStyleTolerance / POST /state 过滤 / 5 路由 413 / POST /baseline 500", async () => {
  // #28 clampStyleTolerance 拦 low > high
  assert.deepEqual(CORE.clampStyleTolerance({ complexity: { low: 50, high: -30 } }), {});
  assert.deepEqual(CORE.clampStyleTolerance({ complexity: { low: -10, high: 15 } }), { complexity: { low: -10, high: 15 } });

  const root = freshLib("http-routes");
  const { defs, exec, routeOf } = createHarness(root);
  const stateRoute = routeOf("/api/dsh-novel-writer/state");
  const baselineRoute = routeOf("/api/dsh-novel-writer/baseline");

  resetStateFile();
  try {
    // 工具侧先设置合法容差，再传全非法容差不清空，显式 {} 可清空
    await defs.novel_sentence_config.execute({ action: "set", styleTolerance: { complexity: { low: -12, high: 18 } } }, exec);
    await defs.novel_sentence_config.execute({ action: "set", styleTolerance: { complexity: { low: 50, high: -30 } } }, exec);
    let st = await CORE.readSentenceState();
    assert.deepEqual(st.styleTolerance, { complexity: { low: -12, high: 18 } }, "全非法容差不得清空既有容差");

    // 路由侧同样验证
    const badTolRes = mkRes();
    await stateRoute.handler(mkReq("/api/dsh-novel-writer/state", "POST", JSON.stringify({
      styleTolerance: { complexity: { low: "bad", high: "bad" } }
    })), badTolRes);
    assert.equal(badTolRes.status, 200);
    st = await CORE.readSentenceState();
    assert.deepEqual(st.styleTolerance, { complexity: { low: -12, high: 18 } });

    const clearTolRes = mkRes();
    await stateRoute.handler(mkReq("/api/dsh-novel-writer/state", "POST", JSON.stringify({ styleTolerance: {} })), clearTolRes);
    assert.equal(clearTolRes.status, 200);
    st = await CORE.readSentenceState();
    assert.deepEqual(st.styleTolerance, {}, "显式传入 {} 仍应清空容差");

    // #29 writeSentenceState / novel_sentence_config / POST /state 对数组/非对象显式拒绝，对纯对象按白名单过滤非布尔与未知键
    await assert.rejects(
      CORE.writeSentenceState({ tools: ["novel_books"] }),
      /必须是键值对象/,
      "writeSentenceState 传数组 tools 必须显式抛错"
    );
    await assert.rejects(
      CORE.writeSentenceState({ features: ["semanticEmbedding"] }),
      /必须是键值对象/,
      "writeSentenceState 传数组 features 必须显式抛错"
    );
    await assert.rejects(
      defs.novel_sentence_config.execute({ action: "set", tools: ["novel_books"] }, exec),
      /必须是键值对象/,
      "novel_sentence_config 传数组 tools 必须显式抛错"
    );
    await assert.rejects(
      defs.novel_sentence_config.execute({ action: "set", features: "bad" }, exec),
      /必须是键值对象/,
      "novel_sentence_config 传非对象 features 必须显式抛错"
    );

    const arrToolsRes = mkRes();
    await stateRoute.handler(mkReq("/api/dsh-novel-writer/state", "POST", JSON.stringify({ tools: ["bad"] })), arrToolsRes);
    assert.equal(arrToolsRes.status, 400, "POST /state 数组 tools 必须返回 400");

    const arrFeatRes = mkRes();
    await stateRoute.handler(mkReq("/api/dsh-novel-writer/state", "POST", JSON.stringify({ features: ["bad"] })), arrFeatRes);
    assert.equal(arrFeatRes.status, 400, "POST /state 数组 features 必须返回 400");

    const dirtyStateRes = mkRes();
    await stateRoute.handler(mkReq("/api/dsh-novel-writer/state", "POST", JSON.stringify({
      features: { evilKey: "notBool", semanticStyle: "false", lexiconFirst: false }
    })), dirtyStateRes);
    assert.equal(dirtyStateRes.status, 200);
    st = await CORE.readSentenceState();
    assert.equal(Object.hasOwn(st.tools || {}, "0"), false, "数组 tools 不得展开成数字键写盘");
    assert.equal(Object.hasOwn(st.features || {}, "evilKey"), false, "未知 feature 键必须被过滤");
    assert.equal(st.features?.semanticStyle, false, "非布尔值不得覆盖已有布尔设置");
    assert.equal(st.features?.lexiconFirst, false, "合法布尔值应正常落盘");

    // #30 5 条 POST 路由 >1 MiB 返回 413
    const over1MB = Buffer.alloc(1024 * 1024 + 64, 65);
    for (const p of [
      "/api/dsh-novel-writer/reveal",
      "/api/dsh-novel-writer/reports",
      "/api/dsh-novel-writer/delete-book",
      "/api/dsh-novel-writer/metric-caliber",
      "/api/dsh-novel-writer/audit"
    ]) {
      const r = routeOf(p);
      assert.ok(r, "路由应存在：" + p);
      const res = mkRes();
      await r.handler(mkReq(p, "POST", over1MB), res);
      assert.equal(res.status, 413, `${p} 超限请求体应返回 413`);
    }

    // #30 POST /baseline 写盘失败返回 500
    const badBaseBook = "基线写失败书";
    mkdirSync(join(root, "novels", badBaseBook), { recursive: true });
    // 用同名目录占位 baseline/<book>.json 触发 atomicWriteJson 抛出 ENOVELWRITEFAIL
    mkdirSync(CORE.baselineScopeFile(root, badBaseBook), { recursive: true });
    const baseFailRes = mkRes();
    await baselineRoute.handler(mkReq("/api/dsh-novel-writer/baseline", "POST", JSON.stringify({
      book: badBaseBook,
      mode: "all"
    })), baseFailRes);
    assert.equal(baseFailRes.status, 500, "POST /baseline 写盘失败必须返回 500 而非 400");
  } finally {
    resetStateFile();
  }
});

// ===========================================================================
// D. MCP 与客户端回归
// ===========================================================================

test("D1 (#38 & #39): mcp/server.mjs Windows 小写盘符 stderr 脱敏与无 id 畸形请求回 -32600", async () => {
  const mcpRoot = freshLib("mcp-redact-rpc");
  const driveRoot = process.platform === "win32"
    ? mcpRoot.replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase() + ":")
    : mcpRoot;

  const serverPath = join(REPO_ROOT, "mcp", "server.mjs");
  const child = spawn(process.execPath, [serverPath, "--root", driveRoot], {
    cwd: REPO_ROOT,
    env: { ...process.env, DSH_NOVEL_WRITER_STATE: STATE_FILE, DSH_HOME: DSH_HOME_DIR },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const frames = [];
  const stderrChunks = [];
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => { try { frames.push(JSON.parse(line)); } catch { /* ignore */ } });
  child.stderr.on("data", (c) => stderrChunks.push(String(c)));

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
  // #39 三种无 id 且缺/非字符串 method 的畸形对象
  send({});
  send({ jsonrpc: "2.0", params: {} });
  send({ jsonrpc: "2.0", method: 123 });
  // #38 触发工具执行失败写入 stderr
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "novel_chapters", arguments: { book: "不存在的书" } } });
  send({ jsonrpc: "2.0", id: 3, method: "ping" });
  child.stdin.end();

  const exit = await new Promise((resolve, reject) => {
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("MCP 进程未按预期退出")); }, 15000);
    child.on("exit", (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
  });
  rl.close();

  assert.equal(exit.code, 0);
  const badReqErrors = frames.filter((f) => f && f.id === null && f.error && f.error.code === -32600);
  assert.equal(badReqErrors.length, 3, "无 id 缺/非字符串 method 应全部回 -32600：" + JSON.stringify(frames));

  const stderrText = stderrChunks.join("");
  const errorLines = stderrText.split(/\r?\n/).filter((l) => l.includes("执行失败"));
  assert.ok(errorLines.length >= 1, "stderr 应记录工具执行失败摘要：" + stderrText);
  assert.ok(errorLines.every((l) => l.includes("<书库根>") && !l.toLowerCase().includes(mcpRoot.toLowerCase())),
    "stderr 错误行应脱敏为 <书库根> 且不得泄漏大小写不一致的真实书库根：" + stderrText);
});

test("D2 (#40): mcp/server.mjs 管道模式 >5s 请求不被 5s 强退定时器腰斩", async () => {
  const pluginDir = join(TMP_BASE, "slow-mcp-plugin");
  mkdirSync(join(pluginDir, "lib"), { recursive: true });
  mkdirSync(join(pluginDir, "mcp"), { recursive: true });
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "slow-mcp-test", version: "1.0.0", type: "module" }), "utf8");
  writeFileSync(join(pluginDir, "mcp", "server.mjs"), readFileSync(join(REPO_ROOT, "mcp", "server.mjs"), "utf8"), "utf8");
  writeFileSync(join(pluginDir, "lib", "index.js"), `
import { setTimeout as wait } from "node:timers/promises";
export async function apply(ctx) {
  ctx.tools.register({
    name: "novel_slow_probe",
    description: "slow probe",
    parameters: { type: "object", properties: {} },
    async execute(_args, exec) {
      await wait(5200, undefined, { signal: exec.signal });
      return "done-after-5.2s";
    }
  });
}
`, "utf8");

  const slowRoot = freshLib("slow-mcp-root");
  const child = spawn(process.execPath, [join(pluginDir, "mcp", "server.mjs"), "--root", slowRoot], {
    cwd: pluginDir,
    env: { ...process.env, DSH_NOVEL_WRITER_STATE: STATE_FILE, DSH_HOME: DSH_HOME_DIR },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const frames = [];
  const stderrChunks = [];
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => { try { frames.push(JSON.parse(line)); } catch { /* ignore */ } });
  child.stderr.on("data", (c) => stderrChunks.push(String(c)));

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "novel_slow_probe", arguments: {} } }) + "\n");
  child.stdin.end(); // 管道模式立即关闭 stdin

  const exit = await new Promise((resolve, reject) => {
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("慢请求超时未退出")); }, 15000);
    child.on("exit", (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
  });
  rl.close();

  assert.equal(exit.code, 0, "慢请求结束后应 exit 0，stderr=" + stderrChunks.join(""));
  const toolFrame = frames.find((f) => f && f.id === 2);
  assert.ok(toolFrame && toolFrame.result, "超过 5s 的在途请求应完整返回 stdout 响应：" + JSON.stringify(frames));
  assert.ok(String(toolFrame.result.content?.[0]?.text ?? "").includes("done-after-5.2s"));
});

test("D3 (#60, #76, #77, #78): client.js 词典英中键全对称、9 组死键清理、死图标清理与死 CSS 清理", () => {
  const clientSrc = readFileSync(join(REPO_ROOT, "lib", "client.js"), "utf8");

  // #60 & #76 提取 zh / en 词典对象并在 vm 沙箱求值
  const zhStart = clientSrc.indexOf("var zh = {");
  const enEnd = clientSrc.indexOf("function currentLang()");
  assert.ok(zhStart > 0 && enEnd > zhStart, "应能定位 lib/client.js 中的 zh/en 词典块");
  const dictSandbox = {};
  vm.runInNewContext(clientSrc.slice(zhStart, enEnd), dictSandbox);
  const zhKeys = Object.keys(dictSandbox.zh).sort();
  const enKeys = Object.keys(dictSandbox.en).sort();
  assert.deepEqual(enKeys, zhKeys, "en 与 zh 词典键集合必须完全对称");
  assert.equal(typeof dictSandbox.zh["audit.howto"], "string");
  assert.equal(typeof dictSandbox.en["audit.howto"], "string");

  const removedI18nKeys = [
    "panel.spSceneInactive", "feature.rawWriting.desc", "del.li",
    "plot.open", "plot.copy", "model.engine",
    "base.rangeTitle", "base.rangeHint", "creation.listTitle"
  ];
  for (const k of removedI18nKeys) {
    assert.equal(Object.hasOwn(dictSandbox.zh, k), false, "死键应已从 zh 删除：" + k);
    assert.equal(Object.hasOwn(dictSandbox.en, k), false, "死键应已从 en 删除：" + k);
  }

  // #77 NW_ICONS / NW_ICONS_C 不含死图标
  const iconsStart = clientSrc.indexOf("/* ===== V6:icons ===== */");
  const iconsEnd = clientSrc.indexOf("/* ===== /V6:icons ===== */");
  assert.ok(iconsStart > 0 && iconsEnd > iconsStart);
  const iconSandbox = {};
  vm.runInNewContext(clientSrc.slice(iconsStart, iconsEnd), iconSandbox);
  for (const deadIcon of ["analyze", "settings", "create", "toolRow"]) {
    assert.equal(Object.hasOwn(iconSandbox.NW_ICONS, deadIcon), false, "NW_ICONS 不得含死图标：" + deadIcon);
    assert.equal(Object.hasOwn(iconSandbox.NW_ICONS_C, deadIcon), false, "NW_ICONS_C 不得含死图标：" + deadIcon);
  }

  // #78 V6-components.css 已清理同权自覆盖死声明，注释口径一致
  const v6Css = readFileSync(join(REPO_ROOT, "tools", "client-src", "V6-components.css"), "utf8");
  assert.equal(/\.nwPrefGlyph\{[^}]*color:var\(--dsw-alias-state-business-primary\)/.test(v6Css), false, "应移除被同权覆盖的 .nwPrefGlyph color 声明");
  assert.equal(/\.nwPref\.nwPrefDanger\{[^}]*background:color-mix/.test(v6Css), false, "应移除被同权覆盖的 .nwPref.nwPrefDanger background 声明");
  assert.ok(v6Css.includes(".nwPrefGlyph{color:inherit}"));
  assert.ok(v6Css.includes(".nwPref.nwPrefDanger{background:none}"));
  assert.match(clientSrc, /导出 6 个原语：5 个用于生产 render，DisclosureRow 保留/);
});

test("隔离守卫：用户真实 ~/.dsh 目录全程未被写入", () => {
  const realAfter = { state: digestFile(REAL_STATE), logs: digestDir(REAL_LOG_DIR) };
  assert.deepEqual(realAfter, realBefore, "测试全过程绝不能改动用户真实 ~/.dsh 配置与日志");
});
