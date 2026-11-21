    // ---- 官方原语适配层（v5.5.0）----
    // 第三方插件（@linxin666/dsh-client-ui-market 等 6 个）同样直接 require 官方 primitives，
    // 且都未声明 dsh.client.external —— 该包属客户端基线模块；这里仍包 try/catch，取不到即回退。
/* ===== B：官方原语适配层（v5.5.0 · @deepseek-ai/dsh-client-ui-primitives → 自绘回退） =====
 * 插入位置：client.js 的 factory 内、`let react = require("react");` 之后（任意组件定义之前）。
 * 用法（本块最后一行已给出）：
 *  * 对外只有 NW_UI：{ Button, Switch, SegmentedControl, Tag, Tooltip, DisclosureRow }
 *    （v7.3.1 修（#84）：Modal / RiskConfirmation 适配器零调用——弹窗一律走 DialogCard——已删除）
 *    （v7.3.2 修（N9）：available 自检标志全仓零读取，已随之删除；判断是否走到回退实现请看实际渲染）
 *
 * 设计约束（宿主启动安全第一）：
 *   1. require 官方包只在 try/catch 内；取不到模块 / 缺某个组件 / 官方组件渲染抛错 → 逐控件回退；
 *      本层在任何情况下都不向上抛，也不写 console。
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

  // #33：零 Hook ErrorBoundary，在真实 React 18+ 宿主下兜住官方原语渲染抛错，同时让官方组件在独立 fiber 中执行 Hook。
  var PrimitiveBoundary = null;
  if (react && typeof react.Component === "function" && react.Component.prototype) {
    PrimitiveBoundary = class PrimitiveBoundary extends react.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch() {}
      render() {
        if (this.state && this.state.failed) return this.props.renderFallback();
        return this.props.children;
      }
    };
  }

  var NAMES = ["Button", "Switch", "SegmentedControl", "Tag", "Tooltip", "DisclosureRow"];
  var official = {};
  for (var n = 0; n < NAMES.length; n += 1) {
    official[NAMES[n]] = pick(NAMES[n]);
  }
  // v7.3.2 修（N9）：原 available 自检标志（官方原语是否全部取到）与它的 resolved 计数一并删除——
  // 全仓零读取，属 #84 清理后残留的死导出；逐控件回退不受影响。

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
      // #29 修复：prepare 里的 Hook 必须**无条件**调用，不能包在 try/catch 里。
      // 任何可能抛错的 props 读取都下沉到 prepare 内部各自 try/catch（见 prepareSegments / prepareDisclosure），
      // 否则异常帧会少调用 Hook、下一帧又恢复 → React 报 "Rendered fewer hooks than expected" → 面板白屏。
      var context = prepare === null ? null : prepare(input);
      return fallback(input, context);
    }
    if (component === null || !canCreate) return FallbackOnly;
    return function Adapted(props) {
      var input = props || {};
      var context = prepare === null ? null : prepare(input);
      var mapped = null;
      try { mapped = mapProps(input, context); } catch (err) { mapped = null; }
      if (mapped !== null) {
        var officialNode = h(component, mapped);
        if (PrimitiveBoundary !== null) {
          return h(PrimitiveBoundary, { renderFallback: function () { return fallback(input, context); } }, officialNode);
        }
        return officialNode;
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
    // 无论调用方是否自带 id，都先按固定分支取一次自动 id：hook 数量每帧恒定。
    // #29：Hook 在**任何 props 读取之前**调用（旧实现包在 try/catch 里，异常帧会少一个 Hook）。
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
    // 以下只是非 Hook 的上下文计算：入参读取/归一化抛错也只影响本帧内容，不改 Hook 链、不冒泡。
    var ownId = "";
    var options = [];
    try {
      ownId = optionalText(props.id) || "";
      options = normalizeOptions(props.options);
    } catch (err) {
      ownId = "";
      options = [];
    }
    return { id: ownId || auto, options: options }; // 自带 id（可选）优先
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
    // #29：先把「入参 → 初始值」这段可能抛错的计算挡在本地（try/catch 不跨越 Hook），
    //      再无条件调用 useState。这样任何一帧的 props 读取失败都不会改变 Hook 数量。
    var initial = false;
    try { initial = isOn(props.defaultOpen); } catch (err) { initial = false; }
    if (useStateHook === null) return { open: initial, toggle: NOOP };
    var pair = useStateHook(initial);
    var setter = callback(pair === null || pair === void 0 ? null : pair[1]);
    return {
      open: pair !== null && pair !== void 0 && pair[0] === true,
      toggle: function () {
        if (setter !== null) setter(function (value) { return value !== true; });
      }
    };
  }
  function mapDisclosure(props, context) {
    var open = false;
    var toggle = NOOP;
    if (context !== null && context !== void 0) { open = context.open === true; toggle = context.toggle; }
    else { try { open = isOn(props.defaultOpen); } catch (err) { open = false; } }
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
    var open = false;
    var toggle = NOOP;
    if (context !== null && context !== void 0) { open = context.open === true; toggle = context.toggle; }
    else { try { open = isOn(props.defaultOpen); } catch (err) { open = false; } }
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
  // v7.3.1 修（#84）：删掉 Modal / RiskConfirmation 两个死适配器（render 零调用，弹窗一律走 DialogCard）。
  // v7.3.2 修（N9）：同时删掉零消费者的 available 标志；导出 6 个原语：5 个用于生产 render，DisclosureRow 保留供 client-test #29 Hook 稳定性回归锁验。
  return {
    Button: adapt("Button", fallbackButton, null, mapButton),
    Switch: adapt("Switch", fallbackSwitch, null, mapSwitch),
    SegmentedControl: adapt("SegmentedControl", fallbackSegments, prepareSegments, mapSegments),
    Tag: adapt("Tag", fallbackTag, null, mapTag),
    Tooltip: adapt("Tooltip", fallbackTooltip, null, mapTooltip),
    DisclosureRow: adapt("DisclosureRow", fallbackDisclosure, prepareDisclosure, mapDisclosure)
  };
}

var NW_UI = createNovelWriterUI(react, require);
