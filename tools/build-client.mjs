#!/usr/bin/env node
/**
 * tools/build-client.mjs — 零依赖客户端模块化构建器
 *
 * 职责：从 client/ 读取全部模块化源码（core/icons/uikit/styles/i18n/controller/components/views/host），
 * 跑完构建前全量校验与产物不变量断言后，确定性地装配输出 lib/client.js；
 * 任一校验或断言失败 → 报错退出（exit 1），绝不写盘。
 *
 * 用法：
 *   node tools/build-client.mjs          构建并写入 lib/client.js
 *   node tools/build-client.mjs --check  只校验当前 lib/client.js 与源码装配结果是否一致（不写盘）
 *
 * 设计铁律：
 *  1. 零第三方依赖，仅使用 Node 内置模块（node:fs / node:path / node:crypto / node:url / node:vm）。
 *  2. 显式模块清单 + 递归孤儿文件检测：client/ 下所有 .js 与 .css 文件都必须进入构建清单。
 *  3. 单模块 vm.Script 独立语法校验 + i18n zh/en 键全对称校验 + 完整产物 vm.Script 校验。
 *  4. 全文件不变量：Hook 调用点恒为 12（代码态与原文均校验）、零服务等待注入、零直接调用适配组件、
 *     CSS 模板括号配平且零颜色字面量/反引号/插值。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import vm from "node:vm";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const SRC = join(REPO, "client");
const CLIENT = join(REPO, "lib", "client.js");
const CHECK_ONLY = process.argv.includes("--check");

/** 客户端图标与 UIKit 标记区块表（保留标记名与合并胶水） */
const CLIENT_BLOCKS = {
  icons: ["icons/a.js", "icons/b1a.js", "icons/b1b.js", "icons/b2.js", "icons/c.js", "icons/d.js"],
  uikit: ["uikit/rows.js", "uikit/wrappers.js"],
};

/** 前置模块（运行时基础与官方原语适配层） */
const PRE_UI_MODULES = [
  "core/runtime.js",
  "core/primitives-adapter.js",
];

/** 图标表之后、样式模板之前的图标挂载胶水 */
const ICON_GLUE_MODULES = [
  "core/icons-glue.js",
];

/** CSS 模板片段清单（按注入顺序） */
const CSS_MANIFEST = {
  base: "styles/base.css",
  components: "styles/components.css",
  overrides: "styles/overrides.css",
};

/** 样式模板之后的业务逻辑/视图/挂载模块（严格按依赖顺序） */
const POST_CSS_MODULES = [
  "core/style-inject.js",
  "i18n/zh.js",
  "i18n/en.js",
  "i18n/index.js",
  "core/http.js",
  "controller/lexicon.js",
  "controller/baseline.js",
  "controller/diagnose.js",
  "controller/packs.js",
  "controller/trash.js",
  "controller/index.js",
  "components/sidebar-entry.js",
  "components/controls.js",
  "components/delete-shared.js",
  "views/helpers.js",
  "views/home.js",
  "views/tools-features.js",
  "views/lexicon.js",
  "views/baseline.js",
  "views/reports.js",
  "views/creation.js",
  "views/diagnose.js",
  "views/trash.js",
  "views/packs.js",
  "views/dialogs.js",
  "views/panel.js",
  "host/mount.js",
  "host/apply.js",
];

const JS_MANIFEST = [
  ...PRE_UI_MODULES,
  ...CLIENT_BLOCKS.icons,
  ...CLIENT_BLOCKS.uikit,
  ...ICON_GLUE_MODULES,
  ...POST_CSS_MODULES,
];

const CSS_FILES = [
  CSS_MANIFEST.base,
  CSS_MANIFEST.components,
  CSS_MANIFEST.overrides,
];

const MANIFEST_SET = new Set([...JS_MANIFEST, ...CSS_FILES]);

const FILE_HEADER = `/* AUTO-GENERATED FILE — DO NOT EDIT DIRECTLY! Built from client/ via node tools/build-client.mjs (npm run build / npm run build:check) */
/**
 * dsh-novel-writer — 浏览器端（client half, v4.0.0）
 *
 * 在 Web GUI 侧边栏挂载「句式分析」入口，点击后在会话区打开开关面板：
 *   - 启用句式分析（enabled）：控制 AI 是否可用 novel_sentence_analysis
 *   - 自动分析（autoAnalyze）：控制 AI 分析作品时是否主动附带句式报告
 * 开关状态通过 /api/dsh-novel-writer/state 同步到宿主端
 * ~/.dsh/dsh-novel-writer/state.json；宿主端不可达时降级为 localStorage。
 *
 * 本文件遵循 DSH client 插件格式：window.__ModuleLoader__.load({ id, factory })，
 * factory 返回 { apply, inject }。仅依赖 react / react-dom（Web GUI 内置）。
 *
 * Built by tools/build-client.mjs from client/
 */`;

const NW_ICONS_MERGER = `/* --- 构建链注入：图标表合并 --- */
var NW_ICONS = {};
(function () {
  var tables = [NW_ICONS_A, NW_ICONS_B1A, NW_ICONS_B1B, NW_ICONS_B2, NW_ICONS_C, NW_ICONS_D];
  for (var ti = 0; ti < tables.length; ti += 1) {
    if (!tables[ti]) continue;
    var ks = Object.keys(tables[ti]);
    for (var ki = 0; ki < ks.length; ki += 1) NW_ICONS[ks[ki]] = tables[ti][ks[ki]];
  }
})();`;

const problems = [];
const log = (m) => console.log("  " + m);

function readSrc(relPath) {
  try {
    const raw = readFileSync(join(SRC, relPath), "utf8").replace(/\r\n/g, "\n").replace(/\s+$/, "");
    if (raw.trim().length === 0) {
      problems.push(`源文件为空：${relPath}`);
      return null;
    }
    return raw;
  } catch {
    problems.push(`源文件缺失：${relPath}（${SRC}）`);
    return null;
  }
}

function walkFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    problems.push(`无法读取源目录：${dir}`);
    return acc;
  }
  entries.sort();
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

function checkNoOrphans() {
  const allFiles = walkFiles(SRC);
  for (const full of allFiles) {
    const rel = relative(SRC, full).replace(/\\/g, "/");
    if (!/\.(?:js|css)$/i.test(rel)) continue;
    if (!MANIFEST_SET.has(rel)) {
      problems.push(`孤儿源文件（未纳入构建清单）：${rel}`);
    }
  }
}

function validateJsStandalone(relPath, code) {
  try {
    new vm.Script(code, { filename: relPath });
  } catch (err) {
    problems.push(`模块语法解析失败（${relPath}）：${err.message}`);
  }
}

function validateCssFragments(sources) {
  for (const relPath of CSS_FILES) {
    const text = sources.get(relPath);
    if (text == null) continue;
    if (text.includes("`")) problems.push(`CSS 片段含反引号（\`）：${relPath}`);
    if (text.includes("${")) problems.push(`CSS 片段含模板插值（\${）：${relPath}`);
  }
}

function validateI18nParity(zhCode, enCode) {
  if (zhCode == null || enCode == null) return;
  let zhDict;
  let enDict;
  try {
    const zhCtx = {};
    vm.runInNewContext(zhCode, zhCtx, { filename: "i18n/zh.js" });
    zhDict = zhCtx.zh;
  } catch (err) {
    problems.push(`i18n/zh.js 求值失败：${err.message}`);
    return;
  }
  try {
    const enCtx = {};
    vm.runInNewContext(enCode, enCtx, { filename: "i18n/en.js" });
    enDict = enCtx.en;
  } catch (err) {
    problems.push(`i18n/en.js 求值失败：${err.message}`);
    return;
  }
  if (!zhDict || typeof zhDict !== "object" || Array.isArray(zhDict)) {
    problems.push("i18n/zh.js 未定义有效的 zh 字典对象");
    return;
  }
  if (!enDict || typeof enDict !== "object" || Array.isArray(enDict)) {
    problems.push("i18n/en.js 未定义有效的 en 字典对象");
    return;
  }
  const zhKeys = Object.keys(zhDict).sort();
  const enKeys = Object.keys(enDict).sort();
  const zhSet = new Set(zhKeys);
  const enSet = new Set(enKeys);
  const missingInEn = zhKeys.filter((k) => !enSet.has(k));
  const missingInZh = enKeys.filter((k) => !zhSet.has(k));
  if (missingInEn.length) problems.push(`i18n/en.js 缺失键（${missingInEn.length}）：${missingInEn.slice(0, 10).join(", ")}`);
  if (missingInZh.length) problems.push(`i18n/zh.js 缺失键（${missingInZh.length}）：${missingInZh.slice(0, 10).join(", ")}`);
}

function formatClientBlock(name, files, sources) {
  const chunks = files.map((f) => `/* --- ${f} --- */\n${sources.get(f)}`);
  let body = chunks.join("\n\n");
  if (name === "icons") body += `\n\n${NW_ICONS_MERGER}`;
  return `    /* ===== client:${name} ===== */\n${body}\n/* ===== /client:${name} ===== */`;
}

function formatCssBlock(sources) {
  const baseCss = sources.get(CSS_MANIFEST.base);
  const componentsCss = sources.get(CSS_MANIFEST.components);
  const overridesCss = sources.get(CSS_MANIFEST.overrides);
  const componentsSection = [
    "  /* ===== client:css ===== */",
    `/* --- ${CSS_MANIFEST.components} --- */\n${componentsCss}`,
  ].join("\n\n") + "\n/* ===== /client:css ===== */";
  return `    // ---- 样式 ----\nvar css = \`\n${baseCss}\n${componentsSection}\n${overridesCss}\n\`;`;
}

function assembleClient(sources) {
  const sections = [];
  for (const rel of PRE_UI_MODULES) {
    sections.push(`    /* === module: ${rel} === */\n${sources.get(rel)}`);
  }
  for (const [name, files] of Object.entries(CLIENT_BLOCKS)) {
    sections.push(formatClientBlock(name, files, sources));
  }
  for (const rel of ICON_GLUE_MODULES) {
    sections.push(`    /* === module: ${rel} === */\n${sources.get(rel)}`);
  }
  sections.push(formatCssBlock(sources));
  for (const rel of POST_CSS_MODULES) {
    sections.push(`    /* === module: ${rel} === */\n${sources.get(rel)}`);
  }
  return [
    FILE_HEADER,
    "window.__ModuleLoader__.load({",
    '  id: "dsh-novel-writer",',
    "  factory: (require) => {",
    "    var module = { exports: {} };",
    "    var exports = module.exports;",
    '    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    "",
    sections.join("\n\n"),
    "",
    "    return module.exports;",
    "  }",
    "});",
    "",
  ].join("\n");
}

/** 剥离注释、字符串/模板文本与正则字面量（保留模板插值内代码与换行符），供代码级计数使用 */
function stripCommentsAndStrings(src) {
  const n = src.length;
  const out = [];
  const REGEX_PREV = new Set("(,=:[!&|?{};+-*%~^<>".split(""));
  const REGEX_KW = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do", "else", "yield", "await", "throw"]);
  let regexOK = true;

  function scanString(i, isTemplate) {
    const q = isTemplate ? "`" : src[i];
    out.push(" ");
    let j = i + 1;
    while (j < n) {
      const c = src[j];
      if (c === "\\") {
        out.push(" ");
        if (j + 1 < n) out.push(src[j + 1] === "\n" ? "\n" : " ");
        j += 2;
        continue;
      }
      if (!isTemplate && c === "\n") break;
      if (c === q) { out.push(" "); j += 1; break; }
      if (isTemplate && c === "$" && src[j + 1] === "{") {
        out.push("  ");
        const prevRegexOK = regexOK;
        regexOK = true;
        j = scanCode(j + 2, true);
        regexOK = prevRegexOK;
        if (j < n && src[j] === "}") { out.push(" "); j += 1; }
        continue;
      }
      out.push(c === "\n" ? "\n" : " ");
      j += 1;
    }
    return j;
  }

  function scanRegex(i) {
    out.push(" ");
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j];
      if (c === "\\") { out.push("  "); j += 2; continue; }
      if (c === "\n") break;
      out.push(" ");
      if (inClass) { if (c === "]") inClass = false; j += 1; continue; }
      if (c === "[") { inClass = true; j += 1; continue; }
      if (c === "/") { j += 1; break; }
      j += 1;
    }
    while (j < n && /[a-z]/i.test(src[j])) { out.push(" "); j += 1; }
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
        out.push(" ".repeat(end - i));
        i = end;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        const e = src.indexOf("*/", i + 2);
        const end = e === -1 ? n : e + 2;
        for (let k = i; k < end; k += 1) out.push(src[k] === "\n" ? "\n" : " ");
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
          const word = src.slice(i, w);
          out.push(word);
          regexOK = REGEX_KW.has(word);
          i = w;
          continue;
        }
        if (/[0-9]/.test(c)) { out.push(c); regexOK = false; i += 1; continue; }
        regexOK = REGEX_PREV.has(c);
      }
      out.push(c);
      i += 1;
    }
    return n;
  }

  scanCode(0, false);
  return out.join("");
}

/** 完整产物校验（语法 + 不变量 + 标记区） */
function assertInvariants(text) {
  try {
    new vm.Script(text, { filename: "lib/client.js" });
  } catch (err) {
    problems.push(`组装后 lib/client.js 语法解析失败：${err.message}`);
    return;
  }

  for (const name of ["icons", "uikit", "css"]) {
    const begin = `/* ===== client:${name} ===== */`;
    const end = `/* ===== /client:${name} ===== */`;
    const i1 = text.indexOf(begin);
    const i2 = text.indexOf(end);
    if (i1 < 0 || i2 < 0) problems.push(`标记缺失：client:${name}`);
    else if (text.indexOf(begin, i1 + 1) >= 0 || text.indexOf(end, i2 + 1) >= 0) problems.push(`标记重复：client:${name}`);
    else if (i2 < i1) problems.push(`标记逆序：client:${name}`);
  }

  const codeOnly = stripCommentsAndStrings(text);
  const useCode = (codeOnly.match(/react\.use[A-Z]/g) || []).length;
  const useRaw = (text.match(/react\.use[A-Z]/g) || []).length;
  if (useCode !== 12) problems.push(`代码态 Hook 调用点 = ${useCode}（须 12）`);
  if (useRaw !== 12) problems.push(`全文 Hook 调用点 = ${useRaw}（须 12）`);

  if (text.includes("ctx.inject(") || /\bctx\s*\.\s*inject\s*\(/.test(codeOnly)) {
    problems.push("出现禁用的服务等待调用");
  }
  const direct = (text.match(/NW_UI\.[A-Za-z]+\(/g) || []).length;
  if (direct !== 0) problems.push(`适配层直接调用计数 = ${direct}（须 0）`);

  const marker = "var css = `";
  const mStart = text.indexOf(marker);
  const s = mStart >= 0 ? mStart + marker.length : -1;
  const e = s >= 0 ? text.indexOf("`;", s) : -1;
  if (s < 0 || e < 0) {
    problems.push("CSS 模板边界异常");
    return;
  }
  const css = text.slice(s, e);
  const ob = (css.match(/\{/g) || []).length;
  const cb = (css.match(/\}/g) || []).length;
  if (ob !== cb) problems.push(`CSS 括号不配平 { ${ob} / } ${cb}`);
  if (/#[0-9a-fA-F]{3,8}\b/.test(css)) problems.push("CSS 出现 #hex 字面量");
  if (/\b(?:rgba?|hsla?)\(/.test(css)) problems.push("CSS 出现 rgb/hsl 字面量");
}

// ---------- 执行：读取清单 -> 前置校验 -> 装配 -> 产物校验 -> 比较/写盘 ----------
checkNoOrphans();

const sources = new Map();
for (const relPath of MANIFEST_SET) {
  const content = readSrc(relPath);
  if (content !== null) sources.set(relPath, content);
}

if (problems.length === 0) {
  for (const relPath of JS_MANIFEST) {
    validateJsStandalone(relPath, sources.get(relPath));
  }
  validateCssFragments(sources);
  validateI18nParity(sources.get("i18n/zh.js"), sources.get("i18n/en.js"));
}

if (problems.length) {
  console.error("✗ 构建前校验失败（未写盘）：\n" + problems.map((p) => "  - " + p).join("\n"));
  process.exit(1);
}

const out = assembleClient(sources);
assertInvariants(out);
if (problems.length) {
  console.error("✗ 产物不变量违例（未写盘）：\n" + problems.map((p) => "  - " + p).join("\n"));
  process.exit(1);
}

const hash = (t) => createHash("sha256").update(t).digest("hex").slice(0, 16);

let current = null;
try {
  current = readFileSync(CLIENT, "utf8").replace(/\r\n/g, "\n");
} catch {
  current = null;
}

if (CHECK_ONLY) {
  if (current !== null && out === current) {
    log(`--check ✓ client.js 与源一致（${hash(out)}）`);
    process.exit(0);
  }
  const curLabel = current === null ? "缺失" : hash(current);
  console.error(`✗ --check 失败：client.js 与由源重放结果不一致（当前 ${curLabel} vs 应为 ${hash(out)}）。\n    运行 node tools/build-client.mjs 重新装配。`);
  process.exit(1);
}

if (current !== null && out === current) {
  log(`无需更新（重放结果与现文件一致，${hash(out)}）`);
  process.exit(0);
}

writeFileSync(CLIENT, out, "utf8");
const prevLen = current === null ? 0 : current.length;
const prevHash = current === null ? "new" : hash(current);
log(`已装配写盘：${prevLen} → ${out.length} 字符（${prevHash} → ${hash(out)}）`);
log(`模块总数：JS ${JS_MANIFEST.length} 个 + CSS ${CSS_FILES.length} 片段`);
