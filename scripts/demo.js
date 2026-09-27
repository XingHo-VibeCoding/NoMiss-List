/**
 * demo.js —— 演示模式（只在网址带 ?demo=… 时生效）
 *
 * 为什么要有它：四种页面状态里，"空"和"错误"用真实数据很难凑出来——
 * 你不可能为了让页面报错，先把浏览器的存储弄坏。所以做一个只在演示时出现的开关。
 *
 * 四条纪律：
 *   1. **平时完全不生效**：网址里没有 ?demo=… 时，这个文件立刻返回，什么都不挂。
 *   2. **绝不碰真实数据**：演示模式下所有"读"都返回假数据，"写"一律被拦下并明确告知。
 *   3. **不做假象**：这里只有一套假数据，不模仿延迟、不假装加载——加载态是真的状态，
 *      只是真实使用时本地读取几乎瞬间完成（接云之后才会有可感的等待）。
 *   4. **用完就走**：去掉网址里的 ?demo=… 刷新，回到你自己的真实数据。
 *
 * 用法：
 *   http://localhost:8000/                → 你的真实数据
 *   http://localhost:8000/?demo=mock      → 用假数据渲染主视图
 *   http://localhost:8000/?demo=loading   → 看"加载中"长什么样（停留一下再继续）
 *   http://localhost:8000/?demo=empty     → 看"空"状态
 *   http://localhost:8000/?demo=error     → 看"出错"状态（会真的走一遍出错处理）
 */

(function () {
  'use strict';

  var search = (typeof location !== 'undefined' && location.search) ? location.search : '';
  var mode = '';
  try {
    mode = new URLSearchParams(search).get('demo') || '';
  } catch (e) {
    mode = '';
  }
  if (!mode) return; // 平时就是这里返回，什么都不影响

  var model = window.NoMissModel;
  if (!model) return;

  var MODES = { mock: 1, loading: 1, empty: 1, error: 1, '1': 1, success: 1 };
  if (!MODES[mode]) mode = 'mock';

  /* ---------- 假数据（按"现在"生成，所以任何时候打开都像活的） ---------- */

  function wd() {
    var w = new Date().getDay(); // 0 = 周日
    return w === 0 ? 7 : w;
  }

  function rel(minutes) {
    return new Date(Date.now() + minutes * 60000).toISOString();
  }

  function todayAt(h, m) {
    var d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m || 0).toISOString();
  }

  function mockSettings() {
    return { dayStart: '08:00', dayEnd: '22:00', defaultEstimate: 30 };
  }

  function mockBlocks() {
    return [
      { id: 'b_demo1', title: '高等数学', weekday: wd(), startTime: '08:00', endTime: '09:40' },
      { id: 'b_demo2', title: '大学英语', weekday: wd(), startTime: '10:00', endTime: '11:40' },
      { id: 'b_demo3', title: '数据结构', weekday: wd(), startTime: '14:00', endTime: '15:40' }
    ];
  }

  function mockTasks() {
    return [
      // 最急的一件：已经在建议里出现过的那种
      { id: 't_demo1', title: '交实验报告', dueAt: rel(20 * 60), estimateMinutes: 60, remainingMinutes: 60,
        scheduledSegments: [], status: 'todo', createdAt: rel(-24 * 60), completedAt: null },

      // 今天做不完的一件：用来演示"分段推进"
      { id: 't_demo2', title: '写课程论文', dueAt: rel(50 * 60), estimateMinutes: 900, remainingMinutes: 900,
        scheduledSegments: [], status: 'todo', createdAt: rel(-48 * 60), completedAt: null },

      // 故意排在"数据结构"那节课里 → 演示冲突提示
      { id: 't_demo3', title: '小组讨论', dueAt: rel(30 * 60), estimateMinutes: 60, remainingMinutes: 60,
        scheduledSegments: [{ start: todayAt(14, 30), end: todayAt(15, 0), settled: false }],
        status: 'todo', createdAt: rel(-30 * 60), completedAt: null },

      // 截止时间已过 → 演示"待重新安排"（假数据直接给好状态，不需要系统去改它）
      { id: 't_demo4', title: '补交作业', dueAt: rel(-24 * 60), estimateMinutes: 45, remainingMinutes: 45,
        scheduledSegments: [], status: 'needsReschedule', createdAt: rel(-72 * 60), completedAt: null },

      // 有一段刚结束、还没回答"做完了吗" → 演示段落结算
      // 时段刻意固定在清早（早于第一节课、也早于每天可用时间的起点），
      // 这样它**不会和任何课撞上**——否则假数据会凭空多出一个不是我故意安排的冲突。
      { id: 't_demo5', title: '整理实验数据', dueAt: rel(200 * 60), estimateMinutes: 120, remainingMinutes: 80,
        scheduledSegments: [{ start: todayAt(6, 30), end: todayAt(7, 10), settled: false }],
        status: 'todo', createdAt: rel(-100 * 60), completedAt: null },

      // 今天已经做完的一件 → 演示"今天完成的"
      { id: 't_demo6', title: '读完那篇文章', dueAt: rel(10 * 60), estimateMinutes: 30, remainingMinutes: 0,
        scheduledSegments: [], status: 'done', createdAt: rel(-6 * 60), completedAt: rel(-30) }
    ];
  }

  /* ---------- 假数据源：读 → 返回假数据；写 → 拦下 ---------- */

  var EMPTY = { tasks: [], blocks: [], settings: mockSettings() };

  function pick() {
    if (mode === 'empty') return EMPTY;
    return { tasks: mockTasks(), blocks: mockBlocks(), settings: mockSettings() };
  }

  function readOrThrow(fn) {
    // ?demo=error 时故意抛错，让页面真的走一遍出错处理（不是画一个假的错误画面）
    if (mode === 'error') {
      var err = new Error('演示：这一步没能读出数据。去掉网址里的 ?demo=error 就能回到真实数据。');
      err.name = 'DemoError';
      err.code = 'READ_FAILED';
      throw err;
    }
    return fn();
  }

  var DEMO_WRITE_MSG = '演示模式不会改动你的数据——这一下没有生效。去掉网址里的 ?demo=… 再试。';

  function blocked() {
    var err = new Error(DEMO_WRITE_MSG);
    err.name = 'DemoError';
    err.code = 'DEMO_READONLY';
    throw err;
  }

  /* 读接口：全部换成假数据 */
  model.readTasks = model.listTasks = function () {
    return readOrThrow(function () { return pick().tasks; });
  };
  model.readBlocks = model.listBlocks = function () {
    return readOrThrow(function () { return pick().blocks; });
  };
  model.readSettings = model.getSettings = model.ensureDefaults = function () {
    return readOrThrow(function () { return pick().settings; });
  };
  model.findTask = function (id) {
    var list = pick().tasks;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };
  // 假数据里的状态是给好的（该待重排的已经是待重排），不需要系统再去改它
  model.reconcileOverdue = function () { return 0; };

  /* 写接口：一律拦下，并说清楚为什么 */
  [
    'addTask', 'updateTask', 'removeTask', 'completeTask',
    'scheduleTaskFor', 'unscheduleTask', 'settleSegment', 'confirmReschedule',
    'addBlock', 'updateBlock', 'removeBlock', 'updateSettings',
    'importBackup', 'exportBackup'
  ].forEach(function (name) {
    if (typeof model[name] === 'function') model[name] = blocked;
  });

  /* ---------- 对外只暴露"当前是什么模式" ---------- */

  window.NoMissDemo = {
    mode: mode,
    isActive: true,
    /** 停在加载态多久（毫秒）；只在 ?demo=loading 时有意义 */
    loadingHoldMs: 1200,
    banner: mode === 'error'
      ? '演示模式 · 正在故意演示「出错」的样子 · 这个模式不会读写你的真实数据'
      : (mode === 'empty'
        ? '演示模式 · 空状态（没有任何任务与课表）· 不会读写你的真实数据'
        : (mode === 'loading'
          ? '演示模式 · 加载态会停留一下让你看清 · 不会读写你的真实数据'
          : '演示模式 · 用假数据渲染（含一处故意安排的冲突）· 不会读写你的真实数据'))
  };
})();
