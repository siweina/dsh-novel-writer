#!/usr/bin/env node
/**
 * tools/package-release.mjs —— M8 打包：产出桌面交付物
 *
 * 产出（对齐历史约定，见桌面上的 v6.1.0 / v6.3.0 交付物）：
 *   ① dsh-novel-writer-v<版本>.zip        —— 整仓副本（含 tools/ 与 test/，排除 .git / .github / dist / docs / node_modules）
 *   ② dsh-novel-writer-v<版本>-更新日志.md —— CHANGELOG 的该版本章节单独成文
 *
 * 为什么排除 docs/：它是 GitHub Pages 站点（从仓库发布），不属于插件包内容；
 * 历史交付物（v6.3.0.zip，65 条目）也是这个口径。
 *
 * 铁律：**门禁不全绿就拒绝打包**。打包一个跑不过测试的版本没有意义。
 *
 * 用法：
 *   node tools/package-release.mjs            预演（只报告将产出什么）
 *   node tools/package-release.mjs --apply    实际产出
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const APPLY = process.argv.includes('--apply');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const VER = pkg.version;
const DESKTOP = join(process.env.USERPROFILE || 'C:\\Users\\zg', 'Desktop');

const EXCLUDE_TOP = new Set(['.git', '.github', 'dist', 'docs', 'node_modules', 'tmp-route-book']);
const EXCLUDE_ANY = new Set(['node_modules', '.git', '.DS_Store', 'Thumbs.db']);
// 生成物目录：截图是开发期前后对比的**产物**（6 个目录 × 30 张 ≈ 15 MB），不属于发布内容，
// 且随时可由 tools/visual/capture.mjs 重新生成。工装脚本、宿主令牌与冻结基线**保留**。
const EXCLUDE_DIR_RE = /[\\/]tools[\\/]visual[\\/]shots(-[a-z0-9]+)?[\\/]/;

const problems = [];
const log = (m) => console.log('  ' + m);

// ---------- 0) 门禁 ----------
console.log(`=== 打包 v${VER} ===\n=== 0) 门禁（不全绿则拒绝打包）===`);
// ⚠️ 本清单随仓库实际拥有的脚本而变。
//    v6.5.0 分支上有 check-client-invariants / verify-protected / verify-tool-count，
//    main（6.4.0 线）没有这些文件 —— 硬编码它们会让打包在第一步就 ENOENT。
//    这里用 existsSync 过滤：脚本不存在就跳过并注明，而不是假装通过。
const GATE_CANDIDATES = [
  ['build:check', ['tools/build-client.mjs', '--check']],
  ['ui-audit', ['tools/ui-audit.mjs', 'lib/client.js']],
  ['check-release', ['tools/check-release.mjs']],
  ['tests', ['test/run-tests.mjs']],
  ['invariants', ['tools/check-client-invariants.mjs']],
  ['protected', ['tools/verify-protected.mjs']],
  ['tool-count', ['tools/verify-tool-count.mjs']],
];
const gates = GATE_CANDIDATES.filter(([, args]) => existsSync(join(REPO, args[0])));
for (const [name] of GATE_CANDIDATES) {
  if (!gates.some(([n]) => n === name)) log(`— ${name.padEnd(14)} 本仓库无此脚本，跳过`);
}
for (const [name, args] of gates) {
  let code = 0, out = '';
  try { out = execFileSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { code = e.status === undefined ? 1 : e.status; out = String(e.stdout || '') + String(e.stderr || ''); }
  const tail = out.trim().split('\n').filter(Boolean).pop() || '';
  log(`${code === 0 ? '✓' : '✗'} ${name.padEnd(14)} ${tail.slice(0, 90)}`);
  if (code !== 0) problems.push(`门禁未通过：${name}`);
}
if (problems.length) {
  console.error('\n✗ 拒绝打包：\n' + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}

// ---------- 1) 收集要打进 zip 的文件 ----------
function walk(dir, acc = []) {
  if (EXCLUDE_DIR_RE.test(dir + '\\')) return acc;
  for (const e of readdirSync(dir)) {
    if (EXCLUDE_ANY.has(e)) continue;
    const p = join(dir, e);
    if (EXCLUDE_DIR_RE.test(p + '\\')) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
const files = [];
for (const e of readdirSync(REPO)) {
  if (EXCLUDE_TOP.has(e) || EXCLUDE_ANY.has(e)) continue;
  const p = join(REPO, e);
  if (statSync(p).isDirectory()) walk(p, files);
  else files.push(p);
}
const totalBytes = files.reduce((s, f) => s + statSync(f).size, 0);
console.log(`\n=== 1) 待打包 ===`);
log(`文件 ${files.length} 个，原始 ${(totalBytes / 1048576).toFixed(1)} MB`);
log(`排除顶层：${[...EXCLUDE_TOP].join(', ')}`);
// 自检：绝不能把 node_modules / .git 打进去
const bad = files.filter((f) => /[\\/](node_modules|\.git)[\\/]/.test(f));
if (bad.length) problems.push(`打包清单里混入了 ${bad.length} 个 node_modules/.git 文件`);

// ---------- 2) 更新日志单独成文 ----------
const cl = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
const m = cl.match(new RegExp(`^## \\[${VER.replace(/\./g, '\\.')}\\][\\s\\S]*?(?=^## \\[|$(?![\\s\\S]))`, 'm'));
if (!m) problems.push(`CHANGELOG 里找不到 ## [${VER}] 章节`);
const section = m ? m[0].trimEnd() + '\n' : '';
const clOut = `# dsh-novel-writer v${VER} 更新日志\n\n> 本文件由 \`tools/package-release.mjs\` 从仓库 \`CHANGELOG.md\` 的 \`## [${VER}]\` 章节提取。\n> 完整历史见仓库 CHANGELOG.md 与 https://siweina.github.io/dsh-novel-writer/\n\n${section}`;
log(`\n=== 2) 更新日志 ===`);
log(`章节 ${section.length} 字符 → 单文件 ${clOut.length} 字符`);

if (problems.length) {
  console.error('\n✗ 打包失败：\n' + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}

const zipPath = join(DESKTOP, `dsh-novel-writer-v${VER}.zip`);
const mdPath = join(DESKTOP, `dsh-novel-writer-v${VER}-更新日志.md`);
console.log(`\n=== 3) 产出 ===`);
log(`${zipPath}`);
log(`${mdPath}`);
if (!APPLY) { console.log('\n（预演，未写盘；加 --apply 执行）'); process.exit(0); }

// ---------- 3) 写 zip（用 PowerShell Compress-Archive，避免引入 zip 依赖）----------
const stage = join(REPO, 'dist', `stage-v${VER}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const rootName = `dsh-novel-writer-v${VER}`;
for (const f of files) {
  const rel = relative(REPO, f);
  const dest = join(stage, rootName, rel);
  mkdirSync(join(dest, '..'), { recursive: true });
  writeFileSync(dest, readFileSync(f));
}
log(`暂存 ${files.length} 个文件到 dist/stage-v${VER}/${rootName}/`);
rmSync(zipPath, { force: true });
// ⚠️ 不要用 PowerShell 的 Compress-Archive：它写出的条目名是**反斜杠**分隔
//    （`dsh-novel-writer-v6.5.0\lib\client.js`），而 ZIP 规范要求正斜杠 ——
//    在 Linux/macOS 上解压会生成名字里带反斜杠的文件。历史交付物（v6.3.0.zip）用的是正斜杠。
//    bsdtar（Windows 10+ 自带 `tar.exe`）写出的 zip 符合规范。
execFileSync('tar', ['-a', '-c', '-f', zipPath, '-C', stage, rootName], { stdio: ['ignore', 'pipe', 'pipe'] });
writeFileSync(mdPath, clOut, 'utf8');
rmSync(stage, { recursive: true, force: true });

// 自检：条目名必须是正斜杠，且不得混入 node_modules/.git
{
  const list = execFileSync('tar', ['-tf', zipPath], { encoding: 'utf8' }).trim().split('\n');
  const bad = list.filter((n) => n.includes('\\'));
  const leaked = list.filter((n) => /(^|\/)(node_modules|\.git)\//.test(n));
  log(`✓ 条目 ${list.length} 个；反斜杠条目 ${bad.length}；混入 node_modules/.git ${leaked.length}`);
  if (bad.length) problems.push(`zip 里有 ${bad.length} 个反斜杠条目（跨平台解压会出错）`);
  if (leaked.length) problems.push(`zip 里混入 ${leaked.length} 个 node_modules/.git 条目`);
  if (problems.length) { console.error('\n✗ ' + problems.join('\n  - ')); process.exit(1); }
}

const zipSize = statSync(zipPath).size;
log(`✓ ${zipPath}  ${(zipSize / 1048576).toFixed(1)} MB`);
log(`✓ ${mdPath}  ${statSync(mdPath).size} B`);
console.log('\n下一步：node tools/install-desktop.mjs --apply');
