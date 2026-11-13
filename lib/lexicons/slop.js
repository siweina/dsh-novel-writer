/**
 * 陈词套话结构词表（dsh-novel-writer v7.0.0 · Phase 0「先修尺子」）
 *
 * ## 为什么需要这个模块
 *
 * 本插件此前**没有任何**套话/陈词词表：`analysis.js` 的密度尺子、风格六维、改稿清单只量句式与词性，
 * 于是「套话多不多」这件事从来没有被真正测过。七审（独立审查）在真实书库上实测后确认：
 * 此前所有"套话""密度"结论测的都是**词表**而不是**文本**——单字词表会把「一点」「根本」「温柔」
 * 算成动作/感官信号（对照 `test/density-precision-test.mjs` 的陷阱句）。所以这里补一张**结构级**词表：
 *
 *   · 只收"高确定性、低误报"的**结构片段**（`眼中闪过一丝` / `三分薄凉` / `倒吸一口凉气` /
 *     `毫无疑问`…），不做"情绪好坏"之类需要判断的评分，也不做任何改写；
 *   · **宁可漏报，也不误杀正常叙事**：「他冷冷地看着窗外。」「她温柔地笑了。」「他瞳孔里映着火光。」
 *     必须 0 命中（负样本见测试 ③）；
 *   · 命中只给**行号 + 类别 + 一句改法**，供改稿台定位。
 *
 * ## 口径（与调用方约定，改动即破坏契约）
 *
 *   · `line` 为 1-based 行号；`index` 为该行内 0-based **码点**偏移（emoji 不按 2 位算）；
 *   · `length` 是命中片段的码点数（未截断时的真实长度），`text` 截断到 24 字；
 *   · 同一行内区间**重叠**的命中只计 1 处，并保留**最长**的那条（v6.9.5 修过的重复计数缺陷）；
 *   · `densityPer1000` = 合并后处数 / 千字，分母用 `text.length`（与 `lib/analysis.js` 的
 *     `per1000` 同口径：含空白、保留一位小数）；
 *   · `ending_preach` 只扫**最后 2 个自然段**（按空行分段）；其余类别全文扫；
 *   · `skipQuoted` 默认 `true`，且只对 `ai_ese` / `abstract_tell` 跳过引号内台词——
 *     角色说「毫无疑问」是在塑造声线，不是 AI 腔；其余类别照常扫引号内。
 *
 * ## 正则安全纪律（测试逐条门禁）
 *
 *   · 所有 pattern 在**模块级预编译**；源码串以 `SLOP_RULES[].source` 暴露给测试；
 *   · 禁止嵌套量词；禁止 `.` 与 `.*` 上叠量词；禁止 `.*` / `[\s\S]*`（会跨句误报）；
 *     `{n,m}` 的 m 一律 ≤ 12；每一条都必须通过 `lib/core.js` 的 `validatePattern()`；
 *   · 需要"中间隔几个字"时写成有界的 `[^。！？\n]{0,4}`，**绝不放宽成 `.*`**。
 *
 * ## 维护纪律
 *
 * 新增 / 收窄 / 放宽任何一条，都**必须在 `test/slop-regex-safety-test.mjs` 里同时加正样本与负样本**：
 * 正样本证明它真的能命中真实网文句子，负样本证明它不误杀正常描写。只加正样本 = 迟早"宁可错杀"；
 * 只加负样本 = 词表变成空壳。改完跑 `node test/slop-regex-safety-test.mjs`。
 *
 * ## 已知边界（如实记录）
 *
 * `ending_preach` 的分段口径是**空行**（契约要求）。若某章只有一个自然段（段间只有单换行、没有空行），
 * 那"最后 2 段"退化为整章，该类别可能命中章中的预告句——这是口径的已知残留，不是漏检 bug；
 * 调用方若要严格章末，应先把章拆成段再传入。
 */

/** 8 个类别（键名固定，顺序即报告里的展示顺序） */
export const SLOP_CATEGORIES = Object.freeze({
  eye_cliche: "眼神/五官类陈词",
  smirk_cliche: "表情/嘴角类陈词",
  shock_crowd: "众人震惊类",
  filler_transition: "转折灌水类",
  abstract_tell: "抽象告知类（直接说情绪，不给反应）",
  ending_preach: "章末升华/预告类",
  ai_ese: "AI 翻译腔/公文腔",
  stat_numeric: "数值播报类"
});

/** 只扫章末的类别（最后 2 个自然段，按空行分段）。 */
const ENDING_ONLY = "ending_preach";

/** `skipQuoted` 默认静音的类别（引号内台词不按 AI 腔计）。 */
const QUOTE_MUTED = new Set(["ai_ese", "abstract_tell"]);

/** 命中片段的展示上限（码点）。 */
const MAX_SNIPPET = 24;

/**
 * 词表本体：`[类别, 正则源码, 改法提示]`。
 *
 * 每类 6~14 条，全部是"结构片段"而不是单个形容词——单个形容词（`冷笑`/`震惊`/`绝美`）
 * 在正常叙事里太常见，收进来就是误杀。提示语一律回答"该改成什么"。
 */
const RULE_SPECS = [
  // ── 眼神 / 五官类 ─────────────────────────────────────────────────────────
  ["eye_cliche", "眼[中里底]闪过一?[丝抹缕]", "改写成视线落点变化或手部接触到器物"],
  ["eye_cliche", "眼[中里底]掠过一?[丝抹缕]", "换成具体视线动作：抬眼、避开、盯住某物"],
  ["eye_cliche", "瞳孔(猛地|骤然)?一缩", "写身体反应本体：呼吸、手指、退半步"],
  ["eye_cliche", "眸光一?沉", "写目光落在何处、看了多久"],
  ["eye_cliche", "眸色一?深", "用动作替代：移开视线或垂下眼"],
  ["eye_cliche", "眼眶(一红|泛红|微红)", "写忍住的动作：吸气、别开脸"],
  ["eye_cliche", "眼神(暗|冷)了下去", "给出让读者自己判断的具体细节"],
  ["eye_cliche", "目光(微|一)凝", "写他看见了什么，而不是「凝」"],
  ["eye_cliche", "眼底(浮现|涌起)一?[丝抹缕]", "把这情绪落到具体物件或动作上"],
  ["eye_cliche", "眼神一凛", "写他对什么起了反应，别直接定性"],

  // ── 表情 / 嘴角类 ─────────────────────────────────────────────────────────
  ["smirk_cliche", "嘴角(勾起|扬起|挑起|弯起)", "改写成具体动作：放下杯子、转过脸"],
  ["smirk_cliche", "勾起一?[抹丝](弧度|笑意|冷笑)", "删掉「弧度」，只写他做了什么"],
  ["smirk_cliche", "三分(薄凉|凉薄|讥诮|嘲弄)", "把态度写进台词，别在旁白里下判语"],
  ["smirk_cliche", "似笑非笑", "直接写他笑了还是没笑"],
  ["smirk_cliche", "嘴角(噙着|挂着)一?[抹丝]", "换成有对象的表情：他对着谁笑"],
  ["smirk_cliche", "笑意不达眼底", "删掉判语，写眼睛在看哪里"],
  ["smirk_cliche", "笑容(渐渐)?凝固", "写他停住了哪个手上的动作"],
  ["smirk_cliche", "(笑意|笑容)(僵|凝)在(脸上|嘴角)", "写下一秒他改做了什么"],

  // ── 众人震惊类 ────────────────────────────────────────────────────────────
  ["shock_crowd", "倒吸一口(凉气|冷气)", "写某一个具体的人的动作与声音"],
  ["shock_crowd", "(全场|满座|众人|人群)(顿时|瞬间|一时)?(哗然|死寂|寂静|炸开了锅)", "删集体反应，只写主角看到的一个具体的人"],
  ["shock_crowd", "鸦雀无声", "写声音消失的过程：谁先停下"],
  ["shock_crowd", "(落针可闻|针落可闻)", "换成可听见的具体声音：滴水、喘息"],
  ["shock_crowd", "所有人(都)?(愣|怔|呆)住", "只写一个人的反应，其余人不必交代"],
  ["shock_crowd", "空气(仿佛|似乎)?(凝固|安静下来)", "写温度、声音或光线的变化"],
  ["shock_crowd", "面面相觑", "写谁看了谁一眼"],
  ["shock_crowd", "(众人|全场)(齐齐)?(一愣|一怔|一惊)", "只保留视角人物的反应"],

  // ── 转折灌水类 ────────────────────────────────────────────────────────────
  ["filler_transition", "就在(此|这)时", "删掉时间副词，直接写动作"],
  ["filler_transition", "说时迟", "直接写动作，不用评书套语"],
  ["filler_transition", "不知(为何|怎的)[，,]", "删掉「不知为何」，直接给因果"],
  ["filler_transition", "不知过了多久", "给出具体时间，或直接跳到下一幕"],
  ["filler_transition", "与此同时", "删掉，用动作承接场景切换"],
  ["filler_transition", "(转眼|转瞬)(间|之间)", "写实际过去的时间或景物变化"],
  ["filler_transition", "几乎同时", "删掉，写同一刻发生的两件事"],
  ["filler_transition", "下一秒[，,]", "删掉，直接写发生了什么"],
  ["filler_transition", "(话虽如此|话虽这么说)", "删掉转折语，直接写转折内容"],

  // ── 抽象告知类（直接说情绪，不给反应） ────────────────────────────────────
  ["abstract_tell", "心中一?[惊紧沉凛]", "写手上、呼吸上的具体变化"],
  ["abstract_tell", "(感到|觉得)一[阵股]", "写引起这感受的具体刺激"],
  ["abstract_tell", "莫名的(不安|恐惧|悲伤|烦躁)", "删掉「莫名」，指出不安的来源"],
  ["abstract_tell", "难以言(说|喻)的", "把「难以言说」换成具体细节"],
  ["abstract_tell", "五味杂陈", "挑一种情绪写透，其余留白"],
  ["abstract_tell", "说不出的(难受|滋味|苦涩)", "写难受时身体在做什么"],
  ["abstract_tell", "(绝望|恐惧|悲伤|寒意)(如潮水)?(般)?(涌|袭)来", "写身体先于情绪的反应"],
  ["abstract_tell", "心如死灰", "写他不再做什么，而不是下结论"],
  ["abstract_tell", "一种(说不上|莫名)的", "删掉模糊限定，直接给具体名词"],
  // 收窄过：裸的「不易察觉的」会误杀「一道不易察觉的裂缝」这类正常观察，
  // 只收它后面直接接**情绪/表情/身体反应**的形态（那才是套话现场）。
  ["abstract_tell", "不易察觉(的|地)(笑|叹|皱眉|失望|冷意|颤|僵|抽|抿)", "删掉「不易察觉」，让读者自己看出来"],

  // ── 章末升华 / 预告类（只扫最后 2 个自然段） ──────────────────────────────
  ["ending_preach", "(他|她)(并)?不知道[，,。]", "章末停在具体动作上，别预告他不知道"],
  ["ending_preach", "不知道的是", "删掉预告句，把镜头留在当下"],
  ["ending_preach", "命运的(齿轮|轨迹|转轮)", "删掉「命运」式总结，写眼前的事"],
  ["ending_preach", "一切[，,]?(才)?(刚刚|刚)开始", "把「才刚开始」换成正在发生的事"],
  ["ending_preach", "(不过)?只是个?(开始|序幕|序章)", "删掉「序幕」式预告，直接收束"],
  ["ending_preach", "(传奇|篇章|时代)(才)?(刚刚|刚)开始", "删掉传奇预告，写具体的结果"],
  ["ending_preach", "未来的路(还)?(很长|才刚开始)", "别替读者总结未来，收在当下"],
  ["ending_preach", "没有人(知道|会知道|能预料)", "删掉旁白预测，让读者自己去猜"],
  ["ending_preach", "仿佛(在|是)?预示(着)?", "删掉「预示」，把物象写具体"],
  ["ending_preach", "多年(以后|之后)", "不要跳到未来，章末留在当下"],

  // ── AI 翻译腔 / 公文腔 ────────────────────────────────────────────────────
  ["ai_ese", "毫无疑问", "删掉副词，直接给出判断"],
  ["ai_ese", "不可否认的是", "删掉「不可否认」，直接写事实"],
  ["ai_ese", "(值得|需要)(一提|注意)的是", "删掉公文提示语，直接说事"],
  ["ai_ese", "在某种(程度|意义)上", "删掉模糊限定，给出具体条件"],
  ["ai_ese", "从某种(角度|意义)(上)?(说|看)?", "改成「在他看来」，或直接删掉"],
  ["ai_ese", "对于(他|她|他们|我们)而言", "改成「对他来说」，或直接省略"],
  ["ai_ese", "事实上", "删掉，直接陈述事实"],
  ["ai_ese", "使得", "改成「让他…」，或直接顺接"],
  ["ai_ese", "伴随着", "改成「跟着 / 随着」"],
  ["ai_ese", "不可避免地", "改成「免不了」"],

  // ── 数值播报类 ────────────────────────────────────────────────────────────
  ["stat_numeric", "(提升|增加|增强)(了)?(近|约|足足)?[一二三四五六七八九十百千0-9]{1,4}(倍|成|%|％)", "改写具体后果：以前搬不动的现在能搬动"],
  ["stat_numeric", "[0-9]{1,6}[.]?[0-9]{0,3}(倍|%|％)", "数字播报改写成可感知的变化"],
  ["stat_numeric", "百分之[一二三四五六七八九十百千0-9]{1,6}", "改成「近一倍」，或干脆删掉数字"],
  ["stat_numeric", "(战斗力|生命值|法力值|精神力|属性)(值)?(达到|跌到|降到)", "别让面板数据代替叙事"],
  ["stat_numeric", "属性(面板|值)", "面板信息不要进正文叙述"],
  ["stat_numeric", "(暴涨|猛增|飙升)(了)?[^。！？\n]{0,4}(倍|成|%|％)", "写增长带来的具体画面"],
  ["stat_numeric", "(提升|增加)了?(近|约)?[一二三四五六七八九十百千0-9]{1,4}(点|个点)", "点数播报改成能力表现"],
  ["stat_numeric", "(修为|境界|力量|速度|防御)(提升|突破)(了)?(近|约)?[一二三四五六七八九十百千0-9]{1,4}(成|倍|点|重|级)", "写他做到了以前做不到的事"]
];

/**
 * 预编译后的词表（模块级常量，含 `g` 正则；扫描时逐行重置 `lastIndex`）。
 *
 * `source` 保留给测试逐条喂 `validatePattern()`——形状黑名单与经验探测都在那边，
 * 这里不自带第二套校验（单一事实源）。
 */
export const SLOP_RULES = Object.freeze(
  RULE_SPECS.map(([category, source, hint]) =>
    Object.freeze({ category, source, hint, re: new RegExp(source, "g") })
  )
);

/** 引号配对（中文引号 + ASCII 双引号；ASCII 单引号不收——中文正文里它几乎只出现在英文词里）。 */
const QUOTE_PAIRS = Object.freeze([["「", "」"], ["『", "』"], ["“", "”"], ['"', '"']]);
const OPEN_TO_CLOSE = new Map(QUOTE_PAIRS);

/**
 * 行内引号区间（`[start, end)`，UTF-16 偏移）。
 *
 * 支持嵌套与对称引号；**未闭合的引号一路延到行尾**——宁可多静音（漏报），
 * 也不把台词当成叙述（误杀）。
 */
function quotedRanges(line) {
  const out = [];
  const stack = [];
  let start = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (stack.length === 0) {
      if (OPEN_TO_CLOSE.has(ch)) { stack.push(ch); start = i; }
      continue;
    }
    const open = stack[stack.length - 1];
    if (ch === OPEN_TO_CLOSE.get(open)) {
      stack.pop();
      if (stack.length === 0 && start >= 0) { out.push([start, i + 1]); start = -1; }
    } else if (OPEN_TO_CLOSE.has(ch) && ch !== open) {
      stack.push(ch);
    }
  }
  if (start >= 0) out.push([start, line.length]);
  return out;
}

/** 区间 `[start, end)` 是否与任一引号区间相交。 */
function intersectsRanges(ranges, start, end) {
  for (const [s, e] of ranges) if (start < e && end > s) return true;
  return false;
}

/**
 * 最后 2 个自然段所覆盖的行下标（0-based）。
 *
 * 段落 = 连续的非空内容行（剔除 Markdown 标题与分割线，与 analysis.splitBlocks 同口径）；
 * 空行（含只含空白的行）是段落分隔符。
 * 若全章超过 4 行内容却没有任何空行分隔（单换行分段的整章），退化为按单行分段取最后 2 行内容行，
 * 避免第 1 行的「但他不知道」被当成章末升华误报；短片段（≤4 行内容）仍视作同一末段。
 */
function endingLineSet(lines) {
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (/^#{1,6}\s/.test(t) || /^[-_*=]{3,}$/.test(t)) continue;
    kept.push({ index: i, empty: t === "" });
  }
  const contentIndices = kept.filter((k) => !k.empty).map((k) => k.index);
  if (contentIndices.length === 0) return new Set();
  const firstPos = kept.findIndex((k) => !k.empty);
  let lastPos = -1;
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    if (!kept[i].empty) { lastPos = i; break; }
  }
  const hasBlank = kept.some((k, idx) => k.empty && idx > firstPos && idx < lastPos);
  if (!hasBlank && contentIndices.length > 4) {
    return new Set(contentIndices.slice(-2));
  }
  const paragraphs = [];
  let current = null;
  for (const k of kept) {
    if (k.empty) { current = null; continue; }
    if (!current) { current = []; paragraphs.push(current); }
    current.push(k.index);
  }
  const set = new Set();
  for (const paragraph of paragraphs.slice(-2)) for (const i of paragraph) set.add(i);
  return set;
}

/**
 * UTF-16 偏移 → 行内**码点**偏移。
 *
 * 纯 BMP 行（绝大多数中文正文）直接返回入参；只有出现代理对（emoji 等）时才逐字折算，
 * 否则 `index` 会比读者数出来的位置多 1。
 */
function codepointIndex(line, utf16Index, hasAstral) {
  if (utf16Index <= 0) return 0;
  if (!hasAstral) return utf16Index;
  let count = 0;
  for (let i = 0; i < utf16Index && i < line.length; i += 1) {
    const code = line.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < line.length) i += 1;
    count += 1;
  }
  return count;
}

/**
 * 同一行内按区间合并：重叠的命中只留一条，取**最长**的那条（等长取靠前者）。
 *
 * 这条规则来自 v6.9.5 修过的重复计数缺陷：同一次"套话现场"被两条规则各报一次，
 * 密度立刻虚高。合并后的 `text`/`hint`/`category` 全部来自被保留的那一条。
 */
function mergeOverlaps(raw) {
  const sorted = raw.slice().sort((a, b) => a.line - b.line || a.start - b.start || b.end - a.end);
  const out = [];
  let cluster = null;
  for (const m of sorted) {
    if (cluster && m.line === cluster.line && m.start < cluster.end) {
      if (m.end > cluster.end) cluster.end = m.end;
      if (m.end - m.start > cluster.best.end - cluster.best.start) cluster.best = m;
      continue;
    }
    if (cluster) out.push(cluster.best);
    cluster = { line: m.line, start: m.start, end: m.end, best: m };
  }
  if (cluster) out.push(cluster.best);
  return out;
}

/** 系统流/无限流/网游数据流题材识别式（命中时自动豁免 stat_numeric 数值播报类） */
const SYSTEM_GENRE_RE = /系统|无限|网游|数据面板|属性面板|游戏异界|数据流|面板流/;

/**
 * 扫描一段正文。
 * @param {string} text
 * @param {{
 *   skipQuoted?: boolean,
 *   muteCategories?: Iterable<string>,
 *   exemptRules?: Iterable<string>,
 *   genre?: string
 * }} [opts] skipQuoted 默认 true：
 *   只对 ai_ese / abstract_tell 两类跳过引号内台词（角色说「毫无疑问」是在塑造声线，不是 AI 腔）；
 *   其余类别照常扫引号内。muteCategories / exemptRules 支持按题材或原著高频习惯词豁免。
 * @returns {{
 *   hits: Array<{category:string, line:number, index:number, length:number, text:string, hint:string}>,
 *   byCategory: Record<string, number>,
 *   total: number,
 *   densityPer1000: number,
 *   lines: number
 * }}
 * line 为 1-based 行号；index 为该行内 0-based 码点偏移；text 是命中的原文片段（不超过 24 字）。
 * densityPer1000 = 合并重叠后的"处数" / 千字（分母用 text.length，与 lib/analysis.js 的 per1000 同口径）。
 */
export function scanSlop(text, opts) {
  // v7.3.3 修（#14）：入口统一把 CRLF / CR 归一成 LF，行号语义与 novel_read / splitBlocks 一致。
  // 旧实现直接按 "\n" 切：CRLF 时每行末尾多一个 \r（长度与 densityPer1000 分母漂移，同一份正文
  // LF 50 字 / CRLF 55 字 → 密度 60.0 / 54.5）；纯 CR 时整章被当成 1 行 → lines=1、所有命中行号塌成 1
  // （ending_preach 这类「章末专属」类别因此看起来命中章首，chapter-diagnose 按行区间过滤末段命中也会漏）。
  // 归一后三种换行给出相同的 lines / hit.line / densityPer1000。
  const raw0 = typeof text === "string" ? text : text == null ? "" : String(text);
  const src = raw0.replace(/\r\n?/g, "\n");
  const skipQuoted = !(opts && opts.skipQuoted === false);
  const mutedCats = new Set(opts && opts.muteCategories ? opts.muteCategories : []);
  if (opts && typeof opts.genre === "string" && SYSTEM_GENRE_RE.test(opts.genre)) {
    mutedCats.add("stat_numeric");
  }
  const exemptSources = new Set(opts && opts.exemptRules ? opts.exemptRules : []);
  const lines = src === "" ? [] : src.split("\n");
  const endingLines = endingLineSet(lines);

  const raw = [];
  const astralLines = [];
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    // 纯 BMP 行（绝大多数中文正文）不需要逐字折算码点；含 emoji 的行才要
    astralLines.push(/[\uD800-\uDBFF]/.test(line));
    if (line === "") continue;
    const endingAllowed = endingLines.has(li);
    const quotes = skipQuoted ? quotedRanges(line) : null;
    for (const rule of SLOP_RULES) {
      if (mutedCats.has(rule.category)) continue;
      if (exemptSources.has(rule.source)) continue;
      if (rule.category === ENDING_ONLY && !endingAllowed) continue;
      const re = rule.re;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (m[0] === "") { re.lastIndex += 1; continue; }
        const start = m.index;
        const end = start + m[0].length;
        if (quotes && QUOTE_MUTED.has(rule.category) && intersectsRanges(quotes, start, end)) continue;
        raw.push({
          category: rule.category,
          line: li + 1,
          start,
          end,
          hint: rule.hint
        });
      }
    }
  }

  // mergeOverlaps 返回的是每个重叠簇里**被保留的那条**（最长者），不是簇本身。
  const hits = mergeOverlaps(raw).map((best) => {
    const line = lines[best.line - 1] || "";
    const matched = Array.from(line.slice(best.start, best.end));
    return {
      category: best.category,
      line: best.line,
      index: codepointIndex(line, best.start, astralLines[best.line - 1] === true),
      length: matched.length,
      text: matched.slice(0, MAX_SNIPPET).join(""),
      hint: best.hint
    };
  });

  const byCategory = {};
  for (const category of Object.keys(SLOP_CATEGORIES)) byCategory[category] = 0;
  for (const hit of hits) {
    if (Object.prototype.hasOwnProperty.call(byCategory, hit.category)) byCategory[hit.category] += 1;
  }

  const total = hits.length;
  return {
    hits,
    byCategory,
    total,
    densityPer1000: Math.round((total / Math.max(src.length, 1)) * 1000 * 10) / 10,
    lines: lines.length
  };
}

/**
 * 生成侧用：取命中频次最高的前 n 个**类别**。
 *
 * 刻意返回类别键、不返回命中原文——把原句喂回生成侧会诱发"照抄这批陈词"
 * （负样本/示例污染）。频次相同按 `SLOP_CATEGORIES` 的展示顺序排，保证结果稳定。
 *
 * @param {Array<{category:string}>} hits `scanSlop().hits`
 * @param {number} [n=3] 取前几类；非法值退回 3，`0` 返回空数组
 * @returns {string[]} 类别键（是 `SLOP_CATEGORIES` 的键，不是原文）
 */
export function topSlopCategories(hits, n) {
  const counts = new Map();
  const list = Array.isArray(hits) ? hits : [];
  for (const hit of list) {
    const category = hit && typeof hit.category === "string" ? hit.category : "";
    if (category === "") continue;
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  const order = Object.keys(SLOP_CATEGORIES);
  const rank = (category) => {
    const at = order.indexOf(category);
    return at === -1 ? order.length : at;
  };
  const limit = Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 3;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0]))
    .slice(0, limit)
    .map(([category]) => category);
}

/**
 * 8 个类别的生成侧**模式级处方**（只描述写法模式与替身动作，不出现具体套话词面，防负样本污染）。
 */
export const SLOP_CATEGORY_PRESCRIPTIONS = Object.freeze({
  eye_cliche: "避免【以眼神闪过某种情绪代替反应】这类写法：改成视线落点变化，或手部接触到器物的动作。",
  smirk_cliche: "避免【靠嘴角弧度或几分薄凉交代态度】这类表情陈词：改成放下器物、转过脸或直接把态度写进台词。",
  shock_crowd: "避免【全场寂静或众人齐齐震惊】这类群体烘托：只写视角人物看到的一个具体的人的动作与声音。",
  filler_transition: "避免【靠空洞时间副词硬切场面】这类转折灌水：删掉过渡套语，直接用动作或器物变化切入下一幕。",
  abstract_tell: "避免【直接在旁白里点破心中情绪】这类抽象告知：写呼吸、手部或碰触器物的具体身体反应。",
  ending_preach: "避免【在章末预告命运或总结未来】这类升华陈词：章末必须停在未完动作、异响或半句话上。",
  ai_ese: "避免【公文式判断与翻译腔连接词】这类句式：删掉模糊限定副词，直接陈述事实与动作。",
  stat_numeric: "避免【用倍数或百分比播报实力变化】这类数值说明：把数字改写成可感知的具体后果。"
});

/**
 * 根据命中列表或类别键数组生成针对性的套话处方文案（最多取前 2 类拼合）。
 * @param {Array<string|{category:string}>} [categoriesOrHits]
 * @returns {string}
 */
export function describeSlopPrescription(categoriesOrHits) {
  const list = Array.isArray(categoriesOrHits) ? categoriesOrHits : [];
  const cats = list.length > 0 && typeof list[0] === "string"
    ? list.filter((k) => Object.prototype.hasOwnProperty.call(SLOP_CATEGORY_PRESCRIPTIONS, k)).slice(0, 2)
    : topSlopCategories(list, 2).filter((k) => Object.prototype.hasOwnProperty.call(SLOP_CATEGORY_PRESCRIPTIONS, k));
  if (cats.length === 0) return SLOP_CATEGORY_PRESCRIPTIONS.eye_cliche;
  if (cats.length === 1) return SLOP_CATEGORY_PRESCRIPTIONS[cats[0]];
  return SLOP_CATEGORY_PRESCRIPTIONS[cats[0]].replace(/。$/, "；") + SLOP_CATEGORY_PRESCRIPTIONS[cats[1]];
}

/**
 * 从参照集文本与作品设定中提取套话豁免配置：
 *   ① 参照集高频习惯词豁免：在参照集中总字数 ≥ 500、命中 ≥ 2 次且密度 ≥ 0.5 处/千字的规则（章末升华除外），
 *      视为原作者个人习惯写法，加入 `exemptRules`；
 *   ② 题材开关：设定或题材含系统流/无限流/网游面板关键词时，自动将 `stat_numeric` 加入 `muteCategories`。
 *
 * @param {string|Array<string|{text?:string}>} referenceText
 * @param {{ genre?: string, settings?: object, minChars?: number, densityFloorPer1000?: number, minCount?: number }} [opts]
 * @returns {{ exemptRules: string[], muteCategories: string[] }}
 */
export function buildSlopExemptions(referenceText, opts) {
  const muteCategories = new Set();
  const genreParts = [];
  // v7.0.0 修正（文档核对时发现）：三处调用传的是**原创设定对象**（creationProfile），不是字符串，
  // 而这里原先只接受 `typeof === "string"`，于是「题材静音」这条**根本没生效过**——
  // 实际只有 settings.worldview 的条目在起作用。现在同时接受字符串与对象（取 genre/worldview/mainConflict/extra 四个正文字段）。
  const genreArg = opts && opts.genre;
  if (typeof genreArg === "string") {
    genreParts.push(genreArg);
  } else if (genreArg && typeof genreArg === "object") {
    for (const key of ["genre", "worldview", "mainConflict", "extra"]) {
      const v = genreArg[key];
      if (typeof v === "string" && v !== "") genreParts.push(v);
    }
  }
  const settings = opts && opts.settings && typeof opts.settings === "object" ? opts.settings : null;
  if (settings && Array.isArray(settings.worldview)) {
    for (const w of settings.worldview) {
      if (!w || typeof w !== "object") continue;
      for (const f of [w.name, w.basis, w.description, w.notes]) {
        if (typeof f === "string" && f !== "") genreParts.push(f);
      }
    }
  }
  if (SYSTEM_GENRE_RE.test(genreParts.join(" "))) {
    muteCategories.add("stat_numeric");
  }

  const refCorpus = Array.isArray(referenceText)
    ? referenceText.map((item) => (typeof item === "string" ? item : String(item?.text ?? ""))).join("\n")
    : typeof referenceText === "string"
      ? referenceText
      : "";
  const minChars = Number.isFinite(Number(opts?.minChars)) ? Number(opts.minChars) : 500;
  const floor = Number.isFinite(Number(opts?.densityFloorPer1000)) ? Number(opts.densityFloorPer1000) : 0.5;
  const minCount = Number.isFinite(Number(opts?.minCount)) ? Number(opts.minCount) : 2;
  const exemptRules = [];
  if (refCorpus.length >= minChars) {
    for (const rule of SLOP_RULES) {
      if (rule.category === ENDING_ONLY || muteCategories.has(rule.category)) continue;
      const re = rule.re;
      re.lastIndex = 0;
      let count = 0;
      let m;
      while ((m = re.exec(refCorpus)) !== null) {
        if (m[0] === "") { re.lastIndex += 1; continue; }
        count += 1;
      }
      if (count >= minCount && (count / refCorpus.length) * 1000 >= floor) {
        exemptRules.push(rule.source);
      }
    }
  }
  return { exemptRules, muteCategories: [...muteCategories] };
}