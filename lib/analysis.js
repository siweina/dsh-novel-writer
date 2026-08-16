/**
 * dsh-novel-writer — 句式模式分析引擎 (v0.3.0 扩展)
 *
 * 零依赖、确定性规则实现。用于分析中文小说的句式构成与排列规律：
 *   - 句式分类：陈述 / 对话 / 心理 / 疑问 / 反问 / 感叹 / 祈使 / 省略留白
 *   - 排列规律：句式转移（二元转移计数）、高频句式模板（2/3 连句）、段首段尾句式
 *   - 风格特征：句长分布、短长句占比、对话/心理密度、主观性指数
 *   - 主观情感：内置轻量情感词典（喜/怒/哀/惧/惊）与强度副词加权，输出情感曲线
 *   - 风格指纹：一维紧凑签名，便于快速比对作者的句式习惯
 *
 * 所有统计均为可复现的启发式规则，不调用任何外部服务。
 */

export const CATEGORY_LABELS = Object.freeze({
  statement: "陈述",
  dialogue: "对话",
  psychology: "心理",
  question: "疑问",
  "rhetoric-question": "反问",
  exclamation: "感叹",
  imperative: "祈使",
  ellipsis: "省略留白"
});

/** 输出固定顺序。 */
export const CATEGORY_ORDER = Object.freeze([
  "statement", "dialogue", "psychology", "question",
  "rhetoric-question", "exclamation", "imperative", "ellipsis"
]);

const EMOTION_LABELS = Object.freeze({
  joy: "喜", anger: "怒", sorrow: "哀", fear: "惧", surprise: "惊", neutral: "中性"
});

/** 轻量中文情感词典（启发式，非完整情感分析）。 */
const EMOTION_WORDS = Object.freeze({
  joy: ["高兴", "开心", "快乐", "喜悦", "愉快", "兴奋", "欣喜", "欢喜", "幸福", "满足", "欣慰", "痛快", "爽快", "笑眯眯", "笑容", "微笑", "笑", "哈哈", "乐", "欢", "喜", "甜蜜", "温暖", "踏实"],
  anger: ["愤怒", "生气", "恼火", "恼", "怒", "恨", "气愤", "气", "火冒三丈", "咬牙", "暴怒", "怒气", "不满", "厌恶", "憎恶", "怨恨", "发火", "气冲冲", "脸色铁青", "怒火", "愤恨", "恼羞成怒", "咬牙切齿"],
  sorrow: ["悲伤", "难过", "伤心", "痛苦", "悲痛", "悲哀", "哀伤", "心碎", "绝望", "哭泣", "哭", "泪", "眼泪", "流泪", "哽咽", "抽泣", "叹息", "叹气", "惆怅", "失落", "忧伤", "黯然", "心酸", "辛酸", "悲", "凄凉", "苦涩"],
  fear: ["害怕", "恐惧", "惊慌", "不安", "紧张", "担心", "畏惧", "惊恐", "胆怯", "发抖", "哆嗦", "心慌", "毛骨悚然", "冷汗", "忐忑", "惶恐", "心悸", "惊惶", "胆战心惊", "心虚"],
  surprise: ["惊讶", "震惊", "意外", "吃惊", "诧异", "愕然", "愣住", "目瞪口呆", "难以置信", "不可思议", "惊愕", "惊奇", "震撼", "傻眼", "呆住", "惊讶", "惊呆", "骇然"]
});

const STRONG_ADVERBS = ["非常", "极其", "特别", "十分", "格外", "无比", "太", "简直", "相当", "超级", "万分", "极为", "异常"];
const MILD_ADVERBS = ["有点", "有些", "稍微", "略", "些许", "不太", "挺", "稍稍"];

const FIRST_PERSON_WORDS = ["我", "我们", "咱们", "俺", "咱"];

/** 心理描写特征（内心独白 / 心理动词 / 心绪名词）。 */
const PSYCH_MARKERS = [
  /心想|心道|心说|心念|暗自|暗暗|默默|不禁|不由得|忍不住|忽然想到|突然想到|转念一想|寻思|思忖|琢磨|盘算|嘀咕|犯嘀咕|扪心自问|自言自语|心里默念|喃喃自语/,
  /觉得|感到|认为|以为|意识到|察觉|发觉|感觉|预感/,
  /希望|盼望|渴望|期待|担心|担忧|害怕|恐惧|畏惧/,
  /回忆|回想|记起|想起|记得|遗忘|怀念|思念/,
  /明白|懂得|醒悟|恍然大悟|茅塞顿开|怀疑|猜想|猜测|料想|预计|估计/,
  /打算|计划|决定|下定决心|下决心|幻想|憧憬|想象/,
  /[他她我你](想|认为|觉得|感到|以为)/,
  /心(里|中|底|头|口|尖|一沉|一紧|一颤|跳|怦怦)/,
  /在(心里|心中|心底|心头|脑海)/,
  /心里|内心|心底|心头/
];

/** 反问强标记（与疑问区分：这些词 + 疑问语气 → 反问）。 */
const RHETORIC_MARKERS = [
  /难道|岂不|岂非|岂能|岂敢|岂止|何尝|何曾|何必|何须|何苦|何不|谈何|莫非|岂|不成/,
  /哪(能|敢|会|曾|配|有|里)/,
  /怎(么)?(能|敢|会|肯|可能|可以|知道)/,
  /谁(说|知道|会|能|肯|曾|料|想到)/,
  /凭什么|干嘛|干吗|至于吗|不是吗|何至于/,
  /不是[^。！？]{0,10}吗/
];

/** 一般疑问句特征词。 */
const QUESTION_WORDS = ["谁", "什么", "为什么", "怎么", "怎样", "如何", "哪", "几", "多少", "何时", "哪里", "哪儿", "是否", "能不能", "会不会", "要不要", "行不行", "好不好", "对不对", "有没有", "为啥", "吗", "么", "呢"];

/** 祈使句动词/命令词。 */
const IMPERATIVE_HARD = ["请", "快", "赶紧", "立刻", "马上", "别", "不要", "莫", "勿", "不许", "不准", "滚", "住手", "放手", "站住", "听我说", "给我", "让", "快点儿", "快点"];
const IMPERATIVE_START = ["走", "来", "去", "坐", "站", "停", "开始", "出发", "算了吧", "算了", "吃", "喝", "看", "听", "说", "做", "干", "起来", "坐下", "住口"];

/** 句尾结束符。 */
const TERMINATORS = "。！？…";

/** 引号对。 */
const QUOTE_PAIRS = [["“", "”"], ["「", "」"], ["『", "』"], ["‘", "’"], ["\"", "\""], ["'", "'"]];

/** 文本 → 段落块：空行分段；无空行时每行视为一段。过滤 Markdown 标题。 */
export function splitBlocks(text) {
  const normalized = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const hasBlank = lines.some((line) => line.trim() === "");
  const blocks = [];
  let current = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n").trim());
        current = [];
      }
      continue;
    }
    if (!hasBlank) {
      if (!/^#{1,6}\s/.test(trimmed) && !/^[-_*=]{3,}$/.test(trimmed)) blocks.push(trimmed);
      continue;
    }
    current.push(trimmed);
  }
  if (current.length > 0) blocks.push(current.join("\n").trim());
  return blocks.filter((block) => block.length > 0);
}

/** 段落 → 句子：按 。！？… 分句，吞并连续结束符与后随的闭合引号。 */
export function splitSentences(block) {
  const sentences = [];
  let buffer = "";
  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i];
    buffer += ch;
    if (TERMINATORS.includes(ch)) {
      while (i + 1 < block.length && TERMINATORS.includes(block[i + 1])) {
        buffer += block[i + 1];
        i += 1;
      }
      let quotes = 0;
      while (quotes < 2 && i + 1 < block.length && "”」』’\"'".includes(block[i + 1]) && !TERMINATORS.includes(block[i + 1])) {
        buffer += block[i + 1];
        i += 1;
        quotes += 1;
      }
      const sentence = buffer.trim();
      if (sentence !== "") sentences.push(sentence);
      buffer = "";
    }
  }
  const rest = buffer.trim();
  if (rest !== "") sentences.push(rest);
  return sentences;
}

/** 提取引号内的直接引语片段。 */
function extractQuoted(text) {
  const segments = [];
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (const [open, close] of QUOTE_PAIRS) {
      if (text[i] === open) {
        const end = text.indexOf(close, i + 1);
        if (end !== -1) {
          segments.push(text.slice(i, end + 1));
          i = end + 1;
          matched = true;
          break;
        }
      }
    }
    if (!matched) i += 1;
  }
  return segments;
}

function hasPsychMarker(text) {
  for (const marker of PSYCH_MARKERS) {
    if (marker.test(text)) return true;
  }
  return false;
}

function endsWithQuestion(text) {
  return /[？?]$/.test(text) || /(吗|么|呢|嘛)$/.test(text);
}

function isRhetoric(text) {
  if (!endsWithQuestion(text)) return false;
  for (const marker of RHETORIC_MARKERS) {
    if (marker.test(text)) return true;
  }
  return false;
}

function isQuestion(text) {
  if (/[？?]$/.test(text)) return true;
  if (/(吗|么|呢|嘛)$/.test(text)) return true;
  if (/(是不是|好不好|行不行|要不要|能不能|会不会|有没有|对不对|愿不愿意)/.test(text) && /(吧|吗)$/.test(text)) return true;
  return false;
}

function isExclamation(text) {
  if (/[！!]$/.test(text) || /！？$/.test(text)) return true;
  if (/太[^。！？]{0,8}了/.test(text)) return true;
  if (/真(是)?[^。！？]{0,10}(啊|呀|！)/.test(text)) return true;
  if (/多么|何等|好不/.test(text)) return true;
  if (/(啊|呀|哇|哎哟|唉|哦|呵|哈哈|嘿嘿|嘻嘻|天哪|天啊|天呐)[。！？…]*$/.test(text)) return true;
  return false;
}

function isImperative(text) {
  if (!/(吧[。！？]?|！)$/.test(text)) return false;
  for (const verb of IMPERATIVE_HARD) {
    if (text.includes(verb)) return true;
  }
  return new RegExp("^(你|您|我们|咱们|大家)?(" + IMPERATIVE_START.join("|") + ")").test(text);
}

/** 对单个句子做句式分类（含优先级与引语/心理合并规则）。 */
export function classifySentence(raw) {
  const text = String(raw).trim();
  if (text === "") return { type: "statement", text, quoted: false };
  const quotedSegments = extractQuoted(text);
  if (quotedSegments.length > 0) {
    const inner = quotedSegments.join(" ");
    if (hasPsychMarker(inner)) return { type: "psychology", text, quoted: true };
    return { type: "dialogue", text, quoted: true };
  }
  if (hasPsychMarker(text)) return { type: "psychology", text, quoted: false };
  if (isRhetoric(text)) return { type: "rhetoric-question", text, quoted: false };
  if (isQuestion(text)) return { type: "question", text, quoted: false };
  if (isExclamation(text)) return { type: "exclamation", text, quoted: false };
  if (isImperative(text)) return { type: "imperative", text, quoted: false };
  if (/…+$/.test(text)) return { type: "ellipsis", text, quoted: false };
  return { type: "statement", text, quoted: false };
}

/** 情感词计数（含强度副词加权）。返回各情感得分与命中的词语。 */
function emotionOf(text) {
  const scores = { joy: 0, anger: 0, sorrow: 0, fear: 0, surprise: 0 };
  const words = { joy: [], anger: [], sorrow: [], fear: [], surprise: [] };
  let weight = 1;
  for (const adverb of STRONG_ADVERBS) {
    if (text.includes(adverb)) { weight = Math.max(weight, 1.5); break; }
  }
  for (const adverb of MILD_ADVERBS) {
    if (text.includes(adverb)) { weight = Math.min(weight, 0.6); break; }
  }
  for (const [emotion, list] of Object.entries(EMOTION_WORDS)) {
    for (const word of list) {
      if (text.includes(word)) {
        scores[emotion] += weight;
        words[emotion].push(word);
      }
    }
  }
  let dominant = "neutral";
  let best = 0;
  for (const emotion of ["joy", "anger", "sorrow", "fear", "surprise"]) {
    if (scores[emotion] > best) {
      best = scores[emotion];
      dominant = emotion;
    }
  }
  return { scores, words, dominant, total: Object.values(scores).reduce((a, b) => a + b, 0) };
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : round((sorted[mid - 1] + sorted[mid]) / 2, 2);
}

/**
 * 全书/单章句式模式分析主入口。
 * @param text 正文文本。
 * @param options { top: 句式模板返回条数（默认 8） }
 * @returns 结构化分析结果（与 novel_sentence_analysis 输出 schema 一致）。
 */
export function analyzeText(text, options = {}) {
  const top = Number.isInteger(options.top) ? options.top : 8;
  const blocks = splitBlocks(text);
  const sentences = [];
  const blockMeta = [];
  for (let b = 0; b < blocks.length; b += 1) {
    const parts = splitSentences(blocks[b]);
    const meta = { sentences: [], opening: void 0, closing: void 0 };
    for (const part of parts) {
      const classified = classifySentence(part);
      const record = {
        text: part,
        type: classified.type,
        quoted: classified.quoted,
        len: part.length,
        block: b,
        emotion: emotionOf(part)
      };
      sentences.push(record);
      meta.sentences.push(record);
    }
    if (meta.sentences.length > 0) {
      meta.opening = meta.sentences[0].type;
      meta.closing = meta.sentences[meta.sentences.length - 1].type;
    }
    blockMeta.push(meta);
  }

  const totalSentences = sentences.length;
  const totalChars = text.length;

  // 分类统计
  const counts = Object.fromEntries(CATEGORY_ORDER.map((type) => [type, 0]));
  const lengthByType = Object.fromEntries(CATEGORY_ORDER.map((type) => [type, []]));
  const examplesByType = Object.fromEntries(CATEGORY_ORDER.map((type) => [type, []]));
  for (const sentence of sentences) {
    counts[sentence.type] += 1;
    lengthByType[sentence.type].push(sentence.len);
    if (examplesByType[sentence.type].length < 3) {
      const sample = sentence.text.length > 42 ? sentence.text.slice(0, 42) + "…" : sentence.text;
      examplesByType[sentence.type].push(sample);
    }
  }
  const categories = CATEGORY_ORDER.map((type) => {
    const count = counts[type];
    const lens = lengthByType[type];
    return {
      type,
      label: CATEGORY_LABELS[type],
      count,
      ratio: totalSentences === 0 ? 0 : round(count / totalSentences, 4),
      avgLength: lens.length === 0 ? 0 : round(lens.reduce((a, b) => a + b, 0) / lens.length, 2),
      examples: examplesByType[type]
    };
  });

  // 句式转移（相邻句）
  const transitionCounts = new Map();
  for (let i = 1; i < sentences.length; i += 1) {
    const key = sentences[i - 1].type + ">" + sentences[i].type;
    transitionCounts.set(key, (transitionCounts.get(key) ?? 0) + 1);
  }
  const transitions = [...transitionCounts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split(">");
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .slice(0, 12);

  // 句式模板（2/3 连句）
  const motif2 = new Map();
  const motif3 = new Map();
  for (let i = 0; i < sentences.length; i += 1) {
    if (i + 1 < sentences.length) {
      const key = sentences[i].type + "→" + sentences[i + 1].type;
      motif2.set(key, (motif2.get(key) ?? 0) + 1);
    }
    if (i + 2 < sentences.length) {
      const key = sentences[i].type + "→" + sentences[i + 1].type + "→" + sentences[i + 2].type;
      motif3.set(key, (motif3.get(key) ?? 0) + 1);
    }
  }
  const motifEntries = [...motif2.entries(), ...motif3.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top);
  const motifs = motifEntries.map(([pattern, count]) => ({ pattern, count }));

  // 段落结构
  const opening = new Map();
  const closing = new Map();
  let dialogueOnly = 0;
  let psychologyOnly = 0;
  let mixed = 0;
  let exchanges = 0;
  for (const meta of blockMeta) {
    const types = meta.sentences.map((s) => s.type);
    if (types.length === 0) continue;
    opening.set(meta.opening, (opening.get(meta.opening) ?? 0) + 1);
    closing.set(meta.closing, (closing.get(meta.closing) ?? 0) + 1);
    const allDialogue = types.every((type) => type === "dialogue");
    const allPsych = types.every((type) => type === "psychology");
    const uniq = new Set(types).size;
    if (allDialogue) dialogueOnly += 1;
    else if (allPsych) psychologyOnly += 1;
    else if (uniq > 1) mixed += 1;
    for (let i = 1; i < types.length; i += 1) {
      if (types[i - 1] === "dialogue" && types[i] === "dialogue") exchanges += 1;
    }
  }
  const sortTypeCounts = (map) => [...map.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const paragraphs = {
    total: blockMeta.filter((meta) => meta.sentences.length > 0).length,
    avgSentences: round(totalSentences / Math.max(blockMeta.filter((meta) => meta.sentences.length > 0).length, 1), 2),
    opening: sortTypeCounts(opening),
    closing: sortTypeCounts(closing),
    dialogueOnly,
    psychologyOnly,
    mixed,
    exchanges
  };

  // 句长分布
  const lens = sentences.map((s) => s.len);
  const avgLength = lens.length === 0 ? 0 : round(lens.reduce((a, b) => a + b, 0) / lens.length, 2);
  const short = lens.filter((len) => len <= 10).length;
  const medium = lens.filter((len) => len > 10 && len <= 24).length;
  const long = lens.filter((len) => len > 24).length;
  const buckets = [
    ["1-10", (len) => len <= 10],
    ["11-20", (len) => len > 10 && len <= 20],
    ["21-30", (len) => len > 20 && len <= 30],
    ["31-40", (len) => len > 30 && len <= 40],
    ["41+", (len) => len > 40]
  ];
  const lengths = {
    avg: avgLength,
    median: median(lens),
    shortRatio: lens.length === 0 ? 0 : round(short / lens.length, 4),
    mediumRatio: lens.length === 0 ? 0 : round(medium / lens.length, 4),
    longRatio: lens.length === 0 ? 0 : round(long / lens.length, 4),
    distribution: buckets.map(([range, test]) => ({ range, count: lens.filter(test).length }))
  };

  // 情感统计
  const emotionCounts = { joy: 0, anger: 0, sorrow: 0, fear: 0, surprise: 0 };
  const emotionWordCounts = new Map();
  for (const sentence of sentences) {
    for (const [emotion, count] of Object.entries(sentence.emotion.scores)) {
      emotionCounts[emotion] += count;
    }
    for (const [emotion, words] of Object.entries(sentence.emotion.words)) {
      for (const word of words) {
        emotionWordCounts.set(word, (emotionWordCounts.get(word) ?? 0) + 1);
      }
    }
  }
  const totalEmotion = Object.values(emotionCounts).reduce((a, b) => a + b, 0);
  let dominantEmotion = "neutral";
  let bestEmotion = 0;
  for (const emotion of ["joy", "anger", "sorrow", "fear", "surprise"]) {
    if (emotionCounts[emotion] > bestEmotion) {
      bestEmotion = emotionCounts[emotion];
      dominantEmotion = emotion;
    }
  }
  const emotionDensity = totalChars === 0 ? 0 : round((totalEmotion / totalChars) * 1000, 2);
  const emotion = {
    dominant: dominantEmotion,
    scores: ["joy", "anger", "sorrow", "fear", "surprise"].map((emotionName) => ({
      emotion: emotionName,
      label: EMOTION_LABELS[emotionName],
      count: round(emotionCounts[emotionName], 2),
      words: [...new Set(EMOTION_WORDS[emotionName])].filter((word) => emotionWordCounts.has(word)).slice(0, 10)
    })),
    intensity: emotionDensity,
    topWords: [...emotionWordCounts.entries()]
      .map(([word, count]) => {
        let emotionOfWord = "neutral";
        for (const [emotionName, words] of Object.entries(EMOTION_WORDS)) {
          if (words.includes(word)) { emotionOfWord = emotionName; break; }
        }
        return { word, count, emotion: emotionOfWord };
      })
      .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
      .slice(0, 12),
    curve: emotionCurve(blockMeta, 20)
  };

  // 主观性指数（启发式 0-100）
  const psychRatio = totalSentences === 0 ? 0 : counts.psychology / totalSentences;
  const exclaimRatio = totalSentences === 0 ? 0 : counts.exclamation / totalSentences;
  const firstPersonCount = FIRST_PERSON_WORDS.reduce((sum, word) => sum + (text.split(word).length - 1), 0);
  const firstPersonDensity = totalChars === 0 ? 0 : (firstPersonCount / totalChars) * 1000;
  const subjectivityIndex = Math.min(100, Math.round(
    psychRatio * 50 + exclaimRatio * 60 + Math.min(emotionDensity * 2.5, 25) + Math.min(firstPersonDensity * 1.2, 20)
  ));

  const dialogueRatio = totalSentences === 0 ? 0 : counts.dialogue / totalSentences;
  const psychologyRatio = psychRatio;
  const questionRatio = totalSentences === 0 ? 0 : (counts.question + counts["rhetoric-question"]) / totalSentences;
  const style = {
    dialogueRatio: round(dialogueRatio, 4),
    psychologyRatio: round(psychologyRatio, 4),
    questionRatio: round(questionRatio, 4),
    exclamationRatio: round(exclaimRatio, 4),
    shortSentenceRatio: lengths.shortRatio,
    longSentenceRatio: lengths.longRatio,
    subjectivityIndex,
    emotionDensity,
    avgSentenceLength: avgLength,
    firstPersonDensity: round(firstPersonDensity, 2)
  };

  const fingerprint = buildFingerprint(categories, lengths, style, emotion, motifs);

  return {
    totalChars,
    totalSentences,
    categories,
    transitions,
    motifs,
    paragraphs,
    lengths,
    style,
    emotion,
    fingerprint
  };
}

/** 情感曲线：把段落分桶（最多 20 段），每段给出主导情感与强度。 */
function emotionCurve(blockMeta, maxSegments) {
  const blocks = blockMeta.filter((meta) => meta.sentences.length > 0);
  if (blocks.length === 0) return [];
  const segmentCount = Math.min(blocks.length, maxSegments);
  const perSegment = Math.ceil(blocks.length / segmentCount);
  const curve = [];
  for (let s = 0; s < segmentCount; s += 1) {
    const slice = blocks.slice(s * perSegment, (s + 1) * perSegment);
    let chars = 0;
    const segScores = { joy: 0, anger: 0, sorrow: 0, fear: 0, surprise: 0 };
    for (const meta of slice) {
      for (const sentence of meta.sentences) {
        chars += sentence.len;
        for (const [emotion, score] of Object.entries(sentence.emotion.scores)) {
          segScores[emotion] += score;
        }
      }
    }
    let dominant = "neutral";
    let best = 0;
    for (const emotion of ["joy", "anger", "sorrow", "fear", "surprise"]) {
      if (segScores[emotion] > best) {
        best = segScores[emotion];
        dominant = emotion;
      }
    }
    const total = Object.values(segScores).reduce((a, b) => a + b, 0);
    curve.push({
      segment: s + 1,
      dominant,
      label: EMOTION_LABELS[dominant],
      intensity: chars === 0 ? 0 : round((total / chars) * 1000, 2)
    });
  }
  return curve;
}

/** 一维风格指纹。 */
function buildFingerprint(categories, lengths, style, emotion, motifs) {
  const codeOf = { statement: "S", dialogue: "D", psychology: "P", question: "Q", "rhetoric-question": "R", exclamation: "E", imperative: "I", ellipsis: "L" };
  const parts = categories.map((category) => codeOf[category.type] + ":" + Math.round(category.ratio * 1000) / 10);
  const motif = motifs.length > 0 ? motifs[0].pattern : "-";
  return parts.join(" ") + " | len:" + lengths.avg + " subj:" + style.subjectivityIndex + " emo:" + emotion.dominant + " | motif:" + motif;
}
