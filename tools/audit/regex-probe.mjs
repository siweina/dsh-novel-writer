/**
 * 误报审计 B：正则类风险
 *
 * 机制：lib/index.js:2882 `new RegExp(pattern, "g")` —— 用户登记的模式**原样编译**，
 * 无锚定、无长度界（仅 <=200 字符）、整章文本一把梭。三类风险：
 *   ① 跨句：`.*` / `[\s\S]*` 会跨过句号与换行
 *   ② 子串：可选量词让"本不相邻"的字凑在一起（如 上[数字]*[柱炷]?香 命中「身上香喷喷」）
 *   ③ ReDoS：嵌套量词（(a+)+ / (.*)*）在长文本上指数回溯
 */
const SHIPPED_WESTERN = [
  '上[一二三四五六七八九十百千两]*[柱炷]?香',
  '[一二三四五六七八九十百千两]+[柱炷]香',
  '烧香', '磕头', '跪拜'
];
const SHIPPED_EASTERN = ['点烛', '蜡烛', '礼拜', '祈祷跪下?', 'light candle'];

console.log('=== ① 内置模式的「子串」风险：本不相邻的字被可选量词凑起来 ===');
const cases = [
  ['身上香喷喷的味道', '上香'],
  ['他站在香炉旁', '上香(需 上+香 相邻)'],
  ['托盘上摆放着几样东西，带着油墨香味', '反馈里的句子'],
  ['马车上香槟酒洒了一地', '上香槟'],
  ['他跪下祈祷', '祈祷跪下?'],
  ['这件事值得礼拜一下', '礼拜'],
  ['点亮蜡烛', '点烛/蜡烛'],
  ['他跪拜下去', '跪拜']
];
for (const [text, note] of cases) {
  const hits = [];
  for (const p of [...SHIPPED_WESTERN, ...SHIPPED_EASTERN]) {
    const re = new RegExp(p, 'g');
    const m = text.match(re);
    if (m) hits.push('/' + p + '/ → ' + JSON.stringify(m));
  }
  console.log('  ' + (hits.length ? '✗ 命中' : '✓ 未命中') + '  「' + text + '」  (' + note + ')');
  hits.forEach((h) => console.log('        ' + h));
}

console.log('\n=== ② 用户自写模式的跨句风险（整章一把梭，无句边界） ===');
const chapter = '第一句提到上。第二句是无关的叙述，中间隔了很多字。' + '填充。'.repeat(30) + '最后提到香。';
console.log('  整章长度: ' + chapter.length + ' 字符');
for (const p of ['上.*香', '上[\\s\\S]*香', '上.{0,5}香']) {
  const m = chapter.match(new RegExp(p, 'g'));
  console.log('  /' + p + '/  → ' + (m ? '✗ 命中 ' + JSON.stringify(m.map((s) => s.slice(0, 24) + '…(' + s.length + '字)')) : '✓ 未命中'));
}

console.log('\n=== ③ ReDoS：嵌套量词在长文本上的回溯代价 ===');
const long = '上'.repeat(28) + 'x';
for (const p of ['(上+)+香', '(上*)*香', '上{0,200}香']) {
  const t0 = process.hrtime.bigint();
  try {
    new RegExp(p, 'g').test(long);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log('  /' + p + '/  用时 ' + ms.toFixed(2) + ' ms  ' + (ms > 50 ? '← ✗ 明显回溯' : ''));
  } catch (e) {
    console.log('  /' + p + '/  抛错: ' + e.message);
  }
}

console.log('\n=== ④ 内置模式里「可选量词」的可疑写法清点 ===');
const all = [...SHIPPED_WESTERN, ...SHIPPED_EASTERN];
for (const p of all) {
  const flags = [];
  if (/\.\*|\[\\s\\S\]\*/.test(p)) flags.push('跨句通配');
  if (/[?*]\s*$/.test(p) || /[?*]/.test(p)) flags.push('可选量词');
  if (/\{\d+,\d*\}/.test(p)) flags.push('有界量词');
  if (!/[\^\$\\b]/.test(p)) flags.push('无边界锚');
  console.log('  /' + p + '/  ' + (flags.length ? flags.join(' / ') : '（纯字面量）'));
}
