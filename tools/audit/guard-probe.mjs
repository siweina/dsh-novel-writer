/**
 * 误报审计 C：**守卫表的端到端复现**（differential probe）
 *
 * 与 scan-substring.mjs / neighbor-stats.mjs 的分工：
 *   · 那两个说的是「哪些词在真实语料里容易当子串」；
 *   · 本探针说的是「这些命中在**真实代码路径**里是不是真的被判成误报，以及守卫是否真的挡住了它」。
 *
 * 做法：把守卫表里每条的 evidence 原句（去掉 [ ] 标记）+ 每条的「真词使用」反例句各写一行，
 * 组成两本书（欧式基准 / 中式基准，因为生效词表取决于文化基准），然后**跑两遍**
 * novel_continuity_check → collectStyleCandidates：
 *
 *   ① 守卫打开：碰撞行**不得**报出；真用法行**必须**报出。
 *   ② 守卫清空（同一进程内把所有守卫键 delete 掉）：碰撞行**必须**报出——
 *      这一遍是①的对照，证明这些行确实是「扫描会命中」的误报，而不是句子本身不触发扫描。
 *
 * 逐行判定（不是逐词）：用的正是候选里的 `locations`（真实行号区间），
 * 所以同一章里「某词既有碰撞行又有真用法行」也能分开判。
 *
 * 用法：node tools/audit/guard-probe.mjs        （退出码 0 = 全部符合预期）
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LIB = 'F:/doment/dnw-work/lib/';
const { COLLISION_GUARDS } = await import(pathToFileURL(LIB + 'lexicons/guards.js').href);
const { SPEECH_STYLE_RULES } = await import(pathToFileURL(LIB + 'lexicons/markers.js').href);
const { apply } = await import(pathToFileURL(LIB + 'index.js').href);

/** 中式基准下禁的是这 11 个西式词；其余守卫词归欧式基准（默认禁词 + western.honorBad）。 */
const EASTERN = new Set(SPEECH_STYLE_RULES.eastern.honorBad);

/** 每个守卫词的「真词使用」反例句——与 test/guards-test.mjs 的 TRUE_USAGE 同源。 */
const TRUE_USAGE = {
  "里正": "他当了里正三年，村里的事都由他断",
  "在下": "在下愿闻其详",
  "大人": "公爵大人请留步",
  "官人": "娘子，你官人我回来了",
  "上香": "他跪在坟前上香",
  "见教": "不知兄台有何见教",
  "门房": "那门房脸刷地就黑了下来",
  "老夫": "这间店铺是老夫多年前买下的",
  "伙计": "他是店里的伙计，手脚麻利",
  "有劳": "那就有劳先生了",
  "道士": "穿道袍的道士正在招收弟子",
  "油条": "街口的油条炸得金黄",
  "江湖": "人在江湖，身不由己",
  "小二": "他是这客栈的小二",
  "保长": "村里推举他做了保长",
  "小人": "你这小人，竟敢在此搬弄是非",
  "打尖": "我们到前面的镇子打尖歇脚",
  "员外": "城东的员外派人送来了贺礼",
  "神甫": "那位神甫在祭坛前点燃了蜡烛",
  "修士": "修道院里的修士们正在祈祷",
  "圣器": "那件圣器被锁在祭坛下的密室里",
  "秀才": "他考中了秀才，光宗耀祖",
  "科举": "今年朝廷又要开科举了",
  "铜板": "他掏出两枚铜板放在柜台上",
  "碎银": "他把几块碎银推了过去",
  "赏钱": "老爷赏钱倒是从不吝啬",
  "见笑": "让诸位见笑了",
  "敝人": "这位兄弟，敝人姓王，初来乍到",
  "劳烦": "那就劳烦先生了",
  "捕快": "几名捕快连夜搜查了整条街"
};

/** 去掉 evidence 里的 [ ] 标记，还原成真实句子。 */
function unmark(marked, word) {
  return marked.replace(/[[\]]/g, '');
}

// ───────── 组装两本书 ─────────
const root = 'F:\\doment\\_cache\\guard-test';
process.env.DSH_NOVEL_WRITER_STATE = join(root, 'state.json');
rmSync(root, { recursive: true, force: true });

const books = {
  west: {
    name: '北境纪事',
    basis: '西方/欧式中世纪（95%），剑与魔法、教廷与骑士',
    head: '# 第一章 山洼',
    lines: [],
    expect: new Map()      // word → { collision: [行号], truth: [行号] }
  },
  east: {
    name: '青石巷',
    basis: '古代中式市井（95%），州县、坊巷、庙宇',
    head: '# 第一章 打烊',
    lines: [],
    expect: new Map()
  }
};
// 行号必须与**落盘后的真实行号**对齐：第 1 行是标题、第 2 行留空，正文从第 3 行开始。
// （踩过一次：行号按「只数正文」算，整表偏移 2 行，判定全部假红。）
for (const book of Object.values(books)) book.lines.push(book.head, '');

function pushLine(book, text) {
  book.lines.push(text);
  const no = book.lines.length;   // 真实行号（1 起）
  book.lines.push('');            // 空行分隔，保证每句独立成行
  return no;
}

for (const [word, guard] of Object.entries(COLLISION_GUARDS)) {
  const book = EASTERN.has(word) ? books.east : books.west;
  const rec = { collision: [], truth: [] };
  for (const ev of guard.evidence || []) rec.collision.push(pushLine(book, unmark(ev, word)));
  const truth = TRUE_USAGE[word];
  if (!truth) { console.error('缺真用法反例句：' + word); process.exit(1); }
  rec.truth.push(pushLine(book, truth));
  book.expect.set(word, rec);
}

// ───────── 起插件、建书、登记文化基准 ─────────
const registry = [];
const ctx = {
  tools: { register: (d) => { registry.push(d); return () => {}; } },
  systemPrompt: { section: () => () => {} },
  inject: (names, cb) => cb({ webServer: { register: () => () => {} }, effect: (fn) => fn() }),
};
apply(ctx, { root, sentenceAnalysis: { enabled: false }, allowLanState: false });
const defs = Object.fromEntries(registry.map((d) => [d.name, d]));
const exec = { agent: { session: { header: { cwd: root } } } };

for (const [key, book] of Object.entries(books)) {
  const dir = join(root, 'novels', book.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '第01章 探针.md'), book.lines.join('\n') + '\n', 'utf8');
  await defs.novel_settings.execute({
    book: book.name, category: 'worldview', action: 'add',
    name: key === 'west' ? '王国纪事·欧式基准' : '巷陌·中式基准',
    basis: book.basis
  }, exec);
}

// ───────── 跑一轮审计，取「词 → 命中行号集合」 ─────────
async function run(book) {
  const v = await defs.novel_continuity_check.execute({ book: book.name, chapter: '1' }, exec);
  const hits = new Map();   // word → Set(行号)
  for (const c of v.styleCandidates || []) {
    if (!c.word) continue;
    const set = hits.get(c.word) || new Set();
    for (const loc of c.locations || []) {
      for (const r of loc.ranges || []) {
        for (let n = r.from; n <= r.to; n += 1) set.add(n);
      }
    }
    hits.set(c.word, set);
  }
  return hits;
}

const withGuards = { west: await run(books.west), east: await run(books.east) };

// ───────── 清空守卫表，再跑一遍作对照 ─────────
const removed = Object.keys(COLLISION_GUARDS);
for (const k of removed) delete COLLISION_GUARDS[k];
const withoutGuards = { west: await run(books.west), east: await run(books.east) };
if (Object.keys(COLLISION_GUARDS).length !== 0) { console.error('守卫表清空失败'); process.exit(1); }

// ───────── 判定 ─────────
let bad = 0;
const fmt = (ns) => '[' + [...ns].sort((a, b) => a - b).join(',') + ']';
for (const [key, book] of Object.entries(books)) {
  const on = withGuards[key], off = withoutGuards[key];
  console.log('\n===== ' + (key === 'west' ? '书 A《北境纪事》· 欧式基准' : '书 B《青石巷》· 中式基准')
    + '（守卫 ' + removed.length + ' 条 → 清空对照）=====');
  for (const [word, rec] of book.expect) {
    const onSet = on.get(word) || new Set();
    const offSet = off.get(word) || new Set();
    const collisionStillReported = rec.collision.filter((n) => onSet.has(n));
    const collisionMissedInControl = rec.collision.filter((n) => !offSet.has(n));
    const truthMissing = rec.truth.filter((n) => !onSet.has(n));
    const ok = collisionStillReported.length === 0 && collisionMissedInControl.length === 0 && truthMissing.length === 0;
    if (!ok) bad += 1;
    console.log(
      (ok ? '  ✔ ' : '  ✘ ') + word.padEnd(4, '　')
      + ' 碰撞行 ' + fmt(rec.collision)
      + ' 守卫开=' + fmt(new Set(rec.collision.filter((n) => onSet.has(n))))
      + ' 守卫关=' + fmt(new Set(rec.collision.filter((n) => offSet.has(n))))
      + ' | 真用法行 ' + fmt(rec.truth) + ' 守卫开=' + fmt(new Set(rec.truth.filter((n) => onSet.has(n))))
    );
    if (collisionStillReported.length) console.log('      · 守卫没挡住碰撞行：' + fmt(new Set(collisionStillReported)));
    if (collisionMissedInControl.length) console.log('      · 对照组里碰撞行根本没被报出（这条守卫没意义？）：' + fmt(new Set(collisionMissedInControl)));
    if (truthMissing.length) console.log('      · 真用法行被守卫吃掉了：' + fmt(new Set(truthMissing)));
  }
}

console.log('\n' + (bad === 0
  ? '全部 ' + Object.values(books).reduce((s, b) => s + b.expect.size, 0) + ' 条守卫：碰撞行被挡住、对照组确实命中、真用法行仍然报出。'
  : bad + ' 条守卫不符合预期。'));
process.exit(bad === 0 ? 0 : 1);
