'use strict';
/**
 * 塔吉多（异环）协议模块
 *
 * 接口来源：SkyBlue997/tjd-daily（MIT）、Loping151/TGDSign、Candy-QAQ/NTE-Auto-Sign
 * - 老虎(laohu)账号体系：POST https://user.laohu.com/openApi/sms/new/login 等
 * - BBS 换 token ：POST https://bbs-api.tajiduo.com/usercenter/api/login
 * - token 续期 ：POST https://bbs-api.tajiduo.com/usercenter/api/refreshToken
 *
 * 登录（短信为推荐主路）：
 *   genFingerprint → { deviceid, openudid, vendorid } // 生成设备指纹
 *   reuseFingerprint(oldCfg) → 同上 // 优先复用已绑定账号的指纹
 *   sendSmsCode(mobile, fp) → { ok, msg } // 发送短信验证码
 *   loginBySms(mobile, code, fp) → credentials // 短信验证码登录（推荐）
 *   loginByPaste(token, fp, oldCred) → credentials // 粘贴抓包 token（兜底，无自动续期）
 *   另有 kind:'gui' 的「浏览器登录」：由框架 core/browser-login.js 起本地页面，内部调的仍是上面
 *   同一对 sendSmsCode/loginBySms 与 loginByPaste，属功能重复的兜底入口。
 *
 * 不提供密码登录：本插件 loginMethods 没有 kind:'password'，框架也没有这条分发路径。
 * 注：POST /openApi/secureLogin 接口本身可用（tjd-daily 至今把它列为推荐路径）；
 * 要接入需同时补 kind:'password' 声明与浏览器登录页的密码 tab。
 *
 * 凭据（credentials）：{ token, refreshToken, deviceid, openudid, vendorid, uid,
 * phone?, account_uid?, loginAt, source }
 *
 * 签到：
 * signin(account) → { result, credentialsUpdate }
 * - 按需刷新：正常签到直接用现有 accessToken，
 * 绝不主动刷新 refreshToken（主动刷新会轮换并作废旧 token，顶掉 App/游戏会话）；仅当接口返回
 * 401/402（token 已失效）时才刷新重试一次
 * - 社区签到 + 自动遍历全部绑定游戏的角色签到
 */

const https = require('https');
const crypto = require('crypto');

// ── 协议常量（App 不升级就不变）──────────────────────────────────────────────
const LAOHU_HOST = 'user.laohu.com';      // 老虎账号体系
const BBS_HOST   = 'bbs-api.tajiduo.com'; // 塔吉多社区
const APP_ID     = '10551';
const BID        = 'com.pwrd.htassistant';
const CHANNEL_ID = '2';
const SDK_VER    = '4.131.0';
const APP_VER    = '1.2.2';
const LH_SECRET  = '5fd254cc0c8740d7a57376415ce40ede'; // laohu sign 密钥
const AES_KEY    = Buffer.from('a57376415ce40ede', 'ascii'); // AES-128-ECB key
const BBS_SECRET = 'pUds3dfMkl';          // bbs-api ds 签名密钥
const UA_LH      = 'HTAssistant/1.2.2 (iPhone; iOS 26.1; Scale/3.00)';
const UA_BBS     = 'HTAssistant/106 CFNetwork/3860.200.71 Darwin/25.1.0';
const H5_ORIGIN  = 'https://webstatic.tajiduo.com';
const H5_UA      = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ALPH       = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const COMMUNITY_ID = '2'; // 2 = 异环社区（与用户原版 异环_signin.js 一致；开源 NTE 用 1 是另一协议，不用）
const SIGN_REWARDS = '/apihub/awapi/sign/rewards';

// ── 小工具 ───────────────────────────────────────────
function uuid() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
}

function genFingerprint() {
  return {
    deviceid: crypto.randomBytes(16).toString('hex').toUpperCase(),
    openudid: uuid(),
    vendorid: uuid(),
  };
}


/** 复用设备指纹：oldCfg 里 deviceid/openudid/vendorid 三个字段齐全就原样返回，否则生成新的。
 * 动机（外部依据，非本仓实测）：SkyBlue997/tjd-daily 注明「同账号每次登录建议复用同一份指纹」、
 * 「--new-device 老账号慎用，可能触发风控」。
 * 框架侧 main.js 的 makeLoginCtx 会按「同游戏已有账号凭据 → 按游戏持久化的 fingerprints.json →
 * 新生成并立即持久化」的顺序把 seed 喂给本函数，所以首次登录之后就不会再每次换指纹了。 */
function reuseFingerprint(oldCfg) {
  if (oldCfg && oldCfg.deviceid && oldCfg.openudid && oldCfg.vendorid) {
    return { deviceid: oldCfg.deviceid, openudid: oldCfg.openudid, vendorid: oldCfg.vendorid };
  }
  return genFingerprint();
}
function makeDs() {
  const ts = String(Math.floor(Date.now() / 1000));
  let nonce = '';
  for (let i = 0; i < 8; i++) nonce += ALPH[Math.floor(Math.random() * ALPH.length)];
  const sig = crypto.createHash('md5').update(ts + nonce + APP_VER + BBS_SECRET).digest('hex');
  return `${ts},${nonce},${sig}`;
}

function laohuSign(params) {
  const keys = Object.keys(params).sort();
  const concat = keys.map(k => String(params[k])).join('');
  return crypto.createHash('md5').update(concat + LH_SECRET).digest('hex');
}

function laohuEncrypt(plaintext) {
  const cipher = crypto.createCipheriv('aes-128-ecb', AES_KEY, null);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return enc.toString('base64');
}

function baseParams(deviceid, openudid, vendorid, tMs) {
  return {
    adid: deviceid, adm: '', appId: APP_ID, bid: BID, channelId: CHANNEL_ID,
    deviceId: deviceid, iOSAppOnMac: '0', mac: deviceid, openudid,
    osType: '1', sdkVersion: SDK_VER,
    t: String(tMs ? Date.now() : Math.floor(Date.now() / 1000)),
    vendorid, version: APP_VER,
  };
}

function maskPhone(p) {
  const s = String(p || '');
  return s.length >= 7 ? s.slice(0, 3) + '****' + s.slice(-4) : s;
}

// ── HTTP ─────────────────────────────────────────────
function httpRequest(host, port, pathname, headers, bodyStr, method) {
  return new Promise((resolve, reject) => {
    // 对照异环_signin.js request：带 body 时自动补 Content-Type（表单编码），
    // 否则 /apihub/api/signin 等 POST 缺 Content-Type 头 → 服务器无法解析 body 返回 code=1「系统错误」
    const h = Object.assign({ 'Content-Length': Buffer.byteLength(bodyStr || '') }, headers || {});
    if (bodyStr && !h['Content-Type']) h['Content-Type'] = 'application/x-www-form-urlencoded';
    const req = https.request({
      hostname: host, port, path: pathname, method: method || 'POST',
      headers: h,
      timeout: 30000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function httpGet(host, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, port: 443, path: pathname, method: 'GET',
      headers, timeout: 30000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

function form(data) {
  return Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    .join('&');
}

function isOk(j) { return j && j.ok && j.code === 0; }

function jsonOrNull(body) { try { return JSON.parse(body); } catch (e) { return null; } }

// ── 老虎登录 ─────────────────────────────────────────
async function laohuPost(pathname, params) {
  const body = Object.assign({}, params);
  body.sign = laohuSign(body);
  const res = await httpRequest(LAOHU_HOST, 443, pathname,
    { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA_LH, 'Host': LAOHU_HOST },
    form(body));
  const j = jsonOrNull(res.body);
  if (!j) return { code: -1, message: '响应非 JSON: ' + res.body.slice(0, 300) };
  return j;
}

/** 1) 发送短信验证码 */
async function sendSmsCode(mobile, fp) {
  const p = baseParams(fp.deviceid, fp.openudid, fp.vendorid);
  p.areaCodeId = '1'; p.cellphone = String(mobile); p.type = '18';
  const j = await laohuPost('/m/newApi/sendPhoneCaptchaWithOutLogin', p);
  if (j.code === 0) return { ok: true, msg: j.message || '验证码已发送' };
  return { ok: false, msg: (j.message || '发送失败') + '(code=' + j.code + ')' };
}

/** 2a) 短信验证码登录（安卓设备参数，对齐开源 NTE：Pixel 6 / sdk 4.327.0） */
async function step2SmsLogin(phone, sms, fp) {
  const p = baseParams(fp.deviceid, fp.openudid, fp.vendorid, true);
  Object.assign(p, {
    areaCodeId: '1',
    captcha: laohuEncrypt(sms),
    cellphone: laohuEncrypt(phone),
    deviceModel: 'iPhone', deviceName: 'iPhone', deviceSys: '26.1',
    deviceType: 'iPhone17,2', idfa: '00000000-0000-0000-0000-000000000000',
    type: '18',
  });
  return laohuPost('/openApi/sms/new/login', p);
}

/** 3) laohu token 换 BBS accessToken（与原版一致：appId=10551 + iOS 平台） */
async function step3BbsLogin(laohuToken, userId, deviceid) {
  const body = form({ token: laohuToken, userIdentity: String(userId), appId: APP_ID });
  const res = await httpRequest(BBS_HOST, 443, '/usercenter/api/login', {
    'Accept': 'application/json, text/plain, */*',
    'Authorization': '',
    'appversion': APP_VER,
    'platform': 'ios',
    'uid': '0',
    'deviceid': deviceid,
    'ds': makeDs(),
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': UA_BBS,
    'Host': BBS_HOST,
  }, body);
  const j = jsonOrNull(res.body);
  if (!j) return { ok: false, message: '响应非 JSON（前80字符）：' + res.body.slice(0, 80) };   // 收敛原文片段
  return j;
}

/** 登录失败摘要：只取 message/code 回显 UI，避免把完整响应（可能含 token/refreshToken）弹给用户 */
function failSummary(j) {
  if (!j || typeof j !== 'object') return '响应非 JSON';
  const msg = j.message || j.msg || j.errMsg || j.error || '';
  const code = (j.code !== undefined && j.code !== null) ? ('(code=' + j.code + ')') : '';
  return String(msg || '登录失败') + code;
}

/** 把 laohu 登录结果 + BBS 换 token 结果组装成凭据 */
async function buildCredentials(phone, fp, laohuResult, source) {
  if (!laohuResult || laohuResult.code !== 0) {
    throw new Error('登录失败：' + failSummary(laohuResult));
  }
  const laohuToken = laohuResult.result && laohuResult.result.token;
  const userId = laohuResult.result && laohuResult.result.userId;
  if (!laohuToken) throw new Error('登录响应缺少 token：' + failSummary(laohuResult));

  const bbs = await step3BbsLogin(laohuToken, userId, fp.deviceid);
  if (!bbs || !bbs.ok) throw new Error('BBS 登录失败：' + failSummary(bbs));
  const d = bbs.data || {};
  const accessToken = d.accessToken;
  if (!accessToken) throw new Error('响应缺少 accessToken：' + failSummary(bbs));

  return {
    token: accessToken,
    refreshToken: d.refreshToken || '',
    deviceid: fp.deviceid,
    openudid: fp.openudid,
    vendorid: fp.vendorid,
    uid: d.uid !== undefined && d.uid !== null ? String(d.uid) : '0',
    phone: String(phone),
    loginAt: new Date().toISOString(),
    source,
  };
}

/**
 * 手机号 + 短信验证码登录
 * @param {object} fp 设备指纹（genFingerprint 或已有凭据中的）
 */
async function loginBySms(mobile, code, fp) {
  const j = await step2SmsLogin(mobile, code, fp);
  return buildCredentials(mobile, fp, j, 'sms');
}

/**
 * 粘贴抓包 token（Authorization 头内容，可整段 JSON）
 * @param {string} raw 纯 token 或 JSON（{token, refreshToken?, deviceid?, uid?}）
 * @param {object} fp 设备指纹
 * @param {object} [oldCred] 已有凭据（复用 uid/refreshToken）
 */
async function loginByPaste(raw, fp, oldCred) {
  let token = String(raw || '').trim();
  let uid = (oldCred && oldCred.uid) || '0';
  let refreshToken = (oldCred && oldCred.refreshToken) || '';
  const t = token;
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      token = j.token || j.accessToken || '';
      if (j.deviceid) fp.deviceid = j.deviceid;
      if (j.uid) uid = String(j.uid);
      if (j.refreshToken) refreshToken = j.refreshToken;
    } catch (e) { /* 按纯 token 处理 */ }
  }
  if (!token) throw new Error('token 为空');
  return {
    token,
    refreshToken,
    deviceid: fp.deviceid,
    openudid: fp.openudid,
    vendorid: fp.vendorid,
    uid,
    phone: (oldCred && oldCred.phone) || '',
    loginAt: new Date().toISOString(),
    source: 'paste',
  };
}

// ── 签到 ─────────────────────────────────────────────
function signResult(level, status, title, lines, reward) {
  return {
    ok: level === 'success' || level === 'info',
    level,
    status,
    title,
    lines: lines || [],
    reward: reward || '',
  };
}

// 原生壳请求头（签到 native 接口：android 平台 + ds 签名 + debug-uid，对齐开源 NTE）
function nativeHeaders(cfg) {
  return {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': UA_BBS,
    'Authorization': cfg.token,
    'appversion': APP_VER,
    'platform': 'ios',
    'uid': cfg.uid || '0',
    'deviceid': cfg.deviceid || '',
    'ds': makeDs(),
  };
}

// H5/WebView 请求头
function h5Headers(cfg) {
  return {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': H5_UA,
    'Authorization': cfg.token,
    'Origin': H5_ORIGIN,
    'Referer': H5_ORIGIN + '/',
  };
}

// 用 refreshToken 换新 accessToken（成功时更新 cfg 并返回 true）
async function refreshAndSave(cfg) {
  if (!cfg.refreshToken) { return { ok: false, msg: '配置缺少 refreshToken，无法自动续期' }; }
  const r = await httpRequest(BBS_HOST, 443, '/usercenter/api/refreshToken', {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': UA_BBS,
    'Authorization': cfg.refreshToken,
    'appversion': APP_VER,
    'platform': 'ios',
    'uid': cfg.uid || '0',
    'deviceid': cfg.deviceid || '',
    'ds': makeDs(),
    'Content-Type': 'application/x-www-form-urlencoded',
  }, '');
  const j = jsonOrNull(r.body);
  if (isOk(j) && j.data && j.data.accessToken && j.data.refreshToken) {
    cfg.token = j.data.accessToken;
    cfg.refreshToken = j.data.refreshToken;
    if (j.data.uid) cfg.uid = String(j.data.uid);
    return { ok: true, msg: '' };
  }
  if (r.status === 402) return { ok: false, msg: 'refreshToken 已失效，请重新登录' };
  return { ok: false, msg: 'token 续期失败：' + ((j && (j.msg || j.message)) || r.body.slice(0, 200)) };
}

// 查询游戏签到奖励
async function getGameReward(cfg, gid, rid, days) {
  try {
    const q = SIGN_REWARDS + '?gameId=' + encodeURIComponent(gid) + (rid ? '&roleId=' + encodeURIComponent(rid) : '');
    const r = await httpGet(BBS_HOST, q, h5Headers(cfg));
    const j = JSON.parse(r.body);
    if (!isOk(j)) return '';
    let list = j.data;
    if (!Array.isArray(list) && list && typeof list === 'object') {
      for (const k of ['items', 'rewards', 'list']) { if (Array.isArray(list[k])) { list = list[k]; break; } }
    }
    if (!Array.isArray(list)) return '';
    const item = list[days - 1];
    if (!item) return '';
    const name = String(item.name || item.itemName || item.title || '').trim();
    if (!name) return '';
    const num = item.num !== undefined ? item.num : (item.count !== undefined ? item.count : item.quantity);
    return (num === undefined || num === null || String(num).trim() === '') ? name : name + ' ×' + num;
  } catch (e) { return ''; }
}

/**
 * 执行异环签到（社区签到 + 全部绑定游戏的角色签到）
 * @param {{credentials:object, nickname?:string}} account
 * @returns {Promise<{result:object, credentialsUpdate:object|null}>}
 */
async function signin(account) {
  const cfg = Object.assign({}, account.credentials || {});
  const lines = [];
  const update = {};
  let dirty = false;

  const token = cfg.token;
  if (!token) {
    return { result: signResult('error', 'failed', '❌ 配置缺少 token，请重新登录', ['配置缺少 token']), credentialsUpdate: null };
  }

  // 不要每次运行前主动刷新 refreshToken！
  // 原因：refreshToken 是轮换、单会话的，主动调 /usercenter/api/refreshToken
  // 会作废旧 refreshToken 并重新签发，使 App/游戏里基于旧 token 的活跃会话失效（账号被顶下线）。
  // 正确做法：正常签到直接用现有 accessToken；仅当接口真正返回 401/402（token 已失效）时才
  // 刷新重试一次（社区签到段与游戏签到段已各自实现按需刷新）。

  // 1) 社区签到（异环社区）
  let bbsResult = '失败';
  let bbsReward = '';
  try {
    let r = await httpRequest(BBS_HOST, 443, '/apihub/api/signin', nativeHeaders(cfg), form({ communityId: COMMUNITY_ID }));
    let j = jsonOrNull(r.body);
    if (r.status === 401 || r.status === 402 || (j && (j.code === 401 || j.code === 402))) {
      const rr = await refreshAndSave(cfg);
      if (rr.ok) {
        update.token = cfg.token; update.refreshToken = cfg.refreshToken; update.uid = cfg.uid; dirty = true;
        lines.push('🔁 社区签到 token 失效，续期后重试');
        r = await httpRequest(BBS_HOST, 443, '/apihub/api/signin', nativeHeaders(cfg), form({ communityId: COMMUNITY_ID }));
        j = jsonOrNull(r.body);
      }
    }
    if (isOk(j) && j.data) {
      bbsResult = '✅ 社区签到成功';
      const gc = j.data.goldCoin, ex = j.data.exp;
      bbsReward = [gc ? `+${gc}金币` : '', ex ? `+${ex}经验` : ''].filter(Boolean).join(' / ');
      lines.push('✅ 社区签到成功！' + (bbsReward ? ' ' + bbsReward : ''));
    } else if (j && (j.code === 5001 || /已签|已经签到|重复/.test(String(j.msg || j.message || '')))) {
      bbsResult = 'ℹ️ 社区今日已签到';
      lines.push('ℹ️ 社区今日已签到。');
    } else {
      bbsResult = '❌ 社区签到失败(' + r.status + (j && j.code !== undefined ? '/' + j.code : '') + ')：' + ((j && j.msg) || r.body.slice(0, 200));
      lines.push(bbsResult);
    }
  } catch (e) { lines.push('社区签到异常：' + e.message); }

  // 2) 游戏签到：遍历账号绑定的全部游戏角色
  let gameResult = '未执行';
  let gameRole = '', gameReward = '';
  const extraLines = [];
  const recordGame = (gname, res, days, roleName) => {
    if (gameResult === '未执行') {
      gameResult = res;
      gameRole = roleName || '?';
      if (days) gameResult += `（本月累计 ${days} 天）`;
      return true;
    }
    extraLines.push(`• ${gname}：${res}${days ? `（本月累计 ${days} 天）` : ''}`);
    return false;
  };
  try {
    // 2.1 真实 uid（先用登录时拿到的 uid，缺失才尝试任务接口）
    let accountUid = cfg.account_uid || (cfg.uid && cfg.uid !== '0' ? cfg.uid : '');
    if (!accountUid) {
      const r = await httpRequest(BBS_HOST, 443, '/apihub/api/getUserTasks?gid=1', nativeHeaders(cfg), '', 'GET');
      try {
        const j = JSON.parse(r.body);
        if (isOk(j) && j.data) {
          for (const k of ['task_list1', 'task_list2']) {
            for (const t of (j.data[k] || [])) {
              if (t && t.uid) { accountUid = String(t.uid); break; }
            }
            if (accountUid) break;
          }
        }
      } catch (e) {}
      if (accountUid) {
        update.account_uid = accountUid; dirty = true;
        lines.push('获取账号 uid：' + accountUid);
      }
    }

    if (!accountUid) {
      gameResult = '无法获取账号 uid，游戏签到跳过';
      lines.push('无法获取账号 uid，游戏签到跳过');
    } else {
      // 2.2 角色卡（与原版 异环_signin.js 一致：GET /apihub/api/getGameRecordCard + nativeHeaders）
      const r = await httpRequest(BBS_HOST, 443, `/apihub/api/getGameRecordCard?uid=${encodeURIComponent(accountUid)}`, nativeHeaders(cfg), '', 'GET');
      let cards = [];
      try {
        const j = JSON.parse(r.body);
        if (isOk(j)) cards = j.data || [];
      } catch (e) {}
      if (!cards.length) {
        gameResult = '未找到绑定游戏（请先在塔吉多 App 绑定异环角色）';
        lines.push('未找到绑定游戏');
      } else {
        for (const card of cards) {
          const gid = card.gameId, gname = card.gameName || ('gameId=' + gid);
          const role = card.bindRoleInfo || {};
          const rid = role.roleId;
          if (!rid) { extraLines.push(`• ${gname}：未绑定角色，跳过`); continue; }
          const st = await httpRequest(BBS_HOST, 443, `/apihub/awapi/signin/state?gameId=${encodeURIComponent(gid)}`, h5Headers(cfg), '', 'GET');
          let stJ; try { stJ = JSON.parse(st.body); } catch { stJ = null; }
          if (isOk(stJ) && stJ.data && stJ.data.todaySign) {
            const days = stJ.data.days ?? 0;
            const reward = await getGameReward(cfg, gid, rid, Number(days));
            const isMain = recordGame(gname, 'ℹ️ 今日已签到', days, role.roleName);
            if (isMain && reward) { gameReward = reward; lines.push('🎁 今日奖励：' + reward); }
            lines.push(`• ${gname}：今日已签到（本月累计 ${stJ.data.days ?? '?'} 天）`);
            continue;
          }
          let s = await httpRequest(BBS_HOST, 443, '/apihub/awapi/sign', h5Headers(cfg), form({ gameId: String(gid), roleId: String(rid) }));
          let sJ = jsonOrNull(s.body);
          if (s.status === 401 || s.status === 402 || (sJ && (sJ.code === 401 || sJ.code === 402))) {
            const rr = await refreshAndSave(cfg);
            if (rr.ok) {
              update.token = cfg.token; update.refreshToken = cfg.refreshToken; update.uid = cfg.uid; dirty = true;
              lines.push(`🔁 ${gname} token 失效，续期后重试`);
              s = await httpRequest(BBS_HOST, 443, '/apihub/awapi/sign', h5Headers(cfg), form({ gameId: String(gid), roleId: String(rid) }));
              sJ = jsonOrNull(s.body);
            }
          }
          if (isOk(sJ)) {
            const rn = role.roleName || '?';
            const isMain = recordGame(gname, '✅ 签到成功', '', rn);
            lines.push(`✅ ${gname} 签到成功（角色 ${rn}）`);
            try {
              const st2 = await httpRequest(BBS_HOST, 443, `/apihub/awapi/signin/state?gameId=${encodeURIComponent(gid)}`, { 'Authorization': cfg.token }, '', 'GET');
              const stJ2 = JSON.parse(st2.body);
              if (isOk(stJ2) && stJ2.data) {
                const reward = await getGameReward(cfg, gid, rid, Number(stJ2.data.days || 0));
                if (isMain && reward) { gameReward = reward; lines.push('🎁 今日奖励：' + reward); }
              }
            } catch (e) {}
          } else if (sJ && sJ.code === 5052) {
            recordGame(gname, 'ℹ️ 今日已签到', '', role.roleName);
            lines.push(`ℹ️ ${gname} 今日已签到。`);
          } else {
            const msg = (sJ && (sJ.msg || sJ.message)) || s.body.slice(0, 200);
            recordGame(gname, '❌ 签到失败' + (sJ && sJ.code !== undefined ? '(' + sJ.code + ')' : '') + ' ' + msg, '', role.roleName);
            lines.push(`❌ ${gname} 签到失败：${msg}`);
          }
        }
      }
    }
  } catch (e) { lines.push('游戏签到异常：' + e.message); gameResult = '脚本异常：' + e.message; }

  // 3) 汇总
  // 第 2+ 个游戏的结果在 extraLines 里，原 hasFail 只检查 gameResult+bbsResult，
  // 多游戏时「第 1 个成功、后续游戏失败」会被误判为整体成功、不推送失败告警。
  // extraLines 中的「未绑定角色，跳过」属信息性跳过，不计失败（与旧行为一致）。
  const extraFail = extraLines.some(l => /❌|失败|异常|失效/.test(String(l || '')));
  const combined = (gameResult || '') + ' ' + (bbsResult || '');
  const hasFail = /❌|失败|异常|失效|跳过/.test(combined) || extraFail;
  const level = hasFail ? (/已签|成功/.test(gameResult) && /成功|已签/.test(bbsResult) ? 'warn' : 'error') : (gameResult === '未执行' ? 'warn' : 'success');
  const status = !hasFail ? 'success' : 'failed';
  const title = hasFail ? '⚠️ 异环签到部分失败' : '✅ 异环签到完成';
  const result = signResult(level, status, title, lines.concat([`游戏签到：${gameResult}`, `社区签到：${bbsResult}`]), gameReward);
  result.lines = result.lines.concat(extraLines);

  result.accountName = account.nickname || maskPhone(cfg.phone) || cfg.uid || '';
  result.roleName = gameRole;
  result.userId = cfg.uid;
  return { result, credentialsUpdate: dirty ? update : null };
}

module.exports = {
  id: 'tajiduo',
  name: '异环',
  community: '塔吉多',
  defaultEnabled: true,
  defaultTime: '06:05',
  loginMethods: [
    // 登录方式：短信验证码（推荐，用户实测可用） / 粘贴 token（兜底） / 浏览器登录（重复入口）
    //
    // 短信是本插件的推荐主路，别把收不到验证码归因为「官方风控」。应用内发码若返回 code=1
    // 『短信正在发送，长时间收不到请用语音验证码』，先查设备指纹是不是每次登录都在变：
    // 框架按游戏持久化指纹（<dataDir>/fingerprints.json），首次生成后即复用；
    // tjd-daily 也注明「同账号每次登录建议复用同一份指纹」「--new-device 老账号慎用，可能触发风控」。
    // SkyBlue997/tjd-daily、Candy-QAQ/NTE-Auto-Sign、Loping151/TGDSign 用的是同一套短信登录。
    // 每种方式带 help（官方网址 + 小白分步操作说明），由登录弹窗「官方网址与操作步骤」帮助区渲染

    { id: 'sms', kind: 'sms', label: '手机号+短信验证码（推荐）', needs: ['mobile', 'code'], hint: '短信登录；token 按需刷新，不主动顶号', help: {
      links: [{ url: 'https://www.tajiduo.com/bbs/index.html', text: '塔吉多网页版 BBS' }],
      steps: [
        '① 填手机号 → 点「发送验证码」；',
        '② 收到短信后填 6 位验证码 → 点「登录」；',
        '③ 点「测试签到」。',
        '失效处理：签到 401/402 时应用会按需用 refreshToken 自动换新 token；refreshToken 也失效则重新登录。',
      ],
    } },

    { id: 'paste', kind: 'paste', label: '粘贴 token', needs: ['token'], hint: '粘贴塔吉多 token（或 JSON），仅加密存储；换账号自动清除旧账号缓存（避免旧角色卡残留）', help: {
      links: [{ url: 'https://www.tajiduo.com/bbs/index.html', text: '塔吉多网页版 BBS' }],
      steps: [
        '① 塔吉多 App 登录后，抓任意 bbs-api.tajiduo.com 请求的 Authorization 值（可整段 {"token":...} JSON 粘贴）；',
        '② 把内容粘贴到本应用「粘贴 token」框并保存；',
        '③ 无自动续期 → 失效需重新粘贴。',
      ],
    } },

    // 浏览器登录：框架 core/browser-login.js 起一个只监听 127.0.0.1 的本地页面并用系统浏览器打开。
    // 它的短信/粘贴两个 tab 调的就是上面同一对 sendSmsCode/loginBySms 与 loginByPaste，属功能重复的
    // 兜底入口（登录页只有短信与粘贴两个 tab）。若只想精简，可直接删掉这一项，短信与粘贴不受影响。
    { id: 'browser', kind: 'gui', label: '浏览器登录', needs: ['gui'], hint: '用默认浏览器打开登录界面（短信/粘贴 token），成功自动绑定；与上面两种方式等效', help: {
      links: [{ url: 'https://www.tajiduo.com/bbs/index.html', text: '塔吉多网页版 BBS' }],
      steps: [
        '① 点击后会自动打开浏览器登录界面；',
        '② 选「短信验证码」或「粘贴 token」完成登录（与在本应用内直接登录等效）；',
        '③ 登录成功后账号自动加入本应用，可立即「测试签到」。',
      ],
    } },
  ],
  genFingerprint,
  reuseFingerprint,
  sendSmsCode,
  loginBySms,
  loginByPaste,
  signin,
  maskPhone,
  describeCredential,
  onRemove,
  meta: { version: '1.6.0', author: '官方插件', login: '短信验证码（推荐）/ 粘贴 token / 浏览器登录' },
};

// ---------- 账号摘要辅助（替代 main.js per-game 昵称硬编码） ----------
function describeCredential(cred) {
  return { nickname: (cred && cred.phone) ? maskPhone(cred.phone) : '' };
}

/** 卸载清理钩子（内置 tajiduo 不通过界面删除；空实现，满足插件契约完整性） */
async function onRemove() { /* 登录会话/网页窗口由主进程管理，无插件级资源需清理 */ }
