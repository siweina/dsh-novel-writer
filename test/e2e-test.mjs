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
if (names.length !== 10) throw new Error("expected 10 tools");

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
console.log("首次分析 cache:", first.cache, "| reportFile:", first.reportFile?.includes("cache"));
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
const plotFile = join(testRoot, ".novel-writer", "测试.json");
if (!existsSync(plotFile)) throw new Error("plot file not persisted");
console.log("伏笔文件:", plotFile, "存在 ✓");

// 4) 关键词（三字组/疑似人名）
writeFileSync(join(testRoot, "novels", "测试", "第03章.md"), "露西亚说着话，琉璃点了点头。露西亚问导师问题，琉璃笑道。\n", "utf8");
const kw = await defs.novel_keywords.execute({ book: "测试", top: 20 }, exec);
console.log("关键词:", kw.keywords.map((k) => k.word + "(" + k.kind + ")").join(" "));
if (!kw.keywords.some((k) => k.kind === "name-candidate" && (k.word.includes("露西") || k.word.includes("琉璃")))) throw new Error("name candidate missing");

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

// 清理缓存文件（保留状态文件）
rmSync(testRoot, { recursive: true, force: true });
console.log("\nALL E2E TESTS PASSED");
