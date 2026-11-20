/**
 * dsh-novel-writer — core/http.js（Layer 4：本地 HTTP 路由、请求体安全读取与系统文件管理器启动）
 *
 * 严格 DAG 最顶层：依赖 ./state.js、./text.js、./domain.js 与外围服务模块（update-check / trash / style-metrics / embedding / log）。
 */

import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { logEvent } from "../log.js";
import { checkForUpdate } from "../update-check.js";
import { METRIC_CALIBER } from "../analysis.js";
import { readChapterMetrics } from "../db.js";
import {
  classifyChapterScene, computeBaselineFromPerChapter, computeSceneBaselines,
  enrichPerChapterScenes, measureStyleMetrics, METRIC_LABELS, METRIC_ORDER,
  MIN_SCENE_BAND_CHAPTERS
} from "../style-metrics.js";
import * as embedding from "../embedding.js";
import { movePathsToTrash } from "../trash.js";
import {
  PLUGIN_VERSION, CHAT_PROMPT_THRESHOLD_CHARS, sanitizeSegment, isAbort,
  resolveUiRootInfo, resolveUiRoot, novelDataDir, featureEnabled,
  stateFilePath, readSentenceState, withFileTx, writeSentenceState
} from "./state.js";
import { scanChapters, readTextFile, decodeTextBuffer, listBookNames } from "./text.js";
import {
  normalizeCreationProfile, listBookCreationProfiles, clearAllBookCreationProfiles,
  applyBookCreationProfilesPatch, syncCreationProfileFiles, SMALL_BASELINE_CHAPTERS, SMALL_BASELINE_TOL_PCT,
  BASELINE_SCOPE_MODES, baselineScopeFile, readBaselineScope, writeBaselineScope,
  LEXICON_KINDS, GLOBAL_LEXICON_BOOK, lexiconFile, parseLexiconLine,
  readLexiconFile, readLexicon, writeLexicon, mergeLexiconEntries
} from "./domain.js";

function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = request.headers?.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try { hostUrl = new URL(`http://${host}`); } catch { return false; }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (request.headers?.["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers?.origin;
  if (origin === void 0) return true;
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}
export function isAllowedRequest(request, allowLan) {
  if (isLoopbackRequest(request)) return true;
  if (allowLan !== true) return false;
  const host = request.headers?.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try { hostUrl = new URL(`http://${host}`); } catch { return false; }
  if (request.headers?.["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers?.origin;
  if (origin === void 0) return true;
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}
export function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}
// v7.3.4（④-①）：去掉 export——BODY_TOO_LARGE 保持内部私有符号，对外提供 isBodyTooLarge 谓词。
const BODY_TOO_LARGE = Symbol("bodyTooLarge");
export function isBodyTooLarge(body) {
  return Boolean(body && typeof body === "object" && body[BODY_TOO_LARGE] === true);
}
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  const LIMIT = 1024 * 1024; // v3.9.0：16KB → 1MB（原创模式长设定被 400 拒，UI 静默降级 localStorage）
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMIT) return { [BODY_TOO_LARGE]: true };
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    // v6.6.0：请求体不是合法 JSON → 返回 void 0，调用方一律讲成"参数缺失/参数错误"
    //（真因是**面板与宿主契约失配**，与"用户没填"完全是两回事）
    logEvent("panel", { level: "warn", detail: "面板请求体 JSON 解析失败（被当作未提供参数处理）" });
    return void 0;
  }
}
/**
 * v6.2.1：路由层读 POST 体的**唯一入口**——包住 readJsonBody，绝不裸抛。
 *
 * 背景：`for await (const chunk of req)` 在客户端读到一半断开时会让 readJsonBody reject（ECONNRESET 等），
 * 而该 await 一直落在各 handler 的 try 之外（历史缺陷：/state、/reveal，v6.2.0 又加了 /lexicon，共三例），
 * 结果是裸抛异常、**一个字节的响应都没写**，宿主只看到连接被断。这里统一转成两个可判定的结果：
 *   - 取消（AbortError）：原样上抛——取消不是"body 读失败"，不能伪装成 client error；
 *   - 流异常：返回 undefined，由调用方按既有的 invalid JSON body（400）分支回复。
 * @returns 解析后的 body / undefined（读失败或非法 JSON）
 */
export async function readRequestBody(req) {
  try {
    return await readJsonBody(req);
  } catch (e) {
    if (isAbort(e)) throw e;
    // v6.6.0：读取请求体时出错（流中断等）被静默当成"没传参数"，与"JSON 写错"表现一样，真因留痕
    logEvent("panel", { level: "warn", detail: "面板请求体读取失败：" + (e?.message ?? e) });
    return void 0;
  }
}
/**
 * v5.2.0 修正：`explorer.exe` 的退出码**不可信**——它成功打开目录时也常返回 1（Windows 的既有行为），
 * 于是 `resolve(!err)` 把成功判成了失败：面板上显示「explorer 启动失败，未能定位目录」，而目录其实已经打开了。
 * 判据改为只认"进程根本没起来"——那种错误的 `code` 是字符串 errno（ENOENT / EACCES …）；
 * 带数字 `code`（退出码）说明进程确实跑过，一律视为已交给系统外壳。
 * @param err - execFile 回调的错误对象（成功时为 null）。
 * @returns 是否属于"连启动都没起来"的失败。
 */
export function explorerSpawnFailed(err) {
  if (!err) return false;
  return typeof err.code !== "number";
}
async function openInExplorer(dir) {
  if (process.platform === "win32") {
    // execFile 数组直调不经 shell，路径含 & 等特殊字符不会注入
    return await new Promise(function (resolve) {
      try {
        execFile("explorer.exe", ["/select," + dir], function (err) { resolve(!explorerSpawnFailed(err)); });
      } catch { resolve(false); }
    });
  } else if (process.platform === "darwin") {
    // v4.0.0 修正：与 win32 分支统一用 Promise 等回调——execFile 的 ENOENT 是异步交给回调的，
    // 旧版空回调 + 无条件 return true 会在无 open/xdg-open 时谎报"已打开文件夹"
    return await new Promise(function (resolve) {
      try {
        execFile("open", [dir], function (err) { resolve(!err); });
      } catch { resolve(false); }
    });
  }
  return await new Promise(function (resolve) {
    try {
      execFile("xdg-open", [dir], function (err) { resolve(!err); });
    } catch { resolve(false); }
  });
}

const bookStatsCache = { key: null, at: 0, data: null };
async function bookStats(root) {
  const dir = join(root, "novels");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    // 指纹：书目录名 + 章节文件名/size/mtime（不读内容）
    let fp = "";
    const bookFiles = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "创作资料" || entry.name.startsWith(".")) continue;
      const bookPath = join(dir, entry.name);
      try {
        const files = await readdir(bookPath, { withFileTypes: true });
        const list = [];
        for (const f of files) {
          if (!f.isFile() || !/\.(md|markdown|txt)$/i.test(f.name)) continue;
          const st = await stat(join(bookPath, f.name));
          fp += entry.name + "/" + f.name + ":" + st.mtimeMs + ":" + st.size + ";";
          list.push(f.name);
        }
        bookFiles.push({ name: entry.name, files: list });
      } catch {
        // v6.6.0：这一项来自**刚读到的目录清单**，读不动它不是"这本书没有章节"而是真故障——
        // 旧版直接跳过，作品列表里这本书凭空少掉（与"这本书不存在"在输出上完全一样）
        logEvent("silent_skip", { book: entry.name, level: "warn", detail: "作品目录不可读，已从作品统计中跳过（列表会少这一本）" });
      }
    }
    // v3.9.0 修正：缓存键含书库根——多 profile/切换工作区不串数据
    const cacheKey = root + "|" + fp;
    if (bookStatsCache.key === cacheKey && Date.now() - bookStatsCache.at < 30000) return bookStatsCache.data;
    const out = [];
    const weekAgo = Date.now() - 7 * 86400000;
    for (const book of bookFiles) {
      const bookPath = join(dir, book.name);
      let chapters = 0, chars = 0, recent7 = 0, decodeErrors = 0;
      for (const fname of book.files) {
        // v4.0.0 修正：try 收进循环体内——旧版整个 for 共用一个 try，第 k 个文件解码失败
        // 会让其后所有章节的 chapters/chars/recent7 全部不再累加（UI 显示偏小的错值且无提示）
        try {
          const full = join(bookPath, fname);
          const st = await stat(full);
          chapters += 1;
          // v3.5.0 M11：与其余工具同口径解码（GBK/UTF-16 章节字数不再按 UTF-8 误读）
          const buf11 = await readFile(full);
          const txt = decodeTextBuffer(buf11, full);
          chars += txt.length;
          if (st.mtimeMs >= weekAgo) recent7 += txt.length;
        } catch { decodeErrors += 1; /* 单文件不可读/编码无法识别：只跳过它 */ }
      }
      out.push({ name: book.name, chapters, chars, recent7Chars: recent7, decodeErrors });
    }
    const result = out.sort(function (a, b) { return b.recent7Chars - a.recent7Chars; });
    bookStatsCache.key = root + "|" + fp;
    bookStatsCache.at = Date.now();
    bookStatsCache.data = result;
    return result;
  } catch (e) {
    // v6.6.0：novels/ 目录读不动 → 对外是「暂无作品」，与「书库里本来就没有书」长得一模一样
    if (e?.code !== "ENOENT") {
      logEvent("silent_skip", { root, level: "warn", detail: "作品统计读取失败（作品列表按空处理）：" + String(e?.message ?? e) });
    }
    return [];
  }
}

async function enrichCachedChaptersReadOnly(root, safeBook, validChapters, available) {
  const lacksScene = validChapters.some((c) => !c.scene?.band);
  if (lacksScene && available.length <= 40) {
    const chapterTexts = new Map();
    for (const ch of available) {
      try {
        chapterTexts.set(ch.file, await readTextFile(join(root, "novels", safeBook, ch.file)));
      } catch {
        /* 忽略单章读取失败 */
      }
    }
    return enrichPerChapterScenes(validChapters, chapterTexts);
  }
  return enrichPerChapterScenes(validChapters);
}

/**
 * 只读读取或现场估算书籍的分场景六维基线统计（绝不写盘缓存）。
 * 优先复用 SQLite `chapter_metrics`（`readOnly: true`），未命中再回退 `<root>/.novel-writer/analysis/<book>-chapters-metrics.json`（兼容 perChapter/chapters 键），
 * 仅在未命中缓存且章节数 ≤ 25 时现场读取正文测量，大书未缓存直接降级标记 uncachedLargeBook。
 */
async function readSceneBaselinesSafe(root, safeBook, available, files) {
  if (available.length === 0) {
    return {
      totalChapters: 0,
      measuredChapters: 0,
      counts: { dialogue: 0, action: 0, narrative: 0 },
      availableBands: [],
      minPeerChapters: MIN_SCENE_BAND_CHAPTERS,
      bands: {},
      fromCache: false
    };
  }

  let perChapter = null;
  let fromCache = false;

  try {
    const dbRes = readChapterMetrics(root, safeBook, { readOnly: true, caliber: METRIC_CALIBER });
    if (dbRes && Array.isArray(dbRes.rows) && dbRes.rows.length > 0) {
      const validChapters = [];
      for (const row of dbRes.rows) {
        if (!files.has(row.chapter)) continue;
        let metrics = null;
        try {
          metrics = JSON.parse(row.metrics_json);
        } catch {
          metrics = null;
        }
        if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) continue;
        let scene = null;
        if (typeof row.scene_json === "string" && row.scene_json !== "") {
          try {
            const parsedScene = JSON.parse(row.scene_json);
            if (parsedScene && typeof parsedScene === "object" && !Array.isArray(parsedScene)) {
              scene = parsedScene;
            }
          } catch {
            scene = null;
          }
        }
        validChapters.push({
          file: row.chapter,
          metrics,
          ...(scene ? { scene } : {})
        });
      }
      if (validChapters.length > 0) {
        perChapter = await enrichCachedChaptersReadOnly(root, safeBook, validChapters, available);
        fromCache = true;
      }
    }
  } catch (e) {
    if (isAbort(e)) throw e;
    /* SQLite 读取失败，继续尝试旧版 JSON 回退 */
  }

  if (perChapter === null) {
    const cachePath = join(novelDataDir(root), "analysis", `${safeBook}-chapters-metrics.json`);
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8"));
      const rawList = Array.isArray(cached?.perChapter)
        ? cached.perChapter
        : (Array.isArray(cached?.chapters) ? cached.chapters : null);
      if (Array.isArray(rawList)) {
        const validChapters = rawList.filter((c) => (
          c && typeof c === "object" && c.metrics && typeof c.metrics === "object" && !Array.isArray(c.metrics)
          && (typeof c.file !== "string" || files.has(c.file))
        ));
        if (validChapters.length > 0) {
          perChapter = await enrichCachedChaptersReadOnly(root, safeBook, validChapters, available);
          fromCache = true;
        }
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      /* 缓存不存在或 JSON 损坏，回退到按章节数分支处理 */
    }
  }

  if (perChapter === null) {
    if (available.length <= 25) {
      perChapter = [];
      for (const c of available) {
        try {
          const text = await readTextFile(join(root, "novels", safeBook, c.file));
          const m = measureStyleMetrics(text).metrics;
          const scene = classifyChapterScene({ text, metrics: m });
          perChapter.push({ file: c.file, metrics: m, scene });
        } catch {
          /* 忽略单章读取失败 */
        }
      }
      fromCache = false;
    } else {
      return {
        totalChapters: available.length,
        measuredChapters: 0,
        counts: { dialogue: 0, action: 0, narrative: 0 },
        availableBands: [],
        minPeerChapters: MIN_SCENE_BAND_CHAPTERS,
        bands: {},
        fromCache: false,
        uncachedLargeBook: true
      };
    }
  }

  const sb = computeSceneBaselines(perChapter);
  return {
    totalChapters: available.length,
    measuredChapters: sb.totalChapters,
    counts: sb.counts,
    availableBands: sb.availableBands,
    minPeerChapters: MIN_SCENE_BAND_CHAPTERS,
    fromCache,
    bands: Object.fromEntries(
      Object.entries(sb.bands).map(([k, v]) => [k, {
        band: v.band,
        label: v.label,
        chapterCount: v.chapterCount,
        baseline: v.baseline
      }])
    )
  };
}

export function makeStateRoutes(allowLan, config) {
  const routePath = "/api/dsh-novel-writer/state";
  const revealPath = "/api/dsh-novel-writer/reveal";
  const handler = async (req, res) => {
    if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
    const method = req.method ?? "GET";
    if (method === "GET") {
      try {
      const state = await readSentenceState();
      // v0.8.0：修复 cordis 注入空字符串 root 时 ?? 不生效的问题
      // v3.7.0 高2：全新环境（无 config.root、无 lastRoot）回退 cwd——listBookNames(undefined) 不再 TypeError
      // v6.4.0：改用 core 的**单一实现** resolveUiRootInfo（旧版这里内联一个三元，与 makeStateRoutes 内的
      // resolveUiRoot 闭包重复；且失败时完全静默——根配错只会让面板"一本书都没有"，不报错不写日志）。
      const params = new URLSearchParams(String(req.url || "").split("?")[1] || "");
      const queryRoot = String(params.get("root") ?? "").trim();
      const rootInfo = resolveUiRootInfo(queryRoot !== "" ? { ...(config || {}), root: queryRoot } : config, state);
      const root = rootInfo.root;
      const mergedCreationProfiles = await listBookCreationProfiles(root, state);
      const dataDir = typeof root === "string" && root.length > 0 ? novelDataDir(root) : "";
      // v2.6.0：数据目录占用 + 语义引擎状态（status() 只探测文件、不触发模型加载）
      let dataDirSize = 0;
      try {
        // v6.2.1 修正（旧清单 #8，注释不符）：删掉 `dataDir !== ""` 守卫——dataDir 由上面同一行三元算出，
        // 只在 root 为空串时才是 ""，而 root 已经过 length > 0 判定，故该条件恒为真（死代码，会误导维护者
        // 以为这里真的能拿到空 dataDir）。dataDir 的"可能为空"由类型层面表达，不再重复运行期判断。
        if (existsSync(dataDir)) {
          // v4.0.0 修正：同步递归 readdirSync/statSync 会阻塞宿主事件循环（该目录含 MB 级 embedding 索引），
          // 改用 fs/promises 异步遍历；单个文件 stat 失败跳过，不整次归零
          const walk = async (d) => {
            let s = 0;
            for (const e of await readdir(d, { withFileTypes: true })) {
              const fp = join(d, e.name);
              if (e.isDirectory()) s += await walk(fp);
              else if (e.isFile()) { try { s += (await stat(fp)).size; } catch { /* 统计失败跳过该文件 */ } }
            }
            return s;
          };
          dataDirSize = await walk(dataDir);
        }
      } catch {
        // v6.6.0：上面的 existsSync 已排除"目录不存在"，故此处是真读不动；面板会把体积显示成 0
        //（看起来像"什么都没存"），而真因（权限/IO）从此有据可查。
        logEvent("panel", { path: dataDir, level: "warn", detail: "插件数据目录体积统计失败（面板显示为 0）" });
      }
      let embeddingStatus = null;
      try {
        // v4.0.0 修正：改用顶部静态 import（embedding.js 顶层只依赖 node 内置模块，动态 import 无收益）
        embeddingStatus = embedding.status ? embedding.status() : null;
      } catch {
        // v6.6.0：语义引擎状态读不到 → 面板/工具会把它显示成"引擎未就绪"，
        // 与"用户没装模型"表现一样（而这是引擎自身的故障）
        logEvent("engine", { detail: "语义引擎状态读取失败（上层会按引擎不可用处理）" });
      }
      return writeJson(res, 200, {
        enabled: state.enabled,
        autoAnalyze: state.autoAnalyze,
        // v4.0.0：系统提示词档位（侧边栏首页开关读它）
        systemPromptMode: state.systemPromptMode ?? "brief",
        // v5.0.0：提示词场景（侧边栏首页开关读它）
        promptScene: state.promptScene ?? "general",
        // v5.0.0：精简工作流（侧边栏首页开关读它；老宿主/老状态文件没有该键 → false，UI 显示关闭态）
        leanWorkflow: state.leanWorkflow ?? false,
        tools: state.tools ?? {},
        features: state.features ?? {},
        // v7.3.1 修（#80）：GET /state 此前**不下发** chatThreshold，而面板是用它渲染「提问节奏」输入框的。
        // 后果：用户设成 150、保存成功（state.json 里确实是 150），但面板拿不到值 → 用 400 兜底显示，
        // 这时再点一次保存就把真实的 150 覆盖成 400。POST /state 的回包一直是有的，只有 GET 漏了这一个键。
        chatThreshold: state.chatThreshold ?? CHAT_PROMPT_THRESHOLD_CHARS,
        // v3.0.0：风格基线容差（±%）
        styleTolerance: state.styleTolerance ?? null,
        // v3.1.0：原创模式设定
        creationProfile: state.creationProfile ?? null,
        // v3.1.0：按书专属设定（合并书库本地 settings/<book>.json 与遗留 state.creationProfiles）
        creationProfiles: mergedCreationProfiles,
        // v3.1.0：书列表（原创模式设定库用）——novels 目录 ∪ 已预配置设定的书（含未建目录的新书）
        books: [...new Set([...(await listBookNames(root)), ...Object.keys(mergedCreationProfiles)])].sort(function (a, b) { return a.localeCompare(b, "zh"); }),
        // v3.2.0：书库统计（写作打卡：章数/总字数/近 7 天活跃字数）
        booksStats: await bookStats(root),
        dataDirSize,
        embeddingStatus,
        dataDir,
        // v6.4.0：把"我到底读的是哪个根、从哪来、有没有问题"一并回传。
        // 这条链上的失败此前完全静默（面板只是空着），是本次排查耗时最久的地方。
        root,
        rootSource: rootInfo.source,
        rootWarning: rootInfo.warning,
        // v6.2.1：删掉 `dataDir !== "" ?` 三元（同 #8 的恒真守卫）——dataDir 在此必然非空，
        // 旧写法让读者以为存在"根未知"的运行时状态，实际由 resolveUiRoot 兜底保证不会发生。
        plotsDir: join(dataDir, "plots"),
        dirs: {
          dataDir,
          plotsDir: join(dataDir, "plots"),
          settingsDir: join(dataDir, "settings"),
          summariesDir: join(dataDir, "summaries"),
          lexiconDir: join(dataDir, "lexicon"),
          analysisDir: join(dataDir, "analysis"),
          auditsDir: join(dataDir, "audits"),
          embeddingDir: join(dataDir, "embedding"),
          stateFile: stateFilePath()
        },
        file: stateFilePath()
      });
      } catch (err) {
        // v3.7.0 高2：GET 任何异常返回 500 JSON（不裸抛杀宿主）
        return writeJson(res, 500, { error: "state read failed: " + String(err).slice(0, 120) });
      }
    }
    if (method === "POST") {
      // v6.2.1：readRequestBody 内部吞掉流异常（旧版 readJsonBody 裸抛，客户端中途断开时连响应都写不出去）
      const body = await readRequestBody(req);
      if (isBodyTooLarge(body)) return writeJson(res, 413, { error: "request body too large (limit 1MB)" });
      if (body === void 0 || body === null || typeof body !== "object" || Array.isArray(body)) return writeJson(res, 400, { error: "invalid JSON body" });
      try {
        // v3.7.0 高3：路由层剥离 novel_sentence_config（与工具侧一致）——UI 一键全关不能锁死 AI 通道（关了 AI 就无法再开）
        if (body?.tools && typeof body.tools === "object" && !Array.isArray(body.tools)) {
          const toolsClone = { ...body.tools };
          delete toolsClone.novel_sentence_config;
          body.tools = toolsClone;
        }
        if (body?.creationProfiles !== void 0 && body.creationProfiles !== null && (typeof body.creationProfiles !== "object" || Array.isArray(body.creationProfiles))) {
          throw new Error("参数 \"creationProfiles\" 必须是键值对象或 null");
        }
        const hasCreationProfiles = body?.creationProfiles !== void 0;
        const statePatch = { ...body };
        if (hasCreationProfiles) delete statePatch.creationProfiles;
        if (Object.prototype.hasOwnProperty.call(statePatch, "creationProfile")) {
          if (statePatch.creationProfile === null) {
            statePatch.creationProfile = null;
          } else if (typeof statePatch.creationProfile === "object" && !Array.isArray(statePatch.creationProfile)) {
            statePatch.creationProfile = normalizeCreationProfile(statePatch.creationProfile);
          } else {
            delete statePatch.creationProfile;
          }
        }
        let next = await writeSentenceState(statePatch);
        // v3.1.0：保存设定 → 同步创建/更新该书创作资料（有书库根时；文件写失败不影响设定保存）
        // v7.3.3 修（#7）：根解析改走**全插件唯一实现** resolveUiRootInfo。
        //   旧版这里是第三个独立实现：`config.root.length > 0`（不 trim，纯空格被当成有效路径）+
        //   直取 `next.lastRoot`（不校验它是否真像书库根、也不回退 cwd/internal）。
        //   实测后果：state.lastRoot 指向一个过期目录时，保存设定会把创作资料**写进那个过期路径**，
        //   而面板其余路由都走 resolveUiRootInfo —— 两套口径各写各的。
        const bodyRoot = typeof body?.root === "string" ? body.root.trim() : "";
        const cpRoot = resolveUiRootInfo(bodyRoot !== "" ? { ...(config || {}), root: bodyRoot } : config, next).root;
        const isClearAll = hasCreationProfiles && (body.creationProfiles === null || (typeof body.creationProfiles === "object" && Object.keys(body.creationProfiles).length === 0));
        if (hasCreationProfiles) {
          if (cpRoot) {
            if (isClearAll) await clearAllBookCreationProfiles(cpRoot);
            else await applyBookCreationProfilesPatch(cpRoot, body.creationProfiles);
          }
          next = await readSentenceState();
        }
        const mergedCreationProfiles = await listBookCreationProfiles(cpRoot, next);
        if (cpRoot && hasCreationProfiles) {
          await syncCreationProfileFiles(cpRoot, body.creationProfiles, isClearAll ? null : mergedCreationProfiles);
        }
        return writeJson(res, 200, { ...next, creationProfiles: mergedCreationProfiles, file: stateFilePath() });
      } catch (error) {
        // v4.3.0：区分"写盘失败"与"参数错误"——旧版一律 400，磁盘没写成功时 GUI 只看到"参数错误"，误导排查方向
        const status = error?.code === "ENOVELWRITEFAIL" ? 500 : 400;
        return writeJson(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return writeJson(res, 405, { error: `method not allowed: ${method}` });
  };
  // v6.2.0：必用词表 UI 路由——词表面板用它读写（list 走 GET，其余走 POST；写盘复用 core 的同一套归一与合并）
  const lexiconHandler = async (req, res) => {
    if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
    const method = req.method ?? "GET";
    const state = await readSentenceState();
    const root = resolveUiRoot(config, state);
    const scopeOf = (value) => (value === "global" ? "global" : value === "book" ? "book" : "all");
    if (method === "GET") {
      try {
        const params = new URLSearchParams(String(req.url || "").split("?")[1] || "");
        // v6.2.1 修正（高危）：空书名先判空再净化。sanitizeSegment("") 自 v3.5.0 起就 assert 抛错，
        // 而这一行在 try 之外——UI 首屏必然发 `?book=&scope=all`（client.js 的 lexiconBook 初值就是 ""），
        // 于是词表页第一次打开只弹「加载失败」，下面那条「空书名退化为只读全局层」的兜底成了死代码。
        // 现在：空书名 → book=""，交给下方 scope 分支按"只读全局层"处理；非空才净化。
        const rawBook = String(params.get("book") ?? "").trim();
        const book = rawBook === "" ? "" : sanitizeSegment(rawBook, "book");
        const scope = scopeOf(params.get("scope"));
        const query = (params.get("q") ?? "").trim();
        // scope=global 一律读全局层，完全不看 book 参数（不校验、也不因它 500）
        let entries = [];
        let counts = { book: 0, global: 0, effective: 0 };
        let files = {};
        let enabled = true;
        let bookEnabled = true;
        let globalEnabled = true;
        let corrupt = false;
        const corruptFiles = [];
        const noteCorrupt = function (f) {
          if (f?.corrupt === true) {
            corrupt = true;
            corruptFiles.push({ file: f.file, error: f.corruptError ?? "读取或解析失败" });
          }
        };
        if (scope === "global") {
          const f = await readLexiconFile(root, GLOBAL_LEXICON_BOOK);
          noteCorrupt(f);
          entries = f.entries.map(function (e) { return { ...e, scope: "global" }; });
          counts = { book: 0, global: f.entries.length, effective: f.entries.length };
          files = { global: f.file };
          enabled = f.enabled;
          globalEnabled = f.enabled;
        } else if (scope === "book" || book === "") {
          const f = await readLexiconFile(root, book === "" ? GLOBAL_LEXICON_BOOK : book);
          noteCorrupt(f);
          const layer = book === "" ? "global" : "book";
          entries = f.entries.map(function (e) { return { ...e, scope: layer }; });
          counts = layer === "global" ? { book: 0, global: f.entries.length, effective: f.entries.length } : { book: f.entries.length, global: 0, effective: f.entries.length };
          files = { [layer]: f.file };
          enabled = f.enabled;
          if (layer === "global") globalEnabled = f.enabled; else bookEnabled = f.enabled;
        } else {
          const lex = await readLexicon(root, book);
          entries = lex.entries;
          counts = lex.counts;
          files = lex.files;
          bookEnabled = lex.book.enabled;
          globalEnabled = lex.global.enabled;
          // v6.2.1：损坏标记必须出现在响应体里（否则 UI 只看到"空表"，接着 read→write 就把该层清空）
          for (const f of [lex.global, lex.book]) noteCorrupt(f);
        }
        if (query !== "") {
          entries = entries.filter(function (e) {
            return [e.term, e.kind, e.scene, e.note].some(function (v) { return typeof v === "string" && v.includes(query); })
              || (Array.isArray(e.avoid) && e.avoid.some(function (w) { return w.includes(query); }));
          });
        }
        const books = await listBookNames(root);
        return writeJson(res, 200, {
          ok: true,
          root,
          book,
          scope,
          entries,
          counts,
          files,
          enabled,
          bookEnabled,
          globalEnabled,
          // v6.2.1 新增字段（既有字段形状不变）：corrupt/corruptFiles 告知"该层文件损坏、读到的是空表"，
          // 供 UI 警示与"确认覆盖"二次确认；写侧由 writeLexicon 的守卫拒写（除非 force/overwrite）。
          corrupt,
          corruptFiles,
          featureEnabled: featureEnabled(state, "lexiconFirst"),
          kinds: LEXICON_KINDS,
          books: [...new Set([...books, ...(book !== "" ? [book] : [])])].sort(function (a, b) { return a.localeCompare(b, "zh"); }),
          dir: join(novelDataDir(root), "lexicon")
        });
      } catch (err) {
        return writeJson(res, 500, { ok: false, error: "lexicon read failed: " + String(err).slice(0, 160) });
      }
    }
    if (method !== "POST") return writeJson(res, 405, { error: `method not allowed: ${method}` });
    // v6.2.1：同 /state POST——readRequestBody 吞流异常（旧版此处裸抛，客户端断开时无响应）
    const body = await readRequestBody(req);
    if (isBodyTooLarge(body)) return writeJson(res, 413, { error: "request body too large (limit 1MB)：词表几千条以内够用，超过请用 novel_lexicon action=import 分批导入" });
    if (body === void 0 || body === null || typeof body !== "object" || Array.isArray(body)) return writeJson(res, 400, { error: "invalid JSON body" });
    try {
      const scope = body.scope === "global" ? "global" : "book";
      const op = typeof body.op === "string" ? body.op : "save";
      // v6.2.1 修正：只有真给了非空书名才净化——旧版 sanitizeSegment(body.book ?? "") 的 assert 抢在
      // 下面那句友好 400 之前抛出，`{op:"toggle",scope:"book",book:""}` 只能拿到 assert 的报错文本。
      const rawBook = String(body.book ?? "").trim();
      if (scope === "book" && rawBook === "") {
        return writeJson(res, 400, { ok: false, error: "book is required for scope=book（缺书名时不会自动写全局层）" });
      }
      const book = scope === "global" ? GLOBAL_LEXICON_BOOK : sanitizeSegment(rawBook, "book");
      // v6.2.1：损坏层默认拒写（writeLexicon 守卫），只有调用方显式确认才允许覆盖：
      // save/import 走 overwrite:true，toggle 走 force:true。原条目永不静默消失。
      const force = body.overwrite === true || body.force === true;
      // v6.3.0（独立校验）：读—改—写必须与工具侧共用同一把锁。此前只有工具的五个写 action 走了
      // withFileTx，而**界面的 toggle / save / import 全部走这条路由** —— 两边同时写同一层会丢更新
      // （实测：并发「工具 add」+「路由 POST save」后，该层只剩一条）。这里用与 index.js 的
      // withLexiconTx **同一个 file key** 包住整段读—改—写，两边因此真正互斥；
      // writeLexicon 自身不取锁，故不会自锁。
      const lexFile = lexiconFile(root, book);
      return await withFileTx(lexFile, async () => {
        const current = await readLexiconFile(root, book);
        if (current.corrupt === true && force !== true) {
          return writeJson(res, 409, {
            ok: false,
            corrupt: true,
            corruptFiles: [{ file: current.file, error: current.corruptError ?? "读取或解析失败" }],
            error: "词表文件损坏，已拒绝覆盖：" + current.file + "（原因：" + (current.corruptError ?? "解析失败") + "）。" +
              "先备份并手工修复；确认要丢弃其内容时用 overwrite:true 覆盖写入。"
          });
        }
        if (op === "toggle") {
          if (typeof body.enabled !== "boolean") return writeJson(res, 400, { error: "enabled (boolean) is required" });
          const written = await writeLexicon(root, book, { entries: current.entries, enabled: body.enabled, force });
          return writeJson(res, 200, { ok: true, op, enabled: written.enabled, count: written.count, file: written.file });
        }
        if (op === "save") {
          if (!Array.isArray(body.entries)) return writeJson(res, 400, { error: "entries (array) is required" });
          // v7.3.3 修（#6）：显式传入的 `enabled` 必须照办。
          // 旧式 `body.enabled !== false && current.enabled` 在两个方向都错：
          //   ① 层原本关闭时传 `enabled:true` → 结果仍是 false（保存永远开不起来，面板只能改用 toggle）；
          //   ② 缺省（undefined）时 `undefined !== false` 为真 → 保留 current.enabled（这条是对的，要保持）。
          const written = await writeLexicon(root, book, {
            entries: body.entries,
            enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
            force
          });
          return writeJson(res, 200, { ok: true, op, enabled: written.enabled, count: written.count, file: written.file });
        }
        if (op === "import") {
          const text = typeof body.text === "string" ? body.text : "";
          const incoming = [];
          for (const line of text.split(/\r?\n/)) {
            const parsed = parseLexiconLine(line);
            if (parsed === null) continue;
            if (typeof body.kind === "string" && body.kind.trim() !== "" && parsed.kind === void 0) parsed.kind = body.kind.trim();
            if (typeof body.scene === "string" && body.scene.trim() !== "" && parsed.scene === void 0) parsed.scene = body.scene.trim();
            incoming.push(parsed);
          }
          if (incoming.length === 0) return writeJson(res, 400, { error: "没有解析到任何词条（每行一条：词，或 词|类型|场景|替身1,替身2|备注）" });
          const base = body.replace === true ? [] : current.entries;
          const merged = mergeLexiconEntries(base, incoming, { overwrite: body.overwrite !== false });
          const written = await writeLexicon(root, book, { entries: merged.entries, enabled: current.enabled, force });
          return writeJson(res, 200, { ok: true, op, added: merged.added.length, updated: merged.updated.length, skipped: merged.skipped.length, count: written.count, file: written.file });
        }
        return writeJson(res, 400, { error: "unknown op (allowed: save / import / toggle)" });
      });
    } catch (error) {
      const status = error?.code === "ENOVELWRITEFAIL" ? 500 : 400;
      // corrupt 键只在真损坏时出现（JSON.stringify 会把 undefined 写成 null，故不能无脑带上）
      const bodyOut = { ok: false, error: error instanceof Error ? error.message : String(error) };
      if (error?.corrupt === true) bodyOut.corrupt = true;
      return writeJson(res, status, bodyOut);
    }
  };
  /**
   * v6.5.5：风格基线范围（按全书 / 按部分）读写的 HTTP 端点。
   *
   * 为什么走独立路由而不是塞进 `/state`：`/state` 是**全局**插件状态
   * （`styleTolerance` 就在那里），而"哪些章当基线"**天然属于某一本书**——
   * 章节是书的一部分，换本书就没有意义了。所以它跟词表一样按书存、按书读写。
   *
   * 语义要点（详见 resolveBaselineScope 的注释）：`custom` 是**只用**选中的章；
   * 目标章永远排除；选中项全部失效时回退 `all` 并披露，绝不返回空基线。
   */
  const baselineHandler = async (req, res) => {
    if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
    const method = req.method ?? "GET";
    const state = await readSentenceState();
    const root = resolveUiRoot(config, state);
    /** GET 与 POST 返回同一结构，前端一套渲染逻辑即可 */
    const respond = async (book) => {
      const safeBook = sanitizeSegment(book, "book");
      const conf = await readBaselineScope(root, safeBook);
      /**
       * **生效档位**：存储值可能是 `{mode:"custom", chapters:[]}`（用户清空了选择），
       * 而 resolveBaselineScope 对这种配置的实际行为是「按全书」。
       * 抽成函数是必须的——独立测试代理实测出：这条三元此前只写在主分支里，
       * 于是**同一份配置在目录存在时报 `all`、目录不存在时报 `custom`**（早退分支漏改）。
       * 界面显示的档位必须恒等于实际生效的档位，否则又回到"面板说按部分、实际按全书"。
       */
      const effectiveMode = (c) => (c.mode === "custom" && c.chapters.length > 0 ? "custom" : "all");
      let available = [];
      try {
        available = (await scanChapters(join(root, "novels", safeBook))).map((c) => ({ file: c.file, number: c.number, title: c.title }));
      } catch (e) {
        // 书目录不存在不该让"看范围"变成 500：返回空列表 + 提示，前端能照常显示"暂无章节"。
        // v6.5.5：这个早退分支也必须走 effectiveMode 并返回 missing（此前两处都漏，
        // 与主分支的返回结构不一致——测试代理指出"该分支还少返回 missing 键"）。
        return writeJson(res, 200, {
          ok: true, book: safeBook, mode: effectiveMode(conf), chapters: conf.chapters, available: [],
          smallSample: { chapters: SMALL_BASELINE_CHAPTERS, tolPct: SMALL_BASELINE_TOL_PCT },
          // 目录都不存在，"哪些选中章已失效"无从判定（全部无法核对），如实给空数组而不是编造
          missing: [], updatedAt: null, sceneBaselines: null, warning: "未找到作品目录：" + String(e?.message ?? e).slice(0, 120)
        });
      }
      // 选中项里已失效（改名/删除）的章：**如实回报**，否则用户看着选了 10 章、实际只有 7 章生效
      const files = new Set(available.map((c) => c.file));
      const missing = conf.chapters.filter((f) => !files.has(f));
      let updatedAt = null;
      try { updatedAt = JSON.parse(await readTextFile(baselineScopeFile(root, safeBook))).updatedAt ?? null; } catch { /* 无文件 */ }
      let sceneBaselines = null;
      try {
        sceneBaselines = await readSceneBaselinesSafe(root, safeBook, available, files);
      } catch (e) {
        if (isAbort(e)) throw e;
        sceneBaselines = null;
      }
      return writeJson(res, 200, {
        ok: true,
        book: safeBook,
        // v6.5.5：回报的是**生效档位**而不是存储值——理由见上方 effectiveMode 的注释。
        // （此前这里是内联三元，早退分支漏改导致同一配置两种回报；现已统一走函数。）
        mode: effectiveMode(conf),
        chapters: conf.chapters,
        available,
        smallSample: { chapters: SMALL_BASELINE_CHAPTERS, tolPct: SMALL_BASELINE_TOL_PCT },
        missing,
        updatedAt,
        sceneBaselines
      });
    };
    if (method === "GET") {
      try {
        const params = new URLSearchParams(String(req.url || "").split("?")[1] || "");
        const rawBook = String(params.get("book") ?? "").trim();
        // 空书名先判空再净化：sanitizeSegment("") 会 assert 抛错（与词表路由同一处坑，v6.2.1 已踩过）
        if (rawBook === "") return writeJson(res, 400, { ok: false, error: "book is required" });
        return await respond(rawBook);
      } catch (err) {
        return writeJson(res, 500, { ok: false, error: "baseline read failed: " + String(err).slice(0, 160) });
      }
    }
    if (method !== "POST") return writeJson(res, 405, { error: "method not allowed: " + method });
    const body = await readRequestBody(req);
    if (isBodyTooLarge(body)) return writeJson(res, 413, { error: "request body too large (limit 1MB)：基线只存章节文件名，正常远小于此" });
    if (body === void 0 || body === null || typeof body !== "object" || Array.isArray(body)) return writeJson(res, 400, { error: "invalid JSON body" });
    const rawBook = String(body.book ?? "").trim();
    if (rawBook === "") return writeJson(res, 400, { ok: false, error: "book is required" });
    if (body.mode !== void 0 && !BASELINE_SCOPE_MODES.includes(body.mode)) {
      return writeJson(res, 400, { ok: false, error: "mode must be one of: " + BASELINE_SCOPE_MODES.join(" / ") });
    }
    if (body.chapters !== void 0 && !Array.isArray(body.chapters)) {
      return writeJson(res, 400, { ok: false, error: "chapters must be an array of file names" });
    }
    try {
      // v6.5.5：两个字段都是**可选**的（PATCH 语义）——缺省即保留原值。
      // 为什么不能"缺省即空"：面板切到「按全书」再保存时，客户端只发 `{mode:"all"}`（甚至 `chapters:[]`），
      // 若照单全收，用户先前勾好的那十几章就被**静默清空**了
      // （表现为"我只是切回全书，再切回按部分，选择没了"）。
      //
      // 更关键的一条规则：**`mode` 非 custom 时不改动已保存的 `chapters`**。
      // 「切到按全书」的语义是"这次不用这个选择"，而不是"删掉这个选择"——
      // 选择是用户挑出来的标杆章，要清就得在「按部分」里显式清空才算数。
      // （客户端实测在 all 模式下发 `chapters:[]`，故光靠"缺省即保留"挡不住这个陷阱。）
      const current = await readBaselineScope(root, rawBook);
      const nextMode = body.mode === void 0 ? current.mode : body.mode;
      const nextChapters = nextMode === "custom"
        ? (body.chapters === void 0 ? current.chapters : body.chapters)
        : current.chapters;
      await writeBaselineScope(root, rawBook, { mode: nextMode, chapters: nextChapters });
      return await respond(rawBook);
    } catch (error) {
      const status = error?.code === "ENOVELWRITEFAIL" ? 500 : 400;
      return writeJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  // v3.2.0：体验演示——内置自创示例文本（不落盘），跑六维测量展示效果
  const demoHandler = async (req, res) => {
    if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
    if ((req.method ?? "GET") !== "GET") return writeJson(res, 405, { error: "method not allowed" });
    try {
      // v4.0.0 修正：删除动态 import（这四个符号已在文件顶部静态导入，此处只是遮蔽 + 多一次模块解析）
      const demoTexts = [
        "雨从傍晚下到深夜。阿澈把油布伞靠在门边，靴子上的泥在门槛前蹭了又蹭。\n\n「坐吧。」掌柜掀开帘子，端出一碗热汤。\n\n他接过碗，指尖还冻得发白，汤面的热气扑在脸上。\n",
        "天没亮，阿澈就醒了。他把昨晚的汤钱放在桌上，推门出去，雾把整条街都吞了。\n\n有人站在雾里，背对着他，手里提着一盏没点的灯。\n",
        "灯在雾里亮起来的时候，阿澈看清了那张脸——是他找了三年的人。\n\n「你迟到了。」那人说。\n\n阿澈站在原地，半天没动。\n"
      ];
      const per = demoTexts.map(function (t, i) { return { file: "示例第" + (i + 1) + "章", metrics: measureStyleMetrics(t).metrics }; });
      const baseline = computeBaselineFromPerChapter(per);
      const lines = ["# 🎬 体验演示：六维风格基线（内置示例 3 章）", "", "| 维度 | μ | 推荐容差 |", "|---|---|---|"];
      for (const k of METRIC_ORDER) {
        const b = baseline[k];
        // v4.0.0 修正：空样本维度没有 recTol 键，旧版会渲染成 "±undefined%"
        lines.push("| " + (METRIC_LABELS[k] || k) + " | " + b.mu.toFixed(2) + " | " + (typeof b.recTol === "number" ? "±" + b.recTol + "%" : "—") + " |");
      }
      lines.push("", "> 示例为插件内置文本（不落盘、不占书库）。想真正体验：在 novels/ 放一本小说，或让 AI 原创一本。", "");
      return writeJson(res, 200, { ok: true, chars: demoTexts.join("").length, report: lines.join("\n"), baseline });
    } catch (e) {
      return writeJson(res, 500, { ok: false, error: String(e).slice(0, 200) });
    }
  };
  // v3.9.0：UI 路由统一根回退（与 GET /state 一致：config.root → lastRoot → cwd）
  // v6.2.1：契约明确化——本函数**保证返回非空字符串**（末位兜底 process.cwd()），
  // 调用方不需要再判空；"根未知"不是可达运行期状态（旧清单 #8 的死分支即由此而来）。
  // v6.4.0：闭包版删除，改调 core 的**单一实现**（见 resolveUiRootInfo 的注释）。
  const revealHandler = async (req, res) => {
    if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
    if ((req.method ?? "GET") !== "POST") return writeJson(res, 405, { error: "method not allowed" });
    // v6.2.1：同 /state POST——readRequestBody 吞流异常，body 为 undefined 时下面按 unknown target 回 400
    const body = await readRequestBody(req);
    if (isBodyTooLarge(body)) return writeJson(res, 413, { error: "request body too large (limit 1MB)" });
    const target = body?.target;
    const allowedTargets = ["data-dir", "plots-dir", "settings-dir", "summaries-dir", "lexicon-dir", "packs-dir", "analysis-dir", "audits-dir", "embedding-dir", "state-file"];
    if (!allowedTargets.includes(target)) return writeJson(res, 400, { error: 'unknown target (allowed: ' + allowedTargets.join(", ") + ')' });
    const state = await readSentenceState();
    // v3.9.0：与 GET /state 同一回退（config.root → lastRoot → cwd），全新环境不再 404
    const root = resolveUiRoot(config, state);
    // v6.2.1 修正（旧清单 #8，死代码 / 注释不符）：删除恒不可达的 404 分支——resolveUiRoot 三条路径
    // （config.root 已判空、lastRoot 已判长、兜底 process.cwd()）保证返回非空字符串，这里 `root.length === 0`
    // 永远为假，那句"书库根未知：先在对话中调用一次 novel_plot…"其实从未返回过。要做成真实状态需先让
    // resolveUiRoot 允许返回空串，属跨模块口径（配置读取方在 index.js），故按注释修正而非改语义。
    const dataDir = novelDataDir(root);
    const targetDir = {
      "data-dir": dataDir,
      "plots-dir": join(dataDir, "plots"),
      "settings-dir": join(dataDir, "settings"),
      "summaries-dir": join(dataDir, "summaries"),
      "lexicon-dir": join(dataDir, "lexicon"),
      "packs-dir": join(dataDir, "packs"),
      "analysis-dir": join(dataDir, "analysis"),
      "audits-dir": join(dataDir, "audits"),
      "embedding-dir": join(dataDir, "embedding"),
      "state-file": stateFilePath()
    }[target];
    const dir = target === "state-file" ? dirname(targetDir) : targetDir;
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      // v6.6.0：创建失败（权限/路径被占）→ 随后打开的往往是不存在的目录，
      // 而对外的唯一说法是"未能调用系统文件管理器"，真因彻底丢失。
      logEvent("panel", { path: dir, level: "warn", detail: "打开目录前创建目录失败（随后的打开多半也会失败）" });
    }
    try {
      const opened = await openInExplorer(dir);
      if (!opened) return writeJson(res, 500, { ok: false, error: "未能调用系统文件管理器（explorer / open / xdg-open 都没能启动）；可手动打开：" + dir });
      return writeJson(res, 200, { ok: true, path: dir });
    } catch (error) {
      return writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  // v3.2.0：报告历史——列出 .novel-writer/analysis 与 style-reports 的已存报告，?read= 读取内容
  // v6.8.0：新增 POST { action:"forget", file } —— 单份报告移入回收站（可恢复，不直接删）。
  // 为什么走回收站而不是 rm：`style-reports/<书>.json` 里可能存着 AI 回传并保存的风格判断，
  // 那不是可再生的缓存，删掉就真没了；而 analysis/ 的缓存虽然可再生，重算一份大书也要时间。
  const reportsHandler = async (req, res) => {
    if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
    try {
      const state = await readSentenceState();
      const root = resolveUiRoot(config, state);
      const dataDir = typeof root === "string" && root.length > 0 ? novelDataDir(root) : "";
      const method = req.method ?? "GET";
      if (method === "POST") {
        const body = await readRequestBody(req);
        if (isBodyTooLarge(body)) return writeJson(res, 413, { error: "request body too large (limit 1MB)" });
        if (body === void 0 || body === null || typeof body !== "object" || Array.isArray(body)) return writeJson(res, 400, { error: "invalid JSON body" });
        if (body.action !== "forget") return writeJson(res, 400, { error: "unknown action: " + String(body.action) });
        // 只接受单段文件名：路径分隔符/`..` 一律拒绝（与 ?read= 的白名单同一口径，且更严格）
        const file = String(body.file ?? "").trim();
        if (file === "" || /[\\/]/.test(file) || file.includes("..") || !file.endsWith(".json")) {
          return writeJson(res, 400, { error: "invalid file: 只接受 .novel-writer/{analysis,style-reports} 下的单段 .json 文件名" });
        }
        const candidates = [join(dataDir, "analysis", file), join(dataDir, "style-reports", file)];
        const found = candidates.find(function (c) { return existsSync(c); });
        if (!found) return writeJson(res, 404, { error: "报告不存在" });
        const kind = found === candidates[0] ? "句式分析" : "风格判断";
        const moved = await movePathsToTrash({ root, dataDir, paths: [found], label: "（报告历史）", safeLabel: "report" });
        logEvent("config", {
          action: "report_forget", file, path: moved.trashDir, files: moved.files, bytes: moved.bytes,
          failures: moved.failed.length, level: moved.failed.length > 0 ? "warn" : "info",
          detail: "单份报告移入回收站：" + kind
        });
        if (moved.trashId === "") {
          return writeJson(res, 500, { ok: false, error: "未能移入回收站（文件可能被占用或没有权限）", failed: moved.failed });
        }
        return writeJson(res, 200, { ok: true, action: "forget", file, kind, trashId: moved.trashId, trashDir: moved.trashDir, files: moved.files, bytes: moved.bytes });
      }
      if (method !== "GET") return writeJson(res, 405, { error: "method not allowed: " + method });
      const qs = String(req.url || "").split("?")[1] || "";
      const params = new URLSearchParams(qs);
      const read = params.get("read");
      if (read) {
        const safe = String(read).replace(/[\\/]/g, "");
        const candidates = [join(dataDir, "analysis", safe), join(dataDir, "style-reports", safe)];
        const found = candidates.find(function (c) { return existsSync(c) && c.endsWith(".json"); });
        if (!found) return writeJson(res, 404, { error: "报告不存在" });
        const content = JSON.parse(await readFile(found, "utf8"));
        return writeJson(res, 200, { ok: true, file: safe, content });
      }
      const groups = [];
      const scanDir = async (dir, name, labelFn) => {
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          const files = [];
          for (const e of entries) {
            if (!e.isFile() || !e.name.endsWith(".json")) continue;
            const st = await stat(join(dir, e.name));
            files.push({ file: e.name, label: labelFn(e.name), time: st.mtime.toISOString() });
          }
          files.sort(function (a, b) { return b.time.localeCompare(a.time); });
          groups.push({ name, files });
        } catch { /* 目录不存在 */ }
      };
      await scanDir(join(dataDir, "analysis"), "句式分析", function (n) { return n.replace(/\.json$/, ""); });
      await scanDir(join(dataDir, "style-reports"), "风格判断", function (n) { return n.replace(/\.json$/, ""); });
      return writeJson(res, 200, { ok: true, groups });
    } catch (e) {
      return writeJson(res, 500, { ok: false, error: String(e).slice(0, 200) });
    }
  };
  // v2.6.5：更新检查路由（GitHub Releases API + 24h 缓存 + 3s 超时，全程静默）
  const updateCheckHandler = async (req, res) => {
    if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
    // v3.5.0 L3：仅 GET（POST 也会触发 GitHub 请求）
    if ((req.method ?? "GET") !== "GET") return writeJson(res, 405, { error: "method not allowed" });
    // v4.0.0 修正：与 styleConfigPath() 同一 DSH_HOME 口径（旧版写死 ~/.dsh，自定义 DSH_HOME 下缓存落到别处）
    const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME.trim() : join(homedir(), ".dsh");
    const result = await checkForUpdate(PLUGIN_VERSION, join(dshHome, "dsh-novel-writer"));
    // v4.3.0：checkForUpdate 的稳定形状（ok/stale/lastSuccess/checkedAt）原样透传——本路由是普通 JSON 路由，
    // 无 schema 约束，客户端据此区分"已是最新"与"检查失败"；不在这里补默认值，保持单一事实来源
    return writeJson(res, 200, result);
  };
  return [
    { kind: "exact", path: routePath, handler },
    { kind: "exact", path: revealPath, handler: revealHandler },
    { kind: "exact", path: "/api/dsh-novel-writer/update-check", handler: updateCheckHandler },
    { kind: "exact", path: "/api/dsh-novel-writer/demo", handler: demoHandler },
    { kind: "exact", path: "/api/dsh-novel-writer/reports", handler: reportsHandler },
    { kind: "exact", path: "/api/dsh-novel-writer/lexicon", handler: lexiconHandler },
    // v6.5.5：风格基线的范围（按全书 / 按部分）——按书存，故与词表同族
    { kind: "exact", path: "/api/dsh-novel-writer/baseline", handler: baselineHandler }
  ];
}
