/**
 * compare-runs.mjs — 两次 capture 的逐字节一致性复核（dev-only）
 *
 * 负责：读两个 manifest.json，按 (view|file) 比对每张 PNG 的 sha256 与像素尺寸，输出差异清单。
 * 不负责：截图、改图。
 *
 * 用法：node compare-runs.mjs shots shots-run2
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error("用法: node compare-runs.mjs <dirA> <dirB>"); process.exit(2); }
const load = (d) => {
  const p = join(HERE, d, "manifest.json");
  if (!existsSync(p)) { console.error("缺 " + p); process.exit(2); }
  return JSON.parse(readFileSync(p, "utf8"));
};
const ma = load(a);
const mb = load(b);
const key = (s) => s.view + "|" + s.file;
const mapA = new Map(ma.shots.map((s) => [key(s), s]));
const diffs = [];
const missing = [];
for (const sb of mb.shots) {
  const sa = mapA.get(key(sb));
  if (!sa) { missing.push(key(sb)); continue; }
  if (sa.sha256 !== sb.sha256 || sa.width !== sb.width || sa.height !== sb.height || sa.bytes !== sb.bytes) {
    diffs.push({ key: key(sb), a: { sha: sa.sha256.slice(0, 16), w: sa.width, h: sa.height, bytes: sa.bytes }, b: { sha: sb.sha256.slice(0, 16), w: sb.width, h: sb.height, bytes: sb.bytes } });
  }
}
const extraInA = ma.shots.filter((s) => !mb.shots.some((x) => key(x) === key(s))).map(key);
const sameSnapshot = ma.clientSnapshot.sha256 === mb.clientSnapshot.sha256;
console.log("运行 A = " + a + "（" + ma.shots.length + " 张）");
console.log("运行 B = " + b + "（" + mb.shots.length + " 张）");
console.log("client.js 快照 sha256 相同: " + sameSnapshot + " (" + ma.clientSnapshot.sha256.slice(0, 16) + "…)");
console.log("差异 " + diffs.length + " 张 | B 缺失 " + missing.length + " 张 | A 多出 " + extraInA.length + " 张");
for (const d of diffs) console.log("  DIFF " + JSON.stringify(d));
for (const m of missing) console.log("  MISSING-in-B " + m);
for (const e of extraInA) console.log("  EXTRA-in-A " + e);
const ok = diffs.length === 0 && missing.length === 0 && extraInA.length === 0 && sameSnapshot;
console.log(ok ? "RESULT: 逐字节一致（" + mb.shots.length + "/" + mb.shots.length + "）" : "RESULT: 不一致");
process.exitCode = ok ? 0 : 1;
