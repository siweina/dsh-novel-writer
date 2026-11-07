/**
 * v7.0.1 回收站条目名 / 跨卷路径 / 恢复状态机 / MCP 写入与参数错误 回归套件。
 *
 * 覆盖源码审查报告中的 10 条：
 *   #2  MCP 单 chunk 2 秒超时 → 大报文自杀（超时放宽 + drain 重置 + 连续超时才致命）
 *   #3  书名含 `..` → 回收站条目永久孤立（trashId 规整；旧非法条目仍可见）
 *   #4  部分恢复后未回写 manifest → 二次恢复卡死（回写 items + profilePending）
 *   #5  跨盘符 relOf 拼出含盘符的非法路径（剥盘符 + 去 `..`/冒号）
 *   #6  MCP canonicalPath 抛裸 Error → -32603（改为参数错误 -32602）
 *   #10 清空回收站统计恒 0（渲染兼容扁平 files/bytes）
 *   #33 局部清理时 totals 取全量（只算选中项）
 *   #39 planBookDelete 缺 keys（plan 自带可清理 key 列表）
 *   #60 恢复项数口径分裂（统一按文件数）
 *   #61 listTrash 把普通文件当条目（withFileTypes 只收目录）
 *
 * 隔离：DSH_NOVEL_WRITER_STATE / DSH_HOME 指向临时目录；每个用例各自一个临时书库根。
 *
 * 运行：node test/trash-id-test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..");
const SERVER = join(PLUGIN_DIR, "mcp", "server.mjs");

// ===========================================================================
// 隔离夹具：先设 env，再动态 import
// ===========================================================================

const ROOT = join(tmpdir(), "dsh-trash-id-" + process.pid + "-" + Date.now().toString(36));
const STATE_DIR = join(ROOT, "state-dir");
const STATE = join(STATE_DIR, "state.json");
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(join(ROOT, "dsh-home"), { recursive: true });
process.env.DSH_NOVEL_WRITER_STATE = STATE;
process.env.DSH_HOME = join(ROOT, "dsh-home");
process.on("exit", () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

const bd = await import("../lib/bookdelete.js");
const trash = await import("../lib/trash.js");

// ===========================================================================
// 夹具构造
// ===========================================================================

let libSeq = 0;
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
 * 一批"多文件目录 + 单文件数据"的混合资料：
 * 章节正文 2 个文件、创作资料 2 个文件（整目录搬回时用来验证 #60 的按文件计数），
 * 数据目录 4 类各 1–2 个文件，另加旧位置伏笔表。
 */
function seedBook(root, book) {
  touch(root, "novels/" + book + "/第01章.md", book + " 第一章正文");
  touch(root, "novels/" + book + "/第02章.md", book + " 第二章正文");
  touch(root, "novels/创作资料/" + book + "/创作设定.md", book + " 设定");
  touch(root, "novels/创作资料/" + book + "/创作状态卡.md", book + " 状态卡");
  const D = ".novel-writer";
  touch(root, D + "/analysis/" + book + "-chapters-metrics.json", "{}");
  touch(root, D + "/analysis/" + book + "-keywords-aaaabbbbcccc.json", "{}");
  touch(root, D + "/audits/fix-plan-" + book + "-第01章.json", "{}");
  touch(root, D + "/style-reports/" + book + ".json", "{}");
  touch(root, D + "/summaries/" + book + ".json", "{}");
  touch(root, D + "/plots/" + book + ".json", "{}");
  touch(root, D + "/" + book + ".json", "{}"); // v0.8.0 前的伏笔表旧位置
}
function seedState(profiles) {
  writeFileSync(STATE, JSON.stringify({ enabled: true, creationProfiles: profiles }, null, 2), "utf8");
}
function readState() {
  return JSON.parse(readFileSync(STATE, "utf8"));
}

// ===========================================================================
// #5 跨盘符相对路径
// ===========================================================================

test("#5 relOf：跨卷 absolute 结果归一为安全相对路径", () => {
  // Windows 跨卷时 relative("C:\\a", "D:\\b") 返回 "D:\\b"——盘符冒号必须剥掉
  assert.equal(trash.normalizeRelPath("D:\\a\\b"), "a/b");
  assert.equal(trash.normalizeRelPath("D:/a/b"), "a/b");
  // 兜底：`..` 段不得逃出条目目录
  assert.equal(trash.normalizeRelPath("..\\..\\x"), "x");
  assert.equal(trash.normalizeRelPath("a\\..\\b"), "a/b");
  // 判据原样：把 relative() 在跨卷时返回的绝对路径喂进去，必须得到安全相对路径
  if (process.platform === "win32") {
    assert.equal(trash.relOf("C:\\lib", "D:\\a\\b"), "a/b", "跨卷 relative 结果必须剥盘符");
  }
  // 正常路径仍按原结构复刻
  const root = freshLib("rel");
  assert.equal(trash.relOf(root, join(root, "novels", "某书", "第01章.md")), "novels/某书/第01章.md");
  // 归一后的路径绝不含盘符冒号
  assert.ok(!trash.normalizeRelPath("D:\\data\\x").includes(":"));
});

test("#5 跨卷移动：movePathsToTrash 的目标路径不含盘符（用伪 relative 模拟）", async () => {
  // 直接验证"拼接目标"这一层：把 normalizeRelPath 的结果拼进回收站目录，不能出现 `D:` 段
  const root = freshLib("rel-move");
  const dataDir = join(root, ".novel-writer");
  const file = join(root, "novels", "某书", "第01章.md");
  touch(root, "novels/某书/第01章.md", "正文");
  const rel = trash.relOf(root, file);
  const dest = join(dataDir, "trash", "某书-20260101-000000", ...rel.split("/"));
  assert.ok(dest.includes(join("trash", "某书-20260101-000000", "novels", "某书", "第01章.md")));
  const moved = await trash.movePathsToTrash({ root, dataDir, paths: [file], label: "（测试）", safeLabel: "测试" });
  assert.equal(moved.failed.length, 0, JSON.stringify(moved.failed));
  assert.equal(existsSync(join(dataDir, "trash", moved.trashId, "novels", "某书", "第01章.md")), true);
  assert.ok(bd.isValidTrashId(moved.trashId));
});

// ===========================================================================
// #3 书名含 `..`
// ===========================================================================

test("#3 书名含连续点号：生成的 trashId 合法且 listTrash 能列出", async () => {
  const root = freshLib("dots");
  seedBook(root, "v1..2");
  seedState({});
  const result = await bd.applyBookDelete({ root, book: "v1..2" });
  assert.equal(bd.isValidTrashId(result.trashId), true, "trashId 必须通过 isValidTrashId：" + result.trashId);
  assert.ok(result.trashId.startsWith("v1_2-"), "连续点号应规整为下划线：" + result.trashId);
  const listed = await bd.listTrash({ root });
  const entry = listed.find((e) => e.id === result.trashId);
  assert.ok(entry, "回收站列表必须能看到该条目：" + JSON.stringify(listed.map((e) => e.id)));
  assert.equal(entry.restorable, true);
  // 恢复入口也应可用（旧版这里断言直接抛错）
  const back = await bd.restoreTrash({ root, trashId: result.trashId });
  assert.equal(back.restored, result.totals.files);
  assert.equal(existsSync(join(root, "novels", "v1..2", "第01章.md")), true);
});

test("#3 旧数据里的非法条目名仍被列出并说明原因（不静默隐藏）", async () => {
  const root = freshLib("legacy-id");
  const base = bd.trashDirPath(root);
  mkdirSync(base, { recursive: true });
  const legacyId = "v1..2-20260101-000000"; // 旧版本生成的非法条目名
  touch(root, ".novel-writer/trash/" + legacyId + "/novels/v1..2/第01章.md", "旧稿");
  writeFileSync(join(base, legacyId, "manifest.json"), JSON.stringify({
    schema: bd.TRASH_SCHEMA, book: "v1..2", safeBook: "v1..2", root,
    createdAt: "2026-01-01T00:00:00.000Z", items: [], files: 1, bytes: 6
  }), "utf8");
  const listed = await bd.listTrash({ root });
  const entry = listed.find((e) => e.id === legacyId);
  assert.ok(entry, "非法历史条目必须可见，实际：" + JSON.stringify(listed.map((e) => e.id)));
  assert.equal(entry.restorable, false, "非法条目名不能被宣称为可一键恢复");
  const text = bd.formatBookDelete({ action: "list", trash: listed });
  assert.ok(text.includes("条目名含非法字符"), "必须说明为什么不能恢复/删除：" + text);
});

// ===========================================================================
// #61 普通文件不是条目
// ===========================================================================

test("#61 listTrash 只收目录：回收站根下的普通文件被忽略", async () => {
  const root = freshLib("trash-file");
  const base = bd.trashDirPath(root);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "stray-file.txt"), "临时文件", "utf8");
  mkdirSync(join(base, "某书-20260101-000000"), { recursive: true });
  const listed = await bd.listTrash({ root });
  assert.ok(!listed.some((e) => e.id === "stray-file.txt"), "普通文件不应被当成回收站条目：" + JSON.stringify(listed));
  assert.ok(listed.some((e) => e.id === "某书-20260101-000000"), "没有清单的目录仍要列出来");
});

// ===========================================================================
// #4 部分恢复后回写 manifest
// ===========================================================================

test("#4 仅设定库条目冲突时回写 manifest，二次恢复不再把已恢复文件当新冲突", async () => {
  const root = freshLib("profile-blocked");
  seedBook(root, "卡书");
  seedState({ 卡书: { genre: "悬疑" } });
  const applied = await bd.applyBookDelete({ root, book: "卡书" });
  // 同名重开：设定库里又出现同名条目（它会被判冲突），但正文目录故意不重建
  seedState({ 卡书: { genre: "重开的新书" } });

  const first = await bd.restoreTrash({ root, trashId: applied.trashId });
  assert.equal(first.profileRestored, false);
  assert.ok(first.conflicts.some((c) => String(c).includes("设定库条目")), JSON.stringify(first.conflicts));
  // 文件都已经恢复，只剩设定库条目
  assert.equal(existsSync(join(root, "novels", "卡书", "第01章.md")), true);

  const manifest = JSON.parse(readFileSync(join(applied.trashDir, "manifest.json"), "utf8"));
  assert.equal(manifest.profilePending, true, "manifest 必须写明设定库条目仍未恢复：" + JSON.stringify(manifest));
  assert.deepEqual(manifest.items, [], "已恢复的文件必须从清单剔除：" + JSON.stringify(manifest.items));

  // 第二次恢复：不能把已恢复的文件当成"新冲突"
  const second = await bd.restoreTrash({ root, trashId: applied.trashId });
  assert.equal(second.restored, 0, "已恢复的文件不应再搬一次");
  assert.ok(!second.conflicts.some((c) => String(c).includes("第01章")), "已恢复文件不应再成为冲突：" + JSON.stringify(second.conflicts));
  assert.ok(second.conflicts.every((c) => String(c).includes("设定库条目")), JSON.stringify(second.conflicts));

  // 幂等：条目目录与文件都还在（设定库冲突没解决前不能整条删掉）
  assert.equal(existsSync(applied.trashDir), true);
  assert.deepEqual(readState().creationProfiles.卡书, { genre: "重开的新书" }, "绝不覆盖同名新条目");
});

// ===========================================================================
// #39 planBookDelete 自带 keys
// ===========================================================================

test("#39 planBookDelete 返回 keys，独立调用也能渲染出可选 key", async () => {
  const root = freshLib("plan-keys");
  seedBook(root, "键书");
  seedState({});
  const plan = await bd.planBookDelete({ root, book: "键书" });
  assert.ok(Array.isArray(plan.keys), "plan.keys 必须是数组");
  assert.ok(plan.keys.includes("chapters"), JSON.stringify(plan.keys));
  assert.ok(plan.keys.includes("data:analysis"), JSON.stringify(plan.keys));
  const text = bd.formatBookDelete({ ...plan, action: "preview" });
  assert.ok(!text.includes("key（）"), "预览不得渲染空括号：" + text.slice(-200));
  assert.ok(text.includes(plan.keys.join(" / ")), "预览必须列出可选 key：" + text.slice(-240));
});

// ===========================================================================
// #33 局部清理只统计选中项
// ===========================================================================

test("#33 只清 analysis 缓存时 totals 与「已清理」列表不含正文", async () => {
  const root = freshLib("partial");
  seedBook(root, "分书");
  seedState({ 分书: { genre: "悬疑" } });
  const plan = await bd.planBookDelete({ root, book: "分书" });
  const result = await bd.applyBookDelete({ root, book: "分书", keys: ["data:analysis"] });
  assert.equal(result.partial, true);
  assert.equal(result.totals.files, 2, "totals 只能算选中的 analysis 两个文件：" + JSON.stringify(result.totals));
  assert.ok(result.totals.files < plan.totals.files, "局部清理的 totals 不应等于全量");
  assert.deepEqual(result.targets.map((t) => t.key), ["data:analysis"], "已清理列表只应有选中项");
  const text = bd.formatBookDelete(result);
  const cleanedSection = text.slice(0, text.indexOf("不会动"));
  assert.ok(!cleanedSection.includes("章节正文"), "已清理段不得出现正文：" + cleanedSection);
  assert.ok(!cleanedSection.includes("正文"), "已清理段不得出现正文：" + cleanedSection);
  assert.ok(text.includes("按选择保留"), "保留项必须单独说明：" + text);
  // 幂等：同样 keys 再执行一次不会产生第二个回收站条目（该类内容已被清空 → 直接拒绝；
  // 目标类别整个消失时 selectTargets 报"未知位置"，仍存在但已空时报"至少要选中"）
  await assert.rejects(() => bd.applyBookDelete({ root, book: "分书", keys: ["data:analysis"] }), /未知位置|至少要选中/);
  assert.equal((await bd.listTrash({ root })).length, 1, "重复 apply 不得留下第二个回收站条目");
});

// ===========================================================================
// #10 清空回收站统计
// ===========================================================================

test("#10 purgeTrash 的扁平 files/bytes 能被渲染出来（不再恒 0）", async () => {
  const root = freshLib("purge-stats");
  seedBook(root, "清书");
  seedState({});
  const applied = await bd.applyBookDelete({ root, book: "清书" });
  const purged = await bd.purgeTrash({ root, trashId: applied.trashId });
  assert.ok(purged.files > 0);
  // 模拟"直接调用 purgeTrash 后渲染"（dispatch 会再包 totals，两条路径都要对）
  const text = bd.formatBookDelete({ action: "purge", trashId: applied.trashId, files: purged.files, bytes: purged.bytes });
  assert.ok(text.includes(purged.files + " 个文件"), "必须渲染真实文件数：" + text);
  assert.ok(!text.includes("已删除：0 个文件"), "旧版恒 0 的文案不得再出现：" + text);
  const textWithTotals = bd.formatBookDelete({ action: "purge", trashId: applied.trashId, totals: { files: purged.files, bytes: purged.bytes } });
  assert.ok(textWithTotals.includes(purged.files + " 个文件"), "totals 路径同样要正常：" + textWithTotals);
  // 幂等：条目已不存在，第二次 purge 必须报错且不产生任何新的副作用
  await assert.rejects(() => bd.purgeTrash({ root, trashId: applied.trashId }), /没有条目/);
  assert.deepEqual(await bd.listTrash({ root }), []);
});

// ===========================================================================
// #60 恢复项数按文件数
// ===========================================================================

test("#60 整目录搬回与逐文件合并统一按文件数统计，且重复恢复无第二次副作用", async () => {
  const root = freshLib("restore-count");
  seedBook(root, "数书");
  seedState({ 数书: { genre: "科幻" } });
  const applied = await bd.applyBookDelete({ root, book: "数书" });
  const manifest = JSON.parse(readFileSync(join(applied.trashDir, "manifest.json"), "utf8"));
  assert.notEqual(manifest.files, applied.moved, "夹具必须让「文件数」与「项数」不同，否则测不出口径分裂");
  const back = await bd.restoreTrash({ root, trashId: applied.trashId });
  assert.equal(back.restored, manifest.files, "恢复项数必须等于文件总数：" + back.restored + " != " + manifest.files);
  const text = bd.formatBookDelete({ action: "restore", book: "数书", restored: back.restored });
  assert.ok(text.includes(back.restored + " 个文件"), "恢复文案的单位必须是「个文件」：" + text);
  // 幂等：条目已清空，第二次恢复不得再动盘
  await assert.rejects(() => bd.restoreTrash({ root, trashId: applied.trashId }), /没有可用的清单/);
  assert.equal(existsSync(join(root, "novels", "数书", "第02章.md")), true);
});

// ===========================================================================
// #2 MCP 单 chunk 超时
// ===========================================================================

test("#2 超时常数放宽到 15–30s，drain 时重置，连续超时才致命", () => {
  const src = readFileSync(SERVER, "utf8");
  const match = /const OUTPUT_TIMEOUT_MS = (\d+);/.exec(src);
  assert.ok(match, "必须能找到 OUTPUT_TIMEOUT_MS 常量");
  const timeoutMs = Number(match[1]);
  assert.ok(timeoutMs >= 15000 && timeoutMs <= 30000, "OUTPUT_TIMEOUT_MS 应在 15–30s 之间，实际 " + timeoutMs);
  assert.match(src, /process\.stdout\.on\("drain"/, "必须在背压恢复（drain）时重置定时器");
  assert.match(src, /const MAX_WRITE_TIMEOUTS = \d+;/, "必须有「连续 N 次超时」上限");
  // 单次写入的超时分支只 reject（带 WRITE_TIMEOUT），不得直接 process.exit
  const timeoutCode = src.slice(src.indexOf("const arm = () =>"), src.indexOf("async function writeAndWait"));
  const armBody = timeoutCode.slice(0, timeoutCode.indexOf("const onDrain"));
  assert.ok(timeoutCode.includes("WRITE_TIMEOUT"), "超时错误必须带可识别的 code");
  assert.ok(!armBody.includes("process.exit"), "单 chunk 超时不得直接 process.exit");
  assert.match(armBody, /clearTimeout\(timer\)/, "重置计时必须 clearTimeout 旧定时器");
  assert.match(armBody, /timer = setTimeout\(/, "重置计时必须重新 setTimeout");
});

/**
 * 行为回归（Windows 专用，避免依赖其他平台管道缓冲区的具体大小）：
 * 旧版 2 秒超时会在客户端停读 4 秒时把进程杀掉；新版应活下来并在客户端恢复读取后
 * 把大报文完整送达。
 */
test("#2 大报文写入：客户端停读 4s 后恢复，进程不自杀且响应完整", { skip: process.platform !== "win32", timeout: 40000 }, async () => {
  const pluginDir = join(ROOT, "big-plugin");
  mkdirSync(join(pluginDir, "lib"), { recursive: true });
  mkdirSync(join(pluginDir, "mcp"), { recursive: true });
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "big-test", version: "1.0.0", type: "module" }));
  writeFileSync(join(pluginDir, "mcp", "server.mjs"), readFileSync(SERVER));
  writeFileSync(join(pluginDir, "lib", "index.js"), `
export async function apply(ctx) {
  ctx.tools.register({
    name: "novel_big", description: "big", parameters: { type: "object", properties: {} },
    execute() { return "x".repeat(6 * 1024 * 1024); }
  });
}
`);
  const child = spawn(process.execPath, [join(pluginDir, "mcp", "server.mjs"), "--root", ROOT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DSH_NOVEL_WRITER_STATE: STATE }
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  const exitPromise = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  let buffer = Buffer.alloc(0);
  let bigResponse = null;
  let exited = null;
  exitPromise.then((value) => { exited = value; });

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let newline;
    while ((newline = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, newline).toString("utf8");
      buffer = buffer.subarray(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === 1) {
        // initialize 完成后发大请求，然后立刻暂停读取，让 stdout 进入背压
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "novel_big", arguments: {} } }) + "\n");
        child.stdout.pause();
        setTimeout(() => child.stdout.resume(), 4000);
      } else if (message.id === 2) {
        bigResponse = message;
      }
    }
  };
  child.stdout.on("data", onData);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\n");

  // 等大响应（最长 30s）
  const deadline = Date.now() + 30000;
  while (bigResponse === null && Date.now() < deadline && exited === null) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.stdin.end();
  await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 8000))]);
  if (exited === null) child.kill("SIGKILL");

  assert.ok(bigResponse !== null, "大报文必须送达（旧版 2s 超时会先杀掉进程）。stderr=" + stderr.join("").slice(0, 300));
  assert.equal(bigResponse.result?.isError, undefined, "大工具调用应正常返回：" + JSON.stringify(bigResponse).slice(0, 160));
  assert.ok(String(bigResponse.result?.content?.[0]?.text ?? "").length >= 6 * 1024 * 1024, "响应文本长度应完整");
  assert.ok(!stderr.join("").includes("关闭连接"), "不应因写入超时关闭连接：" + stderr.join("").slice(0, 200));
});

// ===========================================================================
// #6 MCP 参数错误：不存在的盘符
// ===========================================================================

function runServerCall({ serverPath = SERVER, args = [], callArguments, timeout = 20000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DSH_NOVEL_WRITER_STATE: STATE }
    });
    const stdout = [];
    const stderr = [];
    let buffer = Buffer.alloc(0);
    let response = null;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("等待响应超时。stderr=" + stderr.join("").slice(0, 400)));
    }, timeout);
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while ((newline = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        stdout.push(line);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "novel_books", arguments: callArguments } }) + "\n");
        } else if (message.id === 2) {
          response = message;
          clearTimeout(timer);
          child.stdin.end();
          resolve(message);
        }
      }
    });
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("exit", () => {
      if (response === null) {
        clearTimeout(timer);
        reject(new Error("进程已退出但没有响应。stdout=" + stdout.join(" | ").slice(0, 400) + " stderr=" + stderr.join("").slice(0, 400)));
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\n");
  });
}

test("#6 调用方传不存在的盘符根目录 → -32602 参数错误（不是 -32603）", { skip: process.platform !== "win32", timeout: 30000 }, async () => {
  const root = freshLib("mcp-param");
  const response = await runServerCall({ args: ["--root", root], callArguments: { root: "Z:\\novels" } });
  assert.equal(response.error?.code, -32602, "必须是参数错误，实际：" + JSON.stringify(response.error ?? response.result));
  assert.ok(String(response.error?.message ?? "").includes("无效参数"), String(response.error?.message));
  assert.equal(response.result, undefined, "不得再走工具执行错误路径");
});

test("#6 服务器 --root 本身指向不存在的盘符时同样返回 -32602", { skip: process.platform !== "win32", timeout: 30000 }, async () => {
  const response = await runServerCall({ args: ["--root", "Z:\\novels"], callArguments: {} });
  assert.equal(response.error?.code, -32602, JSON.stringify(response.error ?? response.result));
});
