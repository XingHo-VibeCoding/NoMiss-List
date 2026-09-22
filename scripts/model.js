/**
 * model.js —— 数据模型层
 *
 * 职责：把界面上收到的少数几个字段，补成一条完整、合法、可存储的数据。
 *       这里是"规矩"所在：字段怎么补、什么算不合法、默认值是多少。
 *       具体的"存到哪"交给 storage.js（本文件不直接碰存储）。
 *
 * 界面上只收 3 个字段（任务名 / 截止时间 / 预计用时），
 * 而一条任务要存 9 个字段——差的那些在这里补齐（见 TECH_DESIGN.md 第五节）。
 */

(function () {
  'use strict';

  var storage = window.NoMissStorage;

  var DEFAULT_SETTINGS = {
    dayStart: '08:00',
    dayEnd: '22:00',
    defaultEstimate: 30
  };

  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  /* ---------- 错误对象 ---------- */

  function modelError(message) {
    var err = new Error(message);
    err.name = 'ModelError';
    return err;
  }

  /* ---------- 编号 ---------- */

  function makeId(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ---------- 时间小工具 ---------- */

  function isValidTime(v) {
    return typeof v === 'string' && TIME_RE.test(v);
  }

  function toMinutes(hhmm) {
    if (!isValidTime(hhmm)) return null;
    var parts = hhmm.split(':');
    return Number(parts[0]) * 60 + Number(parts[1]);
  }

  function isValidDateTime(v) {
    if (typeof v !== 'string' || v === '') return false;
    return !isNaN(new Date(v).getTime());
  }

  /* ---------- 设置 ---------- */

  function ensureDefaults() {
    var current = storage.readSettings();
    if (!current) {
      storage.writeSettings(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }
    // 缺哪个补哪个，不动用户已改过的值
    var merged = Object.assign({}, DEFAULT_SETTINGS, current);
    if (JSON.stringify(merged) !== JSON.stringify(current)) {
      storage.writeSettings(merged);
    }
    return merged;
  }

  /**
   * 取设置。
   *
   * 有个细节值得说明：如果存储**读不出来**（例如无痕模式），这里先用默认值
   * 把流程走完——因为用户此刻的意图是"保存"，不该让他先撞上一条"读不出数据"。
   * 真正的失败会在写入那一步以"没能存上"的形式报出来（更贴合他在做的事）。
   *
   * 但**数据损坏**（CORRUPT）不能这样吞掉：那说明旧数据是有的、只是坏了，
   * 若用默认值继续并覆盖写入，就会把用户原有的设置毁掉。所以必须原样往上抛。
   */
  function getSettings() {
    try {
      return ensureDefaults();
    } catch (e) {
      if (e && e.code === 'READ_FAILED') {
        return Object.assign({}, DEFAULT_SETTINGS);
      }
      throw e;
    }
  }

  function updateSettings(patch) {
    var form = Object.assign({}, patch);
    var checked = {};

    if ('dayStart' in form) {
      if (!isValidTime(form.dayStart)) throw modelError('可用时间的起点格式不对，应该是 08:00 这样。');
      checked.dayStart = form.dayStart;
    }
    if ('dayEnd' in form) {
      if (!isValidTime(form.dayEnd)) throw modelError('可用时间的终点格式不对，应该是 22:00 这样。');
      checked.dayEnd = form.dayEnd;
    }
    if ('defaultEstimate' in form) {
      var n = Number(form.defaultEstimate);
      if (!isFinite(n) || n <= 0) throw modelError('默认预计用时要是大于 0 的数字（分钟）。');
      checked.defaultEstimate = Math.round(n);
    }

    var start = toMinutes(checked.dayStart || getSettings().dayStart);
    var end = toMinutes(checked.dayEnd || getSettings().dayEnd);
    if (start !== null && end !== null && end <= start) {
      throw modelError('"每天可用的时间终点"要晚于起点，改一下就能存。');
    }

    return storage.writeSettings(checked);
  }

  /* ---------- 任务 ---------- */

  function createTask(input) {
    var title = (input && input.title ? String(input.title) : '').trim();
    if (!title) throw modelError('给这件事起个名字就能存了。');

    var settings = getSettings();
    var task = {
      id: makeId('t'),
      title: title,
      dueAt: null,
      estimateMinutes: settings.defaultEstimate,
      remainingMinutes: settings.defaultEstimate,
      scheduledSegments: [],
      status: 'todo',
      createdAt: new Date().toISOString(),
      completedAt: null
    };

    if (input.dueAt) {
      if (!isValidDateTime(input.dueAt)) throw modelError('截止时间的格式我读不出来，重新选一次。');
      task.dueAt = new Date(input.dueAt).toISOString();
    }

    if (input.estimateMinutes !== undefined && input.estimateMinutes !== null && input.estimateMinutes !== '') {
      var est = Number(input.estimateMinutes);
      if (!isFinite(est) || est <= 0) throw modelError('预计用时要是大于 0 的数字（分钟）。');
      task.estimateMinutes = Math.round(est);
      task.remainingMinutes = task.estimateMinutes;
    }

    if (Array.isArray(input.scheduledSegments)) {
      task.scheduledSegments = input.scheduledSegments.map(normalizeSegment);
    }

    return task;
  }

  function normalizeSegment(seg) {
    if (!isValidDateTime(seg.start) || !isValidDateTime(seg.end)) {
      throw modelError('执行时段的起止时间格式不对。');
    }
    var start = new Date(seg.start);
    var end = new Date(seg.end);
    if (end.getTime() <= start.getTime()) {
      throw modelError('执行时段的结束时间要晚于开始时间。');
    }
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      // settled = 这一段"时间到了"之后，用户已经回答过「做完了吗」
      settled: !!seg.settled
    };
  }

  function addTask(input) {
    return storage.addTask(createTask(input));
  }

  function updateTask(id, patch) {
    var clean = Object.assign({}, patch);

    if ('title' in clean) {
      clean.title = String(clean.title).trim();
      if (!clean.title) throw modelError('任务名不能是空的。');
    }
    if ('dueAt' in clean && clean.dueAt && !isValidDateTime(clean.dueAt)) {
      throw modelError('截止时间的格式我读不出来，重新选一次。');
    }
    if ('remainingMinutes' in clean) {
      var r = Number(clean.remainingMinutes);
      if (!isFinite(r) || r < 0) throw modelError('剩余用时不能是负数。');
      clean.remainingMinutes = Math.round(r);
    }

    // 改了"预计用时"，要和"剩余用时"保持一致——否则会出现"预计 30 分钟、还剩 5 小时"这种自相矛盾。
    // 规矩（按是否已经开动来分）：
    //   · 还没排过任何时段（没开始做）→ 剩余跟着改成新的预计用时
    //   · 已经排过时段（可能做了一部分）→ 只把剩余压到不超过新的预计用时，不清空已做的进度
    if ('estimateMinutes' in clean && !('remainingMinutes' in clean)) {
      var est = Number(clean.estimateMinutes);
      if (!isFinite(est) || est <= 0) throw modelError('预计用时要是大于 0 的数字（分钟）。');
      clean.estimateMinutes = Math.round(est);
      var current = findTask(id);
      if (current) {
        var started = (current.scheduledSegments || []).length > 0;
        clean.remainingMinutes = started
          ? Math.min(Math.round(est), Math.round(Number(current.remainingMinutes) || 0))
          : Math.round(est);
      }
    }

    return storage.updateTask(id, clean);
  }

  function removeTask(id) {
    return storage.deleteTask(id);
  }

  function completeTask(id) {
    return storage.updateTask(id, {
      status: 'done',
      completedAt: new Date().toISOString(),
      remainingMinutes: 0
    });
  }

  function listTasks() {
    return storage.readTasks();
  }

  /* ---------- 把任务排进时间表 ---------- */

  /** 本地日历日（用于"同一天只保留一段"的判断） */
  function dayKey(iso) {
    var d = new Date(iso);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  /**
   * 把一条任务排进某个时段（写入 `scheduledSegments`）。
   *
   * 规则：**同一天只保留一段**。所以重复点「放进今天」是"替换今天那段"，不是叠加——
   * 否则连点几次就会排出好几段重叠的时段，自己给自己造冲突。
   * 未来其它日子已有的段落不动。
   *
   * 注意：这里**不扣减 `remainingMinutes`**。扣减发生在"一段做完"的时候（F8，下一步接）。
   */
  function scheduleTaskFor(id, startIso, endIso) {
    var task = findTask(id);
    if (!task) throw modelError('这条任务找不到了。');
    var seg = normalizeSegment({ start: startIso, end: endIso });
    var day = dayKey(seg.start);
    var kept = (task.scheduledSegments || []).filter(function (s) { return dayKey(s.start) !== day; });
    var next = kept.concat([seg]);
    next.sort(function (a, b) { return a.start < b.start ? -1 : (a.start > b.start ? 1 : 0); });
    return storage.updateTask(id, { scheduledSegments: next });
  }

  /** 取消全部已排时段（让任务回到"还没安排"） */
  function unscheduleTask(id) {
    return storage.updateTask(id, { scheduledSegments: [] });
  }

  /**
   * 结算一段：回答「做完了吗」。
   *
   * - `outcome === 'done'`     → 任务标记完成（PRD F8：直接打勾也算这个）
   * - `outcome === 'continue'` → 剩余用时减去这一段的时长，并给这一段打上 settled，
   *                              这样不会再反复问你同一段
   *
   * **不记录你实际花了多久**（PRD F8 明确不做计时），只按这一次点击扣减。
   */
  function settleSegment(id, startIso, outcome) {
    var task = findTask(id);
    if (!task) throw modelError('这条任务找不到了。');
    var segs = task.scheduledSegments || [];
    var hit = null;
    segs.forEach(function (s) { if (s.start === startIso) hit = s; });
    if (!hit) throw modelError('这一段的时段找不到了，可能已经被改过。');

    if (outcome === 'done') return completeTask(id);

    var segMinutes = Math.max(0, Math.round((new Date(hit.end) - new Date(hit.start)) / 60000));
    var next = segs.map(function (s) {
      if (s.start === startIso) return { start: s.start, end: s.end, settled: true };
      return { start: s.start, end: s.end, settled: !!s.settled };
    });

    return storage.updateTask(id, {
      scheduledSegments: next,
      remainingMinutes: Math.max(0, Math.round((Number(task.remainingMinutes) || 0) - segMinutes))
    });
  }

  /**
   * 把"截止时间已过、又没有后续安排"的任务标成待重新安排（PRD F9）。
   *
   * 三个条件缺一不可：
   *   ① 状态是待办（已完成、已在重排流程里的都不动）
   *   ② 有截止时间，且已经过了
   *   ③ **没有任何还没结束的时段** —— 若它已经被排到未来某个时间，说明已经安排好了，
   *      不该再要求重排一次（这条能避免"越问越烦"）
   *
   * 返回被改动的条数，便于测试与界面判断。
   */
  function reconcileOverdue(now) {
    var base = now ? new Date(now) : new Date();
    var changed = 0;
    storage.readTasks().forEach(function (t) {
      if (t.status !== 'todo') return;
      if (!t.dueAt) return;
      var due = new Date(t.dueAt);
      if (isNaN(due.getTime()) || due.getTime() >= base.getTime()) return;

      var hasFuture = (t.scheduledSegments || []).some(function (s) {
        var end = new Date(s.end);
        return !isNaN(end.getTime()) && end.getTime() > base.getTime();
      });
      if (hasFuture) return;

      storage.updateTask(t.id, { status: 'needsReschedule' });
      changed++;
    });
    return changed;
  }

  /**
   * 确认改期（PRD F9）：把任务排到新时段，并把"什么时候之前做完"改成这一段的结束时间。
   *
   * 为什么要动 dueAt：截止时间已经过去了，若只加一段时段而不管 dueAt，
   * 下一次一检查它又会被判成"已过截止"，又跳回待重新安排——变成死循环。
   * 改期本来就是"给它一个新的时间"，所以这里把截止时间一起改掉。
   */
  function confirmReschedule(id, startIso, endIso) {
    var task = findTask(id);
    if (!task) throw modelError('这条任务找不到了。');
    var seg = normalizeSegment({ start: startIso, end: endIso });
    var day = dayKey(seg.start);
    var kept = (task.scheduledSegments || []).filter(function (s) { return dayKey(s.start) !== day; });
    var next = kept.concat([seg]);
    next.sort(function (a, b) { return a.start < b.start ? -1 : (a.start > b.start ? 1 : 0); });

    return storage.updateTask(id, {
      scheduledSegments: next,
      dueAt: seg.end,
      status: 'todo',
      completedAt: null
    });
  }

  function findTask(id) {
    var list = storage.readTasks();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /* ---------- 固定占用（课表） ---------- */

  function createBlock(input) {
    var title = (input && input.title ? String(input.title) : '').trim();
    if (!title) throw modelError('给这节课起个名字，比如「高等数学」。');

    var weekday = Number(input.weekday);
    if (!(weekday >= 1 && weekday <= 7)) throw modelError('星期几要在周一到周日之间。');

    if (!isValidTime(input.startTime) || !isValidTime(input.endTime)) {
      throw modelError('起止时间格式不对，应该是 08:00 这样。');
    }
    var start = toMinutes(input.startTime);
    var end = toMinutes(input.endTime);
    if (end <= start) throw modelError('结束时间要晚于开始时间，改一下就能存。');

    return {
      id: makeId('b'),
      title: title,
      weekday: Math.round(weekday),
      startTime: input.startTime,
      endTime: input.endTime
    };
  }

  function addBlock(input) {
    return storage.addBlock(createBlock(input));
  }

  function updateBlock(id, patch) {
    var current = null;
    storage.readBlocks().forEach(function (b) { if (b.id === id) current = b; });
    if (!current) return null;

    var merged = Object.assign({}, current, patch);
    var rebuilt = createBlock(merged);
    return storage.updateBlock(id, {
      title: rebuilt.title,
      weekday: rebuilt.weekday,
      startTime: rebuilt.startTime,
      endTime: rebuilt.endTime
    });
  }

  function removeBlock(id) {
    return storage.deleteBlock(id);
  }

  function listBlocks() {
    return storage.readBlocks();
  }

  /* ---------- 导出 / 导入 ---------- */

  function exportBackup() {
    return storage.exportAll();
  }

  function importBackup(json) {
    return storage.importAll(json);
  }

  window.NoMissModel = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    ensureDefaults: ensureDefaults,
    getSettings: getSettings,
    updateSettings: updateSettings,
    createTask: createTask,
    addTask: addTask,
    updateTask: updateTask,
    removeTask: removeTask,
    completeTask: completeTask,
    listTasks: listTasks,
    findTask: findTask,
    scheduleTaskFor: scheduleTaskFor,
    unscheduleTask: unscheduleTask,
    settleSegment: settleSegment,
    reconcileOverdue: reconcileOverdue,
    confirmReschedule: confirmReschedule,
    createBlock: createBlock,
    addBlock: addBlock,
    updateBlock: updateBlock,
    removeBlock: removeBlock,
    listBlocks: listBlocks,
    exportBackup: exportBackup,
    importBackup: importBackup,
    toMinutes: toMinutes,
    isValidTime: isValidTime
  };
})();
