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
    var css = "[data-pane=conversation],[class*=centerCol]{position:relative}" +
      "[data-dsh-novel-writer-view]{position:absolute;inset:0;z-index:60;background:var(--dsw-alias-bg-base,#fff);display:none;overflow:auto}" +
      "html[data-dsh-novel-writer-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]) [data-dsh-novel-writer-view]{display:block}" +
      "html[data-dsh-novel-writer-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]) [data-pane=conversation]>:not([data-dsh-novel-writer-view])," +
      "html[data-dsh-novel-writer-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]) [class*=centerCol]>:not([data-dsh-novel-writer-view]){display:none!important}" +
      ".nwEntry{width:100%;height:32px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-radius:8px;align-items:center;gap:8px;padding:0 12px;font-size:13px;display:flex}" +
      ".nwEntry:hover{background:var(--dsw-specific-sidebar-nav-item-hover);color:var(--dsw-alias-label-primary)}" +
      ".nwEntry[data-active]{background:var(--dsw-specific-sidebar-nav-item-active);color:var(--dsw-alias-label-primary);font-weight:600}" +
      ".nwEntryIcon{flex:none;justify-content:center;align-items:center;display:inline-flex;width:16px;font-size:13px}" +
      ".nwEntryLabel{text-overflow:ellipsis;overflow:hidden}" +
      "[data-dsh-frame][data-sidebar-collapsed] .nwEntry{justify-content:center;width:100%;padding:0}" +
      "[data-dsh-frame][data-sidebar-collapsed] .nwEntryLabel{display:none}" +
      ".nwPanel{max-width:560px;margin:0 auto;padding:28px 24px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);display:flex;flex-direction:column;gap:10px}" +
      ".nwPanelHeader{display:flex;align-items:center;gap:10px}" +
      ".nwPanelTitle{font-size:16px;font-weight:700;flex:1;min-width:0}" +
      ".nwClose{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);width:30px;height:30px;line-height:1}" +
      ".nwDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.6;margin:0}" +
      ".nwBanner{display:flex;align-items:center;gap:10px;border-radius:12px;padding:14px 16px;font-size:15px;font-weight:700;border:1px solid}" +
      ".nwBannerOn{background:rgba(34,197,94,.12);border-color:#22c55e;color:#15803d}" +
      ".nwBannerOff{background:rgba(239,68,68,.10);border-color:#ef4444;color:#b91c1c}" +
      ".nwBannerIcon{flex:none;font-size:18px;line-height:1}" +
      ".nwBannerSub{font-size:12px;font-weight:500;opacity:.9;margin-left:6px}" +
      ".nwRow{display:flex;align-items:center;gap:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:12px;padding:12px 14px;transition:border-color .18s,background .18s}" +
      ".nwRowOn{border-color:#22c55e;background:rgba(34,197,94,.07)}" +
      ".nwRowOff{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}" +
      ".nwRowText{flex:1;min-width:0}" +
      ".nwRowLabel{font-size:13px;font-weight:600;line-height:1.5}" +
      ".nwRowHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin-top:2px}" +
      ".nwSwitchWrap{flex:none;display:flex;align-items:center;gap:8px}" +
      ".nwSwitch{appearance:none;flex:none;width:56px;height:30px;border-radius:999px;border:2px solid #9ca3af;background:#9ca3af;cursor:pointer;position:relative;padding:0;transition:background .18s,border-color .18s,box-shadow .18s}" +
      ".nwSwitch:hover{box-shadow:0 0 0 4px rgba(156,163,175,.20)}" +
      ".nwSwitch:focus-visible{outline:2px solid #22c55e;outline-offset:2px}" +
      ".nwSwitchOn{background:#22c55e;border-color:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.18)}" +
      ".nwSwitchOn:hover{box-shadow:0 0 0 4px rgba(34,197,94,.28)}" +
      ".nwSwitchKnob{position:absolute;top:2px;left:2px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .18s}" +
      ".nwSwitchOn .nwSwitchKnob{left:28px}" +
      ".nwSwitch:disabled{opacity:.5;cursor:default;box-shadow:none}" +
      ".nwBadge{flex:none;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;white-space:nowrap;letter-spacing:.5px}" +
      ".nwBadgeOn{background:#22c55e;color:#fff}" +
      ".nwBadgeOff{background:#e5e7eb;color:#6b7280}" +
      ".nwStatus{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;word-break:break-all}" +
      ".nwFoot{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px;margin-top:4px}";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-novel-writer\"]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-novel-writer";
      tag.dataset.pluginCss = "dsh-novel-writer";
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ---- 文案（zh / en）----
    var zh = {
      "entry.label": "句式分析",
      "entry.tooltip": "句式模式分析开关（dsh-novel-writer）",
      "panel.title": "句式模式分析",
      "panel.desc": "分析作品的句式分布（陈述/对话/心理/疑问/反问/感叹/祈使/省略留白）、排列规律、句长节奏、情感曲线与风格指纹，帮助 AI 快速掌握作者的写作习惯与主观情感。",
      "panel.enabled": "启用句式分析",
      "panel.enabledHint": "开启后，AI 可以调用 novel_sentence_analysis 提取句式模式报告。",
      "panel.autoAnalyze": "分析作品时自动使用",
      "panel.autoAnalyzeHint": "开启后，AI 在分析作品时会主动附带句式分析；关闭则仅在用户明确要求时使用。",
      "panel.loading": "正在读取开关状态…",
      "panel.saved": "状态已保存到宿主端",
      "panel.localOnly": "宿主端不可达，开关仅保存在本浏览器（重启后可能恢复默认）。",
      "panel.saveFailed": "保存到宿主端失败，已降级保存在本浏览器。",
      "panel.foot": "提示：也可在对话中让 AI 用 novel_sentence_config 查看/修改这两个开关。重启 Web 应用后，AI 的工具列表中会出现 novel_sentence_analysis / novel_sentence_config。",
      "panel.close": "关闭",
      "banner.on": "句式分析已启用",
      "banner.onSub": "AI 可以调用 novel_sentence_analysis",
      "banner.off": "句式分析已关闭",
      "banner.offSub": "AI 不会执行句式分析",
      "badge.on": "已开启",
      "badge.off": "已关闭",
      "card.title": "小说写作助手 novel-writer",
      "card.desc": "句式模式分析：分析原文陈述/环境/心理/对话/疑问/反问/感叹等句子的排列节奏来辅助模仿文风。⚠️ 若机械套用导致文风僵硬，模型会优先回归自然表达。",
      "card.status": "句式模式分析：已启用 · 自动分析：开",
      "card.statusOff": "句式模式分析：已关闭",
      "card.statusAutoOff": "句式模式分析：已启用 · 自动分析：关",
      "card.hint": "开关统一在侧边栏「句式分析」面板（也可让 AI 用 novel_sentence_config 调整），本卡片仅显示状态。",
      "card.open": "打开开关面板"
    };
    var en = {
      "entry.label": "Sentence Analysis",
      "entry.tooltip": "Sentence-pattern analysis switch (dsh-novel-writer)",
      "panel.title": "Sentence Pattern Analysis",
      "panel.desc": "Analyzes sentence-type distribution (statement/dialogue/inner-thought/question/rhetoric/exclamation/imperative/ellipsis), arrangement patterns, rhythm, emotion curve and a style fingerprint — so the AI can quickly learn an author's habits and subjective tone.",
      "panel.enabled": "Enable sentence analysis",
      "panel.enabledHint": "When on, the AI may call novel_sentence_analysis for pattern reports.",
      "panel.autoAnalyze": "Auto-use when analyzing works",
      "panel.autoAnalyzeHint": "When on, the AI proactively includes sentence analysis; otherwise only on explicit request.",
      "panel.loading": "Loading switch state…",
      "panel.saved": "Saved to the host state file",
      "panel.localOnly": "Host unreachable; kept in this browser only (defaults may return after restart).",
      "panel.saveFailed": "Host save failed; fell back to this browser.",
      "panel.foot": "Tip: ask the AI to run novel_sentence_config to view/change these switches. After restarting the Web app, novel_sentence_analysis / novel_sentence_config appear in the tool list.",
      "panel.close": "Close",
      "banner.on": "Sentence analysis is ON",
      "banner.onSub": "novel_sentence_analysis is available",
      "banner.off": "Sentence analysis is OFF",
      "banner.offSub": "the AI will not run it",
      "badge.on": "ON",
      "badge.off": "OFF",
      "card.title": "Novel Writer (dsh-novel-writer)",
      "card.desc": "Sentence-pattern analysis: reads the rhythm of statements/environment/inner-thought/dialogue/questions etc. to help mimic the author's style. ⚠️ If mechanical imitation stiffens the prose, natural expression wins.",
      "card.status": "Sentence analysis: ON · auto-analyze: ON",
      "card.statusOff": "Sentence analysis: OFF",
      "card.statusAutoOff": "Sentence analysis: ON · auto-analyze: OFF",
      "card.hint": "Switches live in the sidebar 'Sentence Analysis' panel (or ask the AI to run novel_sentence_config); this card only shows status.",
      "card.open": "Open the switch panel"
    };
    function dictionary() {
      return (typeof document !== "undefined" && (document.documentElement.lang || "zh").toLowerCase().startsWith("en")) ? en : zh;
    }
    function t(key) {
      var text = dictionary()[key];
      return text === void 0 ? key : text;
    }

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
      var state = {
        enabled: true,
        autoAnalyze: true,
        file: "",
        source: "",
        loading: true,
        hostOk: true,
        saveFailed: false,
        panelOpen: false
      };
      return {
        getSnapshot: function () { return state; },
        set: function (patch) {
          Object.assign(state, patch);
          listeners.forEach(function (fn) { fn(state); });
        },
        subscribe: function (fn) {
          listeners.add(fn);
          return function () { listeners.delete(fn); };
        }
      };
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
      var state = props.controller.getSnapshot();
      var on = state.enabled;
      return react.createElement(
        "div",
        { className: "nwPanel" },
        react.createElement(
          "div",
          { className: "nwPanelHeader" },
          react.createElement("div", { className: "nwPanelTitle" }, t("panel.title")),
          react.createElement("button", { type: "button", className: "nwClose", "aria-label": t("panel.close"), onClick: props.onClose }, "×")
        ),
        react.createElement(
          "div",
          { className: "nwBanner " + (on ? "nwBannerOn" : "nwBannerOff") },
          react.createElement("span", { className: "nwBannerIcon" }, on ? "✔" : "✘"),
          react.createElement("span", null, on ? t("banner.on") : t("banner.off"), react.createElement("span", { className: "nwBannerSub" }, on ? t("banner.onSub") : t("banner.offSub")))
        ),
        react.createElement("p", { className: "nwDesc" }, t("panel.desc")),
        react.createElement(
          "div",
          { className: "nwRow " + (state.enabled ? "nwRowOn" : "nwRowOff") },
          react.createElement(
            "div",
            { className: "nwRowText" },
            react.createElement("div", { className: "nwRowLabel" }, t("panel.enabled")),
            react.createElement("div", { className: "nwRowHint" }, t("panel.enabledHint"))
          ),
          react.createElement(
            "div",
            { className: "nwSwitchWrap" },
            react.createElement(Switch, {
              checked: state.enabled,
              disabled: state.loading,
              onChange: function (value) { props.toggle({ enabled: value }); }
            }),
            react.createElement("span", { className: "nwBadge " + (state.enabled ? "nwBadgeOn" : "nwBadgeOff") }, state.enabled ? t("badge.on") : t("badge.off"))
          )
        ),
        react.createElement(
          "div",
          { className: "nwRow " + (state.autoAnalyze ? "nwRowOn" : "nwRowOff") },
          react.createElement(
            "div",
            { className: "nwRowText" },
            react.createElement("div", { className: "nwRowLabel" }, t("panel.autoAnalyze")),
            react.createElement("div", { className: "nwRowHint" }, t("panel.autoAnalyzeHint"))
          ),
          react.createElement(
            "div",
            { className: "nwSwitchWrap" },
            react.createElement(Switch, {
              checked: state.autoAnalyze,
              disabled: state.loading,
              onChange: function (value) { props.toggle({ autoAnalyze: value }); }
            }),
            react.createElement("span", { className: "nwBadge " + (state.autoAnalyze ? "nwBadgeOn" : "nwBadgeOff") }, state.autoAnalyze ? t("badge.on") : t("badge.off"))
          )
        ),
        react.createElement(
          "div",
          { className: "nwStatus" },
          state.loading ? t("panel.loading") : (state.hostOk ? t("panel.saved") + (state.file !== "" ? " · " + state.file : "") : (state.saveFailed ? t("panel.saveFailed") : t("panel.localOnly")))
        ),
        react.createElement("div", { className: "nwFoot" }, t("panel.foot"))
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
        try {
          var remote = await fetchState();
          controller.set({
            enabled: !!remote.enabled,
            autoAnalyze: !!remote.autoAnalyze,
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
        controller.set(Object.assign({}, patch, { saveFailed: false }));
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
