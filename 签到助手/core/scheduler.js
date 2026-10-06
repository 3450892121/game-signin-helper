'use strict';
/**
 * 调度模块：应用内每日定时签到（主调度）+ 开机/拉起补跑
 *
 * 规则：
 * - 生效时间 = 账号自定义时间 → 游戏统一时间 → 全局统一时间（storage.effectiveTimeFor 三级回退）
 * - 触发点按「账号」算：下一个最近的账号生效时间点；同一分钟的多账号（含跨游戏）归并为一个触发
 * - 到点只跑该时间点的账号（runner.runGame + onlyAccountIds），日志仍按游戏成块
 * - 补跑 catchUp：账号粒度 —— 生效时间今天已过、且今日结果无该 accountId 的启用账号补跑；
 * 今日结果存在但失败的账号不自动重试、明确提示。全局系统任务拉起时也走此兜底
 * - 运行结束后立即检查已过时未执行的触发并补执行（定时触发被运行中任务挤掉时不顺延到明天）
 * - 不变量：调度期间定时器始终武装——start/finally 均先 schedule 再做任何
 * catchUp；否则补跑运行窗口（可达数分钟）内到达的触发点会被静默吞到明天
 *
 * 用法：
 * const sched = scheduler.create({ storage, runner, log, logger });
 * sched.start; sched.stop; sched.nextRunInfo;
 */

function create({ storage, runner, log, logger }) {
  let timer = null;
  let running = false;
  // catchUp 调用串行化——设置保存点也会触发补跑检查，并发扫描会因
  // 「结果尚未写出」重复入队同一账号；串行后后一次扫描重新读盘，天然去重
  let catchUpTail = Promise.resolve();

  function parseHHmm(str) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
    if (!m) return null;
    const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return { h, min };
  }
  function pad2(x) { return String(x).padStart(2, '0'); }

  /** 全部「启用游戏 × 启用账号」及其生效时间 */
  function activeAccounts() {
    const s = storage.loadSettings();
    const accs = storage.loadAccounts().filter(a =>
      a.enabled !== false && s.games && s.games[a.game] && s.games[a.game].enabled !== false);
    const out = [];
    for (const a of accs) {
      const t = storage.effectiveTimeFor(a, s);
      const p = parseHHmm(t);
      if (p) out.push({ account: a, h: p.h, min: p.min, time: t });
    }
    return out;
  }

  /** 下一个触发点 { ts, time, groups:[{gameId, accountIds}] }；无启用账号返回 null */
  function nextRun() {
    const accs = activeAccounts();
    if (!accs.length) return null;
    const now = new Date();
    // 按 (时:分) 归并账号
    const buckets = new Map();
    for (const a of accs) {
      let b = buckets.get(a.time);
      if (!b) { b = { h: a.h, min: a.min, accounts: [] }; buckets.set(a.time, b); }
      b.accounts.push(a.account);
    }
    let best = null;
    for (const b of buckets.values()) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), b.h, b.min, 0, 0);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1); // 今天已过 → 明天
      if (!best || d.getTime() < best.ts) best = { ts: d.getTime(), time: pad2(b.h) + ':' + pad2(b.min), accounts: b.accounts };
    }
    const byGame = {};
    for (const acct of best.accounts) (byGame[acct.game] = byGame[acct.game] || []).push(acct.id);
    const groups = Object.keys(byGame).map(gameId => ({ gameId, accountIds: byGame[gameId] }));
    return { ts: best.ts, time: best.time, groups };
  }

  /**
 * 补跑（账号粒度）：某启用账号「生效时间今天已过」且「今日结果无该账号」时补跑，
 * 只补无结果账号；结果存在但失败的账号明确提示、不自动重试。
 */
  /** 对外入口串行化（内部实现 catchUpImpl） */
  function catchUp() {
    const run = catchUpTail.then(() => catchUpImpl());
    catchUpTail = run.then(() => {}, () => {});   // 单次失败不卡死队列
    return run;
  }

  async function catchUpImpl() {
    const now = new Date();
    const results = logger ? logger.loadTodayResults() : {};
    const s = storage.loadSettings();
    const accs = storage.loadAccounts().filter(a =>
      a.enabled !== false && s.games && s.games[a.game] && s.games[a.game].enabled !== false);
    const due = {};        // gameId -> [accountId]
    const failedHint = {}; // gameId -> [accountId]（今日有结果但失败）
    for (const a of accs) {
      const t = storage.effectiveTimeFor(a, s);
      const p = parseHHmm(t);
      if (!p) continue;
      const todayTs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), p.h, p.min, 0, 0).getTime();
      if (now.getTime() < todayTs) continue; // 还没到点
      const list = results[a.game] || [];
      const done = list.some(r => r && r.accountId === a.id);
      const failed = list.some(r => r && r.accountId === a.id && r.ok === false);
      if (!done) { (due[a.game] = due[a.game] || []).push(a.id); }
      else if (failed) { (failedHint[a.game] = failedHint[a.game] || []).push(a.id); }
    }
    for (const [gameId, ids] of Object.entries(due)) {
      log('🕐 补跑 ' + gameId + '（' + ids.length + ' 个账号生效时间已过且今日无结果）');
      try { await runner.runGame(gameId, { reason: 'catchup', onlyAccountIds: ids }); }
      catch (e) { log('补跑异常：' + e.message); }
    }
    for (const [gameId, ids] of Object.entries(failedHint)) {
      log('⚠️ ' + gameId + ' 以下账号今日结果存在但为失败（不自动重试，请查看结果页确认原因）：' + ids.join('、'));
    }
  }

  /** 运行完成后立即检查「已过时未执行的触发」并补执行 */
  async function runDue() {
    await catchUp();
  }

  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    const next = nextRun();
    if (!next) return;
    const delay = Math.max(1000, next.ts - Date.now());
    timer = setTimeout(async () => {
      timer = null;
      if (running) return; // 上一次还在跑：本次触发由运行结束后的 runDue 补执行
      running = true;
      try {
        const desc = next.groups.map(g => g.gameId + '×' + g.accountIds.length).join('、') || '无';
        log('⏰ 定时触发：' + next.time + '（' + desc + '）');
        for (const g of next.groups) {
          try { await runner.runGame(g.gameId, { reason: 'schedule', onlyAccountIds: g.accountIds }); }
          catch (e) { log('定时签到异常：' + e.message); }
        }
      } finally {
        running = false;
        // 先重排下一次（保持定时器常武装），再补执行——
        // 原顺序 runDue 的补跑运行期间到达的触发点会被吞到明天
        schedule();
        // 运行完成后：立即检查是否还有已过时未执行的触发（含运行期间错过的），补执行而非顺延
        try { await runDue(); } catch (e) { log('补执行检查异常：' + e.message); }
      }
    }, delay);
  }

  function start() {
    stop();
    // 先武装定时器再补跑——catchUp 可能运行数分钟，期间到达的触发点由定时器
    // 正常接管（running=false → 触发回调执行，经 runner 队列串行），不再被静默吞到明天
    schedule();
    catchUp().catch(e => log('补跑检查异常：' + e.message)).then(() => schedule());
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  /** UI 显示下次触发 */
  function nextRunInfo() {
    const n = nextRun();
    if (!n) return null;
    return { ts: n.ts, time: n.time, groups: n.groups, text: new Date(n.ts).toLocaleString('zh-CN') };
  }

  /** 仅重排下一次触发（设置变更后调用；不触发补跑） */
  function reschedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    schedule();
  }

  return { start, stop, reschedule, nextRun, nextRunInfo, catchUp };
}

module.exports = { create };
