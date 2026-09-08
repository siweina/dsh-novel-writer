// v3.9.5 端到端测试：16 工具注册、缓存、伏笔、风格自检、路由、语用扫描（v0.6.0 起持续扩展）

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { apply } from "../lib/index.js";

// v3.9.5 修正（H3）：先隔离 env、再解析 STATE_FILE——旧版在模块加载时先绑定了用户真实 ~/.dsh 路径，
// 退出处理器可能写回/删除真实用户配置；testRoot 也移出仓库目录（不再在 test/ 下留残渣）
const testRoot = join(tmpdir(), "dsh-novel-writer-e2e-" + process.pid + "-" + Date.now().toString(36));
process.env.DSH_NOVEL_WRITER_STATE = join(testRoot, "state-test.json");
const STATE_FILE = process.env.DSH_NOVEL_WRITER_STATE;
// v4.0.0：删除 stateBackup/恢复死代码——STATE_FILE 在全新随机 testRoot 内（下面 rmSync 还会先删掉 testRoot），
// stateBackup 恒为 null、恢复分支永不执行；真正的隔离靠 stateFilePath() 惰性读 env，
// 因此改为"写盘后断言状态文件落在 env 指定的 tmpdir（见开关门禁段）"来防回归。
process.on("exit", () => {
  try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
});
rmSync(testRoot, { recursive: true, force: true });

// v4.0.0：告警即失败护栏——插件运行期 console.warn（如 vibe.js 语义映射契约失配）此前完全不被测试感知，
// 全套 e2e 跑绿却在 stderr 持续刷告警；这里捕获后统一在末尾失败。
const pluginWarnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  const text = args.map((a) => (typeof a === "string" ? a : String(a && a.message ? a.message : a))).join(" ");
  if (text.includes("[novel-writer]") || text.includes("[dsh-novel-writer]")) pluginWarnings.push(text);
  return originalWarn.apply(console, args);
};
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
if (names.length !== 16) throw new Error("expected 16 tools (v3.1.0)");

const exec = { agent: { session: { header: { cwd: testRoot } } } };

// ---- DSH schema 规则检查（additionalProperties 必须布尔；禁用 pattern/format/数值边界关键字）----
const SCHEMA_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "oneOf"]);
const SCHEMA_BANNED = ["pattern", "format", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"];
// v4.0.0：宿主 assertSupportedJsonSchema 的硬规则补全——旧版自造校验器只查 3 条（禁用关键词/additionalProperties 布尔/type 字符串），
// type 取值枚举、required ⊆ properties、oneOf ≥ 2、enum/const 与 type 同型、properties/items 放错节点全部漏检（宿主会拒收的 schema 能过 CI）。
const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
function schemaScalarMatches(value, type) {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number";
  if (type === "integer") return Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}
function assertDshSchema(node, where) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(function (item, i) { assertDshSchema(item, where + "[" + i + "]"); }); return; }
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (!SCHEMA_KEYWORDS.has(key)) continue;
    if (key === "additionalProperties" && typeof v !== "boolean") throw new Error(where + ".additionalProperties must be boolean: " + JSON.stringify(v).slice(0, 60));
    // v3.7.0：宿主不支持 type 数组（曾写 ["object","null"] 导致插件树加载失败）——schema type 必须是单字符串，e2e 必须拦住
    if (key === "type" && typeof v !== "string") throw new Error(where + ".type must be a single string (type arrays are not supported by host): " + JSON.stringify(v).slice(0, 60));
    // v4.0.0：type 取值必须是宿主支持的 7 种（"String"/"Object" 这类大小写错误此前照样通过）
    if (key === "type" && !SCHEMA_TYPES.has(v)) throw new Error(where + ".type 非法值（宿主仅支持 " + [...SCHEMA_TYPES].join("|") + "）: " + JSON.stringify(v));
    if (key === "properties" && node.type !== "object") throw new Error(where + ".properties 只能出现在 type=object 节点（实际 type=" + JSON.stringify(node.type) + "）");
    if (key === "items" && node.type !== "array") throw new Error(where + ".items 只能出现在 type=array 节点（实际 type=" + JSON.stringify(node.type) + "）");
    if (key === "additionalProperties" && node.type !== "object") throw new Error(where + ".additionalProperties 只能出现在 type=object 节点");
    if (key === "required") {
      if (!Array.isArray(v) || v.length === 0) throw new Error(where + ".required 必须是非空字符串数组");
      if (typeof node.properties !== "object" || node.properties === null) throw new Error(where + ".required 缺少同级 properties（宿主会拒收）");
      for (const name of v) {
        if (typeof name !== "string") throw new Error(where + ".required 含非字符串项: " + JSON.stringify(name));
        if (!Object.prototype.hasOwnProperty.call(node.properties, name)) throw new Error(where + ".required 「" + name + "」不在 properties 中（宿主会拒收）");
      }
    }
    if (key === "oneOf" && (!Array.isArray(v) || v.length < 2)) throw new Error(where + ".oneOf 至少需要 2 个分支（宿主会拒收）");
    if ((key === "enum" || key === "const") && typeof node.type === "string") {
      const values = key === "enum" ? (Array.isArray(v) ? v : [v]) : [v];
      for (const value of values) {
        if (!schemaScalarMatches(value, node.type)) throw new Error(where + "." + key + " 与 type=" + node.type + " 不同型: " + JSON.stringify(value).slice(0, 40));
      }
    }
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
console.log("DSH schema 规则检查: 全部通过（type 枚举/required⊆properties/oneOf≥2/enum 同型/节点位置）");

// v4.0.0：宿主级值类型断言（供契约循环与调用点共用）
const typeOk = (val, t) => {
  if (t === "object") return val !== null && typeof val === "object" && !Array.isArray(val);
  if (t === "array") return Array.isArray(val);
  if (t === "null") return val === null;
  if (t === "string") return typeof val === "string";
  if (t === "boolean") return typeof val === "boolean";
  if (t === "integer") return Number.isInteger(val); // v4.0.0：integer 必须整数（旧版与 number 同判）
  if (t === "number") return typeof val === "number";
  return true;
};
// v4.0.0：单次输出契约断言——调用点用它补齐"循环没样例"的工具（new_chapter/import/sentence_analysis/semantic_search）
// 校验：返回键 ⊆ properties、schema.required 全部存在、已出现键的 type 匹配。
function assertOutputContract(def, result, label) {
  const sch = def?.output?.schema;
  if (!sch || sch.additionalProperties !== false) return 0;
  let issues = 0;
  const props = new Set(Object.keys(sch.properties || {}));
  const extra = Object.keys(result || {}).filter((k) => !props.has(k));
  if (extra.length) { issues++; console.log("契约 ✗ " + label + " 未声明字段: " + extra.join(",")); }
  for (const key of sch.required || []) {
    if (!(key in (result || {}))) { issues++; console.log("契约 ✗ " + label + " 缺必填字段: " + key); }
  }
  for (const [key, ps] of Object.entries(sch.properties || {})) {
    if (key in (result || {}) && !typeOk(result[key], ps.type)) {
      issues++;
      console.log("契约类型 ✗ " + label + "." + key + ": 需要 " + JSON.stringify(ps.type) + " 实际 " + (result[key] === null ? "null" : typeof result[key]));
    }
  }
  if (issues > 0) throw new Error("输出契约违规 " + label + " " + issues + " 处");
  return 1;
}

// v3.5.0 #74：输出契约校验——additionalProperties:false 的工具，真实调用后返回键必须全在 schema 声明（防"新字段漏声明"回归）
await (async function outputContractCheck() {
  // v3.7.0：契约 IIFE 顶层 await——此前未 await，与分析段并发（首次分析 cache 断言竞态 flaky）
  const contractCalls = {
    novel_books: { root: testRoot },
    novel_chapters: { book: "测试", root: testRoot },
    novel_read: { book: "测试", chapter: "1", root: testRoot },
    novel_keywords: { book: "测试", root: testRoot },
    // novel_sentence_analysis 已从契约清单移除（v3.7.0：它会写缓存，与"首次分析 cache: miss"断言冲突；分析已有专门测试段）
    novel_sentence_config: { action: "get" },
    novel_style_check: { book: "测试", chapter: "第02章", root: testRoot },
    novel_plot: { book: "测试", root: testRoot },
    novel_settings: { book: "测试", action: "list", category: "character", root: testRoot },
    novel_summary: { book: "测试", root: testRoot },
    novel_continuity_check: { book: "测试", chapter: "第02章", root: testRoot },
    novel_style_report: { book: "测试", brief: true, root: testRoot },
    novel_outline: { book: "测试", action: "read", file: "status", root: testRoot }
  };
  // v4.0.0：这 4 个工具没有"循环调用样例"（analysis 会写缓存与 miss 断言冲突），改为在各自调用点断言契约
  const CONTRACT_AT_CALLSITE = ["novel_new_chapter", "novel_import", "novel_sentence_analysis", "novel_semantic_search"];
  let contractIssues = 0;
  const contractChecked = [];
  const contractSkipped = [];
  for (const d of registry) {
    const args = contractCalls[d.name];
    const sch = d.output?.schema;
    if (!sch || sch.additionalProperties !== false) continue;
    // v4.0.0：跳过项不再静默（旧版 4 个工具被 continue 掉却打印"全部通过"）
    if (!args) { contractSkipped.push(d.name); continue; }
    // v3.5.0 M20：调用失败不再静默跳过——任何故障都显式失败（防"全绿"假象）
    let result = null;
    try { result = await d.execute(args, exec); } catch (e) { throw new Error("输出契约检查调用失败 " + d.name + ": " + String(e).slice(0, 120)); }
    contractChecked.push(d.name);
    const props = new Set(Object.keys(sch.properties || {}));
    const missing = Object.keys(result || {}).filter((k) => !props.has(k));
    if (missing.length) { contractIssues++; console.log("契约 ✗ " + d.name + ": " + missing.join(",")); }
    // v4.0.0：schema.required 缺失此前从不校验（工具漏返回必填字段 → 宿主拒收，CI 却全绿）
    for (const key of sch.required || []) {
      if (!(key in (result || {}))) { contractIssues++; console.log("契约 ✗ " + d.name + " 缺必填字段: " + key); }
    }
    // v4.0.0：typeOk 提升到模块作用域（旧版内联在循环里，且 Array.isArray(t) 分支因 :52 的"type 必须单字符串"恒为死代码）
    for (const [k, ps] of Object.entries(sch.properties || {})) {
      if (k in (result || {}) && !typeOk(result[k], ps.type)) {
        contractIssues++;
        console.log("契约类型 ✗ " + d.name + "." + k + ": 需要 " + JSON.stringify(ps.type) + " 实际 " + (result[k] === null ? "null" : typeof result[k]));
      }
    }
  }
  if (contractIssues > 0) throw new Error("输出契约违规 " + contractIssues + " 处");
  // v4.0.0：跳过项不再静默——4 个工具已改在各自调用点断言，其余若既无样例又无调用点断言则显式失败
  const unaccounted = contractSkipped.filter((n) => !CONTRACT_AT_CALLSITE.includes(n));
  if (unaccounted.length > 0) throw new Error("输出契约检查遗漏工具（既无循环样例也无调用点断言）: " + unaccounted.join(","));
  console.log("输出契约检查: 循环 " + contractChecked.length + " 个工具通过；调用点断言 " + CONTRACT_AT_CALLSITE.join("/") + "；未覆盖 无");
})();

// v3.5.0 三轮：5 个工具的开关门禁断言（关开关 → 拒绝并提示）
{
  const gatedTools = ["novel_settings", "novel_summary", "novel_continuity_check", "novel_style_report", "novel_semantic_search"];
  for (const t of gatedTools) {
    await defs.novel_sentence_config.execute({ action: "set", tools: { [t]: false } }, exec);
    let rejected = false;
    try { await defs[t].execute({ book: "测试", root: testRoot }, exec); } catch (e) { rejected = String(e).includes("关闭"); }
    if (!rejected) throw new Error("开关门禁失败: " + t);
    await defs.novel_sentence_config.execute({ action: "set", tools: { [t]: true } }, exec);
  }
  // v4.0.0：隔离防回归——上面 set 已触发落盘；若有人把 stateFilePath() 改成模块级常量，
  // 静态 import 早于 env 赋值，状态文件会写到真实 ~/.dsh 而不是这里，本断言会立刻失败。
  if (!existsSync(STATE_FILE)) throw new Error("状态文件未落在 env 指定路径（stateFilePath 可能已非惰性读取，会污染用户真实配置）: " + STATE_FILE);
  if (!STATE_FILE.startsWith(tmpdir())) throw new Error("状态文件不在 tmpdir 隔离区: " + STATE_FILE);
  const realStatePath = join(homedir(), ".dsh", "dsh-novel-writer", "state.json");
  if (STATE_FILE === realStatePath) throw new Error("状态文件指向用户真实配置路径（隔离失效）: " + STATE_FILE);
  console.log("开关门禁: 5 工具全部拒绝 ✓ | 状态文件隔离: ✓ " + (STATE_FILE.startsWith(tmpdir()) ? "tmpdir" : "?"));
}

// 1) 分析 + 缓存（第一次 miss，第二次 hit）
const first = await defs.novel_sentence_analysis.execute({ book: "测试" }, exec);
assertOutputContract(defs.novel_sentence_analysis, first, "novel_sentence_analysis(first)"); // v4.0.0：调用点补契约断言
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
// v4.0.0：语用样本修正——旧文本「上了一柱香」匹配不上登记的正则 上[一…]*柱?香（"了"卡住），
// 且没有"XX小姐"→ 仪式/称谓两路实际零覆盖；这里补「上一柱香」「上香」（用语冲突）与「琉璃小姐」（称谓）。
writeFileSync(join(testRoot, "novels", "测试", "第03章.md"), "露西亚说着话，琉璃点了点头。露西亚问导师问题，琉璃笑道：\"多谢导师提点，承蒙关照。\" 她又给母神上一柱香，也给神像上香，唤了声「琉璃小姐」。\n", "utf8");
const kw = await defs.novel_keywords.execute({ book: "测试", top: 20 }, exec);
console.log("关键词:", kw.keywords.map((k) => k.word + "(" + k.kind + ")").join(" "));
if (!kw.keywords.some((k) => k.kind === "name-candidate" && (k.word.includes("露西") || k.word.includes("琉璃")))) throw new Error("name candidate missing");

// 4.5) v0.9.0 世界观：detect 判断 + add 登记 + continuity 用语扫描
const det = await defs.novel_settings.execute({ book: "测试", action: "detect" }, exec);
console.log("worldview detect:", det.culture, det.confidence, "| 证据:", (det.evidence?.western ?? []).slice(0, 2).join(" "));
// v4.0.0：旧断言只查 typeof culture === "string"（退化成恒返回 "unknown" 也算过）。
// 样本含 eastern 标志词（上香/神像），断言具体 culture 与证据命中。
if (det.culture !== "mixed") throw new Error("detect 应判为 mixed（样本含中西标志词），实际 " + det.culture);
if (!(det.evidence?.eastern ?? []).some((e) => String(e).includes("上香"))) throw new Error("detect 证据缺 eastern 上香: " + JSON.stringify(det.evidence));
if (typeof det.confidence !== "number" || det.confidence <= 0 || det.confidence > 1) throw new Error("detect confidence 异常: " + det.confidence);
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
// v4.0.0：旧断言只要求"至少 1 条语用候选"——客套 2 条就能满足，SKILL 宣称的仪式/称谓两路实际零覆盖。
// 样本已补「上一柱香」与「琉璃小姐」，这里按 type 精确要求三类各 ≥1。
for (const type of ["语用冲突·客套", "语用冲突·仪式", "语用冲突·称谓"]) {
  if (!prag.some((x) => x.type === type)) throw new Error("语用扫描缺类型「" + type + "」: " + prag.map((x) => x.type).join(","));
}
console.log("v1.0.0 语用扫描三类: 客套/仪式/称谓 各 ≥1 ✓");

const cont2 = await defs.novel_continuity_check.execute({ book: "测试" }, exec);
const styleHits = cont2.candidates.filter((x) => x.type === "用语冲突");
console.log("continuity 用语扫描:", styleHits.map((x) => x.detail.slice(0, 30)).join(" | ") || "(无)");
// v4.0.0：旧版只打印不校验——正文含 bannedWords「上香」，必须命中用语冲突（词表/扫描退化会被抓住）
if (!styleHits.some((x) => x.detail.includes("上香"))) throw new Error("用语冲突未命中 bannedWords「上香」: " + JSON.stringify(styleHits.map((x) => x.detail)));

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


// v3.5.0 M23：核心路径补测
{
  // ① POST null 拒绝（400）
  const nullReq = { method: "POST", url: "/api/dsh-novel-writer/state", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" }, [Symbol.asyncIterator]: function () { const chunks = [Buffer.from("null")]; let i = 0; return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) }; } };
  const nullRes = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = String(b); } };
  const routeState = routes.find((r) => r.path === "/api/dsh-novel-writer/state");
  await routeState.handler(nullReq, nullRes);
  if (nullRes.status !== 400) throw new Error("POST null 应拒绝 400，实际 " + nullRes.status);
  console.log("POST null 拒绝: ✓");
  // ② OOC 哨兵模式——无登记角色分支（v4.0.0：旧注释写"无登记角色"，但测试书早已登记「单条角色」，
  // 走的是有角色分支，目标分支零覆盖；这里另起一本干净的书真正覆盖无登记路径）
  mkdirSync(join(testRoot, "novels", "无角色书"), { recursive: true });
  writeFileSync(join(testRoot, "novels", "无角色书", "第01章.md"), "她走下楼，街道空无一人，风把纸片吹得满地打转，她攥紧了衣角。\n", "utf8");
  const oocEmpty = await defs.novel_continuity_check.execute({ book: "无角色书", ooc: true, root: testRoot }, exec);
  if (oocEmpty.action !== "OOC") throw new Error("OOC 无登记角色分支 action 缺失");
  if (!/未登记角色/.test(oocEmpty.advice || "")) throw new Error("OOC 无登记角色提示缺失: " + oocEmpty.advice);
  if (oocEmpty.candidates.length !== 0) throw new Error("无登记角色不应有 OOC 候选: " + JSON.stringify(oocEmpty.candidates));
  console.log("OOC 无登记角色分支: ✓ (" + (oocEmpty.advice || "").slice(0, 20) + ")");
  // ②b OOC 哨兵模式——已登记角色分支（测试书已登记「单条角色」）
  const ooc = await defs.novel_continuity_check.execute({ book: "测试", ooc: true, root: testRoot }, exec);
  if (ooc.action !== "OOC") throw new Error("ooc 模式 action 缺失");
  if (/未登记角色/.test(ooc.advice || "")) throw new Error("已登记角色却走了无角色分支: " + ooc.advice);
  console.log("OOC 哨兵: ✓ (" + ((ooc.advice || "").slice(0, 20)) + ")");
  // ③ outline 哨兵模式
  const ol = await defs.novel_continuity_check.execute({ book: "测试", outline: true, root: testRoot }, exec);
  if (ol.action !== "大纲对照") throw new Error("outline 模式 action 缺失");
  console.log("大纲哨兵: ✓");
  // ④ read 分页（offset/limit + truncated）
  const rp = await defs.novel_read.execute({ book: "测试", chapter: "第01章", offset: 1, limit: 1, root: testRoot }, exec);
  if (rp.lines.length !== 1) throw new Error("read 分页 limit 失效");
  console.log("read 分页: ✓ (" + rp.lines.length + " 行, truncated=" + rp.truncated + ")");
  // ⑤ settings timeline update 按 day 双查（M10）
  await defs.novel_settings.execute({ book: "测试", category: "timeline", action: "add", day: "第1天", event: "穿越", root: testRoot }, exec);
  const up = await defs.novel_settings.execute({ book: "测试", category: "timeline", action: "update", day: "第1天", event: "穿越后", root: testRoot }, exec);
  if (!/更新|已更新|已修改/.test(up.message || "")) throw new Error("timeline update 失效: " + (up.message || ""));
  console.log("timeline update: ✓");
}

// v3.5.0 M21b：detect 断言加固（西式/中式样本 → culture+evidence 非空）
{
  const mkBook = async (bn, text) => {
    const dir = join(testRoot, "novels", bn);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "第01章.md"), text, "utf8");
  };
  await mkBook("西式样本", "城堡的钟声响起，骑士在教堂前祈祷，公爵举起酒杯。\n");
  await mkBook("中式样本", "老爷坐在堂前，丫鬟奉上香茶，小姐在庙里上香祈福。\n");
  const detW = await defs.novel_settings.execute({ book: "西式样本", action: "detect", root: testRoot }, exec);
  if (detW.culture !== "western" || !(detW.evidence?.western ?? []).length) throw new Error("西式 detect 失败: " + detW.culture);
  console.log("detect 西式样本: ✓ " + detW.culture + " 证据 " + (detW.evidence.western || []).length + " 条");
  const detC = await defs.novel_settings.execute({ book: "中式样本", action: "detect", root: testRoot }, exec);
  if (detC.culture !== "eastern" || !(detC.evidence?.eastern ?? []).length) throw new Error("中式 detect 失败: " + detC.culture);
  console.log("detect 中式样本: ✓ " + detC.culture + " 证据 " + (detC.evidence.eastern || []).length + " 条");
  // 清理样本
  rmSync(join(testRoot, "novels", "西式样本"), { recursive: true, force: true });
  rmSync(join(testRoot, "novels", "中式样本"), { recursive: true, force: true });
}

// v3.1.0: POST 保存设定 → 自动创建创作资料（设定同步）
{
  const bodyStr = JSON.stringify({ creationProfiles: { "设定同步书": { worldview: "末日测试" } } });
  const req = {
    method: "POST", url: "/api/dsh-novel-writer/state",
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" },
    [Symbol.asyncIterator]: function () {
      const chunks = [Buffer.from(bodyStr)]; let i = 0;
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) };
    }
  };
  const res = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = String(b); } };
  await handler(req, res);
  if (res.status !== 200) throw new Error("POST state broken: " + res.status);
  const f = join(testRoot, "novels", "创作资料", "设定同步书", "创作设定.md");
  if (!existsSync(f)) throw new Error("sync: 创作设定.md 未自动创建");
  const c = readFileSync(f, "utf8");
  if (!c.includes("世界观：末日测试")) throw new Error("sync: 设定未预填");
  const cf = join(testRoot, "novels", "创作资料", "设定同步书", "主要人物设定.md");
  if (existsSync(cf)) {
    const cc = readFileSync(cf, "utf8");
    if (cc.includes("【用户角色设定】")) throw new Error("sync: 无角色设定不应有角色段");
  }
  console.log("v3.1.0 设定同步: POST 自动建创作资料✓");
  // v3.1.1: 删除设定 → 空壳文件夹同步删除
  const bodyStr3 = JSON.stringify({ creationProfiles: { "设定同步书": null } });
  const req3 = { method: "POST", url: "/api/dsh-novel-writer/state", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" }, [Symbol.asyncIterator]: function () { const c = [Buffer.from(bodyStr3)]; let i = 0; return { next: async () => (i < c.length ? { value: c[i++], done: false } : { done: true }) }; } };
  const res3 = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = String(b); } };
  await handler(req3, res3);
  if (existsSync(join(testRoot, "novels", "创作资料", "设定同步书"))) throw new Error("sync: 空壳文件夹未删除");
  console.log("v3.1.1 空壳删除: 设定删除后文件夹消失✓");
}

// v3.1.0: init 首次创建 → 主要人物设定.md 角色段同步（回归：角色设定不丢）
{
  await defs.novel_sentence_config.execute({ action: "set", creationProfiles: { "角色测试书": { worldview: "末世", characters: "女主：冷面剑客" } } }, exec);
  await defs.novel_outline.execute({ book: "角色测试书", action: "init", root: testRoot }, exec);
  const cf = join(testRoot, "novels", "创作资料", "角色测试书", "主要人物设定.md");
  const cc = readFileSync(cf, "utf8");
  if (!cc.includes("【用户角色设定】") || !cc.includes("女主：冷面剑客")) throw new Error("novel_outline: 首次 init 角色段缺失");
  console.log("novel_outline: 首 init 角色段✓");
}

// v3.2.0: 衔接检查模式（chapter 参数 + action/chapter 输出字段契约）
{
  // v4.0.0：旧用例拿「测试」书跑，实测 0 候选也算过（只断言 action/chapter 类型）——业务上什么都没验到。
  // 这里造"上章无时间锚 + 本章开头『三天后』"的样本，断言必须命中「衔接·时间跳跃」并引用硬跳词。
  mkdirSync(join(testRoot, "novels", "衔接样本"), { recursive: true });
  writeFileSync(join(testRoot, "novels", "衔接样本", "第01章.md"), "她把门合上，站在走廊里发了很久的呆，最后什么也没说，转身走下楼去。\n", "utf8");
  writeFileSync(join(testRoot, "novels", "衔接样本", "第02章.md"), "三天后，雨终于停了，她提着箱子回到了城里，街上的人都行色匆匆。\n", "utf8");
  const r = await defs.novel_continuity_check.execute({ book: "衔接样本", chapter: "第02章", root: testRoot }, exec);
  if (r.action !== "衔接") throw new Error("continuity: 衔接模式 action 缺失");
  if (typeof r.chapter !== "string") throw new Error("continuity: chapter 输出缺失");
  const jump = (r.candidates || []).find((x) => x.type === "衔接·时间跳跃");
  if (!jump) throw new Error("衔接模式未命中时间硬跳（三天后）: " + JSON.stringify(r.candidates));
  if (!String(jump.detail).includes("三天后")) throw new Error("衔接候选 detail 未引用硬跳词: " + jump.detail);
  if (!/衔接风险/.test(r.advice || "")) throw new Error("衔接模式 advice 未提示风险: " + r.advice);
  console.log("v3.2.0 衔接模式: OK (" + (r.candidates || []).length + " 候选, 命中时间硬跳)");
}

// v3.1.0: novel_outline 实际调用（初始化 + 大纲 + 钩子 + 未回填提醒）
{
  const def = defs.novel_outline;
  if (!def) throw new Error("novel_outline not registered");
  await def.execute({ book: "测试", action: "init", root: testRoot }, exec);
  await def.execute({ book: "测试", action: "chapter", number: 1, title: "开篇", root: testRoot }, exec);
  const st = await def.execute({ book: "测试", action: "read", file: "status", root: testRoot }, exec);
  if (!String(st.content).includes("未回填钩子章节")) throw new Error("novel_outline: 未回填提醒缺失");
  await def.execute({ book: "测试", action: "hook", number: 1, body: "结尾悬念。", root: testRoot }, exec);
  const st2 = await def.execute({ book: "测试", action: "read", file: "status", root: testRoot }, exec);
  if (String(st2.content).includes("未回填钩子章节")) throw new Error("novel_outline: 回填后仍提醒");
  console.log("novel_outline: OK (init + outline + hook + remind)");
}

// v2.5.0: novel_style_report 实际调用（报告生成 + 字段完整性）
{
  const def = defs.novel_style_report;
  if (!def) throw new Error("novel_style_report not registered");
  const r = await def.execute({ book: "测试", root: testRoot }, exec);
  if (!r.report || !String(r.report).includes("风格画像报告")) throw new Error("style_report: report 内容缺失");
  if (!Array.isArray(r.semantic)) throw new Error("style_report: semantic 应为数组");
  console.log("novel_style_report: OK (" + r.chars + " chars, semantic " + r.semantic.length + ")");
}

// v3.7.0 ⑤：覆盖缺口——import/new_chapter/semantic_search 成功路径 + config set/清除类型断言
{
  const mk = (bn, fname, txt) => {
    mkdirSync(join(testRoot, "novels", bn), { recursive: true });
    writeFileSync(join(testRoot, "novels", bn, fname), txt, "utf8");
  };
  mk("导入书", "第01章 开篇.md", "第一章正文内容。\n");
  // import scan（预览路径）
  const imp = await defs.novel_import.execute({ src: join(testRoot, "novels", "导入书"), mode: "scan", root: testRoot }, exec);
  assertOutputContract(defs.novel_import, imp, "novel_import(scan)"); // v4.0.0：调用点补契约断言
  if (!Array.isArray(imp.groups) || imp.groups.length === 0) throw new Error("import scan 空结果");
  if (imp.mode !== "scan" || imp.imported.length !== 0) throw new Error("scan 模式不应写盘: " + JSON.stringify({ mode: imp.mode, imported: imp.imported.length }));
  console.log("import scan: ✓ (" + imp.groups.length + " 组, 未写盘)");
  // v4.0.0：补 import apply 写盘路径（旧块头注释写"apply 成功路径"，实际只跑了 scan——复制/移动/合并/落盘分支零覆盖）
  const applySrc = join(testRoot, "import-src");
  mkdirSync(applySrc, { recursive: true });
  writeFileSync(join(applySrc, "导入测试书 第01章 开篇.md"), "第一章正文内容。\n", "utf8");
  writeFileSync(join(applySrc, "导入测试书 第02章 承接.md"), "第二章正文内容。\n", "utf8");
  const applyRes = await defs.novel_import.execute({ src: applySrc, mode: "apply", root: testRoot }, exec);
  assertOutputContract(defs.novel_import, applyRes, "novel_import(apply)");
  if (applyRes.mode !== "apply" || applyRes.imported.length !== 2) throw new Error("import apply 未导入 2 个文件: " + JSON.stringify(applyRes.imported));
  const destDir = join(testRoot, "novels", "导入测试书");
  const destFiles = readdirSync(destDir).sort();
  if (destFiles.length !== 2) throw new Error("import apply 落盘文件数错: " + JSON.stringify(destFiles));
  if (readFileSync(join(destDir, "导入测试书 第01章 开篇.md"), "utf8").trim() !== "第一章正文内容。") throw new Error("import apply 复制内容不一致");
  if (readdirSync(applySrc).length !== 2) throw new Error("copy 模式不应删除源文件");
  // 移动分支
  const moveSrc = join(testRoot, "import-move-src");
  mkdirSync(moveSrc, { recursive: true });
  writeFileSync(join(moveSrc, "移动书 第01章.md"), "移动正文。\n", "utf8");
  const moveRes = await defs.novel_import.execute({ src: moveSrc, mode: "apply", move: true, root: testRoot }, exec);
  if (moveRes.imported.length !== 1 || readdirSync(moveSrc).length !== 0) throw new Error("move 模式未移除源文件: " + JSON.stringify(moveRes.imported));
  if (!existsSync(join(testRoot, "novels", "移动书", "移动书 第01章.md"))) throw new Error("move 模式未落盘");
  // 强制合并（book 参数把两个分组并入同一本，顺带覆盖同号改名）
  const mergeSrc = join(testRoot, "import-merge-src");
  mkdirSync(mergeSrc, { recursive: true });
  writeFileSync(join(mergeSrc, "甲书 第01章.md"), "甲正文。\n", "utf8");
  writeFileSync(join(mergeSrc, "乙书 第01章.md"), "乙正文。\n", "utf8");
  const mergeRes = await defs.novel_import.execute({ src: mergeSrc, mode: "apply", book: "合并书", root: testRoot }, exec);
  if (mergeRes.groups.length !== 1 || mergeRes.imported.length !== 2) throw new Error("book 强制合并失败: " + JSON.stringify(mergeRes.groups.map((g) => g.book)));
  if (mergeRes.imported.some((i) => i.book !== "合并书")) throw new Error("强制合并未全部归入 合并书");
  console.log("import apply: ✓ (copy 2 / move 1 / 强制合并 2)");
  // new_chapter 成功路径 + 章号归一拒绝
  const nc = await defs.novel_new_chapter.execute({ book: "导入书", content: "新章正文", root: testRoot }, exec);
  assertOutputContract(defs.novel_new_chapter, nc, "novel_new_chapter"); // v4.0.0：调用点补契约断言
  if (!nc.file || nc.number !== 2) throw new Error("new_chapter 失败: " + JSON.stringify(nc));
  let dupRejected = false;
  try { await defs.novel_new_chapter.execute({ book: "导入书", chapter: 2, root: testRoot }, exec); } catch (e) { dupRejected = String(e).includes("已存在"); }
  if (!dupRejected) throw new Error("new_chapter 同号未拒绝");
  console.log("new_chapter: ✓ (编号 2, 同号拒绝)");
  // semantic_search 成功路径
  const ss = await defs.novel_semantic_search.execute({ book: "导入书", query: "开篇内容", root: testRoot }, exec);
  assertOutputContract(defs.novel_semantic_search, ss, "novel_semantic_search"); // v4.0.0：调用点补契约断言
  if (ss.available !== true) throw new Error("semantic_search 不可用: " + ss.message);
  console.log("semantic_search: ✓ (" + ss.results.length + " 结果, " + ss.cache + ")");
  // config set 空对象清除 + 类型断言（宿主级）
  const cfgSet = await defs.novel_sentence_config.execute({ action: "set", styleTolerance: { complexity: { low: -10, high: 10 } }, root: testRoot }, exec);
  if (typeof cfgSet.styleTolerance !== "object" || cfgSet.styleTolerance === null) throw new Error("config set 容差类型错");
  const cfgClear = await defs.novel_sentence_config.execute({ action: "set", styleTolerance: {}, root: testRoot }, exec);
  if (typeof cfgClear.styleTolerance !== "object" || Object.keys(cfgClear.styleTolerance).length !== 0) throw new Error("config 清除应输出空对象");
  console.log("config set/清除: ✓ 类型断言过");
  rmSync(join(testRoot, "novels", "导入书"), { recursive: true, force: true });
}

// v3.9.0 ⑯：render 层断言——宿主只把 render() 文本给模型看，关键字段必须出现在文本里（防止 value 有、模型看不到的回归）
{
  const mk = (bn, fname, txt) => {
    mkdirSync(join(testRoot, "novels", bn), { recursive: true });
    writeFileSync(join(testRoot, "novels", bn, fname), txt, "utf8");
  };
  mk("渲染书", "第01章.md", "雨下了一整夜。她站在窗前，心里想着明天的事。窗外风急，她深吸一口气，又缓缓叹了出来。\n她低声问：\"你真的要走吗？\"他摇了摇头，没有说话。难道这就是结局？她不禁这样想。");
  mk("渲染书", "第02章.md", "日子照旧。她习惯了独自吃饭。窗外风急，雨打芭蕉。");
  const nc2 = await defs.novel_new_chapter.execute({ book: "渲染书", content: "正文。", root: testRoot }, exec);
  const ncText = defs.novel_new_chapter.output.render({}, nc2)[0].text;
  for (const key of ["风格基线", "风格锚", "句式骨架", "强制流程"]) {
    if (!ncText.includes(key)) throw new Error("new_chapter render 缺 " + key + " 字段");
  }
  console.log("render new_chapter: ✓ (基线/锚包/骨架/流程均在文本)");
  const sc2 = await defs.novel_style_check.execute({ book: "渲染书", chapter: "第01章", root: testRoot }, exec);
  const scText = defs.novel_style_check.output.render({}, sc2)[0].text;
  if (sc2.fixAnchors && sc2.fixAnchors.length > 0) {
    if (!scText.includes("对照修正")) throw new Error("style_check render 缺 fixAnchors 段落");
    if (!scText.includes(sc2.fixAnchors[0].text.slice(0, 8))) throw new Error("style_check render 缺锚段文本");
  }
  console.log("render style_check: ✓ (fixAnchors 在文本)");
  const sr2 = await defs.novel_style_report.execute({ book: "渲染书", root: testRoot }, exec);
  const srText = defs.novel_style_report.output.render({}, sr2)[0].text;
  if (Array.isArray(sr2.anchors) && sr2.anchors.length > 0) {
    if (!srText.includes("风格锚")) throw new Error("style_report render 缺锚段标题");
    if (!srText.includes(sr2.anchors[0].text.slice(0, 8))) throw new Error("style_report render 缺锚段文本");
  }
  if (Array.isArray(sr2.skeletons) && sr2.skeletons.length > 0) {
    if (!srText.includes("句式骨架")) throw new Error("style_report render 缺骨架标题");
  }
  console.log("render style_report: ✓ (anchors/skeletons 在文本)");
  // v3.9.0 复查 2：sentence_analysis render——情感量化/细节密度可见（动作链占比不再 ×100、语义标签用 top 字段）
  const sa = await defs.novel_sentence_analysis.execute({ book: "渲染书", root: testRoot, fresh: true }, exec);
  assertOutputContract(defs.novel_sentence_analysis, sa, "novel_sentence_analysis(render)"); // v4.0.0：调用点补契约断言
  const saText = defs.novel_sentence_analysis.output.render({}, sa)[0].text;
  // v4.0.0：旧断言只挡字面 "10000.0%"（"10000%"/"10000.00%" 都放过），且 render 文案一变整个 if 体被跳过=空断言。
  // 改为：先断言数值本身 ≤1，再强制要求 render 文本必须匹配到动作链占比数字（匹配不到即失败）。
  if (typeof sa.density?.actionChainRatio === "number" && sa.density.actionChainRatio > 1) {
    throw new Error("sentence_analysis density.actionChainRatio 超过 1（×100 回归）: " + sa.density.actionChainRatio);
  }
  if (saText.includes("10000")) throw new Error("sentence_analysis render 动作链占比仍 ×100");
  if (sa.emotion && sa.emotion.quantification && Object.keys(sa.emotion.quantification).length > 0) {
    if (!saText.includes("情感量化")) throw new Error("sentence_analysis render 缺情感量化");
    if (saText.includes("隐性情感句")) throw new Error("sentence_analysis render 仍有误导性的隐性情感句文案");
  }
  if (typeof sa.density?.actionChainRatio === "number") {
    const m = saText.match(/动作链[^0-9%]{0,6}([0-9.]+)%/);
    if (!m) throw new Error("sentence_analysis render 缺动作链占比数字（文案改动导致断言失效）");
    if (Number(m[1]) > 100) throw new Error("动作链占比仍超 100%: " + m[1]);
  }
  console.log("render sentence_analysis: ✓ (量化可见/占比不放大/文案干净)");
  rmSync(join(testRoot, "novels", "渲染书"), { recursive: true, force: true });
}

// v3.9.5 回归：H2/H1/L07/M03/M04/M11 修复验证
{
  // H2：novel_settings 参数 schema 必须声明 bannedWords/recommended（此前缺失导致 SKILL 流程走不通）
  const sp = defs.novel_settings.parameters.properties;
  if (!sp.bannedWords || !sp.recommended) throw new Error("novel_settings schema 缺 bannedWords/recommended（H2 未修）");
  console.log("v3.9.5 schema: bannedWords/recommended 已声明 ✓");
  // H1：功能关闭时输出仍满足 schema 顶层必填（totalChars 存在）且 render 无 undefined
  await defs.novel_sentence_config.execute({ action: "set", enabled: false }, exec);
  const saDisabled = await defs.novel_sentence_analysis.execute({ book: "测试" }, exec);
  assertOutputContract(defs.novel_sentence_analysis, saDisabled, "novel_sentence_analysis(disabled)"); // v4.0.0：调用点补契约断言
  if (saDisabled.enabled !== false || typeof saDisabled.totalChars !== "number") throw new Error("disabled 分支缺 totalChars（H1 未修）");
  const saDisabledText = defs.novel_sentence_analysis.output.render({}, saDisabled)[0].text;
  if (saDisabledText.includes("undefined")) throw new Error("disabled render 仍含 undefined");
  // v4.0.0：enabled=false 语义三方不一致（prompts.js 说"两个工具都会拒绝执行"，实现里 analysis 返回桩、style_check 抛错）。
  // 测试把两者实际行为都固定下来，差异留给 lib 侧统一——不再只测 analysis 一半。
  if (!String(saDisabled.message || "").includes("已关闭")) throw new Error("enabled=false 时 analysis 桩结果应提示已关闭: " + saDisabled.message);
  let styleCheckRejected = null;
  try { await defs.novel_style_check.execute({ book: "测试", chapter: "第02章", root: testRoot }, exec); } catch (e) { styleCheckRejected = String(e); }
  if (styleCheckRejected === null || !styleCheckRejected.includes("已关闭")) throw new Error("enabled=false 时 novel_style_check 应拒绝执行，实际: " + styleCheckRejected);
  await defs.novel_sentence_config.execute({ action: "set", enabled: true }, exec);
  console.log("v3.9.5 disabled 契约: analysis 返回桩(totalChars) / style_check 拒绝执行 ✓");
  // L07：brief 命中/未命中文案一致
  const bMiss = await defs.novel_sentence_analysis.execute({ book: "测试", brief: true, fresh: true }, exec);
  const bHit = await defs.novel_sentence_analysis.execute({ book: "测试", brief: true }, exec);
  if (bMiss.cache !== "miss" || bHit.cache !== "hit") throw new Error("brief 缓存路径异常: " + bMiss.cache + "/" + bHit.cache);
  if (bMiss.brief !== bHit.brief) throw new Error("brief 命中/未命中文案不一致（L07 未修）");
  console.log("v3.9.5 brief: miss === hit ✓");
  // M03/M04：候选 detail 不得含 undefined；自定义 bannedWords（欧式中世纪）与 speechStyle（欧式基准）互不遮蔽
  const ccFix = await defs.novel_continuity_check.execute({ book: "测试", root: testRoot }, exec);
  const badDetail = ccFix.candidates.find((x) => x.detail && x.detail.includes("undefined"));
  if (badDetail) throw new Error("候选 detail 含 undefined（M03/M04 未修）: " + badDetail.detail);
  if (ccFix.candidates.filter((x) => x.type.startsWith("语用")).length === 0) throw new Error("语用候选缺失（speechEntry 未生效）");
  console.log("v3.9.5 continuity: 无 undefined 候选且语用扫描生效 ✓ (" + ccFix.candidates.length + " 条)");
  // M11：scan 按 category 分派（地点消息不再是人物候选）
  // v4.0.0：旧断言只看 message 含"地点"（0 候选也算过）——造地点样本，断言候选内容与两个类别的消息标签。
  mkdirSync(join(testRoot, "novels", "扫描样本"), { recursive: true });
  writeFileSync(join(testRoot, "novels", "扫描样本", "第01章.md"), "她走进书房，翻了翻旧信。第二天她又回到书房，把信烧了。\n", "utf8");
  const scanLoc = await defs.novel_settings.execute({ book: "扫描样本", category: "location", action: "scan", root: testRoot }, exec);
  if (!String(scanLoc.message).includes("地点候选")) throw new Error("scan location 未按类别分派（M11 未修）: " + scanLoc.message);
  if (!scanLoc.candidates.some((c) => String(c).includes("书房"))) throw new Error("scan location 未提取到候选: " + JSON.stringify(scanLoc.candidates));
  const scanChar = await defs.novel_settings.execute({ book: "扫描样本", category: "character", action: "scan", root: testRoot }, exec);
  if (!String(scanChar.message).includes("人物候选")) throw new Error("scan character 标签错（应分派为人物候选）: " + scanChar.message);
  console.log("v3.9.5 scan 分派: " + scanLoc.message + " " + JSON.stringify(scanLoc.candidates) + " ✓");
}

// 清理缓存文件（保留状态文件）
rmSync(testRoot, { recursive: true, force: true });
// v4.0.0：告警即失败——插件运行期 console.warn 此前完全不被测试感知（e2e 全绿但 stderr 持续刷契约失配）
console.warn = originalWarn;
if (pluginWarnings.length > 0) throw new Error("插件运行期告警 " + pluginWarnings.length + " 条（v4.0.0 起视为失败）: " + pluginWarnings.join(" | "));
console.log("\nALL E2E TESTS PASSED");
