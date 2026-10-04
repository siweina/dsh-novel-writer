#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const server = JSON.parse(read('server.json'));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
assert.equal(lock.version, pkg.version, 'lockfile version');
assert.equal(lock.packages[''].version, pkg.version, 'lockfile root version');
assert.equal(server.version, pkg.version, 'MCP server version');
for (const item of server.packages.filter(item => item.registryType === 'npm')) assert.equal(item.version, pkg.version, 'MCP npm package version');
assert.ok(read('CHANGELOG.md').includes(`## [${pkg.version}]`), 'current changelog section');
let pages = [];
// 安装用 ZIP 不带站点，仓库和 CI 则必须检查站点版本。
if (existsSync(new URL('docs/', root))) {
  pages = ['docs/index.html', ...readdirSync(new URL('docs/tools/', root)).filter(p => p.startsWith('novel-') && p.endsWith('.html')).map(p => 'docs/tools/' + p)];
  for (const page of pages) {
    const versions = [...read(page).matchAll(/"softwareVersion":"([^"]+)"/g)];
    assert.ok(versions.length, `${page}: missing softwareVersion`);
    for (const [, value] of versions) assert.equal(value, pkg.version, `${page}: softwareVersion`);
  }
} else assert.ok(!process.env.GITHUB_ACTIONS, 'CI requires docs directory');
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : process.argv[2];
if (tag) assert.equal(tag, `v${pkg.version}`, 'release tag must match package.json');
console.log(`Version ${pkg.version}: package, lockfile, MCP, changelog and ${pages.length} pages agree.`);
