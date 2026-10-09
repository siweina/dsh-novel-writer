/**
 * extract-tokens.mjs — 从 desktop 线 asar 的 theme 包中抽取官方 `--dsw-*` 令牌 CSS（dev-only）
 *
 * 负责：把 @deepseek-ai/dsh-client-ui-theme/lib/client.js 里的 CSS 字符串常量还原成真实 CSS，
 *       落盘为 tools/visual/host/host-tokens.css，供 fixture.html 以「宿主令牌层」身份 <link> 引入。
 * 不负责：改插件产物、改仓库其他文件。契约 §1：版本敏感事实以 desktop 线 asar 为准，
 *       因此本文件头部写入来源路径 + 版本号，并在 manifest 里记录 asar 内该文件的 sha256。
 *
 * 用法：node extract-tokens.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const THEME_CLIENT = join(HERE, "host", "theme-client.js");
const OUT = join(HERE, "host", "host-tokens.css");
const ASAR = "C:\\Users\\zg\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";

/** 解析 JS 双引号字符串字面量（处理 \" \\ \n \t \uXXXX），返回 { value, end } */
function parseJsString(text, start) {
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const nx = text[i + 1];
      if (nx === "n") out += "\n";
      else if (nx === "t") out += "\t";
      else if (nx === "r") out += "\r";
      else if (nx === "u") { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; continue; }
      else out += nx;
      i += 2;
      continue;
    }
    if (ch === '"') return { value: out, end: i + 1 };
    out += ch;
    i += 1;
  }
  throw new Error("未闭合的字符串字面量 @" + start);
}

if (!existsSync(THEME_CLIENT)) {
  console.error("缺少 " + THEME_CLIENT + "（先跑：node probe-asar.mjs dump \"dsh-client-ui-theme/lib/client.js\" host/theme-client.js）");
  process.exit(1);
}
const text = readFileSync(THEME_CLIENT, "utf8");
const themeVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, "host", "theme-package.json"), "utf8"));
    return pkg.version || "unknown";
  } catch { return "unknown"; }
})();
const themeSha = createHash("sha256").update(text).digest("hex");
const asarSha = (() => {
  try { return createHash("sha256").update(readFileSync(ASAR)).digest("hex"); } catch { return "unavailable"; }
})();

// 收集所有 `var <name>_css_default = "..."` 形式的字符串常量（CSS 模块映射是对象字面量，天然被排除）
const re = /var\s+([A-Za-z0-9_$]+_css_default)\s*=\s*"/g;
const chunks = [];
let m;
while ((m = re.exec(text)) !== null) {
  const parsed = parseJsString(text, m.index + m[0].length - 1);
  if (parsed.value.includes("--dsw-") || parsed.value.includes("--shiki-")) {
    chunks.push({ name: m[1], css: parsed.value });
  }
}

const header = [
  "/* ---------------------------------------------------------------------------",
  " * host-tokens.css —— 由 tools/visual/extract-tokens.mjs 生成，请勿手工编辑。",
  " *",
  " * 身份：DSH 官方主题层（宿主 `body{--dsw-*}` 令牌）。插件注入的 CSS 只引用这些令牌，",
  " *       因此视觉装置必须复刻它们，否则面板会退化成浏览器默认色（比对失去意义）。",
  " * 来源：desktop 线 asar（契约 §1 唯一权威线）",
  " *   asar        : " + ASAR,
  " *   entry       : dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js",
  " *   theme 版本  : " + themeVersion,
  " *   entry sha256: " + themeSha,
  " *   asar sha256 : " + asarSha,
  " * 抽取常量    : " + chunks.map((c) => c.name).join(", "),
  " * --------------------------------------------------------------------------- */",
  ""
].join("\n");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, header + chunks.map((c) => "/* ===== " + c.name + " ===== */\n" + c.css).join("\n\n") + "\n", "utf8");
console.log("写出 " + OUT + "（" + chunks.length + " 个 CSS 常量，" + (header.length + chunks.reduce((a, c) => a + c.css.length, 0)) + " 字节）");
for (const c of chunks) console.log("  - " + c.name + " : " + c.css.length + " 字符，选择器片段 " + JSON.stringify(c.css.slice(0, 60)));
