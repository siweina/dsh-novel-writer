# dsh-novel-writer · 宣传页 + 技术文档

`dsh-novel-writer` 插件的宣传站与工具技术文档。纯静态、零依赖、零构建，双击 `index.html` 即可打开。

## 目录结构

```
index.html                 宣传页（9 个区块）
styles.css                 宣传页设计系统（配色 / 排版 / 响应式 / 动效）
script.js                  宣传页交互（滚动进场 / 能力卡展开 / 复制 / 分页 / 移动端菜单）
README.md                  本文件
tools/
  index.html               技术文档总览（18 个工具的分组索引 + 该调哪个工具 + 共同约定）
  docs.css                 文档三栏布局（侧栏 / 正文 / 右侧目录）
  docs.js                  侧栏、目录、上下页的渲染（工具清单唯一数据源）
  novel-books.html         以下 18 个为工具子页面，文件名即 docs.js 中的 file 字段
  novel-chapters.html
  novel-read.html
  novel-new-chapter.html
  novel-chapter-brief.html
  novel-import.html
  novel-keywords.html
  novel-style-report.html
  novel-style-check.html
  novel-fix-plan.html
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
| 能力概览 | `#features` | 能力概览 | 十一张能力卡，每张含隐藏详情面板与子页面链接 |
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

页面数字与链接取自插件仓库的实际状态（v5.0.0）：18 个工具、`bge-small-zh-v1.5` 量化模型约 24MB、Node ≥ 22.3、Glama 评分 B / 18 tools、npm latest 5.0.0。发新版后需同步首屏版本号与胶囊链接、`#trust` 区块、页脚链接。

> **v5.0.0 已改好、尚未推送**（站点是公开在线的，改完后版本号先于发布指向 5.0.0）：全部页面（现 18 个工具页 + 宣传页 + 文档总览）的 JSON-LD `softwareVersion` → 5.0.0；首屏品牌版本号、胶囊内的 Release 链接与文字、`#trust` 的 `latest` → 5.0.0；`16 个工具` / `16 tools` → 18。**新增两个页面**：`tools/novel-chapter-brief.html`（开写包）与 `tools/novel-fix-plan.html`（改稿台），并同步了 `docs.js` 工具清单、`sitemap.xml`、`tools/index.html` 的工具卡与新增的「该调哪个工具」小节、`index.html` 的两张能力卡（能力卡由 9 张变 11 张，`more-8`/`more-9` 之后的编号顺延为 `more-10`/`more-11`）。`tools/novel-plot.html` 增加了 `action: "graph"` 结构视图（不新增工具）。**推送时请与 5.0.0 的 tag 同一次推送**，否则会出现「在线页面写着 5.0.0、Release 与 npm 仍是 4.3.1」的窗口期（与 v4.3.1 那次同型，只是这次窗口不会自动闭合，因为站点改动是提前做好的）。
>
> **同一轮的第二次改动：与落地的 5.0.0 实现对账**（只改站点，未动插件源码、未推送）。要点：① `tools/novel-fix-plan.html` 补回 `mark` 的取值参数 **`state`**（枚举 `done` / `skip`，与 `itemId` 同为必填，缺一报错），并写明 **`mark` 不重新测量、不受「写作助手功能」门禁约束**，而 `plan` / `verify` 依赖六维引擎、开关关闭时拒绝执行；② 逐项对齐 `lib/fixplan.js`：`items[]` 恒为 9 个字段、八类 `type` 的实际判定来源与量级门槛、排序补第四级 `id` 字典序、`verify` 三态改为 `resolved` / `pending` / `new` 并列出 `detail` 的三种文案、指标类段落归因口径（段落须同向且自身出带、每维最多 3 段、退化为全章 0/0 时 severity 降一档）、清单上限 **40 条**（旧文写作「不做上限」）；③ 对齐 `lib/brief.js`：补 `book` 为第 16 个返回字段、`isNext` 的真实语义（目标章文件不存在即为 true）、`openPlots` 收的是 `status !== "done"` 而非 `=== "open"`、`avoid` 实为三类来源（多出「已退场角色」）、`degraded` 元素是**字符串**、`chapter` / `worldview` / `baseline` 三键可整键省略、`skeletons` 实际上限 4 条、`lastVerdict` 是现算而非落盘结论；④ 对齐 `lib/graph.js`：`planVsActual.keywords` 放的是**命中的**子集且命中判定是子串包含、`timelineOrder.issue` 只标在「章号小于此前最大章号」的行上、`absences[].length` 是**连续缺席章数**（与 `threadActivity` 的章号之差口径不同）、`plotLifecycle` 的 `distance` 基准是**全书最大章号**而非 `totalChapters`、排序是 `firstChapter` 升序、`graph` 恒带一个空 `entries: []`、参数补 `absenceThreshold`；⑤ 新增一节「提示词档位与场景」（档位 × 场景正交、场景仅 `full` 档生效、只换提示词不改工具能力、老状态文件落到 `general`，既有工作流不变——仅在其中补入三条新工具的入口指引共 7 行，其余逐字沿用 4.x），并在参数与输出里补 `systemPromptMode` / `promptScene`。
> **v5.1.1（版本号已就绪，尚未发布）**：本站工具页 JSON-LD `softwareVersion` → 5.1.1（18 页）。**本轮只改了客户端 UI 与测试**：面板「提示词场景」的五个按钮此前被 `disabled` 锁死（绑在 `systemPromptMode !== "full"` 上，而默认档位是 off/brief——用户反馈"点不了其他选项"），现改为**始终可点**，并在档位非「完整」时于行内追加一句说明（"场景已保存但暂不注入——把上面的档位切到「完整」即生效"，中英双语）。**首屏品牌版本、Release 胶囊与 `latest` 仍为 5.1.0**（5.1.1 未发布，胶囊不得提前声称已发布——发版后翻正）。`tools/novel-sentence-config.html` 的场景行说明与本次 UI 行为一致，无需新增内容。
> **v5.1.0 已于 2026-09-18 发布**（站点与代码同一次推送）：站点全部工具页 JSON-LD `softwareVersion` → 5.1.0；首屏品牌版本、胶囊 Release 链接与 `#trust` 的 `latest` → 5.1.0；根 `index.html` 的 JSON-LD `softwareVersion` 同步 → 5.1.0（第五轮曾按"未发布"刻意保持 5.0.0，**本轮发布后翻正**）。同时把 v5.1.0 的行为改动写进对应页面：改稿台**上限 40 → 12 条**与**每维只报最严重 1 段**、渲染新增**处理建议**、三类指标 hint 的**软化后缀**；场景提示词三处「必做」改「按需」与**新判据（偏离 ≥2 倍容差才改）**；`novel-style-check` 的 advice 与六维汇总行改措辞（不再说「需修正／请对照基线修正后再续写」）；`novel-sentence-config` 新增 **`leanWorkflow` 精简工作流**（第三个正交维度：档位 × 场景 × 精简工作流）；`novel-new-chapter` 的【基线怎么用】；`novel-chapter-brief` 的开写清单两条改写。
> **v5.0.0 已于 2026-09-17 发布**（站点与代码同一次推送）：本站工具页的 JSON-LD `softwareVersion` → 5.0.0；首屏品牌版本与 `#trust` 的 `latest` → 5.0.0；新增 `tools/novel-chapter-brief.html` 与 `tools/novel-fix-plan.html` 两页；`tools/index.html` 的「该调哪个工具」对照表随 18 工具更新；`sitemap.xml` 收录新页。**实测发版顺序窗口约 2 分钟**：13:49 推送 → 13:49 Pages 部署完成 + GitHub Release 创建（附 CI 构建的 zip）→ 13:52 npm 上出现 `5.0.0` → MCP Registry 紧随其后（13:52 工作流 success）。也就是「胶囊写着已发布」会比 npm 就绪早约 2 分钟——`release.yml` 与 `publish-mcp.yml` 是并发跑的，属正常现象，不必当成失败。
> **第四轮：装机全量实测（18 工具 × 全部 action）后的 4 处修补**（**版本号不变**，仍 5.0.0；只改站点 + 插件源码，未推送）。① `novel_new_chapter` 的 `title` 改为**一并进文件名**（`第NN章 标题.md`，`sanitizeSegment` 剥非法字符 + 截断 24 字，全是非法字符则退回不带标题），`novel_chapters` 增加**一级标题回退** `core.firstHeadingTitle`（`chapterStats` 顺带返回 `heading`，正文已读、零额外 IO）——修掉「写了 title 却在清单里显示空标题」。② `novel-fix-plan` 清单渲染每条待办增加一行 `id：fix-…`（此前要 `mark` 必须先读 `planFile`）。③ `verify` 的**第一轮（id 精确命中）**也拼「（人工标记 done/skip）」，与页面既有描述一致（此前只有按 type 兜底那轮才拼）。④ `mark` 的 `state` 报错区分「没传」与「传了非法值」。**反向确认无误、不改的**：`items[]` 返回体恒为 9 字段（`state`/`stateAt` 只写落盘文件，页面描述正确）、`timelineOrder` 省略 `number` 键被宿主正常接受、留白差值 8.36 < 门槛 12 被正确忽略。
> **第三轮：审查（diff-only 子代理）后的修正**（只改站点 + 插件源码，未推送）。① **契约**：`timelineOrder[]` 的 `number` 从 `required` 移除，`lib/graph.js` 改为**省略**该键而不是写 `null`（宿主 schema 不支持 `type` 数组，写 null 会被 `dropNullDeep` 删键 → 与 required 冲突；`novel-plot.html` 早已写成「解析不出 → 省略」，这轮才让代码追上文档）；`test/e2e-test.mjs` 补一条只有 day/event 的时间线条目做回归。② **取消语义**：`core.isAbort` 提为唯一判据，`graph.js` / `fixplan.js` 的 6 处降级 catch 一律先放行 `AbortError`——此前一次被取消的调用会返回「成功但清单/结构为空」，被误读成「这一章没问题」。③ **口径统一**：容差公式上移为 `core.buildTolerance`（+ `MIN_BASELINE_CHAPTERS` / 小样本下限常量为 `core` 导出），`novel_fix_plan` 与**开写包的 `lastVerdict`** 共用同一实现与同一门槛。④ **清单文件名**：章键改取**解析后的章文件**（`plan("1")` 与 `plan("码头等船")` 不再各写一份，`verify` / `mark` 同口径），`verify` 改为先算再读、以返回值里的 `planFile` 为准。⑤ **开写包锚段**排除目标章自身（与 `novel_fix_plan` 一致）；人物设定行**没有冒号也认**（`novel_outline action=character` 只给名字时写出的正是 `- 名字`，旧正则把它静默丢掉）。⑥ 删死代码（`creationChars` / `inSettings` / `inCreation` / `numberResolved` / `plotIds` 与重复常量），`mcp/README.md` 不再提已删除的 `EXPECTED_TOOL_COUNT`。
> **第五轮：同步刚落地的 5.1.0 行为**（**只改站点，未动插件源码、未推送**；`sitemap.xml` 无页面增删故未改）。**版本口径是刻意的**：5.1.0 尚未正式发布，站点对外仍声称 5.0.0——品牌版本号、胶囊 Release 链接、`#trust` 的 `latest` 与**根 `index.html` 的 JSON-LD `softwareVersion`** 一律保持 5.0.0，只有 `tools/*.html` 的 JSON-LD `softwareVersion` → 5.1.0（18 个页面，每页 1 处；`tools/index.html` 本就没有该字段）。要点：① **改稿台 `lib/fixplan.js`**：`MAX_PARAGRAPH_ITEMS_PER_METRIC` **3 → 1**（同维只报最严重的 1 段，其余由 `summary` 计数体现）、`DEFAULT_MAX_ITEMS` **40 → 12**（含截断备注文案「待办超过 12 条…」与「先处理保留下来的高优先级项」的说明）、`abstractDensity` / `gapIndex` / `hedgeDensity` 三类指标 hint 追加软化后缀「（仅当这里读起来确实别扭才改；抒情、心理、留白段落属正常写法，可标记 skip 保留。）」、`plan` 渲染在 `待办 N 条…` 之后新增一行**处理建议**（分批改 / 一轮 3~5 条 / 不必逐条 mark / 改完最多 verify 一次；返回体形状未变，`items[]` 仍 9 字段）。② **`lib/prompts.js` 三处「必做」改「按需」**：`writing` 的强制自检与「收尾三件」、`revising` 的「逐条处理 + 每批 mark/verify」、通用档的「动笔前必须 style_report / 每章必须 style_check」；并**取消「任一维度出带必改」**，新口径是「偏离达 **2 倍容差**以上、或那一处读起来确实别扭才改」（理由：容差带本身就是 1.5σ，六维里至少一维出带是常见现象）。③ **新增 `leanWorkflow` 精简工作流开关**（`lib/core.js` + `lib/client.js` + `lib/prompts.js`）：布尔、默认 `false`、非法值静默忽略、老状态文件缺键 → `false`（行为同 5.0.0）；侧边栏「写作助手功能」面板「提示词档位」「提示词场景」**下方**新增「精简工作流 / Lean workflow」一行，**任何时候都能切换**（不受 `full` 档限制）；打开后注入 `LEAN_TEXT`（380 字符）且**优先于档位与场景**，`novel_style_report` 与 `novel_sentence_analysis` 在调用方**未显式传 `brief`** 时默认精简输出。`novel-sentence-config.html` 的「档位 × 场景」两维表述统一改为**三维**（档位＝注入多少 × 场景＝注入什么 × 精简工作流＝要不要催促动作）。④ **锚段口径改口**：`anchors` **只用来校准语感**，**不要照 `skeletons` 造句、不要套句式模板**（骨架仅在写不出该类型句子时参考）——`novel-new-chapter.html` 的【风格基线强制流程】改为【基线怎么用】、`novel-chapter-brief.html` 的 `plan.checklist` 三条（首条「读一遍锚段校准语感」、自检改「建议」且「单一维度轻微出带属正常波动，不要为对齐数字改文」、收尾改「按需…确属新埋的伏笔才 `novel_plot add`；钩子与摘要在章节稳定后再回填」）、`novel-style-check.html` 的 `advice` 改为「先判断这是不是有意为之…确实跑偏时才对照 `fixAnchors` 只调整那几处，不要整章重写，也不要为对齐数字改文」。**自查（旧串清零）**：`tools/*.html` 中 `softwareVersion":"5.0.0` **0 处**、`40 条` **0 处**、`每维最多 3 段` **0 处**、`强制流程` **0 处**、`逐条处理` **0 处**、`按此形状造句` / `照此味道写` **0 处**。**已知未改（刻意或超范围）**：`novel-fix-plan.html` 落盘文件的 `version: "5.0.0"` 字段、`tools/index.html:56` 与根 `index.html:56` 的「档位 × 场景两个正交维度」表述（前者页面只允许改 `softwareVersion`，后者只允许不动版本号——两页均不在本轮可改清单内）、README 上一段 5.0.0 记录里的「每维最多 3 段」「清单上限 40 条」（属 5.0.0 史实，不改）。
> **v4.3.1 已于 2026-09-17 发布**（站点与代码同一次推送）：全部工具页（当时 16 个）的 JSON-LD `softwareVersion` → 4.3.1；首屏品牌版本号、胶囊内的 Release 链接与 `#trust` 的 `latest` → 4.3.1；`novel-read` / `novel-chapters` / `novel-continuity-check` 三页各加一个 `v4.3.1` 变更提示块（`.warn.note`），并同步修正 `novel-read` 的查找顺序、`novel-keywords` 的章节解析顺序、`novel-summary` 的同章号共用槽位说明。**注意发版顺序**：站点与 tag 同一次推送时，Pages 重建与 CI 发包是并发的，会有 1–3 分钟窗口内「胶囊写着已发布但 Release/npm 还没就绪」。

技术文档子页面的参数与公式均取自插件源码（`lib/index.js`、`lib/analysis.js`、`lib/style-metrics.js`、`lib/embedding.js`、`lib/core.js`、`lib/brief.js`、`lib/fixplan.js`、`lib/graph.js`、`lib/prompts.js`、`mcp/server.mjs`），改动实现后请同步更新对应页面。
