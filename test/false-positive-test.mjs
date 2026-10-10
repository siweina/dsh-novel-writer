/**
 * test/false-positive-test.mjs —— 用语审计「子串误报」回归门禁（v6.5.0）
 *
 * ## 为什么必须有这一套
 *
 * 本次误报是**结构性**的，不是某个词表填错了：
 *   · 判定是 `text.includes(word)`（lib/index.js 的 collectStyleCandidates），中文没有词边界；
 *   · 禁用词表里 **93% 是 2 字词**（DEFAULT_BANNED_WORDS 69 条中 64 条，脚本可复核）。
 * 两者相乘 → 一个 2 字词与「恰好相邻的两个字」被当成了同一件事。实测 19 句无辜句子
 * 报出 15 条、其中 14 条是误报：「这[里正]是」「[在下]面」「大[大人]物」。
 *
 * 修法有四层，本文件**逐层设门禁**，任何一层退回去都会让这里变红：
 *   ① 邻接守卫：lib/lexicons/guards.js + core.isGuardedArtifact（只收有实证的碰撞字）
 *   ② 档位 tier：3+ 字词 → hard；2 字词 → review（**显式允许模型判"不是问题"**）
 *   ③ 逐句正则扫描 + core.validatePattern 静态拒绝（ReDoS / 跨句误报）
 *   ④ 逐词静音 allowWords（本书豁免，不削弱别的书）
 *
 * ## 断言的鉴别力（本文件的自证纪律）
 *
 * 两道门禁刻意分开写，为的是让「哪一层退化了」一眼可辨：
 *   · **零硬命中**（①-a）是**结构性**门禁：它只依赖词长，不依赖守卫表填得全不全。
 *     所以清空某一条守卫**不会**让它变红——这是有意的设计，不是漏检：
 *     少填守卫的最坏后果是多报一条 review，交给模型判断。
 *   · **无辜句零候选**（①-b）才是**守卫回归探测器**：守卫表少一条它就红。
 *
 * 两处自证（改坏 → 必须变红 → 立刻还原 → 校验哈希）已人工跑过，结论写进交付报告：
 *   · 清空 guards.js 的「里正」守卫 → ①-a 仍绿（2 字词走 review）、①-b 变红、② 仍绿；
 *   · 注释掉 resolveStyleRule 的静音过滤 → ⑦ 变红。
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatLineRanges,
  isGuardedArtifact,
  linesContaining,
  mergeLineRanges,
  resolveStyleRule,
  splitSentences,
  validatePattern
} from "../lib/core.js";
import { apply } from "../lib/index.js";
import { DEFAULT_BANNED_WORDS, SPEECH_STYLE_RULES } from "../lib/lexicons/markers.js";

// ---------------------------------------------------------------------------
// 夹具与真实审计（走 apply() 注册的**真工具**，不直连内部函数——
// 直连内部函数只能证明"函数自洽"，证明不了"用户看到的那条候选"）
// ---------------------------------------------------------------------------

const ROOT = join(tmpdir(), "dsh-novel-writer-fp-" + process.pid + "-" + Date.now().toString(36));
process.env.DSH_NOVEL_WRITER_STATE = join(ROOT, "state-test.json");
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "novels"), { recursive: true });
process.on("exit", () => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
});

const registry = [];
apply({
  tools: { register: (def) => { registry.push(def); return () => {}; } },
  systemPrompt: { section: () => () => {} },
  inject: (names, cb) => cb({ webServer: { register: () => () => {} }, effect: (fn) => fn() })
}, { root: ROOT, sentenceAnalysis: { enabled: false }, allowLanState: false });
const defs = Object.fromEntries(registry.map((def) => [def.name, def]));
const exec = { agent: { session: { header: { cwd: ROOT } } } };

function writeChapter(book, file, lines) {
  const dir = join(ROOT, "novels", book);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), lines.join("\n") + "\n", "utf8");
}
function addWorldview(book, args) {
  return defs.novel_settings.execute({ book, category: "worldview", action: "add", name: book + "·基准", ...args }, exec);
}
function audit(book, args) {
  return defs.novel_continuity_check.execute({ book, ...(args || {}) }, exec);
}
/** 真实审计产出的「用语/语用」候选：全书模式在 candidates，章节模式另放 styleCandidates。 */
function styleCandidates(out) {
  return [...(out?.styleCandidates || []), ...(out?.candidates || [])].filter((c) => c && c.tier !== undefined);
}
const wordsOf = (out) => styleCandidates(out).map((c) => c.word).filter((w) => w !== undefined);
const byWord = (out) => new Map(styleCandidates(out).filter((c) => c.word !== undefined).map((c) => [c.word, c]));

// ── ① 无辜句子集：每句都把某个禁词当**子串**含进去 ──────────────────────────
// `reverse: true` = 反向样本：该词其实**不构成子串**（实测「秀才 ← 优秀人才」
// 「和尚 ← 和平尚且」这两条推断并不成立），保留它们是为了记录"哪些看着像但不是"，
// 也顺带证明本测试不靠"看起来像"下判断。
const INNOCENT = [
  { word: "里正", text: "这里正是莫雷尔在手绘草图上标出的位置。" },
  { word: "秀才", text: "他是王国里少有的优秀人才。", reverse: true },
  { word: "保长", text: "必须确保长期供应不断。" },
  { word: "有劳", text: "所有劳动都应当得到报偿。" },
  { word: "门房", text: "这是一间专门房间，用来存放旧档案。" },
  { word: "老夫", text: "他们是一对老夫老妻了。" },
  { word: "伙计", text: "他递上了合伙计划书。" },
  { word: "油条", text: "议会通过了新的石油条例。" },
  { word: "道士", text: "他知道士兵们已经疲惫。" },
  { word: "和尚", text: "和平尚且难以维持，何况战争。", reverse: true },
  { word: "小二", text: "把图纸缩小二倍。" },
  { word: "江湖", text: "这批丝绸来自浙江湖州。" },
  { word: "官人", text: "即使是文官人才也必须宣誓。" },
  { word: "见教", text: "他看见教头将信收好。" },
  { word: "大人", text: "他不是什么大人物。" },
  { word: "在下", text: "雨还在下着，他在下面的地窖里点了灯。" },
  { word: "里正", text: "他平日里正人君子的模样，此刻全不见了。" }
];

// ── ② 真的中式用语渗透（反向门禁：守卫不得把真命中吃掉）─────────────────────
// 行号刻意固定（标题占第 1 行、空行占第 2 行），④ 与 ② 都据此断言"文件内真实行号"。
const REAL_LINES = [
  "# 第一章 市井",
  "",
  "掌柜把账本推过来，铜板上还留着指印。",
  "他当了里正三年，村里人都认得他。",
  "在下愿闻其详。",
  "他踩过青石板，走向城门。"
];
const REAL_AT = { "掌柜": 3, "铜板": 3, "里正": 4, "在下": 5, "青石板": 6 };

// ── ④ 行号夹具：同一个词落在第 2、3、5 行（第 4 行是空行，必须断开区间）──
const LINE_LINES = ["# 位置之章", "掌柜推开门。", "掌柜点头。", "", "掌柜走远了。"];

// ── ⑤ 中式基准（登记 basis 含「中式」）────────────────────────────────────
const EASTERN_TEXT = ["# 第一章", "", "先生您好。神甫在教堂里主持弥撒，修士在一旁低头。"];
// ⑦ 单独一本书，避免"改设置"污染 ⑤ 的断言
const EXEMPT_TEXT = ["# 第一章", "", "修士在教堂里抄写经文。"];

// ── ⑥ 正则夹具 ────────────────────────────────────────────────────────────
// 危险模式书：整行给足跨句距离（`上。` … `香。`），模式若整章扫必然误报
const DANGER_TEXT = ["# 第一章", "", "上。他走了很远很远的一段路才回来。香。"];
// 逐句书：第 3 行跨句（不该命中）、第 4 行同句（必须命中）——同一模式的对照组
const SENTENCE_TEXT = ["# 第一章", "", "上。他走了很远很远的一段路才回来。香。", "上" + "字".repeat(10) + "香。"];

writeChapter("无辜句之书", "第01章.md", ["# 第一章 无辜", "", ...INNOCENT.map((s) => s.text)]);
writeChapter("真命中书", "第01章.md", REAL_LINES);
writeChapter("行号书", "第01章.md", LINE_LINES);
writeChapter("中式书", "第01章.md", EASTERN_TEXT);
writeChapter("豁免书", "第01章.md", EXEMPT_TEXT);
writeChapter("危险模式书", "第01章.md", DANGER_TEXT);
writeChapter("逐句书", "第01章.md", SENTENCE_TEXT);

await addWorldview("无辜句之书", { basis: "西方/欧式中世纪" });
await addWorldview("真命中书", { basis: "西方/欧式中世纪" });
await addWorldview("行号书", { basis: "西方/欧式中世纪" });
await addWorldview("中式书", { basis: "东方/中式古代" });
await addWorldview("豁免书", { basis: "东方/中式古代" });
await addWorldview("危险模式书", { basis: "西方/欧式中世纪", speechStyle: { ritualBadPatterns: ["上.*香"] } });
await addWorldview("逐句书", { basis: "西方/欧式中世纪", speechStyle: { ritualBadPatterns: ["上.{0,200}香"] } });

const innocentAudit = await audit("无辜句之书");
const realAudit = await audit("真命中书", { chapter: "第01章" });
const realAllAudit = await audit("真命中书");
const lineAudit = await audit("行号书");
const easternAudit = await audit("中式书");
const dangerAudit = await audit("危险模式书");
const sentenceAudit = await audit("逐句书");

const EXEMPT_SETTINGS_FILE = join(ROOT, ".novel-writer", "settings", "豁免书.json");

// ---------------------------------------------------------------------------
// 夹具自检：句子集**确实**把禁词当子串含进去了（否则下面全是假绿）
// ---------------------------------------------------------------------------

test("夹具自检：无辜句真的含子串、词表方向正确、反向样本确不成立", () => {
  const westernWords = new Set([...DEFAULT_BANNED_WORDS.bannedWords, ...SPEECH_STYLE_RULES.western.honorBad]);
  // 前置：词表规模没被裁剪（93% 是 2 字词这一结构性前提仍在）
  assert.ok(DEFAULT_BANNED_WORDS.bannedWords.length >= 60, `默认表只剩 ${DEFAULT_BANNED_WORDS.bannedWords.length} 词，门禁失去意义`);
  const twoChar = DEFAULT_BANNED_WORDS.bannedWords.filter((w) => w.length === 2).length;
  assert.ok(twoChar / DEFAULT_BANNED_WORDS.bannedWords.length > 0.5,
    `2 字词占比 ${twoChar}/${DEFAULT_BANNED_WORDS.bannedWords.length}——本次误报的结构性前提是"2 字词占绝大多数"`);

  for (const { word, text, reverse } of INNOCENT) {
    assert.ok(westernWords.has(word), `「${word}」不在欧式基准的词表里，这句样本没有鉴别力`);
    if (reverse) {
      assert.equal(text.includes(word), false, `反向样本「${word}」其实构成了子串，标注需要更新`);
    } else {
      assert.equal(text.includes(word), true, `样本句不含「${word}」子串，该句是摆设`);
    }
  }
  // 真命中夹具必须**含**这些词（否则 ② 无从谈起）
  assert.deepEqual(Object.keys(REAL_AT).filter((w) => !westernWords.has(w)), [], "真命中夹具里的词必须都在欧式词表内");
});

// ---------------------------------------------------------------------------
// ① 无辜句子集：零硬命中（最重要的门禁）
// ---------------------------------------------------------------------------

test("①-a 无辜句子集：**零硬命中**（结构性门禁，只依赖词长）", () => {
  const hard = styleCandidates(innocentAudit).filter((c) => c.tier === "hard");
  assert.deepEqual(hard.map((c) => c.type + ":" + c.word), [],
    "无辜句子集出现了 hard 档候选——3+ 字词出现真命中、或档位判定退回成一律硬报");
});

test("①-b 无辜句子集：全部命中被邻接守卫吃掉（守卫回归探测器）", () => {
  const style = styleCandidates(innocentAudit);
  const leaked = INNOCENT.map((s) => s.word).filter((w) => wordsOf(innocentAudit).includes(w));
  // 审计确实装配好了：不是"没查到"，而是"查了 69 个词、一个都没留下"
  const checklist = (innocentAudit.checklist || []).find((item) => /用语冲突/.test(String(item?.item)));
  const scanned = Number(String(checklist?.note || "").match(/已扫 (\d+) 个禁词/)?.[1] ?? 0);
  assert.ok(scanned >= 60, `审计并未真正扫禁词（checklist 显示 ${scanned} 个），此时"零候选"是假绿`);

  assert.deepEqual(leaked, [], "无辜句子里的这些词产生了候选——对应的邻接守卫缺失或失效（本条就是守卫回归探测器）");
  assert.deepEqual(style.map((c) => c.word), [],
    "无辜句子集应当一条候选都不产生（守卫生效时连 review 都不该有）");
});

// ---------------------------------------------------------------------------
// ② 真命中必须仍然报出（反向门禁：防"守卫改过头"）
// ---------------------------------------------------------------------------

test("② 真的中式用语渗透必须被报出，且行号落在真用法那一行", () => {
  const words = new Set(wordsOf(realAudit));
  for (const word of ["里正", "在下", "掌柜", "铜板"]) {
    assert.ok(words.has(word), `真用法「${word}」被守卫吃掉了（静默漏报比误报更危险）`);
  }
  const map = byWord(realAudit);
  for (const [word, line] of Object.entries(REAL_AT)) {
    const c = map.get(word);
    assert.ok(c, `真命中「${word}」未报出`);
    assert.deepEqual(c.locations[0].ranges, [{ from: line, to: line }],
      `「${word}」的行号应是文件内的真实行号第 ${line} 行（本章模式只含本章）`);
    assert.equal(c.locations[0].chapter, "第01章.md");
  }
  // 全书模式与本章模式同源：同一批词一个不少
  const all = new Set(wordsOf(realAllAudit));
  assert.deepEqual([...words].filter((w) => !all.has(w)), [], "本章模式报出的词，全书模式必须同样报出（两模式不得分叉）");
});

// ---------------------------------------------------------------------------
// ③ 档位正确性：2 字 → review（显式允许判无问题）；3+ 字 → hard
// ---------------------------------------------------------------------------

test("③ 档位由词长决定；review 档必须显式允许模型判「不要改」", () => {
  const map = byWord(realAudit);
  for (const word of ["里正", "在下", "掌柜", "铜板"]) {
    assert.equal(map.get(word).tier, "review", `2 字词「${word}」应走 review 档`);
    assert.match(map.get(word).detail, /不要改/, `review 档「${word}」的 detail 必须显式允许判无问题，否则会退化成一律照改`);
  }
  assert.equal(map.get("青石板").tier, "hard", "3 字词「青石板」必须硬命中");
  assert.doesNotMatch(map.get("青石板").detail, /不要改/, "hard 档不该出现「不要改」的退路");

  // 通用不变式：用语冲突 / 客套两路的档位恒等于词长判定
  for (const [label, out] of [["真命中书", realAudit], ["中式书", easternAudit], ["行号书", lineAudit]]) {
    for (const c of styleCandidates(out)) {
      if (!["用语冲突", "语用冲突·客套"].includes(c.type)) continue;
      assert.equal(c.tier, String(c.word).length >= 3 ? "hard" : "review", `${label} ${c.type}「${c.word}」档位错误`);
    }
  }
  // e2e 契约：档位只走 tier 字段，**不许**塞进 type 字符串（会破坏 e2e 的 type 断言）
  for (const c of [...styleCandidates(realAudit), ...styleCandidates(easternAudit)]) {
    assert.doesNotMatch(String(c.type), /hard|review|info/, `type 里混进了档位：${c.type}`);
    assert.ok(["hard", "review", "info"].includes(c.tier), `未知档位 ${c.tier}`);
  }
});

// ---------------------------------------------------------------------------
// ④ 行号与区间
// ---------------------------------------------------------------------------

test("④ 行号是该文件内的真实行号，相邻行合并成区间", () => {
  const c = byWord(lineAudit).get("掌柜");
  assert.ok(c, "行号夹具未报出「掌柜」");
  assert.equal(c.locations.length, 1, "单章书应只有一个章节定位");
  assert.equal(c.locations[0].chapter, "第01章.md");
  // 第 2、3 行相邻 → 合并；第 4 行是空行 → 断开
  assert.deepEqual(c.locations[0].ranges, [{ from: 2, to: 3 }, { from: 5, to: 5 }]);
  assert.equal(c.locations[0].ranges[0].from, 2, "from 必须是该文件内的真实行号（不是拼接文本的偏移）");
  assert.match(c.detail, /第2-3行，第5行/);

  // 全部候选的区间都是合法且有序不重叠的
  for (const out of [innocentAudit, realAudit, lineAudit, easternAudit, dangerAudit, sentenceAudit]) {
    for (const cand of styleCandidates(out)) {
      for (const r of cand.locations || []) {
        let prevTo = 0; // 行号按**章节**各自计数，故每个 location 重新起算
        for (const range of r.ranges || []) {
          assert.ok(Number.isInteger(range.from) && Number.isInteger(range.to), `区间不是整数：${JSON.stringify(range)}`);
          assert.ok(range.from <= range.to, `from > to：${JSON.stringify(range)}`);
          assert.ok(range.from > prevTo, `区间未合并或未排序：${JSON.stringify(r.ranges)}`);
          prevTo = range.to;
        }
      }
    }
  }
});

test("④-b linesContaining / mergeLineRanges / formatLineRanges 直接单测（含边界）", () => {
  assert.deepEqual(linesContaining(["a掌柜b", "x", "掌柜"], "掌柜"), [1, 3]);
  assert.deepEqual(linesContaining(["掌柜", "掌柜"], "掌柜"), [1, 2]);
  assert.deepEqual(linesContaining([], "掌柜"), []);
  assert.deepEqual(linesContaining(["没有任何命中"], "掌柜"), []);
  assert.deepEqual(linesContaining(["abc"], ""), [], "空 needle 不得匹配（否则每行都算命中）");
  assert.deepEqual(linesContaining(null, "掌柜"), []);

  assert.deepEqual(mergeLineRanges([5, 2, 3, 3]), [{ from: 2, to: 3 }, { from: 5, to: 5 }], "乱序 + 重复要归一");
  assert.deepEqual(mergeLineRanges([2, 3, 5], 1), [{ from: 2, to: 5 }], "gap=1 时第 4 行也并进来");
  assert.deepEqual(mergeLineRanges([]), []);
  assert.deepEqual(mergeLineRanges(undefined), []);
  assert.deepEqual(mergeLineRanges([3, "x", null, -1, 0, 2.5]), [{ from: 3, to: 3 }], "非正整数一律丢弃");
  assert.deepEqual(mergeLineRanges([1]), [{ from: 1, to: 1 }]);

  assert.equal(formatLineRanges([{ from: 2, to: 10 }, { from: 52, to: 52 }]), "第2-10行，第52行");
  assert.equal(formatLineRanges([{ from: 7, to: 7 }]), "第7行");
  assert.equal(formatLineRanges([]), "");
  assert.equal(formatLineRanges(undefined), "");
  const many = Array.from({ length: 9 }, (_, i) => ({ from: i + 1, to: i + 1 }));
  assert.ok(formatLineRanges(many).startsWith("第1行"));
  assert.match(formatLineRanges(many), /等 9 段$/, "超过 max 段要截断并注明总段数");
});

// ---------------------------------------------------------------------------
// ⑤ 去重：同一批词不得同时出现在「用语冲突」与「语用冲突·客套」两类里
// ---------------------------------------------------------------------------

test("⑤ 中式基准下，禁词与客套禁词不去重就会每个词报两遍", () => {
  const style = styleCandidates(easternAudit);
  const conflict = new Set(style.filter((c) => c.type === "用语冲突").map((c) => c.word));
  const honor = new Set(style.filter((c) => c.type === "语用冲突·客套").map((c) => c.word));
  assert.ok(conflict.size > 0, "中式基准下应当报出禁西式词（否则本条的'无交集'是假绿）");
  assert.deepEqual([...conflict].filter((w) => honor.has(w)), [], "同一个词被两类同时报出（去重失效）");

  // 去重必须**说明去向**，而不是静默吞掉一条
  const merged = style.find((c) => c.type === "用语冲突" && /同属语用规范·客套/.test(String(c.detail)));
  assert.ok(merged, "被合并的禁词必须在 detail 里注明'同属语用规范·客套'");
  // 同一类型内也不得有重复词
  for (const type of ["用语冲突", "语用冲突·客套"]) {
    const words = style.filter((c) => c.type === type).map((c) => c.word);
    assert.equal(new Set(words).size, words.length, `${type} 内出现重复词：${words.join("、")}`);
  }
});

// ---------------------------------------------------------------------------
// ⑥ 正则安全：静态校验
// ---------------------------------------------------------------------------

test("⑥ validatePattern：嵌套量词/无界通配/跨句必须拒绝，有界写法必须放过", () => {
  const reject = (p) => {
    const v = validatePattern(p);
    assert.equal(v.level, "reject", `${p} 应判 reject，实际 ${v.level}（${v.reason}）`);
    assert.equal(v.ok, false);
    return v;
  };
  // 实测：(上+)+香 在 29 字符上 18.4 秒、(上*)*香 40.8 秒——必须在登记的入口就挡住
  reject("(上*)*香");
  reject("(上+)+香");
  reject("(上+)*香");
  const wild = reject("上.*香");
  assert.ok(wild.suggestion.includes("[^。！？\\n]{0,20}"), `建议里要给出可执行的改写示例，实际：${wild.suggestion}`);
  const wild2 = reject("上[\\s\\S]*香");
  assert.ok(wild2.suggestion.includes("[^。！？\\n]{0,20}"));
  reject("a".repeat(201));            // 超长
  reject("(");                        // 语法错误
  reject("");                         // 空
  reject(undefined);

  for (const p of ["上{0,20}香", "上[一二三四五六七八九十]*[柱炷]?香", "上.{0,200}香"]) {
    const v = validatePattern(p);
    assert.equal(v.level, "ok", `${p} 是有界写法，应放行，实际 ${v.level}（${v.reason}）`);
    assert.equal(v.ok, true);
  }
  const warn = validatePattern("^香$");
  assert.equal(warn.level, "warn", "整串锚定在正文扫描里通常匹配不到，应给 warn 而不是 reject");
  assert.equal(warn.ok, false, "warn 也算未通过（消费方据此附警告）");
  assert.ok(/锚定/.test(warn.reason));
});

test("⑥-a 端到端：危险模式被拒绝执行，且显式报出「未生效」而不是静默跳过", () => {
  const style = styleCandidates(dangerAudit);
  // v6.5.0 修正：被拒绝的模式**沿用既有 type**（`语用冲突·仪式`），状态只由 tier 表达。
  // 独立验证代理指出：把档位/状态塞进 type 字符串会破坏既有 type 契约（type=类别，tier=处置档位）。
  const rejected = style.find((c) => c.tier === "info" && /未生效/.test(String(c.detail)));
  assert.ok(rejected, "登记了 /上.*香/ 必须产出一条'未生效'候选；实际：" +
    JSON.stringify(style.map((c) => c.type + "/" + c.tier)));
  assert.equal(rejected.type, "语用冲突·仪式", "type 必须保持既有取值（档位只走 tier，两者正交）");
  assert.equal(rejected.tier, "info");
  assert.equal(rejected.word, "上.*香");
  assert.match(rejected.detail, /未生效/, "必须说清这条模式不提供任何保护作用，否则用户以为有防护");
  assert.deepEqual(rejected.locations, [], "被拒绝的模式没有扫描结果");
  // 它确实**没有执行**：跨句文本不得产生任何「命中了内容」的仪式候选
  //（被拒绝的那条也是 type=语用冲突·仪式，故按"有无 locations"区分，而不是按 type）
  assert.deepEqual(style.filter((c) => c.type === "语用冲突·仪式" && (c.locations || []).length > 0).map((c) => c.word), [],
    "被拒绝的模式仍在运行（跨句误报会就此发生）");
});

test("⑥-b 逐句扫描：同一模式跨句不命中、同句命中（跨句在结构上不可能）", () => {
  const style = styleCandidates(sentenceAudit);
  assert.equal(style.length, 1, "只该有第 4 行那一条命中；实际：" + JSON.stringify(style.map((c) => c.word)));
  assert.equal(style[0].type, "语用冲突·仪式");
  assert.deepEqual(style[0].locations[0].ranges, [{ from: 4, to: 4 }],
    "第 3 行是「上。……香。」（跨句，不得命中），第 4 行是同句（必须命中）");
  // 结构上的理由：正则的扫描单位是**句**，不是整章
  assert.deepEqual(splitSentences("上。他走了很远很远的一段路才回来。香。"), ["上。", "他走了很远很远的一段路才回来。", "香。"]);
  assert.deepEqual(splitSentences(""), []);
  assert.deepEqual(splitSentences(undefined), []);
  // v6.5.0：hardLimit 由 1000 收到 400，且**硬切必须带重叠**——独立验证代理实测，
  // 不带重叠时「相距 6 字但跨过切点」的命中整条丢失（对照组正常命中）。故这里断言重叠行为本身。
  const hard = splitSentences("字".repeat(2500), 1000, 32);
  // step = hardLimit - overlap = 968 → 窗口为 [0,1000)、[968,1968)、[1936,2500)
  assert.deepEqual(hard.map((s) => s.length), [1000, 1000, 564],
    "无标点的超长段落必须按 hardLimit 硬切（ReDoS 的第二道防线）");
  // 相邻窗口必须重叠 hardLimit-overlap 字：末窗起点 = 968、1936，末窗不足则截断
  assert.ok(hard.length >= 3, "2500 字按 step=968 至少切 3 窗，实际 " + hard.length);
  const cut = splitSentences("甲".repeat(990) + "上" + "乙".repeat(6) + "香" + "丙".repeat(50));
  assert.ok(cut.some((u) => /上[^。！？]{0,20}香/.test(u)),
    "跨切点的匹配不得因硬切而丢失（重叠窗口的作用）");
});

test("⑥-c isGuardedArtifact 语义：只吃邻接巧合，没有守卫的词永不被打掉", () => {
  // 索引用 indexOf 现取（与 locate() 的实际调用方式一致），避免手数下标出错
  const guarded = (word, line) => {
    const at = line.indexOf(word);
    assert.ok(at >= 0, `夹具句不含「${word}」：${line}`);
    return isGuardedArtifact(word, line, at);
  };
  const kept = (word, line) => {
    const at = line.indexOf(word);
    assert.ok(at >= 0, `夹具句不含「${word}」：${line}`);
    return !isGuardedArtifact(word, line, at);
  };
  // 实证的误报现场（守卫表里的 evidence 原句）
  assert.equal(guarded("里正", "这里正是莫雷尔标出的位置"), true, "「这[里正]是」应判巧合");
  assert.equal(guarded("里正", "看他平日里正人君子的模样"), true, "「平日[里正]人」应判巧合");
  assert.equal(guarded("在下", "大雨还在下着"), true, "「[在下]着」应判巧合");
  assert.equal(guarded("在下", "他在下面的地窖里"), true, "「[在下]面」应判巧合");
  assert.equal(guarded("大人", "不是什么大人物"), true, "「大[大人]物」应判巧合");
  assert.equal(guarded("官人", "即使是文官人才也必须宣誓"), true, "「文[官人]才」应判巧合");
  // 真用法绝不能被吃（错填守卫 = 静默漏报）
  assert.equal(kept("里正", "他当了里正三年"), true, "真用法「里正」被吃掉了");
  assert.equal(kept("在下", "在下愿闻其详"), true, "真用法「在下」被吃掉了");
  // 多字序列守卫：只吃「老夫老妻」，不吃真用法「老夫老矣」
  assert.equal(guarded("老夫", "他们是一对老夫老妻了"), true);
  assert.equal(kept("老夫", "老夫老矣"), true, "「老夫老矣」是清代真用法，不得被判巧合");
  // 没有守卫条的词永不被判巧合；非法入参一律 false（不误吃）
  assert.equal(kept("掌柜", "掌柜推开门"), true);
  assert.equal(isGuardedArtifact("没人登记的词", "没人登记的词", 0), false);
  assert.equal(isGuardedArtifact("里正", null, 0), false);
  assert.equal(isGuardedArtifact("里正", "里正", -1), false);
  assert.equal(isGuardedArtifact("里正", "里正", undefined), false);
});

// ---------------------------------------------------------------------------
// ⑦ 逐词静音（双向：登记 → 消失；去掉 → 回来）
// ---------------------------------------------------------------------------

test("⑦ 逐词静音只作用于本书的该词，去掉豁免后必须回来", async () => {
  // 前置：中式基准下「修士」确实是禁词，且只在 allowWords 缺席时报出
  const before = wordsOf(await audit("豁免书"));
  assert.ok(before.includes("修士"), "前置不成立：中式基准下「修士」本就未被报出，本条没有鉴别力");

  const original = readFileSync(EXEMPT_SETTINGS_FILE, "utf8");
  try {
    const data = JSON.parse(original);
    data.worldview[0].allowWords = ["修士"];
    writeFileSync(EXEMPT_SETTINGS_FILE, JSON.stringify(data, null, 2), "utf8");

    const mutedAudit = await audit("豁免书");
    const muted = wordsOf(mutedAudit);
    assert.equal(muted.includes("修士"), false, "登记 allowWords 后「修士」仍被报出（静音失效）");
    // 静音是**逐词**的，不是整表失效——别的禁词照报
    assert.ok(muted.includes("教堂"), "静音不得连坐：别的禁词必须照报");
  } finally {
    writeFileSync(EXEMPT_SETTINGS_FILE, original, "utf8"); // 还原夹具
  }

  const restored = wordsOf(await audit("豁免书"));
  assert.ok(restored.includes("修士"), "去掉豁免后「修士」必须回来（静音不得是单向、不可逆的）");

  // 裁决点的返回体也要如实回传（审计文案要能解释"为什么少报了几条"）
  const settings = JSON.parse(original);
  const plain = resolveStyleRule({ worldview: [settings.worldview[0]] });
  assert.ok(plain.bannedWords.includes("修士"));
  assert.deepEqual(plain.allowedWords, []);
  assert.equal(plain.sources.muted, 0);

  const allowed = resolveStyleRule({ worldview: [settings.worldview[0]] }, [], { allowWords: ["修士"] });
  assert.equal(allowed.bannedWords.includes("修士"), false, "第三参 opts.allowWords 必须逐词静音");
  assert.deepEqual(allowed.allowedWords, ["修士"]);
  assert.equal(allowed.sources.muted, 1);
  // speechStyle.honorBad 也要被静音过滤（否则客套那一路照样报同一个词）
  assert.ok(plain.speechStyle.honorBad.includes("修士"));
  assert.equal(allowed.speechStyle.honorBad.includes("修士"), false, "honorBad 未随静音过滤");

  const registered = resolveStyleRule({ worldview: [{ name: "x", basis: "东方/中式古代", allowWords: ["修士"] }] });
  assert.equal(registered.bannedWords.includes("修士"), false, "worldview 条目上的 allowWords 必须生效");
  assert.deepEqual(registered.allowedWords, ["修士"]);
});
