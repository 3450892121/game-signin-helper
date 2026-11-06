'use strict';
/**
 * 子进程输出解码（Windows 中文环境适配，v2.7.5 修复）
 *
 * 背景（bug 根因）：reg.exe / schtasks.exe 等控制台程序在 zh-CN Windows 上
 * 按 GBK（CP936）输出字节，此前调用方统一按 UTF-8 解码 → 中文全部乱码（含 U+FFFD），
 * 导致一连串静默故障：
 *   - main.js queryAllAppTasks 认不出「签到助手-*」任务 → v2.6.0 遗留的按游戏
 *     计划任务（签到助手-崩铁/异环/鸣潮）永远无法被识别与清理，且其中指向已删
 *     旧版本目录的任务每天到点启动失败；
 *   - release.js relinkClsid 的路径正则匹配不到 → CLSID 重链被静默跳过；
 *   - release.js verifyAll 的 Run 键自检误报失败。
 *
 * 策略：先按 UTF-8 解码；若出现替换符 U+FFFD（原字节不是合法 UTF-8，大概率 GBK），
 * 再按 GBK 解码。真 UTF-8 输出保持不变，GBK 输出得到正确中文，两种环境都兼容。
 */
function decodeProcOutput(buf) {
  if (!buf) return '';
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf), 'utf8');
  if (!buf.length) return '';
  const utf8 = buf.toString('utf8');
  if (utf8.indexOf('\uFFFD') < 0) return utf8;
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    if (gbk.indexOf('\uFFFD') < 0) return gbk;
  } catch (e) { /* 当前 ICU 不含 gbk 解码：退回 utf8（行为与旧版一致） */ }
  return utf8;
}

module.exports = { decodeProcOutput };
