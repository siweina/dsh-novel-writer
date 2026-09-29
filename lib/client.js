/**
 * dsh-novel-writer — 浏览器端（client half, v4.0.0）
 *
 * 在 Web GUI 侧边栏挂载「句式分析」入口，点击后在会话区打开开关面板：
 *   - 启用句式分析（enabled）：控制 AI 是否可用 novel_sentence_analysis
 *   - 自动分析（autoAnalyze）：控制 AI 分析作品时是否主动附带句式报告
 * 开关状态通过 /api/dsh-novel-writer/state 同步到宿主端
 * ~/.dsh/dsh-novel-writer/state.json；宿主端不可达时降级为 localStorage。
 *
 * 本文件遵循 DSH client 插件格式：window.__ModuleLoader__.load({ id, factory })，
 * factory 返回 { apply, inject }。仅依赖 react / react-dom（Web GUI 内置）。
 */
window.__ModuleLoader__.load({
  id: "dsh-novel-writer",
  factory: (require) => {
    var module = { exports: {} };
    // v3.5.0 R1：rawTimer 必须在 createController 闭包外/顶部声明（旧位置在渲染函数内，api 方法访问不到 → ReferenceError）
    var rawTimer = null;
    var reportReqId = 0; // v3.5.0 M15：模块级请求序号（渲染闭包变量每次渲染归零，守卫失效）
    var baselineFlashTimer = null; // v4.0.0：基线"已保存"闪烁定时器（此前从不清理：连续保存互相抢状态、卸载后仍写状态）
    var localeId = ""; // v4.3.0：宿主 locale 服务的当前语言（apply 内订阅写入；为空则回退 documentElement.lang）
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let react_dom_client = require("react-dom/client");

    // ---- 官方原语适配层（v5.5.0）----
    // 第三方插件（@linxin666/dsh-client-ui-market 等 6 个）同样直接 require 官方 primitives，
    // 且都未声明 dsh.client.external —— 该包属客户端基线模块；这里仍包 try/catch，取不到即回退。
/* ===== B：官方原语适配层（v5.5.0 · @deepseek-ai/dsh-client-ui-primitives → 自绘回退） =====
 * 插入位置：client.js 的 factory 内、`let react = require("react");` 之后（任意组件定义之前）。
 * 用法（本块最后一行已给出）：
 *  * 对外只有 NW_UI：{ available, Button, Switch, SegmentedControl, Modal, RiskConfirmation,
 *                   Tag, Tooltip, DisclosureRow }
 *
 * 设计约束（宿主启动安全第一）：
 *   1. require 官方包只在 try/catch 内；取不到模块 / 缺某个组件 / 官方组件渲染抛错 → 逐控件回退；
 *      本层在任何情况下都不向上抛，也不写 console（用 NW_UI.available 自检即可）。
 *   2. 回退实现复用既有 nw* 类名，外观全部由 CSS 承担：本块没有任何内联 style、没有任何颜色字面量。
 *   3. 不硬编码任何文案：文案由调用方传入，缺失时给空串等安全默认值。
 *   4. 回退分支与官方分支的 props 映射共用同一套归一化函数，保证两条路径语义一致。
 */
function createNovelWriterUI(react, require) {
  var NOOP = function () {};
  var canCreate = !!react && typeof react.createElement === "function";
  var h = canCreate
    ? function () { return react.createElement.apply(react, arguments); }
    : function () { return null; };

  /* ---------- 归一化小工具（只做类型兜底，不产生文案） ---------- */
  function text(value) { return typeof value === "string" ? value : ""; }
  function optionalText(value) { return typeof value === "string" && value !== "" ? value : void 0; }
  function callback(value) { return typeof value === "function" ? value : null; }
  function isOn(value) { return value === true; }
  function classNameOf(base, extra) { return optionalText(extra) === void 0 ? base : base + " " + extra; }
  function isElement(node) {
    if (!node || typeof node !== "object") return false;
    if (typeof react.isValidElement === "function") return react.isValidElement(node) === true;
    return node.$$typeof !== void 0 && node.$$typeof !== null;
  }
  // 元素锚点：官方 Tooltip 用 cloneElement 注入 ref/handler，children 必须是单个元素
  function anchorOf(children) {
    return isElement(children) ? children : h("span", null, children);
  }

  /* ---------- 官方模块加载（唯一的 require，全程 try/catch） ---------- */
  // 包名与第三方插件（@linxin666/dsh-client-ui-preset-center 等）用的是同一个，属客户端基线包。
  // 调用按完整包名字面量书写（不抽成变量）：契约与审计工具都按这一行字面匹配"必须包在 try 内"。
  var primitives = null;
  try {
    if (typeof require === "function") primitives = require("@deepseek-ai/dsh-client-ui-primitives");
  } catch (err) {
    primitives = null; // 模块不在客户端基线里 / 解析失败 → 全部走回退
  }
  if (!primitives || (typeof primitives !== "object" && typeof primitives !== "function")) primitives = null;

  function typeTag(value) {
    if (!value || typeof value !== "object") return "";
    try { return String(value.$$typeof); } catch (err) { return ""; }
  }
  // 可渲染的组件类型：函数组件/类组件，或 React.memo / forwardRef / lazy 包装对象
  function isComponentType(value) {
    if (typeof value === "function") return true;
    var tag = typeTag(value);
    return tag.indexOf("react.memo") >= 0 || tag.indexOf("react.forward_ref") >= 0 || tag.indexOf("react.lazy") >= 0;
  }
  // 取"可直接调用"的内层函数：memo/forwardRef 拆包（保住"官方组件抛错也能被 try/catch 兜住"）；
  // 类组件不能当函数调用（返回 null，改走 createElement，由 React 渲染）。
  function invocable(value, depth) {
    if (typeof value === "function") {
      if (value.prototype && value.prototype.isReactComponent) return null;
      return value;
    }
    if (!value || typeof value !== "object" || depth > 3) return null;
    var tag = typeTag(value);
    if (tag.indexOf("react.memo") >= 0) return invocable(value.type, depth + 1);
    if (tag.indexOf("react.forward_ref") >= 0) {
      var render = value.render;
      if (typeof render !== "function") return null;
      return function (props) { return render(props, null); };
    }
    return null;
  }
  function pick(name) {
    if (primitives === null) return null;
    try {
      var value = primitives[name];
      if (isComponentType(value)) return value;
      var inner = primitives["default"]; // ESM/CJS 互操作兜底
      if (inner && typeof inner === "object" && isComponentType(inner[name])) return inner[name];
    } catch (err) { /* 访问器抛错 → 视为该组件缺失 */ }
    return null;
  }

  var NAMES = ["Button", "Switch", "SegmentedControl", "Modal", "RiskConfirmation", "Tag", "Tooltip", "DisclosureRow"];
  var official = {};
  var resolved = 0;
  for (var n = 0; n < NAMES.length; n += 1) {
    official[NAMES[n]] = pick(NAMES[n]);
    if (official[NAMES[n]] !== null) resolved += 1;
  }
  // available：8 个官方原语是否**全部**拿到（模块解析层面；个别组件运行时抛错仍会逐次回退，不会翻转它）
  var available = resolved === NAMES.length;

  /* ---------- 统一的"官方优先，抛错即回退"包装 ---------- */
  // prepare(props) 在每次渲染恰好调用一次（分段控件/折叠行的 hook 都在这里，保证 hook 数量稳定）；
  // mapProps(props, ctx) 给出官方 props；回退实现拿到同一份 ctx。
  function adapt(name, fallback, prepare, mapProps) {
    var component = official[name];
    if (component === null || !canCreate) return fallback;
    var call = null;
    try { call = invocable(component, 0); } catch (err) { call = null; }
    return function Adapted(props) {
      var input = props || {};
      var context = null;
      try { context = prepare === null ? null : prepare(input); } catch (err) { context = null; }
      var mapped = null;
      try { mapped = mapProps(input, context); } catch (err) { mapped = null; }
      if (mapped !== null) {
        try {
          var node = call !== null ? call(mapped) : h(component, mapped);
          if (node !== void 0) return node; // null 是合法节点（例如 open:false 的弹窗），只有 undefined 才当失败
        } catch (err2) { /* 官方组件抛错 → 落到下面的回退实现 */ }
      }
      return fallback(input, context);
    };
  }

  /* ---------- 回退实现（只复用既有 nw* 类名；样式全在 CSS） ---------- */

  // --- Button ---
  var BUTTON_VARIANTS = { primary: 1, ghost: 1, outline: 1, toolbar: 1 };
  var BUTTON_CLASS = {
    primary: "nwBtn nwBtnPrimary",
    ghost: "nwBtn nwBtnGhost",
    outline: "nwBtn",
    toolbar: "nwBtn nwBtnGhost"
  };
  function buttonVariant(value) {
    var variant = text(value);
    return BUTTON_VARIANTS[variant] === 1 ? variant : "ghost"; // 与官方默认 variant 对齐
  }
  function mapButton(props) {
    return {
      variant: buttonVariant(props.variant),
      size: props.size === "sm" ? "sm" : "md",
      disabled: isOn(props.disabled),
      title: optionalText(props.title),
      onClick: callback(props.onClick) || void 0,
      className: optionalText(props.className),
      children: props.children
    };
  }
  function fallbackButton(props) {
    return h("button", {
      type: "button",
      className: classNameOf(BUTTON_CLASS[buttonVariant(props.variant)], props.className),
      disabled: isOn(props.disabled),
      title: optionalText(props.title),
      onClick: callback(props.onClick) || void 0
    }, props.children);
  }

  // --- Switch ---
  function mapSwitch(props) {
    return {
      checked: isOn(props.checked),
      onChange: callback(props.onChange) || NOOP,
      label: text(props.label), // 官方必填：缺失兜底成空串（不硬编码文案）
      disabled: isOn(props.disabled),
      title: optionalText(props.title),
      className: optionalText(props.className)
    };
  }
  function fallbackSwitch(props) {
    var checked = isOn(props.checked);
    return h("button", {
      type: "button",
      role: "switch",
      "aria-checked": checked ? "true" : "false",
      "aria-label": optionalText(props.label),
      disabled: isOn(props.disabled),
      title: optionalText(props.title),
      className: classNameOf("nwSwitch" + (checked ? " nwSwitchOn" : ""), props.className),
      onClick: function () {
        var onChange = callback(props.onChange);
        if (onChange !== null) onChange(!checked);
      }
    }, h("span", { className: "nwSwitchKnob" }));
  }

  // --- SegmentedControl（官方必填 id，适配层自己生成稳定 id） ---
  var useIdHook = typeof react.useId === "function" ? react.useId : null;
  var useRefHook = typeof react.useRef === "function" ? react.useRef : null;
  var controlSeq = 0;
  function normalizeOptions(options) {
    var list = [];
    var source = Array.isArray(options) ? options : [];
    for (var i = 0; i < source.length; i += 1) {
      var option = source[i];
      if (!option || typeof option !== "object") continue;
      var value = text(option.value);
      if (value === "") continue;
      list.push({
        value: value,
        label: text(option.label) || value,
        disabled: isOn(option.disabled),
        title: optionalText(option.title)
      });
    }
    return list;
  }
  function prepareSegments(props) {
    // 无论调用方是否自带 id，都先按固定分支取一次自动 id：hook 数量每帧恒定
    var auto;
    if (useIdHook !== null) auto = "nw-seg-" + String(useIdHook()).replace(/[^A-Za-z0-9_-]/g, "");
    else if (useRefHook !== null) {
      var box = useRefHook(null);
      if (box === null || typeof box !== "object") box = { current: null };
      if (box.current === null) {
        controlSeq += 1;
        box.current = "nw-seg-" + controlSeq;
      }
      auto = box.current;
    } else {
      auto = "nw-seg-fallback";
    }
    return { id: optionalText(props.id) || auto, options: normalizeOptions(props.options) }; // 自带 id（可选）优先
  }
  function mapSegments(props, context) {
    return {
      id: context !== null && context !== void 0 ? context.id : text(props.id),
      value: text(props.value),
      options: context !== null && context !== void 0 ? context.options : normalizeOptions(props.options),
      onChange: callback(props.onChange) || NOOP,
      label: text(props.label), // 官方必填
      disabled: isOn(props.disabled),
      className: optionalText(props.className)
    };
  }
  function fallbackSegments(props, context) {
    var value = text(props.value);
    var disabled = isOn(props.disabled);
    var onChange = callback(props.onChange);
    var options = context !== null && context !== void 0 ? context.options : normalizeOptions(props.options);
    var tabs = [];
    for (var i = 0; i < options.length; i += 1) {
      var option = options[i];
      var active = option.value === value;
      tabs.push(h("button", {
        key: option.value,
        type: "button",
        role: "tab",
        "aria-selected": active ? "true" : "false",
        disabled: disabled || option.disabled === true,
        title: option.title,
        className: "nwSegBtn" + (active ? " nwSegBtnOn" : ""),
        onClick: (function (next, isActive) {
          return function () { if (!isActive && onChange !== null) onChange(next); };
        })(option.value, active)
      }, option.label));
    }
    return h("div", {
      className: classNameOf("nwSeg", props.className),
      role: "tablist",
      "aria-label": optionalText(props.label)
    }, tabs);
  }

  // --- Modal ---
  function mapModal(props) {
    return {
      open: isOn(props.open),
      onClose: callback(props.onClose) || NOOP, // 官方必填
      title: text(props.title), // 官方必填
      closeLabel: text(props.closeLabel), // 官方必填：缺失即空串（不硬编码文案）
      description: optionalText(props.description),
      children: props.children,
      footer: props.footer
    };
  }
  function fallbackModal(props) {
    if (!isOn(props.open)) return null;
    var title = text(props.title);
    var description = optionalText(props.description);
    var children = props.children === void 0 || props.children === null ? null : h("div", null, props.children);
    return h("div", { className: "nwModal", role: "presentation" },
      h("div", { className: "nwModalBox", role: "dialog", "aria-modal": "true", "aria-label": title },
        title === "" ? null : h("div", { className: "nwModalTitle" }, title),
        description === void 0 ? null : h("div", { className: "nwModalText" }, description),
        children,
        props.footer === void 0 || props.footer === null ? null : h("div", { className: "nwModalBtns" }, props.footer)
      ));
  }

  // --- RiskConfirmation ---
  function riskLabels(props) {
    var cancelLabel = text(props.cancelLabel);
    return {
      cancelLabel: cancelLabel,
      // 官方多一个必填 closeLabel（弹窗右上角 × 的无障碍名）；
      // 调用方没给就借用 cancelLabel，仍然不产生硬编码文案
      closeLabel: text(props.closeLabel) || cancelLabel
    };
  }
  function mapRisk(props) {
    var labels = riskLabels(props);
    return {
      open: isOn(props.open),
      title: text(props.title),
      description: text(props.description),
      acknowledgeLabel: text(props.acknowledgeLabel),
      cancelLabel: labels.cancelLabel,
      closeLabel: labels.closeLabel,
      confirmLabel: text(props.confirmLabel),
      acknowledged: isOn(props.acknowledged),
      disabled: isOn(props.disabled),
      onAcknowledgedChange: callback(props.onAcknowledgedChange) || NOOP,
      onCancel: callback(props.onCancel) || NOOP,
      onConfirm: callback(props.onConfirm) || NOOP
    };
  }
  function fallbackRisk(props) {
    var labels = riskLabels(props);
    var acknowledged = isOn(props.acknowledged);
    var disabled = isOn(props.disabled);
    var onAck = callback(props.onAcknowledgedChange);
    var onCancel = callback(props.onCancel);
    var onConfirm = callback(props.onConfirm);
    return fallbackModal({
      open: props.open,
      title: props.title,
      description: props.description,
      children: h("label", { className: "nwModalText" },
        h("input", {
          type: "checkbox",
          checked: acknowledged,
          disabled: disabled,
          // 没有回调时给 readOnly，避免 React 对"受控字段无 onChange"报 console.error
          readOnly: onAck === null,
          onChange: onAck === null ? void 0 : function (event) {
            onAck(!!(event && event.target && event.target.checked === true));
          }
        }),
        h("span", null, text(props.acknowledgeLabel))),
      footer: h("div", { className: "nwModalBtns" },
        h("button", {
          type: "button",
          className: "nwBtn nwBtnGhost",
          onClick: onCancel === null ? void 0 : onCancel
        }, labels.cancelLabel),
        h("button", {
          type: "button",
          className: "nwBtn nwBtnDanger",
          disabled: disabled || !acknowledged,
          onClick: onConfirm === null ? void 0 : onConfirm
        }, text(props.confirmLabel)))
    });
  }

  // --- Tag ---
  var TAG_TONES = { outline: 1, solid: 1, neutral: 1, quiet: 1, success: 1, info: 1, warning: 1, danger: 1 };
  function tagTone(value) {
    var tone = text(value);
    return TAG_TONES[tone] === 1 ? tone : "outline"; // 与官方默认 tone 对齐
  }
  function mapTag(props) {
    return { tone: tagTone(props.tone), className: optionalText(props.className), children: props.children };
  }
  function fallbackTag(props) {
    // 既有 nw* 只有"开/关"两种胶囊：成功态映射到 nwBadgeOn，其余中性 tone 共用 nwBadge
    var tone = tagTone(props.tone);
    return h("span", { className: classNameOf(tone === "success" ? "nwBadge nwBadgeOn" : "nwBadge", props.className) }, props.children);
  }

  // --- Tooltip ---
  function mapTooltip(props) {
    var label = props.label;
    if (typeof label !== "function") label = text(label); // 官方的 label 可以是 () => string
    return { label: label, children: anchorOf(props.children) };
  }
  function fallbackTooltip(props) {
    var label = "";
    try {
      label = typeof props.label === "function" ? text(props.label()) : text(props.label);
    } catch (err) { label = ""; }
    var anchor = anchorOf(props.children);
    if (label === "" || anchor === null || typeof react.cloneElement !== "function") return anchor;
    try {
      return react.cloneElement(anchor, { title: label }); // 回退用原生 title 气泡
    } catch (err) { return anchor; }
  }

  // --- DisclosureRow（官方是受控组件，回退实现自己持有展开态） ---
  var useStateHook = typeof react.useState === "function" ? react.useState : null;
  function prepareDisclosure(props) {
    if (useStateHook === null) return { open: isOn(props.defaultOpen), toggle: NOOP };
    var pair = useStateHook(isOn(props.defaultOpen));
    var setter = callback(pair === null || pair === void 0 ? null : pair[1]);
    return {
      open: pair !== null && pair !== void 0 && pair[0] === true,
      toggle: function () {
        if (setter !== null) setter(function (value) { return value !== true; });
      }
    };
  }
  function mapDisclosure(props, context) {
    var open = isOn(props.defaultOpen);
    var toggle = NOOP;
    if (context !== null && context !== void 0) { open = context.open === true; toggle = context.toggle; }
    return {
      icon: null, // 官方必填 icon：给 null，官方自带的 chevron 足以表达展开态
      title: text(props.title),
      open: open,
      expandable: true,
      onToggle: toggle,
      expandOnRowClick: true,
      children: props.children,
      className: optionalText(props.className)
    };
  }
  function fallbackDisclosure(props, context) {
    var open = isOn(props.defaultOpen);
    var toggle = NOOP;
    if (context !== null && context !== void 0) { open = context.open === true; toggle = context.toggle; }
    return h("div", { className: classNameOf("nwToolGroup", props.className) },
      h("div", { className: "nwToolGroupHead" },
        h("button", {
          type: "button",
          className: "nwToolGroupHeadBtn",
          "aria-expanded": open ? "true" : "false",
          onClick: toggle
        },
          h("span", { className: "nwToolGroupHeadText" },
            h("span", { className: "nwToolGroupName" }, text(props.title))),
          h("span", { className: "nwToolGroupArrow" }, open ? "\u25be" : "\u25b8")
        )
      ),
      open ? h("div", { className: "nwToolGroupBody" }, props.children) : null);
  }

  /* ---------- 冻结 API ---------- */
  return {
    available: available,
    Button: adapt("Button", fallbackButton, null, mapButton),
    Switch: adapt("Switch", fallbackSwitch, null, mapSwitch),
    SegmentedControl: adapt("SegmentedControl", fallbackSegments, prepareSegments, mapSegments),
    Modal: adapt("Modal", fallbackModal, null, mapModal),
    RiskConfirmation: adapt("RiskConfirmation", fallbackRisk, null, mapRisk),
    Tag: adapt("Tag", fallbackTag, null, mapTag),
    Tooltip: adapt("Tooltip", fallbackTooltip, null, mapTooltip),
    DisclosureRow: adapt("DisclosureRow", fallbackDisclosure, prepareDisclosure, mapDisclosure)
  };
}

var NW_UI = createNovelWriterUI(react, require);

    // ---- 样式 ----
var css = `



  /* ===== 杂项 ===== */
  /* v4.3.0：删掉永不匹配的 [data-pane=…]（宿主全树 0 命中，真实列名是 CSS-module 的 …_sidebarCol / …_centerCol） */
  [class*=centerCol]{position:relative}
  [data-dsh-novel-writer-view]{position:absolute;inset:0;z-index:60;background:var(--dsw-alias-bg-base);display:none;overflow:auto}
  html[data-dsh-novel-writer-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]) [data-dsh-novel-writer-view]{display:block}
  html[data-dsh-novel-writer-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]) [class*=centerCol]>:not([data-dsh-novel-writer-view]){display:none!important}
  /* v4.3.0：宿主折叠标记挂在 frame 上（<div class="…_frame" data-sidebar-collapsed>），并不存在 data-dsh-frame 属性 */
  [data-sidebar-collapsed] .nwEntry{justify-content:center;width:100%;padding:0}
  [data-sidebar-collapsed] .nwEntryLabel{display:none}
  .nwSectionTitle{display:inline-flex;align-items:center;gap:6px;font-weight:700;font-size:13px;line-height:19px;letter-spacing:.02em;color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent);border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent);border-radius:999px;corner-shape:round;padding:3px 12px;margin-top:10px}.nwTolVer{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);margin:-2px 0 2px;letter-spacing:.03em}.nwTolCard{border-radius:var(--dsw-radius-xl);border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);padding:4px 14px 8px;margin:8px 0 4px}.nwTolRow{display:flex;align-items:center;gap:10px;padding:9px 2px}.nwTolRow+.nwTolRow{border-top:1px dashed var(--dsw-alias-border-l2)}.nwTolName{flex:1;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);font-weight:500;display:flex;align-items:center;gap:8px;white-space:nowrap}.nwTolIcon{font-size:15px;line-height:22px;opacity:.9;flex-shrink:0}.nwTolField{width:66px;flex-shrink:0;display:flex;flex-direction:column;align-items:stretch;gap:3px}.nwTolInput{width:100%;height:30px;padding:0 4px;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);font-size:13px;line-height:20px;text-align:center;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);transition:border-color .18s,box-shadow .18s,background .18s;-moz-appearance:textfield}.nwTolInput::-webkit-outer-spin-button,.nwTolInput::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}.nwTolInput:hover{border-color:var(--dsw-alias-border-l3)}.nwTolInput:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px var(--dsw-focus-ring-color);background:var(--dsw-alias-bg-layer-1)}.nwTolInput::placeholder{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.nwTolCaption{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);text-align:center}.nwTolSep{width:14px;flex-shrink:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);text-align:center}.nwTolPct{width:14px;flex-shrink:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);text-align:left}.nwTolBtns{display:flex;gap:12px;margin-top:16px}.nwBtn.nwBtnPrimary{background:var(--dsw-alias-state-business-primary);border:none;color:var(--dsw-alias-label-primary-foreground);font-weight:600;font-size:13px;line-height:20px;padding:9px 20px;border-radius:var(--dsw-radius-sm);cursor:pointer;box-shadow:var(--dsw-elevation-soft);transition:transform .15s,box-shadow .15s,opacity .15s;font-family:inherit}.nwBtnPrimary:hover{transform:translateY(-1px);box-shadow:var(--dsw-elevation-soft);filter:brightness(1.12)}.nwBtnPrimary:active{transform:translateY(0);box-shadow:var(--dsw-elevation-soft)}.nwBtn.nwBtnDone{background:linear-gradient(135deg,var(--dsw-alias-state-success-primary),var(--dsw-alias-state-success-primary));box-shadow:var(--dsw-elevation-soft);font-family:inherit}.nwBtn.nwBtnGhost{background:transparent;border:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;padding:9px 18px;border-radius:var(--dsw-radius-sm);cursor:pointer;transition:background .15s,border-color .15s,transform .15s;font-family:inherit}.nwBtnGhost:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l3);transform:translateY(-1px)}.nwUpdateBar{display:block;margin:4px 0 8px;padding:7px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;text-decoration:none;border:1px solid var(--dsw-alias-state-success-primary);cursor:pointer}.nwUpdateBar:hover{background:var(--dsw-alias-interactive-bg-hover)}.nwUpdateStale{display:block;margin:4px 0 8px;padding:7px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;border:0.5px solid var(--dsw-alias-border-l2)}
  .nwNavEntry{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;padding:9px 12px;margin:4px 0;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);cursor:pointer;text-align:left;color:inherit;font:inherit;transition:box-shadow .2s var(--nw-ease),transform .18s var(--nw-ease)}
  .nwNavEntry:hover{box-shadow:var(--dsw-elevation-panel);transform:translateY(-1px);font-family:inherit}
  .nwNavEntryText{flex:1;min-width:0;padding-right:8px}
  .nwNavEntryTitle{font-size:13px;line-height:20px;font-weight:600}
  .nwNavEntryHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
  .nwNavEntryRight{display:flex;align-items:center;gap:6px;flex:none}
  .nwNavEntryRight .nwBadge{white-space:nowrap;flex:none}
  .nwNavEntryArrow{font-size:18px;line-height:26px;color:var(--dsw-alias-label-tertiary);flex:none}
  .nwBackBtn{font-size:12px;line-height:18px;padding:3px 8px;margin:2px 0 6px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);cursor:pointer;font-family:inherit}
  .nwModelBtn{font-size:11px;line-height:16px;padding:2px 6px;margin-top:4px;border:0.5px solid var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;font-family:inherit}
  .nwToolRight{display:flex;flex-direction:column;align-items:flex-end;gap:4px}

  /* ===== 导航/入口 ===== */
  .nwEntry{width:100%;height:32px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-radius:var(--dsw-radius-md);align-items:center;gap:8px;padding:0 12px;font-size:13px;line-height:20px;display:flex;font-family:inherit}
  .nwEntry:hover{background:var(--dsw-specific-sidebar-nav-item-hover);color:var(--dsw-alias-label-primary);font-family:inherit}
  .nwEntry[data-active]{background:var(--dsw-specific-sidebar-nav-item-active);color:var(--dsw-alias-label-primary);font-weight:600}
  .nwEntryIcon{flex:none;justify-content:center;align-items:center;display:inline-flex;width:16px;font-size:13px;line-height:20px}
  .nwEntryLabel{text-overflow:ellipsis;overflow:hidden}
  .nwPanel{--nw-ease:cubic-bezier(.16,1,.3,1);max-width:560px;margin:0 auto;padding:28px 24px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);display:flex;flex-direction:column;gap:10px}
  .nwPanelHeader{display:flex;align-items:center;gap:10px}
  .nwPanelTitle{font-size:16px;line-height:24px;font-weight:700;letter-spacing:-.02em;flex:1;min-width:0}
  .nwClose{appearance:none;font:inherit;cursor:pointer;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);width:30px;height:30px;line-height:1}
  .nwRefresh{appearance:none;font:inherit;cursor:pointer;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;padding:5px 9px}
  .nwRefresh:hover{background:var(--dsw-alias-bg-layer-2);font-family:inherit}
  .nwDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.6;margin:0}
  .nwRefreshSpin{animation:nwspin 1s linear infinite}

  /* ===== 横幅与开关 ===== */
  .nwBanner{display:flex;align-items:center;gap:10px;border-radius:var(--dsw-radius-lg);padding:14px 16px;font-size:15px;line-height:22px;font-weight:700;border:0.5px solid}
  .nwBannerOn{background:var(--dsw-alias-state-success-tertiary);border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
  .nwBannerOff{background:var(--dsw-alias-state-danger-tertiary);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-error)}
  .nwBannerIcon{flex:none;font-size:18px;line-height:1}
  .nwBannerSub{font-size:12px;line-height:18px;font-weight:500;opacity:.9;margin-left:6px}
  .nwRow{display:flex;align-items:center;gap:14px;border:0;background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-lg);padding:12px 14px;box-shadow:var(--dsw-elevation-soft);transition:box-shadow .2s var(--nw-ease),transform .18s var(--nw-ease)}
  .nwRow:hover{box-shadow:var(--dsw-elevation-panel);transform:translateY(-1px)}
  .nwRowOn{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 6%,transparent);box-shadow:var(--dsw-elevation-panel)}
  .nwRowOff{background:var(--dsw-alias-bg-layer-1)}
  .nwRowText{flex:1;min-width:0}
  .nwRowLabel{font-size:13px;font-weight:600;line-height:1.5}
  .nwRowHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin-top:2px}
  .nwSwitchWrap{flex:none;display:flex;align-items:center;gap:8px}
  .nwSwitch{appearance:none;flex:none;width:56px;height:30px;box-sizing:border-box;border-radius:999px;border:0;background:var(--dsw-alias-bg-layer-4);cursor:pointer;position:relative;padding:0;transition:background .18s,border-color .18s;corner-shape:round}
  .nwSwitch:hover{border-color:var(--dsw-alias-border-l4)}
  .nwSwitch:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
  .nwSwitchOn{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
  .nwSwitchOn:hover{border-color:var(--dsw-alias-state-business-primary)}
  .nwSwitchKnob{position:absolute;top:4px;left:4px;width:22px;height:22px;border-radius:50%;background:var(--dsw-alias-switch-thumb);box-shadow:var(--dsw-elevation-soft);transition:left .18s;corner-shape:round}
  .nwSwitchOn .nwSwitchKnob{left:30px}
  .nwSwitch:disabled{opacity:.5;cursor:default;box-shadow:none}
  .nwSwitchSmall{appearance:none;flex:none;width:40px;height:22px;box-sizing:border-box;border-radius:999px;border:0;background:var(--dsw-alias-bg-layer-4);cursor:pointer;position:relative;padding:0;transition:background .16s,border-color .16s;corner-shape:round}
  .nwSwitchSmallOn{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
  .nwSwitchSmallKnob{position:absolute;top:4px;left:4px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:left .16s;corner-shape:round}
  .nwSwitchSmallOn .nwSwitchSmallKnob{left:22px}
  .nwSeg{display:flex;gap:3px;flex:none;background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-md);padding:3px}
  .nwSegBtn{appearance:none;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;padding:5px 10px;border-radius:var(--dsw-radius-sm);cursor:pointer;transition:background .16s,border-color .16s,color .16s;font-family:inherit}
  .nwSegBtn:hover{border-color:var(--dsw-alias-border-l3);font-family:inherit}
  .nwSegBtnOn{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:600}
  .nwSegBtn:disabled{opacity:.6;cursor:default;font-family:inherit}

  /* ===== 徽章 ===== */
  .nwBadge{flex:none;border-radius:999px;padding:3px 10px;font-size:12px;line-height:18px;font-weight:700;white-space:nowrap;letter-spacing:.5px;corner-shape:round}
  .nwBadgeOn{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary)}
  .nwBadgeOff{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary)}

  /* ===== 动画与杂项 ===== */
  @keyframes nwspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
  @keyframes nwflash{0%{background:var(--dsw-alias-state-success-tertiary)}100%{background:transparent}}
  /* v4.3.0：错误提示的红色闪烁（旧版错误分支恒不可达，见 PanelView msg 类名） */
  @keyframes nwflashErr{0%{background:var(--dsw-alias-state-error-secondary)}100%{background:transparent}}

  /* ===== 路径/按钮/状态 ===== */
  .nwPlotOk{color:var(--dsw-alias-state-success-primary)}
  .nwFlash{animation:nwflash 1.2s ease}
  .nwFlashErr{animation:nwflashErr 1.2s ease}
  .nwBtn.nwBtnDanger{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground);border-color:var(--dsw-alias-state-error-primary);font-family:inherit}
  .nwPlotBox{margin-top:6px;padding:6px 8px;background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-sm)}
  .nwPlotPath{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);word-break:break-all}
  .nwBtnGroup{display:flex;gap:6px;margin-top:6px}
  .nwBtn{font-size:11px;line-height:1;padding:5px 10px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;transition:background .16s var(--nw-ease),box-shadow .2s var(--nw-ease),transform .18s var(--nw-ease)}
  .nwBtn:hover{background:var(--dsw-alias-bg-layer-2);font-family:inherit}
  .nwBtn:disabled{opacity:.45;cursor:not-allowed;font-family:inherit}
  .nwPlotMsg{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin-top:4px;word-break:break-all}
  .nwPlotErr{color:var(--dsw-alias-label-error)}
  .nwStatus{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;word-break:break-all}
  .nwFoot{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;border-top:0.5px solid var(--dsw-alias-border-l2);padding-top:10px;margin-top:4px}
  .nwGroupState{width:16px;height:16px;border-radius:var(--dsw-radius-xs);border:0.5px solid var(--dsw-alias-border-l3);display:inline-flex;align-items:center;justify-content:center;position:relative;overflow:hidden;background:var(--dsw-alias-bg-layer-1);box-sizing:border-box}
  .nwGroupStateOn{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary)}
  .nwGroupStatePartial{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-1)}
  .nwGroupStateOff{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1)}
  .nwGroupStateCheck{color:var(--dsw-alias-label-primary-foreground);font-size:11px;font-weight:700;line-height:1}
  .nwGroupStateCheckPartial{width:10px;height:10px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-state-business-primary);color:transparent}

  /* ===== 非净化模式 ===== */
  .nwToolRow.nwToolRowRaw{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 5%,transparent);box-shadow:var(--dsw-elevation-panel)}
  .nwToolLabelRaw{color:var(--dsw-alias-label-error);font-weight:700}
  .nwRawDanger{color:var(--dsw-alias-label-error)!important;font-weight:600}
  .nwRawOn{font-size:11px;line-height:16px;color:var(--dsw-alias-label-error);margin-top:2px;font-weight:600}

  /* ===== 确认框（v5.2.0：面板内卡片，不再用全屏遮罩）===== */
  /* 旧版用写死的半透明黑遮罩、上一版换成宿主 mask token + backdrop-blur —— 两者都是"整屏遮罩"，
     会把整个应用（侧栏、会话、面板）糊成一片均匀的灰，用户直观感受就是"背景突变了"。
     但这两个确认框（先确认开启 / 再输入承诺文字）本来就是 PanelView 正文的一部分：
     它们出现时已经替换掉正常正文，所以**完全不需要遮罩**——做成一枚居中卡片即可，
     背景一点不变，也不会盖住侧栏与会话。 */
  .nwModal{display:block;margin:18px auto 0;width:100%;max-width:460px}
  .nwModalBox{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-panel);padding:18px 20px;box-shadow:var(--dsw-elevation-prominent)}
  .nwModalTitle{font-size:15px;font-weight:600;line-height:1.5;margin-bottom:8px}
  .nwModalText{font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary);white-space:pre-line;margin-bottom:14px}
  .nwModalInput{width:100%;box-sizing:border-box;padding:9px 11px;font:inherit;font-size:13px;line-height:20px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);margin-bottom:14px}
  .nwModalInput:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px var(--dsw-focus-ring-color)}
  .nwModalBtns{display:flex;gap:10px;justify-content:flex-end}
  /* 卡片里的按钮：给足点击面积，并与卡片底色拉开层次 */
  .nwModalBtns .nwBtn{min-width:88px;height:34px;padding:0 14px;font-size:13px;line-height:20px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
  .nwModalBtns .nwBtn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3))}
  .nwModalBtns .nwBtn.nwBtnDanger{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
  .nwModalBtns .nwBtnDanger:hover{filter:brightness(1.05)}
  /* 入场：卡片轻微上浮即可，不再有整屏淡入（并尊重系统「减少动态效果」设置） */
  @keyframes nwModalBoxIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion: no-preference){
    .nwModalBox{animation:nwModalBoxIn .18s ease-out}}

  /* ===== 工具行/开关/说明 ===== */
  .nwToolItem{width:100%;margin-bottom:6px}
  .nwToolItem .nwPlotBox{width:100%;box-sizing:border-box}
  .nwToolsHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:6px 0 12px}
  .nwToolRow{display:flex;align-items:center;gap:10px;border:0;background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-md);padding:8px 12px;box-shadow:var(--dsw-elevation-soft);transition:box-shadow .2s var(--nw-ease),transform .18s var(--nw-ease)}
  .nwToolRow:hover{box-shadow:var(--dsw-elevation-panel);transform:translateY(-1px)}
  .nwToolRow+.nwToolRow{margin-top:6px}
  .nwToolRowOn{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 6%,transparent);box-shadow:var(--dsw-elevation-panel)}
  .nwToolLabel{flex:1;min-width:0;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-primary)}
  .nwToolDesc{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary);margin-top:2px}

  /* ===== 工具组 ===== */
  .nwToolGroup{border:0;border-radius:var(--dsw-radius-md);margin-bottom:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft)}
  .nwToolGroupBody .nwToolRow{box-shadow:none;background:transparent;transform:none}
  .nwToolGroupBody .nwToolRow:hover{box-shadow:none;transform:none}
  .nwToolGroupHead{display:flex;align-items:center;gap:6px;width:100%;padding:9px 12px;background:var(--dsw-alias-bg-layer-2);border:none;cursor:default;font-size:13px;line-height:20px;text-align:left;color:inherit;font-family:inherit}
  .nwToolGroupHead:hover{background:var(--dsw-alias-bg-layer-3);font-family:inherit}
  .nwToolGroupIcon{font-size:15px;line-height:22px}
  .nwToolGroupName{font-weight:600}
  .nwToolGroupBadge{margin-left:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-error);background:var(--dsw-alias-state-error-secondary);border-radius:var(--dsw-radius-md);padding:1px 7px}
  .nwToolGroupArrow{font-size:12px;line-height:18px;opacity:.6}
  .nwToolGroupBody{padding:4px 8px 8px}
  .nwToolGroupToggle{flex:none;width:24px;height:24px;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;padding:0}
  .nwToolGroupHeadBtn{flex:1;display:flex;align-items:center;gap:8px;background:none;border:none;cursor:pointer;padding:0;text-align:left;color:inherit;font-size:13px;line-height:20px}
  .nwToolGroupHeadText{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .nwToolGroupDescInline{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary);font-weight:400;white-space:normal}

  /* ===== v5.2.0：官方主栏全局面板 ===== */
  /* 主栏页面：栅格、滚动容器与选中态都由宿主 layout 负责，这里只管内容排版 */
  .nwPanelMain{max-width:760px;margin:0 auto;padding:28px 24px 48px;gap:10px;box-sizing:border-box;height:100%;overflow:auto}

  /* ===== v5.5.0：官方语义类（内联样式收编 + 官方设置卡片材质）===== */
  .nwBoxed{background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:8px 12px}
  .nwSubCard{background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:10px 12px}
  .nwChip{height:24px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer;font-family:inherit;transition:background .16s var(--nw-ease),box-shadow .2s var(--nw-ease)}
  .nwChip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-family:inherit}
  .nwTextInput{height:32px;box-sizing:border-box;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-family:inherit}
  .nwTextArea{box-sizing:border-box;min-height:56px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-family:inherit}
  .nwSelect{height:32px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-family:inherit}
  .nwNote{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
  .nwMuted{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
  .nwSignOk{color:var(--dsw-alias-state-success-primary)}
  .nwSignBad{color:var(--dsw-alias-label-error)}
  .nwGutter{font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary);text-align:center}
  .nwDashedNote{margin-top:10px;padding:10px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
  .nwDividerRow{border-bottom:0.5px solid var(--dsw-alias-border-l2)}
  .nwSettingsCard{border-radius:var(--dsw-radius-xl);border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);padding:14px 16px}
  .nwSettingsCardTitle{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}
  .nwReportPre{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}
  .nwGroupName{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}
  .nwFileRow{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:7px 10px;cursor:pointer;font-family:inherit}
  .nwFileLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
  .nwStatRow{display:flex;align-items:center;gap:8px;font-size:11px;line-height:16px}
  .nwStatName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
  .nwChevron{font-size:13px;line-height:18px}
  .nwFieldLabel{display:flex;align-items:center;gap:6px;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
  .nwWarnBanner{border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);font-size:11px;line-height:16px}
  .nwNoteAccent{color:var(--dsw-alias-state-business-primary)}
  .nwNoteWarn{color:var(--dsw-alias-state-warn-label)}
  .nwNoteOk{color:var(--dsw-alias-state-success-primary)}
  .nwNoteDim{color:var(--dsw-alias-label-dimmed)}
  .nwAccentStrong{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-state-business-primary)}
  .nwTolSign{width:12px;flex:none;text-align:center;font-size:14px;line-height:20px;font-weight:600}
  .nwTolSign.nwSignOk{color:var(--dsw-alias-state-success-primary)}
  .nwTolSign.nwSignBad{color:var(--dsw-alias-label-error)}
  .nwInputErr{border-color:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px var(--dsw-alias-interactive-bg-hover-danger)}
  .nwCreationInput{width:100%;box-sizing:border-box;resize:vertical}
  .nwPlotBoxEmpty{color:var(--dsw-alias-label-tertiary)}
  
  .nwToolGroupHeadOpen{color:var(--dsw-alias-label-primary)}
  .nwTextInput:focus-visible,.nwTextArea:focus-visible,.nwSelect:focus-visible,.nwTolInput:focus-visible,.nwModalInput:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}

/* ===== v5.5.0：内联样式收编层（总负责人所有，拼在 A 的 CSS 之后）===== */
  /* 这些类承接原先写在 React 内联 style 里的**外观**（色值/圆角/字号/描边），
     使外观全部由 CSS + 官方语义 token 掌握：深浅主题自动跟随，不再有硬编码色值。
     只放 A 的清单里没有的类；A 已提供 nwBoxed / nwSubCard / nwChip / nwTextInput /
     nwTextArea / nwSelect / nwNote / nwMuted / nwSignOk / nwSignBad / nwGutter /
     nwDashedNote / nwDividerRow 的外观，这里不重复定义。 */
  /* 阈值行里的 +/- 记号：几何由这里给，颜色由 A 的 nwSignOk / nwSignBad 给 */
  /* 新建书名输入框的错误态：由 JS 加类（替代原先 ev.target.style 写死色值） */
  /* 输入类控件的键盘焦点：官方 focus.css 的全局兜底之外，再显式声明一次 */
  /* 设置页「插件卡」：官方设置卡片材质（R20 + 0.5px 发丝描边 + 卡片底色别名） */

  /* ===== 方案 B（官网式重构）：hero 头部 / 分区 kicker / 图标卡 / 状态 pill ===== */
  .nwHero{display:flex;flex-direction:column;gap:6px;border-radius:var(--dsw-radius-lg);padding:18px 18px 16px;background-color:var(--dsw-alias-bg-layer-1);background-image:radial-gradient(360px 130px at top center,color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent) 0%,transparent 72%);box-shadow:var(--dsw-elevation-soft)}
  .nwHero .nwBanner{background:transparent;border-color:transparent;padding:2px 0;box-shadow:none;letter-spacing:-.01em}
  .nwHero .nwBannerOn,.nwHero .nwBannerOff{background:transparent;border-color:transparent}
  .nwHeroDesc{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
  .nwSection{display:flex;flex-direction:column;gap:10px;margin-top:16px}
  .nwKicker{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;padding:3px 12px;border-radius:999px;corner-shape:round;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent);border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent);color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:17px;font-weight:700;letter-spacing:.06em}
  .nwKickerRule{width:100%;height:1px;background:var(--dsw-alias-border-l2)}
  .nwIconSlot{flex:none;width:34px;height:34px;display:flex;align-items:center;justify-content:center;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent);border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)}
  .nwIconGlyph{font-size:15px;line-height:20px;color:var(--dsw-alias-state-business-primary)}
  .nwPill{display:inline-flex;align-items:baseline;gap:8px;padding:7px 16px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-layer-2);transition:background .16s var(--nw-ease)}
  .nwPill:hover{background:var(--dsw-alias-bg-layer-3)}
  .nwPillKey{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
  .nwPillVal{font-size:13px;line-height:18px;font-weight:650;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
  /* 微交互总门：减少动态效果时关掉 hover 抬升与过渡（模态入场动画原本就在 no-preference 门内） */
  @media (prefers-reduced-motion: reduce){
    .nwRow,.nwNavEntry,.nwToolRow,.nwBtn,.nwChip,.nwPill,.nwSwitch,.nwSwitchKnob,.nwSegBtn{transition:none!important}
    .nwRow:hover,.nwNavEntry:hover,.nwToolRow:hover{transform:none!important}
  }
`;
    // v3.0.0-UI3：已存在旧 style 标签也覆盖内容——否则插件脚本重复执行时新 CSS 永不注入（UI 停留在旧版）
    if (typeof document !== "undefined") {
      var cssTag = document.querySelector("style[data-plugin-css=\"dsh-novel-writer\"]");
      if (cssTag) {
        if (cssTag.textContent !== css) cssTag.textContent = css;
      } else {
        cssTag = document.createElement("style");
        cssTag.dataset.plugin = "dsh-novel-writer";
        cssTag.dataset.pluginCss = "dsh-novel-writer";
        cssTag.textContent = css;
        document.head.appendChild(cssTag);
      }
    }

    // ---- 文案（zh / en）----
    var zh = {
      "entry.label": "写作助手功能",
      "entry.tooltip": "写作助手功能开关（dsh-novel-writer）：句式分析/风格自检/伏笔登记等",
      "panel.title": "写作助手功能",
      "panel.enabled": "启用写作助手功能",
      "panel.enabledHint": "总开关：控制句式模式分析与风格自检（novel_sentence_analysis / novel_style_check）。",
      "panel.autoAnalyze": "分析作品时自动使用",
      "panel.autoAnalyzeHint": "开启后，AI 在分析作品时会主动附带句式分析；关闭则仅在用户明确要求时使用。",
      "panel.spMode": "系统提示词",
      "panel.secSwitch": "开关",
      "panel.secPrompt": "提示词",
      "panel.secStatus": "状态",
      "panel.spModeHint": "控制插件往系统提示词里注入多少内容：关闭=完全不注入；精简=一句话（推荐）；完整=完整工作流说明。改完下一轮对话生效。",
      "sp.off": "关闭",
      "sp.brief": "精简",
      "sp.full": "完整",
      "panel.spScene": "提示词场景",
      "panel.spSceneHint": "完整档下注入哪一套流程：通用（默认，同旧版）/ 写新章 / 改稿 / 审计 / 建资料。场景只改变提示词内容，不影响工具能力。",
      // v5.1.1：档位非「完整」时，场景按钮此前是 disabled（点不动且无解释）——现在始终可点，改用这行说明"为什么暂时不生效"
      "panel.spSceneInactive": "当前档位不是「完整」，场景已保存但暂不注入——把上面的档位切到「完整」即生效。",
      "sc.general": "通用",
      "sc.writing": "写新章",
      "sc.revising": "改稿",
      "sc.auditing": "审计",
      "sc.setup": "建资料",
      "panel.leanWorkflow": "精简工作流",
      "panel.leanWorkflowHint": "不主动跑自检、不复测清单、不登记伏笔/钩子/摘要，只在你要求时调用工具——省 token，适合成本敏感的长篇",
      "panel.back": "Back",
      "panel.featuresTitle": "功能开关",
      "panel.featuresHint": "情感净化预警：剔除感官/爽感词干扰后提示 AI 复核真实情绪；题材与流派检测：detect 时输出主/副题材与设定流派。",
      "feature.webnovelVibe": "网文信号（风格检测内）",
      "feature.webnovelVibe.desc": "识别网文套路词与题材联动（打脸/秒杀/追妻火葬场），让甜宠/热血也能被识别",
      "feature.emotionCaveat": "情感净化预警（高级）",
      "feature.emotionCaveat.desc": "剔除成人向/爽文/极端反应类词汇，污染时提示 AI 抽查原文复核。",
      "feature.genreTheme": "题材与流派检测",
      "feature.genreTheme.desc": "detect 输出题材（骨）与流派（皮），低频噪音自动省略。",
      "feature.emotionComplexity": "情感量化",
      "feature.emotionComplexity.desc": "Valence 滑动窗口：方差/斜率/矛盾指数 + 隐性意象对比，模型读数字理解复杂情感。",
      "feature.semanticEmbedding": "语义增强（本地模型）",
      "feature.semanticEmbedding.desc": "本地 AI 模型提供语义级分析：按含义检索段落、对比文风、识别隐性情感。无需联网，模型缺失时自动回退规则模式。",
      "feature.semanticSearch": "语义检索",
      "feature.semanticSearch.desc": "按含义检索全书：描述你想找的内容，即使原文用词不同也能命中相关段落。",
      "feature.semanticStyle": "语义风格对比",
      "feature.semanticStyle.desc": "风格自检时附加语义相似度维度，与规则指纹互相印证。",
      "feature.semanticImplicit": "语义隐性情感",
      "feature.semanticImplicit.desc": "用情感原型句扫描全书，发现词表未覆盖的隐性情绪段落。",
      "feature.rawWriting": "非净化模式",
      "feature.rawWriting.desc": "模仿作者文风时还原原文直白程度（血腥/暴力/成人）。默认关闭，开启需双重确认。",
      "raw.on": "已开启（仅个人创作）",
      "raw.danger": "危险选项",
      "raw.confirmTitle": "敏感直白模式确认",
      "raw.confirmText": "开启后，AI 在模仿作者文风续写时将还原原文的直白/露骨描写（包括血腥、暴力、成人内容）。\n\n此功能仅用于个人创作与研究。请确认是否开启。",
      "raw.confirmWait": "请确认",
      "raw.confirmOk": "确认开启",
      "raw.cancel": "取消",
      "raw.promiseTitle": "承诺输入",
      "raw.promiseText": "请输入以下承诺以开启（必须包含「绝不传播」）：\n\n我承诺开启此功能仅用于个人创作与研究，绝不传播。",
      "raw.promisePlaceholder": "我承诺开启此功能仅用于个人创作与研究，绝不传播",
      "raw.promiseOk": "确认",
      "model.title": "小模型（本地语义引擎）",
      "model.manage": "管理",
      "model.hint": "总开关：语义增强。以下子功能独立开关，默认全开；关闭总开关后以下全部失效。",
      "dir.data": "数据目录",
      "dir.stateFile": "开关状态文件（state.json）",
      "dir.settings": "设定表存储",
      "dir.summaries": "章节摘要存储",
      "dir.audits": "审计报告存储",
      "dir.analysis": "分析缓存存储",
      "dir.embedding": "语义索引存储",
      "plot.copyFail": "复制失败（浏览器限制），请手动复制：",
      "panel.toolsTitle": "工具开关",
      "toolGroup.analyze": "📊 分析类",
      "toolGroup.analyze.desc": "浏览作品、统计关键词、句式与情感分析、风格自检、语义检索、连贯性审计——全面了解一本书。",
      "toolGroup.settings": "📚 设定类",
      "toolGroup.settings.desc": "维护人物、地点、道具、时间线设定，伏笔登记，章节摘要与稿件导入——作品的资料库。",
      "toolGroup.create": "✍️ 创作类",
      "toolGroup.create.desc": "新建章节与调整开关配置。",
      "group.allOn": "全部开启",
      "group.allOff": "全部关闭",
      "group.onCount": "{n} 开",
      "group.partial": "部分开启（点一下全部开启）",
      "panel.toolsHint": "全部默认开启。关闭后 AI 调用该工具会收到明确提示；可随时在此重新开启。",
      "panel.loading": "正在读取开关状态…",
      "panel.localOnly": "宿主端不可达，开关仅保存在本浏览器（重启后可能恢复默认）。",
      "panel.saveFailed": "保存到宿主端失败，已降级保存在本浏览器。",
      "panel.close": "关闭",
      "banner.on": "写作助手功能已启用",
      "banner.off": "写作助手功能已关闭",
      "badge.on": "已开启",
      "badge.off": "已关闭",
      "tool.novel_books": "作品列表 novel_books",
      "tool.novel_outline": "创作资料 novel_outline",
      "tool.novel_outline.desc": "维护原创小说创作设定/主要次要人物/剧情大纲/钩子记录/创作状态卡（novels/创作资料/<书名>/）；原创前必读状态卡与大纲，写完每章必回填钩子。",
      "tool.novel_chapters": "章节清单 novel_chapters",
      "tool.novel_read": "阅读章节 novel_read",
      "tool.novel_keywords": "关键词分析 novel_keywords",
      "tool.novel_new_chapter": "新建章节 novel_new_chapter",
      // v5.0.0：写作能力层两个新工具
      "tool.novel_chapter_brief": "开写包 novel_chapter_brief",
      "tool.novel_import": "稿件导入 novel_import",
      "tool.novel_sentence_analysis": "句式模式分析 novel_sentence_analysis",
      "tool.novel_style_check": "风格自检 novel_style_check",
      "tool.novel_fix_plan": "改稿台 novel_fix_plan",
      "tool.novel_style_report": "风格画像报告 novel_style_report",
      "tool.novel_plot": "伏笔登记 novel_plot",
      "tool.novel_books.desc": "列出书库中的全部作品（章节数/总字数）。",
      "tool.novel_chapters.desc": "查看某本书的章节清单与字数。",
      "tool.novel_read.desc": "阅读章节正文（支持分页与编码自动识别）。",
      "tool.novel_keywords.desc": "统计高频词汇：人名、意象、习惯用语一目了然。",
      "tool.novel_new_chapter.desc": "创建新章节文件（自动取下一章号）。",
      "tool.novel_chapter_brief.desc": "动笔前一次性取齐材料：上一章承接口、本章方向、相关人物、待回收伏笔、用语规范、风格基线与锚段。",
      "tool.novel_import.desc": "批量导入原稿件文件夹，自动识别书名并分类归档到书库。",
      "tool.novel_sentence_analysis.desc": "分析句子的长短节奏、类型分布与情感曲线，反映作者的写作习惯。",
      "tool.novel_style_check.desc": "对比本章与全书其余章节的风格相似度，检查文风是否一致。",
      "tool.novel_fix_plan.desc": "把风格诊断变成按优先级排好的待办（带原句定位与锚段），改完可复测；只给方向不生成正文。",
      "tool.novel_style_report.desc": "聚合六维测量数据（文风、词汇、题材、情感、氛围、语义距离），供 AI 判断风格气质。",
      "tool.novel_plot.desc": "登记/回收剧情伏笔，续写前查看未回收项。",
      "tool.novel_settings": "设定管理 novel_settings",
      "tool.novel_summary": "章节摘要 novel_summary",
      "tool.novel_continuity_check": "连贯性审计 novel_continuity_check",
      "tool.novel_semantic_search": "语义检索 novel_semantic_search",
      "tool.novel_settings.desc": "五张设定表：人物/地点/道具/时间线/世界观用语规范。",
      "tool.novel_summary.desc": "保存/读取每章摘要，长书续写先读摘要。",
      "tool.novel_continuity_check.desc": "对照设定表扫描全书，输出矛盾候选。",
      "tool.novel_semantic_search.desc": "按语义检索全书相关内容：即使段落未出现查询关键词，也能基于含义匹配。",
      "plot.pathLabel": "数据目录",
      "plot.pathUnknown": "位于书库根的 .novel-writer 文件夹（plots 伏笔 / settings 设定 / summaries 摘要 / analysis 分析报告）。先让 AI 调用一次 novel_plot 或 novel_settings，此处会显示真实路径。",
      "plot.open": "打开文件夹",
      "plot.copy": "复制路径",
      "plot.copied": "已复制",
      "plot.revealOk": "已打开文件夹",
      "plot.revealErr": "打开失败",
      "panel.refresh": "刷新",
      "panel.refreshed": "已刷新",
      "card.title": "小说写作助手 novel-writer",
      "card.desc": "句式模式分析：分析原文陈述/环境/心理/对话/疑问/反问/感叹等句子的排列节奏来辅助模仿文风。⚠️ 若机械套用导致文风僵硬，模型会优先回归自然表达。",
      "card.status": "写作助手功能：已启用 · 自动分析：开",
      "card.statusOff": "写作助手功能：已关闭",
      "card.statusAutoOff": "写作助手功能：已启用 · 自动分析：关",
      "card.hint": "全部开关统一在侧边栏「写作助手功能」面板（也可让 AI 用 novel_sentence_config 调整），本卡片仅显示状态。",
      "card.open": "打开开关面板",
      "dir.size": "数据目录占用",
      "model.engine": "语义引擎（本地模型）",
      "model.engineReady": "可用 · 模型已加载",
      "model.engineIdle": "可用 · 未加载（首次使用时自动加载）",
      "model.engineMissing": "模型文件缺失，语义功能不可用",
      "model.engineError": "加载失败：{err}",
      "model.engineUnknown": "状态未知",
      "update.title": "发现新版本",
      "update.go": "前往下载 →",
      "update.failed": "更新检查失败",
      "update.failedLast": "更新检查失败（上次成功：{time}）",
      "panel.baselineTitle": "风格基线",
      "panel.baselineHint": "六维文笔指标 ±% 容差带",
      "baseline.desc": "新章六维相对原书基线的允许偏离范围（%）。只填数字 0~99（正负号已按位置固定：低于=−、高于=+）；留空 = 使用推荐容差（原著章节波动的 1.5 倍，限 ±10%~100%）。",
      "baseline.save": "保存容差",
      "baseline.reset": "清除自定义（用推荐）",
      "baseline.saved": "容差已保存",
      "baseline.low": "低于%",
      "baseline.high": "高于%",
      "panel.creationTitle": "原创模式",
      "panel.creationHint": "创作设定（留空=让模型自己定）",
      "creation.worldview": "世界观",
      "creation.characters": "角色设定",
      "creation.forbidden": "不允许的事件",
      "creation.mainConflict": "主线目的",
      "creation.genre": "题材偏好",
      "creation.extra": "额外要求",
      "creation.listTitle": "设定库",
      "creation.desc2": "每本书一份设定（未建目录的新书也能预配置）；写书时模型自动用对应设定。",
      "creation.new": "＋ 新建设定",
      "creation.newPlaceholder": "输入新书书名…",
      "creation.default": "默认设定（新书/通用）",
      "creation.defaultHint": "没在设定库里的新书用这份",
      "creation.items": "项已填",
      "creation.none": "未填写（全部交给模型）",
      "creation.edit": "编辑",
      "creation.delete": "删除",
      "creation.deleted": "已删除该书设定",
      "creation.newed": "已创建设定，开始填写",
      "creation.needName": "请先输入新书书名",
      "creation.badName": "书名含非法字符（\\ / : * ? \" < > | 或结尾点/空格/系统保留名）",
      "reports.loading": "读取中…",
      "stats.pending": "统计未就绪（宿主未提供，点刷新重试）",
      "tol.recommend": "推荐",
      "tol.halfFilled": "维度",
      "tol.halfFilledTail": "」只填了低/高一边——容差需成对填写（或都留空用推荐）",
      "state.unreachable": "宿主端不可达",
      "reports.readFail": "读取失败",
      "reports.loading2": "加载中…",
      "demo.fail": "演示失败",
      "ph.e末": "例如：末日后异能世界…",
      "ph.e主": "例如：寻找失踪的同伴，解开身世之谜…",
      "ph.e女": "例如：女主冷静克制，有秘密…",
      "ph.e不": "例如：不能有重生/系统/金手指…",
      "ph.e悬": "例如：悬疑+救赎，都市背景…",
      "ph.e每": "例如：每章结尾留钩子，多对话…",
      "stats.empty": "书库为空——在 novels/ 放一本小说，或让 AI 原创一本",
      "stats.title": "书库统计",
      "stats.week": "7天",
      "stats.idle": "7天未动",
      "stats.chapters": "章",
      "stats.chars": "字",
      "demo.run": "🎬 体验演示",
      "demo.hint": "不落盘，5 秒看六维风格基线效果",
      "demo.loading": "演示中…",
      "reports.title": "报告历史",
      "reports.hint": "句式分析与风格判断的已存报告（.novel-writer/analysis 与 style-reports）",
      "reports.empty": "暂无报告——跑一次句式分析或风格画像后这里会出现",
      "reports.back": "‹ 返回",
      "creation.dirtyWarn": "有未保存的修改，切换将丢弃。继续？",
      "creation.formTitle": "编辑设定",
      "creation.bookFor": "设定应用书",
      "creation.save": "保存设定",
      "creation.clear": "清空",
      "creation.saved": "原创设定已保存",
      "creation.cleared": "已清空（全部交给模型）"
    };
    var en = {
      "entry.label": "Writing Assistant",
      "entry.tooltip": "Writing assistant switches (dsh-novel-writer): analysis / style check / plot tracking etc.",
      "panel.back": "Back",
      "panel.title": "Writing Assistant",
      "panel.enabled": "Enable writing assistant",
      "panel.enabledHint": "Master switch: controls novel_sentence_analysis and novel_style_check.",
      "panel.autoAnalyze": "Auto-use when analyzing works",
      "panel.autoAnalyzeHint": "When on, the AI proactively includes sentence analysis; otherwise only on explicit request.",
      "panel.spMode": "System prompt",
      "panel.secSwitch": "Switch",
      "panel.secPrompt": "Prompts",
      "panel.secStatus": "Status",
      "panel.spModeHint": "How much the plugin injects into the system prompt: Off = nothing; Brief = one line (recommended); Full = the complete workflow. Applies from the next turn.",
      "sp.off": "Off",
      "sp.brief": "Brief",
      "sp.full": "Full",
      "panel.spScene": "Prompt scene",
      "panel.spSceneHint": "Which workflow Full mode injects: General (default, same as before) / Drafting / Revising / Auditing / Setup. Affects prompt text only, not tool capabilities.",
      // v5.1.1: the scene buttons used to be disabled when the mode wasn't Full (no explanation) — now always clickable, with this note
      "panel.spSceneInactive": "The mode above isn't Full, so the scene is saved but not injected yet — switch the mode to Full to activate it.",
      "sc.general": "General",
      "sc.writing": "Drafting",
      "sc.revising": "Revising",
      "sc.auditing": "Auditing",
      "sc.setup": "Setup",
      "panel.leanWorkflow": "Lean workflow",
      "panel.leanWorkflowHint": "Skip auto self-checks, re-checks and registry updates — tools run only when you ask. Saves tokens on long books.",
      "panel.featuresTitle": "Feature switches",
      "panel.featuresHint": "Emotion caveat: strip physiological/euphoric words and ask the AI to re-check real tone. Genre/theme: output main/secondary theme and setting genre on detect.",
      "feature.webnovelVibe": "Webnovel signals",
      "feature.webnovelVibe.desc": "Recognizes webnovel trope words (face-slap/one-shot kill)",
      "feature.emotionCaveat": "Emotion caveat (advanced)",
      "feature.emotionCaveat.desc": "Strip adult-oriented/action/horror reaction words; warn and ask AI to sample-check when polluted.",
      "feature.genreTheme": "Genre & theme",
      "feature.genreTheme.desc": "detect outputs theme (core) and genre (skin); low-frequency noise omitted.",
      "feature.emotionComplexity": "Emotion quantification",
      "feature.emotionComplexity.desc": "Valence sliding window: variance/slope/conflict + implicit imagery compare; AI reads numbers.",
      "feature.semanticEmbedding": "Semantic enhancement (local model)",
      "feature.semanticEmbedding.desc": "Local bge-small-zh: semantic search for plot/emotion + style comparison. 0 token, auto-enabled, falls back to rules.",
      "feature.semanticSearch": "Semantic search",
      "feature.semanticSearch.desc": "novel_semantic_search: natural-language search across the book.",
      "feature.semanticStyle": "Semantic style compare",
      "feature.semanticStyle.desc": "novel_style_check adds semantic similarity (besides rule fingerprint).",
      "feature.semanticImplicit": "Semantic implicit emotion",
      "feature.rawWriting": "Uncensored Mode",
      "feature.rawWriting.desc": "Restore the original explicitness when mimicking author style (gore/violence/adult). Off by default; requires double confirmation.",
      "raw.on": "ON (personal creation only)",
      "raw.danger": "Dangerous option",
      "raw.confirmTitle": "Sensitive explicit mode confirmation",
      "raw.confirmText": "When enabled, the AI will restore the original explicitness (gore, violence, adult content) when continuing in the author's style.\n\nFor personal creation and research only.",
      "raw.confirmWait": "Confirm",
      "raw.confirmOk": "Enable",
      "raw.cancel": "Cancel",
      "raw.promiseTitle": "Promise input",
      "raw.promiseText": "Type the following promise to enable (must contain \"never distribute\"):\n\nI promise to use this feature for personal creation and research only, and never distribute it.",
      "raw.promisePlaceholder": "I promise to use this only for personal creation and research, never distribute",
      "raw.promiseOk": "Confirm",
      "feature.semanticImplicit.desc": "29 emotion prototypes scan the book for implicit imagery paragraphs.",
      "model.title": "Local model (semantic engine)",
      "model.manage": "Manage",
      "model.hint": "Master switch: semantic enhancement. Sub-switches below are independent; disabling the master disables all.",
      "dir.data": "Data dir",
      "dir.stateFile": "Switch state file (state.json)",
      "dir.settings": "Settings storage",
      "dir.summaries": "Summaries storage",
      "dir.audits": "Audit reports storage",
      "dir.analysis": "Analysis cache storage",
      "dir.embedding": "Semantic index storage",
      "plot.copyFail": "Copy failed (browser restriction), copy manually: ",
      "panel.toolsTitle": "Tool switches",
      "toolGroup.analyze": "📊 Analysis",
      "toolGroup.settings": "📚 Settings",
      "toolGroup.create": "✍️ Creation",
      "toolGroup.analyze.desc": "Browse books, keywords, sentence/emotion analysis, style check, semantic search, continuity audit.",
      "toolGroup.settings.desc": "Characters, locations, items, timeline, plot tracking, summaries and import — your story's database.",
      "toolGroup.create.desc": "New chapters and switch configuration.",
      "tool.novel_semantic_search.desc": "Semantic search (local embedding, 0 token): natural-language retrieval across the book.",
"group.allOn": "All on",
      "group.allOff": "All off",
      "group.onCount": "{n} on",
      "group.partial": "Partially on (click to toggle all)",
            "panel.toolsHint": "All on by default. Disabled tools return a clear notice; re-enable anytime here.",
      "panel.loading": "Loading switch state…",
      "panel.localOnly": "Host unreachable; kept in this browser only (defaults may return after restart).",
      "panel.saveFailed": "Host save failed; fell back to this browser.",
      "panel.close": "Close",
      "banner.on": "Writing assistant is ON",
      "banner.off": "Writing assistant is OFF",
      "badge.on": "ON",
      "badge.off": "OFF",
      "tool.novel_books": "Books novel_books",
      "tool.novel_outline": "Creation files novel_outline",
      "tool.novel_outline.desc": "Maintain creation settings/characters/outline/hooks/status (novels/创作资料/<book>/); read status & outline before writing, fill in each chapter hook after writing.",
      "tool.novel_chapters": "Chapters novel_chapters",
      "tool.novel_read": "Read novel_read",
      "tool.novel_keywords": "Keywords novel_keywords",
      "tool.novel_new_chapter": "New chapter novel_new_chapter",
      "tool.novel_chapter_brief": "Chapter brief novel_chapter_brief",
      "tool.novel_import": "Import novel_import",
      "tool.novel_sentence_analysis": "Pattern analysis novel_sentence_analysis",
      "tool.novel_style_check": "Style check novel_style_check",
      "tool.novel_fix_plan": "Fix plan novel_fix_plan",
      "tool.novel_style_report": "Style report novel_style_report",
      "tool.novel_style_report.desc": "Aggregates six measurement dimensions (style, vocabulary, theme, emotion, vibe, semantic distance) for AI to judge style.",
      "tool.novel_plot": "Plot tracking novel_plot",
      "tool.novel_books.desc": "List all books (chapters / total chars).",
      "tool.novel_chapters.desc": "List chapters of a book with sizes.",
      "tool.novel_read.desc": "Read chapter text (paged, auto-encoding).",
      "tool.novel_keywords.desc": "Extract keywords (bigrams / trigrams / name candidates).",
      "tool.novel_new_chapter.desc": "Create a new chapter file (next number auto).",
      "tool.novel_chapter_brief.desc": "One call to gather everything needed before writing: previous-chapter hand-off, chapter direction, characters, open hooks, wording rules, style baseline and anchors.",
      "tool.novel_import.desc": "Import raw drafts and auto-classify into the library.",
      "tool.novel_sentence_analysis.desc": "Pattern distribution / rhythm / emotion curve / fingerprint.",
      "tool.novel_style_check.desc": "Style similarity of this chapter vs the rest of the book.",
      "tool.novel_fix_plan.desc": "Turns style diagnostics into a prioritised to-do list (with line anchors and reference passages) and re-checks after edits. Direction only, never generates prose.",
      "tool.novel_plot.desc": "Track / close plot hooks; check before continuing.",
      "tool.novel_settings": "Settings novel_settings",
      "tool.novel_summary": "Summaries novel_summary",
      "tool.novel_continuity_check": "Continuity novel_continuity_check",
      "tool.novel_semantic_search": "Semantic search novel_semantic_search",
      "tool.novel_settings.desc": "Five tables: characters / locations / items / timeline / worldview wording rules.",
      "tool.novel_summary.desc": "Store / read per-chapter summaries.",
      "tool.novel_continuity_check.desc": "Scan against settings, list contradiction candidates.",
      "plot.pathLabel": "Data dir",
      "plot.pathUnknown": "Located in .novel-writer under the library root (plots / settings / summaries / analysis). Ask the AI to run novel_plot or novel_settings once to show the real path.",
      "plot.open": "Open folder",
      "plot.copy": "Copy path",
      "plot.copied": "Copied",
      "plot.revealOk": "Opened",
      "plot.revealErr": "Open failed",
      "panel.refresh": "Refresh",
      "panel.refreshed": "Refreshed",
      "card.title": "Novel Writer (dsh-novel-writer)",
      "card.desc": "Sentence-pattern analysis: reads the rhythm of statements/environment/inner-thought/dialogue/questions etc. to help mimic the author's style. ⚠️ If mechanical imitation stiffens the prose, natural expression wins.",
      "card.status": "Writing assistant: ON · auto-analyze: ON",
      "card.statusOff": "Writing assistant: OFF",
      "card.statusAutoOff": "Writing assistant: ON · auto-analyze: OFF",
      "card.hint": "All switches live in the sidebar 'Writing Assistant' panel (or ask the AI to run novel_sentence_config); this card only shows status.",
      "card.open": "Open the switch panel",
      "dir.size": "Data dir usage",
      "model.engine": "Semantic engine (local model)",
      "model.engineReady": "Ready · model loaded",
      "model.engineIdle": "Ready · lazy-loaded on first use",
      "model.engineMissing": "Model files missing, semantic features unavailable",
      "model.engineError": "Load failed: {err}",
      "model.engineUnknown": "Unknown",
      "update.title": "New version available",
      "update.go": "Download →",
      "update.failed": "Update check failed",
      "update.failedLast": "Update check failed (last success: {time})",
      "panel.baselineTitle": "Style Baseline",
      "panel.baselineHint": "±% tolerance band for six writing metrics",
      "baseline.desc": "Allowed deviation (%) of new chapters from the book baseline. Enter 0-99 only (signs fixed by position: below=−, above=+); leave blank to use the recommended tolerance (1.5× the book chapter variance, clamped ±10%~100%). Out-of-band triggers correction — theme is free, writing style stays in the band.",
      "baseline.save": "Save tolerance",
      "baseline.reset": "Reset default",
      "baseline.saved": "Tolerance saved",
      "baseline.low": "Below %",
      "baseline.high": "Above %",
      "panel.creationTitle": "Original Mode",
      "panel.creationHint": "Creation settings (blank = let the model decide)",
      "creation.worldview": "Worldview",
      "creation.characters": "Characters",
      "creation.forbidden": "Forbidden events",
      "creation.mainConflict": "Main conflict",
      "creation.genre": "Genre",
      "creation.extra": "Extra requirements",
      "creation.listTitle": "Settings library",
      "creation.desc2": "One profile per book (new books without a folder can be pre-configured); the model uses the matching profile automatically.",
      "creation.new": "+ New profile",
      "creation.newPlaceholder": "Enter new book name…",
      "creation.default": "Default (new / general)",
      "creation.defaultHint": "Used for new books not in the library",
      "creation.items": "filled",
      "creation.none": "Not filled (model decides)",
      "creation.edit": "Edit",
      "creation.delete": "Delete",
      "creation.deleted": "Profile deleted",
      "creation.newed": "Profile created, start filling",
      "creation.needName": "Please enter a book name first",
      "creation.badName": "Invalid book name (\\ / : * ? \" < > | or trailing dot/space / reserved name)",
      "reports.loading": "Loading…",
      "stats.pending": "Stats pending (host unavailable — press refresh)",
      "tol.recommend": "recommended",
      "tol.halfFilled": "Dimension",
      "tol.halfFilledTail": " — fill both low & high (or leave both empty to use recommended)",
      "state.unreachable": "host unreachable",
      "reports.readFail": "Failed to read",
      "reports.loading2": "Loading…",
      "demo.fail": "Demo failed",
      "ph.e末": "e.g. post-apocalyptic world with abilities…",
      "ph.e主": "e.g. find the missing companion and unravel the mystery of her origins…",
      "ph.e女": "e.g. cool-headed heroine with secrets…",
      "ph.e不": "e.g. no rebirth/system/golden finger…",
      "ph.e悬": "e.g. suspense + redemption, urban setting…",
      "ph.e每": "e.g. cliffhanger endings, dialogue-heavy…",
      "stats.empty": "Library empty — put a novel in novels/, or ask AI to create one",
      "stats.title": "Library stats",
      "stats.week": "/7d",
      "stats.idle": "idle 7d",
      "stats.chapters": " ch",
      "stats.chars": " chars",
      "demo.run": "🎬 Try demo",
      "demo.hint": "No files written — see the 6-dimension baseline in 5s",
      "demo.loading": "Running…",
      "reports.title": "Report history",
      "reports.hint": "Saved sentence & style reports (.novel-writer/analysis and style-reports)",
      "reports.empty": "No reports yet — run an analysis first",
      "reports.back": "‹ Back",
      "creation.dirtyWarn": "Unsaved changes will be lost. Continue?",
      "creation.formTitle": "Edit profile",
      "creation.bookFor": "Applied book",
      "creation.save": "Save settings",
      "creation.clear": "Clear",
      "creation.saved": "Original settings saved",
      "creation.cleared": "Cleared (all decided by model)"
    };
    // v4.3.0：语言判定统一出口——优先宿主 locale 服务（inject 声明的 locale 由此真正生效），
    // 服务不可用时回退 <html lang>（宿主 @deepseek-ai/dsh-client-locale 会同步该属性）
    function currentLang() {
      if (localeId !== "") return localeId;
      if (typeof document !== "undefined" && document.documentElement && document.documentElement.lang) return document.documentElement.lang;
      return "zh";
    }
    function isEnglish() {
      return String(currentLang()).toLowerCase().startsWith("en");
    }
    function dictionary() {
      return isEnglish() ? en : zh;
    }
    function t(key) {
      var text = dictionary()[key];
      return text === void 0 ? key : text;
    }

    // ---- 与宿主端同步 ----
    var STATE_ROUTE = "/api/dsh-novel-writer/state";
    var STORAGE_KEY = "dsh.novelWriter.state.v1";
    // v4.3.0：统一请求超时——宿主 GET /state 会递归遍历数据目录 + 统计全书章节字数，
    // 数据目录很大或宿主挂起时 fetch 永不 settle：面板永久 loading、开关全 disabled 且没有任何提示
    var FETCH_TIMEOUT_MS = 8000;
    // v4.3.0：超时信号（特性检测：AbortSignal.timeout → AbortController → 无信号可用时退化为不超时）
    function makeTimeoutSignal(ms) {
      var wait = typeof ms === "number" && ms > 0 ? ms : FETCH_TIMEOUT_MS;
      try {
        if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
          return AbortSignal.timeout(wait);
        }
      } catch { /* 环境不完整时继续降级 */ }
      try {
        if (typeof AbortController === "function") {
          var controller = new AbortController();
          // 定时器触发即中止；不主动清理（到期自清），避免请求体读取阶段失去超时保护
          setTimeout(function () { try { controller.abort(); } catch { /* ignore */ } }, wait);
          return controller.signal;
        }
      } catch { /* 无 AbortController 时退化 */ }
      return void 0;
    }
    // v4.3.0：带超时的 fetch（浏览器端 API；无信号可用时等同普通 fetch）
    function fetchWithTimeout(url, init, ms) {
      var options = Object.assign({}, init || {});
      var signal = makeTimeoutSignal(ms);
      if (signal !== void 0) options.signal = signal;
      return fetch(url, options);
    }
    // v4.3.0：非 2xx 也先解析宿主 JSON，取可操作错误（照 openDir 已修好的写法：
    // 宿主会返回 {error:"报告不存在"} / {error:"request body too large (limit 1MB)"} / forbidden: loopback-only）
    function hostError(response) {
      return response.json().catch(function () { return {}; }).then(function (d) {
        var detail = d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + response.status;
        return new Error(detail);
      });
    }
    // v4.3.0：区分"宿主给了可操作错误"（原样透传）与"根本没连上"（降级成宿主端不可达）
    function errorText(err) {
      if (err instanceof TypeError) return t("state.unreachable");
      var name = err && typeof err.name === "string" ? err.name : "";
      if (name === "AbortError" || name === "TimeoutError") return t("state.unreachable");
      var msg = err && typeof err.message === "string" ? err.message.trim() : "";
      return msg === "" ? t("state.unreachable") : msg;
    }
    async function fetchState() {
      var response = await fetchWithTimeout(STATE_ROUTE, { headers: { accept: "application/json" } });
      if (!response.ok) throw await hostError(response);
      return await response.json();
    }
    async function saveState(patch) {
      var response = await fetchWithTimeout(STATE_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(patch)
      });
      if (!response.ok) throw await hostError(response);
      return await response.json();
    }

    // ---- 迷你控制器 ----
    function createController() {
      var listeners = new Set();
      var toggleRef = null;
      // v4.3.0：在途 POST 计数——rev 只统计"非 silent 写入"，看不到已发出但未返回的保存请求，
      // 刷新/首载会把宿主的旧值回写进 UI（用户刚切的总开关又跳回去）
      var pendingWrites = 0;
      var state = {
        enabled: true,
        autoAnalyze: true,
        systemPromptMode: "brief",
        // v5.0.0：提示词场景（与档位正交）；老宿主不返回该字段 → general，行为与 4.x 一致
        promptScene: "general",
        // v5.0.0：精简工作流（全局布尔，与档位/场景同级；老宿主不返回该字段 → false，行为与 5.0.0 之前一致）
        leanWorkflow: false,
        tools: {},
        file: "",
        loading: true,
        hostOk: true,
        saveFailed: false,
        panelOpen: false,
        plotsDir: "",
        dataDir: "",
        dataDirSize: 0,
        embeddingStatus: null,
        updateCheck: null,
        styleTolerance: null,
        baselineDraft: null,
        baselineSaved: false,
        creationProfile: null,
        creationProfiles: {},
        creationDraft: null,
        creationDirty: false,
        creationBook: "",
        creationNewBook: "",
        books: [],
        booksStats: null, // null=未就绪（宿主未提供），[]=真空
        demoReport: null,
        demoLoading: false,
        reportsGroups: null,
        reportContent: null,
        features: {},
        dirs: null,
        view: "main",
        refreshing: false,
        refreshedAt: 0,
        revealMsg: "",
        revealErr: false,
        revealing: false,
        rawModal: false,
        rawCountdown: 0,
        rawPromiseOpen: false,
        rawPromiseText: "",
        rawPromiseOk: false
      };
      var api = {
        getSnapshot: function () { return state; },
        // v4.3.0：在途写入登记（toggle 的 POST 期间调用），供 GET 侧竞态守卫判断
        beginWrite: function () { pendingWrites += 1; },
        endWrite: function () { pendingWrites = pendingWrites > 0 ? pendingWrites - 1 : 0; },
        pendingWrites: function () { return pendingWrites; },
        // v4.3.0：GET 回写的竞态守卫——rev 变了（用户操作过）或有在途 POST 时都不得用远端覆盖本地
        staleGuard: function (revAt) { return api.getSnapshot().rev !== revAt || pendingWrites > 0; },
        set: function (patch, opts) {
          Object.assign(state, patch);
          // v3.5.0 R4：每次状态变更自增版本号（竞态守卫用，对象引用比较是死代码）
          // v4.0.0 修正：opts.silent=true 的后台写入（如 update-check）不参与"用户是否操作过"的竞态计数
          if (!opts || opts.silent !== true) state.rev = (state.rev || 0) + 1;
          // v4.0.0 修正：写入新的提示条时复位 refreshedAt——此前一旦刷新过，之后"已复制/已保存"等所有提示都带 nwFlash 动画
          if (patch.revealMsg !== void 0 && patch.revealMsg !== "" && patch.refreshedAt === void 0) state.refreshedAt = 0;
          listeners.forEach(function (fn) { fn(state); });
        },
        subscribe: function (fn) {
          listeners.add(fn);
          return function () { listeners.delete(fn); };
        },
        refresh: function () {
          if (api.getSnapshot().refreshing) return Promise.resolve(null);
          // v4.0.0 修正：刷新标志属纯 UI 状态，silent 写入不参与 rev 竞态计数（否则刷新期间点导航就会误判"用户已操作"）
          api.set({ refreshing: true, revealMsg: "", revealErr: false }, { silent: true });
          // v3.5.0 R4：记录请求发起时的版本号——返回时版本未变（用户没操作）才用远端覆盖开关/设定
          // v4.3.0：改判 staleGuard（rev + 在途 POST），否则在途保存尚未落盘时刷新会把宿主旧值回写
          var revAt = api.getSnapshot().rev;
          return fetchState().then(function (remote) {
            var stale = api.staleGuard(revAt);
            api.set({
              // v3.7.0 ②：enabled/autoAnalyze 与 tools/features 同样受竞态守卫（慢请求不覆盖用户刚切的总开关）
              enabled: (stale ? api.getSnapshot().enabled : !!remote.enabled),
              autoAnalyze: (stale ? api.getSnapshot().autoAnalyze : !!remote.autoAnalyze),
              // v4.3.0：补 systemPromptMode——load/toggle 都回读，唯独刷新漏读，三档提示词开关刷新后显示旧值
              systemPromptMode: (stale ? (api.getSnapshot().systemPromptMode || "brief") : (remote.systemPromptMode || "brief")),
              // v5.0.0：同步场景（刷新路径同样不能漏读，否则场景行显示旧值）
              promptScene: (stale ? (api.getSnapshot().promptScene || "general") : (remote.promptScene || "general")),
              // v5.0.0：精简工作流（刷新路径同样不能漏读；严格 === true——字符串/数字脏值不当成"开"）
              leanWorkflow: (stale ? api.getSnapshot().leanWorkflow === true : remote.leanWorkflow === true),
              // v3.5.0 R4：请求期间版本未变（用户没操作）才用远端覆盖开关——慢请求不覆盖用户刚切的
              tools: (stale ? (api.getSnapshot().tools || {}) : (remote.tools || {})),
              features: (stale ? (api.getSnapshot().features || {}) : (remote.features || {})),
              plotsDir: remote.plotsDir || "",
              dataDir: remote.dataDir || "",
              dataDirSize: remote.dataDirSize || 0,
              embeddingStatus: remote.embeddingStatus || null,
              styleTolerance: (stale ? (api.getSnapshot().styleTolerance || null) : (remote.styleTolerance || null)),
              creationProfile: (stale ? (api.getSnapshot().creationProfile || null) : (remote.creationProfile || null)),
              creationProfiles: (stale ? (api.getSnapshot().creationProfiles || {}) : (remote.creationProfiles || {})),
              books: remote.books || [],
              booksStats: typeof remote.booksStats === "undefined" ? null : (remote.booksStats || []),
              dirs: remote.dirs || null,
              file: remote.file || "",
              hostOk: true,
              // v4.0.0 修正：刷新成功同样清除"保存失败"横幅（与 load() 成功分支的 saveFailed:false 对齐）
              saveFailed: false,
              loading: false,
              refreshing: false,
              refreshedAt: Date.now(),
              revealMsg: t("panel.refreshed") + " " + new Date().toLocaleTimeString(),
              revealErr: false
            }, { silent: true });
            return remote;
          }).catch(function (err) {
            // v4.0.0 修正：取错文案——刷新失败此前复用"打开失败"（plot.revealErr），改为"读取失败"（reports.readFail）
            // v4.3.0：宿主给出的可操作错误（如 500 "state read failed: …" / 403 loopback-only）原样透传
            api.set({ hostOk: false, revealMsg: t("reports.readFail") + "：" + errorText(err), revealErr: true }, { silent: true });
            return null;
          }).finally(function () {
            // v4.3.0：统一在 finally 摘掉刷新/加载标志——任一步抛错都不会让按钮永久转圈
            api.set({ loading: false, refreshing: false }, { silent: true });
          });
        },
        openDir: function (target) {
          api.set({ revealMsg: "", revealErr: false, revealing: true }, { silent: true });
          fetchWithTimeout("/api/dsh-novel-writer/reveal", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ target: target || "data-dir" })
          }).then(function (r) {
            // v4.0.0 修正：非 2xx 也先解析 body，取宿主返回的可操作错误（此前直接 throw → 一律降级成"宿主端不可达"）
            if (r.ok) return r.json();
            return r.json().catch(function () { return {}; }).then(function (d) {
              var detail = d && typeof d.error === "string" && d.error !== "" ? d.error : t("plot.revealErr") + "：HTTP " + r.status;
              api.set({ revealMsg: detail, revealErr: true }, { silent: true });
              return null;
            });
          }).then(function (data) {
            if (data === null) return;
            if (data.ok === true) {
              api.set({ revealMsg: t("plot.revealOk") + "：" + (data.path || ""), revealErr: false }, { silent: true });
            } else {
              api.set({ revealMsg: data.error || t("plot.revealErr"), revealErr: true }, { silent: true });
            }
          }).catch(function (err) {
            api.set({ revealMsg: t("plot.revealErr") + "：" + errorText(err), revealErr: true }, { silent: true });
          }).finally(function () {
            api.set({ revealing: false }, { silent: true });
          });
        },
        copyPath: function (dir) {
          if (!dir || dir === "") {
            api.set({ revealMsg: t("plot.pathUnknown"), revealErr: true }, { silent: true });
            return;
          }
          var done = function (ok) {
            if (ok === false) {
              api.set({ revealMsg: t("plot.copyFail") + "：" + dir, revealErr: true }, { silent: true });
            } else {
              api.set({ revealMsg: t("plot.copied") + "：" + dir, revealErr: false }, { silent: true });
            }
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(dir).then(function () { done(true); }, function () { done(false); });
          } else {
            // v3.5.0 #45：非安全上下文实际没复制成功——如实报失败并给出路径
            done(false);
          }
        },
        setToggle: function (fn) { toggleRef = fn; },
        // v4.0.0 修正：导航/分组展开属纯 UI 状态，silent 写入不得自增 rev——否则刷新期间点一下导航，远端开关值会被守卫静默丢弃
        openView: function (view) { api.set({ view: view, revealMsg: "", revealErr: false }, { silent: true }); },
        setToolGroupOpen: function (patch) { api.set({ toolGroupOpen: Object.assign({}, state.toolGroupOpen || {}, patch) }, { silent: true }); },
        rawToggle: function (wantOn) {
          if (!wantOn) {
            if (rawTimer) { clearInterval(rawTimer); rawTimer = null; }
            if (toggleRef) toggleRef({ features: { rawWriting: false } });
            api.set({ rawModal: false, rawCountdown: 0, rawPromiseOpen: false, rawPromiseText: "", rawPromiseOk: false }, { silent: true });
            return;
          }
          api.set({ rawModal: true, rawCountdown: 3, rawPromiseOpen: false, rawPromiseText: "", rawPromiseOk: false }, { silent: true });
          // v3.5.0 #43：timer 存模块级引用，取消/确认时统一清理（防双定时器竞争）
          if (rawTimer) clearInterval(rawTimer);
          rawTimer = setInterval(function () {
            var n = api.getSnapshot().rawCountdown - 1;
            if (n <= 0) { clearInterval(rawTimer); rawTimer = null; api.set({ rawCountdown: 0 }, { silent: true }); }
            else api.set({ rawCountdown: n }, { silent: true });
          }, 1000);
        },
        rawConfirm: function () { if (rawTimer) { clearInterval(rawTimer); rawTimer = null; } api.set({ rawModal: false, rawPromiseOpen: true, rawPromiseText: "", rawPromiseOk: false }, { silent: true }); },
        rawCancel: function () { if (rawTimer) { clearInterval(rawTimer); rawTimer = null; } api.set({ rawModal: false, rawCountdown: 0, rawPromiseOpen: false, rawPromiseText: "", rawPromiseOk: false }, { silent: true }); },
        rawSetPromise: function (text) {
          // v3.5.0 #36：按当前语言校验（中文"绝不传播" / 英文"never distribute"）
          // v4.3.0：语言判定改用 isEnglish()（locale 服务优先）
          var isEn = isEnglish();
          var kw = isEn ? "never distribute" : "绝不传播";
          var ok = String(text || "").toLowerCase().indexOf(kw) !== -1 && String(text || "").length >= 5;
          api.set({ rawPromiseText: text || "", rawPromiseOk: ok }, { silent: true });
        },
        rawPromiseConfirm: function () {
          if (!api.getSnapshot().rawPromiseOk) return;
          if (rawTimer) { clearInterval(rawTimer); rawTimer = null; }
          if (toggleRef) toggleRef({ features: { rawWriting: true } });
          api.set({ rawPromiseOpen: false, rawPromiseText: "", rawPromiseOk: false, rawModal: false, rawCountdown: 0 }, { silent: true });
        }
      };
      return api;
    }

    // ---- 侧边栏入口 ----
    function sidebarRoot() {
      // v4.3.0：删掉永不匹配的 [data-pane="sidebar"]（宿主全树 0 命中；真实标记是 CSS-module 的 …_sidebarCol）
      var column = document.querySelector('[class*="sidebarCol"]');
      if (column === null) return void 0;
      // v4.0.0 修正：firstElementChild 可能为 null（侧边栏列存在但暂无子元素），必须归一化为 undefined，
      // 否则 null 会被 ??= 写进 root，之后 tryPlace 对 null 取属性抛 TypeError，入口永久挂不上
      return column.querySelector('[class*="logoRow"]')?.parentElement ?? column.firstElementChild ?? void 0;
    }
    function newSessionButton(root) {
      var nested = root.querySelector("button[class*=newSession]");
      if (nested !== null) return nested;
      for (var i = 0; i < root.children.length; i += 1) {
        var child = root.children[i];
        if (child.tagName === "BUTTON") return child;
      }
      return void 0;
    }
    function placeEntry(root, entry) {
      var family = Array.from(root.children).filter(function (el) {
        return el instanceof HTMLElement && el.matches("[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-novel-writer-entry]");
      });
      var button = newSessionButton(root);
      // v4.0.0 修正：newSession 按钮尚未渲染时返回 false（保持重试），此前无条件 return true 会把入口钉死在坏位置
      if (button === void 0) return false;
      // v4.0.0 修正：宿主把 newSession 嵌在 logoRow 内部，button.nextElementSibling 恒为 null →
      // 入口会被追加到侧边栏最底部；应以 button 所在的 logoRow 作为基准行（与同作者 dsh-ssh 实现一致）
      var row = button.closest('[class*="logoRow"]');
      var base = row !== null && row.parentElement === root ? row : button;
      var anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling;
      root.insertBefore(entry, anchor);
      return true;
    }
    function mountSidebarEntry(controller, onOpen) {
      var entry = document.createElement("button");
      entry.type = "button";
      entry.dataset.dshNovelWriterEntry = "";
      entry.className = "nwEntry";
      // v4.0.0 修正：文案抽成函数并订阅 lang 变更——此前只在挂载时写一次，运行期切换语言后入口仍是旧语言
      var applyLabel = function () {
        entry.setAttribute("aria-label", t("entry.label"));
        entry.setAttribute("title", t("entry.tooltip"));
        entry.innerHTML = '<span class="nwEntryIcon">✒</span><span class="nwEntryLabel">' + t("entry.label") + "</span>";
      };
      applyLabel();
      entry.addEventListener("click", function () {
        onOpen();
        syncActive();
      });
      var root;
      var placed = false;
      var syncActive = function () {
        if (controller.getSnapshot().panelOpen) entry.dataset.active = "true";
        else delete entry.dataset.active;
      };
      var stopped = false; // v4.0.0：卸载后不再重排（rAF 里的待执行回调会晚于 disposer）
      var rewatchBody = function () {
        // v4.0.0 修正：root 失效后重新挂全页兜底监听，等待宿主重建侧边栏列
        try { waitObserver.observe(document.body, { childList: true, subtree: true }); } catch { /* body 不可观察时静默降级 */ }
      };
      var tryPlace = function () {
        if (stopped) return;
        // v4.0.0 修正：null 与 undefined 一律视为"没有 root"（sidebarRoot 归一化后的双保险）
        if (root != null && !root.isConnected) {
          rootObserver.disconnect();
          root = void 0;
          placed = false;
          rewatchBody();
        }
        if (placed) {
          if (document.body.contains(entry)) return;
          rootObserver.disconnect();
          root = void 0;
          placed = false;
          rewatchBody();
        }
        root ??= sidebarRoot();
        if (root == null) return;
        placed = placeEntry(root, entry);
        if (placed) rootObserver.observe(root, { childList: true, subtree: true });
      };
      var pendingPlace = false;
      // v4.0.0 修正：全页 subtree 变更按帧合并——此前每次 DOM 变更都跑一次 tryPlace，流式回答/思考面板时持续空转
      var waitObserver = new MutationObserver(function () {
        if (pendingPlace) return;
        pendingPlace = true;
        var run = function () { pendingPlace = false; tryPlace(); };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
        else run();
      });
      // v3.5.0 #44：observe 失败容错（不影响 mountPanel 挂载）
      try { waitObserver.observe(document.body, { childList: true, subtree: true }); } catch { /* body 不可观察时静默降级 */ }
      var rootObserver = new MutationObserver(function () {
        if (stopped) return;
        if (root == null || !root.isConnected) {
          placed = false;
          tryPlace();
          return;
        }
        if (!root.contains(entry)) placed = placeEntry(root, entry);
      });
      // v4.0.0 修正：语言切换（documentElement.lang）时刷新入口文案，顺带修掉"首帧早于 locale 同步"的旧语言残留
      // v4.3.0：同时触发一次同步——此前只有入口更新，面板内文案停留在旧语言（isEn 是渲染期快照，不重渲染就不刷新）
      var langObserver = new MutationObserver(function () { applyLabel(); controller.set({}, { silent: true }); });
      try { langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] }); } catch { /* 不可观察时静默降级 */ }
      var unsubscribe = controller.subscribe(function () { applyLabel(); syncActive(); });
      syncActive();
      tryPlace();
      return function () {
        stopped = true;
        // v3.7.0 ⑤：卸载时清理 rawTimer 倒计时（防 interval 泄漏）
        if (rawTimer) { clearInterval(rawTimer); rawTimer = null; }
        waitObserver.disconnect();
        rootObserver.disconnect();
        langObserver.disconnect();
        unsubscribe();
        entry.remove();
      };
    }

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
      var el = react.createElement;
      // v4.0.0 修正：三元优先级错误——此前 nwFlash 只拼在 nwPlotOk 分支，错误提示永远拿不到闪烁类
      // v4.3.0 修正：错误分支此前要求 refreshedAt>0，而任何新提示写入都会把 refreshedAt 归零 → "错误提示也闪烁"恒不可达，
      // 这里把错误闪烁改成独立分支（红色 nwFlashErr），成功/刷新提示仍沿用 refreshedAt 判定的绿色 nwFlash
      var msgCls = state.revealErr ? "nwPlotErr nwFlashErr" : ("nwPlotOk" + (state.refreshedAt > 0 ? " nwFlash" : ""));
      var msg = state.revealMsg !== "" ? el("div", { className: "nwPlotMsg " + msgCls }, state.revealMsg) : null;
      // v4.3.0：加载期提示（panel.loading 词条早就存在却从未渲染——宿主 /state 挂起时面板只有一排灰按钮，用户不知道在等什么）
      var loadingHint = state.loading ? el("div", { className: "nwStatus" }, "⟳ " + t("panel.loading")) : null;
      var entry = function (title, hint, count, viewName) {
        return el("button", { type: "button", className: "nwNavEntry", onClick: function () { props.controller.openView(viewName); } },
          el("div", { className: "nwIconSlot" }, el("span", { className: "nwIconGlyph" }, viewName === "features" ? "⚙" : viewName === "tools" ? "🛠" : viewName === "creation" ? "📖" : viewName === "baseline" ? "🎯" : "▸")),
          el("div", { className: "nwNavEntryText" },
            el("div", { className: "nwNavEntryTitle" }, title),
            el("div", { className: "nwNavEntryHint" }, hint)
          ),
          el("div", { className: "nwNavEntryRight" },
            count === null ? null : el("span", { className: "nwBadge " + (count > 0 ? "nwBadgeOn" : "nwBadgeOff") }, (function () {
              // v4.0.0 修正：t() 缺键返回键名本身（永不为假值），此前 || 兜底恒不生效——改为显式判占位符
              var tpl = t("group.onCount");
              return (tpl.indexOf("{n}") === -1 ? "{n} 开" : tpl).replace("{n}", count);
            })()),
            el("span", { className: "nwNavEntryArrow" }, "›")
          )
        );
      };
      var backBtn = function () {
        return el("button", { type: "button", className: "nwBackBtn", onClick: function () {
            // v3.7.0 ④：creation-form 返回前 dirty 确认（与 switchBook 同机制，防静默丢修改）
            if (view === "creation-form" && state.creationDirty && !window.confirm(t("creation.dirtyWarn"))) return;
            props.controller.openView(view === "reports" || view === "creation" ? "main" : view === "baseline" ? "main" : view === "creation-form" ? "creation" : view === "model" ? "features" : "main");
          } }, "‹ " + t("panel.back"));
      };
      var switchRow = function (name, fOn, onToggle, extra) {
        return el("div", { className: "nwToolRow" + (fOn ? " nwToolRowOn" : ""), key: name },
          el("div", { className: "nwIconSlot" }, el("span", { className: "nwIconGlyph" }, name === "emotionCaveat" ? "💧" : name === "emotionComplexity" ? "🎭" : name === "genreTheme" ? "🏷" : name === "webnovelVibe" ? "📡" : name === "semanticEmbedding" ? "🧠" : name === "semanticSearch" ? "🔎" : name === "semanticStyle" ? "🖌" : name === "semanticImplicit" ? "👁" : "⚙")),
          el("div", { className: "nwToolLabel" },
            el("div", null, t("feature." + name)),
            el("div", { className: "nwToolDesc" }, t("feature." + name + ".desc")),
            extra || null
          ),
          el(Switch, { checked: fOn, disabled: state.loading, label: String(t("feature." + name)),
            onChange: function () { onToggle(name, !fOn); } })
        );
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
        if (st.error) return String(t("model.engineError")).replace("{err}", String(st.error).slice(0, 80));
        return t("model.engineIdle");
      }
      var pathBox = function (label, dir, target) {
        if (!dir) {
          return el("div", { className: "nwPlotBox nwPlotBoxEmpty" },
            el("div", { className: "nwPlotPath" }, label + "：" + t("plot.pathUnknown")),
            el("div", { className: "nwBtnGroup" },
              el("button", { type: "button", className: "nwBtn", disabled: true }, t("plot.open")),
              el("button", { type: "button", className: "nwBtn", disabled: true }, t("plot.copy"))
            )
          );
        }
        return el("div", { className: "nwPlotBox" },
          el("div", { className: "nwPlotPath", title: dir }, label + "：" + dir),
          el("div", { className: "nwBtnGroup" },
            el("button", { type: "button", className: "nwBtn", disabled: state.revealing, onClick: function () { props.controller.openDir(target); } }, t("plot.open")),
            el("button", { type: "button", className: "nwBtn", onClick: function () { props.controller.copyPath(dir); } }, t("plot.copy"))
          )
        );
      };
      var dirs = state.dirs || {};
      var f = state.features || {};
      var tools = state.tools || {};
var TOOL_GROUPS = [
        { key: "analyze", icon: "📊", tools: ["novel_books", "novel_chapters", "novel_read", "novel_keywords", "novel_sentence_analysis", "novel_style_check", "novel_fix_plan", "novel_style_report", "novel_semantic_search", "novel_continuity_check"] },
        { key: "settings", icon: "📚", tools: ["novel_settings", "novel_plot", "novel_summary", "novel_import"] },
        // v3.9.0：novel_sentence_config 移出组开关（宿主会剥离该键，全关后 UI 显示与实际不一致）——config 仅由二级页/设置单独管理
        // v5.0.0：novel_chapter_brief 归入 create 组——它的调用时机是"要动笔了"
        { key: "create", icon: "✍️", tools: ["novel_chapter_brief", "novel_new_chapter", "novel_outline"] }
      ];
      var toolGroupOpen = state.toolGroupOpen || {};
      var toolRows = TOOL_GROUPS.map(function (grp) {
        var closedCount = grp.tools.filter(function (n) { return tools[n] === false; }).length;
        var isOpen = toolGroupOpen[grp.key] === true;
        var groupOnCount = grp.tools.filter(function (n) { return tools[n] !== false; }).length;
        var groupState = groupOnCount === grp.tools.length ? "on" : groupOnCount === 0 ? "off" : "partial";
        return el("div", { key: grp.key, className: "nwToolGroup" },
          el("div", { className: "nwToolGroupHead" + (isOpen ? " nwToolGroupHeadOpen" : "") },
            el("button", { type: "button", className: "nwToolGroupToggle", disabled: state.loading, title: groupState === "on" ? t("group.allOn") : groupState === "partial" ? t("group.partial") : t("group.allOff"), onClick: function (ev) {
              ev.stopPropagation();
              var patch = {};
              var target = groupState === "on" ? false : true;
              grp.tools.forEach(function (n) { patch[n] = target; });
              props.toggle({ tools: patch });
            } },
              el("span", { className: "nwGroupState nwGroupState" + (groupState === "on" ? "On" : groupState === "partial" ? "Partial" : "Off") },
                groupState !== "off" ? el("span", { className: "nwGroupStateCheck" + (groupState === "partial" ? " nwGroupStateCheckPartial" : "") }, "✓") : null
              )
            ),
            el("button", { type: "button", className: "nwToolGroupHeadBtn", onClick: function () {
              var patch = Object.assign({}, toolGroupOpen); patch[grp.key] = !isOpen;
              props.controller.setToolGroupOpen(patch);
            } },
              el("span", { className: "nwToolGroupIcon" }, grp.icon),
              el("span", { className: "nwToolGroupHeadText" },
                el("span", { className: "nwToolGroupName" }, t("toolGroup." + grp.key) + "（" + groupOnCount + "/" + grp.tools.length + "）"),
                el("span", { className: "nwToolGroupDescInline" }, t("toolGroup." + grp.key + ".desc"))
              ),
              closedCount > 0 ? el("span", { className: "nwToolGroupBadge" }, t("badge.off") + " " + closedCount) : null,
              el("span", { className: "nwToolGroupArrow" }, isOpen ? "▾" : "▸")
            )
          ),
          isOpen ? el("div", { className: "nwToolGroupBody" },
            grp.tools.map(function (name) {
            var checked = tools[name] !== false;
            var desc = t("tool." + name + ".desc");
            var pathExtra = null;
            if (name === "novel_plot") pathExtra = pathBox(t("plot.pathLabel"), dirs.plotsDir || state.plotsDir || "", "plots-dir");
            else if (name === "novel_settings") pathExtra = pathBox(t("dir.settings"), dirs.settingsDir || "", "settings-dir");
            else if (name === "novel_summary") pathExtra = pathBox(t("dir.summaries"), dirs.summariesDir || "", "summaries-dir");
            else if (name === "novel_continuity_check") pathExtra = pathBox(t("dir.audits"), dirs.auditsDir || "", "audits-dir");
            else if (name === "novel_sentence_analysis") pathExtra = pathBox(t("dir.analysis"), dirs.analysisDir || "", "analysis-dir");
            return el("div", { key: name, className: "nwToolItem" },
              el("div", { className: "nwToolRow" + (checked ? " nwToolRowOn" : "") },
                el("div", { className: "nwToolLabel" },
                  el("div", null, String(t("tool." + name)).replace(/\s+novel_\w+$/, "")),
                  el("div", { className: "nwToolDesc" }, desc)
                ),
                el(Switch, { checked: checked, disabled: state.loading, label: String(t("tool." + name)).replace(/\s+novel_\w+$/, ""),
                  onChange: function () { props.toggle({ tools: (function (patch) { patch[name] = !checked; return patch; })({}) }); } })
              ),
              pathExtra || null
            );
          })) : null
        );
      });
;
      // v2.6.0 修复：detailFeatures 提升到渲染函数顶部——二级页渲染与主面板计数共用同一列表（此前计数数组漏 webnovelVibe，5 个开关显示"4开"）
      var detailFeatures = ["emotionCaveat", "emotionComplexity", "genreTheme", "webnovelVibe", "semanticEmbedding"];
      var body = null;
      if (view === "features") {
        body = el("div", null,
          backBtn(),
          el("div", { className: "nwSectionTitle" }, t("panel.featuresTitle")),
          el("div", { className: "nwToolsHint" }, t("panel.featuresHint")),
          detailFeatures.map(function (name) {
            var extra = null;
            if (name === "semanticEmbedding") {
              extra = el("button", { type: "button", className: "nwModelBtn", title: t("model.manage"), onClick: function (ev) { ev.stopPropagation(); props.controller.openView("model"); } }, "⚙ " + t("model.manage"));
            }
            return switchRow(name, f[name] !== false, function (n, v) { props.toggle({ features: (function (patch) { patch[n] = v; return patch; })({}) }); }, extra);
          })
        );
      } else if (view === "tools") {
        body = el("div", null,
          backBtn(),
          el("div", { className: "nwSectionTitle" }, t("panel.toolsTitle")),
          el("div", { className: "nwToolsHint" }, t("panel.toolsHint")),
          toolRows
        );
      } else if (view === "model") {
        body = el("div", null,
          backBtn(),
          el("div", { className: "nwSectionTitle" }, "🖥 " + t("model.title")),
          el("div", { className: "nwToolsHint" }, t("model.hint")),
          // v2.6.0：语义引擎状态（模型就绪/未加载/缺失/失败）
          el("div", { className: "nwRow nwRowOff" },
            el("div", { className: "nwRowText" },
              el("div", { className: "nwRowLabel" }, t("model.engine")),
              el("div", { className: "nwRowHint" }, engineStatusText(state.embeddingStatus, t))
            )
          ),
          switchRow("semanticSearch", f.semanticSearch !== false, function (n, v) { props.toggle({ features: (function (patch) { patch[n] = v; return patch; })({}) }); }),
          switchRow("semanticStyle", f.semanticStyle !== false, function (n, v) { props.toggle({ features: (function (patch) { patch[n] = v; return patch; })({}) }); }),
          switchRow("semanticImplicit", f.semanticImplicit !== false, function (n, v) { props.toggle({ features: (function (patch) { patch[n] = v; return patch; })({}) }); }),
          pathBox(t("dir.embedding"), dirs.embeddingDir || "", "embedding-dir")
        );
      } else if (view === "baseline") {
        // v3.0.0：风格基线——六维文笔指标 ±% 容差带（左=允许低于，右=允许高于）
  var DEFAULT_TOL = { low: "", high: "" };
  var NW_METRICS = [
          ["complexity", "句法复杂度", "📐", "Syntax"], ["modifierDensity", "修饰密度", "🎨", "Modifier"], ["abstractDensity", "抽象度", "☁️", "Abstract"],
          ["actionDensity", "动作密度", "⚡", "Action"], ["hedgeDensity", "不确定性", "🌫️", "Hedge"], ["gapIndex", "留白指数", "🕳️", "Gap"]
        ];
        // v3.0.0：输入框留空 = 使用推荐容差（原著章节波动 1.5σ）；填了才保存自定义
        var tolState = state.styleTolerance && typeof state.styleTolerance === "object" ? state.styleTolerance : null;
        var draft = state.baselineDraft;
        if (!draft) {
          draft = {};
          for (var mi = 0; mi < NW_METRICS.length; mi += 1) {
            var mk = NW_METRICS[mi][0];
            var cur = tolState && tolState[mk] ? tolState[mk] : null;
            // v3.0.0：内部统一存正数（正负号由位置决定：低于=负、高于=正）
            draft[mk] = { low: cur && typeof cur.low === "number" ? Math.abs(cur.low) : "", high: cur && typeof cur.high === "number" ? Math.abs(cur.high) : "" };
          }
        }
        var setDraft = function (mk, field, value) {
          var next = {};
          for (var k in draft) { next[k] = { low: draft[k].low, high: draft[k].high }; }
          next[mk] = { low: draft[mk].low, high: draft[mk].high };
          var v = String(value).trim();
          if (v === "") next[mk][field] = "";
          else {
            // v3.0.0：只收 0-100 正数（正负号由位置决定）
            var n = Math.abs(parseInt(v, 10));
            if (isNaN(n)) n = "";
            else n = Math.min(99, n); // v4.0.0 修正：与宿主 clampStyleTolerance（±99）一致，填 100 不再静默变 99
            next[mk][field] = n;
          }
          props.controller.set({ baselineDraft: next }, { silent: true }); // v4.0.0 修正：草稿输入属纯 UI 状态，不参与 rev 计数
        };
        var saveFlash = function () {
          props.controller.set({ baselineSaved: true }, { silent: true });
          // v4.0.0 修正：先清旧定时器（连续保存不再互相抢状态），并由 mountPanel 卸载时统一清理（此前从不清理）
          if (baselineFlashTimer) clearTimeout(baselineFlashTimer);
          baselineFlashTimer = setTimeout(function () {
            baselineFlashTimer = null;
            props.controller.set({ baselineSaved: false }, { silent: true });
          }, 1800);
        };
        var saveTol = function () {
          // v4.3.0：加载期禁止保存——此时 baselineDraft 还是 null（宿主容差尚未读回），
          // 空草稿会被判定成"全部留空"→ 把宿主已存容差清成 null（其它开关都有 disabled: state.loading，唯独基线页漏了）
          if (state.loading) return;
          // v3.5.0 M18：单侧填写提示成对（不再静默丢弃）
          var halfFilled = null;
          var tol = {};
          var any = false;
          for (var si = 0; si < NW_METRICS.length; si += 1) {
            var sk = NW_METRICS[si][0];
            var sd = draft[sk];
            if (sd && sd.low !== "" && sd.high !== "") { tol[sk] = { low: -sd.low, high: sd.high }; any = true; }
            else if (sd && (sd.low !== "" || sd.high !== "")) {
              // v4.0.0 修正：提示里用显示名——此前直接显示内部键名（complexity/modifierDensity），用户对不上输入框
              if (!halfFilled) halfFilled = isEn ? (NW_METRICS[si][3] || NW_METRICS[si][1]) : NW_METRICS[si][1];
            }
          }
          if (halfFilled) {
            props.controller.set({ revealMsg: t("tol.halfFilled") + "「" + halfFilled + "」" + t("tol.halfFilledTail"), revealErr: true }, { silent: true });
            return;
          }
          props.toggle({ styleTolerance: any ? tol : null });
          // v4.0.0 修正：提示/草稿复位属纯 UI 写入，必须 silent——否则同一 tick 的自增 rev 会让 toggle 的 revSame2 守卫恒为 false，宿主钳制结果被丢弃
          props.controller.set({ baselineDraft: null, revealMsg: t("baseline.saved"), revealErr: false }, { silent: true });
          saveFlash();
        };
        var resetTol = function () {
          // v4.3.0：与 saveTol 同理，加载期不允许"清除自定义"（会把还没读到的容差误清）
          if (state.loading) return;
          // 恢复默认：清除自定义并保存（回到推荐模式），输入框清空
          props.toggle({ styleTolerance: null });
          // v4.0.0 修正：提示/草稿复位属纯 UI 写入，必须 silent——否则同一 tick 的自增 rev 会让 toggle 的 revSame2 守卫恒为 false，宿主钳制结果被丢弃
          props.controller.set({ baselineDraft: null, revealMsg: t("baseline.saved"), revealErr: false }, { silent: true });
          saveFlash();
        };
        body = el("div", null,
          backBtn(),
          el("div", { className: "nwSectionTitle" }, "🎯 " + t("panel.baselineTitle")),
          el("div", { className: "nwToolsHint" }, t("baseline.desc")),
          el("div", { className: "nwTolVer" }, "v3.0.0-UI3"),
          el("div", { className: "nwTolCard" },
            NW_METRICS.map(function (item) {
              var mk2 = item[0];
              var d = draft[mk2] || DEFAULT_TOL;
              return el("div", { className: "nwTolRow", key: mk2, style: { display: "flex", alignItems: "center", gap: "10px", padding: "9px 2px" } },
                el("div", { className: "nwTolName" }, el("span", { className: "nwTolIcon" }, item[2]), isEn ? (item[3] || item[1]) : item[1]),
                el("div", { className: "nwTolField", style: { width: "74px", flexShrink: "0", display: "flex", flexDirection: "column", gap: "3px" } },
                  el("div", { style: { display: "flex", alignItems: "center", gap: "4px" } },
                    el("span", { className: "nwTolSign" }, "−"),
                    el("input", { type: "number", className: "nwTolInput", placeholder: t("tol.recommend"), value: d.low, min: 0, max: 99, disabled: state.loading, onChange: function (ev) { setDraft(mk2, "low", ev.target.value); } })
                  ),
                  el("span", { className: "nwTolCaption" }, t("baseline.low"))
                ),
                el("span", { className: "nwTolSep" }, "~"),
                el("div", { className: "nwTolField", style: { width: "74px", flexShrink: "0", display: "flex", flexDirection: "column", gap: "3px" } },
                  el("div", { style: { display: "flex", alignItems: "center", gap: "4px" } },
                    el("span", { className: "nwTolSign" }, "+"),
                    el("input", { type: "number", className: "nwTolInput", placeholder: t("tol.recommend"), value: d.high, min: 0, max: 99, disabled: state.loading, onChange: function (ev) { setDraft(mk2, "high", ev.target.value); } })
                  ),
                  el("span", { className: "nwTolCaption" }, t("baseline.high"))
                ),
                el("span", { className: "nwTolPct" }, "%")
              );
            })
          ),
          el("div", { className: "nwTolBtns", style: { display: "flex", gap: "12px", marginTop: "16px" } },
            el("button", { type: "button", className: "nwBtn nwBtnPrimary" + (state.baselineSaved ? " nwBtnDone" : ""), disabled: state.loading, onClick: saveTol }, state.baselineSaved ? "✓ " + t("baseline.saved") : "💾 " + t("baseline.save")),
            el("button", { type: "button", className: "nwBtn nwBtnGhost", disabled: state.loading, onClick: resetTol }, "↺ " + t("baseline.reset"))
          )
        );
            } else if (view === "reports") {
        // v3.2.0：报告历史（加载在入口 onClick 触发，此处纯渲染防 React 345 循环）
        var openReport = function (file) {
          var reqId = ++reportReqId;
          props.controller.set({ reportContent: t("reports.loading") }, { silent: true });
          // v4.3.0：非 2xx 不再直接 throw——先解析宿主 JSON 取可操作错误（如 404 {error:"报告不存在"}），
          // 否则一律显示成"网络/路由不可用"，用户根本不知道为什么点不开
          fetchWithTimeout("/api/dsh-novel-writer/reports?read=" + encodeURIComponent(file), { headers: { accept: "application/json" } }).then(function (r2) {
            if (r2.ok) return r2.json();
            return r2.json().catch(function () { return {}; }).then(function (d) {
              return { ok: false, error: d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r2.status };
            });
          }).then(function (d) {
            if (reqId !== reportReqId) return; // v3.5.0 #47：快速切换时丢弃过期响应
            props.controller.set({ reportContent: d.ok ? JSON.stringify(d.content, null, 2) : (t("reports.readFail") + "：" + (d.error || "")) }, { silent: true });
          }).catch(function (err) { if (reqId !== reportReqId) return; props.controller.set({ reportContent: t("reports.readFail") + "：" + errorText(err) }, { silent: true }); });
        };
        var groups = state.reportsGroups || [];
        var totalFiles = groups.reduce(function (a, g) { return a + (g.files || []).length; }, 0);
        var reportsLoading = state.reportsGroups === null;
        body = el("div", null,
          backBtn(),
          el("div", { className: "nwSectionTitle" }, "📊 " + t("reports.title")),
          el("div", { className: "nwToolsHint" }, t("reports.hint")),
          state.reportContent ?
            el("div", null,
              el("button", { type: "button", className: "nwChip", style: { margin: "6px 0" }, onClick: function () { props.controller.set({ reportContent: null }); } }, "‹ " + t("reports.back")),
              el("pre", { className: "nwBoxed nwReportPre", style: { margin: "4px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: "70vh", overflow: "auto" } }, state.reportContent)
            )
          : el("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
              reportsLoading ? el("div", { className: "nwMuted", style: { padding: "10px 0" } }, t("reports.loading2")) : totalFiles === 0 ? el("div", { className: "nwMuted", style: { padding: "10px 0" } }, t("reports.empty")) : null,
              groups.map(function (g) {
                return el("div", { key: g.name },
                  el("div", { className: "nwGroupName", style: { margin: "6px 0 4px" } }, g.name + "（" + (g.files || []).length + "）"),
                  (g.files || []).map(function (f) {
                    return el("button", { key: f.file, type: "button", className: "nwBoxed nwFileRow", style: { marginBottom: "4px", textAlign: "left" }, onClick: function () { openReport(f.file); } },
                      el("span", { className: "nwFileLabel",   }, f.label),
                      el("span", { className: "nwNote",   }, (f.time || "").slice(0, 16).replace("T", " "))
                    );
                  })
                );
              })
            )
        );
      } else if (view === "creation" || view === "creation-form") {
        // v3.1.0：原创模式设定库（方案 C：列表页 + 表单页 + 快速切换）
        var CREATION_FIELDS = [
          ["worldview", "🌍", t("creation.worldview"), t("ph.e末")],
          ["characters", "🎭", t("creation.characters"), t("ph.e女")],
          ["forbidden", "🚫", t("creation.forbidden"), t("ph.e不")],
          ["mainConflict", "🎯", t("creation.mainConflict"), t("ph.e主")],
          ["genre", "📚", t("creation.genre"), t("ph.e悬")],
          ["extra", "📝", t("creation.extra"), t("ph.e每")]
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
          var first = "";
          for (var fi2 = 0; fi2 < CREATION_FIELDS.length; fi2 += 1) {
            var fk2 = CREATION_FIELDS[fi2][0];
            if (typeof profile[fk2] === "string" && profile[fk2].trim()) { first = profile[fk2].trim(); break; }
          }
          return c + " " + t("creation.items") + " · " + (first.length > 18 ? first.slice(0, 18) + "…" : first);
        }
        // ---- 列表页 ----
        if (view === "creation") {
          var newBookName = state.creationNewBook || "";
          var createNewBook = function () {
            var nb = String(newBookName || "").trim();
            // v3.5.0 #49：客户端校验——路径分隔符/Windows 保留字符直接提示
            if (nb && (/[\\/:*?"<>|]/.test(nb) || /[.\s]+$/.test(nb) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(nb))) {
              props.controller.set({ revealMsg: t("creation.badName"), revealErr: true }, { silent: true });
              return;
            }
            if (!nb) {
              var elInp = document.getElementById("nwNewBookInput");
              if (elInp) { elInp.focus(); elInp.classList.add("nwInputErr"); }
              props.controller.set({ revealMsg: t("creation.needName"), revealErr: true }, { silent: true });
              return;
            }
            // v4.3.0：先 openView 再写提示——openView 会无条件清空 revealMsg（silent），
            // 旧顺序下"已创建设定，开始填写"在同一 tick 被清掉，用户永远看不到
            props.controller.openView("creation-form");
            props.controller.set({ creationNewBook: "", creationBook: nb, creationDraft: null, creationDirty: false, revealMsg: t("creation.newed"), revealErr: false }, { silent: true });
          };
          function bookRow(name, profile, isDefault, hasProfile) {
            var filled = filledCount(profile);
            return el("div", { key: "bk-" + name, className: "nwBoxed nwFileRow", style: { gap: "10px", padding: "10px 12px" } },
              el("div", { style: { flex: "1", minWidth: "0" } },
                el("div", { className: "nwRowLabel",   }, isDefault ? "🌐 " + t("creation.default") : "📕 " + name),
                el("div", { className: "nwNote" + (filled > 0 ? " nwNoteAccent" : ""), style: { marginTop: "2px" } }, summaryOf(profile)),
                isDefault ? el("div", { className: "nwNote", style: { marginTop: "1px" } }, t("creation.defaultHint")) : null
              ),
              el("button", { type: "button", onClick: function () { props.controller.set({ creationBook: name, creationDraft: null, creationDirty: false }, { silent: true }); props.controller.openView("creation-form"); } }, t("creation.edit")),
              // v4.0.0 修正：书库里的书若没有设定条目，不渲染"删除"（此前点了空操作却提示"已删除"）
              (isDefault || !hasProfile) ? null : el("button", { type: "button", onClick: function () { var patch = {}; patch[name] = null; props.toggle({ creationProfiles: patch }); props.controller.set({ revealMsg: t("creation.deleted"), revealErr: false }, { silent: true }); } }, t("creation.delete"))
            );
          }
          body = el("div", null,
            backBtn(),
            el("div", { className: "nwSectionTitle" }, "🎨 " + t("panel.creationTitle") + " · " + t("creation.listTitle")),
            el("div", { className: "nwToolsHint" }, t("creation.desc2")),
            // 新建设定
            el("div", { style: { display: "flex", gap: "8px", marginTop: "8px", marginBottom: "10px" } },
              el("input", { id: "nwNewBookInput", type: "text", value: newBookName, placeholder: t("creation.newPlaceholder"), className: "nwTextInput", style: { flex: "1", height: "34px" }, onInput: function (ev) { props.controller.set({ creationNewBook: ev.target.value }, { silent: true }); }, onKeyDown: function (ev) { if (ev.key === "Enter") { ev.preventDefault(); createNewBook(); } } }),
              el("button", { type: "button", className: "nwBtn nwBtnPrimary", style: { height: "34px", padding: "0 16px" }, onClick: createNewBook }, t("creation.new"))
            ),
            el("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
              bookRow("", cpGlobal, true),
              allBooks.map(function (name) { return bookRow(name, profileOf(name), false, Object.prototype.hasOwnProperty.call(cpBooks, name)); })
            )
          );
        } else {
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
            if (!curBook) { props.toggle({ creationProfile: null }); }
            else { var p3 = {}; p3[curBook] = null; props.toggle({ creationProfiles: p3 }); }
            props.controller.set({ creationDraft: null, creationDirty: false, revealMsg: t("creation.cleared"), revealErr: false }, { silent: true });
          }
          function switchBook(newName) {
            if (state.creationDirty && newName !== curBook) {
              // v4.3.0：取消分支此前直接 return，没有任何 state 变更 → 受控 <select> 不重渲染，
              // DOM 停在用户选的 B 而 state.creationBook 仍是 A，之后保存会把设定写进另一本书。
              // 这里显式触发一次同步（空 patch + silent），让 React 把 select 的 value 拉回 A。
              if (!window.confirm(t("creation.dirtyWarn"))) {
                props.controller.set({}, { silent: true });
                return;
              }
            }
            props.controller.set({ creationBook: newName, creationDraft: null, creationDirty: false }, { silent: true });
          }
          var switchOpts = [el("option", { key: "opt-default", value: "" }, "🌐 " + t("creation.default"))];
          for (var si4 = 0; si4 < allBooks.length; si4 += 1) {
            var bn = allBooks[si4];
            switchOpts.push(el("option", { key: "opt-" + bn, value: bn }, "📕 " + bn));
          }
          // v4.0.0 修正：新建书尚未保存时不在 allBooks 中，需临时补进下拉——否则受控 select 显示不出当前正在编辑的书
          if (curBook !== "" && allBooks.indexOf(curBook) === -1) {
            switchOpts.push(el("option", { key: "opt-cur", value: curBook }, "📕 " + curBook));
          }
          body = el("div", null,
            backBtn(),
            el("div", { className: "nwSectionTitle" }, "🎨 " + (curBook ? curBook : t("creation.default")) + " · " + t("creation.formTitle")),
            // 快速切换
            el("div", { style: { display: "flex", alignItems: "center", gap: "8px", margin: "4px 0 10px" } },
              el("span", { className: "nwMuted",   }, t("creation.bookFor")),
              el("select", { className: "nwSelect", value: curBook, onChange: function (ev) { switchBook(ev.target.value); } }, switchOpts)
            ),
            el("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
              CREATION_FIELDS.map(function (item) {
                var cf4 = item[0];
                return el("div", { key: cf4, style: { display: "flex", flexDirection: "column", gap: "4px" } },
                  el("div", { className: "nwFieldLabel",   }, item[1] + " " + item[2]),
                  el("textarea", { className: "nwCreationInput nwTextArea", value: formDraft[cf4] || "", rows: 2, placeholder: item[3], style: { width: "100%", resize: "vertical" }, onInput: function (ev) { setFormDraft(cf4, ev.target.value); } })
                );
              })
            ),
            el("div", { style: { display: "flex", gap: "12px", marginTop: "14px" } },
              el("button", { type: "button", className: "nwBtn", style: { padding: "9px 20px" }, onClick: saveForm }, "💾 " + t("creation.save")),
              el("button", { type: "button", className: "nwBtn", style: { padding: "9px 18px" }, onClick: clearForm }, "↺ " + t("creation.clear"))
            )
          );
        }      } else {
        var onFeatures = detailFeatures.filter(function (k) { return f[k] !== false; }).length;
        // v4.0.0 修正：计数与工具页渲染同源（TOOL_GROUPS 共 15 项）；宿主清单里的 novel_sentence_config
        // 没有 UI 行（宿主写路径会剥离该键），按宿主全清单计数会出现"16 开"却只有 15 行
        // v4.3.0：那份全清单常量（ALL_TOOLS）本身零引用，已删除，此处只保留结论说明
        var onTools = TOOL_GROUPS.reduce(function (acc, grp) { return acc.concat(grp.tools); }, []).filter(function (k) { return tools[k] !== false; }).length;
        // v4.0.0 修正：英文界面不再用中文单位「万」
        var fmtChars = function (n) {
          var v = Number(n) || 0;
          if (!isEn) return v >= 10000 ? (v / 10000).toFixed(1) + "万" : String(v);
          if (v >= 1000000) return (v / 1000000).toFixed(1) + "M";
          if (v >= 1000) return (v / 1000).toFixed(1) + "k";
          return String(v);
        };
        // v4.3.0：更新检查结果分流——后端 checkForUpdate 现在回稳定形状 { ok, stale, lastSuccess, checkedAt, ... }。
        // ok === false 表示本次检查失败/被限流（latestVersion 可能只是历史值），此时更新条区域改为一行低调灰字：
        // 不显示"发现新版本"条、不报红色错误、不影响面板其它功能；ok === true 或字段缺失（旧后端）时行为与旧版完全一致。
        var updateCheck = state.updateCheck;
        var updateFailed = !!(updateCheck && updateCheck.ok === false);
        var updateFailedText = t("update.failed");
        if (updateFailed && typeof updateCheck.lastSuccess === "string" && updateCheck.lastSuccess !== "") {
          var lastOkAt = new Date(updateCheck.lastSuccess);
          if (!isNaN(lastOkAt.getTime())) updateFailedText = t("update.failedLast").replace("{time}", lastOkAt.toLocaleString());
        }
        body = el("div", null,
          // v3.5.0 #37：保存失败/宿主不可达提示条
          (state.saveFailed || state.hostOk === false) ? el("div", { key: "saveBanner", className: "nwWarnBanner", style: { padding: "7px 10px", marginBottom: "8px" } }, state.hostOk === false ? t("panel.localOnly") : t("panel.saveFailed")) : null,
          // v2.6.5：更新提示条（有新版才显示，点击跳 GitHub Release）
          // v4.3.0：ok === false 时不显示该条——避免用"上次检查到的版本"冒充本次结果
          updateCheck && !updateFailed && updateCheck.updateAvailable && updateCheck.releaseUrl
            ? el("a", { className: "nwUpdateBar", href: updateCheck.releaseUrl, target: "_blank", rel: "noopener noreferrer" },
                "📢 " + t("update.title") + " v" + updateCheck.latestVersion + " " + t("update.go"))
            : null,
          // v4.3.0：检查失败降级提示（灰字一行，低调不打扰；有历史成功记录时附带上次成功时间）
          // 样式与 .nwUpdateBar 同区同盒模型（见插件样式表 .nwUpdateStale，用主题变量以适配深色）
          updateFailed
            ? el("div", { key: "updateStale", className: "nwUpdateStale" }, updateFailedText)
            : null,
          el("div", { className: "nwSection" },
            el("div", { className: "nwKicker" }, t("panel.secSwitch")),
            el("div", { className: "nwKickerRule" }),
            el("div", { className: "nwRow " + (state.enabled ? "nwRowOn" : "nwRowOff") },
              el("div", { className: "nwIconSlot" }, el("span", { className: "nwIconGlyph" }, "◉")),
              el("div", { className: "nwRowText" },
                el("div", { className: "nwRowLabel" }, t("panel.enabled")),
                el("div", { className: "nwRowHint" }, t("panel.enabledHint"))
              ),
              el("div", { className: "nwSwitchWrap" },
                el(Switch, { checked: state.enabled, disabled: state.loading, label: t("panel.enabled"), onChange: function (value) { props.toggle({ enabled: value }); } }),
                el("span", { className: "nwBadge " + (state.enabled ? "nwBadgeOn" : "nwBadgeOff") }, state.enabled ? t("badge.on") : t("badge.off"))
              )
            ),
            el("div", { className: "nwRow " + (state.autoAnalyze ? "nwRowOn" : "nwRowOff") },
              el("div", { className: "nwIconSlot" }, el("span", { className: "nwIconGlyph" }, "📊")),
              el("div", { className: "nwRowText" },
                el("div", { className: "nwRowLabel" }, t("panel.autoAnalyze")),
                el("div", { className: "nwRowHint" }, t("panel.autoAnalyzeHint"))
              ),
              el("div", { className: "nwSwitchWrap" },
                el(Switch, { checked: state.autoAnalyze, disabled: state.loading, label: t("panel.autoAnalyze"), onChange: function (value) { props.toggle({ autoAnalyze: value }); } }),
                el("span", { className: "nwBadge " + (state.autoAnalyze ? "nwBadgeOn" : "nwBadgeOff") }, state.autoAnalyze ? t("badge.on") : t("badge.off"))
              )
            ),
            // v5.0.0：精简工作流——全局开关，与相邻开关同一套 switch/badge 组件。
            // B2 重排：由「提示词档位 / 提示词场景」两行之下移入「开关」分区——与「提示词场景」行的区别：它不受"仅完整档生效"限制（不给 disabled 逻辑），任何时候都可切换；
            // 打开（true）= 提示词换"按需调用"最简档，关闭（false，默认）= 维持 5.0.0 的自检/收尾/复测清单。
            el("div", { className: "nwRow " + (state.leanWorkflow ? "nwRowOn" : "nwRowOff") },
              el("div", { className: "nwIconSlot" }, el("span", { className: "nwIconGlyph" }, "⚡")),
              el("div", { className: "nwRowText" },
                el("div", { className: "nwRowLabel" }, t("panel.leanWorkflow")),
                el("div", { className: "nwRowHint" }, t("panel.leanWorkflowHint"))
              ),
              el("div", { className: "nwSwitchWrap" },
                el(Switch, { checked: state.leanWorkflow === true, disabled: state.loading, label: t("panel.leanWorkflow"), onChange: function (value) { props.toggle({ leanWorkflow: value }); } }),
                el("span", { className: "nwBadge " + (state.leanWorkflow ? "nwBadgeOn" : "nwBadgeOff") }, state.leanWorkflow ? t("badge.on") : t("badge.off"))
              )
            ),
          ),
          el("div", { className: "nwSection" },
            el("div", { className: "nwKicker" }, t("panel.secPrompt")),
            el("div", { className: "nwKickerRule" }),
            // v4.0.0：系统提示词注入档位（关闭 / 精简 / 完整）——三档分段按钮，沿用 dsh-unrestricted 的开关思路
            el("div", { className: "nwRow " + (state.systemPromptMode !== "off" ? "nwRowOn" : "nwRowOff") },
              el("div", { className: "nwIconSlot" }, el("span", { className: "nwIconGlyph" }, "📝")),
              el("div", { className: "nwRowText" },
                el("div", { className: "nwRowLabel" }, t("panel.spMode")),
                el("div", { className: "nwRowHint" }, t("panel.spModeHint"))
              ),
              el(NW_UI.SegmentedControl, {
                label: t("panel.spMode"),
                value: state.systemPromptMode,
                disabled: state.loading,
                options: ["off", "brief", "full"].map(function (m) { return { value: m, label: t("sp." + m) }; }),
                onChange: function (m) { if (state.systemPromptMode !== m) props.toggle({ systemPromptMode: m }); }
              })
            ),
            // v5.0.0：提示词场景——与上面的档位正交：档位决定"注入多少"，场景决定"注入什么"。
            // v5.1.1 修正：**不再因为档位非 full 就把按钮 disabled**——用户反馈"场景里点不了其他选项"，
            // 因为默认档位是 off/精简，五个按钮全灰且没有任何解释，等于把"选场景"锁死在一个看不见的前提后面。
            // 现在按钮始终可点（只受 loading 限制），档位非 full 时改用行内提示说明"已保存但暂不注入"。
            // 场景枚举必须与 lib/prompts.js 的 PROMPT_SCENES 保持一致（客户端是独立 bundle，不能 import）。
            el("div", { className: "nwRow " + (state.systemPromptMode === "full" ? "nwRowOn" : "nwRowOff") },
              el("div", { className: "nwIconSlot" }, el("span", { className: "nwIconGlyph" }, "🎛")),
              el("div", { className: "nwRowText" },
                el("div", { className: "nwRowLabel" }, t("panel.spScene")),
                el("div", { className: "nwRowHint" }, t("panel.spSceneHint") + (state.systemPromptMode === "full" ? "" : " " + t("panel.spSceneInactive")))
              ),
              el(NW_UI.SegmentedControl, {
                label: t("panel.spScene"),
                value: state.promptScene || "general",
                disabled: state.loading,
                options: ["general", "writing", "revising", "auditing", "setup"].map(function (s) { return { value: s, label: t("sc." + s) }; }),
                onChange: function (s) { if ((state.promptScene || "general") !== s) props.toggle({ promptScene: s }); }
              })
            ),
            (function () {
              var rawOn = f.rawWriting === true;
              return el("div", { className: "nwToolRow" + (rawOn ? " nwToolRowOn" : " nwToolRowRaw"), key: "rawWriting" },
                el("div", { className: "nwToolLabel" },
                  el("div", { className: "nwToolLabelRaw" }, "🔞 " + t("feature.rawWriting")),
                  el("div", { className: "nwToolDesc nwRawDanger" }, t("raw.danger")),
                  rawOn ? el("div", { className: "nwRawOn" }, t("raw.on")) : null
                ),
                el(Switch, { checked: rawOn, disabled: state.loading, label: "🔞 " + t("feature.rawWriting"),
                  onChange: function () { props.controller.rawToggle(!rawOn); } })
              );
            })(),
          ),
          el("div", { className: "nwSection" },
            el("div", { className: "nwKicker" }, t("panel.secStatus")),
            el("div", { className: "nwKickerRule" }),
            entry(t("panel.featuresTitle"), t("panel.featuresHint"), onFeatures, "features"),
            entry(t("panel.toolsTitle"), t("panel.toolsHint"), onTools, "tools"),
            // v3.2.0：原创模式（设定库）移到主面板
            entry(t("panel.creationTitle"), t("panel.creationHint"), null, "creation"),
            // v3.0.0：风格基线（六维 ±% 容差带）
            entry(t("panel.baselineTitle"), t("panel.baselineHint"), null, "baseline"),
            // v3.7.0：功能开关（情感深度/风格检测/语义增强）在二级「功能开关」页维护——主页不重复展示
            // v2.6.0：数据目录占用 + 语义引擎状态（一目了然）
            el("div", { style: { display: "flex", gap: "8px" } },
              el("div", { className: "nwPill" },
                el("span", { className: "nwPillKey" }, t("dir.size")),
                el("span", { className: "nwPillVal" }, formatSize(state.dataDirSize))
              ),
              el("div", { className: "nwPill" },
                el("span", { className: "nwPillKey" }, t("model.engine")),
                el("span", { className: "nwPillVal" }, engineStatusText(state.embeddingStatus, t))
              )
            ),
            pathBox(t("dir.data"), dirs.dataDir || state.dataDir || "", "data-dir"),
            // v4.3.0：state.file / dirs.stateFile 此前写了 4 处却从不读取——宿主 reveal 支持 state-file
            //（lib/core.js allowedTargets 含 "state-file"），这里补一行路径卡把它用起来
            pathBox(t("dir.stateFile"), dirs.stateFile || state.file || "", "state-file"),
          ),
          // v3.2.0：书库统计（写作打卡）；null=未就绪不渲染，[]=真空提示
          el("div", { key: "statsCard", className: "nwBoxed", style: { marginTop: "10px", padding: "10px 12px" } },
            el("div", { className: "nwGroupName", style: { marginBottom: "6px" } }, "📚 " + t("stats.title")),
            el("div", { style: { display: "flex", flexDirection: "column", gap: "5px" } },
              state.booksStats === null
                ? el("div", { className: "nwNote nwNoteWarn",   }, t("stats.pending"))
                : (state.booksStats || []).length === 0
                ? el("div", { className: "nwNote",   }, t("stats.empty"))
                : (state.booksStats || []).slice(0, 6).map(function (bs) {
                    var charsText = fmtChars(bs.chars);
                    return el("div", { key: bs.name, className: "nwStatRow" },
                      el("span", { className: "nwStatRow",   }, "📕 " + bs.name),
                      el("span", { className: "nwStatName",   }, bs.chapters + " " + t("stats.chapters") + " · " + charsText + t("stats.chars")),
                      bs.recent7Chars > 0
                        ? el("span", { className: "nwNote nwNoteOk",   }, "🔥 " + fmtChars(bs.recent7Chars) + " " + t("stats.week"))
                        : el("span", { className: "nwNote nwNoteDim",   }, t("stats.idle"))
                    );
                  })
            )
          ),
          // v3.2.0：报告历史入口
          el("button", { key: "reportsEntry", type: "button", className: "nwBoxed nwFileRow", style: { marginTop: "8px", padding: "9px 12px", textAlign: "left" }, onClick: function () {
            props.controller.set({ reportsGroups: null, reportContent: null }, { silent: true });
            // v4.3.0：超时 + 错误透传（reports.readFailDetail 已被具体错误取代，该词条随之删除）
            fetchWithTimeout("/api/dsh-novel-writer/reports", { headers: { accept: "application/json" } }).then(function (r2) {
              if (r2.ok) return r2.json();
              return r2.json().catch(function () { return {}; }).then(function (d) {
                throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r2.status);
              });
            }).then(function (d) {
              props.controller.set({ reportsGroups: d.groups || [] }, { silent: true });
            }).catch(function (err) {
              // v4.0.0 修正：失败不再伪装成"暂无报告"（空数组），改为错误提示条，避免用户去跑分析而不是重试
              props.controller.set({ reportsGroups: [], revealMsg: t("reports.readFail") + "：" + errorText(err), revealErr: true }, { silent: true });
            });
            props.controller.openView("reports");
          } },
            el("span", { className: "nwRowLabel", style: { flex: "1" } }, "📊 " + t("reports.title")),
            el("span", { className: "nwNote",   }, t("reports.hint")),
            el("span", { className: "nwNote nwChevron",   }, "›")
          ),
          // v3.2.0：体验演示
          el("div", { key: "demoCard", className: "nwDashedNote", style: { marginTop: "10px" } },
            el("button", { type: "button", disabled: state.demoLoading, style: { display: "flex", alignItems: "center", gap: "8px", width: "100%", background: "transparent", border: "none", padding: 0, cursor: state.demoLoading ? "default" : "pointer", textAlign: "left" }, onClick: function () {
              if (state.demoLoading) return;
              props.controller.set({ demoLoading: true }, { silent: true });
              // v4.3.0：超时 + 错误透传 + finally 复位 demoLoading（宿主挂起时按钮不再永久"演示中…"）
              fetchWithTimeout("/api/dsh-novel-writer/demo", { headers: { accept: "application/json" } }).then(function (r2) {
                if (r2.ok) return r2.json();
                return r2.json().catch(function () { return {}; }).then(function (d) {
                  throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r2.status);
                });
              }).then(function (d) {
                props.controller.set({ demoReport: d.ok ? d.report : (t("demo.fail") + "：" + (d.error || t("state.unreachable"))) }, { silent: true });
              }).catch(function (err) {
                props.controller.set({ demoReport: t("demo.fail") + "：" + errorText(err) }, { silent: true });
              }).finally(function () {
                props.controller.set({ demoLoading: false }, { silent: true });
              });
            } },
              el("span", { className: "nwAccentStrong",   }, state.demoLoading ? t("demo.loading") : t("demo.run")),
              el("span", { className: "nwNote",   }, t("demo.hint"))
            ),
            state.demoReport ? el("pre", { className: "nwBoxed nwReportPre", style: { margin: "8px 0 0", maxHeight: "260px", overflow: "auto" } }, state.demoReport) : null
          )
        );
      }
      // 非净化模式弹窗（确认 + 倒计时 / 承诺输入）
      if (state.rawModal) {
        body = el("div", { className: "nwModal" },
          el("div", { className: "nwModalBox" },
            el("div", { className: "nwModalTitle" }, "🔞 " + t("raw.confirmTitle")),
            el("div", { className: "nwModalText" }, t("raw.confirmText")),
            el("div", { className: "nwModalBtns" },
              el("button", { type: "button", className: "nwBtn", disabled: state.rawCountdown > 0, onClick: function () { props.controller.rawConfirm(); } },
                state.rawCountdown > 0 ? t("raw.confirmWait") + " (" + state.rawCountdown + "s)" : t("raw.confirmOk")),
              el("button", { type: "button", className: "nwBtn", onClick: function () { props.controller.rawCancel(); } }, t("raw.cancel"))
            )
          )
        );
      } else if (state.rawPromiseOpen) {
        body = el("div", { className: "nwModal" },
          el("div", { className: "nwModalBox" },
            el("div", { className: "nwModalTitle" }, "🔞 " + t("raw.promiseTitle")),
            el("div", { className: "nwModalText" }, t("raw.promiseText")),
            el("input", { type: "text", className: "nwModalInput", value: state.rawPromiseText || "", placeholder: t("raw.promisePlaceholder"), onChange: function (e) { props.controller.rawSetPromise(e.target.value); } }),
            el("div", { className: "nwModalBtns" },
              el("button", { type: "button", className: "nwBtn" + (state.rawPromiseOk ? " nwBtnDanger" : ""), disabled: !state.rawPromiseOk, onClick: function () { props.controller.rawPromiseConfirm(); } }, t("raw.promiseOk")),
              el("button", { type: "button", className: "nwBtn", onClick: function () { props.controller.rawCancel(); } }, t("raw.cancel"))
            )
          )
        );
      }
      return el("div", { className: "nwPanel" + (props.variant === "main" ? " nwPanelMain" : "") },
        el("div", { className: "nwPanelHeader" },
          el("div", { className: "nwPanelTitle" }, t("panel.title") + (view !== "main" ? " › " + (view === "features" ? t("panel.featuresTitle") : view === "tools" ? t("panel.toolsTitle") : view === "baseline" ? t("panel.baselineTitle") : view === "creation" ? t("panel.creationTitle") : view === "creation-form" ? t("panel.creationTitle") + " · " + t("creation.formTitle") : view === "reports" ? t("reports.title") : t("model.title")) : "")),
          el("button", { type: "button", className: "nwRefresh" + (state.refreshing ? " nwRefreshSpin" : ""), onClick: function () { props.controller.refresh(); } }, state.refreshing ? "⟳" : t("panel.refresh")),
          // v5.2.0：作为官方右栏 tab 时不画关闭按钮——关闭由宿主 tab chip 提供
          typeof props.onClose === "function" ? el("button", { type: "button", className: "nwClose", "aria-label": t("panel.close"), onClick: props.onClose }, "×") : null
        ),
        el("div", { className: "nwHero" },
          el("div", { className: "nwBanner " + (on ? "nwBannerOn" : "nwBannerOff") },
            el("span", { className: "nwBannerIcon" }, on ? "✔" : "✘"),
            el("span", null, on ? t("banner.on") : t("banner.off"))
          ),
          el("div", { className: "nwHeroDesc" }, t("entry.tooltip")),
        ),
        loadingHint,
        msg,
        body
      );
    }

    /** 官方设置页「插件配置」槽位卡片（v0.5.0 统一版）：状态只读 + 跳转按钮，开关只在侧边栏面板。 */
    function NovelWriterSettingsCard(props) {
      var force = react.useState(0)[1];
      // v4.0.0 修正：依赖补全（与 PanelView 同理），并删掉 effect 之前那次必被覆盖的 getSnapshot 死存储
      react.useEffect(function () {
        return props.controller.subscribe(function () { force(function (n) { return n + 1; }); });
      }, [props.controller]);
      var state = props.controller.getSnapshot();
      var statusKey = state.enabled ? (state.autoAnalyze ? "card.status" : "card.statusAutoOff") : "card.statusOff";
      return react.createElement(
        "div",
        { className: "nwSettingsCard" },
        react.createElement("div", { className: "nwSettingsCardTitle" }, t("card.title")),
        react.createElement("div", { className: "nwMuted", style: { margin: "4px 0 8px" } }, t("card.desc")),
        react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 4 } },
          react.createElement(NW_UI.Tag, { tone: state.enabled ? "success" : "danger" }, t(statusKey)),
          react.createElement(NW_UI.Button, {
            variant: "outline", size: "sm",
            onClick: function () { if (typeof props.onOpenPanel === "function") props.onOpenPanel(); }
          }, t("card.open"))
        ),
        react.createElement("div", { className: "nwMuted", style: { marginTop: 8 } }, t("card.hint"))
      );
    }
    function mountPanel(controller, toggle) {
      var container;
      var root;
      var render = function () {
        if (root === void 0) return;
        try {
          root.render(react.createElement(PanelView, {
            controller: controller,
            toggle: toggle,
            onClose: function () { controller.set({ panelOpen: false }, { silent: true }); }
          }));
        } catch (error) {
          console.error("[dsh-novel-writer] panel render failed:", error);
        }
      };
      var wasOpen = false;
      var syncOpen = function () {
        var open = controller.getSnapshot().panelOpen;
        if (container !== void 0) container.style.display = open ? "block" : "none";
        if (open) {
          document.documentElement.dataset.dshNovelWriterActive = "";
          delete document.documentElement.dataset.dshSshActive;
          delete document.documentElement.dataset.dshTaskboardActive;
          // v4.0.0 修正：仅在"关→开"跃迁时派发全局事件——此前每次状态变更都派发，其他插件面板会被反复唤醒
          if (!wasOpen) document.documentElement.dispatchEvent(new CustomEvent("dsh-panel-activate", { detail: "novel-writer" }));
        } else {
          delete document.documentElement.dataset.dshNovelWriterActive;
        }
        wasOpen = open;
      };
      var rootFailed = false; // v4.0.0：createRoot 失败后停止重试（否则每轮 mutation 都会再 append 一个隐藏容器）
      var ensure = function () {
        if (rootFailed) return;
        if (container !== void 0 && container.isConnected === true) return;
        var column = conversationColumn();
        if (column === void 0) return;
        // v3.9.5 修正：宿主重建会话列导致容器脱离 DOM 时，先卸载旧 React root 并移除旧容器，
        // 避免 PanelView 的订阅闭包累积（旧 root 永不 unmount = 监听泄漏）
        if (root !== void 0) { try { root.unmount(); } catch { /* ignore */ } root = void 0; }
        if (container !== void 0) { try { container.remove(); } catch { /* ignore */ } container = void 0; }
        container = document.createElement("div");
        container.dataset.dshNovelWriterView = "";
        container.style.display = "none";
        column.appendChild(container);
        try {
          root = react_dom_client.createRoot(container);
        } catch (error) {
          console.error("[dsh-novel-writer] createRoot failed:", error);
          // v4.0.0 修正：失败时移除已插入的容器并停止重试（此前引用置空但节点留在会话列，每轮 mutation 泄漏一个）
          try { container.remove(); } catch { /* ignore */ }
          container = void 0;
          root = void 0;
          rootFailed = true;
          return;
        }
        render();
        syncOpen();
      };
      var waitObserver = new MutationObserver(function () { ensure(); });
      try {
        waitObserver.observe(document.body, { childList: true, subtree: true });
      } catch { /* body not ready yet */ }
      var unsubscribe = controller.subscribe(function () { render(); syncOpen(); });
      var onOtherPanel = function (event) {
        if (event.detail !== "novel-writer" && controller.getSnapshot().panelOpen) {
          controller.set({ panelOpen: false }, { silent: true });
        }
      };
      document.addEventListener("dsh-panel-activate", onOtherPanel);
      ensure();
      return function () {
        waitObserver.disconnect();
        document.removeEventListener("dsh-panel-activate", onOtherPanel);
        unsubscribe();
        // v4.0.0 修正：卸载时清掉自己写过的 html 标记，避免宿主重建会话列时插件样式残留把会话区隐藏
        delete document.documentElement.dataset.dshNovelWriterActive;
        // v4.0.0 修正：清理基线"已保存"闪烁定时器（此前从不清理）
        if (baselineFlashTimer) { clearTimeout(baselineFlashTimer); baselineFlashTimer = null; }
        if (root !== void 0) {
          try { root.unmount(); } catch { /* ignore */ }
        }
        if (container !== void 0) {
          try { container.remove(); } catch { /* ignore */ }
        }
      };
    }

    // ---- v5.2.0：官方席位（侧栏一行 + 主栏页面）----
    // 背景：v5.1.1 及以前是 DOM 注入——querySelector('[class*="sidebarCol"]') 找宿主侧栏列，
    // 自建容器 + 自写 CSS 模拟宿主样式。宿主一改版就失效，深色主题也对不上。
    // 本版改走 DSH 0.2.0 的官方席位，也就是「插件」「任务看板」所在的那一排：
    //   ① sidebar.panellist（root 作用域 list）：侧栏主导航区的一行，提供 id / order / label；
    //   ② main（root 作用域 keyed）：**同一个 id** 寻址主栏页面——行盒子、选中态、折叠提示、
    //      无障碍名称全由宿主 layout 服务负责，我们只画图标与页面内容。
    // 两个席位都由 shell 包声明，因此一律用 **ctx.slots.inject** 注册：它只在席位被声明后
    // 回调，未声明的宿主上什么都不发生（旧路径照常），**不会影响宿主启动**。
    // 注意区分：ctx.slots.inject（槽位等待，安全）≠ ctx.inject（cordis 服务等待，危险）。
    // 真机事故：v5.2.0 首版曾用 ctx.inject 等 sidebarRight/sidebarRightTabs，客户端宿主把
    // "等待未满足依赖的 entry" 判为 did not activate，桌面端直接启动失败——该写法已彻底删除，
    // 插件永远不能拖垮宿主启动。
    var NW_PANEL_ID = "dsh-novel-writer";
    var NW_PANEL_ORDER = 25;   // 任务看板=20、skill-explorer=30、ssh=40：我们排在任务看板之后

    /** 安全读取宿主服务：ctx.get(name) 优先（可读到未在 inject 声明的服务），再退回属性访问。 */
    function readHostService(ctx, name) {
      try {
        if (ctx && typeof ctx.get === "function") return ctx.get(name);
      } catch { /* 未注册的服务：ctx.get 可能抛错 */ }
      try { return ctx ? ctx[name] : void 0; } catch { /* 属性访问也可能被代理拦截 */ }
      return void 0;
    }
    /**
     * 槽位是否已被宿主声明。未声明的槽位 `register` 会抛错、`inject` 也不会回调，
     * 而"回调被同步调用"并不等于注册成功（测试桩与部分实现都会无脑调用回调）——
     * 所以接管前必须先问声明表：`specDynamic(key)` 未声明时返回 undefined。
     * 缺探测 API 的宿主（老版本）返回 false，宁可保留旧 UI 也不要挂空。
     */
    function slotDeclared(ctx, name) {
      try {
        var slots = ctx && ctx.slots;
        if (!slots) return false;
        if (typeof slots.specDynamic === "function") return !!slots.specDynamic(name);
        if (typeof slots.spec === "function") return !!slots.spec(name);
      } catch { /* 探测失败按未声明处理 */ }
      return false;
    }
    /**
     * 订阅控制器并强制重渲染。
     * 不能用 useSyncExternalStore：控制器的 getSnapshot() 返回同一个可变对象，
     * React 按引用比较会认为"没变化"，界面不刷新。
     */
    function useControllerTick(controller) {
      var force = react.useState(0)[1];
      react.useEffect(function () {
        return controller.subscribe(function () { force(function (n) { return n + 1; }); });
      }, [controller]);
    }
    /** 侧栏主导航那一行的图标（owner props: { size, active }）——行盒子/文字/选中态由宿主画。 */
    function SidebarPanelIcon(props) {
      var size = typeof props.size === "number" && props.size > 0 ? props.size : 16;
      return react.createElement(
        "svg",
        {
          width: size, height: size, viewBox: "0 0 24 24", fill: "none",
          stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round",
          "aria-hidden": "true"
        },
        react.createElement("path", { d: "M5 20h14" }),
        react.createElement("path", { d: "M15.8 3.8a2.1 2.1 0 0 1 3 3L9.2 16.4 4.6 17.6l1.2-4.6z" })
      );
    }
    /** 主栏页面（main keyed 席位）：选中/切换由宿主负责，我们只渲染内容。 */
    function MainPanelPage(props) {
      useControllerTick(props.controller);
      return react.createElement(PanelView, {
        controller: props.controller,
        toggle: props.toggle,
        variant: "main",
        onClose: props.onClose
      });
    }
    /**
     * 注册官方席位：侧栏一行 + 主栏页面（同一个 id）。
     * 两个席位都用 ctx.slots.inject 等声明——未声明的宿主上回调不触发，旧路径保留。
     * 页面先挂成功才撤旧 UI（宁可暂时叠着，也不能出现"入口在、面板没了"）。
     * @returns 是否已接管
     */
    function registerOfficialPanel(ctx, controller, toggle, disposers) {
      if (!ctx.slots || typeof ctx.slots.inject !== "function") return false;
      if (!slotDeclared(ctx, "sidebar.panellist") || !slotDeclared(ctx, "main")) return false;
      var pageDispose = null;
      try {
        var layout = readHostService(ctx, "layout");
        var onClose = layout && typeof layout.selectPanel === "function"
          ? function () { try { layout.selectPanel(null); } catch { /* ignore */ } }
          : null;
        pageDispose = ctx.slots.inject("main", function () {
          return ctx.slots.register({
            name: "main",
            key: NW_PANEL_ID,
            inject: function () { return { controller: controller, toggle: toggle, onClose: onClose }; }
          }, MainPanelPage);
        });
        var rowDispose = ctx.slots.inject("sidebar.panellist", function () {
          return ctx.slots.register({
            name: "sidebar.panellist",
            id: NW_PANEL_ID,
            order: NW_PANEL_ORDER,
            label: function () { return t("panel.title"); }
          }, SidebarPanelIcon);
        });
        if (typeof rowDispose === "function") disposers.push(rowDispose);
        if (typeof pageDispose === "function") disposers.push(pageDispose);
        return true;
      } catch (error) {
        console.warn("[dsh-novel-writer] official panel seat failed:", error);
        if (typeof pageDispose === "function") { try { pageDispose(); } catch { /* ignore */ } }
        return false;
      }
    }

    // ---- 插件入口 ----
    var inject = ["slots", "locale"];
    var applied = false;
    function apply(ctx) {
      // 注（v3.9.5）：applied 防重入依赖宿主 module materialize 语义——若宿主在同一模块实例上 disable→enable/HMR，
      // 第二次 apply 会被静默跳过且旧 UI 已卸载；如遇此场景需宿主重新加载模块实例
      if (applied) return;
      applied = true;
      var controller = createController();
      var load = async function () {
        // v2.6.5：更新检查（独立请求，3s 超时由后端兜底；失败静默不影响面板）
        // v4.3.0：同样纳入 8s 超时（宿主连不上时不再让这条后台请求悬挂）
        fetchWithTimeout("/api/dsh-novel-writer/update-check", { headers: { accept: "application/json" } })
          .then(function (r) { return r.ok ? r.json() : null; })
          // v4.0.0 修正：update-check 是后台写入，若参与 rev 计数会让 load() 的 rev 守卫误判"用户已操作"，
          // 导致 enabled/tools/features/容差 等已持久化的开关被静默丢弃（面板显示"全部开启"）
          .then(function (uc) { if (uc) controller.set({ updateCheck: uc }, { silent: true }); })
          .catch(function () { /* 静默 */ });
        try {
          var revAt = controller.getSnapshot().rev;
          var remote = await fetchState();
          // v3.9.5 修正：初次加载接入 rev 竞态守卫——慢 GET 到达时若用户已操作（rev 变化），
          // 不得用旧快照覆盖 enabled/autoAnalyze/tools/features/容差/设定等开关字段
          // v4.3.0：改判 staleGuard（rev + 在途 POST），首次加载期间的保存不再被旧快照覆盖
          var revSame = !controller.staleGuard(revAt);
          var snap = controller.getSnapshot();
          controller.set({
            enabled: revSame ? !!remote.enabled : snap.enabled,
            autoAnalyze: revSame ? !!remote.autoAnalyze : snap.autoAnalyze,
            systemPromptMode: revSame ? (remote.systemPromptMode || "brief") : (snap.systemPromptMode || "brief"),
            promptScene: revSame ? (remote.promptScene || "general") : (snap.promptScene || "general"),
            // v5.0.0：精简工作流（首次加载同样不能漏读，否则刷新后开关显示回关闭态）
            leanWorkflow: revSame ? remote.leanWorkflow === true : snap.leanWorkflow === true,
            tools: revSame ? (remote.tools || {}) : (snap.tools || {}),
            features: revSame ? (remote.features || {}) : (snap.features || {}),
            plotsDir: remote.plotsDir || "",
            dataDir: remote.dataDir || "",
            // v2.6.0：初始加载同样接入数据目录占用 + 语义引擎状态（与 refresh 白名单一致）
            dataDirSize: remote.dataDirSize || 0,
            embeddingStatus: remote.embeddingStatus || null,
            styleTolerance: revSame ? (remote.styleTolerance || null) : (snap.styleTolerance || null),
            creationProfile: revSame ? (remote.creationProfile || null) : (snap.creationProfile || null),
            creationProfiles: revSame ? (remote.creationProfiles || {}) : (snap.creationProfiles || {}),
            books: remote.books || [],
            booksStats: typeof remote.booksStats === "undefined" ? null : (remote.booksStats || []),
            dirs: remote.dirs || null,
            file: remote.file || "",
            saveFailed: false, // v3.7.0 ③：刷新成功清除错误横幅
            hostOk: true,
            loading: false
          });
          return;
        } catch { /* host unreachable */ }
        try {
          var local = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
          controller.set({
            enabled: typeof local.enabled === "boolean" ? local.enabled : true,
            autoAnalyze: typeof local.autoAnalyze === "boolean" ? local.autoAnalyze : true,
            systemPromptMode: typeof local.systemPromptMode === "string" ? local.systemPromptMode : "brief",
            promptScene: typeof local.promptScene === "string" ? local.promptScene : "general",
            // v5.0.0：精简工作流（宿主不可达时的 localStorage 降级路径；与核心一致只认布尔 true）
            leanWorkflow: local.leanWorkflow === true,
            // v3.5.0 #38：完整恢复本地降级状态
            tools: local.tools || {},
            features: local.features || {},
            styleTolerance: local.styleTolerance || null,
            creationProfile: local.creationProfile || null,
            creationProfiles: local.creationProfiles || {},
            hostOk: false,
            loading: false
          });
        } catch {
          controller.set({ loading: false, hostOk: false });
        }
      };
      // v4.3.0：无论 load 走哪条分支（成功/宿主不可达/localStorage 不可用）都必须摘掉 loading——
      // 宿主挂起时按钮不能永久 disabled（fetch 侧 8s 超时会先兜一层，这里是最后一道）
      load().finally(function () {
        if (controller.getSnapshot().loading) controller.set({ loading: false }, { silent: true });
      });
      var toggle = async function (patch) {
        // v2.6.0 修复：features/tools 深合并——此前浅合并整体替换 state.features，其他开关键丢失后渲染为"开"（关 A 后关 B，A 又变开）
        var merged = Object.assign({}, patch, { saveFailed: false });
        var cur = controller.getSnapshot();
        if (patch.features && typeof patch.features === "object") {
          merged.features = Object.assign({}, cur.features || {}, patch.features);
        }
        if (patch.tools && typeof patch.tools === "object") {
          merged.tools = Object.assign({}, cur.tools || {}, patch.tools);
        }
        // v3.1.1：creationProfiles 深合并（null 键=删除该书的设定，本地立即生效）
        if (patch.creationProfiles && typeof patch.creationProfiles === "object") {
          var mergedCp = Object.assign({}, cur.creationProfiles || {});
          for (var cpk in patch.creationProfiles) {
            if (patch.creationProfiles[cpk] === null) delete mergedCp[cpk];
            else mergedCp[cpk] = patch.creationProfiles[cpk];
          }
          merged.creationProfiles = mergedCp;
        }
        controller.set(merged);
        // v4.3.0：登记在途写入——GET 侧竞态守卫据此禁止用宿主旧快照回写（本函数自身的回读只用 rev 判定，
        // 因为它就是写入方，pendingWrites 在它的 await 期间必然 >0）
        controller.beginWrite();
        try {
          var revAt2 = controller.getSnapshot().rev;
          var remote = await saveState(patch);
          var revSame2 = controller.getSnapshot().rev === revAt2;
          var snap2 = controller.getSnapshot();
          controller.set({
            // v4.0.0 修正：与 tools/features 一致补上 revSame2 守卫——慢响应不再回退用户刚切的总开关
            enabled: revSame2 ? !!remote.enabled : !!snap2.enabled,
            autoAnalyze: revSame2 ? !!remote.autoAnalyze : !!snap2.autoAnalyze,
            systemPromptMode: revSame2 ? (remote.systemPromptMode || "brief") : (snap2.systemPromptMode || "brief"),
            promptScene: revSame2 ? (remote.promptScene || "general") : (snap2.promptScene || "general"),
            // v5.0.0：精简工作流（保存成功后回读宿主 next，同样受 revSame2 守卫保护）
            leanWorkflow: revSame2 ? remote.leanWorkflow === true : snap2.leanWorkflow === true,
            // v3.9.5 修正：保存成功后回读宿主完整 next（tools/features/容差/设定），
            // 前提是期间没有更新的用户操作（rev 未变）——避免服务端钳制/规范化与 UI 长期不一致
            tools: revSame2 && remote.tools ? remote.tools : (snap2.tools || {}),
            features: revSame2 && remote.features ? remote.features : (snap2.features || {}),
            styleTolerance: revSame2 && remote.styleTolerance ? remote.styleTolerance : (snap2.styleTolerance || null),
            creationProfile: revSame2 && remote.creationProfile ? remote.creationProfile : (snap2.creationProfile || null),
            creationProfiles: revSame2 && remote.creationProfiles ? remote.creationProfiles : (snap2.creationProfiles || {}),
            file: remote.file || snap2.file,
            hostOk: true
          });
          try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
          return;
        } catch (err) {
          // v4.3.0：宿主返回的可操作错误（"request body too large (limit 1MB)" / forbidden: loopback-only /
          // 400 校验信息）不再被吞成"网络/路由不可用"——原样显示，同时仍降级保存到本浏览器
          controller.set({ hostOk: false, saveFailed: true, revealMsg: t("panel.saveFailed") + "：" + errorText(err), revealErr: true });
        } finally {
          controller.endWrite();
        }
        try {
          var snapshot = controller.getSnapshot();
          // v3.5.0 #38：宿主不可达时完整持久化（刷新不丢 tools/features/容差/设定）
          // v4.3.0：补写 systemPromptMode——读路径一直会读它（load 的 local.systemPromptMode），
          // 写路径却从不写 → 宿主不可达时切"关闭"，刷新后又变回"精简"（读写不对称）
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: snapshot.enabled, autoAnalyze: snapshot.autoAnalyze, systemPromptMode: snapshot.systemPromptMode || "brief", promptScene: snapshot.promptScene || "general", leanWorkflow: snapshot.leanWorkflow === true, tools: snapshot.tools || {}, features: snapshot.features || {}, styleTolerance: snapshot.styleTolerance || null, creationProfile: snapshot.creationProfile || null, creationProfiles: snapshot.creationProfiles || {} }));
        } catch { /* ignore */ }
      };
            controller.setToggle(toggle);
      // v5.2.0：入口与面板都走官方席位（侧栏一行 + 主栏页面）；拿不到就回退 v5.1.1 的 DOM 注入。
      var officialPanel = false;
      var openPanel = function () {
        controller.set({ panelOpen: !controller.getSnapshot().panelOpen }, { silent: true });
      };
      var disposers = [];
      var legacyEntryDispose = null;
      var legacyPanelDispose = null;
      var mountLegacyEntry = function () {
        if (legacyEntryDispose) return;
        try { legacyEntryDispose = mountSidebarEntry(controller, openPanel) || null; } catch (error) { console.warn("[dsh-novel-writer] UI mount failed:", error); }
      };
      var mountLegacyPanel = function () {
        if (legacyPanelDispose) return;
        try { legacyPanelDispose = mountPanel(controller, toggle) || null; } catch (error) { console.warn("[dsh-novel-writer] UI mount failed:", error); }
      };
      var unmountLegacyEntry = function () {
        if (!legacyEntryDispose) return;
        try { legacyEntryDispose(); } catch { /* ignore */ }
        legacyEntryDispose = null;
      };
      var unmountLegacyPanel = function () {
        if (!legacyPanelDispose) return;
        try { legacyPanelDispose(); } catch { /* ignore */ }
        legacyPanelDispose = null;
      };
      /** 接管官方席位；成功则撤掉 DOM 注入的旧入口与旧面板。 */
      var tryOfficialPanel = function () {
        if (officialPanel) return true;
        if (!registerOfficialPanel(ctx, controller, toggle, disposers)) return false;
        officialPanel = true;
        unmountLegacyEntry();
        unmountLegacyPanel();
        return true;
      };
      mountLegacyEntry();
      mountLegacyPanel();
      exports.__internals.tryOfficialPanel = tryOfficialPanel;   // 供测试直接驱动
      if (!tryOfficialPanel() && typeof ctx.slots.subscribe === "function") {
        // 席位由 shell 包声明，可能晚于我们加载：slots.inject 的回调会在声明后触发，
        // 这里再订一次槽位变化兜底（两条路都只读槽位，不参与宿主激活判定）。
        try {
          var stopWatch = ctx.slots.subscribe("sidebar.panellist", function () { tryOfficialPanel(); });
          if (typeof stopWatch === "function") disposers.push(stopWatch);
        } catch { /* 订阅不可用：slots.inject 的回调仍会在席位声明后触发 */ }
      }
      // 官方设置页「插件配置」卡片（v0.4.0 合并；slots 服务由 inject 声明）
      // 注（v3.9.5）：settings.plugin.item 是 keyed slot——宿主需在其 settingsScope served 集合中登记
      // novel-writer-config 命名空间该卡片才会被渲染；若宿主未实现则此卡片为“仅侧边栏入口”模式，属预期行为
      // v4.3.0 复核：当前宿主只派发已 serve 的 settings 命名空间，插件宿主半从未注册该命名空间 →
      // NovelWriterSettingsCard 实际永不渲染。之所以保留注册与组件（而非按死代码删除）：
      //   1) test/client-test.mjs 以"设置槽位注册（挂载未执行）"作为 apply 走完挂载路径的断言（第 208 行），删掉即测试失败；
      //   2) 宿主侧一旦补上命名空间注册，这里无需再改代码。
      // 若确定永久不做宿主侧注册，可在后续版本连同 card.* 词条一并删除。
      try {
        ctx.slots.inject("settings.plugin.item", function () {
          return ctx.slots.register({
            name: "settings.plugin.item",
            key: "novel-writer-config",
            id: "novel-writer-config",
            order: 105,
            inject: function () { return {}; }
          }, function () {
            return react.createElement(NovelWriterSettingsCard, { controller: controller, onOpenPanel: openPanel });
          });
        });
      } catch (error) {
        console.warn("[dsh-novel-writer] settings card mount failed:", error);
      }
      // v4.3.0：真正用起 inject 里声明的 locale 服务（宿主 @deepseek-ai/dsh-client-locale 通过
      // ctx.provide("locale", locale) 提供 getSnapshot/subscribe）。此前声明了 locale 却全程读
      // document.documentElement.lang，服务白挂；现在语言切换由服务订阅驱动一次同步，
      // 面板内文案（isEn 是渲染期快照）随切换立即更新，不再停留旧语言。
      var localeSub = null;
      var applyLocale = function () {
        try {
          var snap = ctx.locale && typeof ctx.locale.getSnapshot === "function" ? ctx.locale.getSnapshot() : null;
          localeId = snap && typeof snap.active === "string" ? snap.active : "";
        } catch { localeId = ""; }
      };
      try {
        applyLocale();
        if (ctx.locale && typeof ctx.locale.subscribe === "function") {
          localeSub = ctx.locale.subscribe(function () {
            applyLocale();
            controller.set({}, { silent: true });
          });
        }
      } catch { /* locale 服务不可用时退化为 document.documentElement.lang + langObserver */ }
      ctx.effect?.(function () {
        return function () {
          for (var i = 0; i < disposers.length; i += 1) {
            try { disposers[i](); } catch { /* ignore */ }
          }
          if (typeof localeSub === "function") { try { localeSub(); } catch { /* ignore */ } }
        };
      }, "dsh-novel-writer: ui");
    }
    exports.apply = apply;
    exports.inject = inject;
    // v4.3.0：Node 侧探针钩子——宿主只消费 apply/inject，此对象不参与运行时；
    // 用于对纯逻辑（超时封装 / i18n 词条表）做真实断言，无需构建步骤即可测到模块私有函数
    exports.__internals = {
      fetchWithTimeout: fetchWithTimeout,
      makeTimeoutSignal: makeTimeoutSignal,
      errorText: errorText,
      dictionary: dictionary,
      t: t,
      FETCH_TIMEOUT_MS: FETCH_TIMEOUT_MS
    };
    return module.exports;
  }
});
