/**
 * v2.6.5 更新检查（update-check.js）——设计移植自 Archon #1039（coleam00/Archon commit 6f1b72e）
 * - GitHub Releases API 获取最新版：GET /repos/<repo>/releases/latest
 * - 24h 缓存（update-check.json，避免 GitHub API 匿名限流 60 次/小时）
 * - 3s 超时 + 全程静默失败（任何异常都不抛，绝不影响插件功能）
 * - 语义化版本对比：按数字逐段比较（2.10 > 2.9），非字符串比较
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "siweina/dsh-novel-writer";
const GITHUB_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_FILE = "update-check.json";
const STALENESS_MS = 24 * 60 * 60 * 1000; // 24 小时
const FETCH_TIMEOUT_MS = 3000; // 3 秒
// v4.0.0：失败负缓存 TTL——离线/DNS 失败/GitHub 限流时避免每次打开面板都重新打一次外网（最长 3s 超时）
const FAILURE_STALENESS_MS = 5 * 60 * 1000; // 5 分钟

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
  if (!/\d/.test(latestVersion)) return null;
  return {
    latestVersion,
    releaseUrl:
      typeof data.html_url === "string" && data.html_url !== ""
        ? data.html_url
        : `https://github.com/${REPO}/releases`
  };
}

/** v4.0.0：读缓存文件（不存在/损坏返回 null；不抛）。 */
function readCacheFile(cacheDir) {
  try {
    const p = join(cacheDir, CACHE_FILE);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** v4.0.0：写缓存文件（任何失败都静默——缓存写失败不影响本次结果）。 */
function writeCacheFile(cacheDir, payload) {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, CACHE_FILE), JSON.stringify(payload, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** v4.0.0：失败负缓存是否仍在 TTL 内（用于跳过外网请求）。 */
function failureCacheFresh(cacheDir) {
  const data = readCacheFile(cacheDir);
  if (!data || data.error !== true || typeof data.checkedAt !== "number" || !Number.isFinite(data.checkedAt)) return false;
  const age = Date.now() - data.checkedAt;
  return age >= -60_000 && age <= FAILURE_STALENESS_MS;
}

/** 读 24h 内缓存；无缓存/过期/损坏/负缓存返回 null。 */
export function getCachedUpdateCheck(cacheDir) {
  const data = readCacheFile(cacheDir);
  if (!data || data.error === true) return null; // v4.0.0：负缓存不当作成功缓存
  if (typeof data.latestVersion !== "string" || data.latestVersion === "") return null;
  if (typeof data.checkedAt !== "number" || !Number.isFinite(data.checkedAt)) return null;
  const age = Date.now() - data.checkedAt;
  // v4.0.0 修正：旧版只判"过期"——checkedAt 在未来时差值为负、永不大于 24h（时钟回拨/手工改缓存文件 → 长期误报"有更新 v9.9.9"）
  if (age < -60_000 || age > STALENESS_MS) return null;
  return data;
}

/**
 * 检查更新：返回 { updateAvailable, currentVersion, latestVersion, releaseUrl }。
 * 任何异常都静默降级为 updateAvailable:false（插件功能绝不受影响）。
 */
export async function checkForUpdate(currentVersion, cacheDir) {
  const result = {
    updateAvailable: false,
    currentVersion: String(currentVersion ?? ""),
    latestVersion: null,
    releaseUrl: null
  };
  try {
    const cached = getCachedUpdateCheck(cacheDir);
    if (cached) {
      result.latestVersion = cached.latestVersion;
      result.releaseUrl = cached.releaseUrl;
      result.updateAvailable = isNewerVersion(result.currentVersion, cached.latestVersion);
      return result;
    }
    // v4.0.0 修正：失败负缓存命中时直接返回，不再每次重打 GitHub——旧版只有成功解析才写缓存，
    // 注释声称的"24h 缓存避免匿名限流"在离线/限流路径上并不成立
    if (failureCacheFresh(cacheDir)) return result;
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
      writeCacheFile(cacheDir, { error: true, checkedAt: Date.now() });
      return result;
    } finally {
      clearTimeout(timer);
    }
    const parsed = parseLatestRelease(data);
    if (!parsed) {
      // v4.0.0 修正：响应无 tag_name / tag 无法解析出版本号时同样写负缓存
      writeCacheFile(cacheDir, { error: true, checkedAt: Date.now() });
      return result;
    }
    result.latestVersion = parsed.latestVersion;
    result.releaseUrl = parsed.releaseUrl;
    result.updateAvailable = isNewerVersion(result.currentVersion, parsed.latestVersion);
    writeCacheFile(cacheDir, { latestVersion: parsed.latestVersion, releaseUrl: parsed.releaseUrl, checkedAt: Date.now() });
  } catch {
    /* 静默失败 */
  }
  return result;
}
