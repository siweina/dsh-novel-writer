/**
 * v3.0.0 文笔六维测量（style-metrics.js）——用户提出的六维量化指标
 * 句法复杂度 / 抽象度 / 动作密度 / 不确定性 / 修饰密度 / 留白指数
 *
 * 全部零依赖实现：
 * - 句法复杂度：标点分隔的小句数（逗号/分号/冒号），近似嵌套深度
 * - 修饰密度：X的 / X地 结构统计（“的/地”前的词视为修饰语）
 * - 抽象度：抽象后缀启发式（…感/性/度/情/绪/念… 结尾的 2-3 字词）
 * - 动作密度：高频动作动词 + 动态助词/宾语模式（“她推开门”型）
 * - 不确定性：模糊限制语小词表（似乎/仿佛/大概/可能…）
 * - 留白指数：省略号/破折号密度 + 未完句比例
 */

// v4.3.0：句末结束符与 analysis.js 共用同一常量——旧版两处口径不同
// （analysis 只认全角 。！？…，style-metrics 认半角 !?，同一句 "你疯了?我没疯!他走了。"
//  analysis 得 1 句、style-metrics 得 3 句，两模块的句数/复杂度/留白无法交叉核对）。
// 行为变化：本模块切句加入 "…"（此前只在 "。" 处切），省略号句现在单独成句，
// complexity 与 gapIndex（未完句比例）随之变化，同一本书新旧风格报告不可直接比较。
import { TERMINATORS } from "./analysis.js";

// 模糊限制语（不确定性）：叙述犹疑/推测
const HEDGE_WORDS = [
  "似乎", "仿佛", "好像", "大概", "也许", "或许", "可能", "像是", "隐约", "依稀",
  "差不多", "八成", "兴许", "恍若", "貌似", "如同", "好似", "疑似", "感觉", "像是要"
];

// 抽象名词后缀（启发式：以这些字结尾的 2-3 字词多为抽象名词）
const ABSTRACT_SUFFIXES = [
  "感", "性", "度", "情", "绪", "念", "思", "意", "命", "运", "缘", "罪", "愁", "怨",
  "恨", "哀", "悲", "惧", "耻", "愧", "志", "望", "欲", "想", "法", "理", "道",
  "义", "德", "信", "诚", "真", "善", "美", "幻", "虚", "空", "寂", "寞", "孤", "独",
  "茫", "迷", "惑", "悟", "醒", "觉", "变", "化", "限", "界", "域", "境", 
  "魂", "魄", "灵", "梦"
];

// 高频动作动词（动作密度近似：动词 + 了/着/过/起/住 或直接跟宾语名词）
// v4.3.0：① 去重——旧表 665 条里 29 条重复（摆/炸/递/倒/折/裂/染/压/鼓/触/震/咽/堵/乱/潜/
//   修/坐/争/割/配/发/仰/指/设/端/锁/囚/罩/络），虽因 ACTION_SET 是 Set 而不影响计数，
//   但表本身就是文档，重复项会误导维护者；去重后 636 条。
// ② 清洗明显非动词的单字（胖/兴/分/静/行/瓶/肋/颈/壁/牢/笼，共 11 条）——它们是名词/形容词：
//   "他十分高兴。"旧版 actionCount=2（分+兴）、"他很胖。"=1（胖）、"他静静地站着。"=2（静+站）、
//   "不行，我不能去。"=1（行），全部是误计。去重清洗后保留 625 条。
// 行为变化：动作密度 actionDensity / actionCount 数值下降（形容词/名词句不再虚高），
// 同一本书新旧风格报告不可直接比较。
const ACTION_VERBS = [
  "推", "拉", "抓", "拿", "端", "抱", "举", "抬", "踢", "踩",
  "打", "拍", "敲", "砸", "扔", "丢", "接", "递", "握", "捏",
  "掐", "拧", "扯", "撕", "拔", "插", "捅", "刺", "砍", "劈",
  "切", "割", "放", "摆", "搁", "挂", "贴", "塞", "填", "灌",
  "倒", "泼", "洒", "翻", "卷", "铺", "盖", "叠", "折", "脱",
  "穿", "戴", "摘", "解", "开", "关", "锁", "按", "压", "顶",
  "撞", "碰", "触", "摸", "抚", "揉", "搓", "擦", "抹", "洗",
  "刷", "扫", "拖", "铲", "挖", "埋", "堆", "砌", "修", "补",
  "缝", "织", "编", "缠", "绕", "捆", "绑", "扎", "拴", "套",
  "蒙", "罩", "捂", "堵", "挡", "遮", "掩", "藏", "躲", "避",
  "逃", "追", "赶", "跑", "走", "奔", "冲", "闯", "越", "跨",
  "跳", "跃", "爬", "攀", "登", "降", "升", "沉", "浮", "漂",
  "荡", "摇", "晃", "抖", "颤", "震", "动", "停", "驻", "立",
  "坐", "躺", "卧", "跪", "蹲", "站", "靠", "倚", "趴", "俯",
  "仰", "倾", "侧", "转", "回", "返", "退", "进", "出", "入",
  "起", "落", "哭", "笑", "喊", "叫", "嚷", "吼", "骂", "斥",
  "责", "夸", "赞", "叹", "喘", "吸", "呼", "吐", "咽", "吞",
  "嚼", "咬", "啃", "舔", "吮", "嗅", "闻", "听", "看", "望",
  "瞧", "瞅", "盯", "瞪", "瞥", "瞟", "瞄", "观", "察", "读",
  "写", "画", "描", "绘", "刻", "雕", "铸", "炼", "烧", "煮",
  "炒", "煎", "炸", "烤", "烘", "熏", "泡", "浸", "染", "涂",
  "喷", "浇", "淋", "滴", "淌", "涌", "冒", "射", "溅", "裂",
  "碎", "破", "赢", "输", "借", "还", "付", "收", "给", "送",
  "寄", "交", "赐", "赏", "罚", "奖", "惩", "减", "增", "加",
  "删", "改", "换", "替", "代", "变", "创", "建", "设", "置",
  "安", "装", "配", "组", "拆", "卸", "运", "搬", "携", "带",
  "佩", "持", "执", "操", "控", "驾", "驶", "骑", "乘", "踏",
  "迈", "驰", "飞", "翔", "游", "泳", "潜", "航", "驱", "逐",
  "灭", "杀", "斩", "擒", "捕", "捉", "逮", "拘", "押", "囚",
  "禁", "铐", "缚", "吊", "悬", "垂", "坠", "掉", "摔", "跌",
  "仆", "瘫", "麻", "僵", "直", "挺", "竖", "耸", "矗", "凸",
  "凹", "陷", "塌", "崩", "垮", "弯", "断", "绽", "合", "拢",
  "闭", "张", "启", "展", "伸", "缩", "抽", "拽", "揪", "捋",
  "拂", "掸", "扑", "扇", "燃", "点", "着", "焚", "灼", "烫",
  "烙", "煨", "炖", "焖", "熬", "烹", "调", "拌", "搅", "和",
  "团", "发", "烂", "腐", "朽", "酸", "甜", "苦", "辣", "咸",
  "腻", "肿", "胀", "鼓", "瘪", "皱", "平", "整", "齐", "乱",
  "杂", "混", "浊", "清", "澈", "净", "洁", "污", "脏", "臭",
  "香", "芳", "馥", "郁", "浓", "雅", "俗", "野", "蛮", "横",
  "霸", "欺", "榨", "剥", "削", "掠", "夺", "抢", "劫", "偷",
  "盗", "窃", "扒", "掏", "搜", "查", "寻", "找", "觅", "探",
  "索", "究", "研", "讨", "论", "议", "评", "判", "审", "核",
  "验", "证", "试", "测", "量", "计", "算", "析", "归", "纳",
  "辩", "驳", "争", "吵", "闹", "斗", "殴", "拼", "搏", "挣",
  "抗", "抵", "防", "守", "卫", "护", "保", "救", "援", "助",
  "帮", "扶", "领", "导", "指", "引", "教", "训", "培", "锻",
  "磨", "砺", "激", "励", "振", "奋", "感", "惊", "慨", "唏",
  "嘘", "呜", "啜", "泣", "哽", "窒", "憋", "闷", "慌", "躁",
  "烦", "恼", "怒", "火", "气", "愤", "憎", "恶", "厌", "嫌",
  "弃", "鄙", "蔑", "轻", "珍", "爱", "惜", "怜", "悯", "疼",
  "宠", "溺", "娇", "惯", "纵", "容", "包", "庇", "袒", "呵",
  "佑", "祝", "福", "祈", "祷", "祭", "祀", "拜", "念", "诵",
  "咏", "吟", "唱", "歌", "舞", "蹈", "旋", "滚", "滑", "溜",
  "窜", "遁", "隐", "匿", "伏", "悟", "参", "禅", "定", "成",
  "化", "属", "于", "存", "拥", "具", "获", "取", "博", "谋",
  "求", "愿", "确", "决", "选", "挑", "拣", "筛", "甄", "辨",
  "划", "派", "颁", "授", "予", "赠", "托", "委", "信", "任",
  "依", "凭", "仗", "恃", "盼", "期", "渴", "奢", "妄", "幻",
  "梦", "理", "构", "揣", "猜", "预", "料", "征", "兆", "迹",
  "象", "倪", "苗", "头", "绪", "脉", "络", "纹", "层", "次",
  "框", "架", "体", "程", "序", "骤", "环", "节", "细", "难",
  "焦", "热", "卖", "痛", "弱", "短", "板", "垒", "藩", "篱",
  "桎", "梏", "枷", "镣", "樊"
];

/**
 * v4.3.0：单字动作词的常见非动词搭配黑名单（2 字窗口命中即不计）。
 * 单字表无法区分"分"（分开=动作）与"十分"（程度副词）、"行"（行走）与"行李"（名词），
 * 故在命中处用 2 字搭配兜底；黑名单可扩展，新增项不影响既有词条。
 */
const ACTION_NON_VERB_BIGRAMS = new Set([
  "十分", "高兴", "不行", "行李", "方法", "瓶子", "太阳", "平静", "安静", "镇定",
  "冷静", "文静", "雅静", "行头", "行情", "行列", "分外", "胖乎", "笼统", "牢靠",
  "墙壁", "瓶颈", "肋巴", "乱七", "混乱", "杂乱", "忙乱", "络绎"
]);


// 动态助词（动词后出现 → 动作完成/进行，常见于动作描写）
const DYNAMIC_PARTICLES = "了着过起住上下进出开完掉得";

const ACTION_SET = new Set(ACTION_VERBS);

/** 切句：按句末标点切分。 */
// v4.3.0：结束符类由 analysis.js 的 TERMINATORS 派生（口径统一，见文件头说明）
const TERM_CLASS = "[" + TERMINATORS.replace(/[\\\]]/g, "\\$&") + "]";
const SENTENCE_SPLIT_RE = new RegExp("(?<=" + TERM_CLASS + ")(?!" + TERM_CLASS + ")\\s*|\\n+");
const TAIL_QUOTE_RE = /[”」』’\"']+$/;
const PURE_TERM_RE = new RegExp("^" + TERM_CLASS + "+$");
function splitSentences(text) {
  // v3.5.0 #50b：标点切句 + 无标点换行也切（逐行排版正确分句）；未完句判定按"行末豁免"处理（见 measureStyleMetrics）
  // v3.5.0 H3：句末标点后吞闭合引号（"她说：\u201c走吧。\u201d" 不再切成孤儿引号句）
  // v3.9.1 #1：句末符后若紧跟句末符则不切（太好了！！！/真的？？/他哭了。。。不再拆出孤立标点残片）
  return String(text)
    .split(SENTENCE_SPLIT_RE)
    .map(function (s) { return s.replace(TAIL_QUOTE_RE, "").trim(); })
    // 纯句末标点残片（！！！/？？/。。。）丢弃；纯省略号句（"……"）不是纯句末标点，保留
    .filter(function (s) { return s.length > 0 && !PURE_TERM_RE.test(s); });
}

/** v3.9.1 #2：名词词素"X地"——修饰密度统计 X地 时排除（地上/地下/地方/土地/…等；列表可扩展） */
// v4.3.0：拆成两张表——旧版单表 55 条里 16 条（地上/地下/地方/…/地层）永远无法命中：
// 匹配串 m 必然是 "…地" 结尾（正则末字就是"地"），m.endsWith("地上") 恒假，
// 于是"他坐在地上。"被当成真状语（advMods=1）。现按"地"的位置分表：
//  - DI_NOUN_ENDINGS：以"地"结尾的名词，仍用 m.endsWith(noun) 判定（原地/当地/土地…）；
//  - DI_NOUN_AFTER  ：以"地"开头的名词，用"命中之后的 2 字"判定（地上/地下/地方…）。
// 行为变化：advMods 数值下降（"他坐在地上/地下/地方…"不再计修饰），
// 修饰密度 modifierDensity 随之变化，同一本书新旧风格报告不可直接比较。
const DI_NOUN_ENDINGS = new Set([
  "土地", "原地", "当地", "特地", "墓地", "产地", "场地", "落地", "阵地", "田地", "旱地", "湿地", "耕地", "草地", "雪地", "山地", "坡地",
  "林地", "园地", "荒地", "宝地", "圣地", "禁地", "腹地", "属地", "领地", "封地", "外地", "洼地", "谷地", "泥地",
  "大地", "平地", "内地", "各地", "两地", "满地", "遍地", "目的地"
]);
/** 以"地"开头的名词（命中串之后的两个字）——命中即不算 X地 状语。 */
const DI_NOUN_AFTER = new Set([
  "地上", "地下", "地方", "地面", "地区", "地位", "地铁", "地图", "地板", "地道", "地理", "地球", "地域", "地点", "地址", "地层"
]);

// v4.3.0：修饰密度两张停用词表——"的"作为词尾（真的/似的）或词首（的确）时都不是修饰助词。
// 用 matchAll 取真实下标，对"的"前后各 2 字判定；旧版只有 (?<!目)(?<!的) 两个 lookbehind，
// 拦不住"的确"（的在前）与"真的/似的"（的是词尾），实测 adjMods 虚高 1~2。
const DE_FALSE_TAIL = new Set(["真的", "似的", "目的", "有的", "是的"]);
// 刻意不收"中的/的话"——它们在"梦中的场景""他的话很多"里都是真修饰助词，收了会漏计。
const DE_FALSE_HEAD = new Set(["的确", "的士"]);
const MODIFIER_DE_RE = /[\u4e00-\u9fff]{1,3}(?<!目)(?<!的)的/g;

/** 修饰密度①：X的（1-3 字修饰语 + 的），带 2 字停用词排除。 */
function countModifierDe(text) {
  let n = 0;
  for (const m of text.matchAll(MODIFIER_DE_RE)) {
    const end = m.index + m[0].length;              // "的"之后的位置
    if (DE_FALSE_TAIL.has(text.slice(end - 2, end))) continue; // 真的/似的/目的…（的为词尾）
    if (DE_FALSE_HEAD.has(text.slice(end - 1, end + 1))) continue; // 的确/的的/的话…（的为词首）
    n += 1;
  }
  return n;
}

/** 修饰密度②：X地 状语（排除"地"结尾名词与"地"开头名词，见 DI_NOUN_ENDINGS / DI_NOUN_AFTER）。 */
const MODIFIER_DI_RE = /[\u4e00-\u9fff]{1,4}地/g;
function countModifierDi(text) {
  let n = 0;
  for (const m of text.matchAll(MODIFIER_DI_RE)) {
    const s = m[0];
    let excluded = false;
    for (const noun of DI_NOUN_ENDINGS) { if (s.endsWith(noun)) { excluded = true; break; } }
    // v4.3.0：命中串之后的两个字是"地X"名词（地上/地下/地方…）→ 不算状语
    if (!excluded) {
      const diAt = m.index + s.length - 1;          // 匹配串末字就是"地"
      const after = text.slice(diAt, diAt + 2);     // "地"起的两字窗口
      if (DI_NOUN_AFTER.has(after)) excluded = true;
    }
    if (!excluded) n += 1;
  }
  return n;
}

// v4.3.0：抽象度词表辅助——后缀集 + 假阳性停用词（末字恰好是抽象后缀的常用非抽象词）。
const ABSTRACT_SUFFIX_SET = new Set(ABSTRACT_SUFFIXES);
const ABSTRACT_STOP = new Set([
  "知道", "味道", "街道", "心里", "哪里", "事情", "睡觉", "地道", "门道", "过道", "生意", "注意"
]);
const CHINESE_ONLY_RE = /^[\u4e00-\u9fff]+$/;

/**
 * v4.3.0：抽象度计数——逐位「最长匹配 + 区间消费」，4→3→2 字优先。
 * 旧版正则尾部 `(?![\u4e00-\u9fff])` 要求抽象词后必须是非汉字，
 * 于是"她的感情很深。"=0 而"她的感情，很深。"=1，同一词只因后随标点不同而一计一不计；
 * 且 `{1,2}` 上限使 3-4 字抽象词（责任感/存在主义…）永不命中。
 * 已知取舍：相邻两个抽象词若被一个 4 字窗口跨越（"感情和理性"），会计为 1 个。
 */
function countAbstractWords(text) {
  const consumed = new Uint8Array(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (consumed[i] === 1) continue;
    let hitLen = 0;
    for (const len of [4, 3, 2]) {
      if (i + len > text.length) continue;
      const w = text.slice(i, i + len);
      if (!CHINESE_ONLY_RE.test(w)) continue;
      if (!ABSTRACT_SUFFIX_SET.has(w[w.length - 1])) continue;
      if (ABSTRACT_STOP.has(w) || ABSTRACT_STOP.has(w.slice(-2))) continue;
      hitLen = len;
      break;
    }
    if (hitLen === 0) continue;
    for (let p = i; p < i + hitLen; p += 1) consumed[p] = 1;
    n += 1;
  }
  return n;
}


/**
 * 六维测量。
 */
export function measureStyleMetrics(text) {
  // v3.9.5：剥 Markdown 标题行（与 analysis.splitBlocks 口径一致，章节标题不参与句数/字数/留白测量）
  const t = String(text ?? "").replace(/^#{1,6}[ \t]+[^\n]*\n?/gm, "");
  const totalChars = t.length;
  const per1000 = function (n) { return totalChars > 0 ? (n / totalChars) * 1000 : 0; };

  // 1) 句法复杂度：平均每句小句数（逗号/分号/冒号分隔）
  const sentences = splitSentences(t);
  let smallClauseTotal = 0;
  for (const s of sentences) {
    const clauses = s.split(/[，,；;：:]/).filter(function (c) { return c.trim() !== ""; }).length;
    smallClauseTotal += Math.max(clauses, 1);
  }
  const complexity = sentences.length > 0 ? smallClauseTotal / sentences.length : 0;

  // 2) 修饰密度：X的 / X地（“的/地”前的 1-4 字修饰语）
  // v3.6.0：「目的/的确/的的确确」的"的"不是修饰助词——lookbehind 排除（真修饰语不受影响）
  // v3.9.1 #2：X地 排除名词词素（原地/当地/土地…）——命中候选名词或其结尾即跳过
  // v4.3.0：旧版只拦"的"前一字（(?<!目)(?<!的)），拦不住"的确"（的在前）、
  //   "真的/似的"（的是词尾）——实测"他的确走了。"adjMods=1、"他说的是真的。"=2、
  //   "像疯了似的跑。"=1。现对命中窗口的 2 字做停用词排除：
  //   ① 以"的"结尾的整词（真的/似的/目的…）→ 该"的"是词尾，不是修饰助词；
  //   ② 以"的"开头的整词（的确/的的/的话…）→ 该"的"是词首，不是修饰助词。
  // 行为变化：adjMods / modifierDensity 数值下降（真的/的确/似的不再计修饰），
  //   同一本书新旧风格报告不可直接比较。
  const adjMods = countModifierDe(t);
  const advMods = countModifierDi(t);
  const modifierDensity = per1000(adjMods + advMods);

  // 3) 抽象度：抽象后缀 2-4 字词（最长匹配 + 区间消费，3/4 字优先）
  // v3.9.1 #2 遗留缺陷（v4.3.0 修复）：旧正则尾部 (?![\\u4e00-\\u9fff]) 要求抽象词后必须是非汉字，
  //   于是"她的感情很深。"=0 而"她的感情，很深。"=1 —— 同一抽象词只因后随标点不同就一计一不计。
  // 现改为逐位最长匹配（4→3→2 字优先）+ 区间消费，并排除知道/味道/街道/事情/睡觉等假阳性词
  //   （它们的末字恰好在 ABSTRACT_SUFFIXES 里）。
  // 行为变化：abstractCount / abstractDensity 上升（后随汉字的抽象词现在也计），
  //   同一本书新旧风格报告不可直接比较。
  const abstractCount = countAbstractWords(t);
  const abstractDensity = per1000(abstractCount);

  // 4) 动作密度：动作动词 + 动态助词/宾语模式
  let actionCount = 0;
  let idx = 0;
  while (idx < t.length) {
    const ch = t[idx];
    if (ACTION_SET.has(ch)) {
      const next = idx + 1 < t.length ? t[idx + 1] : "";
      const next2 = idx + 2 < t.length ? t[idx + 2] : "";
      // v4.3.0：单字动作词的 2 字搭配黑名单（十分/高兴/不行/行李/方法/瓶子…）——命中即跳过该字
      const prev1 = idx > 0 ? t[idx - 1] : "";
      if (ACTION_NON_VERB_BIGRAMS.has(prev1 + ch) || ACTION_NON_VERB_BIGRAMS.has(ch + next)) { idx += 1; continue; }
      // 动词后跟动态助词（推开门/端起了）
      if (next !== "" && DYNAMIC_PARTICLES.includes(next)) {
        actionCount++;
        // v3.5.0 #59：动补合并——"走出去/跑回来"的补语动词不单独计（推开+走+出去 → 2 个动作）
        if (next2 !== "" && ACTION_SET.has(next2)) idx += 3;
        else idx += 2;
        continue;
      }
      // 动词后直接跟名词性字符（直接宾语：她推门 / 端起碗）
      if (/[\u4e00-\u9fff]/.test(next) && !/[的了着过在是把被给跟从向对于和与以及就都也很又再]/.test(next)) {
        actionCount++;
        idx += 2;
        continue;
      }
      // v3.5.0 #59：句末/孤立动词也计（旧循环 < length-1 漏检末位动词；后接标点同样算句末）
      if (next === "" || /[。！？!?，、；：\s]/.test(next)) {
        actionCount++;
        idx++;
        continue;
      }
    }
    idx++;
  }
  const actionDensity = per1000(actionCount);

  // 5) 不确定性：模糊限制语
  // v3.7.0 引擎⑥：HEDGE 最长匹配（"像是要"不再计 像是×2+像是要×2；先长后短 + 占位）
  let hedgeCount = 0;
  const hedgeSorted = HEDGE_WORDS.slice().sort(function (x, y) { return y.length - x.length; });
  let hedgeText = t;
  for (const w of hedgeSorted) {
    let n = 0;
    let from = 0;
    while (true) {
      const hit = hedgeText.indexOf(w, from);
      if (hit === -1) break;
      n += 1;
      hedgeText = hedgeText.slice(0, hit) + "\u0000".repeat(w.length) + hedgeText.slice(hit + w.length);
      from = hit + w.length;
    }
    hedgeCount += n;
  }
  const hedgeDensity = per1000(hedgeCount);

  // 6) 留白指数：省略号/破折号 + 未完句比例
  const ellipsis = (t.match(/……/g) || []).length + (t.match(/\.\.\./g) || []).length;
  const dash = (t.match(/——/g) || []).length;
  // v3.5.0 #50b：未完句判定——省略号结尾或行内无句末标点；行末无标点（排版分行）视为完整句，不再虚高 gapIndex
  // v3.5.0 L1：顺序游标定位（重复/子串文本不再误判——"他走了。他走了\n"第二句正确豁免）
  let searchFrom = 0;
  const unfinished = sentences.filter(function (s) {
    const idxU = t.indexOf(s, searchFrom);
    if (idxU !== -1) searchFrom = idxU + s.length;
    if (/[……—…]$/.test(s)) return true;
    if (/[。！？!?]$/.test(s)) return false;
    if (idxU === -1) return true;
    const afterU = t[idxU + s.length];
    if (afterU === undefined || afterU === "\n" || afterU === "\r") return false;
    return true;
  }).length;
  // v4.0.0 修正：留白指数量纲统一为「每千字留白点数」——旧版把 per1000 的省略号/破折号密度与
  // 未完句百分比（unfinished/sentences*100，0~100 量级）直接相加，两项量纲不同、上限不可比
  // （15 字文本算出 222.22）；现与其余五维一样按千字归一。
  const gapDots = per1000(ellipsis * 2 + dash * 2);
  const unfinishedPer1000 = per1000(unfinished);

  return {
    metrics: {
      complexity: Math.round(complexity * 100) / 100,
      modifierDensity: Math.round(modifierDensity * 100) / 100,
      abstractDensity: Math.round(abstractDensity * 100) / 100,
      actionDensity: Math.round(actionDensity * 100) / 100,
      hedgeDensity: Math.round(hedgeDensity * 100) / 100,
      gapIndex: Math.round((gapDots + unfinishedPer1000) * 100) / 100
    },
    detail: {
      totalChars,
      sentenceCount: sentences.length,
      smallClauseTotal,
      adjMods,
      advMods,
      abstractCount,
      actionCount,
      hedgeCount,
      ellipsis,
      dash,
      unfinishedCount: unfinished
    }
  };
}

/** 六维标签（展示用）。 */
export const METRIC_LABELS = {
  complexity: "句法复杂度",
  modifierDensity: "修饰密度",
  abstractDensity: "抽象度",
  actionDensity: "动作密度",
  hedgeDensity: "不确定性",
  gapIndex: "留白指数"
};

/** 六维顺序。 */
export const METRIC_ORDER = ["complexity", "modifierDensity", "abstractDensity", "actionDensity", "hedgeDensity", "gapIndex"];

/**
 * 从每章测量值计算基线带（μ/σ）——style_report 用全部章，style_check 排除目标章后现算。
 */
export function computeBaselineFromPerChapter(perChapter, opts) {
  opts = opts || {};
  const minSigmaRatio = opts.minSigmaRatio ?? 0.15;
  const baseline = {};
  for (const key of METRIC_ORDER) {
    const values = (perChapter || []).map(function (c) { return c.metrics[key]; }).filter(function (v) { return typeof v === "number" && isFinite(v); });
    if (values.length === 0) {
      baseline[key] = { mu: 0, sigma: 0, low: 0, high: 0 };
      continue;
    }
    const mu = values.reduce(function (a, b) { return a + b; }, 0) / values.length;
    const variance = values.reduce(function (a, b) { return a + (b - mu) * (b - mu); }, 0) / values.length;
    let sigma = Math.sqrt(variance);
    // v4.3.0：区分「实测 σ」与「参与计算的钳制 σ」——旧版只返回钳制后的 sigma，
    // 展示层把 0.15μ 的下限当成"作者自身波动"念给用户（实测真实 σ=0.0084 被报成 0.15，
    // 相差 18 倍）；且默认 minSigmaRatio=0.15 使 recTol 的"下限 10%"永远不可达（1.5×0.15=22.5%→25）。
    // sigmaMeasured = 原始样本标准差；sigmaUsed = 钳制后用于 low/high/recTol 的值；
    // sigma = sigmaUsed（保持旧字段与既有断言兼容）；sigmaClamped 标记是否发生过钳制。
    const sigmaMeasured = sigma;
    // 最小 σ 下限：防小书（章节少/波动小）容差带过窄
    const minSigma = Math.max(mu * minSigmaRatio, mu === 0 ? 0 : 0.0001);
    sigma = Math.max(sigma, minSigma);
    const sigmaClamped = sigma > sigmaMeasured;
    // v3.0.0：推荐容差 = 作者自身章节波动的 1.5 倍 σ（相对 μ 的百分比，取整到 5，下限 10%、上限 100%）——未自定义时按此判定；mu=0 回退 15 防 NaN
    let recTol = 15;
    if (mu > 0) {
      recTol = Math.max(Math.round(((1.5 * sigma) / mu) * 100 / 5) * 5, 10);
      recTol = Math.min(recTol, 100);
    }
    baseline[key] = {
      mu: Math.round(mu * 100) / 100,
      sigma: Math.round(sigma * 100) / 100,
      sigmaMeasured: Math.round(sigmaMeasured * 1000) / 1000,
      sigmaUsed: Math.round(sigma * 100) / 100,
      sigmaClamped,
      low: Math.round((mu - sigma) * 100) / 100,
      high: Math.round((mu + sigma) * 100) / 100,
      recTol
    };
  }
  return baseline;
}

/**
 * 基线带：按章节测量 → 每维 μ/σ（含每章测量值 perChapter）。
 */
export function computeBaseline(chapters, opts) {
  opts = opts || {};
  const perChapter = [];
  for (const ch of chapters) {
    if (!ch || !ch.text || ch.text.trim().length < 40) continue;
    const m = measureStyleMetrics(ch.text).metrics;
    perChapter.push({ file: ch.file, metrics: m });
  }
  const baseline = computeBaselineFromPerChapter(perChapter, opts);
  return { baseline, perChapter, chapterCount: perChapter.length };
}

/**
 * 偏离判定：新章 vs 基线，输出每维偏差百分比（相对 μ）与判定。
 */
export function judgeAgainstBaseline(metrics, baseline, tolerance) {
  tolerance = tolerance || null;
  const verdicts = [];
  const outOfBand = [];
  const skippedDims = []; // v4.3.0：基线 μ=0、无法做相对判定的维度（不再静默丢弃）
  for (const key of METRIC_ORDER) {
    const b = baseline[key];
    const v = metrics[key];
    if (!b || typeof v !== "number") continue;
    // v4.3.0 修正（P1-3）：基线 μ=0 时旧版直接 continue —— 新章该维无论多离谱都不产生判定，
    // 而 summary 仍宣称"全部维度在容差带内 ✓"（实测 hedgeDensity/gapIndex 给到 50 也被完全忽略）。
    // 现改为：σ>0 时改用绝对尺度判定（|v| > 1.5σ → out）；其余登记进 skippedDims 并由 summary 披露。
    if (b.mu === 0) {
      const sd = typeof b.sigma === "number" && isFinite(b.sigma) ? b.sigma : 0;
      if (sd > 0 && Math.abs(v) > 1.5 * sd) {
        const absItem = {
          metric: key, label: METRIC_LABELS[key], mu: 0, value: v, devPct: null,
          sigma: Math.round((v / sd) * 10) / 10, tolerance: { low: 0, high: 0 },
          status: "out", basis: "absolute"
        };
        verdicts.push(absItem);
        outOfBand.push(absItem);
      } else {
        skippedDims.push({ metric: key, label: METRIC_LABELS[key], value: v, sigma: sd });
      }
      continue;
    }
    const devPct = Math.round(((v - b.mu) / b.mu) * 1000) / 10;
    // v3.0.0：默认用推荐容差（作者自身波动的 1.5σ），无推荐才回退 ±15%
    const recT = typeof b.recTol === "number" && isFinite(b.recTol) && b.recTol > 0 ? b.recTol : 15;
    // v4.0.0 修正：容差 0 语义——显式 0 表示"零容差"（严格，任何偏差都 out），只有缺失/null/空串/非有限值
    // 才回退推荐值。旧版 `Number(x) || -recT` 把 null 也当 0，单侧缺失时那一侧变成 0 → 任何微偏都判 out。
    const tolSide = (raw, fallback) => {
      if (raw === void 0 || raw === null || raw === "") return fallback;
      const num = Number(raw);
      return Number.isFinite(num) ? num : fallback;
    };
    const tol = tolerance && tolerance[key]
      ? { low: tolSide(tolerance[key].low, -recT), high: tolSide(tolerance[key].high, recT) }
      : { low: -recT, high: recT };
    const sigmaDist = b.sigma > 0 ? (v - b.mu) / b.sigma : 0;
    const status = devPct < tol.low || devPct > tol.high ? "out" : (devPct < tol.low / 2 || devPct > tol.high / 2) ? "warn" : "ok";
    verdicts.push({ metric: key, label: METRIC_LABELS[key], mu: b.mu, value: v, devPct, sigma: Math.round(sigmaDist * 10) / 10, tolerance: tol, status });
    if (status === "out") outOfBand.push(verdicts[verdicts.length - 1]);
  }
  // v4.3.0：summary 必须把"被跳过的维度"说清楚，不能一边跳过一边宣称"全部维度在容差带内 ✓"
  const skippedNote = skippedDims.length === 0
    ? ""
    : "；另有 " + skippedDims.length + " 个维度基线均值为 0、未做相对判定（" + skippedDims.map((s) => s.label).join("、") + "）";
  return {
    verdicts,
    outOfBand,
    outCount: outOfBand.length,
    skippedDims,
    summary: (outOfBand.length === 0
      ? (skippedDims.length === 0 ? "全部维度在容差带内 ✓" : "无维度超出容差带")
      : outOfBand.length + " 个维度超出容差带，需修正") + skippedNote
  };
}