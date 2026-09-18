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

const fakeRequire = (name) => {
  if (name === "react") return reactStub;
  if (name === "react-dom/client") return { createRoot };
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
const ctx = {
  effect: (fn) => fn(),
  slots: {
    inject: (name, fn) => { fn(); },
    register: (opts, component) => { slotRegistered = { opts, component }; }
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
const segBtns = (featsRender.stats.buttons || []).filter((b) => String(b.props.className || "").includes("nwSegBtn"));
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
const probeSegs = (probeRender.buttons || []).filter((b) => String(b.props.className || "").includes("nwSegBtn"));
const writingBtn = probeSegs.find((b) => vnodeText(b).trim() === "写新章");
if (!writingBtn) fail("探针渲染后找不到「写新章」按钮（找到：" + probeSegs.map((b) => vnodeText(b).trim()).join("/") + "）");
writingBtn.props.onClick();
if (probe.length !== 1 || probe[0].promptScene !== "writing") {
  fail("点击场景按钮未提交 promptScene=writing（实际 " + JSON.stringify(probe) + "）");
}
const currentBtn = probeSegs.find((b) => b.props.className.includes("nwSegBtnOn") && SCENE_LABELS.includes(vnodeText(b).trim()));
if (currentBtn && vnodeText(currentBtn).trim() !== "通用") fail("当前场景高亮错位：" + vnodeText(currentBtn).trim());
console.log("场景按钮可点（v5.1.1）: 8 个分段按钮全部可点 | 点击「写新章」→ toggle({promptScene:\"writing\"}) ✓ | 档位非 full 时提示「暂不注入」✓");

cleanupHooks(); // 执行 effect 清理（取消控制器订阅），避免残留句柄影响进程退出
console.log("CLIENT OK");
