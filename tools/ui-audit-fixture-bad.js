/**
 * ui-audit-fixture-bad.js —— 规则审计 CLI 的「故意违规样本」
 *
 * 用途：自测同目录的 tools/ui-audit.mjs
 * 期望：`node tools/ui-audit.mjs tools/ui-audit-fixture-bad.js` → 退出码非 0（FAIL），
 *       且 R1..R10 每条规则至少命中一次（见文件内 /* Rn *​/ 标注）。
 *
 * 它不是真插件，只用于验证审计工具的检出能力；请勿照抄任何写法。
 */
window.__ModuleLoader__.load({
  id: "c-fixture-bad",
  factory: (require) => {
    var module = { exports: {} };

    // R10 违规：官方原语 require 不在 try 块内（宿主启动安全红线）
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    var CSS = `
      .nwPanel{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
      .nwGhostClassOne{color:var(--dsw-alias-label-secondary)}
      /* R1 违规：十六进制 / rgb() / 颜色关键字 字面量 */
      .nwBadColor{color:#ff0000;background:rgba(15,23,42,.5);border-color:hsl(210,40%,50%);outline-color:white}
      /* R1 违规：渐变里的色值 */
      .nwBadGradient{background-image:linear-gradient(135deg,#6366f1,#8b5cf6)}
      /* R3 违规：中性边框写成 1px */
      .nwBadBorder{border:1px solid var(--dsw-alias-border-l2);padding:6px 8px}
      /* R3 违规：四向中性边框也必须是 0.5px */
      .nwBadBorderSide{border-top:1px solid var(--dsw-alias-border-l1);border-left:1px solid var(--dsw-alias-border-l1)}
      /* R4 违规：裸圆角数值（应为 var(--dsw-radius-*)） */
      .nwBadRadius{border-radius:10px;border-top-left-radius:6px}
      /* R4 违规：胶囊圆角未配对 corner-shape: round */
      .nwBadPill{border-radius:999px;background:var(--dsw-alias-bg-layer-1)}
      /* R4 违规：50% 未配对 corner-shape: round */
      .nwBadCircle{border-radius:50%;width:8px;height:8px}
      /* R5 违规：elevation 表面同时加 alias 边框 */
      .nwBadElevation{box-shadow:var(--dsw-elevation-panel);border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg)}
      /* R6 违规：有 font-size 没有 line-height */
      .nwBadFontSize{font-size:13px;font-weight:600}
      /* R6 违规（跨行规则块）：确认跨行块也能被解析出 font-size */
      .nwBadFontSizeMultiline{
        font-size:12px;
        font-weight:600;
      }
      /* R4 违规（跨行块）：corner-shape 不是 round，胶囊仍须报错 */
      .nwBadPillMultiline{
        border-radius:999px;
        corner-shape:squircle;
      }
      /* R7 违规：主题选择器 */
      @media (prefers-color-scheme: dark){.nwBadTheme{color:var(--dsw-alias-label-primary)}}
      [data-ds-dark-theme] .nwBadThemeAttr{background:var(--dsw-alias-bg-layer-2)}
      .dark .nwBadThemeClass{background:var(--dsw-alias-bg-layer-2)}
      /* R7 违规：自定义滚动条选择器 */
      .nwBadScroll::-webkit-scrollbar{width:8px}
      /* R8 违规：不在 tokens.md 白名单里的 token（含拼错的 token 名） */
      .nwBadToken{color:var(--dsw-alias-border);background:var(--dsw-alias-surface-1);border-color:var(--dsw-totally-made-up)}
      /* 正常写法（不应报错）：0.5px 中性边框 / dashed 1px / 状态色 1px / token 兜底同 token */
      .nwOkBorder{border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);font-size:13px;line-height:20px}
      .nwOkDashed{border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
      .nwOkState{border:1px solid var(--dsw-alias-state-error-primary)}
      .nwOkFallback{border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))}
    `;

    let react = require("react");

    // R2 违规：内联 style 含色值 / 渐变 / 裸圆角 / 裸 fontSize
    function BadPane(props) {
      var el = react.createElement;
      return el("div", {
        className: "nwPanel nwGhostClassTwo", // R9 违规：nwGhostClassTwo 未在 CSS 中定义
        style: {
          color: "#ffffff",
          background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
          borderRadius: "10px",
          fontSize: 12,
        },
      }, "bad");
    }

    // R2 违规：直接给 DOM 的 style 属性赋色值
    function paint(node) {
      node.style.borderColor = "rgba(0,0,0,.5)";
      node.style.borderRadius = "8px";
    }

    function apply(ctx) {
      // R10 违规：cordis 服务等待 ctx.inject(（曾导致桌面端 web boot 失败）
      ctx.inject("locale", (locale) => { void locale; });
      void primitives;
      void BadPane;
      void paint;
    }

    exports.apply = apply;
    return module.exports;
  }
});
