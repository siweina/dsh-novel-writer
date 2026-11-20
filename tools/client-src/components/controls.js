// ---- 开关面板 ----
function conversationColumn() {
  // v4.3.0：同上，删掉永不匹配的 [data-pane="conversation"]（真实标记是 …_centerCol）
  return document.querySelector('[class*="centerCol"]') ?? void 0;
}
/**
 * v5.5.0：开关交给官方 primitives（Switch 36×20，关闭态滑块读 --dsw-alias-switch-thumb），
 * 取不到官方包时由 NW_UI 内部回退到同一套 token 样式的本地实现（见「官方原语适配层」）。
 * 保留这个局部名字，6 个调用点无需改动；label 是无障碍名称，由调用点传入。
 */
function Switch(props) {
  // 必须用 createElement 变成子组件：官方 Switch 内部用 hook，直接调用会把 hook 混进本组件的 hook 链
  return react.createElement(NW_UI.Switch, {
    checked: props.checked,
    disabled: props.disabled,
    onChange: props.onChange,
    label: props.label || ""
  });
}
// v6.5.0：自建下拉（替换原生 select——系统弹层方角、系统蓝，与面板观感不符）。
// props: { value, options:[{value,label}], placeholder, disabled, label, onChange(value) }
// 键盘：↑/↓ 移动高亮、Enter 选中、Esc/Tab 关闭；点击外部关闭。无选中项时触发器显示 placeholder。
// 无 hook 实现（CONTRACT-V6 §1.6：react.use* 调用点须恒为 12）。开合与高亮状态存于控制器，
// 每个实例用 props.id 区分；点击外部由 document 监听关闭（#28：控制器按开合安装/拆除，见 selectSet）。
// props: { id, value, options:[{value,label}], placeholder, disabled, label, controller, onChange(value) }
function SelectMenu(props) {
  var el = react.createElement;
  var ctl = props.controller;
  var sel = ctl.selectState(props.id);
  var open = sel.open;
  var active = sel.active;
  var pos = sel.pos;
  var options = Array.isArray(props.options) ? props.options : [];
  var current = null;
  for (var oi = 0; oi < options.length; oi += 1) {
    if (options[oi].value === props.value) { current = options[oi]; break; }
  }
  var openMenu = function () {
    if (props.disabled) return;
    var idx = -1;
    for (var k = 0; k < options.length; k += 1) { if (options[k].value === props.value) { idx = k; break; } }
    // v6.4.0：菜单改用 position:fixed，**为了逃出祖先的 overflow 裁剪**。
    // 现场：词表卡片有圆角 → 必须 overflow:hidden，而绝对定位的弹层会被它截断
    // （实测「雨夜灯」那一项被切掉半个字）。fixed 元素的包含块是视口，
    // 不受祖先 overflow 影响（除非祖先有 transform/filter——本面板链路没有）。
    // 于是开菜单时要**算一次几何**：锚点取触发器的视口坐标，并按上下可用空间决定向下还是向上弹。
    var pos = null;
    try {
      var wrap = document.querySelector('[data-sel-id="' + props.id + '"]');
      var btn = wrap ? wrap.querySelector("button") : null;
      if (btn) {
        var r = btn.getBoundingClientRect();
        var vh = window.innerHeight || 0;
        var itemH = 30;              // 与 .nwSelOpt 的 min-height 对齐
        var pad = 8;                 // 与 .nwSelMenu 的 padding(4px×2) 对齐
        var want = options.length * itemH + pad;
        var below = Math.max(0, vh - r.bottom - 8);
        var above = Math.max(0, r.top - 8);
        var dropUp = want > below && above > below;
        pos = {
          left: Math.round(r.left),
          width: Math.round(r.width),
          anchorTop: Math.round(r.top),
          anchorBottom: Math.round(r.bottom),
          vh: Math.round(vh),
          dropUp: dropUp,
          maxH: Math.max(96, Math.min(260, Math.round(dropUp ? above : below)))
        };
      }
    } catch (e) { pos = null; }
    ctl.selectSet(props.id, { open: true, active: idx >= 0 ? idx : (options.length > 0 ? 0 : -1), pos: pos });
  };
  var pick = function (idx) {
    var opt = options[idx];
    ctl.selectSet(props.id, { open: false });
    if (!opt || opt.value === props.value) return;
    if (typeof props.onChange === "function") props.onChange(opt.value);
  };
  var onKey = function (ev) {
    if (props.disabled) return;
    if (!open) {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        openMenu();
      }
      return;
    }
    if (ev.key === "ArrowDown") { ev.preventDefault(); ctl.selectSet(props.id, { active: Math.min(options.length - 1, active + 1) }); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); ctl.selectSet(props.id, { active: Math.max(0, active - 1) }); }
    else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); if (active >= 0) pick(active); }
    else if (ev.key === "Escape") { ev.preventDefault(); ctl.selectSet(props.id, { open: false }); }
    else if (ev.key === "Tab") { ctl.selectSet(props.id, { open: false }); }
  };
  var triggerText = current ? current.label : (props.placeholder || "");
  var items = options.map(function (opt, idx) {
    var isSel = opt.value === props.value;
    var isAct = idx === active;
    var cls = "nwSelOpt" + (isSel ? " nwSelOptSel" : "") + (isAct ? " nwSelOptAct" : "");
    return el("div", {
      key: "o-" + idx,
      role: "option",
      "aria-selected": isSel ? "true" : "false",
      className: cls,
      onMouseEnter: function () { ctl.selectSet(props.id, { active: idx }); },
      onMouseDown: function (ev) { ev.preventDefault(); },
      onClick: function () { pick(idx); }
    },
      el("span", { className: "nwSelOptLabel" }, opt.label),
      isSel ? el("span", { className: "nwSelOptCheck", "aria-hidden": "true" }, "✓") : null
    );
  });
  return el("div", { className: "nwSelWrap", "data-sel-id": props.id },
    el("button", {
      type: "button",
      className: "nwSelect nwSelTrigger" + (open ? " nwSelTriggerOpen" : "") + (current ? "" : " nwSelEmpty"),
      disabled: !!props.disabled,
      "aria-haspopup": "listbox",
      "aria-expanded": open ? "true" : "false",
      "aria-label": props.label || undefined,
      onClick: function () { if (open) ctl.selectSet(props.id, { open: false }); else openMenu(); },
      onKeyDown: onKey
    },
      el("span", { className: "nwSelTriggerText" }, triggerText),
      el("span", { className: "nwSelChevron", "aria-hidden": "true", dangerouslySetInnerHTML: { __html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' } })
    ),
    open ? el("div", {
      className: "nwSelMenu nwSelMenuFixed",
      role: "listbox",
      onKeyDown: onKey,
      tabIndex: -1,
      // 位置由开启时算出的视口坐标决定（fixed → 不受祖先 overflow 裁剪）。
      // 这里只写几何量（left/width/top|bottom/maxHeight），不含颜色/圆角/字号，
      // 不违反 ui-audit 对内联样式的约束。
      style: pos ? (pos.dropUp
        ? { position: "fixed", left: pos.left + "px", width: pos.width + "px", bottom: ((pos.vh || 0) - pos.anchorTop + 4) + "px", maxHeight: pos.maxH + "px" }
        : { position: "fixed", left: pos.left + "px", width: pos.width + "px", top: (pos.anchorBottom + 4) + "px", maxHeight: pos.maxH + "px" })
        : null
    }, items) : null
  );
}
// v7 共享组件：items=[{ label, path, revealKey }], controller 复用现有降级行为。
function StorageDisclosure(el, h, t, NW_UI, props) {
  var p = props || {};
  return el("details", { className: "nwStorage nwGCard" },
    el("summary", { className: "nwDisclosureTitle" }, t("storage.title"), el("span", { className: "nwDisclosureArrow", "aria-hidden": true }, "›")),
    el("div", { className: "nwStorageBody" }, (p.items || []).map(function (item) {
      return el("div", { key: item.revealKey, className: "nwStorageItem" },
        el("div", { className: "nwStorageMeta" },
          el("div", { className: "nwStorageLabel" }, item.label),
          el("div", { className: "nwStoragePath", title: item.path || "" }, item.path || t("plot.pathUnknown"))),
        el("div", { className: "nwStorageActions" },
          el("button", { type: "button", className: "nwBtn nwBtnGhost nwStorageBtn", disabled: !item.path || p.revealing, onClick: function () { p.controller.openDir(item.revealKey); } }, nwGlyph(el, "nwIco", "storageOpen", "↗"), t("storage.open")),
          el("button", { type: "button", className: "nwBtn nwBtnGhost nwStorageBtn", disabled: !item.path, onClick: function () { p.controller.copyPath(item.path); } }, nwGlyph(el, "nwIco", "storageCopy", "⧉"), t("storage.copy"))));
    })));
}
