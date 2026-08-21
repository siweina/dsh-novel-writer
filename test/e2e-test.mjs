// 端到端测试：10 工具注册、缓存、伏笔、风格自检、路由（v0.6.0）

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { apply } from "../lib/index.js";

const testRoot = join(process.cwd(), ".e2e-test");
rmSync(testRoot, { recursive: true, force: true });
mkdirSync(join(testRoot, "novels", "测试"), { recursive: true });
writeFileSync(join(testRoot, "novels", "测试", "第01章.md"), "雨下了一整夜。她站在窗前，心里想着明天的事。\n“你真的要走吗？”他低声问。\n难道这就是结局？她不禁这样想。\n", "utf8");
writeFileSync(join(testRoot, "novels", "测试", "第02章.md"), "日子照旧。她习惯了独自吃饭。窗外风急，雨打芭蕉。\n", "utf8");

const registry = [];
const routes = [];
const ctx = {
  tools: { register: (d) => { registry.push(d); return () => {}; } },
  systemPrompt: { section: () => () => {} },
  inject: (names, cb) => cb({ webServer: { register: (r) => { routes.push(r); return () => {}; } }, effect: (fn) => fn() }),
};
apply(ctx, { root: testRoot, sentenceAnalysis: { enabled: true, autoAnalyze: true }, allowLanState: true });
const defs = Object.fromEntries(registry.map((d) => [d.name, d]));
const names = registry.map((d) => d.name);
console.log("工具数:", names.length, names.join(", "));
if (names.length !== 15) throw new Error("expected 15 tools (v2.5.0)");

const exec = { agent: { session: { header: { cwd: testRoot } } } };

// ---- DSH schema 规则检查（additionalProperties 必须布尔；禁用 pattern/format/数值边界关键字）----
const SCHEMA_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "oneOf"]);
const SCHEMA_BANNED = ["pattern", "format", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"];
function assertDshSchema(node, where) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (!SCHEMA_KEYWORDS.has(key)) continue;
    if (key === "additionalProperties" && typeof v !== "boolean") throw new Error(where + ".additionalProperties must be boolean: " + JSON.stringify(v).slice(0, 60));
    if (key === "type" && typeof v !== "string") throw new Error(where + ".type must be string");
    if (key === "properties") {
      if (v === null || typeof v !== "object") throw new Error(where + ".properties must be object");
      for (const field of Object.keys(v)) assertDshSchema(v[field], where + ".properties." + field);
    } else if (typeof v === "object" && v !== null) {
      assertDshSchema(v, where + "." + key);
    }
  }
  for (const banned of SCHEMA_BANNED) {
    if (Object.prototype.hasOwnProperty.call(node, banned)) throw new Error(where + "." + banned + " not supported by DSH");
  }
}
for (const d of registry) {
  if (d.parameters) assertDshSchema(d.parameters, d.name + ".parameters");
  if (d.output?.schema) assertDshSchema(d.output.schema, d.name + ".output");
}
console.log("DSH schema 规则检查: 全部通过");

// 1) 分析 + 缓存（第一次 miss，第二次 hit）
const first = await defs.novel_sentence_analysis.execute({ book: "测试" }, exec);
console.log("首次分析 cache:", first.cache, "| reportFile:", first.reportFile?.includes("analysis") ? "✓ 新目录" : "✗ " + first.reportFile);
if (first.cache !== "miss") throw new Error("first should be miss");
const second = await defs.novel_sentence_analysis.execute({ book: "测试" }, exec);
console.log("二次分析 cache:", second.cache, "| 指纹一致:", second.fingerprint === first.fingerprint);
if (second.cache !== "hit") throw new Error("second should be hit");
const fresh = await defs.novel_sentence_analysis.execute({ book: "测试", fresh: true }, exec);
console.log("fresh 重算 cache:", fresh.cache);
if (fresh.cache !== "miss") throw new Error("fresh should miss");

// 2) 风格自检
const check = await defs.novel_style_check.execute({ book: "测试", chapter: "第02章.md" }, exec);
console.log("风格自检: 相似度", check.similarity, "| verdict:", check.verdict, "| diffs:", check.diffs.length, "| advice:", !!check.advice);
if (typeof check.similarity !== "number" || !check.advice) throw new Error("style check broken");

// 3) 伏笔登记表
const add = await defs.novel_plot.execute({ book: "测试", action: "add", content: "母神名讳之谜", chapter: "第01章", note: "第二章回收" }, exec);
console.log("伏笔 add:", add.message, "| entries:", add.entries.length);
const id = add.entries[0].id;
await defs.novel_plot.execute({ book: "测试", action: "add", content: "代行者血脉", chapter: "第01章" }, exec);
const list = await defs.novel_plot.execute({ book: "测试", action: "list" }, exec);
console.log("伏笔 list:", list.entries.map((e) => e.content + ":" + e.status).join(" "));
await defs.novel_plot.execute({ book: "测试", action: "done", id }, exec);
const afterDone = await defs.novel_plot.execute({ book: "测试", action: "list" }, exec);
console.log("done 后:", afterDone.entries.map((e) => e.content + ":" + e.status).join(" "));
if (afterDone.entries.find((e) => e.id === id).status !== "done") throw new Error("plot done broken");
const plotFile = join(testRoot, ".novel-writer", "plots", "测试.json");
if (!existsSync(plotFile)) throw new Error("plot file not persisted");
console.log("伏笔文件:", plotFile, "存在 ✓");

// 4) 关键词（三字组/疑似人名）
writeFileSync(join(testRoot, "novels", "测试", "第03章.md"), "露西亚说着话，琉璃点了点头。露西亚问导师问题，琉璃笑道：\"多谢导师提点，承蒙关照。\" 她又给母神上了一柱香。\n", "utf8");
const kw = await defs.novel_keywords.execute({ book: "测试", top: 20 }, exec);
console.log("关键词:", kw.keywords.map((k) => k.word + "(" + k.kind + ")").join(" "));
if (!kw.keywords.some((k) => k.kind === "name-candidate" && (k.word.includes("露西") || k.word.includes("琉璃")))) throw new Error("name candidate missing");

// 4.5) v0.9.0 世界观：detect 判断 + add 登记 + continuity 用语扫描
const det = await defs.novel_settings.execute({ book: "测试", action: "detect" }, exec);
console.log("worldview detect:", det.culture, det.confidence, "| 证据:", (det.evidence?.western ?? []).slice(0, 2).join(" "));
if (typeof det.culture !== "string") throw new Error("detect broken");
await defs.novel_settings.execute({ book: "测试", category: "worldview", action: "add", name: "欧式中世纪", basis: "教堂/神甫/马车", bannedWords: ["上香", "老夫"], recommended: { "上香": "点烛" }, ritual: "点烛不烧香" }, exec);
const wv = await defs.novel_settings.execute({ book: "测试", category: "worldview", action: "list" }, exec);
if (!wv.worldview.some((e) => e.name === "欧式中世纪")) throw new Error("worldview add broken");
// v1.0.0 语用级：worldview 带 speechStyle（欧式）→ 扫描客套/仪式/称谓
await defs.novel_settings.execute({ book: "测试", category: "worldview", action: "add", name: "欧式基准", basis: "western 风格", bannedWords: [], recommended: {}, speechStyle: { title: "Miss+名,不用XX小姐", honorBad: ["提点", "承蒙"], honorGood: { "提点": "提醒" }, ritualBadPatterns: ["上[一二三四五六七八九十百千]*柱?香"], ritualGoodNote: "点烛", tone: "口语化" } }, exec);
// v1.0.2：detect 流派 + add/update 单条返回
const det2 = await defs.novel_settings.execute({ book: "测试", category: "worldview", action: "detect" }, exec);
console.log("v1.0.2 detect:", det2.culture, "| 流派:", det2.genre?.dominant ?? "unknown");
const sumAdd = await defs.novel_summary.execute({ book: "测试", action: "add", chapter: "第01章", summary: "单条测试" }, exec);
if (sumAdd.summaries.length !== 1) throw new Error("summary add should return single entry");
const plotAdd = await defs.novel_plot.execute({ book: "测试", action: "add", content: "单条伏笔" }, exec);
if (plotAdd.entries.length !== 1) throw new Error("plot add should return single entry");
const setAdd = await defs.novel_settings.execute({ book: "测试", category: "character", action: "add", name: "单条角色" }, exec);
if (setAdd.characters.length !== 1) throw new Error("settings add should return single entry");
console.log("v1.0.2 单条返回: summary/plot/settings 全部 ✓");
// v1.0.2 题材检测（骨）
const det3 = await defs.novel_settings.execute({ book: "测试", category: "worldview", action: "detect" }, exec);
console.log("v1.0.2 题材:", det3.theme?.dominant ?? "unknown", "→", det3.theme?.secondary ?? "");

// v1.5.0：情感净化（clean/caveat）+ 功能开关生效
const saClean = await defs.novel_sentence_analysis.execute({ book: "测试", fresh: true }, exec);
console.log("v1.5.0 emotion:", saClean.emotion?.dominant, "| clean:", saClean.emotion?.cleanDominant, "| conf:", saClean.emotion?.confidence);
if (!("cleanDominant" in (saClean.emotion ?? {}))) throw new Error("emotion clean missing");
// 关闭 emotionCaveat → clean/caveat 消失
await defs.novel_sentence_config.execute({ action: "set", features: { emotionCaveat: false } }, exec);
const saOff = await defs.novel_sentence_analysis.execute({ book: "测试", fresh: true }, exec);
if ("cleanDominant" in (saOff.emotion ?? {})) throw new Error("emotionCaveat off should crop clean");
await defs.novel_sentence_config.execute({ action: "set", features: { emotionCaveat: true } }, exec);
// 关闭 genreTheme → detect 无 genre/theme
await defs.novel_sentence_config.execute({ action: "set", features: { genreTheme: false } }, exec);
const detOff = await defs.novel_settings.execute({ book: "测试", category: "worldview", action: "detect" }, exec);
if ("genre" in detOff) throw new Error("genreTheme off should drop genre");
await defs.novel_sentence_config.execute({ action: "set", features: { genreTheme: true } }, exec);
const cfgF = await defs.novel_sentence_config.execute({ action: "get" }, exec);
if (cfgF.features?.emotionCaveat !== true || cfgF.features?.genreTheme !== true) throw new Error("features restore failed");
console.log("v1.5.0 功能开关: 关→生效, 开→恢复 ✓");

// v1.6.0：情感量化（quantification 存在 + 开关裁剪）
const saQ = await defs.novel_sentence_analysis.execute({ book: "测试", fresh: true }, exec);
const q = saQ.emotion?.quantification;
if (!q || typeof q.stats?.variance !== "number") throw new Error("quantification missing");
if (!["high", "medium", "low"].includes(q.complexity?.level)) throw new Error("complexity level broken");
console.log("v1.6.0 量化: V=" + q.stats.variance + " C=" + q.stats.conflict + " level=" + q.complexity?.level);
await defs.novel_sentence_config.execute({ action: "set", features: { emotionComplexity: false } }, exec);
const saQOff = await defs.novel_sentence_analysis.execute({ book: "测试", fresh: true }, exec);
if ("quantification" in (saQOff.emotion ?? {})) throw new Error("emotionComplexity off should drop quantification");
await defs.novel_sentence_config.execute({ action: "set", features: { emotionComplexity: true } }, exec);
console.log("v1.6.0 情感量化开关: 关→生效, 开→恢复 ✓");

// v2.0.0：语义检索工具存在 + 开关门禁（无模型环境也应返回 available:false 而非崩溃）
const semTool = defs.novel_semantic_search;
if (!semTool) throw new Error("novel_semantic_search missing");
await defs.novel_sentence_config.execute({ action: "set", features: { semanticEmbedding: false } }, exec);
const semOff = await semTool.execute({ book: "测试", query: "任何" }, exec);
if (semOff.available !== false) throw new Error("semantic switch off should disable search");
await defs.novel_sentence_config.execute({ action: "set", features: { semanticEmbedding: true } }, exec);
const cfgV2 = await defs.novel_sentence_config.execute({ action: "get" }, exec);
if (typeof cfgV2.embedding?.available !== "boolean") throw new Error("embedding status missing");
console.log("v2.0.0 语义检索: 工具注册✓ 开关门禁✓ 状态字段✓");

// v2.0.0：非净化模式（rawWriting）开关 + 动态 section
await defs.novel_sentence_config.execute({ action: "set", features: { rawWriting: true } }, exec);
const cfgRaw = await defs.novel_sentence_config.execute({ action: "get" }, exec);
if (cfgRaw.features?.rawWriting !== true) throw new Error("rawWriting set failed");
await defs.novel_sentence_config.execute({ action: "set", features: { rawWriting: false } }, exec);
console.log("v2.0.0 非净化模式: 开关读写✓");
if (det3.theme && det3.theme.dominant !== null && typeof det3.theme.dominant !== "string") throw new Error("theme broken");

const cont3 = await defs.novel_continuity_check.execute({ book: "测试" }, exec);
const prag = cont3.candidates.filter((x) => x.type.startsWith("语用"));
console.log("v1.0.0 语用扫描:", prag.map((x) => x.type + ":" + x.detail.slice(0, 24)).join(" | ") || "(无)");
if (prag.length === 0) throw new Error("pragmatic scan broken (test text lacks markers)");

const cont2 = await defs.novel_continuity_check.execute({ book: "测试" }, exec);
console.log("continuity 用语扫描:", cont2.candidates.filter((x) => x.type === "用语冲突").map((x) => x.detail.slice(0, 30)).join(" | ") || "(无)");

// 5) 路由 allowLan：非 loopback 同源放行
const handler = routes.find((r) => r.path === "/api/dsh-novel-writer/state").handler;
const res = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = String(b); } };
await handler({
  method: "GET", url: "/api/dsh-novel-writer/state",
  socket: { remoteAddress: "192.168.1.5" },
  headers: { host: "192.168.1.5:3080", origin: "http://192.168.1.5:3080" },
}, res);
console.log("局域网 GET（allowLanState=true）:", res.status);
if (res.status !== 200) throw new Error("allowLan route broken");


// v2.5.0: novel_style_report 实际调用（报告生成 + 字段完整性）
{
  const def = defs.novel_style_report;
  if (!def) throw new Error("novel_style_report not registered");
  const r = await def.execute({ book: "测试", root: testRoot }, exec);
  if (!r.report || !String(r.report).includes("风格画像报告")) throw new Error("style_report: report 内容缺失");
  if (!Array.isArray(r.semantic)) throw new Error("style_report: semantic 应为数组");
  console.log("novel_style_report: OK (" + r.chars + " chars, semantic " + r.semantic.length + ")");
}

// 清理缓存文件（保留状态文件）
rmSync(testRoot, { recursive: true, force: true });
console.log("\nALL E2E TESTS PASSED");
