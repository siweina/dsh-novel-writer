/**
 * dsh-novel-writer — core/domain.js（Layer 3 兼容 barrel：透传 6 个严格 DAG 子模块的全部导出）
 *
 * 分层（严格无环，只允许上层依赖下层）：
 *   3A. ./stores.js         —— 伏笔/设定/按书创作设定/摘要存储与归一
 *       ./lexicon.js        —— 必用词表（全局/书级合并、导入格式化、成稿覆盖率与替身词审计）
 *       ./rules.js          —— 文化/题材/流派检测、子串守卫与世界观用语规范单一裁决点
 *       ./baseline.js       —— 风格基线范围、容差带、参照集/诊断集、动作链与原著锚包
 *   3B. ./analysis-cache.js —— 语义裁决、隐性情感增强与逐章/全书分析缓存（依赖 ./rules.js）
 *       ./creation.js       —— 创作资料目录/大纲工具与章节衔接检测（依赖 ./stores.js）
 */

export * from "./stores.js";
export * from "./lexicon.js";
export * from "./rules.js";
export * from "./baseline.js";
export * from "./analysis-cache.js";
export * from "./creation.js";
