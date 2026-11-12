/**
 * v6.8.0：回收站的**公共机制**（目录定位、条目名校验、清单结构、跨卷移动）。
 *
 * 为什么单独一层：现在有两类删除都该可恢复——① 按书删除（`lib/bookdelete.js`，整本书的所有资料）；
 * ② 单份报告文件的删除（面板「报告历史」逐条删，走 `lib/core.js` 的报告路由）。
 * 两处若各写一套「建目录 + 移动 + 写 manifest」，恢复端的格式迟早会分叉（这正是本项目最忌讳的那类
 * 口径漂移：能删得掉、但恢复不回来，或反之）。
 *
 * 依赖方向：本模块**只依赖 node 内置**（不 import core / bookdelete），调用方把 root 与 dataDir 传进来。
 * 这样 core.js（路由层）与 bookdelete.js（工具层）都能 import 它，而不产生循环导入。
 */

import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

/** 回收站清单的结构版本（将来改字段时据此兼容旧清单） */
export const TRASH_SCHEMA = 1;
/** 回收站目录名（在插件数据目录下，与 analysis/ plots/ 同级） */
export const TRASH_DIRNAME = "trash";

export function trashDirPathOf(dataDir) {
  return join(dataDir, TRASH_DIRNAME);
}

/** 回收站条目名：单段路径，不含分隔符/保留字符，且不能是 `.`/`..` */
export function isValidTrashId(id) {
  if (typeof id !== "string") return false;
  const v = id.trim();
  if (v === "" || v !== id) return false;
  if (/[\\/:*?"<>|]/.test(v)) return false;
  if (v.includes("..")) return false;
  if (v.startsWith(".")) return false;
  return true;
}

/** 时间戳：本地时间，`20261022-162358`（排序即时间序，便于在回收站目录里肉眼看） */
export function stampOf(date) {
  const d = date instanceof Date ? date : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

/**
 * 把 `relative()` 的结果归一成"可以安全拼进回收站目录"的相对路径。
 *
 * Windows 跨卷时 `relative("C:\\a", "D:\\b")` 会**原样返回绝对路径** `"D:\\b"`——
 * 拼成 `join(trashRoot, ...rel.split("/"))` 就是 `C:\trash\条目\D:\b`，冒号会让 mkdir 直接
 * 抛 EINVAL（#5）。所以这里逐段清洗：剥盘符、丢掉 `.`/`..` 与空段、把残余冒号换成下划线。
 *
 * 注意：调用方传进来的路径本来就该在 root 之内；`..` 段只有在"跨卷/越界"这种
 * 非预期输入下才可能出现，丢弃它（而不是保留）是**安全的那一侧**——绝不让相对路径逃出条目目录。
 */
export function normalizeRelPath(rel) {
  let out = String(rel ?? "").replace(/\\/g, "/");
  // 跨卷：relative 返回 "D:/data/x"（未剥盘符前）——先把盘符摘掉
  out = out.replace(/^[a-zA-Z]:\//, "");
  const parts = out
    .split("/")
    .map((segment) => segment.replace(/:/g, "_"))
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..");
  return parts.join("/");
}

/** 相对 root 的 POSIX 风格路径（回收站里按原结构复刻，恢复时不丢层级） */
export function relOf(root, p) {
  return normalizeRelPath(relative(root, p));
}

/** 移动（同卷 rename 瞬时；跨卷 EXDEV 时退化为复制+删除） */
export async function movePath(from, to) {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (e) {
    if (e?.code !== "EXDEV") throw e;
    await cp(from, to, { recursive: true, force: false, errorOnExist: true });
    await rm(from, { recursive: true, force: true });
  }
}

export function shortError(e) {
  return String(e?.code ?? "") + (e?.code ? " " : "") + String(e?.message ?? e).slice(0, 160);
}

/**
 * 把若干**文件路径**移入回收站并写清单（只用于"按文件删"，如单份报告）。
 *
 * - `label`：回收站条目里显示的名字（例如「（报告历史）」），让人知道这是哪类删除；
 * - `safeLabel`：条目名前缀，必须通过 `isValidTrashId`（调用方负责，这里是最后一道 assert）；
 * - 全部失败时删掉空条目、`trashId` 返回空串，不在列表里留垃圾。
 */
export async function movePathsToTrash({ root, dataDir, paths, label, safeLabel, now }) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === "string" && p !== "" && existsSync(p));
  if (list.length === 0) throw new Error("没有可移入回收站的文件（路径不存在或未提供）");
  const safe = String(safeLabel ?? "");
  if (!isValidTrashId(safe)) throw new Error("回收站条目名前缀非法：" + JSON.stringify(safe));

  const base = trashDirPathOf(dataDir);
  const stamp = stampOf(now);
  let trashId = safe + "-" + stamp;
  for (let n = 2; existsSync(join(base, trashId)); n += 1) trashId = safe + "-" + stamp + "-" + n;
  const trashRoot = join(base, trashId);
  try {
    await mkdir(trashRoot, { recursive: true });
  } catch (e) {
    throw new Error("无法创建回收站目录（" + trashRoot + "）：" + shortError(e) + "——为避免误删，未做任何改动");
  }

  const items = [];
  const failed = [];
  let files = 0;
  let bytes = 0;
  for (const from of list) {
    const to = join(trashRoot, ...relOf(root, from).split("/"));
    try {
      const s = await stat(from);
      await movePath(from, to);
      files += 1;
      bytes += s.size;
      items.push({ from, to, key: "file", files: 1, bytes: s.size });
    } catch (e) {
      failed.push({ path: from, code: String(e?.code ?? ""), error: shortError(e) });
    }
  }

  let trashIdOut = trashId;
  let trashDirOut = trashRoot;
  if (items.length === 0) {
    try { await rm(trashRoot, { recursive: true, force: true }); } catch { /* 留着也无害 */ }
    trashIdOut = "";
    trashDirOut = "";
  } else {
    // 清单最后写：崩溃时"已经搬走的东西"至少还躺在目录里
    const manifest = { schema: TRASH_SCHEMA, book: String(label ?? ""), rawBook: String(label ?? ""), safeBook: safe, root, createdAt: new Date().toISOString(), items, profile: null, files, bytes };
    try {
      await writeFile(join(trashRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    } catch (e) {
      failed.push({ path: join(trashRoot, "manifest.json"), code: String(e?.code ?? ""), error: "回收站清单写入失败（无法一键恢复，但文件确实在回收站目录里）：" + shortError(e) });
    }
  }
  return { trashId: trashIdOut, trashDir: trashDirOut, items, files, bytes, failed };
}

// v7.3.1 修（#48）：删除 `trashItemBasename(item)`（原本把清单条目的 `from` 取 basename，注释声称
// "报告删除后用于在界面上说清删了哪一份"）。全仓 Grep 只有定义行——没有任何界面或工具接线，
// 是纯导出面冗余。选"删"而不是"接线到界面"：回收站条目在面板里展示的是**条目名 + 文件数**，
// 文件名逐条列出会与上方 manifest 的 items 计数重复，接上去反而制造第二套展示口径；
// 真要看具体文件，读该条目的 manifest.json 更准确（且能拿到原路径）。
