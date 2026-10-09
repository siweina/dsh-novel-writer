#!/usr/bin/env node
/**
 * tools/install-desktop.mjs —— M8 本地安装：把 v<版本> 装进 **desktop 端** profile
 *
 * 硬约束（用户明确要求）：**只装 desktop 端，绝不装 web 端**。
 *   本脚本把目标路径写死为 `%USERPROFILE%\.dsh\profiles\desktop`，并在每一步断言它，
 *   绝不接受外部传入的 profile 路径。web 端（`%USERPROFILE%\.dsh\profiles\node_modules` 那条共享根）
 *   一行都不会被碰。
 *
 * 安装机制（与既有 6.1.0 / 6.2.0 / 6.3.0 一致）：
 *   ① 把仓库副本放到  ~/.dsh/plugin-packages/dsh-novel-writer-<版本>/
 *   ② profile 的 package.json 里 dependencies["dsh-novel-writer"] 指向该目录（file: 协议）
 *   ③ 在 profile 目录跑 pnpm install 建立链接
 *
 * ⚠️ 生效需要**重启 desktop 应用**（插件在启动时加载）。重启会结束当前会话。
 *
 * 用法：
 *   node tools/install-desktop.mjs            预演
 *   node tools/install-desktop.mjs --apply    实际安装
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const APPLY = process.argv.includes('--apply');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const VER = pkg.version;

const HOME = process.env.USERPROFILE || 'C:\\Users\\zg';
const PROFILES = join(HOME, '.dsh', 'profiles');
const PROFILE = join(PROFILES, 'desktop');          // ← 写死：desktop 端
const WEB_PROFILE_ROOT = PROFILES;                  // web 端共享根（profiles/node_modules）
const PKG_DIR = join(HOME, '.dsh', 'plugin-packages', `dsh-novel-writer-${VER}`);

const problems = [];
const log = (m) => console.log('  ' + m);
const sha16 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);

// ---------- 0) 安全断言：目标必须是 desktop 端 ----------
console.log(`=== 安装 v${VER} 到 desktop 端 ===\n=== 0) 目标断言 ===`);
log(`profile   : ${PROFILE}`);
log(`包目录    : ${PKG_DIR}`);
if (!/profiles[\\/]desktop$/.test(PROFILE)) problems.push('目标 profile 不是 desktop 端（拒绝执行）');
if (!existsSync(join(PROFILE, 'package.json'))) problems.push(`目标 profile 缺 package.json：${PROFILE}`);
// 反向断言：web 端共享根绝不能被写
if (PROFILE === WEB_PROFILE_ROOT) problems.push('目标误指向 web 端共享根（拒绝执行）');
if (problems.length) { console.error('\n✗ ' + problems.join('\n  - ')); process.exit(1); }
log('✓ 目标是 desktop 端；web 端共享根不会被触碰');

// ---------- 1) 源产物自检 ----------
console.log('\n=== 1) 源产物自检 ===');
const clientHash = sha16(join(REPO, 'lib', 'client.js'));
log(`lib/client.js sha256(16) = ${clientHash}`);
const MANIFEST = join(REPO, 'tools', 'client-src', 'manifest.json');
if (existsSync(MANIFEST)) {
  const mf = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  log(`构建清单：${mf.blocks.length} 块（启用 ${mf.blocks.filter((b) => b.enabled !== false).length}）+ 退役 ${(mf.retired || []).length} 组`);
}
let gate = 0;
try { execFileSync(process.execPath, ['tools/build-client.mjs', '--check'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (e) { gate = 1; }
log(`${gate === 0 ? '✓' : '✗'} build:check`);
if (gate !== 0) problems.push('产物与构建源不一致（先跑 npm run build）');

// ---------- 2) 待复制清单（与 package-release.mjs 同口径） ----------
const EXCLUDE_TOP = new Set(['.git', '.github', 'dist', 'docs', 'node_modules', 'tmp-route-book']);
const EXCLUDE_ANY = new Set(['node_modules', '.git', '.DS_Store', 'Thumbs.db']);
const EXCLUDE_DIR_RE = /[\\/]tools[\\/]visual[\\/]shots(-[a-z0-9]+)?[\\/]/;
function walk(dir, acc = []) {
  if (EXCLUDE_DIR_RE.test(dir + '\\')) return acc;
  for (const e of readdirSync(dir)) {
    if (EXCLUDE_ANY.has(e)) continue;
    const p = join(dir, e);
    if (EXCLUDE_DIR_RE.test(p + '\\')) continue;
    if (statSync(p).isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}
const files = [];
for (const e of readdirSync(REPO)) {
  if (EXCLUDE_TOP.has(e) || EXCLUDE_ANY.has(e)) continue;
  const p = join(REPO, e);
  if (statSync(p).isDirectory()) walk(p, files); else files.push(p);
}
console.log('\n=== 2) 待复制 ===');
log(`${files.length} 个文件，${(files.reduce((s, f) => s + statSync(f).size, 0) / 1048576).toFixed(1)} MB`);

// ---------- 3) profile package.json 改动 ----------
const profPkgPath = join(PROFILE, 'package.json');
const profPkgText = readFileSync(profPkgPath, 'utf8');
const profPkg = JSON.parse(profPkgText);
const wantSpec = 'file:' + PKG_DIR.replace(/\\/g, '/');
const curSpec = profPkg.dependencies && profPkg.dependencies['dsh-novel-writer'];
console.log('\n=== 3) profile 依赖指向 ===');
log(`当前: ${curSpec}`);
log(`目标: ${wantSpec}`);
if (!profPkg.dependencies || !('dsh-novel-writer' in profPkg.dependencies)) problems.push('profile 的 dependencies 里没有 dsh-novel-writer');
if (!(profPkg.dsh && profPkg.dsh.profile && Array.isArray(profPkg.dsh.profile.bundles) && profPkg.dsh.profile.bundles.includes('dsh-novel-writer'))) {
  problems.push('profile 的 dsh.profile.bundles 未注册 dsh-novel-writer');
} else log('✓ dsh.profile.bundles 已注册');

if (problems.length) { console.error('\n✗ 安装前检查失败：\n  - ' + problems.join('\n  - ')); process.exit(1); }
if (!APPLY) { console.log('\n（预演，未写盘；加 --apply 执行）'); process.exit(0); }

// ---------- 4) 复制 ----------
console.log('\n=== 4) 复制包 ===');
rmSync(PKG_DIR, { recursive: true, force: true });
mkdirSync(PKG_DIR, { recursive: true });
for (const f of files) {
  const dest = join(PKG_DIR, relative(REPO, f));
  mkdirSync(join(dest, '..'), { recursive: true });
  copyFileSync(f, dest);
}
const installedClient = join(PKG_DIR, 'lib', 'client.js');
log(`✓ 复制 ${files.length} 个文件到 ${PKG_DIR}`);
log(`  包内 lib/client.js sha256(16) = ${sha16(installedClient)}（源 ${clientHash}）`);
if (sha16(installedClient) !== clientHash) { console.error('✗ 复制后的产物与源不一致，中止'); process.exit(1); }
const installedVer = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version;
if (installedVer !== VER) { console.error(`✗ 包内版本 ${installedVer} ≠ ${VER}`); process.exit(1); }
log(`✓ 包内版本 = ${installedVer}`);

// ---------- 5) 改 profile 依赖 + 安装 ----------
console.log('\n=== 5) 更新 profile 依赖并安装 ===');
const bak = profPkgPath + '.bak-' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
copyFileSync(profPkgPath, bak);
log(`✓ 已备份 profile package.json → ${bak}`);
const newText = profPkgText.replace(
  /("dsh-novel-writer"\s*:\s*")[^"]*(")/,
  (_m, a, b) => a + wantSpec + b
);
if (newText === profPkgText) {
  // ⚠️ 不要在这里中止：重复安装时依赖**已经**指向目标版本，替换后文本自然不变。
  //    早期版本把这当成"替换失败"并退出 1，导致幂等重跑失败（M8 实测踩到）。
  if (curSpec === wantSpec) log('✓ 依赖指向已是目标值（幂等重跑，无需改写）');
  else { console.error('✗ 未能替换依赖指向，中止（profile 未改动）'); process.exit(1); }
} else {
  writeFileSync(profPkgPath, newText, 'utf8');
  log('✓ 依赖指向已更新');
}

let installOut = '', installCode = 0;
try {
  installOut = execFileSync('pnpm', ['install', '--reporter', 'append-only'], {
    cwd: PROFILE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true, timeout: 600000,
  });
} catch (e) {
  installCode = e.status === undefined ? 1 : e.status;
  installOut = String(e.stdout || '') + String(e.stderr || '');
}
log(`${installCode === 0 ? '✓' : '✗'} pnpm install（exit ${installCode}）`);
for (const l of installOut.trim().split('\n').slice(-6)) log('    ' + l);

// ---------- 6) 安装后验证 ----------
console.log('\n=== 6) 安装后验证 ===');
const linked = join(PROFILE, 'node_modules', 'dsh-novel-writer');
if (!existsSync(linked)) problems.push('安装后 node_modules/dsh-novel-writer 不存在');
else {
  const lv = JSON.parse(readFileSync(join(linked, 'package.json'), 'utf8')).version;
  const lh = existsSync(join(linked, 'lib', 'client.js')) ? sha16(join(linked, 'lib', 'client.js')) : '(无)';
  log(`node_modules 里的版本 = ${lv}`);
  log(`node_modules 里 lib/client.js sha256(16) = ${lh}`);
  if (lv !== VER) problems.push(`node_modules 里的版本 ${lv} ≠ ${VER}`);
  if (lh !== clientHash) problems.push(`node_modules 里的产物 ${lh} ≠ 源 ${clientHash}`);
}

console.log('');
if (problems.length) { console.error('✗ 安装有问题：\n  - ' + problems.join('\n  - ')); process.exit(1); }
console.log('✅ 安装完成。**重启 desktop 应用后生效**（插件在启动时加载；重启会结束当前会话）。');
console.log('   回滚：把 ' + bak + ' 覆盖回 profile 的 package.json，再跑一次 pnpm install。');
