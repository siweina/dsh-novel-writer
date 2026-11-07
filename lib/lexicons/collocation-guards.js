/**
 * v7.0.0：细节密度词表的**上下文豁免层**（单一事实源）。
 *
 * 背景（六审/七审实测）：`analysis.js` 的 `DENSITY_ACTION_VERBS` / `DENSITY_OBJECT_WORDS` /
 * `DENSITY_SENSE` 全都是**单字正则**——「一点」里的「点」、「一样」里的「样」、「痛苦」里的「苦」、
 * 「干净」里的「干」、「温柔」里的「温」、「根本」里的「本」、「要被」里的「被」，
 * 都会被分别计成动作 / 视觉 / 嗅觉 / 触觉 / 温度 / 物件。真实书库里这些虚词占了命中的大头，
 * 于是"感官通道占比""动作链占比"这些结论其实是**词表的产物**，不是文本的特征。
 *
 * 这一层只做一件事：把"命中了但必须作废"的双字搭配集中登记，供 `densityOf` 在计数前
 * 先切出保护区。**它不是替代词表**——`style-metrics.js` 的动作表同样是单字驱动
 * （553 条 100% 单字），复用对方并不能解决噪声；两张表各自保留，只共用这一层豁免。
 *
 * 维护约束：
 *   1. 只登记"被匹配的那个字在这里不是信号"的搭配，不要登记整句；
 *   2. 每条都要能被 `test/density-precision-test.mjs` 的陷阱语料覆盖；
 *   3. 新增条目后必须跑该测试（精度跌破阈值即红）。
 */

/**
 * 口径标识：数值含义变化时同步递增，渲染到报告里，避免"同一章新旧数值混读"。
 *
 * v7.1.0：六维里的动作密度接入同一张豁免表（#46），`actionDensity` 整体下移
 * （实测「他直接走了。」2→1、「关系很好。」1→0、「他很开心。」1→0）。
 * 同时 `#63` 补了画面/书画/刻画/笔画/漫画/动画六条物件守卫。两条都改变数值含义，故升版。
 */
export const METRIC_CALIBER = "v7.1.0";

/**
 * 分通道豁免表。键与 `densityOf` 的通道名一致（action/object + 五个感官通道）。
 * 命中区间内出现的通道匹配一律不计。
 */
export const DENSITY_GUARDED_BIGRAMS = Object.freeze({
  // 「点/接/开/关/系/倒/合」等被高频虚词带走
  action: Object.freeze([
    "一点", "有点", "点点", "标点", "重点", "特点", "缺点", "优点", "观点", "起点", "终点",
    "接着", "直接", "连接", "链接", "间接", "接待", "接受", "接触", "接近", "交头接耳",
    "开始", "开心", "开关", "公开", "展开", "开会", "离开",
    "关系", "关心", "关于", "关注", "无关", "系列", "系统", "联系", "系数", "体系",
    "倒是", "倒不如", "合着", "合适", "符合", "结合", "合作", "综合", "组合",
    "走道", "走廊", "听说", "打听", "接踵"
  ]),
  // 「本/被/画/架/车/钟」等被词素或被动式带走
  object: Object.freeze([
    "根本", "原本", "本来", "本人", "本身", "本事", "本能", "成本", "资本", "基本",
    // v7.0.x（审查 #63）：注释早就列了「画」，配置行却留空 → 单字「画」在物件词表里裸奔。
    // 只登记"被匹配的「画」不是实物"的搭配：画面/动画是媒介，刻画是动词，笔画是笔画单位，
    // 书画/漫画是艺术门类/作品形态。真画（一幅画/水墨画/壁画）刻意**不**登记，仍计物件。
    // 「计划/规划/策划」不登记：它们含的是「划」不是「画」，不在任何密度通道词表里，
    // 登记进来就是死条目（density-precision-test ④ 会直接判红）。
    "画面", "书画", "刻画", "笔画", "漫画", "动画",
    "打架", "吵架", "招架", "架势",
    "脑袋", "钟头", "分钟", "车站"
  ]),
  // 「样/面/状」等被比较词、方位词带走
  visual: Object.freeze([
    "一样", "这样", "那样", "怎样", "同样", "模样", "什么样子", "样板",
    "状况", "状态", "症状", "状告", "形状",
    "面对", "面前", "里面", "外面", "上面", "下面", "前面", "后面", "方面",
    "场面", "局面", "体面", "面目", "片面", "全面"
  ]),
  // 「听/打听」这类非听声动作
  auditory: Object.freeze(["打听", "听说", "听凭"]),
  // 「气/苦/酸」被情绪词、抽象词带走
  olfactory: Object.freeze([
    "痛苦", "苦笑", "苦恼", "苦涩", "辛苦", "刻苦", "何苦", "吃苦", "挖苦",
    "语气", "力气", "空气", "口气", "生气", "客气", "脾气", "名气", "小气", "阔气",
    "气势", "气息", "气氛", "神气", "福气", "运气", "骨气",
    "心酸", "辛酸", "酸楚", "寒酸",
    "意味", "意味著", "意味着"
  ]),
  // 「干/麻/痛」被形容词、日常短语带走
  tactile: Object.freeze([
    "干净", "干脆", "干嘛", "干什么", "干扰", "干枯", "干燥", "干戈", "干笑",
    "麻烦", "麻木", "麻利", "麻辣", "芝麻", "肉麻",
    "心疼", "头痛", "头疼", "痛心", "痛快",
    // 跨通道："痛"在 tactile 表、"苦"在 olfactory 表，同一个词两侧都要挡
    "痛苦",
    "滑头", "滑稽", "硬是", "软禁", "干干"
  ]),
  // 「温/热/冷/凉」被性格词、情绪词带走
  temperature: Object.freeze([
    "温柔", "温和", "温度", "体温", "冷笑", "冷静", "冷漠", "冷淡", "冷清", "冷眼",
    "热闹", "热情", "热心", "热烈", "热切", "热衷", "眼热",
    "凉意", "凉薄", "凄凉", "悲凉", "炎凉",
    "暖意", "暖心", "温暖", "烫手", "烫嘴"
  ])
});

/** 通道名清单（导出给测试与报告用，避免各处各写一份） */
export const DENSITY_GUARD_CHANNELS = Object.freeze(Object.keys(DENSITY_GUARDED_BIGRAMS));

/** 供测试断言：总登记条数（新增/删除条目时该数字会变，测试里显式锁定） */
export function guardedEntryCount() {
  return DENSITY_GUARD_CHANNELS.reduce(function (n, ch) {
    return n + DENSITY_GUARDED_BIGRAMS[ch].length;
  }, 0);
}

/** 每通道「首字 → 该字开头的搭配（长度降序）」，用于**重叠也覆盖**的逐位扫描 */
const GUARD_BY_HEAD = new Map();
for (const ch of DENSITY_GUARD_CHANNELS) {
  const words = DENSITY_GUARDED_BIGRAMS[ch].slice().sort(function (a, b) { return b.length - a.length; });
  const byHead = new Map();
  for (const w of words) {
    if (!byHead.has(w[0])) byHead.set(w[0], []);
    byHead.get(w[0]).push(w);
  }
  GUARD_BY_HEAD.set(ch, byHead);
}

/**
 * 取某句在某通道下"必须作废"的字符区间。返回 `[[start, end), ...]`。
 *
 * v7.0.0 修正（审查实测）：「一点点」这类**重叠搭配**必须盖住每一个字。
 * 旧实现用一条 /g 正则 matchAll——「一点」消费 [0,2) 后游标推到 2，重叠的「点点」[1,3)
 * 永远匹配不到，第 3 个字逃出保护区（实测「他只有一点点犹豫」仍计 1 个动作动词）。
 * 现在改为**逐位按首字查表**：天然支持重叠，也不依赖 lastIndex 语义。
 */
export function guardRanges(sentence, channel) {
  const byHead = GUARD_BY_HEAD.get(channel);
  if (!byHead) return [];
  const s = String(sentence ?? "");
  const ranges = [];
  for (let i = 0; i < s.length; i += 1) {
    const cands = byHead.get(s[i]);
    if (!cands) continue;
    for (const w of cands) {
      if (s.startsWith(w, i)) {
        ranges.push([i, i + w.length]);
        break;
      }
    }
  }
  return ranges;
}

/** 位置 index 是否落在任一保护区间内 */
export function inRanges(ranges, index) {
  for (const r of ranges) {
    if (index >= r[0] && index < r[1]) return true;
  }
  return false;
}
