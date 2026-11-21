# dsh-novel-writer 架构地图

> 面向开发者与 AI 协调器的 10 秒模块边界指南：先看边界与主干流，再定位具体模块，严禁跨越构建产物与 DAG 单向边界。

## ① 源码 vs 构建产物 vs 工具边界表

| 类别 | 路径 | 边界与维护规则 |
| --- | --- | --- |
| 产品后端 | `lib/`、`mcp/`、`antigravity/`、`skills/` | DSH 插件主体、`mcp/server.mjs`（stdio MCP）、`antigravity/`（Sidecar）、`skills/` 技能包 |
| 前端源码 | `client/`（39 JS + 3 CSS） | 分 `core/`、`icons/`、`uikit/`、`styles/`、`i18n/`、`controller/`、`components/`、`views/`、`host/`；**改 UI 只能改这里** |
| 构建产物 | `lib/client.js` | **自动构建产物，严禁直接手改**；由 `node tools/build-client.mjs` 从 `client/` 确定性装配 |
| 终端安装器 | `tools/install-desktop.mjs`、`tools/install-antigravity-ui.mjs` | 本地安装脚本（DSH Desktop profile / Antigravity Sidecar UI，默认 dry-run） |
| 开发与发布脚本 | `tools/build-client.mjs`、`tools/ui-audit.mjs`、`tools/check-release.mjs`、`tools/bump-version.mjs`、`tools/mutation-test.mjs`、`tools/package-release.mjs`、`tools/release-notes.mjs`、`tools/visual/` | 客户端构建与一致性检查、UI 规则审计、发布门禁、版本同步、变异测试、发布打包、Release 摘要、视觉回归 |
| 文档与测试 | `docs/`、`test/`（47 套测试） | `docs/` 为 GitHub Pages 文档站（不随插件打包）；`test/` 为 `node:test` 全量回归与架构守护测试 |

## ② 跨层主干数据流

```text
DSH 宿主 / MCP Server (mcp/server.mjs) / 独立 Web UI (lib/web-ui.js) / Antigravity Sidecar (antigravity/)
   │
   ▼
lib/index.js（22 工具注册 + 审计 + { when } 可见性 + 流兜底）
   ├── lib/tools/*（7 个领域工具模块，单向依赖 lib/tools/shared.js）
   └── lib/core/http.js（13 条 UI HTTP 路由，与 lib/web-ui.js、lib/tools/system.js 强耦合）
   │
   ▼
引擎与工作流层（analysis / style-metrics / vibe / chapter-diagnose / fixplan / brief / audit / graph / embedding / vector-audit / explicit / obligations / bookdelete）
   │
   ▼
底座与存储层（lib/core/* DAG Layer 1→4 + lib/packs.js Layer 5 + lib/db.js `cache.sqlite` + lib/log.js `events.jsonl` + lib/trash.js）
```

## ③ `lib/` 全目录清单与一句职责

> **关键消歧**：
> - `lib/client.js`：**自动生成产物，严禁手改**；改动请改 `client/` 后重建。
> - `lib/diagnose.js`（系统健康体检与 `novel_diagnose`）vs `lib/chapter-diagnose.js`（单章文风症状诊断与分位对照）。
> - `lib/core/http.js`：Web UI 13 条 HTTP 路由后端，逻辑与 `lib/web-ui.js`、`lib/tools/system.js` 强耦合。
> - `lib/core/domain.js`：纯兼容透传桶（< 40 行），实际拆分在 Layer 3A/3B 6 个子模块：`stores.js`、`lexicon.js`、`rules.js`、`baseline.js`、`analysis-cache.js`、`creation.js`。

### 顶层模块 `lib/*.js`（27 个）

| 模块 | 一句职责 |
| --- | --- |
| `lib/index.js` | 插件主入口：`apply`/`inject` 协议、22 工具注册、`{ when }` 可见性、审计与流兜底 |
| `lib/manifest.js` | 零依赖纯声明式清单单一事实源（冻结 `ALL_TOOLS` 等元数据，防循环依赖） |
| `lib/node-version.js` | 零依赖 Node.js 运行时版本门禁（校验 `>= 22.13.0` 以启用 `node:sqlite`） |
| `lib/core.js` | 宿主端共享层 DAG barrel 入口（透传 `lib/core/*` 与 `lib/packs.js`） |
| `lib/client.js` | **生成产物勿改**：前端客户端装配包（源码位于 `client/`） |
| `lib/web-ui.js` | 独立 Web UI HTTP 服务与 Antigravity Sidecar 适配器（托管 `client.js` 与 `/api/`） |
| `lib/db.js` | `node:sqlite` 本地缓存层（管理 `cache.sqlite`，仅依赖 Node 内置与 `lib/log.js`） |
| `lib/log.js` | 本地脱敏事件日志（`events.jsonl` 追加写与共享脱敏读取，零业务依赖且永不抛错） |
| `lib/trash.js` | 零内部依赖回收站公共机制（目录定位、条目校验、清单与跨卷移动） |
| `lib/bookdelete.js` | 按书删除：跨目录与 SQLite 清理整书全部关联资料，默认移入回收站 |
| `lib/prompts.js` | 系统提示词文本（写作工作流档位/场景模板与非净化模式直白指令） |
| `lib/rawguard.js` | 非净化模式（`rawWriting`）`llm/stream` 动笔软刹车自动重试闸门 |
| `lib/analysis.js` | 句式模式分析引擎（九类句式、转移规律、情感曲线与风格指纹，纯规则） |
| `lib/style-metrics.js` | 文笔六维量化测量、场景分类与基线对照引擎 |
| `lib/vibe.js` | 12 轴氛围光谱聚合层（汇总多规则与语义隐性情感输出） |
| `lib/explicit.js` | 直白度与淡化标记密度测量（统计跳过/黑场/代称等写法密度） |
| `lib/embedding.js` | `onnxruntime-web` WASM 本地语义嵌入引擎（懒加载与纯规则降级） |
| `lib/vector-audit.js` | 本地 512 维向量审计（原地打转与大纲漏写，仅在 `novel_fix_plan` 触发） |
| `lib/brief.js` | 开写包引擎（单次聚合上章/大纲/人物/伏笔/规范/基线，纯本地可降级） |
| `lib/obligations.js` | 大纲子句义务切分（子句切分、动词元类别判定与填空格式约束） |
| `lib/chapter-diagnose.js` | 单章文风症状诊断与大纲履行检查单一裁决点（无参照分位只报结构症状） |
| `lib/fixplan.js` | 改稿台：把诊断数据转为优先级待办清单、定位排序与复测核销 |
| `lib/audit.js` | 对抗性审计：可机器判定契约检查、独立 AI 任务书与证据链复核 |
| `lib/graph.js` | 跨章只读结构视图（伏笔周期、人物出场矩阵、剧情线空档、时间线与大纲对照） |
| `lib/diagnose.js` | 系统健康体检与 `novel_diagnose` 报告聚合（汇总脱敏事件日志与环境状态） |
| `lib/update-check.js` | GitHub Releases 更新检查（24h 缓存 / 5min 负缓存 / 3s 超时静默失败） |
| `lib/packs.js` | Layer 5：外置 JSON 题材规则包管理（内置包 + 自定义包热加载与正则门禁） |

### 共享底座 `lib/core/*.js`（10 个，严格无环 DAG）

| 模块 | DAG 层 | 一句职责 |
| --- | --- | --- |
| `lib/core/state.js` | Layer 1 | 基础状态、参数校验、路径/根解析、功能开关、状态读写与事务锁 |
| `lib/core/text.js` | Layer 2 | 文本解码、章节扫描/解析、关键词、草稿镜像、正则安全与输出格式化 |
| `lib/core/domain.js` | Layer 3 | **纯兼容透传桶**：仅 `export *` 转发以下 6 个 Layer 3A/3B 子模块 |
| `lib/core/stores.js` | Layer 3A | 伏笔表、设定表、按书创作设定与章节摘要持久化与归一 |
| `lib/core/lexicon.js` | Layer 3A | 必用词表（全局/书级合并、导入格式化、开写包取用与成稿审计） |
| `lib/core/rules.js` | Layer 3A | 文化/题材/流派检测、碰撞守卫与世界观用语规范单一裁决点 |
| `lib/core/baseline.js` | Layer 3A | 风格基线范围、容差带、参照集/诊断集、动作链与原著锚包 |
| `lib/core/analysis-cache.js` | Layer 3B | 语义裁决、隐性情感增强与逐章/全书分析缓存（依赖 `rules.js`） |
| `lib/core/creation.js` | Layer 3B | 创作资料目录/大纲工具与章节衔接检测（依赖 `stores.js`） |
| `lib/core/http.js` | Layer 4 | Web UI 13 条本地 HTTP 路由后端与文件管理器启动（耦合 `web-ui.js`/`system.js`） |

### 工具域与内置资产 `lib/tools/*.js`（7 个）+ `lib/lexicons/` + `lib/packs/`

- `lib/tools/shared.js`（单向纯辅助，禁引其它工具模块）｜ `lib/tools/library.js`（书库/阅读/关键词/导入/按书删除）｜ `lib/tools/writing.js`（建章/开写包/草稿镜像/大纲/必用词表）
- `lib/tools/style.js`（句式分析/风格自检/风格画像/改稿台）｜ `lib/tools/story.js`（设定/摘要/伏笔/结构图/语义检索）｜ `lib/tools/continuity.js`（连贯性审计/用语扫描）｜ `lib/tools/system.js`（开关配置/诊断/UI 路由装配/技能提供）
- `lib/lexicons/`（词库与守卫：`collocation-guards.js`、`dutir_seven.json.gz`、`guards.js`、`markers.js`、`slop.js`、`webnovel-tropes.md`）｜ `lib/packs/`（5 个内置题材包 JSON）｜ `lib/models/`（本地离线模型）

## ④ 前端 `client/` 映射与常用校验命令

- **前端模块分布（39 JS + 3 CSS）**：`core/`（5 JS：HTTP/运行时/图标胶水/原语适配/样式注入）→ `icons/`（6 JS）→ `uikit/`（2 JS）→ `styles/`（3 CSS：`base.css`、`components.css`、`overrides.css`）→ `i18n/`（3 JS）→ `controller/`（6 JS）→ `components/`（3 JS）→ `views/`（12 JS）→ `host/`（2 JS：`apply.js`、`mount.js`）。
- **常用校验命令**：
  - `npm run build` — 从 `client/` 重新构建 `lib/client.js`
  - `npm run build:check` — 校验 `lib/client.js` 与 `client/` 源码构建一致性（不写盘）
  - `node tools/ui-audit.mjs lib/client.js` — 前端产物 11 条 UI 规则审计
  - `node tools/check-release.mjs` — 校验版本号一致与发布边界约束
  - `npm test` / `npm run check` — 运行全部 47 套测试，或串联执行 `build:check && check-release && test`
