'use strict';
/**
 * 一键发版脚本——构建 → 组装免安装版 → 打包 7z → 重链系统引用 → 清理旧版 → 自检
 *
 * 用法（在 签到助手/ 下执行）：
 * node scripts/release.js # 全流程（默认只保留当前版本，清理更早的 免安装版-v* 目录与 7z）
 * node scripts/release.js --relink-only # 只重链系统引用到最新版 exe（目录已存在、无需重构建时）
 * node scripts/release.js --keep-old # 保留旧版本目录（不清理）
 * node scripts/release.js --no-7z # 跳过 7z 打包
 *
 * 为什么需要它：免安装版按「游戏社区签到助手-免安装版-vX.Y.Z」版本化目录交付，目录改名/换代后，
 * 系统里 4 处引用仍指向旧目录会失效（曾引发「开机自启失效」「计划任务到点启动失败」「点通知无反应」）：
 * ① HKCU Run 键 electron.app.游戏社区签到助手 （自愈：启动签到助手.bat / 应用启动）
 * ② 计划任务「签到助手-全局」 （自愈：应用打包启动时同步）
 * ③ 桌面 + 开始菜单「游戏社区签到助手.lnk」 （不自愈，必须重指）
 * ④ Electron 通知激活器 CLSID LocalServer32 （不自愈，必须重指）
 * 本脚本发版时一次性全部重链到新 exe，杜绝漏项；每次发版跑它即可。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { decodeProcOutput } = require('../core/proc-output.js');   // GBK 兼容解码

const REPO = path.resolve(__dirname, '..');          // 签到助手/
const ROOT = path.resolve(REPO, '..');               // 工作区根（放 免安装版 目录）
const APP_BASENAME = '游戏社区签到助手';             // exe/目录 基础名
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const VERSION = PKG.version;
const FOLDER = APP_BASENAME + '-免安装版-v' + VERSION; // 游戏社区签到助手-免安装版-vX.Y.Z
const OUT_DIR = path.join(ROOT, FOLDER);
const EXE = path.join(OUT_DIR, APP_BASENAME, APP_BASENAME + '.exe');
const SETTINGS_FILE = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '签到助手', 'settings.json');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'electron.app.' + APP_BASENAME;
const TASK_NAME = '签到助手-全局';
const CLSID_LS32 = 'HKCU\\Software\\Classes\\CLSID\\{EEB97C84-1080-4E69-9E20-4B7A9DCD5F64}\\LocalServer32';

const args = process.argv.slice(2);
const RELINK_ONLY = args.includes('--relink-only');
const KEEP_OLD = args.includes('--keep-old');
const NO_7Z = args.includes('--no-7z');

let problems = 0;
function ok(msg) { console.log('  ✅ ' + msg); }
function skip(msg) { console.log('  ⏭  ' + msg); }
function fail(msg) { problems++; console.log('  ❌ ' + msg); }
function run(cmd, argsArr, cwd) {
  // reg/schtasks 在 zh-CN Windows 输出 GBK 字节，按 utf8 解码中文全乱码，
  // 曾导致 CLSID 重链正则匹配不到被静默跳过、Run 键自检误报。改 buffer + GBK 兼容解码。
  const r = spawnSync(cmd, argsArr, { encoding: 'buffer', stdio: 'pipe', cwd: cwd || ROOT, timeout: 180000 });
  return { ok: !r.error && r.status === 0, status: r.status, out: decodeProcOutput(r.stdout), err: decodeProcOutput(r.stderr), error: r.error };
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) { return {}; }
}

/* ---------- ① 开机自启 Run 键 ---------- */
function relinkRunKey(settings) {
  console.log('[自启键] electron.app.' + APP_BASENAME);
  const auto = settings.autoStart !== false; // 默认开
  if (auto) {
    const r = run('reg', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', '"' + EXE + '" --hidden', '/f']);
    r.ok ? ok('autoStart=true → 已写入 ' + EXE) : fail('reg add 失败: ' + (r.err || r.error));
  } else {
    const r = run('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f']);
    r.ok || r.status === 1 ? ok('autoStart=false → 已删除自启键') : fail('reg delete 失败: ' + (r.err || r.error));
  }
}

/* ---------- ② 计划任务「签到助手-全局」 ---------- */
function relinkTask(settings) {
  console.log('[系统任务] ' + TASK_NAME);
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(settings.defaultTime || '')) ? settings.defaultTime : '';   // 严格 HH:mm（原 \d{1,2} 放行 25:90 之类非法值写进计划任务）
  if (settings.useSystemTask === true && time) {
    const r = run('schtasks', ['/Create', '/F', '/TN', TASK_NAME, '/TR', '"' + EXE + '" --hidden', '/SC', 'DAILY', '/ST', time]);
    r.ok ? ok('useSystemTask=true → 每日 ' + time + ' 指向 ' + EXE) : fail('schtasks 失败: ' + (r.err || r.error));
  } else if (settings.useSystemTask === true) {
    fail('useSystemTask=true 但 defaultTime 无效（' + settings.defaultTime + '），无法建任务');
  } else {
    const r = run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
    (r.ok || /not find|找不到|没有找到|0x00000051/i.test(r.err)) ? ok('useSystemTask=false → 无系统任务（已确保删除）') : fail('schtasks 删除失败: ' + (r.err || r.error));
  }
}

/* ---------- ③ 桌面 + 开始菜单快捷方式 ---------- */
function relinkShortcuts() {
  console.log('[快捷方式] 桌面 / 开始菜单 ' + APP_BASENAME + '.lnk');
  const ps1 = path.join(os.tmpdir(), 'relink-' + VERSION + '-' + Date.now() + '.ps1');
  const body = '# -*- coding: utf-8 -*-' + "\n" +
    "$ErrorActionPreference = 'Stop'" + "\n" +
    "Write-Output 'running'" + "\n" +
    "$target = '" + EXE + "'" + "\n" +   // 删除无效 replace（PS 单引号串无需转义反斜杠，原为死代码）
    '$sh = New-Object -ComObject WScript.Shell' + "\n" +
    "$desktops = @([Environment]::GetFolderPath('Desktop'))" + "\n" +
    "try { $desktops += [Environment]::GetFolderPath('CommonDesktopDirectory') } catch {}" + "\n" +
    "$appData = [Environment]::GetFolderPath('ApplicationData'); if (-not $appData) { $appData = $env:APPDATA }" + "\n" +
    "$menus = @()" + "\n" +
    "try { if ($appData) { $menus += (Join-Path $appData 'Microsoft\\Windows\\Start Menu\\Programs') } } catch {}" + "\n" +
    "try { if ($env:ProgramData) { $menus += (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs') } } catch {}" + "\n" +
    "$dirs = @($desktops + $menus | Where-Object { $_ -and (Test-Path $_) })" + "\n" +
    "foreach ($d in $dirs) {" + "\n" +
    "  $lnk = Join-Path $d '" + APP_BASENAME + ".lnk'" + "\n" +
    "  if (Test-Path $lnk) {" + "\n" +
    "    $l = $sh.CreateShortcut($lnk)" + "\n" +
    "    $cur = $l.TargetPath" + "\n" +
    "    $isOurs = ($cur -like '*游戏社区签到助手*') -or (-not (Test-Path $cur))" + "\n" +
    "    if ($cur -ne $target -and $isOurs) { $l.TargetPath = $target; $l.WorkingDirectory = (Split-Path $target); $l.IconLocation = ($target + ',0'); $l.Save(); Write-Output ('repointed: ' + $lnk) } else { Write-Output ('up-to-date: ' + $lnk) }" + "\n" +
    "  } else { try { $l = $sh.CreateShortcut($lnk); $l.TargetPath = $target; $l.WorkingDirectory = (Split-Path $target); $l.IconLocation = ($target + ',0'); $l.Save(); Write-Output ('created: ' + $lnk) } catch { Write-Output ('create-failed: ' + $lnk) } }" + "\n" +
    "}";
  fs.writeFileSync(ps1, '\uFEFF' + body, 'utf8');
  const r = run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1]);
  fs.rmSync(ps1, { force: true });
  if (r.ok) {
    const repointed = (r.out.match(/repointed:/g) || []).length;
    const created = (r.out.match(/created:/g) || []).length;
    (repointed + created) > 0 ? ok('重指 ' + repointed + ' 个 / 新建 ' + created + ' 个快捷方式（缺失即自动补建）') : skip('快捷方式均已指向最新版');
  } else {
    fail('改快捷方式失败: ' + (r.err || r.error || r.out).slice(0, 200));
  }
}

/* ---------- ④ Electron 通知激活器 CLSID ---------- */
function relinkClsid() {
  console.log('[通知激活器] Electron Notification Activator CLSID');
  const q = run('reg', ['query', CLSID_LS32, '/ve']);
  if (!q.ok) { skip('CLSID 不存在（无通知激活器注册）'); return; }
  const m = /(\S*游戏社区签到助手-免安装版-\S*\.exe)/.exec(q.out);
  if (!m) { skip('CLSID 当前不属于本应用（其他 Electron 应用在用），不动它'); return; }
  const cur = m[1].trim();
  if (path.resolve(cur) === path.resolve(EXE)) { ok('已指向当前 exe'); return; }
  const r = run('reg', ['add', CLSID_LS32, '/ve', '/t', 'REG_SZ', '/d', EXE, '/f']);
  r.ok ? ok('旧路径 ' + cur + ' → 已改指 ' + EXE) : fail('reg add CLSID 失败: ' + (r.err || r.error));
}

/* ---------- 自检输出 ---------- */
function verifyAll() {
  console.log('\n[自检]');
  if (!fs.existsSync(EXE)) { fail('缺少 exe：' + EXE); return; }
  const r = run('reg', ['query', RUN_KEY, '/v', RUN_NAME]);
  (r.ok && r.out.includes('--hidden') && r.out.includes('免安装版-v' + VERSION)) ? ok('Run 键 → v' + VERSION) : fail('Run 键未指向 v' + VERSION);
  const t = run('schtasks', ['/query', '/tn', TASK_NAME, '/fo', 'LIST', '/v']);
  (t.ok && t.out.includes('免安装版-v' + VERSION)) ? ok('计划任务 → v' + VERSION) : skip('计划任务不存在或非本应用（useSystemTask 关闭时正常）');
  if (NO_7Z) {
    ok('交付物：' + FOLDER);
  } else {
    fs.existsSync(path.join(ROOT, FOLDER + '.7z')) ? ok('交付物：' + FOLDER + ' + ' + FOLDER + '.7z（均已存在）') : fail('7z 缺失：' + FOLDER + '.7z');
  }
}

/* ---------- 构建/组装/打包 ---------- */
function buildAssemble() {
  console.log('===== 1/4 构建 win-unpacked（含图标/版本注入）=====');
  const b = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'rebuild-unpacked.js')], { cwd: REPO, stdio: 'inherit', timeout: 600000 });
  if (b.error || b.status !== 0) throw new Error('rebuild-unpacked 失败（' + (b.error ? b.error.message : 'status=' + b.status) + '）');

  console.log('\n===== 2/4 组装 ' + FOLDER + ' =====');
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_DIR, APP_BASENAME), { recursive: true });
  fs.cpSync(path.join(REPO, 'dist', 'win-unpacked'), path.join(OUT_DIR, APP_BASENAME), { recursive: true });
  // 脚本
  const scriptsSrc = path.join(ROOT, '脚本');
  if (fs.existsSync(scriptsSrc)) fs.cpSync(scriptsSrc, path.join(OUT_DIR, '脚本'), { recursive: true });
  else fail('缺工作区根 脚本/ 目录');
  // 文档（只认工作区根目录这一份；缺了直接报错，防静默漏装）
  const guideSrc = path.join(ROOT, '使用教程-小白版.md');
  const usageSrc = path.join(ROOT, '使用说明.txt');
  if (!fs.existsSync(guideSrc)) { fail('缺 ' + guideSrc); return; }
  if (!fs.existsSync(usageSrc)) { fail('缺 ' + usageSrc); return; }
  fs.copyFileSync(guideSrc, path.join(OUT_DIR, '使用教程-小白版.md'));
  fs.copyFileSync(usageSrc, path.join(OUT_DIR, '使用说明.txt'));
  console.log('  完成：' + OUT_DIR);

  if (!NO_7Z) {
    console.log('\n===== 3/4 打包 7z =====');
    // 7z 可执行文件取自两处：工作区根的 工具/7zr.exe（自带 7zr 时优先），否则用开发依赖 7zip-bin 里的 7za
    let z7 = path.join(ROOT, '工具', '7zr.exe');
    if (!fs.existsSync(z7)) {
      try { z7 = require('7zip-bin').path7za; } catch (e) { z7 = ''; }
    }
    if (!z7 || !fs.existsSync(z7)) { fail('找不到 7z 可执行文件：把 7zr.exe 放进工作区根「工具/」，或在 签到助手/ 下执行 npm install（用 7zip-bin 自带 7za），或加 --no-7z 跳过打包'); return; }
    ok('使用 7z：' + z7);
    const z = run(z7, ['a', '-t7z', '-mx=9', '-m0=BCJ', '-m1=LZMA2:25', FOLDER + '.7z', FOLDER], ROOT);
    // spawn 失败（如沙箱 EPERM/ENOENT）时 z.err 为空串（falsy）、z.error 是 Error 对象，
  // 原写法把 Error 对象当字符串调 .slice 直接 TypeError 崩溃，把真实失败原因吞掉
  z.ok ? ok(FOLDER + '.7z 已生成') : fail('7z 失败: ' + String(z.err || z.out || (z.error && z.error.message) || ('exit ' + z.status)).slice(0, 200));
  }
}

function cleanupOld() {
  if (KEEP_OLD) { skip('--keep-old，保留旧版'); return; }
  console.log('\n===== 4/4 清理旧版本目录 =====');
  const cur7z = FOLDER + '.7z'; // 当前版本的 7z 也要保留！
  for (const n of fs.readdirSync(ROOT)) {
    if (n === FOLDER || n === cur7z) continue; // 跳过当前版本目录与 7z
    if (/^游戏社区签到助手-免安装版-v/.test(n)) {
      const p = path.join(ROOT, n);
      try { fs.rmSync(p, { recursive: true, force: true }); console.log('  已删 ' + n); } catch (e) { fail('删 ' + n + ' 失败: ' + e.message); }
    }
  }
}

/* ---------- 主流程 ---------- */
(async () => {
  console.log('一键发版 v' + VERSION + '（' + FOLDER + '）');
  if (!RELINK_ONLY) {
    if (fs.existsSync(EXE)) { skip('发现同版本目录已存在，仍会重新构建覆盖'); }
    try {
      buildAssemble();
    } catch (e) {
      console.error('❌ 构建失败：' + e.message);
      process.exit(1);
    }
  } else {
    console.log('--relink-only：跳过构建/组装/打包');
    if (!fs.existsSync(EXE)) { console.error('❌ 找不到 ' + EXE + '，请先正常发版'); process.exit(1); }
  }
  const settings = loadSettings();
  console.log('\n===== 重链系统引用到 ' + EXE + ' =====');
  relinkRunKey(settings);
  relinkTask(settings);
  relinkShortcuts();
  relinkClsid();
  if (!RELINK_ONLY) cleanupOld();
  verifyAll();
  if (problems) { console.error('\n❌ 存在问题 ' + problems + ' 处，请检查上面输出'); process.exit(1); }
  console.log('\n✅ 发版完成：' + FOLDER + (NO_7Z ? '' : ' + ' + FOLDER + '.7z') + '，全部系统引用已指向 v' + VERSION);
})().catch(e => { console.error('发版失败：' + (e && e.message || e)); process.exit(1); });
