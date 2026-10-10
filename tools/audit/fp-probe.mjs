/**
 * 误报复现：把「无辜句子」喂进**真实代码路径**（novel_continuity_check → collectStyleCandidates），
 * 看哪些真被报出来。
 *
 * 语料扫描只说明"哪些词容易当子串"，本探针说明"真的会报错"。
 * 分两本书，因为生效的词表取决于文化基准：
 *   书 A 欧式 → 禁中式词（DEFAULT_BANNED_WORDS + western.honorBad）
 *   书 B 中式 → 禁西式词（eastern.honorBad）
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LIB = 'F:/doment/dnw-work/lib/';
const { apply } = await import(pathToFileURL(LIB + 'index.js').href);

const root = 'F:\\doment\\_cache\\fp-test';
process.env.DSH_NOVEL_WRITER_STATE = join(root, 'state.json');
rmSync(root, { recursive: true, force: true });

// ───────── 书 A：欧式，正文全是**无辜句子** ─────────
// 每句都自然，且都恰好把某个禁词当子串含进去。
const A = '北境纪事';
const AD = join(root, 'novels', A);
mkdirSync(AD, { recursive: true });
writeFileSync(join(AD, '第01章 山洼.md'), `# 第一章 山洼

这里正是莫雷尔在手绘草图上标出的“东北山洼”。

托盘上摆放着几样东西：一张执照，还有厚厚一叠带着油墨香味的银行汇票。

“他是王国里少有的优秀人才。”随从低声说。

“可我们必须确保长期供应不断。”莫雷尔摇头。

所有劳动都应当得到报偿，这一点他从不怀疑。

这是一间专门房间，用来存放旧档案。

他们是一对老夫老妻了，争吵早已成了习惯。

他递上了合伙计划书，纸边被汗浸软。

议会通过了新的石油条例，码头上的工人议论纷纷。

他知道士兵们已经疲惫，却什么也没说。

和平尚且难以维持，何况一场漫长的战争。

“把图纸缩小二倍。”莫雷尔说。

这批丝绸来自浙江湖州，价格高得离谱。

即使是文官人才也必须宣誓，这是规矩。

他看见教头将信收好，塞进怀里。

“他不是什么大人物。”随从说。

雨还在下着，他在下面的地窖里点了灯。

他平日里正人君子的模样，此刻全不见了。

雨点打在窗上，声音像有人在数铜板。
`, 'utf8');

// ───────── 书 B：中式，正文全是**无辜句子** ─────────
// 中式表禁的是西式词，但下面这些在中文语境里完全正当。
const B = '青石巷';
const BD = join(root, 'novels', B);
mkdirSync(BD, { recursive: true });
writeFileSync(join(BD, '第01章 打烊.md'), `# 第一章 打烊

账房先生把最后一块门板装上，回身吹熄了灯。

老先生姓周，在巷口开了三十年铺子。

他修的是剑道，门中修士皆以剑入道，境界分明。

城南那座教堂是前朝留下的，如今早空了。

城外山上有座城堡，据说是旧时土司修的。

“Miss 这个词，洋人用得多。”教书先生说。

“Thank you 我不会说。”他摆摆手。

神甫来巷子里发过几次面饼，孩子们都认得他。

弥撒的钟声隔着河传过来，听着倒像庙里的钟。

圣器收在柜子深处，落了灰。
`, 'utf8');

// ───────── 起插件 ─────────
const registry = [];
const ctx = {
  tools: { register: (d) => { registry.push(d); return () => {}; } },
  systemPrompt: { section: () => () => {} },
  inject: (names, cb) => cb({ webServer: { register: () => () => {} }, effect: (fn) => fn() }),
};
apply(ctx, { root, sentenceAnalysis: { enabled: false }, allowLanState: false });
const defs = Object.fromEntries(registry.map((d) => [d.name, d]));
const exec = { agent: { session: { header: { cwd: root } } } };

// 书 A 登记欧式基准（只填 basis——报告里的真实路径）
await defs.novel_settings.execute({
  book: A, category: 'worldview', action: 'add',
  name: '王国纪事·欧式基准', basis: '西方/欧式中世纪（95%），剑与魔法、教廷与骑士',
}, exec);
// 书 B 登记中式基准
await defs.novel_settings.execute({
  book: B, category: 'worldview', action: 'add',
  name: '巷陌·中式基准', basis: '古代中式市井（95%），州县、坊巷、庙宇',
}, exec);

// ───────── 跑审计 ─────────
const run = async (book) => {
  const args = { book, chapter: '1' };
  const v = await defs.novel_continuity_check.execute(args, exec);
  return { v, style: (v.styleCandidates || []).slice() };
};

for (const [book, label] of [[A, '书 A《北境纪事》· 欧式基准'], [B, '书 B《青石巷》· 中式基准']]) {
  const { v, style } = await run(book);
  console.log('\n' + '='.repeat(78));
  console.log(label + '   → styleCandidates ' + style.length + ' 条');
  console.log('='.repeat(78));
  if (!style.length) console.log('  （无）');
  for (const c of style) {
    console.log('  [' + c.type + '] ' + String(c.detail).slice(0, 150));
  }
}

// ───────── 用户登记的危险正则（复现反馈里的 上.*香）─────────
console.log('\n' + '='.repeat(78));
console.log('追加：在书 A 的世界观里登记一条**用户自写**的危险正则 上.*香');
console.log('='.repeat(78));
await defs.novel_settings.execute({
  book: A, category: 'worldview', action: 'update', name: '王国纪事·欧式基准',
  speechStyle: { ritualBadPatterns: ['上.*香'], ritualGoodNote: '欧式宗教仪式=点蜡烛' },
}, exec);
const after = await run(A);
const ritual = (after.style || []).filter((c) => /仪式/.test(c.type));
console.log('  仪式类候选 ' + ritual.length + ' 条：');
  for (const c of ritual) console.log('    ' + String(c.detail).slice(0, 160));
console.log('\n  ↑ 正文里那句是「托盘上摆放着几样东西…油墨香味」——与反馈描述一致。');
