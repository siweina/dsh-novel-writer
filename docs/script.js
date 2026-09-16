/* ============================================================================
   dsh-novel-writer 宣传页 —— 交互脚本（零依赖）
   ========================================================================== */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------- 导航：滚动加边线 */
  var nav = document.getElementById('nav');
  function onScroll() {
    if (!nav) return;
    nav.classList.toggle('is-stuck', window.scrollY > 8);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------------------------------------------------- 导航：移动端菜单 */
  var toggle = document.getElementById('navToggle');
  var links = document.getElementById('navLinks');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? '收起菜单' : '展开菜单');
    });
    links.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        links.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && links.classList.contains('is-open')) {
        links.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });
  }

  /* -------------------------------------------------- 滚动进场：reveal */
  var revealables = document.querySelectorAll('.reveal, .axes');
  if (!('IntersectionObserver' in window) || reduceMotion) {
    Array.prototype.forEach.call(revealables, function (el) { el.classList.add('is-in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });
    Array.prototype.forEach.call(revealables, function (el) { io.observe(el); });
  }

  /* ------------------------------------------------------- 复制到剪贴板 */
  var CHECK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12.5 5 5L20 6.5"/></svg>';

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function flash(btn) {
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    var original = btn.innerHTML;
    var label = (btn.textContent || '').trim();
    btn.classList.add('is-done');
    btn.innerHTML = label ? '已复制' : CHECK_SVG;
    window.setTimeout(function () {
      btn.classList.remove('is-done');
      btn.innerHTML = original;
      btn.dataset.busy = '0';
    }, 1600);
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.copy');
    if (!btn) return;
    e.preventDefault();
    var text = btn.getAttribute('data-copy');
    if (!text) {
      // 兜底：从紧邻的 <pre><code> 取文本
      var box = btn.closest('.code');
      var pre = box ? box.querySelector('pre') : null;
      text = pre ? pre.innerText : '';
    }
    copyText(text).then(function (ok) {
      if (ok) { flash(btn); return; }
      // 复制失败（例如非安全上下文且 execCommand 被禁）：选中文本，让用户手动 Ctrl+C
      var box = btn.closest('.code') || btn.closest('.hero__cmd');
      var pre = box ? box.querySelector('pre, code') : null;
      if (pre && window.getSelection) {
        var range = document.createRange();
        range.selectNodeContents(pre);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      var label = (btn.textContent || '').trim();
      btn.classList.add('is-done');
      if (label) btn.textContent = '请按 Ctrl+C';
      window.setTimeout(function () {
        btn.classList.remove('is-done');
        if (label) btn.textContent = label;
      }, 2200);
    });
  });

  /* ------------------------------------------------------------ 安装分页 */
  var tabs = document.querySelectorAll('.tab');
  Array.prototype.forEach.call(tabs, function (tab) {
    tab.addEventListener('click', function () {
      var targetId = tab.getAttribute('data-tab');
      Array.prototype.forEach.call(tabs, function (t) {
        var active = t === tab;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (p) {
        p.classList.toggle('is-active', p.id === targetId);
      });
    });
  });

  /* --------------------- 能力卡：悬停意图展开（停留 1 秒后展开详情面板） */
  var HOVER_INTENT_MS = 1000;
  var cards = document.querySelectorAll('.card');

  function setCard(card, open) {
    card.classList.toggle('is-open', open);
    var b = card.querySelector('.card__toggle');
    if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
    // 收起期间保留上层：面板收起要 250ms，若此刻就丢掉 z-index，
    // 收回中的面板会被下一行卡片盖住
    if (open) {
      card.classList.remove('is-closing');
      if (card.__closeTimer) { window.clearTimeout(card.__closeTimer); card.__closeTimer = null; }
    } else if (!card.__closeTimer) {
      card.classList.add('is-closing');
      card.__closeTimer = window.setTimeout(function () {
        card.classList.remove('is-closing');
        card.__closeTimer = null;
      }, 380);
    }
  }
  function closeOthers(except) {
    Array.prototype.forEach.call(cards, function (c) { if (c !== except) setCard(c, false); });
  }

  var canvasHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /** 面板展开后的总高度（含与卡片的 6px 间隙）。内容固定，量一次即缓存。 */
  function panelHeight(card) {
    if (card.dataset.panelH) return Number(card.dataset.panelH);
    var panel = card.querySelector('.card__more');
    var inner = card.querySelector('.card__more-in');
    if (!panel || !inner) return 0;
    // 测量前必须先关掉过渡：否则给 grid-template-rows 赋 1fr 会开始一段过渡，
    // 立刻读取到的是过渡的起始值（只剩边框的 2px），方向判定就会失真。
    var prevPanelTrans = panel.style.transition;
    var prevInnerTrans = inner.style.transition;
    var rows = panel.style.gridTemplateRows;
    var pad = inner.style.padding;
    panel.style.transition = 'none';
    inner.style.transition = 'none';
    panel.style.gridTemplateRows = '1fr';
    inner.style.padding = '18px 25px 22px';
    var h = panel.getBoundingClientRect().height + 6;
    // 先把值还原，再恢复过渡声明——保证还原动作也没有动画
    inner.style.padding = pad;
    panel.style.gridTemplateRows = rows;
    panel.style.transition = prevPanelTrans;
    inner.style.transition = prevInnerTrans;
    card.dataset.panelH = String(Math.ceil(h));
    return h;
  }

  /** 方向判定：优先向下；下方放不下且上方放得下才向上；两边都放不下时仍向下。 */
  function placeCard(card) {
    var need = panelHeight(card);
    var r = card.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var below = vh - r.bottom;
    var above = r.top;
    card.classList.toggle('is-open-up', below < need && above >= need);
  }

  // 子页面入口：在面板末尾补一条链接（触屏用户的主要路径），并让整张卡片可点击进入
  Array.prototype.forEach.call(cards, function (card) {
    var doc = card.querySelector('.card__doc');
    if (!doc) return;
    var inner = card.querySelector('.card__more-in');
    if (inner) {
      var link = document.createElement('a');
      link.className = 'card__more-link';
      link.href = doc.getAttribute('href');
      link.textContent = '查看完整技术说明 →';
      inner.appendChild(link);
    }
    if (!canvasHover) return;                        // 触屏上整卡点击会误触，交给标题与面板内链接
    card.classList.add('card--clickable');
    card.addEventListener('click', function (e) {
      if (e.target.closest('a, button')) return;     // 链接与按钮自行处理
      window.location.href = doc.getAttribute('href');
    });
  });

  window.addEventListener('resize', function () {
    Array.prototype.forEach.call(cards, function (c) { c.dataset.panelH = ''; });
  });

  Array.prototype.forEach.call(cards, function (card) {
    var timer = null;
    var btn = card.querySelector('.card__toggle');
    var clear = function () { if (timer) { window.clearTimeout(timer); timer = null; } };
    var open = function () { closeOthers(card); placeCard(card); setCard(card, true); };

    // 鼠标停留满 1 秒才展开：避免划过时误触发
    card.addEventListener('mouseenter', function () {
      clear();
      timer = window.setTimeout(open, HOVER_INTENT_MS);
    });
    card.addEventListener('mouseleave', function () {
      clear();
      setCard(card, false);
    });
    // 键盘：焦点进入卡片即展开，完全移出后收起
    card.addEventListener('focusin', function () { clear(); open(); });
    card.addEventListener('focusout', function (e) {
      if (!card.contains(e.relatedTarget)) setCard(card, false);
    });
    // 触屏与显式操作：点击切换（同一时刻只展开一张）
    if (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        clear();
        if (card.classList.contains('is-open')) setCard(card, false);
        else open();
      });
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeOthers(null);
  });

  /* ------------------------------- 12 轴：进入视口后再增长（纯装饰） */
  var axes = document.querySelector('.axes');
  if (axes && (reduceMotion || !('IntersectionObserver' in window))) {
    axes.classList.add('is-in');
  }
})();
