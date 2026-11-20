/**
 * v3.0.0 文笔六维测量（style-metrics.js）——用户提出的六维量化指标
 * 句法复杂度 / 抽象度 / 动作密度 / 不确定性 / 修饰密度 / 留白指数
 *
 * v7.0.0 抽象度（abstractDensity）精度修正——**只动抽象度一维**，其余五维口径不变：
 *   旧版把三类"非抽象"的东西当成抽象名词计入，实测证据（真实语料）：
 *     ① 「XX道」对话标签被当抽象词：'沈砚摇头道：“不去。”林晚冷笑道：“由不得你。”掌柜低声道：…'
 *        → abstractDensity = 97.56（参照集 p95 仅 11.51，等于 8.5 倍）——100% 具象的对话动作句；
 *     ② 具象感知词被当抽象词：'他摸着刀柄，粗糙的手感和冰凉的触感让他清醒。' → 90.91，
 *        而「手感/触感」恰恰是本插件处方要求模型**多写**的具象词，计入抽象度等于自相矛盾；
 *     ③ 4 字窗口只查了第 1、第 2 个字，第 3 个字是停用字时挡不住（见 countAbstractWords）。
 *   定点修正（不推翻 suffix 集、不改量纲）：① 「…道」尾词改按**白名单反转**判定
 *   （对话标签/具象路名默认不计，只放行 DAO_ABSTRACT_KEEP 里登记的真抽象「X道」与「…之道」成语，
 *    判据与取舍见 isNonAbstractDao 注释）；② 具象感知词（手感/触感/温度…）停用；
 *   ③ 4 字窗口补查第 3 个字。三项都不改「4→3→2 贪婪滑窗 + 区间消费」的骨架。
 *   ⚠ 口径提示：同一章的新旧 abstractDensity **数值会变化（整体下降）**，跨版本**不可直接比较**；
 *   历史风格报告里的抽象度基线需重算后才能与 v7.0.0 之后的章节同带判定。
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
// v7.0.x（审查 #46）：动作计数与 analysis.densityOf 共用同一张上下文豁免表（单一事实源）。
// 该模块零依赖，不会与 analysis.js 形成循环。
import { guardRanges, inRanges } from "./lexicons/collocation-guards.js";

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
//   "不行，我不能去。"=1（行），全部是误计。去重清洗后保留 553 条。
// 行为变化：动作密度 actionDensity / actionCount 数值下降（形容词/名词句不再虚高），
// 同一本书新旧风格报告不可直接比较。
// v6.2.1（清单 #39）：同类性质形容词（香/甜/苦/辣/咸/腻/浓…）不再逐条删，改由 measureStyleMetrics
//   动作扫描处的「程度副词 + 单字」统一规则排除（"味道很香。"=0，与"他很胖。"=0 同口径）。
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
  "烙", "煨", "炖", "焖", "熬", "烹", "调", "拌", "搅",
  "团", "发", "烂", "腐", "朽",
  "肿", "胀", "鼓", "瘪", "皱",
  "霸", "欺", "榨", "剥", "削", "掠", "夺", "抢", "劫", "偷",
  "盗", "窃", "扒", "掏", "搜", "查", "寻", "找", "觅", "探",
  "索", "究", "研", "讨", "论", "议", "评", "判", "审", "核",
  "验", "证", "试", "测", "量", "计", "算", "析", "归", "纳",
  "辩", "驳", "争", "吵", "闹", "斗", "殴", "拼", "搏", "挣",
  "抗", "抵", "防", "守", "卫", "护", "保", "救", "援", "助",
  "帮", "扶", "领", "导", "指", "引", "教", "训", "培", "锻",
  "磨", "砺", "激", "励", "振", "奋", "感", "惊", "慨", "唏",
  "嘘", "呜", "啜", "泣", "哽", "窒", "憋", "闷", "慌", "躁",
  "烦", "恼", "怒", "愤", "憎", "恶", "厌", "嫌",
  "弃", "鄙", "蔑", "轻", "珍", "爱", "惜", "怜", "悯", "疼",
  "宠", "溺", "娇", "惯", "纵", "容", "包", "庇", "袒", "呵",
  "佑", "祝", "福", "祈", "祷", "祭", "祀", "拜", "念", "诵",
  "咏", "吟", "唱", "歌", "舞", "蹈", "旋", "滚", "滑", "溜",
  "窜", "遁", "隐", "匿", "伏", "悟", "参", "禅", "定", "成",
  "化", "存", "拥", "具", "获", "取", "博", "谋",
  "求", "愿", "确", "决", "选", "挑", "拣", "筛", "甄", "辨",
  "划", "派", "颁", "授", "予", "赠", "托", "委", "信", "任",
  "依", "凭", "仗", "恃", "盼", "期", "渴", "奢", "妄", "幻",
  "理", "构", "揣", "猜", "预", "料", "征", "卖"
];

/**
 * v4.3.0：单字动作词的常见非动词搭配黑名单（2 字窗口命中即不计）。
 * 单字表仅收真动词后，这里保留含在表字（定/判/理/成/化/发/算/计/合/作…）的非动作固定词，
 * 避免"一定/肯定/镇定/固定/稳定"等副词/形容词被误计为动作。
 */
const ACTION_NON_VERB_BIGRAMS = new Set([
  "镇定", "一定", "肯定", "必定", "固定", "稳定", "特定", "决定", "规定", "注定"
]);
// v7.0.x（审查 #46）：上面这张本地表只保留「定/判」等**公共豁免表里没有**的搭配。
// 「直接/关系/开心/开始/离开/一点…」改由 collocation-guards 的 action 通道统一豁免——
// 旧版六维动作计数没接公共表，实测「他直接走了。」=2、「关系很好。」=1、「他很开心。」=1，
// 与 analysis.densityOf 的同名量口径分裂（同一段文本两处报不同的动作密度）。
// 行为变化：actionCount / actionDensity **下降**；同一本书新旧风格报告不可直接比较，
// 历史动作维度基线需用新尺子重算（与 v7.0.0 抽象度修正同类）。


// 动态助词（动词后出现 → 动作完成/进行，常见于动作描写）
const DYNAMIC_PARTICLES = "了着过起住上下进出开完掉得";

const ACTION_SET = new Set(ACTION_VERBS);

/** 切句：按句末标点切分。 */
// v4.3.0：结束符类由 analysis.js 的 TERMINATORS 派生（口径统一，见文件头说明）
const TERM_CLASS = "[" + TERMINATORS.replace(/[\\\]]/g, "\\$&") + "]";
const SENTENCE_SPLIT_RE = new RegExp("(?<=" + TERM_CLASS + ")(?!" + TERM_CLASS + ")\\s*|\\n+");
const TAIL_QUOTE_RE = /[”」』’\"']+$/;
// v6.2.1 修正（清单 #37）：纯标点残片只认真正的句末符（。！？!?）。
// 旧版用 TERM_CLASS（含 "…"）构造，于是"……"被当残片丢弃，与本文件「纯省略号句保留」的注释
// 完全相反，也与 analysis.js 的 splitSentences 口径相反
// （实测 measureStyleMetrics("……") → sentenceCount=0，analysis 侧=1）。
const PURE_TERM_RE = new RegExp("^[" + TERMINATORS.replace(/[…]/g, "").replace(/[\\\]]/g, "\\$&") + "]+$");
function splitSentences(text) {
  // v3.5.0 #50b：标点切句 + 无标点换行也切（逐行排版正确分句）；未完句判定按"行末豁免"处理（见 measureStyleMetrics）
  // v3.5.0 H3：句末标点后吞闭合引号（"她说：\u201c走吧。\u201d" 不再切成孤儿引号句）
  // v3.9.1 #1：句末符后若紧跟句末符则不切（太好了！！！/真的？？/他哭了。。。不再拆出孤立标点残片）
  return String(text)
    // v6.3.0（独立校验）：分句前先归一行尾——CRLF / CR → LF，并去掉行尾空白。
    // 否则「行尾闭引号 + 空白 + 换行」这类中文网文对话行会多切出一段：实测同一内容
    // measureStyleMetrics 的 sentenceCount 为 LF=2 / CRLF=3 / 行尾三空格=3，而未完成句与
    // 缺口指数由句数派生；analysis.splitSentences 与 analyzeText.totalSentences 三态都是 2
    //（同一份代码里两个句数计数器打架）。归一行尾后四态恒等。
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+(?=\n|$)/g, "")
    .split(SENTENCE_SPLIT_RE)
    .map(function (s) { return s.replace(TAIL_QUOTE_RE, "").trim(); })
    // 纯句末标点残片（！！！/？？/。。。）丢弃；纯省略号句（"……"）保留（PURE_TERM_RE 已排除 "…"，见上）
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
  "土地", "原地", "当地", "墓地", "产地", "场地", "落地", "阵地", "田地", "旱地", "湿地", "耕地", "草地", "雪地", "山地", "坡地",
  "林地", "园地", "荒地", "宝地", "圣地", "禁地", "腹地", "属地", "领地", "封地", "外地", "洼地", "谷地", "泥地",
  "大地", "平地", "内地", "各地", "两地", "目的地"
]);
// v6.2.1 修正（清单 #44）：移除误收的副词项 特地/遍地/满地——「X地」正是状语结构，
// 被当名词词素排除后"他特地赶来。/遍地都是血。/满地都是水。"advMods 全为 0，
// 而"他蓦地回头。/他缓缓地走。"同为 1，同一结构只因词表误收就一计一不计。
/** 以"地"开头的名词（命中串之后的两个字）——命中即不算 X地 状语。 */
const DI_NOUN_AFTER = new Set([
  "地上", "地下", "地方", "地面", "地区", "地位", "地铁", "地图", "地板", "地道", "地理", "地球", "地域", "地点", "地址", "地层"
]);

// v4.3.0：修饰密度两张停用词表——"的"作为词尾（真的/似的）或词首（的确）时都不是修饰助词。
// 用 matchAll 取真实下标，对"的"前后各 2 字判定；旧版只有 (?<!目)(?<!的) 两个 lookbehind，
// 拦不住"的确"（的在前）与"真的/似的"（的是词尾），实测 adjMods 虚高 1~2。
const DE_FALSE_TAIL = new Set(["真的", "似的", "目的", "有的", "是的"]);
const REAL_MODIFIER_BEFORE_ZHENDE = /[天认纯逼清当写真]/;
const REAL_MODIFIER_BEFORE_YOUDE = /[所原特罕独应既仅固共私公少稀惟唯]/;
// v6.2.1 注释修正（清单 #47）：举例对齐集合——只有"的确/的士"两条（"的的/的话"刻意不在集合里，
// 见上一行：它们在"梦中的场景/他的话很多"里都是真修饰助词）。
const DE_FALSE_HEAD = new Set(["的确", "的士"]);
const MODIFIER_DE_RE = /[\u4e00-\u9fff]{1,3}(?<!目)(?<!的)的/g;

/** 修饰密度①：X的（1-3 字修饰语 + 的），带 2 字停用词排除（保留"天真的/认真的/所有的/原有的"等三字真修饰语）。 */
function countModifierDe(text) {
  let n = 0;
  for (const m of text.matchAll(MODIFIER_DE_RE)) {
    const end = m.index + m[0].length;              // "的"之后的位置
    const tail2 = text.slice(end - 2, end);
    if (DE_FALSE_TAIL.has(tail2)) {
      const prevChar = end >= 3 ? text[end - 3] : "";
      const isRealZhende = tail2 === "真的" && REAL_MODIFIER_BEFORE_ZHENDE.test(prevChar);
      const isRealYoude = tail2 === "有的" && REAL_MODIFIER_BEFORE_YOUDE.test(prevChar);
      if (!isRealZhende && !isRealYoude) continue; // 真的/似的/目的…（的为词尾，且非三字修饰词）
    }
    if (DE_FALSE_HEAD.has(text.slice(end - 1, end + 1))) continue; // 的确/的士…（的为词首）
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
/**
 * v7.0.0：**具象感知词**停用表（末字「感」「度」，但不是抽象名词）。
 *
 * 为什么这些词必须豁免：它们是本插件的**处方本身**要求模型多写的东西——
 * 「多写手感、触感、温度、力度」之类的具象感知描写是降低 AI 味、提高画面感的核心手法，
 * 而抽象度这一维的设计意图恰恰是「越低越好」。若把处方要求多写的词算成"抽象"，尺子就
 * 与处方**自相矛盾**：模型照做 → 抽象度反而升高 → 被判偏离基线 → 又被要求少写具象词。
 * 实测：'他摸着刀柄，粗糙的手感和冰凉的触感让他清醒。' 旧版 90.91（全句 100% 具象）。
 *
 * 取舍：只登记 2 字定名词形（手感/触感…），**不整类豁免「X感」「X度」**——
 * 「预感/痛感意义上的"感觉"/孤独感/存在感/虚无感/可信度/复杂度」等真抽象词必须照旧计入
 * （见 test/abstract-precision-test.mjs 的「预感」断言），否则抽象度会失聪。
 */
const ABSTRACT_SENSORY_STOP = new Set([
  "手感", "触感", "质感", "痛感", "凉感", "光感", "口感", "体感",
  "温度", "速度", "角度", "力度", "厚度", "硬度", "亮度", "湿度"
]);
const ABSTRACT_STOP = new Set([
  "知道", "味道", "街道", "事情", "睡觉", "地道", "门道", "过道", "生意", "注意",
  "天空", "半空", "夜空", "星空", "晴空", "高空", "空气", "空间", "空地", "空白", "空隙",
  "办法", "方法", "做法", "说法", "写法", "活法", "算法", "魔法", "阵法", "剑法", "刀法", "身法", "步法", "功法",
  "整理", "清理", "处理", "料理", "修理", "打理", "护理", "地理", "物理",
  "写信", "书信", "来信", "回信", "信封", "信件", "短信", "微信", "音信", "口信", "报信", "送信",
  "认真", "天真", "当真", "纯真", "逼真", "写真", "失真", "清真",
  "美女", "美人", "美景", "美食", "美酒", "美味", "美丽", "美貌", "完美", "赞美", "优美", "甜美",
  "醒来", "清醒", "苏醒", "惊醒", "吵醒", "叫醒", "提醒", "睡醒",
  "午觉", "发觉", "察觉",
  "做梦", "睡梦",
  "救命", "活命", "拼命", "性命", "人命", "命令", "待命", "遵命", "致命", "亡命", "逃命", "算命", "寿命",
  "好运", "搬运", "运输", "货运", "运动", "运气",
  "张望", "探望", "看望", "仰望", "眺望", "观望", "回望",
  "变成", "融化", "消化", "化妆", "化解", "化石", "化学", "火化", "冰化",
  "灵活", "灵敏", "机灵", "失灵", "水灵"
]);
const CHINESE_ONLY_RE = /^[\u4e00-\u9fff]+$/;
// 代词、副词、介词、连词、助词及高频动作单字不得作为抽象词词首（排除"他很想/她醒/走到半空/这办法/真美/不想/只觉"等跨词伪命中）
const ABSTRACT_BAD_HEAD_RE = /^[他她我你它这那哪谁很太真好更最极挺甚不没别莫都也又还只就才刚正在从向往到给被把让叫对于和与及或但而却虽因为着了过的地得去来走跑看听说做拿坐站躺]/;

/**
 * v7.0.0：「道」的判据——**白名单反转**（本处是全文件唯一有取舍的地方，理由与代价写在这里）。
 *
 * 问题：`ABSTRACT_SUFFIXES` 里有「道」，而 countAbstractWords 是 4→3→2 字贪婪滑窗、只看末字。
 * 于是「摇头道 / 冷笑道 / 低声道 / 沉声道 / 淡淡道 / 接口道 / 答道 / 问道」这些**对话引入标记**
 * （语法功能≈英文 said，语义接近 0）全被算成抽象名词。实测：
 *   '沈砚摇头道：“不去。”林晚冷笑道：“由不得你。”掌柜低声道：“小心山道上的刀客。”'
 *   → abstractDensity = 97.56，参照集 p95 才 11.51（8.5 倍）——这是一段 100% 具象的动作句。
 *
 * 为什么不采用「后接 ：/“ 才豁免」这一条最直觉的判据（它看起来最稳，实际有洞）：
 *   1) 贪婪窗口会**从对话标签中间起步**：'“不去。”沈砚摇头道。' 里 4 字窗 "砚摇头道" 被豁免后，
 *      下一轮滑窗落在 "头道"（"摇头道" 的后两字）上，后面跟的是句号而不是冒号 → 仍然计 1。
 *      而中文网文里**后置标签**（引语在前、XX道 在后，跟句号/叹号）极其常见，
 *      所以"标点判据"只修得好冒号前置形态，修不好同类的后置形态（实测本仓库语料即如此）。
 *   2) 它管不住"山道 / 栈道 / 一道走 / 三道工序"这些具象与数量用法（要靠另一张停用表逐个补）。
 * 为什么不建对话动词白名单：中文说话动词是开放集（喃喃/咕哝/喟然/哂道/接口…），白名单必漏且越养越肥。
 *
 * 采用的判据：**末字为「道」的词默认不计，只有登记在下面这张封闭表里的真抽象「X道」照计**。
 *   语言学依据：抽象义的「道」（天道/大道/正道…）是**封闭小类**，可以穷举；
 *   而对话标记「XX道」与具象路名「山道/栈道/隧道」是**开放类**，穷举不了。
 *   方向必须反过来，才能一次兜住三类：标签、路名、以及"贪婪窗口切出的两字残片（头道/声道/了道）"。
 *   附带收益：「一道走 / 三道工序」这类数量词误计也一并消失。
 *
 * 代价（明知而为，接受）：**未登记的抽象「X道」（如 武士道 / 明道 / 黑道）会漏计**。
 *   所以这张表要按"词表即文档"维护——书里出现新的抽象「X道」，登记进来即可；
 *   test/abstract-precision-test.mjs 用 天道/大道/中庸之道 三条正向断言锚住它，改表就会红。
 *   「…之道」四字成语（中庸之道/处世之道/为官之道/生财…之道）无条件照计，不受本表影响。
 *   刻意**不**删 `ABSTRACT_SUFFIXES` 里的「道」：删后缀会把 天道/大道 一起弄丢，
 *   而且这张白名单就无从依附（现在它只影响「道」尾词，其余后缀的判定一个字都没动）。
 */
const DAO_ABSTRACT_KEEP = new Set([
  "天道", "大道", "王道", "霸道", "正道", "邪道", "魔道", "仙道", "佛道", "人道", "医道",
  "剑道", "武道", "世道", "公道", "常道", "仁道", "师道", "孝道", "妇道", "茶道", "花道",
  "书道", "商道"
]);
const DAO_IDIOM_TAIL_RE = /之道$/;
function isNonAbstractDao(word) {
  if (word.length === 0 || word[word.length - 1] !== "道") return false;
  if (DAO_IDIOM_TAIL_RE.test(word)) return false;  // 中庸之道 / 处世之道：真抽象，照计
  if (DAO_ABSTRACT_KEEP.has(word)) return false;   // 天道 / 大道 / 世道：真抽象，照计
  return true;                                     // 其余「…道」：标签 / 路名 / 残片，不计
}

/**
 * v4.3.0：抽象度计数——逐位「最长匹配 + 区间消费」，4→3→2 字优先。
 * 旧版正则尾部 `(?![\u4e00-\u9fff])` 要求抽象词后必须是非汉字，
 * 于是"她的感情很深。"=0 而"她的感情，很深。"=1，同一词只因后随标点不同而一计一不计；
 * 且 `{1,2}` 上限使 3-4 字抽象词（责任感/存在主义…）永不命中。
 * 已知取舍：相邻两个抽象词若被一个跨词窗口吞并（"感情和理性"），历史上会计为 1 个；
 * v7.0.0 补查 4 字窗口第 3 个字后，这类"中间夹停用字"的情形多数已恢复为 2 个
 * （实测 '感情和理性在他心里打架。' 旧 1 → 新 2），但滑窗本身仍是启发式，不保证分词正确。
 *
 * v7.0.0（定点修正，量纲不变）：仍是 4→3→2 字贪婪滑窗 + 区间消费，只加三处判定：
 *   ① 4 字窗口补查第 3 个字（旧版只查 w[0]、len>=3 时的 w[1]）——否则「X X 停用字 X」
 *      会整窗误命中（如 '痛苦和孤独感' 的 "痛苦和孤"、'真正的情感' 的 "真正的情"），
 *      而且 4 字整窗消费还会**吃掉**它后面本来能正确命中的真抽象词；
 *   ② 「…道」尾词按白名单反转判定（isNonAbstractDao，判据与取舍见上）；
 *   ③ 具象感知词（手感/触感/温度…）停用——它们是处方要求多写的词。
 *   ⚠ 同一段文本的新旧 abstractCount/abstractDensity **数值会变化（整体下降）**，
 *   跨版本**不可直接比较**；历史报告基线要重算。
 */
function countAbstractWords(text) {
  const consumed = new Uint8Array(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (consumed[i] === 1) continue;
    if (ABSTRACT_BAD_HEAD_RE.test(text[i])) continue;
    let hitLen = 0;
    for (const len of [4, 3, 2]) {
      if (i + len > text.length) continue;
      const w = text.slice(i, i + len);
      if (!CHINESE_ONLY_RE.test(w)) continue;
      if (!ABSTRACT_SUFFIX_SET.has(w[w.length - 1])) continue;
      if (len >= 3 && ABSTRACT_BAD_HEAD_RE.test(w[1])) continue;
      // v7.0.0 ①：4 字窗口的**第 3 个字**同样要挡（停用字/代词/副词/助词夹在词中，整窗就不是词）
      if (len >= 4 && ABSTRACT_BAD_HEAD_RE.test(w[2])) continue;
      // v7.0.0 ③：具象感知词（处方本身要求模型多写的词）——整词与其末两字都查
      if (ABSTRACT_SENSORY_STOP.has(w) || ABSTRACT_SENSORY_STOP.has(w.slice(-2))) continue;
      if (ABSTRACT_STOP.has(w) || ABSTRACT_STOP.has(w.slice(-2))) continue;
      // v7.0.0 ②：「…道」默认不是抽象名词（对话标签/具象路名/窗口残片），只放行白名单
      if (isNonAbstractDao(w)) continue;
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
  const t = String(text ?? "").replace(/^#{1,6}[ \t]+[^\n]*\n?/gm, "")
    // v6.3.0（独立校验）：换行风格归一（CRLF / CR → LF）。否则同一内容用 CRLF 会多算字符
    // （每行多一个 \r），而每千字类指标（修饰密度 / 动作密度 / 留白指数…）都按 totalChars 归一，
    // 于是同一段正文的六维报告会随「文件是 LF 还是 CRLF」漂移。
    .replace(/\r\n?/g, "\n");
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
  //   ② 以"的"开头的整词（的确/的士…）→ 该"的"是词首，不是修饰助词。
  //   刻意不收"中的/的话"——它们在"梦中的场景""他的话很多"里都是真修饰助词，收了会漏计。
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
  // v7.0.0 精度修正：「…道」尾词改白名单反转判定（对话标签/路名/窗口残片不计）、
  //   具象感知词（手感/触感/温度…）停用、4 字窗口补查第 3 个字
  //   （详见 countAbstractWords 与 isNonAbstractDao 的注释）。
  //   量纲仍是 count / totalChars * 1000（保留两位小数），但**同一章新旧数值不同（下降）**——
  //   v7.0.0 之前算出的抽象度基线与本章不可同带比较，需用新尺子重算历史章节。
  const abstractCount = countAbstractWords(t);
  const abstractDensity = per1000(abstractCount);

  // 4) 动作密度：动作动词 + 动态助词/宾语模式
  // v7.0.x（审查 #46）：先把 action 通道的**上下文豁免区间**切出来，再逐字计数——
  // 与 analysis.densityOf 的「matchAll + inRanges」是同一判据、同一张表（collocation-guards），
  // 区别只在于本处是状态机扫描（要处理"动词+动态助词/宾语"的合并），所以按位置查区间。
  // 六维里只有动作一路用到这张表；物件/感官两路在 analysis.densityOf 里，早已接入同一豁免层。
  const actionGuards = guardRanges(t, "action");
  let actionCount = 0;
  let idx = 0;
  while (idx < t.length) {
    const ch = t[idx];
    if (ACTION_SET.has(ch) && !inRanges(actionGuards, idx)) {
      const next = idx + 1 < t.length ? t[idx + 1] : "";
      const next2 = idx + 2 < t.length ? t[idx + 2] : "";
      // v4.3.0：单字动作词的 2 字搭配黑名单（十分/高兴/不行/行李/方法/瓶子…）——命中即跳过该字
      const prev1 = idx > 0 ? t[idx - 1] : "";
      const prev2 = idx > 1 ? t[idx - 2] + prev1 : "";
      if (ACTION_NON_VERB_BIGRAMS.has(prev1 + ch) || ACTION_NON_VERB_BIGRAMS.has(ch + next)) { idx += 1; continue; }
      // v6.2.1 修正（清单 #39）：程度副词后的单字**性质形容词**不算动作——"味道很香。/他很胖。"
      // 同一句式此前一计一不计（当时 香/甜/苦/辣/咸/腻/浓… 还在 ACTION_VERBS 里，v4.3.0 起已移出）。
      // 这是系统性规则，替代逐条删词。
      // v6.3.0 修正（独立校验 R2）：**不能豁免程度副词后的任何单字**——旧写法把「他真看不下去了 /
      // 他想多看一眼」里的真动词一起吃掉，并与 analysis.densityOf 的计数口径打架（同一「动作密度」
      // 在句式报告与风格报告给出 0 与 1）。改为只豁免下面这张性质形容词表（含双字程度副词）。
      // v7.3.1 修（#30）：豁免表只剩「破」——它是 ACTION_SET 里**唯一**还会被程度副词前置的性质形容词。
      // 旧版这里列了 25 字（香胖甜苦辣咸酸腻浓淡软硬湿干冷热暖亮暗新旧破乱脆嫩），注释还称
      // 它们「仍在 ACTION_VERBS 里」；而那张表 v4.3.0 起只收真动词，其余 24 字早已移出，
      // 外层 `ACTION_SET.has(ch)` 先把它们挡掉了 → 那 24 字的豁免分支不可达（注释与实现相反）。
      // 为什么选「只留有效字 + 改注释」而不是「把 24 字重新纳入 ACTION_SET」：那 24 字是形容词/状态字，
      // 重新计入动作会把「味道很香」算成一个动作——正是 v6.2.1（审查 #39）要修的反向病。
      if ((/[很太挺好真极甚十非多么]/.test(prev1) || /^(?:十分|非常|格外|无比|有点|有些|极其|极为|分外|特别|相当|略微)$/.test(prev2)) &&
        "破".includes(ch)) { idx += 1; continue; }
      // 动词后跟动态助词（推开门/端起了）
      if (next !== "" && DYNAMIC_PARTICLES.includes(next)) {
        actionCount++;
        // v3.5.0 #59：动补合并——"走出去/跑回来"的补语动词不单独计（推开+走+出去 → 2 个动作）
        if (next2 !== "" && ACTION_SET.has(next2)) idx += 3;
        else idx += 2;
        continue;
      }
      // 动词后跟名词性宾语或方位/处置介词（她推门 / 坐在椅子上 / 把门推开）
      // 排除结构助词「的」、判断词「是」、否定词「不/没」及副词「很/太/真/更/最/也/又/再/都/就」
      if (/[\u4e00-\u9fff]/.test(next) && !/[的是不没很太真更最也又再都就]/.test(next)) {
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
  // v6.2.1 修正（清单 #36）：原实现用 t.indexOf(s) 回原文找切句后的串，而 splitSentences 已把
  // 闭合引号去掉 / trim 过，带引号的对话句**恒搜不到**（idxU=-1 → 直接 return true 算未完句），
  // 后面的"行末豁免"永远走不到；同时"下一字符"取到的是被去掉的引号/空白而非换行。
  // 两步一起坏的结果：中文网文对话行普遍以 "”"/"」" 收尾且不带句号 → 留白指数被系统性推高，
  // 且同一内容因 LF/CRLF、行尾空白给出不同数值（实测 LF → u=1/gap=90.91，CRLF → 0/0）。
  // 现改为：先按「可选闭引号 + 空白」宽松定位（找不到再退回精确 indexOf），跳过被 splitSentences
  // 丢掉的尾随引号与空白后再判行末。
  let searchFrom = 0;
  const unfinished = sentences.filter(function (s) {
    let cursor = t.indexOf(s, searchFrom);
    if (cursor === -1) cursor = t.indexOf(s); // 非顺序出现（重复/子串）时的兜底
    if (cursor !== -1) searchFrom = cursor + s.length;
    // v7.3.3 修（#19）：省略号口径与上面的 `ellipsis` 计数对齐——ASCII 三连点 `...` 同样算「省略号结尾=未完句」。
    // 旧判据只认全角「……」与破折号，而 `ellipsis` 把 `...` 也计了 1 处：同一句话的「留白点数」记了一笔、
    // 「未完句」却记 0，gapIndex 少算一半。中文小说里作者常把省略号打成 `...`（且句末没有别的句末符），
    // 读者读到的就是同一个悬停/留白，故统一**认** `...`，而不是反过来把它从省略号计数里删掉
    // （删掉会让「...」写法的留白整段不被计量，属于漏报）。
    if (/(?:[…—]|\.\.\.)$/.test(s)) return true;
    if (/[。！？!?]$/.test(s)) return false;
    if (cursor === -1) return true;
    // v6.2.1 修正（清单 #36）：旧版取 t[idxU + s.length] 这个**单字符**判定"行末"，
    // 而 s 已被 TAIL_QUOTE_RE 去掉尾部引号并 trim，取到的往往是被去掉的闭合引号或空白而非换行，
    // 行末豁免因此形同虚设：中文网文对话行普遍以 "”"/"」" 收尾且不带句号 →
    // 留白指数被系统性推高，且同一内容因 LF/CRLF、行尾空白给出不同数值
    //（实测 LF"“你回来了”\n他走了。"→u=1，同内容 CRLF→u=0，行尾加空格→u=1）。
    // 现改为：把 s 之后到行尾之间只含「闭合引号/空白」记为行末完整句；
    // 只剥**行尾**的引号与空白（不能用 /^[\s…]*/ 前缀剥离——\s 会把换行本身吃掉，
    // 也不能全串剔引号——否则"“你回来了”\n他走了。"里被误排除的 '”' 会让人以为已到行末）。
    const rest = t.slice(cursor + s.length);
    const lineRest = rest.replace(/[\r\n][\s\S]*$/, "");
    if (lineRest.replace(/[\s”」』’"']+$/, "") === "") return false;
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

/** v7.5.0：场景分带枚举、展示标签与同带成组门槛。 */
export const SCENE_BANDS = Object.freeze(["dialogue", "action", "narrative"]);
export const SCENE_BAND_LABELS = Object.freeze({
  dialogue: "对话文戏",
  action: "动作冲突",
  narrative: "叙事过渡"
});
export const MIN_SCENE_BAND_CHAPTERS = 3;

const CONFLICT_COMPOUNDS = [
  // 搏杀/攻击/防御/武器招式
  "格挡", "招架", "闪避", "闪躲", "闪身", "侧身", "翻滚", "打滚", "滚开", "滚落", "跃起", "纵身", "凌空", "俯冲", "翻身", "扑上", "扑来", "扑倒", "扑向",
  "冲来", "冲进", "冲出", "冲杀", "疾冲", "突围", "突袭", "偷袭", "伏击", "围攻", "夹击", "包抄", "截杀", "反击", "反杀", "反手", "横扫", "横斩",
  "飞脚", "飞踹", "猛踹", "踹开", "踹倒", "踹飞", "踢中", "踢倒", "踢翻", "踢起", "猛刺", "反刺", "刺中", "猛劈", "劈断", "劈开", "劈中", "猛砍", "砍断", "砍来", "挥刀", "挥剑", "挥斧", "挥拳", "挥棍",
  "拔剑", "拔刀", "抽刀", "出剑", "出拳", "出掌", "出招", "拔枪", "开枪", "开火", "射击", "扫射", "点射", "狙击", "交火", "火拼", "枪战", "枪声", "子弹", "弹幕", "掩体",
  "猛砸", "砸向", "砸开", "砸倒", "砸碎", "猛撞", "撞翻", "撞开", "撞破", "撞倒", "撞击", "冲撞", "掀翻", "扫倒", "放倒", "按倒", "压制", "制伏", "擒住", "扼住", "勒住", "锁喉", "扭打", "撕扯",
  "割断", "斩断", "斩杀", "格杀", "绞杀", "劈杀", "击飞", "击退", "击中", "击倒", "击碎", "震飞", "震退", "逼退", "夺刀", "夺剑", "夺枪", "甩开", "甩出", "挣脱", "掷出", "挑飞",
  "缠斗", "厮杀", "激战", "血战", "巷战", "混战", "肉搏", "搏斗", "搏命", "拼杀", "死战", "决战", "交手", "交锋", "过招", "对轰", "对拼", "硬拼", "格斗",
  "追击", "追杀", "追逐", "紧追", "逃窜", "狂奔", "奔逃", "逃命", "逃跑", "翻墙", "跃过", "跃上", "跃下", "潜行", "躲避", "躲开", "避过", "急刹", "甩尾", "轰击",
  "爆炸", "爆破", "炸裂", "爆裂", "崩塌", "坍塌", "轰鸣", "轰然", "火星四溅", "鲜血", "溅血", "吐血", "流血", "血泊", "重伤", "负伤", "剧痛", "闷哼", "痛哼", "踉跄", "倒飞", "坠落", "飞矢", "暗器", "短匕", "匕首", "长剑", "长枪", "斧刃", "利刃", "刀锋", "剑锋", "刀光", "剑影"
];
const CONFLICT_COMPOUNDS_SORTED = [...new Set(CONFLICT_COMPOUNDS)].sort((a, b) => b.length - a.length);
const CONFLICT_SINGLE = new Set(["劈", "斩", "刺", "砍", "捅", "踹", "砸", "搏", "厮", "擒", "掷", "踢", "跃", "扑", "轰", "炸", "杀", "袭"]);
const CONFLICT_SINGLE_EXCL_RE = /打算|打听|打扫|打开|刺激|讽刺|鱼刺|木刺|刺眼|刺骨|刺耳|刺鼻|刺痛|冷刺|刺绣|刺身|刺猬|杀青|杀菌|杀毒|杀价|杀虫|抹杀|笑杀|气杀|轰动|轰趴|劈头盖脸|跃然|跳跃|雀跃|扑鼻|扑面|扑朔|扑克|扑通|炸鸡|油炸|炸酱|砍价|斩钉截铁|踢球|踢毽/g;

/**
 * 统计高强度冲突/打斗/追逃词汇密度（每千字权重）及短句快节奏指标，用于动作冲突带判别（与日常动词解耦）。
 */
export function measureConflictSignals(text) {
  const raw = String(text ?? "");
  const clean = raw.replace(/\s+/g, "");
  if (clean.length === 0) {
    return {
      conflictDensity: 0,
      conflictHits: 0,
      avgSentenceChars: 0,
      shortClauseRatio: 0,
      exclamDensity: 0,
      fastPaced: false
    };
  }
  let masked = clean;
  let conflictHits = 0;
  for (const w of CONFLICT_COMPOUNDS_SORTED) {
    let from = 0;
    while (true) {
      const hit = masked.indexOf(w, from);
      if (hit === -1) break;
      conflictHits += 2;
      masked = masked.slice(0, hit) + "\u0000".repeat(w.length) + masked.slice(hit + w.length);
      from = hit + w.length;
    }
  }
  const singleMasked = masked.replace(CONFLICT_SINGLE_EXCL_RE, (m) => "\u0000".repeat(m.length));
  for (const ch of singleMasked) {
    if (CONFLICT_SINGLE.has(ch)) conflictHits += 1;
  }
  const conflictDensity = Math.round((conflictHits / clean.length) * 1000 * 100) / 100;
  const sents = raw.split(/[。！？!?…\n]+/).map((s) => s.replace(/\s+/g, "")).filter((s) => s.length >= 2);
  const avgSentenceChars = sents.length > 0 ? Math.round((clean.length / sents.length) * 10) / 10 : clean.length;
  const clauses = raw.split(/[，。！？!?；：、…\n]+/).map((s) => s.replace(/[“”「」『』"\s]/g, "")).filter((s) => s.length >= 2);
  const shortClauses = clauses.filter((c) => c.length <= 8).length;
  const shortClauseRatio = clauses.length > 0 ? Math.round((shortClauses / clauses.length) * 1000) / 1000 : 0;
  const exclamCount = (raw.match(/[！!]/g) || []).length;
  const exclamDensity = Math.round((exclamCount / clean.length) * 1000 * 100) / 100;
  const fastPaced = avgSentenceChars <= 22 || shortClauseRatio >= 0.55 || exclamDensity >= 6;
  return {
    conflictDensity,
    conflictHits,
    avgSentenceChars,
    shortClauseRatio,
    exclamDensity,
    fastPaced
  };
}

const DIALOGUE_QUOTE_PAIRS = [
  ["“", "”"],
  ["「", "」"],
  ["『", "』"],
  ['"', '"']
];

/**
 * 统计成对中文/英文引号（“...”、「...」、「『...』」、"..."）内字符占比 / 非空白总字符。
 * 线性单遍扫描 + 失配短路标记，最坏 O(N) 绝不回溯卡顿；空串/全空白返回 0，截到 [0, 1]，保留 3 位小数。
 */
export function measureDialogueRatio(text) {
  const raw = String(text ?? "");
  const nonWsTotal = raw.replace(/\s+/g, "").length;
  if (nonWsTotal === 0) return 0;
  let quotedChars = 0;
  const noClose = [false, false, false, false];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    let matched = false;
    for (let p = 0; p < DIALOGUE_QUOTE_PAIRS.length; p += 1) {
      const [open, close] = DIALOGUE_QUOTE_PAIRS[p];
      if (ch === open && !noClose[p]) {
        const end = raw.indexOf(close, i + 1);
        if (end === -1) {
          noClose[p] = true;
        } else {
          quotedChars += raw.slice(i + 1, end).replace(/\s+/g, "").length;
          i = end + 1;
          matched = true;
        }
        break;
      }
    }
    if (!matched) i += 1;
  }
  const ratio = Math.min(1, Math.max(0, quotedChars / nonWsTotal));
  return Math.round(ratio * 1000) / 1000;
}

/**
 * 场景分类：对话文戏 / 动作冲突 / 叙事过渡。
 * 兼容传正文字符串，或传 { text?, metrics?, dialogueRatio? }；仅传旧缓存 { metrics } 时安全回退纯指标启发式判定。
 */
export function classifyChapterScene(textOrInput) {
  const input = typeof textOrInput === "string"
    ? { text: textOrInput }
    : (textOrInput && typeof textOrInput === "object" ? textOrInput : {});
  const hasText = typeof input.text === "string";
  const hasDialogue = typeof input.dialogueRatio === "number" && Number.isFinite(input.dialogueRatio);
  const hasMetrics = input.metrics && typeof input.metrics === "object";

  let band = "narrative";
  let confidence = "low";
  let reason = "";
  let dialogueRatio = null;
  let actionDensity = 0;
  let conflictDensity = null;

  if (hasText) {
    dialogueRatio = hasDialogue
      ? Math.round(Math.min(1, Math.max(0, input.dialogueRatio)) * 1000) / 1000
      : measureDialogueRatio(input.text);
    const metrics = hasMetrics
      ? input.metrics
      : measureStyleMetrics(input.text).metrics;
    actionDensity = typeof metrics?.actionDensity === "number" && Number.isFinite(metrics.actionDensity)
      ? Math.round(metrics.actionDensity * 100) / 100
      : 0;
    const conflict = measureConflictSignals(input.text);
    conflictDensity = conflict.conflictDensity;

    if (dialogueRatio >= 0.34) {
      band = "dialogue";
      confidence = dialogueRatio >= 0.4 || conflictDensity < 20 ? "high" : "medium";
      reason = "引号对话占比 " + Math.round(dialogueRatio * 100) + "%（>=34%），归为对话文戏";
    } else if (dialogueRatio >= 0.25 && conflictDensity < 15) {
      band = "dialogue";
      confidence = "medium";
      reason = "引号对话占比 " + Math.round(dialogueRatio * 100) + "%（>=25%）且冲突词密度 " + conflictDensity + "（<15），归为对话文戏";
    } else if (conflictDensity >= 40) {
      band = "action";
      confidence = conflictDensity >= 60 || conflict.fastPaced ? "high" : "medium";
      reason = "冲突词密度 " + conflictDensity + "（>=40），归为动作冲突";
    } else if (conflictDensity >= 20 && conflict.fastPaced) {
      band = "action";
      confidence = "medium";
      reason = "冲突词密度 " + conflictDensity + "（>=20）且呈短句快节奏，归为动作冲突";
    } else {
      band = "narrative";
      confidence = dialogueRatio < 0.2 && conflictDensity < 12 ? "high" : "medium";
      reason = "对话占比 " + Math.round(dialogueRatio * 100) + "%、冲突词密度 " + conflictDensity + "，归为叙事过渡";
    }
  } else if (hasDialogue) {
    dialogueRatio = Math.round(Math.min(1, Math.max(0, input.dialogueRatio)) * 1000) / 1000;
    actionDensity = hasMetrics && typeof input.metrics.actionDensity === "number" && Number.isFinite(input.metrics.actionDensity)
      ? Math.round(input.metrics.actionDensity * 100) / 100
      : 0;
    if (dialogueRatio >= 0.34) {
      band = "dialogue";
      confidence = "high";
      reason = "引号对话占比 " + Math.round(dialogueRatio * 100) + "%（>=34%），归为对话文戏";
    } else if (dialogueRatio >= 0.25) {
      band = "dialogue";
      confidence = "medium";
      reason = "引号对话占比 " + Math.round(dialogueRatio * 100) + "%（>=25%，缺正文冲突信号），暂归为对话文戏";
    } else {
      band = "narrative";
      confidence = "low";
      reason = "对话占比 " + Math.round(dialogueRatio * 100) + "%（缺正文无法测量冲突信号），暂归为叙事过渡";
    }
  } else if (hasMetrics) {
    const m = input.metrics;
    actionDensity = typeof m.actionDensity === "number" && Number.isFinite(m.actionDensity)
      ? Math.round(m.actionDensity * 100) / 100
      : 0;
    const hasComplexity = typeof m.complexity === "number" && Number.isFinite(m.complexity);
    const hasModifier = typeof m.modifierDensity === "number" && Number.isFinite(m.modifierDensity);
    confidence = "low";
    if (hasComplexity && hasModifier && m.complexity <= 1.7 && m.modifierDensity <= 25 && actionDensity < 150) {
      band = "dialogue";
      reason = "旧缓存纯指标回退：句法复杂度 " + m.complexity + "（<=1.7）且修饰密度 " + m.modifierDensity + "（<=25），推定为对话文戏";
    } else if (actionDensity >= 210) {
      band = "action";
      reason = "旧缓存纯指标回退：极端动作密度 " + actionDensity + "（>=210），推定为动作冲突";
    } else {
      band = "narrative";
      reason = "旧缓存纯指标回退：归为叙事过渡";
    }
  } else {
    band = "narrative";
    confidence = "low";
    reason = "缺少正文与指标，默认归为叙事过渡";
  }

  return {
    band,
    label: SCENE_BAND_LABELS[band],
    dialogueRatio,
    actionDensity,
    conflictDensity,
    confidence,
    reason
  };
}

function resolveChapterScene(pc) {
  if (pc && pc.scene && SCENE_BANDS.includes(pc.scene.band)) {
    return pc.scene;
  }
  if (pc && typeof pc.text === "string") {
    return classifyChapterScene({ text: pc.text, metrics: pc.metrics });
  }
  return classifyChapterScene({ metrics: pc?.metrics });
}

/**
 * 为缺失 scene 的旧缓存逐章条目就地补齐场景分类（不修改原数组元素）。
 */
export function enrichPerChapterScenes(perChapter, textSource) {
  if (!Array.isArray(perChapter)) return [];
  const lookup = textSource instanceof Map
    ? textSource
    : new Map(Array.isArray(textSource)
      ? textSource.filter((it) => it && typeof it.file === "string" && typeof it.text === "string").map((it) => [it.file, it.text])
      : []);
  return perChapter.map(function (pc) {
    if (!pc || typeof pc !== "object") return pc;
    if (pc.scene && SCENE_BANDS.includes(pc.scene.band)) return pc;
    const text = typeof pc.file === "string" ? lookup.get(pc.file) : void 0;
    if (typeof text === "string") {
      return { ...pc, scene: classifyChapterScene({ text, metrics: pc.metrics }) };
    }
    return pc;
  });
}

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
      // v7.0.x（审查 #44）：旧版只返回 {mu,sigma,low,high}，比非空输入少 6 个键，
      // 下游解构 muRaw/sigmaRaw/sigmaUsed/recTol 时拿到 undefined（判定/展示各写一套兜底）。
      // 现按零值把形状补齐；recTol 用容差默认值 15（与 mu=0 分支的回退值一致）。
      baseline[key] = {
        mu: 0,
        muRaw: 0,
        sigma: 0,
        sigmaRaw: 0,
        sigmaMeasured: 0,
        sigmaUsed: 0,
        sigmaClamped: false,
        low: 0,
        high: 0,
        recTol: 15
      };
      continue;
    }
    const mu = values.reduce(function (a, b) { return a + b; }, 0) / values.length;
    // v6.2.1 注释修正（清单 #45）：这里用的是**总体标准差**（÷n），不是样本标准差（÷(n-1)）。
    // 章节数少时容差带会被系统性窄化（n=3 偏小 18%、n=2 偏小 29%），本仓库选择保留 ÷n 口径
    // 并如实标注字段语义，不再让注释读起来像"样本估计"。
    const variance = values.reduce(function (a, b) { return a + (b - mu) * (b - mu); }, 0) / values.length;
    let sigma = Math.sqrt(variance);
    // v4.3.0：区分「实测 σ」与「参与计算的钳制 σ」——旧版只返回钳制后的 sigma，
    // 展示层把 0.15μ 的下限当成"作者自身波动"念给用户（实测真实 σ=0.0084 被报成 0.15，
    // 相差 18 倍）；且默认 minSigmaRatio=0.15 使 recTol 的"下限 10%"永远不可达（1.5×0.15=22.5%→25）。
    // sigmaMeasured = 原始（未钳制）总体标准差；sigmaUsed = 钳制后用于 low/high/recTol 的值；
    // sigma = sigmaUsed（保持旧字段与既有断言兼容）；sigmaClamped 标记是否发生过钳制。
    // v6.2.1 修正（清单 #40）：另存未舍入的 muRaw / sigmaRaw 供 judgeAgainstBaseline 判定——
    // 旧版判定读的是舍入后的 mu/sigma，mu 舍成 0 后判定路径与 low/high/recTol（由未舍入值算出）
    // 互相矛盾：实测真 μ=0.004/σ=0.012 得到 {mu:0, sigma:0.01, low:-0.01, high:0.02, recTol:100}，
    // 判定走绝对尺度（阈值 1.5×0.01=0.015）把 v=0.017 判 out，而用真 σ 的阈值是 0.018（本在带内）。
    const sigmaRaw = sigma;
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
      muRaw: mu,
      sigma: Math.round(sigma * 100) / 100,
      sigmaRaw,
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
  // v7.0.x（审查 #45）：旧版直接 for...of，computeBaseline(null) 抛 "chapters is not iterable"。
  // 非数组一律按空输入处理，返回与 computeBaseline([]) 完全一致的零值基线（形状见 #44）。
  const list = Array.isArray(chapters) ? chapters : [];
  const perChapter = [];
  for (const ch of list) {
    if (!ch || !ch.text || ch.text.trim().length < 40) continue;
    const m = measureStyleMetrics(ch.text).metrics;
    perChapter.push({
      file: ch.file,
      metrics: m,
      scene: classifyChapterScene({ text: ch.text, metrics: m })
    });
  }
  const baseline = computeBaselineFromPerChapter(perChapter, opts);
  return { baseline, perChapter, chapterCount: perChapter.length };
}

/**
 * 分场景统计各场景带（对话文戏 / 动作冲突 / 叙事过渡）的六维基线。
 * 兼容旧缓存条目（缺少 pc.scene 时回退 classifyChapterScene({ metrics: pc.metrics })），绝不抛错。
 */
export function computeSceneBaselines(perChapter, opts) {
  const list = Array.isArray(perChapter)
    ? perChapter.filter(function (pc) { return pc && pc.metrics && typeof pc.metrics === "object"; })
    : [];
  const grouped = { dialogue: [], action: [], narrative: [] };
  const counts = { dialogue: 0, action: 0, narrative: 0 };
  for (const pc of list) {
    const scene = resolveChapterScene(pc);
    const band = SCENE_BANDS.includes(scene.band) ? scene.band : "narrative";
    grouped[band].push(pc);
    counts[band] += 1;
  }
  const bands = {};
  const availableBands = [];
  for (const band of SCENE_BANDS) {
    const items = grouped[band];
    if (items.length >= MIN_SCENE_BAND_CHAPTERS) {
      bands[band] = {
        band,
        label: SCENE_BAND_LABELS[band],
        chapterCount: items.length,
        files: items.map(function (it) { return it.file; }).filter(function (f) { return typeof f === "string" && f !== ""; }),
        baseline: computeBaselineFromPerChapter(items, opts)
      };
      availableBands.push(band);
    }
  }
  return {
    bands,
    totalChapters: list.length,
    counts,
    availableBands
  };
}

/**
 * 为目标章挑选场景分带基线：同类场景带的**对照样本**（不含本章）达到
 * MIN_SCENE_BAND_CHAPTERS（3 章）优先按同带对照，否则自动回退全量基线。
 *
 * 注意门槛口径：本章不能当自己的基线，所以 `sameBand` 只统计「除本章外」的同带章。
 * 也就是说一本**同带恰好 3 章**的书不会启用分带，需要同带 ≥ 4 章（本章 + 3 章对照）。
 * 回退与命中的 note 都会写明「对照样本 / 不含本章」，避免用户把 3 章总数误读成门槛。
 */
export function selectSceneBaseline(targetTextOrInput, excludingPerChapter, opts) {
  const targetScene = classifyChapterScene(targetTextOrInput);
  const pool = Array.isArray(excludingPerChapter)
    ? excludingPerChapter.filter(function (pc) { return pc && pc.metrics && typeof pc.metrics === "object"; })
    : [];
  const fallbackBaseline = computeBaselineFromPerChapter(pool, opts);
  const sameBand = pool.filter(function (pc) { return resolveChapterScene(pc).band === targetScene.band; });
  if (sameBand.length >= MIN_SCENE_BAND_CHAPTERS) {
    return {
      ...targetScene,
      usedSceneBand: true,
      peerCount: sameBand.length,
      chapterCount: pool.length,
      items: sameBand,
      baseline: computeBaselineFromPerChapter(sameBand, opts),
      fallbackBaseline,
      note: "按「" + targetScene.label + "」同类场景带对照（对照样本 " + sameBand.length + " 章 / 全书其他 " + pool.length + " 章；对照样本不含本章）"
    };
  }
  return {
    ...targetScene,
    usedSceneBand: false,
    peerCount: sameBand.length,
    chapterCount: pool.length,
    items: pool,
    baseline: fallbackBaseline,
    fallbackBaseline,
    note: "同场景「" + targetScene.label + "」的对照样本仅 " + sameBand.length + " 章（不含本章，不足 " + MIN_SCENE_BAND_CHAPTERS + " 章），已自动回退全基线对照（" + pool.length + " 章）"
  };
}

/**
 * 偏离判定：新章 vs 基线，输出每维偏差百分比（相对 μ）与判定。
 */
export function judgeAgainstBaseline(metrics, baseline, tolerance) {
  tolerance = tolerance || null;
  // v7.0.x（审查 #45）：旧版在循环里直接读 baseline[key]，传 null 时抛 TypeError。
  // 整体缺基线 ≠ 逐维缺基线：返回空判定 + "无基线" 说明，形状与正常返回完全一致。
  if (!baseline || typeof baseline !== "object") {
    return {
      verdicts: [],
      outOfBand: [],
      outCount: 0,
      skippedDims: [],
      summary: "无基线（未提供基线数据，未做任何判定）"
    };
  }
  // 取值对象缺失时按"无本章取值"逐维登记，同样不抛错（保持与正常路径同形）
  metrics = metrics && typeof metrics === "object" ? metrics : {};
  const verdicts = [];
  const outOfBand = [];
  const skippedDims = []; // v7.0.x（#40 落地后）只登记"没判"的维度：no-baseline / no-value（mu-zero 已改为绝对判定并出 verdict）
  for (const key of METRIC_ORDER) {
    const b = baseline[key];
    const v = metrics[key];
    // v6.2.1 修正（清单 #42）：这两条跳过路径此前静默丢弃——维度没判，summary 却仍宣称
    // "全部维度在容差带内 ✓"（实测 judgeAgainstBaseline({complexity:1,hedgeDensity:50}, {complexity:…})
    // → verdicts=1、skippedDims=[]、summary 称全部在带内，hedgeDensity=50 被无声吞掉）。
    // 现登记进 skippedDims（带 reason）并由 summary 披露，供调用方区分"判过且没问题"与"根本没判"。
    if (!b) { skippedDims.push({ metric: key, label: METRIC_LABELS[key], value: typeof v === "number" ? v : null, sigma: null, reason: "no-baseline" }); continue; }
    if (typeof v !== "number") { skippedDims.push({ metric: key, label: METRIC_LABELS[key], value: null, sigma: null, reason: "no-value" }); continue; }
    // v4.3.0 修正（P1-3）：基线 μ=0 时旧版直接 continue —— 新章该维无论多离谱都不产生判定，
    // 而 summary 仍宣称"全部维度在容差带内 ✓"（实测 hedgeDensity/gapIndex 给到 50 也被完全忽略）。
    // v7.0.x（审查 #40）：改为绝对尺度判定，且**任何** μ=0 维度都产出 verdict（不再登记 mu-zero 跳过）：
    //   σ>0 → |v| > 1.5σ；σ=0 → |v| > recTol（mu=0 时 recTol 即绝对门槛）——见下方分支。
    // v6.2.1（清单 #40）：判定改用未舍入的 muRaw / sigmaRaw——舍入后的 mu 会误把真 μ=0.004 当 0，
    // 舍入后的 sigma 会把阈值从 1.5σ 变粗（见 computeBaselineFromPerChapter 处的实测）。
    const muRaw = typeof b.muRaw === "number" && isFinite(b.muRaw) ? b.muRaw : b.mu;
    if (muRaw === 0) {
      const sd = typeof b.sigmaRaw === "number" && isFinite(b.sigmaRaw) && b.sigmaRaw > 0
        ? b.sigmaRaw
        : (typeof b.sigma === "number" && isFinite(b.sigma) ? b.sigma : 0);
      // v7.0.x（审查 #40）：sd=0 时旧版整体跳过（skippedDims reason:"mu-zero"）——
      // 「全书该维恒为 0、本章突然出现极值」这类最该报的离群点反而漏判。
      // 现在 sd=0 改用绝对容差带 recTol（mu=0 时判据即 |value| > recTol）；
      // sd>0 保留原 1.5σ 绝对尺度。两条都不再跳过：带内的也给 verdict（ok/warn），
      // 让"判过且没问题"与"根本没判"（no-baseline / no-value）彻底区分开。
      const recT = typeof b.recTol === "number" && isFinite(b.recTol) && b.recTol > 0 ? b.recTol : 15;
      const absLimit = sd > 0 ? 1.5 * sd : recT;
      const absDev = Math.abs(v - muRaw);
      const status = absDev > absLimit ? "out" : (absDev > absLimit / 2 ? "warn" : "ok");
      const absItem = {
        metric: key, label: METRIC_LABELS[key], mu: b.mu, value: v, devPct: null,
        sigma: sd > 0 ? Math.round((v / sd) * 10) / 10 : 0,
        tolerance: { low: -absLimit, high: absLimit },
        status, basis: "absolute"
      };
      verdicts.push(absItem);
      if (status === "out") outOfBand.push(absItem);
      continue;
    }
    const devPct = Math.round(((v - muRaw) / muRaw) * 1000) / 10;
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
    // v6.2.1（清单 #40）：σ 距离同样按未舍入值算（舍入会把 0.012 报成 0.01，且 μ 用舍入值会失真）
    const sigForDist = typeof b.sigmaRaw === "number" && isFinite(b.sigmaRaw) ? b.sigmaRaw : b.sigma;
    const sigmaDist = sigForDist > 0 ? (v - muRaw) / sigForDist : 0;
    const status = devPct < tol.low || devPct > tol.high ? "out" : (devPct < tol.low / 2 || devPct > tol.high / 2) ? "warn" : "ok";
    verdicts.push({ metric: key, label: METRIC_LABELS[key], mu: b.mu, value: v, devPct, sigma: Math.round(sigmaDist * 10) / 10, tolerance: tol, status });
    if (status === "out") outOfBand.push(verdicts[verdicts.length - 1]);
  }
  // v4.3.0：summary 必须把"被跳过的维度"说清楚，不能一边跳过一边宣称"全部维度在容差带内 ✓"
  // v6.2.1（清单 #42）：措辞按 reason 分列，并区分"判过且都在带内"与"一个维度都没判"；
  // reason 只服务展示与调用方诊断——skippedDims 现在只剩 no-baseline / no-value 两种 reason
  // （μ=0 的维度已在上面按绝对尺度判定并进 verdicts，见 muRaw === 0 分支）。
  // v7.3.2 修（N24④）：删除对 lib/fixplan.js「基线 μ=0 绝对量级兜底」的引用——该分支在 7.3.1
  // 已整段删除（fixplan.js:601-609），旧注释仍称它消费 skippedDims[].metric/value，与现状不符。
  const skipReasonText = (s) => (s.reason === "no-value" ? "无本章取值" : s.reason === "no-baseline" ? "基线缺失" : "基线均值为 0");
  const skippedNote = skippedDims.length === 0
    ? ""
    : "；另有 " + skippedDims.length + " 个维度未判定（"
      + skippedDims.map((s) => s.label + " " + skipReasonText(s)).join("、")
      + "）";
  const noJudgement = verdicts.length === 0 && skippedDims.length > 0;
  return {
    verdicts,
    outOfBand,
    outCount: outOfBand.length,
    skippedDims,
    // v5.1.0（降本/防僵化）：措辞从「需修正」改为「先判断是否为有意为之」——容差带是 1.5σ（作者自身波动），
    // 六维里至少一维出带是常见现象；旧措辞会让模型把正常波动当成必须修的缺陷，越改越僵。
    // v6.2.1（清单 #42）：noJudgement 时不再宣称"无维度超出容差带"（一个维度都没判，谈不上"没超出"）。
    summary: (outOfBand.length === 0
      ? (verdicts.length === 0
        ? (noJudgement ? "无维度可判定（基线缺失）" : "无维度超出容差带")
        : (skippedDims.length === 0 ? "全部维度在容差带内 ✓" : "无维度超出容差带"))
      : outOfBand.length + " 个维度超出容差带（先判断是否为有意为之，偏离明显或读起来别扭才改）") + skippedNote
  };
}