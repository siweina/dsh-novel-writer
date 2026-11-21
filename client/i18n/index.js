    // v4.3.0：语言判定统一出口——优先宿主 locale 服务（inject 声明的 locale 由此真正生效），
    // 服务不可用时回退 <html lang>（宿主 @deepseek-ai/dsh-client-locale 会同步该属性）
    function currentLang() {
      if (localeId !== "") return localeId;
      if (typeof document !== "undefined" && document.documentElement && document.documentElement.lang) return document.documentElement.lang;
      return "zh";
    }
    function isEnglish() {
      return String(currentLang()).toLowerCase().startsWith("en");
    }
    function dictionary() {
      return isEnglish() ? en : zh;
    }
    function t(key) {
      var text = dictionary()[key];
      return text === void 0 ? key : text;
    }
