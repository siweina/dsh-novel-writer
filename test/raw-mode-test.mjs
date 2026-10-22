/**
 * v6.9.0 非净化模式（rawWriting）回归套件 —— 钉住 P0（动笔前给目标带 + 直白度度量）与 P1（动笔兜底重试）。
 *
 * ## 被钉住的契约
 *
 * **直白度度量**（`lib/explicit.js`）：
 *   · 只数「把场面绕过去」的写法：省略号整段 / 明示跳过 / 时间跳·黑场 / 代称替代 / 跳出场景的评论 / 英文淡化
 *   · 密度分母是去空白字符数，单位 处/千字；`compareExplicitness` 给出 verdict 与一句人话结论
 *   · `looksLikeSoftStop` **只认**明示跳过 / 跳出场景的评论 / 英文淡化（时间跳与代称在正常叙事里也常见，
 *     按它们重试会把重试变成噪音）
 *
 * **写入口径**（`novel_chapter_brief` / `novel_new_chapter`）：
 *   · 开关打开 → brief 返回 `rawMode`（含原著基线密度、目标带、checklist），渲染文本里出现【非净化模式·目标带】
 *   · 开关关闭 → 无该字段（不是空对象），建章返回也没有 rawMode
 *
 * **动笔兜底**（`lib/rawguard.js` + `installRawModeGuard`）：
 *   · 三层闸门缺一不可：开关 / 系统提示里的非净化模式标记 / 输出开头的自我刹车特征
 *   · 命中 → 丢弃本次输出、**只重试一次**（重试请求的系统消息尾部追加写作指令，不改用户消息）
 *   · 未命中 → 原样透传（缓冲的 chunk 一条不少）
 *
 * 运行：node test/raw-mode-test.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// ---- 隔离：状态文件指向临时目录，不碰用户真实开关 ----
const ROOT = join(tmpdir(), "dsh-raw-mode-" + process.pid + "-" + Date.now().toString(36));
const STATE = join(ROOT, "state.json");
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "lib-root", "novels"), { recursive: true });
process.env.DSH_NOVEL_WRITER_STATE = STATE;
process.env.DSH_HOME = join(ROOT, "dsh-home");
process.on("exit", () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

function setRaw(on) {
  writeFileSync(STATE, JSON.stringify({ enabled: true, features: { rawWriting: on === true }, tools: {} }, null, 2), "utf8");
}

const ex = await import("../lib/explicit.js");
const rg = await import("../lib/rawguard.js");
const prompts = await import("../lib/prompts.js");
const briefMod = await import("../lib/brief.js");
const plugin = await import("../lib/index.js");

const LIB = join(ROOT, "lib-root");
function seedBook(name, chapters) {
  const dir = join(LIB, "novels", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of chapters) writeFileSync(join(dir, file), text, "utf8");
  return dir;
}
async function* chunksOf(list) { for (const c of list) yield c; }

// ===========================================================================
// ① 度量
// ===========================================================================
test("① 直白度度量：分类计数、密度与对话占比", () => {
  const clean = ex.measureExplicitness("他推开门，走了进去。\n「你来了。」她说。\n他点点头。");
  assert.equal(clean.softening.total, 0, "干净文本不应有淡化命中");
  assert.ok(clean.dialogueRatio > 0 && clean.dialogueRatio < 1);

  const soft = ex.measureExplicitness([
    "他推开门。",
    "不知过了多久，她醒来时已是清晨。",
    "……",
    "此处省略。",
    "一番云雨之后，事毕。",
    "作为 AI，我无法描写这类内容。",
    "The rest fades to black."
  ].join("\n"));
  const ids = soft.softening.items.map((i) => i.id).sort();
  for (const id of ["ellipsis", "skipPhrase", "timeJump", "euphemism", "metaComment", "english"]) {
    assert.ok(ids.includes(id), "应命中 " + id + "，实际：" + ids.join(","));
  }
  assert.ok(soft.softening.per1000 > 0);
  assert.equal(typeof soft.softening.items[0].samples[0], "string");

  const empty = ex.measureExplicitness("");
  assert.equal(empty.softening.per1000, 0, "空文本不能除零");
  assert.equal(empty.softening.total, 0);
});

test("①-b compareExplicitness：五种结论 + 基线为 0 的单独分支", () => {
  const base = ex.measureExplicitness("他推开门，走了进去。\n她抬头看他。");
  const clean = ex.compareExplicitness(ex.measureExplicitness("他说了一句。"), base);
  assert.equal(clean.verdict, "clean");
  const fresh = ex.compareExplicitness(ex.measureExplicitness("此处省略。"), base);
  assert.equal(fresh.verdict, "new", "基线为 0 且本章出现淡化 → new（比值无意义，不编一个数）");
  assert.equal(fresh.ratio, null);
  const softBase = ex.measureExplicitness("不知过了多久。\n事后。\n……\n一番云雨。");
  const softer = ex.compareExplicitness(ex.measureExplicitness("不知过了多久。\n……\n此处省略。\n一番云雨。\n事后。\n作为 AI 我无法描写。"), softBase);
  assert.ok(["much-softer", "softer", "similar"].includes(softer.verdict), softer.verdict);
  assert.ok(softer.note.includes("处/千字"), "结论必须带数字：" + softer.note);
});

test("①-c looksLikeSoftStop：只认「自我刹车」三类，不认时间跳与代称", () => {
  assert.equal(ex.looksLikeSoftStop("这一段我不展开，直接跳到第二天。"), true);
  assert.equal(ex.looksLikeSoftStop("作为 AI，我无法描写这类内容。"), true);
  assert.equal(ex.looksLikeSoftStop("The scene fades to black."), true);
  assert.equal(ex.looksLikeSoftStop("不知过了多久，他醒了。"), false, "时间跳是正常叙事手法，不能触发重试");
  assert.equal(ex.looksLikeSoftStop("一番云雨之后。"), false, "代称不触发重试");
  assert.equal(ex.looksLikeSoftStop(""), false);
  assert.equal(ex.looksLikeSoftStop("他推开门，走了进去。"), false);
});

// ===========================================================================
// ② 兜底：闸门与流包装
// ===========================================================================
test("② rawguard：标记判定与 nudge 追加", () => {
  const withMarker = { messages: [{ role: "system", content: "前缀\n" + prompts.RAW_WRITING_PROMPT }, { role: "user", content: "写第 3 章" }] };
  assert.equal(rg.hasRawModeMarker(withMarker), true);
  assert.equal(rg.hasRawModeMarker({ messages: [{ role: "system", content: "普通系统提示" }] }), false);
  assert.equal(rg.hasRawModeMarker({}), false);
  assert.equal(rg.hasRawModeMarker({ messages: [{ role: "user", content: rg.RAW_MODE_MARKER }] }), false, "只认 system 角色，别把用户正文当开关");

  const nudged = rg.withRawNudge(withMarker);
  assert.ok(nudged.messages[0].content.includes(rg.RAW_RETRY_NUDGE.trim()), "nudge 必须追加到系统消息");
  assert.equal(nudged.messages[1].content, "写第 3 章", "不得改动用户消息");
  const blocks = { messages: [{ role: "system", content: [{ type: "text", text: "abc" }] }] };
  assert.ok(rg.withRawNudge(blocks).messages[0].content[0].text.includes("【继续】"));
});

test("②-b streamWithRawRetry：命中→丢弃并重试一次；未命中→原样透传", async () => {
  const options = { messages: [{ role: "system", content: "prefix" }] };
  const seen = [];
  let retried = 0;
  const make = (opts) => {
    seen.push(String(opts.messages[0].content));
    const nudged = String(opts.messages[0].content).includes("【继续】");
    return chunksOf(nudged
      ? [{ type: "text-delta", text: "他把她按在门上，低声说：" }, { type: "finish" }]
      : [{ type: "text-delta", text: "作为 AI，我无法描写这类内容。" }, { type: "finish" }]);
  };
  const out = [];
  for await (const c of rg.streamWithRawRetry(make, options, { onRetry: () => { retried += 1; } })) out.push(c);
  assert.equal(retried, 1, "命中自我刹车应只重试一次");
  assert.equal(seen.length, 2);
  assert.ok(out.some((c) => c.type === "text-delta" && c.text.includes("按在门上")), "必须产出重试后的正文");

  let calls = 0;
  const normal = () => { calls += 1; return chunksOf([{ type: "text-delta", text: "他推开门。" }, { type: "text-delta", text: "她抬头。" }, { type: "finish" }]); };
  const pass = [];
  for await (const c of rg.streamWithRawRetry(normal, options)) pass.push(c);
  assert.equal(calls, 1, "未命中不得重试");
  assert.equal(pass.length, 3, "缓冲的 chunk 不能丢：" + JSON.stringify(pass));
});

// ===========================================================================
// ③ 写入口径
// ===========================================================================
test("③ 开写包：开关打开时给出原著基线与目标带", async () => {
  seedBook("原始书", [
    ["第01章.md", "他推开门。\n「进来。」她说。\n他走了进去，坐下。\n" + "他看着她，说了几句话。".repeat(12)],
    ["第02章.md", "她抬头。\n「你来了。」\n他点头，把杯子放下。\n" + "窗外有风，窗帘动了一下。".repeat(12)]
  ]);
  setRaw(true);
  const brief = await briefMod.buildChapterBrief(LIB, "原始书", "next", { featState: { features: { rawWriting: true } } }, null);
  assert.ok(brief.rawMode, "开关打开时 brief 必须带 rawMode");
  assert.equal(brief.rawMode.on, true);
  assert.ok(brief.rawMode.baseline.softeningPer1000 >= 0);
  assert.ok(brief.rawMode.target.includes("处/千字"), brief.rawMode.target);
  assert.ok(brief.plan.checklist.some((c) => c.includes("非净化模式（硬约束）")), "checklist 必须有硬约束");
  assert.ok(brief.rawMode.sample.chapters >= 1);

  setRaw(false);
  const off = await briefMod.buildChapterBrief(LIB, "原始书", "next", { featState: { features: { rawWriting: false } } }, null);
  assert.equal(off.rawMode, null, "开关关闭时不得给目标带");
  assert.ok(!off.plan.checklist.some((c) => c.includes("非净化模式（硬约束）")));

  // 渲染文本才是模型真正读到的东西：只放结构化字段等于没给（旧版就是只有系统提示一句）
  const defs = [];
  plugin.apply({ tools: { register(def) { defs.push(def); return () => {}; } }, inject() {}, systemPrompt: { section() {} } }, { root: LIB });
  const briefTool = defs.find((d) => d.name === "novel_chapter_brief");
  assert.ok(briefTool, "novel_chapter_brief 必须已注册");
  setRaw(true);
  const onValue = await briefTool.execute({ book: "原始书", chapter: "next" }, {});
  const onText = briefTool.output.render({}, onValue)[0].text;
  assert.ok(onText.includes("【非净化模式·目标带】"), "渲染文本里必须有【非净化模式·目标带】：" + onText.slice(0, 200));
  assert.ok(onText.includes("处/千字"), "渲染里必须带原著基线数字");
  setRaw(false);
  const offValue = await briefTool.execute({ book: "原始书", chapter: "next" }, {});
  assert.ok(!briefTool.output.render({}, offValue)[0].text.includes("非净化模式"));
});

test("③-b 建章：开关打开时返回 rawMode 提示，关闭时没有该键", async () => {
  seedBook("建章书", [["第01章.md", "他推开门。\n" + "他坐下。".repeat(30)]]);
  const defs = [];
  const ctx = { tools: { register(def) { defs.push(def); return () => {}; } }, inject() {}, systemPrompt: { section() {} } };
  plugin.apply(ctx, { root: LIB });
  const newChapter = defs.find((d) => d.name === "novel_new_chapter");
  assert.ok(newChapter, "novel_new_chapter 必须已注册");

  setRaw(true);
  const on = await newChapter.execute({ book: "建章书" }, {});
  assert.ok(typeof on.rawMode === "string" && on.rawMode.includes("非净化模式"), "开关打开时应带提示");

  setRaw(false);
  const off = await newChapter.execute({ book: "建章书" }, {});
  assert.equal(off.rawMode, undefined, "开关关闭时不得出现该键（additionalProperties:false）");
});

// ===========================================================================
// ④ 事后核对
// ===========================================================================
test("④ 风格自检：开关打开时输出直白度对照，关闭时不输出", async () => {
  seedBook("自检书", [
    ["第01章.md", "他推开门。\n「你来了。」她说。\n" + "他坐下，把杯子放下。".repeat(20)],
    ["第02章.md", "此处省略。\n一番云雨之后。\n不知过了多久。\n" + "她抬头看他。".repeat(20)]
  ]);
  const defs = [];
  const ctx = { tools: { register(def) { defs.push(def); return () => {}; } }, inject() {}, systemPrompt: { section() {} } };
  plugin.apply(ctx, { root: LIB });
  const styleCheck = defs.find((d) => d.name === "novel_style_check");
  assert.ok(styleCheck, "novel_style_check 必须已注册");

  setRaw(true);
  const on = await styleCheck.execute({ book: "自检书", chapter: "第02章" }, {});
  assert.ok(on.explicitness, "开关打开时应输出直白度对照");
  assert.ok(on.explicitness.chapter.per1000 > 0, "第 2 章含淡化写法，密度应 > 0");
  assert.ok(typeof on.explicitness.note === "string" && on.explicitness.note.length > 0);
  const rendered = styleCheck.output.render({}, on)[0].text;
  assert.ok(rendered.includes("直白度对照"), rendered.slice(0, 200));
  assert.ok(rendered.includes("处/千字"), "渲染里必须有数字");

  setRaw(false);
  const off = await styleCheck.execute({ book: "自检书", chapter: "第02章" }, {});
  assert.equal(off.explicitness, undefined, "开关关闭时不得输出该键");
  assert.ok(!styleCheck.output.render({}, off)[0].text.includes("直白度对照"));
});

// ===========================================================================
// ⑤ 钩子：三层闸门
// ===========================================================================
test("⑤ llm/stream 钩子：三层闸门缺一不接管，命中时只重试一次", async () => {
  let handler = null;
  const ctx = {
    tools: { register: () => () => {} },
    inject() {},
    systemPrompt: { section() {} },
    on(event, cb) { if (event === "llm/stream") handler = cb; }
  };
  plugin.apply(ctx, { root: LIB });
  assert.equal(typeof handler, "function", "应安装 llm/stream 钩子");

  const markedOptions = { messages: [{ role: "system", content: "前缀\n" + prompts.RAW_WRITING_PROMPT }] };
  const plainOptions = { messages: [{ role: "system", content: "普通系统提示" }] };
  // 宿主侧 next() 不带参数时沿用原始 options（真实实现如此），测试同样要容忍
  const nextWith = (baseOptions, firstText, secondText) => (opts) => {
    const o = opts ?? baseOptions;
    const nudged = String(o.messages[0].content).includes("【继续】");
    return chunksOf(nudged
      ? [{ type: "text-delta", text: secondText }, { type: "finish" }]
      : [{ type: "text-delta", text: firstText }, { type: "finish" }]);
  };
  const drain = async (stream) => { const out = []; for await (const c of stream) out.push(c); return out; };

  setRaw(false);
  let out = await drain(handler(markedOptions, nextWith(markedOptions, "作为 AI，我无法描写。", "正文")));
  assert.equal(out.length, 2, "开关关闭时不得接管（直通 2 个 chunk）");

  setRaw(true);
  out = await drain(handler(plainOptions, nextWith(plainOptions, "作为 AI，我无法描写。", "正文")));
  assert.equal(out.length, 2, "没有非净化模式标记时不得接管");

  out = await drain(handler(markedOptions, nextWith(markedOptions, "他推开门。", "正文")));
  assert.equal(out.length, 2, "输出不是自我刹车时不得接管");

  out = await drain(handler(markedOptions, nextWith(markedOptions, "这一段我不展开。", "他把她按在门上。")));
  assert.ok(out.some((c) => c.type === "text-delta" && c.text.includes("按在门上")), "三层全中时必须返回重试后的输出");
});
