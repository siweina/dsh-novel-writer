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
  // v6.3.0：插件现在把 dsh-panel-activate 派发在 **document** 上（与同族插件 dsh-ssh / task-board 一致；
  // 旧实现派发在 documentElement 且 bubbles:false，冒泡阶段到不了 document，等于没人收得到）。
  // 这里记录一份派发目标，供断言检查「派发在正确的目标上」——旧断言只能去 documentElement 上找事件，
  // 正是它把那个 bug 锁住的原因。
  _dispatched: [],
  dispatchEvent: function (event) { this._dispatched.push(event); dispatchDocumentEvent(event); return true; }
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
// v6.3.0：断言改为检查 document 上的派发（正确目标），而不是 documentElement
document.documentElement._dispatched.length = 0;
document._dispatched.length = 0;
entries[0].click();
const activated = document.documentElement.dataset.dshNovelWriterActive === "";
const activatedEvent = document._dispatched.find((e) => e.type === "dsh-panel-activate" && e.detail === "novel-writer");
if (!activated) fail("点击入口后面板未激活（documentElement.dataset.dshNovelWriterActive 缺失）");
if (!activatedEvent) fail("点击入口后未在 document 上派发 dsh-panel-activate 事件（detail=novel-writer）");
if (document.documentElement._dispatched.some((e) => e.type === "dsh-panel-activate")) fail("dsh-panel-activate 不应派发在 documentElement 上（bubbles:false 时 document 上的监听收不到）");
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
if (!panelClasses.has("nwPanelHeader") || !panelClasses.has("nwHeaderStatus")) {
  fail("面板缺少标题栏/状态胶囊（className 实际：" + [...panelClasses].join(" ") + "）");
}
// enabled 默认 true → 横幅应为「已开启」态（文案随 locale，取不到则退回状态类名断言）
if (!panelClasses.has("nwHeaderStatusOn") && !panelRender.stats.text.includes("已启用")) {
  fail("面板状态横幅未反映 enabled=true：" + panelRender.stats.text.slice(0, 120));
}
if (panelRender.stats.text.length < 20) fail("面板渲染出的文本过少（" + panelRender.stats.text.length + " 字符），内容可能为空");
console.log("面板组件渲染: 组件数 " + panelRender.stats.components + " | vnode 节点 " + panelRender.stats.nodes
  + " | 文本 " + panelRender.stats.text.length + " 字符 | 类名 " + [...panelClasses].slice(0, 8).join(" ") + " ✓");

// 视图切换：主面板之外的各分支也必须能渲染（旧桩下这些分支零执行）
const panelProps = panelRender.element.props;
const controller = panelProps.controller;
if (controller.getSnapshot().lexiconFormOpen !== false) fail("词表表单展开状态必须初始化为 false");
if (!controller || typeof controller.getSnapshot !== "function") fail("PanelView 未拿到可用的 controller");
for (const view of ["features", "tools", "baseline", "creation", "reports", "model", "lexicon", "diagnose"]) {
  controller.set({ view }, { silent: true });
  if (controller.getSnapshot().view !== view) fail("controller.set 未生效：view=" + view);
}
// v6.2.0：词表页在有数据时也必须能渲染（列表 / 表单 / 展开的批量导入区三条分支）
const lexRenderBefore = renderLog.length;
controller.set({
  view: "lexicon",
  lexicon: {
    ok: true,
    book: "测试",
    scope: "all",
    entries: [
      { term: "星轨", kind: "专名", scene: "战斗", avoid: ["轨道"], note: "跃迁用", scope: "book", enabled: true },
      { term: "潮汐税", kind: "偏好词", scope: "global" }
    ],
    counts: { book: 1, global: 1, effective: 2 },
    books: ["测试", "另一本"],
    bookEnabled: true,
    globalEnabled: true,
    files: { book: "x.json", global: "y.json" },
    dir: "lexicon"
  },
  lexiconQuery: "",
  lexiconFormOpen: true,
  lexiconForm: { term: "青铜灯", kind: "专名", scene: "", avoid: "铜灯,油灯", note: "", editing: "" },
  lexiconImportOpen: true,
  lexiconImportText: "北境哨塔|专名"
}, { silent: true });
if (renderLog.length <= lexRenderBefore) fail("词表页加载数据后未触发重渲染");
// 搜索过滤分支：只留一条
controller.set({ lexiconQuery: "潮汐" }, { silent: true });
controller.set({ lexiconQuery: "" }, { silent: true });

// v7-B: layout and UI-only disclosure must not change lexicon controller contracts.
controller.set({ view: "lexicon", lexiconFormOpen: false, lexiconForm: null, lexiconBusy: false, loading: false }, { silent: true });
const currentB = () => renderLog[renderLog.length - 1].stats;
const primaryB = (stats) => stats.buttons.filter((b) => String(b.props.className || "").split(/\s+/).includes("nwBtnPrimary"));
if (currentB().text.includes("词条详情")) fail("词表表单默认应收起");
if (primaryB(currentB()).length !== 1) fail("词表默认态应只有一个 Primary");
currentB().buttons.find((b) => vnodeText(b) === "新增词条").props.onClick();
if (!controller.getSnapshot().lexiconFormOpen || !currentB().text.includes("词条详情")) fail("新增词条未展开表单");
if (currentB().text.indexOf("星轨") > currentB().text.indexOf("词条详情")) fail("词条列表必须在表单之前");
if (primaryB(currentB()).length !== 1) fail("词表展开态应只有一个 Primary");
currentB().buttons.find((b) => vnodeText(b) === "取消").props.onClick();
if (controller.getSnapshot().lexiconFormOpen || controller.getSnapshot().lexiconForm !== null) fail("取消应收起并重置表单");
currentB().buttons.find((b) => vnodeText(b) === "编辑").props.onClick();
if (!controller.getSnapshot().lexiconFormOpen || controller.getSnapshot().lexiconForm.editing !== "星轨") fail("编辑必须展开原词条表单");
const confirmBeforeB = globalThis.confirm;
const confirmsB = [];
globalThis.confirm = (message) => { confirmsB.push(message); return false; };
try {
  currentB().buttons.find((b) => vnodeText(b) === "删除").props.onClick();
  if (confirmsB.length !== 1 || !confirmsB[0].includes("星轨")) fail("词条删除必须保留二次确认");
  let snapB = Object.assign({}, controller.getSnapshot(), { view: "creation", books: ["测试书"], creationProfile: {}, creationProfiles: { "测试书": { worldview: "世界", genre: "悬疑", extra: "要求" } }, creationBook: "测试书", creationDirty: false, creationDraft: null });
  const writesB = [];
  const ctrlB = Object.assign({}, controller, {
    subscribe: () => () => {}, getSnapshot: () => snapB,
    set: (patch) => { snapB = Object.assign({}, snapB, patch); },
    openView: (view) => { snapB = Object.assign({}, snapB, { view }); }
  });
  const renderB = () => runRender(reactStub.createElement(panelRender.element.type, { controller: ctrlB, toggle: (patch) => writesB.push(patch) }));
  let listB = renderB();
  if (!listB.text.includes("已填 3/6 项") || !listB.text.includes("未填写，全部交给 AI 决定")) fail("设定列表计数/空态不正确");
  if (listB.text.indexOf("默认设定") > listB.text.indexOf("测试书")) fail("默认设定应置顶");
  if (primaryB(listB).length !== 1) fail("设定列表只应有一个 Primary");
  snapB.view = "creation-form";
  let formB = renderB();
  if (primaryB(formB).length !== 1 || vnodeText(primaryB(formB)[0]) !== "保存") fail("设定表单保存应为唯一 Primary");
  for (const helpB of ["告诉 AI 故事发生在哪里", "主要角色的身份", "不希望故事发生", "主角要完成什么", "类型和整体氛围", "其他写作要求"]) if (!formB.text.includes(helpB)) fail("设定字段缺少帮助文字：" + helpB);
  formB.buttons.find((b) => vnodeText(b) === "清空").props.onClick();
  if (writesB.length) fail("取消清空确认后不应写入");
  globalThis.confirm = (message) => { confirmsB.push(message); return true; };
  formB.buttons.find((b) => vnodeText(b) === "清空").props.onClick();
  if (writesB.length !== 1 || writesB[0].creationProfiles["测试书"] !== null) fail("确认清空必须保留按书清空的语义");
  snapB.creationDirty = true;
  globalThis.confirm = () => false;
  renderB().buttons.find((b) => String(b.props.className || "") === "nwCreationBack").props.onClick();
  if (snapB.view !== "creation-form") fail("有草稿时取消返回应留在表单");
  globalThis.confirm = () => true;
  renderB().buttons.find((b) => String(b.props.className || "") === "nwCreationBack").props.onClick();
  if (snapB.view !== "creation") fail("表单轻量返回应进入原创设定列表");
} finally { globalThis.confirm = confirmBeforeB; }
controller.set({ lexiconFormOpen: false, lexiconForm: null }, { silent: true });
console.log("v7-B：词表默认收起/新增编辑展开/取消/唯一主按钮/删除确认 | 设定计数/字段帮助/清空确认/草稿返回确认 ✓");

// ---------------------------------------------------------------------------
// v6.6.0：诊断页（view="diagnose"）——空态 / 有数据态 / 忙态 / 剪贴板三条路径
// 口径：report 由宿主「分享层」渲染（与 novel_diagnose 同一实现），面板**只展示不重拼**；
//      状态 pill 与 issues 行取结构化字段。v7 将正文及建议改为专属排版类。
// ---------------------------------------------------------------------------
const DIAG_REPORT = [
  "【诊断报告】生成于 2026-01-01T00:00:00.000Z",
  "一、书库根",
  "  /tmp/lib-root　来源：调用参数 root",
  "六、近 7 天调用",
  "  共 9 次：正常 7 / 降级 1 / 失败 1"
].join("\n");

// ① 空态：按钮可点、报告块不渲染、复制按钮必须禁用（否则会复制出空内容）
const diagEmptyBefore = renderLog.length;
controller.set({ view: "diagnose", diag: null, diagBusy: false, diagErr: false, diagManual: false, diagDays: "7" }, { silent: true });
if (renderLog.length <= diagEmptyBefore) fail("诊断页空态未触发重渲染（订阅失效）");
const diagEmptyRender = renderLog[renderLog.length - 1];
if (!diagEmptyRender.stats.text.includes("生成诊断报告")) fail("诊断页空态按钮文案应为「生成诊断报告」，实际：" + diagEmptyRender.stats.text.slice(0, 160));
if (!diagEmptyRender.stats.text.includes("最近 7 天")) fail("诊断页空态应把窗口天数填进 {n} 提示（diagFill 未生效？），实际：" + diagEmptyRender.stats.text.slice(0, 160));
if (diagEmptyRender.stats.classes.has("nwDiagReport")) fail("空态不应渲染报告块（.nwDiagReport）");
const diagEmptyCopy = diagEmptyRender.stats.buttons.find((b) => vnodeText(b).includes("复制诊断包"));
if (!diagEmptyCopy) fail("诊断页缺少「复制诊断包」按钮");
if (diagEmptyCopy.props.disabled !== true) fail("无报告时「复制诊断包」应禁用");

// ② 有数据态：report 原文进 .nwReportPre；三档计数 pills + error/warn/info 三种语义类
const diagDataBefore = renderLog.length;
controller.set({
  view: "diagnose",
  diagDays: "7",
  diagBusy: false,
  diagErr: false,
  diagManual: false,
  diag: {
    action: "report",
    days: 7,
    root: { path: "/tmp/lib-root", source: "调用参数 root", looksLikeLibraryRoot: true },
    dataDir: { path: "/tmp/state/.novel-writer", exists: true, bytes: 2048, files: 3 },
    log: { dir: "/tmp/state/logs", bytes: 512, files: 1 },
    calls: { total: 9, ok: 7, degraded: 1, failed: 1 },
    issues: [
      { level: "error", title: "书库根可能不对", detail: "根下既无 novels/ 也无 .novel-writer/", suggestion: "把根指向 novels 的父目录" },
      { level: "warn", title: "近期有工具调用失败：1 次", detail: "自由文本已剔除（原文请看本地日志）", suggestion: "先看 topCodes 里最多的那个 code" },
      { level: "info", title: "还没有插件数据目录", detail: "首次使用属正常。", suggestion: "无需处理。" }
    ],
    report: DIAG_REPORT,
    // 合成自由文本字段：面板只该用**结构化字段 + report** 组报告/诊断包，这两个不得出现在页面或剪贴板里
    note: "不应外泄的自由文本-NOTE",
    detail: "不应外泄的自由文本-DETAIL"
  }
}, { silent: true });
if (renderLog.length <= diagDataBefore) fail("诊断页加载数据后未触发重渲染");
const diagRender = renderLog[renderLog.length - 1];
if (!diagRender.stats.classes.has("nwDiagReport")) fail("诊断页未用可选择滚动的 .nwDiagReport 渲染宿主报告块");
if (!diagRender.stats.text.includes("【诊断报告】生成于 2026-01-01T00:00:00.000Z")) fail("诊断页未把宿主 report 原文渲染出来（面板不得重拼报告）");
if (!diagRender.stats.classes.has("nwPill") || !diagRender.stats.classes.has("nwPillKey") || !diagRender.stats.classes.has("nwPillVal")) fail("诊断页缺少调用统计 pills（nwPill/nwPillKey/nwPillVal）");
if (!diagRender.stats.text.includes("使用次数9") || !diagRender.stats.text.includes("简化处理1") || !diagRender.stats.text.includes("未成功1")) {
  fail("pills 的计数必须来自结构化字段 calls，实际文本：" + diagRender.stats.text.slice(0, 200));
}
if (!diagRender.stats.classes.has("nwPlotErr")) fail("error 级 issue 应走既有语义色类 nwPlotErr");
if (!diagRender.stats.classes.has("nwNoteWarn")) fail("warn 级 issue 应走既有 nwNoteWarn");
if (!diagRender.stats.classes.has("nwNote")) fail("info 级 issue 应使用清晰可见的中性 Note");
if (!diagRender.stats.classes.has("nwDiagDetail")) fail("issue 的建议行应显示为中性说明文字");
if (!diagRender.stats.text.includes("书库根可能不对")) fail("诊断页未渲染 issue 标题");
if (!diagRender.stats.text.includes("建议：把根指向 novels 的父目录")) fail("诊断页未渲染 issue 建议（应带「建议：」前缀）");
if (diagRender.stats.text.includes("不应外泄")) fail("诊断页把 data 里的自由文本字段渲染出来了（只应使用结构化字段 + report）");

// ③ 忙态：文案切到「诊断中…」且按钮禁用（避免重复触发）
const diagBusyBefore = renderLog.length;
controller.set({ diagBusy: true }, { silent: true });
if (renderLog.length <= diagBusyBefore) fail("诊断忙态未触发重渲染");
const diagBusyRender = renderLog[renderLog.length - 1];
if (!diagBusyRender.stats.text.includes("诊断中")) fail("诊断中应显示「诊断中…」，实际：" + diagBusyRender.stats.text.slice(0, 160));
const diagBusyRun = diagBusyRender.stats.buttons.find((b) => vnodeText(b).includes("诊断中"));
if (!diagBusyRun || diagBusyRun.props.disabled !== true) fail("诊断中应禁用「生成/重新生成」按钮");
const diagBusyCopy = diagBusyRender.stats.buttons.find((b) => vnodeText(b).includes("复制诊断包"));
if (!diagBusyCopy || diagBusyCopy.props.disabled !== true) fail("诊断中应禁用「复制诊断包」按钮");
controller.set({ diagBusy: false }, { silent: true });

// ④ 窗口天数：UI 字符串值 → 请求值是**同一口径**，且钳到 [1, 90]
controller.set({ diagDays: "abc" }, { silent: true });
if (controller.diagDaysNum() !== 7) fail("diagDays 非数值应回退 7，实际 " + controller.diagDaysNum());
controller.set({ diagDays: "999" }, { silent: true });
if (controller.diagDaysNum() !== 90) fail("diagDays 超上限应钳到 90，实际 " + controller.diagDaysNum());
controller.set({ diagDays: "0" }, { silent: true });
if (controller.diagDaysNum() !== 7) fail("diagDays=0 应回退 7，实际 " + controller.diagDaysNum());
controller.set({ diagDays: "30" }, { silent: true });
if (controller.diagDaysNum() !== 30) fail("diagDays=30 应原样，实际 " + controller.diagDaysNum());
if (controller.diagUrl() !== "/api/dsh-novel-writer/diagnose?days=30") fail("诊断请求 URL 不对：" + controller.diagUrl());
controller.set({ diagDays: "7" }, { silent: true });

// ⑤ 现取：loadDiagnose 打到同一个 URL、写回 state.diag；失败时**保留上一份报告**
const realFetch = globalThis.fetch;
const diagFetched = [];
globalThis.fetch = (url) => {
  diagFetched.push(String(url));
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, report: "【诊断报告】FROM-STUB", calls: { total: 3, ok: 3, degraded: 0, failed: 0 }, issues: [] }) });
};
try {
  controller.set({ view: "diagnose", diag: null, diagBusy: false, diagErr: false, diagDays: "7" }, { silent: true });
  controller.loadDiagnose();
  if (controller.getSnapshot().diagBusy !== true) fail("loadDiagnose 期间应置 diagBusy=true");
  await new Promise((resolve) => setImmediate(resolve));
  if (diagFetched.length !== 1) fail("loadDiagnose 应只发一次请求，实际 " + diagFetched.length);
  if (diagFetched[0] !== "/api/dsh-novel-writer/diagnose?days=7") fail("loadDiagnose 请求 URL 不对：" + diagFetched[0]);
  const diagState = controller.getSnapshot();
  if (diagState.diagBusy !== false || diagState.diagErr !== false) fail("loadDiagnose 成功后应清掉 busy/err");
  if (!diagState.diag || diagState.diag.report !== "【诊断报告】FROM-STUB") fail("loadDiagnose 未把响应写进 state.diag");
  globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
  controller.loadDiagnose();
  await new Promise((resolve) => setImmediate(resolve));
  const diagState2 = controller.getSnapshot();
  if (diagState2.diagErr !== true) fail("loadDiagnose 失败应置 diagErr=true");
  if (!diagState2.diag || diagState2.diag.report !== "【诊断报告】FROM-STUB") fail("loadDiagnose 失败时不得清掉上一份报告（那是仅有的可分享材料）");
} finally {
  globalThis.fetch = realFetch;
}

// ⑥ 剪贴板三条路径：可用 → 写入诊断包并提示成功；被拒 → 不谎报成功；不可用 → 同样降级
const clipTexts = [];
function installClipboard(writeText) {
  try {
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, writable: true, value: { writeText } });
    return true;
  } catch { return false; }
}
function removeClipboard() {
  try { delete globalThis.navigator.clipboard; return true; } catch { return false; }
}
controller.set({
  view: "diagnose", diagBusy: false, diagErr: false, diagManual: false, diagDays: "7",
  diag: {
    action: "report", days: 7,
    root: { path: "/tmp/lib-root", source: "调用参数 root" },
    dataDir: { path: "/tmp/state/.novel-writer", exists: true },
    log: { dir: "/tmp/state/logs" },
    calls: { total: 9, degraded: 1, failed: 1 },
    issues: [],
    report: DIAG_REPORT,
    note: "不应外泄的自由文本-NOTE"
  }
}, { silent: true });
if (installClipboard((text) => { clipTexts.push(text); return Promise.resolve(); })) {
  controller.diagCopy();
  await new Promise((resolve) => setImmediate(resolve));
  if (clipTexts.length !== 1) fail("剪贴板可用时 diagCopy 未调用 writeText");
  const pack = clipTexts[0];
  if (!pack.startsWith(DIAG_REPORT)) fail("诊断包应以宿主 report 原文开头（不得由面板重拼）");
  if (!pack.includes("---- ") || !pack.includes("----")) fail("诊断包应含环境信息分区");
  if (!pack.includes("/tmp/lib-root")) fail("诊断包应含书库根路径");
  if (pack.includes("不应外泄")) fail("诊断包不得包含 data 里的自由文本字段");
  if (controller.getSnapshot().diagManual === true) fail("复制成功后不应保留「手动复制」提示");
  if (controller.getSnapshot().revealErr === true) fail("复制成功后不应是错误提示");
  if (!String(controller.getSnapshot().revealMsg).includes("已复制")) fail("复制成功提示不对：" + controller.getSnapshot().revealMsg);
  // 被拒 → 降级为手动复制，不谎报成功
  installClipboard(() => Promise.reject(new Error("denied")));
  controller.diagCopy();
  await new Promise((resolve) => setImmediate(resolve));
  if (controller.getSnapshot().diagManual !== true || controller.getSnapshot().revealErr !== true) fail("剪贴板被拒时必须降级为「手动复制」提示，不得谎报成功");
  console.log("诊断页: 空态/有数据态/忙态 ✓ | report 原文入 nwDiagReport ✓ | 窗口钳制 [1,90] ✓ | 剪贴板：写入成功 / 被拒降级 ✓");
} else {
  console.log("诊断页: 空态/有数据态/忙态 ✓ | report 原文入 nwDiagReport ✓ | 窗口钳制 [1,90] ✓ | 本环境无法替换 navigator.clipboard，剪贴板分支只测降级");
}
removeClipboard();
controller.set({ diagManual: false, revealErr: false, revealMsg: "" }, { silent: true });
controller.diagCopy();
if (controller.getSnapshot().diagManual !== true) fail("剪贴板不可用时 diagCopy 必须降级为「手动复制」提示");
// 无报告时点复制 → 明确提示，不静默
controller.set({ diag: null, diagManual: false, revealErr: false, revealMsg: "" }, { silent: true });
controller.diagCopy();
if (controller.getSnapshot().revealErr !== true || !String(controller.getSnapshot().revealMsg).includes("还没有诊断报告")) {
  fail("无报告时点复制应提示「还没有诊断报告」，实际：" + controller.getSnapshot().revealMsg);
}
// 降级提示必须真的渲染出来（diagManual=true）
controller.set({ view: "diagnose", diag: { report: DIAG_REPORT, calls: { total: 1 }, issues: [] }, diagManual: true, diagBusy: false, diagErr: false }, { silent: true });
const diagManualRender = renderLog[renderLog.length - 1];
if (!diagManualRender.stats.text.includes("手动")) fail("diagManual=true 时应渲染「手动复制」提示，实际：" + diagManualRender.stats.text.slice(0, 160));
controller.set({ view: "main", diagManual: false, diagErr: false, revealMsg: "" }, { silent: true });

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
// v7：非完整档不渲染场景行；完整档可点且仍提交原 promptScene。
// 这是 IA 规格替代 v5.1.1 的“非 full 场景恒可点”，不是删除行为覆盖。
const segButtonsOf = (stats) => (stats.buttons || []).filter((b) => {
  const cls = String(b.props.className || "");
  return cls.includes("nwSegBtn") || b.props.role === "tab";
});
const SCENE_LABELS = ["通用", "写新章", "改稿", "审计", "建资料"];
const MODE_LABELS = ["关闭", "精简", "完整"];
for (const mode of ["off", "brief"]) {
  controller.set({ view: "main", loading: false, systemPromptMode: mode, promptScene: "general" }, { silent: true });
  const rendered = renderLog[renderLog.length - 1].stats;
  const btns = segButtonsOf(rendered);
  if (btns.length !== 3) fail("非完整档只应显示 3 个档位按钮：" + mode + " / " + btns.length);
  if (rendered.text.includes("提示词场景")) fail("非完整档不应渲染场景行：" + mode);
  for (const b of btns) if (b.props.disabled === true) fail("非加载态档位按钮不可禁用");
}
controller.set({ view: "main", systemPromptMode: "full", promptScene: "general", loading: false }, { silent: true });
const fullRender = renderLog[renderLog.length - 1].stats;
const fullBtns = segButtonsOf(fullRender);
if (fullBtns.length !== 8) fail("完整档应显示 3+5 个分段按钮");
const sceneBtns = fullBtns.filter((b) => SCENE_LABELS.includes(vnodeText(b).trim()));
if (sceneBtns.length !== 5) fail("完整档缺少场景按钮");
for (const b of fullBtns) {
  if (b.props.disabled === true) fail("完整档非加载态分段按钮不应禁用");
  if (typeof b.props.onClick !== "function") fail("完整档分段按钮缺少回调");
}
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
controller.set({ loading: true }, { silent: true });
for (const b of segButtonsOf(renderLog[renderLog.length - 1].stats)) {
  if (!b.props.disabled) fail("加载态分段按钮必须禁用");
}
controller.set({ loading: false }, { silent: true });
console.log("v7 提示词场景：off/brief 隐藏 | full 8 个可用按钮 | 写新章提交原 promptScene | loading 禁用 ✓");

// 主页 IA 与共享外壳：真实入口保留，纯 UI 折叠不增加 controller 状态/hook。
const homeStats = renderLog[renderLog.length - 1].stats;
const navButtons = homeStats.buttons.filter((b) => String(b.props.className || "").split(/\s+/).includes("nwNavEntry"));
const expectedNav = ["原创设定", "必用词表", "风格基线", "功能开关", "工具开关", "语义模型", "报告历史", "诊断报告", "体验演示"];
if (navButtons.length !== expectedNav.length) fail("主页应有 9 个导航/操作行");
for (let i = 0; i < expectedNav.length; i++) {
  if (!vnodeText(navButtons[i]).startsWith(expectedNav[i])) fail("主页入口顺序错误：" + i + " / " + vnodeText(navButtons[i]));
}
if (homeStats.classes.has("nwHero") || homeStats.classes.has("nwSwitchWrap")) fail("主页仍有 Hero 或开关状态徽章容器");
if (!homeStats.classes.has("nwStorage") || !homeStats.classes.has("nwLibrary")) fail("主页缺少存储位置/书库折叠区");
if (!homeStats.text.includes("18+")) fail("危险行必须有文字 18+ 标签");
navButtons[5].props.onClick();
if (controller.getSnapshot().view !== "model") fail("主页语义模型入口未打开 model");
const modelRender = renderLog[renderLog.length - 1].stats;
if (modelRender.classes.has("nwHero") || modelRender.classes.has("nwSectionTitle")) fail("子页仍有 Hero/重复胶囊标题");
const headerBack = modelRender.buttons.filter((b) => String(b.props.className || "").includes("nwBackBtn"));
if (headerBack.length !== 1 || !vnodeText(headerBack[0]).includes("写作助手")) fail("子页必须仅有一个标题栏返回入口");
headerBack[0].props.onClick();
if (controller.getSnapshot().view !== "main") fail("标题栏返回应回到主页");
console.log("v7 主页：9 入口顺序/语义模型直达/存储与书库折叠/18+ 标签/子页标题栏返回 ✓");

// ---------------------------------------------------------------------------
// StorageDisclosure 只转发 controller 既有方法，不另建剪贴板或打开目录路径。
const storageCalls = [];
const storageController = Object.assign({}, controller, {
  subscribe: () => () => {},
  getSnapshot: () => Object.assign({}, controller.getSnapshot(), { view: "main", dirs: { dataDir: "/tmp/data", stateFile: "/tmp/state.json" }, revealing: false }),
  openDir: (key) => storageCalls.push(["open", key]),
  copyPath: (path) => storageCalls.push(["copy", path])
});
const storageRender = runRender(reactStub.createElement(panelRender.element.type, { controller: storageController, toggle: () => {} }));
const storageBtns = storageRender.buttons.filter((b) => String(b.props.className || "").includes("nwStorageBtn"));
if (storageBtns.length !== 4) fail("两条存储位置应提供打开/复制共 4 个按钮");
for (const b of storageBtns) { if (b.props.disabled) fail("已有路径时存储操作不可禁用"); b.props.onClick(); }
if (JSON.stringify(storageCalls) !== JSON.stringify([["open", "data-dir"], ["copy", "/tmp/data"], ["open", "state-file"], ["copy", "/tmp/state.json"]])) fail("存储位置未转发既有 controller 方法：" + JSON.stringify(storageCalls));
const unknownStorage = Object.assign({}, storageController, { getSnapshot: () => Object.assign({}, storageController.getSnapshot(), { dirs: {}, dataDir: "", file: "" }) });
const unknownStorageRender = runRender(reactStub.createElement(panelRender.element.type, { controller: unknownStorage, toggle: () => {} }));
if (unknownStorageRender.buttons.filter((b) => String(b.props.className || "").includes("nwStorageBtn")).some((b) => !b.props.disabled)) fail("路径未知时存储操作必须禁用");
console.log("v7 存储位置：打开/复制调用既有 controller | 两条路径映射正确 | 未知路径禁用 ✓");

// v7-A：只改呈现，不改默认开启、批量开关、loading 与导航行为。
const aTools = {
  analyze: ["novel_books", "novel_chapters", "novel_read", "novel_keywords", "novel_sentence_analysis", "novel_style_check", "novel_fix_plan", "novel_style_report", "novel_semantic_search", "novel_continuity_check", "novel_diagnose"],
  settings: ["novel_settings", "novel_plot", "novel_summary", "novel_import"],
  create: ["novel_chapter_brief", "novel_lexicon", "novel_new_chapter", "novel_outline"]
};
const aGroupLabels = { analyze: "分析作品", settings: "整理资料", create: "开始创作" };
const aPatches = [], aActions = [];
let aSnapshot = Object.assign({}, controller.getSnapshot(), {
  view: "tools", loading: false, tools: {}, features: {},
  rawModal: false, rawPromiseOpen: false,
  toolGroupOpen: { analyze: true, settings: true, create: true },
  dirs: { dataDir: "/tmp/data", analysisDir: "/tmp/data", auditsDir: "/tmp/audits", settingsDir: "/tmp/settings", plotsDir: "/tmp/plots", summariesDir: "/tmp/summaries", lexiconDir: "/tmp/lexicon", embeddingDir: "/tmp/embedding" }
});
const aController = Object.assign({}, controller, {
  subscribe: () => () => {}, getSnapshot: () => aSnapshot,
  openView: (view) => aActions.push(["view", view]),
  setToolGroupOpen: (patch) => aActions.push(["groups", patch])
});
const aRender = (patch = {}) => {
  aSnapshot = Object.assign({}, aSnapshot, patch);
  return runRender(reactStub.createElement(panelRender.element.type, { controller: aController, toggle: (patch) => aPatches.push(patch) }));
};
const aSwitches = (stats) => stats.buttons.filter((b) => b.props.role === "switch");
const aSwitch = (stats, label) => aSwitches(stats).find((b) => b.props["aria-label"] === label);
const aChecked = (button) => String(button.props["aria-checked"]) === "true";
let aStats = aRender();
if (aSwitches(aStats).length !== 22) fail("工具页应有 19 个工具开关 + 3 个全部开关");
if (aSwitches(aStats).some((b) => !aChecked(b))) fail("未配置的工具必须默认开启");
if (aStats.classes.has("nwToolRowOn") || aStats.classes.has("nwToolGroupBadge") || aStats.classes.has("nwPlotBox")) fail("工具页仍有蓝底、关闭徽章或行内路径");
if (!aStats.classes.has("nwGCard") || !aStats.classes.has("nwPref") || !aStats.classes.has("nwStorage")) fail("工具页未复用统一卡片、偏好行或存储折叠区");
if (/tool\.novel_|novel_diagnose/.test(aStats.text) || !aStats.text.includes("生成可安全分享的插件诊断报告")) fail("诊断工具缺少人话文案");
if (aStats.buttons.filter((b) => String(b.props.className || "").includes("nwStorageBtn")).length !== 12) fail("工具页存储路径未按实际路径去重");
for (const [group, names] of Object.entries(aTools)) {
  for (const mode of ["on", "off", "partial"]) {
    const states = Object.fromEntries(names.map((name, i) => [name, mode === "on" || (mode === "partial" && i > 0)]));
    aStats = aRender({ tools: states });
    const all = aSwitch(aStats, aGroupLabels[group] + " · 全部");
    if (!all || aChecked(all) !== (mode === "on")) fail("全部开关状态错误：" + group + "/" + mode);
    all.props.onClick();
    const expected = { tools: Object.fromEntries(names.map((name) => [name, mode !== "on"])) };
    if (JSON.stringify(aPatches.at(-1)) !== JSON.stringify(expected)) fail("批量开关范围/目标改变：" + group + "/" + mode);
  }
}
aStats = aRender({ tools: { novel_diagnose: false } });
aSwitch(aStats, "诊断报告").props.onClick();
if (JSON.stringify(aPatches.at(-1)) !== JSON.stringify({ tools: { novel_diagnose: true } })) fail("单工具开关未提交原 tools patch");
const aFold = aStats.buttons.find((b) => String(b.props.className || "").includes("nwToolGroupHeadBtn"));
if (aFold.props["aria-expanded"] !== true) fail("分类折叠按钮缺少展开状态");
aFold.props.onClick();
if (aActions.at(-1)[1].analyze !== false || aActions.at(-1)[1].settings !== true) fail("分类展开动作不应修改其它分类");
aStats = aRender({ loading: true });
if (aSwitches(aStats).some((b) => !b.props.disabled)) fail("loading 时工具和全部开关必须禁用");
aStats = aRender({ view: "features", loading: false, features: { semanticEmbedding: false } });
if (aSwitches(aStats).length !== 6 || aStats.classes.has("nwSwitchWrap")) fail("功能页开关数或多余状态徽章错误");
const aModelLink = aStats.buttons.find((b) => vnodeText(b) === "模型设置 ›");
if (!aModelLink) fail("功能页缺少行尾模型设置按钮");
aModelLink.props.onClick({ stopPropagation() {} });
if (aActions.at(-1)[1] !== "model") fail("模型设置未打开 model 视图");
aSwitch(aStats, "语义增强").props.onClick();
if (JSON.stringify(aPatches.at(-1)) !== JSON.stringify({ features: { semanticEmbedding: true } })) fail("功能开关未提交原 features patch");
aStats = aRender({ loading: true });
if (aSwitches(aStats).some((b) => !b.props.disabled)) fail("loading 时功能开关必须禁用");
aStats = aRender({ view: "model", loading: false, features: { semanticEmbedding: false, semanticStyle: false }, embeddingStatus: { modelPresent: true, loaded: true } });
if (aSwitches(aStats).length !== 3 || !aStats.classes.has("nwStorage") || !aStats.text.includes("可用 · 模型已加载")) fail("模型页缺少状态卡、三个子功能或存储折叠区");
if (aSwitches(aStats).some((b) => b.props.disabled)) fail("模型总开关关闭不应改变原子开关可编辑行为");
aSwitch(aStats, "语义风格对比").props.onClick();
if (JSON.stringify(aPatches.at(-1)) !== JSON.stringify({ features: { semanticStyle: true } })) fail("模型子功能开关 patch 改变");
console.log("v7-A：工具默认值/三组全开全关混合态/单工具 patch/分类折叠/loading/路径去重/模型设置/子功能行为 ✓");

// v7-C：只友好化展示，文件读取名不变；基线空态与唯一主按钮。
const cViewSnapshot = Object.assign({}, controller.getSnapshot(), {
  view: "baseline", loading: false, baselineBook: "", baselineErr: true,
  revealErr: true, revealMsg: "book is required", books: ["测试书"],
  dirs: { dataDir: "/tmp/data", stateFile: "/tmp/state.json", analysisDir: "/tmp/analysis" }
});
const cViewController = Object.assign({}, controller, { subscribe: () => () => {}, getSnapshot: () => cViewSnapshot });
const cRender = () => runRender(reactStub.createElement(panelRender.element.type, { controller: cViewController, toggle: () => {} }));
const cBase = cRender();
if (!cBase.text.includes("先选择一本书") || cBase.text.includes("book is required") || cBase.text.includes("v3.0.0-UI3")) fail("基线未选书必须显示人话空态，不能泄露原始错误或调试版本");
if (cBase.buttons.filter((b) => /nwBtnPrimary/.test(b.props.className || "")).length !== 1) fail("基线必须只有一个主按钮");
if (!cBase.classes.has("nwBaseTolRow") || cBase.classes.has("nwTolSep") || cBase.classes.has("nwTolSign")) fail("基线容差应使用对齐网格，不再显示游离正负号和波浪号");
Object.assign(cViewSnapshot, { view: "reports", revealMsg: "", revealErr: false, reportContent: null, reportsGroups: [
  { name: "句式分析", files: [
    { file: "测试书__base-full.json", label: "测试书__base-full" },
    { file: "测试书-chapters-metrics.json", label: "测试书-chapters-metrics" },
    { file: "测试书-full.json", label: "测试书-full" },
    { file: "测试书-keywords-1234.json", label: "测试书-keywords-1234" }
  ] },
  { name: "风格判断", files: [{ file: "abcdef0123456789.json", label: "abcdef0123456789" }, { file: "unknown-format.json", label: "unknown-format" }] }
] });
const cReports = cRender();
for (const text of ["测试书", "全书基线", "逐章指标", "全书分析", "关键词", "单段分析", "abcdef", "unknown-format"]) {
  if (!cReports.text.includes(text)) fail("报告展示缺少：" + text);
}
if (!cReports.text.includes("测试书4") || cReports.text.includes("风格判断")) fail("报告必须跨目录合并为按书分组并显示报告数");
const cFiles = cReports.buttons.filter((b) => /nwReportsFile/.test(b.props.className || ""));
if (cFiles.length !== 6 || cFiles[0].props.title !== "测试书__base-full.json") fail("报告行应保留原始文件身份");
const cSavedFetch = globalThis.fetch;
const cReadPending = [];
cViewController.set = (patch) => Object.assign(cViewSnapshot, patch);
globalThis.fetch = (url) => new Promise((resolve) => cReadPending.push({ url: String(url), resolve }));
try {
  cFiles[0].props.onClick();
  cFiles[2].props.onClick();
  if (cReadPending[0].url !== "/api/dsh-novel-writer/reports?read=" + encodeURIComponent("测试书__base-full.json")) fail("友好报告名改变了原文件请求");
  cReadPending[1].resolve({ ok: true, json: () => Promise.resolve({ ok: true, content: { id: "new" } }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  cReadPending[0].resolve({ ok: true, json: () => Promise.resolve({ ok: true, content: { id: "old" } }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (cViewSnapshot.reportContent !== JSON.stringify({ id: "new" }, null, 2)) fail("旧报告响应覆盖了新报告，reqId 过期丢弃失效");
} finally { globalThis.fetch = cSavedFetch; }
console.log("v7-C：基线空态/唯一主按钮/网格 | 报告按书分组/名称映射/原文件请求/reqId 过期丢弃 ✓");

// 导航行重排不能丢掉 reports 入口加载、demo 的不落盘与 finally 复位行为。
const homeFetch = globalThis.fetch;
const homeRequests = [];
globalThis.fetch = (url) => {
  homeRequests.push(String(url));
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(String(url).endsWith("/reports") ? { groups: [{ book: "测试书", files: [{ file: "r.json" }] }] } : { ok: true, report: "演示报告" }) });
};
try {
  controller.set({ view: "main", demoLoading: false, reportsGroups: null }, { silent: true });
  let currentHome = renderLog[renderLog.length - 1].stats;
  currentHome.buttons.find((b) => String(b.props.className || "").includes("nwNavEntry") && vnodeText(b).startsWith("报告历史")).props.onClick();
  if (controller.getSnapshot().view !== "reports") fail("报告历史入口未进入 reports");
  await new Promise((resolve) => setImmediate(resolve));
  if (!controller.getSnapshot().reportsGroups || controller.getSnapshot().reportsGroups.length !== 1) fail("报告历史入口未保存读取结果");
  controller.set({ view: "main" }, { silent: true });
  currentHome = renderLog[renderLog.length - 1].stats;
  currentHome.buttons.find((b) => String(b.props.className || "").includes("nwNavEntry") && vnodeText(b).startsWith("体验演示")).props.onClick();
  if (!controller.getSnapshot().demoLoading) fail("演示入口未设置加载状态");
  await new Promise((resolve) => setImmediate(resolve));
  if (controller.getSnapshot().demoLoading || controller.getSnapshot().demoReport !== "演示报告") fail("演示未显示结果/复位 loading");
  if (JSON.stringify(homeRequests) !== JSON.stringify(["/api/dsh-novel-writer/reports", "/api/dsh-novel-writer/demo"])) fail("主页入口请求发生变化或增加了计数请求：" + JSON.stringify(homeRequests));
} finally { globalThis.fetch = homeFetch; }
console.log("v7 主页加载：报告真实入口读取 | 演示结果与 loading 复位 | 不新增计数请求 ✓");

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
const late = { seats: [], callbacks: new Map() };
const lateDeclared = new Set(["settings.plugin.item"]);
let lateCleanup;
const lateCtx = {
  effect: (fn) => { lateCleanup = fn(); },
  slots: {
    // 如实建模宿主：席位未声明时**不回调**（真机上 slots.inject 就是等声明）
    inject: (name, fn) => { if (lateDeclared.has(name)) fn(); return () => {}; },
    register: (opts, component) => { late.seats.push({ opts, component }); return () => {}; },
    specDynamic: (name) => (lateDeclared.has(name) ? {} : void 0),
    subscribe: (name, callback) => {
      late.callbacks.set(name, callback);
      return () => { late.callbacks.delete(name); };
    }
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
// Let sidebar arrive first and main last. The main event must trigger takeover.
if (!late.callbacks.has("sidebar.panellist") || !late.callbacks.has("main")) {
  fail("两个官方席位都必须订阅晚声明事件");
}
lateDeclared.add("sidebar.panellist");
late.callbacks.get("sidebar.panellist")?.();
if (late.seats.some((s) => s.opts.name === "main")) fail("仅侧栏席位声明时过早接管");
lateDeclared.add("main");
lateCtx.layout = { selectPanel: () => {} };
late.callbacks.get("main")?.();
if (!late.seats.some((s) => s.opts.name === "sidebar.panellist")) fail("席位声明后未接管侧栏行");
if (!late.seats.some((s) => s.opts.name === "main")) fail("席位声明后未接管主栏页面");
if (collect(body, isLegacyEntry).length !== beforeLate) fail("接管后旧入口未撤掉");
const firstLateSeatCount = late.seats.length;
lateCleanup();
if (late.callbacks.size !== 0) fail("卸载后席位订阅未清理");
exportedLate.apply(lateCtx);
if (late.seats.length <= firstLateSeatCount) fail("同一模块实例卸载后再次 apply 未重新注册席位");
lateCleanup();
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

cleanupHooks(); // 执行 effect 清理（取消控制器订阅），避免残留句柄影响进程退出
// v6.3.0：成功标记原先被吞进上一行的行尾注释里（`…进程退出console.log("CLIENT OK");`），
// 等于这一行从来没打印过——既有缺陷（v6.2.0 起就在），本次一并修掉。
console.log("CLIENT OK");
