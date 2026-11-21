/**
 * dsh-novel-writer — lib/tools/system.js（开关配置、诊断报告、UI HTTP 路由与技能提供者）
 */

import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { METRIC_CALIBER } from "../analysis.js";
import { PROMPT_SCENES } from "../prompts.js";
import { buildAuditBrief, runAuditContracts, verifyAuditClaims } from "../audit.js";
import * as embedding from "../embedding.js";
import { clearLogs, logEvent } from "../log.js";
import { buildDiagnosis, formatDiagnosis } from "../diagnose.js";
import { inspectCaliberCache, rebuildCaliberCache } from "../db.js";
import { SLOP_CATEGORIES } from "../lexicons/slop.js";
import { ALL_TOOLS, applyBookCreationProfilesPatch, assertToolEnabled, bookDir, CACHE_VERSION, CHAT_PROMPT_THRESHOLD_CHARS, clampStyleTolerance, cleanOutput, clearAllBookCreationProfiles, deleteCustomPack, DRAFT_FILE_SUFFIX, draftBookDir, effectiveSentenceAnalysis, FEATURE_DEFAULTS, featureEnabled, findChapter, getRawPack, isAbort, isAllowedRequest, isBodyTooLarge, isValidPackId, listBookCreationProfiles, listBookNames, listPacks, loadPack, makeStateRoutes, normalizeCreationProfile, novelDataDir, packsDir, parseDraftSegments, parsePackInput, readRequestBody, readSentenceState, readSettings, readStyleEnabled, readTextFile, resolveDraftTarget, resolvePackForBook, resolveRoot, resolveUiRootInfo, sanitizeSegment, saveCustomPack, scanChapters, semanticFeatureEnabled, settingsFile, stateFilePath, syncCreationProfileFiles, TOOL_LABELS, toolEnabled, toSerializablePack, withFileTx, writeJson, writeSentenceState, writeSettings } from "../core.js";
import { deleteBookDispatch } from "./library.js";

// ---- v4.3.0：把包内 skills/novel-writing 真正注册给宿主（P1-5）----
// 旧版把 SKILL.md 放在包里却没有任何机制加载它：① 文件没有 YAML frontmatter，dsh-skill-filesystem
// 会直接忽略（"missing YAML frontmatter"）；② 包内 skills/ 不在宿主枚举的任何技能根下；③ 插件既没注册
// provider 也没在 cordis.patch.yml 里挂 root。于是默认「精简」档提示词里那句"详细规范见 novel-writing
// 技能"指向一个查不到的技能。现按官方 dsh-skill-badge 的做法自注册 provider：
// 不写用户目录、不依赖用户改配置，宿主没有 skills 服务时静默跳过（可选注入）。
const SKILL_NAME = "novel-writing";
const SKILL_DESCRIPTION = "中文网文写作助手（dsh-novel-writer）：章节读写、开写包取材料、六维风格基线与自检、改稿台、伏笔/设定/必用词表与本地语义检索。用户处理中文小说续写、改稿、文风分析或设定管理时使用。";
const SKILL_WHEN_TO_USE = "用户提到小说、网文、章节、续写、改稿、文风、句式分析、伏笔、设定表、人物卡、大纲、必用词表或用词审计时";
const SKILL_BODY_URL = new URL("../../skills/novel-writing/SKILL.md", import.meta.url);
const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true };
const SKILL_RESOURCE_BASE = { kind: "directory", path: fileURLToPath(new URL("../../skills/novel-writing/", import.meta.url)) };
/** 去掉 YAML frontmatter，只把正文交给宿主（name/description 走候选字段，避免正文里再出现一份）。 */
function stripSkillFrontmatter(markdown) {
  const text = String(markdown);
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  return end === -1 ? text : text.slice(end + 4).replace(/^\s*\n/, "");
}
const skillProvider = {
  name: "novel-writer",
  list: () => Promise.resolve([{
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    invocation: SKILL_INVOCATION,
    source: "custom",
    provider: "novel-writer",
    rank: 600, // 与宿主 BUNDLED_SKILL_RANK 同档；名字唯一，rank 仅在重名时参与裁决
    resourceBase: SKILL_RESOURCE_BASE,
    locator: SKILL_BODY_URL
  }]),
  async get() {
    return {
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      whenToUse: SKILL_WHEN_TO_USE,
      invocation: SKILL_INVOCATION,
      source: "custom",
      provider: "novel-writer",
      resourceBase: SKILL_RESOURCE_BASE,
      content: stripSkillFrontmatter(await readFile(SKILL_BODY_URL, "utf8"))
    };
  }
};

/**
 * 组装插件侧栏 UI 所需的全部 13 条精确 HTTP 路由（供宿主 webServer 注册与测试直连复测）。
 * @param {object} [config]
 * @returns {Array<{ kind: "exact", path: string, handler: Function }>}
 */
export function buildUiRoutes(config) {
  const routes = makeStateRoutes(config?.allowLanState === true, config);
  // v7.3.3：`#7`（POST /state 的根解析）与 `#6`（lexicon save 忽略显式 enabled）都已回归 core 内单点修复，
  // 旧版在这里的 installStatePostRootFix / installLexiconSaveEnabledFix 两层路由包装已删除——
  // 包装会让同一段语义存在两份实现，core 一变就漂移。
  // v6.6.0：诊断路由（面板"看诊断 / 导出诊断包"用）。
  // 为什么加在这里而不是 core.makeStateRoutes：core.js 不能被 diagnose.js 反向依赖
  //（diagnose 依赖 core，core 再依赖 diagnose 就成循环导入，ESM 下 const 导出的 TDZ 风险高）。
  // 放在 index.js 最自然——它本来就同时导入 core 与 diagnose。
  // **与 novel_diagnose 工具同一实现**（buildDiagnosis + formatDiagnosis），口径不会分叉。
  routes.push({
    kind: "exact",
    path: "/api/dsh-novel-writer/diagnose",
    handler: async (req, res) => {
      if (!isAllowedRequest(req, config?.allowLanState === true)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if ((req.method ?? "GET") !== "GET") return writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "GET") });
      try {
        const params = new URLSearchParams(String(req.url || "").split("?")[1] || "");
        const days = Number(params.get("days"));
        const book = String(params.get("book") ?? "").trim();
        const value = await buildDiagnosis(config, {
          days: Number.isFinite(days) && days > 0 ? days : 7,
          book: book === "" ? void 0 : book,
          action: params.get("events") === "1" ? "events" : "report"
        }, null);
        value.report = formatDiagnosis(value);
        return writeJson(res, 200, { ok: true, ...value });
      } catch (err) {
        return writeJson(res, 500, { ok: false, error: "diagnose failed: " + String(err).slice(0, 160) });
      }
    }
  });
  // v6.8.0：按书删除路由（面板「删除整本书」与「回收站」用）。与工具**同一实现**（deleteBookDispatch），
  // 否则面板删一套、AI 删一套，两边对"什么算这本书的文件"迟早会分叉。
  routes.push({
    kind: "exact",
    path: "/api/dsh-novel-writer/delete-book",
    handler: async (req, res) => {
      // v7.3.3 修（漏报②）：删书入口固定按「仅回环」判定，**不跟随 allowLanState**。
      // 理由：allowLanState 是给"看状态/阅读/分析"这类只读面板用的；删书/恢复/彻底销毁一旦暴露到局域网，
      // 任何同网段设备都能借面板接口删掉整本书（甚至 purge 不可恢复）。文档也明写该入口"仅支持回环"。
      if (!isAllowedRequest(req, false)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "POST") return writeJson(res, 405, { error: "method not allowed: " + method });
      try {
        // 与面板其余接口同一个根解析口径（config.root → lastRoot → …），不另起一套
        const root = resolveUiRootInfo(config, await readSentenceState()).root;
        let query = {};
        if (method === "GET") {
          const params = new URLSearchParams(String(req.url || "").split("?")[1] || "");
          const action = (params.get("action") ?? "preview").trim();
          // v7.3.3 修（#8）：GET 只允许只读动作（list / preview）。旧版把 query 里的 action 原样透传，
          // `GET ?action=apply&book=X` 会真的删书、`?action=purge` 会彻底销毁回收站条目——
          // 既违背 HTTP GET 的只读/幂等语义，也会被浏览器预取、链接预览、误点直接触发。
          // 破坏性动作（apply / restore / purge）一律走 POST（文档与 client.js 的既有契约）。
          if (action !== "list" && action !== "preview") {
            return writeJson(res, 400, { error: "GET 只支持只读动作 list / preview；写盘动作（apply / restore / purge）必须用 POST（破坏性动作一律走 POST）" });
          }
          query = { action, book: params.get("book") ?? "", trashId: params.get("trashId") ?? "" };
        } else {
          const body = await readRequestBody(req);
          if (isBodyTooLarge(body)) return writeJson(res, 413, { error: "request body too large (limit 1MB)" });
          if (body === void 0 || body === null || typeof body !== "object" || Array.isArray(body)) return writeJson(res, 400, { error: "invalid JSON body" });
          // v6.8.0：keys 透传（面板的"只清理勾选的几处"走这里）；非数组时交给下游 selectTargets 报错
          query = { action: body.action ?? "preview", book: body.book ?? "", trashId: body.trashId ?? "", keys: body.keys };
        }
        const value = await deleteBookDispatch(root, query);
        return writeJson(res, 200, { ok: true, ...value });
      } catch (err) {
        // 参数/业务错误 400、写盘失败 500（与 POST /state 同口径）
        const status = err?.code === "ENOVELWRITEFAIL" ? 500 : 400;
        return writeJson(res, status, { ok: false, error: String(err?.message ?? err).slice(0, 240) });
      }
    }
  });
  // v7.0.0：度量口径探测 / 旧口径缓存重建（面板「度量口径」区用）。
  // 只处理派生缓存 analysis/*-chapters-metrics.json——删了下次测量即按新口径重建；
  // v7.0.0 修正（审查实测 P0）：旧版只扫 `*-chapters-metrics.json`——那是**六维逐章缓存**，
// 而 v7.0.0 改的是 `densityOf`（细节密度），旧口径数值实际躺在 `*-full.json`（全书分析）
// 与语义缓存里。只清六维等于"打错靶子"：面板显示"已重建"，报告里的旧密度还在。
  // 现在的口径：扫 analysis/ 下所有 `.json`，**跳过嵌入/语义索引**（带 model/dim/items 的那些，
  // 删了要重算几分钟），其余凡带 `ver` 字段的都按旧口径判定；损坏/读不动的一律算旧口径（重建正好清掉）。
  const DERIVED_CACHE_RE = /-chapters-metrics\.json$|-full\.json$|-density\.json$|-[0-9a-f]{16,20}\.json$/;
  function safeInspectCaliberCache(root) {
    if (typeof root !== "string" || root.trim() === "") {
      return {
        exists: false,
        expectedCaliber: METRIC_CALIBER,
        chapterMetrics: { total: 0, byCaliber: {} },
        analysisCache: { total: 0, byCaliber: {} },
        calibers: [],
        total: 0,
        stale: 0
      };
    }
    return inspectCaliberCache(root, METRIC_CALIBER);
  }
  routes.push({
    kind: "exact",
    path: "/api/dsh-novel-writer/metric-caliber",
    handler: async (req, res) => {
      if (!isAllowedRequest(req, config?.allowLanState === true)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "POST") return writeJson(res, 405, { error: "method not allowed: " + method });
      try {
        const root = resolveUiRootInfo(config, await readSentenceState()).root;
        const dir = join(novelDataDir(root), "analysis");
        let names = [];
        try {
          names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
        } catch {
          names = []; // 目录不存在 = 还没测过任何书，按 0 处理（不是错误）
        }
        const files = [];
        for (const name of names) {
          let obj = null;
          try {
            obj = JSON.parse(await readFile(join(dir, name), "utf8"));
          } catch {
            obj = null; // 读不动/损坏
          }
          // 嵌入索引/语义缓存：带 model/dim/items 的一律不碰（重建代价按分钟计，且与密度口径无关）
          if (obj && (obj.model !== void 0 || obj.dim !== void 0 || obj.items !== void 0)) continue;
          const ver = obj && typeof obj.ver === "string" ? obj.ver : "";
          // 既不是已知的派生缓存名、又没有 ver 字段 → 不认识的文件，不动
          if (ver === "" && !DERIVED_CACHE_RE.test(name)) continue;
          files.push({ name, ver, stale: ver !== CACHE_VERSION });
        }
        const staleFiles = files.filter((f) => f.stale);
        const sqliteSummary = safeInspectCaliberCache(root);
        const total = files.length + sqliteSummary.total;
        const staleCount = staleFiles.length + sqliteSummary.stale;
        if (method === "GET") {
          return writeJson(res, 200, {
            ok: true,
            caliber: METRIC_CALIBER,
            version: CACHE_VERSION,
            total,
            stale: staleCount,
            legacy: { total: files.length, stale: staleFiles.length },
            sqlite: sqliteSummary
          });
        }
        const body = await readRequestBody(req);
        if (isBodyTooLarge(body)) return writeJson(res, 413, { error: "request body too large (limit 1MB)" });
        const action = body && typeof body.action === "string" ? body.action : "";
        if (action !== "rebuild") return writeJson(res, 400, { error: "unknown action: " + action });
        let legacyDeleted = 0;
        const failed = [];
        for (const f of staleFiles) {
          try {
            await rm(join(dir, f.name), { force: true });
            legacyDeleted += 1;
          } catch {
            failed.push(f.name);
          }
        }
        let sqliteDeleted = 0;
        let sqliteStaleAfter = sqliteSummary.stale;
        if (sqliteSummary.stale > 0) {
          try {
            const rebuilt = rebuildCaliberCache(root, METRIC_CALIBER);
            sqliteDeleted = Number(rebuilt?.deleted ?? 0);
            sqliteStaleAfter = Math.max(0, sqliteSummary.stale - sqliteDeleted);
          } catch {
            failed.push("cache.sqlite");
          }
        }
        const deleted = legacyDeleted + sqliteDeleted;
        const legacyStaleAfter = Math.max(0, staleFiles.length - legacyDeleted);
        return writeJson(res, 200, {
          ok: true,
          deleted,
          failed,
          caliber: METRIC_CALIBER,
          version: CACHE_VERSION,
          total,
          // v7.1.0 修正（审查 #8）：旧公式 `files.length - deleted - failed.length` 把**新缓存**也算进去了
          // （10 个文件、删 2 个旧口径 → 报 8 个"仍过期"，GET 分支却报 0，前后自相矛盾）。
          // 重建后剩余过期数 = 原过期数 − 已删数；删失败的那些还在盘上，所以不额外减。
          stale: legacyStaleAfter + sqliteStaleAfter,
          legacy: { total: files.length, deleted: legacyDeleted, stale: legacyStaleAfter },
          sqlite: { ...sqliteSummary, deleted: sqliteDeleted, stale: sqliteStaleAfter }
        });
      } catch (err) {
        return writeJson(res, 500, { ok: false, error: "metric caliber failed: " + String(err?.message ?? err).slice(0, 160) });
      }
    }
  });
  // v7.2.0：对抗性审计（面板「诊断报告」页的独立入口）。
  // 方案 A：**不新增工具**——这里只是把已有实现（lib/audit.js 的 runAuditContracts /
  // buildAuditBrief / verifyAuditClaims，与 novel_fix_plan 的 audit / audit_brief / audit_verify
  // 是同一份实现）暴露成面板路由。之所以要这条路由：面板里"哪一步花 token"必须一眼可见，
  // 而工具调用天然不透明。三种 POST 全是**纯本地计算**（0 token）：
  //   audit  = 严格对账（契约逐条跑）
  //   brief  = 生成给另一个 AI 的任务书（生成本身不花 token）
  //   verify = 复核那个 AI 交回的 claims（编造的行号/原文直接判废）
  // 只有"把任务书交给另一个 agent 执行"才会另开会话、产生一次会话费用——那一步在面板之外。
  // **本路由只读**：不落盘报告、不改待办清单、不写任何文件。
  const AUDIT_CONTRACTS = Object.freeze(["lexicon", "banned", "slop", "loop", "outline", "ending", "bare_dialogue", "plot"]);
  routes.push({
    kind: "exact",
    path: "/api/dsh-novel-writer/audit",
    handler: async (req, res) => {
      if (!isAllowedRequest(req, config?.allowLanState === true)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "POST") return writeJson(res, 405, { error: "method not allowed: " + method });
      // GET = 探测 + **作品清单**（面板的书名下拉用它）。
      // v7.2.0：原先只返回契约清单，面板只能让人手打书名——打错就是一句 400，
      // 用户看到的"报错"其实多半是书名不精确。这里顺手把 novels/ 下的作品名列出来（只读目录，不读正文）。
      if (method === "GET") {
        let books = [];
        try {
          const root = resolveUiRootInfo(config, await readSentenceState()).root;
          const dir = join(root, "novels");
          const names = await readdir(dir, { withFileTypes: true });
          books = names.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "创作资料")
            .map((e) => e.name).sort((a, b) => a.localeCompare(b, "zh"));
        } catch {
          books = []; // 书库还没建/读不到：给空列表，面板会提示"先建书"
        }
        return writeJson(res, 200, { ok: true, tool: "audit", contracts: AUDIT_CONTRACTS.slice(), books, tokenFree: true });
      }
      try {
        const body = await readRequestBody(req);
        if (isBodyTooLarge(body)) return writeJson(res, 413, { error: "request body too large (limit 1MB)" });
        if (body === void 0 || body === null || typeof body !== "object" || Array.isArray(body)) return writeJson(res, 400, { error: "invalid JSON body" });
        const action = typeof body.action === "string" ? body.action : "";
        const rawBook = typeof body.book === "string" ? body.book.trim() : "";
        if (rawBook === "") return writeJson(res, 400, { error: "缺少书名（book）：请先在面板里填写书名，或用 novel_books 查看全部作品名" });
        let book;
        try {
          book = sanitizeSegment(rawBook, "book");
        } catch (e) {
          if (isAbort(e)) throw e;
          return writeJson(res, 400, { error: "书名无效：清洗后没有可用字符（收到：" + rawBook.slice(0, 40) + "）" });
        }
        const chapterArg = typeof body.chapter === "string" ? body.chapter.trim() : "";
        // 先判 action：未知动作不该碰磁盘（否则"请求写错"会被报成"章节读不到"）
        if (action !== "audit" && action !== "brief" && action !== "verify") {
          return writeJson(res, 400, { error: "unknown action: " + (action === "" ? "(missing)" : action) });
        }
        const root = resolveUiRootInfo(config, await readSentenceState()).root;
        // ── 章节解析：找不到目录/找不到章节 → 400 + 人话（500 只留给"找到了却跑失败"）──
        const dir = bookDir(root, book);
        let chapters;
        try {
          chapters = await scanChapters(dir);
        } catch (e) {
          if (isAbort(e)) throw e;
          return writeJson(res, 400, { error: String(e?.message ?? e).slice(0, 240) });
        }
        if (chapters.length === 0) return writeJson(res, 400, { error: "《" + book + "》还没有章节文件（可用 novel_chapters 确认书名与章号）" });
        let target;
        try {
          // 章节留空 = 最后一章：面板不填章节时的默认，也是"看最新一章"最短路径（与前端提示同口径）。
          target = chapterArg === "" ? chapters[chapters.length - 1] : findChapter(chapters, chapterArg);
        } catch (e) {
          if (isAbort(e)) throw e;
          return writeJson(res, 400, { error: String(e?.message ?? e).slice(0, 240) });
        }
        if (!target) return writeJson(res, 400, { error: "找不到章节：" + chapterArg + "（可用 novel_chapters 查看清单）" });
        const chapter = { file: target.file, number: target.number, title: target.title };
        const chapterText = await readTextFile(join(dir, target.file));
        if (action === "audit") {
          // 语义增强开关与工具同口径（语义引擎关掉时 loop/outline 如实报 "未跑"，而不是硬跑本地推理）
          const auditState = await readSentenceState();
          const report = await runAuditContracts({
            root,
            book,
            chapterFile: target.file,
            text: chapterText,
            exec: void 0,
            options: { semanticEnabled: semanticFeatureEnabled(auditState) }
          });
          return writeJson(res, 200, { ok: true, action: "audit", chapter, report });
        }
        if (action === "brief") {
          const built = buildAuditBrief({ book, file: target.file, chapterNumber: target.number, chapterText });
          return writeJson(res, 200, {
            ok: true,
            action: "brief",
            chapter,
            brief: built.brief,
            allowedContracts: built.allowedContracts,
            protocol: built.protocol
          });
        }
        if (action === "verify") {
          if (!Array.isArray(body.claims)) return writeJson(res, 400, { error: "claims 必须是数组：[{contract,line,text,why}]" });
          const verify = verifyAuditClaims({ claims: body.claims, text: chapterText });
          return writeJson(res, 200, { ok: true, action: "verify", chapter, verify });
        }
        // v7.3.1 修（#22）：以下兜底**当前不可达**（上面已把 action 白名单化）——防御性保留，不删：
        // 将来给 action 加白名单却漏了分支时，这里会明确回 400，而不是让请求静默落进「成功但什么都没做」。
        return writeJson(res, 400, { error: "unknown action: " + action });
      } catch (err) {
        // 取消不是"跑失败"：与全插件同一判据，原样上抛，不伪装成 500。
        if (isAbort(err)) throw err;
        return writeJson(res, 500, { ok: false, error: "audit failed: " + String(err?.message ?? err).slice(0, 240) });
      }
    }
  });
  // v7.3.0：草稿镜像的**只读预览**（GET /draft?book=&chapter=）。
  // 为什么需要它：草稿镜像写到 .novel-writer/drafts/<书>/ 里，但面板此前**没有任何入口**能看，
  // 用户只能自己去文件管理器找——那等于把"实时看到他在写什么"这一半漏掉了。
  // 只读：不写、不改、不清理；AI 也拿不到它（这不是工具，只是面板的数据源）。
  routes.push({
    kind: "exact",
    path: "/api/dsh-novel-writer/draft",
    handler: async (req, res) => {
      if (!isAllowedRequest(req, config?.allowLanState === true)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
      try {
        const q = new URL(req.url ?? "", "http://127.0.0.1");
        const rawBook = (q.searchParams.get("book") ?? "").trim();
        if (rawBook === "") return writeJson(res, 400, { error: "缺少 book 参数" });
        let book2;
        try {
          book2 = sanitizeSegment(rawBook, "book");
        } catch (e) {
          if (isAbort(e)) throw e;
          // v7.3.1 修（#20②）：非法书名是**客户端输入错误**，对齐 audit 路由（:613-618）的 400 口径——
          // sanitizeSegment 抛错落到外层 catch 会报成 500，用户会以为插件坏了。
          return writeJson(res, 400, { error: "书名无效：清洗后没有可用字符（收到：" + rawBook.slice(0, 40) + "）" });
        }
        const root2 = resolveUiRootInfo(config, await readSentenceState()).root;
        const chapterArg = (q.searchParams.get("chapter") ?? "").trim();
        // 章节留空 = 列出该书**所有**镜像（面板要做"最近在写哪几章"的清单）
        if (chapterArg === "") {
          const dir = draftBookDir(root2, book2);
          let names = [];
          try {
            names = (await readdir(dir)).filter((n) => n.endsWith(DRAFT_FILE_SUFFIX)).sort();
          } catch (e) {
            // v7.3.2 修（N22①）：列镜像目录的失败不能一律吞成空列表。「这本书还没有镜像」是 ENOENT
            //（正常状态，面板显示"没有草稿"是对的）；权限/IO、以及同名文件挡路（ENOTDIR）都是**读不动**，
            // 吞掉就会把真故障讲成"没有草稿"，用户照着提示重写一遍。非 ENOENT 交给外层 catch → 500。
            if (isAbort(e)) throw e;
            if (e?.code !== "ENOENT") {
              throw new Error("列出草稿镜像目录失败（" + dir + "）：" + (e?.code ?? e?.message ?? e));
            }
          }
          const items = [];
          for (const name of names.slice(0, 50)) {
            const full = join(dir, name);
            let st = null;
            let statError = "";
            try { st = await stat(full); } catch (e) {
              if (isAbort(e)) throw e;
              // v7.3.2 修（N22②）：stat 失败时不得伪造 bytes:0 / mtime:0——那会让面板显示「0 字节草稿」，
              // 与"空文件"无法区分。按仓库既有约定「未知就省略该键」：拿到 stat 才给 bytes/mtime，
              // 拿不到就只给 statError（错误码），把"读不动"如实暴露出来。
              statError = e?.code ?? "EUNKNOWN";
            }
            const item = { file: name, chapterKey: name.slice(0, -DRAFT_FILE_SUFFIX.length) };
            if (st !== null) { item.bytes = st.size; item.mtime = st.mtimeMs; }
            else item.statError = statError;
            items.push(item);
          }
          return writeJson(res, 200, { ok: true, book: book2, mirrorDir: dir, items });
        }
        const target = resolveDraftTarget(root2, book2, chapterArg);
        // v7.3.1 修（#20①）：**读失败 ≠ 没有草稿**。ENOENT（这一章还没写过）是正常状态 → exists:false；
        // 权限/IO/编码失败必须如实报错（交给外层 catch → 500）。旧版 catch 一律 content=""，
        // 磁盘上明明有内容却只读到「无草稿」，用户会照着提示重写一遍。
        let content = "";
        let exists = false;
        try {
          content = await readFile(target.file, "utf8");
          exists = true;
        } catch (e) {
          if (isAbort(e)) throw e;
          if (e?.code !== "ENOENT") throw e;
        }
        const segments = parseDraftSegments(content).map((seg) => ({ index: seg.index, text: seg.text }));
        return writeJson(res, 200, {
          ok: true,
          book: book2,
          chapterKey: target.key,
          mirrorDir: target.dir,
          draftFile: target.file,
          exists,
          segments,
          totalChars: segments.reduce((acc, seg) => acc + String(seg.text).length, 0)
        });
      } catch (err) {
        if (isAbort(err)) throw err;
        return writeJson(res, 500, { ok: false, error: "draft preview failed: " + String(err?.message ?? err).slice(0, 240) });
      }
    }
  });
  // v7.5.0：题材规则包管理（GET 列包/查按书绑定；POST 仅回环，写 settings.worldview[].pack 绑定或解绑）。
  routes.push({
    kind: "exact",
    path: "/api/dsh-novel-writer/packs",
    handler: async (req, res) => {
      const method = req.method ?? "GET";
      if (method === "GET") {
        if (!isAllowedRequest(req, config?.allowLanState === true)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      } else if (method === "POST") {
        if (!isAllowedRequest(req, false)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      } else {
        if (!isAllowedRequest(req, config?.allowLanState === true)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
        return writeJson(res, 405, { error: "method not allowed: " + method });
      }

      const buildPacksPayload = async (safeBook) => {
        const root = resolveUiRootInfo(config, await readSentenceState()).root;
        const books = await listBookNames(root);
        const listed = listPacks(root);
        const rawPacks = {};
        for (const p of listed.packs) {
          const raw = getRawPack(p.id, root) || p;
          rawPacks[p.id] = toSerializablePack(raw);
        }
        let boundPackId = "";
        let activePack = null;
        if (safeBook !== "") {
          const settings = await readSettings(root, safeBook);
          const worldview = Array.isArray(settings?.worldview) ? settings.worldview : [];
          for (let i = worldview.length - 1; i >= 0; i -= 1) {
            const entry = worldview[i];
            if (entry && typeof entry === "object" && typeof entry.pack === "string" && entry.pack.trim() !== "") {
              boundPackId = entry.pack.trim();
              break;
            }
          }
          activePack = resolvePackForBook({ packId: boundPackId, book: safeBook, root });
        }
        return {
          ok: true,
          book: safeBook,
          books,
          packsDir: packsDir(root),
          packs: listed.packs,
          rawPacks,
          slopCategories: { ...SLOP_CATEGORIES },
          boundPackId,
          activePack,
          warnings: listed.warnings,
          errors: listed.errors
        };
      };

      const mergePackWarnings = (baseList, extraList) => {
        const out = [];
        const seen = new Set();
        for (const list of [baseList, extraList]) {
          if (!Array.isArray(list)) continue;
          for (const w of list) {
            if (w === null || w === void 0) continue;
            const key = typeof w === "object"
              ? `${String(w.id ?? "") !== "" ? "id:" + String(w.id) : "file:" + String(w.file ?? "")}\u0000${String(w.reason ?? "")}`
              : String(w);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(w);
          }
        }
        return out;
      };

      const bindBookToPack = async (root, safeBook, packVal) => {
        await withFileTx(settingsFile(root, safeBook), async () => {
          let data;
          try {
            data = await readSettings(root, safeBook, { strict: true });
          } catch (e) {
            if (isAbort(e)) throw e;
            if (e?.code === "ENOENT") {
              data = { characters: [], locations: [], items: [], timeline: [], worldview: [] };
            } else {
              const isParse = e instanceof SyntaxError || e?.name === "SyntaxError" || e?.code === "EPARSE";
              const wrapped = new Error(
                isParse
                  ? `《${safeBook}》设定表 JSON 已损坏，拒绝写入题材包绑定以防覆盖原有设定；请先修复 settings/${safeBook}.json`
                  : `《${safeBook}》设定表读取失败，拒绝写入题材包绑定：${String(e?.message ?? e).slice(0, 120)}`
              );
              wrapped.httpStatus = isParse ? 409 : 500;
              wrapped.code = isParse ? "SETTINGS_CORRUPT" : String(e?.code || "SETTINGS_READ_FAILED");
              throw wrapped;
            }
          }
          if (!Array.isArray(data.worldview)) data.worldview = [];
          if (packVal === "") {
            for (const entry of data.worldview) {
              if (entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "pack")) {
                delete entry.pack;
              }
            }
          } else {
            let targetEntry = null;
            for (let i = data.worldview.length - 1; i >= 0; i -= 1) {
              const entry = data.worldview[i];
              if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.pack === "string" && entry.pack.trim() !== "") {
                targetEntry = entry;
                break;
              }
            }
            if (!targetEntry) {
              for (let i = data.worldview.length - 1; i >= 0; i -= 1) {
                const entry = data.worldview[i];
                if (entry && typeof entry === "object" && !Array.isArray(entry)) {
                  targetEntry = entry;
                  break;
                }
              }
            }
            if (!targetEntry) {
              targetEntry = { name: "题材规则包" };
              data.worldview.push(targetEntry);
            }
            targetEntry.pack = packVal;
          }
          await writeSettings(root, safeBook, data);
        });
      };

      const sanitizeOptionalBook = (raw) => {
        const s = typeof raw === "string" ? raw.trim() : "";
        if (s === "") return "";
        return sanitizeSegment(s, "book");
      };

      if (method === "GET") {
        try {
          const params = new URLSearchParams(String(req.url || "").split("?")[1] || "");
          const rawBook = String(params.get("book") ?? "").trim();
          let safeBook = "";
          if (rawBook !== "") {
            try {
              safeBook = sanitizeSegment(rawBook, "book");
            } catch (e) {
              if (isAbort(e)) throw e;
              return writeJson(res, 400, { ok: false, error: "书名无效：清洗后没有可用字符（收到：" + rawBook.slice(0, 40) + "）" });
            }
          }
          return writeJson(res, 200, await buildPacksPayload(safeBook));
        } catch (err) {
          if (isAbort(err)) throw err;
          return writeJson(res, 500, { ok: false, error: "packs read failed: " + String(err?.message ?? err).slice(0, 160) });
        }
      }

      const body = await readRequestBody(req);
      if (isBodyTooLarge(body)) return writeJson(res, 413, { error: "request body too large (limit 1MB)" });
      if (body === void 0 || body === null || typeof body !== "object" || Array.isArray(body)) {
        return writeJson(res, 400, { error: "invalid JSON body" });
      }
      const action = typeof body.action === "string" ? body.action.trim() : "bind";
      const fileName = typeof body.fileName === "string" ? body.fileName.trim().slice(0, 80) : "";
      const stemId = fileName ? fileName.replace(/\.json$/i, "").trim() : "";
      const defaultId = isValidPackId(stemId) ? stemId : "";

      if (action === "preview") {
        try {
          const root = resolveUiRootInfo(config, await readSentenceState()).root;
          const input = body.text !== void 0 ? body.text : body.pack;
          const resPreview = parsePackInput(input, {
            root,
            defaultId,
            file: fileName || "import.json",
            idOverride: typeof body.idOverride === "string" ? body.idOverride : ""
          });
          if (!resPreview.ok) {
            return writeJson(res, 400, { ok: false, error: resPreview.error, warnings: resPreview.warnings || [] });
          }
          return writeJson(res, 200, { ok: true, preview: resPreview });
        } catch (err) {
          if (isAbort(err)) throw err;
          return writeJson(res, 500, { ok: false, error: "packs preview failed: " + String(err?.message ?? err).slice(0, 160) });
        }
      }

      if (action === "save") {
        let safeBook = "";
        try {
          safeBook = sanitizeOptionalBook(body.book);
        } catch (e) {
          if (isAbort(e)) throw e;
          const rawB = typeof body.book === "string" ? body.book.trim() : "";
          return writeJson(res, 400, { ok: false, error: "书名无效：清洗后没有可用字符（收到：" + rawB.slice(0, 40) + "）" });
        }
        try {
          const root = resolveUiRootInfo(config, await readSentenceState()).root;
          const input = body.text !== void 0 ? body.text : body.pack;
          const saved = await saveCustomPack(root, input, {
            overwrite: body.overwrite === true,
            idOverride: typeof body.idOverride === "string" ? body.idOverride : "",
            defaultId,
            file: fileName || "custom.json"
          });
          if (!saved.ok) {
            return writeJson(res, saved.status || 400, {
              ok: false,
              code: saved.code || "",
              existingId: saved.existingId || "",
              error: saved.error,
              warnings: saved.warnings || []
            });
          }
          let bound = false;
          if (body.bindAfterSave === true && safeBook !== "") {
            await bindBookToPack(root, safeBook, saved.id);
            logEvent("config", { action: "pack_bind", book: safeBook, detail: saved.id });
            bound = true;
          }
          const payload = await buildPacksPayload(safeBook);
          const saveWarnings = Array.isArray(saved.warnings) ? saved.warnings : [];
          const warnings = mergePackWarnings(payload.warnings, saveWarnings);
          return writeJson(res, 200, {
            ...payload,
            saved: saved.id,
            bound,
            warnings,
            saveWarnings,
            rejectedPatterns: saved.rejectedPatterns || []
          });
        } catch (err) {
          if (isAbort(err)) throw err;
          const status = Number.isInteger(err?.httpStatus) ? err.httpStatus : 500;
          return writeJson(res, status, {
            ok: false,
            ...(err?.code ? { code: err.code } : {}),
            error: status === 409
              ? String(err?.message ?? err).slice(0, 200)
              : "packs save failed: " + String(err?.message ?? err).slice(0, 160)
          });
        }
      }

      if (action === "delete") {
        let safeBook = "";
        try {
          safeBook = sanitizeOptionalBook(body.book);
        } catch (e) {
          if (isAbort(e)) throw e;
          const rawB = typeof body.book === "string" ? body.book.trim() : "";
          return writeJson(res, 400, { ok: false, error: "书名无效：清洗后没有可用字符（收到：" + rawB.slice(0, 40) + "）" });
        }
        try {
          const root = resolveUiRootInfo(config, await readSentenceState()).root;
          const delId = typeof body.id === "string" ? body.id.trim() : "";
          const del = await deleteCustomPack(root, delId);
          if (!del.ok) {
            return writeJson(res, del.status || 400, { ok: false, error: del.error });
          }
          const payload = await buildPacksPayload(safeBook);
          return writeJson(res, 200, { ...payload, deleted: del.deleted });
        } catch (err) {
          if (isAbort(err)) throw err;
          return writeJson(res, 500, { ok: false, error: "packs delete failed: " + String(err?.message ?? err).slice(0, 160) });
        }
      }

      if (action !== "bind") {
        return writeJson(res, 400, { ok: false, error: "unknown action: " + action.slice(0, 40) });
      }

      const rawBook = typeof body.book === "string" ? body.book.trim() : "";
      if (rawBook === "") return writeJson(res, 400, { ok: false, error: "book is required" });
      let safeBook;
      try {
        safeBook = sanitizeSegment(rawBook, "book");
      } catch (e) {
        if (isAbort(e)) throw e;
        return writeJson(res, 400, { ok: false, error: "书名无效：清洗后没有可用字符（收到：" + rawBook.slice(0, 40) + "）" });
      }
      if (body.pack !== void 0 && body.pack !== null && typeof body.pack !== "string") {
        return writeJson(res, 400, { ok: false, error: "pack must be a string or null" });
      }
      const packVal = typeof body.pack === "string" ? body.pack.trim() : "";
      if (packVal !== "" && !isValidPackId(packVal)) {
        return writeJson(res, 400, { ok: false, error: "invalid pack id: " + packVal.slice(0, 40) });
      }

      try {
        const root = resolveUiRootInfo(config, await readSentenceState()).root;
        await bindBookToPack(root, safeBook, packVal);
        const matched = packVal !== "" ? Boolean(loadPack(packVal, root)) : false;
        logEvent("config", { action: packVal ? "pack_bind" : "pack_unbind", book: safeBook, detail: packVal || "(unbound)" });
        const payload = await buildPacksPayload(safeBook);
        return writeJson(res, 200, { ...payload, updated: true, ...(packVal ? { matched } : {}) });
      } catch (err) {
        if (isAbort(err)) throw err;
        const status = Number.isInteger(err?.httpStatus) ? err.httpStatus : 500;
        return writeJson(res, status, {
          ok: false,
          ...(err?.code ? { code: err.code } : {}),
          error: status === 409
            ? String(err?.message ?? err).slice(0, 200)
            : "packs update failed: " + String(err?.message ?? err).slice(0, 160)
        });
      }
    }
  });
  return routes;
}

function registerStyleConfigRoute(ctx, config) {
  try {
    ctx.inject(["webServer"], (wctx) => {
      const registerRoute = wctx?.webServer?.register;
      if (typeof registerRoute !== "function") {
        logEvent("panel", { level: "warn", detail: "UI 路由注册跳过：webServer.register 不可用（面板接口不可用，工具不受影响）" });
        return;
      }
      const routes = buildUiRoutes(config);
      const mountRoutes = () => {
        const unsubs = [];
        try {
          for (const route of routes) {
            unsubs.push(registerRoute.call(wctx.webServer, route));
          }
        } catch (err) {
          for (let i = unsubs.length - 1; i >= 0; i -= 1) {
            const fn = unsubs[i];
            if (typeof fn === "function") {
              try { fn(); } catch { /* 回滚单个路由注销失败不掩盖原始错误 */ }
            }
          }
          throw err;
        }
        return () => {
          for (let i = unsubs.length - 1; i >= 0; i -= 1) {
            const fn = unsubs[i];
            if (typeof fn === "function") {
              try { fn(); } catch { /* 单个路由注销失败不影响其余路由清理 */ }
            }
          }
        };
      };
      if (typeof wctx.effect === "function") {
        wctx.effect(mountRoutes, "dsh-novel-writer: state routes");
      } else {
        mountRoutes();
      }
    });
  } catch {
    /* 非 cordis 环境：跳过路由，工具仍可用 */
    // v6.6.0：**只在真能注路由的环境里**才记——非 cordis（MCP/测试）下 ctx.inject 不存在，
    // 那是设计内的"本来就没有 UI 路由"，记了只会刷屏 ✗。反之则意味着面板整体不可用：
    // 不报错、不抛异常，只是所有面板接口凭空消失（与"面板还没打开"表现完全一样）。
    if (ctx && typeof ctx.inject === "function") {
      logEvent("panel", { level: "warn", detail: "UI 路由注册失败——本会话面板相关接口全部不可用（工具不受影响）" });
    }
  }
}

function registerNovelSentenceConfig(ctx, config) {
  ctx.tools.register({
    name: "novel_sentence_config",
    description: "读写插件与分析开关配置（get 查询 / set 修改）。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"], description: "操作" },
        enabled: { type: "boolean", description: "总开关" },
        autoAnalyze: { type: "boolean", description: "自动分析" },
        // v5.0.0：提示词"档位 × 场景"两个正交维度。档位决定注入多少，场景决定注入什么。
        systemPromptMode: { type: "string", enum: ["off", "brief", "full"], description: "提示档位" },
        promptScene: { type: "string", enum: [...PROMPT_SCENES], description: "full档场景" },
        // v5.1.0（降本）：精简工作流——打开后注入最简档，去掉自检/复测/登记的全部催促
        leanWorkflow: { type: "boolean", description: "精简工作流(省token)" },
        // v7.3.0：实时聊天写作的提问节奏（字数阈值）。超界夹到 100~5000。
        // v7.3.1 修（#26）：schema 只有 type:"number"，严格宿主会先拒掉 null（同文件其它参数已注明
        // 「宿主不支持 null 类型」）；故描述与实现都只承诺 0 = 清回默认，输出侧仍保持 integer。
        chatThreshold: { type: "number", description: "聊天提问字数阈值(100~5000，0=默认)" },
        tools: { type: "object", additionalProperties: true, description: "工具开关({novel_*:bool})" },
        features: { type: "object", additionalProperties: true, description: "功能开关(emotionCaveat/genreTheme/emotionComplexity/semanticEmbedding/semanticSearch/semanticStyle/semanticImplicit/rawWriting/webnovelVibe/lexiconFirst/chatWriting)；rawWriting仅明确要求时开。" },
        styleTolerance: { type: "object", additionalProperties: true, description: "容差；空对象 {} 表示清除" },
        creationProfile: { type: "object", additionalProperties: true, description: "原创设定(worldview/characters/forbidden/mainConflict/genre/extra)；空对象 {} 表示清除" },
        creationProfiles: { type: "object", additionalProperties: true, description: "按书原创设定；空对象 {} 表示清除" }
      },
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          enabled: { type: "boolean" },
          autoAnalyze: { type: "boolean" },
          // v5.0.0：提示词档位与场景（此前这对开关只在侧边栏可见，模型侧看不到自己的注入状态）
          systemPromptMode: { type: "string" },
          promptScene: { type: "string" },
          // v5.1.0（降本）：精简工作流（与 promptScene 同级；仅接受布尔值）
          leanWorkflow: { type: "boolean" },
          // v7.3.0：实时聊天写作的字数阈值（面板与开写包共用同一份配置）
          chatThreshold: { type: "integer" },
          source: { type: "string" },
          updated: { type: "boolean" },
          tools: { type: "object", additionalProperties: true, description: "各工具当前开关状态。" },
          features: { type: "object", additionalProperties: true, description: "各功能开关状态（11 个键全量：emotionCaveat / genreTheme / emotionComplexity / semanticEmbedding / semanticSearch / semanticStyle / semanticImplicit / rawWriting / webnovelVibe / lexiconFirst / chatWriting）。" },
          embedding: { type: "object", additionalProperties: true, description: "语义嵌入引擎状态（available/error）。" },
          styleTolerance: { type: "object", additionalProperties: true, description: "风格基线容差（用户自定义 ±%；未设置=空对象 {}，此时使用推荐）。" },
          creationProfile: { type: "object", additionalProperties: true, description: "原创模式设定（用户在侧边栏填写的创作意图；未设置=空对象 {}）。" },
          creationProfiles: { type: "object", additionalProperties: true, description: "按书专属原创设定（键=书名，值=设定对象；未设置=空对象 {}）。" }
        },
        required: ["file", "enabled", "autoAnalyze", "tools", "features", "embedding", "styleTolerance", "creationProfile"]
      },
      render: (_args, value) => {
        const toolLines = ALL_TOOLS.map((name) => `  - ${TOOL_LABELS[name] ?? name} (${name}): ${value.tools?.[name] === false ? "关闭" : "开启"}`);
        const featLines = Object.entries(value.features ?? {}).map(([name, on]) => `  - 功能 ${name}: ${on === false ? "关闭" : "开启"}`);
        return [{
          type: "text",
          text: `<path>${value.file}</path>
<type>novel-sentence-config</type>
<content>
写作助手功能: ${value.enabled ? "已启用" : "已关闭"}
自动分析(autoAnalyze): ${value.autoAnalyze ? "开" : "关"}
系统提示词: 档位=${value.systemPromptMode ?? "brief"} 场景=${value.promptScene ?? "general"}${(value.systemPromptMode ?? "brief") === "full" && (value.promptScene ?? "general") !== "general" ? "（按场景注入）" : ""}
精简工作流(leanWorkflow): ${value.leanWorkflow === true ? "开（优先于档位/场景，只按需调用工具）" : "关"}
来源: ${value.source}
${value.updated === true ? "(已保存到 state 文件)" : ""}

各工具开关：
${toolLines.join("\n")}

功能开关：
${featLines.join("\n")}
</content>`
        }];
      }
    },
    async execute(args) {
      await assertToolEnabled(config, "novel_sentence_config");
      const action = args?.action === "set" ? "set" : "get";
      const state = await readSentenceState();
      // v4.0.0 修正：删除未使用的 effective（下方 after 才是返回值来源）
      let updated = false;
      let current = state;
      let creationProfilesChanged = false;
      let effectiveRoot = resolveUiRootInfo(config, current).root;
      if (action === "set") {
        const patch = {};
        if (typeof args?.enabled === "boolean") patch.enabled = args.enabled;
        if (typeof args?.autoAnalyze === "boolean") patch.autoAnalyze = args.autoAnalyze;
        // v5.0.0：提示词档位与场景（非法值直接忽略；general 是显式合法值，用于改回通用档）
        if (["off", "brief", "full"].includes(args?.systemPromptMode)) patch.systemPromptMode = args.systemPromptMode;
        if (PROMPT_SCENES.includes(args?.promptScene)) patch.promptScene = args.promptScene;
        // v5.1.0（降本）：精简工作流（只接受布尔值；非布尔静默忽略，与 core.writeSentenceState 同口径）
        if (typeof args?.leanWorkflow === "boolean") patch.leanWorkflow = args.leanWorkflow;
        // v7.3.0：提问节奏（0 显式表示"清回默认"，所以这里不能用真值判断）
        // v7.3.1 修（#26）：删掉 null 分支——schema 只声明 number，严格宿主根本收不到 null；
        // 留着只会让「描述承诺 null、schema 拒绝 null」的契约冲突重新长出来。0 是唯一的清除写法。
        if (args?.chatThreshold === 0
          || (args?.chatThreshold !== void 0 && Number.isFinite(Number(args.chatThreshold)) && Number(args.chatThreshold) > 0)) {
          patch.chatThreshold = args.chatThreshold;
        }
        if (args?.tools !== void 0) {
          if (args.tools === null || typeof args.tools !== "object" || Array.isArray(args.tools)) {
            throw new Error("参数 \"tools\" 必须是键值对象（如 { novel_books: false }），不能是数组或非对象");
          }
          const toolsPatch = {};
          for (const name of ALL_TOOLS) {
            if (typeof args.tools[name] === "boolean") toolsPatch[name] = args.tools[name];
          }
          // v3.5.0 M13：novel_sentence_config 禁止被关（关了自己就无法再开——死锁）
          delete toolsPatch.novel_sentence_config;
          if (Object.keys(toolsPatch).length > 0) patch.tools = toolsPatch;
        }
        if (args?.features !== void 0) {
          if (args.features === null || typeof args.features !== "object" || Array.isArray(args.features)) {
            throw new Error("参数 \"features\" 必须是键值对象（如 { semanticEmbedding: false }），不能是数组或非对象");
          }
          const featPatch = {};
          for (const name of ["emotionCaveat", "genreTheme", "emotionComplexity", "semanticEmbedding", "semanticSearch", "semanticStyle", "semanticImplicit", "rawWriting", "webnovelVibe", "lexiconFirst", "chatWriting"]) {
            if (typeof args.features[name] === "boolean") featPatch[name] = args.features[name];
          }
          if (Object.keys(featPatch).length > 0) patch.features = featPatch;
        }
        // v3.0.0：风格基线容差（±%：允许低于/高于基线的百分比；null 清除恢复默认）
        if (args?.styleTolerance !== void 0) {
          if (args.styleTolerance === null) patch.styleTolerance = null;
          // v3.1.0：空对象 {} = 清除（DSH schema 不支持 type 数组/剥离 null，空 object 是合规的“传了但清空”）
          else if (args.styleTolerance !== null && typeof args.styleTolerance === "object" && !Array.isArray(args.styleTolerance) && Object.keys(args.styleTolerance).length === 0) patch.styleTolerance = null;
          else if (args.styleTolerance !== null && typeof args.styleTolerance === "object" && !Array.isArray(args.styleTolerance)) {
            const cleanedTol = clampStyleTolerance(args.styleTolerance); // v3.9.0：与 POST /state 共用同一钳制
            if (Object.keys(cleanedTol).length > 0) patch.styleTolerance = cleanedTol;
          }
        }
        // v3.1.0：原创模式设定（世界观/角色/禁忌/主线/题材/额外要求；null/空对象清除）
        if (args?.creationProfile !== void 0) {
          if (args.creationProfile === null) patch.creationProfile = null;
          else if (typeof args.creationProfile === "object" && !Array.isArray(args.creationProfile)) {
            patch.creationProfile = normalizeCreationProfile(args.creationProfile);
          }
        }
        // v3.1.0：按书专属设定（整体替换该书条目；空对象清除全部）——落盘到书库本地 settings/<book>.json
        const hasCreationProfilesArg = args?.creationProfiles !== void 0
          && (args.creationProfiles === null || (typeof args.creationProfiles === "object" && !Array.isArray(args.creationProfiles)));
        if (Object.keys(patch).length > 0) {
          await writeSentenceState(patch);
          // v4.3.0：写后重读 state——writeSentenceState 的返回值继承写前快照（首写时 exists:false），
          // 而 effectiveSentenceAnalysis 以 exists===true 为门，旧版首次 set 会返回与刚落盘状态相反的
          // enabled/source（盘上 enabled:false，返回值却是 config 的 true + "插件 config"）
          current = await readSentenceState();
          updated = true;
        }
        effectiveRoot = resolveUiRootInfo(config, current).root;
        if (hasCreationProfilesArg) {
          const isClearAll = args.creationProfiles === null || Object.keys(args.creationProfiles).length === 0;
          if (effectiveRoot) {
            if (isClearAll) await clearAllBookCreationProfiles(effectiveRoot);
            else await applyBookCreationProfilesPatch(effectiveRoot, args.creationProfiles);
          }
          current = await readSentenceState();
          updated = true;
          creationProfilesChanged = true;
        }
      }
      const after = effectiveSentenceAnalysis(config, current);
      const styleFileOn = readStyleEnabled();
      // v8.2.0（#164）：source 与 effectiveSentenceAnalysis(config, current) 保持严格同源
      const source = current?.exists === true
        ? "state 文件（GUI 开关）"
        : (styleFileOn ? "v0.4.0 兼容文件 novel-writer.json" : (config?.sentenceAnalysis?.enabled !== void 0 || config?.sentenceAnalysis?.stylePattern !== void 0 || config?.sentenceAnalysis?.autoAnalyze !== void 0 ? "插件 config" : "默认值"));
      const tools = {};
      for (const name of ALL_TOOLS) tools[name] = toolEnabled(current, name);
      const features = {};
      for (const name of Object.keys(FEATURE_DEFAULTS)) features[name] = featureEnabled(current, name);
      // v3.0.0：风格基线容差（±%）
      // v3.7.0：宿主不支持 null 类型——未设置输出空对象 {}（语义：使用推荐）
      const styleTolerance = current?.styleTolerance !== null && typeof current?.styleTolerance === "object" ? current.styleTolerance : {};
      // v3.1.0：原创模式设定
      const creationProfile = current?.creationProfile !== null && typeof current?.creationProfile === "object" ? current.creationProfile : {}; // v3.7.0：未设置输出空对象（宿主不支持 null）
      const creationProfiles = await listBookCreationProfiles(effectiveRoot, current);
      // v2.0.0：语义引擎状态（懒探测——不加载模型，仅文件检查 + 已加载状态）
      const embStatus = embedding.status();
      const embAvailable = featureEnabled(current, "semanticEmbedding") ? (embStatus.loaded || embStatus.modelPresent) : false;
      const embError = featureEnabled(current, "semanticEmbedding") ? embStatus.error ?? "" : "semanticEmbedding 已关闭";
      // v3.5.0 #20：工具侧清空/变更设定后同样同步创作资料 md（路由侧已有，此处补齐一致性）
      if (creationProfilesChanged && effectiveRoot) {
        const isClearAll = args.creationProfiles === null || (typeof args.creationProfiles === "object" && Object.keys(args.creationProfiles).length === 0);
        try { await syncCreationProfileFiles(effectiveRoot, args.creationProfiles, isClearAll ? null : creationProfiles); } catch { logEvent("config", { root: effectiveRoot, level: "warn", detail: "原创设定已保存，但同步到创作资料 .md 失败（面板与文件会不一致）" }); }
      }
            return { file: stateFilePath(), enabled: after.enabled, autoAnalyze: after.autoAnalyze, source, updated, systemPromptMode: current?.systemPromptMode ?? "brief", promptScene: current?.promptScene ?? "general", leanWorkflow: current?.leanWorkflow === true, chatThreshold: current?.chatThreshold ?? CHAT_PROMPT_THRESHOLD_CHARS, tools, features, styleTolerance, creationProfile, creationProfiles, embedding: { available: embAvailable, loaded: embStatus.loaded, error: embError } };
    }
  });
}

/**
 * v6.6.0：`novel_diagnose` —— 第 20 个工具，也是本版"可观测性"的出口。
 *
 * 为什么需要一个**工具**而不是让用户去看日志文件：本插件的使用者是小说作者，不会去读 .jsonl ✗；
 * 真正的消费者是替他操作的 AI。所以把"日志 + 当前状态"聚合成**中文报告**，
 * 由 AI 读、AI 转述。同时它也是**报 bug 时可附带的证据**（分享层已剔除自由文本，可安全贴出）。
 *
 * `action=clear` 清空日志；`action=events` 额外返回事件明细（仍为分享层）。
 */
function registerNovelDiagnose(ctx, config) {
  ctx.tools.register({
    name: "novel_diagnose",
    description: "诊断报告：读日志体检书库与数据目录(只含元数据，不含正文)。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        book: { type: "string", description: "按书过滤" },
        days: { type: "integer", description: "天数(7)" },
        action: { type: "string", enum: ["report", "events", "clear"], description: "report/events/clear" },
        root: { type: "string", description: "书库根" }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string" },
          days: { type: "integer" },
          book: { type: "string" },
          cleared: { type: "boolean" },
          root: { type: "object", additionalProperties: true, description: "{ path, source, looksLikeLibraryRoot }" },
          dataDir: { type: "object", additionalProperties: true, description: "{ path, exists, bytes, files, subdirs:[{name,bytes,files}] }" },
          log: { type: "object", additionalProperties: true, description: "{ dir, bytes, files, kinds }" },
          calls: { type: "object", additionalProperties: true, description: "{ total, ok, degraded, failed }" },
          byTool: { type: "array", items: { type: "object", additionalProperties: true }, description: "按工具的调用统计 [{ tool, total, degraded, failed, msTotal }]" },
          byKind: { type: "array", items: { type: "object", additionalProperties: true }, description: "按事件类型的计数 [{ kind, count }]" },
          topCodes: { type: "array", items: { type: "object", additionalProperties: true }, description: "高频失败/降级类型 [{ code, count }]" },
          problems: { type: "array", items: { type: "object", additionalProperties: true }, description: "反复出问题的「工具 × 书名」组合 [{ tool, book, failed, degraded, codes[], chapters[] }]——单次调用看不见的规律" },
          issues: { type: "array", items: { type: "object", additionalProperties: false, properties: { level: { type: "string", enum: ["error", "warn", "info"] }, title: { type: "string" }, detail: { type: "string" }, suggestion: { type: "string" } }, required: ["level", "title"] }, description: "问题与建议（按级别）" },
          events: { type: "array", items: { type: "object", additionalProperties: true }, description: "action=events 时的事件明细（分享层：自由文本已剔除）" },
          checklist: { type: "array", items: { type: "object", additionalProperties: false, properties: { item: { type: "string" }, state: { type: "string" }, note: { type: "string" } }, required: ["item", "state"] }, description: "本次覆盖与未覆盖（沿用既有清单习惯）" },
          tools: { type: "object", additionalProperties: true, description: "{ registered, enabled }" },
          report: { type: "string", description: "渲染后的中文报告（与 render 同源）" }
        },
        required: ["action", "days", "root", "calls", "issues", "checklist", "report"]
      },
      render: (_args, value) => [{ type: "text", text: value.report ?? formatDiagnosis(value) }]
    },
    execute: async (args, exec) => {
      await assertToolEnabled(config, "novel_diagnose");
      if (args?.action === "clear") {
        await clearLogs();
        return cleanOutput({
          action: "clear",
          days: 0,
          cleared: true,
          root: { path: resolveRoot(config, args, exec), source: "", looksLikeLibraryRoot: false },
          calls: { total: 0, ok: 0, degraded: 0, failed: 0 },
          issues: [{ level: "info", title: "本地事件日志已清空", detail: "此后新的事件会继续记录。", suggestion: "无需处理。" }],
          checklist: [{ item: "清空事件日志", state: "checked", note: "logs/ 下的 events*.jsonl 已删除" }],
          report: "【诊断】本地事件日志已清空。此后新的事件会继续记录。\n\n说明：日志以元数据为主，自由文本字段（错误消息等）经收敛后至多保留一句（≤160 字），且该文件不出本机。"
        });
      }
      const value = await buildDiagnosis(config, args, exec);
      value.report = formatDiagnosis(value);
      return cleanOutput(value);
    }
  });
}

export {
  registerNovelSentenceConfig,
  registerNovelDiagnose,
  registerStyleConfigRoute,
  skillProvider
};
