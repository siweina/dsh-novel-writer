/**
 * dsh-novel-writer — core/state.js（Layer 1：基础状态、参数校验、路径解析与事务锁）
 *
 * 严格 DAG 最底层：只依赖 Node 内置、../manifest.js、../prompts.js 与 ../log.js，不依赖 text / domain / http。
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
// v7.3.1 修（#1）：补齐 resolve / sep——`resolvePathSafe` 与 `isInsideBookDir` 一直用它们却从未导入。
// 只补 resolve 不够：`isInsideBookDir` 里的 `a.endsWith(sep)` 在 resolvePathSafe 的 try **之外**裸用 sep，
// 缺它会把「返回 false」换成「ReferenceError 直接抛」——从"防护失效"升级成"调用点炸掉"。
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
// v7.5.0：工具清单与短标签由 manifest.js（零依赖单一事实源）统一持有，core/state.js 直接复用并透传导出
import { ALL_TOOLS, TOOL_LABELS, ALWAYS_VISIBLE_TOOLS } from "../manifest.js";
// v5.0.0：系统提示词的「场景」枚举由 prompts.js 单一持有（core 只做合法性校验与持久化）
import { PROMPT_SCENES } from "../prompts.js";
// v6.6.0：事件日志。`lib/log.js` 刻意做成**无依赖模块**（它自己镜像了状态文件路径），
// 所以 core 可以安全导入它，不会形成 core ↔ log 的循环导入。见 log.js 文件头的三条硬约束。
import { logEvent } from "../log.js";

const require = createRequire(import.meta.url);
export const PLUGIN_VERSION = require("../../package.json").version;
export const CACHE_VERSION = PLUGIN_VERSION;

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
export function requiredString(args, key) {
  const value = args?.[key];
  assert(typeof value === "string" && value.trim() !== "", `参数 "${key}" 不能为空字符串`);
  return value.trim();
}
export function optionalString(args, key) {
  const value = args?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
export function optionalInt(args, key, min, max, fallback) {
  const value = args?.[key];
  if (value === void 0) return fallback;
  assert(Number.isInteger(value) && value >= min && value <= max, `参数 "${key}" 必须是 ${min} 到 ${max} 之间的整数`);
  return value;
}
export function sanitizeSegment(value, label) {
  // v3.5.0 #32：除路径分隔符外，剥掉 Windows 保留字符与结尾点/空格，保留名（CON/NUL…）加下划线后缀
  // v7.1.0 修正（审查 #3）：**中间连续点号**也必须规整。旧版只剥首尾点号，《v1..2》清洗后仍是
  // 「v1..2」→ bookdelete 拼出的 trashId 带「..」→ trash.js 的 isValidTrashId 判非法，
  // 回收站条目从此 listTrash 看不见、restoreTrash/purgeTrash 入口直接拒收（永久孤立，磁盘死数据）。
  // 放在剥首尾点号之后、判空之前：单个点号（a.b）是合法书名，只有连续点号会撞上路径语义。
  let cleaned = String(value ?? "").replace(/[\\/:*?"<>|]/g, "").replace(/[.\s]+$/g, "").replace(/^[.\s]+/g, "").replace(/\.{2,}/g, "_");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) cleaned = "_" + cleaned;
  // v4.0.0 修正：删除恒真的 ["",".",".."].includes 判断（上一行已剥掉首尾点/空白，不可能等于它们）；
  // 空值单独给出可定位的提示——旧文案"含非法路径字符"把"清洗后为空"报成字符问题，误导排查
  assert(cleaned.length > 0, `参数 ${label} 不能为空（清洗后无有效字符）`);
  return cleaned;
}
// v5.0.0：宿主契约要求长任务可取消。取消（AbortError）不是"数据取不到"，
// 它是调用方主动中止——任何 catch 降级分支都必须先用本函数放行，否则取消会被
// 伪装成"成功但内容为空"的结果返回。全插件唯一判据，勿在别处再写一份。
export function isAbort(e) {
  return e?.name === "AbortError" || e?.code === "ABORT_ERR";
}
function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd();
}
// v6.3.0：记录「哪些书库根是调用方显式传入的」。显式 root（工具参数 root / CLI --root / 探针的临时书库）
// 只应影响本次调用，不该改写宿主记住的书库位置——否则用临时书库跑一次**写操作**，就会把用户的插件
// 指向一个随后被删掉的临时目录（实测：桌面端 lastRoot 被探针改成 F:\...\_cache\tmp\lexprobe-XXXX，
// 于是面板里书库为空、词表 0 条，且从界面上极难自查）。noteRoot 据此跳过落盘。
const explicitRoots = new Set();
// v6.4.0：同样的道理也适用于 **cwd 兜底**——`sessionCwd(exec)` 是"当前会话的工作目录"，
// 不是用户的库根。v6.3.0 只堵了「显式 root」那一路，这一路是漏的：
// 只要在**非库根目录**的会话里跑一次**写操作**（settings add/update、plot add、summary add、
// new_chapter 都会 noteRoot），lastRoot 就被写成那个 cwd。
// 实测桌面端 lastRoot 被写成 `F:\doment\_cache\fix4\lib`（某次测试会话的 cwd，目录早已不存在），
// 于是词表面板一本书都列不出来、显示「(尚未选择书)」——与 v6.3.0 修的是同一个坑的另一半。
const cwdFallbackRoots = new Set();
export function resolveRoot(config, args, exec) {
  const override = optionalString(args, "root");
  if (override !== void 0) {
    explicitRoots.add(override);
    // v6.6.0：**只记"可疑决策"，不记每次解析**——resolveRoot 每次工具调用都会跑，
    // 全都记下来只会把日志变成噪音 ✗。真正值得留痕的是"解析出来的根看起来不像书库根"
    // （面板列不出书、工具报"未找到作品目录"的头号原因，作者今天就被它困惑过两次）。
    if (!looksLikeLibraryRoot(override)) {
      logEvent("root_resolve", {
        root: override, rootSource: "调用参数 root", level: "warn",
        detail: "显式 root 看起来不像书库根（其下既无 novels/ 也无 .novel-writer/）——注意 root 必须是 novels 的父目录，填成 novels 目录本身会去找 novels/novels"
      });
    }
    return override;
  }
  const configured = config?.root;
  if (typeof configured === "string" && configured.trim() !== "") {
    const root = configured.trim();
    // config.root 也记可疑决策（配置写错是常见成因，而错误只在运行期表现为"列不出书"）
    if (!looksLikeLibraryRoot(root)) {
      logEvent("root_resolve", {
        root, rootSource: "插件配置 config.root", level: "warn",
        detail: "config.root 看起来不像书库根（其下既无 novels/ 也无 .novel-writer/）"
      });
    }
    return root;
  }
  const cwd = sessionCwd(exec);
  cwdFallbackRoots.add(cwd);
  // cwd 兜底是**最危险的一条路**（v6.3.0/v6.4.0 两次修复都在堵它）：它既可能指向随机会话目录，
  // 又会被 noteRoot 拒之门外。这里只记"看起来不像库根"的那种，避免把正常会话刷屏。
  if (!looksLikeLibraryRoot(cwd)) {
    logEvent("root_resolve", {
      root: cwd, rootSource: "cwd 兜底", level: "warn",
      detail: "既没有显式 root 也没有 config.root，回退到会话工作目录；该目录不像书库根，工具多半会报「未找到作品目录」"
    });
  }
  return cwd;
}
export function novelsDir(root) {
  return join(root, "novels");
}
export function novelDataDir(root) {
  return join(root, ".novel-writer");
}

// ============ v6.4.0：UI 路由的根解析（单一实现 + 可发现性） ============
/**
 * 「这个路径看起来像不像一个书库根」——判据是**结构**，不是猜测：
 * root 的下一层应当有 `novels/`（书在这里）或 `.novel-writer/`（插件数据在这里）。
 *
 * 为什么需要它：插件各处一律 `join(root, "novels")`，所以 root 必须是 **novels 的父目录**。
 * 一旦填成 novels 目录本身（或填了别的目录），`listBookNames` 会去找 `<root>/novels/novels` →
 * 目录不存在 → 它内部 `catch` **静默返回空数组** → 面板"一本书都没有"，而整条链路不报错。
 */
export function looksLikeLibraryRoot(root) {
  if (typeof root !== "string" || root.trim() === "") return false;
  try {
    return existsSync(join(root, "novels")) || existsSync(join(root, ".novel-writer"));
  } catch {
    return false;
  }
}

/** 根不可用时的可执行诊断（把"静默无书"变成"看一眼就知道怎么修"）。 */
function libRootWarning(root, source) {
  const where = {
    config: "来源：插件配置 config.root（profile 的 cordis.patch.yml）",
    "stale-lastRoot": "来源：lastRoot（上一次写操作记住的书库根）",
    cwd: "来源：当前会话的工作目录兜底"
  }[source] ?? "来源：" + source;
  const how = source === "stale-lastRoot"
    ? "这通常是在非库根目录的会话里跑过一次写操作造成的（写操作会把当时的根记进 lastRoot）。" +
      "修法二选一：① 在正确的库根目录下做一次写操作（如 novel_import / novel_new_chapter）以刷新记录；" +
      "② 在 profile 的 cordis.patch.yml 里给 dsh-novel-writer 显式配 config.root（更稳，不受会话目录影响）。"
    : "修法：把根指向库根（novels/ 的父目录，该目录下通常还有 .novel-writer/），或在其中创建 novels/ 目录。";
  // 注意：这里返回的是**前端直接显示**的纯文本（面板按 pre-wrap 原样渲染，不解析 Markdown），
  // 所以不要用 ** 之类标记来强调——那样只会把星号露给用户看。强调请靠措辞与断句。
  return "书库根「" + root + "」下既没有 novels/ 也没有 .novel-writer/ —— 面板将列不出任何书。" +
    where + "。注意 root 必须是 novels 的父目录，填成 novels 目录本身会让插件去找 novels/novels。" + how;
}

/**
 * 插件内部的书库根（最终兜底）——放在插件自己的数据目录下，与 `state.json` 同级。
 *
 * 为什么需要它：此前的兜底是 `process.cwd()`（当前会话的工作目录），而**工作区与书库没有任何必然关系**——
 * 在一个随便什么目录里开会话，面板就会把那个目录当成书库，然后静默列不出书。
 * 工作区只有在**确实像个书库**（有 novels/ 或 .novel-writer/）时才该被采用；
 * 否则应当落到一个**确定的、属于插件的**位置，而不是碰运气。
 */
export function internalRoot() {
  return join(homedir(), ".dsh", "dsh-novel-writer", "library");
}

/**
 * UI 路由的根解析 —— **全插件唯一实现**。
 *
 * v6.4.0 前有两处各写一遍：GET /state 里内联一个三元，`makeStateRoutes` 内又有一个 `resolveUiRoot` 闭包，
 * 两者语义相同但容易改漏一处。现在统一走本函数。
 *
 * 顺序：`config.root → lastRoot → cwd → 插件内部目录`，其中
 *   · `config.root` 非空即**硬钉**（显式配置就该被尊重；不像书库根则用它并给警告，而不是悄悄换掉）；
 *   · `lastRoot` / `cwd` 只在其**确实像书库根**时采用，否则跳过并**在警告里点名**（不静默丢弃配置）；
 *   · 全部落空时用 `internalRoot()` —— 保证**永远有一个可用的根**，且不再由工作区碰运气决定。
 *
 * 额外交代**来源**（source）与**诊断**（warning），是因为这条链上的失败此前是**完全静默**的：
 * 根配错、被删、或值填低一层，都只表现为面板「(尚未选择书)」，不报错、不写日志。
 */
export function resolveUiRootInfo(config, state) {
  const skipped = [];
  const cfg = typeof config?.root === "string" ? config.root.trim() : "";
  if (cfg !== "") {
    // 硬钉：显式配置永远生效（哪怕它不像书库根——那正是要告诉用户的事）
    return { root: cfg, source: "config", warning: looksLikeLibraryRoot(cfg) ? null : libRootWarning(cfg, "config") };
  }
  const last = typeof state?.lastRoot === "string" ? state.lastRoot.trim() : "";
  if (last !== "" && looksLikeLibraryRoot(last)) return { root: last, source: "lastRoot", warning: null };
  if (last !== "") skipped.push(libRootWarning(last, "stale-lastRoot"));
  const cwd = process.cwd();
  if (looksLikeLibraryRoot(cwd)) {
    // 工作区确实是书库（在小说项目目录里开会话）——沿用既有便利
    return { root: cwd, source: "cwd", warning: skipped.length ? skipped.join("\n\n") : null };
  }
  // 工作区不像书库**不是异常**——那正是回退到插件内部目录的设计路径，故不为此报警告
  // （只有"显式配置过却被拒"才值得点名，否则每次在随便哪个目录开会话都会弹警告，纯噪音）。
  //
  // 全部落空 → 插件内部目录。它**按定义就是合法的根**，故也不给"不像书库根"的警告；
  // 但若此前跳过了 lastRoot，仍把那条诊断带出来（否则用户的书为什么消失就无从得知）。
  return { root: internalRoot(), source: "internal", warning: skipped.length ? skipped.join("\n\n") : null };
}

/** 仅取根字符串（沿用既有调用点口径：**保证非空**）。 */
export function resolveUiRoot(config, state) {
  return resolveUiRootInfo(config, state).root;
}
export function bookDir(root, book) {
  return join(novelsDir(root), sanitizeSegment(book, "book"));
}

/**
 * 判断某路径是否落在正文目录（`novels/<书>/`）之内——用于拒绝把镜像放进正文目录。
 *
 * v7.3.1 修（#1）：本函数此前**恒返回 false**——`resolve` / `sep` 从未导入，
 * resolvePathSafe 里的 `resolve(...)` 抛 ReferenceError 被 catch 成 `""`，于是这里第一句就 return false。
 * 修好导入后断言才真的能工作。但要如实说明它能拦什么、不能拦什么：
 *
 *   能拦：把镜像/目标路径指到 `novels/<书>/` 之下的任何**绝对路径**（含 `..` 逃逸后被 resolve 归一的结果）。
 *   不能拦（**已知边界，故意不为此重写实现**）：
 *     ① 镜像路径按构造就在 `<root>/.novel-writer/drafts/<书>/`，正常调用下本断言**几乎恒真为 false**
 *        （不在正文目录内，放行）——它是一道兜底，不是常规防线；
 *     ② `resolve` 区分大小写（Windows 上 `NOVELS\` 与 `novels\` 不同字符串，路径实际同一处）；
 *     ③ 不解析软链接/junction，也不展开 8.3 短名（`PROGRA~1`）——经这些别名指向正文目录会漏判。
 *        **这里刻意保持词法**：本函数的输入是插件自己拼出来的镜像路径（不是用户书名），不存在
 *        "先有根内写权限、再预置链接"的攻击前提；需要防这一层的 `lib/bookdelete.js` 另实现了
 *        `realPathOf`（取存在的最深祖先做 realpath），删除/恢复用它。两处针对不同威胁，不要混用。
 *     ④ 相对路径按**当前进程 cwd** 解析，与书库根无关（调用方给的都是绝对路径）。
 * 要更强的保证需要 realpath + 大小写归一，那超出本函数职责（且会引入 IO 与平台差异），故不在此实现。
 */
export function isInsideBookDir(root, book, target) {
  const bookPath = join(novelDataDir(root), "..", "novels", sanitizeSegment(book, "book"));
  const a = resolvePathSafe(bookPath);
  const b = resolvePathSafe(target);
  if (a === "" || b === "") return false;
  const withSep = a.endsWith(sep) ? a : a + sep;
  return b === a || b.startsWith(withSep);
}
function resolvePathSafe(p) {
  try {
    return resolve(String(p));
  } catch {
    return "";
  }
}

// v5.0.0：leanWorkflow=精简工作流（全局布尔开关，默认 false=保持既有强制清单行为）。
// 它与 promptScene 同级（顶层键，不是 features 功能开关）——写进 features 会被 featureEnabled 的白名单语义污染。
const SENTENCE_ANALYSIS_DEFAULTS = Object.freeze({ enabled: true, autoAnalyze: true, systemPromptMode: "brief", promptScene: "general", leanWorkflow: false });
export { ALL_TOOLS, TOOL_LABELS, ALWAYS_VISIBLE_TOOLS };

/**
 * v7.3.0：**程序**决定"什么时候停下来问人"的字数阈值。
 * v7.3.0：改成可配置（用户可填）——用户在侧栏「实时聊天写作」那一行填多少就是多少（默认 400，允许 100~5000）。
 * 默认值仍写在程序里，是为了"用户没填"时行为确定；填过之后以用户为准。
 */
export const CHAT_PROMPT_THRESHOLD_CHARS = 400;
const CHAT_THRESHOLD_MIN = 100;
const CHAT_THRESHOLD_MAX = 5000;
/** 阈值归一：非数字/≤0 → null（表示"用默认值"）；超界一律夹到 [100, 5000]。 */
function normalizeChatThreshold(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(CHAT_THRESHOLD_MAX, Math.max(CHAT_THRESHOLD_MIN, Math.round(n)));
}

// v6.2.0：lexiconFirst=必用词优先（书级+全局词表注入开写包并参与成稿审计；默认开，词表为空时零影响）。
export const FEATURE_DEFAULTS = Object.freeze({ emotionCaveat: true, genreTheme: true, emotionComplexity: true, semanticEmbedding: true, semanticSearch: true, semanticStyle: true, semanticImplicit: true, rawWriting: false, webnovelVibe: true, lexiconFirst: true, chatWriting: false });
export function featureEnabled(state, name) {
  const features = state?.features ?? {};
  // v4.0.0 修正：缺键必须回退 FEATURE_DEFAULTS，而不是一律按 true——
  // 旧版导致 rawWriting（默认 false）未设置时 novel_sentence_config 谎报 true，
  // 与 UI（=== true）和提示词注入门控（=== true）三方不一致。
  const v = features[name];
  if (typeof v === "boolean") return v;
  return FEATURE_DEFAULTS[name] !== false;
}
export function semanticFeatureEnabled(state, name) {
  if (!featureEnabled(state, "semanticEmbedding")) return false;
  return featureEnabled(state, name);
}

const ALWAYS_VISIBLE_SET = new Set(ALWAYS_VISIBLE_TOOLS);
export function toolEnabled(state, name) {
  if (ALWAYS_VISIBLE_SET.has(name)) return true;
  const tools = state?.tools ?? {};
  return tools[name] !== false;
}
export async function assertToolEnabled(config, name) {
  const state = await readSentenceState();
  assert(toolEnabled(state, name), `工具 ${name}（${TOOL_LABELS[name] ?? name}）当前已在「写作助手功能」UI 中关闭。可用 novel_sentence_config 或侧边栏面板重新开启。`);
}
const TOOL_VISIBILITY_CHECK_INTERVAL_MS = 300;
let toolVisibilityCache = { file: "", mtimeMs: -1, size: -1, checkedAt: 0, tools: {} };
function cloneToolsMap(raw) {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return { ...raw };
  }
  return {};
}
function updateToolVisibilityCache(file, toolsObj) {
  const tools = cloneToolsMap(toolsObj);
  let mtimeMs = -1;
  let size = -1;
  try {
    const st = statSync(file);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    mtimeMs = -1;
    size = -1;
  }
  toolVisibilityCache = { file, mtimeMs, size, checkedAt: Date.now(), tools };
}
export function resetToolVisibilityCache() {
  toolVisibilityCache = { file: "", mtimeMs: -1, size: -1, checkedAt: 0, tools: {} };
}
export function isToolVisibleSync(name, opts) {
  if (typeof name !== "string" || name === "" || ALWAYS_VISIBLE_SET.has(name)) return true;
  try {
    const file = stateFilePath();
    const now = Date.now();
    const force = opts?.force === true;
    const minInterval = typeof opts?.minIntervalMs === "number" && opts.minIntervalMs >= 0
      ? opts.minIntervalMs
      : TOOL_VISIBILITY_CHECK_INTERVAL_MS;
    if (force || file !== toolVisibilityCache.file || now - toolVisibilityCache.checkedAt >= minInterval) {
      let st;
      try {
        st = statSync(file);
      } catch {
        toolVisibilityCache = { file, mtimeMs: -1, size: -1, checkedAt: now, tools: {} };
        return true;
      }
      if (force || file !== toolVisibilityCache.file || st.mtimeMs !== toolVisibilityCache.mtimeMs || st.size !== toolVisibilityCache.size) {
        try {
          const parsed = JSON.parse(readFileSync(file, "utf8"));
          const tools = cloneToolsMap(parsed?.tools);
          toolVisibilityCache = { file, mtimeMs: st.mtimeMs, size: st.size, checkedAt: now, tools };
        } catch {
          toolVisibilityCache = { file, mtimeMs: st.mtimeMs, size: st.size, checkedAt: now, tools: {} };
          return true;
        }
      } else {
        toolVisibilityCache.checkedAt = now;
      }
    }
    return toolEnabled({ tools: toolVisibilityCache.tools }, name);
  } catch {
    return true;
  }
}
export function stateFilePath() {
  // v3.5.0 #75：测试隔离——环境变量覆盖路径（e2e 用它，SIGKILL 也不碰用户配置）
  const override = process.env.DSH_NOVEL_WRITER_STATE;
  if (typeof override === "string" && override.length > 0) return override;
  return join(homedir(), ".dsh", "dsh-novel-writer", "state.json");
}
function styleConfigPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "novel-writer.json");
}
export function readStyleEnabled() {
  try {
    if (!existsSync(styleConfigPath())) return false;
    const parsed = JSON.parse(readFileSync(styleConfigPath(), "utf8"));
    return parsed?.stylePattern === true;
  } catch {
    // v6.6.0：上面的 existsSync 已排除"文件不存在"，走到这里就是**损坏/不可读**，
    // 而对外表现是"句式分析未启用"（用户会以为是自己没开）——真因必须留痕。
    logEvent("config", { file: styleConfigPath(), level: "warn", detail: "句式开关配置文件损坏或不可读，已按「未启用」处理" });
    return false;
  }
}
export async function readSentenceState() {
  try {
    const file = stateFilePath();
    if (!existsSync(file)) {
      return { exists: false, ...SENTENCE_ANALYSIS_DEFAULTS };
    }
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return {
      exists: true,
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : SENTENCE_ANALYSIS_DEFAULTS.enabled,
      autoAnalyze: typeof parsed.autoAnalyze === "boolean" ? parsed.autoAnalyze : SENTENCE_ANALYSIS_DEFAULTS.autoAnalyze,
      // v4.0.0：系统提示词注入档位（非法值一律回退默认）
      systemPromptMode: ["off", "brief", "full"].includes(parsed.systemPromptMode) ? parsed.systemPromptMode : SENTENCE_ANALYSIS_DEFAULTS.systemPromptMode,
      // v5.0.0：提示词场景（与档位正交；老状态文件没有该键 → general，即 4.x 通用工作流 + 本版补入的 7 行新工具指引）
      promptScene: PROMPT_SCENES.includes(parsed.promptScene) ? parsed.promptScene : SENTENCE_ANALYSIS_DEFAULTS.promptScene,
      // v5.0.0：精简工作流（严格布尔校验：只有真正的 true/false 才采用，"true"/1/null/缺失一律回退 false，
      // 与上面 promptScene 的白名单校验同一风格——不做真值转换，避免老状态文件里的脏值把开关"意外打开"）
      leanWorkflow: typeof parsed.leanWorkflow === "boolean" ? parsed.leanWorkflow : SENTENCE_ANALYSIS_DEFAULTS.leanWorkflow,
      tools: parsed.tools !== null && typeof parsed.tools === "object" ? parsed.tools : {},
      features: parsed.features !== null && typeof parsed.features === "object" ? parsed.features : {},
      // v7.3.0：实时聊天写作的**字数阈值**（用户在侧栏填；未填/非法 → 默认 400）
      chatThreshold: normalizeChatThreshold(parsed.chatThreshold) ?? CHAT_PROMPT_THRESHOLD_CHARS,
      // v3.0.0：风格基线容差（±%：用户允许低于/高于基线的范围）
      styleTolerance: parsed.styleTolerance !== null && typeof parsed.styleTolerance === "object" ? parsed.styleTolerance : null,
      // v3.1.0：原创模式设定（用户填写的创作意图，留空项=让模型自行设定）
      creationProfile: parsed.creationProfile !== null && typeof parsed.creationProfile === "object" ? parsed.creationProfile : null,
      // v3.1.0：按书专属设定（书名为键；无该书时回退全局 creationProfile）
      creationProfiles: parsed.creationProfiles !== null && typeof parsed.creationProfiles === "object" ? parsed.creationProfiles : {},
      lastRoot: typeof parsed.lastRoot === "string" ? parsed.lastRoot : void 0
    };
  } catch {
    // v6.6.0：**读不到 ≠ 没有**。上面的 existsSync 已排除"文件不存在"，故此处是损坏/不可读；
    // 而返回值 exists:false 会让所有调用方（含面板与工具开关判定）把它讲成"还没配置过"。
    logEvent("config", { file: stateFilePath(), level: "warn", detail: "状态文件损坏或不可读，已回退默认值（对外表现为 exists=false）" });
    return { exists: false, ...SENTENCE_ANALYSIS_DEFAULTS };
  }
}
export function readSentenceStateSync() {
  try {
    const file = stateFilePath();
    // v5.0.0：无状态文件/解析失败时仍给出 leanWorkflow —— 调用方（提示词注入侧）无条件读 st.leanWorkflow，
    // 不能出现"有文件=布尔值、无文件=undefined"两套口径（其余字段保持既有的"缺失即 undefined"语义不动）
    if (!existsSync(file)) return { leanWorkflow: false };
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      enabled: parsed.enabled !== false,
      autoAnalyze: parsed.autoAnalyze !== false,
      systemPromptMode: ["off", "brief", "full"].includes(parsed.systemPromptMode) ? parsed.systemPromptMode : "brief",
      // v5.0.0：提示词场景（同步版，供 systemPrompt.section 的 text 回调使用）
      promptScene: PROMPT_SCENES.includes(parsed.promptScene) ? parsed.promptScene : "general",
      // v5.0.0：精简工作流（同步版，与异步版 readSentenceState 同一严格布尔校验——两版口径必须一致，
      // 否则同一次会话里"注入提示词读到的值"与"UI/tool 读到的值"会互相矛盾）
      leanWorkflow: typeof parsed.leanWorkflow === "boolean" ? parsed.leanWorkflow : false,
      tools: parsed.tools !== null && typeof parsed.tools === "object" ? parsed.tools : {},
      features: parsed.features !== null && typeof parsed.features === "object" ? parsed.features : {},
      // v3.9.5：同步版补齐 styleTolerance（与异步版 readSentenceState 结构对齐）
      styleTolerance: parsed.styleTolerance !== null && typeof parsed.styleTolerance === "object" ? parsed.styleTolerance : null,
      // v3.1.0：原创模式设定（同步版，供 novel_outline 预填）
      creationProfile: parsed.creationProfile !== null && typeof parsed.creationProfile === "object" ? parsed.creationProfile : null,
      // v3.1.0：按书专属设定（书名为键；无该书时回退全局 creationProfile）
      creationProfiles: parsed.creationProfiles !== null && typeof parsed.creationProfiles === "object" ? parsed.creationProfiles : {},
      lastRoot: typeof parsed.lastRoot === "string" ? parsed.lastRoot : void 0
    };
  } catch {
    // v6.6.0：同 readSentenceState（existsSync 已排除"不存在"）——损坏时静默回退默认开关，真因留痕
    logEvent("config", { file: stateFilePath(), level: "warn", detail: "状态文件损坏或不可读（同步读），开关已回退默认值" });
    return { leanWorkflow: false };
  } // v5.0.0：解析失败同样回退默认（理由同上）
}
const writeQueues = new Map();
export async function atomicWriteJson(file, obj) {
  const prev = writeQueues.get(file) || Promise.resolve();
  const run = prev.then(async function () {
    const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  // v7.3.1 修（#2）：临时文件首写也必须包成 ENOVELWRITEFAIL，并对齐本函数 rename/直写分支的错误口径。
  // 旧版这一句在 try **之外**：磁盘满/权限不足时抛的是原生 ENOSPC/EACCES，路由层看不懂 code，
  // 于是按 400「参数错误」返回（该报 500），且 tmp 残留没人清——违反「写盘失败抛 ENOVELWRITEFAIL」契约。
  // v7.3.2 修（N24②）：JSON.stringify 也在这个 try 里，循环引用/BigInt 等**序列化**错误因此同样被包成
  // ENOVELWRITEFAIL。此处**刻意不区分**（下方 rename 失败后的直写分支同口径）：对调用方而言序列化失败与
  // 磁盘失败同属"服务端这次没能保存"，路由层本来就该回 500（而非 400 参数错误），统一成一个 code 更简单；
  // 且本函数入参都是 JSON.parse 产物或就地拼出的普通对象，循环引用/BigInt 在当前调用点结构上不可达。
  try {
    await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  } catch (writeErr) {
    try { await rm(tmp, { force: true }); } catch { /* 临时文件清理失败不掩盖主错误 */ }
    const err = new Error(`写盘失败（save failed）：${file} —— 临时文件 ${tmp} 写入未成功：` +
      `write=${writeErr?.code ?? writeErr?.message ?? writeErr}`);
    err.code = "ENOVELWRITEFAIL";
    err.cause = writeErr;
    throw err;
  }
  try {
    await rename(tmp, file);
  } catch (renameErr) {
    // v6.6.0：rename 失败会回退直写（未必致错），但它是"这个目录/文件有麻烦"的唯一早期信号
    //（Windows 上多为目标被占用/只读；跨设备、权限也走这里）。错误码就是最可定位的线索。
    logEvent("silent_skip", { file, level: "warn", detail: "原子写 rename 失败，已回退直写：" + (renameErr?.code ?? renameErr?.message ?? renameErr) });
    // rename 失败（跨设备/目标被占用/只读）回退直写；v4.3.0 修正：直写再失败必须向上抛——
    // 旧版 `catch { /* 忽略 */ }` 让调用方收到"已保存"但磁盘没变（Windows 文件被占用/只读/磁盘满全都静默丢数据）
    try {
      await writeFile(file, JSON.stringify(obj, null, 2), "utf8");
    } catch (writeErr) {
      try { await rm(tmp, { force: true }); } catch { /* 临时文件清理失败不掩盖主错误 */ }
      const err = new Error(`写盘失败（save failed）：${file} —— rename 与直写都未成功：` +
        `rename=${renameErr?.code ?? renameErr?.message ?? renameErr}；write=${writeErr?.code ?? writeErr?.message ?? writeErr}`);
      err.code = "ENOVELWRITEFAIL"; // 调用方（路由层）据此区分"写盘失败 500"与"参数错误 400"
      err.cause = writeErr;
      throw err;
    }
    try { await rm(tmp, { force: true }); } catch { /* 已直写成功，临时文件残留不影响数据 */ }
  }
  });
  writeQueues.set(file, run.then(function () {}, function () {}));
  return run;
}
const txQueues = new Map();
export async function withFileTx(file, fn) {
  const prev = txQueues.get(file) || Promise.resolve();
  const run = prev.catch(function () {}).then(fn);
  txQueues.set(file, run.then(function () {}, function () {}));
  return run;
}
let stateWriteChain = Promise.resolve();
export function clampStyleTolerance(tol) {
  const cleaned = {};
  if (tol !== null && typeof tol === "object" && !Array.isArray(tol)) {
    for (const [tk, tv] of Object.entries(tol)) {
      if (tv !== null && typeof tv === "object" && !Array.isArray(tv)) {
        if (Number.isFinite(tv.low) && Number.isFinite(tv.high) && tv.low <= 0 && tv.high >= 0 && tv.low <= tv.high) {
          const low = Math.max(-99, Math.min(0, tv.low));
          const high = Math.max(0, Math.min(99, tv.high));
          cleaned[tk] = { low, high };
        }
      }
    }
  }
  return cleaned;
}
const ALLOWED_TOOL_SET = new Set(ALL_TOOLS);
const ALLOWED_FEATURE_SET = new Set(Object.keys(FEATURE_DEFAULTS));
function filterBooleanStateMap(raw, allowedSet, omitKey) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const key of Object.keys(raw)) {
    if (!allowedSet.has(key) || (omitKey && key === omitKey)) continue;
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  }
  return out;
}
export async function writeSentenceState(patch) {
  if (patch !== void 0 && patch !== null && typeof patch === "object") {
    if (patch.tools !== void 0 && (patch.tools === null || typeof patch.tools !== "object" || Array.isArray(patch.tools))) {
      throw new Error("参数 \"tools\" 必须是键值对象（如 { novel_books: false }），不能是数组或非对象");
    }
    if (patch.features !== void 0 && (patch.features === null || typeof patch.features !== "object" || Array.isArray(patch.features))) {
      throw new Error("参数 \"features\" 必须是键值对象（如 { semanticEmbedding: false }），不能是数组或非对象");
    }
  }
  const run = stateWriteChain.then(async function () {
    const current = await readSentenceState();
    const toolsPatch = filterBooleanStateMap(patch?.tools, ALLOWED_TOOL_SET, "novel_sentence_config");
    const featuresPatch = filterBooleanStateMap(patch?.features, ALLOWED_FEATURE_SET);
    let tolPatch = {};
    if (patch?.styleTolerance === null) {
      tolPatch = { styleTolerance: null };
    } else if (patch?.styleTolerance !== void 0 && typeof patch?.styleTolerance === "object" && !Array.isArray(patch.styleTolerance)) {
      if (Object.keys(patch.styleTolerance).length === 0) {
        tolPatch = { styleTolerance: {} };
      } else {
        const cleanedTol = clampStyleTolerance(patch.styleTolerance);
        if (Object.keys(cleanedTol).length > 0) tolPatch = { styleTolerance: cleanedTol };
      }
    }
    const next = {
    ...current,
    ...(typeof patch?.enabled === "boolean" ? { enabled: patch.enabled } : {}),
    ...(typeof patch?.autoAnalyze === "boolean" ? { autoAnalyze: patch.autoAnalyze } : {}),
    // v4.0.0：系统提示词档位（只接受三个合法值，其余忽略）
    ...(["off", "brief", "full"].includes(patch?.systemPromptMode) ? { systemPromptMode: patch.systemPromptMode } : {}),
    // v5.0.0：提示词场景（非法值忽略；general 是显式合法值，用于改回通用档）
    ...(PROMPT_SCENES.includes(patch?.promptScene) ? { promptScene: patch.promptScene } : {}),
    // v5.0.0：精简工作流（只接受布尔值；非布尔值静默忽略——与上面 promptScene 处理非法枚举值的既有做法一致，
    // 开关类字段不做隐式转换：字符串 "true"/数字 1 一律当作没传，不写盘、不报错）
    ...(typeof patch?.leanWorkflow === "boolean" ? { leanWorkflow: patch.leanWorkflow } : {}),
    ...(toolsPatch !== null ? { tools: { ...(current.tools ?? {}), ...toolsPatch } } : {}),
    ...(typeof patch?.lastRoot === "string" ? { lastRoot: patch.lastRoot } : {}),
    ...(featuresPatch !== null ? { features: { ...(current.features ?? {}), ...featuresPatch } } : {}),
    // v7.3.0：实时聊天写作的字数阈值（非数字忽略；null/0 = 清回默认 400）
    // v7.3.2 修（N24①）：`null` 分支**保留以兼容旧调用方**。工具层（novel_sentence_config）经 schema 只可能
    // 传 number，0 表示清默认，确实不会再传 null；但本函数同时是 POST /state 的落盘入口，body 来自任意
    // JSON，旧面板/脚本仍可能发 null（旧语义 = 清回默认）。删掉它会让 null 静默变成"没传"、阈值不重置，
    // 故按"保留 + 如实注释"收口，行为不变。
    ...(patch?.chatThreshold === null || patch?.chatThreshold === 0 ? { chatThreshold: CHAT_PROMPT_THRESHOLD_CHARS } : {}),
    ...(patch?.chatThreshold !== null && patch?.chatThreshold !== 0 && patch?.chatThreshold !== void 0
      && Number.isFinite(Number(patch.chatThreshold)) && Number(patch.chatThreshold) > 0
      ? { chatThreshold: normalizeChatThreshold(patch.chatThreshold) }
      : {}),
    ...tolPatch, // v3.9.0：写路径统一钳制；全维非法时保留原值，显式 {} 清除
    ...(patch?.creationProfile !== null && typeof patch?.creationProfile === "object" ? { creationProfile: patch.creationProfile } : {}),
    ...(patch?.creationProfile === null ? { creationProfile: null } : {}),
    // v3.5.0 #20：creationProfiles 清空语义统一——null 或空对象 {} = 清除全部（设 null）
    ...(patch?.creationProfiles === null || (patch?.creationProfiles !== null && typeof patch?.creationProfiles === "object" && Object.keys(patch.creationProfiles).length === 0) ? { creationProfiles: null } : {}),
    ...(patch?.creationProfiles !== null && typeof patch?.creationProfiles === "object" && Object.keys(patch.creationProfiles).length > 0 ? { creationProfiles: (function (merged) { for (const k of Object.keys(merged)) if (merged[k] === null || merged[k] === void 0) delete merged[k]; return merged; })({ ...(current.creationProfiles ?? {}), ...patch.creationProfiles }) } : {}),
  };
  const file = stateFilePath();
  await mkdir(dirname(file), { recursive: true });
  // v4.3.0 修正：exists 是读取侧由"文件是否存在"推导的输出字段（readSentenceState），不是用户设置——
  // 旧版把 current 里的 exists 一起落盘，且首写时捕获的是"写前"快照 false 并被永久固化在 state.json 里
  // （磁盘上出现 exists:false 却在读侧被覆写成 true，两份口径互相矛盾）。落盘前剔除派生键。
  const { exists: _derivedExists, ...persisted } = next;
  await atomicWriteJson(file, persisted);
  updateToolVisibilityCache(file, persisted.tools);
  // 返回值保持"读取侧语义"：写完文件必然存在，故 exists 恒为 true（与随后的 readSentenceState() 一致，
  // 也让 index.js 的 effectiveSentenceAnalysis(config, current)/source 判定不再把刚保存的状态当成"默认值"）
  return { ...next, exists: true };
  });
  stateWriteChain = run.then(function () {}, function () {});
  return run;
}
export function effectiveSentenceAnalysis(config, state) {
  const configured = config?.sentenceAnalysis ?? {};
  const styleFileOn = readStyleEnabled();
  const enabled = state?.exists === true
    ? (state.enabled ?? SENTENCE_ANALYSIS_DEFAULTS.enabled)
    : (styleFileOn ? true : configured.enabled ?? configured.stylePattern ?? SENTENCE_ANALYSIS_DEFAULTS.enabled);
  const autoAnalyze = state?.exists === true
    ? (state.autoAnalyze ?? SENTENCE_ANALYSIS_DEFAULTS.autoAnalyze)
    : (configured.autoAnalyze ?? SENTENCE_ANALYSIS_DEFAULTS.autoAnalyze);
  return { enabled, autoAnalyze };
}
export async function noteRoot(root) {
  if (!root) return;
  // v6.3.0：调用方显式传入的 root 不落盘 lastRoot（原因见 resolveRoot 上方注释）
  if (explicitRoots.has(root)) {
    logEvent("root_resolve", { root, rootSource: "显式 root（跳过落盘）", detail: "调用方显式传入的根不改写宿主记住的书库位置——避免用临时书库跑一次写操作就把面板指向随后被删的目录" });
    return;
  }
  // v6.4.0：cwd 兜底来的根**只在它确实像一个书库根时**才落盘。
  //
  // 为什么不是一律不落盘：普通用户**没有设置库根的界面入口**，"在库根目录下跑一次导入/新建章节"
  // 正是他们建立 lastRoot 的唯一途径 —— 一律禁掉会把这条正常路径也堵死。
  // 但无脑落盘又会把"某次会话的随机 cwd"记进去（实测被写成 F:\doment\_cache\fix4\lib，
  // 目录随后被删，面板从此列不出书）。所以判据用**结构**：有 novels/ 或 .novel-writer/ 才认。
  if (cwdFallbackRoots.has(root) && !looksLikeLibraryRoot(root)) {
    logEvent("root_resolve", { root, rootSource: "cwd 兜底（跳过落盘）", level: "warn", detail: "cwd 兜底的根不像书库根，已拒绝记为 lastRoot——这正是「面板列不出书」的历史成因（v6.4.0 修的坑）" });
    return;
  }
  // v6.6.0：**只在 lastRoot 真的发生变化时**记一条。
  // 为什么：noteRoot 被每个写操作调用（settings/plot/summary/new_chapter…），每次都记会刷屏 ✗；
  // 而"书库根被改成什么"恰恰是排查"面板列不出书"时最需要的一条证据（作者今天就被它困惑两次）。
  // 读一次状态是廉价的（小 JSON 同步解析），且只发生在写操作路径上。
  let previous = null;
  try { previous = readSentenceStateSync()?.lastRoot ?? null; } catch { previous = null; }
  try {
    await writeSentenceState({ lastRoot: root });
    if (previous !== root) {
      logEvent("root_resolve", {
        root, rootSource: previous === null ? "lastRoot 首次记录" : "lastRoot 变更",
        detail: previous === null || previous === void 0 ? "首次记录书库根" : "由 " + String(previous).slice(0, 120) + " 改为 " + String(root).slice(0, 120)
      });
    }
  } catch (e) {
    // v6.6.0：写 lastRoot 失败以前是**纯静默**（实现子代理指出这正落在"最该留痕"的一类里）：
    // 它意味着"用户的书库根没被记住"，而表现要到下次打开面板才暴露（列不出书）——
    // 也就是 v6.4.0 修过的那个坑的另一种成因（那次是写错了值，这次是写不进去）。
    logEvent("config", {
      root, status: "failed", level: "warn",
      detail: "lastRoot 写入失败（面板下次可能列不出书）：" + String(e?.message ?? e)
    });
  }
}
