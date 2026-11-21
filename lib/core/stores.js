/**
 * dsh-novel-writer — core/stores.js（Layer 3A：伏笔 / 设定 / 按书创作设定 / 摘要持久化与归一）
 *
 * 严格 DAG 3A 层：只依赖 Node 内置、../log.js 与 ./state.js，不依赖同层其他 domain 模块与 http。
 */

import { mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logEvent } from "../log.js";
import {
  assert, requiredString, sanitizeSegment, novelDataDir,
  readSentenceState, readSentenceStateSync, writeSentenceState,
  atomicWriteJson, noteRoot, withFileTx
} from "./state.js";

export function plotsFile(root, book) {
  return join(novelDataDir(root), "plots", sanitizeSegment(book, "book") + ".json");
}
export function legacyPlotsFile(root, book) {
  return join(novelDataDir(root), sanitizeSegment(book, "book") + ".json");
}
export async function readPlots(root, book, opts) {
  const file = plotsFile(root, book);
  let parsed = null;
  let primaryMissing = false;
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw Object.assign(new SyntaxError("文件内容不是合法 JSON（解析失败）"), { code: "EPARSE" });
    }
    parsed = raw;
  } catch (e) {
    if (e?.code === "ENOENT") {
      primaryMissing = true;
    } else {
      // v6.6.0：新位置不可读（损坏 / EACCES）与「本书还没有伏笔」对外长得一样；
      // 本条是 JSON.parse 路径（消息会回显文件内容片段），故只记固定标签，绝不带 e.message
      const isParse = e instanceof SyntaxError || e?.name === "SyntaxError" || e?.code === "EPARSE";
      const safeError = isParse
        ? Object.assign(new SyntaxError("文件内容不是合法 JSON（解析失败）"), { code: "EPARSE" })
        : e;
      logEvent("config", { book, file, level: "warn", detail: "伏笔表（新位置）读取失败（按无数据处理，未回退旧位置）" });
      if (opts?.strict === true) throw safeError;
      return [];
    }
  }
  if (primaryMissing) {
    // v0.8.0 迁移：旧位置 <root>/.novel-writer/<书>.json → plots/<书>.json（仅主文件 ENOENT 时回退）
    const legacyFile = legacyPlotsFile(root, book);
    try {
      const raw = JSON.parse(await readFile(legacyFile, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw Object.assign(new SyntaxError("文件内容不是合法 JSON（解析失败）"), { code: "EPARSE" });
      }
      parsed = raw;
    } catch (e) {
      // v6.6.0：旧位置同样按「无数据」吞掉——解析类错误的消息会回显文件内容，故只记固定标签
      if (e?.code !== "ENOENT") {
        const isParse = e instanceof SyntaxError || e?.name === "SyntaxError" || e?.code === "EPARSE";
        const safeError = isParse
          ? Object.assign(new SyntaxError("文件内容不是合法 JSON（解析失败）"), { code: "EPARSE" })
          : e;
        logEvent("config", { book, file: legacyFile, level: "warn", detail: "伏笔表（旧位置）读取失败（按无数据处理，未做迁移）" });
        if (opts?.strict === true) throw safeError;
      }
      /* 无旧文件 */
    }
    if (Array.isArray(parsed?.entries) && opts?.readOnly !== true) {
      try {
        await mkdir(dirname(file), { recursive: true });
        await atomicWriteJson(file, parsed);
      } catch {
        logEvent("config", { book, file, level: "warn", detail: "伏笔表（旧位置）迁移写入失败（仍返回旧位置数据）" });
      }
    }
  }
  return Array.isArray(parsed?.entries) ? parsed.entries : [];
}
export async function writePlots(root, book, entries) {
  const file = plotsFile(root, book);
  await mkdir(dirname(file), { recursive: true });
  await atomicWriteJson(file, { book, entries });
}
export function plotKeywords(content) {
  const text = String(content).replace(/[^\u4e00-\u9fff]/g, "");
  // v5.0.0：去掉字串里重复的 "一"（进 Set 后本就无影响，属笔误）
  const stop = new Set("的了是在我有和就都不一个这那与及或但是因为所以如果然后而且比如什么怎么自己她们他们你们我们咱们没有不是别莫未".split(""));
  const keywords = [];
  for (const length of [4, 3, 2]) {
    for (let i = 0; i + length <= text.length; i += 1) {
      const sub = text.slice(i, i + length);
      const nonStop = [...sub].filter((ch) => !stop.has(ch)).length;
      if (nonStop >= Math.ceil(length * 0.6)) keywords.push(sub);
    }
  }
  // 去重并按长度降序，最多取 8 个
  return [...new Set(keywords)].sort((a, b) => b.length - a.length).slice(0, 8);
}
export function normalizePlotEntry(entry) {
  // v3.5.0 #17：脏数据兜底——非对象或缺 id/content 直接跳过（不污染输出）
  if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || typeof entry.content !== "string") return null;
  const out = { id: entry.id, content: entry.content, status: entry.status === "done" ? "done" : "open" }; // v3.5.0 M12：status 归一（脏数据 in-progress 等一律 open，符合 schema enum）
  for (const key of ["chapter", "note", "payoffCondition", "lastMentioned", "type", "priority"]) {
    if (entry[key] !== void 0 && entry[key] !== null) out[key] = String(entry[key]);
  }
  for (const key of ["relatedCharacters", "locations", "mentionedIn"]) {
    if (Array.isArray(entry[key])) out[key] = entry[key].map((x) => String(x));
  }
  if (entry.createdAt != null) out.createdAt = String(entry.createdAt);
  if (entry.updatedAt != null) out.updatedAt = String(entry.updatedAt);
  return out;
}
export function settingsFile(root, book) {
  return join(novelDataDir(root), "settings", sanitizeSegment(book, "book") + ".json");
}
export async function readSettings(root, book, opts) {
  try {
    const parsed = JSON.parse(await readFile(settingsFile(root, book), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw Object.assign(new SyntaxError("文件内容不是合法 JSON（解析失败）"), { code: "EPARSE" });
    }
    return {
      characters: Array.isArray(parsed.characters) ? parsed.characters : [],
      locations: Array.isArray(parsed.locations) ? parsed.locations : [],
      items: Array.isArray(parsed.items) ? parsed.items : [],
      timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
      worldview: Array.isArray(parsed.worldview) ? parsed.worldview : []
    };
  } catch (e) {
    // v6.6.0：**读不到 ≠ 没登记**。ENOENT = "这本书还没登记过设定"（常态，不记）；
    // 其余（损坏/EACCES/IO）在非 strict 调用方那里被静默讲成"设定表为空"——必须留痕。
    //
    // v7.3.2 修（N13 根因）：**JSON.parse 的错误消息会回显文件内容片段**（Node 的 SRP 文本带上出错行附近
    // 的原文），而 strict 消费方（brief / fixplan / graph）会把它原样拼进降级说明或报告里——等于把
    // 设定表正文泄进「模型侧材料」和「可分享的诊断报告」。词表读取那边一直用固定文案，这里此前没有。
    // 现在：解析失败一律换成固定文案 + `code:"EPARSE"`，并把**原始错误只写进本地事件日志**（不出本机）。
    const isParse = e instanceof SyntaxError || e?.name === "SyntaxError" || e?.code === "EPARSE";
    // 保留 SyntaxError **类型**（调用方与测试靠它区分「解析失败」与「权限/IO」），只把 message 换成固定文案；
    // code 另标 EPARSE，方便需要机器判定的调用方不再依赖字符串匹配。
    const safeError = isParse
      ? Object.assign(new SyntaxError("文件内容不是合法 JSON（解析失败）"), { code: "EPARSE" })
      : e;
    if (e?.code !== "ENOENT") {
      logEvent("config", { book: typeof book === "string" ? book : void 0, level: "warn", detail: "设定表读取失败（调用方会把它讲成「未登记」）：" + (e?.message ?? e) });
    }
    if (opts?.strict === true && e?.code !== "ENOENT") throw safeError;
    return { characters: [], locations: [], items: [], timeline: [], worldview: [] };
  }
}
export async function writeSettings(root, book, data) {
  const file = settingsFile(root, book);
  await mkdir(dirname(file), { recursive: true });
  const payload = { book, ...(data && typeof data === "object" ? data : {}) };
  if (Object.prototype.hasOwnProperty.call(data || {}, "creationProfile")) {
    const normalizedProfile = normalizeCreationProfile(payload.creationProfile);
    if (normalizedProfile === null) delete payload.creationProfile;
    else payload.creationProfile = normalizedProfile;
  } else {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      const existingProfile = normalizeCreationProfile(parsed?.creationProfile);
      if (existingProfile !== null) payload.creationProfile = existingProfile;
    } catch { /* 文件不存在或不可解析时无需保留旧 creationProfile */ }
  }
  await atomicWriteJson(file, payload);
  await noteRoot(root); // v3.9.0：settings 写操作统一记录书库根
}

const CREATION_PROFILE_FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CREATION_PROFILE_MAX_STRING = 10000;
const CREATION_PROFILE_MAX_ITEM = 1000;
const CREATION_PROFILE_MAX_ITEMS = 100;

export function normalizeCreationProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out = {};
  for (const key of Object.keys(input)) {
    if (typeof key !== "string" || key === "" || CREATION_PROFILE_FORBIDDEN_KEYS.has(key)) continue;
    const val = input[key];
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed !== "") out[key] = trimmed.length > CREATION_PROFILE_MAX_STRING ? trimmed.slice(0, CREATION_PROFILE_MAX_STRING) : trimmed;
    } else if (Array.isArray(val)) {
      const items = [];
      for (const item of val) {
        const s = typeof item === "string"
          ? item.trim()
          : (typeof item === "number" && Number.isFinite(item) ? String(item) : "");
        if (s !== "") items.push(s.length > CREATION_PROFILE_MAX_ITEM ? s.slice(0, CREATION_PROFILE_MAX_ITEM) : s);
        if (items.length >= CREATION_PROFILE_MAX_ITEMS) break;
      }
      if (items.length > 0) out[key] = items;
    } else if (typeof val === "boolean") {
      out[key] = val;
    } else if (typeof val === "number" && Number.isFinite(val)) {
      out[key] = val;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function resolveLegacyBookProfileFromState(state, book, safeBook, rawBookOpt) {
  const profiles = state?.creationProfiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return null;
  const candidates = [];
  for (const k of [rawBookOpt, book, safeBook]) {
    if (typeof k === "string" && k !== "" && !candidates.includes(k)) candidates.push(k);
  }
  for (const k of candidates) {
    if (Object.prototype.hasOwnProperty.call(profiles, k)) {
      const norm = normalizeCreationProfile(profiles[k]);
      if (norm !== null) return norm;
    }
  }
  return null;
}

export async function readBookCreationProfile(root, book, opts = {}) {
  const rawBook = typeof book === "string" ? book.trim() : "";
  let safeBook = "";
  if (rawBook !== "") {
    try { safeBook = sanitizeSegment(rawBook, "book"); } catch { safeBook = ""; }
  }
  if (typeof root === "string" && root.trim() !== "" && safeBook !== "") {
    try {
      const parsed = JSON.parse(await readFile(settingsFile(root, safeBook), "utf8"));
      const localProfile = normalizeCreationProfile(parsed?.creationProfile);
      if (localProfile !== null) return localProfile;
    } catch { /* 文件不存在或不可读时回退 legacy state */ }
  }
  const state = opts?.state !== void 0 ? opts.state : await readSentenceState();
  const legacyBookProfile = resolveLegacyBookProfileFromState(state, rawBook, safeBook, opts?.rawBook);
  if (legacyBookProfile !== null) return legacyBookProfile;
  if (opts?.fallbackGlobal === true) {
    return normalizeCreationProfile(state?.creationProfile);
  }
  return null;
}

export function readBookCreationProfileSync(root, book, opts = {}) {
  const rawBook = typeof book === "string" ? book.trim() : "";
  let safeBook = "";
  if (rawBook !== "") {
    try { safeBook = sanitizeSegment(rawBook, "book"); } catch { safeBook = ""; }
  }
  if (typeof root === "string" && root.trim() !== "" && safeBook !== "") {
    try {
      const file = settingsFile(root, safeBook);
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        const localProfile = normalizeCreationProfile(parsed?.creationProfile);
        if (localProfile !== null) return localProfile;
      }
    } catch { /* 文件不存在或不可读时回退 legacy state */ }
  }
  const state = opts?.state !== void 0 ? opts.state : readSentenceStateSync();
  const legacyBookProfile = resolveLegacyBookProfileFromState(state, rawBook, safeBook, opts?.rawBook);
  if (legacyBookProfile !== null) return legacyBookProfile;
  if (opts?.fallbackGlobal === true) {
    return normalizeCreationProfile(state?.creationProfile);
  }
  return null;
}

export async function listBookCreationProfiles(root, state) {
  const st = state !== void 0 ? state : await readSentenceState();
  const out = {};
  if (st?.creationProfiles && typeof st.creationProfiles === "object" && !Array.isArray(st.creationProfiles)) {
    for (const [key, val] of Object.entries(st.creationProfiles)) {
      if (typeof key !== "string" || key === "" || CREATION_PROFILE_FORBIDDEN_KEYS.has(key)) continue;
      const norm = normalizeCreationProfile(val);
      if (norm !== null) out[key] = norm;
    }
  }
  if (typeof root === "string" && root.trim() !== "") {
    const dir = join(novelDataDir(root), "settings");
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          const parsed = JSON.parse(await readFile(join(dir, entry.name), "utf8"));
          const norm = normalizeCreationProfile(parsed?.creationProfile);
          if (norm === null) continue;
          const bookName = typeof parsed?.book === "string" && parsed.book.trim() !== ""
            ? parsed.book.trim()
            : entry.name.slice(0, -5);
          if (bookName === "" || CREATION_PROFILE_FORBIDDEN_KEYS.has(bookName)) continue;
          out[bookName] = norm;
        } catch { /* 单文件损坏/不可读时跳过 */ }
      }
    } catch { /* settings 目录不存在或不可读时保留 legacy 结果 */ }
  }
  return out;
}

async function clearLegacyCreationProfileKeys(keys) {
  try {
    const st = await readSentenceState();
    const legacy = st?.creationProfiles;
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return;
    const validKeys = keys.filter((k) => typeof k === "string" && k !== "");
    if (validKeys.length === 0) return;
    const cleanupPatch = {};
    for (const k of validKeys) {
      if (Object.prototype.hasOwnProperty.call(legacy, k)) cleanupPatch[k] = null;
    }
    if (process.platform === "win32") {
      const lowerSet = new Set(validKeys.map((k) => k.toLowerCase()));
      for (const k of Object.keys(legacy)) {
        if (lowerSet.has(k.toLowerCase())) cleanupPatch[k] = null;
      }
    }
    if (Object.keys(cleanupPatch).length > 0) {
      await writeSentenceState({ creationProfiles: cleanupPatch });
    }
  } catch { /* 清理遗留键失败不覆盖已落盘的按书设定 */ }
}

export async function writeBookCreationProfile(root, book, profile) {
  assert(typeof root === "string" && root.trim() !== "", "参数 \"root\" 不能为空字符串");
  const rawBook = requiredString({ book }, "book");
  const safeBook = sanitizeSegment(rawBook, "book");
  const file = settingsFile(root, safeBook);
  const normalized = normalizeCreationProfile(profile);
  let wrote = false;
  await withFileTx(file, async () => {
    let existing = null;
    try {
      existing = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      if (e?.code !== "ENOENT") {
        const isParse = e instanceof SyntaxError || e?.name === "SyntaxError";
        if (isParse) throw Object.assign(new SyntaxError("文件内容不是合法 JSON（解析失败）"), { code: "EPARSE" });
        throw e;
      }
    }
    if (!existing && normalized === null) return;
    if (existing && normalized === null && !Object.prototype.hasOwnProperty.call(existing, "creationProfile")) return;
    const nextData = {
      book: typeof existing?.book === "string" && existing.book.trim() !== "" ? existing.book.trim() : rawBook,
      characters: Array.isArray(existing?.characters) ? existing.characters : [],
      locations: Array.isArray(existing?.locations) ? existing.locations : [],
      items: Array.isArray(existing?.items) ? existing.items : [],
      timeline: Array.isArray(existing?.timeline) ? existing.timeline : [],
      worldview: Array.isArray(existing?.worldview) ? existing.worldview : [],
      ...(normalized ? { creationProfile: normalized } : {})
    };
    await mkdir(dirname(file), { recursive: true });
    await atomicWriteJson(file, nextData);
    wrote = true;
  });
  if (wrote) await noteRoot(root);
  await clearLegacyCreationProfileKeys([rawBook, safeBook]);
  return normalized;
}

export async function clearAllBookCreationProfiles(root) {
  let modifiedAny = false;
  if (typeof root === "string" && root.trim() !== "") {
    const dir = join(novelDataDir(root), "settings");
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const file = join(dir, entry.name);
        await withFileTx(file, async () => {
          let parsed;
          try {
            parsed = JSON.parse(await readFile(file, "utf8"));
          } catch { return; }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
          if (!Object.prototype.hasOwnProperty.call(parsed, "creationProfile")) return;
          const nextData = { ...parsed };
          delete nextData.creationProfile;
          await atomicWriteJson(file, nextData);
          modifiedAny = true;
        });
      }
    } catch { /* settings 目录不存在或不可读时跳过 */ }
  }
  if (modifiedAny) await noteRoot(root);
  try {
    const st = await readSentenceState();
    if (st?.creationProfiles && typeof st.creationProfiles === "object" && Object.keys(st.creationProfiles).length > 0) {
      await writeSentenceState({ creationProfiles: null });
    }
  } catch { /* 清理遗留 state 失败不掩盖结果 */ }
}

export async function applyBookCreationProfilesPatch(root, patch) {
  if (patch === void 0) return { clearedAll: false, updated: [], deleted: [] };
  if (patch === null || (typeof patch === "object" && !Array.isArray(patch) && Object.keys(patch).length === 0)) {
    await clearAllBookCreationProfiles(root);
    return { clearedAll: true, updated: [], deleted: [] };
  }
  assert(typeof patch === "object" && !Array.isArray(patch), "参数 \"creationProfiles\" 必须是键值对象或 null");
  const updated = [];
  const deleted = [];
  for (const book of Object.keys(patch)) {
    if (typeof book !== "string" || book.trim() === "" || CREATION_PROFILE_FORBIDDEN_KEYS.has(book)) continue;
    const res = await writeBookCreationProfile(root, book, patch[book]);
    if (res === null) deleted.push(book);
    else updated.push(book);
  }
  return { clearedAll: false, updated, deleted };
}
export function normalizeSettingEntry(entry) {
  // v4.0.0 修正：脏数据守卫——settings JSON 被手改/半截写坏（[null]/[123]）时
  // 旧版 String(entry.name) 直接 TypeError，导致 list/add/update/scan/detect 整体失败
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const out = { name: String(entry.name ?? "") };
  for (const key of ["description", "traits", "relationships", "firstSeen", "notes", "owner", "status", "lastSeen", "day", "event", "chapter", "basis", "ritual"]) {
    if (entry[key] !== void 0 && entry[key] !== null) out[key] = String(entry[key]);
  }
  if (typeof entry.pack === "string") {
    const pack = entry.pack.trim();
    if (pack !== "") out.pack = pack;
  }
  // v6.5.0：`allowWords`（本书用词豁免）必须进这个白名单——否则它写盘生效、静音也生效，
  // 但 add/list/scan/detect 的**返回体里看不到它**，用户无从核对自己到底豁免了什么
  // （独立核对子代理实测：写盘完整、审计静音正常，而返回值里只有条目名）。
  for (const key of ["alias", "bannedWords", "allowWords"]) {
    if (Array.isArray(entry[key])) out[key] = entry[key].map(String);
  }
  if (entry.recommended !== void 0 && entry.recommended !== null && typeof entry.recommended === "object" && !Array.isArray(entry.recommended)) {
    out.recommended = { ...entry.recommended };
  }
  if (entry.speechStyle !== void 0 && entry.speechStyle !== null && typeof entry.speechStyle === "object" && !Array.isArray(entry.speechStyle)) {
    const speech = {};
    if (typeof entry.speechStyle.title === "string") speech.title = entry.speechStyle.title;
    if (typeof entry.speechStyle.tone === "string") speech.tone = entry.speechStyle.tone;
    if (Array.isArray(entry.speechStyle.honorBad)) speech.honorBad = entry.speechStyle.honorBad.map(String);
    if (entry.speechStyle.honorGood !== void 0 && entry.speechStyle.honorGood !== null && typeof entry.speechStyle.honorGood === "object" && !Array.isArray(entry.speechStyle.honorGood)) speech.honorGood = { ...entry.speechStyle.honorGood };
    if (Array.isArray(entry.speechStyle.ritualBadPatterns)) speech.ritualBadPatterns = entry.speechStyle.ritualBadPatterns.map((x) => String(x));
    if (typeof entry.speechStyle.ritualGoodNote === "string") speech.ritualGoodNote = entry.speechStyle.ritualGoodNote;
    out.speechStyle = speech;
  }
  return out;
}
export function normalizeSettingList(list) {
  return (Array.isArray(list) ? list : []).map(normalizeSettingEntry).filter(Boolean);
}

export function summariesFile(root, book) {
  return join(novelDataDir(root), "summaries", sanitizeSegment(book, "book") + ".json");
}
export async function readSummaries(root, book) {
  try {
    const parsed = JSON.parse(await readFile(summariesFile(root, book), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw Object.assign(new SyntaxError("文件内容不是合法 JSON（解析失败）"), { code: "EPARSE" });
    }
    return Array.isArray(parsed.summaries) ? parsed.summaries : [];
  } catch (e) {
    // v6.6.0：「本章还没有摘要」与「摘要文件读不动/损坏」在 list/get 里长得一样；
    // 本条是 JSON.parse 路径（消息会回显文件内容片段），故只记固定标签，绝不带 e.message
    if (e?.code !== "ENOENT") {
      logEvent("config", { book, file: summariesFile(root, book), level: "warn", detail: "章节摘要读取失败（按无摘要处理）" });
    }
    return [];
  }
}
export function cleanSummaryEntry(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const out = { chapter: String(s.chapter ?? ""), summary: String(s.summary ?? "") };
  if (Array.isArray(s.keyEvents)) out.keyEvents = s.keyEvents.map(String);
  if (Array.isArray(s.keySettings)) out.keySettings = s.keySettings.map(String);
  if (s.updatedAt !== void 0 && s.updatedAt !== null) out.updatedAt = String(s.updatedAt);
  return out;
}
