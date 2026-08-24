/**
 * v2.1.0 气质聚合层：把插件各工具的已有输出（detect 词频/题材、情感净化、
 * 情感量化 V/Δ/C、意象极性/歧义、语义隐性情感）汇总成"氛围光谱"（10 轴）。
 * 纯规则加权 0 token；不做"贴标签"，只输出数值坐标 + 组合结论 + 证据链。
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// v2.6.0 审查修复：Node <22.3 无 zstd——条件获取，不可用时缓存回退纯 JSON（插件照常加载）
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

/** 解析 evidence 词频数组 → { 词: 次数 } */
function parseFreq(arr) {
  const out = {};
  for (const item of arr || []) {
    const m = String(item).match(/^(.+?)(?:×|\u00d7)(\d+)$/);
    if (m) out[m[1]] = parseInt(m[2], 10);
    else out[String(item)] = 1;
  }
  return out;
}

/** 统计 evidence 中属于某词群的总次数 */
function freqIn(evArr, words) {
  const f = parseFreq(evArr);
  let sum = 0;
  for (const w of words) sum += f[w] || 0;
  return sum;
}

/** 语义隐性情感分布 → 各轴信号 */
function semSignals(dist) {
  const s = { nightmare: 0, angst: 0, heartwarming: 0, tearjerker: 0, dark: 0, mystery: 0, blaze: 0, absurd: 0, lonesome: 0, fluff: 0, aesthetic: 0, sensual: 0 };
  // 键与 embedding.js IMPLICIT_EMOTION_PROTOTYPES 的 26 个 emotion 标签严格对齐（v2.5 修复）
  const map = {
    脆弱: "nightmare", 恐惧: "nightmare", 不安: "nightmare",
    焦虑: "angst", 隐忍: "angst", "压抑的愤怒": "angst", 无奈: "angst",
    温暖: "heartwarming", 温柔: "heartwarming", 幸福: "heartwarming", 甜蜜: "heartwarming", 释然: "heartwarming", 仰慕: "heartwarming",
    失落: "tearjerker", 悲伤: "tearjerker", 怅惘: "tearjerker", 心碎: "tearjerker", 不舍: "tearjerker", 眷恋: "tearjerker", 苦涩: "tearjerker",
    孤独: "lonesome", 疏离: "lonesome", 决绝: "lonesome",
    厌恶: "dark", 震惊: "absurd"
  };
  for (const [k, v] of Object.entries(dist || {})) {
    const axis = map[k];
    if (axis) s[axis] += Number(v) || 0;
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
  absurd: ["离谱", "无语", "笑死", "尴尬", "吐槽", "什么鬼", "疯了", "惊了", "搞什么", "还有这种", "打脸★", "装逼★", "扮猪吃虎★", "嘲讽★", "震惊★", "下跪★", "跪地★", "退婚★", "废物★", "赌石★", "透视★", "隐藏身份★", "高攀不起", "悔婚★", "看不起★"],
  nightmare: ["诡异", "毛骨悚然", "不祥", "低语", "畸形", "腐烂", "扭曲", "窒息", "心悸", "不对劲", "渗人", "爬行", "凶兽★"],
  angst: ["完了", "完了完了", "怎么办", "发抖", "紧张", "不安", "慌张", "慌乱", "害怕", "惧怕", "救命"],
  heartwarming: ["温柔", "安心", "踏实", "轻声", "轻轻", "抚", "哄睡", "暖意", "治愈"],
  mystery: ["线索", "真相", "谜", "疑点", "秘密", "调查", "发现", "蛛丝马迹★", "身份反转★", "震撼★"],
  dark: ["鲜血", "尸体", "死亡", "屠杀", "血泊", "杀戮", "折磨", "地狱", "残忍", "冷血"],
  lonesome: ["一个人", "独自", "没人", "寂寞", "想家", "陌生", "空荡荡", "孤零零"],
  aesthetic: ["月色", "清辉", "烟雨", "荷塘", "落英", "余韵", "浮光", "静默", "素净", "微凉", "风过", "细碎"],
  sensual: ["呼吸", "发烫", "贴近", "肌肤", "颤栗", "酥麻", "灼热", "喘息", "缠绕", "柔软", "耳畔", "温存"]
};
const THEME_AXIS_LINK = [
  { themes: ["豪门总裁", "总裁", "现言"], axis: "fluff", bonus: 0.2, needBase: 0.1 },
  { themes: ["虐恋", "替身"], axis: "tearjerker", bonus: 0.25, needBase: 0.1 },
  { themes: ["系统流"], axis: "absurd", bonus: 0.2, needBase: 0.1 },
  { themes: ["系统流"], axis: "blaze", bonus: 0.15, needBase: 0.1 },
  { themes: ["玄幻", "仙侠", "奇幻"], axis: "blaze", bonus: 0.2, needBase: 0.1 },
  { themes: ["都市"], axis: "absurd", bonus: 0.1, needBase: 0.08 },
  { themes: ["恐怖灵异"], axis: "nightmare", bonus: 0.3, needBase: 0.1 },
  { themes: ["悬疑推理"], axis: "mystery", bonus: 0.3, needBase: 0.1 },
  { themes: ["克苏鲁", "怪谈"], axis: "nightmare", bonus: 0.25, needBase: 0.1 },
  { themes: ["发疯文学"], axis: "absurd", bonus: 0.3, needBase: 0.08 }
];

/**
 * @param {object} detect  novel_settings detect 的输出（culture/scores/evidence/genre/theme）
 * @param {object} emotion novel_sentence_analysis 的 emotion 块
 * @returns 氛围光谱 { axes, top, conclusion, confidence, evidence }
 */
export function computeVibe(detect, emotion, text = "") {
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
  const neg = implicit.negative ?? 0;
  const pos = implicit.positive ?? 0;
  const amb = implicit.ambiguousRatio ?? 0;
  const C = q.stats?.conflict ?? 0;
  const V = q.stats?.variance ?? 0;

  const westernCount = Object.values(wF).reduce((s, x) => s + x, 0);
  // v2.5 修复：detect 不输出 questionRatio，改为从文本直接统计疑问句占比
  const questionRatio = text ? Math.min(1, (text.match(/[?？]/g) || []).length / Math.max(1, (text.match(/[。！？!?]/g) || []).length)) : 0;
  // v2.2.0 网文信号：动作/套路词群扫描（封顶计分）
  // v2.6.0 提速：原 12 轴×164 词全文本 indexOf 扫描 → 先滑窗统计 2-4 字词频（Map），词表命中改查表
  // v3.5.0 #58：只生成词表实际词长的 n-gram（旧版逐位生成 2/3/4 字 ≈ 3×字数条目，50 万字书 ~150 万键）
  // v3.5.0 R5(#58)：滑窗只生成 2-4 字 n-gram（词表 >4 字词低频，单独 indexOf 查，不放大内存）
  const longWords = new Set();
  const signalLens = new Set();
  for (const axisWords of Object.values(WEB_NOVEL_SIGNALS)) {
    for (const w of axisWords) { if (w.length >= 2 && w.length <= 4) signalLens.add(w.length); else if (w.length > 4) longWords.add(w); }
  }
  const textWordCounts = new Map();
  if (text) {
    for (const run of String(text).match(/[\u4e00-\u9fa5]{2,}/g) || []) {
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
      while ((from = text.indexOf(lw, from)) !== -1) { cnt++; from += lw.length; }
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
  const modernCount = Object.values(mF).reduce((s, x) => s + x, 0);
  const horror = themes.includes("恐怖灵异") || /恐怖|灵异|惊悚/.test(theme);
  const mystery = themes.includes("悬疑推理") || /悬疑|推理/.test(theme) || genre.includes("悬疑");

  const axes = {};
  const push = (axis, score, weight, label) => {
    axes[axis] = axes[axis] || { score: 0, weight: 0, signals: [] };
    axes[axis].score += score * weight;
    axes[axis].weight += weight;
    axes[axis].signals.push({ s: Math.round(score * 100) / 100, w: weight, label });
  };

  // v2.2.0：网文信号辅助（动作/套路词群 + 题材联动 + 情感直给密度）
  const wnv = (axis, weight = 1.2) => {
    const n = webNovelHits[axis] || 0;
    if (n > 0) push(axis, Math.min(0.3, n * 0.025), weight, "网文词群×" + n);
  };
  const linkThemes = (axis, base) => {
    for (const l of THEME_AXIS_LINK) {
      if (l.axis === axis && l.themes.some((t) => themes.includes(t) || theme.includes(t))) {
        // v2.5.0 修复轮 7：题材联动必须已有基础信号（去掉 bonus>=0.25 绕过，"提了一句恐怖"不再强拉噩梦感）
        if ((base ?? 0) >= l.needBase) push(axis, l.bonus, 1.2, "题材联动:" + l.themes[0]);
        return;
      }
    }
  };
  const wne = (axis, density, weight = 0.8) => { if (density > 0) push(axis, density, weight, "情感词密度"); };

  // 戏谑语气检测（吐槽文 vs 温馨文的"笑"分流依据）
  const absurdWords = freqIn(ev.modern || [], ["游戏", "宿舍", "电脑", "手机", "外卖"]);
  const jocular = (webNovelHits.absurd || 0) > 0 || absurdWords > 0 || /笑死|哈哈|离谱|吐槽|沙雕|救命|摆烂|什么鬼|有毛病|玛德/.test(String(text).slice(0, 6000));

  // ① 噩梦感
  push("nightmare", clean === "fear" ? 0.85 : 0.25, 2, "clean=fear");
  push("nightmare", horror ? 0.8 : 0.1, 2.5, "恐怖灵异题材");
  push("nightmare", neg, 1.5, "意象负向");
  push("nightmare", delta < 0 ? Math.min(0.7, -delta * 5) : 0, 1, "趋势下滑");
  push("nightmare", Math.min(1, sem.nightmare * 0.4), 2, "语义恐惧/脆弱");
  wnv("nightmare", 1.1);
  wne("nightmare", fearDensity * 1.2);
  push("nightmare", clean === "sorrow" && horror ? 0.25 : 0, 1, "恐怖语境下的哀伤");
  linkThemes("nightmare", axes.nightmare?.score || 0);

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
  push("fluff", Math.min(1, sem.fluff * 0.4), 1, "语义轻松/甜蜜");
  wnv("fluff", 1.2);
  wne("fluff", joyDensity);
  linkThemes("fluff", axes.fluff?.score || 0);

  // ⑤ 催泪虐心（恐怖/猎奇语境下 sorrow 分流——恐怖文里的哀伤不是催泪）
  push("tearjerker", clean === "sorrow" ? (horror || themes.includes("恐怖灵异") || themes.includes("黑暗猎奇") ? 0.45 : 0.9) : 0.2, 2, (horror || themes.includes("恐怖灵异")) ? "clean=sorrow(恐怖分流)" : "clean=sorrow");
  push("tearjerker", neg * 0.6, 1, "意象负向");
  push("tearjerker", Math.min(1, sem.tearjerker * 0.5), 1.5, "语义失落/怅惘");
  wnv("tearjerker", 1.0);
  wne("tearjerker", sorrowDensity);
  linkThemes("tearjerker", axes.tearjerker?.score || 0);

  // ⑥ 黑暗残酷
  const darkWords = freqIn(ev.western || [], ["绞刑架", "处刑", "酷刑"]) + freqIn([...(ev.western || []), ...(ev.eastern || []), ...(ev.modern || [])], ["鲜血", "尸体", "死亡", "屠杀", "血泊"]);
  push("dark", Math.min(1, darkWords * 0.4), 2, "残酷词群");
  push("dark", clean === "anger" ? 0.5 : 0.15, 1, "clean=anger");
  push("dark", Math.min(1, sem.dark * 0.4), 1, "语义黑暗");
  push("dark", neg * 0.5, 1, "意象负向");
  wnv("dark", 0.9);

  // ⑦ 悬疑神秘
  push("mystery", mystery ? 0.85 : 0.1, 2, "悬疑题材");
  push("mystery", Math.min(1, questionRatio * 2), 1, "疑问句占比");
  push("mystery", Math.min(1, sem.mystery * 0.4), 1, "语义谜团");
  push("mystery", horror ? 0.3 : 0, 0.5, "恐怖叠加");
  wnv("mystery", 0.9);
  linkThemes("mystery", axes.mystery?.score || 0);

  // ⑧ 热血激昂
  // v2.5.0 修复轮 7：战斗词改双字（单字"战/杀"命中"战战兢兢/抹杀"误判热血）
  const fightWords = freqIn([...(ev.modern || []), ...(ev.western || []), ...(ev.eastern || [])], ["战斗", "冲锋", "斩杀", "刀光", "剑影", "铁拳", "战意", "厮杀", "刀剑", "拳风", "刀锋", "剑锋", "热血", "烈焰", "战鼓", "号角", "拔剑", "挥剑", "挥刀", "杀伐"]);
  push("blaze", clean === "anger" ? 0.8 : 0.15, 2.5, "clean=anger");
  push("blaze", Math.min(1, fightWords * 0.3), 1.5, "战斗词群");
  push("blaze", pos * 0.4, 1, "意象正向");
  wnv("blaze", 1.2);
  wne("blaze", angerDensity);
  linkThemes("blaze", axes.blaze?.score || 0);

  // ⑨ 荒诞无厘头（absurdWords 已在顶部定义）
  push("absurd", Math.min(1, absurdWords * 0.12), 1.2, "网络生活词");
  // v2.5.0 修复轮 7：反差信号需净化确有动作（caveat）才计，且降权（原来有污染时几乎必触发、权重偏大）
  push("absurd", (emotion.dominant !== emotion.cleanDominant && emotion.caveat) ? 0.3 : 0.08, 1, "情绪反差(表象≠内核)");
  if (jocular) push("absurd", 0.4, 1.2, "戏谑语气");
  wnv("absurd", 1.1);
  linkThemes("absurd", axes.absurd?.score || 0);
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
  push("aesthetic", Math.min(1, sem.aesthetic * 0.5), 1.5, "语义怅惘/释然");
  push("aesthetic", envDensity * 2.5, 2.5, "环境意象密度");
  push("aesthetic", dlgRatio < 0.12 ? 0.35 : 0.05, 1.2, "叙述性文本(对话少)");
  wnv("aesthetic", 1.3);

  // ⑫ 情欲暧昧
  push("sensual", themes.includes("情色R18") || /情色|R18/.test(theme) ? 0.75 : 0.05, 2, "情色R18题材");
  wnv("sensual", 1.2);
  push("sensual", Math.min(1, sem.sensual * 0.4), 1, "语义甜蜜/仰慕");

  const names = {
    nightmare: "噩梦感", angst: "焦虑压抑", heartwarming: "温馨治愈", fluff: "甜宠日常",
    tearjerker: "催泪虐心", dark: "黑暗残酷", mystery: "悬疑神秘", blaze: "热血激昂",
    absurd: "荒诞无厘头", lonesome: "孤独疏离", aesthetic: "文艺唯美", sensual: "情欲暧昧"
  };
  const axesOut = Object.entries(axes).map(([key, v]) => ({
    key, name: names[key],
    score: Math.round(clamp01(v.score / v.weight) * 1000) / 1000,
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
    implicit.totalHits > 0 ? `意象负 ${Math.round(neg * 100)}%/正 ${Math.round(pos * 100)}%/歧义 ${Math.round(amb * 100)}%` : "无意象信号",
    delta !== 0 ? `趋势Δ=${delta >= 0 ? "+" : ""}${delta}` : "趋势平稳",
    Object.keys(dist).length > 0 ? `语义隐性: ${Object.entries(dist).slice(0, 3).map(([k, v]) => k + "×" + v).join("/")}` : ""
  ].filter(Boolean);

  return { axes: axesOut, top, conclusion, confidence: Math.round(confidence * 100) / 100, evidence };
}

// v2.5.0 语义风格距离：风格原型句 × 全书向量 → 距离表（0 token 本地推理，纯测量不下结论）
export const STYLE_PROTOTYPES = {
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
/** 等距抽样：超过 max 段时全书均匀取 max 段（首尾保留），避免只取开头序章失真。 */
function sampleEvenly(arr, max) {
  if (arr.length <= max) return arr;
  const out = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

/** 风格原型句向量内存缓存（STYLE_PROTOTYPES 固定 12 类×5 句，跨书复用，进程内一次）。 */
const PROTO_VEC_CACHE = new Map();

/** 语义距离按书缓存路径：<root>/.novel-writer/embedding/<书>__styleproto.json */
function styleProtoCachePath(root, book) {
  const safe = String(book).replace(/[\\/:*?"<>|]/g, "_");
  return path.join(root, ".novel-writer", "embedding", safe + "__styleproto.json");
}

/**
 * 计算全书与各风格原型的语义距离表。
 * @param {string} text 全书文本
 * @param {object} emb embedding 模块（embed/cosine/chunkText/fingerprint）
 * @param {object} [opts] 可选 { root, book }——提供后段落向量按书缓存（内容指纹失效重建，不靠版本号）
 * @returns {Array<{name:string,score:number}>} 按相似度降序
 */
export async function semanticStyleDistances(text, emb, opts = {}) {
  const results = [];
  try {
    if (!emb || typeof emb.embed !== "function") return results;
    // v2.5.0 修复轮 7：全书等距抽样 ≤60 段（原 slice(0,60) 只取开头，序章/引子会失真）
    const allChunks = emb.chunkText ? emb.chunkText(text) : [{ text: text.slice(0, 2000) }];
    if (allChunks.length === 0) return results;
    const chunks = sampleEvenly(allChunks, 60);
    const fp = typeof emb.fingerprint === "function" ? emb.fingerprint(chunks) : null;
    // 段落向量：优先复用按书缓存（fp 匹配才命中；不匹配/缺失/损坏则重建）
    let bookVecs = null;
    let cacheFile = null;
    if (opts?.root && fp) {
      try {
        cacheFile = styleProtoCachePath(opts.root, opts.book);
        if (fs.existsSync(cacheFile)) {
          // v2.6.0：zstd 压缩存储（旧版纯 JSON 自动兼容）
          const buf = fs.readFileSync(cacheFile);
          let data = null;
          if (zstdDecompressSync) {
            try { data = JSON.parse(zstdDecompressSync(buf).toString("utf8")); } catch { /* 非 zstd 旧格式 */ }
          }
          if (!data) { try { data = JSON.parse(buf.toString("utf8")); } catch { /* 损坏 */ } }
          if (data && data.fp === fp && Array.isArray(data.bookVecs) && data.bookVecs.length === chunks.length) {
            bookVecs = data.bookVecs;
          }
        }
      } catch { /* 缓存损坏 → 重建 */ }
    }
    if (!bookVecs) {
      bookVecs = [];
      for (const ch of chunks) {
        try {
          const vec = await emb.embed(ch.text);
          if (vec && vec.length > 0) bookVecs.push(vec);
        } catch { /* 单段失败跳过 */ }
      }
      if (cacheFile && fp && bookVecs.length > 0) {
        try {
          fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
          const rounded = bookVecs.map((v) => v.map((x) => Math.round(x * 10000) / 10000));
          const payload = Buffer.from(JSON.stringify({ fp, bookVecs: rounded }), "utf8");
          fs.writeFileSync(cacheFile, zstdCompressSync ? zstdCompressSync(payload) : payload);
        } catch { /* 写缓存失败不影响结果 */ }
      }
    }
    if (bookVecs.length === 0) return results;
    const dim = bookVecs[0].length;
    const bookMean = new Array(dim).fill(0);
    for (const vec of bookVecs) for (let i = 0; i < dim; i++) bookMean[i] += vec[i] / bookVecs.length;
    for (const [name, sentences] of Object.entries(STYLE_PROTOTYPES)) {
      try {
        let pMean = PROTO_VEC_CACHE.get(name);
        if (!pMean || pMean.length !== dim) {
          const pVecs = [];
          for (const s of sentences) {
            const vec = await emb.embed(s);
            if (vec && vec.length === dim) pVecs.push(vec);
          }
          if (pVecs.length === 0) continue;
          pMean = new Array(dim).fill(0);
          for (const vec of pVecs) for (let i = 0; i < dim; i++) pMean[i] += vec[i] / pVecs.length;
          PROTO_VEC_CACHE.set(name, pMean);
        }
        const score = emb.cosine(bookMean, pMean);
        if (Number.isFinite(score)) results.push({ name, score: Math.round(score * 1000) / 1000 });
      } catch { /* 单原型失败跳过 */ }
    }
  } catch { /* 整体失败返回空 */ }
  return results.sort((a, b) => b.score - a.score);
}
