    // ---- V6 图标挂载胶水（总负责人手管区；构建只替换标记对之间内容，本段不受重建影响） ----
    // nwGlyph: 表内有 key → 注入 SVG（React 不渲染 HTML 字符串，须经 dangerouslySetInnerHTML；
    //          图标串由构建链从静态文件装配，非用户输入）；无 key → 回退原字形文本。
    function nwGlyph(el, cls, key, fallback) {
      var svg = NW_ICONS ? NW_ICONS[key] : "";
      if (svg) return el("span", { className: cls, "aria-hidden": "true", dangerouslySetInnerHTML: { __html: svg } });
      return el("span", { className: cls }, fallback);
    }
    // nwIconEls: PreferenceRow 的 ICONS 参数需"值即节点"，首次渲染时建表并缓存（el 引用稳定）。
    var NW_ICONS_EL_CACHE = null;
    function nwIconEls(el) {
      if (NW_ICONS_EL_CACHE !== null) return NW_ICONS_EL_CACHE;
      var out = {};
      var ks = Object.keys(NW_ICONS);
      for (var nwI = 0; nwI < ks.length; nwI += 1) {
        out[ks[nwI]] = el("span", { className: "nwIco", "aria-hidden": "true", dangerouslySetInnerHTML: { __html: NW_ICONS[ks[nwI]] } });
      }
      NW_ICONS_EL_CACHE = out;
      return out;
    }
