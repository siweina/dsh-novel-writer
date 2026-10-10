#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');

/**
 * JSON 顶层键扫描（原始文本断言）。
 * 起因：package.json 曾同时存在 `"version": "6.1.0"` 与 `"version": "6.2.0"` 两行，
 * JSON.parse 只保留末值，于是下面「四处版本一致」全是假绿——错的地方一个也拦不住。
 * 因此这里不看 parse 结果，直接扫原始文本的顶层键：顶层键必须各出现一次，
 * 「version」额外限定只允许 1 次，把同类错误钉死在发布门禁里。
 * 取键口径：**字符串感知的括号深度扫描**——只有深度恰为 1 处的 `"key":` 才算顶层键，
 * 与缩进无关（更深层级的同名键，如 lockfile 里每个包的 "version"，不计入）。
 *
 * v6.3.0 加固：早期实现按「最小缩进层」取键，存在缩进规避盲区——把重复的 `"version"`
 * 写成比其它顶层键更浅的缩进（顶层用 4 空格、重复行用 2 空格）时，min(indents) 会被该行
 * 拉低、真正的顶层键全部被过滤掉，versionCount 变成 1 而漏过；这种样本 JSON.parse 也合法
 * （末值生效），旧口径与 parse 都看不出区别。现改为按括号深度判定。
 */
const topLevelKeys = text => {
  const keys = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      // 读一个字符串字面量（处理转义），再往后跳过空白看是否紧跟 ':'
      let j = i + 1;
      let value = '';
      while (j < text.length) {
        const c = text[j];
        if (c === '\\') { value += text[j + 1] ?? ''; j += 2; continue; }
        if (c === '"') break;
        value += c;
        j += 1;
      }
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k += 1;
      if (depth === 1 && text[k] === ':') keys.push(value);
      i = j + 1;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    i += 1;
  }
  return keys;
};
for (const name of ['package.json', 'server.json', 'package-lock.json']) {
  const topKeys = topLevelKeys(read(name));
  assert.ok(topKeys.length > 0, `${name}: 找不到顶层键（文件结构异常）`);
  const duplicates = topKeys.filter((key, index) => topKeys.indexOf(key) !== index);
  assert.equal(duplicates.length, 0, `${name}: 顶层出现重复键 ${[...new Set(duplicates)].join('、')}（JSON.parse 只保留末值，会掩盖错误）`);
  const versionCount = topKeys.filter(key => key === 'version').length;
  assert.equal(versionCount, 1, `${name}: 顶层 "version" 只允许出现 1 次，实测 ${versionCount} 次（JSON.parse 只保留末值，会掩盖错误）`);
}

// 工具数守卫：用户可见文案（README / MCP 元数据 / 面板副标题）里的数字此前无人核对，
// 于是 ALL_TOOLS 已是 19、文案却长期停在 18。这里以 lib/core.js 的 ALL_TOOLS 为单一事实源
// 做一致性校验，新增工具时改一处即可，文案漂移会被挡在这里。
const { ALL_TOOLS } = await import(new URL('../lib/core.js', import.meta.url).href);
assert.equal(ALL_TOOLS.length, 19, `ALL_TOOLS 数量（lib/core.js 声明 ${ALL_TOOLS.length} 个；用户可见文案写的是 19 个）`);

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

// 容器构建守卫（v6.5.0 新增）：Dockerfile 里**不得写死版本号**。
//
// 起因是一次真实的构建失败：Dockerfile 曾有 `ARG DSH_NOVEL_WRITER_VERSION=6.3.0`，
// 靠注释提醒「每次发版请同步」。6.4.0 / 6.5.0 两次都忘了改（bump-version 也没覆盖它），
// 于是 Glama 按该 Dockerfile 构出来的容器里装的仍是 6.3.0 —— 请求 6.5.0 却得到 6.3.0，
// 构建判定失败（Glama 恰好从 6.4.0 起报 build failed）。
// 现在版本从 package.json 读，这里再钉一道：任何写死的 dsh-novel-writer@x.y.z / ARG= x.y.z
// 只要与当前版本不一致就失败，防止旧写法复活。
const dockerfile = read('Dockerfile');
// ⚠️ **只看非注释行**：本文件头部的说明注释里就写着旧版本号（"此前这里是 …=6.3.x"），
// 第一版守卫没排除注释，于是被自己的说明误伤（check-release 恒红）——这里按行过滤掉 `#` 开头。
const dockerCode = dockerfile.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
const pinned = [...dockerCode.matchAll(/(?:dsh-novel-writer@|DSH_NOVEL_WRITER_VERSION=)(\d+\.\d+\.\d+)/g)].map(m => m[1]);
for (const v of pinned) {
  assert.equal(v, pkg.version,
    `Dockerfile 写死了 dsh-novel-writer@${v}，而当前版本是 ${pkg.version} —— ` +
    `容器会装成旧版本，MCP 目录（Glama）会因版本不符判定构建失败。` +
    `请改为从 package.json 读取（默认写法即是），不要手写版本号。`);
}

console.log(`Version ${pkg.version}: package, lockfile, MCP, changelog and ${pages.length} pages agree; ALL_TOOLS = ${ALL_TOOLS.length}；Dockerfile 无写死版本；JSON 顶层键无重复。`);
