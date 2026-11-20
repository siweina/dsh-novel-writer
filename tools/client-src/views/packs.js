function renderPacksView(vc) {
  var el = vc.el, state = vc.state, props = vc.props, dirs = vc.dirs;
  // v7.5.0 / v7.7.0：外置 JSON 题材规则包工作室（新建/派生/编辑/分享信封/JSON导出导入/按书绑定/删除）
  var packsData = state.packsData;
  var packsList = packsData && Array.isArray(packsData.packs) ? packsData.packs : [];
  var boundPackId = packsData && typeof packsData.boundPackId === "string" ? packsData.boundPackId : "";
  var activePack = packsData && packsData.activePack ? packsData.activePack : null;
  var activePackLabel = activePack ? (activePack.name || activePack.id) : (boundPackId || t("packs.none"));
  var packsBookList = (packsData && Array.isArray(packsData.books) && packsData.books.length > 0 ? packsData.books : (state.books || [])).slice();
  if (state.packsBook && packsBookList.indexOf(state.packsBook) === -1) packsBookList.unshift(state.packsBook);
  var packIssues = [];
  if (packsData) {
    (Array.isArray(packsData.errors) ? packsData.errors : []).forEach(function (errItem) {
      packIssues.push({ label: errItem.id || errItem.file || "", reason: errItem.reason || String(errItem) });
    });
    (Array.isArray(packsData.warnings) ? packsData.warnings : []).forEach(function (warnItem) {
      packIssues.push({ label: warnItem.id || warnItem.file || "", reason: warnItem.reason || String(warnItem) });
    });
    packsList.forEach(function (pk) {
      if (!Array.isArray(pk.rejectedPatterns) || pk.rejectedPatterns.length === 0) return;
      pk.rejectedPatterns.forEach(function (rp) {
        packIssues.push({ label: pk.id || pk.file || "", reason: (rp.pattern || "") + (rp.reason ? " (" + rp.reason + ")" : "") });
      });
    });
  }
  return el("div", { className: "nwPacksPage" },
    el("div", { className: "nwToolsHint" }, t("packs.hint")),
    state.packsMsg ? el("div", { className: "nwNote " + (state.packsErr ? "nwPlotErr" : "nwNoteAccent") }, state.packsMsg) : null,
    GroupCard(el, el, t, NW_UI, { children: [
      PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
        key: "packs-book",
        title: t("packs.bookLabel"),
        summary: !state.packsBook ? t("packs.needBook") : (state.packsBook + " · " + t("packs.activeLabel") + "：" + activePackLabel),
        trailing: el(SelectMenu, {
          id: "packs-book",
          controller: props.controller,
          label: t("packs.bookLabel"),
          value: state.packsBook || "",
          placeholder: t("packs.noBook"),
          disabled: state.packsBusy,
          options: packsBookList.map(function (b) { return { value: b, label: b }; }),
          onChange: function (v) { props.controller.setPacksBook(v); }
        })
      }),
      boundPackId !== "" ? RowDivider(el, el, t, NW_UI, { key: "packs-rd-active" }) : null,
      boundPackId !== "" ? PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
        key: "packs-active",
        icon: "genreTheme",
        title: t("packs.activeLabel") + "：" + activePackLabel,
        summary: activePack && activePack.description ? activePack.description : boundPackId,
        trailing: el("button", {
          type: "button",
          className: "nwBtn nwBtnGhost nwBtnSm",
          disabled: state.packsBusy || !state.packsBook,
          onClick: function () { props.controller.bindPack(""); }
        }, t("packs.unbind"))
      }) : null
    ] }),
    packIssues.length > 0 ? el("div", { key: "packs-warn", className: "nwNote nwNoteWarn nwPacksWarn" },
      el("div", { className: "nwPacksWarnTitle" }, t("packs.issuesTitle")),
      packIssues.map(function (iss, idx) {
        return el("div", { key: "pi-" + idx, className: "nwPacksWarnItem" },
          (iss.label ? "[" + iss.label + "] " : "") + iss.reason);
      })
    ) : null,
    el("div", { className: "nwPacksToolbar" },
      el("button", { type: "button", className: "nwBtn nwBtnPrimary nwBtnSm", disabled: state.packsBusy, onClick: function () { props.controller.openPackEditor({ mode: "new" }); } }, t("packs.newBtn")),
      el("button", { type: "button", className: "nwBtn nwBtnGhost nwBtnSm", disabled: state.packsBusy, onClick: function () { props.controller.openPackImport(); } }, t("packs.importBtn"))
    ),
    SectionTitle(el, el, t, NW_UI, { label: "packs.listTitle" }),
    GroupCard(el, el, t, NW_UI, { children:
      (state.packsBusy && !packsData)
        ? el("div", { className: "nwEmpty" }, el("div", { className: "nwEmptyTitle" }, t("packs.loading")))
        : packsList.length === 0
          ? el("div", { className: "nwEmpty" }, el("div", { className: "nwEmptyTitle" }, t("packs.empty")))
          : packsList.map(function (pk, idx) {
              var isBound = boundPackId !== "" && boundPackId === pk.id;
              var isCustom = pk.source === "custom";
              var sourceLabel = isCustom ? t("packs.custom") : t("packs.builtin");
              var cultureKey = "packs.culture." + (pk.baseCulture || "");
              var cultureLabel = pk.baseCulture ? (t(cultureKey) === cultureKey ? pk.baseCulture : t(cultureKey)) : "";
              var bannedN = Array.isArray(pk.bannedWords) ? pk.bannedWords.length : 0;
              var allowN = Array.isArray(pk.allowWords) ? pk.allowWords.length : 0;
              var rejectedN = Array.isArray(pk.rejectedPatterns) ? pk.rejectedPatterns.length : 0;
              return [
                idx > 0 ? RowDivider(el, el, t, NW_UI, { key: "pkd-" + pk.id }) : null,
                PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
                  key: "pk-" + pk.id,
                  icon: "genreTheme",
                  title: (pk.name || pk.id) + (pk.name && pk.name !== pk.id ? " (" + pk.id + ")" : ""),
                  summary: pk.description || "",
                  bottom: [
                    el("div", { key: "meta", className: "nwPackMeta" },
                      el("span", { className: "nwPackTag" }, sourceLabel),
                      cultureLabel ? el("span", { className: "nwPackTag" }, cultureLabel) : null,
                      pk.extends ? el("span", { className: "nwPackTag" }, t("packs.extendsTag").replace("{id}", pk.extends)) : null,
                      el("span", { className: "nwPackTag" }, t("packs.bannedCount").replace("{n}", String(bannedN))),
                      el("span", { className: "nwPackTag" }, t("packs.allowCount").replace("{n}", String(allowN))),
                      rejectedN > 0 ? el("span", { className: "nwPackTag nwPackTagWarn" }, t("packs.rejectedCount").replace("{n}", String(rejectedN))) : null
                    ),
                    el("div", { key: "actions", className: "nwPackRowActions" },
                      isCustom ? el("button", { key: "edit", type: "button", className: "nwRowAction", disabled: state.packsBusy, onClick: function () { props.controller.openPackEditor({ mode: "edit", packId: pk.id }); } }, t("packs.actionEdit")) : null,
                      el("button", { key: "fork", type: "button", className: "nwRowAction", disabled: state.packsBusy, onClick: function () { props.controller.openPackEditor({ mode: "fork", packId: pk.id }); } }, t("packs.actionFork")),
                      isCustom ? el("button", { key: "share", type: "button", className: "nwRowAction", disabled: state.packsBusy, onClick: function () { props.controller.sharePack(pk.id); } }, t("packs.actionShare")) : null,
                      isCustom ? el("button", { key: "export", type: "button", className: "nwRowAction", disabled: state.packsBusy, onClick: function () { props.controller.exportPackJson(pk.id); } }, t("packs.actionExport")) : null,
                      isCustom ? el("button", { key: "del", type: "button", className: "nwRowAction nwRowActionDanger", disabled: state.packsBusy, onClick: function () { props.controller.openPackDelete(pk.id, pk.name || pk.id); } }, t("packs.actionDelete")) : null
                    )
                  ],
                  trailing: el("button", {
                    type: "button",
                    className: "nwBtn nwBtnGhost nwBtnSm",
                    disabled: state.packsBusy || !state.packsBook || isBound,
                    onClick: function () { props.controller.bindPack(pk.id); }
                  }, isBound ? t("packs.active") : t("packs.bind"))
                })
              ];
            })
    }),
    StorageDisclosure(el, el, t, NW_UI, { controller: props.controller, revealing: state.revealing, items: [
      { label: t("packs.dirLabel"), path: (packsData && packsData.packsDir) || dirs.packsDir || "", revealKey: "packs-dir" }
    ] })
  );
}

function renderPacksFormView(vc) {
  var el = vc.el, state = vc.state, props = vc.props, isEn = vc.isEn;
  var pf = state.packsForm || {
    editing: false, id: "", name: "", description: "", baseCulture: "", extends: "",
    aliasesText: "", bannedLines: "", allowWordsText: "", slopMuteCategories: [],
    titleGuideline: "", toneGuideline: "", ritualGoodNote: "", honorLines: "", ritualPatternsText: ""
  };
  var pDataF = state.packsData;
  var pListF = pDataF && Array.isArray(pDataF.packs) ? pDataF.packs : [];
  var slopCatMap = (pDataF && pDataF.slopCategories && typeof pDataF.slopCategories === "object")
    ? pDataF.slopCategories : defaultSlopCategories(isEn);
  var cultureOpts = [
    { value: "", label: t("packs.culture.none") },
    { value: "eastern", label: t("packs.culture.eastern") },
    { value: "western", label: t("packs.culture.western") },
    { value: "modern", label: t("packs.culture.modern") }
  ];
  if (pf.baseCulture && !cultureOpts.some(function (o) { return o.value === pf.baseCulture; })) {
    cultureOpts.push({ value: pf.baseCulture, label: pf.baseCulture });
  }
  var extendsOpts = [{ value: "", label: t("packs.extendsNone") }];
  pListF.forEach(function (pk) {
    if (pk && pk.id && pk.id !== pf.id) {
      extendsOpts.push({ value: pk.id, label: (pk.name || pk.id) + " (" + pk.id + ")" });
    }
  });
  if (pf.extends && !extendsOpts.some(function (o) { return o.value === pf.extends; })) {
    extendsOpts.push({ value: pf.extends, label: pf.extends });
  }
  var packField = function (key, labelKey, hintKey, control) {
    return el("div", { key: key, className: "nwCreationField" },
      el("label", { className: "nwFieldLabel", htmlFor: "pack-field-" + key }, t(labelKey)),
      hintKey ? el("div", { className: "nwRowHint" }, t(hintKey)) : null,
      control);
  };
  var pfSlopSelected = Array.isArray(pf.slopMuteCategories) ? pf.slopMuteCategories : [];
  return el("div", { className: "nwPacksPage" },
    state.packsMsg ? el("div", { className: "nwNote " + (state.packsErr ? "nwPlotErr" : "nwNoteAccent") }, state.packsMsg) : null,
    SectionTitle(el, el, t, NW_UI, { label: "packs.formSectionBase" }),
    GroupCard(el, el, t, NW_UI, { children: [
      packField("id", "packs.field.id", "packs.field.idHint",
        el("input", { id: "pack-field-id", type: "text", className: "nwTextInput", disabled: pf.editing === true, value: pf.id || "", placeholder: t("packs.field.idPlaceholder"), onChange: function (ev) { props.controller.setPackForm({ id: ev.target.value }); } })),
      RowDivider(el, el, t, NW_UI, { key: "pfd-1" }),
      packField("name", "packs.field.name", null,
        el("input", { id: "pack-field-name", type: "text", className: "nwTextInput", value: pf.name || "", placeholder: t("packs.field.namePlaceholder"), onChange: function (ev) { props.controller.setPackForm({ name: ev.target.value }); } })),
      RowDivider(el, el, t, NW_UI, { key: "pfd-2" }),
      packField("desc", "packs.field.desc", null,
        el("input", { id: "pack-field-desc", type: "text", className: "nwTextInput", value: pf.description || "", placeholder: t("packs.field.descPlaceholder"), onChange: function (ev) { props.controller.setPackForm({ description: ev.target.value }); } })),
      RowDivider(el, el, t, NW_UI, { key: "pfd-3" }),
      PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
        key: "pfd-culture",
        title: t("packs.field.culture"),
        trailing: el(SelectMenu, { id: "packs-form-culture", controller: props.controller, label: t("packs.field.culture"), value: pf.baseCulture || "", options: cultureOpts, onChange: function (v) { props.controller.setPackForm({ baseCulture: v }); } })
      }),
      RowDivider(el, el, t, NW_UI, { key: "pfd-4" }),
      PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
        key: "pfd-extends",
        title: t("packs.field.extends"),
        trailing: el(SelectMenu, { id: "packs-form-extends", controller: props.controller, label: t("packs.field.extends"), value: pf.extends || "", options: extendsOpts, onChange: function (v) { props.controller.setPackForm({ extends: v }); } })
      }),
      RowDivider(el, el, t, NW_UI, { key: "pfd-5" }),
      packField("aliases", "packs.field.aliases", "packs.field.aliasesHint",
        el("input", { id: "pack-field-aliases", type: "text", className: "nwTextInput", value: pf.aliasesText || "", onChange: function (ev) { props.controller.setPackForm({ aliasesText: ev.target.value }); } }))
    ] }),
    SectionTitle(el, el, t, NW_UI, { label: "packs.formSectionRules" }),
    GroupCard(el, el, t, NW_UI, { children: [
      packField("banned", "packs.field.banned", "packs.field.bannedHint",
        el("textarea", { id: "pack-field-banned", className: "nwCreationInput nwTextArea", rows: 4, value: pf.bannedLines || "", placeholder: t("packs.field.bannedPlaceholder"), onChange: function (ev) { props.controller.setPackForm({ bannedLines: ev.target.value }); } })),
      RowDivider(el, el, t, NW_UI, { key: "pfr-1" }),
      packField("allow", "packs.field.allow", "packs.field.allowHint",
        el("textarea", { id: "pack-field-allow", className: "nwCreationInput nwTextArea", rows: 2, value: pf.allowWordsText || "", onChange: function (ev) { props.controller.setPackForm({ allowWordsText: ev.target.value }); } })),
      RowDivider(el, el, t, NW_UI, { key: "pfr-2" }),
      el("div", { key: "slop", className: "nwCreationField" },
        el("div", { className: "nwFieldLabel" }, t("packs.field.slopMute")),
        el("div", { className: "nwPackCheckGrid" }, Object.keys(slopCatMap).map(function (ck) {
          var onCk = pfSlopSelected.indexOf(ck) !== -1;
          return el("label", { key: ck, className: "nwPackCheckItem" },
            el("input", { type: "checkbox", checked: onCk, onChange: function () { props.controller.togglePackFormSlop(ck); } }),
            el("span", null, slopCatMap[ck] || ck));
        })))
    ] }),
    el("details", { className: "nwGCard nwLexAdvanced" },
      el("summary", { className: "nwDisclosureTitle" }, t("packs.formSectionSpeech"), el("span", { className: "nwDisclosureArrow", "aria-hidden": true }, "›")),
      el("div", null,
        packField("titleGuide", "packs.field.titleGuide", null,
          el("input", { id: "pack-field-titleGuide", type: "text", className: "nwTextInput", value: pf.titleGuideline || "", onChange: function (ev) { props.controller.setPackForm({ titleGuideline: ev.target.value }); } })),
        packField("toneGuide", "packs.field.toneGuide", null,
          el("input", { id: "pack-field-toneGuide", type: "text", className: "nwTextInput", value: pf.toneGuideline || "", onChange: function (ev) { props.controller.setPackForm({ toneGuideline: ev.target.value }); } })),
        packField("ritualNote", "packs.field.ritualNote", null,
          el("input", { id: "pack-field-ritualNote", type: "text", className: "nwTextInput", value: pf.ritualGoodNote || "", onChange: function (ev) { props.controller.setPackForm({ ritualGoodNote: ev.target.value }); } })),
        packField("honor", "packs.field.honor", "packs.field.honorHint",
          el("textarea", { id: "pack-field-honor", className: "nwCreationInput nwTextArea", rows: 3, value: pf.honorLines || "", onChange: function (ev) { props.controller.setPackForm({ honorLines: ev.target.value }); } })),
        packField("ritualRegex", "packs.field.ritualRegex", "packs.field.ritualRegexHint",
          el("textarea", { id: "pack-field-ritualRegex", className: "nwCreationInput nwTextArea nwPackCodeArea", rows: 3, value: pf.ritualPatternsText || "", onChange: function (ev) { props.controller.setPackForm({ ritualPatternsText: ev.target.value }); } }))
      )
    ),
    state.packsBook ? el("label", { className: "nwDelAck" },
      el("input", { type: "checkbox", checked: state.packsFormBind === true, onChange: function (ev) { props.controller.set({ packsFormBind: !!(ev && ev.target && ev.target.checked === true) }, { silent: true }); } }),
      el("span", null, t("packs.bindAfterSave").replace("{book}", state.packsBook))) : null,
    el("div", { className: "nwBaseActions" },
      el("button", { key: "save", type: "button", className: "nwBtn nwBtnPrimary", disabled: state.packsBusy, onClick: function () { props.controller.savePackForm(); } }, state.packsBusy ? t("packs.saving") : t("packs.saveBtn")),
      el("button", { key: "share", type: "button", className: "nwBtn nwBtnGhost", disabled: state.packsBusy || !String(pf.id || "").trim(), onClick: function () { props.controller.sharePack(pf); } }, t("packs.actionShare")),
      el("button", { key: "export", type: "button", className: "nwBtn nwBtnGhost", disabled: state.packsBusy || !String(pf.id || "").trim(), onClick: function () { props.controller.exportPackJson(pf); } }, t("packs.actionExport")),
      el("button", { key: "cancel", type: "button", className: "nwBtn nwBtnGhost", onClick: function () { if (state.packsFormDirty && !safeConfirm(t("packs.dirtyWarn"))) return; props.controller.openView("packs"); } }, t("packs.cancel"))
    )
  );
}

function renderPacksImportView(vc) {
  var el = vc.el, state = vc.state, props = vc.props;
  var impPrev = state.packsImportPreview;
  var impPack = impPrev && impPrev.pack ? impPrev.pack : null;
  var pDataI = state.packsData;
  var pListI = pDataI && Array.isArray(pDataI.packs) ? pDataI.packs : [];
  var impIdVal = String(state.packsImportId || "").trim();
  var impIsBuiltin = BUILTIN_PACK_IDS_CLIENT.indexOf(impIdVal) !== -1;
  var impExistsCustom = impIdVal !== "" && pListI.some(function (pk) { return pk && pk.source === "custom" && pk.id === impIdVal; });
  var impPrompts = impPrev && impPrev.promptTexts ? impPrev.promptTexts : {};
  var impPromptEntries = [];
  if (impPrompts.description) impPromptEntries.push(t("packs.field.desc") + "：" + impPrompts.description);
  if (impPrompts.titleGuideline) impPromptEntries.push(t("packs.field.titleGuide") + "：" + impPrompts.titleGuideline);
  if (impPrompts.toneGuideline) impPromptEntries.push(t("packs.field.toneGuide") + "：" + impPrompts.toneGuideline);
  if (impPrompts.ritualGoodNote) impPromptEntries.push(t("packs.field.ritualNote") + "：" + impPrompts.ritualGoodNote);
  var impRejected = impPrev && Array.isArray(impPrev.rejectedPatterns) ? impPrev.rejectedPatterns : [];
  var impCanSave = Boolean(impPack) && !state.packsImportBusy && impIdVal !== "" && !impIsBuiltin && (!impExistsCustom || state.packsImportOverwrite === true);
  return el("div", { className: "nwPacksPage" },
    el("div", { className: "nwToolsHint" }, t("packs.importHint")),
    state.packsImportMsg ? el("div", { className: "nwNote " + (state.packsImportErr ? "nwPlotErr" : "nwNoteAccent") }, state.packsImportMsg) : null,
    GroupCard(el, el, t, NW_UI, { children: el("div", { className: "nwPackPreviewBox" },
      el("div", { className: "nwPacksToolbar" },
        el("label", { className: "nwBtn nwBtnGhost nwBtnSm nwFileLabel" },
          t("packs.pickFile"),
          el("input", {
            type: "file",
            accept: ".json,application/json,text/plain",
            className: "nwFileHidden",
            onChange: function (ev) {
              var fItem = ev && ev.target && ev.target.files && ev.target.files[0];
              if (fItem) props.controller.readPackImportFile(fItem);
              try { ev.target.value = ""; } catch (e) {}
            }
          })
        ),
        state.packsImportText !== "" ? el("button", { type: "button", className: "nwBtn nwBtnGhost nwBtnSm", disabled: state.packsImportBusy, onClick: function () { props.controller.setPackImportText("", ""); } }, t("packs.clearImport")) : null,
        state.packsImportFileName ? el("span", { className: "nwPackTag" }, state.packsImportFileName) : null
      ),
      el("textarea", {
        className: "nwTextArea nwPackCodeArea",
        rows: 6,
        value: state.packsImportText || "",
        placeholder: t("packs.importPlaceholder"),
        "aria-label": t("packs.importTitle"),
        onChange: function (ev) { props.controller.setPackImportText(ev.target.value); }
      }),
      el("div", { className: "nwBaseActions" },
        el("button", {
          type: "button",
          className: "nwBtn " + (impPack ? "nwBtnGhost" : "nwBtnPrimary"),
          disabled: state.packsImportBusy || !String(state.packsImportText || "").trim(),
          onClick: function () { props.controller.previewPackImport(); }
        }, state.packsImportBusy ? t("packs.previewing") : t("packs.previewBtn"))
      )
    ) }),
    impPack ? GroupCard(el, el, t, NW_UI, { children: el("div", { className: "nwPackPreviewBox" },
      el("div", { className: "nwNote nwNoteAccent" }, t("packs.previewOkTitle")),
      el("div", { className: "nwPackMeta" },
        el("span", { className: "nwPackTag" }, (impPack.name || impPack.id) + " (" + impPack.id + ")"),
        impPack.baseCulture ? el("span", { className: "nwPackTag" }, t("packs.culture." + impPack.baseCulture) === "packs.culture." + impPack.baseCulture ? impPack.baseCulture : t("packs.culture." + impPack.baseCulture)) : null,
        impPack.extends ? el("span", { className: "nwPackTag" }, t("packs.extendsTag").replace("{id}", impPack.extends)) : null,
        el("span", { className: "nwPackTag" }, t("packs.bannedCount").replace("{n}", String(Array.isArray(impPack.bannedWords) ? impPack.bannedWords.length : 0))),
        el("span", { className: "nwPackTag" }, t("packs.allowCount").replace("{n}", String(Array.isArray(impPack.allowWords) ? impPack.allowWords.length : 0))),
        impRejected.length > 0 ? el("span", { className: "nwPackTag nwPackTagWarn" }, t("packs.rejectedCount").replace("{n}", String(impRejected.length))) : null
      ),
      el("div", { className: "nwPackPromptCheck" },
        el("div", { className: "nwPacksWarnTitle" }, t("packs.promptCheckTitle")),
        impPromptEntries.length > 0
          ? impPromptEntries.map(function (line, i) { return el("div", { key: "pt-" + i, className: "nwPacksWarnItem" }, line); })
          : el("div", { className: "nwPacksWarnItem" }, t("packs.promptEmpty"))
      ),
      impRejected.length > 0 ? el("div", { className: "nwNote nwNoteWarn nwPacksWarn" },
        el("div", { className: "nwPacksWarnTitle" }, t("packs.previewRegexWarn").replace("{n}", String(impRejected.length))),
        impRejected.map(function (rp, i) {
          return el("div", { key: "ir-" + i, className: "nwPacksWarnItem" }, (rp.pattern || "") + (rp.reason ? " (" + rp.reason + ")" : ""));
        })
      ) : null,
      (impPrev.extendsInfo && impPrev.extendsInfo.missing)
        ? el("div", { className: "nwNote nwNoteWarn" }, t("packs.previewExtendsMissing").replace("{target}", impPrev.extendsInfo.target))
        : null,
      el("div", { className: "nwCreationField" },
        el("label", { className: "nwFieldLabel", htmlFor: "pack-import-id" }, t("packs.saveAsId")),
        el("input", {
          id: "pack-import-id",
          type: "text",
          className: "nwTextInput",
          value: state.packsImportId || "",
          onChange: function (ev) { props.controller.set({ packsImportId: ev.target.value, packsImportOverwrite: false }, { silent: true }); }
        })
      ),
      impIsBuiltin ? el("div", { className: "nwNote nwPlotErr" }, t("packs.conflictBuiltin").replace("{id}", impIdVal)) : null,
      (!impIsBuiltin && impExistsCustom) ? el("div", null,
        el("div", { className: "nwNote nwNoteWarn" }, t("packs.conflictCustom").replace("{id}", impIdVal)),
        el("label", { className: "nwDelAck" },
          el("input", { type: "checkbox", checked: state.packsImportOverwrite === true, onChange: function (ev) { props.controller.set({ packsImportOverwrite: !!(ev && ev.target && ev.target.checked === true) }, { silent: true }); } }),
          el("span", null, t("packs.overwriteCheck").replace("{id}", impIdVal)))
      ) : null,
      state.packsBook ? el("label", { className: "nwDelAck" },
        el("input", { type: "checkbox", checked: state.packsImportBind === true, onChange: function (ev) { props.controller.set({ packsImportBind: !!(ev && ev.target && ev.target.checked === true) }, { silent: true }); } }),
        el("span", null, t("packs.bindAfterSave").replace("{book}", state.packsBook))) : null,
      el("div", { className: "nwBaseActions" },
        el("button", {
          type: "button",
          className: "nwBtn nwBtnPrimary",
          disabled: !impCanSave,
          onClick: function () { props.controller.confirmPackImport(); }
        }, state.packsImportBusy ? t("packs.saving") : t("packs.confirmImportBtn"))
      )
    ) }) : null
  );
}
