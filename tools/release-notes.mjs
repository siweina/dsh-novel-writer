#!/usr/bin/env node
/**
 * 供 release.yml 在打 tag 时生成 GitHub Release 正文：
 *   node tools/release-notes.mjs v5.2.0 > release-notes.md
 *
 * 背景：原先 release.yml 把正文写成一句「更新日志待手动填写」的占位串，
 * 结果 v5.2.0 的 Release 页面上只有那句占位（事后才手工补上）。
 * 这里直接从 CHANGELOG.md 里按版本号取小节，取不到就退化成一句可读的兜底文案（不阻断发布）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const tag = (process.argv[2] || "").trim();
const version = tag.replace(/^v/, "");
if (version === "") {
  console.error("用法：node tools/release-notes.mjs <tag，如 v5.2.0>");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let changelog = "";
try {
  changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
} catch {
  console.error("读不到 CHANGELOG.md");
}

/** 取 `## [x.y.z] ...` 到下一个 `## [` 之间的小节 */
function sectionOf(md, ver) {
  const re = new RegExp("^## \\[" + ver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\][^\\n]*\\n", "m");
  const m = re.exec(md);
  if (!m) return "";
  return md.slice(m.index + m[0].length).split(/^## \[/m)[0].trim();
}

const section = sectionOf(changelog, version);
const body = section === ""
  ? `# dsh-novel-writer v${version}\n\n本版本的详细改动见 [CHANGELOG.md](https://github.com/siweina/dsh-novel-writer/blob/main/CHANGELOG.md)（未在 CHANGELOG 中找到 \`[${version}]\` 小节，请在发布后补写）。\n`
  : `# dsh-novel-writer v${version}\n\n${section}\n\n---\n\n完整历史见 [CHANGELOG.md](https://github.com/siweina/dsh-novel-writer/blob/main/CHANGELOG.md)；安装：\`dsh plugin --profile web add dsh-novel-writer\`（或桌面端插件页）。\n`;

process.stdout.write(body);
