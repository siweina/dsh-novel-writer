# dsh-novel-writer · 宣传页 + 技术文档

`dsh-novel-writer` 插件的宣传站与工具技术文档。纯静态、零依赖、零构建，双击 `index.html` 即可打开。

## 目录结构

```
index.html                 宣传页（9 个区块）
styles.css                 宣传页设计系统（配色 / 排版 / 响应式 / 动效）
script.js                  宣传页交互（滚动进场 / 能力卡展开 / 复制 / 分页 / 移动端菜单）
README.md                  本文件
tools/
  index.html               技术文档总览（16 个工具的分组索引 + 共同约定）
  docs.css                 文档三栏布局（侧栏 / 正文 / 右侧目录）
  docs.js                  侧栏、目录、上下页的渲染（工具清单唯一数据源）
  novel-books.html         以下 16 个为工具子页面，文件名即 docs.js 中的 file 字段
  novel-chapters.html
  novel-read.html
  novel-new-chapter.html
  novel-import.html
  novel-keywords.html
  novel-style-report.html
  novel-style-check.html
  novel-sentence-analysis.html
  novel-semantic-search.html
  novel-plot.html
  novel-settings.html
  novel-summary.html
  novel-outline.html
  novel-continuity-check.html
  novel-sentence-config.html
```

没有构建步骤、没有 npm 依赖、没有外链字体或脚本。唯一的远程资源是页脚那三枚徽章图片（npm 版本、Glama 评分、MIT 协议），离线打开只会缺图，不影响页面。

## 本地预览

直接双击 `index.html`。若需通过本地服务器预览（例如验证剪贴板权限行为）：

```bash
npx serve .          # 或
python -m http.server 8080
```

## 部署

任何静态托管均可，上传整个目录即可：

- **GitHub Pages**：把文件放进仓库或 `docs/` 目录，Settings → Pages 选择分支与目录；
- **Vercel / Netlify / Cloudflare Pages**：拖入文件夹，无需配置构建命令与输出目录；
- **对象存储 + CDN**：上传后将 `index.html` 设为默认首页。

## 宣传页交互

| 交互 | 行为 |
|---|---|
| **能力卡悬停展开** | 光标在卡片上停留满 **1 秒**后展开详情面板。移出即收起；同时只展开一张；`Esc` 收起 |
| **展开方向自适应** | 优先向下；下方空间不足且上方放得下时**改为向上**；两边都不足时仍向下（按需求约定）。方向在每次展开时重新判定，面板高度只在首次展开时测量并缓存，窗口尺寸变化后失效重算 |
| 能力卡（触屏 / 键盘） | 点击卡片内「详细说明」按钮切换展开；键盘 `Tab` 聚焦到卡片即展开，焦点完全移出后收起 |
| 卡片 → 子页面 | 点击卡片标题进入对应的技术文档子页面；非触屏设备上点击卡片空白处同样进入；展开面板底部另有「查看完整技术说明 →」链接 |
| 首屏胶囊 | 四个片语各自可点：GitHub Release、npm、MCP Registry、Glama |
| 滚动进场 | `IntersectionObserver` 触发淡入上移；能力卡不带交错延迟（保证悬停响应灵敏），其余网格元素带 60ms 递增延迟 |
| 安装分页 | 三个标签页切换，同步更新 `aria-selected` |
| 复制按钮 | 写入剪贴板并显示「已复制」，1.6 秒后复原；不可用时自动选中文本提示手动复制 |

### 两个动画实现上的坑（已规避，改样式时请勿回退）

1. **展开时不能缩放卡片本身。** 面板在做 `grid-template-rows` 高度动画（逐帧重排），若把 `scale` 加在卡片上，等于让「正在逐帧重排的子树」同时处于被缩放的上下文里，每帧都要按新倍率重新栅格化，表现为展开瞬间闪烁。因此**放大作用在 `.card::before` 这个只含背景的独立图层上**（`scale: 1.035`），卡片本身只做 `translate`，文字保持清晰。
2. **面板的边框与投影必须等面板有高度后再淡入。** 面板高度为 0 时若已绘制 1px 边框与投影，会在卡片下方先出现一条细线和一抹阴影，随即被长高的面板盖住——视觉上就是「闪一下」。因此收起态为 `border-color: transparent` + 全透明投影，展开态用 `transition: … .12s / .14s` 延迟淡入。面板同时改为**独立浮层**（自成 16px 圆角、与卡片留 6px 间隙），避免与卡片拼接时在圆角处露出底色缺口。
3. **测量面板高度前必须关掉过渡。** 给 `grid-template-rows` 赋 `1fr` 会立即开始一段过渡，紧接其后的 `getBoundingClientRect()` 读到的是过渡起始值（只剩边框的 2px），方向判定会因此失真。`panelHeight()` 会临时置 `transition: none`，测完先还原值、再恢复过渡声明。
4. **收起方向的边框与投影必须与高度动画同曲线同时长。** 曾把收起写成 `border-color .1s linear`，结果 271ms 的收起动画里边框 67ms 就淡没了（面板还剩 27% 高度），看上去是「啪」地闪掉。现在两个方向都用 `var(--ease)` + `.3s`：实测边框不透明度与面板剩余高度比值稳定在 1.01–1.04，即**同步淡出**。注意展开方向仍需**延迟** 0.12/0.14 秒淡入，那是为了避开 0 高度时绘制边框的问题（见第 2 条），两者不可对调。
5. **卡片必须常驻层叠上下文（`isolation: isolate`）。** 卡片表面画在 `.card::before` 上并带 `z-index: -1`；若卡片本身不是层叠上下文，这个负 z-index 伪元素会被排到**整个区块背景（`.sec--tint` 的 `#f9fafb`）之下**，被整块盖住。后果是两个症状连带出现：① **静止态完全看不到卡片的白色圆角容器**（实测该行像素全为 `249,250,251`，即区块背景色）；② 展开时卡片因 `z-index: 3` / `translate` 临时成为层叠上下文，表面才露出来；收起后 `translate` 过渡结束变回 `none`、层叠上下文消失，**表面瞬间消失**——也就是「闪一下」。加 `isolation: isolate` 后静止态该行像素变为 `249,250,251 → 233,236,242（边框）→ 255,255,255（白底）`，且收起全程与收起之后内部始终为 `255,255,255`。
6. **收起期间要临时保留 `z-index`（`.is-closing`）。** 卡片成为层叠上下文后，后一行卡片会盖住前一行正在收回的面板。`setCard()` 在收起时加 `.is-closing`（`z-index: 3`），380ms 后移除。

## 技术文档子页面

- 三栏布局：左侧工具导航（按 4 个分组）、中间正文（最大 780px）、右侧本页目录（滚动高亮）。
- 每个工具页固定结构：**参数 → 输出结构 → 计算原理 → 约束与边界 → 相关工具 → 源码位置**，面向二次开发与集成方。
- `docs.js` 里的 `TOOLS` 数组是唯一数据源：新增页面只需在该数组登记一行（`file` / `name` / `title` / `g`），侧栏、上下页会自动接上；页面内的 `<h2>` 会自动生成右侧目录。
- 页面骨架可直接复制 `tools/novel-style-report.html`。

## 设计来源

配色与字体栈取自 `deepseek.com` 的实际设计 token（读其 CSS 得出），非凭印象调整：

| 用途 | 值 | 出处 |
|---|---|---|
| 品牌主色 | `#3964fe` | `--dsw-static-deepseek-500` |
| 主色浅阶 | `#5686fe` / `#679efe` / `#b7c8fe` / `#d3e2ff` / `#e4edfd` / `#edf3fe` | `--dsw-static-deepseek-450/400/300/200/100/50` |
| 中性灰阶 | `#ffffff` → `#f9fafb` → `#ebeef2` → `#e1e5ee` → `#61666b` → `#0f1115` | `--dsw-static-neutral-bluish-*` |
| 字体栈 | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC"` | 官网 `font-family` |

文字颜色按 **WCAG AA（正文 ≥ 4.5:1）** 取值：主文字 `#0f1115`（18.9:1）、正文 `#43454a`（9.6:1）、次要文字 `#61666b`（5.8:1）、主色按钮白字 `4.74:1`。全部实测达标。

## 改文案要改哪里

| 区块 | id | 导航标签 | 内容 |
|---|---|---|---|
| 首屏 | `#top` | — | 主标题、副标题、两个按钮、安装命令、四个链接的胶囊、五个数字 |
| 适用场景 | `#problems` | 适用场景 | 六组「问题 → 工具输出」 |
| 能力概览 | `#features` | 能力概览 | 九张能力卡，每张含隐藏详情面板与子页面链接 |
| 报告示例 | `#output` | 报告示例 | 四个终端风格的真实输出 |
| 氛围光谱 | `#vibe` | — | 12 维示意（柱高改 HTML 里的 `style="--v:0.82"`） |
| 本地化设计 | `#compare` | 本地化设计 | 对比表 + 权限边界四格 |
| 安装部署 | `#install` | 安装部署 | 三个分页 + 快速上手 |
| 收录情况 | `#trust` | — | npm / Glama / MCP Registry / awesome 列表 |
| 常见问题 | `#faq` | 常见问题 | 五个 `<details>` 折叠项 |

改完若浏览器有缓存，`Ctrl+F5` 强制刷新。

## 无障碍与兼容

- 文字对比度全部 ≥ 4.5:1；键盘可达；带「跳至正文」跳转链接与 `:focus-visible` 焦点环；
- 能力卡详情面板用 `aria-expanded` / `aria-controls` 关联按钮与面板，面板标为 `role="region"`；
- 首屏胶囊的每个片语均为独立链接，读屏可逐一识别；
- 支持 `prefers-reduced-motion`：关闭滚动进场、柱状增长与卡片展开过渡（交互仍可用）；
- 打印样式已处理（隐藏导航、按钮与装饰光晕）；
- 响应式断点：宣传页 1080 / 900 / 820 / 520px，文档页 1180 / 860px。已在 1440px 与 390px 实测：无横向滚动，胶囊窄屏折为两行并切换 14px 圆角。

## 数据来源

页面数字与链接取自插件仓库的实际状态（v4.3.1）：16 个工具、`bge-small-zh-v1.5` 量化模型约 24MB、Node ≥ 22.3、Glama 评分 B / 16 tools、npm latest 4.3.1。发新版后需同步首屏版本号与胶囊链接、`#trust` 区块、页脚链接。

> **v4.3.1 已于 2026-09-17 发布**（站点与代码同一次推送）：全部 16 个工具页的 JSON-LD `softwareVersion` → 4.3.1；首屏品牌版本号、胶囊内的 Release 链接与 `#trust` 的 `latest` → 4.3.1；`novel-read` / `novel-chapters` / `novel-continuity-check` 三页各加一个 `v4.3.1` 变更提示块（`.warn.note`），并同步修正 `novel-read` 的查找顺序、`novel-keywords` 的章节解析顺序、`novel-summary` 的同章号共用槽位说明。**注意发版顺序**：站点与 tag 同一次推送时，Pages 重建与 CI 发包是并发的，会有 1–3 分钟窗口内「胶囊写着已发布但 Release/npm 还没就绪」。

技术文档子页面的参数与公式均取自插件源码（`lib/index.js`、`lib/analysis.js`、`lib/style-metrics.js`、`lib/embedding.js`、`lib/core.js`、`mcp/server.mjs`），改动实现后请同步更新对应页面。
