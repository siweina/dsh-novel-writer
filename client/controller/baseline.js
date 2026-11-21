function attachBaselineController(api) {
  Object.assign(api, {
    // ---- 风格基线范围（baseline）：与词表同族的数据通道（GET 读 / POST 写） ----
    // 照词表面板的成熟写法：每次请求取递增序号，回调只认最后一次（快切书/快切模式时旧响应不得覆盖新结果）。
    baselineReqId: 0,
    baselineUrl: function () {
      return "/api/dsh-novel-writer/baseline?book=" + encodeURIComponent(api.getSnapshot().baselineBook || "");
    },
    /** 本书全部章节（供选择器渲染），按书序。 */
    baselineAvailable: function () {
      var d = api.getSnapshot().baseline;
      return d && Array.isArray(d.available) ? d.available : [];
    },
    /** 书列表来源与词表面板同源：宿主下发列表优先，否则回退 /state 的 books。 */
    baselineBookOptions: function (data) {
      var s = api.getSnapshot();
      var list = data && Array.isArray(data.books) && data.books.length > 0 ? data.books : (s.books || []);
      var out = [];
      for (var i = 0; i < list.length; i += 1) {
        var b = list[i];
        if (typeof b === "string" && b !== "" && out.indexOf(b) === -1) out.push(b);
      }
      return out;
    },
    /** 待保存的选中章：按书序输出，并顺手丢掉已不在 available 里的失效项（改过名/被删掉的章）。 */
    baselineSelectedFiles: function () {
      var sel = api.getSnapshot().baselineSel;
      var picked = Array.isArray(sel) ? sel : [];
      var avail = api.baselineAvailable();
      var out = [];
      for (var i = 0; i < avail.length; i += 1) {
        var f = avail[i] && avail[i].file;
        if (typeof f === "string" && picked.indexOf(f) !== -1) out.push(f);
      }
      return out;
    },
    /** v7.3.3 修（#5/M4）：把「基线当前书」写进本地偏好——刷新后仍记得上次选择。 */
    persistBaselineBook: function (book) { writeLocalBaselineBook(book || ""); },
    loadBaseline: function () {
      // v7.3.3 修（#5）：**先定下用哪本书再发请求**。旧实现无条件发 `?book=`（空），宿主必然回 400，
      // 于是「首次打开自动选第一本」那句写在成功分支里的逻辑永远走不到（永远先进 catch）。
      var cur = api.getSnapshot();
      var book = cur.baselineBook || "";
      var candidates = api.baselineBookOptions(null);
      // 书库确实为空（首次 /state 已落定、宿主可达、列表就是空的）：连上次记住的书名也作废——
      // 否则会拿一个已经不存在的书去要数据，用户也就看不到「先选择一本书」的引导。
      // loading 期间不这么判：那时 books 还没到，只是"在路上"，不是"没有"。
      var booksGone = candidates.length === 0 && cur.loading !== true && cur.hostOk !== false;
      // v7.3.4 修（④-③）：冷启动时书名是从 localStorage 恢复的，而 /state 还没回来（books 为空），
      // 此时**没有依据**判断这本书还在不在书库。旧实现会直接拿它去发请求，命中一本已被删除的书
      // （后端只好回一条 warning）。这里改成：宁可先不发，等 /state 落定后由补发钩子核对一次。
      var bookUnverifiable = book !== "" && candidates.length === 0 && cur.loading === true;
      if (bookUnverifiable) {
        api.set({ baseline: null, baselineBusy: false, baselineErr: false }, { silent: true });
        return Promise.resolve(null);
      }
      // 上次选的书已不在书库（改名/删除）：退回第一本，别对着不存在的书名继续要数据
      if (book !== "" && (booksGone || (candidates.length > 0 && candidates.indexOf(book) === -1))) {
        book = "";
        api.persistBaselineBook("");
      }
      if (book === "") {
        if (candidates.length === 0) {
          // 真的没有书：不发空 book 的请求（那是必然 400），也不谎称"加载失败"——视图按空态引导选书。
          // 宿主本身就不可达时另说：那是错误，不是"没书"。
          if (cur.hostOk === false) {
            // 宿主不可达：不知道书库空不空，别清掉界面上的书名（本地偏好也保留），只报错
            api.set({ baseline: null, baselineBusy: false, baselineErr: true, revealMsg: t("base.loadFail") + "：" + t("state.unreachable"), revealErr: true }, { silent: true });
          } else {
            api.set({ baselineBook: "", baseline: null, baselineBusy: false, baselineErr: false }, { silent: true });
          }
          return Promise.resolve(null);
        }
        book = candidates[0];
        // 换书 = 换整套基线数据与选中项：旧书的选中项绝不落到新书（与 setBaselineBook 同一口径）
        api.set({ baselineBook: book, baseline: null, baselineMode: "all", baselineSel: [], baselineMissing: [], baselineShowAll: false }, { silent: true });
        api.persistBaselineBook(book);
      }
      var reqId = (api.baselineReqId += 1);
      api.set({ baselineBusy: true, baselineErr: false }, { silent: true });
      return fetchWithTimeout(api.baselineUrl(), { headers: { accept: "application/json" } }).then(function (r) {
        if (r.ok) return r.json();
        return r.json().catch(function () { return {}; }).then(function (d) {
          throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r.status);
        });
      }).then(function (data) {
        if (reqId !== api.baselineReqId) return null; // 已有更新的请求发出：丢弃过期响应
        var s = api.getSnapshot();
        // 兜底：请求前已把书定好（见 loadBaseline 开头），这里只在响应书名与快照不同步时换一次
        var books = api.baselineBookOptions(data);
        var nextBook = s.baselineBook || (data && data.book) || (books.length > 0 ? books[0] : "");
        if (nextBook !== s.baselineBook) {
          api.set({ baselineBook: nextBook || "", baselineBusy: false }, { silent: true });
          return api.loadBaseline();
        }
        var avail = data && Array.isArray(data.available) ? data.available : [];
        var have = {};
        for (var i = 0; i < avail.length; i += 1) {
          var af = avail[i] && avail[i].file;
          if (typeof af === "string" && af !== "") have[af] = true;
        }
        // 已存章节里挑出「不在本书章节列表中」的失效项（改名/删除）：只提示，不塞回选中集合
        var stored = data && Array.isArray(data.chapters) ? data.chapters : [];
        var kept = [];
        var lost = [];
        for (var j = 0; j < stored.length; j += 1) {
          var sf = stored[j];
          if (typeof sf !== "string" || sf === "") continue;
          if (have[sf]) { if (kept.indexOf(sf) === -1) kept.push(sf); }
          else if (lost.indexOf(sf) === -1) lost.push(sf);
        }
        api.set({
          baseline: data,
          baselineMode: data && data.mode === "custom" ? "custom" : "all",
          baselineSel: kept,
          baselineMissing: lost,
          baselineBusy: false
        }, { silent: true });
        return data;
      }).catch(function (err) {
        if (reqId !== api.baselineReqId) return null; // 过期请求的失败同样不覆盖新结果与新提示
        api.set({ baselineBusy: false, baselineErr: true, revealMsg: t("base.loadFail") + "：" + errorText(err), revealErr: true }, { silent: true });
        return null;
      });
    },
    /** 宿主里**已保存**的标杆章（与生效档位无关：mode != custom 时服务端刻意不动 chapters，故这里可能非空而档位是 all）。 */
    baselineStoredFiles: function () {
      var d = api.getSnapshot().baseline;
      if (!d || !Array.isArray(d.chapters)) return [];
      var out = [];
      for (var i = 0; i < d.chapters.length; i += 1) {
        if (typeof d.chapters[i] === "string" && d.chapters[i] !== "") out.push(d.chapters[i]);
      }
      return out;
    },
    /**
     * 清空已保存的标杆章。**唯一能真正清空的写法是 `mode:"custom"` + `chapters:[]`**：
     * 服务端的 PATCH 语义是「mode != custom 时不动 chapters」（切到按全书 = 这次不用，而不是删掉），
     * 所以发 `{mode:"all", chapters:[]}` 什么也清不掉。
     * 清空后服务端会回报**生效档位 `all`**（实际行为就是按全书），面板据此显示「按全书」并让已选归零——
     * 不因为 mode 变回 all 就把本地选择填回去（baselineSel 只由 chapters 派生）。
     */
    baselineClearSaved: function () {
      var s = api.getSnapshot();
      var book = s.baselineBook || "";
      if (book === "") {
        api.set({ revealMsg: t("base.needBook"), revealErr: true }, { silent: true });
        return Promise.resolve(null);
      }
      if (api.baselineStoredFiles().length === 0) return Promise.resolve(null); // 本来就没存量：不是错误，静默不动作
      if (!safeConfirm(String(t("base.confirmClear")))) return Promise.resolve(null);
      return api.baselinePost({ book: book, mode: "custom", chapters: [] }, "base.clearFail").then(function (data) {
        if (data) api.set({ revealMsg: t("base.cleared"), revealErr: false }, { silent: true });
        return data;
      });
    },
    baselinePost: function (body, failKey) {
      api.set({ baselineBusy: true, baselineErr: false }, { silent: true });
      return fetchWithTimeout("/api/dsh-novel-writer/baseline", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body)
      }).then(function (r) {
        if (r.ok) return r.json();
        return r.json().catch(function () { return {}; }).then(function (d) {
          throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r.status);
        });
      }).then(function (data) {
        return api.loadBaseline().then(function () { return data; });
      }).catch(function (err) {
        api.set({ baselineBusy: false, baselineErr: true, revealMsg: t(failKey || "base.saveFail") + "：" + errorText(err), revealErr: true }, { silent: true });
        return null;
      });
    },
    setBaselineBook: function (book) {
      var next = book || "";
      if (next === (api.getSnapshot().baselineBook || "")) return;
      // v7.3.3 修（#5/M4）：用户选定的书立刻写进本地偏好——否则刷新后又变回空书名（再发空 book 的 400 请求）
      api.persistBaselineBook(next);
      // 换书 = 换整套基线数据与选中项：先清空，等 GET 回来重填（旧书的选中项绝不落到新书）
      api.set({ baselineBook: next, baseline: null, baselineMode: "all", baselineSel: [], baselineMissing: [], baselineShowAll: false }, { silent: true });
      api.loadBaseline();
    },
    /** 范围模式只是本地草稿，点了保存才写盘（避免误点分段控件就把配置改掉）。 */
    setBaselineMode: function (mode) {
      var next = mode === "custom" ? "custom" : "all";
      if (api.getSnapshot().baselineMode === next) return;
      api.set({ baselineMode: next }, { silent: true });
    },
    baselineToggleChapter: function (file) {
      if (typeof file !== "string" || file === "") return;
      var cur = api.getSnapshot().baselineSel;
      var sel = Array.isArray(cur) ? cur.slice() : [];
      var at = sel.indexOf(file);
      if (at >= 0) sel.splice(at, 1); else sel.push(file);
      api.set({ baselineSel: sel }, { silent: true });
    },
    baselineSelectAll: function () {
      var avail = api.baselineAvailable();
      var out = [];
      for (var i = 0; i < avail.length; i += 1) {
        var f = avail[i] && avail[i].file;
        if (typeof f === "string" && f !== "") out.push(f);
      }
      api.set({ baselineSel: out }, { silent: true });
    },
    baselineClearSel: function () { api.set({ baselineSel: [] }, { silent: true }); },
    baselineInvertSel: function () {
      var picked = api.getSnapshot().baselineSel;
      var sel = Array.isArray(picked) ? picked : [];
      var avail = api.baselineAvailable();
      var out = [];
      for (var i = 0; i < avail.length; i += 1) {
        var f = avail[i] && avail[i].file;
        if (typeof f !== "string" || f === "") continue;
        if (sel.indexOf(f) === -1) out.push(f);
      }
      api.set({ baselineSel: out }, { silent: true });
    },
    /** 章节很多的本书：列表默认只渲染前若干章，用户显式展开后再全量渲染。 */
    baselineExpandList: function () { api.set({ baselineShowAll: true }, { silent: true }); },
    baselineSave: function () {
      var s = api.getSnapshot();
      var book = s.baselineBook || "";
      if (book === "") {
        api.set({ revealMsg: t("base.needBook"), revealErr: true }, { silent: true });
        return Promise.resolve(null);
      }
      var mode = s.baselineMode === "custom" ? "custom" : "all";
      var chapters = mode === "custom" ? api.baselineSelectedFiles() : [];
      if (mode === "custom" && chapters.length === 0) {
        // 空选择不是"清空"：清空走 baselineClearSaved（显式按钮 + 二次确认），
        // 这里拒绝并指路，免得用户以为"取消全部勾选再保存"就等于把存量清掉了
        // （服务端 mode != custom 时不动 chapters，所以切按全书保存也清不掉）。
        api.set({ revealMsg: t("base.needCustom"), revealErr: true }, { silent: true });
        return Promise.resolve(null);
      }
      return api.baselinePost({ book: book, mode: mode, chapters: chapters }).then(function (data) {
        if (data) api.set({ revealMsg: t("base.saved"), revealErr: false }, { silent: true });
        return data;
      });
    }
  });
}
