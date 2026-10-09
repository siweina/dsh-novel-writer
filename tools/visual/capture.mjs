/**
 * capture.mjs — 用系统 Chrome + Playwright 打开 fixture，逐个进入 9 个视图并截图（dev-only）
 *
 * 负责：
 *   ① 开跑前先把 lib/client.js **复制成快照**（另一个 agent 正在并发重建原文件）；
 *   ② 用系统 Chrome（C:\Program Files\Google\Chrome\Application\chrome.exe）以 file:// 打开 fixture.html；
 *   ③ 9 视图 × 2 宽度（720×900 面板常见宽度 / 380×900 窄栏）× {固定视口, 整页} 逐个截图到 shots/；
 *   ④ 额外拍一张「宿主不可达（localStorage 降级）」的主面板，作为降级路径的实证；
 *   ⑤ 产出 2 张 9 视图联络表 + shots/manifest.json（含每张图的字节数/像素尺寸/sha256/驱动方式/诊断）。
 * 不负责：改插件产物、判断"好看不好看"。渲染失败一律如实记进 manifest，绝不拿占位图充数。
 *
 * 用法：
 *   node capture.mjs                      # 快照 + 全量截图 → shots/
 *   node capture.mjs --out shots-run2     # 换输出目录（用于确定性复核：两次运行对比 sha256）
 *   node capture.mjs --reuse-snapshot     # 复用已有快照（不重新复制 lib/client.js）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { snapshotClient, vendorReact, HERE } from "./prepare.mjs";

const CHROME = process.env.NW_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PLAYWRIGHT_DIR = process.env.NW_PLAYWRIGHT || "C:\\Users\\zg\\.dsh\\profiles\\desktop\\node_modules\\playwright";

const VIEWS = ["main", "features", "tools", "baseline", "reports", "creation", "lexicon", "model", "creation-form"];
// ⚠️ v6.4.0 修正（这条是**流程性缺陷**的修复，不只是加个数字）：
// 此前只有 [720, 380] 两个宽度 —— 而桌面端宿主的**主栏面板实际约 1250px 宽**。
// 后果：我在 720px 下把行式布局（左文字 + 右控件）调好并"目视确认"，用户却在真实宽度下看到
// 徽章被挤成竖条、分段控件压住说明文字、下拉框撑满整行 —— 那些断裂在 720px 下**根本不出现**。
// 用错误的尺子量一百次也不会让尺子变对。现在把**真实面板宽度**加入常规拍摄宽度：
//   1268 = 实测桌面端主栏内容区宽度（用户截图约 1250px，取宿主典型值）
//   960  = 中间档（宿主窗口较窄时）
//   720 / 380 = 保留（窄窗与移动端回归）
const WIDTHS = [1268, 960, 720, 380];
const FIXED_H = 900;

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const OUT_DIR = resolve(HERE, argVal("--out") || "shots");
const REUSE_SNAPSHOT = args.includes("--reuse-snapshot");

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}
/** 直接读 PNG 头拿真实像素尺寸（不信任脚本自己的记录） */
function pngSize(file) {
  const b = readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG: " + file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
function fileInfo(file) {
  const px = pngSize(file);
  return { bytes: statSync(file).size, width: px.width, height: px.height, sha256: sha256File(file) };
}

/** 从 desktop profile 复用 playwright（避免下载浏览器），兼容 CJS 默认导出 */
async function loadPlaywright() {
  const entry = join(PLAYWRIGHT_DIR, "index.js");
  if (!existsSync(entry)) throw new Error("找不到 playwright: " + entry);
  const mod = await import(pathToFileURL(entry).href);
  const pw = mod.chromium ? mod : mod.default;
  if (!pw || !pw.chromium) throw new Error("playwright 模块未导出 chromium");
  return pw;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!existsSync(CHROME)) throw new Error("找不到系统 Chrome: " + CHROME);
  mkdirSync(OUT_DIR, { recursive: true });

  // ① 先快照，再渲染（顺序是硬要求：lib/client.js 正被并发重建）
  //    --reuse-snapshot 时以**磁盘上实际那份快照**的 sha256 为准（meta.json 可能已过期——
  //    手工替换过快照时，绝不能拿旧 meta 冒充），并对不上时大声告警。
  let snap = REUSE_SNAPSHOT
    ? JSON.parse(readFileSync(join(HERE, "snapshot", "meta.json"), "utf8"))
    : snapshotClient();
  if (REUSE_SNAPSHOT) {
    const actual = sha256File(join(HERE, "snapshot", "client.js"));
    snap = Object.assign({}, snap, {
      sha256: actual,
      metaExpectedSha256: snap.sha256,
      metaStale: actual !== snap.sha256,
      bytes: statSync(join(HERE, "snapshot", "client.js")).size
    });
    if (snap.metaStale) console.warn("[prepare] 警告：snapshot/meta.json 与磁盘快照不一致（meta=" + snap.metaExpectedSha256.slice(0, 12) + "… actual=" + actual.slice(0, 12) + "…），以磁盘为准");
  }
  const vendor = vendorReact();
  console.log("[prepare] client.js 快照 sha256 = " + snap.sha256 + " (" + snap.bytes + " 字节, v" + snap.pluginVersion + ")");

  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--hide-scrollbars",              // 跨平台/跨版本一致的滚动条处理（面板自带 scrollbar-gutter:stable，不会横移）
      "--force-color-profile=srgb",     // 颜色空间固定
      "--disable-lcd-text",             // 关闭次像素抗锯齿
      "--font-render-hinting=none",     // 字形 hinting 固定
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only"
    ]
  });

  const shots = [];
  const sheets = [];
  const failures = [];
  const externalRequests = [];
  let diagnostics = {};
  let chromeVersion = "";
  let context = null;

  async function openFixture(query) {
    const ctx = await browser.newContext({
      viewport: { width: WIDTHS[0], height: FIXED_H },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",            // 插件自身的 9 视图 push/pop 过渡就在这个媒体查询门内
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      bypassCSP: true
    });
    const page = await ctx.newPage();
    page.on("request", (req) => {
      const u = req.url();
      if (!u.startsWith("file://") && !u.startsWith("data:") && !u.startsWith("blob:")) externalRequests.push(u);
    });
    page.on("pageerror", (e) => failures.push({ view: "pageerror", error: String(e && e.message || e) }));
    const url = pathToFileURL(join(HERE, "fixture.html")).href + (query || "");
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction("window.__NW_READY_STATE__ !== undefined", null, { timeout: 15000 });
    const state = await page.evaluate("window.__NW_READY_STATE__");
    const info = await page.evaluate("window.__NW_INFO__");
    if (state !== "ready") {
      throw new Error("fixture 未就绪（" + state + "）: " + (info && info.fatal));
    }
    return { ctx, page, info };
  }

  async function setWidth(page, w) {
    await page.setViewportSize({ width: w, height: FIXED_H });
    await sleep(60);
  }

  async function shoot(page, view, w, mode, name) {
    const file = join(OUT_DIR, name);
    if (mode === "full") {
      await page.evaluate("window.__NW__.metric('full')");
      await sleep(80);
      await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
      await page.evaluate("window.__NW__.metric('fixed')");
      await sleep(80);
    } else {
      await page.screenshot({ path: file, animations: "disabled" });
    }
    const metrics = await page.evaluate("window.__NW__.metrics()");
    const textLength = await page.evaluate("window.__NW__.textLength()");
    const rec = Object.assign({
      view, mode, width: w, file: name.replace(/\\/g, "/"),
      capturedAt: new Date().toISOString(),
      clientSnapshotSha256: snap.sha256,
      textLength
    }, fileInfo(file));
    rec.contentHeight = metrics.panelScrollH;
    rec.contentWidth = metrics.panelScrollW;
    return rec;
  }

  try {
    chromeVersion = browser.version();

    /* ---------- 主通道：宿主可达 + 定值数据 ---------- */
    const main = await openFixture("");
    context = main.ctx;
    const page = main.page;
    diagnostics = {
      hostMode: main.info.hostMode,
      primitives: main.info.primitives,
      localStorageAvailable: main.info.localStorageAvailable,
      seatRegistered: main.info.seatRegistered,
      slotInjections: main.info.slotInjections,
      exports: main.info.exports,
      loadSettled: main.info.loadSettled,
      hostOk: main.info.hostOk,
      fetchCounts: main.info.fetchCounts,
      consoleErrors: main.info.consoleErrors,
      pluginWarnings: main.info.pluginWarnings,
      navigation: main.info.navigation
    };

    for (const w of WIDTHS) {
      await setWidth(page, w);
      for (const view of VIEWS) {
        let nav;
        try {
          nav = await page.evaluate((v) => window.__NW__.gotoView(v), view);
        } catch (err) {
          failures.push({ view, width: w, error: String(err && err.message || err) });
          continue;
        }
        try {
          const fixed = await shoot(page, view, w, "fixed", `${view}-${w}x${FIXED_H}.png`);
          Object.assign(fixed, { driver: nav.driver, waitedFor: nav.waitedFor, navMs: nav.ms });
          shots.push(fixed);
          if (w === WIDTHS[0]) {
            const full = await shoot(page, view, w, "full", `${view}-${w}-full.png`);
            Object.assign(full, { driver: nav.driver, waitedFor: nav.waitedFor, navMs: nav.ms });
            shots.push(full);
          }
          const tail = fixed.contentHeight > FIXED_H ? ` | 内容高 ${fixed.contentHeight}px（固定视口裁掉了 ${fixed.contentHeight - FIXED_H}px）` : "";
          console.log(`[shot] ${view} @${w} → ${fixed.file} ${fixed.width}×${fixed.height} ${fixed.bytes}B 文本${fixed.textLength}字 driver=${nav.driver}${tail}`);
        } catch (err) {
          failures.push({ view, width: w, mode: "fixed", error: String(err && err.message || err) });
        }
      }
    }
    // 导航日志要在跑完之后再取（开跑时读到的还是空数组）
    diagnostics.navigation = await page.evaluate("window.__NW_INFO__.navigation");
    diagnostics.fetchCounts = await page.evaluate("window.__NW_INFO__.fetchCounts");
    diagnostics.consoleErrors = await page.evaluate("window.__NW_INFO__.consoleErrors");
    diagnostics.pluginWarnings = await page.evaluate("window.__NW_INFO__.pluginWarnings");
    await main.ctx.close();
    context = null;

    /* ---------- 降级通道：宿主不可达 → localStorage 兜底 ---------- */
    const down = await openFixture("?host=down");
    context = down.ctx;
    await setWidth(down.page, WIDTHS[0]);
    await down.page.evaluate(() => window.__NW__.gotoView("main"));
    const downShot = await shoot(down.page, "main", WIDTHS[0], "fixed", `main-hostdown-${WIDTHS[0]}x${FIXED_H}.png`);
    downShot.note = "宿主不可达（fetch 恒拒绝）→ 插件的 localStorage 降级路径";
    shots.push(downShot);
    const downInfo = await down.page.evaluate("window.__NW_INFO__");
    diagnostics.hostDown = {
      hostOk: downInfo.hostOk,
      localStorageAvailable: downInfo.localStorageAvailable,
      fatal: downInfo.fatal,
      consoleErrors: downInfo.consoleErrors,
      pluginWarnings: downInfo.pluginWarnings
    };
    console.log(`[shot] main(host=down) → ${downShot.file} ${downShot.width}×${downShot.height} ${downShot.bytes}B hostOk=${downInfo.hostOk} localStorage=${downInfo.localStorageAvailable}`);
    await down.ctx.close();
    context = null;

    /* ---------- 联络表（纯 data: URL，不依赖任何图形库） ---------- */
    const sheetFor = async (w, thumbW, name) => {
      const items = shots.filter((s) => s.mode === "fixed" && s.width === w && !/hostdown/.test(s.file));
      if (items.length === 0) return null;
      const cards = items.map((s) => {
        const b64 = readFileSync(join(OUT_DIR, s.file)).toString("base64");
        return `<figure><figcaption>${s.view} · ${s.width}×${s.height} · ${s.bytes}B</figcaption>`
          + `<img src="data:image/png;base64,${b64}" style="width:${thumbW}px;display:block"></figure>`;
      }).join("");
      const sheetPage = await browser.newPage();
      await sheetPage.setViewportSize({ width: thumbW * 3 + 80, height: 900 });
      await sheetPage.setContent(
        `<style>body{margin:0;background:#f4f5f7;font:12px/1.4 "Microsoft YaHei",system-ui;color:#111}
         .h{padding:10px 14px;font-weight:700}
         .grid{display:grid;grid-template-columns:repeat(3,${thumbW}px);gap:14px;padding:0 14px 14px}
         figure{margin:0;background:#fff;border:1px solid #d6d8dd;border-radius:6px;overflow:hidden}
         figcaption{padding:4px 6px;border-bottom:1px solid #e6e8ec;font-weight:600}
         img{image-rendering:auto}</style>
         <div class="h">dsh-novel-writer 视觉基线联络表 · 固定视口 ${w}×900 · client.js 快照 ${snap.sha256.slice(0, 12)}…</div>
         <div class="grid">${cards}</div>`,
        { waitUntil: "load" }
      );
      const file = join(OUT_DIR, name);
      await sheetPage.screenshot({ path: file, fullPage: true, animations: "disabled" });
      await sheetPage.close();
      const rec = Object.assign({ file: name.replace(/\\/g, "/"), kind: "contact-sheet", width: w, views: items.map((s) => s.view) }, fileInfo(file));
      console.log(`[sheet] ${rec.file} ${rec.width}×${rec.height} ${rec.bytes}B`);
      return rec;
    };
    const s1 = await sheetFor(WIDTHS[0], 320, `contact-sheet-${WIDTHS[0]}x${FIXED_H}.png`);
    const s2 = await sheetFor(WIDTHS[1], 160, `contact-sheet-${WIDTHS[1]}x${FIXED_H}.png`);
    if (s1) sheets.push(s1);
    if (s2) sheets.push(s2);
  } finally {
    if (context) { try { await context.close(); } catch { /* ignore */ } }
    await browser.close();
  }

  /* ---------- manifest ---------- */
  const capturedViews = [...new Set(shots.filter((s) => s.mode === "fixed" && !/hostdown/.test(s.file)).map((s) => s.view))];
  const manifest = {
    generatedAt: new Date().toISOString(),
    tool: {
      node: process.version,
      playwright: (() => { try { return JSON.parse(readFileSync(join(PLAYWRIGHT_DIR, "package.json"), "utf8")).version; } catch { return "unknown"; } })(),
      chromeExecutable: CHROME,
      chromeVersion,
      browserMode: "headless"
    },
    fixture: {
      file: "tools/visual/fixture.html",
      boot: "tools/visual/fixture-boot.js",
      hostTokens: "tools/visual/host/host-tokens.css",
      hostTokensSha256: sha256File(join(HERE, "host", "host-tokens.css")),
      hostTokensSource: "desktop asar: dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js（见 host-tokens.css 文件头 provenance）",
      primitivesPath: diagnostics.primitives,
      localStorageAvailable: diagnostics.localStorageAvailable,
      exit: "官方 main 席位（variant=main）+ 真 React 18.3.1 + 真 DOM"
    },
    clientSnapshot: snap,
    vendor: { react: vendor.react, reactDom: vendor["react-dom"] },
    viewportPolicy: {
      widths: WIDTHS,
      fixedHeight: FIXED_H,
      modes: { fixed: "视口 = 截图尺寸，面板超出部分被裁（manifest.contentHeight 记录真实内容高）", full: "整页截图（仅宽度 " + WIDTHS[0] + "）" }
    },
    views: VIEWS,
    capturedViews,
    missingViews: VIEWS.filter((v) => capturedViews.indexOf(v) === -1),
    checks: {
      allNineViewsCaptured: VIEWS.every((v) => capturedViews.indexOf(v) !== -1),
      everyViewCapturedAtBothWidths: VIEWS.every((v) => WIDTHS.every((w) => shots.some((s) => s.view === v && s.width === w && s.mode === "fixed"))),
      noExternalRequests: externalRequests.length === 0,
      pluginWarningsEmpty: (diagnostics.pluginWarnings || []).length === 0,
      consoleErrorsEmpty: (diagnostics.consoleErrors || []).length === 0,
      hostDownRendered: shots.some((s) => /hostdown/.test(s.file))
    },
    diagnostics,
    contactSheets: sheets,
    shots,
    failures
  };
  writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log("\n[summary] 视图 " + capturedViews.length + "/" + VIEWS.length
    + " | 截图 " + shots.length + " 张 | 联络表 " + sheets.length + " 张"
    + " | 外网请求 " + externalRequests.length
    + " | 插件告警 " + (diagnostics.pluginWarnings || []).length
    + " | console.error " + (diagnostics.consoleErrors || []).length
    + " | 失败 " + failures.length);
  if (failures.length > 0) {
    for (const f of failures) console.error("[FAIL] " + JSON.stringify(f));
  }
  console.log("[manifest] " + join(OUT_DIR, "manifest.json"));
  process.exitCode = failures.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("capture 失败: " + ((err && err.stack) || err));
  process.exit(1);
});
