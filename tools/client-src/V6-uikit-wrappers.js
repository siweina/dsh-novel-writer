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

// 5) 计数徽标(复用既有类): .nwBadge + .nwBadgeOn/.nwBadgeOff; 文本=label 直传, 否则 t(labelOn/labelOff).
function CountBadge(el, h, t, NW_UI, props) {
  var p = props || {};
  var on = !!p.on;
  var text = (p.label !== undefined && p.label !== null)
    ? p.label
    : t(on ? p.labelOn : p.labelOff);
  return el("span", { className: "nwBadge " + (on ? "nwBadgeOn" : "nwBadgeOff") }, text);
}

// 6) 行分隔线: 单 div .nwRowDiv, 无子节点; props.key 透传(GroupCard children 数组需 React key).
function RowDivider(el, h, t, NW_UI, props) {
  return el("div", { key: (props || {}).key, className: "nwRowDiv" });
}
