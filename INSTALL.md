# dsh-novel-writer v0.6.0 — 安装指南

基于 v0.5.0 合并版的工程化升级。新增：分析缓存/报告导出、风格自检、伏笔登记表、关键词三字组与疑似人名、情感词典去噪、局域网开关可选放行。

```
dsh-novel-writer-v0.6.0/
├── lib/
│   ├── index.js        # 宿主端（10 个工具 + state 路由 + 缓存）
│   ├── analysis.js     # 句式模式分析引擎（含 fingerprintSimilarity / styleDiffs）
│   └── client.js       # 浏览器端（侧边栏面板 + 设置页状态卡片）
├── test/               # 引擎 + client + e2e 测试
├── package.json / cordis.patch.yml / README.md / INSTALL.md
└── skills/novel-writing/SKILL.md
```

## 安装

1. 放入 profile 的 node_modules（或 `dsh plugin --profile web add <路径>`）；
2. profile `package.json` 的 `dsh.profile.bundles` 加入 `dsh-novel-writer`；
3. （可选）复制 `skills/novel-writing` 到工作区 `.dsh/skills/`；
4. 重启 web 应用。

## 验证

- 工具列表出现 10 个 novel_* 工具（含 novel_style_check / novel_plot）；
- `novel_sentence_analysis` 返回含 `reportFile` / `cache` 字段；
- 缓存目录 `~/.dsh/dsh-novel-writer/cache/` 出现报告 JSON；
- 伏笔表文件 `<root>/.novel-writer/<书名>.json`。

## 数据位置

| 数据 | 路径 |
|---|---|
| 开关状态 | `~/.dsh/dsh-novel-writer/state.json` |
| 分析报告缓存 | `~/.dsh/dsh-novel-writer/cache/<书>-<hash>.json` |
| 伏笔登记表 | `<书库根>/.novel-writer/<书>.json` |
