/* ============================================================================
   技术文档：侧栏 / 目录 / 上下页（零依赖）
   工具清单是唯一数据源 —— 新增子页面只需在此登记一行。
   ========================================================================== */
(function () {
  'use strict';

  var TOOLS = [
    { g: '章节与文稿', file: 'novel-books',        name: 'novel_books',        title: '列出作品' },
    { g: '章节与文稿', file: 'novel-chapters',     name: 'novel_chapters',     title: '列出章节' },
    { g: '章节与文稿', file: 'novel-read',         name: 'novel_read',         title: '阅读正文' },
    { g: '章节与文稿', file: 'novel-new-chapter',  name: 'novel_new_chapter',  title: '新建章节' },
    { g: '章节与文稿', file: 'novel-import',       name: 'novel_import',       title: '批量导入' },
    { g: '章节与文稿', file: 'novel-keywords',     name: 'novel_keywords',     title: '关键词统计' },

    { g: '分析与测量', file: 'novel-style-report',      name: 'novel_style_report',      title: '风格画像报告' },
    { g: '分析与测量', file: 'novel-style-check',       name: 'novel_style_check',       title: '风格自检' },
    { g: '分析与测量', file: 'novel-sentence-analysis', name: 'novel_sentence_analysis', title: '句式模式分析' },
    { g: '分析与测量', file: 'novel-semantic-search',   name: 'novel_semantic_search',   title: '语义检索' },

    { g: '设定、剧情与资料', file: 'novel-plot',     name: 'novel_plot',     title: '伏笔登记表' },
    { g: '设定、剧情与资料', file: 'novel-settings', name: 'novel_settings', title: '设定五张表' },
    { g: '设定、剧情与资料', file: 'novel-summary',  name: 'novel_summary',  title: '章节摘要' },
    { g: '设定、剧情与资料', file: 'novel-outline',  name: 'novel_outline',  title: '创作资料' },

    { g: '审计与配置', file: 'novel-continuity-check', name: 'novel_continuity_check', title: '连贯性审计' },
    { g: '审计与配置', file: 'novel-sentence-config',  name: 'novel_sentence_config',  title: '开关配置' }
  ];

  var here = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '');
  var isIndex = here === '' || here === 'index';

  /* ------------------------------------------------------------- 左侧导航 */
  var side = document.getElementById('docsSide');
  if (side) {
    var html = '<a href="index.html"' + (isIndex ? ' class="is-current"' : '') + '>文档总览</a>';
    var lastGroup = null;
    TOOLS.forEach(function (t) {
      if (t.g !== lastGroup) {
        html += '<h4>' + t.g + '</h4>';
        lastGroup = t.g;
      }
      html += '<a href="' + t.file + '.html"' + (t.file === here ? ' class="is-current"' : '') + '>' +
              t.name + '</a>';
    });
    side.innerHTML = html;
  }

  /* --------------------------------------------------------------- 上下页 */
  var pager = document.getElementById('docsPager');
  if (pager) {
    var idx = -1;
    TOOLS.forEach(function (t, i) { if (t.file === here) idx = i; });
    var prev = idx > 0 ? TOOLS[idx - 1] : null;
    var next = idx >= 0 && idx < TOOLS.length - 1 ? TOOLS[idx + 1] : null;
    var p = '';
    p += prev
      ? '<a href="' + prev.file + '.html"><span>← 上一个</span><b>' + prev.name + '</b></a>'
      : '<span></span>';
    p += next
      ? '<a class="is-next" href="' + next.file + '.html"><span>下一个 →</span><b>' + next.name + '</b></a>'
      : '<span></span>';
    pager.innerHTML = p;
  }

  /* --------------------------------------------------------- 右侧标题目录 */
  var toc = document.getElementById('docsToc');
  var doc = document.querySelector('.doc');
  if (toc && doc) {
    var heads = [].slice.call(doc.querySelectorAll('h2'));
    if (heads.length > 1) {
      var items = heads.map(function (h, i) {
        if (!h.id) {
          h.id = 'sec-' + (i + 1) + '-' + h.textContent.trim().replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, '-').slice(0, 24);
        }
        return { id: h.id, text: h.textContent.trim() };
      });
      toc.innerHTML = '<h4>本页内容</h4>' + items.map(function (it) {
        return '<a href="#' + it.id + '">' + it.text + '</a>';
      }).join('');

      var links = [].slice.call(toc.querySelectorAll('a'));
      if ('IntersectionObserver' in window) {
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            if (!e.isIntersecting) return;
            links.forEach(function (a) { a.classList.toggle('is-active', a.getAttribute('href') === '#' + e.target.id); });
          });
        }, { rootMargin: '-84px 0px -70% 0px', threshold: 0 });
        heads.forEach(function (h) { io.observe(h); });
      }
    } else {
      toc.style.display = 'none';
    }
  }
})();
