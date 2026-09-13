// v4.0.0 MCP 测试：stdio JSON-RPC 协议握手、16 工具清单、真实工具调用、错误隔离、stdout 纯净性、root 优先级
// v4.3.0 补：render 快速路径（插件 render 返回 [{type:"text",text}] 时 MCP 收到精修文本而非整包 JSON）、
//            -32700 Parse error 帧、带 id 的 notifications/* 回 -32600、取消通知、batch 扩展、jsonrpc 字段校验
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
// v4.3.0：书库根之外的目录（用于验证 novel_import src 越界拦截，不需要真的可导入）
const outsideRoot = join(tmpdir(), "dsh-novel-writer-mcp-outside-" + process.pid + "-" + Date.now().toString(36));
mkdirSync(outsideRoot, { recursive: true });
process.on("exit", () => {
  try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { rmSync(outsideRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
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
  const badLines = []; // stdout 上非 JSON 的行（协议污染）
  const stray = []; // 有 id 但无人认领 / 通知类响应（应为空）
  const frames = []; // 原始解析帧（含数组=批量响应；stray 的判定口径不变）
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
    frames.push(message);
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

  // v4.3.0：需要知道 id 才能给"带 id 的请求/取消通知"发后续帧（request() 的 id 不对外暴露）
  const rawRequest = (obj) => {
    const id = nextId;
    nextId += 1;
    const frame = { jsonrpc: "2.0", id, ...obj };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("响应超时：" + frame.method));
        }
      }, 60000);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
    child.stdin.write(JSON.stringify(frame) + "\n");
    return { id, promise };
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
    child, request, notify, rawRequest, rawLine, stop, stray, badLines, frames,
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
ok("initialize 返回结果帧含 jsonrpc:\"2.0\" 与回显 id", init.jsonrpc === "2.0" && init.id === 1, JSON.stringify({ jsonrpc: init.jsonrpc, id: init.id }));
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
// v4.3.0：render 快速路径必须真的生效——插件 16 个 render 都返回 [{type:"text",text}]，
// 旧实现只认字符串 → 这里收到的会是整包 JSON（以 "{" 开头），精修文本被丢弃。
ok("输出走插件 render 精修文本（不是 JSON 兜底）",
  booksText.startsWith("<path>") && booksText.includes("<type>novel-library</type>") && !booksText.startsWith("{"),
  booksText.slice(0, 100).replace(/\n/g, " "));

// v4.3.0：novel_import 的 src 越界必须被拦（--allow-external-src 未开）
const importBlocked = await a.request("tools/call", { name: "novel_import", arguments: { src: outsideRoot, mode: "scan" } });
ok("novel_import src 越界被拒（默认限根内）",
  importBlocked.result?.isError === true && toolText(importBlocked).includes("src 必须位于书库根"),
  toolText(importBlocked).slice(0, 140));
ok("越界拦截提示 --allow-external-src 开关", toolText(importBlocked).includes("--allow-external-src"), toolText(importBlocked).slice(0, 140));

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
// v4.3.0：render 快速路径生效后这里收到的是插件精修文本（旧断言查 "enabled" 只在 JSON 兜底输出里出现）
ok("novel_sentence_config 可用（工具链完整）",
  cfgCall.result?.isError !== true && toolText(cfgCall).includes("<type>novel-sentence-config</type>") && toolText(cfgCall).includes("写作助手功能"),
  toolText(cfgCall).slice(0, 120).replace(/\n/g, " "));

const analysisCall = await a.request("tools/call", { name: "novel_sentence_analysis", arguments: { book: BOOK, brief: true } });
// v4.3.0：同上——精修文本里没有 JSON 字段名 totalChars。断言只依赖 render 格式标记与 brief 标题，
// 不依赖插件 brief 文案的具体措辞（lib/ 正被并行修改，措辞属实现细节）
ok("novel_sentence_analysis 全书分析成功",
  analysisCall.result?.isError !== true && toolText(analysisCall).includes("<type>novel-sentence-analysis</type>") && toolText(analysisCall).includes("【句式分析·精简】"),
  toolText(analysisCall).slice(0, 100).replace(/\n/g, " "));
const reportCall = await a.request("tools/call", { name: "novel_style_report", arguments: { book: BOOK, brief: true } });
// v4.3.0：brief 输出的精修文本标题为「【风格画像·精简】」，旧断言查 JSON 字段名 baseline
ok("novel_style_report 生成六维基线",
  reportCall.result?.isError !== true && toolText(reportCall).includes("【风格画像·精简】《" + BOOK + "》"),
  toolText(reportCall).slice(0, 100).replace(/\n/g, " "));

// 工具抛错 → isError，且进程存活
const errCall = await a.request("tools/call", { name: "novel_chapters", arguments: { book: "不存在的书" } });
ok("工具抛错返回 isError:true", errCall.result?.isError === true, JSON.stringify(errCall.result ?? null).slice(0, 160));
ok("错误文本以「错误：」开头", toolText(errCall).startsWith("错误："), toolText(errCall).slice(0, 120));
const pingAfterError = await a.request("ping");
ok("工具抛错后进程仍存活（ping 正常）", pingAfterError.result !== undefined && Object.keys(pingAfterError.result).length === 0, JSON.stringify(pingAfterError.result ?? null));

// 未知工具 / 未知方法 / 非法 JSON 行
const unknownTool = await a.request("tools/call", { name: "novel_nope", arguments: {} });
// v4.3.0：改为符合规范的协议错误。MCP《Tools → Error Handling》把 "Unknown tools" 明列为 Protocol Error，
// 规范示例即 {"code":-32602,"message":"Unknown tool: invalid_tool_name"}
// （specification/2025-11-25/server/tools#error-handling）；可读提示移到 error.data.hint。
ok("未知工具返回 -32602 协议错误（符合 MCP Tools 规范）",
  unknownTool.error?.code === -32602 && /^Unknown tool: novel_nope$/.test(String(unknownTool.error?.message ?? "")),
  JSON.stringify(unknownTool.error ?? null));
ok("未知工具不再是 isError 结果（不再混入\"工具执行错误\"分类）",
  unknownTool.result === undefined && unknownTool.jsonrpc === "2.0", JSON.stringify(unknownTool.result ?? null));
ok("未知工具的 error.data.hint 给出可用工具数",
  unknownTool.error?.data?.availableToolCount === 16 && String(unknownTool.error?.data?.hint ?? "").includes("tools/list"),
  JSON.stringify(unknownTool.error?.data ?? null));
const unknownMethod = await a.request("foo/bar");
ok("未知方法返回 -32601", unknownMethod.error?.code === -32601 && unknownMethod.jsonrpc === "2.0", JSON.stringify(unknownMethod.error ?? null));
// v4.3.0：带 id 的 notifications/* 是请求（不是通知），必须结算——旧实现无条件 return null → 永不回应
const cancelledAsRequest = await a.rawRequest({ method: "notifications/cancelled", params: { requestId: 999999 } });
const cancelledResp = await cancelledAsRequest.promise;
ok("带 id 的 notifications/cancelled 返回 -32600（不再静默丢弃）",
  cancelledResp.error?.code === -32600 && cancelledResp.id === cancelledAsRequest.id && cancelledResp.jsonrpc === "2.0",
  JSON.stringify(cancelledResp));
// 无 id 的同名通知仍然静默（不产生任何响应帧）
a.notify("notifications/cancelled", { requestId: 888888 });
const pingAfterCancel = await a.request("ping");
ok("无 id 的 cancelled 通知仍静默（无游离帧）", pingAfterCancel.result !== undefined && a.stray.length === 0, JSON.stringify(a.stray));

a.rawLine("{ 这不是 JSON");
a.rawLine("[1,2,");
a.rawLine("");
const pingAfterJunk = await a.request("ping");
ok("非法 JSON 行后仍响应 ping", pingAfterJunk.result !== undefined && Object.keys(pingAfterJunk.result).length === 0, JSON.stringify(pingAfterJunk.result ?? null));
// v4.3.0：JSON-RPC 2.0 要求 Parse error（-32700，id=null）；两行非法 JSON → 两个错误帧（无人认领 → stray）
const parseErrors = a.stray.filter((message) => message && message.error && message.error.code === -32700);
ok("非法 JSON 行回 -32700 Parse error（id=null）",
  parseErrors.length === 2 && parseErrors.every((message) => message.id === null && message.jsonrpc === "2.0"),
  JSON.stringify(a.stray.map((m) => m && m.error && m.error.code)));
// v4.3.0：此刻 stray 只应含这两个 -32700 —— 旧版无此断言，任何新增的游离响应都会静默通过
ok("stray 仅含预期的 -32700（无其它游离响应）",
  a.stray.every((message) => message && message.error && message.error.code === -32700),
  JSON.stringify(a.stray.map((m) => m && (m.error ? m.error.code : m.id))));
ok("stdout 无非 JSON 行（协议通道纯净）", a.badLines.length === 0, a.badLines.join(" | ").slice(0, 200));
ok("日志写 stderr（含注册信息）", a.stderrText().includes("已注册 16 个工具"), a.stderrText().split("\n")[0]?.slice(0, 120));
// v4.3.0：stderr 不得回显非法行正文（旧实现打前 200 字符；正文可能是用户稿件片段）
ok("stderr 不回显非法行正文（只记长度）",
  a.stderrText().includes("非法 JSON 行") && !a.stderrText().includes("这不是 JSON"), a.stderrText().split("\n").filter((l) => l.includes("非法 JSON"))[0] ?? "(无)");

// v4.3.0：超长行（>4 MiB）必须整行丢弃并继续服务——旧实现用 readline，缓冲区无界增长
const hugeLine = '{"jsonrpc":"2.0","id":77001,"method":"ping","params":{"pad":"' + "x".repeat(4 * 1024 * 1024 + 1024) + '"}}';
a.rawLine(hugeLine);
const pingAfterHuge = await a.request("ping");
ok("超长行（>4MiB）被整行丢弃后仍响应 ping",
  pingAfterHuge.result !== undefined && Object.keys(pingAfterHuge.result).length === 0, JSON.stringify(pingAfterHuge.result ?? null));
ok("超长行丢弃写 stderr 且只记字节数（不回显内容）",
  a.stderrText().includes("已丢弃超长行") && !a.stderrText().includes("xxxx"), 
  a.stderrText().split("\n").filter((l) => l.includes("已丢弃超长行"))[0] ?? "(无)");
ok("超长行未污染 stdout（仍无非 JSON 行）", a.badLines.length === 0, a.badLines.join(" | ").slice(0, 120));

// ---------------------------------------------------------------------------
// ①-b v4.3.0：批量请求（JSON-RPC batching；MCP 2025-06-18 已移除，本服务器按声明的 2024-11-05 保留）
// ---------------------------------------------------------------------------
console.log("\n=== MCP 服务器：批量请求（非标准扩展）===");
const BATCH_ID_A = 9001;
const BATCH_ID_B = 9002;
const framesBefore = a.frames.length;
a.rawLine(JSON.stringify([
  { jsonrpc: "2.0", id: BATCH_ID_A, method: "ping" },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: BATCH_ID_B, method: "tools/call", params: { name: "novel_books", arguments: {} } }
]));
const pingAfterBatch = await a.request("ping"); // 串行保证：ping 的响应一定排在批量响应之后
ok("批量后连接仍可用", pingAfterBatch.result !== undefined, JSON.stringify(pingAfterBatch));
const batch = a.frames.slice(framesBefore).find((frame) => Array.isArray(frame));
ok("批量请求返回响应数组", Array.isArray(batch), JSON.stringify(a.frames.slice(framesBefore).map((f) => (Array.isArray(f) ? "batch" : f.id))));
ok("批量响应不含通知响应（3 请求 → 2 响应）", Array.isArray(batch) && batch.length === 2, "n=" + (Array.isArray(batch) ? batch.length : typeof batch));
ok("批量响应每条都含 jsonrpc:\"2.0\" 且 id 正确回显",
  Array.isArray(batch) && batch.every((message) => message.jsonrpc === "2.0")
  && batch[0].id === BATCH_ID_A && batch[1].id === BATCH_ID_B,
  JSON.stringify(Array.isArray(batch) ? batch.map((m) => ({ jsonrpc: m.jsonrpc, id: m.id })) : batch));
ok("批量内 tools/call 正常执行", batch[1].result?.isError !== true && String(batch[1].result?.content?.[0]?.text ?? "").includes("<type>novel-library</type>"),
  String(batch[1].result?.content?.[0]?.text ?? "").slice(0, 80).replace(/\n/g, " "));

// v4.3.0：全测收尾再断言一次"无游离响应"——旧版只在开头断言过一次，之后新增的游离帧不再被发现。
// 允许集只有两类：批量响应（整体数组，无顶层 id）+ 两行非法 JSON 触发的 -32700。
const expectedStray = (message) => Array.isArray(message)
  || (message && message.error && message.error.code === -32700);
ok("全测结束：无游离/无人认领的响应帧（仅批量数组 + 预期 -32700）",
  a.stray.every(expectedStray),
  JSON.stringify(a.stray.map((m) => (Array.isArray(m) ? "batch" : (m && m.error ? m.error.code : m && m.id)))));

const exitA = await a.stop();
ok("关闭 stdin 后 exit=0", exitA.code === 0, JSON.stringify(exitA));

// ---------------------------------------------------------------------------
// ①-c v4.3.0：协议版本协商 + batching 按**协商版本**拒绝
//   规范依据：客户端请求的版本若受支持，服务端 MUST 原样回
//   （specification/2025-11-25/basic/lifecycle#version-negotiation）；
//   JSON-RPC batching 自 MCP 2025-06-18 起被移除。
// ---------------------------------------------------------------------------
console.log("\n=== MCP 服务器：协议版本协商与 batching 版本门控 ===");
const d = startServer({ args: ["--root=" + testRoot], env: { DSH_NOVEL_WRITER_ROOT: emptyRoot }, cwd: emptyRoot });
const dInit = await d.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
ok("请求 2025-11-25 → 服务端原样回该版本", dInit.result?.protocolVersion === "2025-11-25", String(dInit.result?.protocolVersion));
const dFramesBefore = d.frames.length;
d.rawLine(JSON.stringify([{ jsonrpc: "2.0", id: 9101, method: "ping" }]));
await d.request("ping"); // 串行保证：批量请求的回应一定排在这次 ping 之前
const dBatchFrames = d.frames.slice(dFramesBefore);
const dBatchErr = dBatchFrames.find((frame) => frame && frame.error !== undefined);
ok("2025-11-25 会话下批量请求被拒 -32600（不再回响应数组）",
  dBatchErr !== undefined && dBatchErr.error?.code === -32600 && !dBatchFrames.some((frame) => Array.isArray(frame)),
  JSON.stringify(dBatchFrames.map((frame) => (Array.isArray(frame) ? "batch" : frame.error ? frame.error.code : frame.id))));
const dUnknown = await d.request("tools/call", { name: "novel_nope", arguments: {} });
ok("2025-11-25 会话下未知工具同样回 -32602", dUnknown.error?.code === -32602, JSON.stringify(dUnknown.error ?? null));
ok("协商服务器 exit=0", (await d.stop()).code === 0);

// 反向：请求一个不受支持的版本 → 服务端 MUST 回自己支持的最新版本
const e = startServer({ args: ["--root=" + testRoot], env: { DSH_NOVEL_WRITER_ROOT: emptyRoot }, cwd: emptyRoot });
const eInit = await e.request("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
ok("请求不受支持的版本 → 回服务端最新支持版本 2025-11-25",
  eInit.result?.protocolVersion === "2025-11-25", String(eInit.result?.protocolVersion));
ok("版本回退服务器 exit=0", (await e.stop()).code === 0);

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
// ④ v4.3.0：插件加载失败时的两种行为（用"假插件目录"复现，不碰真实 lib/）
//    ①默认：exit(1)，客户端只看得到管道关闭
//    ②--ignore-plugin-load-error：进程存活，initialize 正常应答、其余请求回 -32603
// ---------------------------------------------------------------------------
console.log("\n=== MCP 服务器：插件加载失败（默认 exit / --ignore-plugin-load-error）===");
const brokenPlugin = join(testRoot, "broken-plugin");
mkdirSync(join(brokenPlugin, "lib"), { recursive: true });
writeFileSync(join(brokenPlugin, "package.json"), JSON.stringify({ name: "broken-plugin", version: "0.0.0", type: "module" }), "utf8");
// 故意 import 一个不存在的模块 → apply 阶段必然失败
writeFileSync(join(brokenPlugin, "lib", "index.js"), 'import "./definitely-missing.js";\nexport async function apply() {}\n', "utf8");
const brokenServer = join(brokenPlugin, "mcp", "server.mjs");
mkdirSync(join(brokenPlugin, "mcp"), { recursive: true });
writeFileSync(brokenServer, readFileSync(SERVER, "utf8"), "utf8");

const runBroken = (extraArgs) => new Promise((resolve) => {
  const child = spawn(process.execPath, [brokenServer, "--root", testRoot, ...extraArgs], { stdio: ["pipe", "pipe", "pipe"] });
  const out = [];
  const err = [];
  let exited = null;
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => out.push(line));
  child.stderr.on("data", (chunk) => err.push(String(chunk)));
  child.on("exit", (code, signal) => {
    exited = { code, signal };
    if (!extraArgs.includes("--ignore-plugin-load-error")) resolve({ exited, out, err: err.join("") });
  });
  if (extraArgs.includes("--ignore-plugin-load-error")) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "novel_books", arguments: {} } }) + "\n");
    setTimeout(() => { child.kill("SIGKILL"); resolve({ exited, out, err: err.join("") }); }, 8000);
  }
});

const brokenDefault = await runBroken([]);
ok("插件加载失败：默认 exit=1（客户端只见管道关闭）", brokenDefault.exited.code === 1, JSON.stringify(brokenDefault.exited));
ok("插件加载失败：默认行为 stderr 有原因说明", brokenDefault.err.includes("插件加载失败"), brokenDefault.err.split("\n")[0]?.slice(0, 120));
ok("插件加载失败：默认行为提示 --ignore-plugin-load-error 逃生口", brokenDefault.err.includes("--ignore-plugin-load-error"), brokenDefault.err.split("\n")[0]?.slice(0, 160));

const brokenLenient = await runBroken(["--ignore-plugin-load-error"]);
const framesBroken = brokenLenient.out.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const initFrame = framesBroken.find((frame) => frame.id === 1);
const listFrame = framesBroken.find((frame) => frame.id === 2);
const callFrame = framesBroken.find((frame) => frame.id === 3);
ok("--ignore-plugin-load-error：initialize 仍被应答", initFrame?.result?.serverInfo?.name === "dsh-novel-writer", JSON.stringify(initFrame ?? null).slice(0, 140));
ok("--ignore-plugin-load-error：tools/list 回空清单", Array.isArray(listFrame?.result?.tools) && listFrame.result.tools.length === 0, JSON.stringify(listFrame ?? null).slice(0, 140));
ok("--ignore-plugin-load-error：tools/call 回 -32603 说明原因",
  callFrame?.error?.code === -32603 && String(callFrame.error.message).includes("服务器初始化失败"), JSON.stringify(callFrame ?? null).slice(0, 160));

// ---------------------------------------------------------------------------
console.log("\n通过 " + pass + " 项，失败 " + fail + " 项");
if (fail > 0) {
  process.exitCode = 1;
  console.log("MCP TESTS FAILED");
} else {
  console.log("ALL MCP TESTS PASSED");
}
