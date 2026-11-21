/**
 * dsh-novel-writer — 宿主端共享层 barrel 入口（自单文件拆分为严格 DAG 子模块）
 *
 * 分层（严格无环，只允许上层依赖下层）：
 *   1.  ./core/state.js          —— 版本、参数校验、路径/根解析、功能/工具开关、状态与事务锁
 *   2.  ./core/text.js           —— 文本解码、章节扫描/解析、关键词、草稿镜像、正则安全与格式化
 *   3A. ./core/stores.js         —— 伏笔/设定/按书创作设定/摘要存储与归一
 *       ./core/lexicon.js        —— 必用词表（全局/书级合并、导入格式化、成稿覆盖率与替身词审计）
 *       ./core/rules.js          —— 文化/题材/流派检测、子串守卫与世界观用语规范单一裁决点
 *       ./core/baseline.js       —— 风格基线范围、容差带、参照集/诊断集、动作链与原著锚包
 *   3B. ./core/analysis-cache.js —— 语义裁决、隐性情感增强与逐章/全书分析缓存（依赖 ./rules.js）
 *       ./core/creation.js       —— 创作资料目录/大纲工具与章节衔接检测（依赖 ./stores.js）
 *       (./core/domain.js 作为 Layer 3 兼容 barrel 透传 3A/3B 全部导出)
 *   4.  ./core/http.js           —— 本地 HTTP 路由与请求体安全读取（makeStateRoutes 等）
 *   5.  ./packs.js               —— 外置 JSON 题材规则包（内置包 + 书库自定义包、热加载与正则门禁）
 *
 * 100% 透传既有全部导出符号（零行为变更）。
 */

export * from "./core/state.js";
export * from "./core/text.js";
export * from "./core/domain.js";
export * from "./core/http.js";
export * from "./packs.js";
