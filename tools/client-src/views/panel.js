function PanelView(props) {
  // v3.7.0 高1：isEn 声明在视图作用域（此前只在 rawSetPromise 内部，基线视图引用 ReferenceError 必崩）
  // v4.3.0：语言判定改用 isEnglish()（locale 服务订阅会触发一次 silent set → 本视图重渲染，文案随切换更新）
  var isEn = isEnglish();
  var force = react.useState(0)[1];
  // v4.0.0 修正：依赖补全——此前空依赖却闭包 props.controller，controller 换实例后订阅会留在旧实例
  react.useEffect(function () {
    return props.controller.subscribe(function () { force(function (n) { return n + 1; }); });
  }, [props.controller]);
  var state = props.controller.getSnapshot();
  var on = state.enabled;
  var view = state.view || "main";
  // v6.0.0：过渡方向（同 view 重渲染不重算——StrictMode 双渲染安全）；零 state、零 hook
  if (nwPrevView !== view) {
    nwViewDir = (nwViewOrder[view] || 0) >= (nwViewOrder[nwPrevView] || 0) ? "fwd" : "back";
    nwPrevView = view;
  }
  var el = react.createElement;
  // v4.0.0 修正：三元优先级错误——此前 nwFlash 只拼在 nwPlotOk 分支，错误提示永远拿不到闪烁类
  // v4.3.0 修正：错误分支此前要求 refreshedAt>0，而任何新提示写入都会把 refreshedAt 归零 → "错误提示也闪烁"恒不可达，
  // 这里把错误闪烁改成独立分支（红色 nwFlashErr），成功/刷新提示仍沿用 refreshedAt 判定的绿色 nwFlash
  var msgCls = state.revealErr ? "nwPlotErr nwFlashErr" : ("nwPlotOk" + (state.refreshedAt > 0 ? " nwFlash" : ""));
  var msg = state.revealMsg !== "" ? el("div", { className: "nwPlotMsg " + msgCls }, state.revealErr ? el("div", null,
    /book is required/i.test(state.revealMsg) ? t("note.selectBook") : t("note.actionFailed"),
    el("details", { className: "nwErrorDetails" }, el("summary", null, t("note.details")), state.revealMsg)) : state.revealMsg) : null;
  // v4.3.0：加载期提示（panel.loading 词条早就存在却从未渲染——宿主 /state 挂起时面板只有一排灰按钮，用户不知道在等什么）
  var loadingHint = state.loading ? el("div", { className: "nwStatus" }, "⟳ " + t("panel.loading")) : null;
  var dirs = state.dirs || {};
  var f = state.features || {};
  var tools = state.tools || {};
  var vc = { props: props, state: state, on: on, view: view, isEn: isEn, el: el, dirs: dirs, f: f, tools: tools };
  var helpers = createPanelHelpers(vc);
  vc.entry = helpers.entry;
  vc.backBtn = helpers.backBtn;
  vc.switchRow = helpers.switchRow;
  vc.rootRow = helpers.rootRow;

  var body = null;
  if (view === "features") body = renderFeaturesView(vc);
  else if (view === "tools") body = renderToolsView(vc);
  else if (view === "model") body = renderModelView(vc);
  else if (view === "lexicon") body = renderLexiconView(vc);
  else if (view === "baseline") {
    body = renderBaselineView(vc);
    // 未选书时优先引导选择；已有错误仍保留在 state，选书后按原逻辑加载。
    if ((!state.baselineBook && state.revealErr) || vc.msg === null) msg = null;
  }
  else if (view === "reports") body = renderReportsView(vc);
  else if (view === "creation" || view === "creation-form") body = renderCreationView(vc);
  else if (view === "diagnose") body = renderDiagnoseView(vc);
  else if (view === "trash") body = renderTrashView(vc);
  else if (view === "packs") body = renderPacksView(vc);
  else if (view === "packs-form") body = renderPacksFormView(vc);
  else if (view === "packs-import") body = renderPacksImportView(vc);
  else body = renderHomeView(vc);

  var dialogBody = renderPanelDialog(vc);
  if (dialogBody !== null) body = dialogBody;

  return el("div", { className: "nwPanel" + (props.variant === "main" ? " nwPanelMain" : "") },
    el("div", { className: "nwPanelHeader" },
      el("div", { className: "nwHeaderIdentity" },
        view === "main" ? el("div", { className: "nwPanelTitle" }, t("panel.title")) : helpers.backBtn(),
        view === "main"
          ? el("span", { className: "nwHeaderStatus" + (on ? " nwHeaderStatusOn" : "") }, "● " + t(on ? "status.enabled" : "status.disabled"))
          : el("div", { className: "nwHeaderPage" }, view === "features" ? t("panel.featuresTitle") : view === "tools" ? t("panel.toolsTitle") : view === "baseline" ? t("panel.baselineTitle") : view === "creation" ? t("panel.creationTitle") : view === "creation-form" ? t("creation.formTitle") : view === "reports" ? t("reports.title") : view === "lexicon" ? t("lex.title") : view === "packs" ? t("packs.title") : view === "packs-form" ? ((state.packsForm && state.packsForm.editing) ? t("packs.formTitleEdit") : t("packs.formTitleNew")) : view === "packs-import" ? t("packs.importTitle") : view === "diagnose" ? t("diag.title") : view === "trash" ? t("del.title") : t("model.title"))),
      el("button", { type: "button", title: t("panel.refresh"), "aria-label": t("panel.refresh"), className: "nwRefresh" + (state.refreshing ? " nwRefreshSpin" : ""), onClick: function () { props.controller.refresh(); } }, nwGlyph(el, "nwIco", "refresh", "↻")),
      // v5.2.0：作为官方右栏 tab 时不画关闭按钮——关闭由宿主 tab chip 提供
      typeof props.onClose === "function" ? el("button", { type: "button", className: "nwClose", "aria-label": t("panel.close"), onClick: props.onClose }, "×") : null
    ),
    view === "main" ? el("div", { className: "nwHomeSubtitle" }, t("panel.heroDesc")) : null,
    (state.saveFailed || state.hostOk === false) ? el("div", { className: "nwNote nwNoteWarn nwGlobalNote" }, state.hostOk === false ? t("panel.localOnly") : t("panel.saveFailed")) : null,
    state.rootWarning ? el("div", { className: "nwNote nwNoteWarn nwGlobalNote" }, el("div", null, t("home.rootWarning")), el("div", null, state.rootWarning)) : null,
    loadingHint,
    msg,
    el("div", { key: view, className: "nwView" + (nwViewDir === "back" ? " nwViewBack" : " nwViewFwd") }, body)
  );
}
