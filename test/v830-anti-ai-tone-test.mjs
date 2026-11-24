/**
 * test/v830-anti-ai-tone-test.mjs —— dsh-novel-writer v8.3.0 反 AI 腔与句式节奏回归测试套件
 *
 * 覆盖四大模块分组：
 *   1. lib/lexicons/slop.js（规则总量与正则安全、新增/放宽 ai_ese 正负样本、对白静音、作者习惯豁免、模式级处方自扫）
 *   2. lib/chapter-diagnose.js（scanCadenceMonotony 三类确认门/非重叠步进/换行对齐/对白与 Markdown 跳过/denseEnums + diagnoseChapterSymptoms 7 键契约）
 *   3. lib/fixplan.js（AI 套话与句式单调端到端 plan → mark → verify 闭环、行号漂移身份稳定、单处 denseEnum 不误报、按书基线自动豁免）
 *   4. lib/prompts.js & skills/novel-writing/SKILL.md（最小改动/信息守恒文案、长度预算红线、导出符号契约）
 *
 * 隔离保证：
 *   - test.before 在动态 import 任何 lib/* 之前，把 DSH_NOVEL_WRITER_STATE 与 DSH_HOME 指向 mkdtempSync 临时目录；
 *   - 全程校验真实 ~/.dsh/dsh-novel-writer 与 ~/.gemini/config 递归 SHA-256 零变动；
 *   - test.after（外加 process exit 兜底）恢复环境变量并彻底删除临时目录。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// 真实用户目录 SHA-256 快照与临时隔离夹具（零顶层 lib/* 导入）
// ─────────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = dirname(__dirname);

const PREV_STATE_ENV = process.env.DSH_NOVEL_WRITER_STATE;
const PREV_HOME_ENV = process.env.DSH_HOME;

const REAL_DSH_DIR = join(homedir(), ".dsh", "dsh-novel-writer");
const REAL_GEMINI_CONFIG_DIR = join(homedir(), ".gemini", "config");

function digestTree(dir) {
  if (!existsSync(dir)) return "absent";
  const entries = [];
  const walk = (base, rel) => {
    let items;
    try {
      items = readdirSync(base, { withFileTypes: true });
    } catch {
      entries.push(rel + ":unreadable");
      return;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of items) {
      const full = join(base, e.name);
      const sub = rel === "" ? e.name : rel + "/" + e.name;
      if (e.isDirectory()) {
        entries.push(sub + "/");
        walk(full, sub);
      } else if (e.isFile()) {
        try {
          const h = createHash("sha256").update(readFileSync(full)).digest("hex");
          entries.push(sub + ":" + h);
        } catch {
          entries.push(sub + ":unreadable");
        }
      } else {
        try {
          const st = lstatSync(full);
          entries.push(sub + ":other:" + st.size);
        } catch {
          entries.push(sub + ":other");
        }
      }
    }
  };
  walk(dir, "");
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

const realBefore = {
  dsh: digestTree(REAL_DSH_DIR),
  geminiConfig: digestTree(REAL_GEMINI_CONFIG_DIR)
};

let tempRoot = "";
let validatePattern;
let SLOP_CATEGORIES;
let SLOP_RULES;
let scanSlop;
let buildSlopExemptions;
let describeSlopPrescription;
let scanCadenceMonotony;
let diagnoseChapterSymptoms;
let buildFixPlan;
let verifyFixPlan;
let markFixItem;
let promptsMod;

function restoreEnvAndCleanup() {
  if (PREV_STATE_ENV === undefined) delete process.env.DSH_NOVEL_WRITER_STATE;
  else process.env.DSH_NOVEL_WRITER_STATE = PREV_STATE_ENV;
  if (PREV_HOME_ENV === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_HOME_ENV;
  if (tempRoot && existsSync(tempRoot)) {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // 忽略 Windows 句柄延迟释放的二次清理异常
    }
  }
}

process.on("exit", restoreEnvAndCleanup);

test.before(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "dsh-v830-anti-ai-tone-"));
  const tempDshHome = join(tempRoot, "dsh-home");
  mkdirSync(tempDshHome, { recursive: true });
  process.env.DSH_HOME = tempDshHome;
  process.env.DSH_NOVEL_WRITER_STATE = join(tempDshHome, "state.json");

  const coreMod = await import("../lib/core.js");
  const slopMod = await import("../lib/lexicons/slop.js");
  const diagMod = await import("../lib/chapter-diagnose.js");
  const fixMod = await import("../lib/fixplan.js");
  promptsMod = await import("../lib/prompts.js");

  validatePattern = coreMod.validatePattern;
  SLOP_CATEGORIES = slopMod.SLOP_CATEGORIES;
  SLOP_RULES = slopMod.SLOP_RULES;
  scanSlop = slopMod.scanSlop;
  buildSlopExemptions = slopMod.buildSlopExemptions;
  describeSlopPrescription = slopMod.describeSlopPrescription;
  scanCadenceMonotony = diagMod.scanCadenceMonotony;
  diagnoseChapterSymptoms = diagMod.diagnoseChapterSymptoms;
  buildFixPlan = fixMod.buildFixPlan;
  verifyFixPlan = fixMod.verifyFixPlan;
  markFixItem = fixMod.markFixItem;
});

test.after(() => {
  const realAfter = {
    dsh: digestTree(REAL_DSH_DIR),
    geminiConfig: digestTree(REAL_GEMINI_CONFIG_DIR)
  };
  restoreEnvAndCleanup();
  assert.deepEqual(realAfter, realBefore, "real ~/.dsh/dsh-novel-writer or ~/.gemini/config was modified");
});

// ─────────────────────────────────────────────────────────────────────────────
// 公共夹具：临时作品目录写入器 & 可复用清洁测试样本
// ─────────────────────────────────────────────────────────────────────────────

function createTempBook(prefix, bookName, chapters) {
  const root = mkdtempSync(join(tempRoot, prefix + "-"));
  const dir = join(root, "novels", bookName);
  mkdirSync(dir, { recursive: true });
  for (const [fileName, content] of Object.entries(chapters)) {
    writeFileSync(join(dir, fileName), content, "utf8");
  }
  return { root, dir };
}

const TRIPLE_SAME_START = [
  "他站在巷口石阶边，盯着湿漉漉的瓦檐没动。",
  "他提着半旧铜油灯，顺着墙根慢慢往里走去。",
  "他靠在斑驳木门旁，听着屋里茶盏落桌的响声。"
];

const TRIPLE_SAME_START_2 = [
  "她拂去桌角浮尘，把几页旧信折整齐塞进抽屉。",
  "她拧紧水壶铁盖，把凉透的茶水倒进窗外花盆。",
  "她合上账本封皮，把磨秃的炭笔放回木匣深处。"
];

const TRIPLE_QUESTION = [
  "城门还没彻底落锁，守夜班子为何先撤了岗？",
  "库房门闩完好无损，里头账册怎会少了一匣？",
  "渡口木船刚刚靠岸，船老大为何连夜换了舵？"
];

const TRIPLE_MULTI_CLAUSE = [
  "晨雾压低了河面，渡船靠着石桩晃荡，老船夫拢起袖口点烟。",
  "北风吹响了檐铃，茶炉冒出淡白热气，小伙计端起砂锅倒水。",
  "石街铺满了落叶，板车压过浅浅水洼，赶车人甩开鞭梢喝马。"
];

const DENSE_ENUM_1 = "长案上堆着青铜香炉、描金漆盒、素面玉圭、铁皮账匣，积满浮尘。";
const DENSE_ENUM_2 = "库房里码着粗麻绳索、旧油纸伞、沉重桐油桶、铁皮灯罩、灰布麻袋，排到屋梁。";
const DENSE_ENUM_3 = "后院晾着青布长衫、粗麻围裙、洗白短褂、补丁布鞋，随风轻晃。";
const DENSE_ENUM_4 = "灶台上摆着粗瓷大碗、铁皮菜刀、竹编蒸笼、豁口陶罐，齐齐整整。";

const CLEAN_VARIED_PARAGRAPH =
  "夜雨停在三更前。陈默拉开门闩，廊下石阶还湿着，风从院角竹林里吹过来。他拎起竹篮去灶房添了两勺凉水，又顺手把铁壶坐到余烬上，等水汽慢慢顶起壶盖。";

// ═════════════════════════════════════════════════════════════════════════════
// Group 1: lib/lexicons/slop.js
// ═════════════════════════════════════════════════════════════════════════════

test("Group 1.1: SLOP_CATEGORIES frozen 8 keys, SLOP_RULES=77, ai_ese=14, all pass validatePattern ok", () => {
  assert.equal(Object.isFrozen(SLOP_CATEGORIES), true);
  assert.deepEqual(Object.keys(SLOP_CATEGORIES), [
    "eye_cliche",
    "smirk_cliche",
    "shock_crowd",
    "filler_transition",
    "abstract_tell",
    "ending_preach",
    "ai_ese",
    "stat_numeric"
  ]);

  assert.equal(Object.isFrozen(SLOP_RULES), true);
  assert.equal(SLOP_RULES.length, 77);
  const aiRules = SLOP_RULES.filter((r) => r.category === "ai_ese");
  assert.equal(aiRules.length, 14);

  for (const rule of SLOP_RULES) {
    const verdict = validatePattern(rule.source);
    assert.equal(
      verdict.level,
      "ok",
      `Rule /${rule.source}/ (${rule.category}) failed validatePattern: ${verdict.level} ${verdict.reason || ""}`
    );
    assert.equal(verdict.ok, true, `Rule /${rule.source}/ should have ok=true`);
  }
});

test("Group 1.2: new & broadened ai_ese rules — positive hits and near-miss negative 0-hit checks", () => {
  const cases = [
    {
      name: "antithesis (不是…而是 / 并非…而是 / 不在于…而在于)",
      positives: [
        "他停步不是为了歇脚，而是盯住了瓦片上的湿痕。",
        "那道裂痕并非刀劈出来的，而是冻裂的。",
        "症结不在于门锁松动，而在于钥匙换过。",
        "这把铁锁不是坏了而是锈死了。"
      ],
      negatives: [
        "那人不是陈伯，是隔壁茶铺的伙计。",
        "他并非故意迟到，只是半路塌了桥。",
        "院子不在于大，住着顺心就行。",
        "这并非一时起意。而是隔年秋后才定下来的。"
      ]
    },
    {
      name: "commentary contrast (与其说…不如说 / 看似…实则 / 表面上…实际上)",
      positives: [
        "与其说他在听戏，不如说他在数门外的脚步。",
        "那扇木门看似虚掩着，实则里头顶了铁闩。",
        "巷口表面上风平浪静，实际上早换了暗哨。",
        "账册表面干净，实则少了三页。",
        "他看似退让，实际上攥紧了袖里的短刃。"
      ],
      negatives: [
        "她嘴上答应得好听，转身就把茶泼进了炭盆。",
        "木门看似破旧，推起来却沉得很。",
        "桌面表面积了薄灰，指尖一抹就是一道印。",
        "与其干等，不如先去后院看看。"
      ]
    },
    {
      name: "translationese temporal clause (当…时， with lexicalized-当 guards)",
      positives: [
        "当他推开那扇木门时，廊下的油灯晃了一下。",
        "当暴雨砸在屋檐上之时，廊柱溅起一片水雾。",
        "当马车拐过城门的时候，车帘被人掀开一角。"
      ],
      negatives: [
        "当时，他正蹲在灶边添柴。",
        "当天傍晚收摊时，巷口还剩两盏灯笼。",
        "当年离家赴考时，母亲只塞了一包干粮。",
        "当初定下契约的时候，两家都在场。",
        "当晚暴雨倾盆之时，码头已经封了渡口。",
        "当夜巡逻换班时，墙根多出一双湿鞋印。",
        "他应当在天黑前赶回城时，先把马拴稳。",
        "事情理所当然拖到天黑时，客人都散了。",
        "这事办得相当妥当收尾时，已近三更。",
        "别上当受骗吃亏时，才想起翻旧账。",
        "他担当重任起程时，额头全是细汗。",
        "当他推门进去时天已黑了。"
      ]
    },
    {
      name: "nested 的…的 modifier (excluding 、 parallel phrases)",
      positives: [
        "角落里放着一个布满划痕的泛着冷光的铁匣。",
        "街角立着那座年久失修的挂满蛛网的旧戏楼。",
        "箱底压着一套从南方捎来的浸过桐油的竹简。",
        "屋里飘着一种混着松烟的带着铁锈味的浓烟。"
      ],
      negatives: [
        "院里摆着一个擦得发亮的、刷过红漆的木柜。",
        "他走到那座老旧的、没人住的院子前。",
        "他走到那座老旧的，早没人住的院子前。",
        "他拎起一个沾满泥点的竹篮。",
        "桌上是他母亲留下的褪了色的铜镜。"
      ]
    },
    {
      name: "broadened topic shell (对于…来说 / 对于…而言 / 就…而言, keeping 对他来说 clean)",
      positives: [
        "对于陈默来说，这笔账早就烂在心里。",
        "对于老船夫而言，这条水路闭着眼都能划。",
        "就眼下的局势而言，先撤出去更稳妥。"
      ],
      negatives: [
        "对他来说，这把旧刀比命还重。",
        "对于这件事，他一言不发。",
        "他就站在巷口，一声不吭。",
        "对于这个突如其来让人完全摸不着头脑的旧案子而言，他懒得多问。"
      ]
    }
  ];

  for (const group of cases) {
    for (const text of group.positives) {
      const res = scanSlop(text);
      assert.ok(
        res.byCategory.ai_ese >= 1,
        `[${group.name}] positive expected >=1 ai_ese hit, got ${res.byCategory.ai_ese}: ${text}`
      );
    }
    for (const text of group.negatives) {
      const res = scanSlop(text);
      assert.equal(
        res.total,
        0,
        `[${group.name}] negative expected 0 hits, got ${JSON.stringify(res.hits)}: ${text}`
      );
    }
  }
});

test("Group 1.3: quoted dialogue muting (skipQuoted true vs false) on new ai_ese patterns", () => {
  const dialogueOnly = [
    "陈默道：“这事不是你拖的，而是账房卡住了。”",
    "老人笑道：「与其说他胆小，不如说他怕露底。」",
    "伙计低声道：『当他推开那扇木门时，灯刚好灭了。』",
    "她叹道：“角落里有一个布满划痕的泛着冷光的铁匣。”",
    '他摇头道："对于咱们来说，眼下就别再掺和了。"'
  ].join("\n");

  const muted = scanSlop(dialogueOnly);
  assert.equal(muted.total, 0);
  assert.equal(muted.byCategory.ai_ese, 0);

  const mutedExplicit = scanSlop(dialogueOnly, { skipQuoted: true });
  assert.equal(mutedExplicit.total, 0);

  const unmuted = scanSlop(dialogueOnly, { skipQuoted: false });
  assert.equal(unmuted.byCategory.ai_ese, 5);
  assert.equal(unmuted.total, 5);
  assert.deepEqual(
    unmuted.hits.map((h) => h.line),
    [1, 2, 3, 4, 5]
  );

  // 引号外叙述仍正常检出，引号内同规则保持静音
  const mixed = "“这不是你的错，而是天意。”他低头擦刀，并非怕惹麻烦，而是不想惊动邻院。";
  const mixedRes = scanSlop(mixed, { skipQuoted: true });
  assert.equal(mixedRes.byCategory.ai_ese, 1);
  assert.match(mixedRes.hits[0].text, /并非.*而是/);
});

test("Group 1.4: buildSlopExemptions auto-exempts repeated 不是…而是 author habit (≥500 chars, ≥2 hits, ≥0.5/1000)", () => {
  const filler =
    "雨丝落到院心青石板上，溅起一层细密的水雾。陈默收起竹伞靠在廊柱边，伸手拍了拍肩头的潮气，推门进了里屋。灶上的泥炉还留着一点暗红炭火，他拿铁钳夹起两块干柴架进去，水壶很快响起细微的嘶嘶声。";
  const habitCorpus = [
    filler,
    "他停下脚步不是为了歇脚，而是盯住了瓦片上的湿痕。",
    filler,
    filler,
    "那道裂痕不是刀劈出来的，而是寒夜冻裂的。",
    filler,
    filler,
    "这封信不是托驿站送来的，而是半夜塞进门缝的。",
    filler
  ].join("\n");

  assert.ok(habitCorpus.length >= 500, `corpus length ${habitCorpus.length} should be >= 500`);

  const exemptions = buildSlopExemptions(habitCorpus);
  assert.ok(
    exemptions.exemptRules.some((src) => src.includes("不是") && src.includes("而是")),
    "expected antithesis rule source to be exempted"
  );

  // 短于 500 字的参照语料不得豁免
  const shortCorpus = "他不是怕冷，而是手伤未愈。她不是不信，而是不想追问。";
  assert.ok(shortCorpus.length < 500);
  assert.equal(buildSlopExemptions(shortCorpus).exemptRules.length, 0);

  // 目标章含习惯句式 + 非习惯翻译腔：习惯句式被豁免，其余 ai_ese 照常报出
  const chapter = [
    "这回他绕路不是为了避雨，而是想看看后巷的门锁。",
    "当他推开那扇木门时，廊下的油灯晃了一下。"
  ].join("\n");

  const rawScan = scanSlop(chapter);
  assert.equal(rawScan.byCategory.ai_ese, 2);

  const exemptScan = scanSlop(chapter, exemptions);
  assert.equal(exemptScan.byCategory.ai_ese, 1);
  assert.match(exemptScan.hits[0].text, /当他推开那扇木门时/);
});

test("Group 1.5: describeSlopPrescription(['ai_ese']) gives pattern-level guidance and self-scans to 0 slop hits", () => {
  const prescription = describeSlopPrescription(["ai_ese"]);
  assert.equal(typeof prescription, "string");
  assert.ok(prescription.length > 0);
  assert.match(prescription, /先否后立|对举/);
  assert.match(prescription, /翻译腔|长定语/);
  assert.match(prescription, /修饰壳/);
  assert.doesNotMatch(prescription, /毫无疑问|不是.*而是|与其说/);

  assert.equal(scanSlop(prescription).total, 0);
  assert.equal(scanSlop(prescription, { skipQuoted: false }).total, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 2: lib/chapter-diagnose.js (scanCadenceMonotony & diagnoseChapterSymptoms)
// ═════════════════════════════════════════════════════════════════════════════

test("Group 2.1: scanCadenceMonotony defensive inputs never throw and return empty shape", () => {
  const empty = { triples: [], denseEnums: [], total: 0 };
  for (const input of ["", "   \n\t  ", null, undefined, 0, 42, NaN, {}, []]) {
    assert.deepEqual(scanCadenceMonotony(input), empty);
  }
});

test("Group 2.2: scanCadenceMonotony triples — all 3 confirmations, advance-by-3, and LF/CRLF/CR line alignment", () => {
  // 确认门 1：同起手字（1 逗号陈述句）
  const resSameStart = scanCadenceMonotony(TRIPLE_SAME_START.join(""));
  assert.equal(resSameStart.triples.length, 1);
  assert.equal(resSameStart.denseEnums.length, 0);
  assert.equal(resSameStart.total, 1);
  assert.deepEqual(resSameStart.triples[0].sentences, TRIPLE_SAME_START);

  // 确认门 2：三连问（不同起手字、1 逗号问句）
  const resQuestion = scanCadenceMonotony(TRIPLE_QUESTION.join(""));
  assert.equal(resQuestion.triples.length, 1);
  assert.equal(resQuestion.total, 1);
  assert.deepEqual(resQuestion.triples[0].sentences, TRIPLE_QUESTION);

  // 确认门 3：2 逗号多分句等长槽位同构（不同起手字、陈述句）
  const resMultiClause = scanCadenceMonotony(TRIPLE_MULTI_CLAUSE.join(""));
  assert.equal(resMultiClause.triples.length, 1);
  assert.equal(resMultiClause.total, 1);
  assert.deepEqual(resMultiClause.triples[0].sentences, TRIPLE_MULTI_CLAUSE);

  // 非重叠步进（idx += 3）：6 句连排同构产出 2 组，不是 4 组
  const sixClones = [
    ...TRIPLE_SAME_START,
    "他掀开厚重蓝布帘，望着后院晾晒的衣裳出神。",
    "他摸出袖里铜钥匙，对着锈住的门锁拧了半圈。",
    "他退回檐下石墩旁，望着远处飘起的炊烟发呆。"
  ];
  const resSix = scanCadenceMonotony(sixClones.join(""));
  assert.equal(resSix.triples.length, 2);
  assert.equal(resSix.total, 2);
  assert.deepEqual(resSix.triples[0].sentences, sixClones.slice(0, 3));
  assert.deepEqual(resSix.triples[1].sentences, sixClones.slice(3, 6));

  // LF / CRLF / CR 三种换行给出完全一致的 1-based 行号
  const lfLines = [
    "# 第七章 巷口夜雨",
    "",
    CLEAN_VARIED_PARAGRAPH,
    "",
    TRIPLE_SAME_START[0],
    TRIPLE_SAME_START[1],
    TRIPLE_SAME_START[2],
    "",
    DENSE_ENUM_1
  ];
  const lfText = lfLines.join("\n");
  const crlfText = lfLines.join("\r\n");
  const crText = lfLines.join("\r");

  const rLf = scanCadenceMonotony(lfText);
  const rCrlf = scanCadenceMonotony(crlfText);
  const rCr = scanCadenceMonotony(crText);

  assert.equal(rLf.triples.length, 1);
  assert.equal(rLf.triples[0].lineStart, 5);
  assert.equal(rLf.triples[0].lineEnd, 7);
  assert.equal(rLf.denseEnums.length, 1);
  assert.equal(rLf.denseEnums[0].line, 9);
  assert.equal(rLf.total, 2);
  assert.deepEqual(rCrlf, rLf);
  assert.deepEqual(rCr, rLf);
});

test("Group 2.3: scanCadenceMonotony triples negatives — terse beats, varied prose, quoted dialogue & adjacency break, Markdown", () => {
  // 短促动作节拍（< 14 汉字，含 13 汉字边界）→ 0 命中
  const shortTerse = "他抬起手，推开了门。他迈进屋，放下了刀。他吹熄灯，坐上木凳。";
  assert.equal(scanCadenceMonotony(shortTerse).triples.length, 0);

  const boundary13Han = [
    "他推开老旧木门，走进了黑屋里。",
    "他放下粗瓷茶碗，坐到了石凳上。",
    "他掀开蓝布门帘，望向了院墙外。"
  ].join("");
  assert.equal(scanCadenceMonotony(boundary13Han).triples.length, 0);

  // 正常有变化的叙事散文 & 不同起手单逗号陈述句（未过确认门）→ 0 命中
  const variedNoConfirm = [
    "雨丝斜斜打在窗纸上，屋里的灯火微微晃了晃。",
    "灶台下的余烬早冷透，铁壶口不再冒出白汽。",
    "巷尾的打更声隔墙传来，惊飞了檐下栖着的麻雀。"
  ].join("");
  assert.equal(scanCadenceMonotony(variedNoConfirm).triples.length, 0);
  assert.equal(scanCadenceMonotony(CLEAN_VARIED_PARAGRAPH).triples.length, 0);

  // 引号对白即使 3 句完全同构也必须静音 → 0 命中
  const quotedTriplesCn = TRIPLE_SAME_START.map((s) => `“${s}”`).join("");
  assert.equal(scanCadenceMonotony(quotedTriplesCn).triples.length, 0);

  const quotedTriplesCorner = TRIPLE_SAME_START.map((s) => `「${s}」`).join("");
  assert.equal(scanCadenceMonotony(quotedTriplesCorner).triples.length, 0);

  // 中文跨段未闭合开引号按对白静音 → 0 命中
  const unclosedLeadQuote = "“" + TRIPLE_SAME_START.join("");
  assert.equal(scanCadenceMonotony(unclosedLeadQuote).triples.length, 0);

  // 对白必须打断前后旁白句子的邻接性（2 句同构 + 1 句对白 + 2 句同构 → 0 命中）
  const brokenAdjacency = [
    TRIPLE_SAME_START[0],
    TRIPLE_SAME_START[1],
    "“别出声，先听院外动静。”",
    TRIPLE_SAME_START[2],
    "他掀开厚重蓝布帘，望着后院晾晒的衣裳出神。"
  ].join("");
  assert.equal(scanCadenceMonotony(brokenAdjacency).triples.length, 0);

  // Markdown 标题、代码块、列表、引用、表格、分隔线全部跳过
  const mdDoc = [
    "# " + TRIPLE_SAME_START.join(""),
    "## " + DENSE_ENUM_1,
    "---",
    "```markdown",
    TRIPLE_SAME_START.join("\n"),
    DENSE_ENUM_1,
    "```",
    "- " + TRIPLE_SAME_START.join(""),
    "1. " + DENSE_ENUM_2,
    "> " + TRIPLE_SAME_START.join(""),
    "> " + DENSE_ENUM_1,
    "| 栏目 | " + TRIPLE_SAME_START.join("") + " | " + DENSE_ENUM_1 + " |"
  ].join("\n");
  assert.deepEqual(scanCadenceMonotony(mdDoc), { triples: [], denseEnums: [], total: 0 });
});

test("Group 2.4: scanCadenceMonotony denseEnums — ≥4 items vs 3 items, <12 Han, quoted dialogue, Markdown skip", () => {
  // 4 项（3 顿号）+ ≥12 汉字 → 命中
  const r4 = scanCadenceMonotony(DENSE_ENUM_1);
  assert.equal(r4.denseEnums.length, 1);
  assert.equal(r4.denseEnums[0].line, 1);
  assert.equal(r4.denseEnums[0].items, 4);
  assert.match(r4.denseEnums[0].clause, /青铜香炉/);
  assert.equal(r4.total, 1);

  // 5 项（4 顿号）+ ≥12 汉字 → 命中且 items=5
  const r5 = scanCadenceMonotony(DENSE_ENUM_2);
  assert.equal(r5.denseEnums.length, 1);
  assert.equal(r5.denseEnums[0].items, 5);

  // 3 项（2 顿号）→ 0 命中
  const threeItems = "长案上堆着青铜香炉、描金漆盒、素面玉圭，积满浮尘。";
  assert.equal(scanCadenceMonotony(threeItems).denseEnums.length, 0);

  // 4 项但分句不足 12 汉字 → 0 命中
  const shortEnum = "桌上摆着酒、茶、醋、盐。";
  assert.equal(scanCadenceMonotony(shortEnum).denseEnums.length, 0);

  // 引号对白里的菜名/物品清单 → 0 命中
  const quotedMenu = "伙计报菜名道：“今日有清蒸鲈鱼、红焖肘子、椒盐排骨、桂花糯米藕，客官要哪样？”";
  assert.equal(scanCadenceMonotony(quotedMenu).denseEnums.length, 0);

  // 列表 / 标题 / 代码块 / 引用行里的密集并列 → 0 命中
  const structuralEnums = [
    "### " + DENSE_ENUM_1,
    "- " + DENSE_ENUM_2,
    "* " + DENSE_ENUM_3,
    "2. " + DENSE_ENUM_4,
    "```",
    DENSE_ENUM_1,
    "```"
  ].join("\n");
  assert.equal(scanCadenceMonotony(structuralEnums).denseEnums.length, 0);
});

test("Group 2.5: diagnoseChapterSymptoms strictly returns only keys from the frozen 7-key union", () => {
  const ALLOWED_7_KEYS = new Set([
    "ending_preach",
    "bare_dialogue",
    "slop",
    "abstract",
    "action_thin",
    "sense_mono",
    "object_thin"
  ]);

  // 纯句式单调章节（无 7 键症状）→ 不新增任何新 key
  const cadenceOnlyChapter = [
    TRIPLE_SAME_START.join(""),
    "",
    DENSE_ENUM_1,
    "",
    DENSE_ENUM_2,
    "",
    "他拉开门闩，拎着木桶走出院门。"
  ].join("\n");
  assert.ok(scanCadenceMonotony(cadenceOnlyChapter).total >= 3);
  const cadenceDiag = diagnoseChapterSymptoms(cadenceOnlyChapter, null);
  for (const s of cadenceDiag) {
    assert.ok(ALLOWED_7_KEYS.has(s.key), `unexpected symptom key: ${s.key}`);
  }
  assert.equal(cadenceDiag.length, 0);

  // 叠加多种症状 + refStats（触发结构性 + 相对类症状）→ 全部 key 严格落入 7 键集合
  const heavyChapter = [
    TRIPLE_SAME_START.join(""),
    DENSE_ENUM_1,
    DENSE_ENUM_2,
    "“走了。”他道。",
    "“去哪？”她道。",
    "“城北。”他道。",
    "“现在？”她道。",
    "“马上。”他道。",
    "“好吧。”她道。",
    "毫无疑问，他不是为了歇脚，而是为了等风停。事实上，与其说他在等信，不如说他在等一场风暴。当他推开木门时，一切不可避免地滑向深渊。",
    "",
    "他终于明白，命运的齿轮才刚刚开始转动，未来的路还很长，没有人知道等待他的是什么。"
  ].join("\n").repeat(3);

  const mockRefStats = {
    chapters: 5,
    avgChars: 1000,
    abstractDensity: { p10: 1, p50: 2, p85: 3, p95: 4 },
    actionVerbsPer1000: { p10: 80, p50: 100, p85: 120, p95: 140 },
    objectNounsPer1000: { p10: 80, p50: 100, p85: 120, p95: 140 },
    senseChannels: {
      visual: { p10: 10, p50: 15, p85: 20, p95: 25 },
      auditory: { p10: 5, p50: 8, p85: 12, p95: 15 },
      tactile: { p10: 5, p50: 8, p85: 12, p95: 15 },
      olfactory: { p10: 3, p50: 5, p85: 8, p95: 10 },
      temperature: { p10: 3, p50: 5, p85: 8, p95: 10 }
    },
    bareDialogueRun: { p50: 2, p95: 4, max: 5 }
  };

  const fullDiag = diagnoseChapterSymptoms(heavyChapter, mockRefStats);
  assert.ok(fullDiag.length >= 3, "expected multiple symptoms to fire on synthetic heavy chapter");
  for (const s of fullDiag) {
    assert.ok(ALLOWED_7_KEYS.has(s.key), `unexpected symptom key: ${s.key}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 3: lib/fixplan.js end-to-end loop
// ═════════════════════════════════════════════════════════════════════════════

test("Group 3.1: new ai_ese hits produce 1 AI套话 (ai_ese) item; fixing all hits marks resolved in verifyFixPlan", async () => {
  const book = "反AI腔闭环测试";
  const dirtyText = [
    "陈默站在院门边，不是为了避雨，而是为了看清巷口的脚印。",
    "当他推开那扇木门时，灶房里的炉火闪了一下。",
    "与其说他在翻旧账，不如说他在找一枚丢了三年的铜扣。",
    "角落里放着一个布满划痕的泛着冷光的铁匣。",
    "对于老船夫来说，这封信早就没必要再拆开。"
  ].join("\n");

  const { root, dir } = createTempBook("fix-aiese", book, { "第01章.md": dirtyText });

  const plan = await buildFixPlan(root, book, "1");
  const aiItems = plan.items.filter((it) => it.type === "AI套话" && it.current.startsWith("类别：ai_ese"));
  assert.equal(aiItems.length, 1);
  assert.match(aiItems[0].current, /命中 5 处/);

  const fixedText = [
    "陈默站在院门边，盯紧了巷口的脚印。",
    "他推开木门，灶房里的炉火闪了一下。",
    "他翻过半摞旧账，指腹摸索着那枚丢了三年的铜扣。",
    "角落里放着铁匣，盖面划痕交错，映着窗外冷光。",
    "老船夫把信压到茶碗底下，没再拆开。"
  ].join("\n");
  writeFileSync(join(dir, "第01章.md"), fixedText, "utf8");

  const verify = await verifyFixPlan(root, book, "1");
  const checkedAi = verify.checked.find((c) => c.id === aiItems[0].id);
  assert.ok(checkedAi, "expected original AI套话 item in verify.checked");
  assert.equal(checkedAi.status, "resolved");
  assert.equal(verify.checked.filter((c) => c.type === "AI套话" && c.status === "new").length, 0);
});

test("Group 3.2: 1 cadence_triple + 2 denseEnums produce 句式单调 items (severity 2..3, effort 2); 2 triples + 4 denseEnums escalate to severity 3", async () => {
  const book1 = "句式单调轻度";
  const chapterLight = [
    TRIPLE_SAME_START.join(""),
    "",
    DENSE_ENUM_1,
    "",
    DENSE_ENUM_2
  ].join("\n");
  const { root: root1 } = createTempBook("fix-cadence-light", book1, { "第01章.md": chapterLight });

  const plan1 = await buildFixPlan(root1, book1, "1");
  const cadence1 = plan1.items.filter((it) => it.type === "句式单调");
  assert.equal(cadence1.length, 2);

  const tripleItem = cadence1.find((it) => it.current.startsWith("类型：cadence_triple"));
  const enumItem = cadence1.find((it) => it.current.startsWith("类型：cadence_enum"));
  assert.ok(tripleItem, "expected cadence_triple item");
  assert.ok(enumItem, "expected cadence_enum item");
  assert.equal(tripleItem.severity, 2);
  assert.equal(tripleItem.effort, 2);
  assert.equal(enumItem.severity, 2);
  assert.equal(enumItem.effort, 2);

  // 2 处 triple + 4 处 denseEnum → 保守最高 severity = 3, effort = 2
  const book2 = "句式单调中度";
  const chapterHeavy = [
    TRIPLE_SAME_START.join(""),
    "",
    TRIPLE_SAME_START_2.join(""),
    "",
    DENSE_ENUM_1,
    DENSE_ENUM_2,
    DENSE_ENUM_3,
    DENSE_ENUM_4
  ].join("\n");
  const { root: root2 } = createTempBook("fix-cadence-heavy", book2, { "第01章.md": chapterHeavy });
  const plan2 = await buildFixPlan(root2, book2, "1");
  const cadence2 = plan2.items.filter((it) => it.type === "句式单调");
  assert.equal(cadence2.length, 2);
  for (const it of cadence2) {
    assert.equal(it.severity, 3);
    assert.equal(it.effort, 2);
  }
});

test("Group 3.3: chapter with ONLY 1 denseEnum produces 0 cadence_enum items (no false positive)", async () => {
  const book = "单处顿号不误报";
  const chapter = [CLEAN_VARIED_PARAGRAPH, "", DENSE_ENUM_1, "", "他合上木箱，转身吹熄了桌边灯火。"].join("\n");
  assert.equal(scanCadenceMonotony(chapter).denseEnums.length, 1);

  const { root } = createTempBook("fix-single-enum", book, { "第01章.md": chapter });
  const plan = await buildFixPlan(root, book, "1");
  const cadenceItems = plan.items.filter((it) => it.type === "句式单调");
  assert.equal(cadenceItems.length, 0);
});

test("Group 3.4: identity stability across line shifts (prepend blank lines + fix 1 of 2 triples → pending, 0 resolved, 0 new; fix remaining → resolved)", async () => {
  const book = "行号漂移身份稳定";
  const twoTriples = [
    ...TRIPLE_SAME_START,
    "",
    ...TRIPLE_SAME_START_2
  ].join("\n");
  const { root, dir } = createTempBook("fix-shift", book, { "第01章.md": twoTriples });

  const plan = await buildFixPlan(root, book, "1");
  const tripleItems = plan.items.filter((it) => it.type === "句式单调" && it.current.startsWith("类型：cadence_triple"));
  assert.equal(tripleItems.length, 1);
  const orig = tripleItems[0];
  assert.equal(orig.locate.lineStart, 1);
  assert.equal(orig.severity, 3);

  // 章首新增 3 个空行（行号整体偏移）并修掉第 1 处 triple，仅留第 2 处
  const partialFixed = [
    "",
    "",
    "",
    CLEAN_VARIED_PARAGRAPH,
    "",
    ...TRIPLE_SAME_START_2
  ].join("\n");
  writeFileSync(join(dir, "第01章.md"), partialFixed, "utf8");

  const v1 = await verifyFixPlan(root, book, "1");
  const cadenceChecked1 = v1.checked.filter((c) => c.type === "句式单调");
  assert.equal(cadenceChecked1.length, 1);
  assert.equal(cadenceChecked1[0].id, orig.id);
  assert.equal(cadenceChecked1[0].status, "pending");
  assert.equal(v1.checked.filter((c) => c.status === "resolved").length, 0);
  assert.equal(v1.checked.filter((c) => c.status === "new").length, 0);

  // 修掉剩余第 2 处 triple → resolved
  const allFixed = [
    "",
    "",
    "",
    CLEAN_VARIED_PARAGRAPH,
    "",
    "她抹干净桌角浮尘，把旧信塞进抽屉后顺手锁死。"
  ].join("\n");
  writeFileSync(join(dir, "第01章.md"), allFixed, "utf8");

  const v2 = await verifyFixPlan(root, book, "1");
  const resolvedItem = v2.checked.find((c) => c.id === orig.id);
  assert.ok(resolvedItem, "expected original cadence_triple item in v2.checked");
  assert.equal(resolvedItem.status, "resolved");
  assert.equal(v2.checked.filter((c) => c.type === "句式单调" && c.status !== "resolved").length, 0);
});

test("Group 3.5: markFixItem(..., 'skip') on 句式单调 is preserved across buildFixPlan even after line numbers shift", async () => {
  const book = "跳过状态跨行号保留";
  const initial = [
    ...TRIPLE_SAME_START,
    "",
    DENSE_ENUM_1,
    "",
    DENSE_ENUM_2
  ].join("\n");
  const { root, dir } = createTempBook("fix-skip-preserve", book, { "第01章.md": initial });

  const plan1 = await buildFixPlan(root, book, "1");
  const triple1 = plan1.items.find((it) => it.type === "句式单调" && it.current.startsWith("类型：cadence_triple"));
  const enum1 = plan1.items.find((it) => it.type === "句式单调" && it.current.startsWith("类型：cadence_enum"));
  assert.ok(triple1 && enum1);

  const marked = await markFixItem(root, book, "1", triple1.id, "skip");
  assert.equal(marked.ok, true);
  assert.equal(marked.item.state, "skip");

  // 章首插入 4 个空行导致行号整体后移、item.id 变化
  writeFileSync(join(dir, "第01章.md"), "\n\n\n\n" + initial, "utf8");

  const plan2 = await buildFixPlan(root, book, "1");
  const triple2 = plan2.items.find((it) => it.type === "句式单调" && it.current.startsWith("类型：cadence_triple"));
  const enum2 = plan2.items.find((it) => it.type === "句式单调" && it.current.startsWith("类型：cadence_enum"));
  assert.ok(triple2 && enum2);
  assert.equal(triple2.locate.lineStart, triple1.locate.lineStart + 4);
  assert.notEqual(triple2.id, triple1.id, "line shift should produce a new item id");
  assert.match(plan2.summary, /1 项此前已人工标记 done\/skip（状态已保留）/);

  const savedPlan = JSON.parse(readFileSync(plan2.planFile, "utf8"));
  const savedTriple = savedPlan.items.find((it) => it.id === triple2.id);
  const savedEnum = savedPlan.items.find((it) => it.id === enum2.id);
  assert.equal(savedTriple?.state, "skip");
  assert.equal(savedEnum?.state, "open");
});

test("Group 3.6: per-book baseline exemption auto-exempts triple (≥1/ch) or denseEnum (≥2/ch) independently and discloses in summary/notes", async () => {
  const targetChapter = [
    CLEAN_VARIED_PARAGRAPH,
    "",
    TRIPLE_SAME_START.join(""),
    "",
    DENSE_ENUM_1,
    "",
    DENSE_ENUM_2
  ].join("\n");

  // 场景 A：2 个基线章各含 ≥1 处 triple、0 处 denseEnum → 豁免 cadence_triple，仍报 cadence_enum
  const bookA = "基线豁免同构";
  const baseTripleCh1 = [CLEAN_VARIED_PARAGRAPH, "", TRIPLE_SAME_START.join("")].join("\n");
  const baseTripleCh2 = [CLEAN_VARIED_PARAGRAPH, "", TRIPLE_SAME_START_2.join("")].join("\n");
  const { root: rootA } = createTempBook("fix-base-triple", bookA, {
    "第01章.md": baseTripleCh1,
    "第02章.md": baseTripleCh2,
    "第03章.md": targetChapter
  });

  const planA = await buildFixPlan(rootA, bookA, "3");
  assert.equal(
    planA.items.filter((it) => it.type === "句式单调" && it.current.startsWith("类型：cadence_triple")).length,
    0,
    "cadence_triple should be exempted by baseline"
  );
  assert.equal(
    planA.items.filter((it) => it.type === "句式单调" && it.current.startsWith("类型：cadence_enum")).length,
    1,
    "cadence_enum should still fire when baseline has 0 denseEnums"
  );
  assert.match(planA.summary, /句式同构检查已按作者文风豁免/);
  const savedA = JSON.parse(readFileSync(planA.planFile, "utf8"));
  assert.ok(savedA.notes.some((n) => n.includes("句式同构检查已按作者文风豁免")));

  // 场景 B：2 个基线章各含 ≥2 处 denseEnum、0 处 triple → 豁免 cadence_enum，仍报 cadence_triple
  const bookB = "基线豁免并列";
  const baseEnumCh1 = [CLEAN_VARIED_PARAGRAPH, "", DENSE_ENUM_1, "", DENSE_ENUM_2].join("\n");
  const baseEnumCh2 = [CLEAN_VARIED_PARAGRAPH, "", DENSE_ENUM_3, "", DENSE_ENUM_4].join("\n");
  const { root: rootB } = createTempBook("fix-base-enum", bookB, {
    "第01章.md": baseEnumCh1,
    "第02章.md": baseEnumCh2,
    "第03章.md": targetChapter
  });

  const planB = await buildFixPlan(rootB, bookB, "3");
  assert.equal(
    planB.items.filter((it) => it.type === "句式单调" && it.current.startsWith("类型：cadence_enum")).length,
    0,
    "cadence_enum should be exempted by baseline"
  );
  assert.equal(
    planB.items.filter((it) => it.type === "句式单调" && it.current.startsWith("类型：cadence_triple")).length,
    1,
    "cadence_triple should still fire when baseline has 0 triples"
  );
  assert.match(planB.summary, /密集并列检查已按作者文风豁免/);
  const savedB = JSON.parse(readFileSync(planB.planFile, "utf8"));
  assert.ok(savedB.notes.some((n) => n.includes("密集并列检查已按作者文风豁免")));
});

// ═════════════════════════════════════════════════════════════════════════════
// Group 4: lib/prompts.js & skills/novel-writing/SKILL.md
// ═════════════════════════════════════════════════════════════════════════════

test("Group 4.1: lib/prompts.js revising & lean prompts include minimal-edit/info-conservation wording, stay within length caps, and preserve exact exports", () => {
  assert.deepEqual(Object.keys(promptsMod).sort(), [
    "BRIEF_TEXT",
    "CHAT_MODE_CHECKLIST",
    "CHAT_WRITING_PROMPT",
    "PROMPT_SCENES",
    "RAW_MODE_CHECKLIST",
    "RAW_MODE_HINT",
    "RAW_WRITING_PROMPT",
    "promptTextFor"
  ]);

  const revising = promptsMod.promptTextFor("full", "revising", false);
  assert.match(revising, /最小改/);
  assert.match(revising, /信息守恒/);
  assert.match(revising, /限定词/);
  assert.match(revising, /句式单调/);
  assert.ok(revising.length <= 520, `revising prompt length ${revising.length} exceeds 520`);

  const lean = promptsMod.promptTextFor("full", "general", true);
  assert.match(lean, /最小改/);
  assert.match(lean, /信息守恒|限定词/);
  assert.ok(lean.length <= 360, `lean prompt length ${lean.length} exceeds 360`);
});

test("Group 4.2: skills/novel-writing/SKILL.md stays <= 5000 chars and mentions 信息守恒 & 句式单调", () => {
  const skillPath = join(REPO_ROOT, "skills", "novel-writing", "SKILL.md");
  const content = readFileSync(skillPath, "utf8");
  assert.ok(content.length <= 5000, `SKILL.md length ${content.length} exceeds 5000`);
  assert.match(content, /信息守恒/);
  assert.match(content, /句式单调/);
  assert.match(content, /最小改动/);
  assert.match(content, /限定词/);
});

// ═════════════════════════════════════════════════════════════════════════════
// Isolation Guard: real user directories untouched
// ═════════════════════════════════════════════════════════════════════════════

test("Isolation guard: real ~/.dsh/dsh-novel-writer & ~/.gemini/config SHA-256 unchanged", () => {
  const realAfter = {
    dsh: digestTree(REAL_DSH_DIR),
    geminiConfig: digestTree(REAL_GEMINI_CONFIG_DIR)
  };
  assert.deepEqual(realAfter, realBefore);
});
