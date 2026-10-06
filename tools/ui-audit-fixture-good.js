/**
 * ui-audit-fixture-good.js —— 规则审计 CLI 的「最小合规样本」
 *
 * 用途：自测同目录的 tools/ui-audit.mjs
 * 期望：`node tools/ui-audit.mjs tools/ui-audit-fixture-good.js` → 退出码 0，判定 PASS。
 *
 * 它不是真插件（id 是 c-fixture-good），也不会被宿主加载；
 * 只需具备 client.js 的两个特征：`var CSS = `…`` 的 CSS 模板 + 用 react.createElement 的组件。
 */
window.__ModuleLoader__.load({
  id: "c-fixture-good",
  factory: (require) => {
    var module = { exports: {} };

    // ---- 样式：CSS 模板（全部用语义 token、0.5px 中性边框、具名圆角）----
    var CSS = `
      .nwPanel{display:flex;flex-direction:column;gap:10px;padding:24px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px;line-height:20px}
      .nwPanelTitle{font-size:16px;line-height:24px;font-weight:700;margin:0}
      .nwBtn{height:32px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
      .nwBtnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:0.5px solid var(--dsw-alias-button-primary-fill);border-radius:var(--dsw-radius-md)}
      .nwDashedNote{border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}
      .nwStateErr{border:1px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-sm)}
      .nwChip{border-radius:999px;corner-shape:round;height:24px}
      .nwDot{border-radius:50%;corner-shape:round;width:8px;height:8px}
      .nwFloat{border:0;border-radius:var(--dsw-radius-panel);box-shadow:var(--dsw-elevation-panel);background:var(--dsw-alias-bg-layer-3)}
      .nwZero{border-radius:0;padding:0}
      /* ---- 以下为「低误报」回归用例：全部是合规写法，审计必须一条都不报 ---- */
      .nwFpFallback{border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))}
      .nwFpHalf{border-width:0.5px;border-style:solid;border-color:var(--dsw-alias-border-l2)}
      .nwFpNoBorder{border:0;border-top:none}
      .nwFpDashed{border-bottom:1px dashed var(--dsw-alias-border-l2);font-size:12px;line-height:18px}
      .nwFpState{border:1px solid var(--dsw-alias-state-success-primary)}
      .nwFpPillSameLine{border-radius:999px;corner-shape:round;padding:0 10px}
      .nwFpPillNextLine{
        border-radius:999px;
        corner-shape:round;
      }
      .nwFpTypeSplit{
        font-size:13px;
        line-height:20px;
      }
      .nwFpFontShorthand{font:13px/20px var(--dsw-font-family)}
      .nwFpNowrap{white-space:nowrap;text-overflow:ellipsis}
      .nwFpUrl{background-image:url(#grad1);background-repeat:no-repeat}
      .nwFpTransition{transition:border-color .18s ease,box-shadow .18s ease}
      .nwFpInset{border-radius:var(--dsw-radius-sm) 0 0 var(--dsw-radius-sm)}
      .nwFpCornerToken{border-radius:50%;corner-shape:round}
      .nwFpOutline{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color)}
      /* 下面 14 行覆盖 classes.txt 的全部 109 个类名（规则 R9：契约清单必须都在 CSS 里有定义） */
      .nwBackBtn,.nwBadge,.nwBadgeOff,.nwBadgeOn,.nwBanner,.nwBannerIcon,.nwBannerOff,.nwBannerOn{color:var(--dsw-alias-label-secondary)}
      .nwBannerSub,.nwBtnDanger,.nwBtnDone,.nwBtnGhost,.nwBtnGroup,.nwClose,.nwCreationInput,.nwDesc{color:var(--dsw-alias-label-secondary)}
      .nwEntry,.nwEntryIcon,.nwEntryLabel,.nwFlash,.nwFlashErr,.nwFoot,.nwGroupState,.nwGroupStateCheck{color:var(--dsw-alias-label-secondary)}
      .nwGroupStateCheckPartial,.nwGroupStateOff,.nwGroupStateOn,.nwGroupStatePartial,.nwModal,.nwModalBox,.nwModalBtns,.nwModalInput{color:var(--dsw-alias-label-secondary)}
      .nwModalText,.nwModalTitle,.nwModelBtn,.nwNavEntry,.nwNavEntryArrow,.nwNavEntryHint,.nwNavEntryRight,.nwNavEntryText{color:var(--dsw-alias-label-secondary)}
      .nwNavEntryTitle,.nwPanelHeader,.nwPanelMain,.nwPlotBox,.nwPlotBoxEmpty,.nwPlotErr,.nwPlotMsg,.nwPlotOk{color:var(--dsw-alias-label-secondary)}
      .nwPlotPath,.nwRawDanger,.nwRawOn,.nwRefresh,.nwRefreshSpin,.nwRow,.nwRowHint,.nwRowLabel{color:var(--dsw-alias-label-secondary)}
      .nwRowOff,.nwRowOn,.nwRowText,.nwSectionTitle,.nwSeg,.nwSegBtn,.nwSegBtnOn,.nwStatus{color:var(--dsw-alias-label-secondary)}
      .nwSwitch,.nwSwitchKnob,.nwSwitchOn,.nwSwitchSmall,.nwSwitchSmallKnob,.nwSwitchSmallOn,.nwSwitchWrap,.nwTolBtns{color:var(--dsw-alias-label-secondary)}
      .nwTolCaption,.nwTolCard,.nwTolField,.nwTolIcon,.nwTolInput,.nwTolName,.nwTolPct,.nwTolRow{color:var(--dsw-alias-label-secondary)}
      .nwTolSep,.nwTolSign,.nwTolVer,.nwToolDesc,.nwToolGroup,.nwToolGroupArrow,.nwToolGroupBadge,.nwToolGroupBody{color:var(--dsw-alias-label-secondary)}
      .nwToolGroupDescInline,.nwToolGroupHead,.nwToolGroupHeadBtn,.nwToolGroupHeadText,.nwToolGroupIcon,.nwToolGroupName,.nwToolGroupToggle,.nwToolItem{color:var(--dsw-alias-label-secondary)}
      .nwToolLabel,.nwToolLabelRaw,.nwToolRight,.nwToolRow,.nwToolRowOn,.nwToolRowRaw,.nwToolsHint,.nwUpdateBar{color:var(--dsw-alias-label-secondary)}
      .nwUpdateStale{color:var(--dsw-alias-label-tertiary)}
    `;

    // ---- 官方原语适配（R10：require 必须在 try 内；取不到就回退，不得抛到上层）----
    var primitives = null;
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (error) {
      primitives = null;
    }

    let react = require("react");

    // ---- 假组件：合法内联样式（只用 var()，无字面量、无裸圆角/字号）----
    function Pane(props) {
      var el = react.createElement;
      var small = props.small ? "nwSwitchSmallOn" : "";
      return el("div", { className: "nwPanel" },
        el("div", { className: "nwPanelTitle" }, props.title),
        el("div", { style: { fontWeight: 600, marginTop: "4px", color: "var(--dsw-alias-label-secondary)" } }, "ok"),
        el("span", { className: "nwSwitchSmall " + small }, "·"),
        el("button", { type: "button", className: "nwBtn nwBtnPrimary", onClick: props.onClick }, "save")
      );
    }

    function apply(ctx) {
      // 取宿主服务只能 ctx.get；槽位等待用 ctx.slots.inject（它安全，R10 不报）
      var locale = ctx.get("locale");
      var stop = null;
      try {
        stop = ctx.slots.inject("sidebar.panellist", function () { return null; });
      } catch (error) {
        stop = null;
      }
      void locale;
      void stop;
      void primitives;
    }

    var inject = ["locale"];
    exports.apply = apply;
    exports.Pane = Pane;
    exports.inject = inject;
    return module.exports;
  }
});
