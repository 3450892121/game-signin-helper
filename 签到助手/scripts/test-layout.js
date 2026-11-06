'use strict';
/**
 * 真实 Electron 渲染回归：侧栏、窗口适配、表单、日历和弹窗。
 * 不加载 main.js，不读取真实账号，不执行社区协议或系统引用操作。
 * 可选 --screenshots 将截图与报告保存在仓库根 notes/layout/（Git 忽略）。
 * 可选 --packaged 读取本版本交付包内的 renderer，仍只使用测试桥接与虚构数据。
 */
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const ROOT = path.resolve(__dirname, '..');
const VERSION = require('../package.json').version;
const packaged = process.argv.includes('--packaged');
const rendererRoot = packaged
  ? path.resolve(ROOT, '..', '游戏社区签到助手-免安装版-v' + VERSION, '游戏社区签到助手', 'resources', 'app.asar', 'renderer')
  : path.join(ROOT, 'renderer');
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-layout-'));
const outputDir = process.argv.includes('--screenshots') ? path.resolve(ROOT, '..', 'notes', 'layout') : null;
const checks = [];
const errors = [];
const calls = [];
let fixture;
let win;

app.setPath('userData', testDataDir);
app.disableHardwareAcceleration();

const plugins = ['鸣潮', '崩铁', '异环'].map((name) => {
  const p = require(path.resolve(ROOT, '..', '脚本', name, 'index.js'));
  return JSON.parse(JSON.stringify({
    id: p.id, name: p.name, community: p.community, icon: p.icon,
    loginMethods: p.loginMethods, source: 'user', meta: p.meta || {},
  }));
});

function makeFixture(mode = 'normal') {
  const games = mode === 'empty' ? [] : JSON.parse(JSON.stringify(plugins));
  if (mode === 'long') games[0].name = '第三方社区插件'.repeat(12) + 'LongName'.repeat(12);
  const settings = {
    defaultTime: '23:30', autoStart: false, useSystemTask: false, closeBehavior: 'tray',
    games: Object.fromEntries(games.map((g) => [g.id, { enabled: true, time: '' }])),
    notify: {
      serverchan: { sendKey: '****demo' }, pushplus: { token: '****demo', template: 'html' },
      wecom: { webhook: '****demo' }, email: { pass: '****demo' },
      qqbot: { appId: '', appSecret: '****demo' },
    },
  };
  const accounts = mode === 'no-accounts' ? [] : games.flatMap((g, gi) => [0, 1].map((n) => ({
    id: g.id + '-demo-' + n, game: g.id, enabled: n === 0, time: n ? '09:30' : '',
    nickname: mode === 'long' && !gi && !n ? '很长的虚构测试昵称'.repeat(12) + 'UnbrokenName'.repeat(12) : ['旅行中的小鱼', '周末的星光'][n],
    lastResult: n ? { ok: false, title: '登录已过期，请重新绑定', date: '示例日期' } : {
      ok: true, title: mode === 'long' ? '签到完成'.repeat(36) : '签到成功',
      reward: '社区积分 ×30', date: '示例日期',
    },
  })));
  return { games, settings, accounts, mode };
}

function reply(channel, payload) {
  calls.push({ channel, payload });
  switch (channel) {
    case 'games:list': return { ok: true, games: fixture.games, loadErrors: [] };
    case 'accounts:list': return { ok: true, accounts: fixture.accounts };
    case 'settings:load': return { ok: true, settings: fixture.settings };
    case 'settings:save': return { ok: true, taskSync: { ok: true } };
    case 'app:info': return { ok: true, info: {
      version: VERSION, dataDir: '<隔离测试数据>',
      encryption: { mode: fixture.mode === 'plain' ? 'plain' : 'encrypted', hasPlainFlag: fixture.mode === 'plain' },
    } };
    case 'system:autostart:get': return { ok: true, enabled: false };
    case 'system:task:status': return { ok: true, tasks: [] };
    case 'qqbot:status': return { ok: true, bind: { status: 'idle' }, report: { sendTime: { hh: 23, mm: 59 } } };
    case 'logs:recent': return { ok: true, logs: [] };
    case 'results:history': {
      const result = { ok: true, results: fixture.mode === 'no-records' ? {} : Object.fromEntries(fixture.games.map((g) => [g.id,
        fixture.accounts.filter((a) => a.game === g.id).map((a) => ({ ...a.lastResult, nickname: a.nickname })),
      ])) };
      return fixture.mode === 'race' && payload.date.endsWith('-01') ? new Promise((resolve) => setTimeout(() => resolve(result), 200)) : result;
    }
    case 'calendar:month': {
      if (fixture.mode === 'calendar-error') return { ok: false, error: '模拟记录读取失败' };
      if (fixture.mode === 'no-records') return { ok: true, games: {} };
      const pad = (n) => String(n).padStart(2, '0');
      const data = {};
      for (let d = 1; d <= 31; d++) data[payload.year + '-' + pad(payload.month) + '-' + pad(d)] = {
        status: d % 3 ? 'ok' : 'fail', rewards: d % 3 ? ['社区积分 ×30', 'DSD扭蛋机抽奖券 ×1'] : [],
      };
      return { ok: true, games: Object.fromEntries(fixture.games.map((g) => [g.id, data])) };
    }
    // 关闭登录弹窗会关闭临时 GUI 会话；这里只返回，不启动或关闭任何真实服务。
    case 'login:guiClose': return { ok: true };
    default: throw new Error('布局测试出现未预期调用：' + channel);
  }
}

function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail ? ' ' + JSON.stringify(detail) : ''));
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');

async function waitFor(fn) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (await evaluate(fn)) return;
    await delay(40);
  }
  throw new Error('等待页面超时：' + fn.toString());
}

async function load(mode = 'normal') {
  fixture = makeFixture(mode);
  await win.loadFile(path.join(rendererRoot, 'index.html'));
  await waitFor(() => document.querySelector('#app-version').textContent.length > 0);
  await evaluate(() => document.fonts.ready.then(() => true));
  await delay(80);
}

async function click(selector) {
  await evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) throw new Error('未找到：' + s);
    el.click();
  }, selector);
  await delay(80);
}

async function capture(name) {
  if (!outputDir) return;
  await delay(200);
  // 隐藏窗口的 capturePage 可能取到上一帧。离屏模式下显式请求重绘，
  // 直接保存这次 paint 的完整位图，截图与刚检查的 DOM 保持一致。
  const bitmap = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { win.webContents.removeListener('paint', painted); reject(new Error('等待截图重绘超时')); }, 4000);
    const painted = (_event, _dirty, image) => { clearTimeout(timeout); resolve(image); };
    win.webContents.once('paint', painted);
    win.webContents.invalidate();
  });
  fs.writeFileSync(path.join(outputDir, name + '.png'), bitmap.toPNG());
}

async function geometry(name) {
  const result = await evaluate(() => {
    const main = document.querySelector('#main');
    const page = document.querySelector('.page.active');
    const bounds = main.getBoundingClientRect();
    const problems = [];
    const nodes = [page, ...page.querySelectorAll('button, input, select, textarea, .game-title, .account-nickname, .account-last, .form-row, .channel-row, .cal-grid, .cal-celltop')];
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.left < bounds.left - 1 || r.right > bounds.right + 1) problems.push(el.id || el.className);
      if (el.matches('.form-row, .channel-row, .cal-grid, .cal-celltop') && el.scrollWidth > el.clientWidth + 1) problems.push('内部溢出:' + el.className);
    }
    const side = document.querySelector('.sidebar').getBoundingClientRect();
    const top = document.querySelector('.topbar').getBoundingClientRect();
    const run = document.querySelector('#btn-run-all').getBoundingClientRect();
    const next = document.querySelector('#next-trigger').getBoundingClientRect();
    return {
      problems, documentOverflow: document.documentElement.scrollWidth > innerWidth,
      documentVerticalOverflow: document.documentElement.scrollHeight > innerHeight + 1,
      mainOverflow: main.scrollWidth > main.clientWidth + 1,
      regionsFit: side.right <= top.left + 1 && top.bottom <= bounds.top + 1 && next.right <= run.left,
    };
  });
  check(name + ' 无溢出与区域重叠', !result.problems.length && !result.documentOverflow && !result.documentVerticalOverflow && !result.mainOverflow && result.regionsFit, result);
}

async function reachable(selector, scroll = true) {
  return evaluate((s, shouldScroll) => {
    const el = document.querySelector(s);
    if (!el) return false;
    if (shouldScroll) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return r.width > 0 && r.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && (hit === el || el.contains(hit));
  }, selector, scroll);
}

async function run() {
  if (outputDir) fs.mkdirSync(outputDir, { recursive: true });
  ipcMain.handle('layout-test:invoke', (_event, channel, payload) => reply(channel, payload));
  // 纵深隔离：即使界面误引入外部资源，也只记录并阻止请求。
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, cb) => {
    errors.push('出现外部请求：' + new URL(details.url).origin); cb({ cancel: true });
  });
  win = new BrowserWindow({
    width: 1080, height: 720, useContentSize: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'layout-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', (event, level, message) => {
    if ((event.level || level) === 'error' || level === 3) errors.push(event.message || message);
  });

  for (const [width, height, zoom] of [[1080, 720, 1], [920, 600, 1], [1440, 900, 1], [920, 600, 1.25]]) {
    win.setContentSize(width, height);
    win.webContents.setZoomFactor(zoom);
    await load();
    const label = width + 'x' + height + '-' + Math.round(zoom * 100);
    for (const page of ['accounts', 'calendar', 'notify']) {
      await click('.tab[data-page="' + page + '"]');
      if (page === 'calendar') {
        await waitFor(() => document.querySelectorAll('.cal-card').length === 1 && document.querySelector('#cal-day-detail .result-row'));
        check(label + ' 日历为单张且可切换三游戏', await evaluate(() => document.querySelectorAll('.cal-game-tab').length === 3 && document.querySelectorAll('.cal-game-tab[aria-pressed="true"]').length === 1));
        if (height >= 720 && zoom === 1) check(label + ' 整月日历首屏可见', await evaluate(() => document.querySelector('.cal-legend').getBoundingClientRect().bottom <= document.querySelector('#main').getBoundingClientRect().bottom));
      }
      check(label + ' ' + page + ' 当前页与导航一致', await evaluate((p) =>
        document.querySelectorAll('.page.active').length === 1 && document.querySelector('.page.active').id === 'page-' + p &&
        document.querySelectorAll('.tab[aria-current="page"]').length === 1 && document.querySelector('.tab[aria-current]').dataset.page === p, page));
      await geometry(label + ' ' + page);
      if (page === 'notify') check(label + ' 保存入口首屏可见', await reachable('#btn-save-notify', false));
      await evaluate(() => { document.querySelector('#main').scrollTop = 0; });
      await capture(label + '-' + page);
      const fixed = await evaluate(() => {
        const sidebar = document.querySelector('.sidebar'), topbar = document.querySelector('.topbar');
        const sideTop = sidebar.getBoundingClientRect().top, top = topbar.getBoundingClientRect().top;
        document.querySelector('#main').scrollTop = 500;
        return sidebar.getBoundingClientRect().top === sideTop && topbar.getBoundingClientRect().top === top && document.documentElement.scrollTop === 0;
      });
      check(label + ' ' + page + ' 滚动不移动导航与顶栏', fixed);
    }
  }

  win.webContents.setZoomFactor(1);
  // 再按生产窗口的外框最小值检查，包含 Windows 标题栏/边框占用。
  win.setSize(920, 600);
  await load();
  for (const page of ['accounts', 'calendar', 'notify']) {
    await click('.tab[data-page="' + page + '"]');
    await geometry('含标题栏最小窗口 ' + page);
  }
  win.setContentSize(920, 600);
  for (const mode of ['long', 'no-accounts', 'empty', 'plain']) {
    await load(mode);
    await geometry(mode + ' 账号页');
    if (mode === 'long') check('长昵称不截断', await evaluate(() => {
      const el = document.querySelector('.account-nickname'); return el.scrollWidth <= el.clientWidth + 1;
    }));
    if (mode === 'no-accounts') check('每个游戏有无账号提示', await evaluate(() => document.querySelectorAll('.game-card .empty-list').length === 3));
    if (mode === 'empty') {
      check('无脚本时有恢复入口', await reachable('[data-role="open-script-dir"]'));
      await click('.tab[data-page="calendar"]');
      check('无脚本日历有引导', await evaluate(() => document.querySelector('#cal-cards').textContent.includes('管理游戏脚本')));
    }
    if (mode === 'plain') check('明文与历史凭据警示保留', await evaluate(() => /明文存储/.test(document.querySelector('#footer').textContent) && /历史明文/.test(document.querySelector('#footer').textContent)));
    await capture('edge-' + mode);
    if (mode === 'long') { await click('.tab[data-page="calendar"]'); await geometry('长插件名日历'); }
  }

  await load();
  check('系统任务详情可展开', await evaluate(() => {
    const d = document.querySelector('.system-details'); d.open = true;
    return document.querySelector('#systask-status').getBoundingClientRect().height > 0;
  }));
  for (const g of plugins) {
    await click('[data-role="add-account"][data-game="' + g.id + '"]');
    for (const m of g.loginMethods) {
      await click('.method-tab[data-method="' + m.id + '"]');
      const panel = '#panel-' + m.kind;
      check(g.name + ' ' + m.label + ' 面板可见且关闭入口可达', await evaluate((s) => {
        const r = document.querySelector(s).getBoundingClientRect(); return r.width > 0 && r.height > 0;
      }, panel) && await reachable('#dlg-close'));
      const target = await evaluate((s) => document.querySelector(s + ' button').id, panel);
      check(g.name + ' ' + m.label + ' 操作按钮可达', await reachable('#' + target));
      await capture('login-' + g.id + '-' + m.kind);
    }
    await click('#dlg-close');
  }
  await click('#btn-manage-games');
  await waitFor(() => document.querySelectorAll('.manage-row').length === 3);
  check('脚本管理三个入口可达', await reachable('#manage-import') && await reachable('#manage-open-dir') && await reachable('#manage-reload'));
  await capture('manage-scripts');
  await click('#manage-close');

  await click('.tab[data-page="calendar"]');
  await waitFor(() => document.querySelectorAll('.cal-card').length === 1);
  check('默认选择今天并显示明细', await evaluate(() => document.querySelector('.cal-day[aria-current="date"]').getAttribute('aria-pressed') === 'true' && !!document.querySelector('#cal-day-detail .result-row')));
  for (const g of plugins) {
    await click('[data-cal-game="' + g.id + '"]');
    await waitFor(() => !document.querySelector('#cal-day-detail').textContent.includes('正在读取'));
    check('切换 ' + g.name + ' 同步月历与明细', await evaluate((id, name) =>
      document.querySelectorAll('.cal-card').length === 1 && document.querySelector('.cal-card').dataset.game === id &&
      document.querySelector('#cal-day-detail .cal-detail-head p').textContent === name, g.id, g.name));
  }
  check('日历奖励可见且有完整悬停提示', await evaluate(() => {
    const reward = document.querySelector('.cal-reward-text');
    return !!reward && reward.getBoundingClientRect().height > 0 && reward.closest('.cal-day').title.includes('DSD扭蛋机抽奖券');
  }));
  const initialMonth = await evaluate(() => document.querySelector('#cal-title').textContent);
  await click('#cal-prev');
  check('翻到上月', await evaluate((t) => document.querySelector('#cal-title').textContent !== t, initialMonth));
  await click('#cal-today');
  check('回到当前月', await evaluate((t) => document.querySelector('#cal-title').textContent === t, initialMonth));
  await click('.cal-day[data-clickable]');
  await waitFor(() => document.querySelector('#cal-day-detail .result-row'));
  check('日历日期明细可读', await reachable('#cal-day-detail .result-row'));
  await capture('calendar-detail');
  await click('#cal-next');
  check('未来月份不伪造可点击结果', await evaluate(() => document.querySelectorAll('.cal-day[data-clickable]').length === 0 && document.querySelector('#cal-day-detail').textContent.includes('还没开始')));
  await click('#cal-today');
  // 离屏窗口不获取桌面焦点；通过渲染器调试输入验证原生按钮的键盘默认行为。
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  await evaluate(() => document.querySelector('.cal-day[data-clickable]').focus());
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  win.webContents.debugger.detach();
  await delay(80);
  check('可用回车键选中日期', await evaluate(() => document.querySelector('.cal-day[data-clickable]').getAttribute('aria-pressed') === 'true'));

  await click('.tab[data-page="notify"]');
  for (const id of ['notify-serverchan', 'notify-pushplus', 'notify-pushplus-tpl', 'notify-wecom', 'notify-email-host', 'notify-email-port', 'notify-email-user', 'notify-email-pass', 'notify-email-to', 'notify-qqbot-appid', 'notify-qqbot-secret', 'btn-qqbot-bind']) {
    check('通知控件可达 ' + id, await reachable('#' + id));
  }
  for (const channel of ['serverchan', 'pushplus', 'wecom', 'email', 'qqbot']) check('发送测试按钮可达 ' + channel, await reachable('.btn-test[data-channel="' + channel + '"]'));
  await click('#btn-save-notify');
  const saved = calls.filter((c) => c.channel === 'settings:save').at(-1);
  assert.ok(saved, '点击保存必须实际调用桥接');
  const n = saved.payload.settings.notify;
  check('未改动的五个渠道掩码全部按 null 保留', n.serverchan.sendKey === null && n.pushplus.token === null && n.wecom.webhook === null && n.email.pass === null && n.qqbot.appSecret === null);
  await evaluate(() => { document.querySelector('#notify-serverchan').value = ''; });
  await click('#btn-save-notify');
  check('清空渠道仍发送空串', calls.filter((c) => c.channel === 'settings:save').at(-1).payload.settings.notify.serverchan.sendKey === '');

  for (const mode of ['no-records', 'calendar-error']) {
    await load(mode);
    await click('.tab[data-page="calendar"]');
    check(mode + ' 日历如实显示空记录或错误', await evaluate((m) => m === 'no-records'
      ? !!document.querySelector('.cal-nodata') && document.querySelector('#cal-day-detail').textContent.includes('还没有签到记录')
      : !document.querySelector('.cal-day[data-clickable]') && document.querySelector('#cal-cards').textContent.includes('读取失败'), mode));
    await capture('calendar-' + mode);
  }
  await load('race');
  await click('.tab[data-page="calendar"]');
  const twoDates = await evaluate(() => {
    const days = document.querySelectorAll('.cal-day[data-clickable]');
    if (days.length < 2) return false;
    days[0].click(); days[1].click(); return days[1].dataset.date;
  });
  if (twoDates) {
    await delay(300);
    check('快速切换日期不被旧响应覆盖', await evaluate((ds) => document.querySelector('#cal-day-detail h3').textContent === ds && document.querySelector('.cal-day[aria-pressed="true"]').dataset.date === ds, twoDates));
  }
  check('无界面异常和外部请求', errors.length === 0, errors);
}

app.whenReady().then(run).catch((e) => {
  check('测试正常执行', false, e.stack || String(e));
}).finally(() => {
  if (outputDir) fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify({ target: packaged ? 'packaged' : 'source', checks, errors }, null, 2));
  const failed = checks.filter((c) => !c.ok).length;
  console.log('RESULT=' + (failed ? 'fail' : 'pass') + ' checks=' + checks.length + ' failed=' + failed);
  if (win) win.destroy();
  // 仅清理本测试新建、已核对位于临时目录下的隔离目录。
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (path.resolve(testDataDir).startsWith(tempRoot) && path.basename(testDataDir).startsWith('signin-layout-')) {
    try { fs.rmSync(testDataDir, { recursive: true, force: true }); } catch (_) { /* 系统占用的缓存可稍后清理 */ }
  }
  app.exit(failed ? 1 : 0);
});
