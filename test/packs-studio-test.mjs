/**
 * test/packs-studio-test.mjs —— v7.7.0 题材规则包工作室自动化回归套件（第 43 个测试套件）
 *
 * 覆盖范围：
 *   1. lib/packs.js：toSerializablePack / formatPackJson / formatPackEnvelope / parsePackInput
 *      （纯 JSON、```json 围栏、[DSH-PACK v1] 分享信封带聊天前后废话、剥离反引号后的顶层 {...}、
 *       BOM、>256KB 拦截、ReDoS rejectedPatterns、promptTexts 披露、内置/同名冲突、missing extends）
 *   2. saveCustomPack / deleteCustomPack：原子写盘、409 重名保护、overwrite、内置 ID 禁止、
 *      符号链接写/删拒绝、缓存立即失效、内置不可删、404
 *   3. /api/dsh-novel-writer/packs HTTP 路由（buildUiRoutes + invokeRouteInMemory + 伪造远程源 403）：
 *      GET 含 rawPacks 与 slopCategories、POST preview 只读干跑、POST save（idOverride / 409 /
 *      overwrite / bindAfterSave）、POST delete、旧 bind/unbind 向后兼容
 *   4. 隔离守卫：真实 ~/.dsh/dsh-novel-writer/ 目录零写入
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
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

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
const TMP_BASE = realpathSync.native(mkdtempSync(join(tmpdir(), "dsh-packs-studio-" + process.pid + "-")));
const STATE_FILE = join(TMP_BASE, "state.json");
const DSH_HOME_DIR = join(TMP_BASE, "dsh-home");

function restoreEnvAndCleanup() {
  if (PREV_STATE_ENV === void 0) delete process.env.DSH_NOVEL_WRITER_STATE;
  else process.env.DSH_NOVEL_WRITER_STATE = PREV_STATE_ENV;
  if (PREV_HOME_ENV === void 0) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_HOME_ENV;
  try {
    rmSync(TMP_BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* ignore */ }
}

process.on("exit", restoreEnvAndCleanup);
test.after(restoreEnvAndCleanup);

let PACKS;
let SYSTEM;
let WEB_UI;
let SLOP;

try {
  mkdirSync(DSH_HOME_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({
    enabled: true,
    autoAnalyze: true,
    systemPromptMode: "off",
    promptScene: "general",
    leanWorkflow: false,
    tools: {},
    features: {}
  }, null, 2), "utf8");
  process.env.DSH_NOVEL_WRITER_STATE = STATE_FILE;
  process.env.DSH_HOME = DSH_HOME_DIR;

  PACKS = await import("../lib/packs.js");
  SYSTEM = await import("../lib/tools/system.js");
  WEB_UI = await import("../lib/web-ui.js");
  SLOP = await import("../lib/lexicons/slop.js");
} catch (err) {
  restoreEnvAndCleanup();
  throw err;
}

function findRoute(routes, path) {
  const route = routes.find((r) => r && r.kind === "exact" && r.path === path);
  assert.ok(route, `应存在路由 ${path}`);
  return route;
}

async function invokeRouteWithSocket(route, { method = "GET", url, body, headers = {}, remoteAddress = "127.0.0.1" } = {}) {
  const bodyBuf = body === void 0
    ? null
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  const req = {
    method,
    url: url || route.path,
    headers: { host: "127.0.0.1", ...headers },
    socket: { remoteAddress },
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        async next() {
          if (!sent && bodyBuf !== null) {
            sent = true;
            return { value: bodyBuf, done: false };
          }
          return { value: undefined, done: true };
        }
      };
    }
  };
  const headerMap = new Map();
  const chunks = [];
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) { headerMap.set(String(name).toLowerCase(), String(value)); },
    getHeader(name) { return headerMap.get(String(name).toLowerCase()); },
    writeHead(status, hdrs) {
      this.statusCode = Number(status) || 200;
      if (hdrs && typeof hdrs === "object") {
        for (const [k, v] of Object.entries(hdrs)) {
          if (v !== void 0) headerMap.set(String(k).toLowerCase(), String(v));
        }
      }
      this.headersSent = true;
      return this;
    },
    write(chunk) {
      if (chunk !== void 0 && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
      return true;
    },
    end(chunk) {
      if (chunk !== void 0 && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
      this.headersSent = true;
      this.writableEnded = true;
      return this;
    }
  };
  await route.handler(req, res);
  const text = Buffer.concat(chunks).toString("utf8");
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.statusCode, text, json };
}

test("1. 序列化、可读分享信封与 parsePackInput 多格式/安全边界校验", () => {
  const sample = {
    id: "cyber-xianxia",
    name: "赛博修仙",
    description: "义体飞升与古风忌讳混合规则",
    baseCulture: "eastern",
    extends: "eastern-xianxia",
    aliases: ["赛博", "cyberxianxia"],
    bannedWords: ["先令", "跑堂"],
    recommended: { "先令": "灵石信用点" },
    allowWords: ["义体剑", "灵网"],
    speechStyle: {
      title: "道友/黑客称呼可用",
      honorBad: ["Miss"],
      honorGood: { Miss: "道友" },
      ritualBadPatterns: ["点蜡烛"],
      ritualGoodNote: "用灵网同步代替焚香",
      tone: "冷峻赛博修仙腔"
    },
    slopMuteCategories: ["stat_numeric"],
    source: "custom",
    file: "cyber-xianxia.json",
    rejectedPatterns: [{ pattern: "(a+)+", reason: "ReDoS" }]
  };

  const ser = PACKS.toSerializablePack(sample);
  assert.equal(ser.schema, PACKS.PACK_SCHEMA_V1);
  assert.equal("source" in ser, false);
  assert.equal("file" in ser, false);
  assert.equal("rejectedPatterns" in ser, false);
  assert.equal(ser.speechStyle.titleGuideline, "道友/黑客称呼可用");
  assert.equal(ser.speechStyle.toneGuideline, "冷峻赛博修仙腔");

  const envText = PACKS.formatPackEnvelope(sample);
  assert.ok(envText.startsWith("[DSH-PACK v1] 赛博修仙 (cyber-xianxia)"));
  assert.ok(envText.includes("```json"));

  // 带聊天软件前后废话、BOM 与围栏提取
  const noisy = "\uFEFF大佬发你一个包，快试试！ {无效花括号}\n\n" + envText + "\n\n记得点确认哦～";
  const p1 = PACKS.parsePackInput(noisy);
  assert.equal(p1.ok, true);
  assert.equal(p1.pack.id, "cyber-xianxia");
  assert.deepEqual(p1.promptTexts, {
    description: "义体飞升与古风忌讳混合规则",
    titleGuideline: "道友/黑客称呼可用",
    toneGuideline: "冷峻赛博修仙腔",
    ritualGoodNote: "用灵网同步代替焚香"
  });

  // 剥掉 ```json 围栏的纯文本头 + JSON
  const stripped = "[DSH-PACK v1] 纯头无围栏 {not json}\n" + PACKS.formatPackJson(sample);
  const p2 = PACKS.parsePackInput(stripped);
  assert.equal(p2.ok, true);
  assert.equal(p2.pack.id, "cyber-xianxia");

  // ReDoS 正则剔除 + 冲突/missing extends 预览 + idOverride
  const root = join(TMP_BASE, "root-parse");
  mkdirSync(root, { recursive: true });
  const evilPack = {
    id: "eastern-xianxia",
    name: "冒充内置包",
    extends: "missing-parent",
    speechStyle: { ritualBadPatterns: ["(a+)+$", "烧香"] }
  };
  const p3 = PACKS.parsePackInput(JSON.stringify(evilPack), { root });
  assert.equal(p3.ok, true);
  assert.equal(p3.conflict.isBuiltinId, true);
  assert.equal(p3.extendsInfo.missing, true);
  assert.equal(p3.rejectedPatterns.length, 1);
  assert.deepEqual(p3.pack.speechStyle.ritualBadPatterns, ["烧香"]);

  const pOverride = PACKS.parsePackInput(JSON.stringify(evilPack), { root, idOverride: "my-custom-fork" });
  assert.equal(pOverride.ok, true);
  assert.equal(pOverride.pack.id, "my-custom-fork");
  assert.equal(pOverride.conflict.isBuiltinId, false);

  // > 256KB 与非法 JSON 不泄漏片段
  const bigStr = JSON.stringify({ id: "big", description: "a".repeat(PACKS.PACK_MAX_BYTES + 100) });
  const pBig = PACKS.parsePackInput(bigStr);
  assert.equal(pBig.ok, false);
  assert.match(pBig.error, /256 KB/);

  const canary = "CANARY_SECRET_PARSE_FAIL";
  const pBad = PACKS.parsePackInput(`{ broken: ${canary} `);
  assert.equal(pBad.ok, false);
  assert.equal(pBad.error.includes(canary), false);
});

test("2. saveCustomPack / deleteCustomPack 原子落盘、409 冲突保护、内置保护与缓存即时失效", async () => {
  const root = join(TMP_BASE, "root-crud");
  mkdirSync(join(root, "novels", "测试书"), { recursive: true });

  // 禁止保存为内置包 ID
  const bRes = await PACKS.saveCustomPack(root, { id: "western-fantasy", name: "x" });
  assert.equal(bRes.ok, false);
  assert.equal(bRes.code, "BUILTIN_ID");

  // 首次保存 + 同毫秒 cache 失效校验
  const forkObj = {
    id: "wuxia-jianghu",
    name: "传统武侠",
    description: "武侠江湖用语",
    baseCulture: "eastern",
    extends: "eastern-xianxia",
    bannedWords: ["筑基", "元婴"],
    recommended: { "筑基": "内功初成" },
    allowWords: ["内力"]
  };
  const s1 = await PACKS.saveCustomPack(root, PACKS.formatPackEnvelope(forkObj));
  assert.equal(s1.ok, true);
  assert.equal(s1.id, "wuxia-jianghu");

  const loaded = PACKS.loadPack("wuxia-jianghu", root);
  assert.ok(loaded, "保存后必须立即可 loadPack");
  assert.ok(loaded.bannedWords.includes("阁下"), "继承了 eastern-xianxia 的规则");
  assert.ok(loaded.bannedWords.includes("筑基"), "包含子包新增禁用词");

  const raw = PACKS.getRawPack("wuxia-jianghu", root);
  assert.ok(raw);
  assert.deepEqual(raw.bannedWords, ["筑基", "元婴"], "getRawPack 必须返回未合并父包的增量字段");

  // 重名不带 overwrite → 409 PACK_EXISTS
  const sDup = await PACKS.saveCustomPack(root, forkObj);
  assert.equal(sDup.ok, false);
  assert.equal(sDup.status, 409);
  assert.equal(sDup.code, "PACK_EXISTS");

  // overwrite=true 更新且立即生效
  const sUpd = await PACKS.saveCustomPack(root, { ...forkObj, bannedWords: ["金丹"] }, { overwrite: true });
  assert.equal(sUpd.ok, true);
  const raw2 = PACKS.getRawPack("wuxia-jianghu", root);
  assert.deepEqual(raw2.bannedWords, ["金丹"]);

  // 拒绝删除内置包，未知包回 404
  const delBuiltin = await PACKS.deleteCustomPack(root, "eastern-xianxia");
  assert.equal(delBuiltin.ok, false);
  assert.equal(delBuiltin.status, 400);

  const delMissing = await PACKS.deleteCustomPack(root, "does-not-exist");
  assert.equal(delMissing.ok, false);
  assert.equal(delMissing.status, 404);

  // 符号链接目标拒绝写入/删除（Windows 无权限时优雅跳过）
  const pDir = PACKS.packsDir(root);
  const symOutside = join(TMP_BASE, "outside-target.json");
  writeFileSync(symOutside, "{}", "utf8");
  const symPack = join(pDir, "sym-escape.json");
  let symCreated = false;
  try {
    symlinkSync(symOutside, symPack);
    symCreated = true;
  } catch { /* Windows EPERM */ }
  if (symCreated) {
    const symSave = await PACKS.saveCustomPack(root, { id: "sym-escape", name: "x" }, { overwrite: true });
    assert.equal(symSave.ok, false);
    const symDel = await PACKS.deleteCustomPack(root, "sym-escape");
    assert.equal(symDel.ok, false);
  }

  // 正常删除自定义包
  const dOk = await PACKS.deleteCustomPack(root, "wuxia-jianghu");
  assert.equal(dOk.ok, true);
  assert.equal(dOk.deleted, "wuxia-jianghu");
  assert.equal(PACKS.loadPack("wuxia-jianghu", root), null);
});

test("3. HTTP /api/dsh-novel-writer/packs 路由扩展：GET rawPacks/slopCategories、POST preview/save/delete/bind 与回环保护", async () => {
  const root = join(TMP_BASE, "root-http");
  mkdirSync(join(root, "novels", "大道独行"), { recursive: true });
  writeFileSync(join(root, "novels", "大道独行", "第01章.md"), "正文", "utf8");

  const routes = SYSTEM.buildUiRoutes({ root, allowLanState: false });
  const packsRoute = findRoute(routes, "/api/dsh-novel-writer/packs");

  // GET 返回 rawPacks 与 slopCategories
  const g1 = await WEB_UI.invokeRouteInMemory(packsRoute, {
    method: "GET",
    url: "/api/dsh-novel-writer/packs?book=" + encodeURIComponent("大道独行")
  });
  assert.equal(g1.status, 200);
  assert.ok(g1.json.rawPacks && g1.json.rawPacks["eastern-xianxia"]);
  assert.deepEqual(g1.json.slopCategories, { ...SLOP.SLOP_CATEGORIES });

  // POST preview 严格只读不落盘
  const envInput = PACKS.formatPackEnvelope({
    id: "eastern-xianxia",
    name: "江湖改版",
    description: "测试预览",
    extends: "eastern-xianxia",
    bannedWords: ["手机"],
    speechStyle: { ritualBadPatterns: ["(a+)+$"], toneGuideline: "古风侠气" }
  });
  const preRes = await WEB_UI.invokeRouteInMemory(packsRoute, {
    method: "POST",
    url: "/api/dsh-novel-writer/packs",
    body: { action: "preview", text: envInput }
  });
  assert.equal(preRes.status, 200);
  assert.equal(preRes.json.preview.conflict.isBuiltinId, true);
  assert.equal(preRes.json.preview.rejectedPatterns.length, 1);
  assert.equal(preRes.json.preview.promptTexts.toneGuideline, "古风侠气");
  assert.equal(existsSync(PACKS.packsDir(root)), false, "preview 绝不创建 packs 目录或写盘");

  // POST save + idOverride + bindAfterSave
  const saveRes = await WEB_UI.invokeRouteInMemory(packsRoute, {
    method: "POST",
    url: "/api/dsh-novel-writer/packs",
    body: {
      action: "save",
      text: envInput,
      idOverride: "jianghu-custom",
      book: "大道独行",
      bindAfterSave: true
    }
  });
  assert.equal(saveRes.status, 200);
  assert.equal(saveRes.json.saved, "jianghu-custom");
  assert.equal(saveRes.json.bound, true);
  assert.equal(saveRes.json.boundPackId, "jianghu-custom");
  assert.ok(saveRes.json.rawPacks["jianghu-custom"]);

  // POST save 重名未传 overwrite → 409
  const dupRes = await WEB_UI.invokeRouteInMemory(packsRoute, {
    method: "POST",
    url: "/api/dsh-novel-writer/packs",
    body: { action: "save", pack: { id: "jianghu-custom", name: "重名" } }
  });
  assert.equal(dupRes.status, 409);

  // 向后兼容：省略 action 时仍按 bind/unbind
  const unbindRes = await WEB_UI.invokeRouteInMemory(packsRoute, {
    method: "POST",
    url: "/api/dsh-novel-writer/packs",
    body: { book: "大道独行", pack: "" }
  });
  assert.equal(unbindRes.status, 200);
  assert.equal(unbindRes.json.boundPackId, "");

  // POST delete：拒绝内置，允许删除自定义
  const delBuiltinRes = await WEB_UI.invokeRouteInMemory(packsRoute, {
    method: "POST",
    url: "/api/dsh-novel-writer/packs",
    body: { action: "delete", id: "eastern-xianxia", book: "大道独行" }
  });
  assert.equal(delBuiltinRes.status, 400);

  const delRes = await WEB_UI.invokeRouteInMemory(packsRoute, {
    method: "POST",
    url: "/api/dsh-novel-writer/packs",
    body: { action: "delete", id: "jianghu-custom", book: "大道独行" }
  });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.json.deleted, "jianghu-custom");
  assert.equal(Boolean(delRes.json.rawPacks["jianghu-custom"]), false);

  // 即使 allowLanState=true，非回环 POST preview/save/delete 也必须 403 拒绝
  const lanRoutes = SYSTEM.buildUiRoutes({ root, allowLanState: true });
  const lanPacksRoute = findRoute(lanRoutes, "/api/dsh-novel-writer/packs");
  for (const act of ["preview", "save", "delete"]) {
    const r = await invokeRouteWithSocket(lanPacksRoute, {
      method: "POST",
      url: "/api/dsh-novel-writer/packs",
      remoteAddress: "10.0.0.9",
      headers: { host: "10.0.0.9" },
      body: { action: act, text: "{}", id: "x" }
    });
    assert.equal(r.status, 403, `非回环 ${act} 必须 403 拒绝`);
  }
});

test("4. 抗 ReDoS / 事件循环阻塞回归测试与复杂噪声提取边界", async () => {
  const root = join(TMP_BASE, "root-dos");
  mkdirSync(join(root, "novels", "性能测试书"), { recursive: true });
  const routes = SYSTEM.buildUiRoutes({ root, allowLanState: false });
  const packsRoute = findRoute(routes, "/api/dsh-novel-writer/packs");

  // 4.1 审计复现载荷与各类退化输入均必须在线性时间/预算内返回且不卡死事件循环
  const unclosed200k = "{".repeat(200_000);
  const t0 = performance.now();
  const rUnclosed = PACKS.parsePackInput(unclosed200k);
  const dtUnclosed = performance.now() - t0;
  assert.equal(rUnclosed.ok, false);
  assert.ok(dtUnclosed < 100, `200,000 个 '{' 耗时过长: ${dtUnclosed.toFixed(1)} ms`);

  const saveUnclosedStart = performance.now();
  const sUnclosed = await PACKS.saveCustomPack(root, unclosed200k);
  assert.equal(sUnclosed.ok, false);
  assert.equal(sUnclosed.status, 400);
  assert.ok(performance.now() - saveUnclosedStart < 100, "saveCustomPack 必须继承 O(n) 抗阻塞保护");

  const httpPreStart = performance.now();
  const hPre = await WEB_UI.invokeRouteInMemory(packsRoute, {
    method: "POST",
    url: "/api/dsh-novel-writer/packs",
    body: { action: "preview", text: unclosed200k }
  });
  assert.equal(hPre.status, 400);
  assert.ok(performance.now() - httpPreStart < 100, "HTTP preview 必须在 100ms 内完成");

  const httpSaveStart = performance.now();
  const hSave = await WEB_UI.invokeRouteInMemory(packsRoute, {
    method: "POST",
    url: "/api/dsh-novel-writer/packs",
    body: { action: "save", text: unclosed200k }
  });
  assert.equal(hSave.status, 400);
  assert.ok(performance.now() - httpSaveStart < 100, "HTTP save 必须在 100ms 内完成");

  const adversarialCases = [
    { name: "nested-invalid-50k", text: "{".repeat(50_000) + "x" + "}".repeat(50_000), expectJsonHint: false },
    { name: "many-nonjson-60k", text: "{a}".repeat(60_000), expectJsonHint: false },
    { name: "deep-json-10k", text: "chat " + "{ \"a\": ".repeat(10_000) + "1" + " }".repeat(10_000), expectJsonHint: false },
    { name: "many-fences-50k", text: "```".repeat(50_000), expectJsonHint: true },
    { name: "many-jsonlike-invalid-200", text: "{ \"a\": x }".repeat(200) + "CANARY_SECRET_DOS", expectJsonHint: true }
  ];
  for (const ac of adversarialCases) {
    const startMs = performance.now();
    const res = PACKS.parsePackInput(ac.text);
    const elapsed = performance.now() - startMs;
    assert.equal(res.ok, false, `${ac.name} 不应解析为合法包`);
    assert.ok(elapsed < 100, `${ac.name} 耗时过高: ${elapsed.toFixed(1)} ms`);
    assert.equal(res.error.includes("CANARY_SECRET_DOS"), false, `${ac.name} 不得泄漏原文金丝雀`);
    if (ac.expectJsonHint) {
      assert.match(res.error, /\.json/, `${ac.name} 超预算后应提示改用 .json 文件导入`);
    }
  }

  // 4.2 复杂噪声下仍可正确抽取完整外层包与带转义字符串
  const nestedPack = {
    id: "outer-cyber",
    name: "外层赛博包",
    description: "带嵌套对象与引号测试",
    recommended: { "先生": "阁下" },
    speechStyle: { toneGuideline: "冷峻", honorGood: { Miss: "道友" } }
  };
  const chatterVariants = [
    "[DSH-PACK v1] 聊天 {未闭合花括号\n" + JSON.stringify(nestedPack),
    "群友说\"好用\n" + JSON.stringify(nestedPack),
    "群友 { \"未闭合引号\n" + JSON.stringify(nestedPack),
    "群友 { \"断尾反斜杠引号\\\n" + JSON.stringify(nestedPack),
    "{ broken_outer " + JSON.stringify(nestedPack) + " }",
    "\"\"\"```notjson```\n" + JSON.stringify(nestedPack)
  ];
  for (const txt of chatterVariants) {
    const parsed = PACKS.parsePackInput(txt);
    assert.equal(parsed.ok, true, `噪声前缀应成功解析: ${txt.slice(0, 24)}`);
    assert.equal(parsed.pack.id, "outer-cyber");
    assert.equal(parsed.pack.recommended["先生"], "阁下");
    assert.equal(parsed.pack.speechStyle.tone, "冷峻");
  }

  const escapedJson = JSON.stringify({
    id: "quote-brace",
    name: "括号与转义引号",
    description: "含 } 和 { 和 \"引号\" 与 \\ 反斜杠"
  });
  const parsedEsc = PACKS.parsePackInput("前缀 " + escapedJson + " 后缀");
  assert.equal(parsedEsc.ok, true);
  assert.equal(parsedEsc.pack.id, "quote-brace");
  assert.ok(parsedEsc.pack.description.includes("引号"));
});

test("5. 隔离守卫：用户真实 ~/.dsh/dsh-novel-writer/ 目录未受影响", () => {
  const realAfter = digestTree(REAL_DSH_DIR);
  assert.equal(realAfter, realBefore, "真实 ~/.dsh/dsh-novel-writer/ 目录不可被测试改动");
});
