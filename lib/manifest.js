/**
 * lib/manifest.js —— 零依赖纯声明式清单模块（单一事实源）。
 *
 * 约定：本模块严禁导入项目内任何其他模块，避免与 core.js / bookdelete.js / diagnose.js
 * 之间出现循环依赖；所有导出均为冻结的只读数据结构。
 */

/** 全量 MCP 工具名称清单（与 lib/core.js 声明及运行入口逐项逐序一致，共 22 项）。 */
export const ALL_TOOLS = Object.freeze([
  "novel_books", "novel_chapters", "novel_read", "novel_keywords", "novel_new_chapter",
  "novel_import", "novel_sentence_analysis", "novel_sentence_config", "novel_style_check", "novel_plot",
  "novel_settings", "novel_summary", "novel_continuity_check", "novel_semantic_search", "novel_style_report",
  "novel_outline",
  // v5.0.0：写作能力层——开写包（动笔前装配材料）与改稿台（诊断转待办）
  "novel_chapter_brief", "novel_fix_plan",
  // v6.2.0：必用词表（专有词/偏好词的书级+全局两层登记、批量导入与成稿用词审计）
  "novel_lexicon",
  // v6.6.0：诊断（读本地事件日志 + 体检，把「平时看不出来的问题」讲成人话）
  "novel_diagnose",
  // v6.8.0：按书删除（正文 + 创作资料 + 全部关联资料，移入回收站可恢复）
  "novel_delete_book",
  // v7.3.0：实时聊天写作的草稿镜像（逐段写入独立目录，不碰正式章节文件）
  "novel_draft"
]);

/** 工具英文名 → 面板/诊断用中文短标签（与 lib/core.js 的 TOOL_LABELS 逐项一致）。 */
export const TOOL_LABELS = Object.freeze({
  novel_books: "作品列表", novel_chapters: "章节清单", novel_read: "阅读章节", novel_keywords: "关键词分析",
  novel_new_chapter: "新建章节", novel_import: "稿件导入", novel_sentence_analysis: "句式模式分析",
  novel_sentence_config: "开关配置", novel_style_check: "风格自检", novel_plot: "伏笔登记",
  novel_settings: "设定管理", novel_summary: "章节摘要", novel_continuity_check: "连贯性审计",
  novel_semantic_search: "语义检索", novel_style_report: "风格画像", novel_outline: "创作资料",
  novel_chapter_brief: "开写包", novel_fix_plan: "改稿台", novel_lexicon: "必用词表",
  novel_diagnose: "诊断报告", novel_delete_book: "按书删除", novel_draft: "草稿镜像"
});

/** 永远可见、不允许在配置里被关闭的工具清单（配置开关自身）。 */
export const ALWAYS_VISIBLE_TOOLS = Object.freeze(["novel_sentence_config"]);

/**
 * `.novel-writer/` 下**平铺按书命名**的数据子目录白名单（精确 9 项，用于按书删除）。
 * 注意：`trash/`（回收站）、`drafts/`（按书独立子目录，由按书删除单独登记为 data:drafts）
 * 与书库级共享目录不进入本表。
 */
export const BOOK_DATA_SUBDIRS = Object.freeze([
  "analysis", "audits", "baseline", "embedding", "lexicon", "plots", "settings", "style-reports", "summaries"
]);

/** 平铺按书数据子目录 → 中文短标签（用于按书删除预览与报告）。 */
export const BOOK_DATA_SUBDIR_LABELS = Object.freeze({
  analysis: "分析缓存",
  audits: "改稿/审计报告",
  baseline: "风格基线",
  embedding: "语义索引缓存",
  lexicon: "必用词表（本书）",
  plots: "伏笔登记",
  settings: "设定表",
  "style-reports": "风格画像",
  summaries: "章节摘要"
});

/** 书库级共享数据子目录预留声明（供后续阶段题材包等书库级数据接入，不参与按书删除）。 */
export const LIBRARY_DATA_SUBDIRS = Object.freeze(["packs"]);

/** 诊断模块预期检查的 `.novel-writer/` 下一层数据子目录清单（11 项，含 drafts 与 packs）。 */
export const DIAGNOSE_DATA_SUBDIRS = Object.freeze([
  "analysis", "audits", "baseline", "drafts", "embedding", "lexicon", "packs", "plots", "settings", "style-reports", "summaries"
]);
