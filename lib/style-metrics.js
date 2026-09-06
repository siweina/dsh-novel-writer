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
const ACTION_VERBS = [
  "推", "拉", "抓", "拿", "端", "抱", "举", "抬", "踢", "踩", "打", "拍", "敲", "砸",
  "扔", "丢", "接", "递", "握", "捏", "掐", "拧", "扯", "撕", "拔", "插", "捅", "刺",
  "砍", "劈", "切", "割", "放", "摆", "搁", "挂", "贴", "塞", "填", "灌", "倒", "泼",
  "洒", "翻", "卷", "铺", "盖", "叠", "折", "脱", "穿", "戴", "摘",  "解", "开",
  "关", "锁", "按", "压", "顶", "撞", "碰", "触", "摸", "抚", "揉", "搓", "擦", "抹",
  "洗", "刷", "扫", "拖", "铲", "挖", "埋", "堆", "砌", "修", "补", "缝", "织", "编",
  "缠", "绕", "捆", "绑", "扎", "拴", "套", "蒙", "罩", "捂", "堵", "挡", "遮", "掩",
  "藏", "躲", "避", "逃", "追", "赶", "跑", "走", "奔", "冲", "闯", "越", "跨", "跳",
  "跃", "爬", "攀", "登", "降", "升", "沉", "浮", "漂", "荡", "摇", "晃", "摆", "抖",
  "颤", "震", "动", "静", "停", "驻", "立", "坐", "躺", "卧", "跪", "蹲", "站", "靠",
  "倚", "趴", "俯", "仰", "倾", "侧", "转", "回", "返", "退", "进", "出", "入", "起",
  "落", "哭", "笑", "喊", "叫", "嚷", "吼", "骂", "斥", "责", "夸", "赞", "叹", "喘",
  "吸", "呼", "吐", "咽", "吞", "嚼", "咬", "啃", "舔", "吮", "嗅", "闻", "听", "看",
  "望", "瞧", "瞅", "盯", "瞪", "瞥", "瞟", "瞄", "观", "察", "读", "写", "画", "描",
  "绘", "刻", "雕", "铸", "炼", "烧", "煮", "炒", "煎", "炸", "烤", "烘", "熏", "泡",
  "浸", "染", "涂", "喷", "浇", "淋", "滴",  "淌", "涌", "冒", "射", "溅", "炸",
  "裂", "碎", "破", "赢", "输", "借", "还", "付", "收", "给", "送", "寄", "递", "交",
  "赐", "赏", "罚", "奖", "惩", "减", "增", "加", "删", "改", "换", "替", "代", "变",
  "创", "建", "设", "置", "安", "装", "配", "组", "拆", "卸", "运", "搬", "携", "带",
  "佩", "持", "执", "操", "控", "驾", "驶", "骑", "乘", "踏", "迈",  "驰", "飞",
  "翔", "游", "泳", "潜", "航", "驱", "逐", "灭", "杀", "斩", "擒", "捕", "捉", "逮",
  "拘", "押", "囚", "禁", "铐", "缚", "吊", "悬", "垂", "坠", "掉", "摔", "跌", "倒",
  "仆", "瘫",  "麻", "僵", "直", "挺", "竖", "耸", "矗", "凸", "凹", "陷", "塌",
  "崩", "垮", "弯", "折", "断", "裂", "绽", "合", "拢", "闭", "张", "启", "展", "伸",
  "缩", "抽", "拽", "揪", "捋", "拂", "掸", "扑", "扇", "燃", "点", "着", "焚", "灼",
  "烫", "烙", "煨", "炖", "焖", "熬", "烹", "调", "拌", "搅", "和", "团", "发", "烂",
  "腐", "朽", "酸", "甜", "苦", "辣", "咸",  "腻", "胖", "肿", "胀", "鼓", "瘪",
  "皱", "平", "整", "齐", "乱", "杂", "混", "浊", "清", "澈", "净", "洁", "污", "染",
  "脏", "臭", "香", "芳", "馥", "郁", "浓",  "雅", "俗", "野", "蛮", "横", "霸",
  "欺", "压", "榨", "剥", "削", "掠", "夺", "抢", "劫", "偷", "盗", "窃", "扒", "掏",
  "搜", "查", "寻", "找", "觅", "探", "索", "究", "研", "讨", "论", "议", "评", "判",
  "审", "核", "验", "证", "试", "测", "量", "计", "算",  "分", "析", "归", "纳",
  "辩", "驳", "争", "吵", "闹", "斗", "殴", "拼", "搏", "挣", "抗", "抵", "防", "守",
  "卫", "护", "保", "救", "援", "助", "帮", "扶", "领", "导", "指", "引", "教", "训",
  "培", "锻", "磨", "砺", "激", "励", "鼓", "振", "奋", "兴", "感", "触", "震", "惊",
  "慨", "唏", "嘘", "呜", "咽", "啜", "泣", "哽", "窒", "憋", "闷", "堵", "慌", "乱",
  "躁", "烦", "恼", "怒", "火", "气", "愤", "憎", "恶", "厌", "嫌", "弃", "鄙", "蔑",
  "轻",  "珍", "爱", "惜", "怜", "悯", "疼", "宠", "溺", "娇", "惯", "纵", "容",
  "包", "庇", "袒", "呵", "佑", "祝", "福", "祈", "祷", "祭", "祀", "拜", "念", "诵",
  "咏", "吟", "唱", "歌", "舞", "蹈", "旋", "滚", "滑", "溜", "窜", "遁", "隐", "匿",
  "潜", "伏", "修", "行", "悟", "参", "禅", "坐", "定", "成", "化", "属", "于", "存",
  "拥", "具", "获", "取", "博", "争", "谋", "求", 
  "愿", "确", "决", "选", "挑", "拣", "筛", "甄", "辨", "划", "割", "配", "发",
  "派", "颁", "授", "予", "赠", "托", "委", "信", "任", "依", "凭", "仗", "恃", "仰",
  "指", "盼", "期", "渴", "奢", "妄", "幻", "梦", "理", "设", "构", "揣", "猜", "预",
  "料", "征", "兆", "迹", "象", "端", "倪", "苗", "头", "绪", "脉", "络", "纹", "层",
  "次", "框", "架", "体",    "程", "序",  "骤", "环", "节", "细",
   "难", "焦", "热",  "卖", "痛",  "肋", "弱", "短", "板", "瓶",
  "颈", "壁", "垒", "藩", "篱", "桎", "梏", "枷", "锁", "镣", "牢", "笼", "樊", "囚",
  "罩", "络"
];

// 动态助词（动词后出现 → 动作完成/进行，常见于动作描写）
const DYNAMIC_PARTICLES = "了着过起住上下进出开完掉得";

const ACTION_SET = new Set(ACTION_VERBS);

/** 切句：按句末标点切分。 */
function splitSentences(text) {
  // v3.5.0 #50b：标点切句 + 无标点换行也切（逐行排版正确分句）；未完句判定按"行末豁免"处理（见 measureStyleMetrics）
  // v3.5.0 H3：句末标点后吞闭合引号（"她说：\u201c走吧。\u201d" 不再切成孤儿引号句）
  // v3.9.1 #1：句末符后若紧跟句末符则不切（太好了！！！/真的？？/他哭了。。。不再拆出孤立标点残片）
  return String(text)
    .split(/(?<=[。！？!?])(?![。！？!?])\s*|\n+/)
    .map(function (s) { return s.replace(/[”」』’\"']+$/, "").trim(); })
    // 纯句末标点残片（！！！/？？/。。。）丢弃；纯省略号句（"……"）不是纯句末标点，保留
    .filter(function (s) { return s.length > 0 && !/^[。！？!?]+$/.test(s); });
}

/** v3.9.1 #2：名词词素"X地"——修饰密度统计 X地 时排除（地上/地下/地方/土地/…等；列表可扩展） */
const DI_NOUN_ENDINGS = new Set([
  "地上", "地下", "地方", "土地", "地面", "地区", "地位", "地铁", "地图", "地板", "地道", "地理", "地球", "地域", "地点", "地址", "地层",
  "原地", "当地", "特地", "墓地", "产地", "场地", "落地", "阵地", "田地", "旱地", "湿地", "耕地", "草地", "雪地", "山地", "坡地",
  "林地", "园地", "荒地", "宝地", "圣地", "禁地", "腹地", "属地", "领地", "封地", "外地", "洼地", "谷地", "泥地",
  "大地", "平地", "内地", "各地", "两地", "满地", "遍地", "目的地"
]);

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
  const adjMods = (t.match(/[\u4e00-\u9fff]{1,3}(?<!目)(?<!的)的/g) || []).length;
  const advMods = (t.match(/[\u4e00-\u9fff]{1,4}地/g) || []).filter(function (m) {
    for (const noun of DI_NOUN_ENDINGS) if (m.endsWith(noun)) return false;
    return true;
  }).length;
  const modifierDensity = per1000(adjMods + advMods);

  // 3) 抽象度：抽象后缀 2-3 字词（合并单次正则，性能优化）
  const ABSTRACT_RE = new RegExp("[\\u4e00-\\u9fff]{1,2}(?:" + ABSTRACT_SUFFIXES.join("|") + ")(?![\\u4e00-\\u9fff])", "g");
  const abstractCount = (t.match(ABSTRACT_RE) || []).length;
  const abstractDensity = per1000(abstractCount);

  // 4) 动作密度：动作动词 + 动态助词/宾语模式
  let actionCount = 0;
  let idx = 0;
  while (idx < t.length) {
    const ch = t[idx];
    if (ACTION_SET.has(ch)) {
      const next = idx + 1 < t.length ? t[idx + 1] : "";
      const next2 = idx + 2 < t.length ? t[idx + 2] : "";
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
  const gapChars = per1000(ellipsis * 2 + dash * 2);
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
  const unfinishedRatio = sentences.length > 0 ? unfinished / sentences.length : 0;

  return {
    metrics: {
      complexity: Math.round(complexity * 100) / 100,
      modifierDensity: Math.round(modifierDensity * 100) / 100,
      abstractDensity: Math.round(abstractDensity * 100) / 100,
      actionDensity: Math.round(actionDensity * 100) / 100,
      hedgeDensity: Math.round(hedgeDensity * 100) / 100,
      gapIndex: Math.round((gapChars + unfinishedRatio * 100) * 100) / 100
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
    // 最小 σ 下限：防小书（章节少/波动小）容差带过窄
    const minSigma = Math.max(mu * minSigmaRatio, mu === 0 ? 0 : 0.0001);
    sigma = Math.max(sigma, minSigma);
    // v3.0.0：推荐容差 = 作者自身章节波动的 1.5 倍 σ（相对 μ 的百分比，取整到 5，下限 10%、上限 100%）——未自定义时按此判定；mu=0 回退 15 防 NaN
    let recTol = 15;
    if (mu > 0) {
      recTol = Math.max(Math.round(((1.5 * sigma) / mu) * 100 / 5) * 5, 10);
      recTol = Math.min(recTol, 100);
    }
    baseline[key] = { mu: Math.round(mu * 100) / 100, sigma: Math.round(sigma * 100) / 100, low: Math.round((mu - sigma) * 100) / 100, high: Math.round((mu + sigma) * 100) / 100, recTol };
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
  for (const key of METRIC_ORDER) {
    const b = baseline[key];
    const v = metrics[key];
    if (!b || typeof v !== "number" || b.mu === 0) continue;
    const devPct = Math.round(((v - b.mu) / b.mu) * 1000) / 10;
    // v3.0.0：默认用推荐容差（作者自身波动的 1.5σ），无推荐才回退 ±15%
    const recT = typeof b.recTol === "number" && isFinite(b.recTol) && b.recTol > 0 ? b.recTol : 15;
    const tol = tolerance && tolerance[key]
      ? { low: Number(tolerance[key].low) !== 0 ? (Number(tolerance[key].low) || -recT) : 0, high: Number(tolerance[key].high) !== 0 ? (Number(tolerance[key].high) || recT) : 0 }
      : { low: -recT, high: recT };
    const sigmaDist = b.sigma > 0 ? (v - b.mu) / b.sigma : 0;
    const status = devPct < tol.low || devPct > tol.high ? "out" : (devPct < tol.low / 2 || devPct > tol.high / 2) ? "warn" : "ok";
    verdicts.push({ metric: key, label: METRIC_LABELS[key], mu: b.mu, value: v, devPct, sigma: Math.round(sigmaDist * 10) / 10, tolerance: tol, status });
    if (status === "out") outOfBand.push(verdicts[verdicts.length - 1]);
  }
  return {
    verdicts,
    outOfBand,
    outCount: outOfBand.length,
    summary: outOfBand.length === 0 ? "全部维度在容差带内 ✓" : outOfBand.length + " 个维度超出容差带，需修正"
  };
}