function renderCreationView(vc) {
  var el = vc.el, state = vc.state, props = vc.props, dirs = vc.dirs;
  // v3.1.0：原创模式设定库（方案 C：列表页 + 表单页 + 快速切换）
  var CREATION_FIELDS = [
    ["worldview", "", t("creation.worldview"), t("ph.e末")],
    ["characters", "", t("creation.characters"), t("ph.e女")],
    ["forbidden", "", t("creation.forbidden"), t("ph.e不")],
    ["mainConflict", "", t("creation.mainConflict"), t("ph.e主")],
    ["genre", "", t("creation.genre"), t("ph.e悬")],
    ["extra", "", t("creation.extra"), t("ph.e每")]
  ];
  var cpGlobal = state.creationProfile && typeof state.creationProfile === "object" ? state.creationProfile : {};
  var cpBooks = state.creationProfiles && typeof state.creationProfiles === "object" ? state.creationProfiles : {};
  var bookList = Array.isArray(state.books) ? state.books.slice() : [];
  // 合并：设定库条目 ∪ novels 目录（去重，默认放最前）
  var allBooks = [];
  for (var bi2 = 0; bi2 < bookList.length; bi2 += 1) if (allBooks.indexOf(bookList[bi2]) === -1) allBooks.push(bookList[bi2]);
  for (var bk2 in cpBooks) if (allBooks.indexOf(bk2) === -1) allBooks.push(bk2);
  allBooks.sort(function (a, b) { return a.localeCompare(b, "zh"); });

  function profileOf(bookName) {
    if (!bookName || bookName === "") return cpGlobal;
    return cpBooks[bookName] && typeof cpBooks[bookName] === "object" ? cpBooks[bookName] : {};
  }
  function filledCount(profile) {
    var c = 0;
    for (var fi = 0; fi < CREATION_FIELDS.length; fi += 1) {
      var fk = CREATION_FIELDS[fi][0];
      if (typeof profile[fk] === "string" && profile[fk].trim()) c += 1;
    }
    return c;
  }
  function summaryOf(profile) {
    var c = filledCount(profile);
    if (c === 0) return t("creation.none");
    return String(t("creation.filled")).replace("{n}", String(c));
  }
  // ---- 列表页 ----
  if (vc.view === "creation") {
    var newBookName = state.creationNewBook || "";
    var createNewBook = function () {
      var nb = String(newBookName || "").trim();
      // v3.5.0 #49：客户端校验——路径分隔符/Windows 保留字符直接提示
      if (nb && (/[\\/:*?"<>|]/.test(nb) || /[.\s]+$/.test(nb) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(nb))) {
        props.controller.set({ revealMsg: t("creation.badName"), revealErr: true }, { silent: true });
        return;
      }
      if (!nb) {
        // v6.3.0 修复：此处原先用 classList.add("nwInputErr") 打红框，但全文件没有任何移除点——
        // 用户随后输入合法书名时红框仍在（提示已消失、错误态还在）。改为状态驱动：
        // 红框由 creationNameBad 决定，输入即清除。
        props.controller.set({ revealMsg: t("creation.needName"), revealErr: true, creationNameBad: true }, { silent: true });
        var elInp = document.getElementById("nwNewBookInput");
        if (elInp) elInp.focus();
        return;
      }
      // v4.3.0：先 openView 再写提示——openView 会无条件清空 revealMsg（silent），
      // 旧顺序下"已创建设定，开始填写"在同一 tick 被清掉，用户永远看不到
      props.controller.openView("creation-form");
      props.controller.set({ creationNewBook: "", creationBook: nb, creationDraft: null, creationDirty: false, creationNameBad: false, revealMsg: t("creation.newed"), revealErr: false }, { silent: true });
    };
    function bookRow(name, profile, isDefault, hasProfile) {
      return PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
        key: "bk-" + name,
        title: isDefault ? t("creation.default") : name,
        summary: summaryOf(profile),
        bottom: isDefault ? t("creation.defaultHint") : null,
        trailing: el("div", { className: "nwBtnGroup" },
          (isDefault || !hasProfile) ? null : el("button", { type: "button", className: "nwBtn nwBtnGhost nwBtnSm nwBtnDangerText", disabled: state.loading, onClick: function () { if (state.loading) return; if (!safeConfirm(t("creation.confirmDelete"))) return; var patch = {}; patch[name] = null; props.toggle({ creationProfiles: patch }); props.controller.set({ revealMsg: t("creation.deleted"), revealErr: false }, { silent: true }); } }, t("creation.delete")),
          el("button", { type: "button", className: "nwChip", onClick: function () { props.controller.set({ creationBook: name, creationDraft: null, creationDirty: false }, { silent: true }); props.controller.openView("creation-form"); } }, t("creation.edit") + " ›"))
      });
    }
    var creationRows = [bookRow("", cpGlobal, true)];
    allBooks.forEach(function (name, i) {
      creationRows.push(RowDivider(el, el, t, NW_UI, { key: "creation-div-" + i }));
      creationRows.push(bookRow(name, profileOf(name), false, Object.prototype.hasOwnProperty.call(cpBooks, name)));
    });
    return el("div", { className: "nwCreationPage" },
      el("div", { className: "nwToolsHint" }, t("creation.desc2")),
      el("div", { className: "nwCreationNew" },
        el("input", { id: "nwNewBookInput", type: "text", value: newBookName, placeholder: t("creation.newPlaceholder"), "aria-label": t("creation.newPlaceholder"), className: "nwTextInput" + (state.creationNameBad ? " nwInputErr" : ""), onChange: function (ev) { props.controller.set({ creationNewBook: ev.target.value, creationNameBad: false }, { silent: true }); }, onKeyDown: function (ev) { if (ev.key === "Enter") { ev.preventDefault(); createNewBook(); } } }),
        el("button", { type: "button", className: "nwBtn nwBtnPrimary", onClick: createNewBook }, t("creation.new"))),
      GroupCard(el, el, t, NW_UI, { children: creationRows }),
      StorageDisclosure(el, el, t, NW_UI, { controller: props.controller, revealing: state.revealing, items: [
        { label: t("creation.pathLabel"), path: dirs.stateFile || state.file || "", revealKey: "state-file" }
      ] })
    );
  }
  // ---- 表单页 ----
  var curBook = state.creationBook || "";
  var curProfile = profileOf(curBook);
  var formDraft = state.creationDraft;
  if (!formDraft) {
    formDraft = {};
    for (var ci3 = 0; ci3 < CREATION_FIELDS.length; ci3 += 1) {
      var cf3 = CREATION_FIELDS[ci3][0];
      formDraft[cf3] = typeof curProfile[cf3] === "string" ? curProfile[cf3] : "";
    }
  }
  function setFormDraft(field, value) {
    var next = {};
    for (var k3 in formDraft) next[k3] = formDraft[k3];
    next[field] = value;
    props.controller.set({ creationDraft: next, creationDirty: true }, { silent: true });
  }
  function saveForm() {
    if (state.loading) return;
    var profile = {};
    var any = false;
    for (var si3 = 0; si3 < CREATION_FIELDS.length; si3 += 1) {
      var sk3 = CREATION_FIELDS[si3][0];
      var sv3 = String(formDraft[sk3] || "").trim();
      if (sv3 !== "") { profile[sk3] = sv3; any = true; }
    }
    if (!curBook) {
      props.toggle({ creationProfile: any ? profile : null });
    } else {
      var patch2 = {};
      patch2[curBook] = any ? profile : null;
      props.toggle({ creationProfiles: patch2 });
    }
    props.controller.set({ creationDraft: null, creationDirty: false, revealMsg: t(any ? "creation.saved" : "creation.cleared"), revealErr: false }, { silent: true });
  }
  function clearForm() {
    if (state.loading) return;
    if (!safeConfirm(t("creation.confirmClear"))) return;
    if (!curBook) { props.toggle({ creationProfile: null }); }
    else { var p3 = {}; p3[curBook] = null; props.toggle({ creationProfiles: p3 }); }
    props.controller.set({ creationDraft: null, creationDirty: false, revealMsg: t("creation.cleared"), revealErr: false }, { silent: true });
  }
  function switchBook(newName) {
    if (state.creationDirty && newName !== curBook) {
      // v4.3.0：取消分支此前直接 return，没有任何 state 变更 → 受控 <select> 不重渲染，
      // DOM 停在用户选的 B 而 state.creationBook 仍是 A，之后保存会把设定写进另一本书。
      // 这里显式触发一次同步（空 patch + silent），让 React 把 select 的 value 拉回 A。
      if (!safeConfirm(t("creation.dirtyWarn"))) {
        props.controller.set({}, { silent: true });
        return;
      }
    }
    props.controller.set({ creationBook: newName, creationDraft: null, creationDirty: false }, { silent: true });
  }
  var switchOpts = [{ value: "", label: t("creation.default") }];
  for (var si4 = 0; si4 < allBooks.length; si4 += 1) {
    var bn = allBooks[si4];
    switchOpts.push({ value: bn, label: bn });
  }
  // v4.0.0 修正：新建书尚未保存时不在 allBooks 中，需临时补进下拉——否则受控选择器显示不出当前正在编辑的书
  if (curBook !== "" && allBooks.indexOf(curBook) === -1) {
    switchOpts.push({ value: curBook, label: curBook });
  }
  return el("div", { className: "nwCreationPage" },
    el("button", { type: "button", className: "nwCreationBack", onClick: function () {
      if (state.creationDirty && !safeConfirm(t("creation.dirtyWarn"))) return;
      props.controller.openView("creation");
    } }, "‹ " + t("panel.creationTitle")),
    GroupCard(el, el, t, NW_UI, { children: PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
      key: "creation-current", title: t("creation.bookFor"), summary: t("creation.bookHint"),
      trailing: el(SelectMenu, { id: "creation-book", controller: props.controller, label: t("creation.bookFor"), value: curBook, options: switchOpts, onChange: function (v) { switchBook(v); } })
    }) }),
    GroupCard(el, el, t, NW_UI, { children: CREATION_FIELDS.map(function (item) {
      var cf4 = item[0];
      return el("div", { key: cf4, className: "nwCreationField" },
        el("label", { className: "nwFieldLabel", htmlFor: "creation-" + cf4 }, item[2]),
        el("div", { id: "creation-help-" + cf4, className: "nwRowHint" }, t("creation.help." + cf4)),
        el("textarea", { id: "creation-" + cf4, "aria-describedby": "creation-help-" + cf4, className: "nwCreationInput nwTextArea", value: formDraft[cf4] || "", rows: 2, placeholder: item[3], onChange: function (ev) { setFormDraft(cf4, ev.target.value); } }));
    }) }),
    el("div", { className: "nwCreationActions" },
      el("button", { type: "button", className: "nwBtn nwBtnPrimary", disabled: state.loading, onClick: saveForm }, t("creation.save")),
      el("button", { type: "button", className: "nwBtn nwBtnGhost", disabled: state.loading, onClick: clearForm }, t("creation.clear")))
  );
}
