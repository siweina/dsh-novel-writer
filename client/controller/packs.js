function attachPacksController(api) {
  Object.assign(api, {
    // ---- v7.5.0：外置 JSON 题材规则包（GET 列包 / POST 绑定或解绑）----
    packsReqId: 0,
    packsImportReqId: 0,
    loadPacks: function (bookOverride) {
      var cur = api.getSnapshot();
      var book = bookOverride !== void 0 ? String(bookOverride || "") : (cur.packsBook || cur.baselineBook || (Array.isArray(cur.books) && cur.books[0]) || "");
      var reqId = (api.packsReqId += 1);
      api.set({ packsBusy: true, packsErr: false }, { silent: true });
      var url = PACKS_ROUTE + (book ? "?book=" + encodeURIComponent(book) : "");
      return fetchWithTimeout(url, { headers: { accept: "application/json" } }).then(function (r) {
        if (r.ok) return r.json();
        return hostError(r).then(function (err) { throw err; });
      }).then(function (data) {
        if (reqId !== api.packsReqId) return null;
        var resolvedBook = (data && typeof data.book === "string" && data.book !== "")
          ? data.book
          : (book || (data && Array.isArray(data.books) && data.books.length > 0 ? data.books[0] : ""));
        api.set({ packsData: data, packsBook: resolvedBook, packsBusy: false, packsErr: false }, { silent: true });
        if (book === "" && resolvedBook !== "" && bookOverride === void 0) {
          return api.loadPacks(resolvedBook);
        }
        return data;
      }).catch(function (err) {
        if (reqId !== api.packsReqId) return null;
        api.set({ packsBusy: false, packsErr: true, packsMsg: t("packs.loadFail") + "：" + errorText(err) }, { silent: true });
        return null;
      });
    },
    setPacksBook: function (book) {
      var next = String(book || "");
      api.set({ packsBook: next, packsMsg: "", packsErr: false }, { silent: true });
      return api.loadPacks(next);
    },
    bindPack: function (packId) {
      var cur = api.getSnapshot();
      var book = String(cur.packsBook || "").trim();
      if (book === "") {
        api.set({ packsBusy: false, packsErr: true, packsMsg: t("packs.needBook") }, { silent: true });
        return Promise.resolve(null);
      }
      var nextPack = packId ? String(packId).trim() : "";
      var reqId = (api.packsReqId += 1);
      api.set({ packsBusy: true, packsErr: false, packsMsg: "" }, { silent: true });
      return fetchWithTimeout(PACKS_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ book: book, pack: nextPack })
      }).then(function (r) {
        if (r.ok) return r.json();
        return hostError(r).then(function (err) { throw err; });
      }).then(function (data) {
        if (reqId !== api.packsReqId) return null;
        api.set({
          packsData: data,
          packsBook: (data && typeof data.book === "string" && data.book !== "") ? data.book : book,
          packsBusy: false,
          packsErr: false,
          packsMsg: nextPack ? t("packs.bound") : t("packs.unbound")
        }, { silent: true });
        return data;
      }).catch(function (err) {
        if (reqId !== api.packsReqId) return null;
        api.set({ packsBusy: false, packsErr: true, packsMsg: t("packs.bindFail") + "：" + errorText(err) }, { silent: true });
        return null;
      });
    },
    resolvePackSource: function (packIdOrObj) {
      if (packIdOrObj && typeof packIdOrObj === "object") {
        if (typeof packIdOrObj.bannedLines === "string" || typeof packIdOrObj.editing === "boolean") {
          return buildClientPackObject(packIdOrObj);
        }
        return toClientSerializablePack(packIdOrObj);
      }
      var id = String(packIdOrObj || "").trim();
      if (id === "") return null;
      var cur = api.getSnapshot();
      var data = cur.packsData;
      if (data && data.rawPacks && data.rawPacks[id]) return toClientSerializablePack(data.rawPacks[id]);
      var list = data && Array.isArray(data.packs) ? data.packs : [];
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].id === id) return toClientSerializablePack(list[i]);
      }
      return null;
    },
    openPackEditor: function (opts) {
      var o = opts && typeof opts === "object" ? opts : {};
      var mode = o.mode || "new";
      var packId = String(o.packId || "").trim();
      var cur = api.getSnapshot();
      var data = cur.packsData;
      var rawMap = (data && data.rawPacks) || {};
      var list = data && Array.isArray(data.packs) ? data.packs : [];
      var resolved = null;
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].id === packId) { resolved = list[i]; break; }
      }
      var rawSrc = (packId && rawMap[packId]) || resolved || {};
      var form;
      if (mode === "edit" && packId !== "") {
        var spEdit = rawSrc.speechStyle || {};
        form = {
          editing: true,
          id: rawSrc.id || packId,
          name: rawSrc.name || rawSrc.id || packId,
          description: rawSrc.description || "",
          baseCulture: rawSrc.baseCulture || "",
          extends: rawSrc.extends || "",
          aliasesText: Array.isArray(rawSrc.aliases) ? rawSrc.aliases.join(", ") : "",
          bannedLines: formatWordMappingLines(rawSrc.bannedWords, rawSrc.recommended),
          allowWordsText: Array.isArray(rawSrc.allowWords) ? rawSrc.allowWords.join(", ") : "",
          slopMuteCategories: Array.isArray(rawSrc.slopMuteCategories) ? rawSrc.slopMuteCategories.slice() : [],
          titleGuideline: spEdit.titleGuideline !== void 0 ? spEdit.titleGuideline : (spEdit.title || ""),
          toneGuideline: spEdit.toneGuideline !== void 0 ? spEdit.toneGuideline : (spEdit.tone || ""),
          ritualGoodNote: spEdit.ritualGoodNote || "",
          honorLines: formatWordMappingLines(spEdit.honorBad, spEdit.honorGood),
          ritualPatternsText: Array.isArray(spEdit.ritualBadPatterns) ? spEdit.ritualBadPatterns.join("\n") : ""
        };
      } else if (mode === "fork" && packId !== "") {
        var srcName = (resolved && resolved.name) || rawSrc.name || packId;
        var srcCulture = (resolved && resolved.baseCulture) || rawSrc.baseCulture || "";
        form = {
          editing: false,
          id: packId + "-custom",
          name: srcName + (isEnglish() ? " (Custom)" : " (自定义)"),
          description: "",
          baseCulture: srcCulture,
          extends: packId,
          aliasesText: "",
          bannedLines: "",
          allowWordsText: "",
          slopMuteCategories: Array.isArray(rawSrc.slopMuteCategories) ? rawSrc.slopMuteCategories.slice() : [],
          titleGuideline: "",
          toneGuideline: "",
          ritualGoodNote: "",
          honorLines: "",
          ritualPatternsText: ""
        };
      } else {
        form = {
          editing: false,
          id: "",
          name: "",
          description: "",
          baseCulture: "",
          extends: "",
          aliasesText: "",
          bannedLines: "",
          allowWordsText: "",
          slopMuteCategories: [],
          titleGuideline: "",
          toneGuideline: "",
          ritualGoodNote: "",
          honorLines: "",
          ritualPatternsText: ""
        };
      }
      api.set({
        view: "packs-form",
        packsForm: form,
        packsFormDirty: false,
        packsFormBind: false,
        packsMsg: "",
        packsErr: false,
        packShareOpen: false,
        packDeleteOpen: false
      }, { silent: true });
    },
    setPackForm: function (patch) {
      var cur = api.getSnapshot();
      var prev = cur.packsForm || {};
      api.set({ packsForm: Object.assign({}, prev, patch), packsFormDirty: true }, { silent: true });
    },
    togglePackFormSlop: function (catKey) {
      var cur = api.getSnapshot();
      var prev = cur.packsForm || {};
      var list = Array.isArray(prev.slopMuteCategories) ? prev.slopMuteCategories.slice() : [];
      var idx = list.indexOf(catKey);
      if (idx === -1) list.push(catKey);
      else list.splice(idx, 1);
      api.set({ packsForm: Object.assign({}, prev, { slopMuteCategories: list }), packsFormDirty: true }, { silent: true });
    },
    savePackForm: function () {
      var cur = api.getSnapshot();
      var form = cur.packsForm;
      if (!form || cur.packsBusy) return Promise.resolve(null);
      var packObj = buildClientPackObject(form);
      if (!packObj.id) {
        api.set({ packsErr: true, packsMsg: t("packs.needId") }, { silent: true });
        return Promise.resolve(null);
      }
      var reqId = (api.packsReqId += 1);
      api.set({ packsBusy: true, packsErr: false, packsMsg: "" }, { silent: true });
      return fetchWithTimeout(PACKS_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          action: "save",
          pack: packObj,
          overwrite: form.editing === true,
          book: cur.packsBook || "",
          bindAfterSave: cur.packsFormBind === true
        })
      }).then(function (r) {
        if (r.ok) return r.json();
        return hostError(r).then(function (err) { throw err; });
      }).then(function (data) {
        if (reqId !== api.packsReqId) return null;
        var saveWarnList = data && Array.isArray(data.saveWarnings)
          ? data.saveWarnings
          : (data && Array.isArray(data.warnings) ? data.warnings : []);
        var warnN = Math.max(
          saveWarnList.length,
          Array.isArray(data && data.rejectedPatterns) ? data.rejectedPatterns.length : 0
        );
        var msg = t("packs.savedMsg").replace("{id}", (data && data.saved) || packObj.id);
        if (warnN > 0) msg += t("packs.saveWarnSuffix").replace("{n}", String(warnN));
        var latest = api.getSnapshot();
        var nextPatch = {
          packsData: data,
          packsBook: (data && typeof data.book === "string" && data.book !== "") ? data.book : (latest.packsBook || cur.packsBook),
          packsBusy: false,
          packsErr: false,
          packsMsg: msg,
          packsForm: null,
          packsFormDirty: false,
          packsFormBind: false
        };
        if (latest.view === "packs-form") nextPatch.view = "packs";
        api.set(nextPatch, { silent: true });
        return data;
      }).catch(function (err) {
        if (reqId !== api.packsReqId) return null;
        api.set({ packsBusy: false, packsErr: true, packsMsg: t("packs.saveFail") + "：" + errorText(err) }, { silent: true });
        return null;
      });
    },
    sharePack: function (packIdOrObj) {
      var obj = api.resolvePackSource(packIdOrObj);
      if (!obj || !obj.id) return;
      var envelope = buildClientPackEnvelope(obj);
      var jsonStr = JSON.stringify(obj, null, 2) + "\n";
      api.auditCopy(envelope, function (ok) {
        if (ok) {
          api.set({ packsMsg: t("packs.shareCopied"), packsErr: false }, { silent: true });
        } else {
          api.set({ packShareOpen: true, packShareId: obj.id, packShareText: envelope, packShareJson: jsonStr }, { silent: true });
        }
      });
    },
    exportPackJson: function (packIdOrObj) {
      var obj = api.resolvePackSource(packIdOrObj);
      if (!obj || !obj.id) return;
      var jsonStr = JSON.stringify(obj, null, 2) + "\n";
      var envelope = buildClientPackEnvelope(obj);
      var exported = false;
      try {
        if (typeof Blob === "function" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && typeof document !== "undefined" && typeof document.createElement === "function") {
          var blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
          var url = URL.createObjectURL(blob);
          var link = document.createElement("a");
          link.href = url;
          link.download = obj.id + ".json";
          if (document.body && typeof document.body.appendChild === "function") document.body.appendChild(link);
          if (typeof link.click === "function") link.click();
          if (link.parentElement && typeof link.parentElement.removeChild === "function") link.parentElement.removeChild(link);
          setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 1000);
          exported = true;
        }
      } catch (err) { exported = false; }
      if (exported) {
        api.set({ packsMsg: t("packs.exported").replace("{id}", obj.id), packsErr: false }, { silent: true });
      } else {
        api.set({
          packShareOpen: true,
          packShareId: obj.id,
          packShareText: envelope,
          packShareJson: jsonStr,
          packsMsg: t("packs.exportFail"),
          packsErr: false
        }, { silent: true });
      }
    },
    closePackShare: function () {
      api.set({ packShareOpen: false, packShareId: "", packShareText: "", packShareJson: "" }, { silent: true });
    },
    openPackImport: function () {
      api.packsImportReqId += 1;
      api.set({
        view: "packs-import",
        packsForm: null,
        packsFormDirty: false,
        packsFormBind: false,
        packsImportText: "",
        packsImportFileName: "",
        packsImportPreview: null,
        packsImportPreviewedText: "",
        packsImportId: "",
        packsImportOverwrite: false,
        packsImportBind: false,
        packsImportMsg: "",
        packsImportErr: false,
        packsImportBusy: false,
        packShareOpen: false,
        packDeleteOpen: false
      }, { silent: true });
    },
    setPackImportText: function (text, fileName) {
      api.packsImportReqId += 1;
      var patch = {
        packsImportText: String(text || ""),
        packsImportPreview: null,
        packsImportPreviewedText: "",
        packsImportOverwrite: false,
        packsImportBusy: false,
        packsImportErr: false,
        packsImportMsg: ""
      };
      if (fileName !== void 0) patch.packsImportFileName = String(fileName || "");
      api.set(patch, { silent: true });
    },
    readPackImportFile: function (file) {
      if (!file) return Promise.resolve(null);
      var reqId = (api.packsImportReqId += 1);
      api.set({
        packsImportPreview: null,
        packsImportPreviewedText: "",
        packsImportOverwrite: false,
        packsImportBusy: false,
        packsImportErr: false,
        packsImportMsg: ""
      }, { silent: true });
      if (typeof file.size === "number" && file.size > 256 * 1024) {
        api.set({ packsImportBusy: false, packsImportErr: true, packsImportMsg: t("packs.fileTooLarge"), packsImportPreview: null, packsImportPreviewedText: "" }, { silent: true });
        return Promise.resolve(null);
      }
      var fName = typeof file.name === "string" ? file.name : "import.json";
      var handleText = function (txt) {
        if (reqId !== api.packsImportReqId) return Promise.resolve(null);
        api.set({
          packsImportText: String(txt || ""),
          packsImportFileName: fName,
          packsImportPreview: null,
          packsImportPreviewedText: "",
          packsImportOverwrite: false,
          packsImportBusy: false,
          packsImportErr: false,
          packsImportMsg: ""
        }, { silent: true });
        return api.previewPackImport();
      };
      var handleFail = function () {
        if (reqId !== api.packsImportReqId) return null;
        api.set({ packsImportBusy: false, packsImportErr: true, packsImportMsg: t("packs.fileReadFail"), packsImportPreview: null, packsImportPreviewedText: "" }, { silent: true });
        return null;
      };
      try {
        if (typeof file.text === "function") return file.text().then(handleText, handleFail);
        if (typeof FileReader === "function") {
          return new Promise(function (resolve) {
            var reader = new FileReader();
            reader.onload = function () { handleText(reader.result).then(resolve); };
            reader.onerror = function () { resolve(handleFail()); };
            reader.readAsText(file);
          });
        }
      } catch (err) { /* fall through */ }
      return Promise.resolve(handleFail());
    },
    previewPackImport: function () {
      var cur = api.getSnapshot();
      if (cur.packsImportBusy) return Promise.resolve(null);
      var textToPreview = String(cur.packsImportText || "");
      var fileName = String(cur.packsImportFileName || "");
      var reqId = (api.packsImportReqId += 1);
      api.set({ packsImportBusy: true, packsImportErr: false, packsImportMsg: "", packsImportPreview: null, packsImportPreviewedText: "", packsImportOverwrite: false }, { silent: true });
      return fetchWithTimeout(PACKS_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          action: "preview",
          text: textToPreview,
          fileName: fileName
        })
      }).then(function (r) {
        if (r.ok) return r.json();
        return hostError(r).then(function (err) { throw err; });
      }).then(function (data) {
        if (reqId !== api.packsImportReqId) return null;
        var prev = data && data.preview ? data.preview : null;
        var suggestedId = "";
        if (prev && prev.pack) {
          suggestedId = prev.conflict && prev.conflict.isBuiltinId ? (prev.pack.id + "-custom") : prev.pack.id;
        }
        api.set({
          packsImportBusy: false,
          packsImportErr: false,
          packsImportMsg: "",
          packsImportPreview: prev,
          packsImportPreviewedText: prev ? textToPreview : "",
          packsImportId: suggestedId,
          packsImportOverwrite: false
        }, { silent: true });
        return prev;
      }).catch(function (err) {
        if (reqId !== api.packsImportReqId) return null;
        api.set({ packsImportBusy: false, packsImportErr: true, packsImportMsg: errorText(err), packsImportPreview: null, packsImportPreviewedText: "" }, { silent: true });
        return null;
      });
    },
    confirmPackImport: function () {
      var cur = api.getSnapshot();
      if (cur.packsImportBusy || !cur.packsImportPreview) return Promise.resolve(null);
      var previewedText = String(cur.packsImportPreviewedText || "");
      if (String(cur.packsImportText || "") !== previewedText) {
        api.set({ packsImportPreview: null, packsImportPreviewedText: "", packsImportOverwrite: false, packsImportErr: true, packsImportMsg: t("packs.importHint") }, { silent: true });
        return Promise.resolve(null);
      }
      var idOverride = String(cur.packsImportId || "").trim();
      if (!idOverride) {
        api.set({ packsImportErr: true, packsImportMsg: t("packs.needId") }, { silent: true });
        return Promise.resolve(null);
      }
      var reqId = (api.packsImportReqId += 1);
      api.set({ packsImportBusy: true, packsImportErr: false, packsImportMsg: "" }, { silent: true });
      return fetchWithTimeout(PACKS_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          action: "save",
          text: previewedText,
          fileName: cur.packsImportFileName || "",
          idOverride: idOverride,
          overwrite: cur.packsImportOverwrite === true,
          book: cur.packsBook || "",
          bindAfterSave: cur.packsImportBind === true
        })
      }).then(function (r) {
        if (r.ok) return r.json();
        return hostError(r).then(function (err) { throw err; });
      }).then(function (data) {
        if (reqId !== api.packsImportReqId) return null;
        var savedId = (data && data.saved) || idOverride;
        var saveWarnList = data && Array.isArray(data.saveWarnings)
          ? data.saveWarnings
          : (data && Array.isArray(data.warnings) ? data.warnings : []);
        var warnN = Math.max(
          saveWarnList.length,
          Array.isArray(data && data.rejectedPatterns) ? data.rejectedPatterns.length : 0
        );
        var msg = t("packs.importDone").replace("{id}", savedId);
        if (warnN > 0) msg += t("packs.saveWarnSuffix").replace("{n}", String(warnN));
        var latest = api.getSnapshot();
        var nextPatch = {
          packsData: data,
          packsBook: (data && typeof data.book === "string" && data.book !== "") ? data.book : (latest.packsBook || cur.packsBook),
          packsImportBusy: false,
          packsImportErr: false,
          packsImportMsg: "",
          packsImportText: "",
          packsImportFileName: "",
          packsImportPreview: null,
          packsImportPreviewedText: "",
          packsImportId: "",
          packsImportOverwrite: false,
          packsMsg: msg,
          packsErr: false
        };
        if (latest.view === "packs-import") nextPatch.view = "packs";
        api.set(nextPatch, { silent: true });
        return data;
      }).catch(function (err) {
        if (reqId !== api.packsImportReqId) return null;
        api.set({ packsImportBusy: false, packsImportErr: true, packsImportMsg: errorText(err) }, { silent: true });
        return null;
      });
    },
    openPackDelete: function (packId, packName) {
      var id = String(packId || "").trim();
      if (id === "") return;
      api.set({ packDeleteOpen: true, packDeleteId: id, packDeleteName: String(packName || id) }, { silent: true });
    },
    cancelPackDelete: function () {
      api.set({ packDeleteOpen: false, packDeleteId: "", packDeleteName: "" }, { silent: true });
    },
    confirmPackDelete: function () {
      var cur = api.getSnapshot();
      var targetId = String(cur.packDeleteId || "").trim();
      if (!cur.packDeleteOpen || targetId === "" || cur.packsBusy) return Promise.resolve(null);
      var reqId = (api.packsReqId += 1);
      api.set({ packDeleteOpen: false, packDeleteId: "", packDeleteName: "", packsBusy: true, packsErr: false, packsMsg: "" }, { silent: true });
      return fetchWithTimeout(PACKS_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ action: "delete", id: targetId, book: cur.packsBook || "" })
      }).then(function (r) {
        if (r.ok) return r.json();
        return hostError(r).then(function (err) { throw err; });
      }).then(function (data) {
        if (reqId !== api.packsReqId) return null;
        api.set({
          packsData: data,
          packsBook: (data && typeof data.book === "string" && data.book !== "") ? data.book : cur.packsBook,
          packsBusy: false,
          packsErr: false,
          packsMsg: t("packs.deletedMsg").replace("{id}", targetId)
        }, { silent: true });
        return data;
      }).catch(function (err) {
        if (reqId !== api.packsReqId) return null;
        api.set({ packsBusy: false, packsErr: true, packsMsg: t("packs.deleteFail") + "：" + errorText(err) }, { silent: true });
        return null;
      });
    }
  });
}
