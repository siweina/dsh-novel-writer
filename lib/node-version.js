/**
 * dsh-novel-writer — Node.js 运行时版本检查（零依赖模块）
 *
 * v8.0.0 起本地缓存迁移至 Node 内置 `node:sqlite`（`DatabaseSync`），
 * 最低要求 Node.js >= 22.13.0。本模块刻意不导入任何 `node:sqlite` 或插件业务模块，
 * 以便 `mcp/server.mjs` 在加载 `lib/index.js` 之前先安全校验运行时版本并输出友好诊断。
 */

export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 13;
export const MIN_NODE_VERSION = "22.13.0";

/**
 * 解析 Node.js 版本字符串（如 `"v22.13.0"`、`"24.21.0"`）为 `{ major, minor, patch }`，
 * 格式非法时返回 `null`。
 */
export function parseNodeVersion(versionStr = process.versions?.node || process.version) {
  if (typeof versionStr !== "string") return null;
  const trimmed = versionStr.trim();
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/.exec(trimmed);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] !== undefined ? Number(match[3]) : 0;
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * 判断给定（或当前）Node.js 版本是否满足 `>= 22.13.0`。
 */
export function isNodeVersionSupported(versionStr) {
  const parsed = parseNodeVersion(versionStr);
  if (!parsed) return false;
  return parsed.major > MIN_NODE_MAJOR || (parsed.major === MIN_NODE_MAJOR && parsed.minor >= MIN_NODE_MINOR);
}

/**
 * 生成写往 stderr 的版本不兼容诊断信息（中英双语、简洁明确，不含隐私路径）。
 */
export function formatNodeVersionError(versionStr) {
  const current = typeof versionStr === "string" && versionStr.trim() !== ""
    ? versionStr.trim()
    : (process.versions?.node || process.version || "unknown");
  return [
    `[dsh-novel-writer] 不支持的 Node.js 版本：当前为 ${current}，需要 >=${MIN_NODE_VERSION}（依赖内置 node:sqlite）。`,
    `Unsupported Node.js version: current ${current}, requires >=${MIN_NODE_VERSION} (built-in node:sqlite).`,
    `请升级 Node.js 至 >=${MIN_NODE_VERSION}（推荐 Node 22.13+ 或 24 LTS），或直接使用 DSH Desktop（内置 Node 24 运行时）。`
  ].join("\n");
}
