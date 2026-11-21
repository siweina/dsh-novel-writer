function attachDiagnoseController(api) {
  Object.assign(api, {
    // ---- v6.6.0 诊断（GET /api/dsh-novel-writer/diagnose）：只读通道，与词表/基线同族 ----
    // 语义要点：响应的 report 由宿主「分享层」渲染（自由文本已整体剔除），面板**只展示不重拼**，
    // 否则面板与 novel_diagnose 工具的报告会各写一份、随时间分叉。
    diagReqId: 0,
    diagDaysNum: function () {
      var n = Number(api.getSnapshot().diagDays);
      if (!isFinite(n) || n <= 0) n = 7;
      return Math.min(90, Math.max(1, Math.trunc(n)));
    },
    diagUrl: function () {
      return "/api/dsh-novel-writer/diagnose?days=" + String(api.diagDaysNum());
    },
    loadDiagnose: function () {
      var reqId = (api.diagReqId += 1);
      api.set({ diagBusy: true, diagErr: false }, { silent: true });
      return fetchWithTimeout(api.diagUrl(), { headers: { accept: "application/json" } }).then(function (r) {
        if (r.ok) return r.json();
        return r.json().catch(function () { return {}; }).then(function (d) {
          throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r.status);
        });
      }).then(function (data) {
        if (reqId !== api.diagReqId) return null; // 已有更新的请求发出：丢弃本次过期响应（口径同词表/基线）
        api.set({ diag: data, diagBusy: false, diagErr: false, diagManual: false }, { silent: true });
        return data;
      }).catch(function (err) {
        if (reqId !== api.diagReqId) return null; // 过期请求的失败同样不覆盖新结果与新提示
        // 失败时**保留上一份报告**（诊断失败不该把仅有的可分享材料清掉），只置错误态 + 横幅
        api.set({ diagBusy: false, diagErr: true, revealMsg: t("diag.loadFail") + "：" + errorText(err), revealErr: true }, { silent: true });
        return null;
      });
    },
    setDiagDays: function (days) {
      var next = String(days === void 0 || days === null ? "7" : days);
      var n = Number(next);
      next = (!isFinite(n) || n <= 0) ? "7" : String(Math.min(90, Math.max(1, Math.trunc(n))));
      if (next === api.getSnapshot().diagDays) return;
      api.set({ diagDays: next, diagManual: false }, { silent: true });
      api.loadDiagnose(); // 窗口变了，已展示的报告就过期了：立刻按新窗口重取
    },
    // ---- v7.0.0：度量口径（GET 只读探测 / POST 重建缓存）----
    // 探测只读：列出"仍是旧口径"的逐章指标缓存，不删任何东西。
    // 重建是**破坏性动作**（删缓存文件），所以走 POST，且只删 -chapters-metrics.json——
    // 那是纯派生数据，删了下次测量即重建；用户的基线范围设置保存在 baseline/ 下，绝不动它。
    caliberReqId: 0,
    loadCaliber: function () {
      var reqId = (api.caliberReqId += 1);
      return fetchWithTimeout(CALIBER_ROUTE, { headers: { accept: "application/json" } }).then(function (r) {
        if (r.ok) return r.json();
        return r.json().catch(function () { return {}; }).then(function (d) {
          throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r.status);
        });
      }).then(function (data) {
        if (reqId !== api.caliberReqId) return null;
        api.set({ caliber: data, caliberBusy: false }, { silent: true });
        return data;
      }).catch(function () {
        if (reqId !== api.caliberReqId) return null;
        // 探测失败不打扰主流程：口径区显示"—"即可，不弹横幅（诊断页本身已有错误态）
        api.set({ caliber: null, caliberBusy: false }, { silent: true });
        return null;
      });
    },
    rebuildCaliber: function () {
      api.set({ caliberBusy: true, caliberMsg: "" }, { silent: true });
      return fetchWithTimeout(CALIBER_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ action: "rebuild" })
      }).then(function (r) {
        if (r.ok) return r.json();
        return r.json().catch(function () { return {}; }).then(function (d) {
          throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r.status);
        });
      }).then(function (data) {
        var n = data && typeof data.deleted === "number" ? data.deleted : 0;
        api.set({ caliberBusy: false, caliberMsg: t("caliber.rebuilt").split("{n}").join(String(n)) }, { silent: true });
        return api.loadCaliber();
      }).catch(function (err) {
        api.set({ caliberBusy: false, caliberMsg: t("caliber.rebuildFail") + "：" + errorText(err) }, { silent: true });
        return null;
      });
    },
    // ---- v7.2.0：对抗性审计（POST /api/dsh-novel-writer/audit）----
    // 三个动作共用一条**只读**路由：audit=严格对账 / brief=生成任务书 / verify=复核 claims。
    // 全程本地：不调用模型、不消耗 token、不落盘。唯一花钱的是"把任务书交给另一个 agent 执行"，
    // 那一步发生在面板之外——所以这里一个 API 都不替用户发起。
    auditReqId: 0,
    auditBooksReqId: 0,
    // v7.3.1 修（#82）：草稿预览的请求序号（同 loadAuditBooks / 诊断 / 词表的 reqId 过期丢弃口径）
    draftReqId: 0,
    /**
     * 取作品列表（GET /audit 顺带返回）。失败不打扰主流程：下拉退回"手打书名"的输入框。
     */
    loadAuditBooks: function () {
      var reqId = (api.auditBooksReqId += 1);
      return fetchWithTimeout(AUDIT_ROUTE, { headers: { accept: "application/json" } }).then(function (r) {
        if (!r.ok) return null;
        return r.json();
      }).then(function (data) {
        if (reqId !== api.auditBooksReqId) return null;
        var books = data && Array.isArray(data.books) ? data.books.filter(function (n) { return typeof n === "string" && n !== ""; }) : [];
        api.set({ auditBooks: books }, { silent: true });
        return books;
      }).catch(function () {
        if (reqId !== api.auditBooksReqId) return null;
        api.set({ auditBooks: [] }, { silent: true });
        return null;
      });
    },
    /**
     * v7.3.0：草稿镜像预览（GET /draft?book=&chapter=）。
     * 章节留空 → 列出该书所有镜像文件（面板里先看"有哪几章"）；给了章节 → 返回逐段正文。
     * 只读：不写、不改、不清理。
     */
    setDraftBook: function (book) {
      api.draftReqId += 1;
      api.set({ draftBook: book || "", draftPeek: null, draftBusy: false, draftMsg: "", draftErr: false }, { silent: true });
    },
    loadDraftPeek: function () {
      // v7.3.1 修（#82）：先作废任何在途请求——即使本次因"没选书"提前返回，旧响应也不得再回写。
      var reqId = (api.draftReqId += 1);
      var snap = api.getSnapshot();
      var book = String(snap.draftBook || snap.auditBook || "").trim();
      if (book === "") { api.set({ draftMsg: t("draft.needBook"), draftBusy: false, draftErr: false }, { silent: true }); return Promise.resolve(null); }
      var chapter = String(snap.draftChapter || "").trim();
      api.set({ draftBusy: true, draftMsg: "", draftErr: false }, { silent: true });
      var url = DRAFT_ROUTE + "?book=" + encodeURIComponent(book) + (chapter === "" ? "" : "&chapter=" + encodeURIComponent(chapter));
      return fetchWithTimeout(url, { headers: { accept: "application/json" } }).then(function (r) {
        if (r.ok) return r.json();
        return r.json().catch(function () { return {}; }).then(function (d) {
          throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r.status);
        });
      }).then(function (data) {
        if (reqId !== api.draftReqId) return null; // 已有更新的请求发出：丢弃本次过期响应
        api.set({ draftPeek: data, draftBusy: false, draftMsg: "", draftErr: false }, { silent: true });
        return data;
      }).catch(function (err) {
        if (reqId !== api.draftReqId) return null; // 过期请求的失败同样不覆盖新结果与新提示
        // v7.3.1 修（#88）：草稿通道用自己的错误标志（draftErr），界面据此用警告语义色
        api.set({ draftPeek: null, draftBusy: false, draftErr: true, draftMsg: t("draft.fail") + "：" + errorText(err) }, { silent: true });
        return null;
      });
    },
    /**
     * 安全复制：与 copyPath / diagCopy 同一套写法——`navigator` 在非安全上下文可能不存在，
     * 访问 `navigator.clipboard` 也可能同步抛错（Permissions Policy），一律降级成"没复制成功"，
     * 绝不谎报成功（任务书仍留在结果区，可手动全选）。
     */
    auditCopy: function (text, done) {
      var dispatched = false;
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
          dispatched = true;
        }
      } catch (err) { /* 权限策略/沙箱里访问 clipboard 会同步抛错 → 走失败分支 */ }
      if (!dispatched) done(false);
    },
    /** kind: "audit" | "brief" | "verify"；面板三个按钮各自显式传值，其它值按 audit 兜底。 */
    runAudit: function (kind) {
      var s = api.getSnapshot();
      var book = String(s.auditBook || "").trim();
      var chapter = String(s.auditChapter || "").trim();
      if (book === "") {
        api.set({ auditBusy: false, auditErr: true, auditMsg: t("audit.needBook") }, { silent: true });
        return Promise.resolve(null);
      }
      var action = kind === "brief" ? "brief" : kind === "verify" ? "verify" : "audit";
      var payload = { action: action, book: book, chapter: chapter };
      if (action === "verify") {
        var raw = String(s.auditClaims || "").trim();
        var claims = [];
        if (raw !== "") {
          try {
            var parsed = JSON.parse(raw);
            // 两种交付形态都收：裸数组，或任务书协议要求的 {"claims":[...]}
            claims = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.claims) ? parsed.claims : null);
          } catch (err) { claims = null; }
          if (claims === null) {
            // 本地就拦住：别把一段非法 JSON 发到宿主，再换回一个更难懂的 400
            api.set({ auditBusy: false, auditErr: true, auditMsg: t("audit.claimsBad") }, { silent: true });
            return Promise.resolve(null);
          }
        }
        if (claims.length === 0) {
          api.set({ auditBusy: false, auditErr: true, auditMsg: t("audit.claimsNeeded") }, { silent: true });
          return Promise.resolve(null);
        }
        payload.claims = claims;
      }
      var reqId = (api.auditReqId += 1);
      api.set({ auditBusy: true, auditErr: false, auditMsg: "" }, { silent: true });
      return fetchWithTimeout(AUDIT_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload)
      }).then(function (r) {
        if (r.ok) return r.json();
        return r.json().catch(function () { return {}; }).then(function (d) {
          throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r.status);
        });
      }).then(function (data) {
        if (reqId !== api.auditReqId) return null;
        if (action === "brief") {
          var brief = data && typeof data.brief === "string" ? data.brief : "";
          // 复制是本地动作：成功/失败都如实回报，任务书本身一定进结果区
          return new Promise(function (resolve) {
            api.auditCopy(brief, function (ok) {
              if (reqId !== api.auditReqId) return resolve(null);
              api.set({ auditBusy: false, auditResult: { action: "brief", brief: brief, copied: ok === true } }, { silent: true });
              resolve(data);
            });
          });
        }
        api.set({ auditBusy: false, auditResult: { action: action, report: data && data.report, verify: data && data.verify } }, { silent: true });
        return data;
      }).catch(function (err) {
        if (reqId !== api.auditReqId) return null;
        // 宿主 500 的错误原样显示（不吞），并清掉旧结果——否则"新错误配旧结果"会误导
        api.set({ auditBusy: false, auditResult: null, auditErr: true, auditMsg: t("audit.fail") + "：" + errorText(err) }, { silent: true });
        return null;
      });
    },
    /**
     * 「复制诊断包」正文 = 接口给的 report + 一段极简环境信息。
     * 环境信息只由**结构化字段**（root/days/calls/dataDir/log）拼成，不含任何自由文本——
     * 分享层的隐私承诺因此不被这一段破坏（报告本身也已在服务端剔除自由文本）。
     */
    diagPackText: function (data) {
      var d = data && typeof data === "object" ? data : {};
      var report = typeof d.report === "string" ? d.report : "";
      var root = d.root && typeof d.root === "object" ? d.root : {};
      var calls = d.calls && typeof d.calls === "object" ? d.calls : {};
      var dataDir = d.dataDir && typeof d.dataDir === "object" ? d.dataDir : {};
      var log = d.log && typeof d.log === "object" ? d.log : {};
      var days = d.days === void 0 || d.days === null ? api.diagDaysNum() : d.days;
      var lines = [];
      lines.push("");
      lines.push("---- " + t("diag.packTitle") + " ----");
      lines.push(t("diag.envRoot") + "：" + (typeof root.path === "string" && root.path !== "" ? root.path : t("plot.pathUnknown")) + "（" + (root.source || "") + "）");
      lines.push(t("diag.envWindow") + "：" + String(days) + " " + t("diag.daysUnit"));
      lines.push(t("diag.callsTotal") + " " + String(calls.total || 0) + " · " + t("diag.callsDegraded") + " " + String(calls.degraded || 0) + " · " + t("diag.callsFailed") + " " + String(calls.failed || 0));
      if (typeof dataDir.path === "string" && dataDir.path !== "") {
        lines.push(t("diag.envData") + "：" + dataDir.path + (dataDir.exists === true ? "" : "（×）"));
      }
      if (typeof log.dir === "string" && log.dir !== "") lines.push(t("diag.envLog") + "：" + log.dir);
      lines.push(t("diag.privacy"));
      return report + "\n" + lines.join("\n");
    },
    diagCopy: function () {
      var data = api.getSnapshot().diag;
      if (!data || typeof data.report !== "string" || data.report === "") {
        api.set({ revealMsg: t("diag.empty"), revealErr: true }, { silent: true });
        return;
      }
      var ok = function () { api.set({ revealMsg: t("diag.copied"), revealErr: false, diagManual: false }, { silent: true }); };
      // 降级：剪贴板不存在 / 非安全上下文 / 权限被拒 → 不谎报成功，提示用户手动全选报告块
      var fail = function () { api.set({ revealMsg: t("diag.copyFail"), revealErr: true, diagManual: true }, { silent: true }); };
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(api.diagPackText(data)).then(ok, fail);
          return;
        }
      } catch (err) { /* 访问 navigator.clipboard 抛错（权限策略/沙箱）→ 同样走手动复制 */ }
      fail();
    },
    // v4.0.0 修正：导航/分组展开属纯 UI 状态，silent 写入不得自增 rev——否则刷新期间点一下导航，远端开关值会被守卫静默丢弃
    openView: function (view) {
      var prevView = api.getSnapshot().view;
      if (typeof api.closeAllSelects === "function") api.closeAllSelects();
      if (prevView === "trash" && view !== "trash" && typeof api.deleteClose === "function") api.deleteClose();
      if (prevView === "reports" || view === "reports") reportReqId += 1;
      var navPatch = {
        view: view, revealMsg: "", revealErr: false,
        purgeOpen: false, purgeId: "", purgeBook: "", purgeText: "", purgeOk: false,
        packShareOpen: false, packDeleteOpen: false
      };
      if (prevView === "packs-form" && view !== "packs-form") {
        navPatch.packsForm = null;
        navPatch.packsFormDirty = false;
        navPatch.packsFormBind = false;
      }
      api.set(navPatch, { silent: true });
      // v6.2.0：词表页需要现取数据（宿主侧读盘），进入即拉一次
      if (view === "lexicon") api.loadLexicon();
      // 风格基线页的「范围」同样要现取（本书章节列表来自宿主），进入即拉一次
      if (view === "baseline") api.loadBaseline();
      // v7.5.0：题材规则包管理页进入即拉取一次列表与绑定状态
      if (view === "packs") api.loadPacks();
      // v6.6.0：诊断页的报告是现算的（宿主聚合本地日志），进入即拉一次
      if (view === "diagnose") { api.loadDiagnose(); api.loadCaliber(); api.loadAuditBooks(); }
      // v6.8.1：删除页下方常驻回收站，进入即拉一次列表
      if (view === "trash") api.trashLoad();
    },
    setHomeTab: function (tab) {
      var allowed = ["workspace", "ai", "health", "manage"];
      var next = allowed.indexOf(tab) !== -1 ? tab : "workspace";
      if (api.getSnapshot().homeTab === next) return;
      api.set({ homeTab: next }, { silent: true });
    },
    setToolQuery: function (q) { api.set({ toolQuery: String(q || "") }, { silent: true }); },
    setToolGroupOpen: function (patch) { api.set({ toolGroupOpen: Object.assign({}, api.getSnapshot().toolGroupOpen || {}, patch) }, { silent: true }); },
    setAllToolGroupsOpen: function (open) {
      var on = Boolean(open);
      api.setToolGroupOpen({ library: on, writing: on, style: on, story: on, system: on });
    }
  });
}
