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
