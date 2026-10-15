/**
 * test/log-test.mjs —— v6.6.0「可观测性与诊断」的正式测试（第 14 套）
 *
 * ## 本文件守的是什么
 *
 * v6.6.0 新增了三个互相咬合的东西：本地事件日志（lib/log.js）、注册层审计包装
 * （lib/index.js 的 installToolAudit）、第 20 个工具 + 诊断路由（lib/diagnose.js / index.js）。
 * 它们的**唯一**对外承诺不是功能，而是两条：**不把正文带出本机**、**绝不抛错**。
 * 承诺型契约最容易在"顺手改一行"里悄悄失效，所以这里逐条设门禁：
 *
 * ## ⚠ 口径（v6.6.0 定稿时校正，F1）
 *
 * 原来这里写的是「**绝不写正文**」——**对本地层不成立**，本文件的门禁也从来没有真的守住它：
 * 本地层的自由文本经 `clampFreeText` 收敛后**至多保留一句（≤ LOG_FREE_TEXT_MAX = 160 字）**，
 * 而"一句话"完全可能就是作者的原句。实测复现（走真实工具路径）：
 *   `novel_lexicon action=update term="灯塔的看守人在第三块礁石上捡到一枚生锈的铜钥匙上面刻着两个模糊的名字"`
 *   → 抛「词表中找不到词条…」→ 报错消息把该串回显进 `detail` → 本机 `logs/events.jsonl` 里
 *   出现这 **34 字原句**（无句末标点、连续表意文字 ≤ 40 字，因此两级收敛都不触发）。
 * 所以本文件现在守的是**两级口径**：
 *   · **本地层**：自由文本可能被保留到**一句话 / 160 字**——测试断言的是"至多一句"（见 ④ / ⑤-c / ⑤-d），
 *     **不再断言"本地层里搜不到正文片段"**（那既不成立、又会让断言退化成只查一个短窗口而形同虚设）。
 *   · **分享层**（任何离开本机的内容）：**整体剔除自由文本**，因此对**任意 ≥6 字连续窗口**零命中是
 *     可以断言、也必须断言的（见 ⑤ / ⑤-c / ⑤-d / ③ / ⑨-e）。
 * 协调方已判定：**不收紧本地层**（改成 40 字上限之类会削弱诊断价值、且仍会泄漏若干字），
 * 正确的修法是改口径而不是改代码——本文件据此改写。
 *
 *   ① 落点与常量       —— logs/ 必须紧邻 state.json，**不是**书库根（本夹具刻意把两者分开）
 *   ② 字段白名单       —— 不在 ALLOWED_KEYS 里的键一律丢弃（content/text/对象值/未知键）
 *   ③ 参数摘要         —— summarizeArgs 只记定位字段 + content/text 的**长度**，用真实正文当探针
 *   ④ 本地层自由文本   —— 保留但从第一句末标点截断，且有长度上限（160 / 长中文串 40）；
 *                          **至多一句（≤160 字）会被完整保留**＝F1 已知边界，本套如实断言（不再说"本地层无正文"）
 *   ⑤ 分享层（核心）   —— forShare:true 整体剔除 note/detail/suggestion + redacted 标记；
 *                          端到端断言：跑真实工具后，分享层（readLogEvents / novel_diagnose 返回与
 *                          渲染文本 / GET /diagnose 响应）里**搜不到金丝雀句子的任何连续片段（≥6 字窗口）**，
 *                          而同一次运行里**本地层必须搜得到**（否则断言是空的）。
 *                          失败路径必须一起测：正文是被**报错消息回显**带进日志的（⑤-c 的三条探针 / ⑤-d）
 *   ⑥ 轮转与有界       —— 超 LOG_MAX_BYTES 轮转、历史文件 ≤ LOG_KEEP_FILES、总量有界（现算磁盘真值）
 *   ⑦ 读侧容错         —— 坏行跳过不崩；历史文件读取时**再净化一遍**；超长事件**永远写完整 JSON 行**（⑦-c，F3 回归）
 *   ⑧ 绝不抛错         —— 状态目录不可写/盘不存在时全部 API 仍不得抛
 *   ⑨ 审计包装         —— ok/degraded/failed 三态、参数摘要、异常**原样抛出**（与不装审计逐字段一致）、
 *                          返回值/错误对象**同一引用**、注册后 register 还原、宿主只读时放弃审计但不影响注册
 *   ⑩ novel_diagnose   —— ALL_TOOLS=20、报告中文/含"诊断报告"、issues 四字段、
 *                          clear 后 ≤1 条（clear 自身就是一次调用）、events、以及**返回键 ⊆ schema.properties**
 *                          （通用遍历：diagnose 三 action + 6 个既有工具）
 *   ⑪ 诊断路由         —— GET 200 {ok:true,report}、?events=1、POST 405、非回环 403、cross-site 403
 *   ⑫ 隔离守卫         —— 全套跑完后，用户**真实** state.json 与真实 logs/ 必须一字未改
 *
 * ## 隔离（本会话早前踩过的坑，务必保留）
 *
 * `DSH_NOVEL_WRITER_STATE` 指向 tmpdir 内的**独立状态目录**，且该目录与书库根**分开**
 * （这样"日志落点在状态目录旁、不在书库根"才是可测的，而不是巧合）。
 * 所有工具调用显式传 `root`（v6.3.0 起显式 root 不写 lastRoot），env 在**动态 import 之前**设好。
 * 最后一条测试把真实 state.json / 真实 logs/ 的哈希与清单与开跑前对比——污染会被当场抓住。
 *
 * ## 期望值口径
 *
 * 一律**现算**：报告里的数字与磁盘真值（逐行 JSON.parse 后按同一过滤口径统计）比对，
 * 不信报告自己的说法。
 *
 * 运行：node test/log-test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// ===========================================================================
// 隔离夹具：先设 env，再动态 import（静态 import 会先于模块体求值）
// ===========================================================================

const ROOT = join(tmpdir(), "dsh-novel-writer-log-" + process.pid + "-" + Date.now().toString(36));
/** 书库根（含 novels/）——**故意**与状态目录分开 */
const LIB = join(ROOT, "lib-root");
/** 状态目录：state.json 与 logs/ 都在这（契约 ③：日志落点跟着 state.json，不跟书库根） */
const STATE_DIR = join(ROOT, "state-dir");
const STATE = join(STATE_DIR, "state.json");
const REAL_STATE = join(homedir(), ".dsh", "dsh-novel-writer", "state.json");
const REAL_LOG_DIR = join(homedir(), ".dsh", "dsh-novel-writer", "logs");

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(LIB, "novels"), { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(join(ROOT, "dsh-home"), { recursive: true });
process.env.DSH_NOVEL_WRITER_STATE = STATE;
process.env.DSH_HOME = join(ROOT, "dsh-home");
process.on("exit", () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

/** 隔离守卫：开跑前的真实用户侧快照 */
const guardBefore = { state: fileDigest(REAL_STATE), logs: dirDigest(REAL_LOG_DIR) };
function fileDigest(path) {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; }
}
function dirDigest(path) {
  try {
    return readdirSync(path).sort().map((name) => {
      try { return name + ":" + statSync(join(path, name)).size; } catch { return name + ":?"; }
    }).join("|");
  } catch { return null; }
}

const { apply } = await import("../lib/index.js");
const { ALL_TOOLS, stateFilePath } = await import("../lib/core.js");
const log = await import("../lib/log.js");

// ── 金丝雀 ──────────────────────────────────────────────────────────────────
// 唯一性靠"紫晶兰金丝雀"这个组合词保证：本书正文、文件名、词条名都只用它。
const CANARY_CORE = "紫晶兰金丝雀在第七码头低声鸣叫三声";
const CANARY_TAIL = "，随后振翅飞向北方。";
const CANARY_SENTENCE = CANARY_CORE + CANARY_TAIL;
const BOOK = "紫晶书";
const FILLER = "檐下的铜铃被风推得轻响，他数着远处的灯火，一盏，两盏，直到夜色把街口吞没。";
const FILLER2 = "她把藤箱合上，扣好搭扣，回头看了一眼空下来的屋子，才推门走进雨里。";

/** 金丝雀句子的全部连续片段（≥6 字）——分享层里出现任意一段就算泄漏 */
const CANARY_WINDOWS = (() => {
  const out = [];
  for (let len = 6; len <= CANARY_SENTENCE.length; len += 1) {
    for (let i = 0; i + len <= CANARY_SENTENCE.length; i += 1) out.push(CANARY_SENTENCE.slice(i, i + len));
  }
  return out;
})();
/** 任意字符串的全部 ≥6 字连续窗口（⑤-d 用来扫 F1 原句） */
function windowsOf(text, min = 6) {
  const out = [];
  for (let len = min; len <= text.length; len += 1) {
    for (let i = 0; i + len <= text.length; i += 1) out.push(text.slice(i, i + len));
  }
  return out;
}
function leakOf(text, windows) {
  const s = String(text ?? "");
  return windows.find((w) => s.includes(w)) ?? null;
}
function canaryLeak(text) {
  return leakOf(text, CANARY_WINDOWS);
}
function assertNoCanary(text, label) {
  const hit = canaryLeak(text);
  assert.equal(hit, null, label + " 泄漏了金丝雀句子的连续片段：" + hit);
}

/**
 * F1 已知边界用的原句（**验证代理的复现载荷**，逐字照抄）：
 * 34 字、无句末标点、连续表意文字 34 字 ≤ LOG_CJK_RUN_MAX(40) → 两级收敛都不触发，
 * 因此它会被**完整**留在本机日志里（这正是"本地层做不到绝不记正文"的实证）。
 */
const F1_TERM = "灯塔的看守人在第三块礁石上捡到一枚生锈的铜钥匙上面刻着两个模糊的名字";
const F1_WINDOWS = windowsOf(F1_TERM);
function assertNoLeak(text, label, windows = CANARY_WINDOWS) {
  const hit = leakOf(text, windows);
  assert.equal(hit, null, label + " 泄漏了连续片段：" + hit);
}

// ── 夹具书 ──────────────────────────────────────────────────────────────────
// 金丝雀**同时**出现在两处，各代表一类真实的泄漏途径：
//   ① 章节文件名（v5.0.0 起标题就写进文件名）→ 会被"同号建章"的报错消息带进 detail
//   ② 章节正文 → 正常读取路径（novel_read / 开写包 / 风格自检…）绝不该带进日志
// 注意：正文长度刻意 ≥ 40 字（diagnose 的"过短章节"清单会打印**文件名**，
// 那属于元数据节而非日志脱敏节——本夹具要避免这条无关路径干扰金丝雀断言，故写长一点）。
const CANARY_FILE = `第01章 ${CANARY_CORE}.md`;
function writeFixtureBook() {
  const dir = join(LIB, "novels", BOOK);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, CANARY_FILE), `# 第一章 ${CANARY_CORE}\n\n${CANARY_SENTENCE}\n\n${FILLER}\n\n${FILLER2}\n`, "utf8");
  writeFileSync(join(dir, "第02章 夜航.md"), `# 第二章 夜航\n\n${FILLER}\n\n${FILLER2}\n\n${FILLER}\n`, "utf8");
  writeFileSync(join(dir, "第03章 归途.md"), `# 第三章 归途\n\n${FILLER2}\n\n${FILLER}\n\n${FILLER2}\n`, "utf8");
}
writeFixtureBook();

// ===========================================================================
// 走真实 apply() 注册的真工具（不直连内部函数）
// ===========================================================================

const toolDefs = [];                                  // apply 注册的 20 个真工具
const probeDefs = new Map();                          // 测试后通过**审计包装**注册的合成探针
const routes = [];
let applyFinished = false;
let capturedAuditedRegister = null;                    // apply 期间从 tools.register 上"偷"到的审计包装
const originalRegister = function register(def) {
  if (applyFinished) probeDefs.set(def.name, def);
  else toolDefs.push(def);
  // 审计包装在 apply() 内部把 tools.register 换成了 auditedRegister；
  // 它调用 original 时 this=ctx.tools，此刻 this.register 就是那个包装函数 → 抓住它供后续合成探针用。
  if (!capturedAuditedRegister && this && typeof this.register === "function" && this.register !== originalRegister) {
    capturedAuditedRegister = this.register;
  }
  return () => {};
};
const CONFIG = { root: LIB, sentenceAnalysis: { enabled: true, autoAnalyze: false }, allowLanState: false };
const ctx = {
  tools: { register: originalRegister },
  systemPrompt: { section: () => () => {} },
  inject: (names, cb) => {
    if (names.includes("webServer")) {
      return cb({ webServer: { register: (r) => { routes.push(r); return () => {}; } }, effect: (fn) => fn() });
    }
    return cb({});   // skills 等：宿主无该服务 → 插件必须静默跳过
  }
};
apply(ctx, CONFIG);
applyFinished = true;
const defs = Object.fromEntries(toolDefs.map((d) => [d.name, d]));
const exec = { agent: { session: { header: { cwd: LIB } } } };

/** 用**审计包装**注册一个合成工具（apply 内部偷到的 auditedRegister） */
function registerProbe(name, execute) {
  assert.equal(typeof capturedAuditedRegister, "function", "没抓到审计包装函数（installToolAudit 可能没装上）");
  capturedAuditedRegister({ name, description: "合成探针", parameters: { type: "object", additionalProperties: false, properties: {} }, execute });
  const def = probeDefs.get(name);
  assert.ok(def, "合成探针未进注册表：" + name);
  return def;
}

// ── 日志读取小工具（一律读磁盘真值）────────────────────────────────────────
function rawLines(file) {
  try { return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== ""); } catch { return []; }
}
function tryJson(line) { try { return JSON.parse(line); } catch { return null; } }
function lastEvent() {
  const lines = rawLines(log.logFilePath());
  return lines.length === 0 ? null : tryJson(lines[lines.length - 1]);
}
function logFiles() {
  return [log.logFilePath(), ...Array.from({ length: log.LOG_KEEP_FILES }, (_, i) => join(log.logDir(), `events.${i + 1}.jsonl`))];
}
/** 磁盘真值：按 readLogEvents 的同一口径（有效 JSON + ts 可解析 + 窗口内）统计 */
function diskEvents(days = 7) {
  const since = Date.now() - days * 24 * 3600 * 1000;
  const out = [];
  for (const file of logFiles()) {
    for (const line of rawLines(file)) {
      const ev = tryJson(line);
      if (!ev || typeof ev !== "object" || !ev.ts) continue;
      const at = Date.parse(ev.ts);
      if (!Number.isFinite(at) || at < since) continue;
      out.push(ev);
    }
  }
  return out;
}
const diskToolCalls = (days = 7) => diskEvents(days).filter((ev) => ev.kind === "tool_call");
function lineCount(file) { return rawLines(file).length; }
/** 只数 tool_call：工具调用期间可能另有辅助事件（root_resolve / cache / silent_skip…），那不是"审计记录" */
function toolCallLines() { return rawLines(log.logFilePath()).filter((l) => tryJson(l)?.kind === "tool_call").length; }

/** 审计一致性：工具真实返回值 ↔ 日志里那条 tool_call（现算，不信实现） */
function assertAuditConsistent(label, out, ev, expectFail = false) {
  assert.ok(ev, label + "：调用后没有记到任何事件");
  assert.equal(ev.kind, "tool_call", label + "：事件 kind 应为 tool_call");
  const obj = out !== null && typeof out === "object" ? out : null;
  const degradedCount = Array.isArray(obj?.degraded) ? obj.degraded.length : 0;
  const expected = expectFail ? "failed" : obj && obj.ok === false ? "failed" : degradedCount > 0 ? "degraded" : "ok";
  assert.equal(ev.status, expected, `${label}：status 与返回体不符（返回 degraded=${degradedCount}、ok=${obj?.ok}）`);
  assert.equal(ev.degradedCount ?? 0, degradedCount, label + "：degradedCount 与返回体不符");
  if (expected === "failed" && obj) assert.equal(ev.code, String(obj.error ?? "").slice(0, 80), label + "：code 与 ok:false 的 error 不符");
  assert.ok(Number.isFinite(ev.ms) && ev.ms >= 0, label + "：ms 应为非负数字");
  assert.ok(Object.keys(ev).every((k) => log.ALLOWED_KEYS.includes(k)), label + "：事件含白名单外的键 " + Object.keys(ev).join(","));
  return ev;
}
/** 调一次真工具：执行 + 取"最后写下的那条事件"（append 顺序确定，不靠 ts 排序） */
async function callLogged(name, args) {
  const before = toolCallLines();
  const out = await defs[name].execute(args, exec);
  const ev = lastEvent();
  // 只数 kind==="tool_call"：一次调用期间**允许**另有辅助事件（root_resolve / cache / silent_skip / config…），
  // 它们不是审计记录（见 ⑨-f 对"多出来的那条"的正面断言）
  assert.equal(toolCallLines(), before + 1, `${name}：一次调用应恰好记一条 tool_call`);
  return { out, ev: assertAuditConsistent(name, out, ev) };
}
/** 调一次真工具并**期望它抛错**：失败的调用同样必须恰好记一条 tool_call */
async function callLoggedErr(name, args) {
  const before = toolCallLines();
  const err = await captureErr(() => defs[name].execute(args, exec));
  assert.ok(err instanceof Error, `${name}：本用例期望抛错，实际没抛`);
  assert.equal(toolCallLines(), before + 1, `${name}：失败的调用也必须恰好记一条 tool_call`);
  return { err, ev: assertAuditConsistent(name, null, lastEvent(), true) };
}
async function captureErr(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}
/** 通用 schema 遍历：返回键 ⊆ output.schema.properties（additionalProperties:false 的宿主会整条拒收） */
function assertKeysDeclared(label, def, result) {
  const props = new Set(Object.keys(def.output.schema.properties));
  const extra = Object.keys(result ?? {}).filter((k) => !props.has(k));
  assert.deepEqual(extra, [], `${label} 返回了未登记字段（additionalProperties:false 的宿主会整条拒收）`);
  for (const key of def.output.schema.required) {
    assert.ok(key in (result ?? {}), `${label} 缺必填字段：${key}`);
  }
}

// ===========================================================================
// ① 落点与常量
// ===========================================================================

test("① log 落点：logs/ 紧邻 state.json，而不是书库根；常量形状合法", () => {
  assert.equal(stateFilePath(), STATE, "stateFilePath 必须惰性读 DSH_NOVEL_WRITER_STATE（隔离前提）");
  assert.equal(dirname(log.logDir()), dirname(stateFilePath()), "契约：dirname(logDir()) === dirname(stateFilePath())");
  assert.equal(log.logFilePath(), join(log.logDir(), "events.jsonl"));
  assert.ok(log.logDir().startsWith(STATE_DIR), "日志目录应落在隔离状态目录内：" + log.logDir());
  assert.ok(!log.logDir().startsWith(LIB), "契约③：日志**不得**落在书库根内（书库根不对时那里根本不可写）");
  assert.notEqual(log.logDir(), join(LIB, ".novel-writer", "logs"), "落点不是书库根的 .novel-writer/");

  assert.equal(log.LOG_MAX_BYTES, 512 * 1024);
  assert.equal(log.LOG_KEEP_FILES, 3);
  for (const [name, value] of [["LOG_MAX_EVENT_BYTES", log.LOG_MAX_EVENT_BYTES], ["LOG_FREE_TEXT_MAX", log.LOG_FREE_TEXT_MAX], ["LOG_CJK_RUN_MAX", log.LOG_CJK_RUN_MAX]]) {
    assert.ok(Number.isFinite(value) && value > 0, name + " 应为正数");
  }
  assert.ok(Array.isArray(log.LOG_KINDS) && log.LOG_KINDS.includes("tool_call"));
  assert.ok(Object.isFrozen(log.ALLOWED_KEYS) && Object.isFrozen(log.FORBIDDEN_KEYS) && Object.isFrozen(log.LOG_KINDS), "三张表应冻结");
  // 纵深防御不变式：黑名单不得与白名单重叠（否则黑名单就成了唯一防线）
  const overlap = log.FORBIDDEN_KEYS.filter((k) => log.ALLOWED_KEYS.includes(k));
  assert.deepEqual(overlap, [], "FORBIDDEN_KEYS 与 ALLOWED_KEYS 不得重叠：" + overlap.join(","));

  const stats = log.logStats();
  assert.equal(stats.dir, log.logDir());
  // 现算：files[].bytes 必须等于磁盘真值，bytes 必须等于各文件之和
  let sum = 0;
  for (const row of stats.files) { assert.equal(row.bytes, statSync(row.file).size, "logStats 的字节数与磁盘不符：" + row.file); sum += row.bytes; }
  assert.equal(stats.bytes, sum);
  assert.equal(stats.exists, stats.files.length > 0);
});

// ===========================================================================
// ② 字段白名单 / ④ 自由文本收敛
// ===========================================================================

test("② sanitizeLogData：白名单之外一律丢弃（正文/对象值/未知键），数组只留标量", () => {
  const dirty = {
    ts: new Date().toISOString(), kind: "tool_call", tool: "t", status: "ok",
    // 黑名单里的名字（正文最可能藏身处）
    content: "正文", text: "正文", body: "正文", excerpt: "正文", raw: "正文",
    summary: "摘要", report: "报告", prompt: "提示词", terms: ["词"], entries: [], anchors: [], skeletons: [],
    // 白名单之外
    unknownKey: "nope", Tool: "大小写不匹配", BOOK: "x",
    // 对象值（对象/函数/符号一律丢）
    root: { path: "/x" }, list: [1, 2], fn: () => 1, sym: Symbol("s"), big: 10n,
    // 数组里只允许标量（files 是白名单里的数组键）
    files: ["a.md", { x: 1 }, "b.md", null],
    // 数字边界
    count: 3, bytes: 0, ms: NaN, bytes2: Infinity, bytes3: -Infinity,
    // 空值
    level: "", note: null, detail: void 0,
    // 白名单之外的数组键：**整体丢弃**（白名单对数组键同样生效）
    bigArr: Array.from({ length: 25 }, (_, i) => "item" + i)
  };
  const clean = log.sanitizeLogData(dirty);
  for (const key of log.FORBIDDEN_KEYS) assert.ok(!(key in clean), "黑名单键漏进白名单净化：" + key);
  for (const key of ["unknownKey", "Tool", "BOOK", "root", "list", "fn", "sym", "big", "bytes2", "bytes3", "level", "note", "detail", "bigArr"]) {
    assert.ok(!(key in clean), "白名单之外的键未被丢弃：" + key);
  }
  assert.deepEqual(clean.files, ["a.md", "b.md"], "数组里的对象/null 应被丢弃");
  assert.equal(clean.count, 3);
  assert.equal(clean.bytes, 0, "0 是合法数字，不能当空值丢掉");
  assert.ok(!("ms" in clean), "NaN 应被丢弃");
  assert.equal(clean.ts, dirty.ts);
  assert.ok(Object.keys(clean).every((k) => log.ALLOWED_KEYS.includes(k)));

  // 数组上限 20 项：用**白名单里的数组键**（files）验，未知键验不了（它先被整体丢掉）
  const capped = log.sanitizeLogData({ files: Array.from({ length: 25 }, (_, i) => "f" + i) });
  assert.equal(capped.files.length, 20, "数组应截到 20 项");
  assert.equal(capped.files[19], "f19");

  // 非对象入参不炸
  assert.deepEqual(log.sanitizeLogData(null), {});
  assert.deepEqual(log.sanitizeLogData(void 0), {});
  assert.deepEqual(log.sanitizeLogData("正文"), {});
  assert.deepEqual(log.sanitizeLogData([1, 2]), {});
});

test("④ 自由文本收敛：按第一句末标点截断、长度有上限、长中文串另收；标量 200 字上限", () => {
  // 成句 → 只留第一句之前
  assert.equal(log.sanitizeLogData({ detail: "第一句结束。第二句不该出现。" }).detail, "第一句结束…");
  assert.equal(log.sanitizeLogData({ note: "保留到问号？后面都不要" }).note, "保留到问号…");
  // 换行/多余空白压平
  assert.equal(log.sanitizeLogData({ note: "a\n\nb\tc" }).note, "a b c");
  // 长度上限（ASCII：不触发长中文串规则）
  assert.equal(log.sanitizeLogData({ detail: "a".repeat(300) }).detail.length, log.LOG_FREE_TEXT_MAX + 1);
  assert.equal(log.sanitizeLogData({ detail: "a".repeat(300) }).detail, "a".repeat(log.LOG_FREE_TEXT_MAX) + "…", "超长 ASCII 自由文本应恰好截到上限 + 省略号");
  // 长中文串（无标点正文最可能的形态）→ 收敛到 LOG_CJK_RUN_MAX
  assert.equal(log.sanitizeLogData({ note: "字".repeat(300) }).note.length, log.LOG_CJK_RUN_MAX + 1);
  // 非自由文本标量：200 字上限
  assert.equal(log.sanitizeLogData({ book: "b".repeat(300) }).book.length, 201);
  // 金丝雀句子：本地层保留"到第一句末"为止，但绝不是原文
  const clamped = log.sanitizeLogData({ detail: CANARY_SENTENCE }).detail;
  assert.ok(clamped.includes(CANARY_CORE), "本地层应保留第一句");
  assert.ok(clamped.endsWith("…"));
  assert.notEqual(clamped, CANARY_SENTENCE);

  // ── 契约来源（⑧）：`clampFreeText`（lib/log.js）＝ 换行压平 → SENTENCE_END 截断 →
  //    LOG_FREE_TEXT_MAX(160) 截断 → LOG_CJK_RUN_MAX(40) 截断。**本条断言的是"收敛规则"，
  //    不是"本地层里没有正文"**——后者不可能成立，见下面 F1 边界那三行。
  //    （"本地层无正文"曾经是本文件的直觉，也是 F1 没被自己的测试抓住的原因：
  //      只查一个 17 字核心/整句，34 字的原句片段就能穿过去。）
  // ── F1 已知边界（协调方判定：**不收紧本地层**，只改口径）──
  //    无句末标点、连续表意文字 ≤40 字的一句会被**完整保留**：
  assert.equal(F1_TERM.length, 34);
  // 窗口表自身必须非空、且真的抓得住片段（否则 ⑤-d 的"零命中"是空话）：
  assert.ok(F1_WINDOWS.length > 100, "F1 窗口表应有数百个 ≥6 字窗口，实测 " + F1_WINDOWS.length);
  const selfCheck = leakOf("前缀" + F1_TERM.slice(0, 8) + "后缀", F1_WINDOWS);
  assert.ok(selfCheck && selfCheck.length >= 6 && F1_TERM.includes(selfCheck),
    "窗口表必须能抓住 8 字片段（自证断言不是空的），实测命中 " + JSON.stringify(selfCheck));
  assert.equal(log.sanitizeLogData({ detail: F1_TERM }).detail, F1_TERM,
    "F1 边界：无标点的单句（34 字 ≤ 160）会被完整保留——本地层至多保留一句，这是契约的实话");
  assert.equal(log.sanitizeLogData({ detail: F1_TERM }).detail.length, 34);
  //    而它**一旦带句末标点**就会被截断（同一条规则的另一半）：
  assert.equal(log.sanitizeLogData({ detail: F1_TERM + "。" }).detail, F1_TERM + "…");
});

// ===========================================================================
// ③ 参数摘要
// ===========================================================================

test("③ summarizeArgs：只取定位字段 + content/text 的长度，绝不取内容", () => {
  const args = {
    book: BOOK, chapter: 3, action: "add", mode: "compact", scope: "all", root: LIB,
    file: "f.md", path: "p", name: "n",
    content: CANARY_SENTENCE, text: "敏感文本", src: LIB, files: ["a", "b"], chapters: [1, 2, 3], terms: ["t1", "t2"],
    title: "不在名单里", summary: "不在名单里"
  };
  const sum = log.summarizeArgs(args);
  assert.deepEqual(Object.keys(sum).sort(), [
    "action", "book", "chapter", "chaptersCount", "contentChars", "file", "filesCount",
    "mode", "name", "path", "root", "scope", "srcChars", "termsCount", "textChars"
  ]);
  assert.equal(sum.contentChars, CANARY_SENTENCE.length, "content 只记长度（现算）");
  assert.equal(sum.textChars, "敏感文本".length);
  assert.equal(sum.filesCount, 2);
  assert.equal(sum.chaptersCount, 3);
  assert.equal(sum.termsCount, 2);
  for (const key of ["content", "text", "src", "files", "chapters", "terms", "title", "summary"]) {
    assert.ok(!(key in sum), "摘要里不得出现 " + key);
  }
  assert.equal(canaryLeak(JSON.stringify(sum)), null, "参数摘要里不得有正文片段");

  // 非标量定位字段直接跳过；非对象入参 → {}
  assert.deepEqual(log.summarizeArgs({ book: {}, chapter: [], action: () => {} }), {});
  // 加强（弱断言④）：上面那条"返回 {}"可能只是因为函数**什么都没做**——同一入参里放一个合法
  // 定位字段，断言它仍然活着，才能证明被丢掉的确实是"非标量值"而不是整份入参。
  assert.deepEqual(log.summarizeArgs({ name: "合法定位字段", book: {}, chapter: [], action: () => {} }), { name: "合法定位字段" });
  assert.deepEqual(log.summarizeArgs(null), {});
  assert.deepEqual(log.summarizeArgs("x"), {});
  // 定位字段自身也收敛到 200 字
  assert.equal(log.summarizeArgs({ root: "r".repeat(300) }).root.length, 201);
});

// ===========================================================================
// ⑤ 两级隐私（单元层）
// ===========================================================================

test("⑤ 两级隐私：本地层留自由文本（已截断），分享层整体剔除 + redacted 标记", async () => {
  log.logEvent("tool_call", { tool: "probe_share", status: "failed", note: CANARY_SENTENCE, detail: CANARY_SENTENCE, suggestion: CANARY_SENTENCE });
  log.logEvent("tool_call", { tool: "probe_bare", status: "ok" });

  const local = (await log.readLogEvents({ limit: 2000, forShare: false })).filter((e) => e.tool === "probe_share");
  const share = (await log.readLogEvents({ limit: 2000, forShare: true })).filter((e) => e.tool === "probe_share");
  assert.equal(local.length, 1);
  assert.equal(share.length, 1);
  const [l] = local;
  const [s] = share;
  for (const key of ["note", "detail", "suggestion"]) assert.ok(key in l, "本地层应保留 " + key);
  for (const key of ["note", "detail", "suggestion"]) assert.ok(!(key in s), "分享层必须剔除 " + key);
  assert.equal(s.redacted, true, "分享层应带 redacted 标记");
  assert.equal(s.tool, "probe_share");
  assert.equal(s.status, "failed");
  assert.equal(s.kind, "tool_call");
  assert.ok(typeof s.ts === "string" && Number.isFinite(Date.parse(s.ts)), "时间戳属于结构性字段，必须保留");
  assert.ok(Object.keys(s).every((k) => log.ALLOWED_KEYS.includes(k) || k === "redacted"));
  assert.ok(l.detail.includes(CANARY_CORE));
  assertNoCanary(JSON.stringify(s), "readLogEvents({forShare:true})");
  assertNoCanary(JSON.stringify(share), "readLogEvents({forShare:true}) 全量");

  // 加强（弱断言⑤-a）：**任意 ≥6 字连续窗口**逐条检查，而不是只看拼起来的整串——
  // 整串没有命中只说明"没有一整段连续泄漏"，逐条才排除"字段边界把窗口切开"的假阴性。
  for (const ev of share) {
    assertNoCanary(JSON.stringify(ev), "分享层逐条事件 " + ev.tool);
  }

  // 加强（弱断言⑤-b）：**失败路径必须一起测**。正文实际是被**报错消息回显**带进自由文本的
  // （真实形状见 ⑤-c 的三条探针：novel_lexicon 把用户传入的 term 回显进 message → 审计写进
  // detail），只测成功路径等于没测。这里合成一条形状相同的事件：
  log.logEvent("tool_call", {
    tool: "probe_failpath", status: "failed", code: "E_NOT_FOUND",
    detail: "词表中找不到词条「" + F1_TERM + "」（用 action=list 查看现有词条）"
  });
  const failLocal = (await log.readLogEvents({ limit: 2000, forShare: false })).filter((e) => e.tool === "probe_failpath");
  assert.equal(failLocal.length, 1, "失败路径的事件应被记下");
  // 本地层**会**保留这句（至多一句 / ≤160 字）——F1 已知边界，如实断言（旧文案说"绝不写正文"✗）
  assert.ok(failLocal[0].detail.includes(F1_TERM), "本地层保留自由文本＝F1 已知边界（协调方判定不收紧本地层）");
  assert.ok(failLocal[0].detail.length <= log.LOG_FREE_TEXT_MAX + 1, "本地层自由文本仍受 160 字上限约束");
  const failShare = (await log.readLogEvents({ limit: 2000, forShare: true })).filter((e) => e.tool === "probe_failpath");
  assert.equal(failShare.length, 1, "失败路径的事件在分享层也必须还在（只是被剔除自由文本）");
  assert.equal(failShare[0].code, "E_NOT_FOUND", "分享层保留结构性字段 code");
  assert.equal(failShare[0].status, "failed", "分享层保留结构性字段 status");
  assertNoLeak(JSON.stringify(failShare), "分享层·失败路径事件", F1_WINDOWS);
  assertNoLeak(JSON.stringify(await log.readLogEvents({ limit: 2000, forShare: true })), "分享层·全量（含失败路径）", F1_WINDOWS);

  // v6.6.0 修正后：无自由文本的事件**也带** redacted 标记（标记是"层级"标志，不是"有内容"标志）
  const bare = (await log.readLogEvents({ forShare: true, tool: "probe_bare" }))[0];
  assert.ok(bare, "probe_bare 应被读到");
  assert.equal(bare.redacted, true, "分享层事件**恒带** redacted（v6.6.0 修正：无条件标记，读取方才能区分「已脱敏」与「来自本地层」）");
});

test("⑤-b forShare 的严格性：只有显式 false 才返回本地层，其余一律脱敏（v6.6.0 修正为 fail-closed）", async () => {
  // 契约（现有实现）：`readLogEvents` 里是 `if (opts.forShare === false) return limited;`
  // —— 只有**显式传 false** 才拿到带自由文本的本地层，其余（`1` / `"true"` / `{}` / 忘传）
  // 一律按分享层处理。**旧写法是 `!== true 就返回本地层`（fail-open）**，一个真值非 true 的
  // 标志会让调用方静默拿到全量自由文本——隐私边界上的默认值必须偏向"少给"。
  // 注释与断言必须同口径：本注释描述的**不是**当前实现，而是被替换掉的旧实现（留作回归说明）。
  const viaTruthy = (await log.readLogEvents({ tool: "probe_share", forShare: 1 }))[0];
  assert.ok(!("detail" in viaTruthy), "forShare:1 必须脱敏（fail-closed：边界默认值偏向少给，传 1/\"true\"/忘传都按分享层处理）");
  const viaTrue = (await log.readLogEvents({ tool: "probe_share", forShare: true }))[0];
  assert.ok(!("detail" in viaTrue));
  const viaEmpty = (await log.readLogEvents({ tool: "probe_share" }))[0];
  assert.ok(!("detail" in viaEmpty), "忘传 forShare 也必须脱敏");
  assert.equal(viaEmpty.redacted, true, "分享层恒带 redacted，读取方才能自证走过哪一层");
  const viaExplicitFalse = (await log.readLogEvents({ tool: "probe_share", forShare: false }))[0];
  assert.ok("detail" in viaExplicitFalse, "只有显式 false 才返回本地层（本地调试的唯一入口）");
});

// ===========================================================================
// ⑦ 读侧容错 + 历史文件再净化
// ===========================================================================

test("⑦ 读侧容错：坏行跳过不崩；历史文件读取时再净化一遍", async () => {
  const now = new Date().toISOString();
  const rotated = join(log.logDir(), "events.1.jsonl");
  // 历史文件（模拟旧版本写入：带 content/text/未知键/对象值）
  writeFileSync(rotated, [
    JSON.stringify({ ts: now, kind: "internal", tool: "hist_old", content: CANARY_SENTENCE, text: "SENSITIVE_TEXT", unknownKey: "UNKNOWN_KEY", root: { path: "OBJECT_VALUE" }, note: CANARY_SENTENCE })
  ].join("\n") + "\n", "utf8");
  // 当前文件：截断行 + 非 JSON 行 + 合法的脏 tool_call 行
  writeFileSync(log.logFilePath(), [
    '{"ts":"' + now + '","kind":"internal","tool":"hist_trunc"',
    "not-json-at-all",
    JSON.stringify({ ts: now, kind: "tool_call", tool: "hist_toolcall", status: "ok", detail: CANARY_SENTENCE })
  ].join("\n") + "\n", "utf8");

  // 前置：文件里确实有这些脏数据（否则下面的断言是空的）
  const rawRotated = readFileSync(rotated, "utf8");
  assert.ok(rawRotated.includes("SENSITIVE_TEXT") && rawRotated.includes("UNKNOWN_KEY") && rawRotated.includes('"content"'));
  assert.ok(readFileSync(log.logFilePath(), "utf8").includes("not-json-at-all"));

  const evs = await log.readLogEvents({ limit: 500, forShare: false });     // 不崩
  const old = evs.find((e) => e.tool === "hist_old");
  assert.ok(old, "历史文件里的合法行应被读到");
  for (const key of ["content", "text", "unknownKey", "root"]) assert.ok(!(key in old), "历史文件读取时必须再净化，漏了 " + key);
  assert.ok(old.note.includes(CANARY_CORE), "本地层仍保留自由文本（已截断）");
  assert.ok(!evs.some((e) => e.tool === "hist_trunc"), "截断行应被跳过");
  assert.ok(evs.some((e) => e.tool === "hist_toolcall"), "同文件里的合法行不应被坏行连累");

  const share = await log.readLogEvents({ limit: 500, forShare: true });
  assert.ok(!JSON.stringify(share).includes("SENSITIVE_TEXT"), "历史文件里的 text 不得出现在分享层");
  assertNoCanary(JSON.stringify(share), "历史文件的 forShare 层");
});

test("⑦-b 超长事件：单行不超过 LOG_MAX_EVENT_BYTES，且**永远是一整行合法 JSON**（F3 契约）", async () => {
  const fat = {};
  for (const key of log.ALLOWED_KEYS) fat[key] = "x".repeat(200);
  log.logEvent("engine", { ...fat, tool: "big_probe" });
  const line = rawLines(log.logFilePath()).at(-1);
  assert.ok(line.length <= log.LOG_MAX_EVENT_BYTES, "单行长度应受 LOG_MAX_EVENT_BYTES 约束，实测 " + line.length);
  await assert.doesNotReject(() => log.readLogEvents({ limit: 100 }));
  const evs = await log.readLogEvents({ limit: 100 });
  const parsed = tryJson(line);
  // F3（协调方修，⑦-c 是它的回归测试）：**不再接受"半行"**。旧实现 `delete event.detail;
  // line = JSON.stringify(event).slice(0, LOG_MAX_EVENT_BYTES)` 会把 JSON 拦腰截断，
  // 读侧把解析不了的行当损坏行跳过 → **整条事件从诊断里消失**（比"被截断"更糟：
  // 读取方看到的是"什么都没发生"）。所以这里改为硬断言：落盘行必须是合法 JSON。
  assert.ok(parsed, "超长事件的落盘行必须是合法 JSON（F3：不得写出半行；旧实现会在这里红）");
  assert.ok(evs.some((e) => e.tool === "big_probe"), "合法行必须被读到（不得因为超长而消失）");
  assert.equal(parsed.truncated, true, "被裁过的事件必须带 truncated 标记");
  console.log("   [超长事件] 落盘行 " + line.length + " 字符｜合法 JSON ✓｜truncated=" + parsed.truncated + "｜字段数 " + Object.keys(parsed).length);
});

test("⑦-c F3 回归：全字段撑满的载荷（> LOG_MAX_EVENT_BYTES）必须落成完整 JSON 行、能被读回、带 truncated", async () => {
  // 为什么要单列一条：⑦-b 的载荷虽然也超限，但本条的载荷形状更贴近真实"病态输入"
  // （每个自由文本字段顶到 160 字上限、20 个长数组项、多个长定位字段）。
  // ⚠ 教训（协调方第一版测试栽在这里）：载荷**必须真的超过 LOG_MAX_EVENT_BYTES**，
  //    否则测不到 F3 那条分支——下面第一段就是"前置非空"断言，先证明这道门是真的。
  await log.clearLogs();                      // ⑦ 故意往文件里写过坏行，这里要的是"干净文件 + 多行真值"
  const payload = {
    tool: "fat_probe", status: "failed", code: "E_FAT", level: "warn",
    // 自由文本三键（各自 300 字 → 收敛到 160 / 40 字上限）
    detail: "x".repeat(300), note: "y".repeat(300), suggestion: "字".repeat(300),
    // 长定位字段
    book: "长书名".repeat(80), chapter: "长章号".repeat(80), path: "p".repeat(300), file: "f".repeat(300),
    name: "n".repeat(300), scope: "s".repeat(300), root: "r".repeat(300), action: "a".repeat(300),
    mode: "m".repeat(300), rootSource: "rootSource".repeat(40), source: "src".repeat(80),
    // 20 个长数组项（sanitizeLogData 的数组上限就是 20）
    files: Array.from({ length: 20 }, (_, i) => "file-" + i + "-" + "w".repeat(300)),
    // 结构性字段
    ms: 999, count: 20, degradedCount: 3, bytes: 4096, contentChars: 12345, version: "6.6.0", plugin: "dsh-novel-writer"
  };
  const sanitized = log.sanitizeLogData({ ...payload, kind: "engine" });
  const wouldBe = JSON.stringify(sanitized).length;
  assert.ok(wouldBe > log.LOG_MAX_EVENT_BYTES,
    "前置：本载荷收敛后必须仍超过 LOG_MAX_EVENT_BYTES（实测 " + wouldBe + " ≤ " + log.LOG_MAX_EVENT_BYTES +
    "）——载荷不够大时 F3 分支根本不会被触发，这条测试会退化成空转");
  assert.ok(sanitized.files.length === 20 && sanitized.files[0].length === 201, "前置：20 项数组确实按 200 字上限收敛了（实测 " + sanitized.files.length + " 项 / " + sanitized.files[0].length + " 字）");

  log.logEvent("engine", { tool: "normal_probe", status: "ok", ms: 1 });   // 陪跑的正常行（多行真值）
  log.logEvent("engine", payload);

  // ③ 整个日志文件**每一行**都是合法 JSON（没有半行）
  const lines = rawLines(log.logFilePath());
  assert.ok(lines.length >= 2, "前置：文件里应有多行（陪跑的正常行 + 超长行，实测 " + lines.length + "）");
  const bad = lines.map((l, i) => [i + 1, l]).filter(([, l]) => tryJson(l) === null);
  assert.deepEqual(bad.map(([n]) => n), [], "F3 回归：日志里出现了不是合法 JSON 的行（半行）——第 " + bad.map(([n]) => n).join("、") + " 行");

  // ② 落到盘上的是**完整** JSON 行，且带 truncated 标记
  const line = lines.at(-1);
  assert.ok(line.length <= log.LOG_MAX_EVENT_BYTES, "单行仍受上限约束，实测 " + line.length);
  const parsed = tryJson(line);
  assert.ok(parsed, "超长事件必须写成完整 JSON 行（旧实现 slice 出半行 → 读侧跳过 → 事件消失）");
  assert.equal(parsed.kind, "engine");
  assert.equal(parsed.tool, "fat_probe", "骨架必须保住 tool（否则这条事件查不出是谁写的）");
  assert.equal(parsed.truncated, true, "被裁过必须显式置 truncated（否则读取方把「字段被丢」读成「本来就没有」）");

  // ① 能被读回（不消失）——这是 F3 修复的**目的**
  const evs = await log.readLogEvents({ limit: 200, forShare: false });
  const back = evs.find((e) => e.tool === "fat_probe");
  assert.ok(back, "超长事件必须能被 readLogEvents 读回（旧实现里它从诊断里凭空消失）");
  assert.equal(back.truncated, true, "读回的事件仍带 truncated");
  const normal = evs.find((e) => e.tool === "normal_probe");
  assert.ok(normal, "陪跑的正常事件也应在（截断不得连累同文件其它行）");
  assert.ok(!("truncated" in normal), "正常事件不该带 truncated（标记必须只在真被裁时出现）");
  // 逐级丢弃的顺序：第一级丢自由文本与定位字段（它们是"信息量最低"的那批）
  for (const key of ["detail", "note", "suggestion", "files", "path", "file", "name", "scope", "root"]) {
    assert.ok(!(key in back), "第一级应丢掉 " + key);
  }
  console.log("   [F3 回归] 收敛后 " + wouldBe + " 字节 → 落盘 " + line.length + " 字节｜保留字段 " + Object.keys(back).join(",") + "｜读回 ✓");
});

// ===========================================================================
// ⑧ 绝不抛错
// ===========================================================================

test("⑧ 绝不抛错：状态目录不可写/盘不存在时，写入与读取仍不得抛；首次失败只提示一次", async () => {
  const blocker = join(ROOT, "blocker-file");
  writeFileSync(blocker, "不是目录", "utf8");
  const saved = process.env.DSH_NOVEL_WRITER_STATE;
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...a) => { warns.push(String(a[0] ?? "")); };
  try {
    process.env.DSH_NOVEL_WRITER_STATE = join(blocker, "state.json");   // 父路径是文件 → mkdir 必失败
    assert.doesNotThrow(() => log.logEvent("tool_call", { tool: "unwritable", detail: "x" }));
    assert.doesNotThrow(() => log.logEvent(null));
    assert.doesNotThrow(() => log.logEvent("internal", null));
    assert.doesNotThrow(() => log.logEvent("internal", { get note() { throw new Error("getter boom"); } }));
    assert.doesNotThrow(() => log.logEvent("internal", { ms: 10n, tool: "bigint" }));
    assert.doesNotThrow(() => log.logEvent("internal", { tool: "x", detail: "y" }));
    const stats = log.logStats();
    assert.equal(stats.exists, false, "不可写时 logStats 应如实说 exists=false");
    assert.doesNotThrow(() => log.summarizeArgs({ content: CANARY_SENTENCE }));
    await assert.doesNotReject(() => log.readLogEvents({}));
    await assert.doesNotReject(() => log.clearLogs());

    const zPath = "Z:\\__dsh_no_such_drive__\\state.json";
    if (!existsSync("Z:\\")) {
      process.env.DSH_NOVEL_WRITER_STATE = zPath;
      assert.doesNotThrow(() => log.logEvent("tool_call", { tool: "no-drive" }));
      await assert.doesNotReject(() => log.readLogEvents({}));
      console.log("   [不可写路径] 父路径是文件 + 不存在的盘（Z:）两种场景均未抛错");
    }
  } finally {
    console.warn = originalWarn;
    process.env.DSH_NOVEL_WRITER_STATE = saved;
  }
  assert.ok(warns.length <= 1, "首次失败提示应只打一次，实测 " + warns.length + " 次");
  assert.ok(warns.length >= 1, "日志写入失败时应有一次性提示（否则无从知晓）");
  assert.ok(warns[0].includes("dsh-novel-writer"), "提示文案应带插件前缀：" + warns[0]);
});

// ===========================================================================
// ⑨ 注册层审计包装
// ===========================================================================

test("⑨ 审计包装装上且注册完立刻还原（不留副作用）", () => {
  assert.equal(typeof capturedAuditedRegister, "function", "apply 期间应能观察到被替换的 register");
  assert.equal(ctx.tools.register, originalRegister, "注册完必须还原 register（否则宿主侧有残留副作用）");
  assert.equal(toolDefs.length, ALL_TOOLS.length, `apply 应注册 ${ALL_TOOLS.length} 个工具，实测 ${toolDefs.length}`);
  assert.equal(new Set(toolDefs.map((d) => d.name)).size, toolDefs.length, "工具名不得重复");
});

test("⑨-b 真实工具调用：一条 tool_call，status/degradedCount/ms/参数摘要与返回体一致", async () => {
  await log.clearLogs();
  const { out, ev } = await callLogged("novel_books", { root: LIB });
  assert.equal(ev.tool, "novel_books");
  assert.equal(ev.root, LIB, "参数摘要应带上定位字段 root");
  assert.ok(!("detail" in ev) && !("code" in ev), "成功调用不该有 detail/code（空值被净化层丢掉）");
  assert.ok(!("content" in ev) && !("text" in ev));
  assert.ok(Array.isArray(out.books) && out.books.length >= 1, "夹具书应被列出");

  const { ev: ev2 } = await callLogged("novel_read", { book: BOOK, chapter: "1", root: LIB });
  assert.equal(ev2.status, "ok");
  assert.equal(ev2.book, BOOK, "参数摘要应带上 book/chapter");
  assert.equal(ev2.chapter, "1");
});

test("⑨-c 三态判定：成功→ok、degraded 非空→degraded、ok:false→failed、抛异常→failed", async () => {
  const bad = await callLoggedErr("novel_read", { book: "不存在的书XYZ", chapter: "1", root: LIB });
  assert.ok(String(bad.err.message).includes("未找到作品目录"));
  assert.equal(bad.ev.tool, "novel_read");
  assert.equal(bad.ev.status, "failed");
  assert.ok(String(bad.ev.detail ?? "").includes("未找到作品目录"), "本地层 detail 应保留错误原文（分享层再剔除）");

  const PROBE_OBJ = { marker: "identity", nested: { a: 1 } };
  const PROBE_ERR = Object.assign(new Error("合成异常：审计必须原样抛出"), { code: "E_PROBE_BOOM" });
  registerProbe("probe_ok", async () => ({ ok: true, value: 1 }));
  registerProbe("probe_degraded", async () => ({ ok: true, degraded: ["d1", "d2"] }));
  registerProbe("probe_failed", async () => ({ ok: false, error: "E_PROBE_FAIL" }));
  registerProbe("probe_throw", async () => { throw PROBE_ERR; });
  registerProbe("probe_type_throw", async () => { throw Object.assign(new TypeError("类型探针"), { code: 42 }); });
  registerProbe("probe_void", async () => void 0);
  registerProbe("probe_identity", async () => PROBE_OBJ);

  const cases = [
    ["probe_ok", "ok", 0],
    ["probe_degraded", "degraded", 2],
    ["probe_failed", "failed", 0]
  ];
  for (const [name, status, degradedCount] of cases) {
    const out = await probeDefs.get(name).execute({}, exec);
    const ev = lastEvent();
    assert.equal(ev.tool, name);
    assert.equal(ev.status, status, `${name} 的 status 应为 ${status}`);
    assert.equal(ev.degradedCount ?? 0, degradedCount, `${name} 的 degradedCount 应为 ${degradedCount}`);
  }
  assert.equal(lastEvent().code, "E_PROBE_FAIL", "ok:false 的 error 应作为 code 落盘");

  // 抛异常：三态为 failed，code/detail 取自异常
  const boom = await captureErr(() => probeDefs.get("probe_throw").execute({}, exec));
  const evThrow = lastEvent();
  assert.equal(evThrow.status, "failed");
  assert.equal(evThrow.code, "E_PROBE_BOOM");
  assert.ok(String(evThrow.detail).includes("合成异常"));

  // 返回非对象（undefined）→ ok，且返回值原样
  const voidOut = await probeDefs.get("probe_void").execute({}, exec);
  assert.equal(voidOut, void 0);
  assert.equal(lastEvent().status, "ok");

  // 返回值**同一引用**（审计不得克隆/包装返回值）
  const identityOut = await probeDefs.get("probe_identity").execute({}, exec);
  assert.equal(identityOut, PROBE_OBJ, "审计必须原样返回工具返回值（同一引用）");
  assert.equal(identityOut.nested.a, 1);
});

test("⑨-d 异常原样抛出：与不装审计时逐字段一致，且是同一个对象引用", async () => {
  // 不装审计的对照组：把 register 设为不可写 —— 模拟"宿主把 register 设成只读"（铁律①的逃生口）
  const rawRegistry = [];
  const rawTools = {};
  Object.defineProperty(rawTools, "register", {
    value: (d) => { rawRegistry.push(d); return () => {}; }, writable: false, configurable: true, enumerable: true
  });
  apply({ tools: rawTools, systemPrompt: { section: () => () => {} }, inject: () => {} }, CONFIG);
  assert.equal(rawRegistry.length, ALL_TOOLS.length, "包裹失败也必须完成注册（不影响功能）");
  const rawDefs = Object.fromEntries(rawRegistry.map((d) => [d.name, d]));
  assert.notEqual(rawDefs.novel_read.execute, defs.novel_read.execute, "对照组不该是同一个 execute（说明审计确实没装上）");

  // v6.6.0：包裹失败必须留痕 —— 否则"整场会话的 tool_call 审计静默关闭"在日志里表现为"什么都没有"，
  // 而读取方会把"没有记录"读成"没有发生"（这是最需要记的一处）
  const trace = (await log.readLogEvents({ limit: 100, kind: "internal", forShare: false })).find((e) => e.tool === "installToolAudit");
  assert.ok(trace, "宿主只读 register 时应留一条 internal 事件说明审计已关闭");
  assert.equal(trace.status, "failed");
  assert.ok(String(trace.detail ?? "").includes("tools.register"), "留痕应点名原因");
  console.log("   [审计降级] 宿主只读 register → 注册照常（20 个）+ 留痕：" + String(trace.detail).slice(0, 40) + "…");

  // 对照组调用不写 tool_call
  await log.clearLogs();
  const before = toolCallLines();
  const rawErr = await captureErr(() => rawDefs.novel_read.execute({ book: "不存在的书XYZ", chapter: "1", root: LIB }, exec));
  assert.equal(toolCallLines(), before, "未装审计时不应写 tool_call（宿主只读 register 的降级路径）");
  // 加强（弱断言⑨）：原来只有 `assert.ok(rawErr instanceof Error)`——任何 Error 都能过。
  // 对照组抛的必须是**同一个具体错误**，否则下面的"逐字段一致"比的是两个不相干的东西。
  assert.ok(rawErr instanceof Error);
  assert.ok(String(rawErr.message).includes("未找到作品目录"), "对照组应抛具体的那条错误（书名不存在）：" + String(rawErr.message).slice(0, 60));
  assert.ok(!("code" in rawErr) || rawErr.code === undefined, "夹具里这条错误没有 code（否则下面比 code 只是在比两个 undefined）");

  const auditedErr = await captureErr(() => defs.novel_read.execute({ book: "不存在的书XYZ", chapter: "1", root: LIB }, exec));
  assert.ok(auditedErr instanceof Error, "装审计后异常必须照样抛出（不得吞）");
  assert.equal(auditedErr.constructor, rawErr.constructor, "异常类型必须一致");
  assert.equal(auditedErr.name, rawErr.name);
  assert.equal(auditedErr.message, rawErr.message, "异常 message 必须逐字一致");
  assert.equal(auditedErr.code, rawErr.code);
  assert.deepEqual(Object.keys(auditedErr), Object.keys(rawErr), "审计不得给异常加字段");
  assert.ok(!("detail" in auditedErr) && !("status" in auditedErr));

  // 更强的口径：抛出的就是工具内部抛出的**同一个对象**
  const PROBE_ERR2 = Object.assign(new Error("同一引用探针"), { code: "E_SAME_REF" });
  registerProbe("probe_same_ref", async () => { throw PROBE_ERR2; });
  const caught = await captureErr(() => probeDefs.get("probe_same_ref").execute({}, exec));
  assert.equal(caught, PROBE_ERR2, "审计必须原样抛出（同一引用），不得转换/包装/新建 Error");

  const typeErr = await captureErr(() => probeDefs.get("probe_type_throw").execute({}, exec));
  assert.ok(typeErr instanceof TypeError, "非 Error 子类也要原样抛出");
  assert.equal(typeErr.message, "类型探针");
  assert.equal(lastEvent().status, "failed");
  assert.equal(lastEvent().code, "42", "数字 code 应字符串化落盘");
});

test("⑨-e 参数摘要路径不含正文（成功路径；失败路径见 ⑤-c / ⑤-d）", async () => {
  await log.clearLogs();
  const content = CANARY_SENTENCE + FILLER;
  await callLogged("novel_new_chapter", { book: BOOK, chapter: 9, title: "探针章", content, root: LIB });
  const ev = lastEvent();
  for (const key of ["content", "text", "title", "body"]) assert.ok(!(key in ev), "事件不得含 " + key);
  // 口径收紧（F1）：下面两条**只在"成功路径"上成立**——参数只走 summarizeArgs（定位字段 + 长度），
  // 调用没有失败、就没有"报错消息回显输入"这条通道。**失败路径上本地层会保留一句 ≤160 字的
  // 自由文本**（见 ⑤-d 的正面断言），所以这两条**不能**被读成"本地日志里永远搜不到正文"✗。
  const raw = readFileSync(log.logFilePath(), "utf8");
  assert.equal(canaryLeak(raw), null, "成功路径的落盘内容里不得出现正文片段（本用例只调了一次成功建章）");
  assert.ok(!raw.includes(CANARY_CORE), "参数摘要路径不得写出正文内容");
  // v6.6.0 修正（已落地，2026-10-15 复核）：`contentChars` 等长度/计数派生键此前**漏登记在白名单外、被整批丢掉**，
  // 也就是「content/text 只记长度」这句当时并不成立（隐私侧没事，损失的是可观测性）。现已在
  // ALLOWED_KEYS 里补齐，所以下面从"如实断言失效现状"改为**断言它必须落盘**：
  assert.ok("contentChars" in ev, "★ contentChars 必须落盘（v6.6.0 修正：白名单漏登记 6 个长度/计数派生键 + name，「只记长度」此前根本没生效——由测试负责人实测抓出）");
  assert.equal(ev.contentChars, content.length, "落盘的长度必须等于真实正文长度（现算）");
  assert.ok(!("title" in ev), "title 不在 summarizeArgs 的名单里，不得落盘");
  // 落盘的确实是定位字段（白名单内的那些）——证明"摘要"并非全丢
  assert.equal(ev.book, BOOK);
  assert.equal(ev.chapter, "9");
  assert.ok(existsSync(join(LIB, "novels", BOOK, "第09章 探针章.md")), "探针章应真的被创建（否则探针没生效）");
  assert.equal(readFileSync(join(LIB, "novels", BOOK, "第09章 探针章.md"), "utf8").includes(CANARY_CORE), true);
});

test("⑨-f 辅助事件是有意的：写操作记 lastRoot 轨迹（首次记录一条，重复写不刷屏）", async () => {
  // 为什么要单独测：callLogged 只数 tool_call，所以"一次调用多出别的 kind"必须有正面断言，
  // 否则"多出来的那条"到底是设计还是噪音无人守。
  const LIB2 = join(ROOT, "lib-root2");
  mkdirSync(join(LIB2, "novels"), { recursive: true });
  const registry2 = [];
  apply({
    tools: { register: (d) => { registry2.push(d); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    inject: (names, cb) => cb({})
  }, { root: LIB2, sentenceAnalysis: { enabled: true, autoAnalyze: false }, allowLanState: false });
  const defs2 = Object.fromEntries(registry2.map((d) => [d.name, d]));
  const exec2 = { agent: { session: { header: { cwd: LIB } } } };   // cwd 刻意不是 LIB2（走 config.root 那条路）

  await log.clearLogs();
  // ① 不传 root → 走 config.root → noteRoot 落 lastRoot → 首次记录必留痕
  const added1 = await defs2.novel_new_chapter.execute({ book: BOOK, chapter: 1, content: FILLER + FILLER2 }, exec2);
  assert.equal(added1.number, 1);
  const evs1 = await log.readLogEvents({ limit: 50, forShare: false });
  assert.equal(evs1.filter((e) => e.kind === "tool_call").length, 1, "一次调用一条 tool_call");
  const first = evs1.find((e) => e.kind === "root_resolve");
  assert.ok(first, "写操作应留下 lastRoot 轨迹（root_resolve）");
  assert.equal(first.rootSource, "lastRoot 首次记录");
  assert.equal(first.root, LIB2);

  // ② 再写一次（同一个 root）→ lastRoot 没变 → **不该**再记（避免每个写操作都刷屏）
  const lines2 = lineCount(log.logFilePath());
  await defs2.novel_new_chapter.execute({ book: BOOK, chapter: 2, content: FILLER }, exec2);
  const added = rawLines(log.logFilePath()).slice(lines2).map((l) => tryJson(l));
  assert.equal(added.length, 1, "lastRoot 未变化时不应重复记 root_resolve，实测多出 " + added.length + " 条");
  assert.equal(added[0].kind, "tool_call");

  // ③ 报告里的 lastRoot 应真读到（端到端确认落盘生效）
  const rep = await defs2.novel_diagnose.execute({ days: 7 }, exec2);
  assert.equal(rep.root.path, LIB2);
  assert.equal(rep.root.lastRoot, LIB2, "diagnose 报告的 lastRoot 应等于刚记录的值");
  assert.equal(rep.root.lastRootLooksLikeLibraryRoot, true);
  assert.equal(rep.tools.registered, 20);
  await log.clearLogs();
});

// ===========================================================================
// ⑤ 金丝雀端到端（本版隐私承诺的核心测试）
// ===========================================================================

test("⑤-c 金丝雀端到端：本地层搜得到、分享层（readLogEvents/diagnose/渲染/路由）搜不到", async () => {
  await log.clearLogs();
  assert.equal(lineCount(log.logFilePath()), 0, "起点必须是空日志（否则下面的 liveness 断言无从归因）");

  // ── 真实工具流程 ──
  await callLogged("novel_books", { root: LIB });
  await callLogged("novel_chapters", { book: BOOK, root: LIB });
  await callLogged("novel_read", { book: BOOK, chapter: "1", root: LIB });              // 读的正是含金丝雀那章
  await callLogged("novel_style_check", { book: BOOK, chapter: "第02章", root: LIB });
  await callLogged("novel_fix_plan", { book: BOOK, chapter: "第02章", action: "plan", root: LIB });
  // 内容探针（成功路径：content 只记长度）
  await callLogged("novel_new_chapter", { book: BOOK, chapter: 10, title: "探针章二", content: CANARY_SENTENCE + FILLER, root: LIB });
  // 把"正文级自由文本"逼进日志的错误路径（单次调用看不见的那类）：
  //   ① 同号建章 → 报错消息里带**含金丝雀的章节文件名**
  //   ② 词条改名找不到 → 报错消息里带**用户传入的金丝雀串**
  const err1 = await captureErr(() => defs.novel_new_chapter.execute({ book: BOOK, chapter: 1, root: LIB }, exec));
  assert.ok(err1 instanceof Error && err1.message.includes(CANARY_CORE), "探针①应把金丝雀带进异常消息（同号建章的报错里含章节文件名）");
  const err2 = await captureErr(() => defs.novel_lexicon.execute({ book: BOOK, action: "update", term: CANARY_CORE, root: LIB }, exec));
  assert.ok(err2 instanceof Error && err2.message.includes(CANARY_CORE), "探针②应把金丝雀带进异常消息（词条名被回显）");
  const err3 = await captureErr(() => defs.novel_lexicon.execute({ book: BOOK, action: "update", term: CANARY_CORE, root: LIB }, exec));
  assert.ok(err3 instanceof Error, "探针③（重复失败，用于触发「反复出问题」聚合）");
  console.log("   [金丝雀探针] 三条真实失败：" + [err1, err2, err3].map((e) => e.constructor.name + "「" + String(e.message).slice(0, 24) + "…」").join("｜"));

  // ── liveness：本地层必须真的含有金丝雀（否则"分享层没有"是空话）──
  const rawLocal = readFileSync(log.logFilePath(), "utf8");
  assert.ok(rawLocal.includes(CANARY_CORE), "本地日志文件里应能看到金丝雀（自由文本按设计保留在本地）");
  // ⚠ F1 已知边界（独立验证代理实测；协调方判定 **不收紧本地层**，只改口径）——
  //   本地层**可能保留至多一句（≤ LOG_FREE_TEXT_MAX = 160 字）的自由文本**，
  //   所以这里**不能**断言"日志文件里搜不到正文片段"：那样的断言要不就不成立，
  //   要不就退化成只查一个短窗口（原来的写法只查 17 字核心 → 34 字原句片段能穿过去，
  //   这正是 F1 没被本文件抓住、而被验证代理抓住的原因）。
  //   可断言的只有"收敛规则"：自由文本到第一句末标点为止并加 …，因此**整句原文**
  //   （连同句末标点）不会原样落盘；下面的 ⑤-d 用验证代理的原句把这个边界钉成正面断言。
  //   复现命令（真实工具路径）：
  //     novel_lexicon action=update term="灯塔的看守人在第三块礁石上捡到一枚生锈的铜钥匙上面刻着两个模糊的名字"
  //     → 抛「词表中找不到词条「…」」→ 报错回显该串 → 本机 logs/events.jsonl 里出现这 34 字原句。
  assert.ok(!rawLocal.includes(CANARY_SENTENCE), "整句原文（含句末标点）不得原样落盘——自由文本会被收敛到第一句末");
  const localEvents = await log.readLogEvents({ limit: 500, forShare: false });
  const carried = localEvents.filter((e) => String(e.detail ?? "").includes(CANARY_CORE));
  assert.ok(carried.length >= 2, "应至少有两条事件的 detail 带金丝雀（现算：" + carried.length + "）");
  assert.ok(carried.some((e) => e.tool === "novel_new_chapter" && e.status === "failed"));
  assert.ok(carried.some((e) => e.tool === "novel_lexicon" && e.status === "failed"));
  for (const ev of carried) {
    assert.ok(String(ev.detail).length <= log.LOG_FREE_TEXT_MAX + 1, "本地层自由文本仍受 160 字上限（" + ev.tool + " 实测 " + String(ev.detail).length + "）");
  }
  console.log("   [金丝雀·本地层] 带金丝雀的自由文本事件 " + carried.length + " 条：" +
    carried.map((e) => e.tool + "/" + e.status).join("、") + "（分享层必须一条都不剩）");

  // ── 分享层 1/4：readLogEvents({forShare:true}) ──
  // **失败路径必须在这里也过一遍**（弱断言⑤-c）：上面三条探针的正文是经**报错消息**进日志的，
  // 成功路径干净不代表失败路径干净——所以既查全量，也**按工具逐条**查那三条失败事件。
  const shareEvents = await log.readLogEvents({ limit: 500, forShare: true });
  assertNoCanary(JSON.stringify(shareEvents), "readLogEvents({forShare:true})");
  for (const ev of shareEvents) {
    for (const key of ["note", "detail", "suggestion"]) assert.ok(!(key in ev), "分享层事件不得带 " + key);
  }
  assert.ok(shareEvents.some((e) => e.redacted === true), "至少有一条分享层事件带 redacted 标记");
  const failShareEvents = shareEvents.filter((e) => e.status === "failed" && (e.tool === "novel_lexicon" || e.tool === "novel_new_chapter"));
  assert.ok(failShareEvents.length >= 3, "分享层应仍能看到那三条失败事件本身（只是没有自由文本），实测 " + failShareEvents.length);
  for (const ev of failShareEvents) assertNoCanary(JSON.stringify(ev), "分享层·失败路径事件 " + ev.tool);
  assert.ok(failShareEvents.some((e) => e.tool === "novel_lexicon" && e.book === BOOK), "失败路径的结构性字段（tool / book）必须留住，否则分享层只剩空壳");

  // ── 分享层 2/4：novel_diagnose 的返回体 + 渲染文本 ──
  const rep = await defs.novel_diagnose.execute({ days: 7, root: LIB }, exec);
  assertNoCanary(JSON.stringify(rep), "novel_diagnose(report) 返回体");
  assertNoCanary(rep.report, "novel_diagnose(report) 报告文本");
  const rendered = defs.novel_diagnose.output.render({}, rep).map((r) => r.text).join("\n");
  assertNoCanary(rendered, "novel_diagnose render 文本");
  // 报告不含错误原文（自由文本被剔除的另一面）
  for (const marker of ["不会覆盖旧稿", "用 action=list 查看现有词条"]) {
    assert.ok(!rep.report.includes(marker), "报告里不该出现错误原文：" + marker);
  }

  const evOut = await defs.novel_diagnose.execute({ days: 7, action: "events", root: LIB }, exec);
  assertNoCanary(JSON.stringify(evOut), "novel_diagnose(events) 返回体");
  assert.ok(Array.isArray(evOut.events) && evOut.events.length > 0, "action=events 应附带明细");
  for (const ev of evOut.events) {
    for (const key of ["note", "detail", "suggestion"]) assert.ok(!(key in ev), "明细不得带 " + key);
  }

  // ── 分享层 3~4/4：GET /diagnose 与 ?events=1（面板「看诊断 / 复制诊断包」走的就是它）──
  for (const url of ["/api/dsh-novel-writer/diagnose", "/api/dsh-novel-writer/diagnose?events=1"]) {
    const res = mockRes();
    await diagRoute().handler(mockReq({ url }), res);
    assert.equal(res.state.status, 200, url + " 应 200");
    assertNoCanary(res.state.body, "GET " + url + " 响应");
    const body = JSON.parse(res.state.body);
    assert.equal(body.ok, true);
    assertNoCanary(body.report, "GET " + url + " 的 report");
  }
});

// ===========================================================================
// ⑤-d F1 已知边界（口径修正的落点）：本地层至多一句；分享层对任意 ≥6 字窗口零命中
// ===========================================================================

test("⑤-d F1 边界：34 字无标点原句完整落在**本机**日志；分享层四条出口对任意 ≥6 字窗口零命中", async () => {
  await log.clearLogs();
  assert.equal(lineCount(log.logFilePath()), 0, "起点必须是空日志（否则无法把下面的命中归因到本探针）");
  // 走**真实工具路径**（不是合成事件）：把验证代理的原句当词条名传进去 → 工具抛错 → 审计把回显写进 detail。
  // 连调两次：第二次是"重复失败"，⑩-c 的「工具 × 书名 反复出问题」聚合需要它（本用例清过日志，
  // 前序用例留下的两条失败已被清掉，所以由本用例自己补上这个前提）。
  const errA = await captureErr(() => defs.novel_lexicon.execute({ book: BOOK, action: "update", term: F1_TERM, root: LIB }, exec));
  const errB = await captureErr(() => defs.novel_lexicon.execute({ book: BOOK, action: "update", term: F1_TERM, root: LIB }, exec));
  for (const [label, err] of [["①", errA], ["②", errB]]) {
    assert.ok(err instanceof Error, "F1 探针" + label + "应抛错（词表中找不到该词条）");
    assert.ok(String(err.message).includes(F1_TERM), "F1 探针" + label + "的报错消息必须回显原句——这正是它落进日志的那条通道");
  }

  // ① 本地层：**这是实话**（旧文案「绝不记录正文」✗）。34 字、无句末标点、连续表意文字 34 ≤ 40
  //    → clampFreeText 的两级收敛都不触发 → 原句逐字落盘。协调方判定：**不收紧本地层**，
  //    因此这里断言的是"至多一句（≤160 字）"，而不是"没有正文"。
  const rawLocal = readFileSync(log.logFilePath(), "utf8");
  assert.ok(rawLocal.includes(F1_TERM), "F1 已知边界：本机日志里会出现这句 34 字原句");
  const localEvents = await log.readLogEvents({ limit: 500, forShare: false });
  const localHits = localEvents.filter((e) => e.tool === "novel_lexicon" && String(e.detail ?? "").includes(F1_TERM));
  assert.equal(localHits.length, 2, "两条失败都应在本地层读到（自由文本保留；⑩-c 的「重复失败」聚合也依赖它）");
  for (const e of localHits) {
    assert.equal(e.status, "failed");
    assert.ok(String(e.detail).length <= log.LOG_FREE_TEXT_MAX + 1,
      "但自由文本仍受 160 字上限（至多一句）约束，实测 " + String(e.detail).length);
  }

  // ② 分享层：本地层留着它，**离开本机的那一份必须一个 ≥6 字窗口都不含**
  const shareEvents = await log.readLogEvents({ limit: 500, forShare: true });
  const shareHit = shareEvents.find((e) => e.tool === "novel_lexicon");
  assert.ok(shareHit, "失败事件本身在分享层必须还在（不得因为脱敏而整条消失）");
  assert.equal(shareHit.redacted, true, "分享层恒带 redacted");
  assert.ok(!("detail" in shareHit) && !("note" in shareHit) && !("suggestion" in shareHit), "分享层整体剔除自由文本");
  assertNoLeak(JSON.stringify(shareEvents), "分享层全量（F1 原句窗口）", F1_WINDOWS);
  for (const ev of shareEvents) assertNoLeak(JSON.stringify(ev), "分享层逐条 " + ev.tool, F1_WINDOWS);

  // ③ 分享层的**四条出口**全查（诊断报告 / 渲染文本 / events 明细 / 诊断路由）
  const rep = await defs.novel_diagnose.execute({ days: 7, root: LIB }, exec);
  assertNoLeak(JSON.stringify(rep), "novel_diagnose 返回体", F1_WINDOWS);
  assertNoLeak(rep.report, "novel_diagnose 报告文本", F1_WINDOWS);
  assertNoLeak(defs.novel_diagnose.output.render({}, rep).map((r) => r.text).join("\n"), "novel_diagnose render 文本", F1_WINDOWS);
  const evOut = await defs.novel_diagnose.execute({ days: 7, action: "events", root: LIB }, exec);
  assertNoLeak(JSON.stringify(evOut), "novel_diagnose(events) 明细", F1_WINDOWS);
  for (const url of ["/api/dsh-novel-writer/diagnose", "/api/dsh-novel-writer/diagnose?events=1"]) {
    const res = mockRes();
    await diagRoute().handler(mockReq({ url }), res);
    assert.equal(res.state.status, 200, url + " 应 200");
    assertNoLeak(res.state.body, "GET " + url + " 响应", F1_WINDOWS);
  }
  // 面板「复制诊断包」= 接口给的 report + 由结构化字段拼成的环境信息（面板不重拼报告）——
  // 因此它等同上面的 report（面板侧另有 client-test 单独守"复制出去的正文从哪来"）。
  console.log("   [F1 边界] 本地层保留原句 34 字 ✓（≤160 字上限内）｜分享层四条出口对 " + F1_WINDOWS.length + " 个 ≥6 字窗口零命中 ✓");
});

// ===========================================================================
// ⑩ novel_diagnose 工具契约
// ===========================================================================

test("⑩ ALL_TOOLS=20 且与注册表一致；schema 是 additionalProperties:false 且 required ⊆ properties", () => {
  assert.equal(ALL_TOOLS.length, 20, "v6.6.0 起第 20 个工具是 novel_diagnose");
  assert.ok(ALL_TOOLS.includes("novel_diagnose"));
  assert.deepEqual([...toolDefs.map((d) => d.name)].sort(), [...ALL_TOOLS].sort(), "注册表与 ALL_TOOLS 单一事实源必须一致");

  const def = defs.novel_diagnose;
  assert.equal(def.output.schema.additionalProperties, false, "宿主严格校验：多一个未登记字段会整条拒收");
  for (const key of def.output.schema.required) {
    assert.ok(Object.prototype.hasOwnProperty.call(def.output.schema.properties, key), "required 必须在 properties 里：" + key);
  }
});

test("⑩-b schema 一致性：返回键 ⊆ output.schema.properties（diagnose 三 action + 7 个既有工具）", async () => {
  const calls = [
    ["novel_diagnose(report)", "novel_diagnose", { days: 7, root: LIB }],
    ["novel_diagnose(events)", "novel_diagnose", { days: 7, action: "events", root: LIB }],
    ["novel_books", "novel_books", { root: LIB }],
    ["novel_chapters", "novel_chapters", { book: BOOK, root: LIB }],
    ["novel_read", "novel_read", { book: BOOK, chapter: "1", root: LIB }],
    ["novel_style_check", "novel_style_check", { book: BOOK, chapter: "第02章", root: LIB }],
    ["novel_fix_plan", "novel_fix_plan", { book: BOOK, chapter: "第02章", action: "plan", root: LIB }],
    ["novel_lexicon", "novel_lexicon", { book: BOOK, action: "list", scope: "all", root: LIB }],
    ["novel_continuity_check", "novel_continuity_check", { book: BOOK, root: LIB }]
  ];
  for (const [label, name, args] of calls) {
    const out = await defs[name].execute(args, exec);
    assertKeysDeclared(label, defs[name], out);
  }
  // clear 的 schema 断言放在 ⑩-f（它有"清空日志"的副作用，不能在这里跑）
});

test("⑩-c report：中文报告含「诊断报告」；issues 每条有 level/title/detail/suggestion", async () => {
  const rep = await defs.novel_diagnose.execute({ days: 7, root: LIB }, exec);
  assert.equal(rep.action, "report");
  assert.equal(rep.days, 7);
  assert.equal(typeof rep.report, "string");
  assert.ok(rep.report.includes("诊断报告"), "报告应含「诊断报告」字样");
  assert.ok(rep.report.includes("不含任何正文"), "报告应显式声明不含正文");
  assert.equal(rep.root.path, LIB);
  assert.equal(rep.root.source, "调用参数 root");
  assert.equal(rep.root.looksLikeLibraryRoot, true);
  assert.ok(rep.log.dir.startsWith(STATE_DIR), "报告里的日志目录应是状态目录旁那个");
  assert.equal(rep.tools.registered, 20);
  assert.equal(rep.tools.enabled, 20);

  assert.ok(Array.isArray(rep.issues) && rep.issues.length > 0);
  for (const issue of rep.issues) {
    assert.ok(["error", "warn", "info"].includes(issue.level), "level 取值非法：" + issue.level);
    for (const key of ["title", "detail", "suggestion"]) {
      assert.equal(typeof issue[key], "string", "issue." + key + " 应为字符串");
      assert.ok(issue[key].length > 0, "issue." + key + " 不应为空");
    }
  }
  // 反复失败的模式（单次调用看不见的规律）应被聚合出来
  const repeated = rep.problems.find((p) => p.tool === "novel_lexicon" && p.book === BOOK);
  assert.ok(repeated && repeated.failed >= 2, "novel_lexicon × 紫晶书 的重复失败应被聚合：" + JSON.stringify(rep.problems));
  assert.ok(rep.issues.some((i) => i.title.includes("反复出问题")), "应给出「反复出问题」的结论");
});

test("⑩-d report 的计数与聚合必须等于磁盘真值（现算），且内部自洽", async () => {
  // 现造两条失败（同一工具 × 同一本书 → 触发「反复出问题」聚合），让本用例自给自足
  const badBook = "不存在的书QQQ";
  await callLoggedErr("novel_read", { book: badBook, chapter: "1", root: LIB });
  await callLoggedErr("novel_read", { book: badBook, chapter: "2", root: LIB });

  const diskTools = diskToolCalls(7);
  const expectedTotal = Math.min(diskTools.length, 2000);
  const statsBefore = log.logStats();          // 报告是在"自己那条审计记录"落盘之前生成的 → 必须先取快照
  const rep = await defs.novel_diagnose.execute({ days: 7, root: LIB }, exec);

  // ① 三态计数：与磁盘逐条现算一致（本工具自身那条在报告生成**之后**才写，所以不参与）
  const expectCounts = { total: expectedTotal, ok: 0, degraded: 0, failed: 0 };
  for (const ev of diskTools.slice(0, 2000)) {
    if (ev.status === "failed") expectCounts.failed += 1;
    else if (ev.status === "degraded") expectCounts.degraded += 1;
    else expectCounts.ok += 1;
  }
  assert.deepEqual(rep.calls, expectCounts, "calls 三态计数必须等于磁盘真值");
  assert.equal(rep.calls.ok + rep.calls.degraded + rep.calls.failed, rep.calls.total);
  assert.ok(rep.calls.failed >= 2, "本用例应至少留下 2 条 failed（现算：磁盘 " + expectCounts.failed + "）");

  // ② byTool：逐行与磁盘现算一致，且按 total 降序截断到 12 行
  const perTool = new Map();
  for (const ev of diskTools.slice(0, 2000)) {
    const row = perTool.get(ev.tool) ?? { tool: ev.tool, total: 0, degraded: 0, failed: 0, msTotal: 0 };
    row.total += 1;
    if (ev.status === "failed") row.failed += 1;
    if (ev.status === "degraded") row.degraded += 1;
    if (Number.isFinite(ev.ms)) row.msTotal += ev.ms;
    perTool.set(ev.tool, row);
  }
  const expectedByTool = [...perTool.values()].sort((a, b) => b.total - a.total).slice(0, 12);
  // 并列名次的顺序不可依赖（Map 插入序在两边不同）→ 比集合 + 降序性，逐行比值
  assert.deepEqual([...rep.byTool.map((r) => r.tool)].sort(), expectedByTool.map((r) => r.tool).sort(), "byTool 应是按调用次数降序的前 12 个工具");
  assert.ok(rep.byTool.every((r, i, a) => i === 0 || a[i - 1].total >= r.total), "byTool 必须按 total 降序");
  for (const row of rep.byTool) {
    const want = perTool.get(row.tool);
    assert.equal(row.total, want.total, row.tool + " 的 total 与磁盘不符");
    assert.equal(row.failed, want.failed, row.tool + " 的 failed 与磁盘不符");
    assert.equal(row.degraded, want.degraded, row.tool + " 的 degraded 与磁盘不符");
    assert.equal(row.msTotal, want.msTotal, row.tool + " 的 msTotal 与磁盘不符");
  }

  // ③ 重复失败的模式必须在 problems 里（这就是"单次调用看不见的规律"）
  const repeated = rep.problems.find((p) => p.tool === "novel_read" && p.book === badBook);
  assert.ok(repeated && repeated.failed >= 2, "novel_read × " + badBook + " 的重复失败应被聚合：" + JSON.stringify(rep.problems));
  assert.ok(rep.issues.some((i) => i.title.includes("反复出问题")), "应给出「反复出问题」的结论");

  // ④ 日志体积也是现算的
  const statsAfter = log.logStats();
  assert.equal(rep.log.bytes, statsBefore.bytes);
  assert.equal(rep.log.files, statsBefore.files.length);
  assert.equal(rep.log.dir, log.logDir());
  assert.ok(statsAfter.bytes > statsBefore.bytes, "诊断调用自身也会写一条审计记录（因此报告里的数字必然小于调用后的磁盘真值）");
});

test("⑩-e events：明细等于分享层事件（同一实现），且 ≤200 条", async () => {
  const expected = await log.readLogEvents({ days: 7, limit: 200, forShare: true });
  const out = await defs.novel_diagnose.execute({ days: 7, action: "events", root: LIB }, exec);
  assert.equal(out.action, "events");
  assert.ok(Array.isArray(out.events));
  assert.ok(out.events.length <= 200, "events 明细上限 200 条");
  assert.deepEqual(out.events, expected, "events 应与 readLogEvents({forShare:true}) 完全一致（同一事实源）");
  assertNoCanary(JSON.stringify(out), "novel_diagnose(events)");
});

test("⑩-f clear：清空日志，但 clear 自身也是一次工具调用 → 清空后仍恰好 1 条", async () => {
  await log.clearLogs();
  await defs.novel_books.execute({ root: LIB }, exec);
  assert.ok(lineCount(log.logFilePath()) > 0);
  const out = await defs.novel_diagnose.execute({ action: "clear", root: LIB }, exec);
  assert.equal(out.action, "clear");
  assert.equal(out.cleared, true);
  assert.equal(out.calls.total, 0, "clear 的返回体里计数为 0（它在清空之前组装）");
  assert.ok(out.report.includes("已清空"));
  assert.equal(out.issues.length, 1);
  assert.equal(out.issues[0].level, "info");
  for (const key of ["level", "title", "detail", "suggestion"]) assert.ok(key in out.issues[0]);
  assertKeysDeclared("novel_diagnose(clear)", defs.novel_diagnose, out);

  // 磁盘真值：clear 清掉 events*.jsonl，而审计包装在 finally 里又写下 clear 自己那一条
  const remaining = diskToolCalls(7);
  assert.ok(remaining.length <= 1, "clear 之后磁盘上最多剩 1 条（clear 自身），实测 " + remaining.length);
  assert.equal(remaining.length, 1, "审计包装决定 clear 自身那条必然存在");
  assert.equal(remaining[0].tool, "novel_diagnose");
  assert.equal(remaining[0].action, "clear");
  assert.equal(remaining[0].status, "ok");
  console.log("   [clear] 清空后磁盘剩余事件：" + remaining.length + " 条（= clear 自身的审计记录，符合契约的「≤1」）");
});

// ===========================================================================
// ⑪ 诊断路由
// ===========================================================================

function diagRoute() {
  const found = routes.filter((r) => r.path === "/api/dsh-novel-writer/diagnose");
  assert.equal(found.length, 1, "诊断路由必须恰好注册一次");
  return found[0];
}
function mockRes() {
  const state = { status: 0, headers: null, body: "" };
  return {
    state,
    writeHead(code, headers) { state.status = code; state.headers = headers; },
    end(payload) { state.body = payload === void 0 ? "" : String(payload); }
  };
}
function mockReq({ method = "GET", url, host = "127.0.0.1:19387", origin, secFetchSite, remoteAddress = "127.0.0.1" } = {}) {
  const headers = {};
  if (host !== null) headers.host = host;
  if (origin !== void 0) headers.origin = origin;
  if (secFetchSite !== void 0) headers["sec-fetch-site"] = secFetchSite;
  // core.isLoopbackRequest 同时看 socket.remoteAddress 与 headers.host（两者都要是回环）
  return { method, url, socket: { remoteAddress }, headers, on: () => {} };
}

test("⑪ 诊断路由已注册（由 registerStyleConfigRoute 在 makeStateRoutes 之后 push）", () => {
  assert.ok(routes.length > 1, "应有 makeStateRoutes 的多条路由 + 诊断路由");
  const route = diagRoute();
  assert.equal(route.kind, "exact");
  assert.equal(routes[routes.length - 1].path, route.path, "诊断路由应是最后 push 的那条");
  assert.equal(typeof route.handler, "function");
});

test("⑪-b GET 200 {ok:true,report}；?events=1 带 events；?days&book 生效；POST 405；非回环 403", async () => {
  const route = diagRoute();

  const ok = mockRes();
  await route.handler(mockReq({ url: "/api/dsh-novel-writer/diagnose" }), ok);
  assert.equal(ok.state.status, 200);
  assert.equal(ok.state.headers["content-type"], "application/json; charset=utf-8");
  const body = JSON.parse(ok.state.body);
  assert.equal(body.ok, true);
  assert.equal(typeof body.report, "string");
  assert.ok(body.report.includes("诊断报告"));
  assert.ok(Array.isArray(body.issues) && body.issues.length > 0);
  for (const key of ["action", "days", "root", "calls", "issues", "checklist", "report"]) assert.ok(key in body, "路由响应应带 " + key);

  const evRes = mockRes();
  await route.handler(mockReq({ url: "/api/dsh-novel-writer/diagnose?events=1" }), evRes);
  const evBody = JSON.parse(evRes.state.body);
  assert.equal(evBody.action, "events");
  assert.ok(Array.isArray(evBody.events), "?events=1 应含 events 数组");

  const paramRes = mockRes();
  await route.handler(mockReq({ url: "/api/dsh-novel-writer/diagnose?days=3&book=" + encodeURIComponent(BOOK) }), paramRes);
  const paramBody = JSON.parse(paramRes.state.body);
  assert.equal(paramBody.days, 3);
  assert.equal(paramBody.book, BOOK);

  const post = mockRes();
  await route.handler(mockReq({ method: "POST", url: "/api/dsh-novel-writer/diagnose" }), post);
  assert.equal(post.state.status, 405);
  assert.ok(JSON.parse(post.state.body).error.includes("method not allowed"));

  const lan = mockRes();
  await route.handler(mockReq({ url: "/api/dsh-novel-writer/diagnose", host: "10.1.2.3:3080", origin: "http://10.1.2.3:3080", remoteAddress: "10.1.2.3" }), lan);
  assert.equal(lan.state.status, 403, "allowLanState=false 时非回环必须 403");
  assert.ok(JSON.parse(lan.state.body).error.includes("loopback"));

  // 非回环的**两半**各测一次（socket 与 host 分开）——只堵一半等于没堵
  const lanSocket = mockRes();
  await route.handler(mockReq({ url: "/api/dsh-novel-writer/diagnose", remoteAddress: "192.168.1.5" }), lanSocket);
  assert.equal(lanSocket.state.status, 403, "socket 非回环（host 伪装成 127.0.0.1）必须 403");
  const lanHost = mockRes();
  await route.handler(mockReq({ url: "/api/dsh-novel-writer/diagnose", host: "localhost.evil.test:3080" }), lanHost);
  assert.equal(lanHost.state.status, 403, "host 非回环（socket 是回环）必须 403");

  const crossSite = mockRes();
  await route.handler(mockReq({ url: "/api/dsh-novel-writer/diagnose", secFetchSite: "cross-site" }), crossSite);
  assert.equal(crossSite.state.status, 403, "cross-site 即使 host 是回环也必须 403");
});

test("⑪-c 报告 rootSource 跟随 config.root；报告与路由响应均不含正文", async () => {
  // 不传 args.root → 走 config.root（只读调用，不触发 noteRoot）
  const rep = await defs.novel_diagnose.execute({ days: 7 }, exec);
  assert.equal(rep.root.path, LIB);
  assert.equal(rep.root.source, "插件配置 config.root");
  assert.equal(canaryLeak(JSON.stringify(rep)), null);

  // 根不像书库根 → 应作为 error 级问题报出来（面板"列不出书"的头号成因）
  const bad = await defs.novel_diagnose.execute({ days: 7, root: join(ROOT, "not-a-library") }, exec);
  assert.equal(bad.root.looksLikeLibraryRoot, false);
  assert.ok(bad.issues.some((i) => i.level === "error" && i.title.includes("书库根")), "根不对时应给 error 级问题");
});

// ===========================================================================
// ⑥ 轮转与总量有界（放最后：它会往日志里灌 ~2.5MB 填充，避免影响前面的计数断言）
// ===========================================================================

test("⑥ 轮转：超 LOG_MAX_BYTES 即轮转；历史文件 ≤ LOG_KEEP_FILES；总量有界（现算磁盘真值）", async () => {
  await log.clearLogs();
  mkdirSync(log.logDir(), { recursive: true });
  const fillerLine = JSON.stringify({ ts: new Date(0).toISOString(), kind: "internal", tool: "filler" }) + "\n";
  const pad = Math.ceil(log.LOG_MAX_BYTES / fillerLine.length) + 8;
  const rotated = (n) => join(log.logDir(), `events.${n}.jsonl`);

  // 第一次：当前文件被灌到刚超过上限 → 下一条 logEvent 必须触发轮转
  writeFileSync(log.logFilePath(), fillerLine.repeat(pad), "utf8");
  const beforeSize = statSync(log.logFilePath()).size;
  assert.ok(beforeSize >= log.LOG_MAX_BYTES, "前置：当前文件应已超上限");
  log.logEvent("internal", { tool: "rotate_probe", count: 1 });
  assert.ok(existsSync(rotated(1)), "超上限后应轮转出 events.1.jsonl");
  assert.equal(statSync(rotated(1)).size, beforeSize, "轮转就是把旧文件整体改名（字节不变）");
  assert.ok(statSync(log.logFilePath()).size < log.LOG_MAX_BYTES, "轮转后当前文件应重新变小");

  // 继续轮转 LOG_KEEP_FILES + 1 次：更旧的历史文件必须被删掉
  for (let i = 2; i <= log.LOG_KEEP_FILES + 2; i += 1) {
    writeFileSync(log.logFilePath(), fillerLine.repeat(pad), "utf8");
    log.logEvent("internal", { tool: "rotate_probe", count: i });
  }
  for (let n = 1; n <= log.LOG_KEEP_FILES; n += 1) assert.ok(existsSync(rotated(n)), "events." + n + ".jsonl 应存在");
  assert.ok(!existsSync(rotated(log.LOG_KEEP_FILES + 1)), "历史文件数不得超过 LOG_KEEP_FILES（events." + (log.LOG_KEEP_FILES + 1) + " 不该存在）");

  const stats = log.logStats();
  const onDisk = logFiles().filter((f) => existsSync(f));
  assert.equal(stats.files.length, onDisk.length, "logStats 的文件数应等于磁盘真值");
  assert.equal(stats.files.length, log.LOG_KEEP_FILES + 1, "轮转到位后应恰好 KEEP+1 份文件");
  let sum = 0;
  for (const file of onDisk) sum += statSync(file).size;
  assert.equal(stats.bytes, sum);
  const bound = (log.LOG_KEEP_FILES + 1) * (log.LOG_MAX_BYTES + log.LOG_MAX_EVENT_BYTES);
  assert.ok(stats.bytes <= bound, `总量应有界（实测 ${stats.bytes} 字节，上界 ${bound}）`);

  // 灌了 2.5MB 之后读取仍不崩，且 1970 年的填充行不参与窗口统计
  const evs = await log.readLogEvents({ days: 7, limit: 5000 });
  assert.ok(evs.every((e) => e.tool !== "filler"), "超出时间窗口的填充行不应被返回");
  console.log(`   [轮转] ${stats.files.length} 份文件 / 合计 ${Math.round(stats.bytes / 1024)} KB（上界 ${Math.round(bound / 1024)} KB）`);
});

test("⑥-b clearLogs：连历史文件一起清空", async () => {
  assert.ok(existsSync(join(log.logDir(), "events.1.jsonl")), "前置：应存在历史文件");
  await log.clearLogs();
  for (const file of logFiles()) assert.ok(!existsSync(file), "clearLogs 应删除 " + file);
  const stats = log.logStats();
  assert.equal(stats.exists, false);
  assert.deepEqual(stats.files, []);
  assert.equal(stats.bytes, 0);
  assert.equal(lineCount(log.logFilePath()), 0);
});

// ===========================================================================
// ⑫ 隔离守卫（必须最后跑）
// ===========================================================================

test("⑫ 隔离守卫：用户真实 state.json 与真实 logs/ 全程未被触碰", () => {
  assert.equal(stateFilePath(), STATE, "本套件的 state 必须始终指向临时目录");
  assert.equal(fileDigest(REAL_STATE), guardBefore.state, "用户真实 state.json 被改动了（隔离失效）！");
  assert.equal(dirDigest(REAL_LOG_DIR), guardBefore.logs, "用户真实 logs/ 被写入了（隔离失效）！");
  assert.ok(log.logDir().startsWith(ROOT), "日志目录不属于临时根：" + log.logDir());
  console.log("   [隔离] 真实 state.json：" + (guardBefore.state ? "存在且哈希未变" : "本来不存在、跑完仍不存在") +
    "｜真实 logs/：" + (guardBefore.logs === null ? "本来不存在、跑完仍不存在" : "清单未变"));
});
