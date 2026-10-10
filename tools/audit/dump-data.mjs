/** 导出全部禁词与语用正则，供误报审计使用 */
import { pathToFileURL } from 'node:url';
const LIB = 'F:/doment/dnw-work/lib/';
const m = await import(pathToFileURL(LIB + 'lexicons/markers.js').href);

const dump = (label, arr) => {
  console.log('\n=== ' + label + '（' + (arr || []).length + ' 条）===');
  (arr || []).forEach((w, i) => console.log('  ' + String(i + 1).padStart(3) + '. ' + w));
};

console.log('markers.js 导出:', Object.keys(m).join(', '));

const d = m.DEFAULT_BANNED_WORDS;
if (d && typeof d === 'object') {
  if (Array.isArray(d.groups)) {
    console.log('\n=== DEFAULT_BANNED_WORDS.groups ===');
    for (const g of d.groups) {
      console.log('\n  【' + (g.label || g.name || '?') + '】' + (g.note ? '  // ' + g.note : ''));
      console.log('    ' + (g.words || []).join(' / '));
    }
    console.log('\n  groups 合计词数:', d.groups.reduce((s, g) => s + (g.words || []).length, 0));
  }
  dump('DEFAULT_BANNED_WORDS.bannedWords(扁平)', d.bannedWords);
  console.log('\n=== recommended 映射 ===');
  const rec = d.recommended || {};
  console.log('  条数:', Object.keys(rec).length);
  for (const k of Object.keys(rec)) console.log('    ' + k + ' → ' + rec[k]);
}

const e = m.EASTERN_MARKER_BANLIST;
if (e) {
  console.log('\n=== EASTERN_MARKER_BANLIST ===');
  console.log('  label:', e.label, '| source:', e.source);
  console.log('  note:', e.note);
  console.log('  words(' + (e.words || []).length + '):', (e.words || []).join(' / '));
  console.log('  excluded:', JSON.stringify(e.excluded));
}

const s = m.SPEECH_STYLE_RULES;
if (s) {
  console.log('\n=== SPEECH_STYLE_RULES 文化键 ===', Object.keys(s).join(', '));
  for (const [culture, rule] of Object.entries(s)) {
    console.log('\n--- ' + culture + ' ---');
    for (const [k, v] of Object.entries(rule)) {
      if (Array.isArray(v)) console.log('  ' + k + ' (' + v.length + '): ' + v.join(' / '));
      else if (v && typeof v === 'object') console.log('  ' + k + ': ' + JSON.stringify(v));
      else console.log('  ' + k + ': ' + v);
    }
  }
}
