/**
 * test/audit-contracts-test.mjs —— v7.2.0 对抗性审计「严格对账」回归套件。
 *
 * 被钉住的契约（`lib/audit.js` 的 `runAuditContracts` / `buildAuditBrief`）：
 *   ① 每条契约都必须出现在 `contracts` 数组里；没跑必须给 `ran:false` + `reason`（不许静默缺席）；
 *   ② 每条违约必须可举证：行号 + 原文片段；`detail` 只写事实与依据；
 *   ③ **不得退化成文学评论**：`chapter-diagnose` 的 abstract / action_thin / sense_mono /
 *      object_thin / slop 是「风格建议」，只能出 `ending` / `bare_dialogue` 两条结构性违约；
 *   ④ 一条契约抛错只让它自己 `ran:false`，其它契约照常跑完（逐条 try/catch）；
 *   ⑤ 输出形状固定为 6 个键，绝无建议性字段（suggestion / hint / fix …）。
 *
 * 隔离：状态目录与书库都在 `%TEMP%` 下按进程 + 时间戳新建，跑完删除；
 * 显式向每个调用传 root，绝不碰真实书库。
 *
 * 运行：node test/audit-contracts-test.mjs
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// ===========================================================================
// 隔离夹具：先设 env，再动态 import（静态 import 会先于 env 赋值求值）
// ===========================================================================

const ROOT = join(tmpdir(), "dsh-audit-contracts-" + process.pid + "-" + Date.now().toString(36));
process.env.DSH_NOVEL_WRITER_STATE = join(ROOT, "state-test.json");
process.env.DSH_HOME = join(ROOT, "dsh-home");
process.on("exit", () => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

await mkdir(ROOT, { recursive: true });

const { runAuditContracts, buildAuditBrief } = await import("../lib/audit.js");
const { CREATION_FILES, creationDir, lexiconFile, plotsFile, settingsFile } = await import("../lib/core.js");

const BOOK = "审计书";

let seq = 0;
/** 每项测试一个独立书库根——避免词表/设定/伏笔互相串味。 */
async function freshRoot(tag) {
  seq += 1;
  const root = join(ROOT, tag + "-" + seq);
  await mkdir(join(root, "novels", BOOK), { recursive: true });
  return root;
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

function writeLexicon(root, entries) {
  return writeJson(lexiconFile(root, BOOK), { book: BOOK, enabled: true, entries });
}

function writeWorldview(root, worldview) {
  return writeJson(settingsFile(root, BOOK), { book: BOOK, characters: [], locations: [], items: [], timeline: [], worldview });
}

function writePlots(root, entries) {
  return writeJson(plotsFile(root, BOOK), { book: BOOK, entries });
}

async function writeOutline(root, text) {
  const dir = creationDir(root, BOOK);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, CREATION_FILES.outline), text, "utf8");
}

function contractOf(result, id) {
  return result.contracts.find((c) => c.id === id);
}

const ALL_CONTRACT_IDS = ["lexicon", "banned", "slop", "loop", "outline", "ending", "bare_dialogue", "plot"];

/** 常用于「只想验证某一条」的调用：test id 便于定位失败。 */
function audit(root, text, extra = {}) {
  return runAuditContracts({
    root,
    book: BOOK,
    chapterFile: "第03章 雨夜.md",
    text,
    ...extra
  });
}

// ===========================================================================
// ① 必用词表
// ===========================================================================

test("未登记必用词表：lexicon.ran=false 且 reason 含「未登记」", async () => {
  const root = await freshRoot("no-lexicon");
  const res = await audit(root, "他推开门走了进去。");

  assert.deepEqual(res.contracts.map((c) => c.id), ALL_CONTRACT_IDS);
  const lexicon = contractOf(res, "lexicon");
  assert.equal(lexicon.ran, false);
  assert.match(lexicon.reason, /未登记/);
  // 章号/文件名/行数由章节文件名与正文算出。
  assert.equal(res.file, "第03章 雨夜.md");
  assert.equal(res.chapterNumber, 3);
  assert.equal(res.lines, 1);
});

test("必用词 0 次：severity 2、line 0、text 空、detail 点名该词", async () => {
  const root = await freshRoot("lex-missing");
  await writeLexicon(root, [{ term: "青霉素" }]);

  const res = await audit(root, "他推开门走了进去。\n她把茶盏放在桌上。\n");
  assert.equal(contractOf(res, "lexicon").ran, true);

  const hit = res.violations.find((v) => v.contract === "lexicon" && v.severity === 2);
  assert.ok(hit, "必用词 0 次应产出一条 severity 2 违约");
  assert.equal(hit.line, 0);
  assert.equal(hit.text, "");
  assert.match(hit.detail, /青霉素/);
  assert.match(hit.detail, /未出现/);
});

test("替身词命中：severity 3、line 是真实行号、text 是该行子串", async () => {
  const root = await freshRoot("lex-avoid");
  // 「药」是必用词，「草药」是登记的通用替身词——严格包含口径下该处仍算用了替身词。
  await writeLexicon(root, [{ term: "药", aliases: ["丸药"], avoid: ["草药"] }]);

  const text = "他推开门走了进去。\n她把茶盏放在桌上。\n他掏出草药敷在伤口上。\n窗外下起了雨。\n";
  const res = await audit(root, text);

  const hit = res.violations.find((v) => v.contract === "lexicon" && v.severity === 3);
  assert.ok(hit, "替身词命中应产出一条 severity 3 违约");
  assert.equal(hit.line, 3);
  const line = text.split("\n")[hit.line - 1];
  assert.ok(line.includes(hit.text), "text 必须是该行原文的连续子串");
  assert.match(hit.detail, /草药/);
  assert.match(hit.detail, /药/);
});

// ===========================================================================
// ② 世界观禁用词
// ===========================================================================

test("世界观禁用词命中（severity 4）；allowWords 登记过的词不报", async () => {
  const root = await freshRoot("banned");
  await writeWorldview(root, [{
    name: "中式古代客栈",
    basis: "中式古代客栈与江湖",
    bannedWords: ["上香", "老夫"],
    allowWords: ["老夫"] // 本书用词豁免：resolveStyleRule 会静音它
  }]);

  // 两个词分处两行：这样「老夫 是否被静音」不会被上香那行的整行片段混淆。
  const text = "他上香三炷。\n他把老夫的牌位摆在案上。\n";
  const res = await audit(root, text);

  assert.equal(contractOf(res, "banned").ran, true);
  const banned = res.violations.filter((v) => v.contract === "banned");
  assert.ok(banned.length >= 1, "「上香」应被报出");
  assert.ok(banned.every((v) => v.severity === 4));
  assert.ok(banned.every((v) => v.line >= 1));
  assert.ok(banned.some((v) => v.line === 1 && v.detail.includes("上香")));
  assert.ok(!banned.some((v) => v.detail.includes("「老夫」")), "allowWords 登记过的词必须静音");
  assert.ok(banned.every((v) => v.line !== 2), "第 2 行只含被豁免的「老夫」，不应产生禁用词违约");
});

// ===========================================================================
// ③ 套话归并
// ===========================================================================

test("套话按类别归并：同一类别多处只出一条", async () => {
  const root = await freshRoot("slop");
  const text = [
    "他眼中闪过一丝慌乱。",
    "她的瞳孔猛地一缩。",
    "他嘴角勾起一抹弧度。",
    "他推开门走了出去。",
    "夜色渐深。"
  ].join("\n");
  const res = await audit(root, text);

  const slops = res.violations.filter((v) => v.contract === "slop");
  assert.equal(slops.length, 2, "两条 eye_cliche + 一条 smirk_cliche 应归并成 2 条");
  const eye = slops.find((v) => v.detail.includes("eye_cliche"));
  const smirk = slops.find((v) => v.detail.includes("smirk_cliche"));
  assert.ok(eye, "eye_cliche 应有一条");
  assert.ok(smirk, "smirk_cliche 应有一条");
  assert.match(eye.detail, /命中\s*2\s*处/);
  assert.match(smirk.detail, /命中\s*1\s*处/);
  assert.equal(eye.line, 1, "line 取该类首个命中行号");
});

// ===========================================================================
// ④ 大纲兑现
// ===========================================================================

test("outline：无本章方向行 → ran=false；有方向行且未兑现 → 一条 severity 3", async () => {
  const rootA = await freshRoot("outline-none");
  await writeOutline(rootA, "# 剧情大纲\n\n- 9 别的章的方向\n");
  const missing = await audit(rootA, "他推开门走了进去。\n");
  const ca = contractOf(missing, "outline");
  assert.equal(ca.ran, false);
  assert.match(ca.reason, /没有本章方向行/);

  const rootB = await freshRoot("outline-hit");
  await writeOutline(rootB, "# 剧情大纲\n\n- 3 林风去黑市买药\n");
  const fulfilled = await audit(rootB, "他推开门走了进去。\n", {
    options: {
      deps: {
        isAvailable: async () => true,
        checkOutlineFulfillment: async () => ({
          checked: true,
          clauses: 1,
          unfulfilled: [{ clause: "林风去黑市买药", bestSim: 0.12 }],
          skipped: []
        })
      }
    }
  });
  assert.equal(contractOf(fulfilled, "outline").ran, true);
  const hit = fulfilled.violations.find((v) => v.contract === "outline");
  assert.ok(hit);
  assert.equal(hit.severity, 3);
  assert.match(hit.detail, /林风去黑市买药/);
  assert.match(hit.detail, /0\.12/);
});

test("outline：skipped 的子句不算违约（推理失败 ≠ 没兑现）", async () => {
  const root = await freshRoot("outline-skip");
  await writeOutline(root, "- 3 林风去黑市买药\n");
  const res = await audit(root, "他推开门走了进去。\n", {
    options: {
      deps: {
        isAvailable: async () => true,
        checkOutlineFulfillment: async () => ({
          checked: true,
          clauses: 2,
          unfulfilled: [],
          skipped: [{ clause: "林风去黑市买药", reason: "查询向量推理失败" }]
        })
      }
    }
  });
  assert.equal(contractOf(res, "outline").ran, true);
  assert.equal(res.violations.filter((v) => v.contract === "outline").length, 0);
});

// ===========================================================================
// ⑤ 症状 → 违约的取舍（防退化成文学评论）
// ===========================================================================

test("ending_preach 只转 ending；abstract/object_thin/action_thin/sense_mono/slop 不进 violations", async () => {
  const root = await freshRoot("diag-mapping");
  const text = "他推开门走了进去。\n她把茶盏放在桌上。\n他没再多话。\n";
  const res = await audit(root, text, {
    options: {
      deps: {
        diagnoseChapterSymptoms: () => ([
          { key: "ending_preach", severity: 5, title: "章末升华", detail: "【ADVICE-ENDING】改成停在动作上" },
          { key: "abstract", severity: 5, title: "抽象度过高", detail: "【ADVICE-ABSTRACT】" },
          { key: "object_thin", severity: 5, title: "物件密度偏低", detail: "【ADVICE-OBJECT】" },
          { key: "action_thin", severity: 5, title: "动作密度偏低", detail: "【ADVICE-ACTION】" },
          { key: "sense_mono", severity: 5, title: "感官通道单一", detail: "【ADVICE-SENSE】" },
          { key: "slop", severity: 5, title: "套话堆砌", detail: "【ADVICE-SLOP】" }
        ])
      }
    }
  });

  const diag = res.violations.filter((v) => v.contract === "ending" || v.contract === "bare_dialogue");
  assert.equal(diag.length, 1, "只允许 ending / bare_dialogue 两条结构性违约");
  assert.equal(diag[0].contract, "ending");
  assert.equal(diag[0].severity, 3);
  assert.equal(diag[0].line, 3);
  assert.ok(text.split("\n")[2].includes(diag[0].text));

  for (const forbidden of ["abstract", "object_thin", "action_thin", "sense_mono"]) {
    assert.equal(res.violations.filter((v) => v.contract === forbidden).length, 0, forbidden + " 属于风格建议，不得进 audit");
  }
  // 症状自带的「改法」文案绝不能漏进 detail（那是文学评论，不是违约证据）。
  assert.ok(!res.violations.some((v) => v.detail.includes("ADVICE-")), "不得把症状的改写建议抄进 detail");
});

test("真实症状：章末升华转成 ending 违约，相对分位类症状（abstract/object_thin/action_thin）不转化", async () => {
  const root = await freshRoot("diag-real");
  const text = "他推开门走出去。\n夜色渐深。\n\n他终于明白，命运的序幕才刚刚开始。\n";
  const refStats = {
    abstractDensity: { p10: 0, p50: 0.1, p85: 0.2, p95: 0.0001 },
    objectNounsPer1000: { p10: 1000, p50: 1500, p85: 2000, p95: 2500 },
    actionVerbsPer1000: { p10: 1000, p50: 1500, p85: 2000, p95: 2500 },
    senseChannels: {}
  };
  const res = await audit(root, text, { refStats });

  const endings = res.violations.filter((v) => v.contract === "ending");
  assert.equal(endings.length, 1);
  assert.equal(endings[0].line, 4);
  assert.ok(text.split("\n")[3].includes(endings[0].text));
  assert.equal(res.violations.filter((v) => ["abstract", "object_thin", "action_thin", "sense_mono"].includes(v.contract)).length, 0);
});

// ===========================================================================
// ⑥ 伏笔 / 打转
// ===========================================================================

test("plot：open 且登记章号早于本章、命中 ≥2 关键词但未登记本章 → severity 2", async () => {
  const root = await freshRoot("plot");
  await writePlots(root, [
    // 应报：open、登记第 1 章（早于本章 3）、本章命中 ≥2 关键词、未登记本章提及。
    { id: "plot-1", content: "玉佩碎裂", status: "open", chapter: "1", mentionedIn: ["1"] },
    // 不报：登记章号 = 本章。
    { id: "plot-2", content: "玉佩碎裂", status: "open", chapter: "3", mentionedIn: ["1"] },
    // 不报：登记表已记录本章提及。
    { id: "plot-3", content: "玉佩碎裂", status: "open", chapter: "1", mentionedIn: ["3"] },
    // 不报：已回收。
    { id: "plot-4", content: "玉佩碎裂", status: "done", chapter: "1", mentionedIn: ["1"] }
  ]);

  const text = "玉佩碎裂的声音从里屋传来。\n他站在原地。\n";
  const res = await audit(root, text);

  assert.equal(contractOf(res, "plot").ran, true);
  const plots = res.violations.filter((v) => v.contract === "plot");
  assert.equal(plots.length, 1);
  assert.equal(plots[0].severity, 2);
  assert.match(plots[0].detail, /plot-1/);
  assert.equal(plots[0].line, 1);
  assert.ok(text.split("\n")[0].includes(plots[0].text));
});

test("loop：有打转段 → severity 3、line 取 lineFrom；checked=false → ran=false 带原因", async () => {
  const root = await freshRoot("loop");
  const text = "他推开门走了进去。\n她把茶盏放在桌上。\n";

  const hit = await audit(root, text, {
    options: {
      deps: {
        isAvailable: async () => true,
        detectSemanticLoop: async () => ({
          checked: true,
          blocks: 8,
          loops: [{ fromBlock: 2, toBlock: 4, lineFrom: 2, lineTo: 12, sim: 0.93, novelty: 0.05, excerpt: "她把茶盏放在桌上。" }]
        })
      }
    }
  });
  assert.equal(contractOf(hit, "loop").ran, true);
  const v = hit.violations.find((x) => x.contract === "loop");
  assert.ok(v);
  assert.equal(v.severity, 3);
  assert.equal(v.line, 2);
  assert.equal(v.text, "她把茶盏放在桌上。");

  const skipped = await audit(root, text, {
    options: {
      deps: {
        isAvailable: async () => true,
        detectSemanticLoop: async () => ({ checked: false, reason: "语义引擎不可用（模型缺失或 WASM 初始化失败）", loops: [] })
      }
    }
  });
  const c = contractOf(skipped, "loop");
  assert.equal(c.ran, false);
  assert.match(c.reason, /语义引擎不可用/);
});

// ===========================================================================
// ⑦ 契约互不拖累
// ===========================================================================

test("任一契约抛错不影响其它契约（逐条 try/catch）", async () => {
  const root = await freshRoot("throw");
  await writeLexicon(root, [{ term: "星轨" }]);
  await writeWorldview(root, [{ name: "中式古代", basis: "中式古代客栈", bannedWords: ["上香"] }]);
  await writeOutline(root, "- 3 林风去黑市买药\n");
  await writePlots(root, [{ id: "plot-1", content: "林风去黑市买药", status: "open", chapter: "1", mentionedIn: ["1"] }]);

  const text = "星轨在窗外交错。\n他推开门走了进去。\n";
  const res = await audit(root, text, {
    options: {
      deps: {
        scanSlop: () => { throw new Error("注入失败：slop"); },
        isAvailable: async () => true,
        detectSemanticLoop: async () => ({ checked: true, blocks: 8, loops: [] }),
        checkOutlineFulfillment: async () => ({ checked: true, clauses: 1, unfulfilled: [], skipped: [] })
      }
    }
  });

  const slop = contractOf(res, "slop");
  assert.equal(slop.ran, false);
  assert.match(slop.reason, /注入失败/);

  const others = res.contracts.filter((c) => c.id !== "slop");
  assert.equal(others.length, 7);
  for (const c of others) assert.equal(c.ran, true, c.id + " 不应被 slop 的异常拖垮：" + c.reason);
  // 失败的契约要写进 summary 的「未跑」清单，且带原因。
  assert.match(res.summary, /1 项契约未跑/);
  assert.match(res.summary, /slop/);
});

// ===========================================================================
// ⑧ 输出形状（无建议性字段）+ summary 格式
// ===========================================================================

test("audit 输出不含建议性字段：每条违约只有 6 个固定键", async () => {
  const root = await freshRoot("shape");
  await writeLexicon(root, [{ term: "青霉素" }, { term: "星轨" }, { term: "药", avoid: ["草药"] }]);
  await writeWorldview(root, [{ name: "中式古代", basis: "中式古代客栈", bannedWords: ["上香"] }]);

  const text = "他眼中闪过一丝慌乱。\n他上香三炷。\n他掏出草药敷在伤口上。\n星轨在窗外交错。\n\n他终于明白，命运的序幕才刚刚开始。\n";
  const res = await audit(root, text);

  assert.ok(res.violations.length >= 4, "夹具应同时触发 lexicon / banned / slop / ending");
  const expectedKeys = ["contract", "detail", "line", "severity", "text", "title"];
  for (const v of res.violations) {
    assert.deepEqual(Object.keys(v).sort(), expectedKeys);
    for (const key of ["suggestion", "hint", "fix", "advice", "rewrite"]) {
      assert.equal(v[key], undefined, "不得出现建议性字段 " + key);
    }
  }
  // 排序：severity 降序 → contract 升序 → line 升序。
  for (let i = 1; i < res.violations.length; i += 1) {
    const a = res.violations[i - 1];
    const b = res.violations[i];
    assert.ok(a.severity > b.severity || (a.severity === b.severity && (a.contract < b.contract || (a.contract === b.contract && a.line <= b.line))));
  }
  assert.match(res.summary, /^严格对账：\d+ 条违约（其中 \d+ 条硬违约）；\d+ 项契约未跑/);
});

// ===========================================================================
// ⑨ 读盘与取消
// ===========================================================================

test("只给 chapterFile（不给 text）时从书库读正文", async () => {
  const root = await freshRoot("read");
  await writeFile(join(root, "novels", BOOK, "第04章.md"), "他推开门走了进去。", "utf8");
  const res = await runAuditContracts({ root, book: BOOK, chapterFile: "第04章.md" });
  assert.equal(res.file, "第04章.md");
  assert.equal(res.chapterNumber, 4);
  assert.equal(res.lines, 1);
});

test("exec.signal 已中止 → 抛 AbortError（不被吞成「契约未跑」）", async () => {
  const root = await freshRoot("abort");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => audit(root, "他推开门走了进去。", { exec: { signal: controller.signal } }),
    (error) => Boolean(error) && error.name === "AbortError"
  );
});

// ===========================================================================
// ⑩ 任务书（给另一个没有上下文的 AI）
// ===========================================================================

test("buildAuditBrief：禁止评价/取证格式/substring 约束都在，protocol 与 allowedContracts 一致", () => {
  const { brief, protocol, allowedContracts } = buildAuditBrief({
    book: BOOK,
    file: "第03章 雨夜.md",
    chapterNumber: 3,
    chapterText: "他推开门走了进去。",
    contracts: ["plot", "slop"]
  });

  assert.deepEqual(allowedContracts, ["slop", "plot"], "按契约定义的固定顺序");
  assert.ok(brief.includes("审计员"));
  assert.ok(brief.includes("不是编辑"));
  assert.ok(brief.includes("不许评价文笔"));
  assert.ok(brief.includes("举不出证据"));
  assert.ok(brief.includes('"claims"'));
  assert.ok(brief.includes("编造"));
  assert.ok(brief.includes("```text"));
  assert.ok(brief.includes("他推开门走了进去。"), "章节正文必须原样附在末尾");
  assert.equal(protocol.lineCount, 1);
  assert.deepEqual(protocol.allowedContracts, allowedContracts);
  assert.deepEqual(protocol.claimFields.contract.enum, allowedContracts);
  assert.equal(protocol.claimFields.line.min, 1);
  assert.equal(protocol.claimFields.line.max, 1);
  assert.equal(protocol.claimFields.why.maxChars, 40);
  assert.equal(protocol.verifyRules.textMustBeContinuousSubstring, true);
  assert.equal(protocol.verifyRules.rejectsFabricatedText, true);
});

test("buildAuditBrief：contracts=null → 8 条契约全部允许，空正文行数为 0", () => {
  const { allowedContracts, protocol } = buildAuditBrief({ chapterText: "" });
  assert.deepEqual(allowedContracts, ALL_CONTRACT_IDS);
  assert.equal(protocol.lineCount, 0);
  assert.equal(protocol.contracts.length, 8);
});

// ===========================================================================
// ⑨ v7.3.3 回归：#13（块行号容忍排版空白） / #12（slop 契约放行 AbortError）
// ===========================================================================

/** 7 段连续裸台词；第一段是**两行块**，两行之间的排版空白由参数控制。 */
function bareDialogueFixture(firstLine, secondLineIndent) {
  const lines = [firstLine, secondLineIndent + "她道。"];
  for (let i = 0; i < 6; i += 1) lines.push("", "“嗯。”", "她道。");
  return lines.join("\n") + "\n";
}

test("#13 bare_dialogue 行号：块内行首缩进 / 首行行尾空格不得退化成 line 0", async () => {
  const root = await freshRoot("bare-line-indent");
  const cases = [
    { tag: "无排版空白（基准）", text: bareDialogueFixture("“你回来了。”", "") },
    { tag: "块内第二行行首缩进", text: bareDialogueFixture("“你回来了。”", "  ") },
    { tag: "首行行尾多一个空格", text: bareDialogueFixture("“你回来了。” ", "") }
  ];
  for (const item of cases) {
    const res = await audit(root, item.text);
    const v = res.violations.find((x) => x.contract === "bare_dialogue");
    assert.ok(v, item.tag + "：应检出 bare_dialogue：" + JSON.stringify(res.violations.map((x) => x.contract)));
    // 旧行为（红）：块文本是逐行 trim 后拼的，整块 indexOf 落空 → line=0（编造不出证据行）。
    assert.equal(v.line, 1, item.tag + "：行号必须是首段真实起始行：" + v.line);
    assert.equal(v.text, "“你回来了。”", item.tag + "：证据片段必须取自真实行：" + v.text);
  }
  // 章首加一行标题 + 空行：真实起始行变成 3，行号必须跟着正文走（而不是恒 1 或 0）
  const shifted = await audit(root, "# 第二章\n\n" + bareDialogueFixture("“你回来了。” ", ""));
  const shiftedHit = shifted.violations.find((x) => x.contract === "bare_dialogue");
  assert.ok(shiftedHit, "有标题行时也应检出 bare_dialogue");
  assert.equal(shiftedHit.line, 3, "行号要跟着正文走：" + shiftedHit.line);
});

test("#12 slop 契约内出现 AbortError：必须上抛，不得吞成「读设定失败，不豁免」", async () => {
  const root = await freshRoot("slop-abort");
  const abort = Object.assign(new Error("取消"), { name: "AbortError" });
  // 只让 slop 契约的豁免构建抛取消：其它契约不调用 buildSlopExemptions，
  // 因此这条断言确实钉住 runSlopContract 内部的 catch（旧版会吞掉它并返回一份正常对账结果）。
  await assert.rejects(
    () => audit(root, "他眼中闪过一丝慌乱。\n", { options: { deps: { buildSlopExemptions: () => { throw abort; } } } }),
    (e) => Boolean(e) && e.name === "AbortError",
    "取消被吞掉了：旧版 catch 会把 AbortError 讲成「读设定失败，不豁免」继续跑完"
  );
});
