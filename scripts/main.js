/**
 * NoMiss List —— main.js（入口）
 *
 * 只做两件事：顶部日期、四个视图的切换。
 * 页面内容一律交给 views.js —— 包括首页顶部那条建议、本周大局（负荷 + 冲突）、今天的安排。
 * （第 1 步时这里曾自己画过一条只含日期的"本周条"，第 5 步起由 views.js 接管：
 *   同一块地方要有负荷和冲突标记，画两次只会互相盖掉。）
 */

(function () {
  'use strict';

  var VIEWS = ['home', 'add', 'detail', 'settings'];
  var DEFAULT_VIEW = 'home';

  /* ---------- 顶部日期 ---------- */
  function renderTodayLabel() {
    var el = document.getElementById('todayLabel');
    if (!el) return;
    var now = new Date();
    var week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    el.textContent = (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + week[now.getDay()];
  }

  /* ---------- 视图切换 ---------- */
  function currentView() {
    var hash = (location.hash || '').replace('#', '');
    return VIEWS.indexOf(hash) >= 0 ? hash : DEFAULT_VIEW;
  }

  function renderView() {
    var active = currentView();

    VIEWS.forEach(function (name) {
      var section = document.getElementById('view-' + name);
      if (section) section.hidden = name !== active;
    });

    var tabs = document.querySelectorAll('.tab');
    Array.prototype.forEach.call(tabs, function (tab) {
      var isActive = tab.getAttribute('data-view') === active;
      tab.classList.toggle('is-active', isActive);
    });

    if (window.NoMissViews) window.NoMissViews.onViewChange(active);
  }

  function init() {
    renderTodayLabel();
    if (window.NoMissViews) window.NoMissViews.init();
    renderView();
    window.addEventListener('hashchange', renderView);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
