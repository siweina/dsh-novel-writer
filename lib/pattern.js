/**
 * 句式模式分析引擎 — 纯函数、零依赖。
 *
 * 把正文拆成句子，按启发式规则分类：
 *   S   陈述/叙事   ENV 环境描写   PSY 心理描写   DLG 对话
 *   Q   疑问句      RQ  反问句     EX  感叹句
 * 然后输出：各类占比、高频句式组合（三元组）、按章节的压缩排列序列。
 *
 * 这是给模型做"风格节奏参考"的软信号，不是精确语法标注：启发式分类
 * 允许有误差，模型应把它当节奏参考而非硬约束（见插件提示词中的风险说明）。
 */

/** 全部句式代码（顺序即展示顺序）。 */
export const TYPE_CODES = ["S", "ENV", "PSY", "DLG", "Q", "RQ", "EX"];

/** 对话：句子含中文/英文引号即视为对话（优先于其它类型）。 */
const DIALOGUE_RE = /[“”"「」『』‘’]/;
/** 疑问句：以问号结尾。 */
const INTERROGATIVE_RE = /[？?]$/;
/** 反问句：疑问句且含典型反问标记词。 */
const RHETORICAL_RE = /难道|岂|何尝|焉能|怎能|怎么会|哪里|哪儿|哪有|不是吗|莫非|不成|何必|未必|何苦|奈何/;
/** 感叹句：以感叹号结尾。 */
const EXCLAMATION_RE = /[！!]$/;
/** 心理描写标记词（较保守，避免把常见动词"想/知道"误判为心理）。 */
const PSY_RE = /心里|心中|心想|心道|暗自|暗暗|不禁|忍不住|觉得|感到|感觉|仿佛|似乎|好像|但愿|后悔|担心|害怕|怀疑|意识到|没想到|没料到|怔了怔|愣住|内心|回忆|想念|寒了|一沉|一紧|倒吸/;
/** 环境描写标记词（天色/天气/景物类名词）。 */
const ENV_RE = /夜色|月光|晨光|暮色|夕阳|黄昏|清晨|深夜|夜空|天边|星光|灯火|细雨|微风|大雨|暴雨|风雪|薄雾|浓雾|云层|远山|山影|河面|湖水|街道|巷子|烛火|窗|雨声|风声|树影|落叶|残雪|霜|天色/;

/** 把正文拆成句子（保留句末标点；无标点的尾部片段也算一句）。 */
export function splitSentences(text) {
  const sentences = [];
  const re = /[^。！？…!?]*[。！？…!?]/g;
  let match;
  let last = 0;
  while ((match = re.exec(text)) !== null) {
    const sentence = match[0].trim();
    if (sentence.length > 0) sentences.push(sentence);
    last = match.index + match[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail.length > 0) sentences.push(tail);
  return sentences;
}

/** 单句分类（优先级：对话 > 疑问/反问 > 感叹 > 心理 > 环境 > 陈述）。 */
export function classifySentence(sentence) {
  if (DIALOGUE_RE.test(sentence)) return "DLG";
  if (INTERROGATIVE_RE.test(sentence)) return RHETORICAL_RE.test(sentence) ? "RQ" : "Q";
  if (EXCLAMATION_RE.test(sentence)) return "EX";
  if (PSY_RE.test(sentence)) return "PSY";
  if (ENV_RE.test(sentence)) return "ENV";
  return "S";
}

/** 压缩排列序列：S×8 ENV×2 PSY×3 …（跑长编码，直观展示句式先后排列）。 */
export function compressSequence(codes, maxRuns = 48) {
  const runs = [];
  for (const code of codes) {
    const last = runs[runs.length - 1];
    if (last !== void 0 && last.code === code) last.n += 1;
    else runs.push({ code, n: 1 });
  }
  const parts = runs.slice(0, maxRuns).map((run) => `${run.code}×${run.n}`);
  if (runs.length > maxRuns) parts.push(`…(共${runs.length}段)`);
  return parts.join(" ");
}

/** 各类占比（整数百分比）。 */
export function ratioMap(counts, total) {
  const out = {};
  for (const code of TYPE_CODES) out[code] = total > 0 ? Math.round((counts[code] / total) * 100) : 0;
  return out;
}

/**
 * 分析一段正文的句式模式。
 * @param text - 正文。
 * @param opts - { top: 高频组合条数（默认 10）, maxSentences: 采样上限（默认 4000） }。
 * @returns { codes, counts, topPatterns, sequence, ratios }
 */
export function analyzePattern(text, opts = {}) {
  const top = opts.top ?? 10;
  const maxSentences = opts.maxSentences ?? 4000;
  const sentences = splitSentences(text).slice(0, maxSentences);
  const codes = sentences.map(classifySentence);
  const counts = {};
  for (const code of TYPE_CODES) counts[code] = 0;
  for (const code of codes) counts[code] += 1;
  const grams = new Map();
  for (let i = 0; i + 2 < codes.length; i += 1) {
    const key = codes.slice(i, i + 3).join("→");
    grams.set(key, (grams.get(key) ?? 0) + 1);
  }
  const topPatterns = [...grams.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([pattern, count]) => ({ pattern, count }));
  return {
    codes,
    counts,
    topPatterns,
    sequence: compressSequence(codes),
    ratios: ratioMap(counts, codes.length)
  };
}

/** 生成给模型的风格节奏建议（紧凑文本）。 */
export function buildGuidance(ratios, topPatterns, chapterSequences) {
  const ratioText = TYPE_CODES
    .filter((code) => ratios[code] > 0)
    .map((code) => `${code} ${ratios[code]}%`)
    .join(" · ");
  const patternText = topPatterns.length > 0
    ? topPatterns.slice(0, 5).map((p) => `${p.pattern} ×${p.count}`).join("、")
    : "（样本过短，未形成高频组合）";
  const lines = [
    `句式分布：${ratioText}`,
    `高频句式组合：${patternText}`
  ];
  if (chapterSequences.length > 0) {
    lines.push("章节节奏（压缩序列，S=陈述 ENV=环境 PSY=心理 DLG=对话 Q=疑问 RQ=反问 EX=感叹）：");
    for (const item of chapterSequences.slice(0, 12)) lines.push(`  ${item.chapter}: ${item.sequence}`);
  }
  return lines.join("\n");
}
