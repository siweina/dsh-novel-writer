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
      ".nwSectionTitle{font-size:13px;font-weight:700;margin-top:6px}" +
      ".nwToolsHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:2px 0 4px}" +
      ".nwToolRow{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:8px 12px}" +
      ".nwToolRowOn{border-color:rgba(34,197,94,.55);background:rgba(34,197,94,.05)}" +
      ".nwToolLabel{flex:1;min-width:0;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-primary)}" +
      ".nwSwitchSmall{appearance:none;flex:none;width:40px;height:22px;border-radius:999px;border:2px solid #9ca3af;background:#9ca3af;cursor:pointer;position:relative;padding:0;transition:background .16s,border-color .16s}" +
      ".nwSwitchSmallOn{background:#22c55e;border-color:#22c55e}" +
      ".nwSwitchSmallKnob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .16s}" +
      ".nwSwitchSmallOn .nwSwitchSmallKnob{left:20px}" +
      ".nwToolDesc{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary);margin-top:2px}" +
      ".nwPlotBox{margin-top:6px;padding:6px 8px;background:rgba(127,127,127,.08);border-radius:8px}" +
      ".nwPlotPath{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);word-break:break-all}" +
      ".nwBtnGroup{display:flex;gap:6px;margin-top:6px}" +
      ".nwBtn{font-size:11px;line-height:1;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}" +
      ".nwBtn:hover{background:var(--dsw-alias-bg-layer-2)}" +
      ".nwBtn:disabled{opacity:.45;cursor:not-allowed}" +
      ".nwPlotMsg{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin-top:4px;word-break:break-all}" +
      ".nwPlotErr{color:#ef4444}" +
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
      "entry.label": "写作助手功能",
      "entry.tooltip": "写作助手功能开关（dsh-novel-writer）：句式分析/风格自检/伏笔登记等",
      "panel.title": "写作助手功能",
      "panel.desc": "管理写作助手的功能开关：句式模式分析（九类句式/情感曲线/风格指纹）、风格自检、伏笔登记、稿件导入等。关闭的工具，AI 调用时会收到提示。",
      "panel.enabled": "启用写作助手功能",
      "panel.enabledHint": "总开关：控制句式模式分析与风格自检（novel_sentence_analysis / novel_style_check）。",
      "panel.autoAnalyze": "分析作品时自动使用",
      "panel.autoAnalyzeHint": "开启后，AI 在分析作品时会主动附带句式分析；关闭则仅在用户明确要求时使用。",
      "panel.toolsTitle": "工具开关",
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
      "tool.novel_chapters": "章节清单 novel_chapters",
      "tool.novel_read": "阅读章节 novel_read",
      "tool.novel_keywords": "关键词分析 novel_keywords",
      "tool.novel_new_chapter": "新建章节 novel_new_chapter",
      "tool.novel_import": "稿件导入 novel_import",
      "tool.novel_sentence_analysis": "句式模式分析 novel_sentence_analysis",
      "tool.novel_sentence_config": "开关配置 novel_sentence_config",
      "tool.novel_style_check": "风格自检 novel_style_check",
      "tool.novel_plot": "伏笔登记 novel_plot",
      "tool.novel_books.desc": "列出书库中的全部作品（章节数/总字数）。",
      "tool.novel_chapters.desc": "查看某本书的章节清单与字数。",
      "tool.novel_read.desc": "阅读章节正文（支持分页与编码自动识别）。",
      "tool.novel_keywords.desc": "提取高频关键词（词组/三字组/疑似人名）。",
      "tool.novel_new_chapter.desc": "创建新章节文件（自动取下一章号）。",
      "tool.novel_import.desc": "批量导入原稿件并自动分类到书库。",
      "tool.novel_sentence_analysis.desc": "句式分布/排列规律/情感曲线/风格指纹。",
      "tool.novel_sentence_config.desc": "查看/修改全部开关（AI 通道）。",
      "tool.novel_style_check.desc": "本章文风与全书其余章节的相似度检查。",
      "tool.novel_plot.desc": "登记/回收剧情伏笔，续写前查看未回收项。",
      "plot.pathLabel": "存储位置",
      "plot.pathUnknown": "位于书库根的 .novel-writer 文件夹（每本书一个 JSON）。先让 AI 调用一次 novel_plot，此处会显示真实路径。",
      "plot.open": "打开文件夹",
      "plot.copy": "复制路径",
      "plot.copied": "已复制",
      "plot.revealOk": "已打开文件夹",
      "plot.revealErr": "打开失败",
      "card.title": "小说写作助手 novel-writer",
      "card.desc": "句式模式分析：分析原文陈述/环境/心理/对话/疑问/反问/感叹等句子的排列节奏来辅助模仿文风。⚠️ 若机械套用导致文风僵硬，模型会优先回归自然表达。",
      "card.status": "写作助手功能：已启用 · 自动分析：开",
      "card.statusOff": "写作助手功能：已关闭",
      "card.statusAutoOff": "写作助手功能：已启用 · 自动分析：关",
      "card.hint": "全部开关统一在侧边栏「写作助手功能」面板（也可让 AI 用 novel_sentence_config 调整），本卡片仅显示状态。",
      "card.open": "打开开关面板"
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
      "panel.toolsTitle": "Tool switches",
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
      "tool.novel_chapters": "Chapters novel_chapters",
      "tool.novel_read": "Read novel_read",
      "tool.novel_keywords": "Keywords novel_keywords",
      "tool.novel_new_chapter": "New chapter novel_new_chapter",
      "tool.novel_import": "Import novel_import",
      "tool.novel_sentence_analysis": "Pattern analysis novel_sentence_analysis",
      "tool.novel_sentence_config": "Config novel_sentence_config",
      "tool.novel_style_check": "Style check novel_style_check",
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
      "plot.pathLabel": "Storage",
      "plot.pathUnknown": "Located in .novel-writer under the library root (one JSON per book). Ask the AI to run novel_plot once to show the real path.",
      "plot.open": "Open folder",
      "plot.copy": "Copy path",
      "plot.copied": "Copied",
      "plot.revealOk": "Opened",
      "plot.revealErr": "Open failed",
      "card.title": "Novel Writer (dsh-novel-writer)",
      "card.desc": "Sentence-pattern analysis: reads the rhythm of statements/environment/inner-thought/dialogue/questions etc. to help mimic the author's style. ⚠️ If mechanical imitation stiffens the prose, natural expression wins.",
      "card.status": "Writing assistant: ON · auto-analyze: ON",
      "card.statusOff": "Writing assistant: OFF",
      "card.statusAutoOff": "Writing assistant: ON · auto-analyze: OFF",
      "card.hint": "All switches live in the sidebar 'Writing Assistant' panel (or ask the AI to run novel_sentence_config); this card only shows status.",
      "card.open": "Open the switch panel"
    };
    function dictionary() {
      return (typeof document !== "undefined" && (document.documentElement.lang || "zh").toLowerCase().startsWith("en")) ? en : zh;
    }
    function t(key) {
      var text = dictionary()[key];
      return text === void 0 ? key : text;
    }

    // ---- 工具清单（与宿主端 ALL_TOOLS 一致）----
    var ALL_TOOLS = ["novel_books", "novel_chapters", "novel_read", "novel_keywords", "novel_new_chapter", "novel_import", "novel_sentence_analysis", "novel_sentence_config", "novel_style_check", "novel_plot"];

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
        tools: {},
        file: "",
        source: "",
        loading: true,
        hostOk: true,
        saveFailed: false,
        panelOpen: false,
        plotsDir: "",
        revealMsg: "",
        revealErr: false,
        revealing: false
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
        },
        openPlotsDir: function () {
          controller.set({ revealMsg: "", revealErr: false, revealing: true });
          fetch("/api/dsh-novel-writer/reveal", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ target: "plots-dir" })
          }).then(function (r) { return r.json(); }).then(function (data) {
            if (data.ok === true) {
              controller.set({ plotsDir: data.path || controller.getSnapshot().plotsDir, revealMsg: t("plot.revealOk") + "：" + (data.path || ""), revealErr: false });
            } else {
              controller.set({ revealMsg: data.error || t("plot.revealErr"), revealErr: true });
            }
          }).catch(function () {
            controller.set({ revealMsg: t("plot.revealErr") + "：宿主端不可达", revealErr: true });
          }).finally(function () {
            controller.set({ revealing: false });
          });
        },
        copyPlotsPath: function () {
          var dir = controller.getSnapshot().plotsDir;
          if (dir === "") return;
          var done = function () {
            controller.set({ revealMsg: t("plot.copied") + "：" + dir, revealErr: false });
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(dir).then(done, done);
          } else {
            done();
          }
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
        react.createElement("div", { className: "nwSectionTitle" }, t("panel.toolsTitle")),
        react.createElement("div", { className: "nwToolsHint" }, t("panel.toolsHint")),
        ALL_TOOLS.map(function (name) {
          var checked = (state.tools || {})[name] !== false;
          var desc = t("tool." + name + ".desc");
          var plotExtra = null;
          if (name === "novel_plot") {
            var pathText = state.plotsDir !== "" ? state.plotsDir : t("plot.pathUnknown");
            plotExtra = react.createElement(
              "div",
              { className: "nwPlotBox" },
              react.createElement("div", { className: "nwPlotPath", title: state.plotsDir !== "" ? state.plotsDir : "" }, t("plot.pathLabel") + "：" + pathText),
              react.createElement(
                "div",
                { className: "nwBtnGroup" },
                react.createElement("button", {
                  type: "button", className: "nwBtn", disabled: state.plotsDir === "" || state.revealing,
                  onClick: function () { props.controller.openPlotsDir(); }
                }, t("plot.open")),
                react.createElement("button", {
                  type: "button", className: "nwBtn", disabled: state.plotsDir === "",
                  onClick: function () { props.controller.copyPlotsPath(); }
                }, t("plot.copy"))
              ),
              state.revealMsg !== "" ? react.createElement("div", { className: "nwPlotMsg " + (state.revealErr ? "nwPlotErr" : "") }, state.revealMsg) : null
            );
          }
          return react.createElement(
            "div",
            { className: "nwToolRow" + (checked ? " nwToolRowOn" : ""), key: name },
            react.createElement(
              "div",
              { className: "nwToolLabel", title: desc },
              react.createElement("div", null, t("tool." + name)),
              react.createElement("div", { className: "nwToolDesc" }, desc),
              plotExtra
            ),
            react.createElement(
              "button",
              {
                type: "button",
                role: "switch",
                "aria-checked": checked ? "true" : "false",
                className: "nwSwitchSmall" + (checked ? " nwSwitchSmallOn" : ""),
                disabled: state.loading,
                onClick: function () { props.toggle({ tools: (function (patch) { patch[name] = !checked; return patch; })({}) }); }
              },
              react.createElement("span", { className: "nwSwitchSmallKnob" })
            )
          );
        }),
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
            tools: remote.tools || {},
            plotsDir: remote.plotsDir || "",
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
