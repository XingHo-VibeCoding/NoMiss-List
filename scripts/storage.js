/**
 * storage.js —— 存储层（唯一碰"数据存在哪"的文件）
 *
 * 阶段一：浏览器本地存储（当前）
 * 阶段二：换成云数据库——只改本文件内部，函数名和参数都不变
 *        （见 TECH_DESIGN.md 第四节「分层原则」与第十节「迁移注意事项」）
 *
 * 四条纪律：
 *   1. 出错不静默：读不出、写不进，都要明确报出来，不假装成功
 *   2. 出错不清空：数据解析失败时保留原始内容，绝不自作主张重置
 *   3. 文案不指责：错误提示只说"发生了什么 + 你能做什么"
 *   4. 报错要贴题：要保存时出问题，就说"没存上"，不能说"读不出"——
 *      所以所有写操作开头都先探一次"到底能不能存"（guardWritable）
 */

(function () {
  'use strict';

  var KEYS = {
    tasks: 'nomiss.tasks',
    blocks: 'nomiss.blocks',
    settings: 'nomiss.settings'
  };

  /* ---------- 错误对象 ---------- */

  function storageError(code, message, detail) {
    var err = new Error(message);
    err.name = 'StorageError';
    err.code = code;
    err.detail = detail || null;
    return err;
  }

  var MSG_READ = '这次没能读出数据——可能是浏览器不允许本页存储（比如无痕模式）。';
  var MSG_WRITE = '这次没能存上——可能是浏览器不允许存储，或空间已满。可以先用「导出备份」保住数据。';

  /* ---------- 可用性探测 ---------- */

  function isAvailable() {
    try {
      var probe = '__nomiss_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 所有写操作的守门人：
   * 存不了的时候，直接给出"没存上"的提示，而不是让用户先撞上一条"读不出"。
   */
  function guardWritable() {
    if (!isAvailable()) {
      throw storageError('WRITE_FAILED', MSG_WRITE, '存储不可用');
    }
  }

  /* ---------- 底层读写 ---------- */

  function readRaw(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      throw storageError('READ_FAILED', MSG_READ, e && e.message);
    }
  }

  function readJSON(key, fallback) {
    var raw = readRaw(key);
    if (raw === null || raw === '') return fallback;
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw storageError('CORRUPT',
        '旧数据读取出错，我没有动它。可以先用「导出备份」把原始内容存下来。', raw);
    }
  }

  function writeJSON(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return value;
    } catch (e) {
      throw storageError('WRITE_FAILED', MSG_WRITE, e && e.message);
    }
  }

  /* ---------- 任务 ---------- */

  function readTasks() {
    var list = readJSON(KEYS.tasks, []);
    return Array.isArray(list) ? list : [];
  }

  function writeTasks(list) {
    guardWritable();
    return writeJSON(KEYS.tasks, Array.isArray(list) ? list : []);
  }

  function addTask(task) {
    guardWritable();
    var list = readTasks();
    list.push(task);
    writeTasks(list);
    return task;
  }

  function updateTask(id, patch) {
    guardWritable();
    var list = readTasks();
    var found = null;
    list = list.map(function (t) {
      if (t.id !== id) return t;
      found = Object.assign({}, t, patch);
      return found;
    });
    if (!found) return null;
    writeTasks(list);
    return found;
  }

  function deleteTask(id) {
    guardWritable();
    var list = readTasks();
    var next = list.filter(function (t) { return t.id !== id; });
    if (next.length === list.length) return false;
    writeTasks(next);
    return true;
  }

  /* ---------- 固定占用（课表） ---------- */

  function readBlocks() {
    var list = readJSON(KEYS.blocks, []);
    return Array.isArray(list) ? list : [];
  }

  function writeBlocks(list) {
    guardWritable();
    return writeJSON(KEYS.blocks, Array.isArray(list) ? list : []);
  }

  function addBlock(block) {
    guardWritable();
    var list = readBlocks();
    list.push(block);
    writeBlocks(list);
    return block;
  }

  function updateBlock(id, patch) {
    guardWritable();
    var list = readBlocks();
    var found = null;
    list = list.map(function (b) {
      if (b.id !== id) return b;
      found = Object.assign({}, b, patch);
      return found;
    });
    if (!found) return null;
    writeBlocks(list);
    return found;
  }

  function deleteBlock(id) {
    guardWritable();
    var list = readBlocks();
    var next = list.filter(function (b) { return b.id !== id; });
    if (next.length === list.length) return false;
    writeBlocks(next);
    return true;
  }

  /* ---------- 设置 ---------- */

  function readSettings() {
    var s = readJSON(KEYS.settings, null);
    return (s && typeof s === 'object' && !Array.isArray(s)) ? s : null;
  }

  function writeSettings(patch) {
    guardWritable();
    var current = readSettings() || {};
    var next = Object.assign({}, current, patch || {});
    writeJSON(KEYS.settings, next);
    return next;
  }

  /* ---------- 导出 / 导入（备份与迁移用） ---------- */

  function exportAll() {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      version: 1,
      tasks: readTasks(),
      blocks: readBlocks(),
      settings: readSettings()
    }, null, 2);
  }

  function importAll(json) {
    guardWritable();
    var data;
    try {
      data = JSON.parse(json);
    } catch (e) {
      throw storageError('IMPORT_PARSE', '这个文件读不出来，可能不是备份文件。');
    }
    if (!data || typeof data !== 'object') {
      throw storageError('IMPORT_SHAPE', '这个文件的内容不是备份格式。');
    }
    if (data.tasks) writeTasks(data.tasks);
    if (data.blocks) writeBlocks(data.blocks);
    if (data.settings) writeSettings(data.settings);
    return true;
  }

  window.NoMissStorage = {
    KEYS: KEYS,
    isAvailable: isAvailable,
    readTasks: readTasks,
    writeTasks: writeTasks,
    addTask: addTask,
    updateTask: updateTask,
    deleteTask: deleteTask,
    readBlocks: readBlocks,
    writeBlocks: writeBlocks,
    addBlock: addBlock,
    updateBlock: updateBlock,
    deleteBlock: deleteBlock,
    readSettings: readSettings,
    writeSettings: writeSettings,
    exportAll: exportAll,
    importAll: importAll
  };
})();
