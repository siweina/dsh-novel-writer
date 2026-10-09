/**
 * asar 探针（dev-only，视觉装置附属工具）
 *
 * 负责：只读解析 desktop 线的 resources/app.asar，列出文件名 / 按子串抽取文本文件内容。
 * 不负责：写任何仓库文件、修改插件产物。契约 §1：版本敏感事实一律以 desktop 线 asar 为准。
 *
 * 用法：
 *   node probe-asar.mjs list <子串正则>            # 列出路径匹配的文件
 *   node probe-asar.mjs cat <路径子串>             # 打印文件内容（stdout）
 *   node probe-asar.mjs dump <路径子串> <输出文件>  # 按 UTF-8 无损写出（stdout 重定向会写坏 UTF-8）
 *   node probe-asar.mjs grep <路径正则> <内容正则>  # 在匹配路径的文件里搜内容
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ASAR = "C:\\Users\\zg\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";

/** 解析 asar 头：返回 { baseOffset, header } */
function readAsar(path) {
  const fd = readFileSync(path);
  // 实测布局（desktop 0.2.0-rc.2 的 app.asar，字节 0..15 = 04 00 00 00 | 38 c2 33 00 | 34 c2 33 00 | 30 c2 33 00）：
  //   offset 0  : uint32 = 4
  //   offset 4  : header pickle 总长 = JSON 字节数 + 8
  //   offset 8  : uint32 = JSON 字节数 + 4
  //   offset 12 : uint32 = JSON 字节数
  //   offset 16 : JSON 起始
  const headerSize = fd.readUInt32LE(4);
  const headerJsonSize = fd.readUInt32LE(12);
  const jsonStart = 16;
  const json = fd.subarray(jsonStart, jsonStart + headerJsonSize).toString("utf8");
  const baseOffset = 8 + headerSize;
  return { fd, header: JSON.parse(json), baseOffset };
}

/** 把 asar 文件树拍平成路径列表 */
function flatten(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix === "" ? name : prefix + "/" + name;
    if (entry.files) flatten(entry, p, out);
    else out.push({ path: p, size: entry.size, offset: entry.offset });
  }
  return out;
}

const [, , cmd, a, b] = process.argv;
const { fd, header, baseOffset } = readAsar(ASAR);
const files = flatten(header, "", []);

if (cmd === "list") {
  const re = new RegExp(a, "i");
  const hits = files.filter((f) => re.test(f.path));
  for (const h of hits) console.log(h.size.toString().padStart(10) + "  " + h.path);
  console.log("--- 命中 " + hits.length + " / 共 " + files.length + " 个文件");
} else if (cmd === "cat") {
  const hit = files.find((f) => f.path.includes(a));
  if (!hit) { console.error("未找到: " + a); process.exit(1); }
  const buf = fd.subarray(baseOffset + Number(hit.offset), baseOffset + Number(hit.offset) + hit.size);
  process.stdout.write(buf);
} else if (cmd === "dump") {
  const hit = files.find((f) => f.path.includes(a));
  if (!hit) { console.error("未找到: " + a); process.exit(1); }
  const buf = fd.subarray(baseOffset + Number(hit.offset), baseOffset + Number(hit.offset) + hit.size);
  mkdirSync(dirname(b), { recursive: true });
  writeFileSync(b, buf);
  console.log("写出 " + buf.length + " 字节 → " + b);
} else if (cmd === "grep") {
  const rePath = new RegExp(a, "i");
  const reBody = new RegExp(b, "i");
  for (const f of files.filter((x) => rePath.test(x.path))) {
    const buf = fd.subarray(baseOffset + Number(f.offset), baseOffset + Number(f.offset) + f.size);
    const text = buf.toString("utf8");
    if (reBody.test(text)) {
      const lines = text.split("\n");
      lines.forEach((line, i) => { if (reBody.test(line)) console.log(f.path + ":" + (i + 1) + ": " + line.slice(0, 300)); });
    }
  }
} else {
  console.error("用法: node probe-asar.mjs list|cat|grep ...");
  process.exit(2);
}
