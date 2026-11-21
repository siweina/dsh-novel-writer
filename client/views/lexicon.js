function renderLexiconView(vc) {
  var el = vc.el, state = vc.state, props = vc.props, f = vc.f, dirs = vc.dirs, entry = vc.entry, rootRow = vc.rootRow;
  // v6.2.0：必用词表——登记「必须优先使用的专有名词 / 作者惯用词」，书级 + 全局两层
  var lexData = state.lexicon;
  var lexAll = lexData && Array.isArray(lexData.entries) ? lexData.entries : [];
  var lexCounts = lexData && lexData.counts ? lexData.counts : { book: 0, global: 0, effective: 0 };
  var lexScope = state.lexiconScope || "all";
  var lexWriteLayer = lexScope === "global" ? "global" : "book";
  var lexLayerOn = lexWriteLayer === "global"
    ? (lexData ? lexData.globalEnabled !== false : true)
    : (lexData ? lexData.bookEnabled !== false : true);
  var lexForm = state.lexiconForm || { term: "", kind: "专名", scene: "", avoid: "", note: "", editing: "" };
  // v6.3.0：类型候选取宿主下发的 LEXICON_KINDS（配合 datalist 既给建议又允许自填）
  var lexKinds = lexData && Array.isArray(lexData.kinds) && lexData.kinds.length > 0
    ? lexData.kinds : ["专名", "偏好词", "称呼", "场景词", "口头禅", "其他"];
  var lexScopeName = function (s) {
    return s === "global" ? t("lex.scope.global") : s === "book" ? t("lex.scope.book") : t("lex.scope.all");
  };
  var lexBookOptions = lexData && Array.isArray(lexData.books) ? lexData.books : (state.books || []);
  // v6.3.0：区分「真的没有词条」与「文件坏了读不出来」——core 新增 corrupt / corruptFiles 契约
  var lexCorrupt = lexData ? (lexData.corrupt === true || (Array.isArray(lexData.corruptFiles) && lexData.corruptFiles.length > 0)) : false;
  // Pure UI expansion; entry edits still go through the existing controller.
  var lexOpenForm = function (term, scope) {
    if (term) props.controller.lexiconEditEntry(term, scope);
    else props.controller.lexiconResetForm();
    props.controller.set({ lexiconFormOpen: true }, { silent: true });
    if (typeof window !== "undefined" && window.requestAnimationFrame) window.requestAnimationFrame(function () {
      var form = document.getElementById("lex-entry-form");
      if (form && form.scrollIntoView) form.scrollIntoView({ block: "start", behavior: "auto" });
    });
  };
  var lexQuery = String(state.lexiconQuery || "").trim();
  // v6.2.0 修复：搜索此前不覆盖「勿用」替身词——按替身词（如「轨道」）搜不到对应条目
  var lexShown = lexQuery === "" ? lexAll : lexAll.filter(function (e) {
    return [e.term, e.kind, e.scene, e.note].some(function (v) { return typeof v === "string" && v.indexOf(lexQuery) !== -1; })
      || (Array.isArray(e.avoid) && e.avoid.some(function (w) { return String(w).indexOf(lexQuery) !== -1; }));
  });
  // v6.3.0 UI 统一：表单行改用本文件既有的 .nwField / .nwFieldCtl 词汇（短标题 + 说明在左、控件在右），
  // 与其它面板的表单行同源，窄屏控件在字段说明下方换行。
  var lexField = function (key, labelKey, hintKey, control) {
    return el("div", { key: "lf-" + key, className: "nwField" },
      el("div", { className: "nwRowText" },
        el("div", { className: "nwRowLabel" }, t(labelKey)),
        hintKey ? el("div", { className: "nwRowHint" }, t(hintKey)) : null
      ),
      el("div", { className: "nwFieldCtl" }, control)
    );
  };
  var lexInput = function (key, labelKey, hintKey, value) {
    return lexField(key, labelKey, hintKey,
      el("input", { type: "text", className: "nwTextInput", value: value || "",
        onChange: function (ev) { var patch = {}; patch[key] = ev.target.value; props.controller.setLexiconForm(patch); } }));
  };
  // v6.3.0 UI 统一：词条行改用 PreferenceRow（与工具页/开关页同一行模式），不再借用文件行的 nwFileRow
  var lexEntryRow = function (e) {
    var scope = e.scope || "book";
    var editable = scope === lexWriteLayer;
    var bits = [];
    if (e.kind) bits.push(e.kind);
    if (e.scene) bits.push(t("lex.scene") + "：" + e.scene);
    if (Array.isArray(e.avoid) && e.avoid.length > 0) bits.push(t("lex.avoidShort") + "：" + e.avoid.join("/"));
    if (e.note) bits.push(e.note);
    return PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
      key: "le-" + e.term + "-" + scope,
      title: e.term + " · " + lexScopeName(scope),
      summary: bits.join("｜"),
      trailing: editable ? el("div", { className: "nwBtnGroup" },
        el("button", { key: "ed", type: "button", className: "nwBtn nwBtnGhost nwBtnSm", disabled: state.lexiconBusy, onClick: function () { lexOpenForm(e.term, scope); } }, t("lex.edit")),
        el("button", { key: "del", type: "button", className: "nwBtn nwBtnGhost nwBtnSm nwBtnDangerText", disabled: state.lexiconBusy, onClick: function () { props.controller.lexiconDeleteEntry(e.term); } }, t("lex.delete"))
      ) : null
    });
  };
  // 词条列表：行间插入 RowDivider（与工具页的分组行一致）
  var lexRows = [];
  lexShown.forEach(function (e, i) {
    if (i > 0) lexRows.push(RowDivider(el, el, t, NW_UI, { key: "le-div-" + i }));
    lexRows.push(lexEntryRow(e));
  });
  return el("div", { className: "nwLexPage" },
    el("div", { className: "nwToolsHint" }, t("lex.hint")),
    GroupCard(el, el, t, NW_UI, { children: [
      PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
        key: "lex-book",
        title: t("lex.bookLabel"),
        // 写出目标层：合并视图写「本书层」，这里如实显示，避免"看着合并、实际写本书"的误读
        summary: t(lexScope === "global" ? "lex.bookGlobalHint" : "lex.bookHint"),
        trailing: el(SelectMenu, {
          id: "lex-book",
          controller: props.controller,
          label: t("lex.bookLabel"),
          value: state.lexiconBook || "",
          placeholder: t("lex.noBook"),
          disabled: state.lexiconBusy || lexScope === "global",
          options: lexBookOptions.map(function (b) { return { value: b, label: b }; }),
          onChange: function (v) { props.controller.setLexiconBook(v); }
        })
      }),
      RowDivider(el, el, t, NW_UI, { key: "lex-rd1" }),
      PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
        key: "lex-scope",
        title: t("lex.scopeLabel"),
        summary: t("lex.scopeHint"),
        bottom: t("lex.countsBook") + " " + lexCounts.book + t("lex.countsUnit") + "　" + t("lex.countsGlobal") + " " + lexCounts.global + t("lex.countsUnit") +
          (state.lexiconBusy ? "　" + t("lex.busy") : ""),
        trailing: el(NW_UI.SegmentedControl, {
          label: t("lex.scopeLabel"),
          value: lexScope,
          disabled: state.lexiconBusy,
          options: [
            { value: "all", label: t("lex.scope.all") },
            { value: "book", label: t("lex.scope.book") },
            { value: "global", label: t("lex.scope.global") }
          ],
          onChange: function (next) { if (lexScope !== next) props.controller.setLexiconScope(next); }
        })
      }),
      RowDivider(el, el, t, NW_UI, { key: "lex-rd2" }),
      PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
        key: "lex-force", title: t("lex.forceLabel"), summary: t("lex.forceHint"),
        trailing: el(Switch, { checked: f.lexiconFirst !== false, disabled: state.loading, label: t("lex.forceLabel"),
          onChange: function (v) { props.toggle({ features: { lexiconFirst: v } }); } })
      }),
      RowDivider(el, el, t, NW_UI, { key: "lex-rd3" }),
      PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
        key: "lex-layer",
        title: t("lex.layerLabel") + "（" + (lexWriteLayer === "global" ? t("lex.scope.global") : t("lex.scope.book")) + "）",
        summary: t("lex.layerHint"),
        trailing: el(Switch, { checked: lexLayerOn, disabled: state.loading || state.lexiconBusy, label: t("lex.layerLabel"),
          onChange: function () { props.controller.lexiconToggleLayer(!lexLayerOn); } })
      })
    ] }),
    SectionTitle(el, el, t, NW_UI, { label: "lex.listTitle" }),
    GroupCard(el, el, t, NW_UI, { children: [
      el("div", { key: "lex-search", className: "nwLexToolbar" },
        el("input", { type: "search", className: "nwTextInput", "aria-label": t("lex.searchLabel"), value: state.lexiconQuery || "", placeholder: t("lex.search"),
          onChange: function (ev) { props.controller.setLexiconSearch(ev.target.value); } }),
        el("button", { type: "button", className: "nwBtn" + (state.lexiconFormOpen ? " nwBtnGhost" : " nwBtnPrimary"), disabled: state.lexiconBusy, onClick: function () { lexOpenForm(); } }, t("lex.newEntry"))),
      lexShown.length > 0 ? lexRows : el("div", { key: "lex-empty", className: "nwEmpty" },
        el("div", { className: "nwEmptyTitle" }, state.lexiconErr ? t("lex.loadFail") : lexCorrupt ? t("lex.corruptTitle") : state.lexiconBusy ? t("lex.busy") : lexQuery ? t("lex.noMatch") : t("lex.emptyTitle")),
        el("div", { className: "nwEmptyHint" }, state.lexiconErr ? t("lex.loadFailHint") : lexCorrupt ? t("lex.corruptHint") : lexQuery ? t("lex.noMatchHint") : t("lex.empty")))
    ] }),
    state.lexiconFormOpen ? el("div", { id: "lex-entry-form", className: "nwLexForm" },
    GroupCard(el, el, t, NW_UI, { title: "lex.addTitle", children: [
      lexInput("term", "lex.term", null, lexForm.term),
      RowDivider(el, el, t, NW_UI, { key: "lex-rd4" }),
      // 类型：datalist 既给预设建议、又允许自填（与后端「kind 可自定义」一致）
      // 注意：id 刻意不用 nw* 前缀——它不是 CSS 类名，用 nw 前缀会被 ui-audit 的 R9
      //「疑似类名未在 CSS 中定义」启发式误报（提示级）。
      lexField("kind", "lex.kind", "lex.kindHint",
        el("input", { type: "text", list: "lexKindsList", className: "nwTextInput", value: lexForm.kind || "",
          onChange: function (ev) { props.controller.setLexiconForm({ kind: ev.target.value }); } })),
      el("datalist", { id: "lexKindsList", key: "lex-kinds" },
        lexKinds.map(function (k) { return el("option", { key: k, value: k }); })),
      RowDivider(el, el, t, NW_UI, { key: "lex-rd5" }),
      lexInput("scene", "lex.scene", "lex.sceneHint", lexForm.scene),
      RowDivider(el, el, t, NW_UI, { key: "lex-rd6" }),
      lexInput("avoid", "lex.avoid", "lex.avoidHint", lexForm.avoid),
      RowDivider(el, el, t, NW_UI, { key: "lex-rd7" }),
      lexInput("note", "lex.note", null, lexForm.note),
      el("div", { key: "lex-formBtns", className: "nwField" },
        el("div", { className: "nwRowText" },
          el("div", { className: "nwRowHint" }, t("lex.scope") + "：" + lexScopeName(lexWriteLayer))),
        el("div", { className: "nwFieldCtl" },
          el("button", { key: "cancel", type: "button", className: "nwBtn nwBtnGhost", onClick: function () { props.controller.lexiconResetForm(); props.controller.set({ lexiconFormOpen: false }, { silent: true }); } }, t("lex.cancelEdit")),
          el("button", { key: "submit", type: "button", className: "nwBtn nwBtnPrimary", disabled: state.lexiconBusy, onClick: function () { props.controller.lexiconSubmitForm(); } },
            lexForm.editing ? t("lex.saveEdit") : t("lex.add"))
        )
      )
    ] })) : null,
    el("div", { className: "nwLexImport" },
      el("button", { type: "button", className: "nwBtn nwBtnGhost", "aria-expanded": !!state.lexiconImportOpen, onClick: function () { props.controller.lexiconToggleImport(); } },
        state.lexiconImportOpen ? t("lex.importClose") : t("lex.importTitle") + " ›"),
      state.lexiconImportOpen ? GroupCard(el, el, t, NW_UI, { children: el("div", { className: "nwLexImportBody" },
        el("div", { className: "nwRowHint" }, t("lex.importHint")),
        el("textarea", { className: "nwTextArea", value: state.lexiconImportText || "", placeholder: t("lex.importPlaceholder"), "aria-label": t("lex.importTitle"),
          onChange: function (ev) { props.controller.setLexiconImport(ev.target.value); } }),
        el("div", { className: "nwLexActions" },
          el("button", { type: "button", className: "nwBtn nwBtnGhost", disabled: state.lexiconBusy, onClick: function () { props.controller.lexiconRunImport(true); } }, t("lex.importReplace")),
          el("button", { type: "button", className: "nwBtn", disabled: state.lexiconBusy, onClick: function () { props.controller.lexiconRunImport(false); } }, t("lex.importMerge")))) }) : null),
    lexCorrupt ? el("div", { className: "nwNote nwNoteWarn" }, t("lex.corruptHint")) : null,
    el("div", { className: "nwRowHint nwLexAudit" }, t("lex.auditTip")),
    el("details", { className: "nwLexAdvanced nwGCard" },
      el("summary", { className: "nwDisclosureTitle" }, t("lex.advanced"), el("span", { className: "nwDisclosureArrow", "aria-hidden": true }, "›")),
      rootRow()),
    StorageDisclosure(el, el, t, NW_UI, { controller: props.controller, revealing: state.revealing, items: lexData ? [
      { label: t("lex.pathLabel"), path: (lexData.files && (lexData.files.book || lexData.files.global)) || lexData.dir || "", revealKey: "lexicon-dir" }
    ] : [{ label: t("lex.pathLabel"), path: dirs.lexiconDir || "", revealKey: "lexicon-dir" }] })
  );
}
