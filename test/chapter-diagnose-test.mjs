/**
 * v7.0.0 单章症状诊断的回归测试（chapter-diagnose-test.mjs）。
 *
 * 这个测试守的是"单一裁决点"的**判定边界**，不是具体数值：
 *   ① 章末升华：末段无对话 + 去噪动作 < 2 + （抽象总结词 ≥ 2 或 slop 的 ending_preach 命中）；
 *      重点钉住「望/看/听/想/知」不算具象动作——否则"他望着远方，深知……"会因一个「望」漏判；
 *   ② 站桩：连续 ≥ 6 段（无参照集）只有台词与「道/冷笑」；插入真实动作后必须不报；
 *   ③ 套话：≥ 5 处且 ≥ 2.0 处/千字；
 *   ④ 相对判定：同一段高抽象文本，有 refStats 报 abstract、refStats=null 时**不报**
 *      （证明没有偷偷用绝对阈值）；
 *   ⑤ plan 兑现：合格/不合格 plan、物象缺失进 unfulfilled；
 *   ⑥ 空值安全：任何空/脏输入都不抛错；
 *   —— v7.0.0 实测修复后新增（旧的 16 条一条没删）——
 *   ⑦ plan 兑现：格式规范的 plan 不得被腰斩成「林风去黑 / 黑市买药 / 器物」；
 *      元标签不参与核对；兑现度 ≥1 的行只报具体缺口；
 *   ⑧ 站桩：「根本」这类虚词不得打断裸台词游程（判定必须走 densityOf 的豁免层）；
 *   ⑨ 章末升华：按段定位（第 1 行的「但他不知道」不能算到末段头上），末段已合格就不报；
 *   ⑩ 感官通道单一：参照集 p10=0 时按「0 命中」触发，不再 `hits < 0` 恒 false 永不触发；
 *      有参照集章长时按千字密度比较（万字参照集不误伤短章）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnoseChapterSymptoms,
  checkPlanFulfillment,
  maxBareDialogueRun
} from "../lib/chapter-diagnose.js";

const keysOf = (list) => (Array.isArray(list) ? list.map((item) => item.key) : []);

/** 参照集分位（形状与 lib/core.js 的 buildReferenceStats 一致） */
const REF_STATS = {
  chapters: 16,
  actionVerbsPer1000: { p10: 3, p50: 9, p85: 18, p95: 26 },
  abstractDensity: { p10: 2, p50: 6, p85: 10, p95: 12 },
  objectNounsPer1000: { p10: 2, p50: 6, p85: 12, p95: 16 },
  sensePer1000: { p10: 2, p50: 7, p85: 14, p95: 18 },
  senseChannels: {
    visual: { p10: 3, p50: 8, p85: 14, p95: 18 },
    auditory: { p10: 2, p50: 5, p85: 9, p95: 12 },
    tactile: { p10: 1, p50: 3, p85: 6, p95: 8 },
    olfactory: { p10: 1, p50: 2, p85: 4, p95: 6 },
    temperature: { p10: 1, p50: 2, p85: 4, p95: 5 }
  },
  bareDialogueRun: { p50: 2, p95: 4, max: 9 }
};

// ── ① 章末升华 ──────────────────────────────────────────────────────────────

test("① 章末升华：末段停在抽象感悟上必须报 ending_preach", () => {
  const text = [
    "他推开门，抓起长刀，刀锋撞在门框上，火星四溅。",
    "他望着远方的夜空，终于明白，真正的路途才刚刚开始。"
  ].join("\n\n");
  const got = diagnoseChapterSymptoms(text, null);
  assert.ok(keysOf(got).includes("ending_preach"), "应报 ending_preach，实际：" + JSON.stringify(got));
  const item = got.find((symptom) => symptom.key === "ending_preach");
  assert.ok(item.severity >= 1 && item.severity <= 5, "severity 必须在 1..5：" + item.severity);
  assert.ok(item.detail.length <= 60, "detail 必须 ≤ 60 字：" + item.detail);
});

test("① 章末换成具体动作后不得报 ending_preach", () => {
  const text = [
    "他推开门，抓起长刀，刀锋撞在门框上，火星四溅。",
    "他一把扯下门帘，刀光劈落。"
  ].join("\n\n");
  assert.ok(!keysOf(diagnoseChapterSymptoms(text, null)).includes("ending_preach"));
});

test("① 「望/看/听/想/知」不算具象动作（升华句不能因为「望」而漏判）", () => {
  // 旁白里只有 望/看/知 三个"感知心理动词"，一个具象动作都没有。
  // 若实现把「望」「看」算成动作（=2），ending_preach 就会因"动作 ≥ 2"被跳过。
  const onlyPerception = "他望着远处的灯火，看着夜色，深知未来之路。";
  const got = diagnoseChapterSymptoms(onlyPerception, null);
  assert.ok(keysOf(got).includes("ending_preach"), "望/看 被当成具象动作了：" + JSON.stringify(got));

  // 反证：换成真实的连续动作（≥ 2 个），同样的抽象结尾就不该报
  const withActions = "他推开门，抓起长刀，深知未来之路。";
  assert.ok(!keysOf(diagnoseChapterSymptoms(withActions, null)).includes("ending_preach"), "有连续动作时不应报章末升华");
});

// ── ② 站桩对话 ──────────────────────────────────────────────────────────────

const BARE_LINES = [
  "“你来了。”他道。",
  "“嗯。”他冷笑。",
  "“坐吧。”他道。",
  "“不了。”他冷笑。",
  "“随你。”他道。",
  "“告辞。”他冷笑。",
  "“不送。”他道。"
];

test("② 连续 7 段只有台词与「道/冷笑」→ 报 bare_dialogue", () => {
  const text = BARE_LINES.join("\n");
  const run = maxBareDialogueRun(text);
  assert.deepEqual(run, { run: 7, from: 1, to: 7 }, "裸台词连续段识别错误：" + JSON.stringify(run));
  const got = diagnoseChapterSymptoms(text, null);
  assert.ok(keysOf(got).includes("bare_dialogue"), "应报 bare_dialogue，实际：" + JSON.stringify(got));
});

test("② 插入真实动作后（旁白有物理交互）不再算站桩", () => {
  const withActions = BARE_LINES.slice();
  withActions[2] = "“坐吧。”他摩挲着杯沿，道。";
  withActions[5] = "“告辞。”他摩挲着杯沿，道。";
  const text = withActions.join("\n");
  assert.ok(!keysOf(diagnoseChapterSymptoms(text, null)).includes("bare_dialogue"), "有物象交互的旁白被误判成站桩");
});

test("② 有 refStats 时阈值取 max(4, p95)", () => {
  // p95 = 4 → 阈值 4：4 段裸台词即应报（无参照集时 4 段不够）
  const text = BARE_LINES.slice(0, 4).join("\n");
  assert.ok(!keysOf(diagnoseChapterSymptoms(text, null)).includes("bare_dialogue"));
  assert.ok(keysOf(diagnoseChapterSymptoms(text, REF_STATS)).includes("bare_dialogue"), "有参照集时 4 段应达阈值");
});

// ── ③ 套话 ──────────────────────────────────────────────────────────────────

test("③ 套话 ≥5 处且密度 ≥2.0 → 报 slop", () => {
  const text = [
    "他眼中闪过一丝慌乱。",
    "她眼中闪过一丝犹豫。",
    "他眼中闪过一丝不安。",
    "她眼中闪过一丝迟疑。",
    "他眼中闪过一丝阴霾。",
    "她眼中闪过一丝恐惧。"
  ].join("\n");
  const got = diagnoseChapterSymptoms(text, null);
  assert.ok(keysOf(got).includes("slop"), "应报 slop，实际：" + JSON.stringify(got));
});

test("③ 少数套话（低于 5 处）不报 slop", () => {
  const text = "他眼中闪过一丝慌乱。\n她低头整理衣袖，把袖口压平。";
  assert.ok(!keysOf(diagnoseChapterSymptoms(text, null)).includes("slop"));
});

// ── ④ 相对判定（refStats 是唯一依据） ────────────────────────────────────────

const ABSTRACT_HEAVY = "孤独，悲伤，痛苦，绝望，迷茫，恐惧，思念，惆怅，寂寞，空虚。";

test("④ 有 refStats 且抽象度高于 p95 → 报 abstract", () => {
  const got = diagnoseChapterSymptoms(ABSTRACT_HEAVY, REF_STATS);
  assert.ok(keysOf(got).includes("abstract"), "应报 abstract，实际：" + JSON.stringify(got));
});

test("④ refStats=null 时同样的文本不得报 abstract（不许偷用绝对阈值）", () => {
  const got = diagnoseChapterSymptoms(ABSTRACT_HEAVY, null);
  assert.ok(!keysOf(got).includes("abstract"), "null 参照集时仍报了相对症状：" + JSON.stringify(got));
  assert.ok(!keysOf(got).includes("action_thin"));
  assert.ok(!keysOf(got).includes("object_thin"));
  assert.ok(!keysOf(got).includes("sense_mono"));
});

test("④ 参照集该维度全为 0 时跳过（不因分位缺失误报）", () => {
  const zeroRef = {
    ...REF_STATS,
    abstractDensity: { p10: 0, p50: 0, p85: 0, p95: 0 }
  };
  assert.ok(!keysOf(diagnoseChapterSymptoms(ABSTRACT_HEAVY, zeroRef)).includes("abstract"));
});

test("④ 所有返回项的 key / severity / detail 都在契约内", () => {
  const allowed = new Set([
    "ending_preach", "bare_dialogue", "slop", "abstract", "action_thin", "sense_mono", "object_thin"
  ]);
  const got = diagnoseChapterSymptoms(ABSTRACT_HEAVY, REF_STATS);
  for (const item of got) {
    assert.ok(allowed.has(item.key), "未知 key：" + item.key);
    assert.ok(Number.isInteger(item.severity) && item.severity >= 1 && item.severity <= 5, "severity 越界：" + item.severity);
    assert.ok(typeof item.title === "string" && item.title.length > 0);
    assert.ok(typeof item.detail === "string" && item.detail.length > 0 && item.detail.length <= 60, "detail 越界：" + item.detail);
  }
});

// ── ⑤ plan 兑现核对 ─────────────────────────────────────────────────────────

test("⑤ 合格 plan 且正文兑现 → qualified:true、unfulfilled:[]", () => {
  const plan = [
    "1. 他推开木门，抓起桌上的长刀。",
    "2. 他横刀在胸前，盯着门外的雨。"
  ].join("\n");
  const content = [
    "他推开木门，抓起桌上的长刀。",
    "他横刀在胸前，盯着门外的雨。"
  ].join("\n");
  const result = checkPlanFulfillment(plan, content);
  assert.equal(result.qualified, true);
  assert.deepEqual(result.unfulfilled, []);
  assert.equal(result.checked, 2);
});

test("⑤ plan 只有元指令（按大纲写）→ qualified:false", () => {
  const result = checkPlanFulfillment("按大纲写。", "他推开门，走了进去。");
  assert.equal(result.qualified, false);
  assert.deepEqual(result.unfulfilled, []);
  assert.equal(result.checked, 0);
});

test("⑤ plan 写了正文没有的物象 → 进 unfulfilled", () => {
  const plan = "他推开木门，抓起桌上的青铜灯。";
  const content = "他推开木门，抓起桌上的长刀。";
  const result = checkPlanFulfillment(plan, content);
  assert.equal(result.qualified, true);
  assert.ok(result.unfulfilled.some((fragment) => fragment.includes("青铜")), "缺失物象未进 unfulfilled：" + JSON.stringify(result.unfulfilled));
});

// ── ⑦ plan 兑现：格式规范的 plan（v7.0.0 实测反例） ─────────────────────────

/** 实测反例原文：方括号子句 + 三个元标签 + 三个落点 */
const FORMATTED_PLAN =
  "1. [林风去黑市买药] → 器物：青瓷药瓶；肢体动作：拔开木塞；场景落点：油灯熄灭";
const FORMATTED_BODY = "他走进黑市，从怀里摸出青瓷药瓶，拔开木塞闻了闻，油灯在风里熄灭。";

test("⑦ 格式规范的 plan + 正文已兑现 → qualified:true 且 unfulfilled 为空", () => {
  const result = checkPlanFulfillment(FORMATTED_PLAN, FORMATTED_BODY);
  assert.equal(result.qualified, true, "格式合规的 plan 被判不合格：" + JSON.stringify(result));
  assert.deepEqual(result.unfulfilled, [], "正文其实完全兑现了，却报了未兑现：" + JSON.stringify(result.unfulfilled));
  assert.equal(result.checked, 1);
  // 旧行为（回归锁定）：返回 {"qualified":true,"unfulfilled":["林风去黑","黑市买药","器物"]}——
  //   ① 元标签「器物」被当成要兑现的物象；② 方括号子句被腰斩后拿去正文里找；
  //   ③ slice(0,4)/slice(-4) 把长块砍成正文里根本不会出现的词，后面的动作/落点直接丢弃。
  for (const fragment of result.unfulfilled) {
    assert.notEqual(fragment, "器物", "元标签不该进 unfulfilled");
    assert.ok(!fragment.includes("林风去黑"), "方括号子句不该被腰斩后核对");
  }
});

test("⑦ 元标签不参与核对：只有标签的 plan 判不合格，标签也不会被当成兑现", () => {
  // 只有标签：剥完元标签后没有任何可核对片段 → qualified:false（这是"没有可核对的物象"，不是"没兑现"）
  const labelOnly = checkPlanFulfillment("1. 器物：；肢体动作：；场景落点：", "他走进屋里。");
  assert.equal(labelOnly.qualified, false, "只有元标签的 plan 不该判合格：" + JSON.stringify(labelOnly));
  assert.deepEqual(labelOnly.unfulfilled, []);
  assert.equal(labelOnly.checked, 0);

  // 标签 + 物象：正文没写这个物象 → 必须报物象；「器物」不能被算成兑现，也不能进 unfulfilled
  const withObject = checkPlanFulfillment("1. 器物：青瓷药瓶", "他走进屋里。");
  assert.equal(withObject.qualified, true);
  assert.deepEqual(withObject.unfulfilled, ["青瓷药瓶"], "标签命中不能代替物象兑现：" + JSON.stringify(withObject.unfulfilled));
  assert.ok(!withObject.unfulfilled.includes("器物"), "「器物」是元标签，不该当物象核对");
});

test("⑦ 兑现度 ≥1 的行只报具体缺口，不把已兑现的部分算漏写", () => {
  const result = checkPlanFulfillment("他推开木门，抓起桌上的青铜灯。", "他推开木门，抓起桌上的长刀。");
  assert.equal(result.qualified, true);
  // 旧行为会把整行/半截词都报出来（如「上青铜灯」以外的「抓起桌上」也算）；现在只报对不上的那一段
  assert.deepEqual(result.unfulfilled, ["青铜灯"], "只应报对不上的那一段：" + JSON.stringify(result.unfulfilled));
});

// ── ⑧ 站桩：虚词不得打断裸台词游程 ───────────────────────────────────────────

/** 旁白只有一个虚词「根本」：没有任何物理交互，仍是裸台词段 */
const BARE_WITH_EMPTY_WORD = Array.from({ length: 7 }, () => "“胡说！”他根本不信。");

test("⑧ 「根本」这类虚词不得打断裸台词游程 → 仍报 bare_dialogue", () => {
  const text = BARE_WITH_EMPTY_WORD.join("\n");
  // 旧行为：densityChannelCovers("object", "他根本不信") 命中「根本」里的「本」，
  // 判成"含实物器物" → 连续 7 段裸台词被打断（run=0），站桩漏检。
  const run = maxBareDialogueRun(text);
  assert.deepEqual(run, { run: 7, from: 1, to: 7 }, "虚词打断了游程：" + JSON.stringify(run));
  assert.ok(keysOf(diagnoseChapterSymptoms(text, null)).includes("bare_dialogue"), "站桩被漏检：" + JSON.stringify(diagnoseChapterSymptoms(text, null)));
});

test("⑧ 真物象（杯沿）仍然打断游程（豁免层没把真信号一起挡掉）", () => {
  const lines = BARE_WITH_EMPTY_WORD.slice();
  lines[3] = "“胡说！”他摩挲着杯沿，道。";
  const text = lines.join("\n");
  assert.ok(maxBareDialogueRun(text).run < 7, "有器物接触的旁白不该算裸台词");
  assert.ok(!keysOf(diagnoseChapterSymptoms(text, null)).includes("bare_dialogue"));
});

// ── ⑨ 章末升华：按段定位 + 末段已合格不报 ───────────────────────────────────

test("⑨ 第 1 行有「但他不知道」、末段停在「夜色渐深。」→ 不得报 ending_preach", () => {
  // 旧行为：读 scanSlop 的**全章** ending_preach，第 1 行的「但他不知道」被算到末段头上 → 误报。
  // v7.3.1 修（#40）：无空行的短章（内容行 ≤4）现在按 slop 口径视作**整章同一末段**（见下一个用例）；
  // 要验「首行套话不能串台到末段」，这里用 >4 行内容（末段 = 最后 2 行内容行），与 slop.endingLineSet 一致。
  const text = "但他不知道，客栈来了怪人。\n他推开木门拿起茶杯。\n他把外衣挂到墙上。\n灶火还温着。\n夜色渐深。";
  const got = diagnoseChapterSymptoms(text, null);
  assert.ok(!keysOf(got).includes("ending_preach"), "全章套话串台到末段了：" + JSON.stringify(got));
});

// v7.3.1 修（#40）：无空行且内容行 ≤4 的短章，slop 会把整章视作同一末段（其注释明说“短片段仍视作同一末段”），
// chapter-diagnose 的取段必须同口径——否则这类短章的 ending_preach 永远漏报。
test("⑨ 无空行短章（内容行 ≤4）：整章视作末段，首行的章末预告必须报出来（与 slop 同口径）", () => {
  const text = "但他不知道，客栈来了怪人。\n他推开木门拿起茶杯。\n夜色渐深。";
  assert.ok(keysOf(diagnoseChapterSymptoms(text, null)).includes("ending_preach"),
    "≤4 行无空行短章的章末预告漏报（取段口径与 slop 不一致）：" + JSON.stringify(diagnoseChapterSymptoms(text, null)));
});

test("⑨ 末段换成真升华句 → 必须报 ending_preach", () => {
  const text = "但他不知道，客栈来了怪人。\n他望着远方的夜空，深知这条路才刚刚开始。";
  const got = diagnoseChapterSymptoms(text, null);
  assert.ok(keysOf(got).includes("ending_preach"), "真升华句漏报：" + JSON.stringify(got));
});

test("⑨ 空行分段时末段的套话仍按段定位（多行段落也一样）", () => {
  const text = "他推开门，抓起长刀。\n\n多年以后，他才明白那一天的意义。";
  assert.ok(keysOf(diagnoseChapterSymptoms(text, null)).includes("ending_preach"), "末段的「多年以后」漏报");
  // 反过来：末段是具体动作，前一段才是预告 → 末段已经合格，不报
  const okText = "多年以后，他才明白那一天的意义。\n\n他推开门，抓起长刀，冲进雨里。";
  assert.ok(!keysOf(diagnoseChapterSymptoms(okText, null)).includes("ending_preach"), "末段已停在动作上不该报");
});

// ── ⑩ 感官通道单一：次数 p10 换成千字密度 ──────────────────────────────────

/** 900 字、触觉 0 次的中性正文（≥600 字，过章长门控） */
const SENSE_NEUTRAL = "他走到窗边，看了一眼院里的树。".repeat(60);

/** 只判触觉通道：其余四个通道分位全 0（allQuantilesZero → 跳过，避免互相干扰） */
const SENSE_REF_TACTILE_ZERO_P10 = {
  ...REF_STATS,
  senseChannels: {
    visual: { p10: 0, p50: 0, p85: 0, p95: 0 },
    auditory: { p10: 0, p50: 0, p85: 0, p95: 0 },
    tactile: { p10: 0, p50: 1, p85: 2, p95: 3 },
    olfactory: { p10: 0, p50: 0, p85: 0, p95: 0 },
    temperature: { p10: 0, p50: 0, p85: 0, p95: 0 }
  }
};

test("⑩ 参照集 tactile.p10=0 且本章触觉 0 次（≥600 字）→ 必须报 sense_mono", () => {
  assert.ok(SENSE_NEUTRAL.length >= 600, "测试正文必须 ≥ 600 字：" + SENSE_NEUTRAL.length);
  const got = diagnoseChapterSymptoms(SENSE_NEUTRAL, SENSE_REF_TACTILE_ZERO_P10);
  // 旧行为：`hits < summary.p10` → 0 < 0 恒为 false，触觉/嗅觉/温度三个通道永不触发。
  assert.ok(keysOf(got).includes("sense_mono"), "p10=0 时永不触发的旧行为仍在：" + JSON.stringify(got));
  const item = got.find((symptom) => symptom.key === "sense_mono");
  assert.ok(item.detail.includes("触觉"), "点名的应是触觉通道：" + item.detail);
});

test("⑩ 本章触觉命中 5 次 → 不得报 sense_mono", () => {
  const text = SENSE_NEUTRAL + "石面湿冷，掌心发麻。".repeat(3);
  assert.ok(!keysOf(diagnoseChapterSymptoms(text, SENSE_REF_TACTILE_ZERO_P10)).includes("sense_mono"), "写到了的通道不该点名");
});

test("⑩ 本章不足 600 字时不做感官点名（样本不足，宁可少报）", () => {
  const short = "他走到窗边，看了一眼院里的树。";
  assert.ok(!keysOf(diagnoseChapterSymptoms(short, SENSE_REF_TACTILE_ZERO_P10)).includes("sense_mono"));
});

test("⑩ 知道参照集章长时按千字密度比较（万字参照集不误伤短章）", () => {
  // 参照集 p10 = 5 次 / 万字 = 0.5 次/千字地板
  const refLong = {
    ...SENSE_REF_TACTILE_ZERO_P10,
    avgChars: 10000,
    senseChannels: {
      ...SENSE_REF_TACTILE_ZERO_P10.senseChannels,
      tactile: { p10: 5, p50: 8, p85: 12, p95: 20 }
    }
  };
  // 本章 ~900 字、触觉 1 次 ≈ 1.1 次/千字 ≥ 0.5 → 不报（旧行为 `hits < p10` 即 1 < 5 会误报）
  const withOne = SENSE_NEUTRAL + "指尖碰到湿漉漉的石面。";
  assert.ok(!keysOf(diagnoseChapterSymptoms(withOne, refLong)).includes("sense_mono"), "按次数比会误伤短章，密度比不会");
  // 同一条地板：0 次触觉 → 0 < 0.5 → 报
  assert.ok(keysOf(diagnoseChapterSymptoms(SENSE_NEUTRAL, refLong)).includes("sense_mono"), "0 次触觉应低于密度地板");
});

// ── ⑫ 感官通道单一：p10=0 时的话术不得自相矛盾 ──────────────────────────────

test("⑫ 参照集 p10=0 且本章 0 次 → 不得输出「低于参照集 p10（0 次）」", () => {
  const got = diagnoseChapterSymptoms(SENSE_NEUTRAL, SENSE_REF_TACTILE_ZERO_P10);
  const item = got.find((symptom) => symptom.key === "sense_mono");
  assert.ok(item, "p10=0 且 0 次仍应触发（现有 ⑩ 的行为保留）");
  // 旧行为：「仅 0 次，低于参照集 p10（0 次）」——0 次怎么可能低于 0 次
  assert.equal(item.detail.includes("低于"), false, "p10=0 时不该说「低于」：" + item.detail);
  assert.ok(!(item.detail.includes("低于") && item.detail.includes("0 次）")), "出现矛盾句：" + item.detail);
  assert.ok(item.detail.includes("触觉"), "仍须点名通道：" + item.detail);
  assert.ok(/未使用|也是 0/.test(item.detail), "应使用 p10=0 的独立话术：" + item.detail);
  assert.ok(item.detail.length <= 60, "detail 必须 ≤ 60 字：" + item.detail);
});

// ── ⑥ 空值安全 ──────────────────────────────────────────────────────────────

test("⑥ 空值 / 脏输入不抛错", () => {
  assert.deepEqual(diagnoseChapterSymptoms("", null), []);
  assert.doesNotThrow(() => diagnoseChapterSymptoms(undefined, undefined));
  assert.doesNotThrow(() => diagnoseChapterSymptoms(null, "not-an-object"));
  assert.deepEqual(diagnoseChapterSymptoms("   \n\n  ", null), []);
  assert.deepEqual(checkPlanFulfillment(undefined, undefined), { qualified: false, unfulfilled: [], checked: 0 });
  assert.deepEqual(checkPlanFulfillment("", ""), { qualified: false, unfulfilled: [], checked: 0 });
  assert.deepEqual(maxBareDialogueRun(undefined), { run: 0, from: 0, to: 0 });
  assert.deepEqual(maxBareDialogueRun(""), { run: 0, from: 0, to: 0 });
});

test("⑪ 套话症状按最高频类别给出对应短提示，且支持 slopOpts 豁免", () => {
  const fillerHeavy = "就在此时，他推开门。与此同时，风吹进来。下一秒，灯灭了。不知过了多久，雨停了。转眼间，天亮了。";
  const got = diagnoseChapterSymptoms(fillerHeavy, null);
  const slopItem = got.find((x) => x.key === "slop");
  assert.ok(slopItem, "应检出 slop 症状");
  assert.ok(slopItem.detail.includes("时间过渡"), "应指向转折灌水类提示：" + slopItem.detail);
  assert.ok(slopItem.detail.length <= 60, "detail 不得超过 60 字");

  const muted = diagnoseChapterSymptoms(fillerHeavy, null, { muteCategories: ["filler_transition"] });
  assert.ok(!keysOf(muted).includes("slop"), "被静音类别后不应再报 slop");
});