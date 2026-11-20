var TOOL_GROUPS = [
  { key: "library", tools: ["novel_books", "novel_chapters", "novel_read", "novel_import"] },
  { key: "writing", tools: ["novel_chapter_brief", "novel_new_chapter", "novel_draft", "novel_outline"] },
  { key: "style", tools: ["novel_sentence_analysis", "novel_style_check", "novel_style_report", "novel_fix_plan", "novel_keywords"] },
  { key: "story", tools: ["novel_settings", "novel_lexicon", "novel_plot", "novel_summary", "novel_continuity_check", "novel_semantic_search"] },
  // v3.9.0：novel_sentence_config 移出组开关（宿主会剥离该键，全关后 UI 显示与实际不一致）——config 仅由二级页/设置单独管理
  // （5 组共 21 行 = 22 个工具减去有意无 UI 的 novel_sentence_config）
  { key: "system", tools: ["novel_diagnose", "novel_delete_book"] }
];
var ALL_PANEL_TOOLS = TOOL_GROUPS.reduce(function (acc, grp) { return acc.concat(grp.tools); }, []);
var TOOL_PRESETS = [
  { key: "all", tools: ALL_PANEL_TOOLS },
  { key: "writing", tools: ["novel_books", "novel_chapters", "novel_read", "novel_chapter_brief", "novel_new_chapter", "novel_draft", "novel_style_check", "novel_lexicon"] },
  { key: "revising", tools: ["novel_books", "novel_chapters", "novel_read", "novel_fix_plan", "novel_style_check", "novel_continuity_check", "novel_lexicon"] },
  { key: "auditing", tools: ["novel_books", "novel_chapters", "novel_read", "novel_style_report", "novel_style_check", "novel_sentence_analysis", "novel_continuity_check", "novel_plot", "novel_semantic_search"] },
  { key: "setup", tools: ["novel_books", "novel_chapters", "novel_read", "novel_import", "novel_outline", "novel_settings", "novel_plot", "novel_summary", "novel_lexicon"] }
];
// v2.6.0 修复：detailFeatures 提升到渲染函数顶部——二级页渲染与主面板计数共用同一列表（此前计数数组漏 webnovelVibe，5 个开关显示"4开"）
var DETAIL_FEATURES = ["emotionCaveat", "emotionComplexity", "genreTheme", "webnovelVibe", "semanticEmbedding", "lexiconFirst", "chatWriting"];
// Tool icons describe the action, not its storage location.
var toolIcons = {
  novel_books: "toolBooks", novel_chapters: "toolChapters", novel_read: "toolRead",
  novel_keywords: "toolKeywords", novel_sentence_analysis: "toolSentences", novel_style_check: "toolStyleCheck",
  novel_fix_plan: "toolRevise", novel_style_report: "toolProfile", novel_semantic_search: "toolSearch",
  novel_continuity_check: "toolContinuity", novel_diagnose: "toolDiagnose", novel_settings: "toolSettings",
  novel_plot: "toolPlot", novel_summary: "toolSummary", novel_import: "toolImport",
  novel_chapter_brief: "toolBrief", novel_lexicon: "toolLexicon", novel_new_chapter: "toolNewChapter",
  novel_draft: "toolRevise",
  novel_outline: "toolOutline", novel_delete_book: "trash"
};
function formatSize(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  var units = ["B", "KB", "MB", "GB"];
  var i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + " " + units[i];
}
function engineStatusText(st, t) {
  if (!st) return t("model.engineUnknown");
  if (!st.modelPresent) return t("model.engineMissing");
  if (st.loaded) return t("model.engineReady");
  if (st.error) return t("home.modelError");
  return t("model.engineIdle");
}
function createPanelHelpers(vc) {
  var el = vc.el, state = vc.state, view = vc.view || state.view || "main", props = vc.props;
  var entry = function (title, hint, count, viewName, onClick, disabled) {
    var icons = { features: "navFeatures", tools: "navTools", creation: "navCreation", baseline: "navBaseline", lexicon: "navLexicon", packs: "genreTheme", model: "navModel", reports: "navReports", diagnose: "navDiagnose", demo: "navDemo", trash: "trash" };
    return el("button", { type: "button", key: viewName, className: "nwNavEntry", disabled: !!disabled, onClick: onClick || function () { props.controller.openView(viewName); } },
      el("div", { className: "nwIconSlot" }, nwGlyph(el, "nwIconGlyph", icons[viewName] || "navArrow", "›")),
      el("div", { className: "nwNavEntryText" },
        el("div", { className: "nwNavEntryTitle" }, title),
        el("div", { className: "nwNavEntryHint" }, hint)),
      el("div", { className: "nwNavEntryRight" },
        count === null || count === undefined ? null : CountBadge(el, el, t, NW_UI, { label: String(count) }),
        el("span", { className: "nwNavEntryArrow", "aria-hidden": true }, "›")));
  };
  var backBtn = function () {
    var inPackSub = view === "packs-form" || view === "packs-import";
    return el("button", { type: "button", className: "nwBackBtn", onClick: function () {
        // v3.7.0 ④：creation-form 返回前 dirty 确认（与 switchBook 同机制，防静默丢修改）
        if (view === "creation-form" && state.creationDirty && !safeConfirm(t("creation.dirtyWarn"))) return;
        if (view === "packs-form") {
          if (state.packsFormDirty && !safeConfirm(t("packs.dirtyWarn"))) return;
          props.controller.openView("packs");
          return;
        }
        if (view === "packs-import") {
          props.controller.openView("packs");
          return;
        }
        props.controller.openView("main");
      } }, "‹ " + (inPackSub ? t("packs.formBack") : t("panel.title")));
  };
  var switchRow = function (name, fOn, onToggle, extra) {
    return PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
      key: name,
      icon: NW_ICONS[name] ? name : "fallback",
      className: fOn ? "nwRowOn" : "",
      title: t("feature." + name),
      summary: extra ? [t("feature." + name + ".desc"), extra] : t("feature." + name + ".desc"),
      trailing: el(Switch, { checked: fOn, disabled: state.loading, label: String(t("feature." + name)),
        onChange: function () { onToggle(name, !fOn); } })
    });
  };
  // v6.4.0：书库根行——显示当前根与来源；可直接改（写 lastRoot，走后端既有的 POST /state）。
  //
  // 抽成函数是因为它要在**两处**渲染：主视图「状态」区，以及**词表面板**——
  // 书列不出来时用户人就在词表面板里，让他能就地改根，而不是满面板去找（上一版只放主视图底部，
  // 实测用户根本没翻到那儿）。
  var rootRow = function () {
    var srcKey = "root.src." + (state.rootSource || "cwd");
    var srcText = t(srcKey);
    if (srcText === srcKey) srcText = state.rootSource || "";
    var pinned = state.rootSource === "config";
    var draft = state.rootDraft == null ? (state.root || "") : state.rootDraft;
    return el("div", { key: "root-row", className: "nwRootRow" },
      el("div", { className: "nwRootMeta", title: state.root || "" },
        t("root.label") + "：" + (state.root || t("plot.pathUnknown")),
        el("span", { className: "nwRootSrc" }, srcText)
      ),
      state.rootWarning ? el("div", { className: "nwNote nwNoteWarn", style: { whiteSpace: "pre-wrap" } }, state.rootWarning) : null,
      el("div", { className: "nwRootEdit" },
        el("input", {
          type: "text",
          className: "nwRootInput",
          value: draft,
          placeholder: t("root.placeholder"),
          disabled: pinned || state.rootSaving,
          "aria-label": t("root.label"),
          onInput: function (ev) { props.controller.setRootDraft(ev.target.value); },
          onKeyDown: function (ev) { if (ev.key === "Enter") props.controller.setRoot(draft); }
        }),
        el("button", {
          type: "button",
          className: "nwBtn",
          disabled: pinned || state.rootSaving,
          onClick: function () { props.controller.setRoot(draft); }
        }, state.rootSaving ? "…" : t("root.save"))
      ),
      pinned ? el("div", { className: "nwRootNote" }, t("root.pinned")) : null
    );
  };
  return { entry: entry, backBtn: backBtn, switchRow: switchRow, rootRow: rootRow };
}
