'use strict';
/**
 * 游戏社区签到助手 —— Electron 主进程
 *
 * 职责：
 * - 窗口/单实例/托盘/开机自启/关闭最小化到托盘
 * - 核心服务组装：storage(safeStorage 加密) + logger + notify + runner + scheduler
 * - IPC 白名单通道（渲染进程零 Node 权限，见 preload.js）
 * - 登录流程编排：全部由插件 loginMethods 驱动，框架按 kind 分发——
 * sms 短信验证码 / web 网页登录窗口（官方页 + 登录态提取，失败按 webMeta.degradation 降级提示）/
 * gui 浏览器登录（本地 127.0.0.1 页面，见 core/browser-login.js）/ paste 粘贴 token 或 Cookie。
 * - 系统计划任务同步（schtasks，任务名固定前缀「签到助手-」，绝不触碰其他任务）
 * - 自测模式：--selftest（临时数据目录 + 自动化断言） / --task-test（schtasks 真实往返）
 */

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, safeStorage, session, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const storageMod = require('./core/storage.js');
const loggerMod = require('./core/logger.js');
const notifyMod = require('./core/notify.js');
const runnerMod = require('./core/runner.js');
const schedulerMod = require('./core/scheduler.js');
const qqbotMod = require('./core/qqbot.js');   // QQ 机器人每日签到日报（零依赖，纯 Node）
const browserLogin = require('./core/browser-login.js'); // 本地浏览器登录界面服务器（通用 gui 登录 infra）
const { decodeProcOutput } = require('./core/proc-output.js'); // reg/schtasks 输出 GBK 兼容解码

// ---------------------------------------------------------------------------
// 无 GUI 冒烟模式：ELECTRON_RUN_AS_NODE=1 时以纯 Node 方式加载全部模块，
// 供无显示环境（CI/沙箱）验证主进程依赖图完整性（真正的窗口启动由 verifier 实测）
// ---------------------------------------------------------------------------
if (process.env.ELECTRON_RUN_AS_NODE === '1') {
  const smokeFiles = [
    './core/storage.js', './core/logger.js', './core/notify.js',
    './core/runner.js', './core/scheduler.js', './core/game-registry.js',
    './core/browser-login.js', './core/qqbot.js',
  ];
  let fail = 0;
  for (const f of smokeFiles) {
    try { require(path.join(__dirname, f)); console.log('[SMOKE] ✅ ' + f); }
    catch (e) { fail++; console.log('[SMOKE] ❌ ' + f + ' — ' + e.message); }
  }
  console.log('[SMOKE] RESULT=' + (fail ? 'fail (' + fail + ')' : 'pass'));
  process.exit(fail ? 1 : 0);
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const APP_NAME = '游戏社区签到助手';
const TASK_PREFIX = '签到助手-';           // 本应用系统任务前缀（安全边界）
const gameRegistryMod = require('./core/game-registry.js');  // 游戏注册表（扫描「脚本」目录，放进去即自动读取，框架不内置脚本）
const MASK = '********';                    // 通知密钥掩码占位
const IPC_CHANNELS = [                      // IPC 白名单（--selftest 校验用）
  'settings:load', 'settings:save',
  'games:list', 'games:openUserDir', 'games:reload', 'games:add', 'games:remove',
  'accounts:list', 'accounts:remove', 'accounts:setEnabled', 'accounts:setTime',
  'login:sendSms', 'login:sms',
  'login:webOpen', 'login:webCancel',
  'login:guiOpen', 'login:guiClose',   // t17：浏览器登录界面（本地服务+默认浏览器）
  'login:paste',
  'run:account', 'run:game', 'run:all',
  'logs:recent',
  'results:today', 'results:history', 'calendar:month',
  'notify:test',
  'qqbot:bind:start', 'qqbot:status', 'qqbot:bind:cancel',   // QQ 机器人绑定（临时 WebSocket）
  'system:autostart:get', 'system:autostart:set',
  'system:task:status', 'system:task:sync',
  'scheduler:info',
  'app:info', 'app:quit',
];
const EVENT_CHANNELS = ['event:log', 'event:progress', 'event:webLogin', 'event:guiLogin', 'event:accounts', 'event:games', 'event:visibility'];

// 托盘图标（32x32 PNG，代码内嵌，避免额外资源文件）
const ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAZ3SURBVFhHvZdrbBTXFcen/dBvlRI1VVWUkgLpO+qHRiFNJZpKlAaMmhpn7X3Nzs7s7szuzD69fqzBxkuL1BeERKZNaIWlVBFRU0riECxFaaQkFGObxBBBbaBWk7Zpw8PpIwT8wr6/6u7YBnt3UaUkHOloNLPSnp/uved//ldRKkTMnr47mhaxSEps0VOiqDmiqMlnShTVzLUM5Nz0ycy72dBcnlpKbAk0C3P9jjP3fPVPxU8srbcQekysiSfFq1YKnEaw85BogkQzxFvAagGzFWIFiLVBdDNENoOxBfR20DsgvBW0rRDqdJ/hdtjQPczdL3fx5cM5Vg0ab6163ehe8QfvFxcVN2IzWiIpRDIL0QREZNpgOG7qSQinIJwGLQ2hDKhZUHMQzEGgEfx58DeBby79jbD6qb18buhB7jjmYcWAyp1DEe4YiXDrQP1/lh3x31cqblniPseGhAMxC2LxDw6hpmHt7j9y+/Hvs6JPZWWfxqq+MJ8+XM+3Xsvy8L97+NrR2FuKovAxKyIGMykwTTDnAD4IRClzgq8fKvLZwdpS0eVHgnzmcAN39Zv8feIikzNT3HU6iZI0xTdScUjEIG6C9SFABLPQUJhg2Us6xpmf8uK/hrjzqM6KvhCj4//kyswk9w81seyUhuIYws47kIhC/EOCkE9f0zTLX4yz/mQLMoYu/Znjl0aZnJ3mu8cL3PpKHV8YMVFsQ3TmbbAj/x+EkQDdBt2BsMwkaCkIpd19L0Fk3d/u/e0ePjm4lpoT7SUIGTVvtHPLK5tY2a/ypZNpFDvMtiYbnEh1CDMOEQt8IfCGIGBAIAp+mTHwmeC1oMECNQWqXA0HPB3nWHXE4Jb+DXzveBsPnNjMba96WHlU5fYTG1nz7CEURxPF5gQ4RhUICyIR0HR4bA/09cPwaRg5A8NL8tRp2Nl9GW/mcmkVghb8YPtZvvJSjtuO1fCpYxtYPlTL5wd83Luvu6QTSkoCxCGpV4Ywo2Do0N+/sIo3jJ1Pnmf73nc4OQJ+uTUJCOSneGDXAGu693P/rw7x4Pa/EpDb1DEH0GJBKlwZQvXB/t8tLtLx2HleGx5f/BE49+5V3j4/zaxw358+CLUx94CWzosDWtLtEilUWqcEUEWxxXQBlkLEDbAMOPeO+4f/uDDNo/vGWK2OEvvR26X3+Zi+Klhnv8na+JtcveoSnB9zz0NAHs4KYiVluwTQGoO0Vg5haZBPw5UrbpE3zk7wHfMv3BMc5ZvaKCfOTiwAzM7Cw0+O8fMnLjIztwRXxsFpA79TLlYSQs4OJaOKYkEChMohrBA0pa4BzIe37W/0vPze4o8VYgHALhcrCSEHmJIJiGJbFDJqOYStgR2+tgXzIZhlVsxt9A3iwpgrVqrUigqKKaeokpMAEciqlSF0Dxw8AFNT0PscPLIDXuh1l/z6mJmB53thxyPw7PMwOQk9veDRqytmpATgE8XNBmSDlSHsEDQ78NRvwLMR6mpg4zr49eOLAfZ2w7oNsHET1GyCJ/ZBugVC8eqyLf1ECWCLDrlAZQhbhUYTLl6A1wdgTxfs+DF07YLhYRgZgdMj0NUFP/kZ7P4l9A/C2Ltg50Czqs8OaWqUvE8U23Vo9FeGsP3Q6sD4krafnoJ0AnwekF5CbtH1MTEJmSYIxaoPMLMgARpEsSMMeX9lCAlQcMo7YWIcmqXABCCfLQeU79lm0GLVp6i0dy6A7HdfZYhkAHI6XPrv4gKX34esnJIhSFrw3pKufP8y2CnQzeqj3JIAzQ2iuFWDJm91iFgdPLNvcYGe/WB4XcEK++D3Ty/+/cAzEAzd2E9Io1sC6JQn3VsdIhOEeD08vhN6D8CeXWD5wQm7ALYBkSDsfhQO9sAvuiAchphZ7ieuh5BuW2l5iG1FFVoaqkPk5iDMOjBqIeqBpGxT3VXM5BxE2A9qA2gBsGLuKK9kauYhpOVXCh7RuW0O4EYQS7tjqWwvnaJLTU0lCHnvUAoPieQPg9Baf/MhHAnQ6ple3eGFQv3Nh4inQSkWix8v1ImhohQcz02CsMDJgGGJU6WbUaFOfLvTC+0NHz2EvPwkpAlOS6Mr1i7cDVtqsSSEXImPajvk5SedhFQKoqZILRSfj9ZNYl17vTi21QfyYMrukC0qdUKKlVRMKdtydsgBJqeoHOXST0hT02qCtHfSY0qjK922tPzy3iEvPxl58OJiyIqK9fM1/wfzVU8GDtN1rwAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// 运行参数
// ---------------------------------------------------------------------------
function parseArgs() {
  const argv = process.argv.slice(1);
  const args = { dataDir: null, scriptsDir: null, hidden: false, selftest: false, taskTest: false };
  for (const a of argv) {
    if (a.startsWith('--data-dir=')) args.dataDir = a.slice('--data-dir='.length);
    else if (a.startsWith('--scripts-dir=')) args.scriptsDir = a.slice('--scripts-dir='.length);
    else if (a === '--hidden') args.hidden = true;
    else if (a === '--selftest') args.selftest = true;
    else if (a === '--task-test') args.taskTest = true;
  }
  return args;
}
const ARGS = parseArgs();

// ---------------------------------------------------------------------------
// 全局兜底：主进程未捕获异常 / 未处理的 Promise 拒绝（原代码无兜底，异常被静默吞掉）。
// 只记不退（原代码未定义崩溃退出策略）；日志目标在触发时惰性创建、创建失败退回控制台，
// 全程 try/catch，绝不因兜底自身抛错而掩盖原始错误，也不在模块加载期产生任何副作用。
// ---------------------------------------------------------------------------
function logFatal(kind, err) {
  const detail = (err && err.stack) || (err && err.message) || String(err);
  const line = '💥 主进程' + kind + '：' + detail;
  try {
    const dataDir = ARGS.dataDir || storageMod.defaultDataDir();
    loggerMod.create(dataDir).log(line);
  } catch (e) { /* 日志器不可用时退回控制台 */ }
  try { console.error('[main] ' + line); } catch (e) { /* ignore */ }
}
process.on('uncaughtException', (err) => { logFatal('未捕获异常（uncaughtException）', err); });
process.on('unhandledRejection', (reason) => { logFatal('未处理的 Promise 拒绝（unhandledRejection）', reason); });

// ---------------------------------------------------------------------------
// 运行期状态
// ---------------------------------------------------------------------------
const state = {
  quitting: false,
  mainWindow: null,
  tray: null,
  services: null,          // { storage, logger, runner, scheduler, notify }
  loginSessions: new Map(),// login 会话（验证码 actionType / 二维码 ticket / 塔吉多指纹）
  webWindows: new Map(),   // game -> BrowserWindow（网页登录窗口）
  webLoginBound: {},       // game -> bool（网页登录是否已完成绑定，用于关闭时降级判定）
  guiServers: new Map(),   // game -> 浏览器登录界面服务器（t17；键 game）
  dailyMaintainTimer: null,   // 每日日志保留维护定时器（每日清理超过保留期的记录）
  qqReportTimer: null,     // QQ 机器人日报检查定时器（每分钟；含启动补发）
  qqReportState: null,     // QQ 日报发送状态磁盘缓存（lastDate/lastAttempt/noRec* 等）
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function log(...msgs) { console.log('[main]', ...msgs); }

function maskMobile(m) {
  const s = String(m || '');
  return /^\d{11}$/.test(s) ? s.slice(0, 3) + '****' + s.slice(7) : (s || '(未填写)');
}

function validHHmm(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

/** 调度重排：账号级变更（启用/改期/新绑定）后也须重排，改动即时生效；
 * 原实现全工程仅 settings:save 一处调用，导致改账号时间要等下个自然触发点才生效。失败不阻断调用方。 */
function rescheduleSafe() {
  try { if (state.services && state.services.scheduler) state.services.scheduler.reschedule(); }
  catch (e) { log('⚠️ 调度重排失败：' + (e.message || e)); }
}

/** 调度相关保存点后顺带补跑检查（幂等：只补「生效时间已过且今日无结果」的启用账号）。
 * 不 await——补跑可能耗时数分钟，不能拖住 IPC 响应；执行过程经日志/进度事件可见。
 * 场景：把时间改到今天已过时刻、重新启用游戏/账号后，当天立即补签而非等到明天。
 * 调度器内部已把 catchUp 调用串行化，与定时触发的补跑检查并发安全。 */
function catchUpSafe() {
  try {
    if (state.services && state.services.scheduler) {
      state.services.scheduler.catchUp().catch((e) => log('⚠️ 保存后补跑检查异常：' + (e.message || e)));
    }
  } catch (e) { log('⚠️ 保存后补跑检查异常：' + (e.message || e)); }
}

function send(channel, payload) {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send(channel, payload);
  }
}

let gameRegistry = null;
function getGameRegistry() { return gameRegistry; }

/** 游戏数据清理链（插件契约）——「界面卸载」与「孤儿目录清理」共用：
 * 删账号/设置（storage.removeGameData）→ 清登录会话/关网页登录窗口 → 同步系统任务。
 * 插件目录与 onRemove 钩子由注册表侧负责（界面卸载走 reg.removePlugin；孤儿路径无插件可调）。 */
async function cleanupGameData(gameId) {
  const svc = state.services;
  const removed = svc.storage.removeGameData(gameId);
  for (const [k, s] of state.loginSessions) if (s.game === gameId) state.loginSessions.delete(k);
  const win = state.webWindows.get(gameId);
  if (win) { if (!win.isDestroyed()) { win.close(); } }
  state.webWindows.delete(gameId);
  if (state.webWinState) state.webWinState.delete(gameId);
  if (state.webLoginBound) delete state.webLoginBound[gameId];
  const settings = svc.storage.loadSettings();
  await syncSystemTasks(settings, false);
  return removed;
}

/**
 * 插件契约：扫描时自动清理「用户直接删除插件目录（不经界面）」留下的孤儿数据。
 * 流程（无插件可调 onRemove，日志注明）：删该游戏全部账号（storage.removeGameData 含加密凭据）
 * → 删 settings.games[id] → 清登录会话/关网页窗口 → syncSystemTasks 删对应 签到助手-* 系统任务。
 * @returns {Promise<Array<{gameId:string, removedAccounts:number}>>}（gameId 为插件 id；目录名≠id 时日志附带目录名）
 */
async function cleanupDisappearedGames() {
  const reg = getGameRegistry();
  if (!reg || !state.services) return [];
  const disappeared = reg.getDisappeared();   // [{ dir, id|null }]（id 为目录名→插件id 映射结果）
  const cleaned = [];
  for (const item of disappeared) {
    const dirName = item && item.dir;
    let gameId = item && item.id;
    try {
      if (!gameId) {
        // 状态文件里没有 id 映射时：仅当该目录名下确实存在数据
        // （即目录名恰好===插件 id）才按目录名清理；否则如实跳过，
        // 杜绝把目录名当 id 清理不到数据却报"已清理"
        const s = state.services.storage.loadSettings();
        const hasData = state.services.storage.getAccountsByGame(dirName).length > 0 || !!(s.games && s.games[dirName]);
        if (!hasData) {
          state.services.push('🧹 插件目录「' + dirName + '」已移除（无 id 映射且名下无账号/设置，无需清理）');
          continue;
        }
        gameId = dirName;
      }
      const removed = await cleanupGameData(gameId);
      state.services.push('🧹 已清理已删除游戏 ' + gameId + (dirName && dirName !== gameId ? '（目录「' + dirName + '」）' : '') + ' 的孤儿数据（账号 ' + removed.removedAccounts + ' 个、设置/系统任务已清）');
      cleaned.push({ gameId, removedAccounts: removed.removedAccounts });
    } catch (e) {
      state.services.push('⚠️ 清理已删除游戏 ' + (gameId || dirName) + ' 失败：' + (e.message || e));
    }
  }
  return cleaned;
}

function getLoginMethod(plugin, kind) {
  return ((plugin && plugin.loginMethods) || []).find(m => (m.kind || gameRegistryMod.guessKind(m.needs)) === kind) || null;
}
/** 网页登录元数据：由插件 web 登录方式的 webMeta 提供（框架不内置任何游戏目标） */
function getWebMeta(plugin) {
  if (!plugin) return null;
  const m = getLoginMethod(plugin, 'web');
  return (m && m.webMeta) || null;
}
/** 账号摘要字段（显示名/告警/cookieValid）由插件 describeCredential 提供（插件契约） */
function describeCredential(plugin, cred) {
  if (plugin && typeof plugin.describeCredential === 'function') {
    const d = plugin.describeCredential(cred || {});
    if (d && typeof d === 'object') return Object.assign({}, { nickname: '', warning: '', cookieValid: null }, d);
  }
  return { nickname: '', warning: '', cookieValid: null };
}
function credentialNickname(plugin, cred, fallbackMobile) {
  const d = describeCredential(plugin, cred);
  if (d.nickname) return d.nickname;
  if (cred && cred.mobile) return maskMobile(cred.mobile);
  if (cred && cred.userName) return cred.userName;
  if (fallbackMobile) return maskMobile(fallbackMobile);
  return '';
}

/**
 * 渲染层安全游戏元数据（t10）：IPC 结构化克隆无法序列化函数 → 剔除 loginMethods 中的回调字段。
 * 渲染层只需要 kind/label/hint/needs 元数据驱动登录面板；函数回调仅主进程可用（LOGIN_KIND 经注册表取）。
 */
function ipcSafeGame(g) {
  if (!g || typeof g !== 'object') return g;
  // 递归剔除不可序列化的函数（含 loginMethods 元素内回调，以及 webMeta 里的 validate/buildCredentials），
  // 否则 IPC 结构化克隆会因函数抛异常，导致 games:list 整个失败、渲染层拿不到游戏列表
  const sanitizeMethod = (m) => {
    const out = {};
    for (const k of Object.keys(m || {})) {
      const v = m[k];
      if (typeof v === 'function') continue;
      if (k === 'webMeta' && v && typeof v === 'object') {
        const wm = {};
        for (const wk of Object.keys(v)) if (typeof v[wk] !== 'function') wm[wk] = v[wk];
        out[k] = wm;
        continue;
      }
      out[k] = v;
    }
    return out;
  };
  return {
    id: g.id, name: g.name, community: g.community, icon: g.icon,
    meta: g.meta, defaultEnabled: g.defaultEnabled, source: g.source, idHint: g.idHint,
    loginMethods: (g.loginMethods || []).map(sanitizeMethod),
  };
}
function ipcSafeGames(list) {
  return (list || []).map(ipcSafeGame);
}

/** 按 kind 分发的登录动作表（插件契约）：不在 main.js 写 per-game if/else，插件自带回调优先、模块级兼容回退 */
const LOGIN_KIND = {
  sms: {
    send(plugin, ctx, args) {
      const m = getLoginMethod(plugin, 'sms');
      if (m && typeof m.sendSms === 'function') return m.sendSms(ctx, args);
      const fn = plugin && plugin.sendSmsCode;
      if (typeof fn !== 'function') return Promise.reject(new Error('插件未提供 sendSmsCode 回调'));
      return ctx.fp ? fn(String(args.mobile), ctx.fp) : fn(String(args.mobile));
    },
    login(plugin, ctx, args) {
      const m = getLoginMethod(plugin, 'sms');
      if (m && typeof m.smsLogin === 'function') return m.smsLogin(ctx, args);
      const fn = plugin && plugin.loginBySms;
      if (typeof fn !== 'function') return Promise.reject(new Error('插件未提供 loginBySms 回调'));
      if (ctx.actionType) return fn(String(args.mobile), String(args.code), ctx.actionType);
      if (ctx.fp) return fn(String(args.mobile), String(args.code), ctx.fp);
      return fn(String(args.mobile), String(args.code));
    },
  },
  paste: {
    login(plugin, ctx, args) {
      const m = getLoginMethod(plugin, 'paste');
      if (m && typeof m.paste === 'function') return m.paste(ctx, args);
      const fn = (plugin && plugin.loginByPaste) || (plugin && plugin.loginByCookie);
      if (typeof fn !== 'function') return Promise.reject(new Error('插件未提供粘贴登录回调'));
      return ctx.fp ? fn(String(args.raw), ctx.fp, ctx.oldCred || null) : fn(String(args.raw));
    },
  },
};

/**
 * 取该游戏已有账号凭据里的设备指纹（最权威：与那个账号当初登录时用的完全一致）。
 * 找不到返回 null，由 makeLoginCtx 继续往下走「持久化指纹 → 新生成」。
 */
function existingFingerprint(gameId) {
  try {
    const svc = state.services;
    if (!svc || !svc.storage) return null;
    const list = svc.storage.loadAccounts();
    for (const a of list) {
      if (a.game !== gameId) continue;
      const cr = a.credentials || {};
      if (cr.deviceid && cr.openudid && cr.vendorid) {
        return { deviceid: cr.deviceid, openudid: cr.openudid, vendorid: cr.vendorid };
      }
    }
  } catch (e) { /* 复用失败不阻断 */ }
  return null;
}

/**
 * 构造登录上下文的设备指纹，取值顺序：
 * ① 同游戏已有账号凭据里的指纹（existingFingerprint）——最权威；
 * ② 按游戏持久化的指纹（storage.getFingerprint，落 <dataDir>/fingerprints.json）——解决首次登录无账号可借；
 * ③ 都没有才让插件新生成一份，并**立即持久化**，本游戏后续登录复用同一份。
 *
 * 为什么这么做：同一账号反复更换设备标识容易触发服务端风控（外部项目 SkyBlue997/tjd-daily 亦注明
 * 「同账号每次登录建议复用同一份指纹」「--new-device 老账号慎用，可能触发风控」）。若首次登录就生成
 * 全新随机指纹，还会形成鸡生蛋：要收到验证码得先有账号可借指纹，要有账号得先收到验证码。
 *
 * 排查「收不到验证码」时，先查 fingerprints.json 是否被清空/损坏、是否多机共用同一数据目录，
 * 再怀疑服务端。
 */
function makeLoginCtx(plugin, gameId) {
  let fp = null;
  const svc = state.services;
  const store = (svc && svc.storage) || null;
  const reused = gameId ? existingFingerprint(gameId) : null;
  const persisted = (!reused && gameId && store && typeof store.getFingerprint === 'function')
    ? store.getFingerprint(gameId) : null;
  const seed = reused || persisted;
  if (seed) {
    // 交给插件的 reuseFingerprint 校验/规范化（契约：oldCfg 有效则原样复用，否则退回新生成）
    fp = (plugin && typeof plugin.reuseFingerprint === 'function') ? plugin.reuseFingerprint(seed) : seed;
  } else if (plugin && typeof plugin.reuseFingerprint === 'function') {
    fp = plugin.reuseFingerprint(null);
  } else if (plugin && typeof plugin.genFingerprint === 'function') {
    fp = plugin.genFingerprint();
  }
  // 不是从已有账号借来的（即可能刚新生成）→ 持久化，供该游戏后续登录复用同一份
  if (!reused && fp && gameId && store && typeof store.saveFingerprint === 'function') {
    try { store.saveFingerprint(gameId, fp); } catch (e) { /* 持久化失败不阻断登录 */ }
  }
  return { fp, actionType: null, oldCred: null };
}

function loadGame(gameId) {
  const p = getGameRegistry() && getGameRegistry().get(gameId);
  if (p) return p;
  throw new Error('游戏插件未安装：' + gameId);
}

/** 账号对外摘要（永不含 credentials；roleWarning/cookieValid/昵称由插件 describeCredential 提供） */
function accountSummary(account) {
  const cred = account.credentials || {};
  const d = describeCredential(getGameRegistry() && getGameRegistry().get(account.game), cred);
  return {
    id: account.id,
    game: account.game,
    nickname: account.nickname || d.nickname || '',
    enabled: account.enabled !== false,
    time: account.time || '',                    // 账号自定义时间（空=跟随游戏/全局）
    lastResult: account.lastResult || null,
    roleWarning: d.warning || '',
    cookieValid: d.cookieValid,
  };
}

function newAccount(gameId, credentials, nickname) {
  return {
    id: storageMod.newId(),
    game: gameId,
    nickname,
    enabled: true,
    credentials,
  };
}

/** 主进程日志：写文件 + 推送到渲染进程 */
function makeLogger(dataDir) {
  const logger = loggerMod.create(dataDir);
  return {
    logger,
    push(msg) {
      const line = logger.log(msg);
      send('event:log', { time: new Date().toISOString(), msg: String(msg) });
      return line;
    },
  };
}

// ---------------------------------------------------------------------------
// safeStorage 加密接入
// ---------------------------------------------------------------------------
function makeCrypto() {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      available: true,
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64')),
    };
  }
  log('⚠️ safeStorage 不可用（非 Windows / 无 DPAPI 环境），凭据将明文存储并标记 plain');
  return { available: false, encrypt: null, decrypt: null };
}

// ---------------------------------------------------------------------------
// 服务组装
// ---------------------------------------------------------------------------
function createServices() {
  const dataDir = ARGS.dataDir || storageMod.defaultDataDir();
  const crypto = makeCrypto();
  // t7/t10：已安装游戏供应器（注册表 list → 每游戏默认 enabled；未就绪/未注入时 storage 回落 BUILTIN_GAME_DEFAULTS）
  // t10：内置游戏默认启用（source==='builtin'），用户插件按插件 defaultEnabled（缺省 false）
  const installedGames = () => { const reg = getGameRegistry(); if (!reg) return null; return reg.list().map(p => ({ id: p.id, defaultEnabled: !!p.defaultEnabled, time: p.defaultTime || '' })); };
  const storage = storageMod.create(dataDir, Object.assign({}, crypto, { installedGames }));
  const lg = makeLogger(dataDir);
  // 游戏注册表（只扫 defaultScriptsDir 返回的「脚本」目录，框架不内置脚本）
  gameRegistry = gameRegistryMod.create({ dataDir, userDir: defaultScriptsDir() });   // 脚本目录=免安装版内/脚本（或开发根/脚本），放进去即自动读取
  gameRegistry.loadAll();
  // 启动扫描——用户直接删除插件目录（上次存在、本次消失）→ 自动清理孤儿账号/设置/会话/系统任务
  // （无插件可调 onRemove，日志注明；自测模式不重复跑，selftest 内已专门断言清理链）
  if (!ARGS.selftest && !ARGS.taskTest) {
    cleanupDisappearedGames().catch((e) => log('⚠️ 启动孤儿数据清理异常：' + (e && e.message || e)));
  }
  const services = {
    dataDir,
    storage,
    crypto,
    logger: lg.logger,
    push: lg.push,
    gameRegistry,
    qqbot: qqbotMod.create({ log: (m) => lg.push(m) }),   // QQ 机器人（日报/绑定/测试）
  };

  const runner = runnerMod.create({
    storage,
    logger: lg.logger,
    notify: notifyMod.notify,
    // t10：runner.loadGame 经注册表解析（内置+用户插件），用户插件可被调度/手动签到
    getGamePlugin: (gameId) => { const reg = getGameRegistry(); return reg ? reg.get(gameId) : null; },
    onProgress: (p) => {
      send('event:progress', p);
      // 游戏签到完成 → 系统通知（R4.3；自测模式不打扰；点击唤起主界面 R8）
      if (p.type === 'game-done' && !(ARGS.selftest || ARGS.taskTest)) {
        try {
          const g = loadGame(p.gameId);
          const n = new Notification({
            title: g.name + ' 签到完成',
            body: '成功 ' + p.ok + ' 个 / 失败 ' + p.fail + ' 个',
          });
          n.on('click', () => showMainWindow());
          n.show();
        } catch (e) { /* 通知失败不影响流程 */ }
      }
    },
    log: (msg) => lg.push(msg),
  });
  services.runner = runner;

  const scheduler = schedulerMod.create({
    storage,
    runner,
    logger: lg.logger,
    log: (msg) => lg.push(msg),
  });
  services.scheduler = scheduler;
  return services;
}

// ---------------------------------------------------------------------------
// QQ 机器人日报：每天一条「签到日报」+ 启动/过点补发
// 与签到主流程完全解耦：只读签到结果与账号清单；任何异常只写日志。
// ---------------------------------------------------------------------------
function qqReportStateFile() {
  return path.join(state.services.dataDir, 'qqbot-state.json');
}

function loadQqReportState() {
  try { return JSON.parse(fs.readFileSync(qqReportStateFile(), 'utf8')) || {}; } catch (e) { return {}; }
}

function saveQqReportState(st) {
  try { fs.writeFileSync(qqReportStateFile(), JSON.stringify(st, null, 2), 'utf8'); } catch (e) { /* 尽力而为 */ }
}

function pad2(x) { return String(x).padStart(2, '0'); }

/** 组装并发送当日日报（只读当天结果，纯旁路；失败只记日志） */
async function sendDailyReport(reason) {
  const svc = state.services;
  const settings = svc.storage.loadSettings();
  const cfg = settings.notify.qqbot || {};
  const now = new Date();
  const results = svc.logger.loadTodayResults();
  const accounts = svc.storage.loadAccounts();
  const reg = getGameRegistry();
  const games = [];
  for (const gameId of Object.keys(settings.games || {})) {
    const gs = settings.games[gameId];
    if (!gs || gs.enabled === false) continue;
    const accs = accounts.filter((a) => a.game === gameId && a.enabled !== false);
    const hasRes = !!(results[gameId] && results[gameId].length);
    if (!accs.length && !hasRes) continue;
    const plugin = reg && reg.get(gameId);
    games.push({
      id: gameId,
      name: gameName(gameId),
      community: (plugin && plugin.community) || '',
      accounts: accs.map((a) => ({ id: a.id, nickname: a.nickname || '' })),
    });
  }
  const sp = qqbotMod.reportSendTime(settings.defaultTime, now);
  const untilLabel = sp ? (pad2(sp.hh) + ':' + pad2(sp.mm)) : (pad2(now.getHours()) + ':' + pad2(now.getMinutes()));
  const text = qqbotMod.composeDailyText(results, {
    dateLabel: (now.getMonth() + 1) + '月' + now.getDate() + '日',
    untilLabel,
    games,
  });
  const r = await svc.qqbot.sendText(cfg, text);
  if (r.ok) svc.push('🤖 QQ 日报已发送（' + (reason || '定时') + '）');
  else svc.push('⚠️ QQ 日报发送失败：' + r.error);
  return r;
}

/** 每分钟检查：到点且当天未发 → 发送。含启动补发、无记录 15 分钟宽限、失败 30 分钟冷却 */
function qqReportCheck() {
  const svc = state.services;
  if (!svc || !svc.qqbot) return;
  let settings;
  try { settings = svc.storage.loadSettings(); } catch (e) { return; }
  const cfg = settings.notify.qqbot || {};
  if (!cfg.appId || !cfg.appSecret || !cfg.openid) return;   // 未配置/未绑定：静默跳过
  const now = new Date();
  const today = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  const st = state.qqReportState || (state.qqReportState = loadQqReportState());
  if (st.lastDate === today) return;                                          // 今天已成功发送
  if (st.lastAttempt && Date.now() - st.lastAttempt < 30 * 60 * 1000) return; // 发送中/失败冷却
  const sp = qqbotMod.reportSendTime(settings.defaultTime, now);
  if (!sp || now.getTime() < sp.ts) return;                                   // 未到发送时刻
  // 无任何记录时不急于下结论（可能刚开机、兜底补签还在跑）→ 15 分钟宽限后再判
  let results;
  try { results = svc.logger.loadTodayResults(); } catch (e) { results = {}; }
  const hasAny = Object.keys(results).some((k) => Array.isArray(results[k]) && results[k].length);
  if (!hasAny) {
    if (st.noRecDate !== today) { st.noRecDate = today; st.noRecAt = Date.now(); saveQqReportState(st); return; }
    if (Date.now() - (st.noRecAt || 0) < 15 * 60 * 1000) return;
  } else if (st.noRecDate) {
    delete st.noRecDate; delete st.noRecAt;
  }
  st.lastAttempt = Date.now();
  saveQqReportState(st);
  sendDailyReport('定时/补发').then((r) => {
    if (r && r.ok) { st.lastDate = today; st.lastError = ''; }
    else { st.lastError = (r && r.error) || '发送失败'; }
    saveQqReportState(st);
  }).catch((e) => { st.lastError = (e && e.message) || '发送异常'; saveQqReportState(st); });
}

function startQqReportTimer() {
  if (ARGS.selftest || ARGS.taskTest) return;   // 自测模式不发任何消息
  state.qqReportTimer = setInterval(() => {
    try { qqReportCheck(); } catch (e) { log('QQ 日报检查异常：' + (e.message || e)); }
  }, 60 * 1000);
  if (typeof state.qqReportTimer.unref === 'function') { try { state.qqReportTimer.unref(); } catch (e) { /* ignore */ } }
  // 启动即检查一次：过点未发则补发（当天一条）
  try { qqReportCheck(); } catch (e) { log('QQ 日报启动检查异常：' + (e.message || e)); }
}

// ---------------------------------------------------------------------------
// 窗口 / 托盘 / 自启
// ---------------------------------------------------------------------------
function devPlaceholderHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${APP_NAME}</title>
<style>body{font-family:"Microsoft YaHei",sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;max-width:520px;padding:32px;border:1px dashed #334155;border-radius:12px}
h1{font-size:22px;margin:0 0 12px} p{color:#94a3b8;line-height:1.8;margin:6px 0}
code{background:#1e293b;padding:2px 8px;border-radius:4px;color:#7dd3fc}</style></head>
<body><div class="box"><h1>${APP_NAME}</h1>
<p>主进程已就绪（版本 ${app.getVersion()}），界面模块尚未构建。</p>
<p>开发模式降级页面 —— 由 <code>dev-ui</code> 的 renderer/ 替换。</p>
<p>数据目录：<code>${ARGS.dataDir || storageMod.defaultDataDir()}</code></p></div></body></html>`;
}

function createMainWindow(opts) {
  opts = opts || {};
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 920,
    minHeight: 600,
    title: APP_NAME,
    show: false,
    autoHideMenuBar: true,
    icon: nativeImage.createFromDataURL('data:image/png;base64,' + ICON_B64),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // 安全基线
      nodeIntegration: false,   // 安全基线
      sandbox: true,            // 安全基线
      spellcheck: false,
    },
  });

  const rendererFile = path.join(__dirname, 'renderer', 'index.html');
  if (fs.existsSync(rendererFile)) {
    state.rendererMode = 'renderer';
    if (opts.loadPage !== false) win.loadFile(rendererFile);
  } else {
    // 开发模式降级：renderer 未就绪时加载占位页，保证应用可启动
    state.rendererMode = 'dev-placeholder';
    if (opts.loadPage !== false) {
      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(devPlaceholderHtml()));
    }
  }

  win.once('ready-to-show', () => {
    if (!ARGS.hidden) win.show();
  });

  // 关闭行为二选一（t13）：closeBehavior='exit' 时点 X 真正退出（不再后台常驻）；
  // 否则（默认 'tray'）隐藏到托盘继续后台常驻。托盘菜单「退出」始终为真正退出。
  win.on('close', (e) => {
    if (!state.quitting) {
      let cb = 'tray';
      try { cb = (state.services && state.services.storage.loadSettings().closeBehavior) || 'tray'; } catch (err) { /* 设置读取失败走默认 */ }
      if (cb === 'exit') {
        state.quitting = true;
        app.quit(); // before-quit 会停调度器并清每日维护定时器
        return;
      }
      e.preventDefault();
      if (state.tray && typeof state.tray.displayBalloon === 'function') {
        try { state.tray.displayBalloon({ title: APP_NAME, content: '已最小化到托盘，签到任务继续运行' }); } catch (e) { /* ignore */ }
      }
      // 隐藏到托盘（保留渲染进程，最稳定；签到引擎在主进程，不影响）
      if (state.services) state.services.push('窗口已最小化到托盘（签到任务继续在主进程运行）');
      win.hide();
    }
  });

  // 托盘隐藏时通知 renderer 释放日志流等 DOM，降低常驻内存（不影响主进程调度）
  win.on('hide', () => { send('event:visibility', { visible: false }); });
  win.on('show', () => { send('event:visibility', { visible: true }); });
  win.on('closed', () => { state.mainWindow = null; });
  return win;
}

function buildTrayMenu() {
  const svc = state.services;
  let nextText = '未启用';
  // nextRunInfo 返回 {ts,time,groups,text}，没有 gameId 字段——
  // 原写法托盘固定显示「（undefined）」。改用 groups 描述游戏×账号数
  try {
    const n = svc.scheduler.nextRunInfo();
    if (n) {
      const desc = (n.groups || []).map(g => gameName(g.gameId) + '×' + g.accountIds.length).join('、');
      nextText = n.text + (desc ? '（' + desc + '）' : '');
    }
  } catch (e) { /* ignore */ }
  const menu = Menu.buildFromTemplate([
    { label: '显示主界面', click: () => showMainWindow() },
    { label: '立即签到全部', click: () => { runAll(); } },
    { label: '下次签到：' + nextText, enabled: false },
    { type: 'separator' },
    {
      label: '退出', click: () => {
        state.quitting = true;
        if (state.services) state.services.scheduler.stop();
        app.quit();
      },
    },
  ]);
  return menu;
}

function createTray() {
  const icon = nativeImage.createFromDataURL('data:image/png;base64,' + ICON_B64);
  const tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => showMainWindow());
  state.tray = tray;
}

function showMainWindow() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) {
    state.mainWindow = createMainWindow();
  }
  if (state.mainWindow.isMinimized()) state.mainWindow.restore();
  state.mainWindow.show();
  state.mainWindow.focus();
}

/**
 * 开机自启参数（Windows）：openAsHidden 仅 macOS 且新版 Electron 已移除该选项，
 * Windows 登录自启（注册表 Run 键）必须用 args 显式传 --hidden，
 * 否则开机以裸 exe 启动、主窗口直接弹到桌面（schtasks 定时任务路径早已由 appLaunchCommand 自带 --hidden）。
 */
function autostartSettings(enabled) {
  return { openAtLogin: !!enabled, args: ['--hidden'] };
}

/** 开机自启（仅在打包应用或用户显式切换时写注册表，避免开发期污染） */
function applyAutostart(enabled) {
  try {
    if (!app.isPackaged) {
      log('开发模式跳过写入开机自启（' + (enabled ? '开启' : '关闭') + '）—— 打包后生效');
      return { ok: true, note: 'dev-skip' };
    }
    app.setLoginItemSettings(autostartSettings(enabled));
    log('开机自启已' + (enabled ? '开启' : '关闭'));
    return { ok: true };
  } catch (e) {
    log('开机自启设置失败：' + e.message);
    return { ok: false, error: e.message };
  }
}

function runAll() {
  const svc = state.services;
  if (!svc) return;
  svc.push('🖱️ 手动触发：签到全部');
  svc.runner.runAll().catch((e) => svc.push('全部签到异常：' + e.message));
}

// ---------------------------------------------------------------------------
// 系统计划任务同步（schtasks）—— 只操作「签到助手-*」前缀任务
// ---------------------------------------------------------------------------
function runSchtasks(args) {
  return new Promise((resolve) => {
    let req;
    try {
      // zh-CN Windows 下 schtasks 输出 GBK 字节，按 utf8 解码中文全乱码，
      // 导致「签到助手-*」任务名匹配失败（遗留任务永远无法识别/清理）。改为 buffer 收集 + GBK 兼容解码。
      req = execFile('schtasks', args, { windowsHide: true, timeout: 15000, encoding: 'buffer' }, (err, stdout, stderr) => {
        if (err && (err.code === 'EPERM' || err.errno === -4048)) {
          // 受限环境（沙箱/CI）禁止创建子进程输出管道；错误信息如实上报
          resolve({ ok: false, code: 'EPERM', stdout: '', stderr: '环境限制：无法启动 schtasks（' + err.message + '）' });
          return;
        }
        resolve({ ok: !err, code: err ? err.code : 0, stdout: decodeProcOutput(stdout), stderr: decodeProcOutput(stderr) });
      });
    } catch (e) {
      // 部分受限环境（沙箱）会在 spawn 阶段同步抛出 EPERM
      resolve({ ok: false, code: 'EPERM', stdout: '', stderr: '环境限制：无法启动 schtasks（' + e.message + '）' });
    }
    if (req && typeof req.on === 'function') {
      req.on('error', (e) => {
        if (e && (e.code === 'EPERM' || e.errno === -4048)) {
          resolve({ ok: false, code: 'EPERM', stdout: '', stderr: '环境限制：无法启动 schtasks（' + e.message + '）' });
        }
      });
    }
  });
}

function gameName(gameId) {
  const p = getGameRegistry() && getGameRegistry().get(gameId);
  if (p && p.name) return p.name;
  return gameId;
}

/**
 * 默认脚本目录（注册表扫描的唯一目录；用户把插件文件夹放进去即自动加载）：
 * - --scripts-dir= 显式指定时优先用它（自测/任务测试会指到 <数据目录>/plugins 做隔离，见本文件末尾）
 * - 打包模式：<应用目录上级>/脚本/（process.resourcesPath 上两级 = 游戏社区签到助手-免安装版-vX.Y.Z，绿色版内自带脚本）
 * - 开发模式：仓库根/脚本/
 * - 都找不到时（如安装到 Program Files 只读）：回退到 <数据目录>/脚本/ 并自动创建
 */
function defaultScriptsDir() {
  const candidates = [];
  if (ARGS.scriptsDir) candidates.push(ARGS.scriptsDir);
  if (app.isPackaged) {
    candidates.push(path.resolve(process.resourcesPath, '..', '..', '脚本'));
  } else {
    candidates.push(path.resolve(app.getAppPath(), '..', '脚本'));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  // 安装版（Program Files 只读）等无外置脚本目录时：回退到数据目录下可写的脚本目录
  const fallback = path.join(ARGS.dataDir || storageMod.defaultDataDir(), '脚本');
  try { fs.mkdirSync(fallback, { recursive: true }); return fallback; } catch (e) { /* 创建失败返回 null，界面会提示 */ }
  return null;
}

function taskName(gameId) {
  return TASK_PREFIX + gameName(gameId);
}

/** 全局兜底系统任务名 */
function globalTaskName() {
  return TASK_PREFIX + '全局';
}

/**
 * 本应用应管理的任务：只建一个「签到助手-全局」任务，时间=全局统一时间。
 * 游戏/账号自定义时间不建任务（靠内置定时器挂后台）；应用未运行时由全局任务拉起 catchUp 兜底补签。
 * settings.useSystemTask=false 时返回空数组 → 删除全部本应用任务。
 */
function plannedTasks(settings) {
  if (!settings || settings.useSystemTask !== true) return [];
  const t = validHHmm(settings.defaultTime);
  if (!t) return [];
  return [{ name: globalTaskName(), time: t }];
}

function appLaunchCommand() {
  const exe = process.execPath;
  const parts = ['"' + exe + '"'];
  if (!app.isPackaged) parts.push('"' + app.getAppPath() + '"');
  parts.push('--hidden');
  return parts.join(' ');
}

async function queryAllAppTasks() {
  const r = await runSchtasks(['/Query', '/FO', 'CSV', '/NH']);
  if (!r.ok) return [];
  const out = [];
  // CSV: "TaskName","Next Run Time","Status"
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)","([^"]*)","([^"]*)"/.exec(line.trim());
    if (!m) continue;
    // schtasks CSV 的 TaskName 带前导反斜杠（如 \签到助手-全局），
    // 不剥离则 startsWith('签到助手-') 永远 false，旧任务永远识别不到、无法清理
    const name = m[1].replace(/^\\+/, '');
    if (name.startsWith(TASK_PREFIX)) out.push({ name, time: m[2], status: m[3] });
  }
  return out;
}

async function queryTask(name) {
  const r = await runSchtasks(['/Query', '/TN', name, '/FO', 'LIST']);
  if (!r.ok) return null;
  const m = /下次运行时间:\s*(.+)/.exec(r.stdout) || /Next Run Time:\s*(.+)/.exec(r.stdout);
  return { name, exists: true, nextTime: m ? m[1].trim() : '' };
}

async function createOrUpdateTask(name, time) {
  const r = await runSchtasks(['/Create', '/F', '/TN', name, '/TR', appLaunchCommand(), '/SC', 'DAILY', '/ST', time]);
  return { ok: r.ok, code: r.code, detail: (r.stderr || r.stdout).trim().slice(0, 300) };
}

async function deleteTask(name) {
  const r = await runSchtasks(['/Delete', '/TN', name, '/F']);
  return { ok: r.ok, code: r.code, detail: (r.stderr || r.stdout).trim().slice(0, 300) };
}

/**
 * 同步系统任务到当前设置。dryRun=true 只返回将执行的命令，不真正操作。
 * 安全边界：只增删改 taskName 生成（签到助手-* 前缀）的任务。
 */
async function syncSystemTasks(settings, dryRun) {
  const want = plannedTasks(settings);
  const commands = [];
  const results = [];
  const existing = dryRun ? [] : await queryAllAppTasks();
  const wantNames = new Set(want.map(t => t.name));

  // 删除：已存在但不在期望列表中的任务（含 useSystemTask=false 时全部删除）
  for (const t of existing) {
    if (!wantNames.has(t.name)) {
      commands.push(['/Delete', '/TN', t.name, '/F']);
      if (!dryRun) results.push({ action: 'delete', name: t.name, ...(await deleteTask(t.name)) });
    }
  }
  // 创建/更新（/F 覆盖即更新，改时间自动重写）
  for (const t of want) {
    commands.push(['/Create', '/F', '/TN', t.name, '/TR', appLaunchCommand(), '/SC', 'DAILY', '/ST', t.time]);
    if (!dryRun) results.push({ action: 'upsert', name: t.name, time: t.time, ...(await createOrUpdateTask(t.name, t.time)) });
  }
  const failed = results.filter(r => !r.ok);
  return {
    ok: failed.length === 0,
    dryRun: !!dryRun,
    commands: commands.map(c => 'schtasks ' + c.map(x => x.includes(' ') ? '"' + x + '"' : x).join(' ')),
    results,
    detail: dryRun
      ? ('计划执行 ' + commands.length + ' 条命令')
      : (failed.length ? ('失败 ' + failed.length + ' 条：' + failed.map(f => f.name + ' ' + f.detail).join('; ')) : ('已同步 ' + results.length + ' 条任务')),
  };
}

// ---------------------------------------------------------------------------
// 登录流程
// ---------------------------------------------------------------------------
function smsSession(mobile) {
  const id = storageMod.newId();
  state.loginSessions.set(id, { mobile, createdAt: Date.now() });
  return id;
}

/** 定期清理过期登录会话（统一 60 分钟 TTL），防长期托盘常驻内存缓慢增长 */
function pruneLoginSessions() {
  const now = Date.now();
  for (const [k, s] of state.loginSessions) {
    if (!s.createdAt || now - s.createdAt > 60 * 60 * 1000) state.loginSessions.delete(k);
  }
}

/** 渲染进程未回传 session 时：按 game+mobile 找回最近的验证码会话（10 分钟内） */
function findSmsSession(game, mobile) {
  let best = null;
  for (const [id, s] of state.loginSessions) {
    if (s.game === game && s.mobile === mobile && Date.now() - s.createdAt < 10 * 60 * 1000) {
      if (!best || s.createdAt > best.createdAt) best = { id, ...s };
    }
  }
  return best;
}

/** 登录成功后统一建档 */
async function finishLogin(gameId, credentials, nickname) {
  const plugin = getGameRegistry() && getGameRegistry().get(gameId);
  const d = describeCredential(plugin, credentials);
  const n = nickname || d.nickname || '';
  const account = newAccount(gameId, credentials, n);
  state.services.storage.upsertAccount(account);
  rescheduleSafe();   // 新账号立即纳入调度
  send('event:accounts', { reason: 'added' });
  return accountSummary(account);
}

/**
 * 网页登录成功（供登录态提取集成调用）：推送 event:webLogin success 并标记已绑定，
 * 窗口随后关闭时不再触发降级提示。
 */
async function webLoginSuccess(gameId, account) {
  if (!state.webLoginBound) state.webLoginBound = {};
  state.webLoginBound[gameId] = true;
  send('event:webLogin', { game: gameId, status: 'success', account });
  return account;
}

async function handleSendSms({ game, mobile }) {
  const plugin = getGameRegistry() && getGameRegistry().get(game);
  if (!plugin) return { ok: false, error: '未知游戏' };
  const method = getLoginMethod(plugin, 'sms');
  if (!method) return { ok: false, error: '该游戏不支持短信验证码登录' };
  if (!/^1\d{10}$/.test(String(mobile || ''))) return { ok: false, error: '手机号格式不正确（应为 11 位大陆手机号）' };
  try {
    const sid = smsSession(mobile);
    const s = state.loginSessions.get(sid);
    s.game = game;
    const ctx = makeLoginCtx(plugin, game);
    const r = await LOGIN_KIND.sms.send(plugin, ctx, { mobile });
    if (r && r.ok && r.sessionData) Object.assign(s, r.sessionData);
    if (r && r.ok && ctx.fp) s.fp = ctx.fp;
    return { ok: !!(r && r.ok), needCaptcha: !!(r && (r.needCaptcha || r.needGeeTest)), msg: (r && (r.msg || r.error)) || '', session: (r && r.ok) ? sid : null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleSmsLogin({ game, mobile, code, session }) {
  const plugin = getGameRegistry() && getGameRegistry().get(game);
  if (!plugin) return { ok: false, error: '未知游戏' };
  const method = getLoginMethod(plugin, 'sms');
  if (!method) return { ok: false, error: '该游戏不支持短信验证码登录' };
  if (!/^1\d{10}$/.test(String(mobile || ''))) return { ok: false, error: '手机号格式不正确' };
  if (!/^\d{4,8}$/.test(String(code || '').trim())) return { ok: false, error: '验证码格式不正确' };
  const s = (session && state.loginSessions.get(session)) || findSmsSession(game, String(mobile || ''));
  try {
    const ctx = makeLoginCtx(plugin, game);
    if (s && s.actionType) ctx.actionType = s.actionType;
    if (s && s.fp) ctx.fp = s.fp;
    const cred = await LOGIN_KIND.sms.login(plugin, ctx, { mobile, code });
    const nick = credentialNickname(plugin, cred, mobile);
    const account = await finishLogin(game, cred, nick);
    return { ok: true, account };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 官方网页登录窗口（kind:'web'）。当前声明者：库街区（鸣潮）、米游社（崩铁）。
 * 塔吉多（异环）**没有** webMeta——真走到这里会被下方 handleWebOpen 直接回「该游戏暂不支持网页登录窗口」。
 * 流程：webMeta.loginUrl 加载官方页 → did-finish-load/did-navigate 后定时执行
 * webMeta.extractScript（webContents.executeJavaScript）→ webMeta.validate →
 * 校验通过则 webMeta.buildCredentials → finishLogin + webLoginSuccess（自动绑定）。
 * 框架会把窗口 session 的 Cookie 注入 extracted._cookies（[{name,domain,value}]）供 validate/buildCredentials 用，
 * 这样 HttpOnly 的 cookie_token_v2 也能拿到（页面内 document.cookie 读不到它）。
 * 窗口打开期间提取失败不推送降级（用户可能尚未登录）；窗口关闭仍未绑定 → 按 webMeta.degradation 提示降级。
 */
const WEB_EXTRACT_INTERVAL = 3000;   // 提取轮询间隔
const WEB_EXTRACT_MAX = 120;         // 最多轮询次数（≈6 分钟；F3 修复：原 60 次≈3 分钟，SPA 登录停留超时后提取链停止，现延长并支持 did-finish-load 重置）

/**
 * 网页登录会话重置（F1 修复）：每次打开网页登录窗口（新建或复用）都重置本游戏的绑定标记，
 * 使每次打开都是独立会话——避免第一次绑定成功后 webLoginBound 永久为 true，
 * 导致同一游戏第二次网页登录（添加第二个账号/删除后重绑）完全静默失效。
 * 提取中（wState.extracting）与窗口销毁守卫不受影响，仍由 attemptExtract 内部维护。
 */
function resetWebLoginBound(game) {
  if (!state.webLoginBound) state.webLoginBound = {};
  state.webLoginBound[game] = false;
}

async function handleWebOpen({ game }) {
  const plugin = getGameRegistry() && getGameRegistry().get(game);
  if (!plugin) return { ok: false, error: '未知游戏' };
  const meta = getWebMeta(plugin);
  if (!meta || !meta.loginUrl) return { ok: false, error: '该游戏暂不支持网页登录窗口' };
  if (typeof meta.validate !== 'function' || typeof meta.buildCredentials !== 'function') return { ok: false, error: '插件 webMeta 缺少 validate/buildCredentials' };
  // F1：无论新建窗口还是复用已有窗口，先重置绑定标记（独立会话）
  resetWebLoginBound(game);
  const existing = state.webWindows.get(game);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    // 复用窗口：重新启动提取链（重置计数；同 token 去重守卫避免对已绑定账号重复建档）
    const ws = state.webWinState && state.webWinState.get(game);
    if (ws && typeof ws.restartExtract === 'function') ws.restartExtract();
    return { ok: true, note: '窗口已存在，会话已重置' };
  }
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    title: meta.title || (meta.name ? meta.name + ' 登录' : '网页登录窗口'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 独立分区：网页窗口 cookie 与主应用隔离
      partition: 'persist:weblogin',
    },
  });
  const wState = { game, extractTimer: null, extractCount: 0, extracting: false, restartExtract: null };
  state.webWinState = state.webWinState || new Map();
  state.webWinState.set(game, wState);

  async function attemptExtract() {
    // 已绑定：直接返回 true，不再提取（R3 修复：避免绑定后继续轮询/重复建档）
    if (state.webLoginBound && state.webLoginBound[game]) return true;
    if (wState.extracting || win.isDestroyed()) return false;
    wState.extracting = true;
    try {
      const extractScript = typeof meta.extractScript === 'function' ? meta.extractScript() : (meta.extractScript || '');
      let extracted = await win.webContents.executeJavaScript(extractScript);
      // 插件脚本可能返回原始值（非对象）——先包装为对象，
      // 否则下方 extracted._cookies 赋值在 strict 模式抛 TypeError（catch 内再赋值再抛），登录提取链中断
      if (!extracted || typeof extracted !== 'object') extracted = { value: extracted == null ? null : extracted };
      // 通用扩展：附加 HttpOnly cookie（executeJavaScript 读不到，仅主进程 session.cookies 能读；
      // 供 mihoyo 等插件提取 cookie_token_v2；值只在主进程内传给 validate/buildCredentials，不下发页面）
      try {
        const cookies = await win.webContents.session.cookies.get({});
        extracted._cookies = cookies.map(c => ({ name: c.name, domain: c.domain, value: c.value }));
      } catch (e) { extracted._cookieError = e.message; }
      const v = meta.validate(extracted);
      if (v.usable) {
        const cred = await meta.buildCredentials(extracted);
        // F1 守卫：同游戏同 token 已存在账号 → 跳过重复建档（复用窗口/重新打开会话时页面仍保留旧登录态的场景）
        // 仅当本凭据确有 token 时才做 token 去重——米游社等凭据无 token 字段，
        // 原写法 undefined===undefined 恒真，会把已有账号误判为重复，导致无法用网页登录添加第二个账号
        let dup = null;
        try {
          dup = state.services && state.services.storage.loadAccounts()
            .find(a => a.game === game && cred.token && a.credentials && a.credentials.token === cred.token) || null;
        } catch (e) { /* 存储异常不阻断：继续正常建档 */ }
        if (dup) {
          log('ℹ️ ' + game + ' 网页登录：该账号已绑定（' + (dup.nickname || dup.id) + '），跳过重复建档');
          await webLoginSuccess(game, accountSummary(dup));
          return true;
        }
        const account = await finishLogin(game, cred, '网页登录账号');
        await webLoginSuccess(game, account);
        log('🌐 ' + game + ' 网页登录成功，账号已自动绑定（id=' + account.id + '）');
        return true;
      }
      // 不可用：窗口仍开着，继续等待用户完成登录（不推送降级）
    } catch (e) {
      log('网页登录态提取异常（继续等待）：' + e.message);
    } finally {
      wState.extracting = false;
    }
    return false;
  }

  function stopExtract() {
    if (wState.extractTimer) { clearTimeout(wState.extractTimer); wState.extractTimer = null; }
  }

  function scheduleExtract() {
    stopExtract();
    if (wState.extractCount >= WEB_EXTRACT_MAX) return;
    wState.extractTimer = setTimeout(async () => {
      wState.extractTimer = null;
      wState.extractCount++;
      if (win.isDestroyed()) return;
      const bound = await attemptExtract();
      if (!win.isDestroyed() && !bound && !(state.webLoginBound && state.webLoginBound[game])) scheduleExtract();
    }, WEB_EXTRACT_INTERVAL);
  }

  // F1：复用窗口时从外部重启提取链（重置计数后重新调度）
  wState.restartExtract = () => { stopExtract(); wState.extractCount = 0; scheduleExtract(); };

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => {
    log('网页登录窗口已加载：' + win.webContents.getURL());
    // F3：页面加载完成重置提取计数（SPA 恢复会话/延迟加载也能获得完整轮询窗口，不因停留超时漏绑）
    wState.extractCount = 0;
    // SPA 恢复会话需要时间：延迟后开始提取轮询；已绑定则不再轮询（R3 修复）
    if (!state.webLoginBound || !state.webLoginBound[game]) scheduleExtract();
  });
  win.webContents.on('did-navigate', () => {
    // 登录跳转（如塔吉多 302 → id.wanmei.com → 回跳）后重置计数并继续提取；已绑定则不再轮询
    wState.extractCount = 0;
    if (!state.webLoginBound || !state.webLoginBound[game]) scheduleExtract();
  });
  win.on('closed', () => {
    state.webWindows.delete(game);
    stopExtract();
    state.webWinState.delete(game);
    send('event:webLogin', { game, status: 'closed' });
    // 窗口关闭且未完成绑定 → 明确降级提示（R6.4.2）
    if (!state.webLoginBound || !state.webLoginBound[game]) {
      const degradeText = (typeof meta.degradation === 'string') ? meta.degradation : (meta.degradation && meta.degradation.text);
      send('event:webLogin', { game, status: 'fail', error: degradeText || '网页登录未能提取到可用登录态' });
    }
  });
  state.webWindows.set(game, win);
  win.loadURL(meta.loginUrl);
  return { ok: true };
}

function handleWebCancel({ game }) {
  const win = state.webWindows.get(game);
  const wState = state.webWinState && state.webWinState.get(game);
  if (wState && wState.extractTimer) { clearTimeout(wState.extractTimer); wState.extractTimer = null; }
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
}

async function handlePaste({ game, raw }) {
  const plugin = getGameRegistry() && getGameRegistry().get(game);
  if (!plugin) return { ok: false, error: '未知游戏' };
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: '粘贴内容为空' };
  const method = getLoginMethod(plugin, 'paste');
  if (!method && !plugin.loginByPaste && !plugin.loginByCookie) {
    return { ok: false, error: '该游戏不支持粘贴登录' };
  }
  try {
    const ctx = makeLoginCtx(plugin, game);
    const cred = await LOGIN_KIND.paste.login(plugin, ctx, { raw: text });
    const nick = credentialNickname(plugin, cred, '') || '粘贴账号';
    const account = await finishLogin(game, cred, nick);
    return { ok: true, account };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// 浏览器登录界面（kind:'gui'）：本地 127.0.0.1 服务 + 系统默认浏览器打开 core/login-gui.html
// ---------------------------------------------------------------------------
/** 浏览器登录页面/事件用的账号摘要（掩码，不含凭据明文） */
function guiAccountSummary(account) {
  const cred = (account && account.credentials) || {};
  return {
    nickname: (account && account.nickname) || (cred.phone ? maskMobile(cred.phone) : ''),
    uid: cred.uid || '0',
    source: cred.source || '未知',
    loginAt: cred.loginAt || '',
    hasRefreshToken: !!(cred.refreshToken),
  };
}
function guiGameDesc(game, plugin) { return (plugin && plugin.name) || game; }

/** 登录成功 → 通知渲染层关闭弹窗/刷新账号 + 记日志（不在此关闭服务器，由渲染层或 /api/shutdown 收尾） */
function notifyGuiSuccess(game, account, source) {
  send('event:guiLogin', { game, status: 'success', source, account });
  send('event:accounts', { reason: 'added' });
  if (state.services) {
    state.services.push('✅ ' + guiGameDesc(game, getGameRegistry() && getGameRegistry().get(game)) +
      ' 浏览器登录成功（' + source + '）：' + ((account && account.nickname) || '新账号'));
  }
}

/** 启动（或复用）某游戏的浏览器登录界面服务；返回服务对象（含 url/close） */
async function startGuiServer(game, plugin) {
  const existing = state.guiServers.get(game);
  if (existing) return existing;
  const htmlFile = path.join(__dirname, 'core', 'login-gui.html');
  let html = '';
  try { html = fs.readFileSync(htmlFile, 'utf8'); } catch (e) {
    html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>浏览器登录</title></head>' +
      '<body style="font-family:Microsoft YaHei,sans-serif;background:#0f172a;color:#e2e8f0;padding:32px">' +
      '<h2>浏览器登录界面</h2><p>未找到登录页面文件：' + htmlFile + '</p></body></html>';
  }
  const server = browserLogin.createGuiServer({
    html,
    handlers: {
      status: async () => {
        const list = state.services.storage.loadAccounts().filter(a => a.game === game);
        // 可用的登录 tab：按插件声明除 gui 外的登录方式决定（sms / paste）
        const methods = ['sms', 'paste'].filter(k => getLoginMethod(plugin, k));
        return {
          ok: true,
          gameName: plugin.name || game,
          methods,
          hasAccounts: list.length > 0,
          accounts: list.slice(0, 6).map(guiAccountSummary),
          tip: '登录成功后自动加入「游戏社区签到助手」。',
        };
      },
      smsSend: async (b) => {
        const phone = String((b && b.phone) || '').trim();
        if (!/^1[0-9]{10}$/.test(phone)) return { ok: false, message: '手机号格式错误（需 11 位数字）' };
        // 与 App 内短信路径对齐——建立 smsSession 并保存 sessionData/指纹，
        // 供 smsLogin 复用（否则需要 actionType/fp 的插件在两路径行为不一致）
        const sid = smsSession(phone);
        const sess = state.loginSessions.get(sid);
        sess.game = game;
        const ctx = makeLoginCtx(plugin, game);
        const r = await LOGIN_KIND.sms.send(plugin, ctx, { mobile: phone });
        if (!(r && r.ok)) return { ok: false, message: ((r && (r.msg || r.error)) || '发送失败') + '（收不到验证码可改用「粘贴 token」；若提示需要人机验证，请用手机官方 App 给同一手机号发码后回填）' };
        if (r.sessionData) Object.assign(sess, r.sessionData);
        if (ctx.fp) sess.fp = ctx.fp;
        return { ok: true, message: (r.msg || '验证码已发送，请注意查收短信') };
      },
      smsLogin: async (b) => {
        const phone = String((b && b.phone) || '').trim();
        const code = String((b && b.code) || '').trim();
        if (!/^1[0-9]{10}$/.test(phone)) return { ok: false, message: '手机号格式错误（需 11 位数字）' };
        if (!/^[0-9]{4,8}$/.test(code)) return { ok: false, message: '验证码格式错误（需 4-8 位数字）' };
        // 复用 smsSend 建立的会话（actionType/指纹），与 App 内路径行为一致
        const sess = findSmsSession(game, phone);
        const ctx = makeLoginCtx(plugin, game);
        if (sess && sess.actionType) ctx.actionType = sess.actionType;
        if (sess && sess.fp) ctx.fp = sess.fp;
        const cred = await LOGIN_KIND.sms.login(plugin, ctx, { mobile: phone, code });
        const account = await finishLogin(game, cred, credentialNickname(plugin, cred, phone));
        notifyGuiSuccess(game, account, 'sms');
        return { ok: true, account: guiAccountSummary(account), tip: '短信登录成功！账号已加入「游戏社区签到助手」。' };
      },
      paste: async (b) => {
        const raw = String((b && b.token) || '').trim();
        if (!raw) return { ok: false, message: 'token 为空' };
        const ctx = makeLoginCtx(plugin, game);
        const cred = await LOGIN_KIND.paste.login(plugin, ctx, { raw });
        const account = await finishLogin(game, cred, credentialNickname(plugin, cred, ''));
        notifyGuiSuccess(game, account, 'paste');
        return { ok: true, account: guiAccountSummary(account), tip: '粘贴登录成功！账号已加入「游戏社区签到助手」；注意粘贴登录无法自动续期，token 失效需重新粘贴。' };
      },
    },
  });
  server.on('closed', () => {
    if (state.guiServers.get(game) === server) state.guiServers.delete(game);
  });
  await server.open();
  state.guiServers.set(game, server);
  if (state.services) state.services.push('🌐 已启动 ' + guiGameDesc(game, plugin) + ' 浏览器登录界面：' + server.url);
  return server;
}

async function handleGuiOpen({ game }) {
  const plugin = getGameRegistry() && getGameRegistry().get(game);
  if (!plugin) return { ok: false, error: '未知游戏' };
  const method = getLoginMethod(plugin, 'gui');
  if (!method) return { ok: false, error: '该游戏不支持浏览器登录' };
  try {
    const server = await startGuiServer(game, plugin);
    server.openCount = (server.openCount || 0) + 1;
    if (!server.browserOpened) {
      server.browserOpened = true;
      // 用系统默认浏览器打开本地登录页面
      await shell.openExternal(server.url);
      if (state.services) state.services.push('🌐 已用默认浏览器打开 ' + guiGameDesc(game, plugin) + ' 登录界面（也可在弹窗内点「重新打开浏览器登录」）');
    }
    return { ok: true, url: server.url };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function handleGuiClose({ game }) {
  const server = state.guiServers.get(game);
  if (server) {
    state.guiServers.delete(game);
    server.close();
    if (state.services) state.services.push('🔌 已关闭 ' + guiGameDesc(game, getGameRegistry() && getGameRegistry().get(game)) + ' 浏览器登录界面');
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// IPC 注册
// ---------------------------------------------------------------------------
function registerIpc() {
  const svc = () => state.services;

  // 设置
  ipcMain.handle('settings:load', () => {
    const s = svc().storage.loadSettings();
    // 通知密钥掩码下发（界面不显明文）
    const masked = JSON.parse(JSON.stringify(s));
    const cfg = masked.notify || {};
    const configured = {};
    for (const [k, v] of Object.entries(cfg)) {
      const keyField = storageMod.NOTIFY_SECRET_FIELDS[k];
      if (v && v[keyField]) {
        configured[k] = true;
        v[keyField] = MASK;
      } else {
        configured[k] = false;
      }
    }
    return { ok: true, settings: masked, notifyConfigured: configured, encryption: svc().storage.getEncryptionState() };
  });

  ipcMain.handle('settings:save', async (_e, payload) => {
    try {
      const incoming = payload && payload.settings;
      if (!incoming || typeof incoming !== 'object') return { ok: false, error: '参数错误' };
      const old = svc().storage.loadSettings();
      const next = JSON.parse(JSON.stringify(old));

      // 时间校验
      if (incoming.defaultTime !== undefined) {
        const t = validHHmm(incoming.defaultTime);
        if (!t) return { ok: false, error: '默认签到时间格式不正确（应为 HH:mm）' };
        next.defaultTime = t;
      }
      for (const g of Object.keys(incoming.games || {})) {
        const gs = incoming.games[g];
        if (!gs) continue;
        if (!next.games[g]) next.games[g] = {};
        if (typeof gs.enabled === 'boolean') next.games[g].enabled = gs.enabled;
        if (gs.time !== undefined && gs.time !== '') {
          const t = validHHmm(gs.time);
          if (!t) return { ok: false, error: gameName(g) + ' 签到时间格式不正确（应为 HH:mm）' };
          next.games[g].time = t;
        } else if (gs.time === '') {
          // 清空 = 该游戏跟随全局统一时间
          delete next.games[g].time;
        }
      }
      // 通知：掩码值不覆盖真实值
      const incNotify = incoming.notify || {};
      for (const [k, v] of Object.entries(incNotify)) {
        if (!v || typeof v !== 'object') continue;
        if (!next.notify[k]) next.notify[k] = {};
        const field = storageMod.NOTIFY_SECRET_FIELDS[k];
        if (v[field] != null && v[field] !== MASK) next.notify[k][field] = String(v[field]).trim();
        if (k === 'email') {
          // t15：邮箱非密钥字段（pass 已由上面 field 逻辑掩码处理）
          if (!next.notify.email) next.notify.email = {};
          for (const fk of ['smtpHost', 'smtpPort', 'user', 'to']) {
            if (v[fk] !== undefined) next.notify.email[fk] = String(v[fk]).trim();
          }
        }
        if (v.template !== undefined && k === 'pushplus') next.notify[k].template = v.template;
        if (k === 'qqbot' && v.appId !== undefined) {
          // AppID 为普通字段直接保存；appSecret 走上方法通用掩码逻辑；openid 由绑定流程写入，忽略表单值
          if (!next.notify.qqbot) next.notify.qqbot = {};
          next.notify.qqbot.appId = String(v.appId).trim();
        }
      }
      if (typeof incoming.autoStart === 'boolean') next.autoStart = incoming.autoStart;
      if (typeof incoming.useSystemTask === 'boolean') next.useSystemTask = incoming.useSystemTask;
      // t13：关闭窗口行为二选一（tray=隐藏到托盘 / exit=直接退出）
      if (incoming.closeBehavior !== undefined) {
        if (incoming.closeBehavior !== 'tray' && incoming.closeBehavior !== 'exit') {
          return { ok: false, error: 'closeBehavior 仅支持 tray（隐藏到托盘）或 exit（直接退出）' };
        }
        next.closeBehavior = incoming.closeBehavior;
      }

      // 全局统一时间必须最晚（兜底成立的前提）——任何游戏/账号时间不得晚于全局
      // 磁盘存量脏数据（手工改文件等产生）走「自动钳制 + 提示」，不永久阻塞一切保存——
      // 原实现一旦存在脏账号时间，任意 settings:save（含开关切换）都被拦截且无自愈路径
      {
        const dt = validHHmm(next.defaultTime);
        const late = [];
        if (dt) {
          for (const g of Object.keys(next.games)) {
            const t = validHHmm(next.games[g] && next.games[g].time);
            if (t && t > dt) { next.games[g].time = dt; late.push(gameName(g) + ' ' + t); }
          }
          const accs = svc().storage.loadAccounts();
          let accChanged = false;
          for (const a of accs) {
            const t = validHHmm(a.time);
            if (t && t > dt) { a.time = dt; accChanged = true; late.push((a.nickname || a.id) + ' ' + t); }
          }
          if (accChanged) svc().storage.saveAccounts(accs);   // 持久化钳制结果（自愈）
        }
        if (late.length) {
          svc().push('🕐 已自动把晚于全局统一时间（' + next.defaultTime + '）的签到时间钳制为全局：' + late.join('、'));
        }
      }

      svc().storage.saveSettings(next);
      svc().push('⚙️ 设置已保存（默认时间 ' + next.defaultTime + '，系统任务 ' + (next.useSystemTask ? '开启' : '关闭') + '，关闭窗口：' + (next.closeBehavior === 'exit' ? '直接退出' : '隐藏到托盘') + '）');
      if (incoming.closeBehavior !== undefined && incoming.closeBehavior !== old.closeBehavior) {
        // t13：关闭行为变更说明（与定时方式联动提示）
        // exit 文案按系统任务开关分支——未开启时如实说明「退出后到点不会自动拉起」，
        // 原文案无条件宣称由系统计划任务兜底，与事实相反（useSystemTask 默认 false）
        svc().push(incoming.closeBehavior === 'exit'
          ? (next.useSystemTask
              ? '🚪 关闭窗口行为已设为「直接退出」：点 X 会真正退出应用、不再后台常驻（到点由系统计划任务按全局统一时间拉起补签；游戏/账号时间需软件挂着才准点）'
              : '🚪 关闭窗口行为已设为「直接退出」：点 X 会真正退出应用、不再后台常驻（⚠️ 当前未开启系统计划任务，退出后到点不会自动拉起签到，需下次启动应用/开机自启时才补跑；建议开启系统计划任务兜底）')
          : '🚪 关闭窗口行为已设为「隐藏到托盘」：点 X 会后台常驻并继续自动签到（托盘可恢复界面）');
      }
      if (typeof incoming.useSystemTask === 'boolean') {
        // t5：定时方式二选一说明（系统计划任务即使应用未启动也能跑）
        svc().push(incoming.useSystemTask
          ? '🗓️ 系统计划任务已开启：按全局统一时间创建「签到助手-全局」任务——应用未运行时到点自动拉起补签；游戏/账号时间需软件后台运行（托盘常驻）才准点'
          : '🗓️ 系统计划任务已关闭：仅内置定时器在应用运行/托盘常驻时触发；全局统一时间是兜底，开启系统任务后应用未启动也能补签');
      }

      // 开机自启
      if (typeof incoming.autoStart === 'boolean') applyAutostart(incoming.autoStart);
      // 调度重排（改时间立即生效）+ 补跑检查
      svc().scheduler.reschedule();
      catchUpSafe();
      // 系统任务同步（改时间自动重写）
      let taskSync = null;
      if (next.useSystemTask) {
        taskSync = await syncSystemTasks(next, false);
        if (!taskSync.ok) svc().push('⚠️ 系统任务同步失败：' + taskSync.detail);
      } else {
        // 关闭开关：删除本应用全部任务
        taskSync = await syncSystemTasks(Object.assign({}, next, { useSystemTask: false }), false);
      }
      if (state.tray) state.tray.setContextMenu(buildTrayMenu());
      return { ok: true, taskSync: taskSync ? { ok: taskSync.ok, detail: taskSync.detail } : null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 游戏元数据（t4/t5 注册表驱动 + 含 loadErrors；t10 每次 reload 反射新增/删除；loginMethods 剔除函数回调供 IPC 序列化）
  ipcMain.handle('games:list', () => {
    const reg = getGameRegistry();
    if (reg) reg.loadAll();
    return {
      ok: true,
      games: ipcSafeGames(reg ? reg.list() : []),
      loadErrors: reg ? reg.getLoadErrors() : [],
    };
  });

  // 账号
  ipcMain.handle('accounts:list', () => ({
    ok: true,
    accounts: svc().storage.loadAccounts().map(accountSummary),
  }));

  ipcMain.handle('accounts:remove', (_e, { id } = {}) => {
    if (!id || typeof id !== 'string') return { ok: false, error: '参数错误' };
    svc().storage.removeAccount(id);
    send('event:accounts', { reason: 'removed' });
    return { ok: true };
  });

  ipcMain.handle('accounts:setEnabled', (_e, { id, enabled } = {}) => {
    if (!id || typeof enabled !== 'boolean') return { ok: false, error: '参数错误' };
    const list = svc().storage.loadAccounts();
    const acc = list.find(a => a.id === id);
    if (!acc) return { ok: false, error: '账号不存在' };
    svc().storage.upsertAccount(Object.assign({}, acc, { enabled }));
    rescheduleSafe();   // 启用/禁用立即生效
    catchUpSafe();      // 重新启用且生效时间已过时当天立即补签
    send('event:accounts', { reason: 'updated' });
    return { ok: true };
  });

  // 账号自定义签到时间：'' 或空=清除（跟随游戏/全局）；非空须 ≤ 全局统一时间
  ipcMain.handle('accounts:setTime', (_e, { id, time } = {}) => {
    if (!id || typeof id !== 'string') return { ok: false, error: '参数错误' };
    const s = svc().storage.loadSettings();
    let t = '';
    if (time !== '' && time != null) {
      t = validHHmm(time);
      if (!t) return { ok: false, error: '时间格式不正确（应为 HH:mm）' };
      if (t > s.defaultTime) return { ok: false, error: '账号时间不能晚于全局统一时间（' + s.defaultTime + '），否则应用未后台运行时无法兜底补签' };
    }
    const list = svc().storage.loadAccounts();
    const acc = list.find(a => a.id === id);
    if (!acc) return { ok: false, error: '账号不存在' };
    const updated = Object.assign({}, acc);
    if (t) updated.time = t; else delete updated.time;
    svc().storage.upsertAccount(updated);
    rescheduleSafe();   // 改期立即生效（原缺陷：要等下个自然触发点/catchUp 兜底，时间偏晚）
    catchUpSafe();      // 改成已过时刻时当天立即补签，而非等到明天
    send('event:accounts', { reason: 'updated' });
    svc().push('🕐 账号签到时间' + (t ? '设为 ' + t : '改为跟随游戏/全局') + '：' + (acc.nickname || id));
    return { ok: true };
  });

  // ---------- 游戏管理（t10：开通用户插件目录 / 刷新注册表 / 卸载游戏） ----------
  ipcMain.handle('games:openUserDir', async () => {
    const reg = getGameRegistry();
    if (!reg || !reg.userDir) return { ok: false, error: '用户插件目录未配置' };
    try {
      if (!fs.existsSync(reg.userDir)) fs.mkdirSync(reg.userDir, { recursive: true });
      const p = await shell.openPath(reg.userDir);
      return p ? { ok: false, error: p } : { ok: true, path: reg.userDir };
    } catch (e) {
      return { ok: false, error: e.message, path: reg.userDir };
    }
  });

  ipcMain.handle('games:reload', async () => {
    const reg = getGameRegistry();
    if (!reg) return { ok: false, error: '注册表未就绪' };
    reg.loadAll();
    await cleanupDisappearedGames();   // 插件契约：直接删目录 → 自动清理孤儿账号/设置/会话/系统任务
    const games = ipcSafeGames(reg.list());
    const loadErrors = reg.getLoadErrors();
    svc().push('🔄 游戏列表已刷新');
    send('event:games', { reason: 'reloaded', games, loadErrors });
    return { ok: true, games, loadErrors, errors: loadErrors };
  });

  /** 导入脚本插件：优先用传入 dir（一键安装），无 dir 时弹文件夹选择框（手动兜底）。复制到用户插件目录 → 校验 → 即时生效 */
  ipcMain.handle('games:add', async (_e, { dir } = {}) => {
    const reg = getGameRegistry();
    if (!reg || !reg.userDir) return { ok: false, error: '用户插件目录未配置' };
    let src = dir;
    if (!src) {
      let res;
      try {
        res = await dialog.showOpenDialog({
          title: '选择要导入的脚本插件目录（含 index.js）',
          properties: ['openDirectory'],
        });
      } catch (e) {
        return { ok: false, error: '打开目录选择框失败：' + (e.message || e) };
      }
      if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
      src = res.filePaths[0];
    }
    const entry = path.join(src, 'index.js');
    if (!fs.existsSync(entry)) return { ok: false, error: '所选目录下未找到 index.js（插件须为「目录/index.js」结构，如 脚本/鸣潮/index.js）' };
    let id = '';
    try {
      gameRegistryMod.clearModuleCache(entry);
      const mod = require(entry);
      id = String(mod && mod.id || '');
    } catch (e) {
      return { ok: false, error: '插件加载失败：' + (e.message || e) };
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) return { ok: false, error: '插件 id 非法（须小写/数字开头、仅 a-z0-9_-、长度 1-32）：' + id };
    const dirName = path.basename(src);   // 保留源目录名（可为中文，如「鸣潮」）
    // 若同 id 已存在（可能旧目录名不同），先删旧目录避免 id 冲突残留
    const existing = reg.get(id);
    if (existing && existing.file) {
      const oldDir = path.dirname(existing.file);
      if (oldDir !== path.join(reg.userDir, dirName)) {
        try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      }
    }
    const dest = path.join(reg.userDir, dirName);
    const samePath = path.resolve(src) === path.resolve(dest);   // 源即目标（在插件目录内选已有插件重新导入）
    try {
      if (!samePath) {
        if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });   // 覆盖导入
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(src, dest, { recursive: true });
      }
    } catch (e) {
      return { ok: false, error: '复制插件失败：' + (e.message || e) };
    }
    reg.loadAll();
    const plugin = reg.get(id);
    if (!plugin) {
      if (!samePath) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) { /* 回滚失败不阻断 */ } }   // 源即目标时不得删用户目录
      const errs = reg.getLoadErrors().filter(e => e.idHint === dirName).map(e => (e.errors || []).join('；')).join('；');
      return { ok: false, error: '插件校验失败：' + (errs || '未知错误') };
    }
    await cleanupDisappearedGames();
    svc().push('📥 已导入游戏脚本：' + (plugin.name || id));
    send('event:games', { reason: 'added', gameId: id });
    return { ok: true, gameId: id, game: ipcSafeGame(plugin) };
  });

  /** 卸载用户插件（插件契约清理链：注册表侧 onRemove 钩子+删目录 → cleanupGameData 删账号/设置/会话/系统任务） */
  ipcMain.handle('games:remove', async (_e, { gameId } = {}) => {
    const reg = getGameRegistry();
    if (!reg || !gameId) return { ok: false, error: '参数错误' };
    const plugin = reg.get(gameId);
    if (!plugin) return { ok: false, error: '未安装或未加载该游戏' };
    if (plugin.source !== 'user') return { ok: false, error: '内置游戏不可通过界面删除（请更新安装包）' };
    try {
      // 注册表侧统一执行 onRemove 钩子（仅一次）并删插件目录，随后清理账号/设置/会话/系统任务
      const rr = await reg.removePlugin(gameId);
      const cleaned = await cleanupGameData(gameId);
      svc().push('🗑️ 已卸载 ' + (plugin.name || gameId) + '（账号 ' + cleaned.removedAccounts + ' 个、设置已清理）');
      send('event:accounts', { reason: 'updated' });
      send('event:games', { reason: 'removed', gameId, removedAccounts: cleaned.removedAccounts });
      return { ok: true, gameId, hook: rr.hook, removedAccounts: cleaned.removedAccounts, dirRemoved: rr.dirRemoved, note: rr.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 登录
  ipcMain.handle('login:sendSms', (_e, p) => handleSendSms(p || {}));
  ipcMain.handle('login:sms', (_e, p) => handleSmsLogin(p || {}));
  ipcMain.handle('login:webOpen', (_e, p) => handleWebOpen(p || {}));
  ipcMain.handle('login:webCancel', (_e, p) => handleWebCancel(p || {}));
  ipcMain.handle('login:guiOpen', (_e, p) => handleGuiOpen(p || {}));   // t17：浏览器登录界面
  ipcMain.handle('login:guiClose', (_e, p) => handleGuiClose(p || {}));
  ipcMain.handle('login:paste', (_e, p) => handlePaste(p || {}));

  // 执行
  ipcMain.handle('run:account', async (_e, { id } = {}) => {
    const acc = svc().storage.loadAccounts().find(a => a.id === id);
    if (!acc) return { ok: false, error: '账号不存在' };
    svc().push('🖱️ 手动签到：' + (acc.nickname || acc.id));
    try {
      const result = await svc().runner.runAccount(acc);
      // t5 日志补强：手动签到结果以「成功/失败」明示（日志页实时可见）
      svc().push('🧾 手动签到结果：' + (result.ok ? '✅ 成功' : '❌ 失败') + ' — ' + (result.title || '') + (result.reward ? '（' + result.reward + '）' : ''));
      return { ok: true, result, summary: result.title || '' };
    } catch (e) {
      svc().push('❌ 手动签到异常：' + (e.message || e));
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('run:game', async (_e, { gameId } = {}) => {
    if (!(getGameRegistry() && getGameRegistry().has(gameId))) return { ok: false, error: '未知游戏' };
    const summary = await svc().runner.runGame(gameId, { reason: 'manual' });
    return { ok: true, summary };
  });
  ipcMain.handle('run:all', async () => {
    const out = await svc().runner.runAll();
    return { ok: true, summary: out };
  });

  // 日志 / 结果
  ipcMain.handle('logs:recent', (_e, { n } = {}) => ({
    ok: true,
    logs: svc().logger.recent(Math.min(500, Math.max(1, n || 100))),
  }));
  ipcMain.handle('results:today', () => ({
    ok: true,
    results: svc().logger.loadTodayResults(),
  }));
  ipcMain.handle('results:history', (_e, { date } = {}) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, error: '日期格式不正确' };
    try {
      const f = path.join(svc().dataDir, 'logs', date + '.json');
      return { ok: true, results: JSON.parse(fs.readFileSync(f, 'utf8')) };
    } catch (e) {
      return { ok: true, results: {} };
    }
  });

  // 签到日历：某月按游戏逐日结果状态 {games: { [gameId]: { 'YYYY-MM-DD': {status,total,ok,fail,hasData} } }}
  ipcMain.handle('calendar:month', (_e, { year, month } = {}) => {
    year = parseInt(year, 10); month = parseInt(month, 10);
    if (!Number.isInteger(year) || year < 1970 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
      return { ok: false, error: '参数错误' };
    }
    const raw = svc().logger.monthResults(year, month);
    const games = {};
    for (const [gameId, days] of Object.entries(raw)) {
      games[gameId] = {};
      for (const [ds, list] of Object.entries(days)) {
        games[gameId][ds] = Object.assign({ hasData: true }, loggerMod.summarizeDay(list));
      }
    }
    return { ok: true, year, month, games };
  });

  // 通知测试
  ipcMain.handle('notify:test', async (_e, { channel, cfg } = {}) => {
    const channels = ['serverchan', 'pushplus', 'wecom', 'email', 'qqbot'];
    if (!channels.includes(channel)) return { ok: false, error: '未知渠道' };
    // QQ 机器人测试——需已绑定 openid；AppSecret 掩码未改动时用已存值
    if (channel === 'qqbot') {
      const savedQ = svc().storage.loadSettings().notify.qqbot || {};
      const appId = (cfg && cfg.appId != null ? String(cfg.appId).trim() : '') || savedQ.appId || '';
      const appSecret = (cfg && cfg.appSecret && cfg.appSecret !== MASK) ? String(cfg.appSecret).trim() : savedQ.appSecret;
      if (!appId || !appSecret) return { ok: false, error: '未配置 AppID/AppSecret' };
      if (!savedQ.openid) return { ok: false, error: '尚未绑定：请先点「开始绑定」，并在 QQ 里给机器人发一条消息' };
      const r = await svc().qqbot.sendText({ appId, appSecret, openid: savedQ.openid },
        APP_NAME + ' 测试消息', '收到这条消息说明 QQ 机器人通知已配置成功 ✅');
      return r.ok ? { ok: true, detail: '发送成功' } : { ok: false, detail: r.error, error: r.error };
    }
    const saved = svc().storage.loadSettings().notify[channel] || {};
    const field = storageMod.NOTIFY_SECRET_FIELDS[channel];
    const value = cfg && cfg[field] && cfg[field] !== MASK ? String(cfg[field]).trim() : saved[field];
    if (!value) return { ok: false, error: '未配置 ' + ({ serverchan: 'SendKey', pushplus: 'Token', wecom: 'Webhook', email: '邮箱授权码/密码' })[channel] };
    const single = {};
    single[channel] = Object.assign({}, saved, { [field]: value });
    if (channel === 'email' && cfg && typeof cfg === 'object') {
      // t15：测试用当前表单的非密钥字段（host/port/user/to）
      for (const fk of ['smtpHost', 'smtpPort', 'user', 'to']) {
        if (cfg[fk] !== undefined) single.email[fk] = String(cfg[fk]).trim();
      }
    }
    const lines = [];
    try {
      const sent = await notifyMod.notify(single, APP_NAME + ' 测试通知', '这是一条测试消息，收到即表示配置正确。', (m) => lines.push(m));
      const detail = sent > 0 ? '发送成功' : (lines.join('；') || '发送失败');
      return { ok: sent > 0, detail, error: sent > 0 ? '' : detail };
    } catch (e) {
      return { ok: false, detail: e.message, error: e.message };
    }
  });

  // QQ 机器人绑定：临时 WebSocket 收一条用户消息取身份（openid）
  ipcMain.handle('qqbot:bind:start', () => {
    const cfg = svc().storage.loadSettings().notify.qqbot || {};
    if (!cfg.appId || !cfg.appSecret) return { ok: false, error: '请先填写并保存 AppID 与 AppSecret' };
    const r = svc().qqbot.startBind(cfg, (openid) => {
      try {
        const s = svc().storage.loadSettings();
        s.notify.qqbot = Object.assign({}, s.notify.qqbot, { openid });
        svc().storage.saveSettings(s);
        svc().push('🤖 QQ 机器人绑定成功（身份尾号 ' + String(openid).slice(-6) + '）');
      } catch (e) { log('QQ 绑定结果保存失败：' + (e.message || e)); }
    });
    if (r.ok) svc().push('🤖 开始绑定：请在 3 分钟内在 QQ 里给机器人发送绑定码 ' + (r.code || '') + '（软件界面已显示）');
    return r;
  });

  ipcMain.handle('qqbot:status', () => {
    const st = svc().qqbot.getBindState();
    const s = svc().storage.loadSettings();
    const cfg = s.notify.qqbot || {};
    const rs = state.qqReportState || loadQqReportState();
    const sp = qqbotMod.reportSendTime(s.defaultTime, new Date());
    return {
      ok: true,
      bind: { status: st.status, error: st.error, openid: st.openid || cfg.openid || '', code: st.code || '' },
      report: { lastDate: rs.lastDate || '', lastError: rs.lastError || '', sendTime: sp ? { hh: sp.hh, mm: sp.mm } : null },
    };
  });

  ipcMain.handle('qqbot:bind:cancel', () => { svc().qqbot.stopBind(); return { ok: true }; });

  // 系统
  ipcMain.handle('system:autostart:get', () => {
    try {
      const s = app.getLoginItemSettings();
      return { ok: true, enabled: !!s.openAtLogin };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('system:autostart:set', async (_e, { enabled } = {}) => {
    if (typeof enabled !== 'boolean') return { ok: false, error: '参数错误' };
    const r = applyAutostart(enabled);
    const s = svc().storage.loadSettings();
    s.autoStart = enabled;
    svc().storage.saveSettings(s);
    return Object.assign({ enabled }, r);
  });

  ipcMain.handle('system:task:status', async () => {
    const tasks = await queryAllAppTasks();
    const settings = svc().storage.loadSettings();
    const want = plannedTasks(settings);
    return { ok: true, tasks: tasks.map(t => {
      const w = want.find(x => x.name === t.name);
      return { name: t.name, time: t.time, status: t.status, synced: !!w };
    }) };
  });

  ipcMain.handle('system:task:sync', async (_e, { dryRun } = {}) => {
    const settings = svc().storage.loadSettings();
    return syncSystemTasks(settings, dryRun === true);
  });

  // 调度信息（t5：定时方式二选一说明——框架内置定时器 vs 系统计划任务）
  ipcMain.handle('scheduler:info', () => {
    try {
      const s = svc().storage.loadSettings();
      const nextRun = svc().scheduler.nextRunInfo();
      return {
        ok: true,
        nextRun,
        mode: s.useSystemTask ? 'framework+system' : 'framework',
        systemTaskOn: !!s.useSystemTask,
        explain: '内置定时器：应用运行/托盘常驻时按各账号生效时间到点自动签到；系统计划任务（全局统一时间兜底）：' +
          (s.useSystemTask
            ? '已开启——应用未运行时，到全局统一时间由「签到助手-全局」任务拉起补签（单实例防重复）'
            : '未开启——到「账号管理」的系统设置开启后，应用未启动也能按全局统一时间兜底补签'),
      };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // 应用
  ipcMain.handle('app:info', () => {
    let buildTime = '';
    try {
      const bi = JSON.parse(fs.readFileSync(path.join(__dirname, 'core', 'build-info.json'), 'utf8'));
      buildTime = bi.buildTime ? bi.buildTime : '';
    } catch (e) { /* 开发模式无此文件，忽略 */ }
    return {
      ok: true,
      info: {
        version: app.getVersion(),
        dataDir: svc().dataDir,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        packaged: app.isPackaged,
        rendererMode: state.rendererMode ? state.rendererMode : 'unknown',
        encryption: svc().storage.getEncryptionState(),
        buildTime,
      },
    };
  });
  ipcMain.handle('app:quit', () => {
    state.quitting = true;
    if (state.services) state.services.scheduler.stop();
    app.quit();
    return { ok: true };
  });
}

// 自测/任务测试已抽离至 scripts/selftest.js（仅 --selftest / --task-test 时按需加载）

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------
// 单实例锁：Windows 下基于命名管道；受限环境（沙箱）禁止创建 → 自测模式跳过
// （生产环境正常运行；锁失败时也允许继续，避免环境差异导致无法启动）
let shouldQuit = false;
if (!(ARGS.selftest || ARGS.taskTest)) {
  try {
    shouldQuit = !app.requestSingleInstanceLock();
  } catch (e) {
    log('单实例锁不可用（' + e.message + '），继续启动');
  }
}

if (shouldQuit) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // 定时任务（schtasks /TR 自带 --hidden）在应用已运行时只会「后台唤起」已有实例做签到，
    // 不应弹出/抢占主窗口（尤其关闭行为=隐藏到托盘时，凌晨 5-6 点不应弹窗打扰）。
    // 只有用户手动启动（argv 无 --hidden）才弹出主界面。
    if ((argv || []).indexOf('--hidden') >= 0) return;
    showMainWindow();
  });

  app.disableHardwareAcceleration();

  // 自测模式：受限环境（沙箱/CI）下 Chromium 无法创建命名管道 → 单进程模式 + 独立 userData
  if (ARGS.selftest || ARGS.taskTest) {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('single-process');
    app.commandLine.appendSwitch('disable-gpu');
    app.setPath('userData', path.join(require('os').tmpdir(), 'signin-app-el-profile'));
  }

  app.whenReady().then(async () => {
    // 自测/任务测试：隔离数据目录与插件目录，避免触碰真实账号与「脚本」目录
    if (ARGS.selftest || ARGS.taskTest) {
      if (!ARGS.dataDir) ARGS.dataDir = fs.mkdtempSync(path.join(process.env.TEMP, 'signin-app-test-'));
      if (!ARGS.scriptsDir) ARGS.scriptsDir = path.join(ARGS.dataDir, 'plugins');
      try { fs.mkdirSync(ARGS.scriptsDir, { recursive: true }); } catch (e) { /* 忽略 */ }
    }
    state.services = createServices();
    let selftest = null;
    if (ARGS.selftest || ARGS.taskTest) {
      // scripts/ 不进 app.asar（生产路径只能 require 会进包的文件），打包版 require 必然失败——
      // 捕获后提示「自测仅限开发目录」而非启动即崩
      try {
        selftest = require('./scripts/selftest.js')({
          state, newAccount, accountSummary, plannedTasks, syncSystemTasks,
          createOrUpdateTask, queryTask, deleteTask, resetWebLoginBound,
          autostartSettings, getGameRegistry, TASK_PREFIX, IPC_CHANNELS, browserLogin,
          appRoot: __dirname,
        });
      } catch (e) {
        log('⚠️ 自测模块不可用（打包版不含 scripts/，--selftest/--task-test 仅限开发目录）：' + e.message);
      }
    }
    state.services.push('🚀 ' + APP_NAME + ' 已启动（v' + app.getVersion() + '，数据目录：' + state.services.dataDir + '）');
    state.services.push('🔐 凭据存储：' + (state.services.crypto.available ? 'safeStorage(DPAPI) 加密' : '明文降级（已标记）'));

    if ((ARGS.selftest || ARGS.taskTest) && !selftest) {
      log('自测模块不可用，退出（如需自测请在开发目录运行）。');
      app.quit();
      return;
    }
    if (ARGS.selftest) {
      registerIpc(); // 校验全部 handler 注册无冲突
      // 沙箱环境无法渲染页面（单进程模式渲染器崩溃）→ 仅验证窗口构造与降级逻辑，不加载页面
      state.mainWindow = createMainWindow({ loadPage: false });
      setTimeout(() => selftest.runSelftest(), 1000);
      return;
    }
    if (ARGS.taskTest) {
      setTimeout(() => selftest.runTaskTest(), 1500);
      return;
    }

    state.mainWindow = createMainWindow();
    createTray();
    registerIpc();

    // 开机自启：仅打包应用按设置应用（开发模式跳过，避免污染注册表）
    if (app.isPackaged) {
      try {
        const s = state.services.storage.loadSettings();
        if (s.autoStart) applyAutostart(true);
      } catch (e) { /* ignore */ }
    }

    // 调度启动（含开机补跑）
    state.services.scheduler.start();

    // QQ 机器人日报定时检查（每分钟；含启动补发。未配置/未绑定则静默跳过）
    startQqReportTimer();

    // 系统任务同步：设置开启时启动即校准一次（幂等）
    try {
      const s = state.services.storage.loadSettings();
      if (s.useSystemTask) {
        const r = await syncSystemTasks(s, false);
        state.services.push(r.ok ? '🗓️ 系统任务已同步' : '⚠️ 系统任务同步失败：' + r.detail);
      }
    } catch (e) {
      state.services.push('⚠️ 系统任务检查异常：' + e.message);
    }

    // t5：定时方式说明（框架内置定时器 vs 系统计划任务，自由选择）+ 日志只保留最近一年
    try {
      const s = state.services.storage.loadSettings();
      state.services.push('⏱️ 定时方式：内置定时器按各账号生效时间到点签到（需应用后台运行/托盘常驻）' +
        (s.useSystemTask
          ? '；系统计划任务已开启——全局统一时间到点由「签到助手-全局」拉起补签，应用未启动也能兜底'
          : '；系统计划任务未开启——如需“应用未启动也能按全局时间兜底”，到「账号管理」系统设置开启即可'));
    } catch (e) { /* 说明日志失败不阻断 */ }
    try {
      const st = state.services.logger.retain(loggerMod.RETENTION_DAYS);
      state.services.push('🗄️ 日志维护：只保留最近 ' + loggerMod.RETENTION_DAYS + ' 天（本轮清理历史结果 ' + st.deletedResults + ' 个、轮转日志 ' + st.deletedLogs + ' 个' + (st.rotated ? '，signin.log 已轮转' : '') + '）');
    } catch (e) { /* 维护失败不阻断 */ }
    // 应用长期常驻也每日自动维护一次（不依赖下次重启才清理）
    state.dailyMaintainTimer = setInterval(() => {
      try {
        const st = state.services.logger.retain(loggerMod.RETENTION_DAYS);
        if (st.deletedResults || st.deletedLogs || st.rotated) {
          state.services.push('🗄️ 日志维护完成：清理历史结果 ' + st.deletedResults + ' 个、轮转日志 ' + st.deletedLogs + ' 个' + (st.rotated ? '，signin.log 已轮转' : '') + '（只保留最近 ' + loggerMod.RETENTION_DAYS + ' 天）');
        }
      } catch (e) { /* ignore */ }
    }, 24 * 60 * 60 * 1000);
    if (typeof state.dailyMaintainTimer.unref === 'function') { try { state.dailyMaintainTimer.unref(); } catch (e) {} }
    // 登录会话定期清理（统一 60 分钟 TTL，长期常驻不涨内存）
    state.sessionPruneTimer = setInterval(() => { try { pruneLoginSessions(); } catch (e) { /* ignore */ } }, 30 * 60 * 1000);
    if (state.sessionPruneTimer && typeof state.sessionPruneTimer.unref === 'function') { try { state.sessionPruneTimer.unref(); } catch (e) {} }

    if (state.tray) state.tray.setContextMenu(buildTrayMenu());
  });

  app.on('window-all-closed', () => {
    // 托盘常驻：注册本事件即阻止默认退出行为；真正退出走 app.quit（state.quitting=true）
    /* no-op */
  });

  app.on('before-quit', () => {
    state.quitting = true;
    if (state.dailyMaintainTimer) { clearInterval(state.dailyMaintainTimer); state.dailyMaintainTimer = null; }
    if (state.sessionPruneTimer) { clearInterval(state.sessionPruneTimer); state.sessionPruneTimer = null; }
    if (state.qqReportTimer) { clearInterval(state.qqReportTimer); state.qqReportTimer = null; }
    if (state.guiServers) { for (const s of state.guiServers.values()) { try { s.close(); } catch (e) { /* ignore */ } } state.guiServers.clear(); }
    if (state.services) state.services.scheduler.stop();
  });

  app.on('activate', () => showMainWindow());
}


