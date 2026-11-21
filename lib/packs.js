/**
 * dsh-novel-writer — lib/packs.js（外置 JSON 题材规则包：内置包 + 书库自定义包、热加载与安全门禁）
 *
 * DAG 位置：只依赖 Node 内置、./core/state.js、./core/text.js 与 ./log.js（不依赖 core/domain.js），
 * 可被 core/domain.js 与 lib/core.js 安全导入而不引入循环依赖。
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, extname, join, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, noteRoot, novelDataDir, sanitizeSegment, withFileTx } from "./core/state.js";
import { validatePattern } from "./core/text.js";
import { logEvent } from "./log.js";

export const BUILTIN_PACK_IDS = Object.freeze([
  "western-fantasy",
  "eastern-xianxia",
  "modern-urban",
  "mystery-thriller",
  "scifi-cyberpunk"
]);

export const PACK_SCHEMA_V1 = "dsh-novel-writer-pack/v1";
export const PACK_ENVELOPE_HEADER = "[DSH-PACK v1]";
export const PACK_MAX_BYTES = 256 * 1024;
export const PACK_MAX_EXTENDS_DEPTH = 2;

const VALID_CULTURES = new Set(["western", "eastern", "modern"]);
const BUILTIN_PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "packs");
const PACK_ID_RE = /^[a-zA-Z0-9_\u4e00-\u9fff-]{1,64}$/;
const WINDOWS_RESERVED_PACK_ID_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_FILE_CACHE_ENTRIES = 500;
const MAX_SNAPSHOT_CACHE_ENTRIES = 100;
const PACK_PARSE_BUDGET_MS = 50;
const PACK_PARSE_MAX_ATTEMPTS = 50;
const PACK_PARSE_MAX_FENCES = 50;

/** 文件级缓存：realFile -> { mtimeMs, size, ctimeMs, pack, error, warnings } */
const rawFileCache = new Map();
/** 目录快照级缓存：dirKey -> { signature, result } */
const rootSnapshotCache = new Map();

export function packsDir(root) {
  if (typeof root !== "string" || root.trim() === "") return "";
  return join(novelDataDir(root), "packs");
}

function isBuiltinPackId(id) {
  return typeof id === "string" && BUILTIN_PACK_IDS.includes(id.toLowerCase());
}

export function isValidPackId(id) {
  if (typeof id !== "string") return false;
  if (id === "." || id === "..") return false;
  if (/[\\/]/.test(id) || id.includes("..")) return false;
  if (WINDOWS_RESERVED_PACK_ID_RE.test(id)) return false;
  return PACK_ID_RE.test(id);
}

function isInsideDir(baseCanonical, targetCanonical) {
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const prefix = baseCanonical.endsWith(sep) ? baseCanonical : baseCanonical + sep;
  return norm(targetCanonical).startsWith(norm(prefix));
}

function dedupStrings(list, maxItems = 2000, maxLen = 64, { trim = true } = {}) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const s = (trim ? item.trim() : item).slice(0, maxLen);
    if (s === "" || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function cleanStringMap(raw, maxItems = 500, maxKeyLen = 64, maxValLen = 120) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    const key = String(k).trim().slice(0, maxKeyLen);
    if (key === "" || v === void 0 || v === null) continue;
    const val = String(v).trim().slice(0, maxValLen);
    if (val === "") continue;
    out[key] = val;
    count += 1;
    if (count >= maxItems) break;
  }
  return out;
}

function cloneSpeechStyle(speech) {
  if (!speech || typeof speech !== "object") return null;
  return {
    title: String(speech.title ?? ""),
    honorBad: Array.isArray(speech.honorBad) ? speech.honorBad.slice() : [],
    honorGood: speech.honorGood && typeof speech.honorGood === "object" ? { ...speech.honorGood } : {},
    ritualBadPatterns: Array.isArray(speech.ritualBadPatterns) ? speech.ritualBadPatterns.slice() : [],
    ritualGoodNote: String(speech.ritualGoodNote ?? ""),
    tone: String(speech.tone ?? "")
  };
}

function clonePublicPack(pack) {
  if (!pack) return null;
  const out = {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    baseCulture: pack.baseCulture,
    aliases: pack.aliases.slice(),
    bannedWords: pack.bannedWords.slice(),
    recommended: { ...pack.recommended },
    allowWords: pack.allowWords.slice(),
    speechStyle: cloneSpeechStyle(pack.speechStyle),
    slopMuteCategories: pack.slopMuteCategories.slice(),
    source: pack.source
  };
  if (pack.extends) out.extends = pack.extends;
  if (pack.file) out.file = pack.file;
  if (Array.isArray(pack.rejectedPatterns) && pack.rejectedPatterns.length > 0) {
    out.rejectedPatterns = pack.rejectedPatterns.map((r) => ({ ...r }));
  }
  return out;
}

function normalizeSpeechStyle(rawSpeech, ctx) {
  if (rawSpeech === void 0 || rawSpeech === null) return { speechStyle: null, warnings: [], rejectedPatterns: [] };
  if (typeof rawSpeech !== "object" || Array.isArray(rawSpeech)) {
    return {
      speechStyle: null,
      warnings: [{ file: ctx.file, id: ctx.id, reason: "speechStyle 结构非法（已忽略）" }],
      rejectedPatterns: []
    };
  }
  const titleRaw = rawSpeech.title !== void 0 ? rawSpeech.title : rawSpeech.titleGuideline;
  const toneRaw = rawSpeech.tone !== void 0 ? rawSpeech.tone : rawSpeech.toneGuideline;
  const title = typeof titleRaw === "string" ? titleRaw.trim().slice(0, 300) : "";
  const tone = typeof toneRaw === "string" ? toneRaw.trim().slice(0, 300) : "";
  const ritualGoodNote = typeof rawSpeech.ritualGoodNote === "string" ? rawSpeech.ritualGoodNote.trim().slice(0, 300) : "";
  const honorBad = dedupStrings(rawSpeech.honorBad, 500, 60);
  const honorGood = cleanStringMap(rawSpeech.honorGood, 500, 60, 120);

  const warnings = [];
  const rejectedPatterns = [];
  const ritualBadPatterns = [];
  const seenPatterns = new Set();
  if (Array.isArray(rawSpeech.ritualBadPatterns)) {
    for (const item of rawSpeech.ritualBadPatterns) {
      if (typeof item !== "string") {
        warnings.push({ file: ctx.file, id: ctx.id, reason: "题材包仪式正则存在非字符串条目（已剔除）" });
        logEvent("config", { file: ctx.logFile, level: "warn", detail: "题材包仪式正则存在非字符串条目（已剔除）" });
        rejectedPatterns.push({ pattern: "<非字符串>", code: "NON_STRING", reason: "非字符串条目（已剔除）" });
        continue;
      }
      const verdict = validatePattern(item);
      if (!verdict.ok) {
        const codeTag = verdict.code ? " [" + verdict.code + "]" : "";
        warnings.push({ file: ctx.file, id: ctx.id, reason: "题材包仪式正则未通过安全校验（已剔除）" + codeTag });
        logEvent("config", { file: ctx.logFile, level: "warn", detail: "题材包仪式正则未通过安全校验（已剔除）" + codeTag });
        rejectedPatterns.push({
          pattern: item.slice(0, 60),
          code: verdict.code || "INVALID",
          reason: verdict.reason || "未通过安全校验（已剔除）"
        });
        continue;
      }
      if (seenPatterns.has(item)) continue;
      seenPatterns.add(item);
      ritualBadPatterns.push(item);
      if (ritualBadPatterns.length >= 100) break;
    }
  }

  return {
    speechStyle: {
      title,
      honorBad,
      honorGood,
      ritualBadPatterns,
      ritualGoodNote,
      tone
    },
    warnings,
    rejectedPatterns
  };
}

/**
 * 归一化单份原始 JSON 题材规则包对象（含正则安全门禁）。
 * @param {unknown} raw
 * @param {{ defaultId?: string, file?: string, logFile?: string, source?: "builtin"|"custom"|"inline" }} [opts]
 * @returns {{ pack: object|null, error: {file:string, id:string, reason:string}|null, warnings: Array<{file:string, id:string, reason:string}> }}
 */
export function normalizePack(raw, opts = {}) {
  const file = String(opts.file ?? "");
  const logFile = String(opts.logFile ?? file);
  const source = opts.source || "custom";

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      pack: null,
      error: { file, id: "", reason: "题材包结构非法（根节点必须是 JSON 对象）" },
      warnings: []
    };
  }

  let id = "";
  if (raw.id !== void 0) {
    if (typeof raw.id !== "string") {
      return { pack: null, error: { file, id: "", reason: "题材包 id 必须是字符串" }, warnings: [] };
    }
    id = raw.id.trim();
  } else if (typeof opts.defaultId === "string") {
    id = opts.defaultId.trim();
  }

  if (!isValidPackId(id)) {
    return {
      pack: null,
      error: { file, id: "", reason: "题材包 ID 非法（仅允许 1~64 位字母数字下划线连字符或中文）" },
      warnings: []
    };
  }

  const warnings = [];
  const hasName = typeof raw.name === "string" && raw.name.trim() !== "";
  const hasDescription = typeof raw.description === "string" && raw.description.trim() !== "";
  const name = hasName ? raw.name.trim().slice(0, 80) : id;
  const description = typeof raw.description === "string" ? raw.description.trim().slice(0, 300) : "";

  let baseCulture = "";
  if (typeof raw.baseCulture === "string" && raw.baseCulture.trim() !== "") {
    const c = raw.baseCulture.trim();
    if (VALID_CULTURES.has(c)) {
      baseCulture = c;
    } else {
      warnings.push({ file, id, reason: "题材包 baseCulture 不在 western/eastern/modern 内（已忽略）" });
    }
  }

  let extendsTarget = "";
  if (typeof raw.extends === "string" && raw.extends.trim() !== "") {
    const ext = raw.extends.trim();
    if (/[\\/]/.test(ext) || ext.includes("..") || /[\x00-\x1f]/.test(ext) || ext.length > 64) {
      warnings.push({ file, id, reason: "题材包 extends 包含非法字符或超长（已忽略）" });
      logEvent("config", { file: logFile, level: "warn", detail: "题材包 extends 包含非法字符（已忽略）" });
    } else {
      extendsTarget = ext;
    }
  }

  const aliases = dedupStrings(raw.aliases, 50, 64);
  const bannedWords = dedupStrings(raw.bannedWords, 2000, 60);
  const recommended = cleanStringMap(raw.recommended, 500, 60, 120);
  const allowWords = dedupStrings(raw.allowWords, 500, 40);
  const slopMuteCategories = dedupStrings(raw.slopMuteCategories, 20, 40);

  const speechRes = normalizeSpeechStyle(raw.speechStyle, { file, id, logFile });
  warnings.push(...speechRes.warnings);

  const pack = {
    id,
    name,
    description,
    baseCulture,
    aliases,
    bannedWords,
    recommended,
    allowWords,
    speechStyle: speechRes.speechStyle,
    slopMuteCategories,
    rejectedPatterns: speechRes.rejectedPatterns,
    source,
    extends: extendsTarget,
    file,
    _hasName: hasName,
    _hasDescription: hasDescription
  };

  return { pack, error: null, warnings };
}

function setBoundedMap(map, key, val, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest !== void 0) map.delete(oldest);
  }
}

function readCachedPackFile(realFile, fileName, defaultId, source, st) {
  const cached = rawFileCache.get(realFile);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.ctimeMs === st.ctimeMs) {
    return cached;
  }

  let parsed;
  try {
    const rawText = readFileSync(realFile, "utf8");
    parsed = JSON.parse(rawText);
  } catch {
    // 隐私红线：绝不透传 SyntaxError.message 中的文件内容片段
    logEvent("config", { file: realFile, level: "warn", detail: "题材规则包 JSON 解析失败（已跳过）" });
    const entry = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      ctimeMs: st.ctimeMs,
      pack: null,
      error: { file: fileName, id: "", reason: "文件内容不是合法 JSON（解析失败）" },
      warnings: []
    };
    setBoundedMap(rawFileCache, realFile, entry, MAX_FILE_CACHE_ENTRIES);
    return entry;
  }

  const normalized = normalizePack(parsed, { defaultId, file: fileName, logFile: realFile, source });
  const entry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    ctimeMs: st.ctimeMs,
    pack: normalized.pack,
    error: normalized.error,
    warnings: normalized.warnings
  };
  setBoundedMap(rawFileCache, realFile, entry, MAX_FILE_CACHE_ENTRIES);
  return entry;
}

function loadBuiltinPacks() {
  const packs = [];
  const errors = [];
  const warnings = [];
  for (const id of BUILTIN_PACK_IDS) {
    const fileName = id + ".json";
    const full = join(BUILTIN_PACKS_DIR, fileName);
    try {
      const st = statSync(full);
      const entry = readCachedPackFile(full, fileName, id, "builtin", st);
      if (entry.error) errors.push(entry.error);
      if (entry.warnings.length > 0) warnings.push(...entry.warnings);
      if (entry.pack) packs.push(entry.pack);
    } catch {
      errors.push({ file: fileName, id, reason: "内置题材包文件读取失败" });
    }
  }
  return { packs, errors, warnings };
}

function dedupRejectedPatterns(a, b) {
  const seen = new Set();
  const out = [];
  for (const list of [a, b]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const pattern = String(item.pattern ?? "");
      const code = String(item.code ?? "INVALID");
      const key = pattern + "|" + code;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pattern, code, reason: String(item.reason ?? "") });
      if (out.length >= 200) return out;
    }
  }
  return out;
}

function mergeTwoPacks(parent, child) {
  const pSpeech = parent.speechStyle;
  const cSpeech = child.speechStyle;
  let speechStyle = null;
  if (pSpeech || cSpeech) {
    const ps = pSpeech || { title: "", honorBad: [], honorGood: {}, ritualBadPatterns: [], ritualGoodNote: "", tone: "" };
    const cs = cSpeech || { title: "", honorBad: [], honorGood: {}, ritualBadPatterns: [], ritualGoodNote: "", tone: "" };
    speechStyle = {
      title: cs.title || ps.title || "",
      honorBad: dedupStrings([...ps.honorBad, ...cs.honorBad], 500, 60),
      honorGood: { ...ps.honorGood, ...cs.honorGood },
      ritualBadPatterns: dedupStrings([...ps.ritualBadPatterns, ...cs.ritualBadPatterns], 100, 200, { trim: false }),
      ritualGoodNote: cs.ritualGoodNote || ps.ritualGoodNote || "",
      tone: cs.tone || ps.tone || ""
    };
  }

  const hasName = child._hasName || parent._hasName;
  const name = child._hasName ? child.name : (parent._hasName ? parent.name : child.id);
  const hasDescription = child._hasDescription || parent._hasDescription;
  const description = child._hasDescription ? child.description : parent.description;

  return {
    id: child.id,
    name,
    description,
    baseCulture: child.baseCulture || parent.baseCulture,
    // 继承只复用规则，不继承父包别名（避免子包劫持父包别名查找）
    aliases: child.aliases.slice(),
    bannedWords: dedupStrings([...parent.bannedWords, ...child.bannedWords], 2000, 60),
    recommended: { ...parent.recommended, ...child.recommended },
    allowWords: dedupStrings([...parent.allowWords, ...child.allowWords], 500, 40),
    speechStyle,
    slopMuteCategories: dedupStrings([...parent.slopMuteCategories, ...child.slopMuteCategories], 20, 40),
    rejectedPatterns: dedupRejectedPatterns(parent.rejectedPatterns, child.rejectedPatterns),
    source: child.source,
    extends: child.extends,
    file: child.file,
    _hasName: hasName,
    _hasDescription: hasDescription
  };
}

function findRawPack(rawList, rawById, query) {
  if (!query) return null;
  if (rawById.has(query)) return rawById.get(query);
  const lower = query.toLowerCase();
  for (const p of rawList) {
    if (p.id.toLowerCase() === lower) return p;
  }
  for (const p of rawList) {
    if (p.aliases.some((a) => a.toLowerCase() === lower)) return p;
  }
  return null;
}

function resolveAllExtends(rawPacks, warnings) {
  const rawById = new Map();
  // 自定义优先放在查找列表前面（用于 alias 命中时自定义优先）
  const orderedForLookup = [];
  for (const p of rawPacks) {
    rawById.set(p.id, p);
  }
  const dedupedList = [...rawById.values()];
  for (const p of dedupedList) {
    if (p.source === "custom") orderedForLookup.push(p);
  }
  for (const p of dedupedList) {
    if (p.source !== "custom") orderedForLookup.push(p);
  }

  const resolvedPacks = [];
  for (const pack of dedupedList) {
    if (!pack.extends) {
      resolvedPacks.push(clonePublicPack(pack));
      continue;
    }
    const visited = new Set([pack.id]);
    const chain = [pack];
    let cur = pack;
    for (let depth = 0; depth < PACK_MAX_EXTENDS_DEPTH; depth += 1) {
      if (!cur.extends) break;
      const parent = findRawPack(orderedForLookup, rawById, cur.extends);
      if (!parent) {
        warnings.push({ file: pack.file, id: pack.id, reason: "题材包继承目标不存在（已跳过继承）" });
        logEvent("config", { file: pack.file, level: "warn", detail: "题材包继承目标不存在（已跳过继承）" });
        break;
      }
      if (visited.has(parent.id)) {
        warnings.push({ file: pack.file, id: pack.id, reason: "检测到题材包循环继承（已安全打断）" });
        logEvent("config", { file: pack.file, level: "warn", detail: "检测到题材包循环继承（已安全打断）" });
        break;
      }
      visited.add(parent.id);
      chain.push(parent);
      cur = parent;
    }
    if (chain.length === PACK_MAX_EXTENDS_DEPTH + 1 && cur.extends) {
      const next = findRawPack(orderedForLookup, rawById, cur.extends);
      const isCycle = next && visited.has(next.id);
      const reason = isCycle
        ? "检测到题材包循环继承（已安全打断）"
        : "题材包继承深度超过 2 层（已安全截断）";
      warnings.push({ file: pack.file, id: pack.id, reason });
      logEvent("config", { file: pack.file, level: "warn", detail: reason });
    }
    let merged = chain[chain.length - 1];
    for (let i = chain.length - 2; i >= 0; i -= 1) {
      merged = mergeTwoPacks(merged, chain[i]);
    }
    resolvedPacks.push(clonePublicPack(merged));
  }
  return resolvedPacks;
}

function getPackSnapshot(root) {
  const dir = packsDir(root);
  const builtin = loadBuiltinPacks();

  let dirCanonical = "";
  let dirStatus = "missing";
  if (dir !== "") {
    try {
      dirCanonical = realpathSync(dir);
      const st = statSync(dirCanonical);
      dirStatus = st.isDirectory() ? "ok" : "not-dir";
    } catch (e) {
      dirStatus = e?.code === "ENOENT" ? "missing" : "unreadable";
    }
  }

  const builtinSig = builtin.packs.map((p) => p.id + ":" + p.file).join(",");
  if (dirStatus !== "ok") {
    const cacheKey = dir || "__builtin__";
    const sig = builtinSig + "|" + dirStatus;
    const cached = rootSnapshotCache.get(cacheKey);
    if (cached && cached.signature === sig) return cached.snapshot;

    const errors = [...builtin.errors];
    const warnings = [...builtin.warnings];
    if (dirStatus === "not-dir") {
      errors.push({ file: dir, id: "", reason: "packs 路径存在但不是目录" });
    } else if (dirStatus === "unreadable") {
      errors.push({ file: dir, id: "", reason: "题材包目录无法读取" });
    }
    const rawById = new Map();
    for (const p of builtin.packs) rawById.set(p.id, p);
    const resolvedPacks = resolveAllExtends(builtin.packs, warnings);
    const byId = new Map(resolvedPacks.map((p) => [p.id, p]));
    const snapshot = {
      dir,
      packs: resolvedPacks,
      byId,
      rawById,
      customPacks: [],
      customByFile: new Map(),
      errors,
      warnings
    };
    setBoundedMap(rootSnapshotCache, cacheKey, { signature: sig, snapshot }, MAX_SNAPSHOT_CACHE_ENTRIES);
    return snapshot;
  }

  let dirEntries = [];
  try {
    dirEntries = readdirSync(dirCanonical, { withFileTypes: true })
      .filter((e) => extname(e.name).toLowerCase() === ".json")
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    const warnings = [...builtin.warnings];
    const rawById = new Map();
    for (const p of builtin.packs) rawById.set(p.id, p);
    const resolvedPacks = resolveAllExtends(builtin.packs, warnings);
    const byId = new Map(resolvedPacks.map((p) => [p.id, p]));
    return {
      dir,
      packs: resolvedPacks,
      byId,
      rawById,
      customPacks: [],
      customByFile: new Map(),
      errors: [...builtin.errors, { file: dir, id: "", reason: "题材包目录无法列出" }],
      warnings
    };
  }

  const metaItems = [];
  const sigParts = [builtinSig];
  for (const entry of dirEntries) {
    const candidate = join(dirCanonical, entry.name);
    let realFile = "";
    try {
      realFile = realpathSync(candidate);
    } catch {
      metaItems.push({ kind: "error", file: entry.name, reason: "题材包路径无效或悬空符号链接", candidate });
      sigParts.push(entry.name + ":broken-link");
      continue;
    }
    if (!isInsideDir(dirCanonical, realFile)) {
      metaItems.push({ kind: "error", file: entry.name, reason: "题材包路径越界（拒绝符号链接逃逸）", candidate });
      sigParts.push(entry.name + ":escape");
      continue;
    }
    let st;
    try {
      st = statSync(realFile);
    } catch {
      metaItems.push({ kind: "error", file: entry.name, reason: "题材包文件无法读取属性", candidate: realFile });
      sigParts.push(entry.name + ":unstat");
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size === 0) {
      metaItems.push({ kind: "error", file: entry.name, reason: "题材包文件为空（0 字节）", candidate: realFile });
      sigParts.push(entry.name + ":0");
      continue;
    }
    if (st.size > PACK_MAX_BYTES) {
      metaItems.push({ kind: "error", file: entry.name, reason: "题材包文件超过 256 KB 上限", candidate: realFile });
      sigParts.push(entry.name + ":oversize:" + st.size);
      continue;
    }
    metaItems.push({ kind: "file", file: entry.name, realFile, st });
    sigParts.push(`${entry.name}|${realFile}|${st.mtimeMs}|${st.ctimeMs}|${st.size}`);
  }

  const signature = sigParts.join(";");
  const cachedSnap = rootSnapshotCache.get(dirCanonical);
  if (cachedSnap && cachedSnap.signature === signature) {
    return cachedSnap.snapshot;
  }

  const customRaw = [];
  const errors = [...builtin.errors];
  const warnings = [...builtin.warnings];
  for (const item of metaItems) {
    if (item.kind === "error") {
      errors.push({ file: item.file, id: "", reason: item.reason });
      logEvent("config", { file: item.candidate, level: "warn", detail: item.reason });
      continue;
    }
    const defaultId = item.file.replace(/\.json$/i, "");
    const entry = readCachedPackFile(item.realFile, item.file, defaultId, "custom", item.st);
    if (entry.error) errors.push(entry.error);
    if (entry.warnings.length > 0) warnings.push(...entry.warnings);
    if (entry.pack) customRaw.push(entry.pack);
  }

  const combinedRaw = [...builtin.packs, ...customRaw];
  const rawById = new Map();
  for (const p of combinedRaw) rawById.set(p.id, p);
  const resolvedPacks = resolveAllExtends(combinedRaw, warnings);
  const byId = new Map();
  const customPacks = [];
  const customByFile = new Map();
  for (const p of resolvedPacks) {
    byId.set(p.id, p);
    if (p.source === "custom") {
      customPacks.push(p);
      if (p.file) customByFile.set(p.file, p);
    }
  }

  const snapshot = {
    dir,
    packs: resolvedPacks,
    byId,
    rawById,
    customPacks,
    customByFile,
    errors,
    warnings
  };
  setBoundedMap(rootSnapshotCache, dirCanonical, { signature, snapshot }, MAX_SNAPSHOT_CACHE_ENTRIES);
  return snapshot;
}

/**
 * 列出所有可用题材规则包（内置 + 书库自定义），自动热加载。
 * @param {string} [root]
 * @returns {{ dir: string, packs: object[], errors: Array<{file:string, id:string, reason:string}>, warnings: Array<{file:string, id:string, reason:string}> }}
 */
export function listPacks(root) {
  const snap = getPackSnapshot(root);
  return {
    dir: snap.dir,
    packs: snap.packs.map(clonePublicPack),
    errors: snap.errors.map((e) => ({ ...e })),
    warnings: snap.warnings.map((w) => ({ ...w }))
  };
}

/**
 * 按 ID 或别名加载单个题材规则包（内置优先被同名自定义包覆盖；别名不区分大小写且自定义优先）。
 * @param {string} idOrAlias
 * @param {string} [root]
 * @returns {object|null}
 */
export function loadPack(idOrAlias, root) {
  if (typeof idOrAlias !== "string") return null;
  const query = idOrAlias.trim();
  if (query === "" || /[\\/]/.test(query) || query.includes("..") || /[\x00-\x1f]/.test(query)) {
    return null;
  }
  const snap = getPackSnapshot(root);
  if (snap.byId.has(query)) {
    return clonePublicPack(snap.byId.get(query));
  }
  const lower = query.toLowerCase();
  for (const p of snap.packs) {
    if (p.id.toLowerCase() === lower) return clonePublicPack(p);
  }
  // 别名匹配：自定义包优先
  for (const p of snap.customPacks) {
    if (p.aliases.some((a) => a.toLowerCase() === lower)) return clonePublicPack(p);
  }
  for (const p of snap.packs) {
    if (p.source !== "custom" && p.aliases.some((a) => a.toLowerCase() === lower)) {
      return clonePublicPack(p);
    }
  }
  return null;
}

/**
 * 为指定书籍解析生效的题材规则包：
 *   1) 若显式传入非空 `packId`，调用 `loadPack(packId, root)`（未找到返回 null）；
 *   2) 若未传 `packId`，仅当 `<root>/.novel-writer/packs/<book>.json`（或 `<sanitizeSegment(book)>.json`）存在且合法时自动启用；否则返回 null。
 * @param {{ packId?: string, book?: string, root?: string }} [opts]
 * @returns {object|null}
 */
export function resolvePackForBook(opts = {}) {
  const packId = typeof opts?.packId === "string" ? opts.packId.trim() : "";
  const root = typeof opts?.root === "string" ? opts.root : "";
  if (packId !== "") {
    return loadPack(packId, root);
  }
  const rawBook = typeof opts?.book === "string" ? opts.book.trim() : "";
  if (rawBook === "" || root.trim() === "") return null;

  let safeBook = "";
  try {
    safeBook = sanitizeSegment(rawBook, "book");
  } catch {
    safeBook = "";
  }
  const snap = getPackSnapshot(root);
  if (snap.customByFile.size === 0) return null;

  const candidates = [];
  if (!/[\\/]/.test(rawBook) && !rawBook.includes("..")) {
    candidates.push(rawBook + ".json");
  }
  if (safeBook !== "" && safeBook + ".json" !== candidates[0]) {
    candidates.push(safeBook + ".json");
  }
  for (const fileName of candidates) {
    if (snap.customByFile.has(fileName)) {
      return clonePublicPack(snap.customByFile.get(fileName));
    }
  }
  return null;
}

/**
 * 获取未展开 extends 的原始规则包对象（供可视化编辑器 / 分享导出使用，保留继承增量语义）。
 * @param {string} id
 * @param {string} [root]
 * @returns {object|null}
 */
export function getRawPack(id, root) {
  if (typeof id !== "string") return null;
  const query = id.trim();
  if (query === "" || /[\\/]/.test(query) || query.includes("..") || /[\x00-\x1f]/.test(query)) {
    return null;
  }
  const snap = getPackSnapshot(root);
  if (snap.rawById.has(query)) {
    return clonePublicPack(snap.rawById.get(query));
  }
  const lower = query.toLowerCase();
  for (const p of snap.rawById.values()) {
    if (p.id.toLowerCase() === lower) return clonePublicPack(p);
  }
  return null;
}

/**
 * 清空指定书库（或全部）的题材规则包缓存，确保写删操作立即生效。
 * @param {string} [root]
 */
export function invalidatePackCache(root) {
  if (typeof root !== "string" || root.trim() === "") {
    rootSnapshotCache.clear();
    rawFileCache.clear();
    return;
  }
  const dir = packsDir(root);
  if (!dir) {
    rootSnapshotCache.delete("__builtin__");
    return;
  }
  rootSnapshotCache.delete(dir);
  let dirCanonical = "";
  try {
    dirCanonical = realpathSync(dir);
    rootSnapshotCache.delete(dirCanonical);
  } catch { /* ignore */ }
  for (const key of [...rawFileCache.keys()]) {
    if (isInsideDir(dir, key) || (dirCanonical && isInsideDir(dirCanonical, key))) {
      rawFileCache.delete(key);
    }
  }
}

/**
 * 转为可序列化的纯净规则包 JSON 对象（去除运行时内部字段，对齐内置包字段风格）。
 * @param {object} pack
 * @returns {object}
 */
export function toSerializablePack(pack) {
  const src = pack && typeof pack === "object" ? pack : {};
  const out = {
    schema: PACK_SCHEMA_V1,
    id: String(src.id ?? "").trim(),
    name: String(src.name ?? src.id ?? "").trim(),
    description: String(src.description ?? "").trim()
  };
  const baseCulture = typeof src.baseCulture === "string" ? src.baseCulture.trim() : "";
  if (baseCulture !== "") out.baseCulture = baseCulture;
  const ext = typeof src.extends === "string" ? src.extends.trim() : "";
  if (ext !== "") out.extends = ext;
  const aliases = Array.isArray(src.aliases) ? src.aliases.filter((s) => typeof s === "string" && s.trim() !== "").map((s) => s.trim()) : [];
  if (aliases.length > 0) out.aliases = aliases;

  out.bannedWords = Array.isArray(src.bannedWords) ? src.bannedWords.slice() : [];
  out.recommended = src.recommended && typeof src.recommended === "object" && !Array.isArray(src.recommended)
    ? { ...src.recommended }
    : {};
  out.allowWords = Array.isArray(src.allowWords) ? src.allowWords.slice() : [];

  const sp = src.speechStyle && typeof src.speechStyle === "object" && !Array.isArray(src.speechStyle)
    ? src.speechStyle
    : null;
  if (sp) {
    const titleGuideline = String(sp.titleGuideline ?? sp.title ?? "").trim();
    const honorBad = Array.isArray(sp.honorBad) ? sp.honorBad.slice() : [];
    const honorGood = sp.honorGood && typeof sp.honorGood === "object" && !Array.isArray(sp.honorGood)
      ? { ...sp.honorGood }
      : {};
    const ritualBadPatterns = Array.isArray(sp.ritualBadPatterns) ? sp.ritualBadPatterns.slice() : [];
    const ritualGoodNote = String(sp.ritualGoodNote ?? "").trim();
    const toneGuideline = String(sp.toneGuideline ?? sp.tone ?? "").trim();
    if (
      titleGuideline !== "" || honorBad.length > 0 || Object.keys(honorGood).length > 0 ||
      ritualBadPatterns.length > 0 || ritualGoodNote !== "" || toneGuideline !== ""
    ) {
      out.speechStyle = {
        titleGuideline,
        honorBad,
        honorGood,
        ritualBadPatterns,
        ritualGoodNote,
        toneGuideline
      };
    }
  }

  out.slopMuteCategories = Array.isArray(src.slopMuteCategories) ? src.slopMuteCategories.slice() : [];
  return out;
}

/**
 * 生成格式化的纯 JSON 文件文本。
 * @param {object} pack
 * @returns {string}
 */
export function formatPackJson(pack) {
  return JSON.stringify(toSerializablePack(pack), null, 2) + "\n";
}

/**
 * 生成人类可读的 `[DSH-PACK v1]` 分享信封文本（可直接粘贴至聊天群 / 仓库）。
 * @param {object} pack
 * @returns {string}
 */
export function formatPackEnvelope(pack) {
  const clean = toSerializablePack(pack);
  const body = JSON.stringify(clean, null, 2);
  return `${PACK_ENVELOPE_HEADER} ${clean.name || clean.id} (${clean.id})\n\`\`\`json\n${body}\n\`\`\``;
}

function isPlainJsonObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function pickBestParsedObject(candidates) {
  if (!candidates || candidates.length === 0) return null;
  const preferred = candidates.find((o) => o.schema === PACK_SCHEMA_V1 || typeof o.id === "string");
  return preferred || candidates[0];
}

function looksLikeJsonObjectStart(text, openIdx, len) {
  let j = openIdx + 1;
  while (j < len) {
    const code = text.charCodeAt(j);
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      j += 1;
      continue;
    }
    return code === 34 /* " */ || code === 125 /* } */;
  }
  return false;
}

function extractFencedJsonObjects(text, deadline) {
  const results = [];
  const len = text.length;
  let pos = 0;
  let fences = 0;
  let attempts = 0;
  let tooComplex = false;

  while (pos < len) {
    const open = text.indexOf("```", pos);
    if (open === -1) break;
    fences += 1;
    if (fences > PACK_PARSE_MAX_FENCES || performance.now() > deadline) {
      tooComplex = true;
      break;
    }
    let headerStart = open + 3;
    const close = text.indexOf("```", headerStart);
    if (close === -1) break;

    let body = text.slice(headerStart, close).trim();
    if (
      body.length >= 4 &&
      (body.charCodeAt(0) === 106 || body.charCodeAt(0) === 74) &&
      (body.charCodeAt(1) === 115 || body.charCodeAt(1) === 83) &&
      (body.charCodeAt(2) === 111 || body.charCodeAt(2) === 79) &&
      (body.charCodeAt(3) === 110 || body.charCodeAt(3) === 78)
    ) {
      body = body.slice(4).trim();
    }
    if (body.startsWith("{") && body.endsWith("}")) {
      attempts += 1;
      if (attempts > PACK_PARSE_MAX_ATTEMPTS || performance.now() > deadline) {
        tooComplex = true;
        break;
      }
      try {
        const obj = JSON.parse(body);
        if (isPlainJsonObject(obj)) {
          results.push(obj);
          if (results.length >= 10) break;
        }
      } catch { /* ignore invalid block */ }
    }
    pos = close + 3;
  }
  return { results, tooComplex };
}

function extractBalancedJsonObjects(text, deadline) {
  const results = [];
  const len = text.length;
  const openStack = [];
  const spanStarts = [];
  const spanEnds = [];
  let inString = false;
  let escaped = false;
  let tooComplex = false;

  for (let i = 0; i < len; i += 1) {
    if ((i & 4095) === 0 && performance.now() > deadline) {
      tooComplex = true;
      break;
    }
    const code = text.charCodeAt(i);
    if (inString) {
      if (code === 10 /* \n */ || code === 13 /* \r */) {
        inString = false;
        escaped = false;
      } else if (escaped) {
        escaped = false;
      } else if (code === 92 /* \ */) {
        escaped = true;
      } else if (code === 34 /* " */) {
        inString = false;
      }
      continue;
    }
    if (code === 34 /* " */) {
      if (openStack.length > 0) inString = true;
      continue;
    }
    if (code === 123 /* { */) {
      const validOpen = looksLikeJsonObjectStart(text, i, len);
      openStack.push(validOpen ? i : -(i + 1));
    } else if (code === 125 /* } */) {
      if (openStack.length === 0) continue;
      const start = openStack.pop();
      if (start < 0) continue;
      // Only retain outermost JSON-looking spans so nested properties/objects collapse in O(1).
      while (spanStarts.length > 0 && spanStarts[spanStarts.length - 1] > start) {
        spanStarts.pop();
        spanEnds.pop();
      }
      spanStarts.push(start);
      spanEnds.push(i);
    }
  }

  let attempts = 0;
  for (let s = 0; s < spanStarts.length; s += 1) {
    if (performance.now() > deadline) {
      tooComplex = true;
      break;
    }
    attempts += 1;
    if (attempts > PACK_PARSE_MAX_ATTEMPTS) {
      tooComplex = true;
      break;
    }
    try {
      const parsed = JSON.parse(text.slice(spanStarts[s], spanEnds[s] + 1));
      if (isPlainJsonObject(parsed)) {
        results.push(parsed);
        if (results.length >= 10) break;
      }
    } catch {
      /* 继续尝试下一个候选对象 */
    }
  }
  return { results, tooComplex };
}

function parseRawPackString(rawText) {
  const cleaned = String(rawText ?? "").replace(/^\uFEFF/, "").trim();
  if (cleaned === "") return { ok: false, empty: true, tooComplex: false };

  const deadline = performance.now() + PACK_PARSE_BUDGET_MS;

  // 1) 直接 JSON
  if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
    try {
      const direct = JSON.parse(cleaned);
      if (isPlainJsonObject(direct)) return { ok: true, data: direct };
    } catch { /* fall through */ }
  }

  // 2) Markdown ```json / ``` 代码块（线性扫描 + 次数/时间预算）
  const fenced = extractFencedJsonObjects(cleaned, deadline);
  const pickedFenced = pickBestParsedObject(fenced.results);
  if (pickedFenced) return { ok: true, data: pickedFenced };
  if (performance.now() > deadline) {
    return { ok: false, empty: false, tooComplex: true };
  }

  // 3) 剥离反引号后的顶层配平 {...} 抽取（单遍 O(n) 栈式扫描 + 尝试/时间预算）
  const balanced = extractBalancedJsonObjects(cleaned, deadline);
  const pickedBalanced = pickBestParsedObject(balanced.results);
  if (pickedBalanced) return { ok: true, data: pickedBalanced };

  return { ok: false, empty: false, tooComplex: Boolean(fenced.tooComplex || balanced.tooComplex) };
}

/**
 * 解析并干跑校验外部粘贴文本或 JSON 对象（绝不写盘、绝不泄漏 JSON 解析原文片段）。
 * @param {unknown} rawInput
 * @param {{ root?: string, defaultId?: string, file?: string, idOverride?: string }} [opts]
 * @returns {object}
 */
export function parsePackInput(rawInput, opts = {}) {
  let obj = null;
  if (typeof rawInput === "string") {
    if (Buffer.byteLength(rawInput, "utf8") > PACK_MAX_BYTES) {
      return { ok: false, error: "题材包内容超过 256 KB 上限", warnings: [] };
    }
    const extracted = parseRawPackString(rawInput);
    if (!extracted.ok) {
      return {
        ok: false,
        error: extracted.empty
          ? "请输入题材规则包文本或选择 JSON 文件"
          : extracted.tooComplex
            ? "输入文本结构过于复杂，请改用 .json 文件导入"
            : "未识别到合法的题材规则包 JSON（支持纯 JSON、```json 代码块或 [DSH-PACK v1] 分享文本）",
        warnings: []
      };
    }
    obj = extracted.data;
  } else if (isPlainJsonObject(rawInput)) {
    obj = rawInput;
  } else {
    return { ok: false, error: "题材包输入必须是分享文本、JSON 字符串或 JSON 对象", warnings: [] };
  }

  const idOverride = typeof opts.idOverride === "string" ? opts.idOverride.trim() : "";
  const candidate = idOverride !== "" ? { ...obj, id: idOverride } : obj;
  const normalized = normalizePack(candidate, {
    defaultId: typeof opts.defaultId === "string" ? opts.defaultId.trim() : "",
    file: String(opts.file || "import.json"),
    logFile: String(opts.file || "import.json"),
    source: "custom"
  });
  if (normalized.error || !normalized.pack) {
    return {
      ok: false,
      error: normalized.error?.reason || "题材包格式校验未通过",
      warnings: normalized.warnings || []
    };
  }

  const serializable = toSerializablePack(normalized.pack);
  const json = formatPackJson(normalized.pack);
  if (Buffer.byteLength(json, "utf8") > PACK_MAX_BYTES) {
    return { ok: false, error: "归一化后的题材包超过 256 KB 上限", warnings: normalized.warnings || [] };
  }
  const envelope = formatPackEnvelope(normalized.pack);
  const pack = clonePublicPack(normalized.pack);
  const promptTexts = {
    description: pack.description || "",
    titleGuideline: pack.speechStyle?.title || "",
    toneGuideline: pack.speechStyle?.tone || "",
    ritualGoodNote: pack.speechStyle?.ritualGoodNote || ""
  };

  const root = typeof opts.root === "string" ? opts.root.trim() : "";
  const isBuiltinId = isBuiltinPackId(pack.id);
  let existsCustom = false;
  let extendsMissing = false;
  const extTarget = pack.extends || "";
  if (root !== "") {
    const dir = packsDir(root);
    if (dir !== "") {
      try {
        existsCustom = existsSync(join(dir, pack.id + ".json"));
      } catch { existsCustom = false; }
    }
    if (extTarget !== "") {
      const snap = getPackSnapshot(root);
      const allRaw = [...snap.rawById.values()];
      const parent = findRawPack(allRaw, snap.rawById, extTarget);
      extendsMissing = !parent;
    }
  }

  return {
    ok: true,
    pack,
    serializable,
    json,
    envelope,
    warnings: normalized.warnings || [],
    rejectedPatterns: pack.rejectedPatterns || [],
    promptTexts,
    conflict: { isBuiltinId, existsCustom },
    extendsInfo: { target: extTarget, missing: extendsMissing }
  };
}

/**
 * 原子保存自定义题材规则包到 `<root>/.novel-writer/packs/<id>.json`。
 * @param {string} root
 * @param {unknown} rawInput
 * @param {{ overwrite?: boolean, idOverride?: string, defaultId?: string, file?: string }} [opts]
 * @returns {Promise<object>}
 */
export async function saveCustomPack(root, rawInput, opts = {}) {
  const rootStr = typeof root === "string" ? root.trim() : "";
  if (rootStr === "") {
    return { ok: false, status: 400, error: "书库根目录不能为空", warnings: [] };
  }
  const parsed = parsePackInput(rawInput, {
    root: rootStr,
    defaultId: opts.defaultId,
    file: opts.file || "custom.json",
    idOverride: opts.idOverride
  });
  if (!parsed.ok) {
    return { ok: false, status: 400, error: parsed.error, warnings: parsed.warnings || [] };
  }
  const packId = parsed.pack.id;
  if (isBuiltinPackId(packId)) {
    return {
      ok: false,
      status: 400,
      code: "BUILTIN_ID",
      error: `不能使用内置规则包 ID「${packId}」，请修改 ID（如 ${packId}-custom）`,
      warnings: parsed.warnings
    };
  }

  const dir = packsDir(rootStr);
  await mkdir(dir, { recursive: true });
  const dirCanonical = realpathSync(dir);
  const targetFile = join(dirCanonical, packId + ".json");
  const txError = await withFileTx(targetFile, async () => {
    let lst = null;
    try {
      lst = lstatSync(targetFile);
    } catch (err) {
      if (err?.code !== "ENOENT") {
        return { ok: false, status: 400, error: "无法读取目标规则包路径", warnings: parsed.warnings };
      }
    }
    if (lst !== null) {
      if (lst.isSymbolicLink()) {
        return { ok: false, status: 400, error: "拒绝写入符号链接目标", warnings: parsed.warnings };
      }
      if (!lst.isFile()) {
        return { ok: false, status: 400, error: "目标规则包路径不是普通文件", warnings: parsed.warnings };
      }
      let realTarget = "";
      try {
        realTarget = realpathSync(targetFile);
      } catch {
        return { ok: false, status: 400, error: "无法解析目标规则包真实路径", warnings: parsed.warnings };
      }
      if (!isInsideDir(dirCanonical, realTarget)) {
        return { ok: false, status: 400, error: "题材包路径越界（拒绝逃逸写入）", warnings: parsed.warnings };
      }
      if (opts.overwrite !== true) {
        return {
          ok: false,
          status: 409,
          code: "PACK_EXISTS",
          existingId: packId,
          error: `已存在同名自定义规则包「${packId}」，请勾选覆盖或改名另存`,
          warnings: parsed.warnings
        };
      }
    }
    await atomicWriteJson(targetFile, parsed.serializable);
    return null;
  });
  if (txError) return txError;
  await noteRoot(rootStr);
  invalidatePackCache(rootStr);
  logEvent("config", { action: "pack_save", detail: packId });
  return {
    ok: true,
    status: 200,
    id: packId,
    file: targetFile,
    pack: parsed.pack,
    serializable: parsed.serializable,
    warnings: parsed.warnings,
    rejectedPatterns: parsed.rejectedPatterns
  };
}

/**
 * 删除指定的自定义题材规则包（拒绝删除内置包，防符号链接越界）。
 * @param {string} root
 * @param {string} packId
 * @returns {Promise<object>}
 */
export async function deleteCustomPack(root, packId) {
  const rootStr = typeof root === "string" ? root.trim() : "";
  const id = typeof packId === "string" ? packId.trim() : "";
  if (rootStr === "" || !isValidPackId(id)) {
    return { ok: false, status: 400, error: "invalid pack id" };
  }
  if (isBuiltinPackId(id)) {
    return { ok: false, status: 400, error: "内置规则包不可删除" };
  }
  const dir = packsDir(rootStr);
  if (!dir || !existsSync(dir)) {
    return { ok: false, status: 404, error: "未找到自定义规则包：" + id };
  }
  let dirCanonical = "";
  try {
    dirCanonical = realpathSync(dir);
  } catch {
    return { ok: false, status: 404, error: "未找到自定义规则包：" + id };
  }
  const targetFile = join(dirCanonical, id + ".json");
  const txError = await withFileTx(targetFile, async () => {
    let lst;
    try {
      lst = lstatSync(targetFile);
    } catch (err) {
      if (err?.code === "ENOENT") {
        return { ok: false, status: 404, error: "未找到自定义规则包：" + id };
      }
      return { ok: false, status: 400, error: "无法读取目标规则包路径" };
    }
    if (lst.isSymbolicLink()) {
      return { ok: false, status: 400, error: "拒绝删除符号链接目标" };
    }
    if (!lst.isFile()) {
      return { ok: false, status: 400, error: "目标规则包路径不是普通文件" };
    }
    let realTarget = "";
    try {
      realTarget = realpathSync(targetFile);
    } catch {
      return { ok: false, status: 400, error: "无法解析目标规则包真实路径" };
    }
    if (!isInsideDir(dirCanonical, realTarget)) {
      return { ok: false, status: 400, error: "题材包路径越界（拒绝删除）" };
    }
    await unlink(targetFile);
    return null;
  });
  if (txError) return txError;
  invalidatePackCache(rootStr);
  logEvent("config", { action: "pack_delete", detail: id });
  return { ok: true, status: 200, deleted: id };
}
