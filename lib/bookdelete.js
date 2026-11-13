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

import { existsSync, realpathSync, rmdirSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  writeSentenceState,
  draftBookDir
} from "./core.js";
import { logEvent } from "./log.js";
// v6.8.0：回收站的公共机制（目录名 / 条目名校验 / 时间戳 / 跨卷移动 / 清单结构）抽到 lib/trash.js，
// 与「单份报告删除」共用同一套，避免两处的清单与恢复语义分叉。
// v7.3.1 修（#50）：TRASH_DIRNAME 原来只被本文件导入+再导出、内外都没用到——目录定位统一走
// trashDirPathOf，所以这里不再导入它，也不再对外再导出（需要目录名的调用方直接从 trash.js 取）。
import { TRASH_SCHEMA, isValidTrashId, movePath, relOf, shortError, stampOf, trashDirPathOf } from "./trash.js";

export { TRASH_SCHEMA, isValidTrashId };

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
  return trashDirPathOf(novelDataDir(root));
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
 * 回收站条目名的**前缀**（= 书名那一截）。
 *
 * 为什么不能直接 `plan.safeBook`：`sanitizeSegment`（lib/core.js）只剥**首尾**点号，
 * 书名《v1..2》会得到 `v1..2`，拼出的 trashId 含 `..` → `isValidTrashId` 判非法 →
 * `listTrash` 把它藏起来、`restore`/`purge` 入口断言抛错，整条数据永久滞留在磁盘上（#3）。
 *
 * 这里在生成 trashId 前把**连续点号**规整成下划线，再跑一遍 `sanitizeSegment` 式清洗，
 * 最后用 `isValidTrashId` 验证——保证本模块产出的条目名一定能被恢复端认出。
 */
export function trashIdPrefixFor(safeBook) {
  const normalized = String(safeBook ?? "").replace(/\.{2,}/g, "_");
  let prefix = normalized;
  try { prefix = sanitizeSegment(normalized, "book"); } catch { /* 极端输入：走下面的字符级兜底 */ }
  if (!isValidTrashId(prefix)) {
    prefix = normalized
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/^[.\s]+/, "")
      .replace(/\.{2,}/g, "_")
      .trim();
  }
  if (!isValidTrashId(prefix) || prefix === "") prefix = "book";
  return prefix;
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

/**
 * v7.3.2 修（N5）：解析符号链接/junction 之后的**真实**路径，且目标可以尚不存在。
 *
 * 为什么不能直接 `realpathSync(p)`：要比对的路径里有一半是"还没建的"（回收站清单条目的原路径、
 * 恢复落点等），realpath 对不存在的路径一律 ENOENT 抛错，拿不到可比的东西。
 * 做法：从 p 开始逐级向上找**存在的最深祖先**做 realpath，再把回退过的段按原序拼回去——
 * 于是"根内一个指向库外的链接 + 其余不存在的子路径"也能被认出来。
 * realpathSync.native 解析 Windows junction/reparse point；循环链接等异常一律按上一条处理，
 * 到根仍解析不了时退回词法结果（不抛错——边界判定不该让删除流程崩）。
 */
function realPathOf(p) {
  const abs = resolve(String(p ?? ""));
  if (abs === "") return "";
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      // tail 用 unshift 累积，保证拼回去时仍是原来的层级顺序（/a/b/m/n → real(b)+m+n）
      return tail.length === 0 ? real : join(real, ...tail);
    } catch {
      const parent = dirname(cur);
      // 连盘符/根都解析不了（目标盘不存在、循环链接等）：一处也解析不出，退回词法结果
      if (parent === cur) return abs;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * v7.3.1 修（#47）：路径是否落在 `base` 之内（`allowSelf` 决定 base 自身算不算）。
 *
 * 为什么不复用 `core.isInsideBookDir`：它内部依赖 core.js 的 `resolvePathSafe`，而那个函数
 * 缺 `resolve` 导入（审查 #1，归 core.js 修），当前恒返 `""` → 判定恒 false。删书是破坏性操作，
 * 它的安全断言不能建立在另一个待修函数上，所以这里自备一个只依赖 node:path 的判定。
 * 两侧都先 `resolve`，于是 `..`、`/`、`.\\` 等写法在比较前已被折叠，比字符串比较更难绕过。
 *
 * v7.3.2 修（N5）：只做词法归一不够——书库根内若被预置了指向库外的 junction/符号链接，
 * 词法上"在根内"的路径实际会写到根外。两侧改走 realPathOf（存在的最深祖先 realpath + 拼回
 * 剩余段），链接因此被解析；`..` 仍然折叠，原有语义（allowSelf）不变。
 */
function isInsideDir(base, target, allowSelf = true) {
  const b = realPathOf(base);
  const t = realPathOf(target);
  if (b === "" || t === "") return false;
  if (t === b) return allowSelf;
  const withSep = b.endsWith(sep) ? b : b + sep;
  return t.startsWith(withSep);
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
  // v7.3.1 修（#47）：未匹配到真实目录时返回**清洗后**的书名，不能原样返回用户输入。
  // 旧版 `return book` 让 `x/../../../y` 这类书名在 join 之后逃出 novels/——实测
  // `applyBookDelete` 会把库外的真实目录整个移进回收站（purge 后不可恢复）。
  // 清洗后的名字不含分隔符与父目录段，拼出的路径必然落在 novels/ 之内。
  return safe;
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

/**
 * v7.3.3 修（#9）：可清理判定。**存在但为空**的目录也算可清理——旧版统一要求 `files > 0`，
 * 于是 `novels/<书>/` 这样的空目录在预览里被列为「将清理」、apply 却报「没找到任何内容」；
 * 若同时有别的位置有文件，apply 之后这个空目录又残留在盘上（novel_books 继续把它当一本书列出）。
 * 空目录没有内容可恢复，apply 侧用 rmdir 直接移除、不进回收站（见 applyBookDelete 的循环）。
 */
function isDeletableTarget(target) {
  return Boolean(target?.exists) && (target.files > 0 || target.kind === "dir");
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
  const folder = await resolveBookFolder(root, rawBook);
  const keys = [...new Set([rawBook, folder, safeBook].filter((k) => typeof k === "string" && k !== ""))];
  const warnings = [];
  const targets = [];

  // ① 章节正文（novels/<书>/）
  const chapterDir = join(novelsDir(root), folder);
  // ② 创作资料（novels/创作资料/<书>/）的目标目录
  const creationBookDir = join(novelsDir(root), CREATION_DIR, folder);
  // v7.3.1 修（#47）：目标必须在 novels/ 之内——纵深防御。folder 已被 resolveBookFolder 清洗，
  // 理论上不可能越界；这道断言防的是"将来有人把它改回原样返回书名"再次打开穿越
  // （审查实测：穿越时 apply 会把库外目录整个搬进回收站）。
  const escapedTarget = !isInsideDir(novelsDir(root), chapterDir, false) || !isInsideDir(novelsDir(root), creationBookDir, false);
  const blockedReason = blockReasonFor(rawBook, safeBook)
    || (escapedTarget ? "书名解析后的路径逃出了 novels/ 目录（疑似路径穿越），拒绝执行" : "");
  if (existsSync(chapterDir)) {
    const size = await pathSize(chapterDir);
    targets.push({ key: "chapters", label: "章节正文", kind: "dir", path: chapterDir, exists: true, items: [chapterDir], files: size.files, bytes: size.bytes, sample: size.sample });
  } else {
    targets.push({ key: "chapters", label: "章节正文", kind: "dir", path: chapterDir, exists: false, items: [], files: 0, bytes: 0, sample: [] });
  }

  // ② 创作资料（novels/创作资料/<书>/：创作设定/主要人物/次要人物/剧情大纲/钩子记录/创作状态卡）
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

  // ③-b v7.3.0：草稿镜像（实时聊天写作）——**按书一个目录** `.novel-writer/drafts/<书>/`，
  // 与上面"扁平文件带书名前缀"的口径不同，所以单独成一项（kind:"dir"，整目录移入回收站）。
  // 不登记它的话，按书删除会在磁盘上留下一份看不见的孤儿目录。
  {
    const draftsDir = draftBookDir(root, safeBook);
    let size = { files: 0, bytes: 0, sample: [] };
    try { size = await pathSize(draftsDir); } catch { /* 没有就是没有 */ }
    if (size.files > 0) {
      targets.push({ key: "data:drafts", label: "草稿镜像", kind: "dir", path: draftsDir, exists: true, items: [draftsDir], files: size.files, bytes: size.bytes, sample: size.sample });
    } else {
      targets.push({ key: "data:drafts", label: "草稿镜像", kind: "dir", path: draftsDir, exists: false, items: [], files: 0, bytes: 0, sample: [] });
    }
  }

  // ③b 旧位置伏笔表：v0.8.0 之前写在数据目录**根**上的 `<书>.json`（legacyPlotsFile）。
  // 现有书大多已迁移到 plots/，但"从没读过伏笔表"的书可能还留着，不处理就等于漏删。
  // v7.3.2 修（N15）：`keys` 里含**未清洗**的 rawBook，`x/../../../evil` 这类书名能让
  // `join(dataDir, key+".json")` 落到数据目录之外——预览于是把库外文件的名称/体积/存在性列给用户看
  // （apply 侧还有 dirname 过滤，不会真搬走，但预览本身就不该探库外）。每个候选路径先过一遍
  // isInsideDir 边界（已按 realPathOf 解析链接），越界的直接不列。
  const legacyUnique = [...new Set(keys
    .map((key) => join(dataDir, key + ".json"))
    .filter((f) => isInsideDir(dataDir, f, false) && existsSync(f)))];
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
  // v7.3.3 修（#9）：`found` 与 `keys` 同用 isDeletableTarget——「存在但空的目录」也是可清理内容，
  // 否则纯空目录书永远删不掉（apply 直接抛「没找到任何内容」）。
  const found = targets.some((t) => isDeletableTarget(t) || (t.kind === "state" && t.exists));
  // v7.0.1（审查 #39）：plan 自己也带上"本次可清理的 key 列表"。调用侧（deleteBookDispatch）
  // 虽然会再算一遍，但独立调用 planBookDelete 的代码不该拿到一个没有 keys 的对象——
  // 那会让 formatBookDelete 渲染出 `key（）` 这种空括号。
  const availableKeys = targets.filter((t) => isDeletableTarget(t)).map((t) => t.key);

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
    keys: availableKeys,
    warnings,
    notTouched: [
      "全局词表（.novel-writer/lexicon/" + GLOBAL_LEXICON_BOOK + ".json）",
      "插件通用设置（state.json 里的开关 / 容差 / 提示词档位 / 其他书条目）",
      "事件日志（与 state.json 同级的 logs/）",
      "其他书的正文与资料"
    ]
  };
}

/**
 * v6.8.0：把「要清理哪些位置」解析成一个集合。
 *
 * `keys` 省略 = 全选（＝原来的"删整本书"）；给了就只处理这些 key——于是
 * 「只清报告历史 / 只清缓存，正文留着」不需要另开工具，仍然是同一条执行链路
 * （同一条链路意味着回收站、manifest、失败项、冲突跳过这些语义都自动一致）。
 */
export function selectTargets(plan, keys) {
  // v7.3.3 修（#9）：可用项判定与 planBookDelete 的 found/keys 同源（空目录可清理）
  const available = plan.targets.filter((t) => isDeletableTarget(t)).map((t) => t.key);
  if (keys === void 0 || keys === null) return new Set(available);
  assert(Array.isArray(keys), "参数 \"keys\" 必须是数组（要清理的位置 key 列表，取自 preview 的 targets[].key）");
  const wanted = keys.map((k) => String(k === void 0 || k === null ? "" : k).trim()).filter((k) => k !== "");
  const unknown = wanted.filter((k) => !plan.targets.some((t) => t.key === k));
  assert(
    unknown.length === 0,
    "参数 \"keys\" 含未知位置：" + unknown.join("、") + "——可选值为 preview 返回的 targets[].key（" + plan.targets.map((t) => t.key).join(" / ") + "）"
  );
  const picked = new Set(wanted.filter((k) => available.includes(k)));
  assert(
    picked.size > 0,
    "参数 \"keys\" 至少要选中一处可清理的内容（本书当前可清理：" + (available.length > 0 ? available.join(" / ") : "无") + "）"
  );
  return picked;
}

/**
 * 执行删除：把（选中的）目标项**移入回收站**，并写 `manifest.json` 供恢复。
 *
 * 局部失败不中断：某一项移不动（被占用、权限）就记进 `failed` 继续下一项——
 * 半途整体中止会让用户既不知道删了什么、也无法恢复。
 */
export async function applyBookDelete({ root, book, plan: givenPlan, now, keys }) {
  const plan = givenPlan && givenPlan.folder ? givenPlan : await planBookDelete({ root, book });
  if (plan.blocked) throw new Error("无法删除《" + plan.book + "》：" + plan.blockedReason);
  if (!plan.found) {
    throw new Error("没找到《" + plan.book + "》的任何内容（正文目录、创作资料与数据目录里的按书文件都不存在）——请先用 novel_books 确认书名");
  }
  const selected = selectTargets(plan, keys);
  // v7.3.3 修（#9）：空目录也算「可清理的位置」，未选中时要出现在 skipped 里（与 selectTargets 同源）
  const skippedKeys = plan.targets.filter((t) => isDeletableTarget(t) && !selected.has(t.key)).map((t) => t.key);
  const partial = skippedKeys.length > 0;

  const trashBase = trashDirPath(root);
  const stamp = stampOf(now);
  // 先规整书名再拼条目名：`..` 会让 isValidTrashId 判非法，条目变成看不见的磁盘垃圾（#3）
  const prefix = trashIdPrefixFor(plan.safeBook);
  let trashId = prefix + "-" + stamp;
  for (let n = 2; existsSync(join(trashBase, trashId)); n += 1) trashId = prefix + "-" + stamp + "-" + n;
  const trashRoot = join(trashBase, trashId);

  const failed = [];
  const items = [];
  let moved = 0;
  let files = 0;
  let bytes = 0;
  // v7.3.3 修（#9）：空目录没有内容可移入回收站，直接 rmdir；单独计数只用于文案/提示
  let removedEmptyDirs = 0;

  try {
    await mkdir(trashRoot, { recursive: true });
  } catch (e) {
    throw new Error("无法创建回收站目录（" + trashRoot + "）：" + shortError(e) + "——为避免误删，未做任何改动");
  }

  for (const target of plan.targets) {
    // 设定库条目不是文件，下面单独处理
    if (target.kind === "state") continue;
    if (!target.exists) continue;
    // v7.3.3 修（#9）：只有「空目录」能在 files===0 时继续往下走——它们是本缺陷里删不掉的残留
    const emptyDir = target.kind === "dir" && target.files === 0;
    if (target.files === 0 && !emptyDir) continue;
    // v6.8.0 选择性清理：没选中的位置原样保留（正文留着、只清报告/缓存就是这条路径）
    if (!selected.has(target.key)) continue;
    if (emptyDir) {
      // v7.3.3 修（#9）：空目录没有文件可恢复，不进回收站；成功才删，非空/被占用就记失败并保持原样
      // （宁可留下，也不能误删里面的东西）。这里用 rmdirSync 而不是 rmSync：Node 的 fs.rm 语义等同
      // `rm`，对目录即使 {recursive:false} 也直接抛 EISDIR（实测 Node 26），只有 rmdir 才是「空目录才删」。
      try {
        rmdirSync(target.path);
        removedEmptyDirs += 1;
      } catch (e) {
        failed.push({ path: target.path, code: String(e?.code ?? ""), error: "空目录移除失败（非空或被占用时保持原样）：" + shortError(e) });
      }
      continue;
    }
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
  if (plan.profileKey !== "" && selected.has("profile")) {
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

  // 全部失败（一项都没搬走、条目也没摘）→ 删掉空回收站目录，别在列表里留一个空条目。
  // v7.3.3 修（#9）：只移除了空目录也算「没有内容进回收站」——空目录不可恢复，不该生成 0 文件的回收站条目。
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
  // v7.3.3 修（#9）：空目录是**直接移除**的（没有内容可恢复），必须如实说明它不在回收站里
  if (removedEmptyDirs > 0) {
    warnings.push("已直接移除 " + removedEmptyDirs + " 个空目录（空目录没有文件可恢复，因此不进回收站；如需还原请自行重建目录）");
  }
  if (!manifestWritten) warnings.push("回收站清单没写成：文件已在回收站目录里，但无法用 restore 一键恢复，需手动移回");
  if (failed.length > 0) warnings.push("有 " + failed.length + " 项没搬动（多半是被其他程序占用或没有权限），逐条见下方失败项");
  // 只清理一部分时，remaining 是"有意保留"而不是"残留"——不能拿同一句话去吓人
  if (partial) {
    warnings.push("只清理了选中的 " + selected.size + " 处，另有 " + skippedKeys.length + " 处按选择保留（" + skippedKeys.join(" / ") + "）");
    if (skippedKeys.includes("chapters")) warnings.push("正文目录保留了：这本书仍在书库里，可用 novel_books 确认");
  } else if (remaining.files > 0) {
    warnings.push("清理后仍有 " + remaining.files + " 个文件残留，可用 action=preview 复查具体位置");
  }

  // v7.0.1（审查 #33）：`totals` 与"已清理"清单只算**实际选中**的位置。
  // 旧版取 `plan.totals`（按全部 targets 累加），只清 analysis 缓存时也会把正文的体积累加进去，
  // 把"有意保留"渲染成"已清理"。保留项仍然通过 `skipped` 单独说明。
  const selectedTargets = plan.targets.filter((t) => selected.has(t.key));
  const selectedTotals = selectedTargets.reduce((acc, t) => { acc.files += t.files; acc.bytes += t.bytes; return acc; }, { files: 0, bytes: 0 });

  const result = {
    action: "apply",
    book: plan.book,
    safeBook: plan.safeBook,
    found: plan.found,
    blocked: plan.blocked,
    blockedReason: plan.blockedReason,
    targets: selectedTargets.map((t) => ({ key: t.key, label: t.label, kind: t.kind, path: t.path, rel: t.rel, exists: t.exists, files: t.files, bytes: t.bytes, sample: t.sample })),
    totals: selectedTotals,
    warnings,
    notTouched: plan.notTouched,
    trash: [],
    trashId: trashIdOut,
    trashDir: trashDirOut,
    moved,
    profileRemoved,
    profileRestored: false,
    keys: [...selected],
    skipped: skippedKeys,
    partial,
    failed,
    remaining,
    restored: 0,
    conflicts: [],
    purged: false,
    message: ""
  };
  // v7.3.3 修（#9）：文案必须区分「移入回收站 N 项」与「直接移除 N 个空目录」——后者没有内容可恢复
  const emptyDirNote = removedEmptyDirs > 0 ? "，并移除 " + removedEmptyDirs + " 个空目录" : "";
  if (moved === 0 && removedEmptyDirs === 0 && !profileRemoved) {
    result.message = "《" + plan.book + "》没有移动任何内容（见失败项）";
  } else if (moved === 0 && !profileRemoved) {
    result.message = "已移除《" + plan.book + "》的 " + removedEmptyDirs + " 个空目录（空目录没有文件，未移入回收站）";
  } else {
    result.message = "已将《" + plan.book + "》的 " + moved + " 项（" + files + " 个文件 / " + bytes + " 字节）移入回收站"
      + emptyDirNote
      + (profileRemoved ? "，并移除设定库条目" : "")
      + (partial ? "；另外 " + skippedKeys.length + " 处按选择保留" : "");
  }
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
  let dirents = [];
  try { dirents = await readdir(base, { withFileTypes: true }); } catch { return []; }
  const entries = [];
  for (const entry of dirents) {
    // v7.0.1（审查 #61）：只收目录。回收站根下的普通文件（临时文件、手滑丢进来的东西）不是条目，
    // 旧版把它们也列成"损坏条目"，既误导用户又让列表噪音化。
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const dir = join(base, name);
    const validId = isValidTrashId(name);
    let manifest = null;
    try { manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")); } catch { manifest = null; }
    if (manifest && validId) {
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
    // 没有清单（清单写失败 / 手动塞进来的目录）：仍要列出来，但明确说不能一键恢复。
    // v7.0.1（审查 #3）：**非法条目名**（旧版本用含 ".." 的书名生成的条目）同样列出来并标
    // `restorable:false`——旧版直接 continue 隐藏，restore/purge 又断言拒绝，数据就变成
    // 看不见也动不了的磁盘垃圾。这里宁可让它"可见但说明原因"，也不静默吞掉。
    const hasManifestSize = manifest !== null && (typeof manifest.files === "number" || typeof manifest.bytes === "number");
    const size = hasManifestSize
      ? { files: Number(manifest.files ?? 0) || 0, bytes: Number(manifest.bytes ?? 0) || 0 }
      : await pathSize(dir);
    let mtime = "";
    try { mtime = (await stat(dir)).mtime.toISOString(); } catch { /* ignore */ }
    entries.push({
      id: name,
      book: manifest ? String(manifest.book ?? "") : "",
      createdAt: manifest ? String(manifest.createdAt ?? "") : mtime,
      files: size.files,
      bytes: size.bytes,
      items: manifest && Array.isArray(manifest.items) ? manifest.items.length : 0,
      restorable: false,
      path: dir
    });
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
        // v7.3.2 修（N5）：合并恢复是逐文件**写**的，落点可能经过 fromDir 之下更深一层的
        // junction/符号链接（条目级边界只看 fromDir 本身，看不进去）。每写一个文件前，用
        // realPathOf 解析后的边界再确认一次；越界就报失败、留在 stillThere，绝不在库外落盘。
        if (!isInsideDir(fromDir, dest, false)) {
          failed.push({ path: dest, code: "EPATH", error: "恢复落点经符号链接/junction 指向了原目录之外，已拒绝写入：" + dest });
          left += 1;
          continue;
        }
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
    // v7.3.1 修（#47 姊妹漏洞）：清单文件用户也能改，`items[].from/to` 必须**重新校验**。
    // 旧版只判 existsSync 冲突，于是"库外绝对路径"会被 movePath 原样搬过去——穿越删除之后
    // 再 restore，就能把内容搬到库外任意位置（写盘越权）。两条硬边界：
    //   · from（恢复落点）必须在书库根之内；
    //   · to（回收站里那一份）必须在本条目目录之内。
    // 越界条目一律不动，逐条进 failed（并留在 stillThere，于是条目不会被删、数据不丢）。
    // v7.3.2 修（N5）：两条边界现在都经 realPathOf 解析链接（isInsideDir 内部），
    // 于是"根内一个指向库外的 junction + 不存在的子路径"同样会被判越界——词法比较看不出这一层。
    if (!isInsideDir(resolve(root), from, false)) {
      failed.push({ path: from, code: "EPATH", error: "清单条目的原路径不在书库根内，已拒绝恢复（疑似被改过的回收站清单）：" + from });
      stillThere.push(item);
      continue;
    }
    if (!isInsideDir(dir, to, false)) {
      failed.push({ path: to, code: "EPATH", error: "清单条目的回收站路径不在该条目目录内，已拒绝恢复：" + to });
      stillThere.push(item);
      continue;
    }
    if (item.dir === true) {
      // 目标目录已重建 → 逐文件合并；仍没建 → 整块搬回（最快且保持原样）
      if (existsSync(from)) {
        const complete = await restoreDir(item);
        if (!complete) stillThere.push(item);
        continue;
      }
      try {
        // v7.0.1（审查 #60）：恢复项数统一按**文件数**统计（旧版整目录搬回记 1 项、逐文件合并记 N 项，
        // 同一次恢复的"已恢复 N 项"口径会飘）。搬之前先数一遍，搬成功后按文件数累加。
        const size = await pathSize(to);
        await movePath(to, from);
        restored += size.files > 0 ? size.files : 1;
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
  } else {
    /**
     * v7.0.1（审查 #4）：部分恢复后**必须回写清单**，无论还剩的是文件还是"仅设定库条目"。
     *
     * 旧版只在 `stillThere.length > 0` 时回写。如果文件都恢复了、只有设定库条目因同名被挡
     * （profileBlocked），清单保持原样 → 第二次恢复时已恢复的文件在目标位置存在，被当成
     * **新的冲突**，整个条目永久卡在"恢复不了"。
     *
     * 回写内容：
     * - `items` 只留没恢复成功的项（已恢复的剔除，下次不再重复处理）；
     * - `profile` 在已恢复时置 null（否则下次会把同名条目再报一次冲突）；
     * - `profilePending:true` 明确告诉下一次"只差设定库那一项"。
     */
    const nextManifest = {
      ...manifest,
      items: stillThere,
      profile: profileRestored ? null : (manifest.profile ?? null),
      profilePending: profileBlocked
    };
    try {
      await writeFile(join(dir, "manifest.json"), JSON.stringify(nextManifest, null, 2), "utf8");
    } catch { /* 清单回写失败只会导致下次重复恢复（幂等：已存在的会被当冲突跳过） */ }
  }
  logEvent("config", {
    book: String(manifest.book ?? ""),
    action: "delete_restore",
    count: restored,
    path: dir,
    failures: failed.length + conflicts.length,
    level: failed.length > 0 || conflicts.length > 0 ? "warn" : "info",
    detail: "回收站恢复：成功 " + restored + " 个文件"
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
      // v7.0.1（审查 #3）：非法的旧条目名要可见且说清原因，不能像旧版那样静默隐藏
      const why = e.restorable
        ? ""
        : isValidTrashId(e.id)
          ? "（无清单，不能一键恢复）"
          : "（条目名含非法字符，恢复/删除入口不可用；数据仍在盘上，可手动移出或改名后再试）";
      lines.push("- " + e.id + "  《" + (e.book || "未知") + "》  " + e.files + " 个文件 / " + formatSize(e.bytes) + why);
    }
    lines.push("", "</content>");
    return lines.join("\n");
  }
  if (action === "restore") {
    lines.push("<type>novel-delete-book</type>", "<content>", "【从回收站恢复】《" + (v.book || "") + "》");
    lines.push("- 已恢复：" + (v.restored ?? 0) + " 个文件" + (v.profileRestored ? "（含设定库条目）" : ""));
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
    // v7.0.1（审查 #10）：purgeTrash 返回的是扁平 `{files, bytes}`（dispatch 侧会再包一层 totals）。
    // 两处口径统一：优先 totals，其次扁平字段——旧版只读 totals，直接调 purgeTrash 后渲染
    // 恒显示"已删除：0 个文件 / 0 B"。
    const purgedFiles = v.totals?.files ?? v.files ?? 0;
    const purgedBytes = v.totals?.bytes ?? v.bytes ?? 0;
    lines.push("<type>novel-delete-book</type>", "<content>", "【彻底删除回收站条目】" + (v.trashId || ""), "- 已删除：" + purgedFiles + " 个文件 / " + formatSize(purgedBytes) + "（不可恢复）", "", "</content>");
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
    // v7.3.3 修（#9）：纯空目录没有内容进回收站（trashDir/trashId 均为空串），旧版只会渲染
    // 「已移入回收站：（无）」，看不出空目录其实已被 rmdir。分开说，别让用户以为什么都没发生。
    if (v.trashDir || v.trashId) {
      lines.push("", "已移入回收站：" + v.trashDir);
      if (v.trashId) lines.push("回收站条目 id：" + v.trashId + "（可用 action=restore trashId=" + v.trashId + " 恢复）");
    } else {
      lines.push("", "已移入回收站：（无）——本次没有文件被搬走（空目录如已选中则已在盘上直接移除、不可恢复；失败项见下）");
    }
    if (v.partial && Array.isArray(v.skipped) && v.skipped.length > 0) {
      lines.push("按选择保留：" + v.skipped.join(" / "));
    } else {
      const remaining = v.remaining ?? { files: 0, bytes: 0 };
      lines.push("残留：" + remaining.files + " 个文件");
    }
    if ((v.failed ?? []).length > 0) {
      lines.push("", "失败项：");
      for (const f of v.failed) lines.push("- " + f.path + " — " + f.error);
    }
  } else {
    lines.push("", "以上为预览，磁盘上还没有任何改动。确认无误后把 action 改为 \"apply\" 才会真正执行。");
    lines.push("只想清理其中几处时，把 apply 的 keys 传成对应位置的 key（" + (v.keys ?? []).join(" / ") + "）。");
  }
  lines.push("", "</content>");
  return lines.join("\n");
}
