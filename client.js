/**
 * dsh-novel-writer 客户端设置卡片。
 *
 * 注册进官方设置页的「插件配置」槽位（settings.plugin.item），提供
 * stylePattern（句式模式仿写）开关。读写走宿主端的 /novel-writer-config
 * 同源路由，绕开 rc.6 的 settings namespace 白名单限制；改动即时生效。
 *
 * 格式说明（与官方客户端插件一致）：
 *   - window.__ModuleLoader__.load({ id: <包名>, factory })
 *   - factory 返回 { name, inject, apply } —— inject 声明本插件使用的服务名
 *     （缺少 inject 声明会导致 ctx.locale / ctx.slots 等被服务门禁拦截）。
 */
window.__ModuleLoader__.load({
  id: "dsh-novel-writer",
  factory: (require) => {
    const React = require("react");
    const { createElement: h, useEffect, useState } = React;

    const name = "novel-writer-config";
    const inject = ["slots"];

    function NovelWriterConfigCard() {
      const [enabled, setEnabled] = useState(null);
      const [busy, setBusy] = useState(false);
      useEffect(() => {
        let alive = true;
        fetch("/novel-writer-config", { method: "GET" })
          .then((r) => r.json())
          .then((j) => { if (alive) setEnabled(j.stylePattern === true); })
          .catch(() => { if (alive) setEnabled(false); });
        return () => { alive = false; };
      }, []);
      const toggle = (next) => {
        setBusy(true);
        fetch("/novel-writer-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stylePattern: next })
        })
          .then((r) => r.json())
          .then((j) => setEnabled(j.stylePattern === true))
          .catch(() => {})
          .finally(() => setBusy(false));
      };
      return h("div", { style: { padding: "12px 0", borderBottom: "1px solid var(--dsw-alias-border-l2, #e5e7eb)" } },
        h("div", { style: { fontWeight: 600 } }, "小说写作助手 novel-writer"),
        h("div", { style: { color: "var(--dsw-alias-text-l2, #888)", fontSize: 12, margin: "4px 0 8px" } },
          "句式模式仿写：分析原文陈述/反问/心理/对话等句子的排列节奏来模仿文风。⚠️ 可能让文风变僵硬，默认关闭；改动即时生效。"),
        h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
          h("input", {
            type: "checkbox",
            checked: enabled === true,
            disabled: busy || enabled === null,
            onChange: (e) => toggle(e.target.checked)
          }),
          h("span", null, "开启句式模式仿写（stylePattern）")
        )
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        id: "novel-writer-config",
        order: 105,
        inject: () => ({})
      }, NovelWriterConfigCard));
    }

    return { name, inject, apply };
  }
});
