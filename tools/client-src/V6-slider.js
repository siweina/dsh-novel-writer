// V6-slider.js (M5) — 阈值行 slider 辅助输入 augmentation.
// 契约: CONTRACT-V6.md §1/§3/§4; 只用新建类 nwRange/nwRangeVal; ES5 风格;
// 自包含文本块,不 import 本地文件; 不新增 state 键/控制器方法/保存逻辑;
// 无 react.use*/require/ctx.inject 调用; el 由调用方注入.
// 对应现有视图: lib/client.js L1891-1909 (nwTolRow 内 low/high 两组 nwTolField + nwTolInput).
function TolRangeRow(el, t, mk, d, setDraft, state) {
  function mkOne(field, label) {
    var v = d ? d[field] : "";
    var empty = (v === "" || v === null || v === undefined);
    var pos = mk + "-" + field + "-range";
    function onEv(ev) { setDraft(mk, field, ev.target.value); }
    return el("span", { key: pos, style: { display: "flex", alignItems: "center", gap: "4px", minWidth: "0" } },
      el("input", { type: "range", className: "nwRange", min: 0, max: 99, step: 1,
        value: empty ? 0 : v, disabled: !!(state && state.loading),
        "aria-label": label, "aria-valuetext": empty ? label : (String(v) + "%"),
        onChange: onEv }),
      el("span", { className: "nwRangeVal" }, empty ? "-" : (String(v) + "%")));
  }
  return [mkOne("low", t("baseline.low")), mkOne("high", t("baseline.high"))];
}
