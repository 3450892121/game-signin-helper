'use strict';
/**
 * 执行器：调度/手动触发的签到执行
 *
 * - runGame(gameId)：该游戏全部"启用"账号顺序签到（同游戏多账号）
 * - runAccount(accountId)：单账号签到（界面「立即签到」）
 * - 每个账号完成后：合并 credentialsUpdate 写回（凭据续期持久化）、写当日结果、更新账号 lastResult
 * - 游戏内任一账号失败 → 向已配置渠道推送告警（Server酱/PushPlus/企微）
 * - onProgress 回调推送给界面：{ type:'account-done', gameId, accountId, result, summary }
 */


const { redact } = require('./redact.js');   // 出口统一脱敏

function create({ storage, logger, notify, onProgress, log, getGamePlugin }) {

  // ---- 全局执行串行化：手动/定时/补跑统一排队，防止并发签到与凭据写回竞争 ----
  let queueTail = Promise.resolve();
  function enqueue(fn) {
    const run = queueTail.then(fn);
    queueTail = run.then(() => {}, () => {}); // 单次失败不卡死队列
    return run;
  }
  function serialized(fn) {
    return function (...args) {
      return enqueue(() => fn.apply(this, args));
    };
  }

  function loadGame(gameId) {
    // 插件一律经注册表解析（内置与用户插件同一来源）
    if (typeof getGamePlugin === 'function') {
      const p = getGamePlugin(gameId);
      if (p) return p;
    }
    throw new Error('游戏插件未安装：' + gameId);
  }

  function todayStr() {
    const d = new Date();
    const pad = x => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /**
 * 合并凭据增量并持久化（R3 修复：合并到磁盘最新凭据之上）。
 * 串行队列下账号可能在排队期间已被其他任务更新（如凭据续期/重绑定），
 * 若合并到传入快照的旧凭据上会造成「丢失更新」——因此以磁盘最新版本为基底。
 */
  function persistUpdate(account, credentialsUpdate) {
    if (!credentialsUpdate) return;
    // 账号在排队期间可能已被用户删除——磁盘上查不到就不再写回。
    // 原实现回退到传入快照再 upsert，会把已删除的账号「复活」回 accounts.json。
    const latest = storage.loadAccounts().find(a => a.id === account.id);
    if (!latest) return;
    const merged = Object.assign({}, latest.credentials || {}, credentialsUpdate);
    storage.upsertAccount(Object.assign({}, latest, { credentials: merged }));
  }

  /** 记录结果：当日 JSON + 账号 lastResult */
  function recordResult(account, result, at) {
    const results = logger.loadTodayResults();
    if (!results[account.game]) results[account.game] = [];
    results[account.game].push({
      accountId: account.id,
      nickname: result.accountName || account.nickname || '',
      title: result.title || '',
      ok: !!result.ok,
      reward: result.reward || '',
      at: at || new Date().toISOString(),
    });
    logger.saveTodayResults(results);

    const fresh = storage.loadAccounts().find(a => a.id === account.id);
    if (fresh) {
      storage.upsertAccount(Object.assign({}, fresh, {
        lastResult: {
          date: todayStr(),
          title: result.title || '',
          ok: !!result.ok,
          reward: result.reward || '',
          at: at || new Date().toISOString(),
        },
      }));
    }
  }

  /** 执行单个账号签到（内部实现，不入队；公开 runAccount 走队列） */
  async function runAccountImpl(account) {
    // 串行队列下账号可能在排队期间被用户删除——磁盘已查不到则跳过本次签到，
    // 不再回退传入快照执行（会拿已删账号的凭据发请求，并把失败写进当日结果/触发误告警）
    const base = storage.loadAccounts().find(a => a.id === account.id);
    if (!base) {
      log('⏭️ 账号 ' + (account.nickname || account.id) + ' 已被删除，跳过本次签到');
      if (onProgress) onProgress({ type: 'account-done', gameId: account.game, accountId: account.id, result: { ok: false, skipped: true, title: '账号已删除，跳过' }, summary: '账号已删除，跳过' });
      return { ok: false, skipped: true, title: '账号已删除，跳过' };
    }
    const game = loadGame(base.game);
    const start = new Date().toISOString();
    let out;
    try {
      out = await game.signin(base);
    } catch (e) {
      out = {
        result: {
          ok: false, level: 'error', status: 'failed',
          title: '❌ 脚本异常：' + e.message,
          lines: ['脚本异常：' + e.message], reward: '',
          accountName: base.nickname || '', roleName: '', userId: '',
        },
        credentialsUpdate: null,
      };
    }
    const result = out.result || {};
    // 出口统一脱敏——lines/title 可能携带原始响应体片段（含 token/cookie 等凭据），
    // 掩码后再写当日结果/signin.log/UI，避免凭据长期留存（日志保留一年）；不影响插件原始数据
    result.title = redact(result.title);
    if (Array.isArray(result.lines)) result.lines = result.lines.map((l) => redact(l));
    if (out.credentialsUpdate) persistUpdate(base, out.credentialsUpdate);
    recordResult(base, result, start);
    (result.lines || []).forEach(l => log(`[${game.name}] ${l}`));
    // 日志补强：每个账号运行结束输出明确「成功/失败」摘要行
    // （手动签到/测试/定时在日志页与 signin.log 均可见），避免只靠 result.lines 时结果不直观
    {
      let t = String(result.title || (result.ok ? '签到成功' : '签到失败'));
      if (/^[✅❌]\s*/.test(t)) t = t.replace(/^[✅❌]\s*/, '');
      log(`[${game.name}] ${result.ok ? '✅' : '❌'} ${t}` + (result.reward ? '（' + result.reward + '）' : ''));
    }
    if (onProgress) {
      onProgress({ type: 'account-done', gameId: base.game, accountId: base.id, result, summary: result.title || '' });
    }
    return result;
  }

  /**
 * 签到某游戏全部启用账号（内部实现，不入队）
 * @param {string} gameId
 * @param {object} [opts] { reason: 'schedule'|'catchup'|'manual', onlyAccountIds?: string[] }
 * @returns {Promise<{gameId:string, ok:number, fail:number, results:Array}>}
 */
  async function runGameImpl(gameId, opts) {
    opts = opts || {};
    const game = loadGame(gameId);
    let accounts = storage.loadAccounts().filter(a => a.game === gameId && a.enabled !== false);
    if (Array.isArray(opts.onlyAccountIds)) {
      // 按账号粒度补跑：只执行指定账号
      const set = new Set(opts.onlyAccountIds);
      accounts = accounts.filter(a => set.has(a.id));
    }
    log(`========== ${game.name}(${game.community}) 签到开始（${accounts.length} 个启用账号，原因：${opts.reason || 'manual'}）==========`);

    const results = [];
    let ok = 0, fail = 0;
    for (const account of accounts) {
      log(`▶ 开始签到：${account.nickname || account.id}`);
      const result = await runAccountImpl(account);
      results.push(result);
      // 排队期间被删除的账号按 skipped 处理，不计成败（不触发失败告警）
      if (result.skipped) continue;
      if (result.ok) ok++; else fail++;
    }
    if (!accounts.length) log(`⚠️ ${game.name} 没有启用账号，跳过`);

    log(`========== ${game.name} 签到结束（成功 ${ok} / 失败 ${fail}）==========`);

    // 失败告警：任一账号失败
    if (fail > 0) {
      const lines = results.map((r, i) => {
        const a = accounts[i];
        return `• ${a ? a.nickname || a.id : '?'}：${r.title || '失败'}${r.reward ? '（' + r.reward + '）' : ''}`;
      });
      const content = '时间：' + new Date().toLocaleString('zh-CN') + '\n' + lines.join('\n');
      if (notify) await notify(storage.loadSettings().notify, `⚠️ ${game.name}签到部分失败`, content, log);
    }
    if (onProgress) onProgress({ type: 'game-done', gameId, ok, fail });
    return { gameId, ok, fail, results };
  }

  /** 全部启用游戏依次签到（手动「立即签到全部」；内部实现，不入队） */
  async function runAllImpl() {
    const s = storage.loadSettings();
    const out = [];
    for (const gameId of Object.keys(s.games || {})) {
      const g = s.games[gameId];
      if (g && g.enabled !== false) out.push(await runGameImpl(gameId, { reason: 'manual-all' }));
    }
    return out;
  }

  // 公开入口：全部经全局串行队列（手动/定时/补跑统一排队）
  return {
    runGame: serialized(runGameImpl),
    runAccount: (account) => enqueue(() => runAccountImpl(account)),
    runAll: serialized(runAllImpl),
    loadGame,
  };
}

module.exports = { create };
