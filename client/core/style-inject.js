    // v3.0.0-UI3：已存在旧 style 标签也覆盖内容——否则插件脚本重复执行时新 CSS 永不注入（UI 停留在旧版）
    if (typeof document !== "undefined") {
      var cssTag = document.querySelector("style[data-plugin-css=\"dsh-novel-writer\"]");
      if (cssTag) {
        if (cssTag.textContent !== css) cssTag.textContent = css;
      } else {
        cssTag = document.createElement("style");
        cssTag.dataset.plugin = "dsh-novel-writer";
        cssTag.dataset.pluginCss = "dsh-novel-writer";
        cssTag.textContent = css;
        document.head.appendChild(cssTag);
      }
    }
