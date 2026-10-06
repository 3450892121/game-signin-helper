'use strict';
/**
 * 日志/展示脱敏单源
 *
 * 背景：签到/登录失败兜底常把「原始响应体片段」塞进 result.lines / Error message，
 * 落盘 signin.log（保留一年）或回显 UI/终端。若响应含 token/cookie 等字段将长期留存。
 * 本模块在出口处统一掩码，仅用于展示/持久化文本，不影响插件返回的原始数据结构与契约。
 *
 * 规则（保守，避免误伤正常文案）：
 * 1. JSON 字符串值：键名命中 CRED_KEY_RE 时值掩码（"accessToken":"xxx" → "accessToken":"***"）
 * 2. 查询串/表单键值：token=xxx → token=***
 * 3. JWT 三段式整体掩码
 * 4. 长十六进制串（>=32 位，可能是 token/指纹）掩码
 * 另提供 maskId：uid 等账号标识类 PII 的首尾保留掩码（诊断脚本用）。
 */

/** 命中即视为敏感值的键名（凭据类；uid/account_uid 等仅属 PII，走 maskId 不在此列） */
const CRED_KEY_RE = /(token|cookie|stoken|ltoken|mid|secret|passwo?rd|authorization|auth|session|ticket|sign)/i;

/** 掩码一段文本中的凭据类内容（标题/日志行/响应体片段均可直接传入） */
function redact(input) {
  let s = String(input == null ? '' : input);
  if (!s) return s;
  // 1) JSON 键值对（字符串值）
  s = s.replace(/("(?:[^"\\]|\\.)*?")(\s*:\s*")((?:[^"\\]|\\.)*?)(")/g, (m, key, colon, val, q) => {
    const k = key.slice(1, -1);
    return CRED_KEY_RE.test(k) ? key + colon + '***' + q : m;
  });
  // 2) 查询串 / 表单键值
  s = s.replace(/([?&])((?:token|stoken|ltoken|mid|cookie|access_token|refresh_token|auth|authorization|sign|ticket|session)[a-z_]*)(=)([^&\s"'<]+)/gi,
    (m, p, k, eq) => p + k + eq + '***');
  // 3) JWT 三段式
  s = s.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '***JWT***');
  // 4) 长十六进制串（>=32 位；短时间戳/短 id 不受影响）
  s = s.replace(/\b[0-9a-f]{32,}\b/gi, '***');
  return s;
}

/** 掩码账号标识类 PII（uid 等）：保留首尾各 2 字符，其余打码 */
function maskId(v) {
  const s = String(v == null ? '' : v);
  if (!s) return s;
  if (s.length <= 4) return '***';
  return s.slice(0, 2) + '****' + s.slice(-2);
}

module.exports = { redact, maskId, CRED_KEY_RE };
