/**
 * dsh-novel-writer — lib/tools/continuity.js（连贯性审计工具与用语/语用扫描）
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EASTERN_MARKER_BANLIST } from "../lexicons/markers.js";
import { logEvent } from "../log.js";
import { assert, assertToolEnabled, atomicWriteJson, bookDir, CREATION_FILES, creationDir, detectChapterBridge, findChapter, formatLineRanges, isAbort, isGuardedArtifact, mergeLineRanges, normalizeSettingList, novelDataDir, OUTLINE_LINE_RE, readSettings, readTextFile, requiredString, resolveRoot, resolveStyleRule, sanitizeSegment, scanChapters, splitSentences, validatePattern } from "../core.js";
import { capCandidateChapters } from "./shared.js";

/**
 * v6.4.0（P1-1）：用语/语用扫描的**单一实现**，全书审计与单章自检共用。
 *
 * 为什么必须抽出来：旧实现把这段四路扫描写在函数尾部的「全书模式」返回路径上，而 `chapter` 参数
 * 在函数前段就 `return`（只做与上一章的衔接审计）——用户写完一章调
 * `novel_continuity_check(chapter="第02章")` 自检时，世界观禁词与语用命中**永远走不到**，
 * 「自检没报问题」被读成「没问题」，是假安心（与 P0-4 的 resolveStyleRule 同因：判定点分散就会分叉）。
 * 抽成函数后两种模式共用同一套口径（禁词/客套/仪式/称谓四路 + 同一套截断与文案），结构上不可能再分叉。
 *
 * @param {object} styleRule core.resolveStyleRule() 的返回值（禁词表已合并「用户登记 ∪ 文化基准默认表」）
 * @param {Array<{file:string,text:string}>} chapterTexts 待扫章节；单章模式只传本章
 * @param {boolean} singleChapter true=章节模式（措辞说「本章」，不再说「×N章」）
 * @returns {Array<{type:string,detail:string,chapters:string[]}>} 与全书模式**同 type** 的候选
 */
/**
 * v6.5.0：用语候选的**分档**与**定位**（本次误报修复的核心）。
 *
 * ## 为什么要分档
 *
 * 判定本质是 `text.includes(word)`（纯子串）。而禁用词 **93% 是 2 字词**
 * （DEFAULT_BANNED_WORDS 69 条中 64 条），中文又没有词边界——于是"词"与"恰好相邻的两个字"
 * 被当成同一件事。实测：19 句**完全无辜**的句子报出 15 条，其中 14 条是误报
 * （「这[里正]是」「[在下]面」「大[大人]物」「知[道士]兵」「确[保长]期」「所[有劳]动」…）。
 *
 * 但插件**在字面上无法**区分「里正＝官名」与「这里＋正是」——而模型读一眼那一行就能判断。
 * 所以职责重新划分：
 *   插件负责**指出可疑 + 给出可核对的位置（行号区间）**；模型负责**读那一行做判断**。
 * 这与插件里既有的「情感净化预警：污染时提示 AI 抽查原文复核」是同一套做法，
 * 也与词表审计（auditLexicon）已有的"带行号定位"口径一致。
 *
 * ## 三档
 *   hard   —— 3+ 字词：语料实测 0 误报（青石板/火折子/八仙桌/不敢当），直接要求改
 *   review —— 2 字词：给行号区间，**明确允许模型判"不是问题"**（否则会退化成一律照改）
 *   info   —— 纯提示，不要求动作
 *
 * ## 位置口径（有历史教训，勿改）
 * 行号 = **该文件内的真实行号**，切行用 `/\r?\n/`（与 auditLexicon 一致）。
 * 必须先**逐章**取行号、再带章名合并；绝不可把多章拼成一份文本后取偏移
 * ——旧实现那样做，报出的 Lx 既不是任何文件的真实行号、也不带章名（见本文件内相关注释）。
 *
 * @param {object} styleRule resolveStyleRule 的结果
 * @param {Array<{file:string,text:string}>} chapterTexts 待扫章节；单章模式只传本章
 * @param {boolean} singleChapter
 */
function collectStyleCandidates(styleRule, chapterTexts, singleChapter) {
  const out = [];
  const cultureName = styleRule.cultureName;
  const speechCultureName = styleRule.speechCultureName;
  // 未登记 worldview 时默认表仍生效（resolveStyleRule 的 detected/default 两路），必须告知基准从哪来。
  // v6.4.0：检测命中与落默认要分开说——旧文案一律写"使用默认基准"，与 cultureSource 相矛盾。
  const unregisteredNote = styleRule.registered
    ? ""
    : styleRule.cultureSource === "pack"
      ? `（未登记 worldview，基准由题材包「${styleRule.pack?.name || styleRule.pack?.id || ""}」[${styleRule.pack?.id || ""}] 提供）`
      : styleRule.cultureSource === "detected"
        ? "（未登记 worldview，基准由正文自动检测；可用 novel_settings add 明确登记）"
        : "（未登记 worldview，使用默认基准；可用 novel_settings detect 自动判断）";
  const speech = styleRule.speechStyle;
  const honorSet = new Set(speech && Array.isArray(speech.honorBad) ? speech.honorBad : []);

  // 预切：行（定位用）与「句 + 所属行号」（正则扫描用）。
  // 逐句是**结构性**防线：整章扫时含通配的模式会跨越句号与换行——实测 /上.*香/ 在 121 字文本上命中 115 字。
  // 同时它把单次匹配的输入规模限住，是 ReDoS 的第二道防线（第一道是 validatePattern 的静态拒绝）。
  const prepped = (Array.isArray(chapterTexts) ? chapterTexts : []).map(function (c) {
    const raw = String(c && c.text != null ? c.text : "");
    const lines = raw.split(/\r?\n/);
    const units = [];
    for (let i = 0; i < lines.length; i += 1) {
      for (const s of splitSentences(lines[i])) units.push({ lineNo: i + 1, text: s });
    }
    return { file: String(c && c.file != null ? c.file : ""), lines, units };
  });

  /**
   * 扫一个词，返回**未被守卫挡掉**的行号区间，以及被守卫挡掉的处数。
   * 守卫（isGuardedArtifact）判的是"紧邻前/后一个字是否落在实证的碰撞表里"——
   * 错填会吃掉真命中，所以守卫表只收有实证的字（见 lexicons/guards.js 的填写纪律）。
   */
  function locate(word) {
    const perChapter = [];
    let guarded = 0;
    let total = 0;
    for (const ch of prepped) {
      const lineNos = [];
      for (let i = 0; i < ch.lines.length; i += 1) {
        const line = ch.lines[i];
        let from = 0;
        for (;;) {
          const at = line.indexOf(word, from);
          if (at < 0) break;
          total += 1;
          if (isGuardedArtifact(word, line, at)) guarded += 1;
          else if (!lineNos.includes(i + 1)) lineNos.push(i + 1);
          from = at + word.length;
        }
      }
      if (lineNos.length > 0) perChapter.push({ chapter: ch.file, ranges: mergeLineRanges(lineNos) });
    }
    return { perChapter, guarded, total };
  }

  /** 「第01章 第2-10行；第03章 第5行」——单章模式省略章名（模型知道它问的是哪一章）。 */
  function formatLocs(perChapter, max) {
    const cap = typeof max === "number" ? max : 4;
    const parts = perChapter.slice(0, cap).map(function (p) {
      return (singleChapter ? "" : p.chapter + " ") + formatLineRanges(p.ranges);
    });
    return parts.join("；") + (perChapter.length > cap ? "，等 " + perChapter.length + " 章" : "");
  }

  /** 守卫挡掉处的说明（有才加，避免每条都拖一句废话）。 */
  function guardNote(guarded) {
    return guarded > 0 ? "（另有 " + guarded + " 处疑似相邻巧合，已按邻接守卫忽略）" : "";
  }

  function chaptersOf(perChapter) {
    return capCandidateChapters(perChapter.map(function (p) { return p.chapter; })).chapters;
  }

  /** 待判档的统一收尾话术：**必须显式允许模型判"不是问题"**，否则会退化成一律照改。
   *  v6.5.0 补一句**可执行的静音指引**：同一个词在本书里本来就该用时，模型/用户不必每次都重新判断，
   *  用 novel_settings 登记 allowWords 即可（只作用于本书——全局静音会静默削弱所有书的覆盖）。 */
  function reviewTail(word) {
    return "。「" + word + "」是 2 字词，**可能是相邻两个字凑成的巧合**" +
      "（如「这[里正]是」「[在下]面」「大[大人]物」）。请读上面这些行自行判断：" +
      "若确为该词则改；若只是巧合，**不要改**，并说明你的判断依据。" +
      "若「" + word + "」在**本书**里本来就该这么用（如修仙小说里的「修士」），" +
      "可用 novel_settings add category=worldview name=\"用词豁免\" allowWords=[\"" + word + "\"] 静音（只作用于本书，其它书照常检查）。";
  }

  // ① 用语冲突：世界观禁词（3+ 字词 → 硬命中；2 字词 → 待判）
  const reported = new Set();
  for (const word of styleRule.bannedWords) {
    const loc = locate(word);
    if (loc.perChapter.length === 0) continue;
    reported.add(word);
    const rec = styleRule.recommended && styleRule.recommended[word] ? "（建议改为「" + styleRule.recommended[word] + "」）" : "";
    const where = formatLocs(loc.perChapter);
    const gn = guardNote(loc.guarded);
    const dup = honorSet.has(word) ? "（该词同属语用规范·客套，此处合并为一条）" : "";
    const head = singleChapter
      ? "本章出现「" + word + "」，与当前文化基准「" + cultureName + "」不符"
      : "「" + word + "」×" + loc.perChapter.length + "章 与当前文化基准「" + cultureName + "」不符";
    if (word.length >= 3) {
      out.push({
        type: "用语冲突",
        tier: "hard",
        word,
        detail: head + rec + "。位置：" + where + gn + dup + unregisteredNote,
        locations: loc.perChapter,
        chapters: chaptersOf(loc.perChapter)
      });
    } else {
      out.push({
        type: "用语冲突",
        tier: "review",
        word,
        detail: head + rec + "。位置：" + where + gn + dup + unregisteredNote + reviewTail(word),
        locations: loc.perChapter,
        chapters: chaptersOf(loc.perChapter)
      });
    }
  }

  // ② 语用冲突·客套（称谓/敬语）
  //    v6.5.0 去重：中式基准下 `bannedWords` 与 `speechStyle.honorBad` 是**同一份表**
  //    （登记时 index.js 写入 speechStyle.honorBad，解析时 core.js 又把它当作默认禁词表），
  //    于是每个词都会被报两遍。这里只报 ① 没报过的，并在 ① 里注明"同属客套"。
  if (speech && Array.isArray(speech.honorBad)) {
    for (const word of speech.honorBad) {
      if (reported.has(word)) continue;
      const loc = locate(word);
      if (loc.perChapter.length === 0) continue;
      reported.add(word);
      const rec = speech.honorGood && speech.honorGood[word] ? "（建议改「" + speech.honorGood[word] + "」）" : "";
      const where = formatLocs(loc.perChapter);
      const gn = guardNote(loc.guarded);
      const head = singleChapter
        ? "本章出现「" + word + "」，属于「" + speechCultureName + "」禁用表达"
        : "「" + word + "」×" + loc.perChapter.length + "章 属于「" + speechCultureName + "」禁用表达";
      if (word.length >= 3) {
        out.push({ type: "语用冲突·客套", tier: "hard", word, detail: head + rec + "。位置：" + where + gn, locations: loc.perChapter, chapters: chaptersOf(loc.perChapter) });
      } else {
        out.push({ type: "语用冲突·客套", tier: "review", word, detail: head + rec + "。位置：" + where + gn + reviewTail(word), locations: loc.perChapter, chapters: chaptersOf(loc.perChapter) });
      }
    }
  }

  // ③ 语用冲突·仪式（用户登记的正则）
  //
  // v6.5.0 两处修正：
  //   · **登记时的安全校验在这里兜底执行**——历史数据（本次修复前登记的、导入的配置）
  //     不会经过登记路径，但它们照样会让扫描卡死（实测同类模式在 29 字符上跑 40.8 秒）。
  //     被拒绝的模式**显式报出来**，而不是静默跳过：否则用户以为有保护、其实没有。
  //   · **逐句扫描**（而非整章）：跨句误报在结构上不可能（实测 /上.*香/ 曾跨 115 字命中）。
  if (speech && Array.isArray(speech.ritualBadPatterns)) {
    for (const pattern of speech.ritualBadPatterns) {
      const verdict = validatePattern(pattern);
      if (!verdict.ok && verdict.level === "reject") {
        // v6.5.0：**type 保持既有取值**（`语用冲突·仪式`），档位只由 tier 表达。
        // 独立验证代理指出：把档位/状态塞进 type 字符串会破坏既有 type 契约
        // （type = 类别，tier = 处置档位，两者正交——这是本轮立的规矩，得自己遵守）。
        out.push({
          type: "语用冲突·仪式",
          tier: "info",
          word: pattern,
          detail: "模式 /" + pattern + "/ **未生效**：" + verdict.reason + "。建议：" + verdict.suggestion +
            "。该模式目前不提供任何保护作用，请按建议改写后重新登记。",
          locations: [],
          chapters: []
        });
        continue;
      }
      // v6.5.0：`validatePattern` 内部已用同一 flags 编译过，故这里不再需要 catch 兜底分支
      //（独立验证代理指出原「模式无法编译」分支恒不可达——那是死代码，删掉而不是留着误导维护者）。
      const regex = new RegExp(pattern, "g");
      const perChapter = [];
      for (const ch of prepped) {
        const lineNos = [];
        for (const u of ch.units) {
          regex.lastIndex = 0;
          if (regex.test(u.text) && !lineNos.includes(u.lineNo)) lineNos.push(u.lineNo);
        }
        if (lineNos.length > 0) perChapter.push({ chapter: ch.file, ranges: mergeLineRanges(lineNos) });
      }
      if (perChapter.length === 0) continue;
      const warnNote = !verdict.ok && verdict.level === "warn" ? "（该模式：" + verdict.reason + "，建议 " + verdict.suggestion + "）" : "";
      out.push({
        type: "语用冲突·仪式",
        tier: "hard",
        word: pattern,
        detail: "检测到仪式类表达（规范：" + (speech.ritualGoodNote || "见 worldview 设定") + "）" + warnNote +
          "。位置：" + formatLocs(perChapter) + "。模式：/" + pattern + "/（已按句扫描，不跨句）",
        locations: perChapter,
        chapters: chaptersOf(perChapter)
      });
    }
  }

  // ④ 语用冲突·称谓：仅当称谓规范**明确否定**「XX小姐」时才扫（中式默认规范含「小姐…可用」，
  //    旧逻辑"title 含小姐即扫"会系统性误报，此处保留 v3.9.5 的否定式判定）
  if (speech && typeof speech.title === "string") {
    if (/不用.{0,8}小姐|小姐.{0,8}(禁用|不用)|禁用.{0,8}小姐|不称.{0,6}小姐/.test(speech.title)) {
      let count = 0;
      const perChapter = [];
      for (const ch of prepped) {
        const lineNos = [];
        for (let i = 0; i < ch.lines.length; i += 1) {
          const m = ch.lines[i].match(/[A-Za-z\u4e00-\u9fff]+小姐/g);
          if (m) { count += m.length; if (!lineNos.includes(i + 1)) lineNos.push(i + 1); }
        }
        if (lineNos.length > 0) perChapter.push({ chapter: ch.file, ranges: mergeLineRanges(lineNos) });
      }
      if (count > 0) {
        out.push({
          type: "语用冲突·称谓",
          tier: "hard",
          detail: "「XX小姐」×" + count + " 与称谓规范不符（" + speech.title + "）。位置：" + formatLocs(perChapter),
          locations: perChapter,
          chapters: chaptersOf(perChapter)
        });
      }
    }
  }

  // ⑤ v6.4.0（P2-3）：中式标记词的「**循环陷阱**」提示。
  //
  // 未登记 worldview 时，基准靠正文检测得出；而 `CULTURE_MARKERS.eastern.words` 里**就含「掌柜」「伙计」「客栈」**
  // —— 于是中式用语渗透词本身成了"这本书是中式"的证据：基准判成 eastern → 默认表方向翻成"禁西式词"
  // → 那些渗透词**反而不再被扫**。这是子代理 B 审计时上报的残留通道（"没登记 worldview 时仍会漏"）。
  //
  // 处置原则：**不擅自反转基准**。真正的中式书不该被误报「老夫/上香」，
  // 所以这里只把"沉默"改成"明确提示"——告诉用户基准是检测来的、这批词为何没被报、以及怎么让它生效。
  // 命中集刻意排除已在 `bannedWords` 里的词（那些已由 ① 报出，不重复）。
  if (styleRule.culture === "eastern" && styleRule.cultureSource === "detected") {
    const markerHits = EASTERN_MARKER_BANLIST.words.filter(
      (w) => !styleRule.bannedWords.includes(w) && locate(w).perChapter.length > 0
    );
    if (markerHits.length > 0) {
      const perChapter = [];
      for (const ch of prepped) {
        const lineNos = [];
        for (let i = 0; i < ch.lines.length; i += 1) {
          const line = String(ch.lines[i] ?? "");
          for (const w of markerHits) {
            if (!line.includes(w)) continue;
            let from = 0;
            let unguarded = false;
            for (;;) {
              const at = line.indexOf(w, from);
              if (at < 0) break;
              if (!isGuardedArtifact(w, line, at)) { unguarded = true; break; }
              from = at + w.length;
            }
            if (unguarded) { lineNos.push(i + 1); break; }
          }
        }
        if (lineNos.length > 0) perChapter.push({ chapter: ch.file, ranges: mergeLineRanges(lineNos) });
      }
      out.push({
        type: "文化基准存疑",
        tier: "info",
        detail:
          "正文命中中式标记词 " + markerHits.slice(0, 6).map((w) => "「" + w + "」").join("") +
          (markerHits.length > 6 ? " 等 " + markerHits.length + " 个" : "") + "，但本书**未登记 worldview**，" +
          "基准只能由正文检测得出「" + cultureName + "」。这批词同时也是判定中式基准的证据，" +
          "所以它们**不会**出现在上面的禁用词命中里。位置：" + formatLocs(perChapter) +
          "。若本书实为欧式设定，请用 novel_settings add（category=worldview、basis=\"西方/欧式中世纪\"）显式登记" +
          "——之后欧式默认禁词表即生效，这批词会逐词报出并给出建议改法。",
        locations: perChapter,
        chapters: chaptersOf(perChapter)
      });
    }
  }
  return out;
}

/**
 * v6.4.0：把 resolveStyleRule 的 cultureSource 枚举（worldview / detected / default）译成人话。
 * 直接渲染枚举值会像内部术语（用户看到「来源 default」不知道是什么意思）。
 */
function cultureSourceLabel(cultureSource) {
  return { worldview: "登记", pack: "题材包", detected: "正文检测", default: "默认" }[cultureSource] ?? String(cultureSource ?? "");
}

/**
 * v6.4.0（P1-3）：必查项清单——把「这次审计覆盖了哪些维度 / 哪些没覆盖」显式列在结论旁边。
 *
 * 为什么需要它：只看到「用语冲突 0 条」或「覆盖率 100%」会让用户/模型把「没查」读成「没事」。
 * 未登记语用规范、未登记人物、未启用大纲对照这些**盲区**过去完全不可见；现在每一条都带状态与原因。
 * state 语义：checked=本次已扫；skipped=本次本应扫但因缺登记/缺数据跳过；off=本模式不包含，需另调。
 */
/**
 * 「用语冲突」这条 checklist 的 note（**章节模式与全书模式共用一份**）。
 *
 * 为什么要抽成函数：这两个模式各有一份内联 checklist（章节模式在下方 chapterChecklist 里、
 * 全书模式走 buildAuditChecklist）。v6.5.0 我把「静音披露」只加进了全书模式那份，
 * 章节模式那份就漏了——**同一句话写两遍必然漂移**。冒烟测试正是这样抓到的
 * （静音了「里正」后，章节模式的 note 只写「已扫 68 个禁词」，看不出少报的原因）。
 *
 * 披露的用意：静音会让候选变少，而「少报」必须有痕迹，否则用户会把
 * 「我静音过」读成「这本书没问题」。
 */
function bannedWordsCheckNote(rule) {
  const packNote = rule?.pack && rule.pack.id ? `；题材包：${rule.pack.name || rule.pack.id}[${rule.pack.id}]` : "";
  if (!rule || !Array.isArray(rule.bannedWords) || rule.bannedWords.length === 0) {
    const packTag = rule?.pack && rule.pack.id ? `（题材包「${rule.pack.name || rule.pack.id}」[${rule.pack.id}]）` : "";
    return `禁词表为空${packTag}（既未登记 bannedWords，且该文化基准无默认表），本路无词可扫`;
  }
  const muted = Number(rule.sources && rule.sources.muted) || 0;
  const allowed = Array.isArray(rule.allowedWords) ? rule.allowedWords : [];
  const muteNote = muted > 0
    ? `；已按本书用词豁免静音 ${muted} 个词（${allowed.slice(0, 8).join("、")}${allowed.length > 8 ? " 等" : ""}）`
    : "";
  return `已扫 ${rule.bannedWords.length} 个禁词（文化基准「${rule.cultureName}」，来源 ${cultureSourceLabel(rule.cultureSource)}${packNote}）${muteNote}`;
}

function buildAuditChecklist(settings, styleRule, chapters) {
  const characters = Array.isArray(settings.characters) ? settings.characters : [];
  const validCharacters = characters.filter((c) => c && typeof c === "object" && typeof c.name === "string" && c.name !== "");
  const hasAlias = validCharacters.some((c) => Array.isArray(c.alias) && c.alias.length > 0);
  const bannedCount = styleRule.bannedWords.length;
  const speech = styleRule.speechStyle;
  return [
    {
      item: "用语冲突（世界观禁词）",
      state: bannedCount > 0 ? "checked" : "skipped",
      note: bannedWordsCheckNote(styleRule)
    },
    {
      item: "语用规范（客套/仪式/称谓）",
      state: speech ? "checked" : "skipped",
      note: speech
        ? `已扫「${styleRule.speechCultureName}」的 honorBad / ritualBadPatterns / 称谓规范`
        : "未登记 speechStyle，客套/仪式/称谓三路全部跳过——novel_settings add category=worldview 补 speechStyle"
    },
    {
      item: "人物缺失 / 人物缺场",
      state: validCharacters.length > 0 ? "checked" : "skipped",
      note: validCharacters.length > 0 ? `已对照 ${validCharacters.length} 个登记人物` : "设定表未登记人物，跳过"
    },
    {
      item: "别名未用",
      state: hasAlias ? "checked" : "skipped",
      note: hasAlias ? "已对照登记别名" : "没有任何人物登记 alias，跳过"
    },
    { item: "设定表重复条目", state: "checked", note: "characters / locations / items 三表" },
    { item: "同章号多文件", state: "checked", note: `已扫 ${chapters.length} 个章节文件` },
    { item: "数字口径（亿/千万/百万）", state: "checked", note: "仅对「同值不同写法」成对报出，上限 20 条" },
    { item: "大纲对照", state: "off", note: "本次未启用——需单独调 outline=true（chapter/outline/ooc 三模式互斥）" },
    { item: "OOC 情绪哨兵", state: "off", note: "本次未启用——需单独调 ooc=true（三模式互斥）" },
    { item: "与上一章衔接", state: "off", note: "本次未启用——需单独调 chapter=<章号>（三模式互斥）" },
    { item: "必用词覆盖率 / 通用词顶替", state: "off", note: "不在本工具职责内——用 novel_lexicon action=audit（该审计只覆盖必用词表，不含世界观禁词）" }
  ];
}

function registerNovelContinuityCheck(ctx, config) {
  ctx.tools.register({
    name: "novel_continuity_check",
    description: "连贯性审计：全书矛盾与用语冲突；chapter查衔接及禁词/语用(styleCandidates)；outline大纲；ooc哨兵(互斥)。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名" },
        // v3.2.0：衔接模式——检查该章 vs 上一章（时间跳变/语义距离/人物延续/钩子承接）
        chapter: { type: "string", description: "衔接章(兼查禁词与speechStyle)" },
        outline: { type: "boolean", description: "大纲对照" },
        ooc: { type: "boolean", description: "OOC哨兵" },
        root: { type: "string", description: "书库根" }
      },
      required: ["book"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string" },
          // v3.2.0：衔接/OOC/大纲对照模式返回值
          action: { type: "string" },
          chapter: { type: "string" },
          candidates: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string" },
                detail: { type: "string" },
                chapters: { type: "array", items: { type: "string" } },
                // v6.5.0：用语/语用扫描的候选新增三个字段。
                // 衔接 / OOC / 大纲对照三路**不带**这三者，故不放进 required（默认值兜底由消费方负责）。
                // 补 schema 是必须的：items 上是 additionalProperties:false，多返回字段会被严格校验的宿主整条拒收。
                tier: { type: "string", enum: ["hard", "review", "info"] },
                word: { type: "string" },
                locations: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      chapter: { type: "string" },
                      ranges: {
                        type: "array",
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: { from: { type: "integer" }, to: { type: "integer" } },
                          required: ["from", "to"]
                        }
                      }
                    },
                    required: ["chapter", "ranges"]
                  }
                }
              },
              required: ["type", "detail"]
            }
          },
          // v6.4.0（P1-1）：章节模式（chapter=…）并行返回的**本章用语/语用命中**。
          // 为什么单列而不是混进 candidates：candidates 装的是「与上一章的衔接风险」，
          // 两者判定依据与修法都不同；混在一个列表里会让「衔接 0 条」掩盖「禁词命中 3 条」（职责边界）。
          styleCandidates: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string" },
                detail: { type: "string" },
                chapters: { type: "array", items: { type: "string" } },
                // v6.5.0：用语/语用扫描的候选新增三个字段。
                // 衔接 / OOC / 大纲对照三路**不带**这三者，故不放进 required（默认值兜底由消费方负责）。
                // 补 schema 是必须的：items 上是 additionalProperties:false，多返回字段会被严格校验的宿主整条拒收。
                tier: { type: "string", enum: ["hard", "review", "info"] },
                word: { type: "string" },
                locations: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      chapter: { type: "string" },
                      ranges: {
                        type: "array",
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: { from: { type: "integer" }, to: { type: "integer" } },
                          required: ["from", "to"]
                        }
                      }
                    },
                    required: ["chapter", "ranges"]
                  }
                }
              },
              required: ["type", "detail"]
            }
          },
          // v6.4.0（P1-3）：必查项清单——本次覆盖/未覆盖的维度及原因（防「自检没报=没问题」的误安心）
          checklist: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                item: { type: "string" },
                state: { type: "string", enum: ["checked", "skipped", "off"], description: "checked=本次已扫 / skipped=本次应扫但缺登记或数据 / off=本模式不含，需另调参数" },
                note: { type: "string" }
              },
              required: ["item", "state", "note"]
            }
          },
          pack: { type: "object", additionalProperties: true },
          reportFile: { type: "string" },
          advice: { type: "string" }
        },
        required: ["book", "candidates", "advice"]
      },
      render: (_args, value) => {
        const lines = [`<path>novels/${value.book}</path>`, "<type>novel-continuity-check</type>", "<content>", ""];
        if (value.pack && value.pack.id) {
          lines.push(`生效题材包：${value.pack.name || value.pack.id}（${value.pack.id}，来源：${value.pack.source === "custom" ? "书库自定义" : "内置"}）`, "");
        }
        if (value.candidates.length === 0) {
          // v6.4.0：衔接模式下 candidates 装的是衔接风险，空时不能说成"无明显矛盾候选"（语义串味）
          lines.push(value.action === "衔接" ? "未发现明显衔接问题。" : "未发现明显矛盾候选。");
        } else {
          lines.push(`${value.action === "衔接" ? "衔接候选" : "矛盾候选"} ${value.candidates.length} 条（供人工判断）：`);
          for (const cand of value.candidates) {
            lines.push(`  - [${cand.type}] ${cand.detail}${Array.isArray(cand.chapters) && cand.chapters.length > 0 ? "（涉及：" + cand.chapters.join("、") + "）" : ""}`);
          }
        }
        // v6.4.0（P1-1）：章节模式的用语/语用命中单列一节（此前这段扫描在章节模式下根本走不到）
        if (Array.isArray(value.styleCandidates)) {
          if (value.styleCandidates.length === 0) {
            lines.push("", "【本章用语/语用】未发现禁词或语用规范命中（基准与词表来源见下方覆盖范围）。");
          } else {
            lines.push("", `【本章用语/语用】命中 ${value.styleCandidates.length} 条：`);
            for (const cand of value.styleCandidates) lines.push(`  - [${cand.type}] ${cand.detail}`);
          }
        }
        // v6.4.0（P1-3）：把「这次没查什么」摆在结论旁边
        if (Array.isArray(value.checklist) && value.checklist.length > 0) {
          const label = { checked: "已查", skipped: "跳过", off: "未启用" };
          lines.push("", "【本次审计覆盖范围】");
          for (const item of value.checklist) lines.push(`  - [${label[item.state] ?? item.state}] ${item.item}：${item.note ?? ""}`);
        }
        lines.push("", "【建议】" + value.advice, "", "</content>");
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_continuity_check");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const root = resolveRoot(config, args, exec);
      const dir = bookDir(root, book);
      const chapters = await scanChapters(dir);
      assert(chapters.length > 0, `作品 "${book}" 下没有章节文件`);
      // v3.9.5 修正：chapter/outline/ooc 三种哨兵模式互斥——旧实现多模式同传时静默只跑优先级最高者
      // v7.4.0（#26）：纯空白字符串视作未传，不计入 sentinelModes 也不进入单章衔接模式
      const bridgeChapter = args?.chapter !== void 0 && args?.chapter !== null ? String(args.chapter).trim() : "";
      const sentinelModes = [bridgeChapter !== "", args?.outline === true, args?.ooc === true].filter(Boolean).length;
      assert(sentinelModes <= 1, "novel_continuity_check 的 chapter / outline / ooc 三种模式互斥：一次只能传一种，本次已拒绝（请拆分调用）");
      // v3.2.0：单章衔接检查模式
      if (bridgeChapter !== "") {
        const target = findChapter(chapters, bridgeChapter);
        assert(target !== void 0, `在作品 "${book}" 中找不到章节 "${bridgeChapter}"（可用 novel_chapters 查看章节列表）`);
        const ti = chapters.findIndex((c) => c.file === target.file);
        // v6.4.0（P1-1）：章节模式必须**并行**给出本章的用语/语用命中。
        // 旧实现在这里只做"与上一章衔接"就 return，函数尾部的禁用词/语用扫描永远走不到——
        // 用户写完一章自检看到的"0 条候选"只是"衔接没问题"，与世界观看词毫无关系。
        // 变量名刻意用 chapterText/chapterSettings：下方同名 const（settings/chapterTexts）在本分支之后才声明，
        // 同名引用会落进 TDZ 抛 ReferenceError（本分支 return 得早，不能借它们的值）。
        const chapterText = await readTextFile(join(dir, target.file), exec);
        const chapterSettings = await readSettings(root, book);
        const chapterRule = resolveStyleRule(chapterSettings, [{ file: target.file, text: chapterText }], { root, book });
        const styleCandidates = collectStyleCandidates(chapterRule, [{ file: target.file, text: chapterText }], true);
        const styleAdvice = styleCandidates.length > 0
          ? `另发现 ${styleCandidates.length} 处用语/语用命中（世界观禁词或语用规范）——见【本章用语/语用】。`
          : "";
        const chapterChecklist = [
          { item: "与上一章衔接（时间/人物/钩子）", state: ti <= 0 ? "skipped" : "checked", note: ti <= 0 ? "第一章没有上一章可比对" : `已对照 ${chapters[ti - 1].file}` },
          // v6.5.0：note 走共享函数 bannedWordsCheckNote——此前这里是一份**内联副本**，
          // 于是全书模式那份加上「静音披露」后这里漏了（同一句话写两遍必然漂移；冒烟测试抓到）。
          { item: "本章用语冲突（世界观禁词）", state: chapterRule.bannedWords.length > 0 ? "checked" : "skipped", note: bannedWordsCheckNote(chapterRule) },
          { item: "本章语用规范（客套/仪式/称谓）", state: chapterRule.speechStyle ? "checked" : "skipped", note: chapterRule.speechStyle ? `已扫「${chapterRule.speechCultureName}」的 honorBad / ritualBadPatterns / 称谓规范` : "未登记 speechStyle，三路全部跳过" },
          { item: "全书维度（数字口径/人物缺场/设定重复/同章号）", state: "off", note: "章节模式不跑——需不带 chapter 参数调一次" },
          { item: "必用词覆盖率 / 通用词顶替", state: "off", note: "不在本工具职责内——用 novel_lexicon action=audit（只覆盖必用词表，不含世界观禁词）" }
        ];
        if (ti <= 0) {
          return {
            book,
            action: "衔接",
            chapter: target.file, // v6.4.0：第一章分支也带上章名（旧版此处不返回该字段，调用方无从知道查的是哪一章）
            candidates: [],
            styleCandidates,
            checklist: chapterChecklist,
            ...(chapterRule.pack ? { pack: chapterRule.pack } : {}),
            advice: "第一章无上一章可比对——衔接检查从第二章起可用。" + styleAdvice
          };
        }
        const prev = chapters[ti - 1];
        const bridge = await detectChapterBridge(root, book, prev.file, target.file, exec);
        return {
          book,
          action: "衔接",
          chapter: target.file,
          candidates: bridge,
          styleCandidates,
          checklist: chapterChecklist,
          ...(chapterRule.pack ? { pack: chapterRule.pack } : {}),
          advice: (bridge.length === 0
            ? "未发现明显衔接问题：时间线、人物延续与钩子承接均正常。"
            : "发现 " + bridge.length + " 处衔接风险点——按提示补过渡/承接后重查。") + styleAdvice
        };
      }
      const candidates = [];
      // v4.3.1（P0）：同章号多文件检测。findChapter 现在会在章号命中多个文件时拒绝执行（不再静默读错稿），
      // 所以在审计里先把撞号清单摆出来，否则用户只看到"读取失败"却不知道哪几章撞了。
      const dupByNumber = new Map();
      for (const c of chapters) {
        if (c.number === void 0) continue;
        const list = dupByNumber.get(c.number) ?? [];
        list.push(c.file);
        dupByNumber.set(c.number, list);
      }
      for (const [number, files] of dupByNumber) {
        if (files.length > 1) {
          candidates.push({
            type: "同章号多文件",
            detail: `第 ${number} 章有 ${files.length} 个文件共用同一章号：${files.join("、")}——按章号读取会被拒绝（需改用文件名指定）`,
            chapters: files
          });
        }
      }
      // v3.2.0：大纲 vs 实际偏离检查
      // v4.0.0 修正：移到全书读取之前——大纲模式不用 chapterTexts，旧版先无条件读完全书再进分支，
      // 且分支内又对每章整读一遍再 slice(0,600)（同一章读两遍，第一遍纯浪费）
      if (args?.outline === true) {
        const outlinePath = join(creationDir(root, book), CREATION_FILES.outline); // v4.3.0：改用常量拼路径（与 core.js 同源），避免目录改名后静默失配
        // v4.3.0：大 try 缩到只包"大纲本身"的读取——旧版把循环内"单章读失败"（被删/占用/权限）
        // 也一并吞掉，统一误报成"该书无创作资料"，按提示去 init 大纲后依旧失败
        let outlineText;
        try {
          outlineText = await readTextFile(outlinePath, exec);
        } catch (e) {
          // v6.6.0：**读不到 ≠ 没有创作资料**。旧版把 EACCES / 编码 / 取消都讲成
          // 「该书无创作资料…先 novel_outline init」✗ —— 用户照做也修不好（文件明明在）。
          // 取消必须先放行（isAbort 是全插件唯一取消判据，见 core.js 定义处注释）。
          if (isAbort(e)) throw e;
          if (e?.code === "ENOENT") {
            return { book, action: "大纲对照", candidates: [], advice: "该书无创作资料（novels/创作资料/<书>/剧情大纲.md）——先 novel_outline init + chapter 补大纲方向" };
          }
          logEvent("config", { book, file: outlinePath, level: "warn", detail: "大纲对照读取剧情大纲失败（不是「没有创作资料」）：" + String(e?.message ?? e) });
          // 用户面文案不复述那句错误结论（「无创作资料」），只说事实：文件在，但读不出来；也不要再让人去 init
          return { book, action: "大纲对照", candidates: [], advice: "剧情大纲读取失败：该文件存在，但读不出来（" + String(e?.message ?? e).slice(0, 160) + "）——不必 novel_outline init，请先检查该文件的权限/编码后重试：" + outlinePath };
        }
        // v7.3.4 修（#18）：这里曾**写死** `/^- \d+ /`，与全插件唯一口径 `OUTLINE_LINE_RE` 不一致——
        // 于是用 `* 12 …` / `- 第12章 …` / `## 12 …` / 行首带缩进写大纲的作者，连贯性审计会误报
        // 「创作资料大纲没有方向行」。同批修好的钩子承接已用统一口径，唯独漏了这一处。
        const directionLines = [];
        for (const l of String(outlineText).split(/\r?\n/)) {
          const m = OUTLINE_LINE_RE.exec(l);
          if (m === null) continue;
          const num = parseInt(m[1], 10);
          if (!Number.isInteger(num)) continue;
          directionLines.push({ num: num, direction: String(m[2] || "").trim() });
        }
        if (directionLines.length === 0) return { book, action: "大纲对照", candidates: [], advice: "创作资料大纲没有方向行——先 novel_outline chapter 补每章方向（方向行可写 \"12 内容\" / \"- 12 内容\" / \"* 12 内容\" / \"## 12 内容\"）" };
        const out = [];
        let skipped = 0;
        for (const item of directionLines) {
          const num = item.num;
          const direction = item.direction;
          if (direction.length < 4) continue;
          // v4.0.0 修正：统一用 scanChapters 的章号口径（旧版取文件名首段数字，"第1卷03章.md" 会错配）
          const ch = chapters.find(function (c) { return c.number === num; });
          if (!ch) continue;
          let text;
          try {
            text = (await readTextFile(join(dir, ch.file), exec)).slice(0, 600);
          } catch (e) {
            // v7.3.1 修（#18）：取消必须先放行（全插件唯一判据 core.isAbort）——旧版裸 catch
            // 会把中止伪装成「跳过 N 章读取失败」的成功返回。
            if (isAbort(e)) throw e;
            skipped += 1; // v4.3.0：单章读失败只跳过该章并计数，不再把整次大纲对照判成"无创作资料"
            continue;
          }
          const grams = new Set();
          for (let i = 0; i < direction.length - 1; i += 1) grams.add(direction.slice(i, i + 2));
          let hit = 0;
          for (const g of grams) if (text.includes(g)) hit += 1;
          const ratio = grams.size > 0 ? hit / grams.size : 0;
          if (ratio < 0.12) out.push({ type: "大纲·可能偏离", detail: "第 " + num + " 章方向「" + direction.slice(0, 20) + "…」与正文开头关键词重合率仅 " + Math.round(ratio * 100) + "%——该章可能偏离大纲，建议核对", chapters: [ch.file] });
        }
        const skipNote = skipped > 0 ? "（跳过 " + skipped + " 章读取失败）" : "";
        return { book, action: "大纲对照", candidates: out, advice: (out.length === 0 ? "各章与大纲方向基本一致。" : "发现 " + out.length + " 章可能与大纲方向偏离——逐条核对（偏离不一定是错，但要有意为之）。") + skipNote };
      }
      const settings = await readSettings(root, book);
      const chapterTexts = [];
      for (const chapter of chapters) {
        chapterTexts.push({ file: chapter.file, text: await readTextFile(join(dir, chapter.file), exec) });
      }
      // v3.2.0：角色 OOC 哨兵（情绪基线偏离）
      if (args?.ooc === true) {
        // v4.0.0 修正：复用上方已读的 settings（旧版 settings2 同一次调用里把同一文件读第二遍）；
        // 并过滤脏条目（null/缺 name 会让 c.name 抛 TypeError）
        const characters = (Array.isArray(settings.characters) ? settings.characters : []).filter(function (c) { return c && typeof c === "object" && typeof c.name === "string" && c.name.length >= 2; });
        if (characters.length === 0) return { book, action: "OOC", candidates: [], advice: "未登记角色（novel_settings character）——先登记角色才能检测情绪偏离" };
        const { valenceStats } = await import("../analysis.js");
        const per = {};
        for (const ch of chapterTexts) {
          for (const c of characters) {
            const name = c.name;
            const around = [];
            let pos = -1;
            while ((pos = ch.text.indexOf(name, pos + 1)) !== -1 && around.length < 5) {
              around.push(ch.text.slice(Math.max(0, pos - 120), pos + 120));
            }
            if (around.length === 0) continue;
            const vs = valenceStats(around.join(" "));
            if (vs.hitWindows > 0) (per[name] = per[name] || []).push({ file: ch.file, val: vs.meanValence ?? 0 });
          }
        }
        const out = [];
        for (const name of Object.keys(per)) {
          const list = per[name];
          if (list.length < 2) continue;
          const vals = list.map(function (x) { return x.val; });
          const mu = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
          const variance = vals.reduce(function (s, x) { return s + (x - mu) * (x - mu); }, 0) / vals.length;
          const sigma = Math.sqrt(variance) || 0.05;
          // v3.2.0：小样本（≤4 章）σ 会被离群值撑大，改用固定阈值 0.3
          const thr = list.length <= 4 ? 0.3 : 2 * sigma;
          for (const item of list) {
            if (Math.abs(item.val - mu) > thr) {
              // v4.0.0 修正：文案与阈值判定共用同一条件（旧版用 thr === 0.3 浮点相等，2σ 恰为 0.3 时贴错标签）
              out.push({ type: "OOC·情绪偏离", detail: "角色「" + name + "」在 " + item.file + " 的情绪值 " + item.val.toFixed(2) + " 偏离其全书均值 " + mu.toFixed(2) + "（阈值 " + (list.length <= 4 ? "小样本固定 0.3" : "全书 2σ") + "）——若有重大剧情触发情绪变化可忽略，否则可能 OOC", chapters: [item.file] });
            }
          }
        }
        return { book, action: "OOC", candidates: out, advice: out.length === 0 ? "登记角色情绪基线未见异常。" : "发现 " + out.length + " 处角色情绪偏离——先确认是否有剧情触发，无触发则可能 OOC。" };
      }
      // 1) 数字写法差异（亿/千万/百万 口径）
      const numberForms = new Map();
      for (const { file, text } of chapterTexts) {
        // v4.3.0：字符类与下方解析侧 formValue 对齐（补 零/两）——旧版扫描侧缺这两个字，
        // 「两万」扫不到、解析侧的 零/两 分支成死代码，于是「两万」配不上「2万」（同一数量被判成两种写法）
        for (const m of text.matchAll(/\d+\s*(?:万亿|千万|百万|十万|[万亿千百])|[零一二两三四五六七八九十]{1,2}(?:万亿|千万|百万|十万|[万亿千百])/g)) {
          const form = m[0].replace(/\s/g, "");
          // 只保留"带单位"的数量表达；过滤纯数字（五十/二十九）、连词（万一）、约数（七八）
          if (!/[万亿千百]$/.test(form)) continue;
          if (/^[十百千万亿]$/.test(form)) continue;
          if (!numberForms.has(form)) numberForms.set(form, []);
          if (!numberForms.get(form).includes(file)) numberForms.get(form).push(file);
        }
      }
      if (numberForms.size >= 2) {
        // v4.0.0 修正：先归一化到数值，只对"同值不同写法"生成候选（旧版任意两两配对 → N(N-1)/2 条垃圾候选）
        const unitValue = { 万亿: 1e12, 千万: 1e7, 百万: 1e6, 十万: 1e5, 亿: 1e8, 万: 1e4, 千: 1e3, 百: 1e2, 十: 1e1 };
        const cnDigit = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
        const cnSmall = function (s) {
          if (s === "十") return 10;
          const idx = s.indexOf("十");
          if (idx === -1) return Object.prototype.hasOwnProperty.call(cnDigit, s) ? cnDigit[s] : null;
          const tens = idx === 0 ? 1 : cnDigit[s[idx - 1]];
          const ones = idx === s.length - 1 ? 0 : cnDigit[s[idx + 1]];
          if (tens === undefined || ones === undefined) return null;
          return tens * 10 + ones;
        };
        const formValue = function (form) {
          const m = /^(\d+|[零一二两三四五六七八九十]{1,2})(万亿|千万|百万|十万|[万亿千百])$/.exec(form);
          if (!m) return null;
          const unit = unitValue[m[2]];
          if (!unit) return null;
          const base = /^\d+$/.test(m[1]) ? Number(m[1]) : cnSmall(m[1]);
          return base === null ? null : base * unit;
        };
        const byValue = new Map();
        for (const [form, chs] of numberForms.entries()) {
          const v = formValue(form);
          if (v === null) continue;
          if (!byValue.has(v)) byValue.set(v, []);
          byValue.get(v).push({ form, chs });
        }
        let emitted = 0;
        for (const group of byValue.values()) {
          if (group.length < 2 || emitted >= 20) continue;
          for (let i = 0; i < group.length && emitted < 20; i += 1) {
            for (let j = i + 1; j < group.length && emitted < 20; j += 1) {
              const capped = capCandidateChapters([...new Set(group[i].chs.concat(group[j].chs))]); // v4.3.0：统一截断
              candidates.push({ type: "数字口径", detail: "「" + group[i].form + "」与「" + group[j].form + "」指同一数量但写法不一致，请统一口径" + capped.note, chapters: capped.chapters });
              emitted += 1;
            }
          }
        }
      }
      // 2) 登记人物出现分布（缺失章节提示）
      // v4.0.0 修正：过滤脏条目（null/缺 name 时 character.name 抛 TypeError）
      for (const character of (Array.isArray(settings.characters) ? settings.characters : []).filter((c) => c && typeof c === "object" && typeof c.name === "string" && c.name !== "")) {
        const absent = chapterTexts.filter(({ file, text }) => !text.includes(character.name)).map(({ file }) => file);
        if (absent.length === chapterTexts.length) {
          // v4.0.0 修正：与"缺场"分支同口径截断（旧版把全书章节名全部塞进候选，几百章时输出/报告爆长）
          candidates.push({ type: "人物缺失", detail: `设定表人物「${character.name}」在全书章节中均未出现，请确认是否已出场`, chapters: absent.slice(0, 5) });
        } else if (absent.length > 0 && chapterTexts.length > 1) {
          candidates.push({ type: "人物缺场", detail: `设定表人物「${character.name}」未出现在 ${absent.length} 个章节中（如无出场必要可忽略）`, chapters: absent.slice(0, 5) });
        }
        if (Array.isArray(character.alias) && character.alias.length > 0) {
          const used = chapterTexts.filter(({ text }) => character.alias.some((al) => text.includes(al))).map(({ file }) => file);
          if (used.length === 0) {
            candidates.push({ type: "别名未用", detail: `人物「${character.name}」登记的别名 ${character.alias.join("、")} 在全书未出现`, chapters: [] });
          }
        }
      }
      // 3) 设定表重复条目
      for (const key of ["characters", "locations", "items"]) {
        // v4.0.0 修正：脏条目守卫（同 normalizeSettingList）
        const names = normalizeSettingList(settings[key]).map((e) => e.name);
        const dup = names.filter((n, i) => names.indexOf(n) !== i);
        if (dup.length > 0) candidates.push({ type: "设定重复", detail: `${key} 中存在重复条目：${[...new Set(dup)].join("、")}`, chapters: [] });
      }
      // v6.4.0（P0-4）：词源改由 core.resolveStyleRule **单点裁决**。
      //
      // 此处旧实现（内联 ~40 行）有两个结构性缺陷，正是「欧式设定下冒出掌柜」的代码根因：
      //   ① 默认表是**硬替换**而非合并：`entryHasBanned ? bannedEntry : DEFAULT_BANNED_WORDS`
      //      —— 用户哪怕只登记 1 个禁用词，含「掌柜/客栈/银两/衙门」的整张欧式默认表就被整份丢弃。
      //      **越精心配置，防护越弱。**
      //   ② 它与开写包各拿一套词源：开写包只读用户登记表（无默认兜底），这里却有兜底
      //      —— 两道防线错开，「该告诉模型的没告诉，能查出来的又没查」（章节模式下本段还会被跳过）。
      // 现在开写包与本处共用 resolveStyleRule，结构上不可能再分叉。
      const styleRule = resolveStyleRule(settings, chapterTexts, { root, book });
      // v6.4.0（P1-1）：四路扫描（禁词 / 客套 / 仪式 / 称谓）抽到 collectStyleCandidates，
      // 与章节模式共用同一实现——口径只有一处，两模式不可能再分叉（旧版章节模式整段走不到）。
      candidates.push(...collectStyleCandidates(styleRule, chapterTexts, false));
      const advice = candidates.length === 0
        // v6.4.0（P1-3）：空候选的旧文案「设定表与章节基本一致」正是"误安心"的源头——
        // 未登记语用规范、未登记人物等维度根本没扫，这里必须把话说到覆盖面上去。
        ? "本次扫描未发现矛盾候选。注意这不等于是全书无问题：先看下方【本次审计覆盖范围】里哪些维度是「跳过/未启用」。建议继续登记新章节出现的新人物/新地点。"
        : "以上为规则候选，请逐条人工判断：确认为矛盾则更新设定表（novel_settings update）或修正正文；非矛盾（如回忆/刻意缺席）可忽略。";
      // v6.4.0（P1-3）：必查项清单与候选一起返回（进 schema，渲染层单列一节）
      const checklist = buildAuditChecklist(settings, styleRule, chapters);
      // 落盘审计报告
      const auditDir = join(novelDataDir(root), "audits");
      const reportFile = join(auditDir, book + "-" + createHash("sha1").update(book + "|" + chapters.map((x) => x.file).join(",")).digest("hex").slice(0, 16) + ".json");
      try {
        await mkdir(auditDir, { recursive: true });
        // v6.4.0（P1-3）：清单也写进报告——报告是留存的记录，只有候选而没有覆盖面，
        // 事后翻这份 JSON 时同样会把「没查」读成「没事」。
        await atomicWriteJson(reportFile, { book, generatedAt: new Date().toISOString(), checklist, candidates });
      } catch {
        // v6.6.0：报告没落盘，但返回体照样给出 reportFile 路径（读起来像"报告已留存"）——
        // 而"没查"与"没事"的区分正是靠这份留存的报告，静默丢盘等于把这一点也丢了
        logEvent("cache", { file: reportFile, book, level: "warn", detail: "审计报告落盘失败（返回体仍给出 reportFile 路径，但磁盘上没有）" });
      }
      return { book, candidates, checklist, reportFile, ...(styleRule.pack ? { pack: styleRule.pack } : {}), advice };
    }
  });
}

export {
  registerNovelContinuityCheck,
  collectStyleCandidates,
  cultureSourceLabel,
  bannedWordsCheckNote,
  buildAuditChecklist
};
