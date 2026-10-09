# tools/visual — dsh-novel-writer 客户端 UI 视觉验收装置

> **dev-only 独立工作区**（契约 §2.1）。它不参与插件发布（根 `package.json` 的 `files` 不含 `tools/`），
> 也不影响插件 `npm ci` 的依赖面（依赖装在本目录自己的 `package.json` 里）。
> **除 `tools/visual/**` 外，本装置不改动仓库任何文件**：它只读 `lib/client.js`（复制成快照）与 desktop asar。

## 这个装置解决什么问题

`lib/client.js` 的一次 UI 重构需要一个**可重复、确定性**的视觉基线：把插件在
**真实浏览器 + 真实 React 18.3.1 + 真实 DOM** 里渲染出来，逐个进入它的 9 个视图并截图，
用于重构前后逐像素比对。

不是单元测试的替代品：`test/client-test.mjs` 用 React 桩验证**行为契约**；本装置用真 React 验证**外观与渲染不炸**。

## 目录结构

```
tools/visual/
  package.json            # private:true，独立依赖（react / react-dom 18.3.1 严格同版）
  prepare.mjs             # ① 复制 lib/client.js → snapshot/ ② 复制 react/react-dom 的 UMD → vendor/
  probe-asar.mjs          # 只读解析 desktop 线 app.asar（list / cat / dump / grep）
  extract-tokens.mjs      # 从 asar 的 ui-theme 包抽出官方 --dsw-* 令牌 CSS → host/host-tokens.css
  fixture.html            # 渲染页面（加载顺序即契约，见文件头注释）
  fixture-boot.js         # 桩 fetch + 造 ctx + apply(ctx) + 用真 React 渲染官方 main 席位 + 视图驱动 API
  capture.mjs             # Playwright：系统 Chrome 逐视图截图 + 联络表 + manifest.json
  compare-runs.mjs        # 两次 capture 的逐字节一致性复核（比 sha256 + 像素尺寸）
  host/                   # 宿主令牌层（生成物，已提交，保证离线可重复）
    theme-client.js       #   asar 内 @deepseek-ai/dsh-client-ui-theme/lib/client.js 原件（抽取源）
    theme-package.json    #   该包 package.json（版本溯源）
    host-tokens.css       #   extract-tokens.mjs 生成；文件头写明来源路径 + 版本 + sha256
  vendor/                 # react.js / react-dom.js（UMD 生产构建，从 node_modules 复制）
  snapshot/               # client.js（lib/client.js 的快照）+ meta.json（sha256/字节/行数/mtime）
  shots/                  # 截图 + manifest.json（可被 --out 改到别的目录）
```

## 从零到出图（可复现命令）

```powershell
cd F:\doment\dnw-work\tools\visual

# 0) 一次性：装依赖（需要外网代理）——react 与 react-dom 必须同版 18.3.1
$env:HTTPS_PROXY='http://127.0.0.1:7890'; $env:HTTP_PROXY='http://127.0.0.1:7890'
npm install

# 1) 一次性（或宿主主题升级时）：从 desktop asar 抽官方 --dsw-* 令牌层
node probe-asar.mjs dump "dsh-client-ui-theme/lib/client.js" host/theme-client.js
node probe-asar.mjs dump "dsh-client-ui-theme/package.json" host/theme-package.json
node extract-tokens.mjs

# 2) 日常：快照 client.js → 截图（快照每跑一次都会重新复制，manifest 记录其 sha256）
node capture.mjs                 # 产物在 shots/
node capture.mjs --out shots-b   # 换目录（用于确定性复核，见下）
node capture.mjs --reuse-snapshot  # 复用已有快照（对比"同一份产物"的前后差异时用）

# 3) 确定性复核：两次运行逐字节一致
node capture.mjs --out shots-run2
node compare-runs.mjs shots shots-run2
```

## 已实测的两条硬结论

**① 确定性**：两次独立运行（各自的 Chrome 进程、各自的 browser context、各自重新快照）产出的
**28/28 张 PNG 逐字节一致**（`compare-runs.mjs` 直接比对 sha256 + 像素尺寸 + 字节数）：

```
运行 A = shots（28 张）    运行 B = shots-run2（28 张）
client.js 快照 sha256 相同: true (5a8c21b63b3cd3eb…)
差异 0 张 | B 缺失 0 张 | A 多出 0 张
RESULT: 逐字节一致（28/28）
```

**② 不伪造**：把 `snapshot/client.js` 换成一个 `factory` 直接抛错的假产物后跑 capture：

```
[prepare] client.js 快照 sha256 = 5a8c21b6…        ← 以磁盘实际快照为准
node : capture 失败: Error: fixture 未就绪（error）: Error: intentional-broken-factory-probe
EXIT=1     → shots-broken/ 内 **0 张图**（连目录都没建）
```

即：渲染不出来就是**退出码 1 + 零截图**，不会留下一张"看起来正常的空面板"。
（快照随后已从备份恢复，sha256 与 `lib/client.js` 仍完全一致。）

## 环境依赖（均已实测存在）

| 项 | 位置 | 用途 |
|---|---|---|
| Playwright | `C:\Users\zg\.dsh\profiles\desktop\node_modules\playwright`（1.63.0-alpha） | 复用，**不下载浏览器**；可用 `NW_PLAYWRIGHT` 覆盖 |
| Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe` | 唯一浏览器，`file://` 直开，**零外网**；可用 `NW_CHROME` 覆盖 |
| desktop asar | `…\DeepSeek Harness\resources\app.asar` | 只读源：官方 `--dsw-*` 令牌（契约 §1 唯一权威线） |

`capture.mjs` 会断言**所有网络请求均为 `file://` / `data:`**（manifest `checks.noExternalRequests`），
并把 fetch 全量桩掉，因此整条链路离线可跑。

## 截图规格

| 维度 | 取值 | 理由 |
|---|---|---|
| 宽度 | **720px** | `.nwPanelMain{max-width:760px;padding:28px 24px}` → 720 是"主栏常见宽度"下不被 max-width 钳制的真实工作宽度（内容 672px） |
| 宽度 | **380px** | 覆盖窄主栏/分屏：`max-width` 不再生效、纯弹性收缩，行内固定宽控件（220px 输入框、74px 容差框）的换行/挤压行为会暴露出来 |
| 高度 | **900px** | 固定视口，保证同一视图两次截图的像素网格完全对齐（面板内容常高于 900，固定模式只截可视区） |
| 模式 | `fixed`（视口即截图） | 逐像素比对主用；`manifest.shots[].contentHeight` 记录真实内容高，"有多少内容没入镜"可查 |
| 模式 | `full`（仅 720 宽，整页） | 内容审阅主用：9 个视图的完整排布（main 1638px / tools 2104px / lexicon 1683px…） |

9 视图 × 2 宽度 = 18 张固定截图，+ 9 张 720 整页截图，+ 1 张宿主降级截图（`main-hostdown-720x900.png`），
+ 2 张联络表 = **30 个 PNG**（`manifest.shots` 记 28 条，联络表单列在 `manifest.contactSheets`）。

### `shots/manifest.json` 的关键字段

| 字段 | 含义 |
|---|---|
| `shots[].view` / `.file` / `.width` / `.height` / `.bytes` | 视图名 → 文件路径 / 像素尺寸 / 字节数（尺寸读自 PNG 头，不靠脚本自报） |
| `shots[].sha256` | 该图内容哈希（逐像素比对的锚点） |
| `shots[].capturedAt` | 该图落盘时间戳（ISO） |
| `shots[].clientSnapshotSha256` | **拍这张图时** `lib/client.js` 快照的 sha256（每行自证） |
| `shots[].mode` / `.driver` / `.contentHeight` / `.textLength` | 固定/整页；怎么进的视图；真实内容高（是否被裁）；可见文本长度（是否真渲染出内容） |
| `clientSnapshot` | 快照来源/版本/字节/行数/源文件 mtime/sha256 |
| `fixture` | 宿主令牌 CSS 路径 + 其 sha256 + 抽取来源；原语路径（official/fallback）；localStorage 可用性 |
| `checks` | 6 条自检布尔：9 视图齐全 / 两个宽度都有 / 零外网请求 / 零插件告警 / 零 console.error / 降级图存在 |
| `diagnostics` | 席位注册结果、fetch 次数、导航日志、插件告警原文、渲染异常原文 |
| `failures` | 任何失败的视图与原因（空 = 全部成功） |

## 9 个视图怎么进（`fixture-boot.js` 的 NAV_LABEL / 驱动方式）

视图切换**优先走真实 DOM 点击**（与真机路径一致），点不到才退回 `controller.openView`，
manifest 的 `shots[].driver` 如实记录用了哪条路：

| 视图 | 驱动 | 说明 |
|---|---|---|
| `main` | `api:reset` | 默认视图 |
| `features` / `tools` / `baseline` / `creation` / `lexicon` | `click:nav` | 点击主面板 `.nwNavEntry` 导航行（文案取自插件自己的 zh 词典） |
| `model` | `click:features→model` | 功能开关页 → 「⚙ 管理语义模型」按钮（`.nwModelBtn`） |
| `creation-form` | `click:creation→form` | 原创模式列表 →「长夜将至」行的「编辑」chip |
| `reports` | `click:reports-entry` | **必须真点**：报告数据由主面板入口的 `onClick` 拉取，直接 `openView("reports")` 只会得到「加载中」 |

`tools` 视图额外播一个状态覆盖（`VIEW_SEED.tools`）：把三个工具分组展开，
否则默认全折叠，截图里只有三行标题、看不到真实信息密度。

## 加一个新视图

只有两处（都在 `tools/visual/` 内）：

1. `capture.mjs` 的 `VIEWS` 数组加视图名；
2. `fixture-boot.js` 里按需加两处：`NAV_LABEL`（有主面板导航行时）+ `VIEW_SEED`（需要预置 UI 状态时）。
   若该视图的数据靠某个入口按钮的 `onClick` 拉取，在 `gotoView()` 里加一个 `else if` 分支照 `reports` 的写法真点。

## 已知限制（诚实清单）

1. **官方原语走的是插件的回退实现**。`@deepseek-ai/dsh-client-ui-primitives` 在 desktop asar 内（ESM + 大量
   `*.module.css`），本装置以 `file://` + 经典脚本运行，无法加载 ESM 依赖图（`file://` 下 ESM 被 CORS 拦）。
   因此 `NW_UI.available === false`，面板用插件自注入 CSS + `nw*` 类名渲染。
   **对重构比对是自洽的**（前后用同一装置），但**不等于真机的官方原语外观**。
   留了口子：只要在 `fixture.html` 里于 `fixture-boot.js` 之前挂 `window.__NW_PRIMITIVES__`，
   `requireShim` 就会改用官方原语路径，`manifest.fixture.primitivesPath` 会记成 `official`。
2. **没有真宿主**：`slots` / `locale` / `layout` 都是最小实现。9 个视图全部拿到了；
   但下列状态无法复现，因为它们的输入来自宿主进程而不在前端：
   真实模型就绪态的**中间态**（`embeddingStatus` 里 loaded/error 三态只能挑一个）、
   真实章节文件解码错误（`booksStats[].decodeErrors`）、宿主侧 `settings.plugin.item` 命名空间未注册导致设置卡片**不渲染**
   （真机当前行为；本装置同样不渲染该卡片）、宿主 `layout.selectPanel` 的真实切换动画。
3. **有数据的视图靠定值响应**：`fixture-boot.js` 用常量（无 `Date.now()`、无随机数）桩掉
   `/state`、`/lexicon`、`/reports`、`/demo`、`/reveal`、`/update-check`。
   换数据只需改那一个常量块；**不要**引入时间戳，否则确定性失效。
4. **弹窗/中间态不在基线内**：`rawModal`（非净化确认）、`rawPromiseOpen`（承诺输入）、
   `reports` 的报告正文展开、`lexicon` 的批量导入区展开，当前都没有单独截图。
   它们都能用同一套机制补：在 `VIEW_SEED` 里加 `{ rawModal: true, rawCountdown: 3 }` 之类即可。
5. **字体依赖本机**：用宿主令牌的 `--dsw-font-family`（Windows 上落回本机中文字体）。
   同一台机器 + 同一 Chrome 版本逐字节可复现；**换机器/换 Chrome 大版本时中文抗锯齿可能不同**，
   这也是启动参数里固定 `--disable-lcd-text --font-render-hinting=none --force-color-profile=srgb --hide-scrollbars` 的原因。
6. **`--hide-scrollbars`** 是刻意的：`.nwPanelMain` 自带 `scrollbar-gutter:stable`，隐藏滚动条不会造成内容横移，
   但能消除滚动条样式带来的跨机器差异。
7. **动画被关掉**：`reducedMotion:"reduce"`（插件自身的 9 视图过渡就在这个媒体查询门内）+ fixture 里
   `animation/transition:none !important` 兜底 + Playwright `animations:"disabled"`。截图是**静态终态**，不含过渡中间帧。

## 为什么必须先复制快照再渲染

`lib/client.js` 正被另一个 agent 并发重建。fixture 只加载 `snapshot/client.js`，
`capture.mjs` 每次开跑前重新复制并记下 sha256（写进 `manifest.clientSnapshot`），
因此「这批图是用哪一版产物拍的」永远可追溯，也不会读到半成品。
比对"重构前 vs 重构后"时：重构前用 `--reuse-snapshot` 冻结快照，重构后再重新快照。
