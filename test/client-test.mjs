// 客户端模块加载模拟：验证 __ModuleLoader__ 契约（含 inject 声明）、侧边栏/面板/设置槽位
globalThis.window = globalThis;
// v3.5.0 M22：最小 DOM mock——让侧边栏挂载流程真实执行（否则 apply 静默跳过挂载=假 PASS）
const elStub = () => ({
  style: {}, dataset: {}, classList: { add() {}, remove() {} },
  setAttribute() {}, addEventListener() {}, removeEventListener() {},
  appendChild() {}, remove() {}, contains() { return false; }, isConnected: false,
  parentElement: null, firstElementChild: null, querySelector() { return null; }
});
globalThis.document = {
  createElement: elStub,
  querySelector: () => null,
  body: elStub(),
  head: elStub(),
  documentElement: { lang: "zh", dataset: {} },
  addEventListener() {}, removeEventListener() {}
};
globalThis.MutationObserver = class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} };
const loaded = {};
globalThis.__ModuleLoader__ = {
  load: (spec) => { loaded.id = spec.id; loaded.factory = spec.factory; }
};

await import("../lib/client.js");

console.log("注册 id:", loaded.id, loaded.id === "dsh-novel-writer" ? "✓" : "✗ 应为包名!");
console.log("factory 类型:", typeof loaded.factory);

const fakeRequire = (name) => {
  if (name === "react") return { createElement: () => ({}), useEffect: () => {}, useState: () => [false, () => {}] };
  if (name === "react-dom/client") return { createRoot: () => ({ render() {}, unmount() {} }) };
  throw new Error("意外的 require: " + name);
};

const exported = loaded.factory(fakeRequire);
console.log("导出:", Object.keys(exported).join(", "));
console.log("inject 声明:", JSON.stringify(exported.inject), JSON.stringify(exported.inject) === JSON.stringify(["slots", "locale"]) ? "✓" : "✗ 缺少 inject!");
console.log("apply 类型:", typeof exported.apply);

let slotRegistered = null;
const ctx = {
  effect: (fn) => fn(),
  slots: {
    inject: (name, fn) => { fn(); },
    register: (opts, component) => { slotRegistered = { opts, component }; }
  }
};
// v3.5.0 M22：apply 抛错/槽位未注册 = FAIL（不再假 PASS）
try {
  exported.apply(ctx);
} catch (err) {
  console.error("CLIENT FAIL: apply 抛错:", err);
  process.exit(1);
}
if (!slotRegistered || typeof slotRegistered.component !== "function") {
  console.error("CLIENT FAIL: 设置槽位未注册（挂载未执行）");
  process.exit(1);
}
console.log("设置槽位注册:", slotRegistered.opts?.name, "| id:", slotRegistered.opts?.id, "| 组件:", typeof slotRegistered.component, "✓");
console.log("CLIENT OK");
