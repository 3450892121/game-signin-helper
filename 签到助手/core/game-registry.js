'use strict';
/**
 * 游戏注册表（core/game-registry.js）—— t4 交付
 *
 * 职责（契约定稿 t2 §4 与本任务 t4）：
 * - 用户插件目录发现：主进程注入的 userDir（绿色版随包「脚本」/自测临时目录/安装版兜底数据目录），扫描其下 <目录>/index.js；框架不内置脚本，插件由用户安装
 * - validatePlugin 逐字段校验（id/name/community/loginMethods/signin 必备；
 * kind/hint/describeCredential/onRemove/meta/defaultEnabled 按契约规约补齐）
 * - 单插件加载失败隔离：坏插件只记入 loadErrors，不拖垮其它游戏与框架
 * - removePlugin：内置拒绝删除；用户插件移除前先调用插件 onRemove 数据清理钩子，
 * 再删除插件目录；返回 gameId 供主进程按插件契约清理账号/设置/会话/系统任务
 * - 兼容现有 runner/scheduler：签到仍由 settings.games 驱动，注册表只负责
 * 「发现/校验/元数据」，不引入新的第三方依赖（纯 Node 内置模块）
 */

const fs = require('fs');
const path = require('path');

const KINDS = ['sms', 'web', 'paste', 'gui'];   // 插件 kind 词汇表（gui=浏览器登录，实现见 core/browser-login.js + core/login-gui.html）
// 框架只支持上面这四种 kind。新增一种需同时改：本文件 KINDS/guessKind/validatePlugin/转发白名单、main.js 的 LOGIN_KIND 与 IPC、
// renderer/app.js 的 KIND_LABEL/methodKind/面板模板，以及 docs/脚本开发规范.md。
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** 绕过 require 缓存读取模块：插件文件改动/重新导入后 reload 能立即拿到新代码 */
function freshRequire(file) {
  try { delete require.cache[require.resolve(file)]; } catch (e) { console.error('[game-registry] 清理模块缓存失败：' + file + ' — ' + ((e && e.message) || e)); }
  return require(file);
}
/** 供外部（主进程预检插件 id 等）在自行 require 前清缓存 */
function clearModuleCache(file) {
  try { delete require.cache[require.resolve(file)]; } catch (e) { /* ignore */ }
}

/** 按 needs 推断 kind（兼容尚未显式声明 kind 的插件元数据） */
function guessKind(needs) {
  needs = needs || [];
  if (needs.indexOf('web') >= 0) return 'web';
  if (needs.indexOf('gui') >= 0) return 'gui';
  if (needs.indexOf('code') >= 0) return 'sms';
  return 'paste';
}

/** 校验插件导出；返回 { ok, plugin?, errors[] }（任一规则不满足即拒绝并给明确错误） */
function validatePlugin(mod, hint) {
  hint = hint || {};
  const errors = [];
  if (!mod || typeof mod !== 'object') {
    errors.push('插件导出不是对象（require 失败或未 module.exports）');
    return { ok: false, errors };
  }
  if (typeof mod.id !== 'string') errors.push('缺少必需导出 id（String）');
  else if (!ID_RE.test(mod.id)) errors.push('id 非法：须小写/数字开头、仅 a-z0-9_-、长度 1-32：' + mod.id);
  // 注：目录名无需等于 id（目录名可为中文显示名，如「鸣潮」；id 仅作内部唯一标识）
  if (typeof mod.name !== 'string' || !mod.name.trim()) errors.push('缺少必需导出 name（非空 String）');
  else if (mod.name.length > 24) errors.push('name 过长（≤24 字符）');
  if (mod.community !== undefined && (typeof mod.community !== 'string' || !mod.community.trim())) errors.push('community 必须为非空 String（可省略）');
  if (mod.icon !== undefined && (typeof mod.icon !== 'string' || !mod.icon || mod.icon.length > 4)) errors.push('icon 必须为 1-4 字符展示文本（可省略）');
  if (!Array.isArray(mod.loginMethods) || mod.loginMethods.length === 0) {
    errors.push('缺少必需导出 loginMethods（非空数组）');
  } else {
    const seen = {};
    mod.loginMethods.forEach((m, i) => {
      const at = 'loginMethods[' + i + ']';
      if (!m || typeof m !== 'object') { errors.push(at + ' 不是对象'); return; }
      if (!m.id || typeof m.id !== 'string') errors.push(at + ' 缺少 id');
      if (m.label !== undefined && (typeof m.label !== 'string' || !m.label.trim())) errors.push(at + ' label 必须为非空 String');
      const kind = m.kind || (Array.isArray(m.needs) ? guessKind(m.needs) : '');
      if (!kind) errors.push(at + ' 无法解析 kind（缺 kind 字段且 needs 不识别）');
      else if (KINDS.indexOf(kind) < 0) errors.push(at + ' kind 非法：' + kind + '；词汇表=' + KINDS.join('/') + '（新 kind 需同时登记进 core/game-registry.js 的 KINDS、main.js 的 LOGIN_KIND、renderer/app.js 的 KIND_LABEL）');
      if (seen[m.id]) errors.push(at + ' id 重复：' + m.id);
      seen[m.id] = true;
      if (kind === 'sms' && typeof m.sendSms !== 'function' && typeof mod.sendSmsCode !== 'function') errors.push(at + ' sms 需 sendSms 回调或模块级 sendSmsCode');
      if (kind === 'sms' && typeof m.smsLogin !== 'function' && typeof mod.loginBySms !== 'function') errors.push(at + ' sms 需 smsLogin 回调或模块级 loginBySms');
      if (kind === 'paste' && typeof m.paste !== 'function' && typeof mod.loginByPaste !== 'function' && typeof mod.loginByCookie !== 'function') errors.push(at + ' paste 需 paste/loginByPaste/loginByCookie');
      if (kind === 'gui' && !m.guiOpen && typeof mod.startGuiLogin !== 'function' && !(mod.loginBySms || mod.loginByPaste || mod.loginByCookie || m.smsLogin || m.paste)) errors.push(at + ' gui 需主进程浏览器登录支持（模块需提供 loginBySms/loginByPaste/loginByCookie 之一；内置由 main.js + core/browser-login.js 承载）');
      if (kind === 'web' && (!m.webMeta || !m.webMeta.loginUrl)) errors.push(at + ' web 需 webMeta.loginUrl');
    });
  }
  if (typeof mod.signin !== 'function') errors.push('缺少必需导出 signin（Function）');
  return errors.length ? { ok: false, errors } : { ok: true, plugin: mod };
}

/** 归一化插件元数据（补默认值 + kind 标注），不拷贝函数实现引用 */
function normalize(mod) {
  const p = {
    id: mod.id,
    name: mod.name || '',
    community: mod.community || mod.name || '',
    icon: mod.icon || '🎮',
    meta: mod.meta || {},
    defaultEnabled: mod.defaultEnabled === true,
    defaultTime: typeof mod.defaultTime === 'string' ? mod.defaultTime : '',
    loginMethods: (mod.loginMethods || []).map(m => {
      const copy = Object.assign({}, m);
      copy.kind = m.kind || guessKind(m.needs);
      return copy;
    }),
  };
  // 函数引用仅注册表内部使用（main/runner 通过 get 获取），不外发到渲染层
  // 指纹函数（genFingerprint/reuseFingerprint）也须随注册表外发，
  // 否则 makeLoginCtx 在「无既有指纹的首个账号」时 fp=null → tajiduo loginByPaste 读 fp.deviceid 崩溃
  // startGuiLogin 同理：validatePlugin 承认它可满足 kind:'gui'，若不在这里转发，插件校验能过、运行时却拿不到
  for (const fnKey of ['signin', 'describeCredential', 'onRemove', 'sendSmsCode', 'loginBySms', 'loginByPaste', 'loginByCookie', 'startGuiLogin', 'genFingerprint', 'reuseFingerprint']) {
    if (typeof mod[fnKey] === 'function') p[fnKey] = mod[fnKey];
  }
  return p;
}

function rmSafe(target) {
  if (!target) return false;
  try {
    if (fs.existsSync(target)) { fs.rmSync(target, { recursive: true, force: true }); }
    return true;
  } catch (e) { return false; }
}

/**
 * 创建注册表实例。
 * @param {object} opts { dataDir?, userDir?, log? }
 * dataDir：用户数据目录（缺省时 userDir 需显式给出；不使用则无用户插件发现）

 */
function create(opts) {
  opts = opts || {};
  const userDir = opts.userDir || (opts.dataDir ? path.join(opts.dataDir, 'plugins') : null);
  const log = opts.log || function () {};
  const registry = new Map();   // id -> 归一化插件对象
  let loadErrors = [];
  // 「上次存在、本次消失」检测——用户直接删除插件目录后，下次 loadAll 据上一轮记录的
  // 用户插件目录名集合识别消失项，供主进程按清理链删除孤儿账号/设置/会话/系统任务。
  // 基线是「目录名集合 + 目录名→插件id 映射」——契约允许目录名≠id（见 validatePlugin 注），
  // 孤儿清理必须按真实插件 id 执行，否则删插件目录后账号/设置清不掉却报"已清理"
  const prevState0 = readUserDirState();
  let prevUserDirs = new Set(prevState0.dirs);
  let prevDirToId = prevState0.dirToId;
  let disappearedDirs = [];                          // 本次 loadAll 检测到的消失项 [{ dir, id|null }]（getDisappeared 消费）

  /** 读取上次会话记录的基线（dataDir/.registry-user-dirs.json；无则空）。
 * 兼容两种格式：旧版=目录名数组（无 id 映射，迁移期 id=null）；={ dirs:[], dirToId:{} }。 */
  function readUserDirState() {
    if (!opts.dataDir) return { dirs: [], dirToId: {} };
    try {
      const f = path.join(opts.dataDir, '.registry-user-dirs.json');
      if (!fs.existsSync(f)) return { dirs: [], dirToId: {} };
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(raw)) return { dirs: raw, dirToId: {} };
      if (raw && typeof raw === 'object' && Array.isArray(raw.dirs)) {
        return { dirs: raw.dirs, dirToId: (raw.dirToId && typeof raw.dirToId === 'object') ? raw.dirToId : {} };
      }
      return { dirs: [], dirToId: {} };
    } catch (e) { return { dirs: [], dirToId: {} }; }
  }
  /** 持久化当前基线：目录名集合 + 目录名→插件id 映射（供下次启动的「上次存在」检测与孤儿清理） */
  function saveUserDirState(dirs, dirToId) {
    if (!opts.dataDir) return;
    try {
      fs.mkdirSync(opts.dataDir, { recursive: true });
      fs.writeFileSync(path.join(opts.dataDir, '.registry-user-dirs.json'),
        JSON.stringify({ dirs: Array.from(dirs), dirToId: dirToId || {} }), 'utf8');
    } catch (e) { log('game-registry: ⚠️ 基线状态文件写失败（不阻断扫描）：' + ((e && e.message) || e)); }
  }

  function safeList() {
    return Array.from(registry.values()).map(p => ({
      id: p.id, name: p.name, community: p.community, icon: p.icon,
      meta: p.meta, defaultEnabled: p.defaultEnabled, defaultTime: p.defaultTime || '',
      source: p.source || 'user', idHint: p.idHint || p.id,
      loginMethods: p.loginMethods,
    }));
  }

  /** 全量扫描合并（内置优先、冲突拒绝、单插件失败隔离） */
  function loadAll() {
    const next = new Map();
    const errs = [];
    // 用户 plugins/<id>/index.js（框架不内置任何游戏脚本，全部插件由用户安装）
    let userDirNames = [];
    let userDirScanFailed = false;
    const curDirToId = {};   // 本次扫描：目录名→插件id（成功加载才记录）
    if (userDir) {
      let dirs = [];
      try {
        if (fs.existsSync(userDir)) {
          dirs = fs.readdirSync(userDir).filter(d => {
            try { return fs.statSync(path.join(userDir, d)).isDirectory(); } catch (e) { return false; }
          });
        }
        userDirNames = dirs;
      } catch (e) {
        // 扫描异常时沿用上次已加载的用户插件，且本轮不做消失检测——
        // 目录可能只是临时不可读，清空注册表会让 storage 把 games 剪空并随任意保存落盘
        userDirScanFailed = true;
        errs.push({ dir: userDir, errors: ['扫描用户插件目录失败：' + e.message] });
        log('game-registry: ⚠️ 用户插件目录扫描失败，沿用上次已加载插件：' + e.message);
        for (const [id, p] of registry) { if ((p.source || 'user') === 'user') next.set(id, p); }
      }
      for (const d of (userDirScanFailed ? [] : dirs)) {
        const entry = path.join(userDir, d, 'index.js');
        if (!fs.existsSync(entry)) continue;
        try {
          const mod = freshRequire(entry);
          const v = validatePlugin(mod, { idHint: d, source: 'user' });
          if (!v.ok) { errs.push({ dir: path.join(userDir, d), idHint: d, file: entry, errors: v.errors }); continue; }
          if (next.has(mod.id)) {
            errs.push({ dir: path.join(userDir, d), idHint: d, file: entry, errors: ['冲突：id=' + mod.id + ' 已被内置/先前插件占用（内置优先），已拒绝'] });
            continue;
          }
          const p = normalize(mod);
          p.source = 'user'; p.file = entry; p.idHint = d;
          next.set(p.id, p);
          curDirToId[d] = p.id;
          log('game-registry: 用户插件 ' + p.id + '（' + entry + '）已加载');
        } catch (e) {
          errs.push({ dir: path.join(userDir, d), idHint: d, file: entry, errors: ['加载异常：' + ((e && e.message) || String(e))] });
          log('game-registry: ❌ 用户插件 ' + d + ' 加载失败：' + ((e && e.message) || String(e)));
        }
      }
    }
    registry.clear();
    for (const [id, p] of next) registry.set(id, p);
    loadErrors = errs;
    // 插件契约：检测「上次存在、本次消失」的用户插件目录（仅用户目录；校验失败但目录仍在的不算消失）
    // 扫描失败时目录状态未知——不更新基线、不做消失检测（防误报全部消失）
    if (userDirScanFailed) {
      disappearedDirs = [];
    } else {
      const curUserDirs = new Set(userDirNames);
      disappearedDirs = Array.from(prevUserDirs)
        .filter(d => !curUserDirs.has(d))
        .map(d => ({ dir: d, id: prevDirToId[d] || null }));   // Z1：带映射 id；旧格式基线无映射时 id=null
      prevUserDirs = curUserDirs;
      const mergedDirToId = {};
      for (const d of curUserDirs) {
        if (curDirToId[d]) mergedDirToId[d] = curDirToId[d];
        else if (prevDirToId[d]) mergedDirToId[d] = prevDirToId[d];   // 目录仍在但本轮校验失败：保留历史映射
      }
      prevDirToId = mergedDirToId;
      saveUserDirState(prevUserDirs, prevDirToId);
    }
    return { ok: true, games: safeList(), errors: loadErrors };
  }

  /** 注册单个用户插件目录（「添加游戏」运行时入口）；dir = 插件目录（含 index.js） */
  function addPlugin(dir) {
    const entry = path.join(dir, 'index.js');
    if (!fs.existsSync(entry)) return { ok: false, errors: ['目录下未找到 index.js：' + dir] };
    let mod;
    try { mod = freshRequire(entry); } catch (e) { return { ok: false, errors: ['加载异常：' + ((e && e.message) || String(e))] }; }
    const v = validatePlugin(mod, { idHint: path.basename(dir), source: 'user' });
    if (!v.ok) return { ok: false, errors: v.errors };
    if (registry.has(mod.id)) {
      return { ok: false, errors: ['冲突：id=' + mod.id + ' 已存在（来源=' + registry.get(mod.id).source + '），不覆盖'] };
    }
    const p = normalize(mod);
    p.source = 'user'; p.file = entry; p.idHint = path.basename(dir);
    registry.set(p.id, p);
    loadErrors = loadErrors.filter(e => !(e.idHint === p.id));
    return { ok: true, plugin: safeList().find(x => x.id === p.id) };
  }

  /**
 * 移除插件（仅用户插件；内置拒绝）。
 * 流程（插件契约）：先调插件 onRemove({ gameId }) 数据清理钩子 → 删除插件目录 → 从注册表移除。
 * 账号/设置/会话/系统任务的清理由主进程按返回值 gameId 继续执行（storage+runner+scheduler）。
 */
  async function removePlugin(id, opts) {
    opts = opts || {};
    const p = registry.get(id);
    if (!p) return { removed: false, reason: '未安装或未加载：' + id };
    if (p.source !== 'user') return { removed: false, reason: '内置游戏不能通过界面删除（请使用安装包更新/移除）' };
    let hook = 'none';
    if (typeof p.onRemove === 'function') {
      try { await p.onRemove({ gameId: id }); hook = 'ok'; }
      catch (e) { hook = 'error:' + ((e && e.message) || String(e)); }
    }
    let dirRemoved = false;
    if (opts.deleteDir !== false && p.file) {
      dirRemoved = rmSafe(path.dirname(p.file));
    }
    registry.delete(id);
    try { if (p.file) delete require.cache[require.resolve(p.file)]; } catch (e) { /* 目录已删时清理模块缓存 */ }
    // 该插件目录已删除时同步清理其历史 loadErrors
    loadErrors = loadErrors.filter(e => !(e.idHint === id || (p.file && e.file === p.file)));
    log('game-registry: 用户插件 ' + id + ' 已移除（onRemove=' + hook + '，删目录=' + dirRemoved + '）');
    return {
      removed: true, gameId: id, source: 'user', hook,
      dirRemoved,
      note: '账号/设置/会话/系统任务仍由主进程按插件契约清理（本模块不触碰 storage/accounts/settings）',
    };
  }

  return {
    userDir,
    loadAll, addPlugin, removePlugin,
    /** 消费本次 loadAll 检测到的消失用户插件项 [{ dir, id|null }]（id=目录名→插件id 映射结果；消费后清空，避免重复清理） */
    getDisappeared: () => { const out = disappearedDirs; disappearedDirs = []; return out; },
    list: safeList,
    get: (id) => registry.get(id) || null,
    has: (id) => registry.has(id),
    ids: () => Array.from(registry.keys()),
    getLoadErrors: () => loadErrors,
    getLoginMethod(id, kind) {
      const p = registry.get(id);
      if (!p) return null;
      return p.loginMethods.find(m => m.kind === kind) || null;
    },
    describeCredential(id, cred) {
      const p = registry.get(id);
      if (p && typeof p.describeCredential === 'function') return p.describeCredential(cred || {});
      return { nickname: '', warning: '', cookieValid: null };
    },
    validatePlugin,
  };
}

module.exports = { create, validatePlugin, guessKind, KINDS, freshRequire, clearModuleCache };
