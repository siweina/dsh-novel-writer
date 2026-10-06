import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createOutlineTool,
  decodeTextBuffer,
  detectChapterBridge,
  enrichSemanticImplicit,
  findChapter,
  isAbort,
  lexiconFile,
  nextFreeChapterFile,
  normalizeChapterKey,
  normalizeLexiconEntry,
  parseChapterNumber,
  parseLexiconLine,
  readLexiconFile,
  readSentenceState,
  readSettings,
  writeLexicon
} from "../lib/core.js";
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
});

test("nextFreeChapterFile 不返回已被占用的文件名", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-nextfree-"));
  try {
    // 旧清单 #7：numberToCjk 返回 null 时 break 会把上一轮算出的"已存在"候选名返回出去
    await writeFile(join(dir, "第9999章 旧.md"), "x", "utf8");
    const next = nextFreeChapterFile(dir, "第9999章 旧.md");
    assert.notEqual(next, "第9999章 旧.md", "不得返回磁盘上已占用的文件名（否则调用方落盘即覆盖旧章）");
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
