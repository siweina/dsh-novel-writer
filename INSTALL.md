# dsh-novel-writer v0.5.0 — 安装指南（v0.3.0 × v0.4.0 合并版）

宿主端零第三方依赖；浏览器端依赖 Web GUI 自带的 react。
本包 UI：侧边栏「句式分析」大开关面板（统一开关位置）；设置 > 插件配置 卡片仅显示状态 + 跳转按钮。

```
dsh-novel-writer-v0.5.0/
├── lib/
│   ├── index.js        # 宿主端（8 个 novel_* 工具 + state 路由）
│   ├── analysis.js     # 句式模式分析引擎（九类/情感/节奏，零依赖）
│   └── client.js       # 浏览器端（侧边栏面板 + 设置页卡片）
├── test/               # 引擎与 client 契约测试
├── package.json
├── cordis.patch.yml
├── README.md
├── INSTALL.md
└── skills/novel-writing/SKILL.md
```

## 安装

1. 把本文件夹放入 profile 的 node_modules（或 `dsh plugin --profile web add <路径>`）；
2. profile `package.json` 的 `dsh.profile.bundles` 加入 `dsh-novel-writer`；
3. （可选）把 `skills/novel-writing` 复制到工作区 `.dsh/skills/`；
4. **重启 web 应用**。

## 验证

- 工具列表出现：novel_books / novel_chapters / novel_read / novel_keywords / novel_new_chapter /
  novel_import / novel_sentence_analysis / novel_sentence_config；
- 侧边栏出现「句式分析」入口；设置 > 插件配置 出现 novel-writer 状态卡片；
- `GET /api/dsh-novel-writer/state` 返回 200 JSON。

## 开关

- 默认开启；**唯一开关位置：侧边栏「句式分析」面板**（总开关 enabled + 子开关 autoAnalyze）；
- 设置 > 插件配置 卡片仅显示状态并提供「打开开关面板」跳转；
- 持久化 `~/.dsh/dsh-novel-writer/state.json`；兼容读取 `~/.dsh/novel-writer.json`（v0.4.0 stylePattern）；
- config 支持 `sentenceAnalysis.enabled / autoAnalyze` 与 `stylePattern`（v0.4.0 兼容）。
