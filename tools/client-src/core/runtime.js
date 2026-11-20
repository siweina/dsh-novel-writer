    // v3.5.0 R1：rawTimer 必须在 createController 闭包外/顶部声明（旧位置在渲染函数内，api 方法访问不到 → ReferenceError）
    var rawTimer = null;
    // v6.0.0 页面过渡方向记忆（HyperOS push/pop 分层；模块级而非 state 字段/非 hook——行为契约零变化）
    var nwViewOrder = { main: 0, features: 1, tools: 1, baseline: 1, reports: 1, creation: 1, lexicon: 1, packs: 1, diagnose: 1, trash: 1, model: 2, "creation-form": 2, "packs-form": 2, "packs-import": 2 };
    var nwPrevView = "main";
    var nwViewDir = "fwd";
    var BUILTIN_PACK_IDS_CLIENT = ["western-fantasy", "eastern-xianxia", "modern-urban", "mystery-thriller", "scifi-cyberpunk"];
    var PACK_SCHEMA_V1_CLIENT = "dsh-novel-writer-pack/v1";

    function parsePackListText(text) {
      var seen = {};
      var out = [];
      String(text || "").split(/[,，、\r\n]+/).forEach(function (part) {
        var s = part.trim();
        if (s !== "" && !seen[s]) { seen[s] = true; out.push(s); }
      });
      return out;
    }

    function parseWordMappingLines(text) {
      var seen = {};
      var words = [];
      var map = {};
      String(text || "").split(/\r?\n/).forEach(function (rawLine) {
        var line = rawLine.trim();
        if (line === "") return;
        var m = line.match(/^(.*?)(?:\s*(?:->|→|=>|＝>)\s*)(.*)$/);
        if (m) {
          var left = m[1].trim();
          var right = m[2].trim();
          if (left === "") return;
          if (!seen[left]) { seen[left] = true; words.push(left); }
          if (right !== "") map[left] = right;
          return;
        }
        line.split(/[,，、]+/).forEach(function (part) {
          var w = part.trim();
          if (w !== "" && !seen[w]) { seen[w] = true; words.push(w); }
        });
      });
      return { words: words, map: map };
    }

    function formatWordMappingLines(words, map) {
      var out = [];
      var seen = {};
      (Array.isArray(words) ? words : []).forEach(function (w) {
        var key = String(w || "").trim();
        if (key === "" || seen[key]) return;
        seen[key] = true;
        var rep = map && typeof map === "object" && typeof map[key] === "string" ? map[key].trim() : "";
        out.push(rep !== "" ? (key + " -> " + rep) : key);
      });
      if (map && typeof map === "object") {
        Object.keys(map).forEach(function (k) {
          var key = String(k || "").trim();
          if (key === "" || seen[key]) return;
          var rep = typeof map[k] === "string" ? map[k].trim() : "";
          if (rep !== "") {
            seen[key] = true;
            out.push(key + " -> " + rep);
          }
        });
      }
      return out.join("\n");
    }

    function toClientSerializablePack(raw) {
      var src = raw && typeof raw === "object" ? raw : {};
      var id = String(src.id || "").trim();
      var out = {
        schema: PACK_SCHEMA_V1_CLIENT,
        id: id,
        name: String(src.name || id).trim(),
        description: String(src.description || "").trim()
      };
      var baseCulture = typeof src.baseCulture === "string" ? src.baseCulture.trim() : "";
      if (baseCulture !== "") out.baseCulture = baseCulture;
      var ext = typeof src.extends === "string" ? src.extends.trim() : "";
      if (ext !== "") out.extends = ext;
      var aliases = Array.isArray(src.aliases) ? src.aliases.map(function (s) { return String(s || "").trim(); }).filter(Boolean) : [];
      if (aliases.length > 0) out.aliases = aliases;
      out.bannedWords = Array.isArray(src.bannedWords) ? src.bannedWords.slice() : [];
      out.recommended = src.recommended && typeof src.recommended === "object" && !Array.isArray(src.recommended) ? Object.assign({}, src.recommended) : {};
      out.allowWords = Array.isArray(src.allowWords) ? src.allowWords.slice() : [];
      var sp = src.speechStyle && typeof src.speechStyle === "object" && !Array.isArray(src.speechStyle) ? src.speechStyle : null;
      if (sp) {
        var tg = String(sp.titleGuideline !== void 0 ? sp.titleGuideline : (sp.title || "")).trim();
        var hb = Array.isArray(sp.honorBad) ? sp.honorBad.slice() : [];
        var hg = sp.honorGood && typeof sp.honorGood === "object" && !Array.isArray(sp.honorGood) ? Object.assign({}, sp.honorGood) : {};
        var rbp = Array.isArray(sp.ritualBadPatterns) ? sp.ritualBadPatterns.slice() : [];
        var rgn = String(sp.ritualGoodNote || "").trim();
        var tn = String(sp.toneGuideline !== void 0 ? sp.toneGuideline : (sp.tone || "")).trim();
        if (tg !== "" || hb.length > 0 || Object.keys(hg).length > 0 || rbp.length > 0 || rgn !== "" || tn !== "") {
          out.speechStyle = {
            titleGuideline: tg,
            honorBad: hb,
            honorGood: hg,
            ritualBadPatterns: rbp,
            ritualGoodNote: rgn,
            toneGuideline: tn
          };
        }
      }
      out.slopMuteCategories = Array.isArray(src.slopMuteCategories) ? src.slopMuteCategories.slice() : [];
      return out;
    }

    function buildClientPackObject(form) {
      var f = form && typeof form === "object" ? form : {};
      var bannedParsed = parseWordMappingLines(f.bannedLines || "");
      var honorParsed = parseWordMappingLines(f.honorLines || "");
      var ritualPatterns = [];
      var seenReg = {};
      String(f.ritualPatternsText || "").split(/\r?\n/).forEach(function (line) {
        var pat = line.trim();
        if (pat !== "" && !seenReg[pat]) { seenReg[pat] = true; ritualPatterns.push(pat); }
      });
      var raw = {
        id: String(f.id || "").trim(),
        name: String(f.name || "").trim(),
        description: String(f.description || "").trim(),
        baseCulture: String(f.baseCulture || "").trim(),
        extends: String(f.extends || "").trim(),
        aliases: parsePackListText(f.aliasesText || ""),
        bannedWords: bannedParsed.words,
        recommended: bannedParsed.map,
        allowWords: parsePackListText(f.allowWordsText || ""),
        slopMuteCategories: Array.isArray(f.slopMuteCategories) ? f.slopMuteCategories.slice() : [],
        speechStyle: {
          titleGuideline: String(f.titleGuideline || "").trim(),
          toneGuideline: String(f.toneGuideline || "").trim(),
          ritualGoodNote: String(f.ritualGoodNote || "").trim(),
          honorBad: honorParsed.words,
          honorGood: honorParsed.map,
          ritualBadPatterns: ritualPatterns
        }
      };
      return toClientSerializablePack(raw);
    }

    function buildClientPackEnvelope(packObj) {
      var clean = toClientSerializablePack(packObj);
      var json = JSON.stringify(clean, null, 2);
      return "[DSH-PACK v1] " + (clean.name || clean.id) + " (" + clean.id + ")\n```json\n" + json + "\n```";
    }

    function defaultSlopCategories(isEn) {
      if (isEn) {
        return {
          eye_cliche: "Eye/facial cliches",
          smirk_cliche: "Smirk/expression cliches",
          shock_crowd: "Crowd reaction cliches",
          filler_transition: "Filler transitions",
          abstract_tell: "Abstract emotion telling",
          ending_preach: "Ending preaching",
          ai_ese: "AI translationese",
          stat_numeric: "Numeric stat readouts"
        };
      }
      return {
        eye_cliche: "眼神/五官类陈词",
        smirk_cliche: "表情/嘴角类陈词",
        shock_crowd: "众人震惊类",
        filler_transition: "转折灌水类",
        abstract_tell: "抽象告知类",
        ending_preach: "章末升华/预告类",
        ai_ese: "AI 翻译腔/公文腔",
        stat_numeric: "数值播报类"
      };
    }
    var reportReqId = 0; // v3.5.0 M15：模块级请求序号（渲染闭包变量每次渲染归零，守卫失效）
    var baselineFlashTimer = null; // v4.0.0：基线"已保存"闪烁定时器（此前从不清理：连续保存互相抢状态、卸载后仍写状态）
    var localeId = ""; // v4.3.0：宿主 locale 服务的当前语言（apply 内订阅写入；为空则回退 documentElement.lang）
    /**
     * #30：统一的二次确认入口——所有高破坏性操作都走它，不再出现裸 window.confirm。
     * 沙箱 iframe / 无头测试 / 宿主未实现 confirm 时按「用户已确认」处理（保持功能可用，
     * 否则删除等按钮会在这些环境里变成点了没反应）；访问 confirm 本身抛错（权限策略）同样放行。
     * @param {string} message 确认文案
     * @returns {boolean} true=继续，false=用户取消
     */
    function safeConfirm(message) {
      if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
      try { return window.confirm(message) !== false; } catch (err) { return true; }
    }

    let react = require("react");
    let react_dom_client = require("react-dom/client");
