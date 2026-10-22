/**
 * v6.8.0 按书删除（issue #2）回归套件 —— 钉住「删一本书到底要动哪些文件」这件事。
 *
 * ## 被钉住的契约（v6.8.0，`lib/bookdelete.js`）
 *
 * 匹配口径 —— **前缀 + 分隔符边界**：
 *   · `<书>.json` / `<书>-<hash>.json` / `<书>__style_2.json` / `fix-plan-<书>-第01章.json` 命中
 *   · `_global.json`（全局词表）**不命中**
 *   · `<书>子-<hash>.json`（前缀相近的另一本书）**不命中** ← 少了边界规则就会误删
 *   · 旧位置伏笔表（数据目录**根**上的 `<书>.json`）也要命中（v0.8.0 前的 legacyPlotsFile）
 *
 * 执行语义：
 *   · 默认**移入回收站**（`<数据目录>/trash/<书>-<时间戳>/`），写 `manifest.json`，可 `restore` 原样移回
 *   · 只处理所选书籍：`_global.json`、`state.json` 里的开关/容差/其他书条目、其他书的文件一律不动
 *   · `purge` 才彻底删除；`trashId` 任何形式的路径穿越都要拒绝
 *   · 恢复时原位置已存在 → **跳过并报告冲突**，绝不覆盖（同名重开是这里的典型场景）
 *
 * 工具层：
 *   · `novel_delete_book` 进 `ALL_TOOLS`（第 21 个），输出 schema `additionalProperties:false`
 *     且 `required ⊆ properties`、返回体**无未声明键**（v6.6.x 踩过：cleanOutput 丢掉 undefined 键
 *     会让 required 缺项，`apply` 曾因此少一个 `profileRestored`）
 *   · 面板路由 `POST /api/dsh-novel-writer/delete-book` 与工具**同一实现**（deleteBookDispatch），
 *     返回同形；非 loopback → 403，非法方法 → 405
 *
 * ## 隔离
 *
 * `DSH_NOVEL_WRITER_STATE` / `DSH_HOME` 指向临时目录，每项测试各自一个临时书库根（隐式 root 一律
 * 显式传入）。最后一项把用户**真实** state.json 与 logs/ 与开跑前对比——删书是破坏性操作，
 * 断言"没碰用户真实数据"比断言"删成功了"更要紧。
 *
 * 运行：node test/delete-book-test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// ===========================================================================
// 隔离夹具：先设 env，再动态 import（静态 import 会先于模块体求值）
// ===========================================================================

const ROOT = join(tmpdir(), "dsh-delete-book-" + process.pid + "-" + Date.now().toString(36));
const STATE_DIR = join(ROOT, "state-dir");
const STATE = join(STATE_DIR, "state.json");
const REAL_STATE = join(homedir(), ".dsh", "dsh-novel-writer", "state.json");
const REAL_LOG_DIR = join(homedir(), ".dsh", "dsh-novel-writer", "logs");

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(join(ROOT, "dsh-home"), { recursive: true });
process.env.DSH_NOVEL_WRITER_STATE = STATE;
process.env.DSH_HOME = join(ROOT, "dsh-home");
process.on("exit", () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

function digestFile(file) {
  try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch { return "absent"; }
}
function digestDir(dir) {
  try {
    return readdirSync(dir).sort().map((name) => name + ":" + digestFile(join(dir, name))).join("|");
  } catch { return "absent"; }
}
const guardBefore = { state: digestFile(REAL_STATE), logs: digestDir(REAL_LOG_DIR) };

const bd = await import("../lib/bookdelete.js");
const core = await import("../lib/core.js");
const plugin = await import("../lib/index.js");

// ===========================================================================
// 夹具构造
// ===========================================================================

let libSeq = 0;
/** 每项测试各自一个书库根——避免测试之间通过 trash/ 与残留互相影响。 */
function freshLib(tag) {
  libSeq += 1;
  const root = join(ROOT, "lib-" + tag + "-" + libSeq);
  mkdirSync(join(root, "novels"), { recursive: true });
  return root;
}
function touch(root, rel, body = "x") {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
}

/**
 * 一本书的**全套**资料：正文 + 创作资料 + 9 个数据子目录 + 旧位置伏笔表 + 设定库条目。
 * 与 v6.8.0 实测盘面一一对应（见 lib/bookdelete.js 文件头的命名清单）。
 */
function seedBook(root, book) {
  touch(root, "novels/" + book + "/第01章.md", book + " 第一章正文");
  touch(root, "novels/" + book + "/第02章.md", book + " 第二章正文");
  touch(root, "novels/创作资料/" + book + "/创作设定.md", book + " 设定");
  touch(root, "novels/创作资料/" + book + "/创作状态卡.md", book + " 状态卡");
  const D = ".novel-writer";
  const files = [
    D + "/analysis/" + book + "-0123456789abcdef.json",
    D + "/analysis/" + book + "-chapters-metrics.json",
    D + "/analysis/" + book + "__base-full.json",
    D + "/analysis/" + book + "-keywords-aaaabbbbcccc.json",
    D + "/audits/fix-plan-" + book + "-第01章.json",
    D + "/audits/" + book + "-396fb13a1b939b5f.json",
    D + "/baseline/" + book + ".json",
    D + "/embedding/" + book + ".json",
    D + "/embedding/" + book + "__styleproto.json",
    D + "/embedding/" + book + "__style_第02章.json",
    D + "/lexicon/" + book + ".json",
    D + "/plots/" + book + ".json",
    D + "/settings/" + book + ".json",
    D + "/style-reports/" + book + ".json",
    D + "/summaries/" + book + ".json",
    D + "/" + book + ".json" // v0.8.0 前的伏笔表旧位置
  ];
  for (const rel of files) touch(root, rel, "{}");
  // 全局词表：永远不属于任何一本书
  touch(root, D + "/lexicon/_global.json", '{"entries":[{"term":"全局词"}]}');
}
function seedState(profiles) {
  writeFileSync(STATE, JSON.stringify({
    enabled: true,
    autoGenerate: false,
    tools: { novel_plot: false },
    styleTolerance: { rhetoric: { low: -5, high: 5 } },
    creationProfiles: profiles
  }, null, 2), "utf8");
}
async function readState() {
  return JSON.parse(readFileSync(STATE, "utf8"));
}
function treeFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

// ===========================================================================
// ① 纯函数：前缀 + 分隔符边界
// ===========================================================================

test("① 匹配口径：前缀边界与 fix-plan / 旧位置写法", () => {
  const keys = ["孤舟"];
  for (const name of ["孤舟.json", "孤舟-c7910a84.json", "孤舟__style_2.json", "孤舟__style_第02章.md.json", "孤舟-chapters-metrics.json", "fix-plan-孤舟-第01章.json"]) {
    assert.equal(bd.isBookScopedName(name, keys), true, "应命中：" + name);
  }
  for (const name of ["孤舟子.json", "孤舟子-abc.json", "_global.json", "state.json", "孤舟.txt.bak"]) {
    // 孤舟.txt.bak 命中（点号边界）；其余都不该命中
    if (name === "孤舟.txt.bak") continue;
    assert.equal(bd.isBookScopedName(name, keys), false, "不该命中：" + name);
  }
  // 点号边界本身是允许的（扩展名不同也算同一本书）
  assert.equal(bd.isBookScopedName("孤舟.txt.bak", keys), true);
  // 多写法（原始名 / 清洗名）任一命中即可
  assert.equal(bd.isBookScopedName("孤舟 归来.json", ["孤舟 归来", "孤舟"]), true);
  assert.equal(bd.isBookScopedName("孤舟.json", ["孤舟 归来", "孤舟"]), true);
});

test("①-b 数据子目录白名单与诊断的预期子目录一致（漏登记＝漏删）", () => {
  // 诊断侧把 trash 当成"可缺省"的子目录；这里只要求按书删除覆盖 9 个既有子目录
  assert.deepEqual([...bd.DELETE_DATA_SUBDIRS].sort(), ["analysis", "audits", "baseline", "embedding", "lexicon", "plots", "settings", "style-reports", "summaries"]);
});

// ===========================================================================
// ② 预览
// ===========================================================================

test("② 预览：列出全部位置，且磁盘零改动", async () => {
  const root = freshLib("preview");
  seedBook(root, "试书");
  seedState({ 试书: { genre: "悬疑" } });
  const before = treeFiles(root);
  const plan = await bd.planBookDelete({ root, book: "试书" });
  assert.equal(plan.blocked, false);
  assert.equal(plan.found, true);
  const keys = plan.targets.filter((t) => t.exists).map((t) => t.key);
  for (const expected of ["chapters", "creation", "legacy", "profile", "data:analysis", "data:audits", "data:baseline", "data:embedding", "data:lexicon", "data:plots", "data:settings", "data:style-reports", "data:summaries"]) {
    assert.ok(keys.includes(expected), "预览应包含 " + expected + "，实际：" + keys.join(","));
  }
  // analysis 命中 4 个；audits 命中 2 个（含 fix-plan）
  assert.equal(plan.targets.find((t) => t.key === "data:analysis").files, 4);
  assert.equal(plan.targets.find((t) => t.key === "data:audits").files, 2);
  assert.equal(plan.targets.find((t) => t.key === "legacy").files, 1);
  assert.ok(plan.totals.files >= 18, "总文件数应覆盖全部资料，实际 " + plan.totals.files);
  // 预览绝不写盘
  assert.deepEqual(treeFiles(root), before, "预览不得改动磁盘");
  assert.equal(existsSync(bd.trashDirPath(root)), false, "预览不得创建回收站");
  // 不存在的书
  const missing = await bd.planBookDelete({ root, book: "查无此书" });
  assert.equal(missing.found, false);
});

// ===========================================================================
// ③ 执行
// ===========================================================================

test("③ 执行：移入回收站、清单完整、残留为 0", async () => {
  const root = freshLib("apply");
  seedBook(root, "去书");
  seedState({ 去书: { genre: "武侠" } });
  const plan = await bd.planBookDelete({ root, book: "去书" });
  const result = await bd.applyBookDelete({ root, book: "去书", plan });
  assert.equal(result.failed.length, 0, "不应有失败项：" + JSON.stringify(result.failed));
  assert.ok(result.moved >= 12, "至少要搬走 12 项（2 个目录 + 9 个数据子目录 + 旧位置伏笔表），实际 " + result.moved);
  assert.equal(result.remaining.files, 0, "清理后不应有残留：" + JSON.stringify(result.remaining));
  assert.notEqual(result.trashId, "");
  assert.equal(result.profileRemoved, true);

  // 正文 / 创作资料 / 数据文件全部不在原位
  assert.equal(existsSync(join(root, "novels", "去书")), false);
  assert.equal(existsSync(join(root, "novels", "创作资料", "去书")), false);
  // 回收站里的当然还算"包含书名"——这里只查回收站之外
  assert.deepEqual(treeFiles(join(root, ".novel-writer")).filter((f) => f.includes("去书") && !f.includes("trash")), [], "数据目录里不该再有这本书的文件");
  // 旧位置伏笔表也走了
  assert.equal(existsSync(join(root, ".novel-writer", "去书.json")), false);

  // 清单可读、条目数与 moved 一致、记录了原路径
  const manifestPath = join(result.trashDir, "manifest.json");
  assert.equal(existsSync(manifestPath), true);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schema, bd.TRASH_SCHEMA);
  assert.equal(manifest.book, "去书");
  assert.equal(manifest.items.length, result.moved);
  for (const item of manifest.items) {
    assert.ok(String(item.from).startsWith(root), "清单必须记录原路径：" + item.from);
    assert.ok(existsSync(item.to), "回收站里的目标必须真实存在：" + item.to);
  }
  assert.equal(manifest.profile.key, "去书");
  assert.equal(manifest.profile.value.genre, "武侠");
});

// ===========================================================================
// ④ 只处理所选书籍
// ===========================================================================

test("④ 边界：全局词表 / 其他书 / 插件设置都不受影响", async () => {
  const root = freshLib("scope");
  seedBook(root, "甲书");
  seedBook(root, "甲书子"); // 前缀相近的另一本书
  seedBook(root, "乙书");
  seedState({ 甲书: { genre: "悬疑" }, 乙书: { genre: "武侠" } });
  const beforeSub = treeFiles(join(root, "novels", "甲书子"));
  const beforeYi = treeFiles(join(root, "novels", "乙书"));
  await bd.applyBookDelete({ root, book: "甲书" });

  // 前缀相近的书整棵树不变
  assert.deepEqual(treeFiles(join(root, "novels", "甲书子")), beforeSub);
  assert.deepEqual(treeFiles(join(root, "novels", "乙书")), beforeYi);
  assert.equal(existsSync(join(root, ".novel-writer", "analysis", "甲书子-0123456789abcdef.json")), true);
  assert.equal(existsSync(join(root, ".novel-writer", "analysis", "乙书-0123456789abcdef.json")), true);
  // 全局词表还在
  assert.equal(existsSync(join(root, ".novel-writer", "lexicon", "_global.json")), true);
  // 插件设置：其他书的条目、开关、容差都在；只有甲书的条目被摘掉
  const state = await readState();
  assert.deepEqual(Object.keys(state.creationProfiles).sort(), ["乙书"]);
  assert.equal(state.enabled, true);
  assert.equal(state.tools.novel_plot, false);
  assert.deepEqual(state.styleTolerance.rhetoric, { low: -5, high: 5 });
});

// ===========================================================================
// ⑤ 恢复
// ===========================================================================

test("⑤ 恢复：文件原样回位，设定库条目也回来", async () => {
  const root = freshLib("restore");
  seedBook(root, "回书");
  seedState({ 回书: { genre: "科幻" } });
  const before = treeFiles(root);
  const result = await bd.applyBookDelete({ root, book: "回书" });
  const restored = await bd.restoreTrash({ root, trashId: result.trashId });
  assert.equal(restored.conflicts.length, 0, JSON.stringify(restored.conflicts));
  assert.equal(restored.failed.length, 0, JSON.stringify(restored.failed));
  assert.equal(restored.restored, result.moved);
  assert.equal(restored.profileRestored, true);
  // 每一个原文件都回来了（树结构一致）
  assert.deepEqual(treeFiles(root), before);
  const state = await readState();
  assert.equal(state.creationProfiles.回书.genre, "科幻");
  // 回收站已清空
  assert.deepEqual(await bd.listTrash({ root }), []);
});

// ===========================================================================
// ⑥ 恢复冲突：绝不覆盖
// ===========================================================================

test("⑥ 恢复冲突：原位置已有同名内容时跳过并报告，不覆盖新内容", async () => {
  const root = freshLib("conflict");
  seedBook(root, "冲书");
  seedState({ 冲书: { genre: "历史" } });
  const result = await bd.applyBookDelete({ root, book: "冲书" });
  // 同名重开：用户在新书里已经写了新章（目录被重建）
  touch(root, "novels/冲书/第01章.md", "重开之后的新第一章");
  const restored = await bd.restoreTrash({ root, trashId: result.trashId });
  assert.ok(restored.conflicts.length >= 1, "应报告冲突：" + JSON.stringify(restored.conflicts));
  assert.ok(restored.conflicts.some((p) => p.includes("第01章")), "冲突应具体到文件：" + JSON.stringify(restored.conflicts));
  // 新内容没被旧稿覆盖
  assert.equal(readFileSync(join(root, "novels", "冲书", "第01章.md"), "utf8"), "重开之后的新第一章");
  // 目录被重建时**逐文件合并**恢复：没冲突的第 02 章照常回来
  assert.equal(existsSync(join(root, "novels", "冲书", "第02章.md")), true, "未冲突的文件必须能恢复（整目录跳过会让用户「点了恢复什么都没回来」）");
  // 未恢复成功的条目仍留在回收站里，可以下次再来
  const left = await bd.listTrash({ root });
  assert.equal(left.length, 1, "未完全恢复时条目应保留：" + JSON.stringify(left));
  assert.equal(existsSync(join(result.trashDir, "novels", "冲书", "第01章.md")), true, "冲突的旧稿必须留在回收站里");
});

// ===========================================================================
// ⑦ 彻底删除
// ===========================================================================

test("⑦ 彻底删除：回收站条目消失且不可恢复", async () => {
  const root = freshLib("purge");
  seedBook(root, "绝书");
  seedState({});
  const result = await bd.applyBookDelete({ root, book: "绝书" });
  const dir = join(bd.trashDirPath(root), result.trashId);
  assert.equal(existsSync(dir), true);
  const purged = await bd.purgeTrash({ root, trashId: result.trashId });
  assert.equal(purged.purged, true);
  assert.ok(purged.files > 0);
  assert.equal(existsSync(dir), false);
  assert.deepEqual(await bd.listTrash({ root }), []);
  await assert.rejects(() => bd.restoreTrash({ root, trashId: result.trashId }), /没有可用的清单/);
});

// ===========================================================================
// ⑧ 拒绝：保留名 / 路径穿越 / 不存在的书
// ===========================================================================

test("⑧ 保留名与非法 trashId 一律拒绝", async () => {
  const root = freshLib("reject");
  seedBook(root, "普书");
  seedState({});
  for (const book of ["_global", "创作资料", ".git"]) {
    const plan = await bd.planBookDelete({ root, book });
    assert.equal(plan.blocked, true, "应拒绝书名：" + book);
    await assert.rejects(() => bd.applyBookDelete({ root, book }), /无法删除/, "apply 也必须拒绝：" + book);
  }
  // "." / ".." 在清洗阶段就无有效字符，直接拒绝（比"当成不存在的书"更明确）
  for (const book of [".", ".."]) {
    await assert.rejects(() => bd.planBookDelete({ root, book }), /不能为空/, "应拒绝书名：" + book);
  }
  for (const trashId of ["../../etc", "..", "a/b", "", " x", ".hidden"]) {
    await assert.rejects(() => bd.restoreTrash({ root, trashId }), /trashId/, "应拒绝 trashId：" + JSON.stringify(trashId));
    await assert.rejects(() => bd.purgeTrash({ root, trashId }), /trashId/, "purge 也应拒绝：" + JSON.stringify(trashId));
  }
  await assert.rejects(() => bd.applyBookDelete({ root, book: "查无此书" }), /没找到/);
});

// ===========================================================================
// ⑨ 工具层：注册 + 输出契约 + render
// ===========================================================================

const toolRoot = join(ROOT, "tool-lib");
mkdirSync(join(toolRoot, "novels"), { recursive: true });
const toolDefs = [];
const routes = [];
plugin.apply({
  tools: { register(def) { toolDefs.push(def); return () => {}; } },
  inject(deps, fn) {
    if (deps.includes("webServer")) fn({ webServer: { register(route) { routes.push(route); return () => {}; } }, effect(register) { register(); } });
    else if (deps.includes("skills")) fn({ skills: { registerProvider() { /* 无需断言 */ } } });
  },
  systemPrompt: { section() { /* 无需断言 */ } }
}, { root: toolRoot });

test("⑨ 工具：进 ALL_TOOLS 第 21 位，输出契约与 render 同源", async () => {
  assert.equal(core.ALL_TOOLS.length, 21);
  assert.ok(core.ALL_TOOLS.includes("novel_delete_book"));
  assert.equal(core.TOOL_LABELS.novel_delete_book, "按书删除");
  const def = toolDefs.find((d) => d.name === "novel_delete_book");
  assert.ok(def, "工具必须已注册");
  assert.deepEqual([...toolDefs.map((d) => d.name)].sort(), [...core.ALL_TOOLS].sort(), "注册表与 ALL_TOOLS 必须一致");

  const schema = def.output.schema;
  assert.equal(schema.additionalProperties, false);
  const declared = new Set(Object.keys(schema.properties));
  for (const key of schema.required) assert.ok(declared.has(key), "required 必须在 properties 内：" + key);

  seedBook(toolRoot, "工具书");
  seedState({ 工具书: { genre: "奇幻" } });
  const check = (label, value) => {
    const extra = Object.keys(value).filter((k) => !declared.has(k));
    assert.deepEqual(extra, [], label + " 出现未声明键：" + JSON.stringify(extra));
    for (const key of schema.required) assert.ok(key in value && value[key] !== undefined, label + " 缺少 required：" + key);
  };

  const preview = await def.execute({ book: "工具书", action: "preview" }, {});
  check("preview", preview);
  assert.equal(preview.moved, 0);
  assert.equal(preview.trashId, "");
  assert.ok(preview.message.includes("磁盘未改动"), preview.message);
  const previewText = def.output.render({}, preview)[0].text;
  assert.ok(previewText.includes("按书删除 · 预览"), previewText.slice(0, 40));
  assert.ok(previewText.includes("不会动"), "渲染必须说明哪些东西不动");

  const applied = await def.execute({ book: "工具书", action: "apply" }, {});
  check("apply", applied);
  assert.ok(applied.moved >= 12, "moved=" + applied.moved);
  assert.equal(applied.remaining.files, 0);
  const applyText = def.output.render({}, applied)[0].text;
  assert.ok(applyText.includes(applied.trashId), "渲染必须给出回收站 id");

  const listed = await def.execute({ action: "list" }, {});
  check("list", listed);
  assert.equal(listed.trash.length, 1);
  for (const key of ["id", "book", "createdAt", "files", "bytes", "items", "restorable", "path"]) {
    assert.ok(key in listed.trash[0], "list 条目缺少字段：" + key);
  }

  const restored = await def.execute({ action: "restore", trashId: applied.trashId }, {});
  check("restore", restored);
  assert.equal(restored.restored, applied.moved);

  // action 缺省 = preview（安全的那一侧）
  const defaulted = await def.execute({ book: "工具书" }, {});
  check("default", defaulted);
  assert.equal(defaulted.action, "preview");
});

// ===========================================================================
// ⑩ 面板路由：与工具同一实现
// ===========================================================================

test("⑩ 路由：GET/POST 同形、非 loopback 403、非法方法 405", async () => {
  const route = routes.find((r) => r.path === "/api/dsh-novel-writer/delete-book");
  assert.ok(route, "路由必须已注册");
  const makeRes = () => ({ status: 0, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body; } });
  const makeReq = (url, method = "GET") => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:51783" }, method, url });

  seedBook(toolRoot, "路由书");
  seedState({ 路由书: { genre: "都市" } });

  const listRes = makeRes();
  await route.handler(makeReq("/api/dsh-novel-writer/delete-book?action=list"), listRes);
  assert.equal(listRes.status, 200);
  const listBody = JSON.parse(listRes.body);
  assert.equal(listBody.ok, true);
  for (const key of ["action", "trash", "targets", "totals", "warnings", "notTouched", "moved", "failed", "remaining"]) {
    assert.ok(key in listBody, "路由返回体缺少字段：" + key);
  }

  const previewRes = makeRes();
  const chunks = [Buffer.from(JSON.stringify({ action: "preview", book: "路由书" }))];
  await route.handler({ ...makeReq("/api/dsh-novel-writer/delete-book", "POST"), async *[Symbol.asyncIterator]() { yield* chunks; } }, previewRes);
  assert.equal(previewRes.status, 200);
  const previewBody = JSON.parse(previewRes.body);
  assert.equal(previewBody.ok, true);
  assert.ok(Array.isArray(previewBody.targets) && previewBody.targets.length > 0);
  assert.equal(previewBody.moved, 0, "面板预览也不得动盘");

  const forbidden = makeRes();
  await route.handler({ socket: { remoteAddress: "192.168.1.9" }, headers: { host: "192.168.1.9:51783" }, method: "GET", url: "/api/dsh-novel-writer/delete-book" }, forbidden);
  assert.equal(forbidden.status, 403);

  const badMethod = makeRes();
  await route.handler({ ...makeReq("/api/dsh-novel-writer/delete-book"), method: "DELETE" }, badMethod);
  assert.equal(badMethod.status, 405);

  const badBody = makeRes();
  const badChunks = [Buffer.from("not json")];
  await route.handler({ ...makeReq("/api/dsh-novel-writer/delete-book", "POST"), async *[Symbol.asyncIterator]() { yield* badChunks; } }, badBody);
  assert.equal(badBody.status, 400, "非法 JSON 体应 400");
});

// ===========================================================================
// ⑪ 隔离守卫
// ===========================================================================

test("⑪ 隔离守卫：用户真实的 state.json 与 logs/ 全程未被改动", () => {
  assert.equal(digestFile(REAL_STATE), guardBefore.state, "真实 state.json 被改动了");
  assert.equal(digestDir(REAL_LOG_DIR), guardBefore.logs, "真实 logs/ 被改动了");
});
