/**
 * 套话结构词表（`lib/lexicons/slop.js`）的门禁测试（v7.0.0 · Phase 0「先修尺子」）。
 *
 * 为什么这个测试必须存在：
 * 这张表是**新引入的判定**——它说"某句话是陈词套话"。判定一旦放宽，就会把正常叙事判成病灶
 * （改稿台据此让人改掉好句子），比漏报更贵；判定一旦写坏，同步正则无法中断（`/上.*香/` 曾在
 * 121 字上跨 3 句误报、`/(上*)*香/` 在 29 字上跑 40 秒）。所以六组断言把"能命中"与"不许误杀"
 * 同时钉住，另加两组口径断言（区间合并、密度分母）与生成侧断言（topSlopCategories 只给类别）。
 *
 *   | 组 | 断言 |
 *   |----|------|
 *   | ① | 每条 pattern 过 `core.validatePattern()`（先证明校验器不是摆设）；类别规模 6~14、hint ≤26 字 |
 *   | ② | 每类 ≥2 条真实句子被命中，**行号**正确；`text` 是该行原文子串且 ≤24 字；并证明 index 是码点偏移 |
 *   | ③ | 负样本：正常描写必须 0 命中；引号内台词只静音 ai_ese/abstract_tell；ending_preach 只扫章末 2 段 |
 *   | ④ | 区间合并：同一行重叠的覆盖只计 1 处，且保留**最长**的那条 |
 *   | ⑤ | 密度口径：`densityPer1000` = 合并后处数 / 千字（手算锁定） |
 *   | ⑥ | `topSlopCategories` 按类别计频、返回类别键而不是原文 |
 *   | ⑦ | 空输入/非法入参的兜底，以及 `byCategory` 的键序即展示顺序 |
 *
 * 维护纪律：改 `lib/lexicons/slop.js`（加条目 / 收窄 / 放宽）时，**正样本与负样本必须同时加**，
 * 然后把本文件跑绿。只加正样本 = 迟早"宁可错杀"；只加负样本 = 词表变成空壳。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { validatePattern } from "../lib/core.js";
import {
  SLOP_CATEGORIES,
  SLOP_CATEGORY_PRESCRIPTIONS,
  SLOP_RULES,
  buildSlopExemptions,
  describeSlopPrescription,
  scanSlop,
  topSlopCategories
} from "../lib/lexicons/slop.js";

const CATEGORY_KEYS = Object.keys(SLOP_CATEGORIES);

/** 取某类命中（默认整段文本一次扫描）。 */
const hitsOf = (result, category) => result.hits.filter((h) => h.category === category);

// ---------------------------------------------------------------------------
// ① 正则安全
// ---------------------------------------------------------------------------

test("① 正则安全：73 条 pattern 全部通过 validatePattern，且规模/hint/形状合规", () => {
  // 先证明校验器**不是摆设**：它必须能拒掉本仓库实测过的危险形态，否则下面"全部通过"毫无意义
  assert.equal(validatePattern("(上*)*香").level, "reject", "validatePattern 漏放嵌套量词——本测试的绿是假绿");
  assert.equal(validatePattern("上.*香").level, "reject", "validatePattern 漏放无界通配——本测试的绿是假绿");

  // 每个类别都出现在表里，且键名/顺序与契约一致
  assert.deepEqual(
    [...new Set(SLOP_RULES.map((r) => r.category))].sort(),
    [...CATEGORY_KEYS].sort(),
    "词表覆盖的类别与 SLOP_CATEGORIES 的键不一致"
  );

  for (const rule of SLOP_RULES) {
    // ①-a 静态+经验校验：level 必须是 ok（warn 也算未通过）
    const verdict = validatePattern(rule.source);
    assert.equal(verdict.level, "ok", `「${rule.source}」未通过 validatePattern：${verdict.level} / ${verdict.reason}`);
    assert.equal(verdict.ok, true, `「${rule.source}」ok=false：${verdict.reason}`);

    // ①-b 形状纪律（硬性要求 3）：不许无界通配、不许无上界重复、{n,m} 的 m ≤ 12
    assert.ok(!/\.\*/.test(rule.source), `「${rule.source}」含 .*：会跨句误报`);
    assert.ok(!/\[\\s\\S\][*+]/.test(rule.source), `「${rule.source}」含 [\\s\\S]*：会跨句误报`);
    assert.ok(!/\{\d+,\}/.test(rule.source), `「${rule.source}」含无上界重复 {n,}`);
    for (const quant of rule.source.matchAll(/\{(\d+),(\d+)\}/g)) {
      assert.ok(Number(quant[2]) <= 12, `「${rule.source}」的 {${quant[1]},${quant[2]}} 上界超过 12`);
    }

    // ①-c hint 是中文改法，≤26 字（报告里一行放得下）
    assert.equal(typeof rule.hint, "string");
    assert.ok(rule.hint.trim().length > 0, `「${rule.source}」没有 hint`);
    assert.ok(Array.from(rule.hint).length <= 26, `「${rule.source}」的 hint 超过 26 字：${rule.hint}`);
  }

  // ①-d 词表规模：每类 6~14 条，且同类内不重复
  for (const category of CATEGORY_KEYS) {
    const list = SLOP_RULES.filter((r) => r.category === category);
    assert.ok(list.length >= 6 && list.length <= 14, `类别「${category}」条目数 ${list.length}，应在 6~14 之间`);
    assert.equal(new Set(list.map((r) => r.source)).size, list.length, `类别「${category}」有重复 pattern`);
  }
});

// ---------------------------------------------------------------------------
// ② 正样本
// ---------------------------------------------------------------------------

/** 每类 3 条真实网文风格的句子（都刻意用短句，便于把行号断言写死）。 */
const POSITIVE = {
  eye_cliche: ["他眼中闪过一丝失望。", "她的眼底掠过一抹讥诮。", "看到那面旗，他瞳孔骤然一缩。"],
  smirk_cliche: ["他嘴角勾起，转身走了。", "她三分薄凉地笑了笑。", "他似笑非笑地看着她。"],
  shock_crowd: ["话音落下，全场哗然。", "众人倒吸一口凉气。", "屋里一时鸦雀无声。"],
  filler_transition: ["就在此时，门开了。", "与此同时，远处的钟声响了。", "不知为何，他停下了脚步。"],
  abstract_tell: ["他心中一沉。", "他感到一阵疲惫。", "一种说不出的滋味涌上来。", "他脸上露出不易察觉的失望。"],
  ending_preach: ["但他不知道，这一夜之后一切都变了。", "命运的齿轮开始转动。", "而这一切，才刚刚开始。"],
  ai_ese: ["毫无疑问，这是他最坏的打算。", "对于他而言，这不过是一场交易。", "事实上，他早就知道了。"],
  stat_numeric: ["力量提升了三成，他终于推开了那扇门。", "他的战斗力达到了三千点。", "速度暴涨了整整三倍。"]
};

test("② 正样本：每类 ≥2 条真实句子被命中，且行号正确", () => {
  for (const category of CATEGORY_KEYS) {
    const lines = POSITIVE[category];
    assert.ok(Array.isArray(lines) && lines.length >= 2, `类别「${category}」正样本少于 2 条`);

    const text = lines.join("\n");
    const result = scanSlop(text);

    lines.forEach((line, i) => {
      const expectedLine = i + 1;
      const found = result.hits.filter((h) => h.category === category && h.line === expectedLine);
      assert.ok(
        found.length >= 1,
        `类别「${category}」未命中第 ${expectedLine} 行：${line}\n实际命中：` + JSON.stringify(result.hits)
      );
      for (const hit of found) {
        // text 必须是该行原文的子串（不能是别行/拼出来的），且 ≤24 字
        assert.ok(line.includes(hit.text), `命中的 text 不是该行原文子串：${hit.text} / ${line}`);
        assert.ok(Array.from(hit.text).length <= 24, `命中片段超过 24 字：${hit.text}`);
        // index/length 在该行区间内
        assert.ok(hit.index >= 0, `index 为负：${JSON.stringify(hit)}`);
        assert.ok(
          hit.index + hit.length <= Array.from(line).length,
          `命中区间越出行尾：${JSON.stringify(hit)} / ${line}`
        );
        // hint 来自词表，且是该类的改法
        assert.ok(
          SLOP_RULES.some((r) => r.category === category && r.hint === hit.hint),
          `hint 不是词表里的条目：${hit.hint}`
        );
      }
    });

    // 每类都要真的被扫出来，不能只靠"某一行恰好也命中"
    assert.ok(hitsOf(result, category).length >= 2, `类别「${category}」整体命中过少：` + result.total);
  }
});

test("②-b index 是行内**码点**偏移（emoji 不按 2 位算）", () => {
  // 😀 是 1 个码点 / 2 个 UTF-16 码元：用 slice 偏移会得到 3，用码点口径应为 2
  const line = "😀他眼中闪过一丝慌乱。";
  const hit = hitsOf(scanSlop(line), "eye_cliche")[0];
  assert.ok(hit, "emoji 行未被命中");
  assert.equal(hit.index, 2, "index 按 UTF-16 码元算了（应为码点偏移）");
  assert.equal(hit.length, Array.from("眼中闪过一丝").length);
  assert.equal(hit.text, "眼中闪过一丝");
});

// ---------------------------------------------------------------------------
// ③ 负样本（比正样本更重要）
// ---------------------------------------------------------------------------

test("③ 负样本：正常描写必须 0 命中（宁可漏报，不许误杀）", () => {
  const CLEAN = [
    "他冷冷地看着窗外。",
    "她温柔地笑了。",
    "空气里有股铁锈味，混着药香与淡淡的腥甜。",
    // 合理的生理描写：瞳孔里映着火光 ≠ "瞳孔一缩"
    "他瞳孔里映着火光。",
    "他把刀放下，转身走进了雨里。",
    "雨点砸在瓦上，檐下的灯笼晃了晃。",
    // 近失手（高风险规则的负样本，逐条见交付说明）：
    "一道不易察觉的裂缝爬上了墙。",        // 收窄后的 abstract_tell 不许命中"观察"义
    "他不知为何物，只当是块石头。",        // 缺逗号 → 不是灌水的"不知为何，"
    "这瓶酒有五十三度。",                  // 只有数字、没有倍/% → 不是数值播报
    "他使了个眼色，示意众人退下。",        // "使" 不是 "使得"
    "他知道，这话说出去就收不回来了。"      // "知道" 不是 "不知道"（预告句）
  ];
  for (const sentence of CLEAN) {
    const result = scanSlop(sentence);
    assert.equal(result.total, 0, "误杀正常描写：" + sentence + " → " + JSON.stringify(result.hits));
    assert.deepEqual(result.hits, [], "误杀正常描写：" + sentence);
  }
});

test("③-b 引号内台词：只静音 ai_ese / abstract_tell，其余类别照扫", () => {
  // 角色说「毫无疑问」是在塑造声线，不是 AI 腔 —— 默认（skipQuoted: true）不得命中
  const dialogue = '"毫无疑问，是他。"他说。';
  assert.equal(
    hitsOf(scanSlop(dialogue), "ai_ese").length,
    0,
    "引号内台词被当成 AI 腔误杀了：" + JSON.stringify(scanSlop(dialogue).hits)
  );
  // 但同一句在叙述里（引号外）必须命中——证明不是 pattern 失效
  assert.equal(hitsOf(scanSlop("毫无疑问，是他。"), "ai_ese").length, 1, "引号外的 ai_ese 漏检");
  // 显式关掉 skipQuoted 时，台词里的也要报出来（证明开关真的起作用）
  assert.equal(
    hitsOf(scanSlop(dialogue, { skipQuoted: false }), "ai_ese").length,
    1,
    "skipQuoted:false 时台词内的 ai_ese 仍未命中"
  );

  // abstract_tell 同样被静音（第二类）
  const innerThought = '"他心中一沉。"他低声说。';
  assert.equal(hitsOf(scanSlop(innerThought), "abstract_tell").length, 0, "引号内的 abstract_tell 未被静音");
  assert.equal(hitsOf(scanSlop(innerThought, { skipQuoted: false }), "abstract_tell").length, 1);

  // 其余类别**不许**被 skipQuoted 波及：众人震惊在引号内照样是套话
  const quotedCrowd = "「众人倒吸一口凉气。」";
  assert.equal(hitsOf(scanSlop(quotedCrowd), "shock_crowd").length, 1, "shock_crowd 被 skipQuoted 误静音了");
});

test("③-c ending_preach 只扫章末 2 个自然段（章中的「但他不知道」不得命中）", () => {
  // 4 个自然段（空行分段）：预告句在第 3 段 → 超出"最后 2 段"，必须不报
  const midChapter = [
    "他把灯吹灭了。",
    "",
    "但他不知道，这一夜之后一切都变了。",
    "",
    "雨还在下。",
    "",
    "他推开门，走了出去。"
  ].join("\n");
  const mid = scanSlop(midChapter);
  assert.equal(hitsOf(mid, "ending_preach").length, 0, "章中的预告句被当成章末命中了：" + JSON.stringify(mid.hits));
  assert.equal(mid.hits.filter((h) => h.line === 3).length, 0, "第 3 行（倒数第 3 段）不该被 ending_preach 扫到");

  // 同一句挪到最后一段 → 必须命中（证明是"范围"在起作用，不是 pattern 匹配不到）
  const endChapter = ["他把灯吹灭了。", "", "雨还在下。", "", "但他不知道，这一夜之后一切都变了。"].join("\n");
  const end = scanSlop(endChapter);
  const hit = hitsOf(end, "ending_preach").find((h) => h.line === 5);
  assert.ok(hit, "章末的预告句没被命中：" + JSON.stringify(end.hits));
  assert.equal(hit.text, "他不知道，");

  // 章末 2 段里的另一条结构也要命中
  const twoParagraphs = ["他把灯吹灭了。", "", "雨还在下。", "", "命运的齿轮开始转动。"].join("\n");
  assert.equal(hitsOf(scanSlop(twoParagraphs), "ending_preach").length, 1);
});

// ---------------------------------------------------------------------------
// ④ 区间合并
// ---------------------------------------------------------------------------

test("④ 区间合并：同一行重叠的两条只计 1 处，并保留最长的那条", () => {
  // 「嘴角勾起」(4 字) 与「勾起一抹弧度」(6 字) 在同一行重叠 → 1 处，取最长
  const merged = scanSlop("他嘴角勾起一抹弧度。");
  assert.equal(merged.total, 1, "重叠的套话被重复计数：" + JSON.stringify(merged.hits));
  assert.equal(merged.byCategory.smirk_cliche, 1);
  const hit = merged.hits[0];
  assert.equal(hit.text, "勾起一抹弧度", "合并后应保留最长的片段（不是先到的那条）");
  assert.equal(hit.index, 3, "合并后的 index 应是被保留那条的起点");
  assert.equal(hit.length, 6);

  // 不重叠的命中仍然各算一处（合并不能"过度"）
  const apart = scanSlop("他眼中闪过一丝慌乱，嘴角勾起一抹弧度。");
  assert.equal(apart.total, 2, "不重叠的命中被合并掉了：" + JSON.stringify(apart.hits));
  assert.equal(apart.byCategory.eye_cliche, 1);
  assert.equal(apart.byCategory.smirk_cliche, 1);

  // 规则交叉重叠（stat_numeric 两条规则覆盖同一段）也只算一处
  const crossed = scanSlop("力量提升了三成。");
  assert.equal(crossed.total, 1, "同一处数值播报被两条规则各报一次：" + JSON.stringify(crossed.hits));
});

// ---------------------------------------------------------------------------
// ⑤ 密度口径
// ---------------------------------------------------------------------------

test("⑤ 密度口径：densityPer1000 = 合并后处数 / 千字（手算锁定）", () => {
  // 三行正文：10 + 9 + 14 = 33 个字，加 2 个换行符 = 35（分母用 text.length，含空白，与 analysis.js 同口径）
  const text = ["他眼中闪过一丝慌乱。", "就在此时，门开了。", "他把刀放下，转身走进了雨里。"].join("\n");
  assert.equal(text.length, 35, "测试语料长度变了，下面的手算结论需要重算");
  const result = scanSlop(text);

  assert.equal(result.total, 2, "合并后应为 2 处：" + JSON.stringify(result.hits));
  assert.equal(result.lines, 3);
  assert.equal(result.byCategory.eye_cliche, 1);
  assert.equal(result.byCategory.filler_transition, 1);
  // 手算：2 / 35 * 1000 = 57.142857… → 保留一位小数 = 57.1
  assert.equal(result.densityPer1000, 57.1, "密度不是「合并后处数 / 千字」：" + result.densityPer1000);
  // 与 analysis.js 的 per1000 公式逐字对齐（同一份舍入）
  assert.equal(result.densityPer1000, Math.round((result.total / Math.max(text.length, 1)) * 1000 * 10) / 10);
  // byCategory 之和必须等于 total（不能有"报了数却没进分类"的命中）
  assert.equal(Object.values(result.byCategory).reduce((a, b) => a + b, 0), result.total);
});

// ---------------------------------------------------------------------------
// ⑥ 生成侧：只给类别，不给原文
// ---------------------------------------------------------------------------

test("⑥ topSlopCategories：按类别计频、返回类别键而不是原文", () => {
  const text = ["他眼中闪过一丝慌乱。", "她眼中闪过一丝讥诮。", "就在此时，门开了。"].join("\n");
  const result = scanSlop(text);
  assert.equal(result.byCategory.eye_cliche, 2);
  assert.equal(result.byCategory.filler_transition, 1);

  const top1 = topSlopCategories(result.hits, 1);
  assert.deepEqual(top1, ["eye_cliche"], "频次最高的类别取错：" + JSON.stringify(top1));
  assert.deepEqual(topSlopCategories(result.hits, 2), ["eye_cliche", "filler_transition"]);
  assert.equal(topSlopCategories(result.hits, 0).length, 0, "n=0 应返回空数组");
  assert.deepEqual(topSlopCategories([], 3), [], "空 hits 应返回空数组");
  assert.ok(topSlopCategories(result.hits).length <= 3, "省略 n 时不应返回超过 3 类");

  // 返回的每个元素都必须是类别键——绝不能是命中原文（那会把陈词喂回生成侧）
  for (const category of topSlopCategories(result.hits, 5)) {
    assert.ok(Object.prototype.hasOwnProperty.call(SLOP_CATEGORIES, category), "返回了非类别键：" + category);
    assert.ok(!result.hits.some((h) => h.text === category), "返回了命中原文：" + category);
  }
});

// ---------------------------------------------------------------------------
// ⑦ 兜底与展示顺序
// ---------------------------------------------------------------------------

test("⑦ 空输入/非法入参兜底，byCategory 的键序即报告展示顺序", () => {
  // 空值 → 当作空文本（0 行）；非法但可字符串化的入参 → 按字面处理（1 行）
  for (const [input, expectedLines] of [["", 0], [null, 0], [undefined, 0], [123, 1]]) {
    const result = scanSlop(input);
    assert.equal(result.total, 0, "非法/空输入仍有命中：" + String(input));
    assert.deepEqual(result.hits, []);
    assert.equal(result.densityPer1000, 0, "空输入的密度应为 0，而不是 NaN/Infinity：" + result.densityPer1000);
    assert.equal(result.lines, expectedLines, "空文本应为 0 行，非空文本按行数计：" + String(input));
  }

  const keys = Object.keys(scanSlop("").byCategory);
  assert.deepEqual(keys, CATEGORY_KEYS, "byCategory 的键序必须是 SLOP_CATEGORIES 的顺序（报告按它展示）");
  assert.ok(Object.isFrozen(SLOP_CATEGORIES), "SLOP_CATEGORIES 必须冻结（键名/顺序是契约）");

  // 没有命中时，8 个类别也都要以 0 出现（报告不需要自己补零）
  for (const category of CATEGORY_KEYS) assert.equal(scanSlop("").byCategory[category], 0);
});

test("⑧ 题材豁免（系统流静音 stat_numeric）+ 参照集高频习惯词豁免 + 动态处方 + 单换行整章 endingLineSet", () => {
  // 1) 系统流/面板流自动静音 stat_numeric
  const statLine = "力量提升了三成，属性面板上生命值达到五百。";
  assert.ok(scanSlop(statLine).byCategory.stat_numeric >= 2);
  assert.equal(scanSlop(statLine, { genre: "无限流系统面板" }).byCategory.stat_numeric, 0);

  // 2) 参照集高频词豁免（≥500 字、单条规则命中 ≥2 且密度 ≥0.5/千字）
  const refText = ("他推开木门走了进去，眼中闪过一丝寒意。" + "院子里的石桌上放着茶杯，雨点打在青瓦上。".repeat(15)).repeat(2);
  assert.ok(refText.length >= 500);
  const ex = buildSlopExemptions(refText, { settings: { worldview: [{ name: "系统流世界", basis: "数据面板" }] } });
  assert.ok(ex.muteCategories.includes("stat_numeric"), "系统流设定应静音 stat_numeric");
  assert.ok(ex.exemptRules.length >= 1, "参照集高频出现的套话规则应进入 exemptRules");
  assert.equal(scanSlop("他眼中闪过一丝慌乱，属性面板亮起。", ex).total, 0, "豁免规则与静音类别应生效");

  // 3) 动态套话处方：按命中类别返回对应模式描述，且不含具体套话原文
  const fillerPrescription = describeSlopPrescription(["filler_transition", "shock_crowd"]);
  assert.ok(fillerPrescription.includes("时间副词") && fillerPrescription.includes("群体烘托"));
  assert.equal(Object.keys(SLOP_CATEGORY_PRESCRIPTIONS).length, CATEGORY_KEYS.length);

  // 4) 单换行整章（>4 行内容且带 # 标题 + 空行）：第 1 行内容里的「但他不知道」不得被判成章末升华
  const singleNewlineChapter = [
    "# 第01章 雨夜",
    "",
    "但他不知道，客栈里早就埋伏了刀客。",
    "他推开木门，抖落斗笠上的雨水。",
    "伙计迎上来，接过他手里的长伞。",
    "他走到靠窗的木桌边坐下，摸出三枚铜钱。",
    "窗外的雨越下越大，打得竹叶沙沙作响。",
    "他端起粗瓷茶碗喝了一口热茶。"
  ].join("\n");
  assert.equal(hitsOf(scanSlop(singleNewlineChapter), "ending_preach").length, 0, "单换行整章首段不该被判成章末升华");
});