'use strict';
/**
 * 通知模块：Server酱 / PushPlus / 企业微信机器人 / 邮箱（SMTP）
 * 配置来源：settings.notify（由 storage 提供），从原 dsh-common 迁移并去耦合
 * SMTP 使用 Node 内置 net/tls 实现（t15：零新增依赖，兼容零依赖原则）。
 */

const https = require('https');
const http = require('http');

function requestUrl(method, url, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('通知地址不是合法URL')); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const h = Object.assign({ 'Content-Length': Buffer.byteLength(bodyStr || '') }, headers || {});
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: h,
      timeout: 15000,
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

/** 构造 SMTP 邮件文本（UTF-8 base64 编码正文/主题，避免中文头部乱码） */
function buildSmtpMessage(user, to, title, content) {
  const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
  // 正文 base64 按 76 字符折行（RFC 5321 单行限 998 字节；长失败通知整信一行会被服务器拒收）
  const b64Folded = (s) => b64(s).replace(/(.{76})/g, '$1\r\n');
  // 主题按 RFC 2047 encoded-word（总长 ≤75 字符）切分，续行以 CRLF+空格 折叠（段长取 60=4 的倍数保证可独立解码）
  const raw = b64(title || '通知');
  const subjParts = [];
  for (let i = 0; i < raw.length; i += 60) subjParts.push('=?UTF-8?B?' + raw.slice(i, i + 60) + '?=');
  return [
    'From: <' + user + '>',
    'To: <' + to + '>',
    'Subject: ' + subjParts.join('\r\n '),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Folded(content || ''),
  ].join('\r\n');
}

/**
 * SMTP 发送（Node 内置 net/tls，零依赖）。
 * 465 = 隐式 TLS；587/其它 = 明文握手后按 EHLO 能力做 STARTTLS；之后再 AUTH LOGIN + 发信。
 * @returns {Promise<{status:number,detail:string}>} 成功返回 {status:250}（与 HTTP 渠道 2xx 判定一致）
 */
function smtpSend(cfg, title, content) {
  return new Promise((resolve, reject) => {
    const host = String(cfg.smtpHost || '').trim();
    const portP = String(cfg.smtpPort || '').trim();
    const port = /^\d+$/.test(portP) ? parseInt(portP, 10) : 587;
    const user = String(cfg.user || '').trim();
    const pass = String(cfg.pass || '');
    const to = String(cfg.to || '').trim().split(/[;,，]/)[0].trim();
    if (!host || !pass || !to) { reject(new Error('SMTP 需填写 smtpHost/pass/to')); return; }

    const net = require('net');
    const tls = require('tls');
    const message = buildSmtpMessage(user, to, title, content);

    let sock;
    let buf = '';
    let advertise = '';
    let seq = [];
    let settled = false;

    const fail = (m) => { if (!settled) { settled = true; try { sock && sock.destroy(); } catch (e) {} reject(new Error(m)); } };
    const done = () => { if (!settled) { settled = true; try { sock && sock.destroy(); } catch (e) {} resolve({ status: 250, detail: 'SMTP 已发送' }); } };
    const say = (l) => { try { sock.write(l + '\r\n'); } catch (e) { fail('SMTP 写失败：' + e.message); } };

    /** 认证与发信子序列（在 EHLO 通过或 TLS 升级后追加） */
    function attachAuth() {
      seq.push({ expect: 334, cmd: 'AUTH LOGIN' });
      seq.push({ expect: 334, cmd: Buffer.from(user, 'utf8').toString('base64') });
      seq.push({ expect: 235, cmd: Buffer.from(pass, 'utf8').toString('base64') });
      seq.push({ expect: 250, cmd: 'MAIL FROM:<' + user + '>' });
      seq.push({ expect: 250, cmd: 'RCPT TO:<' + to + '>' });
      // 修复 t16：DATA 的 onOk 用 unshift 把消息体（期待 250）插入队头——它必须排在 QUIT 之前，
      // 用 push 会追加到队尾（QUIT 后面），导致收到 354 后直接跳发 QUIT、跳过邮件正文。
      seq.push({ expect: 354, cmd: 'DATA', onOk: () => { seq.unshift({ expect: 250, cmd: message + '\r\n.' }); } });
      seq.push({ expect: 221, cmd: 'QUIT' });
    }

    /** 升级到 TLS（587/其它端口 STARTTLS 成功后调用） */
    function upgradeTls() {
      sock = tls.connect({ socket: sock, rejectUnauthorized: true }, () => {
        seq.push({ expect: 250, cmd: 'EHLO ' + host, onOk: () => { attachAuth(); } });
        say('EHLO ' + host);
      });
      sock.on('data', onData);
      sock.on('error', (e) => fail('SMTP(TLS) 错误：' + e.message));
      sock.setTimeout(20000, () => fail('SMTP 超时'));
    }

    function onData(data) {
      buf += String(data || '');
      let nl;
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (/^\d{3}-/.test(line)) { advertise += line + '\n'; continue; } // 多行回复（如 EHLO 能力）积累
        const code = parseInt(line.slice(0, 3), 10);
        const text = line.length > 4 ? line.slice(4) : '';
        const cur = seq[0];
        if (!cur) { fail('SMTP 意外响应：' + (text || line)); return; }
        if (code !== cur.expect) { fail('SMTP 期望 ' + cur.expect + ' 实得 ' + code + '：' + (text || '')); return; }
        seq.shift();
        if (code >= 500) { fail('SMTP 服务器拒绝：' + (text || '')); return; }
        if (cur.onOk) {
          const act = cur.onOk(code, text, advertise);
          advertise = '';
          if (act === 'upgrade') { upgradeTls(); continue; }
        }
        if (seq[0] && seq[0].cmd) say(seq[0].cmd);
        if (!seq.length) done();
      }
    }

    const isImplicitTls = port === 465;
    seq.push({ expect: 220 });                                          // 服务器问候
    seq.push({ expect: 250, cmd: 'EHLO ' + host, onOk: (code, text, adv) => {
      if (!isImplicitTls && /STARTTLS/i.test(adv + ' ' + text)) {
        seq.push({ expect: 220, cmd: 'STARTTLS', onOk: () => 'upgrade' });
      } else {
        attachAuth();
      }
    }});

    // 修复 t16：初始连接不主动发 EHLO——seq[0] 期待的是服务器 220 问候，
    // 收到 220 后 onData 会按队列自动发出 EHLO（否则 connect 回调抢先发 EHLO，
    // 收到 220 后又重复发一次，两个 EHLO 的多行 250 响应残留导致与 AUTH 334 失配）。
    if (isImplicitTls) {
      sock = tls.connect({ host, port, rejectUnauthorized: true });
    } else {
      sock = net.connect({ host, port });
    }
    sock.on('data', onData);
    sock.on('error', (e) => fail('SMTP 连接错误：' + e.message));
    sock.setTimeout(20000, () => fail('SMTP 超时'));
  });
}

/** 业务结果解析：HTTP 2xx ≠ 业务成功——
 * 企微 webhook 错误 key 返回 {errcode:40008}、pushplus 返回 {code:903}、Server酱 {code:40001} 等 */
function bizResult(body) {
  try {
    const j = JSON.parse(body);
    if (j && typeof j === 'object') {
      if (j.errcode !== undefined) return { ok: j.errcode === 0, detail: 'errcode=' + j.errcode + (j.errmsg ? ' ' + j.errmsg : '') };
      if (j.code !== undefined && j.code !== null) return { ok: j.code === 0 || j.code === 200, detail: 'code=' + j.code + (j.msg ? ' ' + j.msg : '') };
    }
  } catch (e) { /* 非 JSON（SMTP 等无 body 渠道）：按 HTTP 状态判定 */ }
  return { ok: true, detail: '' };
}

/**
 * 向已配置渠道推送告警
 * @param {object} notifyCfg settings.notify：{ serverchan:{sendKey}, pushplus:{token,template}, wecom:{webhook}, email:{smtpHost,smtpPort,user,pass,to} }
 * @param {function} [log] 日志回调（可选）
 * @returns {Promise<number>} 已发送渠道数
 */
async function notify(notifyCfg, title, content, log) {
  const conf = notifyCfg || {};
  const jobs = [];
  if (conf.serverchan && conf.serverchan.sendKey) {
    jobs.push(() => requestUrl('POST',
      'https://sctapi.ftqq.com/' + encodeURIComponent(conf.serverchan.sendKey) + '.send',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      'title=' + encodeURIComponent(title) + '&desp=' + encodeURIComponent(content)));
  }
  if (conf.pushplus && conf.pushplus.token) {
    jobs.push(() => requestUrl('POST', 'https://www.pushplus.plus/send',
      { 'Content-Type': 'application/json' },
      JSON.stringify({ token: conf.pushplus.token, title, content, template: conf.pushplus.template || 'html' })));
  }
  if (conf.wecom && conf.wecom.webhook) {
    jobs.push(() => requestUrl('POST', conf.wecom.webhook, { 'Content-Type': 'application/json' },
      JSON.stringify({ msgtype: 'text', text: { content: title + '\n' + content } })));
  }
  // t15：邮箱(SMTP)渠道——smtpHost+pass 必须配置才启用
  if (conf.email && conf.email.smtpHost && conf.email.pass) {
    jobs.push(() => smtpSend(conf.email, title, content));
  }
  if (!jobs.length) return 0;
  let ok = 0;
  await Promise.all(jobs.map(async (fn) => {
    try {
      const r = await fn();
      const httpOk = r.status >= 200 && r.status < 300;
      const biz = bizResult(r.body);   // 2xx 但业务码失败（如企微 key 错误）不再误报已发送
      if (httpOk && biz.ok) { ok++; if (log) log('📣 失败告警已发送'); }
      else if (log) log('📣 告警渠道返回异常：HTTP ' + r.status + (biz.ok ? '' : ' / ' + biz.detail));
    } catch (e) {
      if (log) log('📣 告警发送失败：' + e.message);
    }
  }));
  return ok;
}

module.exports = { notify, smtpSend };
