function renderDiagnoseView(vc) {
  var el = vc.el, state = vc.state, props = vc.props;
  // v6.6.0：诊断报告（只读）。
  // 展示口径：直接用接口给的 report（宿主分享层渲染，与 novel_diagnose 同一实现），
  // 面板**不重拼报告**；状态量 pill 与 issues 行都取结构化字段，纯展示、不改写。
  var diagData = state.diag;
  var diagDays = state.diagDays || "7";
  var diagCalls = diagData && diagData.calls && typeof diagData.calls === "object" ? diagData.calls : null;
  var diagIssues = diagData && Array.isArray(diagData.issues) ? diagData.issues : [];
  var diagReport = diagData && typeof diagData.report === "string" ? diagData.report : "";
  // {n} 占位符替换（与基线页 baseFill 同口径；缺键时 t() 返回键名，替换后仍是可读文案）
  var diagFill = function (key, map) {
    var text = String(t(key));
    for (var fk in map) text = text.split("{" + fk + "}").join(String(map[fk]));
    return text;
  };
  // 级别 → 既有语义色类（error=label-error / warn=state-warn-label / info=label-dimmed），不新增组件
  var diagLevelCls = function (level) {
    return level === "error" ? "nwNote nwPlotErr" : level === "warn" ? "nwNote nwNoteWarn" : "nwNote";
  };
  var diagLevelKey = function (level) {
    return level === "error" ? "diag.level.error" : level === "warn" ? "diag.level.warn" : "diag.level.info";
  };
  // ---- v7.2.0：对抗性审计卡片（诊断页）。结果按 action 三态渲染；章节留空 = 最后一章（后端同口径）----
  var auditResult = state.auditResult;
  var auditBusy = state.auditBusy === true;
  var auditBook = typeof state.auditBook === "string" ? state.auditBook : "";
  // v7.2.0：书名下拉的选项（GET /audit 带回 novels/ 下的作品名）。当前值不在列表里时也补进去，
  // 否则下拉会显示空、用户会以为"书没了"。
  var auditBookOptions = [];
  (Array.isArray(state.auditBooks) ? state.auditBooks : []).forEach(function (n) {
    if (typeof n === "string" && n !== "") auditBookOptions.push({ value: n, label: n });
  });
  if (auditBookOptions.length > 0 && auditBook !== "" && !auditBookOptions.some(function (o) { return o.value === auditBook; })) {
    auditBookOptions.unshift({ value: auditBook, label: auditBook });
  }
  var auditChapter = typeof state.auditChapter === "string" ? state.auditChapter : "";
  var auditClaims = typeof state.auditClaims === "string" ? state.auditClaims : "";
  // v7.3.0：草稿镜像预览的派生状态（只读；章节留空 = 列镜像文件）
  var draftBook = typeof state.draftBook === "string" ? state.draftBook : "";
  var draftBookOptions = [];
  (Array.isArray(state.auditBooks) ? state.auditBooks : []).forEach(function (n) {
    if (typeof n === "string" && n !== "") draftBookOptions.push({ value: n, label: n });
  });
  if (draftBookOptions.length > 0 && draftBook !== "" && !draftBookOptions.some(function (o) { return o.value === draftBook; })) {
    draftBookOptions.unshift({ value: draftBook, label: draftBook });
  }
  var draftChapter = typeof state.draftChapter === "string" ? state.draftChapter : "";
  var draftBusy = state.draftBusy === true;
  var draftPeek = state.draftPeek && typeof state.draftPeek === "object" ? state.draftPeek : null;
  var draftPeekNodes = [];
  if (draftPeek) {
    if (Array.isArray(draftPeek.items)) {
      if (draftPeek.items.length === 0) {
        draftPeekNodes.push(el("div", { key: "draft-none", className: "nwRowHint" }, t("draft.noMirror")));
      } else {
        draftPeekNodes.push(el("div", { key: "draft-count", className: "nwNote nwAccentStrong" }, diagFill("draft.count", { n: String(draftPeek.items.length) })));
        draftPeek.items.forEach(function (it, i) {
          draftPeekNodes.push(el("div", { key: "draft-item-" + i, className: "nwDiagAttentionItem" },
            el("div", null, String(it.chapterKey || it.file)),
            // v7.3.2 修（N22 连带）：stat 失败时后端不再伪造 bytes:0，而是省略该键并给 statError。
            // 这里不能再写 `it.bytes || 0`（那会把"读不到"显示成"0 字节"），改为如实显示未知 + 错误码。
            el("div", { className: "nwDiagDetail" }, it.statError
              ? diagFill("draft.itemMetaUnknown", { code: String(it.statError) })
              : diagFill("draft.itemMeta", { n: String(it.bytes ?? 0) }))
          ));
        });
      }
    } else if (Array.isArray(draftPeek.segments)) {
      if (!draftPeek.exists) {
        draftPeekNodes.push(el("div", { key: "draft-absent", className: "nwRowHint" }, t("draft.absent")));
      } else {
        draftPeekNodes.push(el("div", { key: "draft-meta", className: "nwNote nwAccentStrong" }, diagFill("draft.meta", { n: String(draftPeek.segments.length), chars: String(draftPeek.totalChars || 0) })));
        if (Array.isArray(draftPeek.segments)) {
          draftPeekNodes.push(el("pre", {
            key: "draft-pre",
            className: "nwDiagDetail",
            style: { whiteSpace: "pre-wrap", maxHeight: "320px", overflow: "auto", margin: 0 }
          }, draftPeek.segments.map(function (seg) { return diagFill("draft.segmentHeading", { n: String(seg.index) }) + "\n\n" + seg.text; }).join("\n\n")));
        }
      }
    }
  }
  var auditLine = function (n) { return diagFill("audit.line", { n: String(n) }); };
  var auditResultNodes = [];
  if (auditResult && typeof auditResult === "object") {
    if (auditResult.action === "audit") {
      var auditReport = auditResult.report && typeof auditResult.report === "object" ? auditResult.report : {};
      var auditViolations = Array.isArray(auditReport.violations) ? auditReport.violations : [];
      var auditContracts = Array.isArray(auditReport.contracts) ? auditReport.contracts : [];
      auditResultNodes.push(el("div", { key: "audit-count", className: "nwNote nwAccentStrong" }, diagFill("audit.violations", { n: String(auditViolations.length) })));
      for (var av = 0; av < auditViolations.length; av += 1) {
        var avItem = auditViolations[av] && typeof auditViolations[av] === "object" ? auditViolations[av] : {};
        var avLine = Number(avItem.line) > 0 ? "（" + auditLine(avItem.line) + "）" : "";
        auditResultNodes.push(el("div", { key: "audit-v-" + av, className: "nwDiagAttentionItem" },
          el("div", { className: "nwNote" }, "[" + String(avItem.contract || "") + "] " + String(avItem.title || "") + avLine),
          avItem.text ? el("div", { className: "nwDiagDetail" }, String(avItem.text)) : null));
      }
      // 没跑的契约单列一行并给原因——"0 条违约"不等于"每条都跑过"，不写清就是误导
      var auditSkipped = auditContracts.filter(function (c) { return c && c.ran === false; });
      if (auditSkipped.length > 0) {
        auditResultNodes.push(el("div", { key: "audit-skipped", className: "nwRowHint" },
          t("audit.skipped") + "：" + auditSkipped.map(function (c) {
            return String(c.id || "") + "（" + String(c.reason || "") + "）";
          }).join("；")));
      }
    } else if (auditResult.action === "brief") {
      var auditBrief = typeof auditResult.brief === "string" ? auditResult.brief : "";
      var auditBriefLen = String(auditBrief).length;
      auditResultNodes.push(el("div", {
        key: "audit-brief-ok",
        className: auditResult.copied === true ? "nwNote nwNoteOk" : "nwNote nwNoteWarn"
      }, diagFill(auditResult.copied === true ? "audit.briefCopied" : "audit.briefCopyFail", { n: String(auditBriefLen) })));
      if (auditBrief !== "") {
        // 前 200 字预览：够确认"是不是这一章"，又不把整份任务书摊在面板里
        auditResultNodes.push(el("div", { key: "audit-brief-preview", className: "nwNote" }, auditBrief.slice(0, 200)));
      }
    } else if (auditResult.action === "verify") {
      var auditVerify = auditResult.verify && typeof auditResult.verify === "object" ? auditResult.verify : {};
      var auditAcc = Array.isArray(auditVerify.accepted) ? auditVerify.accepted.length : 0;
      var auditCorr = Array.isArray(auditVerify.corrected) ? auditVerify.corrected.length : 0;
      var auditRej = Array.isArray(auditVerify.rejected) ? auditVerify.rejected : [];
      auditResultNodes.push(el("div", { key: "audit-verify-ok", className: "nwNote nwAccentStrong" }, diagFill("audit.verifyOk", {
        ok: String(auditAcc + auditCorr),
        fix: String(auditCorr),
        bad: String(auditRej.length),
        score: String(auditVerify.score === void 0 || auditVerify.score === null ? 0 : auditVerify.score)
      })));
      for (var rv = 0; rv < auditRej.length; rv += 1) {
        var rvItem = auditRej[rv] && typeof auditRej[rv] === "object" ? auditRej[rv] : {};
        var rvLine = Number(rvItem.line) > 0 ? "（" + auditLine(rvItem.line) + "）" : "";
        auditResultNodes.push(el("div", { key: "audit-r-" + rv, className: "nwNote nwNoteWarn" },
          "[" + String(rvItem.contract || "") + "] " + t("audit.rejected") + rvLine + "：" + String(rvItem.text || "")));
      }
    }
  }
  return el("div", null,

    el("div", { className: "nwToolsHint" }, t("diag.desc")),
    GroupCard(el, el, t, NW_UI, { children: [
      PreferenceRow(el, el, t, NW_UI, nwIconEls(el), {
        key: "diag-window",
        icon: "navDiagnose",
        title: t("diag.windowLabel"),
        summary: t("diag.windowHint"),
        trailing: el(NW_UI.SegmentedControl, {
          label: t("diag.windowLabel"),
          value: diagDays,
          disabled: state.diagBusy,
          options: ["1", "7", "30"].map(function (d) { return { value: d, label: d + " " + t("diag.daysUnit") }; }),
          onChange: function (next) { if (next !== diagDays) props.controller.setDiagDays(next); }
        })
      }),
      RowDivider(el, el, t, NW_UI, { key: "diag-rd-calls" }),
      el("div", { key: "diag-calls", className: "nwPillRow" },
        el("div", { className: "nwPill" },
          el("span", { className: "nwPillKey" }, t("diag.callsTotal")),
          el("span", { className: "nwPillVal" }, diagCalls ? String(diagCalls.total || 0) : "—")
        ),
        el("div", { className: "nwPill" },
          el("span", { className: "nwPillKey" }, t("diag.callsDegraded")),
          el("span", { className: "nwPillVal" }, diagCalls ? String(diagCalls.degraded || 0) : "—")
        ),
        el("div", { className: "nwPill" },
          el("span", { className: "nwPillKey" }, t("diag.callsFailed")),
          el("span", { className: "nwPillVal" }, diagCalls ? String(diagCalls.failed || 0) : "—")
        )
      )
    ] }),
    // v7.0.0：度量口径（细节密度词表去噪）。只读展示 + 一个"重建旧缓存"的动作按钮：
    // 口径变了以后同一章的新旧数值不可比，把这件事做成面板上看得见的一行，
    // 比只写在更新日志里管用（用户不会去翻 CHANGELOG，但会看诊断页）。
    GroupCard(el, el, t, NW_UI, { children: [
      el("div", { key: "heading", className: "nwDiagHeading" }, t("caliber.title")),
      // v7.0.0 修正（实测踩到）：`.nwPillRow` / `.nwRowHint` / `.nwBaseActions` 这三条规则
      // **都不带横向内边距**——它们平时都嵌在带 padding 的行组件里（如 PreferenceRow）。
      // 直接塞进 GroupCard 会让说明文字与按钮顶到卡片左右边缘（面板截图报的就是这个）。
      // 这里复用同页已有的 `.nwDiagAttentionList`（padding:0 16px 16px）作为内容容器，
      // 不新增类名，保持类名契约不变。
      el("div", { key: "caliber-body", className: "nwDiagAttentionList" },
        el("div", { className: "nwPillRow" },
          el("div", { className: "nwPill" },
            el("span", { className: "nwPillKey" }, t("caliber.current")),
            el("span", { className: "nwPillVal" }, state.caliber && typeof state.caliber.caliber === "string" ? state.caliber.caliber : "—")
          ),
          // v7.2.0：把「插件版本」也放出来。此前面板只显示口径号（v7.1.0），
          // 用户看到插件是 7.2.0 就以为"口径版本写错了"——其实口径号只在测量规则变化时递增。
          el("div", { className: "nwPill" },
            el("span", { className: "nwPillKey" }, t("caliber.plugin")),
            el("span", { className: "nwPillVal" }, state.caliber && typeof state.caliber.version === "string" ? state.caliber.version : "—")
          ),
          el("div", { className: "nwPill" },
            el("span", { className: "nwPillKey" }, t("caliber.stale")),
            el("span", { className: "nwPillVal" }, state.caliber && typeof state.caliber.stale === "number" ? String(state.caliber.stale) : "—")
          )
        ),
        el("div", { className: "nwRowHint" }, t("caliber.hint").split("{v}").join(state.caliber && typeof state.caliber.version === "string" ? state.caliber.version : "—")),
        el("div", { className: "nwBaseActions" },
          el("button", { type: "button", className: "nwBtn nwBtnGhost", disabled: state.caliberBusy, onClick: function () { props.controller.rebuildCaliber(); } },
            state.caliberBusy ? t("caliber.busy") : t("caliber.rebuild"))),
        state.caliberMsg !== "" ? el("div", { key: "caliber-msg", className: "nwNote" }, state.caliberMsg) : null
      )
    ] }),
    // v7.2.0：对抗性审计（本地对账的独立入口）。紧跟「度量口径」——两张卡都是诊断页上的只读工具，
    // 也都不花 token，同类聚在一起。方案 A：**不新增工具**，这里只是一个看得见的入口 +
    // "哪一步花 token"的说明书（对账/任务书/复核全在本地；只有另派 agent 执行任务书才花会话费）。
    // 只用诊断页与表单页已有的结构类（nwDiagHeading / nwDiagAttentionList / nwDiagAttentionItem /
    // nwDiagDetail / nwRowHint / nwTextInput / nwTextArea / nwBaseActions / nwBtn / nwNote），零新增 CSS。
    GroupCard(el, el, t, NW_UI, { children: [
      el("div", { key: "audit-heading", className: "nwDiagHeading" }, t("audit.title")),
      el("div", { key: "audit-body", className: "nwDiagAttentionList" },
        el("div", { key: "audit-hint", className: "nwRowHint" }, t("audit.hint")),
        el("div", { key: "audit-howto", className: "nwRowHint" }, t("audit.howto")),
        // v7.2.0：书名改成**下拉**（GET /audit 会带回 novels/ 下的作品名）。
        // 手打书名是"报错"的头号来源——名字差一个字就是一句 400，用户只会觉得"这功能坏了"。
        auditBookOptions.length > 0
          ? el(SelectMenu, {
            id: "audit-book",
            controller: props.controller,
            label: t("audit.bookPlaceholder"),
            value: auditBook,
            placeholder: t("audit.bookPlaceholder"),
            options: auditBookOptions,
            onChange: function (v) { props.controller.set({ auditBook: v, auditMsg: "" }, { silent: true }); }
          })
          : el("input", {
            key: "audit-book", type: "text", className: "nwTextInput",
            value: auditBook, placeholder: t("audit.bookPlaceholder"), "aria-label": t("audit.bookPlaceholder"),
            onChange: function (ev) { props.controller.set({ auditBook: ev.target.value }, { silent: true }); }
          }),
        el("input", {
          key: "audit-chapter", type: "text", className: "nwTextInput",
          value: auditChapter, placeholder: t("audit.chapterPlaceholder"), "aria-label": t("audit.chapterPlaceholder"),
          onChange: function (ev) { props.controller.set({ auditChapter: ev.target.value }, { silent: true }); }
        }),
        el("textarea", {
          key: "audit-claims", className: "nwTextArea", rows: 3,
          value: auditClaims, placeholder: t("audit.claimsPlaceholder"), "aria-label": t("audit.claimsPlaceholder"),
          onChange: function (ev) { props.controller.set({ auditClaims: ev.target.value }, { silent: true }); }
        }),
        el("div", { key: "audit-actions", className: "nwBaseActions" },
          el("button", { type: "button", className: "nwBtn nwBtnGhost", disabled: auditBusy, onClick: function () { props.controller.runAudit("audit"); } }, t("audit.run")),
          el("button", { type: "button", className: "nwBtn nwBtnGhost", disabled: auditBusy, onClick: function () { props.controller.runAudit("brief"); } }, t("audit.brief")),
          el("button", { type: "button", className: "nwBtn nwBtnGhost", disabled: auditBusy, onClick: function () { props.controller.runAudit("verify"); } }, t("audit.verify"))
        ),
        auditBusy ? el("div", { key: "audit-busy", className: "nwNote" }, t("audit.busy")) : null,
        String(state.auditMsg || "") !== ""
          ? el("div", { key: "audit-msg", className: "nwNote" + (state.auditErr === true ? " nwNoteWarn" : "") }, state.auditMsg)
          : null,
        auditResultNodes.length === 0 && !auditBusy && String(state.auditMsg || "") === ""
          ? el("div", { key: "audit-empty", className: "nwRowHint" }, t("audit.empty"))
          : null,
        auditResultNodes
      )
    ] }),
    // v7.3.0：草稿镜像预览。为什么放在面板里：镜像写在 .novel-writer/drafts/<书>/，
    // 而「实时聊天写作」的卖点就是"能看到他正在写什么"——没有这个入口，用户只能去文件管理器里找。
    // 只读：不提供任何修改/清理按钮（清理请人工删文件，或按书删除时连带清掉）。
    GroupCard(el, el, t, NW_UI, { children: [
      el("div", { key: "draft-heading", className: "nwDiagHeading" }, t("draft.title")),
      el("div", { key: "draft-body", className: "nwDiagAttentionList" },
        el("div", { key: "draft-hint", className: "nwRowHint" }, t("draft.hint")),
        draftBookOptions.length > 0
          ? el(SelectMenu, {
            id: "draft-book",
            controller: props.controller,
            label: t("draft.bookLabel"),
            value: draftBook,
            placeholder: t("draft.bookLabel"),
            disabled: state.draftBusy === true,
            options: draftBookOptions,
            onChange: function (v) { props.controller.setDraftBook(v); }
          })
          : el("input", {
            key: "draft-book", type: "text", className: "nwTextInput",
            value: draftBook,
            placeholder: t("draft.bookLabel"),
            "aria-label": t("draft.bookLabel"),
            disabled: state.draftBusy === true,
            onChange: function (ev) { props.controller.setDraftBook(ev.target.value); }
          }),
        el("input", {
          type: "text", className: "nwTextInput",
          value: draftChapter,
          placeholder: t("draft.chapterPlaceholder"),
          "aria-label": t("draft.chapterPlaceholder"),
          onChange: function (ev) { props.controller.set({ draftChapter: ev.target.value }, { silent: true }); }
        }),
        el("div", { key: "draft-actions", className: "nwBaseActions" },
          el("button", { type: "button", className: "nwBtn nwBtnGhost", disabled: draftBusy, onClick: function () { props.controller.loadDraftPeek(); } },
            draftBusy ? t("draft.busy") : t("draft.load")),
          draftPeek && draftPeek.mirrorDir
            ? el("button", { type: "button", className: "nwBtn nwBtnGhost", onClick: function () { props.controller.auditCopy(draftPeek.mirrorDir, function (ok) { props.controller.set({ draftMsg: ok ? t("draft.copied") : t("draft.copyFail"), draftErr: !ok }, { silent: true }); }); } }, t("draft.copyDir"))
            : null
        ),
        // v7.3.1 修（#88）：旧写法两支都是空串、且读错标志（auditErr）。改判草稿自身的 draftErr，
        // 失败时复用既有 nwNoteWarn 警告语义色（不新增 CSS 类）。
        String(state.draftMsg || "") !== "" ? el("div", { key: "draft-msg", className: "nwNote" + (state.draftErr === true ? " nwNoteWarn" : "") }, state.draftMsg) : null,
        draftPeekNodes
      )
    ] }),
    diagIssues.length > 0 ? GroupCard(el, el, t, NW_UI, { children: [
      el("div", { key: "heading", className: "nwDiagHeading" }, t("diag.issues")),
      el("div", { key: "issues", className: "nwDiagAttentionList" }, diagIssues.map(function (it, i) {
        var level = it && it.level === "error" ? "error" : it && it.level === "warn" ? "warn" : "info";
        var title = it && typeof it.title === "string" && it.title !== "" ? it.title : String(t(diagLevelKey(level)));
        return el("div", { key: "diag-issue-" + i, className: "nwDiagAttentionItem" },
          el("div", { className: diagLevelCls(level) }, title),
          it && it.detail ? el("div", { className: "nwDiagDetail" }, it.detail) : null,
          it && it.suggestion ? el("div", { className: "nwDiagDetail" }, t("diag.suggestion") + "：" + it.suggestion) : null);
      }))
    ] }) : null,
    diagReport !== ""
      ? el("pre", { key: "diag-report", className: "nwDiagReport", tabIndex: 0 }, diagReport)
      : el("div", { key: "diag-empty", className: "nwEmpty" },
          state.diagBusy ? t("diag.busy") : state.diagErr ? t("diag.loadFailHint") : diagFill("diag.emptyHint", { n: diagDays })),
    state.diagManual
      ? el("div", { key: "diag-manual", className: "nwNote nwNoteWarn" }, t("diag.manual"))
      : null,
    el("div", { className: "nwBaseActions" },
      el("button", { type: "button", className: "nwBtn nwBtnPrimary", disabled: state.diagBusy, onClick: function () { props.controller.loadDiagnose(); } },
        state.diagBusy ? t("diag.busy") : (diagData ? t("diag.refresh") : t("diag.run"))),
      el("button", { type: "button", className: "nwBtn nwBtnGhost", disabled: state.diagBusy || diagReport === "", onClick: function () { props.controller.diagCopy(); } }, t("diag.copy"))
    )
  );
}
