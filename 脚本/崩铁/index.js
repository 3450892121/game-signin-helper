'use strict';
/**
 * 米游社（崩坏：星穹铁道）协议模块
 *
 * 接口来源：UIGF-org/mihoyo-api-sdk（原 mihoyo-api-collect 已归档）、Womsxd/MihoyoBBSTools、Genshin-bots/gsuid_core
 *
 * 登录（两种方式）：
 * 1) 网页登录（推荐，kind:'web'）：打开 user.mihoyo.com 登录后由 webMeta.extractScript 自动提取
 * Cookie（含 HttpOnly cookie_token_v2）→ 交给 loginByCookie。用户无需 F12 抓包。
 * 2) 粘贴 Cookie（kind:'paste'）：loginByCookie(cookie) → credentials
 * （自动 strip 清洗误带前缀；须含 HttpOnly cookie_token_v2）
 *
 * 不提供扫码与短信登录：
 * - 扫码：本模块用的 hk4e「panda」端点已失效——Womsxd/MihoyoBBSTools issue #285 报 gametoken 换
 * stoken 返回 retcode:-5300，#284 评论「现在用扫码换不到真的 stoken 了」。
 * 注：「扫码」本身没死，死的是 panda 端点——Genshin-bots/gsuid_core 换用 ma-cn-passport 端点仍在跑。
 * - 短信：米游社短信登录本身可用（外部证据 BTMuli/TeyvatGuide），但必须在界面内嵌官方极验控件、
 * 由用户手动通过。本模块没有可用的 actionType 传递链路——框架只从返回值的 sessionData 取该标识。
 *
 * 凭据（credentials）：{ userName, userId, cookie, gameUid, region, roleName,
 * stokenV1?, stuid?, stokenV2?, mid?, deviceId?, source }
 * - Cookie 里带 stoken_v2+mid 时签到可自动续期
 *
 * 签到：
 * signin(account) → { result, credentialsUpdate }
 * - 每次签到前用 stoken 换新 cookie_token（免抓包续期）
 */

const https = require('https');
const crypto = require('crypto');

const SR_ACT_ID = 'e202304121516551';
const SR_GAME = 'hkrpg';
const WEB_DS_SALT = 'yBh10ikxtLPoIhgwgPZSv5dmfaOTSJ6a';
const APP_VERSION = '2.102.1';
const TAKUMI = 'https://api-takumi.mihoyo.com';
const PASS = 'https://passport-api.mihoyo.com';
const UA = 'Mozilla/5.0 (Linux; Android 13; PHK110 Build/SKQ1.221119.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.133 Mobile Safari/537.36 miHoYoBBS/' + APP_VERSION;

// ---------- 基础工具 ----------
function webDs() {
  const ts = String(Math.floor(Date.now() / 1000));
  const r = crypto.randomBytes(6).toString('hex').slice(0, 6);
  const md5 = crypto.createHash('md5')
    .update('salt=' + WEB_DS_SALT + '&t=' + ts + '&r=' + r)
    .digest('hex');
  return ts + ',' + r + ',' + md5;
}

function randomDeviceId() { return crypto.randomBytes(16).toString('hex'); }
function randomDeviceFp() {
  return crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 13);
}

function request(opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(opts.url);
    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) u.searchParams.append(k, String(v));
    }
    const data = opts.body ? (opts.jsonBody ? JSON.stringify(opts.body) : opts.body) : '';
    const headers = Object.assign({
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': opts.jsonBody ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(data),
      'User-Agent': opts.ua || UA,
    }, opts.headers || {});
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers,
      timeout: 30000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (data) req.write(data);
    req.end();
  });
}

async function reqJson(opts) {
  const r = await request(opts);
  let j = null;
  try { j = JSON.parse(r.body); } catch (e) {}
  if (!j) throw new Error('响应解析失败（HTTP ' + r.status + '）' + String(r.body).slice(0, 200));
  return j;
}

function maskPhone(p) {
  const s = String(p || '');
  return s.length >= 7 ? s.slice(0, 3) + '****' + s.slice(-4) : s;
}

function jsonOrNull(body) {
  try { return JSON.parse(body); } catch (e) { return null; }
}

// ---------- 签到基础请求 ----------
function baseHeaders(cookie) {
  return {
    'Cookie': cookie,
    'x-rpc-app_version': APP_VERSION,
    'X-Requested-With': 'com.mihoyo.hyperion',
    'x-rpc-client_type': '5',
    'Referer': 'https://webstatic.mihoyo.com/',
    'Origin': 'https://webstatic.mihoyo.com/',
    'DS': webDs(),
    'x-rpc-device_id': randomDeviceId(),
    'x-rpc-device_fp': randomDeviceFp(),
    'x-rpc-signgame': SR_GAME,
  };
}

async function lunaReq(cookie, method, path, params, body) {
  const r = await request({
    url: TAKUMI + path,
    method,
    params,
    body,
    jsonBody: !!body,
    headers: baseHeaders(cookie),
  });
  let j = null;
  try { j = JSON.parse(r.body); } catch (e) {}
  if (!j) throw new Error('响应解析失败（HTTP ' + r.status + '）' + String(r.body).slice(0, 200));
  return j;
}

// ---------- 角色查询 / 凭据校验（登录共用） ----------
async function getSRRole(cookie) {
  const recordBase = 'https://api-takumi-record.mihoyo.com';
  const m = /account_id[=:](\d+)/.exec(cookie);
  const uidParam = m ? m[1] : null;
  const attempts = [
    { appVersion: '2.34.1' },
    { appVersion: APP_VERSION },
    { appVersion: '2.55.0' },
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      const j = await reqJson({
        url: recordBase + '/game_record/card/wapi/getGameRecordCard',
        params: uidParam ? { uid: uidParam } : {},
        headers: {
          'Cookie': cookie,
          'x-rpc-client_type': '5',
          'x-rpc-app_version': a.appVersion,
          'DS': webDs(),
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13; PHK110 Build/SKQ1.221119.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.133 Mobile Safari/537.36 miHoYoBBS/' + a.appVersion,
        },
      });
      const list = (j.data || {}).list || [];
      for (const item of list) {
        if (String(item.game_id) === '6' || item.game === 'hkrpg' || String(item.game_biz || '').indexOf('hkrpg') === 0) {
          // 档案 §四.3：角色 uid 字段是 game_role_id（不是 game_uid！），读错会写成 'undefined' 导致签到 retcode=-502；game_role_id 优先、game_uid 兜底
          return { gameUid: String(item.game_role_id || item.game_uid), region: item.region, roleName: item.nickname || '' };
        }
      }
      if (j.retcode === 0 || (j.data && j.data.list)) {
        return { gameUid: '', region: '', roleName: '', noRole: true, allGames: list.map(x => x.game_id + ':' + x.game_uid).join(', ') };
      }
      lastErr = new Error('查询角色失败：retcode=' + j.retcode + ' ' + (j.message || ''));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('查询角色失败');
}

async function validateCookie(cookie) {
  const j = await reqJson({
    url: TAKUMI + '/event/luna/home',
    params: { act_id: SR_ACT_ID, lang: 'zh-cn' },
    headers: {
      'Cookie': cookie,
      'x-rpc-app_version': APP_VERSION,
      'X-Requested-With': 'com.mihoyo.hyperion',
      'x-rpc-client_type': '5',
      'Referer': 'https://webstatic.mihoyo.com/',
      'Origin': 'https://webstatic.mihoyo.com/',
      'DS': webDs(),
      'x-rpc-device_id': randomDeviceId(),
      'x-rpc-device_fp': randomDeviceFp(),
      'x-rpc-signgame': SR_GAME,
    },
  });
  return j.retcode === 0;
}

// ---------- 凭据构建 ----------
/** 网页/粘贴两条路径共用：查询角色 + 校验签到接口，返回完整凭据对象 */
async function finalizeCredentials(accountId, cookie, extra) {
  extra = extra || {};
  let role = { gameUid: '', region: '', roleName: '', noRole: false };
  try {
    role = await getSRRole(cookie);
  } catch (e) { /* 角色查询失败不阻断登录，凭据里留空 */ }
  const cookieOk = await validateCookie(cookie).catch(() => false);
  const cred = {
    userName: role.roleName || accountId,
    userId: accountId,
    cookie,
    gameUid: role.gameUid || '',
    region: role.region || '',
    roleName: role.roleName || '',
    source: extra.source || 'sms',
  };
  if (extra.stokenV1) { cred.stokenV1 = extra.stokenV1; cred.stuid = accountId; }
  if (extra.stokenV2) cred.stokenV2 = extra.stokenV2;
  if (extra.mid) cred.mid = extra.mid;
  if (extra.deviceId) cred.deviceId = extra.deviceId;
  if (extra.deviceFp) cred.deviceFp = extra.deviceFp;
  cred._roleWarning = role.noRole ? ('未找到星铁角色（已绑定：' + (role.allGames || '?') + '），可在官方社区确认后重新绑定') : '';
  cred._cookieValid = cookieOk;
  return cred;
}

// ---------- 登录方式 2：粘贴 Cookie（网页登录提取到 Cookie 后也走这里） ----------
async function loginByCookie(cookieInput) {
  let cookie = String(cookieInput || '').trim();
  if (!cookie) throw new Error('Cookie 为空');
  // 清洗（档案 §十三.2）：用户从 Network 复制常带 'cookie:' 头标签/换行/垃圾前缀 → 去前缀并截到第一个 name= 处，
  // 否则 Cookie 头含换行非法 → 签到/查角色报 Invalid character 或 retcode=-502/10001。
  cookie = cookie.replace(/^["']?\s*cookie\s*[:]?\s*/i, '');
  const nameAt = /[A-Za-z0-9_-]+\s*=\s*["']?[^;\s]/.exec(cookie);
  if (nameAt && nameAt.index > 0) cookie = cookie.slice(nameAt.index).trim();
  cookie = cookie.replace(/[\r\n]+/g, '; ');
  const m = /(?:account_id|stuid|login_uid)[=:](\d+)/.exec(cookie);
  const accountId = m ? m[1] : '';
  if (!accountId) throw new Error('未能从 Cookie 识别 account_id/stuid，请粘贴登录后的完整 Cookie');
  // 顺带提取 stoken_v2/mid/stoken_v1（Network 复制的完整 Cookie 常含这些）：
  // 存进凭据后，签到可自动用 SToken 换新 cookie_token 续期，无需每月抓包。
  const extra = { source: 'cookie' };
  const sv2 = /(?:^|;\s*)stoken_v2=([^;\s]+)/.exec(cookie);
  const mid = /(?:^|;\s*)mid=([^;\s]+)/.exec(cookie);
  const sv1 = /(?:^|;\s*)stoken=([^;\s]+)/.exec(cookie);
  if (sv2 && mid) { extra.stokenV2 = sv2[1]; extra.mid = mid[1]; }
  if (sv1 && !extra.stokenV2) extra.stokenV1 = sv1[1];
  return finalizeCredentials(accountId, cookie, extra);
}

// ---------- 签到 ----------
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

// stoken 换新 cookie_token（v2 优先，v1 兜底），返回新 cookie_token 或 null（stoken 失效）
async function getCookieTokenByStoken(cred) {
  if (cred.stokenV2 && cred.mid) {
    const r = await request({
      url: PASS + '/account/auth/api/getCookieAccountInfoBySToken',
      headers: {
        'Cookie': 'stoken_v2=' + cred.stokenV2 + '; mid=' + cred.mid,
        'x-rpc-device_id': cred.deviceId || randomDeviceId(),
      },
    });
    const j = JSON.parse(r.body);
    if (j.retcode === 0 && j.data && j.data.cookie_token) return j.data.cookie_token;
    if (j.retcode === -100) return null;
    throw new Error('retcode=' + j.retcode + ' ' + (j.message || ''));
  }
  if (cred.stokenV1 && cred.stuid) {
    const r = await request({
      url: PASS + '/account/auth/api/getCookieAccountInfoBySToken',
      headers: { 'Cookie': 'stuid=' + cred.stuid + '; stoken=' + cred.stokenV1 },
    });
    const j = JSON.parse(r.body);
    if (j.retcode === 0 && j.data && j.data.cookie_token) return j.data.cookie_token;
    if (j.retcode === -100) return null;
    throw new Error('retcode=' + j.retcode + ' ' + (j.message || ''));
  }
  return null;
}

/**
 * 执行崩铁签到
 * @param {{credentials:object, nickname?:string}} account
 * @returns {Promise<{result:object, credentialsUpdate:object|null}>}
 */
async function signin(account) {
  const cred = Object.assign({}, account.credentials || {});
  const lines = [];
  const update = {};
  let dirty = false;

  let cookie = cred.cookie;
  if (!cookie) {
    return { result: signResult('error', 'failed', '❌ 配置缺少 cookie，请重新登录', ['配置缺少 cookie']), credentialsUpdate: null };
  }

  // 免抓包续期：有 SToken 时每次签到前自动换新 cookie_token
  if (cred.stokenV2 || cred.stokenV1) {
    try {
      const newToken = await getCookieTokenByStoken(cred);
      if (newToken) {
        const updated = cookie.replace(/cookie_token=[^;]*/, 'cookie_token=' + newToken);
        if (updated !== cookie) {
          cookie = updated;
          update.cookie = updated;
          dirty = true;
          lines.push('🔄 已用 SToken 自动续期 cookie');
        }
      } else {
        lines.push('⚠️ SToken 已失效，cookie 续期失败（如签到报登录过期请重新登录）');
      }
    } catch (e) {
      lines.push('⚠️ cookie 自动续期失败（沿用旧 cookie）：' + e.message);
    }
  }

  let result;
  let todayReward = '';
  try {
    // 1) 当月奖励列表 + 今日签到状态
    const home = await lunaReq(cookie, 'GET', '/event/luna/home', { act_id: SR_ACT_ID, lang: 'zh-cn' });
    const info = await lunaReq(cookie, 'GET', '/event/luna/info', {
      act_id: SR_ACT_ID, lang: 'zh-cn', region: cred.region, uid: cred.gameUid,
    });
    const awards = (home.data && home.data.awards) || [];
    const infoData = info.data || {};

    if (infoData.is_sign) {
      result = signResult('info', 'already', 'ℹ️ 今天已签到过', lines.concat(['ℹ️ 今天已签到过。']));
    } else {
      const sign = await lunaReq(cookie, 'POST', '/event/luna/sign', {}, {
        act_id: SR_ACT_ID, lang: 'zh-cn', uid: cred.gameUid, region: cred.region,
      });
      const rc = sign.retcode;
      lines.push('签到返回 retcode=' + rc + '：' + (sign.message || ''));
      if (rc === 0) {
        result = signResult('success', 'success', '✅ 签到成功', lines.concat(['✅ 崩铁签到成功！']));
      } else if (rc === -5003) {
        result = signResult('info', 'already', 'ℹ️ 今天已签到过', lines.concat(['ℹ️ 今天已签到过。']));
      } else if (rc === -100) {
        result = signResult('error', 'auth-expired', '❌ 登录已过期（cookie 失效，请重新登录）', lines.concat(['❌ 登录已过期，需要重新获取 cookie']));
      } else {
        const msg = '❌ 签到失败(retcode=' + rc + ')：' + (sign.message || '');
        result = signResult('error', 'failed', msg, lines.concat([msg]));
      }
    }

    // 2) 今日奖励：重新查状态，取 awards[已签到天数-1]
    try {
      const info2 = await lunaReq(cookie, 'GET', '/event/luna/info', {
        act_id: SR_ACT_ID, lang: 'zh-cn', region: cred.region, uid: cred.gameUid,
      });
      const d2 = info2.data || {};
      const idx = (d2.total_sign_day || 0) - 1;
      if (d2.is_sign && awards[idx]) {
        todayReward = awards[idx].name + ' ×' + awards[idx].cnt;
        result.reward = todayReward;
        result.lines = result.lines.concat(['🎁 今日奖励：' + todayReward]);
      }
    } catch (e) {
      lines.push('查询今日奖励失败（不影响签到结果）：' + e.message);
    }
  } catch (e) {
    const msg = '❌ 脚本异常：' + (e && e.message || e);
    result = signResult('error', 'failed', msg, lines.concat([msg]));
  }

  result.accountName = account.nickname || cred.userName || cred.userId || '';
  result.roleName = cred.roleName;
  result.userId = cred.userId;
  return { result, credentialsUpdate: dirty ? update : null };
}

module.exports = {
  id: 'mihoyo',
  name: '崩铁',
  community: '米游社',
  defaultEnabled: true,
  defaultTime: '05:55',
  loginMethods: [
    // 两种登录方式：网页登录为推荐主路（自动提取 Cookie，用户无需 F12 抓包），
    // 粘贴 Cookie 为兜底。扫码/短信已移除，依据见本文件头部注释。
    { id: 'web', kind: 'web', label: '网页登录（推荐）', needs: ['web'], hint: '打开米游社登录页登录后自动提取 Cookie（含 HttpOnly cookie_token_v2），免手动 F12 抓包', help: {
      links: [{ url: 'https://user.mihoyo.com/', text: '米游社登录页' }],
      steps: [
        '① 点击「打开网页登录窗口」；',
        '② 在窗口里用手机号/验证码或扫码登录米游社；',
        '③ 登录成功后本应用自动提取 Cookie（含 HttpOnly 的 cookie_token_v2）并绑定账号；',
        '④ 回应用点「测试签到」确认。',
        '失效处理：签到提示「登录已过期」→ 重新网页登录，或改用「粘贴 Cookie」。',
      ],
    }, webMeta: {
      loginUrl: 'https://user.mihoyo.com/',
      title: '米游社（崩铁）登录',
      extractScript: `(async () => {
  return { game: 'mihoyo', origin: location.origin, href: location.href, cookie: document.cookie };
})()`,
      validate: (extracted) => {
        const res = { usable: false, reason: '' };
        if (!extracted || typeof extracted !== 'object') { res.reason = '页面未返回可解析的登录态'; return res; }
        const cookies = (extracted._cookies || []);
        const hasCookieToken = cookies.some(c => c.name === 'cookie_token_v2' && c.value);
        const hasAccountId = cookies.some(c => c.name === 'account_id' && c.value);
        if (!hasCookieToken) { res.reason = '未检测到 cookie_token_v2（HttpOnly），请先在网页中完成登录'; return res; }
        if (!hasAccountId) { res.reason = '未检测到 account_id，请确认账号已登录'; return res; }
        res.usable = true; res.reason = '';
        return res;
      },
      buildCredentials: async (extracted) => {
        const cookies = (extracted && extracted._cookies) || [];
        const seen = {};
        for (const c of cookies) {
          const d = String((c && c.domain) || '').toLowerCase();
          if (!(d === 'mihoyo.com' || d.endsWith('.mihoyo.com') || d === 'hoyoverse.com' || d.endsWith('.hoyoverse.com'))) continue;
          if (!c || !c.name) continue;
          const value = String(c.value || '');
          if (seen[c.name] === undefined) seen[c.name] = value;
          else if (value && !seen[c.name]) seen[c.name] = value;
        }
        const cookie = Object.keys(seen).map(k => k + '=' + seen[k]).join('; ');
        if (!cookie) throw new Error('未提取到米游社 Cookie，请先在网页中完成登录');
        return loginByCookie(cookie);
      },
      degradation: { text: '网页登录暂未提取到有效 Cookie，请使用「粘贴 Cookie」登录。', fallbackKinds: ['paste'] },
    } },

    // 兜底：手动抓包粘贴。必须从 Network 请求头复制整段 Cookie（document.cookie 读不到 HttpOnly 的 cookie_token_v2）
    { id: 'cookie', kind: 'paste', label: '粘贴 Cookie', needs: ['cookie'], hint: '粘贴米游社完整 Cookie（须含 HttpOnly cookie_token_v2；URL 域名须为 user.mihoyo.com；请从 Network 请求头复制；自动去除误带前缀）', help: {
      links: [
        { url: 'https://user.mihoyo.com/', text: '米游社登录页（须 user.mihoyo.com 域）' },
        { url: 'https://bbs.mihoyo.com/', text: '米游社社区' },
      ],
      steps: [
        '① 用电脑浏览器（Chrome/Edge）打开 https://user.mihoyo.com/ ，用目标账号登录；',
        '② 按 F12 → 切换到 Network → 刷新页面 → 点任意一个 api-takumi.mihoyo.com 请求 → 在「Request Headers」里找到 Cookie，把整段复制出来（必须包含 HttpOnly 的 cookie_token_v2）；',
        '③ 注意：不要用 document.cookie（读不到 HttpOnly 的 cookie_token_v2，会缺关键 token）；',
        '④ 把整段 Cookie 粘贴到本应用「粘贴 Cookie」框（应用会自动去掉误带的 cookie: 前缀）；',
        '⑤ 保存后点「测试签到」；若提示 cookie 无效 → 确认你的账号已在米游社绑定星铁角色，且复制的是完整请求头 Cookie。',
        '失效处理：签到提示「登录已过期」→ 重新抓 Cookie 粘贴，或改用「网页登录」。',
      ],
    } },
  ],
  loginByCookie,
  signin,
  maskPhone,
  describeCredential,
  onRemove,
  meta: { version: '1.4.0', author: '官方插件', login: '网页登录 / 粘贴 Cookie' },
};

// ---------- 账号摘要辅助（替代 main.js per-game 昵称/roleWarning/cookieValid 硬编码） ----------
function describeCredential(cred) {
  return {
    nickname: (cred && cred.userName) || '',
    warning: (cred && cred._roleWarning) || '',
    cookieValid: (cred && typeof cred._cookieValid === 'boolean') ? cred._cookieValid : null,
  };
}

/** 卸载清理钩子（内置 mihoyo 不通过界面删除；空实现，满足插件契约完整性） */
async function onRemove() { /* 无独立窗口/会话需清理 */ }
