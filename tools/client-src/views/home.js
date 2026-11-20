function renderHomeView(vc) {
  var el = vc.el, state = vc.state, props = vc.props, isEn = vc.isEn, dirs = vc.dirs, f = vc.f, tools = vc.tools, entry = vc.entry;
  var onFeatures = DETAIL_FEATURES.filter(function (k) { return f[k] !== false; }).length;
  // v4.0.0 修正：计数与工具页渲染同源（TOOL_GROUPS）；宿主清单里的 novel_sentence_config
  // 没有 UI 行（宿主写路径会剥离该键），按宿主全清单计数会出现"开着的比行数多"的错位
  // v6.3.0 更正：上面这两个数字原先写成 15/16，是 v5.0.0 之前的旧值，与实现不符
  // v7.3.2 修（N23）：原注释在此写死「19 行 / 宿主 20 项」，早已随新增工具失真，也违背它自己那句
  //   「数字不要写死」。改为只陈述**关系**、不写死数量：宿主工具总数 = TOOL_GROUPS 的行数 +
  //   唯一有意无 UI 的 novel_sentence_config（22 个工具里只有它没有 UI 行）。
  //   具体数量一律由 TOOL_GROUPS 现算（见下方 onTools 与工具页渲染），以后加工具不必改这里。
  // v4.3.0：那份全清单常量（ALL_TOOLS）本身零引用，已删除，此处只保留结论说明
  var onTools = TOOL_GROUPS.reduce(function (acc, grp) { return acc.concat(grp.tools); }, []).filter(function (k) { return tools[k] !== false; }).length;
  // v4.0.0 修正：英文界面不再用中文单位「万」
  var fmtChars = function (n) {
    var v = Number(n) || 0;
    if (!isEn) return v >= 10000 ? (v / 10000).toFixed(1) + "万" : String(v);
    if (v >= 1000000) return (v / 1000000).toFixed(1) + "M";
    if (v >= 1000) return (v / 1000).toFixed(1) + "k";
    return String(v);
  };
  // v4.3.0：更新检查结果分流——后端 checkForUpdate 现在回稳定形状 { ok, stale, lastSuccess, checkedAt, ... }。
  // ok === false 表示本次检查失败/被限流（latestVersion 可能只是历史值），此时更新条区域改为一行低调灰字：
  // 不显示"发现新版本"条、不报红色错误、不影响面板其它功能；ok === true 或字段缺失（旧后端）时行为与旧版完全一致。
  var updateCheck = state.updateCheck;
  var updateFailed = !!(updateCheck && updateCheck.ok === false);
  var updateFailedText = t("update.failed");
  if (updateFailed && typeof updateCheck.lastSuccess === "string" && updateCheck.lastSuccess !== "") {
    var lastOkAt = new Date(updateCheck.lastSuccess);
    if (!isNaN(lastOkAt.getTime())) updateFailedText = t("update.failedLast").replace("{time}", lastOkAt.toLocaleString(isEn ? "en-US" : "zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }));
  }
  var allTools = ALL_PANEL_TOOLS;
  var knownLexiconCount = state.lexicon && Array.isArray(state.lexicon.entries) ? state.lexicon.entries.length : null;
  var knownPacksCount = state.packsData && Array.isArray(state.packsData.packs) ? state.packsData.packs.length : null;
  var knownReportCount = Array.isArray(state.reportsGroups) ? state.reportsGroups.reduce(function (n, group) { return n + (Array.isArray(group.files) ? group.files.length : 0); }, 0) : null;
  var stats = state.booksStats;
  var statsTotal = (stats || []).reduce(function (acc, book) { acc.chapters += Number(book.chapters) || 0; acc.chars += Number(book.chars) || 0; return acc; }, { chapters: 0, chars: 0 });
  var statsSummary = stats === null ? t("stats.pending") : t("home.librarySummary").replace("{books}", (stats || []).length).replace("{chapters}", statsTotal.chapters).replace("{chars}", fmtChars(statsTotal.chars));
  var openReports = function () {
    reportReqId += 1;
    props.controller.set({ reportsGroups: null, reportsError: false, reportContent: null }, { silent: true });
    // v6.8.0：拉取逻辑移进 controller（删除单份报告后要用同一份重拉，避免两处各写一遍）
    props.controller.loadReports();
    props.controller.openView("reports");
  };
  var runDemo = function () {
    if (state.demoLoading) return;
    props.controller.set({ demoLoading: true }, { silent: true });
    // v4.3.0：超时 + 错误透传 + finally 复位 demoLoading（宿主挂起时按钮不再永久"演示中…"）
    fetchWithTimeout("/api/dsh-novel-writer/demo", { headers: { accept: "application/json" } }).then(function (r2) {
      if (r2.ok) return r2.json();
      return r2.json().catch(function () { return {}; }).then(function (d) {
        throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r2.status);
      });
    }).then(function (d) {
      props.controller.set({ demoReport: d.ok ? d.report : (t("demo.fail") + "：" + (d.error || t("state.unreachable"))) }, { silent: true });
    }).catch(function (err) {
      props.controller.set({ demoReport: t("demo.fail") + "：" + errorText(err) }, { silent: true });
    }).finally(function () {
      props.controller.set({ demoLoading: false }, { silent: true });
    });
  };
  var masterRow = PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
    key: "row-master", icon: "master", title: t("panel.enabled"), summary: t("panel.enabledHint"),
    switchOn: state.enabled, switchDisabled: state.loading, switchLabel: t("panel.enabled"),
    switchOnChange: function (value) { props.toggle({ enabled: value }); }
  });
  var aiRows = [
    PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
      key: "row-autoAnalyze", icon: "autoAnalyze", title: t("panel.autoAnalyze"), summary: t("panel.autoAnalyzeHint"),
      switchOn: state.autoAnalyze, switchDisabled: state.loading, switchLabel: t("panel.autoAnalyze"),
      switchOnChange: function (value) { props.toggle({ autoAnalyze: value }); }
    }),
    RowDivider(el, el, t, NW_UI, { key: "rd-auto" }),
    PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
      key: "row-lean", icon: "lean", title: t("panel.leanWorkflow"), summary: t("panel.leanWorkflowHint"),
      switchOn: state.leanWorkflow === true, switchDisabled: state.loading, switchLabel: t("panel.leanWorkflow"),
      switchOnChange: function (value) { props.toggle({ leanWorkflow: value }); }
    }),
    RowDivider(el, el, t, NW_UI, { key: "rd-prompt" }),
    PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
      key: "row-prompt", className: "nwPromptRow", icon: "prompt", title: t("panel.spMode"), summary: t("panel.spModeHint"),
      trailing: el(NW_UI.SegmentedControl, {
        label: t("panel.spMode"), value: state.systemPromptMode, disabled: state.loading,
        options: ["off", "brief", "full"].map(function (m) { return { value: m, label: t("sp." + m) }; }),
        onChange: function (m) { if (state.systemPromptMode !== m) props.toggle({ systemPromptMode: m }); }
      })
    })
  ];
  if (state.systemPromptMode === "full") {
    aiRows.push(RowDivider(el, el, t, NW_UI, { key: "rd-scene" }),
      PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
        key: "row-scene", className: "nwPromptRow", icon: "scene", title: t("panel.spScene"), summary: t("panel.spSceneHint"),
        trailing: el(NW_UI.SegmentedControl, {
          label: t("panel.spScene"), value: state.promptScene || "general", disabled: state.loading,
          options: ["general", "writing", "revising", "auditing", "setup"].map(function (scene) { return { value: scene, label: t("sc." + scene) }; }),
          onChange: function (scene) { if ((state.promptScene || "general") !== scene) props.toggle({ promptScene: scene }); }
        })
      }));
  }
  var homeTabs = ["workspace", "ai", "health", "manage"];
  var homeTab = homeTabs.indexOf(state.homeTab) !== -1 ? state.homeTab : "workspace";
  var statLibVal = stats === null ? ((state.books ? state.books.length : 0) + " / —") : ((stats || []).length + " / " + statsTotal.chapters);
  var spModeKey = "sp." + (state.systemPromptMode || "brief");
  var statPromptVal = (state.systemPromptMode === "full")
    ? (t("sp.full") + " · " + t("sc." + (state.promptScene || "general")))
    : (t(spModeKey) === spModeKey ? String(state.systemPromptMode || "") : t(spModeKey));
  var tabBody = null;
  if (homeTab === "workspace") {
    tabBody = el("div", { key: "tab-workspace", className: "nwSection" },
      SectionTitle(el, el, t, NW_UI, { label: "home.writing" }),
      GroupCard(el, el, t, NW_UI, { children: [
        entry(t("panel.creationTitle"), t("panel.creationHint"), null, "creation"),
        RowDivider(el, el, t, NW_UI, { key: "rd-creation" }),
        entry(t("packs.title"), t("packs.navHint"), knownPacksCount, "packs"),
        RowDivider(el, el, t, NW_UI, { key: "rd-packs" }),
        entry(t("lex.title"), t("lex.navHint"), knownLexiconCount, "lexicon"),
        RowDivider(el, el, t, NW_UI, { key: "rd-lex" }),
        entry(t("panel.baselineTitle"), t("panel.baselineHint"), null, "baseline"),
        el("details", { key: "library", className: "nwLibrary" },
          el("summary", { className: "nwDisclosureTitle" }, statsSummary, el("span", { className: "nwDisclosureArrow", "aria-hidden": true }, "›")),
          el("div", { className: "nwLibraryBooks" }, (stats || []).length === 0 ? el("div", { className: "nwMuted" }, stats === null ? t("stats.pending") : t("stats.empty")) : stats.map(function (book) {
            return el("div", { key: book.name, className: "nwLibraryBook" },
              el("div", { className: "nwLibraryName" }, book.name),
              el("div", { className: "nwLibraryMeta" }, book.chapters + " " + t("stats.chapters") + " · " + fmtChars(book.chars) + t("stats.chars")),
              book.recent7Chars > 0 ? null : el("span", { className: "nwLibraryIdle" }, t("stats.idle")),
              el("button", { key: "del", type: "button", className: "nwBtn nwBtnSm nwBtnDangerText nwLibraryDel", onClick: function () { props.controller.deleteOpen(book.name); } }, t("del.entry")));
          })))
      ] })
    );
  } else if (homeTab === "ai") {
    tabBody = [
      el("div", { key: "tab-ai-behavior", className: "nwSection" },
        SectionTitle(el, el, t, NW_UI, { label: "home.ai" }),
        GroupCard(el, el, t, NW_UI, { children: aiRows })),
      el("div", { key: "tab-ai-features", className: "nwSection" },
        SectionTitle(el, el, t, NW_UI, { label: "home.features" }),
        GroupCard(el, el, t, NW_UI, { children: [
          entry(t("panel.featuresTitle"), t("panel.featuresHint"), onFeatures + "/" + DETAIL_FEATURES.length, "features"),
          RowDivider(el, el, t, NW_UI, { key: "rd-features" }),
          entry(t("panel.toolsTitle"), t("panel.toolsHint"), onTools + "/" + allTools.length, "tools"),
          RowDivider(el, el, t, NW_UI, { key: "rd-tools" }),
          entry(t("model.title"), t("home.modelHint").replace("{status}", engineStatusText(state.embeddingStatus, t)), null, "model")
        ] }))
    ];
  } else if (homeTab === "health") {
    tabBody = el("div", { key: "tab-health", className: "nwSection" },
      SectionTitle(el, el, t, NW_UI, { label: "home.maintenance" }),
      GroupCard(el, el, t, NW_UI, { children: [
        entry(t("reports.title"), t("reports.hint"), knownReportCount, "reports", openReports),
        RowDivider(el, el, t, NW_UI, { key: "rd-reports" }),
        entry(t("diag.title"), t("diag.navHint"), null, "diagnose"),
        RowDivider(el, el, t, NW_UI, { key: "rd-diagnose" }),
        entry(state.demoLoading ? t("demo.loading") : t("demo.run"), t("demo.hint"), null, "demo", runDemo, state.demoLoading),
        state.demoReport ? el("pre", { key: "demo-report", className: "nwBoxed nwReportPre nwDemoReport" }, state.demoReport) : null
      ] })
    );
  } else {
    tabBody = [
      el("div", { key: "tab-manage-del", className: "nwSection" },
        SectionTitle(el, el, t, NW_UI, { label: "del.title" }),
        GroupCard(el, el, t, NW_UI, { children: entry(t("del.title"), t("del.navHint"), Array.isArray(state.trashList) ? state.trashList.length : null, "trash") })),
      el("div", { key: "tab-manage-adv", className: "nwSection" },
        SectionTitle(el, el, t, NW_UI, { label: "home.advanced" }),
        GroupCard(el, el, t, NW_UI, { children: PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
          key: "row-raw", icon: "danger", tone: "danger",
          title: el("span", null, el("span", { className: "nwAgeTag" }, "18+"), t("feature.rawWriting")),
          summary: t("home.rawHint"),
          bottom: f.rawWriting === true ? el("div", { className: "nwNote nwNoteWarn" }, t("home.rawWarning")) : null,
          switchOn: f.rawWriting === true, switchDisabled: state.loading, switchLabel: t("feature.rawWriting"),
          switchOnChange: function (value) { props.controller.rawToggle(value); }
        }) })),
      StorageDisclosure(el, el, t, NW_UI, { key: "tab-manage-storage", controller: props.controller, revealing: state.revealing, items: [
        { label: t("dir.data") + " · " + formatSize(state.dataDirSize), path: dirs.dataDir || state.dataDir || "", revealKey: "data-dir" },
        { label: t("dir.stateFile"), path: dirs.stateFile || state.file || "", revealKey: "state-file" }
      ] }),
      updateCheck ? el("div", { key: "updateStale", className: "nwUpdateStale" }, updateFailed ? updateFailedText : t("home.updateChecked")) : null
    ];
  }
  return el("div", { className: "nwHome" },
    updateCheck && !updateFailed && updateCheck.updateAvailable && updateCheck.releaseUrl
      ? el("a", { className: "nwNote nwNoteAccent nwUpdateBar", href: updateCheck.releaseUrl, target: "_blank", rel: "noopener noreferrer" }, t("update.title") + " v" + updateCheck.latestVersion + " · " + t("update.go")) : null,
    GroupCard(el, el, t, NW_UI, { children: [
      masterRow,
      RowDivider(el, el, t, NW_UI, { key: "rd-hero-stats" }),
      el("div", { key: "hero-stats", className: "nwQuickStats" },
        el("button", { type: "button", className: "nwQuickStat", onClick: function () { props.controller.setHomeTab("workspace"); } },
          el("span", { className: "nwQuickStatVal" }, statLibVal),
          el("span", { className: "nwQuickStatLabel" }, t("home.statLibrary"))),
        el("button", { type: "button", className: "nwQuickStat", onClick: function () { props.controller.openView("tools"); } },
          el("span", { className: "nwQuickStatVal" }, onTools + "/" + allTools.length),
          el("span", { className: "nwQuickStatLabel" }, t("home.statTools"))),
        el("button", { type: "button", className: "nwQuickStat", onClick: function () { props.controller.setHomeTab("ai"); } },
          el("span", { className: "nwQuickStatVal" }, statPromptVal),
          el("span", { className: "nwQuickStatLabel" }, t("home.statPrompt")))
      )
    ] }),
    el("div", { key: "home-tabs", className: "nwHomeTabs", role: "tablist", "aria-label": t("panel.title") }, homeTabs.map(function (tabId) {
      var active = homeTab === tabId;
      return el("button", {
        key: tabId,
        type: "button",
        role: "tab",
        "aria-selected": active,
        className: "nwHomeTab" + (active ? " nwHomeTabOn" : ""),
        onClick: function () { props.controller.setHomeTab(tabId); }
      }, t("tab." + tabId));
    })),
    tabBody
  );
}
