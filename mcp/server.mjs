#!/usr/bin/env node
/**
 * dsh-novel-writer — stdio MCP 服务器
 *
 * 让 Claude Desktop / Cursor / 任何 MCP 客户端直接使用插件的 novel_* 工具（当前 16 个）。
 * 实现方式：不复制任何业务逻辑——用 stub ctx 启动插件（lib/index.js 的 apply()），
 * 捕获它注册的 { name, description, parameters, execute, output } 工具定义，
 * 再把 MCP 的 tools/list / tools/call 映射到这些定义上。
 * v4.3.0 修正：工具数与 stub ctx 暴露的服务面（tools/systemPrompt/inject 的 webServer+skills+effect）
 * 不变时本文件无需改动；插件新增工具或改用别的宿主服务时，需同步 EXPECTED_TOOL_COUNT 与 stub ctx。
 *
 * 协议：换行分隔的 JSON-RPC 2.0（stdio），stdout 只走协议帧，日志一律写 stderr。
 * 依赖：仅 Node 内置模块（不依赖 @modelcontextprotocol/sdk）。
 *
 * 用法：node mcp/server.mjs [--root <书库根目录>] [--allow-external-src] [--ignore-plugin-load-error]
 *   --root 缺省时读环境变量 DSH_NOVEL_WRITER_ROOT，再缺省用 process.cwd()。
 *   v4.3.0：工具参数里的 root 必须落在 --root 之内；novel_import 的 src 同样默认限根内，
 *           确需导入外部目录时加 --allow-external-src。
 *   --ignore-plugin-load-error：插件 apply() 失败时不再直接 exit(1)，改为照常应答 initialize，
 *           此后每个请求回 -32603 说明原因（便于客户端看到 JSON-RPC 错误帧而不是"管道被关闭"）。
 *   DEBUG=1 环境变量：stderr 额外打印完整错误堆栈（默认只打一行摘要，避免绝对路径/书名泄漏）。
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// v4.3.0：MCP 生命周期「版本协商」——客户端在 initialize 里请求的版本若受支持，服务端 **MUST** 原样回；
// 否则回自己支持的最新版本（规范原文见 specification/2025-11-25/basic/lifecycle#version-negotiation）。
// 顺序即"新→旧"，表首同时作为默认与回退版本。
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
/** 本会话协商出的协议版本（initialize 时确定；未协商前按默认版本处理）。 */
let negotiatedVersion = PROTOCOL_VERSION;
/** JSON-RPC batching 自 MCP 2025-06-18 起被移除（ISO 日期字符串可直接比较大小）。 */
const BATCHING_REMOVED_SINCE = "2025-06-18";
const SERVER_NAME = "dsh-novel-writer";
const SERVER_VERSION = readPackageVersion();
const EXPECTED_TOOL_COUNT = 16;
// v4.3.0：单行 JSON-RPC 报文长度上限（字节）。超限行整行丢弃并记 stderr——readline 本身不设上限，
// 一条畸形超长行（或忘记换行的巨型 payload）会让缓冲区无界增长直到 OOM。
const MAX_LINE_BYTES = 4 * 1024 * 1024;
// DEBUG=1 时 stderr 才输出完整错误堆栈（默认只输出一行摘要，见 logError）
const DEBUG = process.env.DEBUG === "1";

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
  // v4.3.0：默认只打一行摘要——错误堆栈里含调用方机器上的绝对路径，错误消息里可能夹带书名/路径片段，
  // 而 stderr 会被 MCP 客户端原样写进日志文件。需要完整堆栈时用 DEBUG=1 显式开启。
  const summary = toText(error).replace(/\s+/g, " ").trim();
  log(prefix + (summary.length > 200 ? summary.slice(0, 200) + `…(共 ${summary.length} 字符)` : summary));
  if (DEBUG) {
    const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
    if (stack !== "") log(`${prefix}堆栈（DEBUG=1）：\n${stack}`);
  }
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
// v4.3.0：默认禁止 novel_import 读取书库根之外的目录（防"文档注入 → 复制任意 .md/.txt 进书库再读出"）
const ALLOW_EXTERNAL_SRC = process.argv.slice(2).includes("--allow-external-src");

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
        // v4.3.0：插件会可选注入 skills 注册内置 novel-writing 技能（P1-5），这里给个空桩
        skills: { registerProvider: () => () => {} },
        effect: (fn) => (typeof fn === "function" ? fn() : undefined)
      });
    } catch (error) {
      log("UI 路由注入跳过：" + toText(error && error.message));
    }
  }
};

// v4.3.0：插件加载失败时，默认仍 exit(1)（工具集为空时进程留着只会让客户端看到"连接已断开"），
// 但把原因写清 stderr；加 --ignore-plugin-load-error 则改为"带伤运行"——见下方 handleMessage 的
// INIT_FAILED 分支（照常应答 initialize，其余请求回 -32603，客户端能看到 JSON-RPC 错误帧）。
const IGNORE_PLUGIN_LOAD_ERROR = process.argv.slice(2).includes("--ignore-plugin-load-error");
let INIT_FAILED = null;
try {
  const plugin = await import(pathToFileURL(join(PLUGIN_DIR, "lib", "index.js")).href);
  await plugin.apply(ctx, { root: LIBRARY_ROOT });
} catch (error) {
  if (!IGNORE_PLUGIN_LOAD_ERROR) {
    logError("插件加载失败，服务器退出（如需保留服务器并回 JSON-RPC 错误帧，改用 --ignore-plugin-load-error）：", error);
    process.exit(1);
  }
  INIT_FAILED = error && error.message ? String(error.message) : toText(error);
  logError("插件加载失败，--ignore-plugin-load-error 已生效：initialize 仍会应答，其余请求回 -32603。原因：", error);
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
// 在途请求取消（MCP 2025-06-18：notifications/cancelled 带 requestId）
// v4.3.0：旧版 stub exec 没有 signal，收到 cancelled 只是静默忽略——语义检索/风格分析这类长任务
// 一旦开始就只能跑完。现在按 callId 记录 AbortController，取消时 abort，插件侧 fetch/耗时循环可见。
// ---------------------------------------------------------------------------
const inFlightAbort = new Map();

/** 取该 callId 对应的 AbortController 并注销（同一 id 只会被 abort 一次）。 */
function takeAbortController(id) {
  const controller = inFlightAbort.get(id);
  if (controller !== undefined) inFlightAbort.delete(id);
  return controller;
}

/** 撤销登记，且只在登记的仍是自己时删除（防止 id 复用后误删新请求的控制器）。 */
function releaseAbortController(id, controller) {
  if (inFlightAbort.get(id) === controller) inFlightAbort.delete(id);
}

/** 处理 notifications/cancelled：params.requestId 指向要取消的请求 id。 */
function handleCancelled(params) {
  const requestId = params && typeof params === "object" ? params.requestId : undefined;
  if (requestId === undefined || requestId === null) {
    log("收到 notifications/cancelled 但缺少 params.requestId，忽略");
    return;
  }
  const controller = takeAbortController(requestId);
  if (controller === undefined) {
    log(`收到 notifications/cancelled（requestId=${String(requestId)}），该请求不在途或已完成`);
    return;
  }
  controller.abort();
  log(`已取消在途请求 requestId=${String(requestId)}`);
}

/** 服务器自身结构不可用（插件加载失败）时的统一答复。 */
function initFailedError(id) {
  return rpcError(id, -32603, "服务器初始化失败：插件加载出错，工具不可用"
    + (INIT_FAILED ? `（${INIT_FAILED}）` : "")
    + "。请在启动日志中确认插件依赖是否完整。");
}

// ---------------------------------------------------------------------------
// 工具调用：参数补 root、执行、渲染文本、错误隔离
// ---------------------------------------------------------------------------
/** src 越界时的标记（tools/call 时报错用，不下传给插件）。 */
const SRC_OUT_OF_ROOT = Symbol("srcOutOfRoot");

/** 判断路径是否落在 --root 指定的书库根内（含根本身）。 */
function isInsideRoot(target) {
  const base = resolve(LIBRARY_ROOT);
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function buildArgs(name, raw) {
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  // 调用方未显式给 root 时注入服务器启动时确定的书库根目录
  if (typeof args.root !== "string" || args.root.trim() === "") {
    args.root = LIBRARY_ROOT;
  } else {
    // v4.3.0 安全修正（P1-6）：旧版把调用方给的 root 原样放行——"只读写书库根目录"的承诺等于交给
    // 调用方决定（配合 novel_import{src,move:true} 就能复制/删除盘上任意 .md/.txt）。
    // 现限定：调用方给的 root 必须落在启动参数 --root 指定的书库根内（含根本身），越界则回退并记日志。
    const requested = resolve(args.root.trim());
    if (isInsideRoot(requested)) {
      args.root = requested;
    } else {
      log(`拒绝越界 root：${requested}（不在书库根 ${resolve(LIBRARY_ROOT)} 内），已回退该书库根`);
      args.root = LIBRARY_ROOT;
    }
  }
  // v4.3.0：novel_import 的 src 默认限制在书库根内；确需导入外部稿件时用 --allow-external-src 放开
  if (name === "novel_import" && typeof args.src === "string" && args.src.trim() !== "") {
    const src = resolve(args.src.trim());
    if (!ALLOW_EXTERNAL_SRC && !isInsideRoot(src)) args[SRC_OUT_OF_ROOT] = src;
  }
  return args;
}

/**
 * 输出文本：优先采用插件 output.render 的结果。
 * v4.3.0 修正：插件的 16 个 render 全部按 DSH 宿主契约返回 [{type:"text",text}] 数组
 * （旧实现只认字符串 → 快速路径 16/16 不可达，MCP 客户端永远收到整包 JSON、精修文本被丢弃）。
 * 现在两种形态都认：字符串直接用；数组过滤出 type==="text" 的 text 后 join("\n")。
 * 其余情况（undefined / 非文本对象 / render 抛错）回退 JSON.stringify(value, null, 2)。
 */
function renderToolText(definition, args, value) {
  const render = definition && definition.output ? definition.output.render : undefined;
  if (typeof render === "function") {
    try {
      const rendered = render(args, value);
      if (typeof rendered === "string" && rendered !== "") return rendered;
      if (Array.isArray(rendered)) {
        const texts = rendered
          .filter((part) => part && part.type === "text" && typeof part.text === "string")
          .map((part) => part.text);
        if (texts.length > 0) return texts.join("\n");
      }
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
    if (INIT_FAILED !== null) return initFailedError(id);
    // v4.3.0：改为**符合规范**的协议错误。MCP《Tools → Error Handling》把 "Unknown tools" 明列为
    // Protocol Error，规范示例即 {"code":-32602,"message":"Unknown tool: invalid_tool_name"}
    // （见 specification/2025-11-25/server/tools#error-handling）。旧版回 isError 内容属于
    // "工具执行错误"，规范客户端会把它当成工具正常返回的文本，协议层无法处理。
    // 可读提示移到 error.data.hint，便于客户端展示又不违反分类。
    log(`未知工具：${name}`);
    return rpcError(id, -32602, `Unknown tool: ${name}`, {
      hint: `本服务器提供 ${toolMap.size} 个 novel_* 工具，可用 tools/list 查看`,
      availableToolCount: toolMap.size
    });
  }
  const args = buildArgs(name, params.arguments);
  if (args[SRC_OUT_OF_ROOT] !== void 0) {
    const blocked = args[SRC_OUT_OF_ROOT];
    delete args[SRC_OUT_OF_ROOT];
    log(`拒绝越界 src：${blocked}`);
    return rpcResult(id, {
      content: [{
        type: "text",
        text: `错误：src 必须位于书库根（${resolve(LIBRARY_ROOT)}）内，已拒绝 ${blocked}。`
          + "如确需导入外部目录的稿件，请用 --allow-external-src 重新启动本 MCP 服务器。"
      }],
      isError: true
    });
  }
  // v4.3.0：登记 AbortController，notifications/cancelled 可按 callId 取消这次执行
  const controller = new AbortController();
  inFlightAbort.set(id, controller);
  const exec = {
    signal: controller.signal,
    agent: { session: { header: { cwd: LIBRARY_ROOT } } }
  };
  try {
    const value = await definition.execute(args, exec);
    return rpcResult(id, { content: [{ type: "text", text: renderToolText(definition, args, value) }] });
  } catch (error) {
    if (controller.signal.aborted) {
      log(`工具 ${name} 已被客户端取消（id=${String(id)}）`);
      return rpcResult(id, {
        content: [{ type: "text", text: `错误：工具 ${name} 已被客户端取消（notifications/cancelled）。` }],
        isError: true
      });
    }
    const message = error && error.message ? error.message : toText(error);
    logError(`工具 ${name} 执行失败：`, error);
    return rpcResult(id, {
      content: [{ type: "text", text: "错误：" + message }],
      isError: true
    });
  } finally {
    releaseAbortController(id, controller);
  }
}

// ---------------------------------------------------------------------------
// 方法分派
// 注：批量请求（JSON 数组）是 JSON-RPC 2.0 自带能力，但 MCP 2025-06-18 已把 batching 从规范中移除。
// v4.3.0：批量请求按**协商版本**决定是否接受——MCP 2025-06-18 起移除了 JSON-RPC batching，
// 协商到该版本（或更新）时一律按无效请求拒绝；协商到 2024-11-05 / 2025-03-26 时保留实现（兼容旧客户端）。
// ---------------------------------------------------------------------------
async function handleMessage(message) {
  if (Array.isArray(message)) {
    if (negotiatedVersion >= BATCHING_REMOVED_SINCE) {
      return rpcError(null, -32600, `无效请求：协议版本 ${negotiatedVersion} 不支持批量请求（JSON-RPC batching 自 MCP 2025-06-18 起移除）`);
    }
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

  // 插件没能加载：initialize 照常应答、tools/list 回空清单（让客户端拿到 serverInfo 与合法工具集），
  // 其余请求回 -32603 说明原因
  if (INIT_FAILED !== null && method !== "initialize" && method !== "tools/list") {
    return respond(initFailedError(id));
  }

  switch (method) {
    case "initialize": {
      // v4.3.0：版本协商（MCP Lifecycle）：客户端请求的版本受支持 → 必须原样回；否则回自己最新的
      const requested = params && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      negotiatedVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
      return respond(rpcResult(id, {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      }));
    }
    case "ping":
      return respond(rpcResult(id, {}));
    case "tools/list":
      // 插件加载失败时回空清单（结构合法，客户端能优雅展示"没有工具"），其余请求才回 -32603
      return respond(rpcResult(id, INIT_FAILED === null ? toolListPayload() : { tools: [] }));
    case "tools/call":
      if (notification) return null;
      return handleToolCall(id, params);
    // 通知类方法：无响应
    case "notifications/initialized":
    case "initialized":
    case "notifications/cancelled":
    case "notifications/roots/list_changed":
    case "notifications/progress":
      // v4.3.0：方法名以 notifications/ 开头 ≠ 一定是通知。JSON-RPC 里带 id 就是请求，
      // 旧实现无条件 return null → 该请求永不结算（客户端一直等）。带 id 时按无效请求回 -32600。
      if (!notification) {
        log(`带 id 的 notifications/* 请求：${method}（应作为通知发送），已回 -32600`);
        return rpcError(id, -32600, `无效请求：${method} 是通知方法，不应携带 id`);
      }
      if (method === "notifications/cancelled") handleCancelled(params);
      return null;
    default:
      log(`未知方法：${method}`);
      return respond(rpcError(id, -32601, `Method not found: ${method}`));
  }
}

// ---------------------------------------------------------------------------
// stdout 写入与背压（v4.3.0）：write() 返回 false 说明内核管道缓冲已满，
// 旧实现无视返回值继续写 → 大响应/慢客户端时 Node 内部缓冲无界增长。
// 现在返回"本次写入完成"的等待函数，调用方 await 到 drain 事件再写下一帧。
// ---------------------------------------------------------------------------
let backpressured = false;
const drainWaiters = new Set();

function handleDrain() {
  backpressured = false;
  const waiters = [...drainWaiters];
  drainWaiters.clear();
  for (const resolve of waiters) resolve();
}

process.stdout.on("drain", handleDrain);
process.stdout.on("error", (error) => {
  // 客户端断开后 stdout 可能报 EPIPE：唤醒等待者并记日志，不让队列卡死
  log("stdout 错误（客户端可能已断开）：" + toText(error && error.message));
  handleDrain();
});

function writeMessage(payload) {
  if (backpressured) {
    return new Promise((resolve) => {
      drainWaiters.add(resolve);
      try {
        if (process.stdout.write(JSON.stringify(payload) + "\n") === false) backpressured = true;
      } catch (error) {
        log("stdout 写入失败（客户端可能已断开）：" + toText(error && error.message));
      }
    });
  }
  try {
    if (process.stdout.write(JSON.stringify(payload) + "\n") === false) {
      backpressured = true;
      return new Promise((resolve) => drainWaiters.add(resolve));
    }
  } catch (error) {
    log("stdout 写入失败（客户端可能已断开）：" + toText(error && error.message));
  }
  return null;
}

/** 退出前等 stdout 缓冲排空，避免最后一条响应被截断。 */
function flushStdout() {
  if (!backpressured) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    drainWaiters.add(done);
    const timer = setTimeout(done, 1000);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * 写一帧并遵守背压：返回"可以继续写下一帧"的等待 Promise（未背压时返回 null）。
 * 加 2 秒兜底——drain 事件理论上必然到来，但客户端半死（不读也不关）时不能让串行队列永久卡住。
 */
function writeAndWait(payload) {
  const waitForDrain = writeMessage(payload);
  if (waitForDrain === null) return Promise.resolve();
  return Promise.race([
    waitForDrain,
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      if (typeof timer.unref === "function") timer.unref();
    })
  ]);
}

async function handleLine(line) {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (trimmed === "") return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    // 非法 JSON 行：JSON-RPC 2.0 要求回 Parse error（-32700，id=null）后继续读流——旧实现只记 stderr
    // 不回帧，"服务器已收到但解析失败"对客户端不可见。这里补帧，并继续处理后续行（不能退出）。
    // v4.3.0：日志只记长度，不打正文前 N 字符（可能是用户稿件片段，stderr 会被客户端写进日志文件）。
    log(`非法 JSON 行（${trimmed.length} 字符），已回 -32700 Parse error`);
    await writeAndWait(rpcError(null, -32700, "Parse error: 不是合法的 JSON-RPC 报文"));
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
  if (response !== null && response !== undefined) {
    // 背压：write() 返回 false 时等 drain 再处理下一行，避免 Node 内部写缓冲无界增长
    await writeAndWait(response);
  }
}

// ---------------------------------------------------------------------------
// stdio 主循环（换行分隔 JSON-RPC 2.0）
// v4.3.0：不再用 readline —— 它没有行长上限，一条畸形超长行会让缓冲区无界增长；
// 这里自己按 \n 切分并设 MAX_LINE_BYTES 上限（超限整行丢弃、只记长度，绝不打正文）。
// ---------------------------------------------------------------------------
let queue = Promise.resolve();
let closed = false;
let buffer = "";
let bufferBytes = 0;      // 未结束行已缓冲的字节数（用于判断是否越过上限）
let dropping = false;      // 正在丢弃一条超限行：丢弃到下一个换行为止
let droppedBytes = 0;

function enqueueLine(line) {
  // 串行处理，保证同一连接内响应顺序与请求顺序一致
  queue = queue.then(() => handleLine(line)).catch((error) => logError("行处理异常：", error));
}

function onStdinData(chunk) {
  if (dropping) {
    const cut = chunk.indexOf("\n");
    if (cut === -1) {
      droppedBytes += chunk.length;
      return;
    }
    droppedBytes += cut + 1;
    dropping = false;
    log(`已丢弃超长行（>${MAX_LINE_BYTES} 字节，共 ${droppedBytes} 字节）`);
    droppedBytes = 0;
    bufferBytes = 0;
    onStdinData(chunk.slice(cut + 1));
    return;
  }
  buffer += chunk;
  bufferBytes += chunk.length;
  const parts = buffer.split("\n");
  buffer = parts.pop(); // 末尾是不完整行，留到下一个 chunk
  bufferBytes = buffer.length;
  for (const line of parts) {
    const text = line.replace(/\r$/, "");
    if (text.length > MAX_LINE_BYTES) {
      // 超限整行丢弃（只记字节数，绝不打正文——这行很可能是被误塞进来的稿件内容）
      log(`已丢弃超长行（>${MAX_LINE_BYTES} 字节，实际 ${text.length} 字节）`);
      continue;
    }
    enqueueLine(text);
  }
  if (bufferBytes > MAX_LINE_BYTES) {
    droppedBytes = buffer;
    buffer = "";
    bufferBytes = 0;
    dropping = true;
  }
}

let ended = false;
function onStdinEnd() {
  if (ended) return;
  ended = true;
  if (dropping) {
    log(`已丢弃未结束的超长行（>${MAX_LINE_BYTES} 字节）`);
    droppedBytes = 0;
    dropping = false;
  }
  if (buffer !== "") {
    enqueueLine(buffer);
    buffer = "";
  }
  if (closed) return;
  closed = true;
  const done = () => process.exit(0);
  // 等队列清空并让 stdout 落盘后再退出，避免最后一条响应被截断
  queue
    .then(() => flushStdout())
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
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", onStdinData);
process.stdin.on("end", onStdinEnd);
process.stdin.on("error", (error) => {
  logError("stdin 读取失败：", error);
  onStdinEnd();
});
process.stdin.resume();

// 未捕获异常不让进程静默崩溃：全部记到 stderr
process.on("unhandledRejection", (reason) => {
  logError("未处理的 Promise 拒绝：", reason);
});
process.on("uncaughtException", (error) => {
  logError("未捕获异常：", error);
  process.exit(1);
});
