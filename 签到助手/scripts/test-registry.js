'use strict';
// registry cache regression: same-path plugin rewrite must reload fresh code
var fs=require('fs'),os=require('os'),path=require('path'),R=require('../core/game-registry.js');
var fail=0;
function ck(n,ok,d){console.log((ok?'OK  ':'FAIL')+' '+n+(d?'  '+d:''));if(!ok)fail++;}
var Q=function(s){return String.fromCharCode(39)+s+String.fromCharCode(39);};function src(id){
return 'module.exports = {'+String.fromCharCode(10)+
'  id: '+Q(id)+','+String.fromCharCode(10)+
'  name: '+Q('n')+','+String.fromCharCode(10)+
'  loginMethods: [{ id: '+Q('p')+', kind: '+Q('paste')+', paste: async () => ({ token: 1 }) }],'+String.fromCharCode(10)+
'  signin: async () => ({ result: { ok: true, title: 1, lines: [] }, credentialsUpdate: null })'+String.fromCharCode(10)+
'};'+String.fromCharCode(10);
}(async function(){
var t=fs.mkdtempSync(path.join(os.tmpdir(),'rgc-'));var d=path.join(t,'p1'); fs.mkdirSync(d,{recursive:true}); var i=path.join(d,'index.js');fs.writeFileSync(i,src('cache-v1')); var r=R.create({userDir:t}); r.loadAll();var lv1=r.get('cache-v1'); ck('load v1', lv1 ? true : false);fs.writeFileSync(i,src('cache-v2')); r.loadAll();var lv2=r.get('cache-v2'); var lv1x=r.get('cache-v1');ck('same-path rewrite reloads v2', lv2 ? (lv1x ? false : true) : false);var a=r.addPlugin(d);
ck('addPlugin refuses duplicate loaded id', a.ok ? false : true);var rm=await r.removePlugin('cache-v2');var rmok = rm.removed ? true : false;var dirgone = fs.existsSync(d) ? false : true;ck('remove deletes dir', rmok ? dirgone : false);fs.mkdirSync(d,{recursive:true}); fs.writeFileSync(i,src('cache-v3')); r.loadAll();var lv3=r.get('cache-v3'); ck('rebuild loads v3', lv3 ? true : false);
var r2=R.create({userDir:t});
var a2=r2.addPlugin(d);
ck('addPlugin registers fresh dir', a2.ok ? true : false);
fs.writeFileSync(i,src('cache-v4'));
var a3=r2.addPlugin(d);
var a3ok = a3.ok ? (a3.plugin ? (a3.plugin.id === 'cache-v4' ? true : false) : false) : false;
ck('addPlugin same-path rewrite reads new id', a3ok);
// ---------- 目录名≠id 时，目录删除后 getDisappeared 返回真实插件 id ----------
var t3=fs.mkdtempSync(path.join(os.tmpdir(),'rgc-z1-'));
var dataDir3=path.join(t3,'data'); fs.mkdirSync(dataDir3,{recursive:true});
var uDir3=path.join(t3,'plugins'); var d3=path.join(uDir3,'中文名目录'); fs.mkdirSync(d3,{recursive:true});
fs.writeFileSync(path.join(d3,'index.js'),src('zzdirid'));
var r3=R.create({userDir:uDir3,dataDir:dataDir3});
r3.loadAll();
ck('Z1 插件以 id 加载（目录名为中文显示名）', r3.get('zzdirid') ? true : false);
fs.rmSync(d3,{recursive:true,force:true});
r3.loadAll();
var disp=r3.getDisappeared();
ck('Z1 消失项带目录名→插件id 映射', Array.isArray(disp) && disp.length===1 && disp[0].dir==='中文名目录' && disp[0].id==='zzdirid', JSON.stringify(disp));
ck('Z1 消失项消费后清空（不重复清理）', r3.getDisappeared().length===0);
// 旧格式（纯数组）基线兼容：不崩溃、无映射时 id=null（主进程据此按"名下无数据则跳过"处理）
fs.writeFileSync(path.join(dataDir3,'.registry-user-dirs.json'), JSON.stringify(['旧目录']));
var r4=R.create({userDir:uDir3,dataDir:dataDir3});
r4.loadAll();
var disp4=r4.getDisappeared();
ck('Z1 旧格式基线兼容（id=null 不崩溃）', Array.isArray(disp4) && disp4.length===1 && disp4[0].dir==='旧目录' && disp4[0].id===null, JSON.stringify(disp4));
fs.rmSync(t3,{recursive:true,force:true});
fs.rmSync(t,{recursive:true,force:true});
console.log(fail===0 ? 'ALL PASS' : 'FAILED '+fail); process.exit(fail===0 ? 0 : 1);
})();
process.on('unhandledRejection', function(e){ console.error(String(e)); process.exit(1); });