// v4.0.0 MCP 测试：stdio JSON-RPC 协议握手、16 工具清单、真实工具调用、错误隔离、stdout 纯净性、root 优先级
// 用法：node test/mcp-test.mjs（独立于其他四套测试，不依赖任何外部服务）

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..");
const SERVER = join(PLUGIN_DIR, "mcp", "server.mjs");
const PKG = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"));

// 期望的 16 个工具（硬编码=强回归断言：少注册/改名即失败，与 lib/core.js ALL_TOOLS 对齐）
const EXPECTED_TOOLS = [
  "novel_books", "novel_chapters", "novel_read", "novel_keywords", "novel_new_chapter",
  "novel_import", "novel_sentence_analysis", "novel_sentence_config", "novel_style_check", "novel_plot",
  "novel_settings", "novel_summary", "novel_continuity_check", "novel_semantic_search", "novel_style_report",
  "novel_outline"
];

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  const suffix = detail ? "  [" + detail + "]" : "";
  if (cond) {
    pass += 1;
    console.log("  ✓ " + name + suffix);
  } else {
    fail += 1;
    console.log("  ✗ " + name + suffix);
  }
};

// ---------------------------------------------------------------------------
// 临时书库：一本 2 章的书 + 状态文件隔离（不碰用户 ~/.dsh）
// ---------------------------------------------------------------------------
const testRoot = join(tmpdir(), "dsh-novel-writer-mcp-" + process.pid + "-" + Date.now().toString(36));
const stateFile = join(testRoot, "state-test.json");
const BOOK = "测试书";
mkdirSync(join(testRoot, "novels", BOOK), { recursive: true });
writeFileSync(join(testRoot, "novels", BOOK, "第01章.md"), "雨下了一整夜。她站在窗前，心里想着明天的事。\n“你真的要走吗？”他低声问。\n", "utf8");
writeFileSync(join(testRoot, "novels", BOOK, "第02章.md"), "日子照旧。她习惯了独自吃饭。窗外风急，雨打芭蕉。\n", "utf8");
const emptyRoot = join(testRoot, "empty-root");
mkdirSync(emptyRoot, { recursive: true });
process.on("exit", () => {
  try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

// ---------------------------------------------------------------------------
// MCP 客户端桩：spawn 服务器，按行收发 JSON-RPC
// ---------------------------------------------------------------------------
function startServer({ args = [], env = {}, cwd = PLUGIN_DIR } = {}) {
  const child = spawn(process.execPath, [SERVER, ...args], {
    cwd,
    env: { ...process.env, DSH_NOVEL_WRITER_STATE: stateFile, ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = new Map();
  const stray = []; // 有 id 但无人认领 / 通知类响应（应为空）
  const badLines = []; // stdout 上非 JSON 的行（协议污染）
  const stderrChunks = [];
  let nextId = 1;
  let exited = null;

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      badLines.push(line);
      return;
    }
    if (message && message.id !== undefined && message.id !== null && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      entry.resolve(message);
      return;
    }
    stray.push(message);
  });
  child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));
  child.on("exit", (code, signal) => { exited = { code, signal }; });

  const request = (method, params) => new Promise((resolve, reject) => {
    if (exited !== null) {
      reject(new Error("服务器已退出，无法发送：" + method));
      return;
    }
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("响应超时：" + method));
      }
    }, 60000);
    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      }
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

  const rawLine = (line) => child.stdin.write(line + "\n");

  const stop = () => new Promise((resolve) => {
    if (exited !== null) {
      resolve(exited);
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.stdin.end();
    setTimeout(() => {
      if (exited === null) child.kill("SIGKILL");
    }, 10000).unref();
  });

  return {
    child, request, notify, rawLine, stop, stray, badLines,
    stderrText: () => stderrChunks.join(""),
    get exited() { return exited; }
  };
}

/** 取 content[0].text；输出可能是插件 render 字符串，也可能是回退 JSON。 */
function toolText(response) {
  return String(response?.result?.content?.[0]?.text ?? "");
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ① 命令行 --root
// ---------------------------------------------------------------------------
console.log("=== MCP 服务器：--root 优先 ===");
const a = startServer({ args: ["--root", testRoot] });

const init = await a.request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" }
});
ok("initialize 返回 result", init.result !== undefined, JSON.stringify(init.error ?? null));
ok("protocolVersion = 2024-11-05", init.result?.protocolVersion === "2024-11-05", String(init.result?.protocolVersion));
ok("capabilities.tools 存在", Boolean(init.result?.capabilities?.tools), JSON.stringify(init.result?.capabilities ?? null));
ok("serverInfo.name = dsh-novel-writer", init.result?.serverInfo?.name === "dsh-novel-writer", String(init.result?.serverInfo?.name));
ok("serverInfo.version = package.json version（" + PKG.version + "）", init.result?.serverInfo?.version === PKG.version, String(init.result?.serverInfo?.version));

// 通知类消息不得产生任何响应
a.notify("notifications/initialized");
const ping1 = await a.request("ping");
ok("ping 返回空对象 {}", ping1.result !== undefined && Object.keys(ping1.result).length === 0, JSON.stringify(ping1.result ?? null));
ok("notifications/initialized 无响应（无游离消息）", a.stray.length === 0, JSON.stringify(a.stray));

const list = await a.request("tools/list");
const tools = Array.isArray(list.result?.tools) ? list.result.tools : [];
ok("tools/list 返回 16 个工具", tools.length === 16, "n=" + tools.length);
const names = tools.map((tool) => tool.name).sort();
ok("工具名与 ALL_TOOLS 完全一致", JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()), names.join(","));
const schemaOk = tools.every((tool) => tool
  && typeof tool.name === "string"
  && typeof tool.description === "string" && tool.description.length > 0
  && tool.inputSchema && typeof tool.inputSchema === "object"
  && tool.inputSchema.type === "object"
  && tool.inputSchema.properties && typeof tool.inputSchema.properties === "object");
ok("每个工具含 name/description/inputSchema(object)", schemaOk);
const booksSchema = tools.find((tool) => tool.name === "novel_books")?.inputSchema;
ok("inputSchema 原样透传 d.parameters（novel_books.root 为 string）", booksSchema?.properties?.root?.type === "string", JSON.stringify(booksSchema?.properties?.root ?? null));
ok("inputSchema 保留 required/additionalProperties", booksSchema?.additionalProperties === false, JSON.stringify(booksSchema?.additionalProperties ?? null));

// tools/call：不传 root，由服务器注入 --root
const call = await a.request("tools/call", { name: "novel_books", arguments: {} });
ok("tools/call 成功（isError 未置位）", call.result !== undefined && call.result.isError !== true, JSON.stringify(call.error ?? call.result ?? null));
const content = call.result?.content;
ok("content = [{type:'text',text}]", Array.isArray(content) && content.length === 1 && content[0].type === "text" && typeof content[0].text === "string" && content[0].text.length > 0, JSON.stringify(content?.[0]?.type ?? null));
const booksText = toolText(call);
const booksValue = parseJsonOrNull(booksText);
if (booksValue !== null) {
  ok("注入的 root = --root 路径", booksValue.root === testRoot, String(booksValue.root));
  const book = (booksValue.books ?? []).find((item) => item.name === BOOK);
  ok("识别到 2 章的书", Boolean(book) && book.chapters === 2, JSON.stringify(booksValue.books ?? null));
} else {
  ok("文本输出含书名与章节数", booksText.includes(BOOK) && booksText.includes("2"), booksText.slice(0, 120));
  ok("文本输出含书库根目录", booksText.includes(testRoot), booksText.slice(0, 120));
}

// 调用方显式传 root 时不得被服务器默认值覆盖
const explicitCall = await a.request("tools/call", { name: "novel_books", arguments: { root: emptyRoot } });
const explicitValue = parseJsonOrNull(toolText(explicitCall));
ok("调用方显式 root 优先于服务器 --root", explicitValue !== null
  ? explicitValue.root === emptyRoot && explicitValue.books.length === 0
  : toolText(explicitCall).includes("empty-root"), explicitValue !== null ? JSON.stringify(explicitValue) : toolText(explicitCall).slice(0, 120));

const readCall = await a.request("tools/call", { name: "novel_read", arguments: { book: BOOK, chapter: "1" } });
ok("novel_read 成功", readCall.result !== undefined && readCall.result.isError !== true, JSON.stringify(readCall.result ?? null).slice(0, 160));
ok("novel_read 正文含第01章内容", toolText(readCall).includes("她站在窗前"), toolText(readCall).slice(0, 120));

const cfgCall = await a.request("tools/call", { name: "novel_sentence_config", arguments: { action: "get" } });
ok("novel_sentence_config 可用（工具链完整）", cfgCall.result?.isError !== true && toolText(cfgCall).includes("enabled"), toolText(cfgCall).slice(0, 120));

const analysisCall = await a.request("tools/call", { name: "novel_sentence_analysis", arguments: { book: BOOK, brief: true } });
ok("novel_sentence_analysis 全书分析成功", analysisCall.result?.isError !== true && toolText(analysisCall).includes("totalChars"), toolText(analysisCall).slice(0, 100).replace(/\n/g, " "));
const reportCall = await a.request("tools/call", { name: "novel_style_report", arguments: { book: BOOK, brief: true } });
ok("novel_style_report 生成六维基线", reportCall.result?.isError !== true && toolText(reportCall).includes("baseline"), toolText(reportCall).slice(0, 100).replace(/\n/g, " "));

// 工具抛错 → isError，且进程存活
const errCall = await a.request("tools/call", { name: "novel_chapters", arguments: { book: "不存在的书" } });
ok("工具抛错返回 isError:true", errCall.result?.isError === true, JSON.stringify(errCall.result ?? null).slice(0, 160));
ok("错误文本以「错误：」开头", toolText(errCall).startsWith("错误："), toolText(errCall).slice(0, 120));
const pingAfterError = await a.request("ping");
ok("工具抛错后进程仍存活（ping 正常）", pingAfterError.result !== undefined && Object.keys(pingAfterError.result).length === 0, JSON.stringify(pingAfterError.result ?? null));

// 未知工具 / 未知方法 / 非法 JSON 行
const unknownTool = await a.request("tools/call", { name: "novel_nope", arguments: {} });
ok("未知工具返回 isError（不中断会话）", unknownTool.result?.isError === true && toolText(unknownTool).includes("未知工具"), toolText(unknownTool).slice(0, 120));
const unknownMethod = await a.request("foo/bar");
ok("未知方法返回 -32601", unknownMethod.error?.code === -32601, JSON.stringify(unknownMethod.error ?? null));

a.rawLine("{ 这不是 JSON");
a.rawLine("[1,2,");
a.rawLine("");
const pingAfterJunk = await a.request("ping");
ok("非法 JSON 行后仍响应 ping", pingAfterJunk.result !== undefined && Object.keys(pingAfterJunk.result).length === 0, JSON.stringify(pingAfterJunk.result ?? null));
ok("stdout 无非 JSON 行（协议通道纯净）", a.badLines.length === 0, a.badLines.join(" | ").slice(0, 200));
ok("日志写 stderr（含注册信息）", a.stderrText().includes("已注册 16 个工具"), a.stderrText().split("\n")[0]?.slice(0, 120));

const exitA = await a.stop();
ok("关闭 stdin 后 exit=0", exitA.code === 0, JSON.stringify(exitA));

// ---------------------------------------------------------------------------
// ② 环境变量 DSH_NOVEL_WRITER_ROOT（cwd 不含书库）
// ---------------------------------------------------------------------------
console.log("\n=== MCP 服务器：环境变量 DSH_NOVEL_WRITER_ROOT ===");
const b = startServer({ args: [], env: { DSH_NOVEL_WRITER_ROOT: testRoot }, cwd: tmpdir() });
await b.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
const bCall = await b.request("tools/call", { name: "novel_books", arguments: {} });
const bValue = parseJsonOrNull(toolText(bCall));
ok("env 指定书库被识别", bValue !== null ? bValue.root === testRoot : toolText(bCall).includes(testRoot), bValue !== null ? String(bValue.root) : toolText(bCall).slice(0, 120));
ok("env 服务器 exit=0", (await b.stop()).code === 0);

// ---------------------------------------------------------------------------
// ③ 优先级：--root（含 --root= 形式）> 环境变量
// ---------------------------------------------------------------------------
console.log("\n=== MCP 服务器：--root= 形式且优先于环境变量 ===");
const c = startServer({ args: ["--root=" + testRoot], env: { DSH_NOVEL_WRITER_ROOT: emptyRoot }, cwd: emptyRoot });
await c.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
const cCall = await c.request("tools/call", { name: "novel_books", arguments: {} });
const cValue = parseJsonOrNull(toolText(cCall));
ok("--root= 生效且覆盖环境变量", cValue !== null ? cValue.root === testRoot : toolText(cCall).includes(testRoot), cValue !== null ? String(cValue.root) : toolText(cCall).slice(0, 120));
ok("--root= 服务器 exit=0", (await c.stop()).code === 0);

// ---------------------------------------------------------------------------
console.log("\n通过 " + pass + " 项，失败 " + fail + " 项");
if (fail > 0) {
  process.exitCode = 1;
  console.log("MCP TESTS FAILED");
} else {
  console.log("ALL MCP TESTS PASSED");
}
