/**
 * 子串碰撞守卫表（lib/lexicons/guards.js）的双向测试。
 *
 * 这张表的两个失效方向**代价不对称**（见 guards.js 文件头）：
 *   · 漏填 → 多报一条候选，走「待判」档交给模型读上下文（可恢复）；
 *   · 错填 → **静默吃掉真命中**，报告里什么都不说（不可恢复）。
 *
 * 因此本文件把「填写纪律」写成**可执行断言**——这是本套测试存在的理由：
 *
 *   ① 每个边界字/序列都必须有 `evidenceBy`（缺一条就红）——把纪律变成硬约束；
 *   ② 该 evidence 原句必须真的被判为巧合（isGuardedArtifact === true）——证明守卫在挡；
 *   ③ `trueUse`（被删掉的字能造出的真用法反例句）必须**不被挡住**（=== false）
 *      —— 守住「不吃真命中」这个方向；谁把那个字加回表里，本条立刻变红（反向门禁）；
 *   ④ 元测试：扫描全表，凡「有边界字却没有 evidence」的条目 → 失败并逐条列出；
 *   ⑤ 每条守卫都必须有至少一句「该词作真词用」的反例句（TRUE_USAGE），且不被吃掉。
 *
 * 纪律：边界字与 trueUse 的键**互斥**——一个字要么是被实证的碰撞字（填进去），
 * 要么是被真用法否掉的字（写进 trueUse），不能两头都占。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { COLLISION_GUARDS, guardOf } from "../lib/lexicons/guards.js";
import { isGuardedArtifact } from "../lib/core.js";
import { DEFAULT_BANNED_WORDS, EASTERN_MARKER_BANLIST, SPEECH_STYLE_RULES } from "../lib/lexicons/markers.js";

const WORDS = Object.keys(COLLISION_GUARDS);
const LISTS = ["notBefore", "notAfter", "notBeforeSeq", "notAfterSeq"];

/** 词表并集：守卫表里的词必须来自这里（防「凭空造词」）。 */
const ALL_BANNED = new Set([
  ...(DEFAULT_BANNED_WORDS.bannedWords || []),
  ...(SPEECH_STYLE_RULES.western.honorBad || []),
  ...(SPEECH_STYLE_RULES.eastern.honorBad || []),
  ...(EASTERN_MARKER_BANLIST.words || [])
]);

/**
 * 「该词作为真词使用」的反例句。每个守卫词条都必须有一条——
 * 少了它就等于放弃了这一半的测试（守卫吃真命中时不会有人发现）。
 */
const TRUE_USAGE = {
  "里正": ["他当了[里正]三年，村里的事都由他断"],
  "在下": ["[在下]愿闻其详"],
  "大人": ["公爵[大人]请留步"],
  "官人": ["娘子，你[官人]我回来了"],
  "上香": ["他跪在坟前[上香]"],
  "见教": ["不知兄台有何[见教]"],
  "门房": ["那[门房]脸刷地就黑了下来"],
  "老夫": ["这间店铺是[老夫]多年前买下的"],
  "伙计": ["他是店里的[伙计]，手脚麻利"],
  "有劳": ["那就[有劳]先生了"],
  "道士": ["穿道袍的[道士]正在招收弟子"],
  "油条": ["街口的[油条]炸得金黄"],
  "江湖": ["人在[江湖]，身不由己"],
  "小二": ["他是这客栈的[小二]"],
  "保长": ["村里推举他做了[保长]"],
  "小人": ["你这[小人]，竟敢在此搬弄是非"],
  "打尖": ["我们到前面的镇子[打尖]歇脚"],
  "员外": ["城东的[员外]派人送来了贺礼"],
  "神甫": ["那位[神甫]在祭坛前点燃了蜡烛"],
  "修士": ["修道院里的[修士]们正在祈祷"],
  "秀才": ["他考中了[秀才]，光宗耀祖"],
  "铜板": ["他掏出两枚[铜板]放在柜台上"],
  "碎银": ["他把几块[碎银]推了过去"],
  "赏钱": ["老爷[赏钱]倒是从不吝啬"],
  "见笑": ["让诸位[见笑]了"],
  "敝人": ["这位兄弟，[敝人]姓王，初来乍到"],
  "劳烦": ["那就[劳烦]先生了"],
  "捕快": ["几名[捕快]连夜搜查了整条街"]
};

/** 全部边界字/序列（带所属字段与「是否序列」标记）。 */
function boundaries(g) {
  const out = [];
  for (const list of LISTS) {
    for (const key of g[list] || []) out.push({ list, key, isSeq: list.endsWith("Seq") });
  }
  return out;
}

/** 去掉 evidence 里的 [ ] 标记，返回 { line, index }——index 是该词在真实行里的下标。 */
function unmark(marked, word) {
  const at = marked.indexOf("[" + word + "]");
  assert.notEqual(at, -1, "evidence 必须用 [ ] 标出命中处：「" + marked + "」缺 [" + word + "]");
  const shift = (marked.slice(0, at).match(/[[\]]/g) || []).length;
  return { line: marked.replace(/[[\]]/g, ""), index: at - shift };
}

/** 该句（去掉标记后）在该词处是否被判为子串巧合。 */
function guarded(marked, word) {
  const { line, index } = unmark(marked, word);
  return isGuardedArtifact(word, line, index);
}

// ---------------------------------------------------------------------------
// 结构
// ---------------------------------------------------------------------------

test("结构：守卫词条来自真实词表，字段与数据形状合法", () => {
  assert.ok(WORDS.length >= 15, "守卫表条目数异常：" + WORDS.length);
  for (const word of WORDS) {
    const g = guardOf(word);
    assert.ok(ALL_BANNED.has(word), "守卫表的「" + word + "」不在任何禁词/客套词表里（凭空造词？）");
    assert.equal(typeof g.reason, "string");
    assert.ok(g.reason.length > 0, "「" + word + "」缺 reason");

    const bs = boundaries(g);
    assert.ok(bs.length > 0, "「" + word + "」四个字段全空，这条守卫不起任何作用");

    // evidenceBy：逐字/逐序列的实证（本轮新增的数据形状）
    assert.equal(typeof g.evidenceBy, "object", "「" + word + "」缺 evidenceBy（逐字实证）");
    assert.ok(g.evidenceBy !== null && !Array.isArray(g.evidenceBy), "「" + word + "」的 evidenceBy 必须是「字 → 句子数组」的对象");
    for (const [key, sentences] of Object.entries(g.evidenceBy)) {
      assert.ok(typeof key === "string" && key.length > 0, "「" + word + "」的 evidenceBy 含空键");
      assert.ok(Array.isArray(sentences) && sentences.length > 0, "「" + word + "」的 evidenceBy「" + key + "」是空数组");
      for (const ev of sentences) {
        assert.ok(typeof ev === "string" && ev.length > 0, "「" + word + "」的 evidenceBy「" + key + "」含空串");
        assert.ok(ev.includes("[" + word + "]"), "「" + word + "」的 evidenceBy「" + key + "」未用 [ ] 标出命中处：" + ev);
      }
    }

    // trueUse：被真用法否掉的字 → 反例句
    if (g.trueUse !== undefined) {
      assert.ok(g.trueUse !== null && !Array.isArray(g.trueUse) && typeof g.trueUse === "object",
        "「" + word + "」的 trueUse 必须是「字 → 句子数组」的对象");
      for (const [key, sentences] of Object.entries(g.trueUse)) {
        assert.ok(typeof key === "string" && key.length > 0, "「" + word + "」的 trueUse 含空键");
        assert.ok(Array.isArray(sentences) && sentences.length > 0, "「" + word + "」的 trueUse「" + key + "」是空数组");
        for (const s of sentences) {
          assert.ok(typeof s === "string" && s.includes("[" + word + "]"),
            "「" + word + "」的 trueUse「" + key + "」未用 [ ] 标出该词：" + s);
        }
      }
    }

    // 兼容字段 evidence（扁平数组，供 tools/audit/guard-probe.mjs 使用）必须与 evidenceBy 严格一致
    const union = [...new Set(Object.values(g.evidenceBy).flat())];
    assert.deepEqual(g.evidence, union,
      "「" + word + "」的扁平 evidence 与 evidenceBy 的并集不一致（数据漂移）");

    for (const list of ["notBefore", "notAfter"]) {
      if (!Array.isArray(g[list])) continue;
      for (const ch of g[list]) {
        assert.equal(Array.from(ch).length, 1, "「" + word + "」的 " + list + " 必须是**单字**，收到：" + ch);
      }
      assert.equal(new Set(g[list]).size, g[list].length, "「" + word + "」的 " + list + " 有重复项");
    }
    for (const list of ["notBeforeSeq", "notAfterSeq"]) {
      if (!Array.isArray(g[list])) continue;
      for (const seq of g[list]) {
        assert.ok(typeof seq === "string" && seq.length > 0, "「" + word + "」的 " + list + " 含空串");
      }
      assert.equal(new Set(g[list]).size, g[list].length, "「" + word + "」的 " + list + " 有重复项");
    }
  }
});

// ---------------------------------------------------------------------------
// ① 每个边界字/序列都有实证，且该实证原句真的被挡住
// ---------------------------------------------------------------------------

test("① 巧合被挡：每个边界字/序列的 evidenceBy 原句都判为子串巧合", () => {
  const missing = [];
  for (const word of WORDS) {
    const g = guardOf(word);
    for (const b of boundaries(g)) {
      const sentences = g.evidenceBy?.[b.key];
      if (!Array.isArray(sentences) || sentences.length === 0) {
        missing.push(word + " ← " + b.list + "「" + b.key + "」");
        continue;
      }
      for (const ev of sentences) {
        assert.equal(guarded(ev, word), true,
          "「" + word + "」的边界「" + b.key + "」没被守卫挡住（evidence 与守卫表不一致）：" + ev);
      }
    }
  }
  assert.deepEqual(missing, [],
    "这些边界字/序列没有 evidence（填写纪律：举不出实证就删掉）：\n  " + missing.join("\n  "));
});

// ---------------------------------------------------------------------------
// ② 反向门禁：trueUse 反例句（被删掉的字）必须不被吃掉
// ---------------------------------------------------------------------------

test("② 真命中不被吃掉：trueUse 反例句与每词一句真用法都不得被判为巧合", () => {
  for (const word of WORDS) {
    const g = guardOf(word);
    const rejectedKeys = Object.keys(g.trueUse || {});
    for (const key of rejectedKeys) {
      const filled = boundaries(g).some((b) => b.key === key);
      assert.equal(filled, false,
        "「" + word + "」的「" + key + "」既填进了边界表又写进了 trueUse——两者互斥（要么是碰撞字，要么被真用法否掉）");
      for (const marked of g.trueUse[key]) {
        assert.equal(guarded(marked, word), false,
          "「" + word + "」被删掉的字「" + key + "」把真用法吃掉了：" + marked);
        // 同一句里该词出现多次时，每一处都必须不被吃掉
        const { line } = unmark(marked, word);
        let from = 0;
        for (;;) {
          const at = line.indexOf(word, from);
          if (at < 0) break;
          assert.equal(isGuardedArtifact(word, line, at), false,
            "「" + word + "」的真用法第 " + (at + 1) + " 字处被守卫吃掉：" + line);
          from = at + word.length;
        }
      }
    }
  }
});

test("② 补充：每个守卫词条都有一句「该词作真词用」的反例句，且不被吃掉", () => {
  for (const word of WORDS) {
    const sentences = TRUE_USAGE[word];
    assert.ok(Array.isArray(sentences) && sentences.length > 0,
      "「" + word + "」缺「真词使用」反例句——请补进 TRUE_USAGE（否则这一半没有测试）");
    for (const marked of sentences) {
      assert.equal(guarded(marked, word), false, "「" + word + "」的真用法被守卫吃掉了：" + marked);
      const { line } = unmark(marked, word);
      let from = 0;
      for (;;) {
        const at = line.indexOf(word, from);
        if (at < 0) break;
        assert.equal(isGuardedArtifact(word, line, at), false,
          "「" + word + "」的真用法第 " + (at + 1) + " 字处被守卫吃掉：" + line);
        from = at + word.length;
      }
    }
  }
  for (const word of Object.keys(TRUE_USAGE)) {
    assert.ok(WORDS.includes(word), "TRUE_USAGE 里的「" + word + "」已不在守卫表中");
  }
});

// ---------------------------------------------------------------------------
// ③ 元测试：数据自洽（有边界字没实证 / 有僵尸键）一律失败
// ---------------------------------------------------------------------------

test("③ 元测试：凡「有边界字/序列却缺 evidenceBy」的条目一律失败并列出", () => {
  const broken = [];
  const stale = [];
  for (const word of WORDS) {
    const g = guardOf(word);
    const bs = boundaries(g);
    const keys = new Set(bs.map((b) => b.key));
    for (const b of bs) {
      const sentences = g.evidenceBy?.[b.key];
      if (!Array.isArray(sentences) || sentences.length === 0) broken.push(word + " :: " + b.list + "「" + b.key + "」");
    }
    for (const key of Object.keys(g.evidenceBy || {})) {
      if (!keys.has(key)) stale.push(word + " :: evidenceBy「" + key + "」不在 notBefore/notAfter/Seq 里（僵尸键）");
    }
    for (const key of Object.keys(g.trueUse || {})) {
      if (keys.has(key)) stale.push(word + " :: trueUse「" + key + "」同时出现在边界表里（互斥被破坏）");
    }
  }
  assert.deepEqual(broken, [], "有边界字却没有 evidence（纪律：举不出实证就删掉）：\n  " + broken.join("\n  "));
  assert.deepEqual(stale, [], "守卫表存在僵尸/冲突键：\n  " + stale.join("\n  "));
});

test("③ 元测试：守卫确实在挡（每条起码挡住自己的一条 evidence），且表整体有效", () => {
  let totalBoundaries = 0;
  let totalRejected = 0;
  for (const word of WORDS) {
    const g = guardOf(word);
    totalBoundaries += boundaries(g).length;
    totalRejected += Object.keys(g.trueUse || {}).length;
    // 至少一条 evidence 真的被挡住（不是空表混进来源）
    const any = boundaries(g).some((b) => (g.evidenceBy[b.key] || []).some((ev) => guarded(ev, word) === true));
    assert.equal(any, true, "「" + word + "」的守卫一条 evidence 都没挡住");
  }
  assert.ok(totalBoundaries >= 30, "边界字/序列总数异常偏少：" + totalBoundaries);
  assert.ok(totalRejected >= 20, "被真用法否掉的字太少（trueUse 记录不足）：" + totalRejected);
});

// ---------------------------------------------------------------------------
// ④ 具体判例（含 test/false-positive-test.mjs 里被钉死的现场）
// ---------------------------------------------------------------------------

test("④ 具体判例：任务点名的正反例与序列判定", () => {
  const at = (word, line) => isGuardedArtifact(word, line, line.indexOf(word));
  // 必须挡住（碰撞）
  assert.equal(at("里正", "前一世，这里正是刺客们选择的狙击地点。"), true);
  assert.equal(at("里正", "别看他平日里正人君子的模样。"), true);
  assert.equal(at("在下", "大雨还在下着。"), true);
  assert.equal(at("在下", "他在下面的地窖里点了灯。"), true);
  assert.equal(at("大人", "他不是什么大人物。"), true);
  assert.equal(at("官人", "即使是文官人才也必须宣誓。"), true);
  assert.equal(at("老夫", "他们是一对老夫老妻了。"), true);
  assert.equal(at("道士", "他知道士兵们已经疲惫。"), true);
  assert.equal(at("小二", "把图纸缩小二倍。"), true);
  assert.equal(at("江湖", "这批丝绸来自浙江湖州。"), true);
  assert.equal(at("见教", "他看见教头将信收好。"), true);
  assert.equal(at("保长", "必须确保长期供应不断。"), true);
  assert.equal(at("有劳", "所有劳动都应当得到报偿。"), true);
  assert.equal(at("门房", "这是一间专门房间，用来存放旧档案。"), true);
  assert.equal(at("伙计", "他递上了合伙计划书。"), true);
  assert.equal(at("油条", "议会通过了新的石油条例。"), true);

  // 必须**不**挡（真用法；错填守卫会静默漏报）
  assert.equal(at("里正", "他当了里正三年，村里人都认得他。"), false);
  assert.equal(at("里正", "昨日里正来收租，村里人躲着不见。"), false);
  assert.equal(at("在下", "在下愿闻其详。"), false);
  assert.equal(at("在下", "在下前几日曾在贵府叨扰。"), false);
  assert.equal(at("在下", "在下于此地住了三年。"), false);
  assert.equal(at("在下", "在下内人身子不适，先行告退。"), false);
  assert.equal(at("大人", "请大人多担待，此事容后再议。"), false);
  assert.equal(at("大人", "大人会替我们做主的，你且宽心。"), false);
  assert.equal(at("官人", "娘子，官人才回来，快歇歇罢。"), false);
  assert.equal(at("官人", "官人手冷，妾身给你暖暖。"), false);
  assert.equal(at("官人", "官人们请留步，容小的通传。"), false);
  assert.equal(at("老夫", "老夫人生地不熟，还望多多照拂。"), false);
  assert.equal(at("老夫", "老夫老矣不能披甲。"), false);
  assert.equal(at("江湖", "他年轻时走过江湖，见过血。"), false);
  assert.equal(at("道士", "此地道士众多，香火也旺。"), false);
  // 整条被移除的守卫：唯一候选字两侧都成立（诸神|圣器、科[举]行于隋唐）→ 不再挡，走待判档
  assert.equal(at("科举", "各科举行了一次成果展。"), false);
  assert.equal(at("圣器", "祭坛上摆满了神圣器皿与烛台。"), false);
  assert.equal(at("上香", "一早上香的人络绎不绝。"), false);
  assert.equal(at("油条", "老板，再加油条两根。"), false);
  assert.equal(at("碎银", "袋里只剩些破碎银子。"), false);
  assert.equal(at("见教", "若有不妥之处，还望见教。"), false);

  // 无守卫的词 / 非法入参：一律不挡
  assert.equal(at("先生", "学生先走了。"), false);
  assert.equal(isGuardedArtifact("里正", "里正", -1), false);
  assert.equal(isGuardedArtifact("里正", null, 0), false);
  assert.equal(isGuardedArtifact("里正", "里正", undefined), false);
});

test("④ 序列守卫：notBeforeSeq「平日」只吃「平日里正」，不吃「昨日里正」", () => {
  const a = "别看他平日里正人君子的模样。";
  assert.equal(isGuardedArtifact("里正", a, a.indexOf("里正")), true);
  const b = "昨日里正来收租。";
  assert.equal(isGuardedArtifact("里正", b, b.indexOf("里正")), false);
  // 序列守卫的数据形状：键是序列而不是单字
  const g = guardOf("里正");
  assert.deepEqual(g.notBeforeSeq, ["平日"]);
  assert.equal(Array.from(g.notBefore).some((c) => c === "日"), false,
    "单字「日」会把「昨日[里正]」一起吃掉——必须走 notBeforeSeq「平日」");
});
