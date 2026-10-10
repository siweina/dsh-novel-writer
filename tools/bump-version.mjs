/**
 * bump-version.mjs —— v6.5.0 版本号原子提升（协调方专用，不属于发布物）
 *
 * 为什么需要它：tools/check-release.mjs 强制要求下列位置的版本号**完全一致**：
 *   package.json / package-lock.json(2 处) / server.json(2 处) / CHANGELOG.md 章节 / docs 全部页面 softwareVersion
 * 手工改 21 个 HTML 极易漏改。本脚本一次改全，并用 check-release 复验。
 *
 * 用法：
 *   node tools/bump-version.mjs 6.5.0          # 预演（不写盘，只报告将改什么）
 *   node tools/bump-version.mjs 6.5.0 --apply   # 实际写盘
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const NEW = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!/^\d+\.\d+\.\d+$/.test(NEW || '')) { console.error('用法: node bump-version.mjs <x.y.z> [--apply]'); process.exit(1); }

const w = (p, s) => { if (APPLY) writeFileSync(p, s, 'utf8'); };
const changes = [];

// 1) package.json
const pkgPath = join(REPO, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const oldVer = pkg.version;
if (oldVer !== NEW) {
  changes.push(`package.json: version ${oldVer} → ${NEW}`);
  const txt = readFileSync(pkgPath, 'utf8').replace(`"version": "${oldVer}"`, `"version": "${NEW}"`);
  w(pkgPath, txt);
}

// 2) package-lock.json（version + packages[""].version）
const lockPath = join(REPO, 'package-lock.json');
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const hits = [];
  if (lock.version !== NEW) hits.push('lock.version');
  if (lock.packages && lock.packages[''] && lock.packages[''].version !== NEW) hits.push('lock.packages[""].version');
  if (hits.length) {
    changes.push(`package-lock.json: ${hits.join(', ')} → ${NEW}`);
    if (APPLY) {
      lock.version = NEW;
      if (lock.packages && lock.packages['']) lock.packages[''].version = NEW;
      writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
    }
  }
}

// 3) server.json（version + packages[].version，仅 npm 类型）
// ⚠️ 必须用**文本替换**而不是 JSON 往返：JSON.stringify 按 2 空格重排，而本文件原本是
//    4 空格缩进 —— 那会把整个文件重排版（2244 → 1870 字符），在 diff 里看起来像"动了后端清单"，
//    掩盖真正的改动（M5 实测踩到，由 tools/verify-protected.mjs 的归一化比对抓出）。
const srvPath = join(REPO, 'server.json');
if (existsSync(srvPath)) {
  const srvText = readFileSync(srvPath, 'utf8');
  const srv = JSON.parse(srvText);
  const hits = [];
  if (srv.version !== NEW) hits.push('version');
  for (const p of srv.packages || []) if (p.registryType === 'npm' && p.version !== NEW) hits.push('packages[npm].version');
  if (hits.length) {
    changes.push(`server.json: ${hits.join(', ')} → ${NEW}（文本替换，保持原缩进）`);
    if (APPLY) {
      const out = srvText.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/g, (_m, a, b) => a + NEW + b);
      // 自检：除版本号外必须逐字不变，否则中止（绝不静默重排版）
      const before = srvText.replace(/\d+\.\d+\.\d+/g, '<V>');
      const after = out.replace(/\d+\.\d+\.\d+/g, '<V>');
      if (before !== after) { console.error('✗ server.json 除版本号外还有改动，已中止（请人工检查）'); process.exit(1); }
      writeFileSync(srvPath, out, 'utf8');
    }
  }
}

// 4) Dockerfile（MCP 目录如 Glama 按它构建容器）
//
// v6.5.0 新增。此前 Dockerfile 里写死 `ARG DSH_NOVEL_WRITER_VERSION=6.3.0`，
// 而这个脚本不管它 → 6.4.0 / 6.5.0 两次发版都漂移，Glama 构出来的容器装的还是 6.3.0，
// 版本不符使构建判定失败。现在 Dockerfile 默认从 package.json 读版本（不会漂移），
// 但**若有人又写死了版本号**，这里负责改掉并明确提示，而不是让它悄悄错下去。
const dockerPath = join(REPO, 'Dockerfile');
if (existsSync(dockerPath)) {
  const dText = readFileSync(dockerPath, 'utf8');
  // 只看非注释行：文件头说明里会提到旧版本号，按整文件扫会被自己的注释误伤（本次踩过）
  const dCode = dText.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  const stale = [...dCode.matchAll(/(?:dsh-novel-writer@|DSH_NOVEL_WRITER_VERSION=)(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  const need = stale.filter((v) => v !== NEW);
  if (need.length) {
    changes.push(`Dockerfile: 写死的版本 ${need.join(', ')} → ${NEW}（建议改成从 package.json 读取，见文件头注释）`);
    if (APPLY) {
      const out = dText
        .replace(/(dsh-novel-writer@)\d+\.\d+\.\d+/g, (_m, a) => a + NEW)
        .replace(/(DSH_NOVEL_WRITER_VERSION=)\d+\.\d+\.\d+/g, (_m, a) => a + NEW);
      const before = dText.replace(/\d+\.\d+\.\d+/g, '<V>');
      const after = out.replace(/\d+\.\d+\.\d+/g, '<V>');
      if (before !== after) { console.error('✗ Dockerfile 除版本号外还有改动，已中止（请人工检查）'); process.exit(1); }
      writeFileSync(dockerPath, out, 'utf8');
    }
  } else {
    changes.push('Dockerfile: 无写死版本（从 package.json 读取）✓');
  }
}

// 5) docs 页面 softwareVersion（index.html + tools/novel-*.html + tools/index.html 若已有）
const docsDir = join(REPO, 'docs');
const pages = [];
if (existsSync(docsDir)) {
  pages.push(join(docsDir, 'index.html'));
  const tdir = join(docsDir, 'tools');
  if (existsSync(tdir)) {
    for (const f of readdirSync(tdir)) {
      if (f.endsWith('.html') && (f.startsWith('novel-') || f === 'index.html')) pages.push(join(tdir, f));
    }
  }
}
let pageChanged = 0, pageMissing = [], pageNoField = [];
for (const p of pages) {
  if (!existsSync(p)) { pageMissing.push(p); continue; }
  const t = readFileSync(p, 'utf8');
  const re = /"softwareVersion"\s*:\s*"([^"]+)"/g;
  const found = [...t.matchAll(re)];
  if (found.length === 0) { pageNoField.push(p.replace(REPO + '\\', '')); continue; }
  if (found.every((m) => m[1] === NEW)) continue;
  const out = t.replace(re, `"softwareVersion":"${NEW}"`);
  w(p, out);
  pageChanged++;
}
changes.push(`docs 页面 softwareVersion → ${NEW}：改了 ${pageChanged} 个（共扫 ${pages.length} 个）`);
if (pageNoField.length) changes.push(`⚠ 缺 softwareVersion 字段的页面（需补）：${pageNoField.join(', ')}`);
if (pageMissing.length) changes.push(`⚠ 不存在的页面：${pageMissing.join(', ')}`);

// 4b) docs/index.html 的**可见**版本徽章（brand__ver）
// ⚠️ 它不在 JSON-LD 里，所以只改 softwareVersion 会漏掉它——页头会一直显示旧版本号，
//    是用户直接看得见的不一致（M5 实测踩到：徽章停在 v6.3.0）。
{
  const p = join(docsDir, 'index.html');
  if (existsSync(p)) {
    const t = readFileSync(p, 'utf8');
    const re = /(<span class="brand__ver">v?)(\d+\.\d+\.\d+)(<\/span>)/g;
    const found = [...t.matchAll(re)];
    if (found.length === 0) changes.push('⚠ docs/index.html 未找到可见版本徽章（brand__ver），请人工确认');
    else if (found.every((m) => m[2] === NEW)) changes.push(`docs/index.html 可见版本徽章已是 v${NEW} ✓`);
    else {
      changes.push(`docs/index.html 可见版本徽章：${found.map((m) => 'v' + m[2]).join(', ')} → v${NEW}`);
      w(p, t.replace(re, `$1${NEW}$3`));
    }
  }
}

// 5) CHANGELOG 章节
const clPath = join(REPO, 'CHANGELOG.md');
if (existsSync(clPath)) {
  const cl = readFileSync(clPath, 'utf8');
  const has = cl.includes(`## [${NEW}]`);
  changes.push(`CHANGELOG.md: ${has ? `已有 ## [${NEW}] 章节 ✓` : `⚠ 缺少 ## [${NEW}] 章节（必须先补）`}`);
}

console.log(`\n=== 版本提升 ${oldVer} → ${NEW} ${APPLY ? '（已写盘）' : '（预演，未写盘）'} ===`);
for (const c of changes) console.log('  ' + c);
console.log('\n  下一步：在 ' + REPO + ' 下运行  node tools/check-release.mjs  复验');
