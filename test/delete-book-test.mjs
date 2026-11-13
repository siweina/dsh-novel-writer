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
 *   · `novel_delete_book` 进 `ALL_TOOLS`（第 21 个；v7.3.0 起总数为 22），输出 schema `additionalProperties:false`
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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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
  // 诊断侧把 trash 当成"可缺省"的子目录；这里要求按书删除覆盖全部**扁平存书**的子目录。
  // v7.3.0：drafts（草稿镜像）不在此列——它是"按书一个目录"，由 planBookDelete 单独登记成
  // data:drafts（kind:"dir"）。放进这个白名单反而永远命中 0 个文件而被跳过。删除覆盖由
  // chat-writing-test 的「按书删除必须清掉 drafts」断言盯着。
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
  // 清单里的 files 才是"真实搬走的文件数"（totals 还含设定库条目这个非文件项）
  const manifest = JSON.parse(readFileSync(join(result.trashDir, "manifest.json"), "utf8"));
  const restored = await bd.restoreTrash({ root, trashId: result.trashId });
  assert.equal(restored.conflicts.length, 0, JSON.stringify(restored.conflicts));
  assert.equal(restored.failed.length, 0, JSON.stringify(restored.failed));
  assert.equal(restored.restored, manifest.files, "恢复项数按文件数统计（#60）：" + restored.restored + " != " + manifest.files);
  const restoredText = bd.formatBookDelete({ action: "restore", book: "回书", restored: restored.restored, profileRestored: true });
  assert.ok(restoredText.includes("个文件"), "恢复文案必须写明单位是「个文件」：" + restoredText.slice(0, 120));
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
// ⑦-b 选择性清理（只删某几类数据）—— "只清报告历史/缓存，正文留着"
// ===========================================================================

test("⑦-b 选择性清理：只清报告与缓存，正文/创作资料/设定条目原样保留", async () => {
  const root = freshLib("partial");
  seedBook(root, "分书");
  seedState({ 分书: { genre: "悬疑" } });
  const result = await bd.applyBookDelete({ root, book: "分书", keys: ["data:analysis", "data:audits", "data:style-reports"] });
  assert.equal(result.partial, true, "只清一部分时 partial 必须为 true");
  assert.deepEqual([...result.keys].sort(), ["data:analysis", "data:audits", "data:style-reports"]);
  assert.ok(result.skipped.includes("chapters"), "正文应被列为保留：" + JSON.stringify(result.skipped));
  assert.ok(result.skipped.includes("creation"));
  assert.ok(result.skipped.includes("profile"));
  assert.ok(result.moved >= 3, "moved=" + result.moved);
  // 保留侧：正文 / 创作资料 / 设定库条目 / 其他类别都还在
  assert.equal(existsSync(join(root, "novels", "分书", "第01章.md")), true);
  assert.equal(existsSync(join(root, "novels", "创作资料", "分书", "创作设定.md")), true);
  assert.equal((await readState()).creationProfiles.分书.genre, "悬疑");
  assert.equal(existsSync(join(root, ".novel-writer", "summaries", "分书.json")), true);
  assert.equal(existsSync(join(root, ".novel-writer", "plots", "分书.json")), true);
  // 清理侧：报告与缓存没了
  assert.equal(existsSync(join(root, ".novel-writer", "analysis", "分书-chapters-metrics.json")), false);
  assert.equal(existsSync(join(root, ".novel-writer", "audits", "fix-plan-分书-第01章.json")), false);
  assert.equal(existsSync(join(root, ".novel-writer", "style-reports", "分书.json")), false);
  // 提示必须说清"是有意保留"，而不是"还有残留"
  assert.ok(result.warnings.some((w) => w.includes("按选择保留")), JSON.stringify(result.warnings));

  // 清单只记录实际搬走的项，恢复只把那些移回
  const manifest = JSON.parse(readFileSync(join(result.trashDir, "manifest.json"), "utf8"));
  assert.equal(manifest.items.length, result.moved);
  const back = await bd.restoreTrash({ root, trashId: result.trashId });
  assert.equal(back.restored, result.totals.files);
  assert.equal(existsSync(join(root, ".novel-writer", "analysis", "分书-chapters-metrics.json")), true);

  // 三种非法 keys 都要报错（未知位置 / 空选择 / 不是数组）
  await assert.rejects(() => bd.applyBookDelete({ root, book: "分书", keys: ["data:nope"] }), /未知位置/);
  await assert.rejects(() => bd.applyBookDelete({ root, book: "分书", keys: [] }), /至少要选中/);
  await assert.rejects(() => bd.applyBookDelete({ root, book: "分书", keys: "chapters" }), /必须是数组/);
  // 全选 == 不传 keys（回放既有语义）
  const all = bd.selectTargets(await bd.planBookDelete({ root, book: "分书" }), undefined);
  assert.ok(all.has("chapters") && all.has("data:summaries") && all.has("profile"), JSON.stringify([...all]));
});

// ===========================================================================
// ⑦-c v7.3.3 #9：空目录也要能删（预览算可清理 + apply 直接移除）
// ===========================================================================

test("⑦-c #9 纯空作品目录：预览 found=true、可清理，apply 能真的删掉（旧版抛「没找到任何内容」）", async () => {
  const root = freshLib("emptydir");
  // novels/<书>/ 存在但一个文件都没有：这正是「0 章书」在盘上的样子
  mkdirSync(join(root, "novels", "空书"), { recursive: true });
  seedState({});

  const plan = await bd.planBookDelete({ root, book: "空书" });
  assert.equal(plan.found, true, "存在但为空的作品目录也必须算可清理：" + JSON.stringify(plan.targets));
  const chapterTarget = plan.targets.find((t) => t.key === "chapters");
  assert.equal(chapterTarget.exists, true);
  assert.equal(chapterTarget.files, 0);
  assert.ok(plan.keys.includes("chapters"), "可清理 keys 必须含空目录：" + JSON.stringify(plan.keys));
  // 预览侧：它确实被列为「将清理」的项目（缺陷原状是列了却删不掉）
  const preview = bd.formatBookDelete({ action: "preview", ...plan });
  assert.ok(preview.includes("章节正文") && preview.includes("novels/空书"), "预览应列出空正文目录：" + preview);

  const result = await bd.applyBookDelete({ root, book: "空书", plan });
  assert.deepEqual(result.failed, [], "空目录不该移不动：" + JSON.stringify(result.failed));
  assert.equal(result.moved, 0, "空目录没有文件，moved 不应虚增");
  assert.equal(result.trashId, "", "空目录没有内容可恢复，不应生成 0 文件的回收站条目");
  assert.equal(existsSync(join(root, "novels", "空书")), false, "空目录必须真的从盘上消失");
  assert.equal(result.remaining.files, 0, "不应有残留：" + JSON.stringify(result.remaining));
  assert.ok(result.warnings.some((w) => w.includes("空目录")), "必须说明空目录是直接移除、不进回收站：" + JSON.stringify(result.warnings));
  assert.ok(result.message.includes("空目录"), "结论必须提到空目录：" + result.message);

  // 反证：再预览一次，这本书已经彻底不在了（novel_books 不会再列出 0 章书）
  const after = await bd.planBookDelete({ root, book: "空书" });
  assert.equal(after.found, false, "删除后再预览不得仍说找到了这本书");
});

test("⑦-d #9 空目录 + 其它文件：apply 清掉文件的同时移除空目录，不留空壳", async () => {
  const root = freshLib("emptymix");
  mkdirSync(join(root, "novels", "混书"), { recursive: true });
  touch(root, ".novel-writer/audits/混书-0123456789abcdef.json", "{}");
  seedState({});

  const plan = await bd.planBookDelete({ root, book: "混书" });
  assert.equal(plan.found, true);
  assert.ok(plan.keys.includes("chapters"), "空目录应进入可清理清单：" + JSON.stringify(plan.keys));
  assert.ok(plan.keys.includes("data:audits"));

  const result = await bd.applyBookDelete({ root, book: "混书", plan });
  assert.deepEqual(result.failed, [], JSON.stringify(result.failed));
  assert.equal(result.moved, 1, "只有 audits 那 1 个文件需要移入回收站");
  assert.equal(existsSync(join(root, "novels", "混书")), false, "清理后不得残留空目录（缺陷原状是空壳留在盘上）");
  assert.equal(existsSync(join(root, ".novel-writer", "audits", "混书-0123456789abcdef.json")), false);
  assert.equal(result.remaining.files, 0, "不应有残留：" + JSON.stringify(result.remaining));
  // 回收站清单只记录真实搬走的文件，条目数与 moved 同口径（空目录不在清单里）
  const manifest = JSON.parse(readFileSync(join(result.trashDir, "manifest.json"), "utf8"));
  assert.equal(manifest.items.length, result.moved);
  assert.ok(manifest.items.every((it) => it.dir !== true), "空目录不应被当成可恢复目录项写进清单");
});

test("⑦-e #9 反证：未选中的空目录必须保留（选择性清理语义不被空目录改写）", async () => {
  const root = freshLib("emptykeep");
  mkdirSync(join(root, "novels", "留书"), { recursive: true });
  touch(root, ".novel-writer/audits/留书-0123456789abcdef.json", "{}");
  seedState({});

  const result = await bd.applyBookDelete({ root, book: "留书", keys: ["data:audits"] });
  assert.equal(result.partial, true);
  assert.ok(result.skipped.includes("chapters"), "未选中的空目录要出现在 skipped：" + JSON.stringify(result.skipped));
  assert.equal(existsSync(join(root, "novels", "留书")), true, "没选中的空目录绝不删除");
  assert.notEqual(result.trashId, "", "仍有文件被搬走，应生成回收站条目");
});

test("⑦-f #9 反证：目录里还有子目录（无文件）时 rmdir 失败 → 记失败项并原样保留，不得误删", async () => {
  const root = freshLib("emptynested");
  mkdirSync(join(root, "novels", "深书", "空子目录"), { recursive: true });
  seedState({});

  const result = await bd.applyBookDelete({ root, book: "深书" });
  assert.equal(result.moved, 0);
  assert.equal(result.failed.length, 1, "非空目录必须报失败而不是静默删掉：" + JSON.stringify(result.failed));
  assert.equal(existsSync(join(root, "novels", "深书", "空子目录")), true, "非空目录里的内容必须原样保留");
  assert.equal(result.message.includes("没有移动任何内容"), true, "失败时结论要如实：" + result.message);
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
// ⑧-b v7.3.1（审查 #47 + 其姊妹漏洞）：删除与恢复都不得越出书库根
// ===========================================================================

/** p 是否落在 root 之内（root 本身不算"里面"——删除目标不该是根目录自己） */
function inside(root, p) {
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !rel.includes(":");
}

test("⑧-b #47：书名含 ../ 时删除目标必须落在书库根内，绝不搬走库外的东西", async () => {
  const root = freshLib("traverse");
  // 库外的受害者目录：`x/../../../<name>` 从 novels/ 出发正好落到它的父目录（ROOT）下。
  // 修复前 `resolveBookFolder` 原样返回未清洗的书名，join 之后 chapterDir === victimDir，
  // 于是"删一本不存在的书"会把库外的真实目录整个移进回收站（purge 后不可恢复）。
  const tag = "victim-" + libSeq;
  const victimDir = join(ROOT, tag);
  mkdirSync(victimDir, { recursive: true });
  writeFileSync(join(victimDir, "库外机密.txt"), "outside-root", "utf8");
  const book = "x/../../../" + tag;

  const plan = await bd.planBookDelete({ root, book });
  // 策略：清洗后的书名（`x_victim-…`）——目标一律在 root 内；若将来改成"直接拒绝"，
  // 断言 2 那一路（blocked）同样满足"绝不搬走库外内容"的契约。
  if (!plan.blocked) {
    assert.ok(inside(root, plan.folder === "" ? root : join(root, "novels", plan.folder)), "folder 必须在 root 内：" + plan.folder);
    assert.equal(plan.folder.includes(".."), false, "folder 不得含父目录段：" + plan.folder);
    for (const t of plan.targets) {
      // profile 是"从 state.json 里摘掉本书那一条键"的**非文件**目标（kind:"state"），
      // 位置本来就在书库根之外（插件全局设置），只摘键不搬文件——不在本断言范围内。
      if (t.kind === "state") continue;
      assert.ok(inside(root, t.path), "删除目标逃出书库根：" + t.key + " → " + t.path);
      assert.notEqual(t.path, victimDir, "删除目标不得指向库外受害者目录");
    }
  }

  // 无论如何，apply 都绝不能把库外目录搬走
  const before = readFileSync(join(victimDir, "库外机密.txt"), "utf8");
  await assert.rejects(() => bd.applyBookDelete({ root, book }), /没找到|无法删除/, "apply 应拒绝或判定无内容");
  assert.equal(existsSync(victimDir), true, "库外目录被移走了（路径穿越）");
  assert.equal(readFileSync(join(victimDir, "库外机密.txt"), "utf8"), before, "库外文件内容被改动了");
});

test("⑧-c v7.3.1（#47 姊妹漏洞）：回收站清单里的库外路径不得被 restore 搬回库外", async () => {
  const root = freshLib("restoretraverse");
  const stamp = "20260101-000000";
  const trashId = "evil-" + stamp;
  const entryDir = join(bd.trashDirPath(root), trashId);
  mkdirSync(entryDir, { recursive: true });
  // 库外的"落点"：修复前 restoreTrash 会按清单 from 原样 movePath 到这里
  const outsideVictim = join(ROOT, "pwned-" + libSeq, "payload.txt");
  mkdirSync(dirname(outsideVictim), { recursive: true });
  assert.equal(existsSync(outsideVictim), false);
  // 回收站里放一份真实存在的文件（清单说它"原本在库外"）
  writeFileSync(join(entryDir, "payload.txt"), "restored-outside", "utf8");
  const outsideDirVictim = join(ROOT, "pwned-dir-" + libSeq);
  writeFileSync(join(entryDir, "made-elsewhere"), "dir-restore-outside", "utf8");
  writeFileSync(join(entryDir, "manifest.json"), JSON.stringify({
    schema: bd.TRASH_SCHEMA,
    book: "越界书",
    rawBook: "越界书",
    safeBook: "越界书",
    root,
    createdAt: new Date().toISOString(),
    items: [
      { from: outsideVictim, to: join(entryDir, "payload.txt"), key: "data:analysis", files: 1, bytes: 15 },
      { from: outsideDirVictim, to: join(entryDir, "made-elsewhere"), key: "chapters", dir: true, files: 1, bytes: 18 }
    ],
    profile: null,
    files: 2,
    bytes: 33
  }, null, 2), "utf8");

  const out = await bd.restoreTrash({ root, trashId });
  assert.equal(out.restored, 0, "越界条目一个都不该恢复：" + JSON.stringify(out));
  assert.ok(out.failed.length >= 2, "越界条目必须逐条报失败：" + JSON.stringify(out.failed));
  assert.ok(out.failed.every((f) => f.error && f.error.length > 0), "失败项必须说明原因");
  assert.equal(existsSync(outsideVictim), false, "文件被搬到库外了（restore 路径穿越）");
  assert.equal(existsSync(outsideDirVictim), false, "目录被建到库外了（restore 路径穿越）");
  // 原内容还在回收站里，可手动处理——不能因为拒绝就丢掉数据
  assert.equal(existsSync(join(entryDir, "payload.txt")), true);
});

// ===========================================================================
// ⑧-d / ⑧-e v7.3.2（审查 N5 / N15）：符号链接边界 + 预览不得探库外
// ===========================================================================

test("⑧-d N5：根内指向库外的 junction/symlink 不得被删除或恢复穿过", async (t) => {
  const mkLink = (target, link) => {
    try {
      symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      return true;
    } catch {
      return false;
    }
  };

  // —— 删除侧：novels/创作资料 整个是指向库外的 junction ——
  // 词法上 `novels/创作资料/穿越书` 在书库根内，realpath 之后它在库外。
  const root = freshLib("junctions");
  const outside = join(ROOT, "junction-out-" + libSeq);
  mkdirSync(join(outside, "穿越书"), { recursive: true });
  writeFileSync(join(outside, "穿越书", "库外设定.md"), "outside-secret", "utf8");
  if (!mkLink(outside, join(root, "novels", "创作资料"))) {
    t.skip("本机无法创建 junction/symlink（权限策略），无法验证 N5");
    return;
  }
  const plan = await bd.planBookDelete({ root, book: "穿越书" });
  if (plan.blocked) {
    // 修复后的策略：边界解析出"逃出 novels/" → 拒绝执行
    await assert.rejects(() => bd.applyBookDelete({ root, book: "穿越书" }), /无法删除/);
  } else {
    // 若将来改成"允许但不动链接目标"，最低契约仍是库外内容不得被搬走
    await bd.applyBookDelete({ root, book: "穿越书" }).catch(() => {});
  }
  assert.equal(existsSync(join(outside, "穿越书", "库外设定.md")), true, "库外文件被删/被搬走了（删除穿过了 junction）");
  assert.equal(readFileSync(join(outside, "穿越书", "库外设定.md"), "utf8"), "outside-secret");

  // —— 恢复侧：根内 junction + 不存在的子路径 → 清单的 from 词法在根内、实际落到库外 ——
  const root2 = freshLib("junctionrestore");
  const outside2 = join(ROOT, "junction-restore-" + libSeq);
  mkdirSync(outside2, { recursive: true });
  const link2 = join(root2, "linkout");
  if (!mkLink(outside2, link2)) {
    t.skip("本机无法创建 junction/symlink（权限策略），无法验证 N5");
    return;
  }
  const trashId = "穿越书-20260101-000000";
  const entryDir = join(bd.trashDirPath(root2), trashId);
  mkdirSync(entryDir, { recursive: true });
  writeFileSync(join(entryDir, "payload.txt"), "should-stay-in-trash", "utf8");
  const escapeDest = join(link2, "write-through", "payload.txt");
  writeFileSync(join(entryDir, "manifest.json"), JSON.stringify({
    schema: bd.TRASH_SCHEMA,
    book: "穿越书",
    rawBook: "穿越书",
    safeBook: "穿越书",
    root: root2,
    createdAt: new Date().toISOString(),
    items: [{ from: escapeDest, to: join(entryDir, "payload.txt"), key: "data:analysis", files: 1, bytes: 19 }],
    profile: null,
    files: 1,
    bytes: 19
  }, null, 2), "utf8");
  const out = await bd.restoreTrash({ root: root2, trashId });
  assert.equal(out.restored, 0, "穿出库外的条目一个都不该恢复：" + JSON.stringify(out));
  assert.ok(out.failed.length >= 1 && out.failed.every((f) => f.error && f.error.length > 0), "越界条目必须逐条报失败：" + JSON.stringify(out.failed));
  assert.equal(existsSync(join(outside2, "write-through")), false, "恢复穿过了 junction，在库外写了文件");
  assert.equal(existsSync(join(entryDir, "payload.txt")), true, "拒绝恢复后数据必须留在回收站里");
});

test("⑧-e N15：书名含 ../ 时删除预览不得列出库外文件", async () => {
  const root = freshLib("legacytraverse");
  mkdirSync(join(root, ".novel-writer"), { recursive: true });
  const tag = "evil-" + libSeq;
  // `.novel-writer/x/../../../<tag>.json` 从数据目录出发正好落到 **ROOT**（书库根的父目录）
  const outsideFile = join(ROOT, tag + ".json");
  writeFileSync(outsideFile, "outside-secret", "utf8");
  const book = "x/../../../" + tag;

  const plan = await bd.planBookDelete({ root, book });
  assert.ok(!plan.items.includes(outsideFile), "删除预览列出了库外文件：" + outsideFile);
  for (const t of plan.targets) {
    if (t.kind === "state") continue; // 设定库条目不是文件目标（见 ⑧-b 的说明）
    assert.ok(inside(root, t.path), "删除预览的目标逃出书库根：" + t.key + " → " + t.path);
  }
  assert.equal(plan.targets.some((t) => t.key === "legacy"), false, "库外的旧位置伏笔表不该被列成清理项");
  // 预览不写盘：库外文件必须原样还在
  assert.equal(existsSync(outsideFile), true, "预览动了库外文件");
  assert.equal(readFileSync(outsideFile, "utf8"), "outside-secret");
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
  assert.equal(core.ALL_TOOLS.length, 22); // v7.3.0：21→22（novel_draft）
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

  const appliedManifest = JSON.parse(readFileSync(join(applied.trashDir, "manifest.json"), "utf8"));
  const restored = await def.execute({ action: "restore", trashId: applied.trashId }, {});
  check("restore", restored);
  assert.equal(restored.restored, appliedManifest.files, "恢复项数按文件数统计（#60）");

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
// ⑫ 单份报告删除（面板「报告历史」逐条删）—— 同样走回收站
// ===========================================================================

test("⑫ 单份报告删除：走回收站可恢复，非法文件名一律拒绝", async () => {
  const dataDir = join(toolRoot, ".novel-writer");
  mkdirSync(join(dataDir, "analysis"), { recursive: true });
  mkdirSync(join(dataDir, "style-reports"), { recursive: true });
  writeFileSync(join(dataDir, "analysis", "报告书-full.json"), "{}", "utf8");
  writeFileSync(join(dataDir, "style-reports", "报告书.json"), '{"judgment":"人工判断"}', "utf8");
  const route = routes.find((r) => r.path === "/api/dsh-novel-writer/reports");
  assert.ok(route, "报告路由必须已注册");
  const makeRes = () => ({ status: 0, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body; } });
  const makeReq = (body) => ({
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:51783" },
    method: "POST",
    url: "/api/dsh-novel-writer/reports",
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); }
  });
  // 非法文件名：带分隔符 / 非 .json / 空 / ..
  for (const bad of ["../x.json", "a/b.json", "x.txt", "", ".."]) {
    const r = makeRes();
    await route.handler(makeReq({ action: "forget", file: bad }), r);
    assert.equal(r.status, 400, "应拒绝文件名：" + JSON.stringify(bad));
  }
  // 未知 action / 不存在的报告
  {
    const r = makeRes();
    await route.handler(makeReq({ action: "nope", file: "报告书-full.json" }), r);
    assert.equal(r.status, 400);
  }
  {
    const r = makeRes();
    await route.handler(makeReq({ action: "forget", file: "查无.json" }), r);
    assert.equal(r.status, 404);
  }
  // 正常删除：移入回收站（不是 rm），只动指定的那一份
  const ok = makeRes();
  await route.handler(makeReq({ action: "forget", file: "报告书-full.json" }), ok);
  assert.equal(ok.status, 200, ok.body);
  const body = JSON.parse(ok.body);
  assert.equal(body.ok, true);
  assert.notEqual(body.trashId, "", "必须给出回收站条目 id");
  assert.equal(existsSync(join(dataDir, "analysis", "报告书-full.json")), false, "被删的文件应离开原位");
  assert.equal(existsSync(join(dataDir, "style-reports", "报告书.json")), true, "不应牵扯其它报告");
  const listed = await bd.listTrash({ root: toolRoot });
  const entry = listed.find((e) => e.book === "（报告历史）");
  assert.ok(entry, "回收站里应有一条报告条目，实际：" + JSON.stringify(listed.map((e) => e.book)));
  assert.equal(entry.restorable, true);
  // 可恢复：移回原路径
  const back = await bd.restoreTrash({ root: toolRoot, trashId: body.trashId });
  assert.equal(back.restored, 1);
  assert.equal(existsSync(join(dataDir, "analysis", "报告书-full.json")), true);
});

// ===========================================================================
// ⑪ 隔离守卫
// ===========================================================================

test("⑪ 隔离守卫：用户真实的 state.json 与 logs/ 全程未被改动", () => {
  assert.equal(digestFile(REAL_STATE), guardBefore.state, "真实 state.json 被改动了");
  assert.equal(digestDir(REAL_LOG_DIR), guardBefore.logs, "真实 logs/ 被改动了");
});
