/**
 * test/scene-baseline-test.mjs —— v7.5.0 场景分带基线自动化回归套件（第 40 个测试套件）
 *
 * 覆盖范围：
 *   1. measureDialogueRatio(text)：空串/空白、纯叙事、四种成对引号占比精度、[0, 1] 截断、100k 未闭合引号防卡顿
 *   2. classifyChapterScene：对话文戏 / 动作冲突 / 叙事过渡 / 仅传 { metrics } 的旧缓存启发式回退
 *   3. computeBaseline + computeSceneBaselines + selectSceneBaseline：逐章 scene 附加、>=2 章门槛、旧缓存兼容与回退
 *   4. 4 个工具端到端集成（7 章混合书：3 章高对话 + 3 章高动作 + 1 章过渡）：
 *      - novel_style_check（动作带命中、独苗过渡章回退全基线、render 含「场景带识别」、剥 .scene 旧缓存走 enrichPerChapterScenes）
 *      - novel_style_report（brief=false 返回 sceneBaselines 且含「分场景参考带」、brief=true 正常省略）
 *      - novel_chapter_brief（多场景混合书返回 sceneBaselines 且渲染「场景参考带」通过 output.schema；统一文风书省略 sceneBaselines）
 *      - novel_fix_plan（action="plan" 返回 sceneBand 且 summary 披露「场景带」；action="verify" 通过契约校验并按同场景带复测）
 *   5. 隔离守卫：~/.dsh/dsh-novel-writer/ 真实目录哈希全程一致
 *
 * 运行：node test/scene-baseline-test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// ===========================================================================
// 严格隔离：先重定向 DSH_NOVEL_WRITER_STATE / DSH_HOME，再动态 import lib/*
// ===========================================================================

const PREV_STATE_ENV = process.env.DSH_NOVEL_WRITER_STATE;
const PREV_HOME_ENV = process.env.DSH_HOME;
const REAL_DSH_DIR = join(homedir(), ".dsh", "dsh-novel-writer");

function digestTree(rootPath) {
  try {
    if (!existsSync(rootPath)) return "absent";
    const lst = lstatSync(rootPath);
    if (lst.isSymbolicLink()) return "symlink";
    if (lst.isFile()) return "file:" + createHash("sha256").update(readFileSync(rootPath)).digest("hex");
    if (!lst.isDirectory()) return "other";
    const entries = readdirSync(rootPath).sort((a, b) => a.localeCompare(b));
    return "dir:[" + entries.map((name) => name + "=" + digestTree(join(rootPath, name))).join("|") + "]";
  } catch {
    return "unreadable";
  }
}

const realBefore = digestTree(REAL_DSH_DIR);

const TMP_BASE = realpathSync.native(mkdtempSync(join(tmpdir(), "dsh-scene-baseline-" + process.pid + "-")));
const STATE_FILE = join(TMP_BASE, "state.json");
const DSH_HOME_DIR = join(TMP_BASE, "dsh-home");

function restoreEnvAndCleanup() {
  if (PREV_STATE_ENV === void 0) delete process.env.DSH_NOVEL_WRITER_STATE;
  else process.env.DSH_NOVEL_WRITER_STATE = PREV_STATE_ENV;
  if (PREV_HOME_ENV === void 0) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_HOME_ENV;
  try {
    rmSync(TMP_BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* 忽略清理错误 */
  }
}

process.on("exit", restoreEnvAndCleanup);
test.after(restoreEnvAndCleanup);

let PLUGIN;
let METRICS;
let CORE;
let DB;

try {
  mkdirSync(DSH_HOME_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({
    enabled: true,
    autoAnalyze: true,
    systemPromptMode: "off",
    promptScene: "general",
    leanWorkflow: false,
    tools: {},
    features: {
      semanticStyle: false,
      semanticImplicit: false,
      semanticEmbedding: false,
      semanticSearch: false,
      chatWriting: false
    }
  }, null, 2), "utf8");

  process.env.DSH_NOVEL_WRITER_STATE = STATE_FILE;
  process.env.DSH_HOME = DSH_HOME_DIR;

  PLUGIN = await import("../lib/index.js");
  METRICS = await import("../lib/style-metrics.js");
  CORE = await import("../lib/core.js");
  DB = await import("../lib/db.js");
} catch (err) {
  restoreEnvAndCleanup();
  throw err;
}

// ===========================================================================
// 通用测试夹具与契约校验
// ===========================================================================

let libSeq = 0;
async function withLib(tag, fn) {
  libSeq += 1;
  const root = join(TMP_BASE, `lib-${tag}-${libSeq}`);
  mkdirSync(join(root, "novels"), { recursive: true });
  try {
    return await fn(root);
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* 忽略子夹具清理异常，外层 TMP_BASE exit/after 会兜底 */
    }
  }
}

function createHarness(root, extraConfig = {}) {
  const registry = [];
  const ctx = {
    tools: { register: (def) => { registry.push(def); return () => {}; } },
    systemPrompt: { section: () => () => {} },
    inject: (_names, cb) => cb({ webServer: { register: () => () => {} }, effect: (fn) => fn() })
  };
  PLUGIN.apply(ctx, { root, sentenceAnalysis: { enabled: true, autoAnalyze: true }, allowLanState: false, ...extraConfig });
  const defs = Object.fromEntries(registry.map((d) => [d.name, d]));
  const exec = { agent: { session: { header: { cwd: root } } } };
  return { defs, exec };
}

function renderText(def, args, value) {
  const rendered = def.output.render(args, value);
  assert.ok(Array.isArray(rendered) && rendered.length > 0, `${def.name}.output.render 必须返回非空数组`);
  for (const item of rendered) {
    assert.equal(item.type, "text");
    assert.equal(typeof item.text, "string");
  }
  return rendered.map((x) => x.text).join("\n");
}

function typeMatches(val, type) {
  if (type === "object") return val !== null && typeof val === "object" && !Array.isArray(val);
  if (type === "array") return Array.isArray(val);
  if (type === "null") return val === null;
  if (type === "string") return typeof val === "string";
  if (type === "boolean") return typeof val === "boolean";
  if (type === "integer") return Number.isInteger(val);
  if (type === "number") return typeof val === "number" && Number.isFinite(val);
  return true;
}

function assertOutputSchema(def, value, label) {
  const schema = def?.output?.schema;
  assert.ok(schema && schema.properties, `${label}: 缺少 output.schema`);
  const validateNode = (node, val, where) => {
    if (!node || typeof node !== "object") return;
    if (node.type) {
      assert.ok(typeMatches(val, node.type), `${where}: 期望 type=${node.type}，实际=${val === null ? "null" : typeof val}`);
    }
    if (Array.isArray(node.enum)) {
      assert.ok(node.enum.includes(val), `${where}: 值 ${JSON.stringify(val)} 不在 enum ${JSON.stringify(node.enum)} 中`);
    }
    if (node.type === "object" && val && typeof val === "object") {
      const props = node.properties || {};
      for (const req of node.required || []) {
        assert.ok(Object.prototype.hasOwnProperty.call(val, req), `${where}: 缺少必填键 ${req}`);
      }
      if (node.additionalProperties === false) {
        const extra = Object.keys(val).filter((k) => !Object.prototype.hasOwnProperty.call(props, k));
        assert.deepEqual(extra, [], `${where}: 出现未声明字段 ${JSON.stringify(extra)}`);
      }
      for (const [k, childSchema] of Object.entries(props)) {
        if (Object.prototype.hasOwnProperty.call(val, k) && val[k] !== void 0) {
          validateNode(childSchema, val[k], `${where}.${k}`);
        }
      }
    }
    if (node.type === "array" && Array.isArray(val) && node.items) {
      for (let i = 0; i < val.length; i += 1) {
        validateNode(node.items, val[i], `${where}[${i}]`);
      }
    }
  };
  validateNode(schema, value, label);
}

// ===========================================================================
// 典型三类场景夹具文本（接近真实中文叙事、对话与打斗文本）
// ===========================================================================

// 4 章高对话文戏：引号内字符占比高（>= 0.34），complexity >= 2.0，无冲突词汇
const DIALOGUE_CH1 = [
  "# 第一章 茶室长谈",
  "“今夜江上风势很急，北岸渡口恐怕多半早早歇业，此时冒雨前去未必妥当。”林晚缓缓说道。",
  "“话虽不错，城南老铺的陈年旧账明日清晨便须封存，错过今宵就难办了。”沈砚轻声回答。",
  "“如此，明日黎明先请稳妥之人绕道城西茶坊探听实情，余下事宜天亮后再作详细打算。”"
].join("\n\n");

const DIALOGUE_CH2 = [
  "# 第二章 窗前对语",
  "“昨日盐运司的文书之中，三处岸口总数颇多疏漏，仿佛有人曾经私下改动。”苏晴问。",
  "“确实古怪，症结大约只在去年冬月那几艘空货船上，彼时竟无半枚私章印记。”顾衡答。",
  "“清晨先清点当年原本与副本，省得日后当堂对质彼此只剩下空口无凭。”"
].join("\n\n");

const DIALOGUE_CH3 = [
  "# 第三章 密议",
  "“东巷那处老宅地契原本三十年一期，今春刚满头季，管事却急忙催众人搬迁。”周明道。",
  "“左邻右舍昨夜也曾议论，月底深更曾经几辆青布马车静静停在西门附近。”陈墨道。",
  "“务必先把街角茶铺掌柜稳住，请他留神近日各方往来客商，余事万勿泄漏。”"
].join("\n\n");

const DIALOGUE_CH4 = [
  "# 第四章 客栈议事",
  "“如今府衙里的几位熟识全数调往南堤，留守新吏口风严密得很，旧卷实在难借。”赵宁道。",
  "“幸好南街书肆的老吏昨晚透露，案头尚留着早年亲手抄录的一份完整副本。”韩雪笑道。",
  "“只要副本年份与印信吻合，明日便足够呈请御史复核这桩多年陈案，今晚大家先安歇。”"
].join("\n\n");

// 4 章高动作打斗冲突：零对话，高冲突词密度（conflictDensity >= 40）且 actionDensity >= 210
const ACTION_CH5 = [
  "# 第五章 巷战突围",
  "他拔剑刺踢砍劈，黑影躲闪砸撞，他跃起劈断绳索撞翻木架，滚开躲避飞矢挥刀斩杀敌兵，夺剑挑飞灯笼跃上屋檐！",
  "伏兵扑来围攻，他拧腰甩开对手猛刺劈砍，抢过短刀横斩击倒刺客，反手砸碎砖瓦踹翻追兵突围而出！"
].join("\n\n");

const ACTION_CH6 = [
  "# 第六章 屋脊追击",
  "刺客跃上瓦檐甩出飞爪，他紧追踏碎青瓦凌空劈剑，刺客落地翻滚掷出短匕横斩！",
  "他举剑格挡猛踹胸口，夺匕反刺压制刺客，再踢起木桶砸翻伏兵，挥刀劈退追兵冲入夜巷！"
].join("\n\n");

const ACTION_CH7 = [
  "# 第七章 码头夺船",
  "他潜行割断缆绳爬上甲板，飞脚踹倒哨兵夺刀猛砍！水手挥斧劈来，他闪身格挡猛踢腰腹。",
  "他反手掷出匕首刺中船夫，挥刀斩断索具砍退追兵，纵身扑入舵室撞开木门逃出港湾！"
].join("\n\n");

const ACTION_CH8 = [
  "# 第八章 雨夜激战",
  "炸裂声撕裂夜幕，敌人开枪扫射！他扑向掩体翻滚躲避流弹，掷出飞斧砸碎灯盏。",
  "枪手冲上石阶，他猛踹铁桌撞翻对手，跃起夺枪猛砸劈倒伏兵，疾冲撞破木门杀出重围！"
].join("\n\n");

// 日常平淡叙事章：富含 站/看/望/听/坐/走/开/关/笑/叹 等日常动词（actionDensity >= 100），零打斗、零引号
const NARRATIVE_CH9 = [
  "# 第九章 雨夜书房",
  "他站在窗前，看着雨水沿着玻璃往下淌，屋里的钟轻轻敲了三下。母亲坐在灯下缝着旧衣，偶尔抬头望他一眼，又低下头去。",
  "桌上那杯茶早已凉透，他伸手端起来抿了一口，转身走回书案旁坐下。窗外的风吹落几片树叶，院门轻轻晃动着，远处传来狗叫声。",
  "他打开抽屉取出旧信，翻了两页便合上，靠在椅背上闭目养神，心里想着明天要去镇上办事，顺道去看看老友。"
].join("\n\n");

const NARRATIVE_CH10 = [
  "# 第十章 长街漫步",
  "清晨的薄雾刚散，她提着竹篮走出巷口，顺着青石板路慢慢往早市走去。街角的茶铺刚揭开木板门，伙计正往炉子里添炭生火。",
  "她站在摊位前挑了两捆青菜，又到隔壁铺子称了半斤芝麻糖，笑着同老板娘寒暄几句后才拎起篮子往回走。",
  "回到小院时阳光正照在石阶上，她推开堂屋门把菜放进厨房，坐到廊下翻开账本记完今晨的花销，抬头望见檐下的燕子正来回忙碌。"
].join("\n\n");

const NARRATIVE_CH11 = [
  "# 第十一章 书院午后",
  "午后的阳光透过窗格洒在青砖地上，他沿着长廊慢慢走过花坛，听见讲堂里传来先生低沉的诵读声。",
  "他停在石桌旁整理书箱，把刚借来的几册旧书放回竹筐，转身望向院墙外缓缓飘过的云影，坐下沏了半壶清茶慢慢饮完。"
].join("\n\n");

const NARRATIVE_CH12 = [
  "# 第十二章 冬夜围炉",
  "傍晚雪粒轻轻落在屋瓦上，她关好木窗回到炭盆边坐下，拿铁钳拨开灰烬添了几块松木炭。",
  "茶壶渐渐发出细微响声，她取下铜盖倒出热茶捧在手里暖着，静静看着炉火映红墙角，听着巷口更夫敲响第一声木梆。"
].join("\n\n");

// ===========================================================================
// 1. measureDialogueRatio(text)
// ===========================================================================

test("1. measureDialogueRatio：空串/空白/纯叙事/四种引号精度/[0,1]/100k未闭合引号耗时", () => {
  assert.equal(METRICS.measureDialogueRatio(""), 0);
  assert.equal(METRICS.measureDialogueRatio("   \n\t  "), 0);
  assert.equal(METRICS.measureDialogueRatio(null), 0);
  assert.equal(METRICS.measureDialogueRatio(undefined), 0);

  const narrative = "他站在窗前望着庭院落叶，轻轻叹了口气转身回到书案前坐下。";
  assert.equal(METRICS.measureDialogueRatio(narrative), 0);

  // 成对引号精度：引用内部非空白字符 / 含引号在内的非空白总字符
  assert.equal(METRICS.measureDialogueRatio("“你好”"), 0.5); // 2 / 4
  assert.equal(METRICS.measureDialogueRatio("「你好」"), 0.5); // 2 / 4
  assert.equal(METRICS.measureDialogueRatio("『你好』"), 0.5); // 2 / 4
  assert.equal(METRICS.measureDialogueRatio('"hello"'), 0.714); // 5 / 7 = 0.71428... -> 0.714

  // 四种成对引号混用（带叙事与空白）："“甲甲” 「乙乙」 『丙丙』 \"dd\" 他说道" -> 引号内 8 字 / 非空白共 19 字 = 0.421
  const mixed = '“甲甲” 「乙乙」 『丙丙』 "dd" 他说道';
  assert.equal(METRICS.measureDialogueRatio(mixed), 0.421);

  // 边界 [0, 1]
  const allQuotes = "“" + "字".repeat(100) + "”";
  const rAll = METRICS.measureDialogueRatio(allQuotes);
  assert.ok(rAll >= 0 && rAll <= 1 && rAll > 0.95, `全对话比例应在 [0, 1] 且接近 1，实际 ${rAll}`);

  // 100k 字符未闭合引号输入不卡顿（< 500ms）
  const hugeUnclosed = '“「『"' + "甲".repeat(100000);
  const t0 = performance.now();
  const hugeRatio = METRICS.measureDialogueRatio(hugeUnclosed);
  const elapsed = performance.now() - t0;
  assert.equal(hugeRatio, 0, "未闭合引号不应计入对话字符");
  assert.ok(elapsed < 500, `100k 未闭合引号输入耗时应 < 500ms，实际 ${elapsed.toFixed(2)}ms`);
});

// ===========================================================================
// 2. classifyChapterScene
// ===========================================================================

test("2. classifyChapterScene：独立冲突信号 / 日常叙事防误判 / 3 章门槛 / 旧缓存回退", () => {
  assert.deepEqual(METRICS.SCENE_BANDS, ["dialogue", "action", "narrative"]);
  assert.equal(METRICS.SCENE_BAND_LABELS.dialogue, "对话文戏");
  assert.equal(METRICS.SCENE_BAND_LABELS.action, "动作冲突");
  assert.equal(METRICS.SCENE_BAND_LABELS.narrative, "叙事过渡");
  assert.equal(METRICS.MIN_SCENE_BAND_CHAPTERS, 3);

  // 高对话章 -> dialogue (confidence=high)
  const sDlg = METRICS.classifyChapterScene(DIALOGUE_CH1);
  assert.equal(sDlg.band, "dialogue");
  assert.equal(sDlg.label, "对话文戏");
  assert.ok(sDlg.dialogueRatio >= 0.34, `dialogueRatio 应 >= 0.34，实际 ${sDlg.dialogueRatio}`);
  assert.equal(sDlg.confidence, "high");

  // 含日常动作描写的真实对话章仍应保持 high 置信度，不被广义动作动词拉低
  const realisticDlg = [
    "周明夹起一块炸鸡放进碗里，抬头笑道：“你这回砍价真是斩钉截铁啊。”苏晴端起茶杯抿了一口，“那当然，老板开价太离谱了。”",
    "屋里暖气开得足，周明一边剥虾一边说：“下周去城南看房子，你打算什么时候请假？”“周三下午吧，正好没会。”"
  ].join("\n\n");
  const sRealisticDlg = METRICS.classifyChapterScene(realisticDlg);
  assert.equal(sRealisticDlg.band, "dialogue");
  assert.equal(sRealisticDlg.confidence, "high");

  // 高动作打斗章 -> action (conflictDensity >= 40)
  const sAct = METRICS.classifyChapterScene(ACTION_CH5);
  assert.equal(sAct.band, "action");
  assert.equal(sAct.label, "动作冲突");
  assert.ok(sAct.conflictDensity >= 40, `conflictDensity 应 >= 40，实际 ${sAct.conflictDensity}`);
  assert.equal(sAct.confidence, "high");

  // 核心修复守卫：富含日常动词（站/看/望/听/坐/走/开/关）的平淡纯叙事（actionDensity > 100）必须判为 narrative！
  const sNar = METRICS.classifyChapterScene(NARRATIVE_CH9);
  assert.ok(sNar.actionDensity >= 100, `前置条件：真实日常叙事广义 actionDensity >= 100，实际 ${sNar.actionDensity}`);
  assert.equal(sNar.conflictDensity, 0, "纯日常叙事冲突词密度应为 0");
  assert.equal(sNar.band, "narrative", "日常叙事绝不得误判为 action");
  assert.equal(sNar.label, "叙事过渡");
  assert.equal(sNar.confidence, "high");

  // 日常搭配黑名单（打算/打开/打听/刺骨/斩钉截铁/炸鸡/踢毽）不误触单字冲突词
  const exclProse = "他打算打开抽屉打听消息，虽然北风刺骨寒意刺鼻，今晚还是斩钉截铁先吃炸鸡再出去踢毽子跳跃玩耍。".repeat(2);
  const exclSignal = METRICS.measureConflictSignals(exclProse);
  assert.equal(exclSignal.conflictHits, 0, "常见非战斗日常搭配不得误计为冲突词");
  assert.equal(METRICS.classifyChapterScene(exclProse).band, "narrative");

  // 朝堂世界观铺垫、悬疑推理、偶提一次过去伏击与长剑的日常叙事 -> 全部归为 narrative
  const courtProse = "大晋建朝三百年，北境诸镇割据已久，礼部尚书站在丹墀之下捧着税制奏折神情凝重。阁老们在暖阁里商议了两个时辰，依旧拿不定主意。";
  const mysteryProse = "法医摘下手套，将检验报告平铺在会议桌上。窗锁完好无损，门缝里也没有撬动痕迹，老陈盯着现场照片逐一核对当晚四名目击者的口供。";
  const recallProse = NARRATIVE_CH9 + "\n\n他想起三年前在北境遭遇伏击的事，伸手抚过墙上挂着的那柄长剑，轻轻叹了口气。";
  assert.equal(METRICS.classifyChapterScene(courtProse).band, "narrative");
  assert.equal(METRICS.classifyChapterScene(mysteryProse).band, "narrative");
  assert.equal(METRICS.classifyChapterScene(recallProse).band, "narrative");

  // 无武器快节奏逃亡（中等冲突词 20~39 + 短句/感叹节奏）-> 联合识别为 action
  const fastEscapeProse = "脚步声越来越近！他贴紧墙角屏息！门锁忽然松开！他翻窗跑出小院，沿着夜巷一路狂奔！身后光柱扫过，犬吠声四起！他钻进桥洞喘息。".repeat(2);
  const sFastEscape = METRICS.classifyChapterScene(fastEscapeProse);
  assert.ok(sFastEscape.conflictDensity >= 20 && sFastEscape.conflictDensity < 40, `中等冲突密度范围验证，实际 ${sFastEscape.conflictDensity}`);
  assert.equal(sFastEscape.band, "action", "冲突词 >= 20 且呈短句快节奏时应识别为 action");

  // 仅传 { metrics } 无 text 的旧缓存低干扰启发式回退
  const fbAction = METRICS.classifyChapterScene({ metrics: { actionDensity: 225, complexity: 3.0, modifierDensity: 12 } });
  assert.equal(fbAction.band, "action");
  assert.equal(fbAction.confidence, "low");
  assert.equal(fbAction.dialogueRatio, null);
  assert.equal(fbAction.conflictDensity, null);

  // 正常日常叙事的广义 actionDensity (~145) 在旧缓存回退中也不得误判为 action
  const fbDailyNarrative = METRICS.classifyChapterScene({ metrics: { actionDensity: 145, complexity: 3.1, modifierDensity: 15 } });
  assert.equal(fbDailyNarrative.band, "narrative");
  assert.equal(fbDailyNarrative.confidence, "low");

  const fbDialogue = METRICS.classifyChapterScene({ metrics: { actionDensity: 8, complexity: 1.5, modifierDensity: 20 } });
  assert.equal(fbDialogue.band, "dialogue");
  assert.equal(fbDialogue.confidence, "low");
  assert.equal(fbDialogue.dialogueRatio, null);

  const fbNarrative = METRICS.classifyChapterScene({ metrics: { actionDensity: 8, complexity: 2.3, modifierDensity: 35 } });
  assert.equal(fbNarrative.band, "narrative");
  assert.equal(fbNarrative.confidence, "low");
  assert.equal(fbNarrative.dialogueRatio, null);

  // 缺少正文与指标兜底
  const fbEmpty = METRICS.classifyChapterScene({});
  assert.equal(fbEmpty.band, "narrative");
  assert.equal(fbEmpty.confidence, "low");
  assert.equal(fbEmpty.dialogueRatio, null);
  assert.equal(fbEmpty.conflictDensity, null);
});

// ===========================================================================
// 3. computeBaseline + computeSceneBaselines + selectSceneBaseline
// ===========================================================================

test("3. computeBaseline + computeSceneBaselines + selectSceneBaseline 单元测试（>=3 章门槛）", () => {
  const chapters = [
    { file: "第01章.md", text: DIALOGUE_CH1 },
    { file: "第02章.md", text: DIALOGUE_CH2 },
    { file: "第03章.md", text: DIALOGUE_CH3 },
    { file: "第04章.md", text: DIALOGUE_CH4 },
    { file: "第05章.md", text: ACTION_CH5 },
    { file: "第06章.md", text: ACTION_CH6 },
    { file: "第07章.md", text: ACTION_CH7 },
    { file: "第08章.md", text: ACTION_CH8 },
    { file: "第09章.md", text: NARRATIVE_CH9 },
    { file: "第10章.md", text: NARRATIVE_CH10 }
  ];

  // computeBaseline 保留 { file, metrics } 并附加 scene
  const base = METRICS.computeBaseline(chapters);
  assert.equal(base.chapterCount, 10);
  assert.equal(base.perChapter.length, 10);
  for (const pc of base.perChapter) {
    assert.equal(typeof pc.file, "string");
    assert.ok(pc.metrics && typeof pc.metrics.actionDensity === "number");
    assert.ok(pc.scene && METRICS.SCENE_BANDS.includes(pc.scene.band), `${pc.file} 应附加合法 scene`);
  }
  assert.equal(base.perChapter[0].scene.band, "dialogue");
  assert.equal(base.perChapter[4].scene.band, "action");
  assert.equal(base.perChapter[8].scene.band, "narrative");

  // computeSceneBaselines：>= 3 章的带进入 availableBands，不足 3 章（narrative=2）不纳入
  const sb = METRICS.computeSceneBaselines(base.perChapter);
  assert.equal(sb.totalChapters, 10);
  assert.deepEqual(sb.counts, { dialogue: 4, action: 4, narrative: 2 });
  assert.deepEqual(sb.availableBands, ["dialogue", "action"]);
  assert.equal(sb.bands.dialogue.chapterCount, 4);
  assert.deepEqual(sb.bands.dialogue.files, ["第01章.md", "第02章.md", "第03章.md", "第04章.md"]);
  assert.equal(sb.bands.action.chapterCount, 4);
  assert.deepEqual(sb.bands.action.files, ["第05章.md", "第06章.md", "第07章.md", "第08章.md"]);
  assert.equal(sb.bands.narrative, void 0, "只有 2 章（< 3 章）的叙事过渡带不应纳入 bands");

  // 兼容缺 .scene 的老缓存输入（不抛错、且日常叙事指标不会被错当 action）
  const legacyPerCh = base.perChapter.map((pc) => ({ file: pc.file, metrics: pc.metrics }));
  const sbLegacy = METRICS.computeSceneBaselines(legacyPerCh);
  assert.equal(sbLegacy.totalChapters, 10);
  assert.equal(sbLegacy.counts.action, 4);
  assert.equal(sbLegacy.counts.narrative, 6, "去 .scene 后日常叙事指标与对话章均保守落入 narrative，不被错标成 action");
  assert.ok(sbLegacy.availableBands.includes("action"));

  // selectSceneBaseline：同类 >= 3 章命中 usedSceneBand: true
  const excludingCh5 = base.perChapter.filter((pc) => pc.file !== "第05章.md");
  const pickAction = METRICS.selectSceneBaseline(ACTION_CH5, excludingCh5);
  assert.equal(pickAction.band, "action");
  assert.equal(pickAction.usedSceneBand, true);
  assert.equal(pickAction.peerCount, 3);
  assert.equal(pickAction.chapterCount, 9);
  assert.deepEqual(pickAction.baseline, METRICS.computeBaselineFromPerChapter(excludingCh5.filter((p) => p.scene.band === "action")));
  assert.notEqual(pickAction.baseline.actionDensity.mu, pickAction.fallbackBaseline.actionDensity.mu);

  // selectSceneBaseline：同类仅 1 章（< 3 章）自动回退全基线 usedSceneBand: false
  const excludingCh9 = base.perChapter.filter((pc) => pc.file !== "第09章.md");
  const pickNarrative = METRICS.selectSceneBaseline(NARRATIVE_CH9, excludingCh9);
  assert.equal(pickNarrative.band, "narrative");
  assert.equal(pickNarrative.usedSceneBand, false);
  assert.equal(pickNarrative.peerCount, 1);
  assert.equal(pickNarrative.chapterCount, 9);
  assert.deepEqual(pickNarrative.baseline, pickNarrative.fallbackBaseline);
});

// ===========================================================================
// 4. 4 个工具端到端集成测试
// ===========================================================================

function seedMixedBook(root, book) {
  const dir = join(root, "novels", book);
  mkdirSync(dir, { recursive: true });
  const files = [
    ["第01章 茶室长谈.md", DIALOGUE_CH1],
    ["第02章 窗前对语.md", DIALOGUE_CH2],
    ["第03章 密议.md", DIALOGUE_CH3],
    ["第04章 客栈议事.md", DIALOGUE_CH4],
    ["第05章 巷战突围.md", ACTION_CH5],
    ["第06章 屋脊追击.md", ACTION_CH6],
    ["第07章 码头夺船.md", ACTION_CH7],
    ["第08章 雨夜激战.md", ACTION_CH8],
    ["第09章 雨夜书房.md", NARRATIVE_CH9],
    ["第10章 长街漫步.md", NARRATIVE_CH10]
  ];
  for (const [name, content] of files) {
    writeFileSync(join(dir, name), content + "\n", "utf8");
  }
  return files.map(([file, text]) => ({ file, text }));
}

test("4a. novel_style_check：动作带命中 vs 日常叙事识别并回退全基线 vs 剥 .scene 旧缓存走 enrichPerChapterScenes", async () => {
  await withLib("style-check", async (root) => {
  const book = "场景混合书";
  const rawFiles = seedMixedBook(root, book);
  const { defs, exec } = createHarness(root);

  // 1) 检验第 5 章动作打斗章：走 action 场景带（peerCount=3），不被对话/日常带拉低误报
  const actArgs = { book, chapter: "5", root };
  const actRes = await defs.novel_style_check.execute(actArgs, exec);
  assertOutputSchema(defs.novel_style_check, actRes, "novel_style_check(action)");

  assert.equal(actRes.metric.enabled, true);
  assert.equal(actRes.metric.sceneBand.band, "action");
  assert.equal(actRes.metric.sceneBand.label, "动作冲突");
  assert.ok(actRes.metric.sceneBand.conflictDensity >= 40);
  assert.equal(actRes.metric.sceneBand.usedSceneBand, true);
  assert.equal(actRes.metric.sceneBand.peerCount, 3);
  assert.equal(actRes.metric.sceneBand.chapterCount, 9);

  const ch678Baseline = METRICS.computeBaseline(
    rawFiles.filter((f) => ["第06章", "第07章", "第08章"].some((p) => f.file.startsWith(p))).map((f) => ({ file: f.file, text: f.text + "\n" }))
  ).baseline;
  const fullExcludingCh5 = METRICS.computeBaseline(
    rawFiles.filter((f) => !f.file.startsWith("第05章")).map((f) => ({ file: f.file, text: f.text + "\n" }))
  ).baseline;

  assert.equal(actRes.metric.baseline.actionDensity.mu, ch678Baseline.actionDensity.mu, "第 5 章对比基线必须是第 6/7/8 章动作带 μ");
  assert.ok(
    actRes.metric.baseline.actionDensity.mu > fullExcludingCh5.actionDensity.mu * 1.5,
    `动作带 μ(${actRes.metric.baseline.actionDensity.mu}) 应明显高于被对话带拉低的全书基线(${fullExcludingCh5.actionDensity.mu})`
  );

  // 对照实验：拿第 5 章去比全书均值会被判显著偏离，而按动作带对照则稳稳在带内
  const ch5Metrics = METRICS.measureStyleMetrics(ACTION_CH5 + "\n").metrics;
  const fullJudge = METRICS.judgeAgainstBaseline(ch5Metrics, fullExcludingCh5, CORE.buildTolerance(fullExcludingCh5, 9));
  const fullActVerdict = fullJudge.verdicts.find((v) => v.metric === "actionDensity");
  const bandActVerdict = actRes.metric.verdicts.find((v) => v.metric === "actionDensity");
  assert.ok(fullActVerdict.devPct > 80 && fullActVerdict.status !== "ok", `前置对照：全书均值下动作密度偏差应明显出/近带(${fullActVerdict.devPct}%)`);
  assert.equal(bandActVerdict.status, "ok", "同动作带内第 5 章动作密度应在带内");

  const actRendered = renderText(defs.novel_style_check, actArgs, actRes);
  assert.ok(actRendered.includes("场景带识别"), "render 应包含「场景带识别」");
  assert.ok(actRendered.includes("同类场景带基线"), "动作带命中时 render 应标明「同类场景带基线」");

  // 2) 检验第 9 章真实日常叙事章：即使 actionDensity > 100，仍正确归入 narrative 并因 peerCount=1 < 3 回退全基线
  const narArgs = { book, chapter: "9", root };
  const narRes = await defs.novel_style_check.execute(narArgs, exec);
  assertOutputSchema(defs.novel_style_check, narRes, "novel_style_check(narrative)");

  assert.equal(narRes.metric.sceneBand.band, "narrative");
  assert.equal(narRes.metric.sceneBand.conflictDensity, 0);
  assert.equal(narRes.metric.sceneBand.usedSceneBand, false);
  assert.equal(narRes.metric.sceneBand.peerCount, 1);
  assert.equal(narRes.metric.sceneBand.chapterCount, 9);
  const fullExcludingCh9 = CORE.cleanOutput(METRICS.computeBaseline(
    rawFiles.filter((f) => !f.file.startsWith("第09章")).map((f) => ({ file: f.file, text: f.text + "\n" }))
  ).baseline);
  assert.deepEqual(narRes.metric.baseline, fullExcludingCh9, "回退全基线时 metric.baseline 应与排除第 9 章的全书基线一致");

  const narRendered = renderText(defs.novel_style_check, narArgs, narRes);
  assert.ok(narRendered.includes("场景带识别"), "回退场景 render 也应包含「场景带识别」");
  assert.ok(narRendered.includes("全书其他章基线"), "回退场景 render 应标明「全书其他章基线」");

  // 3a) SQLite chapter_metrics 剥掉 scene_json 后：只读路径（readOnly: true）在内存中现场补算 scene 且不重写 SQLite；
  //     同时 novel_style_check 靠正文补齐 scene，第 1 章仍按 dialogue 带命中。
  // 第 2/3/4 章 complexity > 1.7：若不走正文场景分类 / enrichPerChapterScenes，纯指标启发式会误判为 narrative 导致回退！
  const dbPath = DB.libraryDbPath(root);
  assert.ok(existsSync(dbPath), "前置条件：应已落盘 cache.sqlite");
  const initialRows = DB.readChapterMetrics(root, book, { readOnly: true }).rows;
  assert.equal(initialRows.length, rawFiles.length, "首次缓存应含全部章节行");
  assert.ok(initialRows.every((r) => typeof r.scene_json === "string" && r.scene_json !== ""), "首次 SQLite 缓存应含 scene_json");

  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE chapter_metrics SET scene_json = NULL WHERE book = ?").run(book);
  } finally {
    db.close();
  }
  const strippedRows = DB.readChapterMetrics(root, book, { readOnly: true }).rows;
  assert.ok(strippedRows.every((r) => r.scene_json === null), "前置条件：chapter_metrics.scene_json 应已置为 NULL");
  const ch2Row = strippedRows.find((r) => r.chapter.startsWith("第02章"));
  const fallbackCh2 = METRICS.classifyChapterScene({ metrics: JSON.parse(ch2Row.metrics_json) });
  assert.equal(fallbackCh2.confidence, "low");
  assert.notEqual(fallbackCh2.band, "dialogue", "前置条件：纯指标启发式不得把第 2 章归为 dialogue，才能证明现场正文场景分组起了作用");

  const roPerChapter = await CORE.metricChaptersCached(
    root,
    book,
    rawFiles.map((f) => ({ file: f.file, text: f.text + "\n" })),
    { readOnly: true }
  );
  assert.equal(roPerChapter.length, rawFiles.length);
  const roCh2 = roPerChapter.find((pc) => pc.file.startsWith("第02章"));
  assert.equal(roCh2?.scene?.band, "dialogue", "只读读取 scene_json=NULL 的 SQLite 行必须在内存中补全 dialogue 场景");

  const afterRoRows = DB.readChapterMetrics(root, book, { readOnly: true }).rows;
  assert.ok(afterRoRows.every((r) => r.scene_json === null), "只读内存中补算不得重写 SQLite chapter_metrics.scene_json");
  assert.deepEqual(
    afterRoRows.map((r) => [r.chapter, r.updated_at]),
    strippedRows.map((r) => [r.chapter, r.updated_at]),
    "只读内存中补算不得改写 SQLite chapter_metrics 的 updated_at"
  );

  const dlgRes = await defs.novel_style_check.execute({ book, chapter: "1", root }, exec);
  assertOutputSchema(defs.novel_style_check, dlgRes, "novel_style_check(sqlite-null-scene-dialogue)");
  assert.equal(dlgRes.metric.sceneBand.band, "dialogue");
  assert.equal(dlgRes.metric.sceneBand.usedSceneBand, true, "scene_json=NULL 时必须按正文分组为 dialogue");
  assert.equal(dlgRes.metric.sceneBand.peerCount, 3);
  });

  // 3b) 旧版 JSON 缓存兼容回归：预置去掉 .scene 的 <book>-chapters-metrics.json（无 cache.sqlite）仍可正常兜底并完成分析
  await withLib("style-check-legacy-json", async (legacyRoot) => {
  const legacyBook = "旧缓存场景书";
  const legacyRaw = seedMixedBook(legacyRoot, legacyBook);
  const legacyHarness = createHarness(legacyRoot);
  const legacyChapters = legacyRaw.map((f) => ({ file: f.file, text: f.text + "\n" }));
  const th = createHash("sha1")
    .update(legacyChapters.slice().sort((a, b) => String(a.file).localeCompare(String(b.file))).map((c) => `${c.file}\u0000${c.text}`).join("\u0001"))
    .digest("hex")
    .slice(0, 16);
  const strippedPerChapter = METRICS.computeBaseline(legacyChapters).perChapter.map(({ file, metrics }) => ({ file, metrics }));
  const legacyFallbackCh2 = METRICS.classifyChapterScene({ metrics: strippedPerChapter[1].metrics });
  assert.equal(legacyFallbackCh2.confidence, "low");
  assert.notEqual(legacyFallbackCh2.band, "dialogue");

  const cacheFile = join(legacyRoot, ".novel-writer", "analysis", `${legacyBook}-chapters-metrics.json`);
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ th, perChapter: strippedPerChapter, ver: CORE.CACHE_VERSION }, null, 2), "utf8");
  assert.equal(existsSync(DB.libraryDbPath(legacyRoot)), false, "前置条件：旧缓存兜底测试起点不得存在 cache.sqlite");

  const legacyRes = await legacyHarness.defs.novel_style_check.execute({ book: legacyBook, chapter: "1", root: legacyRoot }, legacyHarness.exec);
  assertOutputSchema(legacyHarness.defs.novel_style_check, legacyRes, "novel_style_check(legacy-json-fallback)");
  assert.equal(legacyRes.metric.sceneBand.band, "dialogue");
  assert.equal(legacyRes.metric.sceneBand.usedSceneBand, true, "剥掉 .scene 的旧 JSON 缓存必须回退补算并分组为 dialogue");
  assert.equal(legacyRes.metric.sceneBand.peerCount, 3);

  const afterLegacy = JSON.parse(readFileSync(cacheFile, "utf8"));
  assert.ok(afterLegacy.perChapter.every((pc) => pc.scene === void 0), "应读取旧 JSON 缓存而非重写该 JSON 文件");
  });
});

test("4b. novel_style_report：brief=false 返回 sceneBaselines 含「分场景参考带」，brief=true 精简省略", async () => {
  await withLib("style-report", async (root) => {
  const book = "画像场景书";
  seedMixedBook(root, book);
  const { defs, exec } = createHarness(root);

  const fullArgs = { book, brief: false, root };
  const fullRes = await defs.novel_style_report.execute(fullArgs, exec);
  assertOutputSchema(defs.novel_style_report, fullRes, "novel_style_report(full)");
  assert.ok(fullRes.sceneBaselines && typeof fullRes.sceneBaselines === "object", "brief=false 应返回 sceneBaselines");
  assert.deepEqual(fullRes.sceneBaselines.availableBands, ["dialogue", "action"]);
  assert.equal(fullRes.sceneBaselines.counts.narrative, 2);
  assert.equal(fullRes.sceneBaselines.bands.narrative, void 0, "仅 2 章(<3)的 narrative 带不应进入 bands");
  assert.ok(fullRes.report.includes("分场景参考带"), "完整报告正文应包含「分场景参考带」");
  assert.ok(fullRes.report.includes("对话文戏（4 章）"), "报告应列出对话文戏带章节数");
  assert.ok(fullRes.report.includes("动作冲突（4 章）"), "报告应列出动作冲突带章节数");

  const briefArgs = { book, brief: true, root };
  const briefRes = await defs.novel_style_report.execute(briefArgs, exec);
  assertOutputSchema(defs.novel_style_report, briefRes, "novel_style_report(brief)");
  assert.equal("sceneBaselines" in briefRes, false, "brief=true 精简路径应省略 sceneBaselines");
  assert.equal(briefRes.report.includes("分场景参考带"), false, "brief=true 精简报告不应输出分场景明细");
  });
});

test("4c. novel_chapter_brief：多场景混合书返回 sceneBaselines 并通过 output.schema；统一文风书省略 sceneBaselines", async () => {
  await withLib("chapter-brief", async (root) => {
  const mixedBook = "混合开写书";
  const seeded = seedMixedBook(root, mixedBook);
  const { defs, exec } = createHarness(root);

  // 多场景混合书
  const mixedArgs = { book: mixedBook, chapter: "next", root };
  const mixedRes = await defs.novel_chapter_brief.execute(mixedArgs, exec);
  assertOutputSchema(defs.novel_chapter_brief, mixedRes, "novel_chapter_brief(mixed)");
  assert.ok(mixedRes.sceneBaselines && typeof mixedRes.sceneBaselines === "object", "多场景混合书应返回 sceneBaselines");
  assert.ok(mixedRes.sceneBaselines.dialogue && mixedRes.sceneBaselines.action, "sceneBaselines 应包含 dialogue 与 action 带");
  assert.equal(mixedRes.sceneBaselines.dialogue.chapterCount, 4);
  assert.equal(mixedRes.sceneBaselines.action.chapterCount, 4);
  assert.equal(mixedRes.sceneBaselines.narrative, void 0, "仅 2 章(<3)的 narrative 带不应列入 sceneBaselines");
  const expectedSb = METRICS.computeSceneBaselines(
    METRICS.computeBaseline(seeded.map((s) => ({ file: s.file, text: s.text + "\n" }))).perChapter
  );
  assert.deepEqual(mixedRes.sceneBaselines.dialogue.mu, {
    complexity: expectedSb.bands.dialogue.baseline.complexity.mu,
    modifierDensity: expectedSb.bands.dialogue.baseline.modifierDensity.mu,
    actionDensity: expectedSb.bands.dialogue.baseline.actionDensity.mu
  });
  assert.deepEqual(mixedRes.sceneBaselines.action.mu, {
    complexity: expectedSb.bands.action.baseline.complexity.mu,
    modifierDensity: expectedSb.bands.action.baseline.modifierDensity.mu,
    actionDensity: expectedSb.bands.action.baseline.actionDensity.mu
  });

  const mixedRendered = renderText(defs.novel_chapter_brief, mixedArgs, mixedRes);
  assert.ok(mixedRendered.includes("【风格基线】"), "多场景开写包 render 应包含「【风格基线】」");
  assert.ok(mixedRendered.includes("场景参考带"), "多场景开写包 render 应输出「场景参考带」");
  assert.ok(mixedRendered.includes("对话文戏(4章:") && mixedRendered.includes("动作冲突(4章:"), "渲染应展示两个参考带的章数与均值");

  // 统一文风书（仅 1 个有效场景带）
  const uniformBook = "统一文风书";
  const uDir = join(root, "novels", uniformBook);
  mkdirSync(uDir, { recursive: true });
  writeFileSync(join(uDir, "第01章.md"), DIALOGUE_CH1 + "\n", "utf8");
  writeFileSync(join(uDir, "第02章.md"), DIALOGUE_CH2 + "\n", "utf8");
  writeFileSync(join(uDir, "第03章.md"), DIALOGUE_CH3 + "\n", "utf8");

  const uniformArgs = { book: uniformBook, chapter: "next", root };
  const uniformRes = await defs.novel_chapter_brief.execute(uniformArgs, exec);
  assertOutputSchema(defs.novel_chapter_brief, uniformRes, "novel_chapter_brief(uniform)");
  assert.equal("sceneBaselines" in uniformRes, false, "只有 1 个有效场景带的书应省略 sceneBaselines");
  const uniformRendered = renderText(defs.novel_chapter_brief, uniformArgs, uniformRes);
  assert.equal(uniformRendered.includes("场景参考带"), false, "单场景书不应渲染「场景参考带」");
  });
});

test("4d. novel_fix_plan：action=plan 与 verify 均返回 sceneBand 且按动作带（3章）复测", async () => {
  await withLib("fix-plan", async (root) => {
  const book = "改稿场景书";
  seedMixedBook(root, book);
  const { defs, exec } = createHarness(root);

  const planArgs = { book, chapter: "5", action: "plan", root };
  const planRes = await defs.novel_fix_plan.execute(planArgs, exec);
  assertOutputSchema(defs.novel_fix_plan, planRes, "novel_fix_plan(plan)");

  assert.ok(planRes.sceneBand && typeof planRes.sceneBand === "object", "action=plan 必须返回 sceneBand");
  assert.equal(planRes.sceneBand.band, "action");
  assert.equal(planRes.sceneBand.label, "动作冲突");
  assert.ok(planRes.sceneBand.conflictDensity >= 40);
  assert.equal(planRes.sceneBand.usedSceneBand, true);
  assert.equal(planRes.sceneBand.peerCount, 3);
  assert.equal(planRes.sceneBand.chapterCount, 9);
  assert.ok(planRes.summary.includes("场景带"), "plan summary 应披露「场景带」");
  assert.ok(planRes.summary.includes("动作冲突"), "plan summary 应包含场景带名称");

  const actionMetricItem = (planRes.items || []).find((it) => String(it.current || "").startsWith("actionDensity "));
  assert.equal(actionMetricItem, void 0, "动作带对照下第 5 章不应误报 actionDensity 句式偏离");

  const planRendered = renderText(defs.novel_fix_plan, planArgs, planRes);
  assert.ok(planRendered.includes("场景带"), "plan render 应包含「场景带」");

  const verifyArgs = { book, chapter: "5", action: "verify", root };
  const verifyRes = await defs.novel_fix_plan.execute(verifyArgs, exec);
  assertOutputSchema(defs.novel_fix_plan, verifyRes, "novel_fix_plan(verify)");
  assert.equal(verifyRes.action, "verify");
  assert.ok(Array.isArray(verifyRes.checked), "verify 应返回 checked 数组");
  assert.equal(typeof verifyRes.summary, "string");
  assert.ok(verifyRes.summary.includes("复测结果"), "verify summary 应含复测结果");
  const verifyActionNew = verifyRes.checked.find((c) => c.status === "new" && String(c.detail || "").includes("actionDensity"));
  assert.equal(verifyActionNew, void 0, "verify 复测同样应基于动作带，不新增 actionDensity 误报");
  renderText(defs.novel_fix_plan, verifyArgs, verifyRes);

  assert.ok(verifyRes.sceneBand && typeof verifyRes.sceneBand === "object", "action=verify 必须透传 sceneBand");
  assert.equal(verifyRes.sceneBand.band, "action");
  assert.equal(verifyRes.sceneBand.label, "动作冲突");
  assert.equal(verifyRes.sceneBand.usedSceneBand, true);
  assert.ok(verifyRes.summary.includes("场景带"), "verify summary 应披露「场景带」");
  });
});

test("4e. 防回退实测：无打斗的「3叙事 + 3对话」书绝不出现 action 带；4叙事起按 narrative 带对照", async () => {
  await withLib("pure-narrative-dialogue", async (root) => {
  const book = "日常剧情书";
  const dir = join(root, "novels", book);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "第01章.md"), DIALOGUE_CH1 + "\n", "utf8");
  writeFileSync(join(dir, "第02章.md"), DIALOGUE_CH2 + "\n", "utf8");
  writeFileSync(join(dir, "第03章.md"), DIALOGUE_CH3 + "\n", "utf8");
  writeFileSync(join(dir, "第04章.md"), NARRATIVE_CH9 + "\n", "utf8");
  writeFileSync(join(dir, "第05章.md"), NARRATIVE_CH10 + "\n", "utf8");
  writeFileSync(join(dir, "第06章.md"), NARRATIVE_CH11 + "\n", "utf8");

  const { defs, exec } = createHarness(root);

  // 全书风格报告：3 章日常叙事应全部识别为 narrative，action 恒为 0
  const repRes = await defs.novel_style_report.execute({ book, brief: false, root }, exec);
  assert.equal(repRes.sceneBaselines.counts.action, 0, "没有打斗章的书绝不允许产生 action 场景带");
  assert.equal(repRes.sceneBaselines.counts.narrative, 3);
  assert.equal(repRes.sceneBaselines.counts.dialogue, 3);
  assert.deepEqual(repRes.sceneBaselines.availableBands, ["dialogue", "narrative"]);

  // 对第 4 章日常叙事跑 style_check：其余叙事只有 2 章 (<3)，识别为 narrative 且回退全基线
  const chk3 = await defs.novel_style_check.execute({ book, chapter: "4", root }, exec);
  assert.equal(chk3.metric.sceneBand.band, "narrative");
  assert.equal(chk3.metric.sceneBand.usedSceneBand, false, "peerCount=2 时未达 3 章门槛，应回退全基线");
  assert.equal(chk3.metric.sceneBand.peerCount, 2);

  // 追加第 4 章日常叙事 -> peerCount=3，达标并按 narrative 同带对照
  writeFileSync(join(dir, "第07章.md"), NARRATIVE_CH12 + "\n", "utf8");
  const chk4 = await defs.novel_style_check.execute({ book, chapter: "4", root }, exec);
  assert.equal(chk4.metric.sceneBand.band, "narrative");
  assert.equal(chk4.metric.sceneBand.usedSceneBand, true, "达到 3 章同带门槛后应启用 narrative 同带对照");
  assert.equal(chk4.metric.sceneBand.peerCount, 3);
  });
});

// ===========================================================================
// 5. 隔离守卫
// ===========================================================================

test("5. 隔离守卫：用户真实 ~/.dsh/dsh-novel-writer/ 目录全程未被修改", () => {
  const realAfter = digestTree(REAL_DSH_DIR);
  assert.deepEqual(realAfter, realBefore, "测试全程绝不能改动用户真实 ~/.dsh/dsh-novel-writer/ 目录");
});
