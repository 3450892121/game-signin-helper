'use strict';
// consistency: channel whitelists and shared dictionaries must stay single source
var fs=require('fs'),path=require('path');
var ROOT=path.join(__dirname,'..');
function rd(f){return fs.readFileSync(path.join(ROOT,f),'utf8');}
var main=rd('main.js'),pre=rd('preload.js'),app=rd('renderer/app.js');
var fail=0;
function ck(n,ok,d){console.log((ok?'OK  ':'FAIL')+' '+n+(d?'  '+d:''));if(!ok)fail++;}
function grab(src,head){var a=src.indexOf(head);if(a<0){return null;}var b=src.indexOf('];',a);var seg=src.slice(a,b);var out=[];var re=/'([a-zA-Z][a-zA-Z0-9:]*[a-zA-Z0-9])'/g;var m;while((m=re.exec(seg))!==null){out.push(m[1]);}return out;}
function same(a,b){if(a===null||b===null){return false;}if(a.length!==b.length){return false;}return a.slice().sort().join('|')===b.slice().sort().join('|');}
var mainIp=grab(main,'const IPC_CHANNELS = ['),preIp=grab(pre,'const INVOKE_CHANNELS = [');
ck('IPC invoke whitelist main=preload', same(mainIp,preIp), 'channels='+mainIp.length);
var me=grab(main,'const EVENT_CHANNELS = ['),pe=grab(pre,'const EVENT_CHANNELS = [');
ck('event whitelist main=preload', same(me,pe), 'events='+me.length);
ck('invoke count >= 33', mainIp.length>=33 ? true : false, 'main='+mainIp.length);
ck('event count >= 7', me.length>=7 ? true : false, 'events='+me.length);

var storage=require('../core/storage.js');
var secKeys=Object.keys(storage.NOTIFY_SECRET_FIELDS).sort().join('|');
ck('NOTIFY_SECRET_FIELDS exported with 5 channels', secKeys===('email|pushplus|qqbot|serverchan|wecom'), secKeys);
var leakMain=main.indexOf('serverchan: \'sendKey\'')<0;
ck('main.js has no literal secret map (single source)', leakMain);
var hasGui=app.indexOf('needs.indexOf(\'gui\') >= 0) return \'gui\'')>=0;
ck('renderer methodKind has gui fallback', hasGui);
var noDup=main.indexOf('function guessKind')<0;
ck('guessKind single source (no main duplicate)', noDup);
var setA=[];var rx=/channel: \'(\w+)\'/g;var mm;
while((mm=rx.exec(app))!==null){setA.push(mm[1]);}
var sk=setA.filter(function(v,i){return setA.indexOf(v)===i;}).sort().join('|');
ck('renderer SECRET_FIELDS channels match storage keys', sk===secKeys, sk);
var gk=require('../core/game-registry.js').guessKind;
var mapOk = gk(['web'])==='web' && gk(['gui'])==='gui' && gk(['code'])==='sms' && gk(['token'])==='paste';
ck('guessKind mapping (web/gui/code/paste)', mapOk, 'web='+gk(['web'])+' gui='+gk(['gui'])+' code='+gk(['code'])+' token='+gk(['token']));
var nf=rd('core/notify.js');
ck('notify.js SMTP 已开启证书校验（无 rejectUnauthorized:false）', nf.indexOf('rejectUnauthorized: false')<0);

// ---------- 全量 JS 语法门禁（node --check）----------
// 为什么要这道门禁：块注释里出现 */ 会提前闭合注释导致 SyntaxError，
// 而只把源文件当文本读、不真正 parse 时，这类语法炸弹要直到打包启动才会爆。
// 此门禁对全部会被打包/加载的 JS 做真实语法解析，任何提交引入语法错误都在 test:core 阶段拦截。
var cp=require('child_process');
var jsTargets=['main.js','preload.js','core/proc-output.js','core/redact.js','core/storage.js','core/logger.js','core/notify.js','core/runner.js','core/scheduler.js','core/game-registry.js','core/browser-login.js','core/qqbot.js','renderer/app.js','scripts/release.js','scripts/rebuild-unpacked.js','scripts/check-system-refs.js','../脚本/鸣潮/index.js','../脚本/崩铁/index.js','../脚本/异环/index.js'];
var synFail=[];
for (var ji=0;ji<jsTargets.length;ji++){
  var jf=jsTargets[ji];
  var jp=path.join(ROOT,jf);
  var rr=cp.spawnSync(process.execPath,['--check',jp],{stdio:'pipe'});
  if(rr.error&&rr.status===null){
    // 受限环境（如 DSH 沙箱）禁止经管道捕获子进程输出（spawnSync EPERM）：
    // 降级为 stdio:'ignore' 重试（ignore 模式 spawn 可用），仅按退出码判定语法；
    // 真实终端走 pipe，语法错误仍能输出具体行。
    rr=cp.spawnSync(process.execPath,['--check',jp],{stdio:'ignore'});
  }
  if(rr.status!==0){
    var detail=String(rr.stderr||'').split('\n')[1];
    synFail.push(jf+'：'+(detail||('退出码 '+rr.status+(rr.error?'（'+rr.error.code+'，受限环境无错误详情）':''))));
  }
}
ck('全量 JS 语法检查（node --check，'+jsTargets.length+' 个文件）', synFail.length===0, synFail.length?synFail.join(' | '):'全部通过');

// ---------- ----------
ck('main.js runSchtasks 用 buffer 收集并 GBK 兼容解码', main.indexOf("encoding: 'buffer'")>=0 && main.indexOf('decodeProcOutput(stdout)')>=0);
ck('main.js queryAllAppTasks 剥离任务名前导反斜杠', main.indexOf("replace(/^\\\\+/, '')")>=0);
ck('main.js 托盘菜单不再读取不存在的 n.gameId', main.indexOf('n.gameId')<0);
ck('main.js 网页登录 dup 守卫要求 cred.token 非空', main.indexOf('cred.token && a.credentials && a.credentials.token === cred.token')>=0);
var tjd=rd('../脚本/异环/index.js');
ck('异环插件汇总把 extraLines 失败纳入 hasFail', tjd.indexOf('extraLines.some(l => /❌|失败|异常|失效/.test')>=0);
var rel=rd('scripts/release.js');
ck('release.js run() 也走 GBK 兼容解码', rel.indexOf('decodeProcOutput(r.stdout)')>=0);
ck('runner.js persistUpdate 有删除守卫（不复活账号）', rd('core/runner.js').indexOf('if (!latest) return;')>=0);
ck('proc-output.js 存在且导出 decodeProcOutput', rd('core/proc-output.js').indexOf('module.exports = { decodeProcOutput }')>=0);

// ---------- ----------
ck('Z4: 账号级变更调用 rescheduleSafe（def+3 调用点）', (main.match(/rescheduleSafe\(\)/g)||[]).length >= 4);
ck('Z2: 渲染层不再引用已删除的 schedule 页面条件', app.indexOf("state.page === 'schedule'") < 0);
ck('Z3: 渲染层不再手动调 system:task:sync（防按磁盘旧值误删任务）', app.indexOf("invoke('system:task:sync'") < 0);
ck('Z3: onSystaskToggle 检查 settings:save 结果', app.indexOf('系统计划任务未变更') >= 0);
ck('Z1: 注册表基线含目录名→插件id 映射', rd('core/game-registry.js').indexOf('dirToId') >= 0 && main.indexOf('getDisappeared()') >= 0);
ck('D3: storage resolveInstalled 异常时回退上次快照', rd('core/storage.js').indexOf('lastInstalledRaw') >= 0);
ck('D3: 注册表扫描失败沿用上次插件且跳过消失检测', rd('core/game-registry.js').indexOf('userDirScanFailed') >= 0);
ck('Z5: runner 出口统一脱敏', rd('core/runner.js').indexOf("require('./redact.js')") >= 0 && rd('core/runner.js').indexOf('result.title = redact(result.title)') >= 0);
ck('D9: runner 已删账号跳过不计成败', rd('core/runner.js').indexOf('skipped: true') >= 0 && rd('core/runner.js').indexOf('if (result.skipped) continue;') >= 0);
// D17/D18（诊断脚本输出走 redact/maskId）在本仓库不适用：scripts/diag-*.js 是开发者本机的一次性排障脚本，未随本仓库发布。
ck('D4/D5: notify 业务码判定 + SMTP base64 折行', rd('core/notify.js').indexOf('function bizResult') >= 0 && rd('core/notify.js').indexOf("replace(/(.{76})/g") >= 0);
ck('D6: webExtract 死通道已下线（main/preload 无引用）', main.indexOf('webExtract') < 0 && pre.indexOf('webExtract') < 0);
ck('D8: 网页提取原始值先包装为对象', main.indexOf("typeof extracted !== 'object'") >= 0);
ck('D13: 打包版 --selftest 有缺失保护', main.indexOf('自测模块不可用') >= 0);
ck('D7: login-gui 动态插值走 escH', rd('core/login-gui.html').indexOf('escH(a.nickname') >= 0);
ck('D11: 主渐变统一走令牌（无散落 #8b5cf6 渐变）', rd('renderer/style.css').indexOf('linear-gradient(135deg, #8b5cf6, #38bdf8)') < 0);
ck('D12: index.html 无内联 style 属性', rd('renderer/index.html').indexOf('style="') < 0);
ck('D12: app.js 无内联 style 插值', app.indexOf('style="') < 0);
ck('D15: release.js 时间校验拒绝非法 HH:mm', rel.indexOf('2[0-3]') >= 0 && rel.indexOf('EXE.replace') < 0);
ck('D20: 桌面候选链含 User Shell Folders 兜底', rd('scripts/check-system-refs.js').indexOf('User Shell Folders') >= 0);

// ---------- ----------
var schedSrc=rd('core/scheduler.js');
var startIdx=schedSrc.indexOf('function start()');
var startBody=schedSrc.slice(startIdx, schedSrc.indexOf('\n  }', startIdx)+4);
ck('R6: start() 先 schedule() 再 catchUp()（补跑窗口不吞触发点）', startIdx>=0 && startBody.indexOf('schedule();')>=0 && startBody.indexOf('schedule();')<startBody.indexOf('catchUp()'));
var finIdx=schedSrc.indexOf('} finally {');
var finBody=schedSrc.slice(finIdx, schedSrc.indexOf('await runDue()', finIdx)+40);
ck('R6: 定时回调 finally 先 schedule() 再 runDue()（同一不变量）', finIdx>=0 && finBody.indexOf('schedule();')>=0 && finBody.indexOf('schedule();')<finBody.indexOf('await runDue()'));
ck('R6: catchUp 调用串行化（防并发补跑重复入队）', schedSrc.indexOf('catchUpTail')>=0);
ck('C1: 三个调度保存点调用 catchUpSafe（def+3 调用点）', (main.match(/catchUpSafe\(\)/g)||[]).length>=4);
ck('C1: settings:save 中 reschedule 与 catchUp 相邻', /scheduler\.reschedule\(\);[\s\S]{0,120}catchUpSafe\(\)/.test(main));
ck('C2: exit 关闭文案按系统任务开关分支（不再无条件宣称兜底）', main.indexOf('退出后到点不会自动拉起签到')>=0 && main.indexOf('next.useSystemTask')>=0);
ck('R7: release.js 7z 失败不再对 Error 调 .slice（崩溃吞真实错误）', rel.indexOf('(z.err || z.error).slice')<0 && rel.indexOf('z.error && z.error.message')>=0);

// ---------- 签到日历显示当日奖励 ----------
var loggerSrc=rd('core/logger.js');
ck('V2.8: summarizeDay 返回 rewards（聚合层透传奖励，不再丢弃）', loggerSrc.indexOf('fail, rewards }')>=0 && loggerSrc.indexOf('rewards: []')>=0);
ck('V2.8: 日历格子下方小字直显奖励（app.js+style.css）', app.indexOf('cal-reward-text')>=0 && app.indexOf('st.rewards')>=0 && rd('renderer/style.css').indexOf('cal-reward-text')>=0);
ck('release.js 快捷方式缺失时自动创建（防升级后桌面/开始菜单入口丢失）', rel.indexOf('created:')>=0 && rel.indexOf('create-failed:')>=0 && rel.indexOf("if (-not (Test-Path $lnk)) { continue }")<0);

// ---------- QQ 机器人日报 ----------
ck('E1: main.js 集成 QQ 日报定时器（含启动补发与退出清理）', main.indexOf('startQqReportTimer()')>=0 && main.indexOf('state.qqReportTimer')>=0 && main.indexOf('loadQqReportState')>=0);
ck('E2: runner.js 零改动（QQ 日报只读当天结果，不碰签到主流程）', rd('core/runner.js').indexOf('qqbot')<0 && rd('core/scheduler.js').indexOf('qqbot')<0);
ck('E3: 绑定走临时 WebSocket（intents 1<<25 = 单聊事件）', rd('core/qqbot.js').indexOf('startBind')>=0 && rd('core/qqbot.js').indexOf('1 << 25')>=0 && rd('core/qqbot.js').indexOf('stopBind')>=0);
ck('E5: 专属绑定码（只接受含随机码的消息，防误绑）', rd('core/qqbot.js').indexOf('bindCodeMatches')>=0 && rd('core/qqbot.js').indexOf('generateBindCode')>=0 && app.indexOf('绑定码')>=0);
ck('E4: qqbot 不进 scripts/（打包白名单 core/** 已覆盖）+ preload 命名空间', pre.indexOf('qqbot:bind:start')>=0 && pre.indexOf('bindStart')>=0);

// ---------- 登录方式裁剪 + 指纹持久化 + 生效时间单点 ----------
var regMod=require('../core/game-registry.js');
ck('KINDS 不含 qr 与 password', regMod.KINDS.indexOf('qr')<0 && regMod.KINDS.indexOf('password')<0, regMod.KINDS.join('/'));
ck('转发白名单不再含扫码/密码登录函数', rd('core/game-registry.js').indexOf("'startQrLogin'")<0
  && rd('core/game-registry.js').indexOf("'loginByPassword'")<0);
// 框架侧 qr/password 分发路径应彻底消失（否则白名单与渲染层会出现指向不存在面板的死代码）
ck('main.js 无 qr/password 登录通道与分发', main.indexOf("'login:qrStart'")<0 && main.indexOf("'login:password'")<0
  && main.indexOf("'event:qr'")<0 && main.indexOf('LOGIN_KIND.qr')<0 && main.indexOf('handleQrStart')<0
  && main.indexOf('handlePasswordLogin')<0);
ck('preload.js 无 qr/password 通道', pre.indexOf("'login:qrStart'")<0 && pre.indexOf("'login:password'")<0
  && pre.indexOf("'event:qr'")<0 && pre.indexOf('qrStart:')<0 && pre.indexOf('password:')<0);
ck('renderer 无 qr/password 面板与处理函数', app.indexOf('handleQrEvent')<0 && app.indexOf('onPasswordLogin')<0
  && app.indexOf('startQr')<0 && app.indexOf('panel-qr')<0 && app.indexOf('panel-password')<0
  && app.indexOf('dlg-pw-')<0 && app.indexOf('dlg-qr-')<0);
ck('不依赖 qrcode（main.js 不 require，package.json 不声明）', main.indexOf("require('qrcode')")<0
  && (function () { var d=JSON.parse(rd('package.json')).dependencies; return !d || d.qrcode===undefined; })());
// 注意：以下断言只匹配「代码形态」（函数定义 / 元素 id / 路由判断），不匹配裸标识符——
// 因为各插件头部注释与 login-gui.html 里写着「不提供 xxx」的说明，裸匹配会误伤这些注释本身。
ck('login-gui.html 无密码 tab 与面板', rd('core/login-gui.html').indexOf('id="panel-pwd"')<0
  && rd('core/login-gui.html').indexOf('pwdBtn')<0 && rd('core/login-gui.html').indexOf('data-tab="pwd"')<0
  && rd('core/login-gui.html').indexOf("'/api/password'")<0);
ck('browser-login.js 无 /api/password 路由分支', rd('core/browser-login.js').indexOf("pathname === '/api/password'")<0);
// 崩铁扫码/短信、异环密码登录已从插件移除（外部证据与链路断裂，详见各插件头部注释）
var mh=rd('../脚本/崩铁/index.js'), tj=rd('../脚本/异环/index.js');
ck('崩铁插件不含扫码与短信登录函数', mh.indexOf('async function startQrLogin')<0
  && mh.indexOf('async function queryQrLogin')<0 && mh.indexOf('async function completeQrLogin')<0
  && mh.indexOf('async function sendSmsCode')<0 && mh.indexOf('async function loginBySms')<0
  && mh.indexOf('  startQrLogin,')<0 && mh.indexOf('  sendSmsCode,')<0);
ck('异环插件不含密码登录函数', tj.indexOf('async function loginByPassword')<0
  && tj.indexOf('async function step2PasswordLogin')<0 && tj.indexOf('  loginByPassword,')<0);
// 「官方风控」这类未经核实的归因，不许以陈述句形式出现在代码/文案里
ck('「官方风控」不作为结论出现（只允许在纠错说明中被引用）',
  (function () {
    var hits=[];
    ['core/browser-login.js','renderer/app.js','../脚本/异环/index.js','../使用教程-小白版.md','../使用说明.txt'].forEach(function (f) {
      var s=rd(f); var i=s.indexOf('官方风控');
      while (i>=0) { var ctx=s.slice(Math.max(0,i-40), i+20); if (!/误诊|推翻|旧结论|误判|别把|不要|不许|未经核实|未证实/.test(ctx)) hits.push(f); i=s.indexOf('官方风控', i+1); }
    });
    return hits.length===0;
  })(), '');
// 设备指纹按游戏持久化（修「首次登录必然用全新随机指纹」）
ck('storage 提供按游戏持久化的指纹读写', typeof storage.create==='function'
  && rd('core/storage.js').indexOf('getFingerprint')>=0 && rd('core/storage.js').indexOf('saveFingerprint')>=0
  && rd('core/storage.js').indexOf('fingerprints.json')>=0);
ck('main.js makeLoginCtx 三级取值：账号凭据 → 持久化指纹 → 新生成并持久化',
  main.indexOf('getFingerprint(gameId)')>=0 && main.indexOf('saveFingerprint(gameId, fp)')>=0
  && main.indexOf('existingFingerprint(gameId)')>=0);
// 「扫码登录（网页窗口）」是把 kind:'web' 张冠李戴的旧标签，三个官方插件都没有扫码方式；
// 只匹配代码形态（不匹配注释里的纠错说明），防止它被重新写回界面文案。
ck('界面文案不再出现「扫码登录」旧标签', app.indexOf("qr: '扫码登录'")<0
  && app.indexOf("setDlgMsg('扫码登录")<0 && rd('../脚本/鸣潮/index.js').indexOf('走「扫码登录')<0);
// 生效时间三级回退：渲染层只允许有一份实现（多份实现在改规则时必然漏改）
ck('renderer 生效时间回退只有一份实现', (app.match(/a\.time \|\| gs\.time \|\| s\.defaultTime/g)||[]).length===1
  && app.indexOf('function effectiveTime(a, s)')>=0,
  '出现 '+((app.match(/a\.time \|\| gs\.time \|\| s\.defaultTime/g)||[]).length)+' 处');

console.log(fail===0?'ALL PASS':'FAILED '+fail);process.exit(fail===0?0:1);
