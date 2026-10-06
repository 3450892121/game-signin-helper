'use strict';
/**
 * core/browser-login.js —— 本地「浏览器登录界面」服务器模块（通用框架，服务 kind:'gui' 登录方式）
 *
 * 用途：插件声明 kind:'gui' 时，主进程起一个仅 127.0.0.1 可访问的 HTTP 服务，用系统默认浏览器
 * 打开 core/login-gui.html；页面里的各个 tab 通过 /api/* 回调主进程完成登录，成功后由主进程
 * 加密存档并刷新界面。凭据不经过浏览器页面——页面只拿到账号摘要（手机号掩码/uid 等）。
 *
 * ⚠️ 别把塔吉多短信登录归因为「官方风控」。应用内发码若返回 code=1
 * 『短信正在发送，长时间收不到请用语音验证码』，先查设备指纹是不是每次登录都在变
 * （见 main.js 的 makeLoginCtx 与 <dataDir>/fingerprints.json）。外部项目
 * SkyBlue997/tjd-daily、Candy-QAQ/NTE-Auto-Sign、Loping151/TGDSign 用的是同一套短信登录。
 * gui 只是等效兜底入口：它的短信/粘贴 tab 调的就是插件里同一对 sendSmsCode/loginBySms
 * 与 loginByPaste，与在应用内直接登录功能重复。
 *
 * 安全：
 * - 只监听 127.0.0.1 + 系统随机空闲端口（server.listen(0,...)），其他设备无法访问；
 * - 每次启动生成一次性随机 token，拼进访问地址 ?t=<token>；页面所有 /api/* 请求必须带
 * X-Auth-Token，否则 403（防本机其他网页/程序误调用）；
 * - 登录接口只回传账号摘要（手机号掩码/uid/source/hasRefreshToken），绝不回传凭据明文。
 *
 * 纯 Node 内置模块（零依赖、不 require Electron），可被主进程与 scripts/ 冒烟测试共用。
 * 用法：
 * const gui = require('./browser-login.js');
 * const server = gui.createGuiServer({ html, handlers, onShutdown });
 * server.on('closed', cb); // 服务关闭回调
 * const url = await server.open; // 启动并返回 http://127.0.0.1:<port>/?t=<token>
 * server.close; // 关闭（/api/shutdown 也会关闭）
 *
 * handlers（async，返回 {ok:true,...} 或 {ok:false,message}）：
 * status → { ok, gameName, methods:['sms','paste'], hasAccounts,
 * accounts:[{nickname,uid,source,loginAt,hasRefreshToken}], tip }
 * methods 决定页面显示哪些 tab（tab 的 data-tab 必须与此处字符串完全一致）
 * smsSend({phone}) → { ok, message }
 * smsLogin({phone,code}) → { ok, account, tip }
 * paste({token}) → { ok, account, tip }
 * （不提供密码登录：没有 password 处理器，也没有 /api/password 路由）
 */
const http = require('http');
const crypto = require('crypto');

function createGuiServer(opts) {
  opts = opts || {};
  const handlers = opts.handlers || {};
  const token = crypto.randomBytes(16).toString('hex');
  let server = null;
  let port = 0;
  let closed = false;
  const listeners = {};

  function on(ev, cb) {
    if (typeof cb !== 'function') return;
    (listeners[ev] = listeners[ev] || []).push(cb);
  }
  function emit(ev, payload) {
    (listeners[ev] || []).forEach((cb) => { try { cb(payload || {}); } catch (e) { /* 监听回调异常不阻断 */ } });
  }

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    if (res.headersSent) return; // 防御：响应已写出时不再重复写（避免 ERR_HTTP_HEADERS_SENT）
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }
  function readBody(req) {
    return new Promise((resolve) => {
      let d = '';
      req.on('data', (c) => { d += c; if (d.length > 64 * 1024) req.destroy(); });
      req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
      req.on('error', () => resolve({}));
    });
  }
  function authOk(req) { return req.headers['x-auth-token'] === token; }
  function okOrMessage(o) { return (o && o.ok) ? o : { ok: false, message: (o && (o.message || o.msg || o.error)) || '操作失败' }; }

  async function route(req, res, pathname) {
    try {
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(opts.html || '');
        return;
      }
      if (!pathname.startsWith('/api/')) { res.writeHead(404); res.end('Not Found'); return; }
      if (!authOk(req)) { sendJson(res, 403, { ok: false, message: '鉴权失败：请通过启动脚本打开的页面访问' }); return; }

      if (req.method === 'GET' && pathname === '/api/status' && typeof handlers.status === 'function') {
        const o = await handlers.status();
        sendJson(res, 200, okOrMessage(o));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/sms/send' && typeof handlers.smsSend === 'function') {
        const b = await readBody(req);
        sendJson(res, 200, okOrMessage(await handlers.smsSend(b)));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/sms/login' && typeof handlers.smsLogin === 'function') {
        const b = await readBody(req);
        sendJson(res, 200, okOrMessage(await handlers.smsLogin(b)));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/paste' && typeof handlers.paste === 'function') {
        const b = await readBody(req);
        sendJson(res, 200, okOrMessage(await handlers.paste(b)));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/shutdown') {
        sendJson(res, 200, { ok: true, message: '登录界面即将关闭，可以关闭浏览器页面了' });
        if (typeof opts.onShutdown === 'function') { try { opts.onShutdown(); } catch (e) { /* ignore */ } }
        api.close();
        return;
      }
      sendJson(res, 404, { ok: false, message: '接口不存在' });
    } catch (e) {
      sendJson(res, 500, { ok: false, message: '服务异常：' + (e && e.message || e) });
    }
  }

  const api = {
    get token() { return token; },
    get url() { return 'http://127.0.0.1:' + port + '/?t=' + token; },
    on,
    open() {
      return new Promise((resolve, reject) => {
        if (server) { resolve(api.url); return; }
        server = http.createServer((req, res) => {
          let pathname;
          try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch (e) { pathname = '/'; }
          route(req, res, pathname);
        });
        closed = false;
        server.on('error', (e) => { reject(e); });
        server.listen(0, '127.0.0.1', () => {
          port = server.address().port;
          emit('opened', { url: api.url });
          resolve(api.url);
        });
      });
    },
    close() {
      if (server) { try { server.close(); } catch (e) { /* ignore */ } server = null; }
      if (!closed) { closed = true; port = 0; emit('closed', {}); }
    },
  };
  return api;
}

module.exports = { createGuiServer };
