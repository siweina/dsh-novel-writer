/**
 * fixture-boot.js — 让插件在「无宿主」环境里跑起来并渲染（dev-only）
 *
 * 负责：
 *   ① 全量桩掉 fetch → 返回**定值**宿主响应（9 视图才有数据可看）；`?host=down` 时改为恒失败，
 *      走插件的 localStorage 降级路径；
 *   ② 造出插件 apply(ctx) 需要的 host 契约（slots / locale / effect / layout）——只给最小可用实现，
 *      并且**如实建模**：未声明的槽位不回调（真机上 slots.inject 就是等声明）；
 *   ③ 用真 React 18.3.1 + 真 react-dom 把官方 `main` 席位组件渲染进 #panel-root；
 *   ④ 暴露 __NW__.{gotoView,shoot 前的稳定等待} 供 capture.mjs 逐视图驱动；
 *   ⑤ 记录渲染期异常与告警到 __NW_INFO__，供 manifest 如实汇报（不伪造成功）。
 * 不负责：截图、写盘、改插件源码。
 *
 * 已知取舍（报告与 README 都写明）：
 *   - 官方原语包 @deepseek-ai/dsh-client-ui-primitives **不在本装置内**，因此插件走它的
 *     NW_UI 回退实现（nw* 类名 + 自注入 CSS）。若宿主在 window.__NW_PRIMITIVES__ 里放了该包，
 *     本文件会自动改用官方原语路径（见 requireShim）。
 */
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var HOST_MODE = params.get("host") === "down" ? "down" : "ok";
  var panelRootEl = document.getElementById("panel-root");

  var info = {
    hostMode: HOST_MODE,
    primitives: window.__NW_PRIMITIVES__ ? "official" : "fallback",
    localStorageAvailable: (function () { try { localStorage.setItem("__nw_probe__", "1"); localStorage.removeItem("__nw_probe__"); return true; } catch (e) { return false; } })(),
    applied: false,
    seatRegistered: [],
    loadSettled: false,
    hostOk: null,
    loading: null,
    lexiconLoaded: false,
    reportsLoaded: false,
    consoleErrors: [],
    pluginWarnings: [],
    fatal: null,
    fetchCounts: {}
  };
  window.__NW_INFO__ = info;

  /* ------------------------------------------------------------------ 异常留痕 */
  var origError = console.error;
  console.error = function () {
    info.consoleErrors.push(Array.prototype.map.call(arguments, function (a) { return a && a.stack ? String(a.stack) : String(a); }).join(" "));
    origError.apply(console, arguments);
  };
  var origWarn = console.warn;
  console.warn = function () {
    info.pluginWarnings.push(Array.prototype.map.call(arguments, String).join(" "));
    origWarn.apply(console, arguments);
  };
  window.addEventListener("error", function (e) { info.fatal = info.fatal || ("window.error: " + (e.message || String(e.error))); });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    info.fatal = info.fatal || ("unhandledrejection: " + ((r && r.message) || String(r)));
  });

  /* ------------------------------------------------------------------ ① 定值宿主数据 */
  // 全部为**常量**（不含 Date.now / 随机数），保证两次运行输入完全相同。
  // ⚠️ 这里是**库根**，不是 novels 目录：插件各处一律 `join(root, "novels")`，
  //    所以 DATA_ROOT 必须是 novels 的父目录（其下同时有 .novel-writer/）。
  //    此前工装写成 "F:\\doment\\novels"（把 novels 目录当根），与真实语义不符——
  //    会让"书库根"行的显示与判据看起来都对，但拿真机一比就露馅。
  var DATA_ROOT = "F:\\doment";
  var DATA_DIR = DATA_ROOT + "\\.novel-writer";
  var DIRS = {
    dataDir: DATA_DIR,
    plotsDir: DATA_DIR + "\\plots",
    settingsDir: DATA_DIR + "\\settings",
    summariesDir: DATA_DIR + "\\summaries",
    lexiconDir: DATA_DIR + "\\lexicon",
    analysisDir: DATA_DIR + "\\analysis",
    auditsDir: DATA_DIR + "\\audits",
    embeddingDir: DATA_DIR + "\\embedding",
    stateFile: DATA_DIR + "\\state.json"
  };
  var BOOKS = ["长夜将至", "潮汐纪年", "星轨之外"];
  var STATE = {
    enabled: true,
    autoAnalyze: true,
    systemPromptMode: "brief",
    promptScene: "general",
    leanWorkflow: false,
    tools: {
      novel_books: true, novel_chapters: true, novel_read: true, novel_keywords: true,
      novel_sentence_analysis: true, novel_style_check: true, novel_fix_plan: true, novel_style_report: true,
      novel_semantic_search: false, novel_continuity_check: true,
      novel_settings: true, novel_plot: true, novel_summary: true, novel_import: false,
      novel_chapter_brief: true, novel_lexicon: true, novel_new_chapter: true, novel_outline: true
    },
    features: {
      emotionCaveat: true, emotionComplexity: false, genreTheme: true, webnovelVibe: false,
      semanticEmbedding: true, lexiconFirst: true,
      semanticSearch: true, semanticStyle: true, semanticImplicit: false,
      rawWriting: false
    },
    styleTolerance: {
      complexity: { low: -15, high: 20 }, modifierDensity: { low: -12, high: 18 },
      abstractDensity: { low: -10, high: 25 }, actionDensity: { low: -18, high: 15 },
      hedgeDensity: { low: -8, high: 22 }, gapIndex: { low: -20, high: 12 }
    },
    creationProfile: {
      worldview: "潮汐历纪元，海平面随双月相位起落，陆地以「潮位」划分阶层。",
      characters: "林砚（拟潮师）、阿澈（灯塔看守）、税官裴洵",
      forbidden: "不写穿越、不写系统面板",
      mainConflict: "林砚必须在第七次大潮前改写潮汐税则，否则将被沉海",
      genre: "东方幻想 · 悬疑",
      extra: "每章至少一次潮声意象；对话不用书面语"
    },
    creationProfiles: {
      "长夜将至": {
        worldview: "长夜降临后，人类靠「灯油」维持城市外围的照明带。",
        characters: "守灯人沈砚、灯油商人段四",
        forbidden: "不写神明视角",
        mainConflict: "灯油即将耗尽，沈砚必须决定献祭哪一区"
      },
      "星轨之外": { worldview: "跃迁航道由废弃星轨构成。", genre: "太空歌剧" }
    },
    books: BOOKS,
    booksStats: [
      { name: "长夜将至", chapters: 128, chars: 412300, recent7Chars: 18600, decodeErrors: 0 },
      { name: "潮汐纪年", chapters: 64, chars: 198540, recent7Chars: 0, decodeErrors: 1 },
      { name: "星轨之外", chapters: 12, chars: 31200, recent7Chars: 4230, decodeErrors: 0 }
    ],
    dataDirSize: 7340032,
    embeddingStatus: { modelPresent: true, loaded: true, error: null },
    dataDir: DATA_DIR,
    // v6.4.0：补上根解析三件套（此前 fixture 没有，导致面板「书库根」行渲染成空值，
    // 看不出真实长相）。三者与 lib/core.js 的 resolveUiRootInfo 返回体同形。
    root: DATA_ROOT,
    rootSource: "lastRoot",
    rootWarning: null,
    plotsDir: DIRS.plotsDir,
    dirs: DIRS,
    file: DIRS.stateFile
  };
  var LEXICON = {
    ok: true, root: DATA_ROOT, book: "长夜将至", scope: "all", dir: DIRS.lexiconDir,
    entries: [
      { term: "潮汐税", kind: "专名", scene: "议事", avoid: ["海税"], note: "官方税目，全书写法统一", scope: "global" },
      { term: "拟潮师", kind: "称呼", scene: "", avoid: ["潮法师"], note: "", scope: "global" },
      { term: "青铜灯", kind: "道具", scene: "夜航", avoid: ["铜灯", "油灯"], note: "林砚随身灯，不要写成普通灯具", scope: "book" },
      { term: "沉海", kind: "场景词", scene: "刑罚", avoid: ["淹死"], note: "本书刑罚术语", scope: "book" },
      { term: "第七次大潮", kind: "专名", scene: "", avoid: [], note: "全书唯一时间锚点", scope: "book" }
    ],
    counts: { book: 3, global: 2, effective: 5 },
    files: { book: "长夜将至.json", global: "_global.json" },
    enabled: true, bookEnabled: true, globalEnabled: true,
    corrupt: false, corruptFiles: [],
    kinds: ["专名", "偏好词", "称呼", "场景词", "口头禅", "其他"],
    books: BOOKS
  };
  var REPORTS = {
    ok: true,
    groups: [
      { name: "句式分析", files: [
        { file: "长夜将至-chapters-metrics.json", label: "长夜将至 · 全书逐章指标", time: "2026-09-28T21:04:12" },
        { file: "长夜将至-第12章.json", label: "长夜将至 · 第12章", time: "2026-09-30T10:31:07" }
      ] },
      { name: "风格画像", files: [
        { file: "长夜将至-style-report.json", label: "长夜将至 · 风格画像", time: "2026-09-29T09:12:45" }
      ] }
    ]
  };
  var DEMO = { ok: true, report: "【体验演示】句式分布：陈述 62% / 对话 18% / 心理 9% …（定值示例，非真实分析）" };
  var UPDATE_CHECK = { ok: true, updateAvailable: false, latestVersion: "6.3.0" };

  /** 构造一个真实 Response（插件按 r.ok / r.json() 消费） */
  function json(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { "content-type": "application/json" }
    });
  }
  function count(url) {
    var key = String(url).split("?")[0];
    info.fetchCounts[key] = (info.fetchCounts[key] || 0) + 1;
  }
  window.fetch = function (url, init) {
    var u = String(url);
    var method = (init && init.method) || "GET";
    count(u);
    if (HOST_MODE === "down") {
      // 如实模拟"宿主端不可达"：fetch 抛 TypeError（插件的 errorText 据此给出"宿主端不可达"）
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    if (u.indexOf("/api/dsh-novel-writer/state") === 0) {
      if (method === "POST") {
        var patch = {};
        try { patch = JSON.parse((init && init.body) || "{}"); } catch (e) { patch = {}; }
        Object.assign(STATE, patch);
      }
      return Promise.resolve(json(STATE));
    }
    if (u.indexOf("/api/dsh-novel-writer/lexicon") === 0) {
      if (method === "POST") return Promise.resolve(json({ ok: true }));
      var q = new URLSearchParams(u.split("?")[1] || "");
      var scope = q.get("scope") || "all";
      var book = q.get("book") || "";
      var entries = LEXICON.entries.filter(function (e) {
        if (scope === "global") return e.scope === "global";
        if (scope === "book") return e.scope === "book" && (book === "" || true);
        return true;
      });
      return Promise.resolve(json(Object.assign({}, LEXICON, { scope: scope, book: book || LEXICON.book, entries: entries })));
    }
    if (u.indexOf("/api/dsh-novel-writer/reports") === 0) {
      if (u.indexOf("read=") !== -1) {
        return Promise.resolve(json({ ok: true, content: { note: "定值报告内容（fixture）", rows: [1, 2, 3] } }));
      }
      return Promise.resolve(json(REPORTS));
    }
    if (u.indexOf("/api/dsh-novel-writer/demo") === 0) return Promise.resolve(json(DEMO));
    if (u.indexOf("/api/dsh-novel-writer/update-check") === 0) return Promise.resolve(json(UPDATE_CHECK));
    if (u.indexOf("/api/dsh-novel-writer/reveal") === 0) return Promise.resolve(json({ ok: true, path: DATA_DIR }));
    return Promise.resolve(json({ error: "fixture: 未桩的路径 " + u }, 404));
  };

  /* ------------------------------------------------------------------ ② host 契约（ctx） */
  var seats = [];
  var disposers = [];
  var slotInjections = [];
  // 如实建模宿主的槽位声明表：这三个槽位在 desktop 0.2.0-rc.2 的 shell 包里被声明
  var DECLARED = { "sidebar.panellist": true, "main": true, "settings.plugin.item": true };
  var ctx = {
    // cordis 风格的服务读取口（第三方插件惯用：ctx.get("layout")）
    get: function (name) { return name === "layout" ? { selectPanel: function () {} } : void 0; },
    effect: function (fn) { var d = fn(); if (typeof d === "function") disposers.push(d); return d; },
    slots: {
      specDynamic: function (name) { return DECLARED[name] ? {} : void 0; },
      spec: function (name) { return DECLARED[name] ? {} : void 0; },
      // 声明即回调（宿主行为）；返回 disposer，registerOfficialPanel 会把它收进 disposers
      inject: function (name, fn) { slotInjections.push(name); var d = fn(); return typeof d === "function" ? d : function () {}; },
      register: function (opts, component) { seats.push({ opts: opts, component: component }); return function () {}; },
      // 席位晚声明的兜底订阅：本 fixture 三个槽位一开始就声明，所以回调不会被调用
      subscribe: function () { return function () {}; }
    },
    locale: {
      getSnapshot: function () { return { active: "zh-Hans" }; },
      subscribe: function () { return function () {}; }
    },
    // package.json 的 dsh.client.inject 声明的三个客户端服务：client.js 全程不读它们，
    // 这里给空壳只为如实建模"宿主侧存在"，避免读者误以为插件依赖它们才能渲染。
    runtime: {}, connection: {}, uiSettings: {}
  };

  /* ------------------------------------------------------------------ ③ 真 React 渲染 */
  var React = window.React;
  var ReactDOM = window.ReactDOM;
  if (!React || !ReactDOM || typeof ReactDOM.createRoot !== "function") {
    info.fatal = "vendor/react.js 或 vendor/react-dom.js 未就位（先跑 node prepare.mjs）";
    window.__NW_READY_STATE__ = "error";
    return;
  }
  function requireShim(name) {
    if (name === "react") return React;
    if (name === "react-dom/client") return { createRoot: ReactDOM.createRoot, hydrateRoot: ReactDOM.hydrateRoot };
    if (name === "@deepseek-ai/dsh-client-ui-primitives") {
      if (window.__NW_PRIMITIVES__) return window.__NW_PRIMITIVES__;
      // 不抛错而是抛错：插件适配层要求"取不到 / 渲染抛错 → 逐控件回退"，这里就是"取不到"分支。
      throw new Error("fixture: @deepseek-ai/dsh-client-ui-primitives 未随装置提供（走回退路径）");
    }
    throw new Error("fixture: 意外的 require(" + name + ")");
  }

  var spec = window.__NW_SPEC__;
  var controller = null;
  var pageSeat = null;
  var root = null;

  (async function boot() {
    try {
      if (!spec || typeof spec.factory !== "function") throw new Error("未捕获到插件模块（window.__NW_SPEC__ 为空）");
      if (spec.id !== "dsh-novel-writer") throw new Error("模块 id 异常: " + spec.id);

      var mod = spec.factory(requireShim);
      info.exports = Object.keys(mod);
      mod.apply(ctx);
      info.applied = true;
      info.seatRegistered = seats.map(function (s) { return s.opts.name || s.opts.id || "?"; });
      info.slotInjections = slotInjections.slice();

      pageSeat = seats.filter(function (s) { return s.opts.name === "main"; })[0];
      if (!pageSeat) throw new Error("未注册官方 main 席位（registerOfficialPanel 未接管）；实际席位=" + JSON.stringify(info.seatRegistered));
      var props = typeof pageSeat.opts.inject === "function" ? pageSeat.opts.inject() : {};
      controller = props.controller;
      if (!controller) throw new Error("main 席位的 inject() 未提供 controller");

      root = ReactDOM.createRoot(panelRootEl);
      var element = React.createElement(pageSeat.component, props);
      if (typeof ReactDOM.flushSync === "function") ReactDOM.flushSync(function () { root.render(element); });
      else root.render(element);

      // 等插件的 load() 落地（loading=false 即两种降级路径都已走完）
      await waitFor(function () { return controller.getSnapshot().loading === false; }, 6000, "load() 落地");
      info.loadSettled = true;
      info.hostOk = controller.getSnapshot().hostOk === true;
      info.loading = controller.getSnapshot().loading === true;

      // 降级路径断言：宿主不可达时必须 hostOk=false，且面板仍然画出来了
      if (HOST_MODE === "down" && info.hostOk !== false) throw new Error("?host=down 未走到降级路径（hostOk 仍为 true）");
      if (!panelRootEl.querySelector(".nwPanel")) throw new Error("面板未渲染出 .nwPanel 根节点");

      await settle();
      window.__NW_READY_STATE__ = "ready";
    } catch (err) {
      info.fatal = String((err && err.stack) || err);
      window.__NW_READY_STATE__ = "error";
    }
  })();

  /* ------------------------------------------------------------------ 稳定等待工具 */
  function raf() { return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function settle() {
    await raf();
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) { /* ignore */ } }
    await raf();
  }
  async function waitFor(pred, timeoutMs, label) {
    var t0 = Date.now();
    for (;;) {
      if (pred()) return true;
      if (Date.now() - t0 > (timeoutMs || 5000)) throw new Error("等待超时: " + label);
      await sleep(16);
    }
  }

  /* ------------------------------------------------------------------ ④ 视图驱动 */
  // 视图 → 真实点击路径（与真机一致：宿主侧栏行/主栏页面由宿主画，我们只驱动 DOM 里的入口）
  var NAV_LABEL = {
    features: "功能开关",
    tools: "工具开关",
    baseline: "风格基线",
    creation: "原创模式",
    lexicon: "必用词表"
  };
  // 每个视图的最小状态覆盖（全部为常量；在导航前一次性写入，silent 不参与 rev 计数）
  var VIEW_SEED = {
    main: {},
    features: {},
    // 工具页默认三组折叠 → 展开三组，才能在截图里看到真实的信息密度
    tools: { toolGroupOpen: { analyze: true, settings: true, create: true } },
    baseline: {},
    reports: {},
    creation: {},
    lexicon: {},
    model: {},
    "creation-form": {}
  };
  var lastLog = [];

  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function textOf(el) { return (el.textContent || "").replace(/\s+/g, " ").trim(); }
  function clickEl(el) {
    el.scrollIntoView({ block: "center" });
    el.click();
  }
  async function resetToMain() {
    if (controller.getSnapshot().view !== "main") {
      controller.set({ view: "main" }, { silent: true });
      await settle();
      return "api-reset";
    }
    return "already-main";
  }
  /** 点击主面板里指定文案的导航入口（nwNavEntry） */
  async function clickNav(label) {
    var hit = qsa("button.nwNavEntry").filter(function (b) {
      var t = b.querySelector(".nwNavEntryTitle");
      return t && textOf(t) === label;
    })[0];
    if (!hit) throw new Error("主面板找不到导航入口「" + label + "」");
    clickEl(hit);
    return "click:nav";
  }

  /**
   * 进入某视图：优先走真实点击链（main → X / features → model / creation → creation-form），
   * 失败时退回 controller.openView（并如实记录 driver）。
   * @returns {Promise<{view:string, driver:string, waitFor:string}>}
   */
  async function gotoView(view) {
    var t0 = Date.now();
    var driver = "api";
    var seed = VIEW_SEED[view] || {};
    if (Object.keys(seed).length > 0) controller.set(Object.assign({}, seed, { view: "main" }), { silent: true });
    else controller.set({ view: "main" }, { silent: true });
    await settle();

    if (view === "main") {
      driver = "api:reset";
    } else if (NAV_LABEL[view]) {
      try { driver = await clickNav(NAV_LABEL[view]); }
      catch (e) { controller.openView(view); driver = "api:fallback(" + e.message + ")"; }
    } else if (view === "model") {
      try {
        controller.set({ view: "main" }, { silent: true }); await settle();
        await clickNav(NAV_LABEL.features);
        await waitFor(function () { return controller.getSnapshot().view === "features"; }, 4000, "features");
        var btn = qsa("button.nwModelBtn")[0];
        if (!btn) throw new Error("功能开关页找不到「⚙ 管理语义模型」按钮");
        clickEl(btn);
        driver = "click:features→model";
      } catch (e) { controller.openView("model"); driver = "api:fallback(" + e.message + ")"; }
    } else if (view === "creation-form") {
      try {
        controller.set({ view: "main" }, { silent: true }); await settle();
        await clickNav(NAV_LABEL.creation);
        await waitFor(function () { return controller.getSnapshot().view === "creation"; }, 4000, "creation");
        // 点「长夜将至」那一行的「编辑」→ 进入表单页（并带上该书已存设定）
        var row = qsa("div.nwFileRow").filter(function (r) { return textOf(r).indexOf("长夜将至") !== -1; })[0];
        if (!row) throw new Error("原创模式列表页找不到「长夜将至」行");
        var chip = Array.prototype.slice.call(row.querySelectorAll("button.nwChip")).filter(function (b) { return textOf(b) === "编辑"; })[0];
        if (!chip) throw new Error("「长夜将至」行找不到「编辑」按钮");
        clickEl(chip);
        driver = "click:creation→form";
      } catch (e) {
        controller.set({ creationBook: "长夜将至", creationDraft: null }, { silent: true });
        controller.openView("creation-form");
        driver = "api:fallback(" + e.message + ")";
      }
    } else if (view === "reports") {
      // 报告数据由主面板入口的 onClick 拉取（不是 reports 视图自己拉的）——必须真点，否则只有"加载中"
      try {
        controller.set({ view: "main", reportsGroups: null, reportsError: false }, { silent: true });
        await settle();
        var entry = qsa("button.nwFileRow").filter(function (b) { return textOf(b).indexOf("报告历史") !== -1; })[0];
        if (!entry) throw new Error("主面板找不到「报告历史」入口");
        clickEl(entry);
        driver = "click:reports-entry";
      } catch (e) {
        var d = await fetch("/api/dsh-novel-writer/reports").then(function (r) { return r.json(); });
        controller.set({ reportsGroups: d.groups || [], reportsError: false }, { silent: true });
        controller.openView("reports");
        driver = "api:fallback(" + e.message + ")";
      }
    } else {
      // 未在上表登记的视图（当前不存在）：退回 controller.openView
      controller.openView(view);
    }

    // 视图切换 + 该视图自己的异步数据都落地后才算稳定
    var waited = [];
    await waitFor(function () { return controller.getSnapshot().view === view; }, 5000, "view=" + view);
    waited.push("view");
    if (view === "lexicon") {
      await waitFor(function () {
        var s = controller.getSnapshot();
        return s.lexicon !== null && s.lexiconBusy !== true;
      }, 5000, "lexicon 数据");
      waited.push("lexicon");
    }
    if (view === "reports") {
      await waitFor(function () {
        var s = controller.getSnapshot();
        return s.reportsGroups !== null || s.reportsError === true;
      }, 5000, "reports 数据");
      waited.push("reports");
    }
    await settle();
    var entryOut = { view: view, driver: driver, waitedFor: waited, ms: Date.now() - t0 };
    lastLog.push(entryOut);
    info.navigation = lastLog;
    if (view === "lexicon") info.lexiconLoaded = controller.getSnapshot().lexicon !== null;
    if (view === "reports") info.reportsLoaded = controller.getSnapshot().reportsGroups !== null;
    return entryOut;
  }

  window.__NW__ = {
    gotoView: gotoView,
    settle: settle,
    controller: function () { return controller; },
    state: function () { return controller ? controller.getSnapshot() : null; },
    /** 面板内容高度（固定视口模式下超出 900px 的部分会被裁掉——manifest 记录它以示"有内容未入镜"） */
    metrics: function () {
      var panel = panelRootEl.querySelector(".nwPanel");
      return {
        view: controller ? controller.getSnapshot().view : null,
        stageW: document.getElementById("stage").clientWidth,
        panelScrollH: panel ? Math.round(panel.scrollHeight) : 0,
        panelScrollW: panel ? Math.round(panel.scrollWidth) : 0,
        panelClientH: panel ? Math.round(panel.clientHeight) : 0,
        docScrollH: Math.round(document.documentElement.scrollHeight)
      };
    },
    /** 当前视图的可见文本指纹（供 capture 核对"确实渲染出了内容"） */
    textLength: function () { var p = panelRootEl.querySelector(".nwPanel"); return p ? textOf(p).length : 0; },
    /** 切到全高模式（页面级滚动）再切回 */
    metric: function (mode) {
      if (mode === "full") document.documentElement.dataset.nwMetric = "full";
      else delete document.documentElement.dataset.nwMetric;
    }
  };
})();
