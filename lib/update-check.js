/**
 * v2.6.5 更新检查（update-check.js）——设计移植自 Archon #1039（coleam00/Archon commit 6f1b72e）
 * - GitHub Releases API 获取最新版：GET /repos/<repo>/releases/latest
 * - 24h 缓存（update-check.json，避免 GitHub API 匿名限流 60 次/小时）
 * - 5min 失败负缓存（v4.3.0：独立文件 update-check-error.json，不再与成功缓存争同一个文件）
 * - 3s 超时 + 全程静默失败（任何异常都不抛，绝不影响插件功能）
 * - 语义化版本对比：按数字逐段比较（2.10 > 2.9），非字符串比较
 * - v4.3.0：返回值升级为稳定形状 { ok, stale, lastSuccess, checkedAt, updateAvailable, ... }——
 *   调用方（core.js 路由 / client.js 更新条）从此能区分"已是最新"与"检查失败/被限流"；
 *   失败但有历史成功记录时仍回历史 latestVersion/releaseUrl，UI 至少能显示"上次检查到的版本"
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "siweina/dsh-novel-writer";
const GITHUB_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_FILE = "update-check.json";
// v4.3.0 修复（E11）：失败负缓存独立落盘——旧版把 {error:true} 写进同一个 CACHE_FILE，
// 成功缓存一旦过期（>24h）再遇上一次网络失败，仍含 latestVersion 的旧记录当场被覆盖成 error，
// 之后 5 分钟内 checkForUpdate 恒返回 latestVersion:null，调用方无法区分"已是最新"与"检查失败"。
const FAILURE_CACHE_FILE = "update-check-error.json";
const STALENESS_MS = 24 * 60 * 60 * 1000; // 24 小时
const FETCH_TIMEOUT_MS = 3000; // 3 秒
// v4.0.0：失败负缓存 TTL——离线/DNS 失败/GitHub 限流时避免每次打开面板都重新打一次外网（最长 3s 超时）
const FAILURE_STALENESS_MS = 5 * 60 * 1000; // 5 分钟
const VERSION_RE = /^\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.\-]+)?$/; // v4.3.0：解析出的版本号必须整体形如 4.3.0 / 4.3.0-rc.1 / 4.3.0+build.5

/** 规范化版本号：去 v/V 前缀。
 * v4.0.0 修正：旧版只剥首个 v/V——tag 形如 "dsh-novel-writer-v3.9.6" / "release-3.9.6" 时原样返回，
 * 后续 parseInt 得 NaN→0，isNewerVersion 恒为 false，更新提示永久静默。改为提取尾部版本号。 */
function normalizeVersion(v) {
  const s = String(v ?? "").trim().replace(/^[vV]/, "");
  if (/^\d/.test(s)) return s;
  const m = s.match(/(\d+(?:\.\d+)*)(?:[-+][0-9A-Za-z.\-]+)?$/);
  return m ? m[1] : s;
}

/**
 * 语义化版本对比：latest 比 current 新返回 true。
 * 按数字逐段比较（处理 0.99.99 vs 1.0.0、双位数 2.9 vs 2.10），缺省段视为 0。
 * 既有设计（保留）：预发布与正式同号视为同版本（1.0.0-rc.1 不比 1.0.0 新）；
 * build 元数据（+build.5）同样不参与比较——两个后缀在逐段数字比较下本就同号，剥掉仅为规范化。
 */
export function isNewerVersion(current, latest) {
  // v3.5.0 #56：剥预发布后缀（2.10.0-beta 与 2.10.0 视为同版本；currentVersion 为空不误报）
  if (!String(current ?? "").trim()) return false;
  // v3.7.0 ⑮修：只剥预发布（-beta2/.rc1）与 build（-1）；不再匹配正常次版本段（"3.7.0" 不再被剥成 "3"）
  // v3.9.1 M23：追加剥 semver build 元数据（+build.5）；必须先剥 build——它位于预发布之后，
  // 若不先剥，预发布正则的 $ 锚点被 build 挡住，残留 "-rc.1" 会因内含 "." 产生幻影第 4 段
  const strip = (v) => String(v).replace(/\+[0-9A-Za-z][0-9A-Za-z.\-]*$/, "").replace(/(?:-|\.)(?:alpha|beta|rc|pre|dev)[0-9.]*$|-[\d]+$/i, "");
  const a = strip(normalizeVersion(current)).split(".").map((n) => parseInt(n, 10) || 0);
  // v3.5.0 #56：latest 同样剥预发布后缀（2.10.0-beta 不视为比 2.10.0 新）
  const b = strip(normalizeVersion(latest)).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

/** 解析 GitHub /releases/latest 响应 → { latestVersion, releaseUrl }；解析失败返回 null。 */
export function parseLatestRelease(data) {
  if (!data || typeof data !== "object") return null;
  const tag = String(data.tag_name ?? "");
  if (tag === "") return null;
  const latestVersion = normalizeVersion(tag);
  // v4.0.0 修正：tag 无法提取版本号（如 "v"）时不再返回空串——空串能通过缓存校验并写进 24h 缓存，期间永不提示更新
  // v4.3.0 修复（E12）：旧的 /\d/ 只要求"含一个数字"，"第4版"/"4版"/"4.1.1 (latest)" 这类 tag 会被当成成功版本
  // 写入 24h 缓存，而 isNewerVersion 对它们逐段 parseInt 得 0 → 缓存期内 isNewerVersion 恒 false（更新提示静默 24h）。
  // 改为整体形如 semver 数字段（可带 -pre/+build 后缀）：v4.3.0、dsh-novel-writer-v3.9.6、release-3.9.6 等合法形式
  // 已经由 normalizeVersion 归一，仍被接受（回归矩阵见 test 之外的 fixE-04 探针）。
  if (!VERSION_RE.test(latestVersion)) return null;
  return {
    latestVersion,
    releaseUrl:
      typeof data.html_url === "string" && data.html_url !== ""
        ? data.html_url
        : `https://github.com/${REPO}/releases`
  };
}

/** v4.0.0：读缓存文件（不存在/损坏返回 null；不抛）。v4.3.0：文件名参数化（成功/失败两份缓存）。 */
function readCacheFile(cacheDir, fileName = CACHE_FILE) {
  try {
    const p = join(cacheDir, fileName);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** v4.0.0：写缓存文件（任何失败都静默——缓存写失败不影响本次结果）。v4.3.0：文件名参数化。 */
function writeCacheFile(cacheDir, payload, fileName = CACHE_FILE) {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, fileName), JSON.stringify(payload, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** v4.3.0：失败负缓存写独立文件——成功缓存（CACHE_FILE）原样保留，5 分钟内不再重打外网。 */
function writeFailureCache(cacheDir) {
  return writeCacheFile(cacheDir, { error: true, checkedAt: Date.now() }, FAILURE_CACHE_FILE);
}

/** v4.0.0：失败负缓存是否仍在 TTL 内（用于跳过外网请求）。v4.3.0：改读独立的失败缓存文件。 */
function failureCacheFresh(cacheDir) {
  const data = readCacheFile(cacheDir, FAILURE_CACHE_FILE);
  if (!data || data.error !== true || typeof data.checkedAt !== "number" || !Number.isFinite(data.checkedAt)) return false;
  const age = Date.now() - data.checkedAt;
  return age >= -60_000 && age <= FAILURE_STALENESS_MS;
}

/** v4.3.0：时间戳 → ISO 字符串；非有限数 / 超出 Date 可表示范围返回 null（不抛）。 */
function toIsoString(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * v4.3.0：读「上一次成功检查」记录——**不设 24h 新鲜度门槛**。
 * 只为在本次检查失败/被限流时降级给出历史 latestVersion/releaseUrl/lastSuccess
 * （旧版失败路径回 latestVersion:null，调用方无法区分"已是最新"与"检查失败"）。
 * 拒收负缓存与损坏记录；未来时间戳（时钟回拨/手工改缓存文件）视为不可信 → null，
 * 与 getCachedUpdateCheck 的反篡改口径保持一致。
 */
function readLastSuccess(cacheDir) {
  const data = readCacheFile(cacheDir);
  if (!data || data.error === true) return null;
  if (typeof data.latestVersion !== "string" || data.latestVersion === "") return null;
  if (toIsoString(data.checkedAt) === null) return null;
  if (data.checkedAt - Date.now() > 60_000) return null;
  return data;
}

/** 读 24h 内缓存；无缓存/过期/损坏/负缓存返回 null。 */
export function getCachedUpdateCheck(cacheDir) {
  const data = readCacheFile(cacheDir);
  if (!data || data.error === true) return null; // v4.0.0：负缓存不当作成功缓存（v4.1.x 旧文件里的 error:true 仍然拒收）
  if (typeof data.latestVersion !== "string" || data.latestVersion === "") return null;
  if (typeof data.checkedAt !== "number" || !Number.isFinite(data.checkedAt)) return null;
  const age = Date.now() - data.checkedAt;
  // v4.0.0 修正：旧版只判"过期"——checkedAt 在未来时差值为负、永不大于 24h（时钟回拨/手工改缓存文件 → 长期误报"有更新 v9.9.9"）
  if (age < -60_000 || age > STALENESS_MS) return null;
  return data;
}

/**
 * 检查更新：返回**稳定形状**
 * { ok, stale, lastSuccess, checkedAt, updateAvailable, currentVersion, latestVersion, releaseUrl }。
 * v4.3.0：
 * - ok        本次是否拿到可信的成功结果（命中 24h 成功缓存、或本次网络成功解析出版本号）
 * - stale     是否在"用历史数据"的降级状态：`!ok && lastSuccess !== null`。
 *             （v4.3.0 起精算；4.3.0 早期实现为恒等于 !ok——从未成功过时其实没有"历史数据"可陈旧，
 *              要判断"有没有历史"请看 lastSuccess，要判断"本次可不可信"请看 ok。）
 * - lastSuccess  上一次成功检查时间（ISO 字符串；从未成功为 null）
 * - checkedAt    本次调用时间（ISO 字符串）
 * - 失败但有历史成功记录时，仍给出历史 latestVersion/releaseUrl（UI 至少能显示"上次检查到的版本"）
 * 既有语义不变：24h 成功缓存、5min 失败负缓存、3s 超时、成功记录绝不被失败覆盖、全程静默不抛。
 */
export async function checkForUpdate(currentVersion, cacheDir) {
  const result = {
    ok: false,
    stale: false,
    lastSuccess: null,
    checkedAt: new Date().toISOString(),
    updateAvailable: false,
    currentVersion: String(currentVersion ?? ""),
    latestVersion: null,
    releaseUrl: null
  };
  /** v4.3.0：失败路径统一出口——stale 精算为"确实有历史数据可陈旧"（从未成功过时为 false）。 */
  const failed = () => {
    result.stale = result.lastSuccess !== null;
    return result;
  };
  try {
    // v4.3.0：先取历史成功记录兜底——本次失败时仍能给出历史版本号（失败只写负缓存，成功缓存原样保留）
    const last = readLastSuccess(cacheDir);
    if (last) {
      result.lastSuccess = toIsoString(last.checkedAt);
      result.latestVersion = last.latestVersion;
      result.releaseUrl = typeof last.releaseUrl === "string" && last.releaseUrl !== "" ? last.releaseUrl : null;
      result.updateAvailable = isNewerVersion(result.currentVersion, last.latestVersion);
    }
    const cached = getCachedUpdateCheck(cacheDir);
    if (cached) {
      // 24h 成功缓存命中：不打外网，本次结果可信（ok:true/stale:false）
      result.ok = true;
      result.stale = false;
      result.lastSuccess = toIsoString(cached.checkedAt);
      result.latestVersion = cached.latestVersion;
      result.releaseUrl = typeof cached.releaseUrl === "string" && cached.releaseUrl !== "" ? cached.releaseUrl : null;
      result.updateAvailable = isNewerVersion(result.currentVersion, cached.latestVersion);
      return result;
    }
    // v4.0.0 修正：失败负缓存命中时直接返回，不再每次重打 GitHub——旧版只有成功解析才写缓存，
    // 注释声称的"24h 缓存避免匿名限流"在离线/限流路径上并不成立
    // v4.3.0：命中负缓存时保持 ok:false，并原样保留上面填好的历史版本号（stale 由 failed() 精算）
    if (failureCacheFresh(cacheDir)) return failed();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let data = null;
    try {
      const res = await fetch(GITHUB_API_URL, {
        headers: { accept: "application/vnd.github+json", "user-agent": "dsh-novel-writer" },
        signal: controller.signal
      });
      if (res.ok) data = await res.json();
      // v4.0.0 修正：非 2xx（403 限流/404/5xx）时消费响应体——旧版不读不取消，undici keep-alive 连接滞留到 GC/超时
      else await res.text().catch(() => {});
    } catch {
      // v4.0.0 修正：超时/DNS/离线等网络异常也写负缓存（5 分钟内不再重试外网）
      // v4.3.0 修复（E11）：写独立的失败缓存文件，成功缓存（含 latestVersion）原样保留
      // v4.3.0：失败路径不写成功缓存、不改 ok/lastSuccess→ 本次仍是 ok:false + 历史值（stale 由 failed() 精算）
      writeFailureCache(cacheDir);
      return failed();
    } finally {
      clearTimeout(timer);
    }
    const parsed = parseLatestRelease(data);
    if (!parsed) {
      // v4.0.0 修正：响应无 tag_name / tag 无法解析出版本号时同样写负缓存
      // v4.3.0 修复（E11/E12）：负缓存独立落盘；严格版本校验拦住 "第4版" 这类伪版本，不再污染 24h 成功缓存
      writeFailureCache(cacheDir);
      return failed();
    }
    // v4.3.0：本次网络成功——写成功缓存 + 结果置为可信（命中缓存与本次成功用同一套字段口径）
    const checkedAt = Date.now();
    writeCacheFile(cacheDir, { latestVersion: parsed.latestVersion, releaseUrl: parsed.releaseUrl, checkedAt });
    result.ok = true;
    result.stale = false;
    result.lastSuccess = toIsoString(checkedAt);
    result.latestVersion = parsed.latestVersion;
    result.releaseUrl = parsed.releaseUrl;
    result.updateAvailable = isNewerVersion(result.currentVersion, parsed.latestVersion);
  } catch {
    /* 静默失败 */
  }
  return result.ok ? result : failed();
}
