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
  if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return false;
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
