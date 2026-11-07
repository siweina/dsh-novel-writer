/**
 * 句子分类 / 引语状态 / 否定与副词守卫 / 软化正则 的缺陷回归（审查报告 #11 #12 #14 #15 #41 #48 #50）。
 *
 * 说明：
 * - #11/#12/#50 是**可观测行为**修复，断言在修复前必红；
 * - #14/#15 的"死规则"在当前情感词表下**没有可达的行为差异**（`别人高兴` 本来就因为
 *   `prev1` 不是否定词而不会被否定、`太阳` 也不可能紧邻情感词），所以除行为锁外还加了
 *   **源码结构断言**：旧写法必须消失、新探针必须存在——这是防止"死规则又写回去"的唯一办法。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  analyzeText, classifySentence, densityOf, splitSentences
} from "../lib/analysis.js";
import { measureExplicitness } from "../lib/explicit.js";

const ANALYSIS_SRC = readFileSync(new URL("../lib/analysis.js", import.meta.url), "utf8");

function joyCount(text) {
  return analyzeText(text).emotion.scores.find((entry) => entry.emotion === "joy").count;
}

// ── #11 多句引语拆句后丢失 quoted 标记 ────────────────────────────────────────
test("#11 多句引语切开后的每一句都必须是 quoted 对话/祈使，不能掉成陈述", () => {
  const source = "“你先走吧。我留下来断后。”";
  const parts = splitSentences(source);
  assert.deepEqual(parts, ["“你先走吧。", "我留下来断后。”"], "切句文本不应被改写（行号/偏移归因依赖原文子串）");
  for (const part of parts) {
    assert.ok(source.includes(part), "切出来的句子必须是原文子串：" + part);
    const classified = classifySentence(part);
    assert.equal(classified.quoted, true, "单边引号句必须带 quoted 标记：" + part + " → " + JSON.stringify(classified));
    assert.ok(["dialogue", "imperative"].includes(classified.type), "不能判成陈述/其它：" + part + " → " + classified.type);
  }
});

test("#11 三句以上的引语中段也不掉回陈述（跨句引号状态）", () => {
  const result = analyzeText("“我告诉你。今天必须走。不然来不及了。”");
  const dialogue = result.categories.find((entry) => entry.type === "dialogue").count;
  assert.equal(dialogue, 3, "整段引语 3 句都应是对话：" + JSON.stringify(result.categories.map((c) => [c.type, c.count])));
  // 分章节奏与主路径同口径（同一段对话不能在节奏序列里变成 S）
  const withChapter = analyzeText("“我告诉你。今天必须走。不然来不及了。”", {
    chapterTexts: [{ chapter: "第01章", text: "“我告诉你。今天必须走。不然来不及了。”" }]
  });
  assert.equal(withChapter.chapterPatterns[0].sequence, "DLG×3");
});

test("#11 修复不改写句子文本：densityOf 的动作链示例仍是原文子串", () => {
  const chainText = "他推开门板，抓起桌上的长刀，跨过门槛走进雨里。"
    + "这是一句没有动作的说明文字，用来把后半段推远一点。".repeat(6)
    + "他握紧长枪，一把扯开帐帘，翻身跃上那匹枣红战马。";
  for (const ex of densityOf(chainText).actionChainExamples) {
    assert.ok(chainText.includes(ex), "示例不是原文子串（说明切句改写了文本）：" + ex);
  }
  // 含引号的正文同理：引号补全若真的改了字符串，这里会红
  const quoted = "“他推开门板，抓起桌上的长刀，跨过门槛走进雨里。”";
  for (const ex of densityOf(quoted).actionChainExamples) {
    assert.ok(quoted.includes(ex), "含引号的示例不是原文子串：" + ex);
  }
});

// ── #12 台词与心理描写判定颠倒 ───────────────────────────────────────────────
test("#12 引号前的引导语优先：说话→对话，心理→心理，引语内心理词不得翻案", () => {
  assert.equal(classifySentence("他吼道：“我觉得你在骗人！”").type, "dialogue");
  assert.equal(classifySentence("他心想：“危险就要来了。”").type, "psychology");
  assert.equal(classifySentence("他低声说：“走吧。”").type, "dialogue");
  assert.equal(classifySentence("他心里想：他会不会来？").type, "psychology", "无引号的心理句口径不变");
  assert.equal(classifySentence("他问我：“你去哪？”").type, "dialogue");
  // 外部引导语缺失时才允许引语内部心理词兜底（保留既有口径）
  assert.equal(classifySentence("“我觉得他在骗人。”").type, "psychology");
  // 台词句的 quoted 标记仍在
  assert.equal(classifySentence("他吼道：“我觉得你在骗人！”").quoted, true);
});

// ── #14 否定排除前缀方向错位（别X / X别）─────────────────────────────────────
test("#14 别X 构词不算否定，裸“别”仍是否定，X别 构词保持不算否定", () => {
  assert.equal(joyCount("别人高兴。"), 1, "“别人高兴”里的“别”不是否定词");
  assert.equal(joyCount("别高兴。"), 0, "“别高兴”里的“别”是否定词");
  assert.equal(joyCount("特别高兴。"), 1.5, "“特别高兴”里的“别”是构词语素（旧规则仍须生效）");
});

test("#14 死规则方向已修正（prev1/prev2 的语义方向）", () => {
  assert.match(ANALYSIS_SRC, /prev2 === "别" && prev1 && BIE_NON_NEGATION_FOLLOWERS\.has\(prev1\)/,
    "别X 判定应检查 prev2==='别' && SET.has(prev1)（别人高兴：prev1=人、prev2=别）");
  assert.ok(!/BIE_NON_NEGATION_PREFIX/.test(ANALYSIS_SRC), "混装两类词序的旧集合应已拆分为 FOLLOWERS / LEADERS");
  assert.match(ANALYSIS_SRC, /BIE_NON_NEGATION_LEADERS\.has\(prev2\)/, "X别 判定（特别高兴：prev1=别、prev2=特）必须保留");
});

// ── #15 副词否定守卫取前缀词 ─────────────────────────────────────────────────
test("#15 单字副词同形词守卫：太阳/老太太 的“太”不算程度副词，真副词仍加权", () => {
  // 真实可达反例：DUTIR 兜底词「阳光」紧跟在「太阳」的「太」后面。
  // 旧版对 太 取 text.slice(idx-2, idx)（idx 是「阳光」起点 → 只剩“太”，长度 1），
  // 永远匹配不到以副词开头的「太阳」→ 误把 joy 加权成 1.5；修复后为 1。
  assert.equal(joyCount("太阳光刺眼。"), 1, "太阳光：太阳 里的“太”不是程度副词");
  assert.equal(joyCount("老太太高兴。"), 1, "老太太高兴：太太 里的“太”不是程度副词");
  assert.equal(joyCount("太太高兴。"), 1);
  assert.equal(joyCount("她太高兴了。"), 1.5, "真·程度副词“太”必须加权");
});

test("#15 守卫探针已改为双向（后向 + 从副词向后看）", () => {
  assert.match(ANALYSIS_SRC, /const fromAdverb = text\.slice\(Math\.max\(0, adverbIdx\), adverbIdx \+ 2\);/,
    "必须以副词为起点向后看 2 字（太阳/太子/挺拔 这类以副词开头的同形词）");
  assert.ok(!/SINGLE_ADVERB_FALSE_POSITIVES\.has\(text\.slice/.test(ANALYSIS_SRC),
    "旧版只截 [X][副词]（要求“人别…”式反序），10 条以副词开头的排除词永远匹配不到");
});

// ── #41 软化正则把缩进空行当省略号 ───────────────────────────────────────────
test("#41 纯空白行不再算“整段省略号”，真省略号符号仍命中", () => {
  assert.equal(measureExplicitness("第一段正文。\n  \n第二段正文。").softening.total, 0,
    "两个空格的空行不是省略号");
  assert.equal(measureExplicitness("第一段正文。\n\t\t\n第二段正文。").softening.total, 0);
  assert.equal(measureExplicitness("第一段正文。\r\n  \r\n第二段正文。").softening.total, 0, "CRLF 空行同理");
  assert.equal(measureExplicitness("……").softening.total, 1);
  assert.equal(measureExplicitness("...").softening.total, 1);
  assert.equal(measureExplicitness("。 。 。").softening.total, 1);
});

// ── #48 exchanges 在单句成段排版下恒 0 ──────────────────────────────────────
test("#48 单句成段的对白也计回合，且不与段内计数重复", () => {
  const fourLines = analyzeText("“一。”\n“二。”\n“三。”\n“四。”").paragraphs.exchanges;
  assert.ok(fourLines >= 2, "4 行单句成段对白应至少 2 个回合（旧值 0），实际：" + fourLines);
  assert.equal(fourLines, 3);
  // 同一段内写 4 句：保持原来的 3，不得因跨段逻辑重复计数
  assert.equal(analyzeText("“一。”“二。”“三。”“四。”").paragraphs.exchanges, 3);
  // 两段各 2 句：段内 2 + 段边界 1 = 3，与“4 句同段”同口径
  assert.equal(analyzeText("“一。”“二。”\n“三。”“四。”").paragraphs.exchanges, 3);
});

// ── #50 省略号分类只认 Unicode … ────────────────────────────────────────────
test("#50 省略留白同时认 … / ... / 。。。 / ——", () => {
  for (const text of ["他走了……", "他走了...", "他走了。。。", "他走了——"]) {
    assert.equal(classifySentence(text).type, "ellipsis", "应判省略留白：" + text);
  }
  assert.equal(classifySentence("他走了。").type, "statement", "单个句号不是省略号");
  assert.equal(classifySentence("他走了。。").type, "statement", "两个句号仍不够（至少 3 个）");
});
