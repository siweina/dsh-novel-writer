#!/usr/bin/env node
/**
 * dsh-novel-writer — stdio MCP 服务器
 *
 * 让 Claude Desktop / Cursor / 任何 MCP 客户端直接使用插件的 16 个 novel_* 工具。
 * 实现方式：不复制任何业务逻辑——用 stub ctx 启动插件（lib/index.js 的 apply()），
 * 捕获它注册的 { name, description, parameters, execute, output } 工具定义，
 * 再把 MCP 的 tools/list / tools/call 映射到这些定义上。插件升级后本文件无需改动。
 *
 * 协议：换行分隔的 JSON-RPC 2.0（stdio），stdout 只走协议帧，日志一律写 stderr。
 * 依赖：仅 Node 内置模块（不依赖 @modelcontextprotocol/sdk）。
 *
 * 用法：node mcp/server.mjs [--root <书库根目录>]
 *   --root 缺省时读环境变量 DSH_NOVEL_WRITER_ROOT，再缺省用 process.cwd()。
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "dsh-novel-writer";
const SERVER_VERSION = readPackageVersion();
const EXPECTED_TOOL_COUNT = 16;

/** 读插件 package.json 的 version（服务器版本随插件版本走）。 */
function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 任意值 → 可读文本（日志/兜底输出用）。 */
function toText(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 日志只写 stderr——stdout 是 JSON-RPC 协议通道，绝不能被污染。 */
function log(message) {
  try {
    process.stderr.write(`[${SERVER_NAME}-mcp] ${message}\n`);
  } catch {
    /* stderr 不可写时静默（例如父进程已关闭管道） */
  }
}

function logError(prefix, error) {
  log(prefix + toText(error));
}

// ---------------------------------------------------------------------------
// stdout 保护：插件内部若出现 console.log/info/debug（当前 lib/ 无此类调用），
// 一律改道 stderr，避免任何一行非 JSON 内容混进协议通道。
// ---------------------------------------------------------------------------
for (const method of ["log", "info", "debug"]) {
  console[method] = (...args) => {
    try {
      process.stderr.write(`[plugin:${method}] ${args.map(toText).join(" ")}\n`);
    } catch {
      /* 忽略 */
    }
  };
}

// ---------------------------------------------------------------------------
// 书库根目录：命令行 --root > 环境变量 DSH_NOVEL_WRITER_ROOT > process.cwd()
// ---------------------------------------------------------------------------
function parseCliRoot(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.trim() === "") {
        log("警告：--root 缺少路径值，忽略该参数");
        return null;
      }
      return value.trim();
    }
    if (arg.startsWith("--root=")) {
      const value = arg.slice("--root=".length).trim();
      if (value === "") {
        log("警告：--root= 缺少路径值，忽略该参数");
        return null;
      }
      return value;
    }
  }
  return null;
}

function resolveLibraryRoot(argv) {
  const cliRoot = parseCliRoot(argv);
  if (cliRoot !== null) return { root: resolve(cliRoot), source: "命令行 --root" };
  const envRoot = process.env.DSH_NOVEL_WRITER_ROOT;
  if (typeof envRoot === "string" && envRoot.trim() !== "") {
    return { root: resolve(envRoot.trim()), source: "环境变量 DSH_NOVEL_WRITER_ROOT" };
  }
  return { root: process.cwd(), source: "process.cwd()" };
}

const { root: LIBRARY_ROOT, source: ROOT_SOURCE } = resolveLibraryRoot(process.argv.slice(2));

// ---------------------------------------------------------------------------
// 用 stub ctx 启动插件，捕获 16 个工具定义
// ---------------------------------------------------------------------------
const registry = [];
const ctx = {
  tools: {
    register(definition) {
      if (definition && typeof definition.name === "string") registry.push(definition);
      return () => {};
    }
  },
  systemPrompt: { section: () => () => {} },
  // 插件可选注入 UI 状态路由：headless 下用桩接管（effect 立即执行并返回 noop 清理器）
  inject(_names, callback) {
    try {
      callback({
        webServer: { register: () => () => {} },
        effect: (fn) => (typeof fn === "function" ? fn() : undefined)
      });
    } catch (error) {
      log("UI 路由注入跳过：" + toText(error && error.message));
    }
  }
};

try {
  const plugin = await import(pathToFileURL(join(PLUGIN_DIR, "lib", "index.js")).href);
  await plugin.apply(ctx, { root: LIBRARY_ROOT });
} catch (error) {
  logError("插件加载失败，服务器退出：", error);
  process.exit(1);
}

const toolMap = new Map(registry.map((definition) => [definition.name, definition]));
log(`已注册 ${toolMap.size} 个工具；书库根目录 = ${LIBRARY_ROOT}（来源：${ROOT_SOURCE}）`);
if (toolMap.size !== EXPECTED_TOOL_COUNT) {
  log(`警告：工具数 ${toolMap.size} != 预期 ${EXPECTED_TOOL_COUNT}（插件升级后请同步检查）`);
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 响应构造
// ---------------------------------------------------------------------------
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function isNotification(message) {
  return !Object.prototype.hasOwnProperty.call(message, "id") || message.id === undefined;
}

// ---------------------------------------------------------------------------
// 工具调用：参数补 root、执行、渲染文本、错误隔离
// ---------------------------------------------------------------------------
function buildArgs(raw) {
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  // 调用方未显式给 root 时注入服务器启动时确定的书库根目录
  if (typeof args.root !== "string" || args.root.trim() === "") args.root = LIBRARY_ROOT;
  return args;
}

/**
 * 输出文本：优先采用插件 output.render 的字符串结果；插件侧 render 按 DSH 宿主契约
 * 返回 [{type:"text",text}]，MCP 只接受纯文本，故非字符串一律回退 JSON.stringify(value, null, 2)。
 */
function renderToolText(definition, args, value) {
  const render = definition && definition.output ? definition.output.render : undefined;
  if (typeof render === "function") {
    try {
      const rendered = render(args, value);
      if (typeof rendered === "string") return rendered;
    } catch (error) {
      log("render 失败，回退 JSON：" + toText(error && error.message));
    }
  }
  if (value === undefined) return "null";
  try {
    const text = JSON.stringify(value, null, 2);
    return typeof text === "string" ? text : "null";
  } catch (error) {
    log("JSON 序列化失败，回退 String：" + toText(error && error.message));
    return String(value);
  }
}

function toolListPayload() {
  return {
    tools: registry.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.parameters
    }))
  };
}

async function handleToolCall(id, params) {
  const name = params && typeof params.name === "string" ? params.name : "";
  if (name === "") {
    return rpcError(id, -32602, "无效参数：tools/call 需要字符串 name");
  }
  const definition = toolMap.get(name);
  if (!definition) {
    // 未知工具也走 isError 内容（而不是协议级错误）：客户端只会看到一条可读消息，不会中断会话
    log(`未知工具：${name}`);
    return rpcResult(id, {
      content: [{
        type: "text",
        text: `错误：未知工具 ${name}（本服务器提供 ${toolMap.size} 个 novel_* 工具，可用 tools/list 查看）`
      }],
      isError: true
    });
  }
  const args = buildArgs(params.arguments);
  const exec = { agent: { session: { header: { cwd: LIBRARY_ROOT } } } };
  try {
    const value = await definition.execute(args, exec);
    return rpcResult(id, { content: [{ type: "text", text: renderToolText(definition, args, value) }] });
  } catch (error) {
    const message = error && error.message ? error.message : toText(error);
    logError(`工具 ${name} 执行失败：`, error);
    return rpcResult(id, {
      content: [{ type: "text", text: "错误：" + message }],
      isError: true
    });
  }
}

// ---------------------------------------------------------------------------
// 方法分派
// ---------------------------------------------------------------------------
async function handleMessage(message) {
  if (Array.isArray(message)) {
    if (message.length === 0) return rpcError(null, -32600, "无效请求：空批次");
    const responses = [];
    for (const item of message) {
      const response = await handleMessage(item);
      if (response !== null) responses.push(response);
    }
    return responses.length > 0 ? responses : null;
  }
  if (message === null || typeof message !== "object") {
    return rpcError(null, -32600, "无效请求：应为 JSON-RPC 对象");
  }

  const { id, method, params } = message;
  const notification = isNotification(message);
  const respond = (payload) => (notification ? null : payload);

  if (typeof method !== "string") {
    return respond(rpcError(id === undefined ? null : id, -32600, "无效请求：缺少 method"));
  }

  switch (method) {
    case "initialize":
      return respond(rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      }));
    case "ping":
      return respond(rpcResult(id, {}));
    case "tools/list":
      return respond(rpcResult(id, toolListPayload()));
    case "tools/call":
      if (notification) return null;
      return handleToolCall(id, params);
    // 通知类方法：无响应
    case "notifications/initialized":
    case "initialized":
    case "notifications/cancelled":
    case "notifications/roots/list_changed":
    case "notifications/progress":
      return null;
    default:
      log(`未知方法：${method}`);
      return respond(rpcError(id, -32601, `Method not found: ${method}`));
  }
}

function writeMessage(payload) {
  try {
    process.stdout.write(JSON.stringify(payload) + "\n");
  } catch (error) {
    log("stdout 写入失败（客户端可能已断开）：" + toText(error && error.message));
  }
}

async function handleLine(line) {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (trimmed === "") return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    // 非法 JSON 行：忽略并继续（不能退出——否则一行脏数据就杀死整个会话）
    log("忽略非法 JSON 行：" + trimmed.slice(0, 200));
    return;
  }
  let response;
  try {
    response = await handleMessage(message);
  } catch (error) {
    logError("处理请求失败：", error);
    const id = message && typeof message === "object" && !Array.isArray(message) && message.id !== undefined
      ? message.id
      : null;
    response = rpcError(id, -32603, "内部错误：" + toText(error && error.message));
  }
  if (response !== null && response !== undefined) writeMessage(response);
}

// ---------------------------------------------------------------------------
// stdio 主循环（换行分隔 JSON-RPC 2.0）
// ---------------------------------------------------------------------------
const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
let queue = Promise.resolve();
let closed = false;

input.on("line", (line) => {
  // 串行处理，保证同一连接内响应顺序与请求顺序一致
  queue = queue.then(() => handleLine(line)).catch((error) => logError("行处理异常：", error));
});

input.on("close", () => {
  if (closed) return;
  closed = true;
  const done = () => process.exit(0);
  // 等队列清空并让 stdout 落盘后再退出，避免最后一条响应被截断
  queue
    .then(() => new Promise((res) => {
      try {
        process.stdout.write("", res);
      } catch {
        res();
      }
    }))
    .then(() => {
      log("stdin 已关闭，服务器正常退出");
      done();
    })
    .catch(() => done());
  // 兜底：插件若残留句柄导致无法自然退出，5 秒后强制退出
  const timer = setTimeout(() => {
    log("退出兜底超时（5s），强制退出");
    done();
  }, 5000);
  timer.unref();
});

input.on("error", (error) => {
  logError("stdin 读取失败：", error);
});

// 未捕获异常不让进程静默崩溃：全部记到 stderr
process.on("unhandledRejection", (reason) => {
  logError("未处理的 Promise 拒绝：", reason);
});
process.on("uncaughtException", (error) => {
  logError("未捕获异常：", error);
  process.exit(1);
});
