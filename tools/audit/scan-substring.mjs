/**
 * 误报审计 A：子串碰撞扫描
 *
 * 机制：lib/index.js 的禁词/客套词判定是 `text.includes(word)`（纯子串）。
 * 因此只要禁词是某个常用词的**子串**，就会 100% 误报（如「这【里正】是」）。
 *
 * 方法：对每个词，在真实中文网文语料里取出「匹配点周围的固定窗口」并统计频次。
 * 若该词被包在更长的词里，那个窗口会高频重复 → 碰撞自动浮现。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LIB = 'F:/doment/dnw-work/lib/';
const markers = await import(pathToFileURL(LIB + 'lexicons/markers.js').href);
const { DEFAULT_BANNED_WORDS, EASTERN_MARKER_BANLIST, SPEECH_STYLE_RULES } = markers;

// ---- 收集待审词（带来源标签）----
const subjects = [];
const push = (label, words) => (words || []).forEach((w) => subjects.push({ label, word: w }));
push('默认禁用词', DEFAULT_BANNED_WORDS.bannedWords);
push('中式标记词表', EASTERN_MARKER_BANLIST.words);
push('欧式·客套禁用', SPEECH_STYLE_RULES.western.honorBad);
push('中式·客套禁用', SPEECH_STYLE_RULES.eastern.honorBad);

// 去重（同一个词可能在多表里）
const seen = new Set();
const uniq = [];
for (const s of subjects) {
  const k = s.label + '|' + s.word;
  if (seen.has(k)) continue;
  seen.add(k);
  uniq.push(s);
}

// ---- 载入语料 ----
const raw = readFileSync('F:/doment/corpus/books.jsonl', 'utf8');
let corpus = '';
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  try { corpus += JSON.parse(line).text + '\n'; } catch { /* 跳过坏行 */ }
}
console.log('语料字符数: ' + corpus.length.toLocaleString());

const WINDOW = 4;   // 匹配点左右各取几个字
const rows = [];
for (const { label, word } of uniq) {
  if (!word) continue;
  const freq = new Map();
  let count = 0;
  let from = 0;
  for (;;) {
    const i = corpus.indexOf(word, from);
    if (i < 0) break;
    count += 1;
    const win = corpus.slice(Math.max(0, i - WINDOW), Math.min(corpus.length, i + word.length + WINDOW)).replace(/\n/g, '~');
    freq.set(win, (freq.get(win) || 0) + 1);
    from = i + word.length;
    if (count > 200000) break;
  }
  if (count === 0) continue;
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  rows.push({ label, word, len: word.length, count, top });
}

// ---- 输出：先列「2 字词」这类高危项（越短越容易当子串）----
rows.sort((a, b) => a.len - b.len || b.count - a.count);

// 输出走 node 自己的 fs 写 UTF-8 文件——**不要**用 PowerShell 的 `>` 重定向：
// 那会用 UTF-16LE 落盘，后续按 UTF-8 读会变成乱码/被判成二进制文件（本次踩过）。
const lines = [];
lines.push('语料字符数: ' + corpus.length.toLocaleString());
lines.push('命中词数: ' + rows.length + ' / 待审 ' + uniq.length);
lines.push('');
for (const r of rows) {
  lines.push('[' + r.label + '] 「' + r.word + '」 共 ' + r.count + ' 次  (len=' + r.len + ')');
  for (const [win, c] of r.top) {
    lines.push('    ' + String(c).padStart(5) + ' x ' + win.replace(r.word, '[' + r.word + ']'));
  }
}
writeFileSync('F:/doment/_cache/audit/scan-substring.txt', lines.join('\n'), 'utf8');
console.log('已写出 scan-substring.txt（' + lines.length + ' 行）');
console.log(lines.slice(0, 3).join('\n'));
