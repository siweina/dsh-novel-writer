import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  auditLexicon,
  bookNameFromFileName,
  buildStyleAnchorPackage,
  cjkToNumber,
  createOutlineTool,
  decodeTextBuffer,
  detectChapterBridge,
  enrichSemanticImplicit,
  extractKeywords,
  findChapter,
  formatImport,
  internalRoot,
  isAbort,
  lexiconFile,
  nextFreeChapterFile,
  normalizeChapterKey,
  listBookNames,
  looksLikeLibraryRoot,
  normalizeLexiconEntry,
  novelsDir,
  noteRoot,
  OUTLINE_LINE_RE,
  parseChapterNumber,
  resolveStyleRule,
  sanitizeSegment,
  parseLexiconLine,
  readBaselineScope,
  readLexiconFile,
  readSentenceState,
  readSettings,
  resolveRoot,
  resolveUiRoot,
  resolveUiRootInfo,
  writeLexicon
} from "../lib/core.js";
import { measureStyleMetrics } from "../lib/style-metrics.js";
import { readLogEvents } from "../lib/log.js";
import * as embedding from "../lib/embedding.js";
import { apply } from "../lib/index.js";
import { buildChapterBrief } from "../lib/brief.js";
import { buildFixPlan, verifyFixPlan } from "../lib/fixplan.js";
import { buildStoryGraph } from "../lib/graph.js";

// v6.2.1：词表路由用例要在真实申请的路由上跑（core.js 只把 handler 交给宿主 webServer），
// 故这里与 e2e/lexicon 测试同口径地走一次 apply（状态文件指向临时目录，不碰真实 ~/.dsh）。
const routeTestRoot = await mkdtemp(join(tmpdir(), "dsh-core-route-"));
process.env.DSH_NOVEL_WRITER_STATE = join(routeTestRoot, "state-test.json");
const routeRegistry = [];
const routeList = [];
const routeCtx = {
  tools: { register: (d) => { routeRegistry.push(d); return () => {}; } },
  systemPrompt: { section: () => () => {} },
  inject: (names, cb) => cb({ webServer: { register: (r) => { routeList.push(r); return () => {}; } }, effect: (fn) => fn() })
};
apply(routeCtx, { root: routeTestRoot, sentenceAnalysis: { enabled: true, autoAnalyze: true } });
await mkdir(join(routeTestRoot, "novels", "测试书"), { recursive: true });
await writeFile(join(routeTestRoot, "novels", "测试书", "第01章.md"), "他抬头看星轨。\n", "utf8");
const routeDefs = Object.fromEntries(routeRegistry.map((d) => [d.name, d]));
const lexiconRoute = routeList.find((r) => r.path === "/api/dsh-novel-writer/lexicon").handler;
const routeExec = { agent: { session: { header: { cwd: routeTestRoot } } } };

function fakeRes() {
  return { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = String(b); } };
}
function bodyReq(method, url, payload) {
  const chunks = [Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload))];
  let i = 0;
  return {
    method,
    url,
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" },
    [Symbol.asyncIterator]: () => ({ next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) })
  };
}
function plainReq(method, url) {
  return {
    method,
    url,
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" },
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) })
  };
}

async function withBook(run) {
  const root = await mkdtemp(join(tmpdir(), "dsh-core-regression-"));
  const book = "测试书";
  const chapterDir = join(root, "novels", book);
  await mkdir(chapterDir, { recursive: true });
  try {
    await run({ root, book, chapterDir, dataDir: join(root, ".novel-writer") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSettings(root, book, data) {
  const dir = join(root, ".novel-writer", "settings");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, book + ".json"), JSON.stringify(data), "utf8");
}

test("complete chapter filenames win and ambiguous stems fail", () => {
  const chapters = [
    { file: "第01章.md", number: 1, title: "" },
    { file: "第01章.txt", number: 1, title: "" }
  ];
  assert.equal(findChapter(chapters, "第01章.txt"), chapters[1]);
  assert.equal(findChapter(chapters, "第01章.md"), chapters[0]);
  assert.throws(() => findChapter(chapters, "第01章"), /第01章\.md.*第01章\.txt/);
  assert.equal(findChapter(chapters, "第01章.markdown"), undefined);
});

test("verify compares all findings, including those beyond the display limit", async () => {
  await withBook(async ({ root, book, chapterDir }) => {
    const file = join(chapterDir, "第01章.md");
    const addedWords = Array.from({ length: 12 }, (_, i) => "NEWTOKEN" + i);
    await writeSettings(root, book, { worldview: [{ name: "规范", bannedWords: [...addedWords, "OLDTOKEN"] }] });
    await writeFile(file, "前文。\n\n继续。\n\nOLDTOKEN 仍在这一章。", "utf8");
    const first = await buildFixPlan(root, book, "第01章.md", {});
    assert.equal(first.items.length, 1);
    await writeFile(file, addedWords.join(" ") + "\n\n继续。\n\nOLDTOKEN 仍在这一章。", "utf8");
    const result = await verifyFixPlan(root, book, "第01章.md", {});
    assert.equal(result.checked.find((item) => item.id === first.items[0].id)?.status, "pending");
    assert.equal(result.checked.filter((item) => item.status === "new").length, 12);
  });
});

test("verify does not pair different banned words by type", async () => {
  await withBook(async ({ root, book, chapterDir }) => {
    const file = join(chapterDir, "第01章.md");
    await writeSettings(root, book, { worldview: [{ name: "规范", bannedWords: ["OLDTOKEN", "NEWTOKEN"] }] });
    await writeFile(file, "OLDTOKEN 在正文中。", "utf8");
    const first = await buildFixPlan(root, book, "第01章.md", {});
    await writeFile(file, "NEWTOKEN 在正文中。", "utf8");
    const result = await verifyFixPlan(root, book, "第01章.md", {});
    assert.equal(result.checked.find((item) => item.id === first.items[0].id)?.status, "resolved");
    assert.equal(result.checked.filter((item) => item.status === "new").length, 1);
  });
});

test("brief does not treat a relative's death as the character's death", async () => {
  await withBook(async ({ root, book, chapterDir }) => {
    await writeFile(join(chapterDir, "第01章.md"), "张三正在调查父亲死亡真相。", "utf8");
    await writeSettings(root, book, { characters: [{ name: "张三", description: "调查父亲死亡真相" }] });
    const living = await buildChapterBrief(root, book, "next", {});
    assert.equal(living.characters.find((item) => item.name === "张三")?.offstage, undefined);
    assert.equal(living.avoid.some((item) => item.kind === "已退场角色"), false);
    await writeSettings(root, book, { characters: [{ name: "张三", status: "已死", description: "调查父亲死亡真相" }] });
    const dead = await buildChapterBrief(root, book, "next", {});
    assert.equal(dead.characters.find((item) => item.name === "张三")?.offstage, true);
  });
});

test("graph distinguishes corrupt settings from missing settings", async () => {
  await withBook(async ({ root, book, chapterDir, dataDir }) => {
    await writeFile(join(chapterDir, "第01章.md"), "正文。", "utf8");
    const missing = await buildStoryGraph(root, book, {});
    assert.equal(missing.degraded.some((item) => item.includes("设定表读取失败")), false);
    const dir = join(dataDir, "settings");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, book + ".json"), "{broken", "utf8");
    const corrupt = await buildStoryGraph(root, book, {});
    assert.equal(corrupt.degraded.some((item) => item.includes("设定表读取失败")), true);
    await assert.rejects(readSettings(root, book, { strict: true }), SyntaxError);
  });
});

test("fix plan reports corrupt settings instead of calling them unregistered", async () => {
  await withBook(async ({ root, book, chapterDir, dataDir }) => {
    await writeFile(join(chapterDir, "第01章.md"), "这是一段测试正文。", "utf8");
    const dir = join(dataDir, "settings");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, book + ".json"), "{broken", "utf8");
    const plan = await buildFixPlan(root, book, "第01章.md", {});
    assert.match(plan.summary, /设定表读取失败/);
    assert.doesNotMatch(plan.summary, /未登记 worldview/);
    const verify = await verifyFixPlan(root, book, "第01章.md", {});
    assert.match(verify.summary, /设定表读取失败/);
  });
});

test("verify retains setting-dependent items when settings cannot be read", async () => {
  await withBook(async ({ root, book, chapterDir, dataDir }) => {
    await writeFile(join(chapterDir, "第01章.md"), "OLDTOKEN 和 HONORWORD 出现在正文中。", "utf8");
    await writeSettings(root, book, {
      worldview: [{ name: "规范", bannedWords: ["OLDTOKEN"], speechStyle: { honorBad: ["HONORWORD"] } }]
    });
    const plan = await buildFixPlan(root, book, "第01章.md", {});
    assert.deepEqual(new Set(plan.items.map((item) => item.type)), new Set(["禁用词", "语用不符"]));
    await writeFile(join(chapterDir, "第01章.md"), "正文已改写，不再含原来的用语。", "utf8");
    await writeFile(join(dataDir, "settings", book + ".json"), "{broken", "utf8");
    const verify = await verifyFixPlan(root, book, "第01章.md", {});
    assert.equal(verify.checked.length, 2);
    assert.ok(verify.checked.every((item) => item.status === "pending" && item.detail.includes("无法复测")));
    assert.match(verify.summary, /设定表读取失败/);
    assert.doesNotMatch(verify.summary, /已解决 [1-9]/);
  });
});

test("verify reads legacy plots without migrating them or writing an analysis cache", async () => {
  await withBook(async ({ root, book, chapterDir, dataDir }) => {
    for (let n = 1; n <= 3; n += 1) {
      await writeFile(join(chapterDir, `第0${n}章.md`), "这是一段足够长的章节正文，人物走过院子，打开门，看见屋内的灯仍然亮着。".repeat(2), "utf8");
    }
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, book + ".json"), JSON.stringify({ entries: [{ id: "p1", content: "旧伏笔", status: "open", chapter: "第01章" }] }), "utf8");
    await verifyFixPlan(root, book, "第03章.md", {});
    await assert.rejects(readFile(join(dataDir, "plots", book + ".json"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(dataDir, "analysis", book + "-chapters-metrics.json"), "utf8"), { code: "ENOENT" });
  });
});

// ---------------------------------------------------------------------------
// v6.2.1：core.js 修复项的回归（旧清单 #1/#2/#3/#4/#5/#6/#7/#8/#9 + 增量 #2/#3/#17/#18/#29）
// ---------------------------------------------------------------------------

test("章号解析：五位以上不截尾，节/回/话 与归一同口径", () => {
  // 旧清单 #1：\d{1,4} 不锚定数字前边界 → 引擎右移起点取尾部 4 位（静默错号、与第 1 章撞摘要槽位）
  assert.equal(parseChapterNumber("第1章.md"), 1);
  assert.equal(parseChapterNumber("第10000章.md"), undefined);
  assert.equal(parseChapterNumber("第10001章.md"), undefined);
  assert.equal(parseChapterNumber("第12345章.md"), undefined);
  // 归一化同样不得把 5 位数压成第 1 章
  assert.equal(normalizeChapterKey("第10001章"), "第10001章");
  assert.notEqual(normalizeChapterKey("第10001章"), normalizeChapterKey("第1章"));
  // 旧清单 #4：解析侧与归一化侧字符类必须一致 —— 「第一节 初遇.md」两边都要认出章号 1
  assert.equal(parseChapterNumber("第一节 初遇.md"), 1);
  assert.equal(parseChapterNumber("第01节.md"), 1);
  assert.equal(normalizeChapterKey("第一节 初遇.md"), "第01章");
  // 旧清单 #5：cjkToNumber 补「万」分支后不再是"字符类里有万、函数里没有"
  assert.equal(parseChapterNumber("第一万章.md"), undefined, "一万章超出 numberToCjk 的 9999 上界 → 判为解析不出（而非截尾）");
  // v7.3.1 修（#5）：纯数字分支与 parseChapterNumber 统一口径——5 位零填充章号必须归一到同一章
  assert.equal(parseChapterNumber("00001"), 1);
  assert.equal(normalizeChapterKey("00001"), "第01章", "「00001」与「第1章」同章，归一键不得原样返回");
  assert.equal(normalizeChapterKey("00001"), normalizeChapterKey("第1章"));
  assert.equal(normalizeChapterKey("000012-初遇"), "第12章", "分隔符分支同样吃 5 位零填充");
  // 超出上界仍保持"解析不出"口径：归一键原样返回，不硬压成第 N 章
  assert.equal(normalizeChapterKey("12345"), "12345");
});

test("nextFreeChapterFile 不返回已被占用的文件名", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-nextfree-"));
  try {
    // 旧清单 #7：numberToCjk 返回 null 时 break 会把上一轮算出的"已存在"候选名返回出去
    await writeFile(join(dir, "第9999章 旧.md"), "x", "utf8");
    // v7.3.1 修（#6）：章号已占满 9999 时不再产出「第10000章」（parseChapterNumber 认不出的孤章），
    // 改为显式报错。这条比 v6.2.1 的"不得返回已占用文件名"更硬：报错既不覆盖旧章，也不造孤章。
    assert.throws(() => nextFreeChapterFile(dir, "第9999章 旧.md"), /章号已用尽/);
    // 未到上界时正常改名避让必须不受影响（防止上界检查误伤常态）
    await writeFile(join(dir, "第02章 旧.md"), "x", "utf8");
    const bumped = nextFreeChapterFile(dir, "第02章 旧.md");
    assert.equal(bumped, "第03章 旧.md");
    assert.equal(parseChapterNumber(bumped), 3, "避让出的章名必须仍能解析出章号");
    // 超出章号上界（解析不出章号）不得静默加 "-2" 绕过去：显式报错
    assert.throws(() => nextFreeChapterFile(dir, "第10001章 远.md"), /章号超出支持范围/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("decodeTextBuffer：无 BOM 的 UTF-16LE 不再被当成合法 UTF-8 静默读坏", () => {
  // 旧清单 #6：每字节都 < 0x80 的 UTF-16LE 是合法 UTF-8，旧版直接返回乱码
  assert.equal(decodeTextBuffer(Buffer.from("你好世界", "utf16le"), "x.md"), "你好世界");
  assert.equal(decodeTextBuffer(Buffer.from("世界。", "utf16le"), "x.md"), "世界。");
  assert.equal(decodeTextBuffer(Buffer.from("他走了。", "utf16le"), "x.md"), "他走了。");
  // 真正的 UTF-8 / ASCII / GBK 判据不受影响（不得误判成 UTF-16）
  assert.equal(decodeTextBuffer(Buffer.from("初遇。", "utf8"), "x.md"), "初遇。");
  assert.equal(decodeTextBuffer(Buffer.from("chapter one\nhello world", "utf8"), "x.md"), "chapter one\nhello world");
  assert.equal(decodeTextBuffer(Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xa1, 0xa3]), "x.md"), "你好。");
});

test("novel_outline 的读失败不再被当成文件不存在（不覆盖手写创作资料）", async () => {
  await withBook(async ({ root, book }) => {
    const outline = createOutlineTool({});
    const exec = { agent: { session: { header: { cwd: root } } } };
    await outline.execute({ book, action: "init", root }, exec);
    const hooksFile = join(root, "novels", "创作资料", book, "钩子记录.md");
    const written = "# 钩子记录\n\n- 1 手写的旧钩子（必须保留）\n";
    await writeFile(hooksFile, written, "utf8");
    // 旧清单 #2：exec.signal 取消（AbortError）在旧版被 catch 当成 ENOENT → 用模板覆盖整个文件
    const aborting = { agent: { session: { header: { cwd: root } } }, signal: AbortSignal.abort() };
    await assert.rejects(() => outline.execute({ book, action: "hook", number: 2, body: "新钩子", root }, aborting), (e) => isAbort(e));
    assert.equal(await readFile(hooksFile, "utf8"), written, "取消不得改写用户手写的钩子记录");
  });
});

test("取消不再被吞成成功结果（enrichSemanticImplicit）", async (t) => {
  // 旧清单 #3：isAbort 是全插件唯一取消判据，旧版 core.js 一处未用 → 取消被伪装成"成功但字段缺失"。
  // 注意：该路径要求本地语义引擎可用（否则函数在 isAvailable() 处提前返回，与取消无关），
  // 故无模型的环境下跳过本用例而不是误报失败。
  if (!(await embedding.isAvailable())) {
    t.skip("本地语义引擎不可用（embedding.isAvailable()=false），本用例的读盘取消路径不可达");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "dsh-abort-"));
  try {
    await mkdir(join(root, "novels", "取消书"), { recursive: true });
    await writeFile(join(root, "novels", "取消书", "第01章.md"), "这是一段用于触发读盘的正文。", "utf8");
    const aborting = { agent: { session: { header: { cwd: root } } }, signal: AbortSignal.abort() };
    await assert.rejects(
      () => enrichSemanticImplicit({ features: { semanticEmbedding: true, semanticImplicit: true } }, root, "取消书", {}, aborting),
      (e) => isAbort(e),
      "取消必须上抛，不得降级成一份看似成功的结果"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("取消不再被渲染成「衔接·检查跳过」（detectChapterBridge）", async () => {
  // 旧清单 #3 第二处：外层 catch 把 AbortError 渲染成一条「衔接·检查跳过」候选，
  // 用户看到的是"跳过"而不是"已取消"。本用例不依赖语义引擎（章节文本读取在最前面）。
  await withBook(async ({ root, book }) => {
    await writeFile(join(root, "novels", book, "第01章.md"), "上一章结尾。\n", "utf8");
    await writeFile(join(root, "novels", book, "第02章.md"), "下一章开头。\n", "utf8");
    const aborting = { agent: { session: { header: { cwd: root } } }, signal: AbortSignal.abort() };
    await assert.rejects(
      () => detectChapterBridge(root, book, "第01章.md", "第02章.md", aborting),
      (e) => isAbort(e),
      "取消必须上抛，不得变成「衔接·检查跳过」候选"
    );
  });
});

test("词表路由：并发写不丢更新，且与工具侧共用同一把锁", async () => {
  // v6.3.0（独立校验）：路由侧的「读—改—写」此前没有纳入 withFileTx（只有工具的五个写 action 纳入了），
  // 而界面上的 toggle / save / import **全部走这条路由** —— 两边同时写同一层会丢更新。
  // 这里用 import（合并语义）而不是 save（整层覆盖）来验：save「谁后写谁赢」是契约本身，不是缺陷。
  const merge = (word) => bodyReq("POST", "/api/dsh-novel-writer/lexicon", { op: "import", scope: "book", book: "测试书", text: word });
  const r1 = fakeRes(); const r2 = fakeRes();
  await Promise.all([lexiconRoute(merge("并发甲"), r1), lexiconRoute(merge("并发乙"), r2)]);
  assert.equal(r1.status, 200, "并发 import #1 状态 " + r1.status);
  assert.equal(r2.status, 200, "并发 import #2 状态 " + r2.status);
  const listed = fakeRes();
  await lexiconRoute(plainReq("GET", "/api/dsh-novel-writer/lexicon?book=测试书&scope=book"), listed);
  const terms = JSON.parse(listed.body).entries.map((e) => e.term);
  assert.ok(terms.includes("并发甲") && terms.includes("并发乙"), "两个并发 import 的词条必须都在（只留一条 = 丢更新）：" + JSON.stringify(terms));

  // 路由侧与工具侧必须串在同一把锁上（同样的 file key），否则两边同时写仍会互相覆盖
  const r3 = fakeRes();
  await Promise.all([
    lexiconRoute(merge("并发丙"), r3),
    routeDefs.novel_lexicon.execute({ action: "add", terms: ["工具侧丁"], scope: "book", book: "测试书" }, routeExec)
  ]);
  const listed2 = fakeRes();
  await lexiconRoute(plainReq("GET", "/api/dsh-novel-writer/lexicon?book=测试书&scope=book"), listed2);
  const terms2 = JSON.parse(listed2.body).entries.map((e) => e.term);
  assert.ok(terms2.includes("并发丙") && terms2.includes("工具侧丁"), "路由与工具并发写后两侧内容都必须在：" + JSON.stringify(terms2));
});

test("显式 root 的写操作不写 lastRoot（探针 / --root 不污染宿主书库记忆点）", async () => {
  // v6.3.0：显式传入的 root（工具参数 root / CLI --root / 探针临时书库）只应影响本次调用。
  // 此前任何写操作都会把它记进 ~/.dsh 的 state.json —— 桌面端实测被探针改成
  // F:\...\_cache\tmp\lexprobe-XXXX（随后被删），于是面板里书库为空、词表 0 条，且从界面上极难自查。
  const stateFile = process.env.DSH_NOVEL_WRITER_STATE;
  const before = (await readSentenceState()).lastRoot;
  const explicitRoot = join(routeTestRoot, "novels", "显式根书");
  await mkdir(explicitRoot, { recursive: true });
  await writeFile(join(explicitRoot, "第01章.md"), "雨下了一整夜。\n", "utf8");
  const added = await routeDefs.novel_lexicon.execute({ action: "add", terms: ["显式根词"], book: "显式根书", root: explicitRoot }, routeExec);
  assert.equal(added.action, "add");
  const after = (await readSentenceState()).lastRoot;
  assert.notEqual(after, explicitRoot, "显式传入的 root 不得被写成 lastRoot（state 文件：" + stateFile + "）");
  assert.equal(after, before, "lastRoot 不应因显式 root 的写操作而改变");
});

test("词表路由：空书名 GET 不再 500（首屏 ?book=&scope=all）", async () => {
  // 增量 #2：sanitizeSegment("") 在 try 之外 assert 抛错 → UI 首屏必然 500，路由内兜底成死代码
  for (const url of ["/api/dsh-novel-writer/lexicon?book=&scope=all", "/api/dsh-novel-writer/lexicon?book=&scope=global", "/api/dsh-novel-writer/lexicon?scope=global", "/api/dsh-novel-writer/lexicon?book="]) {
    const res = fakeRes();
    await lexiconRoute(plainReq("GET", url), res);
    assert.equal(res.status, 200, url + " 必须 200（实际 " + res.status + "：" + res.body + "）");
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.books) && body.books.length > 0, "空书名时仍要回书列表（UI 靠它自动选第一本书）");
    assert.ok(body.books.includes("测试书"));
    // 冻结契约的键必须齐全（不得因空书名缺字段）
    for (const key of ["ok", "root", "book", "scope", "entries", "counts", "files", "enabled", "bookEnabled", "globalEnabled", "featureEnabled", "kinds", "books", "dir"]) {
      assert.ok(key in body, "响应缺键 " + key);
    }
    assert.equal(body.book, "");
  }
  // POST 缺书名的友好 400 必须真的可达（旧版被 sanitizeSegment 的 assert 抢先成 500）
  const res400 = fakeRes();
  await lexiconRoute(bodyReq("POST", "/api/dsh-novel-writer/lexicon", { op: "toggle", scope: "book", book: "", enabled: false }), res400);
  assert.equal(res400.status, 400, "缺书名的写操作应回 400，实际 " + res400.status + "：" + res400.body);
  assert.match(res400.body, /book is required/);
  // 空的全局层 toggle 照旧可用
  const resGlobal = fakeRes();
  await lexiconRoute(bodyReq("POST", "/api/dsh-novel-writer/lexicon", { op: "toggle", scope: "global", enabled: false }), resGlobal);
  assert.equal(resGlobal.status, 200, resGlobal.body);
});

test("词表文件损坏：GET 报 corrupt，写操作拒写且原条目不丢", async () => {
  // 增量 #3：JSON 解析失败与 ENOENT 混成一个"空表" → toggle/save/import 读到空表就写回空表（整层清空）
  // 注意：路由的根由 apply 时的 config.root 决定（resolveUiRoot 不回退调用方自定义根），
  // 故这里直接对模块级 routeTestRoot 里的书级词表文件做损坏/修复验证。
  const root = routeTestRoot;
  const file = lexiconFile(root, "测试书");
  {
    await mkdir(join(root, ".novel-writer", "lexicon"), { recursive: true });
    const broken = "{broken";
    await writeFile(file, broken, "utf8");
    const read = await readLexiconFile(root, "测试书");
    assert.equal(read.corrupt, true, "解析失败必须与 ENOENT 区分开");
    assert.equal(read.exists, true);
    const missing = await readLexiconFile(root, "不存在的书");
    assert.equal(missing.corrupt, false, "文件不存在不是损坏");
    // 拒写：不得把损坏文件覆盖成空表
    await assert.rejects(() => writeLexicon(root, "测试书", { entries: [{ term: "星轨" }], enabled: false }), (e) => e.code === "ENOVELWRITEFAIL" && e.corrupt === true);
    assert.equal(await readFile(file, "utf8"), broken, "拒写后原文必须原封不动");
    // 显式 force 才允许覆盖（UI 二次确认后的修复路径）
    const forced = await writeLexicon(root, "测试书", { entries: [{ term: "星轨" }], enabled: false, force: true });
    assert.equal(forced.count, 1);
    // 路由侧：GET 必须把"该层损坏"透出来；toggle 被守卫拦住（409 + corrupt 标记）；overwrite:true 可修复
    await writeFile(file, broken, "utf8");
    const getRes = fakeRes();
    await lexiconRoute(plainReq("GET", "/api/dsh-novel-writer/lexicon?book=" + encodeURIComponent("测试书") + "&scope=book"), getRes);
    assert.equal(getRes.status, 200, getRes.body);
    const getBody = JSON.parse(getRes.body);
    assert.equal(getBody.corrupt, true, "损坏层必须在响应体里体现（否则 UI 只看到空表）：" + getRes.body.slice(0, 200));
    assert.ok(Array.isArray(getBody.corruptFiles) && getBody.corruptFiles.length > 0);
    const toggleRes = fakeRes();
    await lexiconRoute(bodyReq("POST", "/api/dsh-novel-writer/lexicon", { op: "toggle", scope: "book", book: "测试书", enabled: false }), toggleRes);
    assert.equal(toggleRes.status, 409, "损坏层默认拒写，实际 " + toggleRes.status + "：" + toggleRes.body);
    assert.equal(JSON.parse(toggleRes.body).corrupt, true);
    assert.equal(await readFile(file, "utf8"), broken);
    const fixRes = fakeRes();
    await lexiconRoute(bodyReq("POST", "/api/dsh-novel-writer/lexicon", { op: "toggle", scope: "book", book: "测试书", enabled: false, overwrite: true }), fixRes);
    assert.equal(fixRes.status, 200, fixRes.body);
    assert.equal(JSON.parse(await readFile(file, "utf8")).enabled, false);
  }
});

test("词表路由：读体中途断开不再裸抛（三处 handler 同口径）", async () => {
  // 增量 #29 / 旧清单 #9：readJsonBody 的 for-await 在 try 之外 → ECONNRESET 时裸抛且一个字节响应都不写
  const throwingReq = (method, url) => ({
    method,
    url,
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" },
    [Symbol.asyncIterator]: () => ({ next: async () => { const e = new Error("aborted"); e.code = "ECONNRESET"; throw e; } })
  });
  for (const [url, payload] of [["/api/dsh-novel-writer/state", {}], ["/api/dsh-novel-writer/reveal", { target: "data-dir" }], ["/api/dsh-novel-writer/lexicon", { op: "toggle", scope: "global", enabled: false }]]) {
    const handler = routeList.find((r) => r.path === url).handler;
    const res = fakeRes();
    await handler(throwingReq("POST", url), res);
    assert.ok(res.status >= 400 && res.status < 500, url + " 读体失败应回 4xx，实际 " + res.status);
  }
});

test("词表批量行解析：avoid 的空格分隔与归一化同口径", () => {
  // 增量 #18：解析用 [,，、]，归一化用 [,，、\s]+，而注释承诺"逗号/顿号/空格分隔"
  assert.deepEqual(parseLexiconLine("星轨|专名|战斗|轨道 轨迹|空格").avoid, ["轨道", "轨迹"]);
  assert.deepEqual(normalizeLexiconEntry({ term: "星轨", avoid: "轨道 轨迹" }).avoid, ["轨道", "轨迹"]);
});

test("implicit 三比率之和恒 ≤ 1（与 analysis.js 同一派生口径）", async () => {
  // 旧清单 #28 同款：resolveAmbiguousCarriers 里三项各自四舍五入，negW=4/posW=1/ambW=1 → 0.67+0.17+0.17=1.01，
  // index.js 的「意象」行按百分比渲染给模型（101% 用户可见）。现在 ambiguousRatio 由 1 - negative - positive 派生。
  // 本用例用与显式路径等价的镜像计算覆盖权重的全组合（显式路径需要本地 ONNX 模型推理成功才可达，
  // 见 embedding.js isAvailable；无法在纯 node 环境下驱动）：数学与 core.js 内联代码逐行一致。
  const round2 = (x) => Math.round(x * 100) / 100;
  let over = 0;
  let zeroState = 0;
  for (let a = 0; a <= 12; a += 1) {
    for (let b = 0; b <= 12; b += 1) {
      for (let c = 0; c <= 12; c += 1) {
        const totalW = a + b + c;
        const negative = totalW === 0 ? 0 : round2(a / totalW);
        let positive = totalW === 0 ? 0 : round2(b / totalW);
        let ambiguousRatio = totalW === 0 ? 0 : round2(c / totalW);
        if (totalW > 0) {
          if (c === 0) positive = Math.max(0, round2(1 - negative));
          else ambiguousRatio = Math.max(0, round2(1 - negative - positive));
        }
        const sum = negative + positive + ambiguousRatio;
        if (sum > 1 + 1e-9) over += 1;
        if (totalW === 0 && (negative !== 0 || positive !== 0 || ambiguousRatio !== 0)) zeroState += 1;
      }
    }
  }
  assert.equal(over, 0, "不存在三项之和 > 1 的权重组合");
  assert.equal(zeroState, 0, "无命中时三项必须都是 0");
  // 具体现场：旧版这里就是 1.01（4/6、1/6、1/6 各自取整）
  assert.equal(round2(round2(4 / 6) + round2(1 / 6) + Math.max(0, round2(1 - round2(4 / 6) - round2(1 / 6)))), 1);
  // 源码级核对：派生式必须还在（防回退成三项独立取整）
  const src = await readFile(new URL("../lib/core.js", import.meta.url), "utf8");
  assert.match(src, /ambiguousRatio = Math\.max\(0, Math\.round\(\(1 - negative - positive\)/);
  assert.match(src, /positive = Math\.max\(0, Math\.round\(\(1 - negative\)/);
});

// v6.4.0：lastRoot 的落盘守卫
//
// 现场：桌面端 `lastRoot` 被写成 `F:\doment\_cache\fix4\lib`（某次测试会话的 cwd，目录早已不存在），
// 于是**词表面板一本书都列不出来**，显示「(尚未选择书)」「本书 0 条 全局 0 条」——
// 而 UI 路由的根解析顺序是 `config.root → lastRoot → cwd`（lib/core.js 的 UI 路由段），
// 插件的 bundle 里 config.root 又恰好是空串，于是完全依赖 lastRoot。
//
// 这个故障的形态是「面板静默变空、从界面上极难自查」，所以必须有回归断言钉住两条边界：
//   ① 显式 root（工具参数/探针临时库）不落盘 —— v6.3.0 已堵
//   ② cwd 兜底（会话工作目录）不落盘 —— v6.4.0 新堵，正是上面那次污染的来源
// 同时必须断言「配置根仍然正常落盘」，否则就是把功能改死了（宁可漏记也不能不记）。
test("v6.4.0：lastRoot 不记录显式 root 与 cwd 兜底，但配置根正常落盘", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-root-guard-"));
  const prev = process.env.DSH_NOVEL_WRITER_STATE;
  process.env.DSH_NOVEL_WRITER_STATE = join(dir, "state-guard.json"); // stateFilePath() 惰性读 env
  const readState = async () => {
    try { return JSON.parse(await readFile(join(dir, "state-guard.json"), "utf8")); } catch { return {}; }
  };
  try {
    // ① 显式 root 不落盘
    const explicit = join(dir, "explicit-lib");
    assert.equal(resolveRoot({}, { root: explicit }, undefined), explicit);
    await noteRoot(explicit);
    assert.notEqual((await readState()).lastRoot, explicit, "显式 root 不得写进 lastRoot");

    // ② cwd 兜底不落盘（本次修复的那一半）
    const cwd = join(dir, "some-session-cwd");
    assert.equal(resolveRoot({}, {}, { agent: { session: { header: { cwd } } } }), cwd);
    await noteRoot(cwd);
    assert.notEqual((await readState()).lastRoot, cwd, "cwd 兜底不得写进 lastRoot");

    // ③ 无 config.root 时确实走 cwd 兜底（确认上一条测的是真路径，不是空转）
    assert.equal(resolveRoot({ root: "" }, {}, { agent: { session: { header: { cwd } } } }), cwd,
      "config.root 为空串时应回退 cwd（插件 bundle 里就是空串）");

    // ④ 配置根**必须**正常落盘——否则是把功能改死了
    const configured = join(dir, "configured-root");
    assert.equal(resolveRoot({ root: configured }, {}, undefined), configured);
    await noteRoot(configured);
    assert.equal((await readState()).lastRoot, configured, "配置根应正常记入 lastRoot");

    // ⑤ 库根的**语义契约**：root 的下一层才是 novels/ 与 .novel-writer/
    //
    // 这条是被一次真实误配打回来的：把 `config.root` 填成 `<库根>\novels`（看起来"更像小说目录"），
    // 会让 listBookNames 去找 `<库根>\novels\novels` → 目录不存在 → catch 返空数组
    // → **面板一本书都列不出来，且没有任何报错**。判据钉在函数关系上，不靠记忆：
    assert.equal(novelsDir(join("X", "libroot")), join("X", "libroot", "novels"),
      "novelsDir(root) 必须是 <root>/novels —— 即 root 是 novels 的**父目录**");
    const goodRoot = join(dir, "good-root");
    await mkdir(join(goodRoot, "novels", "测试书"), { recursive: true });
    assert.deepEqual(await listBookNames(goodRoot), ["测试书"], "父目录作为 root 时应能列出 novels/ 下的书");
    assert.deepEqual(await listBookNames(join(goodRoot, "novels")), [],
      "把 novels 目录本身当 root 会列不出书（误配现场复现：静默返空、不报错）");

    // ⑥ v6.4.0：根解析的**可发现性**——把"静默无书"变成"看一眼就知道怎么修"
    //
    // 起因：这两个故障（lastRoot 被污染 / config.root 填低一层）**症状完全相同、且都不报错**，
    // 排查花了很久。现在解析结果会带 source 与 warning。
    assert.equal(resolveUiRootInfo({ root: goodRoot }, {}).warning, null, "库根正确时不应有警告");
    assert.equal(resolveUiRootInfo({ root: goodRoot }, {}).source, "config");
    const badCfg = resolveUiRootInfo({ root: join(goodRoot, "novels") }, {});
    assert.equal(badCfg.source, "config");
    assert.ok(badCfg.warning && /库根/.test(badCfg.warning),
      "config.root 填成 novels 目录本身时必须给出警告（本次真实误配的现场）");
    const stale = resolveUiRootInfo({ root: "" }, { lastRoot: join(dir, "nonexistent-root") });
    assert.notEqual(stale.source, "lastRoot", "失效的 lastRoot 不得被采用（不能再把死路径当根）");
    assert.ok(stale.warning && /lastRoot/.test(stale.warning),
      "失效 lastRoot 必须留下点名诊断——否则用户的书为什么消失就无从得知");
    assert.ok(["internal", "cwd"].includes(stale.source), "应继续回退到工作区或插件内部目录");
    // 候选被拒后**不能**回到那个被拒的根（旧版会把死路径原样返回，面板于是永远空白）
    assert.notEqual(stale.root, join(dir, "nonexistent-root"), "被拒的候选不得出现在最终 root 里");
    assert.equal(resolveUiRootInfo({ root: goodRoot }, { lastRoot: "X" }).source, "config",
      "config.root 非空时优先级高于 lastRoot");
    assert.equal(resolveUiRoot({ root: goodRoot }, {}), goodRoot, "resolveUiRoot 仍返回根字符串（兼容既有调用点）");

    // ⑦ v6.4.0：最终兜底是**插件内部目录**，不是「随便一个工作区」
    //
    // 起因（用户质询）：旧链最后一跳是 process.cwd()，而**工作区与书库没有任何必然关系**——
    // 在随便哪个目录里开会话，面板就把那个目录当书库，然后静默列不出书。
    // 现在工作区**只有在它确实像个书库时**才被采用，否则落到插件自己的目录。
    assert.equal(internalRoot(), join(homedir(), ".dsh", "dsh-novel-writer", "library"),
      "插件内部根应与其数据目录同级（state.json 就在那儿）");
    assert.ok(internalRoot().startsWith(homedir()), "内部根必须在用户目录下，不能落在工作区");
    if (!looksLikeLibraryRoot(process.cwd())) {
      const r = resolveUiRootInfo({ root: "" }, {});
      assert.equal(r.source, "internal", "无任何候选时应回退插件内部目录，而不是把工作区当书库");
      assert.equal(r.root, internalRoot());
      assert.equal(r.warning, null,
        "「工作区不像书库」属**正常设计路径**，不该报警告——否则每次在随便哪个目录开会话都弹一次，纯噪音");
    }
    // looksLikeLibraryRoot 的判据：novels/ 或 .novel-writer/ 任一存在
    assert.equal(looksLikeLibraryRoot(goodRoot), true);
    assert.equal(looksLikeLibraryRoot(join(goodRoot, "novels")), false, "novels 目录本身不算库根");
    assert.equal(looksLikeLibraryRoot(""), false);
    const dotRoot = join(dir, "dot-root");
    await mkdir(join(dotRoot, ".novel-writer"), { recursive: true });
    assert.equal(looksLikeLibraryRoot(dotRoot), true, "只有 .novel-writer/ 而无 novels/ 也算（新库尚未建书）");
  } finally {
    if (prev === undefined) delete process.env.DSH_NOVEL_WRITER_STATE;
    else process.env.DSH_NOVEL_WRITER_STATE = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("v6.9.0 词表审查修复回归：auditLexicon 不把专名自身含有的替身词算作违规命中", () => {
  const result = auditLexicon(
    [{ term: "魔导步枪", avoid: ["步枪"] }],
    "战士手持魔导步枪冲锋。\n"
  );
  assert.equal(result.coveredCount, 1);
  assert.equal(result.avoidHits.length, 0, "魔导步枪命中处不得因包含「步枪」而产生 avoid 误报");
});

test("v6.9.0 词表审查修复回归：extractKeywords 去重与候选规范", () => {
  const text = "林风站在山崖上。林风看着远方。林风握紧了拳头。";
  const kw = extractKeywords(text, 10);
  const terms = kw.map((k) => k.word);
  assert.equal(new Set(terms).size, terms.length, "提取的关键词不得有重复项");
});

test("v6.9.0 词表审查修复回归：measureStyleMetrics 的修饰词与抽象词判定", () => {
  // 「天真的」与「所有的」必须计为真实修饰词（adjMods）
  const m1 = measureStyleMetrics("他露出了天真的笑容。");
  assert.ok(m1.detail.adjMods > 0, "天真的 应当被计入真实修饰词");
  const m2 = measureStyleMetrics("他交出了所有的希望。");
  assert.ok(m2.detail.adjMods > 0, "所有的 应当被计入真实修饰词");

  // 假阳性停用词（如「认真」「写信」「方法」不再因末字为「真」「信」「法」而误计为抽象概念）
  const m3 = measureStyleMetrics("他认真地写信。");
  assert.equal(m3.detail.abstractCount, 0, "认真/写信 不得因末字为抽象后缀而误计为抽象概念");
  const m4 = measureStyleMetrics("这个方法很管用。");
  assert.equal(m4.detail.abstractCount, 0, "方法 不得因末字为「法」而误计为抽象概念");
  const m5 = measureStyleMetrics("他心中涌起一阵孤独感。");
  assert.ok(m5.detail.abstractCount > 0, "孤独感 应当被计入抽象概念");
});

test("v6.9.0 词表审查修复回归：未登记 worldview 时 brief 仍注入默认禁用词", async () => {
  await withBook(async ({ root, book, chapterDir }) => {
    await writeFile(join(chapterDir, "第01章.md"), "骑士推开大门。\n", "utf8");
    const brief = await buildChapterBrief(root, book, "next", {});
    assert.ok(brief.avoid.some((a) => a.kind === "禁词"), "未登记 worldview 时 brief.avoid 必须注入默认禁用词");
    assert.ok(brief.worldview && brief.worldview.bannedWords.length > 0, "brief.worldview 必须注入默认禁用词列表");
    assert.ok(brief.degraded.some((d) => d.includes("默认禁用词表")), "未登记 worldview 时 degraded 必须说明已注入默认禁用词表");
  });
});

// ---------------------------------------------------------------------------
// v7.0.1：源码审查 14 条缺陷的回归（core 侧 #3 / #31 / #34 / #35 / #37 / #38 / #52 / #55 / #64）
// 每条都先有断言、再改实现；断言取值来自缺陷判据，不掺"看着差不多"。
// ---------------------------------------------------------------------------

test("【#3】sanitizeSegment 把中间连续点号规整为下划线（不再产出含 .. 的 trashId 片段）", () => {
  // 旧版只剥首尾点号，中间 ".." 原样保留 → trashId 含 ".." 被 isValidTrashId 判非法，条目永久孤立。
  assert.equal(sanitizeSegment("v1..2", "book"), "v1_2");
  assert.equal(sanitizeSegment("a.b", "book"), "a.b", "单个点号是合法书名，不得改动");
  assert.equal(sanitizeSegment("v1...2", "book"), "v1_2", "连续 3 个点号同样压成一个下划线");
  assert.equal(sanitizeSegment("..v1..2..", "book"), "v1_2", "首尾点号先剥、中间点号再压");
  assert.throws(() => sanitizeSegment("..", "book"), /不能为空/, "纯点号仍按「清洗后无有效字符」拒绝");
});

test("【#31】词表审计：替身词「包含」必用词时必须报 avoidHit（严格包含判定 + 跨词条占位互通）", () => {
  // 旧版用区间相交判"已在合法专名内"：「草药」与必用词「药」相交 → 被当成合法而漏报。
  const hit = auditLexicon([{ term: "药", avoid: ["草药"] }], "他买了草药。\n");
  assert.equal(hit.avoidHits.length, 1, "「草药」并未完整落在必用词「药」之内，必须报 avoidHit");
  assert.equal(hit.avoidHits[0].word, "草药");
  assert.equal(hit.avoidHits[0].term, "药");
  assert.equal(hit.avoidHits[0].line, 1);
  // 真正被完整包含的（魔导步枪 ⊃ 步枪）仍不报——既有口径不得回退
  const clean = auditLexicon([{ term: "魔导步枪", avoid: ["步枪"] }], "战士手持魔导步枪冲锋。\n");
  assert.equal(clean.avoidHits.length, 0, "必用词自身含有的替身词不得误报");
  // 占位跨词条互通：替身词落在**另一条目**的合法专名内部时不报
  const shared = auditLexicon([{ term: "灵芝草" }, { term: "丹房", avoid: ["草"] }], "他买了灵芝草。\n");
  assert.equal(shared.avoidHits.length, 0, "「草」落在另一条目的合法专名「灵芝草」内，属正常用词");
  // 覆盖计数仍按本词条口径：短词落在另一条目的长词里也不能被判 missing
  const both = auditLexicon([{ term: "草药" }, { term: "药" }], "他买了草药。\n");
  assert.equal(both.coveredCount, 2, "「草药」与「药」都确实出现，不得因共享占位而漏计");
});

test("【#34】cjkToNumber 无权位叠字按十进制位权累加（「一二」= 12，不再静默取末位）", () => {
  assert.equal(cjkToNumber("一二"), 12);
  assert.equal(cjkToNumber("一零"), 10, "「一零」= 10（不是 undefined，也不是 0）");
  assert.equal(cjkToNumber("一零二四"), 1024);
  // 「零」明确判为解析不出（第 0 章不存在）：这里把行为写死，防止以后被改成 0 而静默多出第 0 章
  assert.equal(cjkToNumber("零"), undefined);
  assert.equal(parseChapterNumber("第零章.md"), undefined, "「第零章」走同一条判据：解析不出");
  // 有位权字的既有口径不得回归
  assert.equal(cjkToNumber("十二"), 12);
  assert.equal(cjkToNumber("二十"), 20);
  assert.equal(cjkToNumber("一千零一"), 1001);
  assert.equal(cjkToNumber("一万"), 10000);
  // v7.3.1 修（#4）：「万」是**进位权**，它左边的整段数字要一起乘 10000。
  // 旧实现只把「万」前最后一个数字段乘进去（已累计的 total 被丢掉）：「十二万」=10+2*10000=20010、「十万」=10010。
  assert.equal(cjkToNumber("十二万"), 120000, "「十二万」必须是 120000（旧版 20010）");
  assert.equal(cjkToNumber("十万"), 100000, "「十万」必须是 100000（旧版 10010）");
  assert.equal(cjkToNumber("万"), 10000, "单字「万」按 1 万读");
  assert.equal(cjkToNumber("一万二千"), 12000, "「万」之后的小段继续累加");
  assert.equal(cjkToNumber("一千二百万"), 12000000, "「万」左边含百位小段时整段乘 10000");
});

test("【#35】「1984-第一章.md」按中文「第N章」解析，不再被分隔符数字抢成第 1984 章", () => {
  assert.equal(parseChapterNumber("1984-第一章.md"), 1);
  assert.equal(parseChapterNumber("1984-第1章.md"), 1);
  assert.equal(parseChapterNumber("第1984章"), 1984, "纯「第1984章」仍按阿位伯数字取 1984");
  assert.equal(parseChapterNumber("斗破苍穹-01-陨落.md"), 1, "无「第」的分隔符章号保持原口径");
});

test("【#37】normalizeChapterKey 统一剥除 .md/.markdown/.txt 扩展名", () => {
  assert.equal(normalizeChapterKey("番外.md"), "番外");
  assert.equal(normalizeChapterKey("番外.markdown"), "番外");
  assert.equal(normalizeChapterKey("番外.txt"), "番外");
  assert.equal(normalizeChapterKey("番外.MD"), "番外", "扩展名大小写不敏感");
  assert.equal(normalizeChapterKey("第01章.md"), "第01章", "章号归一不受影响");
});

test("【#38】formatImport 不向模型输出宿主绝对路径（相对书库根，失败只留 basename）", () => {
  const base = { mode: "scan", groups: [], skipped: [], imported: [] };
  if (process.platform === "win32") {
    const text = formatImport({ ...base, src: "C:\\Users\\zg\\Desktop\\稿件" }, "C:\\Users\\zg\\Desktop");
    assert.equal(text.split("\n")[0], "<path>稿件</path>", "书库根内 → 相对书库根");
    assert.ok(!/[A-Za-z]:[\\/]/.test(text), "渲染文本不得出现 Windows 盘符绝对路径：" + text.split("\n")[0]);
    const outside = formatImport({ ...base, src: "D:\\备份\\小说\\旧稿" }, "C:\\Users\\zg\\Desktop");
    assert.equal(outside.split("\n")[0], "<path>旧稿</path>", "跨盘符 relative 失败 → 只留 basename");
    const noRoot = formatImport({ ...base, src: "C:\\Users\\zg\\Desktop\\稿件" });
    assert.equal(noRoot.split("\n")[0], "<path>稿件</path>", "拿不到书库根时同样只留 basename");
  } else {
    const text = formatImport({ ...base, src: "/home/zg/novels/草稿" }, "/home/zg");
    assert.equal(text.split("\n")[0], "<path>novels/草稿</path>", "书库根内 → 相对书库根");
    assert.ok(!text.includes("/home/"), "渲染文本不得出现 /home/ 绝对路径");
  }
  // 判据的普适形式：无论如何都不得把绝对路径原样吐给模型
  const win = formatImport({ ...base, src: "C:\\Users\\zg\\Desktop\\稿件" }, "C:\\Users\\zg\\Desktop");
  assert.ok(!/[A-Za-z]:[\\/]/.test(win), "Windows 绝对路径泄露");
  const posix = formatImport({ ...base, src: "/home/zg/novels/草稿" }, "/home/zg");
  assert.ok(!posix.includes("/home/"), "POSIX 绝对路径泄露");
});

test("【#52】大纲方向行正则单一来源 OUTLINE_LINE_RE，判重按行首锚定", async () => {
  const parse = (line) => {
    const m = OUTLINE_LINE_RE.exec(line);
    return m === null ? null : { number: Number(m[1]), text: m[2].trim() };
  };
  assert.deepEqual(parse("- 3 夜航"), { number: 3, text: "夜航" }, "novel_outline 自己落盘的格式");
  assert.deepEqual(parse("- 第3章 夜航"), { number: 3, text: "夜航" });
  assert.deepEqual(parse("* 第3节 夜航"), { number: 3, text: "夜航" }, "「节」与章/回/话 同口径（graph 旧正则漏了它）");
  assert.deepEqual(parse("# 第3章 夜航"), { number: 3, text: "夜航" });
  assert.deepEqual(parse("3、夜航"), { number: 3, text: "夜航" });
  assert.equal(parse("正文里提到 - 3 秒后的爆炸"), null, "正文中间的「- 3 」不是方向行");

  await withBook(async ({ root, book }) => {
    const outline = createOutlineTool({});
    const exec = { agent: { session: { header: { cwd: root } } } };
    await outline.execute({ book, action: "init", root }, exec);
    const file = join(root, "novels", "创作资料", book, "剧情大纲.md");
    // 旧版用 includes("- 3 ") 判重：正文里出现「- 3 」就误以为第 3 章已在纲
    await writeFile(file, "# 剧情大纲\n\n第 2 章里他数了 - 3 秒钟。\n", "utf8");
    const added = await outline.execute({ book, action: "chapter", number: 3, title: "夜航", root }, exec);
    assert.ok(/大纲已补/.test(added.message), "正文里的「- 3 」不得被当成「已在纲」，实际：" + added.message);
    const after = await readFile(file, "utf8");
    assert.ok(/^- 3 夜航$/m.test(after), "第 3 章方向行必须真的落盘");
    const again = await outline.execute({ book, action: "chapter", number: 3, title: "夜航", root }, exec);
    assert.ok(/已在纲/.test(again.message), "已有行首「- 3 夜航」后必须识别为已在纲，实际：" + again.message);
    assert.equal((after.match(/^- 3 /gm) || []).length, 1, "同号方向行不得重复追加");
  });
});

test("【#55】只带 allowWords 的「用词豁免」条目不得被当成文化基准名", () => {
  const fallback = resolveStyleRule({}, []).cultureName;
  const rule = resolveStyleRule({ worldview: [{ name: "用词豁免", allowWords: ["修士"], bannedWords: [] }] }, []);
  assert.notEqual(rule.cultureName, "用词豁免", "保留名不得污染 cultureName（否则文案显示「与当前文化基准「用词豁免」不符」）");
  assert.equal(rule.cultureName, fallback, "没有真正的文化声明时，cultureName 必须落默认基准名");
  assert.deepEqual(rule.allowedWords, ["修士"], "用词豁免本身仍要生效");
  // 正常命名的文化条目仍要覆写 cultureName（不要把过滤写成「一律不用条目名」）
  const named = resolveStyleRule({ worldview: [{ name: "东方修真", bannedWords: ["骑士"] }] }, []);
  assert.equal(named.cultureName, "东方修真");
});

test("【#64】bookNameFromFileName 删掉不可达分支后行为不变", () => {
  // 以章号开头且没有书名前缀的文件仍归「未分类」（name === "" 分支）
  assert.equal(bookNameFromFileName("第1章 初遇.md"), undefined);
  assert.equal(bookNameFromFileName("01-初遇.md"), undefined);
  assert.equal(bookNameFromFileName("第一章 初遇.md"), undefined);
  assert.equal(bookNameFromFileName("第01节 初遇.md"), undefined);
  // 有书名前缀的照旧取书名；中文数字+空格是书名不是章号
  assert.equal(bookNameFromFileName("斗破苍穹 第1章 陨落.md"), "斗破苍穹");
  assert.equal(bookNameFromFileName("大秦帝国 第1章.md"), "大秦帝国");
  assert.equal(bookNameFromFileName("三 体.md"), "三 体");
});

// v7.3.3 修（#11/M7）：三处 catch 必须放行 AbortError——取消不是「读取失败」，不得被伪装成成功，
// 也不得写进本地事件日志（否则 novel_diagnose 的 byKind 会把「用户按了取消」计成「数据故障」）。
test("【#11/M7】三处取消都抛 AbortError，且取消不写事件日志、真故障仍写", async () => {
  await withBook(async ({ root, book, chapterDir }) => {
    const exec = { agent: { session: { header: { cwd: root } } } };
    // ① readBaselineScope：取消必须抛，不得返回 {mode:"all",chapters:[]}
    await assert.rejects(readBaselineScope(root, book, { signal: AbortSignal.abort() }), (e) => isAbort(e));
    // ② novel_outline read：第 1 次读状态卡成功、第 2 次读大纲被取消
    const outline = createOutlineTool({});
    await outline.execute({ book, action: "init", root }, exec);
    let n = 0;
    const abortOnSecond = { agent: { session: { header: { cwd: root } } }, get signal() { n += 1; return n === 2 ? AbortSignal.abort() : undefined; } };
    await assert.rejects(outline.execute({ book, action: "read", file: "status", root }, abortOnSecond), (e) => isAbort(e));
    // ③ detectChapterBridge：前两次读章节成功、第 3 次读钩子记录被取消
    await writeFile(join(chapterDir, "第01章.md"), "他把杯子放回桌上，转身走进里屋，没有再回头看一眼。", "utf8");
    await writeFile(join(chapterDir, "第02章.md"), "楼道里的灯坏了三天，他摸黑上楼，钥匙在锁孔里转了两圈才打开。", "utf8");
    const creation = join(root, "novels", "创作资料", book);
    await mkdir(creation, { recursive: true });
    await writeFile(join(creation, "钩子记录.md"), "# 钩子记录\n\n- 1 她站在码头边等他，手里攥着一张被雨打湿的车票\n", "utf8");
    const normal = await detectChapterBridge(root, book, "第01章.md", "第02章.md", exec);
    assert.ok(normal.some((x) => x.type === "衔接·钩子未接"), "正常时钩子未接检查要真的跑起来：" + JSON.stringify(normal));
    let k = 0;
    const abortOnThird = { agent: { session: { header: { cwd: root } } }, get signal() { k += 1; return k === 3 ? AbortSignal.abort() : undefined; } };
    await assert.rejects(detectChapterBridge(root, book, "第01章.md", "第02章.md", abortOnThird), (e) => isAbort(e));

    // M7：以上取消不得写事件日志（按书过滤）；真故障仍要写
    const logBook = "日志取消测试";
    const eventsFor = async (b) => (await readLogEvents({ limit: 5000, forShare: false })).filter((e) => e.book === b);
    const beforeCancel = (await eventsFor(book)).length;
    const beforeLogBook = (await eventsFor(logBook)).length;
    await assert.rejects(readBaselineScope(root, logBook, { signal: AbortSignal.abort() }), (e) => isAbort(e));
    let m = 0;
    await outline.execute({ book: logBook, action: "init", root }, exec);
    const abortOnSecond2 = { agent: { session: { header: { cwd: root } } }, get signal() { m += 1; return m === 2 ? AbortSignal.abort() : undefined; } };
    await assert.rejects(outline.execute({ book: logBook, action: "read", file: "status", root }, abortOnSecond2), (e) => isAbort(e));
    let j = 0;
    await assert.rejects(detectChapterBridge(root, book, "第01章.md", "第02章.md", { agent: { session: { header: { cwd: root } } }, get signal() { j += 1; return j === 3 ? AbortSignal.abort() : undefined; } }), (e) => isAbort(e));
    assert.equal((await eventsFor(book)).length, beforeCancel, "取消不得写事件日志（测试书）");
    assert.equal((await eventsFor(logBook)).length, beforeLogBook, "取消不得写事件日志（日志取消测试）");
    // 真故障（基线 JSON 损坏）仍必须留痕
    const baseline = join(root, ".novel-writer", "baseline", logBook + ".json");
    await mkdir(join(root, ".novel-writer", "baseline"), { recursive: true });
    await writeFile(baseline, "{ 坏掉的 json", "utf8");
    await readBaselineScope(root, logBook, exec);
    assert.ok((await eventsFor(logBook)).length > beforeLogBook, "真故障必须仍写事件日志");
  });
});

// v7.3.3 修（M1）：句式骨架不得把 Markdown 标题粘进句子（novel_new_chapter 落盘的章节正是标题开头）。
test("【M1】句式骨架剥掉 Markdown 标题，正常正文采样不变", async () => {
  const headed = "# 第02章 雨夜\n他沿着河岸慢慢走，风从背后推着他向前，夜色像水一样漫过脚踝。远处灯塔的光扫过水面，又暗下去。";
  const fixed = await buildStyleAnchorPackage(".", "测试书", [], {}, headed);
  assert.ok(fixed.skeletons.length > 0, "标题之外仍有合格句，骨架不得为空");
  assert.ok(fixed.skeletons.every((s) => !s.text.includes("#")), "骨架不得含 #：" + JSON.stringify(fixed.skeletons));
  assert.ok(fixed.skeletons.some((s) => s.text.includes("他沿着河岸慢慢走")), "正常正文仍要被采样");
  // 没有标题的语料行为不变（同一句仍被抽中）
  const plain = "他沿着河岸慢慢走，风从背后推着他向前，夜色像水一样漫过脚踝。远处灯塔的光扫过水面，又暗下去。";
  const unchanged = await buildStyleAnchorPackage(".", "测试书", [], {}, plain);
  assert.deepEqual(unchanged.skeletons, fixed.skeletons, "无标题时骨架应与修复前一致（不误伤正常语料）");
});

// v7.3.3 修（M5）：文件名被同名目录占位时 init 必须明确报错，不得回「已初始化（6 个文件）」。
test("【M5】novel_outline init 遇到同名目录占位要明确报错", async () => {
  await withBook(async ({ root, book }) => {
    const dir = join(root, "novels", "创作资料", book);
    await mkdir(join(dir, "钩子记录.md"), { recursive: true });
    const outline = createOutlineTool({});
    const exec = { agent: { session: { header: { cwd: root } } } };
    await assert.rejects(outline.execute({ book, action: "init", root }, exec), /被同名目录占位/);
    // 「写入前检查」：一个文件都不该被写出来（不是写到一半才报错）
    await assert.rejects(readFile(join(dir, "创作设定.md"), "utf8"), /ENOENT/);
    await assert.rejects(outline.execute({ book, action: "read", file: "hooks", root }, exec), /创作资料读取失败/);
  });
});

// v7.3.3 修（M6）：钩子行解析统一走 OUTLINE_LINE_RE——`* 1 …` 与 `- 1 …` 两个工具结论必须一致。
test("【M6】钩子记录 `* 1` 与 `- 1` 在 novel_outline read 与 detectChapterBridge 中结论一致", async () => {
  await withBook(async ({ root, book, chapterDir }) => {
    const exec = { agent: { session: { header: { cwd: root } } } };
    const outline = createOutlineTool({});
    await outline.execute({ book, action: "init", root }, exec);
    const creation = join(root, "novels", "创作资料", book);
    await writeFile(join(chapterDir, "第01章.md"), "他把杯子放回桌上，转身走进里屋，没有再回头看一眼。", "utf8");
    await writeFile(join(chapterDir, "第02章.md"), "楼道里的灯坏了三天，他摸黑上楼，钥匙在锁孔里转了两圈才打开。", "utf8");
    for (const prefix of ["-", "*"]) {
      await writeFile(join(creation, "剧情大纲.md"), "# 剧情大纲\n\n- 1 第一章\n- 2 第二章\n", "utf8");
      await writeFile(join(creation, "钩子记录.md"), "# 钩子记录\n\n" + prefix + " 1 她站在码头边等他，手里攥着一张被雨打湿的车票\n", "utf8");
      const read = await outline.execute({ book, action: "read", file: "outline", root }, exec);
      assert.ok(read.content.includes("未回填钩子章节：2"), prefix + " 写法：outline read 应提示第 2 章未回填，实际：" + read.content);
      const bridge = await detectChapterBridge(root, book, "第01章.md", "第02章.md", exec);
      assert.ok(bridge.some((x) => x.type === "衔接·钩子未接"), prefix + " 写法：detectChapterBridge 应报钩子未接，实际：" + JSON.stringify(bridge));
    }
  });
});
