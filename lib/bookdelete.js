/**
 * v6.8.0：**按书删除**（整本书 + 全部关联资料 + 回收站）。
 *
 * 起因是 issue #2：用户放弃一本书 / 删测试项目 / 想用同名重开时，发现「删不干净」——
 * 只删 `novels/<书>` 会留下一堆关联资料，而面板里的「删除设定」只是移除 `创作设定.md`
 * 里的一段，不是删书。他就得自己翻多个目录逐项清理，容易漏，多本书并存时还怕误删别的书。
 *
 * ## 这个模块存在的理由：**按书命名的文件不止一种写法**
 *
 * 真实盘面上的命名（v6.8.0 实测）：
 * ```
 * analysis/      <书>-chapters-metrics.json   <书>-full.json   <书>-<hash16>.json
 *                <书>-keywords-<hash12>.json  <书>__base-full.json
 * embedding/     <书>.json   <书>__styleproto.json   <书>__style_2.json   <书>__style_第02章.md.json
 * audits/        <书>-<hash16>.json      fix-plan-<书>-第01章.json     ← 前缀不是书名
 * baseline/      <书>.json
 * lexicon/       <书>.json  +  _global.json（全局，绝不能删）
 * plots/         <书>.json
 * settings/      <书>.json
 * style-reports/ <书>.json
 * summaries/     <书>.json
 * .novel-writer/<书>.json                ← v0.8.0 前的伏笔表旧位置（legacyPlotsFile）
 * ```
 * 所以「删 `<书>.json`」一定漏 ✗。本模块用**前缀 + 分隔符边界**匹配（`isBookScopedName`）：
 * 文件名以书名开头、且紧跟的字符是 `.` / `-` / `_` 或到此结束。这条边界规则是承重的——
 * 少了它，删《孤舟》会顺手删掉《孤舟子》的资料 ✗。
 *
 * ## 为什么默认是「移入回收站」而不是真删
 *
 * 删书是**不可撤销的破坏性操作**，而这里最典型的用户误操作恰好是「删错了书」和
 * 「想重开却把旧稿删了」。所以默认把内容**移进** `<root>/.novel-writer/trash/<书>-<时间戳>/`
 * （同卷 rename，瞬时、不占双份空间），并写一份 `manifest.json` 记录每一项的原路径，
 * 于是 `restore` 能原样移回去。真要省空间时再用 `purge` 彻底删掉某个回收站条目。
 *
 * 注意：移到回收站**不释放磁盘空间**（这正是"还能恢复"的代价）。`.novel-writer` 的体积会照常变大，
 * 这是诚实的——字节确实还在盘上。
 *
 * ## 只处理所选书籍
 *
 * 全局词表 `lexicon/_global.json`、插件设置 `state.json` 里的开关/容差/提示词档位、
 * 事件日志、其他书的按书文件——一律不动（结果里的 `notTouched` 会把这些逐条说明）。
 */

import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  CREATION_DIR,
  GLOBAL_LEXICON_BOOK,
  assert,
  novelDataDir,
  novelsDir,
  readSentenceState,
  sanitizeSegment,
  stateFilePath,
  writeSentenceState
} from "./core.js";
import { logEvent } from "./log.js";

/** 回收站清单的结构版本（将来改字段时据此兼容旧清单） */
export const TRASH_SCHEMA = 1;
/** 回收站目录名（在插件数据目录下，与 analysis/ plots/ 同级） */
export const TRASH_DIRNAME = "trash";

/**
 * 数据目录下**按书存放**的子目录白名单。
 * 为什么不直接遍历数据目录：`trash/` 与将来可能出现的其他目录不该被当成"书的资料"，
 * 白名单同时充当"新子目录必须先登记"的提醒（漏登记＝漏删，测试里有断言盯着）。
 */
export const DELETE_DATA_SUBDIRS = Object.freeze([
  "analysis", "audits", "baseline", "embedding", "lexicon", "plots", "settings", "style-reports", "summaries"
]);

const SUBDIR_LABELS = Object.freeze({
  analysis: "分析缓存",
  audits: "改稿/审计报告",
  baseline: "风格基线",
  embedding: "语义索引缓存",
  lexicon: "必用词表（本书）",
  plots: "伏笔登记",
  settings: "设定表",
  "style-reports": "风格画像",
  summaries: "章节摘要"
});

export function trashDirPath(root) {
  return join(novelDataDir(root), TRASH_DIRNAME);
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

function trashEntryPath(root, trashId) {
  assert(isValidTrashId(trashId), "参数 \"trashId\" 非法：只接受回收站条目名（单段、不含路径分隔符）");
  const base = resolve(trashDirPath(root));
  const target = resolve(base, trashId);
  // 纵深防御：校验通过后仍确认解析结果确实在回收站目录内（`..` 已被上面拦住，这里再兜一层）
  assert(target.startsWith(base + sep), "参数 \"trashId\" 非法：解析后不在回收站目录内");
  return target;
}

/**
 * 文件名是否属于这本书。`keys` 里可以有多个等价写法（原始书名 / 盘上目录名 / 清洗名）——
 * 因为插件各处落盘用的写法并不统一：`audits/` 用的是**原始** book，其余多用 `sanitizeSegment`。
 */
export function isBookScopedName(name, keys) {
  if (typeof name !== "string" || name === "") return false;
  for (const key of keys) {
    if (typeof key !== "string" || key === "") continue;
    if (name === key) return true;
    if (name.startsWith(key)) {
      const next = name.charAt(key.length);
      // 边界：`.json` / `-<hash>` / `__style`；**不是**「任何字符都算」——否则《孤舟》会吃掉《孤舟子》
      if (next === "." || next === "-" || next === "_") return true;
    }
    // audits/ 的改稿台报告前缀是 fix-plan-（fixplan.js），书名在中间
    if (name.startsWith("fix-plan-" + key + "-")) return true;
  }
  return false;
}

/** 保留书名：这些名字与插件自己的文件/目录撞名，删除会误伤，直接拒绝 */
function blockReasonFor(rawBook, safeBook) {
  if (safeBook === GLOBAL_LEXICON_BOOK) {
    return "书名与全局词表文件同名（" + GLOBAL_LEXICON_BOOK + "）：删除会连带清掉全局词表，请先改名再删";
  }
  if (rawBook === CREATION_DIR || safeBook === CREATION_DIR) {
    return "「" + CREATION_DIR + "」是插件的保留目录（创作资料容器），不能当作书名删除";
  }
  if (rawBook.startsWith(".") || safeBook.startsWith(".")) {
    return "点号开头的目录是插件/系统的保留位置，不作为作品删除";
  }
  return "";
}

/** novels/ 下真实存在的作品目录名（不含 创作资料 与点号目录） */
async function listBookFolderNames(root) {
  try {
    const entries = await readdir(novelsDir(root), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== CREATION_DIR)
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 把用户给的书名解析到盘上真实的目录名。
 * 为什么要这一步：书可能是用带非法字符的名字建的（落盘时被 `sanitizeSegment` 洗过），
 * 用户复述时又常常用清洗后的名字。两种写法都要能定位到同一本书，否则「预览说没找到」而书明明在。
 */
export async function resolveBookFolder(root, book) {
  const safe = sanitizeSegment(book, "book");
  const names = await listBookFolderNames(root);
  if (names.includes(book)) return book;
  for (const name of names) {
    let ok = false;
    try { ok = sanitizeSegment(name, "book") === safe; } catch { ok = false; }
    if (ok) return name;
  }
  return book;
}

/** 统计一个路径（文件或目录）的文件数与字节数，顺带取几个文件名做展示样例 */
async function pathSize(p) {
  const out = { files: 0, bytes: 0, sample: [] };
  let st;
  try { st = await stat(p); } catch { return out; }
  if (st.isFile()) {
    out.files = 1;
    out.bytes = st.size;
    out.sample.push(basename(p));
    return out;
  }
  if (!st.isDirectory()) return out;
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) continue;
      try {
        const s = await stat(full);
        out.files += 1;
        out.bytes += s.size;
        if (out.sample.length < 4) out.sample.push(entry.name);
      } catch { /* 单个文件 stat 失败跳过，不整次归零 */ }
    }
  }
  await walk(p);
  return out;
}

function relOf(root, p) {
  return relative(root, p).split(sep).join("/");
}

/**
 * 预览：把「删这本书会动到哪些位置」算清楚，**不写盘**。
 *
 * 返回的 `targets` 就是要给用户看的那份清单：一处一行（位置 / 文件数 / 体积 / 样例文件名）。
 * `kind` 决定执行方式：`dir` = 整个目录移走；`files` = 只移走匹配到的文件（目录留着）；
 * `state` = 只从 `state.json` 里摘掉该书的设定库条目。
 */
export async function planBookDelete({ root, book }) {
  const rawBook = String(book ?? "").trim();
  assert(rawBook !== "", "参数 \"book\" 不能为空字符串");
  const safeBook = sanitizeSegment(rawBook, "book");
  const blockedReason = blockReasonFor(rawBook, safeBook);
  const folder = await resolveBookFolder(root, rawBook);
  const keys = [...new Set([rawBook, folder, safeBook].filter((k) => typeof k === "string" && k !== ""))];
  const warnings = [];
  const targets = [];

  // ① 章节正文（novels/<书>/）
  const chapterDir = join(novelsDir(root), folder);
  if (existsSync(chapterDir)) {
    const size = await pathSize(chapterDir);
    targets.push({ key: "chapters", label: "章节正文", kind: "dir", path: chapterDir, exists: true, items: [chapterDir], files: size.files, bytes: size.bytes, sample: size.sample });
  } else {
    targets.push({ key: "chapters", label: "章节正文", kind: "dir", path: chapterDir, exists: false, items: [], files: 0, bytes: 0, sample: [] });
  }

  // ② 创作资料（novels/创作资料/<书>/：创作设定/主要人物/次要人物/剧情大纲/钩子记录/创作状态卡）
  const creationBookDir = join(novelsDir(root), CREATION_DIR, folder);
  if (existsSync(creationBookDir)) {
    const size = await pathSize(creationBookDir);
    targets.push({ key: "creation", label: "创作资料", kind: "dir", path: creationBookDir, exists: true, items: [creationBookDir], files: size.files, bytes: size.bytes, sample: size.sample });
  } else {
    targets.push({ key: "creation", label: "创作资料", kind: "dir", path: creationBookDir, exists: false, items: [], files: 0, bytes: 0, sample: [] });
  }

  // ③ 数据目录里按书存放的文件（9 个子目录，逐个按前缀+边界过滤）
  const dataDir = novelDataDir(root);
  for (const sub of DELETE_DATA_SUBDIRS) {
    const dir = join(dataDir, sub);
    let names;
    try { names = await readdir(dir); } catch { continue; } // 目录不存在＝这本书没有这类资料，正常
    const hits = names.filter((name) => isBookScopedName(name, keys)).sort();
    if (hits.length === 0) continue;
    let files = 0;
    let bytes = 0;
    const items = [];
    const sample = [];
    for (const name of hits) {
      const full = join(dir, name);
      try {
        const s = await stat(full);
        if (!s.isFile()) continue;
        files += 1;
        bytes += s.size;
        items.push(full);
        if (sample.length < 4) sample.push(name);
      } catch { /* 读不到就跳过——预览不该因为一个坏文件而整份失败 */ }
    }
    if (files === 0) continue;
    targets.push({ key: "data:" + sub, label: SUBDIR_LABELS[sub] ?? sub, kind: "files", path: dir, exists: true, items, files, bytes, sample });
  }

  // ③b 旧位置伏笔表：v0.8.0 之前写在数据目录**根**上的 `<书>.json`（legacyPlotsFile）。
  // 现有书大多已迁移到 plots/，但"从没读过伏笔表"的书可能还留着，不处理就等于漏删。
  const legacyUnique = [...new Set(keys.map((key) => join(dataDir, key + ".json")).filter((f) => existsSync(f)))];
  if (legacyUnique.length > 0) {
    let files = 0;
    let bytes = 0;
    for (const f of legacyUnique) {
      try { const s = await stat(f); files += 1; bytes += s.size; } catch { /* ignore */ }
    }
    targets.push({ key: "legacy", label: "旧位置伏笔表", kind: "files", path: dataDir, exists: true, items: legacyUnique, files, bytes, sample: legacyUnique.map((f) => basename(f)) });
  }

  // ④ 设定库里的本书条目（存在 state.json 的 creationProfiles 里，是本模块唯一会写"插件设置"的地方——
  //    只摘掉这一本书的键，其余开关/容差/提示词档位与其他书的条目一律保留）
  const state = await readSentenceState();
  const profiles = state?.creationProfiles && typeof state.creationProfiles === "object" ? state.creationProfiles : {};
  const profileKey = [rawBook, folder, safeBook].find((k) => Object.prototype.hasOwnProperty.call(profiles, k)) ?? "";
  targets.push({
    key: "profile",
    label: "设定库条目（仅本书）",
    kind: "state",
    path: stateFilePath(),
    exists: profileKey !== "",
    items: [],
    files: profileKey === "" ? 0 : 1,
    bytes: 0,
    sample: profileKey === "" ? [] : ["原创模式 · " + profileKey]
  });

  // 同名清洗冲突：两本书的清洗名相同 → 它们的按书文件本来就共用一个文件名，删一本必然带走另一本的
  const siblings = (await listBookFolderNames(root)).filter((name) => {
    if (name === folder) return false;
    try { return sanitizeSegment(name, "book") === safeBook; } catch { return false; }
  });
  if (siblings.length > 0) {
    warnings.push("另有作品与本书的清洗名相同（" + siblings.join("、") + "）：插件按清洗后的名字落盘，两者的数据文件本来就是共用的，删除会一并清掉");
  }
  if (folder !== rawBook) {
    warnings.push("参数书名已被清洗为「" + folder + "」（原样为「" + rawBook + "」）：路径兼容非法字符，实际匹配按清洗后的写法");
  }
  if (!existsSync(chapterDir) && targets.some((t) => t.exists && t.key !== "chapters")) {
    warnings.push("本书没有正文目录（novels/" + folder + " 不存在），只会清理关联资料");
  }
  if (profileKey !== "" && profileKey !== rawBook) {
    warnings.push("设定库里的条目名是「" + profileKey + "」（与参数书名写法不同），按条目名删除");
  }

  const totals = targets.reduce((acc, t) => { acc.files += t.files; acc.bytes += t.bytes; return acc; }, { files: 0, bytes: 0 });
  const found = targets.some((t) => t.exists && (t.files > 0 || t.kind === "state"));

  return {
    book: folder,
    rawBook,
    safeBook,
    folder,
    root,
    blocked: blockedReason !== "",
    blockedReason,
    found,
    targets: targets.map((t) => ({ key: t.key, label: t.label, kind: t.kind, path: t.path, rel: relOf(root, t.path), exists: t.exists, files: t.files, bytes: t.bytes, sample: t.sample })),
    items: targets.reduce((acc, t) => acc.concat(t.items), []),
    profileKey,
    totals,
    warnings,
    notTouched: [
      "全局词表（.novel-writer/lexicon/" + GLOBAL_LEXICON_BOOK + ".json）",
      "插件通用设置（state.json 里的开关 / 容差 / 提示词档位 / 其他书条目）",
      "事件日志（与 state.json 同级的 logs/）",
      "其他书的正文与资料"
    ]
  };
}

/** 时间戳：本地时间，`20261022-162358`（排序即时间序，便于在回收站目录里肉眼看） */
function stampOf(date) {
  const d = date instanceof Date ? date : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

/** 移动（同卷 rename 瞬时；跨卷 EXDEV 时退化为复制+删除） */
async function movePath(from, to) {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (e) {
    if (e?.code !== "EXDEV") throw e;
    await cp(from, to, { recursive: true, force: false, errorOnExist: true });
    await rm(from, { recursive: true, force: true });
  }
}

function shortError(e) {
  return String(e?.code ?? "") + (e?.code ? " " : "") + String(e?.message ?? e).slice(0, 160);
}

/**
 * 执行删除：把预览清单里的每一项**移入回收站**（默认），并写 `manifest.json` 供恢复。
 *
 * 局部失败不中断：某一项移不动（被占用、权限）就记进 `failed` 继续下一项——
 * 半途整体中止会让用户既不知道删了什么、也无法恢复。
 */
export async function applyBookDelete({ root, book, plan: givenPlan, now }) {
  const plan = givenPlan && givenPlan.folder ? givenPlan : await planBookDelete({ root, book });
  if (plan.blocked) throw new Error("无法删除《" + plan.book + "》：" + plan.blockedReason);
  if (!plan.found) {
    throw new Error("没找到《" + plan.book + "》的任何内容（正文目录、创作资料与数据目录里的按书文件都不存在）——请先用 novel_books 确认书名");
  }

  const trashBase = trashDirPath(root);
  const stamp = stampOf(now);
  let trashId = plan.safeBook + "-" + stamp;
  for (let n = 2; existsSync(join(trashBase, trashId)); n += 1) trashId = plan.safeBook + "-" + stamp + "-" + n;
  const trashRoot = join(trashBase, trashId);

  const failed = [];
  const items = [];
  let moved = 0;
  let files = 0;
  let bytes = 0;

  try {
    await mkdir(trashRoot, { recursive: true });
  } catch (e) {
    throw new Error("无法创建回收站目录（" + trashRoot + "）：" + shortError(e) + "——为避免误删，未做任何改动");
  }

  for (const target of plan.targets) {
    // 设定库条目不是文件，下面单独处理
    if (target.kind === "state") continue;
    if (!target.exists || target.files === 0) continue;
    // 按目标分组取回绝对路径（`items` 是扁平数组，`path` 是它所属的目录 / 目录本身）
    const paths = plan.items.filter((p) => (target.kind === "dir" ? p === target.path : dirname(p) === target.path));
    for (const from of paths) {
      const rel = relOf(root, from);
      const to = join(trashRoot, ...rel.split("/"));
      try {
        if (target.kind === "dir") {
          // 目录整块搬走；体积沿用预览时的统计（移动不改变大小）
          await movePath(from, to);
          moved += 1;
          files += target.files;
          bytes += target.bytes;
          // `dir: true` 让恢复端知道"这是整目录搬的"，从而在目标目录已被重建时逐文件合并恢复
          items.push({ from, to, key: target.key, dir: true, files: target.files, bytes: target.bytes });
        } else {
          const s = await stat(from);
          await movePath(from, to);
          moved += 1;
          files += 1;
          bytes += s.size;
          items.push({ from, to, key: target.key, files: 1, bytes: s.size });
        }
      } catch (e) {
        failed.push({ path: from, code: String(e?.code ?? ""), error: shortError(e) });
      }
    }
  }

  // 设定库条目：先**只读**取到快照（此时还不改 state），把它一起写进清单——
  // 顺序很关键：清单若在摘除条目之后才写、又写失败，那份条目备份就永久丢了（文件还能手动移回，
  // 设定库条目没有别的副本）。所以：搬文件 → 写清单 → 才真正改 state。
  let profileBackup = null;
  if (plan.profileKey !== "") {
    try {
      const state = await readSentenceState();
      const value = state?.creationProfiles?.[plan.profileKey];
      if (value !== void 0) profileBackup = { key: plan.profileKey, value };
    } catch (e) {
      failed.push({ path: stateFilePath(), code: String(e?.code ?? ""), error: "读取设定库条目失败（该书条目保持原样）：" + shortError(e) });
    }
  }

  // 清单在移动之后写（崩溃时至少"已经搬走的东西"能被恢复），但**在改 state 之前**写（见上）
  let manifestWritten = true;
  const manifest = { schema: TRASH_SCHEMA, book: plan.book, rawBook: plan.rawBook, safeBook: plan.safeBook, root, createdAt: new Date().toISOString(), items, profile: profileBackup, files, bytes };
  try {
    await writeFile(join(trashRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  } catch (e) {
    manifestWritten = false;
    failed.push({ path: join(trashRoot, "manifest.json"), code: String(e?.code ?? ""), error: "回收站清单写入失败（无法一键恢复，但文件确实在回收站目录里）：" + shortError(e) });
  }

  // 设定库条目：只摘掉本书那一条（writeSentenceState 的 patch 语义：值为 null 的键会被删掉）
  let profileRemoved = false;
  if (profileBackup !== null) {
    try {
      await writeSentenceState({ creationProfiles: { [profileBackup.key]: null } });
      profileRemoved = true;
    } catch (e) {
      failed.push({ path: stateFilePath(), code: String(e?.code ?? ""), error: "设定库条目移除失败：" + shortError(e) });
    }
  }

  // 全部失败（一项都没搬走、条目也没摘）→ 删掉空回收站目录，别在列表里留一个空条目
  let trashDirOut = trashRoot;
  let trashIdOut = trashId;
  if (moved === 0 && !profileRemoved) {
    try { await rm(trashRoot, { recursive: true, force: true }); } catch { /* 留着也无害 */ }
    trashDirOut = "";
    trashIdOut = "";
  }

  // 复核：再扫一遍，看还有什么留着（被占用的文件会留在这里，必须如实报告）
  const after = await planBookDelete({ root, book: plan.folder });
  const remaining = { files: after.totals.files, bytes: after.totals.bytes };

  const warnings = [...plan.warnings];
  if (!manifestWritten) warnings.push("回收站清单没写成：文件已在回收站目录里，但无法用 restore 一键恢复，需手动移回");
  if (failed.length > 0) warnings.push("有 " + failed.length + " 项没搬动（多半是被其他程序占用或没有权限），逐条见下方失败项");
  if (remaining.files > 0) warnings.push("清理后仍有 " + remaining.files + " 个文件残留，可用 action=preview 复查具体位置");

  const result = {
    action: "apply",
    book: plan.book,
    safeBook: plan.safeBook,
    found: plan.found,
    blocked: plan.blocked,
    blockedReason: plan.blockedReason,
    targets: plan.targets.map((t) => ({ key: t.key, label: t.label, kind: t.kind, path: t.path, rel: t.rel, exists: t.exists, files: t.files, bytes: t.bytes, sample: t.sample })),
    totals: plan.totals,
    warnings,
    notTouched: plan.notTouched,
    trash: [],
    trashId: trashIdOut,
    trashDir: trashDirOut,
    moved,
    profileRemoved,
    profileRestored: false,
    failed,
    remaining,
    restored: 0,
    conflicts: [],
    purged: false,
    message: ""
  };
  result.message = moved === 0 && !profileRemoved
    ? "《" + plan.book + "》没有移动任何内容（见失败项）"
    : "已将《" + plan.book + "》的 " + moved + " 项（" + files + " 个文件 / " + bytes + " 字节）移入回收站" + (profileRemoved ? "，并移除设定库条目" : "");
  logEvent("config", {
    book: plan.book,
    action: "delete_apply",
    files,
    bytes,
    count: moved,
    path: trashDirOut,
    failures: failed.length,
    level: failed.length > 0 ? "warn" : "info",
    detail: result.message
  });
  return result;
}

/** 列出回收站条目（新→旧） */
export async function listTrash({ root }) {
  const base = trashDirPath(root);
  let names = [];
  try { names = await readdir(base); } catch { return []; }
  const entries = [];
  for (const name of names) {
    if (!isValidTrashId(name)) continue;
    const dir = join(base, name);
    let manifest = null;
    try { manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")); } catch { manifest = null; }
    if (manifest) {
      entries.push({
        id: name,
        book: String(manifest.book ?? ""),
        createdAt: String(manifest.createdAt ?? ""),
        files: Number(manifest.files ?? 0) || 0,
        bytes: Number(manifest.bytes ?? 0) || 0,
        items: Array.isArray(manifest.items) ? manifest.items.length : 0,
        restorable: true,
        path: dir
      });
      continue;
    }
    // 没有清单（清单写失败 / 手动塞进来的目录）：仍要列出来，但明确说不能一键恢复
    const size = await pathSize(dir);
    let mtime = "";
    try { mtime = (await stat(dir)).mtime.toISOString(); } catch { /* ignore */ }
    entries.push({ id: name, book: "", createdAt: mtime, files: size.files, bytes: size.bytes, items: 0, restorable: false, path: dir });
  }
  entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return entries;
}

/** 从回收站恢复一个条目：逐项移回原路径；目标已存在视为冲突，绝不覆盖 */
export async function restoreTrash({ root, trashId }) {
  const dir = trashEntryPath(root, trashId);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  } catch (e) {
    throw new Error("回收站条目「" + trashId + "」没有可用的清单（manifest.json），无法一键恢复——请手动把该目录里的文件移回原位：" + dir);
  }
  const all = Array.isArray(manifest.items) ? manifest.items : [];
  const stillThere = [];
  const conflicts = [];
  const failed = [];
  let restored = 0;
  /**
   * 整目录搬走的项，在**目标目录已被重建**时（同名重开是最常见的场景）不能整块跳过——
   * 那会让用户"点了恢复，什么都没回来"。改为在目录内**逐文件**恢复：能回的都回，
   * 只有同名文件才跳过并报告，绝不覆盖新内容。
   */
  const restoreDir = async (item) => {
    const fromDir = String(item.from ?? "");
    const toDir = String(item.to ?? "");
    if (!existsSync(toDir)) return true;
    let left = 0;
    const walk = async (dir) => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { left += 1; return; }
      for (const entry of entries) {
        const src = join(dir, entry.name);
        const rel = relative(toDir, src);
        if (entry.isDirectory()) { await walk(src); continue; }
        if (!entry.isFile()) continue;
        const dest = join(fromDir, rel);
        if (existsSync(dest)) { conflicts.push(dest); left += 1; continue; }
        try {
          await movePath(src, dest);
          restored += 1;
        } catch (e) {
          failed.push({ path: dest, code: String(e?.code ?? ""), error: shortError(e) });
          left += 1;
        }
      }
    };
    await walk(toDir);
    return left === 0;
  };
  for (const item of all) {
    const from = String(item.from ?? "");
    const to = String(item.to ?? "");
    if (from === "" || to === "") { failed.push({ path: from, code: "", error: "清单条目缺少原路径" }); continue; }
    if (item.dir === true) {
      // 目标目录已重建 → 逐文件合并；仍没建 → 整块搬回（最快且保持原样）
      if (existsSync(from)) {
        const complete = await restoreDir(item);
        if (!complete) stillThere.push(item);
        continue;
      }
      try {
        await movePath(to, from);
        restored += 1;
      } catch (e) {
        failed.push({ path: from, code: String(e?.code ?? ""), error: shortError(e) });
        stillThere.push(item);
      }
      continue;
    }
    if (existsSync(from)) {
      conflicts.push(from); // 同名重开后原稿又有了：不覆盖，交给用户自己决定
      stillThere.push(item);
      continue;
    }
    try {
      await movePath(to, from);
      restored += 1;
    } catch (e) {
      failed.push({ path: from, code: String(e?.code ?? ""), error: shortError(e) });
      stillThere.push(item);
    }
  }
  // 设定库条目：恢复时按清单原样写回（若已被同名新书占用则跳过）
  let profileRestored = false;
  const backup = manifest.profile;
  let profileBlocked = false;
  if (backup && typeof backup.key === "string" && backup.key !== "") {
    try {
      const state = await readSentenceState();
      const profiles = state?.creationProfiles && typeof state.creationProfiles === "object" ? state.creationProfiles : {};
      if (Object.prototype.hasOwnProperty.call(profiles, backup.key)) {
        conflicts.push("设定库条目「" + backup.key + "」");
        profileBlocked = true;
      } else {
        await writeSentenceState({ creationProfiles: { [backup.key]: backup.value } });
        profileRestored = true;
      }
    } catch (e) {
      failed.push({ path: stateFilePath(), code: String(e?.code ?? ""), error: "设定库条目恢复失败：" + shortError(e) });
      profileBlocked = true;
    }
  }
  const complete = stillThere.length === 0 && !profileBlocked;
  if (complete) {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* 删不掉就留着，下次仍可重试 */ }
  } else if (stillThere.length > 0) {
    // 只把没恢复成功的项目留在清单里，避免下次重复处理已恢复的项
    try {
      await writeFile(join(dir, "manifest.json"), JSON.stringify({ ...manifest, items: stillThere }, null, 2), "utf8");
    } catch { /* 清单回写失败只会导致下次重复恢复（幂等：已存在的会被当冲突跳过） */ }
  }
  logEvent("config", {
    book: String(manifest.book ?? ""),
    action: "delete_restore",
    count: restored,
    path: dir,
    failures: failed.length + conflicts.length,
    level: failed.length > 0 || conflicts.length > 0 ? "warn" : "info",
    detail: "回收站恢复：成功 " + restored + " 项"
  });
  return { trashId, book: String(manifest.book ?? ""), restored, profileRestored, conflicts, failed, items: all.length };
}

/** 彻底删除一个回收站条目（不可恢复） */
export async function purgeTrash({ root, trashId }) {
  const dir = trashEntryPath(root, trashId);
  if (!existsSync(dir)) throw new Error("回收站里没有条目「" + trashId + "」——可用 action=list 查看现有条目");
  const size = await pathSize(dir);
  await rm(dir, { recursive: true, force: true });
  if (existsSync(dir)) throw new Error("彻底删除失败（目录仍存在）：" + dir + "——多半是被其他程序占用");
  logEvent("config", { action: "delete_purge", path: dir, files: size.files, bytes: size.bytes, detail: "彻底删除回收站条目（不可恢复）" });
  return { trashId, purged: true, files: size.files, bytes: size.bytes };
}

function formatSize(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(1) + " KB";
  return b + " B";
}

/**
 * 把结果渲染成给 AI / 用户看的中文文本（与工具 render 同源，避免两份口径）。
 */
export function formatBookDelete(value) {
  const v = value ?? {};
  const lines = [];
  const action = String(v.action ?? "preview");
  if (action === "list") {
    const entries = Array.isArray(v.trash) ? v.trash : [];
    lines.push("<type>novel-delete-book</type>", "<content>", "【回收站】共 " + entries.length + " 项");
    if (entries.length === 0) lines.push("", "（回收站是空的：还没有用 novel_delete_book 删过书，或已全部彻底删除）");
    for (const e of entries) {
      lines.push("- " + e.id + "  《" + (e.book || "未知") + "》  " + e.files + " 个文件 / " + formatSize(e.bytes) + (e.restorable ? "" : "（无清单，不能一键恢复）"));
    }
    lines.push("", "</content>");
    return lines.join("\n");
  }
  if (action === "restore") {
    lines.push("<type>novel-delete-book</type>", "<content>", "【从回收站恢复】《" + (v.book || "") + "》");
    lines.push("- 已恢复：" + (v.restored ?? 0) + " 项" + (v.profileRestored ? "（含设定库条目）" : ""));
    if ((v.conflicts ?? []).length > 0) {
      lines.push("- 跳过（原位置已有同名内容，**未覆盖**）：");
      for (const c of v.conflicts) lines.push("  - " + c);
    }
    if ((v.failed ?? []).length > 0) {
      lines.push("- 失败：");
      for (const f of v.failed) lines.push("  - " + f.path + " — " + f.error);
    }
    lines.push("", "</content>");
    return lines.join("\n");
  }
  if (action === "purge") {
    lines.push("<type>novel-delete-book</type>", "<content>", "【彻底删除回收站条目】" + (v.trashId || ""), "- 已删除：" + (v.totals?.files ?? 0) + " 个文件 / " + formatSize(v.totals?.bytes ?? 0) + "（不可恢复）", "", "</content>");
    return lines.join("\n");
  }

  // preview / apply
  const isApply = action === "apply";
  lines.push("<type>novel-delete-book</type>", "<content>");
  lines.push("【" + (isApply ? "按书删除 · 已执行" : "按书删除 · 预览") + "】《" + (v.book || "") + "》");
  if (v.blocked) {
    lines.push("", "✗ 不能删除：" + v.blockedReason);
    lines.push("", "</content>");
    return lines.join("\n");
  }
  if (!v.found) {
    lines.push("", "没有找到这本书的任何内容（正文目录 / 创作资料 / 数据目录里的按书文件都不存在）。", "请先用 novel_books 确认书名。", "", "</content>");
    return lines.join("\n");
  }
  const totals = v.totals ?? { files: 0, bytes: 0 };
  lines.push("", (isApply ? "已清理" : "将清理") + "（共 " + totals.files + " 个文件 / " + formatSize(totals.bytes) + "）：");
  for (const t of v.targets ?? []) {
    if (!t.exists) continue;
    const extra = Array.isArray(t.sample) && t.sample.length > 0 ? "  [" + t.sample.slice(0, 3).join("、") + (t.sample.length > 3 ? " …" : "") + "]" : "";
    lines.push("- " + t.label + " · " + t.files + " 个文件 / " + formatSize(t.bytes) + " — " + t.rel + extra);
  }
  lines.push("", "不会动：" + (v.notTouched ?? []).join("；"));
  if ((v.warnings ?? []).length > 0) {
    lines.push("", "⚠ 提示：");
    for (const w of v.warnings) lines.push("- " + w);
  }
  if (isApply) {
    lines.push("", "已移入回收站：" + (v.trashDir || "（无）"));
    if (v.trashId) lines.push("回收站条目 id：" + v.trashId + "（可用 action=restore trashId=" + v.trashId + " 恢复）");
    const remaining = v.remaining ?? { files: 0, bytes: 0 };
    lines.push("残留：" + remaining.files + " 个文件");
    if ((v.failed ?? []).length > 0) {
      lines.push("", "失败项：");
      for (const f of v.failed) lines.push("- " + f.path + " — " + f.error);
    }
  } else {
    lines.push("", "以上为预览，磁盘上还没有任何改动。确认无误后把 action 改为 \"apply\" 才会真正执行。");
  }
  lines.push("", "</content>");
  return lines.join("\n");
}
