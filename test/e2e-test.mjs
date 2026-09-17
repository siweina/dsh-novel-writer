// v3.9.5 端到端测试：16 工具注册、缓存、伏笔、风格自检、路由、语用扫描（v0.6.0 起持续扩展）

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { apply } from "../lib/index.js";
import { ALL_TOOLS } from "../lib/core.js"; // v5.0.0：工具清单的单一事实源

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
// v5.0.0：工具数断言改为与 lib/core.js 的 ALL_TOOLS **单一事实源**对齐。
// 旧版硬编码 `names.length !== 16`：每加一个工具都要改测试，而且只能发现"少注册"，发现不了"多注册"。
// 现在双向比对：注册表与 ALL_TOOLS 必须完全一致（顺序无关）。
const expectedToolNames = [...ALL_TOOLS].sort();
const actualToolNames = [...names].sort();
if (JSON.stringify(actualToolNames) !== JSON.stringify(expectedToolNames)) {
  throw new Error("注册的工具与 ALL_TOOLS 不一致\n  实际: " + actualToolNames.join(", ") + "\n  期望: " + expectedToolNames.join(", "));
}

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
    novel_outline: { book: "测试", action: "read", file: "status", root: testRoot },
    // v5.0.0：写作能力层的两个新工具也纳入循环契约校验
    novel_chapter_brief: { book: "测试", chapter: "1", root: testRoot },
    novel_fix_plan: { book: "测试", chapter: "第01章", action: "plan", root: testRoot }
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

// ================= v4.3.1 回归：同章号多文件不再"静默读错稿" =================
// 现场背景：某工具把一章拆成两个文件后，两份共用章号 3。旧版 findChapter 先按章号匹配、
// 才退回文件名匹配，于是「第03章 重逢.md」这种完整文件名也会被 parseChapterNumber 解析出 3、
// 命中排序靠前的另一份；被抢走的那份用章号/文件名/标题三条路都读不到（永久不可达，已实测复现）。
await (async function duplicateChapterRegression() {
  const dupBook = join(testRoot, "novels", "重号样本");
  mkdirSync(dupBook, { recursive: true });
  writeFileSync(join(dupBook, "第03章 初遇.md"), "这是旧的第三章正文。\n", "utf8");
  writeFileSync(join(dupBook, "第03章 重逢.md"), "这是新拆分出来的第三章正文。\n", "utf8");
  writeFileSync(join(dupBook, "第3章 初遇.md"), "这是另一份同号同名文件的正文。\n", "utf8");

  // ① 章节列表必须显式提示——否则用户只看到两条同名条目，不知道磁盘上是两份文件
  const listed = await defs.novel_chapters.execute({ book: "重号样本", root: testRoot }, exec);
  const listText = defs.novel_chapters.output.render({}, listed)[0].text;
  if (!listText.includes("同章号多文件")) throw new Error("同章号未在 novel_chapters 提示: " + listText);

  // ② 精确文件名优先于章号（旧版此处命中另一份）
  const byFile = await defs.novel_read.execute({ book: "重号样本", chapter: "第03章 重逢.md", root: testRoot }, exec);
  if (!String(byFile.path).endsWith("第03章 重逢.md")) throw new Error("完整文件名未优先命中: " + byFile.path);
  // ③ 省略扩展名的文件名同样命中
  const byStem = await defs.novel_read.execute({ book: "重号样本", chapter: "第3章 初遇", root: testRoot }, exec);
  if (!String(byStem.path).endsWith("第3章 初遇.md")) throw new Error("省略扩展名的文件名未命中: " + byStem.path);
  // ④ 只给章号 → 必须拒绝并列出候选（旧版静默返回其中一份，另一份永久读不到）
  let ambiguous = null;
  try { await defs.novel_read.execute({ book: "重号样本", chapter: "3", root: testRoot }, exec); } catch (e) { ambiguous = String(e && e.message ? e.message : e); }
  if (ambiguous === null) throw new Error("同章号按章号读取应被拒绝，实际成功返回");
  for (const expect of ["第03章 初遇.md", "第03章 重逢.md", "第3章 初遇.md"]) {
    if (!ambiguous.includes(expect)) throw new Error("歧义报错未列出候选 " + expect + ": " + ambiguous);
  }
  // ⑤ 审计工具能查出同章号
  const audit = await defs.novel_continuity_check.execute({ book: "重号样本", root: testRoot }, exec);
  if (!audit.candidates.some((c) => c.type === "同章号多文件")) throw new Error("novel_continuity_check 未报同章号多文件");
  // ⑥ 无重号的书必须零误报、行为不变
  const cleanList = await defs.novel_chapters.execute({ book: "测试", root: testRoot }, exec);
  const cleanText = defs.novel_chapters.output.render({}, cleanList)[0].text;
  if (cleanText.includes("同章号多文件")) throw new Error("无重号书出现误报: " + cleanText);
  const cleanRead = await defs.novel_read.execute({ book: "测试", chapter: "1", root: testRoot }, exec);
  if (!String(cleanRead.path).endsWith("第01章.md")) throw new Error("无重号书按章号读取异常: " + cleanRead.path);
  console.log("v4.3.1 同章号回归: 列表提示 / 文件名优先 / 章号歧义拒绝 / 审计检出 / 无重号书零误报 ✓");
})();

// ============================================================================
// v5.0.0：写作能力层三件套的功能性断言（开写包 / 改稿台 / 结构视图）
// 夹具原则：本段全部自建独立书目，**不往 novels/测试/ 里加改任何文件**（那本书被上方大量既有断言依赖）；
// 三段各自独立、互不依赖执行顺序，书名的命名也刻意避开既有夹具书（测试/衔接样本/扫描样本/重号样本…）。
// ============================================================================

// v5.0.0：接线前置检查——两个新工具必须同时存在于注册表与 ALL_TOOLS 单一事实源（工具数不硬编码，沿用文件顶部对齐口径）；
// novel_plot 的参数 schema 必须已声明 graph（schema 与实际 action 分支脱节时，宿主会在调用前就拒收）。
await (async function v5WiringPreflight() {
  for (const toolName of ["novel_chapter_brief", "novel_fix_plan"]) {
    if (!defs[toolName]) throw new Error("v5.0.0 工具未在注册表中: " + toolName);
    if (!ALL_TOOLS.includes(toolName)) throw new Error("v5.0.0 工具未进 ALL_TOOLS 单一事实源: " + toolName);
    if (!names.includes(toolName)) throw new Error("v5.0.0 工具未出现在注册表名称列表: " + toolName);
  }
  const plotActions = defs.novel_plot?.parameters?.properties?.action?.enum ?? [];
  if (!plotActions.includes("graph")) throw new Error("novel_plot 参数 schema 未声明 graph action: " + plotActions.join(","));
  console.log("v5.0.0 接线: chapter_brief / fix_plan 与 ALL_TOOLS 一致；novel_plot action 已含 graph ✓");
})();

// ---------- v5.0.0 ①：开写包 novel_chapter_brief（主路径 / 两档预算 / 降级 / isNext） ----------
await (async function chapterBriefRegression() {
  const BOOK = "开写包样本";
  const writeChapter = (book, file, text) => {
    mkdirSync(join(testRoot, "novels", book), { recursive: true });
    writeFileSync(join(testRoot, "novels", book, file), text, "utf8");
  };
  // v5.0.0 夹具：3 章 + 多段正文 + 设定表（worldview 禁词 + 人物）+ 2 条 open 伏笔 + 创作资料（大纲/钩子/人物）。
  // 段长都要 ≥40 字（buildStyleAnchorPackage 的抽样门槛），对话段 ≤200 字才会被选为「对话」锚段；
  // 第 03 章写到 600 字以上，compact(300)/full(600) 两档的 anchor 截断长度才都可观测。
  const briefCh1 = [
    "“你真的要去码头？”老船工把缆绳在木桩上绕了两圈，眯着眼看她，“那地方夜里风大，去了也未必等得到人，趁早回吧。”",
    "",
    "“我等了三年。”她把袖口的水拧出来，声音很轻，“再等一夜也不算什么，反正家里也没有人在等我回去。”",
    "",
    "她心里明白，这一夜若是空手而归，往后就再也没有任何理由站在这条湿冷的栈桥上，继续等一个不会出现的人。",
    "",
    "栈桥上的水洼映着摇晃的灯影，风从海口方向一阵一阵地压过来，把远处桅杆上的铁环吹得叮当作响；岸边堆着几只废弃的鱼筐，筐底结着白色的盐霜，一只瘦猫从筐缝里钻出来，嗅了嗅，又钻了回去。",
    "",
    "雨停之后，云缝里漏下一点很淡的月光，正落在木桩之间那根断掉的缆绳上。她把缆绳捡起来绕好，放回原处，然后拢了拢衣领，慢慢往回走。",
    ""
  ].join("\n");
  const briefCh2 = [
    "第二天清晨，她把那本旧账册摊在桌上，一页一页地翻过去，找三年前的那一笔记录。",
    "",
    "账册的边角被虫子蛀了几个洞，凡是沾到水的地方都洇成了一片模糊的墨迹，只剩下零星几个还能认出来的字，她凑近了才看清那是个船号的尾数。",
    "",
    "她数了数剩下的铜钱，把它们分成三份，一份买米，一份付船钱，剩下的一份塞进贴身的布袋里。",
    "",
    "院子里的鸡叫了第三遍，隔壁的妇人开始在井边打水，木桶磕在石沿上，回声一阵一阵地荡过来，又慢慢地散开去，像什么都没有发生过。",
    ""
  ].join("\n");
  const briefCh3 = [
    "苏晚在码头等到了天快亮的时候，才看见那艘挂着灰帆的船慢慢靠了上来。",
    "",
    "船头站着一个披蓑衣的人，他没有说话，只是把手里的木匣递了下来，木匣上刻着一朵很浅的花，花瓣的边缘已经磨得看不出原来的形状。",
    "",
    "她接过木匣，指尖碰到匣面的时候，忽然想起父亲临走前说过的那句“别急着打开”，于是把手缩回去，抱在怀里没有动。",
    "",
    "潮水退下去以后，滩上留下一层浅浅的泥纹，远远看去像谁用手指在纸上划过的痕迹；她把伞靠在栏杆上，看着那条纹路一点一点被新一轮的浪抹平，然后转身往回走，脚底的沙在每一步里都发出细小的响声。",
    "",
    "天光一点点亮起来的时候，整条栈桥从灰蓝变成灰白，海面上浮着一层薄薄的雾气，远处的桅杆只剩下一根根竖着的黑影。偶尔有一只海鸟贴着水面掠过去，翅膀几乎碰到浪尖，然后又抬起来，消失在货栈后面那片低矮的屋脊之间；卖早点的摊子支起了棚布，白色的蒸汽从锅沿上冒出来，被风一吹就散进灰蒙蒙的天里，只剩下一股淡淡的咸腥味留在原地。",
    "",
    "她没有回头。船上的蓑衣人也没有再说话。两个人隔着一段不长不短的栈桥，各自站着，直到天完全亮透，货栈的门一扇一扇地被推开发出吱呀的响声。",
    "",
    "“船钱我给你留着。”她把布袋按在桌上，声音不高，“你只管把那匣子交到我手上，别问别的。”",
    "",
    "她在桥头站了很久，直到早起卖鱼的人推着独轮车从身边经过，轮子在石板上压出一串闷响，她才慢慢往巷子里走，衣角还在滴水。",
    "",
    "巷口的屋檐下挂着一盏没有点亮的灯笼，纸面上落了些灰，风一来，灯笼便贴着墙晃两下，发出很轻的响声，像是谁在远处应了一声，又像是谁把门轻轻地合上了。",
    ""
  ].join("\n");
  writeChapter(BOOK, "第01章.md", briefCh1);
  writeChapter(BOOK, "第02章.md", briefCh2);
  writeChapter(BOOK, "第03章.md", briefCh3);
  if (briefCh3.length <= 600) throw new Error("v5.0.0 夹具失效：第 03 章正文不足 600 字，两档 anchor 预算无法区分（实际 " + briefCh3.length + "）");
  // 设定表：worldview（禁词 + 替代词 + 仪式规范 + 语用）+ 人物卡
  await defs.novel_settings.execute({ book: BOOK, category: "worldview", action: "add", name: "海港基准", basis: "近海港口，帆船与铜钱", bannedWords: ["上香", "老夫"], recommended: { "上香": "点烛" }, ritual: "点烛不烧香", speechStyle: { tone: "口语化" }, root: testRoot }, exec);
  await defs.novel_settings.execute({ book: BOOK, category: "character", action: "add", name: "苏晚", description: "等船的年轻女子", traits: "沉默、执拗", root: testRoot }, exec);
  // 伏笔：2 条 open（一条 high、一条 medium），都要能判出 priority
  await defs.novel_plot.execute({ book: BOOK, action: "add", content: "灰帆船上的木匣", chapter: "第02章", priority: "high", type: "道具", root: testRoot }, exec);
  await defs.novel_plot.execute({ book: BOOK, action: "add", content: "父亲临走前的嘱托", chapter: "第03章", priority: "medium", type: "剧情", root: testRoot }, exec);
  // 创作资料：大纲方向行（下一章 4）+ 上一章（3）钩子 + 主要人物
  await defs.novel_outline.execute({ book: BOOK, action: "init", root: testRoot }, exec);
  await defs.novel_outline.execute({ book: BOOK, action: "chapter", number: 1, title: "码头等船", root: testRoot }, exec);
  await defs.novel_outline.execute({ book: BOOK, action: "chapter", number: 4, title: "苏晚打开木匣，看清里面的东西", root: testRoot }, exec);
  await defs.novel_outline.execute({ book: BOOK, action: "hook", number: 3, body: "她抱着木匣站在栈桥上，天亮了也没有打开。", root: testRoot }, exec);
  await defs.novel_outline.execute({ book: BOOK, action: "character", role: "main", name: "苏晚", description: "等船的年轻女子，沉默而执拗", root: testRoot }, exec);

  // ── 主路径（compact）──
  const compact = await defs.novel_chapter_brief.execute({ book: BOOK, chapter: "next", budget: "compact", root: testRoot }, exec);
  assertOutputContract(defs.novel_chapter_brief, compact, "novel_chapter_brief(compact)");
  // ① 约定字段齐全（schema.required + 夹具已登记材料的可选字段）
  for (const key of ["book", "isNext", "anchor", "previousHook", "outlineDirection", "characters", "openPlots", "anchors", "skeletons", "lastVerdict", "avoid", "plan", "degraded"]) {
    if (!(key in compact)) throw new Error("开写包缺约定字段: " + key);
  }
  if (!compact.worldview || !compact.baseline) throw new Error("夹具已登记世界观与 3 章正文，worldview/baseline 不应缺失");
  // ② 目标章 = 推导出的下一章（本书命名格式为「第NN章.md」→ 第 04 章）
  if (compact.chapter?.file !== "第04章.md" || compact.chapter?.number !== 4) throw new Error("下一章文件名推导错: " + JSON.stringify(compact.chapter));
  if (compact.isNext !== true) throw new Error("下一章（尚未创建）isNext 应为 true，实际 " + compact.isNext);
  // ③ anchor 非空且受 budget 截断（compact 300 字 / full 600 字）
  if (typeof compact.anchor !== "string" || compact.anchor.trim() === "") throw new Error("anchor 为空（上一章正文应给出承接口原文）");
  if (compact.anchor.length > 300) throw new Error("compact anchor 超预算：实际 " + compact.anchor.length + " > 300");
  // ④ 未回收伏笔：非空 + 每条有 priority（并按 优先级 → distance 降序）
  if (!Array.isArray(compact.openPlots) || compact.openPlots.length === 0) throw new Error("openPlots 为空（夹具已登记 2 条 open 伏笔）");
  const prioRank = { high: 0, medium: 1, low: 2 };
  for (const p of compact.openPlots) {
    if (typeof p.priority !== "string" || !(p.priority in prioRank)) throw new Error("openPlots 条目 priority 非法: " + JSON.stringify(p));
    if (typeof p.distance !== "number") throw new Error("openPlots 条目缺 distance: " + JSON.stringify(p));
  }
  for (let i = 1; i < compact.openPlots.length; i += 1) {
    const prevPlot = compact.openPlots[i - 1];
    const curPlot = compact.openPlots[i];
    if (prioRank[prevPlot.priority] > prioRank[curPlot.priority]) throw new Error("openPlots 未按优先级降序: " + prevPlot.priority + " → " + curPlot.priority);
    if (prioRank[prevPlot.priority] === prioRank[curPlot.priority] && prevPlot.distance < curPlot.distance) throw new Error("openPlots 同优先级未按 distance 降序: " + prevPlot.distance + " → " + curPlot.distance);
  }
  // ⑤ worldview.bannedWords 非空 → avoid 里必须有「禁词」类条目且逐词列出
  if (!Array.isArray(compact.worldview.bannedWords) || compact.worldview.bannedWords.length === 0) throw new Error("worldview.bannedWords 为空（夹具已登记 2 个禁词）");
  const bannedEntries = compact.avoid.filter((a) => a.kind === "禁词");
  if (bannedEntries.length === 0) throw new Error("worldview 有 bannedWords 时 avoid 必须出现「禁词」类条目: " + JSON.stringify(compact.avoid));
  for (const word of compact.worldview.bannedWords) {
    if (!bannedEntries.some((a) => String(a.detail).includes(word))) throw new Error("avoid 禁词条目缺词「" + word + "」: " + JSON.stringify(bannedEntries.map((a) => a.detail)));
  }
  // ⑥ plan.checklist 必须是**非空字符串数组**（宿主 render 直接逐条渲染，空串/非字符串会渲染出空行）
  if (!Array.isArray(compact.plan?.checklist) || compact.plan.checklist.length === 0) throw new Error("plan.checklist 不是非空数组: " + JSON.stringify(compact.plan));
  for (const step of compact.plan.checklist) {
    if (typeof step !== "string" || step.trim() === "") throw new Error("plan.checklist 含空/非字符串条目: " + JSON.stringify(step));
  }
  if (typeof compact.plan.previousState !== "string" || typeof compact.plan.goal !== "string") throw new Error("plan.previousState/goal 缺失");
  // ⑦ 两档预算：compact ≤ full，且 full 确实放开了截断（anchors/skeletons 条数与 anchor 长度）
  const full = await defs.novel_chapter_brief.execute({ book: BOOK, chapter: "next", budget: "full", root: testRoot }, exec);
  assertOutputContract(defs.novel_chapter_brief, full, "novel_chapter_brief(full)");
  if (full.anchor.length > 600) throw new Error("full anchor 超预算：实际 " + full.anchor.length + " > 600");
  if (!(compact.anchor.length < full.anchor.length)) throw new Error("compact/full 的 anchor 截断长度未体现预算差异: " + compact.anchor.length + " / " + full.anchor.length);
  if (!full.anchor.endsWith(compact.anchor)) throw new Error("full anchor 不是 compact anchor 的后缀（两档截断口径不一致）");
  if (compact.anchors.length > full.anchors.length) throw new Error("anchors 条数违反 compact ≤ full: " + compact.anchors.length + " > " + full.anchors.length);
  if (compact.skeletons.length > full.skeletons.length) throw new Error("skeletons 条数违反 compact ≤ full: " + compact.skeletons.length + " > " + full.skeletons.length);
  if (!(full.anchors.length > compact.anchors.length)) throw new Error("full 档没有放开锚段截断（compact/full 条数相同: " + compact.anchors.length + "）");
  // ⑧ 已存在的章：isNext 必须为 false
  const existing = await defs.novel_chapter_brief.execute({ book: BOOK, chapter: "1", root: testRoot }, exec);
  if (existing.isNext !== false) throw new Error("对已存在章调用时 isNext 应为 false，实际 " + existing.isNext);
  if (existing.chapter?.file !== "第01章.md") throw new Error("已存在章未按章号命中: " + JSON.stringify(existing.chapter));
  // ⑨ 人物卡：上一章出场 + 大纲方向 | 伏笔 distance | 上一章自检结论
  if (!Array.isArray(compact.characters) || compact.characters.length === 0) throw new Error("characters 为空（苏晚在第 03 章出场且出现在第 4 章方向行）");
  if (!compact.characters.some((c) => c.name === "苏晚" && c.mentions > 0 && (c.sources ?? []).includes("上一章出场"))) throw new Error("人物卡未按上一章正文计出场: " + JSON.stringify(compact.characters));
  if (typeof compact.lastVerdict !== "string" || !compact.lastVerdict.includes("六维对照")) throw new Error("lastVerdict 缺失（3 章正文应能现算上一章六维对照）: " + compact.lastVerdict);
  console.log("v5.0.0 开写包: 目标 " + compact.chapter.file + " | anchor " + compact.anchor.length + "/" + full.anchor.length + " 字 | 锚段 " + compact.anchors.length + "/" + full.anchors.length + " | 骨架 " + compact.skeletons.length + "/" + full.skeletons.length + " | 伏笔 " + compact.openPlots.length + " | 禁词条目 " + bannedEntries.length + " | 清单 " + compact.plan.checklist.length + " 步 ✓");

  // ── 降级：只有 1 章、无设定表、无伏笔、无创作资料 → 不抛错 + degraded 说明缺什么 ──
  const DEGRADED_BOOK = "开写降级";
  writeChapter(DEGRADED_BOOK, "第01章.md", "她一个人走进空荡荡的屋子，把门关上，坐在桌边没有开灯。\n");
  let degResult = null;
  try {
    degResult = await defs.novel_chapter_brief.execute({ book: DEGRADED_BOOK, chapter: "next", root: testRoot }, exec);
  } catch (e) {
    throw new Error("材料全缺时开写包不应抛错，实际抛出: " + String(e?.message ?? e));
  }
  assertOutputContract(defs.novel_chapter_brief, degResult, "novel_chapter_brief(degraded)");
  if (!Array.isArray(degResult.degraded) || degResult.degraded.length === 0) throw new Error("降级书返回了空 degraded（材料缺失必须显式说明）");
  if (degResult.characters.length !== 0 || degResult.openPlots.length !== 0) throw new Error("降级书 characters/openPlots 应为空数组: " + JSON.stringify({ characters: degResult.characters.length, openPlots: degResult.openPlots.length }));
  if (degResult.anchor !== "" && degResult.anchor === undefined) throw new Error("降级 anchor 应为空字符串");
  for (const missing of ["设定表", "伏笔"]) {
    if (!degResult.degraded.some((d) => String(d).includes(missing))) throw new Error("degraded 未说明缺少「" + missing + "」: " + JSON.stringify(degResult.degraded));
  }
  console.log("v5.0.0 开写包降级: 不抛错 | characters/openPlots 空数组 | degraded " + degResult.degraded.length + " 条（含 设定表/伏笔/创作资料 缺失说明）✓");
})();

// ---------- v5.0.0 ②：改稿台 novel_fix_plan（plan / verify / mark / 落盘 / 不当误报） ----------
await (async function fixPlanRegression() {
  const BOOK = "改稿台样本";
  const writeChapter = (book, file, text) => {
    mkdirSync(join(testRoot, "novels", book), { recursive: true });
    writeFileSync(join(testRoot, "novels", book, file), text, "utf8");
  };
  // v5.0.0 夹具：第 01 章正常（必须零误报），第 02 章刻意写坏——抽象词（感情/意义/状态）+ 世界观禁词（老夫）
  // + 仪式/客套违例（上一柱香、提点、承蒙）+ 大量省略号 + 情感直给（非常痛苦/极其悲伤/十分难过/格外孤独）。
  // 全书只有 2 章：改稿台的指标类检查需要「除本章外 ≥2 章基线」，此处按设计跳过（见 summary 备注），
  // 因此本段覆盖的是「禁用词 / 语用不符 / 衔接缺失 / 情感过直」四类确定性判定，不含指标类。
  const normalCh1 = "雨停之后，她沿着河堤慢慢往回走。岸边的芦苇被风吹得伏下去，又立起来。她把伞收好，抖了抖水，抬头看了看天色。远处有人在收摊，木轮碾过石板，声音很轻。回到院子里，她先把湿鞋放在台阶上，再进屋点了灯。\n";
  const brokenCh2 = [
    "她站在堂前，心里非常痛苦，也极其悲伤，那种感情与意义纠缠在一起，说不清是什么状态。",
    "",
    "老夫给她上一柱香，又添了茶，嘴里说着提点的话，承蒙她多年照拂这个家。",
    "",
    "她望着窗外……夜色很沉……她不知道该怎么办……也许一切都结束了……她十分难过，也格外孤独，忽然觉得这一切毫无意义。",
    ""
  ].join("\n");
  writeChapter(BOOK, "第01章.md", normalCh1);
  writeChapter(BOOK, "第02章.md", brokenCh2);
  await defs.novel_settings.execute({ book: BOOK, category: "worldview", action: "add", name: "改稿台基准", basis: "中式旧宅", bannedWords: ["上香", "老夫"], recommended: { "上香": "点烛" }, speechStyle: { honorBad: ["提点", "承蒙"], honorGood: { "提点": "提醒" }, ritualBadPatterns: ["上[一二三四五六七八九十百千]*柱?香"], ritualGoodNote: "点烛", tone: "口语化" }, root: testRoot }, exec);
  // 钩子记录：上一章钩子（铁匠铺/绿灯/风）与第 02 章开头字符几乎不重合 → 产出一条**无法精确到行**的 0/0 定位项，
  // 用来真实覆盖「全章层面」分支（否则该分支在本段里是空断言）。
  await defs.novel_outline.execute({ book: BOOK, action: "init", root: testRoot }, exec);
  await defs.novel_outline.execute({ book: BOOK, action: "hook", number: 1, body: "铁匠铺门口挂着一盏绿灯，风一吹就晃。", root: testRoot }, exec);

  // ── 硬要求：正常章零误报 ──
  const clean = await defs.novel_fix_plan.execute({ book: BOOK, chapter: "第01章", action: "plan", root: testRoot }, exec);
  assertOutputContract(defs.novel_fix_plan, clean, "novel_fix_plan(plan,正常章)");
  if (clean.items.length !== 0) throw new Error("正常章被误报 " + clean.items.length + " 项: " + clean.items.map((it) => it.type + "@" + it.locate.lineStart).join(","));
  console.log("v5.0.0 改稿台误报检查: 正常章 0 项待办 ✓");

  // ── plan：条数 / 类型数 / 9 字段 / 排序 ──
  const planRes = await defs.novel_fix_plan.execute({ book: BOOK, chapter: "第02章", action: "plan", root: testRoot }, exec);
  assertOutputContract(defs.novel_fix_plan, planRes, "novel_fix_plan(plan)");
  if (planRes.action !== "plan") throw new Error("plan 返回的 action 错: " + planRes.action);
  const items = planRes.items;
  if (items.length < 3) throw new Error("写坏的章待办不足 3 条: " + items.length);
  const typeSet = [...new Set(items.map((it) => it.type))];
  if (typeSet.length < 3) throw new Error("改稿台 type 种类不足 3 种: " + typeSet.join(","));
  for (const it of items) {
    for (const key of ["id", "type", "locate", "current", "target", "anchor", "severity", "effort", "hint"]) {
      if (!(key in it)) throw new Error("改稿项缺约定字段「" + key + "」: " + JSON.stringify(it).slice(0, 160));
    }
    if (typeof it.id !== "string" || it.id === "") throw new Error("改稿项 id 非法: " + JSON.stringify(it.id));
    if (typeof it.type !== "string" || it.type === "") throw new Error("改稿项 type 非法: " + JSON.stringify(it.type));
    if (!it.locate || typeof it.locate !== "object") throw new Error("改稿项 locate 非法: " + JSON.stringify(it.locate));
    for (const key of ["lineStart", "lineEnd", "excerpt"]) {
      if (!(key in it.locate)) throw new Error("改稿项 locate 缺字段「" + key + "」: " + JSON.stringify(it.locate));
    }
    if (!Number.isFinite(it.severity) || it.severity < 1 || it.severity > 5) throw new Error("改稿项 severity 越界: " + it.severity);
    if (!Number.isFinite(it.effort) || it.effort < 1 || it.effort > 3) throw new Error("改稿项 effort 越界: " + it.effort);
    if (typeof it.hint !== "string" || it.hint.trim() === "") throw new Error("改稿项 hint 为空: " + it.id);
  }
  // 排序：severity 降序 → effort 升序 → lineStart 升序（逐对校验，与 sortItems 的比较键一一对应）
  for (let i = 1; i < items.length; i += 1) {
    const prevItem = items[i - 1];
    const curItem = items[i];
    if (prevItem.severity < curItem.severity) throw new Error("排序错（severity 未降序）: " + prevItem.id + " " + prevItem.severity + " → " + curItem.id + " " + curItem.severity);
    if (prevItem.severity === curItem.severity && prevItem.effort > curItem.effort) throw new Error("排序错（同严重度下 effort 未升序）: " + prevItem.id + " " + prevItem.effort + " → " + curItem.id + " " + curItem.effort);
    if (prevItem.severity === curItem.severity && prevItem.effort === curItem.effort && prevItem.locate.lineStart > curItem.locate.lineStart) throw new Error("排序错（同严重度/难度下 lineStart 未升序）: " + prevItem.id + " " + prevItem.locate.lineStart + " → " + curItem.id + " " + curItem.locate.lineStart);
  }
  // locate：0/0 = 全章层面（hint 必须说明不可精确到行）；否则两端都落在真实行内，绝不允许 lineStart > lineEnd
  const ch2Lines = readFileSync(join(testRoot, "novels", BOOK, "第02章.md"), "utf8").split(/\r?\n/).length;
  const wholeChapterHintRe = /全章层面|跨章层面|整体衔接|没有可精确定位的行/; // v5.0.0：三类实现（指标全章/伏笔跨章/衔接整体）各自的措辞
  let zeroLocate = 0;
  for (const it of items) {
    const ls = it.locate.lineStart;
    const le = it.locate.lineEnd;
    if (ls > le) throw new Error("locate 区间反向（lineStart > lineEnd）: " + ls + " > " + le + " (" + it.id + ")");
    if (ls === 0 && le === 0) {
      zeroLocate += 1;
      if (!wholeChapterHintRe.test(it.hint)) throw new Error("0/0 定位项的 hint 未说明是全章层面: " + it.id + " | " + it.hint);
      if (String(it.locate.excerpt) !== "") throw new Error("0/0 定位项不应带 excerpt: " + it.id + " | " + it.locate.excerpt);
    } else {
      if (!(ls >= 1 && le >= 1)) throw new Error("locate 只有一个端点 > 0: " + ls + "/" + le + " (" + it.id + ")");
      if (le > ch2Lines) throw new Error("locate 超出真实行数（本章共 " + ch2Lines + " 行）: " + ls + "-" + le + " (" + it.id + ")");
      if (String(it.locate.excerpt).trim() === "") throw new Error("落在真实行上的项 excerpt 为空: " + it.id);
    }
  }
  console.log("v5.0.0 改稿台 plan: " + items.length + " 项（" + typeSet.join("/") + "）| 严重度 " + items.map((it) => it.severity).join(",") + " | 0/0 全章层面项 " + zeroLocate + " 条 ✓");

  // ── mark → verify ──
  const targetItem = items[0];
  const marked = await defs.novel_fix_plan.execute({ book: BOOK, chapter: "第02章", action: "mark", itemId: targetItem.id, state: "done", root: testRoot }, exec);
  assertOutputContract(defs.novel_fix_plan, marked, "novel_fix_plan(mark)");
  if (marked.ok !== true) throw new Error("mark 未返回 ok:true: " + JSON.stringify(marked.ok));
  if (marked.item?.id !== targetItem.id || marked.item?.state !== "done") throw new Error("mark 未写回目标项状态: " + JSON.stringify(marked.item));
  const verified = await defs.novel_fix_plan.execute({ book: BOOK, chapter: "第02章", action: "verify", root: testRoot }, exec);
  assertOutputContract(defs.novel_fix_plan, verified, "novel_fix_plan(verify)");
  const checkedItem = verified.checked.find((c) => c.id === targetItem.id);
  if (!checkedItem) throw new Error("verify 未回报已落盘清单里的项 " + targetItem.id);
  if (checkedItem.status === "new") throw new Error("已落盘清单项被 verify 判成 new（清单匹配失效）: " + JSON.stringify(checkedItem));
  if (!["resolved", "pending"].includes(checkedItem.status)) throw new Error("verify 状态超出约定三态: " + checkedItem.status);
  if (typeof verified.summary !== "string" || !verified.summary.includes("复测结果")) throw new Error("verify summary 缺失: " + verified.summary);
  // ── 非法入参必须抛错（而不是静默当 skip / 静默成功）──
  let badStateError = null;
  try { await defs.novel_fix_plan.execute({ book: BOOK, chapter: "第02章", action: "mark", itemId: targetItem.id, state: "bogus", root: testRoot }, exec); } catch (e) { badStateError = String(e?.message ?? e); }
  if (badStateError === null) throw new Error("mark 传非法 state 应抛错，实际成功返回");
  if (!badStateError.includes("state")) throw new Error("非法 state 的报错未点明 state 参数: " + badStateError);
  let noIdError = null;
  try { await defs.novel_fix_plan.execute({ book: BOOK, chapter: "第02章", action: "mark", state: "done", root: testRoot }, exec); } catch (e) { noIdError = String(e?.message ?? e); }
  if (noIdError === null) throw new Error("mark 缺 itemId 应抛错，实际成功返回");
  if (!noIdError.includes("itemId")) throw new Error("缺 itemId 的报错未点明 itemId 参数: " + noIdError);
  // ── 落盘：audits/fix-plan-*.json 必须存在，且 mark 的状态写回了文件 ──
  const auditsDir = join(testRoot, ".novel-writer", "audits");
  if (!existsSync(auditsDir)) throw new Error("改稿台未落盘 audits 目录: " + auditsDir);
  const auditFiles = readdirSync(auditsDir).filter((f) => /^fix-plan-.*\.json$/.test(f));
  if (auditFiles.length === 0) throw new Error("audits 下没有 fix-plan-*.json: " + JSON.stringify(readdirSync(auditsDir)));
  if (!auditFiles.some((f) => f.includes(BOOK))) throw new Error("落盘的 fix-plan 文件名未包含书名: " + auditFiles.join(","));
  if (!existsSync(planRes.planFile)) throw new Error("plan 返回的 planFile 不存在: " + planRes.planFile);
  const savedPlan = JSON.parse(readFileSync(planRes.planFile, "utf8"));
  if (!Array.isArray(savedPlan.items) || savedPlan.items.length !== items.length) throw new Error("落盘清单条数与返回值不一致: " + (savedPlan.items || []).length + " vs " + items.length);
  const savedMarked = savedPlan.items.find((it) => it.id === targetItem.id);
  if (savedMarked?.state !== "done") throw new Error("mark 的人工状态未写回清单文件: " + JSON.stringify(savedMarked?.state));
  console.log("v5.0.0 改稿台 mark/verify: ok=true → " + checkedItem.status + " | 非法 state/缺 itemId 均抛错 | 落盘 " + auditFiles.length + " 个清单文件（人工状态已写回）✓");
})();

// ---------- v5.0.0 ②-b：改稿台的「指标类」分支（句式偏离/抽象度过高/留白异常） ----------
// 为什么需要单独一本 3 章书：指标类判定要求「除本章外 ≥2 章」的基线（MIN_BASELINE_CHAPTERS=2，
// 单章基线无法估计作者自身波动，整类被跳过），所以 2 章的「改稿台样本」按设计覆盖不到这一分支。
// 这本 3 章书只用来覆盖指标类分支：第 01/03 章是正常行文（第 03 章刻意换一种「的」密度，让基线有波动），
// 第 02 章沿用上面那段写坏的正文。
await (async function fixPlanMetricBranch() {
  const BOOK = "改稿台指标样本";
  const writeChapter = (book, file, text) => {
    mkdirSync(join(testRoot, "novels", book), { recursive: true });
    writeFileSync(join(testRoot, "novels", book, file), text, "utf8");
  };
  const normalA = "雨停之后，她沿着河堤慢慢往回走。岸边的芦苇被风吹得伏下去，又立起来。她把伞收好，抖了抖水，抬头看了看天色。远处有人在收摊，木轮碾过石板，声音很轻。回到院子里，她先把湿鞋放在台阶上，再进屋点了灯。\n";
  const normalB = "天刚亮，她提着水桶去井边打水。绳子勒进掌心，她换了一只手。井口的石沿上结着一层青苔，滑得很。她把桶拉上来，水面晃了晃，映出屋檐的一角。回屋以后，她把这桶水倒进缸里，又拿了抹布开始擦桌子。\n";
  const brokenB = [
    "她站在堂前，心里非常痛苦，也极其悲伤，那种感情与意义纠缠在一起，说不清是什么状态。",
    "",
    "老夫给她上一柱香，又添了茶，嘴里说着提点的话，承蒙她多年照拂这个家。",
    "",
    "她望着窗外……夜色很沉……她不知道该怎么办……也许一切都结束了……她十分难过，也格外孤独，忽然觉得这一切毫无意义。",
    ""
  ].join("\n");
  writeChapter(BOOK, "第01章.md", normalA);
  writeChapter(BOOK, "第02章.md", brokenB);
  writeChapter(BOOK, "第03章.md", normalB);
  await defs.novel_settings.execute({ book: BOOK, category: "worldview", action: "add", name: "改稿台基准", basis: "中式旧宅", bannedWords: ["上香", "老夫"], recommended: { "上香": "点烛" }, speechStyle: { honorBad: ["提点", "承蒙"], honorGood: { "提点": "提醒" }, ritualBadPatterns: ["上[一二三四五六七八九十百千]*柱?香"], ritualGoodNote: "点烛", tone: "口语化" }, root: testRoot }, exec);

  const metricPlan = await defs.novel_fix_plan.execute({ book: BOOK, chapter: "第02章", action: "plan", root: testRoot }, exec);
  assertOutputContract(defs.novel_fix_plan, metricPlan, "novel_fix_plan(plan,3章指标)");
  const METRIC_TYPES = ["句式偏离", "抽象度过高", "留白异常"];
  const TYPE_WHITELIST = [...METRIC_TYPES, "禁用词", "语用不符", "衔接缺失", "伏笔未回收", "情感过直"];
  for (const it of metricPlan.items) {
    if (!TYPE_WHITELIST.includes(it.type)) throw new Error("改稿台产出未约定的 type: " + it.type);
  }
  const metricItems = metricPlan.items.filter((it) => METRIC_TYPES.includes(it.type));
  if (metricItems.length === 0) throw new Error("3 章基线下未触发任何指标类待办（collectMetricItems 分支零覆盖）: " + JSON.stringify(metricPlan.items.map((it) => it.type)));
  const ch2LineCount = readFileSync(join(testRoot, "novels", BOOK, "第02章.md"), "utf8").split(/\r?\n/).length;
  for (const it of metricPlan.items) {
    for (const key of ["id", "type", "locate", "current", "target", "anchor", "severity", "effort", "hint"]) {
      if (!(key in it)) throw new Error("指标类章节的待办缺字段「" + key + "」: " + JSON.stringify(it).slice(0, 160));
    }
    if (it.locate.lineStart > it.locate.lineEnd) throw new Error("locate 反向: " + JSON.stringify(it.locate));
    if (it.locate.lineEnd > ch2LineCount) throw new Error("locate 超出真实行数 " + ch2LineCount + ": " + JSON.stringify(it.locate));
  }
  for (let i = 1; i < metricPlan.items.length; i += 1) {
    const prevItem = metricPlan.items[i - 1];
    const curItem = metricPlan.items[i];
    if (prevItem.severity < curItem.severity) throw new Error("指标类章节排序错（severity 未降序）: " + prevItem.id + " → " + curItem.id);
    if (prevItem.severity === curItem.severity && prevItem.effort > curItem.effort) throw new Error("指标类章节排序错（effort 未升序）: " + prevItem.id + " → " + curItem.id);
    if (prevItem.severity === curItem.severity && prevItem.effort === curItem.effort && prevItem.locate.lineStart > curItem.locate.lineStart) throw new Error("指标类章节排序错（lineStart 未升序）: " + prevItem.id + " → " + curItem.id);
  }
  // 指标类问题必须能落到具体段落（段落归因），并带上可对照的原著锚段
  if (!metricItems.some((it) => it.locate.lineStart > 0)) throw new Error("指标类项全部没有段落级落点（段落归因失效）: " + JSON.stringify(metricItems.map((it) => it.locate)));
  if (!metricItems.some((it) => String(it.anchor).trim() !== "")) throw new Error("指标类项未带可参照的原著锚段 anchor: " + JSON.stringify(metricItems.map((it) => it.anchor)));
  // 硬要求：正常章零误报（3 章基线同样不得误报）
  const cleanThree = await defs.novel_fix_plan.execute({ book: BOOK, chapter: "第01章", action: "plan", root: testRoot }, exec);
  if (cleanThree.items.length !== 0) throw new Error("3 章基线下的正常章被误报 " + cleanThree.items.length + " 项: " + cleanThree.items.map((it) => it.type + "@" + it.locate.lineStart).join(","));
  const metricTypeSet = [...new Set(metricItems.map((it) => it.type))];
  console.log("v5.0.0 改稿台指标类分支: 3 章基线 → 待办 " + metricPlan.items.length + " 项（指标类 " + metricItems.length + " 条: " + metricTypeSet.join("/") + "，severity " + metricItems.map((it) => it.severity).join(",") + "）| 正常章仍 0 项 ✓");
})();

// ---------- v5.0.0 ③：结构视图 novel_plot{action:"graph"}（伏笔跨度 / 人物缺席 / 降级 / list 不受影响） ----------
await (async function storyGraphRegression() {
  const BOOK = "结构视图样本";
  const writeChapter = (book, file, text) => {
    mkdirSync(join(testRoot, "novels", book), { recursive: true });
    writeFileSync(join(testRoot, "novels", book, file), text, "utf8");
  };
  // v5.0.0 夹具：8 章。林昭 第 1~3 章出场、第 4 章起完全消失；沈砚 第 5 章才首次出场（用来验证「出场前的章不算缺席」）。
  // 伏笔：2 条 open（A 第 1 章埋下、B 第 3 章登记）+ 1 条 done（不得进 plotLifecycle）。
  const graphTexts = [
    "林昭在码头等了一整夜。她捡起那枚琥珀色齿轮怀表，金属外壳冰凉，指针停在三点。",
    "林昭回到旧宅，把怀表放在桌上。沈家的人在门外来回踱步，她没有开门。",
    "林昭终于打开父亲留下的木箱，里面只有一张泛黄的海图。",
    "海风把帆吹得鼓起，船队向着雾里驶去。甲板上的人各自沉默。",
    "沈砚站在船头，手里握着那卷海图。他问船长还有几天靠岸。",
    "沈砚在舱里写完了那封信，又把它撕碎。",
    "雾散了，远处出现一座礁岛。沈砚让人放慢船速。",
    "沈砚最后一个走下船，脚印很快被潮水抹平。"
  ];
  graphTexts.forEach((text, i) => writeChapter(BOOK, "第" + String(i + 1).padStart(2, "0") + "章.md", text + "\n"));
  await defs.novel_settings.execute({ book: BOOK, category: "character", action: "add", name: "林昭", description: "守码头的人", root: testRoot }, exec);
  await defs.novel_settings.execute({ book: BOOK, category: "character", action: "add", name: "沈砚", description: "随船出海的人", root: testRoot }, exec);
  // A：正文里真的提到（关键词命中路径）→ firstChapter=1；B：只靠登记的 chapter 字段 → firstChapter=3
  const addA = await defs.novel_plot.execute({ book: BOOK, action: "add", content: "琥珀色齿轮怀表的来历", chapter: "第01章", priority: "high", type: "道具", root: testRoot }, exec);
  const addB = await defs.novel_plot.execute({ book: BOOK, action: "add", content: "沉船底的青铜罗盘", chapter: "第03章", priority: "medium", type: "道具", root: testRoot }, exec);
  const addC = await defs.novel_plot.execute({ book: BOOK, action: "add", content: "断剑上的铭文", chapter: "第02章", type: "剧情", root: testRoot }, exec);
  const idA = addA.entries[0].id;
  const idB = addB.entries[0].id;
  const idC = addC.entries[0].id;
  await defs.novel_plot.execute({ book: BOOK, action: "done", id: idC, root: testRoot }, exec);

  // v5.0.0 P1 回归：时间线里「章号解析不出来」的条目（只有 day/event）必须**省略 number 键**而不是写 null。
  // 写 null 会被调用方的 dropNullDeep 删掉，若 schema 又把 number 列为 required，整个 graph 响应就会违反
  // 宿主契约（宿主 schema 不支持 type 数组，无法声明 ["number","null"]）。这里同时验证 required 键齐全。
  await defs.novel_settings.execute({ book: BOOK, category: "timeline", action: "add", day: "第1天", event: "抵达码头", chapter: "第02章", root: testRoot }, exec);
  await defs.novel_settings.execute({ book: BOOK, category: "timeline", action: "add", day: "第3天", event: "出海那天", chapter: "出海的当天", root: testRoot }, exec);
  await defs.novel_settings.execute({ book: BOOK, category: "timeline", action: "add", day: "第2天", event: "回想旧事", chapter: "第01章", root: testRoot }, exec);

  const graph = await defs.novel_plot.execute({ book: BOOK, action: "graph", root: testRoot }, exec);
  assertOutputContract(defs.novel_plot, graph, "novel_plot(graph)");
  if (graph.action !== "graph" || graph.book !== BOOK) throw new Error("graph 返回的 action/book 错: " + JSON.stringify({ action: graph.action, book: graph.book }));
  // graph 分支要靠空 entries 满足共享 schema 的 required（不能为了一个 action 放松契约）
  if (!Array.isArray(graph.entries) || graph.entries.length !== 0) throw new Error("graph 分支未返回空 entries（共享 required 会被违反）: " + JSON.stringify(graph.entries));
  if (graph.totalChapters !== 8) throw new Error("totalChapters 错: " + graph.totalChapters);
  // plotLifecycle：只含 open 的两条；distance = 最大章号 − 最早提及章号
  if (!Array.isArray(graph.plotLifecycle) || graph.plotLifecycle.length !== 2) throw new Error("plotLifecycle 应只含 2 条 open 伏笔: " + JSON.stringify(graph.plotLifecycle));
  const lifeA = graph.plotLifecycle.find((p) => p.id === idA);
  const lifeB = graph.plotLifecycle.find((p) => p.id === idB);
  if (!lifeA || !lifeB) throw new Error("plotLifecycle 缺登记的 open 伏笔: " + JSON.stringify(graph.plotLifecycle.map((p) => p.id)));
  if (lifeA.firstChapter !== 1 || lifeA.distance !== 7) throw new Error("伏笔 A 埋设章/跨度错（应为 第1章/7）: " + JSON.stringify(lifeA));
  if (lifeB.firstChapter !== 3 || lifeB.distance !== 5) throw new Error("伏笔 B 埋设章/跨度错（应为 第3章/5）: " + JSON.stringify(lifeB));
  for (const p of graph.plotLifecycle) {
    if (p.status !== "open") throw new Error("plotLifecycle 混入非 open 条目: " + JSON.stringify(p));
    if (p.distance !== graph.totalChapters - p.firstChapter) throw new Error("distance ≠ 最大章号 − 最早提及章号: " + JSON.stringify(p));
  }
  if (graph.plotLifecycle.some((p) => p.id === idC)) throw new Error("已回收（done）伏笔混进 plotLifecycle");
  if (typeof graph.summary !== "string" || !graph.summary.includes("已回收 1 条")) throw new Error("summary 未披露已回收条数: " + graph.summary);
  // characterMatrix：抓到消失的人物，且出场前的章不算缺席
  const rows = graph.characterMatrix?.rows ?? [];
  const absences = graph.characterMatrix?.absences ?? [];
  if (rows.length !== 8) throw new Error("人物矩阵行数应等于章数: " + rows.length);
  if (!rows[0].present.includes("林昭") || rows[0].present.includes("沈砚")) throw new Error("第 1 章出场判定错: " + JSON.stringify(rows[0]));
  if (!rows[4].present.includes("沈砚")) throw new Error("第 5 章出场判定错: " + JSON.stringify(rows[4]));
  const absentHero = absences.find((a) => a.name === "林昭");
  if (!absentHero) throw new Error("未抓到第 4 章起消失的人物「林昭」: " + JSON.stringify(absences));
  if (absentHero.from !== 4 || absentHero.to !== 8 || absentHero.length !== 5) throw new Error("林昭 缺席区间错（应为 4–8 / 5 章）: " + JSON.stringify(absentHero));
  if (absences.some((a) => a.name === "沈砚")) throw new Error("出场前的章被算成缺席（沈砚 第 5 章才首现）: " + JSON.stringify(absences));
  const firstPresentChapter = (name) => (rows.find((r) => r.present.includes(name)) || {}).number;
  for (const a of absences) {
    const first = firstPresentChapter(a.name);
    if (typeof first !== "number") throw new Error("缺席项对应人物在正文里从未出场: " + JSON.stringify(a));
    if (a.from <= first) throw new Error("缺席区间起点 " + a.from + " 不晚于首次出场章 " + first + "（出场前的章被算成缺席）: " + a.name);
    if (a.to - a.from + 1 !== a.length) throw new Error("缺席长度与区间不一致: " + JSON.stringify(a));
  }
  // v5.0.0：缺席/风险是"数据说了什么"，写在 summary 的【风险】段里（degraded 只报"少了什么数据"）
  if (!graph.summary.includes("林昭") || !/4[–-]8/.test(graph.summary)) throw new Error("summary 未提示最长缺席区间: " + graph.summary);
  for (const key of ["threadActivity", "timelineOrder", "planVsActual"]) {
    if (!Array.isArray(graph[key])) throw new Error("graph." + key + " 应为数组: " + typeof graph[key]);
  }
  // 时间线：number 可省略（解析不出章号），但 day/event/chapter/issue 四个键恒在
  const tl = graph.timelineOrder;
  if (tl.length !== 3) throw new Error("timelineOrder 应有 3 行: " + JSON.stringify(tl));
  for (const row of tl) {
    for (const k of ["day", "event", "chapter", "issue"]) {
      if (!(k in row)) throw new Error("timelineOrder 行缺 " + k + " 键（required 必须恒在）: " + JSON.stringify(row));
    }
  }
  if (tl[0].number !== 2 || tl[0].issue !== "") throw new Error("时间线第 1 行（第02章）错: " + JSON.stringify(tl[0]));
  if ("number" in tl[1]) throw new Error("章号解析不出的时间线条目必须**省略** number 键（写 null 会被 dropNullDeep 删键、与 schema required 冲突）: " + JSON.stringify(tl[1]));
  if (tl[1].issue !== "") throw new Error("无法解析章号的行不应被判为顺序不一致: " + JSON.stringify(tl[1]));
  if (tl[2].number !== 1 || tl[2].issue === "") throw new Error("章号回退（第02章 → 第01章）应报顺序不一致: " + JSON.stringify(tl[2]));
  console.log("v5.0.0 结构视图: " + graph.totalChapters + " 章 | 未回收 " + graph.plotLifecycle.length + " 条（distance " + graph.plotLifecycle.map((p) => p.distance).join(",") + "）| 缺席 " + JSON.stringify(absentHero) + " | 出场前不计缺席 | 时间线 " + tl.length + " 行（无章号行省略 number ✓）✓");

  // ── 只有 done 伏笔（或没有伏笔）时：不抛错 + plotLifecycle 为空数组 ──
  const DONLY_BOOK = "结构降级样本";
  writeChapter(DONLY_BOOK, "第01章.md", "她把窗推开，风灌进来。\n");
  writeChapter(DONLY_BOOK, "第02章.md", "天亮以前，她收拾好了行李。\n");
  const addDone = await defs.novel_plot.execute({ book: DONLY_BOOK, action: "add", content: "旧钥匙", chapter: "第01章", root: testRoot }, exec);
  await defs.novel_plot.execute({ book: DONLY_BOOK, action: "done", id: addDone.entries[0].id, root: testRoot }, exec);
  const doneGraph = await defs.novel_plot.execute({ book: DONLY_BOOK, action: "graph", root: testRoot }, exec);
  if (!Array.isArray(doneGraph.plotLifecycle) || doneGraph.plotLifecycle.length !== 0) throw new Error("只有 done 伏笔时 plotLifecycle 应为空数组: " + JSON.stringify(doneGraph.plotLifecycle));
  if (doneGraph.totalChapters !== 2) throw new Error("done-only 书 totalChapters 错: " + doneGraph.totalChapters);

  // ── 空书（目录存在、0 章）：不抛错 + degraded 非空 ──
  const EMPTY_BOOK = "空书样本";
  mkdirSync(join(testRoot, "novels", EMPTY_BOOK), { recursive: true });
  let emptyGraph = null;
  try {
    emptyGraph = await defs.novel_plot.execute({ book: EMPTY_BOOK, action: "graph", root: testRoot }, exec);
  } catch (e) {
    throw new Error("空书（目录存在、0 章）调用 graph 不应抛错，实际抛出: " + String(e?.message ?? e));
  }
  if (emptyGraph.totalChapters !== 0) throw new Error("空书 totalChapters 应为 0: " + emptyGraph.totalChapters);
  if (!Array.isArray(emptyGraph.plotLifecycle) || emptyGraph.plotLifecycle.length !== 0) throw new Error("空书 plotLifecycle 应为空数组: " + JSON.stringify(emptyGraph.plotLifecycle));
  if (!Array.isArray(emptyGraph.degraded) || emptyGraph.degraded.length === 0) throw new Error("空书 degraded 为空（缺数据必须显式说明）");
  console.log("v5.0.0 结构视图降级: 只有 done 伏笔 → plotLifecycle 空数组；空书 → 不抛错 + degraded " + emptyGraph.degraded.length + " 条 ✓");

  // ── 既有 action（list）行为不受影响 ──
  const plotList = await defs.novel_plot.execute({ book: BOOK, action: "list", root: testRoot }, exec);
  assertOutputContract(defs.novel_plot, plotList, "novel_plot(list)");
  if (plotList.action !== "list" || plotList.entries.length !== 3) throw new Error("list 行为被 graph 分支影响: " + JSON.stringify({ action: plotList.action, n: plotList.entries.length }));
  const openCount = plotList.entries.filter((e) => e.status === "open").length;
  const doneCount = plotList.entries.filter((e) => e.status === "done").length;
  if (openCount !== 2 || doneCount !== 1) throw new Error("list 的 open/done 分桶错: " + JSON.stringify({ openCount, doneCount }));
  const listText = defs.novel_plot.output.render({}, plotList)[0].text;
  if (!listText.includes("未回收伏笔") || listText.includes("novel-plot-graph")) throw new Error("list 的 render 走了 graph 分支或被污染: " + listText.slice(0, 120));
  const graphText = defs.novel_plot.output.render({}, graph)[0].text;
  if (!graphText.includes("novel-plot-graph") || !graphText.includes("连续缺席")) throw new Error("graph 的 render 未渲染结构视图分区: " + graphText.slice(0, 200));
  if (!graphText.includes(String(absentHero.from) + "–" + String(absentHero.to))) throw new Error("graph render 未显示缺席区间: " + graphText.slice(0, 400));
  console.log("v5.0.0 结构视图 list 未受影响: " + plotList.entries.length + " 条（open " + openCount + " / done " + doneCount + "）| list 与 graph 的 render 各自走对应分支 ✓");
})();

// ---------- v5.0.0 全量实测后的 4 处修补回归（版本号不变，属同一次发布） ----------
await (async function v500PostAuditFixes() {
  const BOOK = "修补回归书";
  const dir = join(testRoot, "novels", BOOK);
  mkdirSync(dir, { recursive: true });
  const put = (fname, txt) => writeFileSync(join(dir, fname), txt, "utf8");
  // ①「文件名有标题」的章：H1 故意写成别的内容 → 标题必须以文件名为准，不被 H1 回退覆盖
  put("第01章 初遇.md", "# 随便写的一级标题\n\n他把伞靠在墙角，抖了抖袖子上的水。桌上摆着一只冷掉的茶杯。\n");
  // ②「文件名没标题」的章：H1 就是标题 → 清单必须回退读出它（旧行为显示空标题）
  put("第02章.md", "# 她数了数台阶，一共四十七级\n\n她数了数台阶，第四级缺了一角，边上压着半块砖。\n");

  // ③ novel_new_chapter 的 title 必须进文件名（清单标题取自文件名，否则显示为空标题）
  const created = await defs.novel_new_chapter.execute({ book: BOOK, title: "靠岸之后", content: "小艇靠上码头的时候是清晨六点十分。", root: testRoot }, exec);
  assertOutputContract(defs.novel_new_chapter, created, "novel_new_chapter(title)");
  if (!/靠岸之后/.test(created.file ?? "")) throw new Error("title 未进文件名（清单标题会显示为空）: " + created.file);
  if (!String(created.file).startsWith("第03章 ")) throw new Error("带标题的文件名丢了章号前缀: " + created.file);
  const sanitized = await defs.novel_new_chapter.execute({ book: BOOK, chapter: 9, title: 'A/B:C*D?E"F<G>H|I', content: "x", root: testRoot }, exec);
  if (/[\\/:*?"<>|]/.test(sanitized.file ?? "")) throw new Error("标题里的非法文件名字符没被剥掉: " + sanitized.file);

  // ④ 清单标题口径：文件名优先，文件名没有才回退 H1
  const chList = await defs.novel_chapters.execute({ book: BOOK, root: testRoot }, exec);
  assertOutputContract(defs.novel_chapters, chList, "novel_chapters(标题回退)");
  const byFile = new Map(chList.chapters.map((c) => [c.file, c]));
  if (byFile.get("第02章.md")?.title !== "她数了数台阶，一共四十七级") throw new Error("无标题文件名未回退读 H1: " + JSON.stringify(byFile.get("第02章.md")));
  if (byFile.get("第03章 靠岸之后.md")?.title !== "靠岸之后") throw new Error("带标题文件名的标题应从文件名取: " + JSON.stringify(byFile.get("第03章 靠岸之后.md")));
  if (byFile.get("第01章 初遇.md")?.title !== "初遇") throw new Error("文件名标题被 H1 回退覆盖了: " + JSON.stringify(byFile.get("第01章 初遇.md")));

  // ⑤ fix_plan 清单渲染必须带 itemId（否则 mark 前得先自己去读 planFile）
  const plan = await defs.novel_fix_plan.execute({ book: BOOK, chapter: "第02章", action: "plan", root: testRoot }, exec);
  const planText = defs.novel_fix_plan.output.render({}, plan)[0].text;
  if (plan.items.length > 0 && !planText.includes("id：" + plan.items[0].id)) throw new Error("清单渲染未带 itemId: " + planText.slice(0, 300));
  // ⑥ verify 在 id 精确命中时也要显示人工标记（正文没动时 id 必然精确命中，第二轮兜底走不到）
  if (plan.items.length > 0) {
    const target = plan.items[0];
    await defs.novel_fix_plan.execute({ book: BOOK, chapter: "第02章", action: "mark", itemId: target.id, state: "done", root: testRoot }, exec);
    const verified = await defs.novel_fix_plan.execute({ book: BOOK, chapter: "第02章", action: "verify", root: testRoot }, exec);
    const markedItem = verified.checked.find((c) => c.id === target.id);
    if (!/人工标记 done/.test(markedItem?.detail ?? "")) throw new Error("verify 未显示人工标记: " + JSON.stringify(markedItem));
  }
  // ⑦ 非法 state 的报错要点明合法取值（不能让人以为"没传参数"）
  let badState = "";
  try { await defs.novel_fix_plan.execute({ book: BOOK, chapter: "第02章", action: "mark", itemId: "fix-x-0-0000000", state: "finished", root: testRoot }, exec); } catch (e) { badState = String(e?.message ?? e); }
  if (!/done/.test(badState) || !/skip/.test(badState) || !/收到/.test(badState)) throw new Error("非法 state 的报错文案不合格: " + badState);
  let noState = "";
  try { await defs.novel_fix_plan.execute({ book: BOOK, chapter: "第02章", action: "mark", itemId: "fix-x-0-0000000", root: testRoot }, exec); } catch (e) { noState = String(e?.message ?? e); }
  if (!/缺少 state/.test(noState)) throw new Error("缺 state 的报错文案未区分「没传」: " + noState);
  console.log("v5.0.0 修补回归: title 进文件名 + 非法字符剥离 ✓ | 文件名优先、无标题回退 H1 ✓ | 清单渲染带 itemId ✓ | verify 显示人工标记 ✓ | state 报错区分「没传/非法值」✓");
})();

// 清理缓存文件（保留状态文件）
rmSync(testRoot, { recursive: true, force: true });
// v4.0.0：告警即失败——插件运行期 console.warn 此前完全不被测试感知（e2e 全绿但 stderr 持续刷契约失配）
console.warn = originalWarn;
if (pluginWarnings.length > 0) throw new Error("插件运行期告警 " + pluginWarnings.length + " 条（v4.0.0 起视为失败）: " + pluginWarnings.join(" | "));
console.log("\nALL E2E TESTS PASSED");
