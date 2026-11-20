function renderFeaturesView(vc) {
  var el = vc.el, state = vc.state, props = vc.props, f = vc.f;
  // v7.3.0：提问节奏的输入框草稿值（未编辑时显示当前生效值）
  // v7.3.1 修（#80）/ v7.3.2 修（N21）：正常情况下宿主 GET /state **一定**下发 chatThreshold（无值时给 400），
  // 所以"未确认（null）即显示空"在健康宿主上恒不可达；这段防御只覆盖**老宿主不下发 / 本地降级**两条路径，
  // 不能删——删了它，老宿主下界面会拿默认 400 冒充当前值（用户照显示的 400 保存，会把 state.json 里
  // 真实的 150 覆盖掉）。
  var chatThresholdNow = (state.chatThreshold !== null && state.chatThreshold !== void 0 && Number(state.chatThreshold) > 0)
    ? Math.round(Number(state.chatThreshold)) : null;
  var chatThresholdDraft = (state.chatThresholdDraft === void 0 || state.chatThresholdDraft === null)
    ? (chatThresholdNow === null ? "" : String(chatThresholdNow))
    : String(state.chatThresholdDraft);
  return el("div", { className: "nwFeaturesPage" },
    el("div", { className: "nwToolsHint" }, t("panel.featuresHint")),
    GroupCard(el, el, t, NW_UI, { children: DETAIL_FEATURES.map(function (name, idx) {
      var checked = f[name] !== false;
      return [
        idx > 0 ? RowDivider(el, el, t, NW_UI, { key: "fd-" + name }) : null,
        PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
          key: name, icon: NW_ICONS[name] ? name : "fallback", title: t("feature." + name),
          summary: t("feature." + name + ".desc"),
          className: name === "semanticEmbedding" ? "nwFeatureModelRow" : "",
          trailing: el("div", { className: "nwFeatureActions" },
            name === "semanticEmbedding" ? el("button", { type: "button", className: "nwBtn nwBtnGhost nwFeatureModelLink", onClick: function (ev) { ev.stopPropagation(); props.controller.openView("model"); } }, t("model.manage")) : null,
            el(Switch, { checked: checked, disabled: state.loading, label: t("feature." + name),
              onChange: function () { props.toggle({ features: (function (patch) { patch[name] = !checked; return patch; })({}) }); } })
          )
        })
      ];
    }) }),
    // v7.3.0：实时聊天写作的「提问节奏」——多少字停下来问人，由**用户**填，程序按它判定。
    // 放在功能页的理由：它是这个模式的节奏旋钮，和上面的开关是一组。
    GroupCard(el, el, t, NW_UI, { title: "chatThreshold.title", children: [
      el("div", { className: "nwBaseTolRow" },
        el("div", { className: "nwBaseTolName" },
          el("div", null, t("chatThreshold.label")),
          el("div", { className: "nwToolsHint" }, t("chatThreshold.hint"))
        ),
        el("div", { className: "nwBaseTolControl" },
          el("input", {
            type: "number", className: "nwTolInput", min: 100, max: 5000, step: 50,
            "aria-label": t("chatThreshold.label"), disabled: state.loading === true,
            value: chatThresholdDraft,
            onChange: function (ev) { props.controller.set({ chatThresholdDraft: String(ev.target.value) }, { silent: true }); }
          }),
          el("button", {
            type: "button", className: "nwBtn nwBtnGhost", disabled: state.loading === true,
            onClick: function () {
              // v7.3.1 修（#80）：未编辑时取界面**当前显示**的值（未经确认则为空 → 如实提示，不编一个 400）
              var draftRaw = props.controller.getSnapshot().chatThresholdDraft;
              var showRaw = (draftRaw === void 0 || draftRaw === null)
                ? (chatThresholdNow === null ? "" : String(chatThresholdNow)) : String(draftRaw);
              var n = Number(showRaw.trim());
              if (!Number.isFinite(n) || n <= 0) { props.controller.set({ revealMsg: t("chatThreshold.invalid"), revealErr: true }); return; }
              var clamped = Math.min(5000, Math.max(100, Math.round(n)));
              // v7.3.1 修（#80）：先只写草稿，不预写"已生效值"——等 POST 回包确认（toggle 内回读），
              // 失败时由 toggle 的失败分支把显示值回滚到宿主已确认值。
              props.controller.set({ chatThresholdDraft: String(clamped) }, { silent: true });
              props.toggle({ chatThreshold: clamped });
            }
          }, t("chatThreshold.save"))
        )
      )
    ] })
  );
}

function renderToolsView(vc) {
  var el = vc.el, state = vc.state, props = vc.props, dirs = vc.dirs, tools = vc.tools;
  var toolGroupOpen = state.toolGroupOpen || {};
  var toolQuery = String(state.toolQuery || "");
  var toolQueryLower = toolQuery.trim().toLowerCase();
  var hasToolQuery = toolQueryLower !== "";
  var anyToolGroupOpen = TOOL_GROUPS.some(function (grp) { return toolGroupOpen[grp.key] === true; });
  var toolRows = TOOL_GROUPS.map(function (grp) {
    var visibleTools = hasToolQuery ? grp.tools.filter(function (name) {
      return String(t("tool." + name)).toLowerCase().indexOf(toolQueryLower) !== -1
        || String(t("tool." + name + ".desc")).toLowerCase().indexOf(toolQueryLower) !== -1
        || name.toLowerCase().indexOf(toolQueryLower) !== -1;
    }) : grp.tools;
    if (visibleTools.length === 0) return null;
    var isOpen = hasToolQuery ? true : (toolGroupOpen[grp.key] === true);
    var groupOnCount = grp.tools.filter(function (n) { return tools[n] !== false; }).length;
    var groupState = groupOnCount === grp.tools.length ? "on" : groupOnCount === 0 ? "off" : "partial";
    return el("div", { key: grp.key, className: "nwToolCategory" },
      GroupCard(el, el, t, NW_UI, { children: [
        el("div", { key: "head", className: "nwToolGroupHead" + (isOpen ? " nwToolGroupHeadOpen" : "") },
          el("button", { type: "button", className: "nwToolGroupHeadBtn", "aria-expanded": isOpen, onClick: function () {
            var patch = Object.assign({}, toolGroupOpen); patch[grp.key] = !isOpen;
            props.controller.setToolGroupOpen(patch);
          } },
            el("span", { className: "nwToolGroupName" }, t("toolGroup." + grp.key)),
            CountBadge(el, el, t, NW_UI, { label: groupOnCount + "/" + grp.tools.length }),
            nwGlyph(el, "nwToolCategoryArrow" + (isOpen ? " nwToolCategoryArrowOpen" : ""), "navArrow", "›")
          ),
          el("div", { className: "nwToolAll", title: groupState === "on" ? t("group.allOn") : groupState === "partial" ? t("group.partial") : t("group.allOff") },
            el("span", { "aria-hidden": true }, t("tool.all")),
            el(Switch, { checked: groupState === "on", disabled: state.loading, label: t("toolGroup." + grp.key) + " · " + t("tool.all"), onChange: function () {
              var patch = {};
              var target = groupState === "on" ? false : true;
              grp.tools.forEach(function (n) { patch[n] = target; });
              props.toggle({ tools: patch });
            } })
          )
        ),
        el("div", { key: "desc", className: "nwToolCategoryHint" }, t("toolGroup." + grp.key + ".desc")),
        isOpen ? el("div", { key: "body", className: "nwToolCategoryBody" }, visibleTools.map(function (name) {
          var checked = tools[name] !== false;
          return [
            RowDivider(el, el, t, NW_UI, { key: "td-" + name }),
            PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
              key: name, icon: toolIcons[name], title: t("tool." + name), summary: t("tool." + name + ".desc"),
              switchOn: checked, switchDisabled: state.loading, switchLabel: t("tool." + name),
              switchOnChange: function () { props.toggle({ tools: (function (patch) { patch[name] = !checked; return patch; })({}) }); }
            })
          ];
        })) : null
      ] })
    );
  }).filter(Boolean);
  var toolStorage = [
    { label: t("dir.data"), path: dirs.dataDir || state.dataDir || "", revealKey: "data-dir" },
    { label: t("dir.analysis"), path: dirs.analysisDir || "", revealKey: "analysis-dir" },
    { label: t("dir.audits"), path: dirs.auditsDir || "", revealKey: "audits-dir" },
    { label: t("dir.settings"), path: dirs.settingsDir || "", revealKey: "settings-dir" },
    { label: t("tool.storagePlots"), path: dirs.plotsDir || state.plotsDir || "", revealKey: "plots-dir" },
    { label: t("dir.summaries"), path: dirs.summariesDir || "", revealKey: "summaries-dir" },
    { label: t("lex.pathLabel"), path: dirs.lexiconDir || "", revealKey: "lexicon-dir" }
  ].filter(function (item, idx, items) {
    return !item.path || items.slice(0, idx).every(function (prev) { return prev.path !== item.path; });
  });
  return el("div", { className: "nwToolsPage" },
    el("div", { className: "nwToolsHint" }, t("panel.toolsHint")),
    el("div", { className: "nwToolControls" },
      GroupCard(el, el, t, NW_UI, { children: [
        el("div", { key: "presets", className: "nwPresetBar" },
          el("div", { className: "nwPresetLabel" }, t("tools.presets")),
          el("div", { className: "nwPresetPills" }, TOOL_PRESETS.map(function (pr) {
            var prSet = {};
            pr.tools.forEach(function (tn) { prSet[tn] = true; });
            var isOn = ALL_PANEL_TOOLS.every(function (tn) { return (tools[tn] !== false) === (prSet[tn] === true); });
            return el("button", {
              key: pr.key,
              type: "button",
              className: "nwPresetBtn" + (isOn ? " nwPresetBtnOn" : ""),
              "aria-pressed": isOn,
              disabled: state.loading,
              onClick: function () {
                var patch = {};
                ALL_PANEL_TOOLS.forEach(function (tn) { patch[tn] = prSet[tn] === true; });
                props.toggle({ tools: patch });
              }
            }, t("tools.preset." + pr.key));
          }))
        ),
        el("div", { key: "search", className: "nwToolSearchBar" },
          el("input", {
            type: "search",
            className: "nwTextInput",
            value: toolQuery,
            placeholder: t("tools.searchPlaceholder"),
            "aria-label": t("tools.searchPlaceholder"),
            onInput: function (ev) { props.controller.setToolQuery(ev.target.value); }
          }),
          toolQuery !== ""
            ? el("button", {
                type: "button",
                className: "nwBtn nwBtnGhost nwBtnSm",
                onClick: function () { props.controller.setToolQuery(""); }
              }, t("tools.searchClear"))
            : null,
          el("button", {
            type: "button",
            className: "nwBtn nwBtnGhost nwBtnSm",
            onClick: function () { props.controller.setAllToolGroupsOpen(!anyToolGroupOpen); }
          }, anyToolGroupOpen ? t("tools.collapseAll") : t("tools.expandAll"))
        )
      ] })
    ),
    toolRows.length > 0
      ? toolRows
      : el("div", { className: "nwEmpty" },
          el("div", { className: "nwEmptyTitle" }, t("tools.searchEmpty")),
          el("div", { className: "nwEmptyHint" }, t("tools.searchEmptyHint"))
        ),
    StorageDisclosure(el, el, t, NW_UI, { controller: props.controller, revealing: state.revealing, items: toolStorage })
  );
}

function renderModelView(vc) {
  var el = vc.el, state = vc.state, props = vc.props, dirs = vc.dirs, f = vc.f, switchRow = vc.switchRow;
  return el("div", { className: "nwModelPage" },
    GroupCard(el, el, t, NW_UI, { children: PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
      key: "engine", icon: "navModel", title: engineStatusText(state.embeddingStatus, t), summary: t("model.localHint")
    }) }),
    SectionTitle(el, el, t, NW_UI, { label: "model.subfeatures" }),
    GroupCard(el, el, t, NW_UI, { children: [
      el("div", { key: "hint", className: "nwModelSubHint" }, t("model.hint")),
      switchRow("semanticSearch", f.semanticSearch !== false, function (n, v) { props.toggle({ features: (function (patch) { patch[n] = v; return patch; })({}) }); }),
      RowDivider(el, el, t, NW_UI, { key: "rd-s1" }),
      switchRow("semanticStyle", f.semanticStyle !== false, function (n, v) { props.toggle({ features: (function (patch) { patch[n] = v; return patch; })({}) }); }),
      RowDivider(el, el, t, NW_UI, { key: "rd-s2" }),
      switchRow("semanticImplicit", f.semanticImplicit !== false, function (n, v) { props.toggle({ features: (function (patch) { patch[n] = v; return patch; })({}) }); })
    ] }),
    StorageDisclosure(el, el, t, NW_UI, { controller: props.controller, revealing: state.revealing, items: [
      { label: t("dir.embedding"), path: dirs.embeddingDir || "", revealKey: "embedding-dir" }
    ] })
  );
}
