'use strict';
/**
 * 重建 dist/win-unpacked（绕过 electron-builder 的 spawn EPERM）
 *
 * 步骤：
 * 1. BFS 收集 package.json dependencies 的生产依赖（qrcode 及其递归依赖）
 * 2. 组装临时 app 目录：源码(main/preload/renderer/core/package.json) + node_modules
 * 3. 用 @electron/asar 进程内打包成 resources/app.asar（不 spawn，绕开沙箱限制）
 * 4. 复制 node_modules/electron/dist 到 win-unpacked，并把 electron.exe 改名为 游戏社区签到助手.exe
 *
 * 用法：node scripts/rebuild-unpacked.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const OUT = process.env.OUT_DIR
  ? path.resolve(BASE, process.env.OUT_DIR)
  : path.join(BASE, 'dist', 'win-unpacked');
const ELECTRON_DIST = path.join(BASE, 'node_modules', 'electron', 'dist');
const APP_NAME = '游戏社区签到助手.exe';
const APP_LABEL = '游戏社区签到助手';

function collectProdDeps() {
  const appPkg = JSON.parse(fs.readFileSync(path.join(BASE, 'package.json'), 'utf8'));
  const seen = new Set();
  const queue = Object.keys(appPkg.dependencies || {});
  const deps = [];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const p = path.join(BASE, 'node_modules', name);
    if (!fs.existsSync(p)) { console.warn('[warn] 缺依赖目录 ' + name); continue; }
    deps.push({ name, path: p });
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')); } catch (e) { continue; }
    const all = Object.assign({}, pkg.dependencies || {}, pkg.optionalDependencies || {});
    for (const d of Object.keys(all)) queue.push(d);
  }
  return deps;
}

function buildAppDir(deps) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-app-'));
  const appDir = path.join(tmp, 'app');
  const copy = (src, destRel) => {
    const dest = path.join(appDir, destRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  };
  copy(path.join(BASE, 'main.js'), 'main.js');
  copy(path.join(BASE, 'preload.js'), 'preload.js');
  copy(path.join(BASE, 'package.json'), 'package.json');
  copy(path.join(BASE, 'renderer'), 'renderer');
  copy(path.join(BASE, 'core'), 'core');
  const buildInfo = {
    version: JSON.parse(fs.readFileSync(path.join(BASE, 'package.json'), 'utf8')).version,
    buildTime: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(appDir, 'core', 'build-info.json'), JSON.stringify(buildInfo), 'utf8');
  for (const d of deps) copy(d.path, path.join('node_modules', d.name));
  return appDir;
}

function packAsar(appDir) {
  const asar = require('@electron/asar');
  const resources = path.join(OUT, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  const dest = path.join(resources, 'app.asar');
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  return asar.createPackage(appDir, dest);
}

function copyElectron() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.cpSync(ELECTRON_DIST, OUT, { recursive: true });
  const exeSrc = path.join(OUT, 'electron.exe');
  const exeDst = path.join(OUT, APP_NAME);
  if (!fs.existsSync(exeSrc)) throw new Error('未找到 electron.exe：' + exeSrc);
  if (fs.existsSync(exeDst)) fs.unlinkSync(exeDst);
  fs.copyFileSync(exeSrc, exeDst);
  // 已经复制出 APP_NAME，删除多余的 electron.exe（避免包里重复 244MB）
  if (fs.existsSync(exeSrc)) fs.unlinkSync(exeSrc);
  // 清理运行时残留 debug.log（Electron 调试产物，不进正式包）
  const dbg = path.join(OUT, 'debug.log');
  if (fs.existsSync(dbg)) fs.unlinkSync(dbg);
  // 删除 default_app.asar，避免 electron 回退到默认页
  const defApp = path.join(OUT, 'resources', 'default_app.asar');
  if (fs.existsSync(defApp)) fs.unlinkSync(defApp);
}

/** 体积优化：只保留中英文语言包，删除其余 locales（省约 30-40MB） */
function stripLocales() {
  const localesDir = path.join(OUT, 'locales');
  if (!fs.existsSync(localesDir)) return;
  const keep = new Set(['zh-CN.pak', 'en-US.pak', 'en-GB.pak']);
  let removed = 0;
  for (const f of fs.readdirSync(localesDir)) {
    if (f.endsWith('.pak') && !keep.has(f)) {
      try { fs.unlinkSync(path.join(localesDir, f)); removed++; } catch (e) { /* ignore */ }
    }
  }
  console.log('      已删除多余语言包 ' + removed + ' 个（仅保留 zh-CN/en-US）');
}

/**
 * 给 exe 注入应用图标 + 版本信息（rcedit）。
 * 注意：electron-winstaller 自带的旧版 rcedit 不支持非 ASCII 路径/文件名，
 * 所以先复制到纯 ASCII 临时目录加工，再拷回 OUT。
 */
function applyRcedit() {
  const exe = path.join(OUT, APP_NAME);
  const pkg = JSON.parse(fs.readFileSync(path.join(BASE, 'package.json'), 'utf8'));
  const version = pkg.version || '0.0.0';
  const icoSrc = path.join(BASE, 'build', 'icon.ico');
  const rceditExe = path.join(BASE, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
  if (!fs.existsSync(rceditExe)) throw new Error('未找到 rcedit.exe：' + rceditExe);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-rcedit-'));
  const workExe = path.join(tmp, 'app.exe');
  const workIco = path.join(tmp, 'icon.ico');
  try {
    fs.copyFileSync(exe, workExe);
    const args = [workExe];
    if (fs.existsSync(icoSrc)) {
      fs.copyFileSync(icoSrc, workIco);
      args.push('--set-icon', workIco);
    } else {
      console.log('      [warn] 缺少 build/icon.ico，跳过图标嵌入');
    }
    args.push(
      '--set-version-string', 'FileDescription', APP_LABEL,
      '--set-version-string', 'ProductName', APP_LABEL,
      '--set-version-string', 'OriginalFilename', APP_NAME,
      '--set-version-string', 'FileVersion', version,
      '--set-file-version', version,
      '--set-product-version', version,
    );
    console.log('      rcedit 注入图标 + 版本信息（v' + version + '）…');
    // spawn 必须用 inherit/ignore，沙箱禁止 pipe 捕获子进程输出（EPERM）
    const r = spawnSync(rceditExe, args, { stdio: 'inherit', timeout: 120000 });
    if (r.error || r.status !== 0) {
      throw new Error('rcedit 失败：' + (r.error ? r.error.message : 'status=' + r.status));
    }
    fs.copyFileSync(workExe, exe);
    console.log('      exe 图标/版本信息注入完成');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** t6：产物自检——确认 exe/app.asar 存在且有效、归档内含 main.js、exe 已应用自定义图标/版本 */
function verifyOutput() {
  const appAsar = path.join(OUT, 'resources', 'app.asar');
  const exe = path.join(OUT, APP_NAME);
  const errors = [];
  if (!fs.existsSync(exe)) errors.push('缺少可执行文件：' + exe);
  if (!fs.existsSync(appAsar)) errors.push('缺少 app.asar：' + appAsar);
  else {
    const st = fs.statSync(appAsar);
    if (st.size < 1024) errors.push('app.asar 过小（' + st.size + ' 字节），归档疑似不完整');
  }
  try {
    const asar = require('@electron/asar');
    const list = asar.listPackage(appAsar);
    const MAIN_ENTRY = String.fromCharCode(92) + 'main.js'; // asar 列表条目前缀为 \（如 \main.js）
    if (!list.some((x) => x === MAIN_ENTRY || x === '/main.js')) {
      errors.push('app.asar 未包含 main.js（归档内容异常）');
    } else {
      console.log('      app.asar 内含 main.js 校验通过（共 ' + list.length + ' 个条目）');
    }
  } catch (e) {
    errors.push('app.asar 内容校验失败：' + (e && e.message || e));
  }
  // t6b：确认 rcedit 已生效——exe 不再是原生 electron.exe，且含自定义版本信息
  try {
    if (fs.existsSync(exe)) {
      const buf = fs.readFileSync(exe);
      const rawExe = path.join(ELECTRON_DIST, 'electron.exe');
      const marker = Buffer.from(APP_LABEL, 'utf16le');
      if (fs.existsSync(rawExe) && buf.length === fs.statSync(rawExe).size) {
        if (buf.equals(fs.readFileSync(rawExe))) errors.push('exe 仍为原生 electron.exe（rcedit 未生效）');
      }
      if (!buf.includes(marker)) errors.push('exe 缺少自定义版本信息（rcedit 未生效）');
    }
  } catch (e) {
    errors.push('exe 自检异常：' + (e && e.message || e));
  }
  if (errors.length) {
    console.error('❌ 产物自检失败：');
    errors.forEach((x) => console.error('   - ' + x));
    return { ok: false };
  }
  console.log('✅ 产物自检通过（exe 在、app.asar 有效）');
  return { ok: true };
}

(async () => {
  // 先清空旧产物目录（packAsar 会写入 app.asar，copyElectron 不再清目录，避免互相覆盖）
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log('[1/4] 收集生产依赖...');
  const deps = collectProdDeps();
  console.log('      生产依赖 ' + deps.length + ' 个：' + deps.map(d => d.name).join(', '));

  console.log('[2/4] 组装 app 目录...');
  const appDir = buildAppDir(deps);

  console.log('[3/4] 打包 app.asar（进程内，无 spawn）...');
  await packAsar(appDir);
  const asarSize = fs.statSync(path.join(OUT, 'resources', 'app.asar')).size;
  console.log('      app.asar 完成：' + Math.round(asarSize / 1024) + ' KB');

  console.log('[4/4] 复制 electron 运行时 + 改名 exe + 注入图标/版本...');
  copyElectron();
  stripLocales();
  applyRcedit();
  console.log('      完成：' + path.join(OUT, APP_NAME));

  // t6：产物自检——exe/app.asar 存在且有效、归档含 main.js
  const check = verifyOutput();
  if (!check.ok) process.exit(1);
  console.log('\n✅ win-unpacked 重建完成，双击可运行：');
  console.log('   ' + path.join(OUT, APP_NAME));
})().catch(e => { console.error('重建失败：' + (e && e.message || e)); process.exit(1); });
