// V6-icons-d.js —— M4d-r 线图标·导航栏批（5 字形）+ v6.2.0 词表批（2 字形）
// 统一规范：viewBox="0 0 24 24" / fill="none" / stroke="currentColor" / stroke-width="1.5"
//           stroke-linecap="round" stroke-linejoin="round；SVG 内零颜色字面量；不引入字体与图片资源。
// key 用语义名（navFeatures / navTools / navCreation / navBaseline / navArrow / navLexicon / lexiconFirst）；
// key 对应的原字形与画法见 V6-icons-d-notes.md 对照表（本文件不放字形字符，避免误扫描）。
// ES5：var + 对象字面量；自包含，不 import 任何本地文件。
var NW_ICONS_D = {
  navFeatures: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="2"/><path d="M17.5 12H21.2"/><path d="M14.75 16.76L16.6 19.97"/><path d="M9.25 16.76L7.4 19.97"/><path d="M6.5 12H2.8"/><path d="M9.25 7.24L7.4 4.03"/><path d="M14.75 7.24L16.6 4.03"/></svg>',
  navTools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.48 7.85A4 4 0 1 1 16.15 3.52"/><path d="M13.67 10.33L5.5 18.5"/></svg>',
  navCreation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7C10 5.5 6.5 5.5 4 6.5V17.5C6.5 16.5 10 16.5 12 18"/><path d="M12 7C14 5.5 17.5 5.5 20 6.5V17.5C17.5 16.5 14 16.5 12 18"/><path d="M12 7V18"/></svg>',
  navBaseline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12h0.01"/></svg>',
  navArrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  // v6.2.0：必用词表——左侧词条行 + 右侧书签，表示"把要用的词钉下来"
  navLexicon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.5h9"/><path d="M3.5 12h9"/><path d="M3.5 17.5h6"/><path d="M17 4h4.5"/><path d="M21.5 4v15.2"/><path d="M17 19.2V4"/><path d="M17 19.2l2.25-1.5 2.25 1.5"/></svg>',
  lexiconFirst: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.5h9"/><path d="M3.5 12h9"/><path d="M3.5 17.5h6"/><path d="M17 4h4.5"/><path d="M21.5 4v15.2"/><path d="M17 19.2V4"/><path d="M17 19.2l2.25-1.5 2.25 1.5"/></svg>',
  // v7-A: action-specific tool icons.
  toolBooks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="5" height="16" rx="1"/><path d="M12 4v16M16 5l4 14M5 8h3"/></svg>',
  toolChapters: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  toolRead: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14"/></svg>',
  toolKeywords: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 4 8 1 8 8-7 7-8-8-1-8Z"/><circle cx="8" cy="8" r="1"/></svg>',
  toolSentences: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 10h10M4 14h14M4 18h7"/></svg>',
  toolStyleCheck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h11v7M4 4v16h7M7 8h5M7 12h3m3 5 3 3 5-7"/></svg>',
  toolRevise: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14v6Zm0 0h16"/></svg>',
  toolProfile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V5M4 20h17M8 17v-5M13 17V8M18 17V4"/></svg>',
  toolSearch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5M7 10h6M10 7v6"/></svg>',
  toolContinuity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 15 6-6M10 6l2-2a4 4 0 0 1 6 6l-2 2M14 18l-2 2a4 4 0 0 1-6-6l2-2"/></svg>',
  toolDiagnose: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H5v17h14V4h-4M9 3h6v4H9zM8 14h2l1-3 2 6 1-3h2"/></svg>',
  toolSettings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10"/><circle cx="12" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/></svg>',
  toolPlot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h7a4 4 0 0 1 0 8h-4a2 2 0 0 0 0 4h7M19 3v7m-3-4h6"/></svg>',
  toolSummary: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6V3Zm9 0v5h4M9 12h7M9 16h5"/></svg>',
  toolImport: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v8M4 15v6h16v-6M12 7v10m-4-4 4 4 4-4"/></svg>',
  toolBrief: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V3h8v4M3 12h18M10 12v3h4v-3"/></svg>',
  toolLexicon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14v18H5V3ZM8 7h8M8 11h5M8 15h5M15 15l2 2 3-4"/></svg>',
  toolNewChapter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H5v18h14V9M13 3v6h6M9 15h6M12 12v6"/></svg>',
  toolOutline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/><path d="M6 8v10h8M6 13h11V6h-3M17 3v6M14 6h6"/></svg>'
};
