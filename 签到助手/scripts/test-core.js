'use strict';
/**
 * 核心层验证（阶段 1）
 *
 * 用法：node scripts/test-core.js
 *
 * 安全策略（同 smoke.js）：
 * - 使用临时数据目录（%TEMP%/signin-app-core-test），测试后删除
 * - kuro/mihoyo 用现有 config 凭据跑真实 signin（今天已签过=无副作用）
 * - tajiduo 只验证模块可加载与存储加密往返，不执行 signin（避免轮换 refreshToken 影响明早 schtasks）
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const storage = require('../core/storage.js');
const logger = require('../core/logger.js');
const notifyMod = require('../core/notify.js');
const runnerMod = require('../core/runner.js');
const schedulerMod = require('../core/scheduler.js');

const TEST_DIR = path.join(os.tmpdir(), 'signin-app-core-test');
// 真实凭据实校改为可选项：v2 起凭据存于应用加密存储（DPAPI），Node 侧无法解密。
// 需要凭据实校时用环境变量指向同构 JSON（旧 config.json 与 credentials 字段同构）：
// SMOKE_KURO_CONFIG / SMOKE_MIHOYO_CONFIG / SMOKE_TAJIDUO_CONFIG
const CONFIG_MAP = { kuro: process.env.SMOKE_KURO_CONFIG || '', mihoyo: process.env.SMOKE_MIHOYO_CONFIG || '', tajiduo: process.env.SMOKE_TAJIDUO_CONFIG || '' };

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '✅' : '❌') + ' ' + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}
// 跳过（SKIP）：旧三套脚本已归档（备份 zip），config 缺失时跳过真实签到而非失败
function skip(name, detail) {
  console.log('⏭ ' + name + (detail ? '  ' + detail : ''));
}

function loadLegacyConfig(game) {
  const file = CONFIG_MAP[game];
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

(async () => {
  // 清理旧测试目录
  fs.rmSync(TEST_DIR, { recursive: true, force: true });

  // ---------- storage：注入假加密验证加密往返 ----------
  console.log('=== storage ===');
  const secret = 'test-secret';
  const enc = (plain) => Buffer.from(secret + '|' + plain).toString('base64');
  const dec = (cipher) => {
    const s = Buffer.from(cipher, 'base64').toString('utf8');
    if (!s.startsWith(secret + '|')) throw new Error('bad cipher');
    return s.slice(secret.length + 1);
  };
  // 注入已安装游戏供应器（框架不内置游戏；测试用官方三游戏模拟已安装）
const store = storage.create(TEST_DIR, {
  encrypt: enc, decrypt: dec,
  installedGames: () => [
    { id: 'kuro', defaultEnabled: true, time: '05:50' },
    { id: 'mihoyo', defaultEnabled: true, time: '05:55' },
    { id: 'tajiduo', defaultEnabled: true, time: '06:05' },
  ],
});

  // 默认设置
  const s0 = store.loadSettings();
  check('默认设置加载', s0.defaultTime === '06:00' && s0.games.kuro.enabled === true, 'defaultTime=' + s0.defaultTime);

  // 账号加密往返
  const sample = { id: 'abc123', game: 'kuro', nickname: '测试号', enabled: true, credentials: { token: 'SECRET_TOKEN_XYZ', mobile: '13800000000' } };
  store.upsertAccount(sample);
  const raw = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'accounts.json'), 'utf8'));
  check('凭据已加密落盘', raw[0].credentials.__enc === true && raw[0].credentials.v !== JSON.stringify(sample.credentials));
  const loaded = store.loadAccounts()[0];
  check('凭据解密还原', loaded.credentials.token === 'SECRET_TOKEN_XYZ' && loaded.credentials.mobile === '13800000000');

  // 增删改查
  store.upsertAccount({ id: 'x2', game: 'mihoyo', nickname: '二号', enabled: true, credentials: { cookie: 'c' } });
  check('多账号查询', store.getAccountsByGame('mihoyo').length === 1);
  store.removeAccount('x2');
  check('删除账号', store.getAccountsByGame('mihoyo').length === 0);
  store.removeAccount('abc123');

  // 设置保存
  const s1 = store.loadSettings();
  s1.defaultTime = '07:30';
  store.saveSettings(s1);
  check('设置保存', store.loadSettings().defaultTime === '07:30');

  // effectiveTimeFor 三级回退
  const eff = storage.effectiveTimeFor;
  const sEff = { defaultTime: '08:00', games: { g1: { time: '07:00' }, g2: {} } };
  check('effectiveTimeFor 三级回退',
    eff({ game: 'g1', time: '06:30' }, sEff) === '06:30' &&
    eff({ game: 'g1' }, sEff) === '07:00' &&
    eff({ game: 'g2' }, sEff) === '08:00' &&
    eff({ game: 'gX' }, sEff) === '08:00' &&
    eff({}, {}) === '',
    '账号>游戏>全局；空→空');
  check('effectiveTimeFor 非法值回退', eff({ game: 'g1', time: '25:99' }, sEff) === '07:00', '非法账号时间回退游戏时间');

  // ---------- 设备指纹按游戏持久化----------
  // 有些社区对「同账号反复换设备标识」有风控；首次登录没有已有账号可借指纹，
  // 必须复用按游戏持久化的那一份，否则每次都换新指纹。
  {
    const fpDir = path.join(os.tmpdir(), 'signin-app-core-test-fp');
    try { fs.rmSync(fpDir, { recursive: true, force: true }); } catch (e) { /* 首次不存在 */ }
    const fpStore = storage.create(fpDir, { encrypt: enc, decrypt: dec, installedGames: () => [] });
    const FP = { deviceid: 'D-1', openudid: 'O-1', vendorid: 'V-1' };
    check('指纹：新数据目录读出 null', fpStore.getFingerprint('gFp') === null);
    check('指纹：保存后原样读回', fpStore.saveFingerprint('gFp', FP) === true
      && JSON.stringify(fpStore.getFingerprint('gFp')) === JSON.stringify(FP));
    fpStore.saveFingerprint('gFp2', Object.assign({ extra: 'x', junk: 1 }, FP));
    check('指纹：只保留三个字段（多余字段丢弃）',
      Object.keys(fpStore.getFingerprint('gFp2')).sort().join(',') === 'deviceid,openudid,vendorid');
    check('指纹：字段不全时拒绝保存', fpStore.saveFingerprint('gFp3', { deviceid: 'D' }) === false
      && fpStore.getFingerprint('gFp3') === null);
    check('指纹：无 gameId 时拒绝保存', fpStore.saveFingerprint('', FP) === false);
    // 跨实例（模拟应用重启后重新 create 指向同目录）
    const fpStore2 = storage.create(fpDir, { encrypt: enc, decrypt: dec, installedGames: () => [] });
    check('指纹：重启后仍在（落盘 fingerprints.json）',
      JSON.stringify(fpStore2.getFingerprint('gFp')) === JSON.stringify(FP)
      && fs.existsSync(path.join(fpDir, 'fingerprints.json')));
    fpStore2.removeGameData('gFp');
    check('指纹：removeGameData 一并清除该游戏的、不动其它游戏',
      fpStore2.getFingerprint('gFp') === null && fpStore2.getFingerprint('gFp2') !== null);
    try { fs.rmSync(fpDir, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响判定 */ }
  }

  // 插件 defaultTime 晚于全局时钳制为全局
  // 场景：插件默认 23:00、全局 09:00、用户未给该游戏设时间 → 解析为 09:00（钳制）
  const sClamp = storage.create(TEST_DIR, { encrypt: enc, decrypt: dec, installedGames: () => [
    { id: 'gLate', defaultEnabled: true, time: '23:00' },
  ] });
  const sc0 = sClamp.loadSettings();
  check('插件 defaultTime 首次解析钳制为全局', sc0.games.gLate.time === sc0.defaultTime, '23:00 → ' + sc0.defaultTime + '（钳制为全局）');
  sClamp.saveSettings({ defaultTime: '09:00' });
  check('插件 defaultTime 晚于全局被钳制', sClamp.loadSettings().games.gLate.time === '09:00', '23:00 → 09:00（未保存游戏时间时按全局钳制）');

  // removeGameData：批量删除目标游戏全部账号，保留其它游戏账号
  store.upsertAccount({ id: 'gd1', game: 'kuro', nickname: '批量1', enabled: true, credentials: { token: 't1' } });
  store.upsertAccount({ id: 'gd2', game: 'kuro', nickname: '批量2', enabled: true, credentials: { token: 't2' } });
  store.upsertAccount({ id: 'gd3', game: 'tajiduo', nickname: '保留', enabled: true, credentials: { token: 't3' } });
  const rm = store.removeGameData('kuro');
  check('removeGameData 批量删除目标游戏账号', rm.removedAccounts === 2 && store.getAccountsByGame('kuro').length === 0, JSON.stringify(rm));
  check('removeGameData 保留其它游戏账号', store.getAccountsByGame('tajiduo').length === 1);
  check('removeGameData 报告清理了 settings', rm.settingsRemoved === true);
  store.removeAccount('gd3');   // 清理残留，避免影响后续 scheduler 补跑用例

  // ---------- logger ----------
  console.log('\n=== logger ===');
  const log = logger.create(TEST_DIR);
  log.log('测试日志 A');
  log.log('测试日志 B');
  const recent = log.recent(10);
  check('日志缓冲', recent.length === 2 && recent[1].msg === '测试日志 B');
  check('日志落盘', fs.existsSync(path.join(TEST_DIR, 'logs', 'signin.log')));
  // summarizeDay 二态判定
  check('summarizeDay 当天成功过即ok',
    // 全成功 → ok
    logger.summarizeDay([{ accountId: 'a', ok: true }, { accountId: 'a', ok: true }]).status === 'ok' &&
    // 当天成功过 + 后续重试失败 → 仍 ok（用户核心诉求：不因重试失败打叉）
    logger.summarizeDay([
      { accountId: 'a', ok: true,  at: '2026-09-05T09:00:00.000Z' },
      { accountId: 'a', ok: false, at: '2026-09-05T10:00:00.000Z' },
      { accountId: 'a', ok: false, at: '2026-09-05T11:00:00.000Z' },
    ]).status === 'ok' &&
    // 失败后补签成功 → ok
    logger.summarizeDay([
      { accountId: 'a', ok: false, at: '2026-09-05T09:00:00.000Z' },
      { accountId: 'a', ok: true,  at: '2026-09-05T10:00:00.000Z' },
    ]).status === 'ok' &&
    // 全天只有失败（从未成功）→ fail
    logger.summarizeDay([
      { accountId: 'a', ok: false, at: '2026-09-05T09:00:00.000Z' },
      { accountId: 'a', ok: false, at: '2026-09-05T10:00:00.000Z' },
    ]).status === 'fail' &&
    // 两个账号：一个有成功、一个全天失败 → fail（还有账号没成功）
    logger.summarizeDay([
      { accountId: 'a', ok: true,  at: '2026-09-05T09:00:00.000Z' },
      { accountId: 'b', ok: false, at: '2026-09-05T09:30:00.000Z' },
    ]).status === 'fail' &&
    // 无记录 / 空 → fail（无记录=失败）
    logger.summarizeDay([]).status === 'fail' &&
    logger.summarizeDay(null).status === 'fail',
    '当天成功过（后续重试失败也绿）→ok；全天仅失败→fail；任一账号未成功→fail；空/无→fail');
  // summarizeDay rewards 奖励汇总
  const _rw = logger.summarizeDay([
    { accountId: 'a', ok: true,  reward: '星琼 ×60' },
    { accountId: 'b', ok: true,  reward: '星琼 ×60' },
    { accountId: 'c', ok: true,  reward: '旅行指南 ×3' },
    { accountId: 'd', ok: false, reward: '失败不应计入' },
    { accountId: 'e', ok: true },
  ]);
  check('summarizeDay rewards 汇总',
    Array.isArray(_rw.rewards) && _rw.rewards.length === 2 &&
    _rw.rewards[0] === '星琼 ×60' && _rw.rewards[1] === '旅行指南 ×3' &&
    logger.summarizeDay([{ accountId: 'a', ok: true }]).rewards.length === 0 &&
    logger.summarizeDay([]).rewards.length === 0 &&
    logger.summarizeDay(null).rewards.length === 0,
    'ok 记录 reward 保序去重；失败记录不计；无 reward 字段/空/无记录 → []');
  // monthResults 聚合（写当天结果文件 → 读回）
  const _today = new Date();
  const _y = _today.getFullYear(), _m = _today.getMonth() + 1;
  const _p2 = x => String(x).padStart(2, '0');
  log.saveTodayResults({ kuro: [{ accountId: 'a1', ok: true, title: '✅' }] });
  const mr = log.monthResults(_y, _m);
  const _todayKey = _y + '-' + _p2(_m) + '-' + _p2(_today.getDate());
  check('monthResults 聚合当天结果',
    !!(mr.kuro && mr.kuro[_todayKey] && mr.kuro[_todayKey].length === 1 && mr.kuro[_todayKey][0].ok === true),
    'games=' + Object.keys(mr).join('/') + ' today=' + _todayKey);

  // ---------- notify：无渠道 → 0 ----------
  console.log('\n=== notify ===');
  const sent = await notifyMod.notify({ serverchan: {}, pushplus: {}, wecom: {} }, 't', 'c', log.log);
  check('无渠道不发送', sent === 0);

  // ---------- runner：真实签到（kuro/mihoyo）----------
  console.log('\n=== runner（真实签到，kuro/mihoyo；tajiduo 仅结构检查）===');
  const kc = loadLegacyConfig('kuro');
  const mc = loadLegacyConfig('mihoyo');
  const tc = loadLegacyConfig('tajiduo');
  if (kc && mc && tc) {
    check('读取现有凭据', true);
  } else {
    skip('读取现有凭据（config 缺失，旧脚本已归档）', `kuro=${!!kc} mihoyo=${!!mc} tajiduo=${!!tc}`);
  }

  if (kc) {
    store.upsertAccount({ id: 't-kuro', game: 'kuro', nickname: '测试鸣潮', enabled: true, credentials: kc });
  }
  if (mc) {
    store.upsertAccount({ id: 't-mihoyo', game: 'mihoyo', nickname: mc.userName || '测试崩铁', enabled: true, credentials: mc });
  }

  // 框架不内置游戏：runner 经注册表从 脚本/ 目录解析插件（目录名可为中文）
  const testRegistry = require('../core/game-registry.js').create({ userDir: path.resolve(__dirname, '..', '..', '脚本') });
  testRegistry.loadAll();
  const getGamePlugin = (gameId) => testRegistry.get(gameId);
  const runner = runnerMod.create({
    storage: store,
    logger: log,
    notify: notifyMod.notify,
    log: log.log,
    getGamePlugin,
    onProgress: (p) => {
      if (p.type === 'account-done') console.log('    [进度] ' + p.gameId + ' → ' + p.summary);
    },
  });

  if (kc) {
    const r1 = await runner.runGame('kuro', { reason: 'test' });
    check('鸣潮 runGame 执行', r1.ok === 1 && r1.fail === 0, `成功 ${r1.ok} 失败 ${r1.fail}`);
    const today = log.loadTodayResults();
    check('今日结果已记录', !!(today.kuro && today.kuro.length === 1), 'title=' + (today.kuro && today.kuro[0].title));
    const accK = store.loadAccounts().find(a => a.id === 't-kuro');
    check('lastResult 已更新', !!accK.lastResult && accK.lastResult.ok === true, accK.lastResult && accK.lastResult.title);
  } else {
    skip('鸣潮真实签到（config 缺失）');
  }

  if (mc) {
    const r2 = await runner.runGame('mihoyo', { reason: 'test' });
    check('崩铁 runGame 执行', r2.ok === 1 && r2.fail === 0, `成功 ${r2.ok} 失败 ${r2.fail}`);
  } else {
    skip('崩铁真实签到（config 缺失）');
  }

  // ---------- 三插件登录方式结构检查（不执行登录） ----------
  // 顺序与各插件 loginMethods 的声明保持一致。
  const kGame = runner.loadGame('kuro');
  check('库街区登录方式（短信第一位）', kGame.loginMethods.map(m => m.id).join(',') === 'sms,paste,web', kGame.loginMethods.map(m => m.id).join(','));

  // tajiduo 结构检查（不执行）
  const tGame = runner.loadGame('tajiduo');
  check('塔吉多模块可加载', typeof tGame.signin === 'function');
  // 异环登录方式 = 短信验证码(推荐) + 粘贴 token + 浏览器登录(等效兜底)
  check('塔吉多登录方式（短信第一位）', tGame.loginMethods.map(m => m.id).join(',') === 'sms,paste,browser', tGame.loginMethods.map(m => m.id).join(','));
  // 不提供密码登录：框架内零可达入口（无 kind:'password' 声明，且 login-gui.html 的 tab 名 'pwd' 与框架下发的 'password' 不符）
  check('塔吉多无密码登录函数', typeof tGame.loginByPassword === 'undefined' && typeof tGame.step2PasswordLogin === 'undefined');

  // mihoyo 结构检查（登录方式：网页登录(推荐，自动抓 Cookie) + 粘贴 Cookie 兜底）
  // 不提供扫码登录：hk4e panda 端点已失效（MihoyoBBSTools issue#285，retcode:-5300），且全仓无界面入口
  // 不提供短信登录：actionType 链路要求（sendSmsCode 放返回值顶层，main.js 只读 r.sessionData）→ loginBySms 必然抛错
  const mGame = runner.loadGame('mihoyo');
  check('崩铁登录方式（网页登录第一位）', mGame.loginMethods.map(m => m.id).join(',') === 'web,cookie', mGame.loginMethods.map(m => m.id).join(','));
  check('崩铁无扫码与短信登录函数', typeof mGame.startQrLogin === 'undefined' && typeof mGame.queryQrLogin === 'undefined'
    && typeof mGame.completeQrLogin === 'undefined' && typeof mGame.sendSmsCode === 'undefined' && typeof mGame.loginBySms === 'undefined');
  check('崩铁网页登录 webMeta 完整', !!(mGame.loginMethods[0].webMeta
    && mGame.loginMethods[0].webMeta.loginUrl && mGame.loginMethods[0].webMeta.extractScript
    && typeof mGame.loginMethods[0].webMeta.validate === 'function'
    && typeof mGame.loginMethods[0].webMeta.buildCredentials === 'function'));

  // ---------- scheduler：触发点计算 ----------
  console.log('\n=== scheduler ===');
  const sched = schedulerMod.create({
    storage: store,
    runner: { runGame: async () => ({ ok: 0, fail: 0 }) },
    log: log.log,
    logger: log,
  });
  // 账号粒度触发：先建一个启用账号再算下次触发
  store.upsertAccount({ id: 'sched-a', game: 'kuro', nickname: '调度测试', enabled: true, credentials: { token: 'x' } });
  const ni = sched.nextRunInfo();
  check('下次触发计算（账号粒度）', !!ni && ni.ts > Date.now() && Array.isArray(ni.groups) &&
    ni.groups.some(g => g.gameId === 'kuro' && Array.isArray(g.accountIds) && g.accountIds.indexOf('sched-a') >= 0),
    ni ? ni.text + ' (' + ni.time + ')' : '无');

  // 多账号同分钟归并：两个游戏同 12:30 → 归并为一个触发点、两组
  // （先调高全局时间，避免 12:30 触发「全局最晚」钳制）
  const sMerge = store.loadSettings();
  sMerge.defaultTime = '23:59';
  sMerge.games.kuro.time = '12:30';
  sMerge.games.mihoyo.time = '12:30';
  store.saveSettings(sMerge);
  store.upsertAccount({ id: 'merge-b', game: 'mihoyo', nickname: '归并测试', enabled: true, credentials: { cookie: 'c' } });
  const nm = sched.nextRun();
  check('多账号同分钟归并为一个触发点', !!nm && nm.time === '12:30' && nm.groups.length === 2 &&
    nm.groups.every(g => g.accountIds.length === 1),
    nm ? JSON.stringify({ time: nm.time, groups: nm.groups }) : '无');
  store.removeAccount('merge-b');
  store.removeAccount('sched-a');   // 清理，避免影响后续补跑用例

  // 补跑按账号粒度：把时间设到过去后 catchUp 只补跑「今日无结果记录的启用账号」
  const s2 = store.loadSettings();
  s2.games.kuro.time = '00:01';
  s2.games.mihoyo.time = '00:02';
  s2.games.tajiduo.time = '00:03';
  store.saveSettings(s2);
  // kuro 已有结果账号 t-kuro + 新加一个「今日无结果」的账号 → 只补跑新账号
  store.upsertAccount({ id: 't-kuro-new', game: 'kuro', nickname: '新账号', enabled: true, credentials: { token: 'x' } });
  // 给 mihoyo 塞一条失败结果 → 不应重跑，但应有明确提示日志
  // （t-mihoyo 账号在旧 config 缺失时未创建，用假凭据补齐以便验证失败提示逻辑，不依赖真实凭据）
  if (!store.loadAccounts().some(a => a.id === 't-mihoyo')) {
    store.upsertAccount({ id: 't-mihoyo', game: 'mihoyo', nickname: '测试崩铁', enabled: true, credentials: { cookie: 'test' } });
  }
  const todayRes = log.loadTodayResults();
  todayRes.mihoyo = [{ accountId: 't-mihoyo', nickname: '测试崩铁', title: '❌ 失败', ok: false, at: new Date().toISOString() }];
  log.saveTodayResults(todayRes);
  let caught = [];
  const sched2 = schedulerMod.create({
    storage: store,
    runner: { runGame: async (g, opts) => { caught.push({ g, opts }); return { ok: 0, fail: 0 }; } },
    log: log.log,
    logger: log,
  });
  await sched2.catchUp();
  check('补跑按账号粒度（仅无结果账号）', caught.length === 1 && caught[0].g === 'kuro' &&
    Array.isArray(caught[0].opts.onlyAccountIds) && caught[0].opts.onlyAccountIds.length === 1 && caught[0].opts.onlyAccountIds[0] === 't-kuro-new',
    caught.length ? JSON.stringify(caught) : '无补跑');
  const recentLogs = log.recent(20).map(l => l.msg).join('\n');
  check('失败结果明确提示（不静默跳过）', recentLogs.indexOf('结果存在但为失败') >= 0 && recentLogs.indexOf('t-mihoyo') >= 0,
    '日志含失败提示（t-mihoyo）');


  // ---------- persistUpdate 不得复活排队期间被删除的账号 ----------
  console.log('\n=== runner 删除竞态 ===');
  {
    const reg2 = require('../core/game-registry.js').create({ userDir: path.resolve(__dirname, '..', '..', '脚本') });
    reg2.loadAll();
    const fakePlugin = {
      name: 'fake', community: 'x',
      signin: async (acc) => {
        // 模拟排队期间用户删除账号，签到完成时才返回凭据续期
        store.removeAccount(acc.id);
        return { result: { ok: true, level: 'success', status: 'success', title: '✅ ok', lines: [], reward: '' }, credentialsUpdate: { token: 'renewed' } };
      },
    };
    const runner2 = runnerMod.create({ storage: store, logger: log, notify: { notify: async () => 0 }, log: log.log, getGamePlugin: () => fakePlugin });
    store.upsertAccount({ id: 'race-del', game: 'kuro', nickname: '删除竞态', enabled: true, credentials: { token: 'old' } });
    await runner2.runAccount({ id: 'race-del', game: 'kuro', nickname: '删除竞态', enabled: true, credentials: { token: 'old' } });
    check('排队中删除的账号不被凭据写回复活', store.loadAccounts().every(a => a.id !== 'race-del'),
      'accounts=' + store.loadAccounts().map(a => a.id).join(','));
  }

  // ---------- proc-output GBK 兼容解码 ----------
  console.log('\n=== proc-output 解码 ===');
  const { decodeProcOutput } = require('../core/proc-output.js');
  const gbkBytes = Buffer.from([0xC7, 0xA9, 0xB5, 0xBD, 0xD6, 0xFA, 0xCA, 0xD6]); // GBK「签到助手」
  check('GBK 字节流解码为中文', decodeProcOutput(gbkBytes) === '签到助手', decodeProcOutput(gbkBytes));
  check('UTF-8 字节流保持原样', decodeProcOutput(Buffer.from('签到助手-全局', 'utf8')) === '签到助手-全局');
  check('空/非法输入返回空串', decodeProcOutput(Buffer.alloc(0)) === '' && decodeProcOutput(null) === '');

  // ---------- D3 storage 安装来源抛异常时回退上次快照 ----------
  console.log('\n=== storage 扫描异常兜底 ===');
  {
    let calls = 0;
    const d3Dir = path.join(os.tmpdir(), 'signin-app-core-test-d3');
    const store3 = storage.create(d3Dir, {
      encrypt: enc, decrypt: dec,
      installedGames: () => { calls++; if (calls === 1) return [{ id: 'gA', defaultEnabled: true }]; throw new Error('临时不可读'); },
    });
    const ok1 = store3.loadSettings();
    check('D3 首次正常扫描返回游戏', !!(ok1.games && ok1.games.gA));
    const ok2 = store3.loadSettings();
    check('D3 来源抛异常时回退上次快照（games 不被剪空）', !!(ok2.games && ok2.games.gA), 'games=' + Object.keys(ok2.games || {}).join('/'));
    fs.rmSync(d3Dir, { recursive: true, force: true });
  }

  // ---------- Z5 redact 出口脱敏 ----------
  console.log('\n=== core/redact 脱敏 ===');
  {
    const red = require('../core/redact.js');
    check('Z5 JSON token 值掩码', red.redact('{"code":0,"data":{"accessToken":"abc123def456","uid":123}}').indexOf('abc123def456') < 0);
    check('Z5 查询串 token 掩码', red.redact('https://x/api?uid=1&token=tok123456&x=2').indexOf('tok123456') < 0);
    check('Z5 JWT 掩码', red.redact('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c').indexOf('eyJhbGciOiJIUzI1NiJ9') < 0);
    check('Z5 正常失败文案不误伤', red.redact('❌ 签到失败：今日已签到（原石×60）') === '❌ 签到失败：今日已签到（原石×60）');
    check('Z5 普通文本原样', red.redact('响应超时') === '响应超时');
    check('Z5 maskId 保留首尾', red.maskId('123456789') === '12****89');
  }

  // ---------- D9 排队期间已删账号跳过且不写结果 ----------
  console.log('\n=== runner 已删账号跳过 ===');
  {
    const runner3 = runnerMod.create({ storage: store, logger: log, notify: { notify: async () => 0 }, log: log.log, getGamePlugin: () => ({ name: 'fake', community: 'x', signin: async () => ({ result: { ok: true, title: 'x', lines: [] }, credentialsUpdate: null }) }) });
    const before = JSON.stringify(log.loadTodayResults());
    const rsk = await runner3.runAccount({ id: 'never-exists', game: 'kuro', nickname: '幽灵账号', enabled: true, credentials: {} });
    const after = JSON.stringify(log.loadTodayResults());
    check('D9 已删账号跳过不执行签到', !!(rsk && rsk.skipped === true), 'result=' + JSON.stringify(rsk));
    check('D9 跳过不写当日结果', before === after);
  }

  // ---------- QQ 机器人（qqbot）纯函数 与 密钥通道 ----------
  console.log('\n=== QQ 机器人日报 ===');
  {
    const qqbot = require('../core/qqbot.js');
    check('qqbot 纯函数导出齐全', ['create', 'composeDailyText', 'reportSendTime', 'explainCode'].every((k) => typeof qqbot[k] === 'function'));

    const t1 = qqbot.composeDailyText({
      kuro: [
        { accountId: 'a', nickname: '甲', ok: true, title: '✅ 签到成功', reward: '数据金×60' },
        { accountId: 'b', nickname: '乙', ok: false, title: '❌ 登录已过期', reward: '' },
      ],
    }, { dateLabel: '10月4日', untilLabel: '06:30', games: [
      { id: 'kuro', name: '鸣潮', community: '库街区', accounts: [{ id: 'a', nickname: '甲' }, { id: 'b', nickname: '乙' }, { id: 'c', nickname: '丙' }] },
    ] });
    check('qqbot 日报：成功/失败/未跑三态',
      t1.indexOf('✅ 甲：签到成功（奖励：数据金×60）') >= 0 && t1.indexOf('❌ 乙：登录已过期') >= 0 && t1.indexOf('⬜ 丙：今日无签到记录') >= 0,
      t1.replace(/\n/g, ' | '));
    check('qqbot 日报：标题与合计行', t1.indexOf('【签到日报】10月4日（截至 06:30）') >= 0 && t1.indexOf('合计：成功 1 · 失败 1 · 未跑 1') >= 0);

    const t2 = qqbot.composeDailyText({ g: [
      { accountId: 'a', ok: false, title: '❌ 先失败' },
      { accountId: 'a', ok: true, title: '✅ 后成功', reward: 'x' },
    ] }, { dateLabel: 'd', games: [{ id: 'g', name: 'G', accounts: [{ id: 'a', nickname: 'A' }] }] });
    check('qqbot 日报：当天成功过即 ✅（重试失败不覆盖，口径同 summarizeDay）',
      t2.indexOf('✅ A：签到成功（奖励：x）') >= 0 && t2.indexOf('合计：成功 1 · 失败 0 · 未跑 0') >= 0);

    const t3 = qqbot.composeDailyText({}, { dateLabel: 'd', games: [] });
    check('qqbot 日报：全无记录提示', t3.indexOf('今日没有签到记录') >= 0, t3.replace(/\n/g, ' | '));

    const many = [];
    for (let i = 0; i < 400; i++) many.push({ accountId: 'x' + i, ok: true, title: 'ok', reward: '' });
    const t4 = qqbot.composeDailyText({ g: many }, { dateLabel: 'd', games: [{ id: 'g', name: 'G', accounts: many.map((r) => ({ id: r.accountId, nickname: '账号' + r.accountId })) }] });
    check('qqbot 日报：超长截断', t4.length <= qqbot.MAX_TEXT_LEN && t4.indexOf('已截断') >= 0, 'len=' + t4.length);

    const t5 = qqbot.composeDailyText({ g: [{ accountId: 'a', ok: false, title: '❌ ' }] }, { dateLabel: 'd', games: [{ id: 'g', name: 'G', accounts: [{ id: 'a', nickname: 'A' }] }] });
    check('qqbot 日报：空标题清理为「签到失败」', t5.indexOf('❌ A：签到失败') >= 0);

    const rp1 = qqbot.reportSendTime('06:00', new Date(2026, 9, 4, 5, 0, 0));
    check('qqbot 发送时刻 = 全局+30 分钟', rp1 && rp1.hh === 6 && rp1.mm === 30 && rp1.ts === new Date(2026, 9, 4, 6, 30, 0).getTime(), JSON.stringify(rp1));
    const rp2 = qqbot.reportSendTime('23:50', new Date(2026, 9, 4, 8, 0, 0));
    check('qqbot 发送时刻：跨天钳制到 23:59', rp2 && rp2.hh === 23 && rp2.mm === 59);
    check('qqbot 发送时刻：非法时间返回 null', qqbot.reportSendTime('25:00', new Date()) === null && qqbot.reportSendTime('', new Date()) === null);

    check('qqbot 错误码人话映射',
      qqbot.explainCode(40054004, 'x').indexOf('添加为好友') >= 0 &&
      qqbot.explainCode(100016, 'x').indexOf('AppSecret') >= 0 &&
      qqbot.explainCode(40034100, 'x').indexOf('频控') >= 0 &&
      qqbot.explainCode(999999, 'msg').indexOf('999999') >= 0 &&
      qqbot.explainCode(0, '') === '');

    check('qqbot 密钥字段注册（掩码通道）', storage.NOTIFY_SECRET_FIELDS.qqbot === 'appSecret');

    // 专属绑定码（防误绑）：生成格式 + 校验规则（含空格/大小写/夹带）
    check('qqbot 绑定码：生成 6 位免混淆格式',
      /^[A-HJ-NP-Z2-9]{6}$/.test(qqbot.generateBindCode()) && /^[A-HJ-NP-Z2-9]{6}$/.test(qqbot.generateBindCode()) &&
      qqbot.generateBindCode() !== qqbot.generateBindCode());
    check('qqbot 绑定码：校验（原样/小写/夹带/带空格 通过；无关消息拒绝）',
      qqbot.bindCodeMatches('K7M2Q9', 'K7M2Q9') &&
      qqbot.bindCodeMatches('k7m2q9', 'K7M2Q9') &&
      qqbot.bindCodeMatches('绑定 K7M2Q9', 'K7M2Q9') &&
      qqbot.bindCodeMatches('K7 M2 Q9', 'K7M2Q9') &&
      !qqbot.bindCodeMatches('你好', 'K7M2Q9') &&
      !qqbot.bindCodeMatches('', 'K7M2Q9') &&
      !qqbot.bindCodeMatches('K7M2Q9', '') &&
      !qqbot.bindCodeMatches(null, 'K7M2Q9'));

    const sQ = store.loadSettings();
    check('qqbot 默认设置存在', !!(sQ.notify && sQ.notify.qqbot && sQ.notify.qqbot.appId === '' && 'appSecret' in sQ.notify.qqbot));
    sQ.notify.qqbot.appId = '1024';
    sQ.notify.qqbot.appSecret = 'SECRET_QQBOT_XYZ';
    sQ.notify.qqbot.openid = 'OPENID_ABC';
    store.saveSettings(sQ);
    const rawQ = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'settings.json'), 'utf8'));
    check('qqbot appSecret 加密落盘（无明文泄漏）', rawQ.notify.qqbot.appSecret.__enc === true && JSON.stringify(rawQ).indexOf('SECRET_QQBOT_XYZ') < 0);
    const sQ2 = store.loadSettings();
    check('qqbot appSecret 解密还原 + openid 保留', sQ2.notify.qqbot.appSecret === 'SECRET_QQBOT_XYZ' && sQ2.notify.qqbot.openid === 'OPENID_ABC');
  }

  // ---------- 清理 ----------
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('\n' + (failures === 0 ? '🎉 核心层全部通过' : `❌ ${failures} 项失败`));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常：' + e); process.exit(1); });
