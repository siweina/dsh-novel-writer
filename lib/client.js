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
    // v6.0.0 页面过渡方向记忆（HyperOS push/pop 分层；模块级而非 state 字段/非 hook——行为契约零变化）
    var nwViewOrder = { main: 0, features: 1, tools: 1, baseline: 1, reports: 1, creation: 1, lexicon: 1, diagnose: 1, model: 2, "creation-form": 2 };
    var nwPrevView = "main";
    var nwViewDir = "fwd";
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
    // 官方原语缺失时必须**包一层**再交回退实现：React 把函数组件当普通函数调用时，
    // 第二个实参是 legacy context（无 contextTypes 的组件恒为 {}），不是 null/undefined，
    // 若把 fallback 直接返回，回退实现里 `context.options` / `context.toggle` 就会拿到
    // undefined 并在真机 React 18 下抛 TypeError（面板白屏）。包一层即可由我们自己算 context。
    function FallbackOnly(props) {
      var input = props || {};
      var context = null;
      try { context = prepare === null ? null : prepare(input); } catch (err) { context = null; }
      return fallback(input, context);
    }
    if (component === null || !canCreate) return FallbackOnly;
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

    // ---- V6 构建链标记区（tools/build-client.mjs 装配；禁止手改标记之间内容） ----
    /* ===== V6:icons ===== */
/* --- V6-icons-a.js --- */
// V6-icons-a.js —— M4a 线图标·主视图批（5 字形）
// 契约：CONTRACT-V6.md 第 1 条铁律 + 第 7 条拆分附录（M4a 行与图标统一规范）。
// 统一规范：viewBox="0 0 24 24" / fill="none" / stroke="currentColor" / stroke-width="1.5"
//           stroke-linecap="round" stroke-linejoin="round；SVG 内零颜色字面量；不引入字体与图片资源。
// key 用语义名（master / autoAnalyze / lean / prompt / scene）；
// key 对应的原字形与设计理由见 V6-icons-a-notes.md 对照表（本文件不放字形字符，避免误扫描）。
// ES5：var + 对象字面量；自包含，不 import 任何本地文件。
var NW_ICONS_A = {
  master: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4V9"/><path d="M12 15V20"/><rect x="7" y="9" width="10" height="6" rx="3"/></svg>',
  autoAnalyze: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5H20"/><path d="M8 19.5V14"/><path d="M12 19.5V11"/><path d="M16 19.5V7"/></svg>',
  lean: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 2.5L5 13H11L10 21.5L18.5 11H12.5Z"/></svg>',
  prompt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5V19A1.5 1.5 0 0 0 7.5 20.5H16.5A1.5 1.5 0 0 0 18 19V8Z"/><path d="M14 3.5V7A1 1 0 0 0 15 8H18"/><path d="M9 11H15"/><path d="M9 14.5H15"/><path d="M9 18H13.5"/></svg>',
  scene: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4V11.5"/><path d="M5.5 16.5V20"/><path d="M3.5 14H7.5"/><path d="M12 4V6.5"/><path d="M12 11.5V20"/><path d="M10 9H14"/><path d="M18.5 4V10"/><path d="M18.5 15V20"/><path d="M16.5 12.5H20.5"/></svg>'
};

/* --- V6-icons-b1a.js --- */
// V6-icons-b1a.js —— M4b1a 线图标·情感批（3 字形）
// 契约：CONTRACT-V6.md 第 1 条铁律 + 第 7 条拆分附录（M4b1a 行与图标统一规范）。
// 统一规范：viewBox="0 0 24 24" / fill="none" / stroke="currentColor" / stroke-width="1.5"
//           stroke-linecap="round" stroke-linejoin="round；SVG 内零颜色字面量；不引入字体与图片资源。
// key 用语义名（emotionCaveat / emotionComplexity / genreTheme）；
// key 对应的原字形与画法理由见 V6-icons-b1a-notes.md 对照表（本文件不放字形字符，避免误扫描）。
// ES5：var + 对象字面量；自包含，不 import 任何本地文件。
var NW_ICONS_B1A = {
  emotionCaveat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5C12 3.5 5.5 11 5.5 15.5C5.5 19.09 8.41 22 12 22C15.59 22 18.5 19.09 18.5 15.5C18.5 11 12 3.5 12 3.5Z"/><path d="M14.6 16.6C15.1 17.4 15.3 18.3 15.1 19.1"/></svg>',
  emotionComplexity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="12" rx="8" ry="9"/><path d="M12 3V21"/><path d="M7.6 11.2C8.3 10 9.7 10 10.4 11.2"/><path d="M13.6 11.2C14.3 10 15.7 10 16.4 11.2"/></svg>',
  genreTheme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5H18V13.2L12 20.5L6 13.2Z"/><circle cx="12" cy="7" r="1.5"/><path d="M9.5 11.5H14.5"/></svg>'
};

/* --- V6-icons-b1b.js --- */
// V6 题材语义图标 · 微批 b1b（M4b1b），共 2 枚 24px 线性图标。
// 数据模块：NW_ICONS_B1B 为 key 到 SVG 字符串的映射表，供总装配方合并进图标集。
// 规范约定：viewBox 24、currentColor 描边继承、全文件零颜色字面量。
// 语法约定：仅 ES5；字符串值用单引号包裹，SVG 属性一律双引号；图形元素自闭合。
// key 一览：webnovelVibe（雷达波，网文信号）/ semanticEmbedding（半脑轮廓，语义增强）。
var NW_ICONS_B1B = {
  webnovelVibe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 20L12 12"/><path d="M11.1 8.6A3.5 3.5 0 0 1 15.4 11.1"/><path d="M10.4 6.2A6 6 0 0 1 17.8 10.4"/></svg>',
  semanticEmbedding: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5A7 7 0 0 0 15 19Z"/><path d="M13.5 8q-2 1.5-1.2 3.2"/><path d="M13.5 12.4q-1.7 0.6-1.4 2.6"/><path d="M13.4 16.3q-1.4 1-1.6-0.1"/></svg>'
};

/* --- V6-icons-b2.js --- */
// V6-icons-b2.js —— M4b2 线图标·语义批（4 字形）
// 契约：CONTRACT-V6.md 第 1 条铁律 + 第 7 条拆分附录（M4b2 行与图标统一规范）。
// 统一规范：viewBox="0 0 24 24" / fill="none" / stroke="currentColor" / stroke-width="1.5"
//           stroke-linecap="round" stroke-linejoin="round；SVG 内零颜色字面量；不引入字体与图片资源。
// key 用语义名（semanticSearch / semanticStyle / semanticImplicit / fallback）；
// key 对应的原字形与设计理由见 V6-icons-b2-notes.md 对照表（本文件不放字形字符，避免误扫描）。
// ES5：var + 对象字面量；自包含，不 import 任何本地文件。
var NW_ICONS_B2 = {
  semanticSearch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M14.9 14.9L19.5 19.5"/></svg>',
  semanticStyle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L9.5 14.5"/><path d="M7.9 12.9L11.1 16.1"/><path d="M7.9 12.9L6 18L11.1 16.1"/></svg>',
  semanticImplicit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12C6 5.5 18 5.5 21.5 12C18 18.5 6 18.5 2.5 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  fallback: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.60 6.78L10.54 3.73L13.46 3.73L13.40 6.78L15.82 8.18L18.43 6.60L19.89 9.13L17.22 10.60L17.22 13.40L19.89 14.87L18.43 17.40L15.82 15.82L13.40 17.22L13.46 20.27L10.54 20.27L10.60 17.22L8.18 15.82L5.57 17.40L4.11 14.87L6.78 13.40L6.78 10.60L4.11 9.13L5.57 6.60L8.18 8.18Z"/><circle cx="12" cy="12" r="2.6"/></svg>'
};

/* --- V6-icons-c.js --- */
/* V6-icons-c.js — M4c 线图标·工具组批（NW_ICONS_C）
   key→字形：analyze=📊 工具组·分析测量 / settings=📚 工具组·设定 / create=✍️ 工具组·创作
             toolRow=🧩 工具行通用 / danger=⚠️ 危险行（rawWriting）
             trash=🗑️ 按书删除与回收站（v6.8.0）
   规范：viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
         stroke-linecap="round" stroke-linejoin="round"；SVG 内零颜色字面量；ES5 var；自包含。 */
var NW_ICONS_C = {
  analyze: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 4v16h16\"/><path d=\"M8.5 20V15\"/><path d=\"M12.5 20V9\"/><path d=\"M16.5 20V12.5\"/></svg>",
  settings: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"4\" y=\"5\" width=\"6\" height=\"14\" rx=\"1\"/><path d=\"M6.3 5v14\"/><path d=\"M4 9h2.3\"/><rect x=\"14\" y=\"5\" width=\"6\" height=\"14\" rx=\"1\"/><path d=\"M16.3 5v14\"/><path d=\"M14 9h2.3\"/></svg>",
  create: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M7 9h10\"/><path d=\"M9.5 9V4.5h5V9\"/><path d=\"M7 9l5 12 5-12\"/><circle cx=\"12\" cy=\"13.3\" r=\"1.6\"/><path d=\"M12 21v-6.1\"/></svg>",
  toolRow: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M5 18V8h4a2 2 0 0 1 4 0h4v4a2 2 0 0 1 0 4v2z\"/></svg>",
  danger: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 4.5L21 19.5L3 19.5Z\"/><path d=\"M12 9.5V15.5\"/><path d=\"M12 18h0.01\"/></svg>",
  storageOpen: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M14 4h6v6M20 4l-9 9\"/><path d=\"M10 4H4v16h16v-6\"/></svg>",
  storageCopy: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"8\" y=\"8\" width=\"12\" height=\"12\" rx=\"2\"/><path d=\"M16 8V4H4v12h4\"/></svg>",
  refresh: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 7v5h-5M4 17v-5h5\"/><path d=\"M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1\"/></svg>",
  navModel: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"5\" y=\"5\" width=\"14\" height=\"14\" rx=\"2\"/><path d=\"M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4\"/><rect x=\"9\" y=\"9\" width=\"6\" height=\"6\" rx=\"1\"/></svg>",
  navReports: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M14 3H5v18h14V8zM14 3v5h5M8 12h8m-8 4h6\"/></svg>",
  navDiagnose: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M9 4H5v17h14V4h-4M9 3h6v4H9zM8 12h2l1-2 2 6 1-3h2\"/></svg>",
  navDemo: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M9 5l11 7-11 7z\"/></svg>",
  trash: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 7h16\"/><path d=\"M9.5 7V4.5h5V7\"/><path d=\"M6.5 7l1 13h9l1-13\"/><path d=\"M10 11v5\"/><path d=\"M14 11v5\"/></svg>"
};

/* --- V6-icons-d.js --- */
// V6-icons-d.js —— M4d-r 线图标·导航栏批（5 字形）+ v6.2.0 词表批（2 字形）
// 统一规范：viewBox="0 0 24 24" / fill="none" / stroke="currentColor" / stroke-width="1.5"
//           stroke-linecap="round" stroke-linejoin="round；SVG 内零颜色字面量；不引入字体与图片资源。
// key 用语义名（navFeatures / navTools / navCreation / navBaseline / navArrow / navLexicon / lexiconFirst）；
// key 对应的原字形与画法见 V6-icons-d-notes.md 对照表（本文件不放字形字符，避免误扫描）。
// ES5：var + 对象字面量；自包含，不 import 任何本地文件。
var NW_ICONS_D = {
  navFeatures: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="2"/><path d="M17.5 12H21.2"/><path d="M14.75 16.76L16.6 19.97"/><path d="M9.25 16.76L7.4 19.97"/><path d="M6.5 12H2.8"/><path d="M9.25 7.24L7.4 4.03"/><path d="M14.75 7.24L16.6 4.03"/></svg>',
  navTools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.48 7.85A4 4 0 1 1 16.15 3.52"/><path d="M13.67 10.33L5.5 18.5"/></svg>',
  navCreation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7C10 5.5 6.5 5.5 4 6.5V17.5C6.5 16.5 10 16.5 12 18"/><path d="M12 7C14 5.5 17.5 5.5 20 6.5V17.5C17.5 16.5 14 16.5 12 18"/><path d="M12 7V18"/></svg>',
  navBaseline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12h0.01"/></svg>',
  navArrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  // v6.2.0：必用词表——左侧词条行 + 右侧书签，表示"把要用的词钉下来"
  navLexicon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.5h9"/><path d="M3.5 12h9"/><path d="M3.5 17.5h6"/><path d="M17 4h4.5"/><path d="M21.5 4v15.2"/><path d="M17 19.2V4"/><path d="M17 19.2l2.25-1.5 2.25 1.5"/></svg>',
  lexiconFirst: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.5h9"/><path d="M3.5 12h9"/><path d="M3.5 17.5h6"/><path d="M17 4h4.5"/><path d="M21.5 4v15.2"/><path d="M17 19.2V4"/><path d="M17 19.2l2.25-1.5 2.25 1.5"/></svg>',
  // v7-A: action-specific tool icons.
  toolBooks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="5" height="16" rx="1"/><path d="M12 4v16M16 5l4 14M5 8h3"/></svg>',
  toolChapters: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  toolRead: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14"/></svg>',
  toolKeywords: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 4 8 1 8 8-7 7-8-8-1-8Z"/><circle cx="8" cy="8" r="1"/></svg>',
  toolSentences: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 10h10M4 14h14M4 18h7"/></svg>',
  toolStyleCheck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h11v7M4 4v16h7M7 8h5M7 12h3m3 5 3 3 5-7"/></svg>',
  toolRevise: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14v6Zm0 0h16"/></svg>',
  toolProfile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V5M4 20h17M8 17v-5M13 17V8M18 17V4"/></svg>',
  toolSearch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5M7 10h6M10 7v6"/></svg>',
  toolContinuity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 15 6-6M10 6l2-2a4 4 0 0 1 6 6l-2 2M14 18l-2 2a4 4 0 0 1-6-6l2-2"/></svg>',
  toolDiagnose: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H5v17h14V4h-4M9 3h6v4H9zM8 14h2l1-3 2 6 1-3h2"/></svg>',
  toolSettings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10"/><circle cx="12" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/></svg>',
  toolPlot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h7a4 4 0 0 1 0 8h-4a2 2 0 0 0 0 4h7M19 3v7m-3-4h6"/></svg>',
  toolSummary: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6V3Zm9 0v5h4M9 12h7M9 16h5"/></svg>',
  toolImport: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v8M4 15v6h16v-6M12 7v10m-4-4 4 4 4-4"/></svg>',
  toolBrief: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V3h8v4M3 12h18M10 12v3h4v-3"/></svg>',
  toolLexicon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14v18H5V3ZM8 7h8M8 11h5M8 15h5M15 15l2 2 3-4"/></svg>',
  toolNewChapter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H5v18h14V9M13 3v6h6M9 15h6M12 12v6"/></svg>',
  toolOutline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/><path d="M6 8v10h8M6 13h11V6h-3M17 3v6M14 6h6"/></svg>'
};

/* --- 构建链注入：图标表合并 --- */
var NW_ICONS = {};
(function () {
  var tables = [NW_ICONS_A, NW_ICONS_B1A, NW_ICONS_B1B, NW_ICONS_B2, NW_ICONS_C, NW_ICONS_D];
  for (var ti = 0; ti < tables.length; ti += 1) {
    if (!tables[ti]) continue;
    var ks = Object.keys(tables[ti]);
    for (var ki = 0; ki < ks.length; ki += 1) NW_ICONS[ks[ki]] = tables[ti][ks[ki]];
  }
})();
/* ===== /V6:icons ===== */
    /* ===== V6:uikit ===== */
/* --- V6-uikit-rows.js --- */
// V6-uikit-rows.js (M3a-r) — 行组件纯函数: PreferenceRow.
// 契约: CONTRACT-V6.md §1 / §4 / §7(M3a 行); ES5 风格(var/function); 零内联样式声明;
// 零硬编码文案; 类名只用 §4 词汇表(不自造). el / h / t / NW_UI / ICONS / props 六参全部
// 由调用方注入: 本文件不自引依赖模块、不碰宿主上下文注入、不碰任何 hook; 官方 Switch 只作为
// h 的类型引用挂载, 绝不在本文件内直接调用. title / summary / label / trailing / bottom
// 文案槽一律直传(由调用方负责套 t()). 由总负责人经 tools/build-client.mjs 拼进 client.js.

// 1) 偏好行: .nwPref > (.nwPrefIcon > .nwPrefGlyph)? + .nwPrefText > (.nwPrefTitle +
//    .nwPrefSummary?) + .nwPrefTrail(Switch 经 h 挂载 或 trailing 槽) + (.nwPrefBottom)?.
//    tone === "danger" 时根类追加 nwPrefDanger; props.className 追加到根类(自动补一个分隔空格,
//    防 "nwPref" 与扩展类名直接黏连). ICONS 命中 -> 字形槽渲染 SVG 字符串; 未命中 -> 渲染原字形
//    (SVG 字符串子节点如何注入由总负责人集成时决定, 此处只按字符串子节点渲染).
function PreferenceRow(el, h, t, NW_UI, ICONS, props) {
  var p = props || {};
  var extra = "";
  if (p.className) extra = " " + String(p.className).replace(/^\s+/, "");
  var iconNode = null;
  if (p.icon) {
    iconNode = h("div", { className: "nwPrefIcon" },
      h("span", { className: "nwPrefGlyph" },
        ICONS && ICONS[p.icon] ? ICONS[p.icon] : p.icon));
  }
  var trailNode;
  if (typeof p.switchOnChange === "function") {
    // 开关一律委托官方组件: 经 h 以引用挂载(形态同 client.js switchRow), 不直接调用.
    trailNode = h(NW_UI.Switch, {
      checked: !!p.switchOn,
      disabled: !!p.switchDisabled,
      label: p.switchLabel || "",
      onChange: p.switchOnChange
    });
  } else {
    trailNode = p.trailing;
  }
  var summaryNode = null;
  if (p.summary !== undefined && p.summary !== null && p.summary !== "") {
    summaryNode = h("div", { className: "nwPrefSummary" }, p.summary);
  }
  var bottomNode = null;
  if (p.bottom !== undefined && p.bottom !== null && p.bottom !== "") {
    bottomNode = h("div", { className: "nwPrefBottom" }, p.bottom);
  }
  return h("div", { key: p.key, className: "nwPref" + (p.tone === "danger" ? " nwPrefDanger" : "") + extra },
    iconNode,
    h("div", { className: "nwPrefText" },
      h("div", { className: "nwPrefTitle" }, p.title),
      summaryNode
    ),
    h("div", { className: "nwPrefTrail" }, trailNode),
    bottomNode
  );
}

/* --- V6-uikit-wrappers.js --- */
// V6-uikit-wrappers.js (M3b) — 五个包装组件纯函数.
// 契约: CONTRACT-V6.md §1 / §4 / §7(M3b 行); ES5 风格(var/function); 零内联样式声明;
// 零硬编码文案; 类名只用 §4 词汇表(不自造); el/h/t/NW_UI 由调用方注入,
// 不自引依赖模块、不碰宿主上下文注入、不碰 hook、不直接调用 NW_UI 组件、零新增状态字段.
// 统一签名 (el, h, t, NW_UI, props); 由总负责人经 tools/build-client.mjs 拼进 V6:uikit 标记区.

// 1) 分组卡片: .nwGCard > (.nwGCardTitle? + .nwGCardBody > children); title 经 t(), 缺省槽位为 null.
function GroupCard(el, h, t, NW_UI, props) {
  var p = props || {};
  return el("div", { className: "nwGCard" },
    p.title ? el("div", { className: "nwGCardTitle" }, t(p.title)) : null,
    el("div", { className: "nwGCardBody" }, p.children)
  );
}

// 2) 分区标题三件套(复用既有类): .nwKickerRow > .nwKicker(经 t()) + .nwKickerRule.
function SectionTitle(el, h, t, NW_UI, props) {
  var p = props || {};
  return el("div", { className: "nwKickerRow" },
    el("div", { className: "nwKicker" }, t(p.label)),
    el("div", { className: "nwKickerRule" })
  );
}

// 3) 对话框卡(复用既有 nwModal 三件套): .nwModal > .nwModalBox > (.nwModalTitle? +
//    .nwModalText? + children + .nwModalBtns(footer)?). 文案槽直传(调用方已拼好或已套 t()) —
//    任务书对本组件未标注 t(); 现状弹窗标题即 "🔞 " + t(...) 形态(client.js L2365/L2377).
function DialogCard(el, h, t, NW_UI, props) {
  var p = props || {};
  return el("div", { className: "nwModal" },
    el("div", { className: "nwModalBox" },
      p.title ? el("div", { className: "nwModalTitle" }, p.title) : null,
      p.description ? el("div", { className: "nwModalText" }, p.description) : null,
      p.children,
      p.footer ? el("div", { className: "nwModalBtns" }, p.footer) : null
    )
  );
}

// 5) v7 导航计数：中性胶囊，不表达开关状态；保留 labelOn/labelOff 兼容旧调用。
function CountBadge(el, h, t, NW_UI, props) {
  var p = props || {};
  var on = !!p.on;
  var text = (p.label !== undefined && p.label !== null)
    ? p.label
    : t(on ? p.labelOn : p.labelOff);
  return el("span", { className: "nwBadge nwCountBadge" }, text);
}

// 6) 行分隔线: 单 div .nwRowDiv, 无子节点; props.key 透传(GroupCard children 数组需 React key).
function RowDivider(el, h, t, NW_UI, props) {
  return el("div", { key: (props || {}).key, className: "nwRowDiv" });
}
/* ===== /V6:uikit ===== */
    /* ===== V6:slider ===== */
/* --- V6-slider.js --- */
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
/* ===== /V6:slider ===== */

    // ---- V6 图标挂载胶水（总负责人手管区；构建只替换标记对之间内容，本段不受重建影响） ----
    // nwGlyph: 表内有 key → 注入 SVG（React 不渲染 HTML 字符串，须经 dangerouslySetInnerHTML；
    //          图标串由构建链从静态文件装配，非用户输入）；无 key → 回退原字形文本。
    function nwGlyph(el, cls, key, fallback) {
      var svg = NW_ICONS ? NW_ICONS[key] : "";
      if (svg) return el("span", { className: cls, "aria-hidden": "true", dangerouslySetInnerHTML: { __html: svg } });
      return el("span", { className: cls }, fallback);
    }
    // nwIconEls: PreferenceRow 的 ICONS 参数需"值即节点"，首次渲染时建表并缓存（el 引用稳定）。
    var NW_ICONS_EL_CACHE = null;
    function nwIconEls(el) {
      if (NW_ICONS_EL_CACHE !== null) return NW_ICONS_EL_CACHE;
      var out = {};
      var ks = Object.keys(NW_ICONS);
      for (var nwI = 0; nwI < ks.length; nwI += 1) {
        out[ks[nwI]] = el("span", { className: "nwIco", "aria-hidden": "true", dangerouslySetInnerHTML: { __html: NW_ICONS[ks[nwI]] } });
      }
      NW_ICONS_EL_CACHE = out;
      return out;
    }

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
  .nwSectionTitle{display:inline-flex;align-items:center;gap:6px;font-weight:700;font-size:13px;line-height:19px;letter-spacing:.02em;color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,var(--dsw-alias-bg-layer-1));border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,var(--dsw-alias-bg-layer-1));border-radius:999px;corner-shape:round;padding:3px 12px;margin-top:10px}.nwTolVer{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);margin:-2px 0 2px;letter-spacing:.03em}.nwTolCard{border-radius:var(--dsw-radius-xl);border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);padding:4px 14px 8px;margin:8px 0 4px}.nwTolRow{display:flex;align-items:center;gap:10px;padding:9px 2px}.nwTolRow+.nwTolRow{border-top:1px dashed var(--dsw-alias-border-l2)}.nwTolName{flex:1;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);font-weight:500;display:flex;align-items:center;gap:8px;white-space:nowrap}.nwTolIcon{font-size:15px;line-height:22px;opacity:.9;flex-shrink:0}.nwTolField{width:66px;flex-shrink:0;display:flex;flex-direction:column;align-items:stretch;gap:3px}.nwTolInput{width:100%;height:30px;padding:0 4px;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);font-size:13px;line-height:20px;text-align:center;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);transition:border-color .18s,box-shadow .18s,background .18s;-moz-appearance:textfield}.nwTolInput::-webkit-outer-spin-button,.nwTolInput::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}.nwTolInput:hover{border-color:var(--dsw-alias-border-l3)}.nwTolInput:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px var(--dsw-focus-ring-color);background:var(--dsw-alias-bg-layer-1)}.nwTolInput::placeholder{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.nwTolCaption{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);text-align:center}.nwTolSep{width:14px;flex-shrink:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);text-align:center}.nwTolPct{width:14px;flex-shrink:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);text-align:left}.nwTolBtns{display:flex;gap:12px;margin-top:16px}.nwBtn.nwBtnPrimary{background:var(--dsw-alias-state-business-primary);border:none;color:var(--dsw-alias-label-primary-foreground);font-weight:600;font-size:13px;line-height:20px;padding:9px 20px;border-radius:var(--dsw-radius-sm);cursor:pointer;box-shadow:var(--dsw-elevation-soft);transition:transform .15s,box-shadow .15s,opacity .15s,filter .15s;font-family:inherit}.nwBtnPrimary:hover{transform:translateY(-1px);box-shadow:var(--dsw-elevation-panel);filter:brightness(1.12)}.nwBtnPrimary:active{transform:translateY(0);box-shadow:var(--dsw-elevation-soft)}.nwBtn.nwBtnDone{background:linear-gradient(135deg,var(--dsw-alias-state-success-primary),var(--dsw-alias-state-success-primary));box-shadow:var(--dsw-elevation-soft);font-family:inherit}.nwBtn.nwBtnGhost{background:transparent;border:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;padding:9px 18px;border-radius:var(--dsw-radius-sm);cursor:pointer;transition:background .15s,border-color .15s,transform .15s;font-family:inherit}.nwBtnGhost:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l3);transform:translateY(-1px)}.nwUpdateBar{display:block;margin:4px 0 8px;padding:7px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;text-decoration:none;border:1px solid var(--dsw-alias-state-success-primary);cursor:pointer}.nwUpdateBar:hover{background:var(--dsw-alias-interactive-bg-hover)}.nwUpdateStale{display:block;margin:4px 0 8px;padding:7px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;border:0.5px solid var(--dsw-alias-border-l2)}
  .nwNavEntry{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;padding:9px 12px;margin:4px 0;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);cursor:pointer;text-align:left;color:inherit;font:inherit;transition:box-shadow .2s var(--nw-ease),transform .18s var(--nw-ease)}
  .nwNavEntry:hover{box-shadow:var(--dsw-elevation-panel);transform:translateY(-1px);font-family:inherit}
  .nwNavEntryText{flex:1;min-width:0;padding-right:8px}
  .nwNavEntryTitle{font-size:13px;line-height:20px;font-weight:600}
  .nwNavEntryHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
  .nwNavEntryRight{display:flex;align-items:center;gap:6px;flex:none}
  .nwNavEntryRight .nwBadge{white-space:nowrap;flex:none}
  .nwNavEntryArrow{font-size:18px;line-height:26px;color:var(--dsw-alias-label-tertiary);flex:none}
  .nwBackBtn{display:flex;width:fit-content;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 14px;margin:2px 0 6px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;cursor:pointer;font-family:inherit;transition:background .16s var(--nw-ease),color .16s var(--nw-ease),box-shadow .2s var(--nw-ease)}
  .nwModelBtn{font-size:11px;line-height:16px;padding:2px 6px;margin-top:4px;border:0.5px solid var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;font-family:inherit}
  .nwToolRight{display:flex;flex-direction:column;align-items:flex-end;gap:4px}

  /* ===== 导航/入口 ===== */
  .nwEntry{width:100%;height:32px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-radius:var(--dsw-radius-md);align-items:center;gap:8px;padding:0 12px;font-size:13px;line-height:20px;display:flex;font-family:inherit}
  .nwEntry:hover{background:var(--dsw-specific-sidebar-nav-item-hover);color:var(--dsw-alias-label-primary);font-family:inherit}
  .nwEntry[data-active]{background:var(--dsw-specific-sidebar-nav-item-active);color:var(--dsw-alias-label-primary);font-weight:600}
  .nwEntryIcon{flex:none;justify-content:center;align-items:center;display:inline-flex;width:16px;font-size:13px;line-height:20px}
  .nwEntryLabel{text-overflow:ellipsis;overflow:hidden}
  .nwPanel{--nw-ease:cubic-bezier(.16,1,.3,1);scrollbar-gutter:stable;width:100%;max-width:560px;margin:0 auto;padding:28px 24px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);display:flex;flex-direction:column;gap:10px}
  .nwPanelHeader{display:flex;align-items:center;gap:10px}
  .nwPanelTitle{font-size:16px;line-height:24px;font-weight:700;letter-spacing:-.02em;flex:1;min-width:0}
  .nwClose{appearance:none;font:inherit;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);width:30px;height:30px;padding:0;font-size:15px;line-height:1;transition:background .16s var(--nw-ease),color .16s var(--nw-ease),box-shadow .2s var(--nw-ease)}
  .nwRefresh{appearance:none;font:inherit;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);height:30px;padding:0 12px;font-size:12px;line-height:18px;transition:background .16s var(--nw-ease),color .16s var(--nw-ease),box-shadow .2s var(--nw-ease)}
  .nwRefresh:hover,.nwClose:hover,.nwBackBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-family:inherit}
  .nwDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.6;margin:0}
  .nwRefreshSpin{animation:nwspin 1s linear infinite}

  /* ===== 横幅与开关 ===== */
  .nwBanner{display:flex;align-items:center;gap:10px;border-radius:var(--dsw-radius-lg);padding:14px 16px;font-size:15px;line-height:22px;font-weight:700;border:0.5px solid}
  .nwBannerOn{background:var(--dsw-alias-state-success-tertiary);border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
  .nwBannerOff{background:var(--dsw-alias-state-danger-tertiary);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-error)}
  .nwBannerIcon{flex:none;font-size:18px;line-height:1}
  .nwBannerSub{font-size:12px;line-height:18px;font-weight:500;opacity:.9;margin-left:6px}
  .nwRow{display:flex;align-items:center;gap:14px;border:0;background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-lg);padding:14px 16px;box-shadow:var(--dsw-elevation-soft);transition:box-shadow .2s var(--nw-ease),transform .18s var(--nw-ease)}
  .nwRow:hover{box-shadow:var(--dsw-elevation-panel);transform:translateY(-1px)}
  .nwRowOn{background:none;box-shadow:none}
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
  .nwBadgeOn{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-business-primary)}
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
  /* v6.4.0：裸 .nwBtn 此前是旧样式（font-size:11px;line-height:1;padding:5px 10px），
     与设计体系的按钮（.nwBtnPrimary / .nwBtnGhost 都是 13px / line-height 20px / padding 9px 18-20px）不是一套——
     实测「整层覆盖」（裸 nwBtn）比它旁边的「合并追加」（nwBtnPrimary）小一号、高低不齐。
     有调用点甚至用内联 style（padding:9px 20px）硬凑（见 creation 表单的保存/清空钮），属补丁而非修根。
     现在把基类的几何对齐到设计体系；底色/描边沿用基类自己的（与 .nwBtnGhost 一致）。 */
  .nwBtn{font-size:13px;line-height:20px;padding:9px 18px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;transition:background .16s var(--nw-ease),box-shadow .2s var(--nw-ease),transform .18s var(--nw-ease)}
  /* ⚠️ .nwBtn 在源序上位于 .nwBtnPrimary 之后，同特异度会把它压掉（padding 变 18px 而非 20px）。
     这里显式放行 Primary 的几何，与下方已有的 .nwBtn.nwBtnPrimary:hover 同一处理思路。 */
  .nwBtn.nwBtnPrimary{padding:9px 20px;border:none}
  .nwBtn:hover{background:var(--dsw-alias-bg-layer-2);font-family:inherit}
  /* v6 真机首验：本规则(L源序在后)与 .nwBtnPrimary:hover 同特异 → hover 底色被抢成浅灰（保存钮变全白）。复合放行： */
  .nwBtn.nwBtnPrimary:hover{background:var(--dsw-alias-state-business-primary)}
  .nwBtn.nwBtnDone:hover{background:linear-gradient(135deg,var(--dsw-alias-state-success-primary),var(--dsw-alias-state-success-primary))}
  .nwBtn.nwBtnDanger:hover{background:var(--dsw-alias-state-error-primary)}
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
  .nwToolRow.nwToolRowRaw{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 5%,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-panel)}
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
  .nwToolsHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:6px 0 14px}
  .nwToolRow{display:flex;align-items:center;gap:10px;border:0;background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-md);padding:10px 14px;box-shadow:var(--dsw-elevation-soft);transition:box-shadow .2s var(--nw-ease),transform .18s var(--nw-ease)}
  .nwToolRow:hover{box-shadow:var(--dsw-elevation-panel);transform:translateY(-1px)}
  .nwToolRow+.nwToolRow{margin-top:10px}
  .nwRow+.nwToolRow,.nwToolRow+.nwRow{margin-top:10px}
  .nwToolRow+.nwPlotBox{margin-top:10px}
  .nwToolRowOn{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-panel)}
  .nwToolLabel{flex:1;min-width:0;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-primary)}
  .nwToolDesc{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary);margin-top:2px}

  /* ===== 工具组 ===== */
  .nwToolGroup{border:0;border-radius:var(--dsw-radius-md);margin-bottom:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft)}
  .nwToolGroupBody .nwToolRow{box-shadow:none;background:transparent;transform:none}
  .nwToolGroupBody .nwToolRowOn{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,var(--dsw-alias-bg-layer-1))}
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
  .nwPanelMain{width:100%;max-width:760px;margin:0 auto;padding:28px 24px 48px;gap:10px;box-sizing:border-box;height:100%;overflow:auto;scrollbar-gutter:stable}

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
  .nwHero{display:flex;flex-direction:column;gap:6px;border-radius:var(--dsw-radius-xl);padding:18px 18px 16px;border:0.5px solid var(--dsw-alias-border-l4);background-color:var(--dsw-alias-bg-layer-2);background-image:radial-gradient(340px 120px at top center,color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,var(--dsw-alias-bg-layer-2)) 0%,var(--dsw-alias-bg-layer-2) 72%);box-shadow:none}
  .nwHero .nwBanner{background:transparent;border-color:transparent;padding:2px 0;box-shadow:none;letter-spacing:-.01em}
  .nwHero .nwBannerOn,.nwHero .nwBannerOff{background:transparent;border-color:transparent}
  .nwHeroDesc{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
  .nwSection{display:flex;flex-direction:column;gap:12px;margin-top:16px}
  .nwKickerRow{display:flex;align-items:center;gap:10px}
  .nwKicker{display:inline-flex;align-items:center;gap:6px;padding:3px 12px;border-radius:999px;corner-shape:round;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,var(--dsw-alias-bg-layer-1));border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:17px;font-weight:700;letter-spacing:.04em;flex:none}
  .nwKickerRule{flex:1;min-width:0;height:1px;background:var(--dsw-alias-border-l2)}
  .nwIconSlot{flex:none;width:34px;height:34px;display:flex;align-items:center;justify-content:center;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,var(--dsw-alias-bg-layer-1));border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,var(--dsw-alias-bg-layer-1))}
  .nwIconGlyph{font-size:15px;line-height:20px;color:var(--dsw-alias-state-business-primary)}
  .nwPillRow{display:flex;flex-wrap:wrap;gap:8px}
  .nwPill{display:inline-flex;align-items:baseline;gap:8px;padding:7px 16px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-layer-2);transition:background .16s var(--nw-ease)}
  .nwPillKey{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
  .nwPillVal{font-size:13px;line-height:18px;font-weight:650;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
  /* 微交互总门：减少动态效果时关掉 hover 抬升与过渡（模态入场动画原本就在 no-preference 门内） */
  @media (prefers-reduced-motion: reduce){
    .nwRow,.nwNavEntry,.nwToolRow,.nwBtn,.nwChip,.nwPill,.nwSwitch,.nwSwitchKnob,.nwSegBtn{transition:none!important}
    .nwRow:hover,.nwNavEntry:hover,.nwToolRow:hover,.nwBtnPrimary:hover,.nwBtnGhost:hover{transform:none!important}
    .nwBtnPrimary:hover{filter:none!important}
  }
  /* ===== V6:css ===== */
/* --- V6-components.css --- */
/* V6-components.css (M2) — §4 新建 20 类的统一样式.两空格紧凑写法,零颜色字面量,token 仅白名单 --dsw-* (+沿用 --nw-ease 缓动变量). */
.nwGCard{margin:0;border:0;border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-soft);overflow:hidden}
.nwGCard+.nwGCard{margin-top:12px}
.nwGCardTitle{padding:14px 16px 6px;font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.nwGCardBody{padding:0}
.nwPref{display:flex;align-items:center;gap:14px;padding:14px 16px;background:none;transition:background .16s var(--nw-ease,cubic-bezier(.16,1,.3,1))}
.nwPref:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nwPrefIcon{flex:none;width:34px;height:34px;display:flex;align-items:center;justify-content:center;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,var(--dsw-alias-bg-layer-2));border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-state-business-primary)}
.nwPrefGlyph{display:inline-flex;align-items:center;justify-content:center;font-size:15px;line-height:20px;color:var(--dsw-alias-state-business-primary)}
.nwPrefGlyph svg{width:20px;height:20px;display:block}
.nwPrefText{flex:1;min-width:0}
.nwPrefTitle{font-size:14px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.nwPrefSummary{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
.nwPrefTrail{flex:none;display:flex;align-items:center;gap:8px;margin-left:auto}
.nwPrefBottom{display:flex;align-items:center;gap:10px;padding:0 16px 12px}
.nwPref.nwPrefDanger{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 5%,var(--dsw-alias-bg-layer-2))}
.nwRowDiv{height:0.5px;margin:0 16px;background:var(--dsw-alias-border-l2)}
.nwEmpty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:24px 16px}
.nwEmptyTitle{font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.nwEmptyHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-top:4px}
.nwField{display:flex;align-items:center;gap:10px;padding:10px 16px}
.nwFieldCtl{flex:none;display:flex;align-items:center;gap:8px;margin-left:auto}
/* .nwRange 本体外观归 M5(V6-slider-css.txt),此处仅预留 flex 布局槽,合并冲突以 M5 为准. */
.nwRange{flex:1;min-width:0}
.nwRangeVal{flex:none;min-width:36px;text-align:right;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion: reduce){.nwGCard,.nwPref{transition:none!important}}
/* 风格基线·范围选择器（选「按部分」时的章节多选）：列表自身可滚动，侧栏高度有限时也不撑破面板。 */
.nwBasePick{padding:0 16px 12px}
.nwBaseList{max-height:230px;overflow-y:auto;overscroll-behavior:contain;margin-top:8px;padding:4px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.nwBaseItem{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:var(--dsw-radius-sm);cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.nwBaseItem:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}
.nwBaseItemText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nwBaseCheck{flex:none;margin:0;accent-color:var(--dsw-alias-state-business-primary)}
/* 存量的显式清空行（已选摘要旁 / 档位=按全书而存量非空时）：说明占满余宽，破坏性按钮靠右。 */
.nwBaseClear{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:10px}
/* 诊断·「值得注意」区块（v6.6.0）。
   修复由来（用户反馈）：原先直接用 .nwBoxed，而那个类只有 0.5px 边框、没有阴影，
   于是"得看老一会才看得出边框"；整块也没有外边距，与上下组件贴在一起。
   这里改成与 .nwGCard 同一套观感（layer-2 底 + 柔和阴影 + xl 圆角），留白对齐 .nwGCard 的 12px。
   注意：本文件会被整体内联进模板字符串，注释里不要写反引号、也不要写花括号。 */
.nwDiagIssues{margin:12px 0}
.nwDiagIssueList{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.nwDiagIssue{background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-xl);box-shadow:var(--dsw-elevation-soft);padding:9px 12px}
/* v7 Foundation：安静的默认态，标题栏承担导航。 */
.nwPanelHeader{gap:12px;align-items:center;margin-bottom:8px}
.nwHeaderIdentity{display:flex;align-items:center;gap:12px;min-width:0;flex:1;flex-wrap:wrap}
.nwPanelTitle{font-size:18px;line-height:26px;font-weight:600}
.nwHeaderPage{font-size:15px;line-height:22px;font-weight:600;border-left:0.5px solid var(--dsw-alias-border-l2);padding-left:12px}
.nwPanelHeader .nwBackBtn{margin:0;padding:4px 0;border:0;background:none;box-shadow:none;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.nwHeaderStatus{font-size:12px;line-height:18px;white-space:nowrap;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-layer-3);padding:3px 8px;color:var(--dsw-alias-label-tertiary)}
.nwHeaderStatusOn{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}
.nwRefresh{display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:6px;flex:none}
.nwIco svg{width:20px;height:20px}
.nwHomeSubtitle{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0 0 20px}
.nwSection{gap:0;margin:0}
.nwKickerRow{margin:24px 0 8px;padding:0 16px}
.nwKicker{background:none;border:0;border-radius:0;padding:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-weight:600;letter-spacing:0}
.nwKickerRule{display:none}
.nwPref{min-height:56px;box-sizing:border-box;gap:12px;flex-wrap:wrap}
.nwPrefIcon,.nwIconSlot{width:32px;height:32px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);flex:none;display:flex;align-items:center;justify-content:center}
.nwPrefGlyph{color:inherit}
.nwPrefTitle,.nwNavEntryTitle{font-size:14px;line-height:22px;font-weight:500}
.nwPrefSummary,.nwNavEntryHint{font-size:12.5px;line-height:18px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--dsw-alias-label-secondary)}
.nwPrefBottom{flex-basis:100%;padding:0 0 0 44px;min-width:0}
.nwPref.nwPrefDanger{background:none}
.nwRowDiv{margin:0 16px 0 60px}
.nwCountBadge{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3);border:0;white-space:nowrap;font-size:12px;line-height:18px;flex:none}
.nwNote,.nwPlotMsg,.nwWarnBanner{border:0;border-radius:var(--dsw-radius-md);padding:10px 12px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3)}
.nwNoteAccent{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.nwNoteWarn,.nwWarnBanner{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary)}
.nwNoteDanger,.nwPlotErr{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,var(--dsw-alias-bg-layer-2))}
.nwErrorDetails{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-top:4px;overflow-wrap:anywhere}
.nwAgeTag{display:inline-block;margin-right:8px;padding:0 4px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:nowrap}
.nwStorage{margin-top:24px}
.nwDisclosureTitle{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none;padding:16px;font-size:13px;line-height:20px;font-weight:500}
.nwDisclosureTitle::-webkit-details-marker{display:none}
.nwDisclosureArrow{font-size:18px;line-height:20px;color:var(--dsw-alias-label-tertiary);transition:transform .15s}
details[open]>.nwDisclosureTitle .nwDisclosureArrow{transform:rotate(90deg)}
.nwStorageBody{padding:0 16px 8px}
.nwStorageItem{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:12px 0;border-top:0.5px solid var(--dsw-alias-border-l2)}
.nwStorageMeta{flex:1;min-width:160px}
.nwStorageLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.nwStoragePath{font-family:monospace;font-size:12px;line-height:18px;overflow-wrap:anywhere;user-select:text;color:var(--dsw-alias-label-secondary)}
.nwStorageActions{display:flex;gap:8px;flex:none}
.nwBtn.nwStorageBtn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 6px;border:0;background:none;box-shadow:none;font-size:12px;line-height:18px;white-space:nowrap;transform:none}
.nwStorageBtn svg{width:14px;height:14px}
.nwUpdateStale{margin:16px 0 0;padding:0;border:0;background:none;font-size:12px;line-height:18px}
@media(max-width:480px){.nwPrefText{min-width:150px}.nwPrefTrail{max-width:100%;white-space:nowrap}.nwPrefTrail:has(.nwSeg){width:calc(100% - 44px);margin-left:44px;white-space:normal}.nwPrefTrail .nwSeg{flex-wrap:wrap;max-width:100%}.nwPrefTrail .nwSegBtn{white-space:nowrap;flex:none}.nwHeaderIdentity{gap:8px}.nwHeaderPage{padding-left:8px}.nwPrefBottom{padding:0}}
@media(prefers-reduced-motion:reduce){.nwDisclosureArrow{transition:none}}
.nwHeaderIdentity .nwPanelTitle{flex:none}
.nwHome .nwNavEntry{min-height:56px;gap:12px}
.nwHome .nwNavEntryText{padding-right:0}
.nwHome .nwNavEntry:disabled{cursor:wait;opacity:.65}
.nwHome .nwIconGlyph{color:var(--dsw-alias-label-secondary)}
.nwHome .nwPrefText{min-width:0}
.nwHome .nwPrefTrail{white-space:nowrap}
.nwLibrary{border-top:0.5px solid var(--dsw-alias-border-l2);margin:0 16px}
.nwLibrary>.nwDisclosureTitle{padding:12px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-weight:400}
.nwLibraryBooks{padding:0 0 12px}
.nwLibraryBook{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;padding:8px 0;font-size:12px;line-height:18px}
.nwLibraryName{flex:1;min-width:80px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.nwLibraryMeta,.nwLibraryIdle{color:var(--dsw-alias-label-tertiary)}
.nwDemoReport{margin:0 16px 16px;max-height:260px;overflow:auto}
.nwGlobalNote{margin-bottom:12px;white-space:pre-wrap}
.nwUpdateBar.nwNoteAccent{border:0;margin:0 0 12px;padding:10px 12px;font-size:12.5px;line-height:18px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}
.nwPromptRow{min-width:0}
@media(max-width:480px){.nwPromptRow .nwPrefTrail{flex-basis:calc(100% - 44px);width:calc(100% - 44px);margin-left:44px;white-space:normal}.nwPromptRow .nwPrefTrail>*{max-width:100%;flex-wrap:wrap}.nwPromptRow .nwPrefTrail [role="tablist"]{max-width:100%;flex-wrap:wrap}.nwPromptRow .nwPrefTrail button{white-space:nowrap;flex:none}}
/* v7 共享：小号按钮与危险文字按钮（合并时统一） */
.nwBtn.nwBtnSm{height:28px;padding:0 10px;font-size:12.5px;line-height:18px;display:inline-flex;align-items:center;white-space:nowrap}
.nwBtn.nwBtnDangerText{color:var(--dsw-alias-state-error-primary)}
/* ==== v7-A: features / tools / model ==== */
.nwFeaturesPage,.nwToolsPage,.nwModelPage{min-width:0}
.nwFeatureActions{display:flex;align-items:center;gap:12px;white-space:nowrap}
.nwBtn.nwFeatureModelLink{border:0;background:none;box-shadow:none;padding:4px 0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;transform:none}
.nwToolCategory+.nwToolCategory{margin-top:12px}
.nwToolsPage .nwToolGroupHead{box-sizing:border-box;padding:16px 16px 0;gap:16px;background:none;font-size:14px;line-height:22px}
.nwToolsPage .nwToolGroupHead:hover{background:none}
.nwToolsPage .nwToolGroupHeadBtn{min-width:0;gap:8px;font-size:14px;line-height:22px}
.nwToolsPage .nwToolGroupName{font-weight:500;white-space:nowrap}
.nwToolCategoryArrow{display:inline-flex;align-items:center;justify-content:center;flex:none;color:var(--dsw-alias-label-tertiary)}
.nwToolCategoryArrow svg{width:14px;height:14px}
.nwToolCategoryArrowOpen{transform:rotate(90deg)}
.nwToolAll{display:flex;align-items:center;gap:8px;flex:none;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.nwToolCategoryHint{padding:6px 16px 14px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.nwToolCategoryBody .nwRowDiv:first-child{margin-left:16px}
.nwModelSubHint{padding:14px 16px 0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
@media(max-width:480px){.nwFeaturesPage .nwFeatureModelRow .nwPrefTrail{flex-basis:calc(100% - 44px);margin-left:44px}.nwFeatureModelRow .nwFeatureActions{width:100%;justify-content:space-between}.nwToolsPage .nwToolGroupHead{gap:8px}.nwToolsPage .nwPrefText,.nwModelPage .nwPrefText{min-width:0}}
/* ==== end v7-A ==== */
/* ==== v7-B: lexicon / creation / edit ==== */
.nwLexPage .nwRowDiv,.nwCreationPage .nwRowDiv{margin-left:16px}
.nwLexPage .nwPrefText,.nwCreationPage .nwPrefText{min-width:120px}
.nwLexPage .nwPrefBottom,.nwCreationPage .nwPrefBottom{padding-left:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.nwLexToolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:16px;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.nwLexToolbar .nwTextInput{flex:1;min-width:150px;width:0}
.nwLexToolbar .nwBtn,.nwCreationNew .nwBtn{flex:none;white-space:nowrap}
.nwLexForm{margin-top:16px;scroll-margin-top:16px}
.nwLexForm .nwField{flex-wrap:wrap;gap:8px 16px;min-width:0}
.nwLexForm .nwRowText{flex:1;min-width:150px}
.nwLexForm .nwFieldCtl{max-width:100%;flex-wrap:wrap}
.nwLexForm .nwTextInput{width:240px;max-width:100%;box-sizing:border-box}
.nwLexImport{margin-top:12px}
.nwLexImport>.nwGCard{margin-top:8px}
.nwLexImportBody{padding:16px;display:flex;flex-direction:column;gap:12px}
.nwLexImportBody .nwTextArea{width:100%;box-sizing:border-box;min-height:120px}
.nwLexActions,.nwCreationActions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;justify-content:flex-end}
.nwLexAudit{margin-top:16px}
.nwLexAdvanced{margin-top:24px}
.nwLexPage .nwStoragePath{white-space:pre-line}
.nwLexPage .nwPrefTrail:has(.nwSeg){max-width:100%}
.nwCreationNew{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
.nwCreationNew .nwTextInput{flex:1;min-width:150px;width:0;box-sizing:border-box}
.nwCreationPage .nwPrefTitle{overflow-wrap:anywhere}
.nwCreationPage .nwChip{white-space:nowrap;border:0;background:none;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.nwCreationBack{display:inline-flex;align-items:center;min-height:36px;margin:0 0 8px;padding:0;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.nwCreationField{padding:16px;display:flex;flex-direction:column;gap:4px}
.nwCreationField+.nwCreationField{border-top:0.5px solid var(--dsw-alias-border-l2)}
.nwCreationField .nwTextArea{margin-top:4px;width:100%;box-sizing:border-box;resize:vertical}
.nwCreationActions{justify-content:flex-start;margin-top:16px}
@media(max-width:480px){.nwLexPage .nwPrefTrail:has(.nwSeg){width:100%;margin-left:0}.nwLexForm .nwFieldCtl{width:100%;margin-left:0}.nwLexForm .nwTextInput{width:100%}.nwLexForm .nwFieldCtl .nwTextInput{flex:1;min-width:0}.nwLexPage .nwPrefTrail:has(.nwSelWrap),.nwCreationPage .nwPrefTrail:has(.nwSelWrap){max-width:100%}.nwLexToolbar .nwTextInput{flex-basis:100%;width:100%}.nwLexToolbar .nwBtn{margin-left:auto}}

/* ==== end v7-B ==== */
/* ==== v7-C: baseline / reports / diagnose ==== */
/* C: aligned tolerance fields and quiet report groups */
.nwBasePick .nwBaseItemText{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere}
.nwBaseTolRow{display:grid;grid-template-columns:minmax(160px,1fr) minmax(120px,160px) minmax(120px,160px);align-items:center;gap:16px;padding:16px}
.nwBaseTolRow+.nwBaseTolRow{border-top:0.5px solid var(--dsw-alias-border-l2)}
.nwBaseTolName{display:flex;align-items:center;gap:8px;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.nwBaseHelp{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:help}
.nwBaseTolField{display:flex;align-items:center;gap:8px;min-width:0}
.nwBaseTolLabel{flex-shrink:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.nwBaseTolControl{display:flex;align-items:center;gap:4px;min-width:0;flex:1}
.nwBaseTolControl .nwTolInput{width:100%;min-width:0;max-width:88px;height:36px;padding:6px;font-size:13px;line-height:20px}
.nwBaseTolUnit{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.nwBaseActions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin:16px 0}
.nwBaseRaw{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.nwReportsGroup+.nwReportsGroup{margin-top:12px}
.nwReportsHead{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px;font-size:14px;line-height:22px;font-weight:600}
.nwReportsFile{display:flex;align-items:center;justify-content:space-between;width:100%;box-sizing:border-box;gap:16px;padding:14px 16px;border:0;border-top:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:default}
/* v6.8.0 修正（实测踩到）：这一行原本是 <button>（浏览器 UA 给按钮 box-sizing:border-box），
   改成 <div> 后变回 content-box → width:100% + 左右各 16px 内边距让整行比卡片宽 32px，
   最右边的删除按钮被卡片 overflow:hidden 裁掉半截。显式写死 border-box。 */
.nwReportsFile:hover{background:var(--dsw-alias-bg-layer-1)}
/* v6.8.0：报告行改为三段（打开 / 日期 / 删除），打开按钮承担原来整行的点击区域。
   右侧两个元素都**不参与 flex 收缩**，并用 min-width:max-content 兜底——
   只靠 white-space:nowrap 时，按钮在部分宿主的 button reset 下仍会被压成一字一行（实测过）。 */
.nwReportsOpen{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;padding:0;margin:0;border:0;background:none;box-shadow:none;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;transform:none}
.nwReportsOpen:hover{color:var(--dsw-alias-state-business-primary)}
.nwReportsFile>.nwReportsDate{flex:none}
.nwReportsFile>.nwBtn{flex:none;min-width:max-content;white-space:nowrap}
.nwReportsLabel{min-width:0;overflow-wrap:anywhere}
.nwReportsHash{margin-left:8px;color:var(--dsw-alias-label-tertiary);font-family:monospace;font-size:12px;line-height:18px}
.nwReportsDate{flex-shrink:0;margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:right}
.nwReportsBody,.nwDiagReport{margin:12px 0 0;padding:16px;max-height:440px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;font-family:monospace;font-size:12.5px;line-height:20px;border:0;border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-primary)}
.nwDiagHeading{padding:16px 16px 8px;font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}
.nwDiagAttentionList{padding:0 16px 16px;display:flex;flex-direction:column;gap:12px}
.nwDiagAttentionItem{min-width:0}
.nwDiagAttentionItem .nwNote{margin:0;color:var(--dsw-alias-label-primary)}
.nwDiagDetail{margin-top:6px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:20px;overflow-wrap:anywhere}
@media(max-width:540px){.nwBaseTolRow{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px 16px}.nwBaseTolName{grid-column:1 / -1}.nwBaseTolControl .nwTolInput{max-width:none}.nwReportsFile{flex-wrap:wrap;gap:6px}.nwReportsLabel{flex-basis:100%}.nwReportsDate{font-size:12px;line-height:18px}}
/* ==== end v7-C ==== */
/* ==== v7-D: 按书删除 / 回收站（issue #2） ====
   列表本身复用 .nwPref（图标+标题+副标题+右侧动作），这里只补三样小件：
   ① 行尾的"文字动作"（恢复 / 彻底删除 / 删除整本书…）——不用带边框的按钮，
      否则一行里最扎眼的是那个红框，与全站的"安静默认态"不一致；
   ② 卡片内的文字块（提示 / 空态）需要 16px 内边距，否则文字顶到卡片边缘；
   ③ 位置清单的勾选行与"全选/全不选"。
   颜色只用语义 token；边框一律 0.5px；有阴影就不加边框（R05）。 */
.nwLibraryDel{flex:none;margin-left:auto;white-space:nowrap}
.nwRowAction{flex:none;min-width:max-content;border:0;background:none;box-shadow:none;padding:4px 0;margin:0;font:inherit;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer;transform:none}
.nwRowAction:hover{color:var(--dsw-alias-label-primary)}
.nwRowAction:disabled{color:var(--dsw-alias-label-dimmed);cursor:not-allowed}
.nwRowAction.nwRowActionDanger{color:var(--dsw-alias-state-error-primary)}
.nwRowAction.nwRowActionDanger:disabled{color:var(--dsw-alias-label-dimmed)}
.nwPageBlock{padding:0 16px 4px}
.nwCardHint{padding:14px 16px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.nwCardHint:first-child{padding-top:12px}
.nwWarnText{color:var(--dsw-alias-state-error-primary)}
.nwDelList{display:flex;flex-direction:column;gap:2px;margin:12px 0 0}
.nwDelRow{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:12.5px;line-height:18px}
.nwDelRowLabel{flex:1;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.nwDelRowMeta{flex:none;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.nwDelRowPick{align-items:center;gap:8px;cursor:pointer}
.nwDelRowPick input{flex:none;margin:0}
.nwDelSelActions{display:flex;align-items:center;gap:16px;margin-top:10px}
.nwDelPath{margin-top:10px;font-family:monospace;font-size:11.5px;line-height:17px;overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary)}
.nwDelAck{display:flex;align-items:flex-start;gap:8px;margin-top:14px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.nwDelAck input{margin:2px 0 0;flex:none}

/* --- V6-slider-css.txt --- */
/* V6-slider-css.txt (M5) — 只含 nwRange 本体 + nwRangeVal, 由总负责人并入样式表. */
/* 口径: 轨道/滑块/禁用态/焦点环/值显; 伪元素只做尺寸与圆角, 颜色走本体 token; 动效进 reduced-motion 门. */
.nwRange {
  width: 96px;
  accent-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-active);
  border-radius: 999px;
  corner-shape: round;
}
.nwRange:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset: 2px;
}
.nwRange:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.nwRange::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 999px;
  corner-shape: round;
}
.nwRange::-webkit-slider-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  corner-shape: round;
}
.nwRange::-moz-range-track {
  height: 4px;
  border-radius: 999px;
  corner-shape: round;
}
.nwRange::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  corner-shape: round;
}
.nwRangeVal {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  min-width: 36px;
}
@media (prefers-reduced-motion: no-preference) {
  .nwRange {
    transition: opacity 0.15s ease;
  }
}
/* ===== /V6:css ===== */
  /* ---- V6 挂载胶水样式（总负责人手管区） ---- */
  .nwIconGlyph svg,.nwToolGroupIcon svg{width:20px;height:20px;display:block}
  .nwIco{display:inline-flex;align-items:center;justify-content:center}
  .nwPrefGlyph .nwIco{color:inherit}
  /* ---- P2-1: .nwPref{background:none} 与 .nwRowOn 同特异性后写者胜 → 复合选择器放行 On 态底色（含 hover） ---- */
  /* ---- 裸堆叠行距（不在卡内的 PreferenceRow 与遗留 nwRow 混排）；卡内行间由 RowDivider 分隔，分隔线打断相邻选择器故不叠加 ---- */
  .nwPref+.nwPref,.nwRow+.nwPref,.nwPref+.nwRow,.nwPref+.nwPlotBox{margin-top:10px}
  /* ---- 卡内元素拍平（导航卡/pill/路径收纳进 GroupCard 后的样式） ---- */
  .nwGCardBody .nwNavEntry{box-shadow:none;background:none;margin:0;border-radius:0;transform:none;padding:14px 16px}
  .nwGCardBody .nwNavEntry:hover{box-shadow:none;background:var(--dsw-alias-interactive-bg-hover);transform:none}
  .nwGCardBody .nwPillRow{padding:14px 16px 4px}
  .nwGCardBody .nwPlotBox{margin:8px 16px 4px}
  .nwGCardBody .nwRow{box-shadow:none;background:none;margin:0;border-radius:0;transform:none}
  .nwGCardBody .nwRow:hover{box-shadow:none;transform:none}
  /* ---- v6 页面级过渡（HyperOS/MIUⅨ 式 push-pop；方向类由 nwViewDir 决定；no-preference 门内播放） ---- */
  .nwView{min-width:0}
  @keyframes nwViewInFwd{from{opacity:0;transform:translateX(26px)}to{opacity:1;transform:none}}
  @keyframes nwViewInBack{from{opacity:0;transform:translateX(-26px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion: no-preference){
    .nwViewFwd{animation:nwViewInFwd .3s var(--nw-ease)}
    .nwViewBack{animation:nwViewInBack .3s var(--nw-ease)}
  }
  /* ---- v6.5.0 自建下拉 SelectMenu（替换原生 select；闭合态沿用 nwSelect 观感） ---- */
  .nwSelWrap{position:relative;display:inline-block;min-width:0;max-width:100%}
  .nwSelTrigger{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;min-width:160px;max-width:100%;box-sizing:border-box;text-align:left;cursor:pointer}
  .nwSelTrigger:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
  .nwSelTrigger:disabled{opacity:.45;cursor:not-allowed}
  .nwSelTriggerOpen{border-color:var(--dsw-alias-state-business-primary)}
  .nwSelEmpty .nwSelTriggerText{color:var(--dsw-alias-label-tertiary)}
  .nwSelTriggerText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .nwSelChevron{flex-shrink:0;display:inline-flex;width:14px;height:14px;font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary);transition:transform .18s var(--nw-ease)}
  .nwSelTriggerOpen .nwSelChevron{transform:rotate(180deg)}
  .nwSelChevron svg{width:14px;height:14px;display:block}
  .nwSelMenu{position:absolute;top:calc(100% + 4px);left:0;z-index:50;min-width:100%;max-width:min(360px,80vw);max-height:260px;overflow-y:auto;box-sizing:border-box;padding:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);outline:none}
  /* v6.4.0：fixed 变体——逃出祖先的 overflow 裁剪（词表卡片圆角需要 overflow:hidden，
     绝对定位的弹层会被截断，实测菜单底部一项被切掉半个字）。
     位置上由内联几何量决定，这里只把绝对定位那套坐标全部复位。 */
  .nwSelMenuFixed{position:fixed;top:auto;left:auto;right:auto;bottom:auto;min-width:0;max-width:min(360px,calc(100vw - 24px))}
  .nwSelOpt{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:30px;padding:0 10px;border-radius:var(--dsw-radius-sm);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer;user-select:none;white-space:nowrap}
  .nwSelOptLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
  .nwSelOptAct{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3))}
  .nwSelOptSel{font-weight:600}
  .nwSelOptCheck{flex-shrink:0;font-size:12px;line-height:20px;color:var(--dsw-alias-state-business-primary)}
  .nwSelTrigger:focus-visible,.nwSelMenu:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
  /* ---- v6.5.0 书库根行（可直接改；输入 + 保存；rootSource=config 时禁用） ---- */
  .nwRootRow{display:flex;flex-direction:column;gap:6px;padding:10px 12px;margin:8px 16px 4px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}
  .nwRootMeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));word-break:break-all}
  .nwRootSrc{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;corner-shape:round;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);border:0.5px solid var(--dsw-alias-border-l2)}
  .nwRootEdit{display:flex;align-items:center;gap:8px}
  .nwRootInput{flex:1;min-width:0;height:30px;padding:0 10px;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-family:inherit}
  .nwRootInput:disabled{opacity:.5;cursor:not-allowed}
  .nwRootNote{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
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

      "panel.title": "写作助手",

      "panel.enabled": "启用写作助手",

      "panel.enabledHint": "关闭后所有分析和自检都不会运行",
      "panel.autoAnalyze": "分析作品时自动使用",

      "panel.autoAnalyzeHint": "AI 分析你的作品时，顺带给出句式分析",

      "panel.spMode": "提示词详细程度",
      "panel.secSwitch": "开关",
      "panel.secPrompt": "提示词",
      "panel.secStatus": "状态",

      "panel.heroDesc": "全部在本机运行，正文不会外传",

      "panel.spModeHint": "告诉 AI 怎么用这个插件：不说 / 一句话 / 完整说明",
      "sp.off": "关闭",
      "sp.brief": "精简",
      "sp.full": "完整",
      "panel.spScene": "提示词场景",

      "panel.spSceneHint": "完整说明按哪种工作来写",
      // v5.1.1：档位非「完整」时，场景按钮此前是 disabled（点不动且无解释）——现在始终可点，改用这行说明"为什么暂时不生效"
      "panel.spSceneInactive": "当前档位不是「完整」，场景已保存但暂不注入——把上面的档位切到「完整」即生效。",
      "sc.general": "通用",
      "sc.writing": "写新章",
      "sc.revising": "改稿",
      "sc.auditing": "审计",
      "sc.setup": "建资料",
      "panel.leanWorkflow": "精简工作流",

      "panel.leanWorkflowHint": "AI 只在你要求时才用工具，更省 token，适合长篇",
      "panel.back": "返回",
      "panel.featuresTitle": "功能开关",

      "panel.featuresHint": "情感分析、题材检测、语义增强等分析能力",
      "feature.webnovelVibe": "网文风格识别",
      "feature.webnovelVibe.desc": "识别网文常见套路与题材特色",
      "feature.emotionCaveat": "情感分析预警",
      "feature.emotionCaveat.desc": "遇到可能干扰情感判断的用词时提醒复核",
      "feature.genreTheme": "题材与流派检测",
      "feature.genreTheme.desc": "识别作品的题材、主题与流派",
      "feature.emotionComplexity": "情感变化分析",
      "feature.emotionComplexity.desc": "看清情绪起伏与复杂情感",
      "feature.semanticEmbedding": "语义增强",
      "feature.semanticEmbedding.desc": "用本地模型理解段落含义",
      // v6.2.0：必用词优先（lexiconFirst）
      // v6.4.0 改名：「必用词优先（专有词表）」与工具页的「必用词表」撞脸（工具标签会剥掉尾部 novel_xxx
      // 再显示，于是两个开关看起来像同一个东西）。现在两者各表一事、名字不再重叠、描述互相指路：
      //   本开关（功能）= **是否**把词表作为硬清单注入开写包；
      //   那个工具（工具开关页）= 词条的**登记/导入/审计**本身。
      "feature.lexiconFirst": "必用词强制注入",
      "feature.lexiconFirst.desc": "要求 AI 使用你指定的词",
      "feature.semanticSearch": "语义检索",
      "feature.semanticSearch.desc": "按意思查找全书相关段落",
      "feature.semanticStyle": "语义风格对比",
      "feature.semanticStyle.desc": "从含义与表达方式对比文风",
      "feature.semanticImplicit": "隐性情感识别",
      "feature.semanticImplicit.desc": "找出没有直说的情绪与情感线索",
      "feature.rawWriting": "非净化模式",
      "feature.rawWriting.desc": "模仿作者文风时还原原文直白程度（血腥/暴力/成人）。这是写作约束而不是模型开关：默认关闭，开启需双重确认；开启后开写包会带直白度目标带、写完可核对，模型自行淡化时自动重试一次。",
      "raw.on": "已开启（仅个人创作）",
      "raw.danger": "危险选项",
      "raw.confirmTitle": "敏感直白模式确认",
      "raw.confirmText": "开启后，AI 在模仿作者文风续写时将还原原文的直白/露骨描写（包括血腥、暴力、成人内容）。\n\n开启后插件会做三件事：① 在系统提示里注入写作约束；② 开写包与建章返回里给出原著直白度基线与目标带；③ 模型若在动笔时自行淡化或跳过场面，丢弃本次输出并重试一次（只一次）。\n\n效果取决于模型本身，插件不保证产出——它提供的是约束与核对，不是开关。\n\n此功能仅用于个人创作与研究。请确认是否开启。",
      "raw.confirmWait": "请确认",
      "raw.confirmOk": "确认开启",
      "raw.cancel": "取消",
      "raw.promiseTitle": "承诺输入",
      "raw.promiseText": "请输入以下承诺以开启（必须包含「绝不传播」）：\n\n我承诺开启此功能仅用于个人创作与研究，绝不传播。",
      "raw.promisePlaceholder": "我承诺开启此功能仅用于个人创作与研究，绝不传播",
      "raw.promiseOk": "确认",

      // v6.8.0：按书删除 + 回收站（issue #2）
      "del.entry": "删除整本书…",
      "del.title": "删除整本书",
      "del.navHint": "删掉一本书的正文与全部关联资料；删前先看清单，可恢复",
      "del.pickHint": "先选一本书，看清会清掉什么，确认后才动手。",
      "del.pickBack": "返回书目",
      "del.sectionPick": "选择要删除的书",
      "del.sectionPreview": "确认清理范围",
      "del.noBooks": "书库里还没有可删除的书。",
      "del.loading": "正在清点这本书的资料…",
      "del.loadFail": "清点失败：{err}",
      "del.none": "没有找到这本书的任何内容（正文、创作资料与关联资料都不存在）。",
      "del.total": "将清理 {files} 个文件 / {size}",
      "del.li": "{label} · {files} 个文件 / {size}",
      "del.selectAll": "全选",
      "del.selectNone": "全不选",
      "del.selCount": "已选 {n} 处 / 共 {m} 处",
      "del.notTouched": "不会动：{list}",
      "del.hint": "内容先移入数据目录下的回收站，之后可在本页下方「回收站」里恢复或彻底删除。",
      "del.ack": "我确认清理《{book}》选中的 {n} 处",
      "del.confirm": "移入回收站",
      "del.busy": "正在删除…",
      "del.done": "已移入回收站：{moved} 项",
      "del.failed": "{n} 项没搬动（多半是被占用或没有权限）",
      "del.remaining": "仍有 {n} 个文件残留",
      "del.cancel": "取消",
      "del.close": "关闭",
      "trash.entry": "回收站",
      "trash.loading": "正在读取回收站…",
      "trash.loadFail": "读取回收站失败：{err}",
      "trash.empty": "回收站是空的。",
      "trash.line": "{files} 个文件 / {size}",
      "trash.restore": "恢复",
      "trash.purge": "彻底删除",
      "trash.purgeAsk": "彻底删除回收站条目「{id}」？此操作无法撤销。",
      "trash.restored": "已恢复 {n} 项",
      "trash.conflict": "原位置已有同名内容，跳过 {n} 项（不覆盖）",
      "trash.purged": "已彻底删除",
      "trash.noManifest": "无清单，不能一键恢复",

      "model.title": "语义模型",
      "model.manage": "模型设置 ›",
      "model.localHint": "用于按意思找相似段落，全部在本机运行",
      "model.subfeatures": "分析能力",
      "tool.all": "全部",
      "tool.storagePlots": "伏笔存储",
      "tool.novel_diagnose": "诊断报告",
      "tool.novel_diagnose.desc": "生成可安全分享的插件诊断报告",
      "tool.novel_delete_book": "按书删除",
      "tool.novel_delete_book.desc": "删掉一本书的正文与全部关联资料（先移入回收站，可恢复）",
      "model.hint": "关闭「语义增强」后，以下功能不生效",
      "dir.data": "数据目录",
      "root.label": "书库根",
      "root.src.config": "登记配置（固定）",
      "root.src.lastRoot": "上次记录",
      "root.src.stale-lastRoot": "记录已失效",
      "root.src.cwd": "当前目录",
      // v6.4.0：最终兜底改为**插件自己的目录**（此前是 process.cwd()，工作区与书库没有必然关系）
      "root.src.internal": "插件内部目录",
      "root.placeholder": "输入书库根的绝对路径",
      "root.save": "保存",
      "root.pinned": "由插件配置固定，界面改动不生效",
      "root.emptyErr": "书库根路径不能为空",
      "root.saved": "书库根已保存",
      "root.saveErr": "保存书库根失败",
      "dir.stateFile": "开关状态文件（state.json）",
      "dir.settings": "设定表存储",
      "dir.summaries": "章节摘要存储",
      "dir.audits": "审计报告存储",
      "dir.analysis": "分析缓存存储",
      "dir.embedding": "语义索引存储",
      "plot.copyFail": "复制失败（浏览器限制），请手动复制：",
      "panel.toolsTitle": "工具开关",
      "toolGroup.analyze": "分析作品",
      "toolGroup.analyze.desc": "了解内容、文风与情节连贯性",
      "toolGroup.settings": "整理资料",
      "toolGroup.settings.desc": "维护设定、伏笔与章节摘要",
      "toolGroup.create": "开始创作",
      "toolGroup.create.desc": "准备材料、统一用词、开始写作",
      "group.allOn": "全部开启",
      "group.allOff": "全部关闭",
      "group.onCount": "{n} 开",
      "group.offCount": "全关",
      "group.partial": "部分开启（点一下全部开启）",

      "panel.toolsHint": "控制 AI 能调用哪些工具",
      "panel.loading": "正在读取开关状态…",
      "panel.localOnly": "宿主端不可达，开关仅保存在本浏览器（重启后可能恢复默认）。",
      "panel.saveFailed": "保存到宿主端失败，已降级保存在本浏览器。",
      "panel.close": "关闭",
      "banner.on": "写作助手功能已启用",
      "banner.off": "写作助手功能已关闭",
      "badge.on": "已开启",
      "badge.off": "已关闭",
      "tool.novel_books": "作品列表",
      "tool.novel_outline": "创作资料",
      "tool.novel_outline.desc": "维护大纲、角色与创作进度",
      "tool.novel_chapters": "章节清单",
      "tool.novel_read": "阅读章节",
      "tool.novel_keywords": "关键词分析",
      "tool.novel_new_chapter": "新建章节",
      // v5.0.0：写作能力层两个新工具
      "tool.novel_chapter_brief": "开写包",
      // v6.2.0：必用词表
      "tool.novel_lexicon": "词表管理",
      "tool.novel_lexicon.desc": "维护必用词，检查成稿用词",
      "tool.novel_import": "稿件导入",
      "tool.novel_sentence_analysis": "句式分析",
      "tool.novel_style_check": "风格自检",
      "tool.novel_fix_plan": "改稿建议",
      "tool.novel_style_report": "风格画像",
      "tool.novel_plot": "伏笔登记",
      "tool.novel_books.desc": "查看书库作品、章数与字数",
      "tool.novel_chapters.desc": "查看每章标题与字数",
      "tool.novel_read.desc": "读取章节正文",
      "tool.novel_keywords.desc": "找出高频词、人名与常见意象",
      "tool.novel_new_chapter.desc": "自动编号并创建下一章",
      "tool.novel_chapter_brief.desc": "写作前备齐上下文与创作要求",
      "tool.novel_import.desc": "把已有稿件分类导入书库",
      "tool.novel_sentence_analysis.desc": "分析句子节奏与情绪变化",
      "tool.novel_style_check.desc": "检查本章文风是否与全书一致",
      "tool.novel_fix_plan.desc": "把文风问题整理成改稿清单",
      "tool.novel_style_report.desc": "汇总作品的文风与表达特色",
      "tool.novel_plot.desc": "记录伏笔并跟踪回收进度",
      "tool.novel_settings": "设定管理",
      "tool.novel_summary": "章节摘要",
      "tool.novel_continuity_check": "连贯性检查",
      "tool.novel_semantic_search": "语义检索",
      "tool.novel_settings.desc": "维护人物、地点与世界观设定",
      "tool.novel_summary.desc": "保存与读取章节梗概",
      "tool.novel_continuity_check.desc": "检查人物与情节是否前后矛盾",
      "tool.novel_semantic_search.desc": "按意思查找相关段落",
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
      "model.engine": "模型状态",
      "model.engineReady": "可用 · 模型已加载",
      "model.engineIdle": "可用 · 首次使用时加载",
      "model.engineMissing": "模型文件缺失，语义功能不可用",
      "model.engineError": "加载失败：{err}",
      "model.engineUnknown": "状态未知",
      "update.title": "发现新版本",

      "update.go": "查看 ›",
      "update.failed": "更新检查失败",

      "update.failedLast": "更新检查失败 · 上次成功 {time}",
      "panel.baselineTitle": "风格基线",

      "panel.baselineHint": "设定新章节文风允许偏离原作多少",
      "base.toleranceTitle": "文风六项指标",
      "base.toleranceHint": "句长、修饰、抽象、动作、语气和留白；留空用推荐值。",
      "base.storage": "基线数据所在目录",
      "reports.storage": "报告所在数据目录",
      "reports.unassigned": "未关联书籍",
      "reports.name.baseline": "全书基线",
      "reports.name.chapters": "逐章指标",
      "reports.name.full": "全书分析",
      "reports.name.keywords": "关键词",
      "reports.name.segment": "单段分析",
      "base.metric.complexity": "句长与结构",
      "base.metric.modifierDensity": "修饰用词",
      "base.metric.abstractDensity": "抽象表达",
      "base.metric.actionDensity": "动作描写",
      "base.metric.hedgeDensity": "不确定语气",
      "base.metric.gapIndex": "叙述留白",
      "base.help.complexity": "句子有多长，结构有多复杂。",
      "base.help.modifierDensity": "形容词、副词等修饰有多密集。",
      "base.help.abstractDensity": "概念和想法相对具体事物的多少。",
      "base.help.actionDensity": "动作描写在文字中占多少。",
      "base.help.hedgeDensity": "「也许」「似乎」等语气有多少。",
      "base.help.gapIndex": "有多少内容留给读者自行体会。",
      "baseline.desc": "设定新章节文风允许偏离原作多少。",
      "baseline.save": "保存容差",
      "baseline.reset": "恢复推荐容差",
      "baseline.saved": "容差已保存",
      "baseline.low": "低于",
      "baseline.high": "高于",
      "base.rangeTitle": "基线范围",
      "base.rangeHint": "选哪些章节当风格基线。按全书 = 除本章外的所有章；按部分 = 只用勾选的章节（不自动补齐）。",
      "base.modeLabel": "范围",
      "base.modeHint": "选择哪些章节作为参照，修改后保存。",
      "base.mode.all": "全书",
      "base.mode.custom": "按部分",
      "base.modeAllSummary": "除本章外的全部章节",
      "base.modeCustomSummary": "只用手工勾选的章节",
      "base.bookLabel": "当前书",
      "base.noBook": "选择一本书",
      "base.needBook": "先选择一本书",
      "base.pickTitle": "挑选章节",
      "base.pickHint": "只用勾选的章节作为参照。",
      "base.selectAll": "全选",
      "base.clearSel": "清空",
      "base.invertSel": "反选",
      "base.selected": "已选",
      "base.selectedUnit": " 章",
      "base.chapterPrefix": "第 {n} 章 ",
      "base.allChapters": "本书共 {n} 章",
      "base.showRest": "展开其余 {n} 章",
      "base.truncTip": "章节较多，先显示前 {n} 章。",
      "base.smallSample": "少于 {n} 章时容差将放宽到 ±{p}%",
      "base.smallSampleNow": "已选 {n} 章；不足 {min} 章时放宽至 ±{p}%。",
      "base.missing": "{n} 章已改名或删除，保存时会移除。",
      "base.save": "保存范围",
      "base.saved": "范围已保存",
      "base.saveFail": "基线范围保存失败",
      "base.loadFail": "基线范围读取失败",
      "base.loadFailHint": "检查书库根后，换一本书再切回来重试。",
      "base.busy": "处理中…",
      "base.emptyTitle": "本书还没有章节",
      "base.emptyHint": "添加章节后，重新打开本页。",
      "base.updatedAt": "上次保存",
      "base.needCustom": "至少选一章，或切到「全书」。",
      "base.clearSaved": "清空已保存的选择",
      "base.clearSavedHint": "清空后不再保留选择，改用全书。",
      "base.confirmClear": "清空基线选择？清空后基线按全书计算，已保存的与本页尚未保存的勾选都会清掉。",
      "base.cleared": "基线选择已清空（按全书）",
      "base.clearFail": "清空基线选择失败",
      "base.storedCount": "已保存 {n} 章作为参照",
      "base.storedIdle": "已保留 {n} 章选择；全书模式下暂不使用。",
      "base.dirWarn": "章节目录读取异常",

      "panel.creationTitle": "原创设定",

      "panel.creationHint": "每本书的世界观、角色和禁忌，写作时自动参考",
      "creation.worldview": "世界观",
      "creation.characters": "角色设定",
      "creation.forbidden": "不允许的事件",
      "creation.mainConflict": "主线目的",
      "creation.genre": "题材偏好",
      "creation.extra": "额外要求",
      "creation.listTitle": "设定库",
      "creation.desc2": "每本书一份设定，AI 写作时自动参考",
      "creation.new": "新建设定",
      "creation.newPlaceholder": "输入新书书名…",
      "creation.default": "默认设定",
      "creation.defaultHint": "新书没单独设定时用它",
      "creation.items": "项已填",
      "creation.none": "未填写，全部交给 AI 决定",
      "creation.edit": "编辑",
      "creation.delete": "删除",
      "creation.deleted": "已删除该书设定",
      "creation.newed": "已创建设定，开始填写",
      "creation.needName": "请先输入新书书名",
      "creation.badName": "换个书名试试，避免特殊符号和末尾空格",
      "reports.loading": "读取中…",

      "stats.pending": "书库概况暂不可用，刷新后重试",
      "tol.recommend": "推荐",
      "tol.halfFilled": "维度",
      "tol.halfFilledTail": "」只填了低/高一边——容差需成对填写（或都留空用推荐）",
      "state.unreachable": "宿主端不可达",
      // v6.2.0：必用词表面板（lex.*，zh）
      "lex.title": "必用词表",

      "lex.navHint": "专有名词和惯用说法，让 AI 不乱换词",
      "lex.hint": "专有名词和惯用说法，让 AI 不乱换词",
      "lex.scope.all": "合并查看",
      "lex.scope.book": "本书",
      "lex.scope.global": "全局",
      "lex.scopeHint": "本书单独使用，全局所有书共用",
      "lex.scopeLabel": "作用层",
      "lex.scope": "保存到",
      "lex.noBook": "选择一本书",
      "lex.bookLabel": "当前书",
      "lex.search": "搜索词条 / 场景 / 备注 / 勿用词",
      "lex.searchLabel": "搜索",
      "lex.emptyTitle": "还没有词条",
      "lex.empty": "点击「新增词条」，告诉 AI 哪些词不能换",
      "lex.listTitle": "词条",
      "lex.addTitle": "词条详情",
      "lex.term": "词条（必填）",
      "lex.kind": "类型",
      "lex.kindHint": "选一个类型，也可以自己填写",
      "lex.scene": "适用场景",
      "lex.sceneHint": "大纲提到这个场景时，AI 优先参考这条",
      "lex.avoid": "避免使用的词",
      "lex.avoidShort": "勿用",
      "lex.note": "备注 / 用法",
      "lex.add": "新增",
      "lex.saveEdit": "保存修改",
      "lex.edit": "编辑",
      "lex.delete": "删除",
      "lex.cancelEdit": "取消",
      "lex.importTitle": "批量导入",
      "lex.importOpen": "展开批量导入",
      "lex.importClose": "收起批量导入",
      "lex.importHint": "每行一条：词，或 词|类型|场景|替身1,替身2|备注（# 开头为注释行）",
      "lex.importMerge": "合并追加",
      "lex.importReplace": "替换本层词条",
      "lex.importPlaceholder": "星轨|专名|战斗|轨道,轨迹|跃迁场面用\n青铜灯|专名\n潮汐税",
      "lex.layerLabel": "本层生效",
      "lex.layerHint": "关闭后，这层词条不参与写作和用词检查",
      "lex.countsBook": "本书",
      "lex.countsGlobal": "全局",
      "lex.countsUnit": " 条",
      "lex.busy": "处理中…",
      "lex.loadFail": "词表读取失败",
      "lex.loadFailHint": "在底部「高级」检查书库位置后，切换作用层重试",
      "lex.corruptTitle": "部分词条暂时读不出来",
      "lex.corruptHint": "词表文件已损坏，重新保存前会请你确认",
      "lex.corruptConfirm": "该层词表文件已损坏，继续写入会丢弃它原有的内容并按当前列表重建。确定继续？",
      "lex.saveFail": "词表保存失败",
      "lex.saved": "已保存",
      "lex.confirmDelete": "删除词条「{term}」？",
      "lex.confirmReplace": "整层覆盖会清掉该层现有词条，确定继续？",
      "lex.needTerm": "请先填写词条",
      "lex.avoidHint": "多个词用逗号分开，检查时会提示替换",
      "lex.auditTip": "写完后让 AI 检查一遍用词，就能看到哪里用了替代词",
      "lex.pathLabel": "词表文件",
      "creation.filled": "已填 {n}/6 项",
      "creation.confirmClear": "清空这份设定？清空后由 AI 决定。",
      "creation.confirmDelete": "删除这本书的设定？此操作无法撤销。",
      "creation.pathLabel": "设定保存位置",
      "creation.bookHint": "切换后可编辑另一本书的设定",
      "creation.help.worldview": "告诉 AI 故事发生在哪里，有哪些规则",
      "creation.help.characters": "写下主要角色的身份、关系和性格",
      "creation.help.forbidden": "列出不希望故事发生的情节",
      "creation.help.mainConflict": "告诉 AI 主角要完成什么、会遇到什么阻碍",
      "creation.help.genre": "指定你想要的类型和整体氛围",
      "creation.help.extra": "补充节奏、篇幅或其他写作要求",
      "lex.newEntry": "新增词条",
      "lex.forceLabel": "强制使用词表",
      "lex.forceHint": "AI 开始写作时，提醒它优先使用这些词",
      "lex.bookHint": "选择要查看和维护词条的书",
      "lex.bookGlobalHint": "全局词条供所有书使用，无需选书",
      "lex.noMatch": "没有找到匹配的词条",
      "lex.noMatchHint": "换个关键词，或点击「新增词条」补充",
      "lex.advanced": "高级",
      // v6.6.0：诊断面板（diag.*，zh）——报告来自宿主「分享层」，自由文本已整体剔除
      "diag.title": "诊断报告",

      "diag.navHint": "出问题时生成一份可安全分享的报告",
      "diag.desc": "汇总运行情况，不包含正文和提示词。",
      "diag.windowLabel": "统计窗口",
      "diag.windowHint": "查看最近这段时间的使用情况",
      "diag.daysUnit": "天",
      "diag.run": "生成诊断报告",
      "diag.refresh": "重新生成",
      "diag.busy": "诊断中…",
      "diag.empty": "还没有诊断报告",
      "diag.emptyHint": "生成一份最近 {n} 天的运行报告。",
      "diag.loadFail": "诊断失败",
      "diag.loadFailHint": "暂时无法生成，请稍后重试。",
      "diag.copy": "复制诊断包",
      "diag.copied": "诊断包已复制（报告 + 环境信息）",
      "diag.copyFail": "剪贴板不可用或被拒绝，请在报告块内手动全选复制",
      "diag.manual": "报告全文就在本页：选中整段手动复制（Ctrl/Cmd+C）即可。",
      "diag.packTitle": "环境信息（不含正文）",
      "diag.envRoot": "书库根",
      "diag.envWindow": "窗口",
      "diag.envData": "数据目录",
      "diag.envLog": "日志目录",
      "diag.callsTotal": "使用次数",
      "diag.callsDegraded": "简化处理",
      "diag.callsFailed": "未成功",
      "diag.issues": "值得注意",
      "diag.level.error": "错误",
      "diag.level.warn": "警告",
      "diag.level.info": "提示",
      "diag.suggestion": "建议",
      "diag.privacy": "本报告只含元数据（工具名 / 耗时 / 错误码 / 章节名），不含正文与原始错误文本。",
      "reports.readFail": "读取失败",
      "reports.loading2": "加载中…",
      "demo.fail": "演示失败",
      "ph.e末": "例如：末日后异能世界…",
      "ph.e主": "例如：寻找失踪的同伴，解开身世之谜…",
      "ph.e女": "例如：女主冷静克制，有秘密…",
      "ph.e不": "例如：不能有重生/系统/金手指…",
      "ph.e悬": "例如：悬疑+救赎，都市背景…",
      "ph.e每": "例如：每章结尾留钩子，多对话…",

      "stats.empty": "书库还没有作品，可让 AI 新建一本",
      "stats.title": "书库统计",
      "stats.week": "7天",
      "stats.idle": "7天未动",
      "stats.chapters": "章",
      "stats.chars": "字",

      "demo.run": "体验演示",

      "demo.hint": "用示例看文风六项指标，不保存任何内容",
      "demo.loading": "演示中…",
      "reports.title": "报告历史",

      "reports.hint": "已保存的句式分析和风格报告",
      "reports.delete": "删除",
      "reports.deleteAsk": "把报告「{file}」移入回收站？\n\n它不会被直接删掉——可以在「删除整本书」页下方的回收站里恢复。",
      "reports.deleted": "已移入回收站：{file}",
      "reports.deleteFail": "删除报告失败",
      "reports.empty": "还没有报告，完成一次分析后再来看看。",
      "reports.back": "返回报告列表",
      "creation.dirtyWarn": "有未保存的修改，切换将丢弃。继续？",
      "creation.formTitle": "编辑设定",
      "creation.bookFor": "设定应用书",
      "creation.save": "保存",
      "creation.clear": "清空",
      "creation.saved": "原创设定已保存",
      "creation.cleared": "已清空，全部交给 AI 决定",
      "storage.title": "存储位置",
      "storage.open": "打开",
      "storage.copy": "复制",
      "status.enabled": "已启用",
      "status.disabled": "已停用",
      "note.selectBook": "先在上面选择一本书",
      "note.actionFailed": "操作未完成，请重试或查看详情",
      "note.details": "查看详情",
      "home.writing": "写作资料",
      "home.ai": "AI 行为",
      "home.features": "功能与工具",
      "home.maintenance": "记录与维护",
      "home.advanced": "高级",
      "home.modelHint": "本地语义检索模型：{status}",
      "home.modelError": "模型加载失败，请到模型页检查",
      "home.rawHint": "模仿原作直白程度，可能包含成人、血腥或暴力描写",
      "home.rawWarning": "仅用于个人创作与研究，请勿传播敏感内容",
      "home.rootWarning": "书库位置可能有误，部分作品可能无法显示",
      "home.updateChecked": "已检查更新",
      "home.librarySummary": "书库 {books} 部 · {chapters} 章 · {chars}字",
    };
    var en = {
      "entry.label": "Writing Assistant",
      "entry.tooltip": "Writing assistant switches (dsh-novel-writer): analysis / style check / plot tracking etc.",
      "panel.back": "Back",

      "panel.title": "Writing Assistant",

      "panel.enabled": "Enable writing assistant",

      "panel.enabledHint": "Turn off to pause all analysis and self-checks",
      "panel.autoAnalyze": "Analyze sentences automatically",

      "panel.autoAnalyzeHint": "Include sentence analysis when AI reviews your writing",

      "panel.spMode": "Prompt detail",
      "panel.secSwitch": "Switch",
      "panel.secPrompt": "Prompts",
      "panel.secStatus": "Status",

      "panel.heroDesc": "Runs entirely on this device. Your writing never leaves it.",

      "panel.spModeHint": "Explain this plugin to AI: nothing, one line, or full guidance",
      "sp.off": "Off",
      "sp.brief": "Brief",
      "sp.full": "Full",
      "panel.spScene": "Prompt scene",

      "panel.spSceneHint": "Choose the workflow for full guidance",
      // v5.1.1: the scene buttons used to be disabled when the mode wasn't Full (no explanation) — now always clickable, with this note
      "panel.spSceneInactive": "The mode above isn't Full, so the scene is saved but not injected yet — switch the mode to Full to activate it.",
      "sc.general": "General",
      "sc.writing": "Drafting",
      "sc.revising": "Revising",
      "sc.auditing": "Auditing",
      "sc.setup": "Setup",
      "panel.leanWorkflow": "Lean workflow",

      "panel.leanWorkflowHint": "Use tools only when asked; save tokens on longer books",
      "panel.featuresTitle": "Feature switches",

      "panel.featuresHint": "Emotion, genre and semantic analysis",
      "feature.webnovelVibe": "Webnovel signals",
      "feature.webnovelVibe.desc": "Recognize common webnovel tropes and themes",
      "feature.emotionCaveat": "Emotion analysis warnings",
      "feature.emotionCaveat.desc": "Flag wording that may distort emotion analysis",
      "feature.genreTheme": "Genre & theme",
      "feature.genreTheme.desc": "Identify the book’s themes and genre",
      "feature.emotionComplexity": "Emotion changes",
      "feature.emotionComplexity.desc": "Reveal emotional shifts and mixed feelings",
      "feature.semanticEmbedding": "Semantic enhancement",
      "feature.semanticEmbedding.desc": "Understand passages with a local model",
      // v6.2.0：lexiconFirst
      "feature.lexiconFirst": "Force lexicon in brief",
      "feature.lexiconFirst.desc": "Require your chosen wording in the chapter brief",
      "feature.semanticSearch": "Semantic search",
      "feature.semanticSearch.desc": "Find related passages by meaning",
      "feature.semanticStyle": "Semantic style compare",
      "feature.semanticStyle.desc": "Compare style through meaning and expression",
      "feature.semanticImplicit": "Implicit emotions",
      "feature.rawWriting": "Uncensored Mode",
      "feature.rawWriting.desc": "Restore the original explicitness when mimicking author style (gore/violence/adult). This is a writing constraint, not a model switch: off by default, double confirmation required; once on, the chapter brief carries an explicitness target and style check reports it, and the plugin retries once if the model softens the scene by itself.",
      "raw.on": "ON (personal creation only)",
      "raw.danger": "Dangerous option",
      "raw.confirmTitle": "Sensitive explicit mode confirmation",
      "raw.confirmText": "When enabled, the AI will restore the original explicitness (gore, violence, adult content) when continuing in the author's style.\n\nThree things happen: ① a writing constraint is injected into the system prompt; ② the chapter brief and chapter creation return the source's explicitness baseline and a target band; ③ if the model softens or skips the scene on its own, that output is discarded and retried once.\n\nEffectiveness depends on the model itself — this is a constraint plus a check, not a switch.\n\nFor personal creation and research only.",
      "raw.confirmWait": "Confirm",
      "raw.confirmOk": "Enable",
      "raw.cancel": "Cancel",
      "raw.promiseTitle": "Promise input",
      "raw.promiseText": "Type the following promise to enable (must contain \"never distribute\"):\n\nI promise to use this feature for personal creation and research only, and never distribute it.",
      "raw.promisePlaceholder": "I promise to use this only for personal creation and research, never distribute",
      "raw.promiseOk": "Confirm",

      // v6.8.0：按书删除 + 回收站（issue #2）
      "del.entry": "Delete book…",
      "del.title": "Delete book",
      "del.navHint": "Remove one book's chapters and related data; preview first, restorable",
      "del.pickHint": "Pick a book, see exactly what will be cleaned, then confirm.",
      "del.pickBack": "Back to books",
      "del.sectionPick": "Choose a book to delete",
      "del.sectionPreview": "Confirm what will be cleaned",
      "del.noBooks": "No books in the library yet.",
      "del.loading": "Checking what this book has…",
      "del.loadFail": "Could not check: {err}",
      "del.none": "Nothing found for this book (no chapters, notes, or related data).",
      "del.total": "Will clean {files} files / {size}",
      "del.li": "{label} · {files} files / {size}",
      "del.selectAll": "Select all",
      "del.selectNone": "Select none",
      "del.selCount": "{n} of {m} locations selected",
      "del.notTouched": "Untouched: {list}",
      "del.hint": "Content is moved to the recycle bin in the data folder first; restore or permanently delete it in the recycle bin below.",
      "del.ack": "I confirm cleaning the {n} selected locations in \"{book}\"",
      "del.confirm": "Move to recycle bin",
      "del.busy": "Deleting…",
      "del.done": "Moved to recycle bin: {moved} items",
      "del.failed": "{n} items could not be moved (in use or no permission)",
      "del.remaining": "{n} files still remain",
      "del.cancel": "Cancel",
      "del.close": "Close",
      "trash.entry": "Recycle bin",
      "trash.loading": "Reading the recycle bin…",
      "trash.loadFail": "Could not read the recycle bin: {err}",
      "trash.empty": "The recycle bin is empty.",
      "trash.line": "{files} files / {size}",
      "trash.restore": "Restore",
      "trash.purge": "Delete permanently",
      "trash.purgeAsk": "Permanently delete recycle bin entry \"{id}\"? This cannot be undone.",
      "trash.restored": "Restored {n} items",
      "trash.conflict": "Skipped {n} items that already exist (not overwritten)",
      "trash.purged": "Permanently deleted",
      "trash.noManifest": "No manifest; restore it manually",
      "feature.semanticImplicit.desc": "Find emotions suggested rather than stated",

      "model.title": "Semantic model",
      "model.manage": "Model settings ›",
      "model.localHint": "Find similar passages by meaning, entirely on your device",
      "model.subfeatures": "Analysis features",
      "tool.all": "All",
      "tool.storagePlots": "Plot hook storage",
      "tool.novel_diagnose": "Diagnostics",
      "tool.novel_diagnose.desc": "Generate a safe-to-share plugin diagnostic report",
      "tool.novel_delete_book": "Delete a book",
      "tool.novel_delete_book.desc": "Remove one book's chapters and all related data (moved to the recycle bin first, restorable)",
      "model.hint": "These features require Semantic enhancement to be on",
      "dir.data": "Data dir",
      "root.label": "Library root",
      "root.src.config": "Pinned by plugin config",
      "root.src.lastRoot": "Last saved",
      "root.src.stale-lastRoot": "Saved path is stale",
      "root.src.cwd": "Current directory",
      "root.src.internal": "Plugin's own folder",
      "root.placeholder": "Absolute path of the library root",
      "root.save": "Save",
      "root.pinned": "Pinned by plugin config; changes here have no effect",
      "root.emptyErr": "Library root cannot be empty",
      "root.saved": "Library root saved",
      "root.saveErr": "Failed to save library root",
      "dir.stateFile": "Switch state file (state.json)",
      "dir.settings": "Settings storage",
      "dir.summaries": "Summaries storage",
      "dir.audits": "Audit reports storage",
      "dir.analysis": "Analysis cache storage",
      "dir.embedding": "Semantic index storage",
      "plot.copyFail": "Copy failed (browser restriction), copy manually: ",
      "panel.toolsTitle": "Tool switches",
      "toolGroup.analyze": "Analysis",
      "toolGroup.settings": "Reference",
      "toolGroup.create": "Writing",
      "toolGroup.analyze.desc": "Explore content, style and continuity",
      "toolGroup.settings.desc": "Organize settings, plot hooks and summaries",
      "toolGroup.create.desc": "Prepare context, keep wording consistent and write",
      "tool.novel_semantic_search.desc": "Find related passages by meaning",
"group.allOn": "All on",
      "group.allOff": "All off",
      "group.onCount": "{n} on",
      "group.offCount": "all off",
      "group.partial": "Partially on (click to toggle all)",

      "panel.toolsHint": "Choose which tools AI can use",
      "panel.loading": "Loading switch state…",
      "panel.localOnly": "Host unreachable; kept in this browser only (defaults may return after restart).",
      "panel.saveFailed": "Host save failed; fell back to this browser.",
      "panel.close": "Close",
      "banner.on": "Writing assistant is ON",
      "banner.off": "Writing assistant is OFF",
      "badge.on": "ON",
      "badge.off": "OFF",
      "tool.novel_books": "Books",
      "tool.novel_outline": "Creation profile",
      "tool.novel_outline.desc": "Maintain outlines, characters and writing progress",
      "tool.novel_chapters": "Chapters",
      "tool.novel_read": "Read chapters",
      "tool.novel_keywords": "Keywords",
      "tool.novel_new_chapter": "New chapter",
      "tool.novel_chapter_brief": "Chapter brief",
      "tool.novel_lexicon": "Lexicon",
      "tool.novel_lexicon.desc": "Maintain required wording and check drafts",
      "tool.novel_import": "Import drafts",
      "tool.novel_sentence_analysis": "Sentence analysis",
      "tool.novel_style_check": "Style check",
      "tool.novel_fix_plan": "Revision plan",
      "tool.novel_style_report": "Style profile",
      "tool.novel_style_report.desc": "Summarize the book’s style and expression",
      "tool.novel_plot": "Plot hooks",
      "tool.novel_books.desc": "Browse books with chapter and word counts",
      "tool.novel_chapters.desc": "Browse chapter titles and word counts",
      "tool.novel_read.desc": "Read chapter text",
      "tool.novel_keywords.desc": "Find recurring words, names and imagery",
      "tool.novel_new_chapter.desc": "Create the next chapter with automatic numbering",
      "tool.novel_chapter_brief.desc": "Gather context and requirements before writing",
      "tool.novel_import.desc": "Import and organize existing drafts",
      "tool.novel_sentence_analysis.desc": "Analyze sentence rhythm and emotional shifts",
      "tool.novel_style_check.desc": "Check this chapter against the book’s style",
      "tool.novel_fix_plan.desc": "Turn style issues into a revision checklist",
      "tool.novel_plot.desc": "Track plot hooks and their resolution",
      "tool.novel_settings": "Story settings",
      "tool.novel_summary": "Chapter summaries",
      "tool.novel_continuity_check": "Continuity check",
      "tool.novel_semantic_search": "Semantic search",
      "tool.novel_settings.desc": "Maintain characters, locations and world details",
      "tool.novel_summary.desc": "Save and read chapter summaries",
      "tool.novel_continuity_check.desc": "Find inconsistencies in characters and plot",
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
      "model.engine": "Model status",
      "model.engineReady": "Ready · model loaded",
      "model.engineIdle": "Ready · loads on first use",
      "model.engineMissing": "Model files missing, semantic features unavailable",
      "model.engineError": "Load failed: {err}",
      "model.engineUnknown": "Unknown",
      "update.title": "New version available",

      "update.go": "View ›",
      "update.failed": "Update check failed",

      "update.failedLast": "Update check failed · last success {time}",
      "panel.baselineTitle": "Style baseline",

      "panel.baselineHint": "Limit style changes in new chapters",
      "base.toleranceTitle": "Six style measures",
      "base.toleranceHint": "Sentence structure, modifiers, abstraction, action, uncertainty and implication. Leave blank for defaults.",
      "base.storage": "Baseline data folder",
      "reports.storage": "Report data folder",
      "reports.unassigned": "Unassigned reports",
      "reports.name.baseline": "Whole-book baseline",
      "reports.name.chapters": "Chapter metrics",
      "reports.name.full": "Whole-book analysis",
      "reports.name.keywords": "Keywords",
      "reports.name.segment": "Passage analysis",
      "base.metric.complexity": "Sentence structure",
      "base.metric.modifierDensity": "Modifiers",
      "base.metric.abstractDensity": "Abstraction",
      "base.metric.actionDensity": "Action",
      "base.metric.hedgeDensity": "Uncertainty",
      "base.metric.gapIndex": "Implication",
      "base.help.complexity": "How long and structurally complex sentences are.",
      "base.help.modifierDensity": "How often descriptive modifiers appear.",
      "base.help.abstractDensity": "Concepts and ideas compared with concrete details.",
      "base.help.actionDensity": "How much of the text describes actions.",
      "base.help.hedgeDensity": "How often words like “perhaps” or “seems” appear.",
      "base.help.gapIndex": "How much is left for the reader to infer.",
      "baseline.desc": "Keep new chapters close to the original style.",
      "baseline.save": "Save tolerance",
      "baseline.reset": "Use recommended tolerance",
      "baseline.saved": "Tolerance saved",
      "baseline.low": "Below",
      "baseline.high": "Above",
      "base.rangeTitle": "Baseline range",
      "base.rangeHint": "Which chapters form the style baseline. Whole book = every chapter but the current one; Selected = only the chapters you tick (no automatic top-up).",
      "base.modeLabel": "Range",
      "base.modeHint": "Choose reference chapters, then save the range.",
      "base.mode.all": "Whole book",
      "base.mode.custom": "Selected",
      "base.modeAllSummary": "Every chapter except the current one",
      "base.modeCustomSummary": "Only the chapters you tick",
      "base.bookLabel": "Book",
      "base.noBook": "Select a book",
      "base.needBook": "Select a book first",
      "base.pickTitle": "Pick chapters",
      "base.pickHint": "Use only the chapters you select.",
      "base.selectAll": "Select all",
      "base.clearSel": "Clear",
      "base.invertSel": "Invert",
      "base.selected": "Selected",
      "base.selectedUnit": " chapters",
      "base.chapterPrefix": "Ch. {n} ",
      "base.allChapters": "{n} chapters in this book",
      "base.showRest": "Show the remaining {n}",
      "base.truncTip": "Many chapters — showing the first {n} for now.",
      "base.smallSample": "Below {n} chapters the tolerance widens to ±{p}%",
      "base.smallSampleNow": "{n} selected; below {min}, tolerance widens to ±{p}%.",
      "base.missing": "{n} chapters were renamed or deleted; saving removes them.",
      "base.save": "Save range",
      "base.saved": "Range saved",
      "base.saveFail": "Failed to save the baseline range",
      "base.loadFail": "Failed to load the baseline range",
      "base.loadFailHint": "Check the library root, then switch to another book and back to retry.",
      "base.busy": "Working…",
      "base.emptyTitle": "This book has no chapters yet",
      "base.emptyHint": "Add chapters, then reopen this page.",
      "base.updatedAt": "Last saved",
      "base.needCustom": "0 selected: \"Selected\" needs at least one chapter. To drop the saved ones, use \"Clear saved selection\".",
      "base.clearSaved": "Clear saved selection",
      "base.clearSavedHint": "Remove saved selections and use the whole book.",
      "base.confirmClear": "Clear the baseline selection? The baseline then uses the whole book, and both the saved and the unsaved ticks on this page are cleared.",
      "base.cleared": "Baseline selection cleared (whole book)",
      "base.clearFail": "Failed to clear the baseline selection",
      "base.storedCount": "{n} reference chapters saved",
      "base.storedIdle": "{n} selections kept; not used in Whole book mode.",
      "base.dirWarn": "Could not read the chapter directory",

      "panel.creationTitle": "Creation profile",

      "panel.creationHint": "World, cast and boundaries for each book",
      "creation.worldview": "Worldview",
      "creation.characters": "Characters",
      "creation.forbidden": "Forbidden events",
      "creation.mainConflict": "Main conflict",
      "creation.genre": "Genre",
      "creation.extra": "Extra requirements",
      "creation.listTitle": "Settings library",
      "creation.desc2": "One profile per book, referenced automatically while writing.",
      "creation.new": "New profile",
      "creation.newPlaceholder": "Enter new book name…",
      "creation.default": "Default profile",
      "creation.defaultHint": "Used when a new book has no profile of its own.",
      "creation.items": "filled",
      "creation.none": "Not filled; let AI decide everything",
      "creation.edit": "Edit",
      "creation.delete": "Delete",
      "creation.deleted": "Profile deleted",
      "creation.newed": "Profile created, start filling",
      "creation.needName": "Please enter a book name first",
      "creation.badName": "Try another name without special characters or trailing spaces.",
      "reports.loading": "Loading…",

      "stats.pending": "Library overview unavailable; refresh to retry",
      "tol.recommend": "recommended",
      "tol.halfFilled": "Dimension",
      "tol.halfFilledTail": " — fill both low & high (or leave both empty to use recommended)",
      "state.unreachable": "host unreachable",
      // v6.2.0：lexicon panel (lex.*, en)
      "lex.title": "Lexicon",

      "lex.navHint": "Keep names and wording consistent",
      "lex.hint": "Keep names and preferred wording consistent.",
      "lex.scope.all": "Both layers",
      "lex.scope.book": "This book",
      "lex.scope.global": "Global",
      "lex.scopeHint": "Book entries stay with this book; global entries apply to all.",
      "lex.scopeLabel": "Layer",
      "lex.scope": "Save to",
      "lex.noBook": "Choose a book",
      "lex.bookLabel": "Book",
      "lex.search": "Search term / scene / note / avoid",
      "lex.searchLabel": "Search",
      "lex.emptyTitle": "No entries yet",
      "lex.empty": "Choose “New entry” to add words AI should keep.",
      "lex.listTitle": "Entries",
      "lex.addTitle": "Entry details",
      "lex.term": "Term (required)",
      "lex.kind": "Kind",
      "lex.kindHint": "Choose a kind or enter your own.",
      "lex.scene": "Scene",
      "lex.sceneHint": "AI prioritizes this entry when the outline mentions this scene.",
      "lex.avoid": "Words to avoid",
      "lex.avoidShort": "Avoid",
      "lex.note": "Note / usage",
      "lex.add": "Add",
      "lex.saveEdit": "Save edit",
      "lex.edit": "Edit",
      "lex.delete": "Delete",
      "lex.cancelEdit": "Cancel",
      "lex.importTitle": "Bulk import",
      "lex.importOpen": "Show bulk import",
      "lex.importClose": "Hide bulk import",
      "lex.importHint": "One per line: term, or term|kind|scene|avoid1,avoid2|note (lines starting with # are comments)",
      "lex.importMerge": "Merge & append",
      "lex.importReplace": "Replace entries in this layer",
      "lex.importPlaceholder": "Startrail|proper|battle|orbit,track|used for warps\nBronze lamp|proper\nTide tax",
      "lex.layerLabel": "Layer active",
      "lex.layerHint": "Turn off to exclude this layer from writing and wording checks.",
      "lex.countsBook": "Book",
      "lex.countsGlobal": "Global",
      "lex.countsUnit": " entries",
      "lex.busy": "Working…",
      "lex.loadFail": "Failed to load the lexicon",
      "lex.loadFailHint": "Check the library location under Advanced, then switch layers to retry.",
      "lex.corruptTitle": "Some entries could not be read",
      "lex.corruptHint": "A lexicon file is damaged. Rebuilding it will ask for confirmation.",
      "lex.corruptConfirm": "This layer's lexicon file is corrupt. Continuing will discard its current content and rebuild it from the list shown. Continue?",
      "lex.saveFail": "Failed to save the lexicon",
      "lex.saved": "Saved",
      "lex.confirmDelete": "Delete entry \"{term}\"?",
      "lex.confirmReplace": "Replacing the layer drops its existing entries. Continue?",
      "lex.needTerm": "Enter a term first",
      "lex.avoidHint": "Separate words with commas; wording checks will flag them.",
      "lex.auditTip": "After writing, ask AI to check for substituted words.",
      "lex.pathLabel": "Lexicon files",
      "creation.filled": "{n}/6 fields filled",
      "creation.confirmClear": "Clear this profile and let AI decide?",
      "creation.confirmDelete": "Delete this book’s profile? This cannot be undone.",
      "creation.pathLabel": "Creation profiles",
      "creation.bookHint": "Switch books to edit a different profile.",
      "creation.help.worldview": "Describe the setting and the rules of this world.",
      "creation.help.characters": "Describe key characters, relationships, and personalities.",
      "creation.help.forbidden": "List events you do not want in the story.",
      "creation.help.mainConflict": "Define the protagonist’s goal and what stands in the way.",
      "creation.help.genre": "Set the genre and overall mood.",
      "creation.help.extra": "Add pacing, length, or other writing requirements.",
      "lex.newEntry": "New entry",
      "lex.forceLabel": "Always use lexicon",
      "lex.forceHint": "Remind AI to prioritize these words before writing.",
      "lex.bookHint": "Choose the book whose entries you want to manage.",
      "lex.bookGlobalHint": "Global entries apply to every book; no selection needed.",
      "lex.noMatch": "No matching entries",
      "lex.noMatchHint": "Try another search or choose “New entry”.",
      "lex.advanced": "Advanced",

      // v6.6.0: diagnostics panel (diag.*, en) — the report comes from the host's share layer, free text already stripped
      "diag.title": "Diagnostics",

      "diag.navHint": "Create a safe-to-share report when something goes wrong",
      "diag.desc": "Review activity without sharing prose or prompts.",
      "diag.windowLabel": "Window",
      "diag.windowHint": "Review activity over this period",
      "diag.daysUnit": "d",
      "diag.run": "Run diagnosis",
      "diag.refresh": "Refresh",
      "diag.busy": "Diagnosing…",
      "diag.empty": "No diagnosis yet",
      "diag.emptyHint": "Generate a report for the past {n} days.",
      "diag.loadFail": "Diagnosis failed",
      "diag.loadFailHint": "Could not generate a report. Try again shortly.",
      "diag.copy": "Copy diagnostics",
      "diag.copied": "Diagnostics copied (report + environment)",
      "diag.copyFail": "Clipboard unavailable or denied — select the report block and copy it manually",
      "diag.manual": "The full report is on this page: select it and copy manually (Ctrl/Cmd+C).",
      "diag.packTitle": "Environment (no prose)",
      "diag.envRoot": "Library root",
      "diag.envWindow": "Window",
      "diag.envData": "Data dir",
      "diag.envLog": "Log dir",
      "diag.callsTotal": "Total calls",
      "diag.callsDegraded": "Fallbacks",
      "diag.callsFailed": "Failed",
      "diag.issues": "Worth attention",
      "diag.level.error": "Error",
      "diag.level.warn": "Warning",
      "diag.level.info": "Info",
      "diag.suggestion": "Suggestion",
      "diag.privacy": "This report is metadata only (tool / timing / error code / chapter) — no prose and no raw error text.",
      "reports.readFail": "Failed to read",
      "reports.loading2": "Loading…",
      "demo.fail": "Demo failed",
      "ph.e末": "e.g. post-apocalyptic world with abilities…",
      "ph.e主": "e.g. find the missing companion and unravel the mystery of her origins…",
      "ph.e女": "e.g. cool-headed heroine with secrets…",
      "ph.e不": "e.g. no rebirth/system/golden finger…",
      "ph.e悬": "e.g. suspense + redemption, urban setting…",
      "ph.e每": "e.g. cliffhanger endings, dialogue-heavy…",

      "stats.empty": "Your library is empty. Ask AI to create a book.",
      "stats.title": "Library stats",
      "stats.week": "/7d",
      "stats.idle": "idle 7d",
      "stats.chapters": " ch",
      "stats.chars": " chars",

      "demo.run": "Try a demo",

      "demo.hint": "Try six style metrics on a sample; nothing is saved",
      "demo.loading": "Running…",
      "reports.title": "Report history",

      "reports.hint": "Saved sentence analysis and style reports",
      "reports.delete": "Delete",
      "reports.deleteAsk": "Move report \"{file}\" to the recycle bin?\n\nIt is not deleted outright — you can restore it in the recycle bin on the Delete book page.",
      "reports.deleted": "Moved to recycle bin: {file}",
      "reports.deleteFail": "Could not delete the report",
      "reports.empty": "No reports yet. Run an analysis to get started.",
      "reports.back": "Back to reports",
      "creation.dirtyWarn": "Unsaved changes will be lost. Continue?",
      "creation.formTitle": "Edit profile",
      "creation.bookFor": "Applied book",
      "creation.save": "Save",
      "creation.clear": "Clear",
      "creation.saved": "Original settings saved",
      "creation.cleared": "Cleared; AI will decide everything",
      "storage.title": "Storage locations",
      "storage.open": "Open",
      "storage.copy": "Copy",
      "status.enabled": "Enabled",
      "status.disabled": "Disabled",
      "note.selectBook": "Choose a book above first",
      "note.actionFailed": "Could not complete this action. Retry or view details.",
      "note.details": "View details",
      "home.writing": "Writing resources",
      "home.ai": "AI behavior",
      "home.features": "Features & tools",
      "home.maintenance": "History & maintenance",
      "home.advanced": "Advanced",
      "home.modelHint": "Local semantic search model: {status}",
      "home.modelError": "Could not load the model; check model settings",
      "home.rawHint": "Match explicitness, including adult, graphic or violent content",
      "home.rawWarning": "For personal writing and research. Do not distribute sensitive content.",
      "home.rootWarning": "Check the library location; some books may not appear",
      "home.updateChecked": "Update check complete",
      "home.librarySummary": "Library: {books} books · {chapters} chapters · {chars} characters",
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
    // v6.8.0：按书删除 / 回收站（宿主端与 novel_delete_book 同一实现，见 lib/bookdelete.js）
    var DELETE_ROUTE = "/api/dsh-novel-writer/delete-book";
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
    // v6.8.0：删书路由（JSON POST）。破坏性动作一律走 POST——不能落在可以被预取/缓存/重放的 GET 上。
    async function deleteBookRoute(payload) {
      var response = await fetchWithTimeout(DELETE_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload || {})
      });
      if (!response.ok) throw await hostError(response);
      return await response.json();
    }

    // v6.8.0：报告历史的读取与"单份删除"（删除走回收站，可恢复）
    async function fetchReports() {
      var response = await fetchWithTimeout("/api/dsh-novel-writer/reports", { headers: { accept: "application/json" } });
      if (!response.ok) throw await hostError(response);
      return await response.json();
    }
    async function forgetReport(file) {
      var response = await fetchWithTimeout("/api/dsh-novel-writer/reports", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ action: "forget", file: String(file || "") })
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
      // v6.8.0：报告列表加载的陈旧响应序号（模块级闭包变量在每次渲染归零，所以放在控制器作用域）
      let reportsLoadSeq = 0;
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
        // 书库根诊断：root 实际解析路径 / rootSource 来源 / rootWarning 有问题时的中文诊断（正常为 null）
        root: "",
        rootSource: "",
        rootWarning: null,
        // v6.5.0：书库根输入草稿（null=未编辑，显示当前根）与保存中标记
        rootDraft: null,
        rootSaving: false,
        // v6.5.0：SelectMenu 各实例的开合/高亮状态与外部点击监听安装标记
        selectMenus: {},
        selectOutsideBound: false,
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
      reportsError: false,
      creationNameBad: false,
        reportContent: null,
        // v6.8.0：正在删除的那一份报告文件名（删完清空；用于禁用该行按钮）
        reportDeleting: "",
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
        rawPromiseOk: false,
        // v6.8.0：按书删除（预览 → 确认 → 执行）与回收站
        // v6.8.1：删除改由独立页面承载（delBook 非空 = 正在看某本书的预览），弹窗只留给书库行上的快捷入口
        delOpen: false,
        delBook: "",
        delPlan: null,
        delLoading: false,
        delError: "",
        delAck: false,
        delBusy: false,
        delResult: null,
        delReqId: 0,
        // v6.8.0：勾选了哪些位置（key → true）。默认全选＝原来的"删整本书"；
        // 取消勾选就变成"只清这一类"（例如只清报告历史/缓存，正文留着）
        delSel: {},
        trashLoading: false,
        trashList: null,
        trashError: "",
        trashBusyId: "",
        trashNote: "",
        // v6.2.0：必用词表面板状态（词表数据 / 作用层 / 当前书 / 过滤词 / 表单 / 导入区）
        lexicon: null,
        lexiconScope: "all",
        lexiconBook: "",
        lexiconQuery: "",
        lexiconForm: null,
        lexiconFormOpen: false,
        lexiconImportOpen: false,
        lexiconImportText: "",
        lexiconBusy: false,
        lexiconErr: false,
        // 风格基线范围面板状态（数据 / 当前书 / 范围模式 / 待保存选中章 / 失效章 / 列表是否全展开 / 状态位）
        // 数据源 = GET|POST /api/dsh-novel-writer/baseline（与词表同族：reqId 过期丢弃 + busy/err 约定）
        baseline: null,
        baselineBook: "",
        baselineMode: "all",
        baselineSel: [],
        baselineMissing: [],
        baselineShowAll: false,
        baselineBusy: false,
        baselineErr: false,
        // v6.6.0：诊断面板状态。数据源 = GET /api/dsh-novel-writer/diagnose（只读，不写盘）。
        // diagDays 存**字符串**：官方 SegmentedControl 的选项 value 只接受字符串（非字符串会被丢弃），
        // 数值转换统一走 controller.diagDaysNum()，避免 UI 值与请求值两套口径漂移。
        diag: null,
        diagDays: "7",
        diagBusy: false,
        diagErr: false,
        // 剪贴板不可用/被拒时的降级标记（true = 提示用户手动全选报告块）
        diagManual: false
      };
      var api = {
        getSnapshot: function () { return state; },
        // v4.3.0：在途写入登记（toggle 的 POST 期间调用），供 GET 侧竞态守卫判断
        beginWrite: function () { pendingWrites += 1; },
        endWrite: function () { pendingWrites = pendingWrites > 0 ? pendingWrites - 1 : 0; },
        // v6.3.0：删掉零调用的公开访问器 pendingWrites()——staleGuard 直接读闭包变量，
        // 两个口径并存容易漂移；测试与渲染均未使用它。
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
              // 书库根诊断（只读宿主事实，不走 stale 快照分支；空/缺省一律视为无警告）
              root: remote.root || "",
              rootSource: remote.rootSource || "",
              rootWarning: remote.rootWarning || null,
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
        /** v6.5.0：书库根可直接改——POST {lastRoot}，成功后刷新一次让新根与 rootWarning 立即生效。 */
        setRoot: function (dir) {
          var value = String(dir || "").trim();
          if (value === "") {
            api.set({ revealMsg: t("root.emptyErr"), revealErr: true }, { silent: true });
            return Promise.resolve(null);
          }
          api.set({ rootSaving: true, revealMsg: "", revealErr: false }, { silent: true });
          return saveState({ lastRoot: value }).then(function () {
            api.set({ rootSaving: false, rootDraft: null, revealMsg: t("root.saved"), revealErr: false }, { silent: true });
            return api.refresh();
          }).catch(function (err) {
            api.set({ rootSaving: false, revealMsg: t("root.saveErr") + "：" + errorText(err), revealErr: true }, { silent: true });
          });
        },
        setRootDraft: function (text) { api.set({ rootDraft: text == null ? null : String(text) }, { silent: true }); },
        /** v6.5.0 SelectMenu 状态：每个实例 id 一条 {open, active, pos}；open 时惰性安装一次外部点击/滚动关闭。 */
        selectState: function (id) {
          var all = api.getSnapshot().selectMenus || {};
          var cur = all[id] || {};
          return {
            open: cur.open === true,
            active: typeof cur.active === "number" ? cur.active : -1,
            pos: cur.pos && typeof cur.pos === "object" ? cur.pos : null
          };
        },
        selectSet: function (id, patch) {
          var all = Object.assign({}, api.getSnapshot().selectMenus || {});
          all[id] = Object.assign({ open: false, active: -1, pos: null }, all[id] || {}, patch);
          // 同一时刻只开一个下拉：打开某个时关闭其它
          if (patch.open === true) {
            Object.keys(all).forEach(function (k) { if (k !== id) all[k] = Object.assign({}, all[k], { open: false }); });
          }
          api.set({ selectMenus: all }, { silent: true });
          if (patch.open === true && typeof document !== "undefined" && !api.getSnapshot().selectOutsideBound) {
            api.set({ selectOutsideBound: true }, { silent: true });
            var closeAll = function () {
              var menus = api.getSnapshot().selectMenus || {};
              var next = {};
              Object.keys(menus).forEach(function (k) { next[k] = Object.assign({}, menus[k], { open: false }); });
              api.set({ selectMenus: next }, { silent: true });
            };
            document.addEventListener("mousedown", function (ev) {
              var menus = api.getSnapshot().selectMenus || {};
              var anyOpen = Object.keys(menus).some(function (k) { return menus[k] && menus[k].open; });
              if (!anyOpen) return;
              var hit = ev.target && ev.target.closest ? ev.target.closest(".nwSelWrap") : null;
              if (hit) return; // 点在某个下拉内部：交由其自身逻辑处理
              closeAll();
            });
            // v6.4.0：菜单是 position:fixed 的（为了逃出祖先 overflow 裁剪），
            // 所以祖先滚动时要**跟着重定位**，否则它会与触发器脱节、悬在半空。
            //
            // 为什么不是"滚动就关闭"：那样太粗暴——触发器若在面板底边被裁掉一半，
            // 点击时的聚焦滚动会**立刻把刚打开的菜单关掉**（自动化里 Playwright 的自动滚动
            // 就稳定复现了这一点：click 前先滚 → scroll 事件 → closeAll → 菜单数 0）。
            // 现在改成 rAF 节流的重定位；只有触发器整个滚出视口才关闭。
            var reposition = function () {
              var menus = api.getSnapshot().selectMenus || {};
              var next = null;
              var vh = window.innerHeight || 0;
              Object.keys(menus).forEach(function (k) {
                var m = menus[k];
                if (!m || !m.open) return;
                var wrap = document.querySelector('[data-sel-id="' + k + '"]');
                var btn = wrap ? wrap.querySelector("button") : null;
                next = next || Object.assign({}, menus);
                if (!btn) { next[k] = Object.assign({}, m, { open: false }); return; }
                var r = btn.getBoundingClientRect();
                if (r.bottom < 0 || r.top > vh) { next[k] = Object.assign({}, m, { open: false }); return; }
                next[k] = Object.assign({}, m, {
                  pos: Object.assign({}, m.pos, {
                    left: Math.round(r.left),
                    anchorTop: Math.round(r.top),
                    anchorBottom: Math.round(r.bottom),
                    vh: Math.round(vh)
                  })
                });
              });
              if (next) api.set({ selectMenus: next }, { silent: true });
            };
            var ticking = false;
            var onScrollOrResize = function () {
              if (ticking) return;
              ticking = true;
              var run = function () { ticking = false; reposition(); };
              if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run);
              else setTimeout(run, 16);
            };
            window.addEventListener("scroll", onScrollOrResize, true);
            window.addEventListener("resize", onScrollOrResize);
          }
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
        // ---- v6.2.0 必用词表（lexicon）：面板数据通道（GET 读 / POST 写，全部走宿主同一套归一与合并逻辑）----
        // v6.2.0 修复：作用层/当前书快切时旧响应会覆盖新结果——每次请求取递增序号，回调只认最后一次
        lexiconReqId: 0,
        lexiconUrl: function () {
          var s = api.getSnapshot();
          return "/api/dsh-novel-writer/lexicon?book=" + encodeURIComponent(s.lexiconBook || "") +
            "&scope=" + encodeURIComponent(s.lexiconScope || "all");
        },
        loadLexicon: function () {
          var reqId = (api.lexiconReqId += 1);
          api.set({ lexiconBusy: true, lexiconErr: false }, { silent: true });
          return fetchWithTimeout(api.lexiconUrl(), { headers: { accept: "application/json" } }).then(function (r) {
            if (r.ok) return r.json();
            return r.json().catch(function () { return {}; }).then(function (d) {
              throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r.status);
            });
          }).then(function (data) {
            if (reqId !== api.lexiconReqId) return null; // 已有更新的请求发出：丢弃本次过期响应，别覆盖新层数据
            var s = api.getSnapshot();
            // 首次打开时自动选一本书（合并/本书层需要一个书名）；选完再拉一次，避免"空书名只看到全局层"
            var nextBook = s.lexiconBook || data.book || (Array.isArray(data.books) && data.books.length > 0 ? data.books[0] : "");
            var needReload = nextBook !== "" && nextBook !== s.lexiconBook;
            api.set({ lexicon: data, lexiconBook: nextBook, lexiconBusy: false }, { silent: true });
            return needReload ? api.loadLexicon() : data;
          }).catch(function (err) {
            if (reqId !== api.lexiconReqId) return null; // 过期请求的失败同样不要覆盖新结果与新提示
            api.set({ lexiconBusy: false, lexiconErr: true, revealMsg: t("lex.loadFail") + "：" + errorText(err), revealErr: true }, { silent: true });
            return null;
          });
        },
        lexiconPost: function (body) {
          api.set({ lexiconBusy: true, lexiconErr: false }, { silent: true });
          return fetchWithTimeout("/api/dsh-novel-writer/lexicon", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(body)
          }).then(function (r) {
            if (r.ok) return r.json();
            return r.json().catch(function () { return {}; }).then(function (d) {
              throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r.status);
            });
          }).then(function (data) {
            return api.loadLexicon().then(function () { return data; });
          }).catch(function (err) {
            api.set({ lexiconBusy: false, lexiconErr: true, revealMsg: t("lex.saveFail") + "：" + errorText(err), revealErr: true }, { silent: true });
            return null;
          });
        },
        setLexiconScope: function (scope) {
          var next = scope === "global" ? "global" : scope === "book" ? "book" : "all";
          // v6.2.0 修复：切作用层会静默改变「写入层」，留着草稿会让词条落到非预期层 → 切层即清空表单
          api.set({ lexiconScope: next, lexiconForm: null }, { silent: true });
          api.loadLexicon();
        },
        setLexiconBook: function (book) {
          // 同理：换书即换了写入目标，草稿不再属于当前书
          api.set({ lexiconBook: book || "", lexiconForm: null }, { silent: true });
          api.loadLexicon();
        },
        setLexiconSearch: function (text) { api.set({ lexiconQuery: text || "" }, { silent: true }); },
        setLexiconForm: function (patch) {
          var current = api.getSnapshot().lexiconForm || { term: "", kind: "专名", scene: "", avoid: "", note: "", editing: "" };
          api.set({ lexiconForm: Object.assign({}, current, patch) }, { silent: true });
        },
        lexiconResetForm: function () { api.set({ lexiconForm: null }, { silent: true }); },
        lexiconToggleImport: function () { api.set({ lexiconImportOpen: !api.getSnapshot().lexiconImportOpen }, { silent: true }); },
        setLexiconImport: function (text) { api.set({ lexiconImportText: text || "" }, { silent: true }); },
        /** 写入层：scope=global 写全局层，其余（含合并视图）一律写本书层——合并视图只做总览，编辑按钮只出现在写入层条目上。 */
        lexiconWriteLayer: function () { return api.getSnapshot().lexiconScope === "global" ? "global" : "book"; },
        lexiconWriteEntries: function () {
          var s = api.getSnapshot();
          var layer = api.lexiconWriteLayer();
          var all = s.lexicon && Array.isArray(s.lexicon.entries) ? s.lexicon.entries : [];
          return all.filter(function (e) { return (e.scope || "book") === layer; });
        },
        /** v6.3.0：core 现在会显式回报「该层词表文件损坏」。目标层损坏时，写操作默认被 core 拒绝，
         *  必须由用户确认后带 force（toggle）/ overwrite（save/import）才允许丢弃原内容重建。 */
        lexiconLayerCorrupt: function () {
          var data = api.getSnapshot().lexicon || {};
          return data.corrupt === true || (Array.isArray(data.corruptFiles) && data.corruptFiles.length > 0);
        },
        lexiconConfirmCorrupt: function () {
          if (typeof window === "undefined" || !window.confirm) return false;
          return window.confirm(String(t("lex.corruptConfirm")));
        },
        lexiconSaveEntries: function (entries, okMsg) {
          var s = api.getSnapshot();
          var corrupt = api.lexiconLayerCorrupt();
          if (corrupt && !api.lexiconConfirmCorrupt()) return Promise.resolve(null);
          var body = { op: "save", scope: api.lexiconWriteLayer(), book: s.lexiconBook || "", entries: entries };
          if (corrupt) body.overwrite = true;
          return api.lexiconPost(body)
            .then(function (data) {
              if (data) api.set({ revealMsg: okMsg || t("lex.saved"), revealErr: false }, { silent: true });
              return data;
            });
        },
        lexiconSubmitForm: function () {
          var s = api.getSnapshot();
          var form = s.lexiconForm || {};
          var term = String(form.term || "").trim();
          if (term === "") {
            api.set({ revealMsg: t("lex.needTerm"), revealErr: true }, { silent: true });
            return;
          }
          var entry = { term: term };
          if (String(form.kind || "").trim() !== "") entry.kind = String(form.kind).trim();
          if (String(form.scene || "").trim() !== "") entry.scene = String(form.scene).trim();
          if (String(form.note || "").trim() !== "") entry.note = String(form.note).trim();
          var avoid = String(form.avoid || "").split(/[,，、]/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ""; });
          if (avoid.length > 0) entry.avoid = avoid;
          var base = api.lexiconWriteEntries().slice();
          var editing = String(form.editing || "");
          var at = -1;
          for (var i = 0; i < base.length; i += 1) { if (base[i].term === (editing !== "" ? editing : term)) { at = i; break; } }
          if (at >= 0) {
            // v6.2.0 修复：表单只展示 term/kind/scene/avoid/note，其余字段（aliases/priority/enabled）
            // 此前被整条重建时静默丢弃——改成以原条目为底，只覆盖表单拥有的字段，其余原样保留。
            var merged = Object.assign({}, base[at]);
            merged.term = term;
            if (entry.kind) merged.kind = entry.kind; else delete merged.kind;
            if (entry.scene) merged.scene = entry.scene; else delete merged.scene;
            if (entry.note) merged.note = entry.note; else delete merged.note;
            if (entry.avoid) merged.avoid = entry.avoid; else delete merged.avoid;
            base[at] = merged;
          } else base.push(entry);
          api.lexiconResetForm();
          api.lexiconSaveEntries(base, t("lex.saved") + "：" + term);
        },
        lexiconEditEntry: function (term, scope) {
          var s = api.getSnapshot();
          var all = s.lexicon && Array.isArray(s.lexicon.entries) ? s.lexicon.entries : [];
          // v6.2.0 修复：合并视图下同名条目以书级为准，只按 term 匹配可能取到另一层的字段 → 用 term+scope 唯一定位
          var wantScope = scope === "global" ? "global" : "book";
          var found = null;
          for (var i = 0; i < all.length; i += 1) {
            if (all[i].term === term && (all[i].scope || "book") === wantScope) { found = all[i]; break; }
          }
          if (!found) for (var j = 0; j < all.length; j += 1) { if (all[j].term === term) { found = all[j]; break; } }
          api.set({ lexiconForm: {
            term: term,
            kind: found && found.kind ? found.kind : "专名",
            scene: found && found.scene ? found.scene : "",
            avoid: found && Array.isArray(found.avoid) ? found.avoid.join(",") : "",
            note: found && found.note ? found.note : "",
            editing: term
          } }, { silent: true });
        },
        lexiconDeleteEntry: function (term) {
          var label = String(t("lex.confirmDelete")).replace("{term}", String(term));
          if (typeof window !== "undefined" && window.confirm && !window.confirm(label)) return;
          var base = api.lexiconWriteEntries().filter(function (e) { return e.term !== term; });
          api.lexiconSaveEntries(base, t("lex.saved"));
        },
        lexiconRunImport: function (replace) {
          var s = api.getSnapshot();
          var text = String(s.lexiconImportText || "");
          if (text.trim() === "") {
            api.set({ revealMsg: t("lex.needTerm"), revealErr: true }, { silent: true });
            return;
          }
          if (replace === true && typeof window !== "undefined" && window.confirm && !window.confirm(String(t("lex.confirmReplace")))) return;
          var corrupt = api.lexiconLayerCorrupt();
          if (corrupt && !api.lexiconConfirmCorrupt()) return;
          var body = { op: "import", scope: api.lexiconWriteLayer(), book: s.lexiconBook || "", text: text, replace: replace === true };
          if (corrupt) body.overwrite = true;
          api.lexiconPost(body)
            .then(function (data) { if (data) api.set({ lexiconImportText: "" }, { silent: true }); });
        },
        lexiconToggleLayer: function (enabled) {
          var s = api.getSnapshot();
          var corrupt = api.lexiconLayerCorrupt();
          if (corrupt && !api.lexiconConfirmCorrupt()) return;
          var body = { op: "toggle", scope: api.lexiconWriteLayer(), book: s.lexiconBook || "", enabled: !!enabled };
          if (corrupt) body.force = true;
          api.lexiconPost(body);
        },
        // ---- 风格基线范围（baseline）：与词表同族的数据通道（GET 读 / POST 写） ----
        // 照词表面板的成熟写法：每次请求取递增序号，回调只认最后一次（快切书/快切模式时旧响应不得覆盖新结果）。
        baselineReqId: 0,
        baselineUrl: function () {
          return "/api/dsh-novel-writer/baseline?book=" + encodeURIComponent(api.getSnapshot().baselineBook || "");
        },
        /** 本书全部章节（供选择器渲染），按书序。 */
        baselineAvailable: function () {
          var d = api.getSnapshot().baseline;
          return d && Array.isArray(d.available) ? d.available : [];
        },
        /** 书列表来源与词表面板同源：宿主下发列表优先，否则回退 /state 的 books。 */
        baselineBookOptions: function (data) {
          var s = api.getSnapshot();
          var list = data && Array.isArray(data.books) && data.books.length > 0 ? data.books : (s.books || []);
          var out = [];
          for (var i = 0; i < list.length; i += 1) {
            var b = list[i];
            if (typeof b === "string" && b !== "" && out.indexOf(b) === -1) out.push(b);
          }
          return out;
        },
        /** 待保存的选中章：按书序输出，并顺手丢掉已不在 available 里的失效项（改过名/被删掉的章）。 */
        baselineSelectedFiles: function () {
          var sel = api.getSnapshot().baselineSel;
          var picked = Array.isArray(sel) ? sel : [];
          var avail = api.baselineAvailable();
          var out = [];
          for (var i = 0; i < avail.length; i += 1) {
            var f = avail[i] && avail[i].file;
            if (typeof f === "string" && picked.indexOf(f) !== -1) out.push(f);
          }
          return out;
        },
        loadBaseline: function () {
          var reqId = (api.baselineReqId += 1);
          api.set({ baselineBusy: true, baselineErr: false }, { silent: true });
          return fetchWithTimeout(api.baselineUrl(), { headers: { accept: "application/json" } }).then(function (r) {
            if (r.ok) return r.json();
            return r.json().catch(function () { return {}; }).then(function (d) {
              throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r.status);
            });
          }).then(function (data) {
            if (reqId !== api.baselineReqId) return null; // 已有更新的请求发出：丢弃过期响应
            var s = api.getSnapshot();
            // 首次打开时自动选一本书（基线范围是「按书」配置的）；选完再拉一次，避免"空书名拿不到章节列表"
            var books = api.baselineBookOptions(data);
            var nextBook = s.baselineBook || (data && data.book) || (books.length > 0 ? books[0] : "");
            if (nextBook !== s.baselineBook) {
              api.set({ baselineBook: nextBook || "", baselineBusy: false }, { silent: true });
              return api.loadBaseline();
            }
            var avail = data && Array.isArray(data.available) ? data.available : [];
            var have = {};
            for (var i = 0; i < avail.length; i += 1) {
              var af = avail[i] && avail[i].file;
              if (typeof af === "string" && af !== "") have[af] = true;
            }
            // 已存章节里挑出「不在本书章节列表中」的失效项（改名/删除）：只提示，不塞回选中集合
            var stored = data && Array.isArray(data.chapters) ? data.chapters : [];
            var kept = [];
            var lost = [];
            for (var j = 0; j < stored.length; j += 1) {
              var sf = stored[j];
              if (typeof sf !== "string" || sf === "") continue;
              if (have[sf]) { if (kept.indexOf(sf) === -1) kept.push(sf); }
              else if (lost.indexOf(sf) === -1) lost.push(sf);
            }
            api.set({
              baseline: data,
              baselineMode: data && data.mode === "custom" ? "custom" : "all",
              baselineSel: kept,
              baselineMissing: lost,
              baselineBusy: false
            }, { silent: true });
            return data;
          }).catch(function (err) {
            if (reqId !== api.baselineReqId) return null; // 过期请求的失败同样不覆盖新结果与新提示
            api.set({ baselineBusy: false, baselineErr: true, revealMsg: t("base.loadFail") + "：" + errorText(err), revealErr: true }, { silent: true });
            return null;
          });
        },
        /** 宿主里**已保存**的标杆章（与生效档位无关：mode != custom 时服务端刻意不动 chapters，故这里可能非空而档位是 all）。 */
        baselineStoredFiles: function () {
          var d = api.getSnapshot().baseline;
          if (!d || !Array.isArray(d.chapters)) return [];
          var out = [];
          for (var i = 0; i < d.chapters.length; i += 1) {
            if (typeof d.chapters[i] === "string" && d.chapters[i] !== "") out.push(d.chapters[i]);
          }
          return out;
        },
        /**
         * 清空已保存的标杆章。**唯一能真正清空的写法是 `mode:"custom"` + `chapters:[]`**：
         * 服务端的 PATCH 语义是「mode != custom 时不动 chapters」（切到按全书 = 这次不用，而不是删掉），
         * 所以发 `{mode:"all", chapters:[]}` 什么也清不掉。
         * 清空后服务端会回报**生效档位 `all`**（实际行为就是按全书），面板据此显示「按全书」并让已选归零——
         * 不因为 mode 变回 all 就把本地选择填回去（baselineSel 只由 chapters 派生）。
         */
        baselineClearSaved: function () {
          var s = api.getSnapshot();
          var book = s.baselineBook || "";
          if (book === "") {
            api.set({ revealMsg: t("base.needBook"), revealErr: true }, { silent: true });
            return Promise.resolve(null);
          }
          if (api.baselineStoredFiles().length === 0) return Promise.resolve(null); // 本来就没存量：不是错误，静默不动作
          if (typeof window === "undefined" || typeof window.confirm !== "function" || !window.confirm(String(t("base.confirmClear")))) return Promise.resolve(null);
          return api.baselinePost({ book: book, mode: "custom", chapters: [] }, "base.clearFail").then(function (data) {
            if (data) api.set({ revealMsg: t("base.cleared"), revealErr: false }, { silent: true });
            return data;
          });
        },
        baselinePost: function (body, failKey) {
          api.set({ baselineBusy: true, baselineErr: false }, { silent: true });
          return fetchWithTimeout("/api/dsh-novel-writer/baseline", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(body)
          }).then(function (r) {
            if (r.ok) return r.json();
            return r.json().catch(function () { return {}; }).then(function (d) {
              throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r.status);
            });
          }).then(function (data) {
            return api.loadBaseline().then(function () { return data; });
          }).catch(function (err) {
            api.set({ baselineBusy: false, baselineErr: true, revealMsg: t(failKey || "base.saveFail") + "：" + errorText(err), revealErr: true }, { silent: true });
            return null;
          });
        },
        setBaselineBook: function (book) {
          var next = book || "";
          if (next === (api.getSnapshot().baselineBook || "")) return;
          // 换书 = 换整套基线数据与选中项：先清空，等 GET 回来重填（旧书的选中项绝不落到新书）
          api.set({ baselineBook: next, baseline: null, baselineMode: "all", baselineSel: [], baselineMissing: [], baselineShowAll: false }, { silent: true });
          api.loadBaseline();
        },
        /** 范围模式只是本地草稿，点了保存才写盘（避免误点分段控件就把配置改掉）。 */
        setBaselineMode: function (mode) {
          var next = mode === "custom" ? "custom" : "all";
          if (api.getSnapshot().baselineMode === next) return;
          api.set({ baselineMode: next }, { silent: true });
        },
        baselineToggleChapter: function (file) {
          if (typeof file !== "string" || file === "") return;
          var cur = api.getSnapshot().baselineSel;
          var sel = Array.isArray(cur) ? cur.slice() : [];
          var at = sel.indexOf(file);
          if (at >= 0) sel.splice(at, 1); else sel.push(file);
          api.set({ baselineSel: sel }, { silent: true });
        },
        baselineSelectAll: function () {
          var avail = api.baselineAvailable();
          var out = [];
          for (var i = 0; i < avail.length; i += 1) {
            var f = avail[i] && avail[i].file;
            if (typeof f === "string" && f !== "") out.push(f);
          }
          api.set({ baselineSel: out }, { silent: true });
        },
        baselineClearSel: function () { api.set({ baselineSel: [] }, { silent: true }); },
        baselineInvertSel: function () {
          var picked = api.getSnapshot().baselineSel;
          var sel = Array.isArray(picked) ? picked : [];
          var avail = api.baselineAvailable();
          var out = [];
          for (var i = 0; i < avail.length; i += 1) {
            var f = avail[i] && avail[i].file;
            if (typeof f !== "string" || f === "") continue;
            if (sel.indexOf(f) === -1) out.push(f);
          }
          api.set({ baselineSel: out }, { silent: true });
        },
        /** 章节很多的本书：列表默认只渲染前若干章，用户显式展开后再全量渲染。 */
        baselineExpandList: function () { api.set({ baselineShowAll: true }, { silent: true }); },
        baselineSave: function () {
          var s = api.getSnapshot();
          var book = s.baselineBook || "";
          if (book === "") {
            api.set({ revealMsg: t("base.needBook"), revealErr: true }, { silent: true });
            return Promise.resolve(null);
          }
          var mode = s.baselineMode === "custom" ? "custom" : "all";
          var chapters = mode === "custom" ? api.baselineSelectedFiles() : [];
          if (mode === "custom" && chapters.length === 0) {
            // 空选择不是"清空"：清空走 baselineClearSaved（显式按钮 + 二次确认），
            // 这里拒绝并指路，免得用户以为"取消全部勾选再保存"就等于把存量清掉了
            // （服务端 mode != custom 时不动 chapters，所以切按全书保存也清不掉）。
            api.set({ revealMsg: t("base.needCustom"), revealErr: true }, { silent: true });
            return Promise.resolve(null);
          }
          return api.baselinePost({ book: book, mode: mode, chapters: chapters }).then(function (data) {
            if (data) api.set({ revealMsg: t("base.saved"), revealErr: false }, { silent: true });
            return data;
          });
        },
        // ---- v6.6.0 诊断（GET /api/dsh-novel-writer/diagnose）：只读通道，与词表/基线同族 ----
        // 语义要点：响应的 report 由宿主「分享层」渲染（自由文本已整体剔除），面板**只展示不重拼**，
        // 否则面板与 novel_diagnose 工具的报告会各写一份、随时间分叉。
        diagReqId: 0,
        diagDaysNum: function () {
          var n = Number(api.getSnapshot().diagDays);
          if (!isFinite(n) || n <= 0) n = 7;
          return Math.min(90, Math.max(1, Math.trunc(n)));
        },
        diagUrl: function () {
          return "/api/dsh-novel-writer/diagnose?days=" + String(api.diagDaysNum());
        },
        loadDiagnose: function () {
          var reqId = (api.diagReqId += 1);
          api.set({ diagBusy: true, diagErr: false }, { silent: true });
          return fetchWithTimeout(api.diagUrl(), { headers: { accept: "application/json" } }).then(function (r) {
            if (r.ok) return r.json();
            return r.json().catch(function () { return {}; }).then(function (d) {
              throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r.status);
            });
          }).then(function (data) {
            if (reqId !== api.diagReqId) return null; // 已有更新的请求发出：丢弃本次过期响应（口径同词表/基线）
            api.set({ diag: data, diagBusy: false, diagErr: false, diagManual: false }, { silent: true });
            return data;
          }).catch(function (err) {
            if (reqId !== api.diagReqId) return null; // 过期请求的失败同样不覆盖新结果与新提示
            // 失败时**保留上一份报告**（诊断失败不该把仅有的可分享材料清掉），只置错误态 + 横幅
            api.set({ diagBusy: false, diagErr: true, revealMsg: t("diag.loadFail") + "：" + errorText(err), revealErr: true }, { silent: true });
            return null;
          });
        },
        setDiagDays: function (days) {
          var next = String(days === void 0 || days === null ? "7" : days);
          var n = Number(next);
          next = (!isFinite(n) || n <= 0) ? "7" : String(Math.min(90, Math.max(1, Math.trunc(n))));
          if (next === api.getSnapshot().diagDays) return;
          api.set({ diagDays: next, diagManual: false }, { silent: true });
          api.loadDiagnose(); // 窗口变了，已展示的报告就过期了：立刻按新窗口重取
        },
        /**
         * 「复制诊断包」正文 = 接口给的 report + 一段极简环境信息。
         * 环境信息只由**结构化字段**（root/days/calls/dataDir/log）拼成，不含任何自由文本——
         * 分享层的隐私承诺因此不被这一段破坏（报告本身也已在服务端剔除自由文本）。
         */
        diagPackText: function (data) {
          var d = data && typeof data === "object" ? data : {};
          var report = typeof d.report === "string" ? d.report : "";
          var root = d.root && typeof d.root === "object" ? d.root : {};
          var calls = d.calls && typeof d.calls === "object" ? d.calls : {};
          var dataDir = d.dataDir && typeof d.dataDir === "object" ? d.dataDir : {};
          var log = d.log && typeof d.log === "object" ? d.log : {};
          var days = d.days === void 0 || d.days === null ? api.diagDaysNum() : d.days;
          var lines = [];
          lines.push("");
          lines.push("---- " + t("diag.packTitle") + " ----");
          lines.push(t("diag.envRoot") + "：" + (typeof root.path === "string" && root.path !== "" ? root.path : t("plot.pathUnknown")) + "（" + (root.source || "") + "）");
          lines.push(t("diag.envWindow") + "：" + String(days) + " " + t("diag.daysUnit"));
          lines.push(t("diag.callsTotal") + " " + String(calls.total || 0) + " · " + t("diag.callsDegraded") + " " + String(calls.degraded || 0) + " · " + t("diag.callsFailed") + " " + String(calls.failed || 0));
          if (typeof dataDir.path === "string" && dataDir.path !== "") {
            lines.push(t("diag.envData") + "：" + dataDir.path + (dataDir.exists === true ? "" : "（×）"));
          }
          if (typeof log.dir === "string" && log.dir !== "") lines.push(t("diag.envLog") + "：" + log.dir);
          lines.push(t("diag.privacy"));
          return report + "\n" + lines.join("\n");
        },
        diagCopy: function () {
          var data = api.getSnapshot().diag;
          if (!data || typeof data.report !== "string" || data.report === "") {
            api.set({ revealMsg: t("diag.empty"), revealErr: true }, { silent: true });
            return;
          }
          var ok = function () { api.set({ revealMsg: t("diag.copied"), revealErr: false, diagManual: false }, { silent: true }); };
          // 降级：剪贴板不存在 / 非安全上下文 / 权限被拒 → 不谎报成功，提示用户手动全选报告块
          var fail = function () { api.set({ revealMsg: t("diag.copyFail"), revealErr: true, diagManual: true }, { silent: true }); };
          try {
            if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
              navigator.clipboard.writeText(api.diagPackText(data)).then(ok, fail);
              return;
            }
          } catch (err) { /* 访问 navigator.clipboard 抛错（权限策略/沙箱）→ 同样走手动复制 */ }
          fail();
        },
        // v4.0.0 修正：导航/分组展开属纯 UI 状态，silent 写入不得自增 rev——否则刷新期间点一下导航，远端开关值会被守卫静默丢弃
        openView: function (view) {
          api.set({ view: view, revealMsg: "", revealErr: false }, { silent: true });
          // v6.2.0：词表页需要现取数据（宿主侧读盘），进入即拉一次
          if (view === "lexicon") api.loadLexicon();
          // 风格基线页的「范围」同样要现取（本书章节列表来自宿主），进入即拉一次
          if (view === "baseline") api.loadBaseline();
          // v6.6.0：诊断页的报告是现算的（宿主聚合本地日志），进入即拉一次
          if (view === "diagnose") api.loadDiagnose();
          // v6.8.1：删除页下方常驻回收站，进入即拉一次列表
          if (view === "trash") api.trashLoad();
        },
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
          // v6.3.0 修复：长度阈值原先写死 5，而中文关键词「绝不传播」只有 4 个字——用户严格照提示只输入这
          // 4 个字时关键词判定通过、长度判定失败，确认按钮（disabled: !rawPromiseOk）永远点不动且无任何反馈。
          // 改为与关键词长度对齐（英文 "never distribute" 16 字，同样满足）。
          var ok = String(text || "").toLowerCase().indexOf(kw) !== -1 && String(text || "").trim().length >= kw.length;
          api.set({ rawPromiseText: text || "", rawPromiseOk: ok }, { silent: true });
        },
        rawPromiseConfirm: function () {
          if (!api.getSnapshot().rawPromiseOk) return;
          if (rawTimer) { clearInterval(rawTimer); rawTimer = null; }
          if (toggleRef) toggleRef({ features: { rawWriting: true } });
          api.set({ rawPromiseOpen: false, rawPromiseText: "", rawPromiseOk: false, rawModal: false, rawCountdown: 0 }, { silent: true });
        },
        // ---- v6.8.0：按书删除 + 回收站（宿主端与 novel_delete_book 同一实现） ----
        // v6.8.1：入口从"藏在书库折叠区里的弹窗"改成**独立页面**（用户实测找不到按钮）。
        // 页面内联预览，书库行上的按钮仍走弹窗；两者的加载与陈旧响应守卫共用 loadDeletePlan。
        /** 书库行快捷入口（弹窗） */
        deleteOpen: function (book) { return loadDeletePlan(book, true); },
        /** 删除页内选中一本书（页面内联） */
        deletePick: function (book) { return loadDeletePlan(book, false); },
        deleteClose: function () {
          // 作废在途预览：关掉/返回后迟到的响应不该把内容又填回来
          api.set({ delReqId: (api.getSnapshot().delReqId || 0) + 1, delOpen: false, delBook: "", delPlan: null, delResult: null, delLoading: false, delError: "", delAck: false, delBusy: false }, { silent: true });
        },
        deleteAck: function (value) { api.set({ delAck: value === true }, { silent: true }); },
        /** 勾/取消某一处（全选时等于原来的"删整本书"，取消到只剩报告类就变成"只清报告"） */
        deleteToggleKey: function (key, on) {
          var sel = Object.assign({}, api.getSnapshot().delSel || {});
          if (on === true) sel[key] = true; else delete sel[key];
          api.set({ delSel: sel, delAck: false }, { silent: true });
        },
        deleteSelectAll: function (on) {
          var plan = api.getSnapshot().delPlan;
          var sel = {};
          if (on === true && plan) (plan.targets || []).forEach(function (t) { if (t.exists && t.files > 0) sel[t.key] = true; });
          api.set({ delSel: sel, delAck: false }, { silent: true });
        },
        deleteApply: function () {
          var snapshot = api.getSnapshot();
          var keys = Object.keys(snapshot.delSel || {}).filter(function (k) { return snapshot.delSel[k] === true; });
          if (snapshot.delAck !== true || snapshot.delBusy || snapshot.delBook === "" || keys.length === 0) return Promise.resolve(null);
          api.set({ delBusy: true, delError: "" }, { silent: true });
          return deleteBookRoute({ action: "apply", book: snapshot.delBook, keys }).then(function (data) {
            api.set({ delBusy: false, delResult: data }, { silent: true });
            // 正文与资料已移走：书库统计 / 书列表 / 报告目录都变了，静默刷新一次；
            // 回收站里同时多了一条，页面的回收站小节要跟着更新
            api.refresh();
            api.trashLoad();
            return data;
          }).catch(function (err) {
            api.set({ delBusy: false, delError: errorText(err) }, { silent: true });
            return null;
          });
        },
        /** 拉回收站列表（删除页的「回收站」小节；不再开弹窗） */
        trashLoad: function () {
          api.set({ trashLoading: true, trashError: "", trashNote: "", trashBusyId: "" }, { silent: true });
          return deleteBookRoute({ action: "list" }).then(function (data) {
            var list = data && Array.isArray(data.trash) ? data.trash : [];
            api.set({ trashList: list, trashLoading: false }, { silent: true });
            return list;
          }).catch(function (err) {
            api.set({ trashLoading: false, trashList: null, trashError: errorText(err) }, { silent: true });
            return null;
          });
        },
        /** 恢复：成功后重列一次（清单可能整条消失），并刷新书库统计。 */
        trashRestore: function (id) {
          var entryId = String(id || "");
          if (entryId === "" || api.getSnapshot().trashBusyId !== "") return Promise.resolve(null);
          api.set({ trashBusyId: entryId, trashNote: "", trashError: "" }, { silent: true });
          return deleteBookRoute({ action: "restore", trashId: entryId }).then(function (data) {
            var note = String(t("trash.restored")).replace("{n}", String((data && data.restored) || 0));
            if (data && Array.isArray(data.conflicts) && data.conflicts.length > 0) {
              note += "；" + String(t("trash.conflict")).replace("{n}", String(data.conflicts.length));
            }
            return deleteBookRoute({ action: "list" }).then(function (next) {
              api.set({ trashBusyId: "", trashList: next && Array.isArray(next.trash) ? next.trash : [], trashNote: note }, { silent: true });
              api.refresh();
              return data;
            });
          }).catch(function (err) {
            api.set({ trashBusyId: "", trashError: errorText(err) }, { silent: true });
            return null;
          });
        },
        /** 彻底删除：不可撤销，先过一次原生确认（与创建页丢弃草稿的确认同一做法）。 */
        trashPurge: function (id) {
          var entryId = String(id || "");
          if (entryId === "" || api.getSnapshot().trashBusyId !== "") return Promise.resolve(null);
          if (!window.confirm(String(t("trash.purgeAsk")).replace("{id}", entryId))) return Promise.resolve(null);
          api.set({ trashBusyId: entryId, trashNote: "", trashError: "" }, { silent: true });
          return deleteBookRoute({ action: "purge", trashId: entryId }).then(function (data) {
            return deleteBookRoute({ action: "list" }).then(function (next) {
              api.set({ trashBusyId: "", trashList: next && Array.isArray(next.trash) ? next.trash : [], trashNote: t("trash.purged") }, { silent: true });
              return data;
            });
          }).catch(function (err) {
            api.set({ trashBusyId: "", trashError: errorText(err) }, { silent: true });
            return null;
          });
        },
        /** 报告历史：拉取分组列表（进入视图 / 删除后重拉都走它） */
        loadReports: function () {
          var seq = (reportsLoadSeq += 1);
          return fetchReports().then(function (data) {
            if (seq !== reportsLoadSeq) return null; // 过期响应丢弃（与报告正文读取同一口径）
            api.set({ reportsGroups: Array.isArray(data.groups) ? data.groups : [], reportsError: false }, { silent: true });
            return data;
          }).catch(function (err) {
            if (seq !== reportsLoadSeq) return null;
            // 失败不伪装成"暂无报告"（空数组会让视图显示空态，与"读取失败"混淆）
            api.set({ reportsGroups: null, reportsError: true, revealMsg: t("reports.readFail") + "：" + errorText(err), revealErr: true }, { silent: true });
            return null;
          });
        },
        /**
         * 单份报告移入回收站（v6.8.0）。为什么不是直接 rm：`style-reports/<书>.json` 里可能存着
         * AI 回传并保存的风格判断，删掉就真没了——所以与删书共用同一套回收站，可恢复。
         */
        deleteReport: function (file) {
          var name = String(file || "");
          if (name === "") return Promise.resolve(null);
          if (!window.confirm(String(t("reports.deleteAsk")).replace("{file}", name))) return Promise.resolve(null);
          api.set({ reportDeleting: name }, { silent: true });
          return forgetReport(name).then(function (data) {
            api.set({ reportDeleting: "", reportContent: null, revealMsg: String(t("reports.deleted")).replace("{file}", name), revealErr: false }, { silent: true });
            api.loadReports();
            api.trashLoad(); // 回收站多了一条：删除页那一块要能立刻看到并恢复
            return data;
          }).catch(function (err) {
            api.set({ reportDeleting: "", revealMsg: t("reports.deleteFail") + "：" + errorText(err), revealErr: true }, { silent: true });
            return null;
          });
        }
      };
      /**
       * 取某本书的删除预览——书库行按钮（弹窗）与删除页（内联）**共用**这一份。
       * 预览用 delReqId 做陈旧响应守卫（与 reports/fix-plan 同一口径）：连点两本书时，
       * 先发后到的旧响应不得把清单覆盖成另一本书的内容——那正是"删错书"最可能的入口。
       */
      function loadDeletePlan(book, modal) {
        var bookName = String(book || "");
        var reqId = (api.getSnapshot().delReqId || 0) + 1;
        api.set({ delOpen: modal === true, delBook: bookName, delPlan: null, delLoading: true, delError: "", delAck: false, delBusy: false, delResult: null, delReqId: reqId, delSel: {} }, { silent: true });
        return deleteBookRoute({ action: "preview", book: bookName }).then(function (data) {
          if (api.getSnapshot().delReqId !== reqId) return null;
          // 默认全选＝"删整本书"（既有行为）；用户取消勾选即变成"只清这一类"
          var sel = {};
          if (data && Array.isArray(data.targets)) {
            data.targets.forEach(function (t) { if (t.exists === true && Number(t.files) > 0) sel[t.key] = true; });
          }
          api.set({ delPlan: data, delLoading: false, delSel: sel }, { silent: true });
          return data;
        }).catch(function (err) {
          if (api.getSnapshot().delReqId !== reqId) return null;
          api.set({ delLoading: false, delError: errorText(err) }, { silent: true });
          return null;
        });
      }
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
    // v6.5.0：自建下拉（替换原生 select——系统弹层方角、系统蓝，与面板观感不符）。
    // props: { value, options:[{value,label}], placeholder, disabled, label, onChange(value) }
    // 键盘：↑/↓ 移动高亮、Enter 选中、Esc/Tab 关闭；点击外部关闭。无选中项时触发器显示 placeholder。
    // 无 hook 实现（CONTRACT-V6 §1.6：react.use* 调用点须恒为 12）。开合与高亮状态存于控制器，
    // 每个实例用 props.id 区分；点击外部由 document 监听（控制器惰性安装一次）关闭。
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
      var entry = function (title, hint, count, viewName, onClick, disabled) {
        var icons = { features: "navFeatures", tools: "navTools", creation: "navCreation", baseline: "navBaseline", lexicon: "navLexicon", model: "navModel", reports: "navReports", diagnose: "navDiagnose", demo: "navDemo", trash: "trash" };
        return el("button", { type: "button", key: viewName, className: "nwNavEntry", disabled: !!disabled, onClick: onClick || function () { props.controller.openView(viewName); } },
          el("div", { className: "nwIconSlot" }, nwGlyph(el, "nwIconGlyph", icons[viewName] || "navArrow", "›")),
          el("div", { className: "nwNavEntryText" },
            el("div", { className: "nwNavEntryTitle" }, title),
            el("div", { className: "nwNavEntryHint" }, hint)),
          el("div", { className: "nwNavEntryRight" },
            count === null || count === undefined ? null : CountBadge(el, el, t, NW_UI, { label: String(count) }),
            el("span", { className: "nwNavEntryArrow", "aria-hidden": true }, "›")));
      };
      var backBtn = function () {
        return el("button", { type: "button", className: "nwBackBtn", onClick: function () {
            // v3.7.0 ④：creation-form 返回前 dirty 确认（与 switchBook 同机制，防静默丢修改）
            if (view === "creation-form" && state.creationDirty && !window.confirm(t("creation.dirtyWarn"))) return;
            props.controller.openView("main");
          } }, "‹ " + t("panel.title"));
      };
      var switchRow = function (name, fOn, onToggle, extra) {
        return PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
          key: name,
          icon: NW_ICONS[name] ? name : "fallback",
          className: fOn ? "nwRowOn" : "",
          title: t("feature." + name),
          summary: extra ? [t("feature." + name + ".desc"), extra] : t("feature." + name + ".desc"),
          trailing: el(Switch, { checked: fOn, disabled: state.loading, label: String(t("feature." + name)),
            onChange: function () { onToggle(name, !fOn); } })
        });
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
        if (st.error) return t("home.modelError");
        return t("model.engineIdle");
      }
      // v6.4.0：书库根行——显示当前根与来源；可直接改（写 lastRoot，走后端既有的 POST /state）。
      //
      // 抽成函数是因为它要在**两处**渲染：主视图「状态」区，以及**词表面板**——
      // 书列不出来时用户人就在词表面板里，让他能就地改根，而不是满面板去找（上一版只放主视图底部，
      // 实测用户根本没翻到那儿）。
      var rootRow = function () {
        var srcKey = "root.src." + (state.rootSource || "cwd");
        var srcText = t(srcKey);
        if (srcText === srcKey) srcText = state.rootSource || "";
        var pinned = state.rootSource === "config";
        var draft = state.rootDraft == null ? (state.root || "") : state.rootDraft;
        return el("div", { key: "root-row", className: "nwRootRow" },
          el("div", { className: "nwRootMeta", title: state.root || "" },
            t("root.label") + "：" + (state.root || t("plot.pathUnknown")),
            el("span", { className: "nwRootSrc" }, srcText)
          ),
          state.rootWarning ? el("div", { className: "nwNote nwNoteWarn", style: { whiteSpace: "pre-wrap" } }, state.rootWarning) : null,
          el("div", { className: "nwRootEdit" },
            el("input", {
              type: "text",
              className: "nwRootInput",
              value: draft,
              placeholder: t("root.placeholder"),
              disabled: pinned || state.rootSaving,
              "aria-label": t("root.label"),
              onInput: function (ev) { props.controller.setRootDraft(ev.target.value); },
              onKeyDown: function (ev) { if (ev.key === "Enter") props.controller.setRoot(draft); }
            }),
            el("button", {
              type: "button",
              className: "nwBtn",
              disabled: pinned || state.rootSaving,
              onClick: function () { props.controller.setRoot(draft); }
            }, state.rootSaving ? "…" : t("root.save"))
          ),
          pinned ? el("div", { className: "nwRootNote" }, t("root.pinned")) : null
        );
      };
      var dirs = state.dirs || {};
      var f = state.features || {};      var tools = state.tools || {};
var TOOL_GROUPS = [
        { key: "analyze", tools: ["novel_books", "novel_chapters", "novel_read", "novel_keywords", "novel_sentence_analysis", "novel_style_check", "novel_fix_plan", "novel_style_report", "novel_semantic_search", "novel_continuity_check", "novel_diagnose"] },
        { key: "settings", tools: ["novel_settings", "novel_plot", "novel_summary", "novel_import", "novel_delete_book"] },
        // v3.9.0：novel_sentence_config 移出组开关（宿主会剥离该键，全关后 UI 显示与实际不一致）——config 仅由二级页/设置单独管理
        // v5.0.0：novel_chapter_brief 归入 create 组——它的调用时机是"要动笔了"
        // v6.2.0：novel_lexicon（必用词表）同属"动笔前定好用词"这条线
        { key: "create", tools: ["novel_chapter_brief", "novel_lexicon", "novel_new_chapter", "novel_outline"] }
      ];
      var toolGroupOpen = state.toolGroupOpen || {};
      // Tool icons describe the action, not its storage location.
      var toolIcons = {
        novel_books: "toolBooks", novel_chapters: "toolChapters", novel_read: "toolRead",
        novel_keywords: "toolKeywords", novel_sentence_analysis: "toolSentences", novel_style_check: "toolStyleCheck",
        novel_fix_plan: "toolRevise", novel_style_report: "toolProfile", novel_semantic_search: "toolSearch",
        novel_continuity_check: "toolContinuity", novel_diagnose: "toolDiagnose", novel_settings: "toolSettings",
        novel_plot: "toolPlot", novel_summary: "toolSummary", novel_import: "toolImport",
        novel_chapter_brief: "toolBrief", novel_lexicon: "toolLexicon", novel_new_chapter: "toolNewChapter",
        novel_outline: "toolOutline", novel_delete_book: "trash"
      };
      var toolRows = TOOL_GROUPS.map(function (grp) {
        var isOpen = toolGroupOpen[grp.key] === true;
        var groupOnCount = grp.tools.filter(function (n) { return tools[n] !== false; }).length;
        var groupState = groupOnCount === grp.tools.length ? "on" : groupOnCount === 0 ? "off" : "partial";
        return el("div", { key: grp.key, className: "nwToolCategory" },
          GroupCard(el, el, t, NW_UI, { children: [
            el("div", { key: "head", className: "nwToolGroupHead" + (isOpen ? " nwToolGroupHeadOpen" : "") },
              el("button", { type: "button", className: "nwToolGroupHeadBtn", "aria-expanded": isOpen, onClick: function () {
                var patch = Object.assign({}, toolGroupOpen); patch[grp.key] = !isOpen;
                props.controller.setToolGroupOpen(patch);
              } },
                el("span", { className: "nwToolGroupName" }, t("toolGroup." + grp.key)),
                CountBadge(el, el, t, NW_UI, { label: groupOnCount + "/" + grp.tools.length }),
                nwGlyph(el, "nwToolCategoryArrow" + (isOpen ? " nwToolCategoryArrowOpen" : ""), "navArrow", "›")
              ),
              el("div", { className: "nwToolAll", title: groupState === "on" ? t("group.allOn") : groupState === "partial" ? t("group.partial") : t("group.allOff") },
                el("span", { "aria-hidden": true }, t("tool.all")),
                el(Switch, { checked: groupState === "on", disabled: state.loading, label: t("toolGroup." + grp.key) + " · " + t("tool.all"), onChange: function () {
                  var patch = {};
                  var target = groupState === "on" ? false : true;
                  grp.tools.forEach(function (n) { patch[n] = target; });
                  props.toggle({ tools: patch });
                } })
              )
            ),
            el("div", { key: "desc", className: "nwToolCategoryHint" }, t("toolGroup." + grp.key + ".desc")),
            isOpen ? el("div", { key: "body", className: "nwToolCategoryBody" }, grp.tools.map(function (name, idx) {
              var checked = tools[name] !== false;
              return [
                RowDivider(el, el, t, NW_UI, { key: "td-" + name }),
                PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
                  key: name, icon: toolIcons[name], title: t("tool." + name), summary: t("tool." + name + ".desc"),
                  switchOn: checked, switchDisabled: state.loading, switchLabel: t("tool." + name),
                  switchOnChange: function () { props.toggle({ tools: (function (patch) { patch[name] = !checked; return patch; })({}) }); }
                })
              ];
            })) : null
          ] })
        );
      });
      // v2.6.0 修复：detailFeatures 提升到渲染函数顶部——二级页渲染与主面板计数共用同一列表（此前计数数组漏 webnovelVibe，5 个开关显示"4开"）
      var detailFeatures = ["emotionCaveat", "emotionComplexity", "genreTheme", "webnovelVibe", "semanticEmbedding", "lexiconFirst"];
      var body = null;
      if (view === "features") {
        body = el("div", { className: "nwFeaturesPage" },
          el("div", { className: "nwToolsHint" }, t("panel.featuresHint")),
          GroupCard(el, el, t, NW_UI, { children: detailFeatures.map(function (name, idx) {
            var checked = f[name] !== false;
            return [
              idx > 0 ? RowDivider(el, el, t, NW_UI, { key: "fd-" + name }) : null,
              PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
                key: name, icon: NW_ICONS[name] ? name : "fallback", title: t("feature." + name),
                summary: t("feature." + name + ".desc"),
                className: name === "semanticEmbedding" ? "nwFeatureModelRow" : "",
                trailing: el("div", { className: "nwFeatureActions" },
                  name === "semanticEmbedding" ? el("button", { type: "button", className: "nwBtn nwBtnGhost nwFeatureModelLink", onClick: function (ev) { ev.stopPropagation(); props.controller.openView("model"); } }, t("model.manage")) : null,
                  el(Switch, { checked: checked, disabled: state.loading, label: t("feature." + name),
                    onChange: function () { props.toggle({ features: (function (patch) { patch[name] = !checked; return patch; })({}) }); } })
                )
              })
            ];
          }) })
        );
      } else if (view === "tools") {
        var toolStorage = [
          { label: t("dir.data"), path: dirs.dataDir || state.dataDir || "", revealKey: "data-dir" },
          { label: t("dir.analysis"), path: dirs.analysisDir || "", revealKey: "analysis-dir" },
          { label: t("dir.audits"), path: dirs.auditsDir || "", revealKey: "audits-dir" },
          { label: t("dir.settings"), path: dirs.settingsDir || "", revealKey: "settings-dir" },
          { label: t("tool.storagePlots"), path: dirs.plotsDir || state.plotsDir || "", revealKey: "plots-dir" },
          { label: t("dir.summaries"), path: dirs.summariesDir || "", revealKey: "summaries-dir" },
          { label: t("lex.pathLabel"), path: dirs.lexiconDir || "", revealKey: "lexicon-dir" }
        ].filter(function (item, idx, items) {
          return !item.path || items.slice(0, idx).every(function (prev) { return prev.path !== item.path; });
        });
        body = el("div", { className: "nwToolsPage" },
          el("div", { className: "nwToolsHint" }, t("panel.toolsHint")),
          toolRows,
          StorageDisclosure(el, el, t, NW_UI, { controller: props.controller, revealing: state.revealing, items: toolStorage })
        );
      } else if (view === "model") {
        body = el("div", { className: "nwModelPage" },
          GroupCard(el, el, t, NW_UI, { children: PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
            key: "engine", icon: "navModel", title: engineStatusText(state.embeddingStatus, t), summary: t("model.localHint")
          }) }),
          SectionTitle(el, el, t, NW_UI, { label: "model.subfeatures" }),
          GroupCard(el, el, t, NW_UI, { children: [
            el("div", { key: "hint", className: "nwModelSubHint" }, t("model.hint")),
            switchRow("semanticSearch", f.semanticSearch !== false, function (n, v) { props.toggle({ features: (function (patch) { patch[n] = v; return patch; })({}) }); }),
            RowDivider(el, el, t, NW_UI, { key: "rd-s1" }),
            switchRow("semanticStyle", f.semanticStyle !== false, function (n, v) { props.toggle({ features: (function (patch) { patch[n] = v; return patch; })({}) }); }),
            RowDivider(el, el, t, NW_UI, { key: "rd-s2" }),
            switchRow("semanticImplicit", f.semanticImplicit !== false, function (n, v) { props.toggle({ features: (function (patch) { patch[n] = v; return patch; })({}) }); })
          ] }),
          StorageDisclosure(el, el, t, NW_UI, { controller: props.controller, revealing: state.revealing, items: [
            { label: t("dir.embedding"), path: dirs.embeddingDir || "", revealKey: "embedding-dir" }
          ] })
        );
      } else if (view === "lexicon") {
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
        body = el("div", { className: "nwLexPage" },
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
      } else if (view === "baseline") {
        // 未选书时优先引导选择；已有错误仍保留在 state，选书后按原逻辑加载。
        if (!state.baselineBook && state.revealErr) msg = null;
        var DEFAULT_TOL = { low: "", high: "" };
        var NW_METRICS = [
          ["complexity"], ["modifierDensity"], ["abstractDensity"],
          ["actionDensity"], ["hedgeDensity"], ["gapIndex"]
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
        // ---- 基线范围（按书 + 按全书/按部分）----
        // 与容差滑块相互独立：容差仍是全局的 styleTolerance，范围走 GET|POST /api/dsh-novel-writer/baseline。
        // 数据形状见契约：{ ok, book, mode(生效档位), chapters(存量的文件名校验后原样回报),
        //                  available[{file,number,title}], smallSample{chapters,tolPct}, missing?, updatedAt }
        // ⚠ 关键：`mode` 是**生效档位**（custom 仅当存储 mode=custom 且 chapters 非空），而 `chapters`
        //    回报的是**存量**——服务端在 mode != custom 时刻意不动 chapters（切按全书 = 这次不用，不是删掉）。
        //    于是「档位=按全书 + 存量非空」是合法状态，必须显式披露且给清空入口，否则用户永远看不到、也删不掉。
        var baseData = state.baseline;
        var baseMode = state.baselineMode === "custom" ? "custom" : "all";
        var baseAvail = baseData && Array.isArray(baseData.available) ? baseData.available : [];
        var baseSel = Array.isArray(state.baselineSel) ? state.baselineSel : [];
        var baseSelSet = {};
        for (var bsi = 0; bsi < baseSel.length; bsi += 1) baseSelSet[baseSel[bsi]] = true;
        var baseMissing = Array.isArray(state.baselineMissing) ? state.baselineMissing : [];
        // 存量（宿主已保存的标杆章）：与生效档位无关，按全书时也可能非空
        var baseStored = baseData && Array.isArray(baseData.chapters) ? baseData.chapters : [];
        var baseDirWarn = baseData && typeof baseData.warning === "string" && baseData.warning !== "" ? baseData.warning : "";
        var baseSmall = baseData && baseData.smallSample && typeof baseData.smallSample === "object" ? baseData.smallSample : null;
        // 小样本阈值：来源唯一（宿主下发）。0 = 宿主没给，不显示提示（不自己编阈值）
        var baseMinCh = baseSmall && typeof baseSmall.chapters === "number" && baseSmall.chapters > 0 ? Math.floor(baseSmall.chapters) : 0;
        var baseMinTol = baseSmall && typeof baseSmall.tolPct === "number" && baseSmall.tolPct > 0 ? Math.floor(baseSmall.tolPct) : 0;
        var baseBookList = props.controller.baselineBookOptions(baseData);
        // /state 里还没有当前书时也把它补进下拉，免得触发器显示成"尚未选择书"而实际已选中
        if (state.baselineBook && baseBookList.indexOf(state.baselineBook) === -1) baseBookList = [state.baselineBook].concat(baseBookList);
        // 章节上百时默认只渲染前 N 章（全选/反选仍作用于全部章节，不受渲染上限影响）
        var BASE_LIST_CAP = 200;
        var baseShown = state.baselineShowAll === true ? baseAvail : baseAvail.slice(0, BASE_LIST_CAP);
        var baseFill = function (key, map) {
          var text = String(t(key));
          for (var fk in map) text = text.split("{" + fk + "}").join(String(map[fk]));
          return text;
        };
        var baseChapterLabel = function (c) {
          var num = c && c.number !== void 0 && c.number !== null && c.number !== "" ? String(c.number) : "";
          var title = c && typeof c.title === "string" && c.title !== "" ? c.title : (c && typeof c.file === "string" ? c.file : "");
          return (num === "" ? "" : baseFill("base.chapterPrefix", { n: num })) + title;
        };
        var baseChapterRow = function (c) {
          var file = c && typeof c.file === "string" ? c.file : "";
          return el("label", { key: "bch-" + file, className: "nwBaseItem", title: file },
            el("input", { type: "checkbox", className: "nwBaseCheck", checked: baseSelSet[file] === true,
              disabled: state.baselineBusy || state.loading,
              onChange: function () { props.controller.baselineToggleChapter(file); } }),
            el("span", { className: "nwBaseItemText" }, baseChapterLabel(c))
          );
        };
        var baseSelText = t("base.selected") + " " + baseSel.length + t("base.selectedUnit");
        var baseCurSummary = baseMode === "all" ? t("base.modeAllSummary") : t("base.modeCustomSummary");
        var baseUpdated = baseData && typeof baseData.updatedAt === "string" && baseData.updatedAt !== ""
          ? "　" + t("base.updatedAt") + " " + baseData.updatedAt.slice(0, 16).replace("T", " ")
          : "";
        var baseSaveBtn = el("button", { key: "base-save", type: "button", className: "nwBtn nwBtnGhost",
          disabled: state.baselineBusy || state.loading || (state.baselineBook || "") === "",
          onClick: function () { props.controller.baselineSave(); } }, t("base.save"));
        // 显式清空入口：**唯一**能真正删掉存量的动作（切按全书保存不会清，服务端刻意保留）。
        // 只在存量非空时出现；二次确认在 controller 里走 window.confirm（与词表页的破坏性操作同一套写法）。
        var baseClearBtn = baseStored.length > 0
          ? el("button", { key: "base-clear", type: "button", className: "nwBtn nwBtnGhost nwBtnSm nwBtnDangerText",
              disabled: state.baselineBusy || state.loading || (state.baselineBook || "") === "",
              onClick: function () { props.controller.baselineClearSaved(); } }, t("base.clearSaved"))
          : null;
        var baseClearRow = baseClearBtn
          ? el("div", { key: "base-clear-row", className: "nwBaseClear" },
              el("div", { className: "nwRowHint", style: { flex: "1", minWidth: "0", marginTop: "0" } },
                baseFill("base.storedCount", { n: baseStored.length }) + " · " + t("base.clearSavedHint")),
              baseClearBtn)
          : null;
        // 保存行：单实例。custom 时它排在挑选区**下方**，all 时直接跟在范围行后面（两种模式都点得到保存）
        var baseSaveRow = el("div", { key: "base-save-row", className: "nwField" },
          el("div", { className: "nwRowText" },
            el("div", { className: "nwRowHint" }, baseCurSummary + baseUpdated + (state.baselineBusy ? "　" + t("base.busy") : ""))),
          el("div", { className: "nwFieldCtl" }, baseSaveBtn)
        );
        // 档位=按全书但存量非空：必须披露（否则用户以为早清掉了，实际还在盘上占着）
        var baseIdleRow = baseMode !== "custom" && baseStored.length > 0
          ? el("div", { key: "base-idle-row", className: "nwField" },
              el("div", { className: "nwRowText" },
                el("div", { className: "nwRowLabel" }, t("base.clearSaved")),
                el("div", { className: "nwRowHint nwNoteWarn" }, baseFill("base.storedIdle", { n: baseStored.length }))),
              el("div", { className: "nwFieldCtl" }, baseClearBtn))
          : null;
        var basePicker = null;
        if (baseMode === "custom") {
          var baseListBody;
          if (state.baselineErr) {
            // 读取失败 ≠ 本书没有章节（与词表页同一条口径：不把失败伪装成空态）
            baseListBody = el("div", { key: "base-empty", className: "nwEmpty" },
              el("div", { className: "nwEmptyTitle" }, t("base.loadFail")),
              el("div", { className: "nwEmptyHint" }, t("base.loadFailHint")));
          } else if (baseAvail.length === 0) {
            baseListBody = el("div", { key: "base-empty", className: "nwEmpty" },
              el("div", { className: "nwEmptyTitle" }, state.baselineBusy ? t("base.busy") : t("base.emptyTitle")),
              el("div", { className: "nwEmptyHint" }, t("base.emptyHint")));
          } else {
            baseListBody = el("div", { key: "base-list", className: "nwBaseList" }, baseShown.map(baseChapterRow));
          }
          basePicker = el("div", { key: "base-picker", className: "nwBasePick" },
            el("div", { className: "nwRowLabel" }, t("base.pickTitle")),
            el("div", { className: "nwRowHint", style: { marginTop: "2px" } }, t("base.pickHint")),
            el("div", { key: "base-acts", className: "nwBtnGroup", style: { marginTop: "8px" } },
              el("button", { key: "all", type: "button", className: "nwBtn nwBtnGhost", disabled: state.baselineBusy || baseAvail.length === 0,
                onClick: function () { props.controller.baselineSelectAll(); } }, t("base.selectAll")),
              el("button", { key: "inv", type: "button", className: "nwBtn nwBtnGhost", disabled: state.baselineBusy || baseAvail.length === 0,
                onClick: function () { props.controller.baselineInvertSel(); } }, t("base.invertSel")),
              el("button", { key: "clr", type: "button", className: "nwBtn nwBtnGhost", disabled: state.baselineBusy || baseSel.length === 0,
                onClick: function () { props.controller.baselineClearSel(); } }, t("base.clearSel"))
            ),
            baseListBody,
            // 章节目录读不出来时宿主给 warning：别让空列表被读成"本书没有章节"
            baseDirWarn !== ""
              ? el("div", { key: "base-dirwarn", className: "nwNote nwNoteWarn", style: { marginTop: "6px" } }, t("base.dirWarn"), el("div", { className: "nwBaseRaw" }, baseDirWarn))
              : null,
            // 已选摘要 + 展开剩余（章节上百时列表只渲染前 N 章）
            el("div", { key: "base-sum", className: "nwRowHint", style: { marginTop: "8px" } },
              baseSelText + "　" + baseFill("base.allChapters", { n: baseAvail.length }) +
              (state.baselineShowAll !== true && baseAvail.length > baseShown.length
                ? "　" + baseFill("base.truncTip", { n: baseShown.length }) : "")),
            (state.baselineShowAll !== true && baseAvail.length > baseShown.length)
              ? el("button", { key: "base-more", type: "button", className: "nwBtn nwBtnGhost", style: { marginTop: "6px" },
                  onClick: function () { props.controller.baselineExpandList(); } },
                  baseFill("base.showRest", { n: baseAvail.length - baseShown.length }))
              : null,
            // 紧挨已选摘要：清空**已保存**的选择（本地「清空」只清勾选草稿，二者语义不同，故分开摆）
            baseClearRow,
            // 小样本提示：宿主明确要求显式呈现——否则用户选 1 章后看到一堆偏差会以为插件坏了
            baseMinCh > 0 && baseMinTol > 0
              ? el("div", { key: "base-small", className: baseSel.length < baseMinCh ? "nwNote nwNoteWarn" : "nwNote", style: { marginTop: "6px" } },
                  (baseSel.length < baseMinCh ? "⚠ " : "") + (baseSel.length < baseMinCh
                    ? baseFill("base.smallSampleNow", { n: baseSel.length, min: baseMinCh, p: baseMinTol })
                    : baseFill("base.smallSample", { n: baseMinCh, p: baseMinTol })))
              : null,
            // 失效选中项（章节被改名/删除）：只提示，保存时按当前 available 过滤掉
            baseMissing.length > 0
              ? el("div", { key: "base-missing", className: "nwNote nwNoteWarn", style: { marginTop: "6px" } }, baseFill("base.missing", { n: baseMissing.length }))
              : null
          );
        }
        body = el("div", null,

          el("div", { className: "nwToolsHint" }, t("baseline.desc")),
          // 范围与容差保留独立保存动作，范围保存为次要按钮。
          GroupCard(el, el, t, NW_UI, { children: [
            PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
              key: "base-book",
              title: t("base.bookLabel"),
              // 宿主里**已保存**的范围（与上面待保存的分段选择区分开：看着改了其实没保存，这行说清）
              summary: !state.baselineBook ? t("base.needBook") : state.baselineBook + "　" + (baseData
                ? (baseData.mode === "custom"
                    ? t("base.mode.custom") + " " + (Array.isArray(baseData.chapters) ? baseData.chapters.length : 0) + t("base.selectedUnit")
                    : t("base.mode.all"))
                : (state.baselineBusy ? t("base.busy") : t("base.loadFail"))),
              trailing: el(SelectMenu, {
                id: "base-book",
                controller: props.controller,
                label: t("base.bookLabel"),
                value: state.baselineBook || "",
                placeholder: t("base.noBook"),
                disabled: state.baselineBusy,
                options: baseBookList.map(function (b) { return { value: b, label: b }; }),
                onChange: function (v) { props.controller.setBaselineBook(v); }
              })
            }),
            RowDivider(el, el, t, NW_UI, { key: "base-rd1" }),
            PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
              key: "base-mode",
              title: t("base.modeLabel"),
              summary: t("base.modeHint"),
              trailing: el(NW_UI.SegmentedControl, {
                label: t("base.modeLabel"),
                value: baseMode,
                disabled: state.baselineBusy,
                options: [
                  { value: "all", label: t("base.mode.all") },
                  { value: "custom", label: t("base.mode.custom") }
                ],
                onChange: function (next) { if (baseMode !== next) props.controller.setBaselineMode(next); }
              })
            }),
            baseIdleRow ? RowDivider(el, el, t, NW_UI, { key: "base-rd-idle" }) : null,
            baseIdleRow,
            baseMode === "custom" ? RowDivider(el, el, t, NW_UI, { key: "base-rd2" }) : null,
            baseMode === "custom" ? basePicker : null,
            RowDivider(el, el, t, NW_UI, { key: "base-rd3" }),
            baseSaveRow
          ] }),
          !state.baselineBook ? el("div", { className: "nwEmpty" }, el("div", { className: "nwEmptyTitle" }, t("base.needBook"))) : null,
          SectionTitle(el, el, t, NW_UI, { label: "base.toleranceTitle" }),
          el("div", { className: "nwToolsHint" }, t("base.toleranceHint")),
          GroupCard(el, el, t, NW_UI, { children:
            NW_METRICS.map(function (item) {
              var mk2 = item[0];
              var d = draft[mk2] || DEFAULT_TOL;
              var input = function (field) {
                return el("label", { className: "nwBaseTolField" },
                  el("span", { className: "nwBaseTolLabel" }, t("baseline." + field)),
                  el("span", { className: "nwBaseTolControl" },
                    el("input", { type: "number", className: "nwTolInput", "aria-label": t("base.metric." + mk2) + " · " + t("baseline." + field), placeholder: t("tol.recommend"), value: d[field], min: 0, max: 99, disabled: state.loading, onChange: function (ev) { setDraft(mk2, field, ev.target.value); } }),
                    el("span", { className: "nwBaseTolUnit" }, "%")));
              };
              return el("div", { className: "nwBaseTolRow", key: mk2 },
                el("div", { className: "nwBaseTolName" }, t("base.metric." + mk2),
                  el(NW_UI.Tooltip, { label: t("base.help." + mk2) }, el("button", { type: "button", className: "nwBaseHelp", "aria-label": t("base.help." + mk2), title: t("base.help." + mk2) }, "?"))),
                input("low"), input("high"));
            })
          }),
          el("div", { className: "nwBaseActions" },
            el("button", { type: "button", className: "nwBtn nwBtnPrimary" + (state.baselineSaved ? " nwBtnDone" : ""), disabled: state.loading, onClick: saveTol }, state.baselineSaved ? t("baseline.saved") : t("baseline.save")),
            el("button", { type: "button", className: "nwBtn nwBtnGhost", disabled: state.loading, onClick: resetTol }, t("baseline.reset"))
          ),
          StorageDisclosure(el, el, t, NW_UI, { controller: props.controller, revealing: state.revealing, items: [
            { label: t("base.storage"), path: dirs.dataDir || state.dataDir || "", revealKey: "data-dir" },
            { label: t("dir.stateFile"), path: dirs.stateFile || state.file || "", revealKey: "state-file" }
          ] })
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
        // 后端按目录分组；此处只重排展示，不更改文件名或读取请求。
        var reportBooks = (state.books || []).slice().sort(function (a, b) { return b.length - a.length; });
        var reportInfo = function (f) {
          var stem = String(f.file || "").replace(/\.json$/i, "");
          var book = "";
          for (var ri = 0; ri < reportBooks.length; ri += 1) {
            if (stem === reportBooks[ri] || stem.indexOf(reportBooks[ri] + "-") === 0 || stem.indexOf(reportBooks[ri] + "__") === 0) { book = reportBooks[ri]; break; }
          }
          var match = stem.match(/^(.*?)(__base-full|-chapters-metrics|-full|-keywords-.+)$/);
          if (!book && match && match[1]) book = match[1];
          var tail = book ? stem.slice(book.length).replace(/^-/, "") : stem;
          var label = f.label || stem, hash = "";
          if (/^__base-full$/.test(tail)) label = t("reports.name.baseline");
          else if (/^chapters-metrics$/.test(tail)) label = t("reports.name.chapters");
          else if (/^full$/.test(tail)) label = t("reports.name.full");
          else if (/^keywords-.+$/.test(tail)) label = t("reports.name.keywords");
          else if (/^[a-f0-9]{6,}$/i.test(tail)) { label = t("reports.name.segment"); hash = tail.slice(0, 6); }
          return { book: book || t("reports.unassigned"), label: label, hash: hash, source: f };
        };
        var groups = [];
        (state.reportsGroups || []).forEach(function (sourceGroup) {
          (sourceGroup.files || []).forEach(function (file) {
            var info = reportInfo(file);
            var group = groups.filter(function (g) { return g.name === info.book; })[0];
            if (!group) { group = { name: info.book, files: [] }; groups.push(group); }
            group.files.push(info);
          });
        });
        var totalFiles = groups.reduce(function (a, g) { return a + (g.files || []).length; }, 0);
        var reportsLoading = state.reportsGroups === null && !state.reportsError;
        body = el("div", null,
          el("div", { className: "nwToolsHint" }, t("reports.hint")),
          state.reportContent ? el("div", null,
            el("button", { type: "button", className: "nwBtn nwBtnGhost", onClick: function () { props.controller.set({ reportContent: null }); } }, t("reports.back")),
            el("pre", { className: "nwReportsBody", tabIndex: 0 }, state.reportContent))
          : el("div", null,
              reportsLoading ? el("div", { className: "nwEmpty" }, t("reports.loading2")) : (totalFiles === 0 && !state.reportsError) ? el("div", { className: "nwEmpty" }, t("reports.empty")) : null,
              groups.map(function (g) {
                return el("div", { key: g.name, className: "nwReportsGroup" }, GroupCard(el, el, t, NW_UI, { children: [
                  el("div", { key: "head", className: "nwReportsHead" }, el("span", null, g.name), CountBadge(el, el, t, NW_UI, { label: String(g.files.length) })),
                  g.files.map(function (info) {
                    var f = info.source;
                    // v6.8.0：行本身不再是 <button>（按钮里不能再放按钮），改为「打开 / 日期 / 删除」三段；
                    // 删除走回收站，且只有确认框里那一个文件名，避免删错相邻行。
                    return el("div", { key: f.file, className: "nwReportsFile", title: f.file },
                      el("button", { type: "button", className: "nwReportsOpen", title: f.file, onClick: function () { openReport(f.file); } },
                        el("span", { className: "nwReportsLabel" }, info.label, info.hash ? el("span", { className: "nwReportsHash" }, info.hash) : null)),
                      el("span", { className: "nwReportsDate" }, (f.time || "").slice(0, 16).replace("T", " ")),
                      // v6.8.0 修正：这里曾用自造的纯文字按钮（.nwRowAction），在宿主 button reset 下被 flex 压成
                      // 一字一行、还撑高了整行。改用面板里已验证的行尾按钮写法（词表页同款），并由 CSS 兜底不参与收缩。
                      el("button", {
                        type: "button",
                        className: "nwBtn nwBtnGhost nwBtnSm nwBtnDangerText",
                        title: t("reports.delete") + " " + f.file,
                        disabled: state.reportDeleting === f.file,
                        onClick: function () { props.controller.deleteReport(f.file); }
                      }, t("reports.delete")));
                  })
                ] }));
              })),
          StorageDisclosure(el, el, t, NW_UI, { controller: props.controller, revealing: state.revealing, items: [
            { label: t("dir.analysis"), path: dirs.analysisDir || "", revealKey: "analysis-dir" },
            { label: t("reports.storage"), path: dirs.dataDir || state.dataDir || "", revealKey: "data-dir" }
          ] })
        );
      } else if (view === "creation" || view === "creation-form") {
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
                (isDefault || !hasProfile) ? null : el("button", { type: "button", className: "nwBtn nwBtnGhost nwBtnSm nwBtnDangerText", onClick: function () { if (!window.confirm(t("creation.confirmDelete"))) return; var patch = {}; patch[name] = null; props.toggle({ creationProfiles: patch }); props.controller.set({ revealMsg: t("creation.deleted"), revealErr: false }, { silent: true }); } }, t("creation.delete")),
                el("button", { type: "button", className: "nwChip", onClick: function () { props.controller.set({ creationBook: name, creationDraft: null, creationDirty: false }, { silent: true }); props.controller.openView("creation-form"); } }, t("creation.edit") + " ›"))
            });
          }
          var creationRows = [bookRow("", cpGlobal, true)];
          allBooks.forEach(function (name, i) {
            creationRows.push(RowDivider(el, el, t, NW_UI, { key: "creation-div-" + i }));
            creationRows.push(bookRow(name, profileOf(name), false, Object.prototype.hasOwnProperty.call(cpBooks, name)));
          });
          body = el("div", { className: "nwCreationPage" },
            el("div", { className: "nwToolsHint" }, t("creation.desc2")),
            el("div", { className: "nwCreationNew" },
              el("input", { id: "nwNewBookInput", type: "text", value: newBookName, placeholder: t("creation.newPlaceholder"), "aria-label": t("creation.newPlaceholder"), className: "nwTextInput" + (state.creationNameBad ? " nwInputErr" : ""), onInput: function (ev) { props.controller.set({ creationNewBook: ev.target.value, creationNameBad: false }, { silent: true }); }, onKeyDown: function (ev) { if (ev.key === "Enter") { ev.preventDefault(); createNewBook(); } } }),
              el("button", { type: "button", className: "nwBtn nwBtnPrimary", onClick: createNewBook }, t("creation.new"))),
            GroupCard(el, el, t, NW_UI, { children: creationRows }),
            StorageDisclosure(el, el, t, NW_UI, { controller: props.controller, revealing: state.revealing, items: [
              { label: t("creation.pathLabel"), path: dirs.stateFile || state.file || "", revealKey: "state-file" }
            ] })
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
            if (!window.confirm(t("creation.confirmClear"))) return;
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
          var switchOpts = [{ value: "", label: t("creation.default") }];
          for (var si4 = 0; si4 < allBooks.length; si4 += 1) {
            var bn = allBooks[si4];
            switchOpts.push({ value: bn, label: bn });
          }
          // v4.0.0 修正：新建书尚未保存时不在 allBooks 中，需临时补进下拉——否则受控选择器显示不出当前正在编辑的书
          if (curBook !== "" && allBooks.indexOf(curBook) === -1) {
            switchOpts.push({ value: curBook, label: curBook });
          }
          body = el("div", { className: "nwCreationPage" },
            el("button", { type: "button", className: "nwCreationBack", onClick: function () {
              if (state.creationDirty && !window.confirm(t("creation.dirtyWarn"))) return;
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
                el("textarea", { id: "creation-" + cf4, "aria-describedby": "creation-help-" + cf4, className: "nwCreationInput nwTextArea", value: formDraft[cf4] || "", rows: 2, placeholder: item[3], onInput: function (ev) { setFormDraft(cf4, ev.target.value); } }));
            }) }),
            el("div", { className: "nwCreationActions" },
              el("button", { type: "button", className: "nwBtn nwBtnPrimary", onClick: saveForm }, t("creation.save")),
              el("button", { type: "button", className: "nwBtn nwBtnGhost", onClick: clearForm }, t("creation.clear")))
          );
        }
      } else if (view === "diagnose") {
        // v6.6.0：诊断报告（只读）。
        // 展示口径：直接用接口给的 report（宿主分享层渲染，与 novel_diagnose 同一实现），
        // 面板**不重拼报告**；状态量 pill 与 issues 行都取结构化字段，纯展示、不改写。
        var diagData = state.diag;
        var diagDays = state.diagDays || "7";
        var diagCalls = diagData && diagData.calls && typeof diagData.calls === "object" ? diagData.calls : null;
        var diagIssues = diagData && Array.isArray(diagData.issues) ? diagData.issues : [];
        var diagReport = diagData && typeof diagData.report === "string" ? diagData.report : "";
        // {n} 占位符替换（与基线页 baseFill 同口径；缺键时 t() 返回键名，替换后仍是可读文案）
        var diagFill = function (key, map) {
          var text = String(t(key));
          for (var fk in map) text = text.split("{" + fk + "}").join(String(map[fk]));
          return text;
        };
        // 级别 → 既有语义色类（error=label-error / warn=state-warn-label / info=label-dimmed），不新增组件
        var diagLevelCls = function (level) {
          return level === "error" ? "nwNote nwPlotErr" : level === "warn" ? "nwNote nwNoteWarn" : "nwNote";
        };
        var diagLevelKey = function (level) {
          return level === "error" ? "diag.level.error" : level === "warn" ? "diag.level.warn" : "diag.level.info";
        };
        body = el("div", null,

          el("div", { className: "nwToolsHint" }, t("diag.desc")),
          GroupCard(el, el, t, NW_UI, { children: [
            PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
              key: "diag-window",
              icon: "navDiagnose",
              title: t("diag.windowLabel"),
              summary: t("diag.windowHint"),
              trailing: el(NW_UI.SegmentedControl, {
                label: t("diag.windowLabel"),
                value: diagDays,
                disabled: state.diagBusy,
                options: ["1", "7", "30"].map(function (d) { return { value: d, label: d + " " + t("diag.daysUnit") }; }),
                onChange: function (next) { if (next !== diagDays) props.controller.setDiagDays(next); }
              })
            }),
            RowDivider(el, el, t, NW_UI, { key: "diag-rd-calls" }),
            el("div", { key: "diag-calls", className: "nwPillRow" },
              el("div", { className: "nwPill" },
                el("span", { className: "nwPillKey" }, t("diag.callsTotal")),
                el("span", { className: "nwPillVal" }, diagCalls ? String(diagCalls.total || 0) : "—")
              ),
              el("div", { className: "nwPill" },
                el("span", { className: "nwPillKey" }, t("diag.callsDegraded")),
                el("span", { className: "nwPillVal" }, diagCalls ? String(diagCalls.degraded || 0) : "—")
              ),
              el("div", { className: "nwPill" },
                el("span", { className: "nwPillKey" }, t("diag.callsFailed")),
                el("span", { className: "nwPillVal" }, diagCalls ? String(diagCalls.failed || 0) : "—")
              )
            )
          ] }),
          diagIssues.length > 0 ? GroupCard(el, el, t, NW_UI, { children: [
            el("div", { key: "heading", className: "nwDiagHeading" }, t("diag.issues")),
            el("div", { key: "issues", className: "nwDiagAttentionList" }, diagIssues.map(function (it, i) {
              var level = it && it.level === "error" ? "error" : it && it.level === "warn" ? "warn" : "info";
              var title = it && typeof it.title === "string" && it.title !== "" ? it.title : String(t(diagLevelKey(level)));
              return el("div", { key: "diag-issue-" + i, className: "nwDiagAttentionItem" },
                el("div", { className: diagLevelCls(level) }, title),
                it && it.detail ? el("div", { className: "nwDiagDetail" }, it.detail) : null,
                it && it.suggestion ? el("div", { className: "nwDiagDetail" }, t("diag.suggestion") + "：" + it.suggestion) : null);
            }))
          ] }) : null,
          diagReport !== ""
            ? el("pre", { key: "diag-report", className: "nwDiagReport", tabIndex: 0 }, diagReport)
            : el("div", { key: "diag-empty", className: "nwEmpty" },
                state.diagBusy ? t("diag.busy") : state.diagErr ? t("diag.loadFailHint") : diagFill("diag.emptyHint", { n: diagDays })),
          state.diagManual
            ? el("div", { key: "diag-manual", className: "nwNote nwNoteWarn" }, t("diag.manual"))
            : null,
          el("div", { className: "nwBaseActions" },
            el("button", { type: "button", className: "nwBtn nwBtnPrimary", disabled: state.diagBusy, onClick: function () { props.controller.loadDiagnose(); } },
              state.diagBusy ? t("diag.busy") : (diagData ? t("diag.refresh") : t("diag.run"))),
            el("button", { type: "button", className: "nwBtn nwBtnGhost", disabled: state.diagBusy || diagReport === "", onClick: function () { props.controller.diagCopy(); } }, t("diag.copy"))
          )
        );
      } else if (view === "trash") {
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
        for (var ti = 0; ti < trashEntries.length; ti += 1) {
          var trashItem = trashEntries[ti];
          var trashMeta = String(t("trash.line")).replace("{files}", String(trashItem.files)).replace("{size}", formatSize(trashItem.bytes));
          if (trashItem.restorable !== true) trashMeta += " · " + t("trash.noManifest");
          if (ti > 0) trashBody.push(RowDivider(el, el, t, NW_UI, { key: "rd-trash-" + trashItem.id }));
          trashBody.push(PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
            key: trashItem.id,
            icon: "trash",
            title: trashItem.book === "" ? trashItem.id : trashItem.book,
            summary: trashMeta,
            trailing: el("div", { className: "nwFeatureActions" },
              el("button", { key: "restore", type: "button", className: "nwRowAction", disabled: state.trashBusyId !== "" || trashItem.restorable !== true, onClick: function () { props.controller.trashRestore(trashItem.id); } }, t("trash.restore")),
              el("button", { key: "purge", type: "button", className: "nwRowAction nwRowActionDanger", disabled: state.trashBusyId !== "", onClick: function () { props.controller.trashPurge(trashItem.id); } }, t("trash.purge")))
          }));
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
              : t("del.selCount").replace("{n}", String(deleteSelectedCount())).replace("{m}", String((state.delPlan && Array.isArray(state.delPlan.targets) ? state.delPlan.targets.filter(function (x) { return x.exists && x.files > 0; }).length : 0))),
            trailing: el("button", { key: "back", type: "button", className: "nwRowAction", onClick: function () { props.controller.deleteClose(); } }, t("del.pickBack"))
          }));
          pickChildren.push(RowDivider(el, el, t, NW_UI, { key: "rd-del-head" }));
          pickChildren.push(el("div", { key: "block", className: "nwPageBlock" }, deleteBlockRows()));
          // 动作行也要 16px 内边距（nwBaseActions 只给上下 margin，直接放在卡片里会贴到右边缘）
          pickChildren.push(el("div", { key: "actions", className: "nwBaseActions nwPageBlock" },
            state.delResult
              ? el("button", { key: "close", type: "button", className: "nwBtn", onClick: function () { props.controller.deleteClose(); } }, t("del.close"))
              : null,
            state.delResult
              ? null
              : el("button", { key: "ok", type: "button", className: "nwBtn nwBtnDanger", disabled: !deleteCanApply(), onClick: function () { props.controller.deleteApply(); } }, state.delBusy ? t("del.busy") : t("del.confirm")),
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
        body = el("div", null,
          el("div", { className: "nwSection" },
            SectionTitle(el, el, t, NW_UI, { label: state.delBook !== "" ? "del.sectionPreview" : "del.sectionPick" }),
            GroupCard(el, el, t, NW_UI, { children: pickChildren })),
          el("div", { className: "nwSection" },
            SectionTitle(el, el, t, NW_UI, { label: "trash.entry" }),
            GroupCard(el, el, t, NW_UI, { children: trashBody })));
      } else {
        var onFeatures = detailFeatures.filter(function (k) { return f[k] !== false; }).length;
        // v4.0.0 修正：计数与工具页渲染同源（TOOL_GROUPS）；宿主清单里的 novel_sentence_config
        // 没有 UI 行（宿主写路径会剥离该键），按宿主全清单计数会出现"开着的比行数多"的错位
        // v6.3.0 更正：上面这两个数字原先写成 15/16，是 v5.0.0 之前的旧值，与实现不符
        // v6.6.0 更正（由客户端实现者指出这三个数字已随版本失真，协调方补）：
        //   当前 TOOL_GROUPS 共 **19** 行（= 20 个工具减去无 UI 行的 novel_sentence_config），
        //   宿主全清单 **20** 项。数字**不要写死**——它们随每次加工具而变化，写死必然再次失真；
        //   这里只记录"为什么两者不等"这个**关系**，具体数量由 TOOL_GROUPS 现算（见下方 onTools）。
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
          if (!isNaN(lastOkAt.getTime())) updateFailedText = t("update.failedLast").replace("{time}", lastOkAt.toLocaleString(isEn ? "en-US" : "zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }));
        }
        var allTools = TOOL_GROUPS.reduce(function (acc, group) { return acc.concat(group.tools); }, []);
        var knownLexiconCount = state.lexicon && Array.isArray(state.lexicon.entries) ? state.lexicon.entries.length : null;
        var knownReportCount = Array.isArray(state.reportsGroups) ? state.reportsGroups.reduce(function (n, group) { return n + (Array.isArray(group.files) ? group.files.length : 0); }, 0) : null;
        var stats = state.booksStats;
        var statsTotal = (stats || []).reduce(function (acc, book) { acc.chapters += Number(book.chapters) || 0; acc.chars += Number(book.chars) || 0; return acc; }, { chapters: 0, chars: 0 });
        var statsSummary = stats === null ? t("stats.pending") : t("home.librarySummary").replace("{books}", (stats || []).length).replace("{chapters}", statsTotal.chapters).replace("{chars}", fmtChars(statsTotal.chars));
        var openReports = function () {
            props.controller.set({ reportsGroups: null, reportsError: false, reportContent: null }, { silent: true });
            // v6.8.0：拉取逻辑移进 controller（删除单份报告后要用同一份重拉，避免两处各写一遍）
            props.controller.loadReports();
            props.controller.openView("reports");
        };
        var runDemo = function () {
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
        };
        var masterRow = PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
          key: "row-master", icon: "master", title: t("panel.enabled"), summary: t("panel.enabledHint"),
          switchOn: state.enabled, switchDisabled: state.loading, switchLabel: t("panel.enabled"),
          switchOnChange: function (value) { props.toggle({ enabled: value }); }
        });
        var aiRows = [
          PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
            key: "row-autoAnalyze", icon: "autoAnalyze", title: t("panel.autoAnalyze"), summary: t("panel.autoAnalyzeHint"),
            switchOn: state.autoAnalyze, switchDisabled: state.loading, switchLabel: t("panel.autoAnalyze"),
            switchOnChange: function (value) { props.toggle({ autoAnalyze: value }); }
          }),
          RowDivider(el, el, t, NW_UI, { key: "rd-auto" }),
          PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
            key: "row-lean", icon: "lean", title: t("panel.leanWorkflow"), summary: t("panel.leanWorkflowHint"),
            switchOn: state.leanWorkflow === true, switchDisabled: state.loading, switchLabel: t("panel.leanWorkflow"),
            switchOnChange: function (value) { props.toggle({ leanWorkflow: value }); }
          }),
          RowDivider(el, el, t, NW_UI, { key: "rd-prompt" }),
          PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
            key: "row-prompt", className: "nwPromptRow", icon: "prompt", title: t("panel.spMode"), summary: t("panel.spModeHint"),
            trailing: el(NW_UI.SegmentedControl, {
              label: t("panel.spMode"), value: state.systemPromptMode, disabled: state.loading,
              options: ["off", "brief", "full"].map(function (m) { return { value: m, label: t("sp." + m) }; }),
              onChange: function (m) { if (state.systemPromptMode !== m) props.toggle({ systemPromptMode: m }); }
            })
          })
        ];
        if (state.systemPromptMode === "full") {
          aiRows.push(RowDivider(el, el, t, NW_UI, { key: "rd-scene" }),
            PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
              key: "row-scene", className: "nwPromptRow", icon: "scene", title: t("panel.spScene"), summary: t("panel.spSceneHint"),
              trailing: el(NW_UI.SegmentedControl, {
                label: t("panel.spScene"), value: state.promptScene || "general", disabled: state.loading,
                options: ["general", "writing", "revising", "auditing", "setup"].map(function (scene) { return { value: scene, label: t("sc." + scene) }; }),
                onChange: function (scene) { if ((state.promptScene || "general") !== scene) props.toggle({ promptScene: scene }); }
              })
            }));
        }
        body = el("div", { className: "nwHome" },
          updateCheck && !updateFailed && updateCheck.updateAvailable && updateCheck.releaseUrl
            ? el("a", { className: "nwNote nwNoteAccent nwUpdateBar", href: updateCheck.releaseUrl, target: "_blank", rel: "noopener noreferrer" }, t("update.title") + " v" + updateCheck.latestVersion + " · " + t("update.go")) : null,
          GroupCard(el, el, t, NW_UI, { children: masterRow }),
          el("div", { className: "nwSection" },
            SectionTitle(el, el, t, NW_UI, { label: "home.writing" }),
            GroupCard(el, el, t, NW_UI, { children: [
              entry(t("panel.creationTitle"), t("panel.creationHint"), null, "creation"),
              RowDivider(el, el, t, NW_UI, { key: "rd-creation" }),
              entry(t("lex.title"), t("lex.navHint"), knownLexiconCount, "lexicon"),
              RowDivider(el, el, t, NW_UI, { key: "rd-lex" }),
              entry(t("panel.baselineTitle"), t("panel.baselineHint"), null, "baseline"),
              RowDivider(el, el, t, NW_UI, { key: "rd-trash-nav" }),
              // v6.8.1：删书入口提到首页**第一个分区**——原来的入口藏在下面这个书库折叠区里，
              // 用户实测翻不到；这里给一行导航 + 独立页面（含回收站），书库行上的按钮仍保留作快捷方式。
              entry(t("del.title"), t("del.navHint"), Array.isArray(state.trashList) ? state.trashList.length : null, "trash"),
              el("details", { key: "library", className: "nwLibrary" },
                el("summary", { className: "nwDisclosureTitle" }, statsSummary, el("span", { className: "nwDisclosureArrow", "aria-hidden": true }, "›")),
                el("div", { className: "nwLibraryBooks" }, (stats || []).length === 0 ? el("div", { className: "nwMuted" }, stats === null ? t("stats.pending") : t("stats.empty")) : stats.map(function (book) {
                  return el("div", { key: book.name, className: "nwLibraryBook" },
                    el("div", { className: "nwLibraryName" }, book.name),
                    el("div", { className: "nwLibraryMeta" }, book.chapters + " " + t("stats.chapters") + " · " + fmtChars(book.chars) + t("stats.chars")),
                    book.recent7Chars > 0 ? null : el("span", { className: "nwLibraryIdle" }, t("stats.idle")),
                    // v6.8.0：按书删除的入口就放在这本书旁边——用户原来要自己翻多个目录逐项清理（issue #2）
                    el("button", { key: "del", type: "button", className: "nwBtn nwBtnSm nwBtnDangerText nwLibraryDel", onClick: function () { props.controller.deleteOpen(book.name); } }, t("del.entry")));
                })))
            ] })),
          el("div", { className: "nwSection" },
            SectionTitle(el, el, t, NW_UI, { label: "home.ai" }),
            GroupCard(el, el, t, NW_UI, { children: aiRows })),
          el("div", { className: "nwSection" },
            SectionTitle(el, el, t, NW_UI, { label: "home.features" }),
            GroupCard(el, el, t, NW_UI, { children: [
              entry(t("panel.featuresTitle"), t("panel.featuresHint"), onFeatures + "/" + detailFeatures.length, "features"),
              RowDivider(el, el, t, NW_UI, { key: "rd-features" }),
              entry(t("panel.toolsTitle"), t("panel.toolsHint"), onTools + "/" + allTools.length, "tools"),
              RowDivider(el, el, t, NW_UI, { key: "rd-tools" }),
              entry(t("model.title"), t("home.modelHint").replace("{status}", engineStatusText(state.embeddingStatus, t)), null, "model")
            ] })),
          el("div", { className: "nwSection" },
            SectionTitle(el, el, t, NW_UI, { label: "home.maintenance" }),
            GroupCard(el, el, t, NW_UI, { children: [
              entry(t("reports.title"), t("reports.hint"), knownReportCount, "reports", openReports),
              RowDivider(el, el, t, NW_UI, { key: "rd-reports" }),
              entry(t("diag.title"), t("diag.navHint"), null, "diagnose"),
              RowDivider(el, el, t, NW_UI, { key: "rd-diagnose" }),
              entry(state.demoLoading ? t("demo.loading") : t("demo.run"), t("demo.hint"), null, "demo", runDemo, state.demoLoading),
              state.demoReport ? el("pre", { key: "demo-report", className: "nwBoxed nwReportPre nwDemoReport" }, state.demoReport) : null
            ] })),
          el("div", { className: "nwSection" },
            SectionTitle(el, el, t, NW_UI, { label: "home.advanced" }),
            GroupCard(el, el, t, NW_UI, { children: PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
              key: "row-raw", icon: "danger", tone: "danger",
              title: el("span", null, el("span", { className: "nwAgeTag" }, "18+"), t("feature.rawWriting")),
              summary: t("home.rawHint"),
              bottom: f.rawWriting === true ? el("div", { className: "nwNote nwNoteWarn" }, t("home.rawWarning")) : null,
              switchOn: f.rawWriting === true, switchDisabled: state.loading, switchLabel: t("feature.rawWriting"),
              switchOnChange: function (value) { props.controller.rawToggle(value); }
            }) })),
          StorageDisclosure(el, el, t, NW_UI, { controller: props.controller, revealing: state.revealing, items: [
            { label: t("dir.data") + " · " + formatSize(state.dataDirSize), path: dirs.dataDir || state.dataDir || "", revealKey: "data-dir" },
            { label: t("dir.stateFile"), path: dirs.stateFile || state.file || "", revealKey: "state-file" }
          ] }),
          updateCheck ? el("div", { key: "updateStale", className: "nwUpdateStale" }, updateFailed ? updateFailedText : t("home.updateChecked")) : null
        );
      }
      /**
       * v6.8.1：删除的「预览 / 执行结果」区块 —— **弹窗与独立删除页共用同一份**。
       * 为什么抽出来：v6.8.0 只把它放在弹窗里，进场藏在书库折叠区的按钮后面，用户实测找不到；
       * 改成独立页面后若两处各写一份，「勾选才可点」「失败项怎么显示」这些判断迟早分叉。
       */
      function deleteBlockRows() {
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
          if ((dr.remaining?.files ?? 0) > 0) rows.push(el("div", { key: "remain", className: "nwNote nwNoteWarn" }, fill("del.remaining", { n: String(dr.remaining.files) })));
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
            var pickable = (plan.targets || []).filter(function (target) { return target.exists && target.files > 0; });
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
      function deleteCanApply() {
        var sel = state.delSel || {};
        var any = Object.keys(sel).some(function (k) { return sel[k] === true; });
        return any && state.delAck === true && !state.delBusy && !state.delLoading && !!state.delPlan && state.delPlan.blocked !== true && state.delPlan.found === true;
      }
      /** 已勾选几处（页面标题里用，避免"选了几处"要自己数） */
      function deleteSelectedCount() {
        var sel = state.delSel || {};
        return Object.keys(sel).filter(function (k) { return sel[k] === true; }).length;
      }
      // 非净化模式弹窗（确认 + 倒计时 / 承诺输入）
      if (state.rawModal) {
        body = DialogCard(el, el, t, NW_UI, {
          title: t("raw.confirmTitle"),
          description: t("raw.confirmText"),
          footer: [
            el("button", { key: "ok", type: "button", className: "nwBtn", disabled: state.rawCountdown > 0, onClick: function () { props.controller.rawConfirm(); } },
              state.rawCountdown > 0 ? t("raw.confirmWait") + " (" + state.rawCountdown + "s)" : t("raw.confirmOk")),
            el("button", { key: "cancel", type: "button", className: "nwBtn", onClick: function () { props.controller.rawCancel(); } }, t("raw.cancel"))
          ]
        });
      } else if (state.rawPromiseOpen) {
        body = DialogCard(el, el, t, NW_UI, {
          title: t("raw.promiseTitle"),
          description: t("raw.promiseText"),
          children: el("input", { key: "promise", type: "text", className: "nwModalInput", value: state.rawPromiseText || "", placeholder: t("raw.promisePlaceholder"), onChange: function (e) { props.controller.rawSetPromise(e.target.value); } }),
          footer: [
            el("button", { key: "ok", type: "button", className: "nwBtn" + (state.rawPromiseOk ? " nwBtnDanger" : ""), disabled: !state.rawPromiseOk, onClick: function () { props.controller.rawPromiseConfirm(); } }, t("raw.promiseOk")),
            el("button", { key: "cancel", type: "button", className: "nwBtn", onClick: function () { props.controller.rawCancel(); } }, t("raw.cancel"))
          ]
        });
      } else if (state.delOpen) {
        // 书库行上的快捷入口：内容与独立删除页完全同源（deleteBlockRows / deleteCanApply）
        body = DialogCard(el, el, t, NW_UI, {
          title: t("del.title"),
          description: state.delBook === "" ? "" : "《" + state.delBook + "》",
          children: deleteBlockRows(),
          footer: state.delResult
            ? [el("button", { key: "close", type: "button", className: "nwBtn", onClick: function () { props.controller.deleteClose(); } }, t("del.close"))]
            : [
                el("button", { key: "ok", type: "button", className: "nwBtn nwBtnDanger", disabled: !deleteCanApply(), onClick: function () { props.controller.deleteApply(); } }, state.delBusy ? t("del.busy") : t("del.confirm")),
                el("button", { key: "cancel", type: "button", className: "nwBtn", onClick: function () { props.controller.deleteClose(); } }, t("del.cancel"))
              ]
        });
      }
      return el("div", { className: "nwPanel" + (props.variant === "main" ? " nwPanelMain" : "") },
        el("div", { className: "nwPanelHeader" },
          el("div", { className: "nwHeaderIdentity" },
            view === "main" ? el("div", { className: "nwPanelTitle" }, t("panel.title")) : backBtn(),
            view === "main"
              ? el("span", { className: "nwHeaderStatus" + (on ? " nwHeaderStatusOn" : "") }, "● " + t(on ? "status.enabled" : "status.disabled"))
              : el("div", { className: "nwHeaderPage" }, view === "features" ? t("panel.featuresTitle") : view === "tools" ? t("panel.toolsTitle") : view === "baseline" ? t("panel.baselineTitle") : view === "creation" ? t("panel.creationTitle") : view === "creation-form" ? t("creation.formTitle") : view === "reports" ? t("reports.title") : view === "lexicon" ? t("lex.title") : view === "diagnose" ? t("diag.title") : view === "trash" ? t("del.title") : t("model.title"))),
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
          // v6.3.0 修复：同族插件（dsh-ssh / task-board）都派发在 document 上，而本插件的互斥监听是
          // document.addEventListener（非捕获）。CustomEvent 默认 bubbles:false，派发在 documentElement
          // 上时冒泡阶段到不了 document → 本插件自己派发的激活事件永远没人收到（包括它自己）。
          if (!wasOpen) document.dispatchEvent(new CustomEvent("dsh-panel-activate", { detail: "novel-writer" }));
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
            // 书库根诊断（初始加载同样接入，与 refresh 路径一致）
            root: remote.root || "",
            rootSource: remote.rootSource || "",
            rootWarning: remote.rootWarning || null,
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
        // Either seat can be declared last; retry when either one changes.
        ["sidebar.panellist", "main"].forEach(function (name) {
          try {
            var stopWatch = ctx.slots.subscribe(name, function () { tryOfficialPanel(); });
            if (typeof stopWatch === "function") disposers.push(stopWatch);
          } catch { /* 订阅不可用：保留旧 UI */ }
        });
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
          unmountLegacyEntry();
          unmountLegacyPanel();
          for (var i = 0; i < disposers.length; i += 1) {
            try { disposers[i](); } catch { /* ignore */ }
          }
          if (typeof localeSub === "function") { try { localeSub(); } catch { /* ignore */ } }
          applied = false;
        };
      }, "dsh-novel-writer: ui");
    }
    exports.apply = apply;
    exports.inject = inject;
    // v4.3.0：Node 侧探针钩子——宿主只消费 apply/inject，此对象不参与运行时；
    // 用于对纯逻辑（超时封装 / i18n 词条表）做真实断言，无需构建步骤即可测到模块私有函数
    // v6.3.0：原先这里导出 6 个纯逻辑函数（fetchWithTimeout / makeTimeoutSignal / errorText /
    // dictionary / t / FETCH_TIMEOUT_MS）供测试断言，但全仓 grep 无任何引用——测试只用下面 apply()
    // 里另挂的 tryOfficialPanel。按项目自己的「零消费者即删」标准清掉，避免留下"注释说供测试、
    // 实际没人用"的空头契约。将来要断言这些私有函数时，请连同真正的断言一起加回来。
    exports.__internals = {};
    return module.exports;
  }
});
