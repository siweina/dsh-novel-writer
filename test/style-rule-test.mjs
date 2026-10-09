// v6.4.0 回归测试：世界观用语规范的「单一裁决点」与中式语用渗透防线
//
// 起因：用户在**欧式/中世纪**设定下写作，AI 却写出「掌柜」「多谢提点」这类中式市井/客套词。
// 复核确认代码侧有 6 处独立断点，本测试逐条钉住修复后的行为：
//   ① speechStyle 只被审计用、从不进模型      → 断言开写包渲染文本里有语用规范
//   ② 开写包禁词无默认表兜底                  → 断言只登记 basis（不填 bannedWords）时模型能看到默认表词
//   ③ 登记 bannedWords 就整份丢弃默认表        → 断言用户登记后默认表仍被合并
//   ④ 禁词被截断到前 10 条                     → 断言渲染里可见的禁词数 > 10
//   ⑤ chapter 模式跳过用语扫描                 → 断言 chapter 模式也返回本章用语命中
//   ⑥ lexicon audit 与禁词无关                 → 断言 audit 文案明确划出职责边界
// 另有未登记 worldview 时的「循环陷阱」（中式渗透词本身成了判定中式基准的证据）→ 断言它被显式提示。
//
// 本测试**直接断言 output.render() 的产物**——那是"发给模型的真实文本"，
// 而不是只看内部字段（字段对了但没渲染出去，正是本次 bug 的形态）。

import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";
import { resolveStyleRule } from "../lib/core.js";
import { DEFAULT_BANNED_WORDS } from "../lib/lexicons/markers.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = join(tmpdir(), "dsh-novel-writer-style-rule-" + process.pid + "-" + Date.now().toString(36));
process.env.DSH_NOVEL_WRITER_STATE = join(testRoot, "state-test.json");
process.on("exit", () => {
  try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
});
rmSync(testRoot, { recursive: true, force: true });

let pass = 0;
const failures = [];
function ok(name, cond, extra = "") {
  if (cond) { pass += 1; return; }
  failures.push(name + (extra ? "  [" + extra + "]" : ""));
}

// ---------- 夹具：一本欧式设定的书，正文里混入报告里的中式语用渗透 ----------
const BOOK = "王国纪事";
const DIR = join(testRoot, "novels", BOOK);
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, "第01章.md"),
  "# 第一章 渡鸦旅店\n\n雨敲在窗棂上。艾德里安推开旅店的门，壁炉的火光在他铠甲的划痕上跳了一下。\n\n" +
  "“住店？”掌柜抬起头，把一盏灯推过来，“这样的夜里，没人赶路。”\n\n" +
  "艾德里安道了谢，又问了往北的路。多谢提点，他说。\n\n神甫在角落念着祷词，桌上的蜡烛烧到一半。\n", "utf8");
writeFileSync(join(DIR, "第02章.md"),
  "# 第二章 北境\n\n雪原上没有路标。骑士把缰绳交给侍从，自己走上城堡的台阶。\n\n" +
  "“掌柜的说过，往北三十里有个村子。”随从低声说。\n\n教堂的钟敲了七下。\n", "utf8");

// ---------- 未登记 worldview 的书（验证「循环陷阱」提示）----------
const BOOK2 = "无登记之书";
const DIR2 = join(testRoot, "novels", BOOK2);
mkdirSync(DIR2, { recursive: true });
writeFileSync(join(DIR2, "第01章.md"), "# 第一章\n\n掌柜迎上来，唤伙计添茶。衙门的人来过了。\n", "utf8");

const registry = [];
const ctx = {
  tools: { register: (d) => { registry.push(d); return () => {}; } },
  systemPrompt: { section: () => () => {} },
  inject: (names, cb) => cb({ webServer: { register: () => () => {} }, effect: (fn) => fn() }),
};
apply(ctx, { root: testRoot, sentenceAnalysis: { enabled: false }, allowLanState: false });
const defs = Object.fromEntries(registry.map((d) => [d.name, d]));
const exec = { agent: { session: { header: { cwd: testRoot } } } };

const textOf = (def, args, value) => (def.output.render(args, value) || []).map((x) => x.text ?? "").join("\n");

// ---------- 1) 只登记 basis（不填 bannedWords）→ 默认表必须自动合并 ----------
await defs.novel_settings.execute({
  book: BOOK, category: "worldview", action: "add",
  name: "王国纪事·欧式基准", basis: "西方/欧式中世纪（95%），剑与魔法",
}, exec);

const rule = resolveStyleRule({ worldview: [{ name: "王国纪事·欧式基准", basis: "西方/欧式中世纪（95%），剑与魔法" }] });
ok("文化基准判为 western", rule.culture === "western", "实际 " + rule.culture);
ok("默认表自动启用", rule.defaultEnabled === true);
ok("合并结果含「掌柜」（★断点②）", rule.bannedWords.includes("掌柜"));
ok("合并结果含默认表全部词",
  DEFAULT_BANNED_WORDS.bannedWords.every((w) => rule.bannedWords.includes(w)),
  `默认 ${DEFAULT_BANNED_WORDS.bannedWords.length} 词 / 合并 ${rule.bannedWords.length} 词`);

// ---------- 2) 开写包：断言「注入载荷」，而不是在整篇渲染里做宽松正则 ----------
//
// ⚠️ 本节的断言写法是**被独立验证打回后重写的**。初版有三条是摆设，实证如下：
//   · `rendered.includes("掌柜")` —— 夹具正文（承接口的上一章结尾、句式骨架）里**本来就有**「掌柜」，
//     所以 v6.3.0 跑同一夹具也通过，把断点② 原样复现（brief 退回 userBannedWords）后**仍然通过**。
//   · `/仪式|语气|点烛|蜡烛/.test(rendered)` —— 由 v6.3.0 就存在的【世界观用语】行满足
//     （那一行拼了 basis + ritual，文本里含"在祭坛点蜡烛…禁烧香"），测的是旧行为。
//   · `rule.bannedWords.filter(w => rendered.includes(w)).length > 10` —— 把截断原样恢复后，
//     可见词数仍有 13（散文里的"禁烧香/上香/磕头"凑数），13 > 10 照样通过。
//
// 现在的口径：**只看 avoid 里「禁词」「语用规范·*」两类条目的载荷**——那是唯一的注入通道，
// 整篇渲染里的散文不会再给假通过。
const briefArgs = { book: BOOK, chapter: "next" };
const briefVal = await defs.novel_chapter_brief.execute(briefArgs, exec);
const rendered = textOf(defs.novel_chapter_brief, briefArgs, briefVal);
const avoidKinds = new Set((briefVal.avoid || []).map((a) => a && a.kind));
// 「禁词」条目里真正展示的词：`世界观禁用词（第 1/4 组，共 69 条）：老夫→我、上香→点烛、…`
const shownText = (briefVal.avoid || []).filter((a) => a && a.kind === "禁词").map((a) => String(a.detail)).join("\n");
const shownWords = shownText.split(/[、：]/).slice(1).map((s) => s.split("→")[0].trim()).filter((w) => w !== "" && !/^第 /.test(w));

ok("开写包渲染出非空文本", rendered.length > 100, `长度 ${rendered.length}`);
ok("★注入通道存在：「禁词」条目已产出", shownWords.length > 0);
ok("★模型能看到「掌柜」（★断点②：默认表自动并入注入载荷）", shownWords.includes("掌柜"),
  "注入的词：" + shownWords.length + " 个，含掌柜=" + shownWords.includes("掌柜"));
ok("★注入载荷覆盖默认表全部词（★断点②）",
  DEFAULT_BANNED_WORDS.bannedWords.every((w) => shownWords.includes(w)),
  `默认 ${DEFAULT_BANNED_WORDS.bannedWords.length} 词 / 注入 ${shownWords.length} 词 / 缺 ` +
  DEFAULT_BANNED_WORDS.bannedWords.filter((w) => !shownWords.includes(w)).join("、"));
ok("★语用规范四类进了注入载荷（★断点①：speechStyle 到得了模型）",
  ["语用规范·称谓", "语用规范·客套", "语用规范·仪式", "语用规范·语气"].every((k) => avoidKinds.has(k)),
  "实际 kinds：" + [...avoidKinds].join("、"));
ok("★语用禁词「提点」在注入载荷里（★断点①）",
  (briefVal.avoid || []).some((a) => a.kind === "语用规范·客套" && String(a.detail).includes("提点")));
ok("★禁词条目数与裁决结果**逐词相等**（★断点④：截断已取消）",
  shownWords.length === rule.bannedWords.length && new Set(shownWords).size === shownWords.length,
  `注入 ${shownWords.length} / 裁决 ${rule.bannedWords.length}`);
ok("★checklist 点名要求遵守语用规范（独立验证的 M6 变异曾在此处零失败）",
  JSON.stringify(briefVal.plan?.checklist ?? []).includes("语用规范"));

// ---------- 3) 词源一致性：展示的词必须全部来自裁决结果（无自造词源）----------
// ⚠️ 不要用 rendered.replace(bannedWords.join("|"), "") 来"挖掉"已知词：String.replace(字符串,…)
//    只替换第一处，残留会让断言恒假（本测试初版即因此误报）。
ok("展示的词全部属于裁决结果（无自造词源）",
  shownWords.every((w) => rule.bannedWords.includes(w)),
  "越界：" + shownWords.filter((w) => !rule.bannedWords.includes(w)).join("、"));

// ---------- 4) 用户显式登记 bannedWords → 默认表仍须合并（★断点③ 的回归点）----------
const r2 = resolveStyleRule({ worldview: [{ name: "x", basis: "欧式中世纪", bannedWords: ["老爷"] }] });
ok("用户词保留", r2.bannedWords.includes("老爷"));
ok("★用户登记后默认表不再被丢弃（★断点③）", r2.bannedWords.includes("掌柜"));
ok("总数 = 用户 1 + 默认全表", r2.bannedWords.length === DEFAULT_BANNED_WORDS.bannedWords.length + 1,
  `实际 ${r2.bannedWords.length}`);

// ---------- 5) 显式 bannedWords: [] = 关闭默认表 ----------
const r3 = resolveStyleRule({ worldview: [{ basis: "欧式中世纪", bannedWords: [] }] });
ok("显式空数组关闭默认表", r3.defaultEnabled === false && r3.bannedWords.length === 0);

// ---------- 6) 中式书不得被反向误报（方向守卫）----------
const r4 = resolveStyleRule({}, ["老夫捋着胡须，唤来丫鬟上了三炷香，又吩咐伙计去衙门打点。"]);
ok("中式正文判为 eastern", r4.culture === "eastern", "实际 " + r4.culture);
ok("★中式书禁西式词（方向不反）", r4.bannedWords.includes("教堂"));
ok("★中式书不误报「老夫」「上香」", !r4.bannedWords.includes("老夫") && !r4.bannedWords.includes("上香"));

// ---------- 7) 事后审计：全书模式与章节模式都要能报出禁词 ----------
const auditAll = await defs.novel_continuity_check.execute({ book: BOOK }, exec);
ok("★全书审计报出「掌柜」", JSON.stringify(auditAll).includes("掌柜"));
ok("全书审计报出「提点」（语用规范生效）", JSON.stringify(auditAll).includes("提点"));
ok("全书审计带必查项清单（P1-3）", Array.isArray(auditAll.checklist) && auditAll.checklist.length > 0);

const auditCh = await defs.novel_continuity_check.execute({ book: BOOK, chapter: "第02章" }, exec);
ok("章节模式保留衔接结果", Array.isArray(auditCh.candidates), "action=" + auditCh.action);
ok("★章节模式报出本章禁词（★断点⑤）", JSON.stringify(auditCh).includes("掌柜"));

// ---------- 7b) ★P0-4 的跨消费者一致性（独立验证的 M8 变异曾在此处零失败）----------
//
// 判据：挑一个**只可能来自默认表**的词（铜板——用户没登记、v6.3.0 也不会有），
// 让它在正文里出现一次，然后要求**三个消费方都报出它**：开写包（注入载荷）、
// 连贯性审计（全书 + 章节模式）、**改稿台**（第三个词源，曾是真实缺口）。
// 三处同源才叫「单一裁决点」；只测 core.js 自洽不叫。
const CROSS_WORD = "铜板";
{
  writeFileSync(join(DIR, "第03章.md"),
    "# 第三章 市集\n\n他摸出几枚" + CROSS_WORD + "，放在柜台上。远处的教堂敲了钟。\n", "utf8");
  const r5 = resolveStyleRule({ worldview: [{ name: "王国纪事·欧式基准", basis: "西方/欧式中世纪（95%），剑与魔法" }] });
  ok(`前置：${CROSS_WORD} 确在默认表内（否则本条无鉴别力）`, r5.bannedWords.includes(CROSS_WORD));

  const brief3Args = { book: BOOK, chapter: "第03章" };
  const brief3 = await defs.novel_chapter_brief.execute(brief3Args, exec);
  const shown3 = (brief3.avoid || []).filter((a) => a && a.kind === "禁词").map((a) => String(a.detail)).join("\n");
  ok(`★开写包注入载荷含「${CROSS_WORD}」`, shown3.includes(CROSS_WORD));

  const audit3 = await defs.novel_continuity_check.execute({ book: BOOK }, exec);
  ok(`★全书审计报出「${CROSS_WORD}」（与开写包同源）`, JSON.stringify(audit3).includes(CROSS_WORD));

  const ch3 = await defs.novel_continuity_check.execute({ book: BOOK, chapter: "第03章" }, exec);
  ok(`★章节审计报出「${CROSS_WORD}」（与开写包同源）`, JSON.stringify(ch3).includes(CROSS_WORD));

  // 改稿台：第三个词源（独立验证子代理发现它此前完全没有默认表兜底）
  const fix3 = await defs.novel_fix_plan.execute({ book: BOOK, chapter: "第03章" }, exec);
  ok(`★改稿台报出「${CROSS_WORD}」（第三个消费方也必须同源）`,
    JSON.stringify(fix3).includes(CROSS_WORD),
    "notes=" + JSON.stringify((fix3.notes || []).slice(0, 3)));
}

// ---------- 8) lexicon audit 的职责边界必须出现在**产物**里，而不是源码里 ----------
// ⚠️ 初版是 readFileSync(lib/index.js) + 正则 grep：只要常量定义还在就能骗过它。
//    现在改为断言工具的 description 与真实返回/渲染。
const lexDef = defs.novel_lexicon;
// 判据用「提到了世界观禁用词、且把读者指向 continuity_check」——
// 不要抠具体措辞（初版抠"不含"二字，而实现写的是"毫无关系"，误报）。
ok("★lexicon 的 description 写明了审计边界",
  /必用词表/.test(lexDef.description) && /世界观禁用词/.test(lexDef.description) && /novel_continuity_check/.test(lexDef.description));
{
  const lexOut = await lexDef.execute({ book: BOOK, action: "audit" }, exec);
  const lexBlob = JSON.stringify(lexOut) + textOf(lexDef, { book: BOOK, action: "audit" }, lexOut);
  ok("★lexicon audit 的**产物**里写明了边界并指路 continuity_check",
    /必用词表/.test(lexBlob) && /novel_continuity_check/.test(lexBlob));
}

// ---------- 9) 未登记 worldview 的「循环陷阱」必须被显式提示 ----------
const auditNoReg = await defs.novel_continuity_check.execute({ book: BOOK2 }, exec);
const trap = (auditNoReg.candidates || []).find((c) => c.type === "文化基准存疑");
ok("★未登记时漏网通道变成明确提示", !!trap,
  "实际类型：" + (auditNoReg.candidates || []).map((c) => c.type).join("、"));
if (trap) {
  ok("提示点出被漏掉的中式标记词", /掌柜|伙计|衙门/.test(trap.detail));
  ok("提示给出可执行修法", /novel_settings/.test(trap.detail));
}

// ---------- 结果 ----------
console.log(`用语规范回归: ${pass} 通过 / ${failures.length} 失败`);
if (failures.length > 0) {
  console.error("失败项：");
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log("ALL STYLE-RULE TESTS PASSED");
