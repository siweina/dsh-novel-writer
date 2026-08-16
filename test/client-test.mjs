// 客户端模块加载模拟：验证 client.js 的 __ModuleLoader__ 契约（含 inject 声明）与 apply
globalThis.window = globalThis;
const loaded = {};
globalThis.__ModuleLoader__ = {
  load: (spec) => {
    loaded.id = spec.id;
    loaded.factory = spec.factory;
  }
};

await import("file:///D:/Deep%20Seek%E6%8F%92%E4%BB%B6%E5%BA%93/novel-writer/client.js");

console.log("注册 id:", loaded.id, loaded.id === "dsh-novel-writer" ? "✓" : "✗ 应为包名!");
console.log("factory 类型:", typeof loaded.factory);

const fakeRequire = (name) => {
  if (name === "react") {
    return { createElement: (...a) => ({}), useEffect: () => {}, useState: () => [false, () => {}] };
  }
  throw new Error("意外的 require: " + name);
};

const exported = loaded.factory(fakeRequire);
console.log("导出:", Object.keys(exported).join(", "));
console.log("inject 声明:", JSON.stringify(exported.inject), JSON.stringify(exported.inject) === JSON.stringify(["slots"]) ? "✓" : "✗ 缺少 inject!");
console.log("name:", exported.name, "| apply:", typeof exported.apply);

let slotRegistered = null;
const ctx = {
  effect: (fn) => fn(),
  slots: {
    inject: (name, fn) => { fn(); },
    register: (opts, component) => { slotRegistered = { opts, component }; }
  }
};
exported.apply(ctx);
console.log("槽位注册:", slotRegistered?.opts?.name, "| id:", slotRegistered?.opts?.id, "| 组件:", typeof slotRegistered?.component, "✓");
console.log("CLIENT OK");
