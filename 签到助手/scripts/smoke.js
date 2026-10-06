'use strict';
/**
 * 阶段 0 冒烟测试
 *
 * 用法：
 * node scripts/smoke.js # 只读级：验证模块可加载 + 现有凭据有效
 * node scripts/smoke.js --login # 登录接口无副作用部分（生成二维码/申请验证任务/设备指纹）
 * node scripts/smoke.js --full # 完整级：kuro/mihoyo 真实 signin（今天已签过=无副作用）
 *
 * 安全设计（不破坏用户现有脚本）：
 * - 不向任何真实用户发短信：发码可达性探测一律用未分配号段 13800000000，且只判「接口是否可达」，
 * 不校验业务 code（注意：这仍是一次真实的服务器请求，会消耗该 IP/指纹的发码配额）
 * - 塔吉多只做只读检查（不触发 refreshToken 轮换，避免影响明早 schtasks）
 * - mihoyo 的 SToken 续期是查询性质，无服务器端副作用
 * - 所有测试都不写任何配置文件
 */

const path = require('path');

// 真实凭据实校改为可选项：v2 起凭据存于应用加密存储（DPAPI），Node 侧无法解密。
// 需要凭据实校时用环境变量指向同构 JSON（旧 config.json 与 credentials 字段同构）：
// SMOKE_KURO_CONFIG / SMOKE_MIHOYO_CONFIG / SMOKE_TAJIDUO_CONFIG
const CONFIG_MAP = {
  kuro: process.env.SMOKE_KURO_CONFIG || '',
  mihoyo: process.env.SMOKE_MIHOYO_CONFIG || '',
  tajiduo: process.env.SMOKE_TAJIDUO_CONFIG || '',
};

const SCRIPTS_DIR = process.env.SCRIPTS_DIR || path.resolve(__dirname, '..', '..', '脚本');
const kuro = require(path.join(SCRIPTS_DIR, '鸣潮', 'index.js'));
const mihoyo = require(path.join(SCRIPTS_DIR, '崩铁', 'index.js'));
const tajiduo = require(path.join(SCRIPTS_DIR, '异环', 'index.js'));

let failures = 0;
function check(name, ok, detail) {
  const mark = ok ? '✅' : '❌';
  console.log(mark + ' ' + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}
// 跳过（SKIP）：旧三套脚本已归档（备份 zip），config 缺失时跳过而非失败
function skip(name, detail) {
  console.log('⏭ ' + name + (detail ? '  ' + detail : ''));
}

function loadConfig(game) {
  try {
    return JSON.parse(require('fs').readFileSync(CONFIG_MAP[game], 'utf8'));
  } catch (e) {
    return null;
  }
}

// ---------- 模块结构检查 ----------
function checkModule() {
  console.log('=== 模块结构 ===');
  for (const [id, mod] of [['kuro', kuro], ['mihoyo', mihoyo], ['tajiduo', tajiduo]]) {
    check(`${id}.id`, mod.id === id);
    check(`${id}.name/community`, typeof mod.name === 'string' && typeof mod.community === 'string');
    check(`${id}.loginMethods`, Array.isArray(mod.loginMethods) && mod.loginMethods.length > 0,
      mod.loginMethods.map(m => m.label).join(' / '));
    check(`${id}.signin`, typeof mod.signin === 'function');
  }
  check('kuro 短信登录', typeof kuro.sendSmsCode === 'function' && typeof kuro.loginBySms === 'function');
  check('mihoyo 网页登录 + 粘贴 Cookie', typeof mihoyo.loginByCookie === 'function'
    && !!((mihoyo.loginMethods.find(m => m.id === 'web') || {}).webMeta));
  check('mihoyo 已移除扫码与短信登录', typeof mihoyo.startQrLogin === 'undefined'
    && typeof mihoyo.queryQrLogin === 'undefined' && typeof mihoyo.completeQrLogin === 'undefined'
    && typeof mihoyo.sendSmsCode === 'undefined' && typeof mihoyo.loginBySms === 'undefined');
  check('tajiduo 短信 + 粘贴登录', typeof tajiduo.sendSmsCode === 'function' && typeof tajiduo.loginBySms === 'function' && typeof tajiduo.loginByPaste === 'function');
  check('tajiduo 已移除密码登录', typeof tajiduo.loginByPassword === 'undefined');
  check('tajiduo.genFingerprint', typeof tajiduo.genFingerprint === 'function');
}

// ---------- 游戏注册表冒烟（t4：双目录发现/校验/隔离/移除） ----------
async function registryCheck() {
  console.log('\n=== 游戏注册表（core/game-registry.js）===');
  const fs2 = require('fs');
  const os = require('os');
  const path2 = require('path');
  const registryMod = require('../core/game-registry.js');
  const tmpRoot = fs2.mkdtempSync(path2.join(os.tmpdir(), 't4reg-'));
  const tmp = path2.join(tmpRoot, 'plugins');
  // 1) 合法用户插件 t4-test（自带 paste 回调 + onRemove 清理钩子）
  const testDir = path2.join(tmp, 't4-test');
  fs2.mkdirSync(testDir, { recursive: true });
  fs2.writeFileSync(path2.join(testDir, 'index.js'), [
    "'use strict';",
    "module.exports = {",
    "  id: 't4-test',",
    "  name: '测试游戏',",
    "  community: '测试社区',",
    "  icon: '🧪',",
    "  loginMethods: [ { id: 'paste', kind: 'paste', label: '粘贴 token', needs: ['token'], hint: 't4 冒烟专用', paste: async (ctx, raw) => ({ token: String(raw || '').trim() }) } ],",
    "  describeCredential: () => ({ nickname: 't4-test' }),",
    "  onRemove: async () => { /* t4-test 清理钩子 */ },",
    "  signin: async () => ({ result: { ok: false, level: 'error', status: 'skipped', title: 't4-test 冒烟占位', lines: [], reward: '' }, credentialsUpdate: null })",
    "};"
  ].join('\n'));
  // 2) 非法插件 t4-bad（缺 signin/loginMethods）
  const badDir = path2.join(tmp, 't4-bad');
  fs2.mkdirSync(badDir, { recursive: true });
  fs2.writeFileSync(path2.join(badDir, 'index.js'), [
    "'use strict';",
    "module.exports = {",
    "  id: 't4-bad',",
    "  name: '坏插件'",
    "};"
  ].join('\n'));

  // 1) 真实官方插件（脚本/ 目录）作为用户插件被发现（只读，不在此移除）
  const realReg = registryMod.create({ userDir: path2.resolve(__dirname, '..', '..', '脚本') });
  const realLoaded = realReg.loadAll();
  const ids = realLoaded.games.map(g => g.id);
  check('脚本/ 目录插件被发现（source=user）', ['kuro', 'mihoyo', 'tajiduo'].every(id => { const g = realLoaded.games.find(x => x.id === id); return g && g.source === 'user'; }), 'games=' + ids.join('/'));
  check('kuro web 登录方式（webMeta）', !!((realLoaded.games.find(g => g.id === 'kuro') || {}).loginMethods || []).some(m => m.kind === 'web' && m.webMeta && m.webMeta.loginUrl));
  check('mihoyo web 登录方式（webMeta）', !!((realLoaded.games.find(g => g.id === 'mihoyo') || {}).loginMethods || []).some(m => m.kind === 'web' && m.webMeta && m.webMeta.loginUrl));

  // 2) 临时目录：合法插件发现 + 非法插件拒绝 + 移除（不影响真实 脚本/ 目录）
  const reg = registryMod.create({ userDir: tmp });
  const loaded = reg.loadAll();
  const u = loaded.games.find(g => g.id === 't4-test');
  check('用户插件目录被发现（source=user）', !!u && u.source === 'user', u ? ('source=' + u.source) : 't4-test 未发现');
  const bad = loaded.errors.find(e => e.idHint === 't4-bad');
  check('非法插件被拒绝且不拖垮其它（loadErrors 记录）', !!bad, bad ? ('errors=' + bad.errors.join('|')) : 't4-bad 未被拒绝/未记录');
  check('get()/has()/getLoginMethod 可用', !!reg.get('t4-test') && !reg.has('no-such') && !!reg.getLoginMethod('t4-test', 'paste') && !reg.getLoginMethod('t4-test', 'qr'));
  check('guessKind 兜底', registryMod.guessKind(['code']) === 'sms' && registryMod.guessKind(['password']) === 'password' && registryMod.guessKind(['web']) === 'web' && registryMod.guessKind(['token']) === 'paste');
  const removed = await reg.removePlugin('t4-test');
  check('removePlugin 移除用户插件（onRemove 钩子+删目录）', !!(removed.removed && removed.hook === 'ok' && removed.dirRemoved), JSON.stringify(removed));
  check('移除后 get 返回 null', !reg.has('t4-test'));
  try { fs2.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* 清理失败不阻断 */ }
}

// ---------- 只读凭据验证 ----------
async function readCheck() {
  console.log('\n=== 只读凭据验证（真实接口，无副作用）===');

  // 鸣潮：mineV2 验证 token
  const kc = loadConfig('kuro');
  if (kc && kc.token) {
    const fs = require('fs');
    const cred = { token: kc.token, devcode: kc.devcode || '', distinct_id: kc.distinct_id || '' };
    // 直接用模块内部不可访问，这里用登录头构造 mineV2 请求验证 token（只读）
    const https = require('https');
    const ip = (() => {
      const os = require('os');
      const nets = os.networkInterfaces();
      for (const n of Object.keys(nets)) for (const net of nets[n] || []) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
      return '127.0.0.1';
    })();
    const bodyStr = 'mobile=' + encodeURIComponent(kc.mobile || '') + '&' +
      'devCode=' + encodeURIComponent(cred.devcode) + '&' +
      'distinct_id=' + encodeURIComponent(cred.distinct_id);
    const mine = await new Promise((resolve) => {
      const req = https.request({ hostname: 'api.kurobbs.com', path: '/user/mineV2', method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(bodyStr), 'osversion': 'Android', 'countrycode': 'CN', 'ip': ip, 'model': '2211133C', 'source': 'android', 'lang': 'zh-Hans', 'version': '1.0.9', 'versioncode': '1090', 'deviceid': cred.distinct_id, 'token': cred.token, 'ds': '', 'User-Agent': 'okhttp/3.10.0', 'Accept': '*/*' },
        timeout: 15000 }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', () => resolve({ status: 0, body: '网络错误' }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '超时' }); });
      req.write(bodyStr); req.end();
    });
    const mj = (() => { try { return JSON.parse(mine.body); } catch { return null; } })();
    check('鸣潮 token 有效（mineV2）', mj && mj.code === 200 && mj.data && mj.data.mine,
      mj ? ('code=' + mj.code + ' userId=' + (mj.data && mj.data.mine ? mj.data.mine.userId : '?')) : ('HTTP ' + mine.status));
  } else {
    skip('鸣潮 config 缺失（旧脚本已归档，跳过 token 验证）', '未找到 ' + CONFIG_MAP.kuro);
  }

  // 崩铁：luna/home 验证 cookie
  const mc = loadConfig('mihoyo');
  if (mc && mc.cookie) {
    try {
      const r = await mihoyoSignRead(mc.cookie);
      check('崩铁 cookie 有效（luna/home）', r.valid, r.retcode !== undefined ? 'retcode=' + r.retcode : 'HTTP ' + r.status);
    } catch (e) {
      check('崩铁 cookie 有效（luna/home）', false, e.message);
    }
  } else {
    skip('崩铁 config 缺失（旧脚本已归档，跳过 cookie 验证）', '未找到 ' + CONFIG_MAP.mihoyo);
  }

  // 异环：getUserTasks 验证 token（t11：GET + HTTP 200 真实校验，杜绝 405 假阳性）
  const tc = loadConfig('tajiduo');
  if (tc && tc.token) {
    try {
      const r = await tajiduoRead(tc);
      check('异环 token 有效（getUserTasks）', r.valid, r.detail);
    } catch (e) {
      check('异环 token 有效（getUserTasks）', false, e.message);
    }
  } else {
    skip('异环 config 缺失（旧脚本已归档，跳过 token 验证）', '未找到 ' + CONFIG_MAP.tajiduo);
  }
}

// 崩铁只读：直接用 luna/home
function mihoyoSignRead(cookie) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const crypto = require('crypto');
    const ts = String(Math.floor(Date.now() / 1000));
    const r = crypto.randomBytes(6).toString('hex').slice(0, 6);
    const md5 = crypto.createHash('md5').update('salt=yBh10ikxtLPoIhgwgPZSv5dmfaOTSJ6a&t=' + ts + '&r=' + r).digest('hex');
    const ds = ts + ',' + r + ',' + md5;
    const u = new URL('https://api-takumi.mihoyo.com/event/luna/home');
    u.searchParams.append('act_id', 'e202304121516551');
    u.searchParams.append('lang', 'zh-cn');
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'Cookie': cookie, 'x-rpc-app_version': '2.102.1', 'X-Requested-With': 'com.mihoyo.hyperion', 'x-rpc-client_type': '5', 'Referer': 'https://webstatic.mihoyo.com/', 'Origin': 'https://webstatic.mihoyo.com/', 'DS': ds, 'x-rpc-device_id': crypto.randomBytes(16).toString('hex'), 'x-rpc-device_fp': crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 13), 'x-rpc-signgame': 'hkrpg', 'User-Agent': 'Mozilla/5.0 (Linux; Android 13; PHK110 Build/SKQ1.221119.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.133 Mobile Safari/537.36 miHoYoBBS/2.102.1' },
      timeout: 15000 }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { const j = JSON.parse(d); resolve({ valid: j.retcode === 0, retcode: j.retcode, status: res.statusCode }); }
        catch { resolve({ valid: false, status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('超时')); });
    req.end();
  });
}

// 异环只读：getUserTasks（用模块的 nativeHeaders 逻辑简化；t11：改 GET 真实校验）
// 坑：POST /apihub/api/getUserTasks 返回 405（Method Not Allowed），但响应体仍包装 {ok:true,code:0}
// → 仅按 ok/code 判断会产生「假阳性」（实际未验证 token）。参考异环_signin.js 用 GET + 强制 HTTP 200。
function tajiduoRead(cfg) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const crypto = require('crypto');
    const ALPH = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const ts = String(Math.floor(Date.now() / 1000));
    let nonce = '';
    for (let i = 0; i < 8; i++) nonce += ALPH[Math.floor(Math.random() * ALPH.length)];
    const sig = crypto.createHash('md5').update(ts + nonce + '1.2.2' + 'pUds3dfMkl').digest('hex');
    const ds = `${ts},${nonce},${sig}`;
    const req = https.request({ hostname: 'bbs-api.tajiduo.com', path: '/apihub/api/getUserTasks?gid=1', method: 'GET',
      headers: { 'Accept': 'application/json, text/plain, */*', 'User-Agent': 'HTAssistant/106 CFNetwork/3860.200.71 Darwin/25.1.0', 'Authorization': cfg.token, 'appversion': '1.2.2', 'platform': 'ios', 'uid': cfg.uid || '0', 'deviceid': cfg.deviceid || '', 'ds': ds },
      timeout: 15000 }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const ok = res.statusCode === 200 && j.ok === true && j.code === 0;
          resolve({ valid: ok, detail: 'HTTP ' + res.statusCode + ' ok=' + j.ok + ' code=' + j.code + (ok && j.data ? '（有任务数据）' : (ok ? '' : '（token 可能失效）')) });
        } catch { resolve({ valid: false, detail: '响应非JSON' }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('超时')); });
    req.end();
  });
}

// ---------- 登录接口无副作用部分 ----------
async function loginChecks() {
  console.log('\n=== 登录接口（无副作用部分）===');
  // 米游社（崩铁）不再做发码/扫码探测：扫码 panda 端点已失效、短信链路已移除（依据见插件头部注释）。
  // 崩铁现只剩网页登录与粘贴 Cookie，两者都需要真实浏览器或真实 Cookie，无法在无副作用前提下冒烟。
  try {
    // t3 复核（契约 R2.4.2）：库街区 APP 端发码可达性（13800000000；触发极验 needGeeTest=true 也算可达）
    const s = await kuro.sendSmsCode('13800000000');
    const reachable = !/响应解析失败|网络错误|超时/.test(s.msg);
    check('库街区发码接口可达（未注册号探测）', reachable, 'ok=' + s.ok + ' needGeeTest=' + s.needGeeTest + ' msg=' + s.msg.slice(0, 80));
  } catch (e) {
    check('库街区发码接口可达（未注册号探测）', false, e.message);
  }
  try {
    // t3 复核（契约 R2.4.2）：塔吉多 laohu 发码可达性（13800000000；不向真实用户发码，返回业务响应即可达）
    const fp = tajiduo.genFingerprint();
    const s = await tajiduo.sendSmsCode('13800000000', fp);
    const reachable = !/响应非 JSON|网络错误|超时/.test(s.msg);
    check('塔吉多发码接口可达（未注册号探测）', reachable, 'ok=' + s.ok + ' msg=' + s.msg.slice(0, 120));
  } catch (e) {
    check('塔吉多发码接口可达（未注册号探测）', false, e.message);
  }
  const fp = tajiduo.genFingerprint();
  check('塔吉多生成设备指纹', !!(fp.deviceid && fp.openudid && fp.vendorid), 'deviceid=' + fp.deviceid.slice(0, 8) + '…');
}

// ---------- 完整级：真实 signin（今天已签过=无副作用）----------
async function fullSignin() {
  console.log('\n=== 完整 signin（kuro/mihoyo；塔吉多仅只读）===');
  const fs = require('fs');

  const kc = loadConfig('kuro');
  if (kc && kc.token) {
    const account = {
      id: 'smoke-kuro',
      game: 'kuro',
      nickname: kc.mobile || '冒烟测试',
      credentials: kc,
    };
    try {
      const { result, credentialsUpdate } = await kuro.signin(account);
      check('鸣潮 signin 返回', result && typeof result.ok === 'boolean' && result.title,
        result.title + (result.reward ? ' 奖励=' + result.reward : ''));
      check('鸣潮 signin 凭据增量', credentialsUpdate === null || typeof credentialsUpdate === 'object');
      result.lines.forEach(l => console.log('    ' + l));
    } catch (e) {
      check('鸣潮 signin', false, e.message);
    }
  } else {
    skip('鸣潮 signin（无凭据，旧脚本已归档）', '未找到 ' + CONFIG_MAP.kuro);
  }

  const mc = loadConfig('mihoyo');
  if (mc && mc.cookie) {
    const account = {
      id: 'smoke-mihoyo',
      game: 'mihoyo',
      nickname: mc.userName || '冒烟测试',
      credentials: mc,
    };
    try {
      const { result, credentialsUpdate } = await mihoyo.signin(account);
      check('崩铁 signin 返回', result && typeof result.ok === 'boolean' && result.title,
        result.title + (result.reward ? ' 奖励=' + result.reward : ''));
      check('崩铁 signin 凭据增量', credentialsUpdate === null || typeof credentialsUpdate === 'object');
      result.lines.forEach(l => console.log('    ' + l));
    } catch (e) {
      check('崩铁 signin', false, e.message);
    }
  } else {
    skip('崩铁 signin（无凭据，旧脚本已归档）', '未找到 ' + CONFIG_MAP.mihoyo);
  }

  const tc = loadConfig('tajiduo');
  if (tc && tc.token) {
    // 只读验证（已在 readCheck 做过）；这里仅确认模块 signin 导出（不执行，避免轮换 refreshToken）
    check('异环 signin 已导出（跳过执行）', typeof tajiduo.signin === 'function', '为避免轮换 refreshToken 影响明早计划任务，--full 不执行异环 signin');
  }
}

(async () => {
  checkModule();
  await registryCheck();
  await readCheck();
  if (process.argv.includes('--login')) await loginChecks();
  if (process.argv.includes('--full')) await fullSignin();
  console.log('\n' + (failures === 0 ? '🎉 全部通过' : `❌ ${failures} 项失败`));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('冒烟测试异常：' + e.message); process.exit(1); });
