/**
 * views.js —— 渲染层
 *
 * 职责：读数据 → 画到界面上；接收点击 → 调 model 改数据 → 重画。
 * 规矩：
 *   1. 不直接碰存储，只用 model（分层见 TECH_DESIGN.md 第四节）
 *   2. 任务名一律用 textContent 写入，不做 HTML 拼接（避免注入也避免破版）
 *   3. 提示语不指责人：只说"发生了什么 + 你能做什么"
 */

(function () {
  'use strict';

  var model = window.NoMissModel;
  var scheduler = window.NoMissScheduler;
  var selectedTaskId = null;
  var noticeTimer = null;

  /** 正在修改的任务 id；为空表示"添加新任务"模式 */
  var editingTaskId = null;

  /** 进入修改模式时，那条任务原有执行时段属于哪一天（用于"只是改名字"时不去动它） */
  var editingSegmentDay = null;

  /** 进入修改模式时，那一段的开始时刻（用来判断用户有没有改动执行时段） */
  var editingSegmentStart = null;

  /** 本周大局里被点开的那一天（ISO 日期字符串；空表示都收起） */
  var selectedDayKey = null;

  /**
   * 周条上每一天的元素，按日期存一份。
   * 用途只在键盘操作：按下回车切换后，renderWeek 会把整块重画（旧元素全没了），
   * 必须在新画出来的那一批里把焦点放回同一天，否则焦点会掉到页面开头，
   * 用户每看一天就得重新 Tab 一遍。
   */
  var dayElByKey = {};

  /** 事件是否已经绑过（防重复绑定，见 bindEvents） */
  var bound = false;

  /**
   * 演示模式下的"加载中"：两个变量配合，缺一不可。
   *
   *   loadingDemoPlayed —— 计时器只武装一次（否则每渲染一次就重新计时，永远转下去）
   *   loadingDemoUntil  —— 在这个时间点之前，不管重画几次都显示加载中
   *
   * 为什么要后者：首屏其实会被渲染两次（视图初始化一次、随后视图切换逻辑又一次），
   * 用"只演一次"的布尔标记会被第二次立刻冲掉——真机上同样如此。
   */
  var loadingDemoPlayed = false;
  var loadingDemoUntil = 0;

  /** 首页顶部那条建议的当前结果，供「就按这个安排」按钮读取 */
  var currentAdvice = null;

  function el(id) { return document.getElementById(id); }

  /* ---------- 顶部提示条 ---------- */

  function showNotice(text, kind) {
    var box = el('notice');
    if (!box) return;
    box.textContent = text;
    box.className = 'notice' + (kind ? ' notice--' + kind : '');
    box.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { box.hidden = true; }, 6000);
  }

  /**
   * 所有可能出错的调用都从这里过一道：
   * 出错时把 model / storage 里写好的友好提示原样显示出来，不让界面卡死。
   */
  function safely(fn, okMessage) {
    try {
      var result = fn();
      if (okMessage) showNotice(okMessage, 'ok');
      return result;
    } catch (e) {
      showNotice(e && e.message ? e.message : '这一步没做成，稍后再试一次。', 'warn');
      return null;
    }
  }

  /* ---------- 小工具 ---------- */

  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var WEEK_FULL = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function hm(iso) {
    var d = new Date(iso);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** 紧凑的时长写法，用在窄小的格子里：90 分钟 → 1.5h */
  function compactMinutes(m) {
    if (!m) return '';
    if (m >= 60) {
      var h = Math.round(m / 60 * 10) / 10;
      return (h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)) + 'h';
    }
    return m + '分';
  }

  /** 某个日期相对于"今天"的叫法，用于冲突提示 */
  function dayLabelOf(dateKey, now) {
    var todayKey = scheduler.isoDay(now);
    if (dateKey === todayKey) return '今天';
    if (dateKey === scheduler.isoDay(scheduler.addDays(now, 1))) return '明天';
    var d = new Date(dateKey + 'T00:00:00');
    return WEEK_FULL[scheduler.weekdayOf(d)];
  }

  function todayKey() { return scheduler.isoDay(new Date()); }

  /** 这条任务今天还有"没结束"的已排时段吗（结束了就不再挡着它重新参与安排） */
  function hasSegmentToday(task) {
    var now = new Date().getTime();
    return (task.scheduledSegments || []).some(function (s) {
      return scheduler.isoDay(new Date(s.start)) === todayKey() && new Date(s.end).getTime() > now;
    });
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtMinutes(m) {
    if (m === null || m === undefined) return '—';
    if (m <= 0) return '0 分钟';
    var h = Math.floor(m / 60);
    var rest = m % 60;
    if (h && rest) return h + ' 小时 ' + rest + ' 分钟';
    if (h) return h + ' 小时';
    return rest + ' 分钟';
  }

  function isToday(iso) {
    if (!iso) return false;
    var d = new Date(iso);
    var now = new Date();
    return d.getFullYear() === now.getFullYear() &&
           d.getMonth() === now.getMonth() &&
           d.getDate() === now.getDate();
  }

  function statusText(s) {
    if (s === 'done') return '已完成';
    if (s === 'needsReschedule') return '待重新安排';
    return '待办';
  }

  /* ---------- 任务条目 ---------- */

  function buildTaskRow(task, options) {
    options = options || {};
    var row = document.createElement('div');
    row.className = 'task' + (task.status === 'done' ? ' task--done' : '');

    // 键盘可达：这一行本身是可点的（点开详情），所以它必须能用 Tab 走到。
    // 注意只加 tabIndex 不够 —— div 不会自己响应回车，下面还要手动接 keydown。
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', '打开任务详情：' + task.title);

    var check = document.createElement('button');
    check.type = 'button';
    check.className = 'task-check';
    check.setAttribute('aria-label', task.status === 'done' ? '标记为未完成' : '标记完成');
    check.textContent = task.status === 'done' ? '✓' : '';
    if (!options.readonly) {
      check.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var ok = safely(function () {
          if (task.status === 'done') {
            return model.updateTask(task.id, { status: 'todo', completedAt: null, remainingMinutes: task.estimateMinutes });
          }
          return model.completeTask(task.id);
        }, task.status === 'done' ? '已放回待办' : '完成一件，做得不错——下一件在首页顶上等你');
        if (ok !== null) renderAll();
      });
    } else {
      check.disabled = true;
    }

    var body = document.createElement('div');
    body.className = 'task-body';

    var title = document.createElement('p');
    title.className = 'task-title';
    title.textContent = task.title;
    body.appendChild(title);

    var meta = document.createElement('p');
    meta.className = 'task-meta';
    var bits = [];
    if (task.dueAt) bits.push('截止 ' + fmtDateTime(task.dueAt));
    bits.push('预计 ' + fmtMinutes(task.estimateMinutes));
    if (task.remainingMinutes !== task.estimateMinutes) {
      bits.push('还剩 ' + fmtMinutes(task.remainingMinutes));
    }
    var segs = task.scheduledSegments || [];
    if (segs.length) {
      bits.push('已排 ' + segs.map(fmtSegment).join('、'));
    }
    meta.textContent = bits.join(' · ');
    body.appendChild(meta);

    row.appendChild(check);
    row.appendChild(body);

    // 未完成、今天没有"还没结束"的时段、且不在重排流程里的任务，给一个「放进今天」
    // （待重新安排的任务由那张卡专门处理，这里不再插一脚，免得两处都能改它的时间）
    if (options.allowSchedule && task.status === 'todo' && !hasSegmentToday(task)) {
      var put = document.createElement('button');
      put.type = 'button';
      put.className = 'btn btn--tiny';
      put.textContent = '放进今天';
      put.addEventListener('click', function (ev) {
        ev.stopPropagation();
        placeToday(task);
      });
      row.appendChild(put);
    }

    function openDetail() {
      selectedTaskId = task.id;
      location.hash = '#detail';
      renderDetail();
    }
    row.addEventListener('click', openDetail);
    row.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openDetail();
      }
    });

    return row;
  }

  /** 已排时段的紧凑写法：今天 11:40–14:00 */
  function fmtSegment(seg) {
    var s = new Date(seg.start);
    var now = new Date();
    var dayLabel;
    if (scheduler.sameDay(s, now)) dayLabel = '今天';
    else if (scheduler.sameDay(s, scheduler.addDays(now, 1))) dayLabel = '明天';
    else dayLabel = (s.getMonth() + 1) + '月' + s.getDate() + '日';
    return dayLabel + ' ' + hm(seg.start) + '–' + hm(seg.end);
  }

  /**
   * 把一条任务排进今天最近的一段空档。
   * 排不下就直说，并给出最早能做的时间——不悄悄塞进一个不合适的时段。
   */
  function placeToday(task) {
    var next;
    try {
      next = scheduler.predictNextAvailable(task, new Date());
    } catch (e) {
      showNotice(e && e.message ? e.message : '这一步没算出来，稍后再试一次。', 'warn');
      return;
    }

    if (!next || next.date !== todayKey()) {
      var alt = next
        ? '最早可以排到 ' + scheduler.formatSlot(next.slot, new Date()) + '（' + fmtMinutes(next.slot.minutes) + '）。'
        : '最近两周都没找到合适的时段。';
      showNotice('今天没有放得下它的空档。' + alt, 'warn');
      return;
    }

    var saved = safely(function () {
      // 写的是"真正要占用的那一段"（plannedStart–plannedEnd），不是整段空档
      return model.scheduleTaskFor(task.id, next.plannedStart, next.plannedEnd);
    });
    if (saved === null) return;
    showNotice('已排进今天：' + hm(next.plannedStart) + '–' + hm(next.plannedEnd) +
      '（' + fmtMinutes(next.planMinutes) + '）', 'ok');
    renderAll();
  }

  function fillTaskList(containerId, emptyId, tasks, emptyText, options) {
    var box = el(containerId);
    if (!box) return;
    box.innerHTML = '';
    var emptyEl = el(emptyId);
    if (!tasks.length) {
      if (emptyEl) { emptyEl.hidden = false; if (emptyText) emptyEl.textContent = emptyText; }
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    tasks.forEach(function (t) { box.appendChild(buildTaskRow(t, options)); });
  }

  /* ---------- 首页渲染 ---------- */

  /** 计算层出问题时不装作没事，也不留一片空白 */
  function reportCalcError(e) {
    showNotice(e && e.message ? e.message : '这一步没算出来，稍后再看一次。', 'warn');
  }

  /* ---------- 区块的四种状态：加载中 / 成功 / 空 / 出错 ---------- */

  /**
   * 每个区块在卡片内部都留了一个"状态位"。
   *
   * 为什么必须做在卡片里，而不是像以前那样顶部飘一条提示：
   * 顶部那条 6 秒后自己消失，而卡里还留着上一次的数据——用户会以为看到的是新的，
   * 其实是旧的。**这比白屏更危险，因为白屏至少你知道出事了。**
   */
  var CARDS = {
    advice: { card: 'cardAdvice', state: 'stateAdvice' },
    settle: { card: 'cardSettle', state: 'stateSettle' },
    reschedule: { card: 'cardReschedule', state: 'stateReschedule' },
    week: { card: 'cardWeek', state: 'stateWeek' },
    timeline: { card: 'cardTimeline', state: 'stateTimeline' },
    tasks: { card: 'cardTasks', state: 'stateTasks' },
    blocks: { card: 'cardBlocks', state: 'stateBlocks' },
    settings: { card: 'cardSettings', state: 'stateSettings' }
  };

  /** 当前是不是演示模式（平时返回空字符串） */
  function currentDemoMode() {
    return (window.NoMissDemo && window.NoMissDemo.mode) || '';
  }

  /** 回到"正常渲染"的样子：撤掉加载中 / 出错状态（.is-state 会把卡里其余内容藏起来） */
  function clearCardState(key) {
    var ref = CARDS[key];
    if (!ref) return;
    var card = el(ref.card);
    var st = el(ref.state);
    if (card) card.classList.remove('is-state');
    if (st) { st.hidden = true; st.innerHTML = ''; }
  }

  /** 在卡片内部显示"出错"，并给一个「重新试一次」——比顶部那句话有用 */
  function failCard(key, e) {
    var ref = CARDS[key];
    if (!ref) return;
    var card = el(ref.card);
    var st = el(ref.state);
    if (!card || !st) return;

    card.hidden = false;
    card.classList.add('is-state');
    st.innerHTML = '';
    st.hidden = false;

    var msg = document.createElement('p');
    msg.className = 'card-state-msg';
    msg.textContent = (e && e.message) ? e.message : '这一步没算出来。';

    var actions = document.createElement('div');
    actions.className = 'actions';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--tiny';
    btn.textContent = '重新试一次';
    btn.addEventListener('click', function () { renderAll(); });
    actions.appendChild(btn);

    st.appendChild(msg);
    st.appendChild(actions);
  }

  /** 在卡片内部显示"加载中" */
  function loadingCard(key) {
    var ref = CARDS[key];
    if (!ref) return;
    var card = el(ref.card);
    var st = el(ref.state);
    if (!card || !st) return;

    card.hidden = false;
    card.classList.add('is-state');
    st.innerHTML = '';
    st.hidden = false;

    var msg = document.createElement('p');
    msg.className = 'card-state-msg';
    msg.textContent = '正在读取…';

    var bar = document.createElement('div');
    bar.className = 'loading-bar';

    st.appendChild(msg);
    st.appendChild(bar);
  }

  /** 组装"最早可以安排……"这句话 */
  function nextAvailableText(prefix, next) {
    if (!next || !next.slot) return prefix + ' 最近两周都没找到合适的时段。';
    var s = next.slot;
    return prefix + ' 最早可以安排 ' + scheduler.formatSlot(s, new Date()) +
           '（' + fmtMinutes(s.minutes) + '）' + (next.partial ? '，先做这一段' : '') + '。';
  }

  /**
   * ①-1 今天的建议：全站唯一一条建议，字最大。
   * 三种状态都要有话说：有建议 / 没有待办 / 今天没空档了。
   */
  function renderAdvice(adv, failure) {
    var mainEl = el('adviceMain');
    if (!mainEl) return;
    var slotEl = el('adviceSlot');
    var reasonEl = el('adviceReason');
    var extraEl = el('adviceExtra');
    var emptyEl = el('adviceEmpty');
    var actionsEl = el('adviceActions');

    currentAdvice = null;
    clearCardState('advice');
    mainEl.hidden = true;
    slotEl.hidden = true;
    reasonEl.hidden = true;
    extraEl.hidden = true;
    actionsEl.hidden = true;
    emptyEl.hidden = false;

    if (failure || !adv) {
      emptyEl.hidden = true;
      failCard('advice', failure);
      return;
    }

    if (adv.kind === 'no-task') {
      emptyEl.textContent = '现在没有待办。想安排点什么，就去「添加任务」写一件——只填名字就能存。';
      return;
    }

    if (adv.kind === 'no-slot') {
      emptyEl.textContent = nextAvailableText('今天已经没有空档了。', adv.nextAvailable);
      return;
    }

    if (adv.kind === 'all-placed') {
      emptyEl.textContent = '今天的事都已经排进时间表了，剩下的时间留给你自己。';
      return;
    }

    // 有建议
    currentAdvice = adv;
    emptyEl.hidden = true;
    mainEl.hidden = false;
    slotEl.hidden = false;
    reasonEl.hidden = false;
    actionsEl.hidden = false;

    mainEl.textContent = '现在做：' + adv.task.title;
    // 显示"真正要做的这一段"，而不是那段空档的全部长度
    slotEl.textContent = hm(adv.plannedStart) + '–' + hm(adv.plannedEnd) + ' · ' + fmtMinutes(adv.planMinutes);
    reasonEl.textContent = adv.reason;

    var extras = [];
    if (adv.partial) {
      extras.push('这一段先做 ' + fmtMinutes(adv.planMinutes) + '，还剩 ' + fmtMinutes(adv.remainingAfter) +
                  '，做完一段会自动排进下一个空档。');
    }
    if (adv.deferred) {
      extras.push(nextAvailableText('另外「' + adv.deferred.task.title + '」今天排不下。', adv.deferred.nextAvailable));
    }
    if (extras.length) {
      extraEl.hidden = false;
      extraEl.textContent = extras.join(' ');
    }

    var btn = el('btnFollowAdvice');
    if (btn) btn.textContent = adv.partial ? '就按这一段排' : '就按这个安排';
  }

  /** 这条安排（课或已排任务）今天和谁撞了？没撞返回 null */
  function conflictPartnerOf(conflicts, dateKey, item) {
    if (!item.id) return null;
    for (var i = 0; i < conflicts.length; i++) {
      var c = conflicts[i];
      if (c.date !== dateKey) continue;
      if (c.a.id === item.id) return c.b.title;
      if (c.b.id === item.id) return c.a.title;
    }
    return null;
  }

  /** ①-2 本周大局：7 天负荷 + 冲突提示 */
  function renderWeek() {
    var list = el('weekStrip');
    if (!list) return;
    clearCardState('week');
    try {
      var now = new Date();
      var days = [];
      for (var i = 0; i < 7; i++) days.push(scheduler.addDays(now, i));

      var load = scheduler.getWeekLoad(now, 7);
      var conflicts = scheduler.detectConflicts(days);

      // 先把要算的都算完再清空画面——反过来的话，一旦中间出错，
      // 卡里会留着上一次的数据，看起来像"一切正常"。
      list.innerHTML = '';
      dayElByKey = {};   // 旧元素已经被丢掉，索引一起清掉，免得 focus 到不在页面上的节点

      load.forEach(function (d, idx) {
        var n = conflicts.filter(function (c) { return c.date === d.date; }).length;
        var opened = (selectedDayKey === d.date);
        var li = document.createElement('li');
        li.className = 'week-day is-' + d.level + (idx === 0 ? ' is-today' : '') +
                       (n ? ' has-conflict' : '') + (opened ? ' is-open' : '');
        li.title = d.label + ' · 已占用 ' + fmtMinutes(d.occupiedMinutes) +
                   (n ? ' · ' + n + ' 处时间重叠' : '') + ' · 点一下看这天的安排';

        // 点一下展开那天的安排，再点一下收起（B1）
        // 键盘同样可达：Tab 走到某一天、按回车即可展开
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
        li.setAttribute('aria-label', '看 ' + d.label + ' 的安排');

        function toggleDay() {
          selectedDayKey = (selectedDayKey === d.date) ? null : d.date;
          renderWeek();
          var back = dayElByKey[d.date];
          if (back && back.focus) back.focus();
        }
        li.addEventListener('click', toggleDay);
        li.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggleDay();
          }
        });

        dayElByKey[d.date] = li;

        var name = document.createElement('span');
        name.className = 'day-name';
        name.textContent = WEEK_FULL[scheduler.weekdayOf(days[idx])];

        var num = document.createElement('span');
        num.className = 'day-num';
        num.textContent = String(days[idx].getDate());

        var track = document.createElement('span');
        track.className = 'load-track';
        var fill = document.createElement('span');
        fill.className = 'load-fill';
        fill.style.width = Math.round(d.loadRatio * 100) + '%';
        track.appendChild(fill);

        li.appendChild(name);
        li.appendChild(num);
        li.appendChild(track);

        if (d.occupiedMinutes > 0) {
          var txt = document.createElement('span');
          txt.className = 'load-text';
          txt.textContent = compactMinutes(d.occupiedMinutes);
          li.appendChild(txt);
        }
        list.appendChild(li);
      });

      var box = el('conflictList');
      if (box) {
        box.innerHTML = '';
        conflicts.forEach(function (c) {
          var row = document.createElement('div');
          row.className = 'conflict';
          row.textContent = dayLabelOf(c.date, now) + ' ' + c.text;
          box.appendChild(row);
        });
      }
      var emptyEl = el('conflictEmpty');
      if (emptyEl) emptyEl.hidden = conflicts.length > 0;

      renderDayDetail();

    } catch (e) {
      failCard('week', e);
    }
  }

  /* ---------- 可复用组件：时间线的"一段"与"一整块" ---------- */

  var TL_TAG = { block: '课', task: '已排', plan: '建议', free: '空' };

  /**
   * 组件①：时间线上的一行。
   *
   * 为什么要抽出来：「今天的安排」和「点某天展开的那一天」画的是**同一件事**，
   * 只有日期不同。不抽的话就是把这段拼装代码抄第二遍——以后改一处忘一处。
   */
  function timelineRow(item, conflicts, dateKey) {
    var row = document.createElement('div');
    row.className = 'tl tl--' + item.kind + (item.pinned ? ' is-pinned' : '');

    var time = document.createElement('span');
    time.className = 'tl-time';
    time.textContent = hm(item.start) + '–' + hm(item.end);

    var tag = document.createElement('span');
    tag.className = 'tl-tag';
    tag.textContent = TL_TAG[item.kind] || '';

    var title = document.createElement('span');
    title.className = 'tl-title';
    title.textContent = item.kind === 'free' ? '这段时间空着' : item.title;

    row.appendChild(time);
    row.appendChild(tag);
    row.appendChild(title);

    // 撞了就直接在这一行说出来——竞品只给你一张图，让你自己看
    var other = conflictPartnerOf(conflicts, dateKey, item);
    if (other) {
      row.className += ' has-conflict';
      var note = document.createElement('span');
      note.className = 'tl-note';
      note.textContent = '与「' + other + '」时间重叠';
      row.appendChild(note);
    } else {
      var mins = document.createElement('span');
      mins.className = 'tl-min';
      mins.textContent = fmtMinutes(item.minutes);
      row.appendChild(mins);
    }
    return row;
  }

  /**
   * 组件②：把"某一天的安排"填进一个容器里。
   *
   * 注意这里刻意**不返回一个包裹层**——直接往容器里填。
   * 多包一层看着无害，但会让样式里的 ":first-child"、以及"取直接子节点"的代码全部错位。
   */
  function fillTimeline(box, items, conflicts, dateKey) {
    box.innerHTML = '';
    items.forEach(function (it) { box.appendChild(timelineRow(it, conflicts, dateKey)); });
  }

  /** ①-3 今天的安排：只列时段和事，不喊口号 */
  function renderTimeline(adv) {
    var box = el('timelineList');
    if (!box) return;
    clearCardState('timeline');
    try {
      var now = new Date();
      var items = scheduler.getTodayTimeline(now, adv);
      var todayKey = scheduler.isoDay(now);
      var todaysConflicts = scheduler.detectConflicts([now]);

      var emptyEl = el('timelineEmpty');
      if (!items.length) {
        box.innerHTML = '';
        if (emptyEl) emptyEl.hidden = false;
        return;
      }
      if (emptyEl) emptyEl.hidden = true;

      fillTimeline(box, items, todaysConflicts, todayKey);

    } catch (e) {
      failCard('timeline', e);
    }
  }

  /**
   * ①-4b 点某天展开：把"那一天"的安排画在周条下面。
   * 用的是和「今天的安排」完全相同的组件，所以两处的样子天然一致。
   */
  function renderDayDetail() {
    var box = el('dayDetail');
    if (!box) return;

    if (!selectedDayKey) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }

    box.hidden = false;
    box.innerHTML = '';

    var now = new Date();
    var date = new Date(selectedDayKey + 'T00:00:00');

    var head = document.createElement('p');
    head.className = 'day-detail-head';
    box.appendChild(head);

    var items;
    try {
      items = scheduler.getDayTimeline(date, now);
    } catch (e) {
      head.textContent = (e && e.message) ? e.message : '这一天的安排没算出来。';
      return;
    }

    if (!items.length) {
      head.textContent = dayLabelOf(selectedDayKey, now) + '：这一天没有可安排的时段。';
      return;
    }
    head.textContent = dayLabelOf(selectedDayKey, now) + ' 的安排（共 ' + items.length + ' 段）';

    var list = document.createElement('div');
    box.appendChild(list);
    fillTimeline(list, items, scheduler.detectConflicts([date]), selectedDayKey);
  }

  /**
   * ①-2 段落结算：只问一句「做完了吗？」
   *
   * 为什么只问这一句：这是 F8 的全部交互。不问"你花了多久"、不让你填数字，
   * 一个点击就把剩余时长扣掉，剩下的自动排进下一个空档。
   */
  function renderSettle() {
    var card = el('cardSettle');
    var box = el('settleList');
    if (!card || !box) return;

    var list;
    clearCardState('settle');
    try {
      list = scheduler.getPendingSettlements(new Date());
    } catch (e) {
      failCard('settle', e);
      return;
    }

    box.innerHTML = '';
    if (!list.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    list.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'settle';

      var text = document.createElement('p');
      text.className = 'settle-text';
      text.textContent = '「' + item.task.title + '」这一段（' + hm(item.start) + '–' + hm(item.end) +
        '，' + fmtMinutes(item.minutes) + '）时间到了——做完了吗？';

      var actions = document.createElement('div');
      actions.className = 'actions';

      var btnDone = document.createElement('button');
      btnDone.type = 'button';
      btnDone.className = 'btn btn--primary';
      btnDone.textContent = '做完了';
      btnDone.addEventListener('click', function () {
        var saved = safely(function () {
          return model.settleSegment(item.task.id, item.start, 'done');
        }, '完成一件——下一件在首页顶上等你');
        if (saved !== null) renderAll();
      });

      var btnMore = document.createElement('button');
      btnMore.type = 'button';
      btnMore.className = 'btn';
      btnMore.textContent = '还没，继续';
      btnMore.addEventListener('click', function () {
        continueSegment(item);
      });

      actions.appendChild(btnDone);
      actions.appendChild(btnMore);
      row.appendChild(text);
      row.appendChild(actions);

      if (item.remainingAfter > 0) {
        var hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent = '选「还没，继续」，这一段的 ' + fmtMinutes(item.minutes) +
          ' 会从剩余里扣掉，并自动排进下一个空档。';
        row.appendChild(hint);
      }

      box.appendChild(row);
    });
  }

  /** 「还没，继续」：扣掉这一段，然后把它排进下一个空档 */
  function continueSegment(item) {
    var updated = safely(function () {
      return model.settleSegment(item.task.id, item.start, 'continue');
    }, null);
    if (updated === null) return;

    var next = null;
    try {
      next = scheduler.predictNextAvailable(updated, new Date());
    } catch (e) {
      reportCalcError(e);
      renderAll();
      return;
    }

    if (next && next.slot) {
      var saved = safely(function () {
        // 同样只写"真正要占用的那一段"
        return model.scheduleTaskFor(updated.id, next.plannedStart, next.plannedEnd);
      }, null);
      if (saved !== null) {
        showNotice('还剩 ' + fmtMinutes(updated.remainingMinutes) + '，下一段排在 ' +
          hm(next.plannedStart) + '–' + hm(next.plannedEnd), 'ok');
      }
    } else {
      showNotice('这一段已经扣掉，还剩 ' + fmtMinutes(updated.remainingMinutes) +
        '；最近两周还没找到合适的时段，先放在「要做的事」里。', 'warn');
    }
    renderAll();
  }

  /**
   * ①-3 待重新安排：截止时间已过、又没有后续安排的任务。
   * 系统给一个建议，**必须由你确认**才写入（P-A：用户有自主权，AI 只补位）。
   */
  function renderReschedule() {
    var card = el('cardReschedule');
    var box = el('rescheduleList');
    if (!card || !box) return;

    var list;
    clearCardState('reschedule');
    try {
      list = scheduler.getRescheduleSuggestions(new Date());
    } catch (e) {
      failCard('reschedule', e);
      return;
    }

    box.innerHTML = '';
    if (!list.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    list.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'resched';

      var text = document.createElement('p');
      text.className = 'resched-text';
      if (item.slot) {
        text.textContent = '「' + item.task.title + '」原定 ' + fmtDateTime(item.task.dueAt) +
          ' 完成，放到 ' + hm(item.plannedStart) + '–' + hm(item.plannedEnd) +
          '（' + fmtMinutes(item.planMinutes) + '）？';
      } else {
        text.textContent = '「' + item.task.title + '」原定 ' + fmtDateTime(item.task.dueAt) +
          ' 完成，最近两周都没找到合适的时段——可以去「课表与设置」放宽每天可用的时间。';
      }
      row.appendChild(text);

      if (item.partial) {
        var h = document.createElement('p');
        h.className = 'hint';
        h.textContent = '这段时间放不下全部 ' + fmtMinutes(item.task.remainingMinutes) +
          '，先做这一段，剩下的下次接着排。';
        row.appendChild(h);
      }

      if (item.slot) {
        var actions = document.createElement('div');
        actions.className = 'actions';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--primary';
        btn.textContent = '放到这个时间';
        btn.addEventListener('click', function () {
          var saved = safely(function () {
            return model.confirmReschedule(item.task.id, item.plannedStart, item.plannedEnd);
          }, '已改期：' + scheduler.formatSlot(item.slot, new Date()));
          if (saved !== null) renderAll();
        });
        actions.appendChild(btn);
        row.appendChild(actions);
      }

      box.appendChild(row);
    });
  }

  /** 首页「要做的事」区块：单独拆出来，它出错时不至于把整页拖垮 */
  function renderTaskList() {
    clearCardState('tasks');
    var pending, doneToday;
    try {
      var tasks = model.listTasks();
      pending = tasks.filter(function (t) { return t.status !== 'done'; });
      doneToday = tasks.filter(function (t) { return t.status === 'done' && isToday(t.completedAt); });
      fillTaskList('taskList', 'taskEmpty', pending, null, { allowSchedule: true });
    } catch (e) {
      failCard('tasks', e);
      return;
    }

    var hint = el('taskListHint');
    if (hint) hint.hidden = pending.length === 0;

    var cardDone = el('cardDone');
    var doneBox = el('doneList');
    if (cardDone && doneBox) {
      doneBox.innerHTML = '';
      if (doneToday.length) {
        cardDone.hidden = false;
        doneToday.forEach(function (t) { doneBox.appendChild(buildTaskRow(t)); });
      } else {
        cardDone.hidden = true;
      }
    }
  }

  function renderHome() {
    // 演示模式：先把"加载中"演一遍再继续。
    // 说明白：这一帧在真实使用时几乎看不见（本地读取是瞬时的），
    // 它真正有用的时候是阶段二接了云数据库——那时候等待是真实存在的。
    var demo = currentDemoMode();
    if (demo === 'loading') {
      var holdMs = (window.NoMissDemo && window.NoMissDemo.loadingHoldMs) || 1200;
      if (!loadingDemoPlayed) {
        loadingDemoPlayed = true;
        loadingDemoUntil = Date.now() + holdMs;
        setTimeout(function () { renderAll(); }, holdMs);
      }
      if (Date.now() < loadingDemoUntil) {
        ['advice', 'settle', 'reschedule', 'week', 'timeline', 'tasks'].forEach(loadingCard);
        return;
      }
    }

    // 先做一次"截止时间已过"的核对：它只改状态，不改任何数值。
    // 没被核对到就渲染，等于用旧状态画界面，下一帧又变了，看起来会像界面在闪。
    safely(function () { return model.reconcileOverdue(new Date()); });

    var adv = null;
    var failure = null;
    try {
      adv = scheduler.getTodayAdvice(new Date());
    } catch (e) {
      failure = e;
    }

    renderAdvice(adv, failure);
    renderSettle();
    renderReschedule();
    renderWeek();
    renderTimeline(adv);
    renderTaskList();
  }

  /* ---------- 详情渲染 ---------- */

  function renderDetail() {
    var task = selectedTaskId ? model.findTask(selectedTaskId) : null;
    var body = el('detailBody');
    var actions = el('detailActions');
    var emptyEl = el('detailEmpty');

    if (!task) {
      if (body) body.hidden = true;
      if (actions) actions.hidden = true;
      if (emptyEl) emptyEl.hidden = false;
      return;
    }

    if (body) body.hidden = false;
    if (actions) actions.hidden = false;
    if (emptyEl) emptyEl.hidden = true;

    el('dTitle').textContent = task.title;
    el('dDue').textContent = task.dueAt ? fmtDateTime(task.dueAt) : '没设截止时间';
    el('dEstimate').textContent = fmtMinutes(task.estimateMinutes);
    el('dRemaining').textContent = fmtMinutes(task.remainingMinutes);
    el('dSegments').textContent = (task.scheduledSegments && task.scheduledSegments.length)
      ? task.scheduledSegments.map(function (s) { return fmtDateTime(s.start) + ' – ' + fmtDateTime(s.end); }).join('；')
      : '还没排进时间表';
    el('dStatus').textContent = statusText(task.status);
    el('dCreated').textContent = fmtDateTime(task.createdAt);

    var btnDone = el('btnDone');
    if (btnDone) {
      btnDone.textContent = task.status === 'done' ? '放回待办' : '标记完成';
    }
  }

  /* ---------- 课表与设置渲染 ---------- */

  function renderBlocks() {
    var box = el('blockList');
    var emptyEl = el('blockEmpty');
    if (!box) return;
    clearCardState('blocks');

    var blocks;
    try {
      blocks = model.listBlocks();
    } catch (e) {
      failCard('blocks', e);
      return;
    }
    box.innerHTML = '';
    if (!blocks.length) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;

    blocks.sort(function (a, b) { return a.weekday - b.weekday || a.startTime.localeCompare(b.startTime); });

    blocks.forEach(function (b) {
      var row = document.createElement('div');
      row.className = 'task';

      var body = document.createElement('div');
      body.className = 'task-body';
      var title = document.createElement('p');
      title.className = 'task-title';
      title.textContent = b.title;
      var meta = document.createElement('p');
      meta.className = 'task-meta';
      meta.textContent = WEEK[b.weekday - 1] + ' ' + b.startTime + ' – ' + b.endTime + ' · 每周重复';
      body.appendChild(title);
      body.appendChild(meta);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn--tiny';
      del.textContent = '删除';
      del.addEventListener('click', function () {
        if (!window.confirm('删掉「' + b.title + '」？之后每个' + WEEK[b.weekday - 1] + '都不再显示它。')) return;
        var ok = safely(function () { return model.removeBlock(b.id); }, '已删除');
        if (ok !== null) renderAll();
      });

      row.appendChild(body);
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  function renderSettingsFields() {
    clearCardState('settings');
    var s;
    try {
      s = model.getSettings();
    } catch (e) {
      failCard('settings', e);
      return;
    }
    el('sDayStart').value = s.dayStart;
    el('sDayEnd').value = s.dayEnd;
    el('sDefaultEstimate').value = s.defaultEstimate;
  }

  /* ---------- 「修改任务」：复用「添加任务」那张表单 ---------- */

  /**
   * 进入修改模式：把任务的内容回填到表单里。
   *
   * 为什么不另做一个修改页：添加和修改填的是同样的三个字段，
   * 做两张表单等于同一套校验写两遍、以后改一处忘一处。所以复用同一张表单，
   * 只是标题、按钮文字和提交后的去向不同。
   */
  function startEdit(taskId) {
    var task = model.findTask(taskId);
    if (!task) {
      showNotice('这条任务找不到了。', 'warn');
      return;
    }
    editingTaskId = task.id;
    el('fTitle').value = task.title;
    el('fDue').value = toLocalInputValue(task.dueAt);
    el('fEstimate').value = task.estimateMinutes;

    // 回填"最近一段"的执行时段。
    // 注意：这里只显示一段，但**没改动就不会去动其它段**（见提交处的判断）——
    // 否则编辑一次任务名，就会把它排在别天的时段悄悄抹掉。
    var seg = (task.scheduledSegments || [])[0] || null;
    el('fSegStart').value = seg ? toLocalInputValue(seg.start) : '';
    el('fSegEnd').value = seg ? toLocalInputValue(seg.end) : '';
    editingSegmentDay = seg ? scheduler.isoDay(new Date(seg.start)) : null;
    editingSegmentStart = seg ? seg.start : null;

    el('addCardLabel').textContent = '修改任务';
    el('btnSave').textContent = '保存修改';
    el('btnDeleteInForm').hidden = false;
    location.hash = '#add';
  }

  /** 退出修改模式，把表单还原成"添加"的样子 */
  function resetAddForm() {
    editingTaskId = null;
    el('fTitle').value = '';
    el('fDue').value = '';
    el('fEstimate').value = '';
    el('fSegStart').value = '';
    el('fSegEnd').value = '';
    el('addCardLabel').textContent = '添加任务';
    el('btnSave').textContent = '保存';
    el('btnDeleteInForm').hidden = true;
    editingSegmentDay = null;
    editingSegmentStart = null;
  }

  /** ISO 时间 → datetime-local 输入框要的格式（本地时区，形如 2026-09-23T14:30） */
  function toLocalInputValue(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---------- 备份：导出 / 导入 ---------- */

  /** 导出：把全部数据存成一个 .json 文件下载下来 */
  function exportBackup() {
    var json = safely(function () { return model.exportBackup(); });
    if (json === null) return;

    var filename = 'nomiss-backup-' + scheduler.isoDay(new Date()) + '.json';
    var url = null;
    try {
      var blob = new Blob([json], { type: 'application/json' });
      url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showNotice('已导出：' + filename, 'ok');
    } catch (e) {
      showNotice('这次没能导出文件。可以试着换个浏览器，或者稍后再试一次。', 'warn');
    } finally {
      if (url) setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
  }

  /**
   * 导入：用文件里的内容替换现有数据。
   * 这一步会覆盖现有数据，所以**必须先问一次**（AGENTS.md 5.8：动数据前先说清风险）。
   */
  function importBackupFile(file) {
    if (!file) return;
    var reader = new FileReader();

    reader.onload = function () {
      var okToGo = window.confirm(
        '导入会用文件里的内容替换现在浏览器里的全部任务、课表和设置。\n\n' +
        '原来那份不会自动留备份——如果还想留着，先取消、点「导出备份」存一份，再回来导入。\n\n' +
        '确定现在导入吗？'
      );
      if (!okToGo) return;

      var done = safely(function () { return model.importBackup(String(reader.result)); });
      if (done === null) return;
      showNotice('已导入。', 'ok');
      selectedTaskId = null;
      renderAll();
    };

    reader.onerror = function () {
      showNotice('这个文件读不出来，可能不是备份文件。', 'warn');
    };

    reader.readAsText(file);
  }

  /* ---------- 总刷新 ---------- */

  /**
   * 全部重画。
   *
   * 一块一块各管各的：某个区块出错，只影响它自己那张卡——
   * 以前是一条错误就把后面全带停，页面会停在"画了一半"的样子。
   */
  function renderAll() {
    [renderHome, renderDetail, renderBlocks, renderSettingsFields].forEach(function (fn) {
      try {
        fn();
      } catch (e) {
        reportCalcError(e);
      }
    });
  }

  /* ---------- 事件绑定 ---------- */

  function bindEvents() {
    // 防重复绑定：万一 init 被调用两次，事件会绑两遍——一次提交触发两次，
    // 第二遍时表单已清空，用户会看到一个莫名其妙的"请起个名字"。
    if (bound) return;
    bound = true;

    var form = el('taskForm');
    if (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();

        var editing = editingTaskId;
        var saved = safely(function () {
          var payload = {
            title: el('fTitle').value,
            dueAt: el('fDue').value || null,
            estimateMinutes: el('fEstimate').value || null
          };

          // —— 执行时段：只有用户真的动过它，才去碰数据 ——
          // 这条判断很重要：否则"只改个任务名"也会把这条任务排在别天的时段悄悄抹掉。
          var rawStart = el('fSegStart').value;
          var rawEnd = el('fSegEnd').value;
          var wantSeg = !!(rawStart || rawEnd);
          var segChanged = true;

          if (wantSeg && (!rawStart || !rawEnd)) {
            throw new Error('执行时段要填就填完整：开始和结束两个都填上。');
          }
          if (wantSeg && new Date(rawEnd).getTime() <= new Date(rawStart).getTime()) {
            throw new Error('执行时段的结束时间要晚于开始时间，改一下就能存。');
          }

          var newStartIso = wantSeg ? new Date(rawStart).toISOString() : null;
          var newEndIso = wantSeg ? new Date(rawEnd).toISOString() : null;
          if (editing) {
            segChanged = (newStartIso !== editingSegmentStart);
          }

          if (!editing) {
            // 新建：直接跟着任务一起写进去
            if (wantSeg) payload.scheduledSegments = [{ start: newStartIso, end: newEndIso }];
            return model.addTask(payload);
          }

          var updated = model.updateTask(editing, payload);
          if (segChanged) {
            updated = wantSeg
              ? model.scheduleTaskFor(editing, newStartIso, newEndIso)          // 替换那一天，其它天不动
              : (editingSegmentStart ? model.unscheduleDay(editing, editingSegmentStart) : updated);
          }
          return updated;
        });

        if (!saved) return;
        var wasEditing = !!editing;
        resetAddForm();
        selectedTaskId = saved.id;
        location.hash = '#home';
        showNotice(wasEditing ? '已保存修改：' + saved.title : '已记下：' + saved.title, 'ok');
        renderAll();
      });
    }

    var btnCancel = el('btnCancel');
    if (btnCancel) {
      btnCancel.addEventListener('click', function () {
        resetAddForm();
        location.hash = '#home';
      });
    }

    var btnQuickAdd = el('btnQuickAdd');
    if (btnQuickAdd) {
      btnQuickAdd.addEventListener('click', function () {
        resetAddForm();
        location.hash = '#add';
      });
    }

    var btnDeleteInForm = el('btnDeleteInForm');
    if (btnDeleteInForm) {
      btnDeleteInForm.addEventListener('click', function () {
        var id = editingTaskId;
        if (!id) return;
        var t = model.findTask(id);
        if (!t) return;
        if (!window.confirm('删掉「' + t.title + '」？这是唯一会问你一次的操作。')) return;
        var ok = safely(function () { return model.removeTask(id); }, '已删除');
        if (ok !== null) {
          resetAddForm();
          selectedTaskId = null;
          location.hash = '#home';
          renderAll();
        }
      });
    }

    var btnEdit = el('btnEdit');
    if (btnEdit) {
      btnEdit.addEventListener('click', function () {
        if (selectedTaskId) startEdit(selectedTaskId);
      });
    }

    var btnExport = el('btnExport');
    if (btnExport) {
      btnExport.addEventListener('click', exportBackup);
    }

    var btnImport = el('btnImport');
    var fileImport = el('fileImport');
    if (btnImport && fileImport) {
      btnImport.addEventListener('click', function () { fileImport.click(); });
      fileImport.addEventListener('change', function () {
        importBackupFile(fileImport.files && fileImport.files[0]);
        fileImport.value = ''; // 允许连续导入同一个文件
      });
    }

    var btnFollowAdvice = el('btnFollowAdvice');
    if (btnFollowAdvice) {
      btnFollowAdvice.addEventListener('click', function () {
        var adv = currentAdvice;
        if (!adv || adv.kind !== 'advice') return;
        if (!(adv.planMinutes > 0)) return;
        var startMs = new Date(adv.slot.start).getTime();
        var endIso = new Date(startMs + adv.planMinutes * 60000).toISOString();
        var saved = safely(function () {
          return model.scheduleTaskFor(adv.task.id, adv.slot.start, endIso);
        }, '已排进今天：' + scheduler.formatSlot(adv.slot, new Date()));
        if (saved !== null) renderAll();
      });
    }

    var btnDone = el('btnDone');
    if (btnDone) {
      btnDone.addEventListener('click', function () {
        if (!selectedTaskId) return;
        var ok = safely(function () {
          var t = model.findTask(selectedTaskId);
          if (!t) return null;
          if (t.status === 'done') {
            return model.updateTask(t.id, { status: 'todo', completedAt: null, remainingMinutes: t.estimateMinutes });
          }
          return model.completeTask(t.id);
        }, '已更新');
        if (ok !== null) renderAll();
      });
    }

    var btnDelete = el('btnDelete');
    if (btnDelete) {
      btnDelete.addEventListener('click', function () {
        if (!selectedTaskId) return;
        var t = model.findTask(selectedTaskId);
        if (!t) return;
        if (!window.confirm('删掉「' + t.title + '」？这是唯一会问你一次的操作。')) return;
        var ok = safely(function () { return model.removeTask(selectedTaskId); }, '已删除');
        if (ok !== null) {
          // 如果正在修改的正是这条，退出修改模式，免得表单还留着一条已经不存在的任务
          if (editingTaskId === selectedTaskId) resetAddForm();
          selectedTaskId = null;
          location.hash = '#home';
          renderAll();
        }
      });
    }

    var btnAddBlock = el('btnAddBlock');
    if (btnAddBlock) {
      btnAddBlock.addEventListener('click', function () {
        var ok = safely(function () {
          return model.addBlock({
            title: el('bTitle').value,
            weekday: el('bWeekday').value,
            startTime: el('bStart').value,
            endTime: el('bEnd').value
          });
        }, '已加入课表，之后每周自动重复');
        if (ok) {
          el('bTitle').value = '';
          renderAll();
        }
      });
    }

    var btnSaveSettings = el('btnSaveSettings');
    if (btnSaveSettings) {
      btnSaveSettings.addEventListener('click', function () {
        var ok = safely(function () {
          return model.updateSettings({
            dayStart: el('sDayStart').value,
            dayEnd: el('sDayEnd').value,
            defaultEstimate: el('sDefaultEstimate').value
          });
        }, '设置已保存');
        if (ok) renderAll();
      });
    }
  }

  function init() {
    // 首次运行就把三条默认值落盘，避免后面到处判断"有没有"
    safely(function () { return model.ensureDefaults(); });

    // 演示模式：顶部挂一条横幅，随时提醒"你现在看的不是真实数据"
    var banner = el('demoBanner');
    if (banner && window.NoMissDemo && window.NoMissDemo.isActive) {
      banner.textContent = window.NoMissDemo.banner;
      banner.hidden = false;
    }

    bindEvents();
    renderAll();
  }

  /**
   * 切换视图时只重画这个视图需要的东西。
   * 单独做一层，是为了避免"切个页面就把别处正在编辑的内容冲掉"。
   */
  function onViewChange(name) {
    if (name === 'home') renderHome();
    else if (name === 'detail') renderDetail();
    else if (name === 'settings') { renderBlocks(); renderSettingsFields(); }
  }

  window.NoMissViews = {
    init: init,
    renderAll: renderAll,
    onViewChange: onViewChange,
    showNotice: showNotice
  };
})();
