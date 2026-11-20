// ---- 迷你控制器 ----
function createController() {
  var listeners = new Set();
  var toggleRef = null;
  // v4.3.0：在途 POST 计数——rev 只统计"非 silent 写入"，看不到已发出但未返回的保存请求，
  // 刷新/首载会把宿主的旧值回写进 UI（用户刚切的总开关又跳回去）
  var pendingWrites = 0;
  var state = {
    enabled: true,
    autoAnalyze: true,
    systemPromptMode: "brief",
    // v5.0.0：提示词场景（与档位正交）；老宿主不返回该字段 → general，行为与 4.x 一致
    promptScene: "general",
    // v5.0.0：精简工作流（全局布尔，与档位/场景同级；老宿主不返回该字段 → false，行为与 5.0.0 之前一致）
    leanWorkflow: false,
    // v7.3.1 修（#80）：提问节奏（chatThreshold）。v7.3.2 修（N21）：宿主 GET /state 与 POST 回包**都**下发
    // 该字段（core.js 无条件下发，无值时给 400）；此处的 null 只是"未确认"哨兵，仅覆盖老宿主不下发 /
    // 本地降级两条路径——那种情况下界面显示空，而不是拿默认 400 冒充"当前值"
    // （假的 400 一旦被用户点保存，就会把 state.json 里真实的 150 覆盖掉）。
    chatThreshold: null,
    chatThresholdDraft: null,
    tools: {},
    file: "",
    loading: true,
    hostOk: true,
    saveFailed: false,
    panelOpen: false,
    plotsDir: "",
    dataDir: "",
    // 书库根诊断：root 实际解析路径 / rootSource 来源 / rootWarning 有问题时的中文诊断（正常为 null）
    root: "",
    rootSource: "",
    rootWarning: null,
    // v6.5.0：书库根输入草稿（null=未编辑，显示当前根）与保存中标记
    rootDraft: null,
    rootSaving: false,
    // v6.5.0：SelectMenu 各实例的开合/高亮状态（#28：按开合安装/拆除外部点击监听）
    // v7.3.1 修（#86）：删掉只写不读的 state.selectOutsideBound——监听装拆由闭包 selectUnbind 判据
    selectMenus: {},
    dataDirSize: 0,
    embeddingStatus: null,
    updateCheck: null,
    styleTolerance: null,
    baselineDraft: null,
    baselineSaved: false,
    creationProfile: null,
    creationProfiles: {},
    creationDraft: null,
    creationDirty: false,
    creationBook: "",
    creationNewBook: "",
    books: [],
    booksStats: null, // null=未就绪（宿主未提供），[]=真空
    demoReport: null,
    demoLoading: false,
    reportsGroups: null,
    reportsError: false,
    creationNameBad: false,
    reportContent: null,
    // v6.8.0：正在删除的那一份报告文件名（删完清空；用于禁用该行按钮）
    reportDeleting: "",
    features: {},
    dirs: null,
    view: "main",
    refreshing: false,
    refreshedAt: 0,
    revealMsg: "",
    revealErr: false,
    revealing: false,
    rawModal: false,
    rawCountdown: 0,
    rawPromiseOpen: false,
    rawPromiseText: "",
    rawPromiseOk: false,
    // v6.8.0：按书删除（预览 → 确认 → 执行）与回收站
    // v6.8.1：删除改由独立页面承载（delBook 非空 = 正在看某本书的预览），弹窗只留给书库行上的快捷入口
    delOpen: false,
    delBook: "",
    delPlan: null,
    delLoading: false,
    delError: "",
    delAck: false,
    delBusy: false,
    delResult: null,
    delReqId: 0,
    // v6.8.0：勾选了哪些位置（key → true）。默认全选＝原来的"删整本书"；
    // 取消勾选就变成"只清这一类"（例如只清报告历史/缓存，正文留着）
    delSel: {},
    trashLoading: false,
    trashList: null,
    trashError: "",
    trashBusyId: "",
    trashNote: "",
    purgeOpen: false,
    purgeId: "",
    purgeBook: "",
    purgeText: "",
    purgeOk: false,
    // v6.2.0：必用词表面板状态（词表数据 / 作用层 / 当前书 / 过滤词 / 表单 / 导入区）
    lexicon: null,
    lexiconScope: "all",
    lexiconBook: "",
    lexiconQuery: "",
    lexiconForm: null,
    lexiconFormOpen: false,
    lexiconImportOpen: false,
    lexiconImportText: "",
    lexiconBusy: false,
    lexiconErr: false,
    // 风格基线范围面板状态（数据 / 当前书 / 范围模式 / 待保存选中章 / 失效章 / 列表是否全展开 / 状态位）
    // 数据源 = GET|POST /api/dsh-novel-writer/baseline（与词表同族：reqId 过期丢弃 + busy/err 约定）
    baseline: null,
    // v7.3.3 修（#5/M4）：初值从本地偏好恢复——刷新后仍记得上次选的书（空 = 还没选过）
    baselineBook: readLocalBaselineBook(),
    baselineMode: "all",
    baselineSel: [],
    baselineMissing: [],
    baselineShowAll: false,
    baselineBusy: false,
    baselineErr: false,
    // v6.6.0：诊断面板状态。数据源 = GET /api/dsh-novel-writer/diagnose（只读，不写盘）。
    // diagDays 存**字符串**：官方 SegmentedControl 的选项 value 只接受字符串（非字符串会被丢弃），
    // 数值转换统一走 controller.diagDaysNum()，避免 UI 值与请求值两套口径漂移。
    diag: null,
    diagDays: "7",
    diagBusy: false,
    diagErr: false,
    // 剪贴板不可用/被拒时的降级标记（true = 提示用户手动全选报告块）
    diagManual: false,
    // v7.0.0：度量口径（细节密度词表去噪后的口径标识）。
    // 口径一变，同一章的新旧数值就不可比——所以面板必须能看见"有几个缓存还是旧口径"，
    // 并给一个按钮把这些缓存清掉重算，否则作者会拿新报告跟旧报告比，越比越糊涂。
    caliber: null,
    caliberBusy: false,
    caliberMsg: "",
    // v7.2.0：对抗性审计（诊断页的独立入口）。这三个动作都在本机算完，不调用模型、不花 token；
    // 它们也都不写盘：对账结果与任务书只活在面板状态里，刷新即弃。
    // 唯一会产生会话费用的是「把任务书交给另一个 agent 执行」——那一步在面板之外，由用户自己发起。
    auditBusy: false,
    auditMsg: "",
    auditErr: false,
    auditBook: "",
    auditBooks: [],
    // v7.3.0：草稿镜像预览（只读）
    draftBook: "",
    draftChapter: "",
    draftBusy: false,
    draftMsg: "",
    // v7.3.1 修（#88）：草稿通道自己的错误标志（旧实现读的是审计通道的 auditErr，且三元两支皆空串）
    draftErr: false,
    draftPeek: null,
    auditChapter: "",
    auditClaims: "",
    auditResult: null,
    // v7.5.0：首页标签页 / 工具搜索与默认展开 / 题材规则包管理状态
    homeTab: "workspace",
    toolQuery: "",
    toolGroupOpen: { library: true, writing: true, style: false, story: false, system: false },
    packsBook: "",
    packsData: null,
    packsBusy: false,
    packsErr: false,
    packsMsg: "",
    packsForm: null,
    packsFormDirty: false,
    packsFormBind: false,
    packsImportText: "",
    packsImportFileName: "",
    packsImportPreview: null,
    packsImportId: "",
    packsImportOverwrite: false,
    packsImportBind: false,
    packsImportMsg: "",
    packsImportErr: false,
    packsImportBusy: false,
    packShareOpen: false,
    packShareId: "",
    packShareText: "",
    packShareJson: "",
    packDeleteOpen: false,
    packDeleteId: "",
    packDeleteName: ""
  };
  // #28：下拉全局监听的"当前解绑器"。展开时安装（重复安装先解绑上一次）、收起/点击外部/
  // 面板卸载时拆除；解绑幂等（没有安装或重复调用都安全）。
  var selectUnbind = null;
  /** 关闭所有下拉并拆除全局监听（点外部与显式关闭共用）。 */
  var closeAllSelects = function () {
    var menus = api.getSnapshot().selectMenus || {};
    var next = {};
    Object.keys(menus).forEach(function (k) { next[k] = Object.assign({}, menus[k], { open: false }); });
    api.set({ selectMenus: next }, { silent: true });
    unbindSelectGlobals();
  };
  /** 幂等解绑：没有安装时直接返回；解绑本身抛错也不影响关闭路径。 */
  var unbindSelectGlobals = function () {
    if (selectUnbind === null) return;
    var off = selectUnbind;
    selectUnbind = null;
    try { off(); } catch (err) { /* ignore */ }
  };
  /** 安装全局监听（只装一层；已安装时直接返回，保证 add/remove 成对）。 */
  var bindSelectGlobals = function () {
    if (selectUnbind !== null) return;
    if (typeof document === "undefined" || typeof window === "undefined") return;
    var onDocMouseDown = function (ev) {
      var menus = api.getSnapshot().selectMenus || {};
      var anyOpen = Object.keys(menus).some(function (k) { return menus[k] && menus[k].open; });
      if (!anyOpen) return;
      var hit = ev.target && ev.target.closest ? ev.target.closest(".nwSelWrap") : null;
      if (hit) return; // 点在某个下拉内部：交由其自身逻辑处理
      closeAllSelects();
    };
    // v6.4.0：菜单是 position:fixed 的（为了逃出祖先 overflow 裁剪），
    // 所以祖先滚动时要**跟着重定位**，否则它会与触发器脱节、悬在半空。
    //
    // 为什么不是"滚动就关闭"：那样太粗暴——触发器若在面板底边被裁掉一半，
    // 点击时的聚焦滚动会**立刻把刚打开的菜单关掉**（自动化里 Playwright 的自动滚动
    // 就稳定复现了这一点：click 前先滚 → scroll 事件 → closeAll → 菜单数 0）。
    // 现在改成 rAF 节流的重定位；只有触发器整个滚出视口才关闭。
    var reposition = function () {
      var menus = api.getSnapshot().selectMenus || {};
      var next = null;
      var vh = window.innerHeight || 0;
      Object.keys(menus).forEach(function (k) {
        var m = menus[k];
        if (!m || !m.open) return;
        var wrap = document.querySelector('[data-sel-id="' + k + '"]');
        var btn = wrap ? wrap.querySelector("button") : null;
        next = next || Object.assign({}, menus);
        if (!btn) { next[k] = Object.assign({}, m, { open: false }); return; }
        var r = btn.getBoundingClientRect();
        if (r.bottom < 0 || r.top > vh) { next[k] = Object.assign({}, m, { open: false }); return; }
        next[k] = Object.assign({}, m, {
          pos: Object.assign({}, m.pos, {
            left: Math.round(r.left),
            anchorTop: Math.round(r.top),
            anchorBottom: Math.round(r.bottom),
            vh: Math.round(vh)
          })
        });
      });
      if (next) api.set({ selectMenus: next }, { silent: true });
    };
    var ticking = false;
    var onScrollOrResize = function () {
      if (ticking) return;
      ticking = true;
      var run = function () { ticking = false; reposition(); };
      if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run);
      else setTimeout(run, 16);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    selectUnbind = function () {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  };
  var api = {
    getSnapshot: function () { return state; },
    // v4.3.0：在途写入登记（toggle 的 POST 期间调用），供 GET 侧竞态守卫判断
    beginWrite: function () { pendingWrites += 1; },
    endWrite: function () { pendingWrites = pendingWrites > 0 ? pendingWrites - 1 : 0; },
    // v6.3.0：删掉零调用的公开访问器 pendingWrites()——staleGuard 直接读闭包变量，
    // 两个口径并存容易漂移；测试与渲染均未使用它。
    // v4.3.0：GET 回写的竞态守卫——rev 变了（用户操作过）或有在途 POST 时都不得用远端覆盖本地
    staleGuard: function (revAt) { return api.getSnapshot().rev !== revAt || pendingWrites > 0; },
    set: function (patch, opts) {
      Object.assign(state, patch);
      // v3.5.0 R4：每次状态变更自增版本号（竞态守卫用，对象引用比较是死代码）
      // v4.0.0 修正：opts.silent=true 的后台写入（如 update-check）不参与"用户是否操作过"的竞态计数
      if (!opts || opts.silent !== true) state.rev = (state.rev || 0) + 1;
      // v4.0.0 修正：写入新的提示条时复位 refreshedAt——此前一旦刷新过，之后"已复制/已保存"等所有提示都带 nwFlash 动画
      if (patch.revealMsg !== void 0 && patch.revealMsg !== "" && patch.refreshedAt === void 0) state.refreshedAt = 0;
      listeners.forEach(function (fn) { fn(state); });
    },
    subscribe: function (fn) {
      listeners.add(fn);
      return function () { listeners.delete(fn); };
    },
    refresh: function (opts) {
      var preserveReveal = !!(opts && opts.preserveRevealMsg === true);
      if (api.getSnapshot().refreshing) return Promise.resolve(null);
      // v4.0.0 修正：刷新标志属纯 UI 状态，silent 写入不参与 rev 竞态计数（否则刷新期间点导航就会误判"用户已操作"）
      api.set(preserveReveal ? { refreshing: true } : { refreshing: true, revealMsg: "", revealErr: false }, { silent: true });
      // v3.5.0 R4：记录请求发起时的版本号——返回时版本未变（用户没操作）才用远端覆盖开关/设定
      // v4.3.0：改判 staleGuard（rev + 在途 POST），否则在途保存尚未落盘时刷新会把宿主旧值回写
      var revAt = api.getSnapshot().rev;
      return fetchState().then(function (remote) {
        var stale = api.staleGuard(revAt);
        var patch = {
          // v3.7.0 ②：enabled/autoAnalyze 与 tools/features 同样受竞态守卫（慢请求不覆盖用户刚切的总开关）
          enabled: (stale ? api.getSnapshot().enabled : !!remote.enabled),
          autoAnalyze: (stale ? api.getSnapshot().autoAnalyze : !!remote.autoAnalyze),
          // v4.3.0：补 systemPromptMode——load/toggle 都回读，唯独刷新漏读，三档提示词开关刷新后显示旧值
          systemPromptMode: (stale ? (api.getSnapshot().systemPromptMode || "brief") : (remote.systemPromptMode || "brief")),
          // v5.0.0：同步场景（刷新路径同样不能漏读，否则场景行显示旧值）
          promptScene: (stale ? (api.getSnapshot().promptScene || "general") : (remote.promptScene || "general")),
          // v5.0.0：精简工作流（刷新路径同样不能漏读；严格 === true——字符串/数字脏值不当成"开"）
          leanWorkflow: (stale ? api.getSnapshot().leanWorkflow === true : remote.leanWorkflow === true),
          // v3.5.0 R4：请求期间版本未变（用户没操作）才用远端覆盖开关——慢请求不覆盖用户刚切的
          tools: (stale ? (api.getSnapshot().tools || {}) : (remote.tools || {})),
          features: (stale ? (api.getSnapshot().features || {}) : (remote.features || {})),
          plotsDir: remote.plotsDir || "",
          dataDir: remote.dataDir || "",
          // 书库根诊断（只读宿主事实，不走 stale 快照分支；空/缺省一律视为无警告）
          root: remote.root || "",
          rootSource: remote.rootSource || "",
          rootWarning: remote.rootWarning || null,
          dataDirSize: remote.dataDirSize || 0,
          embeddingStatus: remote.embeddingStatus || null,
          styleTolerance: (stale ? (api.getSnapshot().styleTolerance || null) : (remote.styleTolerance || null)),
          // v7.3.1 修（#80）/ v7.3.2 修（N21）：GET /state 与 POST 回包都下发 chatThreshold，这里照常回读；
          // 只有老宿主不下发该键时保留已确认值/null（不回落 400）
          chatThreshold: stale ? api.getSnapshot().chatThreshold : (Number(remote.chatThreshold) > 0 ? Math.round(Number(remote.chatThreshold)) : api.getSnapshot().chatThreshold),
          creationProfile: (stale ? (api.getSnapshot().creationProfile || null) : (remote.creationProfile || null)),
          creationProfiles: (stale ? (api.getSnapshot().creationProfiles || {}) : (remote.creationProfiles || {})),
          books: remote.books || [],
          booksStats: typeof remote.booksStats === "undefined" ? null : (remote.booksStats || []),
          dirs: remote.dirs || null,
          file: remote.file || "",
          hostOk: true,
          // v4.0.0 修正：刷新成功同样清除"保存失败"横幅（与 load() 成功分支的 saveFailed:false 对齐）
          saveFailed: false,
          loading: false,
          refreshing: false,
          refreshedAt: Date.now(),
          revealMsg: t("panel.refreshed") + " " + new Date().toLocaleTimeString(),
          revealErr: false
        };
        if (preserveReveal) {
          delete patch.refreshedAt;
          delete patch.revealMsg;
          delete patch.revealErr;
        }
        api.set(patch, { silent: true });
        return remote;
      }).catch(function (err) {
        // v4.0.0 修正：取错文案——刷新失败此前复用"打开失败"（plot.revealErr），改为"读取失败"（reports.readFail）
        // v4.3.0：宿主给出的可操作错误（如 500 "state read failed: …" / 403 loopback-only）原样透传
        api.set({ hostOk: false, revealMsg: t("reports.readFail") + "：" + errorText(err), revealErr: true }, { silent: true });
        return null;
      }).finally(function () {
        // v4.3.0：统一在 finally 摘掉刷新/加载标志——任一步抛错都不会让按钮永久转圈
        api.set({ loading: false, refreshing: false }, { silent: true });
      });
    },
    /** v6.5.0：书库根可直接改——POST {lastRoot}，成功后刷新一次让新根与 rootWarning 立即生效。 */
    setRoot: function (dir) {
      var value = String(dir || "").trim();
      if (value === "") {
        api.set({ revealMsg: t("root.emptyErr"), revealErr: true }, { silent: true });
        return Promise.resolve(null);
      }
      api.set({ rootSaving: true, revealMsg: "", revealErr: false }, { silent: true });
      return saveState({ lastRoot: value }).then(function () {
        var before = api.getSnapshot();
        var shouldReloadLex = before.view === "lexicon" || before.lexicon !== null;
        api.set({
          rootSaving: false,
          rootDraft: null,
          revealMsg: t("root.saved"),
          revealErr: false,
          lexicon: shouldReloadLex ? null : before.lexicon,
          lexiconErr: false
        }, { silent: true });
        return api.refresh({ preserveRevealMsg: true }).then(function (remote) {
          var cur = api.getSnapshot();
          if (remote && cur.lexiconBook && Array.isArray(remote.books) && remote.books.indexOf(cur.lexiconBook) === -1) {
            api.set({ lexiconBook: "", lexiconForm: null }, { silent: true });
          }
          if (remote && (cur.view === "lexicon" || cur.lexicon !== null || shouldReloadLex)) {
            return api.loadLexicon().then(function () { return remote; });
          }
          return remote;
        });
      }).catch(function (err) {
        api.set({ rootSaving: false, revealMsg: t("root.saveErr") + "：" + errorText(err), revealErr: true }, { silent: true });
      });
    },
    setRootDraft: function (text) { api.set({ rootDraft: text == null ? null : String(text) }, { silent: true }); },
    /** v6.5.0 SelectMenu 状态：每个实例 id 一条 {open, active, pos}；展开时安装一次外部点击/滚动关闭。 */
    selectState: function (id) {
      var all = api.getSnapshot().selectMenus || {};
      var cur = all[id] || {};
      return {
        open: cur.open === true,
        active: typeof cur.active === "number" ? cur.active : -1,
        pos: cur.pos && typeof cur.pos === "object" ? cur.pos : null
      };
    },
    /** #28：面板卸载/接管时拆除下拉全局监听（幂等，重复调用安全）。 */
    selectGlobalsDispose: function () { unbindSelectGlobals(); },
    selectSet: function (id, patch) {
      var all = Object.assign({}, api.getSnapshot().selectMenus || {});
      all[id] = Object.assign({ open: false, active: -1, pos: null }, all[id] || {}, patch);
      // 同一时刻只开一个下拉：打开某个时关闭其它
      if (patch.open === true) {
        Object.keys(all).forEach(function (k) { if (k !== id) all[k] = Object.assign({}, all[k], { open: false }); });
      }
      api.set({ selectMenus: all }, { silent: true });
      // #28 修复：按"当前是否还有展开的菜单"决定安装/拆除全局监听。
      // 旧实现只在首次展开时惰性安装、从不拆除——每次面板渲染/展开都留下一层捕获阶段监听，
      // 闭包一直持有整份状态快照，滚动与尺寸变化持续空转（内存泄漏 + 掉帧）。
      var anyOpen = Object.keys(all).some(function (k) { return all[k] && all[k].open === true; });
      if (anyOpen) bindSelectGlobals();
      else unbindSelectGlobals();
    },
    openDir: function (target) {
      api.set({ revealMsg: "", revealErr: false, revealing: true }, { silent: true });
      fetchWithTimeout("/api/dsh-novel-writer/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: target || "data-dir" })
      }).then(function (r) {
        // v4.0.0 修正：非 2xx 也先解析 body，取宿主返回的可操作错误（此前直接 throw → 一律降级成"宿主端不可达"）
        if (r.ok) return r.json();
        return r.json().catch(function () { return {}; }).then(function (d) {
          var detail = d && typeof d.error === "string" && d.error !== "" ? d.error : t("plot.revealErr") + "：HTTP " + r.status;
          api.set({ revealMsg: detail, revealErr: true }, { silent: true });
          return null;
        });
      }).then(function (data) {
        if (data === null) return;
        if (data.ok === true) {
          api.set({ revealMsg: t("plot.revealOk") + "：" + (data.path || ""), revealErr: false }, { silent: true });
        } else {
          api.set({ revealMsg: data.error || t("plot.revealErr"), revealErr: true }, { silent: true });
        }
      }).catch(function (err) {
        api.set({ revealMsg: t("plot.revealErr") + "：" + errorText(err), revealErr: true }, { silent: true });
      }).finally(function () {
        api.set({ revealing: false }, { silent: true });
      });
    },
    copyPath: function (dir) {
      if (!dir || dir === "") {
        api.set({ revealMsg: t("plot.pathUnknown"), revealErr: true }, { silent: true });
        return;
      }
      var done = function (ok) {
        if (ok === false) {
          api.set({ revealMsg: t("plot.copyFail") + "：" + dir, revealErr: true }, { silent: true });
        } else {
          api.set({ revealMsg: t("plot.copied") + "：" + dir, revealErr: false }, { silent: true });
        }
      };
      // #62 修复：与 diagCopy 同口径——非安全上下文/权限沙箱里 `navigator` 可能不存在，
      // 访问 `navigator.clipboard` 也可能同步抛错（Permissions Policy）。缺守卫时整个复制动作
      // 会以未捕获异常中断，用户既没复制成功也拿不到提示。
      var dispatched = false;
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(dir).then(function () { done(true); }, function () { done(false); });
          dispatched = true;
        }
      } catch (err) { /* 访问 navigator.clipboard 抛错（权限策略/沙箱）→ 同样走失败提示 */ }
      if (!dispatched) {
        // v3.5.0 #45：非安全上下文实际没复制成功——如实报失败并给出路径
        done(false);
      }
    },
    setToggle: function (fn) { toggleRef = fn; }
  };
  var ctrlCtx = { getToggle: function () { return toggleRef; } };
  attachLexiconController(api);
  attachBaselineController(api);
  attachDiagnoseController(api);
  attachPacksController(api);
  attachTrashController(api, ctrlCtx);
  return api;
}
