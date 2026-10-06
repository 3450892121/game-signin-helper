'use strict';
/**
 * 库街区（鸣潮）协议模块
 *
 * 接口来源：mxyooR/Kuro-AutoSignin、TomyJan/Kuro-API-Collection
 * - 发送验证码：POST /user/getSmsCode （2024.06.17，APP 端）
 * - 验证码登录：POST /user/sdkLogin
 * - 用户信息 ：POST /user/mineV2
 * - 角色列表 ：POST /user/role/findRoleList (gameId=3)
 * - 鸣潮签到 ：POST /encourage/signIn/v2
 * - 签到记录 ：POST /encourage/signIn/queryRecordV2
 *
 * 登录（三种方式；短信为推荐主路。signin 按 credentials.source 分端头）：
 * sendSmsCode(mobile) → { ok, needGeeTest, msg } // 发送短信验证码
 * loginBySms(mobile, code) → credentials // 验证码登录（推荐）
 * loginByPaste(raw) → credentials // 粘贴 token（或 {token, distinct_id} JSON）
 * kind:'web' 网页登录 → 打开 kurobbs.com 登录后由 webMeta.extractScript 从 localStorage
 * 提取 AUTH_TOKEN + distinct_id → h5 头，web token 可签到
 * 注：APP 端 token 与 Web 端 token 分端、互不通用，且 APP 端同时只允许一个登录（取新 token 会作废旧的）
 * ——依据 TomyJan/Kuro-API-Collection 的 sdkLogin.md / sdkLoginForH5.md 原文。
 * 注：网页登录这条（localStorage 取 AUTH_TOKEN）在外部开源项目里找不到第二家同做法，属本仓自有实现，
 * 链路完整但缺少外部佐证；另有线索显示库街区存在 H5 发码端点 /user/getSmsCodeForH5
 * （Loping151/XutheringWavesUID 在用，内嵌官方极验 v4），若 APP 端发码被极验卡死可往这个方向查。
 *
 * 签到：
 * signin(account) → { result, credentialsUpdate }
 */

const https = require('https');
const crypto = require('crypto');
const os = require('os');

const API_HOST = 'api.kurobbs.com';
const WUWA_GAME_ID = '3';
const WUWA_SERVER_ID = '76402e5b20be2c39f095a152090afddc';

// ---------- 基础工具 ----------
function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function request(payload) {
  return new Promise((resolve, reject) => {
    const data = payload.body || '';
    const req = https.request({
      hostname: API_HOST,
      path: payload.path,
      method: payload.method || 'POST',
      headers: Object.assign({
        'Accept': '*/*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
      }, payload.headers || {}),
      timeout: 30000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (data) req.write(data);
    req.end();
  });
}

function form(data) {
  return Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    .join('&');
}

function jsonOrNull(body) {
  try { return JSON.parse(body); } catch (e) { return null; }
}

// 登录/发码环境头（与 App 一致；devcode/distinct_id 每次登录随机生成）
function loginHeaders(devcode, distinct_id) {
  return {
    'osversion': 'Android',
    'devcode': devcode,
    'distinct_id': distinct_id,
    'countrycode': 'CN',
    'ip': '192.168.1.101',
    'model': '2211133C',
    'source': 'android',
    'lang': 'zh-Hans',
    'version': '1.0.9',
    'versioncode': '1090',
    'content-type': 'application/x-www-form-urlencoded',
    'accept-encoding': 'gzip',
    'user-agent': 'okhttp/3.10.0',
  };
}

// 签到游戏头（ios 壳）
function gameHeaders(token, devcode, ip) {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) KuroGameBox/2.2.0';
  return {
    'Accept': 'application/json, text/plain, */*',
    'Sec-Fetch-Site': 'same-site',
    'source': 'ios',
    'Sec-Fetch-Mode': 'cors',
    'Origin': 'https://web-static.kurobbs.com',
    'User-Agent': ua,
    'Host': API_HOST,
    'devCode': `${ip}, ${ua}`,
    'token': token,
  };
}

// 用户信息头（android 壳）
function userInfoHeaders(token, devcode, distinct_id, ip) {
  return {
    'osversion': 'Android',
    'countrycode': 'CN',
    'ip': ip,
    'model': '2211133C',
    'source': 'android',
    'lang': 'zh-Hans',
    'version': '1.0.9',
    'versioncode': '1090',
    'content-type': 'application/x-www-form-urlencoded',
    'deviceid': distinct_id,
    'token': token,
    'ds': '',
    'User-Agent': 'okhttp/3.10.0',
    'Accept': '*/*',
  };
}

// 网页端（h5）用户信息头：与 kurobbs 网页版一致（source:h5 / version:3.0.0，同 games/web-login.js 提取脚本）
// t2 调研结论（TomyJan/Kuro-API-Collection）：APP 端 token 与 Web 端 token 互不通用——绑定/签到必须用同一端 token。
// 网页窗口提取的 AUTH_TOKEN（credentials.source='web'）走用户信息接口时必须用 h5 头，否则 mineV2 校验会失败。
function h5UserHeaders(token, devcode, distinct_id) {
  return {
    'source': 'h5',
    'devCode': devcode,
    'distinct_id': distinct_id,
    'version': '3.0.0',
    'token': token,
    'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': '*/*',
  };
}

// 按凭据来源选择用户信息接口请求头（web token → h5 头；APP/paste 其余 → android 头，行为不变）
// h5 mineV2 请求体与 games/web-login.js 提取脚本完全一致（devCode 字段取 distinct_id 值）——
// 该组合是网页版验证 AUTH_TOKEN 可用的同一组请求，保证 web 提取的账号能通过 signin 的用户信息校验。
function pickUserInfoHeaders(cred, ip) {
  if (cred.source === 'web') {
    return {
      headers: h5UserHeaders(cred.token, cred.devcode, cred.distinct_id),
      body: form({ mobile: '', devCode: cred.distinct_id, distinct_id: cred.distinct_id }),
    };
  }
  return { headers: userInfoHeaders(cred.token, cred.devcode, cred.distinct_id, ip), body: '' };
}

// ---------- 登录 ----------
/**
 * 发送短信验证码
 * @param {string} mobile 手机号
 * @returns {Promise<{ok:boolean, needGeeTest:boolean, msg:string, raw?:object}>}
 * code=200 且 data.geeTest=false 才表示验证码已发送；
 * needGeeTest=true 表示触发极验人机验证（UI 需提示走官方 App 获取验证码）。
 */
async function sendSmsCode(mobile) {
  const devcode = crypto.randomBytes(16).toString('hex');
  const distinct_id = crypto.randomBytes(16).toString('hex');
  const r = await request({
    path: '/user/getSmsCode',
    headers: loginHeaders(devcode, distinct_id),
    body: form({ mobile: String(mobile), geeTestData: '' }),
  });
  const j = jsonOrNull(r.body);
  if (!j) return { ok: false, needGeeTest: false, msg: '响应解析失败(HTTP ' + r.status + ')' };
  if (j.code === 200) {
    const needGeeTest = !!(j.data && j.data.geeTest);
    if (needGeeTest) return { ok: false, needGeeTest: true, msg: j.msg || '需要极验人机验证' };
    return { ok: true, needGeeTest: false, msg: j.msg || '验证码已发送' };
  }
  return { ok: false, needGeeTest: false, msg: (j.msg || '发送失败') + '(code=' + j.code + ')' };
}

/**
 * 手机号 + 短信验证码登录
 * @returns {Promise<object>} credentials（含 token/devcode/distinct_id）
 * @throws {Error} 登录失败（含 code/msg）
 */
async function loginBySms(mobile, code) {
  const devcode = crypto.randomBytes(16).toString('hex');
  const distinct_id = crypto.randomBytes(16).toString('hex');
  const r = await request({
    path: '/user/sdkLogin',
    headers: loginHeaders(devcode, distinct_id),
    body: form({ code, devCode: devcode, gameList: '', mobile: String(mobile) }),
  });
  const j = jsonOrNull(r.body);
  if (!j) throw new Error('登录响应解析失败(HTTP ' + r.status + ')');
  if (j.code !== 200 || !(j.data && j.data.token)) {
    throw new Error((j.msg || '登录失败') + '(code=' + j.code + ')');
  }
  return {
    mobile: String(mobile),
    token: j.data.token,
    devcode,
    distinct_id,
    loginAt: new Date().toISOString(),
  };
}

/**
 * 粘贴 token（抓包/网页提取的 kurobbs token；devcode/distinct_id 随机生成，与 App 登录一致）
 * @param {string} raw 纯 token，或 JSON（{token, distinct_id?}）
 * @returns {Promise<object>} credentials
 */
async function loginByPaste(raw) {
  let token = String(raw || '').trim();
  let distinct_id = '';
  if (token.startsWith('{')) {
    try {
      const j = JSON.parse(token);
      token = String(j.token || '').trim();
      distinct_id = String(j.distinct_id || '').trim();
    } catch (e) { /* 按纯 token 处理 */ }
  }
  if (!token) throw new Error('token 为空');
  return {
    mobile: '',
    token,
    devcode: crypto.randomBytes(16).toString('hex'),
    distinct_id: distinct_id || crypto.randomBytes(16).toString('hex'),
    loginAt: new Date().toISOString(),
    source: 'paste',
  };
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

/**
 * 获取用户信息（mineV2）。
 * @returns {Promise<{userId:string|null, code:number|null}>} code=接口业务码（null 表示无业务码）
 */
async function fetchUserId(cred, ip) {
  const pick = pickUserInfoHeaders(cred, ip);
  const r = await request({
    path: '/user/mineV2',
    headers: pick.headers,
    body: pick.body,
  });
  const j = jsonOrNull(r.body);
  const id = j && j.data && j.data.mine && j.data.mine.userId;
  return { userId: id ? String(id) : null, code: (j && typeof j.code === 'number') ? j.code : null };
}

/**
 * 获取鸣潮角色列表（findRoleList）。
 * @returns {Promise<{roleId:string|null, roleName:string, code:number|null}>}
 */
async function fetchRoleId(cred, ip) {
  const pick = pickUserInfoHeaders(cred, ip);
  const r = await request({
    path: '/user/role/findRoleList',
    headers: pick.headers,
    body: form({ gameId: WUWA_GAME_ID }),
  });
  const j = jsonOrNull(r.body);
  const roles = j && j.data;
  if (Array.isArray(roles) && roles.length > 0) {
    return { roleId: String(roles[0].roleId), roleName: roles[0].roleName || '', code: (j && typeof j.code === 'number') ? j.code : null };
  }
  return { roleId: null, roleName: '', code: (j && typeof j.code === 'number') ? j.code : null };
}

// 查询当月签到记录，提取今日奖励
async function queryTodayReward(token, devcode, ip, roleId, userId) {
  try {
    const month = String(new Date().getMonth() + 1).padStart(2, '0');
    const r = await request({
      path: '/encourage/signIn/queryRecordV2',
      headers: gameHeaders(token, devcode, ip),
      body: form({ gameId: WUWA_GAME_ID, serverId: WUWA_SERVER_ID, roleId, userId, reqMonth: month }),
    });
    const j = jsonOrNull(r.body);
    if (!j || j.code !== 200 || !Array.isArray(j.data)) return '';
    const todayYmd = new Date().toISOString().slice(0, 10);
    const today = j.data.find(rr => rr.sigInDate && rr.sigInDate.slice(0, 10) === todayYmd);
    if (!today) return '';
    const name = today.goodsName || '';
    const num = today.goodsNum !== undefined ? today.goodsNum : '';
    return name ? (num === '' ? name : `${name} ×${num}`) : '';
  } catch (e) {
    return '';
  }
}

/**
 * 执行鸣潮签到
 * @param {{credentials:object}} account
 * @returns {Promise<{result:object, credentialsUpdate:object|null}>}
 */
async function signin(account) {
  const cred = Object.assign({}, account.credentials || {});
  const lines = [];
  const update = {};
  let dirty = false;

  const token = cred.token;
  if (!token) {
    return { result: signResult('error', 'failed', '❌ 配置缺少 token，请重新登录', ['配置缺少 token']), credentialsUpdate: null };
  }
  const devcode = cred.devcode || '';
  const distinct_id = cred.distinct_id || '';
  const mobile = cred.mobile || '';
  const ip = getLocalIp();
  const maskPhone = (p) => { const s = String(p || ''); return s.length >= 7 ? s.slice(0, 3) + '****' + s.slice(-4) : s; };

  // 1) userId（缺失时自动获取并回写；失败区分网络异常/业务码，R7）
  let userId = cred.userId;
  let uidFail = null; // {network:true} 或 {code:业务码}
  if (!userId) {
    try {
      const r = await fetchUserId(cred, ip);
      if (r.userId) { userId = r.userId; update.userId = userId; dirty = true; lines.push('获取 userId：' + userId); }
      else {
        uidFail = { code: r.code };
        lines.push(r.code === 220 ? '获取 userId 失败：登录已过期（code=220）' : (r.code != null ? '获取 userId 失败（业务码 ' + r.code + '）' : '获取 userId 失败（接口未返回业务码）'));
      }
    } catch (e) { uidFail = { network: true }; lines.push('获取 userId 异常：' + e.message); }
  }

  // 2) roleId（缺失时自动获取并回写；失败区分网络异常/业务码/无角色，R7）
  let roleId = cred.roleId;
  let roleName = cred.roleName || '';
  let roleFail = null; // {network:true} 或 {code:业务码}
  if (!roleId) {
    try {
      const role = await fetchRoleId(cred, ip);
      if (role.roleId) { roleId = role.roleId; roleName = role.roleName; update.roleId = roleId; update.roleName = roleName; dirty = true; lines.push(`获取鸣潮角色 roleId：${roleId}${roleName ? '（' + roleName + '）' : ''}`); }
      else {
        roleFail = { code: role.code };
        lines.push(role.code === 220 ? '获取角色失败：登录已过期（code=220）' : (role.code != null ? '获取角色失败（业务码 ' + role.code + '）' : '获取角色失败（接口未返回业务码）'));
      }
    } catch (e) { roleFail = { network: true }; lines.push('获取 roleId 异常：' + e.message); }
  }

  // 3) 签到
  let result;
  if (!userId || !roleId) {
    // 仅确凿的登录失效（业务码 220）才标 auth-expired；其余（网络异常/其他业务码）标 failed 网络语义
    let status, title;
    if (roleFail && !roleFail.network && roleFail.code === 200) {
      status = 'failed';
      title = '❌ 未找到鸣潮角色，无法签到（请确认该账号已创建鸣潮角色）';
    } else if ((uidFail && uidFail.code === 220) || (roleFail && roleFail.code === 220)) {
      status = 'auth-expired';
      title = '❌ 登录已过期，请重新登录';
    } else {
      status = 'failed';
      title = '❌ 获取用户信息失败，请检查网络后重试';
    }
    result = signResult('error', status, title, lines.concat([title]));
    return { result, credentialsUpdate: dirty ? update : null };
  }

  const month = String(new Date().getMonth() + 1).padStart(2, '0');
  const r = await request({
    path: '/encourage/signIn/v2',
    headers: gameHeaders(token, devcode, ip),
    body: form({ gameId: WUWA_GAME_ID, serverId: WUWA_SERVER_ID, roleId, userId, reqMonth: month }),
  });
  const j = jsonOrNull(r.body);
  let reward = '';
  let title = '';

  if (j && j.code === 200) {
    title = '✅ 签到成功';
    result = signResult('success', 'success', title, lines.concat([title]));
  } else if (j && j.code === 1511) {
    title = 'ℹ️ 今天已签到过';
    result = signResult('info', 'already', title, lines.concat([title]));
  } else if (j && j.code === 1513) {
    title = '❌ 用户信息异常';
    result = signResult('error', 'failed', title, lines.concat([title + '：' + (j.msg || '')]));
  } else if (j && j.code === 220) {
    title = '❌ 登录已过期，需要重新获取 token';
    result = signResult('error', 'auth-expired', title, lines.concat([title]));
  } else {
    title = '❌ 签到失败(code=' + (j ? j.code : '?') + ')：' + ((j && j.msg) || r.body.slice(0, 200));
    result = signResult('error', 'failed', title, lines.concat([title]));
  }

  // 4) 今日奖励（仅成功/已签时查询）
  if (result.level === 'success' || result.level === 'info') {
    reward = await queryTodayReward(token, devcode, ip, roleId, userId);
    if (reward) { result.reward = reward; result.lines = result.lines.concat(['🎁 今日奖励：' + reward]); }
  }

  // 账号显示名（用于日报/界面）
  result.accountName = maskPhone(mobile) || (account.nickname || '');
  result.roleName = roleName;
  result.userId = userId;
  return { result, credentialsUpdate: dirty ? update : null };
}

module.exports = {
  id: 'kuro',
  name: '鸣潮',
  community: '库街区',
  defaultEnabled: true,
  defaultTime: '05:50',
  loginMethods: [
    // 登录方式：短信验证码（推荐，用户实测可用） / 粘贴 token（兜底） / 网页登录
    // 每种方式带 help（官方网址 + 小白分步操作说明），由登录弹窗「官方网址与操作步骤」帮助区渲染
    { id: 'sms', kind: 'sms', label: '手机号+短信验证码（推荐）', needs: ['mobile', 'code'], hint: '用手机库街区给同一手机号发码，把收到的验证码填回本应用；发码可能触发极验人机验证（当前为图标点选），触发时改用「粘贴 token」', help: {
      links: [{ url: 'https://www.kurobbs.com/', text: '库街区网页版' }],
      steps: [
        '① 在本应用填 11 位手机号，点「发送验证码」；',
        '② 若提示「需要人机验证」（极验为图标点选，本应用内无法完成）：改用手机上的库街区 App 或官网登录页，用同一个手机号申请验证码；',
        '③ 把收到的 6 位验证码填回本应用，点「登录」，成功后自动把 token 绑定到该账号并加密保存；',
        '④ 点「测试签到」确认能签到。',
        '失效处理：签到提示「登录已过期」→ 重新发验证码登录，或改用「粘贴 token」。',
      ],
    } },

    { id: 'paste', kind: 'paste', label: '粘贴 token', needs: ['token'], hint: '粘贴库街区 token（或 {"token":..., "distinct_id":...} JSON），仅加密存储、不会明文回显。抓取方法见下方帮助区', help: {
      links: [{ url: 'https://www.kurobbs.com/', text: '库街区网页版' }],
      steps: [
        '① 用电脑浏览器打开 https://www.kurobbs.com/ 并登录自己的账号（或打开库街区 App 登录）；',
        '② 按 F12 → Network → 刷新页面，选一个 api.kurobbs.com 请求，在请求头里找到 token（网页端是 localStorage 的 AUTH_TOKEN；嫌麻烦建议直接改用「网页登录」，它会自动提取，无需抓包）；',
        '③ 把整段 token（或 {"token":..., "distinct_id":...} JSON）粘贴到本应用「粘贴 token」框；',
        '④ 保存后点「测试签到」确认。',
        '注意：粘贴 token 无自动续期，失效后需重新粘贴；网页 token 与 App token 分端，粘贴来源要选对。',
      ],
    } },

    { id: 'web', kind: 'web', label: '网页登录', needs: ['web'], hint: '打开库街区网页版登录后自动提取登录态（AUTH_TOKEN），免手动抓包', help: {
      links: [{ url: 'https://www.kurobbs.com/', text: '库街区网页版' }],
      steps: [
        '① 点击「打开网页登录窗口」；',
        '② 在窗口中点右上角「立即登录」，用手机号+验证码完成登录（可能需过极验人机验证）；',
        '③ 登录成功后本应用会自动提取登录态并绑定账号；',
        '④ 回应用点「测试签到」确认。',
      ],
    }, webMeta: {
      loginUrl: 'https://www.kurobbs.com/',
      title: '库街区（鸣潮）登录',
      extractScript: `(async () => {
  const out = { game: 'kuro', origin: location.origin, href: location.href, localStorage: {} };
  const keys = ['AUTH_TOKEN', 'distinct_id', 'dc', 'auth'];
  for (const k of keys) { try { out.localStorage[k] = localStorage.getItem(k) || ''; } catch (e) { out.localStorage[k] = ''; } }
  out.token = out.localStorage['AUTH_TOKEN'] || '';
  if (out.token) {
    try {
      const body = new URLSearchParams();
      body.set('mobile', ''); body.set('devCode', out.localStorage['distinct_id'] || ''); body.set('distinct_id', out.localStorage['distinct_id'] || '');
      const r = await fetch('https://api.kurobbs.com/user/mineV2', { method: 'POST', headers: { 'source': 'h5', 'token': out.token, 'devCode': out.localStorage['distinct_id'] || '', 'distinct_id': out.localStorage['distinct_id'] || '', 'version': '3.0.0', 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: body.toString() });
      out.mineV2Status = r.status; out.mineV2 = await r.json().catch(() => null);
    } catch (e) { out.mineV2Error = String(e && e.message || e); }
  }
  return out;
})()`,
      validate: (extracted) => {
        const res = { usable: false, reason: '' };
        if (!extracted || typeof extracted !== 'object') { res.reason = '页面未返回可解析的登录态'; return res; }
        const token = extracted.token || (extracted.localStorage && extracted.localStorage.AUTH_TOKEN) || '';
        const distinctId = (extracted.localStorage && extracted.localStorage.distinct_id) || '';
        if (!token || !distinctId) { res.reason = '未检测到登录态（localStorage 缺少 AUTH_TOKEN），请先在网页中完成登录'; return res; }
        const mv = extracted.mineV2;
        if (mv && mv.code === 200 && mv.data && mv.data.mine) { res.usable = true; res.reason = ''; }
        else if (mv && (mv.code === 220 || mv.code === 401)) { res.reason = '检测到登录态但已失效（code=' + mv.code + '），请重新登录'; }
        else { res.usable = true; res.reason = ''; }
        return res;
      },
      buildCredentials: (extracted) => {
        const token = String(extracted.token || (extracted.localStorage && extracted.localStorage.AUTH_TOKEN) || '').trim();
        if (!token) throw new Error('未提取到库街区登录态（AUTH_TOKEN 为空）');
        const distinctId = String((extracted.localStorage && extracted.localStorage.distinct_id) || '').trim() || crypto.randomBytes(16).toString('hex');
        return { mobile: '', token, devcode: crypto.randomBytes(16).toString('hex'), distinct_id: distinctId, loginAt: new Date().toISOString(), source: 'web' };
      },
      degradation: { text: '网页登录暂不可用，请使用「手机号+短信验证码」或「粘贴 token」登录。', fallbackKinds: ['sms', 'paste'] },
    } },
  ],
  sendSmsCode,
  loginBySms,
  loginByPaste,
  signin,
  describeCredential,
  onRemove,
  meta: { version: '1.4.0', author: '官方插件', login: '短信验证码（推荐）/ 粘贴 token / 网页登录' },
};

// ---------- 账号摘要辅助（替代 main.js per-game 昵称硬编码） ----------
function describeCredential(cred) {
  const p = String((cred && cred.mobile) || '');
  return { nickname: p.length >= 7 ? p.slice(0, 3) + '****' + p.slice(-4) : p };
}

/** 卸载清理钩子（内置 kuro 不通过界面删除；空实现，满足插件契约完整性） */
async function onRemove() { /* 网页登录窗口由主进程管理，无插件级资源需清理 */ }
