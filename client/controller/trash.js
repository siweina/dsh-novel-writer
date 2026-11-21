function attachTrashController(api, ctrlCtx) {
  // v6.8.0：报告列表加载的陈旧响应序号（模块级闭包变量在每次渲染归零，所以放在控制器作用域）
  var reportsLoadSeq = 0;
  Object.assign(api, {
    rawToggle: function (wantOn) {
      if (!wantOn) {
        if (rawTimer) { clearInterval(rawTimer); rawTimer = null; }
        var toggleRef = ctrlCtx.getToggle();
        if (toggleRef) toggleRef({ features: { rawWriting: false } });
        api.set({ rawModal: false, rawCountdown: 0, rawPromiseOpen: false, rawPromiseText: "", rawPromiseOk: false }, { silent: true });
        return;
      }
      api.set({ rawModal: true, rawCountdown: 3, rawPromiseOpen: false, rawPromiseText: "", rawPromiseOk: false }, { silent: true });
      // v3.5.0 #43：timer 存模块级引用，取消/确认时统一清理（防双定时器竞争）
      if (rawTimer) clearInterval(rawTimer);
      rawTimer = setInterval(function () {
        var n = api.getSnapshot().rawCountdown - 1;
        if (n <= 0) { clearInterval(rawTimer); rawTimer = null; api.set({ rawCountdown: 0 }, { silent: true }); }
        else api.set({ rawCountdown: n }, { silent: true });
      }, 1000);
    },
    rawConfirm: function () {
      var s = api.getSnapshot();
      if (!s.rawModal || s.rawCountdown > 0) return;
      if (rawTimer) { clearInterval(rawTimer); rawTimer = null; }
      api.set({ rawModal: false, rawPromiseOpen: true, rawPromiseText: "", rawPromiseOk: false }, { silent: true });
    },
    rawCancel: function () { if (rawTimer) { clearInterval(rawTimer); rawTimer = null; } api.set({ rawModal: false, rawCountdown: 0, rawPromiseOpen: false, rawPromiseText: "", rawPromiseOk: false }, { silent: true }); },
    rawSetPromise: function (text) {
      // v3.5.0 #36：按当前语言校验（中文"绝不传播" / 英文"never distribute"）
      // v4.3.0：语言判定改用 isEnglish()（locale 服务优先）
      var isEn = isEnglish();
      var kw = isEn ? "never distribute" : "绝不传播";
      // v6.3.0 修复：长度阈值原先写死 5，而中文关键词「绝不传播」只有 4 个字——用户严格照提示只输入这
      // 4 个字时关键词判定通过、长度判定失败，确认按钮（disabled: !rawPromiseOk）永远点不动且无任何反馈。
      // 改为与关键词长度对齐（英文 "never distribute" 16 字，同样满足）。
      var ok = String(text || "").toLowerCase().indexOf(kw) !== -1 && String(text || "").trim().length >= kw.length;
      api.set({ rawPromiseText: text || "", rawPromiseOk: ok }, { silent: true });
    },
    rawPromiseConfirm: function () {
      if (!api.getSnapshot().rawPromiseOk) return;
      if (rawTimer) { clearInterval(rawTimer); rawTimer = null; }
      var toggleRef = ctrlCtx.getToggle();
      if (toggleRef) toggleRef({ features: { rawWriting: true } });
      api.set({ rawPromiseOpen: false, rawPromiseText: "", rawPromiseOk: false, rawModal: false, rawCountdown: 0 }, { silent: true });
    },
    // ---- v6.8.0：按书删除 + 回收站（宿主端与 novel_delete_book 同一实现） ----
    // v6.8.1：入口从"藏在书库折叠区里的弹窗"改成**独立页面**（用户实测找不到按钮）。
    // 页面内联预览，书库行上的按钮仍走弹窗；两者的加载与陈旧响应守卫共用 loadDeletePlan。
    /** 书库行快捷入口（弹窗） */
    deleteOpen: function (book) { return loadDeletePlan(book, true); },
    /** 删除页内选中一本书（页面内联） */
    deletePick: function (book) { return loadDeletePlan(book, false); },
    deleteClose: function () {
      // 作废在途预览：关掉/返回后迟到的响应不该把内容又填回来
      api.set({ delReqId: (api.getSnapshot().delReqId || 0) + 1, delOpen: false, delBook: "", delPlan: null, delResult: null, delLoading: false, delError: "", delAck: false, delBusy: false }, { silent: true });
    },
    deleteAck: function (value) { api.set({ delAck: value === true }, { silent: true }); },
    /** 勾/取消某一处（全选时等于原来的"删整本书"，取消到只剩报告类就变成"只清报告"） */
    deleteToggleKey: function (key, on) {
      var sel = Object.assign({}, api.getSnapshot().delSel || {});
      if (on === true) sel[key] = true; else delete sel[key];
      api.set({ delSel: sel, delAck: false }, { silent: true });
    },
    deleteSelectAll: function (on) {
      var plan = api.getSnapshot().delPlan;
      var sel = {};
      if (on === true && plan) (plan.targets || []).forEach(function (t) { if (isPickableDeleteTarget(t)) sel[t.key] = true; });
      api.set({ delSel: sel, delAck: false }, { silent: true });
    },
    deleteApply: function () {
      var snapshot = api.getSnapshot();
      var keys = Object.keys(snapshot.delSel || {}).filter(function (k) { return snapshot.delSel[k] === true; });
      if (snapshot.delAck !== true || snapshot.delBusy || snapshot.delBook === "" || keys.length === 0) return Promise.resolve(null);
      var reqId = (snapshot.delReqId || 0) + 1;
      api.set({ delReqId: reqId, delBusy: true, delError: "" }, { silent: true });
      return deleteBookRoute({ action: "apply", book: snapshot.delBook, keys: keys }).then(function (data) {
        // 正文与资料已移走：书库统计 / 书列表 / 报告目录都变了，静默刷新一次；
        // 回收站里同时多了一条，页面的回收站小节要跟着更新
        api.refresh();
        api.trashLoad();
        if (api.getSnapshot().delReqId !== reqId) return data;
        api.set({ delBusy: false, delResult: data }, { silent: true });
        return data;
      }).catch(function (err) {
        if (api.getSnapshot().delReqId !== reqId) return null;
        api.set({ delBusy: false, delError: errorText(err) }, { silent: true });
        return null;
      });
    },
    /** 拉回收站列表（删除页的「回收站」小节；不再开弹窗） */
    // v7.3.1 修（#83）：加陈旧响应序号——进入页加载与恢复/删除后的重列交错时，旧快照不得覆盖新列表
    trashLoadSeq: 0,
    trashLoad: function () {
      var seq = (api.trashLoadSeq += 1);
      api.set({ trashLoading: true, trashError: "", trashNote: "" }, { silent: true });
      return deleteBookRoute({ action: "list" }).then(function (data) {
        // v7.3.2 修（N4）：过期响应被丢弃时也必须结束"加载中"——作废的在途加载若自己不复位，
        // 提示会一直常驻到重新进页（最多让此时更新的在途请求瞬时少一次提示，它会在自己的响应里落定）
        if (seq !== api.trashLoadSeq) { api.set({ trashLoading: false }, { silent: true }); return null; }
        var list = data && Array.isArray(data.trash) ? data.trash : [];
        api.set({ trashList: list, trashLoading: false }, { silent: true });
        return list;
      }).catch(function (err) {
        if (seq !== api.trashLoadSeq) { api.set({ trashLoading: false }, { silent: true }); return null; } // 过期请求的失败同样不覆盖新结果
        api.set({ trashLoading: false, trashList: null, trashError: errorText(err) }, { silent: true });
        return null;
      });
    },
    /** 恢复：成功后重列一次（清单可能整条消失），并刷新书库统计。 */
    trashRestore: function (id) {
      var entryId = String(id || "");
      if (entryId === "" || api.getSnapshot().trashBusyId !== "") return Promise.resolve(null);
      api.set({ trashBusyId: entryId, trashNote: "", trashError: "" }, { silent: true });
      // v7.3.2 修（N4）：seq 在**发起时**就 bump（旧实现在重列响应到达时才 +1）——这样"作废在途加载"的
      // 时机与恢复/删除发起一致，且不会把重列在途期间新发起的 trashLoad 误作废（列表停在旧快照）。
      var seq = (api.trashLoadSeq += 1);
      return deleteBookRoute({ action: "restore", trashId: entryId }).then(function (data) {
        var note = String(t("trash.restored")).replace("{n}", String((data && data.restored) || 0));
        if (data && Array.isArray(data.conflicts) && data.conflicts.length > 0) {
          note += "；" + String(t("trash.conflict")).replace("{n}", String(data.conflicts.length));
        }
        return deleteBookRoute({ action: "list" }).then(function (next) {
          // v7.3.2 修（N4）：重列同样要落定加载态（旧实现从不写 trashLoading:false → 「加载中」常驻）；
          // 且只有期间没有更新的列表请求（seq 未变）才用它覆盖，否则会把新快照盖回旧列表。
          var fresh = seq === api.trashLoadSeq;
          api.set({ trashBusyId: "", trashLoading: false, trashList: fresh && next && Array.isArray(next.trash) ? next.trash : api.getSnapshot().trashList, trashNote: note }, { silent: true });
          api.refresh();
          return data;
        }, function (listErr) {
          api.set({ trashBusyId: "", trashLoading: false, trashNote: note, trashError: errorText(listErr) }, { silent: true });
          api.refresh();
          return data;
        });
      }).catch(function (err) {
        api.set({ trashBusyId: "", trashError: errorText(err) }, { silent: true });
        return null;
      });
    },
    /** 彻底删除（不可撤销）：打开面板内建显式书名输入确认框，不走沙箱 webview 可能拦截/绕过的 safeConfirm。 */
    trashPurge: function (id, book) {
      var entryId = String(id || "");
      var snap = api.getSnapshot();
      if (entryId === "" || snap.trashBusyId !== "") return Promise.resolve(null);
      var target = String(book || "").trim();
      if (target === "" && Array.isArray(snap.trashList)) {
        for (var ti = 0; ti < snap.trashList.length; ti += 1) {
          if (snap.trashList[ti] && snap.trashList[ti].id === entryId) {
            target = String(snap.trashList[ti].book || "").trim();
            break;
          }
        }
      }
      if (target === "") target = entryId;
      api.set({ purgeOpen: true, purgeId: entryId, purgeBook: target, purgeText: "", purgeOk: false }, { silent: true });
      return Promise.resolve(null);
    },
    trashPurgeSetText: function (text) {
      var val = String(text || "");
      var expected = String(api.getSnapshot().purgeBook || "");
      var ok = expected !== "" && val.trim() === expected;
      api.set({ purgeText: val, purgeOk: ok }, { silent: true });
    },
    trashPurgeCancel: function () {
      api.set({ purgeOpen: false, purgeId: "", purgeBook: "", purgeText: "", purgeOk: false }, { silent: true });
    },
    trashPurgeConfirm: function () {
      var snap = api.getSnapshot();
      if (!snap.purgeOpen || !snap.purgeOk || snap.purgeId === "" || snap.trashBusyId !== "") return Promise.resolve(null);
      var entryId = snap.purgeId;
      api.set({ purgeOpen: false, purgeId: "", purgeBook: "", purgeText: "", purgeOk: false, trashBusyId: entryId, trashNote: "", trashError: "" }, { silent: true });
      // v7.3.2 修（N4）：彻底删除同样在发起时就 bump seq（理由同上：作废时机提前、不误伤新发起的 trashLoad）
      var seq = (api.trashLoadSeq += 1);
      return deleteBookRoute({ action: "purge", trashId: entryId }).then(function (data) {
        return deleteBookRoute({ action: "list" }).then(function (next) {
          // v7.3.2 修（N4）：重列落定加载态，且 seq 未变才覆盖（期间有更新的列表请求则保留它的结果）
          var fresh = seq === api.trashLoadSeq;
          api.set({ trashBusyId: "", trashLoading: false, trashList: fresh && next && Array.isArray(next.trash) ? next.trash : api.getSnapshot().trashList, trashNote: t("trash.purged") }, { silent: true });
          return data;
        }, function (listErr) {
          api.set({ trashBusyId: "", trashLoading: false, trashNote: t("trash.purged"), trashError: errorText(listErr) }, { silent: true });
          return data;
        });
      }).catch(function (err) {
        api.set({ trashBusyId: "", trashError: errorText(err) }, { silent: true });
        return null;
      });
    },
    /** 报告历史：拉取分组列表（进入视图 / 删除后重拉都走它） */
    loadReports: function () {
      var seq = (reportsLoadSeq += 1);
      return fetchReports().then(function (data) {
        if (seq !== reportsLoadSeq) return null; // 过期响应丢弃（与报告正文读取同一口径）
        api.set({ reportsGroups: Array.isArray(data.groups) ? data.groups : [], reportsError: false }, { silent: true });
        return data;
      }).catch(function (err) {
        if (seq !== reportsLoadSeq) return null;
        // 失败不伪装成"暂无报告"（空数组会让视图显示空态，与"读取失败"混淆）
        api.set({ reportsGroups: null, reportsError: true, revealMsg: t("reports.readFail") + "：" + errorText(err), revealErr: true }, { silent: true });
        return null;
      });
    },
    /**
     * 单份报告移入回收站（v6.8.0）。为什么不是直接 rm：`style-reports/<书>.json` 里可能存着
     * AI 回传并保存的风格判断，删掉就真没了——所以与删书共用同一套回收站，可恢复。
     */
    deleteReport: function (file) {
      var name = String(file || "");
      if (name === "") return Promise.resolve(null);
      if (!safeConfirm(String(t("reports.deleteAsk")).replace("{file}", name))) return Promise.resolve(null);
      reportReqId += 1;
      api.set({ reportDeleting: name }, { silent: true });
      return forgetReport(name).then(function (data) {
        reportReqId += 1;
        api.set({ reportDeleting: "", reportContent: null, revealMsg: String(t("reports.deleted")).replace("{file}", name), revealErr: false }, { silent: true });
        api.loadReports();
        api.trashLoad(); // 回收站多了一条：删除页那一块要能立刻看到并恢复
        return data;
      }).catch(function (err) {
        api.set({ reportDeleting: "", revealMsg: t("reports.deleteFail") + "：" + errorText(err), revealErr: true }, { silent: true });
        return null;
      });
    }
  });
  /**
   * 取某本书的删除预览——书库行按钮（弹窗）与删除页（内联）**共用**这一份。
   * 预览用 delReqId 做陈旧响应守卫（与 reports/fix-plan 同一口径）：连点两本书时，
   * 先发后到的旧响应不得把清单覆盖成另一本书的内容——那正是"删错书"最可能的入口。
   */
  function loadDeletePlan(book, modal) {
    var bookName = String(book || "");
    var reqId = (api.getSnapshot().delReqId || 0) + 1;
    api.set({ delOpen: modal === true, delBook: bookName, delPlan: null, delLoading: true, delError: "", delAck: false, delBusy: false, delResult: null, delReqId: reqId, delSel: {} }, { silent: true });
    return deleteBookRoute({ action: "preview", book: bookName }).then(function (data) {
      if (api.getSnapshot().delReqId !== reqId) return null;
      // 默认全选＝"删整本书"（既有行为）；用户取消勾选即变成"只清这一类"
      var sel = {};
      if (data && Array.isArray(data.targets)) {
        data.targets.forEach(function (t) { if (isPickableDeleteTarget(t)) sel[t.key] = true; });
      }
      api.set({ delPlan: data, delLoading: false, delSel: sel }, { silent: true });
      return data;
    }).catch(function (err) {
      if (api.getSnapshot().delReqId !== reqId) return null;
      api.set({ delLoading: false, delError: errorText(err) }, { silent: true });
      return null;
    });
  }
}
