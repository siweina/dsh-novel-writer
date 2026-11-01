/**
 * dsh-novel-writer — 大纲子句义务（obligations）v7.0.0
 *
 * 职责：把作者的「一行大纲方向」切成事件子句 → 判一个动词元类别 → 给一条**格式约束**，
 * 供开写包在动笔前渲染给写正文的模型。
 *
 * ▍为什么"只切分、不生成问句"
 * 曾有一版想在本模块里用正则拼出「药是什么形态？钱怎么付？」这类"定制追问"去逼出细节，
 * 最后被否掉：纯本地 JS 没有语义理解，所谓"定制"只是把固定模板换上不同的词，越写越像八股；
 * 模板一旦与题材错配，还会把模型往错误的方向推（比不说更糟）。
 * 所以这里的产出被硬性限制为三样东西——「原句 + 类别 + 填空格式」：
 *   · 原句：不动作者的字，调用方一眼能对上自己的大纲；
 *   · 类别：粗粒度动词元类别，只用于"这批子句里有没有某类"的相关性门控；
 *   · 格式：只说"必须包含哪几个要素"，具体写什么物象、什么动作、停在哪个画面，
 *     全部留给调用方（大模型）填。
 * 本模块只做确定性的结构处理：切句、归类、给要素清单。语义由调用方负责。
 *
 * ▍为什么"末位动词优先"
 * 汉语连动结构高发，"林风去黑市买药"里 去(move) 与 买(trade) 同时出现，
 * 而句子中心动词通常是**最后一个**：先到场、后交易，事件落点是交易。
 * 因此判定取"命中位置最靠后者"，且比较键用**词尾**（at + len）而不是起笔位置——
 * 这样"想到/打听/回答/坐在"这类双字词不会被自己内部的单字（到/打/答/坐）反超；
 * 词尾相同再取更长的词（更具体的那一个）。
 * 一条都没命中 → 兜底 introspect（内省推演）：它对正文的约束最宽松，误判代价最小。
 *
 * 设计约束（硬性）：
 * - 纯函数、零依赖、无 IO、不写盘、不读时钟、不 console：同输入必得同输出。
 * - 不抛异常：非字符串入参一律返回空数组 / 兜底类别。
 * - 词表只做**词形**匹配，附带极少量词形级上下文豁免（如"现在"里的"在"、"立刻"里的"立"），
 *   不做任何语义推断。
 */

/** 7 个动词元类别（键名固定，v7.0.0） */
export const CLAUSE_CATEGORIES = Object.freeze({
  move: "位移入场",
  fight: "交锋对抗",
  trade: "交易获取",
  discover: "发现窥探",
  talk: "交谈博弈",
  endure: "静态承受",
  introspect: "内省推演"
});

/** 兜底类别：没命中任何词形时使用（约束最宽松，误判代价最小） */
const FALLBACK_CATEGORY = "introspect";

/** 子句上限：超过就截断，避免开写包预算被一条过长的大纲撑爆 */
const MAX_CLAUSES = 8;

/**
 * 格式约束模板（v7.0.0）。
 * 它不是问句，只是一句"必须包含哪几个要素"的填空说明；
 * 三个要素固定为：可触碰器物 / 肢体动作 / 落点（这一幕停在哪）。
 */
export const CLAUSE_FRAME_FORMAT = "需指定：1 个可触碰器物 + 1 个肢体动作 + 1 个落点（这一幕停在哪）";

/** 单子句大纲（K=1）的三步具象展开引导（供开写包渲染） */
export const SINGLE_CLAUSE_STEP_HINT = "单句大纲请拆成三步写入 plan：① 入场接触的器物与环境 → ② 核心动作交锋或阻碍 → ③ 章末停在哪个未完动作或异响。";

/** 章末收束闸门（恒定追加的一条，供开写包渲染） */
export const ENDING_GATE_TEXT = "本章必须停在具体动作、突发异响或一句没答完的话上；不写总结陈词与未来展望。";

// ---------------------------------------------------------------------------
// 词表（v7.0.0，每类 8~20 个词，只收高频词形，宁缺勿滥）
// ---------------------------------------------------------------------------

const WORD_LISTS = Object.freeze({
  // 位移入场：含 在/于 这类静态位置词——"苏莫在祠堂"这类开场很常见，漏了就会掉进兜底类别
  move: Object.freeze([
    "去", "到", "回", "入", "在", "于",
    "走进", "踏入", "潜入", "来到", "赶往", "前往",
    "离开", "进入", "抵达", "跪在", "坐在", "守在", "走向"
  ]),
  // 交锋对抗
  fight: Object.freeze([
    "杀", "战", "打", "斗", "搏", "挡", "破", "突围", "逃",
    "躲", "闪", "交手", "刺", "砍", "劈", "撞", "按住"
  ]),
  // 交易获取
  trade: Object.freeze([
    "买", "卖", "换", "付", "收", "求", "讨", "借",
    "还", "典当", "交割", "递上", "讨价", "支付"
  ]),
  // 发现窥探
  discover: Object.freeze([
    "盯上", "发现", "察觉", "看见", "听到", "撞见", "识破", "窥见",
    "搜出", "翻出", "注意到", "看到", "闻到", "打量", "瞥见"
  ]),
  // 交谈博弈
  talk: Object.freeze([
    "说", "问", "答", "谈", "议", "劝", "试探", "交涉",
    "打听", "商议", "追问", "辩解", "吩咐", "交代", "告知"
  ]),
  // 静态承受
  endure: Object.freeze([
    "跪", "坐", "守", "困", "卧", "立", "扛", "忍",
    "受", "熬", "等着", "怔住", "僵住", "忍耐", "硬撑"
  ]),
  // 内省推演（兜底类）
  introspect: Object.freeze([
    "回忆", "想起", "参悟", "运转", "修炼", "盘算", "查看", "权衡",
    "琢磨", "意识到", "想到", "回想", "思忖", "明白", "断定"
  ])
});

/** 判定顺序：取 CLAUSE_CATEGORIES 的键序，保证同一输入在不同运行时下结果一致 */
const CATEGORY_ORDER = Object.freeze(Object.keys(CLAUSE_CATEGORIES));

// ---------------------------------------------------------------------------
// 词形级上下文豁免（不做语义判断，只挡掉"这些字在该组合里不是动词用法"的情形）
// ---------------------------------------------------------------------------

/** 左侧豁免：前一个字命表中则不算动词（现在 / 正在 / 所 在 / 对 于 / 由 于 …） */
const LEFT_GUARDS = Object.freeze({
  "在": Object.freeze(["现", "正", "所", "自", "存", "实"]),
  "于": Object.freeze(["对", "由", "关", "至", "终", "等", "属", "善", "便", "敢", "甚", "鉴", "过", "在", "存"]),
  // v7.0.0 修正（审查实测）：单字言语动词会撞进常用词里——
  // 「传说/据说/听说/小说/学说/再说/解说」「不可思议/建议/会议/协议/争议」「座谈/空谈」「顾问/学问/访问」。
  // 实测「他独自琢磨那个古老传说」被判成 talk、「这简直不可思议」也被判成 talk。
  // 只挡左邻字；多字词（商议/议论）仍按自身命中，不受影响。
  "说": Object.freeze(["传", "据", "听", "小", "学", "术", "再", "解", "虽", "空"]),
  "议": Object.freeze(["思", "建", "会", "协", "争", "异", "决", "评"]),
  "谈": Object.freeze(["座", "空", "闲", "漫"]),
  "问": Object.freeze(["顾", "学", "访", "疑", "询"]),
  "答": Object.freeze(["解", "报", "回"])
});

/** 右侧豁免：后一个字命表中则不算动词（还是 / 立刻 / 在乎 / 于是 …） */
const RIGHT_GUARDS = Object.freeze({
  "在": Object.freeze(["乎", "意", "于"]),
  "于": Object.freeze(["是"]),
  // v7.0.0：补单字言语动词的右邻字（说明/说法/答案/问题）
  "说": Object.freeze(["明", "法", "服", "辞"]),
  "问": Object.freeze(["题", "号"]),
  "答": Object.freeze(["案"]),
  "还": Object.freeze([
    "是", "在", "有", "没", "不", "得", "要", "会", "能", "好", "算",
    "想", "站", "坐", "说", "问", "笑", "看", "听", "走", "来", "去"
  ]),
  "立": Object.freeze(["刻", "即", "时", "马"])
});

/**
 * 该位置上的这个词是不是被上下文豁免掉了。
 * @param {string} word 词表里的词
 * @param {number} at 在 text 中的起始下标
 * @param {string} text 被判定文本
 * @returns {boolean}
 */
function isGuardedUse(word, at, text) {
  const left = LEFT_GUARDS[word];
  if (left && at > 0) {
    const prev = text[at - 1];
    if (prev && left.includes(prev)) return true;
  }
  const right = RIGHT_GUARDS[word];
  if (right) {
    const nextAt = at + word.length;
    const next = nextAt < text.length ? text[nextAt] : "";
    if (next && right.includes(next)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 切分
// ---------------------------------------------------------------------------

/** 主切分：，；。、→ -> 以及换行 */
const MAIN_SPLIT_RE = /[，,；;。、→\r\n]+|[-—]+>/u;

/**
 * 连词二次切分。
 *
 * v7.0.0 修正（审查实测）：**单字「并 / 又 / 却」不能当切分点**。
 * 中文里它们大量出现在词内部 —— 实测「他吞并了邻镇的地盘」被切成「他吞 / 并了邻镇的地盘」。
 * 同理「并州 / 退却 / 冷却 / 又一」都会误切。这里只保留**多字且不含歧义**的连接词：
 * 并且 / 随后 / 接着 / 然后 / 于是 / 不料 / 为了。
 * 代价是「他进了屋并坐下」这类句子不再二次切分——**少切一刀**远好过切错一刀
 * （切错会把一个事件拆成两条欠账，直接污染开写包）。
 */
const CONNECTIVE_SOURCE = "并且|随后|接着|然后|于是|不料|为了";

/** "有内容"的判据：至少一个文字/数字，用来丢掉纯标点段 */
const CONTENT_RE = /[\p{L}\p{N}]/u;

/** 子句是否含实际内容（纯标点、纯空白 → false） */
function isMeaningfulClause(text) {
  return typeof text === "string" && CONTENT_RE.test(text);
}

/** 只修剪首尾的空白与分隔符，内部一字不改（保证结果仍是原句的子串） */
function normalizeClause(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/^[\s，,；;。、：:！？!?、]+/u, "")
    .replace(/[\s，,；;。、：:！？!?、]+$/u, "")
    .trim();
}

/**
 * 按连词把一段话切成几截（连词保留在后一截的开头，原句用词不丢）。
 * @param {string} text
 * @returns {string[]}
 */
function splitByConnectives(text) {
  if (typeof text !== "string" || !text) return [];
  const re = new RegExp(CONNECTIVE_SOURCE, "gu");
  const cuts = [];
  let match = re.exec(text);
  while (match !== null) {
    if (match[0].length === 0) {
      re.lastIndex += 1; // 防死循环（当前词表不会出现，留作保险）
    } else if (match.index > 0 && cuts[cuts.length - 1] !== match.index) {
      cuts.push(match.index); // 连词在句首时不切，避免切出空段
    }
    match = re.exec(text);
  }
  if (cuts.length === 0) return [text];

  const parts = [];
  let start = 0;
  for (const cut of cuts) {
    parts.push(text.slice(start, cut));
    start = cut;
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * 把一行大纲切成事件子句（v7.0.0）。
 * - 主切分：，；。、→ -> 以及换行
 * - 若只切出 1 段，再按连词二次切分（并且/并/又/随后/接着/却/不料/为了/然后）
 * - 去掉空段与纯标点段，保留原顺序，最多 8 条
 * @param {string} direction 大纲方向行
 * @returns {string[]} 0~8 条子句
 */
export function splitOutlineClauses(direction) {
  if (typeof direction !== "string") return [];
  const text = direction.trim();
  if (!text) return [];

  let clauses = text
    .split(MAIN_SPLIT_RE)
    .map(normalizeClause)
    .filter(isMeaningfulClause);

  // 只有一段时才做二次切分：连词通常出现在"无标点长句"里
  if (clauses.length === 1) {
    clauses = splitByConnectives(clauses[0])
      .map(normalizeClause)
      .filter(isMeaningfulClause);
  }

  return clauses.slice(0, MAX_CLAUSES);
}

// ---------------------------------------------------------------------------
// 归类
// ---------------------------------------------------------------------------

/**
 * 给单条子句判一个元类别（v7.0.0）。
 * 规则：连动句取"最后一个命中"的类别；比较键是词尾位置（at + len），
 * 词尾相同取更长的词；一条都没命中 → introspect（兜底）。
 * @param {string} clause 子句
 * @returns {string} CLAUSE_CATEGORIES 的某个键
 */
export function classifyClause(clause) {
  if (typeof clause !== "string") return FALLBACK_CATEGORY;
  const text = clause.trim();
  if (!text) return FALLBACK_CATEGORY;

  let bestCategory = FALLBACK_CATEGORY;
  let bestEnd = -1;
  let bestLen = 0;

  for (const category of CATEGORY_ORDER) {
    const words = WORD_LISTS[category] || [];
    for (const word of words) {
      let from = 0;
      while (from <= text.length - word.length) {
        const at = text.indexOf(word, from);
        if (at < 0) break;
        from = at + 1; // 允许重叠命中，逐位置往后找
        if (isGuardedUse(word, at, text)) continue;
        const end = at + word.length;
        if (end > bestEnd || (end === bestEnd && word.length > bestLen)) {
          bestEnd = end;
          bestLen = word.length;
          bestCategory = category;
        }
      }
    }
  }

  return bestCategory;
}

// ---------------------------------------------------------------------------
// 渲染材料
// ---------------------------------------------------------------------------

/**
 * 生成"格式约束"（不是问句）：每条子句一条，供开写包渲染（v7.0.0）。
 * @param {string} direction 大纲方向行
 * @returns {Array<{clause:string, category:string, label:string, format:string}>}
 */
export function buildClauseFrames(direction) {
  const clauses = splitOutlineClauses(direction);
  return clauses.map(clause => {
    const category = classifyClause(clause);
    return {
      clause,
      category,
      label: CLAUSE_CATEGORIES[category] || CLAUSE_CATEGORIES[FALLBACK_CATEGORY],
      format: CLAUSE_FRAME_FORMAT
    };
  });
}

/**
 * 相关性门控用：这批子句里有没有某个类别（v7.0.0）。
 * @param {Array<{category?:string}>} frames buildClauseFrames 的结果
 * @param {string} category CLAUSE_CATEGORIES 的键
 * @returns {boolean}
 */
export function hasCategory(frames, category) {
  if (!Array.isArray(frames) || typeof category !== "string") return false;
  for (const frame of frames) {
    if (frame && frame.category === category) return true;
  }
  return false;
}