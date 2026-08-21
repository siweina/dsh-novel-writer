/**
 * dsh-novel-writer — 句式模式分析引擎 (v1.6.0 合并版)
 *
 * 融合 v0.3.0（深度分析）与 v0.4.0（轻量节奏参考）两版引擎：
 *   - 九类句式：陈述 / 环境 / 心理 / 对话 / 疑问 / 反问 / 感叹 / 祈使 / 省略留白
 *   - 排列规律：句式转移、2/3 连句模板、段首段尾句式、按章节的压缩排列序列（跑长编码）
 *   - 风格特征：句长分布、短长句占比、对话/心理/环境密度、主观性指数、风格指纹
 *   - 主观情感：轻量情感词典（喜/怒/哀/惧/惊）+ 强度副词加权，输出情感曲线
 *   - 节奏建议：给模型的 guidance 文本（句式分布 + 高频组合 + 章节节奏序列）
 *   - 采样上限：maxSentences 保护超长文本（默认 20000 句）
 *
 * 零依赖、确定性规则，不调用任何外部服务。
 */

export const CATEGORY_LABELS = Object.freeze({
  statement: "陈述",
  environment: "环境",
  psychology: "心理",
  dialogue: "对话",
  question: "疑问",
  "rhetoric-question": "反问",
  exclamation: "感叹",
  imperative: "祈使",
  ellipsis: "省略留白"
}
);

/** 输出固定顺序。 */
export const CATEGORY_ORDER = Object.freeze([
  "statement", "environment", "psychology", "dialogue", "question",
  "rhetoric-question", "exclamation", "imperative", "ellipsis"
]);

/** 短码（压缩序列/指纹用）。 */
export const TYPE_CODE = Object.freeze({
  statement: "S", environment: "ENV", psychology: "PSY", dialogue: "DLG", question: "Q",
  "rhetoric-question": "RQ", exclamation: "EX", imperative: "IMP", ellipsis: "…"
});

const EMOTION_LABELS = Object.freeze({
  joy: "喜", anger: "怒", sorrow: "哀", fear: "惧", surprise: "惊", neutral: "中性"
});

/** 轻量中文情感词典（启发式，非完整情感分析）。 */
/**
 * v1.5.0 情感词分级：
 * - STRONG（强情绪词）：深层情感，不易被场景污染，真实基调参考（clean）
 * - WEAK（弱情绪词）：生理/爽感反应，R18/战斗/爽文场景高频，易污染（raw 中剔除出 clean）
 */
const STRONG_EMOTION_WORDS = Object.freeze({
  joy: ["幸福", "欣慰", "甜蜜", "温暖", "踏实", "欣慰", "欢喜", "欣喜", "快乐"],
  anger: ["愤怒", "暴怒", "怒火", "愤恨", "怨恨", "憎恶", "厌恶", "火冒三丈", "恼羞成怒", "咬牙切齿", "脸色铁青", "怒气"],
  sorrow: ["悲伤", "悲痛", "悲哀", "哀伤", "心碎", "绝望", "心酸", "辛酸", "凄凉", "黯然", "惆怅", "忧伤", "苦涩", "悲痛欲绝"],
  fear: ["恐惧", "毛骨悚然", "胆战心惊", "惶恐", "惊惶", "畏惧", "惊恐", "胆怯", "冷汗"],
  surprise: ["震惊", "目瞪口呆", "难以置信", "不可思议", "惊愕", "骇然", "震撼"]
});
const WEAK_EMOTION_WORDS = Object.freeze({
  joy: ["兴奋", "满足", "愉快", "痛快", "爽快", "爽", "笑眯眯", "笑容", "微笑", "笑", "哈哈", "乐", "欢", "喜", "高兴", "开心", "喜悦"],
  anger: ["生气", "恼火", "恼", "怒", "恨", "气愤", "气", "咬牙", "不满", "发火", "气冲冲"],
  sorrow: ["难过", "伤心", "痛苦", "哭泣", "哭", "泪", "眼泪", "流泪", "哽咽", "抽泣", "叹息", "叹气", "失落", "悲"],
  fear: ["害怕", "惊慌", "不安", "紧张", "担心", "发抖", "哆嗦", "心慌", "忐忑", "心悸", "心虚", "惊惶"],
  surprise: ["惊讶", "意外", "吃惊", "诧异", "愕然", "愣住", "傻眼", "呆住", "惊奇", "惊呆"]
});
const EMOTION_WORDS = Object.freeze({
  joy: [...STRONG_EMOTION_WORDS.joy, ...WEAK_EMOTION_WORDS.joy],
  anger: [...STRONG_EMOTION_WORDS.anger, ...WEAK_EMOTION_WORDS.anger],
  sorrow: [...STRONG_EMOTION_WORDS.sorrow, ...WEAK_EMOTION_WORDS.sorrow],
  fear: [...STRONG_EMOTION_WORDS.fear, ...WEAK_EMOTION_WORDS.fear],
  surprise: [...STRONG_EMOTION_WORDS.surprise, ...WEAK_EMOTION_WORDS.surprise]
});

/** v1.5.0 情绪污染源词表：检测到高密度时降低情感可信度并提示 AI 复核。 */
const EMOTION_POLLUTION = Object.freeze({
  r18: ["做爱", "性交", "交配", "高潮", "呻吟", "精液", "淫水", "鸡巴", "小穴", "肉棒", "插入", "抽插", "射精", "爱液", "淫荡", "口交", "手淫", "乳头", "阴茎", "阴道", "裸体", "色情", "情色", "发情", "春药", "催情"],
  battle: ["碾压", "打脸", "爆发", "激战", "秒杀", "轰", "爆炸", "斩杀", "狂暴", "暴击", "大招", "反杀", "降维打击"],
  horror: ["疯狂", "发疯", "癫狂", "血腥", "尸体", "恐怖", "鬼", "惨叫", "阴森", "诡异", "腐烂", "畸形", "触手"]
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

/** 反问强标记（与疑问区分）。 */
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

/** 环境描写标记词（天色/天气/景物类名词，来自 v0.4.0，v0.6.0 扩充）。 */
const ENV_MARKERS = /夜色|月光|晨光|暮色|夕阳|黄昏|清晨|深夜|夜空|天边|星光|灯火|细雨|微风|大雨|暴雨|风雪|薄雾|浓雾|云层|远山|山影|河面|湖水|街道|巷子|烛火|窗|雨声|风声|树影|落叶|残雪|霜|天色|晚风|夜风|晨曦|晚霞|晴空|雨滴|溪水|江水|海浪|沙漠|草原|森林|群山|雪地|庭院|檐下|廊下/;

/** 句尾结束符。 */
const TERMINATORS = "。！？…";

/** 引号对。 */
const QUOTE_PAIRS = [["“", "”"], ["「", "」"], ["『", "』"], ["‘", "’"], ["\"", "\""], ["'", "'"]];

/** 文本 → 段落块：空行分段；无空行时每行视为一段。过滤 Markdown 标题。 */
export function splitBlocks(text) {
  const normalized = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  // 段落分隔符 = 前后都有内容的"中间空行"；仅开头/结尾的空行不算分段。
  const hasBlank = lines.some((line, index) => line.trim() === "" && index > 0 && index < lines.length - 1);
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
  if (!/吧/.test(text) && !/[！!]$/.test(text)) return false;
  for (const verb of IMPERATIVE_HARD) {
    if (text.includes(verb)) return true;
  }
  return new RegExp("^(你|您|我们|咱们|大家)?(" + IMPERATIVE_START.join("|") + ")").test(text) && /吧/.test(text);
}

/**
 * 单句分类（优先级：对话 > 心理 > 反问 > 疑问 > 感叹 > 祈使 > 环境 > 省略 > 陈述）。
 * 引语优先：引号内的直接引语算对话；引号内含心理标记（内心独白）算心理。
 */
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
  if (ENV_MARKERS.test(text)) return { type: "environment", text, quoted: false };
  if (/…+$/.test(text)) return { type: "ellipsis", text, quoted: false };
  return { type: "statement", text, quoted: false };
}

/** 单字情感词的多字搭配排除（"叹气"不算"气"、"笑道"不算"笑"）。 */
const EMOTION_EXCLUDE = {
  joy: { "笑": ["笑道", "说笑", "玩笑", "搞笑", "笑话", "苦笑", "冷笑", "嘲笑", "嬉笑", "傻笑", "微笑", "笑死", "笑呵呵", "笑眯眯"] },
  anger: { "气": ["叹气", "运气", "客气", "一口气", "服气", "脾气", "争气", "节气", "淘气", "景气", "暖气", "口气", "名气", "勇气", "底气", "俗气", "风气", "香气", "水气", "湿气", "潮气", "和气", "生气勃勃"] },
  sorrow: { "悲": ["慈悲"], "哭": ["哭丧"] },
  fear: { "怕": ["哪怕", "只怕", "生怕"] },
  surprise: { "愣": ["愣住"] }
};

/** 情感词前紧邻的否定字（"不害怕"不计入恐惧）。 */
const EMOTION_NEGATORS = new Set(["不", "没", "无", "别", "莫", "未"]);

/** 情感词计数（v0.6.0：扫描式匹配 + 搭配排除 + 否定过滤 + 副词窗口加权）。 */
function emotionOf(text) {
  const scores = { joy: 0, anger: 0, sorrow: 0, fear: 0, surprise: 0 };
  const cleanScores = { joy: 0, anger: 0, sorrow: 0, fear: 0, surprise: 0 };
  const words = { joy: [], anger: [], sorrow: [], fear: [], surprise: [] };
  const hitWords = new Set();
  // v1.5.0：记录"该词是否属于强情绪词（clean）"
  const isStrong = new Set();
  for (const [emotionName, list] of Object.entries(STRONG_EMOTION_WORDS)) {
    for (const word of list) isStrong.add(emotionName + ":" + word);
  }
  for (const [emotion, list] of Object.entries(EMOTION_WORDS)) {
    for (const word of list) {
      let from = 0;
      while (from < text.length) {
        const idx = text.indexOf(word, from);
        if (idx === -1) break;
        // 单字词的搭配排除（如"叹气"中的"气"）
        const exclude = EMOTION_EXCLUDE[emotion]?.[word];
        if (exclude !== void 0) {
          const two = text.slice(Math.max(0, idx - 1), idx + 2);
          const prevTwo = text.slice(Math.max(0, idx - 1), idx + 1);
          const nextTwo = text.slice(idx, idx + 2);
          const prevFour = text.slice(Math.max(0, idx - 2), idx + 2);
          let excluded = false;
          for (const bad of exclude) {
            if (two.includes(bad) || prevTwo === bad || nextTwo === bad || prevFour.includes(bad)) {
              excluded = true;
              break;
            }
          }
          if (excluded) { from = idx + word.length; continue; }
        }
        // 否定过滤："不害怕"不计入
        const prevChar = idx > 0 ? text[idx - 1] : "";
        if (EMOTION_NEGATORS.has(prevChar)) { from = idx + word.length; continue; }
        // 副词窗口加权：词前 6 字符内出现的强/弱副词生效一次
        const window = text.slice(Math.max(0, idx - 6), idx);
        let weight = 1;
        for (const adverb of STRONG_ADVERBS) {
          if (window.includes(adverb)) { weight = Math.max(weight, 1.5); break; }
        }
        for (const adverb of MILD_ADVERBS) {
          if (window.includes(adverb)) { weight = Math.min(weight, 0.6); break; }
        }
        scores[emotion] += weight;
        if (isStrong.has(emotion + ":" + word)) cleanScores[emotion] += weight;
        if (!hitWords.has(word)) {
          hitWords.add(word);
          words[emotion].push(word);
        }
        from = idx + word.length;
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
  let cleanDominant = "neutral";
  let bestClean = 0;
  for (const emotion of ["joy", "anger", "sorrow", "fear", "surprise"]) {
    if (cleanScores[emotion] > bestClean) {
      bestClean = cleanScores[emotion];
      cleanDominant = emotion;
    }
  }
  // v2.5 修复：dutir_seven.json（大连理工 27,413 词）兜底——小词表未覆盖的情感词也计分
  // 性能安全：只用"文本中出现的相邻二字组"查表（O(句长)），不做 27k 词全表扫描
  try {
    const seenWords = new Set();
    for (const list of Object.values(words)) for (const w of list) seenWords.add(w);
    dutirEmotion(""); // 确保 dutirLookup 已构建（懒加载）
    const bigrams = text.match(/[\u4e00-\u9fa5]{2}/g) || [];
    for (const w of new Set(bigrams)) {
      if (seenWords.has(w)) continue;
      const emo = dutirLookup.get(w);
      if (!emo) continue;
      scores[emo] += 1;
      cleanScores[emo] += 1;
      words[emo].push(w);
      seenWords.add(w);
    }
    dominant = "neutral";
    let best = 0;
    for (const emotion of ["joy", "anger", "sorrow", "fear", "surprise"]) {
      if (scores[emotion] > best) { best = scores[emotion]; dominant = emotion; }
    }
  } catch { /* dutir 兜底失败不影响原结果 */ }
  return {
    scores,
    words,
    dominant,
    cleanScores,
    cleanDominant,
    total: Object.values(scores).reduce((a, b) => a + b, 0),
    cleanTotal: Object.values(cleanScores).reduce((a, b) => a + b, 0)
  };
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

/** 跑长编码压缩排列序列（来自 v0.4.0）：S×8 ENV×2 PSY×3 … */
export function compressSequence(codes, maxRuns = 48) {
  const runs = [];
  for (const code of codes) {
    const last = runs[runs.length - 1];
    if (last !== void 0 && last.code === code) last.n += 1;
    else runs.push({ code, n: 1 });
  }
  const parts = runs.slice(0, maxRuns).map((run) => run.code + "×" + run.n);
  if (runs.length > maxRuns) parts.push("…(共" + runs.length + "段)");
  return parts.join(" ");
}

/** 生成给模型的节奏建议文本（来自 v0.4.0 buildGuidance，适配九类）。 */
export function buildGuidance(ratios, topPatterns, chapterSequences) {
  const ratioText = CATEGORY_ORDER
    .filter((code) => (ratios[code] ?? 0) > 0)
    .map((code) => TYPE_CODE[code] + " " + Math.round((ratios[code] ?? 0) * 100) + "%")
    .join(" · ");
  const patternText = topPatterns.length > 0
    ? topPatterns.slice(0, 5).map((p) => p.pattern + " ×" + p.count).join("、")
    : "（样本过短，未形成高频组合）";
  const lines = [
    "句式分布：" + ratioText,
    "高频句式组合：" + patternText
  ];
  if (chapterSequences.length > 0) {
    lines.push("章节节奏（压缩序列，" + CATEGORY_ORDER.map((code) => TYPE_CODE[code] + "=" + CATEGORY_LABELS[code]).join(" ") + "）：");
    for (const item of chapterSequences.slice(0, 12)) lines.push("  " + item.chapter + ": " + item.sequence);
  }
  return lines.join("\n");
}

/**
 * v1.6.0 Valence 效价映射表（基于大连理工中文情感词汇本体库框架）：
 * 七维（乐/好/怒/哀/惧/恶/惊）× 强度五档（1/3/4/7/9 → ±0.1/0.3/0.5/0.7/0.9）。
 * 乐=正向，好=正向，怒/哀/惧/恶/惊=负向（惊=中性偏负）。纯规则查表，0 token。
 */
const VALENCE_WORDS = Object.freeze({
  "欣喜": 0.9, "狂喜": 0.9, "欢天喜地": 0.9, "雀跃": 0.7, "高兴": 0.7, "开心": 0.7, "快乐": 0.7,
  "喜悦": 0.7, "愉快": 0.5, "欢喜": 0.7, "兴奋": 0.7, "愉悦": 0.5, "欢快": 0.7, "乐": 0.5,
  "欢": 0.5, "喜": 0.5, "笑": 0.3, "微笑": 0.3, "笑容": 0.3, "笑眯眯": 0.3, "哈哈": 0.3,
  "欣慰": 0.5, "满足": 0.3, "痛快": 0.5, "爽快": 0.3, "甜": 0.5, "甜蜜": 0.5, "幸福": 0.9,
  "美满": 0.9, "温馨": 0.5, "温暖": 0.3, "踏实": 0.1, "平静": 0.1, "释然": 0.4, "解脱": 0.4,
  "喜欢": 0.7, "喜爱": 0.7, "欣赏": 0.5, "爱": 0.9, "疼爱": 0.7, "宠爱": 0.7, "仰慕": 0.7,
  "尊敬": 0.5, "敬仰": 0.7, "崇拜": 0.7, "心动": 0.5, "眷恋": 0.7, "依恋": 0.7, "思念": 0.3,
  "心疼": 0.3, "怜爱": 0.5, "温柔": 0.3, "珍惜": 0.5, "信赖": 0.5, "感恩": 0.7,
  "愤怒": -0.9, "暴怒": -0.9, "怒发冲冠": -0.9, "火冒三丈": -0.9, "恼羞成怒": -0.9,
  "生气": -0.7, "恼火": -0.7, "气愤": -0.7, "怒": -0.7, "恨": -0.9, "怨恨": -0.9, "憎恨": -0.9,
  "厌恶": -0.7, "憎恶": -0.9, "不满": -0.5, "恼": -0.5, "气": -0.3, "发火": -0.7, "咬牙": -0.3,
  "怒意": -0.7, "怒火": -0.9, "愤恨": -0.9, "恼羞": -0.7, "气冲冲": -0.7, "咬牙切齿": -0.5,
  "悲伤": -0.7, "悲痛": -0.9, "悲痛欲绝": -0.9, "悲哀": -0.7, "哀伤": -0.7, "难过": -0.5,
  "伤心": -0.7, "痛苦": -0.7, "心碎": -0.9, "绝望": -0.9, "哭泣": -0.7, "哭": -0.5, "泪": -0.3,
  "眼泪": -0.3, "流泪": -0.5, "哽咽": -0.5, "抽泣": -0.5, "叹息": -0.3, "叹气": -0.3,
  "惆怅": -0.5, "失落": -0.5, "忧伤": -0.5, "黯然": -0.5, "心酸": -0.7, "辛酸": -0.7,
  "悲": -0.7, "凄凉": -0.7, "苦涩": -0.7, "苦闷": -0.5, "沮丧": -0.7, "消沉": -0.7,
  "落寞": -0.5, "孤寂": -0.5, "郁闷": -0.3, "低落": -0.3, "压抑": -0.5, "心灰意冷": -0.9,
  "恐惧": -0.9, "害怕": -0.7, "惊慌": -0.7, "不安": -0.3, "紧张": -0.3, "担心": -0.3,
  "畏惧": -0.7, "惊恐": -0.9, "胆怯": -0.5, "发抖": -0.3, "哆嗦": -0.3, "心慌": -0.5,
  "毛骨悚然": -0.9, "冷汗": -0.5, "忐忑": -0.5, "惶恐": -0.9, "心悸": -0.5, "惊惶": -0.7,
  "胆战心惊": -0.9, "心虚": -0.5, "焦虑": -0.5, "恐慌": -0.9,
  "恶心": -0.7, "厌恶": -0.7, "鄙视": -0.7, "轻蔑": -0.5, "嫌弃": -0.7, "反感": -0.5,
  "憎恶": -0.9, "作呕": -0.7,
  "惊讶": -0.1, "震惊": -0.5, "意外": -0.1, "吃惊": -0.3, "诧异": -0.3, "愕然": -0.3,
  "愣住": -0.1, "目瞪口呆": -0.5, "难以置信": -0.5, "不可思议": -0.3, "惊愕": -0.5,
  "惊奇": 0.1, "震撼": -0.3, "傻眼": -0.3, "呆住": -0.1, "惊呆": -0.5, "骇然": -0.5
});

/**
 * v1.6.0 隐性情感载体映射表（意象/动作 → 效价 + 标签 + 脆弱标记）。
 * 参考中国古典诗歌意象体系 + 现代微动作意象，规则查表 0 token。
 */
const IMPLICIT_CARRIERS = Object.freeze([
  { words: ["雨", "阴雨", "细雨", "冷雨", "秋雨"], valence: -0.3, label: "压抑·萧瑟" },
  { words: ["黄昏", "暮色", "残阳", "夕阳西下"], valence: -0.3, label: "迟暮·萧瑟" },
  { words: ["枯枝", "落叶", "枯叶", "败叶"], valence: -0.3, label: "凋零·萧瑟" },
  { words: ["冷风", "寒风", "北风", "秋风"], valence: -0.3, label: "寒冷·孤寂" },
  { words: ["昏暗", "阴影", "灰暗", "幽暗"], valence: -0.3, label: "压抑" },
  { words: ["孤雁", "孤鸿", "寒鸦"], valence: -0.25, label: "孤独" },
  { words: ["残月", "冷月", "孤月"], valence: -0.25, label: "孤独·凄清" },
  { words: ["梧桐", "芭蕉"], valence: -0.25, label: "愁绪" },
  { words: ["寒蝉", "秋虫"], valence: -0.2, label: "凄切" },
  { words: ["荒芜", "废墟", "断壁", "残垣"], valence: -0.4, label: "荒凉·衰败" },
  { words: ["空荡", "空旷", "空落落"], valence: -0.3, label: "空虚" },
  { words: ["暖光", "暖阳", "炉火", "烛火", "灯火"], valence: 0.2, label: "短暂温暖", fragile: true },
  { words: ["茶烟", "炊烟", "轻烟"], valence: 0.2, label: "短暂温暖", fragile: true },
  { words: ["余晖", "黄昏的光"], valence: 0.15, label: "短暂温暖", fragile: true },
  { words: ["摩挲", "摩挲杯沿"], valence: -0.2, label: "焦虑·克制" },
  { words: ["攥紧衣角", "攥着衣角", "握紧衣角"], valence: -0.2, label: "焦虑·克制" },
  { words: ["咬唇", "咬住嘴唇", "咬着下唇"], valence: -0.2, label: "隐忍·克制" },
  { words: ["低垂眼帘", "垂下眼帘", "垂下眼"], valence: -0.2, label: "隐忍·欲言又止" },
  { words: ["沉默良久", "久久沉默"], valence: -0.2, label: "隐忍" },
  { words: ["指尖发白", "指节发白", "攥紧拳头"], valence: -0.3, label: "压抑·愤怒" },
  { words: ["颤抖的手", "手在抖"], valence: -0.3, label: "紧张·恐惧" },
  { words: ["转身", "转过身"], valence: -0.3, label: "疏离·决绝" },
  { words: ["走出", "推门而出", "大步离开"], valence: -0.3, label: "决绝" },
  { words: ["背影", "远去的背影"], valence: -0.3, label: "疏离·失落" },
  { words: ["回头", "回望"], valence: -0.2, label: "不舍·眷恋" },
  { words: ["轻笑", "苦笑", "扯了扯嘴角"], valence: -0.15, label: "无奈·强颜" },
  { words: ["摇头", "摇了摇头", "垂下头"], valence: -0.15, label: "无奈·妥协" },
  { words: ["垂手", "放下手", "手垂落"], valence: -0.15, label: "无力·放弃" }
]);

/**
 * v2.1.0 多方向意象表：同一载体在不同语境可表达不同情感（"变色龙词"）。
 * 每个词允许多个方向条目，各自带触发语境词（规则层裁决）：
 *  - 命中触发词 → 按该方向计分
 *  - 无触发词 → 交给语义层（与正/负原型句比相似度）
 *  - 语义层也不确定 → 双计分 + 歧义标记
 */
const AMBIGUOUS_CARRIERS = Object.freeze({
  "雨": [
    { valence: -0.3, label: "压抑·萧瑟", triggers: ["冷", "夜", "秋", "寒", "阴", "灰", "敲", "不停", "绵", "细", "孤"] },
    { valence: 0.2, label: "清新·复苏", triggers: ["晴", "彩虹", "洗净", "春", "润", "后", "停", "甘"] }
  ],
  "烛火": [
    { valence: -0.2, label: "诡异·不安", triggers: ["摇曳", "昏", "暗", "影", "鬼", "摇", "颤", "燃尽", "跳"] },
    { valence: 0.25, label: "温馨", triggers: ["暖", "炉", "家", "围", "饭", "柔", "亮"] }
  ],
  "火光": [
    { valence: -0.25, label: "灾难·恐惧", triggers: ["烧", "浓烟", "废墟", "惨叫", "逃", "夜", "红"] },
    { valence: 0.2, label: "希望·温暖", triggers: ["暖", "黎明", "亮", "驱散", "炉", "温"] }
  ],
  "夜": [
    { valence: -0.2, label: "孤独·恐惧", triggers: ["深", "黑", "静", "冷", "无眠", "怕", "漫长", "沉"] },
    { valence: 0.15, label: "安宁·静谧", triggers: ["星", "月", "静好", "温柔", "安"] }
  ],
  "风": [
    { valence: -0.15, label: "萧瑟·离别", triggers: ["冷", "寒", "秋", "吹散", "凛冽", "呜咽"] },
    { valence: 0.15, label: "清爽·自由", triggers: ["暖", "春", "清新", "拂", "轻", "晴"] }
  ],
  "海": [
    { valence: -0.3, label: "深邃·恐惧", triggers: ["黑", "沉", "浪", "吞", "潮", "深", "暗", "涌"] },
    { valence: 0.2, label: "开阔·浪漫", triggers: ["蓝", "晴", "暖", "浪花", "笑", "沙滩", "夕阳"] }
  ],
  "灯": [
    { valence: -0.15, label: "孤独·守望", triggers: ["孤", "昏", "暗", "残", "灭", "夜"] },
    { valence: 0.2, label: "温暖·归处", triggers: ["暖", "亮", "家", "等", "柔", "光"] }
  ],
  "影子": [
    { valence: -0.25, label: "不安·诡异", triggers: ["长", "暗", "摇晃", "鬼", "拖", "黑"] },
    { valence: 0.1, label: "陪伴", triggers: ["暖", "短", "依偎"] }
  ],
  "笑": [
    { valence: -0.15, label: "苦笑·强颜", triggers: ["苦", "勉", "僵", "假", "惨", "涩", "硬"] },
    { valence: 0.25, label: "欢乐", triggers: ["开怀", "灿烂", "暖", "甜", "大", "爽朗", "咯咯"] }
  ],
  "眼泪": [
    { valence: -0.3, label: "悲伤", triggers: ["落", "流", "止不住", "擦", "咸", "含", "忍"] },
    { valence: 0.15, label: "感动·释然", triggers: ["感动", "幸福", "喜极", "温暖", "笑"] }
  ],
  "沉默": [
    { valence: -0.2, label: "压抑·隔阂", triggers: ["久", "冷", "尴尬", "低头", "死寂", "不开口"] },
    { valence: 0.1, label: "默契·安宁", triggers: ["温柔", "懂", "默契", "安静", "并肩"] }
  ],
  "花开": [
    { valence: -0.1, label: "易逝·伤春", triggers: ["落", "谢", "春尽", "残"] },
    { valence: 0.25, label: "美好·希望", triggers: ["盛", "香", "春", "灿烂", "暖"] }
  ],
  "黄昏": [
    { valence: -0.25, label: "迟暮·萧瑟", triggers: ["残", "落", "暗", "孤", "冷", "尽"] },
    { valence: 0.15, label: "温柔·归家", triggers: ["暖", "金", "柔", "炊烟", "并肩"] }
  ],
  "奔跑": [
    { valence: -0.2, label: "逃离·慌乱", triggers: ["逃", "拼命", "慌", "追", "喘", "夜"] },
    { valence: 0.2, label: "自由·奔赴", triggers: ["向", "奔", "扑", "迎", "笑", "阳光"] }
  ]
});

/** v2.1.0：查找多方向载体命中（返回所有方向条目 + 上下文命中触发词）。 */
export function matchAmbiguousCarriers(text) {
  const hits = [];
  for (const [word, entries] of Object.entries(AMBIGUOUS_CARRIERS)) {
    let idx = 0;
    while ((idx = text.indexOf(word, idx)) !== -1) {
      // 上下文窗口：前后 30 字
      const ctx = text.slice(Math.max(0, idx - 30), idx + word.length + 30);
      const matched = entries.map((e) => {
        const trigger = e.triggers.find((t) => ctx.includes(t));
        return { ...e, triggerHit: trigger || null };
      });
      hits.push({ word, ctx, entries: matched });
      idx += word.length;
    }
  }
  return hits;
}

/** v1.6.0 隐性载体扫描：意象/动作 → 负向/正向占比 + top 载体 + 脆弱标记。 */
export function implicitEmotionScan(text, semResolver = null) {
  let negHits = 0, posHits = 0, fragileHits = 0;
  let ambHits = 0;
  const carrierCounts = new Map();
  const ambiguous = [];
  const see = (label, word, n, valence) => {
    if (valence < 0) negHits += n * -valence;
    else { posHits += n * valence; if (false) fragileHits += n; }
    carrierCounts.set(label + ":" + word, (carrierCounts.get(label + ":" + word) ?? 0) + n);
  };
  // ① 单方向表（原有）
  for (const carrier of IMPLICIT_CARRIERS) {
    for (const word of carrier.words) {
      const n = text.split(word).length - 1;
      if (n > 0) {
        see(carrier.label, word, n, carrier.valence);
        if (carrier.valence >= 0 && carrier.fragile) fragileHits += n;
      }
    }
  }
  // ② 多方向表（变色龙词）：规则触发 → 定方向；无触发 → 语义层；都不确定 → 双计分+歧义
  for (const [word, entries] of Object.entries(AMBIGUOUS_CARRIERS)) {
    let idx = 0;
    while ((idx = text.indexOf(word, idx)) !== -1) {
      const ctx = text.slice(Math.max(0, idx - 30), idx + word.length + 30);
      const triggerMatched = entries.filter((e) => e.triggers.some((t) => ctx.includes(t)));
      if (triggerMatched.length === 1) {
        const e = triggerMatched[0];
        see(e.label, word, 1, e.valence);
      } else if (triggerMatched.length > 1) {
        // 多个触发同时命中：双计分 + 歧义
        for (const e of triggerMatched) see(e.label, word, 1, e.valence * 0.5);
        ambHits += 1;
        ambiguous.push({ word, reason: "多触发冲突", ctx: ctx.trim().slice(0, 40) });
      } else if (semResolver) {
        // 无触发 → 语义层裁决（异步由调用方包装）
        const r = semResolver(ctx, entries);
        if (r && r.resolved) see(r.label, word, 1, r.valence);
        else {
          // 语义不确定 → 双计分 + 歧义标记
          for (const e of entries) see(e.label, word, 1, e.valence * 0.5);
          ambHits += 1;
          ambiguous.push({ word, reason: "语义不确定", ctx: ctx.trim().slice(0, 40) });
        }
      } else {
        // 无语义层可用 → 按词表首条目弱计分 + 歧义
        for (const e of entries.slice(0, 2)) see(e.label, word, 1, e.valence * 0.5);
        ambHits += 1;
        ambiguous.push({ word, reason: "未裁决", ctx: ctx.trim().slice(0, 40) });
      }
      idx += word.length;
    }
  }
  const total = negHits + posHits;
  const top = [...carrierCounts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, n]) => ({ carrier: k.split(":")[1], label: k.split(":")[0], count: n }));
  return {
    negative: total === 0 ? 0 : Math.round((negHits / total) * 100) / 100,
    positive: total === 0 ? 0 : Math.round((posHits / total) * 100) / 100,
    ambiguousRatio: total === 0 ? 0 : Math.round((ambHits / (total + ambHits)) * 100) / 100,
    fragile: fragileHits > 0,
    totalHits: negHits + posHits,
    ambiguous,
    topCarriers: top
  };
}

/**
 * v1.6.0 情感量化：Valence 滑动窗口时间序列 → 方差/斜率/矛盾指数。
 */
const EMOTION_CATS = ["joy", "anger", "sorrow", "fear", "surprise"];
const EMOTION_MAX_ENTROPY = Math.log(EMOTION_CATS.length);

/** v1.6.0 滑动窗口：每 100 字算平均效价 → 时间序列 + 正负词计数。 */
export function valenceSeries(text, winChars = 100) {
  const series = [];
  const windowPosNeg = [];
  const entries = Object.entries(VALENCE_WORDS).sort((x, y) => y[0].length - x[0].length);
  for (let start = 0; start < text.length; start += winChars) {
    const slice = text.slice(start, start + winChars);
    let sum = 0, n = 0, pos = 0, neg = 0;
    for (const [word, val] of entries) {
      let from = 0;
      while (from < slice.length) {
        const idx = slice.indexOf(word, from);
        if (idx === -1) break;
        sum += val; n += 1;
        if (val > 0) pos += 1; else if (val < 0) neg += 1;
        from = idx + word.length;
      }
    }
    series.push(n === 0 ? 0 : Math.round((sum / n) * 1000) / 1000);
    windowPosNeg.push({ pos, neg });
  }
  const posWords = windowPosNeg.reduce((s, w) => s + w.pos, 0);
  const negWords = windowPosNeg.reduce((s, w) => s + w.neg, 0);
  return { series, posWords, negWords, windowCount: series.length, windowPosNeg };
}

/** v1.6.0 三指标：方差 V + 相邻撕裂 V_adj + 斜率 Δ（最小二乘+鲁棒版）+ 矛盾指数 C。 */
export function valenceStats(text) {
  const { series, posWords, negWords } = valenceSeries(text);
  const n = series.length;
  if (n === 0) return { windows: 0 };
  const mean = series.reduce((x, y) => x + y, 0) / n;
  const variance = series.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  let adjSum = 0;
  for (let i = 1; i < n; i += 1) adjSum += Math.abs(series[i] - series[i - 1]);
  const adjVariance = n > 1 ? adjSum / (n - 1) : 0;
  const iMean = (n - 1) / 2;
  let num = 0, den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - iMean) * (series[i] - mean);
    den += (i - iMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const delta = slope * (n - 1);
  const third = Math.max(1, Math.floor(n / 3));
  const headMean = series.slice(0, third).reduce((x, y) => x + y, 0) / third;
  const tailMean = series.slice(-third).reduce((x, y) => x + y, 0) / third;
  const { windowPosNeg } = valenceSeries(text);
  const totalWords = posWords + negWords;
  const posRatio = totalWords === 0 ? 0 : posWords / totalWords;
  const negRatio = totalWords === 0 ? 0 : negWords / totalWords;
  // 坑1方案：矛盾指数按"窗口内原始词"算再平均（避免全书平均掩盖"同窗交织"vs"分段喜悲"）
  const windowConflicts = windowPosNeg
    .filter((w) => w.pos + w.neg > 0)
    .map((w) => 2 * Math.min(w.pos / (w.pos + w.neg), w.neg / (w.pos + w.neg)));
  const conflict = windowConflicts.length === 0 ? 0 : windowConflicts.reduce((x, y) => x + y, 0) / windowConflicts.length;
  return {
    windows: n,
    variance: Math.round(variance * 1000) / 1000,
    adjVariance: Math.round(adjVariance * 1000) / 1000,
    delta: Math.round(delta * 1000) / 1000,
    deltaRobust: Math.round((tailMean - headMean) * 1000) / 1000,
    conflict: Math.round(conflict * 1000) / 1000,
    posRatio: Math.round(posRatio * 1000) / 1000,
    negRatio: Math.round(negRatio * 1000) / 1000,
    meanValence: Math.round(mean * 1000) / 1000
  };
}

/** v1.6.0 显隐对比：显性均值 vs 隐性方向 → 表里不一。 */
export function explicitImplicitCompare(explicitMean, implicit) {
  if (!implicit || implicit.totalHits === 0) return { explicitImplicitConflict: false, explicitSign: "neutral", implicitSign: "neutral" };
  const explicitSign = explicitMean > 0.15 ? "positive" : explicitMean < -0.15 ? "negative" : "neutral";
  const implicitSign = implicit.negative >= 0.6 ? "negative" : implicit.positive >= 0.6 ? "positive" : "neutral";
  return {
    explicitImplicitConflict: explicitSign === "positive" && implicitSign === "negative",
    explicitSign,
    implicitSign
  };
}

/** v1.6.0 复合情感共现（规则）：同段多情感类别 → 高频矛盾对。 */
export function compositeEmotionPairs(blocks) {
  const pairCounts = new Map();
  for (const block of blocks) {
    const present = new Set();
    for (const sentence of block) {
      const e = sentence.emotion;
      for (const k of EMOTION_CATS) if ((e.cleanScores?.[k] ?? 0) > 0) present.add(k);
    }
    const list = [...present];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const key = [list[i], list[j]].sort().join("+");
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const labels = {
    "joy+sorrow": "悲喜交加", "joy+anger": "又爱又恨/喜怒交织", "sorrow+anger": "哀怒交加/愤懑",
    "fear+sorrow": "悲伤恐惧", "joy+fear": "惊喜交加", "anger+fear": "惊惧愤怒", "sorrow+surprise": "愕然悲伤"
  };
  return [...pairCounts.entries()].map(([pair, count]) => ({ pair, count, label: labels[pair] ?? "复合情感" }))
    .sort((x, y) => y.count - x.count).slice(0, 5);
}

/** v1.6.0 单章分布（五维 clean）→ 熵/多样性/主次。 */
export function chapterEmotionStats(counts) {
  const total = EMOTION_CATS.reduce((s, k) => s + (counts[k] ?? 0), 0);
  if (total === 0) return null;
  const p = EMOTION_CATS.map((k) => (counts[k] ?? 0) / total);
  const entropy = -p.filter((x) => x > 0).reduce((s, x) => s + x * Math.log(x), 0);
  const diversity = p.filter((x) => x >= 0.15).length;
  const sorted = EMOTION_CATS.map((k, i) => ({ emotion: k, ratio: p[i] })).sort((x, y) => y.ratio - x.ratio);
  return {
    entropy: Math.round(entropy * 1000) / 1000,
    diversity,
    dominant: sorted[0].emotion,
    dominantRatio: Math.round(sorted[0].ratio * 1000) / 1000,
    secondary: sorted[1].emotion,
    secondaryRatio: Math.round(sorted[1].ratio * 1000) / 1000
  };
}

/** v1.6.0 全书聚合：复杂度评分 0-1（熵归一化0.5 + 多样性0.25 + 主次冲突0.25）+ 章间漂移。 */
export function emotionComplexity(perChapter) {
  const stats = perChapter.map((c) => ({ chapter: c.chapter, ...(chapterEmotionStats(c.counts) ?? {}) })).filter((s) => s.entropy !== void 0);
  if (stats.length === 0) {
    // 无情感词命中：不复杂（low），恒有值供模型读取
    return {
      score: 0, level: "low", entropy: 0, maxEntropy: Math.round(EMOTION_MAX_ENTROPY * 1000) / 1000,
      diversity: 0, dominant: "neutral", dominantRatio: 0, secondary: "neutral", secondaryRatio: 0,
      conflict: "", conflictStrength: 0,
      chapterDrift: { meanEntropy: 0, entropyVariance: 0, swinging: false }
    };
  }
  const totalCounts = {};
  for (const c of perChapter) for (const k of EMOTION_CATS) totalCounts[k] = (totalCounts[k] ?? 0) + (c.counts[k] ?? 0);
  const global = chapterEmotionStats(totalCounts);
  const entropies = stats.map((s) => s.entropy);
  const meanEntropy = entropies.reduce((x, y) => x + y, 0) / entropies.length;
  const entropyVariance = entropies.reduce((s, e) => s + (e - meanEntropy) ** 2, 0) / entropies.length;
  const meanDiversity = stats.reduce((s, x) => s + x.diversity, 0) / stats.length;
  const entropyNorm = global ? global.entropy / EMOTION_MAX_ENTROPY : 0;
  const conflictStrength = global ? global.secondaryRatio / Math.max(global.dominantRatio, 0.0001) : 0;
  const score = Math.min(1, Math.max(0, entropyNorm * 0.5 + (meanDiversity / 5) * 0.25 + conflictStrength * 0.25));
  const level = score >= 0.6 ? "high" : score >= 0.4 ? "medium" : "low";
  return {
    score: Math.round(score * 100) / 100,
    level,
    entropy: global ? global.entropy : 0,
    maxEntropy: Math.round(EMOTION_MAX_ENTROPY * 1000) / 1000,
    diversity: global ? global.diversity : 0,
    dominant: global?.dominant ?? "neutral",
    dominantRatio: global?.dominantRatio ?? 0,
    secondary: global?.secondary ?? "neutral",
    secondaryRatio: global?.secondaryRatio ?? 0,
    conflict: global ? global.dominant + "↔" + global.secondary : "",
    conflictStrength: Math.round(conflictStrength * 100) / 100,
    chapterDrift: {
      meanEntropy: Math.round(meanEntropy * 1000) / 1000,
      entropyVariance: Math.round(entropyVariance * 10000) / 10000,
      swinging: entropyVariance > 0.03
    }
  };
}

/**
 * v1.6.0 情感量化入口：三指标 + 显隐对比 + 复杂度 + 复合共现（纯规则 0 token）。
 */
export function emotionalQuantification(text, perChapter, blocks, semResolver = null) {
  const stats = valenceStats(text);
  const implicit = implicitEmotionScan(text, semResolver);
  const meanValence = stats.meanValence ?? 0;
  // perChapter 为空（单章/无分章输入）时，用当前文本自身 clean 计数聚合，保证 complexity 恒有值
  if (!Array.isArray(perChapter) || perChapter.length === 0) {
    const counts = { joy: 0, anger: 0, sorrow: 0, fear: 0, surprise: 0 };
    for (const block of blocks) {
      for (const sentence of block) {
        const cs = sentence.emotion.cleanScores ?? {};
        for (const k of EMOTION_CATS) counts[k] += cs[k] ?? 0;
      }
    }
    perChapter = [{ chapter: "全书", counts }];
  }
  return {
    stats,
    implicit,
    compare: explicitImplicitCompare(meanValence, implicit),
    complexity: emotionComplexity(perChapter),
    composites: compositeEmotionPairs(blocks)
  };
}

/**
 * 全书/单章句式模式分析主入口（v1.6.0 合并版）。
 * @param text 正文文本。
 * @param options { top: 句式模板条数（默认 8）, maxSentences: 采样上限（默认 20000）, chapterTexts: [{chapter, text}] 可选分章输入 }
 * @returns 结构化分析结果（与 novel_sentence_analysis 输出 schema 一致）。
 */
export function analyzeText(text, options = {}) {
  const top = Number.isInteger(options.top) ? options.top : 8;
  const maxSentences = Number.isInteger(options.maxSentences) ? options.maxSentences : 20000;
  const curveSegments = Number.isInteger(options.curveSegments) ? Math.min(Math.max(options.curveSegments, 1), 50) : 20;
  const blocks = splitBlocks(text);
  const sentences = [];
  const blockMeta = [];
  for (let b = 0; b < blocks.length; b += 1) {
    if (sentences.length >= maxSentences) break;
    const parts = splitSentences(blocks[b]);
    const meta = { sentences: [], opening: void 0, closing: void 0 };
    for (const part of parts) {
      if (sentences.length >= maxSentences) break;
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
  const cleanEmotionCounts = { joy: 0, anger: 0, sorrow: 0, fear: 0, surprise: 0 };
  const emotionWordCounts = new Map();
  for (const sentence of sentences) {
    for (const [emotion, count] of Object.entries(sentence.emotion.scores)) {
      emotionCounts[emotion] += count;
    }
    for (const [emotion, count] of Object.entries(sentence.emotion.cleanScores)) {
      cleanEmotionCounts[emotion] += count;
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
  // v1.5.0：clean（仅强情绪词）主导
  let cleanDominantEmotion = "neutral";
  let bestCleanEmotion = 0;
  for (const emotion of ["joy", "anger", "sorrow", "fear", "surprise"]) {
    if (cleanEmotionCounts[emotion] > bestCleanEmotion) {
      bestCleanEmotion = cleanEmotionCounts[emotion];
      cleanDominantEmotion = emotion;
    }
  }
  const emotionDensity = totalChars === 0 ? 0 : round((totalEmotion / totalChars) * 1000, 2);
  // v1.5.0：情绪污染源检测（R18/战斗/恐怖高密度 → 情感结论降级）
  const pollution = { r18: 0, battle: 0, horror: 0 };
  for (const [kind, words] of Object.entries(EMOTION_POLLUTION)) {
    for (const word of words) pollution[kind] += text.split(word).length - 1;
  }
  const pollutionPer1000 = (n) => round((n / Math.max(totalChars, 1)) * 1000, 2);
  const r18Density = pollutionPer1000(pollution.r18);
  const battleDensity = pollutionPer1000(pollution.battle);
  const horrorDensity = pollutionPer1000(pollution.horror);
  const polluted = r18Density >= 1.5 || battleDensity >= 3 || horrorDensity >= 3;
  const pollutedBy = [];
  if (r18Density >= 1.5) pollutedBy.push("高密度 R18/生理描写（每千字 " + r18Density + "）");
  if (battleDensity >= 3) pollutedBy.push("高密度战斗/爽文描写（每千字 " + battleDensity + "）");
  if (horrorDensity >= 3) pollutedBy.push("高密度恐怖/疯狂描写（每千字 " + horrorDensity + "）");
  const confidence = polluted ? "low" : (cleanDominantEmotion !== "neutral" && cleanDominantEmotion !== dominantEmotion ? "medium" : "high");
  const caveat = polluted
    ? "⚠️ 检测到" + pollutedBy.join("、") + "，dominant（" + EMOTION_LABELS[dominantEmotion] + "）可能来自生理/爽感反应词而非真实情感。请勿直接采信，须 novel_read 抽查 2-3 段原文复核真实情感基调后再下结论。"
    : (cleanDominantEmotion !== dominantEmotion
      ? "ℹ️ 剔除易污染的情绪词后，主导情感为「" + EMOTION_LABELS[cleanDominantEmotion] + "」（raw 为「" + EMOTION_LABELS[dominantEmotion] + "」），差异来自场景性用词，请结合原文判断。"
      : "");
  const emotion = {
    dominant: dominantEmotion,
    cleanDominant: cleanDominantEmotion,
    confidence,
    caveat,
    aiAction: polluted ? "novel_read 抽查 2-3 段原文，复核真实情感基调后给出结论（勿直接采信 dominant）。" : "",
    pollution: { r18: pollution.r18, battle: pollution.battle, horror: pollution.horror, r18Per1000: r18Density, battlePer1000: battleDensity, horrorPer1000: horrorDensity },
    scores: ["joy", "anger", "sorrow", "fear", "surprise"].map((emotionName) => ({
      emotion: emotionName,
      label: EMOTION_LABELS[emotionName],
      count: round(emotionCounts[emotionName], 2),
      words: [...new Set(EMOTION_WORDS[emotionName])].filter((word) => emotionWordCounts.has(word)).slice(0, 10)
    })),
    cleanScores: ["joy", "anger", "sorrow", "fear", "surprise"].map((emotionName) => ({
      emotion: emotionName,
      label: EMOTION_LABELS[emotionName],
      count: round(cleanEmotionCounts[emotionName], 2)
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
    curve: emotionCurve(blockMeta, curveSegments),
    // v1.6.0：情感量化（Valence 三指标 + 显隐对比 + 复杂度 + 复合共现）
    quantification: emotionalQuantification(text, [], blockMeta.map((m) => m.sentences).filter((s) => s.length > 0), options.semResolver || null)
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
  const environmentRatio = totalSentences === 0 ? 0 : counts.environment / totalSentences;
  const questionRatio = totalSentences === 0 ? 0 : (counts.question + counts["rhetoric-question"]) / totalSentences;
  const style = {
    dialogueRatio: round(dialogueRatio, 4),
    psychologyRatio: round(psychologyRatio, 4),
    environmentRatio: round(environmentRatio, 4),
    questionRatio: round(questionRatio, 4),
    exclamationRatio: round(exclaimRatio, 4),
    shortSentenceRatio: lengths.shortRatio,
    longSentenceRatio: lengths.longRatio,
    subjectivityIndex,
    emotionDensity,
    avgSentenceLength: avgLength,
    firstPersonDensity: round(firstPersonDensity, 2)
  };

  // 分章节奏序列（可选：调用方传入各章文本）
  const chapterPatterns = [];
  if (Array.isArray(options.chapterTexts)) {
    for (const item of options.chapterTexts) {
      const chapterCodes = splitSentences(String(item.text)).slice(0, maxSentences).map((s) => classifySentence(s).type);
      chapterPatterns.push({
        chapter: String(item.chapter),
        sequence: compressSequence(chapterCodes.map((type) => TYPE_CODE[type]))
      });
    }
  }

  const ratios = Object.fromEntries(CATEGORY_ORDER.map((type) => [type, totalSentences === 0 ? 0 : round(counts[type] / totalSentences, 4)]));
  const guidance = buildGuidance(ratios, motifs, chapterPatterns);

  const fingerprint = buildFingerprint(categories, lengths, style, emotion, motifs);
  const density = densityOf(text);

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
    chapterPatterns,
    guidance,
    density,
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
  const parts = categories.map((category) => TYPE_CODE[category.type] + ":" + Math.round(category.ratio * 1000) / 10);
  const motif = motifs.length > 0 ? motifs[0].pattern : "-";
  return parts.join(" ") + " | len:" + lengths.avg + " subj:" + style.subjectivityIndex + " emo:" + emotion.dominant + " | motif:" + motif;
}

/** 两篇文本的风格指纹相似度（0~1）：句式分布 + 句长 + 主观性的余弦相似度。 */
export function fingerprintSimilarity(a, b) {
  const vectorOf = (r) => {
    const v = [];
    const catMap = new Map((r.categories ?? []).map((x) => [x.type, x.ratio ?? 0]));
    for (const type of CATEGORY_ORDER) v.push(catMap.get(type) ?? 0);
    const len = r.lengths?.avg ?? 0;
    v.push(Math.min(len, 100) / 100);
    v.push(r.lengths?.shortRatio ?? 0);
    v.push(r.lengths?.longRatio ?? 0);
    v.push((r.style?.subjectivityIndex ?? 0) / 100);
    return v;
  };
  const va = vectorOf(a);
  const vb = vectorOf(b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < va.length; i += 1) {
    dot += va[i] * vb[i];
    na += va[i] * va[i];
    nb += vb[i] * vb[i];
  }
  if (na === 0 || nb === 0) return 0;
  return Math.round((dot / (Math.sqrt(na) * Math.sqrt(nb))) * 1000) / 1000;
}

/** 风格偏差清单：b 相对 a 的显著差异（阈值可调）。 */
export function styleDiffs(a, b, threshold = 0.06) {
  const diffs = [];
  const catA = new Map((a.categories ?? []).map((x) => [x.type, x.ratio]));
  const catB = new Map((b.categories ?? []).map((x) => [x.type, x.ratio]));
  for (const type of CATEGORY_ORDER) {
    const d = (catB.get(type) ?? 0) - (catA.get(type) ?? 0);
    if (Math.abs(d) >= threshold) {
      diffs.push({
        dimension: CATEGORY_LABELS[type] + "占比",
        diff: Math.round(d * 1000) / 10,
        note: d > 0 ? "偏高" : "偏低"
      });
    }
  }
  if (b.lengths && a.lengths) {
    const lenDiff = b.lengths.avg - a.lengths.avg;
    if (Math.abs(lenDiff) >= 5) diffs.push({ dimension: "平均句长", diff: Math.round(lenDiff * 10) / 10, note: lenDiff > 0 ? "偏长" : "偏短" });
    const shortDiff = (b.lengths.shortRatio ?? 0) - (a.lengths.shortRatio ?? 0);
    if (Math.abs(shortDiff) >= 0.08) diffs.push({ dimension: "短句占比", diff: Math.round(shortDiff * 1000) / 10, note: shortDiff > 0 ? "偏高" : "偏低" });
  }
  if (b.emotion && a.emotion && b.emotion.dominant !== a.emotion.dominant) {
    diffs.push({ dimension: "主导情绪", diff: 0, note: "由「" + (a.emotion.dominant ?? "?") + "」变为「" + (b.emotion.dominant ?? "?") + "」" });
  }
  return diffs;
}

/** v0.8.0 细节密度词表：动作动词/物件名词/感官词。 */
const DENSITY_ACTION_VERBS = /摸|拿|推|拉|走|跑|蹲|站|坐|转|伸|握|点|掀|翻|跪|爬|钻|抱|搂|抬|放|挂|摘|系|披|踩|迈|跨|扑|撞|躲|闪|看|盯|瞥|望|听|闻|尝|咬|喝|吃|敲|拍|捏|揉|擦|吹|按|拨|拧|捡|拾|丢|抛|接|递|塞|掏|捞|舀|倒|浇|洗|叠|铺|盖|关|开|掩|合/;
const DENSITY_OBJECT_WORDS = /油灯|灯|床|门|窗|桌|椅|凳|杯|碗|碟|盘|筷|勺|剑|刀|枪|书|本|纸|笔|衣|裙|帽|鞋|镜|烛台|蜡烛|铁罐|罐|盒|箱|马车|车|墙|柱|帘|毯|被|枕|簪|铃|钟|画|架|梯|绳|袋|篮|桶|壶|锅|铲|柴|炭|火|灰/;
const DENSITY_SENSE = {
  visual: /看|见|映入|光|亮|暗|色|影|闪|照|映|目光|眼神|脸|面|状|样/,
  auditory: /听|声|音|响|钟|脚步|敲|喊|叫|低语|呢喃|咕哝|咚|砰|咔/,
  tactile: /凉|热|疼|痛|滑|糙|冷|暖|烫|冰|湿|干|硬|软|麻|痒/,
  olfactory: /香|臭|味|气|腥|甜|苦|酸/,
  temperature: /热|烫|凉|冷|暖|温/
};

/** 细节密度统计（v0.8.0）：动作链/物件名词/感官词，按千字归一。 */
export function densityOf(text) {
  const sentences = splitSentences(text);
  const totalChars = text.replace(/\s/g, "").length;
  let actionVerbs = 0;
  let actionChainSentences = 0;
  let objectHits = 0;
  const sense = { visual: 0, auditory: 0, tactile: 0, olfactory: 0, temperature: 0 };
  const actionChains = [];
  for (const sentence of sentences) {
    let verbs = 0;
    for (const m of sentence.matchAll(new RegExp(DENSITY_ACTION_VERBS.source, "g"))) verbs += 1;
    if (verbs >= 2) {
      actionChainSentences += 1;
      if (actionChains.length < 3) actionChains.push(sentence.slice(0, 40));
    }
    actionVerbs += verbs;
    for (const m of sentence.matchAll(new RegExp(DENSITY_OBJECT_WORDS.source, "g"))) objectHits += 1;
    for (const [kind, re] of Object.entries(DENSITY_SENSE)) {
      for (const m of sentence.matchAll(new RegExp(re.source, "g"))) sense[kind] += 1;
    }
  }
  const per1000 = (n) => Math.round((n / Math.max(totalChars, 1)) * 1000 * 10) / 10;
  const ratio = sentences.length === 0 ? 0 : Math.round((actionChainSentences / sentences.length) * 1000) / 10;
  return {
    actionVerbsPer1000: per1000(actionVerbs),
    actionChainRatio: ratio,
    actionChainExamples: actionChains,
    objectNounsPer1000: per1000(objectHits),
    sensePer1000: per1000(Object.values(sense).reduce((x, y) => x + y, 0)),
    sense: { ...sense }
  };
}


// v2.5 修复：接入 lib/lexicons/dutir_seven.json（大连理工七类情感词表 27,413 词）
// 懒加载 + 内存缓存；七类 → 五情感映射，供 sentimentCounts 扩展计数（词表未覆盖的词也能计分）
import { createRequire } from "node:module";
const __req = createRequire(import.meta.url);
let DUTIR = null;
function loadDutir() {
  if (DUTIR) return DUTIR;
  try {
    const p = __req.resolve("./lexicons/dutir_seven.json");
    DUTIR = JSON.parse(__req("node:fs").readFileSync(p, "utf8"));
  } catch {
    DUTIR = {};
  }
  return DUTIR;
}
const DUTIR_TO_EMOTION = { 乐: "joy", 好: "joy", 怒: "anger", 哀: "sorrow", 惧: "fear", 恶: "sorrow", 惊: "surprise" };
const dutirLookup = new Map();
function dutirEmotion(word) {
  if (dutirLookup.size === 0) {
    const dutir = loadDutir();
    for (const [cat, words] of Object.entries(dutir)) {
      const emo = DUTIR_TO_EMOTION[cat];
      if (!emo) continue;
      for (const w of words) if (typeof w === "string" && w.length >= 2) dutirLookup.set(w, emo);
    }
  }
  return dutirLookup.get(word);
}
export function dutirEmotionOf(word) { return dutirEmotion(word); }
