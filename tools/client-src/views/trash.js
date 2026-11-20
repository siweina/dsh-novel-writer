function renderTrashView(vc) {
  var el = vc.el, state = vc.state, props = vc.props, isEn = vc.isEn, entry = vc.entry;
  // v6.8.1：删书入口从「藏在书库折叠区里的按钮」改成**首页第一分区的一行 + 独立页面**。
  // 用户实测在折叠区里根本找不到入口，所以页面顺序就按操作顺序排：选书 → 看清清单 → 勾选执行；
  // 页面下方常驻回收站（恢复 / 彻底删除），不用再记"回收站在哪个分区里"。
  var trashChars = function (n) {
    var v = Number(n) || 0;
    if (!isEn) return v >= 10000 ? (v / 10000).toFixed(1) + "万" : String(v);
    if (v >= 1000000) return (v / 1000000).toFixed(1) + "M";
    if (v >= 1000) return (v / 1000).toFixed(1) + "k";
    return String(v);
  };
  var trashEntries = Array.isArray(state.trashList) ? state.trashList : [];
  var trashBody = [];
  if (state.trashLoading) trashBody.push(el("div", { key: "tl", className: "nwCardHint" }, t("trash.loading")));
  if (state.trashError) trashBody.push(el("div", { key: "te", className: "nwCardHint nwWarnText" }, String(t("trash.loadFail")).replace("{err}", state.trashError)));
  if (state.trashNote) trashBody.push(el("div", { key: "tn", className: "nwCardHint" }, state.trashNote));
  if (!state.trashLoading && !state.trashError && trashEntries.length === 0) trashBody.push(el("div", { key: "empty", className: "nwCardHint" }, t("trash.empty")));
  // #1 修复：旧实现用 `for (var ti...) { var trashItem = ... }`，var 是函数级作用域，
  // 所有行的 onClick 共享同一个 trashItem，循环结束后恒指向最后一条——点任意行都作用在最后一条
  // （「彻底删除」尤其危险）。改用 map：回调参数天然按项独立，每行绑定自己的 id。
  var trashRows = trashEntries.map(function (trashItem, trashIndex) {
    var trashMeta = String(t("trash.line")).replace("{files}", String(trashItem.files)).replace("{size}", formatSize(trashItem.bytes));
    if (trashItem.restorable !== true) trashMeta += " · " + t("trash.noManifest");
    return [
      trashIndex > 0 ? RowDivider(el, el, t, NW_UI, { key: "rd-trash-" + trashItem.id }) : null,
      PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
        key: trashItem.id,
        icon: "trash",
        title: trashItem.book === "" ? trashItem.id : trashItem.book,
        summary: trashMeta,
        trailing: el("div", { className: "nwFeatureActions" },
          el("button", { key: "restore", type: "button", className: "nwRowAction", disabled: state.trashBusyId !== "" || trashItem.restorable !== true, onClick: function () { props.controller.trashRestore(trashItem.id); } }, t("trash.restore")),
          el("button", { key: "purge", type: "button", className: "nwRowAction nwRowActionDanger", disabled: state.trashBusyId !== "", onClick: function () { props.controller.trashPurge(trashItem.id, trashItem.book); } }, t("trash.purge")))
      })
    ];
  });
  for (var tri = 0; tri < trashRows.length; tri += 1) {
    if (trashRows[tri][0] !== null) trashBody.push(trashRows[tri][0]);
    trashBody.push(trashRows[tri][1]);
  }
  var pickChildren = [];
  if (state.delBook !== "") {
    // 与全站一致：一行 = 图标 + 标题 + 副标题 + 右侧动作（此前自造的行样式，文字顶到卡片边缘，明显不像同一套 UI）
    pickChildren.push(PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
      key: "del-head",
      icon: "trash",
      title: "《" + state.delBook + "》",
      summary: state.delResult
        ? t("del.done").replace("{moved}", String(state.delResult.moved || 0))
        : t("del.selCount").replace("{n}", String(deleteSelectedCount(state))).replace("{m}", String((state.delPlan && Array.isArray(state.delPlan.targets) ? state.delPlan.targets.filter(function (x) { return x.exists && x.files > 0; }).length : 0))),
      trailing: el("button", { key: "back", type: "button", className: "nwRowAction", onClick: function () { props.controller.deleteClose(); } }, t("del.pickBack"))
    }));
    pickChildren.push(RowDivider(el, el, t, NW_UI, { key: "rd-del-head" }));
    pickChildren.push(el("div", { key: "block", className: "nwPageBlock" }, renderDeleteBlockRows(vc)));
    // 动作行也要 16px 内边距（nwBaseActions 只给上下 margin，直接放在卡片里会贴到右边缘）
    pickChildren.push(el("div", { key: "actions", className: "nwBaseActions nwPageBlock" },
      state.delResult
        ? el("button", { key: "close", type: "button", className: "nwBtn", onClick: function () { props.controller.deleteClose(); } }, t("del.close"))
        : null,
      state.delResult
        ? null
        : el("button", { key: "ok", type: "button", className: "nwBtn nwBtnDanger", disabled: !deleteCanApply(state), onClick: function () { props.controller.deleteApply(); } }, state.delBusy ? t("del.busy") : t("del.confirm")),
      state.delResult
        ? null
        : el("button", { key: "cancel", type: "button", className: "nwBtn nwBtnGhost", onClick: function () { props.controller.deleteClose(); } }, t("del.cancel"))));
  } else {
    var pickRows = (Array.isArray(state.booksStats) ? state.booksStats : []).map(function (book, index) {
      return [
        index === 0 ? null : RowDivider(el, el, t, NW_UI, { key: "rd-book-" + book.name }),
        PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
          key: book.name,
          icon: "toolBooks",
          title: book.name,
          summary: book.chapters + " " + t("stats.chapters") + " · " + trashChars(book.chars) + t("stats.chars"),
          trailing: el("button", { key: "del", type: "button", className: "nwRowAction nwRowActionDanger", onClick: function () { props.controller.deletePick(book.name); } }, t("del.entry"))
        })
      ];
    });
    pickChildren.push(el("div", { key: "pick-hint", className: "nwCardHint" }, t("del.pickHint")));
    // 首帧 booksStats 还是 null（宿主还没回）——此时说"没有书"是错的，要说"正在读取"
    if (state.booksStats === null) pickChildren.push(el("div", { key: "pick-pending", className: "nwCardHint" }, t("stats.pending")));
    else if (pickRows.length === 0) pickChildren.push(el("div", { key: "pick-none", className: "nwCardHint" }, t("del.noBooks")));
    else pickChildren = pickChildren.concat(pickRows.reduce(function (acc, pair) { return acc.concat(pair[0] === null ? [pair[1]] : pair); }, []));
  }
  return el("div", null,
    el("div", { className: "nwSection" },
      SectionTitle(el, el, t, NW_UI, { label: state.delBook !== "" ? "del.sectionPreview" : "del.sectionPick" }),
      GroupCard(el, el, t, NW_UI, { children: pickChildren })),
    el("div", { className: "nwSection" },
      SectionTitle(el, el, t, NW_UI, { label: "trash.entry" }),
      GroupCard(el, el, t, NW_UI, { children: trashBody })));
}
