// utils.js — 纯函数工具模块，不依赖任何 Chrome API，可直接在 Node 中测试。

// 浏览器内部/特殊协议，这些页面不统计（SKILL 第 23 节）。
const NON_TRACKABLE_PROTOCOLS = new Set([
  'chrome:',
  'chrome-extension:',
  'edge:',
  'about:',
  'file:',
  'view-source:',
  'devtools:',
  'data:',
  'blob:',
  'moz-extension:',
  'safari-web-extension:'
]);

/**
 * 把 URL 规范化为用于聚合的 domain。
 *
 * 规则（SKILL 5.2 / 5.3）：
 * - 只剥离前导 "www."，其余多级子域名全部保留，
 *   因此 mail.google.com 与 drive.google.com 不会被错误合并。
 * - 不做 eTLD（co.uk 之类）截短：保持可预测，避免误伤。
 * - 非 http(s) 页面（chrome://、about:、file:// 等）返回 null，调用方应静默停止计时。
 *
 * 扩展点：未来若要处理多后缀或自定义合并规则，只改本函数。
 *
 * @param {string} rawUrl
 * @returns {string|null} 规范化后的 domain；不可统计时返回 null
 */
export function normalizeDomain(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  let host = url.hostname.toLowerCase();
  if (!host) return null;

  // 剥掉 IPv6 字面量的方括号仅用于判断，输出时保留可读形式。
  const isIpV6 = host.startsWith('[');
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host) return null;

  // IP 字面量（v4/v6）不做子域处理，原样作为一个独立 "domain"。
  if (isIpV6 || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.startsWith('[') ? host.slice(1, -1) : host;
  }

  return host;
}

/**
 * 本地时区的日期 key：YYYY-MM-DD（不是 UTC 日期）。
 * @param {Date} [date]
 * @returns {string}
 */
export function dateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 在日期 key 上偏移 n 天，返回新的 YYYY-MM-DD。
 * @param {string} key
 * @param {number} days
 * @returns {string}
 */
export function shiftDateKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d + days);
  return dateKey(date);
}

/**
 * 把 [startMs, endMs) 这段时长按本地午夜切分到各天。
 * 跨午夜的 session 不会被整段算进某一天（SKILL 计时准确性要求）。
 *
 * @param {number} startMs
 * @param {number} endMs
 * @returns {{date: string, ms: number}[]}
 */
export function splitDurationByLocalDay(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return [];
  }

  const pieces = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const cursorDate = new Date(cursor);
    const nextMidnight = new Date(
      cursorDate.getFullYear(),
      cursorDate.getMonth(),
      cursorDate.getDate() + 1,
      0, 0, 0, 0
    ).getTime();
    const pieceEnd = Math.min(nextMidnight, endMs);
    pieces.push({ date: dateKey(cursorDate), ms: pieceEnd - cursor });
    cursor = pieceEnd;
  }
  return pieces;
}

/**
 * 毫秒时长格式化（SKILL 第 24 节）。
 * - 默认：  42s / 42m / 1h 42m / 1d 3h
 * - 带秒：  42s / 42m 18s / 1h 42m 18s（详细页用）
 *
 * @param {number} ms
 * @param {{withSeconds?: boolean}} [opts]
 * @returns {string}
 */
export function formatDuration(ms, opts = {}) {
  const { withSeconds = false } = opts;
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (withSeconds) {
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/**
 * 环比百分比（如今天 vs 昨天）。
 * @param {number} current
 * @param {number} previous
 * @returns {number|null} 百分比整数；previous 为 0 无法比较时返回 null
 */
export function percentChange(current, previous) {
  if (previous <= 0) return current > 0 ? null : 0;
  return Math.round(((current - previous) / previous) * 100);
}
