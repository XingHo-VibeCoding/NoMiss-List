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

  /** 事件是否已经绑过（防重复绑定，见 bindEvents） */
  var bound = false;

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

    row.addEventListener('click', function () {
      selectedTaskId = task.id;
      location.hash = '#detail';
      renderDetail();
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
    mainEl.hidden = true;
    slotEl.hidden = true;
    reasonEl.hidden = true;
    extraEl.hidden = true;
    actionsEl.hidden = true;
    emptyEl.hidden = false;

    if (failure || !adv) {
      emptyEl.textContent = (failure && failure.message) ? failure.message : '这一步没算出来，稍后再看一次。';
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
    try {
      var now = new Date();
      var days = [];
      for (var i = 0; i < 7; i++) days.push(scheduler.addDays(now, i));

      var load = scheduler.getWeekLoad(now, 7);
      var conflicts = scheduler.detectConflicts(days);
      list.innerHTML = '';

      load.forEach(function (d, idx) {
        var n = conflicts.filter(function (c) { return c.date === d.date; }).length;
        var li = document.createElement('li');
        li.className = 'week-day is-' + d.level + (idx === 0 ? ' is-today' : '') + (n ? ' has-conflict' : '');
        li.title = d.label + ' · 已占用 ' + fmtMinutes(d.occupiedMinutes) +
                   (n ? ' · ' + n + ' 处时间重叠' : '');

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

    } catch (e) {
      reportCalcError(e);
    }
  }

  /** ①-3 今天的安排：只列时段和事，不喊口号 */
  function renderTimeline(adv) {
    var box = el('timelineList');
    if (!box) return;
    var TAG = { block: '课', task: '已排', plan: '建议', free: '空' };
    try {
      var now = new Date();
      var items = scheduler.getTodayTimeline(now, adv);
      var todayKey = scheduler.isoDay(now);

      // 今天的冲突，用来在对应行旁边标一句"和谁撞了"
      var todaysConflicts = scheduler.detectConflicts([now]);

      box.innerHTML = '';
      var emptyEl = el('timelineEmpty');
      if (!items.length) {
        if (emptyEl) emptyEl.hidden = false;
        return;
      }
      if (emptyEl) emptyEl.hidden = true;

      items.forEach(function (it) {
        var row = document.createElement('div');
        row.className = 'tl tl--' + it.kind + (it.pinned ? ' is-pinned' : '');

        var time = document.createElement('span');
        time.className = 'tl-time';
        time.textContent = hm(it.start) + '–' + hm(it.end);

        var tag = document.createElement('span');
        tag.className = 'tl-tag';
        tag.textContent = TAG[it.kind] || '';

        var title = document.createElement('span');
        title.className = 'tl-title';
        title.textContent = it.kind === 'free' ? '这段时间空着' : it.title;

        var mins = document.createElement('span');
        mins.className = 'tl-min';
        mins.textContent = fmtMinutes(it.minutes);

        row.appendChild(time);
        row.appendChild(tag);
        row.appendChild(title);

        // 撞了就直接在这行说出来——竞品只给你一张图让你自己看
        var other = conflictPartnerOf(todaysConflicts, todayKey, it);
        if (other) {
          row.className += ' has-conflict';
          var note = document.createElement('span');
          note.className = 'tl-note';
          note.textContent = '与「' + other + '」时间重叠';
          row.appendChild(note);
        } else {
          row.appendChild(mins);
        }

        box.appendChild(row);
      });

    } catch (e) {
      reportCalcError(e);
    }
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
    try {
      list = scheduler.getPendingSettlements(new Date());
    } catch (e) {
      reportCalcError(e);
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
    try {
      list = scheduler.getRescheduleSuggestions(new Date());
    } catch (e) {
      reportCalcError(e);
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

  function renderHome() {
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

    var tasks = model.listTasks();
    var pending = tasks.filter(function (t) { return t.status !== 'done'; });
    var doneToday = tasks.filter(function (t) { return t.status === 'done' && isToday(t.completedAt); });

    fillTaskList('taskList', 'taskEmpty', pending, null, { allowSchedule: true });
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
    var blocks = model.listBlocks();
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
    var s = model.getSettings();
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
    el('addCardLabel').textContent = '修改任务';
    el('btnSave').textContent = '保存修改';
    location.hash = '#add';
  }

  /** 退出修改模式，把表单还原成"添加"的样子 */
  function resetAddForm() {
    editingTaskId = null;
    el('fTitle').value = '';
    el('fDue').value = '';
    el('fEstimate').value = '';
    el('addCardLabel').textContent = '添加任务';
    el('btnSave').textContent = '保存';
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

  function renderAll() {
    renderHome();
    renderDetail();
    renderBlocks();
    renderSettingsFields();
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
          return editing
            ? model.updateTask(editing, payload)
            : model.addTask(payload);
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
