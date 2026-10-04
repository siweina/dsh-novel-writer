/**
 * test/ui-structure-test.mjs —— B 档「官网式整体重构」源码级结构回归测试（契约 §7，G 的独占产物）
 *
 * 规格来源：既有 UI 结构约定 §1 铁律 / §4 类名词汇表 / §7 G 专项（8 条断言）。
 * 归属：只写这一个文件；其它 test/* 一概不碰（client-test.mjs 归总负责人）。
 *
 * 运行：node test/ui-structure-test.mjs（路径相对本文件解析，任意 cwd 均可）
 * 依赖：零第三方——只用 node:fs / node:crypto；读 ALL_TOOLS 用动态 import("../lib/core.js")
 *       （lib/core.js 是 ESM，package.json "type":"module"），import 失败则降级为正则统计并在输出标注。
 * 退出码：任一断言 ✗ → 1；全部 ✓ → 0。
 *
 * 两组分区（§7.8）：
 *   [A] 结构存在性（断言 1）——本测试写于集成之前，**当前预期为红**；总负责人应用 F+E 后应转绿。
 *       计数口径：css 模板段之外的 js 段、**剔除注释后**、且排除 ".类名" 形态——只统计真正写在
 *       代码字符串里的结构类名（注释里提一句 `.nwSection` 或裸写 nwSection 都凑不了阈值）。
 *   [B] 不变量与守卫（断言 2~6）——写测试时实测**全绿**，集成前后任何时候都必须保持全绿。
 *   断言 7（输出格式/退出码）与 8（红绿分区呈现）由本文件的运行行为自证，汇总里单列。
 *
 * ── hook 稳定性基线（断言 4，写死）：12 ────────────────────────────────────────
 *   基线 = lib/client.js 全文 `react.use[A-Z]` 调用点 12 处。
 *   实测时文件指纹：185410 字节 / sha256 05d8ee70e04dd0ae188d82a087822fabd5a223f199124c04c8b16e877d4a36f5。
 *   复测命令（仓库根目录执行，期望输出 12）：
 *     node -e "const s=require('fs').readFileSync('lib/client.js','utf8');console.log((s.match(/react\.use[A-Z]/g)||[]).length)"
 *   口径：契约 §7.4 写的是「≤ 基线 +0」，本测试按 **== 12** 实现（更严）：F 的片段按 §1.6 不得新增 hook
 *   （新增 = 白屏回归）；hook 被删除同样是「对外行为零变化」被破坏，一并判红。
 *
 * ── 写测试时实测快照（§7.8 要求的红绿清单）────────────────────────────────────
 *   当前红（待集成后变绿，全部属 A 组）：
 *     A1.1~A1.6 —— js 段命中 nwHero=0、nwSection=0、nwKicker=0、nwIconSlot=0、nwPill=0、nwKickerRule=0
 *     （5.5.0 新类在 client.js 里还不存在，属预期；集成 F 的结构片段后应全部转绿）。
 *   当前绿（B 组，实测全绿）：
 *     B2 命脉 11/11 存活（js+css；nwSegBtn 独立词 4 处、role:"tab" 1 处）；
 *     B3 5.5.0 新增类 34/34 在 css 模板段有定义；
 *     B4 react.use[A-Z] == 12；
 *     B5 ctx.inject( =0、sidebar.panellist=5、name:"main"=1、createNovelWriterUI 定义=1、
 *        var NW_UI = createNovelWriterUI =1、primitives require 在 try 之后、
 *        client.js 与仓库内构建源重放一致、ALL_TOOLS=18；
 *     B6 css 模板段禁区 3×0；style: 对象裸色值违规 0（1 条 ⚠ 全局关键字豁免，见下）。
 *
 * ── 两处口径说明（已报总负责人）──────────────────────────────────────────────
 *   1) 断言 3 清单以契约 §4.2 冻结文本为准 = **34 个**（任务书口述「36 个」，对第 58 行反引号内
 *      token 程序点数为 34，以契约为准）。
 *   2) 断言 6d 对 style: 值的口径：`var(` 与 `color-mix(` 允许；CSS 全局关键字
 *      （transparent/none/inherit/initial/unset/revert/currentColor；borderRadius 另允许 0/0px，
 *      与 A-check R3 同口径）判绿但打 ⚠ 警告（与 A-check R1「只抓 #hex / rgb() / hsl()」一致，
 *      它们不含颜色信息、跟主题走）；其余色值、渐变、px 圆角字面量判红。
 *      写测试时实测存量豁免 1 条：lib/client.js 约 2267 行 background:"transparent"（demo 按钮）。
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// ============================== 写死的基线与清单 ==============================

const HOOK_BASELINE = 12;                       // 见头注释：实测命令与指纹
const EXPECTED_ALL_TOOLS = 18;                  // 工具侧零改动（契约 §1.7：18 个工具）
const PRIMITIVES_REQ = 'require("@deepseek-ai/dsh-client-ui-primitives")';

// 契约 §4.2：5.5.0 新增类必须全部保留定义（逐字来自契约第 58 行冻结清单，共 34 个）
const NEW_550_CLASSES = [
  "nwBoxed", "nwSubCard", "nwChip", "nwTextInput", "nwTextArea", "nwSelect", "nwNote", "nwMuted",
  "nwSignOk", "nwSignBad", "nwGutter", "nwDashedNote", "nwDividerRow", "nwSettingsCard",
  "nwSettingsCardTitle", "nwReportPre", "nwGroupName", "nwFileRow", "nwFileLabel", "nwStatRow",
  "nwStatName", "nwChevron", "nwFieldLabel", "nwWarnBanner", "nwNoteAccent", "nwNoteWarn",
  "nwNoteOk", "nwNoteDim", "nwAccentStrong", "nwTolSign", "nwInputErr", "nwCreationInput",
  "nwPlotBoxEmpty", "nwToolGroupHeadOpen"
];

// 契约 §4.2 末条「测试命脉类」（client-test.mjs 断言直接依赖，E/F 双重保证存活）
const LIFELINE_CLASSES = [
  "nwPanel", "nwPanelHeader", "nwPanelTitle", "nwRefresh", "nwClose",
  "nwBanner", "nwBannerOn", "nwBannerIcon", "nwPlotOk", "nwPlotErr", "nwMuted"
];

// 契约 §7.1 结构存在性阈值（只统计 js 段 = css 模板段之外，防止被 E 的 CSS 定义"误判为已插入"）
const STRUCTURE_MIN = [
  ["A1.1", "nwHero", 1],
  ["A1.2", "nwSection", 2],
  // A1.3 已升级为 v6 口径（见下方独立块：kicker 三件套统一经 SectionTitle 组件渲染）
  // A1.4 已升级为 v6 口径（见下方独立块：图标槽 = nwIconSlot(遗留) + nwPrefIcon(新行模式)）
  ["A1.5", "nwPill", 2]
];

const GLOBAL_KEYWORDS = new Set([
  "transparent", "none", "inherit", "initial", "unset", "revert", "revert-layer", "currentcolor"
]);

// ================================= 工具函数 ==================================

const CLIENT_URL = new URL("../lib/client.js", import.meta.url);
const CORE_URL = new URL("../lib/core.js", import.meta.url);

/** 统计正则命中数 */
function countRe(text, re) { return (text.match(re) || []).length; }
/** 统计「独立词形态」的类名命中（nwSection 不会命中 nwSectionTitle / nwKicker 不会命中 nwKickerRule） */
function countToken(text, name) {
  return countRe(text, new RegExp("(?<![A-Za-z0-9_])" + name + "(?![A-Za-z0-9_])", "g"));
}
/** 字面量计数（split 法，"." 等正则元字符不转义风险） */
function countLit(text, lit) { return text.split(lit).length - 1; }
/** idx 处的 1-based 行号 */
function lineOf(text, idx) {
  let n = 1;
  const end = Math.min(idx, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
/** 从 s[i] 的引号跳到闭合引号（处理转义） */
function skipString(s, i) {
  const q = s[i];
  for (let k = i + 1; k < s.length; k++) {
    if (s[k] === "\\") { k++; continue; }
    if (s[k] === q) return k;
  }
  return s.length - 1;
}
/** 从 s[i] 的 // 或 /* 注释跳到结束 */
function skipComment(s, i) {
  if (s[i + 1] === "/") {
    const n = s.indexOf("\n", i);
    return n < 0 ? s.length - 1 : n - 1;
  }
  const n = s.indexOf("*/", i + 2);
  return n < 0 ? s.length - 1 : n + 1;
}
/**
 * 把注释整段替换成等长空白（保留长度与换行 → 行号/下标不变）。
 * 结构类名只统计非注释代码：本仓库注释里确实会裸写类名（如 "成功态映射到 nwBadgeOn"），
 * 不剔除的话注释提一句就能凑阈值。字符串整体原样保留（JS 词法上字符串外的 `//` `/*`
 * 才是注释；正则字面量里能出现的相邻斜杠必然已转义，实际不会误伤真实代码——
 * 即便某段被误判跳过，失败方向也只是"注释没剔干净"，不会删掉真实代码造成假红）。
 */
function stripComments(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const e = skipString(s, i);
      out += s.slice(i, e + 1);
      i = e;
      continue;
    }
    if (ch === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      const end = nl < 0 ? s.length : nl;
      out += " ".repeat(end - i);
      i = end - 1;
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {
      const close = s.indexOf("*/", i + 2);
      const end = close < 0 ? s.length : close + 2;
      out += s.slice(i, end).replace(/[^\n]/g, " ");
      i = end - 1;
      continue;
    }
    out += ch;
  }
  return out;
}
/**
 * 结构类名计数（A 组专用）：独立词形态 + 前面不能是 "."。
 * 排除 `.nwSection` 形态 → 注释/文档式提法与 querySelector(".nwXxx") 都不算结构节点；
 * 真正的节点写法（className: "nwSection" / classList.add("nwSection")）前面是引号或空格，照算。
 */
function countClassNode(text, name) {
  return countRe(text, new RegExp("(?<![A-Za-z0-9_.])" + name + "(?![A-Za-z0-9_])", "g"));
}
/**
 * 把 `var css = \\`` 模板段切出来：
 * 返回 { ok, open, close, css, js }——css = 反引号内正文；js = 其余部分拼接（结构类名统计只用 js）。
 * 支持转义符与 ${ … } 插值配平；找不到标记 / 未闭合 → ok:false（调用方按致命错误处理）。
 */
function splitCssTemplate(text) {
  const m = /(?:var|const|let)\s+css\s*=\s*`/.exec(text);
  if (!m) return { ok: false, reason: "找不到 `var css = \\`` 模板标记（契约：E 只替换反引号之间的内容）" };
  const open = m.index + m[0].length - 1; // 反引号位置
  let depth = 0, close = -1;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (depth === 0 && ch === "`") { close = i; break; }
    if (depth === 0 && ch === "$" && text[i + 1] === "{") { depth = 1; i++; continue; }
    if (depth > 0) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
  }
  if (close < 0) return { ok: false, reason: "css 模板段未闭合（反引号不配平）" };
  return {
    ok: true,
    open, close,
    css: text.slice(open + 1, close),
    js: text.slice(0, open + 1) + text.slice(close),
    semicolon: /^;/.test(text.slice(close + 1))
  };
}

/**
 * 扫 js 段里的 `style: { … }` 对象，找裸 color:/background:/borderRadius: 字面量。
 * 口径（契约 §7.6 + 头注释说明）：var( / color-mix( 允许 → ok；
 * CSS 全局关键字 → 豁免但记 ⚠；#hex、rgb()/hsl()、无 token 渐变、其它具名色值/px 圆角 → 违规。
 * toOrig：js 段下标 → 原文下标（js 段被抽走了 css 模板，行号必须换算回原文件才可读）；orig = 原文。
 * 返回 { blocks, errors[], warnings[] }。
 */
function scanStyleObjects(js, toOrig, orig) {
  const errors = [], warnings = [];
  let blocks = 0;
  const lineIn = (idx) => lineOf(orig, toOrig(idx));
  const re = /(?<![\w$-])style\s*:\s*\{/g;
  let m;
  while ((m = re.exec(js)) !== null) {
    blocks++;
    const bodyStart = m.index + m[0].length - 1; // 指向 "{"
    let depth = 0, end = -1;
    for (let k = bodyStart; k < js.length; k++) {
      const ch = js[k];
      if (ch === '"' || ch === "'" || ch === "`") { k = skipString(js, k); continue; }
      if (ch === "/" && (js[k + 1] === "/" || js[k + 1] === "*")) { k = skipComment(js, k); continue; }
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end < 0) { errors.push(`行 ${lineIn(m.index)}：style: 对象未闭合`); break; }
    const body = js.slice(bodyStart + 1, end);
    const propRe = /(?<![\w$-])(color|background|borderRadius)\s*:/g;
    let p;
    while ((p = propRe.exec(body)) !== null) {
      const raw = readValue(body, p.index + p[0].length);
      const verdict = classifyStyleValue(p[1], raw);
      const where = `行 ${lineIn(bodyStart + 1 + p.index)}`;
      if (verdict === "violation") errors.push(`${where}：${p[1]}: ${raw}`);
      else if (verdict === "keyword") warnings.push(`${where}：${p[1]}: ${raw}（CSS 全局关键字豁免，同 A-check R1 口径）`);
    }
    re.lastIndex = end + 1; // style 对象不嵌套，跳过正文
  }
  return { blocks, errors, warnings };
}
/** 从 start 起读到顶层 , / } / ;（跨引号、跨括号） */
function readValue(s, start) {
  let depth = 0, out = "";
  for (let k = start; k < s.length; k++) {
    const ch = s[k];
    if (ch === '"' || ch === "'" || ch === "`") { const e = skipString(s, k); out += s.slice(k, e + 1); k = e; continue; }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && (ch === "," || ch === "}" || ch === ";")) break;
    out += ch;
  }
  return out.trim();
}
function classifyStyleValue(prop, raw) {
  const s = String(raw).trim();
  if (/(#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])|rgba?\s*\(|hsla?\s*\()/i.test(s)) return "violation"; // 色值字面量
  if (/var\s*\(/.test(s) || /color-mix\s*\(/.test(s)) return "ok";                              // 契约允许
  if (/(?:linear|radial|conic)-gradient\s*\(/.test(s)) return "violation";                       // 无 token 渐变
  const v = s.replace(/^["'\s]+/, "").replace(/["'\s]+$/, "").toLowerCase();
  if (GLOBAL_KEYWORDS.has(v)) return "keyword";                    // transparent/none/inherit/…
  if (prop === "borderRadius" && (v === "0" || v === "0px")) return "keyword"; // 同 A-check R3
  return "violation";
}

// ================================== 断言执行 ==================================

const items = [];          // { group:"A"|"B", assertion:1..6, id, ok, detail }
const warnings = [];       // ⚠ 豁免（不判红）
function report(group, assertion, id, label, ok, detail) {
  items.push({ group, assertion, id, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${id} ${label} —— ${detail}`);
}
function head(t) { console.log("\n" + t); }

console.log("==================================================================");
console.log(" B 档结构回归测试 · test/ui-structure-test.mjs（契约 §7）");
console.log(" hook 基线 react.use[A-Z] == " + HOOK_BASELINE + "（复测命令见头注释）");
console.log(" 分区：[A] 结构存在性＝集成后才绿 ｜ [B] 不变量＝现在就该绿");
console.log("==================================================================");

// ---------- 读取与切分（失败=致命，直接 exit 1） ----------
let full;
try {
  full = readFileSync(CLIENT_URL, "utf8");
} catch (e) {
  console.error(`✗ FATAL 无法读取 lib/client.js：${(e && e.message) || e}`);
  process.exit(1);
}
const digest = createHash("sha256").update(full).digest("hex");
const parts = splitCssTemplate(full);
if (!parts.ok) {
  console.error(`✗ FATAL css 模板段定位失败：${parts.reason}`);
  process.exit(1);
}
const js = parts.js;
const css = parts.css;
console.log(`读取 lib/client.js：${Buffer.byteLength(full, "utf8")} 字节 / ${full.length} 字符 / sha256 ${digest.slice(0, 16)}…`);
console.log(`css 模板段：[${parts.open}, ${parts.close}] ${css.length} 字符；js 段 ${js.length} 字符${parts.semicolon ? "" : " ⚠ 反引号后未见 `;`（提示级）"}`);

// ---------- 断言 1：结构存在性（A 组） ----------
// 计数口径：js 段**剔除注释后**、且排除 ".类名" 形态 → 只统计真正写在代码字符串里的结构类名
const jsCode = stripComments(js);
head("【A】断言 1 · 结构存在性（js 段·去注释统计；预期：集成前红 / 集成后绿）");
for (const [id, cls, min] of STRUCTURE_MIN) {
  const n = countClassNode(jsCode, cls);
  const glyph = cls === "nwIconSlot" ? `；同段 nwIconGlyph=${countClassNode(jsCode, "nwIconGlyph")}` : "";
  report("A", 1, id, `.${cls} ≥${min}`, n >= min, `js 段实测 ${n}（期望 ≥${min}）${glyph}`);
}
{
  // v6 口径：kicker 字面量收敛进 SectionTitle 组件（uikit 标记区），
  // 结构存在性改判「组件被真实调用 ≥2」——比数散字面量更强的约束。
  const stCalls = countLit(jsCode, "SectionTitle(el, el");
  const ok = stCalls >= 2;
  report("A", 1, "A1.3", "SectionTitle(分区标题) ≥2", ok, `js 段 SectionTitle 调用 ${stCalls}（期望 ≥2；v6 起 kicker 三件套统一经组件渲染，组件定义内 nwKicker=${countClassNode(jsCode, "nwKicker")}）`);
}
{
  // v6 口径：行模式迁移后图标槽两形态并存——遗留 nwIconSlot（导航卡/工具行）+ 新 nwPrefIcon（PreferenceRow 内）。
  const a = countClassNode(jsCode, "nwIconSlot");
  const b = countClassNode(jsCode, "nwPrefIcon");
  const ok = a + b >= 3;
  report("A", 1, "A1.4", "图标槽 ≥3（nwIconSlot+nwPrefIcon）", ok, `js 段 nwIconSlot=${a} + nwPrefIcon=${b}（合计 ${a + b}，期望 ≥3）；同段 nwIconGlyph=${countClassNode(jsCode, "nwIconGlyph")}`);
}
{
  const nk = countClassNode(jsCode, "nwKicker");
  const nr = countClassNode(jsCode, "nwKickerRule");
  const stCalls = countLit(jsCode, "SectionTitle(el, el");
  const ok = nk >= 1 && nr >= 1 && stCalls >= 2;
  report("A", 1, "A1.6", "nwKickerRule 与 nwKicker 成对（v6：由 SectionTitle 组件保证）", ok, `js 段组件内 kicker=${nk} / rule=${nr}、SectionTitle 调用=${stCalls}（期望 kicker≥1 且 rule≥1 且 调用≥2）`);
}

// ---------- 断言 2：测试命脉类存活（B 组） ----------
head("【B】断言 2~6 · 不变量与守卫（预期：现在就全绿）");
{
  const missing = LIFELINE_CLASSES.filter((c) => countToken(full, c) === 0);
  report("B", 2, "B2.1", "测试命脉 11 类在 js+css 存活",
    missing.length === 0,
    `${LIFELINE_CLASSES.length - missing.length}/${LIFELINE_CLASSES.length} 存活` +
    (missing.length ? `，缺失：${missing.join(", ")}` : ""));
  const segBtn = countToken(full, "nwSegBtn");
  const roleTab = countRe(js, /role\s*:\s*"tab"/g) + countRe(js, /role\s*=\s*"tab"/g);
  report("B", 2, "B2.2", "分段存活（nwSegBtn 或 role:\"tab\" 其一）",
    segBtn > 0 || roleTab > 0,
    `nwSegBtn=${segBtn}（js+css），role:"tab"=${roleTab}（js 段）`);
}

// ---------- 断言 3：5.5.0 新增类在 css 段全部有定义（B 组） ----------
{
  const defined = new Set();
  for (const m of css.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)/g)) defined.add(m[1]);
  const missing = NEW_550_CLASSES.filter((c) => !defined.has(c));
  report("B", 3, "B3.1", "5.5.0 新增类在 css 模板段全部有定义（契约 §4.2 冻结清单 34 个）",
    missing.length === 0,
    `${NEW_550_CLASSES.length - missing.length}/${NEW_550_CLASSES.length} 有定义` +
    (missing.length ? `，缺：${missing.join(", ")}` : ""));
}

// ---------- 断言 4：hook 稳定性基线（B 组） ----------
{
  const n = countRe(full, /react\.use[A-Z]/g);
  report("B", 4, "B4.1", `hook 调用点 == 基线 ${HOOK_BASELINE}`,
    n === HOOK_BASELINE,
    `全文 react.use[A-Z] 实测 ${n}` +
    (n === HOOK_BASELINE ? "（持平 ✓）" : n > HOOK_BASELINE ? "（+ 新增 hook → 白屏红线，契约 §1.6）" : "（− hook 被删 → 行为变化，§1.7）") +
    "；复测命令见头注释");
}

// ---------- 断言 5：不变量（B 组，8 个子项） ----------
{
  const nInj = countLit(full, "ctx.inject(");
  report("B", 5, "B5.1", "ctx.inject( == 0（启动安全红线 §1.5）", nInj === 0, `全文实测 ${nInj}`);

  const nSeat = countLit(full, "sidebar.panellist");
  report("B", 5, "B5.2", "sidebar.panellist 仍在", nSeat >= 1, `全文实测 ${nSeat} 处`);

  const nMain = countRe(full, /name:\s*"main"/g);
  report("B", 5, "B5.3", 'name: "main" 席位仍在', nMain >= 1, `全文实测 ${nMain} 处`);

  const nDef = countRe(full, /(?:function\s+createNovelWriterUI|(?:var|let|const)\s+createNovelWriterUI\s*=)/g);
  const nFn = countRe(full, /function\s+createNovelWriterUI/g);
  const nVarDef = countRe(full, /(?:var|let|const)\s+createNovelWriterUI\s*=/g);
  report("B", 5, "B5.4", "createNovelWriterUI 定义恰好 1 次", nDef === 1,
    `定义 ${nDef} 处（function 形 ${nFn} + var/let/const 形 ${nVarDef}；全文提及 ${countLit(full, "createNovelWriterUI")} 次）`);

  const nUiDecl = countRe(full, /\b(?:var|let|const)\s+NW_UI\s*=/g);
  const nUiCreate = countRe(full, /\bvar\s+NW_UI\s*=\s*createNovelWriterUI/g);
  report("B", 5, "B5.5", "var NW_UI = createNovelWriterUI 恰好 1 次", nUiDecl === 1 && nUiCreate === 1,
    `NW_UI 声明 ${nUiDecl} 处，其中 var NW_UI = createNovelWriterUI ${nUiCreate} 处（§1.7 适配层去重口径）`);

  const reqIdx = full.indexOf(PRIMITIVES_REQ);
  const reqCount = countLit(full, PRIMITIVES_REQ);
  let tryIdx = -1;
  if (reqIdx >= 0) {
    const tryRe = /\btry\s*\{/g;
    let tm;
    while ((tm = tryRe.exec(full)) !== null) {
      if (tm.index < reqIdx) tryIdx = tm.index; else break;
    }
  }
  report("B", 5, "B5.6", "primitives require 出现在 try { 之后（§1.5）", reqCount === 1 && tryIdx >= 0,
    `require ×${reqCount}` +
    (reqCount === 1 && tryIdx >= 0
      ? `，前置 try @行 ${lineOf(full, tryIdx)} < require @行 ${lineOf(full, reqIdx)}`
      : reqCount !== 1 ? "（必须恰好 1 次）" : "（require 之前找不到 try {）"));

  const replay = spawnSync(process.execPath, [fileURLToPath(new URL("../tools/build-client.mjs", import.meta.url)), "--check"], { encoding: "utf8" });
  report("B", 5, "B5.7", "client.js 与仓库内构建源重放一致", replay.status === 0,
    (replay.stdout || replay.stderr || replay.error?.message || "无输出").trim());

  let toolsCount = null, toolsSource = "";
  try {
    const mod = await import(CORE_URL.href);
    if (Array.isArray(mod.ALL_TOOLS)) { toolsCount = mod.ALL_TOOLS.length; toolsSource = "动态 import('../lib/core.js').ALL_TOOLS"; }
  } catch (e) {
    toolsSource = `import 失败：${(e && e.message) || e}`;
  }
  if (toolsCount === null) {
    // 降级：正则统计 export const ALL_TOOLS = Object.freeze([ … ]) 里的字符串字面量
    try {
      const src = readFileSync(CORE_URL, "utf8");
      const mm = /export\s+const\s+ALL_TOOLS\s*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]\s*\)/.exec(src);
      if (mm) {
        toolsCount = (mm[1].match(/"[^"]+"|'[^']+'/g) || []).length;
        toolsSource = `正则降级（${toolsSource || "未导出数组"}）`;
      } else {
        toolsSource = `正则降级失败（未检出 ALL_TOOLS 字面量；${toolsSource}）`;
      }
    } catch (e) {
      toolsSource = `正则降级读取失败：${(e && e.message) || e}`;
    }
  }
  report("B", 5, "B5.8", `ALL_TOOLS == ${EXPECTED_ALL_TOOLS}`,
    toolsCount === EXPECTED_ALL_TOOLS,
    `实测 ${toolsCount === null ? "无法统计" : toolsCount}（来源：${toolsSource}）`);
}

// ---------- 断言 6：结构禁区（B 组） ----------
{
  const cssBad = [
    ["B6.1", "@media (prefers-color-scheme", /@media\s*\(prefers-color-scheme/],
    ["B6.2", "[data-ds-dark-theme", /\[data-ds-dark-theme/],
    ["B6.3", "::-webkit-scrollbar", /::-webkit-scrollbar/]
  ];
  for (const [id, label, re] of cssBad) {
    const n = countRe(css, re);
    report("B", 6, id, `css 模板段内无 ${label}`, n === 0, `css 段实测 ${n} 处`);
  }
  // js 段 = 原文[0..open] + 原文[close..]：下标换算回原文件，行号才对得上真实 client.js
  const jsToOrig = (i) => (i <= parts.open ? i : parts.close + (i - (parts.open + 1)));
  const sty = scanStyleObjects(js, jsToOrig, full);
  for (const w of sty.warnings) warnings.push(`lib/client.js ${w}`);
  report("B", 6, "B6.4", "style: 对象无裸 color/background/borderRadius 字面量",
    sty.errors.length === 0,
    `扫描 ${sty.blocks} 个 style: 对象（js 段），违规 ${sty.errors.length}` +
    (sty.errors.length ? `：${sty.errors.slice(0, 5).join("；")}${sty.errors.length > 5 ? " …" : ""}` : "") +
    `；全局关键字豁免 ${sty.warnings.length} 条` +
    (sty.warnings.length ? "（见下方 ⚠，不判红）" : ""));
}

// ---------- ⚠ 豁免警告（不判红，但必须让总负责人看见） ----------
if (warnings.length) {
  console.log("\n⚠ 豁免警告（判绿，仅提示）：");
  for (const w of warnings) console.log(`   - ${w}`);
}

// ================================== 汇总 ====================================

function agg(num, label) {
  const xs = items.filter((i) => i.assertion === num);
  const ok = xs.every((i) => i.ok);
  console.log(` ${ok ? "✓" : "✗"} 断言 ${num} ${label} —— ${xs.filter((i) => i.ok).length}/${xs.length} 子项通过`);
  return ok;
}
console.log("\n==================================================================");
console.log("汇总（对照契约 §7 断言 1~8）");
agg(1, "结构存在性 [A 组·预期集成后才全绿]");
agg(2, "测试命脉类存活 [B 组]");
agg(3, "5.5.0 新增类 CSS 定义全集 [B 组]");
agg(4, `hook 稳定性基线 == ${HOOK_BASELINE} [B 组]`);
agg(5, "启动/席位/适配层/哈希/工具数 不变量 [B 组]");
agg(6, "结构禁区（css 模板段 + style: 对象）[B 组]");
console.log(` ✓ 断言 7 输出格式与退出码 —— 本运行即「逐项 ✓/✗ + 明细 + 末行汇总」，存在任一 ✗ → exit 1（由代码路径自证）`);
console.log(` ✓ 断言 8 红绿分区 —— 见下方两行（当前已绿 / 待集成后变绿）`);

const fail = items.filter((i) => !i.ok);
const greenIds = items.filter((i) => i.ok).map((i) => i.id);
const redA = fail.filter((i) => i.group === "A").map((i) => i.id);
const redB = fail.filter((i) => i.group === "B").map((i) => i.id);
console.log(`\n 当前已绿（${greenIds.length}/${items.length}）：${greenIds.join(", ") || "（无）"}`);
console.log(` 待集成后变绿（A 组红项，写于集成前属预期）：${redA.join(", ") || "（无 —— 结构已全部就位）"}`);
if (redB.length) console.log(` ⚠⚠ B 组红项（不变量回归，任何阶段都不该出现，必须立即处理）：${redB.join(", ")}`);

if (fail.length) {
  console.log(`\n判定：FAIL —— ${fail.length}/${items.length} 项未过 → exit 1`);
  process.exitCode = 1;
} else {
  console.log(`\n判定：PASS —— 全部 ${items.length} 项通过 → exit 0`);
  process.exitCode = 0;
}
