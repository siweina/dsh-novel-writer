/**
 * test/genre-packs-test.mjs —— v7.5.0 外置 JSON 题材规则包自动化回归套件（第 41 个测试套件）
 *
 * 覆盖范围：
 *   1. 5 套内置题材包（western-fantasy / eastern-xianxia / modern-urban / mystery-thriller / scifi-cyberpunk）：
 *      listPacks、全量正则 validatePattern()、别名解析、allowWords 豁免「修士」、slopMuteCategories=["stat_numeric"] 与禁词
 *   2. resolveStyleRule 兼容性与优先级：无 pack / 无按书文件同构性、worldview.pack 生效、cultureSource="pack"、bannedWords=[] 清空
 *   3. 热加载、自定义覆盖、extends 继承（含循环继承 A→B→A 与 >2 层截断）
 *   4. 安全边界与正则防护：isValidPackId 越界拦截、ReDoS (a+)+ 剔除、>256KB 与坏 JSON 金丝雀零泄漏、junction/symlink 越界逃逸拒绝
 *   5. 全工具联动与删书隔离：novel_settings(packs/add/update/非法拦截)、novel_continuity_check、novel_chapter_brief、
 *      novel_style_check、novel_fix_plan、novel_diagnose(损坏检出且无金丝雀泄漏)、novel_delete_book(9 类按书数据清理而 packs/ 完好无损)
 *   6. 隔离守卫：~/.dsh/dsh-novel-writer/ 真实目录哈希全程一致
 *
 * 运行：node test/genre-packs-test.mjs
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
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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

const TMP_BASE = realpathSync.native(mkdtempSync(join(tmpdir(), "dsh-genre-packs-" + process.pid + "-")));
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
let PACKS;
let SLOP;
let BOOKDELETE;
let DIAGNOSE;

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
  PACKS = await import("../lib/packs.js");
  SLOP = await import("../lib/lexicons/slop.js");
  BOOKDELETE = await import("../lib/bookdelete.js");
  DIAGNOSE = await import("../lib/diagnose.js");
} catch (err) {
  restoreEnvAndCleanup();
  throw err;
}

// ===========================================================================
// 通用夹具与契约校验
// ===========================================================================

let libSeq = 0;
async function withLib(tag, fn) {
  libSeq += 1;
  const root = join(TMP_BASE, `lib-${tag}-${libSeq}`);
  mkdirSync(join(root, "novels"), { recursive: true });
  try {
    return await fn(root);
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* 忽略子夹具清理异常，外层 TMP_BASE exit/after 会兜底 */
    }
  }
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

function renderText(def, args, value) {
  const rendered = def.output.render(args, value);
  assert.ok(Array.isArray(rendered) && rendered.length > 0, `${def.name}.output.render 必须返回非空数组`);
  for (const item of rendered) {
    assert.equal(item.type, "text");
    assert.equal(typeof item.text, "string");
  }
  return rendered.map((x) => x.text).join("\n");
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

// ===========================================================================
// 1. 5 套内置题材包验证
// ===========================================================================

test("1. 内置 5 套题材包：listPacks、全量正则安全校验、别名解析、allowWords 与 slopMuteCategories", async () => {
  await withLib("builtin-packs", async (root) => {
    const listed = PACKS.listPacks(root);
    assert.deepEqual(listed.errors, [], "内置包不应有任何解析错误");
    assert.deepEqual(listed.warnings, [], "内置包不应有任何安全告警");
    const ids = listed.packs.map((p) => p.id).sort();
    assert.deepEqual(ids, [...PACKS.BUILTIN_PACK_IDS].sort(), "应精确包含 5 套内置题材包");
    assert.equal(ids.length, 5);

    for (const pack of listed.packs) {
      assert.equal(pack.source, "builtin");
      const patterns = pack.speechStyle?.ritualBadPatterns || [];
      for (const pat of patterns) {
        const verdict = CORE.validatePattern(pat);
        assert.equal(verdict.ok, true, `内置包 ${pack.id} 仪式正则 /${pat}/ 未通过 validatePattern: ${verdict.reason}`);
      }
    }

    // 别名解析（含大小写无关）
    assert.equal(PACKS.loadPack("古风", root)?.id, "eastern-xianxia");
    assert.equal(PACKS.loadPack("仙侠", root)?.id, "eastern-xianxia");
    assert.equal(PACKS.loadPack("赛博朋克", root)?.id, "scifi-cyberpunk");
    assert.equal(PACKS.loadPack("系统流", root)?.id, "scifi-cyberpunk");
    assert.equal(PACKS.loadPack("SCIFI", root)?.id, "scifi-cyberpunk");
    assert.equal(PACKS.loadPack("西幻", root)?.id, "western-fantasy");
    assert.equal(PACKS.loadPack("都市", root)?.id, "modern-urban");
    assert.equal(PACKS.loadPack("悬疑", root)?.id, "mystery-thriller");

    // eastern-xianxia：allowWords 含「修士」，且对含「修士」的正文不误报禁词
    const xianxia = PACKS.loadPack("eastern-xianxia", root);
    assert.ok(xianxia.allowWords.includes("修士"), "eastern-xianxia 默认 allowWords 应包含「修士」");
    const xianxiaRule = CORE.resolveStyleRule(
      { worldview: [{ name: "仙侠", pack: "eastern-xianxia", bannedWords: ["修士", "教堂"] }] },
      [],
      { root, book: "仙侠测试" }
    );
    assert.equal(xianxiaRule.bannedWords.includes("修士"), false, "「修士」应被 eastern-xianxia allowWords 静音豁免");
    assert.equal(xianxiaRule.bannedWords.includes("教堂"), true, "非豁免禁词「教堂」仍应保留");

    const xBookDir = join(root, "novels", "修仙误报验证");
    mkdirSync(xBookDir, { recursive: true });
    writeFileSync(
      join(xBookDir, "第01章.md"),
      "山门外的石阶上，几位年轻修士手托灵石与古朴法器，沿着石路缓缓行礼。\n",
      "utf8"
    );
    const { defs, exec } = createHarness(root);
    await defs.novel_settings.execute({
      book: "修仙误报验证",
      category: "worldview",
      action: "add",
      name: "修仙界",
      pack: "eastern-xianxia",
      root
    }, exec);
    const contXianxia = await defs.novel_continuity_check.execute({ book: "修仙误报验证", root }, exec);
    assert.equal(
      contXianxia.candidates.some((c) => c.type === "用语冲突" && c.word === "修士"),
      false,
      "eastern-xianxia 对含「修士」的正文绝不能误报禁词"
    );

    // scifi-cyberpunk：slopMuteCategories=["stat_numeric"] 且禁用 衙门/客栈/银两
    const scifi = PACKS.loadPack("scifi-cyberpunk", root);
    assert.deepEqual(scifi.slopMuteCategories, ["stat_numeric"]);
    assert.ok(scifi.bannedWords.includes("衙门"));
    assert.ok(scifi.bannedWords.includes("客栈"));
    assert.ok(scifi.bannedWords.includes("银两"));

    // buildSlopExemptions 直接联动验证：传 pack 或 extraMuteCategories 均可静音 stat_numeric
    const statProbe = "他的战斗力达到999点，力量提升了50%，速度暴涨了3倍。";
    const plainSlop = SLOP.scanSlop(statProbe, SLOP.buildSlopExemptions("", {}));
    assert.ok(plainSlop.byCategory.stat_numeric > 0, "前置条件：无豁免时应命中 stat_numeric");
    const exByPack = SLOP.buildSlopExemptions("", { pack: scifi });
    assert.ok(exByPack.muteCategories.includes("stat_numeric"), "buildSlopExemptions({ pack }) 应将 stat_numeric 加入 muteCategories");
    assert.equal(SLOP.scanSlop(statProbe, exByPack).total, 0, "使用 pack 豁免后 stat_numeric 应归零");
    const exByExtra = SLOP.buildSlopExemptions("", { extraMuteCategories: scifi.slopMuteCategories });
    assert.ok(exByExtra.muteCategories.includes("stat_numeric"));
  });
});

// ===========================================================================
// 2. resolveStyleRule 兼容性与优先级
// ===========================================================================

test("2. resolveStyleRule：未配 pack 逐字同构兼容 + worldview.pack 优先级 + bannedWords=[] 清空", async () => {
  await withLib("resolve-compat", async (root) => {
    const samples = [
      { name: "空设定+默认", settings: {}, texts: [] },
      { name: "空设定+中式正文", settings: {}, texts: ["老夫捋着胡须去客栈喝茶，又吩咐丫鬟上了三炷香。"] },
      { name: "空设定+西式正文", settings: {}, texts: ["骑士走过城堡，教堂的牧师与公爵在庄园里举行弥撒。"] },
      { name: "显式欧式设定", settings: { worldview: [{ name: "西幻", basis: "西方/欧式中世纪", bannedWords: ["老爷"] }] }, texts: [] },
      { name: "显式空禁词数组", settings: { worldview: [{ name: "免检", basis: "欧式中世纪", bannedWords: [] }] }, texts: [] }
    ];
    for (const s of samples) {
      const legacyCall = CORE.resolveStyleRule(s.settings, s.texts);
      const packAwareCall = CORE.resolveStyleRule(s.settings, s.texts, { root, book: "无包书" });
      assert.deepEqual(packAwareCall, legacyCall, `${s.name}: 未配 pack 且无按书文件时返回值必须逐字一致`);
      assert.equal("pack" in packAwareCall, false, `${s.name}: 无包时不得返回 pack 字段`);
    }

    // worldview.pack 生效且未显式 basis 时：cultureSource === "pack"，返回 pack 元信息
    const rPack = CORE.resolveStyleRule(
      { worldview: [{ name: "赛博", pack: "scifi-cyberpunk" }] },
      ["骑士在教堂里走来走去，旁边是城堡与修道院。"],
      { root, book: "赛博书" }
    );
    assert.equal(rPack.culture, "modern");
    assert.equal(rPack.cultureSource, "pack");
    assert.deepEqual(rPack.pack, {
      id: "scifi-cyberpunk",
      name: "科幻赛博",
      source: "builtin",
      baseCulture: "modern",
      slopMuteCategories: ["stat_numeric"]
    });
    assert.ok(rPack.bannedWords.includes("衙门"));
    assert.ok(rPack.bannedWords.includes("客栈"));

    // 显式 basis 优先于 pack.baseCulture；但 pack 仍保留元信息
    const rBasisOverride = CORE.resolveStyleRule(
      { worldview: [{ name: "西幻赛博", basis: "西方/欧式中世纪", pack: "scifi-cyberpunk" }] },
      [],
      { root, book: "混合" }
    );
    assert.equal(rBasisOverride.culture, "western");
    assert.equal(rBasisOverride.cultureSource, "worldview");
    assert.equal(rBasisOverride.pack.id, "scifi-cyberpunk");

    // 用户 bannedWords: [] 仍可清空默认禁用词与包禁用词
    const rClear = CORE.resolveStyleRule(
      { worldview: [{ name: "赛博", pack: "scifi-cyberpunk", bannedWords: [] }] },
      [],
      { root, book: "赛博清空" }
    );
    assert.equal(rClear.defaultEnabled, false);
    assert.deepEqual(rClear.bannedWords, []);
    assert.equal(rClear.pack.id, "scifi-cyberpunk");

    // 按书文件 <root>/.novel-writer/packs/<书>.json 自动激活，且显式 worldview.pack 优先级更高
    const pDir = PACKS.packsDir(root);
    mkdirSync(pDir, { recursive: true });
    writeFileSync(join(pDir, "自动绑定书.json"), JSON.stringify({
      id: "auto-book-pack",
      name: "按书自动包",
      baseCulture: "modern",
      bannedWords: ["按书禁词"]
    }), "utf8");
    const rAutoBook = CORE.resolveStyleRule({}, [], { root, book: "自动绑定书" });
    assert.equal(rAutoBook.cultureSource, "pack");
    assert.equal(rAutoBook.pack?.id, "auto-book-pack");
    assert.ok(rAutoBook.bannedWords.includes("按书禁词"));

    const rExplicitOverride = CORE.resolveStyleRule(
      { worldview: [{ name: "覆盖", pack: "eastern-xianxia" }] },
      [],
      { root, book: "自动绑定书" }
    );
    assert.equal(rExplicitOverride.pack?.id, "eastern-xianxia", "worldview.pack 优先级应高于按书文件");
    assert.equal(rExplicitOverride.culture, "eastern");
  });
});

// ===========================================================================
// 3. 热加载、自定义覆盖、extends 继承（含循环继承与超深截断）
// ===========================================================================

test("3. 热加载、自定义覆写、extends 继承、循环继承与 >2 层继承截断", async () => {
  await withLib("hot-reload-extends", async (root) => {
    const pDir = PACKS.packsDir(root);
    mkdirSync(pDir, { recursive: true });

    // 新增自定义继承包 cyber-custom (extends: "scifi-cyberpunk")
    const customPath = join(pDir, "cyber-custom.json");
    writeFileSync(customPath, JSON.stringify({
      id: "cyber-custom",
      name: "赛博修真混合包",
      extends: "scifi-cyberpunk",
      aliases: ["cyber-custom-alias"],
      bannedWords: ["灵丹", "天劫"],
      recommended: { "银两": "数字信用点" },
      allowWords: ["客栈"]
    }, null, 2), "utf8");

    // 覆写内置 western-fantasy.json
    writeFileSync(join(pDir, "western-fantasy.json"), JSON.stringify({
      id: "western-fantasy",
      name: "自定义欧式奇幻",
      baseCulture: "western",
      bannedWords: ["自定义禁词甲"],
      recommended: { "自定义禁词甲": "替词" }
    }, null, 2), "utf8");

    const listed1 = PACKS.listPacks(root);
    assert.ok(listed1.packs.some((p) => p.id === "cyber-custom" && p.source === "custom"));
    const custom1 = PACKS.loadPack("cyber-custom", root);
    assert.equal(custom1.baseCulture, "modern", "应继承 scifi-cyberpunk 的 baseCulture");
    assert.deepEqual(custom1.slopMuteCategories, ["stat_numeric"], "应继承 stat_numeric 静音");
    assert.ok(custom1.bannedWords.includes("衙门") && custom1.bannedWords.includes("灵丹"));
    assert.equal(custom1.recommended["银两"], "数字信用点", "子包 recommended 应覆盖父包");
    assert.ok(custom1.allowWords.includes("客栈"));

    const wfOverridden = PACKS.loadPack("western-fantasy", root);
    assert.equal(wfOverridden.source, "custom");
    assert.equal(wfOverridden.name, "自定义欧式奇幻");
    assert.deepEqual(wfOverridden.bannedWords, ["自定义禁词甲"]);

    // 热加载修改刷新：改内容并更新时间戳
    writeFileSync(customPath, JSON.stringify({
      id: "cyber-custom",
      name: "赛博修真混合包v2",
      extends: "scifi-cyberpunk",
      bannedWords: ["灵丹", "神符"],
      recommended: { "银两": "电子星币" }
    }, null, 2), "utf8");
    const tFuture = new Date(Date.now() + 5000);
    utimesSync(customPath, tFuture, tFuture);

    const custom2 = PACKS.loadPack("cyber-custom", root);
    assert.equal(custom2.name, "赛博修真混合包v2");
    assert.ok(custom2.bannedWords.includes("神符"));
    assert.equal(custom2.recommended["银两"], "电子星币");

    // 循环继承（A -> B -> A）与 >2 层继承链（L3 -> L2 -> L1 -> L0）
    writeFileSync(join(pDir, "cycle-a.json"), JSON.stringify({ id: "cycle-a", extends: "cycle-b", bannedWords: ["环词甲"] }), "utf8");
    writeFileSync(join(pDir, "cycle-b.json"), JSON.stringify({ id: "cycle-b", extends: "cycle-a", bannedWords: ["环词乙"] }), "utf8");

    writeFileSync(join(pDir, "chain-0.json"), JSON.stringify({ id: "chain-0", baseCulture: "eastern", bannedWords: ["零层禁词"] }), "utf8");
    writeFileSync(join(pDir, "chain-1.json"), JSON.stringify({ id: "chain-1", extends: "chain-0", bannedWords: ["一层禁词"] }), "utf8");
    writeFileSync(join(pDir, "chain-2.json"), JSON.stringify({ id: "chain-2", extends: "chain-1", bannedWords: ["二层禁词"] }), "utf8");
    writeFileSync(join(pDir, "chain-3.json"), JSON.stringify({ id: "chain-3", extends: "chain-2", bannedWords: ["三层禁词"] }), "utf8");

    const listedCycle = PACKS.listPacks(root);
    assert.ok(
      listedCycle.warnings.some((w) => w.reason.includes("循环继承")),
      "循环继承应安全打断并在 warnings 中记录"
    );
    assert.ok(
      listedCycle.warnings.some((w) => w.reason.includes("超过 2 层")),
      "超过 2 层继承应安全截断并在 warnings 中记录"
    );

    const cyA = PACKS.loadPack("cycle-a", root);
    assert.ok(cyA && cyA.bannedWords.includes("环词甲") && cyA.bannedWords.includes("环词乙"));
    const ch3 = PACKS.loadPack("chain-3", root);
    assert.ok(ch3 && ch3.bannedWords.includes("三层禁词") && ch3.bannedWords.includes("二层禁词") && ch3.bannedWords.includes("一层禁词"));
    assert.equal(ch3.bannedWords.includes("零层禁词"), false, "第 3 层祖先应在 PACK_MAX_EXTENDS_DEPTH=2 处截断");
  });
});

// ===========================================================================
// 4. 安全边界与正则防护
// ===========================================================================

test("4. 安全边界：isValidPackId / ReDoS 剔除 / 超大包与坏 JSON 金丝雀零泄漏 / junction 越界拒绝", async () => {
  await withLib("security-boundaries", async (root) => {
    // 4a. isValidPackId
    for (const badId of ["../evil", "a/b", "a\\b", "", "a".repeat(65), "..", ".", "a..b", "bad id"]) {
      assert.equal(PACKS.isValidPackId(badId), false, `非法 packId 应被拦截: ${JSON.stringify(badId)}`);
    }
    for (const goodId of ["western-fantasy", "scifi_v2", "中式_自定义-01"]) {
      assert.equal(PACKS.isValidPackId(goodId), true, `合法 packId 应放行: ${goodId}`);
    }

    const pDir = PACKS.packsDir(root);
    mkdirSync(pDir, { recursive: true });

    // 4b. ReDoS 危险模式剔除（含 rejectedPatterns 透出；干净包无该字段）
    const cleanBuiltin = PACKS.loadPack("western-fantasy", root);
    assert.equal("rejectedPatterns" in cleanBuiltin, false, "干净内置包不应返回 rejectedPatterns 字段");

    writeFileSync(join(pDir, "redos-pack.json"), JSON.stringify({
      id: "redos-pack",
      name: "正则安全测试包",
      baseCulture: "western",
      speechStyle: {
        ritualBadPatterns: ["(a+)+$", "(a+)+", 123, "正常\\s*仪式", "祭坛点烛"]
      }
    }), "utf8");
    const t0 = performance.now();
    const redosLoaded = PACKS.loadPack("redos-pack", root);
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 500, `ReDoS 校验与加载应快速完成，实际 ${elapsed.toFixed(2)}ms`);
    assert.deepEqual(
      redosLoaded.speechStyle.ritualBadPatterns,
      ["正常\\s*仪式", "祭坛点烛"],
      "loadPack 必须剔除 (a+)+$ / (a+)+ / 非字符串条目 并放行安全模式"
    );
    assert.ok(Array.isArray(redosLoaded.rejectedPatterns) && redosLoaded.rejectedPatterns.length === 3, "loadPack 应返回 rejectedPatterns 记录被剔除条目");
    assert.ok(
      redosLoaded.rejectedPatterns.some((r) => r.pattern === "(a+)+$" && r.code === "redos"),
      "rejectedPatterns 应标明 pattern='(a+)+$' 与 code='redos'"
    );
    assert.ok(
      redosLoaded.rejectedPatterns.some((r) => r.code === "NON_STRING"),
      "rejectedPatterns 应包含非字符串剔除记录"
    );
    const listRedos = PACKS.listPacks(root);
    const listedRedosPack = listRedos.packs.find((p) => p.id === "redos-pack");
    assert.ok(listedRedosPack && Array.isArray(listedRedosPack.rejectedPatterns) && listedRedosPack.rejectedPatterns.length === 3);
    assert.ok(
      listRedos.warnings.some((w) => w.id === "redos-pack" && w.reason.includes("未通过安全校验")),
      "剔除危险正则应产生告警"
    );

    // 4c. 超过 PACK_MAX_BYTES (>256KB) 与坏 JSON（含金丝雀原文）
    const CANARY = "秘密泄露片段XXXX";
    writeFileSync(join(pDir, "broken.json"), `{bad ${CANARY}`, "utf8");
    const oversizePayload = JSON.stringify({
      id: "oversize-pack",
      description: CANARY,
      bannedWords: Array.from({ length: 12000 }, (_, i) => `超长禁词_${i}_${"字".repeat(8)}`)
    });
    assert.ok(Buffer.byteLength(oversizePayload, "utf8") > PACKS.PACK_MAX_BYTES);
    writeFileSync(join(pDir, "oversize.json"), oversizePayload, "utf8");

    const snapAfterBad = PACKS.listPacks(root);
    assert.ok(snapAfterBad.packs.some((p) => p.id === "scifi-cyberpunk"), "损坏/超大包存在时内置包仍应 fail-open 正常加载");
    assert.equal(PACKS.loadPack("broken", root), null);
    assert.equal(PACKS.loadPack("oversize-pack", root), null);
    assert.ok(snapAfterBad.errors.some((e) => e.file === "broken.json" && e.reason.includes("不是合法 JSON")));
    assert.ok(snapAfterBad.errors.some((e) => e.file === "oversize.json" && e.reason.includes("超过 256 KB")));
    assert.equal(JSON.stringify(snapAfterBad).includes(CANARY), false, "listPacks 返回体与 errors 绝不可泄漏金丝雀原文");

    // 4d. 越界 symlink / junction 拒绝（包外目录绝不泄出）
    const outsideDir = join(TMP_BASE, "outside-packs-" + process.pid);
    const OUTSIDE_CANARY = "秘密泄露片段YYYY";
    mkdirSync(outsideDir, { recursive: true });
    try {
      writeFileSync(join(outsideDir, "secret.json"), JSON.stringify({ id: "outside-secret", name: OUTSIDE_CANARY }), "utf8");
      const outsideFile = join(outsideDir, "outside-file.json");
      writeFileSync(outsideFile, JSON.stringify({ id: "outside-file", name: OUTSIDE_CANARY }), "utf8");

      const escapeJunction = join(pDir, "escape-dir.json");
      let junctionCreated = false;
      try {
        symlinkSync(outsideDir, escapeJunction, "junction");
        junctionCreated = true;
      } catch (e) {
        if (e?.code === "EPERM" || e?.code === "EACCES") {
          console.log(`   [跳过提示] 创建目录 junction 遇权限限制(${e.code})，跳过 junction 子校验`);
        } else {
          throw e;
        }
      }
      if (junctionCreated) {
        const listedEsc = PACKS.listPacks(root);
        assert.equal(PACKS.loadPack("escape-dir", root), null, "越界 junction 不得被加载");
        assert.ok(
          listedEsc.errors.some((e) => e.file === "escape-dir.json" && e.reason.includes("越界")),
          "越界 junction 必须在 errors 中报越界拒绝"
        );
        assert.equal(JSON.stringify(listedEsc).includes(OUTSIDE_CANARY), false, "越界目录内容绝不可泄出");
      }

      const escapeFileLink = join(pDir, "escape-file.json");
      let fileLinkCreated = false;
      try {
        symlinkSync(outsideFile, escapeFileLink, "file");
        fileLinkCreated = true;
      } catch (e) {
        if (e?.code === "EPERM" || e?.code === "EACCES") {
          console.log(`   [跳过提示] Windows 非特权用户创建文件软链接受限(${e.code})，仅保留 junction 越界校验`);
        } else {
          throw e;
        }
      }
      if (fileLinkCreated) {
        const listedFileEsc = PACKS.listPacks(root);
        assert.equal(PACKS.loadPack("escape-file", root), null);
        assert.equal(PACKS.loadPack("outside-file", root), null);
        assert.ok(listedFileEsc.errors.some((e) => e.file === "escape-file.json" && e.reason.includes("越界")));
        assert.equal(JSON.stringify(listedFileEsc).includes(OUTSIDE_CANARY), false);
      }
    } finally {
      try {
        rmSync(outsideDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* 忽略 */
      }
    }
  });
});

// ===========================================================================
// 5. 全工具联动与删书隔离
// ===========================================================================

const SCIFI_SLOP_CHAPTER = [
  "# 第一章 义体校准",
  "霓虹灯穿透酸雨照亮合金街道，侦测终端发出蜂鸣。这片街区竟然还有旧时代留下的衙门与客栈，柜台里还摆着银两。",
  "他低头查看自己的属性面板，战斗力达到999点，力量提升了50%，速度暴涨了3倍，防御突破5级，敏捷也增加了20%。",
  "随后他推开铁门走向停机坪，冷冷看着远处驶来的悬浮巡逻车。"
].join("\n\n");

test("5a. novel_settings(packs/add/update/非法拒收) + 4 个联动工具全链路校验", async () => {
  await withLib("tools-integration", async (root) => {
    const scifiBook = "赛博联动书";
    const controlBook = "无包对照书";
    for (const b of [scifiBook, controlBook]) {
      const bDir = join(root, "novels", b);
      mkdirSync(bDir, { recursive: true });
      for (let i = 1; i <= 3; i += 1) {
        writeFileSync(join(bDir, `第0${i}章.md`), SCIFI_SLOP_CHAPTER + "\n", "utf8");
      }
    }
    const { defs, exec } = createHarness(root);

    // 1) novel_settings packs / add / update / 非法拒绝
    const packsBefore = await defs.novel_settings.execute({ book: scifiBook, action: "packs", root }, exec);
    assertOutputSchema(defs.novel_settings, packsBefore, "novel_settings.packs(before)");
    assert.ok(packsBefore.packs.length >= 5, "packs 应返回至少 5 套题材包");
    assert.equal(packsBefore.activePack, void 0);

    await assert.rejects(
      () => defs.novel_settings.execute({
        book: scifiBook,
        category: "worldview",
        action: "add",
        name: "恶意包",
        pack: "../x",
        root
      }, exec),
      /非法字符/,
      "传非法 pack '../x' 时 novel_settings add 必须显式拒绝"
    );

    const added = await defs.novel_settings.execute({
      book: scifiBook,
      category: "worldview",
      action: "add",
      name: "赛博设定",
      pack: "eastern-xianxia",
      root
    }, exec);
    assertOutputSchema(defs.novel_settings, added, "novel_settings.add");
    assert.ok(added.message.includes("eastern-xianxia"));

    await assert.rejects(
      () => defs.novel_settings.execute({
        book: scifiBook,
        category: "worldview",
        action: "update",
        name: "赛博设定",
        pack: "../x",
        root
      }, exec),
      /非法字符/,
      "update 传非法 pack '../x' 必须显式拒绝"
    );

    const updated = await defs.novel_settings.execute({
      book: scifiBook,
      category: "worldview",
      action: "update",
      name: "赛博设定",
      pack: "scifi-cyberpunk",
      root
    }, exec);
    assertOutputSchema(defs.novel_settings, updated, "novel_settings.update");
    assert.equal(updated.worldview[0].pack, "scifi-cyberpunk");

    const packsAfter = await defs.novel_settings.execute({ book: scifiBook, action: "packs", root }, exec);
    assertOutputSchema(defs.novel_settings, packsAfter, "novel_settings.packs(after)");
    assert.equal(packsAfter.activePack?.id, "scifi-cyberpunk");
    const packsRendered = renderText(defs.novel_settings, { book: scifiBook, action: "packs", root }, packsAfter);
    assert.ok(packsRendered.includes("scifi-cyberpunk") && packsRendered.includes("★当前生效"));

    // 1b) novel_settings action="packs" 透出题材包被拒正则告警（warnings + render）
    const pDir = PACKS.packsDir(root);
    mkdirSync(pDir, { recursive: true });
    writeFileSync(join(pDir, "warn-regex-pack.json"), JSON.stringify({
      id: "warn-regex-pack",
      name: "告警验证包",
      baseCulture: "modern",
      speechStyle: { ritualBadPatterns: ["(a+)+$", "点烛"] }
    }), "utf8");
    const packsWithWarn = await defs.novel_settings.execute({ book: scifiBook, action: "packs", root }, exec);
    assertOutputSchema(defs.novel_settings, packsWithWarn, "novel_settings.packs(warnings)");
    assert.ok(Array.isArray(packsWithWarn.warnings) && packsWithWarn.warnings.length >= 1, "action=packs 应透出 warnings");
    assert.ok(packsWithWarn.message.includes("规则告警"), "action=packs message 应提示存在规则告警");
    const warnPackItem = packsWithWarn.packs.find((p) => p.id === "warn-regex-pack");
    assert.ok(warnPackItem && Array.isArray(warnPackItem.rejectedPatterns) && warnPackItem.rejectedPatterns.length === 1);
    const warnRendered = renderText(defs.novel_settings, { book: scifiBook, action: "packs", root }, packsWithWarn);
    assert.ok(warnRendered.includes("已剔除正则=1") && warnRendered.includes("规则告警（"), "render 应输出被剔除正则计数与规则告警明细");
    rmSync(join(pDir, "warn-regex-pack.json"), { force: true });

    // 2) novel_continuity_check（全书 + 单章模式）：报出 衙门/客栈 并注明题材包
    const contRes = await defs.novel_continuity_check.execute({ book: scifiBook, root }, exec);
    assertOutputSchema(defs.novel_continuity_check, contRes, "novel_continuity_check");
    assert.equal(contRes.pack?.id, "scifi-cyberpunk");
    assert.ok(contRes.candidates.some((c) => c.type === "用语冲突" && c.word === "衙门"), "应报出禁词「衙门」");
    assert.ok(contRes.candidates.some((c) => c.type === "用语冲突" && c.word === "客栈"), "应报出禁词「客栈」");
    const contChecklistBanned = contRes.checklist.find((item) => item.item.includes("用语冲突"));
    assert.ok(contChecklistBanned && contChecklistBanned.note.includes("scifi-cyberpunk"), "checklist 应注明题材包");
    const contRendered = renderText(defs.novel_continuity_check, { book: scifiBook, root }, contRes);
    assert.ok(contRendered.includes("生效题材包") && contRendered.includes("scifi-cyberpunk"));

    const contChRes = await defs.novel_continuity_check.execute({ book: scifiBook, chapter: "2", root }, exec);
    assertOutputSchema(defs.novel_continuity_check, contChRes, "novel_continuity_check(chapter)");
    assert.equal(contChRes.pack?.id, "scifi-cyberpunk");
    assert.ok(contChRes.styleCandidates.some((c) => c.type === "用语冲突" && c.word === "衙门"), "单章模式也应报出「衙门」");

    // 3) novel_chapter_brief：worldview.pack 与 slop 静音 stat_numeric（与无包对照组对比）
    const briefCtrl = await defs.novel_chapter_brief.execute({ book: controlBook, chapter: "next", root }, exec);
    const briefScifi = await defs.novel_chapter_brief.execute({ book: scifiBook, chapter: "next", root }, exec);
    assertOutputSchema(defs.novel_chapter_brief, briefScifi, "novel_chapter_brief");
    assert.equal(briefScifi.worldview?.pack?.id, "scifi-cyberpunk");
    assert.deepEqual(briefScifi.worldview?.pack?.slopMuteCategories, ["stat_numeric"]);
    assert.ok((briefCtrl.prevChapterIssues || []).some((it) => it.key === "slop"), "对照组：无包时应检出 stat_numeric 套话症状");
    assert.equal((briefScifi.prevChapterIssues || []).some((it) => it.key === "slop"), false, "实验组：scifi-cyberpunk 应静音 stat_numeric 套话症状");
    assert.equal(
      (briefScifi.symptomPrescriptions || []).some((p) => p.key === "slop"),
      false,
      "实验组：scifi-cyberpunk 静音后不应下发 stat_numeric 处方"
    );
    const briefRendered = renderText(defs.novel_chapter_brief, { book: scifiBook, chapter: "next", root }, briefScifi);
    assert.ok(briefRendered.includes("题材包:科幻赛博(scifi-cyberpunk)"));

    // 4) novel_style_check：slop 静音 stat_numeric（对照组命中，实验组静音）
    const styleCtrl = await defs.novel_style_check.execute({ book: controlBook, chapter: "3", root }, exec);
    const styleScifi = await defs.novel_style_check.execute({ book: scifiBook, chapter: "3", root }, exec);
    assertOutputSchema(defs.novel_style_check, styleScifi, "novel_style_check");
    assert.ok(styleCtrl.slop && styleCtrl.slop.byCategory?.stat_numeric >= 5, "对照组：无包时 novel_style_check 应命中 stat_numeric");
    assert.equal(styleScifi.slop?.byCategory?.stat_numeric ?? 0, 0, "实验组：scifi-cyberpunk 应将 stat_numeric 静音为 0");
    assert.equal(styleScifi.slop, void 0, "实验组仅含 stat_numeric 套话时静音后 slop 应整体省略");

    // 5) novel_fix_plan：summary（含 notes）披露「生效题材包」，且 stat_numeric 被静音
    const fixCtrl = await defs.novel_fix_plan.execute({ book: controlBook, chapter: "3", action: "plan", root }, exec);
    const fixScifi = await defs.novel_fix_plan.execute({ book: scifiBook, chapter: "3", action: "plan", root }, exec);
    assertOutputSchema(defs.novel_fix_plan, fixScifi, "novel_fix_plan");
    assert.ok(
      fixCtrl.items.some((it) => it.type === "AI套话" && String(it.current || "").includes("stat_numeric")),
      "对照组：无包时 novel_fix_plan 应检出 AI套话 stat_numeric"
    );
    assert.equal(
      fixScifi.items.some((it) => it.type === "AI套话" && String(it.current || "").includes("stat_numeric")),
      false,
      "实验组：scifi-cyberpunk 下 stat_numeric 必须被静音"
    );
    assert.ok(fixScifi.items.some((it) => it.type === "禁用词" && String(it.current || "").includes("衙门")), "禁用词检查仍应生效");
    assert.ok(fixScifi.summary.includes("生效题材包：科幻赛博（scifi-cyberpunk"), "fix_plan notes/summary 应含「生效题材包」");
    const fixRendered = renderText(defs.novel_fix_plan, { book: scifiBook, chapter: "3", action: "plan", root }, fixScifi);
    assert.ok(fixRendered.includes("生效题材包"));
  });
});

test("5b. novel_diagnose：检出损坏 packs/broken.json 与被拒正则包，且报告绝不含金丝雀原文", async () => {
  await withLib("diagnose-packs", async (root) => {
    const CANARY = "秘密泄露片段XXXX";
    const REDOS_CANARY = "CANARY_REDOS_SECRET_999";
    const pDir = PACKS.packsDir(root);
    mkdirSync(pDir, { recursive: true });
    writeFileSync(join(pDir, "broken.json"), `{bad ${CANARY}`, "utf8");
    writeFileSync(join(pDir, "redos-warn.json"), JSON.stringify({
      id: "redos-warn",
      name: "危险正则诊断测试包",
      baseCulture: "modern",
      speechStyle: { ritualBadPatterns: [`(${REDOS_CANARY}+)+$`] }
    }), "utf8");

    const { defs, exec } = createHarness(root);
    const diagRes = await defs.novel_diagnose.execute({ root, days: 7 }, exec);
    assertOutputSchema(defs.novel_diagnose, diagRes, "novel_diagnose");
    const diagDirect = await DIAGNOSE.buildDiagnosis({ root }, { root, days: 7 }, exec);

    assert.ok(diagRes.dataDir.corruptTotal >= 1, "应检出损坏的 packs/broken.json");
    assert.ok(
      diagRes.dataDir.corruptFiles.some((f) => f.rel === "packs/broken.json"),
      "corruptFiles 应列出 packs/broken.json"
    );
    assert.ok(diagRes.dataDir.packWarningTotal >= 1, "应检出含非法/ReDoS 正则的 packs/redos-warn.json");
    assert.ok(
      diagRes.dataDir.packWarnings.some((w) => w.rel === "packs/redos-warn.json" && w.rejectedCount === 1 && w.codes.includes("redos")),
      "packWarnings 应列出文件名、被拒数量与 redos 错误码"
    );
    assert.ok(
      diagRes.issues.some((iss) => iss.level === "warn" && iss.title.includes("仪式正则")),
      "issues 应生成题材包仪式正则告警"
    );
    assert.ok(diagRes.report.includes("packs/broken.json"), "诊断报告文本应点名 packs/broken.json");
    assert.ok(diagRes.report.includes("packs/redos-warn.json"), "诊断报告文本应点名 packs/redos-warn.json");
    const serialized = diagRes.report + JSON.stringify(diagRes) + JSON.stringify(diagDirect);
    assert.equal(serialized.includes(CANARY), false, "诊断报告与结构化输出绝不得泄漏金丝雀原文");
    assert.equal(serialized.includes(REDOS_CANARY), false, "诊断报告绝不得泄漏原始正则模式原文");
  });
});

test("5c. novel_delete_book 隔离：删书清理正文与 9 类按书数据，packs/ 共享题材包目录完好无损", async () => {
  await withLib("delete-book-packs", async (root) => {
    const book = "赛博删书测试";
    const touch = (rel, body = "{}") => {
      const full = join(root, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body, "utf8");
    };

    // 正文 + 创作资料 + 9 类按书数据
    touch(`novels/${book}/第01章.md`, "测试正文内容超过四十字，用以验证删书清理与 packs 隔离。\n");
    touch(`novels/创作资料/${book}/创作设定.md`, "赛博设定\n");
    for (const sub of BOOKDELETE.DELETE_DATA_SUBDIRS) {
      const fileName = sub === "audits" ? `fix-plan-${book}-第01章.json` : `${book}.json`;
      touch(`.novel-writer/${sub}/${fileName}`, JSON.stringify({ book, sub }));
    }

    // 在 .novel-writer/packs/ 下放置同名按书包与共享包
    const bookPackFile = join(PACKS.packsDir(root), `${book}.json`);
    const sharedPackFile = join(PACKS.packsDir(root), "shared-pack.json");
    const bookPackBody = JSON.stringify({ id: "book-specific-pack", name: "按书包", baseCulture: "modern", bannedWords: ["词甲"] });
    const sharedPackBody = JSON.stringify({ id: "shared-pack", name: "共享包", baseCulture: "western", bannedWords: ["词乙"] });
    mkdirSync(PACKS.packsDir(root), { recursive: true });
    writeFileSync(bookPackFile, bookPackBody, "utf8");
    writeFileSync(sharedPackFile, sharedPackBody, "utf8");

    const { defs, exec } = createHarness(root);

    // preview
    const previewRes = await defs.novel_delete_book.execute({ book, action: "preview", root }, exec);
    assertOutputSchema(defs.novel_delete_book, previewRes, "novel_delete_book.preview");
    assert.equal(previewRes.found, true);
    assert.equal(previewRes.targets.some((t) => t.key === "data:packs"), false, "packs 目录绝不能进入删书 targets");
    for (const sub of BOOKDELETE.DELETE_DATA_SUBDIRS) {
      assert.ok(previewRes.targets.some((t) => t.key === `data:${sub}` && t.exists), `应检出按书目录 data:${sub}`);
    }

    // apply
    const applyRes = await defs.novel_delete_book.execute({ book, action: "apply", root }, exec);
    assertOutputSchema(defs.novel_delete_book, applyRes, "novel_delete_book.apply");
    assert.equal(applyRes.remaining.files, 0, "按书数据与正文应全部移入回收站，无残留");
    assert.equal(existsSync(join(root, "novels", book)), false, "书籍目录应被清理");
    for (const sub of BOOKDELETE.DELETE_DATA_SUBDIRS) {
      const fileName = sub === "audits" ? `fix-plan-${book}-第01章.json` : `${book}.json`;
      assert.equal(existsSync(join(root, ".novel-writer", sub, fileName)), false, `9 类按书数据 ${sub} 应被清理`);
    }

    // 共享 packs/ 目录与文件完好无损不被误删
    assert.equal(existsSync(PACKS.packsDir(root)), true, ".novel-writer/packs/ 目录必须完好保留");
    assert.equal(existsSync(bookPackFile), true, "packs/<书>.json 属于共享 packs 目录，删书绝不能误删");
    assert.equal(readFileSync(bookPackFile, "utf8"), bookPackBody);
    assert.equal(existsSync(sharedPackFile), true);
    assert.equal(readFileSync(sharedPackFile, "utf8"), sharedPackBody);
  });
});

// ===========================================================================
// 6. 隔离守卫
// ===========================================================================

test("6. 隔离守卫：用户真实 ~/.dsh/dsh-novel-writer/ 目录全程未被修改", () => {
  const realAfter = digestTree(REAL_DSH_DIR);
  assert.deepEqual(realAfter, realBefore, "测试全程绝不能改动用户真实 ~/.dsh/dsh-novel-writer/ 目录");
});
