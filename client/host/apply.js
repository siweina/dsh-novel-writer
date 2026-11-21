// ---- 插件入口 ----
var inject = ["slots", "locale"];
var applied = false;
function apply(ctx) {
  if (applied) return;
  applied = true;
  var controller = createController();
  var load = async function () {
    // v2.6.5：更新检查（独立请求，3s 超时由后端兜底；失败静默不影响面板）
    // v4.3.0：同样纳入 8s 超时（宿主连不上时不再让这条后台请求悬挂）
    fetchWithTimeout("/api/dsh-novel-writer/update-check", { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      // v4.0.0 修正：update-check 是后台写入，若参与 rev 计数会让 load() 的 rev 守卫误判"用户已操作"，
      // 导致 enabled/tools/features/容差 等已持久化的开关被静默丢弃（面板显示"全部开启"）
      .then(function (uc) { if (uc) controller.set({ updateCheck: uc }, { silent: true }); })
      .catch(function () { /* 静默 */ });
    var revAt = controller.getSnapshot().rev;
    try {
      var remote = await fetchState();
      // v3.9.5 修正：初次加载接入 rev 竞态守卫——慢 GET 到达时若用户已操作（rev 变化），
      // 不得用旧快照覆盖 enabled/autoAnalyze/tools/features/容差/设定等开关字段
      // v4.3.0：改判 staleGuard（rev + 在途 POST），首次加载期间的保存不再被旧快照覆盖
      var revSame = !controller.staleGuard(revAt);
      var snap = controller.getSnapshot();
      controller.set({
        enabled: revSame ? !!remote.enabled : snap.enabled,
        autoAnalyze: revSame ? !!remote.autoAnalyze : snap.autoAnalyze,
        systemPromptMode: revSame ? (remote.systemPromptMode || "brief") : (snap.systemPromptMode || "brief"),
        promptScene: revSame ? (remote.promptScene || "general") : (snap.promptScene || "general"),
        // v5.0.0：精简工作流（首次加载同样不能漏读，否则刷新后开关显示回关闭态）
        leanWorkflow: revSame ? remote.leanWorkflow === true : snap.leanWorkflow === true,
        tools: revSame ? (remote.tools || {}) : (snap.tools || {}),
        features: revSame ? (remote.features || {}) : (snap.features || {}),
        plotsDir: remote.plotsDir || "",
        dataDir: remote.dataDir || "",
        // 书库根诊断（初始加载同样接入，与 refresh 路径一致）
        root: remote.root || "",
        rootSource: remote.rootSource || "",
        rootWarning: remote.rootWarning || null,
        // v2.6.0：初始加载同样接入数据目录占用 + 语义引擎状态（与 refresh 白名单一致）
        dataDirSize: remote.dataDirSize || 0,
        embeddingStatus: remote.embeddingStatus || null,
        styleTolerance: revSame ? (remote.styleTolerance || null) : (snap.styleTolerance || null),
        // v7.3.1 修（#80）/ v7.3.2 修（N21）：GET /state 与 POST 回包都下发 chatThreshold，这里照常回读；
        // 老宿主不下发该键时保留已确认值/null（不回落 400）
        chatThreshold: revSame ? (Number(remote.chatThreshold) > 0 ? Math.round(Number(remote.chatThreshold)) : snap.chatThreshold) : snap.chatThreshold,
        creationProfile: revSame ? (remote.creationProfile || null) : (snap.creationProfile || null),
        creationProfiles: revSame ? (remote.creationProfiles || {}) : (snap.creationProfiles || {}),
        books: remote.books || [],
        booksStats: typeof remote.booksStats === "undefined" ? null : (remote.booksStats || []),
        dirs: remote.dirs || null,
        file: remote.file || "",
        saveFailed: false, // v3.7.0 ③：刷新成功清除错误横幅
        hostOk: true,
        loading: false
      }, { silent: true });
      // v7.3.3 修（#5）：基线页可能在 /state 落定前就打开了（那时 books 还空，自动选书无从下手，
      // 只能先显示空态）。落定后若仍停在基线页且还没选书，补一次——只在确实有书时才发请求，绝不再发空 book。
      var settled = controller.getSnapshot();
      // v7.3.4 修（④-③）：落定后要**把恢复的书名与真实书库对一次**。
      // 旧版只在「书名为空」时补发一次，于是从 localStorage 恢复的旧名（书已被删除/改名）永远等不到核对，
      // 页面会一直停在一条 warning 上。现在四种情形分别处理，且只在确实还没加载出数据时补发。
      if (settled.view === "baseline") {
        var remoteBooks = remote.books || [];
        var curBook = settled.baselineBook || "";
        var notLoadedYet = (settled.baseline || null) === null;
        if (remoteBooks.length === 0) {
          // 书库确实为空：清掉失效的本地记忆，视图走「先选择一本书」空态（不发请求）
          if (curBook !== "") {
            controller.set({ baselineBook: "", baseline: null, baselineErr: false }, { silent: true });
            controller.persistBaselineBook("");
          }
        } else if (curBook === "" || remoteBooks.indexOf(curBook) === -1) {
          // 没选过，或记住的书已不在书库：改选第一本（与 loadBaseline 内同一口径），再加载
          controller.set({ baselineBook: remoteBooks[0], baseline: null }, { silent: true });
          controller.persistBaselineBook(remoteBooks[0]);
          if (notLoadedYet) controller.loadBaseline();
        } else if (notLoadedYet) {
          // 书名有效、只是之前在加载期间被推迟了：现在补一次
          controller.loadBaseline();
        }
      }
      if (settled.view === "packs" && settled.packsData === null) {
        controller.loadPacks();
      }
      return;
    } catch { /* host unreachable */ }
    if (controller.staleGuard(revAt)) return;
    try {
      var local = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      controller.set({
        enabled: typeof local.enabled === "boolean" ? local.enabled : true,
        autoAnalyze: typeof local.autoAnalyze === "boolean" ? local.autoAnalyze : true,
        systemPromptMode: typeof local.systemPromptMode === "string" ? local.systemPromptMode : "brief",
        promptScene: typeof local.promptScene === "string" ? local.promptScene : "general",
        // v5.0.0：精简工作流（宿主不可达时的 localStorage 降级路径；与核心一致只认布尔 true）
        leanWorkflow: local.leanWorkflow === true,
        // v7.3.1 修（#80）：本地降级路径也恢复提问节奏（宿主不可达时本地值就是生效值）
        chatThreshold: Number(local.chatThreshold) > 0 ? Math.round(Number(local.chatThreshold)) : null,
        // v3.5.0 #38：完整恢复本地降级状态
        tools: local.tools || {},
        features: local.features || {},
        styleTolerance: local.styleTolerance || null,
        creationProfile: local.creationProfile || null,
        creationProfiles: local.creationProfiles || {},
        hostOk: false,
        loading: false
      }, { silent: true });
    } catch {
      controller.set({ loading: false, hostOk: false }, { silent: true });
    }
  };
  // v4.3.0：无论 load 走哪条分支（成功/宿主不可达/localStorage 不可用）都必须摘掉 loading——
  // 宿主挂起时按钮不能永久 disabled（fetch 侧 8s 超时会先兜一层，这里是最后一道）
  load().finally(function () {
    if (controller.getSnapshot().loading) controller.set({ loading: false }, { silent: true });
  });
  var TOOLS_DEBOUNCE_MS = 350;
  var toolsDebounceTimer = null;
  var pendingToolsPatch = null;
  var pendingToolsResolvers = [];
  var toolsDebounceWriteHeld = false;
  var isPureToolsPatch = function (patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return false;
    var keys = Object.keys(patch);
    return keys.length === 1 && keys[0] === "tools"
      && !!patch.tools && typeof patch.tools === "object" && !Array.isArray(patch.tools);
  };
  var isPlainPatchObject = function (value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  };
  var resolveQueuedTools = function (resolvers) {
    for (var i = 0; i < resolvers.length; i += 1) {
      try { resolvers[i](); } catch { /* ignore */ }
    }
  };
  var flushSave = async function (savePatch, prevChatThreshold, holdAlreadyAcquired) {
    // v4.3.0：登记在途写入——GET 侧竞态守卫据此禁止用宿主旧快照回写（本函数自身的回读只用 rev 判定，
    // 因为它就是写入方，pendingWrites 在它的 await 期间必然 >0）
    if (!holdAlreadyAcquired) controller.beginWrite();
    var revAt2 = controller.getSnapshot().rev;
    try {
      var remote = await saveState(savePatch);
      var revSame2 = controller.getSnapshot().rev === revAt2;
      var snap2 = controller.getSnapshot();
      controller.set({
        // v4.0.0 修正：与 tools/features 一致补上 revSame2 守卫——慢响应不再回退用户刚切的总开关
        enabled: revSame2 ? !!remote.enabled : !!snap2.enabled,
        autoAnalyze: revSame2 ? !!remote.autoAnalyze : !!snap2.autoAnalyze,
        systemPromptMode: revSame2 ? (remote.systemPromptMode || "brief") : (snap2.systemPromptMode || "brief"),
        promptScene: revSame2 ? (remote.promptScene || "general") : (snap2.promptScene || "general"),
        // v5.0.0：精简工作流（保存成功后回读宿主 next，同样受 revSame2 守卫保护）
        leanWorkflow: revSame2 ? remote.leanWorkflow === true : snap2.leanWorkflow === true,
        // v3.9.5 修正：保存成功后回读宿主完整 next（tools/features/容差/设定），
        // 前提是期间没有更新的用户操作（rev 未变）——避免服务端钳制/规范化与 UI 长期不一致
        tools: revSame2 && remote.tools ? remote.tools : (snap2.tools || {}),
        features: revSame2 && remote.features ? remote.features : (snap2.features || {}),
        styleTolerance: revSame2 && remote.styleTolerance ? remote.styleTolerance : (snap2.styleTolerance || null),
        creationProfile: revSame2 && remote.creationProfile ? remote.creationProfile : (snap2.creationProfile || null),
        creationProfiles: revSame2 && remote.creationProfiles ? remote.creationProfiles : (snap2.creationProfiles || {}),
        // v7.3.1 修（#80）/ v7.3.2 修（N21）：提问节奏回读——POST 回包与 GET /state 都带 chatThreshold；
        // 只有保存成功且期间无新操作才把宿主确认值写入界面，然后清掉草稿（显示宿主实际生效值）。
        chatThreshold: (revSame2 && Number(remote.chatThreshold) > 0) ? Math.round(Number(remote.chatThreshold)) : snap2.chatThreshold,
        chatThresholdDraft: (savePatch.chatThreshold !== void 0 && revSame2) ? null : snap2.chatThresholdDraft,
        file: remote.file || snap2.file,
        hostOk: true
      }, { silent: true });
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      return;
    } catch (err) {
      // v4.3.0：宿主返回的可操作错误（"request body too large (limit 1MB)" / forbidden: loopback-only /
      // 400 校验信息）不再被吞成"网络/路由不可用"——原样显示，同时仍降级保存到本浏览器
      // v7.3.1 修（#80）：保存失败如实回滚界面显示——恢复成宿主已确认值（从未确认则回到空），
      // 不把用户刚填的数当成已生效（旧实现只置 saveFailed，界面仍显示新值，看着像保存成功）。
      // v7.3.2 修（N3）：只在**宿主明确拒绝**时回滚。宿主不可达/路由不可用时属本地降级模式——
      // 用户填的值就是本地生效值（与其它字段一致保留乐观值），必须原样留给下面的 localStorage 持久化；
      // 旧实现先回滚再持久化，等于纯本地模式下 chatThreshold 永远存不进（唯一改不动的字段）。
      var rollback = {};
      if (savePatch.chatThreshold !== void 0 && controller.getSnapshot().rev === revAt2) {
        if (hostUnreachable(err)) {
          // 本地降级：清掉草稿，让输入框显示刚从本地生效的新值（不是"未确认"）
          rollback.chatThresholdDraft = null;
        } else {
          // 宿主拒绝：回滚到宿主已确认值（从未确认则回到空），并保留失败提示
          rollback.chatThreshold = prevChatThreshold;
          rollback.chatThresholdDraft = (prevChatThreshold === null || prevChatThreshold === void 0) ? "" : String(prevChatThreshold);
        }
      }
      // v7.3.2 修（N3）：完整提示——本地降级（hostOk=false）显示「仅保存在本浏览器」，
      // 宿主明确拒绝（hostOk 保持 true）显示「保存到宿主端失败」，两种都带具体错误文案。
      controller.set(Object.assign({ hostOk: !hostUnreachable(err), saveFailed: true, revealMsg: t("panel.saveFailed") + "：" + errorText(err), revealErr: true }, rollback), { silent: true });
    } finally {
      controller.endWrite();
    }
    try {
      var snapshot = controller.getSnapshot();
      // v3.5.0 #38：宿主不可达时完整持久化（刷新不丢 tools/features/容差/设定）
      // v4.3.0：补写 systemPromptMode——读路径一直会读它（load 的 local.systemPromptMode），
      // 写路径却从不写 → 宿主不可达时切"关闭"，刷新后又变回"精简"（读写不对称）
      // v7.3.1 修（#80）：补写 chatThreshold（读路径同样恢复；否则本地降级也丢提问节奏）
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: snapshot.enabled, autoAnalyze: snapshot.autoAnalyze, systemPromptMode: snapshot.systemPromptMode || "brief", promptScene: snapshot.promptScene || "general", leanWorkflow: snapshot.leanWorkflow === true, chatThreshold: snapshot.chatThreshold, tools: snapshot.tools || {}, features: snapshot.features || {}, styleTolerance: snapshot.styleTolerance || null, creationProfile: snapshot.creationProfile || null, creationProfiles: snapshot.creationProfiles || {} }));
    } catch { /* ignore */ }
  };
  var flushPendingTools = function () {
    if (toolsDebounceTimer) { clearTimeout(toolsDebounceTimer); toolsDebounceTimer = null; }
    if (!pendingToolsPatch) {
      if (toolsDebounceWriteHeld) { toolsDebounceWriteHeld = false; controller.endWrite(); }
      var orphanResolvers = pendingToolsResolvers;
      pendingToolsResolvers = [];
      resolveQueuedTools(orphanResolvers);
      return Promise.resolve();
    }
    var batchTools = pendingToolsPatch;
    pendingToolsPatch = null;
    var resolvers = pendingToolsResolvers;
    pendingToolsResolvers = [];
    var held = toolsDebounceWriteHeld;
    toolsDebounceWriteHeld = false;
    return flushSave({ tools: batchTools }, null, held).finally(function () {
      resolveQueuedTools(resolvers);
    });
  };
  var toggle = async function (patch) {
    // v2.6.0 修复：features/tools 深合并——此前浅合并整体替换 state.features，其他开关键丢失后渲染为"开"（关 A 后关 B，A 又变开）
    var merged = Object.assign({}, patch, { saveFailed: false });
    var cur = controller.getSnapshot();
    // v7.3.1 修（#80）：getSnapshot() 返回的是**同一个可变 state 对象**——回滚必须在 set(merged)
    // 之前把标量记下来，否则 catch 里读到的已经是刚写进去的新值（回滚等于没滚）。
    var prevChatThreshold = cur.chatThreshold;
    if (patch.features && typeof patch.features === "object") {
      merged.features = Object.assign({}, cur.features || {}, patch.features);
    }
    if (isPlainPatchObject(patch.tools)) {
      merged.tools = Object.assign({}, cur.tools || {}, patch.tools);
    }
    // v3.1.1：creationProfiles 深合并（null 键=删除该书的设定，本地立即生效）
    if (patch.creationProfiles && typeof patch.creationProfiles === "object") {
      var mergedCp = Object.assign({}, cur.creationProfiles || {});
      for (var cpk in patch.creationProfiles) {
        if (patch.creationProfiles[cpk] === null) delete mergedCp[cpk];
        else mergedCp[cpk] = patch.creationProfiles[cpk];
      }
      merged.creationProfiles = mergedCp;
    }
    controller.set(merged);
    if (isPureToolsPatch(patch)) {
      pendingToolsPatch = Object.assign(pendingToolsPatch || {}, patch.tools);
      if (!toolsDebounceWriteHeld) {
        controller.beginWrite();
        toolsDebounceWriteHeld = true;
      }
      if (toolsDebounceTimer) clearTimeout(toolsDebounceTimer);
      return new Promise(function (resolve) {
        pendingToolsResolvers.push(resolve);
        toolsDebounceTimer = setTimeout(function () {
          flushPendingTools();
        }, TOOLS_DEBOUNCE_MS);
      });
    }
    var savePatch = patch;
    var queuedResolvers = [];
    var held = false;
    if (pendingToolsPatch) {
      if (patch.tools !== void 0 && !isPlainPatchObject(patch.tools)) {
        await flushPendingTools();
      } else {
        if (toolsDebounceTimer) { clearTimeout(toolsDebounceTimer); toolsDebounceTimer = null; }
        var queuedTools = pendingToolsPatch;
        pendingToolsPatch = null;
        queuedResolvers = pendingToolsResolvers;
        pendingToolsResolvers = [];
        held = toolsDebounceWriteHeld;
        toolsDebounceWriteHeld = false;
        savePatch = Object.assign({}, patch, {
          tools: Object.assign({}, queuedTools, isPlainPatchObject(patch.tools) ? patch.tools : {})
        });
      }
    }
    try {
      return await flushSave(savePatch, prevChatThreshold, held);
    } finally {
      resolveQueuedTools(queuedResolvers);
    }
  };
  controller.setToggle(toggle);
  // v5.2.0：入口与面板都走官方席位（侧栏一行 + 主栏页面）；拿不到就回退 v5.1.1 的 DOM 注入。
  var officialPanel = false;
  var openPanel = function () {
    if (officialPanel) {
      var layout = readHostService(ctx, "layout");
      if (layout && typeof layout.selectPanel === "function") {
        try { layout.selectPanel(NW_PANEL_ID); return; } catch { /* ignore */ }
      }
    }
    controller.set({ panelOpen: !controller.getSnapshot().panelOpen }, { silent: true });
  };
  var disposers = [];
  var legacyEntryDispose = null;
  var legacyPanelDispose = null;
  var mountLegacyEntry = function () {
    if (legacyEntryDispose) return;
    try { legacyEntryDispose = mountSidebarEntry(controller, openPanel) || null; } catch (error) { console.warn("[dsh-novel-writer] UI mount failed:", error); }
  };
  var mountLegacyPanel = function () {
    if (legacyPanelDispose) return;
    try { legacyPanelDispose = mountPanel(controller, toggle) || null; } catch (error) { console.warn("[dsh-novel-writer] UI mount failed:", error); }
  };
  var unmountLegacyEntry = function () {
    if (!legacyEntryDispose) return;
    try { legacyEntryDispose(); } catch { /* ignore */ }
    legacyEntryDispose = null;
  };
  var unmountLegacyPanel = function () {
    if (!legacyPanelDispose) return;
    try { legacyPanelDispose(); } catch { /* ignore */ }
    legacyPanelDispose = null;
  };
  /** 接管官方席位；成功则撤掉 DOM 注入的旧入口与旧面板。 */
  var tryOfficialPanel = function () {
    if (officialPanel) return true;
    if (!registerOfficialPanel(ctx, controller, toggle, disposers)) return false;
    officialPanel = true;
    unmountLegacyEntry();
    unmountLegacyPanel();
    return true;
  };
  mountLegacyEntry();
  mountLegacyPanel();
  exports.__internals.tryOfficialPanel = tryOfficialPanel;   // 供测试直接驱动
  if (!tryOfficialPanel() && ctx && ctx.slots && typeof ctx.slots.subscribe === "function") {
    // Either seat can be declared last; retry when either one changes.
    ["sidebar.panellist", "main"].forEach(function (name) {
      try {
        var stopWatch = ctx.slots.subscribe(name, function () { tryOfficialPanel(); });
        if (typeof stopWatch === "function") disposers.push(stopWatch);
      } catch { /* 订阅不可用：保留旧 UI */ }
    });
  }
  // 官方设置页「插件配置」卡片（v0.4.0 合并；slots 服务由 inject 声明）
  // 注（v3.9.5）：settings.plugin.item 是 keyed slot——宿主需在其 settingsScope served 集合中登记
  // novel-writer-config 命名空间该卡片才会被渲染；若宿主未实现则此卡片为“仅侧边栏入口”模式，属预期行为
  // v4.3.0 复核：当前宿主只派发已 serve 的 settings 命名空间，插件宿主半从未注册该命名空间 →
  // NovelWriterSettingsCard 实际永不渲染。v7.3.1 修（#85）复核后仍**保留**（不是纯死代码，故不删）：
  //   1) test/client-test.mjs 不只看"槽位已注册"：它把注册到的 component 当组件真渲染一遍，
  //      断言组件体可执行、vnode 节点数正常（卡片内任何 TypeError 都会在那里当场失败）；
  //      删组件就得同步删掉这段覆盖，等于把"设置卡片能不能安全渲染"的守卫一起丢掉；
  //   2) 宿主侧一旦补上命名空间注册，这里无需再改代码。
  // 若确定永久不做宿主侧注册，请在删组件的同时修改 test/client-test.mjs 的槽位/卡片渲染断言，
  // 并连同 card.* 词条一并删除。
  try {
    var settingsDispose = ctx.slots?.inject?.("settings.plugin.item", function () {
      return ctx.slots.register({
        name: "settings.plugin.item",
        key: "novel-writer-config",
        id: "novel-writer-config",
        order: 105,
        inject: function () { return {}; }
      }, function () {
        return react.createElement(NovelWriterSettingsCard, { controller: controller, onOpenPanel: openPanel });
      });
    });
    if (typeof settingsDispose === "function") disposers.push(settingsDispose);
  } catch (error) {
    console.warn("[dsh-novel-writer] settings card mount failed:", error);
  }
  // v4.3.0：真正用起 inject 里声明的 locale 服务（宿主 @deepseek-ai/dsh-client-locale 通过
  // ctx.provide("locale", locale) 提供 getSnapshot/subscribe）。此前声明了 locale 却全程读
  // document.documentElement.lang，服务白挂；现在语言切换由服务订阅驱动一次同步，
  // 面板内文案（isEn 是渲染期快照）随切换立即更新，不再停留旧语言。
  var localeSub = null;
  var applyLocale = function () {
    try {
      var snap = ctx.locale && typeof ctx.locale.getSnapshot === "function" ? ctx.locale.getSnapshot() : null;
      localeId = snap && typeof snap.active === "string" ? snap.active : "";
    } catch { localeId = ""; }
  };
  try {
    applyLocale();
    if (ctx.locale && typeof ctx.locale.subscribe === "function") {
      localeSub = ctx.locale.subscribe(function () {
        applyLocale();
        controller.set({}, { silent: true });
      });
    }
  } catch { /* locale 服务不可用时退化为 document.documentElement.lang + langObserver */ }
  var langObserver = null;
  try {
    if (typeof MutationObserver === "function" && typeof document !== "undefined" && document.documentElement) {
      langObserver = new MutationObserver(function () { controller.set({}, { silent: true }); });
      langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    }
  } catch { /* 不可观察时静默降级 */ }
  ctx.effect?.(function () {
    return function () {
      flushPendingTools();
      unmountLegacyEntry();
      unmountLegacyPanel();
      if (langObserver) { try { langObserver.disconnect(); } catch { /* ignore */ } langObserver = null; }
      if (rawTimer) { clearInterval(rawTimer); clearTimeout(rawTimer); rawTimer = null; }
      if (baselineFlashTimer) { clearTimeout(baselineFlashTimer); baselineFlashTimer = null; }
      reportReqId += 1;
      for (var i = 0; i < disposers.length; i += 1) {
        try { disposers[i](); } catch { /* ignore */ }
      }
      if (typeof localeSub === "function") { try { localeSub(); } catch { /* ignore */ } }
      // #28：面板卸载/接管时拆除下拉全局监听（幂等）
      try { controller.selectGlobalsDispose(); } catch { /* ignore */ }
      applied = false;
    };
  }, "dsh-novel-writer: ui");
}
exports.apply = apply;
exports.inject = inject;
// v4.3.0：Node 侧探针钩子——宿主只消费 apply/inject，此对象不参与运行时；
// 用于对纯逻辑（超时封装 / i18n 词条表）做真实断言，无需构建步骤即可测到模块私有函数
// v6.3.0：原先这里导出 6 个纯逻辑函数（fetchWithTimeout / makeTimeoutSignal / errorText /
// dictionary / t / FETCH_TIMEOUT_MS）供测试断言，但全仓 grep 无任何引用——测试只用下面 apply()
// 里另挂的 tryOfficialPanel。按项目自己的「零消费者即删」标准清掉，避免留下"注释说供测试、
// 实际没人用"的空头契约。将来要断言这些私有函数时，请连同真正的断言一起加回来。
exports.__internals = {};
// #29 回归：把适配层交给测试直接驱动——「Hook 是否每帧稳定」只有真渲染才能断言
// （client-test.mjs 用回退路径的 DisclosureRow 验证 Hook 入参求值抛错时不改变 Hook 数量）。
exports.__internals.NW_UI = NW_UI;
