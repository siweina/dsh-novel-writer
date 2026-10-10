/**
 * 子串碰撞取证 B：**邻接字统计**
 *
 * scan-substring.mjs 只给每个词的 top-4 窗口，而语料里大量窗口是**真命中**
 * （客栈/江湖/掌柜…），真误报的窗口（学生[先生]走）排不进 top-4。
 * 本探针换一个口径：对每个 2 字词，统计「紧邻前一字」「紧邻后一字」的分布，
 * 并给出每个邻接字的实例上下文——高频 + 语义上属于别的词 = 碰撞。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LIB = 'F:/doment/dnw-work/lib/';
const markers = await import(pathToFileURL(LIB + 'lexicons/markers.js').href);
const { DEFAULT_BANNED_WORDS, SPEECH_STYLE_RULES } = markers;

const words = [];
const seen = new Set();
const push = (label, arr) => (arr || []).forEach((w) => {
  if (typeof w !== 'string' || w.length !== 2) return;
  if (/[^\u4e00-\u9fa5]/.test(w)) return;      // 只审纯汉字 2 字词
  if (seen.has(w)) return;
  seen.add(w);
  words.push({ label, word: w });
});
push('默认禁用词', DEFAULT_BANNED_WORDS.bannedWords);
push('欧式·客套禁用', SPEECH_STYLE_RULES.western.honorBad);
push('中式·客套禁用', SPEECH_STYLE_RULES.eastern.honorBad);

const raw = readFileSync('F:/doment/corpus/books.jsonl', 'utf8');
let corpus = '';
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  try { corpus += JSON.parse(line).text + '\n'; } catch { /* 坏行跳过 */ }
}

const WINDOW = 10;
const clean = (s) => s.replace(/\n/g, '~').replace(/\s+/g, ' ');

const out = [];
for (const { label, word } of words) {
  const before = new Map();   // 前一字 → {n, ex:Set}
  const after = new Map();
  let count = 0;
  let from = 0;
  for (;;) {
    const i = corpus.indexOf(word, from);
    if (i < 0) break;
    count += 1;
    const b = corpus[i - 1];
    const a = corpus[i + word.length];
    const win = clean(corpus.slice(Math.max(0, i - WINDOW), Math.min(corpus.length, i + word.length + WINDOW)));
    const mark = (map, ch) => {
      if (!ch || ch === '\n') return;
      const cur = map.get(ch) || { n: 0, ex: new Set() };
      cur.n += 1;
      if (cur.ex.size < 3) cur.ex.add(win.replace(word, '[' + word + ']'));
      map.set(ch, cur);
    };
    mark(before, b);
    mark(after, a);
    from = i + word.length;
  }
  if (count === 0) continue;
  const top = (map) => [...map.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 6)
    .map(([ch, v]) => ({ ch, n: v.n, ex: [...v.ex] }));
  out.push({ label, word, count, before: top(before), after: top(after) });
}

out.sort((a, b) => b.count - a.count);
const lines = ['语料字符数: ' + corpus.length.toLocaleString(), '待审 2 字词: ' + words.length, ''];
for (const r of out) {
  lines.push('[' + r.label + '] 「' + r.word + '」 共 ' + r.count + ' 次');
  lines.push('   前一字: ' + r.before.map((b) => b.ch + '×' + b.n).join('  '));
  for (const b of r.before) lines.push('        ' + b.ch + ' | ' + b.ex.join(' || '));
  lines.push('   后一字: ' + r.after.map((a) => a.ch + '×' + a.n).join('  '));
  for (const a of r.after) lines.push('        ' + a.ch + ' | ' + a.ex.join(' || '));
  lines.push('');
}
writeFileSync('F:/doment/_cache/audit/neighbor-stats.txt', lines.join('\n'), 'utf8');
console.log('已写出 neighbor-stats.txt（' + lines.length + ' 行，' + out.length + ' 个词有命中）');
