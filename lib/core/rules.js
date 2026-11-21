/**
 * dsh-novel-writer — core/rules.js（Layer 3A：文化/题材/流派检测、碰撞守卫与世界观用语规范单一裁决点）
 *
 * 严格 DAG 3A 层：只依赖 ../lexicons/* 与 ../packs.js，不依赖同层其他 domain 模块与 http。
 */

import { CULTURE_MARKERS, GENRE_MARKERS, THEME_MARKERS, DEFAULT_BANNED_WORDS, SPEECH_STYLE_RULES } from "../lexicons/markers.js";
import { COLLISION_GUARDS } from "../lexicons/guards.js";
import { normalizePack, resolvePackForBook } from "../packs.js";

/**
 * 该命中是否为**子串巧合**（应当忽略）。
 *
 * 判据极简且可审计：词**紧邻的前/后一个字**是否落在守卫表里。
 * 例：「这[里正]是」的前一字是「这」→ 巧合；「[在下]面」的后一字是「面」→ 巧合。
 *
 * 纪律：**错填会吃掉真命中**（静默漏报），所以守卫表只收有实证的字（见 lexicons/guards.js）。
 */
export function isGuardedArtifact(word, line, index) {
  const g = COLLISION_GUARDS[word];
  if (!g || typeof line !== "string" || !Number.isInteger(index) || index < 0) return false;
  // ① 单字邻接（最常见：这里+正是 / 在+下面 / 大+人物）
  if (Array.isArray(g.notBefore) && index > 0) {
    const before = line[index - 1];
    if (before && g.notBefore.includes(before)) return true;
  }
  if (Array.isArray(g.notAfter)) {
    const after = line[index + word.length];
    if (after && g.notAfter.includes(after)) return true;
  }
  // ② 多字序列（单字判不到的：如「老夫老妻」——匹配后紧跟的是「老」，而「老夫老矣」是真用法，
  //    故不能简单把「老」放进 notAfter，必须判完整的「老妻」序列）
  if (Array.isArray(g.notAfterSeq)) {
    for (const s of g.notAfterSeq) {
      if (typeof s === "string" && s !== "" && line.startsWith(s, index + word.length)) return true;
    }
  }
  if (Array.isArray(g.notBeforeSeq)) {
    for (const s of g.notBeforeSeq) {
      if (typeof s === "string" && s !== "" && index >= s.length && line.slice(index - s.length, index) === s) return true;
    }
  }
  return false;
}

const SORTED_MARKER_WORDS = new Map();
function sortedMarkerWords(words) {
  let cached = SORTED_MARKER_WORDS.get(words);
  if (cached === undefined) {
    cached = words.slice().sort(function (a, b) { return b.length - a.length; });
    SORTED_MARKER_WORDS.set(words, cached);
  }
  return cached;
}
function scanWordHits(text, words) {
  const used = new Uint8Array(text.length);
  const hits = [];
  for (const word of sortedMarkerWords(words)) {
    const wlen = word.length;
    // v4.3.0 修正：补空词条守卫——wlen===0 时 from = hit + 0 不推进，while 条件恒真 → 死循环。
    // 当前词表无空串，属"缺守卫"的潜在缺陷（词典/自定义词表一旦引入空串就是挂死）
    if (wlen <= 0) continue;
    let n = 0;
    let from = 0;
    while (from <= text.length - wlen) {
      const hit = text.indexOf(word, from);
      if (hit === -1) break;
      if (isGuardedArtifact(word, text, hit)) {
        from = hit + wlen;
        continue;
      }
      let blocked = false;
      for (let i = hit; i < hit + wlen; i += 1) {
        if (used[i] === 1) { blocked = true; break; }
      }
      if (!blocked) {
        n += 1;
        for (let i = hit; i < hit + wlen; i += 1) used[i] = 1;
      }
      from = hit + wlen;
    }
    if (n > 0) hits.push({ word, count: n });
  }
  return hits;
}
export function detectCulture(text) {
  const scores = { western: 0, eastern: 0, modern: 0 };
  const evidence = { western: [], eastern: [], modern: [] };
  // v3.5.0 M4：词表去重扫描（同表重复词如 城堡×2/便利店×2 不再双计）
  // v3.6.0：同文化子串最长匹配（"高潮迭起"命中后 "高潮" 不再重复计）
  // v4.0.0：改单遍 + 占用位图（重复词第二次扫描命中 0，与旧占位替换等价）
  for (const [culture, table] of Object.entries(CULTURE_MARKERS)) {
    for (const hit of scanWordHits(text, table.words)) {
      scores[culture] += hit.count;
      if (evidence[culture].length < 8) evidence[culture].push(hit.word + "×" + hit.count);
    }
  }
  const total = scores.western + scores.eastern + scores.modern;
  let culture = "unknown";
  let confidence = 0;
  if (total > 0) {
    // v1.0.2：modern 优先——现代词命中足够多时直接判现代（避免剧情西式词误导）
    const cultureTotal = scores.western + scores.eastern;
    if (scores.modern >= 5 && scores.modern >= Math.max(scores.western, scores.eastern, 1)) {
      culture = "modern";
      confidence = Math.min(0.95, 0.5 + scores.modern / (total * 2));
    } else if (cultureTotal > 0) {
      const ratio = scores.western / Math.max(scores.eastern, 1);
      if (ratio >= 2) { culture = "western"; confidence = Math.min(0.95, 0.5 + scores.western / (total * 2)); }
      else if (ratio <= 0.5) { culture = "eastern"; confidence = Math.min(0.95, 0.5 + scores.eastern / (total * 2)); }
      else { culture = "mixed"; confidence = 0.5; }
    } else {
      culture = "modern";
      confidence = Math.min(0.95, 0.5 + scores.modern / (total * 2));
    }
  }
  return { culture, confidence: Math.round(confidence * 100) / 100, scores, evidence, total };
}
export function detectGenre(text) {
  const hits = {};
  const evidence = {};
  // v3.7.0 引擎①：同流派子串最长匹配（"魔法师"不再被 魔法+法师+魔法师 计 3 次；先长后短 + 占位）
  // v4.0.0：单遍 + 占用位图
  for (const [genre, words] of Object.entries(GENRE_MARKERS)) {
    let count = 0;
    const found = [];
    for (const hit of scanWordHits(text, words)) {
      count += hit.count;
      if (found.length < 6) found.push(hit.word + "×" + hit.count);
    }
    if (count > 0) { hits[genre] = count; evidence[genre] = found; }
  }
  // v1.5.0：count < 5 视为噪音省略
  const filtered = Object.entries(hits).filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]);
  return {
    dominant: filtered[0]?.[0] ?? null,
    genres: filtered.slice(0, 3).map(([g, n]) => ({ genre: g, count: n })),
    evidence
  };
}
export function detectTheme(text) {
  const hits = {};
  const evidence = {};
  for (const [theme, words] of Object.entries(THEME_MARKERS)) {
    let count = 0;
    const found = [];
    // v3.5.0：同主题子串最长匹配（"高潮迭起"命中后 "高潮" 不再重复计；先长后短 + 占位）
    // v4.0.0：单遍 + 占用位图
    for (const hit of scanWordHits(text, words)) {
      count += hit.count;
      if (found.length < 6) found.push(hit.word + "×" + hit.count);
    }
    if (count > 0) { hits[theme] = count; evidence[theme] = found; }
  }
  // v1.5.0：count < 5 视为噪音省略
  const filtered = Object.entries(hits).filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]);
  return {
    dominant: filtered[0]?.[0] ?? null,
    secondary: filtered[1]?.[0] ?? null,
    themes: filtered.slice(0, 5).map(([t, n]) => ({ theme: t, count: n })),
    evidence
  };
}

// ============ v6.4.0（P0-2 / P0-4）：世界观用语规范的**单一裁决点** ============
/**
 * 文化基准提示词判定：看**登记文本**（basis / name / description / ritual / notes）落在哪一支。
 *
 * v4.0.0 起这段内联在 index.js 的「登记 worldview 时自动推导语用规范」分支里；
 * v6.4.0 抽到 core.js，让「登记时推导语用规范」与「resolveStyleRule 决定用哪张默认表」
 * 用的是**同一套判据**——否则两处会各判一次、结论还可能不一致。
 */
const HINT_NEGATION_RE = /(?:禁(?:止|用)?|避免|不要|忌(?:用)?)[^，。；;\n]{0,30}|非(?:中式|东方式|东方|西式|西方|欧式|古风|现代|都市)[^，。；;\n]{0,12}/g;
const HINT_EASTERN_RE = /中式|东方|中原|中土|古装|古风|客栈|老爷|少侠|江湖|茶楼|媒婆|太监|衙门|香客/g;
const HINT_WESTERN_RE = /west|西方|欧式|西式|教廷|教堂|神甫|公爵|骑士|城堡|女巫|庄园|圣器|牧师|弥撒/gi;
const HINT_MODERN_RE = /现代日常|现代|都市|职场|科幻|赛博|末世|校园|悬疑|刑侦|现言|商战|医院|警局/g;

export function hintCulture(text) {
  const s = String(text ?? "").replace(HINT_NEGATION_RE, " ");
  const counts = {
    eastern: (s.match(HINT_EASTERN_RE) || []).length,
    western: (s.match(HINT_WESTERN_RE) || []).length,
    modern: (s.match(HINT_MODERN_RE) || []).length
  };
  const ranked = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 1 || (ranked.length > 1 && ranked[0][1] > ranked[1][1])) {
    return { culture: ranked[0][0], confidence: 1, scores: counts, evidence: {}, total: ranked[0][1] };
  }
  if (ranked.length > 1) {
    const det = detectCulture(s);
    if (det.culture !== "unknown") return det;
    return { culture: "mixed", confidence: 0.5, scores: counts, evidence: {}, total: ranked.reduce((a, [, n]) => a + n, 0) };
  }
  return detectCulture(s);
}

// v7.1.0 修正（审查 #55）：「用词豁免」是 v6.5.0 引入的**保留条目名**——它只承载 allowWords
// （逐词静音），不是"这本书的文化基准"的声明。旧版把它当 cultureName，审计文案会写成
// 「与当前文化基准「用词豁免」不符」，语义完全错位。这里显式过滤保留名（而不是"只要有
// allowWords 就过滤"：正常命名的文化条目也可能同时带 allowWords，仍应以它的名字为准）。
// 注意：过滤只作用于**展示名**；豁免本身（bannedWords/speechStyle 的静音）仍按原逻辑生效。
const RESERVED_CULTURE_ENTRY_NAMES = new Set(["用词豁免"]);
function cultureEntryName(entry) {
  const name = String(entry?.name ?? "");
  const trimmed = name.trim();
  return trimmed !== "" && !RESERVED_CULTURE_ENTRY_NAMES.has(trimmed) ? name : "";
}

/**
 * 世界观「用语规范」的唯一裁决点 —— 开写包与连贯性审计**都必须**调它。
 *
 * ## 为什么必须有它（v6.4.0 的核心修复）
 *
 * 此前两处**各拿一套词源**：
 *   - 开写包（决定模型看到什么）：只读用户登记的 `bannedWords`，**没有默认表兜底**
 *     → 用户登记了 worldview 但没显式填禁词时，模型看不到任何禁词
 *   - 连贯性审计（决定事后查出什么）：`用户登记 ?? DEFAULT_BANNED_WORDS`，**有默认表兜底**
 * 于是两道防线错开：该告诉模型的没告诉，能查出来的（在章节模式下）又没查。
 * 更糟的是那个 `??` 是**硬替换**：用户哪怕只登记 1 个词，含「掌柜/客栈/银两/衙门」的
 * 整张欧式默认表就被整份丢弃 —— **越精心配置，防护越弱**。
 *
 * 现在两处都调本函数，结构上不可能再分叉。
 *
 * ## 合并语义
 *
 *   bannedWords = 去重（用户登记 ∪ 文化基准对应的默认表）
 *   **显式登记 `bannedWords: []` 表示「我不要默认表」，此时不合并**
 *   （沿用 v4.0.0「显式空 ≠ 未登记」的语义，见 index.js 旧注释）
 *
 * 默认表随**文化基准**选，这是关键——不能无条件合并欧式表，否则中式书会被误报：
 *   western → `DEFAULT_BANNED_WORDS`（欧式表：老夫/上香/掌柜/客栈/银两/衙门/郎中…，见 `markers.js` 的 `groups`）
 *   eastern → `SPEECH_STYLE_RULES.eastern.honorBad`（**禁西式词**：Miss/先生/教堂/神甫…）
 *   modern  → 空（现代都市无文化禁用词）
 *   unknown → 落 western（历史默认），并在 `sources.cultureSource` 标成 `"default"`
 *
 * > ⚠️ 注释里**不要写死词数**：词表会增补（v6.4.0 就从 42 增到 69），
 * >    写死的数字必然腐烂——本文件此前四处「40 词」就是这么过期的。要查数量请读 `DEFAULT_BANNED_WORDS.bannedWords.length`。
 *
 * ## 文化基准的判定顺序
 *   ① 登记文本（任一 worldview 条目的 basis/name/description/ritual/notes）——
 *      登记是用户显式声明的，优先级最高，且不依赖正文长度
 *   ② 正文检测（`chapterTexts`，接受 `string[]` 或 `{text}[]`）——未登记时才用
 *   ③ 落默认欧式
 *
 * @param {object} settings 设定表（`readSettings` 的返回值；容忍 undefined/null）
 * @param {Array<string|{text?:string}>} [chapterTexts] 正文样本；**调用方应尽量传入**，
 *        否则未登记 worldview 的书无法按正文判出文化基准，会落成欧式默认
 * @returns {{culture:string, cultureSource:"worldview"|"detected"|"default", cultureName:string,
 *            bannedWords:string[], recommended:Record<string,string>, speechStyle:object|null,
 *            userBannedWords:string[], defaultEnabled:boolean,
 *            sources:{userCount:number, defaultCount:number, total:number, hint:string|null}}}
 */
export function resolveStyleRule(settings, chapterTexts = [], opts = {}) {
  const worldviewList = Array.isArray(settings?.worldview) ? settings.worldview.filter((e) => e && typeof e === "object") : [];
  const reversed = worldviewList.slice().reverse();

  // 题材规则包解析：opts.pack（对象或 ID）> worldview[].pack > 按书自定义包（<root>/.novel-writer/packs/<book>.json）
  let activePack = null;
  const optPack = opts?.pack;
  if (optPack && typeof optPack === "object" && !Array.isArray(optPack)) {
    const hasInlineRules = Array.isArray(optPack.bannedWords)
      || Array.isArray(optPack.allowWords)
      || Array.isArray(optPack.slopMuteCategories)
      || (optPack.speechStyle && typeof optPack.speechStyle === "object")
      || (optPack.recommended && typeof optPack.recommended === "object")
      || (typeof optPack.baseCulture === "string" && optPack.baseCulture.trim() !== "");
    if (hasInlineRules) {
      const normalized = normalizePack(
        { ...optPack, id: typeof optPack.id === "string" && optPack.id.trim() !== "" ? optPack.id.trim() : "inline-pack" },
        { source: optPack.source || "inline" }
      );
      if (normalized.pack) activePack = normalized.pack;
    } else if (typeof optPack.id === "string" && optPack.id.trim() !== "") {
      activePack = resolvePackForBook({ packId: optPack.id.trim(), book: opts?.book, root: opts?.root });
    }
  } else {
    const packEntry = reversed.find((e) => typeof e.pack === "string" && e.pack.trim() !== "");
    const packId = typeof optPack === "string" && optPack.trim() !== ""
      ? optPack.trim()
      : packEntry
        ? packEntry.pack.trim()
        : "";
    activePack = resolvePackForBook({ packId, book: opts?.book, root: opts?.root });
  }

  // ① 用户登记的禁词表：取「最近一个含 bannedWords 字段」的条目（**含显式空数组**）
  //    —— 与语用规范解耦：后登记的 speechStyle 不得遮蔽先登记的 bannedWords（v3.9.5 修正的语义）
  // v7.3.1 修（#3）：旧版是「先找最近的非空条目，找不到再找最近的含字段条目」——顺序反了。
  // 于是先登记 `bannedWords: ["老爷"]`、后登记 `bannedWords: []`（显式"我不要默认表"）时，
  // `[]` 会被旧的非空条目遮蔽，默认禁用词表照样启用，「显式空数组 = 不要默认表」这条语义直接失效。
  // 现在严格按注释：**离现在最近的那个含 bannedWords 字段的条目说了算**，空数组也算数。
  const bannedEntry = reversed.find((e) => Array.isArray(e.bannedWords));
  // ② 语用规范：合并题材包（若命中）与**全部**用户条目的 speechStyle（用户条目后入覆盖标量、数组去重、对象浅合并）
  const speechEntry = reversed.find((e) => e.speechStyle && typeof e.speechStyle === "object");
  const speechSources = activePack && activePack.speechStyle
    ? [{ speechStyle: activePack.speechStyle }, ...worldviewList]
    : worldviewList;
  const speechStyle = (() => {
    const out = {};
    for (const e of speechSources) {
      const sp = e.speechStyle;
      if (!sp || typeof sp !== "object") continue;
      for (const [k, v] of Object.entries(sp)) {
        if (Array.isArray(v)) {
          const cur = Array.isArray(out[k]) ? out[k] : [];
          for (const x of v.map(String)) if (x !== "" && !cur.includes(x)) cur.push(x);
          if (cur.length > 0) out[k] = cur;
        } else if (v && typeof v === "object") {
          out[k] = { ...(out[k] && typeof out[k] === "object" ? out[k] : {}), ...v };
        } else if (v !== void 0 && v !== null && String(v) !== "") {
          out[k] = String(v);
        }
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  })();
  const userRecommended = {};
  for (const e of worldviewList) {
    if (e.recommended && typeof e.recommended === "object") Object.assign(userRecommended, e.recommended);
  }

  const userBannedWords = bannedEntry ? bannedEntry.bannedWords.map(String).filter((w) => w !== "") : [];
  // 显式 `bannedWords: []` = 「我不要默认表」；未登记 = 用默认表
  const defaultEnabled = !(bannedEntry && bannedEntry.bannedWords.length === 0);

  // ③ 文化基准：登记文本（显式 basis/description/ritual/notes）→ 题材包 baseCulture → 条目名 name → 正文检测 → 默认欧式
  const explicitHintParts = [];
  const nameHintParts = [];
  for (const e of worldviewList) {
    for (const s of [e.basis, e.description, e.ritual, e.notes]) {
      if (typeof s === "string" && s.trim() !== "") explicitHintParts.push(s.trim());
    }
    if (typeof e.name === "string" && e.name.trim() !== "") nameHintParts.push(e.name.trim());
  }
  const texts = (Array.isArray(chapterTexts) ? chapterTexts : [])
    .map((t) => (typeof t === "string" ? t : t && typeof t.text === "string" ? t.text : ""))
    .filter((s) => s !== "");
  let culture = "unknown";
  let cultureSource = "default";
  let hint = null;
  if (explicitHintParts.length > 0) {
    hint = hintCulture(explicitHintParts.join("；"));
    if (hint.culture !== "unknown") { culture = hint.culture; cultureSource = "worldview"; }
  }
  if (culture === "unknown" && activePack && ["western", "eastern", "modern"].includes(activePack.baseCulture)) {
    culture = activePack.baseCulture;
    cultureSource = "pack";
  }
  if (culture === "unknown" && nameHintParts.length > 0) {
    hint = hintCulture(nameHintParts.join("；"));
    if (hint.culture !== "unknown") { culture = hint.culture; cultureSource = "worldview"; }
  }
  if (culture === "unknown" && texts.length > 0) {
    const det = detectCulture(texts.join("\n"));
    if (det.culture !== "unknown") { culture = det.culture; cultureSource = "detected"; }
  }
  if (culture === "unknown") { culture = "western"; cultureSource = "default"; }

  // ④ 该文化基准对应的默认表（注意 eastern 是**禁西式词**，方向与 western 相反）
  // v6.4.0 修正：`mixed`（detectCulture 在东西方信号势均力敌时给出）此前落进 else 分支，
  // 于是 cultureName 显示成**默认欧式表的名字**，而 cultureSource 却是 "detected" ——
  // 审计文案会写成「与当前文化基准「欧式中世纪晚期（默认）」不符（未登记 worldview，基准由正文自动检测…）」，
  // 自相矛盾（独立验证子代理发现）。现在 mixed 单列一个诚实的名字；词表仍用欧式表
  // （混合稿更需要防中式渗透，且这个方向不会误伤中式词）。
  const base = culture === "eastern"
    ? { culture: "东方/中式古代（默认）", bannedWords: SPEECH_STYLE_RULES.eastern.honorBad.slice(), recommended: { ...SPEECH_STYLE_RULES.eastern.honorGood } }
    : culture === "modern"
      ? { culture: "现代都市（默认）", bannedWords: [], recommended: {} }
      : culture === "mixed"
        ? { culture: "东西方混合（正文检测）", bannedWords: DEFAULT_BANNED_WORDS.bannedWords.slice(), recommended: { ...DEFAULT_BANNED_WORDS.recommended } }
        : { culture: DEFAULT_BANNED_WORDS.culture, bannedWords: DEFAULT_BANNED_WORDS.bannedWords.slice(), recommended: { ...DEFAULT_BANNED_WORDS.recommended } };

  // ⑤ 合并（优先级：用户登记 worldview > 题材包 > 文化默认表；显式 bannedWords: [] 清空默认与包禁词）
  const packBannedWords = activePack && Array.isArray(activePack.bannedWords) ? activePack.bannedWords : [];
  const merged = [];
  for (const w of userBannedWords) if (!merged.includes(w)) merged.push(w);
  if (defaultEnabled) {
    for (const w of packBannedWords) if (!merged.includes(w)) merged.push(w);
    for (const w of base.bannedWords) if (!merged.includes(w)) merged.push(w);
  }
  // 替代词：用户登记 > 题材包 > 文化默认表
  const packRecommended = defaultEnabled && activePack && activePack.recommended && typeof activePack.recommended === "object"
    ? activePack.recommended
    : {};
  const recommended = { ...(defaultEnabled ? base.recommended : {}), ...packRecommended, ...userRecommended };

  // ⑥ v6.5.0：**逐词静音**（本书豁免）。
  //
  // 解决什么问题：词表是"猜"这本书的。但有些词在**这本书里就是对的**——
  // 修仙小说里的「修士」＝修行者（语料 308 次全是这个义）、中文历史小说里真有一座「教堂」。
  // 此前用户**没有任何办法**告诉插件"这个我知道"：只能每次手动忽略（下次还报）、
  // 或关掉整个用语检查（别的词也不查了）、或把词从表里删掉（**所有书**都不查了，影响面过大）。
  //
  // 静音只作用于**本书**（不提供全局静音）：全局静音会静默削弱所有书的覆盖，
  // 而人很难记得自己什么时候加过；按书静音最坏只是"这本书里漏"，看得见、摸得着。
  //
  // 过滤放在本函数（**单一裁决点**）而不是各消费方——这样开写包 / 审计 / 改稿台
  // 四个入口自动一致，不会出现"审计静音了但开写包还在警告"的分裂。
  const allow = new Set([
    ...(Array.isArray(opts?.allowWords) ? opts.allowWords : []),
    ...(activePack && Array.isArray(activePack.allowWords) ? activePack.allowWords : []),
    // 用户登记的豁免：worldview 条目上的 allowWords（并集）。
    // 复用既有表而不是新开一张，这样 `novel_settings add category=worldview name="用词豁免"
    // allowWords=["修士"]` 就能静音，且**没有登记过 worldview 的书**也能用（加这一条即可）。
    // 该条目的 name 不含文化标记词，故不会影响 hintCulture 的基准判定。
    ...worldviewList.flatMap((e) => (Array.isArray(e.allowWords) ? e.allowWords : []))
  ].map((w) => String(w ?? "").trim()).filter((w) => w !== ""));
  const bannedWords = allow.size > 0 ? merged.filter((w) => !allow.has(w)) : merged;
  const speechStyleFiltered = (() => {
    if (allow.size === 0 || !speechStyle) return speechStyle;
    const out = { ...speechStyle };
    if (Array.isArray(out.honorBad)) out.honorBad = out.honorBad.filter((w) => !allow.has(w));
    return out;
  })();

  const cultureName = cultureEntryName(bannedEntry) || cultureEntryName(speechEntry) || (activePack ? activePack.name : "") || base.culture;
  // 语用规范条目名：沿用 index.js 既有口径（speechEntry.name 优先，缺则回落题材包/cultureName）
  const speechCultureName = cultureEntryName(speechEntry) || (activePack && activePack.speechStyle ? activePack.name : "") || cultureName;
  const defaultCount = defaultEnabled
    ? (activePack ? new Set([...packBannedWords, ...base.bannedWords]).size : base.bannedWords.length)
    : 0;
  const result = {
    culture,
    cultureSource,
    cultureName,
    speechCultureName,
    bannedWords,
    recommended,
    speechStyle: speechStyleFiltered,
    userBannedWords,
    defaultEnabled,
    registered: worldviewList.length > 0,
    // v6.5.0：把静音结果一并回传——审计文案要能说清"为什么少报了几条"
    allowedWords: [...allow],
    sources: {
      userCount: userBannedWords.length,
      defaultCount,
      total: bannedWords.length,
      muted: merged.length - bannedWords.length,
      hint: hint ? hint.culture : null
    }
  };
  if (activePack) {
    result.pack = {
      id: activePack.id,
      name: activePack.name,
      source: activePack.source,
      baseCulture: activePack.baseCulture,
      slopMuteCategories: Array.isArray(activePack.slopMuteCategories) ? activePack.slopMuteCategories.slice() : []
    };
  }
  return result;
}
