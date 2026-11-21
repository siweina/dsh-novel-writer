/**
 * test/v820-audit-fixes-test.mjs —— v8.2.0 全面审计加固回归测试套件
 *
 * 覆盖五大子系统分组：
 *   1. Host / Sidecar / HTTP / MCP Security (#1, #2, #4, #5, #104-#109, #112, #141, #167, #168)
 *   2. Storage, ReDoS, Packs, Trash & Logs (#6-#9, #39-#43, #45-#49, #143, #144, #149-#151)
 *   3. Domain Core & Lexicons (#12-#17, #51-#57, #142, #154)
 *   4. Engines & Writing Loop (#3, #18-#30, #58-#86, #145, #160, #161)
 *   5. Tools Layer & Frontend Bundle (#10, #11, #31-#38, #87, #88, #91-#103, #132, #136, #137, #146, #148, #164, #165, #169, #196)
 *
 * 隔离保证：
 *   - 动态 import 任何 lib/* 之前，把 DSH_NOVEL_WRITER_STATE 与 DSH_HOME 全部指向 os.tmpdir() 独立临时目录；
 *   - 启动前对真实 ~/.dsh/dsh-novel-writer 与 ~/.gemini/config 做递归 SHA-256 快照，末尾隔离守卫用例断言零字节改动；
 *   - test.after 与 process.on("exit") 双重清理临时目录并恢复环境变量。
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
  symlinkSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// ─────────────────────────────────────────────────────────────────────────────
// 严格环境隔离（必须在导入任何 lib/* 之前执行）
// ─────────────────────────────────────────────────────────────────────────────

const PREV_STATE_ENV = process.env.DSH_NOVEL_WRITER_STATE;
const PREV_HOME_ENV = process.env.DSH_HOME;

const REAL_DSH_DIR = join(homedir(), ".dsh", "dsh-novel-writer");
const REAL_GEMINI_CONFIG_DIR = join(homedir(), ".gemini", "config");

function digestTree(dir) {
  if (!existsSync(dir)) return "absent";
  const entries = [];
  const walk = (base, rel) => {
    let items;
    try { items = readdirSync(base, { withFileTypes: true }); } catch { entries.push(rel + ":unreadable"); return; }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of items) {
      const full = join(base, e.name);
      const sub = rel === "" ? e.name : rel + "/" + e.name;
      if (e.isDirectory()) {
        entries.push(sub + "/");
        walk(full, sub);
      } else if (e.isFile()) {
        try {
          const h = createHash("sha256").update(readFileSync(full)).digest("hex");
          entries.push(sub + ":" + h);
        } catch {
          entries.push(sub + ":unreadable");
        }
      } else {
        try {
          const st = lstatSync(full);
          entries.push(sub + ":other:" + st.size);
        } catch {
          entries.push(sub + ":other");
        }
      }
    }
  };
  walk(dir, "");
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

const realBefore = {
  dsh: digestTree(REAL_DSH_DIR),
  geminiConfig: digestTree(REAL_GEMINI_CONFIG_DIR)
};

const TMP_BASE = realpathSync.native(mkdtempSync(join(tmpdir(), "dsh-nw-v820-" + process.pid + "-")));
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
  try { rmSync(TMP_BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
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

// 动态加载全部待测模块（位于 env 隔离之后）
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PLUGIN = await import("../lib/index.js");
const CORE = await import("../lib/core.js");
const WEB_UI = await import("../lib/web-ui.js");
const TRASH = await import("../lib/trash.js");
const BOOKDELETE = await import("../lib/bookdelete.js");
const LOG = await import("../lib/log.js");
const SLOP = await import("../lib/lexicons/slop.js");
const ANALYSIS = await import("../lib/analysis.js");
const VEC = await import("../lib/vector-audit.js");
const FIXPLAN = await import("../lib/fixplan.js");
const BRIEF = await import("../lib/brief.js");
const DIAG = await import("../lib/chapter-diagnose.js");
const OBL = await import("../lib/obligations.js");
const PROMPTS = await import("../lib/prompts.js");
const AUDIT = await import("../lib/audit.js");
const GRAPH = await import("../lib/graph.js");
const RAWGUARD = await import("../lib/rawguard.js");
const UPDATE = await import("../lib/update-check.js");
const DIAGNOSE = await import("../lib/diagnose.js");
const VIBE = await import("../lib/vibe.js");
const METRICS = await import("../lib/style-metrics.js");
const EXPLICIT = await import("../lib/explicit.js");
const STORY_TOOLS = await import("../lib/tools/story.js");

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
  PLUGIN.apply(ctx, {
    root,
    sentenceAnalysis: { enabled: true, autoAnalyze: true },
    allowLanState: false,
    ...extraConfig
  });
  const defs = Object.fromEntries(registry.map((d) => [d.name, d]));
  const exec = { agent: { session: { header: { cwd: root } } } };
  const routeOf = (path) => routes.find((r) => r.path === path);
  return { defs, exec, routes, routeOf };
}

function mkRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
    },
    writeHead(s, h) {
      this.status = s;
      if (h && typeof h === "object") this.headers = { ...this.headers, ...h };
    },
    end(b) {
      this.body = b === void 0 || b === null ? "" : (Buffer.isBuffer(b) ? b.toString("utf8") : String(b));
    }
  };
}

function mkReq(path, method = "GET", bodyPayload, extraHeaders, remoteAddress = "127.0.0.1") {
  const req = {
    method,
    url: path,
    socket: { remoteAddress },
    headers: { host: remoteAddress === "127.0.0.1" ? "127.0.0.1:3847" : `${remoteAddress}:3847`, ...(extraHeaders || {}) }
  };
  if (bodyPayload !== void 0) {
    const chunk = Buffer.isBuffer(bodyPayload) ? bodyPayload : Buffer.from(String(bodyPayload));
    req[Symbol.asyncIterator] = async function* () { yield chunk; };
  }
  return req;
}

function createMinimalDomStub() {
  class NodeStub {
    constructor(nodeType, tagName = "") {
      this.nodeType = nodeType;
      this.tagName = tagName;
      this.parentNode = null;
      this.childNodes = [];
      this.attributes = Object.create(null);
      this.listeners = Object.create(null);
      this.style = Object.create(null);
      this.dataset = Object.create(null);
      this.className = "";
      this._text = "";
    }
    get firstChild() { return this.childNodes[0] || null; }
    get textContent() {
      if (this.nodeType === 3) return this._text;
      return this.childNodes.map((c) => c.textContent).join("");
    }
    set textContent(v) {
      if (this.nodeType === 3) { this._text = String(v ?? ""); return; }
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = [];
      const s = String(v ?? "");
      if (s !== "") {
        const t = new NodeStub(3);
        t._text = s;
        this.appendChild(t);
      }
    }
    get nodeValue() { return this._text; }
    set nodeValue(v) { this._text = String(v ?? ""); }
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === "class") this.className = String(v); }
    removeAttribute(k) { delete this.attributes[k]; if (k === "class") this.className = ""; }
    getAttribute(k) { return this.attributes[k] ?? null; }
    addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
    removeEventListener(k, fn) {
      if (!this.listeners[k]) return;
      this.listeners[k] = this.listeners[k].filter((f) => f !== fn);
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    insertBefore(child, ref) {
      if (!ref) return this.appendChild(child);
      if (child.parentNode) child.parentNode.removeChild(child);
      const idx = this.childNodes.indexOf(ref);
      child.parentNode = this;
      if (idx === -1) this.childNodes.push(child);
      else this.childNodes.splice(idx, 0, child);
      return child;
    }
    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx !== -1) this.childNodes.splice(idx, 1);
      child.parentNode = null;
      return child;
    }
    replaceChild(next, old) {
      const idx = this.childNodes.indexOf(old);
      if (idx === -1) return this.appendChild(next);
      if (next.parentNode) next.parentNode.removeChild(next);
      old.parentNode = null;
      next.parentNode = this;
      this.childNodes[idx] = next;
      return old;
    }
    contains(target) {
      let cur = target;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }
  }
  const head = new NodeStub(1, "HEAD");
  const body = new NodeStub(1, "BODY");
  const docEl = new NodeStub(1, "HTML");
  docEl.lang = "zh-CN";
  docEl.appendChild(head);
  docEl.appendChild(body);
  const doc = {
    documentElement: docEl,
    head,
    body,
    createElement: (tag) => new NodeStub(1, String(tag).toUpperCase()),
    createElementNS: (_ns, tag) => new NodeStub(1, String(tag)),
    createTextNode: (t) => { const n = new NodeStub(3); n._text = String(t ?? ""); return n; },
    createDocumentFragment: () => new NodeStub(11, "#fragment"),
    querySelector: () => null,
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  return { NodeStub, document: doc };
}

// 公共中文语料片段（长度 ≥ 60 字，满足各模块最小段落/章节长度阈值）
const PARA_PROSE_A = "夜雨顺着青瓦檐角滴落，把石阶冲刷得泛出冷光。他蹲在廊柱旁拆开油纸包，用指腹抹去铜牌边沿的水渍，再把暗纹朝内塞进袖袋。";
const PARA_PROSE_B = "茶馆二楼靠窗的方桌只剩半壶残茶，掌柜拎着紫铜长嘴壶走过来，壶口升起细白水汽，将桌角那本线装账簿熏得微微卷边。";
const PARA_PROSE_C = "巷口深处响起三声竹梆，紧接着铁锁落地的闷响传过半条石街，巡夜灯笼在转角停住，将长影拖到门坎前。";

// ===========================================================================
// Group 1: Host / Sidecar / HTTP / MCP Security
// (#1, #2, #4, #5, #104, #105, #106, #107, #108, #109, #112, #141, #167, #168)
// ===========================================================================

test("G1-1 (#1): BOOTSTRAP_JS 同步 inSidecarFetch 重入守卫阻止无限递归并精确回落 nativeFetch 1 次", async () => {
  const handler = WEB_UI.createWebUiRequestHandler({});
  const res = mkRes();
  await handler(mkReq("/assets/bootstrap.js", "GET"), res);
  assert.equal(res.status, 200);
  const bootstrapCode = res.body;
  assert.match(bootstrapCode, /inSidecarFetch/, "BOOTSTRAP_JS 应包含同步 inSidecarFetch 重入标志");

  let nativeCalls = 0;
  let sidecarCalls = 0;
  const nativeFetch = async (input, init) => {
    nativeCalls += 1;
    return { ok: true, status: 200, url: String(input), init };
  };
  const { document } = createMinimalDomStub();
  const sandbox = {
    console,
    Promise,
    URL,
    Headers,
    Response,
    Request,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    document,
    location: { origin: "http://127.0.0.1:3847", href: "http://127.0.0.1:3847/" },
    fetch: nativeFetch,
    sidecar: {
      fetch: async (url, init) => {
        sidecarCalls += 1;
        // 故意重入全局 window.fetch —— 若无同步守卫必然爆栈
        return await sandbox.window.fetch(url, init);
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(bootstrapCode, sandbox, { filename: "bootstrap.js" });

  const r1 = await sandbox.window.fetch("/api/dsh-novel-writer/state");
  assert.equal(r1.status, 200);
  assert.equal(sidecarCalls, 1, "首次请求应进入 sidecar.fetch 1 次");
  assert.equal(nativeCalls, 1, "重入后必须直接回落 nativeFetch 恰好 1 次且零爆栈");

  // 确认 finally 正确复位 inSidecarFetch，第二次请求仍能正常走 sidecar.fetch
  const r2 = await sandbox.window.fetch("/api/dsh-novel-writer/state");
  assert.equal(r2.status, 200);
  assert.equal(sidecarCalls, 2, "finally 复位后下次请求应再次经由 sidecar.fetch");
  assert.equal(nativeCalls, 2);
});

test("G1-2 (#2, #105): web-ui 与 panel sidecar 默认不把 cwd 钉死为 config.root，且 sidecar 忽略大小写剥离 content-type", async () => {
  const webUiSrc = readFileSync(join(REPO_ROOT, "lib", "web-ui.js"), "utf8");
  const sidecarSrc = readFileSync(join(REPO_ROOT, "antigravity", "sidecars", "panel", "main.mjs"), "utf8");

  assert.match(webUiSrc, /const root = rawRoot !== "" \? resolve\(rawRoot\) : "";/, "parseCliArgs 默认 root 必须为空字符串而非 process.cwd()");
  assert.doesNotMatch(webUiSrc, /rawRoot[^;]*process\.cwd\(\)/, "web-ui parseCliArgs 不得把 cwd 写死为默认 root");

  assert.match(sidecarSrc, /const root = rawRoot !== "" \? resolve\(rawRoot\) : "";/, "sidecar 未设 root 时必须保持空串");
  assert.doesNotMatch(sidecarSrc, /process\.cwd\(\)/, "sidecar 不得将 process.cwd() 钉死为 config.root");
  assert.match(sidecarSrc, /String\(k\)\.toLowerCase\(\) === "content-type"/, "sidecar 必须大小写不敏感地剥离 content-type 响应头");

  // 运行期校验：空 options 创建的 web-ui handler 不得将 rootSource 钉成 "config"
  resetStateFile();
  const handler = WEB_UI.createWebUiRequestHandler({});
  const res = mkRes();
  await handler(mkReq("/api/dsh-novel-writer/state", "GET"), res);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.notEqual(body.rootSource, "config", "未显式传 root 时不应被钉死为 config 来源");
});

test("G1-3 (#4, #106, #141, #167, #168): makeStateRoutes LAN 写封锁、queryRoot 忽略、packsDir、lexicon/baseline 校验与 Host 伪造拒收", async () => {
  const rootA = freshLib("http-a");
  const rootB = freshLib("http-b");
  const routes = CORE.makeStateRoutes(true, { root: rootA });
  const byPath = Object.fromEntries(routes.map((r) => [r.path, r.handler]));

  // 1) LAN (192.168.1.50) 上所有写操作与 /reveal 一律 403
  for (const [path, payload] of [
    ["/api/dsh-novel-writer/state", JSON.stringify({ enabled: false })],
    ["/api/dsh-novel-writer/reports", JSON.stringify({ action: "forget", file: "x.json" })],
    ["/api/dsh-novel-writer/lexicon", JSON.stringify({ op: "save", scope: "global", entries: [] })],
    ["/api/dsh-novel-writer/baseline", JSON.stringify({ book: "测试书", mode: "all" })],
    ["/api/dsh-novel-writer/reveal", JSON.stringify({ target: "data-dir" })]
  ]) {
    const res = mkRes();
    await byPath[path](mkReq(path, "POST", payload, {}, "192.168.1.50"), res);
    assert.equal(res.status, 403, `LAN POST ${path} 必须返回 403`);
  }

  // 2) LAN GET /state?root=rootB 必须忽略 queryRoot
  {
    const res = mkRes();
    await byPath["/api/dsh-novel-writer/state"](
      mkReq(`/api/dsh-novel-writer/state?root=${encodeURIComponent(rootB)}`, "GET", void 0, {}, "192.168.1.50"),
      res
    );
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.root, rootA, "非回环请求必须忽略 queryRoot，不得暴露任意路径");
  }

  // 3) Loopback GET /state 返回 dirs.packsDir
  {
    const res = mkRes();
    await byPath["/api/dsh-novel-writer/state"](mkReq("/api/dsh-novel-writer/state", "GET"), res);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(typeof data.dirs?.packsDir, "string");
    assert.equal(data.dirs.packsDir, join(CORE.novelDataDir(rootA), "packs"));
  }

  // 4) GET /lexicon?scope=global&book=../bad 忽略 book 返回 200
  {
    const res = mkRes();
    await byPath["/api/dsh-novel-writer/lexicon"](
      mkReq("/api/dsh-novel-writer/lexicon?scope=global&book=../bad", "GET"),
      res
    );
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.scope, "global");
  }

  // 5) GET /lexicon?scope=book&book=... 与 GET /baseline?book=... 非法书名返回 400
  {
    const res1 = mkRes();
    await byPath["/api/dsh-novel-writer/lexicon"](
      mkReq("/api/dsh-novel-writer/lexicon?scope=book&book=...", "GET"),
      res1
    );
    assert.equal(res1.status, 400, "非法 book 查询 /lexicon?scope=book 必须返回 400");

    const res2 = mkRes();
    await byPath["/api/dsh-novel-writer/baseline"](
      mkReq("/api/dsh-novel-writer/baseline?book=...", "GET"),
      res2
    );
    assert.equal(res2.status, 400, "非法 book 查询 /baseline 必须返回 400");
  }

  // 6) GET /lexicon?scope=all&book=X 两层均关闭时 enabled 必须为 false
  {
    await CORE.writeLexicon(rootA, CORE.GLOBAL_LEXICON_BOOK, { enabled: false, entries: [{ term: "全局词" }] });
    await CORE.writeLexicon(rootA, "双关书", { enabled: false, entries: [{ term: "本书词" }] });
    const res = mkRes();
    await byPath["/api/dsh-novel-writer/lexicon"](
      mkReq(`/api/dsh-novel-writer/lexicon?scope=all&book=${encodeURIComponent("双关书")}`, "GET"),
      res
    );
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.bookEnabled, false);
    assert.equal(data.globalEnabled, false);
    assert.equal(data.enabled, false, "两层均停用时合并视图 enabled 应为 false");
  }

  // 7) 伪造 Host 头（含 userinfo @ 或路径 /）必须返回 403
  for (const forgedHost of ["evil.com@127.0.0.1:3847", "127.0.0.1:3847/foo"]) {
    const res = mkRes();
    await byPath["/api/dsh-novel-writer/state"](
      mkReq("/api/dsh-novel-writer/state", "GET", void 0, { host: forgedHost }, "127.0.0.1"),
      res
    );
    assert.equal(res.status, 403, `伪造 Host=${forgedHost} 必须返回 403`);
  }
});

test("G1-4 (#5, #108, #168): mcp/server.mjs 拒绝嵌套批量数组、相对 src 按 LIBRARY_ROOT 解析、derivedPathViolation 拦截越界与清洗后逃逸", async () => {
  const mcpLib = freshLib("mcp-sec");
  const otherCwd = join(TMP_BASE, "mcp-other-cwd");
  const outsideDir = join(TMP_BASE, "mcp-outside");
  mkdirSync(otherCwd, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  mkdirSync(join(mcpLib, "inbox"), { recursive: true });
  writeFileSync(join(mcpLib, "inbox", "星海纪元 第01章 启航.md"), "# 启航\n\n" + PARA_PROSE_A + "\n", "utf8");

  // 构造清洗后逃逸：rawBook = "a/b" → rawBookPath = novels/a/b（在根内），sanitizeBookSegment("a/b") = "ab" → novels/ab 指向根外目录
  let junctionReady = false;
  try {
    symlinkSync(outsideDir, join(mcpLib, "novels", "ab"), process.platform === "win32" ? "junction" : "dir");
    junctionReady = true;
  } catch { /* 受限环境回退验证 .. 越界 */ }

  const child = spawn(process.execPath, [join(REPO_ROOT, "mcp", "server.mjs"), "--root", mcpLib], {
    cwd: otherCwd,
    env: { ...process.env, DSH_NOVEL_WRITER_STATE: STATE_FILE, DSH_HOME: DSH_HOME_DIR },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const rl = createInterface({ input: child.stdout });
  const pending = [];
  rl.on("line", (line) => {
    const s = line.trim();
    if (!s) return;
    const msg = JSON.parse(s);
    const next = pending.shift();
    if (next) next(msg);
  });
  const sendAndRecv = (payload) => new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("MCP response timeout")), 8000);
    pending.push((msg) => { clearTimeout(timer); resolvePromise(msg); });
    child.stdin.write(JSON.stringify(payload) + "\n");
  });

  try {
    // 协商支持批量数组的协议版本 2025-03-26，精准命中嵌套批量分支
    const initRes = await sendAndRecv({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "v820-test", version: "1.0.0" } }
    });
    assert.equal(initRes.result?.protocolVersion, "2025-03-26");

    // #5: 嵌套批量数组 [[...]] 必须返回 JSON-RPC -32600
    const nestedRes = await sendAndRecv([[{ jsonrpc: "2.0", id: 2, method: "ping" }]]);
    assert.ok(Array.isArray(nestedRes) && nestedRes.length === 1);
    assert.equal(nestedRes[0].error?.code, -32600, "嵌套批量数组必须返回 -32600");

    // #108: 相对 src 必须基于 LIBRARY_ROOT 而非 process.cwd() 解析
    const importRes = await sendAndRecv({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "novel_import", arguments: { src: "inbox", mode: "scan" } }
    });
    assert.equal(importRes.error, void 0, "相对 src 应按 LIBRARY_ROOT 找到 inbox 目录");
    assert.equal(importRes.result?.isError, void 0);
    const importText = (importRes.result?.content || []).map((c) => c.text).join("\n");
    assert.match(importText, /星海纪元/, "相对 src 导入预览应发现 LIBRARY_ROOT/inbox 下的稿件");

    // #168: rawBook 含 .. 越界必须被 derivedPathViolation 拒绝
    const dotDotRes = await sendAndRecv({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "novel_chapters", arguments: { book: "../escape" } }
    });
    assert.ok(
      dotDotRes.error?.code === -32602 || dotDotRes.result?.isError === true,
      "book='../escape' 必须被 derivedPathViolation 拦截"
    );

    // #168: 含 / 的 book 清洗后命中符号链接/目录联接逃逸同样必须拦截
    assert.equal(junctionReady, true, "测试环境应能创建目录联接/符号链接验证清洗后逃逸");
    const slashEscapeRes = await sendAndRecv({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "novel_chapters", arguments: { book: "a/b" } }
    });
    assert.ok(
      slashEscapeRes.error?.code === -32602 || slashEscapeRes.result?.isError === true,
      "book='a/b' 清洗后若指向根外目标必须被 derivedPathViolation 拦截"
    );
  } finally {
    rl.close();
    child.stdin.end();
    child.kill();
  }
});

test("G1-5 (#109): REACT_SHIM_JS 条件渲染切换保留兄弟 DOM 节点且重复 key 不二次复用同一节点", async () => {
  const handler = WEB_UI.createWebUiRequestHandler({});
  const res = mkRes();
  await handler(mkReq("/assets/react-shim.js", "GET"), res);
  assert.equal(res.status, 200);
  const shimCode = res.body;

  const { document } = createMinimalDomStub();
  const sandbox = { console, document, queueMicrotask: (fn) => fn(), setTimeout, clearTimeout };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(shimCode, sandbox, { filename: "react-shim.js" });

  const React = sandbox.window.__NW_REACT__;
  const ReactDOMClient = sandbox.window.__NW_REACT_DOM_CLIENT__;
  assert.ok(React && ReactDOMClient);

  // 1) 条件渲染 {cond && <div/>} 切换时，后续兄弟 <span> DOM 引用必须保持严格同一对象
  const container1 = document.createElement("div");
  const root1 = ReactDOMClient.createRoot(container1);
  const AppToggle = ({ cond }) => React.createElement(
    "section",
    null,
    cond && React.createElement("div", null, "A"),
    React.createElement("span", null, "B")
  );
  root1.render(React.createElement(AppToggle, { cond: true }));
  const section1 = container1.childNodes[0];
  assert.equal(section1.childNodes.length, 2);
  const spanRef1 = section1.childNodes[1];
  assert.equal(spanRef1.tagName, "SPAN");

  root1.render(React.createElement(AppToggle, { cond: false }));
  assert.equal(section1.childNodes.length, 1);
  assert.strictEqual(section1.childNodes[0], spanRef1, "隐藏前序条件节点时兄弟 DOM 必须原地复用");

  root1.render(React.createElement(AppToggle, { cond: true }));
  assert.equal(section1.childNodes.length, 2);
  assert.strictEqual(section1.childNodes[1], spanRef1, "重新显示前序条件节点时兄弟 DOM 仍必须保持同一实例");

  // 2) 重复 key 不得二次复用同一个 DOM 节点
  const container2 = document.createElement("div");
  const root2 = ReactDOMClient.createRoot(container2);
  const DupList = ({ suffix }) => React.createElement(
    "ul",
    null,
    React.createElement("li", { key: "dup" }, "first" + suffix),
    React.createElement("li", { key: "dup" }, "second" + suffix)
  );
  root2.render(React.createElement(DupList, { suffix: "1" }));
  const ul = container2.childNodes[0];
  assert.equal(ul.childNodes.length, 2);
  assert.notStrictEqual(ul.childNodes[0], ul.childNodes[1], "首次渲染重复 key 应生成 2 个独立 DOM 节点");

  root2.render(React.createElement(DupList, { suffix: "2" }));
  assert.equal(ul.childNodes.length, 2);
  assert.notStrictEqual(ul.childNodes[0], ul.childNodes[1], "重渲染重复 key 不得二次复用同一节点");
  assert.equal(ul.childNodes[0].textContent, "first2");
  assert.equal(ul.childNodes[1].textContent, "second2");
});

// ===========================================================================
// Group 2: Storage, ReDoS, Packs, Trash & Logs
// (#6-#9, #39-#43, #45-#49, #143, #144, #149, #150, #151)
// ===========================================================================

test("G2-1 (#7, #40, #143): validatePattern 拦截 ReDoS/无界通配、放行线性与字面量模式、不误报转义尾锚 100\\$", () => {
  for (const bad of ["([，。]?[，。]?)+终", "前(?:a?a?)+终", "上.+香", "[\\S\\s]*"]) {
    const v = CORE.validatePattern(bad);
    assert.equal(v.ok, false, `危险模式 ${bad} 必须被拒绝`);
    assert.equal(v.level, "reject", `危险模式 ${bad} 级别必须为 reject`);
  }

  for (const good of ["上\\d+柱香|点\\d+根蜡烛", "\\d+年\\d+月", "神父\\s+祈祷|牧师\\s+布道", "Mr\\.*", "[.*]", "(\\d{2}){2}"]) {
    const v = CORE.validatePattern(good);
    assert.equal(v.ok, true, `合法模式 ${good} 不应被误拒: ${JSON.stringify(v)}`);
    assert.equal(v.level, "ok");
  }

  const escapedDollar = CORE.validatePattern("100\\$");
  assert.equal(escapedDollar.ok, true, "转义字面量 100\\$ 不应触发尾锚告警");
  assert.equal(escapedDollar.level, "ok");
});

test("G2-2 (#39, #49): parseChapterNumber 兼容版本/书名前缀与 nextFreeChapterFile 拒绝全角超限并无损顺延全角章号", () => {
  assert.equal(CORE.parseChapterNumber("v1.2 第03章"), 3);
  assert.equal(CORE.parseChapterNumber("书名.第03章"), 3);

  const dir = join(freshLib("fw-ch"), "novels", "全角章书");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "第01章.md"), "正文\n", "utf8");

  assert.throws(
    () => CORE.nextFreeChapterFile(dir, "第１０００１章.md"),
    /10000|上限|范围|超出/,
    "全角第１０００１章必须被拒绝"
  );

  const renamed = CORE.nextFreeChapterFile(dir, "第０１章 初遇.md");
  assert.equal(renamed, "第02章 初遇.md", "全角第０１章冲突改名不得叠出双章号前缀");
  assert.equal(CORE.parseChapterNumber(renamed), 2);
});

test("G2-3 (#41, #144): isValidPackId 拦截保留设备名、大小写不敏感拦截内置包 ID、mergeTwoPacks 保留尾部转义空格", async () => {
  assert.equal(CORE.isValidPackId("CON"), false);
  assert.equal(CORE.isValidPackId("NUL"), false);
  assert.equal(CORE.isValidPackId("con"), false);

  const root = freshLib("packs-sec");
  const builtinClash = await CORE.saveCustomPack(root, { id: "Western-Fantasy", name: "冒充内置包" });
  assert.equal(builtinClash.ok, false);
  assert.equal(builtinClash.code, "BUILTIN_ID");

  // 经 extends 触发 mergeTwoPacks，确认 ritualBadPatterns 尾部转义空格 "foo\\ " 不被 .trim() 吃掉
  const baseSaved = await CORE.saveCustomPack(root, {
    id: "base-esc-space",
    name: "父包",
    speechStyle: { ritualBadPatterns: ["foo\\ "] }
  });
  assert.equal(baseSaved.ok, true, JSON.stringify(baseSaved));
  const childSaved = await CORE.saveCustomPack(root, {
    id: "child-esc-space",
    name: "子包",
    extends: "base-esc-space",
    speechStyle: { ritualBadPatterns: ["bar\\ "] }
  });
  assert.equal(childSaved.ok, true, JSON.stringify(childSaved));
  const loaded = CORE.loadPack("child-esc-space", root);
  assert.ok(loaded, "子包应可加载");
  assert.ok(loaded.speechStyle.ritualBadPatterns.includes("foo\\ "), "父包尾部转义空格必须保留");
  assert.ok(loaded.speechStyle.ritualBadPatterns.includes("bar\\ "), "子包尾部转义空格必须保留");
});

test("G2-4 (#45, #46, #151): 并发 createUniqueTrashDir 唯一性、manifest.json 同名文件不覆写清单、purgeTrash 计数与 listTrash 对齐", async () => {
  const root = freshLib("trash-sec");
  const trashBase = join(CORE.novelDataDir(root), "trash");
  mkdirSync(trashBase, { recursive: true });

  // 1) 并发 createUniqueTrashDir 必须产出 8 个互不冲突的目录
  const created = await Promise.all(
    Array.from({ length: 8 }, () => TRASH.createUniqueTrashDir(trashBase, "并发书"))
  );
  const ids = new Set(created.map((c) => c.trashId));
  const dirs = new Set(created.map((c) => c.trashRoot));
  assert.equal(ids.size, 8, "并发创建回收站目录必须全部唯一");
  assert.equal(dirs.size, 8);
  // 清理这 8 个空目录以免干扰后续 listTrash
  for (const c of created) rmSync(c.trashRoot, { recursive: true, force: true });

  // 2) 移入用户同名 manifest.json 文件时不得覆写回收站条目自身的 manifest.json
  const srcDir = join(root, "novels", "清单测试书");
  mkdirSync(srcDir, { recursive: true });
  const userManifest = join(srcDir, "manifest.json");
  const userChapter = join(srcDir, "第01章.md");
  writeFileSync(userManifest, JSON.stringify({ userOwned: true }), "utf8");
  writeFileSync(userChapter, "正文内容\n", "utf8");

  const moved = await TRASH.movePathsToTrash({
    root,
    dataDir: CORE.novelDataDir(root),
    paths: [userManifest, userChapter],
    label: "清单测试书",
    safeLabel: "manifest-book"
  });
  assert.ok(moved.trashId);
  assert.equal(moved.files, 2);
  const trashManifest = JSON.parse(readFileSync(join(moved.trashDir, "manifest.json"), "utf8"));
  assert.equal(trashManifest.schema, TRASH.TRASH_SCHEMA, "回收站自身 manifest.json 必须保持合法清单而非被用户文件覆写");
  assert.equal(trashManifest.items.length, 2);
  assert.equal(trashManifest.userOwned, void 0);

  // 3) listTrash 与 purgeTrash 均只统计负载文件数（不含 manifest.json）
  const listed = await BOOKDELETE.listTrash({ root });
  const entry = listed.find((e) => e.id === moved.trashId);
  assert.ok(entry);
  assert.equal(entry.files, 2, "listTrash 文件数应排除 manifest.json");
  const purged = await BOOKDELETE.purgeTrash({ root, trashId: moved.trashId });
  assert.equal(purged.purged, true);
  assert.equal(purged.files, entry.files, "purgeTrash 报告的文件数必须与 listTrash 完全一致（不含 manifest.json）");
});

test("G2-5 (#149, #150): readLogEvents 跳过非法时间戳行且 logEvent 对中文长负载强制 UTF-8 字节上限", async () => {
  const logDir = LOG.logDir();
  mkdirSync(logDir, { recursive: true });
  const nowIso = new Date().toISOString();
  // 直接向当前活跃日志写入一条合法记录与一条 NaN 时间戳脏记录
  const activeLog = LOG.logFilePath();
  writeFileSync(
    activeLog,
    JSON.stringify({ ts: "not-a-date", kind: "tool_call", level: "info", tool: "bad_ts" }) + "\n" +
    JSON.stringify({ ts: nowIso, kind: "tool_call", level: "info", tool: "good_ts" }) + "\n",
    "utf8"
  );
  const events = await LOG.readLogEvents({ days: 7 });
  assert.ok(events.some((e) => e.tool === "good_ts"), "合法时间戳事件必须读出");
  assert.equal(events.some((e) => e.tool === "bad_ts"), false, "非法时间戳 (NaN) 事件必须被跳过");

  // #150: 多字段中文负载的字符数（UTF-16 length < 4096）但 UTF-8 字节数 > 4096，必须按 UTF-8 字节截断并标记 truncated: true
  const cjkField = "中".repeat(220);
  LOG.logEvent("tool_call", {
    tool: "cjk_cap_test",
    book: cjkField,
    chapter: cjkField,
    file: cjkField,
    path: cjkField,
    root: cjkField,
    rootSource: cjkField,
    mode: cjkField,
    scope: cjkField,
    name: cjkField,
    code: cjkField,
    detail: "中文负载" + "a".repeat(30) + "测试"
  });
  const rawLines = readFileSync(activeLog, "utf8").trim().split(/\r?\n/);
  const lastLine = rawLines[rawLines.length - 1];
  assert.ok(
    Buffer.byteLength(lastLine, "utf8") <= LOG.LOG_MAX_EVENT_BYTES,
    `中文长负载落盘单行字节数 ${Buffer.byteLength(lastLine, "utf8")} 必须 <= ${LOG.LOG_MAX_EVENT_BYTES}`
  );
  const parsedLast = JSON.parse(lastLine);
  assert.equal(parsedLast.tool, "cjk_cap_test");
  assert.equal(parsedLast.truncated, true);
});

// ===========================================================================
// Group 3: Domain Core & Lexicons
// (#12, #13, #14, #15, #16, #17, #51, #52, #53, #54, #55, #56, #57, #142, #154)
// ===========================================================================

test("G3-1 (#12, #154): 损坏 plots/<book>.json 不回退覆写且 strict 抛错；settings/plots/summaries 遇 JSON null 安全处理", async () => {
  const root = freshLib("corrupt-stores");
  const book = "损坏伏笔书";
  const pFile = CORE.plotsFile(root, book);
  const legFile = CORE.legacyPlotsFile(root, book);
  mkdirSync(dirname(pFile), { recursive: true });
  writeFileSync(pFile, "{broken json", "utf8");
  writeFileSync(legFile, JSON.stringify({ book, entries: [{ id: "leg1", content: "旧版伏笔", status: "open" }] }), "utf8");

  const nonStrict = await CORE.readPlots(root, book);
  assert.deepEqual(nonStrict, [], "主伏笔文件损坏时不得回退读取旧位置");
  assert.equal(readFileSync(pFile, "utf8"), "{broken json", "主伏笔文件损坏时绝不得被旧位置覆盖");
  await assert.rejects(
    CORE.readPlots(root, book, { strict: true }),
    (err) => err instanceof SyntaxError && err.code === "EPARSE",
    "strict 读取损坏伏笔文件必须抛 EPARSE SyntaxError"
  );

  // #154: JSON null 在 settings / plots / summaries 中均按非法根结构拦截
  const nullBook = "空根书";
  const sFile = CORE.settingsFile(root, nullBook);
  const pNull = CORE.plotsFile(root, nullBook);
  const sumFile = CORE.summariesFile(root, nullBook);
  mkdirSync(dirname(sFile), { recursive: true });
  mkdirSync(dirname(pNull), { recursive: true });
  mkdirSync(dirname(sumFile), { recursive: true });
  writeFileSync(sFile, "null", "utf8");
  writeFileSync(pNull, "null", "utf8");
  writeFileSync(sumFile, "null", "utf8");

  await assert.rejects(
    CORE.readSettings(root, nullBook, { strict: true }),
    (err) => err instanceof SyntaxError && err.code === "EPARSE",
    "settings 为 JSON null 时 strict 读取必须抛 EPARSE"
  );
  await assert.rejects(
    CORE.readPlots(root, nullBook, { strict: true }),
    (err) => err instanceof SyntaxError && err.code === "EPARSE",
    "plots 为 JSON null 时 strict 读取必须抛 EPARSE"
  );
  // readSummaries 内部抛 EPARSE 并记 warn 日志后返回 []（不抛出裸 TypeError）
  const sums = await CORE.readSummaries(root, nullBook);
  assert.deepEqual(sums, []);
});

test("G3-2 (#13, #14, #53): parseLexiconLine 保留空 kind 列、mergeLexiconEntries 支持重置字段、防伪装名覆写全局词表", async () => {
  // #13: 制表符空列不得吃掉后续字段
  const parsed = CORE.parseLexiconLine("星轨\t\t战斗\t轨道,轨迹\t备注");
  assert.equal(parsed.term, "星轨");
  assert.equal(parsed.kind, void 0, "空 kind 列应保持 undefined");
  assert.equal(parsed.scene, "战斗");
  assert.deepEqual(parsed.avoid, ["轨道", "轨迹"]);
  assert.equal(parsed.note, "备注");

  // #14: mergeLexiconEntries 允许重新启用、降级 priority、清空 avoid
  const merged = CORE.mergeLexiconEntries(
    [{ term: "星轨", enabled: false, priority: "high", avoid: ["轨道", "轨迹"] }],
    [{ term: "星轨", enabled: true, priority: "normal", avoid: [] }],
    { overwrite: true }
  );
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0].enabled, void 0, "enabled: true 应清除原有 enabled: false");
  assert.equal(merged.entries[0].priority, void 0, "priority: 'normal' 应降级清除原有 priority: 'high'");
  assert.equal(merged.entries[0].avoid, void 0, "avoid: [] 应清空原有 avoid");

  // #53: 清洗后撞名 _global 的书名不得覆写全局词表
  const root = freshLib("lex-global-guard");
  await CORE.writeLexicon(root, CORE.GLOBAL_LEXICON_BOOK, { entries: [{ term: "守护全局词" }] });
  await assert.rejects(
    CORE.writeLexicon(root, "_global.", { entries: [{ term: "恶意覆盖" }] }),
    /全局词表保留名|冲突/,
    '"_global." 不得覆写全局词表'
  );
  await assert.rejects(
    CORE.writeLexicon(root, "_global/", { entries: [{ term: "恶意覆盖" }] }),
    /全局词表保留名|冲突/,
    '"_global/" 不得覆写全局词表'
  );
  await assert.rejects(
    CORE.writeLexicon(root, " _global ", { entries: [{ term: "恶意覆盖" }] }),
    /全局词表保留名|冲突/,
    '" _global " 不得覆写全局词表'
  );
  const lexRoute = CORE.makeStateRoutes(false, { root }).find((r) => r.path === "/api/dsh-novel-writer/lexicon");
  const badLexPost = mkRes();
  await lexRoute.handler(mkReq(
    "/api/dsh-novel-writer/lexicon",
    "POST",
    JSON.stringify({ scope: "book", op: "save", book: "_global.", entries: [{ term: "恶意覆盖" }] })
  ), badLexPost);
  assert.equal(badLexPost.status, 400, 'POST /lexicon scope="book" book="_global." 必须返 400 拒绝');
  const globalAfter = await CORE.readLexiconFile(root, CORE.GLOBAL_LEXICON_BOOK);
  assert.deepEqual(globalAfter.entries.map((e) => e.term), ["守护全局词"]);
  // readLexicon 面对带空白的 " _global " 仅作为全局层读取，不生成重复书层
  const readTrimmed = await CORE.readLexicon(root, " _global ");
  assert.equal(readTrimmed.book.file, "");
  assert.equal(readTrimmed.counts.book, 0);
});

test("G3-3 (#15, #142): hintCulture 正确识别否定约束与现代都市，resolveStyleRule 保留空 id 内联包", () => {
  const westernNeg = CORE.hintCulture("欧式背景，禁中式词汇（客栈、衙门）");
  assert.notEqual(westernNeg.culture, "eastern", "否定括号中的中式词汇不得把欧式设定判为 eastern");
  assert.equal(westernNeg.culture, "western");

  const modernHint = CORE.hintCulture("现代都市职场悬疑，写字楼地铁咖啡厅");
  assert.equal(modernHint.culture, "modern", "现代都市设定应判为 modern 而非 western");

  const rule = CORE.resolveStyleRule({}, [], { pack: { id: "", bannedWords: ["测试禁词"] } });
  assert.ok(rule.bannedWords.includes("测试禁词"), "空 id 内联题材包必须保留其 bannedWords");
  assert.equal(rule.pack?.id, "inline-pack");
});

test("G3-4 (#16): resolveAmbiguousCarriers 全部歧义项裁决后 ambiguousRatio 精确归零", async () => {
  const implicit = {
    negative: 0,
    positive: 0,
    ambiguousRatio: 1,
    fragile: false,
    totalHits: 0,
    negHits: 0,
    posHits: 0,
    ambHits: 1,
    totalAllHits: 1,
    ambiguous: [
      { word: "雨", reason: "未裁决", ctx: "黑暗里有什么在逼近，他说不清自己在怕什么，浑身发冷，雨水冰凉" }
    ],
    topCarriers: []
  };
  const resolved = await CORE.resolveAmbiguousCarriers(implicit);
  assert.equal(resolved.resolved?.length, 1, "明确负向语境应被本地语义模型成功裁决");
  assert.equal(resolved.ambiguous.length, 0);
  assert.equal(resolved.ambHits, 0);
  assert.equal(resolved.ambiguousRatio, 0, "100% 歧义项裁决后 ambiguousRatio 必须为 0");
  assert.equal(Math.round((resolved.negative + resolved.positive) * 100), 100);
});

test("G3-5 (#17): createOutlineTool hook 原地替换 * 1 旧钩子并拒绝负章号", async () => {
  const root = freshLib("outline-hook");
  const book = "大纲测试书";
  const tool = CORE.createOutlineTool({ root });
  const exec = { agent: { session: { header: { cwd: root } } } };

  const cDir = CORE.creationDir(root, book);
  mkdirSync(cDir, { recursive: true });
  const hooksFile = join(cDir, CORE.CREATION_FILES.hooks);
  writeFileSync(hooksFile, "# 钩子记录\n\n* 1 旧钩子\n- 2 第二章钩子\n", "utf8");

  await tool.execute({ book, action: "hook", number: 1, body: "新钩子内容", root }, exec);
  const content = readFileSync(hooksFile, "utf8");
  assert.ok(content.includes("- 1 新钩子内容"), "应写入替换后的新钩子");
  assert.equal(content.includes("旧钩子"), false, "* 1 旧钩子必须被原地替换而非追加重复项");
  const ch1Matches = content.match(/^[-*]\s*1\s+/gm) || [];
  assert.equal(ch1Matches.length, 1, "第 1 章钩子行只能有 1 条");

  await assert.rejects(
    tool.execute({ book, action: "hook", number: -1, body: "负章钩子", root }, exec),
    /正整数|number/,
    "负章号必须被拒绝"
  );
});

test("G3-6 (#51, #52): buildStyleAnchorPackage 将中文？问句归为「疑问」且 buildTolerance 局部合并并剔除 NaN / 倒挂区间", async () => {
  const root = freshLib("anchor-tol");
  const book = "问句书";
  const text = [
    "这盏熄灭多年的旧铜灯为什么偏偏在今晚重新亮起呢？",
    PARA_PROSE_A,
    PARA_PROSE_B,
    PARA_PROSE_C
  ].join("\n\n");
  const pkg = await CORE.buildStyleAnchorPackage(root, book, [], null, text);
  assert.ok(
    pkg.skeletons.some((s) => s.type === "疑问" && s.text.includes("？")),
    `中文 ？ 疑问句应被归类为「疑问」，实际 skeletons=${JSON.stringify(pkg.skeletons)}`
  );

  // #52: buildTolerance 局部 opts.tolerance 叠加在 stateTolerance 之上，同时剔除 NaN 与 low > high
  const base = {};
  for (const k of METRICS.METRIC_ORDER) base[k] = { mu: 10, recTol: 30 };
  const tol = CORE.buildTolerance(
    base,
    5,
    { tolerance: { complexity: { low: -10, high: 10 } } },
    {
      modifierDensity: { low: -20, high: 20 },
      actionDensity: { low: Number.NaN, high: 10 },
      hedgeDensity: { low: 20, high: 10 }
    }
  );
  assert.deepEqual(tol.complexity, { low: -10, high: 10 }, "opts.tolerance 局部项应生效");
  assert.deepEqual(tol.modifierDensity, { low: -20, high: 20 }, "stateTolerance 其余维度必须保留而非整包清空");
  assert.deepEqual(tol.actionDensity, { low: -30, high: 30 }, "NaN 容差必须被拒并回退推荐容差");
  assert.deepEqual(tol.hedgeDensity, { low: -30, high: 30 }, "low > high 倒挂区间必须被拒并回退推荐容差");
});

test("G3-7 (#55, #56, #57): buildSlopExemptions 忽略 null/空串数值选项、静音引号内对话、COLLISION_GUARDS['碎银'] 不再豁免「散碎银」", () => {
  // #55: null / "" 不得通过 Number(null)===0 变成 0 阈值
  const shortCorpus = "这一刻，一切都变了。这一刻，一切都变了。";
  const exNull = SLOP.buildSlopExemptions(shortCorpus, { minChars: null, minCount: "", densityFloorPer1000: null });
  assert.equal(exNull.exemptRules.length, 0, "null/空串选项必须回落默认门槛，短语料不得误豁免");

  // #56: QUOTE_MUTED 类别（如 ai_ese / abstract_tell）仅在对话引号内高频出现时，不得进入参照豁免表
  const filler = "他走过青石板路，推开木门，把手里的油灯放在木桌上，静静听着窗外细雨落下。".repeat(30);
  const quotedCorpus = filler + Array(8).fill("“值得注意的是，这件事本质上已经超出了我们的控制。”他说道。").join("\n") + filler;
  const exQuoted = SLOP.buildSlopExemptions(quotedCorpus);
  assert.equal(exQuoted.exemptRules.includes("ai_worth_noting"), false, "仅出现在引号对话中的 QUOTE_MUTED 套话不得豁免旁白");
  assert.equal(exQuoted.exemptRules.length, 0, "对话内 QUOTE_MUTED 套话不应产出任何豁免规则");

  // #57: 「散碎银」不再被 COLLISION_GUARDS["碎银"] 误豁免（而「粉碎银」仍保留豁免）
  assert.equal(CORE.isGuardedArtifact("碎银", "散碎银子", 1), false, "「散碎银」不应被守卫豁免");
  assert.equal(CORE.isGuardedArtifact("碎银", "粉碎银甲", 1), true, "「粉碎银」仍应被守卫豁免");
});

// ===========================================================================
// Group 4: Engines & Writing Loop
// (#3, #18-#30, #58-#86, #145, #160, #161)
// ===========================================================================

test("G4-1 (#18, #60, #61, #62, #63): 隐性载体防自触发、书写嵌套引号保留、ASCII 直引号切句、零歧义和=1、chapterTexts 去标题行", () => {
  // #18: 「奔跑」自身不自触发正向，应按「拼命/逃/追/喘/夜」归负向且无歧义
  const imp = ANALYSIS.implicitEmotionScan("他拼命逃离追杀，喘不过气地奔跑在黑夜里。");
  assert.equal(imp.ambHits, 0, "逃离追杀语境的奔跑不应判歧义");
  assert.ok(imp.negHits >= 1 && imp.negative === 1, "应明确归类为负向意象");

  // #60: 碑文/书写引语含内层单引号时仍保持 written quote（非 dialogue）
  const cls = ANALYSIS.classifySentence("碑上写着：“凡见‘禁忌’者必死。”");
  assert.equal(cls.quoted, false, "书写引语内含单引号不得翻转成人物对话");
  assert.notEqual(cls.type, "dialogue");

  // #61: ASCII 直引号开引号留在第二句
  const sents = ANALYSIS.splitSentences('夜色很深。"快走吧。"');
  assert.deepEqual(sents, ["夜色很深。", '"快走吧。"']);

  // #62: ambCount === 0 时 neg + pos === 1.00（即便是 1:7 → 0.125/0.875 也不得出现 1.01）
  const balanced = ANALYSIS.implicitEmotionScan("秋雨落叶枯枝。" + "暖阳茶烟炊烟暖光炉火余晖暖阳".repeat(1));
  assert.equal(balanced.ambHits, 0);
  assert.equal(Math.round((balanced.negative + balanced.positive) * 100), 100, "零歧义时 negative + positive 必须严格等于 1.00");

  // #63: analyzeText 对 chapterTexts 剥离 Markdown 标题中的强情绪词
  const mdCh1 = "# 愤怒绝望悲痛欲绝\n\n他沿着石阶慢慢走到井边，提了半桶清水。\n";
  const mdCh2 = "# 狂喜幸福恐惧绝望\n\n她把木窗推开一条缝，看着雨丝落下。\n";
  const analyzed = ANALYSIS.analyzeText(mdCh1 + "\n" + mdCh2, {
    chapterTexts: [
      { chapter: "第01章.md", text: mdCh1 },
      { chapter: "第02章.md", text: mdCh2 }
    ]
  });
  assert.equal(analyzed.emotion.dominant, "neutral");
  assert.equal(analyzed.emotion.quantification.complexity.chapterDrift.meanEntropy, 0, "标题里的情绪词不得污染 chapterTexts 漂移熵");
  assert.equal(analyzed.emotion.quantification.complexity.score, 0, "标题里的强情绪词不得污染情感复杂度评分");
});

test("G4-2 (#19): checkOutlineFulfillment 忽略 Markdown 标题行中的大纲关键词", async () => {
  const unrelatedBody = (PARA_PROSE_A + "\n\n" + PARA_PROSE_B + "\n\n" + PARA_PROSE_C + "\n\n").repeat(2);
  const chapter = "# 第1章 主角点燃烽火号令三军\n\n" + unrelatedBody;
  // 确定性正交嵌入：大纲查询映射到 [1,0,0,0]，正文段映射到 [0,1,0,0]
  const mockEmbed = async (t) => (t.includes("烽火") ? [1, 0, 0, 0] : [0, 1, 0, 0]);
  const res = await VEC.checkOutlineFulfillment("主角点燃烽火号令三军", chapter, {
    isAvailable: async () => true,
    embed: mockEmbed
  });
  assert.equal(res.checked, true);
  assert.equal(res.unfulfilled.length, 1, "仅标题行含大纲词而正文无关时必须判定为未兑现");
});

test("G4-3 (#20, #21, #22, #23, #69): 损坏伏笔表触发 plot 跳过不误判 resolved、skippedOutlineClauses 保留大纲漏写 pending、verifyFixPlan 不创建 cache.sqlite", async () => {
  // 1) #20/#21: 损坏伏笔文件在 verifyFixPlan 中保留旧伏笔待办为 pending
  const root1 = freshLib("fp-corrupt-plot");
  const book1 = "改稿伏笔书";
  const dir1 = join(root1, "novels", book1);
  mkdirSync(dir1, { recursive: true });
  writeFileSync(join(dir1, "第01章.md"), PARA_PROSE_A + "\n\n" + PARA_PROSE_B + "\n", "utf8");
  writeFileSync(join(dir1, "第02章.md"), PARA_PROSE_B + "\n\n" + PARA_PROSE_C + "\n", "utf8");
  writeFileSync(join(dir1, "第25章.md"), PARA_PROSE_C + "\n\n" + PARA_PROSE_A + "\n", "utf8");
  await CORE.writePlots(root1, book1, [{ id: "p1", content: "铜牌背后的密文来历", chapter: "第01章.md", status: "open" }]);

  const plan1 = await FIXPLAN.buildFixPlan(root1, book1, "25", {}, null);
  const plotItem = plan1.items.find((it) => it.type === "伏笔未回收");
  assert.ok(plotItem, "初始 buildFixPlan 应检出超期未回收伏笔");

  // 破坏伏笔文件后复测
  writeFileSync(CORE.plotsFile(root1, book1), "{corrupt plot json", "utf8");
  const ver1 = await FIXPLAN.verifyFixPlan(root1, book1, "25", {}, null);
  const checkedPlot = ver1.checked.find((c) => c.id === plotItem.id);
  assert.ok(checkedPlot);
  assert.equal(checkedPlot.status, "pending", "伏笔表损坏触发 plot 跳过时，旧伏笔项必须保持 pending 而非误判 resolved");

  // 2) #23: skippedOutlineClauses（或 vector_outline 跳过）保持旧「大纲漏写」项 pending
  const root2 = freshLib("fp-outline-skip");
  const book2 = "大纲跳过书";
  const dir2 = join(root2, "novels", book2);
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, "第01章.md"), PARA_PROSE_A + "\n\n" + PARA_PROSE_B + "\n", "utf8");
  writeFileSync(join(dir2, "第02章.md"), PARA_PROSE_B + "\n\n" + PARA_PROSE_C + "\n", "utf8");
  const cDir2 = CORE.creationDir(root2, book2);
  mkdirSync(cDir2, { recursive: true });
  writeFileSync(join(cDir2, CORE.CREATION_FILES.outline), "# 剧情大纲\n\n- 2 主角点燃烽火号令三军\n", "utf8");

  // 写入一份既有待办清单，含 1 条「大纲漏写」项；verify 时关闭语义增强使 vector_outline 跳过
  const planDir2 = join(CORE.novelDataDir(root2), "audits");
  mkdirSync(planDir2, { recursive: true });
  const clause = "主角点燃烽火号令三军";
  const missKey = "miss-" + createHash("sha1").update(clause).digest("hex").slice(0, 8);
  const fakeOutlineId = "大纲漏写-" + missKey;
  writeFileSync(join(planDir2, `fix-plan-${book2}-第02章.json`), JSON.stringify({
    book: book2,
    chapter: { file: "第02章.md", number: 2, title: "" },
    items: [{
      id: fakeOutlineId,
      type: "大纲漏写",
      locate: { lineStart: 0, lineEnd: 0, excerpt: "" },
      current: `大纲节点「${clause}」未检出对应段落（最高相似度 0.12）`,
      target: "让这条大纲有落点",
      anchor: "",
      severity: 4,
      effort: 3,
      hint: "**全章层面**：核对大纲"
    }],
    summary: "test"
  }), "utf8");

  // #69: 在完全没有 cache.sqlite 的全新书库上运行 verifyFixPlan (persist: false)，确认零 SQLite 副作用
  const sqlitePath2 = join(CORE.novelDataDir(root2), "cache.sqlite");
  assert.equal(existsSync(sqlitePath2), false);
  const ver2 = await FIXPLAN.verifyFixPlan(root2, book2, "2", {}, null);
  const checkedOut = ver2.checked.find((c) => c.id === fakeOutlineId);
  assert.ok(checkedOut);
  assert.equal(checkedOut.status, "pending", "大纲校验未执行时旧「大纲漏写」必须维持 pending");
  assert.equal(existsSync(sqlitePath2), false, "verifyFixPlan 只读复测 (persist: false) 不得创建 cache.sqlite");
});

test("G4-4 (#25, #70, #71): buildChapterBrief 坏设定不注入69西幻禁词、跳过空标题大纲行、已回收伏笔中的已知角色名不误报 longHits", async () => {
  // 1) #25: 设定文件损坏时，不注入默认 69 条西幻禁用词
  const root1 = freshLib("brief-corrupt-settings");
  const book1 = "坏设定开写书";
  const dir1 = join(root1, "novels", book1);
  mkdirSync(dir1, { recursive: true });
  writeFileSync(join(dir1, "第01章.md"), PARA_PROSE_A + "\n\n" + PARA_PROSE_B + "\n", "utf8");
  const sFile1 = CORE.settingsFile(root1, book1);
  mkdirSync(dirname(sFile1), { recursive: true });
  writeFileSync(sFile1, "{corrupt settings", "utf8");

  const brief1 = await BRIEF.buildChapterBrief(root1, book1, "2", null);
  assert.equal(brief1.worldview, null, "设定表损坏时不得静默注入默认西幻 69 禁词");
  assert.ok((brief1.degraded || []).some((d) => d.includes("设定表")), "degraded 应披露设定表损坏");

  // 2) #70 & #71: 空 ## 第01章 标题不截胡真正方向行；3-4 字已知角色名在已回收伏笔中不触发误报
  const root2 = freshLib("brief-outline-char");
  const book2 = "方向与角色书";
  const dir2 = join(root2, "novels", book2);
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, "第01章.md"), "欧阳克明推开木门，走过院子，拿起桌上的茶壶倒了半盏清茶。\n\n" + PARA_PROSE_A + "\n", "utf8");
  const cDir2 = CORE.creationDir(root2, book2);
  mkdirSync(cDir2, { recursive: true });
  writeFileSync(join(cDir2, CORE.CREATION_FILES.outline), "# 剧情大纲\n\n## 第01章\n- 1 真实第一方向\n- 2 第二章方向\n", "utf8");
  await CORE.writeSettings(root2, book2, {
    characters: [{ name: "欧阳克明", traits: "沉稳" }],
    locations: [],
    items: [],
    timeline: [],
    worldview: []
  });
  await CORE.writePlots(root2, book2, [
    { id: "done1", content: "欧阳克明失踪案查清", chapter: "第01章.md", status: "done" }
  ]);

  const briefCh1 = await BRIEF.buildChapterBrief(root2, book2, "1", null);
  assert.equal(briefCh1.outlineDirection, "真实第一方向", "parseNumberedLines 应跳过空 ## 第01章 标题并取到真实方向行");

  const briefCh2 = await BRIEF.buildChapterBrief(root2, book2, "2", null);
  const falseLongHit = (briefCh2.notes || []).concat(briefCh2.degraded || []).some((m) => String(m).includes("欧阳克明"));
  assert.equal(falseLongHit, false, "已回收伏笔中仅命中已知人物名欧阳克明时不应误触发 longHits 警告");
});

test("G4-5 (#26, #74, #75, #76, #145, #161): ending_preach 五行豁免、PLAN_META_PREFIX_RE、splitOutlineClauses 无纯连词、bareDialogueRun.p95=null 保底 6", () => {
  // #26: 5 行单换行章节，第 4 行带 >=2 具象动作+收尾词、第 5 行干净 → 不报 ending_preach
  const fiveLine = [
    "巷口雨势渐小，青石板泛出冷光。",
    "他把伞靠在门边，拂去肩头水珠。",
    "茶馆掌柜提壶过来，添了半盏热茶。",
    "他握住青瓷杯推开窗扇，这才明白命运从不等人。",
    "窗外街灯一盏接一盏熄灭了。"
  ].join("\n");
  const symsEnd = DIAG.diagnoseChapterSymptoms(fiveLine, null);
  assert.equal(symsEnd.some((s) => s.key === "ending_preach"), false, "第 4 行有充分具象动作且末行干净时不得误报 ending_preach");

  // #74/#75: PLAN_META_PREFIX_RE 过滤「按照大纲写。」且不误伤「按住他的肩膀。」
  const metaPlan = DIAG.checkPlanFulfillment("按照大纲写。", PARA_PROSE_A);
  assert.equal(metaPlan.qualified, false, "元指令「按照大纲写。」必须被过滤");
  const realPlan = DIAG.checkPlanFulfillment("按住他的肩膀。", "他快步上前伸手按住他的肩膀，低声说了一句话。");
  assert.equal(realPlan.qualified, true, "真实动作「按住他的肩膀。」不得被元指令前缀误切");
  assert.equal(realPlan.unfulfilled.length, 0);

  // #76: splitOutlineClauses("买药并且为了救人") 不产生纯连词子句
  const clauses = OBL.splitOutlineClauses("买药并且为了救人");
  assert.ok(clauses.length >= 1);
  assert.equal(clauses.some((c) => c === "并且" || c === "为了"), false, `不得产出纯连词子句: ${JSON.stringify(clauses)}`);

  // #145/#161: bareDialogueRun.p95 为 null 时阈值保持 6，5 连段对话不误报
  const fiveBare = [
    "“走了吗？”他问。",
    "“还没。”她答。",
    "“什么时候走？”他问。",
    "“天亮前。”她说。",
    "“好。”他点头。"
  ].join("\n\n");
  const symsBare = DIAG.diagnoseChapterSymptoms(fiveBare, { bareDialogueRun: { p95: null } });
  assert.equal(symsBare.some((s) => s.key === "bare_dialogue"), false, "p95=null 时站桩对话阈值必须保持默认 6");
});

test("G4-6 (#27-#30, #77-#82, #86): prompts/audit/graph/rawguard/update-check/diagnose 关键契约回归", async () => {
  // #27: promptTextFor(undefined, undefined, false) 返回 BRIEF_TEXT
  assert.equal(PROMPTS.promptTextFor(void 0, void 0, false), PROMPTS.BRIEF_TEXT);

  // #28: runAuditContracts (runBannedContract & runSlopContract) 遵守书级题材包与 slopMuteCategories
  const rootAud = freshLib("audit-pack");
  const bookAud = "审计题材书";
  const dirAud = join(rootAud, "novels", bookAud);
  mkdirSync(dirAud, { recursive: true });
  const savedAudPack = await CORE.saveCustomPack(rootAud, {
    id: bookAud,
    name: "本书专属包",
    bannedWords: ["专属禁词甲"],
    slopMuteCategories: ["stat_numeric"]
  });
  assert.equal(savedAudPack.ok, true);
  const audText = "他看到专属禁词甲后，力量提升了三倍，速度增加了五成，修为突破筑基。\n\n" + PARA_PROSE_A + "\n";
  writeFileSync(join(dirAud, "第01章.md"), audText, "utf8");
  const audRes = await AUDIT.runAuditContracts({
    root: rootAud,
    book: bookAud,
    chapterFile: "第01章.md",
    text: audText,
    options: { semanticEnabled: false }
  });
  assert.ok(audRes.violations.some((v) => v.contract === "banned" && String(v.title + v.text + v.detail).includes("专属禁词甲")), "runBannedContract 应命中书级题材包禁词");
  assert.equal(audRes.violations.some((v) => v.contract === "slop" && String(v.detail).includes("stat_numeric")), false, "runSlopContract 应遵守题材包 slopMuteCategories");

  // #29: assignChapterNumbers 将未编号的 序章.md 标为 resolved: false，不在 buildPlotLifecycle 中伪造占位章号
  const rootG = freshLib("graph-prologue");
  const bookG = "序章图谱书";
  const dirG = join(rootG, "novels", bookG);
  mkdirSync(dirG, { recursive: true });
  writeFileSync(join(dirG, "第01章.md"), PARA_PROSE_A + "\n", "utf8");
  writeFileSync(join(dirG, "序章.md"), "上古青铜钥匙在雪夜里失踪了。\n", "utf8");
  await CORE.writePlots(rootG, bookG, [{ id: "g1", content: "上古青铜钥匙下落", status: "open" }]);
  const graph = await GRAPH.buildStoryGraph(rootG, bookG, {}, null);
  const gPlot = graph.plotLifecycle.find((p) => p.id === "g1");
  assert.ok(gPlot);
  assert.equal(gPlot.firstChapter, void 0, "仅在未编号 序章.md 中出现的伏笔不得被赋予伪造的占位章号 2");

  // #30/#77: streamWithRawRetry 透传 AbortError 并在空重试流时回落原流
  const mkStream = (chunks) => (async function* () { for (const c of chunks) yield c; })();
  const softChunk = [{ type: "text-delta", text: "以下省略三百字，此处略去细节，不便展开。" }];
  const rawOpts = { messages: [{ role: "system", content: RAWGUARD.RAW_MODE_MARKER }] };
  let abortAttempt = 0;
  await assert.rejects(
    (async () => {
      for await (const _c of RAWGUARD.streamWithRawRetry(
        () => {
          abortAttempt += 1;
          if (abortAttempt === 1) return mkStream(softChunk);
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        },
        rawOpts
      )) { /* consume */ }
    })(),
    (err) => err?.name === "AbortError",
    "retry 抛出 AbortError 必须原样上抛"
  );
  assert.equal(abortAttempt, 2, "必须确实进入了重试分支才验证 AbortError 透传");

  let emptyAttempt = 0;
  const fallbackOut = [];
  for await (const c of RAWGUARD.streamWithRawRetry(
    () => {
      emptyAttempt += 1;
      return emptyAttempt === 1 ? mkStream(softChunk) : mkStream([]);
    },
    rawOpts
  )) {
    fallbackOut.push(c);
  }
  assert.equal(emptyAttempt, 2, "应触发一次重试");
  assert.equal(fallbackOut.length, 1, "空重试流必须回落输出原始流分片而非丢弃整次回复");
  assert.equal(fallbackOut[0].text, softChunk[0].text);

  // #81/#82: checkForUpdate 版本比较与带年份前缀 tag 归一化
  const prevFetch = globalThis.fetch;
  try {
    const cacheDirA = join(TMP_BASE, "upd-a");
    mkdirSync(cacheDirA, { recursive: true });
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ tag_name: "v7.6.0-canary.1", html_url: "https://example.invalid/r1" })
    });
    const u1 = await UPDATE.checkForUpdate("7.6.0", cacheDirA, { force: true });
    assert.equal(u1.updateAvailable, false, "正式版 7.6.0 不得把预发布 v7.6.0-canary.1 误判为更新");

    const cacheDirB = join(TMP_BASE, "upd-b");
    mkdirSync(cacheDirB, { recursive: true });
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ tag_name: "dsh-novel-writer-2026-v7.6.0", html_url: "https://example.invalid/r2" })
    });
    const u2 = await UPDATE.checkForUpdate("7.5.0", cacheDirB, { force: true });
    assert.equal(u2.latestVersion, "7.6.0", "带年份前缀的 tag 必须正确提取 7.6.0");
    assert.equal(u2.updateAvailable, true);
  } finally {
    globalThis.fetch = prevFetch;
  }

  // #86: classifyCacheError 不得因路径含 .json 而把 EIO 误判为 corrupt
  assert.notEqual(DIAGNOSE.classifyCacheError("EIO: i/o error, open 'book.json'"), "corrupt");
  assert.equal(DIAGNOSE.classifyCacheError("EIO: i/o error, open 'book.json'"), "unknown");
});

test("G4-7 (#58, #59, #64, #65, #160): vibe dim 隔离、vector-audit 自定义 embed 缓存隔离、judgeAgainstBaseline 跳过 NaN、compareExplicitness 240k 基准不误报 new、computeVibe 歧义态不报无信号", async () => {
  // #58: vibe.js 不同 emb 对象隔离 dim，不互相污染
  const mkEmb = (dim) => ({
    embed: async (s) => {
      const v = new Array(dim).fill(0);
      v[s.length % dim] = 1;
      return v;
    },
    cosine: (a, b) => {
      assert.equal(a.length, b.length, "不得把不同维度 emb 的原型缓存串用");
      let dot = 0;
      for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
      return dot;
    }
  });
  const d4 = await VIBE.semanticStyleDistances(PARA_PROSE_A, mkEmb(4));
  const d8 = await VIBE.semanticStyleDistances(PARA_PROSE_A, mkEmb(8));
  assert.ok(Array.isArray(d4) && d4.length > 0 && typeof d4[0].name === "string");
  assert.ok(Array.isArray(d8) && d8.length > 0 && typeof d8[0].name === "string");

  // #59: vector-audit.js 自定义 opts.embed 缓存隔离
  let calls1 = 0;
  let calls2 = 0;
  const emb1 = async () => { calls1 += 1; return [1, 0, 0, 0]; };
  const emb2 = async () => { calls2 += 1; return [0, 1, 0, 0]; };
  const body = (PARA_PROSE_A + "\n\n" + PARA_PROSE_B + "\n\n").repeat(2);
  await VEC.checkOutlineFulfillment("测试大纲条款", body, { isAvailable: async () => true, embed: emb1 });
  await VEC.checkOutlineFulfillment("测试大纲条款", body, { isAvailable: async () => true, embed: emb2 });
  assert.ok(calls1 > 0 && calls2 > 0, "不同自定义 opts.embed 必须隔离缓存，各自独立计算");

  // #64: judgeAgainstBaseline 跳过 NaN 指标值
  const baseline = {};
  for (const k of METRICS.METRIC_ORDER) baseline[k] = { mu: 10, recTol: 30 };
  const chMetrics = Object.fromEntries(METRICS.METRIC_ORDER.map((k) => [k, 10]));
  chMetrics.complexity = Number.NaN;
  const judged = METRICS.judgeAgainstBaseline(chMetrics, baseline, CORE.buildTolerance(baseline, 5));
  assert.ok(judged.skippedDims.some((s) => s.metric === "complexity"), "NaN 指标应进 skippedDims");
  assert.equal(judged.verdicts.some((v) => v.metric === "complexity"), false);

  // #65: compareExplicitness 处理 240k 字 1 命中（四舍五入后 per1000=0 但 raw>0）的基线不得误报 "new"
  const b240k = { chars: 240000, total: 1, per1000: 0, dialogueRatio: 0, byCategory: {} };
  const ch2k = { chars: 2000, total: 1, per1000: 0.5, dialogueRatio: 0, byCategory: {} };
  const cmp = EXPLICIT.compareExplicitness(ch2k, b240k);
  assert.notEqual(cmp.verdict, "new", "基线有真实 1 命中时不得因 per1000 四舍五入为 0 而误报 new");

  // #160: computeVibe 仅有歧义意象命中时，evidence 不得误说「无意象信号」
  const vibe = VIBE.computeVibe(
    { culture: "eastern", genre: { dominant: "" }, theme: { dominant: "" } },
    {
      dominant: "neutral",
      scores: [],
      quantification: {
        implicit: { totalHits: 0, totalAllHits: 3, ambHits: 3, ambiguousRatio: 1, negative: 0, positive: 0, fragile: false }
      }
    },
    ""
  );
  assert.equal((vibe.evidence || []).some((e) => String(e).includes("无意象信号")), false, "存在歧义意象命中时不得声称无意象信号");
});

// ===========================================================================
// Group 5: Tools Layer & Frontend Bundle
// (#10, #11, #31-#38, #87, #88, #91-#103, #132, #136, #137, #146, #148, #164, #165, #169, #196)
// ===========================================================================

test("G5-1 (#10): 禁用 novel_diagnose 时执行 execute 必须抛出错误", async () => {
  const root = freshLib("diag-disabled");
  const { defs, exec } = createHarness(root);
  resetStateFile({ tools: { novel_diagnose: false } });
  try {
    await assert.rejects(
      defs.novel_diagnose.execute({ root }, exec),
      /关闭|禁用|停用/,
      "已禁用的 novel_diagnose 必须在 execute 时抛错拦截"
    );
  } finally {
    resetStateFile();
  }
});

test("G5-2 (#11, #87, #88): /packs 坏 settings 绑定返回 409 保盘、GET 自动识别同名书包、POST save 返回 warnings 与 saveWarnings", async () => {
  const root = freshLib("packs-route");
  const book = "题材路由书";
  mkdirSync(join(root, "novels", book), { recursive: true });
  const { routeOf } = createHarness(root);
  const packsRoute = routeOf("/api/dsh-novel-writer/packs");
  assert.ok(packsRoute, "应注册 /api/dsh-novel-writer/packs 路由");

  // #11: settings/<book>.json 损坏时 bind 返回 409 且不破坏磁盘文件
  const sFile = CORE.settingsFile(root, book);
  mkdirSync(dirname(sFile), { recursive: true });
  writeFileSync(sFile, "{broken settings bytes", "utf8");
  const resBind = mkRes();
  await packsRoute.handler(
    mkReq("/api/dsh-novel-writer/packs", "POST", JSON.stringify({ action: "bind", book, packId: "western-fantasy" })),
    resBind
  );
  assert.equal(resBind.status, 409);
  assert.equal(JSON.parse(resBind.body).code, "SETTINGS_CORRUPT");
  assert.equal(readFileSync(sFile, "utf8"), "{broken settings bytes", "409 拒写时必须完整保留磁盘原文件");

  // 恢复合法 settings 后验证 #87: 未显式绑定时自动激活同名自定义包 <book>.json
  writeFileSync(sFile, JSON.stringify({ book, characters: [], locations: [], items: [], timeline: [], worldview: [] }), "utf8");
  const savedBookPack = await CORE.saveCustomPack(root, { id: book, name: "同名自动包", bannedWords: ["禁词一"] });
  assert.equal(savedBookPack.ok, true);
  const resGet = mkRes();
  await packsRoute.handler(mkReq(`/api/dsh-novel-writer/packs?book=${encodeURIComponent(book)}`, "GET"), resGet);
  assert.equal(resGet.status, 200);
  const getData = JSON.parse(resGet.body);
  assert.equal(getData.activePack?.id, book, "GET /packs 必须汇报自动激活的 <book>.json 题材包");

  // #88: POST /packs save 返回合并 warnings 且单独返回 saveWarnings
  const resSave = mkRes();
  await packsRoute.handler(
    mkReq("/api/dsh-novel-writer/packs", "POST", JSON.stringify({
      action: "save",
      pack: { id: "warn-save-pack", name: "告警测试包", speechStyle: { ritualBadPatterns: ["(a+)+$"] } }
    })),
    resSave
  );
  assert.equal(resSave.status, 200);
  const saveData = JSON.parse(resSave.body);
  assert.ok(Array.isArray(saveData.warnings) && saveData.warnings.length > 0, "应返回合并 warnings");
  assert.ok(Array.isArray(saveData.saveWarnings) && saveData.saveWarnings.length > 0, "应返回独立的 saveWarnings");
});

test("G5-3 (#31, #32, #103): novel_continuity_check OOC n=5 跳变检出、中文万级数字解析准确、角色名 constructor 不崩溃", async () => {
  const root = freshLib("cont-ooc-num");
  const book = "连贯测试书";
  const dir = join(root, "novels", book);
  mkdirSync(dir, { recursive: true });

  // #31: n=5，前 4 章林舟周围呈强烈正向效价，第 5 章骤降为强烈负向效价，触发小样本 OOC 跳变
  const happyCtx = "林舟满心欢喜，笑容温暖甜蜜，心中踏实欣慰又快乐幸福，整个人喜悦兴奋。\n";
  const darkCtx = "林舟暴怒绝望，心中充满了愤怒怨恨与悲痛欲绝，浑身恐惧颤抖心灰意冷。\n";
  // #32: 同值等价表达（1.5万 vs 一万五千；二十五万 vs 25万；一百五十万 vs 150万；0万不产生错误匹配）
  writeFileSync(join(dir, "第01章.md"), happyCtx + "城主赏赐银票1.5万两，库房存粮二十五万石，军费一百五十万贯，欠款0万两。\n", "utf8");
  writeFileSync(join(dir, "第02章.md"), happyCtx + "城主赏赐银票一万五千两，库房存粮25万石，军费150万贯。\n", "utf8");
  writeFileSync(join(dir, "第03章.md"), happyCtx + "constructor高兴微笑着说道：“我还在。”\n", "utf8");
  writeFileSync(join(dir, "第04章.md"), happyCtx + "constructor欣慰温暖地说道：“记住了。”\n", "utf8");
  writeFileSync(join(dir, "第05章.md"), darkCtx + "constructor悲伤绝望地说道：“一切都完了。”\n", "utf8");

  await CORE.writeSettings(root, book, {
    characters: [
      { name: "林舟", traits: "沉稳" },
      { name: "constructor", traits: "原型键名压力测试角色" }
    ],
    locations: [],
    items: [],
    timeline: [],
    worldview: [{ name: "默认世界观", basis: "东方古代", bannedWords: [] }]
  });

  const { defs, exec } = createHarness(root);
  const oocRes = await defs.novel_continuity_check.execute({ book, ooc: true, root }, exec);
  assert.ok(
    oocRes.candidates.some((c) => String(c.type).includes("OOC") && String(c.detail).includes("林舟")),
    `n=5 情绪剧变应检出林舟 OOC，实际 candidates=${JSON.stringify(oocRes.candidates)}`
  );

  // #32: 全书常规连贯性检查正确解析 1.5万==一万五千 / 二十五万==25万 / 一百五十万==150万 为同值异写，且忽略 0万
  const fullRes = await defs.novel_continuity_check.execute({ book, root }, exec);
  const numIssues = fullRes.candidates.filter((c) => String(c.type).includes("数字"));
  assert.ok(numIssues.some((c) => c.detail.includes("1.5万") && c.detail.includes("一万五千")), "1.5万 与 一万五千 应解析为同一数值 15000");
  assert.ok(numIssues.some((c) => c.detail.includes("二十五万") && c.detail.includes("25万")), "二十五万 与 25万 应解析为同一数值 250000");
  assert.ok(numIssues.some((c) => c.detail.includes("一百五十万") && c.detail.includes("150万")), "一百五十万 与 150万 应解析为同一数值 1500000");
  assert.equal(numIssues.some((c) => c.detail.includes("「0万」")), false, "0万 应被忽略，不得产生误报");
});

test("G5-4 (#91-#95): 空词表 delete all:true 幂等、未分类导入、formatImport 渲染 maybe/candidate、formatBookDelete 优先 message、保留书名拦截", async () => {
  const root = freshLib("tools-misc");
  const { defs, exec } = createHarness(root);

  // #91: 空词表 delete all:true 幂等成功
  const delEmpty = await defs.novel_lexicon.execute({ action: "delete", book: "空词表书", all: true, root }, exec);
  assert.deepEqual(delEmpty.removed, []);

  // #92: book: "未分类" 可正常导入
  const srcDir = join(root, "inbox-unclass");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "第01章 散稿.md"), "# 散稿\n\n" + PARA_PROSE_A + "\n", "utf8");
  const impUnclass = await defs.novel_import.execute({ src: srcDir, book: "未分类", mode: "apply", root }, exec);
  assert.equal(impUnclass.imported.length, 1);
  assert.equal(impUnclass.imported[0].book, "未分类");

  // #93: formatImport 渲染 maybe 与 bookNameCandidate
  const formattedImp = CORE.formatImport({
    src: srcDir,
    mode: "preview",
    groups: [{
      book: "星海",
      from: "file",
      maybe: ["星海纪元"],
      files: [{ file: "第01章.md", chapter: 1, bookNameCandidate: "星海传" }]
    }],
    skipped: [],
    imported: []
  }, root);
  assert.match(formattedImp, /可能同书：星海纪元/);
  assert.match(formattedImp, /候选书名：星海传/);

  // #94: formatBookDelete 存在幂等 message 时先于 !found 分支渲染
  const formattedDel = BOOKDELETE.formatBookDelete({
    book: "已删书",
    action: "apply",
    found: false,
    message: "该书此前已清理完毕（幂等确认）",
    targets: [],
    totalFiles: 0,
    totalBytes: 0,
    notTouched: []
  });
  assert.match(formattedDel, /该书此前已清理完毕（幂等确认）/);

  // #95: 保留书名「创作资料」与「_global」在 novel_new_chapter 与 novel_import 均被拒绝
  for (const reserved of ["创作资料", "_global"]) {
    await assert.rejects(
      defs.novel_new_chapter.execute({ book: reserved, content: "正文\n", root }, exec),
      /保留|不能/,
      `novel_new_chapter 必须拒绝保留书名 ${reserved}`
    );
    await assert.rejects(
      defs.novel_import.execute({ src: srcDir, book: reserved, mode: "scan", root }, exec),
      /保留|不能/,
      `novel_import 必须拒绝保留书名 ${reserved}`
    );
  }
});

test("G5-5 (#96, #99-#102, #132, #146, #165): 仪式正则 warn 放行、list 零 .lock、语义检索拒空白书名、scan lastMentioned 不倒退、timeline 保留 day、fix_plan audit 闭合 </content>", async () => {
  // #96: ^上香$ 为 level:"warn"，应通过 assertRitualPatternsValid
  assert.doesNotThrow(() => STORY_TOOLS.assertRitualPatternsValid({ ritualBadPatterns: ["^上香$"] }));

  const root = freshLib("story-style-misc");
  const book = "故事工具书";
  const dir = join(root, "novels", book);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "第02章.md"), "他在抽屉深处摸到那枚青铜秘钥。\n", "utf8");
  writeFileSync(join(dir, "第05章.md"), "城门前再次出现那枚青铜秘钥的线索。\n", "utf8");
  const { defs, exec } = createHarness(root);

  // #99: novel_settings(list) 与 novel_plot(list) 不创建任何 .lock 文件
  await defs.novel_settings.execute({ book, action: "list", root }, exec);
  await defs.novel_plot.execute({ book, action: "list", root }, exec);
  const findLockFiles = (d) => {
    if (!existsSync(d)) return [];
    const found = [];
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) found.push(...findLockFiles(full));
      else if (e.name.endsWith(".lock")) found.push(full);
    }
    return found;
  };
  assert.deepEqual(findLockFiles(CORE.novelDataDir(root)), [], "只读 list 不得遗留或创建任何 .lock 文件");

  // #100: novel_semantic_search 拒绝空白书名
  await assert.rejects(
    defs.novel_semantic_search.execute({ book: "   ", query: "秘钥", root }, exec),
    /book|不能为空/
  );

  // #101: novel_plot(scan) 先扫第 5 章再扫第 2 章时，lastMentioned 不得倒退
  const addedPlot = await defs.novel_plot.execute({ book, action: "add", content: "青铜秘钥的来历", chapter: "第01章.md", root }, exec);
  const plotId = addedPlot.entries[0].id;
  await defs.novel_plot.execute({ book, action: "scan", chapter: "5", root }, exec);
  await defs.novel_plot.execute({ book, action: "scan", chapter: "2", root }, exec);
  const listedPlots = await defs.novel_plot.execute({ book, action: "list", root }, exec);
  const p = listedPlots.entries.find((e) => e.id === plotId);
  assert.equal(p.lastMentioned, "第05章.md", "扫描更早章节不得让 lastMentioned 从第05章倒退到第02章");

  // #132: novel_settings(timeline) 显式传 name 与 day 时保留显式 day
  const tlAdd = await defs.novel_settings.execute({
    book,
    category: "timeline",
    action: "add",
    name: "祭典夜",
    day: "第三日夜",
    event: "城门遇袭",
    root
  }, exec);
  assert.equal(tlAdd.timeline[0].day, "第三日夜", "timeline 显式 day 不得被 name 覆盖");

  // #165: novel_fix_plan 三条 audit 早返回渲染路径全部正确闭合 </content>
  const renderFix = defs.novel_fix_plan.output.render;
  for (const sample of [
    { book, action: "audit", summary: "s", auditReport: { file: "第02章.md", lines: 1, contracts: [], violations: [], summary: "s" } },
    { book, action: "audit_brief", summary: "s", auditBrief: { brief: "brief text", allowedContracts: ["banned"] } },
    { book, action: "audit_verify", summary: "s", auditVerify: { total: 0, score: 100, accepted: [], corrected: [], rejected: [] } }
  ]) {
    const out = renderFix({}, sample);
    assert.ok(Array.isArray(out) && out.length === 1);
    assert.ok(out[0].text.trim().endsWith("</content>"), `audit 分支 ${sample.action} 渲染必须闭合 </content>`);
  }
});

test("G5-6 (#33, #34, #37, #38, #136, #137, #148, #169, #196): client.js VM 加载与全部前端审计修复回归", () => {
  const clientCode = readFileSync(join(REPO_ROOT, "lib", "client.js"), "utf8");

  // 1) 真实 React.Component 基类 + 抛错官方 Button，验证 #33 PrimitiveBoundary 不直接调 invocable() 且捕获抛错回退
  let officialButtonDirectCalls = 0;
  function ThrowingOfficialButton() {
    officialButtonDirectCalls += 1;
    throw new Error("official primitive boom");
  }
  class RealComponent {
    constructor(props) { this.props = props; this.state = {}; }
  }
  const reactStub = {
    Component: RealComponent,
    createElement: (type, props, ...children) => ({
      $$typeof: Symbol.for("react.element"),
      type,
      props: { ...(props || {}), children: children.length <= 1 ? children[0] : children }
    }),
    isValidElement: (x) => Boolean(x && typeof x === "object" && x.$$typeof),
    useState: (init) => [typeof init === "function" ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v })
  };

  let loadedExports = null;
  const { document } = createMinimalDomStub();
  const sandbox = {
    console: { warn: () => {}, error: () => {}, log: () => {} },
    document,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    AbortController,
    AbortSignal,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    __ModuleLoader__: {
      load: ({ factory }) => {
        loadedExports = factory((id) => {
          if (id === "react") return reactStub;
          if (id === "react-dom/client") return { createRoot: () => ({ render: () => {}, unmount: () => {} }) };
          if (id === "@deepseek-ai/dsh-client-ui-primitives") return { Button: ThrowingOfficialButton };
          throw new Error("unexpected require: " + id);
        });
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(clientCode, sandbox, { filename: "lib/client.js" });
  assert.ok(loadedExports && loadedExports.__internals?.NW_UI);

  // #33: NW_UI.Button 返回 PrimitiveBoundary 元素而非直接调用 ThrowingOfficialButton()
  const btnEl = loadedExports.__internals.NW_UI.Button({ variant: "primary", children: "确定" });
  assert.equal(officialButtonDirectCalls, 0, "Adapted 组件不得在渲染中直接裸调官方原语函数");
  assert.equal(typeof btnEl.type, "function");
  assert.equal(btnEl.type.name, "PrimitiveBoundary");
  assert.ok(btnEl.type.prototype instanceof RealComponent, "PrimitiveBoundary 必须继承 React.Component");
  const boundaryInst = new btnEl.type(btnEl.props);
  const normalChild = boundaryInst.render();
  assert.equal(normalChild.type, ThrowingOfficialButton);
  const errState = btnEl.type.getDerivedStateFromError(new Error("boom"));
  boundaryInst.state = { ...boundaryInst.state, ...errState };
  const fallbackChild = boundaryInst.render();
  assert.equal(fallbackChild.type, "button", "捕获异常后 PrimitiveBoundary 应渲染原生回退 button");

  // 2) #196: official 模式下 openPanel 调用 layout.selectPanel("dsh-novel-writer")
  const selectedPanels = [];
  const registeredSettingsCards = [];
  const mockCtx = {
    slots: {
      specDynamic: (name) => name === "sidebar.panellist" || name === "main" || name === "settings.plugin.item",
      inject: (_name, cb) => cb(),
      register: (meta, comp) => {
        if (meta.name === "settings.plugin.item") registeredSettingsCards.push(comp);
        return () => {};
      }
    },
    get: (svc) => (svc === "layout" ? { selectPanel: (id) => selectedPanels.push(id) } : null),
    locale: { getSnapshot: () => ({ active: "zh-CN" }), subscribe: () => () => {} },
    effect: () => {}
  };
  loadedExports.apply(mockCtx);
  assert.equal(registeredSettingsCards.length, 1, "应注册 settings.plugin.item 卡片");
  const cardVNode = registeredSettingsCards[0]();
  assert.equal(typeof cardVNode.props.onOpenPanel, "function");
  cardVNode.props.onOpenPanel();
  assert.deepEqual(selectedPanels, ["dsh-novel-writer"], "官方模式下 openPanel 必须调用 layout.selectPanel(NW_PANEL_ID)");

  // 3) 提取并直接运行 client.js 中的纯逻辑函数 + 检查 zh/en 字典词条
  const fnProbe = vm.runInNewContext(
    `(function () {\n` +
    clientCode.slice(clientCode.indexOf("function isPickableDeleteTarget"), clientCode.indexOf("function parseWordMappingLines")) + "\n" +
    clientCode.slice(clientCode.indexOf("function featureIsOn"), clientCode.indexOf("// Tool icons describe")) + "\n" +
    clientCode.slice(clientCode.indexOf("var zh = {"), clientCode.indexOf("/* === module: i18n/index.js === */")) + "\n" +
    `return { isPickableDeleteTarget, parsePackListText, featureIsOn, zh, en };\n})()`,
    {},
    { filename: "client-helpers-probe.js" }
  );

  // #34: isPickableDeleteTarget 放行空目录 (kind: "dir", exists: true, files: 0)
  assert.equal(fnProbe.isPickableDeleteTarget({ kind: "dir", exists: true, files: 0 }), true);
  assert.equal(fnProbe.isPickableDeleteTarget({ kind: "file", exists: true, files: 0 }), false);
  assert.equal(fnProbe.isPickableDeleteTarget({ kind: "dir", exists: false, files: 0 }), false);

  // #37: featureIsOn 默认关 chatWriting / rawWriting，其余默认开
  assert.equal(fnProbe.featureIsOn({}, "chatWriting"), false);
  assert.equal(fnProbe.featureIsOn({}, "rawWriting"), false);
  assert.equal(fnProbe.featureIsOn({}, "styleAnchor"), true);
  assert.equal(fnProbe.featureIsOn({ chatWriting: true }, "chatWriting"), true);

  // #38: trash.purgeDesc 替换全部 {target} 占位符（源码确认 split/join 且实测无残留）
  assert.match(clientCode, /t\("trash\.purgeDesc"\)\)\.split\("\{target\}"\)\.join\(/);
  for (const dict of [fnProbe.zh, fnProbe.en]) {
    const rendered = String(dict["trash.purgeDesc"]).split("{target}").join("测试书").split("{id}").join("t1");
    assert.equal(rendered.includes("{target}"), false, "purgeDesc 不得残留未替换的 {target}");
    assert.equal(rendered.includes("{id}"), false);
    assert.equal((rendered.match(/测试书/g) || []).length, 2, "purgeDesc 应替换全部两处 {target}");
  }

  // #136: parsePackListText("constructor, toString, foo") 保留原型链同名项
  assert.deepEqual(Array.from(fnProbe.parsePackListText("constructor, toString, foo")), ["constructor", "toString", "foo"]);

  // #137: tol.halfFilled 中文无 "」」"，英文无 "「"
  assert.equal(fnProbe.zh["tol.halfFilled"].includes("」」"), false, "zh tol.halfFilled 不得含重复闭引号 」」");
  assert.equal(fnProbe.en["tol.halfFilled"].includes("「"), false, "en tol.halfFilled 不得混入中文引号 「");

  // #148/#169: draft.segmentHeading 在 zh 与 en 中均存在且含 {n}
  assert.equal(typeof fnProbe.zh["draft.segmentHeading"], "string");
  assert.equal(typeof fnProbe.en["draft.segmentHeading"], "string");
  assert.ok(fnProbe.zh["draft.segmentHeading"].includes("{n}"));
  assert.ok(fnProbe.en["draft.segmentHeading"].includes("{n}"));
});

// ===========================================================================
// 终局隔离守卫：确认用户真实 ~/.dsh 与 ~/.gemini/config 零改动
// ===========================================================================

test("ISOLATION GUARD: 真实 ~/.dsh/dsh-novel-writer 与 ~/.gemini/config 零字节创建或修改", () => {
  assert.equal(digestTree(REAL_DSH_DIR), realBefore.dsh, "测试绝不得改动真实 ~/.dsh/dsh-novel-writer");
  assert.equal(digestTree(REAL_GEMINI_CONFIG_DIR), realBefore.geminiConfig, "测试绝不得改动真实 ~/.gemini/config");
});
