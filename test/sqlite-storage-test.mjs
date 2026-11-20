/**
 * test/sqlite-storage-test.mjs —— v8.0.0 SQLite 存储层、节点版本闸门与跨进程锁回归套件（第 45 个测试套件）
 *
 * 覆盖范围：
 *   1. lib/node-version.js 边界校验（22.12.x -> false / >=22.13 -> true / 非法串 -> false）与 mcp/server.mjs <22.13 启动闸门
 *   2. SQLite WAL、schemaVersion === 1 与严格 readOnly 守卫（冷启动绝不创建 cache.sqlite）
 *   3. Float32 BLOB 非对齐视图解码（byteOffset % 4 !== 0）与 128/512 维编解码往返
 *   4. 损坏自愈：只读读损坏库返回 null 且不动原文件；可写路径自动重建并记录脱敏 sqlite_recover 日志
 *   5. 大书增量加速（205 章仅改 1 章：204 章精确保留 updated_at，1 章更新，耗时显著优于全量；readSceneBaselinesSafe 只读返回 205 章）
 *   6. embedding.js 128 维 BLOB 持久化与缓存失效重载 + vector-audit.js 跨会话 SQLite LRU 零重算命中
 *   7. metric-caliber 过期口径检测与选择性重建（不碰 embedding_meta / audit_vectors）+ diagnose.js sqliteCache 纯元数据与金丝雀不泄露
 *   8. 真实双进程并发 withFileTx 40 次累加无丢更新 + 陈旧锁（>30s）自动恢复
 *   9. 隔离守卫：真实 ~/.dsh/dsh-novel-writer/ 目录全程哈希一致
 *
 * 运行：node test/sqlite-storage-test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

// ===========================================================================
// 严格隔离：先重定向 DSH_NOVEL_WRITER_STATE / DSH_HOME，再动态 import lib/*
// ===========================================================================

const PREV_STATE_ENV = process.env.DSH_NOVEL_WRITER_STATE;
const PREV_HOME_ENV = process.env.DSH_HOME;
const REAL_DSH_DIR = join(homedir(), ".dsh", "dsh-novel-writer");

function digestTree(rootPath) {
  try {
    if (!existsSync(rootPath)) return "absent";
    const lst = lstatSync(rootPath);
    if (lst.isSymbolicLink()) return "symlink";
    if (lst.isFile()) return "file:" + createHash("sha256").update(readFileSync(rootPath)).digest("hex");
    if (!lst.isDirectory()) return "other";
    const entries = readdirSync(rootPath).sort((a, b) => a.localeCompare(b));
    return "dir:[" + entries.map((name) => name + "=" + digestTree(join(rootPath, name))).join("|") + "]";
  } catch {
    return "unreadable";
  }
}

const realBefore = digestTree(REAL_DSH_DIR);

const TMP_BASE = realpathSync.native(mkdtempSync(join(tmpdir(), "dsh-sqlite-storage-" + process.pid + "-")));
const STATE_FILE = join(TMP_BASE, "state.json");
const DSH_HOME_DIR = join(TMP_BASE, "dsh-home");

function restoreEnvAndCleanup() {
  if (PREV_STATE_ENV === void 0) delete process.env.DSH_NOVEL_WRITER_STATE;
  else process.env.DSH_NOVEL_WRITER_STATE = PREV_STATE_ENV;
  if (PREV_HOME_ENV === void 0) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_HOME_ENV;
  try {
    rmSync(TMP_BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* 忽略清理错误 */
  }
}

process.on("exit", restoreEnvAndCleanup);
test.after(restoreEnvAndCleanup);

let NODE_VER;
let DB;
let CORE;
let EMBEDDING;
let VECTOR_AUDIT;
let DIAGNOSE;
let ANALYSIS;
let SYSTEM_TOOLS;
let WEB_UI;
let LOG;
let MANIFEST;

try {
  mkdirSync(DSH_HOME_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({
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
  }, null, 2), "utf8");

  process.env.DSH_NOVEL_WRITER_STATE = STATE_FILE;
  process.env.DSH_HOME = DSH_HOME_DIR;

  NODE_VER = await import("../lib/node-version.js");
  DB = await import("../lib/db.js");
  CORE = await import("../lib/core.js");
  EMBEDDING = await import("../lib/embedding.js");
  VECTOR_AUDIT = await import("../lib/vector-audit.js");
  DIAGNOSE = await import("../lib/diagnose.js");
  ANALYSIS = await import("../lib/analysis.js");
  SYSTEM_TOOLS = await import("../lib/tools/system.js");
  WEB_UI = await import("../lib/web-ui.js");
  LOG = await import("../lib/log.js");
  MANIFEST = await import("../lib/manifest.js");
} catch (err) {
  restoreEnvAndCleanup();
  throw err;
}

// ===========================================================================
// 通用测试辅助
// ===========================================================================

let libSeq = 0;
function freshLib(tag) {
  libSeq += 1;
  const root = join(TMP_BASE, `lib-${tag}-${libSeq}`);
  mkdirSync(join(root, "novels"), { recursive: true });
  return root;
}

function findRoute(routes, path) {
  const route = routes.find((r) => r && r.kind === "exact" && r.path === path);
  assert.ok(route, `应存在路由 ${path}`);
  return route;
}

function runProcess(args, { env = process.env, input = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      rejectRun(new Error(`子进程超时（${timeoutMs}ms）：${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (d) => stdoutChunks.push(d));
    child.stderr.on("data", (d) => stderrChunks.push(d));
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectRun(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8")
      });
    });

    if (input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

function deterministicVec(seedText, dim = 512) {
  const vec = new Float32Array(dim);
  let normSq = 0;
  for (let i = 0; i < dim; i += 1) {
    const h = createHash("sha1").update(`${seedText}|${i}`).digest();
    const val = ((h.readUInt32BE(0) % 2000) - 1000) / 1000;
    vec[i] = val;
    normSq += val * val;
  }
  const norm = Math.sqrt(normSq) || 1;
  for (let i = 0; i < dim; i += 1) vec[i] /= norm;
  return vec;
}

// ===========================================================================
// 1. lib/node-version.js 边界与 mcp/server.mjs <22.13 启动闸门
// ===========================================================================

test("1a. lib/node-version.js：版本解析与 >=22.13.0 边界判定", () => {
  assert.deepEqual(NODE_VER.parseNodeVersion("22.12.0"), { major: 22, minor: 12, patch: 0 });
  assert.deepEqual(NODE_VER.parseNodeVersion("v22.12.9"), { major: 22, minor: 12, patch: 9 });
  assert.deepEqual(NODE_VER.parseNodeVersion("22.13.0"), { major: 22, minor: 13, patch: 0 });
  assert.deepEqual(NODE_VER.parseNodeVersion("26.13.0-nightly.1"), { major: 26, minor: 13, patch: 0 });

  assert.equal(NODE_VER.isNodeVersionSupported("22.12.0"), false);
  assert.equal(NODE_VER.isNodeVersionSupported("v22.12.9"), false);
  assert.equal(NODE_VER.isNodeVersionSupported("20.18.0"), false);
  assert.equal(NODE_VER.isNodeVersionSupported("22.13.0"), true);
  assert.equal(NODE_VER.isNodeVersionSupported("22.14.0"), true);
  assert.equal(NODE_VER.isNodeVersionSupported("24.21.0"), true);
  assert.equal(NODE_VER.isNodeVersionSupported("26.13.0"), true);

  for (const bad of ["", "   ", "abc", "v", "22", "22.x.0", null, 123, {}]) {
    assert.equal(NODE_VER.parseNodeVersion(bad), null, `非法版本 ${JSON.stringify(bad)} 应解析为 null`);
    assert.equal(NODE_VER.isNodeVersionSupported(bad), false, `非法版本 ${JSON.stringify(bad)} 应判不支持`);
  }

  const errMsg = NODE_VER.formatNodeVersionError("22.12.0");
  assert.ok(errMsg.includes(">=22.13.0"), "错误诊断应含 >=22.13.0");
  assert.ok(errMsg.includes("node:sqlite"), "错误诊断应含 node:sqlite");
});

test("1b. mcp/server.mjs：伪造 Node 22.12.0 时走 stderr 报错退出且零 stdout 污染", async () => {
  const serverUrl = pathToFileURL(join(REPO, "mcp", "server.mjs")).href;
  const script = [
    `Object.defineProperty(process.versions, "node", { value: "22.12.0", configurable: true });`,
    `await import(${JSON.stringify(serverUrl)});`
  ].join(" ");
  const res = await runProcess(["--input-type=module", "-e", script], {
    env: {
      ...process.env,
      DSH_NOVEL_WRITER_STATE: STATE_FILE,
      DSH_HOME: DSH_HOME_DIR
    }
  });
  assert.notEqual(res.code, 0, "Node <22.13.0 时应以非 0 退出码退出");
  assert.equal(res.stdout, "", "版本门控拦截时绝不能污染 stdout");
  assert.ok(res.stderr.includes(">=22.13.0"), `stderr 应提示 >=22.13.0，实际：${res.stderr}`);
  assert.ok(res.stderr.includes("node:sqlite"), `stderr 应提及 node:sqlite，实际：${res.stderr}`);
});

test("1c. mcp/server.mjs：当前 Node (>=22.13) 正常初始化与 tools/list 完整注册", async () => {
  const root = freshLib("mcp-ok");
  const book = "MCP启停测试";
  mkdirSync(join(root, "novels", book), { recursive: true });
  writeFileSync(join(root, "novels", book, "第01章.md"), "夜风吹过长廊，灯火明灭不定。\n", "utf8");

  const child = spawn(process.execPath, [join(REPO, "mcp", "server.mjs"), "--root", root], {
    cwd: REPO,
    env: { ...process.env, DSH_NOVEL_WRITER_STATE: STATE_FILE, DSH_HOME: DSH_HOME_DIR },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const frames = [];
  const badLines = [];
  const stderrChunks = [];
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    try { frames.push(JSON.parse(line)); } catch { badLines.push(line); }
  });
  child.stderr.on("data", (d) => stderrChunks.push(String(d)));

  const exitPromise = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sqlite-test", version: "1.0.0" } }
  }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  child.stdin.end();

  const exitRes = await exitPromise;
  assert.equal(exitRes.code, 0, `MCP 服务器应正常退出，stderr=${stderrChunks.join("")}`);
  assert.deepEqual(badLines, [], "stdout 不得出现非 JSON 行");
  assert.equal(frames.length, 2);
  assert.equal(frames[0].id, 1);
  assert.equal(frames[0].result?.serverInfo?.name, "dsh-novel-writer");
  assert.equal(frames[1].id, 2);
  assert.equal(frames[1].result?.tools?.length, MANIFEST.ALL_TOOLS.length);
});

// ===========================================================================
// 2. SQLite WAL、schema 与严格 readOnly 守卫
// ===========================================================================

test("2. SQLite WAL、schemaVersion === 1 与冷启动严格 readOnly 不建库", async () => {
  const root = freshLib("readonly-wal");
  const book = "冷启不建库";
  mkdirSync(join(root, "novels", book), { recursive: true });
  writeFileSync(
    join(root, "novels", book, "第01章.md"),
    "清晨的风吹开窗帘，桌上放着半杯凉透的茶与一本折角的笔记本，字迹工整却略显仓促。\n",
    "utf8"
  );

  const dbPath = DB.libraryDbPath(root);
  assert.equal(existsSync(dbPath), false);

  // 所有只读 API 与 HTTP 路由均绝不创建 cache.sqlite 或 .novel-writer/
  const chMetrics = DB.readChapterMetrics(root, book);
  assert.equal(chMetrics.rows.length, 0);
  assert.equal(chMetrics.byChapter.size, 0);
  assert.equal(DB.readAnalysisCache(root, `book_full:${book}`), null);
  assert.equal(DB.readEmbeddingIndex(root, book), null);
  assert.equal(DB.readAuditVectors(root, ["k1"], EMBEDDING.MODEL_NAME, 512).size, 0);
  assert.equal(DB.inspectLibraryDb(root).exists, false);
  assert.equal(DB.inspectCaliberCache(root, ANALYSIS.METRIC_CALIBER).exists, false);
  assert.deepEqual(DB.purgeBookCache(root, book), { existed: false, deleted: 0 });

  const routes = SYSTEM_TOOLS.buildUiRoutes({ root });
  const baselineRoute = findRoute(routes, "/api/dsh-novel-writer/baseline");
  const caliberRoute = findRoute(routes, "/api/dsh-novel-writer/metric-caliber");

  const baseRes = await WEB_UI.invokeRouteInMemory(baselineRoute, {
    method: "GET",
    url: `${baselineRoute.path}?book=${encodeURIComponent(book)}`
  });
  assert.equal(baseRes.status, 200);
  assert.equal(baseRes.json?.ok, true);

  const calRes = await WEB_UI.invokeRouteInMemory(caliberRoute, { method: "GET" });
  assert.equal(calRes.status, 200);
  assert.equal(calRes.json?.ok, true);
  assert.equal(calRes.json?.sqlite?.exists, false);

  assert.equal(existsSync(dbPath), false, "只读探测与只读路由后绝不能创建 cache.sqlite");
  assert.equal(existsSync(join(root, ".novel-writer")), false, "只读操作后绝不能创建 .novel-writer 目录");

  // 首次写入启用 WAL 与 schema_version = 1
  const w = DB.writeChapterMetrics(root, book, [{
    chapter: "第01章.md",
    content_hash: "abc123",
    size: 42,
    caliber: ANALYSIS.METRIC_CALIBER,
    metrics_json: { complexity: 1.5 }
  }]);
  assert.equal(w.written, 1);
  assert.equal(existsSync(dbPath), true);

  const info = DB.inspectLibraryDb(root);
  assert.equal(info.exists, true);
  assert.equal(info.journalMode, "wal");
  assert.equal(info.schemaVersion, 1);
  assert.equal(info.schemaVersion, DB.LIBRARY_DB_SCHEMA_VERSION);
  assert.equal(info.counts.chapterMetrics, 1);
});

// ===========================================================================
// 3. Float32 BLOB 对齐（byteOffset % 4 !== 0）与 128/512 维往返
// ===========================================================================

test("3. Float32 BLOB 非对齐视图解码与 128/512 维编码往返", () => {
  const sample = [1.5, -2.25, 0.125, 42.75];
  const srcF32 = Float32Array.from(sample);
  const raw = new Uint8Array(17);
  raw.set(new Uint8Array(srcF32.buffer, srcF32.byteOffset, srcF32.byteLength), 1);
  const unaligned = raw.subarray(1, 17);
  assert.equal(unaligned.byteOffset, 1);
  assert.notEqual(unaligned.byteOffset % 4, 0);

  const decoded = DB.decodeFloat32Blob(unaligned, 4);
  assert.ok(decoded instanceof Float32Array);
  assert.equal(decoded.length, 4);
  assert.deepEqual(Array.from(decoded), sample);

  // 128 维与 512 维往返（Float32Array 与 number[]）
  for (const dim of [128, 512]) {
    const arr = Array.from({ length: dim }, (_, i) => Math.fround(Math.sin(i * 0.13) * 0.75));
    const blobFromArr = DB.encodeFloat32Blob(arr);
    assert.ok(blobFromArr instanceof Uint8Array);
    assert.equal(blobFromArr.byteLength, dim * 4);
    const out1 = DB.decodeFloat32Blob(blobFromArr, dim);
    assert.ok(out1 instanceof Float32Array);
    assert.equal(out1.length, dim);
    for (let i = 0; i < dim; i += 1) assert.equal(out1[i], arr[i]);

    const blobFromF32 = DB.encodeFloat32Blob(Float32Array.from(arr));
    const out2 = DB.decodeFloat32Blob(blobFromF32, dim);
    assert.deepEqual(Array.from(out2), arr);
    assert.equal(DB.decodeFloat32Blob(blobFromF32, dim + 1), null, "维度不匹配应返回 null");
  }

  assert.equal(DB.decodeFloat32Blob(new Uint8Array(5)), null, "字节长非 4 倍数应返回 null");
});

// ===========================================================================
// 4. 损坏自愈：只读不改盘 + 可写重建并记脱敏 sqlite_recover 日志
// ===========================================================================

test("4. 损坏自愈：只读读坏库返回 null 且原样保留；写入重建并记录 sqlite_recover", async () => {
  const root = freshLib("corrupt-recover");
  const book = "自愈测试书";
  mkdirSync(join(root, "novels", book), { recursive: true });
  const c1 = "第01章.md";
  const c2 = "第02章.md";
  const CANARY = "绝密损坏自愈金丝雀_CORRUPT_CANARY_8899";
  const t1 = `# 第一章\n\n他推开铁门，屋里点着半截蜡烛，桌上有本泛黄账册与一把铜锁。${CANARY}。\n`;
  const t2 = "# 第二章\n\n雨声顺着屋檐滴落，石阶上积起一洼浅水，他收起钥匙转身走下木梯，推开后院木门望向街口。\n";
  writeFileSync(join(root, "novels", book, c1), t1, "utf8");
  writeFileSync(join(root, "novels", book, c2), t2, "utf8");

  const dbPath = DB.libraryDbPath(root);
  mkdirSync(dirname(dbPath), { recursive: true });
  const garbageMain = Buffer.from("CORRUPT_SQLITE_HEADER_GARBAGE_0123456789_NOTADB");
  const garbageWal = Buffer.from("CORRUPT_WAL_GARBAGE_ABCDEF");
  writeFileSync(dbPath, garbageMain);
  writeFileSync(dbPath + "-wal", garbageWal);

  // 只读模式：返回 null/空，绝不修改坏文件
  assert.equal(DB.withLibraryDb(root, () => "unexpected", { readOnly: true }), null);
  const roMetrics = DB.readChapterMetrics(root, book, { readOnly: true });
  assert.equal(roMetrics.rows.length, 0);
  assert.equal(Buffer.compare(readFileSync(dbPath), garbageMain), 0, "只读读取不得改写损坏的 cache.sqlite");
  assert.equal(Buffer.compare(readFileSync(dbPath + "-wal"), garbageWal), 0, "只读读取不得改写损坏的 -wal");

  await LOG.clearLogs();

  // 可写路径：自动清理重建并重新测量写入
  const per = await CORE.metricChaptersCached(root, book, [
    { file: c1, text: t1 },
    { file: c2, text: t2 }
  ]);
  assert.equal(per.length, 2);

  const info = DB.inspectLibraryDb(root);
  assert.equal(info.exists, true);
  assert.equal(info.journalMode, "wal");
  assert.equal(info.schemaVersion, 1);
  assert.equal(info.counts.chapterMetrics, 2);

  const cacheEvents = await LOG.readLogEvents({ kind: "cache", forShare: false, limit: 50 });
  const recoverEv = cacheEvents.find((ev) => ev.action === "sqlite_recover" || String(ev.detail || "").includes("sqlite_recover"));
  assert.ok(recoverEv, "重建后应在 events.jsonl 中留下 sqlite_recover 日志");
  const rawLogText = existsSync(LOG.logFilePath()) ? readFileSync(LOG.logFilePath(), "utf8") : "";
  assert.equal(rawLogText.includes(CANARY), false, "事件日志不得泄漏任何章节正文金丝雀");
});

// ===========================================================================
// 5. 大书增量加速（205 章仅改 1 章）+ readSceneBaselinesSafe 只读读取
// ===========================================================================

test("5. 大书（205 章）单章编辑增量重算：204 章保留 updated_at，仅 1 章刷新且只读基线命中", async () => {
  const root = freshLib("large-205");
  const book = "两百零五章大书";
  const bDir = join(root, "novels", book);
  mkdirSync(bDir, { recursive: true });

  const chapters = [];
  for (let i = 1; i <= 205; i += 1) {
    const num = String(i).padStart(3, "0");
    const file = `chapter-${num}.md`;
    const body = i % 2 === 0
      ? `# 第${i}章 长廊交锋\n\n他拔出长剑劈向门栓，木屑飞溅而出，走廊尽头的石碑应声裂开一道深缝。第${i}节风声骤紧，众人急忙后撤。\n`
      : `# 第${i}章 茶室叙旧\n\n“今日风平浪静，你先喝口热茶再慢慢讲明缘由。”老掌柜微笑点头，将第${i}本账册轻轻推过木桌。\n`;
    writeFileSync(join(bDir, file), body, "utf8");
    chapters.push({ file, text: body });
  }

  // 预热 SQLite 缓存
  const warm = await CORE.metricChaptersCached(root, book, chapters);
  assert.equal(warm.length, 205);

  const before = DB.readChapterMetrics(root, book, { readOnly: true });
  assert.equal(before.rows.length, 205);

  // 确保时间戳严格前进
  await new Promise((resolveWait) => setTimeout(resolveWait, 25));

  // 仅修改 chapter-100.md
  const editedFile = "chapter-100.md";
  const editedText = "# 第100章 异变突生\n\n“快看窗外！”他猛然跃起抓住铜铃，重重敲响三下，石门在轰鸣声中缓缓开启，寒风灌满整座大厅。\n";
  writeFileSync(join(bDir, editedFile), editedText, "utf8");
  const updatedChapters = chapters.map((c) => (c.file === editedFile ? { file: c.file, text: editedText } : c));

  const t0 = performance.now();
  const res2 = await CORE.metricChaptersCached(root, book, updatedChapters);
  const elapsedMs = performance.now() - t0;
  console.log(`   [205章增量重算] 单章修改耗时: ${elapsedMs.toFixed(2)} ms`);
  assert.equal(res2.length, 205);
  assert.ok(elapsedMs < 1000, `205 章仅改 1 章增量重算应在 1000ms 内完成（实际 ${elapsedMs.toFixed(2)}ms）`);

  const after = DB.readChapterMetrics(root, book, { readOnly: true });
  assert.equal(after.rows.length, 205);

  let unchangedPreserved = 0;
  let editedUpdated = 0;
  for (const rowAfter of after.rows) {
    const rowBefore = before.byChapter.get(rowAfter.chapter);
    assert.ok(rowBefore, `应存在旧行 ${rowAfter.chapter}`);
    if (rowAfter.chapter === editedFile) {
      assert.notEqual(rowAfter.content_hash, rowBefore.content_hash, "被修改章节的 content_hash 必须更新");
      assert.ok(rowAfter.updated_at > rowBefore.updated_at, "被修改章节的 updated_at 必须推进");
      editedUpdated += 1;
    } else {
      assert.equal(rowAfter.content_hash, rowBefore.content_hash);
      assert.equal(rowAfter.updated_at, rowBefore.updated_at, `未修改章节 ${rowAfter.chapter} 必须保留原 updated_at`);
      unchangedPreserved += 1;
    }
  }
  assert.equal(unchangedPreserved, 204);
  assert.equal(editedUpdated, 1);

  // readSceneBaselinesSafe（经 GET /api/dsh-novel-writer/baseline）只读返回 205 章基线
  const routes = SYSTEM_TOOLS.buildUiRoutes({ root });
  const baselineRoute = findRoute(routes, "/api/dsh-novel-writer/baseline");
  const baseRes = await WEB_UI.invokeRouteInMemory(baselineRoute, {
    method: "GET",
    url: `${baselineRoute.path}?book=${encodeURIComponent(book)}`
  });
  assert.equal(baseRes.status, 200);
  assert.equal(baseRes.json?.ok, true);
  assert.equal(baseRes.json?.sceneBaselines?.totalChapters, 205);
  assert.equal(baseRes.json?.sceneBaselines?.measuredChapters, 205);
  assert.equal(baseRes.json?.sceneBaselines?.fromCache, true);
  assert.notEqual(baseRes.json?.sceneBaselines?.uncachedLargeBook, true);

  const afterBaseline = DB.readChapterMetrics(root, book, { readOnly: true });
  assert.equal(afterBaseline.byChapter.get(editedFile).updated_at, after.byChapter.get(editedFile).updated_at, "只读 baseline 路由不应改写数据库");
});

// ===========================================================================
// 6. embedding.js 128 维 BLOB + vector-audit.js 跨会话持久化 LRU
// ===========================================================================

test("6a. embedding.js：128 维 Float32 BLOB 落库、evict 内存读缓存后精确重载", () => {
  const root = freshLib("embedding-blob");
  const book = "嵌入索引书";
  const longText = "海港夜雾浓重，渔船停靠在旧木栈桥旁，灯塔旋转的光束扫过石堤。".repeat(8);
  const index = [
    { id: "ch1#0", chapter: "第01章.md", offset: 120, text: "第一段短文本测试：雨夜里的石桥与铜灯。", vec: deterministicVec("c0", 128) },
    { id: "ch1#1", chapter: "第01章.md", offset: 480, text: longText, vec: deterministicVec("c1", 128) }
  ];

  assert.equal(EMBEDDING.saveIndex(root, book, index), true);

  // 保存并读取另一本书，驱逐 embedding.js 的单槽进程内 indexReadCache，强迫重新从 cache.sqlite 读取
  const dummyBook = "缓存驱逐占位书";
  assert.equal(EMBEDDING.saveIndex(root, dummyBook, [
    { id: "d#0", chapter: "第01章.md", offset: 0, text: "占位段落用于驱逐单槽读缓存。", vec: deterministicVec("dummy", 128) }
  ]), true);
  const dummyMeta = EMBEDDING.loadIndexMeta(root, dummyBook);
  assert.equal(dummyMeta.items?.length, 1);

  const reloaded = EMBEDDING.loadIndexMeta(root, book);
  assert.ok(reloaded.items && reloaded.items.length === 2);
  assert.equal(reloaded.fp, EMBEDDING.fingerprint(index));

  const rawIdx = DB.readEmbeddingIndex(root, book, { readOnly: true });
  assert.ok(rawIdx);
  assert.equal(rawIdx.meta.dim, 128);
  assert.equal(rawIdx.meta.chunk_count, 2);
  assert.equal(rawIdx.chunks[0].offset, 120);
  assert.equal(rawIdx.chunks[1].offset, 480);
  assert.equal(rawIdx.chunks[0].chapter, "第01章.md");

  for (let i = 0; i < index.length; i += 1) {
    assert.ok(reloaded.items[i].vec instanceof Float32Array);
    assert.equal(reloaded.items[i].vec.length, 128);
    assert.equal(reloaded.items[i].id, index[i].id);
    assert.equal(reloaded.items[i].text, index[i].text.slice(0, 200));
    assert.equal(reloaded.items[i].chapter, index[i].chapter);
    assert.ok(EMBEDDING.cosine(reloaded.items[i].vec, index[i].vec) > 0.99999, "重载向量必须与原始 128 维向量一致");
  }
});

test("6b. vector-audit.js：清空内存 LRU 后由 SQLite audit_vectors 零重算命中 + LRU 淘汰", async () => {
  const root = freshLib("vector-audit-lru");
  VECTOR_AUDIT.__clearVectorCache();

  // 构造 >= 6 块、>= 200 字的正文，使 detectSemanticLoop 与 checkOutlineFulfillment 均执行嵌入
  const para = (n) => `第${n}幕海风沿着礁石长堤吹拂，灯塔守卫擦净玻璃罩并记下潮汐刻度与航标灯火颜色变化。`;
  const chapterText = [para(1), para(2), para(3), para(4), para(5), para(6), para(7)].join("\n\n");
  const direction = "主角潜入地窖破译密信并取走铜钥匙";

  let mockCalls = 0;
  const mockEmbed = async (text) => {
    mockCalls += 1;
    return deterministicVec(text, 512);
  };

  const loop1 = await VECTOR_AUDIT.detectSemanticLoop(chapterText, {
    root,
    isAvailable: async () => true,
    embed: mockEmbed
  });
  assert.equal(loop1.checked, true);
  assert.ok(loop1.blocks >= 6);
  const callsAfterLoop = mockCalls;
  assert.ok(callsAfterLoop >= 6, "首次冷启动应调用 mockEmbed 计算段落向量");

  const outline1 = await VECTOR_AUDIT.checkOutlineFulfillment(direction, chapterText, {
    root,
    isAvailable: async () => true,
    embed: mockEmbed
  });
  assert.equal(outline1.checked, true);
  assert.ok(mockCalls > callsAfterLoop, "首次核对大纲子句应调用 mockEmbed 计算查询向量");

  const dbAfterWarm = DB.inspectLibraryDb(root);
  assert.ok(dbAfterWarm.counts.auditVectors >= 7, `audit_vectors 应落盘持久化（实际 ${dbAfterWarm.counts.auditVectors}）`);

  // 彻底清空进程内 vecCache，再用抛错 spyEmbed 验证 100% 走 SQLite 持久化缓存
  VECTOR_AUDIT.__clearVectorCache();
  let spyCalls = 0;
  const spyEmbed = async () => {
    spyCalls += 1;
    throw new Error("SHOULD_NOT_RECOMPUTE_ON_SQLITE_CACHE_HIT");
  };

  const loop2 = await VECTOR_AUDIT.detectSemanticLoop(chapterText, {
    root,
    isAvailable: async () => true,
    embed: spyEmbed
  });
  const outline2 = await VECTOR_AUDIT.checkOutlineFulfillment(direction, chapterText, {
    root,
    isAvailable: async () => true,
    embed: spyEmbed
  });

  assert.equal(spyCalls, 0, "清空内存缓存后，SQLite audit_vectors 应命中并实现零重算");
  assert.deepEqual(loop2, loop1);
  assert.deepEqual(outline2, outline1);

  // 验证 writeAuditVectors / readAuditVectors 的 LRU 淘汰逻辑
  const lruRoot = freshLib("audit-lru-prune");
  const v1 = deterministicVec("lru-1", 512);
  const v2 = deterministicVec("lru-2", 512);
  const v3 = deterministicVec("lru-3", 512);
  const v4 = deterministicVec("lru-4", 512);
  DB.writeAuditVectors(lruRoot, [
    { vec_key: "k1", model: EMBEDDING.MODEL_NAME, dim: 512, vec: v1, last_used: 100 },
    { vec_key: "k2", model: EMBEDDING.MODEL_NAME, dim: 512, vec: v2, last_used: 200 },
    { vec_key: "k3", model: EMBEDDING.MODEL_NAME, dim: 512, vec: v3, last_used: 300 }
  ], 10);

  // 触碰 k1 使其成为最近使用（不再是最旧）
  const touched = DB.readAuditVectors(lruRoot, ["k1"], EMBEDDING.MODEL_NAME, 512);
  assert.equal(touched.has("k1"), true);

  // 插入 k4 并设 maxRows = 3，应淘汰未触碰且最旧的 k2
  const prunedRes = DB.writeAuditVectors(lruRoot, [
    { vec_key: "k4", model: EMBEDDING.MODEL_NAME, dim: 512, vec: v4, last_used: Date.now() + 1000 }
  ], 3);
  assert.equal(prunedRes.pruned, 1);

  const left = DB.readAuditVectors(lruRoot, ["k1", "k2", "k3", "k4"], EMBEDDING.MODEL_NAME, 512, { readOnly: true });
  assert.equal(left.has("k1"), true, "近期命中过的 k1 不应被淘汰");
  assert.equal(left.has("k2"), false, "最久未用的 k2 应被 LRU 淘汰");
  assert.equal(left.has("k3"), true);
  assert.equal(left.has("k4"), true);
});

// ===========================================================================
// 7. metric-caliber 过期检测/选择性重建 + diagnose.js 元数据隐私校验
// ===========================================================================

test("7. metric-caliber 过期检测与选择性重建 + buildDiagnosis sqliteCache 元数据零金丝雀泄露", async () => {
  const root = freshLib("caliber-diagnose");
  const book = "口径核查书";
  const CANARY_PROSE = "绝密金丝雀正文片段_SQLITE_DIAGNOSE_XYZ987";
  const CANARY_DB_BOOK = "绝密库内书名_SQLITE_CANARY_BOOK";
  const CANARY_DB_CHAPTER = "绝密库内章名_SQLITE_CANARY_CHAP.md";

  mkdirSync(join(root, "novels", book), { recursive: true });
  writeFileSync(
    join(root, "novels", book, "第01章.md"),
    `# 第一章\n\n灯火摇曳，木桌旁有人低声交谈。${CANARY_PROSE}，随后一切归于寂静。\n`,
    "utf8"
  );

  // 种子：1 条过期 chapter_metrics + 1 条当前口径 chapter_metrics + 1 条过期 analysis_cache + 1 条当前口径 analysis_cache
  DB.writeChapterMetrics(root, CANARY_DB_BOOK, [{
    chapter: CANARY_DB_CHAPTER,
    content_hash: "stale-hash",
    size: 80,
    caliber: "v0-stale-caliber",
    metrics_json: { complexity: 1.0, canary: CANARY_PROSE }
  }]);
  DB.writeChapterMetrics(root, book, [{
    chapter: "第01章.md",
    content_hash: "curr-hash",
    size: 80,
    caliber: ANALYSIS.METRIC_CALIBER,
    metrics_json: { complexity: 1.5 }
  }]);
  DB.writeAnalysisCache(root, {
    cache_key: `book_full:${CANARY_DB_BOOK}`,
    kind: "book_full",
    book: CANARY_DB_BOOK,
    fingerprint: "fp-stale",
    caliber: "v0-stale-caliber",
    payload: { ver: "0.0.1", note: CANARY_PROSE }
  });
  DB.writeAnalysisCache(root, {
    cache_key: `book_full:${book}`,
    kind: "book_full",
    book,
    fingerprint: "fp-curr",
    caliber: ANALYSIS.METRIC_CALIBER,
    payload: { ver: CORE.CACHE_VERSION }
  });

  // 同时写入 embedding_meta / embedding_chunks / audit_vectors（重建口径时不得误删）
  DB.writeEmbeddingIndex(
    root,
    CANARY_DB_BOOK,
    { model: EMBEDDING.MODEL_NAME, dim: 128, fingerprint: "emb-fp" },
    [{ chunk_idx: 0, chapter: CANARY_DB_CHAPTER, offset: 0, text_hash: JSON.stringify(["h", "id", CANARY_PROSE]), vec: deterministicVec("emb", 128) }]
  );
  DB.writeAuditVectors(root, [{
    vec_key: "audit-canary-key",
    model: EMBEDDING.MODEL_NAME,
    dim: 512,
    vec: deterministicVec("aud", 512)
  }]);

  const routes = SYSTEM_TOOLS.buildUiRoutes({ root });
  const caliberRoute = findRoute(routes, "/api/dsh-novel-writer/metric-caliber");

  const getRes = await WEB_UI.invokeRouteInMemory(caliberRoute, { method: "GET" });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.json?.ok, true);
  assert.equal(getRes.json?.stale, 2);
  assert.equal(getRes.json?.sqlite?.stale, 2);
  assert.equal(getRes.json?.sqlite?.chapterMetrics?.total, 2);
  assert.equal(getRes.json?.sqlite?.analysisCache?.total, 2);

  const postRes = await WEB_UI.invokeRouteInMemory(caliberRoute, {
    method: "POST",
    body: { action: "rebuild" }
  });
  assert.equal(postRes.status, 200);
  assert.equal(postRes.json?.ok, true);
  assert.equal(postRes.json?.deleted, 2);
  assert.equal(postRes.json?.stale, 0);
  assert.equal(postRes.json?.sqlite?.deleted, 2);
  assert.equal(postRes.json?.sqlite?.stale, 0);

  const dbAfterRebuild = DB.inspectLibraryDb(root);
  assert.equal(dbAfterRebuild.counts.chapterMetrics, 1, "只应清掉过期口径的 chapter_metrics，保留当前口径行");
  assert.equal(dbAfterRebuild.counts.analysisCache, 1, "只应清掉过期口径的 analysis_cache，保留当前口径行");
  assert.equal(dbAfterRebuild.counts.embeddingBooks, 1, "embedding_meta 绝不能被口径重建误删");
  assert.equal(dbAfterRebuild.counts.embeddingChunks, 1, "embedding_chunks 绝不能被口径重建误删");
  assert.equal(dbAfterRebuild.counts.auditVectors, 1, "audit_vectors 绝不能被口径重建误删");

  // 归零的 SQLite WAL/SHM 附属文件不应被误报成写入中断的 0 字节损坏文件，报告纯文本亦不得残留 **
  writeFileSync(join(root, ".novel-writer", "cache.sqlite-wal"), "");
  writeFileSync(join(root, ".novel-writer", "cache.sqlite-shm"), "");

  // 验证 buildDiagnosis 含 dataDir.sqliteCache 计数与字节数，且零金丝雀泄露
  const diag = await DIAGNOSE.buildDiagnosis({ root }, { days: 7, action: "report" }, null);
  const formatted = DIAGNOSE.formatDiagnosis(diag);
  assert.equal(diag.dataDir?.emptyTotal, 0, "0 字节 cache.sqlite-wal / cache.sqlite-shm 不得被误报为 emptyTotal");
  assert.equal(formatted.includes("**"), false, "formatDiagnosis 输出纯文本不得包含字面量 **");
  const sc = diag.dataDir?.sqliteCache;
  assert.ok(sc && sc.exists === true, "buildDiagnosis 应包含 dataDir.sqliteCache");
  assert.ok(Number.isFinite(sc.sizeBytes) && sc.sizeBytes > 0, "sqliteCache.sizeBytes 应 > 0");
  assert.equal(sc.schemaVersion, 1);
  assert.equal(sc.journalMode, "wal");
  assert.deepEqual(sc.counts, {
    chapterMetrics: 1,
    analysisCache: 1,
    embeddingBooks: 1,
    embeddingChunks: 1,
    auditVectors: 1
  });
  assert.ok(formatted.includes("SQLite 缓存：cache.sqlite"), "formatDiagnosis 应渲染 SQLite 缓存摘要行");

  const serializedDiag = JSON.stringify(diag);
  assert.equal(serializedDiag.includes(CANARY_PROSE), false, "诊断结构不得泄露正文金丝雀");
  assert.equal(formatted.includes(CANARY_PROSE), false, "诊断报告不得泄露正文金丝雀");
  assert.equal(serializedDiag.includes(CANARY_DB_BOOK), false, "诊断结构不得泄露 SQLite 库内书名金丝雀");
  assert.equal(serializedDiag.includes(CANARY_DB_CHAPTER), false, "诊断结构不得泄露 SQLite 库内章名金丝雀");

  const sqliteMetaText = JSON.stringify(sc) + "\n" + JSON.stringify(DB.inspectCaliberCache(root, ANALYSIS.METRIC_CALIBER));
  for (const secret of [CANARY_PROSE, CANARY_DB_BOOK, CANARY_DB_CHAPTER, book, "第01章.md"]) {
    assert.equal(sqliteMetaText.includes(secret), false, `SQLite 元数据检查不得泄露 ${secret}`);
  }
});

// ===========================================================================
// 8. 真实双进程并发 withFileTx（40 次累加）+ 陈旧锁恢复
// ===========================================================================

test("8. withFileTx：真实双进程并发 20×2=40 次累加无丢更新 + 陈旧锁 (>30s) 自动恢复", async () => {
  const root = freshLib("file-tx-2proc");
  const targetJson = join(root, "counter.json");
  writeFileSync(targetJson, JSON.stringify({ count: 0 }), "utf8");

  const stateModuleUrl = pathToFileURL(join(REPO, "lib", "core", "state.js")).href;
  const workerCode = [
    `import { readFile } from "node:fs/promises";`,
    `const { withFileTx, atomicWriteJson } = await import(${JSON.stringify(stateModuleUrl)});`,
    `const file = process.env.TX_TARGET;`,
    `for (let i = 0; i < 20; i += 1) {`,
    `  await withFileTx(file, async () => {`,
    `    const cur = JSON.parse(await readFile(file, "utf8"));`,
    `    cur.count += 1;`,
    `    await atomicWriteJson(file, cur);`,
    `  });`,
    `}`
  ].join("\n");

  const envA = { ...process.env, TX_TARGET: targetJson, DSH_NOVEL_WRITER_STATE: STATE_FILE, DSH_HOME: DSH_HOME_DIR };
  const envB = { ...process.env, TX_TARGET: targetJson, DSH_NOVEL_WRITER_STATE: STATE_FILE, DSH_HOME: DSH_HOME_DIR };

  const [resA, resB] = await Promise.all([
    runProcess(["--input-type=module", "-e", workerCode], { env: envA, timeoutMs: 30000 }),
    runProcess(["--input-type=module", "-e", workerCode], { env: envB, timeoutMs: 30000 })
  ]);

  assert.equal(resA.code, 0, `子进程 A 失败：${resA.stderr}`);
  assert.equal(resB.code, 0, `子进程 B 失败：${resB.stderr}`);

  const finalObj = JSON.parse(readFileSync(targetJson, "utf8"));
  assert.equal(finalObj.count, 40, `双进程各累加 20 次后 count 必须严格等于 40，实际=${finalObj.count}`);
  assert.equal(existsSync(targetJson + ".lock"), false, "事务完成后不得残留 .lock 文件");

  // 陈旧锁（> 30_000 ms）恢复验证
  const staleJson = join(root, "stale-lock-target.json");
  writeFileSync(staleJson, JSON.stringify({ recovered: false }), "utf8");
  writeFileSync(staleJson + ".lock", JSON.stringify({
    pid: 999999,
    ts: Date.now() - CORE.LOCK_STALE_MS - 2000
  }), "utf8");

  const t0 = performance.now();
  await CORE.withFileTx(staleJson, async () => {
    const cur = JSON.parse(readFileSync(staleJson, "utf8"));
    cur.recovered = true;
    await CORE.atomicWriteJson(staleJson, cur);
  });
  const elapsed = performance.now() - t0;

  assert.ok(elapsed < 2000, `陈旧锁应立即恢复，不应等待 5000ms 超时（实际 ${elapsed.toFixed(2)}ms）`);
  assert.equal(JSON.parse(readFileSync(staleJson, "utf8")).recovered, true);
  assert.equal(existsSync(staleJson + ".lock"), false, "陈旧锁恢复并释放后不得残留 .lock 文件");
});

// ===========================================================================
// 9. 隔离守卫
// ===========================================================================

test("9. 隔离守卫：用户真实 ~/.dsh/dsh-novel-writer/ 目录全程未被修改", () => {
  const realAfter = digestTree(REAL_DSH_DIR);
  assert.deepEqual(realAfter, realBefore, "测试全程绝不能改动用户真实 ~/.dsh/dsh-novel-writer/ 目录");
});
