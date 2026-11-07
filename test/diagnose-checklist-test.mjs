/**
 * 诊断报告（lib/diagnose.js）的审查修复回归测试 —— v7.0.0 #26 / #56 / #57 / #58。
 *
 * 隔离方式与 log-test 相同：**先设 env，再动态 import**（静态 import 会先于模块体求值，
 * 那样 stateFilePath()/logDir() 会读到真实用户目录）。
 *
 * 锁四件事：
 *   ① #26 体检清单不再硬编码 checked：数据目录损坏 / 书库读取失败 / 语义模型缺失 /
 *      状态文件损坏时，对应项必须是 warn（不是"打勾显示正常"）。
 *   ② #56 按书诊断时，不带 book 的系统级事件（engine 类）必须保留并标注"系统级"，
 *      同时带 book 的其它书事件仍要被过滤。
 *   ③ #57 默认关闭的 rawWriting 不得被报成"功能开关处于关闭"——它只进"可选未开启"；
 *      默认开启却被用户关掉的项（genreTheme）仍要报。
 *   ④ #58 SyntaxError / Unexpected token 这类 JSON 解析异常要归类为 corrupt，不是 unknown。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// ── 隔离夹具：先设 env，再动态 import ───────────────────────────────────────
const ROOT = await mkdtemp(join(tmpdir(), "dsh-diag-checklist-"));
process.env.DSH_NOVEL_WRITER_STATE = join(ROOT, "state-dir", "state.json");
await mkdir(join(ROOT, "state-dir"), { recursive: true });
process.on("exit", () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

const { buildDiagnosis, formatDiagnosis, buildChecklist, classifyCacheError } = await import("../lib/diagnose.js");
const { logEvent } = await import("../lib/log.js");

const BOOK = "测试书";
const LIB = join(ROOT, "lib-root");
const STATE = process.env.DSH_NOVEL_WRITER_STATE;

async function seedLibrary() {
  const dir = join(LIB, "novels", BOOK);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "第01章.md"), "他推开门，抓起桌上的长刀，走进雨里。", "utf8");
}
await seedLibrary();

async function writeState(obj) {
  await writeFile(STATE, JSON.stringify(obj), "utf8");
}

/** 从 checklist 里按 item 名称子串取一项 */
const itemOf = (checklist, needle) => (checklist ?? []).find((it) => String(it.item ?? "").includes(needle));

// ── ④ #58 classifyCacheError ────────────────────────────────────────────────

test("#58 Unexpected token / SyntaxError 归类为 corrupt（不是 unknown）", () => {
  assert.equal(classifyCacheError("Unexpected token '}'"), "corrupt");
  assert.equal(classifyCacheError("SyntaxError: Unexpected end of JSON input"), "corrupt");
  assert.equal(classifyCacheError("Unexpected token '}', \"...\" is not valid JSON"), "corrupt");
  // 既有分类不受影响
  assert.equal(classifyCacheError("ENOSPC: no space left on device"), "no-space");
  assert.equal(classifyCacheError("EACCES: permission denied"), "denied");
  assert.equal(classifyCacheError("EBUSY: resource busy or locked"), "locked");
  assert.equal(classifyCacheError("完全无法归类的文本"), "unknown");
});

// ── ① #26 体检清单动态状态（纯函数直测，覆盖模型缺失这种无法在测试里伪造的文件状态） ──

const BASE_CHECKLIST_CTX = Object.freeze({
  action: "report",
  days: 7,
  rootLooksOk: true,
  dataDir: { exists: true, corruptTotal: 0, unreadableTotal: 0, emptyTotal: 0 },
  engine: {
    modelPresent: true, loaded: false,
    modelDir: "lib/models", errorCode: "", errorLabel: "",
    lastCacheErrorCode: "", lastCacheErrorLabel: "",
    events: { count: 0, system: 0, codes: [] }
  },
  switches: {
    stateFile: { path: "state.json", exists: true, readable: true },
    features: { effective: { semanticEmbedding: true }, disabled: [], optionalOff: [] }
  },
  library: {
    chapterCount: 3, chars: 90, partial: false, scannedFiles: 3,
    listFailed: false, unreadableBookCount: 0, unreadableTotal: 0
  }
});

function checklistOf(patch) {
  return buildChecklist({
    ...BASE_CHECKLIST_CTX,
    ...patch,
    engine: { ...BASE_CHECKLIST_CTX.engine, ...(patch.engine ?? {}) },
    dataDir: { ...BASE_CHECKLIST_CTX.dataDir, ...(patch.dataDir ?? {}) },
    switches: { ...BASE_CHECKLIST_CTX.switches, ...(patch.switches ?? {}) },
    library: { ...BASE_CHECKLIST_CTX.library, ...(patch.library ?? {}) }
  });
}

test("#26 全部健康时四项体检是 checked（不是 skipped）", () => {
  const list = checklistOf({});
  for (const needle of ["书库内容体检", "插件数据目录体检", "语义引擎", "开关与状态快照"]) {
    const item = itemOf(list, needle);
    assert.ok(item, "缺少体检项：" + needle);
    assert.equal(item.state, "checked", needle + " 健康时应为 checked：" + JSON.stringify(item));
  }
});

test("#26 语义模型文件缺失 → 语义引擎项必须是 warn，且 note 写清原因", () => {
  const list = checklistOf({ engine: { modelPresent: false } });
  const item = itemOf(list, "语义引擎");
  assert.equal(item.state, "warn", "模型缺失却仍打勾：" + JSON.stringify(item));
  assert.ok(item.note.includes("模型文件不在位"), "note 应写清模型缺失：" + item.note);
});

test("#26 语义引擎上次初始化失败 → 语义引擎项必须是 warn", () => {
  const item = itemOf(checklistOf({ engine: { errorCode: "wasm-failed", errorLabel: "WASM 会话创建或推理失败" } }), "语义引擎");
  assert.equal(item.state, "warn", JSON.stringify(item));
  assert.ok(item.note.includes("wasm-failed"));
});

test("#26 数据目录有损坏 / 读不出 / 0 字节文件 → 数据目录项必须是 warn", () => {
  const corrupt = itemOf(checklistOf({ dataDir: { corruptTotal: 2 } }), "插件数据目录体检");
  assert.equal(corrupt.state, "warn", JSON.stringify(corrupt));
  assert.ok(corrupt.note.includes("损坏"), corrupt.note);

  const unreadable = itemOf(checklistOf({ dataDir: { unreadableTotal: 1 } }), "插件数据目录体检");
  assert.equal(unreadable.state, "warn", JSON.stringify(unreadable));

  const empty = itemOf(checklistOf({ dataDir: { emptyTotal: 1 } }), "插件数据目录体检");
  assert.equal(empty.state, "warn", JSON.stringify(empty));

  // 目录不存在仍是 skipped（"没跑"不能冒充"跑过且正常"）
  const missing = itemOf(checklistOf({ dataDir: { exists: false } }), "插件数据目录体检");
  assert.equal(missing.state, "skipped");
});

test("#26 书库读取失败 → 书库内容体检项必须是 warn", () => {
  const listFailed = itemOf(checklistOf({ library: { listFailed: true } }), "书库内容体检");
  assert.equal(listFailed.state, "warn", JSON.stringify(listFailed));
  assert.ok(listFailed.note.includes("作品清单读取失败"), listFailed.note);

  const unreadableBook = itemOf(checklistOf({ library: { unreadableBookCount: 1 } }), "书库内容体检");
  assert.equal(unreadableBook.state, "warn", JSON.stringify(unreadableBook));

  const unreadableChapter = itemOf(checklistOf({ library: { unreadableTotal: 2 } }), "书库内容体检");
  assert.equal(unreadableChapter.state, "warn", JSON.stringify(unreadableChapter));
});

test("#26 状态文件存在但读不动 → 开关快照项必须是 warn；文件不存在属正常（checked）", () => {
  const broken = itemOf(checklistOf({ switches: { stateFile: { path: "state.json", exists: true, readable: false } } }), "开关与状态快照");
  assert.equal(broken.state, "warn", JSON.stringify(broken));
  assert.ok(broken.note.includes("读不动") || broken.note.includes("损坏"), broken.note);

  const absent = itemOf(checklistOf({ switches: { stateFile: { path: "state.json", exists: false, readable: true } } }), "开关与状态快照");
  assert.equal(absent.state, "checked", "没有 state.json 是常态，不该 warn：" + JSON.stringify(absent));
});

// ── ② #56 按书诊断保留系统级事件 ────────────────────────────────────────────

test("#56 按书诊断时，不带 book 的 engine 事件仍被统计并标注为系统级", async () => {
  await writeState({ enabled: true, autoAnalyze: true, features: {} });
  // 系统级：不带 book 的引擎事件（真实日志里 engine 事件本来就没有 book 字段）
  logEvent("engine", { code: "model-missing", level: "warn" });
  // 其它书的工具调用（必须被 book 过滤掉）
  logEvent("tool_call", { tool: "probe_book_tool", status: "failed", book: "别书" });
  // 本书的工具调用（保留）
  logEvent("tool_call", { tool: "probe_book_tool", status: "ok", book: BOOK });
  // 没有 book 的系统级失败调用（保留，并应标注 system:true）
  logEvent("tool_call", { tool: "probe_sys_tool", status: "failed" });

  const result = await buildDiagnosis({ root: LIB }, { book: BOOK, root: LIB, days: 7 }, null);
  assert.equal(result.book, BOOK);

  // engine 事件必须在（旧行为：readLogEvents({book}) 会把它整条丢掉）
  const engineKind = (result.byKind ?? []).find((k) => k.kind === "engine");
  assert.ok(engineKind && engineKind.count >= 1, "按书诊断吞掉了系统级 engine 事件：" + JSON.stringify(result.byKind));
  assert.ok((result.tools.engine.events?.count ?? 0) >= 1, "engine 事件计数为 0：" + JSON.stringify(result.tools.engine));

  // 其它书的事件必须被过滤：probe_book_tool 只剩本书那 1 条
  const byTool = (result.byTool ?? []).find((row) => row.tool === "probe_book_tool");
  assert.ok(byTool, "本书的 probe_book_tool 调用丢了");
  assert.equal(byTool.total, 1, "其它书的事件没有被过滤：" + JSON.stringify(byTool));

  // 系统级失败调用被保留，并带 system 标记
  const sysProblem = (result.problems ?? []).find((p) => p.tool === "probe_sys_tool");
  assert.ok(sysProblem, "系统级失败调用被吞掉了：" + JSON.stringify(result.problems));
  assert.equal(sysProblem.system, true, "系统级事件未标注：" + JSON.stringify(sysProblem));

  // 报告里要能读出"系统级"
  const report = formatDiagnosis(result);
  assert.ok(report.includes("系统级"), "报告没有标注系统级事件：" + report.slice(0, 400));
});

// ── ③ #57 默认关闭的 rawWriting 不算异常 ────────────────────────────────────

test("#57 只有 rawWriting 关闭时，issues 里没有「功能开关处于关闭」；它只进可选未开启", async () => {
  await writeState({ enabled: true, autoAnalyze: true, features: { rawWriting: false } });
  const result = await buildDiagnosis({ root: LIB }, { root: LIB, days: 7 }, null);

  assert.ok(!result.issues.some((it) => it.title.includes("功能开关处于关闭")), "默认关闭的 rawWriting 被误报：" + JSON.stringify(result.issues));
  assert.ok(!(result.tools.disabledFeatures ?? []).includes("rawWriting"), "rawWriting 不该进 disabledFeatures");
  assert.ok((result.tools.optionalOffFeatures ?? []).includes("rawWriting"), "rawWriting 应归到可选未开启");
  const report = formatDiagnosis(result);
  assert.ok(report.includes("可选未开启"), "报告应单独展示可选未开启：" + report);
  assert.ok(report.includes("rawWriting"), "报告应点名 rawWriting：" + report);
});

test("#57 默认开启却被关掉的 genreTheme 仍要报（不能把异常也一起静音）", async () => {
  await writeState({ enabled: true, autoAnalyze: true, features: { rawWriting: false, genreTheme: false } });
  const result = await buildDiagnosis({ root: LIB }, { root: LIB, days: 7 }, null);
  const hit = result.issues.find((it) => it.title.includes("功能开关处于关闭"));
  assert.ok(hit, "默认开启的 genreTheme 被关闭却没报：" + JSON.stringify(result.issues));
  assert.ok(hit.title.includes("1 个"), "只应数到 genreTheme 一个：" + hit.title);
  assert.ok((result.tools.disabledFeatures ?? []).includes("genreTheme"));
  assert.ok(!(result.tools.disabledFeatures ?? []).includes("rawWriting"));
});

// ── #26 端到端：数据目录损坏 / 状态文件损坏 → 报告 checklist 必须 warn ──────

test("#26-e2e 插件数据目录有损坏 JSON 时，体检清单的数据目录项为 warn", async () => {
  const plotDir = join(LIB, ".novel-writer", "plots");
  await mkdir(plotDir, { recursive: true });
  await writeFile(join(plotDir, "坏文件.json"), "{broken", "utf8");
  await writeState({ enabled: true, autoAnalyze: true, features: {} });
  try {
    const result = await buildDiagnosis({ root: LIB }, { root: LIB, days: 7 }, null);
    const item = itemOf(result.checklist, "插件数据目录体检");
    assert.equal(item.state, "warn", "数据目录损坏却仍打勾：" + JSON.stringify(item));
    const report = formatDiagnosis(result);
    assert.ok(report.includes("[异常]"), "报告末节应体现异常状态：" + report.slice(-400));
  } finally {
    await rm(plotDir, { recursive: true, force: true });
  }
});

test("#26-e2e state.json 损坏时，体检清单的开关快照项为 warn", async () => {
  await writeFile(STATE, "{broken", "utf8");
  const result = await buildDiagnosis({ root: LIB }, { root: LIB, days: 7 }, null);
  const item = itemOf(result.checklist, "开关与状态快照");
  assert.equal(item.state, "warn", "状态文件损坏却仍打勾：" + JSON.stringify(item));
  assert.equal(typeof formatDiagnosis(result), "string");
});
