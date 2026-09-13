/**
 * v2.1.0 气质聚合层：把插件各工具的已有输出（detect 词频/题材、情感净化、
 * 情感量化 V/Δ/C、意象极性/歧义、语义隐性情感）汇总成"氛围光谱"（12 轴）。
 * 纯规则加权 0 token；不做"贴标签"，只输出数值坐标 + 组合结论 + 证据链。
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
// v3.9.1：语义隐性情感原型的 label 契约直接引用 embedding.js（消除手抄漂移；embedding.js 不 import vibe.js，无循环依赖）
// v4.3.0：一并引用 MODEL_NAME——styleproto 缓存 payload 需写入模型标识（与索引缓存 {model,dim} 校验口径一致）
import { IMPLICIT_EMOTION_PROTOTYPES, MODEL_NAME as EMBED_MODEL_NAME } from "./embedding.js";

const require = createRequire(import.meta.url);
// v2.6.0 审查修复：zstd 条件获取，不可用时缓存回退纯 JSON（插件照常加载）
// v3.9.1 注释修正：Node 实际在 v23.8.0 才引入 zlib 的 zstd（并非 22.3）；22.3–23.7 及更旧版本自动回退纯 JSON 是安全设计
let zstdCompressSync = null;
let zstdDecompressSync = null;
try {
  const zlib = require("node:zlib");
  if (typeof zlib.zstdCompressSync === "function") {
    zstdCompressSync = zlib.zstdCompressSync;
    zstdDecompressSync = zlib.zstdDecompressSync;
  }
} catch { /* 旧 Node：回退纯 JSON 缓存 */ }

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** 解析 evidence 词频数组 → { 词: 次数 }
 * v4.3.0 注释修正（E10b）：原正则 /^(.+?)(?:×|\u00d7)(\d+)$/ 的两个分支是同一个字符（× 即 U+00D7），
 * 冗余分支删除；匹配行为逐字节不变。 */
function parseFreq(arr) {
  const out = {};
  for (const item of arr || []) {
    const m = String(item).match(/^(.+?)×(\d+)$/);
    if (m) out[m[1]] = parseInt(m[2], 10);
    else out[String(item)] = 1;
  }
  return out;
}

/** v4.3.0 死代码清理：删除 freqIn() —— 它唯一的调用点（absurd 词群计数）已改为直扫全文的 countHits，
 * 留着就是"看着有人用、实际无人用"的死函数。 */

/** v3.9.1 M21 本地全文直扫：indexOf 逐词计数（每词独立计出现次数，不依赖 detect.evidence 文化词表）。
 * v4.3.0 修复（E6）：游标改 from += 1（重叠计数）——旧版 from += w.length 是非重叠口径，与下方 textWordCounts
 * 的重叠 n-gram 口径不一致（实测 "甜甜甜甜甜甜"：textWordCounts=5 而 countHits=3，同一个词表两套次数）。
 * 统一为重叠口径后，重复字串文本的证据词命中数上升（如 "甜甜甜" 1→2 次）：AXIS_EVIDENCE_WORDS 门控按
 * 0.06 分/词、needBase≈0.1 计算，会更早打开（"甜甜甜"+甜宠题材 从"不联动"变为 0.12≥0.1 联动），
 * dark/blaze 的正文词群分与 axisEvidence 门控随之变化——对老报告的可比性影响见 CHANGELOG v4.3.0 行为变化清单。 */
function countHits(text, words) {
  const src = String(text ?? "");
  let total = 0;
  for (const w of words) {
    let from = 0;
    while ((from = src.indexOf(w, from)) !== -1) {
      total += 1;
      from += 1;
    }
  }
  return total;
}

// v3.9.1：原型 label → 10 轴显式映射表（与 embedding.js IMPLICIT_EMOTION_PROTOTYPES 的 29 个 label 对齐；
// absurd/blaze 两个旧轴及其"震惊:absurd"映射已删——无人消费；剩 10 轴）
const SEM_AXIS_BY_EMOTION = Object.freeze({
  脆弱: "nightmare", 恐惧: "nightmare", 不安: "nightmare",
  焦虑: "angst", 隐忍: "angst", "压抑的愤怒": "angst", 无奈: "angst",
  温暖: "heartwarming", 温柔: "heartwarming", 幸福: "heartwarming", 甜蜜: "heartwarming", 释然: "heartwarming", 仰慕: "heartwarming",
  失落: "tearjerker", 悲伤: "tearjerker", 怅惘: "tearjerker", 心碎: "tearjerker", 不舍: "tearjerker", 眷恋: "tearjerker", 苦涩: "tearjerker",
  孤独: "lonesome", 疏离: "lonesome", 决绝: "lonesome",
  厌恶: "dark",
  // v4.0.0 修正：原型表里的"震惊"此前无映射 → 每次加载都触发契约告警且该标签信号被丢弃；归入悬疑神秘轴
  震惊: "mystery",
  // v3.5.0 M7：近义近似映射（原型无 4 轴域，语义信号不再恒 0）
  甜宠: "fluff", 悬疑: "mystery", 唯美: "aesthetic", 情欲: "sensual"
});
const SEM_AXIS_KEYS = Object.freeze(["nightmare", "angst", "heartwarming", "fluff", "tearjerker", "dark", "mystery", "lonesome", "aesthetic", "sensual"]);
const SEM_WARNED = new Set();
/** 契约失配只 console.warn 一次（每缺陷一条），不刷屏。 */
function warnSemContractOnce(msg) {
  if (SEM_WARNED.has(msg)) return;
  SEM_WARNED.add(msg);
  console.warn("[novel-writer] 语义隐性情感映射契约失配: " + msg + "（该标签已跳过）");
}

/** 语义隐性情感分布 → 各轴信号（分布计数按传入 dist 的键做；v3.9.1 引入原型 label 一致性检查）。 */
function semSignals(dist) {
  const s = {};
  for (const k of SEM_AXIS_KEYS) s[k] = 0;
  const labelSet = new Set(IMPLICIT_EMOTION_PROTOTYPES.map((p) => p.emotion));
  // 一致性检查：映射表缺 label（原型多出未映射 label）或映射了原型没有的 label 都告警并跳过
  for (const proto of IMPLICIT_EMOTION_PROTOTYPES) {
    const axis = SEM_AXIS_BY_EMOTION[proto.emotion];
    if (axis === undefined) warnSemContractOnce("原型 label 未映射: " + proto.emotion);
    else if (!SEM_AXIS_KEYS.includes(axis)) warnSemContractOnce("label→轴指向不存在: " + proto.emotion + "→" + axis);
  }
  for (const [label, axis] of Object.entries(SEM_AXIS_BY_EMOTION)) {
    if (!labelSet.has(label)) warnSemContractOnce("映射表含原型没有的 label: " + label);
    else if (!SEM_AXIS_KEYS.includes(axis)) warnSemContractOnce("轴不存在: " + axis);
  }
  for (const [k, v] of Object.entries(dist || {})) {
    const axis = SEM_AXIS_BY_EMOTION[k];
    if (axis && SEM_AXIS_KEYS.includes(axis)) s[axis] += Number(v) || 0;
  }
  return s;
}

// v2.2.0 网文动作/对话/套路词群（参考 webnovel-writer genre-tropes 精选，封顶权重防污染）
const WEB_NOVEL_SIGNALS = {
  // 词源标注：★=genre-tropes.md 现成套路词（lib/lexicons/webnovel-tropes.md），无标注=补充词
  // v2.5.0 修复轮 7：单字词全部改双字（"战/杀/血/死/慌/怕/疼/腻/查"等命中普通词会误判）
  fluff: ["宝贝", "老婆", "亲爱的", "宠溺", "宠着", "哄着", "哄她", "撒娇", "搂住", "搂着", "亲吻", "吻住", "抱紧", "摸头", "甜甜", "甜蜜", "心头一软", "小傻瓜", "乖乖", "甜宠★", "拉扯★", "白月光★"],
  tearjerker: ["心碎", "对不起", "眼泪", "分手", "绝望", "崩溃★", "哽咽", "追妻★", "火葬场★", "求你", "别走", "心疼", "悔婚★", "虐心★", "决绝★", "卑微★", "挽回★", "拒绝★", "替身★"],
  blaze: ["冲锋", "斩杀", "轰鸣", "燃烧", "震碎", "战意", "怒吼", "碾压", "横扫", "秒杀★", "一招", "吞噬★", "越级★", "击杀★", "暴涨★", "大比★", "秘境★", "夺宝★", "宗门★", "练气★", "筑基★", "突破", "绝技★", "凶兽★", "宝物★", "金手指★", "天才★", "觉醒★", "传承★", "武道★", "念力★", "雷电★", "火焰★", "超能力★", "医术★", "体质★", "戒指★", "老爷爷★", "重生★", "签到★"],
  // v4.3.0 修复（E10d）：两张表口径统一——原型标签「震惊」在 SEM_AXIS_BY_EMOTION 里归 mystery（v4.0.0 起，
  // 依据是"惊→悬疑惊悚"的语义轴归属，且 v3.9.1 已删除旧的 震惊:absurd 映射），而网文套路词「震惊★」此前
  // 仍留在 absurd 词群里，同 release 两张表相反归属（纯"震惊"文本 absurd 0.182 > mystery 0.044）。
  // 现把 震惊★ 迁到 mystery（与同为"惊"系的 震撼★ 同轴），使词群轴与原型映射轴一致。
  absurd: ["离谱", "无语", "笑死", "尴尬", "吐槽", "什么鬼", "疯了", "惊了", "搞什么", "还有这种", "打脸★", "装逼★", "扮猪吃虎★", "嘲讽★", "下跪★", "跪地★", "退婚★", "废物★", "赌石★", "透视★", "隐藏身份★", "高攀不起", "悔婚★", "看不起★"],
  nightmare: ["诡异", "毛骨悚然", "不祥", "低语", "畸形", "腐烂", "扭曲", "窒息", "心悸", "不对劲", "渗人", "爬行", "凶兽★"],
  angst: ["完了", "完了完了", "怎么办", "发抖", "紧张", "不安", "慌张", "慌乱", "害怕", "惧怕", "救命"],
  heartwarming: ["温柔", "安心", "踏实", "轻声", "轻轻", "抚摸", "哄睡", "暖意", "治愈"],
  mystery: ["线索", "真相", "谜团", "疑点", "秘密", "调查", "发现", "蛛丝马迹★", "身份反转★", "震撼★", "震惊★"],
  dark: ["鲜血", "尸体", "死亡", "屠杀", "血泊", "杀戮", "折磨", "地狱", "残忍", "冷血"],
  lonesome: ["一个人", "独自", "没人", "寂寞", "想家", "陌生", "空荡荡", "孤零零"],
  aesthetic: ["月色", "清辉", "烟雨", "荷塘", "落英", "余韵", "浮光", "静默", "素净", "微凉", "风过", "细碎"],
  sensual: ["呼吸", "发烫", "贴近", "肌肤", "颤栗", "酥麻", "灼热", "喘息", "缠绕", "柔软", "耳畔", "温存"]
};
// v3.5.0 H1b：词表统一剥 ★ 字尾（模块加载时一次；★ 是词源标注，带星号永不命中——61 个词大面积作废）
for (const axis of Object.keys(WEB_NOVEL_SIGNALS)) {
  WEB_NOVEL_SIGNALS[axis] = WEB_NOVEL_SIGNALS[axis].map(function (w) { return w.replace(/★$/, ""); });
}
// v4.3.0 修复（E3）：题材 token 必须落在 THEME_MARKERS 的键值域内——linkThemes 只比对 detect.theme 的键
// （themes.includes(t)）与 dominant 子串（theme.includes(t)），**不看 genre**。原表中的 现言/替身/仙侠/奇幻
// 在键值域里既无相等项也无包含项 → 恒不命中（4 个 token 是死字面量）：
//   现言   → 现代言情在表中不是独立题材键，改指真实键 "甜宠"（同属现言甜向，且与原型映射 甜宠→fluff 一致）；
//   替身   → 无此题材键，其义已由 AXIS_EVIDENCE_WORDS.tearjerker 的"替身"证据词覆盖，故直接删除该 token；
//   仙侠/奇幻 → 属 GENRE_MARKERS 的流派名而非题材键，改指覆盖它们的真实题材键 "玄幻修仙"/"西幻"。
// 若日后要让流派名参与联动，必须显式把 genre 纳入判定并在此注释写明优先级（当前设计：只看题材键，流派不参与）。
const THEME_AXIS_LINK = [
  { themes: ["豪门总裁", "总裁", "甜宠"], axis: "fluff", bonus: 0.2, needBase: 0.1 },
  { themes: ["虐恋"], axis: "tearjerker", bonus: 0.25, needBase: 0.1 },
  { themes: ["系统流"], axis: "absurd", bonus: 0.2, needBase: 0.1 },
  { themes: ["系统流"], axis: "blaze", bonus: 0.15, needBase: 0.1 },
  { themes: ["玄幻修仙", "西幻"], axis: "blaze", bonus: 0.2, needBase: 0.1 },
  { themes: ["都市"], axis: "absurd", bonus: 0.1, needBase: 0.08 },
  { themes: ["恐怖灵异"], axis: "nightmare", bonus: 0.3, needBase: 0.1 },
  { themes: ["悬疑推理"], axis: "mystery", bonus: 0.3, needBase: 0.1 },
  { themes: ["克苏鲁", "怪谈"], axis: "nightmare", bonus: 0.25, needBase: 0.1 },
  { themes: ["发疯文学"], axis: "absurd", bonus: 0.3, needBase: 0.08 }
];

// v4.0.0 新增：题材联动的「内容证据」词表。linkThemes 只认轴自身的内容证据（正文实义用词 +
// 轴专属语义信号）；默认推送（clean=*/意象/趋势等无条件基础分）与题材标签本身都不再算证据，
// 否则"只有标签、正文无对应用词"的文本也会白拿题材加成。每命中一个词计 0.06 分（权重 1.5），
// 单提一句（1 词 = 0.06 < needBase≈0.1）不触发，2 个词起才生效。
const AXIS_EVIDENCE_WORDS = Object.freeze({
  nightmare: ["诡异", "毛骨悚然", "不祥", "低语", "畸形", "腐烂", "扭曲", "窒息", "心悸", "不对劲", "渗人", "爬行", "阴森", "恐怖", "惊悚", "灵异", "幽灵", "鬼影", "噩梦", "尖叫", "血腥", "凶宅", "诅咒", "棺材", "腐臭", "怨气", "尸体", "尸骨", "阴气", "触手", "邪神", "献祭", "深渊"],
  fluff: ["宝贝", "老婆", "亲爱的", "宠溺", "宠着", "哄着", "哄她", "撒娇", "搂住", "搂着", "亲吻", "吻住", "抱紧", "摸头", "甜甜", "甜蜜", "心头一软", "小傻瓜", "乖乖", "白月光", "情话", "告白", "恋爱", "宠爱", "未婚妻", "未婚夫", "订婚", "豪门", "总裁", "董事", "秘书", "别墅"],
  tearjerker: ["心碎", "眼泪", "分手", "绝望", "崩溃", "哽咽", "追妻", "火葬场", "求你", "别走", "心疼", "虐心", "卑微", "挽回", "替身", "哭泣", "流泪", "痛哭", "泪流", "哭腔", "断肠", "泪痕", "诀别", "背叛", "误会", "冷暴力", "离婚", "前妻", "前夫"],
  blaze: ["战斗", "冲锋", "斩杀", "刀光", "剑影", "铁拳", "战意", "厮杀", "刀剑", "拳风", "刀锋", "剑锋", "热血", "烈焰", "战鼓", "号角", "拔剑", "挥剑", "挥刀", "杀伐", "轰鸣", "碾压", "横扫", "秒杀", "越级", "秘境", "宗门", "筑基", "绝技", "凶兽", "武道", "雷电", "火焰", "丹田", "灵根", "渡劫", "法宝", "灵力", "真气", "修炼", "境界", "丹药", "仙尊", "魔尊", "剑修"],
  absurd: ["离谱", "无语", "笑死", "吐槽", "什么鬼", "搞什么", "还有这种", "打脸", "装逼", "扮猪吃虎", "嘲讽", "下跪", "跪地", "退婚", "废物", "赌石", "透视", "隐藏身份", "高攀不起", "看不起", "沙雕", "摆烂", "破防", "躺平", "发疯", "系统", "签到", "面板", "积分", "兑换", "抽奖", "宿主", "金手指"],
  mystery: ["密室", "线索", "凶手", "疑点", "谜团", "推理", "侦破", "不在场证明", "案发", "尸体", "指纹", "监控", "嫌疑人", "作案", "动机", "凶器", "目击", "报案", "尸检", "悬案", "毒杀", "失踪", "暗号", "密码"]
});

/**
 * @param {object} detect  novel_settings detect 的输出（culture/scores/evidence/genre/theme）
 * @param {object} emotion novel_sentence_analysis 的 emotion 块
 * @returns 氛围光谱 { axes, top, conclusion, confidence, evidence }
 */
export function computeVibe(detect, emotion, text = "") {
  // v3.9.0 修正：外部直接传 null/undefined 不抛（v3.8 的 if (text) 防御恢复）
  text = typeof text === "string" ? text : String(text ?? "");
  const ev = detect.evidence || {};
  const wF = parseFreq(ev.western || []);
  const mF = parseFreq(ev.modern || []);
  const theme = detect.theme?.dominant || "";
  const themes = (detect.theme?.themes || []).map((t) => t.theme);
  const genre = detect.genre?.dominant || "";

  const q = emotion.quantification || {};
  const implicit = q.implicit || {};
  const dist = q.semanticImplicit?.distribution || {};
  const sem = semSignals(dist);
  const clean = emotion.cleanDominant || emotion.dominant || "";
  const delta = q.stats?.delta ?? 0;
  // v4.3.0（父代理裁决）：轴加权一律用「已裁决两分口径」negHits/(negHits+posHits)。
  // 理由：上游 analysis.js 的 implicit.negative/positive 已改为三分分母（neg/(neg+pos+amb)，见该文件 v4.3.0 P1-4 注释），
  // 而 12 轴把它们当加权项（nightmare/angst/heartwarming/fluff/tearjerker/dark/blaze/lonesome 共 8 轴，
  // 权重 1.5/0.8/0.6/0.5/0.3/0.4/0.7）。原样消费三分值会让这 8 个轴整体下降 = 上游口径变更带来的意外回归，
  // 不是 vibe 侧的任何修复。这里用 analysis.js 同时返回的命中次数还原两分比（v4.1.1 的轴语义即两分口径），
  // 歧义占比不再摊薄轴分；amb 只用于证据行的上游原值展示（三比率同分母，可相加）。
  // 命中次数字段缺失（老调用方 / 桩数据）时回退到旧字段，行为与修复前一致。
  const negHits = Number(implicit.negHits ?? 0) || 0;
  const posHits = Number(implicit.posHits ?? 0) || 0;
  const decidedHits = negHits + posHits;
  const negUp = implicit.negative ?? 0; // 上游三分口径原值：只用于证据行展示（与 index.js「四、情感」同源同口径）
  const posUp = implicit.positive ?? 0;
  const neg = decidedHits > 0 ? negHits / decidedHits : negUp; // 轴加权用两分
  const pos = decidedHits > 0 ? posHits / decidedHits : posUp;
  const amb = implicit.ambiguousRatio ?? 0;
  const V = q.stats?.variance ?? 0;

  // v4.3.0 修复（E4）：词群总次数优先取 detect.scores（core.detectCulture 的全量计数）——
  // detect.evidence 每文化只留前 8 个词（core.js: evidence[culture].length < 8），用它求和时第 9 个词之后的
  // 命中全部丢失（实测 12 个西方词各 3 次：真值 36 被报成 24）。回退链与 index.js 报告行（v4.0.0）一致；
  // scores 缺失（老调用方/桩数据）时退回 evidence 求和，不改变既有行为。
  const westernCount = Number.isFinite(detect.scores?.western) ? detect.scores.western : Object.values(wF).reduce((s, x) => s + x, 0);
  const modernCount = Number.isFinite(detect.scores?.modern) ? detect.scores.modern : Object.values(mF).reduce((s, x) => s + x, 0);
  // v2.5 修复：detect 不输出 questionRatio，改为从文本直接统计疑问句占比
  const questionRatio = text ? Math.min(1, (text.match(/[?？]/g) || []).length / Math.max(1, (text.match(/[。！？!?]/g) || []).length)) : 0;
  // v2.2.0 网文信号：动作/套路词群扫描（封顶计分）
  // v2.6.0 提速：原 12 轴×164 词全文本 indexOf 扫描 → 先滑窗统计 2-4 字词频（Map），词表命中改查表
  // v3.5.0 #58：只生成词表实际词长的 n-gram（旧版逐位生成 2/3/4 字 ≈ 3×字数条目，50 万字书 ~150 万键）
    // v3.5.0 R5(#58)：滑窗只生成 2-4 字 n-gram（词表 >4 字词低频，单独 indexOf 查，不放大内存）
  // v4.0.0 修正：词表里的单字词（抚/谜）既不进 signalLens 也不进 longWords → 恒不命中；已改双字（抚摸/谜团）
  const longWords = new Set();
  const signalLens = new Set();
  for (const axisWords of Object.values(WEB_NOVEL_SIGNALS)) {
    for (const w of axisWords) { if (w.length >= 2 && w.length <= 4) signalLens.add(w.length); else if (w.length > 4) longWords.add(w); }
  }
  const textWordCounts = new Map();
  // v3.9.0 性能：n-gram 滑窗限长（大书 50 万字 ~150 万键 → 上限 ~60 万键）
  // v3.9.0 修正：头/中/尾三段等距抽样（只取头部会让集中在末尾的信号词完全丢失——实测甜宠词失真 0.089 vs 0.033）
  const NGRAM_LIMIT = 200000;
  let scanText = text;
  if (scanText.length > NGRAM_LIMIT) {
    const seg = Math.floor(scanText.length / 3);
    const third = Math.floor(NGRAM_LIMIT / 3);
    // v3.9.0 复查修正：第三段取 slice(-third) 覆盖真正的文末（原 seg*2 是「最后 1/3 的开头」，末尾约 1/9 永不采样）
    scanText = scanText.slice(0, third) + scanText.slice(seg, seg + third) + scanText.slice(-third);
  }
  if (scanText) {
    for (const run of String(scanText).match(/[\u4e00-\u9fa5]{2,}/g) || []) {
      for (const L of signalLens) {
        for (let i = 0; i + L <= run.length; i++) {
          const w = run.slice(i, i + L);
          textWordCounts.set(w, (textWordCounts.get(w) || 0) + 1);
        }
      }
    }
    // >4 字词：直接 indexOf 计数（这些词低频出现，全文本扫一遍开销可忽略）
    for (const lw of longWords) {
      let from = 0, cnt = 0;
      while ((from = scanText.indexOf(lw, from)) !== -1) { cnt++; from += lw.length; }
      if (cnt > 0) textWordCounts.set(lw, cnt);
    }
  }
  const webNovelHits = {};
  for (const [axis, words] of Object.entries(WEB_NOVEL_SIGNALS)) {
    let n = 0;
    for (const w of words) n += textWordCounts.get(w) || 0;
    webNovelHits[axis] = n;
  }
  // v2.2.0 情感直给词计数接入（emotion.scores 词计数 → 密度）
  const emoCount = {};
  for (const s of emotion.scores || []) emoCount[s.emotion] = s.count || 0;
  const joyDensity = Math.min(1, (emoCount.joy || 0) * 0.04);
  const fearDensity = Math.min(1, (emoCount.fear || 0) * 0.04);
  const sorrowDensity = Math.min(1, (emoCount.sorrow || 0) * 0.04);
  const angerDensity = Math.min(1, (emoCount.anger || 0) * 0.04);
  const horror = themes.includes("恐怖灵异") || /恐怖|灵异|惊悚/.test(theme);
  const mystery = themes.includes("悬疑推理") || /悬疑|推理/.test(theme) || genre.includes("悬疑");

  const axes = {};
  /** 轴记录初始形态（v4.3.0：新增 bonus 字段承载"输出期加成"，见 linkThemes）。 */
  const newAxis = () => ({ score: 0, weight: 0, evidenceScore: 0, evidenceWeight: 0, bonus: 0, signals: [] });
  // v4.0.0：push 增加第 5 个参数 isEvidence——只有「内容证据」信号累计 evidenceScore/evidenceWeight，
  // 题材联动门控改用它（默认推送 / 题材标签不算证据）。
  const push = (axis, score, weight, label, isEvidence) => {
    axes[axis] = axes[axis] || newAxis();
    axes[axis].score += score * weight;
    axes[axis].weight += weight;
    if (isEvidence && score > 0) {
      axes[axis].evidenceScore += score * weight;
      axes[axis].evidenceWeight += weight;
    }
    axes[axis].signals.push({ s: Math.round(score * 100) / 100, w: weight, label });
  };

  // v2.2.0：网文信号辅助（动作/套路词群 + 题材联动 + 情感直给密度）
  const wnv = (axis, weight = 1.2) => {
    const n = webNovelHits[axis] || 0;
    if (n > 0) push(axis, Math.min(0.3, n * 0.025), weight, "网文词群×" + n);
  };
  // v4.0.0 修正：题材联动门控改用「内容证据分」——旧版用归一化累计分，而各轴的默认推送
  // （0.1~0.2 的无条件基础分）本身就可能达到 needBase（0.08~0.1），等于题材标签白给加成。
  // 现在只统计 isEvidence 信号（轴专属内容词群 / 轴专属语义信号），默认推送与题材标签不计。
  const evidenceBase = (axis) => {
    const a = axes[axis];
    if (!a || !a.evidenceWeight) return 0;
    return a.evidenceScore / a.evidenceWeight;
  };
  /** v4.3.0：某轴题材链路的门控基准（与 linkThemes 同源，避免轴级标签推送另写一份硬编码阈值而漂移）。 */
  const themeNeedBase = (axis) => THEME_AXIS_LINK.find((l) => l.axis === axis)?.needBase ?? 0.1;
  const linkThemes = (axis) => {
    for (const l of THEME_AXIS_LINK) {
      if (l.axis === axis && l.themes.some((t) => themes.includes(t) || theme.includes(t))) {
        // v2.5.0 修复轮 7：题材联动必须已有基础信号（"提了一句恐怖"不再强拉噩梦感）；
        // v4.0.0：基准改为内容证据分——正文无对应内容证据时不再给题材加成。
        // v4.3.0 修复（E1）：加成本身改为「输出期加法」（记 bonus，输出时 clamp01(均值+bonus)）。
        // 旧版 push(axis, bonus, 1.2) 走加权平均：轴均值高于 bonus 时把均值往下拉（实测同文本仅切题材标签
        // absurd −0.011 / mystery −0.017 / blaze −0.097 / tearjerker −0.024），能翻转 top3 与 confidence，
        // 与"加成"语义相反。门控条件（evidenceBase ≥ needBase）与 v4.0.0 完全一致：纯题材标签仍然零加成。
        if (evidenceBase(axis) >= l.needBase) {
          const a = axes[axis] || (axes[axis] = newAxis());
          a.bonus += l.bonus;
          // s=加成值、w=0：标记这是输出期加成而非参与加权平均的信号
          a.signals.push({ s: Math.round(l.bonus * 100) / 100, w: 0, label: "题材联动:" + l.themes[0] });
        }
        return;
      }
    }
  };
  const wne = (axis, density, weight = 0.8) => { if (density > 0) push(axis, density, weight, "情感词密度"); };
  // v4.0.0：只累计证据分、不改动轴得分量纲（既有 12 轴分数与排序保持不变，新增的只有题材加成本身）。
  const markEvidence = (axis, score, weight) => {
    if (!(score > 0)) return;
    axes[axis] = axes[axis] || newAxis();
    axes[axis].evidenceScore += score * weight;
    axes[axis].evidenceWeight += weight;
  };
  // v4.0.0：轴专属内容证据词群（正文直扫）——题材联动唯一的"用词"证据来源。
  const axisEvidence = (axis) => {
    const words = AXIS_EVIDENCE_WORDS[axis];
    if (!words || !text) return;
    const hits = countHits(text, words);
    if (hits > 0) markEvidence(axis, Math.min(1, hits * 0.06), 1.5);
  };

  // 戏谑语气检测（吐槽文 vs 温馨文的"笑"分流依据）
  // v4.3.0 修复（父代理裁决）：改直扫全文，不再读 detect.evidence —— 证据数组被 core.js 的
  // `evidence[culture].length < 8` 截断，这 5 个词只要没排进 modern 前 8 位就整词丢成 0，
  // 会让吐槽/沙雕文被误分到温馨文。与 v3.9.1 M21「不再依赖 detect.evidence，直扫全文」的口径一致。
  const absurdWords = countHits(String(text || ""), ["游戏", "宿舍", "电脑", "手机", "外卖"]);
  const jocular = (webNovelHits.absurd || 0) > 0 || absurdWords > 0 || /笑死|哈哈|离谱|吐槽|沙雕|救命|摆烂|什么鬼|有毛病|玛德/.test(String(text).slice(0, 6000));

  // ① 噩梦感
  push("nightmare", clean === "fear" ? 0.85 : 0.25, 2, "clean=fear");
  push("nightmare", neg, 1.5, "意象负向");
  push("nightmare", delta < 0 ? Math.min(0.7, -delta * 5) : 0, 1, "趋势下滑");
  push("nightmare", Math.min(1, sem.nightmare * 0.4), 2, "语义恐惧/脆弱", true);
  wnv("nightmare", 1.1);
  wne("nightmare", fearDensity * 1.2);
  push("nightmare", clean === "sorrow" && horror ? 0.25 : 0, 1, "恐怖语境下的哀伤");
  axisEvidence("nightmare");
  // v4.3.0 修复（E5）：轴级题材标签推送挪到证据累计之后，并套用与 linkThemes 同一道 evidenceBase 门控。
  // 旧版位置在证据之前、且无条件 push(horror ? 0.8 : 0.1, 2.5)：题材标签直接决定 2.5 权重的高分，
  // 纯标签文本（正文零证据）实测 nightmare 0.37 vs 0.195（Δ=+0.175），与 CHANGELOG"纯标签 6/6 不联动"口径不符。
  // 现在无内容证据时只给 0.1 基线（与无标签完全同分），有证据（≥needBase 0.1）才升到 0.8。
  push("nightmare", horror && evidenceBase("nightmare") >= themeNeedBase("nightmare") ? 0.8 : 0.1, 2.5, horror ? "恐怖灵异题材" : "题材缺席(基线)");
  linkThemes("nightmare");

  // ② 焦虑压抑
  push("angst", clean === "sorrow" ? 0.5 : 0.2, 1.5, "clean=sorrow");
  push("angst", neg * 0.8, 1.5, "意象负向");
  push("angst", delta < 0 ? Math.min(0.8, -delta * 6) : 0.1, 1.5, "趋势下滑");
  push("angst", Math.min(1, sem.angst * 0.5), 1.5, "语义焦虑/压抑");
  push("angst", Math.min(1, V * 6), 0.8, "情绪波动");
  wnv("angst", 0.8);
  wne("angst", fearDensity * 0.6);

  // ③ 温馨治愈（戏谑文分流——吐槽文的"笑"与正向意象都不算温馨）
  push("heartwarming", clean === "joy" ? (jocular ? 0.3 : 0.7) : 0.15, 2, jocular ? "clean=joy(戏谑分流)" : "clean=joy");
  push("heartwarming", jocular ? pos * 0.3 : pos, 1.5, jocular ? "意象正向(戏谑分流)" : "意象正向");
  push("heartwarming", Math.min(1, sem.heartwarming * 0.35), 1.5, "语义温暖/释然");
  push("heartwarming", delta > 0 ? Math.min(0.6, delta * 5) : 0.1, 1, "趋势回升");
  wnv("heartwarming", 0.9);
  wne("heartwarming", joyDensity * 0.5);

  // ④ 甜宠日常
  push("fluff", clean === "joy" ? (jocular ? 0.25 : 0.65) : 0.1, 1.5, jocular ? "clean=joy(戏谑分流)" : "clean=joy");
  push("fluff", modernCount > 0 ? Math.min(0.6, modernCount * 0.05) : 0, 1, "现代生活痕迹");
  push("fluff", pos * 0.7, 1, "意象正向");
  push("fluff", Math.min(1, sem.fluff * 0.4), 1, "语义轻松/甜蜜", true);
  wnv("fluff", 1.2);
  wne("fluff", joyDensity);
  axisEvidence("fluff");
  linkThemes("fluff");

  // ⑤ 催泪虐心（恐怖/猎奇语境下 sorrow 分流——恐怖文里的哀伤不是催泪）
  // v4.3.0 注释/标签口径修正（E10a）：分流条件实际是 horror∪恐怖灵异∪黑暗猎奇（score 分支已含 黑暗猎奇），
  // 但信号 label 只判 horror∪恐怖灵异 → "黑暗猎奇"命中的书会显示成未分流的 "clean=sorrow"（0.45 分却报无分流）。
  // 抽成同一个布尔量，score 与 label 口径一致（实测 score 无变化，只有 label 在猎奇语境下变准）。
  const sorrowDiluted = horror || themes.includes("恐怖灵异") || themes.includes("黑暗猎奇");
  push("tearjerker", clean === "sorrow" ? (sorrowDiluted ? 0.45 : 0.9) : 0.2, 2, sorrowDiluted ? "clean=sorrow(恐怖/猎奇分流)" : "clean=sorrow");
  push("tearjerker", neg * 0.6, 1, "意象负向");
  push("tearjerker", Math.min(1, sem.tearjerker * 0.5), 1.5, "语义失落/怅惘", true);
  wnv("tearjerker", 1.0);
  wne("tearjerker", sorrowDensity);
  axisEvidence("tearjerker");
  linkThemes("tearjerker");

  // ⑥ 黑暗残酷
  // v3.9.1 M21 词源修正：原只扫 detect.evidence（文化词表），与全文实际用词交集≈0 → 改为全文直扫
  const darkWords = countHits(text, ["绞刑架", "处刑", "酷刑", "鲜血", "尸体", "死亡", "屠杀", "血泊"]);
  push("dark", Math.min(1, darkWords * 0.4), 2, "残酷词群");
  push("dark", clean === "anger" ? 0.5 : 0.15, 1, "clean=anger");
  push("dark", Math.min(1, sem.dark * 0.4), 1, "语义黑暗");
  push("dark", neg * 0.5, 1, "意象负向");
  wnv("dark", 0.9);

  // ⑦ 悬疑神秘
  push("mystery", Math.min(1, questionRatio * 2), 1, "疑问句占比");
  push("mystery", Math.min(1, sem.mystery * 0.4), 1, "语义谜团", true);
  push("mystery", horror ? 0.3 : 0, 0.5, "恐怖叠加");
  wnv("mystery", 0.9);
  axisEvidence("mystery");
  // v4.3.0 修复（E5）：同噩梦轴——题材标签推送移到证据之后并加 evidenceBase 门控。
  // 旧版无条件 push(mystery ? 0.85 : 0.1, 2)：纯标签文本实测 mystery 0.378 vs 0.044（Δ=+0.334），
  // 与"纯标签不联动"口径不符。现在无证据时只给 0.1 基线，≥needBase(0.1) 才升到 0.85。
  push("mystery", mystery && evidenceBase("mystery") >= themeNeedBase("mystery") ? 0.85 : 0.1, 2, mystery ? "悬疑题材" : "题材缺席(基线)");
  linkThemes("mystery");

  // ⑧ 热血激昂
  // v2.5.0 修复轮 7：战斗词改双字（单字"战/杀"命中"战战兢兢/抹杀"误判热血）
  // v3.9.1 M21 词源修正：同上——不再依赖 detect.evidence，直接扫全文 text
  const fightWords = countHits(text, ["战斗", "冲锋", "斩杀", "刀光", "剑影", "铁拳", "战意", "厮杀", "刀剑", "拳风", "刀锋", "剑锋", "热血", "烈焰", "战鼓", "号角", "拔剑", "挥剑", "挥刀", "杀伐"]);
  push("blaze", clean === "anger" ? 0.8 : 0.15, 2.5, "clean=anger");
  push("blaze", Math.min(1, fightWords * 0.3), 1.5, "战斗词群");
  push("blaze", pos * 0.4, 1, "意象正向");
  wnv("blaze", 1.2);
  wne("blaze", angerDensity);
  axisEvidence("blaze");
  linkThemes("blaze");

  // ⑨ 荒诞无厘头（absurdWords 已在顶部定义）
  push("absurd", Math.min(1, absurdWords * 0.12), 1.2, "网络生活词");
  // v2.5.0 修复轮 7：反差信号需净化确有动作（caveat）才计，且降权（原来有污染时几乎必触发、权重偏大）
  push("absurd", (emotion.dominant !== emotion.cleanDominant && emotion.caveat) ? 0.3 : 0.08, 1, "情绪反差(表象≠内核)");
  if (jocular) push("absurd", 0.4, 1.2, "戏谑语气");
  wnv("absurd", 1.1);
  axisEvidence("absurd");
  linkThemes("absurd");
  // v3.5.0 #52：情绪跳跃门控——需已有荒诞信号才计（否则平静文本被塞 0 分信号稀释）
  if ((webNovelHits.absurd || 0) > 0) push("absurd", Math.min(1, V * 3), 0.4, "情绪跳跃(波动大)");

  // ⑩ 孤独疏离
  push("lonesome", Math.min(1, sem.lonesome * 0.5), 1.5, "语义孤独/疏离");
  push("lonesome", neg * 0.5, 1, "意象负向");
  push("lonesome", clean === "sorrow" ? 0.4 : 0.15, 1, "clean=sorrow");
  push("lonesome", delta < 0 ? 0.3 : 0.05, 0.5, "趋势下滑");
  wnv("lonesome", 0.8);

  // ⑪ 文艺唯美（v2.5 修复：detect 无 envRatio，改为文本直算环境词密度 + 叙述性）
  // 专属环境意象词（双字为主，避免"夜/水/风"等常用字虚高）
  const envHits = (String(text).match(/月色|清辉|荷塘|暮色|薄雾|余韵|浮光|微凉|静默|细碎|素净|落英|烟雨|水光|风过|光影|夜色|黄昏|月光|露珠|水墨|晚风|斜阳|残阳|疏影|波光|氤氲|幽静|空濛|斑斓/g) || []).length;
  const envDensity = envHits >= 3 ? Math.min(1, envHits / Math.max(1, text.length / 300)) : 0;
  const dlgRatio = (String(text).match(/[“"「『]/g) || []).length / Math.max(1, (String(text).match(/[。！？!?]/g) || []).length);
  push("aesthetic", Math.min(1, sem.aesthetic * 0.5), 1.5, "语义唯美/文艺"); // v3.7.0 引擎⑧：标签与轴匹配（原复制粘贴成 tearjerker 的怅惘/释然）
  push("aesthetic", Math.min(1, envDensity * 2.5), 2.5, "环境意象密度"); // v3.9.1：score 超 1 时 clamp，不破坏计分契约
  push("aesthetic", dlgRatio < 0.12 ? 0.35 : 0.05, 1.2, "叙述性文本(对话少)");
  wnv("aesthetic", 1.3);

  // ⑫ 情欲暧昧
  push("sensual", themes.includes("情色R18") || /情色|R18/.test(theme) ? 0.75 : 0.05, 2, "情色R18题材");
  wnv("sensual", 1.2);
  push("sensual", Math.min(1, sem.sensual * 0.4), 1, "语义情欲/暧昧"); // v3.7.0 引擎⑧：标签与轴匹配（原复制粘贴成 fluff/heartwarming 的甜蜜/仰慕）

  const names = {
    nightmare: "噩梦感", angst: "焦虑压抑", heartwarming: "温馨治愈", fluff: "甜宠日常",
    tearjerker: "催泪虐心", dark: "黑暗残酷", mystery: "悬疑神秘", blaze: "热血激昂",
    absurd: "荒诞无厘头", lonesome: "孤独疏离", aesthetic: "文艺唯美", sensual: "情欲暧昧"
  };
  const axesOut = Object.entries(axes).map(([key, v]) => ({
    key, name: names[key],
    // v4.3.0：题材联动 bonus 在输出期做加法（clamp01(加权均值 + bonus)）——只增不减，方向与"加成"一致；
    // 加权平均本身仍只由 push 的信号决定，既有 12 轴分数不受联动的反噬（见 linkThemes 注释）。
    score: Math.round(clamp01((v.weight > 0 ? v.score / v.weight : 0) + (v.bonus || 0)) * 1000) / 1000,
    signals: v.signals.slice(0, 4)
  })).sort((a, b) => b.score - a.score);

  const top = axesOut.slice(0, 3).map((a) => ({ name: a.name, score: a.score }));
  const topScore = axesOut[0]?.score ?? 0;
  const evidenceCount = (emotion.caveat ? 1 : 0) + (implicit.totalHits > 0 ? 1 : 0) + (Object.keys(dist).length > 0 ? 1 : 0) + (westernCount > 0 ? 1 : 0) + (modernCount > 0 ? 1 : 0) + (horror || mystery ? 1 : 0);
  const confidence = clamp01(topScore * 0.55 + evidenceCount * 0.07);

  // v2.5.0：不再由规则贴结论——判断交给大模型读报告
  const conclusion = "（测量数据已输出，请由大模型结合全部维度判断风格气质）";
  const evidence = [
    westernCount > 0 ? `西方词群 ${westernCount} 次（${Object.entries(wF).slice(0, 3).map(([k, v]) => k + "×" + v).join("/")}）` : "无西方词群",
    modernCount > 0 ? `现代痕迹 ${modernCount} 次` : "无现代痕迹",
    clean ? `情感(净化) ${clean}` : "",
    // v4.3.0：展示用上游三分原值（negUp/posUp/amb 同分母，三项之和 ≤1，与 index.js「四、情感」行一致）；
    // 轴加权才用两分 neg/pos——否则"负 100% / 歧义 50%"这类自相矛盾组合（analysis.js v4.3.0 修的就是它）会从证据行回流。
    implicit.totalHits > 0 ? `意象负 ${Math.round(negUp * 100)}%/正 ${Math.round(posUp * 100)}%/歧义 ${Math.round(amb * 100)}%` : "无意象信号",
    delta !== 0 ? `趋势Δ=${delta >= 0 ? "+" : ""}${delta}` : "趋势平稳",
    Object.keys(dist).length > 0 ? `语义隐性: ${Object.entries(dist).slice(0, 3).map(([k, v]) => k + "×" + v).join("/")}` : ""
  ].filter(Boolean);

  return { axes: axesOut, top, conclusion, confidence: Math.round(confidence * 100) / 100, evidence };
}

// v2.5.0 语义风格距离：风格原型句 × 全书向量 → 距离表（0 token 本地推理，纯测量不下结论）
// v4.3.0 修复（E7）：去掉 export——全项目（lib/test/mcp/skills）除本文件定义处外无任何消费者
// （index.js 只 import computeVibe/semanticStyleDistances），导出只会误导外部当成公共 API。
const STYLE_PROTOTYPES = {
  "克苏鲁诡异": ["黑暗里有什么在逼近，他说不清自己在怕什么", "有些秘密知道得越多越危险", "钟声响起时，她心里有什么在应和", "那晚的潮声格外浓稠，像海底有什么在翻身", "她回头看了一眼教堂，暮色更深了"],
  "甜宠日常": ["阳光暖融融的，他轻轻揉了揉她的头发", "粥在锅里，牛奶在桌上，纸条压在杯底", "他笑起来的时候，整个世界都亮了", "她抱着被子滚了一圈，觉得冬天也没那么冷", "平凡又温暖的一天，这样就好"],
  "热血燃向": ["他握紧刀柄，迎着敌阵冲了上去", "身后的兄弟们一个接一个倒下，可他不退", "战鼓擂动，号角长鸣，信念在胸腔燃烧", "今天谁也不能阻止我踏平这座城", "他冲在最前面，像一头烧不尽的火"],
  "文艺忧郁": ["雨落在玻璃上，像时间一样漫无目的", "所有的告别都是潮水，涨了又退", "她走进雨里，像走进一段没有结局的句子", "记忆大概就是这样的东西，抓不住，只剩轮廓", "黄昏的光晕在雨幕里慢慢散开"],
  "悬疑紧张": ["监控显示灯熄灭的短短四分钟里，门从未打开", "密室本身就是他的不在场证明", "他抬头看了看天花板，检修口边缘有一圈新灰", "案情的轮廓正在一点点清晰起来", "凶手一定是他能听出声音的人"],
  "压抑致郁": ["心里发紧，像有什么东西在缓缓下沉", "她盯着黑漆漆的房梁，一夜无眠", "沉默在房间里蔓延，谁也没有开口", "日子像一锅煮不开的粥，怎么都理不出头绪", "她觉得自己像被什么慢慢压扁了"],
  "温馨治愈": ["温暖从心底慢慢升起来，像融化的蜜", "他替她掖好被角，轻轻带上门", "这一刻真好，所有的疲惫都被抚平了", "她闭上眼睛，嘴角不自觉地上扬", "有人等着你回家，灯火是暖的"],
  "荒诞吐槽": ["离谱，这剧本是不是拿错了", "大哥，我就是个摆烂大学生", "还有这种操作？", "算了算了，既来之则安之", "我寻思这破地方是不是有什么大病"],
  "情欲暧昧": ["呼吸在耳畔交缠，空气变得灼热", "指尖划过肌肤，引起一阵颤栗", "他俯身贴近，声音低沉而温柔", "暧昧在安静里慢慢发酵", "她咬着嘴唇，脸上发烫"],
  "史诗庄严": ["铁骑踏碎城门的那一刻，整个世界都在震颤", "古老的契约刻在石碑上，无人敢违逆", "钟声从云层里落下，一声接一声", "这座巨城容纳着千万人的命运", "神明的意志贯穿了千年的历史"],
  "怀旧乡愁": ["巷口的桂花还是那个味道", "老屋的木门吱呀作响，像在说别走", "她想起很多年前的黄昏，也是这样下雨", "照片泛黄了，可那时候的笑还是真的", "故乡的月亮，总是比别处圆"],
  "孤独疏离": ["她一个人坐在角落里，看着热气升起来", "没有人叫她的名字", "这座城很大，可没有一盏灯是为她亮的", "隔着一层雾，什么都够不着", "她习惯了把话咽回去"]
};
/** 等距抽样：超过 max 段时全书均匀取 max 段（首尾保留），避免只取开头序章失真。
 * v4.3.0 修复（E8）：max<=1 单独处理——旧版 step=(len-1)/(max-1)=Infinity → Math.round(i*Infinity)=NaN →
 * 返回 [undefined]（实测 sampleEvenly([1,2,3,4,5],1) = [undefined]），调用方拿到 undefined 段。取中位段，
 * 与 core.js 的同名实现（const sampleEvenly，锚段抽样）行为一致。 */
function sampleEvenly(arr, max) {
  if (arr.length <= max) return arr;
  if (max <= 1) return arr.length > 0 ? [arr[Math.floor((arr.length - 1) / 2)]] : [];
  const out = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

/** 风格原型句向量内存缓存（STYLE_PROTOTYPES 固定 12 类×5 句，跨书复用，进程内一次）。 */
const PROTO_VEC_CACHE = new Map();
/** v4.3.0：本进程模型实际输出维度（首次探测后固定）——用于判定进程内原型缓存是否仍属当前模型。 */
let PROBE_MODEL_DIM = 0;
/** v4.3.0：styleproto 缓存自愈告警去重集合（同一缓存文件同一原因只 warn 一次，不刷屏）。 */
const STYLE_PROTO_WARNED = new Set();
function warnStyleProtoOnce(msg) {
  if (STYLE_PROTO_WARNED.has(msg)) return;
  STYLE_PROTO_WARNED.add(msg);
  console.warn("[novel-writer] 语义风格缓存自愈：" + msg);
}

/** v4.3.0：语义风格距离最近一次诊断（reason 区分"无数据"与"引擎不可用"，见 semanticStyleDiagnostics）。 */
let lastStyleDiag = { reason: "not-run", detail: "", count: 0, at: 0 };
/** v4.3.0：读取最近一次 semanticStyleDistances 的失败通道（index.js 若要显示细分原因需接线，见 CHANGELOG 裁决节）。 */
export function semanticStyleDiagnostics() { return { ...lastStyleDiag }; }

/** v4.3.0：原型/正文向量所属模型标识（payload 增写 model；emb 未导出标识时回落静态常量，仅按 dim 校验）。 */
function modelTagOf(emb) {
  const t = emb?.MODEL_NAME;
  if (typeof t === "string" && t !== "") return t;
  return typeof EMBED_MODEL_NAME === "string" && EMBED_MODEL_NAME !== "" ? EMBED_MODEL_NAME : "unknown";
}

/** v4.3.0：一组向量是否长度一致且元素全为有限数（缓存半损坏——bookVecs[0]=null / 混入字符串——的判定）。 */
function uniformVecDim(list) {
  if (!Array.isArray(list) || list.length === 0) return 0;
  if (!Array.isArray(list[0]) || list[0].length === 0) return 0;
  const d = list[0].length;
  for (const v of list) {
    if (!Array.isArray(v) || v.length !== d) return 0;
    for (let i = 0; i < d; i++) if (!Number.isFinite(v[i])) return 0;
  }
  return d;
}

/**
 * v4.3.0：取某个风格原型的句向量均值（进程内缓存）。
 * dim=0 表示本次调用还没确定模型维度；缓存维度与已知维度不符（同进程换模型）时重算。
 */
async function protoMeanOf(emb, name, sentences, dim) {
  const cached = PROTO_VEC_CACHE.get(name);
  if (cached && cached.length > 0 && (dim === 0 || cached.length === dim)) return cached;
  const pVecs = [];
  for (const s of sentences) {
    try {
      const vec = await emb.embed(s);
      if (vec && vec.length > 0 && (pVecs.length === 0 || vec.length === pVecs[0].length)) pVecs.push(vec);
    } catch { /* 单句失败跳过 */ }
  }
  if (pVecs.length === 0) return null;
  const pMean = new Array(pVecs[0].length).fill(0);
  for (const vec of pVecs) for (let i = 0; i < pMean.length; i++) pMean[i] += vec[i] / pVecs.length;
  PROTO_VEC_CACHE.set(name, pMean);
  return pMean;
}

/** v4.3.0：进程内模型维度探测（每进程最多 1 次推理；仅当原型缓存已有内容、需要判断其是否过期时使用）。 */
async function probeModelDim(emb) {
  if (PROBE_MODEL_DIM > 0) return PROBE_MODEL_DIM;
  try {
    const v = await emb.embed("维度探测");
    if (v && v.length > 0) PROBE_MODEL_DIM = v.length;
  } catch { /* 探测失败：保持 0，退回"按首个原型均值定维" */ }
  return PROBE_MODEL_DIM;
}

/** 语义距离按书缓存路径：<root>/.novel-writer/embedding/<书>__styleproto.json */
function styleProtoCachePath(root, book) {
  const safe = String(book).replace(/[\\/:*?"<>|]/g, "_");
  return path.join(root, ".novel-writer", "embedding", safe + "__styleproto.json");
}

/** v4.3.0：读 styleproto 缓存文件（zstd 优先，旧版纯 JSON 兼容；读不出返回 null）。 */
function readStyleProtoCache(cacheFile) {
  const buf = fs.readFileSync(cacheFile);
  let data = null;
  if (zstdDecompressSync) {
    try { data = JSON.parse(zstdDecompressSync(buf).toString("utf8")); } catch { /* 非 zstd 旧格式 */ }
  }
  if (!data) { try { data = JSON.parse(buf.toString("utf8")); } catch { /* 损坏 */ } }
  return data;
}

/**
 * v4.3.0：段落向量缓存是否可用——指纹一致 + 向量维度与本次模型一致 + 段数一致，且（若载荷写了 model）模型一致。
 * 旧版只校验 fp 与段数：换模型/维度变化后旧维度向量被继续复用，12 个原型因维度不符被静默 continue，
 * semanticStyleDistances 永久返回 [] 且缓存永不重写（index.js 还会把它显示成"语义引擎不可用"）。
 */
function styleProtoCacheUsable(data, fp, dim, chunkCount, modelTag) {
  if (!data || data.fp !== fp) return false;
  if (typeof data.model === "string" && data.model !== modelTag) return false;
  const vecDim = uniformVecDim(data.bookVecs);
  if (vecDim !== dim || data.bookVecs.length !== chunkCount) return false;
  return true;
}

/**
 * 计算全书与各风格原型的语义距离表。
 * @param {string} text 全书文本
 * @param {object} emb embedding 模块（embed/cosine/chunkText/fingerprint；可带 MODEL_NAME）
 * @param {object} [opts] 可选 { root, book }——提供后段落向量按书缓存（内容指纹 + 模型/维度失效重建）
 * @returns {Array<{name:string,score:number}>} 按相似度降序（数组另带非枚举 reason 字段，见 semanticStyleDiagnostics）
 */
export async function semanticStyleDistances(text, emb, opts = {}) {
  const results = [];
  // v4.3.0 失败通道（E2）：空数组不再只有"没数据"一种含义——reason 区分引擎不可用/切块为空/原型向量失败/
  // 段落向量失败/内部异常。非枚举属性 → 不改 JSON 序列化与既有消费方（index.js 只读 length/元素）。
  const done = (reason, detail) => {
    lastStyleDiag = { reason, detail: detail ?? "", count: results.length, at: Date.now() };
    Object.defineProperty(results, "reason", { value: reason, enumerable: false, configurable: true });
    return results;
  };
  try {
    if (!emb || typeof emb.embed !== "function") return done("no-engine", "embedding 模块不可用");
    // v2.5.0 修复轮 7：全书等距抽样 ≤60 段（原 slice(0,60) 只取开头，序章/引子会失真）
    const allChunks = emb.chunkText ? emb.chunkText(text) : [{ text: String(text ?? "").slice(0, 2000) }];
    if (allChunks.length === 0) return done("no-chunks", "切块为空");
    const chunks = sampleEvenly(allChunks, 60);
    const fp = typeof emb.fingerprint === "function" ? emb.fingerprint(chunks) : null;
    const modelTag = modelTagOf(emb);
    // ① 原型均值先行（v4.3.0）：其向量长度就是本次模型的实际维度——正文向量与缓存向量都必须与之同维
    // （cosine 要求等长，维度不符只会恒返回 0）。原型向量进程内缓存；缓存非空时先用一次探测确认模型维度，
    // 同进程换模型（探测维度与缓存不符）会整表重算。
    const protoMeans = [];
    let dim = PROTO_VEC_CACHE.size > 0 ? await probeModelDim(emb) : 0;
    if (dim !== 0 && [...PROTO_VEC_CACHE.values()].every((v) => v.length !== dim)) { PROTO_VEC_CACHE.clear(); dim = 0; }
    for (const [name, sentences] of Object.entries(STYLE_PROTOTYPES)) {
      const pMean = await protoMeanOf(emb, name, sentences, dim);
      if (!pMean) continue;
      if (dim === 0) dim = pMean.length;
      protoMeans.push([name, pMean]);
    }
    if (protoMeans.length === 0 || dim === 0) return done("proto-embed-failed", "风格原型句未能生成向量（引擎可能不可用）");
    // ② 段落向量：优先复用按书缓存（指纹 + 模型/维度一致才命中；不匹配/缺失/损坏则删缓存重建）
    let bookVecs = null;
    let cacheFile = null;
    if (opts?.root && fp) {
      cacheFile = styleProtoCachePath(opts.root, opts.book);
      try {
        if (fs.existsSync(cacheFile)) {
          const data = readStyleProtoCache(cacheFile);
          if (styleProtoCacheUsable(data, fp, dim, chunks.length, modelTag)) {
            bookVecs = data.bookVecs;
          } else if (data && data.fp === fp) {
            // 指纹一致却不可用 = 模型/维度/向量损坏（非"内容变了"的正常重建）：删缓存重算并 warn 一次
            const why = typeof data.model === "string" && data.model !== modelTag
              ? "模型不匹配(" + data.model + "→" + modelTag + ")"
              : (uniformVecDim(data.bookVecs) !== dim ? "维度不匹配(缓存" + uniformVecDim(data.bookVecs) + "→当前" + dim + ")" : "向量损坏或段数不符");
            warnStyleProtoOnce(cacheFile + "：" + why + "，已删除并重算");
            try { fs.rmSync(cacheFile, { force: true }); } catch { /* 删除失败不影响重建 */ }
          }
        }
      } catch { /* 缓存读失败 → 重建 */ }
    }
    if (!bookVecs) {
      bookVecs = [];
      for (const ch of chunks) {
        try {
          const vec = await emb.embed(ch.text);
          if (vec && vec.length === dim) bookVecs.push(vec); // 维度不符的向量直接丢弃（付不了 cosine，还会污染缓存）
        } catch { /* 单段失败跳过 */ }
      }
      if (cacheFile && fp && bookVecs.length > 0) {
        try {
          fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
          const rounded = bookVecs.map((v) => v.map((x) => Math.round(x * 10000) / 10000));
          // v4.3.0：payload 增写 model/dim（与索引缓存同口径），供下次调用判定是否仍适用于当前模型
          const payload = Buffer.from(JSON.stringify({ model: modelTag, dim, fp, bookVecs: rounded }), "utf8");
          fs.writeFileSync(cacheFile, zstdCompressSync ? zstdCompressSync(payload) : payload);
        } catch { /* 写缓存失败不影响结果 */ }
      }
    }
    if (bookVecs.length === 0) return done("chunk-embed-failed", "段落向量为空（模型维度 " + dim + "，切块 " + chunks.length + " 段）");
    const bookMean = new Array(dim).fill(0);
    for (const vec of bookVecs) for (let i = 0; i < dim; i++) bookMean[i] += vec[i] / bookVecs.length;
    for (const [name, pMean] of protoMeans) {
      try {
        const score = emb.cosine(bookMean, pMean);
        if (Number.isFinite(score)) results.push({ name, score: Math.round(score * 1000) / 1000 });
      } catch { /* 单原型失败跳过 */ }
    }
  } catch (e) {
    return done("error", String(e).slice(0, 200)); // v4.3.0：整体失败也走失败通道（旧版静默返回空数组）
  }
  results.sort((a, b) => b.score - a.score);
  return done("ok");
}
