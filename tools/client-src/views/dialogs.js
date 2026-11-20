function renderPanelDialog(vc) {
  var el = vc.el, state = vc.state, props = vc.props;
  // 非净化模式弹窗（确认 + 倒计时 / 承诺输入）
  if (state.rawModal) {
    return DialogCard(el, el, t, NW_UI, {
      title: t("raw.confirmTitle"),
      description: t("raw.confirmText"),
      footer: [
        el("button", { key: "ok", type: "button", className: "nwBtn", disabled: state.rawCountdown > 0, onClick: function () { props.controller.rawConfirm(); } },
          state.rawCountdown > 0 ? t("raw.confirmWait") + " (" + state.rawCountdown + "s)" : t("raw.confirmOk")),
        el("button", { key: "cancel", type: "button", className: "nwBtn", onClick: function () { props.controller.rawCancel(); } }, t("raw.cancel"))
      ]
    });
  }
  if (state.rawPromiseOpen) {
    return DialogCard(el, el, t, NW_UI, {
      title: t("raw.promiseTitle"),
      description: t("raw.promiseText"),
      children: el("input", { key: "promise", type: "text", className: "nwModalInput", value: state.rawPromiseText || "", placeholder: t("raw.promisePlaceholder"), onChange: function (e) { props.controller.rawSetPromise(e.target.value); } }),
      footer: [
        el("button", { key: "ok", type: "button", className: "nwBtn" + (state.rawPromiseOk ? " nwBtnDanger" : ""), disabled: !state.rawPromiseOk, onClick: function () { props.controller.rawPromiseConfirm(); } }, t("raw.promiseOk")),
        el("button", { key: "cancel", type: "button", className: "nwBtn", onClick: function () { props.controller.rawCancel(); } }, t("raw.cancel"))
      ]
    });
  }
  if (state.delOpen) {
    // 书库行上的快捷入口：内容与独立删除页完全同源（renderDeleteBlockRows / deleteCanApply）
    return DialogCard(el, el, t, NW_UI, {
      title: t("del.title"),
      description: state.delBook === "" ? "" : "《" + state.delBook + "》",
      children: renderDeleteBlockRows(vc),
      footer: state.delResult
        ? [el("button", { key: "close", type: "button", className: "nwBtn", onClick: function () { props.controller.deleteClose(); } }, t("del.close"))]
        : [
            el("button", { key: "ok", type: "button", className: "nwBtn nwBtnDanger", disabled: !deleteCanApply(state), onClick: function () { props.controller.deleteApply(); } }, state.delBusy ? t("del.busy") : t("del.confirm")),
            el("button", { key: "cancel", type: "button", className: "nwBtn", onClick: function () { props.controller.deleteClose(); } }, t("del.cancel"))
          ]
    });
  }
  if (state.purgeOpen) {
    var purgeTarget = String(state.purgeBook || state.purgeId || "");
    var purgePh = String(t("trash.purgePlaceholder")).replace("{target}", purgeTarget);
    return DialogCard(el, el, t, NW_UI, {
      title: t("trash.purgeTitle"),
      description: String(t("trash.purgeDesc")).replace("{target}", purgeTarget).replace("{id}", String(state.purgeId || "")),
      children: el("input", {
        key: "purge-confirm",
        type: "text",
        className: "nwModalInput",
        value: state.purgeText || "",
        placeholder: purgePh,
        "aria-label": purgePh,
        onChange: function (e) { props.controller.trashPurgeSetText(e.target.value); }
      }),
      footer: [
        el("button", { key: "ok", type: "button", className: "nwBtn" + (state.purgeOk ? " nwBtnDanger" : ""), disabled: !state.purgeOk || state.trashBusyId !== "", onClick: function () { props.controller.trashPurgeConfirm(); } }, t("trash.purgeConfirm")),
        el("button", { key: "cancel", type: "button", className: "nwBtn", onClick: function () { props.controller.trashPurgeCancel(); } }, t("del.cancel"))
      ]
    });
  }
  if (state.packShareOpen) {
    return DialogCard(el, el, t, NW_UI, {
      title: t("packs.shareTitle"),
      description: t("packs.shareDesc"),
      children: el("textarea", {
        key: "pack-share-text",
        className: "nwTextArea nwPackCodeArea",
        readOnly: true,
        rows: 8,
        value: state.packShareText || "",
        "aria-label": t("packs.shareTitle")
      }),
      footer: [
        el("button", { key: "export", type: "button", className: "nwBtn", onClick: function () {
          var expTarget = (state.packsForm && String(state.packsForm.id || "").trim() === state.packShareId)
            ? state.packsForm
            : (state.packShareJson ? (function () { try { return JSON.parse(state.packShareJson); } catch (e) { return state.packShareId; } })() : state.packShareId);
          props.controller.exportPackJson(expTarget);
        } }, t("packs.actionExport")),
        el("button", { key: "close", type: "button", className: "nwBtn nwBtnPrimary", onClick: function () { props.controller.closePackShare(); } }, t("packs.close"))
      ]
    });
  }
  if (state.packDeleteOpen) {
    return DialogCard(el, el, t, NW_UI, {
      title: t("packs.deleteTitle"),
      description: String(t("packs.deleteDesc")).replace("{name}", String(state.packDeleteName || state.packDeleteId || "")).replace("{id}", String(state.packDeleteId || "")),
      footer: [
        el("button", { key: "ok", type: "button", className: "nwBtn nwBtnDanger", disabled: state.packsBusy, onClick: function () { props.controller.confirmPackDelete(); } }, t("packs.deleteConfirm")),
        el("button", { key: "cancel", type: "button", className: "nwBtn", onClick: function () { props.controller.cancelPackDelete(); } }, t("packs.cancel"))
      ]
    });
  }
  return null;
}
