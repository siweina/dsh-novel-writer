# 客户端模块化源码 (`client/`)

本目录存放浏览器端插件 `lib/client.js` 的全部模块化源码（共 39 个 JS 模块 + 3 个 CSS 文件，零 `V6-` 前缀）。所有前端 UI、控制器、样式与多语言改动都应直接维护本目录，不要直接手改产物 `lib/client.js`（首行标有 `AUTO-GENERATED`）。

## 构建命令

- 构建产物：`npm run build`（即 `node tools/build-client.mjs`）
- 一致性校验：`npm run build:check`（即 `node tools/build-client.mjs --check`，只校验不写盘）

构建脚本零第三方依赖，在写盘前会执行全套门禁：清单完整性检查、递归孤儿 `.js`/`.css` 文件检查、单模块 `vm.Script` 语法校验、CSS 片段禁用反引号/`${` 检查、`i18n/zh.js` 与 `i18n/en.js` 键对称校验、完整产物 `vm.Script` 校验，以及 Hook 调用点/启动安全/CSS 颜色字面量不变量校验。

## 目录结构与装配顺序

1. **核心运行时与样式注入（`core/`）**
   - `core/runtime.js`：模块级变量、规则包文本解析与序列化、`safeConfirm`、`react` / `react_dom_client` 引用。
   - `core/primitives-adapter.js`：官方 UI 原语包适配层（`createNovelWriterUI` / `NW_UI`，带本地安全回退）。
   - `core/icons-glue.js`：`nwGlyph`、`nwIconEls` SVG 图标挂载胶水。
   - `core/style-inject.js`：向 `document.head` 注入或刷新 `style[data-plugin-css="dsh-novel-writer"]`。
   - `core/http.js`：API 路由常量、超时 `fetchWithTimeout`、错误分类与状态/报告/删书请求封装。
2. **图标表（`icons/`）与 UIKit 包装（`uikit/`）**
   - `icons/a.js`、`icons/b1a.js`、`icons/b1b.js`、`icons/b2.js`、`icons/c.js`、`icons/d.js`：分组 SVG 图标表（构建器自动合并为 `NW_ICONS`，包裹在 `client:icons` 标记内）。
   - `uikit/rows.js`、`uikit/wrappers.js`：UIKit 行与容器包装函数（包裹在 `client:uikit` 标记内）。
3. **样式表片段（`styles/`）**
   - `styles/base.css`：基础样式规则（位于 `client:css` 之前）。
   - `styles/components.css`：UI 组件与面板视图样式片段（嵌入 CSS 模板的 `client:css` 标记内）。
   - `styles/overrides.css`：挂载覆盖样式、页面切换动画、下拉菜单与书库根编辑行样式（位于 `client:css` 之后）。
4. **国际化词典（`i18n/`）**
   - `i18n/zh.js`：简体中文词条字典 `zh`。
   - `i18n/en.js`：英文词条字典 `en`（构建时强制与 `zh` 键集合完全一致）。
   - `i18n/index.js`：语言探测与 `t(key)` 查词出口。
5. **状态控制器（`controller/`）**
   - `controller/lexicon.js`：必用词表状态通道（`attachLexiconController`）。
   - `controller/baseline.js`：风格基线范围与容差通道（`attachBaselineController`）。
   - `controller/diagnose.js`：诊断、度量口径与对抗性审计通道（`attachDiagnoseController`）。
   - `controller/packs.js`：题材规则包工作室通道（`attachPacksController`）。
   - `controller/trash.js`：非净化模式弹窗与回收站/删书通道（`attachTrashController`）。
   - `controller/index.js`：`createController` 主控制器工厂与防抖/订阅/下拉全局监听管理。
6. **共享 UI 组件（`components/`）**
   - `components/sidebar-entry.js`：传统侧边栏入口挂载与观察器管理（`mountSidebarEntry`）。
   - `components/controls.js`：`Switch`、`SelectMenu`、`StorageDisclosure` 与 `conversationColumn`。
   - `components/delete-shared.js`：删书预览/结果共享渲染块与确认门禁辅助函数。
7. **面板视图（`views/`）**
   - `views/helpers.js`：工具分组/预设常量、图标映射与 `createPanelHelpers`。
   - `views/home.js`：主面板工作台视图（`renderHomeView`）。
   - `views/tools-features.js`：功能开关、工具开关与语义模型管理视图。
   - `views/lexicon.js`：必用词表管理视图（`renderLexiconView`）。
   - `views/baseline.js`：风格基线与分场景基线视图（`renderBaselineView`）。
   - `views/reports.js`：分析报告浏览视图（`renderReportsView`）。
   - `views/creation.js`：原创模式创作资料视图（`renderCreationView`）。
   - `views/diagnose.js`：书库体检诊断、旧口径重建与对抗性审计视图（`renderDiagnoseView`）。
   - `views/trash.js`：回收站与按书删除视图（`renderTrashView`）。
   - `views/packs.js`：题材规则包列表、编辑器与导入体检视图。
   - `views/dialogs.js`：模态确认/分享/彻底删除对话框（`renderPanelDialog`）。
   - `views/panel.js`：`PanelView` 根视图与顶部栏调度器。
8. **宿主接入与导出（`host/`）**
   - `host/mount.js`：设置页卡片、传统浮动面板与官方席位（`sidebar.panellist` + `main`）注册。
   - `host/apply.js`：`inject`、`apply` 生命周期主入口以及 `exports.apply` / `exports.inject` / `exports.__internals` 导出。

全部路径均相对脚本所在仓库目录解析，不依赖当前工作目录或外部环境。
