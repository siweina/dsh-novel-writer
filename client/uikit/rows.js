// V6-uikit-rows.js (M3a-r) — 行组件纯函数: PreferenceRow.
// 契约: CONTRACT-V6.md §1 / §4 / §7(M3a 行); ES5 风格(var/function); 零内联样式声明;
// 零硬编码文案; 类名只用 §4 词汇表(不自造). el / h / t / NW_UI / ICONS / props 六参全部
// 由调用方注入: 本文件不自引依赖模块、不碰宿主上下文注入、不碰任何 hook; 官方 Switch 只作为
// h 的类型引用挂载, 绝不在本文件内直接调用. title / summary / label / trailing / bottom
// 文案槽一律直传(由调用方负责套 t()). 由总负责人经 tools/build-client.mjs 拼进 client.js.

// 1) 偏好行: .nwPref > (.nwPrefIcon > .nwPrefGlyph)? + .nwPrefText > (.nwPrefTitle +
//    .nwPrefSummary?) + .nwPrefTrail(Switch 经 h 挂载 或 trailing 槽) + (.nwPrefBottom)?.
//    tone === "danger" 时根类追加 nwPrefDanger; props.className 追加到根类(自动补一个分隔空格,
//    防 "nwPref" 与扩展类名直接黏连). ICONS 命中 -> 字形槽渲染 SVG 字符串; 未命中 -> 渲染原字形
//    (SVG 字符串子节点如何注入由总负责人集成时决定, 此处只按字符串子节点渲染).
function PreferenceRow(el, h, t, NW_UI, ICONS, props) {
  var p = props || {};
  var extra = "";
  if (p.className) extra = " " + String(p.className).replace(/^\s+/, "");
  var iconNode = null;
  if (p.icon) {
    iconNode = h("div", { className: "nwPrefIcon" },
      h("span", { className: "nwPrefGlyph" },
        ICONS && ICONS[p.icon] ? ICONS[p.icon] : p.icon));
  }
  var trailNode;
  if (typeof p.switchOnChange === "function") {
    // 开关一律委托官方组件: 经 h 以引用挂载(形态同 client.js switchRow), 不直接调用.
    trailNode = h(NW_UI.Switch, {
      checked: !!p.switchOn,
      disabled: !!p.switchDisabled,
      label: p.switchLabel || "",
      onChange: p.switchOnChange
    });
  } else {
    trailNode = p.trailing;
  }
  var summaryNode = null;
  if (p.summary !== undefined && p.summary !== null && p.summary !== "") {
    summaryNode = h("div", { className: "nwPrefSummary" }, p.summary);
  }
  var bottomNode = null;
  if (p.bottom !== undefined && p.bottom !== null && p.bottom !== "") {
    bottomNode = h("div", { className: "nwPrefBottom" }, p.bottom);
  }
  return h("div", { key: p.key, className: "nwPref" + (p.tone === "danger" ? " nwPrefDanger" : "") + extra },
    iconNode,
    h("div", { className: "nwPrefText" },
      h("div", { className: "nwPrefTitle" }, p.title),
      summaryNode
    ),
    h("div", { className: "nwPrefTrail" }, trailNode),
    bottomNode
  );
}

