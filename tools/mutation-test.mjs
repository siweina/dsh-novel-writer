/**
 * 变异测试：证明 test/style-rule-test.mjs 的断言**真的有鉴别力**。
 *
 * 起因：独立验证子代理用 9 次变异证明初版有 3 条摆设断言（例如「模型能看到掌柜」
 * 只因夹具正文里本来就有「掌柜」，v6.3.0 也能通过）。重写后必须自证。
 *
 * 做法：改坏一处 → 跑测试 → **必须失败** → 立刻还原 → 校验 sha256。
 * 还原用「先备份再覆盖」，**不用 git checkout**（工作区改动未提交，checkout 会毁掉它们）。
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const BAK = join(REPO, 'dist', 'mutbak');
mkdirSync(BAK, { recursive: true });

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const MUTATIONS = [
  {
    name: 'M-A 断掉语用规范注入（pushSpeechStyleAvoids 调用注释掉）',
    file: 'lib/brief.js',
    from: 'if (worldview) pushSpeechStyleAvoids(worldview.speechStyle, avoid);',
    to: 'if (worldview && false) pushSpeechStyleAvoids(worldview.speechStyle, avoid);',
    expectFail: ['语用规范四类进了注入载荷', '语用禁词「提点」在注入载荷里'],
  },
  {
    name: 'M-B 恢复 10 条截断（pushBannedWordAvoids 只看前 10 个）',
    file: 'lib/brief.js',
    from: 'function pushBannedWordAvoids(bannedWords, recommended, avoid) {',
    to: 'function pushBannedWordAvoids(bannedWords, recommended, avoid) {\n  bannedWords = bannedWords.slice(0, 10);',
    expectFail: ['禁词条目数与裁决结果'],
  },
  {
    name: 'M-C 改稿台退回"无默认表兜底"（第三个词源复现）',
    file: 'lib/fixplan.js',
    from: 'const bannedEntry = styleRule.bannedWords.length > 0',
    to: 'const bannedEntry = styleRule.userBannedWords.length > 0',
    expectFail: ['改稿台报出'],
  },
  {
    name: 'M-D 去掉 checklist 的语用点名（删掉整条 checklist.push，而不是只换句首）',
    file: 'lib/brief.js',
    // ⚠️ 两个坑都踩过：① 只换句首会留下「语用规范·称谓/…」交叉引用，断言照过（变异不忠实）；
    //    ② from 里带缩进/换行会因 CRLF 与 4 空格缩进而匹配不上。这里用**不含缩进与换行的单行子串**。
    from: 'checklist.push("称呼、客套、仪式与语气按本设定的语用规范写（见 avoid 的「语用规范·称谓/客套/仪式/语气」条目）：不要出现与登记规范冲突的称谓、客套语或仪式表达");',
    to: '',
    expectFail: ['checklist 点名要求遵守语用规范'],
  },
  {
    name: 'M-E 审计侧把词表截到 20（与开写包分叉）',
    file: 'lib/index.js',
    from: 'function collectStyleCandidates(styleRule, chapterTexts, singleChapter) {',
    to: 'function collectStyleCandidates(styleRule, chapterTexts, singleChapter) {\n  styleRule = { ...styleRule, bannedWords: styleRule.bannedWords.slice(0, 20) };',
    expectFail: ['章节审计报出'],
  },
];

const runTest = () => {
  try {
    const out = execFileSync(process.execPath, ['test/style-rule-test.mjs'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

console.log('=== 基线 ===');
const baseline = runTest();
console.log(`  exit=${baseline.code}  ${baseline.out.trim().split('\n').pop()}`);
if (baseline.code !== 0) { console.error('✗ 基线不是绿的，先修好再变异'); process.exit(1); }

let caught = 0, missed = [];
for (const m of MUTATIONS) {
  const p = join(REPO, m.file);
  const bak = join(BAK, m.file.replace(/[\\/]/g, '__'));
  const before = sha(p);
  copyFileSync(p, bak);

  const txt = readFileSync(p, 'utf8');
  if (!txt.includes(m.from)) { console.log(`  ⚠ ${m.name}\n      替换目标未命中，跳过（可能被上游改动）`); copyFileSync(bak, p); continue; }
  writeFileSync(p, txt.replace(m.from, m.to), 'utf8');

  const r = runTest();
  copyFileSync(bak, p);              // 立刻还原
  const after = sha(p);
  const restored = before === after;

  const failedNames = m.expectFail.filter((n) => r.out.includes(n));
  const okCaught = r.code !== 0 && failedNames.length > 0;
  console.log(`  ${okCaught ? '✓ 抓到' : '✗ 漏过'}  ${m.name}`);
  console.log(`      exit=${r.code}｜命中预期失败项 ${failedNames.length}/${m.expectFail.length}｜还原${restored ? '✓' : '✗ 哈希不符！'}`);
  if (okCaught && restored) caught += 1;
  else missed.push(m.name + (restored ? '' : '（还原失败）'));
}

console.log(`\n变异测试：${caught}/${MUTATIONS.length} 被抓到`);
if (missed.length) { console.error('漏过的变异：\n  - ' + missed.join('\n  - ')); process.exit(1); }
console.log('全部变异均被断言抓住 → 测试具备鉴别力');
rmSync(BAK, { recursive: true, force: true });
