function attachLexiconController(api) {
  Object.assign(api, {
    // ---- v6.2.0 必用词表（lexicon）：面板数据通道（GET 读 / POST 写，全部走宿主同一套归一与合并逻辑）----
    // v6.2.0 修复：作用层/当前书快切时旧响应会覆盖新结果——每次请求取递增序号，回调只认最后一次
    lexiconReqId: 0,
    lexiconUrl: function () {
      var s = api.getSnapshot();
      return "/api/dsh-novel-writer/lexicon?book=" + encodeURIComponent(s.lexiconBook || "") +
        "&scope=" + encodeURIComponent(s.lexiconScope || "all");
    },
    loadLexicon: function () {
      var reqId = (api.lexiconReqId += 1);
      api.set({ lexiconBusy: true, lexiconErr: false }, { silent: true });
      return fetchWithTimeout(api.lexiconUrl(), { headers: { accept: "application/json" } }).then(function (r) {
        if (r.ok) return r.json();
        return r.json().catch(function () { return {}; }).then(function (d) {
          throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r.status);
        });
      }).then(function (data) {
        if (reqId !== api.lexiconReqId) return null; // 已有更新的请求发出：丢弃本次过期响应，别覆盖新层数据
        var s = api.getSnapshot();
        // 首次打开时自动选一本书（合并/本书层需要一个书名）；选完再拉一次，避免"空书名只看到全局层"
        var nextBook = s.lexiconBook || data.book || (Array.isArray(data.books) && data.books.length > 0 ? data.books[0] : "");
        var needReload = nextBook !== "" && nextBook !== s.lexiconBook;
        api.set({ lexicon: data, lexiconBook: nextBook, lexiconBusy: false }, { silent: true });
        return needReload ? api.loadLexicon() : data;
      }).catch(function (err) {
        if (reqId !== api.lexiconReqId) return null; // 过期请求的失败同样不要覆盖新结果与新提示
        api.set({ lexiconBusy: false, lexiconErr: true, revealMsg: t("lex.loadFail") + "：" + errorText(err), revealErr: true }, { silent: true });
        return null;
      });
    },
    lexiconPost: function (body) {
      api.set({ lexiconBusy: true, lexiconErr: false }, { silent: true });
      return fetchWithTimeout("/api/dsh-novel-writer/lexicon", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body)
      }).then(function (r) {
        if (r.ok) return r.json();
        return r.json().catch(function () { return {}; }).then(function (d) {
          throw new Error(d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + r.status);
        });
      }).then(function (data) {
        return api.loadLexicon().then(function () { return data; });
      }).catch(function (err) {
        api.set({ lexiconBusy: false, lexiconErr: true, revealMsg: t("lex.saveFail") + "：" + errorText(err), revealErr: true }, { silent: true });
        return null;
      });
    },
    setLexiconScope: function (scope) {
      var next = scope === "global" ? "global" : scope === "book" ? "book" : "all";
      // v6.2.0 修复：切作用层会静默改变「写入层」，留着草稿会让词条落到非预期层 → 切层即清空表单
      // #31：切层先置 lexicon: null, lexiconErr: false，避免新层加载延迟或失败时仍渲染/误存旧层词条
      api.set({ lexiconScope: next, lexicon: null, lexiconErr: false, lexiconForm: null }, { silent: true });
      api.loadLexicon();
    },
    setLexiconBook: function (book) {
      // 同理：换书即换了写入目标，草稿与已加载词条不再属于当前书
      api.set({ lexiconBook: book || "", lexicon: null, lexiconErr: false, lexiconForm: null }, { silent: true });
      api.loadLexicon();
    },
    setLexiconSearch: function (text) { api.set({ lexiconQuery: text || "" }, { silent: true }); },
    setLexiconForm: function (patch) {
      var current = api.getSnapshot().lexiconForm || { term: "", kind: "专名", scene: "", avoid: "", note: "", editing: "" };
      api.set({ lexiconForm: Object.assign({}, current, patch) }, { silent: true });
    },
    lexiconResetForm: function () { api.set({ lexiconForm: null }, { silent: true }); },
    lexiconToggleImport: function () { api.set({ lexiconImportOpen: !api.getSnapshot().lexiconImportOpen }, { silent: true }); },
    setLexiconImport: function (text) { api.set({ lexiconImportText: text || "" }, { silent: true }); },
    /** 写入层：scope=global 写全局层，其余（含合并视图）一律写本书层——合并视图只做总览，编辑按钮只出现在写入层条目上。 */
    lexiconWriteLayer: function () { return api.getSnapshot().lexiconScope === "global" ? "global" : "book"; },
    lexiconWriteEntries: function () {
      var s = api.getSnapshot();
      var layer = api.lexiconWriteLayer();
      var all = s.lexicon && Array.isArray(s.lexicon.entries) ? s.lexicon.entries : [];
      return all.filter(function (e) { return (e.scope || "book") === layer; });
    },
    /** v6.3.0：core 现在会显式回报「该层词表文件损坏」。目标层损坏时，写操作默认被 core 拒绝，
     *  必须由用户确认后带 force（toggle）/ overwrite（save/import）才允许丢弃原内容重建。 */
    lexiconLayerCorrupt: function () {
      var data = api.getSnapshot().lexicon || {};
      return data.corrupt === true || (Array.isArray(data.corruptFiles) && data.corruptFiles.length > 0);
    },
    lexiconConfirmCorrupt: function () {
      return safeConfirm(String(t("lex.corruptConfirm")));
    },
    lexiconSaveEntries: function (entries, okMsg) {
      var s = api.getSnapshot();
      var corrupt = api.lexiconLayerCorrupt();
      if (corrupt && !api.lexiconConfirmCorrupt()) return Promise.resolve(null);
      var body = { op: "save", scope: api.lexiconWriteLayer(), book: s.lexiconBook || "", entries: entries };
      if (corrupt) body.overwrite = true;
      return api.lexiconPost(body)
        .then(function (data) {
          if (data) api.set({ revealMsg: okMsg || t("lex.saved"), revealErr: false }, { silent: true });
          return data;
        });
    },
    lexiconSubmitForm: function () {
      var s = api.getSnapshot();
      var form = s.lexiconForm || {};
      var term = String(form.term || "").trim();
      if (term === "") {
        api.set({ revealMsg: t("lex.needTerm"), revealErr: true }, { silent: true });
        return;
      }
      var entry = { term: term };
      if (String(form.kind || "").trim() !== "") entry.kind = String(form.kind).trim();
      if (String(form.scene || "").trim() !== "") entry.scene = String(form.scene).trim();
      if (String(form.note || "").trim() !== "") entry.note = String(form.note).trim();
      var avoid = String(form.avoid || "").split(/[,，、]/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ""; });
      if (avoid.length > 0) entry.avoid = avoid;
      var base = api.lexiconWriteEntries().slice();
      var editing = String(form.editing || "");
      var at = -1;
      for (var i = 0; i < base.length; i += 1) { if (base[i].term === (editing !== "" ? editing : term)) { at = i; break; } }
      if (at >= 0) {
        // v6.2.0 修复：表单只展示 term/kind/scene/avoid/note，其余字段（aliases/priority/enabled）
        // 此前被整条重建时静默丢弃——改成以原条目为底，只覆盖表单拥有的字段，其余原样保留。
        var merged = Object.assign({}, base[at]);
        merged.term = term;
        if (entry.kind) merged.kind = entry.kind; else delete merged.kind;
        if (entry.scene) merged.scene = entry.scene; else delete merged.scene;
        if (entry.note) merged.note = entry.note; else delete merged.note;
        if (entry.avoid) merged.avoid = entry.avoid; else delete merged.avoid;
        base[at] = merged;
      } else base.push(entry);
      return api.lexiconSaveEntries(base, t("lex.saved") + "：" + term).then(function (data) {
        if (data) api.lexiconResetForm();
        return data;
      });
    },
    lexiconEditEntry: function (term, scope) {
      var s = api.getSnapshot();
      var all = s.lexicon && Array.isArray(s.lexicon.entries) ? s.lexicon.entries : [];
      // v6.2.0 修复：合并视图下同名条目以书级为准，只按 term 匹配可能取到另一层的字段 → 用 term+scope 唯一定位
      var wantScope = scope === "global" ? "global" : "book";
      var found = null;
      for (var i = 0; i < all.length; i += 1) {
        if (all[i].term === term && (all[i].scope || "book") === wantScope) { found = all[i]; break; }
      }
      if (!found) for (var j = 0; j < all.length; j += 1) { if (all[j].term === term) { found = all[j]; break; } }
      api.set({ lexiconForm: {
        term: term,
        kind: found && found.kind ? found.kind : "专名",
        scene: found && found.scene ? found.scene : "",
        avoid: found && Array.isArray(found.avoid) ? found.avoid.join(",") : "",
        note: found && found.note ? found.note : "",
        editing: term
      } }, { silent: true });
    },
    lexiconDeleteEntry: function (term) {
      var label = String(t("lex.confirmDelete")).replace("{term}", String(term));
      if (!safeConfirm(label)) return;
      var base = api.lexiconWriteEntries().filter(function (e) { return e.term !== term; });
      api.lexiconSaveEntries(base, t("lex.saved"));
    },
    lexiconRunImport: function (replace) {
      var s = api.getSnapshot();
      var text = String(s.lexiconImportText || "");
      if (text.trim() === "") {
        api.set({ revealMsg: t("lex.needTerm"), revealErr: true }, { silent: true });
        return;
      }
      if (replace === true && !safeConfirm(String(t("lex.confirmReplace")))) return;
      var corrupt = api.lexiconLayerCorrupt();
      if (corrupt && !api.lexiconConfirmCorrupt()) return;
      var body = { op: "import", scope: api.lexiconWriteLayer(), book: s.lexiconBook || "", text: text, replace: replace === true };
      if (corrupt) body.overwrite = true;
      api.lexiconPost(body)
        .then(function (data) { if (data) api.set({ lexiconImportText: "" }, { silent: true }); });
    },
    lexiconToggleLayer: function (enabled) {
      var s = api.getSnapshot();
      var corrupt = api.lexiconLayerCorrupt();
      if (corrupt && !api.lexiconConfirmCorrupt()) return;
      var body = { op: "toggle", scope: api.lexiconWriteLayer(), book: s.lexiconBook || "", enabled: !!enabled };
      if (corrupt) body.force = true;
      api.lexiconPost(body);
    }
  });
}
