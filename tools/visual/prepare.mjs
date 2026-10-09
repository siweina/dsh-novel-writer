/**
 * prepare.mjs — 视觉装置的前置步骤（dev-only）
 *
 * 负责：
 *   ① 把 lib/client.js **复制成快照** tools/visual/snapshot/client.js，并记录 sha256/字节数/修改时间；
 *   ② 把 react / react-dom 的 UMD 产物复制到 tools/visual/vendor/，供 fixture 以经典 <script> 加载。
 * 不负责：安装依赖、渲染、截图、改仓库其它文件。
 *
 * 为什么必须先快照再渲染：另一个 agent 正在并发重建 lib/client.js，fixture 直接引用它
 * 会读到半成品（甚至半截文件）；快照 + sha256 同时让「这份图是用哪版产物拍的」可追溯。
 *
 * 用法：
 *   node prepare.mjs            # 快照 + 拷 vendor
 *   import { snapshotClient }   # capture.mjs 复用快照逻辑
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..", "..");
export const SNAPSHOT_DIR = join(HERE, "snapshot");
export const VENDOR_DIR = join(HERE, "vendor");

const CLIENT_SRC = join(REPO, "lib", "client.js");

/** 复制 lib/client.js → snapshot/client.js，返回快照元信息（含 sha256） */
export function snapshotClient() {
  const buf = readFileSync(CLIENT_SRC);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const st = statSync(CLIENT_SRC);
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const out = join(SNAPSHOT_DIR, "client.js");
  writeFileSync(out, buf);
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const meta = {
    source: "lib/client.js",
    snapshot: "tools/visual/snapshot/client.js",
    pluginVersion: pkg.version,
    bytes: buf.length,
    lines: buf.toString("utf8").split("\n").length,
    srcMtimeIso: new Date(st.mtimeMs).toISOString(),
    sha256
  };
  writeFileSync(join(SNAPSHOT_DIR, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
  return meta;
}

/** 复制 react / react-dom 的 UMD 产物（浏览器经典脚本可直接跑，无需打包器） */
export function vendorReact() {
  const umd = [
    ["react", "umd/react.production.min.js", "react.js"],
    ["react-dom", "umd/react-dom.production.min.js", "react-dom.js"]
  ];
  mkdirSync(VENDOR_DIR, { recursive: true });
  const versions = {};
  for (const [pkg, rel, out] of umd) {
    const from = join(HERE, "node_modules", pkg, rel);
    if (!existsSync(from)) {
      throw new Error("缺少 " + from + "（先在 tools/visual 内 npm install react@18.3.1 react-dom@18.3.1）");
    }
    copyFileSync(from, join(VENDOR_DIR, out));
    const pkgJson = JSON.parse(readFileSync(join(HERE, "node_modules", pkg, "package.json"), "utf8"));
    versions[pkg] = pkgJson.version;
    versions[pkg + "Sha256"] = createHash("sha256").update(readFileSync(from)).digest("hex");
  }
  return versions;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (!existsSync(CLIENT_SRC)) {
    console.error("找不到 " + CLIENT_SRC);
    process.exit(1);
  }
  const meta = snapshotClient();
  const ver = vendorReact();
  console.log("快照 lib/client.js → snapshot/client.js");
  console.log("  插件版本 v" + meta.pluginVersion + " | " + meta.bytes + " 字节 | " + meta.lines + " 行");
  console.log("  sha256  " + meta.sha256);
  console.log("  src mtime " + meta.srcMtimeIso);
  console.log("vendor: react " + ver.react + " | react-dom " + ver["react-dom"]);
}
