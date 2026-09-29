// 客户端模块加载模拟：验证 __ModuleLoader__ 契约（含 inject 声明）、侧边栏/面板/设置槽位
globalThis.window = globalThis;

// v4.0.0：DOM 桩升级——旧版 querySelector 恒返回 null，sidebarRoot()/conversationColumn() 都是 undefined，
// 侧边栏入口与面板容器从未插入 DOM（挂载整体空转=假 PASS，且插件把挂载异常吞成 console.warn 也测不出来）。
// 这里用带父子关系的节点桩，让 insertBefore/appendChild/contains 真正生效。
class HTMLElementStub {
  constructor(tagName) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.isConnected = false;
    this.className = "";
    this.innerHTML = "";
    this.type = "";
    this._listeners = {};
    this._dispatched = [];
    this.classList = { add() {}, remove() {} };
  }
  get firstElementChild() { return this.children.length > 0 ? this.children[0] : null; }
  get nextElementSibling() {
    if (this.parentElement === null) return null;
    const i = this.parentElement.children.indexOf(this);
    return i >= 0 && i + 1 < this.parentElement.children.length ? this.parentElement.children[i + 1] : null;
  }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, anchor) {
    if (node.parentElement !== null) {
      const old = node.parentElement.children.indexOf(node);
      if (old >= 0) node.parentElement.children.splice(old, 1);
    }
    const at = anchor === null || anchor === undefined ? this.children.length : this.children.indexOf(anchor);
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    node.parentElement = this;
    markConnected(node, true);
    return node;
  }
  remove() {
    if (this.parentElement !== null) {
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) this.parentElement.children.splice(i, 1);
    }
    this.parentElement = null;
    markConnected(this, false);
  }
  contains(node) { for (let n = node; n; n = n.parentElement) if (n === this) return true; return false; }
  matches(selector) { return matchSelector(this, selector); }
  closest(selector) { for (let n = this; n; n = n.parentElement) if (matchSelector(n, selector)) return n; return null; }
  querySelector() { return null; }
  click() { for (const fn of this._listeners.click || []) fn({ type: "click" }); }
  dispatchEvent(event) {
    this._dispatched.push(event);
    dispatchDocumentEvent(event); // 模拟事件冒泡到 document（插件在 document 上监听 dsh-panel-activate）
    return true;
  }
}
function markConnected(node, value) {
  node.isConnected = value;
  for (const child of node.children) markConnected(child, value);
}
// 极简选择器匹配：只支持本测试用到的 [class*="x"] / [data-*] / 标签名
function matchSelector(node, selector) {
  for (const part of String(selector).split(",").map((s) => s.trim()).filter(Boolean)) {
    const attr = part.match(/^\[([a-zA-Z0-9_-]+)([*^$]?=)["']?([^\]"']*)["']?\]$/);
    if (attr) {
      const raw = attr[1] === "class" ? node.className : node[attr[1]];
      const value = raw === undefined || raw === null ? "" : String(raw);
      if (attr[2] === "*=") { if (value.includes(attr[3])) return true; }
      else if (value !== "") return true;
      continue;
    }
    if (node.tagName === part.toUpperCase()) return true;
  }
  return false;
}
globalThis.HTMLElement = HTMLElementStub;
// v4.0.0：补 CustomEvent（Node 无此全局）——否则面板打开路径 syncOpen() 一走到就 ReferenceError，该路径零覆盖
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init && init.detail; }
};

const documentListeners = new Map();
function dispatchDocumentEvent(event) {
  for (const fn of documentListeners.get(event.type) || []) fn(event);
}

const body = new HTMLElementStub("body");
const head = new HTMLElementStub("head");
// 侧边栏列：真实宿主结构 = sidebarColumn > logoRow > 新建会话按钮
// （v4.0.0：placeEntry 在 newSession 按钮尚未渲染时返回 false 保持重试，桩里必须给出该按钮，否则入口永远挂不上）
const sidebarColumn = new HTMLElementStub("div");
const logoRow = new HTMLElementStub("div");
logoRow.className = "logoRow";
const newSessionButton = new HTMLElementStub("button");
newSessionButton.className = "newSessionBtn";
logoRow.appendChild(newSessionButton);
sidebarColumn.appendChild(logoRow);
// 会话列（面板容器挂这里）
const conversationColumn = new HTMLElementStub("div");
body.appendChild(sidebarColumn);
body.appendChild(conversationColumn);

globalThis.document = {
  createElement: (tag) => new HTMLElementStub(tag),
  querySelector: (selector) => {
    if (typeof selector !== "string") return null;
    if (/data-pane="sidebar"|sidebarCol/.test(selector)) return sidebarColumn;
    if (/data-pane="conversation"|centerCol/.test(selector)) return conversationColumn;
    return null;
  },
  body,
  head,
  documentElement: Object.assign(new HTMLElementStub("html"), { lang: "zh" }),
  addEventListener: (type, fn) => { (documentListeners.get(type) || documentListeners.set(type, []).get(type)).push(fn); },
  removeEventListener: (type, fn) => { documentListeners.set(type, (documentListeners.get(type) || []).filter((f) => f !== fn)); },
  dispatchEvent: (event) => { dispatchDocumentEvent(event); return true; }
};
globalThis.MutationObserver = class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} };
const loaded = {};
globalThis.__ModuleLoader__ = {
  load: (spec) => { loaded.id = spec.id; loaded.factory = spec.factory; }
};

await import("../lib/client.js");

const fail = (msg) => { console.error("CLIENT FAIL: " + msg); process.exit(1); };

// v4.0.0：契约断言必须落退出码（旧版只打印 ✓/✗——id 改成别的、inject 删掉，测试照样 CLIENT OK）
if (loaded.id !== "dsh-novel-writer") fail("注册 id 应为包名 dsh-novel-writer，实际 " + JSON.stringify(loaded.id));
console.log("注册 id:", loaded.id, "✓");
if (typeof loaded.factory !== "function") fail("factory 类型应为 function，实际 " + typeof loaded.factory);
console.log("factory 类型:", typeof loaded.factory);

// ---------------------------------------------------------------------------
// v4.3.0：React 桩升级——旧桩 createElement 恒返回 {}、createRoot().render() 空转，
// 导致 PanelView / NovelWriterSettingsCard 的组件体从未执行：面板内容、控制器订阅、
// 状态同步、各视图分支（main/features/tools/baseline/creation/reports/model/raw 弹窗）
// 全部零覆盖，组件里任何 TypeError 都测不出来（真机上表现为点开面板白屏）。
// 这里实现最小可执行的 React 子集：createElement 建 vnode、useState/useEffect 有真实槽位
// （含依赖数组与清理函数，跨渲染复用实例）、createRoot().render(el) 会真的把组件函数跑一遍
// 并遍历返回的 vnode 树（组件体里的运行期异常会直接抛出，由调用方 fail）。
// ---------------------------------------------------------------------------
let reactRenderDepth = 0; // 渲染期外的 setState 直接忽略（不引入重渲染语义，避免假异步）
const hookViolations = []; // v5.5.0：hook 数量不稳定的记录（收尾统一判失败）
function makeElement(type, props, ...children) {
  const vnode = { type, props: props === null || props === undefined ? {} : props, children: [] };
  // React 的 createElement 是可变参数（...children），这里必须照抄，否则多子节点会被丢掉
  if (children.length === 1) vnode.children = [children[0]];
  else if (children.length > 1) vnode.children = children;
  return vnode;
}
const hookQueue = []; // 每次 effect 执行返回的清理函数（收尾统一调用，避免订阅泄漏）
const instances = new Map(); // 组件函数 → 实例（跨多次渲染复用 hooks 槽位与 effect 依赖）
let currentHooks = null;
const reactStub = {
  createElement: makeElement,
  useState(initial) {
    if (currentHooks === null) throw new Error("useState 在组件渲染之外被调用");
    const slot = currentHooks.index;
    currentHooks.index += 1;
    if (currentHooks.list[slot] === undefined) {
      currentHooks.list[slot] = typeof initial === "function" ? initial() : initial;
    }
    const setter = (next) => {
      if (reactRenderDepth <= 0) return; // 渲染期外忽略：本桩不做异步重渲染
      currentHooks.list[slot] = typeof next === "function" ? next(currentHooks.list[slot]) : next;
    };
    return [currentHooks.list[slot], setter];
  },
  useEffect(fn, deps) {
    if (currentHooks === null) throw new Error("useEffect 在组件渲染之外被调用");
    const slot = currentHooks.index;
    currentHooks.index += 1;
    currentHooks.effects.push({ slot, fn, deps: Array.isArray(deps) ? deps.map(String).join("\u0000") : null });
  },
  useId() {
    if (currentHooks === null) throw new Error("useId 在组件渲染之外被调用");
    const slot = currentHooks.index;
    currentHooks.index += 1;
    if (currentHooks.list[slot] === undefined) currentHooks.list[slot] = ":nw" + slot + ":";
    return currentHooks.list[slot];
  }
};
/** 执行一个 React 元素：函数组件会被真的调用（带 hooks 上下文），随后递归遍历它的 vnode 树。 */
function renderElement(element, stats) {
  if (element === null || element === undefined || typeof element === "boolean") return;
  if (typeof element === "string" || typeof element === "number") {
    stats.text += String(element);
    return;
  }
  if (Array.isArray(element)) {
    for (const item of element) renderElement(item, stats);
    return;
  }
  if (typeof element.type === "function") {    stats.components += 1;
    // 按组件函数复用实例（模拟 React 的组件实例）：hooks 槽位与 effect 依赖跨渲染保持
    let instance = instances.get(element.type);
    if (instance === undefined) {
      instance = { list: [], effects: [] };
      instances.set(element.type, instance);
    }
    const prev = currentHooks;
    instance.index = 0;
    instance.effects = []; // 本次渲染声明的 effect（是否执行由 deps 决定）
    currentHooks = instance;
    let rendered;
    try {
      rendered = element.type(element.props);
    } finally {
      currentHooks = prev;
    }
    // v5.5.0：像 React 一样校验 hook 数量稳定性。
    // 组件被"当普通函数直接调用"（而不是 createElement 成子组件）时，它的 hook 会被混进调用者的 hook 链，
    // 条件分支/视图切换一变就出现 "Rendered more hooks than during the previous render"，
    // 真机表现是整棵面板白屏（v5.5.0 的官方原语适配层就踩过这个坑）。这里让它当场失败，而不是溜到真机。
    const consumed = instance.index;
    if (instance.lastHookCount !== undefined && instance.lastHookCount !== consumed) {
      const msg = "Rendered more hooks than during the previous render：组件 "
        + (element.type.name || "anonymous") + " 上次 " + instance.lastHookCount + " 个 hook / 本次 " + consumed + " 个";
      hookViolations.push(msg); // 收尾必须失败：异常可能被上层 catch 吞掉，靠这里兜底
      throw new Error(msg);
    }
    instance.lastHookCount = consumed;
    renderElement(rendered, stats);
    // effect 首次渲染必执行，之后仅在依赖变化时执行（与 React 一致：PanelView 的订阅不会每次渲染都加一个）
    for (const effect of instance.effects) {
      const prevDeps = instance.list["eff" + effect.slot];
      const changed = prevDeps === undefined || prevDeps === null || effect.deps === null || prevDeps !== effect.deps;
      instance.list["eff" + effect.slot] = effect.deps;
      if (!changed) continue;
      const cleanup = effect.fn();
      if (typeof cleanup === "function") hookQueue.push(cleanup);
    }
    return;
  }
  stats.nodes += 1;
  if (typeof element.type === "string" && element.props && typeof element.props.className === "string") {
    for (const cls of element.props.className.split(/\s+/).filter(Boolean)) stats.classes.add(cls);
  }
  // v5.1.1：收集按钮（vnode 级，不依赖 DOM 物化）——供"分段按钮必须可点"的断言使用
  if (element.type === "button") stats.buttons.push(element);
  for (const child of element.children) renderElement(child, stats);
}
/** 驱动一次真实渲染：跑组件函数 + 遍历 vnode 树，返回统计（异常向上抛，由调用方 fail）。 */
function runRender(element) {
  // v5.1.1：新增 buttons 收集——面板里的分段按钮（档位/场景）此前只被"渲染出来"而从未被断言，
  // 于是"场景按钮被 disabled 锁死"这个真机上立刻能看出来的问题，测试完全看不见。
  const stats = { components: 0, nodes: 0, text: "", classes: new Set(), buttons: [] };
  reactRenderDepth += 1;
  try {
    renderElement(element, stats);
  } finally {
    reactRenderDepth -= 1;
  }
  return stats;
}
/** 取 vnode 的纯文本（递归拼接字符串子节点），用于按文案定位按钮。 */
function vnodeText(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(vnodeText).join("");
  if (typeof node === "object" && node.children) return vnodeText(node.children);
  return "";
}
/** 测试收尾：执行 effect 返回的清理函数（取消订阅/清定时器），避免句柄泄漏。 */
function cleanupHooks() {
  while (hookQueue.length > 0) {
    const cleanup = hookQueue.pop();
    try { cleanup(); } catch { /* 清理失败不影响断言结果 */ }
  }
}

// react-dom/client 桩：把交给 root.render() 的元素真的渲染一遍（PanelView/设置卡片都在这里执行）
const renderLog = [];
function createRoot(container) {
  return {
    render(element) {
      const stats = runRender(element);
      renderLog.push({ container, stats, element });
    },
    unmount() {}
  };
}

/**
 * v5.5.0：官方 primitives 的桩 —— 用来覆盖「官方原语可用」这条路径。
 * 默认关闭（只跑回退路径，保持原有断言稳定）；`NW_TEST_PRIMITIVES=1` 时开启。
 *
 * 桩里**刻意让 SegmentedControl / DisclosureRow 使用 hook**（官方实现就是这么写的）：
 * 这样一旦我们在别处把这些适配层组件当普通函数直接调用、而不是 createElement 成子组件，
 * hook 计数就会随面板视图/条件分支变化 → React 报 "Rendered more hooks than during the previous render"
 * → 真机上表现为点开面板白屏。这条路径此前没有任何覆盖，正是该白屏 bug 能溜到真机的原因。
 */
const stubPrimitives = {
  Switch: (props) => reactStub.createElement("button", {
    role: "switch", "aria-checked": String(props.checked === true), disabled: props.disabled === true,
    "aria-label": props.label, onClick: () => props.onChange(!props.checked)
  }, reactStub.createElement("span", null)),
  SegmentedControl: (props) => {
    const uid = reactStub.useId(); // ← hook：迫使调用方必须用 createElement 而不是直接调用
    return reactStub.createElement("div", { role: "tablist", "aria-label": props.label, "data-stub-uid": uid },
      props.options.map((o) => reactStub.createElement("button", {
        key: o.value, role: "tab", "aria-selected": String(o.value === props.value),
        disabled: props.disabled === true || o.disabled === true,
        onClick: () => { if (o.value !== props.value) props.onChange(o.value); }
      }, o.label)));
  },
  Button: (props) => reactStub.createElement("button", {
    type: "button", disabled: props.disabled, onClick: props.onClick, className: props.className
  }, props.children),
  Tag: (props) => reactStub.createElement("span", { "data-stub-tone": props.tone, className: props.className }, props.children),
  Tooltip: (props) => props.children,
  Modal: (props) => (props.open ? reactStub.createElement("div", { role: "dialog" }, props.title, props.children) : null),
  RiskConfirmation: (props) => (props.open ? reactStub.createElement("div", { role: "dialog" }, props.description) : null),
  DisclosureRow: (props) => {
    const [open] = reactStub.useState(props.defaultOpen === true); // ← hook
    return reactStub.createElement("div", null, props.title, open ? props.children : null);
  }
};
const USE_STUB_PRIMITIVES = process.env.NW_TEST_PRIMITIVES === "1";
const fakeRequire = (name) => {
  if (name === "react") return reactStub;
  if (name === "react-dom/client") return { createRoot };
  if (USE_STUB_PRIMITIVES && name === "@deepseek-ai/dsh-client-ui-primitives") return stubPrimitives;
  throw new Error("意外的 require: " + name);
};

const exported = loaded.factory(fakeRequire);
console.log("导出:", Object.keys(exported).join(", "));
const injectOk = JSON.stringify(exported.inject) === JSON.stringify(["slots", "locale"]);
if (!injectOk) fail("inject 声明应为 [\"slots\",\"locale\"]，实际 " + JSON.stringify(exported.inject));
console.log("inject 声明:", JSON.stringify(exported.inject), "✓");
if (typeof exported.apply !== "function") fail("apply 类型应为 function，实际 " + typeof exported.apply);
console.log("apply 类型:", typeof exported.apply);

let slotRegistered = null;
// v5.2.0：假宿主也要如实建模宿主的"槽位声明表"——未声明的槽位 register 会抛错、
// inject 的时机也由声明决定（真机事故就是从这里来的）。老宿主（v5.1.1 那套）只声明设置卡槽位。
const SIDEBAR_SEATS = ["sidebar.panellist", "main"];
const DECLARED_LEGACY = new Set(["settings.plugin.item"]);
const ctx = {
  effect: (fn) => fn(),
  slots: {
    inject: (name, fn) => { fn(); },
    register: (opts, component) => { slotRegistered = { opts, component }; },
    specDynamic: (name) => (DECLARED_LEGACY.has(name) ? {} : void 0)
  }
};
// v4.0.0：挂载异常不再被 console.warn 吞掉——apply 期间任何 [dsh-novel-writer] 告警都视为失败
const mountWarnings = [];
const originalWarn = console.warn;
console.warn = (...args) => { mountWarnings.push(args.map((a) => String(a)).join(" ")); };
try {
  exported.apply(ctx);
} catch (err) {
  console.warn = originalWarn;
  fail("apply 抛错: " + err);
}
console.warn = originalWarn;
if (mountWarnings.length > 0) fail("apply 期间出现插件告警（挂载失败被静默吞掉）: " + mountWarnings.join(" | "));

// v4.0.0：侧边栏入口必须真的插入 DOM（旧版只验证 settings 槽位，挂载空转也算通过）
const collect = (node, pred, out = []) => {
  if (pred(node)) out.push(node);
  for (const child of node.children || []) collect(child, pred, out);
  return out;
};
const entries = collect(body, (n) => n instanceof HTMLElementStub && n.dataset && n.dataset.dshNovelWriterEntry !== undefined);
if (entries.length !== 1) fail("侧边栏入口未挂载（期望 1 个，实际 " + entries.length + "）");
if (entries[0].tagName !== "BUTTON") fail("侧边栏入口应为 BUTTON，实际 " + entries[0].tagName);
if (!body.contains(entries[0])) fail("侧边栏入口未进入 document.body 子树");
console.log("侧边栏入口挂载:", entries[0].tagName, "| aria-label:", entries[0]["aria-label"], "✓");

// v4.0.0：面板容器必须真的挂到会话列（conversationColumn）上
const panels = collect(conversationColumn, (n) => n instanceof HTMLElementStub && n.dataset && n.dataset.dshNovelWriterView !== undefined);
if (panels.length !== 1) fail("面板容器未挂载（期望 1 个，实际 " + panels.length + "）");
if (panels[0].style.display !== "none") fail("面板初始应隐藏，实际 display=" + panels[0].style.display);
console.log("面板容器挂载:", panels[0].dataset.dshNovelWriterView, "| 初始 display:", panels[0].style.display, "✓");

// v4.0.0：点击侧边栏入口 → 面板打开（激活属性 + dsh-panel-activate 事件 + 容器显示）
document.documentElement._dispatched.length = 0;
entries[0].click();
const activated = document.documentElement.dataset.dshNovelWriterActive === "";
const activatedEvent = document.documentElement._dispatched.find((e) => e.type === "dsh-panel-activate" && e.detail === "novel-writer");
if (!activated) fail("点击入口后面板未激活（documentElement.dataset.dshNovelWriterActive 缺失）");
if (!activatedEvent) fail("点击入口后未派发 dsh-panel-activate 事件（detail=novel-writer）");
if (panels[0].style.display !== "block") fail("面板打开后容器应 display:block，实际 " + panels[0].style.display);
if (entries[0].dataset.active !== "true") fail("侧边栏入口未标记 active");
console.log("面板打开: 激活属性 ✓ 事件 ✓ 容器显示 ✓ 入口 active ✓");
// v4.0.0：其它插件激活面板时本插件互斥关闭（document 上的 dsh-panel-activate 监听）
document.dispatchEvent(new CustomEvent("dsh-panel-activate", { detail: "ssh" }));
if (document.documentElement.dataset.dshNovelWriterActive !== undefined) fail("其它面板激活后本插件未取消激活");
if (panels[0].style.display !== "none") fail("其它面板激活后本插件容器应隐藏，实际 " + panels[0].style.display);
console.log("面板互斥关闭: ✓");

if (!slotRegistered || typeof slotRegistered.component !== "function") fail("设置槽位未注册（挂载未执行）");
console.log("设置槽位注册:", slotRegistered.opts?.name, "| id:", slotRegistered.opts?.id, "| 组件:", typeof slotRegistered.component, "✓");

// ---------------------------------------------------------------------------
// v4.3.0：面板内容必须真的渲染出来（旧桩下组件体从不执行 → 这一段是新增覆盖）
// 前置条件：上面的面板互斥关闭测试已把面板关回 (view="main", panelOpen=false)
// ---------------------------------------------------------------------------
if (renderLog.length === 0) fail("createRoot().render() 从未被调用——面板组件体零执行（桩又空转了）");
const panelRender = renderLog.find((entry) => entry.stats.classes.has("nwPanel"));
if (!panelRender) {
  fail("PanelView 未渲染出 .nwPanel 根节点（components=" + renderLog.map((e) => e.stats.components).join(",")
    + " classes=" + renderLog.map((e) => [...e.stats.classes].join("|")).join(" ; ") + "）");
}
const panelClasses = panelRender.stats.classes;
if (panelRender.stats.components < 1) fail("面板渲染期间没有执行任何函数组件");
if (panelRender.stats.nodes < 20) fail("面板 vnode 树节点过少（" + panelRender.stats.nodes + "），组件体可能提前返回");
if (!panelClasses.has("nwPanelHeader") || !panelClasses.has("nwBanner")) {
  fail("面板缺少标题栏/状态横幅（className 实际：" + [...panelClasses].join(" ") + "）");
}
// enabled 默认 true → 横幅应为「已开启」态（文案随 locale，取不到则退回状态类名断言）
if (!panelClasses.has("nwBannerOn") && !panelRender.stats.text.includes("已开启")) {
  fail("面板状态横幅未反映 enabled=true：" + panelRender.stats.text.slice(0, 120));
}
if (panelRender.stats.text.length < 20) fail("面板渲染出的文本过少（" + panelRender.stats.text.length + " 字符），内容可能为空");
console.log("面板组件渲染: 组件数 " + panelRender.stats.components + " | vnode 节点 " + panelRender.stats.nodes
  + " | 文本 " + panelRender.stats.text.length + " 字符 | 类名 " + [...panelClasses].slice(0, 8).join(" ") + " ✓");

// 视图切换：主面板之外的各分支也必须能渲染（旧桩下这些分支零执行）
const panelProps = panelRender.element.props;
const controller = panelProps.controller;
if (!controller || typeof controller.getSnapshot !== "function") fail("PanelView 未拿到可用的 controller");
for (const view of ["features", "tools", "baseline", "creation", "reports", "model"]) {
  controller.set({ view }, { silent: true });
  if (controller.getSnapshot().view !== view) fail("controller.set 未生效：view=" + view);
}
const viewRenders = renderLog.length;
if (viewRenders <= 1) fail("切换视图未触发任何重渲染（订阅失效）");
// 弹窗分支（rawModal / rawPromiseOpen）也必须能渲染——真机上这两条是"非净化模式"的必走路径
const modalRenders = renderLog.length;
controller.set({ view: "main", rawModal: true, rawCountdown: 3 }, { silent: true });
controller.set({ rawModal: false, rawPromiseOpen: true, rawPromiseText: "我承诺" }, { silent: true });
controller.set({ rawPromiseOpen: false }, { silent: true });
if (renderLog.length <= modalRenders) fail("弹窗状态变更未触发重渲染");
console.log("视图/弹窗分支渲染: 共 " + renderLog.length + " 次渲染（main/features/tools/baseline/creation/reports/model/rawModal/rawPromiseOpen）✓");

// 设置页卡片组件体同样必须可执行（槽位注册的 component）
const cardRender = runRender(reactStub.createElement(slotRegistered.component, { controller, toggle: () => {}, onOpenPanel: () => {} }));
if (cardRender.components < 1 || cardRender.nodes < 3) fail("设置卡片组件体未执行（components=" + cardRender.components + " nodes=" + cardRender.nodes + "）");
console.log("设置卡片渲染: 组件数 " + cardRender.components + " | vnode 节点 " + cardRender.nodes + " ✓");

// ---------------------------------------------------------------------------
// v5.1.1 回归：提示词「场景」分段按钮必须始终可点（真机反馈：档位=off 时五个场景按钮全灰、点不动）
// 旧实现把 disabled 绑在 systemPromptMode !== "full" 上，用户默认档位（off/brief）下场景被锁死且无任何提示。
// ---------------------------------------------------------------------------
// 先落到"档位=关闭 + 不在加载中"——这正是用户遇到问题的现场（默认档位 off，场景行整行点不动）
controller.set({ view: "main", loading: false, systemPromptMode: "off", promptScene: "general" }, { silent: true });
const featsRender = renderLog[renderLog.length - 1];
// v5.5.0：分段控件可能是「回退实现」（带 nwSegBtn 类）或「官方 SegmentedControl」（tablist，role="tab"），
// 两条路径都要能断言——否则官方路径下这段覆盖会静默失效。
const segButtonsOf = (stats) => (stats.buttons || []).filter((b) => {
  const cls = String(b.props.className || "");
  return cls.includes("nwSegBtn") || b.props.role === "tab";
});
const segBtns = segButtonsOf(featsRender.stats);
if (segBtns.length !== 8) fail("主面板分段按钮数量异常（档位 3 + 场景 5 应为 8，实际 " + segBtns.length + "）");
const SCENE_LABELS = ["通用", "写新章", "改稿", "审计", "建资料"];
const MODE_LABELS = ["关闭", "精简", "完整"];
const sceneBtns = segBtns.filter((b) => SCENE_LABELS.includes(vnodeText(b).trim()));
const modeBtns = segBtns.filter((b) => MODE_LABELS.includes(vnodeText(b).trim()));
if (sceneBtns.length !== 5) fail("未按文案定位到 5 个场景按钮（实际 " + sceneBtns.length + "："
  + segBtns.map((b) => vnodeText(b).trim()).join("/") + "）");
if (modeBtns.length !== 3) fail("未按文案定位到 3 个档位按钮（实际 " + modeBtns.length + "）");
// 关键回归断言：档位=off（非 full）时，场景按钮必须可点——旧实现把它们 disabled 了，用户"点不了"
const lockedScene = sceneBtns.filter((b) => b.props.disabled === true);
if (lockedScene.length > 0) {
  fail("档位非 full 时场景按钮被 disabled 锁死（用户点不了）：" + lockedScene.map((b) => vnodeText(b).trim()).join("/")
    + "｜loading=" + controller.getSnapshot().loading + " mode=" + controller.getSnapshot().systemPromptMode);
}
const lockedMode = modeBtns.filter((b) => b.props.disabled === true);
if (lockedMode.length > 0) fail("loading=false 时档位按钮仍被禁用：" + lockedMode.map((b) => vnodeText(b).trim()).join("/"));
for (const b of sceneBtns) if (typeof b.props.onClick !== "function") fail("场景按钮缺 onClick：" + vnodeText(b).trim());
const hintNode = featsRender.stats.text.includes("暂不注入");
if (!hintNode) fail("档位非 full 时未给出「场景暂不注入」的说明（用户不知道为何没生效）");
// 点一个非当前场景：必须真的回调 toggle({ promptScene })（把面板的 toggle 换成探针后再渲染）
// 点一个非当前场景：必须真的回调 toggle({ promptScene })。
// 用探针 props 直接渲染面板组件（与上面设置卡片同一手法）——比改 props 对象更可靠：
// 组件内部若把 toggle 解构进局部变量，改 props 就失效了。
const probe = [];
const probeRender = runRender(reactStub.createElement(panelRender.element.type, {
  controller,
  toggle: (patch) => probe.push(patch),
  onOpenPanel: () => {}
}));
const probeSegs = segButtonsOf(probeRender);
const writingBtn = probeSegs.find((b) => vnodeText(b).trim() === "写新章");
if (!writingBtn) fail("探针渲染后找不到「写新章」按钮（找到：" + probeSegs.map((b) => vnodeText(b).trim()).join("/") + "）");
writingBtn.props.onClick();
if (probe.length !== 1 || probe[0].promptScene !== "writing") {
  fail("点击场景按钮未提交 promptScene=writing（实际 " + JSON.stringify(probe) + "）");
}
// 选中态：回退实现用 nwSegBtnOn 类；官方控件用 aria-selected
const currentBtn = probeSegs.find((b) => (String(b.props.className || "").includes("nwSegBtnOn") || b.props["aria-selected"] === "true") && SCENE_LABELS.includes(vnodeText(b).trim()));
if (currentBtn && vnodeText(currentBtn).trim() !== "通用") fail("当前场景高亮错位：" + vnodeText(currentBtn).trim());
console.log("场景按钮可点（v5.1.1）: 8 个分段按钮全部可点 | 点击「写新章」→ toggle({promptScene:\"writing\"}) ✓ | 档位非 full 时提示「暂不注入」✓");

// ---------------------------------------------------------------------------
// v5.2.0：官方席位 = 侧栏一行（sidebar.panellist）+ 主栏页面（main，同一个 id）
// 这就是「插件」「任务看板」在用的同一套席位（模板见 @linxin666/dsh-client-ui-task-board）：
// 行盒子/选中态/文字/无障碍名称由宿主 layout 画，我们只提供图标与页面内容。
// ---------------------------------------------------------------------------
const isLegacyEntry = (n) => n instanceof HTMLElementStub && n.dataset && n.dataset.dshNovelWriterEntry !== undefined;
const official = { seats: [], injected: [] };
const officialDeclared = new Set(["settings.plugin.item", ...SIDEBAR_SEATS]);
let selectedPanel = "sentinel";
const officialCtx = {
  effect: (fn) => fn(),
  slots: {
    inject: (name, fn) => { official.injected.push(name); return fn(); },
    register: (opts, component) => { official.seats.push({ opts, component }); return () => {}; },
    specDynamic: (name) => (officialDeclared.has(name) ? {} : void 0),
    subscribe: () => () => {}
  },
  layout: { selectPanel: (id) => { selectedPanel = id; } }
};
const legacyBeforeOfficial = collect(body, isLegacyEntry).length;
const officialWarnings = [];
console.warn = (...args) => { officialWarnings.push(args.map((a) => String(a)).join(" ")); };
try {
  loaded.factory(fakeRequire).apply(officialCtx);
} catch (err) {
  console.warn = originalWarn;
  fail("官方席位路径 apply 抛错: " + err);
}
console.warn = originalWarn;
if (officialWarnings.length > 0) fail("官方席位路径出现插件告警（席位注册失败被吞掉）: " + officialWarnings.join(" | "));
const rowSeat = official.seats.find((s) => s.opts.name === "sidebar.panellist");
const pageSeat = official.seats.find((s) => s.opts.name === "main");
if (!rowSeat) fail("未注册侧栏行席位（sidebar.panellist）");
if (!pageSeat) fail("未注册主栏页面席位（main）");
if (rowSeat.opts.id !== "dsh-novel-writer") fail("侧栏行 id 应为包名，实际 " + rowSeat.opts.id);
if (pageSeat.opts.key !== rowSeat.opts.id) {
  fail("main 席位的 key 必须等于侧栏行的 id（宿主按 id 派发页面），实际 " + pageSeat.opts.key);
}
if (typeof rowSeat.opts.label !== "function") fail("侧栏行缺 label thunk（切语言不会跟随）");
if (typeof rowSeat.opts.label() !== "string" || rowSeat.opts.label().length === 0) fail("侧栏行 label 求值为空");
if (typeof rowSeat.opts.order !== "number") fail("侧栏行缺 order");
// 图标组件：宿主传 { size, active }
const iconRender = runRender(reactStub.createElement(rowSeat.component, { size: 18, active: true }));
if (iconRender.nodes < 1) fail("侧栏行图标组件没有渲染出节点");
// 页面组件：inject 提供 controller/toggle/onClose，必须能渲染出主栏面板
const pageProps = typeof pageSeat.opts.inject === "function" ? pageSeat.opts.inject() : {};
if (!pageProps.controller || typeof pageProps.controller.getSnapshot !== "function") fail("主栏页面的 inject 未提供 controller");
const pageRender = runRender(reactStub.createElement(pageSeat.component, pageProps));
if (!pageRender.classes.has("nwPanel")) fail("主栏页面未渲染出 .nwPanel（类名：" + [...pageRender.classes].join(" ") + "）");
if (!pageRender.classes.has("nwPanelMain")) fail("主栏页面未带 nwPanelMain 标记：" + [...pageRender.classes].join(" "));
// 关闭按钮 = 回会话：走宿主 layout.selectPanel(null)
const closeBtn = (pageRender.buttons || []).find((b) => String(b.props.className || "").includes("nwClose"));
if (!closeBtn) fail("主栏页面没有关闭按钮（应通过 layout.selectPanel(null) 返回会话）");
closeBtn.props.onClick();
if (selectedPanel !== null) fail("点击关闭未调用 layout.selectPanel(null)，实际 " + JSON.stringify(selectedPanel));
// 接管后旧 DOM 入口必须撤掉
if (collect(body, isLegacyEntry).length !== legacyBeforeOfficial) {
  fail("官方席位接管后旧 DOM 入口未撤掉（" + collect(body, isLegacyEntry).length + " 个，期望 " + legacyBeforeOfficial + "）");
}
console.log("官方席位（v5.2.0 重做）: 侧栏行 sidebar.panellist(id/order/label) ✓ | 主栏页面 main(key=id) ✓"
  + " | 图标组件 {size,active} ✓ | 页面渲染 + 关闭走 layout.selectPanel(null) ✓ | 旧 DOM 入口已撤 ✓");

// ---------------------------------------------------------------------------
// v5.2.0 二次修正回归：两个真机事故一起钉住
//  ① 用 ctx.inject 等 cordis 服务会让宿主把 entry 判为 did not activate（桌面端起不来）
//     → 本段用一个**没有 inject**、也没有官方席位的 ctx，必须正常 apply 且走旧路径兜底。
//  ② 席位晚声明时要有接管路径（slots.inject 只在声明后回调，另挂 subscribe 兜底）。
// ---------------------------------------------------------------------------
const late = { seats: [] };
const lateDeclared = new Set(["settings.plugin.item"]);
const lateCtx = {
  effect: (fn) => fn(),
  slots: {
    // 如实建模宿主：席位未声明时**不回调**（真机上 slots.inject 就是等声明）
    inject: (name, fn) => { if (lateDeclared.has(name)) fn(); return () => {}; },
    register: (opts, component) => { late.seats.push({ opts, component }); return () => {}; },
    specDynamic: (name) => (lateDeclared.has(name) ? {} : void 0),
    subscribe: () => () => {}
  }
  // 关键：故意不提供 ctx.inject（上一版就是靠它等依赖，导致 web boot 失败）
};
const beforeLate = collect(body, isLegacyEntry).length;
const exportedLate = loaded.factory(fakeRequire);
exportedLate.apply(lateCtx);
if (late.seats.some((s) => s.opts.name === "sidebar.panellist" || s.opts.name === "main")) {
  fail("席位未声明却注册了官方席位（守卫失效）");
}
const afterLate = collect(body, isLegacyEntry).length;
if (afterLate !== beforeLate + 1) {
  fail("席位缺席时旧入口未挂载（兜底失效：" + beforeLate + " → " + afterLate + "，期望 +1）");
}
if (typeof exportedLate.__internals.tryOfficialPanel !== "function") {
  fail("未暴露 tryOfficialPanel（席位晚声明的接管路径无法验证）");
}
// 席位后声明 + layout 服务后到
SIDEBAR_SEATS.forEach((name) => lateDeclared.add(name));
lateCtx.layout = { selectPanel: () => {} };
exportedLate.__internals.tryOfficialPanel();
if (!late.seats.some((s) => s.opts.name === "sidebar.panellist")) fail("席位声明后未接管侧栏行");
if (!late.seats.some((s) => s.opts.name === "main")) fail("席位声明后未接管主栏页面");
if (collect(body, isLegacyEntry).length !== beforeLate) fail("接管后旧入口未撤掉");
// ctx.get 取服务（第三方插件惯用写法，见 @linxin666/dsh-client-ui-market）：layout 也要能拿到
const viaGet = { seats: [], selected: "sentinel" };
const getCtx = {
  effect: (fn) => fn(),
  get: (name) => (name === "layout" ? { selectPanel: (id) => { viaGet.selected = id; } } : void 0),
  slots: {
    inject: (name, fn) => { fn(); return () => {}; },
    register: (opts, component) => { viaGet.seats.push({ opts, component }); return () => {}; },
    specDynamic: (name) => (SIDEBAR_SEATS.includes(name) || name === "settings.plugin.item" ? {} : void 0),
    subscribe: () => () => {}
  }
};
loaded.factory(fakeRequire).apply(getCtx);
const getPage = viaGet.seats.find((s) => s.opts.name === "main");
if (!getPage) fail("ctx.get 路径未注册主栏页面");
const getProps = typeof getPage.opts.inject === "function" ? getPage.opts.inject() : {};
const getRender = runRender(reactStub.createElement(getPage.component, getProps));
const getClose = (getRender.buttons || []).find((b) => String(b.props.className || "").includes("nwClose"));
if (!getClose) fail("ctx.get 路径下主栏页面缺关闭按钮（layout 服务没取到？）");
getClose.props.onClick();
if (viaGet.selected !== null) fail("ctx.get 路径的关闭按钮未调用 layout.selectPanel(null)");
console.log("席位晚声明与兜底（v5.2.0 二次修正）: 无 ctx.inject 依赖（不拖垮启动）✓ | 未声明时不注册 ✓"
  + " | 旧路径兜底 ✓ | 声明后接管两个席位并撤旧 UI ✓ | ctx.get 取 layout ✓");

// v5.5.0 收尾：hook 数量必须跨渲染稳定（否则真机 = 面板白屏）
if (hookViolations.length > 0) {
  fail("hook 数量不稳定（组件被当普通函数直接调用？必须用 createElement）：" + hookViolations.slice(0, 3).join(" ｜ "));
}
console.log("hook 稳定性: " + (process.env.NW_TEST_PRIMITIVES === "1" ? "官方原语路径" : "回退路径") + " 跨视图/弹窗切换零违规 ✓");

cleanupHooks(); // 执行 effect 清理（取消控制器订阅），避免残留句柄影响进程退出console.log("CLIENT OK");
