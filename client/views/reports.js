function renderReportsView(vc) {
  var el = vc.el, state = vc.state, props = vc.props, f = vc.f, dirs = vc.dirs;
  // v3.2.0：报告历史（加载在入口 onClick 触发，此处纯渲染防 React 345 循环）
  var openReport = function (file) {
    var reqId = ++reportReqId;
    props.controller.set({ reportContent: t("reports.loading") }, { silent: true });
    // v4.3.0：非 2xx 不再直接 throw——先解析宿主 JSON 取可操作错误（如 404 {error:"报告不存在"}），
    // 否则一律显示成"网络/路由不可用"，用户根本不知道为什么点不开
    fetchWithTimeout("/api/dsh-novel-writer/reports?read=" + encodeURIComponent(file), { headers: { accept: "application/json" } }).then(function (r2) {
      if (r2.ok) return r2.json();
      return r2.json().catch(function () { return {}; }).then(function (d) {
        return { ok: false, error: d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r2.status };
      });
    }).then(function (d) {
      if (reqId !== reportReqId) return; // v3.5.0 #47：快速切换时丢弃过期响应
      props.controller.set({ reportContent: d.ok ? JSON.stringify(d.content, null, 2) : (t("reports.readFail") + "：" + (d.error || "")) }, { silent: true });
    }).catch(function (err) { if (reqId !== reportReqId) return; props.controller.set({ reportContent: t("reports.readFail") + "：" + errorText(err) }, { silent: true }); });
  };
  // 后端按目录分组；此处只重排展示，不更改文件名或读取请求。
  var reportBooks = (state.books || []).slice().sort(function (a, b) { return b.length - a.length; });
  var reportInfo = function (f) {
    var stem = String(f.file || "").replace(/\.json$/i, "");
    var book = "";
    for (var ri = 0; ri < reportBooks.length; ri += 1) {
      if (stem === reportBooks[ri] || stem.indexOf(reportBooks[ri] + "-") === 0 || stem.indexOf(reportBooks[ri] + "__") === 0) { book = reportBooks[ri]; break; }
    }
    var match = stem.match(/^(.*?)(__base-full|-chapters-metrics|-full|-keywords-.+)$/);
    if (!book && match && match[1]) book = match[1];
    var tail = book ? stem.slice(book.length).replace(/^-/, "") : stem;
    var label = f.label || stem, hash = "";
    if (/^__base-full$/.test(tail)) label = t("reports.name.baseline");
    else if (/^chapters-metrics$/.test(tail)) label = t("reports.name.chapters");
    else if (/^full$/.test(tail)) label = t("reports.name.full");
    else if (/^keywords-.+$/.test(tail)) label = t("reports.name.keywords");
    else if (/^[a-f0-9]{6,}$/i.test(tail)) { label = t("reports.name.segment"); hash = tail.slice(0, 6); }
    return { book: book || t("reports.unassigned"), label: label, hash: hash, source: f };
  };
  var groups = [];
  (state.reportsGroups || []).forEach(function (sourceGroup) {
    (sourceGroup.files || []).forEach(function (file) {
      var info = reportInfo(file);
      var group = groups.filter(function (g) { return g.name === info.book; })[0];
      if (!group) { group = { name: info.book, files: [] }; groups.push(group); }
      group.files.push(info);
    });
  });
  var totalFiles = groups.reduce(function (a, g) { return a + (g.files || []).length; }, 0);
  var reportsLoading = state.reportsGroups === null && !state.reportsError;
  return el("div", null,
    el("div", { className: "nwToolsHint" }, t("reports.hint")),
    state.reportContent ? el("div", null,
      el("button", { type: "button", className: "nwBtn nwBtnGhost", onClick: function () { reportReqId += 1; props.controller.set({ reportContent: null }, { silent: true }); } }, t("reports.back")),
      el("pre", { className: "nwReportsBody", tabIndex: 0 }, state.reportContent))
    : el("div", null,
        reportsLoading ? el("div", { className: "nwEmpty" }, t("reports.loading2")) : (totalFiles === 0 && !state.reportsError) ? el("div", { className: "nwEmpty" }, t("reports.empty")) : null,
        groups.map(function (g) {
          return el("div", { key: g.name, className: "nwReportsGroup" }, GroupCard(el, el, t, NW_UI, { children: [
            el("div", { key: "head", className: "nwReportsHead" }, el("span", null, g.name), CountBadge(el, el, t, NW_UI, { label: String(g.files.length) })),
            g.files.map(function (info) {
              var f = info.source;
              // v6.8.0：行本身不再是 <button>（按钮里不能再放按钮），改为「打开 / 日期 / 删除」三段；
              // 删除走回收站，且只有确认框里那一个文件名，避免删错相邻行。
              return el("div", { key: f.file, className: "nwReportsFile", title: f.file },
                el("button", { type: "button", className: "nwReportsOpen", title: f.file, onClick: function () { openReport(f.file); } },
                  el("span", { className: "nwReportsLabel" }, info.label, info.hash ? el("span", { className: "nwReportsHash" }, info.hash) : null)),
                el("span", { className: "nwReportsDate" }, (f.time || "").slice(0, 16).replace("T", " ")),
                // v6.8.0 修正：这里曾用自造的纯文字按钮（.nwRowAction），在宿主 button reset 下被 flex 压成
                // 一字一行、还撑高了整行。改用面板里已验证的行尾按钮写法（词表页同款），并由 CSS 兜底不参与收缩。
                el("button", {
                  type: "button",
                  className: "nwBtn nwBtnGhost nwBtnSm nwBtnDangerText",
                  title: t("reports.delete") + " " + f.file,
                  disabled: state.reportDeleting === f.file,
                  onClick: function () { props.controller.deleteReport(f.file); }
                }, t("reports.delete")));
            })
          ] }));
        })),
    StorageDisclosure(el, el, t, NW_UI, { controller: props.controller, revealing: state.revealing, items: [
      { label: t("dir.analysis"), path: dirs.analysisDir || "", revealKey: "analysis-dir" },
      { label: t("reports.storage"), path: dirs.dataDir || state.dataDir || "", revealKey: "data-dir" }
    ] })
  );
}
