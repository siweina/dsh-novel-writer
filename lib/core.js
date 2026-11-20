/**
 * dsh-novel-writer — 宿主端共享层 barrel 入口（自单文件拆分为严格 DAG 四子模块）
 *
 * 分层（严格无环，只允许上层依赖下层）：
 *   1. ./core/state.js  —— 版本、参数校验、路径/根解析、功能/工具开关、状态与事务锁
 *   2. ./core/text.js   —— 文本解码、章节扫描/解析、关键词、草稿镜像、正则安全与格式化
 *   3. ./core/domain.js —— 语义裁决、文化/题材/语用规则、基线与锚包、伏笔/设定/词表/摘要/大纲
 *   4. ./core/http.js   —— 本地 HTTP 路由与请求体安全读取（makeStateRoutes 等）
 *   5. ./packs.js       —— 外置 JSON 题材规则包（内置包 + 书库自定义包、热加载与正则门禁）
 *
 * 100% 透传既有全部导出符号（零行为变更）。
 */

export * from "./core/state.js";
export * from "./core/text.js";
export * from "./core/domain.js";
export * from "./core/http.js";
export * from "./packs.js";
