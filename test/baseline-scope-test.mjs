/**
 * test/baseline-scope-test.mjs —— 风格基线范围「按全书 / 按部分」的契约门禁（v6.5.5）
 *
 * ## 这一套为什么必须存在
 *
 * 本功能把「**拿哪些章当基准**」交给作者（`<root>/.novel-writer/baseline/<书名>.json`
 * 里的 `{mode, chapters}`），修的是「AI 续写越写越像自己、越来越不像原著」的漂移。
 * 它的失效方式**几乎全是静默的**，而且多数比"报错"更糟：
 *
 *   · 目标章没被排除 → 拿自己跟自己比必然"完美符合"，作者以为"没问题"（比不检查更糟）；
 *   · `custom` 退化成"优先 + 不够再补" → 补进来的很可能正是用户想排除的 AI 续写章，
 *     功能目的被抵消，而界面上仍显示"按部分"；
 *   · 选中章全部失效时不回退 → 返回空基线，μ=0 的假基线把"没有基线"伪装成"全都在带内"；
 *   · 只有文案跟着范围走、**μ 仍按全书算** → 报告看起来变了，判定其实没变（最隐蔽的一种）。
 *
 * 因此本文件的分工是：**契约逐条设门禁**，并且**用数字证明范围真的参与了计算**——
 * ⑪ 的对照实验（同一章、同一书，只改范围，μ/偏差值必须改变）是这一套里最重要的一条：
 * 光看文案变了不算数（那只证明了字符串拼接）。
 *
 * ## 断言的鉴别力（自证纪律）
 *
 * 本文件对实现只读不写（`test/**` 之外不动）。两处刻意写窄，避免"绿得没有信息量"：
 *   · 期望的 μ **不写死数字**，而是用与被测实现**同一个公开函数**
 *     （`measureStyleMetrics` + `computeBaselineFromPerChapter`）现算选中章集的 μ，
 *     再与工具输出 deepEqual —— 这直接证明"基线真的只用了那几章"，而不是"数字看着差不多"；
 *   · `all` 模式的旧措辞（`全书除本章外的 N 章`；N==1 时直接给章名）写成硬断言——
 *     有读取方按旧格式解析，改坏它是**回归**。
 *
 * 变异自证（改坏 → 必须变红 → 还原 → 校验哈希）见交付报告；
 * 本文件末尾的「★汇总」会把实测到的契约偏差打印出来（不写成失败断言的原因见那一节）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  BASELINE_SCOPE_MAX_CHAPTERS,
  BASELINE_SCOPE_MODES,
  SMALL_BASELINE_CHAPTERS,
  SMALL_BASELINE_TOL_PCT,
  baselineDir,
  baselineScopeFile,
  normalizeBaselineScope,
  readBaselineScope,
  resolveBaselineScope,
  writeBaselineScope
} from "../lib/core.js";
import { computeBaselineFromPerChapter, measureStyleMetrics } from "../lib/style-metrics.js";
import { apply } from "../lib/index.js";

// ---------------------------------------------------------------------------
// 夹具：临时书库根（绝不碰真实数据）+ 真工具注册表
// ---------------------------------------------------------------------------

const ROOT = join(tmpdir(), "dsh-novel-writer-baseline-scope-" + process.pid + "-" + Date.now().toString(36));
process.env.DSH_NOVEL_WRITER_STATE = join(ROOT, "state-test.json");
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "novels"), { recursive: true });
// 语义引擎在测试里必须**关掉**：它在不在取决于本机模型文件，会让"同一断言"在不同机器上
// 走不同分支（还会引入分钟级耗时）。这里用状态文件把四个语义开关显式置 false。
writeFileSync(process.env.DSH_NOVEL_WRITER_STATE, JSON.stringify({
  enabled: true,
  autoAnalyze: true,
  systemPromptMode: "off",
  tools: {},
  features: { semanticStyle: false, semanticImplicit: false, semanticEmbedding: false, semanticSearch: false }
}), "utf8");
process.on("exit", () => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
});

const registry = [];
const routes = [];
apply({
  tools: { register: (def) => { registry.push(def); return () => {}; } },
  systemPrompt: { section: () => () => {} },
  inject: (names, cb) => cb({
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    effect: (fn) => fn()
  })
}, { root: ROOT, sentenceAnalysis: { enabled: true, autoAnalyze: true }, allowLanState: false });
const defs = Object.fromEntries(registry.map((def) => [def.name, def]));
const exec = { agent: { session: { header: { cwd: ROOT } } } };

/** 观测到的契约偏差：不写成失败断言（原因见文件末尾「★汇总」），但必须被打印出来。 */
const observed = [];

// ── 两族风格截然不同的正文：A = 长句/多修饰/抽象/犹疑；B = 短句/连串动作/无修饰 ──
const A1 = [
  "他似乎在想着那些遥远的、模糊的往事，心里有一种说不出的感觉，仿佛那些记忆本身就带着它自己的温度与重量。",
  "雨大概还要下很久，屋檐下的水痕渐渐地连成了一条细长的线，那样的夜色里，他的思绪隐约飘向了更远的地方。",
  "也许这就是所谓的宿命感，她说的话里带着一种淡淡的、几乎听不见的哀愁。"
].join("\n");
const A2 = A1 + "\n他大概也许似乎想起了什么。";
// A = 长句/多修饰/抽象/犹疑；B = 短句/连串动作/无修饰。B 的每行刻意 ≥40 字——
// buildStyleAnchorPackage 只把「≥40 字的行」当段落候选，若 B 的行太短，B 永远抽不出锚段，
// 「锚段是否跟着范围走」那一条就无从验证（夹具问题会伪装成实现问题）。
const B1 = [
  "他推开门走进去。她抬起头。他把碗放下端起杯子。她伸手接过碗。他转身走向窗边。她跟上去。",
  "风停了。雨掉了。他抓起衣服跑出门。她追到楼梯口。他跳上车冲了出去。她站在原地没动。",
  "她喊了一声。他回头看她。两人对视了很久。她笑了。他也笑了。然后车开走了。她转身回屋关上门。"
].join("\n");

const BOOKS = {
  // 对照实验主用书：1/3 原著风、4/5/6 另一种文风，目标章 2
  "范围书": {
    "第01章.md": A1, "第02章.md": A2, "第03章.md": A1,
    "第04章.md": B1, "第05章.md": B1, "第06章.md": B1
  },
  // 只有 2 章：all 模式下「其他章」恰好 1 章 → 文案应直接给章名（旧格式）
  "两章书": { "第01章.md": A1, "第02章.md": A2 },
  // 选中项里有一章不足 40 字（六维测量会跳过它）→ 检验「选中数 ≠ 真正参与计算的章数」
  "短章书": { "第01章.md": "太短了。", "第02章.md": A1, "第03章.md": A1, "第04章.md": A2 },
  // 按书隔离用：同一批正文，只有甲书配了自定义范围
  "隔离甲": { "第01章.md": A1, "第02章.md": A1, "第03章.md": A1, "第04章.md": B1 },
  "隔离乙": { "第01章.md": A1, "第02章.md": A1, "第03章.md": A1, "第04章.md": B1 },
  // 建章用：与「范围书」同构（含两种文风，否则 all 与 custom 的 μ 会碰巧相同）
  "建章甲": { "第01章.md": A1, "第02章.md": A1, "第03章.md": A1, "第04章.md": B1 },
  "建章乙": { "第01章.md": A1, "第02章.md": A1, "第03章.md": A1, "第04章.md": B1 },
  // 建章锚段用：A 族（1-3）行 ≥40 字能进锚段候选池，B 族（4）只能靠"原文"兜底——
  // 两族的锚段互不重合，才能用内容证明"锚段跟着范围走"
  "建章丙": { "第01章.md": A1, "第02章.md": A1, "第03章.md": A1, "第04章.md": B1 },
  "建章丁": { "第01章.md": A1, "第02章.md": A1, "第03章.md": A1, "第04章.md": B1 }
};
for (const [book, files] of Object.entries(BOOKS)) {
  const dir = join(ROOT, "novels", book);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text + "\n", "utf8");
}
/** 空目录书：书目录存在但没有章节（GET 该 200 + warning，不该 500） */
mkdirSync(join(ROOT, "novels", "空目录书"), { recursive: true });

const bookDirOf = (book) => join(ROOT, "novels", book);
/** 设置/清除本书的基线范围（写盘口径与 UI 路由一致）。 */
const setScope = (book, mode, chapters) => writeBaselineScope(ROOT, book, { mode, chapters });
const clearScope = (book) => { rmSync(baselineScopeFile(ROOT, book), { force: true }); };
/**
 * 期望基线：用与被测实现**同一个公开函数**现算。
 * 口径刻意与 style-metrics.computeBaseline 对齐（正文不足 40 字（trim 后）的章不参与测量）——
 * 少了这一条，期望值会把实现会跳过的短章也算进去，断言就变成假的。
 */
function muOf(book, files) {
  const per = [];
  for (const file of files) {
    const text = readFileSync(join(bookDirOf(book), file), "utf8");
    if (text.trim().length < 40) continue;
    per.push({ file, metrics: measureStyleMetrics(text).metrics });
  }
  return computeBaselineFromPerChapter(per);
}
const sc = (book, chapter) => defs.novel_style_check.execute({ book, chapter, root: ROOT }, exec);
const fix = (book, chapter) => defs.novel_fix_plan.execute({ book, chapter, root: ROOT }, exec);
const brief = (book, chapter) => defs.novel_chapter_brief.execute({ book, chapter, root: ROOT }, exec);
const report = (book, extra) => defs.novel_style_report.execute({ book, root: ROOT, ...(extra || {}) }, exec);

// ---------------------------------------------------------------------------
// ① 常量与落盘位置
// ---------------------------------------------------------------------------

test("① 常量与落盘位置：只认 all/custom，范围文件按书存在 .novel-writer/baseline/", () => {
  assert.deepEqual([...BASELINE_SCOPE_MODES], ["all", "custom"], "mode 白名单被改动");
  assert.ok(Object.isFrozen(BASELINE_SCOPE_MODES), "BASELINE_SCOPE_MODES 必须是冻结的（防调用方就地改白名单）");
  assert.equal(BASELINE_SCOPE_MAX_CHAPTERS, 2000, "选中章数上限被改动（它是防内存撑爆的硬边界）");
  assert.equal(baselineDir(ROOT), join(ROOT, ".novel-writer", "baseline"));
  assert.equal(baselineScopeFile(ROOT, "范围书"), join(ROOT, ".novel-writer", "baseline", "范围书.json"));
  // 书名要过 sanitizeSegment：路径分隔符不能穿出 baseline 目录
  const escaped = baselineScopeFile(ROOT, "../坏书");
  assert.equal(dirname(escaped), baselineDir(ROOT), "书名未净化，可穿出 baseline 目录：" + escaped);
});

// ---------------------------------------------------------------------------
// ② normalizeBaselineScope
// ---------------------------------------------------------------------------

test("② normalize：非法 mode 回落 all；chapters 去空白/丢非串/去重/单条 220 字/上限 2000", () => {
  assert.deepEqual(normalizeBaselineScope(undefined), { mode: "all", chapters: [] }, "无配置不是 all");
  assert.deepEqual(normalizeBaselineScope(null), { mode: "all", chapters: [] });
  assert.deepEqual(normalizeBaselineScope("custom"), { mode: "all", chapters: [] }, "非对象入参必须回落默认");
  assert.deepEqual(normalizeBaselineScope({ mode: "CUSTOM" }), { mode: "all", chapters: [] }, "mode 大小写必须回落 all");
  assert.deepEqual(normalizeBaselineScope({ mode: "nope", chapters: ["a"] }), { mode: "all", chapters: ["a"] },
    "非法 mode 必须回落 all（宁可退回全覆盖，也不要因拼错变成空集）");
  assert.deepEqual(normalizeBaselineScope({ mode: "custom", chapters: "第01章.md" }), { mode: "custom", chapters: [] },
    "chapters 非数组必须按空处理，不能把字符串当一项");
  // 去首尾空白 + 丢空串/非字符串 + 按出现顺序去重
  const dirty = normalizeBaselineScope({
    mode: "custom",
    chapters: [" 第01章.md ", "", "   ", "第01章.md", 1, null, { file: "x" }, ["第02章.md"], "第02章.md"]
  });
  assert.deepEqual(dirty, { mode: "custom", chapters: ["第01章.md", "第02章.md"] },
    "清洗结果不符（应为：去空白 → 丢空/非串 → 按序去重）");
  // 单条截 220 字
  const long = "第" + "很".repeat(400) + "章.md";
  const cut = normalizeBaselineScope({ mode: "custom", chapters: [long] });
  assert.equal(cut.chapters.length, 1);
  assert.equal(cut.chapters[0].length, 220, "单条文件名未截到 220 字");
  // 上限 2000（且不得多出第 2001 条）
  const many = normalizeBaselineScope({ mode: "custom", chapters: Array.from({ length: 2100 }, (_, i) => "第" + i + "章.md") });
  assert.equal(many.chapters.length, BASELINE_SCOPE_MAX_CHAPTERS, "选中章数未按上限截断");
  // 去重与截断的顺序：单条先截 220 字、再去重 → 两条只在 220 字之后不同的超长名会并成一条。
  // 章节文件名远短于 220 字，这只是把当前行为钉住，不是鼓励这种用法。
  const longA = "甲".repeat(300) + "A.md";
  const longB = "甲".repeat(300) + "B.md";
  assert.equal(normalizeBaselineScope({ mode: "custom", chapters: [longA, longB] }).chapters.length, 1,
    "截断与去重的顺序变了（当前实现：先截 220 字再去重）");
  // 去重发生在上限之前：重复项不得吃掉名额
  const dupes = normalizeBaselineScope({ mode: "custom", chapters: Array.from({ length: 2100 }, () => "同一章.md").concat(["第X章.md"]) });
  assert.deepEqual(dupes.chapters, ["同一章.md", "第X章.md"], "去重与上限的顺序错了（去重必须在计数之前）");
});

// ---------------------------------------------------------------------------
// ③–⑧ resolver：契约逐条
// ---------------------------------------------------------------------------

/** 造 items（resolver 只认 file 字段），顺序与磁盘一致。 */
function itemsOf(book, targetFile) {
  return Object.keys(BOOKS[book]).map((file) => ({ file, number: Number(file.slice(1, 3)) }))
    .filter((x) => x.file !== targetFile);
}
const FILES6 = Object.keys(BOOKS["范围书"]);

test("③ resolver：无配置 = 全书除目标章；all 措辞沿用旧格式（1 章时直接给章名）", async () => {
  clearScope("范围书");
  const r = await resolveBaselineScope(ROOT, "范围书", itemsOf("范围书", "第02章.md"), "第02章.md", exec);
  assert.equal(r.mode, "all");
  assert.equal(r.fellBack, false);
  assert.equal(r.selected, 0);
  assert.equal(r.missing, 0);
  assert.deepEqual(r.items.map((x) => x.file), FILES6.filter((f) => f !== "第02章.md"), "基线不是「全书除本章外」");
  assert.equal(r.scope, "全书除本章外的 5 章", "all 模式文案必须沿用旧措辞（有读取方按旧格式解析）");

  // 只有 1 个其他章 → 旧格式直接给章名
  const two = await resolveBaselineScope(ROOT, "两章书", itemsOf("两章书", "第02章.md"), "第02章.md", exec);
  assert.equal(two.mode, "all");
  assert.equal(two.scope, "第01章.md", "仅 1 章基线时文案应为章名（旧格式兼容）");

  // mode:"all" 与无文件等价
  await setScope("范围书", "all", FILES6);
  const explicitAll = await resolveBaselineScope(ROOT, "范围书", itemsOf("范围书", "第02章.md"), "第02章.md", exec);
  assert.equal(explicitAll.mode, "all");
  assert.equal(explicitAll.scope, "全书除本章外的 5 章", "显式 mode=all 的文案应与无配置一致");
  clearScope("范围书");
});

test("④ resolver：custom **只用**选中章（不是「优先 + 不够再补」）", async () => {
  await setScope("范围书", "custom", ["第01章.md", "第03章.md"]);
  const r = await resolveBaselineScope(ROOT, "范围书", itemsOf("范围书", "第02章.md"), "第02章.md", exec);
  assert.equal(r.mode, "custom");
  assert.equal(r.fellBack, false);
  assert.equal(r.selected, 2);
  assert.equal(r.missing, 0);
  // 关键：一个都不能多（多出来的章往往是用户想排除的 AI 续写章）
  assert.deepEqual(r.items.map((x) => x.file), ["第01章.md", "第03章.md"], "custom 把未选中的章补进了基线");
  assert.equal(r.scope, "自定义基线 2 章（选中 2 章）");
  // 单章选中也要成立（小样本靠 buildTolerance 抬到 ±25% 兜底）
  await setScope("范围书", "custom", ["第03章.md"]);
  const one = await resolveBaselineScope(ROOT, "范围书", itemsOf("范围书", "第02章.md"), "第02章.md", exec);
  assert.deepEqual(one.items.map((x) => x.file), ["第03章.md"]);
  assert.equal(one.scope, "自定义基线 1 章（选中 1 章）");
  clearScope("范围书");
});

test("⑤ resolver：目标章永远排除（即使它被选中）——不许拿自己跟自己比", async () => {
  await setScope("范围书", "custom", ["第01章.md", "第02章.md"]); // 第02章正是目标章
  const r = await resolveBaselineScope(ROOT, "范围书", itemsOf("范围书", "第02章.md"), "第02章.md", exec);
  assert.equal(r.mode, "custom");
  assert.deepEqual(r.items.map((x) => x.file), ["第01章.md"], "目标章没被排除：会得出「完美符合」的假结论");
  assert.equal(r.scope, "自定义基线 1 章（选中 2 章）");
  // 目标章被选中**不算失效**：它存在，只是作为被判定者按设计排除。
  // （这一条曾经是实打实的 bug：missing 用"入参 items"当分母，而消费方常常已经剔掉了目标章，
  //   于是文案写成「选中 2 章，其中 1 章已失效」——把"按设计排除"说成"章没了"。）
  assert.equal(r.missing, 0, "被选中的目标章被误记成「已失效」");
  assert.doesNotMatch(r.scope, /已失效/, "文案把「按设计排除的目标章」说成「已失效」：" + r.scope);

  // 目标章在入参 items 里也必须被排除（消费方传的集合各不相同：chapters 全集 / 已筛集合 / perChapter）
  const withTarget = await resolveBaselineScope(ROOT, "范围书",
    [...itemsOf("范围书", "第02章.md"), { file: "第02章.md", number: 2 }], "第02章.md", exec);
  assert.ok(!withTarget.items.some((x) => x.file === "第02章.md"), "入参里的目标章没被排除");
  assert.equal(withTarget.missing, 0, "目标章在入参里时同样不该算失效");
  assert.equal(withTarget.scope, "自定义基线 1 章（选中 2 章）");

  // 目标章名恰好是另一个文件名的**子串**时不得误伤（排除必须用全等）。
  // 注意先把范围切回 all：custom 是"只用选中章"，.bak 不在选中列表里被过滤掉是**正确**的，
  // 留在 custom 下断言会把这个正确行为误报成"前缀匹配误伤"。
  await setScope("范围书", "all", []);
  const tricky = await resolveBaselineScope(ROOT, "范围书",
    [{ file: "第02章.md.bak" }, { file: "第02章.md" }, { file: "第01章.md" }], "第02章.md", exec);
  assert.deepEqual(tricky.items.map((x) => x.file), ["第02章.md.bak", "第01章.md"], "排除目标章用的是前缀/子串匹配而不是全等");
  // 同上，改回 custom 并且**把 .bak 一起选中**，它就该留在基线里（不是目标章）
  await setScope("范围书", "custom", ["第01章.md", "第02章.md", "第02章.md.bak"]);
  const tricky2 = await resolveBaselineScope(ROOT, "范围书",
    [{ file: "第02章.md.bak" }, { file: "第02章.md" }, { file: "第01章.md" }], "第02章.md", exec);
  assert.deepEqual(tricky2.items.map((x) => x.file), ["第02章.md.bak", "第01章.md"], "选中的 .bak 文件被误当成目标章剔除了");
  clearScope("范围书");
});

test("⑥ resolver：选中项部分失效 → 跳过 + missing 如实计数 + 文案披露", async () => {
  await setScope("范围书", "custom", ["第01章.md", "已改名.md", "第03章.md"]);
  const r = await resolveBaselineScope(ROOT, "范围书", itemsOf("范围书", "第02章.md"), "第02章.md", exec);
  assert.equal(r.mode, "custom");
  assert.equal(r.selected, 3, "selected 应是配置里的选中数");
  assert.equal(r.missing, 1, "失效章数没如实计数");
  assert.deepEqual(r.items.map((x) => x.file), ["第01章.md", "第03章.md"], "失效章被跳过后的集合不对");
  // 措辞必须是中性的「未纳入基线」：resolver 只看得见调用方递进来的池子，
  // 而 brief 递的是 perChapter（<40 字的章已被丢掉）——说成"已失效"会把"章太短"谎报成"章没了"。
  assert.equal(r.scope, "自定义基线 2 章（选中 3 章，其中 1 章未纳入基线（已删除、或正文过短无法测量））",
    "未纳入基线的章未在文案里如实披露");
  assert.doesNotMatch(r.scope, /已失效/, "正常生效时出现「已失效」= 谎报（选中的章可能只是正文过短）：" + r.scope);
  // 「已失效」只允许出现在**回退**文案里（那里选中的章确实都不存在）
  // 失效项仍留在配置里（用户改回名字后应自动复活）
  assert.deepEqual((await readBaselineScope(ROOT, "范围书")).chapters, ["第01章.md", "已改名.md", "第03章.md"]);
  clearScope("范围书");
});

test("⑦ resolver：选中项全部失效 → 回退 all + fellBack + 披露，**绝不返回空基线**", async () => {
  await setScope("范围书", "custom", ["已改名.md", "已删除.md"]);
  const r = await resolveBaselineScope(ROOT, "范围书", itemsOf("范围书", "第02章.md"), "第02章.md", exec);
  assert.equal(r.mode, "all", "全部失效必须回退 all");
  assert.equal(r.fellBack, true, "回退未被标记：消费方无法向用户披露");
  assert.equal(r.selected, 2);
  assert.equal(r.missing, 2);
  assert.ok(r.items.length > 0, "返回了空基线——空基线算出的 μ 是假的，会把「没基线」伪装成「全都在带内」");
  assert.deepEqual(r.items.map((x) => x.file), FILES6.filter((f) => f !== "第02章.md"), "回退后的基线必须是全书除本章外");
  assert.ok(r.scope.includes("已回退全书"), "回退未在文案里披露：" + r.scope);
  assert.ok(r.scope.startsWith("全书除本章外的 5 章"), "回退后仍应沿用 all 旧措辞：" + r.scope);
  clearScope("范围书");
});

test("⑧ resolver 边界：custom+空列表 / 只选目标章 / 无 file 字段项 / 非数组 items", async () => {
  // custom 但一个都没选：等价 all，且不算「失效回退」（没有东西失效）
  await setScope("范围书", "custom", []);
  const empty = await resolveBaselineScope(ROOT, "范围书", itemsOf("范围书", "第02章.md"), "第02章.md", exec);
  assert.equal(empty.mode, "all");
  assert.equal(empty.fellBack, false);
  assert.equal(empty.selected, 0);
  assert.deepEqual(empty.items.map((x) => x.file), FILES6.filter((f) => f !== "第02章.md"));
  assert.doesNotMatch(empty.scope, /未纳入基线|已失效|已回退/, "空选择不该出现任何「有章没纳入」的暗示：" + empty.scope);
  observed.push("custom + 空章节列表（= 用户把选择清空）在 resolver 侧按 all 处理且 fellBack=false，scope=「" + empty.scope + "」。"
    + "路由已改报**生效档位**（custom+[] → 回报 all），面板档位与实际一致 ✓；"
    + "存储值仍是 mode=custom（清空选择不改变用户填的档位）——这是刻意的，只是读取配置的人必须自己判空才能得到生效档位。"
    + "属可维护性提示，不是行为缺陷");
  // 只选了目标章：picked 为空 → 回退 all（不是空基线），且 missing=0（目标章不是"失效"），
  // 文案要说明真正的原因（"只有本章自身"），不能笼统说"选择已失效"
  await setScope("范围书", "custom", ["第02章.md"]);
  const onlyTarget = await resolveBaselineScope(ROOT, "范围书", itemsOf("范围书", "第02章.md"), "第02章.md", exec);
  assert.equal(onlyTarget.mode, "all");
  assert.equal(onlyTarget.fellBack, true, "「只选目标章」必须回退（否则基线为空）");
  assert.equal(onlyTarget.missing, 0, "目标章不算失效章，missing 不该虚报");
  assert.ok(onlyTarget.items.length > 0, "回退后基线不得为空");
  assert.match(onlyTarget.scope, /只有本章自身/, "回退原因说错了（应说明选中的只有本章自身）：" + onlyTarget.scope);
  assert.match(onlyTarget.scope, /已回退全书/);
  assert.doesNotMatch(onlyTarget.scope, /选择已失效/, "把「只选了本章自身」说成「选择已失效」——原因与事实不符");
  // 对照：选中的章**真的都不存在**时，文案才是"已失效"
  await setScope("范围书", "custom", ["没这本.md"]);
  const allGone = await resolveBaselineScope(ROOT, "范围书", itemsOf("范围书", "第02章.md"), "第02章.md", exec);
  assert.equal(allGone.fellBack, true);
  assert.equal(allGone.missing, 1);
  assert.match(allGone.scope, /自定义选择已失效/, "真失效时文案不对：" + allGone.scope);

  // 劣质 items：没有 file / file 非字符串 → 丢弃；items 非数组 → 不抛错
  const junk = await resolveBaselineScope(ROOT, "范围书", [null, {}, { file: 1 }, { file: "第01章.md" }], "", exec);
  assert.deepEqual(junk.items.map((x) => x.file), ["第01章.md"], "带 file 字段的过滤没生效（其他消费方传的形状不同，过滤必须宽进严出）");
  const notArray = await resolveBaselineScope(ROOT, "范围书", null, "", exec);
  assert.deepEqual(notArray.items, []);
  assert.equal(notArray.mode, "all");
  clearScope("范围书");
});

// ---------------------------------------------------------------------------
// ⑨ 落盘往返 / 损坏 / 按书隔离
// ---------------------------------------------------------------------------

test("⑨ 落盘：write 净化后落盘（含 updatedAt），读回一致；损坏/缺失一律按 all；按书隔离", async () => {
  clearScope("范围书");
  assert.deepEqual(await readBaselineScope(ROOT, "范围书"), { mode: "all", chapters: [] }, "无文件时不是 all");

  const written = await writeBaselineScope(ROOT, "范围书", { mode: "nope", chapters: [" 第01章.md ", "第01章.md", 7] });
  assert.deepEqual(written, { mode: "all", chapters: ["第01章.md"] }, "write 未净化（写盘与读盘口径必须同一套）");
  const raw = JSON.parse(readFileSync(baselineScopeFile(ROOT, "范围书"), "utf8"));
  assert.equal(raw.mode, "all");
  assert.deepEqual(raw.chapters, ["第01章.md"]);
  assert.equal(typeof raw.updatedAt, "string", "落盘缺 updatedAt（UI 靠它显示保存时间）");
  assert.deepEqual(await readBaselineScope(ROOT, "范围书"), { mode: "all", chapters: ["第01章.md"] });

  // 损坏文件：fail-safe 回 all（读不出来就退回全覆盖，不静默缩小基线）
  writeFileSync(baselineScopeFile(ROOT, "范围书"), "{ 这不是 JSON", "utf8");
  assert.deepEqual(await readBaselineScope(ROOT, "范围书"), { mode: "all", chapters: [] }, "损坏文件必须按 all 处理");
  // 结构合法但值非法：同样回落
  writeFileSync(baselineScopeFile(ROOT, "范围书"), JSON.stringify({ mode: "weird", chapters: [1, "x"] }), "utf8");
  assert.deepEqual(await readBaselineScope(ROOT, "范围书"), { mode: "all", chapters: ["x"] });

  // 按书隔离：给甲书写范围不得创建/影响乙书
  clearScope("隔离甲");
  clearScope("隔离乙");
  await setScope("隔离甲", "custom", ["第01章.md", "第02章.md"]);
  assert.ok(existsSync(baselineScopeFile(ROOT, "隔离甲")));
  assert.equal(existsSync(baselineScopeFile(ROOT, "隔离乙")), false, "写甲书范围时创建了乙书的范围文件");
  assert.deepEqual(await readBaselineScope(ROOT, "隔离乙"), { mode: "all", chapters: [] });
  const jia = await resolveBaselineScope(ROOT, "隔离甲", itemsOf("隔离甲", "第04章.md"), "第04章.md", exec);
  const yi = await resolveBaselineScope(ROOT, "隔离乙", itemsOf("隔离乙", "第04章.md"), "第04章.md", exec);
  assert.equal(jia.mode, "custom");
  assert.equal(yi.mode, "all", "甲书的范围泄漏到了乙书");
  assert.equal(yi.scope, "全书除本章外的 3 章");
  clearScope("范围书");
});

// ---------------------------------------------------------------------------
// ⑩ HTTP 路由
// ---------------------------------------------------------------------------

const baselineRoute = routes.find((r) => r.path === "/api/dsh-novel-writer/baseline");
function fakeRes() {
  return { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = String(b); } };
}
function fakeReq(method, url, body, overrides) {
  const req = {
    method,
    url,
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" }
  };
  Object.assign(req, overrides || {});
  if (body !== undefined) {
    req[Symbol.asyncIterator] = () => {
      const chunks = [Buffer.from(body)];
      let i = 0;
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) };
    };
  }
  return req;
}
async function call(method, url, body, overrides) {
  const res = fakeRes();
  await baselineRoute.handler(fakeReq(method, url, body, overrides), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { json = res.body; }
  return { status: res.status, json };
}
const q = (book) => "/api/dsh-novel-writer/baseline?book=" + encodeURIComponent(book);

test("⑩ HTTP：路由已注册；空书名/非法 mode/非数组 chapters → 400；缺目录 → 200+warning；非回环 → 403", async () => {
  assert.ok(baselineRoute, "基线范围路由未注册（GET/POST /api/dsh-novel-writer/baseline）");
  assert.equal(baselineRoute.kind, "exact");
  clearScope("范围书");

  // 空书名：sanitizeSegment("") 会抛错，实现必须先判空 → 必须 400 而不是 500
  const noBook = await call("GET", "/api/dsh-novel-writer/baseline");
  assert.equal(noBook.status, 400, "空书名应 400，实测 " + noBook.status + "：" + JSON.stringify(noBook.json));
  assert.equal(noBook.json.ok, false);
  assert.match(noBook.json.error, /book is required/);
  const blank = await call("GET", q("   "));
  assert.equal(blank.status, 400, "纯空白书名应 400");
  const postNoBook = await call("POST", "/api/dsh-novel-writer/baseline", JSON.stringify({ mode: "all" }));
  assert.equal(postNoBook.status, 400, "POST 缺书名应 400");

  // 非法 mode / chapters 非数组
  const badMode = await call("POST", "/api/dsh-novel-writer/baseline", JSON.stringify({ book: "范围书", mode: "customx" }));
  assert.equal(badMode.status, 400, "非法 mode 应 400");
  assert.match(badMode.json.error, /mode must be one of/);
  const badCh = await call("POST", "/api/dsh-novel-writer/baseline", JSON.stringify({ book: "范围书", chapters: "第01章.md" }));
  assert.equal(badCh.status, 400, "chapters 非数组应 400");
  assert.match(badCh.json.error, /chapters must be an array/);
  // 非法 JSON / 非对象 body
  assert.equal((await call("POST", "/api/dsh-novel-writer/baseline", "{")).status, 400);
  assert.equal((await call("POST", "/api/dsh-novel-writer/baseline", "null")).status, 400);
  assert.equal((await call("POST", "/api/dsh-novel-writer/baseline", "\"x\"")).status, 400);
  // 方法
  assert.equal((await call("PUT", q("范围书"))).status, 405, "未知方法应 405");

  // 书目录不存在：不该 500（面板要能照常显示「暂无章节」）
  const missingBook = await call("GET", q("这本书不存在"));
  assert.equal(missingBook.status, 200, "书目录不存在应 200 + warning，实测 " + missingBook.status);
  assert.equal(missingBook.json.ok, true);
  assert.deepEqual(missingBook.json.available, []);
  assert.equal(missingBook.json.mode, "all");
  assert.equal(typeof missingBook.json.warning, "string");
  assert.ok(missingBook.json.warning.length > 0, "书目录不存在却没给 warning");
  // 目录存在但没有章节：同样 200
  const emptyBook = await call("GET", q("空目录书"));
  assert.equal(emptyBook.status, 200);
  assert.deepEqual(emptyBook.json.available, []);
  assert.equal(emptyBook.json.warning, undefined, "章节为空不是「找不到目录」，不该有 warning");

  // 非回环：只允许回环访问
  const remote = await call("GET", q("范围书"), undefined, {
    socket: { remoteAddress: "192.168.1.5" },
    headers: { host: "192.168.1.5:3080", origin: "http://192.168.1.5:3080" }
  });
  assert.equal(remote.status, 403, "非回环访问未拦住");
  assert.match(remote.json.error, /loopback-only/);
});

test("⑩ HTTP：GET/POST 返回同一结构；POST 落盘后 GET 能读回，missing/updatedAt 如实", async () => {
  clearScope("范围书");
  const before = await call("GET", q("范围书"));
  assert.equal(before.status, 200);
  assert.equal(before.json.ok, true);
  assert.equal(before.json.book, "范围书");
  assert.equal(before.json.mode, "all", "无配置时应报 all");
  assert.deepEqual(before.json.chapters, []);
  assert.equal(before.json.updatedAt, null, "无配置时 updatedAt 应为 null");
  assert.deepEqual(before.json.missing, [], "无配置时 missing 应为空数组");
  assert.equal(before.json.available.length, 6, "available 章数不对");
  for (const item of before.json.available) {
    assert.equal(typeof item.file, "string");
    assert.equal(typeof item.number, "number");
    assert.equal(typeof item.title, "string");
  }
  // 小样本门槛要回给前端（UI 据此解释"为什么容差是 25%"）
  assert.deepEqual(before.json.smallSample, { chapters: SMALL_BASELINE_CHAPTERS, tolPct: SMALL_BASELINE_TOL_PCT });

  const posted = await call("POST", "/api/dsh-novel-writer/baseline",
    JSON.stringify({ book: "范围书", mode: "custom", chapters: ["第01章.md", "第03章.md", "不存在.md"] }));
  assert.equal(posted.status, 200, "POST 保存失败：" + JSON.stringify(posted.json));
  assert.equal(posted.json.mode, "custom");
  assert.deepEqual(posted.json.chapters, ["第01章.md", "第03章.md", "不存在.md"]);
  assert.deepEqual(posted.json.missing, ["不存在.md"], "失效章没如实回报（用户会以为 3 章都生效了）");
  assert.equal(typeof posted.json.updatedAt, "string");
  assert.equal(posted.json.available.length, 6);
  // POST 返回体与 GET 同构（前端一套渲染逻辑）
  const after = await call("GET", q("范围书"));
  assert.deepEqual(Object.keys(after.json).sort(), Object.keys(posted.json).sort(), "GET/POST 返回结构不一致");
  assert.equal(after.json.mode, "custom");
  assert.deepEqual(after.json.chapters, ["第01章.md", "第03章.md", "不存在.md"]);
  assert.deepEqual(after.json.missing, ["不存在.md"]);
  assert.equal(after.json.updatedAt, posted.json.updatedAt);
  // 落盘内容与返回一致
  const onDisk = JSON.parse(readFileSync(baselineScopeFile(ROOT, "范围书"), "utf8"));
  assert.equal(onDisk.mode, "custom");
  assert.deepEqual(onDisk.chapters, ["第01章.md", "第03章.md", "不存在.md"]);
  // 净化在路由层同样生效（脏数据不许进盘）
  await call("POST", "/api/dsh-novel-writer/baseline",
    JSON.stringify({ book: "范围书", mode: "custom", chapters: [" 第01章.md ", "第01章.md", 3] }));
  assert.deepEqual(JSON.parse(readFileSync(baselineScopeFile(ROOT, "范围书"), "utf8")).chapters, ["第01章.md"],
    "路由写入未净化 chapters");
  // POST 的写入规则（三条，缺一条都会静默吃掉用户的勾选）：
  //   ① 缺省字段保留原值（PATCH）——面板切「按全书」时客户端只发 `{mode:"all"}`；
  //   ② `mode !== "custom"` 时**不动** chapters——"切到按全书"= 这次不用这个选择，不是删掉它；
  //   ③ 只有 `mode:"custom"` + 显式 `chapters:[]` 才算真清空。
  await call("POST", "/api/dsh-novel-writer/baseline", JSON.stringify({ book: "范围书", mode: "all" }));
  const patched = JSON.parse(readFileSync(baselineScopeFile(ROOT, "范围书"), "utf8"));
  assert.equal(patched.mode, "all");
  assert.deepEqual(patched.chapters, ["第01章.md"], "缺省 chapters 时被清空了已保存的选择（PATCH 语义被破坏）");
  // ②：即使显式发 chapters:[]，只要 mode 不是 custom 就不该动它（客户端实测会这么发）
  await call("POST", "/api/dsh-novel-writer/baseline", JSON.stringify({ book: "范围书", mode: "all", chapters: [] }));
  assert.deepEqual(JSON.parse(readFileSync(baselineScopeFile(ROOT, "范围书"), "utf8")).chapters, ["第01章.md"],
    "mode=all 时被 chapters:[] 清空了已保存的选择（切回按全书不该丢掉用户挑的标杆章）");
  // ③：在 custom 下显式清空才生效——同时钉住「回报的是**生效档位**」这条契约：
  // 存的是 {mode:"custom", chapters:[]}，而实际行为是「按全书」（resolver 对空选择就是 all）。
  // 若照存储值回报 custom，面板会显示"按部分"而实际在用全书——正是这个功能想消灭的
  //「界面说的和实际做的不一致」，所以 mode 必须回报 all。
  const clearedRes = await call("POST", "/api/dsh-novel-writer/baseline",
    JSON.stringify({ book: "范围书", mode: "custom", chapters: [] }));
  const cleared = JSON.parse(readFileSync(baselineScopeFile(ROOT, "范围书"), "utf8"));
  assert.equal(cleared.mode, "custom", "存储值应保留用户填的档位（清空选择不等于把档位也改掉）");
  assert.deepEqual(cleared.chapters, [], "custom 下显式传 chapters:[] 应清空");
  assert.equal(clearedRes.json.mode, "all", "custom+空选择必须回报**生效档位** all：" + JSON.stringify(clearedRes.json.mode));
  assert.deepEqual(clearedRes.json.chapters, []);
  const cGet = await call("GET", q("范围书"));
  assert.equal(cGet.json.mode, "all", "GET 也必须回报生效档位");
  // ④：custom 下缺省 chapters 也保留原值（此时原值已空，仍是空）
  await call("POST", "/api/dsh-novel-writer/baseline", JSON.stringify({ book: "范围书", mode: "custom" }));
  assert.deepEqual(JSON.parse(readFileSync(baselineScopeFile(ROOT, "范围书"), "utf8")).chapters, []);
  // ⑤「生效档位」必须**恒等于实际生效的档位**，两条分支（目录存在 / 不存在）口径一致。
  // 这一条是独立测试代理测出来的真 bug：生效档位的三元此前只写在主分支，
  // 同一份 {mode:"custom",chapters:[]} 在目录存在时报 all、目录不存在时报 custom；
  // 早退分支还少返回 missing 键。现在两处都走同一个 effectiveMode 函数、返回结构也一致。
  await setScope("没有这本书", "custom", []); // 书目录不存在，但配置可以存在（书改名/被删后的残配置）
  const ghost = await call("GET", q("没有这本书"));
  assert.equal(ghost.status, 200);
  assert.equal(typeof ghost.json.warning, "string");
  assert.equal(ghost.json.mode, "all", "书目录不存在时也必须回报**生效档位**（与主分支同口径）");
  assert.deepEqual(ghost.json.missing, [], "早退分支必须返回 missing（结构一致）；目录不存在时无从核对，空数组是唯一诚实的答案");
  // 早退分支允许**多**一个 warning（那是它存在的理由），但主分支有的键一个都不能少
  const ghostKeys = new Set(Object.keys(ghost.json));
  const absent = Object.keys(cGet.json).filter((k) => !ghostKeys.has(k));
  assert.deepEqual(absent, [], "早退分支缺少主分支的返回键（前端一套渲染逻辑会踩空）：" + JSON.stringify(absent));
  assert.equal(ghostKeys.has("warning"), true, "目录不存在必须给 warning");
  clearScope("范围书");
  clearScope("没有这本书");
});

// ---------------------------------------------------------------------------
// ⑪ 端到端 · 对照实验（本套最重要的一条）
// ---------------------------------------------------------------------------

test("⑪ 对照实验：同一章同一书，只改基线范围 → 基线 μ 与六维偏差值必须跟着变", async () => {
  clearScope("范围书");
  const full = await sc("范围书", "第02章");
  await setScope("范围书", "custom", ["第01章.md", "第03章.md"]);
  const custom = await sc("范围书", "第02章");

  // 先看文案（必要但不充分）
  assert.equal(full.baselineMode, "all");
  assert.equal(full.baselineScope, "全书除本章外的 5 章");
  assert.equal(custom.baselineMode, "custom");
  assert.equal(custom.baselineScope, "自定义基线 2 章（选中 2 章）");
  assert.ok(full.metric && full.metric.enabled, "六维测量不可用，对照实验无从谈起：" + JSON.stringify(full.metric));

  // 关键一：custom 的 μ 必须**恰好等于**选中两章现算的 μ（证明基线真的只用那两章，而不是只改了文案）
  const expectedCustom = muOf("范围书", ["第01章.md", "第03章.md"]);
  const expectedAll = muOf("范围书", ["第01章.md", "第03章.md", "第04章.md", "第05章.md", "第06章.md"]);
  assert.deepEqual(custom.metric.baseline, expectedCustom,
    "custom 的六维基线不等于「只用选中两章」的基线（说明范围没真正进入 μ/σ 计算）");
  assert.deepEqual(full.metric.baseline, expectedAll,
    "all 的六维基线不等于「全书除本章外」的基线");
  // 顺带证明两套语料确实不同（否则下面"必须变化"的断言会变成假的强断言）
  assert.notDeepEqual(expectedAll, expectedCustom, "夹具失效：两种范围的基线碰巧相同，对照实验无意义");

  // 关键二：偏差值（devPct/status）必须跟着变
  const tuple = (run) => (run.metric.verdicts || []).map((v) => v.metric + "=" + v.devPct + "/" + v.status).join(",");
  const fullVerdicts = tuple(full);
  const customVerdicts = tuple(custom);
  assert.notEqual(fullVerdicts, customVerdicts, "基线范围变了，六维判定却一模一样（范围没参与判定）");
  const devOf = (run, key) => (run.metric.verdicts || []).find((v) => v.metric === key)?.devPct;
  assert.notEqual(devOf(full, "complexity"), devOf(custom, "complexity"), "句法复杂度的偏差值没随范围变化");
  assert.notEqual(devOf(full, "actionDensity"), devOf(custom, "actionDensity"), "动作密度的偏差值没随范围变化");
  // 关键三：句式指纹基线（整段文本分析）也必须换语料
  assert.notEqual(full.similarity, custom.similarity, "相似度没随基线语料变化（指纹基线仍取全书）");

  console.log("   [对照实验] all   : scope=" + full.baselineScope + " | μ.complexity=" + full.metric.baseline.complexity.mu
    + " μ.actionDensity=" + full.metric.baseline.actionDensity.mu + " | similarity=" + full.similarity);
  console.log("   [对照实验] custom: scope=" + custom.baselineScope + " | μ.complexity=" + custom.metric.baseline.complexity.mu
    + " μ.actionDensity=" + custom.metric.baseline.actionDensity.mu + " | similarity=" + custom.similarity);
  console.log("   [对照实验] 偏差 all=" + fullVerdicts);
  console.log("   [对照实验] 偏差 custom=" + customVerdicts);

  // 关键四：锚段（fixAnchors）也必须跟着范围走——它是"照原著改"的范本，是最影响模型输出的那一处。
  // 用内容判定来源：短句族 B 与长句族 A 的段落互不重合。
  await setScope("范围书", "custom", ["第04章.md", "第05章.md"]);
  const anchorCustom = await sc("范围书", "第02章");
  assert.ok((anchorCustom.fixAnchors || []).length > 0, "夹具问题：custom 下没抽出锚段，无法验证锚段范围");
  for (const a of anchorCustom.fixAnchors) {
    const head = String(a.text).slice(0, 12);
    assert.ok(B1.includes(head), "fixAnchors 不是从选中章里抽的：" + a.text.slice(0, 24));
    assert.ok(!A1.includes(head), "fixAnchors 来自**未选中**的长句族（锚段仍取全书）：" + a.text.slice(0, 24));
  }
  clearScope("范围书");
  const anchorAll = await sc("范围书", "第02章");
  assert.ok((anchorAll.fixAnchors || []).some((a) => !B1.includes(String(a.text).slice(0, 12))),
    "all 模式与 custom 模式的锚段池相同，无法证明锚段跟着范围走");
  assert.notDeepEqual((anchorCustom.fixAnchors || []).map((a) => a.text), (anchorAll.fixAnchors || []).map((a) => a.text),
    "只改范围，fixAnchors 一字未变（锚段仍取全书）");
  console.log("   [style_check 锚段] custom: " + (anchorCustom.fixAnchors || []).map((a) => a.label + ":" + a.text.slice(0, 10)).join(" | "));
  console.log("   [style_check 锚段] all   : " + (anchorAll.fixAnchors || []).map((a) => a.label + ":" + a.text.slice(0, 10)).join(" | "));
  clearScope("范围书");
});

test("⑫ 端到端：改回 all / 删配置文件 → 行为回到「全书」（存量书零迁移）", async () => {
  await setScope("范围书", "custom", ["第01章.md"]);
  const custom = await sc("范围书", "第02章");
  assert.equal(custom.baselineMode, "custom");

  await setScope("范围书", "all", ["第01章.md"]); // 显式改回
  const back = await sc("范围书", "第02章");
  assert.equal(back.baselineMode, "all");
  assert.equal(back.baselineScope, "全书除本章外的 5 章");
  assert.deepEqual(back.metric.baseline, muOf("范围书", FILES6.filter((f) => f !== "第02章.md")), "改回 all 后 μ 没回到全书");

  clearScope("范围书"); // 删配置文件
  const gone = await sc("范围书", "第02章");
  assert.equal(gone.baselineMode, "all");
  assert.equal(gone.baselineScope, "全书除本章外的 5 章");
  assert.deepEqual(gone.metric.baseline, back.metric.baseline, "删掉配置文件后基线口径与显式 all 不一致");

  // 目标章被选中也不该进基线（工具级复核 ⑤）
  await setScope("范围书", "custom", ["第01章.md", "第02章.md"]);
  const withTarget = await sc("范围书", "第02章");
  assert.equal(withTarget.baselineScope, "自定义基线 1 章（选中 2 章）");
  assert.deepEqual(withTarget.metric.baseline, muOf("范围书", ["第01章.md"]), "目标章进了自己的基线");
  clearScope("范围书");
});

// ---------------------------------------------------------------------------
// ⑬ 端到端 · 改稿台
// ---------------------------------------------------------------------------

test("⑬ 端到端 fix_plan：基线规模=真正参与计算的章数；文案随范围变化；失效回退如实", async () => {
  clearScope("范围书");
  const full = await fix("范围书", "第02章");
  assert.match(full.summary, /基线：全书除本章外的 5 章/, "all 模式文案不是旧措辞：" + full.summary);
  assertScope("novel_fix_plan", full, /全书除本章外的 5 章/, "novel_fix_plan（all）");
  assert.equal(full.baselineMode, "all");

  await setScope("范围书", "custom", ["第01章.md", "第03章.md"]);
  const custom = await fix("范围书", "第02章");
  assert.match(custom.summary, /基线：自定义基线：可测 2 章（选中 2 章）/, "custom 文案未反映范围：" + custom.summary);
  assertScope("novel_fix_plan", custom, /自定义基线：可测 2 章（选中 2 章）/, "novel_fix_plan（custom）");
  assert.equal(custom.baselineMode, "custom");
  // 落盘清单里也要有范围说明（verify/mark 与事后排障都只读这个文件）
  assert.match(readFileSync(custom.planFile, "utf8"), /自定义基线/, "落盘清单缺范围说明");

  // 选中 3 章但其中 1 章正文不足 40 字 → 真正进 μ/σ 的只有 2 章，文案必须说「可测 2 章（选中 3 章）」
  await setScope("短章书", "custom", ["第01章.md", "第02章.md", "第03章.md"]);
  const short = await fix("短章书", "第04章");
  assert.match(short.summary, /可测 2 章（选中 3 章）/, "「选中数 ≠ 参与计算的章数」时文案没如实区分：" + short.summary);
  assert.equal(short.baselineScope, "自定义基线：可测 2 章（选中 3 章）",
    "fix_plan 的专属格式被改动（它还要解释「本章过短」等情形，故与 style_check 不逐字相同）：" + short.baselineScope);
  // 跨工具一致性（v6.5.5 修正后新增的门禁）：同一本书、同一范围、含"过短章"时，
  // 两处报的 N 必须是**同一个数**（真正进 μ/σ 的章数）——此前 style_check 报 3、fix_plan 报 2。
  const shortSc = await sc("短章书", "第04章");
  const nOf = (text) => Number(/(?:自定义基线：可测|自定义基线)\s*(\d+)\s*章/.exec(String(text))?.[1]);
  assert.equal(nOf(shortSc.baselineScope), 2, "style_check 的基线规模没按「真正进 μ/σ 的章数」报：" + shortSc.baselineScope);
  assert.equal(nOf(short.baselineScope), 2, "fix_plan 的基线规模不对：" + short.baselineScope);
  assert.equal(nOf(shortSc.baselineScope), nOf(short.baselineScope),
    "style_check 与 fix_plan 报的基线规模不是同一个数（同一事实两个数字）：" + shortSc.baselineScope + " vs " + short.baselineScope);
  assert.notEqual(shortSc.baselineScope, short.baselineScope,
    "两处文案各有自己的形式（fix_plan 带「可测」，style_check 不带）——不要求逐字相同，但本断言守住这个差异");
  assert.match(shortSc.baselineScope, /未纳入基线/, "style_check 没披露有章未纳入：" + shortSc.baselineScope);
  // 真失效（文件不存在）时 fix_plan 会额外报失效章数——它拿的是 scanChapters 全表，
  // 所以"已失效"在它这儿是**准确的**（只剩"文件不存在"一种可能）；style_check 的 custom 文案
  // 则只说中性的「未纳入基线」（它的池子不同）。同一个字段名的诚实度取决于调用方递的池子，
  // 这也是 core 改成中性措辞、而 fix_plan 保留"已失效"的理由。
  await setScope("范围书", "custom", ["第01章.md", "第03章.md", "已改名.md"]);
  const withMissing = await fix("范围书", "第02章");
  const withMissingSc = await sc("范围书", "第02章");
  assert.equal(withMissing.baselineScope, "自定义基线：可测 2 章（选中 3 章，其中 1 章已失效）",
    "fix_plan 未如实报出失效章数：" + withMissing.baselineScope);
  assert.equal(nOf(withMissing.baselineScope), nOf(withMissingSc.baselineScope),
    "两处基线规模不一致：" + withMissing.baselineScope + " vs " + withMissingSc.baselineScope);
  assert.match(withMissingSc.baselineScope, /未纳入基线/, "style_check 文案：" + withMissingSc.baselineScope);
  assert.doesNotMatch(withMissingSc.baselineScope, /已失效/, "style_check 的 custom 文案不该说「已失效」：" + withMissingSc.baselineScope);

  // 选中项全部失效 → 回退全书（绝不留空基线），且**返回体**要能看出已回退
  await setScope("范围书", "custom", ["没了.md"]);
  const fell = await fix("范围书", "第02章");
  assert.match(fell.summary, /基线：全书除本章外的 5 章/, "失效回退后未按全书文案披露：" + fell.summary);
  assertScope("novel_fix_plan", fell, /已回退全书/, "novel_fix_plan（失效回退）");
  assert.equal(fell.baselineMode, "all", "回退后 baselineMode 必须回到 all");
  clearScope("范围书");
  clearScope("短章书");
});

/**
 * 契约：消费方的**返回体**必须带 `baselineScope`（非空字符串，随范围切换）与 `baselineMode`（all/custom）。
 * 三者一起断言，是因为只查文案会漏掉「字段没产出」这类静默失败：宿主严格校验 schema 时，
 * 缺字段/多字段都可能让整条输出被拒收，而调用方看到的是"拒收"而不是"报错"。
 */
function assertScope(toolName, value, re, where) {
  assert.equal(typeof value.baselineScope, "string", where + " 的返回体缺 baselineScope 字段");
  assert.ok(value.baselineScope.length > 0, where + " 的 baselineScope 是空串");
  assert.match(value.baselineScope, re, where + " 的 baselineScope 与范围不符：" + value.baselineScope);
  assert.ok(["all", "custom"].includes(value.baselineMode), where + " 的 baselineMode 非法：" + JSON.stringify(value.baselineMode));
  const declaredEnum = defs[toolName]?.output?.schema?.properties?.baselineMode?.enum;
  assert.ok(Array.isArray(declaredEnum) && declaredEnum.includes(value.baselineMode),
    where + " 的 baselineMode 未登记进 schema 的 enum（宿主会拒收该输出）");
}

// ---------------------------------------------------------------------------
// ⑭ 端到端 · 开写包
// ---------------------------------------------------------------------------

test("⑭ 端到端 brief：六维基线与锚段只取选中章；失效回退在 degraded 里披露", async () => {
  clearScope("范围书");
  // 目标章第03章：选中第01章 → 基线应等于第01章一章的指标（范围真的生效）
  await setScope("范围书", "custom", ["第01章.md"]);
  const one = await brief("范围书", "第03章");
  assertScope("novel_chapter_brief", one, /自定义基线 1 章（选中 1 章）/, "novel_chapter_brief（custom）");
  assert.equal(one.baselineScope, "自定义基线 1 章（选中 1 章）", "brief 的范围文案不对：" + JSON.stringify(one.baselineScope));
  assert.equal(one.baselineMode, "custom");
  assert.deepEqual(one.baseline, muOf("范围书", ["第01章.md"]), "brief 的六维基线不是「只用选中章」算出来的");

  // 目标章在选中列表里：仍被排除（范围=选中章，排除谁取决于在判定哪一章）
  await setScope("范围书", "custom", ["第01章.md", "第03章.md"]);
  const two = await brief("范围书", "第03章");
  assert.equal(two.baselineScope, "自定义基线 1 章（选中 2 章）", "目标章没从 brief 的基线里排除：" + two.baselineScope);
  assert.deepEqual(two.baseline, muOf("范围书", ["第01章.md"]));

  // 锚段必须来自选中章（只选第04/05/06 = 短句族），选中章正文里不该出现长句族锚段
  await setScope("范围书", "custom", ["第04章.md", "第05章.md"]);
  const bOnly = await brief("范围书", "第03章");
  assert.ok((bOnly.anchors || []).length > 0, "夹具问题：选中章没抽出锚段，无法验证锚段范围");
  const selectedText = [BOOKS["范围书"]["第04章.md"], BOOKS["范围书"]["第05章.md"]].join("\n");
  for (const a of bOnly.anchors) {
    assert.ok(selectedText.includes(String(a.text).slice(0, 12)), "锚段不是从选中章里抽的（锚段仍在取全书）：" + a.text.slice(0, 20));
  }
  for (const s of bOnly.skeletons || []) {
    assert.ok(selectedText.includes(String(s.text).slice(0, 12)), "句式骨架不是从选中章里抽的：" + s.text.slice(0, 20));
  }

  // 全部失效 → 回退全书 + degraded 必须披露（否则用户以为自己选的章生效了）
  await setScope("范围书", "custom", ["没了.md", "也没了.md"]);
  const fell = await brief("范围书", "第03章");
  assertScope("novel_chapter_brief", fell, /已回退全书/, "novel_chapter_brief（失效回退）");
  assert.equal(fell.baselineMode, "all", "回退后 baselineMode 必须回到 all");
  assert.equal(fell.baselineScope.startsWith("全书除本章外的 5 章"), true, "失效回退后未按全书：" + fell.baselineScope);
  assert.deepEqual(fell.baseline, muOf("范围书", FILES6.filter((f) => f !== "第03章.md")), "回退后 brief 的基线不是全书");
  assert.ok((fell.degraded || []).some((d) => d.includes("已回退按全书")), "回退未在 degraded 里披露：" + JSON.stringify(fell.degraded));

  // 短章：**不得**报成「已失效」（章还在，只是正文 <40 字、六维测量会跳过），必须是中性的
  // 「未纳入基线（已删除、或正文过短无法测量）」——brief 递的池子是 perChapter，
  // 说成"失效"就是把"太短"谎报成"没了"（这一条是独立测试代理抓出来后才改的措辞）。
  await setScope("短章书", "custom", ["第01章.md", "第02章.md"]);
  const shortBrief = await brief("短章书", "第04章");
  assert.equal(shortBrief.baselineScope,
    "自定义基线 1 章（选中 2 章，其中 1 章未纳入基线（已删除、或正文过短无法测量））",
    "brief 对「选中但过短」的章的措辞不对：" + shortBrief.baselineScope);
  assert.doesNotMatch(shortBrief.baselineScope, /已失效/, "把「正文过短」谎报成「已失效」：" + shortBrief.baselineScope);
  assert.equal(shortBrief.baselineMode, "custom", "选中章里还有可测的章，档位不该回退");
  assert.deepEqual(shortBrief.baseline, muOf("短章书", ["第02章.md"]), "brief 的基线应只由可测的那一章算出");
  clearScope("短章书");
  clearScope("范围书");
});

// ---------------------------------------------------------------------------
// ⑮ 端到端 · 风格画像报告
// ---------------------------------------------------------------------------

test("⑮ 端到端 style_report：baselineChapterCount 与 baseline 随范围变化；简报带范围标签", async () => {
  clearScope("范围书");
  const full = await report("范围书");
  assert.equal(full.baselineChapterCount, 6, "all 模式基线章数应为全书 6 章");
  assert.deepEqual(full.baseline, muOf("范围书", FILES6), "all 模式基线不是全书");
  // 期望值于 2026-10-11 由实现者按独立验证代理的发现 4 更新（**不是为了让测试变绿而放宽**）：
  // 风格画像**没有"本章"概念**（它不判定某一章、不排除任何章），所以旧断言里那句「全书除**本章**外的 6 章」
  // 把基线说得比实际小（6 章全在基线里）。现在该路说「全书 6 章」。注意 `N` 未变（都是真正进 μ/σ 的
  // 可测章数 6）；变的只是措辞。**有目标章的那几路（风格自检 / 改稿台）仍说「全书除本章外的 N 章」**，
  // 那些断言（如 ⑬）保持原样、不要跟着改——它们的"本章"是真实存在的。
  assertScope("novel_style_report", full, /^全书 6 章$/, "novel_style_report（all）");
  assert.equal(full.baselineMode, "all");

  await setScope("范围书", "custom", ["第01章.md", "第03章.md"]);
  const custom = await report("范围书");
  assert.equal(custom.baselineChapterCount, 2, "custom 模式基线章数没变成选中章数（范围没进入计算）");
  assert.deepEqual(custom.baseline, muOf("范围书", ["第01章.md", "第03章.md"]), "custom 模式基线不是选中章集");
  assertScope("novel_style_report", custom, /自定义基线 2 章（选中 2 章）/, "novel_style_report（custom）");
  assert.equal(custom.baselineMode, "custom");
  // 精简路径（brief=true）：仍必须能看出 μ 来自自定义子集
  const briefOut = await report("范围书", { brief: true });
  assert.equal(briefOut.baselineChapterCount, 2);
  assert.match(briefOut.brief, /自定义基线 2 章（选中 2 章）/, "精简简报没标出基线范围：" + briefOut.brief);
  assert.match(briefOut.report, /自定义基线 2 章/, "精简 report 没标出基线范围");
  assertScope("novel_style_report", briefOut, /自定义基线 2 章（选中 2 章）/, "novel_style_report（brief=true）");
  assert.equal(briefOut.baselineMode, "custom");

  // 全部失效 → 回退全书，返回体与简报都要如实披露
  await setScope("范围书", "custom", ["没了.md"]);
  const fell = await report("范围书");
  assert.equal(fell.baselineChapterCount, 6, "回退后基线章数必须是全书 6 章（绝不能是空基线）");
  assert.deepEqual(fell.baseline, muOf("范围书", FILES6), "回退后的基线不是全书");
  assertScope("novel_style_report", fell, /已回退全书/, "novel_style_report（失效回退）");
  assert.equal(fell.baselineMode, "all", "回退后 baselineMode 必须回到 all");

  // all 模式不该出现「自定义基线」字样（免得读取方把全书 μ 当成子集 μ 的反面）
  clearScope("范围书");
  const allBrief = await report("范围书", { brief: true });
  assert.doesNotMatch(allBrief.brief, /自定义基线/, "all 模式的简报里出现了自定义基线标签");
  assert.equal(allBrief.baselineMode, "all");
  clearScope("范围书");

  // ── 载荷自洽 + 三路同口径（含"过短章"时最容易露馅） ──
  // ① 同一份返回体里 `baselineScope` 的 N 与 `baselineChapterCount` 必须相等：
  //    读者同时看到这两个数，一旦打架就无从判断该信哪个（比跨工具不一致更该守）。
  // ② 同一本书、同一范围，style_check / style_report / fix_plan 三处的 N 必须相等
  //    （文案格式各随其用，但"基线到底几章"只有一个事实）。
  await setScope("短章书", "custom", ["第01章.md", "第02章.md", "第03章.md"]);
  const nOf = (text) => Number(/(?:自定义基线：可测|自定义基线)\s*(\d+)\s*章/.exec(String(text))?.[1]);
  const repShort = await report("短章书");
  assert.equal(repShort.baselineChapterCount, 2, "报告的基线章数应为真正可测的 2 章（第01章只有 4 字）");
  assert.deepEqual(repShort.baseline, muOf("短章书", ["第02章.md", "第03章.md"]), "报告的基线不是可测的那两章");
  assert.match(repShort.baselineScope, /未纳入基线/, "报告未披露有章未纳入：" + repShort.baselineScope);
  assert.equal(nOf(repShort.baselineScope), repShort.baselineChapterCount,
    "同一份报告里 baselineScope 的 N 与 baselineChapterCount 打架：" + repShort.baselineScope + " vs " + repShort.baselineChapterCount);
  const repShortBrief = await report("短章书", { brief: true });
  assert.equal(repShortBrief.baselineChapterCount, 2);
  assert.equal(nOf(repShortBrief.baselineScope), repShortBrief.baselineChapterCount,
    "精简路径同样要自洽：" + repShortBrief.baselineScope + " vs " + repShortBrief.baselineChapterCount);
  assert.match(repShortBrief.brief, /未纳入基线/, "精简简报未披露有章未纳入：" + repShortBrief.brief);
  const scShort3 = await sc("短章书", "第04章");
  const fixShort3 = await fix("短章书", "第04章");
  assert.equal(nOf(scShort3.baselineScope), 2, "style_check 的 N：" + scShort3.baselineScope);
  assert.equal(nOf(fixShort3.baselineScope), 2, "fix_plan 的 N：" + fixShort3.baselineScope);
  assert.equal(nOf(scShort3.baselineScope), nOf(repShort.baselineScope), "style_check 与 style_report 的 N 不一致");
  assert.equal(nOf(fixShort3.baselineScope), nOf(repShort.baselineScope), "fix_plan 与 style_report 的 N 不一致");
  console.log("   [三路同口径] style_check=" + scShort3.baselineScope);
  console.log("   [三路同口径] style_report=" + repShort.baselineScope + " | baselineChapterCount=" + repShort.baselineChapterCount);
  console.log("   [三路同口径] fix_plan=" + fixShort3.baselineScope);
  clearScope("短章书");
});

// ---------------------------------------------------------------------------
// ⑯ 端到端 · 建章
// ---------------------------------------------------------------------------

test("⑯ 端到端 new_chapter：附带的基线行只算选中章，并与按全书的兄弟书不同", async () => {
  clearScope("建章甲");
  clearScope("建章乙");
  await setScope("建章甲", "custom", ["第01章.md"]);
  const custom = await defs.novel_new_chapter.execute({ book: "建章甲", content: "新章正文。".repeat(12), root: ROOT }, exec);
  const full = await defs.novel_new_chapter.execute({ book: "建章乙", content: "新章正文。".repeat(12), root: ROOT }, exec);
  assert.equal(custom.baselineMode, "custom");
  assertScope("novel_new_chapter", custom, /自定义基线 1 章（选中 1 章）/, "novel_new_chapter（custom）");
  assert.equal(custom.baselineScope, "自定义基线 1 章（选中 1 章）", "建章附带的基线范围文案不对：" + custom.baselineScope);
  assert.equal(full.baselineMode, "all", "未配置的兄弟书应报 all：" + full.baselineMode);
  assertScope("novel_new_chapter", full, /全书除本章外的 4 章/, "novel_new_chapter（all）");
  assert.equal(full.baselineScope, "全书除本章外的 4 章");
  // 基线行里的第一个数字（句法复杂度 μ）必须等于对应语料的 μ——两族文风 → 两个数字必然不同
  const muOne = muOf("建章甲", ["第01章.md"]);
  const muAll = muOf("建章乙", ["第01章.md", "第02章.md", "第03章.md", "第04章.md"]);
  assert.match(custom.baseline, new RegExp("句法复杂度 " + muOne.complexity.mu + "\\b"), "custom 的基线行不是选中章的 μ：" + custom.baseline);
  assert.match(full.baseline, new RegExp("句法复杂度 " + muAll.complexity.mu + "\\b"), "all 的基线行不是全书的 μ：" + full.baseline);
  assert.notEqual(custom.baseline, full.baseline, "两书的基线行相同（范围没进入建章时的基线计算）");
});

// ---------------------------------------------------------------------------
// ⑯-b 端到端 · 建章锚段（锚段同样要按范围筛）
// ---------------------------------------------------------------------------

test("⑯-b 端到端 new_chapter：返回的锚段/骨架也只来自选中章", async () => {
  // 两本书内容一致：丙配了 custom（只选短句族第04章），丁没配（= 全书）。
  // 两族的锚段互不重合（长句族命中「心理」标签，短句族只能走「原文」兜底），故能用内容判定来源。
  clearScope("建章丙");
  clearScope("建章丁");
  await setScope("建章丙", "custom", ["第04章.md"]);
  const custom = await defs.novel_new_chapter.execute({ book: "建章丙", content: "新章正文。".repeat(12), root: ROOT }, exec);
  const full = await defs.novel_new_chapter.execute({ book: "建章丁", content: "新章正文。".repeat(12), root: ROOT }, exec);
  assert.ok((custom.anchors || []).length > 0, "夹具问题：只选短句族时没抽出锚段，无法验证锚段范围");
  for (const a of custom.anchors) {
    const head = String(a.text).slice(0, 12);
    assert.ok(B1.includes(head), "custom 下建章锚段不是从选中章里抽的：" + a.text.slice(0, 24));
    assert.ok(!A1.includes(head), "custom 下建章锚段来自**未选中**的长句族：" + a.text.slice(0, 24));
  }
  for (const s of custom.skeletons || []) {
    assert.ok(B1.includes(String(s.text).slice(0, 10)), "custom 下建章句式骨架不是从选中章里抽的：" + s.text.slice(0, 24));
  }
  // 对照：没配范围的兄弟书（all）锚段池含全书，必然抽出至少一条不在选中集里的锚段
  const fullHeads = (full.anchors || []).map((a) => String(a.text).slice(0, 12));
  assert.ok(fullHeads.some((head) => !B1.includes(head)),
    "all 模式与 custom 模式的锚段池相同，无法证明范围起了作用：" + fullHeads.join(" | "));
  assert.notDeepEqual((custom.anchors || []).map((a) => a.text), (full.anchors || []).map((a) => a.text),
    "只改范围，建章锚段一字未变（锚段仍取全书）");
  console.log("   [建章锚段] custom: " + (custom.anchors || []).map((a) => a.label + ":" + a.text.slice(0, 10)).join(" | "));
  console.log("   [建章锚段] all   : " + (full.anchors || []).map((a) => a.label + ":" + a.text.slice(0, 10)).join(" | "));
  clearScope("建章丙");
  clearScope("建章丁");
});

// ---------------------------------------------------------------------------
// ⑰ 端到端 · 按书隔离（工具级：同一批正文的两本书，只有甲配了范围）
// ---------------------------------------------------------------------------

test("⑰ 端到端：甲书的自定义范围不影响乙书（范围属于书，不是全局）", async () => {
  clearScope("隔离甲");
  clearScope("隔离乙");
  await setScope("隔离甲", "custom", ["第01章.md", "第02章.md"]);
  const jia = await sc("隔离甲", "第04章");
  const yi = await sc("隔离乙", "第04章");
  assert.equal(jia.baselineMode, "custom");
  assert.equal(jia.baselineScope, "自定义基线 2 章（选中 2 章）");
  assert.equal(yi.baselineMode, "all", "甲书的范围泄漏到了乙书");
  assert.equal(yi.baselineScope, "全书除本章外的 3 章");
  assert.deepEqual(jia.metric.baseline, muOf("隔离甲", ["第01章.md", "第02章.md"]));
  assert.deepEqual(yi.metric.baseline, muOf("隔离乙", ["第01章.md", "第02章.md", "第03章.md"]));
  assert.equal(existsSync(baselineScopeFile(ROOT, "隔离乙")), false, "读乙书时凭空创建了它的范围文件");
  // 其余三个消费方同样按书读范围（同一本书的口径必须一致）
  assert.equal((await fix("隔离乙", "第04章")).baselineMode, "all");
  assert.equal((await report("隔离乙")).baselineChapterCount, 4);
  assert.equal((await brief("隔离乙", "第04章")).baselineMode, "all");
  clearScope("隔离甲");
  clearScope("隔离乙");
});

// ---------------------------------------------------------------------------
// ⑱ schema 一致性：多返回一个未登记字段 = 静默失败（宿主整条拒收）
// ---------------------------------------------------------------------------

/**
 * 为什么单独设一条门禁：`output.schema.additionalProperties:false` 的工具多返回一个键，
 * 宿主**整条拒收**——调用方拿到的是"拒收"，不是"报错"，也没有任何日志指向那个多出来的键。
 * 本功能恰好往五个消费方的返回体里各加了 1~2 个键（baselineScope / baselineMode），
 * 只要有一处忘了登记 schema，整个工具就哑了。故这里把「注册的 schema」与「真实返回体」对起来查。
 */
test("⑱ schema 一致性：返回体的每个键都必须在 output.schema.properties 里登记", async () => {
  const checkKeys = (toolName, value, where) => {
    const schema = defs[toolName]?.output?.schema;
    assert.ok(schema && schema.properties, toolName + " 没有 output.schema.properties");
    const declared = schema.properties;
    const extra = Object.keys(value).filter((k) => !Object.prototype.hasOwnProperty.call(declared, k));
    assert.deepEqual(extra, [], where + " 返回了未登记的键 " + JSON.stringify(extra)
      + "（additionalProperties=" + String(schema.additionalProperties) + "，宿主会整条拒收该输出）");
    if (schema.additionalProperties === false) {
      // 额外的信息：本工具确实是严格校验，缺键/多键都会致命
      assert.ok(Object.keys(declared).length > 0);
    }
  };

  clearScope("范围书");
  await setScope("范围书", "custom", ["第01章.md", "第03章.md"]);
  checkKeys("novel_style_check", await sc("范围书", "第02章"), "novel_style_check");
  checkKeys("novel_style_report", await report("范围书"), "novel_style_report（完整）");
  checkKeys("novel_style_report", await report("范围书", { brief: true }), "novel_style_report（精简）");
  checkKeys("novel_chapter_brief", await brief("范围书", "第03章"), "novel_chapter_brief");

  const plan = await fix("范围书", "第02章");
  checkKeys("novel_fix_plan", plan, "novel_fix_plan（plan）");
  const verified = await defs.novel_fix_plan.execute({ book: "范围书", chapter: "第02章", action: "verify", root: ROOT }, exec);
  checkKeys("novel_fix_plan", verified, "novel_fix_plan（verify）");
  if (Array.isArray(plan.items) && plan.items.length > 0 && typeof plan.items[0].id === "string") {
    const marked = await defs.novel_fix_plan.execute({ book: "范围书", chapter: "第02章", action: "mark", itemId: plan.items[0].id, state: "skip", root: ROOT }, exec);
    checkKeys("novel_fix_plan", marked, "novel_fix_plan（mark）");
  } else {
    console.log("   （本次 plan 无待办项，mark 分支的 schema 一致性未覆盖——不是失败）");
  }
  for (const book of ["建章甲", "建章乙"]) clearScope(book);
  await setScope("建章甲", "custom", ["第01章.md"]);
  const created = await defs.novel_new_chapter.execute({ book: "建章甲", content: "新章正文。".repeat(12), root: ROOT }, exec);
  checkKeys("novel_new_chapter", created, "novel_new_chapter");
  clearScope("范围书");
  clearScope("建章甲");
  // 与本次功能配套的四个键必须真的被登记（谁把它们从 schema 里删掉，这条立刻红）
  for (const tool of ["novel_style_check", "novel_style_report", "novel_chapter_brief", "novel_fix_plan", "novel_new_chapter"]) {
    const props = defs[tool].output.schema.properties;
    assert.ok(Object.prototype.hasOwnProperty.call(props, "baselineScope"), tool + " 的 schema 未登记 baselineScope");
  }
});

// ---------------------------------------------------------------------------
// ★汇总：实测偏差（打印，不判失败）
// ---------------------------------------------------------------------------

test("★汇总：本次实测到的契约偏差（只打印，不判失败——逐条写进交付报告）", () => {
  // 为什么不写成失败断言：这些是**实现与任务书契约的偏差**，不是我这一套测试的正确性判据。
  // 把「当前缺陷」写成断言（例如 assert.equal(x, undefined)）等于把它固化成"正确行为"，修好后测试反而变红。
  // 反过来，能严格断言的都已在上面严格断言了（baselineScope/baselineMode 的存在性与文案、μ 的一致性、
  // 回退披露、schema 覆盖）；这里剩下的只是"措辞/口径"层面的实测记录，供报告逐条引用。
  console.log("   实测契约偏差 " + observed.length + " 条：");
  for (const item of observed) console.log("   - " + item);
  assert.ok(Array.isArray(observed));
});
