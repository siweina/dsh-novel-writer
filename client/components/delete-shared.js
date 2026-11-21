/**
 * v6.8.1：删除的「预览 / 执行结果」区块 —— **弹窗与独立删除页共用同一份**。
 * 为什么抽出来：v6.8.0 只把它放在弹窗里，进场藏在书库折叠区的按钮后面，用户实测找不到；
 * 改成独立页面后若两处各写一份，「勾选才可点」「失败项怎么显示」这些判断迟早分叉。
 */
function renderDeleteBlockRows(vc) {
  var el = vc.el, state = vc.state, props = vc.props;
  var fill = function (key, map) {
    var text = String(t(key));
    Object.keys(map).forEach(function (token) { text = text.split("{" + token + "}").join(map[token]); });
    return text;
  };
  var row = function (key, label, meta) {
    return el("div", { key: key, className: "nwDelRow" },
      el("div", { className: "nwDelRowLabel" }, label),
      meta === null || meta === void 0 ? null : el("div", { className: "nwDelRowMeta" }, meta));
  };
  var rows = [];
  if (state.delLoading) rows.push(el("div", { key: "loading", className: "nwMuted" }, t("del.loading")));
  if (state.delError) rows.push(el("div", { key: "error", className: "nwNote nwNoteWarn" }, fill("del.loadFail", { err: state.delError })));
  if (state.delResult) {
    var dr = state.delResult;
    rows.push(el("div", { key: "done", className: "nwMuted" }, fill("del.done", { moved: String(dr.moved || 0) })));
    rows.push(el("div", { key: "size", className: "nwMuted" }, fill("trash.line", { files: String(dr.totals?.files ?? 0), size: formatSize(dr.totals?.bytes ?? 0) })));
    if ((dr.failed || []).length > 0) {
      rows.push(el("div", { key: "failed", className: "nwNote nwNoteWarn" }, fill("del.failed", { n: String(dr.failed.length) })));
      rows.push(el("div", { key: "flist", className: "nwDelList" }, dr.failed.map(function (f, i) {
        return row("f" + i, f.path, f.error);
      })));
    }
    if (!dr.partial && (dr.remaining && dr.remaining.files > 0)) rows.push(el("div", { key: "remain", className: "nwNote nwNoteWarn" }, fill("del.remaining", { n: String(dr.remaining.files) })));
    if (dr.trashDir) rows.push(el("div", { key: "dir", className: "nwDelPath" }, dr.trashDir));
    rows.push(el("div", { key: "hint", className: "nwNote" }, t("del.hint")));
  } else if (state.delPlan) {
    var plan = state.delPlan;
    if (plan.blocked) {
      rows.push(el("div", { key: "blocked", className: "nwNote nwNoteWarn" }, plan.blockedReason));
    } else if (!plan.found) {
      rows.push(el("div", { key: "none", className: "nwMuted" }, t("del.none")));
    } else {
      // v6.8.0 选择性清理：每处位置一个勾选框（默认全选）。取消掉正文与创作资料，
      // 只留报告/缓存，就是「只删这一类数据」——不需要第二个工具、第二条链路。
      var pickable = (plan.targets || []).filter(isPickableDeleteTarget);
      var sel = state.delSel || {};
      var selCount = pickable.filter(function (target) { return sel[target.key] === true; }).length;
      var selFiles = 0;
      var selBytes = 0;
      pickable.forEach(function (target) {
        if (sel[target.key] !== true) return;
        selFiles += Number(target.files) || 0;
        selBytes += Number(target.bytes) || 0;
      });
      rows.push(el("div", { key: "total", className: "nwMuted" }, fill("del.total", { files: String(selFiles), size: formatSize(selBytes) })));
      rows.push(el("div", { key: "selline", className: "nwMuted" }, fill("del.selCount", { n: String(selCount), m: String(pickable.length) })));
      rows.push(el("div", { key: "list", className: "nwDelList" }, pickable.map(function (target) {
        var on = sel[target.key] === true;
        return el("label", { key: target.key, className: "nwDelRow nwDelRowPick" },
          el("input", {
            type: "checkbox",
            checked: on,
            disabled: state.delBusy,
            onChange: function (event) { props.controller.deleteToggleKey(target.key, !!(event && event.target && event.target.checked === true)); }
          }),
          el("div", { className: "nwDelRowLabel" }, target.label),
          el("div", { className: "nwDelRowMeta" }, fill("trash.line", { files: String(target.files), size: formatSize(target.bytes) })));
      })));
      rows.push(el("div", { key: "selactions", className: "nwDelSelActions" },
        el("button", { key: "all", type: "button", className: "nwRowAction", onClick: function () { props.controller.deleteSelectAll(true); } }, t("del.selectAll")),
        el("button", { key: "none", type: "button", className: "nwRowAction", onClick: function () { props.controller.deleteSelectAll(false); } }, t("del.selectNone"))));
      rows.push(el("div", { key: "untouched", className: "nwMuted" }, fill("del.notTouched", { list: (plan.notTouched || []).join("；") })));
      for (var wi = 0; wi < (plan.warnings || []).length; wi += 1) {
        rows.push(el("div", { key: "w" + wi, className: "nwNote nwNoteWarn" }, plan.warnings[wi]));
      }
      rows.push(el("div", { key: "hint", className: "nwNote" }, t("del.hint")));
      rows.push(el("label", { key: "ack", className: "nwDelAck" },
        el("input", {
          type: "checkbox",
          checked: state.delAck === true,
          disabled: state.delBusy || selCount === 0,
          onChange: function (event) { props.controller.deleteAck(!!(event && event.target && event.target.checked === true)); }
        }),
        el("span", null, fill("del.ack", { book: state.delBook, n: String(selCount) }))));
    }
  }
  return rows;
}
/** 「勾选后才能点」的唯一判定（弹窗与页面共用，避免两处口径漂移） */
function deleteCanApply(state) {
  var sel = state.delSel || {};
  var any = Object.keys(sel).some(function (k) { return sel[k] === true; });
  return any && state.delAck === true && !state.delBusy && !state.delLoading && !!state.delPlan && state.delPlan.blocked !== true && state.delPlan.found === true;
}
/** 已勾选几处（页面标题里用，避免"选了几处"要自己数） */
function deleteSelectedCount(state) {
  var sel = state.delSel || {};
  return Object.keys(sel).filter(function (k) { return sel[k] === true; }).length;
}
