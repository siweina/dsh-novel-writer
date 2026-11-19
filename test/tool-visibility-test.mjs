/**
 * test/tool-visibility-test.mjs —— 第 39 套回归测试：工具可见性与 MCP 预设过滤
 *
 * 覆盖分组：
 *   A. 宿主 register(def, { when }) 可见性测试（同时覆盖可写与只读冻结 tools.register）
 *      1. ALL_TOOLS（22 个，含 novel_outline）注册均收到 options.when；非 ALL_TOOLS 合成探针保持 1 参调用且不被注入 when
 *      2. 无 state.json 时 22 个 when() 全返回 true
 *      3. writeSentenceState 关闭 3 个工具后零等待立即返回 false，其余 19 个返回 true
 *      4. writeSentenceState 重开后零等待全部返回 true
 *      5. 防死锁：磁盘手写 novel_sentence_config:false 后配合 resetToolVisibilityCache() 仍恒为 true
 *      6. state.enabled === false 隔离：所有工具 when() 仍全返回 true（总开关不误隐藏工具）
 *      7. Fail-open：损坏 JSON + resetToolVisibilityCache() 后 22 个 when() 全返回 true 且不抛异常
 *      8. 路径切换隔离：切换 DSH_NOVEL_WRITER_STATE（文件 A → 文件 B）不调 resetToolVisibilityCache、不等待 300ms 即刻生效
 *      9. 系统提示词防悬空：有关闭工具且非 off 档时追加固定提示；全开或 off 档零注入
 *   B. MCP stdio 集成测试（真实 mcp/server.mjs 子进程 + 临时书库 + 临时 DSH_NOVEL_WRITER_STATE）
 *      1. 启动前禁用 3 工具 + 手写 novel_sentence_config:false → tools/list 返回 19 个工具，stdout 无非 JSON / 游离帧
 *      2. 同会话 tools/call novel_sentence_config set 重开 novel_plot → 紧接着 tools/list 立即返回 20 个工具
 *      3. 同会话直接调用被 state.json 禁用的 novel_import → 返回清晰 isError:true 文案（非协议错）
 *      4. --preset writing → tools/list 精确匹配 MCP_TOOL_PRESETS.writing；调用预设外 novel_delete_book 返回 isError:true 且提及 --preset writing
 *      5. --preset writing + state.json 禁用 novel_lexicon → tools/list 返回交集
 *      6. 未知预设 --preset nope → stderr 告警且回退 all（22 工具），关闭 stdin 后 exit 0
 *      7. 环境变量 DSH_NOVEL_WRITER_PRESET=revising → tools/list 精确匹配 MCP_TOOL_PRESETS.revising
 *
 * 隔离：
 *   - 使用 realpathSync.native(mkdtempSync(join(tmpdir(), ...))) 建立临时目录；
 *   - 在动态导入任何 lib/* 前将 DSH_NOVEL_WRITER_STATE 与 DSH_HOME 重定向至临时路径；
 *   - try/finally 与 process.on("exit") 中彻底清理，并校验用户真实 ~/.dsh 目录未被写入。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PREV_STATE_ENV = process.env.DSH_NOVEL_WRITER_STATE;
const PREV_HOME_ENV = process.env.DSH_HOME;
const PREV_PRESET_ENV = process.env.DSH_NOVEL_WRITER_PRESET;
const PREV_ROOT_ENV = process.env.DSH_NOVEL_WRITER_ROOT;

const REAL_STATE = join(homedir(), ".dsh", "dsh-novel-writer", "state.json");
const REAL_LOG_DIR = join(homedir(), ".dsh", "dsh-novel-writer", "logs");
function digestFile(file) {
  try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch { return "absent"; }
}
function digestDir(dir) {
  try { return readdirSync(dir).sort().map((n) => n + ":" + digestFile(join(dir, n))).join("|"); } catch { return "absent"; }
}
const realBefore = { state: digestFile(REAL_STATE), logs: digestDir(REAL_LOG_DIR) };

const TMP_DIR = realpathSync.native(mkdtempSync(join(tmpdir(), "dsh-tool-visibility-" + process.pid + "-")));
const STATE_A = join(TMP_DIR, "state-a", "state.json");
const STATE_B = join(TMP_DIR, "state-b", "state.json");
const DSH_HOME_DIR = join(TMP_DIR, "dsh-home");
const LIB_ROOT = join(TMP_DIR, "library");

mkdirSync(dirname(STATE_A), { recursive: true });
mkdirSync(dirname(STATE_B), { recursive: true });
mkdirSync(DSH_HOME_DIR, { recursive: true });
mkdirSync(join(LIB_ROOT, "novels", "测试书"), { recursive: true });
writeFileSync(join(LIB_ROOT, "novels", "测试书", "第01章.md"), "夜色沉了下来。他推开木门，听见院外传来细碎的脚步声。\n", "utf8");
writeFileSync(join(LIB_ROOT, "novels", "测试书", "第02章.md"), "次日清晨，雾气未散。她在石阶前停住脚步，低头看向手中的信笺。\n", "utf8");

process.env.DSH_NOVEL_WRITER_STATE = STATE_A;
process.env.DSH_HOME = DSH_HOME_DIR;

const activeChildren = new Set();
let cleaned = false;
function cleanup() {
  for (const child of activeChildren) {
    try { child.kill("SIGKILL"); } catch { /* 忽略 */ }
  }
  activeChildren.clear();
  if (PREV_STATE_ENV === void 0) delete process.env.DSH_NOVEL_WRITER_STATE;
  else process.env.DSH_NOVEL_WRITER_STATE = PREV_STATE_ENV;
  if (PREV_HOME_ENV === void 0) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_HOME_ENV;
  if (PREV_PRESET_ENV === void 0) delete process.env.DSH_NOVEL_WRITER_PRESET;
  else process.env.DSH_NOVEL_WRITER_PRESET = PREV_PRESET_ENV;
  if (PREV_ROOT_ENV === void 0) delete process.env.DSH_NOVEL_WRITER_ROOT;
  else process.env.DSH_NOVEL_WRITER_ROOT = PREV_ROOT_ENV;
  if (!cleaned) {
    try {
      rmSync(TMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      cleaned = true;
    } catch { /* 进程退出钩子再次兜底 */ }
  }
}
process.on("exit", cleanup);

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SERVER_PATH = join(REPO_ROOT, "mcp", "server.mjs");

// 动态导入共享层与插件入口（确保在 env 重定向之后）
const CORE = await import("../lib/core.js");
const PLUGIN = await import("../lib/index.js");
const PROMPTS = await import("../lib/prompts.js");

const { ALL_TOOLS, ALWAYS_VISIBLE_TOOLS, isToolVisibleSync, resetToolVisibilityCache, writeSentenceState } = CORE;
const { apply } = PLUGIN;
const { promptTextFor } = PROMPTS;

// 从 mcp/server.mjs 单一事实源提取 MCP_TOOL_PRESETS
function loadServerPresets() {
  const src = readFileSync(SERVER_PATH, "utf8");
  const marker = "const MCP_TOOL_PRESETS = ";
  const start = src.indexOf(marker);
  assert.ok(start > 0, "应在 mcp/server.mjs 中定位 MCP_TOOL_PRESETS");
  const end = src.indexOf("});", start);
  assert.ok(end > start, "应在 mcp/server.mjs 中定位 MCP_TOOL_PRESETS 结束括号");
  const expr = src.slice(start + marker.length, end + 2);
  const presets = vm.runInNewContext(`(${expr})`);
  assert.ok(presets && typeof presets === "object", "MCP_TOOL_PRESETS 解析应为对象");
  return presets;
}
const MCP_TOOL_PRESETS = loadServerPresets();

let pass = 0;
let fail = 0;
function group(title) {
  console.log(`\n=== ${title} ===`);
}
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  ✗ ${name}`);
    console.error("   ", error?.stack || error);
  }
}

function startServer({ args = [], env = {}, stateFile }) {
  const childEnv = { ...process.env };
  delete childEnv.DSH_NOVEL_WRITER_PRESET;
  delete childEnv.DSH_NOVEL_WRITER_ROOT;
  Object.assign(childEnv, { DSH_NOVEL_WRITER_STATE: stateFile, DSH_HOME: DSH_HOME_DIR }, env);

  const child = spawn(process.execPath, [SERVER_PATH, "--root", LIB_ROOT, ...args], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"]
  });
  activeChildren.add(child);

  const pending = new Map();
  const badLines = [];
  const stray = [];
  const stderrChunks = [];
  let nextId = 1;
  let exited = null;

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      badLines.push(line);
      return;
    }
    if (msg && msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      entry.resolve(msg);
      return;
    }
    stray.push(msg);
  });
  child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));
  child.on("exit", (code, signal) => {
    exited = { code, signal };
    activeChildren.delete(child);
    rl.close();
    for (const [, entry] of pending) {
      entry.reject(new Error(`服务器提前退出（code=${code}, signal=${signal}），stderr=${stderrChunks.join("")}`));
    }
    pending.clear();
  });

  const request = (method, params) => new Promise((resolve, reject) => {
    if (exited !== null) {
      reject(new Error(`服务器已退出，无法发送 ${method}`));
      return;
    }
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`请求超时：${method}；stderr=${stderrChunks.join("")}`));
      }
    }, 30000);
    pending.set(id, {
      resolve: (msg) => { clearTimeout(timer); resolve(msg); },
      reject: (err) => { clearTimeout(timer); reject(err); }
    });
    const frame = { jsonrpc: "2.0", id, method };
    if (params !== undefined) frame.params = params;
    child.stdin.write(JSON.stringify(frame) + "\n");
  });

  const notify = (method, params) => {
    const frame = { jsonrpc: "2.0", method };
    if (params !== undefined) frame.params = params;
    child.stdin.write(JSON.stringify(frame) + "\n");
  };

  const stop = () => new Promise((resolve) => {
    if (exited !== null) {
      resolve(exited);
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
    try { child.stdin.end(); } catch { /* 忽略 */ }
    setTimeout(() => {
      if (exited === null) {
        try { child.kill("SIGKILL"); } catch { /* 忽略 */ }
      }
    }, 10000).unref();
  });

  return {
    request,
    notify,
    stop,
    badLines,
    stray,
    stderrText: () => stderrChunks.join("")
  };
}

function toolText(res) {
  return String(res?.result?.content?.[0]?.text ?? "");
}

function sorted(list) {
  return [...list].sort();
}

try {
  // =========================================================================
  // Group A: 宿主 register(def, { when }) 测试
  // =========================================================================
  group("Group A · 宿主 register(def, { when }) 与缓存语义");

  // 1) 可写 tools.register（带审计包装）
  const writableCalls = [];
  const probeCalls = [];
  let applyFinished = false;
  let capturedAuditedRegister = null;
  function originalRegister(def, options) {
    const rec = { def, options, argc: arguments.length };
    if (applyFinished) probeCalls.push(rec);
    else writableCalls.push(rec);
    if (!capturedAuditedRegister && this && typeof this.register === "function" && this.register !== originalRegister) {
      capturedAuditedRegister = this.register;
    }
    return () => {};
  }
  const promptSections = [];
  const writableCtx = {
    tools: { register: originalRegister },
    systemPrompt: { section: (s) => { promptSections.push(s); return () => {}; } },
    inject: () => {}
  };
  apply(writableCtx, { root: LIB_ROOT });
  applyFinished = true;

  // 2) 只读冻结 tools.register（走 regCtx 回退包装）
  const frozenCalls = [];
  const frozenTools = Object.freeze({
    register(def, options) {
      frozenCalls.push({ def, options, argc: arguments.length });
      return () => {};
    }
  });
  const frozenCtx = {
    tools: frozenTools,
    systemPrompt: { section: () => () => {} },
    inject: () => {}
  };
  apply(frozenCtx, { root: LIB_ROOT });

  const writableByName = new Map(writableCalls.map((c) => [c.def.name, c]));
  const frozenByName = new Map(frozenCalls.map((c) => [c.def.name, c]));
  const harnesses = [
    ["可写 tools.register", writableCalls, writableByName],
    ["只读冻结 tools.register", frozenCalls, frozenByName]
  ];

  await check("A1: 22 个 ALL_TOOLS（含 novel_outline）均收到 options.when；非 ALL_TOOLS 合成探针保持 1 参调用", () => {
    assert.equal(ALL_TOOLS.length, 22);
    assert.ok(ALL_TOOLS.includes("novel_outline"), "ALL_TOOLS 必须包含 novel_outline");
    assert.equal(writableCtx.tools.register, originalRegister, "apply 结束后必须还原可写 tools.register");
    assert.equal(Object.isFrozen(frozenCtx.tools), true, "只读冻结 tools 对象保持冻结");

    for (const [label, calls, byName] of harnesses) {
      assert.equal(calls.length, ALL_TOOLS.length, `${label} 应注册 ${ALL_TOOLS.length} 个工具`);
      assert.deepEqual(sorted(calls.map((c) => c.def.name)), sorted(ALL_TOOLS), `${label} 工具清单应与 ALL_TOOLS 一致`);
      for (const name of ALL_TOOLS) {
        const rec = byName.get(name);
        assert.ok(rec, `${label} 缺少工具 ${name}`);
        assert.equal(rec.argc, 2, `${label} ${name} 应以 2 参 register(def, { when }) 调用`);
        assert.ok(rec.options && typeof rec.options.when === "function", `${label} ${name} 必须收到 options.when 函数`);
      }
      const outlineRec = byName.get("novel_outline");
      assert.equal(typeof outlineRec?.options?.when, "function", `${label} novel_outline 必须收到 options.when`);
    }

    assert.equal(typeof capturedAuditedRegister, "function", "应捕获审计包装 auditedRegister");
    capturedAuditedRegister({
      name: "probe_non_plugin_tool",
      description: "合成探针",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true })
    });
    assert.equal(probeCalls.length, 1, "合成探针应通过 auditedRegister 透传一次");
    assert.equal(probeCalls[0].argc, 1, "非 ALL_TOOLS 合成探针必须保持原样 1 参调用");
    assert.equal(probeCalls[0].options, void 0, "非 ALL_TOOLS 合成探针不得被注入 options");

    capturedAuditedRegister(
      {
        name: "probe_non_plugin_with_opts",
        description: "带自定义选项的合成探针",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ ok: true })
      },
      { keep: true }
    );
    assert.equal(probeCalls.length, 2);
    assert.equal(probeCalls[1].argc, 2);
    assert.deepEqual(probeCalls[1].options, { keep: true }, "非 ALL_TOOLS 探针原有 options 不得被注入 when");
  });

  await check("A2: 无 state.json 时全部 22 个 when() 返回 true", () => {
    assert.equal(existsSync(STATE_A), false, "测试前不应存在 state.json");
    resetToolVisibilityCache();
    for (const [label, , byName] of harnesses) {
      for (const name of ALL_TOOLS) {
        assert.equal(byName.get(name).options.when(), true, `${label} 无 state.json 时 ${name}.when() 应返回 true`);
      }
    }
  });

  await check("A3: writeSentenceState 关闭 3 个工具后零等待立即返回 false，其余 19 个返回 true", async () => {
    const offTools = ["novel_plot", "novel_import", "novel_outline"];
    await writeSentenceState({ tools: { novel_plot: false, novel_import: false, novel_outline: false } });
    // 零等待（不 sleep），直接校验
    for (const [label, , byName] of harnesses) {
      let falseCount = 0;
      let trueCount = 0;
      for (const name of ALL_TOOLS) {
        const visible = byName.get(name).options.when();
        if (offTools.includes(name)) {
          assert.equal(visible, false, `${label} 关闭 ${name} 后 when() 应立即返回 false`);
          falseCount += 1;
        } else {
          assert.equal(visible, true, `${label} 未关闭的 ${name} when() 应返回 true`);
          trueCount += 1;
        }
      }
      assert.equal(falseCount, 3);
      assert.equal(trueCount, 19);
    }
  });

  await check("A4: writeSentenceState 重开 3 个工具后零等待全部返回 true", async () => {
    await writeSentenceState({ tools: { novel_plot: true, novel_import: true, novel_outline: true } });
    // 零等待（不 sleep），直接校验
    for (const [label, , byName] of harnesses) {
      for (const name of ALL_TOOLS) {
        assert.equal(byName.get(name).options.when(), true, `${label} 重开后 ${name}.when() 应立即返回 true`);
      }
    }
  });

  await check("A5: 防死锁：磁盘手写 novel_sentence_config:false + novel_plot:false 后 novel_sentence_config 恒返回 true", () => {
    assert.ok(ALWAYS_VISIBLE_TOOLS.includes("novel_sentence_config"), "ALWAYS_VISIBLE_TOOLS 必须包含 novel_sentence_config");
    writeFileSync(STATE_A, JSON.stringify({ tools: { novel_sentence_config: false, novel_plot: false } }), "utf8");
    resetToolVisibilityCache();
    assert.equal(isToolVisibleSync("novel_sentence_config"), true);
    for (const [label, , byName] of harnesses) {
      assert.equal(byName.get("novel_sentence_config").options.when(), true, `${label} novel_sentence_config 必须防死锁恒返回 true`);
      assert.equal(byName.get("novel_plot").options.when(), false, `${label} novel_plot 应返回 false`);
      for (const name of ALL_TOOLS) {
        if (name !== "novel_plot") {
          assert.equal(byName.get(name).options.when(), true, `${label} ${name} 应返回 true`);
        }
      }
    }
  });

  await check("A6: state.enabled === false 隔离：所有工具（含非句式与句式工具）when() 仍全部返回 true", async () => {
    rmSync(STATE_A, { force: true });
    await writeSentenceState({ enabled: false, tools: {} });
    const spotlight = ["novel_books", "novel_read", "novel_plot", "novel_chapter_brief", "novel_sentence_config"];
    for (const [label, , byName] of harnesses) {
      for (const name of spotlight) {
        assert.equal(byName.get(name).options.when(), true, `${label} enabled=false 时 ${name}.when() 仍必须为 true`);
      }
      for (const name of ALL_TOOLS) {
        assert.equal(byName.get(name).options.when(), true, `${label} enabled=false 时 ${name}.when() 必须为 true`);
      }
    }
  });

  await check("A7: Fail-open：state.json 损坏 JSON + resetToolVisibilityCache() 后全部 22 个 when() 返回 true 且不抛异常", () => {
    writeFileSync(STATE_A, "{not valid json", "utf8");
    resetToolVisibilityCache();
    for (const [label, , byName] of harnesses) {
      for (const name of ALL_TOOLS) {
        let result;
        assert.doesNotThrow(() => {
          result = byName.get(name).options.when();
        }, `${label} 损坏 JSON 时 ${name}.when() 不得抛异常`);
        assert.equal(result, true, `${label} 损坏 JSON 时 ${name}.when() 必须 fail-open 返回 true`);
      }
    }
  });

  await check("A8: 路径切换隔离：切换 DSH_NOVEL_WRITER_STATE（A→B）不调 resetToolVisibilityCache、不等待 300ms 即刻生效", async () => {
    process.env.DSH_NOVEL_WRITER_STATE = STATE_A;
    rmSync(STATE_A, { force: true });
    await writeSentenceState({ tools: { novel_plot: false } });
    // 预热 A 缓存并核对 A 状态
    for (const [label, , byName] of harnesses) {
      assert.equal(byName.get("novel_plot").options.when(), false, `${label} 文件 A 中 novel_plot 应为 false`);
      assert.equal(byName.get("novel_import").options.when(), true, `${label} 文件 A 中 novel_import 应为 true`);
    }

    // 写入文件 B（开 novel_plot，关 novel_import）
    writeFileSync(STATE_B, JSON.stringify({ tools: { novel_plot: true, novel_import: false } }), "utf8");
    // 切换环境变量到文件 B，刻意不调用 resetToolVisibilityCache()、不等待 300ms
    process.env.DSH_NOVEL_WRITER_STATE = STATE_B;

    for (const [label, , byName] of harnesses) {
      assert.equal(byName.get("novel_plot").options.when(), true, `${label} 切到文件 B 后 novel_plot 应即刻为 true`);
      assert.equal(byName.get("novel_import").options.when(), false, `${label} 切到文件 B 后 novel_import 应即刻为 false`);
      for (const name of ALL_TOOLS) {
        if (name !== "novel_import") {
          assert.equal(byName.get(name).options.when(), true, `${label} 文件 B 中 ${name} 应为 true`);
        }
      }
    }
  });

  await check("A9: 系统提示词防悬空：有关闭工具且非 off 档时追加固定提示；全开或 off 档零注入", async () => {
    const section = promptSections.find((s) => s.name === "novel-writing");
    assert.ok(section && typeof section.text === "function", "必须注册 novel-writing 动态 systemPrompt section");

    process.env.DSH_NOVEL_WRITER_STATE = STATE_A;
    rmSync(STATE_A, { force: true });

    // ① 全开时与 promptTextFor(...) 逐字一致（不附带任何关闭提示）
    await writeSentenceState({ enabled: true, systemPromptMode: "brief", promptScene: "general", leanWorkflow: false, tools: {} });
    assert.equal(section.text(), promptTextFor("brief", "general", false), "全开 brief 档不应注入额外提示");
    await writeSentenceState({ systemPromptMode: "full", promptScene: "writing", leanWorkflow: false });
    assert.equal(section.text(), promptTextFor("full", "writing", false), "全开 full+writing 档不应注入额外提示");
    await writeSentenceState({ leanWorkflow: true });
    assert.equal(section.text(), promptTextFor("full", "writing", true), "全开 leanWorkflow 不应注入额外提示");

    // ② 关掉任意非豁免工具后（brief / full / lean）均追加防悬空固定提示
    await writeSentenceState({ systemPromptMode: "brief", leanWorkflow: false, tools: { novel_chapter_brief: false } });
    const briefClosed = section.text();
    assert.ok(briefClosed.startsWith(promptTextFor("brief", "general", false)), "关闭工具后仍保留原 brief 文本");
    assert.ok(briefClosed.includes("未提供的工具不要调用") && briefClosed.includes("novel_sentence_config"), "brief 档应追加防悬空提示：" + briefClosed);

    await writeSentenceState({ systemPromptMode: "full", promptScene: "writing", leanWorkflow: false });
    const writingClosed = section.text();
    assert.ok(writingClosed.startsWith(promptTextFor("full", "writing", false)));
    assert.ok(writingClosed.includes("未提供的工具不要调用") && writingClosed.includes("novel_sentence_config"));

    await writeSentenceState({ leanWorkflow: true });
    const leanClosed = section.text();
    assert.ok(leanClosed.startsWith(promptTextFor("full", "writing", true)));
    assert.ok(leanClosed.includes("未提供的工具不要调用"));

    // ③ off 档：即使有关闭工具也绝不能复活空 section
    await writeSentenceState({ systemPromptMode: "off", leanWorkflow: false });
    assert.equal(section.text(), "", "off 档即使关闭了工具也必须返回空串");

    // ④ enabled=false（仅总开关关闭，tools 全开）或磁盘手写 novel_sentence_config:false 均不误触发
    await writeSentenceState({ enabled: false, systemPromptMode: "brief", promptScene: "general", leanWorkflow: false, tools: { novel_chapter_brief: true } });
    assert.equal(section.text(), promptTextFor("brief", "general", false), "仅总开关关闭不应触发工具关闭提示");

    writeFileSync(STATE_A, JSON.stringify({ systemPromptMode: "brief", tools: { novel_sentence_config: false } }), "utf8");
    assert.equal(section.text(), promptTextFor("brief", "general", false), "仅手写防死锁工具 novel_sentence_config:false 不应触发关闭提示");
  });

  // =========================================================================
  // Group B: MCP stdio 集成测试
  // =========================================================================
  group("Group B · MCP stdio 动态清单与预设过滤");

  const stateMcp1 = join(TMP_DIR, "mcp-b1", "state.json");
  mkdirSync(dirname(stateMcp1), { recursive: true });
  writeFileSync(stateMcp1, JSON.stringify({
    tools: {
      novel_plot: false,
      novel_import: false,
      novel_delete_book: false,
      novel_sentence_config: false
    }
  }), "utf8");

  const s1 = startServer({ stateFile: stateMcp1 });
  try {
    const init1 = await s1.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    assert.equal(init1.result?.protocolVersion, "2025-11-25");
    s1.notify("notifications/initialized");

    await check("B1: 启动前禁用 3 工具并手写 novel_sentence_config:false → tools/list 返回 19 工具且 stdout 纯净", async () => {
      const list1 = await s1.request("tools/list");
      const names1 = (list1.result?.tools ?? []).map((t) => t.name);
      assert.equal(names1.length, 19, `应返回 19 个工具，实测 ${names1.length}`);
      assert.equal(names1.includes("novel_plot"), false);
      assert.equal(names1.includes("novel_import"), false);
      assert.equal(names1.includes("novel_delete_book"), false);
      assert.equal(names1.includes("novel_sentence_config"), true, "novel_sentence_config 必须防死锁保持可见");
      assert.equal(s1.badLines.length, 0, `stdout 不得有非 JSON 行：${s1.badLines.join(" | ")}`);
      assert.equal(s1.stray.length, 0, `不得有未请求的游离通知帧：${JSON.stringify(s1.stray)}`);
    });

    await check("B2: 同会话 novel_sentence_config set 重开 novel_plot → 紧接着 tools/list 立即返回 20 个工具", async () => {
      const setRes = await s1.request("tools/call", {
        name: "novel_sentence_config",
        arguments: { action: "set", tools: { novel_plot: true } }
      });
      assert.equal(setRes.error, void 0, `set 不得返回协议错：${JSON.stringify(setRes.error)}`);
      assert.notEqual(setRes.result?.isError, true, `set 不得失败：${toolText(setRes)}`);

      const list2 = await s1.request("tools/list");
      const names2 = (list2.result?.tools ?? []).map((t) => t.name);
      assert.equal(names2.length, 20, `重开 novel_plot 后应立即返回 20 个工具，实测 ${names2.length}`);
      assert.equal(names2.includes("novel_plot"), true, "tools/list 必须立即包含重开的 novel_plot");
      assert.equal(names2.includes("novel_import"), false);
      assert.equal(names2.includes("novel_delete_book"), false);
      assert.equal(names2.includes("novel_sentence_config"), true);
      assert.equal(s1.badLines.length, 0);
      assert.equal(s1.stray.length, 0);
    });

    await check("B3: 直接调用被 state.json 禁用的 novel_import → 返回清晰 isError:true 文案（非协议错）", async () => {
      const impRes = await s1.request("tools/call", {
        name: "novel_import",
        arguments: { src: join(LIB_ROOT, "novels", "测试书") }
      });
      assert.equal(impRes.error, void 0, "禁用工具应走工具执行错误 isError:true 而非协议错");
      assert.equal(impRes.result?.isError, true, "被禁用的 novel_import 必须返回 isError: true");
      const text = toolText(impRes);
      assert.ok(text.includes("novel_import"), `错误文案应点名 novel_import：${text}`);
      assert.ok(text.includes("关闭"), `错误文案应说明已关闭：${text}`);
      assert.equal(s1.badLines.length, 0);
      assert.equal(s1.stray.length, 0);
    });
  } finally {
    const exit1 = await s1.stop();
    await check("B1-B3 会话正常关闭 exit=0 且 stdout 全程无非 JSON / 游离帧", () => {
      assert.equal(exit1.code, 0, `s1 应以 exit 0 退出，实际 ${JSON.stringify(exit1)}，stderr=${s1.stderrText()}`);
      assert.equal(s1.badLines.length, 0);
      assert.equal(s1.stray.length, 0);
    });
  }

  await check("B4: --preset writing → tools/list 精确匹配 MCP_TOOL_PRESETS.writing；调用预设外 novel_delete_book 返回 isError:true", async () => {
    const stateB4 = join(TMP_DIR, "mcp-b4", "state.json");
    mkdirSync(dirname(stateB4), { recursive: true });
    const s4 = startServer({ args: ["--preset", "writing"], stateFile: stateB4 });
    try {
      await s4.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
      s4.notify("notifications/initialized");
      const listRes = await s4.request("tools/list");
      const names = (listRes.result?.tools ?? []).map((t) => t.name);
      assert.equal(names.length, MCP_TOOL_PRESETS.writing.length);
      assert.deepEqual(sorted(names), sorted(MCP_TOOL_PRESETS.writing));

      const outRes = await s4.request("tools/call", {
        name: "novel_delete_book",
        arguments: { action: "list" }
      });
      assert.equal(outRes.error, void 0, "预设外调用应返回 isError:true 结果而非协议错");
      assert.equal(outRes.result?.isError, true);
      const text = toolText(outRes);
      assert.ok(text.includes("--preset writing"), `预设外拒接文案应提及 --preset writing：${text}`);
      assert.ok(text.includes("novel_delete_book"), `预设外拒接文案应提及工具名：${text}`);
    } finally {
      const exit4 = await s4.stop();
      assert.equal(exit4.code, 0, `s4 exit=${exit4.code}`);
      assert.equal(s4.badLines.length, 0);
      assert.equal(s4.stray.length, 0);
    }
  });

  await check("B5: --preset writing 且 state.json 关闭 novel_lexicon → tools/list 返回预设与开关的交集", async () => {
    const stateB5 = join(TMP_DIR, "mcp-b5", "state.json");
    mkdirSync(dirname(stateB5), { recursive: true });
    writeFileSync(stateB5, JSON.stringify({ tools: { novel_lexicon: false } }), "utf8");
    const s5 = startServer({ args: ["--preset", "writing"], stateFile: stateB5 });
    try {
      await s5.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
      s5.notify("notifications/initialized");
      const listRes = await s5.request("tools/list");
      const names = (listRes.result?.tools ?? []).map((t) => t.name);
      const expected = MCP_TOOL_PRESETS.writing.filter((n) => n !== "novel_lexicon");
      assert.equal(names.includes("novel_lexicon"), false, "交集清单不得包含被 state.json 禁用的 novel_lexicon");
      assert.equal(names.length, expected.length);
      assert.deepEqual(sorted(names), sorted(expected));
    } finally {
      const exit5 = await s5.stop();
      assert.equal(exit5.code, 0, `s5 exit=${exit5.code}`);
      assert.equal(s5.badLines.length, 0);
      assert.equal(s5.stray.length, 0);
    }
  });

  await check("B6: 未知预设 --preset nope → stderr 出现告警且回退 all（22 工具），关闭 stdin 后 exit 0", async () => {
    const stateB6 = join(TMP_DIR, "mcp-b6", "state.json");
    mkdirSync(dirname(stateB6), { recursive: true });
    const s6 = startServer({ args: ["--preset", "nope"], stateFile: stateB6 });
    let exit6;
    try {
      await s6.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
      s6.notify("notifications/initialized");
      const listRes = await s6.request("tools/list");
      const names = (listRes.result?.tools ?? []).map((t) => t.name);
      assert.equal(names.length, 22);
      assert.deepEqual(sorted(names), sorted(ALL_TOOLS));
    } finally {
      exit6 = await s6.stop();
    }
    assert.equal(exit6.code, 0, `未知预设回退 all 后关 stdin 应 exit 0，实际 ${JSON.stringify(exit6)}`);
    const errText = s6.stderrText();
    assert.ok(errText.includes("警告") && errText.includes("nope") && errText.includes("all"), `stderr 应出现未知预设告警与回退 all 说明：${errText}`);
    assert.equal(s6.badLines.length, 0);
    assert.equal(s6.stray.length, 0);
  });

  await check("B7: 环境变量 DSH_NOVEL_WRITER_PRESET=revising → tools/list 精确匹配 MCP_TOOL_PRESETS.revising", async () => {
    const stateB7 = join(TMP_DIR, "mcp-b7", "state.json");
    mkdirSync(dirname(stateB7), { recursive: true });
    const s7 = startServer({ env: { DSH_NOVEL_WRITER_PRESET: "revising" }, stateFile: stateB7 });
    try {
      await s7.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
      s7.notify("notifications/initialized");
      const listRes = await s7.request("tools/list");
      const names = (listRes.result?.tools ?? []).map((t) => t.name);
      assert.equal(names.length, MCP_TOOL_PRESETS.revising.length);
      assert.deepEqual(sorted(names), sorted(MCP_TOOL_PRESETS.revising));
    } finally {
      const exit7 = await s7.stop();
      assert.equal(exit7.code, 0, `s7 exit=${exit7.code}`);
      assert.equal(s7.badLines.length, 0);
      assert.equal(s7.stray.length, 0);
    }
  });

  // 隔离守卫：核验用户真实 ~/.dsh 目录未被写入
  group("隔离守卫");
  await check("用户真实 ~/.dsh/dsh-novel-writer 目录全程未受任何读写污染", () => {
    const realAfter = { state: digestFile(REAL_STATE), logs: digestDir(REAL_LOG_DIR) };
    assert.deepEqual(realAfter, realBefore, "测试全过程绝不能改动用户真实 ~/.dsh 配置与日志");
  });
} finally {
  cleanup();
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  process.exitCode = 1;
  console.log("TOOL VISIBILITY TESTS FAILED");
} else {
  console.log("ALL TOOL VISIBILITY TESTS PASSED");
}
