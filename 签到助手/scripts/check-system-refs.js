'use strict';
// 系统引用体检（只读）：核对 4 处系统引用是否仍指向「现存最新」交付版本 exe。
//
// 背景（历史反复教训）：手工删除/改名交付目录后，系统引用仍指向已删路径，
// 造成「升级后开机自启失效 / 计划任务指向已删目录 / 快捷方式打不开 / Electron 通知不弹」。
// 本脚本专项体检，删旧版本目录前后、发版后、或任何怀疑引用失效时运行：npm run test:refs
//
// 覆盖 4 处引用：
// 1) HKCU Run 自启键 electron.app.游戏社区签到助手（开机自启）
// 2) 计划任务「签到助手-全局」（直读 Tasks 存储 XML；schtasks 在受限环境不可用且查询会整体报错）
// 3) 桌面 + 开始菜单快捷方式（.lnk 目标，GBK/UTF-16 双通道解析）
// 4) 通知激活器 CLSID {EEB97C84-1080-4E69-9E20-4B7A9DCD5F64} LocalServer32
//
// 判定：引用存在但指向旧版本/不存在路径 = FAIL（退出码 1）；
// 引用未配置（用户未开启自启等）或受限环境读不到 = WARN（不失败）。
// 修复：发现 FAIL 后跑 npm run release:relink 重链 4 处系统引用（勿手工改注册表/lnk）。

var fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
var decodeProcOutput = require('../core/proc-output.js').decodeProcOutput;

var WSROOT = path.resolve(__dirname, '..', '..');
var RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
var RUN_NAME = 'electron.app.游戏社区签到助手';
var TASK_XML = 'C:\\Windows\\System32\\Tasks\\签到助手-全局';
var CLSID_KEY = 'HKCU\\Software\\Classes\\CLSID\\{EEB97C84-1080-4E69-9E20-4B7A9DCD5F64}\\LocalServer32';
var VER_RE = /^游戏社区签到助手-免安装版-v(\d+)\.(\d+)\.(\d+)$/;
var VER_ANY = /游戏社区签到助手-免安装版-v\d+\.\d+\.\d+/g;

var fail = 0, warn = 0;
function rep(name, state, detail) {
  var tag = state === 'OK' ? '[OK]  ' : state === 'FAIL' ? '[FAIL]' : '[WARN]';
  console.log(tag + ' ' + name + (detail ? '  —— ' + detail : ''));
  if (state === 'FAIL') fail++;
  if (state === 'WARN') warn++;
}

// ---------- 定位最新交付版本与期望 exe ----------
var dirs = [];
try { dirs = fs.readdirSync(WSROOT).filter(function (n) { return VER_RE.test(n); }); } catch (e) { /* 工作区不可读 */ }
dirs.sort(function (a, b) {
  var ma = VER_RE.exec(a), mb = VER_RE.exec(b);
  for (var i = 1; i < 4; i++) { if (+ma[i] !== +mb[i]) return +ma[i] - +mb[i]; }
  return 0;
});
if (!dirs.length) {
  console.log('未找到交付版本目录（游戏社区签到助手-免安装版-vX.Y.Z），无可体检的系统引用，跳过。');
  process.exit(0);
}
var latest = dirs[dirs.length - 1];
var exePath = path.join(WSROOT, latest, '游戏社区签到助手', '游戏社区签到助手.exe');
console.log('体检基准: ' + latest);
console.log('期望 exe: ' + exePath);
console.log('');

rep('最新版 exe 存在', fs.existsSync(exePath) ? 'OK' : 'FAIL', exePath);

// ---------- 注册表读取（GBK 解码；失败返回 {absent:true} 或 {unreadable:reason}） ----------
function regQuery(key, valueName) {
  var args = ['query', key];
  if (valueName === null) args.push('/ve'); else args = args.concat(['/v', valueName]);
  var r = cp.spawnSync('reg', args, { stdio: 'pipe' });
  if (r.error && r.status === null) {
    // 受限环境（如 DSH 沙箱）禁止管道捕获：降级不可行（需要 stdout），如实上报不可读
    return { unreadable: r.error.code || 'SPAWN_FAIL' };
  }
  if (r.status !== 0) return { absent: true }; // reg 找不到键/值时退出码非 0
  return { text: decodeProcOutput(r.stdout) };
}
function refVerInText(text) {
  var m = text.match(VER_ANY);
  return m ? m[0] : null; // 文本中出现的版本目录名（取第一个）
}

// ---------- 1) HKCU Run 自启键 ----------
(function checkRunKey() {
  var r = regQuery(RUN_KEY, RUN_NAME);
  if (r.unreadable) return rep('①Run 自启键', 'WARN', '受限环境无法读取注册表（' + r.unreadable + '），请在真实终端复核');
  if (r.absent) return rep('①Run 自启键', 'WARN', '未配置（可能用户关闭了开机自启，非引用失效）');
  var val = r.text.split('\n').filter(function (l) { return l.indexOf('REG_SZ') >= 0; }).join(' ');
  if (val.indexOf(exePath) >= 0) {
    var hidden = val.indexOf('--hidden') >= 0;
    return rep('①Run 自启键', 'OK', '指向最新版' + (hidden ? '（--hidden）' : '（缺 --hidden，将弹出窗口而非静默启动）'));
  }
  var stale = refVerInText(val);
  if (stale && stale !== latest) return rep('①Run 自启键', 'FAIL', '指向旧版本「' + stale + '」，开机自启会失效');
  return rep('①Run 自启键', 'FAIL', '未指向期望 exe，实际值: ' + val.trim().slice(0, 160));
})();

// ---------- 2) 计划任务「签到助手-全局」（直读 Tasks 存储 XML） ----------
(function checkTask() {
  var buf;
  try { buf = fs.readFileSync(TASK_XML); } catch (e) {
    return rep('②计划任务', 'WARN', '任务未创建或无读取权限（' + e.code + '），无法核对');
  }
  var xml;
  if (buf[0] === 0xFF && buf[1] === 0xFE) xml = buf.toString('utf16le');
  else xml = buf.toString('utf8');
  var m = xml.match(/<Command>([\s\S]*?)<\/Command>/);
  if (!m) return rep('②计划任务', 'WARN', 'XML 中未找到 Command 节点，无法核对');
  var cmd = m[1].replace(/"/g, '').trim();
  if (cmd.indexOf(exePath) >= 0) return rep('②计划任务', 'OK', '指向最新版 exe');
  var stale = refVerInText(cmd);
  if (stale && stale !== latest) return rep('②计划任务', 'FAIL', '指向旧版本「' + stale + '」（已删目录则触发即报错）');
  return rep('②计划任务', 'WARN', '指向非版本化路径: ' + cmd.slice(0, 160) + '，请人工确认');
})();

// ---------- 3) 桌面 + 开始菜单快捷方式 ----------
function lnkMentionsExe(buf) {
  // .lnk 目标路径可能以 ANSI(GBK LocalBasePath) 或 UTF-16 存储，双通道搜索
  var utf16 = buf.toString('utf16le');
  if (utf16.indexOf(exePath) >= 0) return 'ok';
  try { if (new TextDecoder('gbk').decode(buf).indexOf(exePath) >= 0) return 'ok'; } catch (e) { /* 无 gbk 解码器 */ }
  var all16 = utf16.match(VER_ANY) || [];
  var all8 = buf.toString('latin1').match(VER_ANY) || [];
  var vers = all16.concat(all8).filter(function (v) { return v !== latest; });
  if (vers.length) return 'stale:' + vers[0];
  return 'unknown';
}
function checkLnk(label, lnkPath) {
  var buf;
  try { buf = fs.readFileSync(lnkPath); } catch (e) {
    return rep(label, 'WARN', '快捷方式不存在或不可读（' + e.code + '）: ' + lnkPath);
  }
  var st = lnkMentionsExe(buf);
  if (st === 'ok') return rep(label, 'OK', '指向最新版 exe');
  if (st.indexOf('stale:') === 0) return rep(label, 'FAIL', '指向旧版本「' + st.slice(6) + '」，点击将打不开应用');
  return rep(label, 'WARN', '无法从 lnk 解析出目标路径，请人工确认: ' + lnkPath);
}
// 桌面目录：候选链 = Shell Folders（已展开、反映重定向）→ User Shell Folders
// （需展开 %USERPROFILE%，注册表不可读的沙箱环境两个都拿不到）→ home\Desktop → OneDrive\Desktop。
// 修复：原实现注册表读取失败时直接退 home\Desktop，桌面重定向机器（如 D:\桌面）在此环境
// 被误报 ENOENT WARN；仅当全部候选都不存在才落到最后一个候选并 WARN。
function expandEnvVars(s) {
  return String(s || '').replace(/%([^%]+)%/g, function (m, name) { return process.env[name] || m; });
}
var desktopCandidates = [];
var sf = regQuery('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders', 'Desktop');
if (sf && sf.text) {
  var lm = sf.text.match(/REG_SZ\s+(.+?)\r?\n/);
  if (lm) desktopCandidates.push(lm[1].trim());
}
var usf = regQuery('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', 'Desktop');
if (usf && usf.text) {
  var um = usf.text.match(/REG_SZ\s+(.+?)\r?\n/);
  if (um) desktopCandidates.push(expandEnvVars(um[1].trim()));
}
desktopCandidates.push(path.join(os.homedir(), 'Desktop'));
desktopCandidates.push(path.join(process.env.USERPROFILE || os.homedir(), 'OneDrive', 'Desktop'));
var desktopDir = null;
for (var di = 0; di < desktopCandidates.length; di++) {
  if (desktopCandidates[di] && fs.existsSync(desktopCandidates[di])) { desktopDir = desktopCandidates[di]; break; }
}
if (!desktopDir) desktopDir = desktopCandidates[0];
checkLnk('③桌面快捷方式', path.join(desktopDir, '游戏社区签到助手.lnk'));
checkLnk('③开始菜单快捷方式', path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', '游戏社区签到助手.lnk'));

// ---------- 4) 通知激活器 CLSID ----------
(function checkClsid() {
  var r = regQuery(CLSID_KEY, null);
  if (r.unreadable) return rep('④通知CLSID', 'WARN', '受限环境无法读取注册表（' + r.unreadable + '），请在真实终端复核');
  if (r.absent) return rep('④通知CLSID', 'WARN', '未配置（Electron 通知激活器缺失，Windows 通知可能不弹）');
  if (r.text.indexOf(exePath) >= 0) return rep('④通知CLSID', 'OK', '指向最新版 exe');
  var stale = refVerInText(r.text);
  if (stale && stale !== latest) return rep('④通知CLSID', 'FAIL', '指向旧版本「' + stale + '」，通知激活将失败');
  return rep('④通知CLSID', 'FAIL', '未指向期望 exe，实际值: ' + r.text.trim().slice(0, 160));
})();

// ---------- 汇总 ----------
console.log('');
if (fail > 0) {
  console.log('RESULT: FAIL（' + fail + ' 处引用失效）—— 跑 npm run release:relink 重链 4 处系统引用后复检');
  console.log('        （若仅改了路径/引用而无需重建产物，禁止手工拷贝 exe/目录，必须走 release:relink）');
  process.exit(1);
}
console.log('RESULT: PASS' + (warn > 0 ? '（' + warn + ' 项 WARN，均为未配置或受限环境无法读取，非引用失效）' : '（4 处系统引用全部指向 ' + latest + '）'));
process.exit(0);
