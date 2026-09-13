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
 *
 * v4.3.0 —— 关于本模块的导出面（回应审计提出的"11 个零消费者导出"）：
 * 下面这些导出**有意保留**为该模块的公共 API，不属于死代码：`splitSentences`、`compressSequence`、
 * `buildGuidance`、`implicitEmotionScan`、`explicitImplicitCompare`、`compositeEmotionPairs`、
 * `chapterEmotionStats`、`emotionComplexity`、`emotionalQuantification`、`densityOf`、`TYPE_CODE`。
 * 它们是纯函数（无副作用、无宿主依赖），当前在包内只被 analysis.js 自身与 test/pattern-test.mjs 之外
 * 的调用链间接使用；保留导出是为了让 MCP 侧、未来的独立分析工具或使用方脚本能在不改本模块的前提下复用。
 * 若确实要收缩公开面，请在**下一个大版本**统一处理，并同步 README 的 API 说明。
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
  // v4.0.0 修正：删除重复的"欣慰"（与去重注释矛盾；直接遍历本表时会被双计）
  joy: ["幸福", "欣慰", "甜蜜", "温暖", "踏实", "欢喜", "欣喜", "快乐"],
  anger: ["愤怒", "暴怒", "怒火", "愤恨", "怨恨", "憎恶", "厌恶", "火冒三丈", "恼羞成怒", "咬牙切齿", "脸色铁青", "怒气"],
  sorrow: ["悲伤", "悲痛", "悲哀", "哀伤", "心碎", "绝望", "心酸", "辛酸", "凄凉", "黯然", "惆怅", "忧伤", "苦涩", "悲痛欲绝"],
  fear: ["恐惧", "毛骨悚然", "胆战心惊", "惶恐", "惊惶", "畏惧", "惊恐", "胆怯", "冷汗"],
  surprise: ["震惊", "目瞪口呆", "难以置信", "不可思议", "惊愕", "骇然", "震撼"]
});
const WEAK_EMOTION_WORDS = Object.freeze({
  joy: ["兴奋", "满足", "愉快", "痛快", "爽快", "笑眯眯", "笑容", "微笑", "哈哈", "高兴", "开心", "喜悦"],
  anger: ["生气", "恼火", "气愤", "咬牙", "不满", "发火", "气冲冲"],
  sorrow: ["难过", "伤心", "痛苦", "哭泣", "眼泪", "流泪", "哽咽", "抽泣", "叹息", "叹气", "失落", ],
  fear: ["害怕", "惊慌", "不安", "紧张", "担心", "发抖", "哆嗦", "心慌", "忐忑", "心悸", "心虚", "惊惶"],
  surprise: ["惊讶", "意外", "吃惊", "诧异", "愕然", "愣住", "傻眼", "呆住", "惊奇", "惊呆"]
});
// v3.5.0 M1：情感词表构建去重（欣慰/惊惶等同表重复——双计残留）
const EMOTION_WORDS = Object.freeze({
  joy: [...new Set([...STRONG_EMOTION_WORDS.joy, ...WEAK_EMOTION_WORDS.joy])],
  anger: [...new Set([...STRONG_EMOTION_WORDS.anger, ...WEAK_EMOTION_WORDS.anger])],
  sorrow: [...new Set([...STRONG_EMOTION_WORDS.sorrow, ...WEAK_EMOTION_WORDS.sorrow])],
  fear: [...new Set([...STRONG_EMOTION_WORDS.fear, ...WEAK_EMOTION_WORDS.fear])],
  surprise: [...new Set([...STRONG_EMOTION_WORDS.surprise, ...WEAK_EMOTION_WORDS.surprise])]
});
// v4.0.0 性能：强词 Set 提升到模块级（旧版每句 emotionOf 重建约 50 项 Set）
const STRONG_WORD_KEYS = new Set();
for (const [emotionName, list] of Object.entries(STRONG_EMOTION_WORDS)) {
  for (const word of list) STRONG_WORD_KEYS.add(emotionName + ":" + word);
}

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
  // v4.0.0 修正：删除"哪里"分支——它是最常见的真疑问词，"你去了哪里？"被误判反问
  /哪(能|敢|会|曾|配|有)/,
  /怎(么)?(能|敢|会|肯|可能|可以|知道)/,
  // v4.3.0 修正（P1-7）：收紧"谁+情态"分支——旧版 /谁(说|知道|会|能|肯|曾|料|想到)/ 把
  // 真疑问"谁会来参加明天的会议？"判成反问。现只认固定反问格式（谁知道/谁说的/谁能想到/谁曾想…）。
  /谁知道|谁说的|谁(能|会)(想到|料到|知道)|谁曾(想|料)|谁料|谁肯/,
  /凭什么|干嘛|干吗|至于吗|不是吗|何至于/,
  /不是[^。！？]{0,10}吗/
];

/** 祈使句硬词（v3.9.1 #7）：句首出现即祈使（感叹只留给无祈使词的 !/！ 句）。 */
const IMPERATIVE_HARD = ["不准", "不许", "禁止", "闭嘴", "住手", "住口", "站住", "停下", "小心", "当心", "注意", "赶紧", "立刻", "马上", "给我", "跟我", "起来", "坐下", "躺下", "放下", "松开", "放开", "请", "快", "别", "勿", "莫", "滚"];
/** 祈使句动词（句首、需带命令语气：吧/标点/句尾——"走了几步"这类陈述不算）。 */
const IMPERATIVE_VERBS = ["去", "来", "走"];

/** 环境描写标记词（天色/天气/景物类名词，来自 v0.4.0，v0.6.0 扩充）。 */
const ENV_MARKERS = /夜色|月光|晨光|暮色|夕阳|黄昏|清晨|深夜|夜空|天边|星光|灯火|细雨|微风|大雨|暴雨|风雪|薄雾|浓雾|云层|远山|山影|河面|湖水|街道|巷子|烛火|窗|雨声|风声|树影|落叶|残雪|霜|天色|晚风|夜风|晨曦|晚霞|晴空|雨滴|溪水|江水|海浪|沙漠|草原|森林|群山|雪地|庭院|檐下|廊下/;

/** 句尾结束符。 */
// v4.3.0：补半角 !? 并导出，供 style-metrics.js 共用同一常量。
// 旧版只有全角 。！？…，而分类器的 isQuestion/isExclamation 与 style-metrics 的切句正则都认半角，
// 于是同一句 "你疯了?我没疯!他走了。" analysis 切成 1 句（类型还归错）、style-metrics 切成 3 句，
// 两模块的句数/句式分布/复杂度无法交叉核对。
export const TERMINATORS = "。！？…!?";

/** 引号对。 */
const QUOTE_PAIRS = [["“", "”"], ["「", "」"], ["『", "』"], ["‘", "’"], ["\"", "\""], ["'", "'"]];

/** 文本 → 段落块：空行分段；无空行时每行视为一段。过滤 Markdown 标题与分割线。 */
export function splitBlocks(text) {
  const normalized = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  // 段落分隔符 = 前后都有内容的"中间空行"；仅开头/结尾的空行不算分段。
  // v3.9.1 #4：hasBlank 必须同时要求空行两侧都是非空行——文末 \n\n 不再把全文并成一块
  const hasBlank = lines.some((line, index) =>
    line.trim() === "" && index > 0 && index < lines.length - 1 &&
    lines[index - 1].trim() !== "" && lines[index + 1].trim() !== ""
  );
  const blocks = [];
  let current = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // v3.5.0 #51：Markdown 标题（# 开头）不是句子——跳过（含空行场景）
    if (/^#{1,6}\s/.test(trimmed)) continue;
    // v4.3.0：分割线（--- / *** / ___）过滤提升到两个分支之前。
    // 旧版只在"无空行"分支过滤，带空行的文本会把 "---" 当成一个独立段落
    // （splitBlocks("第一段。\n\n---\n\n第二段。") 得 3 段，多出一个 "---" 段，
    //  进而污染段落数/段首段尾句式统计）。
    if (/^[-_*=]{3,}$/.test(trimmed)) continue;
    if (trimmed === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n").trim());
        current = [];
      }
      continue;
    }
    if (!hasBlank) {
      blocks.push(trimmed);
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
    // v3.5.0 #50b：无标点换行也是句边界（逐行排版正确分句，整篇不再算 1 句）
    if (ch === "\n" || ch === "\r") {
      const lineSentence = buffer.trim();
      if (lineSentence !== "") sentences.push(lineSentence);
      buffer = "";
      continue;
    }
    buffer += ch;
    if (TERMINATORS.includes(ch)) {
      while (i + 1 < block.length && TERMINATORS.includes(block[i + 1])) {
        buffer += block[i + 1];
        i += 1;
      }
      let quotes = 0;
      // v4.0.0 修正：去掉恒真的 TERMINATORS 判断（引号字符与"。！？…"无交集）
      while (quotes < 2 && i + 1 < block.length && "”」』’\"'".includes(block[i + 1])) {
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
  // v4.0.0 修正：无句末标点时，"什么/这么/那么/多么/要么"以"么"结尾是陈述（"他不知道该说什么"），不再判疑问
  // v4.3.0 修正（P1-7）："吗/嘛"仍是强疑问标记，但"呢"收紧——旧版裸 /呢$/ 把逐行排版里
  // 无标点的陈述句"他还在家呢"判成疑问。现要求"呢"句含疑问词，或极短省略式问句（"他呢"）。
  if (/(吗|嘛)$/.test(text)) return true;
  if (/呢$/.test(text)) {
    if (/(谁|什么|哪|怎么|多少|几|何处|为何|是不是|有没有|要不要|能不能|会不会)/.test(text)) return true;
    return text.length <= 4;
  }
  if (/么$/.test(text) && !/(什么|这么|那么|多么|要么)$/.test(text)) return true;
  if (/(是不是|好不好|行不行|要不要|能不能|会不会|有没有|对不对|愿不愿意)/.test(text) && /(吧|吗)$/.test(text)) return true;
  return false;
}

function isExclamation(text) {
  // v4.0.0 修正：删除恒不可达的 /！？$/ 分支（以？结尾的句子已被 isQuestion 先截获）
  if (/[！!]$/.test(text)) return true;
  // v4.3.0 修正（P1-7）：太…了 收紧——旧版 /太[^。！？]{0,8}了/ 允许跨逗号，
  // 把"他太累了，就先睡了。"判成感叹。现要求 太…了 落在句末（可带句末标点）且不跨标点，
  // 并排除"…了 + 就/便/才/于是"这种转折陈述（"他太累了就先睡了。"）。
  if (/太[^。！？，,；;、]{0,8}了[。！？…!?]*$/.test(text) && !/了(就|便|才|于是|然后|接着)/.test(text)) return true;
  if (/真(是)?[^。！？]{0,10}(啊|呀|！)/.test(text)) return true;
  if (/多么|何等|好不/.test(text)) return true;
  if (/(啊|呀|哇|哎哟|唉|哦|呵|哈哈|嘿嘿|嘻嘻|天哪|天啊|天呐)[。！？…]*$/.test(text)) return true;
  return false;
}

/**
 * v4.3.0：单字硬祈使词（请/快/别/勿/莫/滚）的**句首同形反例**——命中即不算祈使。
 * 这些是名词/形容词，不是命令："别人走了。""快乐的日子。""请柬收到了。""滚烫的水。""莫大的荣幸。"
 */
const SINGLE_HARD_FALSE_POSITIVES = new Set([
  "别人", "别处", "别的", "别样", "别墅", "别致", "别扭", "别具", "别名", "别号", "别离",
  "快乐", "快步", "快递", "快车", "快餐", "快照", "快感", "快艇", "快门", "快板", "快活", "快捷", "快讯", "快报",
  "请柬", "请帖",
  "滚烫", "滚动", "滚滚", "滚球", "滚轮",
  "莫大", "莫非", "莫不", "莫如", "莫过"
]);

/**
 * v3.9.1 #7：硬祈使判定——句首硬祈使词（可带呼语前缀），或句首单字动词 去/来/走
 * 且紧跟命令语气（吧/句末标点/句尾），或含"吧"的非疑问句。
 * 疑问/反问在前置阶段已返回，这里不重复处理。
 */
function isImperative(text) {
  // v4.0.0 修正：硬词加词尾边界 + 单字硬词要求命令语气，杜绝"别人/马上/快乐/注意/放下/滚烫/莫大/请柬"词首同形误判
  const caller = "^(?:你|您|我们|咱们|大家|喂)?"; // v4.3.0：改非捕获组——否则 [1] 是呼语而非硬词，黑名单复核会取错位置
  const hardMulti = IMPERATIVE_HARD.filter(function (w) { return w.length >= 2; });
  const hardSingle = IMPERATIVE_HARD.filter(function (w) { return w.length === 1; });
  if (hardMulti.length > 0) {
    const multiRe = new RegExp(caller + "(" + hardMulti.sort(function (a, b) { return b.length - a.length; }).join("|") + ")(?![\u4e00-\u9fa5])");
    if (multiRe.test(text)) return true;
    // v4.3.0 修正（P1-2）：v4.0.0 给硬词加的"后随不得为汉字"硬边界过严——"硬词 + 宾语/补语"的祈使句
    // （放下刀！/小心点！/赶紧走！/给我滚！）整类失配，最终被 isExclamation 的 /[！!]$/ 收走（句式分布失真）。
    // 现补一条受限的宽松规则：硬词 + 0~3 字宾语/补语 + 命令语气收尾。三类同形误判仍被排除：
    //   ① 句首同形副词「马上/立刻」（"马上就到了。" 不算祈使）；
    //   ② 体标记紧接（"注意到他了。" 的 到/过/着/了 → 视为动词短语而非命令）；
    //   ③ 名词同形「酒吧/网吧」等仍由下方裸"吧"分支拦截。
    const relaxWords = hardMulti
      .filter(function (w) { return w !== "马上" && w !== "立刻"; })
      .sort(function (a, b) { return b.length - a.length; });
    const relaxRe = new RegExp(caller + "(" + relaxWords.join("|") + ")(?![到过着了])[\u4e00-\u9fa5]{0,3}(?:[。！？!?…]|吧|$)");
    if (relaxRe.test(text)) return true;
  }
  if (hardSingle.length > 0) {
    const singleRe = new RegExp(caller + "(" + hardSingle.join("|") + ")[\u4e00-\u9fa5]{0,2}(?:[。！？!?…]|吧|$)");
    const singleHit = singleRe.exec(text);
    // v4.3.0 修正：单字硬词的句首同形名词/形容词（别人/快乐/请柬/滚烫/莫大…）此前仍被判祈使——
    // v4.0.0 只堵住了"酒吧/网吧"一类（下方裸"吧"分支），漏了单字分支。命中后用 2 字黑名单复核。
    if (singleHit) {
      const at = singleHit[0].indexOf(singleHit[1]);
      if (!SINGLE_HARD_FALSE_POSITIVES.has(text.slice(at, at + 2))) return true;
    }
  }
  const verbRe = new RegExp(caller + "(" + IMPERATIVE_VERBS.join("|") + ")(吧|[。！？!?…]|$)");
  if (verbRe.test(text)) return true;
  // "太好了吧！"这类感叹式"吧"句不算祈使（太…了吧 → 感叹留给 isExclamation）
  if (/太[^。！？]{0,12}了吧/.test(text)) return false;
  // v4.0.0 修正：裸 /吧/ → 只认句末语气词；并排除 酒吧/网吧/吧台/吧嗒/吧唧 等名词
  if (/(酒吧|网吧|吧台|吧嗒|吧唧|吧友)/.test(text)) return false;
  return /吧[，。！？!?…]*$/.test(text);
}

/**
 * 单句分类（优先级：对话 > 心理 > 反问 > 疑问 > 祈使 > 感叹 > 环境 > 省略 > 陈述）。
 * v3.9.1 #7：祈使先于感叹判定——含祈使词的 !/！ 句是祈使，感叹只留给无祈使词的 !/！ 句。
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
  if (isImperative(text)) return { type: "imperative", text, quoted: false };
  if (isExclamation(text)) return { type: "exclamation", text, quoted: false };
  if (ENV_MARKERS.test(text)) return { type: "environment", text, quoted: false };
  if (/…+$/.test(text)) return { type: "ellipsis", text, quoted: false };
  return { type: "statement", text, quoted: false };
}

/**
 * v3.9.1 #6：EMOTION_EXCLUDE（单字情感词的多字搭配排除）已删除——STRONG/WEAK 情感词表
 * 与 DUTIR 兜底词表都不含单字词（叹气/笑道里的"气/笑"从来不会被查），该排除分支是
 * 永不触发的死代码；行为与现状一致（"叹气"不产生 anger 等）。
 *
 * v3.9.1 #5：情感否定统一判定。命中情感词时检查其前 1-3 字：
 * - 单字否定：不/没/无/别/莫/未
 * - 双/三字否定前缀：不要/不用/不必/不再/不是/并非/绝非/毫不/丝毫不/从不/从未/没有/没啥/未曾/无法/难以
 */
// v4.0.0 修正：补"不太/不很/不怎么/不算/算不上/谈不上"——旧表缺这些前缀，"不太高兴"被计成正面情绪 0.6
const NEGATION_PREFIXES = ["不要", "不用", "不必", "不再", "不是", "并非", "绝非", "毫不", "丝毫不", "从不", "从未", "没有", "没啥", "未曾", "无法", "难以", "不太", "不很", "不怎么", "不算", "算不上", "谈不上"];
const NEGATION_SINGLE = new Set(["不", "没", "无", "别", "莫", "未"]);
/** v4.0.0 修正：这些字是"别"的构词语素前字（特别/别人/个别/分别/告别…），此时"别"不是否定词 */
// v4.3.0 修正（P1-1）：补 人/处/家/样/致/扭/具/名/墅/送/话/惜/永/诀/小——
// 它们是"别X"（别人/别处/别家/别样/别致/别扭/别具/别名/别墅/别送/别话/别惜）
// 与"X别"（永别/诀别/小别）的搭配字，此处"别"是词素而非否定词。
// 触发场景：上述词直接后接情感词时（"人别开心"这类字面构造）旧版整词丢分。
const BIE_NON_NEGATION_PREFIX = new Set([
  "特", "个", "分", "差", "告", "判", "识", "辨", "离", "级", "性", "类", "区", "派", "辞", "阔", "作", "待", "辈", "隔", "吻",
  "人", "处", "家", "样", "致", "扭", "具", "名", "墅", "送", "话", "惜", "永", "诀", "小"
]);

/** text[idx] 起的情感词命中是否被紧邻否定语否定。 */
function negatedAt(text, idx) {
  if (idx <= 0 || idx >= text.length) return false;
  if (NEGATION_SINGLE.has(text[idx - 1])) {
    // v4.0.0 修正："特别高兴/特别害怕"里的"别"是构词语素，不能当否定（旧版整词丢分）
    if (text[idx - 1] === "别" && idx >= 2 && BIE_NON_NEGATION_PREFIX.has(text[idx - 2])) return false;
    return true;
  }
  if (idx >= 2 && NEGATION_PREFIXES.includes(text.slice(idx - 2, idx))) return true;
  if (idx >= 3 && NEGATION_PREFIXES.includes(text.slice(idx - 3, idx))) return true;
  return false;
}

/**
 * v4.0.0 修正：副词窗口权重——强副词优先，弱副词仅在无强副词时生效。
 * 旧版先置 1.5 再 Math.min(0.6)，"非常有点开心"里的"有点"会覆盖"非常"。
 * v4.3.0 修正（P1-1）：窗口改为**当前小句内**（遇标点即截断），且单字副词（太/略/挺）
 * 必须紧邻情感词。旧版用 6 字窗口 + includes 子串匹配，把词内同形字当成副词：
 * 实测"老太太高兴。"→joy 1.5（老太太）、"策略让他高兴。"→0.6（策略）、
 * "太阳高照她很高兴。"→1.5（太阳）、"省略号"→0.6、"挺拔"→0.6。
 * 行为变化：副词加权只在同小句内生效，跨标点的副词不再加权（情感强度可能下降）；
 * 同一本书新旧报告的情感曲线强度不可直接比较。
 */
const ADVERB_BREAK_RE = /[，。！？；：、…—,.!?;:（）()「」『』“”\s]/;
const SINGLE_ADVERB_FALSE_POSITIVES = new Set([
  "太阳", "老太", "太太", "太子", "太爷", "太后", "太监", "太牢", "太学",
  "策略", "侵略", "省略", "大略", "粗略", "谋略",
  "挺拔", "挺括", "挺直", "坚挺"
]);
function adverbWeight(text, idx) {
  // 窗口下界：最近一个标点之后（当前小句起点），再往前最多 6 字
  let start = Math.max(0, idx - 6);
  for (let i = idx - 1; i >= start; i -= 1) {
    if (ADVERB_BREAK_RE.test(text[i])) { start = i + 1; break; }
  }
  const window = text.slice(start, idx);
  const prevChar = idx > 0 ? text[idx - 1] : "";
  for (const adverb of STRONG_ADVERBS) {
    if (adverb.length === 1) {
      // 单字强副词（太）：必须紧邻情感词，且左邻 2 字不是同形非副词搭配
      if (prevChar !== adverb) continue;
      if (SINGLE_ADVERB_FALSE_POSITIVES.has(text.slice(Math.max(0, idx - 2), idx))) continue;
      return 1.5;
    }
    if (window.includes(adverb)) return 1.5;
  }
  for (const adverb of MILD_ADVERBS) {
    if (adverb.length === 1) {
      if (prevChar !== adverb) continue;
      if (SINGLE_ADVERB_FALSE_POSITIVES.has(text.slice(Math.max(0, idx - 2), idx))) continue;
      return 0.6;
    }
    if (window.includes(adverb)) return 0.6;
  }
  return 1;
}

/**
 * v4.3.0：最长匹配 + 区间消费的通用扫描器（emotionOf 与 cleanScoresOf 共用同一份实现）。
 * 先收集词表全部出现，按「词长降序 → 表内情绪序 → 表内词序 → 起点」排序后消费区间，
 * 落在已消费区间内的短词不再产生命中——彻底消除「悲痛 ⊂ 悲痛欲绝」这类嵌套双计。
 */
function scanEmotionHits(text, table) {
  const emotionOrder = new Map(Object.keys(table).map((name, index) => [name, index]));
  const occurrences = [];
  for (const [emotion, list] of Object.entries(table)) {
    for (let li = 0; li < list.length; li += 1) {
      const word = list[li];
      let from = 0;
      while (from <= text.length - word.length) {
        const idx = text.indexOf(word, from);
        if (idx === -1) break;
        occurrences.push({ word, emotion, idx, len: word.length, emoIdx: emotionOrder.get(emotion), li });
        from = idx + word.length;
      }
    }
  }
  occurrences.sort((a, b) => b.len - a.len || a.emoIdx - b.emoIdx || a.li - b.li || a.idx - b.idx);
  const consumed = new Uint8Array(text.length);
  const hits = [];
  for (const occ of occurrences) {
    let free = true;
    for (let p = occ.idx; p < occ.idx + occ.len; p += 1) {
      if (consumed[p] === 1) { free = false; break; }
    }
    if (!free) continue;
    for (let p = occ.idx; p < occ.idx + occ.len; p += 1) consumed[p] = 1;
    hits.push(occ);
  }
  return hits;
}

/**
 * v4.0.0：单段/单章 clean 情感计数（chapterDrift 按章聚合用）。
 * 口径与 emotionOf 的 cleanScores 一致：只计强词表命中 + 否定过滤 + 副词加权。
 * v4.3.0 修正：旧版用朴素 indexOf 逐个词扫描、没有区间消费，会把「悲痛欲绝」里的「悲痛」
 * 再计一次（sorrow 2 而非 1），导致 complexity.dominant 与报告主导情感互相矛盾
 * （实测 "悲痛欲绝，他却只觉得愤怒。"：句级 anger，complexity 却给 sorrow）。
 * 现改为复用 scanEmotionHits——与 emotionOf 逐步同源，两处口径不会再漂移。
 */
function cleanScoresOf(text) {
  const counts = { joy: 0, anger: 0, sorrow: 0, fear: 0, surprise: 0 };
  for (const occ of scanEmotionHits(text, EMOTION_WORDS)) {
    if (!STRONG_WORD_KEYS.has(occ.emotion + ":" + occ.word)) continue;
    if (negatedAt(text, occ.idx)) continue;
    counts[occ.emotion] += adverbWeight(text, occ.idx);
  }
  return counts;
}

/** 情感词计数（v0.6.0：扫描式匹配 + 否定过滤 + 副词窗口加权）。 */
function emotionOf(text) {
  const scores = { joy: 0, anger: 0, sorrow: 0, fear: 0, surprise: 0 };
  const cleanScores = { joy: 0, anger: 0, sorrow: 0, fear: 0, surprise: 0 };
  const words = { joy: [], anger: [], sorrow: [], fear: [], surprise: [] };
  const hitWords = new Set();
  // v4.3.0（P0-1）：把「区间消费后的命中列表」随返回值带出（hitList），供 analyzeText 的
  // topWords 直接累加——旧版 topWords 拿 words（去重词表）回原文用 indexOf 重扫，
  // 于是"悲痛欲绝"里嵌的"悲痛"被再计一次：实测 "他悲痛欲绝，悲痛得说不出话。"
  // scores.sorrow=2 但 topWords 给出 悲痛:2 + 悲痛欲绝:1 = 3，与 scores 打架。
  const hitList = [];
  // v4.0.0 修正：词表嵌套双计（悲痛 ⊂ 悲痛欲绝、咬牙 ⊂ 咬牙切齿）——改为「最长匹配 + 区间消费」，
  // 与 valenceSeries / implicitEmotionScan 同一套口径：先收集全部出现，按词长降序消费区间，
  // 落在已消费区间内的短词不再计分；否定过滤 / 副词加权仍在命中起点判定（语义不变）。
  // v4.3.0：该算法抽到 scanEmotionHits 并与 cleanScoresOf 共用，消除两处口径漂移（见 P0 修复）。
  const hits = scanEmotionHits(text, EMOTION_WORDS);
  for (const occ of hits) {
    // v3.9.1 #5：否定过滤（共享 negatedAt）——"不要害怕/不再担心/丝毫不慌"不计该次
    if (negatedAt(text, occ.idx)) continue;
    // v4.0.0：副词窗口加权改走 adverbWeight（强优先，弱不覆盖强）
    const weight = adverbWeight(text, occ.idx);
    scores[occ.emotion] += weight;
    const strong = STRONG_WORD_KEYS.has(occ.emotion + ":" + occ.word);
    if (strong) cleanScores[occ.emotion] += weight;
    if (!hitWords.has(occ.word)) {
      hitWords.add(occ.word);
      words[occ.emotion].push(occ.word);
    }
    hitList.push({ word: occ.word, emotion: occ.emotion, weight, strong });
  }
  // v2.5 修复：dutir_seven.json（大连理工 27,413 词）兜底——小词表未覆盖的情感词也计分
  // 性能安全：只查"文本中出现的 2-8 字片段"（O(句长×7)），不做 27k 词全表扫描
  try {
    const seenWords = new Set();
    for (const list of Object.values(words)) for (const w of list) seenWords.add(w);
    dutirEmotion(""); // 确保 dutirLookup 已构建（懒加载）
    // v4.0.0 修正：旧版只查相邻二字组，词表里 3 字及以上条目（约 63%）永不命中；
    // 改为 4/3/2 字最长优先扫描 + 区间消费（长词命中后其子串不再计分），命中处逐次做否定过滤
    // v4.3.0 修正（P1-5）：上限由写死的 4 提到 DUTIR_MAX_WORD_LEN(8)——词表里 853 条 ≥5 字条目
    // （久旱逢甘雨/一步一个脚印/打开天窗说亮话…）此前永不命中。内层循环最多 7 次切片，
    // 实测 2000 字文本 dutir 兜底耗时由 ~1.1ms 升至 ~2.6ms（见 fixA-perf.mjs），可接受。
    const dutirConsumed = new Uint8Array(text.length);
    for (let bi = 0; bi < text.length; bi += 1) {
      if (dutirConsumed[bi] === 1) continue;
      let hitWord = "", hitEmo = null, hitLen = 0;
      for (let len = Math.min(DUTIR_MAX_WORD_LEN, text.length - bi); len >= 2; len -= 1) {
        const w = text.slice(bi, bi + len);
        if (!/^[\u4e00-\u9fa5]+$/.test(w)) continue;
        // 主词表（或本轮）已计过 → 消费该区间，避免"悲痛欲绝"之外再计"悲痛"
        if (seenWords.has(w)) { hitLen = len; break; }
        const emo = dutirLookup.get(w);
        if (emo) { hitWord = w; hitEmo = emo; hitLen = len; break; }
      }
      if (hitLen === 0) continue;
      for (let p = bi; p < bi + hitLen; p += 1) dutirConsumed[p] = 1;
      if (hitEmo === null) continue;
      if (negatedAt(text, bi)) continue;
      // v3.7.0 高5：DUTIR 27k 词无强弱分级（呵呵/傻乐等口语弱词）——只进 raw，不进 clean
      scores[hitEmo] += 1;
      words[hitEmo].push(hitWord);
      seenWords.add(hitWord);
      hitList.push({ word: hitWord, emotion: hitEmo, weight: 1, strong: false });
    }
  } catch { /* dutir 兜底失败不影响原结果 */ }
  // v4.3.0（P1-6）：删除两轮「主导情感」死计算——全仓库 grep 确认句级
  // emotion.dominant / cleanDominant / total / cleanTotal 零读者（详见报告第三节 grep 证据），
  // 且其中第二轮是在 dutir 兜底之后重算的纯浪费（每句多 5 次比较）。顶层主导情感由
  // analyzeText 用 emotionCounts/cleanEmotionCounts 统一判定（emotion.dominant/cleanDominant）。
  return { scores, words, cleanScores, hitList };
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  const out = Math.round(value * factor) / factor;
  return out === 0 ? 0 : out; // v4.0.0：消除 -0（宿主 lossless JSON 校验会拒绝 -0）
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
  "喜悦": 0.7, "愉快": 0.5, "欢喜": 0.7, "兴奋": 0.7, "愉悦": 0.5, "欢快": 0.7, "微笑": 0.3, "笑容": 0.3, "笑眯眯": 0.3, "哈哈": 0.3,
  "欣慰": 0.5, "满足": 0.3, "痛快": 0.5, "爽快": 0.3, "甜蜜": 0.5, "幸福": 0.9,
  "美满": 0.9, "温馨": 0.5, "温暖": 0.3, "踏实": 0.1, "平静": 0.1, "释然": 0.4, "解脱": 0.4,
  "喜欢": 0.7, "喜爱": 0.7, "欣赏": 0.5, "疼爱": 0.7, "宠爱": 0.7, "仰慕": 0.7,
  "尊敬": 0.5, "敬仰": 0.7, "崇拜": 0.7, "心动": 0.5, "眷恋": 0.7, "依恋": 0.7, "思念": 0.3,
  "心疼": 0.3, "怜爱": 0.5, "温柔": 0.3, "珍惜": 0.5, "信赖": 0.5, "感恩": 0.7,
  "愤怒": -0.9, "暴怒": -0.9, "怒发冲冠": -0.9, "火冒三丈": -0.9, "恼羞成怒": -0.9,
  "生气": -0.7, "恼火": -0.7, "气愤": -0.7, "怨恨": -0.9, "憎恨": -0.9,
  "厌恶": -0.7, "憎恶": -0.9, "不满": -0.5, "发火": -0.7, "咬牙": -0.3,
  "怒意": -0.7, "怒火": -0.9, "愤恨": -0.9, "恼羞": -0.7, "气冲冲": -0.7, "咬牙切齿": -0.5,
  "悲伤": -0.7, "悲痛": -0.9, "悲痛欲绝": -0.9, "悲哀": -0.7, "哀伤": -0.7, "难过": -0.5,
  "伤心": -0.7, "痛苦": -0.7, "心碎": -0.9, "绝望": -0.9, "哭泣": -0.7, "眼泪": -0.3, "流泪": -0.5, "哽咽": -0.5, "抽泣": -0.5, "叹息": -0.3, "叹气": -0.3,
  "惆怅": -0.5, "失落": -0.5, "忧伤": -0.5, "黯然": -0.5, "心酸": -0.7, "辛酸": -0.7,
  "凄凉": -0.7, "苦涩": -0.7, "苦闷": -0.5, "沮丧": -0.7, "消沉": -0.7,
  "落寞": -0.5, "孤寂": -0.5, "郁闷": -0.3, "低落": -0.3, "压抑": -0.5, "心灰意冷": -0.9,
  "恐惧": -0.9, "害怕": -0.7, "惊慌": -0.7, "不安": -0.3, "紧张": -0.3, "担心": -0.3,
  "畏惧": -0.7, "惊恐": -0.9, "胆怯": -0.5, "发抖": -0.3, "哆嗦": -0.3, "心慌": -0.5,
  "毛骨悚然": -0.9, "冷汗": -0.5, "忐忑": -0.5, "惶恐": -0.9, "心悸": -0.5, "惊惶": -0.7,
  "胆战心惊": -0.9, "心虚": -0.5, "焦虑": -0.5, "恐慌": -0.9,
  "恶心": -0.7,  "鄙视": -0.7, "轻蔑": -0.5, "嫌弃": -0.7, "反感": -0.5,
   "作呕": -0.7,
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
    // v4.0.0 修正：fragile 并入多方向条目（旧版只在单方向表，"烛火"因是多方向键被跳过，fragile 永久失效）
    { valence: 0.25, label: "温馨", triggers: ["暖", "炉", "家", "围", "饭", "柔", "亮"], fragile: true }
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

/**
 * v1.6.0 隐性载体扫描：意象/动作 → 负向/正向占比 + top 载体 + 脆弱标记。
 * v4.0.0 重写要点：
 *  - ①+② 合并为一次「最长优先 + 区间消费」扫描：旧版只排除与多方向表键同名的词，
 *    含键长词（细雨⊃雨、远去的背影⊃背影）与表内互为子串的项被双计；
 *  - 触发词裁决改为最长优先消费（"不停"命中后"停"不再算、"春尽"命中后"春"不再算），
 *    不再把本可单向裁决的语境判成「多触发冲突」；
 *  - 口径统一为「命中次数」：negative/positive/ambiguousRatio 的分母不再把加权效价和与次数相加
 *    （旧版 totalHits 名为次数实为加权和，会稀释歧义率）；
 *  - 删除 semResolver 死分支（index.js 从不传该参数，真实语义裁决走 resolveAmbiguousCarriers 后处理）。
 */
export function implicitEmotionScan(text) {
  const src = String(text ?? "");
  let negCount = 0, posCount = 0, ambCount = 0, fragileHits = 0;
  const carrierCounts = new Map();
  const ambiguous = [];
  // v4.3.0（P1-4）：删去 negWeight/posWeight 累加（唯一消费者 weightedTotal 已删除，
  // 且它是"加权效价和"与"命中次数"混用的历史遗留字段，全仓库零读取）。
  const see = (label, word, valence) => {
    if (valence < 0) negCount += 1;
    else posCount += 1;
    carrierCounts.set(label + ":" + word, (carrierCounts.get(label + ":" + word) ?? 0) + 1);
  };
  const ambWords = new Set(Object.keys(AMBIGUOUS_CARRIERS));
  // 收集全部载体出现（单方向表 + 多方向表），统一做最长优先消费
  const occurrences = [];
  const collect = (word, single) => {
    let from = 0;
    while (from <= src.length - word.length) {
      const idx = src.indexOf(word, from);
      if (idx === -1) break;
      occurrences.push({ word, idx, end: idx + word.length, single });
      from = idx + word.length;
    }
  };
  for (const carrier of IMPLICIT_CARRIERS) {
    for (const word of carrier.words) {
      if (ambWords.has(word)) continue; // 多方向词统一在下方按触发词裁决
      collect(word, carrier);
    }
  }
  for (const word of ambWords) collect(word, null);
  occurrences.sort((a, b) => b.word.length - a.word.length || a.idx - b.idx);
  const consumed = new Uint8Array(src.length);
  for (const occ of occurrences) {
    let free = true;
    for (let p = occ.idx; p < occ.end; p += 1) {
      if (consumed[p] === 1) { free = false; break; }
    }
    if (!free) continue;
    for (let p = occ.idx; p < occ.end; p += 1) consumed[p] = 1;
    if (occ.single) {
      see(occ.single.label, occ.word, occ.single.valence);
      if (occ.single.valence >= 0 && occ.single.fragile) fragileHits += 1;
      continue;
    }
    // 多方向表（变色龙词）：触发词最长优先裁决 → 定方向；无触发 → 交语义层/标歧义
    const entries = AMBIGUOUS_CARRIERS[occ.word];
    const ctx = src.slice(Math.max(0, occ.idx - 30), occ.end + 30);
    const triggerSpans = [];
    for (let ei = 0; ei < entries.length; ei += 1) {
      for (const trigger of entries[ei].triggers) {
        let from = 0;
        while (from <= ctx.length - trigger.length) {
          const ti = ctx.indexOf(trigger, from);
          if (ti === -1) break;
          triggerSpans.push({ ei, len: trigger.length, start: ti, end: ti + trigger.length });
          from = ti + 1;
        }
      }
    }
    triggerSpans.sort((a, b) => b.len - a.len || a.start - b.start);
    const takenSpans = [];
    const matched = new Set();
    for (const span of triggerSpans) {
      let overlapped = false;
      for (const taken of takenSpans) {
        if (span.start < taken.end && span.end > taken.start) { overlapped = true; break; }
      }
      if (overlapped) continue;
      takenSpans.push(span);
      matched.add(span.ei);
    }
    if (matched.size === 1) {
      const e = entries[[...matched][0]];
      see(e.label, occ.word, e.valence);
      if (e.valence > 0 && e.fragile) fragileHits += 1;
    } else if (matched.size > 1) {
      ambCount += 1;
      ambiguous.push({ word: occ.word, reason: "多触发冲突", ctx: ctx.trim().slice(0, 40) });
    } else {
      ambCount += 1;
      ambiguous.push({ word: occ.word, reason: "未裁决", ctx: ctx.trim().slice(0, 40) });
    }
  }
  const total = negCount + posCount;
  const totalAll = total + ambCount;
  const top = [...carrierCounts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, n]) => ({ carrier: k.split(":")[1], label: k.split(":")[0], count: n }));
  // v4.3.0 修正（P1-4）：三个比率统一到**同一分母 totalAll（已裁决 + 歧义）**。
  // 旧版 negative/positive 用两分分母（neg+pos）、ambiguousRatio 用三分分母（neg+pos+amb），
  // 同一份数据能渲染出"负向 100% / 歧义 50%"这种自相矛盾的组合（实测"雨打芭蕉。"：
  // neg=1 amb=1 → negative=1、ambiguousRatio=0.5，三项之和 1.5）。
  // 现 negative=negCount/totalAll、positive=posCount/totalAll、ambiguousRatio=ambCount/totalAll，
  // 三项之和恒 ≤1（无命中时为 0）。
  // 行为变化：negative/positive 数值下降（分母变大），0.6 之类的绝对阈值含义随之变化——
  // 下游 explicitImplicitCompare 的方向判定阈值（analysis.js 内，本次同步调整见该函数注释）
  // 与可能存在的 core.js/index.js/vibe.js 阈值消费方需一并复核（见报告「需父代理裁决」）。
  // 同一本书新旧报告不可直接比较。
  return {
    negative: totalAll === 0 ? 0 : Math.round((negCount / totalAll) * 100) / 100,
    positive: totalAll === 0 ? 0 : Math.round((posCount / totalAll) * 100) / 100,
    ambiguousRatio: totalAll === 0 ? 0 : Math.round((ambCount / totalAll) * 100) / 100,
    fragile: fragileHits > 0,
    totalHits: total,
    // v4.0.0：negHits/posHits/ambHits 统一为命中次数（旧版是加权效价和，与 ambHits 次数混用）
    negHits: negCount,
    posHits: posCount,
    ambHits: ambCount,
    // v4.3.0：三分口径的公共分母，供调用方自行复算比率
    totalAllHits: totalAll,
    ambiguous,
    topCarriers: top
  };
}

/**
 * v1.6.0 情感量化：Valence 滑动窗口时间序列 → 方差/斜率/矛盾指数。
 */
const EMOTION_CATS = ["joy", "anger", "sorrow", "fear", "surprise"];
const EMOTION_MAX_ENTROPY = Math.log(EMOTION_CATS.length);

/** v4.3.0（P1-3）：delta / deltaRobust 共用的采样基标识（全窗口等距序列），供展示层区分口径。 */
const DELTA_BASIS = "seriesFull";

/**
 * v1.6.0 滑动窗口：每 100 字算平均效价 → 时间序列 + 正负词计数。
 * v4.0.0 修正：
 *  - winChars<=0 旧版死循环（start 不推进）→ 钳制为 >=1；
 *  - 情感词改为全文匹配后按起点归窗口（旧版硬切窗口，跨边界的情感词两侧都匹配不到、整词丢失）；
 *  - 词表嵌套双计（悲痛⊂悲痛欲绝）→ 最长优先 + 区间消费；
 *  - 新增 seriesFull（含零命中窗口的等距序列，供相邻撕裂/斜率使用）。
 * v4.3.0 修正（P1-3/4）：新增 hasHit 逐窗口命中标记——adjVariance 与 delta 需要区分
 * "真实效价 0"与"该窗口根本没有情感词"，旧版把两者都当 0（详见 valenceStats）。
 */
export function valenceSeries(text, winChars = 100) {
  const src = String(text ?? "");
  const win = Math.max(1, Number.isFinite(winChars) ? Math.floor(winChars) : 100);
  const series = [];
  const windowPosNeg = [];
  const entries = Object.entries(VALENCE_WORDS).sort((x, y) => y[0].length - x[0].length);
  const windowTotal = Math.ceil(src.length / win);
  const seriesFull = new Array(windowTotal).fill(0);
  // 全文逐词匹配（indexOf 原生扫描）→ 最长优先消费区间
  const matches = [];
  for (const [word, val] of entries) {
    let from = 0;
    while (from <= src.length - word.length) {
      const idx = src.indexOf(word, from);
      if (idx === -1) break;
      matches.push({ idx, end: idx + word.length, len: word.length, val });
      from = idx + word.length;
    }
  }
  matches.sort((a, b) => b.len - a.len || a.idx - b.idx);
  const consumed = new Uint8Array(src.length);
  const sums = new Array(windowTotal).fill(0);
  const counts = new Array(windowTotal).fill(0);
  for (let w = 0; w < windowTotal; w += 1) windowPosNeg.push({ pos: 0, neg: 0 });
  for (const m of matches) {
    let free = true;
    for (let p = m.idx; p < m.end; p += 1) {
      if (consumed[p] === 1) { free = false; break; }
    }
    if (!free) continue;
    for (let p = m.idx; p < m.end; p += 1) consumed[p] = 1;
    // v3.9.1 #5：对每个情感词命中位置做 negatedAt 过滤——被否定则该次不计词、不进 pos/neg 计数
    if (negatedAt(src, m.idx)) continue;
    const w = Math.floor(m.idx / win);
    sums[w] += m.val;
    counts[w] += 1;
    if (m.val > 0) windowPosNeg[w].pos += 1;
    else if (m.val < 0) windowPosNeg[w].neg += 1;
  }
  // v4.3.0：hasHit[w] 标记该窗口是否有情感词命中（区分"效价 0"与"无数据"）
  const hasHit = counts.map((c) => c > 0);
  for (let w = 0; w < windowTotal; w += 1) {
    // v3.7.0 高6：零命中窗口（无情感词）不进 series——0 会稀释均值并伪造"趋势回升"信号
    if (counts[w] > 0) {
      const value = Math.round((sums[w] / counts[w]) * 1000) / 1000;
      series.push(value);
      seriesFull[w] = value;
    }
  }
  const posWords = windowPosNeg.reduce((s, w) => s + w.pos, 0);
  const negWords = windowPosNeg.reduce((s, w) => s + w.neg, 0);
  // v4.3.0（P1-4）：删除零消费者的 windowCount / hitWindowCount 两个返回字段
  // （全仓库 grep 仅本行出现；valenceStats 内部用 windowPosNeg.length 自行取窗口数）。
  return { series, seriesFull, hasHit, posWords, negWords, windowPosNeg };
}

/** v1.6.0 三指标：方差 V + 相邻撕裂 V_adj + 斜率 Δ（最小二乘+鲁棒版）+ 矛盾指数 C。 */
export function valenceStats(text) {
  // v3.5.0 #57：一次 valenceSeries 取全部（旧版窗口统计二次调用，大书白扫一遍词表）
  const { series, seriesFull, hasHit, posWords, negWords, windowPosNeg } = valenceSeries(text);
  const n = series.length;
  const windowTotal = windowPosNeg.length;
  // v3.7.0：零命中窗口跳过后的空系列——补全字段（下游 emotion.quantification.stats 恒有值）
  if (n === 0) return { windows: windowTotal, hitWindows: 0, adjPairs: 0, variance: 0, adjVariance: 0, delta: 0, deltaRobust: 0, deltaBasis: DELTA_BASIS, conflict: 0, posRatio: 0, negRatio: 0, meanValence: 0 };
  const mean = series.reduce((x, y) => x + y, 0) / n;
  // v3.6.0：样本方差口径 /(n-1)（n=1 时无方差=0）
  const variance = n > 1 ? series.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  // v4.0.0 修正：相邻撕裂/斜率改用全窗口等距序列——旧版跳过零命中窗口后，相隔数百字的两个窗口被当成"相邻"，
  // adjVariance 虚高、delta 被单次跳变放大；均值/方差仍只统计有命中的窗口（避免 0 稀释）。
  // v4.3.0 修正（P1-3）：相邻撕裂只累加「相邻两窗口都有命中」的对——旧版把零命中窗口的 0 也当效价 0，
  // 一次真实跳变被拆成"命中→空窗"与"空窗→命中"两段并摊到全部相邻对上，
  // 实测真实跳变 1.6 被算成 0.278（10 窗口里 6 个是空窗）。现按有效对数归一，并返回 adjPairs
  // 让调用方知道本次只有几对可用（adjPairs=0 表示没有任何可测量的相邻撕裂）。
  // 行为变化：adjVariance 通常变大（分母只数有效对），空窗占比高的文本 adjPairs 会很小；
  // 同一本书新旧报告不可直接比较。
  const m = seriesFull.length;
  let adjSum = 0;
  let adjPairs = 0;
  for (let i = 1; i < m; i += 1) {
    if (!hasHit[i] || !hasHit[i - 1]) continue;
    adjSum += Math.abs(seriesFull[i] - seriesFull[i - 1]);
    adjPairs += 1;
  }
  const adjVariance = adjPairs > 0 ? adjSum / adjPairs : 0;
  const fullMean = m > 0 ? seriesFull.reduce((x, y) => x + y, 0) / m : 0;
  const iMean = (m - 1) / 2;
  let num = 0, den = 0;
  for (let i = 0; i < m; i += 1) {
    num += (i - iMean) * (seriesFull[i] - fullMean);
    den += (i - iMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const delta = slope * (m - 1);
  // v4.3.0 修正（P1-3）：deltaRobust 与 delta 统一到同一采样基 seriesFull。
  // 旧版 delta 用 seriesFull（全窗口等距）、deltaRobust 用 series（仅命中窗口），
  // 两者共享"趋势 Δ"语义与 ±0.3 阈值却不同源——命中窗口疏密不同就能给出差 4 倍以上的值
  // （实测 12 窗口仅首窗有命中：delta=-0.272 而 deltaRobust=0，报告并列展示即自相矛盾）。
  // 现二者都基于 seriesFull，并通过 deltaBasis 字段显式声明；两者差异只来自估计器
  // （delta=最小二乘斜率×跨度，deltaRobust=首尾三分位均值差），不再是采样基差异。
  // 行为变化：deltaRobust 数值改变（零命中窗口现在参与首尾均值），
  // 同一本书新旧报告不可直接比较。
  const third = Math.max(1, Math.floor(m / 3));
  const headMean = seriesFull.slice(0, third).reduce((x, y) => x + y, 0) / third;
  const tailMean = seriesFull.slice(-third).reduce((x, y) => x + y, 0) / third;
  // v3.5.0 #57：复用上面的 windowPosNeg（不再二次扫描）
  const totalWords = posWords + negWords;
  const posRatio = totalWords === 0 ? 0 : posWords / totalWords;
  const negRatio = totalWords === 0 ? 0 : negWords / totalWords;
  // 坑1方案：矛盾指数按"窗口内原始词"算再平均（避免全书平均掩盖"同窗交织"vs"分段喜悲"）
  const windowConflicts = windowPosNeg
    .filter((w) => w.pos + w.neg > 0)
    .map((w) => 2 * Math.min(w.pos / (w.pos + w.neg), w.neg / (w.pos + w.neg)));
  const conflict = windowConflicts.length === 0 ? 0 : windowConflicts.reduce((x, y) => x + y, 0) / windowConflicts.length;
  return {
    // v4.0.0 修正：windows 是窗口总数（旧版是"有命中的窗口数"）；另有 hitWindows
    windows: windowTotal,
    hitWindows: n,
    // v4.3.0：相邻撕裂的有效对数（分母），delta/deltaRobust 的采样基
    adjPairs,
    deltaBasis: DELTA_BASIS,
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
  // v4.3.0 修正（P1-4）：implicit.negative/positive 的分母由"neg+pos"改为三分分母"neg+pos+amb"后，
  // 旧阈值 0.6 在同一份文本上更难达到（歧义载体越多，比率被摊得越低），方向判定会整体偏向 neutral。
  // 这里改判"已裁决命中内部的方向"：用负/正占已裁决（非歧义）命中的比例，语义与旧版一致且不受歧义率影响。
  // 行为变化：implicitSign 在"歧义载体占比高"的文本上不再退化为 neutral。
  const decided = (implicit.negHits ?? 0) + (implicit.posHits ?? 0);
  const negShare = decided === 0 ? 0 : (implicit.negHits ?? 0) / decided;
  const posShare = decided === 0 ? 0 : (implicit.posHits ?? 0) / decided;
  const implicitSign = negShare >= 0.6 ? "negative" : posShare >= 0.6 ? "positive" : "neutral";
  return {
    // v3.7.0 引擎⑦：双向冲突（显负+隐正也报——原只查显正+隐负）
    explicitImplicitConflict: (explicitSign === "positive" && implicitSign === "negative") || (explicitSign === "negative" && implicitSign === "positive"),
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
        // v4.0.0 修正：按 EMOTION_CATS 索引排序构造键，与 labels 表键序一致（旧版字典序使 3/7 标签永不命中）
        const key = EMOTION_CATS.indexOf(list[i]) <= EMOTION_CATS.indexOf(list[j]) ? list[i] + "+" + list[j] : list[j] + "+" + list[i];
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const labels = {
    "joy+sorrow": "悲喜交加", "joy+anger": "又爱又恨/喜怒交织", "anger+sorrow": "哀怒交加/愤懑",
    "sorrow+fear": "悲伤恐惧", "joy+fear": "惊喜交加", "anger+fear": "惊惧愤怒", "sorrow+surprise": "愕然悲伤"
  };
  return [...pairCounts.entries()].map(([pair, count]) => ({ pair, count, label: labels[pair] ?? "复合情感" }))
    .sort((x, y) => y.count - x.count).slice(0, 5);
}

/** v1.6.0 单章分布（五维 clean）→ 熵/多样性/主次。 */
export function chapterEmotionStats(counts) {
  // v4.0.0 修正：counts 缺失时旧版直接抛 TypeError（导出 API 输入形状偏差即整条分析失败）
  const c = counts ?? {};
  const total = EMOTION_CATS.reduce((s, k) => s + (c[k] ?? 0), 0);
  if (total === 0) return null;
  const p = EMOTION_CATS.map((k) => (c[k] ?? 0) / total);
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
  // v4.0.0 修正：c.counts 缺失时不再抛 TypeError（与其余 ?? 0 的防御风格一致）
  const list = Array.isArray(perChapter) ? perChapter : [];
  const stats = list.map((c) => ({ chapter: c?.chapter, ...(chapterEmotionStats(c?.counts) ?? {}) })).filter((s) => s.entropy !== void 0);
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
  for (const c of list) for (const k of EMOTION_CATS) totalCounts[k] = (totalCounts[k] ?? 0) + (c?.counts?.[k] ?? 0);
  // v4.0.0：进入此处必有章节命中情感词（stats.length>0）→ totalCounts 总量>0 → global 恒非 null，
  // 故下方不再写 global ? … : … 的恒真分支（旧版死条件）
  const global = chapterEmotionStats(totalCounts);
  const entropies = stats.map((s) => s.entropy);
  const meanEntropy = entropies.reduce((x, y) => x + y, 0) / entropies.length;
  const entropyVariance = entropies.reduce((s, e) => s + (e - meanEntropy) ** 2, 0) / entropies.length;
  const meanDiversity = stats.reduce((s, x) => s + x.diversity, 0) / stats.length;
  const entropyNorm = global.entropy / EMOTION_MAX_ENTROPY;
  const conflictStrength = global.secondaryRatio / Math.max(global.dominantRatio, 0.0001);
  const score = Math.min(1, Math.max(0, entropyNorm * 0.5 + (meanDiversity / 5) * 0.25 + conflictStrength * 0.25));
  const level = score >= 0.6 ? "high" : score >= 0.4 ? "medium" : "low";
  return {
    score: Math.round(score * 100) / 100,
    level,
    entropy: global.entropy,
    maxEntropy: Math.round(EMOTION_MAX_ENTROPY * 1000) / 1000,
    diversity: global.diversity,
    dominant: global.dominant,
    dominantRatio: global.dominantRatio,
    secondary: global.secondary,
    secondaryRatio: global.secondaryRatio,
    conflict: global.dominant + "↔" + global.secondary,
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
export function emotionalQuantification(text, perChapter, blocks) {
  const stats = valenceStats(text);
  const implicit = implicitEmotionScan(text);
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
  // v3.5.0 M6：入口容错（null/undefined 不崩溃）
  text = String(text ?? "");
  // v4.0.0 修正：top 钳制 ≥1（旧版传 -1 时 slice(0,-1) 会静默丢掉最高频模板）
  const top = Math.max(1, Number.isInteger(options.top) ? options.top : 8);
  // v3.5.0 #63：maxSentences 钳制 ≥1（0/负数会让 slice(0,-5) 产生错误语义）
  const maxSentences = Math.max(1, Number.isInteger(options.maxSentences) ? options.maxSentences : 20000);
  const curveSegments = Number.isInteger(options.curveSegments) ? Math.min(Math.max(options.curveSegments, 1), 50) : 20;
  const blocks = splitBlocks(text);
  const sentences = [];
  const blockMeta = [];
  // v3.9.1 #10：是否因 maxSentences 上限提前 break（前缀采样）——只影响 guidance 尾注，不加顶层字段
  let truncated = false;
  for (let b = 0; b < blocks.length; b += 1) {
    if (sentences.length >= maxSentences) { truncated = true; break; }
    const parts = splitSentences(blocks[b]);
    const meta = { sentences: [], opening: void 0, closing: void 0 };
    for (const part of parts) {
      if (sentences.length >= maxSentences) { truncated = true; break; }
      const classified = classifySentence(part);
      // v4.3.0（P1-6）：逐句记录删除两个只写不读的字段——quoted（全仓库唯一出现处即本行赋值）
      // 与 block（段落归属已由 blockMeta[b].sentences 的结构隐含，且 .block 全仓库零读取）。
      // classifySentence 仍返回 quoted（其公开契约不变），只是不再抄进逐句记录。
      const record = {
        text: part,
        type: classified.type,
        len: part.length,
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
  // v4.0.0 修正：截断采样时口径统一——旧版分子只统计前缀句、分母却是全文长度（emotionDensity/intensity/
  // firstPersonDensity 系统性低估），且 valenceStats/implicit/densityOf 扫全文与句式计数不同源。
  // 直接拼接句子（句内已含句末标点，不会跨句造词），避免 join 分隔符虚增分母。
  // v4.3.0 修正（P1-6）：两条路径统一为「句子拼接」样本——旧版截断时用句子拼接、
  // 未截断时用原文（含空行与 Markdown 标题行），同一段文本仅因是否触顶就换分母，
  // 密度类指标（emotionDensity/intensity/firstPersonDensity/densityOf）无法跨次比较。
  // 现 sampleText 恒为句子拼接结果，sampleChars 恒为 sampleText.length；
  // totalChars 仍保留全文长度（顶层字段语义不变，截断提示里的 "采样字数/全文字数" 因此仍可比）。
  // 行为变化：未截断路径下，空行/标题/段落分隔符不再计入密度分母（分子不变 → 密度略升），
  // 同一本书新旧报告不可直接比较。
  const sampleText = sentences.map((s) => s.text).join("");
  const sampleChars = sampleText.length;

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
  let narrationOnly = 0;
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
    // v4.0.0 新增：其余「单一句式且非对话/心理」的段落统一计入 narrationOnly——
    // 保证 dialogueOnly + psychologyOnly + mixed + narrationOnly === total 恒成立
    //（常见形态即全陈述句段；全环境/全疑问等单一句式段同属纯叙述，不再漏计）
    else narrationOnly += 1;
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
    narrationOnly,
    exchanges
  };

  // 句长分布
  const lens = sentences.map((s) => s.len);
  const avgLength = lens.length === 0 ? 0 : round(lens.reduce((a, b) => a + b, 0) / lens.length, 2);
  const short = lens.filter((len) => len <= 10).length;
  const medium = lens.filter((len) => len > 10 && len <= 24).length;
  const long = lens.filter((len) => len > 24).length;
  // v4.0.0 修正：distribution 桶边界与 short/medium/long 对齐（10/24/40）——旧版两套边界
  // （10/24 vs 10/20/30/40）无法交叉核对，按 distribution 复算 ratio 必然对不上
  const buckets = [
    ["1-10", (len) => len <= 10],
    ["11-24", (len) => len > 10 && len <= 24],
    ["25-40", (len) => len > 24 && len <= 40],
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
    // v3.7.0 引擎③：按文本内实际出现次数计数（"开心开心开心"不再 count=1）
    // v4.0.0 修正：与 scores 同口径——被否定（"不害怕"）的命中不再计入词频
    // v4.3.0 修正（P0-1）：直接累加 emotionOf 带出的命中列表（hitList，已经过区间消费 +
    // 否定过滤 + 副词加权），删除旧的"words 去重回原文 indexOf 重扫"——
    // 那次重扫不认识区间消费，"悲痛欲绝"里嵌的"悲痛"被再计一次，
    // 实测 "他悲痛欲绝，悲痛得说不出话。" scores.sorrow=2 而 topWords 合计 3。
    for (const hit of sentence.emotion.hitList) {
      emotionWordCounts.set(hit.word, (emotionWordCounts.get(hit.word) ?? 0) + 1);
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
  const emotionDensity = sampleChars === 0 ? 0 : round((totalEmotion / sampleChars) * 1000, 2);
  // v1.5.0：情绪污染源检测（R18/战斗/恐怖高密度 → 情感结论降级）
  const pollution = { r18: 0, battle: 0, horror: 0 };
  for (const [kind, words] of Object.entries(EMOTION_POLLUTION)) {
    for (const word of words) pollution[kind] += sampleText.split(word).length - 1;
  }
  const pollutionPer1000 = (n) => round((n / Math.max(sampleChars, 1)) * 1000, 2);
  const r18Density = pollutionPer1000(pollution.r18);
  const battleDensity = pollutionPer1000(pollution.battle);
  const horrorDensity = pollutionPer1000(pollution.horror);
  const polluted = r18Density >= 1.5 || battleDensity >= 3 || horrorDensity >= 3;
  const pollutedBy = [];
  if (r18Density >= 1.5) pollutedBy.push("高密度 R18/生理描写（每千字 " + r18Density + "）");
  if (battleDensity >= 3) pollutedBy.push("高密度战斗/爽文描写（每千字 " + battleDensity + "）");
  if (horrorDensity >= 3) pollutedBy.push("高密度恐怖/疯狂描写（每千字 " + horrorDensity + "）");
  // v3.7.0 引擎②：clean 无强词主导（全来自弱词）→ medium（不再判 high）
  const confidence = polluted ? "low" : (cleanDominantEmotion === "neutral" ? "medium" : (cleanDominantEmotion !== dominantEmotion ? "medium" : "high"));
  const caveat = polluted
    ? "⚠️ 检测到" + pollutedBy.join("、") + "，dominant（" + EMOTION_LABELS[dominantEmotion] + "）可能来自生理/爽感反应词而非真实情感。请勿直接采信，须 novel_read 抽查 2-3 段原文复核真实情感基调后再下结论。"
    : (cleanDominantEmotion !== dominantEmotion
      ? "ℹ️ 剔除易污染的情绪词后，主导情感为「" + EMOTION_LABELS[cleanDominantEmotion] + "」（raw 为「" + EMOTION_LABELS[dominantEmotion] + "」），差异来自场景性用词，请结合原文判断。"
      : "");
  // v4.0.0 修正：chapterDrift 有分章输入时按「章」聚合——旧版按段分组，单情绪段的熵恒为 0，
  // meanEntropy/entropyVariance/swinging 在常见文本上几乎恒 false，与字段名"章间漂移"不符。
  // 单章分析（无 chapterTexts）仍回退段级，并在结果里标出 basis 以免误读。
  const perChapterGroups = (function () {
    if (Array.isArray(options.chapterTexts) && options.chapterTexts.length > 0) {
      return {
        basis: "chapter",
        entries: options.chapterTexts.map(function (item) {
          return { chapter: String(item?.chapter ?? "?"), counts: cleanScoresOf(String(item?.text ?? "")) };
        }).filter((c) => Object.values(c.counts).some((v) => v > 0))
      };
    }
    return {
      basis: "paragraph",
      entries: blockMeta.map(function (m, bi) {
        const pcCounts = { joy: 0, anger: 0, sorrow: 0, fear: 0, surprise: 0 };
        for (const s of m.sentences) {
          const cs = s.emotion.cleanScores ?? {};
          for (const k of Object.keys(pcCounts)) pcCounts[k] += cs[k] ?? 0;
        }
        return { chapter: "段" + (bi + 1), counts: pcCounts };
      }).filter((m) => Object.values(m.counts).some((v) => v > 0))
    };
  })();
  const quantification = emotionalQuantification(sampleText, perChapterGroups.entries, blockMeta.map((m) => m.sentences).filter((s) => s.length > 0));
  if (quantification?.complexity?.chapterDrift) quantification.complexity.chapterDrift.basis = perChapterGroups.basis;
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
        // v3.7.0 引擎④：DUTIR 兜底词标出真实情感（不再与 scores 自相矛盾标 neutral）
        if (emotionOfWord === "neutral") emotionOfWord = dutirLookup.get(word) || "neutral";
        return { word, count, emotion: emotionOfWord };
      })
      .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
      .slice(0, 12),
    curve: emotionCurve(blockMeta, curveSegments),
    // v1.6.0：情感量化（Valence 三指标 + 显隐对比 + 复杂度 + 复合共现）
    quantification
  };

  // 主观性指数（启发式 0-100）
  const psychRatio = totalSentences === 0 ? 0 : counts.psychology / totalSentences;
  const exclaimRatio = totalSentences === 0 ? 0 : counts.exclamation / totalSentences;
  // v3.6.0：第一人称最长匹配优先（"我们"不拆成 我+我们 双计）
  const firstPersonCount = (function () {
    let fpSum = 0;
    const fpSorted = FIRST_PERSON_WORDS.slice().sort((x, y) => y.length - x.length);
    let fpText = sampleText;
    for (const w of fpSorted) {
      if (w.length < 2) continue;
      const parts = fpText.split(w);
      fpSum += parts.length - 1;
      fpText = parts.join("\u0000".repeat(w.length));
    }
    // v3.9.1 #8：剩余孤立单字统计 我/俺/咱 三者（原只补"我"，俺/咱方言第一人称漏计）
    fpSum += (fpText.match(/[我俺咱]/g) || []).length;
    return fpSum;
  })();
  const firstPersonDensity = sampleChars === 0 ? 0 : (firstPersonCount / sampleChars) * 1000;
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
      // v4.0.0 修正：缺失 text 时旧版 String(undefined) → "undefined" 被当成陈述句污染节奏指纹
      if (typeof item?.text !== "string") continue;
      const chapterCodes = splitSentences(item.text).slice(0, maxSentences).map((s) => classifySentence(s).type);
      chapterPatterns.push({
        chapter: String(item.chapter ?? "?"),
        sequence: compressSequence(chapterCodes.map((type) => TYPE_CODE[type]))
      });
    }
  }

  const ratios = Object.fromEntries(CATEGORY_ORDER.map((type) => [type, totalSentences === 0 ? 0 : round(counts[type] / totalSentences, 4)]));
  let guidance = buildGuidance(ratios, motifs, chapterPatterns);
  // v3.9.1 #10：因 maxSentences 前缀截断时在 guidance 末尾追加一行提示（不新增顶层字段）
  if (truncated) {
    // v4.0.0：标注实际采样字数（各密度分母已统一为采样文本，模型可据此核对）
    guidance += "\n⚠️ 文本超过采样上限(" + maxSentences + " 句),以上统计基于前缀采样(" + sampleChars + "/" + totalChars + " 字);建议分章分析。";
  }

  const fingerprint = buildFingerprint(categories, lengths, style, emotion, motifs);
  // v4.0.0 修正：细节密度同样以采样文本为样本（旧版扫全文，与句式/情感计数不同源）
  const density = densityOf(sampleText);

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
  const curve = [];
  for (let s = 0; s < segmentCount; s += 1) {
    // v4.0.0 修正：按比例分配边界，杜绝 ceil 均分产生的尾部空 slice（伪造的 intensity=0 平缓段）
    const from = Math.floor((s * blocks.length) / segmentCount);
    const to = Math.floor(((s + 1) * blocks.length) / segmentCount);
    const slice = blocks.slice(from, to);
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
  // v3.6.0 复审修正：不裁剪——强度 0 段是"平缓段"（跨章节曲线对齐需要固定段数契约）；
  // segmentCount=min(blocks, maxSegments) 已保证每段至少 1 块，无空 slice
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
  // v3.9.1 #12：温度词（冷/热/凉/暖/烫）只归 temperature 通道——从 tactile 剔除，防同一词 sensePer1000 双计
  tactile: /疼|痛|滑|糙|冰|湿|干|硬|软|麻|痒/,
  olfactory: /香|臭|味|气|腥|甜|苦|酸/,
  temperature: /热|烫|凉|冷|暖|温/
};
// v4.0.0 性能：带 /g 的正则提升到模块级（旧版每句重建 5 个 RegExp；String.match 会重置 lastIndex，复用安全）
const DENSITY_ACTION_RE = new RegExp(DENSITY_ACTION_VERBS.source, "g");
const DENSITY_OBJECT_RE = new RegExp(DENSITY_OBJECT_WORDS.source, "g");
const DENSITY_SENSE_RE = Object.fromEntries(Object.entries(DENSITY_SENSE).map(([kind, re]) => [kind, new RegExp(re.source, "g")]));
const countMatches = (str, re) => (str.match(re) || []).length;

/** 细节密度统计（v0.8.0）：动作链/物件名词/感官词，按千字归一。 */
export function densityOf(text) {
  const sentences = splitSentences(text);
  // v3.5.0 #62：分母口径统一（含空白，与 style-metrics 的 per1000 一致，跨模块数值可比）
  const totalChars = String(text).length;
  let actionVerbs = 0;
  let actionChainSentences = 0;
  let objectHits = 0;
  const sense = { visual: 0, auditory: 0, tactile: 0, olfactory: 0, temperature: 0 };
  const actionChains = [];
  for (const sentence of sentences) {
    // v4.0.0：去掉未使用的循环变量 m（旧版 for…of matchAll 只为计数）
    const verbs = countMatches(sentence, DENSITY_ACTION_RE);
    if (verbs >= 2) {
      actionChainSentences += 1;
      if (actionChains.length < 3) actionChains.push(sentence.slice(0, 40));
    }
    actionVerbs += verbs;
    objectHits += countMatches(sentence, DENSITY_OBJECT_RE);
    for (const [kind, re] of Object.entries(DENSITY_SENSE_RE)) {
      sense[kind] += countMatches(sentence, re);
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
import { gunzipSync } from "node:zlib";
const __req = createRequire(import.meta.url);
let DUTIR = null;
function loadDutir() {
  if (DUTIR) return DUTIR;
  try {
    // v4.0.1：dutir 词表以 gzip 随包分发（原文件 383KB 超出商店单文件上限），加载时解压
    const p = __req.resolve("./lexicons/dutir_seven.json.gz");
    DUTIR = JSON.parse(gunzipSync(__req("node:fs").readFileSync(p)).toString("utf8"));
  } catch {
    DUTIR = {};
  }
  return DUTIR;
}
const DUTIR_TO_EMOTION = { 乐: "joy", 好: "joy", 怒: "anger", 哀: "sorrow", 惧: "fear", 恶: "anger", 惊: "surprise" }; // v3.5.0 H4：恶(厌恶) 归 anger 而非 sorrow
/**
 * v4.3.0（P1-5）：dutir 兜底扫描的最长词长上限。
 * 旧版在 emotionOf 里写死 `Math.min(4, …)`，而词表里 853 条 ≥5 字条目
 * （久旱逢甘雨/一步一个脚印/打开天窗说亮话…）永远无法命中——占比 3.1%，且都是成语级强情感词。
 * 现提到 8（词表最长条目 7 字），内层最多 7 次 slice，实测 2000 字文本兜底耗时 1.1ms→2.6ms。
 */
const DUTIR_MAX_WORD_LEN = 8;
const dutirLookup = new Map();
function dutirEmotion(word) {
  if (dutirLookup.size === 0) {
    const dutir = loadDutir();
    for (const [cat, words] of Object.entries(dutir)) {
      const emo = DUTIR_TO_EMOTION[cat];
      if (!emo) continue;
      // v3.5.0 H4：跨类冲突词首见保留（后写不再覆盖——"开心"不会被 恶 类覆盖成 sorrow）
      for (const raw of words) {
        if (typeof raw !== "string") continue;
        // v4.3.0：词表里有大量带首尾空白（"一路福星　"）与纯 ASCII/颜文字的噪声条目，
        // 它们永远过不了命中处的 /^[\u4e00-\u9fa5]+$/ 校验。建表时先 trim 并只收纯汉字，
        // 既让"一路福星"这类词恢复可命中，也减小 Map 体积（27k → 实际可命中条目）。
        const w = raw.trim();
        if (w.length < 2 || w.length > DUTIR_MAX_WORD_LEN) continue;
        if (!/^[\u4e00-\u9fa5]+$/.test(w)) continue;
        if (!dutirLookup.has(w)) dutirLookup.set(w, emo);
      }
    }
  }
  return dutirLookup.get(word);
}
// v4.0.0：删除零调用的导出 dutirEmotionOf（全仓库仅定义处出现；内部用 dutirEmotion）
