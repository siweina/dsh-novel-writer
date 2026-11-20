/**
 * test/client-build-test.mjs —— 客户端模块化源码与构建流水线回归套件（第 44 个测试套件）
 *
 * 覆盖范围：
 *   1. tools/client-src/ 下全部 .js 模块均可独立通过 vm.Script 语法解析
 *   2. 无孤儿 .js / .css 文件（node tools/build-client.mjs --check 退出码为 0）
 *   3. tools/client-src/i18n/zh.js 与 en.js 键集合完全一致且所有值为非空字符串
 *   4. 所有非词典 .js 模块保持干净拆分（< 600 行）
 *   5. 组装产物 lib/client.js 保留全部 4 组 V6 标记区、Hook 调用点/安全/CSS 颜色不变量，
 *      并通过 window.__ModuleLoader__.load 存根导出 apply / inject / __internals.NW_UI
 *
 * 运行：node test/client-build-test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const SRC_DIR = join(REPO, "tools", "client-src");
const BUILD_SCRIPT = join(REPO, "tools", "build-client.mjs");
const CLIENT_FILE = join(REPO, "lib", "client.js");

function walkFiles(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

const ALL_SRC_FILES = walkFiles(SRC_DIR);
const JS_SRC_FILES = ALL_SRC_FILES.filter((p) => p.endsWith(".js"));
const DICTIONARY_FILES = new Set(["i18n/zh.js", "i18n/en.js"]);

test("1. tools/client-src 下每个 .js 模块均可独立通过 new vm.Script 解析", () => {
  assert.ok(JS_SRC_FILES.length >= 30, `预期至少 30 个模块化 .js 文件，实测 ${JS_SRC_FILES.length}`);
  for (const filePath of JS_SRC_FILES) {
    const rel = relative(SRC_DIR, filePath).replace(/\\/g, "/");
    const code = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
    assert.ok(code.trim().length > 0, `${rel} 不得为空`);
    assert.doesNotThrow(() => {
      new vm.Script(code, { filename: rel });
    }, `${rel} 应可独立语法解析`);
  }
});

test("2. 无孤儿 .js/.css 文件且 build-client.mjs --check 退出码为 0", () => {
  const out = execFileSync(process.execPath, [BUILD_SCRIPT, "--check"], {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(out, /--check ✓/, "build-client.mjs --check 应打印一致通过标记");
});

test("3. i18n/zh.js 与 i18n/en.js 键集合完全对称且全部值为非空字符串", () => {
  const zhCode = readFileSync(join(SRC_DIR, "i18n", "zh.js"), "utf8").replace(/\r\n/g, "\n");
  const enCode = readFileSync(join(SRC_DIR, "i18n", "en.js"), "utf8").replace(/\r\n/g, "\n");
  const zhSandbox = {};
  const enSandbox = {};
  vm.runInNewContext(zhCode, zhSandbox, { filename: "i18n/zh.js" });
  vm.runInNewContext(enCode, enSandbox, { filename: "i18n/en.js" });

  assert.ok(zhSandbox.zh && typeof zhSandbox.zh === "object", "zh.js 应定义 zh 对象");
  assert.ok(enSandbox.en && typeof enSandbox.en === "object", "en.js 应定义 en 对象");

  const zhKeys = Object.keys(zhSandbox.zh).sort();
  const enKeys = Object.keys(enSandbox.en).sort();
  assert.deepEqual(enKeys, zhKeys, "en 与 zh 的词条键集合必须完全一致");
  assert.ok(zhKeys.length > 500, `词条数应大于 500，实测 ${zhKeys.length}`);

  for (const key of zhKeys) {
    assert.equal(typeof zhSandbox.zh[key], "string", `zh["${key}"] 必须为字符串`);
    assert.ok(zhSandbox.zh[key].trim().length > 0, `zh["${key}"] 不可为空`);
    assert.equal(typeof enSandbox.en[key], "string", `en["${key}"] 必须为字符串`);
    assert.ok(enSandbox.en[key].trim().length > 0, `en["${key}"] 不可为空`);
  }
});

test("4. 所有非词典 .js 模块行数保持 < 600 行", () => {
  const oversized = [];
  for (const filePath of JS_SRC_FILES) {
    const rel = relative(SRC_DIR, filePath).replace(/\\/g, "/");
    if (DICTIONARY_FILES.has(rel)) continue;
    const lines = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n").split("\n").length;
    if (lines >= 600) oversized.push(`${rel} (${lines} lines)`);
  }
  assert.deepEqual(oversized, [], `存在超过 600 行的非词典模块：${oversized.join(", ")}`);
});

test("5. 组装产物 lib/client.js 保留全部 V6 标记、全文不变量及模块导出契约", () => {
  const clientSrc = readFileSync(CLIENT_FILE, "utf8").replace(/\r\n/g, "\n");
  assert.doesNotThrow(() => {
    new vm.Script(clientSrc, { filename: "lib/client.js" });
  }, "lib/client.js 应可完整解析");

  for (const marker of ["V6:icons", "V6:uikit", "V6:slider", "V6:css"]) {
    const begin = `/* ===== ${marker} ===== */`;
    const end = `/* ===== /${marker} ===== */`;
    const i1 = clientSrc.indexOf(begin);
    const i2 = clientSrc.indexOf(end);
    assert.ok(i1 >= 0 && i2 > i1, `应包含成对标记 ${marker}`);
    assert.equal(clientSrc.indexOf(begin, i1 + 1), -1, `标记 ${begin} 不应重复`);
    assert.equal(clientSrc.indexOf(end, i2 + 1), -1, `标记 ${end} 不应重复`);
  }

  const rawUseCount = (clientSrc.match(/react\.use[A-Z]/g) || []).length;
  assert.equal(rawUseCount, 12, `全文 react.use[A-Z] 计数应为 12，实测 ${rawUseCount}`);
  assert.equal(clientSrc.includes("ctx.inject("), false, "lib/client.js 不得包含 ctx.inject(");
  assert.equal((clientSrc.match(/NW_UI\.[A-Za-z]+\(/g) || []).length, 0, "lib/client.js 不得直接调用 NW_UI.X(");

  const loaded = {};
  const sandbox = {
    Object, Array, String, Number, Boolean, Math, Date, JSON, RegExp, Error, TypeError,
    Set, Map, Symbol, Promise, console, setTimeout, clearTimeout, setInterval, clearInterval,
    encodeURIComponent, decodeURIComponent, isFinite,
  };
  sandbox.window = sandbox;
  sandbox.__ModuleLoader__ = {
    load(spec) {
      loaded.id = spec.id;
      loaded.factory = spec.factory;
    },
  };

  vm.runInNewContext(clientSrc, sandbox, { filename: "lib/client.js" });
  assert.equal(loaded.id, "dsh-novel-writer");
  assert.equal(typeof loaded.factory, "function");

  const exported = loaded.factory((mod) => {
    if (mod === "react") {
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        isValidElement: () => false,
      };
    }
    if (mod === "react-dom/client") {
      return { createRoot: () => ({ render() {}, unmount() {} }) };
    }
    throw new Error("module not found: " + mod);
  });

  assert.equal(typeof exported.apply, "function", "应导出 apply 函数");
  assert.deepEqual(Array.from(exported.inject), ["slots", "locale"], "应声明 inject = ['slots', 'locale']");
  assert.ok(exported.__internals && exported.__internals.NW_UI, "应导出 __internals.NW_UI");
  assert.deepEqual(
    Object.keys(exported.__internals.NW_UI).sort(),
    ["Button", "DisclosureRow", "SegmentedControl", "Switch", "Tag", "Tooltip"],
    "__internals.NW_UI 应包含全部 6 个原语适配器"
  );
});
