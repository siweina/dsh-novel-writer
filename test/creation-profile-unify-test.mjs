/**
 * test/creation-profile-unify-test.mjs —— v8.0.0 按书创作设定统一落盘与隔离回归套件（第 46 个测试套件）
 *
 * 覆盖范围：
 *   1. 按书落盘至 <root>/.novel-writer/settings/<book>.json：
 *      - writeBookCreationProfile / POST /api/dsh-novel-writer/state / novel_sentence_config 三入口统一落盘、同步创作资料 .md 并清理 state.json 遗留键
 *      - readSettings(root, book) 仅返回五表，不泄漏 creationProfile
 *      - writeSettings / novel_settings 不传 creationProfile 时保留既有 creationProfile
 *   2. 双书库隔离：同书名「同书名」在 libA 与 libB 各自持有独立 creationProfile，互不串扰
 *   3. 优先级与回退：settings/<book>.json .creationProfile > state.json creationProfiles[book] > 全局 creationProfile；
 *      清除不存在设定不产生空壳 settings 文件，清除现有设定后正确回退
 *   4. 工具端到端消费：novel_outline init 与 novel_chapter_brief（系统流题材静音 stat_numeric）均消费书库本地设定
 *   5. 回收站删书与恢复 + purgeBookCache 联动：删书把 settings/<book>.json（含 creationProfile）移入回收站并清理 cache.sqlite 中本书行（不伤及同库其他书），restoreTrash 原样恢复
 *   6. 隔离守卫：真实 ~/.dsh/dsh-novel-writer/ 目录全程哈希一致
 *
 * 运行：node test/creation-profile-unify-test.mjs
 */

import assert from "node:assert/strict";
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
import { dirname, join } from "node:path";
import test from "node:test";

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

const TMP_BASE = realpathSync.native(mkdtempSync(join(tmpdir(), "dsh-creation-profile-" + process.pid + "-")));
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

let PLUGIN;
let CORE;
let DB;
let BOOKDELETE;
let SYSTEM_TOOLS;
let WEB_UI;
let EMBEDDING;

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

  PLUGIN = await import("../lib/index.js");
  CORE = await import("../lib/core.js");
  DB = await import("../lib/db.js");
  BOOKDELETE = await import("../lib/bookdelete.js");
  SYSTEM_TOOLS = await import("../lib/tools/system.js");
  WEB_UI = await import("../lib/web-ui.js");
  EMBEDDING = await import("../lib/embedding.js");
} catch (err) {
  restoreEnvAndCleanup();
  throw err;
}

// ===========================================================================
// 通用测试辅助与契约校验
// ===========================================================================

let libSeq = 0;
function freshLib(tag) {
  libSeq += 1;
  const root = join(TMP_BASE, `lib-${tag}-${libSeq}`);
  mkdirSync(join(root, "novels"), { recursive: true });
  return root;
}

function createHarness(root, extraConfig = {}) {
  const registry = [];
  const ctx = {
    tools: { register: (def) => { registry.push(def); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    inject: (_names, cb) => cb({ webServer: { register: () => () => {} }, effect: (fn) => fn() })
  };
  PLUGIN.apply(ctx, { root, sentenceAnalysis: { enabled: true, autoAnalyze: true }, allowLanState: false, ...extraConfig });
  const defs = Object.fromEntries(registry.map((d) => [d.name, d]));
  const exec = { agent: { session: { header: { cwd: root } } } };
  return { defs, exec };
}

function findRoute(routes, path) {
  const route = routes.find((r) => r && r.kind === "exact" && r.path === path);
  assert.ok(route, `应存在路由 ${path}`);
  return route;
}

function typeMatches(val, type) {
  if (type === "object") return val !== null && typeof val === "object" && !Array.isArray(val);
  if (type === "array") return Array.isArray(val);
  if (type === "null") return val === null;
  if (type === "string") return typeof val === "string";
  if (type === "boolean") return typeof val === "boolean";
  if (type === "integer") return Number.isInteger(val);
  if (type === "number") return typeof val === "number" && Number.isFinite(val);
  return true;
}

function assertOutputSchema(def, value, label) {
  const schema = def?.output?.schema;
  assert.ok(schema && schema.properties, `${label}: 缺少 output.schema`);
  const validateNode = (node, val, where) => {
    if (!node || typeof node !== "object") return;
    if (node.type) {
      assert.ok(typeMatches(val, node.type), `${where}: 期望 type=${node.type}，实际=${val === null ? "null" : typeof val}`);
    }
    if (Array.isArray(node.enum)) {
      assert.ok(node.enum.includes(val), `${where}: 值 ${JSON.stringify(val)} 不在 enum ${JSON.stringify(node.enum)} 中`);
    }
    if (node.type === "object" && val && typeof val === "object") {
      const props = node.properties || {};
      for (const req of node.required || []) {
        assert.ok(Object.prototype.hasOwnProperty.call(val, req), `${where}: 缺少必填键 ${req}`);
      }
      if (node.additionalProperties === false) {
        const extra = Object.keys(val).filter((k) => !Object.prototype.hasOwnProperty.call(props, k));
        assert.deepEqual(extra, [], `${where}: 出现未声明字段 ${JSON.stringify(extra)}`);
      }
      for (const [k, childSchema] of Object.entries(props)) {
        if (Object.prototype.hasOwnProperty.call(val, k) && val[k] !== void 0) {
          validateNode(childSchema, val[k], `${where}.${k}`);
        }
      }
    }
    if (node.type === "array" && Array.isArray(val) && node.items) {
      for (let i = 0; i < val.length; i += 1) {
        validateNode(node.items, val[i], `${where}[${i}]`);
      }
    }
  };
  validateNode(schema, value, label);
}

function readRawState() {
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function readRawSettings(root, book) {
  return JSON.parse(readFileSync(CORE.settingsFile(root, book), "utf8"));
}

function deterministicVec(seedText, dim = 128) {
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
// 1. 书库本地存储与遗留迁移清理 + readSettings / writeSettings 隔离保护
// ===========================================================================

test("1a. writeBookCreationProfile / POST /state / novel_sentence_config 统一落盘至 settings/<book>.json 并清理 state.json 遗留键", async () => {
  const root = freshLib("local-storage");
  const book = "星海";

  // 1) writeBookCreationProfile：迁移清理 state.json 中遗留的 creationProfiles["星海"]
  await CORE.writeSentenceState({ creationProfiles: { [book]: { worldview: "遗留旧设定" } } });
  assert.equal(readRawState().creationProfiles?.[book]?.worldview, "遗留旧设定");

  const written1 = await CORE.writeBookCreationProfile(root, book, {
    worldview: "星际联邦第一纪元",
    characters: "林舟：领航员",
    genre: "太空歌剧"
  });
  assert.deepEqual(written1, {
    worldview: "星际联邦第一纪元",
    characters: "林舟：领航员",
    genre: "太空歌剧"
  });
  assert.equal(existsSync(CORE.settingsFile(root, book)), true);
  assert.deepEqual(readRawSettings(root, book).creationProfile, written1);
  assert.equal(readRawState().creationProfiles?.[book], void 0, "迁移写入后应清理 state.json 中的遗留按书条目");

  // 2) POST /api/dsh-novel-writer/state：写入本地 settings/<book>.json、同步 .md 并清理遗留键
  await CORE.writeSentenceState({ creationProfiles: { [book]: { worldview: "二次遗留" } } });
  const routes = SYSTEM_TOOLS.buildUiRoutes({ root });
  const stateRoute = findRoute(routes, "/api/dsh-novel-writer/state");
  const postRes = await WEB_UI.invokeRouteInMemory(stateRoute, {
    method: "POST",
    body: {
      root,
      creationProfiles: {
        [book]: {
          worldview: "群星议会宇宙",
          characters: "林舟：跃迁舰长",
          mainConflict: "寻回星门密匙"
        }
      }
    }
  });
  assert.equal(postRes.status, 200);
  assert.equal(postRes.json?.creationProfiles?.[book]?.worldview, "群星议会宇宙");
  assert.equal(readRawSettings(root, book).creationProfile?.worldview, "群星议会宇宙");
  assert.equal(readRawState().creationProfiles?.[book], void 0, "POST /state 后不应残留 state.json.creationProfiles[book]");

  const bibleMdPath = join(CORE.creationDir(root, book), CORE.CREATION_FILES.bible);
  const mainCharMdPath = join(CORE.creationDir(root, book), CORE.CREATION_FILES["characters-main"]);
  assert.equal(existsSync(bibleMdPath), true);
  assert.equal(existsSync(mainCharMdPath), true);
  const bibleMd1 = readFileSync(bibleMdPath, "utf8");
  const mainCharMd1 = readFileSync(mainCharMdPath, "utf8");
  assert.ok(bibleMd1.includes("群星议会宇宙") && bibleMd1.includes("寻回星门密匙"));
  assert.ok(mainCharMd1.includes("林舟：跃迁舰长"));

  // 3) novel_sentence_config：工具侧 set creationProfiles 同样落盘本地并同步 .md
  await CORE.writeSentenceState({ creationProfiles: { [book]: { worldview: "三次遗留" } } });
  const { defs, exec } = createHarness(root);
  const cfgRes = await defs.novel_sentence_config.execute({
    action: "set",
    creationProfiles: {
      [book]: {
        worldview: "深空灯塔纪元",
        characters: "林舟与阿澈",
        extra: "硬核细节优先"
      }
    }
  }, exec);
  assertOutputSchema(defs.novel_sentence_config, cfgRes, "novel_sentence_config(set)");
  assert.equal(cfgRes.creationProfiles?.[book]?.worldview, "深空灯塔纪元");
  assert.equal(readRawSettings(root, book).creationProfile?.worldview, "深空灯塔纪元");
  assert.equal(readRawState().creationProfiles?.[book], void 0, "novel_sentence_config 后应清理 state.json 中的遗留条目");

  const bibleMd2 = readFileSync(bibleMdPath, "utf8");
  const mainCharMd2 = readFileSync(mainCharMdPath, "utf8");
  assert.ok(bibleMd2.includes("深空灯塔纪元") && bibleMd2.includes("硬核细节优先"));
  assert.ok(mainCharMd2.includes("林舟与阿澈"));
});

test("1b. readSettings 不泄漏 creationProfile；writeSettings 与 novel_settings 保留既有 creationProfile", async () => {
  const root = freshLib("settings-preserve");
  const book = "星海";
  const initialProfile = {
    worldview: "保留测试世界观",
    characters: "主角沈星",
    genre: "科幻悬疑"
  };
  await CORE.writeBookCreationProfile(root, book, initialProfile);

  const settingsView = await CORE.readSettings(root, book);
  assert.equal(Object.prototype.hasOwnProperty.call(settingsView, "creationProfile"), false, "readSettings 不得返回 creationProfile");
  assert.deepEqual(Object.keys(settingsView).sort(), ["characters", "items", "locations", "timeline", "worldview"]);

  // writeSettings 不含 creationProfile 时必须保留原 creationProfile
  await CORE.writeSettings(root, book, {
    ...settingsView,
    characters: [{ name: "沈星", description: "调查员" }]
  });
  let raw = readRawSettings(root, book);
  assert.deepEqual(raw.creationProfile, initialProfile, "writeSettings 未传 creationProfile 时必须保留现有设定");
  assert.equal(raw.characters.length, 1);

  // novel_settings add 不传 creationProfile 时同样保留原 creationProfile
  const { defs, exec } = createHarness(root);
  await defs.novel_settings.execute({
    book,
    category: "location",
    action: "add",
    name: "零号港",
    description: "星门停泊港",
    root
  }, exec);

  raw = readRawSettings(root, book);
  assert.deepEqual(raw.creationProfile, initialProfile, "novel_settings 修改设定表时必须保留既有 creationProfile");
  assert.equal(raw.characters.length, 1);
  assert.equal(raw.locations.length, 1);
  assert.equal(raw.locations[0].name, "零号港");
});

// ===========================================================================
// 2. 双书库隔离：同书名在 libA 与 libB 各自独立
// ===========================================================================

test("2. 双书库隔离：同名书籍「同书名」在 libA 与 libB 持有独立 creationProfile 且互不干扰", async () => {
  const libA = freshLib("iso-A");
  const libB = freshLib("iso-B");
  const sameBook = "同书名";

  await CORE.writeBookCreationProfile(libA, sameBook, {
    worldview: "A库古典仙侠",
    genre: "修仙",
    characters: "李青云"
  });
  await CORE.writeBookCreationProfile(libB, sameBook, {
    worldview: "B库赛博矩阵",
    genre: "系统流",
    characters: "零号骇客"
  });

  const readA = await CORE.readBookCreationProfile(libA, sameBook);
  const readB = await CORE.readBookCreationProfile(libB, sameBook);
  assert.equal(readA.worldview, "A库古典仙侠");
  assert.equal(readB.worldview, "B库赛博矩阵");

  const syncA = CORE.readBookCreationProfileSync(libA, sameBook);
  const syncB = CORE.readBookCreationProfileSync(libB, sameBook);
  assert.equal(syncA.characters, "李青云");
  assert.equal(syncB.characters, "零号骇客");

  const listA = await CORE.listBookCreationProfiles(libA);
  const listB = await CORE.listBookCreationProfiles(libB);
  assert.equal(listA[sameBook]?.genre, "修仙");
  assert.equal(listB[sameBook]?.genre, "系统流");

  // HTTP GET /state?root= 同样隔离
  const routes = SYSTEM_TOOLS.buildUiRoutes({});
  const stateRoute = findRoute(routes, "/api/dsh-novel-writer/state");
  const httpA = await WEB_UI.invokeRouteInMemory(stateRoute, {
    method: "GET",
    url: `${stateRoute.path}?root=${encodeURIComponent(libA)}`
  });
  const httpB = await WEB_UI.invokeRouteInMemory(stateRoute, {
    method: "GET",
    url: `${stateRoute.path}?root=${encodeURIComponent(libB)}`
  });
  assert.equal(httpA.status, 200);
  assert.equal(httpB.status, 200);
  assert.equal(httpA.json?.creationProfiles?.[sameBook]?.worldview, "A库古典仙侠");
  assert.equal(httpB.json?.creationProfiles?.[sameBook]?.worldview, "B库赛博矩阵");

  // 清空 libA 的设定绝不能影响 libB
  await CORE.writeBookCreationProfile(libA, sameBook, null);
  assert.equal(await CORE.readBookCreationProfile(libA, sameBook, { fallbackGlobal: false }), null);
  assert.equal((await CORE.readBookCreationProfile(libB, sameBook, { fallbackGlobal: false }))?.worldview, "B库赛博矩阵");
});

// ===========================================================================
// 3. 优先级与回退 + 清除不留空壳
// ===========================================================================

test("3. 优先级链（书库本地 > state.creationProfiles[book] > 全局 creationProfile）与安全清除", async () => {
  const root = freshLib("precedence");

  // 种子：全局 + 遗留按书
  await CORE.writeSentenceState({
    creationProfile: { worldview: "全局世界观", genre: "全局题材" },
    creationProfiles: {
      "三层覆盖书": { worldview: "旧state按书", genre: "旧按书题材" },
      "仅旧state书": { worldview: "仅旧按书", genre: "旧按书题材2" }
    }
  });

  // 为「三层覆盖书」写入书库本地 settings/<book>.json（直接写盘以保留 state.json 中的遗留键用于测试优先级）
  mkdirSync(dirname(CORE.settingsFile(root, "三层覆盖书")), { recursive: true });
  writeFileSync(CORE.settingsFile(root, "三层覆盖书"), JSON.stringify({
    book: "三层覆盖书",
    characters: [],
    locations: [],
    items: [],
    timeline: [],
    worldview: [],
    creationProfile: { worldview: "书库本地世界观", genre: "本地题材" }
  }, null, 2), "utf8");

  // 1) 三层优先级校验（异步 + 同步双口径）
  assert.equal((await CORE.readBookCreationProfile(root, "三层覆盖书", { fallbackGlobal: true }))?.worldview, "书库本地世界观");
  assert.equal(CORE.readBookCreationProfileSync(root, "三层覆盖书", { fallbackGlobal: true })?.worldview, "书库本地世界观");

  assert.equal((await CORE.readBookCreationProfile(root, "仅旧state书", { fallbackGlobal: true }))?.worldview, "仅旧按书");
  assert.equal(CORE.readBookCreationProfileSync(root, "仅旧state书", { fallbackGlobal: true })?.worldview, "仅旧按书");

  assert.equal((await CORE.readBookCreationProfile(root, "无专属书", { fallbackGlobal: true }))?.worldview, "全局世界观");
  assert.equal(CORE.readBookCreationProfileSync(root, "无专属书", { fallbackGlobal: true })?.worldview, "全局世界观");
  assert.equal(await CORE.readBookCreationProfile(root, "无专属书", { fallbackGlobal: false }), null);

  // 2) 清除不存在设定：绝不生成空的 settings/<book>.json
  const missingBook = "从未建立设定的书";
  const clearMissingRes = await CORE.writeBookCreationProfile(root, missingBook, null);
  assert.equal(clearMissingRes, null);
  assert.equal(existsSync(CORE.settingsFile(root, missingBook)), false, "清除不存在的按书设定绝不能创建空 settings 文件");

  // 3) 清除已有书库本地设定：清理本地 creationProfile + 遗留键，并保留既有五表与正常回退全局
  const clearTarget = "带五表待清除书";
  await CORE.writeSettings(root, clearTarget, {
    characters: [{ name: "韩立", description: "修士" }],
    locations: [],
    items: [],
    timeline: [],
    worldview: []
  });
  await CORE.writeBookCreationProfile(root, clearTarget, { worldview: "临时本地设定" });
  assert.equal((await CORE.readBookCreationProfile(root, clearTarget, { fallbackGlobal: false }))?.worldview, "临时本地设定");

  await CORE.writeBookCreationProfile(root, clearTarget, null);
  const rawAfterClear = readRawSettings(root, clearTarget);
  assert.equal(Object.prototype.hasOwnProperty.call(rawAfterClear, "creationProfile"), false);
  assert.equal(rawAfterClear.characters.length, 1);
  assert.equal(await CORE.readBookCreationProfile(root, clearTarget, { fallbackGlobal: false }), null);
  assert.equal((await CORE.readBookCreationProfile(root, clearTarget, { fallbackGlobal: true }))?.worldview, "全局世界观");

  // 4) POST /state 清除空设定书时同步清理空壳创作资料目录
  const syncClearBook = "同步清除资料书";
  const routes = SYSTEM_TOOLS.buildUiRoutes({ root });
  const stateRoute = findRoute(routes, "/api/dsh-novel-writer/state");
  await WEB_UI.invokeRouteInMemory(stateRoute, {
    method: "POST",
    body: { root, creationProfiles: { [syncClearBook]: { worldview: "待清世界观", characters: "待清角色" } } }
  });
  assert.equal(existsSync(CORE.creationDir(root, syncClearBook)), true);
  await WEB_UI.invokeRouteInMemory(stateRoute, {
    method: "POST",
    body: { root, creationProfiles: { [syncClearBook]: null } }
  });
  assert.equal(existsSync(CORE.creationDir(root, syncClearBook)), false, "清除空壳创作资料后应自动清理空目录");

  // 清理全局设定，避免影响后续测试
  await CORE.writeSentenceState({ creationProfile: null, creationProfiles: null });
});

// ===========================================================================
// 4. 端到端工具消费：novel_outline init 与 novel_chapter_brief
// ===========================================================================

test("4a. novel_outline init 端到端消费书库本地 settings/<book>.json 的 creationProfile", async () => {
  const libA = freshLib("tool-outline-A");
  const libB = freshLib("tool-outline-B");
  const book = "大纲联动书";

  // 放置干扰项：全局 creationProfile 与 libB 同名书设定
  await CORE.writeSentenceState({
    creationProfile: { worldview: "全局干扰设定_DO_NOT_USE", characters: "全局干扰角色" }
  });
  await CORE.writeBookCreationProfile(libB, book, {
    worldview: "B库干扰设定_DO_NOT_USE",
    characters: "B库干扰角色"
  });
  await CORE.writeBookCreationProfile(libA, book, {
    worldview: "蒸汽浮空城纪元",
    characters: "苏青：机械师",
    forbidden: "禁止现代枪械",
    mainConflict: "寻回天穹核心蓝图",
    genre: "蒸汽奇幻",
    extra: "强化齿轮与铜管意象"
  });

  const { defs, exec } = createHarness(libA);
  const initRes = await defs.novel_outline.execute({ book, action: "init", root: libA }, exec);
  assertOutputSchema(defs.novel_outline, initRes, "novel_outline(init)");

  const bibleText = readFileSync(join(CORE.creationDir(libA, book), CORE.CREATION_FILES.bible), "utf8");
  const charText = readFileSync(join(CORE.creationDir(libA, book), CORE.CREATION_FILES["characters-main"]), "utf8");

  assert.ok(bibleText.includes("蒸汽浮空城纪元"));
  assert.ok(bibleText.includes("禁止现代枪械"));
  assert.ok(bibleText.includes("寻回天穹核心蓝图"));
  assert.ok(bibleText.includes("蒸汽奇幻"));
  assert.ok(bibleText.includes("强化齿轮与铜管意象"));
  assert.equal(bibleText.includes("DO_NOT_USE"), false, "绝不能读取全局或其它书库的 creationProfile");
  assert.ok(charText.includes("苏青：机械师"));
  assert.equal(charText.includes("DO_NOT_USE"), false);

  await CORE.writeSentenceState({ creationProfile: null, creationProfiles: null });
});

test("4b. novel_chapter_brief 端到端按书库隔离消费书库本地 creationProfile（系统流静音 stat_numeric）", async () => {
  const libA = freshLib("tool-brief-A");
  const libB = freshLib("tool-brief-B");
  const book = "流派验证书";

  // 确认 state.json 不含任何 creationProfile(s)
  await CORE.writeSentenceState({ creationProfile: null, creationProfiles: null });

  const cleanChapter = (n) => [
    `# 第0${n}章 旅途见闻`,
    "",
    `清晨薄雾未散，石板路边摊贩摆开竹筐，第${n}队商旅牵着骡马缓缓走过长街。`,
    "阿澈握紧包袱里的旧木牌，沿着青石台阶走上山坡，看见山门前的古松投下长长影子。",
    "远处钟声传遍山谷，他把木牌放回怀里，迈步走过石桥。"
  ].join("\n");

  // 第 4 章包含 8 条互不重复的 stat_numeric 规则命中（每条仅出现 1 次，避免习惯词豁免误静音）
  const statHeavyChapter4 = [
    "# 第04章 测试进阶",
    "",
    "石室中央的灯盏亮起，他感觉力量增强了十倍，奔跑速度达到了99%，力道发挥出百分之八十。",
    "此刻战斗力达到顶峰，视线角落的属性面板亮起微光，体内灵气飙升了三成，耐力数值增加了五点，境界突破三重。",
    "他伸手推开石门，迈步走进下一座石殿。"
  ].join("\n");

  for (const lib of [libA, libB]) {
    const dir = join(lib, "novels", book);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "第01章.md"), cleanChapter(1), "utf8");
    writeFileSync(join(dir, "第02章.md"), cleanChapter(2), "utf8");
    writeFileSync(join(dir, "第03章.md"), cleanChapter(3), "utf8");
    writeFileSync(join(dir, "第04章.md"), statHeavyChapter4, "utf8");
  }

  // libA 设为系统流（自动静音 stat_numeric）；libB 设为传统武侠（不静音 stat_numeric）
  await CORE.writeBookCreationProfile(libA, book, {
    genre: "系统流",
    worldview: "高武数据面板系统流"
  });
  await CORE.writeBookCreationProfile(libB, book, {
    genre: "写实武侠",
    worldview: "传统江湖写实"
  });

  const harnessA = createHarness(libA);
  const harnessB = createHarness(libB);

  const briefA = await harnessA.defs.novel_chapter_brief.execute({ book, chapter: "next", root: libA }, harnessA.exec);
  const briefB = await harnessB.defs.novel_chapter_brief.execute({ book, chapter: "next", root: libB }, harnessB.exec);
  assertOutputSchema(harnessA.defs.novel_chapter_brief, briefA, "novel_chapter_brief(libA)");
  assertOutputSchema(harnessB.defs.novel_chapter_brief, briefB, "novel_chapter_brief(libB)");

  const slopIssueB = (briefB.prevChapterIssues || []).find((it) => it.key === "slop");
  assert.ok(slopIssueB, "libB 非系统流应检出第 4 章的 stat_numeric 套话问题");
  const slopPrescB = (briefB.symptomPrescriptions || []).find((it) => it.key === "slop");
  assert.ok(slopPrescB && (slopPrescB.text.includes("数值") || slopPrescB.text.includes("倍数")), "libB 应生成数值播报套话处方");

  const slopIssueA = (briefA.prevChapterIssues || []).find((it) => it.key === "slop");
  assert.equal(slopIssueA, void 0, "libA 读取书库本地系统流 creationProfile 后应静音 stat_numeric");
  const slopPrescA = (briefA.symptomPrescriptions || []).find((it) => it.key === "slop" && (it.text.includes("数值") || it.text.includes("倍数")));
  assert.equal(slopPrescA, void 0, "libA 不得生成 stat_numeric 套话处方");
});

// ===========================================================================
// 5. 回收站删书与恢复 + purgeBookCache 联动
// ===========================================================================

test("5. 回收站删书与恢复 + purgeBookCache：移走并恢复 settings/<book>.json 含 creationProfile，且只清理本书 SQLite 缓存", async () => {
  const root = freshLib("trash-purge");
  const targetBook = "待删之书";
  const siblingBook = "保留之书";

  const targetProfile = {
    worldview: "待删书本地世界观",
    characters: "林夜：剑客",
    genre: "东方玄幻"
  };
  const siblingProfile = {
    worldview: "保留书本地世界观",
    characters: "陈风：医者",
    genre: "历史悬疑"
  };

  for (const [b, prof] of [[targetBook, targetProfile], [siblingBook, siblingProfile]]) {
    const dir = join(root, "novels", b);
    mkdirSync(dir, { recursive: true });
    const text = `# 第一章 开端\n\n${b}的清晨安静而湿润，青石街尽头传来一阵清脆的铜铃声，他提灯走入长巷。\n`;
    writeFileSync(join(dir, "第01章.md"), text, "utf8");

    await CORE.writeBookCreationProfile(root, b, prof);
    await CORE.writeSettings(root, b, {
      characters: [{ name: `${b}角色`, description: "主要人物" }],
      locations: [],
      items: [],
      timeline: [],
      worldview: []
    });

    await CORE.metricChaptersCached(root, b, [{ file: "第01章.md", text }]);
    await CORE.bookAnalysisCached(root, b, text, { features: { genreTheme: false } });
    EMBEDDING.saveIndex(root, b, [
      { id: "c1#0", chapter: "第01章.md", offset: 0, text: `${b}首段语义分块正文样本。`, vec: deterministicVec(b, 128) }
    ]);
  }

  // 确认删前两本书的 SQLite 缓存均存在
  assert.equal(DB.readChapterMetrics(root, targetBook, { readOnly: true }).rows.length, 1);
  assert.equal(DB.readChapterMetrics(root, siblingBook, { readOnly: true }).rows.length, 1);
  assert.notEqual(DB.readAnalysisCache(root, `book_full:${targetBook}`, { readOnly: true }), null);
  assert.notEqual(DB.readAnalysisCache(root, `book_full:${siblingBook}`, { readOnly: true }), null);
  assert.notEqual(DB.readEmbeddingIndex(root, targetBook, { readOnly: true }), null);
  assert.notEqual(DB.readEmbeddingIndex(root, siblingBook, { readOnly: true }), null);

  // 执行删书（移入回收站 + purgeBookCache）
  const delRes = await BOOKDELETE.applyBookDelete({ root, book: targetBook });
  assert.ok(delRes.trashId !== "", "应生成有效回收站条目");
  assert.equal(existsSync(CORE.settingsFile(root, targetBook)), false, "settings/待删之书.json 应已移入回收站");
  assert.equal(existsSync(CORE.settingsFile(root, siblingBook)), true, "保留之书的 settings 绝不能被误删");

  // 验证回收站内的 settings/<book>.json 仍完整保留 creationProfile
  const trashedSettings = join(delRes.trashDir, ".novel-writer", "settings", `${targetBook}.json`);
  assert.equal(existsSync(trashedSettings), true);
  assert.deepEqual(JSON.parse(readFileSync(trashedSettings, "utf8")).creationProfile, targetProfile);

  // 验证 cache.sqlite 中仅清除了 targetBook 的行，siblingBook 完好无损
  assert.equal(DB.readChapterMetrics(root, targetBook, { readOnly: true }).rows.length, 0);
  assert.equal(DB.readAnalysisCache(root, `book_full:${targetBook}`, { readOnly: true }), null);
  assert.equal(DB.readEmbeddingIndex(root, targetBook, { readOnly: true }), null);

  assert.equal(DB.readChapterMetrics(root, siblingBook, { readOnly: true }).rows.length, 1);
  assert.notEqual(DB.readAnalysisCache(root, `book_full:${siblingBook}`, { readOnly: true }), null);
  assert.notEqual(DB.readEmbeddingIndex(root, siblingBook, { readOnly: true }), null);

  // 恢复回收站：settings/<book>.json 与 creationProfile 原样归位
  const restoreRes = await BOOKDELETE.restoreTrash({ root, trashId: delRes.trashId });
  assert.ok(restoreRes.restored > 0);
  assert.equal(existsSync(CORE.settingsFile(root, targetBook)), true, "恢复后 settings/待删之书.json 必须归位");
  assert.equal(existsSync(join(root, "novels", targetBook, "第01章.md")), true, "恢复后章节正文必须归位");
  assert.deepEqual(
    await CORE.readBookCreationProfile(root, targetBook, { fallbackGlobal: false }),
    targetProfile,
    "恢复后书库本地 creationProfile 必须完好无损"
  );
  const restoredSettings = await CORE.readSettings(root, targetBook);
  assert.equal(restoredSettings.characters.length, 1);
  assert.equal(restoredSettings.characters[0].name, `${targetBook}角色`);
});

// ===========================================================================
// 6. 隔离守卫
// ===========================================================================

test("6. 隔离守卫：用户真实 ~/.dsh/dsh-novel-writer/ 目录全程未被修改", () => {
  const realAfter = digestTree(REAL_DSH_DIR);
  assert.deepEqual(realAfter, realBefore, "测试全程绝不能改动用户真实 ~/.dsh/dsh-novel-writer/ 目录");
});
