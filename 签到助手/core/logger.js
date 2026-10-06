'use strict';
/**
 * 日志模块：写文件 + 内存环形缓冲（供界面实时读取）
 *
 * 文件：<dataDir>/logs/signin.log（追加；超过 MAX_SIGNIN_LOG_SIZE 自动轮转为 signin-<日期>.log）
 * 缓冲：最近 MAX_BUFFER 条（每条 { time, msg }）
 * 保留策略（只保留最近一年）：
 * - retain(days)：删除超过 days 天的每日结果 logs/YYYY-MM-DD.json 与轮转日志 signin-<日期>.log
 * - signin.log 超 2MB 自动轮转后同样按日龄受 retain 清理
 */

const fs = require('fs');
const path = require('path');

const MAX_BUFFER = 500;
const RETENTION_DAYS = 365;                            // 默认保留天数（最近一年）
const MAX_SIGNIN_LOG_SIZE = 2 * 1024 * 1024;           // signin.log 超此大小自动轮转

function create(dataDir) {
  const logDir = path.join(dataDir, 'logs');
  let buffer = [];

  function nowStr() { return new Date().toLocaleString('zh-CN'); }

  function dateStamp(d) {
    d = d || new Date();
    const pad = x => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function ensureDir() {
    try {
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    } catch (e) { /* 尽力 */ }
  }

  /** 轮转：signin.log 超过大小限制时改名为 signin-<日期>.log（同名冲突加 -<n>） */
  function rotateSigninLog() {
    try {
      const file = path.join(logDir, 'signin.log');
      if (!fs.existsSync(file)) return false;
      if (fs.statSync(file).size <= MAX_SIGNIN_LOG_SIZE) return false;
      let target = path.join(logDir, 'signin-' + dateStamp() + '.log');
      let n = 1;
      while (fs.existsSync(target)) target = path.join(logDir, 'signin-' + dateStamp() + '-' + (n++) + '.log');
      fs.renameSync(file, target);
      return true;
    } catch (e) { return false; }
  }

  function log(msg) {
    const line = `[${nowStr()}] ${msg}`;
    try { console.log(line); } catch (e) {}
    buffer.push({ time: new Date().toISOString(), msg: String(msg) });
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
    ensureDir();
    try {
      rotateSigninLog();   // 追加前检查大小：应用长期常驻也不会无限增长
      fs.appendFileSync(path.join(logDir, 'signin.log'), line + '\n', 'utf8');
    } catch (e) {}
    return line;
  }

  /** 最近 N 条（UI 用） */
  function recent(n) {
    return buffer.slice(-(n || 100));
  }

  /** 当日结果文件：logs/YYYY-MM-DD.json，记录每个账号当日签到结果 */
  function todayFile() {
    return path.join(logDir, dateStamp() + '.json');
  }

  function loadTodayResults() {
    try { return JSON.parse(fs.readFileSync(todayFile(), 'utf8')); } catch (e) { return {}; }
  }

  function saveTodayResults(results) {
    ensureDir();
    try { fs.writeFileSync(todayFile(), JSON.stringify(results, null, 2), 'utf8'); } catch (e) {}
  }

  /** 今日某游戏是否已产生结果（补跑判断用） */
  function hasTodayResult(gameId) {
    const r = loadTodayResults();
    return !!(r[gameId] && r[gameId].length);
  }

  /**
 * 保留策略（只保留最近一年）：
 * - 删除超过保留期的每日结果 logs/YYYY-MM-DD.json
 * - 删除超过保留期的轮转日志 signin-<日期>.log（含 <日期>-<n> 多段形式）
 * - 顺带清理写入残留的 .tmp 文件（早于保留期）
 * - 轮转当前过大的 signin.log
 * @param {number} [days] 保留天数（缺省 RETENTION_DAYS=365）≈ 保留最近一年
 * @returns {{scannedResults:number,deletedResults:number,scannedLogs:number,deletedLogs:number,rotated:boolean}}
 */
  function retain(days) {
    days = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : RETENTION_DAYS;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const stat = { scannedResults: 0, deletedResults: 0, scannedLogs: 0, deletedLogs: 0, rotated: false };
    try {
      ensureDir();
      for (const f of fs.readdirSync(logDir)) {
        const p = path.join(logDir, f);
        let st;
        try { st = fs.statSync(p); } catch (e) { continue; }
        if (!st.isFile()) continue;
        // 每日结果 JSON：logs/YYYY-MM-DD.json
        const dm = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
        if (dm) {
          stat.scannedResults++;
          const t = new Date(dm[1] + 'T00:00:00').getTime();
          if (!Number.isNaN(t) && t < cutoff) {
            try { fs.unlinkSync(p); stat.deletedResults++; } catch (e) {}
          }
          continue;
        }
        // 轮转日志：logs/signin-<日期>.log / signin-<日期>-<n>.log
        const lm = /^signin-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.log$/.exec(f);
        if (lm) {
          stat.scannedLogs++;
          const t = new Date(lm[1] + 'T00:00:00').getTime();
          if (!Number.isNaN(t) && t < cutoff) {
            try { fs.unlinkSync(p); stat.deletedLogs++; } catch (e) {}
          }
          continue;
        }
        // 写入残留：.tmp 且早于保留期
        if (/\.tmp$/.test(f) && st.mtimeMs < cutoff) {
          try { fs.unlinkSync(p); } catch (e) {}
        }
      }
      stat.rotated = rotateSigninLog();
    } catch (e) { /* 尽力而为，不阻断运行 */ }
    return stat;
  }

  /**
 * 某月每日结果聚合：
 * 读 logs/YYYY-MM-DD.json（该月每一天），返回 { [gameId]: { 'YYYY-MM-DD': [账号结果...] } }。
 * 无结果文件的日期不出现；主进程用 summarizeDay 归并成日历状态。
 * @param {number} year 如 2026
 * @param {number} month 1-12
 */
  function monthResults(year, month) {
    const out = {};
    const pad2 = (x) => String(x).padStart(2, '0');
    const days = new Date(year, month, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const ds = year + '-' + pad2(month) + '-' + pad2(d);
      let r = {};
      try { r = JSON.parse(fs.readFileSync(path.join(logDir, ds + '.json'), 'utf8')); } catch (e) { r = {}; }
      if (!r || typeof r !== 'object') r = {};
      for (const [gameId, list] of Object.entries(r)) {
        if (!Array.isArray(list) || !list.length) continue;
        out[gameId] = out[gameId] || {};
        out[gameId][ds] = list;
      }
    }
    return out;
  }

  return { log, recent, loadTodayResults, saveTodayResults, hasTodayResult, retain, logDir, todayFile, monthResults };
}

module.exports = { create, MAX_BUFFER, RETENTION_DAYS, MAX_SIGNIN_LOG_SIZE, summarizeDay };

/**
 * 某游戏一天签到结果的日历状态：
 * 全部 ok=true → { status:'ok' }；存在失败/部分未完成/空 → { status:'fail' }。
 * rewards 字段：ok 记录的 reward 文案保序去重（失败记录/缺失不计），供日历格子悬停展示。
 * @param {Array} list 该游戏当天账号结果数组（runner 归一化后的 {accountId, ok, ...}）
 */
function summarizeDay(list) {
  // 按「当天是否成功签到过」判定（用户核心诉求）——
  // 某账号当天只要成功签到过（存在任意 ok=true 记录），后续重试失败不覆盖成功；
  // 统计口径：账号数（total=账号数），每账号当天有任一成功记录即 ok，否则 fail。
  // 游戏状态：所有账号都 ok → 'ok'；有账号当天全失败/无记录 → 'fail'；无任何记录 → 'fail'（无记录=失败）。
  if (!Array.isArray(list)) return { status: 'fail', total: 0, ok: 0, fail: 0, rewards: [] };
  const byAcc = {};
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const key = r.accountId || '__unknown__';
    (byAcc[key] = byAcc[key] || []).push(r);
  }
  const keys = Object.keys(byAcc);
  if (!keys.length) return { status: 'fail', total: 0, ok: 0, fail: 0, rewards: [] };
  let ok = 0;
  const rewards = [];
  for (const k of keys) {
    if (!byAcc[k].some(r => r && r.ok === true)) continue;
    ok++;
    for (const r of byAcc[k]) {
      if (r && r.ok === true && typeof r.reward === 'string' && r.reward && !rewards.includes(r.reward)) rewards.push(r.reward);
    }
  }
  const total = keys.length;
  const fail = total - ok;
  return { status: total > 0 && fail === 0 ? 'ok' : 'fail', total, ok, fail, rewards };
}