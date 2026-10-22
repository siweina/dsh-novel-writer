/**
 * lib/log.js —— v6.6.0 引入的**本地事件日志**（可观测性）
 *
 * ## 为什么需要它
 *
 * 插件此前的自我披露做得不差（`assert` 中文提示、`degraded[]`、`notes[]`、`checklist[]`、
 * 「被拒绝的模式显式报出」），但它们都只覆盖**单次调用**。看不见的是**跨调用/跨会话**的规律：
 *   · 全仓库有 ~100 处 `catch { /* … *\/ }`（按设计"不影响主流程"的静默跳过），
 *     其中「读不到」与「本来就没有」表现**完全一样**——问题唯一能藏身的地方；
 *   · 用户的操作错误（书名末尾带空格、书库根填成 novels 目录本身、章号格式不对）
 *     每次都会有友好报错，但**重复了 5 次**这件事没人知道；
 *   · 报 bug 时手上没有任何可附带的证据（issue #1 与 Glama 构建失败两次都吃了这个亏）。
 *
 * ## 三条硬约束（这是本模块存在的意义，改它之前先读这里）
 *
 * ① **绝不把正文带出本机。** 插件的核心承诺是「本地、正文不外传」，而日志天生会被贴出去
 *    （贴进 issue、贴给 AI 看）。一旦日志里有正文片段，就等于把作者的作品泄漏了。
 *    实现手段是**字段白名单**而不是黑名单：只有 `ALLOWED_KEYS` 里的键能落盘，
 *    **未知键一律丢弃**——所以调用方"顺手多传一个字段"不会意外带出正文。
 *    自由文本字段（note/detail/suggestion）另有长度上限与"长中文串"收敛，
 *    并有测试用真实章节正文做探针断言"日志里搜不到正文的任何连续片段"。
 *
 * ② **绝不抛错、绝不阻塞主流程。** 本模块每个导出函数内部的失败都被吞掉：
 *    写日志失败绝不能让工具调用失败（那才是本末倒置）。唯一例外是"首次失败"时
 *    往 stderr 打一行提示，且只打一次——否则连日志本身出问题都无从知晓。
 *
 * ③ **落点必须永远可写。** 日志写在**状态目录**旁（`<state.json 所在目录>/logs/`），
 *    **不是**书库根的 `.novel-writer/` ✗。理由很实在：最常见的故障就是"书库根不对"，
 *    那时候 `.novel-writer/` 根本不存在或不可写——偏偏这时最需要留下证据。
 *    状态目录还会被 `DSH_NOVEL_WRITER_STATE` 覆盖，测试因此天然隔离。
 *
 * ## 读者不是作者
 *
 * 小说作者不会去看 `.jsonl`。真正的消费者是**替他操作的 AI**（经 `novel_diagnose` 读成中文报告）
 * 与**维护者**（收到用户附上的诊断包）。所以本模块只负责"如实、结构化、脱敏地记下来"，
 * "讲成人话"是 `lib/diagnose.js` 的职责。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 状态文件路径的**本地镜像**。
 *
 * 为什么不直接 `import { stateFilePath } from "./core.js"`：那样 `log.js` 就依赖 `core.js`，
 * 而 `core.js` 里恰恰有 35 处最需要记日志的静默 catch——**它会形成循环导入**（ESM 下
 * `const` 导出的 TDZ 会让其中一方拿到未初始化绑定，风险高且难查）。
 * 所以这里刻意重复 6 行路径逻辑，换来"任何模块都能安全记日志"。
 * 两边必须保持一致，由 `test/log-test.mjs` 断言 `dirname(logDir()) === dirname(stateFilePath())` 守着。
 */
function stateFilePathLocal() {
  const override = process.env.DSH_NOVEL_WRITER_STATE;
  if (typeof override === "string" && override.length > 0) return override;
  return join(homedir(), ".dsh", "dsh-novel-writer", "state.json");
}

/** 单文件上限：超过就轮转（默认 512 KB，约数千条事件） */
export const LOG_MAX_BYTES = 512 * 1024;
/** 保留的历史文件数（events.1.jsonl … events.<N>.jsonl），加上当前文件共 N+1 份 */
export const LOG_KEEP_FILES = 3;
/** 单条事件序列化后的上限（防某条事件把文件一次撑爆） */
export const LOG_MAX_EVENT_BYTES = 4096;
/** 自由文本字段上限（note/detail/suggestion） */
export const LOG_FREE_TEXT_MAX = 160;
/**
 * 自由文本里"连续中文/日文等表意文字"的长度上限。
 * 这不是安全保证（保证靠白名单 + 测试），而是**降低误伤面**。
 */
export const LOG_CJK_RUN_MAX = 40;
/**
 * 自由文本里允许出现的**句末标点**。出现即从该处截断。
 *
 * 为什么是这条规则：正文必然由**成句**的文字组成（含 。！？），而本插件自己写进日志的
 * 提示语都是**短语/单句片段**（实测：书库根提示、词表损坏提示、章节过短提示都不含句末标点）。
 * 这条规则不是安全证明——它只是把"调用方顺手把正文传进 detail"这一类误用的爆炸半径压到一句话。
 * 真正的保证是两道：① 字段白名单；② test/log-test.mjs 里用真实章节正文做**金丝雀断言**
 * （跑完整工具流程后，日志里搜不到正文的任何连续片段）。
 *
 * ⚠️ 这条规则的历史值得一提：第一版只挡"连续 40 字中文串"，而带标点的正文会把它切断，
 * 于是 160 字正文原样落盘——**是被上面那条金丝雀测试当场抓出来的**。
 */
const SENTENCE_END = /[。！？!?…]+/;

/** 自由文本收敛：压掉换行/多余空白，按长度、句末标点与"长表意文字串"截断 */
function clampFreeText(value) {
  let s = String(value).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  const end = s.search(SENTENCE_END);
  if (end >= 0) s = s.slice(0, end) + "…";              // 成句文字：只留第一句之前的部分
  if (s.length > LOG_FREE_TEXT_MAX) s = s.slice(0, LOG_FREE_TEXT_MAX) + "…";
  // 长表意文字串 → 截断（无标点正文最可能的形态）
  const run = s.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{41,}/);
  if (run) s = s.slice(0, s.indexOf(run[0]) + LOG_CJK_RUN_MAX) + "…";
  return s;
}

/**
 * **字段白名单**：只有这些键能落盘。这是"正文传不出去"的实现手段（**注意**：本地层的自由文本
 * 字段仍可能出现被错误消息回显的输入片段，至多一句 ≤160 字——见文件头对两级隐私的说明）——
 * 未知键被丢弃，所以调用方无法"顺手"把 text/content 带出去。
 */
export const ALLOWED_KEYS = Object.freeze([
  "ts", "kind", "level",
  "tool", "action", "status", "code",
  "book", "chapter", "file", "path", "root", "rootSource", "mode", "scope", "name",
  "ms", "count", "degradedCount", "bytes", "files",
  "note", "detail", "suggestion", "source", "phase", "version", "plugin",
  // v6.6.0 修正（由测试负责人实测抓出）：`summarizeArgs` 产出的**长度/计数**派生键必须一并登记，
  // 否则它们会被本白名单丢掉 —— 也就是「参数摘要只记长度」这一半**根本没生效**：
  // 实测 15 个键落盘只剩 8 个，`contentChars`/`textChars`/`srcChars`/`filesCount`/`chaptersCount`/
  // `termsCount` 与定位字段 `name` 全丢。隐私侧没有问题（正文本来也进不来），损失的是可观测性
  // ——「这次调用带了多少字正文」永远查不到，而这正是排查"AI 把正文传错了"时要看的东西。
  "contentChars", "textChars", "srcChars", "filesCount", "chaptersCount", "termsCount",
  // v6.6.0 修正：超长事件的显式截断标记（读侧要能看到"这里丢过东西"，而不是以为本来就没有）
  "truncated",
  // v6.8.0：按书删除的失败项计数（action=apply/restore 的留痕；`failed` 这个键名太容易与
  // status="failed" 混淆，故另起名）
  "failures", "trashId"
]);

/**
 * 额外拦一道**显式黑名单**（纵深防御，不是主手段）：即使有人把某个键加进白名单，
 * 这些名字仍然直接丢——它们最可能承载正文或其片段。
 */
export const FORBIDDEN_KEYS = Object.freeze([
  "text", "content", "body", "excerpt", "raw", "paragraph", "paragraphs",
  "anchor", "anchors", "skeleton", "skeletons", "summary", "brief", "report",
  "prompt", "term", "terms", "entries", "chaptertext", "fulltext"
]);

/** 事件类型（诊断按 kind 聚合；新增 kind 时记得同步 lib/diagnose.js 的分组表） */
export const LOG_KINDS = Object.freeze([
  "tool_call",      // 工具调用（审计轨迹）
  "root_resolve",   // 书库根解析
  "silent_skip",    // 被静默跳过的失败（对应代码里那些 catch）
  "degraded",       // 降级披露（工具返回了 degraded/notes）
  "cache",          // 缓存读写失败/重建
  "engine",         // 语义引擎（模型/WASM）相关问题
  "config",         // 配置/词表/基线等读写异常
  "panel",          // 面板侧失败（挂载、请求）
  "internal"        // 兜底
]);

let warnedOnce = false;
/** 首次失败往 stderr 提示一行（只一次）；之后彻底沉默，避免刷屏或递归 */
function warnOnce(reason) {
  if (warnedOnce) return;
  warnedOnce = true;
  try {
    console.warn("[dsh-novel-writer] 事件日志写入失败（不影响功能，但诊断信息会缺失）：" + String(reason).slice(0, 160));
  } catch { /* stderr 都不可用就彻底放弃 */ }
}

/** 日志目录：状态文件所在目录下的 logs/（见文件头约束 ③） */
export function logDir() {
  return join(dirname(stateFilePathLocal()), "logs");
}
export function logFilePath() {
  return join(logDir(), "events.jsonl");
}
function rotatedPath(n) {
  return join(logDir(), "events." + n + ".jsonl");
}

function isFreeText(key) {
  return key === "note" || key === "detail" || key === "suggestion";
}
/** 标量收敛：字符串 200 字上限（自由文本另走 clampFreeText） */
function clampScalar(key, value) {
  if (isFreeText(key)) return clampFreeText(value);
  const s = String(value).replace(/[\r\n\t]+/g, " ").trim();
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

/**
 * 净化一条事件：**只保留白名单键**，逐值收敛；对象/函数等一律丢弃。
 * 返回可直接 JSON.stringify 的普通对象。
 */
export function sanitizeLogData(data) {
  const out = {};
  if (!data || typeof data !== "object") return out;
  for (const key of Object.keys(data)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_KEYS.includes(lower)) continue;      // 显式黑名单优先
    if (!ALLOWED_KEYS.includes(key)) continue;          // 白名单之外一律丢弃
    const value = data[key];
    if (value === void 0 || value === null) continue;
    if (typeof value === "number") { if (Number.isFinite(value)) out[key] = value; continue; }
    if (typeof value === "boolean") { out[key] = value; continue; }
    if (typeof value === "string") { const s = clampScalar(key, value); if (s !== "") out[key] = s; continue; }
    if (Array.isArray(value)) {
      const arr = [];
      for (const item of value.slice(0, 20)) {
        if (item === void 0 || item === null) continue;
        if (typeof item === "object") continue;         // 数组里也只允许标量
        arr.push(clampScalar(key, item));
      }
      if (arr.length > 0) out[key] = arr;
      continue;
    }
    // 对象/函数/符号：丢弃（正文最可能藏在这里）
  }
  return out;
}

/**
 * 把工具参数压成**安全摘要**：只取白名单里的定位类字段，**绝不带 content/text/files 内容**。
 * 这是"审计工具调用"能安全落盘的关键——参数里往往就有正文（如 novel_new_chapter 的 content）。
 */
export function summarizeArgs(args) {
  if (!args || typeof args !== "object") return {};
  const pick = ["book", "chapter", "action", "mode", "scope", "root", "file", "path", "name"];
  const out = {};
  for (const key of pick) {
    const value = args[key];
    if (value === void 0 || value === null) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    out[key] = clampScalar(key, value);
  }
  // 只记"给了几个"这种结构性信息，绝不记内容本身
  for (const key of ["content", "text", "src", "files", "chapters", "terms"]) {
    const value = args[key];
    if (value === void 0 || value === null) continue;
    if (Array.isArray(value)) out[key + "Count"] = value.length;
    else if (typeof value === "string") out[key + "Chars"] = value.length;
  }
  return out;
}

/** 必要时轮转：events.jsonl → events.1.jsonl → … → 删除最旧 */
function rotateIfNeeded() {
  let size = 0;
  try { size = statSync(logFilePath()).size; } catch { return; }   // 不存在就不用轮转
  if (size < LOG_MAX_BYTES) return;
  try {
    rmSync(rotatedPath(LOG_KEEP_FILES), { force: true });
    for (let n = LOG_KEEP_FILES - 1; n >= 1; n -= 1) {
      if (existsSync(rotatedPath(n))) renameSync(rotatedPath(n), rotatedPath(n + 1));
    }
    renameSync(logFilePath(), rotatedPath(1));
  } catch (e) {
    warnOnce("轮转失败：" + (e?.message ?? e));
  }
}

/**
 * 追加一条事件（**同步**写）。为什么同步：工具调用本身是异步的，但一次 appendFileSync
 * 只有几十字节，代价远小于"异步队列在进程退出时丢事件"的风险（本插件没有常驻进程生命周期钩子）。
 * 任何失败都被吞掉——写日志绝不能让工具调用失败。
 */
export function logEvent(kind, data) {
  try {
    const event = sanitizeLogData({ ...data, kind });
    event.ts = new Date().toISOString();
    let line = JSON.stringify(event);
    if (line.length > LOG_MAX_EVENT_BYTES) {
      // v6.6.0 修正（独立验证代理发现）：原来只 `delete event.detail` 然后 `slice(0, MAX)`。
      // 问题是**一旦仍超限就会写出半行 JSON** ✗，而读侧把解析不了的整行当"损坏行"跳过 →
      // **这条事件从诊断里凭空消失**，比"被截断"更糟：读取方看到的是"什么都没发生"。
      // 现在改为**逐级丢弃信息量最低的字段**，每步都重新序列化；
      // 最后仍超限时只保留结构性骨架，**永远写一行完整的 JSON**。
      // 两级都要打 `truncated` 标记——否则读取方看不出"这条被裁过"，会把"字段被丢"读成"本来就没有"。
      event.truncated = true;
      for (const key of ["detail", "note", "suggestion", "files", "path", "file", "name", "scope", "root"]) delete event[key];
      line = JSON.stringify(event);
    }
    if (line.length > LOG_MAX_EVENT_BYTES) {
      // 仍然超限（病态输入）：只留骨架（`truncated` 已在上一级置位）
      for (const key of Object.keys(event)) {
        if (!["ts", "kind", "tool", "status", "code", "level", "book", "chapter", "truncated"].includes(key)) delete event[key];
      }
      line = JSON.stringify(event);
    }
    const dir = logDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    rotateIfNeeded();
    appendFileSync(logFilePath(), line + "\n", "utf8");
  } catch (e) {
    warnOnce(e?.message ?? e);
  }
}

/** 工具调用审计（由注册层 wrapper 统一调用，见 lib/index.js 的 withAudit） */
export function logToolCall(info) {
  logEvent("tool_call", {
    tool: info?.tool,
    status: info?.status,
    ms: info?.ms,
    degradedCount: info?.degradedCount,
    code: info?.code,
    detail: info?.error,
    ...summarizeArgs(info?.args)
  });
}

/**
 * 读事件（新→旧）。诊断与面板都用它。
 *
 * **两级读法**（这是本模块隐私设计的第二半，务必理解）：
 * - `forShare: false`（默认）：本地诊断用，保留 `note/detail/suggestion` 等自由文本。
 *   日志文件本身**不出本机**——插件的承诺是"正文不外传"，本地多一个文件不违背它。
 * - `forShare: true`：**导出/分享用**，把自由文本字段**整体剔除**，只留结构性字段
 *   （工具名 / 书名 / 章号 / 状态 / 耗时 / 错误 code / 计数 / 时间）。
 *
 * 为什么必须分两级：值层面的启发式**从原理上无法保证**自由文本里不含正文
 * （正文的一句话就是正文，截到多短都还是正文）。所以真正的保证不是"让日志不含正文"，
 * 而是「**任何离开本机的东西都不含自由文本**」——面板的「导出诊断包」与
 * `novel_diagnose` 的对外报告都必须走 `forShare: true`。
 *
 * @param {{days?:number, limit?:number, book?:string, kind?:string, tool?:string, forShare?:boolean}} opts
 */
export async function readLogEvents(opts = {}) {
  const days = Number.isFinite(opts.days) && opts.days > 0 ? Math.min(365, opts.days) : 7;
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.min(5000, opts.limit) : 1000;
  const since = Date.now() - days * 24 * 3600 * 1000;
  const files = [logFilePath()];
  for (let n = 1; n <= LOG_KEEP_FILES; n += 1) files.push(rotatedPath(n));
  const events = [];
  for (const file of files) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let ev = null;
      try { ev = JSON.parse(line); } catch { continue; }   // 坏行跳过（截断写入等）
      // 再净化一遍：历史文件可能由旧版本写入，读侧不能假设它已经干净。
      // `ts` 在白名单里，所以净化后不会丢（早期版本曾把它漏在白名单外，靠再解析补回来——已修）。
      ev = sanitizeLogData(ev);
      if (!ev.ts) continue;
      const at = Date.parse(ev.ts);
      if (Number.isFinite(at) && at < since) continue;
      if (opts.kind && ev.kind !== opts.kind) continue;
      if (opts.tool && ev.tool !== opts.tool) continue;
      if (opts.book && ev.book !== opts.book) continue;
      events.push(ev);
    }
  }
  events.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const limited = events.slice(0, limit);
  // v6.6.0 修正（由测试负责人指出 **fail-open** 风险）：只有**显式** `forShare === false`
  // 才返回带自由文本的本地层；其它一切情况（含 `forShare: 1`、`"true"`、`{}`、忘传）
  // 一律按「对外分享」处理。
  //
  // 为什么方向要这样定：这是一条**隐私边界**。原来写的是 `!== true 就返回本地层`，
  // 于是将来有人写 `readLogEvents({ forShare: someFlag })` 而 someFlag 是 `1`/`"yes"` 时，
  // 会**静默拿到含自由文本的全量数据**并且**不报错** ✗——边界上的默认值必须偏向"少给"。
  // 代价：本地调试要看自由文本必须显式传 `forShare: false`（日志文件本身也始终可直读）。
  if (opts.forShare === false) return limited;
  return limited.map((ev) => {
    const copy = { ...ev };
    for (const key of ["note", "detail", "suggestion"]) delete copy[key];
    // v6.6.0 修正：`redacted` **恒带**（原先只在"本来有自由文本"时才加）。
    // 理由：读取方需要能区分「这条走过分享层、已脱敏」与「这条来自本地层」——
    // 若标记是条件性的，一条没有 detail 的事件在两种层里长得一模一样，无法自证来源。
    copy.redacted = true;
    return copy;
  });
}

/** 日志体积与文件数（诊断报告用） */
export function logStats() {
  const out = { dir: logDir(), files: [], bytes: 0, exists: false };
  try {
    for (const file of [logFilePath(), ...Array.from({ length: LOG_KEEP_FILES }, (_, i) => rotatedPath(i + 1))]) {
      try {
        const st = statSync(file);
        out.files.push({ file, bytes: st.size });
        out.bytes += st.size;
        out.exists = true;
      } catch { /* 不存在 */ }
    }
  } catch { /* 忽略 */ }
  return out;
}

/** 清空日志（面板/诊断工具的 action=clear） */
export async function clearLogs() {
  for (const file of [logFilePath(), ...Array.from({ length: LOG_KEEP_FILES }, (_, i) => rotatedPath(i + 1))]) {
    try { rmSync(file, { force: true }); } catch { /* 忽略 */ }
  }
  return true;
}
