'use strict';
/**
 * 子进程输出解码（Windows 中文环境适配）
 *
 * reg.exe / schtasks.exe 等控制台程序在 zh-CN Windows 上按 GBK（CP936）输出字节，
 * 若一律按 UTF-8 解码会得到乱码（U+FFFD），而调用方多处靠文本匹配工作
 * （例如按计划任务名前缀「签到助手-」筛选任务、用路径正则重链通知 CLSID），
 * 乱码会让这些匹配静默失败——既不报错也不生效。
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
  } catch (e) { /* 当前 ICU 不含 gbk 解码：退回 utf8 */ }
  return utf8;
}

module.exports = { decodeProcOutput };
