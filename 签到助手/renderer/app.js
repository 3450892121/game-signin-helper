'use strict';
/**
 * 游戏社区签到助手 — renderer 逻辑（纯 JS，无框架）
 *
 * 与主进程通信仅通过 preload 暴露的白名单桥 window.app：
 * window.app.invoke(channel, payload) -> Promise<{ok, ...}> （通道白名单见 preload.js 的 INVOKE_CHANNELS）
 * window.app.on(event, handler) （事件白名单见 preload.js 的 EVENT_CHANNELS）
 * 两处白名单与 main.js 的 IPC_CHANNELS / EVENT_CHANNELS 由 scripts/test-consistency.js 强制三方一致，
 * 所以这里不写死数量（写死会随功能增删过时）。
 *
 * 密钥掩码约定（与主进程 settings:save / notify:test 对齐）：
 * - settings:load 返回的密钥字段为掩码串（含 ****，如 "****abcd"）或空串；
 * - 保存时：字段输入未改动 -> 发送 null（主进程保留原值）；
 * 清空 -> 发送 "" （关闭该渠道）；
 * 输入新值 -> 原样发送（覆盖）。
 * - notify:test 的 cfg 同理：未改动的密钥传 null，主进程用已存值测试。
 *
 * 安全：本文件不写日志、不打印任何手机号/验证码/凭据明文；凭据只出现在
 * 粘贴输入框（默认掩码显示），提交后立即调用 IPC，不做本地存储。
 */
(() => {
  'use strict';

  /* ==================== 桥接 ==================== */
  const bridge = window.app || null;
  const bridgeOk = !!(bridge && typeof bridge.invoke === 'function');

  function invoke(channel, payload) {
    if (!bridgeOk) {
      return Promise.resolve({ ok: false, error: '未检测到应用桥（window.app），请通过主进程启动' });
    }
    return Promise.resolve(bridge.invoke(channel, payload)).catch((err) => ({
      ok: false,
      error: (err && (err.message || String(err))) || '调用失败',
    }));
  }

  function onEvent(event, handler) {
    if (bridge && typeof bridge.on === 'function') {
      try { bridge.on(event, handler); } catch (e) { /* 忽略 */ }
    }
  }

  /* ==================== 状态 ==================== */
  const state = {
    settings: null,          // settings:load 结果
    games: [],               // games:list
    accounts: [],            // accounts:list（无凭据字段）
    taskStatus: null,        // system:task:status
    appInfo: null,           // app:info
    gameLoadErrors: [],      // games:list 的 loadErrors（被拒插件）
    manageOpen: false,       // 管理游戏脚本弹窗
    page: 'accounts',
    results: {},             // results:today
    autostart: false,
  };

  /* 登录弹窗会话状态（手机号/验证码/凭据不落盘，仅内存） */
  const dlg = {
    open: false,
    game: null,              // {id,name,community}
    methods: [],             // [{id,label,kind,disabled,hint}]
    active: null,            // 当前方法 id
    sms: { countdown: 0, timer: null, needCaptcha: false },
    web: { waiting: false },
    gui: { waiting: false, opened: false, autoOpened: false },
    paste: { value: '', shown: false },
  };

  /* ==================== 小工具 ==================== */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** ⓘ 悬浮提示：data-tip + title 兜底（键盘/无障碍） */
  function tip(text) {
    const t = String(text == null ? '' : text);
    return '<span class="tip" data-tip="' + esc(t) + '" title="' + esc(t) + '" tabindex="0">ⓘ</span>';
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /* ---------- Toast ---------- */
  function toast(msg, type) {
    const root = $('#toast-root');
    if (!root) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; }, 3400);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 3700);
  }

  /* ---------- 确认弹窗 ---------- */
  function confirmDialog(text) {
    return new Promise((resolve) => {
      const modal = $('#confirm-modal');
      $('#confirm-text').textContent = text;
      modal.classList.remove('hidden');
      const done = (v) => {
        modal.classList.add('hidden');
        $('#confirm-ok').removeEventListener('click', okH);
        $('#confirm-cancel').removeEventListener('click', cancelH);
        resolve(v);
      };
      const okH = () => done(true);
      const cancelH = () => done(false);
      $('#confirm-ok').addEventListener('click', okH);
      $('#confirm-cancel').addEventListener('click', cancelH);
    });
  }

  /* ---------- 全局忙碌 ---------- */
  function busy(on, text) {
    const b = $('#busy-overlay');
    if (!b) return;
    if (on) { $('.busy-box', b).textContent = text || '处理中…'; b.classList.remove('hidden'); }
    else b.classList.add('hidden');
  }

  /* ==================== 页面切换 ==================== */
  function switchPage(page) {
    state.page = page;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.page === page));
    $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
    if (page === 'calendar') { loadCalendarPage(); }
    if (page === 'accounts') { renderAccounts(); }
  }

  /* ==================== 初始化加载 ==================== */
  async function init() {
    if (!bridgeOk) {
      $('#bridge-warn').classList.remove('hidden');
      // 预览模式：无已安装游戏（框架不内置脚本），渲染空骨架
      state.games = [];
      state.settings = {
        defaultTime: '06:00',
        games: {},
        notify: { serverchan: { sendKey: '' }, pushplus: { token: '', template: 'html' }, wecom: { webhook: '' } },
        autoStart: true, useSystemTask: false,
      };
    } else {
      const [g, a, s, i] = await Promise.all([
        invoke('games:list'), invoke('accounts:list'), invoke('settings:load'),
        invoke('app:info'),
      ]);
      if (g.ok && Array.isArray(g.games)) state.games = g.games;
      if (g.ok && Array.isArray(g.loadErrors)) state.gameLoadErrors = g.loadErrors;
      if (a.ok && Array.isArray(a.accounts)) state.accounts = a.accounts;
      if (s.ok && s.settings) state.settings = s.settings;
      if (i.ok && i.info) state.appInfo = i.info;
      if (state.appInfo && state.appInfo.version) document.title = '游戏社区签到助手 v' + state.appInfo.version;
      const as = await invoke('system:autostart:get');
      if (as.ok && typeof as.enabled === 'boolean') state.autostart = as.enabled;
      // 系统任务状态改为后台异步查询，不阻塞启动（schtasks 查询慢/卡时不影响界面）
      invoke('system:task:status').then((t) => {
        // 无条件刷新——原条件 state.page==='schedule' 引用早已删除的页面，
        // 永假导致启动后系统任务状态框永不更新（已有任务仍显示"当前未创建"）
        if (t.ok && Array.isArray(t.tasks)) { state.taskStatus = t.tasks; renderTaskStatus(); }
      }).catch(() => {});
    }

    try { bindStaticEvents(); } catch (e) { console.error('[init] bindStaticEvents 失败：', e); }
    onEvent('event:log', handleLogEvent);
    onEvent('event:progress', handleProgressEvent);
    onEvent('event:accounts', () => { refreshAccounts(); if (state.page === 'calendar') loadCalendarPage(); });
    onEvent('event:games', async () => {
      const [g, a] = await Promise.all([invoke('games:list'), invoke('accounts:list')]);
      if (g.ok && Array.isArray(g.games)) state.games = g.games;
      if (g.ok && Array.isArray(g.loadErrors)) state.gameLoadErrors = g.loadErrors;
      if (a.ok && Array.isArray(a.accounts)) state.accounts = a.accounts;
      renderAccounts(); renderNextTrigger();
      if (state.page === 'calendar') loadCalendarPage();
    });
    onEvent('event:webLogin', handleWebLoginEvent);
    onEvent('event:guiLogin', handleGuiLoginEvent);
    onEvent('event:visibility', handleVisibilityEvent);

    renderAll();
  }

  function renderAll() {
    [renderHeader, renderAccounts, renderSystemPanel, renderNotify, renderFooter].forEach((fn) => {
      try { fn(); } catch (e) { console.error('[render] ' + fn.name + ' 失败：', e); }
    });
  }

  /* ==================== 顶栏/页脚 ==================== */
  function renderHeader() {
    renderNextTrigger();
    renderAppVersion();
  }

  function renderAppVersion() {
    const el = $('#app-version');
    if (!el) return;
    if (state.appInfo && state.appInfo.version) {
      el.textContent = 'v' + state.appInfo.version;
      el.classList.add('has-version');
    } else {
      el.textContent = '';
      el.classList.remove('has-version');
    }
  }

  function renderFooter() {
    const f = $('#footer');
    if (!f) return;
    const v = state.appInfo ? ('v' + state.appInfo.version) : '';
    const dir = state.appInfo && state.appInfo.dataDir ? (' · 数据目录：' + state.appInfo.dataDir) : '';
    // R4：凭据加密状态警示（页脚）
    let warns = '';
    const enc = state.appInfo && state.appInfo.encryption;
    if (enc) {
      const list = [];
      if (enc.mode === 'plain') list.push('凭据将明文存储（非 Windows/无 DPAPI 环境）');
      if (enc.hasPlainFlag) list.push('检测到历史明文凭据，建议删除后重新绑定账号');
      if (list.length) warns = ' ⚠️ ' + list.join('；');
    }
    f.textContent = '游戏社区签到助手 ' + v + dir + warns;
    f.classList.toggle('footer-warn', !!warns);   // 颜色走令牌类，不再写死 hex
  }

  /* 下次触发时间：启用游戏 × 有启用账号，取最近一次（今天未到则今天，否则明天） */
  function openAbout() {
    const info = state.appInfo;
    if (!info) return;
    $('#about-version').textContent = '版本 v' + info.version;
    const meta = [];
    if (info.electron) meta.push('Electron ' + info.electron);
    if (info.chrome) meta.push('Chromium ' + info.chrome);
    if (info.node) meta.push('Node ' + info.node);
    if (typeof info.packaged === 'boolean') meta.push(info.packaged ? '打包版' : '开发版');
    if (info.buildTime) meta.push('构建于 ' + info.buildTime);
    $('#about-meta').textContent = meta.join(' · ');
    const enc = info.encryption ? info.encryption : {};
    const encText = (enc.mode === 'plain') ? '凭据明文存储（非 Windows / 无 DPAPI）' : '凭据已加密（safeStorage / DPAPI）';
    $('#about-datadir').textContent = '数据目录：' + (info.dataDir ? info.dataDir : '') + ' · ' + encText;
    $('#about-modal').classList.remove('hidden');
  }

  function closeAbout() { $('#about-modal').classList.add('hidden'); }

  function renderNextTrigger() {
    const el = $('#next-trigger');
    if (!el) return;
    const s = state.settings;
    if (!s) return;
    const now = new Date();
    const p = (x) => String(x).padStart(2, '0');
    const today = p(now.getHours()) + ':' + p(now.getMinutes());
    const items = [];
    for (const a of state.accounts) {
      if (a.enabled === false) continue;
      const gs = (s.games || {})[a.game];
      if (!gs || gs.enabled === false) continue;
      const t = effectiveTime(a, s);   // 统一走本文件唯一的 effectiveTime，别再内联一份回退逻辑
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) continue;
      const g = state.games.find((x) => x.id === a.game);
      const day = t > today ? '今天' : '明天';
      items.push({ text: day + ' ' + t + ' ' + (g ? g.name : a.game) + '·' + (a.nickname || a.id), sort: (day === '今天' ? 0 : 1) + t });
    }
    items.sort((a, b) => (a.sort < b.sort ? -1 : 1));
    const shown = items.slice(0, 2);
    el.textContent = items.length
      ? ('下次签到：' + shown.map((i) => i.text).join(' · ') + (items.length > 2 ? ' …' : ''))
      : '未启用签到（请到账号管理页设置时间并启用）';
    el.title = items.length ? items.map((i) => i.text).join('\n') : '未启用签到';
  }

  /* ==================== 账号管理页 ==================== */
  /* 图标由插件元数据提供，缺省回退通用图标（不再硬编码三游戏映射） */
  function gameIcon(g) { return (g && g.icon) ? g.icon : '🎮'; }

  function renderAccounts() {
    const box = $('#game-cards');
    if (!box) return;
    const s = state.settings || { games: {} };

    // 全局统一时间输入回显 + 违反「全局最晚」的提示
    const gdi = $('#set-default-time');
    if (gdi) gdi.value = s.defaultTime || '06:00';
    const gh = $('#global-time-hint');
    if (gh) {
      const late = [];
      for (const g of state.games) { const t = (s.games || {})[g.id] && (s.games[g.id].time || ''); if (t && t > s.defaultTime) late.push(g.name); }
      for (const a of state.accounts) { if (a.time && a.time > s.defaultTime) late.push((a.nickname || a.id)); }
      gh.textContent = late.length ? '⚠ ' + late.join('、') + ' 的时间晚于全局，请调整' : '未单独设置的游戏/账号使用该时间 · 所有游戏/账号时间都不能晚于它';
    }

    // 空状态：脚本放进「脚本」目录即自动读取（首次使用提示打开脚本目录）
    if (!state.games.length) {
      box.innerHTML =
        '<div class="empty-list empty-hero">' +
          '<div class="empty-hero-icon">📦</div>' +
          '<p class="empty-hero-title">还没有游戏脚本</p>' +
          '<p class="empty-hero-desc">把脚本文件夹放进「脚本」目录即可自动读取<br><b>鸣潮 / 崩铁 / 异环</b> 已在里面，点「刷新」即可</p>' +
          '<button class="btn primary" data-role="open-script-dir">📂 打开脚本目录</button> ' +
          '<button class="btn secondary" data-role="refresh-scripts">🔄 刷新</button>' +
        '</div>';
      return;
    }
    box.innerHTML = state.games.map((g) => {
      const gs = (s.games || {})[g.id] || { enabled: true };
      const gTime = gs.time || '';
      const accounts = state.accounts.filter((a) => a.game === g.id);
      const mlabels = availableMethodLabels(g);
      const rows = accounts.length
        ? accounts.map((a) => {
          const lr = a.lastResult;
          let lastHtml = '<span class="info">尚未签到</span>';
          if (lr && lr.title) {
            const cls = lr.ok ? 'ok' : (lr.ok === false ? 'fail' : 'info');
            lastHtml = '<span class="' + cls + '">' + esc(lr.title) + (lr.reward ? '（' + esc(lr.reward) + '）' : '') + ' · ' + esc(lr.date || '') + ' ' + esc(fmtTime(lr.at)) + '</span>';
          }
          const eff = effectiveTime(a, s);
          const effText = a.time ? ('生效：' + esc(eff)) : (gTime ? '跟随游戏 ' + esc(gTime) : (s.defaultTime ? '跟随全局 ' + esc(s.defaultTime) : ''));
          return (
            '<div class="account-row" data-account="' + esc(a.id) + '">' +
              '<div class="account-info">' +
                '<div class="account-line1">' +
                  '<span class="account-nickname">' + esc(a.nickname || '未命名账号') + '</span>' +
                  '<span class="account-last">最近结果：' + lastHtml + '</span>' +
                '</div>' +
                '<div class="account-line2">' +
                  '<label class="time-label">🕐 签到时间</label>' +
                  '<input class="input time-input acct-time" type="time" step="60" data-role="account-time" data-id="' + esc(a.id) + '" value="' + esc(a.time || '') + '" title="留空=跟随游戏/全局">' +
                  '<span class="eff-hint">' + effText + '</span>' +
                  tip('留空=跟随游戏统一时间（游戏也没设就用全局）。设置后只对这个账号生效。想让某个账号晚点签，需要把全局时间也调到更晚（全局=兜底的最后时间）。') +
                  '<span class="acct-err"></span>' +
                '</div>' +
              '</div>' +
              '<div class="account-actions">' +
                '<label class="switch" title="停用后不参与定时签到与补跑">' +
                  '<input type="checkbox" data-role="account-enabled" data-id="' + esc(a.id) + '"' + (a.enabled !== false ? ' checked' : '') + '>' +
                  '<span class="track"></span><span>启用</span>' +
                '</label>' +
                '<button class="btn mini" data-role="run-account" data-id="' + esc(a.id) + '">立即签到</button>' +
                '<button class="btn mini danger" data-role="remove-account" data-id="' + esc(a.id) + '">删除</button>' +
              '</div>' +
            '</div>'
          );
        }).join('')
        : '<div class="empty-list">' + (mlabels.length
            ? '暂无账号，点击「添加账号」绑定（可用登录方式：' + esc(mlabels.join(' / ')) + '）'
            : '暂无账号，点击「添加账号」绑定') + '</div>';

      return (
        '<div class="game-card' + (gs.enabled === false ? ' game-off' : '') + '" data-game="' + g.id + '">' +
          '<div class="game-card-head">' +
            '<div class="card-head-left">' +
              '<span class="game-title">' + gameIcon(g) + ' ' + esc(g.name) + '</span>' +
              '<span class="game-community">' + esc(g.community) + '</span>' +
              '<span class="game-time-box">' +
                '<label class="time-label">每游戏时间</label>' +
                '<input class="input time-input game-time-input" type="time" step="60" data-role="game-time" data-game="' + g.id + '" value="' + esc(gTime) + '" title="留空=跟随全局 ' + esc(gTime || s.defaultTime || '') + '">' +
                '<span class="eff-hint">' + (gTime ? '生效：' + esc(gTime) : (s.defaultTime ? '跟随全局 ' + esc(s.defaultTime) : '')) + '</span>' +
                tip('该游戏所有账号的默认签到时间；某账号单独设置了时间则优先用它的。留空=跟随全局。') +
              '</span>' +
            '</div>' +
            '<div class="card-head-right">' +
              '<label class="switch" title="关闭后该游戏全部账号不参与定时签到">' +
                '<input type="checkbox" data-role="game-enabled" data-game="' + g.id + '"' + (gs.enabled !== false ? ' checked' : '') + '>' +
                '<span class="track"></span><span>启用签到</span>' +
              '</label>' +
              '<button class="btn mini" data-role="run-game" data-game="' + g.id + '">立即签到</button>' +
              '<button class="btn primary mini" data-role="add-account" data-game="' + g.id + '">+ 添加账号</button>' +
            '</div>' +
          '</div>' +
          '<div class="account-list">' + rows + '</div>' +
        '</div>'
      );
    }).join('');
  }

  /**
 * 账号生效时间（三级回退：账号 → 游戏 → 全局），界面显示用。
 * 这是渲染层**唯一**一份实现（顶栏「下次签到」也调它，别再内联第二份）。
 * 调度侧的权威实现是 core/storage.js 的 effectiveTimeFor——两份口径必须一致，
 * 由 scripts/test-consistency.js 的断言锁定；改回退顺序时两边都要改。
 * （渲染层跑在 sandbox 里拿不到 Node，无法直接 require 共用同一份代码，只能靠断言守住。）
 */
  function effectiveTime(a, s) {
    s = s || state.settings || {};
    const gs = (s.games || {})[a.game] || {};
    return a.time || gs.time || s.defaultTime || '';
  }

  async function refreshAccounts() {
    const r = await invoke('accounts:list');
    if (r.ok && Array.isArray(r.accounts)) { state.accounts = r.accounts; renderAccounts(); renderNextTrigger(); }
  }

  /* ---------- 账号页操作 ---------- */
  async function onAccountAction(target) {
    const role = target.dataset.role;
    if (role === 'game-enabled') {
      const game = target.dataset.game;
      const checked = target.checked;
      const s = state.settings;
      s.games[game] = Object.assign({}, s.games[game] || {}, { enabled: checked });
      const r = await invoke('settings:save', { settings: s });
      if (r.ok) { toast(checked ? '已启用 ' + gameName(game) + ' 签到' : '已停用 ' + gameName(game) + ' 签到', 'success'); }
      else toast('保存失败：' + (r.error || ''), 'error');
      renderAccounts(); renderNextTrigger();
      return;
    }
    if (role === 'account-enabled') {
      const id = target.dataset.id;
      const checked = target.checked;
      const r = await invoke('accounts:setEnabled', { id: id, enabled: checked });
      if (r.ok) toast(checked ? '账号已启用' : '账号已停用', 'success');
      else toast('操作失败：' + (r.error || ''), 'error');
      refreshAccounts();
      return;
    }
    if (role === 'run-account') {
      const id = target.dataset.id;
      target.disabled = true;
      const r = await invoke('run:account', { id: id });
      target.disabled = false;
      if (r.ok) toast('已执行，结果见日志页：' + (r.summary || ''), 'success');
      else toast('执行失败：' + (r.error || ''), 'error');
      refreshAccounts();
      return;
    }
    if (role === 'run-game') {
      const game = target.dataset.game;
      target.disabled = true;
      const r = await invoke('run:game', { gameId: game });
      target.disabled = false;
      if (r.ok) toast(gameName(game) + '签到执行完成（结果见日志页）', r.summary ? 'success' : 'info');
      else toast('执行失败：' + (r.error || ''), 'error');
      refreshAccounts();
      return;
    }
    if (role === 'remove-account') {
      const id = target.dataset.id;
      const acc = state.accounts.find((a) => a.id === id);
      const name = (acc && acc.nickname) || id;
      const ok = await confirmDialog('确定删除账号「' + name + '」？删除后无法恢复。');
      if (!ok) return;
      const r = await invoke('accounts:remove', { id: id });
      if (r.ok) { toast('账号已删除', 'success'); refreshAccounts(); }
      else toast('删除失败：' + (r.error || ''), 'error');
      return;
    }
    if (role === 'add-account') {
      const game = state.games.find((g) => g.id === target.dataset.game);
      if (game) openLoginDialog(game);
    }
  }

  function gameName(id) {
    const g = state.games.find((x) => x.id === id);
    return g ? g.name : id;
  }

  /* ==================== 账号页：系统设置面板 ==================== */
  function renderSystemPanel() {
    const s = state.settings;
    if (!s) return;
    const ab = $('#set-autostart'); if (ab) ab.checked = !!s.autoStart;
    const st = $('#set-systask'); if (st) st.checked = !!s.useSystemTask;
    const cbEl = $('#set-close-behavior');
    if (cbEl) cbEl.value = s.closeBehavior === 'exit' ? 'exit' : 'tray';
    renderTimerHint();
    renderTaskStatus();
  }

  /* 定时方式提示：游戏/账号时间靠内置定时器（挂后台）；全局时间是系统任务兜底 */
  function renderTimerHint() {
    const el = $('#timer-mode-hint');
    if (!el) return;
    const s = state.settings || {};
    el.textContent = s.useSystemTask
      ? '定时方式：内置定时器按各账号生效时间到点签到（需应用后台运行/托盘常驻）；系统计划任务已开启——全局统一时间到点由「签到助手-全局」拉起补签，应用未启动也能兜底。'
      : '定时方式：内置定时器按各账号生效时间到点签到，需应用后台运行（关闭窗口会隐藏到托盘常驻、开机自启常驻）才能到点签到；若想"应用未启动也能按全局时间兜底"，开启系统计划任务即可。';
  }

  function renderTaskStatus() {
    const box = $('#systask-status');
    if (!box) return;
    if (!state.taskStatus || !state.taskStatus.length) {
      box.innerHTML = '当前未创建「签到助手-*」系统计划任务。开启上方开关后，将按全局统一时间创建「签到助手-全局」一个任务（仅操作本应用任务）。';
      return;
    }
    box.innerHTML = '<div class="task-line">本应用系统计划任务（仅操作「签到助手-*」前缀任务）：</div>' +
      state.taskStatus.map((t) =>
        '<div class="task-line">· ' + esc(t.name) + '（' + esc(t.time || '') + '）— ' +
        (t.synced ? '<span class="synced">✓ 已同步</span>' : '<span class="unsynced">⚠ 未同步</span>') + '</div>'
      ).join('');
  }

  /** 全局统一时间即改即存：校验格式 + 全局必须最晚 */
  async function onDefaultTimeChange() {
    const inp = $('#set-default-time');
    const msg = $('#global-time-msg');
    const s = state.settings;
    msg.textContent = ''; msg.className = 'form-msg';
    const val = inp.value;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(val)) { msg.textContent = '时间格式不正确（应为 HH:mm）'; msg.className = 'form-msg err'; inp.value = s.defaultTime || ''; return; }
    // 前置校验：任何游戏/账号时间不得晚于新全局时间
    const late = [];
    for (const g of state.games) { const t = (s.games || {})[g.id] && (s.games[g.id].time || ''); if (t && t > val) late.push(g.name + ' ' + t); }
    for (const a of state.accounts) { if (a.time && a.time > val) late.push((a.nickname || a.id) + ' ' + a.time); }
    if (late.length) {
      msg.textContent = '无法保存：以下时间晚于新全局时间，请先调整（或把全局时间设晚）：' + late.join('、');
      msg.className = 'form-msg err';
      inp.value = s.defaultTime || '';
      return;
    }
    s.defaultTime = val;
    const r = await invoke('settings:save', { settings: s });
    if (r.ok) {
      msg.textContent = '✓ 全局统一时间已设为 ' + val; msg.className = 'form-msg ok';
      toast('全局统一时间已设为 ' + val, 'success');
      renderAccounts(); renderNextTrigger();
    } else {
      msg.textContent = '保存失败：' + (r.error || ''); msg.className = 'form-msg err';
      inp.value = s.defaultTime || '';
    }
  }

  /** 游戏统一时间即改即存：留空=跟随全局；不得晚于全局 */
  async function onGameTimeChange(inp) {
    const game = inp.dataset.game;
    const val = inp.value;
    const s = state.settings;
    const gs = s.games[game] = Object.assign({}, s.games[game] || {});
    if (val && !/^([01]\d|2[0-3]):[0-5]\d$/.test(val)) { toast('时间格式不正确（应为 HH:mm）', 'error'); inp.value = gs.time || ''; return; }
    if (val && val > s.defaultTime) {
      toast(gameName(game) + '时间不能晚于全局统一时间（' + s.defaultTime + '），否则未后台运行时无法兜底', 'error');
      inp.value = gs.time || '';
      return;
    }
    gs.time = val;   // '' = 清除（跟随全局）
    const r = await invoke('settings:save', { settings: s });
    if (r.ok) {
      toast(gameName(game) + '签到时间已' + (val ? '设为 ' + val : '改为跟随全局 ' + (s.defaultTime || '')), 'success');
      renderAccounts(); renderNextTrigger();
    } else {
      toast('保存失败：' + (r.error || ''), 'error');
      renderAccounts();
    }
  }

  /** 账号自定义时间即改即存：留空=跟随游戏/全局；不得晚于全局 */
  async function onAccountTimeChange(inp) {
    const id = inp.dataset.id;
    const val = inp.value;
    const acc = state.accounts.find((a) => a.id === id);
    const row = inp.closest('.account-row');
    const errEl = row ? row.querySelector('.acct-err') : null;
    if (errEl) { errEl.textContent = ''; }
    if (val && !/^([01]\d|2[0-3]):[0-5]\d$/.test(val)) {
      if (errEl) { errEl.textContent = '时间格式不正确（HH:mm）'; }
      inp.value = (acc && acc.time) || '';
      return;
    }
    if (val && val > state.settings.defaultTime) {
      if (errEl) { errEl.textContent = '不能晚于全局统一时间（' + state.settings.defaultTime + '），否则未后台运行时无法兜底'; }
      inp.value = (acc && acc.time) || '';
      return;
    }
    const r = await invoke('accounts:setTime', { id: id, time: val });
    if (r.ok) {
      refreshAccounts(); renderNextTrigger();
    } else {
      if (errEl) { errEl.textContent = r.error || '保存失败'; }
      inp.value = (acc && acc.time) || '';
    }
  }

  async function onAutostartToggle(checked) {
    const s = state.settings;
    s.autoStart = checked;
    const r = await invoke('system:autostart:set', { enabled: checked });
    const msg = $('#systask-msg');
    if (!r.ok) {
      msg.textContent = '设置失败：' + (r.error || ''); msg.className = 'form-msg err';
      s.autoStart = !checked; $('#set-autostart').checked = !checked;
      return;   // 注册表未改成功时不再把状态写入设置
    }
    state.autostart = !!r.enabled;
    const rs = await invoke('settings:save', { settings: s });
    if (rs.ok) {
      msg.textContent = '✓ 开机自启已' + (checked ? '开启' : '关闭'); msg.className = 'form-msg ok';
    } else {
      // 注册表已切换但设置持久化失败——如实提示，不谎报成功
      msg.textContent = '开机自启已' + (checked ? '开启' : '关闭') + '，但设置保存失败：' + (rs.error || '');
      msg.className = 'form-msg err';
    }
  }

  async function onSystaskToggle(checked) {
    const s = state.settings;
    s.useSystemTask = checked;
    const msg = $('#systask-msg');
    msg.textContent = ''; msg.className = 'form-msg';
    const r = await invoke('settings:save', { settings: s });
    if (!r.ok) {
      // 保存失败不得继续触发任务同步——否则主进程会按磁盘旧设置
      // 把「签到助手-*」任务全部删除却向用户报成功。回滚开关并如实提示。
      s.useSystemTask = !checked; $('#set-systask').checked = !checked;
      msg.textContent = '保存失败，系统计划任务未变更：' + (r.error || ''); msg.className = 'form-msg err';
      toast('系统计划任务设置保存失败：' + (r.error || ''), 'error');
      return;
    }
    if (r.taskSync && r.taskSync.ok === false) {
      // 保存成功但主进程自动同步任务失败：如实报告（不手动补 sync，避免按磁盘旧值误删）
      msg.textContent = '设置已保存，但系统任务同步失败：' + (r.taskSync.detail || ''); msg.className = 'form-msg err';
      toast('系统任务同步失败：' + (r.taskSync.detail || ''), 'error');
    } else {
      msg.textContent = checked ? '✓ 系统计划任务已开启并同步' : '✓ 系统计划任务已关闭并清除';
      msg.className = 'form-msg ok';
      toast(checked ? '系统计划任务已写入' : '系统计划任务已清除', 'success');
    }
    const st = await invoke('system:task:status', {});
    if (st.ok && Array.isArray(st.tasks)) state.taskStatus = st.tasks;
    renderTaskStatus();
    renderTimerHint();
  }

  /* 关闭窗口行为（t13）：exit=直接退出 / tray=隐藏到托盘常驻（后台常驻，点托盘可恢复） */
  async function onCloseBehaviorChange(value) {
    const s = state.settings;
    if (value !== 'tray' && value !== 'exit') return;
    s.closeBehavior = value;
    const msg = $('#systask-msg');
    msg.textContent = ''; msg.className = 'form-msg';
    const r = await invoke('settings:save', { settings: s });
    if (r.ok) {
      msg.textContent = value === 'exit'
        ? '✓ 已设：关闭窗口=直接退出（不再后台常驻；已开启系统计划任务仍会到点自动补签到）'
        : '✓ 已设：关闭窗口=隐藏到托盘（后台常驻，点托盘可恢复）';
      msg.className = 'form-msg ok';
      toast('关闭窗口行为已更新', 'success');
    } else {
      msg.textContent = '保存失败：' + (r.error || ''); msg.className = 'form-msg err';
    }
  }

  /* ==================== 签到日历页 ==================== */
  const calState = { year: 0, month: 0, data: {}, detailGame: '', detailDate: '' };
  const calPad = (x) => String(x).padStart(2, '0');

  function todayDs() {
    const n = new Date();
    return n.getFullYear() + '-' + calPad(n.getMonth() + 1) + '-' + calPad(n.getDate());
  }

  async function loadCalendarPage() {
    if (!state.games.length) {
      $('#cal-cards').innerHTML = '<div class="empty-list empty-hero">还没有游戏脚本。请到「账号管理」页点「管理游戏脚本」→「📥 导入脚本…」，选中插件文件夹即可。</div>';
      $('#cal-title').textContent = '';
      $('#cal-day-detail').classList.add('hidden');
    } else {
      const now = new Date();
      if (!calState.year) { calState.year = now.getFullYear(); calState.month = now.getMonth() + 1; }
      await loadCalendarData();
      renderCalendar();
    }
    loadRecentLogs();
  }

  async function loadCalendarData() {
    const r = await invoke('calendar:month', { year: calState.year, month: calState.month });
    calState.data = (r.ok && r.games) ? r.games : {};
  }

  function monthDoneCount(gameId) {
    const d = calState.data[gameId] || {};
    let n = 0;
    for (const k of Object.keys(d)) if (d[k].status === 'ok') n++;
    return n;
  }

  function buildMiniCalendar(gameId) {
    const data = calState.data[gameId] || {};
    const dsToday = todayDs();
    const first = new Date(calState.year, calState.month - 1, 1);
    const daysInMonth = new Date(calState.year, calState.month, 0).getDate();
    const offset = (first.getDay() + 6) % 7;
    let html = ['一', '二', '三', '四', '五', '六', '日'].map((w) => '<div class="cal-wd">' + w + '</div>').join('');
    for (let i = 0; i < offset; i++) html += '<div class="cal-cell cal-blank"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = calState.year + '-' + calPad(calState.month) + '-' + calPad(d);
      const st = data[ds];
      const isToday = ds === dsToday;
      const isFuture = ds > dsToday;
      let cls = 'cal-cell', mark = '';
      if (!isFuture) {
        if (st && st.status === 'ok') { cls += ' cal-ok'; mark = '✅'; }
        else if (st) { cls += ' cal-fail'; mark = '❌'; }
        else { cls += ' cal-fail cal-nodata'; mark = '❌'; }
      } else {
        cls += ' cal-future';
      }
      if (isToday) cls += ' cal-today';
      // 奖励小字并入格子磁贴（上：状态+日期，下：奖励两行），不再悬空在格子外
      const rewards = (st && Array.isArray(st.rewards)) ? st.rewards : [];
      const hasReward = !isFuture && rewards.length > 0;
      const tip = hasReward ? '🎁 ' + rewards.join('\n🎁 ') + '\n' : '';
      const rewardText = hasReward ? '<div class="cal-reward-text">' + esc(rewards.join('、')) + '</div>' : '';
      const top = isFuture ? String(d) : '<div class="cal-celltop">' + mark + '<span class="cal-daynum">' + d + '</span></div>';
      html += '<div class="cal-day"' + (isFuture ? '' : ' data-clickable="1" data-game="' + esc(gameId) + '" data-date="' + ds + '" title="' + esc(tip + '点击查看当天明细') + '"') + '>' +
        '<div class="' + cls + '">' + top + rewardText + '</div></div>';
    }
    return html;
  }

  function renderCalendar() {
    const box = $('#cal-cards');
    if (!box) return;
    $('#cal-title').textContent = calState.year + '年' + calState.month + '月';
    // 卡片列数交给 CSS 自适应（每卡≥760px 才并排），保证格子下奖励小字完整显示
    box.className = 'cal-cards';
    box.innerHTML = state.games.map((g) => {
      const okCount = monthDoneCount(g.id);
      return '<div class="cal-card">' +
        '<div class="cal-card-head">' +
          '<span class="cal-card-title">' + gameIcon(g) + ' ' + esc(g.name) + '</span>' +
          '<span class="cal-card-badge">' + okCount + ' / ' + new Date(calState.year, calState.month, 0).getDate() + ' 天</span>' +
        '</div>' +
        '<div class="cal-grid mini">' + buildMiniCalendar(g.id) + '</div>' +
      '</div>';
    }).join('');

    if (calState.detailDate && calState.detailGame) showDayDetail(calState.detailGame, calState.detailDate);
  }

  async function showDayDetail(gameId, ds) {
    calState.detailGame = gameId;
    calState.detailDate = ds;
    const box = $('#cal-day-detail');
    if (!box) return;
    box.classList.remove('hidden');
    const g = state.games.find((x) => x.id === gameId);
    const r = await invoke('results:history', { date: ds });
    const results = (r.ok && r.results) ? r.results : {};
    const list = results[gameId] || [];
    box.innerHTML = '<div class="cal-detail-head">' + (g ? gameIcon(g) + ' ' + esc(g.name) : esc(gameId)) + ' · ' + esc(ds) + ' 账号明细</div>';
    if (!list.length) { box.innerHTML += '<div class="result-empty">当天无记录（无结果文件）</div>'; return; }
    box.innerHTML += list.map((it) =>
      '<div class="result-row">' +
        '<span class="result-badge">' + (it.ok ? '✅' : '❌') + '</span>' +
        '<span class="result-title">' + esc(it.nickname || '') + ' — ' + esc(it.title || '') + '</span>' +
        (it.reward ? '<span class="result-reward">' + esc(it.reward) + '</span>' : '') +
        '<span class="result-time">' + esc(fmtTime(it.at)) + '</span>' +
      '</div>').join('');
  }

  async function moveCalMonth(delta) {
    let m = calState.month + delta, y = calState.year;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    calState.year = y; calState.month = m; calState.detailDate = ''; calState.detailGame = '';
    await loadCalendarData();
    renderCalendar();
  }

  async function calGoToday() {
    const now = new Date();
    calState.year = now.getFullYear(); calState.month = now.getMonth() + 1;
    calState.detailDate = ''; calState.detailGame = '';
    await loadCalendarData();
    renderCalendar();
  }

  async function loadRecentLogs() {
    const r = await invoke('logs:recent', { n: 200 });
    const stream = $('#log-stream');
    if (!stream) return;
    stream.innerHTML = '';
    if (r.ok && Array.isArray(r.logs)) r.logs.forEach((l) => appendLogLine(l.time, l.msg));
    else stream.innerHTML = '<div class="log-line msg-error">无法获取日志</div>';
    scrollLogToBottom();
  }

  function appendLogLine(time, msg) {
    const stream = $('#log-stream');
    if (!stream) return;
    const div = document.createElement('div');
    div.className = 'log-line';
    let cls = '';
    const m = String(msg || '');
    if (/❌|失败|错误|异常/.test(m)) cls = ' msg-error';
    else if (/⚠️|警告|跳过|过期|降级|极验/.test(m)) cls = ' msg-warn';
    else if (/✅|成功|完成/.test(m)) cls = ' msg-success';
    div.innerHTML = '<span class="log-time">' + esc(fmtTime(time)) + '</span>' + esc(m);
    div.className = 'log-line' + cls;
    stream.appendChild(div);
    // 日志流 DOM 上限 500 条（长期常驻降内存；点开日历/日志仍自动重拉，不丢信息）
    const max = 500;
    while (stream.childNodes.length > max) stream.removeChild(stream.firstChild);
    const auto = $('#log-autoscroll');
    if (!auto || auto.checked) scrollLogToBottom();
  }

  function scrollLogToBottom() {
    const stream = $('#log-stream');
    if (stream) stream.scrollTop = stream.scrollHeight;
  }

  /* ==================== 通知设置页 ==================== */
  /* 密钥字段：{ path, inputId, channel, key } */
  const SECRET_FIELDS = [
    { channel: 'serverchan', key: 'sendKey', inputId: 'notify-serverchan' },
    { channel: 'pushplus', key: 'token', inputId: 'notify-pushplus' },
    { channel: 'wecom', key: 'webhook', inputId: 'notify-wecom' },
    { channel: 'email', key: 'pass', inputId: 'notify-email-pass' },
    { channel: 'qqbot', key: 'appSecret', inputId: 'notify-qqbot-secret' },
  ];
  const loadedSecrets = {};   // channel.key -> 加载时的掩码值（用于判断是否改动）

  function renderNotify() {
    const s = state.settings;
    if (!s) return;
    const n = s.notify || {};
    for (const f of SECRET_FIELDS) {
      const val = ((n[f.channel] || {})[f.key]) || '';
      loadedSecrets[f.channel + '.' + f.key] = val;
      $('#' + f.inputId).value = val;
    }
    const tpl = (n.pushplus || {}).template || 'html';
    $('#notify-pushplus-tpl').value = tpl === 'markdown' ? 'markdown' : 'html';
    // t15：邮箱渠道非密钥字段回显（pass 由 SECRET_FIELDS 通用掩码处理）
    const em = n.email || {};
    $('#notify-email-host').value = em.smtpHost || '';
    $('#notify-email-port').value = em.smtpPort || '';
    $('#notify-email-user').value = em.user || '';
    $('#notify-email-to').value = em.to || '';
    // QQ 机器人回显（appSecret 由 SECRET_FIELDS 通用掩码回显）
    const q = n.qqbot || {};
    $('#notify-qqbot-appid').value = q.appId || '';
    refreshQqbotStatus();
  }

  function isMasked(v) { return typeof v === 'string' && v.indexOf('****') >= 0; }

  /* 构造保存用的 notify：未改动且原值为掩码 -> null（主进程保留原值）；清空 -> ''；新值 -> 原样 */
  function buildNotifyPayload() {
    const s = state.settings;
    const n = (s.notify || {});
    const out = {
      serverchan: { sendKey: null },
      pushplus: { token: null, template: $('#notify-pushplus-tpl').value || 'html' },
      wecom: { webhook: null },
      email: {
        smtpHost: $('#notify-email-host').value.trim(),
        smtpPort: $('#notify-email-port').value.trim(),
        user: $('#notify-email-user').value.trim(),
        pass: null,
        to: $('#notify-email-to').value.trim(),
      },
      qqbot: { appId: $('#notify-qqbot-appid').value.trim(), appSecret: null },   // openid 由绑定流程写入
    };
    for (const f of SECRET_FIELDS) {
      const input = $('#' + f.inputId).value;
      const orig = loadedSecrets[f.channel + '.' + f.key] || '';
      let val;
      if (input === orig) val = isMasked(orig) ? null : orig;   // 未改动：掩码->保留；真实值(未加密模式)->原样
      else val = input;                                          // 改动（含清空）-> 按输入
      out[f.channel][f.key] = val;
    }
    out.pushplus.template = $('#notify-pushplus-tpl').value || 'html';
    return out;
  }

  async function saveNotify() {
    const msg = $('#notify-msg');
    msg.textContent = ''; msg.className = 'form-msg';
    const s = state.settings;
    s.notify = buildNotifyPayload();
    const r = await invoke('settings:save', { settings: s });
    if (r.ok) { msg.textContent = '✓ 通知设置已保存（密钥未改动时保留原值）'; msg.className = 'form-msg ok'; toast('通知设置已保存', 'success'); refreshQqbotStatus(); }
    else { msg.textContent = '保存失败：' + (r.error || ''); msg.className = 'form-msg err'; }
  }

  async function testNotify(channel) {
    const cfg = buildNotifyPayload()[channel];
    const btn = $('.btn-test[data-channel="' + channel + '"]');
    if (btn) btn.disabled = true;
    const r = await invoke('notify:test', { channel: channel, cfg: cfg });
    if (btn) btn.disabled = false;
    if (r.ok) { toast(channel + ' 测试发送成功：' + (r.detail || ''), 'success'); }
    else toast(channel + ' 测试失败：' + (r.error || '发送失败'), 'error');
  }

  /* ---------- QQ 机器人：绑定轮询与状态直显 ---------- */
  let qqBindPollTimer = null;

  function renderQqbotStatus(r) {
    const el = $('#notify-qqbot-status');
    if (!el) return;
    const b = r.bind || {};
    const rp = r.report || {};
    // 发送时刻直显（= 全局统一签到时间 + 30 分钟）
    const tEl = $('#notify-qqbot-time');
    if (tEl) {
      const pad = (x) => String(x).padStart(2, '0');
      tEl.textContent = rp.sendTime
        ? '日报每天 ' + pad(rp.sendTime.hh) + ':' + pad(rp.sendTime.mm) + ' 自动发送（=「全局统一签到时间 + 30 分钟」）'
        : '日报在「全局统一签到时间 + 30 分钟」后自动发送';
    }
    // 上次发送结果直显
    const repEl = $('#notify-qqbot-report');
    if (repEl) {
      if (rp.lastError) { repEl.textContent = '⚠️ 上次日报发送失败：' + rp.lastError; repEl.className = 'form-msg err'; }
      else if (rp.lastDate) { repEl.textContent = '上次日报：' + rp.lastDate + ' 已发送 ✅'; repEl.className = 'form-msg ok'; }
      else { repEl.textContent = ''; repEl.className = 'form-msg'; }
    }
    // 绑定状态
    const waiting = b.status === 'connecting' || b.status === 'waiting';
    if (waiting) {
      // 安全 DOM 构造（码只含 [A-Z2-9]，仍不做 innerHTML 拼接）
      el.textContent = '';
      el.appendChild(document.createTextNode('⏳ 请在 QQ 里给机器人发送绑定码：'));
      const codeEl = document.createElement('b');
      codeEl.textContent = b.code || '…';
      el.appendChild(codeEl);
      el.appendChild(document.createTextNode('（3 分钟内有效）'));
      el.className = 'form-msg';
    } else if (b.status === 'done') {
      el.textContent = '✅ 绑定成功' + (b.openid ? '（身份尾号 ' + b.openid.slice(-6) + '）' : '');
      el.className = 'form-msg ok';
    } else if (b.status === 'error' || b.status === 'expired') {
      el.textContent = '⚠️ ' + (b.error || '绑定失败，请重试');
      el.className = 'form-msg err';
    } else if (b.openid) {
      el.textContent = '✅ 已绑定（身份尾号 ' + b.openid.slice(-6) + '）';
      el.className = 'form-msg ok';
    } else {
      el.textContent = '未绑定：点「开始绑定」并在 QQ 里给机器人发一条消息';
      el.className = 'form-msg';
    }
    const btn = $('#btn-qqbot-bind');
    if (btn) { btn.disabled = waiting; btn.textContent = waiting ? '绑定中…' : '开始绑定'; }
    const cancel = $('#btn-qqbot-cancel');
    if (cancel) cancel.classList.toggle('hidden', !waiting);
  }

  async function refreshQqbotStatus() {
    if (!$('#notify-qqbot-status')) return;
    const r = await invoke('qqbot:status');
    if (r.ok) renderQqbotStatus(r);
  }

  function stopQqbotPoll() {
    if (qqBindPollTimer) { clearInterval(qqBindPollTimer); qqBindPollTimer = null; }
  }

  function startQqbotPoll() {
    stopQqbotPoll();
    let tries = 0;
    qqBindPollTimer = setInterval(async () => {
      tries++;
      const r = await invoke('qqbot:status');
      if (r.ok) renderQqbotStatus(r);
      const st = r.ok && r.bind && r.bind.status;
      if (st === 'done' || st === 'error' || st === 'expired' || tries > 140) stopQqbotPoll();
    }, 1500);
  }

  async function bindQqbot() {
    await saveNotify();   // 先保存 AppID/AppSecret，再开始绑定
    const r = await invoke('qqbot:bind:start');
    if (!r.ok) {
      const el = $('#notify-qqbot-status');
      if (el) { el.textContent = '⚠️ ' + (r.error || '无法开始绑定'); el.className = 'form-msg err'; }
      return;
    }
    toast('绑定已开始：请把界面上显示的绑定码发给 QQ 里的机器人', 'success');
    startQqbotPoll();
  }

  /* ==================== 登录弹窗 ==================== */
  /* 登录方式全部由插件 loginMethods 元数据驱动（t4/t5/t6）；不写死任何游戏 */

  /* 登录方式标签兜底表：仅在插件没给 label 时使用。
 * 注意：不要用它覆盖插件自己的 label——插件作者最清楚自己那条方式是什么。
 * 本表若优先，会把插件的实际方式显示成一个与实现不符的旧标签。 */
  const KIND_LABEL = {
    sms: '短信验证码',
    web: '网页登录',
    gui: '浏览器登录',
    paste: '粘贴登录',
  };

  /* ---------- 登录方式（按 needs 判定 kind；同 kind 去重） ---------- */
  function methodKind(m) {
    if (m.kind && KIND_LABEL[m.kind]) return m.kind;      // 插件显式声明（推荐）
    const needs = m.needs || [];
    if (needs.indexOf('web') >= 0) return 'web';          // 网页登录窗口
    if (needs.indexOf('gui') >= 0) return 'gui';          // 浏览器登录（与注册表 guessKind 顺序一致）
    if (needs.indexOf('code') >= 0) return 'sms';         // 手机号+短信验证码
    return 'paste';                                       // 粘贴 token / cookie
  }

  function methodLabel(m) {
    return m.label || KIND_LABEL[methodKind(m)] || '登录方式';   // 插件 label 优先，兜底表只在缺失时用
  }

  function buildMethods(game) {
    const methods = [];
    const kindSeen = {}; // kind -> true（用于去重与断言）
    (game.loginMethods || []).forEach((m) => {
      const kind = methodKind(m);
      if (!kind || kindSeen[kind]) return;               // 非法/重复 kind 跳过（不崩溃）
      kindSeen[kind] = true;
      methods.push({ id: m.id, label: methodLabel(m), pluginLabel: m.label || '', kind, disabled: false, hint: m.hint || '', help: m.help || null });
    });
    const kinds = methods.map((m) => m.kind);
    const dup = kinds.filter((k, i) => kinds.indexOf(k) !== i);
    if (dup.length) console.warn('[buildMethods] 登录方式 kind 重复/错位：' + dup.join(','));
    return methods;
  }

  /* 可用登录方式标签（用于空列表引导，与弹窗入口保持一致） */
  function availableMethodLabels(game) {
    return buildMethods(game).filter((m) => !m.disabled).map((m) => m.label);
  }

  /* 登录方式官方网址+操作步骤帮助区（数据源 = loginMethods 条目 help 字段：{links:[{url,text}], steps:[]}）。
     在登录弹窗每个登录方式 tab 都显示「官方网址 + 小白分步操作说明」；插件未提供 help 时隐藏不报错。 */
  function renderDlgHelp(m) {
    const box = $('#dlg-help');
    if (!box) return;
    if (!m || m.disabled || !m.help) { box.classList.add('hidden'); return; }
    const h = m.help || {};
    const links = Array.isArray(h.links) ? h.links : (h.url ? [{ url: h.url, text: h.urlText || h.url }] : []);
    const steps = Array.isArray(h.steps) ? h.steps : [];
    const head = '<div class="help-title">📖 ' + esc(m.pluginLabel || m.label || '该登录方式') + ' — 官方网址与操作步骤（小白可用）</div>';
    const linkHtml = links.map((l) =>
      '<div class="help-link">🌐 官方网址：<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.text || l.url) + '</a>（' + esc(l.url) + '）</div>'
    ).join('');
    const stepHtml = steps.length
      ? '<ol class="help-steps">' + steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>'
      : '';
    box.innerHTML = head + linkHtml + stepHtml;
    box.classList.remove('hidden');
  }

  /* 动态登录面板模板（web/gui）：面板按需动态创建，元素 id 与既有面板保持一致。 */
  const PANEL_HTML = {
    web: `
        <p class="panel-hint" id="dlg-web-hint">将打开官方登录页，请在窗口中按官方流程完成登录。</p>
        <button id="dlg-web-open" class="btn primary block">打开网页登录窗口</button>
        <div id="dlg-web-status" class="web-status"></div>
        <div id="dlg-web-degrade" class="degrade-box hidden">
          <p class="degrade-title">⚠️ 网页登录暂不可用</p>
          <p class="degrade-desc" id="dlg-web-degrade-reason">未能提取登录态或页面结构已变化。</p>
          <div class="degrade-actions">
            <button id="degrade-sms-btn" class="btn primary" data-switch="sms">改用验证码登录</button>
            <button id="degrade-paste-btn" class="btn secondary" data-switch="paste">改用粘贴登录</button>
          </div>
        </div>`,
    gui: `
        <p class="panel-hint" id="dlg-gui-hint">将在默认浏览器中打开本地登录页（短信验证码 / 粘贴 token）；登录成功后账号自动绑定到本应用。</p>
        <button id="dlg-gui-open" class="btn primary block">打开浏览器登录</button>
        <div id="dlg-gui-status" class="web-status"></div>`,
  };

  /* 确保某 kind 的面板存在：静态 sms/paste 直接返回；web/gui 不存在时按模板动态创建并绑定事件；未识别返回 null */
  function ensurePanel(kind) {
    const existing = $('#panel-' + kind);
    if (existing) return existing;
    const tpl = PANEL_HTML[kind];
    if (!tpl) return null;
    const holder = $('#dlg-dynamic-panels');
    if (!holder) return null;
    const div = document.createElement('div');
    div.id = 'panel-' + kind;
    div.className = 'method-panel hidden';
    div.innerHTML = tpl;
    holder.appendChild(div);
    bindDynamicPanelEvents(kind, div);
    return div;
  }

  /* 动态面板事件绑定：面板按需创建，事件在创建时绑定（创建一次即永久有效） */
  function bindDynamicPanelEvents(kind, panel) {
    if (kind === 'web') {
      $('#dlg-web-open').addEventListener('click', onWebOpen);
      $('#dlg-web-degrade').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-switch]');
        if (btn) selectMethod(btn.dataset.switch);
      });
    } else if (kind === 'gui') {
      $('#dlg-gui-open').addEventListener('click', () => { dlg.gui.opened = false; startGuiLogin(); });
    }
  }

  function openLoginDialog(game) {
    dlg.game = game;
    dlg.methods = buildMethods(game);
    dlg.sms = { countdown: 0, timer: null, needCaptcha: false };
    dlg.web = { waiting: false };
    dlg.gui = { waiting: false, opened: false, autoOpened: false };
    dlg.paste = { value: '', shown: false };

    $('#dlg-title').textContent = '添加账号 · ' + game.name + '（' + game.community + '）';
    $('#dlg-msg').textContent = ''; $('#dlg-msg').className = 'dialog-msg';

    // 动态面板：仅对当前游戏实际声明的 kind 创建面板（sms/paste 为静态面板；web/gui 按需动态创建）
    ['web', 'gui'].forEach((k) => {
      if ((game.loginMethods || []).some((m) => methodKind(m) === k)) ensurePanel(k);
    });

    // 网页登录窗口提示与降级按钮：仅在声明了 web 方式（对应面板已创建）时写入（不再无条件读写 #dlg-web-hint/#degrade-*）
    if ($('#panel-web')) {
      const webHintM = (game.loginMethods || []).find((m) => methodKind(m) === 'web' && m.hint);
      $('#dlg-web-hint').textContent = (webHintM && webHintM.hint) || '将打开官方登录页，请在窗口中按官方流程完成登录。';

      const hasMethod = { sms: false, paste: false };
      dlg.methods.forEach((m) => { if (!m.disabled && hasMethod[m.kind] !== undefined) hasMethod[m.kind] = true; });
      $('#degrade-sms-btn').classList.toggle('hidden', !hasMethod.sms);
      $('#degrade-paste-btn').classList.toggle('hidden', !hasMethod.paste);
    }

    const tabs = $('#dlg-methods');
    tabs.innerHTML = dlg.methods.map((m) =>
      '<button class="method-tab' + (m.disabled ? ' disabled' : '') + '" data-method="' + esc(m.id) + '">' + esc(m.label) + '</button>'
    ).join('');

    // 面板内容准备
    const pasteHint = $('#dlg-paste-hint');
    const pasteHintM = (game.loginMethods || []).find((m) => methodKind(m) === 'paste' && m.hint);
    pasteHint.textContent = (pasteHintM && pasteHintM.hint) || '粘贴登录凭据（token / Cookie），仅加密存储，不会明文回显。';
    $('#dlg-paste').value = '';
    $('#dlg-paste-show').checked = false;
    $('#dlg-paste').classList.add('masked');
    $('#dlg-mobile').value = '';
    $('#dlg-code').value = '';
    $('#dlg-send-code').disabled = false;
    $('#dlg-send-code').textContent = '发送验证码';
    $('#dlg-sms-login').disabled = false;
    // 网页面板：仅当它存在（当前游戏声明了 kind:'web'）时重置，避免对未创建的面板做空引用
    if ($('#panel-web')) {
      $('#dlg-web-status').textContent = ''; $('#dlg-web-status').className = 'web-status';
      $('#dlg-web-degrade').classList.add('hidden');
    }
    if ($('#panel-gui')) {
      $('#dlg-gui-status').textContent = ''; $('#dlg-gui-status').className = 'web-status';
      $('#dlg-gui-hint').textContent = '将在默认浏览器中打开「塔吉多·异环 登录界面」（密码/短信/粘贴 token 三方式）；登录成功后账号自动绑定到本应用。';
      $('#dlg-gui-open').disabled = false;
      $('#dlg-gui-open').textContent = '打开浏览器登录';
    }

    // 默认选中第一个可用方法
    const first = dlg.methods.find((m) => !m.disabled) || dlg.methods[0];
    selectMethod(first ? first.id : null);

    dlg.open = true;
    $('#login-modal').classList.remove('hidden');

    // 若插件把 kind:'gui'（浏览器登录）排在第一位，则点「添加账号」时自动帮用户打开浏览器登录页。
    // 注：三个官方插件都没把 gui 排在第一位，所以这段目前不会触发；保留它是为第三方插件服务。
    const firstAvail = dlg.methods.find((m) => !m.disabled);
    if (firstAvail && firstAvail.kind === 'gui' && !dlg.gui.autoOpened) {
      dlg.gui.autoOpened = true;
      startGuiLogin();
    }
  }

  function selectMethod(methodId) {
    const m = dlg.methods.find((x) => x.id === methodId);
    if (!m) return;
    renderDlgHelp(m);
    if (m.disabled) {
      setDlgMsg(m.hint || '该登录方式暂不可用', 'warn');
      return;
    }
    dlg.active = m.id;
    $$('#dlg-methods .method-tab').forEach((t) => t.classList.toggle('active', t.dataset.method === m.id));
    // 只切换「已存在/按需创建的面板」：确保当前 kind 面板存在（web/gui 动态创建），隐藏其余、显示当前
    const panel = ensurePanel(m.kind);
    $$('.method-panel').forEach((p) => p.classList.add('hidden'));
    if (panel) panel.classList.remove('hidden');
    setDlgMsg('', '');

    if (m.kind === 'web') {
      $('#dlg-web-status').textContent = '';
      $('#dlg-web-status').className = 'web-status';
    }
    if (m.kind === 'gui' && !dlg.gui.opened) {
      $('#dlg-gui-status').textContent = ''; $('#dlg-gui-status').className = 'web-status';
      const gb = $('#dlg-gui-open');
      if (gb) { gb.disabled = false; gb.textContent = dlg.gui.autoOpened ? '重新打开浏览器登录' : '打开浏览器登录'; }
    }
  }

  function setDlgMsg(text, type) {
    const el = $('#dlg-msg');
    el.textContent = text;
    el.className = 'dialog-msg' + (type ? ' ' + type : '');
  }

  function closeLoginDialog() {
    dlg.open = false;
    stopSmsCountdown();
    closeGuiServer();
    $('#login-modal').classList.add('hidden');
    $('#dlg-help').classList.add('hidden');
    dlg.game = null;
  }

  /* ---------- 短信验证码 ---------- */
  function startSmsCountdown(sec) {
    stopSmsCountdown();
    dlg.sms.countdown = sec;
    const btn = $('#dlg-send-code');
    const tick = () => {
      if (dlg.sms.countdown > 0) {
        btn.disabled = true;
        btn.textContent = '重新发送（' + dlg.sms.countdown + 's）';
        dlg.sms.countdown--;
        dlg.sms.timer = setTimeout(tick, 1000);
      } else {
        btn.disabled = false;
        btn.textContent = '发送验证码';
      }
    };
    tick();
  }

  function stopSmsCountdown() {
    if (dlg.sms.timer) { clearTimeout(dlg.sms.timer); dlg.sms.timer = null; }
  }

  async function onSendSms() {
    const mobile = $('#dlg-mobile').value.trim();
    if (!/^1[3-9]\d{9}$/.test(mobile)) { setDlgMsg('请输入正确的 11 位手机号', 'err'); return; }
    const btn = $('#dlg-send-code');
    btn.disabled = true;
    btn.textContent = '发送中…';
    const r = await invoke('login:sendSms', { game: dlg.game.id, mobile: mobile });
    if (!r.ok) { setDlgMsg(r.error || '验证码发送失败', 'err'); btn.disabled = false; btn.textContent = '发送验证码'; return; }
    if (r.needCaptcha) {
      // 极验/人机验证：本应用内无法完成（官方控件需渲染在页面里）。
      // 不要提示「改用扫码登录」——三个官方插件都没有扫码方式，那是条死路。
      // 可行的绕法：用手机上的官方 App 给同一手机号申请验证码，收到后把码填回本应用。
      const tip = '⚠️ 需要人机验证（极验），本应用内无法完成。请改用手机上的官方 App 给同一手机号发送验证码，收到后把 6 位验证码填回这里登录；或改用本游戏的其它登录方式。';
      setDlgMsg(tip, 'warn');
      toast(dlg.game.name + '：需要人机验证，请用手机 App 发码后回填', 'warn');
      btn.disabled = false; btn.textContent = '发送验证码';
      return;
    }
    startSmsCountdown(60);
    setDlgMsg(r.msg || '验证码已发送，请查收短信', 'ok');
  }

  async function onSmsLogin() {
    const mobile = $('#dlg-mobile').value.trim();
    const code = $('#dlg-code').value.trim();
    if (!/^1[3-9]\d{9}$/.test(mobile)) { setDlgMsg('请输入正确的 11 位手机号', 'err'); return; }
    if (!/^\d{4,8}$/.test(code)) { setDlgMsg('请输入正确的验证码', 'err'); return; }
    const btn = $('#dlg-sms-login');
    btn.disabled = true; btn.textContent = '登录中…';
    setDlgMsg('', '');
    const r = await invoke('login:sms', { game: dlg.game.id, mobile: mobile, code: code });
    btn.disabled = false; btn.textContent = '登录';
    if (r.ok && r.account) {
      setDlgMsg('✓ 登录成功，账号「' + (r.account.nickname || '') + '」已绑定', 'ok');
      toast('「' + dlg.game.name + '」账号添加成功', 'success');
      setTimeout(() => { closeLoginDialog(); refreshAccounts(); }, 500);
    } else {
      setDlgMsg(r.error || '登录失败，请稍后重试', 'err');
    }
  }

  /* ---------- 网页登录窗口 ---------- */
  /* 窗口打开后的提示：通用兜底（插件可经 web 方法 hint 提供细化文案） */
  const WEB_OPENED_TEXT_DEFAULT = '登录窗口已打开，请完成登录；成功后自动提取并绑定账号；无法绑定时会提示改用其他方式。';

  async function onWebOpen() {
    if (dlg.web.waiting) return;
    const btn = $('#dlg-web-open');
    btn.disabled = true; btn.textContent = '窗口打开中…';
    dlg.web.waiting = true;
    const st = $('#dlg-web-status');
    st.textContent = ''; st.className = 'web-status';
    $('#dlg-web-degrade').classList.add('hidden');
    const r = await invoke('login:webOpen', { game: dlg.game.id });
    if (!r.ok) {
      dlg.web.waiting = false;
      btn.disabled = false; btn.textContent = '打开网页登录窗口';
      st.textContent = r.error || '打开窗口失败'; st.className = 'web-status err';
      setDlgMsg(r.error || '打开网页登录窗口失败', 'err');
      return;
    }
    st.textContent = WEB_OPENED_TEXT_DEFAULT;
    st.className = 'web-status ok';
  }

  function handleWebLoginEvent(ev) {
    if (!dlg.open || !ev || ev.game !== dlg.game.id) return;
    const btn = $('#dlg-web-open');
    const st = $('#dlg-web-status');
    dlg.web.waiting = false;
    btn.disabled = false; btn.textContent = '打开网页登录窗口';

    if (ev.status === 'success' && ev.account) {
      st.textContent = '✓ 网页登录成功，正在绑定账号…'; st.className = 'web-status ok';
      setDlgMsg('✓ 登录成功，账号「' + (ev.account.nickname || '') + '」已绑定', 'ok');
      toast('「' + dlg.game.name + '」账号添加成功', 'success');
      setTimeout(() => { closeLoginDialog(); refreshAccounts(); }, 500);
      return;
    }
    if (ev.status === 'closed') {
      st.textContent = '登录窗口已关闭，可重新打开或改用其他方式。'; st.className = 'web-status';
      return;
    }
    // fail：明确降级提示（图标+原因+一键切换，仅显示该游戏可用的替代方式）
    st.textContent = ''; st.className = 'web-status';
    $('#dlg-web-degrade-reason').textContent = ev.error || '未能提取登录态（官方页面结构可能已变化）。';
    $('#dlg-web-degrade').classList.remove('hidden');
    const alts = dlg.methods.filter((m) => !m.disabled && m.kind !== 'web').map((m) => m.label);
    const alt = alts.length ? alts.join('、') : '其他方式';
    const tail = (alt === '其他方式' || alt.slice(-2) !== '登录') ? '登录' : '';
    setDlgMsg('网页登录暂不可用，请改用' + alt + tail, 'warn');
  }

  /* ---------- 浏览器登录（kind:'gui'）：本地 127.0.0.1 服务 + 系统默认浏览器打开 core/login-gui.html ---------- */
  async function startGuiLogin() {
    if (!dlg.open || !dlg.game) return;
    const btn = $('#dlg-gui-open');
    const st = $('#dlg-gui-status');
    if (!btn || !st) return;
    btn.disabled = true; btn.textContent = '正在打开浏览器…';
    st.textContent = ''; st.className = 'web-status';
    const r = await invoke('login:guiOpen', { game: dlg.game.id });
    if (!dlg.open || !dlg.game) return;
    dlg.gui.waiting = false;
    if (!r.ok) {
      btn.disabled = false; btn.textContent = '打开浏览器登录';
      st.textContent = r.error || '打开浏览器登录失败'; st.className = 'web-status err';
      setDlgMsg(r.error || '打开浏览器登录失败，请改用粘贴 token 登录', 'err');
      return;
    }
    dlg.gui.opened = true;
    btn.disabled = false; btn.textContent = '重新打开浏览器登录';
    const showUrl = String(r.url || '').split('?')[0];
    st.textContent = '✅ 已在默认浏览器打开登录界面（' + showUrl + '）。请在浏览器中选择「密码登录」（推荐）或「短信验证码」或「粘贴 token」完成登录；登录成功后账号会自动绑定到本应用。';
    st.className = 'web-status ok';
  }

  function closeGuiServer() {
    if (dlg.game && dlg.gui.opened) {
      dlg.gui.opened = false;
      invoke('login:guiClose', { game: dlg.game.id });
    }
  }

  function handleGuiLoginEvent(ev) {
    if (!dlg.open || !ev || ev.game !== dlg.game.id) return;
    const st = $('#dlg-gui-status');
    if (ev.status === 'success' && ev.account) {
      st.textContent = '✓ 浏览器登录成功，账号「' + (ev.account.nickname || '') + '」已绑定'; st.className = 'web-status ok';
      setDlgMsg('✓ 登录成功，账号「' + (ev.account.nickname || '') + '」已绑定', 'ok');
      toast('「' + dlg.game.name + '」账号添加成功', 'success');
      closeGuiServer();
      setTimeout(() => { closeLoginDialog(); refreshAccounts(); }, 500);
      return;
    }
    if (ev.status === 'closed') {
      st.textContent = '登录界面已关闭，可点「重新打开浏览器登录」。'; st.className = 'web-status';
      return;
    }
  }

  /* ---------- 粘贴登录 ---------- */
  async function onPasteLogin() {
    const raw = $('#dlg-paste').value;
    if (!raw.trim()) { setDlgMsg('请先粘贴凭据内容', 'err'); return; }
    const btn = $('#dlg-paste-login');
    btn.disabled = true; btn.textContent = '登录中…';
    setDlgMsg('', '');
    const r = await invoke('login:paste', { game: dlg.game.id, raw: raw.trim() });
    btn.disabled = false; btn.textContent = '登录';
    if (r.ok && r.account) {
      setDlgMsg('✓ 登录成功，账号「' + (r.account.nickname || '') + '」已绑定', 'ok');
      toast('「' + dlg.game.name + '」账号添加成功', 'success');
      setTimeout(() => { closeLoginDialog(); refreshAccounts(); }, 500);
    } else {
      setDlgMsg(r.error || '凭据无法识别，请检查后重试', 'err');
    }
  }

  /* ==================== 管理游戏脚本 ==================== */
  function openManageGames() {
    state.manageOpen = true;
    $('#manage-modal').classList.remove('hidden');
    renderManageGames();
  }
  function closeManageGames() {
    state.manageOpen = false;
    $('#manage-modal').classList.add('hidden');
  }
  async function refreshGames() {
    const g = await invoke('games:list');
    if (g.ok && Array.isArray(g.games)) { state.games = g.games; state.gameLoadErrors = g.loadErrors || []; }
    return g;
  }
  function renderManageGames() {
    const list = $('#manage-list');
    const errBox = $('#manage-errors');
    if (!list) return;
    if (errBox) {
      const errs = state.gameLoadErrors || [];
      errBox.className = 'manage-errors' + (errs.length ? '' : ' hidden');
      errBox.innerHTML = errs.map((e) =>
        '<div class="err-item">⚠️ ' + esc((e.idHint || '插件') + '：' + (Array.isArray(e.errors) ? e.errors.join('；') : (e.error || '校验失败'))) + '</div>'
      ).join('');
    }
    const rows = (state.games || []).map((g) => {
      const isUser = g.source === 'user';
      const ver = (g.meta && g.meta.version) ? g.meta.version : '—';
      const mlabels = availableMethodLabels(g).join(' / ') || '（无可用登录方式）';
      const badge = '<span class="m-badge ' + (isUser ? 'user' : 'builtin') + '">' + (isUser ? '用户插件' : '内置') + '</span>';
      const removeBtn = isUser
        ? '<button class="btn mini danger" data-mg-remove="' + esc(g.id) + '">删除</button>'
        : '<span class="m-builtin-note">内置，不可删</span>';
      return (
        '<div class="manage-row" data-mg-id="' + esc(g.id) + '">' +
          '<span class="m-icon">' + gameIcon(g) + '</span>' +
          '<div class="m-main">' +
            '<div class="m-name">' + esc(g.name || g.id) + ' ' + badge + '</div>' +
            '<div class="m-sub">' + esc(g.community || '') + ' · v' + esc(String(ver)) + ' · ' + esc(mlabels) + '</div>' +
          '</div>' +
          '<div class="m-actions">' + removeBtn + '</div>' +
        '</div>'
      );
    }).join('');
    list.innerHTML = rows || '<div class="empty-list">暂未发现任何游戏脚本</div>';
  }
  async function onManageAction(target) {
    const gameId = target.dataset.mgRemove;
    if (!gameId) return;
    const game = state.games.find((x) => x.id === gameId);
    if (!game || game.source !== 'user') { toast('仅用户插件可删除', 'warn'); return; }
    const ok = await confirmDialog('确定删除游戏「' + (game.name || gameId) + '」？将同时删除该游戏全部账号与调度设置（凭据不可恢复）。');
    if (!ok) return;
    const r = await invoke('games:remove', { gameId: gameId });
    if (r.ok) toast('已移除 ' + (game.name || gameId) + ' 及其账号/设置', 'success');
    else toast((r.error || '移除失败') + '；可手动删除插件目录后重启应用', 'warn');
    await refreshGames();
    renderManageGames();
    renderAccounts(); refreshAccounts();
  }
  async function onManageToolbar(action) {
    if (action === 'manage-import') {
      // games:add 不带 dir 时会弹系统文件夹选择框；选中插件文件夹后自动拷进脚本目录、校验并即时生效。
      const r = await invoke('games:add', {});
      if (r.ok) toast('已导入游戏脚本：' + ((r.game && r.game.name) || r.gameId || ''), 'success');
      else if (!r.canceled) toast(r.error || '导入失败', 'err');   // 用户取消选择框不报错
    }
    if (action === 'manage-open-dir') {
      const r = await invoke('games:openUserDir', {});
      if (r.ok) toast('已打开用户插件目录', 'success');
      else toast((r.error || '无法打开目录') + '；脚本目录位置见《使用教程-小白版》，或重启应用后重试', 'warn');
    }
    if (action === 'manage-reload') {
      const r = await invoke('games:reload', {});
      if (r.ok) toast('游戏列表已刷新', 'success');
      else toast((r.error || '刷新失败') + '；重启应用后新插件生效', 'warn');
    }
    await refreshGames();
    renderManageGames();
    renderAccounts();
  }

  /* ==================== 事件处理 ==================== */
  function handleLogEvent(ev) {
    if (!ev) return;
    appendLogLine(ev.time, ev.msg);
  }

  // 托盘隐藏/显示 —— 隐藏时清空日志流 DOM 降低常驻内存；显示时重拉最近日志
  // 注：窗口首次显示也会触发 show 事件，用 state._hiddenOnce 标记只在「真隐藏过」后重拉，避免启动时多余请求
  function handleVisibilityEvent(ev) {
    if (!ev) return;
    const stream = $('#log-stream');
    if (!stream) return;
    if (ev.visible === false) {
      state._hiddenOnce = true;
      // 释放日志流 DOM（签到日志已持久化到磁盘，不丢任何信息）
      stream.innerHTML = '';
    } else if (ev.visible === true && state._hiddenOnce) {
      // 恢复：仅当日历页展开日志时重拉（避免后台频繁请求）
      loadRecentLogs();
    }
  }

  function handleProgressEvent(ev) {
    if (!ev) return;
    if (ev.type === 'account-done') {
      const title = (ev.result && ev.result.title) || ev.summary || '签到完成';
      toast(title, ev.result && ev.result.ok ? 'success' : 'warn');
      refreshAccounts();
      if (state.page === 'calendar') loadCalendarPage();   // 刷新当天日历状态
    } else if (ev.type === 'game-done') {
      toast(gameName(ev.gameId) + ' 签到结束：成功 ' + ev.ok + ' / 失败 ' + ev.fail, ev.fail > 0 ? 'warn' : 'success');
      refreshAccounts();
      if (state.page === 'calendar') loadCalendarPage();   // 刷新当天日历状态
    }
  }

  /* ==================== 静态事件绑定 ==================== */
  function bindStaticEvents() {
    // 页面切换
    $$('.tab').forEach((t) => t.addEventListener('click', () => switchPage(t.dataset.page)));

    // 立即签到全部
    $('#btn-run-all').addEventListener('click', async (e) => {
      e.target.disabled = true;
      const r = await invoke('run:all', {});
      e.target.disabled = false;
      if (r.ok) toast('全部签到执行完成（结果见日志页）', 'success');
      else toast('执行失败：' + (r.error || ''), 'error');
      refreshAccounts();
    });

    // 账号管理页（事件委托）
    $('#game-cards').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-role]');
      if (!btn) return;
      if (btn.dataset.role === 'open-script-dir') { onManageToolbar('manage-open-dir'); return; }
      if (btn.dataset.role === 'refresh-scripts') { onManageToolbar('manage-reload'); return; }
      if (['run-account', 'run-game', 'remove-account', 'add-account'].indexOf(btn.dataset.role) >= 0) onAccountAction(btn);
    });
    $('#game-cards').addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.role === 'game-enabled' || t.dataset.role === 'account-enabled') onAccountAction(t);
      else if (t.dataset.role === 'game-time') onGameTimeChange(t);
      else if (t.dataset.role === 'account-time') onAccountTimeChange(t);
    });

    // 时间即改即存
    $('#set-default-time').addEventListener('change', onDefaultTimeChange);
    $('#set-autostart').addEventListener('change', (e) => onAutostartToggle(e.target.checked));
    $('#set-systask').addEventListener('change', (e) => onSystaskToggle(e.target.checked));

    const cbEl = $('#set-close-behavior');
    if (cbEl) cbEl.addEventListener('change', (e) => onCloseBehaviorChange(e.target.value));

    // 签到日历
    $('#cal-prev').addEventListener('click', () => moveCalMonth(-1));
    $('#cal-next').addEventListener('click', () => moveCalMonth(1));
    $('#cal-today').addEventListener('click', calGoToday);
    // 点任意日历格子 → 显示该游戏该日明细
    document.addEventListener('click', (e) => {
      const cell = e.target.closest('.cal-day[data-clickable]');
      if (cell) {
        const g = cell.dataset.game;
        const d = cell.dataset.date;
        if (g && d) showDayDetail(g, d);
      }
    });
    $('#log-autoscroll').addEventListener('change', () => { if ($('#log-autoscroll').checked) scrollLogToBottom(); });

    // 通知设置页
    $('#btn-save-notify').addEventListener('click', saveNotify);
    $$('.btn-test').forEach((b) => b.addEventListener('click', () => testNotify(b.dataset.channel)));
    // QQ 机器人绑定
    $('#btn-qqbot-bind').addEventListener('click', bindQqbot);
    $('#btn-qqbot-cancel').addEventListener('click', async () => {
      await invoke('qqbot:bind:cancel');
      stopQqbotPoll();
      refreshQqbotStatus();
    });

    // 登录弹窗
    $('#dlg-close').addEventListener('click', closeLoginDialog);
    $('#dlg-methods').addEventListener('click', (e) => {
      const t = e.target.closest('.method-tab');
      if (t) selectMethod(t.dataset.method);
    });
    $('#dlg-send-code').addEventListener('click', onSendSms);
    $('#dlg-sms-login').addEventListener('click', onSmsLogin);
    // web/gui 面板事件随面板动态创建时绑定（见 bindDynamicPanelEvents），不再静态绑定
    $('#dlg-paste-login').addEventListener('click', onPasteLogin);
    $('#dlg-paste-show').addEventListener('change', (e) => {
      $('#dlg-paste').classList.toggle('masked', !e.target.checked);
    });

    // 管理游戏脚本
    $('#btn-manage-games').addEventListener('click', openManageGames);
    $('#manage-close').addEventListener('click', closeManageGames);
    $('#manage-import').addEventListener('click', () => onManageToolbar('manage-import'));
    $('#manage-open-dir').addEventListener('click', () => onManageToolbar('manage-open-dir'));
    $('#manage-reload').addEventListener('click', () => onManageToolbar('manage-reload'));
    $('#manage-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mg-remove]');
      if (btn) onManageAction(btn);
    });
    $('#manage-modal').addEventListener('click', (e) => { if (e.target.id === 'manage-modal') closeManageGames(); });
    // 关于弹窗
    $('#app-version').addEventListener('click', openAbout);
    $('#about-close').addEventListener('click', closeAbout);
    $('#about-ok').addEventListener('click', closeAbout);
    $('#about-modal').addEventListener('click', (e) => { if (e.target.id === 'about-modal') closeAbout(); });
    // 弹窗内 Enter 快捷提交
    $('#login-modal').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const t = e.target;
      if (t.id === 'dlg-code') onSmsLogin();
      else if (t.id === 'dlg-mobile') onSendSms();
    });
    // 点击遮罩关闭
    $('#login-modal').addEventListener('click', (e) => { if (e.target.id === 'login-modal') closeLoginDialog(); });
  }

  /* ==================== 启动 ==================== */
  document.addEventListener('DOMContentLoaded', init);
})();
