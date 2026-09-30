#!/usr/bin/env node
/**
 * tools/build-client.mjs — v6.0 方案A 构建链（总负责人所有）
 *
 * 职责：把 _ui-work 下各子代理交付的 V6 文本块，装配进 lib/client.js 的**标记区**，
 * 并对全文件跑不变量断言；任一断言失败 → 不写盘（exit 1）。
 *
 * 标记区约定（lib/client.js 内，成对出现，区块内容每次构建整体替换）：
 *   /* ===== V6:icons ===== * /        ← V6-icons-a/b/c.js 的 NW_ICONS_* 依次拼接
 *   /* ===== V6:uikit ===== * /        ← V6-uikit-rows.js + V6-uikit-wrappers.js
 *   /* ===== V6:slider ===== * /       ← V6-slider.js
 *   /* ===== V6:css ===== * /          ← V6-components.css + V6-slider-css.txt（进 CSS 模板内）
 *
 * 用法：
 *   node tools/build-client.mjs          构建（有缺失源/断言失败不写盘）
 *   node tools/build-client.mjs --check  只校验"当前 client.js == 由源重放的结果"（CI 一致性）
 *
 * 设计铁律：
 *  1. 只读源文件、只写 lib/client.js；任何异常不落盘。
 *  2. 源文件缺失/标记缺失/标记重复 → 报错退出，绝不"部分写入"。
 *  3. 不变量（与 CONTRACT-V6 §1.6 对齐）：react.use==12、ctx.inject(==0、
 *     NW_UI.X( 直接调用==0、括号配平、注入 CSS 零颜色字面量。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const REPO = "F:\\doment\\dsh-novel-writer";
const SRC = "F:\\doment\\_ui-work";
const CLIENT = REPO + "\\lib\\client.js";
const CHECK_ONLY = process.argv.includes("--check");

/** 区块表：name → 依序读取的源文件（缺一不可） */
const BLOCKS = {
  icons: ["V6-icons-a.js", "V6-icons-b1a.js", "V6-icons-b1b.js", "V6-icons-b2.js", "V6-icons-c.js", "V6-icons-d.js"],
  uikit: ["V6-uikit-rows.js", "V6-uikit-wrappers.js"],
  slider: ["V6-slider.js"],
  css: ["V6-components.css", "V6-slider-css.txt"],
};

const problems = [];
const log = (m) => console.log("  " + m);

function readSrc(name) {
  try { return readFileSync(SRC + "\\" + name, "utf8").replace(/\s+$/, ""); }
  catch { problems.push(`源文件缺失：${name}（${SRC}）`); return null; }
}

/** 用标记区替换区块内容：begin/end 各出现且只出现一次 */
function spliceRegion(text, name, body, problems) {
  const begin = `/* ===== V6:${name} ===== */`;
  const end = `/* ===== /V6:${name} ===== */`;
  const i1 = text.indexOf(begin), i2 = text.indexOf(end);
  if (i1 < 0 || i2 < 0) { problems.push(`标记缺失：V6:${name}`); return text; }
  if (text.indexOf(begin, i1 + 1) >= 0 || text.indexOf(end, i2 + 1) >= 0) {
    problems.push(`标记重复：V6:${name}`); return text;
  }
  if (i2 < i1) { problems.push(`标记逆序：V6:${name}`); return text; }
  const head = text.slice(0, i1 + begin.length);
  const tail = text.slice(i2);
  const sep = body.length ? "\n" : "";
  return head + sep + body + "\n" + tail;
}

/** 逐块读源并按区块拼装 */
function assembleSources() {
  const parts = {};
  for (const [name, files] of Object.entries(BLOCKS)) {
    const chunks = [];
    for (const f of files) {
      const s = readSrc(f);
      if (s === null) continue;
      chunks.push(`/* --- ${f} --- */\n` + s);
    }
    if (chunks.length === files.length) {
      parts[name] = chunks.join("\n\n");
      if (name === "icons") {
        // 合并行：五批 → NW_ICONS（构建链注入；全批到齐才组装，缺一批在上面已报错）
        parts[name] += `

/* --- 构建链注入：图标表合并 --- */
var NW_ICONS = {};
(function () {
  var tables = [NW_ICONS_A, NW_ICONS_B1A, NW_ICONS_B1B, NW_ICONS_B2, NW_ICONS_C, NW_ICONS_D];
  for (var ti = 0; ti < tables.length; ti += 1) {
    if (!tables[ti]) continue;
    var ks = Object.keys(tables[ti]);
    for (var ki = 0; ki < ks.length; ki += 1) NW_ICONS[ks[ki]] = tables[ti][ks[ki]];
  }
})();`;
      }
    }
  }
  return parts;
}

/** 不变量断言（全文件级） */
function assertInvariants(text) {
  const use = (text.match(/react\.use[A-Z]/g) || []).length;
  if (use !== 12) problems.push(`react.use* = ${use}（须 12）`);
  if (text.includes("ctx.inject(")) problems.push("出现 ctx.inject(");
  const direct = (text.match(/NW_UI\.[A-Za-z]+\(/g) || []).length;
  if (direct !== 0) problems.push(`NW_UI 直接调用 = ${direct}（须 0）`);
  const s = text.indexOf("var css = `") + 11;
  const e = text.indexOf("`;", s);
  if (s < 11 || e < 0) { problems.push("CSS 模板边界异常"); return; }
  const css = text.slice(s, e);
  const ob = (css.match(/\{/g) || []).length, cb = (css.match(/\}/g) || []).length;
  if (ob !== cb) problems.push(`CSS 括号不配平 { ${ob} / } ${cb}`);
  if (/#[0-9a-fA-F]{3,8}\b/.test(css)) problems.push("CSS 出现 #hex 字面量");
  if (/\b(?:rgba?|hsla?)\(/.test(css)) problems.push("CSS 出现 rgb/hsl 字面量");
}

const srcText = readFileSync(CLIENT, "utf8");
const parts = assembleSources();
let out = srcText;
if (problems.length === 0) {
  for (const [name, body] of Object.entries(parts)) out = spliceRegion(out, name, body, problems);
}

if (problems.length) {
  console.error("✗ 构建失败（未写盘）：\n" + problems.map((p) => "  - " + p).join("\n"));
  process.exit(1);
}
assertInvariants(out);
if (problems.length) {
  console.error("✗ 不变量违例（未写盘）：\n" + problems.map((p) => "  - " + p).join("\n"));
  process.exit(1);
}

const hash = (t) => createHash("sha256").update(t).digest("hex").slice(0, 16);
if (CHECK_ONLY) {
  if (out === srcText) { log(`--check ✓ client.js 与源一致（${hash(out)}）`); process.exit(0); }
  console.error(`✗ --check 失败：client.js 与由源重放结果不一致（当前 ${hash(srcText)} vs 应为 ${hash(out)}）。\n    运行 node tools/build-client.mjs 重新装配。`);
  process.exit(1);
}
if (out === srcText) { log("无需更新（重放结果与现文件一致）"); process.exit(0); }
writeFileSync(CLIENT, out, "utf8");
log(`已装配写盘：${srcText.length} → ${out.length} 字符（${hash(srcText)} → ${hash(out)}）`);
log("区块：" + Object.keys(parts).map((k) => `${k}(${parts[k].length}B)`).join("  "));
