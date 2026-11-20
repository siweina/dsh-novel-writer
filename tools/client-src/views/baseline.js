function renderBaselineView(vc) {
  var el = vc.el, state = vc.state, props = vc.props, dirs = vc.dirs;
  // 未选书时优先引导选择；已有错误仍保留在 state，选书后按原逻辑加载。
  if (!state.baselineBook && state.revealErr) {
    if (typeof vc.clearMsg === "function") vc.clearMsg();
    else if ("msg" in vc) vc.msg = null;
  }
  var DEFAULT_TOL = { low: "", high: "" };
  // v7.3.2 修（N24⑥）：这张表只存**内部键**——显示名统一由 i18n 的 t("base.metric." + key) 提供。
  // 旧实现把中/英显示名抄成第 2/4 列（v7.3.1 修 #79 时补的），与 i18n 的 base.metric.* 是两份数据：
  // 当前一致，但改词条/加维度时必然漂移（第二次出现"两处都要改、漏一处就出事"的老毛病）。
  // 保留第 1 列内部键的数组形状，是为了不动调用方（草稿初始化 / 单侧校验 / 行渲染都按 NW_METRICS 遍历）。
  var NW_METRICS = ["complexity", "modifierDensity", "abstractDensity", "actionDensity", "hedgeDensity", "gapIndex"];
  // v3.0.0：输入框留空 = 使用推荐容差（原著章节波动 1.5σ）；填了才保存自定义
  var tolState = state.styleTolerance && typeof state.styleTolerance === "object" ? state.styleTolerance : null;
  var draft = state.baselineDraft;
  if (!draft) {
    draft = {};
    for (var mi = 0; mi < NW_METRICS.length; mi += 1) {
      var mk = NW_METRICS[mi];
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
      else n = Math.min(99, n); // v4.0.0 修正：与宿主 clampStyleTolerance（±99）一致，填 100 不再静默变 99
      next[mk][field] = n;
    }
    props.controller.set({ baselineDraft: next }, { silent: true }); // v4.0.0 修正：草稿输入属纯 UI 状态，不参与 rev 计数
  };
  var saveFlash = function () {
    props.controller.set({ baselineSaved: true }, { silent: true });
    // v4.0.0 修正：先清旧定时器（连续保存不再互相抢状态），并由 mountPanel 卸载时统一清理（此前从不清理）
    if (baselineFlashTimer) clearTimeout(baselineFlashTimer);
    baselineFlashTimer = setTimeout(function () {
      baselineFlashTimer = null;
      props.controller.set({ baselineSaved: false }, { silent: true });
    }, 1800);
  };
  var saveTol = function () {
    // v4.3.0：加载期禁止保存——此时 baselineDraft 还是 null（宿主容差尚未读回），
    // 空草稿会被判定成"全部留空"→ 把宿主已存容差清成 null（其它开关都有 disabled: state.loading，唯独基线页漏了）
    if (state.loading) return;
    // v3.5.0 M18：单侧填写提示成对（不再静默丢弃）
    var halfFilled = null;
    var tol = {};
    var any = false;
    for (var si = 0; si < NW_METRICS.length; si += 1) {
      var sk = NW_METRICS[si];
      var sd = draft[sk];
      if (sd && sd.low !== "" && sd.high !== "") { tol[sk] = { low: -sd.low, high: sd.high }; any = true; }
      else if (sd && (sd.low !== "" || sd.high !== "")) {
        // v4.0.0 修正：提示里用显示名——此前直接显示内部键名（complexity/modifierDensity），用户对不上输入框
        // v7.3.2 修（N24⑥）：显示名一律取 i18n（与行渲染、输入框 aria-label 同一来源），不再抄第二份
        if (!halfFilled) halfFilled = t("base.metric." + sk);
      }
    }
    if (halfFilled) {
      props.controller.set({ revealMsg: t("tol.halfFilled") + "「" + halfFilled + "」" + t("tol.halfFilledTail"), revealErr: true }, { silent: true });
      return;
    }
    props.toggle({ styleTolerance: any ? tol : null });
    // v4.0.0 修正：提示/草稿复位属纯 UI 写入，必须 silent——否则同一 tick 的自增 rev 会让 toggle 的 revSame2 守卫恒为 false，宿主钳制结果被丢弃
    props.controller.set({ baselineDraft: null, revealMsg: t("baseline.saved"), revealErr: false }, { silent: true });
    saveFlash();
  };
  var resetTol = function () {
    // v4.3.0：与 saveTol 同理，加载期不允许"清除自定义"（会把还没读到的容差误清）
    if (state.loading) return;
    // 恢复默认：清除自定义并保存（回到推荐模式），输入框清空
    props.toggle({ styleTolerance: null });
    // v4.0.0 修正：提示/草稿复位属纯 UI 写入，必须 silent——否则同一 tick 的自增 rev 会让 toggle 的 revSame2 守卫恒为 false，宿主钳制结果被丢弃
    props.controller.set({ baselineDraft: null, revealMsg: t("baseline.saved"), revealErr: false }, { silent: true });
    saveFlash();
  };
  // ---- 基线范围（按书 + 按全书/按部分）----
  // 与容差滑块相互独立：容差仍是全局的 styleTolerance，范围走 GET|POST /api/dsh-novel-writer/baseline。
  // 数据形状见契约：{ ok, book, mode(生效档位), chapters(存量的文件名校验后原样回报),
  //                  available[{file,number,title}], smallSample{chapters,tolPct}, missing?, updatedAt }
  // ⚠ 关键：`mode` 是**生效档位**（custom 仅当存储 mode=custom 且 chapters 非空），而 `chapters`
  //    回报的是**存量**——服务端在 mode != custom 时刻意不动 chapters（切按全书 = 这次不用，不是删掉）。
  //    于是「档位=按全书 + 存量非空」是合法状态，必须显式披露且给清空入口，否则用户永远看不到、也删不掉。
  var baseData = state.baseline;
  var baseMode = state.baselineMode === "custom" ? "custom" : "all";
  var baseAvail = baseData && Array.isArray(baseData.available) ? baseData.available : [];
  var baseSel = Array.isArray(state.baselineSel) ? state.baselineSel : [];
  var baseSelSet = {};
  for (var bsi = 0; bsi < baseSel.length; bsi += 1) baseSelSet[baseSel[bsi]] = true;
  var baseMissing = Array.isArray(state.baselineMissing) ? state.baselineMissing : [];
  // 存量（宿主已保存的标杆章）：与生效档位无关，按全书时也可能非空
  var baseStored = baseData && Array.isArray(baseData.chapters) ? baseData.chapters : [];
  var baseDirWarn = baseData && typeof baseData.warning === "string" && baseData.warning !== "" ? baseData.warning : "";
  var baseSmall = baseData && baseData.smallSample && typeof baseData.smallSample === "object" ? baseData.smallSample : null;
  // 小样本阈值：来源唯一（宿主下发）。0 = 宿主没给，不显示提示（不自己编阈值）
  var baseMinCh = baseSmall && typeof baseSmall.chapters === "number" && baseSmall.chapters > 0 ? Math.floor(baseSmall.chapters) : 0;
  var baseMinTol = baseSmall && typeof baseSmall.tolPct === "number" && baseSmall.tolPct > 0 ? Math.floor(baseSmall.tolPct) : 0;
  var baseBookList = props.controller.baselineBookOptions(baseData);
  // /state 里还没有当前书时也把它补进下拉，免得触发器显示成"尚未选择书"而实际已选中
  if (state.baselineBook && baseBookList.indexOf(state.baselineBook) === -1) baseBookList = [state.baselineBook].concat(baseBookList);
  // 章节上百时默认只渲染前 N 章（全选/反选仍作用于全部章节，不受渲染上限影响）
  var BASE_LIST_CAP = 200;
  var baseShown = state.baselineShowAll === true ? baseAvail : baseAvail.slice(0, BASE_LIST_CAP);
  var baseFill = function (key, map) {
    var text = String(t(key));
    for (var fk in map) text = text.split("{" + fk + "}").join(String(map[fk]));
    return text;
  };
  var baseChapterLabel = function (c) {
    var num = c && c.number !== void 0 && c.number !== null && c.number !== "" ? String(c.number) : "";
    var title = c && typeof c.title === "string" && c.title !== "" ? c.title : (c && typeof c.file === "string" ? c.file : "");
    return (num === "" ? "" : baseFill("base.chapterPrefix", { n: num })) + title;
  };
  var baseChapterRow = function (c) {
    var file = c && typeof c.file === "string" ? c.file : "";
    return el("label", { key: "bch-" + file, className: "nwBaseItem", title: file },
      el("input", { type: "checkbox", className: "nwBaseCheck", checked: baseSelSet[file] === true,
        disabled: state.baselineBusy || state.loading,
        onChange: function () { props.controller.baselineToggleChapter(file); } }),
      el("span", { className: "nwBaseItemText" }, baseChapterLabel(c))
    );
  };
  var baseSelText = t("base.selected") + " " + baseSel.length + t("base.selectedUnit");
  var baseCurSummary = baseMode === "all" ? t("base.modeAllSummary") : t("base.modeCustomSummary");
  var baseUpdated = baseData && typeof baseData.updatedAt === "string" && baseData.updatedAt !== ""
    ? "　" + t("base.updatedAt") + " " + baseData.updatedAt.slice(0, 16).replace("T", " ")
    : "";
  var baseSaveBtn = el("button", { key: "base-save", type: "button", className: "nwBtn nwBtnGhost",
    disabled: state.baselineBusy || state.loading || (state.baselineBook || "") === "",
    onClick: function () { props.controller.baselineSave(); } }, t("base.save"));
  // 显式清空入口：**唯一**能真正删掉存量的动作（切按全书保存不会清，服务端刻意保留）。
  // 只在存量非空时出现；二次确认在 controller 里走 safeConfirm（与词表页的破坏性操作同一套写法）。
  var baseClearBtn = baseStored.length > 0
    ? el("button", { key: "base-clear", type: "button", className: "nwBtn nwBtnGhost nwBtnSm nwBtnDangerText",
        disabled: state.baselineBusy || state.loading || (state.baselineBook || "") === "",
        onClick: function () { props.controller.baselineClearSaved(); } }, t("base.clearSaved"))
    : null;
  var baseClearRow = baseClearBtn
    ? el("div", { key: "base-clear-row", className: "nwBaseClear" },
        el("div", { className: "nwRowHint", style: { flex: "1", minWidth: "0", marginTop: "0" } },
          baseFill("base.storedCount", { n: baseStored.length }) + " · " + t("base.clearSavedHint")),
        baseClearBtn)
    : null;
  // 保存行：单实例。custom 时它排在挑选区**下方**，all 时直接跟在范围行后面（两种模式都点得到保存）
  var baseSaveRow = el("div", { key: "base-save-row", className: "nwField" },
    el("div", { className: "nwRowText" },
      el("div", { className: "nwRowHint" }, baseCurSummary + baseUpdated + (state.baselineBusy ? "　" + t("base.busy") : ""))),
    el("div", { className: "nwFieldCtl" }, baseSaveBtn)
  );
  // 档位=按全书但存量非空：必须披露（否则用户以为早清掉了，实际还在盘上占着）
  var baseIdleRow = baseMode !== "custom" && baseStored.length > 0
    ? el("div", { key: "base-idle-row", className: "nwField" },
        el("div", { className: "nwRowText" },
          el("div", { className: "nwRowLabel" }, t("base.clearSaved")),
          el("div", { className: "nwRowHint nwNoteWarn" }, baseFill("base.storedIdle", { n: baseStored.length }))),
        el("div", { className: "nwFieldCtl" }, baseClearBtn))
    : null;
  var basePicker = null;
  if (baseMode === "custom") {
    var baseListBody;
    if (state.baselineErr) {
      // 读取失败 ≠ 本书没有章节（与词表页同一条口径：不把失败伪装成空态）
      baseListBody = el("div", { key: "base-empty", className: "nwEmpty" },
        el("div", { className: "nwEmptyTitle" }, t("base.loadFail")),
        el("div", { className: "nwEmptyHint" }, t("base.loadFailHint")));
    } else if (baseAvail.length === 0) {
      baseListBody = el("div", { key: "base-empty", className: "nwEmpty" },
        el("div", { className: "nwEmptyTitle" }, state.baselineBusy ? t("base.busy") : t("base.emptyTitle")),
        el("div", { className: "nwEmptyHint" }, t("base.emptyHint")));
    } else {
      baseListBody = el("div", { key: "base-list", className: "nwBaseList" }, baseShown.map(baseChapterRow));
    }
    basePicker = el("div", { key: "base-picker", className: "nwBasePick" },
      el("div", { className: "nwRowLabel" }, t("base.pickTitle")),
      el("div", { className: "nwRowHint", style: { marginTop: "2px" } }, t("base.pickHint")),
      el("div", { key: "base-acts", className: "nwBtnGroup", style: { marginTop: "8px" } },
        el("button", { key: "all", type: "button", className: "nwBtn nwBtnGhost", disabled: state.baselineBusy || baseAvail.length === 0,
          onClick: function () { props.controller.baselineSelectAll(); } }, t("base.selectAll")),
        el("button", { key: "inv", type: "button", className: "nwBtn nwBtnGhost", disabled: state.baselineBusy || baseAvail.length === 0,
          onClick: function () { props.controller.baselineInvertSel(); } }, t("base.invertSel")),
        el("button", { key: "clr", type: "button", className: "nwBtn nwBtnGhost", disabled: state.baselineBusy || baseSel.length === 0,
          onClick: function () { props.controller.baselineClearSel(); } }, t("base.clearSel"))
      ),
      baseListBody,
      // 章节目录读不出来时宿主给 warning：别让空列表被读成"本书没有章节"
      baseDirWarn !== ""
        ? el("div", { key: "base-dirwarn", className: "nwNote nwNoteWarn", style: { marginTop: "6px" } }, t("base.dirWarn"), el("div", { className: "nwBaseRaw" }, baseDirWarn))
        : null,
      // 已选摘要 + 展开剩余（章节上百时列表只渲染前 N 章）
      el("div", { key: "base-sum", className: "nwRowHint", style: { marginTop: "8px" } },
        baseSelText + "　" + baseFill("base.allChapters", { n: baseAvail.length }) +
        (state.baselineShowAll !== true && baseAvail.length > baseShown.length
          ? "　" + baseFill("base.truncTip", { n: baseShown.length }) : "")),
      (state.baselineShowAll !== true && baseAvail.length > baseShown.length)
        ? el("button", { key: "base-more", type: "button", className: "nwBtn nwBtnGhost", style: { marginTop: "6px" },
            onClick: function () { props.controller.baselineExpandList(); } },
            baseFill("base.showRest", { n: baseAvail.length - baseShown.length }))
        : null,
      // 紧挨已选摘要：清空**已保存**的选择（本地「清空」只清勾选草稿，二者语义不同，故分开摆）
      baseClearRow,
      // 小样本提示：宿主明确要求显式呈现——否则用户选 1 章后看到一堆偏差会以为插件坏了
      baseMinCh > 0 && baseMinTol > 0
        ? el("div", { key: "base-small", className: baseSel.length < baseMinCh ? "nwNote nwNoteWarn" : "nwNote", style: { marginTop: "6px" } },
            (baseSel.length < baseMinCh ? "⚠ " : "") + (baseSel.length < baseMinCh
              ? baseFill("base.smallSampleNow", { n: baseSel.length, min: baseMinCh, p: baseMinTol })
              : baseFill("base.smallSample", { n: baseMinCh, p: baseMinTol })))
        : null,
      // 失效选中项（章节被改名/删除）：只提示，保存时按当前 available 过滤掉
      baseMissing.length > 0
        ? el("div", { key: "base-missing", className: "nwNote nwNoteWarn", style: { marginTop: "6px" } }, baseFill("base.missing", { n: baseMissing.length }))
        : null
    );
  }
  return el("div", null,

    el("div", { className: "nwToolsHint" }, t("baseline.desc")),
    // 范围与容差保留独立保存动作，范围保存为次要按钮。
    GroupCard(el, el, t, NW_UI, { children: [
      PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
        key: "base-book",
        title: t("base.bookLabel"),
        // 宿主里**已保存**的范围（与上面待保存的分段选择区分开：看着改了其实没保存，这行说清）
        summary: !state.baselineBook ? t("base.needBook") : state.baselineBook + "　" + (baseData
          ? (baseData.mode === "custom"
              ? t("base.mode.custom") + " " + (Array.isArray(baseData.chapters) ? baseData.chapters.length : 0) + t("base.selectedUnit")
              : t("base.mode.all"))
          : (state.baselineBusy ? t("base.busy") : t("base.loadFail"))),
        trailing: el(SelectMenu, {
          id: "base-book",
          controller: props.controller,
          label: t("base.bookLabel"),
          value: state.baselineBook || "",
          placeholder: t("base.noBook"),
          disabled: state.baselineBusy,
          options: baseBookList.map(function (b) { return { value: b, label: b }; }),
          onChange: function (v) { props.controller.setBaselineBook(v); }
        })
      }),
      RowDivider(el, el, t, NW_UI, { key: "base-rd1" }),
      PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
        key: "base-mode",
        title: t("base.modeLabel"),
        summary: t("base.modeHint"),
        trailing: el(NW_UI.SegmentedControl, {
          label: t("base.modeLabel"),
          value: baseMode,
          disabled: state.baselineBusy,
          options: [
            { value: "all", label: t("base.mode.all") },
            { value: "custom", label: t("base.mode.custom") }
          ],
          onChange: function (next) { if (baseMode !== next) props.controller.setBaselineMode(next); }
        })
      }),
      baseIdleRow ? RowDivider(el, el, t, NW_UI, { key: "base-rd-idle" }) : null,
      baseIdleRow,
      baseMode === "custom" ? RowDivider(el, el, t, NW_UI, { key: "base-rd2" }) : null,
      baseMode === "custom" ? basePicker : null,
      RowDivider(el, el, t, NW_UI, { key: "base-rd3" }),
      baseSaveRow
    ] }),
    // v7.3.3 修（#5）：首载还没落定（书列表在路上）时先不把"还没选书"说成"没有书"——
    // 落定后确实有书会自动选中第一本，确实没书才显示这个空态。
    !state.baselineBook && !state.loading ? el("div", { className: "nwEmpty" }, el("div", { className: "nwEmptyTitle" }, t("base.needBook"))) : null,
    baseData && baseData.sceneBaselines ? (function () {
      var sb = baseData.sceneBaselines;
      var sbMin = typeof sb.minPeerChapters === "number" && sb.minPeerChapters > 0 ? sb.minPeerChapters : 3;
      var sbCounts = sb.counts && typeof sb.counts === "object" ? sb.counts : {};
      var sbBands = sb.bands && typeof sb.bands === "object" ? sb.bands : {};
      var sbMeasured = typeof sb.measuredChapters === "number" ? sb.measuredChapters : 0;
      return [
        SectionTitle(el, el, t, NW_UI, { key: "scene-title", label: "base.sceneTitle" }),
        el("div", { key: "scene-hint", className: "nwToolsHint" }, t("base.sceneHint")),
        el("div", { key: "scene-grid", className: "nwBandGrid" }, ["dialogue", "action", "narrative"].map(function (bandKey) {
          var count = typeof sbCounts[bandKey] === "number" ? sbCounts[bandKey] : 0;
          var bandObj = sbBands[bandKey] || null;
          var bandActive = !!bandObj && count >= sbMin;
          var baselineObj = bandObj && bandObj.baseline ? bandObj.baseline : null;
          return el("div", { key: bandKey, className: "nwBandCard" },
            el("div", { className: "nwBandHead" },
              el("span", { className: "nwBandName" }, t("base.band." + bandKey)),
              el("span", { className: "nwBandCount" }, baseFill("base.bandCount", { n: count })),
              el("span", { className: "nwBandBadge" + (bandActive ? " nwBandBadgeOn" : "") },
                bandActive ? t("base.bandActive") : baseFill("base.bandFallback", { min: sbMin }))
            ),
            baselineObj ? el("div", { className: "nwBandMetrics" }, NW_METRICS.map(function (mk3) {
              var bm = baselineObj[mk3];
              var muText = bm && typeof bm.mu === "number" ? bm.mu.toFixed(2) : "—";
              var tolText = bm && typeof bm.recTol === "number" ? "±" + bm.recTol + "%" : "—";
              return el("div", { key: mk3, className: "nwBandMetricRow" },
                el("span", { className: "nwBandMetricName" }, t("base.metric." + mk3)),
                el("span", { className: "nwBandMetricVal" }, muText + " " + tolText)
              );
            })) : null
          );
        })),
        sbMeasured === 0 ? el("div", { key: "scene-empty", className: "nwRowHint nwBandEmptyHint" }, sb.uncachedLargeBook ? t("base.sceneUncachedLarge") : t("base.sceneNoMeasure")) : null
      ];
    })() : null,
    SectionTitle(el, el, t, NW_UI, { label: "base.toleranceTitle" }),
    el("div", { className: "nwToolsHint" }, t("base.toleranceHint")),
    GroupCard(el, el, t, NW_UI, { children:
      NW_METRICS.map(function (mk2) {
        var d = draft[mk2] || DEFAULT_TOL;
        var input = function (field) {
          return el("label", { className: "nwBaseTolField" },
            el("span", { className: "nwBaseTolLabel" }, t("baseline." + field)),
            el("span", { className: "nwBaseTolControl" },
              el("input", { type: "number", className: "nwTolInput", "aria-label": t("base.metric." + mk2) + " · " + t("baseline." + field), placeholder: t("tol.recommend"), value: d[field], min: 0, max: 99, disabled: state.loading, onChange: function (ev) { setDraft(mk2, field, ev.target.value); } }),
              el("span", { className: "nwBaseTolUnit" }, "%")));
        };
        return el("div", { className: "nwBaseTolRow", key: mk2 },
          el("div", { className: "nwBaseTolName" }, t("base.metric." + mk2),
            el(NW_UI.Tooltip, { label: t("base.help." + mk2) }, el("button", { type: "button", className: "nwBaseHelp", "aria-label": t("base.help." + mk2), title: t("base.help." + mk2) }, "?"))),
          input("low"), input("high"));
      })
    }),
    el("div", { className: "nwBaseActions" },
      el("button", { type: "button", className: "nwBtn nwBtnPrimary" + (state.baselineSaved ? " nwBtnDone" : ""), disabled: state.loading, onClick: saveTol }, state.baselineSaved ? t("baseline.saved") : t("baseline.save")),
      el("button", { type: "button", className: "nwBtn nwBtnGhost", disabled: state.loading, onClick: resetTol }, t("baseline.reset"))
    ),
    StorageDisclosure(el, el, t, NW_UI, { controller: props.controller, revealing: state.revealing, items: [
      { label: t("base.storage"), path: dirs.dataDir || state.dataDir || "", revealKey: "data-dir" },
      { label: t("dir.stateFile"), path: dirs.stateFile || state.file || "", revealKey: "state-file" }
    ] })
  );
}
