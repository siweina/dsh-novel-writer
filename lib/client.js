/**
 * dsh-novel-writer — 浏览器端（client half, v0.3.0）
 *
 * 在 Web GUI 侧边栏挂载「句式分析」入口，点击后在会话区打开开关面板：
 *   - 启用句式分析（enabled）：控制 AI 是否可用 novel_sentence_analysis
 *   - 自动分析（autoAnalyze）：控制 AI 分析作品时是否主动附带句式报告
 * 开关状态通过 /api/dsh-novel-writer/state 同步到宿主端
 * ~/.dsh/dsh-novel-writer/state.json；宿主端不可达时降级为 localStorage。
 *
 * 本文件遵循 DSH client 插件格式：window.__ModuleLoader__.load({ id, factory })，
 * factory 返回 { apply, inject }。仅依赖 react / react-dom（Web GUI 内置）。
 */
window.__ModuleLoader__.load({
  id: "dsh-novel-writer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let react_dom_client = require("react-dom/client");

    // ---- 样式 ----
var css = `

  /* ===== 杂项 ===== */
  [data-pane=conversation],[class*=centerCol]{position:relative}
  [data-dsh-novel-writer-view]{position:absolute;inset:0;z-index:60;background:var(--dsw-alias-bg-base,#fff);display:none;overflow:auto}
  html[data-dsh-novel-writer-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]) [data-dsh-novel-writer-view]{display:block}
  html[data-dsh-novel-writer-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]) [data-pane=conversation]>:not([data-dsh-novel-writer-view]),
  html[data-dsh-novel-writer-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]) [class*=centerCol]>:not([data-dsh-novel-writer-view]){display:none!important}
  [data-dsh-frame][data-sidebar-collapsed] .nwEntry{justify-content:center;width:100%;padding:0}
  [data-dsh-frame][data-sidebar-collapsed] .nwEntryLabel{display:none}
  .nwSectionTitle{.nwTolVer{font-size:10px;color:var(--dsw-alias-label-tertiary,#94a3b8);margin:-2px 0 2px;letter-spacing:.03em}.nwTolCard{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:12px;padding:4px 14px 8px;margin:8px 0 4px;box-shadow:0 1px 4px rgba(15,23,42,.05)}.nwTolRow{display:flex;align-items:center;gap:10px;padding:9px 2px}.nwTolRow+.nwTolRow{border-top:1px dashed var(--dsw-alias-border-l2,#eef2f7)}.nwTolName{flex:1;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary,#334155);font-weight:500;display:flex;align-items:center;gap:8px;white-space:nowrap}.nwTolIcon{font-size:15px;opacity:.9;flex-shrink:0}.nwTolField{width:66px;flex-shrink:0;display:flex;flex-direction:column;align-items:stretch;gap:3px}.nwTolInput{width:100%;height:30px;padding:0 4px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#d4d4d8);border-radius:8px;font-size:13px;text-align:center;color:var(--dsw-alias-label-primary,#18181b);background:var(--dsw-alias-bg-layer-2,#fafafa);transition:border-color .18s,box-shadow .18s,background .18s;-moz-appearance:textfield}.nwTolInput::-webkit-outer-spin-button,.nwTolInput::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}.nwTolInput:hover{border-color:#a1a1aa}.nwTolInput:focus{outline:none;border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.16);background:#fff}.nwTolInput::placeholder{color:#c4c8d0;font-size:11px}.nwTolCaption{font-size:10px;color:var(--dsw-alias-label-tertiary,#94a3b8);text-align:center}.nwTolSep{width:14px;flex-shrink:0;font-size:12px;color:var(--dsw-alias-label-tertiary,#b0b8c4);text-align:center}.nwTolPct{width:14px;flex-shrink:0;font-size:13px;color:var(--dsw-alias-label-secondary,#64748b);text-align:left}.nwTolBtns{display:flex;gap:12px;margin-top:16px}.nwBtnPrimary{background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;color:#fff;font-weight:600;font-size:13px;padding:9px 20px;border-radius:10px;cursor:pointer;box-shadow:0 2px 6px rgba(99,102,241,.28);transition:transform .15s,box-shadow .15s,opacity .15s}.nwBtnPrimary:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(99,102,241,.38)}.nwBtnPrimary:active{transform:translateY(0);box-shadow:0 1px 3px rgba(99,102,241,.3)}.nwBtnDone{background:linear-gradient(135deg,#10b981,#34d399);box-shadow:0 2px 6px rgba(16,185,129,.3)}.nwBtnGhost{background:transparent;border:1px solid var(--dsw-alias-border-l2,#cbd5e1);color:var(--dsw-alias-label-secondary,#475569);font-size:13px;padding:9px 18px;border-radius:10px;cursor:pointer;transition:background .15s,border-color .15s,transform .15s}.nwBtnGhost:hover{background:var(--dsw-alias-bg-layer-2,#f1f5f9);border-color:#a1a1aa;transform:translateY(-1px)}.nwUpdateBar{display:block;margin:4px 0 8px;padding:7px 10px;border-radius:6px;background:#e8f5e9;color:#1b5e20;font-size:12px;text-decoration:none;border:1px solid #a5d6a7;cursor:pointer}.nwUpdateBar:hover{background:#c8e6c9}font-size:13px;font-weight:700;margin-top:6px}
  .nwNavEntry{display:flex;align-items:center;justify-content:space-between;width:100%;box-sizing:border-box;padding:8px 10px;margin:4px 0;border:1px solid var(--dsw-alias-border);border-radius:8px;background:var(--dsw-alias-surface-1);cursor:pointer;text-align:left;color:inherit;font:inherit}
  .nwNavEntry:hover{border-color:#22c55e}
  .nwNavEntryText{flex:1;min-width:0;padding-right:8px}
  .nwNavEntryTitle{font-size:13px;font-weight:600}
  .nwNavEntryHint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
  .nwNavEntryRight{display:flex;align-items:center;gap:6px;flex:none}
  .nwNavEntryRight .nwBadge{white-space:nowrap;flex:none}
  .nwNavEntryArrow{font-size:18px;color:var(--dsw-alias-label-tertiary);flex:none}
  .nwBackBtn{font-size:12px;padding:3px 8px;margin:2px 0 6px;border:1px solid var(--dsw-alias-border);border-radius:6px;background:var(--dsw-alias-surface-1);cursor:pointer}
  .nwModelBtn{font-size:11px;padding:2px 6px;margin-top:4px;border:1px solid #7c3aed;color:#7c3aed;border-radius:6px;background:transparent;cursor:pointer}
  .nwToolRight{display:flex;flex-direction:column;align-items:flex-end;gap:4px}

  /* ===== 导航/入口 ===== */
  .nwEntry{width:100%;height:32px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-radius:8px;align-items:center;gap:8px;padding:0 12px;font-size:13px;display:flex}
  .nwEntry:hover{background:var(--dsw-specific-sidebar-nav-item-hover);color:var(--dsw-alias-label-primary)}
  .nwEntry[data-active]{background:var(--dsw-specific-sidebar-nav-item-active);color:var(--dsw-alias-label-primary);font-weight:600}
  .nwEntryIcon{flex:none;justify-content:center;align-items:center;display:inline-flex;width:16px;font-size:13px}
  .nwEntryLabel{text-overflow:ellipsis;overflow:hidden}
  .nwPanel{max-width:560px;margin:0 auto;padding:28px 24px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);display:flex;flex-direction:column;gap:10px}
  .nwPanelHeader{display:flex;align-items:center;gap:10px}
  .nwPanelTitle{font-size:16px;font-weight:700;flex:1;min-width:0}
  .nwClose{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);width:30px;height:30px;line-height:1}
  .nwRefresh{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;padding:5px 9px}
  .nwRefresh:hover{background:var(--dsw-alias-bg-layer-2)}
  .nwDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.6;margin:0}
  .nwRefreshSpin{animation:nwspin 1s linear infinite}

  /* ===== 横幅与开关 ===== */
  .nwBanner{display:flex;align-items:center;gap:10px;border-radius:12px;padding:14px 16px;font-size:15px;font-weight:700;border:1px solid}
  .nwBannerOn{background:rgba(34,197,94,.12);border-color:#22c55e;color:#15803d}
  .nwBannerOff{background:rgba(239,68,68,.10);border-color:#ef4444;color:#b91c1c}
  .nwBannerIcon{flex:none;font-size:18px;line-height:1}
  .nwBannerSub{font-size:12px;font-weight:500;opacity:.9;margin-left:6px}
  .nwRow{display:flex;align-items:center;gap:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:12px;padding:12px 14px;transition:border-color .18s,background .18s}
  .nwRowOn{border-color:#22c55e;background:rgba(34,197,94,.07)}
  .nwRowOff{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
  .nwRowText{flex:1;min-width:0}
  .nwRowLabel{font-size:13px;font-weight:600;line-height:1.5}
  .nwRowHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin-top:2px}
  .nwSwitchWrap{flex:none;display:flex;align-items:center;gap:8px}
  .nwSwitch{appearance:none;flex:none;width:56px;height:30px;border-radius:999px;border:2px solid #9ca3af;background:#9ca3af;cursor:pointer;position:relative;padding:0;transition:background .18s,border-color .18s,box-shadow .18s}
  .nwSwitch:hover{box-shadow:0 0 0 4px rgba(156,163,175,.20)}
  .nwSwitch:focus-visible{outline:2px solid #22c55e;outline-offset:2px}
  .nwSwitchOn{background:#22c55e;border-color:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.18)}
  .nwSwitchOn:hover{box-shadow:0 0 0 4px rgba(34,197,94,.28)}
  .nwSwitchKnob{position:absolute;top:2px;left:2px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .18s}
  .nwSwitchOn .nwSwitchKnob{left:28px}
  .nwSwitch:disabled{opacity:.5;cursor:default;box-shadow:none}
  .nwSwitchSmall{appearance:none;flex:none;width:40px;height:22px;border-radius:999px;border:2px solid #9ca3af;background:#9ca3af;cursor:pointer;position:relative;padding:0;transition:background .16s,border-color .16s}
  .nwSwitchSmallOn{background:#22c55e;border-color:#22c55e}
  .nwSwitchSmallKnob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .16s}
  .nwSwitchSmallOn .nwSwitchSmallKnob{left:20px}

  /* ===== 徽章 ===== */
  .nwBadge{flex:none;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;white-space:nowrap;letter-spacing:.5px}
  .nwBadgeOn{background:#22c55e;color:#fff}
  .nwBadgeOff{background:#e5e7eb;color:#6b7280}

  /* ===== 动画与杂项 ===== */
  @keyframes nwspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
  @keyframes nwflash{0%{background:rgba(34,197,94,.25)}100%{background:transparent}}

  /* ===== 路径/按钮/状态 ===== */
  .nwPlotOk{color:#22c55e}
  .nwFlash{animation:nwflash 1.2s ease}
  .nwBtnDanger{background:#ef4444;color:#fff;border-color:#ef4444}
  .nwPlotBox{margin-top:6px;padding:6px 8px;background:rgba(127,127,127,.08);border-radius:8px}
  .nwPlotPath{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);word-break:break-all}
  .nwBtnGroup{display:flex;gap:6px;margin-top:6px}
  .nwBtn{font-size:11px;line-height:1;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}
  .nwBtn:hover{background:var(--dsw-alias-bg-layer-2)}
  .nwBtn:disabled{opacity:.45;cursor:not-allowed}
  .nwPlotMsg{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin-top:4px;word-break:break-all}
  .nwPlotErr{color:#ef4444}
  .nwStatus{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;word-break:break-all}
  .nwFoot{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px;margin-top:4px}
  .nwGroupState{width:16px;height:16px;border-radius:4px;border:2px solid #9ca3af;display:inline-flex;align-items:center;justify-content:center;position:relative;overflow:hidden;background:#fff}
  .nwGroupStateOn{border-color:#22c55e;background:#22c55e}
  .nwGroupStatePartial{border-color:#22c55e;background:#fff}
  .nwGroupStateOff{border-color:#9ca3af;background:#fff}
  .nwGroupStateCheck{color:#fff;font-size:11px;font-weight:700;line-height:1}
  .nwGroupStateCheckPartial{width:10px;height:10px;border-radius:2px;background:#22c55e;color:transparent}

  /* ===== 非净化模式 ===== */
  .nwToolRowRaw{border-color:#ef4444}
  .nwToolLabelRaw{color:#ef4444;font-weight:700}
  .nwRawDanger{color:#ef4444!important;font-weight:600}
  .nwRawOn{font-size:11px;color:#ef4444;margin-top:2px;font-weight:600}

  /* ===== 弹窗 ===== */
  .nwModal{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999}
  .nwModalBox{background:var(--dsw-alias-surface-1,#fff);border-radius:12px;padding:18px 20px;max-width:420px;width:90%;box-shadow:0 8px 30px rgba(0,0,0,.3)}
  .nwModalTitle{font-size:15px;font-weight:700;margin-bottom:10px}
  .nwModalText{font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary);white-space:pre-line;margin-bottom:12px}
  .nwModalInput{width:100%;box-sizing:border-box;padding:8px 10px;font-size:13px;border:1px solid var(--dsw-alias-border);border-radius:8px;background:var(--dsw-alias-surface-2,#fafafa);color:inherit;margin-bottom:12px}
  .nwModalBtns{display:flex;gap:10px;justify-content:flex-end}

  /* ===== 工具行/开关/说明 ===== */
  .nwToolItem{width:100%;margin-bottom:2px}
  .nwToolItem .nwPlotBox{width:100%;box-sizing:border-box}
  .nwToolsHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:2px 0 4px}
  .nwToolRow{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:8px 12px}
  .nwToolRowOn{border-color:rgba(34,197,94,.55);background:rgba(34,197,94,.05)}
  .nwToolLabel{flex:1;min-width:0;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-primary)}
  .nwToolDesc{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary);margin-top:2px}

  /* ===== 工具组 ===== */
  .nwToolGroup{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;margin-bottom:8px;overflow:hidden}
  .nwToolGroupHead{display:flex;align-items:center;gap:6px;width:100%;padding:9px 12px;background:rgba(127,127,127,.08);border:none;cursor:default;font-size:13px;text-align:left;color:inherit}
  .nwToolGroupHead:hover{background:rgba(127,127,127,.14)}
  .nwToolGroupIcon{font-size:15px}
  .nwToolGroupName{font-weight:600}
  .nwToolGroupBadge{margin-left:auto;font-size:11px;color:#c62828;background:rgba(198,40,40,.1);border-radius:10px;padding:1px 7px}
  .nwToolGroupArrow{font-size:12px;opacity:.6}
  .nwToolGroupBody{padding:4px 8px 8px}
  .nwToolGroupToggle{flex:none;width:24px;height:24px;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;padding:0}
  .nwToolGroupHeadBtn{flex:1;display:flex;align-items:center;gap:8px;background:none;border:none;cursor:pointer;padding:0;text-align:left;color:inherit;font-size:13px}
  .nwToolGroupHeadText{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .nwToolGroupDescInline{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary);font-weight:400;white-space:normal}
`;
    // v3.0.0-UI3：已存在旧 style 标签也覆盖内容——否则插件脚本重复执行时新 CSS 永不注入（UI 停留在旧版）
    if (typeof document !== "undefined") {
      var cssTag = document.querySelector("style[data-plugin-css=\"dsh-novel-writer\"]");
      if (cssTag) {
        if (cssTag.textContent !== css) cssTag.textContent = css;
      } else {
        cssTag = document.createElement("style");
        cssTag.dataset.plugin = "dsh-novel-writer";
        cssTag.dataset.pluginCss = "dsh-novel-writer";
        cssTag.textContent = css;
        document.head.appendChild(cssTag);
      }
    }

    // ---- 文案（zh / en）----
    var zh = {
      "entry.label": "写作助手功能",
      "entry.tooltip": "写作助手功能开关（dsh-novel-writer）：句式分析/风格自检/伏笔登记等",
      "panel.title": "写作助手功能",
      "panel.desc": "管理写作助手的功能开关：句式模式分析（九类句式/情感曲线/风格指纹）、风格自检、伏笔登记、稿件导入等。关闭的工具，AI 调用时会收到提示。",
      "panel.enabled": "启用写作助手功能",
      "panel.enabledHint": "总开关：控制句式模式分析与风格自检（novel_sentence_analysis / novel_style_check）。",
      "panel.autoAnalyze": "分析作品时自动使用",
      "panel.autoAnalyzeHint": "开启后，AI 在分析作品时会主动附带句式分析；关闭则仅在用户明确要求时使用。",
      "panel.back": "Back",
      "panel.featuresTitle": "功能开关",
      "panel.featuresHint": "情感净化预警：剔除感官/爽感词干扰后提示 AI 复核真实情绪；题材与流派检测：detect 时输出主/副题材与设定流派。",
      "feature.emotionDeep": "情感深度检测",
      "feature.emotionDeep.desc": "剔除感官性反应词汇的干扰，呈现作品真实的情感基调",
      "feature.styleDetect": "风格检测",
      "feature.styleDetect.desc": "识别世界观背景、题材类型与整体气质（如西幻、克苏鲁、甜宠）",
      "feature.webnovelVibe": "网文信号（风格检测内）",
      "feature.webnovelVibe.desc": "识别网文套路词与题材联动（打脸/秒杀/追妻火葬场），让甜宠/热血也能被识别",
      "feature.emotionCaveat": "情感净化预警（高级）",
      "feature.emotionCaveat.desc": "剔除成人向/爽文/极端反应类词汇，污染时提示 AI 抽查原文复核。",
      "feature.genreTheme": "题材与流派检测",
      "feature.genreTheme.desc": "detect 输出题材（骨）与流派（皮），低频噪音自动省略。",
      "feature.emotionComplexity": "情感量化",
      "feature.emotionComplexity.desc": "Valence 滑动窗口：方差/斜率/矛盾指数 + 隐性意象对比，模型读数字理解复杂情感。",
      "feature.semanticEmbedding": "语义增强（本地模型）",
      "feature.semanticEmbedding.desc": "本地 AI 模型提供语义级分析：按含义检索段落、对比文风、识别隐性情感。无需联网，模型缺失时自动回退规则模式。",
      "feature.semanticSearch": "语义检索",
      "feature.semanticSearch.desc": "按含义检索全书：描述你想找的内容，即使原文用词不同也能命中相关段落。",
      "feature.semanticStyle": "语义风格对比",
      "feature.semanticStyle.desc": "风格自检时附加语义相似度维度，与规则指纹互相印证。",
      "feature.semanticImplicit": "语义隐性情感",
      "feature.semanticImplicit.desc": "用情感原型句扫描全书，发现词表未覆盖的隐性情绪段落。",
      "feature.rawWriting": "非净化模式",
      "feature.rawWriting.desc": "模仿作者文风时还原原文直白程度（血腥/暴力/成人）。默认关闭，开启需双重确认。",
      "raw.on": "已开启（仅个人创作）",
      "raw.danger": "危险选项",
      "raw.confirmTitle": "敏感直白模式确认",
      "raw.confirmText": "开启后，AI 在模仿作者文风续写时将还原原文的直白/露骨描写（包括血腥、暴力、成人内容）。\n\n此功能仅用于个人创作与研究。请确认是否开启。",
      "raw.confirmWait": "请确认",
      "raw.confirmOk": "确认开启",
      "raw.cancel": "取消",
      "raw.promiseTitle": "承诺输入",
      "raw.promiseText": "请输入以下承诺以开启（必须包含「绝不传播」）：\n\n我承诺开启此功能仅用于个人创作与研究，绝不传播。",
      "raw.promisePlaceholder": "我承诺开启此功能仅用于个人创作与研究，绝不传播",
      "raw.promiseOk": "确认",
      "feature.semanticImplicit.desc": "25 个情感原型句扫全书，找词表外疑似意象段落（semanticImplicit）。",
      "model.title": "小模型（本地语义引擎）",
      "model.manage": "管理",
      "model.hint": "总开关：语义增强。以下子功能独立开关，默认全开；关闭总开关后以下全部失效。",
      "dir.data": "数据目录",
      "dir.settings": "设定表存储",
      "dir.summaries": "章节摘要存储",
      "dir.audits": "审计报告存储",
      "dir.analysis": "分析缓存存储",
      "dir.embedding": "语义索引存储",
      "plot.copyFail": "复制失败（浏览器限制），请手动复制：",
      "panel.toolsTitle": "工具开关",
      "toolGroup.analyze": "📊 分析类",
      "toolGroup.analyze.desc": "浏览作品、统计关键词、句式与情感分析、风格自检、语义检索、连贯性审计——全面了解一本书。",
      "toolGroup.settings": "📚 设定类",
      "toolGroup.settings.desc": "维护人物、地点、道具、时间线设定，伏笔登记，章节摘要与稿件导入——作品的资料库。",
      "toolGroup.create": "✍️ 创作类",
      "toolGroup.create.desc": "新建章节与调整开关配置。",
      "group.allOn": "全部开启",
      "group.allOff": "全部关闭",
      "group.partial": "部分开启（点一下全部开启）",
      "panel.toolsHint": "全部默认开启。关闭后 AI 调用该工具会收到明确提示；可随时在此重新开启。",
      "panel.loading": "正在读取开关状态…",
      "panel.saved": "状态已保存到宿主端",
      "panel.localOnly": "宿主端不可达，开关仅保存在本浏览器（重启后可能恢复默认）。",
      "panel.saveFailed": "保存到宿主端失败，已降级保存在本浏览器。",
      "panel.foot": "提示：也可在对话中让 AI 用 novel_sentence_config 查看/修改全部开关。",
      "panel.close": "关闭",
      "banner.on": "写作助手功能已启用",
      "banner.onSub": "句式分析 / 风格自检可用",
      "banner.off": "写作助手功能已关闭",
      "banner.offSub": "句式分析 / 风格自检不可用",
      "badge.on": "已开启",
      "badge.off": "已关闭",
      "tool.novel_books": "作品列表 novel_books",
      "tool.novel_outline": "创作资料 novel_outline",
      "tool.novel_outline.desc": "维护原创小说创作设定/主要次要人物/剧情大纲/钩子记录/创作状态卡（novels/创作资料/<书名>/）；原创前必读状态卡与大纲，写完每章必回填钩子。",
      "tool.novel_chapters": "章节清单 novel_chapters",
      "tool.novel_read": "阅读章节 novel_read",
      "tool.novel_keywords": "关键词分析 novel_keywords",
      "tool.novel_new_chapter": "新建章节 novel_new_chapter",
      "tool.novel_import": "稿件导入 novel_import",
      "tool.novel_sentence_analysis": "句式模式分析 novel_sentence_analysis",
      "tool.novel_sentence_config": "开关配置 novel_sentence_config",
      "tool.novel_style_check": "风格自检 novel_style_check",
      "tool.novel_style_report": "风格画像报告 novel_style_report",
      "tool.novel_plot": "伏笔登记 novel_plot",
      "tool.novel_books.desc": "列出书库中的全部作品（章节数/总字数）。",
      "tool.novel_chapters.desc": "查看某本书的章节清单与字数。",
      "tool.novel_read.desc": "阅读章节正文（支持分页与编码自动识别）。",
      "tool.novel_keywords.desc": "统计高频词汇：人名、意象、习惯用语一目了然。",
      "tool.novel_new_chapter.desc": "创建新章节文件（自动取下一章号）。",
      "tool.novel_import.desc": "批量导入原稿件文件夹，自动识别书名并分类归档到书库。",
      "tool.novel_sentence_analysis.desc": "分析句子的长短节奏、类型分布与情感曲线，反映作者的写作习惯。",
      "tool.novel_sentence_config.desc": "查看与修改全部功能与工具开关（供 AI 调用）。",
      "tool.novel_style_check.desc": "对比本章与全书其余章节的风格相似度，检查文风是否一致。",
      "tool.novel_style_report.desc": "聚合六维测量数据（文风、词汇、题材、情感、氛围、语义距离），供 AI 判断风格气质。",
      "tool.novel_plot.desc": "登记/回收剧情伏笔，续写前查看未回收项。",
      "tool.novel_settings": "设定管理 novel_settings",
      "tool.novel_summary": "章节摘要 novel_summary",
      "tool.novel_continuity_check": "连贯性审计 novel_continuity_check",
      "tool.novel_semantic_search": "语义检索 novel_semantic_search",
      "tool.novel_settings.desc": "四张设定表：人物卡/地点卡/道具/时间线。",
      "tool.novel_summary.desc": "保存/读取每章摘要，长书续写先读摘要。",
      "tool.novel_continuity_check.desc": "对照设定表扫描全书，输出矛盾候选。",
      "tool.novel_semantic_search.desc": "按语义检索全书相关内容：即使段落未出现查询关键词，也能基于含义匹配。",
      "plot.pathLabel": "数据目录",
      "plot.pathUnknown": "位于书库根的 .novel-writer 文件夹（plots 伏笔 / settings 设定 / summaries 摘要 / analysis 分析报告）。先让 AI 调用一次 novel_plot 或 novel_settings，此处会显示真实路径。",
      "plot.open": "打开文件夹",
      "plot.copy": "复制路径",
      "plot.copied": "已复制",
      "plot.revealOk": "已打开文件夹",
      "plot.revealErr": "打开失败",
      "panel.refresh": "刷新",
      "panel.refreshed": "已刷新",
      "card.title": "小说写作助手 novel-writer",
      "card.desc": "句式模式分析：分析原文陈述/环境/心理/对话/疑问/反问/感叹等句子的排列节奏来辅助模仿文风。⚠️ 若机械套用导致文风僵硬，模型会优先回归自然表达。",
      "card.status": "写作助手功能：已启用 · 自动分析：开",
      "card.statusOff": "写作助手功能：已关闭",
      "card.statusAutoOff": "写作助手功能：已启用 · 自动分析：关",
      "card.hint": "全部开关统一在侧边栏「写作助手功能」面板（也可让 AI 用 novel_sentence_config 调整），本卡片仅显示状态。",
      "card.open": "打开开关面板",
      "dir.size": "数据目录占用",
      "model.engine": "语义引擎（本地模型）",
      "model.engineReady": "可用 · 模型已加载",
      "model.engineIdle": "可用 · 未加载（首次使用时自动加载）",
      "model.engineMissing": "模型文件缺失，语义功能不可用",
      "model.engineError": "加载失败：{err}",
      "model.engineUnknown": "状态未知",
      "update.title": "发现新版本",
      "update.go": "前往下载 →",
      "update.latest": "已是最新版本",
      "panel.baselineTitle": "风格基线",
      "panel.baselineHint": "六维文笔指标 ±% 容差带",
      "baseline.desc": "新章六维相对原书基线的允许偏离范围（%）。只填数字 0~100（正负号已按位置固定：低于=−、高于=+）；留空 = 使用推荐容差（原著章节波动的 1.5 倍，限 ±10%~100%）。",
      "baseline.save": "保存容差",
      "baseline.reset": "清除自定义（用推荐）",
      "baseline.saved": "容差已保存",
      "baseline.low": "低于%",
      "baseline.high": "高于%",
      "panel.creationTitle": "原创模式",
      "panel.creationHint": "创作设定（留空=让模型自己定）",
      "creation.desc": "填写你的创作意图，保存后每次原创自动带上（留空的维度由模型自行设定）。也可在对话中随时补充调整。",
      "creation.worldview": "世界观",
      "creation.characters": "角色设定",
      "creation.forbidden": "不允许的事件",
      "creation.mainConflict": "主线目的",
      "creation.genre": "题材偏好",
      "creation.extra": "额外要求",
      "creation.listTitle": "设定库",
      "creation.desc2": "每本书一份设定（未建目录的新书也能预配置）；写书时模型自动用对应设定。",
      "creation.new": "＋ 新建设定",
      "creation.newPlaceholder": "输入新书书名…",
      "creation.default": "默认设定（新书/通用）",
      "creation.defaultHint": "没在设定库里的新书用这份",
      "creation.items": "项已填",
      "creation.none": "未填写（全部交给模型）",
      "creation.edit": "编辑",
      "creation.delete": "删除",
      "creation.deleted": "已删除该书设定",
      "creation.newed": "已创建设定，开始填写",
      "creation.needName": "请先输入新书书名",
      "creation.dirtyWarn": "有未保存的修改，切换将丢弃。继续？",
      "creation.formTitle": "编辑设定",
      "creation.bookFor": "设定应用书",
      "creation.save": "保存设定",
      "creation.clear": "清空",
      "creation.saved": "原创设定已保存",
      "creation.cleared": "已清空（全部交给模型）"
    };
    var en = {
      "entry.label": "Writing Assistant",
      "entry.tooltip": "Writing assistant switches (dsh-novel-writer): analysis / style check / plot tracking etc.",
      "panel.title": "Writing Assistant",
      "panel.desc": "Manage the writing-assistant features: sentence-pattern analysis, style check, plot tracking, import, etc. Disabled tools return a clear notice when called.",
      "panel.enabled": "Enable writing assistant",
      "panel.enabledHint": "Master switch: controls novel_sentence_analysis and novel_style_check.",
      "panel.autoAnalyze": "Auto-use when analyzing works",
      "panel.autoAnalyzeHint": "When on, the AI proactively includes sentence analysis; otherwise only on explicit request.",
      "panel.featuresTitle": "Feature switches",
      "panel.featuresHint": "Emotion caveat: strip physiological/euphoric words and ask the AI to re-check real tone. Genre/theme: output main/secondary theme and setting genre on detect.",
      "feature.emotionDeep": "Emotion Depth",
      "feature.emotionDeep.desc": "Filters physiological reaction words to see the true mood",
      "feature.styleDetect": "Style Detect",
      "feature.styleDetect.desc": "Detects worldview, theme and vibe (fantasy/cthulhu/romance)",
      "feature.webnovelVibe": "Webnovel signals",
      "feature.webnovelVibe.desc": "Recognizes webnovel trope words (face-slap/one-shot kill)",
      "feature.emotionCaveat": "Emotion caveat (advanced)",
      "feature.emotionCaveat.desc": "Strip adult-oriented/action/horror reaction words; warn and ask AI to sample-check when polluted.",
      "feature.genreTheme": "Genre & theme",
      "feature.genreTheme.desc": "detect outputs theme (core) and genre (skin); low-frequency noise omitted.",
      "feature.emotionComplexity": "Emotion quantification",
      "feature.emotionComplexity.desc": "Valence sliding window: variance/slope/conflict + implicit imagery compare; AI reads numbers.",
      "feature.semanticEmbedding": "Semantic enhancement (local model)",
      "feature.semanticEmbedding.desc": "Local bge-small-zh: semantic search for plot/emotion + style comparison. 0 token, auto-enabled, falls back to rules.",
      "feature.semanticSearch": "Semantic search",
      "feature.semanticSearch.desc": "novel_semantic_search: natural-language search across the book.",
      "feature.semanticStyle": "Semantic style compare",
      "feature.semanticStyle.desc": "novel_style_check adds semantic similarity (besides rule fingerprint).",
      "feature.semanticImplicit": "Semantic implicit emotion",
      "feature.rawWriting": "Uncensored Mode",
      "feature.rawWriting.desc": "Restore the original explicitness when mimicking author style (gore/violence/adult). Off by default; requires double confirmation.",
      "raw.on": "ON (personal creation only)",
      "raw.danger": "Dangerous option",
      "raw.confirmTitle": "Sensitive explicit mode confirmation",
      "raw.confirmText": "When enabled, the AI will restore the original explicitness (gore, violence, adult content) when continuing in the author's style.\n\nFor personal creation and research only.",
      "raw.confirmWait": "Confirm",
      "raw.confirmOk": "Enable",
      "raw.cancel": "Cancel",
      "raw.promiseTitle": "Promise input",
      "raw.promiseText": "Type the following promise to enable (must contain \"never distribute\"):\n\nI promise to use this feature for personal creation and research only, and never distribute it.",
      "raw.promisePlaceholder": "I promise to use this only for personal creation and research, never distribute",
      "raw.promiseOk": "Confirm",
      "feature.semanticImplicit.desc": "25 emotion prototypes scan the book for implicit imagery paragraphs.",
      "model.title": "Local model (semantic engine)",
      "model.manage": "Manage",
      "model.hint": "Master switch: semantic enhancement. Sub-switches below are independent; disabling the master disables all.",
      "dir.data": "Data dir",
      "dir.settings": "Settings storage",
      "dir.summaries": "Summaries storage",
      "dir.audits": "Audit reports storage",
      "dir.analysis": "Analysis cache storage",
      "dir.embedding": "Semantic index storage",
      "plot.copyFail": "Copy failed (browser restriction), copy manually: ",
      "panel.toolsTitle": "Tool switches",
      "toolGroup.analyze": "📊 Analysis",
      "toolGroup.settings": "📚 Settings",
      "toolGroup.create": "✍️ Creation",
      "panel.toolsHint": "All on by default. Disabled tools return a clear notice; re-enable anytime here.",
      "panel.loading": "Loading switch state…",
      "panel.saved": "Saved to the host state file",
      "panel.localOnly": "Host unreachable; kept in this browser only (defaults may return after restart).",
      "panel.saveFailed": "Host save failed; fell back to this browser.",
      "panel.foot": "Tip: ask the AI to run novel_sentence_config to view/change all switches.",
      "panel.close": "Close",
      "banner.on": "Writing assistant is ON",
      "banner.onSub": "analysis / style check available",
      "banner.off": "Writing assistant is OFF",
      "banner.offSub": "analysis / style check unavailable",
      "badge.on": "ON",
      "badge.off": "OFF",
      "tool.novel_books": "Books novel_books",
      "tool.novel_outline": "Creation files novel_outline",
      "tool.novel_outline.desc": "Maintain creation settings/characters/outline/hooks/status (novels/创作资料/<book>/); read status & outline before writing, fill in each chapter hook after writing.",
      "tool.novel_chapters": "Chapters novel_chapters",
      "tool.novel_read": "Read novel_read",
      "tool.novel_keywords": "Keywords novel_keywords",
      "tool.novel_new_chapter": "New chapter novel_new_chapter",
      "tool.novel_import": "Import novel_import",
      "tool.novel_sentence_analysis": "Pattern analysis novel_sentence_analysis",
      "tool.novel_sentence_config": "Config novel_sentence_config",
      "tool.novel_style_check": "Style check novel_style_check",
      "tool.novel_style_report": "Style report novel_style_report",
      "tool.novel_style_report.desc": "Aggregates six measurement dimensions (style, vocabulary, theme, emotion, vibe, semantic distance) for AI to judge style.",
      "tool.novel_plot": "Plot tracking novel_plot",
      "tool.novel_books.desc": "List all books (chapters / total chars).",
      "tool.novel_chapters.desc": "List chapters of a book with sizes.",
      "tool.novel_read.desc": "Read chapter text (paged, auto-encoding).",
      "tool.novel_keywords.desc": "Extract keywords (bigrams / trigrams / name candidates).",
      "tool.novel_new_chapter.desc": "Create a new chapter file (next number auto).",
      "tool.novel_import.desc": "Import raw drafts and auto-classify into the library.",
      "tool.novel_sentence_analysis.desc": "Pattern distribution / rhythm / emotion curve / fingerprint.",
      "tool.novel_sentence_config.desc": "View / change all switches (AI channel).",
      "tool.novel_style_check.desc": "Style similarity of this chapter vs the rest of the book.",
      "tool.novel_plot.desc": "Track / close plot hooks; check before continuing.",
      "tool.novel_settings": "Settings novel_settings",
      "tool.novel_summary": "Summaries novel_summary",
      "tool.novel_continuity_check": "Continuity novel_continuity_check",
      "tool.novel_semantic_search": "Semantic search novel_semantic_search",
      "tool.novel_settings.desc": "Four tables: characters / locations / items / timeline.",
      "tool.novel_summary.desc": "Store / read per-chapter summaries.",
      "tool.novel_continuity_check.desc": "Scan against settings, list contradiction candidates.",
      "plot.pathLabel": "Data dir",
      "plot.pathUnknown": "Located in .novel-writer under the library root (plots / settings / summaries / analysis). Ask the AI to run novel_plot or novel_settings once to show the real path.",
      "plot.open": "Open folder",
      "plot.copy": "Copy path",
      "plot.copied": "Copied",
      "plot.revealOk": "Opened",
      "plot.revealErr": "Open failed",
      "panel.refresh": "Refresh",
      "panel.refreshed": "Refreshed",
      "card.title": "Novel Writer (dsh-novel-writer)",
      "card.desc": "Sentence-pattern analysis: reads the rhythm of statements/environment/inner-thought/dialogue/questions etc. to help mimic the author's style. ⚠️ If mechanical imitation stiffens the prose, natural expression wins.",
      "card.status": "Writing assistant: ON · auto-analyze: ON",
      "card.statusOff": "Writing assistant: OFF",
      "card.statusAutoOff": "Writing assistant: ON · auto-analyze: OFF",
      "card.hint": "All switches live in the sidebar 'Writing Assistant' panel (or ask the AI to run novel_sentence_config); this card only shows status.",
      "card.open": "Open the switch panel",
      "dir.size": "Data dir usage",
      "model.engine": "Semantic engine (local model)",
      "model.engineReady": "Ready · model loaded",
      "model.engineIdle": "Ready · lazy-loaded on first use",
      "model.engineMissing": "Model files missing, semantic features unavailable",
      "model.engineError": "Load failed: {err}",
      "model.engineUnknown": "Unknown",
      "update.title": "New version available",
      "update.go": "Download →",
      "update.latest": "Up to date",
      "panel.baselineTitle": "Style Baseline",
      "panel.baselineHint": "±% tolerance band for six writing metrics",
      "baseline.desc": "Allowed deviation (%) of new chapters from the book baseline. Enter 0-100 only (signs fixed by position: below=−, above=+); leave blank to use the recommended tolerance (1.5× the book chapter variance, clamped ±10%~100%). Out-of-band triggers correction — theme is free, writing style stays in the band.",
      "baseline.save": "Save tolerance",
      "baseline.reset": "Reset default",
      "baseline.saved": "Tolerance saved",
      "baseline.low": "Below %",
      "baseline.high": "Above %",
      "panel.creationTitle": "Original Mode",
      "panel.creationHint": "Creation settings (blank = let the model decide)",
      "creation.desc": "Fill in your creative intent; saved once, applied to every original writing task (blank dimensions are decided by the model). You can also add notes in chat anytime.",
      "creation.worldview": "Worldview",
      "creation.characters": "Characters",
      "creation.forbidden": "Forbidden events",
      "creation.mainConflict": "Main conflict",
      "creation.genre": "Genre",
      "creation.extra": "Extra requirements",
      "creation.listTitle": "Settings library",
      "creation.desc2": "One profile per book (new books without a folder can be pre-configured); the model uses the matching profile automatically.",
      "creation.new": "+ New profile",
      "creation.newPlaceholder": "Enter new book name…",
      "creation.default": "Default (new / general)",
      "creation.defaultHint": "Used for new books not in the library",
      "creation.items": "filled",
      "creation.none": "Not filled (model decides)",
      "creation.edit": "Edit",
      "creation.delete": "Delete",
      "creation.deleted": "Profile deleted",
      "creation.newed": "Profile created, start filling",
      "creation.needName": "Please enter a book name first",
      "creation.dirtyWarn": "Unsaved changes will be lost. Continue?",
      "creation.formTitle": "Edit profile",
      "creation.bookFor": "Applied book",
      "creation.save": "Save settings",
      "creation.clear": "Clear",
      "creation.saved": "Original settings saved",
      "creation.cleared": "Cleared (all decided by model)"
    };
    function dictionary() {
      return (typeof document !== "undefined" && (document.documentElement.lang || "zh").toLowerCase().startsWith("en")) ? en : zh;
    }
    function t(key) {
      var text = dictionary()[key];
      return text === void 0 ? key : text;
    }

    // ---- 工具清单（与宿主端 ALL_TOOLS 一致）----
    var ALL_TOOLS = ["novel_books", "novel_chapters", "novel_read", "novel_keywords", "novel_new_chapter", "novel_import", "novel_sentence_analysis", "novel_sentence_config", "novel_style_check", "novel_style_report", "novel_plot", "novel_settings", "novel_summary", "novel_continuity_check", "novel_semantic_search", "novel_outline"];

    // ---- 与宿主端同步 ----
    var STATE_ROUTE = "/api/dsh-novel-writer/state";
    var STORAGE_KEY = "dsh.novelWriter.state.v1";
    async function fetchState() {
      var response = await fetch(STATE_ROUTE, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.json();
    }
    async function saveState(patch) {
      var response = await fetch(STATE_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(patch)
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.json();
    }

    // ---- 迷你控制器 ----
    function createController() {
      var listeners = new Set();
      var toggleRef = null;
      var state = {
        enabled: true,
        autoAnalyze: true,
        tools: {},
        file: "",
        source: "",
        loading: true,
        hostOk: true,
        saveFailed: false,
        panelOpen: false,
        plotsDir: "",
        dataDir: "",
        dataDirSize: 0,
        embeddingStatus: null,
        updateCheck: null,
        styleTolerance: null,
        baselineDraft: null,
        baselineSaved: false,
        creationProfile: null,
        creationProfiles: {},
        creationDraft: null,
        creationDirty: false,
        creationBook: "",
        creationNewBook: "",
        books: [],
        features: {},
        dirs: null,
        view: "main",
        refreshing: false,
        refreshedAt: 0,
        revealMsg: "",
        revealErr: false,
        revealing: false,
        rawModal: false,
        rawCountdown: 0,
        rawPromiseOpen: false,
        rawPromiseText: "",
        rawPromiseOk: false
      };
      var api = {
        getSnapshot: function () { return state; },
        set: function (patch) {
          Object.assign(state, patch);
          listeners.forEach(function (fn) { fn(state); });
        },
        subscribe: function (fn) {
          listeners.add(fn);
          return function () { listeners.delete(fn); };
        },
        refresh: function () {
          if (api.getSnapshot().refreshing) return Promise.resolve(null);
          api.set({ refreshing: true, revealMsg: "", revealErr: false });
          return fetchState().then(function (remote) {
            api.set({
              enabled: !!remote.enabled,
              autoAnalyze: !!remote.autoAnalyze,
              tools: remote.tools || {},
              features: remote.features || {},
              plotsDir: remote.plotsDir || "",
              dataDir: remote.dataDir || "",
              dataDirSize: remote.dataDirSize || 0,
              embeddingStatus: remote.embeddingStatus || null,
              styleTolerance: remote.styleTolerance || null,
              creationProfile: remote.creationProfile || null,
              creationProfiles: remote.creationProfiles || {},
              books: remote.books || [],
              dirs: remote.dirs || null,
              file: remote.file || "",
              hostOk: true,
              loading: false,
              refreshing: false,
              refreshedAt: Date.now(),
              revealMsg: t("panel.refreshed") + " " + new Date().toLocaleTimeString(),
              revealErr: false
            });
            return remote;
          }).catch(function () {
            api.set({ hostOk: false, loading: false, refreshing: false, revealMsg: t("plot.revealErr") + "：宿主端不可达", revealErr: true });
            return null;
          });
        },
        openDir: function (target) {
          api.set({ revealMsg: "", revealErr: false, revealing: true });
          fetch("/api/dsh-novel-writer/reveal", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ target: target || "data-dir" })
          }).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          }).then(function (data) {
            if (data.ok === true) {
              api.set({ revealMsg: t("plot.revealOk") + "：" + (data.path || ""), revealErr: false });
            } else {
              api.set({ revealMsg: data.error || t("plot.revealErr"), revealErr: true });
            }
          }).catch(function () {
            api.set({ revealMsg: t("plot.revealErr") + "：宿主端不可达", revealErr: true });
          }).finally(function () {
            api.set({ revealing: false });
          });
        },
        copyPath: function (dir) {
          if (!dir || dir === "") {
            api.set({ revealMsg: t("plot.pathUnknown"), revealErr: true });
            return;
          }
          var done = function (ok) {
            if (ok === false) {
              api.set({ revealMsg: t("plot.copyFail") + "：" + dir, revealErr: true });
            } else {
              api.set({ revealMsg: t("plot.copied") + "：" + dir, revealErr: false });
            }
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(dir).then(function () { done(true); }, function () { done(false); });
          } else {
            // 非安全上下文降级：显示路径文本供手动复制
            done(true);
          }
        },
        setToggle: function (fn) { toggleRef = fn; },
        openView: function (view) { api.set({ view: view, revealMsg: "", revealErr: false }); },
        setToolGroupOpen: function (patch) { api.set({ toolGroupOpen: Object.assign({}, (this.state && this.state.toolGroupOpen) || {}, patch) }); },
        rawToggle: function (wantOn) {
          if (!wantOn) {
            if (toggleRef) toggleRef({ features: { rawWriting: false } });
            api.set({ rawModal: false, rawCountdown: 0, rawPromiseOpen: false, rawPromiseText: "", rawPromiseOk: false });
            return;
          }
          api.set({ rawModal: true, rawCountdown: 3, rawPromiseOpen: false, rawPromiseText: "", rawPromiseOk: false });
          var timer = setInterval(function () {
            var n = api.getSnapshot().rawCountdown - 1;
            if (n <= 0) { clearInterval(timer); api.set({ rawCountdown: 0 }); }
            else api.set({ rawCountdown: n });
          }, 1000);
        },
        rawConfirm: function () { api.set({ rawModal: false, rawPromiseOpen: true, rawPromiseText: "", rawPromiseOk: false }); },
        rawCancel: function () { api.set({ rawModal: false, rawCountdown: 0, rawPromiseOpen: false, rawPromiseText: "", rawPromiseOk: false }); },
        rawSetPromise: function (text) {
          var ok = String(text || "").indexOf("绝不传播") !== -1 && String(text || "").length >= 5;
          api.set({ rawPromiseText: text || "", rawPromiseOk: ok });
        },
        rawPromiseConfirm: function () {
          if (!api.getSnapshot().rawPromiseOk) return;
          if (toggleRef) toggleRef({ features: { rawWriting: true } });
          api.set({ rawPromiseOpen: false, rawPromiseText: "", rawPromiseOk: false, rawModal: false, rawCountdown: 0 });
        }
      };
      return api;
    }

    // ---- 侧边栏入口 ----
    function sidebarRoot() {
      var column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
      if (column === null) return void 0;
      return column.querySelector('[class*="logoRow"]')?.parentElement ?? column.firstElementChild;
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
      var base = newSessionButton(root);
      var anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : (base !== void 0 ? base.nextElementSibling : null);
      root.insertBefore(entry, anchor);
      return true;
    }
    function mountSidebarEntry(controller, onOpen) {
      var entry = document.createElement("button");
      entry.type = "button";
      entry.dataset.dshNovelWriterEntry = "";
      entry.className = "nwEntry";
      entry.setAttribute("aria-label", t("entry.label"));
      entry.setAttribute("title", t("entry.tooltip"));
      entry.innerHTML = '<span class="nwEntryIcon">✒</span><span class="nwEntryLabel">' + t("entry.label") + "</span>";
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
      var tryPlace = function () {
        if (root !== void 0 && !root.isConnected) {
          rootObserver.disconnect();
          root = void 0;
          placed = false;
        }
        if (placed) {
          if (document.body.contains(entry)) return;
          rootObserver.disconnect();
          root = void 0;
          placed = false;
        }
        root ??= sidebarRoot();
        if (root === void 0) return;
        placed = placeEntry(root, entry);
        if (placed) rootObserver.observe(root, { childList: true, subtree: true });
      };
      var waitObserver = new MutationObserver(function () { tryPlace(); });
      waitObserver.observe(document.body, { childList: true, subtree: true });
      var rootObserver = new MutationObserver(function () {
        if (root === void 0 || !root.isConnected) {
          placed = false;
          tryPlace();
          return;
        }
        if (!root.contains(entry)) placed = placeEntry(root, entry);
      });
      var unsubscribe = controller.subscribe(syncActive);
      syncActive();
      tryPlace();
      return function () {
        waitObserver.disconnect();
        rootObserver.disconnect();
        unsubscribe();
        entry.remove();
      };
    }

    // ---- 开关面板 ----
    function conversationColumn() {
      return document.querySelector('[data-pane="conversation"], [class*="centerCol"]') ?? void 0;
    }
    function Switch(props) {
      return react.createElement(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": props.checked ? "true" : "false",
          disabled: props.disabled,
          className: "nwSwitch" + (props.checked ? " nwSwitchOn" : ""),
          onClick: function () { props.onChange(!props.checked); }
        },
        react.createElement("span", { className: "nwSwitchKnob" })
      );
    }
    function PanelView(props) {
      var force = react.useState(0)[1];
      react.useEffect(function () {
        return props.controller.subscribe(function () { force(function (n) { return n + 1; }); });
      }, []);
      var state = props.controller.getSnapshot();
      var on = state.enabled;
      var view = state.view || "main";
      var el = react.createElement;
      var msg = state.revealMsg !== "" ? el("div", { className: "nwPlotMsg " + (state.revealErr ? "nwPlotErr" : "nwPlotOk" + (state.refreshedAt > 0 ? " nwFlash" : "")) }, state.revealMsg) : null;
      var entry = function (title, hint, count, viewName) {
        return el("button", { type: "button", className: "nwNavEntry", onClick: function () { props.controller.openView(viewName); } },
          el("div", { className: "nwNavEntryText" },
            el("div", { className: "nwNavEntryTitle" }, title),
            el("div", { className: "nwNavEntryHint" }, hint)
          ),
          el("div", { className: "nwNavEntryRight" },
            count === null ? null : el("span", { className: "nwBadge " + (count > 0 ? "nwBadgeOn" : "nwBadgeOff") }, count + " 开"),
            el("span", { className: "nwNavEntryArrow" }, "›")
          )
        );
      };
      var backBtn = function () {
        return el("button", { type: "button", className: "nwBackBtn", onClick: function () { props.controller.openView(view === "baseline" ? "main" : view === "creation-form" ? "creation" : view === "model" || view === "creation" ? "features" : "main"); } }, "‹ " + t("panel.back"));
      };
      var switchRow = function (name, fOn, onToggle, extra) {
        return el("div", { className: "nwToolRow" + (fOn ? " nwToolRowOn" : ""), key: name },
          el("div", { className: "nwToolLabel" },
            el("div", null, t("feature." + name)),
            el("div", { className: "nwToolDesc" }, t("feature." + name + ".desc")),
            extra || null
          ),
          el("button", { type: "button", role: "switch", "aria-checked": fOn ? "true" : "false", className: "nwSwitchSmall" + (fOn ? " nwSwitchSmallOn" : ""), disabled: state.loading,
            onClick: function () { onToggle(name, !fOn); } },
            el("span", { className: "nwSwitchSmallKnob" })
          )
        );
      };
      function formatSize(bytes) {
        if (!bytes || bytes <= 0) return "0 B";
        var units = ["B", "KB", "MB", "GB"];
        var i = 0, v = bytes;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + " " + units[i];
      }
      function engineStatusText(st, t) {
        if (!st) return t("model.engineUnknown");
        if (!st.modelPresent) return t("model.engineMissing");
        if (st.loaded) return t("model.engineReady");
        if (st.error) return String(t("model.engineError")).replace("{err}", String(st.error).slice(0, 80));
        return t("model.engineIdle");
      }
      var pathBox = function (label, dir, target) {
        if (!dir) {
          return el("div", { className: "nwPlotBox nwPlotBoxEmpty" },
            el("div", { className: "nwPlotPath" }, label + "：" + t("plot.pathUnknown")),
            el("div", { className: "nwBtnGroup" },
              el("button", { type: "button", className: "nwBtn", disabled: true }, t("plot.open")),
              el("button", { type: "button", className: "nwBtn", disabled: true }, t("plot.copy"))
            )
          );
        }
        return el("div", { className: "nwPlotBox" },
          el("div", { className: "nwPlotPath", title: dir }, label + "：" + dir),
          el("div", { className: "nwBtnGroup" },
            el("button", { type: "button", className: "nwBtn", disabled: state.revealing, onClick: function () { props.controller.openDir(target); } }, t("plot.open")),
            el("button", { type: "button", className: "nwBtn", onClick: function () { props.controller.copyPath(dir); } }, t("plot.copy"))
          )
        );
      };
      var dirs = state.dirs || {};
      var f = state.features || {};
      var tools = state.tools || {};
      var mergedFeatures = [
        { key: "emotionDeep", keys: ["emotionCaveat", "emotionComplexity"], labelKey: "feature.emotionDeep", descKey: "feature.emotionDeep.desc" },
        { key: "styleDetect", keys: ["genreTheme", "webnovelVibe"], labelKey: "feature.styleDetect", descKey: "feature.styleDetect.desc" }
      ];
      // 主面板功能开关（v2.2.0 化简：合并行 + 语义增强单独行 + 非净化单独行）
      var featureRows = mergedFeatures.map(function (mf) {
        var allOn = mf.keys.every(function (k) { return f[k] !== false; });
        return el("div", { className: "nwToolRow" + (allOn ? " nwToolRowOn" : ""), key: mf.key },
          el("div", { className: "nwToolLabel" },
            el("div", null, t(mf.labelKey)),
            el("div", { className: "nwToolDesc" }, t(mf.descKey))
          ),
          el("button", { type: "button", role: "switch", "aria-checked": allOn ? "true" : "false", className: "nwSwitchSmall" + (allOn ? " nwSwitchSmallOn" : ""), disabled: state.loading,
            onClick: function () {
              var patch = {};
              mf.keys.forEach(function (k) { patch[k] = !allOn; });
              props.toggle({ features: patch });
            } },
            el("span", { className: "nwSwitchSmallKnob" })
          )
        );
      });
      // 语义增强：单独一行 + ⚙ 小模型管理入口（大白话文案）
      featureRows.push(switchRow("semanticEmbedding", f.semanticEmbedding !== false,
        function (n, v) { props.toggle({ features: (function (patch) { patch[n] = v; return patch; })({}) }); },
        el("button", { type: "button", className: "nwModelBtn", title: t("model.manage"), onClick: function (ev) { ev.stopPropagation(); props.controller.openView("model"); } }, "⚙ " + t("model.manage"))
      ));
var TOOL_GROUPS = [
        { key: "analyze", icon: "📊", tools: ["novel_books", "novel_chapters", "novel_read", "novel_keywords", "novel_sentence_analysis", "novel_style_check", "novel_style_report", "novel_semantic_search", "novel_continuity_check"] },
        { key: "settings", icon: "📚", tools: ["novel_settings", "novel_plot", "novel_summary", "novel_import"] },
        { key: "create", icon: "✍️", tools: ["novel_new_chapter", "novel_sentence_config", "novel_outline"] }
      ];
      var toolGroupOpen = state.toolGroupOpen || {};
      var toolRows = TOOL_GROUPS.map(function (grp) {
        var closedCount = grp.tools.filter(function (n) { return tools[n] === false; }).length;
        var isOpen = toolGroupOpen[grp.key] === true;
        var groupOnCount = grp.tools.filter(function (n) { return tools[n] !== false; }).length;
        var groupState = groupOnCount === grp.tools.length ? "on" : groupOnCount === 0 ? "off" : "partial";
        return el("div", { key: grp.key, className: "nwToolGroup" },
          el("div", { className: "nwToolGroupHead" + (isOpen ? " nwToolGroupHeadOpen" : "") },
            el("button", { type: "button", className: "nwToolGroupToggle", title: groupState === "on" ? t("group.allOn") : groupState === "partial" ? t("group.partial") : t("group.allOff"), onClick: function (ev) {
              ev.stopPropagation();
              var patch = {};
              var target = groupState === "on" ? false : true;
              grp.tools.forEach(function (n) { patch[n] = target; });
              props.toggle({ tools: patch });
            } },
              el("span", { className: "nwGroupState nwGroupState" + (groupState === "on" ? "On" : groupState === "partial" ? "Partial" : "Off") },
                groupState !== "off" ? el("span", { className: "nwGroupStateCheck" + (groupState === "partial" ? " nwGroupStateCheckPartial" : "") }, "✓") : null
              )
            ),
            el("button", { type: "button", className: "nwToolGroupHeadBtn", onClick: function () {
              var patch = Object.assign({}, toolGroupOpen); patch[grp.key] = !isOpen;
              props.controller.setToolGroupOpen(patch);
            } },
              el("span", { className: "nwToolGroupIcon" }, grp.icon),
              el("span", { className: "nwToolGroupHeadText" },
                el("span", { className: "nwToolGroupName" }, t("toolGroup." + grp.key) + "（" + groupOnCount + "/" + grp.tools.length + "）"),
                el("span", { className: "nwToolGroupDescInline" }, t("toolGroup." + grp.key + ".desc"))
              ),
              closedCount > 0 ? el("span", { className: "nwToolGroupBadge" }, t("badge.off") + " " + closedCount) : null,
              el("span", { className: "nwToolGroupArrow" }, isOpen ? "▾" : "▸")
            )
          ),
          isOpen ? el("div", { className: "nwToolGroupBody" },
            grp.tools.map(function (name) {
            var checked = tools[name] !== false;
            var desc = t("tool." + name + ".desc");
            var pathExtra = null;
            if (name === "novel_plot") pathExtra = pathBox(t("plot.pathLabel"), dirs.plotsDir || state.plotsDir || "", "plots-dir");
            else if (name === "novel_settings") pathExtra = pathBox(t("dir.settings"), dirs.settingsDir || "", "settings-dir");
            else if (name === "novel_summary") pathExtra = pathBox(t("dir.summaries"), dirs.summariesDir || "", "summaries-dir");
            else if (name === "novel_continuity_check") pathExtra = pathBox(t("dir.audits"), dirs.auditsDir || "", "audits-dir");
            else if (name === "novel_sentence_analysis") pathExtra = pathBox(t("dir.analysis"), dirs.analysisDir || "", "analysis-dir");
            return el("div", { key: name, className: "nwToolItem" },
              el("div", { className: "nwToolRow" + (checked ? " nwToolRowOn" : "") },
                el("div", { className: "nwToolLabel" },
                  el("div", null, String(t("tool." + name)).replace(/\s+novel_\w+$/, "")),
                  el("div", { className: "nwToolDesc" }, desc)
                ),
                el("button", { type: "button", role: "switch", "aria-checked": checked ? "true" : "false", className: "nwSwitchSmall" + (checked ? " nwSwitchSmallOn" : ""), disabled: state.loading,
                  onClick: function () { props.toggle({ tools: (function (patch) { patch[name] = !checked; return patch; })({}) }); } },
                  el("span", { className: "nwSwitchSmallKnob" })
                )
              ),
              pathExtra || null
            );
          })) : null
        );
      });
;
      // v2.6.0 修复：detailFeatures 提升到渲染函数顶部——二级页渲染与主面板计数共用同一列表（此前计数数组漏 webnovelVibe，5 个开关显示"4开"）
      var detailFeatures = ["emotionCaveat", "emotionComplexity", "genreTheme", "webnovelVibe", "semanticEmbedding"];
      var body = null;
      if (view === "features") {
        body = el("div", null,
          backBtn(),
          el("div", { className: "nwSectionTitle" }, t("panel.featuresTitle")),
          el("div", { className: "nwToolsHint" }, t("panel.featuresHint")),
          detailFeatures.map(function (name) {
            var extra = null;
            if (name === "semanticEmbedding") {
              extra = el("button", { type: "button", className: "nwModelBtn", title: t("model.manage"), onClick: function (ev) { ev.stopPropagation(); props.controller.openView("model"); } }, "⚙ " + t("model.manage"));
            }
            return switchRow(name, f[name] !== false, function (n, v) { props.toggle({ features: (function (patch) { patch[n] = v; return patch; })({}) }); }, extra);
          }),
          // v3.1.0：原创模式入口
          el("div", { key: "creationEntry", style: { margin: "8px 0 4px", padding: "10px 12px", borderRadius: "10px", background: "linear-gradient(135deg, rgba(99,102,241,.08), rgba(139,92,246,.08))", border: "1px solid rgba(99,102,241,.25)" } },
            el("button", { type: "button", className: "nwNavEntry", style: { width: "100%", background: "transparent", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }, onClick: function () { props.controller.openView("creation"); } },
              el("div", { className: "nwNavEntryText" },
                el("div", { className: "nwNavEntryTitle" }, "🎨 " + t("panel.creationTitle")),
                el("div", { className: "nwNavEntryHint" }, t("panel.creationHint"))
              ),
              el("div", { className: "nwNavEntryRight" },
                el("span", { className: "nwNavEntryArrow" }, "›")
              )
            )
          )
        );
      } else if (view === "tools") {
        body = el("div", null,
          backBtn(),
          el("div", { className: "nwSectionTitle" }, t("panel.toolsTitle")),
          el("div", { className: "nwToolsHint" }, t("panel.toolsHint")),
          toolRows
        );
      } else if (view === "model") {
        body = el("div", null,
          backBtn(),
          el("div", { className: "nwSectionTitle" }, "🖥 " + t("model.title")),
          el("div", { className: "nwToolsHint" }, t("model.hint")),
          // v2.6.0：语义引擎状态（模型就绪/未加载/缺失/失败）
          el("div", { className: "nwRow nwRowOff" },
            el("div", { className: "nwRowText" },
              el("div", { className: "nwRowLabel" }, t("model.engine")),
              el("div", { className: "nwRowHint" }, engineStatusText(state.embeddingStatus, t))
            )
          ),
          switchRow("semanticSearch", f.semanticSearch !== false, function (n, v) { props.toggle({ features: (function (patch) { patch[n] = v; return patch; })({}) }); }),
          switchRow("semanticStyle", f.semanticStyle !== false, function (n, v) { props.toggle({ features: (function (patch) { patch[n] = v; return patch; })({}) }); }),
          switchRow("semanticImplicit", f.semanticImplicit !== false, function (n, v) { props.toggle({ features: (function (patch) { patch[n] = v; return patch; })({}) }); }),
          pathBox(t("dir.embedding"), dirs.embeddingDir || "", "embedding-dir")
        );
      } else if (view === "baseline") {
        // v3.0.0：风格基线——六维文笔指标 ±% 容差带（左=允许低于，右=允许高于）
        var NW_METRICS = [
          ["complexity", "句法复杂度", "📐"], ["modifierDensity", "修饰密度", "🎨"], ["abstractDensity", "抽象度", "☁️"],
          ["actionDensity", "动作密度", "⚡"], ["hedgeDensity", "不确定性", "🌫️"], ["gapIndex", "留白指数", "🕳️"]
        ];
        // v3.0.0：输入框留空 = 使用推荐容差（原著章节波动 1.5σ）；填了才保存自定义
        var tolState = state.styleTolerance && typeof state.styleTolerance === "object" ? state.styleTolerance : null;
        var draft = state.baselineDraft;
        if (!draft) {
          draft = {};
          for (var mi = 0; mi < NW_METRICS.length; mi += 1) {
            var mk = NW_METRICS[mi][0];
            var cur = tolState && tolState[mk] ? tolState[mk] : null;
            // v3.0.0：内部统一存正数（正负号由位置决定：低于=负、高于=正）
            draft[mk] = { low: cur && typeof cur.low === "number" ? Math.abs(cur.low) : "", high: cur && typeof cur.high === "number" ? Math.abs(cur.high) : "" };
          }
        }
        var setDraft = function (mk, field, value) {
          var next = {};
          for (var k in draft) { next[k] = { low: draft[k].low, high: draft[k].high }; }
          next[mk] = { low: draft[mk].low, high: draft[mk].high };
          var v = String(value).trim();
          if (v === "") next[mk][field] = "";
          else {
            // v3.0.0：只收 0-100 正数（正负号由位置决定）
            var n = Math.abs(parseInt(v, 10));
            if (isNaN(n)) n = "";
            else n = Math.min(100, n);
            next[mk][field] = n;
          }
          props.controller.set({ baselineDraft: next });
        };
        var saveFlash = function () {
          props.controller.set({ baselineSaved: true });
          setTimeout(function () { props.controller.set({ baselineSaved: false }); }, 1800);
        };
        var saveTol = function () {
          // 只保存填写了低+高的维度；全空 → null（全部用推荐）
          var tol = {};
          var any = false;
          for (var si = 0; si < NW_METRICS.length; si += 1) {
            var sk = NW_METRICS[si][0];
            var sd = draft[sk];
            if (sd && sd.low !== "" && sd.high !== "") { tol[sk] = { low: -sd.low, high: sd.high }; any = true; }
          }
          props.toggle({ styleTolerance: any ? tol : null });
          props.controller.set({ baselineDraft: null, revealMsg: t("baseline.saved"), revealErr: false });
          saveFlash();
        };
        var resetTol = function () {
          // 恢复默认：清除自定义并保存（回到推荐模式），输入框清空
          props.toggle({ styleTolerance: null });
          props.controller.set({ baselineDraft: null, revealMsg: t("baseline.saved"), revealErr: false });
          saveFlash();
        };
        body = el("div", null,
          backBtn(),
          el("div", { className: "nwSectionTitle" }, "🎯 " + t("panel.baselineTitle")),
          el("div", { className: "nwToolsHint" }, t("baseline.desc")),
          el("div", { className: "nwTolVer" }, "v3.0.0-UI3"),
          el("div", { className: "nwTolCard", style: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "4px 14px 8px", margin: "8px 0 4px" } },
            NW_METRICS.map(function (item) {
              var mk2 = item[0];
              var d = draft[mk2] || DEFAULT_TOL;
              return el("div", { className: "nwTolRow", key: mk2, style: { display: "flex", alignItems: "center", gap: "10px", padding: "9px 2px" } },
                el("div", { className: "nwTolName", style: { flex: "1", minWidth: "0", display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: "500", whiteSpace: "nowrap", color: "#334155" } }, el("span", { className: "nwTolIcon", style: { fontSize: "15px" } }, item[2]), item[1]),
                el("div", { className: "nwTolField", style: { width: "74px", flexShrink: "0", display: "flex", flexDirection: "column", gap: "3px" } },
                  el("div", { style: { display: "flex", alignItems: "center", gap: "4px" } },
                    el("span", { className: "nwTolSign", style: { width: "12px", flexShrink: "0", textAlign: "center", fontSize: "14px", color: "#ef4444", fontWeight: "600" } }, "−"),
                    el("input", { type: "number", className: "nwTolInput", placeholder: "推荐", value: d.low, min: 0, max: 100, style: { width: "100%", height: "30px", boxSizing: "border-box", border: "1px solid #d4d4d8", borderRadius: "8px", fontSize: "13px", textAlign: "center", background: "#fafafa", color: "#18181b", outline: "none", MozAppearance: "textfield" }, onChange: function (ev) { setDraft(mk2, "low", ev.target.value); } })
                  ),
                  el("span", { className: "nwTolCaption", style: { fontSize: "10px", color: "#94a3b8", textAlign: "center" } }, t("baseline.low"))
                ),
                el("span", { className: "nwTolSep", style: { width: "14px", flexShrink: "0", fontSize: "12px", color: "#b0b8c4", textAlign: "center" } }, "~"),
                el("div", { className: "nwTolField", style: { width: "74px", flexShrink: "0", display: "flex", flexDirection: "column", gap: "3px" } },
                  el("div", { style: { display: "flex", alignItems: "center", gap: "4px" } },
                    el("span", { className: "nwTolSign", style: { width: "12px", flexShrink: "0", textAlign: "center", fontSize: "14px", color: "#10b981", fontWeight: "600" } }, "+"),
                    el("input", { type: "number", className: "nwTolInput", placeholder: "推荐", value: d.high, min: 0, max: 100, style: { width: "100%", height: "30px", boxSizing: "border-box", border: "1px solid #d4d4d8", borderRadius: "8px", fontSize: "13px", textAlign: "center", background: "#fafafa", color: "#18181b", outline: "none", MozAppearance: "textfield" }, onChange: function (ev) { setDraft(mk2, "high", ev.target.value); } })
                  ),
                  el("span", { className: "nwTolCaption", style: { fontSize: "10px", color: "#94a3b8", textAlign: "center" } }, t("baseline.high"))
                ),
                el("span", { className: "nwTolPct", style: { width: "14px", flexShrink: "0", fontSize: "13px", color: "#64748b" } }, "%")
              );
            })
          ),
          el("div", { className: "nwTolBtns", style: { display: "flex", gap: "12px", marginTop: "16px" } },
            el("button", { type: "button", className: "nwBtn nwBtnPrimary" + (state.baselineSaved ? " nwBtnDone" : ""), onClick: saveTol, style: state.baselineSaved ? { background: "linear-gradient(135deg,#10b981,#34d399)", border: "none", color: "#fff", fontWeight: "600", fontSize: "13px", padding: "9px 20px", borderRadius: "10px", cursor: "pointer" } : { background: "linear-gradient(135deg,#6366f1,#8b5cf6)", border: "none", color: "#fff", fontWeight: "600", fontSize: "13px", padding: "9px 20px", borderRadius: "10px", cursor: "pointer" } }, state.baselineSaved ? "✓ " + t("baseline.saved") : "💾 " + t("baseline.save")),
            el("button", { type: "button", className: "nwBtn nwBtnGhost", onClick: resetTol, style: { background: "transparent", border: "1px solid #cbd5e1", color: "#475569", fontSize: "13px", padding: "9px 18px", borderRadius: "10px", cursor: "pointer" } }, "↺ " + t("baseline.reset"))
          )
        );
            } else if (view === "creation" || view === "creation-form") {
        // v3.1.0：原创模式设定库（方案 C：列表页 + 表单页 + 快速切换）
        var CREATION_FIELDS = [
          ["worldview", "🌍", t("creation.worldview"), "例如：末日后异能世界…"],
          ["characters", "🎭", t("creation.characters"), "例如：女主冷静克制，有秘密…"],
          ["forbidden", "🚫", t("creation.forbidden"), "例如：不能有重生/系统/金手指…"],
          ["mainConflict", "🎯", t("creation.mainConflict"), "例如：女主寻找失踪的同伴…"],
          ["genre", "📚", t("creation.genre"), "例如：悬疑+救赎，都市背景…"],
          ["extra", "📝", t("creation.extra"), "例如：每章结尾留钩子，多对话…"]
        ];
        var cpGlobal = state.creationProfile && typeof state.creationProfile === "object" ? state.creationProfile : {};
        var cpBooks = state.creationProfiles && typeof state.creationProfiles === "object" ? state.creationProfiles : {};
        var bookList = Array.isArray(state.books) ? state.books.slice() : [];
        // 合并：设定库条目 ∪ novels 目录（去重，默认放最前）
        var allBooks = [];
        for (var bi2 = 0; bi2 < bookList.length; bi2 += 1) if (allBooks.indexOf(bookList[bi2]) === -1) allBooks.push(bookList[bi2]);
        for (var bk2 in cpBooks) if (allBooks.indexOf(bk2) === -1) allBooks.push(bk2);
        allBooks.sort(function (a, b) { return a.localeCompare(b, "zh"); });

        function profileOf(bookName) {
          if (!bookName || bookName === "") return cpGlobal;
          return cpBooks[bookName] && typeof cpBooks[bookName] === "object" ? cpBooks[bookName] : {};
        }
        function filledCount(profile) {
          var c = 0;
          for (var fi = 0; fi < CREATION_FIELDS.length; fi += 1) {
            var fk = CREATION_FIELDS[fi][0];
            if (typeof profile[fk] === "string" && profile[fk].trim()) c += 1;
          }
          return c;
        }
        function summaryOf(profile) {
          var c = filledCount(profile);
          if (c === 0) return t("creation.none");
          var first = "";
          for (var fi2 = 0; fi2 < CREATION_FIELDS.length; fi2 += 1) {
            var fk2 = CREATION_FIELDS[fi2][0];
            if (typeof profile[fk2] === "string" && profile[fk2].trim()) { first = profile[fk2].trim(); break; }
          }
          return c + " " + t("creation.items") + " · " + (first.length > 18 ? first.slice(0, 18) + "…" : first);
        }
        // ---- 列表页 ----
        if (view === "creation") {
          var newBookName = state.creationNewBook || "";
          var createNewBook = function () {
            var nb = String(newBookName || "").trim();
            if (!nb) {
              var elInp = document.getElementById("nwNewBookInput");
              if (elInp) { elInp.focus(); elInp.style.borderColor = "#ef4444"; elInp.style.boxShadow = "0 0 0 3px rgba(239,68,68,.15)"; }
              props.controller.set({ revealMsg: t("creation.needName"), revealErr: true });
              return;
            }
            props.controller.set({ creationNewBook: "", creationBook: nb, creationDraft: null, creationDirty: false, revealMsg: t("creation.newed"), revealErr: false });
            props.controller.openView("creation-form");
          };
          function bookRow(name, profile, isDefault) {
            var filled = filledCount(profile);
            return el("div", { key: "bk-" + name, style: { display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", borderRadius: "10px", border: "1px solid #e2e8f0", background: "#fff" } },
              el("div", { style: { flex: "1", minWidth: "0" } },
                el("div", { style: { fontSize: "13px", fontWeight: "600", color: "#334155" } }, isDefault ? "🌐 " + t("creation.default") : "📕 " + name),
                el("div", { style: { fontSize: "11px", color: filled > 0 ? "#6366f1" : "#94a3b8", marginTop: "2px" } }, summaryOf(profile)),
                isDefault ? el("div", { style: { fontSize: "10px", color: "#cbd5e1", marginTop: "1px" } }, t("creation.defaultHint")) : null
              ),
              el("button", { type: "button", onClick: function () { props.controller.set({ creationBook: name, creationDraft: null, creationDirty: false }); props.controller.openView("creation-form"); } }, t("creation.edit")),
              isDefault ? null : el("button", { type: "button", onClick: function () { var patch = {}; patch[name] = null; props.toggle({ creationProfiles: patch }); var nb = (props.controller.getSnapshot().books || []).filter(function (b) { return b !== name; }); props.controller.set({ books: nb, revealMsg: t("creation.deleted"), revealErr: false }); } }, t("creation.delete"))
            );
          }
          body = el("div", null,
            backBtn(),
            el("div", { className: "nwSectionTitle" }, "🎨 " + t("panel.creationTitle") + " · " + t("creation.listTitle")),
            el("div", { className: "nwToolsHint" }, t("creation.desc2")),
            // 新建设定
            el("div", { style: { display: "flex", gap: "8px", marginTop: "8px", marginBottom: "10px" } },
              el("input", { id: "nwNewBookInput", type: "text", value: newBookName, placeholder: t("creation.newPlaceholder"), style: { flex: "1", height: "34px", boxSizing: "border-box", padding: "0 12px", border: "1px solid #d4d4d8", borderRadius: "10px", fontSize: "13px", background: "#fff", color: "#18181b", outline: "none", transition: "border-color .15s ease, box-shadow .15s ease" }, onInput: function (ev) { props.controller.set({ creationNewBook: ev.target.value }); }, onFocus: function (ev) { ev.target.style.borderColor = "#6366f1"; ev.target.style.boxShadow = "0 0 0 3px rgba(99,102,241,.14)"; }, onBlur: function (ev) { ev.target.style.borderColor = "#d4d4d8"; ev.target.style.boxShadow = "none"; }, onKeyDown: function (ev) { if (ev.key === "Enter") { ev.preventDefault(); createNewBook(); } } }),
              el("button", { type: "button", style: { height: "34px", padding: "0 16px", borderRadius: "10px", border: "none", background: "linear-gradient(135deg,#6366f1,#8b5cf6)", color: "#fff", fontWeight: "600", fontSize: "13px", cursor: "pointer" }, onClick: createNewBook }, t("creation.new"))
            ),
            el("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
              bookRow("", cpGlobal, true),
              allBooks.map(function (name) { return bookRow(name, profileOf(name), false); })
            )
          );
        } else {
          // ---- 表单页 ----
          var curBook = state.creationBook || "";
          var curProfile = profileOf(curBook);
          var formDraft = state.creationDraft;
          if (!formDraft) {
            formDraft = {};
            for (var ci3 = 0; ci3 < CREATION_FIELDS.length; ci3 += 1) {
              var cf3 = CREATION_FIELDS[ci3][0];
              formDraft[cf3] = typeof curProfile[cf3] === "string" ? curProfile[cf3] : "";
            }
          }
          function setFormDraft(field, value) {
            var next = {};
            for (var k3 in formDraft) next[k3] = formDraft[k3];
            next[field] = value;
            props.controller.set({ creationDraft: next, creationDirty: true });
          }
          function saveForm() {
            var profile = {};
            var any = false;
            for (var si3 = 0; si3 < CREATION_FIELDS.length; si3 += 1) {
              var sk3 = CREATION_FIELDS[si3][0];
              var sv3 = String(formDraft[sk3] || "").trim();
              if (sv3 !== "") { profile[sk3] = sv3; any = true; }
            }
            if (!curBook) {
              props.toggle({ creationProfile: any ? profile : null });
            } else {
              var patch2 = {};
              patch2[curBook] = any ? profile : null;
              props.toggle({ creationProfiles: patch2 });
            }
            props.controller.set({ creationDraft: null, creationDirty: false, revealMsg: t(any ? "creation.saved" : "creation.cleared"), revealErr: false });
          }
          function clearForm() {
            if (!curBook) { props.toggle({ creationProfile: null }); }
            else { var p3 = {}; p3[curBook] = null; props.toggle({ creationProfiles: p3 }); }
            props.controller.set({ creationDraft: null, creationDirty: false, revealMsg: t("creation.cleared"), revealErr: false });
          }
          function switchBook(newName) {
            if (state.creationDirty && newName !== curBook) {
              if (!window.confirm(t("creation.dirtyWarn"))) return;
            }
            props.controller.set({ creationBook: newName, creationDraft: null, creationDirty: false });
          }
          var switchOpts = [el("option", { key: "opt-default", value: "" }, "🌐 " + t("creation.default"))];
          for (var si4 = 0; si4 < allBooks.length; si4 += 1) {
            var bn = allBooks[si4];
            switchOpts.push(el("option", { key: "opt-" + bn, value: bn }, "📕 " + bn));
          }
          body = el("div", null,
            backBtn(),
            el("div", { className: "nwSectionTitle" }, "🎨 " + (curBook ? curBook : t("creation.default")) + " · " + t("creation.formTitle")),
            // 快速切换
            el("div", { style: { display: "flex", alignItems: "center", gap: "8px", margin: "4px 0 10px" } },
              el("span", { style: { fontSize: "12px", color: "#64748b" } }, t("creation.bookFor")),
              el("select", { value: curBook, style: { height: "32px", padding: "0 10px", borderRadius: "8px", border: "1px solid #d4d4d8", background: "#fff", color: "#18181b", fontSize: "13px", outline: "none" }, onChange: function (ev) { switchBook(ev.target.value); } }, switchOpts)
            ),
            el("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
              CREATION_FIELDS.map(function (item) {
                var cf4 = item[0];
                return el("div", { key: cf4, style: { display: "flex", flexDirection: "column", gap: "4px" } },
                  el("div", { style: { fontSize: "13px", fontWeight: "500", color: "#334155", display: "flex", alignItems: "center", gap: "6px" } }, item[1] + " " + item[2]),
                  el("textarea", { className: "nwCreationInput", value: formDraft[cf4] || "", rows: 2, placeholder: item[3], style: { width: "100%", boxSizing: "border-box", minHeight: "56px", padding: "10px 12px", border: "1px solid #d4d4d8", borderRadius: "10px", fontSize: "13px", fontFamily: "inherit", resize: "vertical", background: "#fff", color: "#18181b", outline: "none", lineHeight: "1.6", transition: "border-color .15s ease, box-shadow .15s ease, background .15s ease", boxShadow: "0 1px 2px rgba(15,23,42,.04)" }, onInput: function (ev) { setFormDraft(cf4, ev.target.value); }, onFocus: function (ev) { ev.target.style.borderColor = "#6366f1"; ev.target.style.boxShadow = "0 0 0 3px rgba(99,102,241,.14)"; }, onBlur: function (ev) { ev.target.style.borderColor = "#d4d4d8"; ev.target.style.boxShadow = "0 1px 2px rgba(15,23,42,.04)"; } })
                );
              })
            ),
            el("div", { style: { display: "flex", gap: "12px", marginTop: "14px" } },
              el("button", { type: "button", className: "nwBtn", style: { background: "linear-gradient(135deg,#6366f1,#8b5cf6)", border: "none", color: "#fff", fontWeight: "600", fontSize: "13px", padding: "9px 20px", borderRadius: "10px", cursor: "pointer" }, onClick: saveForm }, "💾 " + t("creation.save")),
              el("button", { type: "button", className: "nwBtn", style: { background: "transparent", border: "1px solid #cbd5e1", color: "#475569", fontSize: "13px", padding: "9px 18px", borderRadius: "10px", cursor: "pointer" }, onClick: clearForm }, "↺ " + t("creation.clear"))
            )
          );
        }      } else {
        var onFeatures = detailFeatures.filter(function (k) { return f[k] !== false; }).length;
        var onTools = ALL_TOOLS.filter(function (k) { return tools[k] !== false; }).length;
        body = el("div", null,
          // v2.6.5：更新提示条（有新版才显示，点击跳 GitHub Release）
          state.updateCheck && state.updateCheck.updateAvailable && state.updateCheck.releaseUrl
            ? el("a", { className: "nwUpdateBar", href: state.updateCheck.releaseUrl, target: "_blank", rel: "noopener noreferrer" },
                "📢 " + t("update.title") + " v" + state.updateCheck.latestVersion + " " + t("update.go"))
            : null,
          el("div", { className: "nwRow " + (state.enabled ? "nwRowOn" : "nwRowOff") },
            el("div", { className: "nwRowText" },
              el("div", { className: "nwRowLabel" }, t("panel.enabled")),
              el("div", { className: "nwRowHint" }, t("panel.enabledHint"))
            ),
            el("div", { className: "nwSwitchWrap" },
              el(Switch, { checked: state.enabled, disabled: state.loading, onChange: function (value) { props.toggle({ enabled: value }); } }),
              el("span", { className: "nwBadge " + (state.enabled ? "nwBadgeOn" : "nwBadgeOff") }, state.enabled ? t("badge.on") : t("badge.off"))
            )
          ),
          el("div", { className: "nwRow " + (state.autoAnalyze ? "nwRowOn" : "nwRowOff") },
            el("div", { className: "nwRowText" },
              el("div", { className: "nwRowLabel" }, t("panel.autoAnalyze")),
              el("div", { className: "nwRowHint" }, t("panel.autoAnalyzeHint"))
            ),
            el("div", { className: "nwSwitchWrap" },
              el(Switch, { checked: state.autoAnalyze, disabled: state.loading, onChange: function (value) { props.toggle({ autoAnalyze: value }); } }),
              el("span", { className: "nwBadge " + (state.autoAnalyze ? "nwBadgeOn" : "nwBadgeOff") }, state.autoAnalyze ? t("badge.on") : t("badge.off"))
            )
          ),
          // 非净化模式（主页直接可见，红色危险选项）
          (function () {
            var rawOn = f.rawWriting === true;
            return el("div", { className: "nwToolRow" + (rawOn ? " nwToolRowOn" : " nwToolRowRaw"), key: "rawWriting" },
              el("div", { className: "nwToolLabel" },
                el("div", { className: "nwToolLabelRaw" }, "🔞 " + t("feature.rawWriting")),
                el("div", { className: "nwToolDesc nwRawDanger" }, t("raw.danger")),
                rawOn ? el("div", { className: "nwRawOn" }, t("raw.on")) : null
              ),
              el("button", { type: "button", role: "switch", "aria-checked": rawOn ? "true" : "false", className: "nwSwitchSmall" + (rawOn ? " nwSwitchSmallOn" : ""), disabled: state.loading,
                onClick: function () { props.controller.rawToggle(!rawOn); } },
                el("span", { className: "nwSwitchSmallKnob" })
              )
            );
          })(),
          entry(t("panel.featuresTitle"), t("panel.featuresHint"), onFeatures, "features"),
          entry(t("panel.toolsTitle"), t("panel.toolsHint"), onTools, "tools"),
          // v3.0.0：风格基线（六维 ±% 容差带）
          entry(t("panel.baselineTitle"), t("panel.baselineHint"), null, "baseline"),
          // v2.6.0：数据目录占用 + 语义引擎状态（一目了然）
          el("div", { className: "nwRow nwRowOff" },
            el("div", { className: "nwRowText" },
              el("div", { className: "nwRowLabel" }, t("dir.size")),
              el("div", { className: "nwRowHint" }, formatSize(state.dataDirSize) + " · " + engineStatusText(state.embeddingStatus, t))
            )
          ),
          pathBox(t("dir.data"), dirs.dataDir || state.dataDir || "", "data-dir")
        );
      }
      // 非净化模式弹窗（确认 + 倒计时 / 承诺输入）
      if (state.rawModal) {
        body = el("div", { className: "nwModal" },
          el("div", { className: "nwModalBox" },
            el("div", { className: "nwModalTitle" }, "🔞 " + t("raw.confirmTitle")),
            el("div", { className: "nwModalText" }, t("raw.confirmText")),
            el("div", { className: "nwModalBtns" },
              el("button", { type: "button", className: "nwBtn", disabled: state.rawCountdown > 0, onClick: function () { props.controller.rawConfirm(); } },
                state.rawCountdown > 0 ? t("raw.confirmWait") + " (" + state.rawCountdown + "s)" : t("raw.confirmOk")),
              el("button", { type: "button", className: "nwBtn", onClick: function () { props.controller.rawCancel(); } }, t("raw.cancel"))
            )
          )
        );
      } else if (state.rawPromiseOpen) {
        body = el("div", { className: "nwModal" },
          el("div", { className: "nwModalBox" },
            el("div", { className: "nwModalTitle" }, "🔞 " + t("raw.promiseTitle")),
            el("div", { className: "nwModalText" }, t("raw.promiseText")),
            el("input", { type: "text", className: "nwModalInput", value: state.rawPromiseText || "", placeholder: t("raw.promisePlaceholder"), onChange: function (e) { props.controller.rawSetPromise(e.target.value); } }),
            el("div", { className: "nwModalBtns" },
              el("button", { type: "button", className: "nwBtn" + (state.rawPromiseOk ? " nwBtnDanger" : ""), disabled: !state.rawPromiseOk, onClick: function () { props.controller.rawPromiseConfirm(); } }, t("raw.promiseOk")),
              el("button", { type: "button", className: "nwBtn", onClick: function () { props.controller.rawCancel(); } }, t("raw.cancel"))
            )
          )
        );
      }
      return el("div", { className: "nwPanel" },
        el("div", { className: "nwPanelHeader" },
          el("div", { className: "nwPanelTitle" }, t("panel.title") + (view !== "main" ? " › " + (view === "features" ? t("panel.featuresTitle") : view === "tools" ? t("panel.toolsTitle") : view === "baseline" ? t("panel.baselineTitle") : view === "creation" ? t("panel.creationTitle") : view === "creation-form" ? t("panel.creationTitle") + " · " + t("creation.formTitle") : t("model.title")) : "")),
          el("button", { type: "button", className: "nwRefresh" + (state.refreshing ? " nwRefreshSpin" : ""), onClick: function () { props.controller.refresh(); } }, state.refreshing ? "⟳" : t("panel.refresh")),
          el("button", { type: "button", className: "nwClose", "aria-label": t("panel.close"), onClick: props.onClose }, "×")
        ),
        el("div", { className: "nwBanner " + (on ? "nwBannerOn" : "nwBannerOff") },
          el("span", { className: "nwBannerIcon" }, on ? "✔" : "✘"),
          el("span", null, on ? t("banner.on") : t("banner.off"))
        ),
        msg,
        body
      );
    }

    /** 官方设置页「插件配置」槽位卡片（v0.5.0 统一版）：状态只读 + 跳转按钮，开关只在侧边栏面板。 */
    function NovelWriterSettingsCard(props) {
      var state = props.controller.getSnapshot();
      var force = react.useState(0)[1];
      react.useEffect(function () {
        return props.controller.subscribe(function () { force(function (n) { return n + 1; }); });
      }, []);
      state = props.controller.getSnapshot();
      var statusKey = state.enabled ? (state.autoAnalyze ? "card.status" : "card.statusAutoOff") : "card.statusOff";
      return react.createElement(
        "div",
        { style: { padding: "12px 0", borderBottom: "1px solid var(--dsw-alias-border-l2, #e5e7eb)" } },
        react.createElement("div", { style: { fontWeight: 600 } }, t("card.title")),
        react.createElement("div", { style: { color: "var(--dsw-alias-text-l2, #888)", fontSize: 12, margin: "4px 0 8px" } }, t("card.desc")),
        react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 4 } },
          react.createElement(
            "span",
            {
              style: {
                display: "inline-flex", alignItems: "center", gap: 6,
                fontSize: 12, fontWeight: 700, lineHeight: 1,
                padding: "4px 10px", borderRadius: 999,
                background: state.enabled ? "rgba(34,197,94,.14)" : "rgba(239,68,68,.10)",
                color: state.enabled ? "#15803d" : "#b91c1c",
                border: "1px solid " + (state.enabled ? "#22c55e" : "#ef4444")
              }
            },
            react.createElement("span", null, state.enabled ? "●" : "○"),
            react.createElement("span", null, t(statusKey))
          ),
          react.createElement(
            "button",
            {
              type: "button",
              style: {
                appearance: "none", font: "inherit", cursor: "pointer",
                border: "1px solid var(--dsw-alias-border-l2, #d1d5db)", borderRadius: 8,
                background: "var(--dsw-alias-bg-layer-3, #fff)", color: "inherit",
                padding: "5px 12px", fontSize: 12
              },
              onClick: function () {
                if (typeof props.onOpenPanel === "function") props.onOpenPanel();
              }
            },
            t("card.open")
          )
        ),
        react.createElement("div", { style: { color: "var(--dsw-alias-text-l2, #888)", fontSize: 12, marginTop: 8 } }, t("card.hint"))
      );
    }
    function mountPanel(controller, toggle) {
      var container;
      var root;
      var render = function () {
        if (root === void 0) return;
        try {
          root.render(react.createElement(PanelView, {
            controller: controller,
            toggle: toggle,
            onClose: function () { controller.set({ panelOpen: false }); }
          }));
        } catch (error) {
          console.error("[dsh-novel-writer] panel render failed:", error);
        }
      };
      var syncOpen = function () {
        var open = controller.getSnapshot().panelOpen;
        if (container !== void 0) container.style.display = open ? "block" : "none";
        if (open) {
          document.documentElement.dataset.dshNovelWriterActive = "";
          delete document.documentElement.dataset.dshSshActive;
          delete document.documentElement.dataset.dshTaskboardActive;
          document.documentElement.dispatchEvent(new CustomEvent("dsh-panel-activate", { detail: "novel-writer" }));
        } else {
          delete document.documentElement.dataset.dshNovelWriterActive;
        }
      };
      var ensure = function () {
        if (container !== void 0 && container.isConnected === true) return;
        var column = conversationColumn();
        if (column === void 0) return;
        container = document.createElement("div");
        container.dataset.dshNovelWriterView = "";
        container.style.display = "none";
        column.appendChild(container);
        try {
          root = react_dom_client.createRoot(container);
        } catch (error) {
          console.error("[dsh-novel-writer] createRoot failed:", error);
          container = void 0;
          root = void 0;
          return;
        }
        render();
        syncOpen();
      };
      var waitObserver = new MutationObserver(function () { ensure(); });
      try {
        waitObserver.observe(document.body, { childList: true, subtree: true });
      } catch (error) { /* body not ready yet */ }
      var unsubscribe = controller.subscribe(function () { render(); syncOpen(); });
      var onOtherPanel = function (event) {
        if (event.detail !== "novel-writer" && controller.getSnapshot().panelOpen) {
          controller.set({ panelOpen: false });
        }
      };
      document.addEventListener("dsh-panel-activate", onOtherPanel);
      ensure();
      return function () {
        waitObserver.disconnect();
        document.removeEventListener("dsh-panel-activate", onOtherPanel);
        unsubscribe();
        if (root !== void 0) {
          try { root.unmount(); } catch (error) { /* ignore */ }
        }
        if (container !== void 0) {
          try { container.remove(); } catch (error) { /* ignore */ }
        }
      };
    }

    // ---- 插件入口 ----
    var inject = ["slots", "locale"];
    var applied = false;
    function apply(ctx) {
      if (applied) return;
      applied = true;
      var controller = createController();
      var load = async function () {
        // v2.6.5：更新检查（独立请求，3s 超时由后端兜底；失败静默不影响面板）
        fetch("/api/dsh-novel-writer/update-check", { headers: { accept: "application/json" } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (uc) { if (uc) controller.set({ updateCheck: uc }); })
          .catch(function () { /* 静默 */ });
        try {
          var remote = await fetchState();
          controller.set({
            enabled: !!remote.enabled,
            autoAnalyze: !!remote.autoAnalyze,
            tools: remote.tools || {},
            features: remote.features || {},
            plotsDir: remote.plotsDir || "",
            dataDir: remote.dataDir || "",
            // v2.6.0：初始加载同样接入数据目录占用 + 语义引擎状态（与 refresh 白名单一致）
            dataDirSize: remote.dataDirSize || 0,
            embeddingStatus: remote.embeddingStatus || null,
            styleTolerance: remote.styleTolerance || null,
            creationProfile: remote.creationProfile || null,
            creationProfiles: remote.creationProfiles || {},
            books: remote.books || [],
            dirs: remote.dirs || null,
            file: remote.file || "",
            source: "host",
            hostOk: true,
            loading: false
          });
          return;
        } catch (error) { /* host unreachable */ }
        try {
          var local = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
          controller.set({
            enabled: typeof local.enabled === "boolean" ? local.enabled : true,
            autoAnalyze: typeof local.autoAnalyze === "boolean" ? local.autoAnalyze : true,
            source: "local",
            hostOk: false,
            loading: false
          });
        } catch (error) {
          controller.set({ loading: false, hostOk: false });
        }
      };
      load();
      var toggle = async function (patch) {
        // v2.6.0 修复：features/tools 深合并——此前浅合并整体替换 state.features，其他开关键丢失后渲染为"开"（关 A 后关 B，A 又变开）
        var merged = Object.assign({}, patch, { saveFailed: false });
        var cur = controller.getSnapshot();
        if (patch.features && typeof patch.features === "object") {
          merged.features = Object.assign({}, cur.features || {}, patch.features);
        }
        if (patch.tools && typeof patch.tools === "object") {
          merged.tools = Object.assign({}, cur.tools || {}, patch.tools);
        }
        // v3.1.1：creationProfiles 深合并（null 键=删除该书的设定，本地立即生效）
        if (patch.creationProfiles && typeof patch.creationProfiles === "object") {
          var mergedCp = Object.assign({}, cur.creationProfiles || {});
          for (var cpk in patch.creationProfiles) {
            if (patch.creationProfiles[cpk] === null) delete mergedCp[cpk];
            else mergedCp[cpk] = patch.creationProfiles[cpk];
          }
          merged.creationProfiles = mergedCp;
        }
        controller.set(merged);
        try {
          var remote = await saveState(patch);
          controller.set({
            enabled: !!remote.enabled,
            autoAnalyze: !!remote.autoAnalyze,
            file: remote.file || controller.getSnapshot().file,
            source: "host",
            hostOk: true
          });
          try { localStorage.removeItem(STORAGE_KEY); } catch (error) { /* ignore */ }
          return;
        } catch (error) { /* fall through */ }
        controller.set({ hostOk: false, saveFailed: true, source: "local" });
        try {
          var snapshot = controller.getSnapshot();
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: snapshot.enabled, autoAnalyze: snapshot.autoAnalyze }));
        } catch (error) { /* ignore */ }
      };
            controller.setToggle(toggle);
var openPanel = function () {
        controller.set({ panelOpen: !controller.getSnapshot().panelOpen });
      };
      var disposers = [];
      try {
        disposers.push(mountSidebarEntry(controller, openPanel));
        disposers.push(mountPanel(controller, toggle));
      } catch (error) {
        console.warn("[dsh-novel-writer] UI mount failed:", error);
      }
      // 官方设置页「插件配置」卡片（v0.4.0 合并；slots 服务由 inject 声明）
      try {
        ctx.slots.inject("settings.plugin.item", function () {
          return ctx.slots.register({
            name: "settings.plugin.item",
            key: "novel-writer-config",
            id: "novel-writer-config",
            order: 105,
            inject: function () { return {}; }
          }, function () {
            return react.createElement(NovelWriterSettingsCard, { controller: controller, toggle: toggle, onOpenPanel: openPanel });
          });
        });
      } catch (error) {
        console.warn("[dsh-novel-writer] settings card mount failed:", error);
      }
      ctx.effect?.(function () {
        return function () {
          for (var i = 0; i < disposers.length; i += 1) {
            try { disposers[i](); } catch (error) { /* ignore */ }
          }
        };
      }, "dsh-novel-writer: ui");
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
