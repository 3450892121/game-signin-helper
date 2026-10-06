'use strict';
/**
 * 存储模块：全局设置 + 账号清单（%APPDATA%/签到助手 或注入的 dataDir）
 *
 * 文件：
 * settings.json 全局设置（默认签到时间、每游戏开关/时间、通知渠道、自启、系统任务）
 * accounts.json 账号清单（凭据字段整体加密存储）
 *
 * 加密：通过 init 注入 { encrypt, decrypt }（Electron 主进程用 safeStorage 实现）；
 * 未注入时明文存储并标记 credentials.plain=true（开发模式，UI 提示）。
 * 加解密失败时降级明文并保留数据不丢失。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// t7：DEFAULT_SETTINGS.games 不再硬编码三游戏——由「已安装游戏供应器」在 loadSettings 时动态并入
// （未接入注册表时无已安装游戏；接入后仅出现已安装插件）。
const DEFAULT_SETTINGS = {
  defaultTime: '06:00',                       // 全局默认签到时间（HH:mm）
  games: {},                                 // 每游戏独立开关与时间（由 installed 供应器动态生成，见 loadSettings）
  notify: {                                   // 失败告警渠道（留空关闭）
    serverchan: { sendKey: '' },
    pushplus: { token: '', template: 'html' },
    wecom: { webhook: '' },
    email: { smtpHost: '', smtpPort: '', user: '', pass: '', to: '' },   // t15：SMTP 邮箱渠道（零依赖 net/tls）
    qqbot: { appId: '', appSecret: '', openid: '' },                     // QQ 机器人每日签到日报（openid 由绑定写入）
  },
  autoStart: true,                            // 开机自启 + 托盘常驻
  useSystemTask: false,                       // 是否同步写入 Windows 计划任务
  closeBehavior: 'tray',                      // t13：关闭窗口行为二选一：'tray'=隐藏到托盘(默认,后台常驻) / 'exit'=直接退出(不再后台常驻)
};

/** HH:mm 校验/规范化（内部与导出共用） */
function validHHmm(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

/** 账号生效时间三级回退：账号时间 → 游戏统一时间 → 全局统一时间
 * 返回规范化 'HH:mm' 或 ''（都未设置）。settings 用 loadSettings 结果。 */
function effectiveTimeFor(account, settings) {
  settings = settings || {};
  const gs = (settings.games || {})[account && account.game] || {};
  const candidates = [
    account && account.time,
    gs.time,
    settings.defaultTime,
  ];
  for (const c of candidates) {
    const t = validHHmm(c);
    if (t) return t;
  }
  return '';
}

/** 通知渠道密钥字段名（主进程 settings:save / notify:test 与本模块共用，单源定义，勿散落各处手抄） *//** 通知渠道密钥字段名（主进程 settings:save / notify:test 与本模块共用，单源定义，勿散落各处手抄） */
const NOTIFY_SECRET_FIELDS = { serverchan: 'sendKey', pushplus: 'token', wecom: 'webhook', email: 'pass', qqbot: 'appSecret' };
function defaultDataDir() {
  return path.join(process.env.APPDATA || path.join(require('os').homedir(), '.config'), '签到助手');
}

function create(dataDir, opts) {
  opts = opts || {};
  dataDir = dataDir || defaultDataDir();
  const enc = opts.encrypt || null;   // (plainText) => cipherText
  const dec = opts.decrypt || null;   // (cipherText) => plainText

  // t7：已安装游戏来源（主进程把注册表 list 传入；约定 opts.installedGames 可取
  // 函数或数组：函数返回 [{id, defaultEnabled, time?}] 或 {id:{enabled,time}}；缺省 = 空（无已安装游戏））
  const installedSource = (typeof opts.installedGames === 'function')
    ? opts.installedGames
    : (opts.installedGames != null ? (() => opts.installedGames) : (() => ({})));

  /** 规范化已安装来源 → [{ id, defaults:{enabled,time} }] */
  function normalizeInstalled(src) {
    const out = [];
    if (Array.isArray(src)) {
      for (const it of src) {
        if (!it || !it.id) continue;
        let d;
        if (it.defaults && typeof it.defaults === 'object') d = it.defaults;
        else if (it.defaultEnabled !== undefined) d = { enabled: it.defaultEnabled === true, time: it.time || '' };
        else if (it.enabled !== undefined) d = { enabled: !!it.enabled, time: it.time || '' };
        else d = { enabled: false, time: '' };
        out.push({ id: it.id, defaults: { enabled: d.enabled !== false, time: d.time || '' } });
      }
    } else if (src && typeof src === 'object') {
      for (const id of Object.keys(src)) out.push({ id, defaults: Object.assign({}, src[id] || {}) });
    }
    return out;
  }

  let lastInstalledRaw = null;   // 上次成功的已安装来源快照（来源抛异常时兜底，防 games 被剪空后随任意保存落盘）
  /** 当前已安装游戏列表（每次 load 重取，支持运行时插件增删即时反映） */
  function resolveInstalled() {
    let raw;
    try {
      raw = installedSource();
      lastInstalledRaw = raw;
    } catch (e) {
      raw = (lastInstalledRaw != null) ? lastInstalledRaw : {};
    }
    return normalizeInstalled(raw);
  }

  function ensureDir() {
    try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { console.error('[storage] 创建数据目录失败：' + dataDir + ' — ' + ((e && e.message) || e)); }
  }
  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
  }
  function writeJson(file, obj) {
    ensureDir();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    try { fs.chmodSync(tmp, 0o600); } catch (e) { console.error('[storage] 设置文件权限失败：' + tmp + ' — ' + ((e && e.message) || e)); }
    fs.renameSync(tmp, file);
  }

  // ---------- 设置（R5：通知密钥字段同样走加密注入，settings.json 不落明文密钥） ----------


  function encryptSettingsSecrets(s) {
    if (!enc || !s || !s.notify) return s;
    const out = Object.assign({}, s, { notify: {} });
    for (const [k, v] of Object.entries(s.notify || {})) {
      const field = NOTIFY_SECRET_FIELDS[k];
      if (field && v && v[field]) {
        try {
          out.notify[k] = Object.assign({}, v, { [field]: { __enc: true, v: enc(String(v[field])) } });
        } catch (e) {
          out.notify[k] = Object.assign({}, v); // 加密失败：保留原值（与账号凭据降级策略一致）
        }
      } else {
        out.notify[k] = Object.assign({}, v || {});
      }
    }
    return out;
  }

  function decryptSettingsSecrets(s) {
    if (!s || !s.notify) return s;
    const out = Object.assign({}, s, { notify: {} });
    for (const [k, v] of Object.entries(s.notify || {})) {
      const field = NOTIFY_SECRET_FIELDS[k];
      if (field && v && v[field] && v[field].__enc) {
        let val = '';
        try { val = dec ? dec(v[field].v) : ''; } catch (e) { val = ''; }
        out.notify[k] = Object.assign({}, v, { [field]: val });
      } else {
        out.notify[k] = Object.assign({}, v || {});
      }
    }
    return out;
  }

  function loadSettings() {
    const s = readJson(path.join(dataDir, 'settings.json'), {});
    const merged = Object.assign({}, DEFAULT_SETTINGS, s);
    // t7：每游戏开关/时间由「已安装游戏」动态生成；已保存值覆盖默认，未安装键自动清除（§6 孤儿清理）
    const games = {};
    for (const g of resolveInstalled()) {
      games[g.id] = Object.assign({}, g.defaults, (s.games || {})[g.id] || {});
      if (!('enabled' in games[g.id])) games[g.id].enabled = g.defaults.enabled;
      // 插件/已存游戏时间晚于全局统一时间时钳制为全局（保证「全局最晚」兜底不变量）
      const gt = validHHmm(games[g.id].time);
      const dt = validHHmm(merged.defaultTime);
      if (gt && dt && gt > dt) games[g.id].time = dt;
    }
    merged.games = games;
    merged.notify = Object.assign({}, DEFAULT_SETTINGS.notify, s.notify || {});
    return decryptSettingsSecrets(merged);
  }
  function saveSettings(s) {
    writeJson(path.join(dataDir, 'settings.json'), encryptSettingsSecrets(s));
  }

  // ---------- 账号 ----------
  function encryptCredentials(account) {
    if (!account.credentials) return account;
    if (enc) {
      try {
        return Object.assign({}, account, { credentials: { __enc: true, v: enc(JSON.stringify(account.credentials)) } });
      } catch (e) {
        return Object.assign({}, account, { credentials: Object.assign({ plain: true }, account.credentials) });
      }
    }
    return Object.assign({}, account, { credentials: Object.assign({ plain: true }, account.credentials) });
  }

  function decryptCredentials(account) {
    if (!account || !account.credentials) return account;
    const c = account.credentials;
    if (c.__enc) {
      if (!dec) return Object.assign({}, account, { credentials: null, _decryptFailed: true });
      try {
        return Object.assign({}, account, { credentials: JSON.parse(dec(c.v)) });
      } catch (e) {
        return Object.assign({}, account, { credentials: null, _decryptFailed: true });
      }
    }
    const { plain, ...rest } = c;
    return Object.assign({}, account, { credentials: rest });
  }

  function loadAccounts() {
    const list = readJson(path.join(dataDir, 'accounts.json'), []);
    if (!Array.isArray(list)) return [];
    return list.map(decryptCredentials);
  }

  function saveAccounts(list) {
    writeJson(path.join(dataDir, 'accounts.json'), list.map(encryptCredentials));
  }

  /**
 * 增删改查（供 runner/UI 使用）
 * upsertAccount(account)：按 id 覆盖或新增（加密存储）
 * removeAccount(id)
 * getAccountsByGame(gameId)：某游戏全部账号（含禁用）
 */
  function upsertAccount(account) {
    const list = loadAccounts();
    const idx = list.findIndex(a => a.id === account.id);
    if (idx >= 0) list[idx] = account;
    else list.push(account);
    saveAccounts(list);
    return account;
  }

  function removeAccount(id) {
    const list = loadAccounts().filter(a => a.id !== id);
    saveAccounts(list);
  }

  function getAccountsByGame(gameId) {
    return loadAccounts().filter(a => a.game === gameId);
  }

  /** 移除游戏数据（t7：配合注册表 removePlugin / games:remove 通道）
 * 清理：该游戏全部账号（含加密凭据）→ settings.games[gameId]
 * @returns {{removedAccounts:number, settingsRemoved:boolean}} */
  function removeGameData(gameId) {
    // 单次读写批量删除：避免逐账号「读全量→过滤→写全量」的 O(n²) 与非原子风险
    const list = loadAccounts();
    const remaining = list.filter(a => a.game !== gameId);
    const removedAccounts = list.length - remaining.length;
    saveAccounts(remaining);
    const s = loadSettings();
    let settingsRemoved = false;
    if (s.games && Object.prototype.hasOwnProperty.call(s.games, gameId)) {
      delete s.games[gameId];
      saveSettings(s);
      settingsRemoved = true;
    }
    // 该游戏的持久化设备指纹一并清掉（插件都卸载了，指纹没有意义）
    const fps = loadFingerprints();
    if (Object.prototype.hasOwnProperty.call(fps, String(gameId))) {
      delete fps[String(gameId)];
      try { writeJson(fingerprintsFile(), fps); } catch (e) { /* 清理失败不阻断卸载 */ }
    }
    return { removedAccounts, settingsRemoved };
  }

  // ---------- 设备指纹（按游戏持久化） ----------
  // 为什么需要：有些社区（如塔吉多）的发码/登录接口对「同一账号反复换设备标识」有风控。
  // 首次登录没有已有账号可借指纹，此时生成全新随机指纹正落在风控高发场景
  // （要收到验证码得先有账号可借指纹，要有账号得先收到验证码）。
  // 所以按游戏存一份到 <dataDir>/fingerprints.json：首次生成后立即持久化，之后每次登录都复用同一份。
  function fingerprintsFile() { return path.join(dataDir, 'fingerprints.json'); }

  function loadFingerprints() {
    const m = readJson(fingerprintsFile(), {});
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  }

  /** 取某游戏已持久化的指纹；没有或不完整则返回 null */
  function getFingerprint(gameId) {
    if (!gameId) return null;
    const fp = loadFingerprints()[String(gameId)];
    return (fp && fp.deviceid && fp.openudid && fp.vendorid) ? fp : null;
  }

  /** 存某游戏的指纹（只保留三个字段，多余字段丢弃）；成功返回 true */
  function saveFingerprint(gameId, fp) {
    if (!gameId || !fp || !fp.deviceid || !fp.openudid || !fp.vendorid) return false;
    const all = loadFingerprints();
    all[String(gameId)] = { deviceid: fp.deviceid, openudid: fp.openudid, vendorid: fp.vendorid };
    try { writeJson(fingerprintsFile(), all); return true; } catch (e) { return false; }
  }

  /** 加密状态（供 UI 提示：凭据是否加密存储） */
  function getEncryptionState() {
    return {
      available: !!enc,
      mode: enc ? 'encrypted' : 'plain',
      // accounts.json 中是否存在明文标记（plain:true 的凭据）
      hasPlainFlag: (function () {
        try {
          const list = readJson(path.join(dataDir, 'accounts.json'), []);
          return Array.isArray(list) && list.some(a => a.credentials && a.credentials.plain === true);
        } catch (e) { return false; }
      })(),
    };
  }

  return {
    dataDir,
    loadSettings, saveSettings,
    loadAccounts, saveAccounts,
    upsertAccount, removeAccount, getAccountsByGame,
    removeGameData,
    getFingerprint, saveFingerprint,
    getEncryptionState,
    DEFAULT_SETTINGS,
    validHHmm,
    effectiveTimeFor,
  };
}

/** 简易随机 id */
function newId() { return crypto.randomBytes(6).toString('hex'); }

module.exports = { create, defaultDataDir, newId, NOTIFY_SECRET_FIELDS, validHHmm, effectiveTimeFor };