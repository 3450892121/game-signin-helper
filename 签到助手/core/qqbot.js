'use strict';
/**
 * QQ 机器人通知模块：主动消息走 HTTPS，无常驻长连接、不需公网服务器
 * （仅绑定 openid 那一步临时连一次 WebSocket，拿到即断）。
 *
 * 零依赖：Node 内置 https + WebSocket（Electron 44 自带 Node 24，已实测内置）。
 * 本模块不 require electron，可在纯 Node 下单测。
 *
 * 能力：
 * - fetchToken：AppID+AppSecret → access_token（7200s，进程内缓存、提前刷新）
 * - sendText ：向已绑定用户发单聊文本（主动消息；日报/测试）
 * - startBind ：临时 WebSocket 连接接收一条用户消息取 user_openid（仅绑定时连接，用完即断）
 * - composeDailyText / reportSendTime / explainCode：纯函数（可单测）
 *
 * 设计原则：
 * - 任何网络失败只返回 { ok:false, error }，不抛给调用方（绝不影响签到主流程）
 * - 密钥只进请求头/请求体，不写入日志
 */

const https = require('https');
const crypto = require('crypto');

const API_HOST = 'api.bot.qq.com';
const TOKEN_PATH = '/app/getAppAccessToken';
const GATEWAY_PATH = '/gateway/bot';
const C2C_INTENT = 1 << 25;          // GROUP_AND_C2C_EVENT：单聊消息 / 好友添加等事件
const REPORT_DELAY_MIN = 30;         // 日报发送延迟：全局统一时间 + 30 分钟（等兜底补签跑完）
const BIND_TIMEOUT_MS = 3 * 60 * 1000;   // 绑定等待：3 分钟
const MAX_TEXT_LEN = 2800;           // 单条消息保守上限（超出截断）

// ---------------------------------------------------------------------------
// 纯函数：专属绑定码（防误绑——只有把软件界面显示的一次性码发给机器人，才算完成绑定）
// ---------------------------------------------------------------------------
const BIND_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉易混淆字符 0/O/1/I

function generateBindCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += BIND_CODE_CHARS[crypto.randomInt(0, BIND_CODE_CHARS.length)];
  return s;
}

/** 消息是否包含绑定码（忽略空格与大小写；支持「绑定 XXXXXX」等任意夹带形式） */
function bindCodeMatches(content, code) {
  if (!code) return false;
  const norm = (x) => String(x == null ? '' : x).replace(/\s+/g, '').toUpperCase();
  return norm(content).indexOf(norm(code)) >= 0;
}

// ---------------------------------------------------------------------------
// 基础 HTTP（resolve 永不 reject；错误进 error 字段）
// ---------------------------------------------------------------------------
function requestJson(method, apiPath, headers, bodyObj, timeoutMs) {
  return new Promise((resolve) => {
    let body = '';
    if (bodyObj !== undefined) body = JSON.stringify(bodyObj);
    const h = Object.assign({
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    }, headers || {});
    const req = https.request({
      host: API_HOST, port: 443, path: apiPath, method, headers: h, timeout: timeoutMs || 15000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, json, body: d });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, body: '', error: e.message }));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ status: 0, json: null, body: '', error: '请求超时' }); });
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 纯函数：错误码 → 人话（写日志与界面直接用）
// ---------------------------------------------------------------------------
function explainCode(code, message) {
  const table = {
    100001: '请求过于频繁，请稍后重试',
    100007: 'AppID 无效，或机器人状态异常（被封禁/已删除），请到 QQ 开放平台检查',
    100016: 'AppID 或 AppSecret 不正确，请到 QQ 开放平台核对后重新填写',
    10004: 'AppID 对应的机器人不存在，请核对 AppID',
    11243: '访问凭证未通过，请核对 AppSecret',
    11253: '该机器人暂无此接口权限，请到 QQ 开放平台查看权限设置',
    22006: '消息类型与内容不匹配（内部错误，请反馈）',
    40034006: '消息内容被平台审核拦截，请修改内容后重试',
    40034100: '主动消息发送超过频控限制（当天额度用尽或发送过快）',
    40034105: '机器人暂无主动消息权限：请到 QQ 开放平台检查机器人权限设置',
    40034122: '召回消息已达区间上限',
    40034127: '无 markdown 模板权限（本应用使用纯文本，不应触发）',
    40054004: '机器人还不是你的好友：请在 QQ 里把机器人添加为好友（或加入消息列表）后再试',
    40054005: '消息被平台判为重复，请稍后重试',
    40054006: '好友关系校验失败，请稍后重试',
    40054007: '消息太长，超出平台限制',
    40054013: '你已在 QQ 机器人资料卡关闭了「主动消息」推送，请在资料卡中重新开启',
    40054016: '机器人已下线，请到 QQ 开放平台检查机器人状态',
    40054018: '消息过长或异常',
  };
  if (code === undefined || code === null || code === 0) return '';
  const base = table[code] || ('发送失败（错误码 ' + code + (message ? '：' + message : '') + '）');
  return base;
}

// ---------------------------------------------------------------------------
// 纯函数：日报发送时刻 = 全局统一时间 + 30 分钟；跨天则钳制到当天 23:59
// ---------------------------------------------------------------------------
function reportSendTime(defaultTime, now) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(defaultTime || '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  const base = (now instanceof Date && !isNaN(now.getTime())) ? now : new Date();
  let d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, min + REPORT_DELAY_MIN, 0, 0);
  if (d.getFullYear() !== base.getFullYear() || d.getMonth() !== base.getMonth() || d.getDate() !== base.getDate()) {
    d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 0, 0);
  }
  return { ts: d.getTime(), hh: d.getHours(), mm: d.getMinutes() };
}

// ---------------------------------------------------------------------------
// 纯函数：日报文本（详细版·逐账号；口径与 logger.summarizeDay 一致：
// 同账号当天任一成功即算成功）
// ---------------------------------------------------------------------------
function cleanTitle(t) {
  const s = String(t == null ? '' : t).replace(/^[✅❌]\s*/, '').trim();
  return s || '签到失败';
}

/**
 * @param {object} results logger.loadTodayResults 结构：{ [gameId]: [ {accountId, nickname, ok, title, reward, at} ] }
 * @param {object} meta { dateLabel, untilLabel, games: [ { id, name, community, accounts: [ {id, nickname} ] } ] }
 */
function composeDailyText(results, meta) {
  meta = meta || {};
  const lines = ['【签到日报】' + (meta.dateLabel || '') + (meta.untilLabel ? '（截至 ' + meta.untilLabel + '）' : '')];
  let okN = 0, failN = 0, noneN = 0, any = false;
  const games = Array.isArray(meta.games) ? meta.games : [];
  for (const g of games) {
    if (!g || !g.id) continue;
    const list = (results && Array.isArray(results[g.id])) ? results[g.id].filter((r) => r && typeof r === 'object') : [];
    const byAcc = new Map();
    for (const r of list) {
      const k = r.accountId || '__unknown__';
      if (!byAcc.has(k)) byAcc.set(k, []);
      byAcc.get(k).push(r);
    }
    const rows = [];
    const seen = new Set();
    for (const acc of Array.isArray(g.accounts) ? g.accounts : []) {
      const recs = byAcc.get(acc.id) || [];
      seen.add(acc.id);
      const nickname = acc.nickname || (recs.length ? recs[recs.length - 1].nickname : '') || ('账号' + String(acc.id || '').slice(-4));
      if (recs.some((r) => r.ok === true)) {
        okN++;
        const hit = recs.find((r) => r.ok === true && r.reward);
        rows.push('✅ ' + nickname + '：签到成功' + (hit && hit.reward ? '（奖励：' + hit.reward + '）' : ''));
      } else if (recs.length) {
        failN++;
        rows.push('❌ ' + nickname + '：' + cleanTitle(recs[recs.length - 1].title));
      } else {
        noneN++;
        rows.push('⬜ ' + nickname + '：今日无签到记录');
      }
    }
    // 结果里存在但当前账号清单没有的（如账号已被删除）：防御性列出，避免数据凭空消失
    for (const [aid, recs] of byAcc) {
      if (seen.has(aid)) continue;
      const last = recs[recs.length - 1];
      const nickname = last.nickname || ('账号' + String(aid).slice(-4));
      if (recs.some((r) => r.ok === true)) {
        okN++;
        const hit = recs.find((r) => r.ok === true && r.reward);
        rows.push('✅ ' + nickname + '：签到成功' + (hit && hit.reward ? '（奖励：' + hit.reward + '）' : ''));
      } else {
        failN++;
        rows.push('❌ ' + nickname + '：' + cleanTitle(last.title));
      }
    }
    if (!rows.length) continue;
    lines.push('── ' + g.name + (g.community ? '（' + g.community + '）' : '') + '──');
    for (const r of rows) lines.push(r);
    any = true;
  }
  if (!any) {
    lines.push('今日没有签到记录（应用未运行，或今天没有启用的签到任务）。');
    return lines.join('\n');
  }
  lines.push('合计：成功 ' + okN + ' · 失败 ' + failN + ' · 未跑 ' + noneN);
  let text = lines.join('\n');
  if (text.length > MAX_TEXT_LEN) text = text.slice(0, MAX_TEXT_LEN - 16) + '\n…（内容过长已截断）';
  return text;
}

// ---------------------------------------------------------------------------
// 实例（网络能力，闭包持缓存与绑定会话）
// ---------------------------------------------------------------------------
function create(opts) {
  opts = opts || {};
  const log = typeof opts.log === 'function' ? opts.log : function () { };

  let tokenCache = null;   // { key, token, expiresAt }
  let seqCounter = Math.floor(Math.random() * 1000);
  function nextSeq() { seqCounter = (seqCounter + 1) % 60000; return seqCounter + 1; }

  // 绑定会话（仅在「开始绑定 → 成功/失败」期间存在网络资源）
  let bind = { status: 'idle', openid: '', error: '', code: '', ws: null, hb: null, timeout: null, token: '' };

  function clearBindResources() {
    if (bind.hb) { clearInterval(bind.hb); bind.hb = null; }
    if (bind.timeout) { clearTimeout(bind.timeout); bind.timeout = null; }
    if (bind.ws) {
      const ws = bind.ws;
      bind.ws = null;
      try {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close();
      } catch (e) { /* 忽略 */ }
    }
  }

  function failBind(msg) {
    clearBindResources();
    bind.status = 'error';
    bind.error = String(msg || '绑定失败');
    log('⚠️ QQ 绑定失败：' + bind.error);
  }

  /** 取凭证（含缓存；提前 120s 刷新） */
  async function fetchToken(appId, appSecret) {
    const key = String(appId || '') + '|' + String(appSecret || '');
    if (tokenCache && tokenCache.key === key && Date.now() < tokenCache.expiresAt - 120000) {
      return { ok: true, token: tokenCache.token };
    }
    const r = await requestJson('POST', TOKEN_PATH, null, { appId: String(appId || ''), clientSecret: String(appSecret || '') });
    if (r.error) return { ok: false, error: '网络错误：' + r.error };
    const j = r.json || {};
    if (j.access_token) {
      const ttl = (parseInt(j.expires_in, 10) || 7200) * 1000;
      tokenCache = { key, token: j.access_token, expiresAt: Date.now() + ttl };
      return { ok: true, token: j.access_token };
    }
    const code = j.code !== undefined ? j.code : (r.status && r.status !== 200 ? r.status : undefined);
    return { ok: false, error: explainCode(code, j.message || ('HTTP ' + r.status)) };
  }

  /** 用已取得 token 发送（msgId 非空 = 被动回复该消息） */
  async function sendWithToken(token, openid, content, msgId) {
    const body = { msg_type: 0, content: String(content || ''), msg_seq: nextSeq() };
    if (msgId) body.msg_id = String(msgId);
    const r = await requestJson('POST', '/v2/users/' + encodeURIComponent(openid) + '/messages', { Authorization: 'QQBot ' + token }, body);
    if (r.error) return { ok: false, error: '网络错误：' + r.error };
    const j = r.json || {};
    const code = j.err_code !== undefined ? j.err_code : j.code;
    if (r.status >= 200 && r.status < 300 && (code === undefined || code === 0)) {
      return { ok: true, id: j.id || '' };
    }
    return { ok: false, error: explainCode(code !== undefined ? code : r.status, j.message || ''), code: code, status: r.status };
  }

  /** 对外：发送文本（主动消息）。cfg = { appId, appSecret, openid } */
  async function sendText(cfg, content) {
    cfg = cfg || {};
    if (!cfg.appId || !cfg.appSecret) return { ok: false, error: '未配置 AppID/AppSecret' };
    if (!cfg.openid) return { ok: false, error: '尚未绑定 QQ 机器人（先在通知设置里点「开始绑定」）' };
    const tok = await fetchToken(cfg.appId, cfg.appSecret);
    if (!tok.ok) return { ok: false, error: tok.error };
    return sendWithToken(tok.token, cfg.openid, content, '');
  }

  /**
 * 开始绑定：连临时 WebSocket 等一条**包含专属绑定码**的用户消息取 user_openid。
 * 不含绑定码的消息一律忽略（防陌生人/误发触发误绑）。
 * @param {object} cfg { appId, appSecret }
 * @param {function} [onOpenid] 收到 openid 时回调（由调用方持久化）
 * @returns {{ok:boolean, code?:string, error?:string}}
 */
  function startBind(cfg, onOpenid) {
    cfg = cfg || {};
    if (typeof WebSocket === 'undefined') {
      failBind('当前环境不支持 WebSocket（需 Electron 44+）');
      return { ok: false, error: bind.error };
    }
    if (!cfg.appId || !cfg.appSecret) {
      failBind('请先填写并保存 AppID 与 AppSecret');
      return { ok: false, error: bind.error };
    }
    clearBindResources();
    bind = { status: 'connecting', openid: '', error: '', code: generateBindCode(), ws: null, hb: null, timeout: null, token: '' };
    const self = bind;

    function guard(fn) { return function () { if (bind === self) fn.apply(null, arguments); }; }

    const openGateway = (url, token) => {
      let ws;
      try { ws = new WebSocket(url); } catch (e) { failBind('无法建立连接：' + (e.message || e)); return; }
      bind.ws = ws;
      let lastSeq = null;
      if (bind === self) {
        bind.timeout = setTimeout(() => {
          if (bind === self && (bind.status === 'connecting' || bind.status === 'waiting')) {
            clearBindResources();
            bind.status = 'expired';
            bind.error = '等待超时（3 分钟）：请重新点「开始绑定」，并在 QQ 里发送软件界面上显示的绑定码';
            log('⏰ QQ 绑定等待超时（3 分钟未收到含绑定码的消息）');
          }
        }, BIND_TIMEOUT_MS);
        if (typeof bind.timeout.unref === 'function') { try { bind.timeout.unref(); } catch (e) { /* ignore */ } }
      }
      ws.onopen = guard(() => { if (bind.status === 'connecting') bind.status = 'waiting'; });
      ws.onmessage = guard((ev) => {
        let msg = null;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.op === 10) {
          const interval = (msg.d && msg.d.heartbeat_interval) || 45000;
          try {
            ws.send(JSON.stringify({
              op: 2,
              d: {
                token: 'QQBot ' + token,
                intents: C2C_INTENT,
                shard: [0, 1],
                properties: { $os: 'Windows', $browser: 'game-signin-helper', $device: 'game-signin-helper' },
              },
            }));
          } catch (e) { failBind('发送鉴权请求失败：' + (e.message || e)); return; }
          if (bind.hb) clearInterval(bind.hb);
          bind.hb = setInterval(() => {
            try { ws.send(JSON.stringify({ op: 1, d: lastSeq || null })); } catch (e) { /* 断线由 onclose 兜底 */ }
          }, interval);
          if (typeof bind.hb.unref === 'function') { try { bind.hb.unref(); } catch (e) { /* ignore */ } }
        } else if (msg.op === 0) {
          if (typeof msg.s === 'number') lastSeq = msg.s;
          if (msg.t === 'C2C_MESSAGE_CREATE') {
            const d = msg.d || {};
            const openid = d.author && d.author.user_openid;
            if (!openid) return;
            // 专属绑定码校验：只有包含软件界面显示的绑定码的消息才算绑定，其余一律忽略
            if (!bindCodeMatches(d.content, bind.code)) {
              log('🤖 QQ 绑定：收到一条不含绑定码的消息，已忽略（未计入绑定）');
              return;
            }
            const msgId = d.id || '';
            const bindToken = bind.token;
            clearBindResources();
            bind.status = 'done';
            bind.openid = openid;
            bind.code = '';
            log('🤖 QQ 绑定：绑定码校验通过（用户身份尾号 ' + String(openid).slice(-6) + '）');
            sendWithToken(bindToken, openid, '✅ 绑定成功！以后每天的签到日报会发到这里。', msgId)
              .then((r) => { if (!r.ok) log('⚠️ 绑定确认消息发送失败：' + r.error); })
              .catch(() => { /* 忽略 */ });
            if (typeof onOpenid === 'function') {
              try { onOpenid(openid); } catch (e) { log('⚠️ 绑定结果保存失败：' + (e.message || e)); }
            }
          } else if (msg.t === 'READY') {
            log('🤖 QQ 绑定：连接就绪，等待你在 QQ 里给机器人发消息…');
          }
        } else if (msg.op === 9) {
          failBind('鉴权被拒绝：请核对 AppID/AppSecret，并确认机器人已开通「单聊消息事件」权限（开放平台 → 开发设置）');
        }
      });
      ws.onerror = guard(() => { /* 具体原因由 onclose 给出 */ });
      ws.onclose = guard((ev) => {
        if (bind !== self) return;
        if (bind.status === 'connecting' || bind.status === 'waiting') {
          const code = ev && ev.code;
          const hint = (code === 4013 || code === 4014)
            ? '：该机器人没有「单聊消息事件」权限（Intents），请到 QQ 开放平台检查权限并申请'
            : (code ? '（连接被关闭，code=' + code + '）' : '');
          failBind('连接已断开，请重试' + hint);
        }
      });
    };

    (async () => {
      const tok = await fetchToken(cfg.appId, cfg.appSecret);
      if (!tok.ok) { failBind(tok.error); return; }
      if (bind !== self) return;
      bind.token = tok.token;
      const gw = await requestJson('GET', GATEWAY_PATH, { Authorization: 'QQBot ' + tok.token });
      if (bind !== self) return;
      if (gw.error) { failBind('获取接入点网络错误：' + gw.error); return; }
      const j = gw.json || {};
      const url = j.url || (j.data && j.data.url) || '';
      if (!url) { failBind(explainCode(j.code, j.message || ('获取接入点失败（HTTP ' + gw.status + '）'))); return; }
      openGateway(url, tok.token);
    })().catch((e) => { if (bind === self && bind.status === 'connecting') failBind(e.message || String(e)); });

    return { ok: true };
  }

  /** 取消绑定（用户主动放弃；done 状态保留） */
  function stopBind() {
    if (bind.status === 'connecting' || bind.status === 'waiting') {
      clearBindResources();
      bind.status = 'idle';
      bind.error = '';
      log('🤖 QQ 绑定已取消');
    } else {
      clearBindResources();
    }
  }

  /** 当前绑定状态（done 保留 openid；等待期间返回本次专属绑定码供界面显示） */
  function getBindState() {
    const waiting = bind.status === 'connecting' || bind.status === 'waiting';
    return { status: bind.status, openid: bind.openid, error: bind.error, code: waiting ? bind.code : '' };
  }

  return { fetchToken, sendText, startBind, stopBind, getBindState };
}

module.exports = {
  create,
  composeDailyText,
  reportSendTime,
  explainCode,
  generateBindCode,
  bindCodeMatches,
  API_HOST,
  C2C_INTENT,
  REPORT_DELAY_MIN,
  MAX_TEXT_LEN,
};
