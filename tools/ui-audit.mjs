#!/usr/bin/env node
/**
 * C-audit.mjs —— dsh-novel-writer UI 改造 · 规则审计 CLI
 *
 * 用法：
 *   node C-audit.mjs <client.js 路径> [--json] [--tokens <tokens.md>] [--classes <classes.txt>]
 *                                    [--skip 1,7] [--max-text <n>]
 *
 * 判定契约 §6 的 11 条规则（R1..R10 + 汇总）。有「错误」级违规时退出码 = 1；
 * 只有「提示(warn)」级发现时退出码 = 0（低误报策略：边界写法降级为提示，见 C-notes.md）。
 * 退出码：0 = PASS / 1 = FAIL（有 error）/ 2 = 用法或 IO 致命错误。
 *
 * 实现要点：
 *   1) 先对整个文件做「区域词法扫描」，标出 CSS 模板串 / JS 字符串 / 注释 / 普通代码；
 *   2) CSS 区域按「规则块 + 声明」两级解析，所有需要「同一规则块内」的规则都基于该结构；
 *   3) JS 区域按字符串字面量与 style 对象字面量定位，避免正则误伤注释与 CSS；
 *   4) 所有检查只依赖 Node 内置模块，无外部依赖。
 *
 * 该工具只读输入文件，不写任何东西。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOKENS = path.join(HERE, "tokens.md");
const DEFAULT_CLASSES = path.join(HERE, "classes.txt");

/* ------------------------------------------------------------------ *
 * 0. 常量
 * ------------------------------------------------------------------ */

const RULE_NAMES = {
  1: "CSS 颜色字面量",
  2: "JS 内联样式违规",
  3: "中性边框 0.5px",
  4: "圆角尺度",
  5: "elevation 与 alias 边框互斥",
  6: "font-size 配 line-height",
  7: "主题选择器 / 自定义滚动条",
  8: "token 白名单",
  9: "类名契约",
  10: "启动安全",
};

const CLS_CODE = 0;
const CLS_STR = 1;
const CLS_COMMENT = 2;
const CLS_CSS = 3;

const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;
const FUNC_COLOR_RE = /\b(?:rgba?|hsla?|hwb)\s*\(/gi;
const GRADIENT_RE = /\b(?:linear|radial|conic|repeating-linear|repeating-radial|repeating-conic)-gradient\s*\(/gi;

const NAMED_COLORS = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black",
  "blanchedalmond", "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse",
  "chocolate", "coral", "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan",
  "darkgoldenrod", "darkgray", "darkgrey", "darkgreen", "darkkhaki", "darkmagenta",
  "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink",
  "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen",
  "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "grey", "green",
  "greenyellow", "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender",
  "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan",
  "lightgoldenrodyellow", "lightgray", "lightgrey", "lightgreen", "lightpink", "lightsalmon",
  "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue",
  "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon", "mediumaquamarine",
  "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
  "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream",
  "mistyrose", "moccasin", "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange",
  "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise", "palevioletred",
  "papayawhip", "peachpuff", "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple",
  "red", "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell",
  "sienna", "silver", "skyblue", "slateblue", "slategray", "slategrey", "snow", "springgreen",
  "steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white",
  "whitesmoke", "yellow", "yellowgreen",
]);

/** 可能承载颜色的 CSS 属性（只对这些属性做「颜色关键字」检查，避免误伤 white-space 之类） */
const COLOR_PROPS = new Set([
  "color", "background", "background-color", "background-image", "border", "border-top",
  "border-right", "border-bottom", "border-left", "border-color", "border-top-color",
  "border-right-color", "border-bottom-color", "border-left-color", "border-block-color",
  "border-inline-color", "box-shadow", "text-shadow", "outline", "outline-color", "fill",
  "stroke", "caret-color", "accent-color", "text-decoration-color", "column-rule",
  "column-rule-color", "-webkit-text-fill-color", "scrollbar-color", "stop-color",
  "flood-color", "lighting-color", "text-emphasis-color",
]);

/** 承载颜色的 JS style 键（小写比较） */
const COLOR_KEYS = new Set([
  "color", "background", "backgroundcolor", "backgroundimage", "bordercolor", "bordertopcolor",
  "borderrightcolor", "borderbottomcolor", "borderleftcolor", "border", "bordertop",
  "borderright", "borderbottom", "borderleft", "boxshadow", "textshadow", "outline",
  "outlinecolor", "fill", "stroke", "caretcolor", "accentcolor", "webkittextfillcolor",
  "textdecorationcolor", "stopcolor",
]);

const BORDER_SHORTHAND_RE = /^border(?:-(?:top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?$/;
const BORDER_WIDTH_RE = /^border(?:-(?:top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?-width$/;
const BORDER_ANY_RE = /^border(?:$|-)/;
/** 状态语义色：命中即允许 1px（契约给的是 state-/error/success/warn，这里按语义扩到 status/danger） */
const STATE_COLOR_RE = /(state-|status-|error|success|warn|danger)/i;

/**
 * 契约 §3.5 明文规定的设置卡片材质 token —— 它们不在 tokens.md（362 个，按已装机包取证）里，
 * 但 CONTRACT.md 直接点名要求使用，故内置放行并在输出里注明（不静默）。
 */
const CONTRACT_ALLOWED_TOKENS = new Set([
  "--dsw-alias-settings-card-fill",
  "--dsw-alias-settings-card-stroke",
]);

const RADIUS_PROP_RE = /^border-(?:[a-z-]*-)?radius$/;

/* ------------------------------------------------------------------ *
 * 1. 基础工具
 * ------------------------------------------------------------------ */

function buildLineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineAt(lineStarts, off) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  if (off <= 0) return 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= off) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function snippet(text, max = 64) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 顶层切分：在括号深度 0、引号之外按分隔符切开（分隔符集合由参数给） */
function splitTop(value, sepRe) {
  const out = [];
  let cur = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (quote) {
      cur += c;
      if (c === quote && value[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === "(" || c === "[") { depth += 1; cur += c; continue; }
    if (c === ")" || c === "]") { depth = Math.max(0, depth - 1); cur += c; continue; }
    if (depth === 0 && sepRe.test(c)) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** 取一个值里所有「裸单词」（不限括号深度；url()/var() 内的整串不会被拆开） */
function bareWords(value) {
  return value.split(/[\s,()]+/).map((s) => s.trim()).filter(Boolean);
}

function unquote(s) {
  const t = String(s).trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) return t.slice(1, -1);
  return t;
}

/** camelCase -> kebab-case（JS 内联样式键名转 CSS 属性名） */
function toKebab(s) {
  return String(s).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/* ------------------------------------------------------------------ *
 * 2. 区域词法扫描：CSS 模板串 / JS 字符串 / 注释 / 代码
 * ------------------------------------------------------------------ */

/**
 * 返回 { cls: Uint8Array, strings: [], cssBlocks: [{start,end,ident,interpRanges,kind}] }
 * cls[k]：0=代码 1=字符串或正则字面量 2=注释 3=CSS 模板内容
 */
function lex(src) {
  const n = src.length;
  const cls = new Uint8Array(n);
  const strings = [];
  const templates = [];
  const cssBlocks = [];
  const REGEX_PREV = new Set("(,=:[!&|?{};+-*%~^<>".split(""));
  const REGEX_KEYWORDS = new Set([
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do",
    "else", "yield", "await", "throw",
  ]);

  const mark = (a, b, klass) => {
    for (let k = a; k < b && k < n; k += 1) if (src[k] !== "\n") cls[k] = klass;
  };

  /** 从 pos 往前找 `ident =`，用于判断「这个模板串/字符串是不是 CSS」 */
  const identBefore = (pos) => {
    let i = pos - 1;
    while (i >= 0 && /\s/.test(src[i])) i -= 1;
    if (src[i] !== "=") return null;
    i -= 1;
    while (i >= 0 && /\s/.test(src[i])) i -= 1;
    const end = i + 1;
    while (i >= 0 && /[A-Za-z0-9_$]/.test(src[i])) i -= 1;
    const word = src.slice(i + 1, end);
    if (!word) return null;
    // 属性访问（obj.pluginCss = "…"）不算 CSS 变量声明
    if (src[i] === "." || (src[i] === "?" && src[i - 1] === ".")) return null;
    return word;
  };

  /** 变量名像 CSS 且内容确实像样式表（含 {} 与 :），才认作 CSS 块——避免 dataset.pluginCss 之类误判 */
  const isCssIdent = (word, content) => {
    if (!word || !/css$/i.test(word)) return false;
    if (/^(cssTag|cssTags|cssText|cssClass|cssModules?|cssHref)$/.test(word)) return false;
    if (!content || !content.includes("{") || !content.includes(":")) return false;
    return content.length > 40;
  };

  let regexOK = true;

  function scanString(i, isTemplate) {
    const q = isTemplate ? "`" : src[i];
    let j = i + 1;
    const interpRanges = [];
    let terminated = false;
    while (j < n) {
      const c = src[j];
      if (c === "\\") { j += 2; continue; }
      if (!isTemplate && c === "\n") break;
      if (c === q) { j += 1; terminated = true; break; }
      if (isTemplate && c === "$" && src[j + 1] === "{") {
        const innerStart = j + 2;
        const end = scanCode(innerStart, true);
        interpRanges.push([innerStart, Math.min(end + 1, n)]);
        j = end + 1;
        continue;
      }
      j += 1;
    }
    const contentEnd = terminated ? j - 1 : j;
    mark(i, j, isTemplate ? CLS_CODE : CLS_STR);
    const rec = {
      start: i, end: j, contentStart: i + 1, contentEnd, quote: q, interpRanges,
      value: src.slice(i + 1, contentEnd), terminated,
    };
    if (isTemplate) templates.push(rec);
    else strings.push(rec);
    const word = identBefore(i);
    if (isCssIdent(word, rec.value)) {
      cssBlocks.push({
        start: i + 1, end: contentEnd, ident: word, interpRanges,
        kind: isTemplate ? "template" : "string", srcStart: i,
      });
    }
    return j;
  }

  function scanRegex(i) {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j];
      if (c === "\\") { j += 2; continue; }
      if (c === "\n") break;
      if (inClass) { if (c === "]") inClass = false; j += 1; continue; }
      if (c === "[") { inClass = true; j += 1; continue; }
      if (c === "/") { j += 1; break; }
      j += 1;
    }
    while (j < n && /[a-z]/i.test(src[j])) j += 1;
    mark(i, j, CLS_STR);
    return j;
  }

  function scanCode(start, stopOnBrace) {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") {
        const e = src.indexOf("\n", i);
        const end = e === -1 ? n : e;
        mark(i, end, CLS_COMMENT);
        i = end;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        const e = src.indexOf("*/", i + 2);
        const end = e === -1 ? n : e + 2;
        mark(i, end, CLS_COMMENT);
        i = end;
        continue;
      }
      if (c === '"' || c === "'") { i = scanString(i, false); regexOK = false; continue; }
      if (c === "`") { i = scanString(i, true); regexOK = false; continue; }
      if (c === "/" && regexOK) { i = scanRegex(i); regexOK = false; continue; }
      if (stopOnBrace) {
        if (c === "{") depth += 1;
        else if (c === "}") { if (depth === 0) return i; depth -= 1; }
      }
      if (!/\s/.test(c)) {
        if (/[A-Za-z_$]/.test(c)) {
          let w = i;
          while (w < n && /[A-Za-z0-9_$]/.test(src[w])) w += 1;
          regexOK = REGEX_KEYWORDS.has(src.slice(i, w));
          i = w;
          continue;
        }
        if (/[0-9]/.test(c)) { regexOK = false; i += 1; continue; }
        regexOK = REGEX_PREV.has(c);
      }
      i += 1;
    }
    return n;
  }

  scanCode(0, false);

  // CSS 区域标灰（模板内容 + 其中的插值）
  for (const blk of cssBlocks) mark(blk.start, blk.end, CLS_CSS);
  return { cls, strings, templates, cssBlocks };
}

/* ------------------------------------------------------------------ *
 * 3. CSS 解析：区域 -> 规则 -> 声明
 * ------------------------------------------------------------------ */

/** 把 CSS 区域渲染成纯文本 + 每字符对应的源码行号（注释变空格，插值变空格） */
function buildCss(src, lineStarts, blk) {
  const len = blk.end - blk.start;
  const chars = new Array(len);
  const lines = new Uint32Array(len);
  for (let k = 0; k < len; k += 1) {
    const off = blk.start + k;
    chars[k] = src[off];
    lines[k] = lineAt(lineStarts, off);
  }
  if (blk.interpRanges) {
    for (const [a, b] of blk.interpRanges) {
      for (let off = a; off < b; off += 1) {
        const k = off - blk.start;
        if (k < 0 || k >= len) continue;
        if (chars[k] !== "\n") chars[k] = " ";
      }
    }
  }
  let text = chars.join("");
  // 注释：先记录范围（相对 CSS 文本，未做任何等长替换前与源码 offset 一一对应），再换等长空格
  const comments = [];
  const commentRe = /\/\*[\s\S]*?\*\//g;
  let cm;
  while ((cm = commentRe.exec(text)) !== null) comments.push([cm.index, cm.index + cm[0].length]);
  text = text.replace(commentRe, (m) => m.replace(/[^\n]/g, " "));
  if (blk.kind === "string") {
    // 字符串形态的 CSS：把 \n 等转义还原（行号用近似映射即可）
    text = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }
  return { text, lines, comments, ident: blk.ident, kind: blk.kind };
}

function matchBrace(text, openIdx, limit) {
  let depth = 0;
  for (let i = openIdx; i < limit; i += 1) {
    const c = text[i];
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) return i; }
  }
  return limit;
}

function hasTopLevelBrace(text, from, to) {
  let depth = 0;
  for (let i = from; i < to; i += 1) {
    const c = text[i];
    if (c === "{") { if (depth === 0) return true; depth += 1; }
    else if (c === "}") depth = Math.max(0, depth - 1);
  }
  return false;
}

function parseDecls(text, from, to) {
  const decls = [];
  for (const chunk of splitTop(text.slice(from, to), /[;]/)) {
    const raw = chunk;
    if (!raw.trim()) continue;
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    let depth = 0;
    let quote = null;
    let colon = -1;
    for (let i = 0; i < body.length; i += 1) {
      const c = body[i];
      if (quote) { if (c === quote && body[i - 1] !== "\\") quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === "(") depth += 1;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if (c === ":" && depth === 0) { colon = i; break; }
    }
    if (colon <= 0) continue;
    const prop = body.slice(0, colon).trim();
    const value = body.slice(colon + 1).trim();
    if (!prop || !value) continue;
    decls.push({ prop, propLower: prop.toLowerCase(), value, offset: from + lead });
  }
  return decls;
}

function parseRules(text, from, to, out) {
  let i = from;
  let preludeStart = from;
  while (i < to) {
    const c = text[i];
    if (c === "{") {
      const close = matchBrace(text, i, to);
      const selector = text.slice(preludeStart, i);
      const rule = {
        selector,
        selectorStart: preludeStart,
        bodyStart: i + 1,
        bodyEnd: close,
        decls: [],
        children: [],
      };
      if (hasTopLevelBrace(text, i + 1, close)) parseRules(text, i + 1, close, rule.children);
      else rule.decls = parseDecls(text, i + 1, close);
      out.push(rule);
      i = close + 1;
      preludeStart = i;
      continue;
    }
    if (c === "}" || c === ";") { i += 1; preludeStart = i; continue; }
    i += 1;
  }
  return out;
}

/** 展平所有规则（含 @media / @keyframes 内部） */
function flattenRules(rules, acc = []) {
  for (const r of rules) {
    acc.push(r);
    if (r.children && r.children.length) flattenRules(r.children, acc);
  }
  return acc;
}

/* ------------------------------------------------------------------ *
 * 4. 白名单 / 契约清单
 * ------------------------------------------------------------------ */

function loadTokens(file) {
  const text = fs.readFileSync(file, "utf8");
  const names = new Set();
  const prefixFamilies = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = /^-\s+`(--dsw-[A-Za-z0-9_-]*)`/.exec(line.trim());
    if (!m) continue;
    const name = m[1];
    if (name.endsWith("-")) prefixFamilies.add(name);
    else names.add(name);
  }
  return { names, prefixFamilies, file };
}

function loadClasses(file) {
  const text = fs.readFileSync(file, "utf8");
  const list = [];
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim();
    if (!name || name.startsWith("#")) continue;
    list.push(name);
  }
  return { list, file };
}

/* ------------------------------------------------------------------ *
 * 5. 审计主体
 * ------------------------------------------------------------------ */

class Reporter {
  constructor() {
    this.items = [];
    this.notes = [];
  }

  add(rule, line, kind, detail, desc, severity = "error", keySuffix = "") {
    const key = `${rule}|${line}|${kind}${keySuffix ? `|${keySuffix}` : ""}`;
    this.items.push({ rule, line, kind, detail, desc, severity, key });
  }

  note(msg) { this.notes.push(msg); }
}

function analyze(src, opts) {
  const rep = new Reporter();
  const lineStarts = buildLineStarts(src);
  const lexed = lex(src);
  const { cls, strings, cssBlocks } = lexed;
  const skip = opts.skip || new Set();
  const enabled = (r) => !skip.has(r);

  /* ---------- CSS 区域 ---------- */
  const cssDocs = cssBlocks.map((b) => buildCss(src, lineStarts, b));
  // CSS 注释在全局 cls 里标成 CLS_COMMENT，供「扫全文」的规则（R8）跳过
  cssBlocks.forEach((b, i) => {
    const doc = cssDocs[i];
    if (!doc || !doc.comments) return;
    for (const [a, z] of doc.comments) {
      for (let k = b.start + a; k < b.start + z && k < src.length; k += 1) {
        if (src[k] !== "\n") cls[k] = CLS_COMMENT;
      }
    }
  });
  if (cssDocs.length === 0) {
    rep.add(1, 1, "no-css-template", "", "未检出 CSS 模板（期望 `const CSS = \\`…\\``）——R1/R3~R7/R9 的 CSS 侧无法审计", "error");
    rep.note("未检出 CSS 模板：请确认文件里有 const CSS = `…`（或 var css = `…`）形态的样式块。");
  } else {
    rep.note(`CSS 模板：${cssDocs.map((d) => `${d.ident}(${d.kind}, ${d.text.length} 字符)`).join("、")}`);
  }

  const allRules = [];
  for (const doc of cssDocs) {
    doc.rules = parseRules(doc.text, 0, doc.text.length, []);
    for (const r of flattenRules(doc.rules)) allRules.push({ rule: r, doc });
  }
  const lineOfCss = (doc, off) => doc.lines[Math.max(0, Math.min(doc.lines.length - 1, off))] || 1;

  // R1 附加项：CSS 括号平衡（语法错误会让浏览器丢弃/误解析规则，也会让本工具的 CSS 侧检查在受影响区域失效）
  for (const doc of cssDocs) {
    const stack = [];
    const extra = [];
    for (let i = 0; i < doc.text.length; i += 1) {
      const c = doc.text[i];
      if (c === "{") stack.push(i);
      else if (c === "}") { if (stack.length) stack.pop(); else extra.push(lineOfCss(doc, i)); }
    }
    if (stack.length || extra.length) {
      const lines = [...new Set(stack.map((o) => lineOfCss(doc, o)))].slice(0, 8);
      const detail = `${stack.length} 个 { 未闭合${lines.length ? `（行 ${lines.join("、")}）` : ""}${extra.length ? `；${extra.length} 个多余的 }（行 ${[...new Set(extra)].slice(0, 8).join("、")}）` : ""}`;
      rep.add(1, lines[0] || 1, "css-syntax", detail, `CSS 括号不平衡（${doc.ident}）：语法错误会导致浏览器丢弃规则，本工具在受影响区域也会漏检——请先修 CSS 语法`);
      rep.note(`⚠ ${doc.ident}：${detail}。`);
    }
  }

  // 「同一行」宽松判断用：源码行号 -> 该行出现过的标记（line-height / corner-shape: round）
  const cssLineHas = new Map(); // docIndex -> Map<srcLine, Set<marker>>
  const addMarker = (docIdx, line, marker) => {
    if (!cssLineHas.has(docIdx)) cssLineHas.set(docIdx, new Map());
    const m = cssLineHas.get(docIdx);
    if (!m.has(line)) m.set(line, new Set());
    m.get(line).add(marker);
  };
  cssDocs.forEach((doc, di) => {
    let offset = 0;
    for (const ln of doc.text.split("\n")) {
      const srcLine = doc.lines[Math.min(offset, doc.lines.length - 1)] || 1;
      if (/line-height\s*:/.test(ln)) addMarker(di, srcLine, "line-height");
      if (/corner-shape\s*:\s*(?:round|var\()/.test(ln)) addMarker(di, srcLine, "corner-shape-round");
      offset += ln.length + 1;
    }
  });
  const lineHasMarker = (di, srcLine, marker) => {
    const m = cssLineHas.get(di);
    return !!(m && m.has(srcLine) && m.get(srcLine).has(marker));
  };

  /* ---------- R1：CSS 颜色字面量 ---------- */
  if (enabled(1)) {
    cssDocs.forEach((doc, di) => {
      const text = doc.text;
      const pushMatches = (re, kind, desc) => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          const line = lineOfCss(doc, m.index);
          rep.add(1, line, kind, snippet(m[0], 40), desc, "error");
          if (re.lastIndex === m.index) re.lastIndex += 1;
        }
      };
      pushMatches(HEX_RE, "css-hex", "CSS 颜色字面量（十六进制）");
      pushMatches(FUNC_COLOR_RE, "css-func", "CSS 颜色字面量（rgb/hsl 函数）");
      // 颜色关键字：只查「可能承载颜色」的声明值
      for (const { rule, } of allRules.filter((x) => x.doc === doc)) {
        for (const d of rule.decls) {
          if (!COLOR_PROPS.has(d.propLower)) continue;
          if (/url\(/i.test(d.value)) continue;
          for (const w of bareWords(d.value)) {
            const low = w.toLowerCase();
            if (NAMED_COLORS.has(low)) {
              rep.add(1, lineOfCss(doc, d.offset), "css-named", `${d.prop}:${w}`, "CSS 颜色字面量（颜色关键字）", "error");
            }
          }
        }
      }
    });
  }

  /* ---------- R3：中性边框 0.5px ---------- */
  const checkBorderDecl = (propLower, value, emit) => {
    if (!(BORDER_SHORTHAND_RE.test(propLower) || BORDER_WIDTH_RE.test(propLower))) return;
    const dashed = /\b(dashed|dotted)\b/i.test(value);
    const stateful = STATE_COLOR_RE.test(value);
    const tokens = splitTop(value, /[\s]/).map((s) => s.trim()).filter(Boolean);
    const numeric = [];
    for (const t of tokens) {
      const m = /^(\d*\.?\d+)(px|rem|em|pt|%|vw|vh)?$/.exec(t);
      if (m) numeric.push({ raw: t, num: parseFloat(m[1]), unit: m[2] || "" });
      else if (/^(thin|medium|thick)$/i.test(t)) numeric.push({ raw: t, num: NaN, unit: "" });
    }
    if (!numeric.length) return; // none / 纯颜色 / 纯样式
    if (dashed) return;          // dashed / dotted 记号豁免
    if (stateful) return;        // 状态语义色豁免
    for (const w of numeric) {
      if (w.num === 0) continue;
      const isHalf = w.unit === "px" && Math.abs(w.num - 0.5) < 1e-9;
      if (isHalf) continue;
      if (/transparent|none\b/i.test(value)) {
        emit("warn", `border:${snippet(value, 40)}`, "1px 透明/无色边框（中性边框规范为 0.5px；若只是占位可改 0.5px）");
        continue;
      }
      emit("error", `${propLower}:${snippet(value, 46)}`, "中性边框宽度必须为 0.5px（仅 dashed 与状态语义色可 1px）");
    }
  };

  if (enabled(3)) {
    for (const { rule, doc } of allRules) {
      for (const d of rule.decls) {
        checkBorderDecl(d.propLower, d.value, (sev, detail, desc) => {
          rep.add(3, lineOfCss(doc, d.offset), sev === "warn" ? "border-warn" : "border-width", detail, desc, sev);
        });
      }
    }
  }

  /* ---------- R4：圆角 ---------- */
  if (enabled(4)) {
    for (const { rule, doc } of allRules) {
      const blockHasCorner = rule.decls.some((d) => d.propLower === "corner-shape" && /(round|var\()/i.test(d.value));
      for (const d of rule.decls) {
        if (!RADIUS_PROP_RE.test(d.propLower)) continue;
        const parts = d.value.split("/").flatMap((p) => splitTop(p, /[\s]/)).map((s) => s.trim()).filter(Boolean);
        for (const part of parts) {
          const low = part.toLowerCase();
          if (/^(0|0px|0%|inherit|initial|unset|revert|revert-layer)$/.test(low)) continue;
          if (/^var\(\s*--dsw-radius-/.test(part)) continue;
          const isCapsule = /^(50%|999px|9999px)$/.test(low);
          if (isCapsule) {
            const line = lineOfCss(doc, d.offset);
            const di = cssDocs.indexOf(doc);
            if (blockHasCorner || lineHasMarker(di, line, "corner-shape-round")) continue;
            rep.add(4, line, "radius-capsule", `${d.propLower}:${snippet(d.value, 40)}`, "50%/999px 胶囊圆角必须配对 corner-shape: round", "error");
            continue;
          }
          rep.add(4, lineOfCss(doc, d.offset), "radius-value", `${d.propLower}:${snippet(d.value, 40)}`, "圆角只能用 var(--dsw-radius-*)/0（胶囊见 corner-shape 规则）", "error");
        }
      }
    }
  }

  /* ---------- R5：elevation 与 alias 边框互斥 ---------- */
  if (enabled(5)) {
    for (const { rule, doc } of allRules) {
      const hasElevation = rule.decls.some((d) => /var\(\s*--dsw-elevation-/.test(d.value));
      if (!hasElevation) continue;
      const zeroed = rule.decls.some((d) => (BORDER_SHORTHAND_RE.test(d.propLower) || BORDER_WIDTH_RE.test(d.propLower)) &&
        /(^|[^\d.])0(px)?(\s|$)|none\b/i.test(d.value));
      for (const d of rule.decls) {
        if (!BORDER_ANY_RE.test(d.propLower)) continue;
        if (!/var\(\s*--dsw-alias-border-/.test(d.value)) continue;
        const isWidthDecl = BORDER_SHORTHAND_RE.test(d.propLower) || BORDER_WIDTH_RE.test(d.propLower);
        const ownZero = isWidthDecl && /(^|[^\d.])0(px)?(\s|$)|none\b/i.test(d.value);
        if (ownZero || (!isWidthDecl && zeroed)) continue;
        rep.add(5, lineOfCss(doc, d.offset), "elevation-border", `${d.propLower}:${snippet(d.value, 40)}`,
          "使用 --dsw-elevation-* 的表面不得再加 --dsw-alias-border-* 边框（elevation 自带发丝描边）", "error");
      }
    }
  }

  /* ---------- R6：font-size 配 line-height ---------- */
  if (enabled(6)) {
    for (const { rule, doc } of allRules) {
      const fs = rule.decls.filter((d) => d.propLower === "font-size");
      if (!fs.length) continue;
      const hasLHDecl = rule.decls.some((d) => d.propLower === "line-height");
      const hasFontShorthand = rule.decls.some((d) => d.propLower === "font" && d.value.includes("/"));
      if (hasLHDecl || hasFontShorthand) continue;
      const di = cssDocs.indexOf(doc);
      for (const d of fs) {
        const line = lineOfCss(doc, d.offset);
        if (lineHasMarker(di, line, "line-height")) continue; // 同一行有 line-height 也算
 
        rep.add(6, line, "font-size-pair", `${d.propLower}:${snippet(d.value, 30)}`, "含 font-size 的规则必须配 line-height（同一规则块内或同一行）", "error");
      }
    }
  }

  /* ---------- R7：主题选择器 / 滚动条 ---------- */
  if (enabled(7)) {
    const patterns = [
      [/prefers-color-scheme/g, "theme-media", "不得出现主题选择器 prefers-color-scheme"],
      [/\[data-ds-dark-theme\]/g, "theme-attr", "不得出现主题选择器 [data-ds-dark-theme]"],
      [/(^|[^A-Za-z0-9_$-])\.dark(?![A-Za-z0-9_-])/g, "theme-class", "不得出现主题选择器 .dark"],
      [/::-webkit-scrollbar/g, "scrollbar", "不得自定义滚动条选择器 ::-webkit-scrollbar"],
      [/::-(?:moz|ms)-scrollbar/g, "scrollbar", "不得自定义滚动条选择器"],
    ];
    for (const doc of cssDocs) {
      for (const [re, kind, desc] of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(doc.text)) !== null) {
          rep.add(7, lineOfCss(doc, m.index), kind, snippet(m[0], 40), desc, "error");
          if (re.lastIndex === m.index) re.lastIndex += 1;
        }
      }
    }
    // JS 区域里的字符串也算（例如动态拼选择器）——只报提示
    for (const s of strings) {
      if (/(prefers-color-scheme|\[data-ds-dark-theme\]|::-webkit-scrollbar)/.test(s.value)) {
        rep.add(7, lineAt(lineStarts, s.start), "theme-js", snippet(s.value, 46), "JS 字符串里出现主题选择器/滚动条选择器", "error");
      }
    }
  }

  /* ---------- R8：token 白名单 ---------- */
  if (enabled(8)) {
    const tokenRe = /var\(\s*(--dsw-[A-Za-z0-9_-]+)/g;
    let m;
    tokenRe.lastIndex = 0;
    const seen = new Set();
    const usedContractAllowed = new Set();
    while ((m = tokenRe.exec(src)) !== null) {
      if (cls[m.index] === CLS_COMMENT) continue;
      const name = m[1];
      if (opts.tokens.names.has(name)) continue;
      if (CONTRACT_ALLOWED_TOKENS.has(name)) { usedContractAllowed.add(name); continue; }
      if (opts.extraAllowed && opts.extraAllowed.has(name)) continue;
      if (opts.allowPrefixTokens && [...opts.tokens.prefixFamilies].some((p) => name.startsWith(p))) continue;
      const line = lineAt(lineStarts, m.index);
      const key = `${name}|${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rep.add(8, line, "token-unknown", name, "var(--dsw-*) 不在 tokens.md 白名单内", "error", name);
    }
    if (usedContractAllowed.size) {
      rep.note(`契约 §3.5 明文规定的设置卡片 token 放行（不在 tokens.md 白名单内）：${[...usedContractAllowed].join("、")}。`);
    }
    if (opts.extraAllowed && opts.extraAllowed.size) {
      rep.note(`--allow-token 额外放行：${[...opts.extraAllowed].join("、")}。`);
    }
    if (opts.tokens.prefixFamilies.size) {
      rep.note(`tokens.md 中有 ${opts.tokens.prefixFamilies.size} 个以 - 结尾的前缀条目（${[...opts.tokens.prefixFamilies].join("、")}），默认按「精确名」处理，不加 --allow-prefix-tokens 时不做前缀放行。`);
    }
  }

  /* ---------- 类名契约：CSS 侧统计 ---------- */
  const cssClasses = new Set();
  for (const doc of cssDocs) {
    for (const { rule } of allRules.filter((x) => x.doc === doc)) {
      const sel = rule.selector;
      if (!sel) continue;
      const re = /\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g;
      let m;
      while ((m = re.exec(sel)) !== null) cssClasses.add(m[1]);
    }
  }

  /* ---------- R9：类名契约双向 ---------- */
  if (enabled(9)) {
    for (const name of opts.classes.list) {
      if (cssClasses.has(name)) continue;
      rep.add(9, 0, "class-missing-css", name, "classes.txt 的类名在 CSS 中未定义", "error", name);
    }
    // JS 侧：className 用到的 nw* 类名
    const jsUsed = new Map(); // name -> {line, severity}
    const isNwToken = (t) => /^nw[A-Za-z0-9_]+$/.test(t);
    const cssSrcStarts = new Set(cssBlocks.map((b) => b.srcStart));
    const lookback = (start, maxLen) => {
      let i = start - 1;
      const from = Math.max(0, i - maxLen);
      let seg = "";
      for (; i >= from; i -= 1) {
        if (cls[i] === CLS_COMMENT) continue;
        const c = src[i];
        if (c === ";" || c === "{" || c === "}") break;
        seg = c + seg;
      }
      return seg;
    };
    const lookbackIsClassName = (start) => /className\s*:\s*[^;{}]*$/.test(lookback(start, 220));
    /** 元素 id / 选择器，不是类名：getElementById("nwX")、{ id: "nwX" }、setAttribute("id","nwX") */
    const lookbackIsId = (start) => {
      const seg = lookback(start, 60);
      if (/(?:getElementById|querySelector|querySelectorAll)\s*\(\s*$/.test(seg)) return true;
      if (/(?:^|[^\w$])id\s*[:(,]\s*$/.test(seg)) return true;
      return false;
    };
    for (const s of strings) {
      const value = s.value;
      if (!/nw[A-Za-z0-9_]/.test(value)) continue;
      if (cssSrcStarts.has(s.start)) continue;                 // CSS 块（引号形态）不算 JS 用法
      if (lookbackIsId(s.start)) continue;                     // 元素 id，不是类名
      const tokens = value.split(/[\s]+/).map((t) => t.trim()).filter(Boolean);
      if (!tokens.length) continue;
      const allNw = tokens.every(isNwToken);
      const nearClassName = lookbackIsClassName(s.start);
      if (!allNw && !nearClassName) continue;
      const line = lineAt(lineStarts, s.start);
      for (const t of tokens) {
        if (!isNwToken(t)) continue;
        const sev = nearClassName ? "error" : "warn";
        const prev = jsUsed.get(t);
        if (!prev || (prev.severity === "warn" && sev === "error")) jsUsed.set(t, { line, severity: sev, value });
      }
    }
    // 模板串里的 nw* 类名（className: `nwA ${x}` 形态）——按提示级处理
    // 注意：CSS 模板也是模板串，必须排除（否则 @keyframes nwspin 之类动画名会被当类名）
    for (const t of lexed.templates) {
      if (cssSrcStarts.has(t.start)) continue;
      const v = t.value;
      if (!/nw[A-Za-z0-9_]/.test(v)) continue;
      const line = lineAt(lineStarts, t.start);
      for (const tok of v.split(/[\s${}]+/)) {
        if (!isNwToken(tok)) continue;
        if (jsUsed.has(tok)) continue;
        jsUsed.set(tok, { line, severity: "warn", value: v });
      }
    }
    for (const [name, info] of jsUsed) {
      if (cssClasses.has(name)) continue;
      rep.add(9, info.line, "class-js-undef", name,
        info.severity === "error"
          ? "JS className 用到的 nw* 类名未在 CSS 中定义"
          : "疑似类名的 nw* 字符串未在 CSS 中定义（非 className 直接赋值，按提示处理）",
        info.severity, name);
    }
  }

  /* ---------- R10：启动安全 ---------- */
  if (enabled(10)) {
    const ctxInjectRe = /(?<![A-Za-z0-9_$])ctx\s*\.\s*inject\s*\(/g;
    let m;
    ctxInjectRe.lastIndex = 0;
    while ((m = ctxInjectRe.exec(src)) !== null) {
      if (cls[m.index] === CLS_COMMENT) continue;
      rep.add(10, lineAt(lineStarts, m.index), "ctx-inject", "ctx.inject(", "禁用 cordis 服务等待 ctx.inject(（取服务只能 ctx.get(name)；槽位等待请用 ctx.slots.inject）", "error");
    }
    // require("@deepseek-ai/dsh-client-ui-primitives") 必须在 try 块内
    const MOD = "@deepseek-ai/dsh-client-ui-primitives";
    const hits = [];
    for (const s of strings) if (s.value === MOD) hits.push(s);
    for (const t of lexed.templates) if (t.value === MOD) hits.push(t);
    if (!hits.length) {
      rep.note(`未检出 require("${MOD}")：R10 后半条（必须在 try 内）跳过。`);
    } else {
      // 收集所有 try 块范围
      const tryRanges = [];
      const tryRe = /(?<![A-Za-z0-9_$.])try\s*\{/g;
      let tm;
      tryRe.lastIndex = 0;
      while ((tm = tryRe.exec(src)) !== null) {
        if (cls[tm.index] === CLS_COMMENT) continue;
        const braceIdx = src.indexOf("{", tm.index + tm[0].length - 1);
        if (braceIdx === -1) continue;
        // 找配对右括号（忽略字符串/注释/模板）
        let depth = 0;
        let i = braceIdx;
        let end = -1;
        while (i < src.length) {
          if (cls[i] === CLS_COMMENT) { i += 1; continue; }
          const c = src[i];
          if (cls[i] === CLS_CODE || cls[i] === CLS_CSS) {
            if (c === "{") depth += 1;
            else if (c === "}") { depth -= 1; if (depth === 0) { end = i; break; } }
          }
          i += 1;
        }
        if (end !== -1) tryRanges.push([braceIdx, end]);
      }
      for (const s of hits) {
        const inside = tryRanges.some(([a, b]) => s.start > a && s.start < b);
        if (!inside) {
          rep.add(10, lineAt(lineStarts, s.start), "require-not-try", `require("${MOD}")`, `require("${MOD}") 必须包在 try 块内`, "error");
        }
      }
    }
  }

  /* ---------- R2：JS 内联样式 ---------- */
  if (enabled(2)) {
    const n = src.length;
    const colorInText = (text) => {
      const out = [];
      HEX_RE.lastIndex = 0; FUNC_COLOR_RE.lastIndex = 0; GRADIENT_RE.lastIndex = 0;
      let m;
      while ((m = HEX_RE.exec(text)) !== null) out.push(m[0]);
      while ((m = FUNC_COLOR_RE.exec(text)) !== null) out.push(snippet(m[0], 16));
      while ((m = GRADIENT_RE.exec(text)) !== null) out.push(m[0].replace(/\($/, ""));
      return out;
    };
    const offsetOf = (base, sub) => base + sub;

    const styleRe = /(?<![A-Za-z0-9_$.])style\s*:\s*\{/g;
    let m;
    while ((m = styleRe.exec(src)) !== null) {
      if (cls[m.index] !== CLS_CODE) continue;
      const braceIdx = src.indexOf("{", m.index + m[0].length - 1);
      let depth = 0;
      let i = braceIdx;
      let end = -1;
      while (i < n) {
        const c = src[i];
        if (cls[i] === CLS_CODE || cls[i] === CLS_CSS) {
          if (c === "{") depth += 1;
          else if (c === "}") { depth -= 1; if (depth === 0) { end = i; break; } }
        }
        i += 1;
      }
      if (end === -1) continue;
      const objText = src.slice(braceIdx + 1, end);
      const objStart = braceIdx + 1;
      const entries = splitTop(objText, /[,]/);
      for (const entry of entries) {
        if (!entry.trim()) continue;
        let d2 = 0;
        let quote = null;
        let colon = -1;
        for (let k = 0; k < entry.length; k += 1) {
          const c = entry[k];
          if (quote) { if (c === quote && entry[k - 1] !== "\\") quote = null; continue; }
          if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
          if (c === "(" || c === "[") d2 += 1;
          else if (c === ")" || c === "]") d2 = Math.max(0, d2 - 1);
          else if (c === ":" && d2 === 0) { colon = k; break; }
        }
        if (colon <= 0) continue;
        const keyRaw = entry.slice(0, colon).trim();
        const valRaw = entry.slice(colon + 1).trim();
        const key = unquote(keyRaw);
        const keyLow = key.toLowerCase();
        const valPlain = unquote(valRaw);
        const entryLine = lineAt(lineStarts, offsetOf(objStart, objText.indexOf(entry)));
        const colors = colorInText(valRaw);
        if (colors.length) {
          rep.add(2, entryLine, "js-style-color", `${key}:${snippet(valRaw, 46)}`,
            `内联 style 不得含色值/渐变（${colors.slice(0, 3).join("、")}）`, "error");
        } else if (COLOR_KEYS.has(keyLow) && NAMED_COLORS.has(valPlain.toLowerCase())) {
          rep.add(2, entryLine, "js-style-color", `${key}:${valPlain}`, "内联 style 不得含颜色字面量", "error");
        }
        if (/radius$/i.test(key)) {
          const bare = /^-?\d*\.?\d+$/.test(valPlain) || /^-?\d*\.?\d+(px|rem|em|pt|%)$/.test(valPlain);
          const isZero = /^0(px|%)?$/.test(valPlain) || valPlain === "0";
          const okVar = /^var\(\s*--dsw-radius-/.test(valPlain);
          const capsule = /^(50%|999px|9999px)$/.test(valPlain);
          if (!isZero && !okVar && !capsule && (bare || valPlain)) {
            rep.add(2, entryLine, "js-radius", `${key}:${snippet(valRaw, 40)}`, "内联 style 不得用裸圆角数值（改用 var(--dsw-radius-*)）", "error");
          }
        }
        if (keyLow === "fontsize") {
          const okVar = /^var\(\s*--dsw-font/.test(valPlain);
          const okKeyword = /^(inherit|unset|revert|initial|)$/.test(valPlain);
          const bare = /^-?\d*\.?\d+(px|rem)?$/.test(valPlain);
          if (!okVar && !okKeyword && bare) {
            rep.add(2, entryLine, "js-fontsize", `${key}:${snippet(valRaw, 40)}`, "内联 style 不得用裸 fontSize 数值（改用排版 token 或类名）", "error");
          }
        }
        if (keyLow === "font") {
          const bare = /\d*\.?\d+px/.test(valPlain);
          if (bare) rep.add(2, entryLine, "js-fontsize", `${key}:${snippet(valRaw, 40)}`, "内联 style 不得用裸字号（font 简写）", "error");
        }
        if (/^border/i.test(keyLow) && /(^|[^\d.])\d*\.?\d+(px|rem|pt)/.test(valPlain)) {
          checkBorderDecl(toKebab(key), valPlain, (sev, detail, desc) => {
            rep.add(3, entryLine, sev === "warn" ? "border-warn" : "border-width", detail, desc, sev);
          });
        }
        if (/gradient/i.test(`${keyRaw}${valRaw}`) && !colors.length) {
          rep.add(2, entryLine, "js-gradient", `${key}:${snippet(valRaw, 40)}`, "内联 style 不得用渐变", "error");
        }
      }
      styleRe.lastIndex = end;
    }
    // 直接给 DOM style 属性赋值
    const styleAssignRe = /\.style\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
    while ((m = styleAssignRe.exec(src)) !== null) {
      if (cls[m.index] === CLS_COMMENT) continue;
      const prop = m[1];
      const value = m[2].slice(1, -1);
      const line = lineAt(lineStarts, m.index);
      const colors = colorInText(value);
      if (colors.length) {
        rep.add(2, line, "js-dom-style-color", `.style.${prop} = ${snippet(value, 40)}`, `DOM 内联样式赋值含色值（${colors.slice(0, 2).join("、")}）`, "error");
      }
      if (/radius$/i.test(prop) && /\d*\.?\d+(px|rem|em|pt)/.test(value)) {
        rep.add(2, line, "js-radius", `.style.${prop} = ${snippet(value, 40)}`, "DOM 内联样式不得用裸圆角数值", "error");
      }
      if (prop.toLowerCase() === "fontsize" && /^\d*\.?\d+(px|rem)?$/.test(value)) {
        rep.add(2, line, "js-fontsize", `.style.${prop} = ${snippet(value, 40)}`, "DOM 内联样式不得用裸字号", "error");
      }
      if (/^border/i.test(prop)) {
        checkBorderDecl(toKebab(prop), value, (sev, detail, desc) => {
          rep.add(3, line, sev === "warn" ? "border-warn" : "border-width", detail, desc, sev);
        });
      }
    }
  }

  return { rep, cssClasses, cssDocs };
}

/* ------------------------------------------------------------------ *
 * 6. 输出
 * ------------------------------------------------------------------ */

function groupFindings(items) {
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.key)) groups.set(it.key, { ...it, count: 0, details: [] });
    const g = groups.get(it.key);
    g.count += 1;
    if (it.detail && !g.details.includes(it.detail) && g.details.length < 3) g.details.push(it.detail);
  }
  return [...groups.values()].sort((a, b) => (a.line - b.line) || (a.rule - b.rule) || a.key.localeCompare(b.key));
}

function renderText(file, items, notes, opts) {
  const lines = [];
  const groups = groupFindings(items);
  const shown = opts.maxText > 0 ? groups.slice(0, opts.maxText) : groups;
  for (const g of shown) {
    const tag = g.severity === "warn" ? "[warn] " : "";
    const detail = g.details.length ? `：${g.details.join("、")}` : "";
    const more = g.count > 1 ? `（共 ${g.count} 处）` : "";
    lines.push(`${file}:${g.line} R${g.rule} ${tag}${g.desc}${detail}${more}`);
  }
  if (opts.maxText > 0 && groups.length > shown.length) {
    lines.push(`… 另有 ${groups.length - shown.length} 组未显示（--max-text 限制）`);
  }
  const per = {};
  for (let r = 1; r <= 10; r += 1) per[r] = { error: 0, warn: 0 };
  for (const it of items) per[it.rule][it.severity] += 1;
  lines.push("");
  lines.push("---- 汇总 ----");
  let totalErr = 0;
  let totalWarn = 0;
  for (let r = 1; r <= 10; r += 1) {
    const { error, warn } = per[r];
    totalErr += error;
    totalWarn += warn;
    const mark = error > 0 ? "✗" : (warn > 0 ? "!" : "✓");
    lines.push(`${mark} R${String(r).padStart(2, "0")} ${RULE_NAMES[r]}：违规 ${error} 处${warn ? ` / 提示 ${warn} 处` : ""}`);
  }
  lines.push(`命中合计：违规 ${totalErr} 处 / 提示 ${totalWarn} 处`);
  if (notes.length) {
    lines.push("");
    lines.push("---- 说明 ----");
    for (const n of notes) lines.push(`- ${n}`);
  }
  lines.push("");
  lines.push(totalErr > 0 ? `判定：FAIL（R1..R10 有 ${totalErr} 处违规）` : `判定：PASS（无违规${totalWarn ? `，${totalWarn} 处提示供参考` : ""}）`);
  return { text: lines.join("\n"), totalErr, totalWarn, groups };
}

function renderJson(file, items, notes, tokensInfo, classesInfo) {
  const per = {};
  for (let r = 1; r <= 10; r += 1) per[r] = { id: `R${r}`, name: RULE_NAMES[r], error: 0, warn: 0 };
  for (const it of items) per[it.rule][it.severity] += 1;
  const totalErr = items.filter((i) => i.severity === "error").length;
  const totalWarn = items.filter((i) => i.severity === "warn").length;
  return {
    file,
    ok: totalErr === 0,
    verdict: totalErr === 0 ? "PASS" : "FAIL",
    exitCode: totalErr === 0 ? 0 : 1,
    totals: { errors: totalErr, warnings: totalWarn },
    rules: per,
    findings: groupFindings(items).map((g) => ({
      line: g.line, rule: g.rule, ruleId: `R${g.rule}`, severity: g.severity, kind: g.kind,
      detail: g.details[0] || "", count: g.count, message: g.desc,
    })),
    tokens: tokensInfo,
    classes: classesInfo,
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * 7. CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    file: null, json: false, help: false, maxText: 0,
    tokensFile: DEFAULT_TOKENS, classesFile: DEFAULT_CLASSES,
    skip: new Set(), allowPrefixTokens: false, extraAllowed: new Set(),
  };
  const rest = [];
  const addSkip = (v) => String(v || "").split(/[,\s]+/).filter(Boolean).forEach((s) => opts.skip.add(Number(s)));
  const addToken = (v) => String(v || "").split(/[,\s]+/).filter(Boolean).forEach((s) => opts.extraAllowed.add(s));
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--allow-prefix-tokens") opts.allowPrefixTokens = true;
    else if (a === "--allow-token") addToken(argv[++i]);
    else if (a.startsWith("--allow-token=")) addToken(a.slice(14));
    else if (a === "--tokens") opts.tokensFile = argv[++i];
    else if (a.startsWith("--tokens=")) opts.tokensFile = a.slice(9);
    else if (a === "--classes") opts.classesFile = argv[++i];
    else if (a.startsWith("--classes=")) opts.classesFile = a.slice(10);
    else if (a === "--skip") addSkip(argv[++i]);
    else if (a.startsWith("--skip=")) addSkip(a.slice(7));
    else if (a === "--max-text") opts.maxText = Number(argv[++i]) || 0;
    else if (a.startsWith("--max-text=")) opts.maxText = Number(a.slice(11)) || 0;
    else rest.push(a);
  }
  opts.file = rest[0] || null;
  return opts;
}

const USAGE = `用法：node C-audit.mjs <client.js 路径> [选项]

选项：
  --json                  输出机器可读 JSON
  --tokens <path>         token 白名单文件（默认同目录 tokens.md）
  --classes <path>        类名契约文件（默认同目录 classes.txt）
  --skip 1,7              跳过指定规则编号（调试用）
  --max-text <n>          文本输出最多显示 n 组（默认全部）
  --allow-token <name>    额外放行某个 token（可逗号分隔/重复；默认严格按 tokens.md）
  --allow-prefix-tokens   允许 tokens.md 里以 - 结尾的前缀族条目放行

退出码：0=PASS 1=有违规(FAIL) 2=用法/IO 错误`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.file) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(opts.help ? 0 : 2);
  }
  let src;
  try {
    src = fs.readFileSync(opts.file, "utf8");
  } catch (err) {
    process.stderr.write(`无法读取文件：${opts.file}（${err.message}）\n`);
    process.exit(2);
  }
  let tokens;
  let classes;
  try {
    tokens = loadTokens(opts.tokensFile);
    classes = loadClasses(opts.classesFile);
  } catch (err) {
    process.stderr.write(`无法读取白名单/契约文件：${err.message}\n`);
    process.exit(2);
  }
  opts.tokens = tokens;
  opts.classes = classes;

  const { rep, cssClasses } = analyze(src, opts);

  if (opts.json) {
    const out = renderJson(opts.file, rep.items, rep.notes, {
      file: opts.tokensFile, whitelist: tokens.names.size, prefixEntries: [...tokens.prefixFamilies],
    }, {
      file: opts.classesFile, required: classes.list.length, cssDefined: cssClasses.size,
    });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(out.exitCode);
  }

  const { text, totalErr } = renderText(opts.file, rep.items, rep.notes, opts);
  process.stdout.write(`${text}\n`);
  process.exit(totalErr > 0 ? 1 : 0);
}

main();
