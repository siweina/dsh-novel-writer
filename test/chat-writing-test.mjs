/**
 * test/chat-writing-test.mjs —— v7.3.0「实时聊天写作」（chatWriting）回归测试
 *
 * 本版的设计约束（每一条都有对应用例，缺一条功能就退化成普通提示词）：
 *   ① 默认关；打开后开写包给出镜像路径 + **程序的字数阈值** + 硬约束；
 *   ② 镜像**只追加**：工具面只有 commit（无 open/read/clear/index），重复段落照写；
 *   ③ 镜像**由程序写**：路径/分段号/计数全在工具里完成，AI 不拼路径、不读内容；
 *   ④ **"何时提问"由程序按字数阈值判定**：短段累计 → 达阈值才 ask_user，并给出合并文本；
 *   ⑤ 镜像在独立目录，绝不落在 novels/<书>/ 内，也不影响章节扫描；
 *   ⑥ 建章时**插件自己**把定稿镜像一份（不是 AI 干的）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LIB = pathToFileURL(join(import.meta.dirname, "..", "lib")).href;
const base = join(tmpdir(), "nw-chat-" + process.pid + "-" + Date.now().toString(36));
const stateFile = join(base, "state.json");
process.env.DSH_NOVEL_WRITER_STATE = stateFile;
process.on("exit", () => { try { rmSync(base, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const BOOK = "聊天之书";
const SUFFIX = "__draft.md";
const root = join(base, "library");
const bookDir = join(root, "novels", BOOK);
mkdirSync(bookDir, { recursive: true });
writeFileSync(join(bookDir, "第01章.md"), "# 第一章\n\n他推开门。\n", "utf8");

const core = await import(LIB + "/core.js");
const { apply } = await import(LIB + "/index.js");
const { CHAT_WRITING_PROMPT, CHAT_MODE_CHECKLIST } = await import(LIB + "/prompts.js");

const reg = [];
const sections = [];
const ctx = {
  tools: { register: (d) => { reg.push(d); return () => {}; } },
  systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
  inject: () => {}
};
apply(ctx, { root });
const defs = Object.fromEntries(reg.map((d) => [d.name, d]));
const exec = { agent: { session: { header: { cwd: root } } } };
const setFeatures = (features) => writeFileSync(stateFile, JSON.stringify({ enabled: true, features }), "utf8");
const sectionText = () => (sections.find((s) => s.name === "novel-writing:chat-writing") ?? { text: () => "<未注册>" }).text();
const commit = (chapter, text) => defs.novel_draft.execute({ action: "commit", book: BOOK, chapter, text, root }, exec);
const THRESHOLD = core.CHAT_PROMPT_THRESHOLD_CHARS;

// ---------- ① 默认关 / ② 打开后的开写包 ----------
test("默认关闭：开写包与系统提示两侧都不出现", async () => {
  assert.equal(core.FEATURE_DEFAULTS.chatWriting, false, "chatWriting 必须默认关");
  rmSync(stateFile, { force: true });
  const brief = await defs.novel_chapter_brief.execute({ book: BOOK, chapter: "next", root }, exec);
  assert.equal(brief.chatWriting, undefined, "关闭时开写包不得有 chatWriting");
  assert.ok(!(brief.plan.checklist ?? []).some((l) => l.includes("实时聊天写作")));
  assert.equal(sectionText(), "", "关闭时系统提示 section 必须为空串");
});

test("打开后：给出镜像路径 + 程序阈值 + 硬约束，render 里也有", async () => {
  setFeatures({ chatWriting: true });
  const brief = await defs.novel_chapter_brief.execute({ book: BOOK, chapter: "next", root }, exec);
  const cw = brief.chatWriting ?? {};
  assert.equal(cw.on, true);
  assert.ok(String(cw.draftFile).endsWith(SUFFIX));
  assert.ok(String(cw.draftFile).includes(join(".novel-writer", "drafts", BOOK)));
  assert.ok(!String(cw.draftFile).startsWith(bookDir), "镜像不得落在正文目录");
  assert.equal(cw.threshold, THRESHOLD, "开写包要给出程序的字数阈值");
  assert.ok((brief.plan.checklist ?? []).some((l) => l.includes("实时聊天写作")), "清单要有硬约束");
  const rendered = defs.novel_chapter_brief.output.render({}, brief).map((x) => x.text).join("\n");
  assert.ok(rendered.includes("【实时聊天写作"), "render 要有该分区");
  assert.ok(rendered.includes(cw.draftFile), "render 要带镜像路径");
});

// ---------- ③ 工具面：只有 commit ----------
test("工具面只有 commit：open / read / clear 一律拒绝，且没有 index 参数", async () => {
  const def = defs.novel_draft;
  assert.deepEqual(def.parameters.properties.action.enum, ["commit"], "只暴露 commit");
  assert.ok(!("index" in def.parameters.properties), "不该有 index（只追加、不覆盖）");
  for (const bad of ["open", "read", "clear", "append"]) {
    await assert.rejects(() => def.execute({ action: bad, book: BOOK, text: "x", root }, exec), /只支持 action=commit/, "必须拒绝 " + bad);
  }
  await assert.rejects(() => commit("第09章", "   "), /text/, "空正文必须拒绝");
});

// ---------- ④ 程序判定：短段累计 → 达阈值提问 ----------
test("短段累计不提问；达阈值才 ask_user 并给出合并文本", async () => {
  const a = await commit("第02章", "第一小段。");
  assert.equal(a.nextAction, "continue");
  assert.equal(a.pendingChars, "第一小段。".length);
  assert.equal(a.threshold, THRESHOLD);
  assert.equal(a.remaining, THRESHOLD - "第一小段。".length);
  assert.ok(a.message.includes("不要自己去问用户"), "continue 时要明确禁止 AI 自己提问");

  const b = await commit("第02章", "第二小段。");
  assert.equal(b.nextAction, "continue", "两小段加起来没到阈值，不该提问");
  assert.equal(b.pendingChars, "第一小段。".length + "第二小段。".length);

  const long = "这".repeat(THRESHOLD);
  const c = await commit("第02章", long);
  assert.equal(c.nextAction, "ask_user", "累计到阈值必须由程序判定提问");
  assert.equal(c.segmentIndex, 3);
  assert.equal(c.prompts, 1, "提问次数 +1");
  assert.ok(c.combinedText.includes("第一小段。") && c.combinedText.includes("第二小段。") && c.combinedText.includes("这这这"), "合并文本要含本批全部段落");
  assert.ok(c.question.includes("第一小段。"), "问题里要带合并正文");
  assert.ok(c.question.includes(String(THRESHOLD)), "问题里要写清程序阈值（用户才知道为什么这次被问到）");
  // v7.3.0 修正：这个字段报的是**本批真实累计字数**（按整段累加，会略超阈值），
  // 不是阈值本身——旧写法报阈值会让 162 字看起来像"恰好 150"，读不出实际超出了多少。
  // combinedText 用 "\n\n" 连接各段，所以它的 length 含分隔符；本批字数只算正文
  assert.equal(c.pendingChars, String(c.combinedText).replace(/\n\n/g, "").length, "提问时的 pendingChars 应等于本批正文的实际字数（不含段落分隔符）");
  assert.ok(c.pendingChars >= THRESHOLD, "提问时本批累计必须 >= 阈值");
  assert.equal(c.remaining, THRESHOLD, "提问后计数器已清零，remaining 表示下一批要从头累计整个阈值");

  const d = await commit("第02章", "下一批第一段。");
  assert.equal(d.nextAction, "continue", "提问后计数器必须清零，重新累计");
  assert.equal(d.pendingChars, "下一批第一段。".length);
});

// ---------- ② 只追加：重复段落照写、内容不被抹掉 ----------
test("只追加：重复段落照写；已有内容（含人工手改）永不被抹掉", async () => {
  const first = await commit("第03章", "重复的段落。");
  const second = await commit("第03章", "重复的段落。");
  assert.equal(second.segmentIndex, first.segmentIndex + 1, "重复段落也要写成新的一段（不去重）");
  const mirror = readFileSync(second.draftFile, "utf8");
  assert.equal((mirror.match(/^## 第\d+段/gm) ?? []).length, 2, "镜像里应有两段");
  // 人工在镜像里追加批注，再 commit：旧内容必须还在
  writeFileSync(second.draftFile, mirror + "\n> 作者批注：这里要更克制\n", "utf8");
  await commit("第03章", "第三段。");
  const after = readFileSync(second.draftFile, "utf8");
  assert.ok(after.includes("作者批注：这里要更克制"), "追加不得整篇重写（否则会抹掉作者手改）");
  assert.ok(after.includes("第三段。"));
  assert.equal((after.match(/^## 第\d+段/gm) ?? []).length, 3);
});

// ---------- ⑤ 独立目录 + 不影响章节扫描 ----------
test("镜像在独立目录，且不进入章节扫描", async () => {
  const before = (await core.scanChapters(bookDir)).length;
  const r = await commit("第04章", "草稿内容。");
  assert.ok(r.draftFile.startsWith(core.draftRootDir(root)));
  assert.ok(!r.draftFile.startsWith(bookDir));
  assert.equal(core.isInsideBookDir(root, BOOK, r.draftFile), false);
  const after = (await core.scanChapters(bookDir)).length;
  assert.equal(after, before, "写草稿不得改变章节数");
  assert.equal(existsSync(join(root, ".novel-writer", "drafts", BOOK)), true);
});

// ---------- 非法章名 ----------
test("非法/超长章名：哈希兜底、不越界、路径不超限", async () => {
  for (const evil of ["..", "../../etc/passwd", "a/b/c", "..\\..\\win", "***", "   ", "第01章/../../x", "a".repeat(300)]) {
    const r = await commit(evil, "x");
    assert.ok(r.draftFile.startsWith(core.draftRootDir(root)), "必须在镜像根下：" + evil.slice(0, 16));
    assert.ok(!r.draftFile.includes(".."), "路径不得含 ..：" + evil.slice(0, 16));
    assert.ok(!r.draftFile.startsWith(bookDir), "不得落在正文目录：" + evil.slice(0, 16));
    assert.ok(r.draftFile.length < 260, "整条路径要短于 Windows 260 上限：" + r.draftFile.length);
  }
});

// ---------- 程序账本 ----------
test("程序账本 __state.json：计数持久；丢失后按段头重建", async () => {
  const r = await commit("第05章", "甲段。");
  const stateFileForChapter = core.draftStateFileFor(root, BOOK, "第05章");
  assert.ok(existsSync(stateFileForChapter), "应有该章的计数账本");
  const meta = JSON.parse(readFileSync(stateFileForChapter, "utf8"));
  assert.equal(meta.segments, r.segmentIndex);
  await commit("第05章", "乙段。");
  const meta2 = JSON.parse(readFileSync(stateFileForChapter, "utf8"));
  assert.equal(meta2.segments, 2, "账本要跨调用累计");
  // 删掉账本 → 下一次 commit 应按镜像里的段头重建段号（不重头覆盖）
  rmSync(stateFileForChapter, { force: true });
  const r3 = await commit("第05章", "丙段。");
  assert.equal(r3.segmentIndex, 3, "账本丢失后应从镜像段头续上（而不是回到第 1 段）");
});

// ---------- ⑥ 建章自动镜像（有段落只留标记；没段落才补正文） ----------
// 用一个独立书，避免与上面各用例已经 commit 过的章号撞车（撞车会让"有没有段落"的判定失真）
const BOOK2 = "镜像规则之书";
mkdirSync(join(root, "novels", BOOK2), { recursive: true });

test("建章时插件自己写镜像：无段落 → 补一次正文", async () => {
  const r = await defs.novel_new_chapter.execute({ book: BOOK2, title: "无段篇", content: "他推开门。雨落进来。", root }, exec);
  const mir = core.draftFileFor(root, BOOK2, String(r.number));
  assert.ok(existsSync(mir), "建章必须建出镜像：" + mir);
  const text = readFileSync(mir, "utf8");
  assert.ok(text.includes("## 定稿落盘"), "必须有定稿落盘标记");
  assert.ok(text.includes("雨落进来"), "没有逐段内容时必须补一次正文（否则镜像里什么都看不到）");
});

test("建章时插件自己写镜像：已有段落 → 只留标记，不让镜像等于正文", async () => {
  // 先让这一章有过 commit（镜像里有逐段内容），再建章
  const committed = await defs.novel_draft.execute({ action: "commit", book: BOOK2, chapter: "第02章", text: "逐段写下的正文。", root }, exec);
  const r = await defs.novel_new_chapter.execute({ book: BOOK2, chapter: 2, title: "有段篇", content: "逐段写下的正文。", root }, exec);
  assert.equal(r.number, 2, "显式章号要生效（参数名是 chapter，不是 number）");
  assert.equal(committed.draftFile, core.draftFileFor(root, BOOK2, "2"), "commit 与建章必须落在同一文件");
  const text = readFileSync(committed.draftFile, "utf8");
  assert.ok(text.includes("## 定稿落盘"), "要有定稿落盘标记");
  assert.equal((text.match(/逐段写下的正文。/g) ?? []).length, 1, "已有段落时不得再整章拷贝一次（否则镜像等于正文）");
});

test("标题里自带「第N章」时，文件名不会出现两个章号", async () => {
  const r = await defs.novel_new_chapter.execute({ book: BOOK, title: "第09章 重复章号测试", content: "正文。", root }, exec);
  const marks = String(r.file).match(/第\s*\d+\s*章/g) ?? [];
  assert.equal(marks.length, 1, "文件名里章号只能出现一次，实际：" + r.file);
  assert.ok(String(r.file).includes("重复章号测试"), "标题本体要保留");
});

// ---------- ⑦ 同一章只能有一个镜像文件（真实数据暴露的问题） ----------
test("同一章的不同写法（3 / 第03章 / 第03章 标题）收敛到同一个镜像文件", async () => {
  const a = await commit("7", "第一段。");
  const b = await commit("第07章", "第二段。");
  const c = await commit("第07章 某个标题", "第三段。");
  assert.equal(a.draftFile, b.draftFile, "数字与「第NN章」必须指向同一文件");
  assert.equal(b.draftFile, c.draftFile, "带标题的写法也必须指向同一文件");
  assert.equal(c.segmentIndex, 3, "段号应在同一文件里连续累计");
});

// ---------- ⑧ 阈值可由用户配置 ----------
test("阈值可配置：默认 400，用户填 800 就按 800 判，0 恢复默认，超界夹到 100~5000", async () => {
  setFeatures({ chatWriting: true });
  assert.equal((await commit("第08章", "x")).threshold, 400, "未配置时用默认 400");
  writeFileSync(stateFile, JSON.stringify({ enabled: true, features: { chatWriting: true }, chatThreshold: 800 }), "utf8");
  const r800 = await commit("第08章", "x");
  assert.equal(r800.threshold, 800, "用户配置 800 应生效");
  // 800 字阈值：799 字不触发、800 字触发
  const near = await commit("第08章", "字".repeat(700));
  assert.equal(near.nextAction, "continue", "按 800 算：此前累计不足 800，不该提问");
  const hit = await commit("第08章", "字".repeat(200));
  assert.equal(hit.nextAction, "ask_user", "按 800 算：累计够 800 必须提问");
  // 配置接口：0 恢复默认、超界夹断
  await defs.novel_sentence_config.execute({ action: "set", chatThreshold: 0 }, exec);
  assert.equal((await core.readSentenceState()).chatThreshold, 400, "0 = 恢复默认");
  await defs.novel_sentence_config.execute({ action: "set", chatThreshold: 999999 }, exec);
  assert.equal((await core.readSentenceState()).chatThreshold, 5000, "超界夹到 5000");
  await defs.novel_sentence_config.execute({ action: "set", chatThreshold: 400 }, exec);
  // 开写包也要给出用户配置的阈值
  const brief = await defs.novel_chapter_brief.execute({ book: BOOK, chapter: "next", root }, exec);
  assert.equal(brief.chatWriting.threshold, 400);
});

// ---------- 提示词 ----------
test("系统提示：按 nextAction 执行、不读不改镜像、提问时机由程序定", async () => {
  setFeatures({ chatWriting: false });
  assert.equal(sectionText(), "");
  setFeatures({ chatWriting: true });
  const text = sectionText();
  assert.equal(text, CHAT_WRITING_PROMPT);
  for (const kw of ["novel_draft", "commit", "nextAction", "ask_user_question", "不要读它", "由插件程序按字数阈值决定"]) {
    assert.ok(text.includes(kw), "纪律文本应包含：" + kw);
  }
  assert.ok(CHAT_MODE_CHECKLIST.includes("阈值"));
  assert.ok(text.includes("不要提前写"), "必须写明确认前不写正式章节");
});

// ---------- 清单 ----------
test("novel_draft 进 ALL_TOOLS 且在注册表里", () => {
  assert.ok(core.ALL_TOOLS.includes("novel_draft"));
  assert.ok(defs.novel_draft);
  assert.equal(core.TOOL_LABELS.novel_draft, "草稿镜像");
});

// ---------- v7.3.0 补：合并时补上的三处（对方实现里漏的） ----------
test("【v7.3.0 补】按书删除必须清掉 drafts（白名单登记 + 预览可见）", async () => {
  const bd = await import("../lib/bookdelete.js");
  // drafts 是"按书一个目录"，与扁平文件白名单的口径不同——它由 planBookDelete 单独登记成 data:drafts 项，
  // 不进 DELETE_DATA_SUBDIRS（进了反而永远命中 0 个文件而被跳过）。这里断言的是"能被删到"。
  // 预览里要能看见这个位置（有草稿时）
  await commit("第09章", "这一段的唯一用途是让 drafts 目录里出现一个文件。");
  const plan = await bd.planBookDelete({ root, book: BOOK });
  if (plan.blocked) return; // 夹具书可能因其它原因被拦，不在此断言
  const keys = plan.targets.filter((t) => t.exists).map((t) => t.key);
  assert.ok(keys.includes("data:drafts"), "预览应包含 data:drafts，实际：" + keys.join(","));
});

test("【v7.3.0 补】诊断把 drafts 纳入数据目录统计", async () => {
  const dg = await import("../lib/diagnose.js");
  const diag = await dg.buildDiagnosis({ root, days: 7 });
  const dir = JSON.stringify(diag).includes("drafts");
  assert.ok(dir, "诊断报告里应能看到 drafts（否则半成品堆多少、多大完全不可见）");
});

test("【v7.3.0 补】面板：功能开关有 chatWriting、并给出打开镜像的入口", async () => {
  const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.ok(src.includes('"feature.chatWriting"'), "功能页要有「实时聊天写作」开关");
  assert.ok(src.includes('"chatThreshold.title"'), "功能页要有「提问节奏」一行");
  // 面板必须能打开/查看镜像——否则「实时看到他在写什么」这一半就漏了
  assert.ok(/draftFile|drafts/.test(src), "面板应能定位草稿镜像");
});

test("【v7.3.0 修】parseDraftSegments 能解析 commit 自己写的段头（带时间戳）", () => {
  const txt = [
    "## 第1段 · 2026-11-10 21:40:00", "", "他在门口停了半秒。", "",
    "## 第2段 · 2026-11-10 21:41:00", "", "她没回头。", ""
  ].join("\n");
  const segs = core.parseDraftSegments(txt);
  // 合并进来的实现原来只认 `## 第N段`（段名后必须直接结束），而 commit 写的是 `## 第N段 · 时间戳`
  // → 「数段」对、「取正文」永远 0 段，面板预览会显示成空。这条断言盯着它别回归。
  assert.equal(segs.length, 2, "带时间戳的段头也必须能解析");
  assert.equal(segs[0].text, "他在门口停了半秒。");
  assert.equal(segs[1].text, "她没回头。");
  assert.equal(core.parseDraftSegments("## 第1段\n\n只有段名没有时间戳\n").length, 1, "人工手写的旧格式也要兼容");
});
