/**
 * scheduler.js —— 计算层（"大脑"）
 *
 * 职责：只做算术——算空档、判冲突、排紧迫度、给建议。
 *       不记东西（那是 storage.js 的事），不画界面（那是 views.js 的事）。
 *
 * 一条来自 Day 5 每日一问的原则（见 TECH_DESIGN.md 7.4）：
 *   **只持久化原始数据，衍生数据每次重新计算。**
 *   所以本文件里的空档、冲突、紧迫度、建议都不存盘——它们每次都被重新算，
 *   这样你改了任务时间，界面立刻一致，界面永远不会说谎。
 *
 * 对应 PRD：F1（一周负荷）、F3（冲突提示）、F5（今日建议）、F8（分段推进）、F9（待重新安排）
 */

(function () {
  'use strict';

  var model = window.NoMissModel;

  /** 短于这个分钟数的空档，不作为"排活"的依据（不值得开始一件事） */
  var MIN_BLOCK_MINUTES = 10;

  /** 负荷比例达到多少算"这天比较满"（PRD F1 / 验收 8.8） */
  var OVERLOAD_RATIO = 0.8;

  /* ================= 时间小工具 ================= */

  function toDate(v) {
    return v instanceof Date ? v : new Date(v);
  }

  function startOfDay(d) {
    var x = toDate(d);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate(), 0, 0, 0, 0);
  }

  function addDays(d, n) {
    var x = startOfDay(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function sameDay(a, b) {
    return startOfDay(a).getTime() === startOfDay(b).getTime();
  }

  function minutesOfDay(d) {
    var x = toDate(d);
    return x.getHours() * 60 + x.getMinutes();
  }

  function atMinutes(day, min) {
    var d = startOfDay(day);
    return new Date(d.getTime() + min * 60000);
  }

  /** 把 1–7 的星期编号算出来（1 = 周一 … 7 = 周日），与 PRD 的 weekday 字段一致 */
  function weekdayOf(d) {
    var js = toDate(d).getDay(); // 0 = 周日
    return js === 0 ? 7 : js;
  }

  function dayKey(d) {
    var x = toDate(d);
    return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function isoDay(d) {
    var x = toDate(d);
    return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
  }

  /** 给用户看的日期时间说法：今天 / 明天 / 9月25日 12:00 */
  function formatWhen(v, now) {
    var d = toDate(v);
    var base = now ? toDate(now) : new Date();
    var time = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (sameDay(d, base)) return '今天 ' + time;
    if (sameDay(d, addDays(base, 1))) return '明天 ' + time;
    if (sameDay(d, addDays(base, -1))) return '昨天 ' + time;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + time;
  }

  function formatSlot(slot, now) {
    var s = toDate(slot.start);
    var e = toDate(slot.end);
    var head = sameDay(s, now || new Date()) ? '' : (s.getMonth() + 1) + '月' + s.getDate() + '日 ';
    return head + pad2(s.getHours()) + ':' + pad2(s.getMinutes()) + '–' + pad2(e.getHours()) + ':' + pad2(e.getMinutes());
  }

  /* ================= 区间运算 ================= */

  function mergeIntervals(list) {
    var sorted = list.slice().sort(function (a, b) { return a.startMin - b.startMin; });
    var out = [];
    sorted.forEach(function (it) {
      var last = out[out.length - 1];
      if (last && it.startMin <= last.endMin) {
        last.endMin = Math.max(last.endMin, it.endMin);
      } else {
        out.push({ startMin: it.startMin, endMin: it.endMin });
      }
    });
    return out;
  }

  /** 从 base 里挖掉 busy，得到剩余区间（自由时间） */
  function subtractIntervals(base, busy) {
    var free = base.slice();
    mergeIntervals(busy).forEach(function (b) {
      var next = [];
      free.forEach(function (f) {
        if (b.endMin <= f.startMin || b.startMin >= f.endMin) { next.push(f); return; } // 不相交
        if (b.startMin > f.startMin) next.push({ startMin: f.startMin, endMin: b.startMin });
        if (b.endMin < f.endMin) next.push({ startMin: b.endMin, endMin: f.endMin });
      });
      free = next;
    });
    return free.filter(function (f) { return f.endMin > f.startMin; });
  }

  /* ================= 这一天的"忙碌区间" ================= */

  /**
   * 收集某一天所有被占用的时段：固定占用（课表）+ 已排任务时段。
   * 三种冲突（课vs课、课vs任务、任务vs任务）都靠这一份清单两两比对得出。
   */
  function getBusyIntervals(date) {
    var target = startOfDay(date);
    var dayStartMs = target.getTime();
    var dayEndMs = dayStartMs + 24 * 60 * 60000;
    var list = [];

    model.listBlocks().forEach(function (b) {
      if (b.weekday !== weekdayOf(target)) return;
      var s = model.toMinutes(b.startTime);
      var e = model.toMinutes(b.endTime);
      if (s === null || e === null || e <= s) return;
      list.push({ startMin: s, endMin: e, source: 'block', id: b.id, title: b.title });
    });

    model.listTasks().forEach(function (t) {
      (t.scheduledSegments || []).forEach(function (seg, idx) {
        var s = new Date(seg.start);
        var e = new Date(seg.end);
        if (isNaN(s.getTime()) || isNaN(e.getTime())) return;
        if (e.getTime() <= dayStartMs || s.getTime() >= dayEndMs) return; // 不在这一天
        var sMin = Math.max(0, Math.round((s.getTime() - dayStartMs) / 60000));
        var eMin = Math.min(1440, Math.round((e.getTime() - dayStartMs) / 60000));
        if (eMin <= sMin) return;
        list.push({
          startMin: sMin,
          endMin: eMin,
          source: 'task',
          id: t.id,
          title: t.title,
          segmentIndex: idx,
          done: t.status === 'done'
        });
      });
    });

    return list;
  }

  /* ================= 空档 ================= */

  /**
   * 某日【当前时刻之后】的空档。
   * - 当天：只看现在往后的部分（过去的不再作为建议依据，见 PRD F5 空档定义）
   * - 未来的日子：整天都算
   * - 已经过去的日子：返回空
   */
  function getFreeSlots(date, now) {
    var target = startOfDay(date);
    var settings = model.getSettings();
    var dayStartMin = model.toMinutes(settings.dayStart);
    var dayEndMin = model.toMinutes(settings.dayEnd);
    if (dayStartMin === null || dayEndMin === null || dayEndMin <= dayStartMin) return [];

    var busy = mergeIntervals(getBusyIntervals(target));
    var free = subtractIntervals([{ startMin: dayStartMin, endMin: dayEndMin }], busy);

    var today = startOfDay(now || new Date());
    var floorMin = 0;
    if (target.getTime() < today.getTime()) return [];          // 过去的日子
    if (target.getTime() === today.getTime()) floorMin = minutesOfDay(now || new Date());

    var out = [];
    free.forEach(function (f) {
      var s = Math.max(f.startMin, floorMin);
      if (f.endMin - s < 1) return;
      out.push({
        date: isoDay(target),
        start: atMinutes(target, s).toISOString(),
        end: atMinutes(target, f.endMin).toISOString(),
        minutes: f.endMin - s
      });
    });
    return out;
  }

  /** 某日已占用的总时长（重叠部分只算一次，所以不会超过一天的总可用时长） */
  function getOccupiedMinutes(date) {
    var total = 0;
    mergeIntervals(getBusyIntervals(date)).forEach(function (i) { total += i.endMin - i.startMin; });
    return total;
  }

  /** 某日负荷比例 = 已占用 ÷ 当日可用时长（0–1） */
  function getLoadRatio(date) {
    var settings = model.getSettings();
    var dayStartMin = model.toMinutes(settings.dayStart);
    var dayEndMin = model.toMinutes(settings.dayEnd);
    var span = dayEndMin - dayStartMin;
    if (!(span > 0)) return 0;
    var ratio = getOccupiedMinutes(date) / span;
    return ratio > 1 ? 1 : ratio;
  }

  /** 一周负荷（供「本周大局」用） */
  function getWeekLoad(fromDate, dayCount) {
    var n = dayCount || 7;
    var base = fromDate || new Date();
    var out = [];
    for (var i = 0; i < n; i++) {
      var d = addDays(base, i);
      var ratio = getLoadRatio(d);
      var level = ratio >= OVERLOAD_RATIO ? 'busy' : (ratio >= 0.5 ? 'normal' : 'light');
      out.push({
        date: isoDay(d),
        label: (d.getMonth() + 1) + '月' + d.getDate() + '日',
        weekday: weekdayOf(d),
        occupiedMinutes: getOccupiedMinutes(d),
        loadRatio: ratio,
        level: level
      });
    }
    return out;
  }

  /* ================= 冲突 ================= */

  /**
   * 两两比对，找出所有重叠时段。
   * 覆盖三种情况：课表↔课表、课表↔任务、任务↔任务（PRD 验收 3.5）
   */
  function detectConflicts(days) {
    var list = days && days.length ? days : [new Date()];
    var out = [];
    list.forEach(function (day) {
      var items = getBusyIntervals(day);
      for (var i = 0; i < items.length; i++) {
        for (var j = i + 1; j < items.length; j++) {
          var a = items[i];
          var b = items[j];
          var os = Math.max(a.startMin, b.startMin);
          var oe = Math.min(a.endMin, b.endMin);
          if (oe <= os) continue;
          out.push({
            date: isoDay(day),
            day: isoDay(day),
            a: a,
            b: b,
            overlapStart: atMinutes(day, os).toISOString(),
            overlapEnd: atMinutes(day, oe).toISOString(),
            overlapMinutes: oe - os,
            range: pad2(Math.floor(os / 60)) + ':' + pad2(os % 60) + '–' + pad2(Math.floor(oe / 60)) + ':' + pad2(oe % 60),
            text: a.title + ' 与 ' + b.title + ' 在 ' + pad2(Math.floor(os / 60)) + ':' + pad2(os % 60) +
                  '–' + pad2(Math.floor(oe / 60)) + ':' + pad2(oe % 60) + ' 重叠'
          });
        }
      }
    });
    return out;
  }

  /* ================= 紧迫度排序 ================= */

  /**
   * 紧迫度 = （截止时间 − 现在）÷ 剩余用时
   *   · 数字越小越急；已过截止时间时为负数，天然排最前（所以不需要标红）
   *   · 没有截止时间的任务排最后
   *   · 处于「待重新安排」的任务不参与（PRD F5 / F9）
   */
  function urgencyOf(task, now) {
    if (!task) return Number.POSITIVE_INFINITY;
    if (!task.dueAt) return Number.POSITIVE_INFINITY;
    var due = new Date(task.dueAt).getTime();
    if (isNaN(due)) return Number.POSITIVE_INFINITY;
    var need = Math.max(Number(task.remainingMinutes) || 0, 1);
    return (due - toDate(now).getTime()) / 60000 / need;
  }

  function isPending(task) {
    return task && task.status !== 'done' && task.status !== 'needsReschedule';
  }

  /**
   * 今天"还占着位置"的任务（键为 id）。
   *
   * 为什么要单独认得它们：这些任务的时段已经写进数据了、也已经在地图上占着位置，
   * 系统补位时不该再给它们排一次——否则同一件事会在地图上出现两次，看起来像让你做两遍。
   * 一次补位只服务"还没安排的事"。
   *
   * 两点讲究：
   *   · 已经结束的时段不算（那一段已经过去了，事情可能还没做完，该重新参与安排）
   *   · 只算今天，且以 refTime 为界
   */
  function placedTodayMap(day, refTime) {
    var target = startOfDay(day || new Date());
    var ref = refTime ? toDate(refTime) : new Date();
    var refMin = (target.getTime() === startOfDay(ref).getTime()) ? minutesOfDay(ref) : 0;
    var map = {};
    getBusyIntervals(target).forEach(function (b) {
      if (b.source !== 'task') return;
      if (b.endMin <= refMin) return;
      map[b.id] = true;
    });
    return map;
  }

  function rankTasks(now) {
    var base = now || new Date();
    var list = model.listTasks().filter(isPending);
    list.forEach(function (t) { t.__urgency = urgencyOf(t, base); });
    list.sort(function (a, b) {
      if (a.__urgency !== b.__urgency) return a.__urgency - b.__urgency;
      var ca = a.createdAt || '';
      var cb = b.createdAt || '';
      return ca < cb ? -1 : (ca > cb ? 1 : 0);
    });
    return list;
  }

  /* ================= 建议 ================= */

  /** 取时长最长的那段空档（一样长时取更早的） */
  function largestSlot(list) {
    var best = null;
    list.forEach(function (s) {
      if (!best || s.minutes > best.minutes) best = s;
    });
    return best;
  }

  function buildReason(task, now) {
    var parts = [];
    var due = task.dueAt ? new Date(task.dueAt) : null;
    if (due && !isNaN(due.getTime())) {
      var overdue = due.getTime() < toDate(now).getTime();
      parts.push(overdue
        ? '它原定 ' + formatWhen(due, now) + ' 完成，现在需要重新安排'
        : '它要在 ' + formatWhen(due, now) + ' 之前完成');
    } else {
      parts.push('它还没定截止时间');
    }
    parts.push('还剩 ' + Math.max(0, Number(task.remainingMinutes) || 0) + ' 分钟要做');
    return parts.join('，') + '。';
  }

  /**
   * 唯一一条「现在做这个」。
   * 返回结构（kind 有四种，界面按 kind 显示不同状态文字）：
   *   { kind:'no-task' }                                   一条待办都没有
   *   { kind:'all-placed' }                                待办都有今天的时段了
   *   { kind:'no-slot', nextAvailable }                    今天没空档了，给出最早可行时间
   *   { kind:'advice', task, slot, plannedStart, plannedEnd,
   *     planMinutes, remainingAfter, partial, deferred, reason }
   */
  function getTodayAdvice(now) {
    var base = now || new Date();
    var pending = model.listTasks().filter(isPending);
    if (!pending.length) return { kind: 'no-task' };

    // 已经排进今天的任务不再重复建议（它的时段已经在地图上了）
    var placed = placedTodayMap(base, base);
    var ranked = rankTasks(base).filter(function (t) { return !placed[t.id]; });
    if (!ranked.length) return { kind: 'all-placed', placedCount: pending.length };

    var usable = getFreeSlots(base, base).filter(function (s) { return s.minutes >= MIN_BLOCK_MINUTES; });
    if (!usable.length) {
      return { kind: 'no-slot', nextAvailable: predictNextAvailable(ranked[0], addDays(base, 1)) };
    }

    // 按紧迫度升序，取第一个"放得下"的任务
    var pick = null;
    for (var i = 0; i < ranked.length; i++) {
      var t = ranked[i];
      var fit = null;
      for (var j = 0; j < usable.length; j++) {
        if (usable[j].minutes >= t.remainingMinutes) { fit = usable[j]; break; }
      }
      if (fit) { pick = { task: t, slot: fit, partial: false }; break; }
    }

    // 最紧急的任务也放不下 → 分段推进（F8）
    // 这里刻意取"今天最长的那段空档"，而不是"最早的那段"：
    // 分段推进的意义是让你真正往前推一截，若取到只有 20 分钟的碎空档，
    // 一句"先做 20 分钟"对一件要 15 小时的事毫无意义。
    if (!pick) {
      pick = { task: ranked[0], slot: largestSlot(usable), partial: true };
    }

    var planMinutes = pick.partial ? pick.slot.minutes : pick.task.remainingMinutes;

    // 若最紧急的那件事今天根本排不下、而建议给了别的任务，
    // 把它记下来，让界面可以额外提一句"最早什么时候能做"——
    // 否则它会一直被别的任务顶掉，永远不出现在建议里。
    var deferred = null;
    if (pick.task !== ranked[0]) {
      deferred = {
        task: ranked[0],
        nextAvailable: predictNextAvailable(ranked[0], addDays(base, 1))
      };
    }

    // 真正会被排进去的时段：从空档起点算起 planMinutes 分钟
    // （空档有 4 小时、事情只要 1 小时时，界面上必须显示那 1 小时，不是 4 小时）
    var startMs = new Date(pick.slot.start).getTime();

    return {
      kind: 'advice',
      task: pick.task,
      slot: pick.slot,
      plannedStart: new Date(startMs).toISOString(),
      plannedEnd: new Date(startMs + Math.round(planMinutes) * 60000).toISOString(),
      planMinutes: Math.max(0, Math.round(planMinutes)),
      remainingAfter: Math.max(0, Math.round(pick.task.remainingMinutes - planMinutes)),
      partial: pick.partial,
      deferred: deferred,
      reason: buildReason(pick.task, base)
    };
  }

  /**
   * 今天的安排（"地图"，弱呈现）：
   * 把课、已排任务、系统补位的时段、以及仍然空着的时间，按时间顺序排出来。
   *
   * 可选传入 `advice`（getTodayAdvice 的结果）：顶部那条建议指定的时段会被**原样固定**
   * 在地图里——否则会出现"建议说一次做完 45 分钟、地图却显示先做 20 分钟"这种自相矛盾。
   *
   * 注意：这里算出的补位时段**只是显示**，不会写进数据——你不动它，它就不会改变你的任务。
   */
  function getTodayTimeline(now, advice) {
    var base = now || new Date();
    var today = startOfDay(base);
    var settings = model.getSettings();
    var dayStartMin = model.toMinutes(settings.dayStart);
    var dayEndMin = model.toMinutes(settings.dayEnd);

    var items = [];

    getBusyIntervals(today).forEach(function (b) {
      items.push({
        kind: b.source === 'block' ? 'block' : 'task',
        title: b.title,
        id: b.id,
        start: atMinutes(today, b.startMin).toISOString(),
        end: atMinutes(today, b.endMin).toISOString(),
        minutes: b.endMin - b.startMin,
        done: !!b.done,
        startMin: b.startMin
      });
    });

    // 空档 + 系统补位的软计划
    // 已经排进今天的任务不参与补位——它的时段已经在地图上了（kind = 'task'）
    var placed = placedTodayMap(today, base);
    var queue = rankTasks(base)
      .filter(function (t) { return !placed[t.id]; })
      .map(function (t) {
        return { task: t, left: Math.max(0, Number(t.remainingMinutes) || 0) };
      });
    var qi = 0;

    // 顶部建议指定的那段，先在地图里钉住
    var pinnedStart = null;
    var pinnedMinutes = 0;
    if (advice && advice.kind === 'advice' && advice.slot && advice.planMinutes > 0) {
      pinnedStart = new Date(advice.slot.start).getTime();
      pinnedMinutes = advice.planMinutes;
    }

    getFreeSlots(today, base).forEach(function (slot) {
      var cursor = new Date(slot.start).getTime();
      var left = slot.minutes;

      if (pinnedStart !== null && cursor === pinnedStart) {
        var pinMin = Math.min(pinnedMinutes, left);
        items.push({
          kind: 'plan',
          pinned: true,
          title: advice.task.title,
          id: advice.task.id,
          start: new Date(cursor).toISOString(),
          end: new Date(cursor + pinMin * 60000).toISOString(),
          minutes: pinMin,
          isContinuation: false,
          isPartial: !!advice.partial,
          startMin: minutesOfDay(new Date(cursor))
        });
        cursor += pinMin * 60000;
        left -= pinMin;
        queue.forEach(function (q) {
          if (q.task.id === advice.task.id) q.left = Math.max(0, q.left - pinMin);
        });
      }

      while (left >= MIN_BLOCK_MINUTES && qi < queue.length) {
        var q = queue[qi];
        if (q.left <= 0) { qi++; continue; }
        var take = Math.min(q.left, left);
        if (take < MIN_BLOCK_MINUTES) break;
        items.push({
          kind: 'plan',
          pinned: false,
          title: q.task.title,
          id: q.task.id,
          start: new Date(cursor).toISOString(),
          end: new Date(cursor + take * 60000).toISOString(),
          minutes: take,
          isContinuation: q.left < (Number(q.task.remainingMinutes) || 0),
          isPartial: take < q.left,
          startMin: minutesOfDay(new Date(cursor))
        });
        cursor += take * 60000;
        left -= take;
        q.left -= take;
        if (q.left > 0) break; // 这一段用完，下一段排到下一个空档
        qi++;
      }

      if (left >= 1) {
        items.push({
          kind: 'free',
          title: '',
          id: null,
          start: new Date(cursor).toISOString(),
          end: new Date(cursor + left * 60000).toISOString(),
          minutes: left,
          startMin: minutesOfDay(new Date(cursor))
        });
      }
    });

    items.sort(function (a, b) {
      if (a.startMin !== b.startMin) return a.startMin - b.startMin;
      return a.kind === 'free' ? 1 : -1;
    });
    return items;
  }

  /* ================= 放不下时：最早可行时间 ================= */

  /**
   * 从 from 起往后找，给出最早能做的时段。
   * 先找"整段放得下"的；找不到就退而给"最早能开始做一段"的（分段推进）。
   *
   * 返回里带上 `plannedStart` / `plannedEnd` / `planMinutes`——**这是"真正要占用的时段"**，
   * 不是那段空档的全部长度。调用方（按钮、续排）必须用这三个，不能直接拿 `slot` 去写数据：
   * 空档有 10 小时、事情只差 3.5 小时时，写 10 小时就是在骗人，也会把负荷算虚高。
   */
  function predictNextAvailable(task, from) {
    if (!task) return null;
    var need = Math.max(0, Number(task.remainingMinutes) || 0);
    var base = from ? toDate(from) : new Date();
    var fallback = null;
    var hit = null;

    for (var i = 0; i < 14 && !hit; i++) {
      var day = addDays(base, i);
      var slots = getFreeSlots(day, base).filter(function (s) { return s.minutes >= MIN_BLOCK_MINUTES; });
      if (!slots.length) continue;
      for (var j = 0; j < slots.length; j++) {
        if (slots[j].minutes >= need) { hit = { date: isoDay(day), slot: slots[j], partial: false }; break; }
      }
      if (!fallback) fallback = { date: isoDay(day), slot: largestSlot(slots), partial: true };
    }

    var chosen = hit || fallback;
    if (!chosen) return null;

    var planMinutes = chosen.partial
      ? chosen.slot.minutes
      : Math.min(need, chosen.slot.minutes);
    var startMs = new Date(chosen.slot.start).getTime();
    chosen.planMinutes = Math.round(planMinutes);
    chosen.plannedStart = new Date(startMs).toISOString();
    chosen.plannedEnd = new Date(startMs + chosen.planMinutes * 60000).toISOString();
    return chosen;
  }

  /* ================= 分段推进：段落结算（F8） ================= */

  /**
   * 哪些已排的时段"时间到了"、但还没问过「做完了吗」。
   *
   * 只问一次：回答过（`settled`）的段落不再出现——否则每次打开首页都要回答同一段，
   * 那就成了骚扰，与我们"不做催你的工具"的立场相反。
   */
  function getPendingSettlements(now) {
    var base = now || new Date();
    var out = [];
    model.listTasks().forEach(function (t) {
      if (t.status !== 'todo') return; // 已完成 / 已在重排流程里的都不问
      (t.scheduledSegments || []).forEach(function (s) {
        if (s.settled) return;
        var start = new Date(s.start);
        var end = new Date(s.end);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return;
        if (end.getTime() > base.getTime()) return; // 还没到点
        var minutes = Math.max(0, Math.round((end - start) / 60000));
        out.push({
          task: t,
          start: s.start,
          end: s.end,
          minutes: minutes,
          remainingAfter: Math.max(0, Math.round((Number(t.remainingMinutes) || 0) - minutes))
        });
      });
    });
    out.sort(function (a, b) { return a.end < b.end ? -1 : (a.end > b.end ? 1 : 0); });
    return out;
  }

  /* ================= 待重新安排（F9） ================= */

  /**
   * 每条待重新安排的任务，给一个建议时段。
   * 用的是与 F5 完全相同的算法（同一套空档与紧迫度），不另建一套逻辑（PRD F9 明确要求）。
   */
  function getRescheduleSuggestions(now) {
    var base = now || new Date();
    return model.listTasks()
      .filter(function (t) { return t.status === 'needsReschedule'; })
      .map(function (t) {
        var next = predictNextAvailable(t, base);
        return {
          task: t,
          slot: next ? next.slot : null,
          plannedStart: next ? next.plannedStart : null,
          plannedEnd: next ? next.plannedEnd : null,
          planMinutes: next ? next.planMinutes : 0,
          partial: next ? !!next.partial : false,
          reason: buildReason(t, base)
        };
      });
  }

  /* ================= 对外接口 ================= */

  window.NoMissScheduler = {
    MIN_BLOCK_MINUTES: MIN_BLOCK_MINUTES,
    OVERLOAD_RATIO: OVERLOAD_RATIO,

    getBusyIntervals: getBusyIntervals,
    getFreeSlots: getFreeSlots,
    getOccupiedMinutes: getOccupiedMinutes,
    getLoadRatio: getLoadRatio,
    getWeekLoad: getWeekLoad,

    detectConflicts: detectConflicts,
    urgencyOf: urgencyOf,
    rankTasks: rankTasks,

    getTodayAdvice: getTodayAdvice,
    getTodayTimeline: getTodayTimeline,
    planToday: getTodayTimeline,
    predictNextAvailable: predictNextAvailable,
    getPendingSettlements: getPendingSettlements,
    getRescheduleSuggestions: getRescheduleSuggestions,

    // 时间格式化（供界面复用，避免两处各写一套）
    formatWhen: formatWhen,
    formatSlot: formatSlot,
    weekdayOf: weekdayOf,
    isoDay: isoDay,
    addDays: addDays,
    startOfDay: startOfDay,
    sameDay: sameDay
  };
})();
