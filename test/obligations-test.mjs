/**
 * 大纲子句义务（lib/obligations.js）的测试 —— v7.0.0
 *
 * 这套测试只锁三件事，因为模块本身就只承诺三件事：
 *   ① 切分是**确定性**的（标点/箭头/换行/连词四条路径，顺序与条数都对得上）；
 *   ② 归类是**末位动词优先**的（连动句必须以最后那个动词为准，否则整条义务会指错方向）；
 *   ③ 渲染材料是**格式约束**而不是问句（只要求"器物/动作/落点"三个要素，不给现成问句）。
 * 另外锁空值安全与幂等：开写包会在材料缺失时把空参数递进来，这里抛错会连累整条开写链路。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUSE_CATEGORIES,
  CLAUSE_FRAME_FORMAT,
  ENDING_GATE_TEXT,
  SINGLE_CLAUSE_STEP_HINT,
  splitOutlineClauses,
  classifyClause,
  buildClauseFrames,
  hasCategory
} from "../lib/obligations.js";

// ---------------------------------------------------------------------------
// 1. 切分
// ---------------------------------------------------------------------------

test("splitOutlineClauses：逗号切分", () => {
  assert.deepEqual(splitOutlineClauses("他去镇上，买了药"), ["他去镇上", "买了药"]);
  assert.deepEqual(splitOutlineClauses("刀，药，请帖"), ["刀", "药", "请帖"]);
});

test("splitOutlineClauses：分号切分", () => {
  assert.deepEqual(splitOutlineClauses("他守在门口；她没有回头"), ["他守在门口", "她没有回头"]);
});

test("splitOutlineClauses：箭头切分（→ 与 -> 两种写法）", () => {
  assert.deepEqual(splitOutlineClauses("埋伏→收网"), ["埋伏", "收网"]);
  assert.deepEqual(splitOutlineClauses("埋伏->收网"), ["埋伏", "收网"]);
});

test("splitOutlineClauses：顿号与换行切分", () => {
  assert.deepEqual(splitOutlineClauses("破门、搜查、对质"), ["破门", "搜查", "对质"]);
  assert.deepEqual(splitOutlineClauses("第一幕：下雨\n第二幕：对峙"), ["第一幕：下雨", "第二幕：对峙"]);
});

test("splitOutlineClauses：无标点长句按连词二次切分", () => {
  // v7.0.0 修正（审查实测）：单字「并 / 又 / 却」不再当切分点——它们大量出现在词内部。
  // 现在只认多字连接词：并且 / 随后 / 接着 / 然后 / 于是 / 不料 / 为了。
  const clauses = splitOutlineClauses("他走进院子随后坐到灯下接着翻了翻账本");
  assert.equal(clauses.length, 3);
  assert.deepEqual(clauses, ["他走进院子", "随后坐到灯下", "接着翻了翻账本"]);
  // 连词在句首时不切（避免切出空段）
  assert.deepEqual(splitOutlineClauses("随后他离开了"), ["随后他离开了"]);
  // 单字连接词撞词内的反例：吞并 / 并州 / 退却 / 并不 —— 一律不许切
  assert.deepEqual(splitOutlineClauses("他吞并了邻镇的地盘"), ["他吞并了邻镇的地盘"]);
  assert.deepEqual(splitOutlineClauses("林风赶往并州"), ["林风赶往并州"]);
  assert.deepEqual(splitOutlineClauses("他退却了半步"), ["他退却了半步"]);
  assert.deepEqual(splitOutlineClauses("他并不想去"), ["他并不想去"]);
});

test("classifyClause：单字言语动词不许被常用词吃掉（v7.0.0 审查反例）", () => {
  // 传说 / 不可思议 曾分别因「说」「议」被判成 talk，导致开写包给出"把这一幕写成对话博弈"的错误格式
  assert.equal(classifyClause("他独自琢磨那个古老传说"), "introspect");
  assert.equal(classifyClause("这简直不可思议"), "introspect");
  assert.equal(classifyClause("他摇头说明来意"), "introspect");
  // 真正的言语动词仍要判对
  assert.equal(classifyClause("他低声问掌柜价钱"), "talk");
  assert.equal(classifyClause("她答应了这门亲事"), "talk");
  assert.equal(classifyClause("他在会上说了两句"), "talk");
});

test("splitOutlineClauses：纯标点与空串返回空数组", () => {
  assert.deepEqual(splitOutlineClauses(""), []);
  assert.deepEqual(splitOutlineClauses("    "), []);
  assert.deepEqual(splitOutlineClauses("，。；、→"), []);
  assert.deepEqual(splitOutlineClauses("\n\n"), []);
});

test("splitOutlineClauses：超过 8 条只留前 8 条", () => {
  const direction = Array.from({ length: 10 }, (_, i) => `第${i + 1}段`).join("，");
  const clauses = splitOutlineClauses(direction);
  assert.equal(clauses.length, 8);
  assert.equal(clauses[0], "第1段");
  assert.equal(clauses[7], "第8段");
  assert.equal(clauses.includes("第9段"), false);
});

// ---------------------------------------------------------------------------
// 2. 归类（连动句取末位）
// ---------------------------------------------------------------------------

test("classifyClause：连动句取最后一个命中的类别", () => {
  assert.equal(classifyClause("林风去黑市买药"), "trade"); // 去(move) → 买(trade)
  assert.equal(classifyClause("他冲进去砍了一刀"), "fight"); // 去(move) → 砍(fight)
  assert.equal(classifyClause("她坐下开始盘算"), "introspect"); // 坐(endure) → 盘算(introspect)
});

test("classifyClause：每类至少一个正例", () => {
  assert.equal(classifyClause("他走进黑市"), "move");
  assert.equal(classifyClause("苏莫在祠堂"), "move"); // 静态位置词算 move
  assert.equal(classifyClause("两人交手三合"), "fight");
  assert.equal(classifyClause("她去当铺典当玉佩"), "trade");
  assert.equal(classifyClause("她看见门口有人"), "discover");
  assert.equal(classifyClause("他压低声音问她"), "talk");
  assert.equal(classifyClause("他咬牙忍着不发一言"), "endure");
  assert.equal(classifyClause("她默默回想那天的对话"), "introspect");
});

test("classifyClause：全不命中 → 兜底 introspect", () => {
  assert.equal(classifyClause("风停了"), "introspect");
  assert.equal(classifyClause("天光渐白"), "introspect");
});

test("classifyClause：非字符串与空串 → 兜底 introspect，不抛错", () => {
  assert.equal(classifyClause(null), "introspect");
  assert.equal(classifyClause(undefined), "introspect");
  assert.equal(classifyClause(42), "introspect");
  assert.equal(classifyClause(""), "introspect");
  assert.equal(classifyClause("   "), "introspect");
});

test("classifyClause：词形豁免——副词/连词里的同形字不算动词", () => {
  assert.equal(classifyClause("现在他明白了"), "introspect"); // "现在"的"在"不算 move
  assert.equal(classifyClause("他立刻转身"), "introspect"); // "立刻"的"立"不算 endure
  assert.equal(classifyClause("他还是没答上来"), "talk"); // "还是"的"还"不算 trade，末位"答"命中
  assert.equal(classifyClause("他把银子还了回去"), "move"); // 这里的"还(hái)"不算 trade，末位"回"命中
});

// ---------------------------------------------------------------------------
// 3. 格式约束
// ---------------------------------------------------------------------------

test("buildClauseFrames：条数与子句数一致", () => {
  const direction = "林风去黑市买药，她看见他在数钱→他转身离开";
  const frames = buildClauseFrames(direction);
  assert.equal(frames.length, splitOutlineClauses(direction).length);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].category, "trade");
  assert.equal(frames[2].category, "move");
});

test("buildClauseFrames：每条 format 含器物/动作/落点三要素，且不是问句", () => {
  const frames = buildClauseFrames("林风去黑市买药；他跪在雪里");
  assert.ok(frames.length > 0);
  for (const frame of frames) {
    assert.ok(frame.format.includes("器物"), `format 缺器物：${frame.format}`);
    assert.ok(frame.format.includes("动作"), `format 缺动作：${frame.format}`);
    assert.ok(frame.format.includes("落点"), `format 缺落点：${frame.format}`);
    assert.equal(frame.format, CLAUSE_FRAME_FORMAT);
    // 格式约束不是问句模板：不带问号
    assert.equal(frame.format.includes("？"), false);
    assert.equal(frame.format.includes("?"), false);
  }
});

test("buildClauseFrames：clause 是原文子串，label 与类别对得上", () => {
  const direction = "林风去黑市买药，她看见他在数钱→他转身离开";
  for (const frame of buildClauseFrames(direction)) {
    assert.equal(typeof frame.clause, "string");
    assert.ok(frame.clause.length > 0);
    assert.ok(direction.includes(frame.clause), `不是原文子串：${frame.clause}`);
    assert.equal(frame.label, CLAUSE_CATEGORIES[frame.category]);
    assert.ok(Object.hasOwn(CLAUSE_CATEGORIES, frame.category));
  }
});

// ---------------------------------------------------------------------------
// 4. 相关性门控
// ---------------------------------------------------------------------------

test("hasCategory：命中与未命中两态", () => {
  const frames = buildClauseFrames("林风去黑市买药，她看见他在数钱→他转身离开");
  assert.equal(hasCategory(frames, "trade"), true);
  assert.equal(hasCategory(frames, "move"), true);
  assert.equal(hasCategory(frames, "fight"), false);
  assert.equal(hasCategory(frames, "endure"), false);
  assert.equal(hasCategory([], "trade"), false);
  assert.equal(hasCategory(null, "trade"), false);
  assert.equal(hasCategory(undefined, "trade"), false);
  assert.equal(hasCategory(frames, "不存在的类别"), false);
});

// ---------------------------------------------------------------------------
// 5. 幂等与空值安全
// ---------------------------------------------------------------------------

test("空值安全：非字符串入参不抛错，返回空数组", () => {
  assert.deepEqual(splitOutlineClauses(null), []);
  assert.deepEqual(splitOutlineClauses(undefined), []);
  assert.deepEqual(splitOutlineClauses(0), []);
  assert.deepEqual(splitOutlineClauses({}), []);
  assert.deepEqual(splitOutlineClauses([]), []);
  assert.deepEqual(buildClauseFrames(undefined), []);
  assert.deepEqual(buildClauseFrames(null), []);
  assert.deepEqual(buildClauseFrames(""), []);
});

test("幂等：同一输入必得同一输出", () => {
  const direction = "他走进院子并关上门随后坐到灯下；林风去黑市买药→她坐下开始盘算";
  assert.deepEqual(splitOutlineClauses(direction), splitOutlineClauses(direction));
  assert.deepEqual(buildClauseFrames(direction), buildClauseFrames(direction));
  assert.deepEqual(classifyClause("林风去黑市买药"), classifyClause("林风去黑市买药"));
});

test("常量：7 个类别、冻结、章末闸门文案完整", () => {
  assert.deepEqual(Object.keys(CLAUSE_CATEGORIES), [
    "move", "fight", "trade", "discover", "talk", "endure", "introspect"
  ]);
  assert.equal(Object.isFrozen(CLAUSE_CATEGORIES), true);
  assert.equal(ENDING_GATE_TEXT.includes("不写总结陈词"), true);
  assert.equal(ENDING_GATE_TEXT.includes("本章必须停在"), true);
  assert.equal(SINGLE_CLAUSE_STEP_HINT.includes("单句大纲请拆成三步"), true);
});

// ---------------------------------------------------------------------------
// 6. 审查修复 #51：单字「答」被「回」豁免后，双字「回答」必须接住
// ---------------------------------------------------------------------------

test("classifyClause：「回答」是言语动词，不得被单字「回」的位移吞掉（#51）", () => {
  // 旧行为：talk 只收「答」，而 LEFT_GUARDS["答"] 把左邻「回」豁免掉；
  // 单字「回」又属于 move → 末位命中 move（"他回答" === "move"）。
  assert.equal(classifyClause("他回答"), "talk");
  assert.equal(classifyClause("他点头回答"), "talk");
  assert.equal(classifyClause("他回答了"), "talk");
  // 反证：真正的位移「回」仍判 move，不能被「回答」顺带改掉
  assert.equal(classifyClause("他回了家"), "move");
  assert.equal(classifyClause("他把银子还了回去"), "move");
});