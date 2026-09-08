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

const fakeRequire = (name) => {
  if (name === "react") return { createElement: () => ({}), useEffect: () => {}, useState: () => [false, () => {}] };
  if (name === "react-dom/client") return { createRoot: () => ({ render() {}, unmount() {} }) };
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
console.log("CLIENT OK");
