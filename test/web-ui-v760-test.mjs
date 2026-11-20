/**
 * test/web-ui-v760-test.mjs —— v7.6.0 独立 Web UI、面板新路由、MCP --ui 与 Antigravity Sidecar 回归套件（第 42 个测试套件）
 *
 * 覆盖范围：
 *   1. /api/dsh-novel-writer/packs（GET 列包/警告/错误、POST 事务绑定/解绑、非法 packId 400、allowLanState=true 下非回环/伪造 Host 403、DELETE/PUT 405）
 *   2. /api/dsh-novel-writer/baseline（sceneBaselines 3+3+3 严格只读估算、缺失书籍返回 null）
 *   3. /api/dsh-novel-writer/reveal（packs-dir 白名单校验，不触发真实系统文件管理器弹窗）
 *   4. lib/web-ui.js 独立 Web UI 服务器（startWebUiServer、全静态与 API 路由 200/404、伪造 Host 403、react-shim.js vm 挂载与状态更新/清理、close）
 *   5. mcp/server.mjs --ui --ui-port 0（stdout 100% 纯净 JSON-RPC、22 个工具、stderr 含 Web UI URL、exit 0）
 *   6. Antigravity Sidecar 插件与安装器（plugin.json、sidecar.json、node --check main.mjs、dry-run 与 --apply 仅写临时 GEMINI_CONFIG_DIR）
 *   7. 隔离守卫：~/.dsh/dsh-novel-writer/ 与 ~/.gemini/config/ 真实目录哈希全程一致
 *
 * 运行：node --test test/web-ui-v760-test.mjs
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
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

// ===========================================================================
// 严格隔离：先重定向 DSH_NOVEL_WRITER_STATE / DSH_HOME / GEMINI_CONFIG_DIR，再动态 import lib/*
// ===========================================================================

const PREV_STATE_ENV = process.env.DSH_NOVEL_WRITER_STATE;
const PREV_HOME_ENV = process.env.DSH_HOME;
const PREV_GEMINI_CONFIG_DIR = process.env.GEMINI_CONFIG_DIR;
const REAL_DSH_DIR = join(homedir(), ".dsh", "dsh-novel-writer");
const REAL_GEMINI_CONFIG_DIR = join(homedir(), ".gemini", "config");

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

const realDshBefore = digestTree(REAL_DSH_DIR);
const realGeminiBefore = digestTree(REAL_GEMINI_CONFIG_DIR);

const TMP_BASE = realpathSync.native(mkdtempSync(join(tmpdir(), "dsh-web-ui-v760-" + process.pid + "-")));
const STATE_FILE = join(TMP_BASE, "state.json");
const DSH_HOME_DIR = join(TMP_BASE, "dsh-home");

function restoreEnvAndCleanup() {
  if (PREV_STATE_ENV === void 0) delete process.env.DSH_NOVEL_WRITER_STATE;
  else process.env.DSH_NOVEL_WRITER_STATE = PREV_STATE_ENV;
  if (PREV_HOME_ENV === void 0) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_HOME_ENV;
  if (PREV_GEMINI_CONFIG_DIR === void 0) delete process.env.GEMINI_CONFIG_DIR;
  else process.env.GEMINI_CONFIG_DIR = PREV_GEMINI_CONFIG_DIR;
  try {
    rmSync(TMP_BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* 忽略清理错误 */
  }
}

process.on("exit", restoreEnvAndCleanup);
test.after(restoreEnvAndCleanup);

let buildUiRoutes;
let invokeRouteInMemory;
let startWebUiServer;
let ALL_TOOLS;
let METRIC_ORDER;

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

  ({ buildUiRoutes } = await import("../lib/tools/system.js"));
  ({ invokeRouteInMemory, startWebUiServer } = await import("../lib/web-ui.js"));
  ({ ALL_TOOLS } = await import("../lib/manifest.js"));
  ({ METRIC_ORDER } = await import("../lib/style-metrics.js"));
} catch (err) {
  restoreEnvAndCleanup();
  throw err;
}

// ===========================================================================
// 通用辅助函数
// ===========================================================================

function findRoute(routes, path) {
  const route = routes.find((r) => r && r.kind === "exact" && r.path === path);
  assert.ok(route, `应存在路由 ${path}`);
  return route;
}

/**
 * 以自定义 socket.remoteAddress 调用路由处理器，用于验证非回环源站拦截。
 */
async function invokeRouteWithSocket(route, { method = "GET", url, body, headers = {}, remoteAddress = "127.0.0.1" } = {}) {
  const reqHeaders = { host: "127.0.0.1", ...headers };
  const bodyBuf = body === void 0
    ? null
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  const req = {
    method,
    url: url || route.path,
    headers: reqHeaders,
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
  if ((headerMap.get("content-type") || "").includes("application/json") && text.length > 0) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  return { status: res.statusCode, headers: Object.fromEntries(headerMap.entries()), body: text, json };
}

function runCommandProcess(command, args, { env = process.env, input = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: REPO,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      rejectRun(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
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

    if (input !== null) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

function rawHttpGet({ port, path, headers = {} }) {
  return new Promise((resolveReq, rejectReq) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolveReq({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    req.on("error", rejectReq);
    req.end();
  });
}

/**
 * 构建供 /assets/react-shim.js 在 node:vm 中挂载、更新和卸载组件的最小 DOM 桩。
 */
function createMinimalDomStub() {
  function attachNodeHelpers(node) {
    node.childNodes = [];
    node.parentNode = null;
    Object.defineProperty(node, "firstChild", {
      get() { return this.childNodes[0] || null; }
    });
    Object.defineProperty(node, "lastChild", {
      get() { return this.childNodes[this.childNodes.length - 1] || null; }
    });
    Object.defineProperty(node, "previousSibling", {
      get() {
        if (!this.parentNode) return null;
        const idx = this.parentNode.childNodes.indexOf(this);
        return idx > 0 ? this.parentNode.childNodes[idx - 1] : null;
      }
    });
    Object.defineProperty(node, "nextSibling", {
      get() {
        if (!this.parentNode) return null;
        const idx = this.parentNode.childNodes.indexOf(this);
        return idx >= 0 && idx + 1 < this.parentNode.childNodes.length ? this.parentNode.childNodes[idx + 1] : null;
      }
    });
    return node;
  }

  function createTextNode(text) {
    const node = attachNodeHelpers({
      nodeType: 3,
      nodeValue: String(text),
      get textContent() { return this.nodeValue; },
      set textContent(v) { this.nodeValue = String(v); }
    });
    return node;
  }

  function createElement(tagName, namespaceURI = null) {
    const attrs = new Map();
    const listeners = new Map();
    const styleProps = new Map();
    const style = new Proxy({}, {
      set(_target, prop, value) {
        styleProps.set(String(prop), String(value));
        return true;
      },
      get(_target, prop) {
        if (prop === "setProperty") return (k, v) => styleProps.set(String(k), String(v));
        if (prop === "removeProperty") return (k) => styleProps.delete(String(k));
        return styleProps.get(String(prop)) || "";
      }
    });

    const el = attachNodeHelpers({
      nodeType: 1,
      tagName: String(tagName).toUpperCase(),
      namespaceURI,
      className: "",
      style,
      tabIndex: 0,
      value: "",
      checked: false,
      disabled: false,
      _attrs: attrs,
      _listeners: listeners,
      setAttribute(name, value) { attrs.set(String(name), String(value)); },
      getAttribute(name) { return attrs.has(String(name)) ? attrs.get(String(name)) : null; },
      removeAttribute(name) { attrs.delete(String(name)); },
      addEventListener(type, fn) {
        const key = String(type);
        if (!listeners.has(key)) listeners.set(key, new Set());
        listeners.get(key).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(String(type))?.delete(fn);
      },
      dispatchEvent(ev) {
        const key = String(ev?.type || "");
        for (const fn of listeners.get(key) || []) fn(ev);
        return true;
      },
      appendChild(child) {
        return el.insertBefore(child, null);
      },
      insertBefore(child, ref) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = el;
        if (ref && el.childNodes.includes(ref)) {
          el.childNodes.splice(el.childNodes.indexOf(ref), 0, child);
        } else {
          el.childNodes.push(child);
        }
        return child;
      },
      removeChild(child) {
        const idx = el.childNodes.indexOf(child);
        if (idx >= 0) {
          el.childNodes.splice(idx, 1);
          child.parentNode = null;
        }
        return child;
      },
      get textContent() {
        return el.childNodes.map((c) => c.textContent).join("");
      },
      set textContent(v) {
        for (const c of el.childNodes) c.parentNode = null;
        el.childNodes.length = 0;
        if (v !== "" && v !== null && v !== void 0) {
          el.appendChild(createTextNode(v));
        }
      },
      querySelectorByTag(targetTag) {
        const upper = String(targetTag).toUpperCase();
        for (const c of el.childNodes) {
          if (c.nodeType === 1) {
            if (c.tagName === upper) return c;
            const nested = c.querySelectorByTag(upper);
            if (nested) return nested;
          }
        }
        return null;
      }
    });
    return el;
  }

  return {
    createElement: (tag) => createElement(tag, null),
    createElementNS: (ns, tag) => createElement(tag, ns),
    createTextNode
  };
}

// ===========================================================================
// 1. /api/dsh-novel-writer/packs GET & POST
// ===========================================================================

test("1. /api/dsh-novel-writer/packs：GET 列包/警告/报错、POST 绑定/解绑、安全与方法守卫", async () => {
  const root = join(TMP_BASE, "root-packs");
  const book = "测试书";
  mkdirSync(join(root, "novels", book), { recursive: true });
  writeFileSync(join(root, "novels", book, "第01章.md"), "# 第一章\n\n夜色渐深，风声掠过窗棂。\n", "utf8");

  const customPacksDir = join(root, ".novel-writer", "packs");
  mkdirSync(customPacksDir, { recursive: true });
  writeFileSync(join(customPacksDir, "custom-pack.json"), JSON.stringify({
    id: "custom-pack",
    name: "自定义规则包",
    baseCulture: "western",
    speechStyle: {
      ritualBadPatterns: ["(a+)+$", "合理的模式\\d+"]
    }
  }, null, 2), "utf8");
  writeFileSync(join(customPacksDir, "broken-pack.json"), "{ not-valid-json", "utf8");

  const routes = buildUiRoutes({ root });
  const packsRoute = findRoute(routes, "/api/dsh-novel-writer/packs");

  // GET ?book=测试书
  const getRes1 = await invokeRouteInMemory(packsRoute, {
    method: "GET",
    url: `/api/dsh-novel-writer/packs?book=${encodeURIComponent(book)}`
  });
  assert.equal(getRes1.status, 200);
  assert.equal(getRes1.json.ok, true);
  assert.equal(getRes1.json.book, book);
  assert.equal(getRes1.json.boundPackId, "");
  assert.equal(getRes1.json.activePack, null);

  const packIds = new Set(getRes1.json.packs.map((p) => p.id));
  for (const expectedId of ["western-fantasy", "eastern-xianxia", "modern-urban", "mystery-thriller", "scifi-cyberpunk", "custom-pack"]) {
    assert.ok(packIds.has(expectedId), `packs 应包含 ${expectedId}`);
  }

  assert.ok(Array.isArray(getRes1.json.warnings) && getRes1.json.warnings.length > 0, "应上浮 ReDoS 警告");
  const customPack = getRes1.json.packs.find((p) => p.id === "custom-pack");
  assert.ok(customPack && Array.isArray(customPack.rejectedPatterns));
  assert.ok(customPack.rejectedPatterns.some((r) => r.pattern === "(a+)+$"), "应记录被剔除的 ReDoS 模式 (a+)+$");

  assert.ok(Array.isArray(getRes1.json.errors) && getRes1.json.errors.length > 0, "应上浮损坏 JSON 错误");
  assert.ok(getRes1.json.errors.some((e) => String(e.file).includes("broken-pack.json")), "errors 应指向 broken-pack.json");

  // POST 绑定 western-fantasy
  const bindRes = await invokeRouteInMemory(packsRoute, {
    method: "POST",
    url: "/api/dsh-novel-writer/packs",
    body: { book, pack: "western-fantasy" }
  });
  assert.equal(bindRes.status, 200);
  assert.equal(bindRes.json.ok, true);
  assert.equal(bindRes.json.updated, true);
  assert.equal(bindRes.json.matched, true);
  assert.equal(bindRes.json.boundPackId, "western-fantasy");
  assert.equal(bindRes.json.activePack?.id, "western-fantasy");

  const settingsOnDisk = JSON.parse(readFileSync(join(root, ".novel-writer", "settings", `${book}.json`), "utf8"));
  assert.ok(Array.isArray(settingsOnDisk.worldview));
  assert.ok(settingsOnDisk.worldview.some((w) => w && w.pack === "western-fantasy"), "settings.worldview 应写入 pack 绑定");

  // 随后 GET 校验绑定持久化生效
  const getRes2 = await invokeRouteInMemory(packsRoute, {
    method: "GET",
    url: `/api/dsh-novel-writer/packs?book=${encodeURIComponent(book)}`
  });
  assert.equal(getRes2.status, 200);
  assert.equal(getRes2.json.boundPackId, "western-fantasy");
  assert.equal(getRes2.json.activePack?.id, "western-fantasy");

  // POST 解绑 pack: ""
  const unbindRes = await invokeRouteInMemory(packsRoute, {
    method: "POST",
    url: "/api/dsh-novel-writer/packs",
    body: { book, pack: "" }
  });
  assert.equal(unbindRes.status, 200);
  assert.equal(unbindRes.json.ok, true);
  assert.equal(unbindRes.json.updated, true);
  assert.equal(unbindRes.json.boundPackId, "");
  assert.equal(unbindRes.json.activePack, null);

  // 非法 pack ID -> 400
  for (const badId of ["../evil", "bad/id"]) {
    const badRes = await invokeRouteInMemory(packsRoute, {
      method: "POST",
      url: "/api/dsh-novel-writer/packs",
      body: { book, pack: badId }
    });
    assert.equal(badRes.status, 400, `非法 packId ${badId} 应返回 400`);
    assert.equal(badRes.json.ok, false);
  }

  // allowLanState: true 下，POST 仍必须强制仅回环（403）
  const lanRoutes = buildUiRoutes({ root, allowLanState: true });
  const lanPacksRoute = findRoute(lanRoutes, "/api/dsh-novel-writer/packs");

  const remotePost = await invokeRouteWithSocket(lanPacksRoute, {
    method: "POST",
    url: "/api/dsh-novel-writer/packs",
    headers: { host: "10.0.0.5" },
    remoteAddress: "10.0.0.5",
    body: { book, pack: "western-fantasy" }
  });
  assert.equal(remotePost.status, 403, "allowLanState=true 时非回环 POST 仍须拒绝 403");

  const forgedHostPost = await invokeRouteInMemory(lanPacksRoute, {
    method: "POST",
    url: "/api/dsh-novel-writer/packs",
    headers: { host: "evil.example.com" },
    body: { book, pack: "western-fantasy" }
  });
  assert.equal(forgedHostPost.status, 403, "allowLanState=true 时伪造 Host 的 POST 仍须拒绝 403");

  // DELETE / PUT -> 405
  for (const method of ["DELETE", "PUT"]) {
    const mRes = await invokeRouteInMemory(packsRoute, { method, url: "/api/dsh-novel-writer/packs" });
    assert.equal(mRes.status, 405, `${method} 应返回 405`);
  }
});

// ===========================================================================
// 2. /api/dsh-novel-writer/baseline sceneBaselines（严格只读）
// ===========================================================================

test("2. /api/dsh-novel-writer/baseline：3+3+3 场景带只读估算且不写盘，缺书返回 null", async () => {
  const root = join(TMP_BASE, "root-baseline");
  const book = "场景混合录";
  const bDir = join(root, "novels", book);
  mkdirSync(bDir, { recursive: true });

  const chapters = [
    ["第01章.md", "# 第一章 茶室长谈\n\n“今夜江上风势很急，北岸渡口恐怕多半早早歇业，此时冒雨前去未必妥当。”林晚缓缓说道。\n\n“话虽不错，城南老铺的陈年旧账明日清晨便须封存，错过今宵就难办了。”沈砚轻声回答。\n\n“如此，明日黎明先请稳妥之人绕道城西茶坊探听实情，余下事宜天亮后再作详细打算。”\n"],
    ["第02章.md", "# 第二章 窗前对语\n\n“昨日盐运司的文书之中，三处岸口总数颇多疏漏，仿佛有人曾经私下改动。”苏晴问。\n\n“确实古怪，症结大约只在去年冬月那几艘空货船上，彼时竟无半枚私章印记。”顾衡答。\n\n“清晨先清点当年原本与副本，省得日后当堂对质彼此只剩下空口无凭。”\n"],
    ["第03章.md", "# 第三章 密议\n\n“东巷那处老宅地契原本三十年一期，今春刚满头季，管事却急忙催众人搬迁。”周明道。\n\n“左邻右舍昨夜也曾议论，月底深更曾经几辆青布马车静静停在西门附近。”陈墨道。\n\n“务必先把街角茶铺掌柜稳住，请他留神近日各方往来客商，余事万勿泄漏。”\n"],
    ["第04章.md", "# 第四章 巷战突围\n\n他拔剑刺踢砍劈，黑影躲闪砸撞，他跃起劈断绳索撞翻木架，滚开躲避飞矢挥刀斩杀敌兵，夺剑挑飞灯笼跃上屋檐！\n\n伏兵扑来围攻，他拧腰甩开对手猛刺劈砍，抢过短刀横斩击倒刺客，反手砸碎砖瓦踹翻追兵突围而出！\n"],
    ["第05章.md", "# 第五章 屋脊追击\n\n刺客跃上瓦檐甩出飞爪，他紧追踏碎青瓦凌空劈剑，刺客落地翻滚掷出短匕横斩！\n\n他举剑格挡猛踹胸口，夺匕反刺压制刺客，再踢起木桶砸翻伏兵，挥刀劈退追兵冲入夜巷！\n"],
    ["第06章.md", "# 第六章 码头夺船\n\n他潜行割断缆绳爬上甲板，飞脚踹倒哨兵夺刀猛砍！水手挥斧劈来，他闪身格挡猛踢腰腹。\n\n他反手掷出匕首刺中船夫，挥刀斩断索具砍退追兵，纵身扑入舵室撞开木门逃出港湾！\n"],
    ["第07章.md", "# 第七章 雨夜书房\n\n他站在窗前，看着雨水沿着玻璃往下淌，屋里的钟轻轻敲了三下。母亲坐在灯下缝着旧衣，偶尔抬头望他一眼，又低下头去。\n\n桌上那杯茶早已凉透，他伸手端起来抿了一口，转身走回书案旁坐下。窗外的风吹落几片树叶，院门轻轻晃动着，远处传来狗叫声。\n\n他打开抽屉取出旧信，翻了两页便合上，靠在椅背上闭目养神，心里想着明天要去镇上办事，顺道去看看老友。\n"],
    ["第08章.md", "# 第八章 长街漫步\n\n清晨的薄雾刚散，她提着竹篮走出巷口，顺着青石板路慢慢往早市走去。街角的茶铺刚揭开木板门，伙计正往炉子里添炭生火。\n\n她站在摊位前挑了两捆青菜，又到隔壁铺子称了半斤芝麻糖，笑着同老板娘寒暄几句后才拎起篮子往回走。\n\n回到小院时阳光正照在石阶上，她推开堂屋门把菜放进厨房，坐到廊下翻开账本记完今晨的花销，抬头望见檐下的燕子正来回忙碌。\n"],
    ["第09章.md", "# 第九章 书院午后\n\n午后的阳光透过窗格洒在青砖地上，他沿着长廊慢慢走过花坛，听见讲堂里传来先生低沉的诵读声。\n\n他停在石桌旁整理书箱，把刚借来的几册旧书放回竹筐，转身望向院墙外缓缓飘过的云影，坐下沏了半壶清茶慢慢饮完。\n"]
  ];
  for (const [name, content] of chapters) {
    writeFileSync(join(bDir, name), content, "utf8");
  }

  const routes = buildUiRoutes({ root });
  const baselineRoute = findRoute(routes, "/api/dsh-novel-writer/baseline");

  const res = await invokeRouteInMemory(baselineRoute, {
    method: "GET",
    url: `/api/dsh-novel-writer/baseline?book=${encodeURIComponent(book)}`
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  const sb = res.json.sceneBaselines;
  assert.ok(sb && typeof sb === "object", "应返回 sceneBaselines");
  assert.deepEqual(sb.counts, { dialogue: 3, action: 3, narrative: 3 });
  assert.deepEqual([...sb.availableBands].sort(), ["action", "dialogue", "narrative"]);
  assert.equal(sb.minPeerChapters, 3);
  assert.equal(sb.fromCache, false);

  for (const band of ["dialogue", "action", "narrative"]) {
    const bandObj = sb.bands?.[band];
    assert.ok(bandObj && bandObj.baseline, `应包含 ${band} 基线`);
    for (const dim of METRIC_ORDER) {
      assert.equal(typeof bandObj.baseline[dim]?.mu, "number", `${band}.baseline.${dim}.mu 应为数字`);
    }
  }

  assert.equal(existsSync(join(root, ".novel-writer", "analysis")), false, "baseline GET 绝不能写盘生成 analysis 缓存");

  // 不存在的书籍目录 -> 200 + sceneBaselines: null
  const missingRes = await invokeRouteInMemory(baselineRoute, {
    method: "GET",
    url: "/api/dsh-novel-writer/baseline?book=%E4%B8%8D%E5%AD%98%E5%9C%A8%E4%B9%A6"
  });
  assert.equal(missingRes.status, 200);
  assert.equal(missingRes.json.ok, true);
  assert.equal(missingRes.json.sceneBaselines, null);
});

// ===========================================================================
// 3. /api/dsh-novel-writer/reveal packs-dir 白名单校验（不弹出资源管理器）
// ===========================================================================

test("3. /api/dsh-novel-writer/reveal：未知 target 披露 packs-dir 白名单，不弹窗", async () => {
  const root = join(TMP_BASE, "root-reveal");
  mkdirSync(root, { recursive: true });
  const routes = buildUiRoutes({ root });
  const revealRoute = findRoute(routes, "/api/dsh-novel-writer/reveal");

  const badTarget = await invokeRouteInMemory(revealRoute, {
    method: "POST",
    url: "/api/dsh-novel-writer/reveal",
    body: { target: "not-a-target" }
  });
  assert.equal(badTarget.status, 400);
  assert.match(badTarget.json.error, /allowed:.*packs-dir/, "allowed 列表应包含 packs-dir");

  const getRes = await invokeRouteInMemory(revealRoute, {
    method: "GET",
    url: "/api/dsh-novel-writer/reveal"
  });
  assert.equal(getRes.status, 405);

  const forgedHost = await invokeRouteInMemory(revealRoute, {
    method: "POST",
    url: "/api/dsh-novel-writer/reveal",
    headers: { host: "evil.example.com" },
    body: { target: "not-a-target" }
  });
  assert.equal(forgedHost.status, 403);
});

// ===========================================================================
// 4. 独立 Web UI 服务器（lib/web-ui.js）与 react-shim.js vm 验证
// ===========================================================================

test("4. startWebUiServer：全路由 200/404、Host 校验 403、react-shim.js vm 组件挂载与卸载", async () => {
  const root = join(TMP_BASE, "root-webui");
  mkdirSync(root, { recursive: true });

  const srv = await startWebUiServer({ root, port: 0 });
  try {
    assert.equal(srv.host, "127.0.0.1");
    assert.ok(Number.isInteger(srv.port) && srv.port > 0, "应分配有效空闲端口");
    assert.equal(srv.url, `http://127.0.0.1:${srv.port}`);

    const endpoints = [
      { path: "/", type: "text/html" },
      { path: "/healthz", type: "application/json" },
      { path: "/assets/theme.css", type: "text/css" },
      { path: "/assets/react-shim.js", type: "application/javascript" },
      { path: "/assets/bootstrap.js", type: "application/javascript" },
      { path: "/assets/client.js", type: "application/javascript" },
      { path: "/preload.js", type: "application/javascript" },
      { path: "/api/dsh-novel-writer/state", type: "application/json" }
    ];

    let reactShimCode = "";
    for (const ep of endpoints) {
      const resp = await fetch(`${srv.url}${ep.path}`);
      assert.equal(resp.status, 200, `GET ${ep.path} 应返回 200`);
      const ct = resp.headers.get("content-type") || "";
      assert.ok(ct.includes(ep.type), `GET ${ep.path} Content-Type 应包含 ${ep.type}，实际：${ct}`);
      const body = await resp.text();
      assert.ok(body.length > 0, `GET ${ep.path} 响应体不能为空`);
      if (ep.path === "/assets/react-shim.js") reactShimCode = body;
      if (ep.path === "/healthz") {
        const hz = JSON.parse(body);
        assert.equal(hz.ok, true);
        assert.equal(hz.service, "dsh-novel-writer-ui");
      }
    }

    const notFound = await fetch(`${srv.url}/does-not-exist-v760`);
    assert.equal(notFound.status, 404);

    // 原始 HTTP 请求伪造 Host -> 403
    const forged = await rawHttpGet({
      port: srv.port,
      path: "/healthz",
      headers: { Host: "evil.example.com" }
    });
    assert.equal(forged.statusCode, 403, "伪造 Host 请求必须被拦截 403");

    // 在 node:vm 中执行 /assets/react-shim.js 验证 hooks 与生命周期
    const documentStub = createMinimalDomStub();
    const sandbox = {
      window: null,
      document: documentStub,
      console,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      Promise
    };
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(reactShimCode, context, { filename: "react-shim.js" });

    const React = context.window.__NW_REACT__;
    const ReactDOMClient = context.window.__NW_REACT_DOM_CLIENT__;
    assert.ok(React && ReactDOMClient, "应暴露 __NW_REACT__ 与 __NW_REACT_DOM_CLIENT__");
    for (const apiName of ["createElement", "cloneElement", "isValidElement", "useState", "useEffect", "useRef", "useId", "Fragment"]) {
      assert.ok(apiName in React, `__NW_REACT__ 应包含 ${apiName}`);
    }
    assert.equal(typeof ReactDOMClient.createRoot, "function");

    const effectLog = { runs: 0, cleanups: 0, seenIds: [] };
    function CounterWidget() {
      const [count, setCount] = React.useState(0);
      const ref = React.useRef(null);
      const id = React.useId();
      React.useEffect(() => {
        effectLog.runs += 1;
        effectLog.seenIds.push(id);
        return () => {
          effectLog.cleanups += 1;
        };
      }, [count]);
      const rawBtn = React.createElement("button", { id, onClick: () => setCount((c) => c + 1) }, `Count:${count}`);
      assert.equal(React.isValidElement(rawBtn), true);
      const clonedBtn = React.cloneElement(rawBtn, { ref });
      return React.createElement(React.Fragment, null, clonedBtn);
    }

    const container = documentStub.createElement("div");
    const rootHandle = ReactDOMClient.createRoot(container);
    rootHandle.render(React.createElement(CounterWidget, null));

    const btn = container.querySelectorByTag("button");
    assert.ok(btn, "应成功挂载 button 节点");
    assert.equal(btn.textContent, "Count:0");
    assert.equal(effectLog.runs, 1);
    assert.equal(effectLog.cleanups, 0);

    // 触发点击并等待 queueMicrotask 刷新
    btn.dispatchEvent({ type: "click" });
    await new Promise((r) => setTimeout(r, 15));

    assert.equal(container.querySelectorByTag("button").textContent, "Count:1");
    assert.equal(effectLog.cleanups, 1, "重渲染 effect 应先执行上一次 cleanup");
    assert.equal(effectLog.runs, 2, "重渲染应重新触发 useEffect");
    assert.equal(effectLog.seenIds[0], effectLog.seenIds[1], "useId 在同一组件实例内应稳定");

    rootHandle.unmount();
    assert.equal(effectLog.cleanups, 2, "unmount() 应触发最后一次 effect cleanup");
    assert.equal(container.childNodes.length, 0, "unmount() 后容器应被清空");
  } finally {
    await srv.close();
  }

  await assert.rejects(() => fetch(`${srv.url}/healthz`), "close() 后服务应已关闭拒绝连接");
});

// ===========================================================================
// 5. MCP --ui --ui-port 0 stdout 纯净度与 stderr URL
// ===========================================================================

test("5. mcp/server.mjs --ui --ui-port 0：stdout 纯 JSON-RPC、22 个工具、stderr 含 URL", async () => {
  const root = join(TMP_BASE, "root-mcp-ui");
  mkdirSync(root, { recursive: true });

  const rpcInput = [
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1.0" } }
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping", params: {} })
  ].join("\n") + "\n";

  const res = await runCommandProcess(
    process.execPath,
    [join(REPO, "mcp", "server.mjs"), "--root", root, "--ui", "--ui-port", "0"],
    {
      env: {
        ...process.env,
        DSH_NOVEL_WRITER_STATE: STATE_FILE,
        DSH_HOME: DSH_HOME_DIR
      },
      input: rpcInput
    }
  );

  assert.equal(res.code, 0, `MCP --ui 应正常退出 0，stderr: ${res.stderr}`);
  assert.match(res.stderr, /http:\/\/127\.0\.0\.1:\d+/, "stderr 应输出独立 Web UI 地址");

  const lines = res.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  assert.equal(lines.length, 3, "应精确返回 initialize / tools/list / ping 三条 JSON-RPC 响应");

  const frames = lines.map((line, idx) => {
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(line);
    }, `stdout 第 ${idx + 1} 行必须是合法 JSON：${line}`);
    assert.equal(parsed.jsonrpc, "2.0");
    return parsed;
  });

  const toolsFrame = frames.find((f) => f.id === 2);
  assert.ok(toolsFrame?.result && Array.isArray(toolsFrame.result.tools));
  assert.equal(toolsFrame.result.tools.length, ALL_TOOLS.length);
  assert.equal(toolsFrame.result.tools.length, 22);

  const pingFrame = frames.find((f) => f.id === 3);
  assert.deepEqual(pingFrame?.result, {});
});

// ===========================================================================
// 6. Antigravity Sidecar 插件与安装器
// ===========================================================================

test("6. Antigravity Sidecar 清单校验、main.mjs 语法与安装器 dry-run / --apply 隔离验证", async () => {
  const pluginJson = JSON.parse(readFileSync(join(REPO, "antigravity", "plugin.json"), "utf8"));
  assert.equal(pluginJson.name, "dsh-novel-writer-ui");

  const sidecarJson = JSON.parse(readFileSync(join(REPO, "antigravity", "sidecars", "panel", "sidecar.json"), "utf8"));
  assert.equal(sidecarJson.has_web_ui, true);
  assert.equal(sidecarJson.ui_config?.views?.[0]?.entrypoint, "SIDECAR_UI_ENTRYPOINT_AUX_PANE");

  const mainMjs = join(REPO, "antigravity", "sidecars", "panel", "main.mjs");
  const syntaxRes = await runCommandProcess(process.execPath, ["--check", mainMjs]);
  assert.equal(syntaxRes.code, 0, `node --check main.mjs 失败：${syntaxRes.stderr}`);

  const geminiConfigDir = join(TMP_BASE, "gemini-config");
  const libraryRoot = join(TMP_BASE, "antigravity-lib");
  mkdirSync(geminiConfigDir, { recursive: true });
  mkdirSync(libraryRoot, { recursive: true });

  const installerPath = join(REPO, "tools", "install-antigravity-ui.mjs");
  const isolatedEnv = {
    ...process.env,
    GEMINI_CONFIG_DIR: geminiConfigDir,
    DSH_NOVEL_WRITER_STATE: STATE_FILE,
    DSH_HOME: DSH_HOME_DIR
  };

  // dry-run 不应写入任何文件
  const dryRes = await runCommandProcess(process.execPath, [installerPath], { env: isolatedEnv });
  assert.equal(dryRes.code, 0, `dry-run 失败：${dryRes.stderr}`);
  assert.match(dryRes.stdout, /\[dry-run\]/);
  const pluginDest = join(geminiConfigDir, "plugins", "dsh-novel-writer-ui");
  assert.equal(existsSync(pluginDest), false, "dry-run 绝不能创建目标插件目录");

  // --apply --root 应仅写入临时 GEMINI_CONFIG_DIR
  const applyRes = await runCommandProcess(
    process.execPath,
    [installerPath, "--apply", "--root", libraryRoot],
    { env: isolatedEnv }
  );
  assert.equal(applyRes.code, 0, `--apply 失败：${applyRes.stderr}`);

  for (const rel of [
    "plugin.json",
    join("assets", "logo.svg"),
    join("sidecars", "panel", "sidecar.json"),
    join("sidecars", "panel", "main.mjs"),
    join("sidecars", "panel", "config.json")
  ]) {
    assert.equal(existsSync(join(pluginDest, rel)), true, `已安装目录应包含 ${rel}`);
  }

  const installedCfg = JSON.parse(readFileSync(join(pluginDest, "sidecars", "panel", "config.json"), "utf8"));
  assert.equal(installedCfg.pluginDir, REPO);
  assert.equal(installedCfg.root, libraryRoot);
  assert.equal(existsSync(join(geminiConfigDir, "config.json")), false, "绝不能创建或修改根 config.json");
});

// ===========================================================================
// 7. 隔离守卫
// ===========================================================================

test("7. 隔离守卫：用户真实 ~/.dsh/dsh-novel-writer/ 与 ~/.gemini/config/ 目录全程未被修改", () => {
  const realDshAfter = digestTree(REAL_DSH_DIR);
  const realGeminiAfter = digestTree(REAL_GEMINI_CONFIG_DIR);
  assert.deepEqual(realDshAfter, realDshBefore, "测试全程绝不能改动用户真实 ~/.dsh/dsh-novel-writer/ 目录");
  assert.deepEqual(realGeminiAfter, realGeminiBefore, "测试全程绝不能改动用户真实 ~/.gemini/config/ 目录");
});
