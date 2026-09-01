// storage.js — 本地数据层。
//
// 设计：
// - 通过构造参数注入存储后端（生产环境传 chrome.storage.local，测试传内存 mock），
//   因此本模块不直接依赖 chrome.*，可在 Node 中断言数据模型与写入行为。
// - 顶层三个 key：settings / stats / current，各自独立脏标记，
//   persist() 只把发生变化的 key 写回（SKILL 第 27 节：不要每次全量写 storage）。
//
// 数据模型（SKILL 第 3 节，按 domain 聚合，不保存完整 URL）：
//   settings: { idleThresholdSeconds, trackMediaPlayback, trackIncognito, theme }
//   stats[domain] = {
//     domain, totalTime(ms), visitCount(全周期), lastVisited,
//     daily: { "YYYY-MM-DD": { ms: number, visits: number } },
//     sessions: [ { start, end, ms } ]  // 最近 MAX_SESSIONS 条已结算会话（第三阶段）
//   }
//   current: 当前未闭合的活跃段（由 tracker 维护，store 只透传），无则为 null

import { shiftDateKey } from './utils.js';

// 空闲超时可选值（秒）；chrome.idle.setDetectionInterval 最小 15s，这里给四档常用值。
export const IDLE_OPTIONS = Object.freeze([30, 60, 120, 300]);
// 主题可选值（第四阶段 Appearance）。
export const THEME_OPTIONS = Object.freeze(['system', 'light', 'dark']);

export const DEFAULT_SETTINGS = Object.freeze({
  idleThresholdSeconds: 60,
  trackMediaPlayback: true,
  trackIncognito: false,
  theme: 'system'
});

/**
 * 清洗设置补丁：只保留已知且合法的字段，丢弃未知 key 与非法值。
 * 供 updateSettings 与导入数据复用，防止脏设置进入存储。
 * @param {object} patch
 * @returns {object} 只含合法字段的干净补丁（可能为空对象）
 */
export function normalizeSettings(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if (IDLE_OPTIONS.includes(patch.idleThresholdSeconds)) {
    out.idleThresholdSeconds = patch.idleThresholdSeconds;
  }
  if (typeof patch.trackMediaPlayback === 'boolean') {
    out.trackMediaPlayback = patch.trackMediaPlayback;
  }
  if (typeof patch.trackIncognito === 'boolean') {
    out.trackIncognito = patch.trackIncognito;
  }
  if (THEME_OPTIONS.includes(patch.theme)) {
    out.theme = patch.theme;
  }
  return out;
}

// 每个 domain 保留的最近会话条数（够展示"最近"，又不让数据无限膨胀）。
const MAX_SESSIONS = 30;

const STORAGE_KEYS = ['settings', 'stats', 'current'];

// 旧版本 daily 直接存毫秒数，加载时就地迁移为 { ms, visits: 0 }；
// 并给缺失 sessions 的历史站点补空数组。
function migrateDaily(stats) {
  let migrated = false;
  for (const site of Object.values(stats)) {
    if (!Array.isArray(site.sessions)) {
      site.sessions = [];
      migrated = true;
    }
    if (!site.daily) {
      site.daily = {};
      migrated = true;
      continue;
    }
    for (const [date, cell] of Object.entries(site.daily)) {
      if (typeof cell === 'number') {
        site.daily[date] = { ms: cell, visits: 0 };
        migrated = true;
      }
    }
  }
  return migrated;
}

/**
 * @param {{get(keys: string[]): Promise<object>, set(items: object): Promise<void>}} backend
 * 兼容 chrome.storage.local 的最小接口
 */
export function createStore(backend) {
  let cache = null;
  const dirty = new Set();

  function ensureLoaded() {
    if (!cache) throw new Error('store.init() must be awaited before use');
    return cache;
  }

  /** 读取单元格，兼容旧 number 格式（防御性）。 */
  function readCell(cell) {
    if (typeof cell === 'number') return { ms: cell, visits: 0 };
    return { ms: cell?.ms ?? 0, visits: cell?.visits ?? 0 };
  }

  /** 从后端载入全部数据到内存缓存，service worker 启动时调用一次。 */
  async function init() {
    const stored = await backend.get(STORAGE_KEYS);
    // 合并默认值后再整体清洗一次：旧/非法字段回退默认，未知字段剔除。
    const settings = { ...DEFAULT_SETTINGS, ...normalizeSettings({ ...DEFAULT_SETTINGS, ...(stored.settings || {}) }) };
    cache = {
      settings,
      stats: stored.stats || {},
      current: stored.current || null
    };
    if (migrateDaily(cache.stats)) dirty.add('stats');
    return cache;
  }

  /** 同步读取内存缓存（init 之后可用）。 */
  function getState() {
    return ensureLoaded();
  }

  function getSettings() {
    return ensureLoaded().settings;
  }

  /** 合并合法设置字段；非法值/未知 key 被 normalizeSettings 过滤。 */
  function updateSettings(patch) {
    const clean = normalizeSettings(patch);
    Object.assign(ensureLoaded().settings, clean);
    dirty.add('settings');
  }

  /**
   * 把一段已结束的时间累加到某 domain。
   * @param {string} domain
   * @param {{date: string, ms: number, visits?: number}[]} pieces 已按本地午夜切分；
   *        一次段结算最多在最后一片携带 visits:1（访问计入段结束当天）
   * @param {number} now 段结束时间戳
   */
  function addTime(domain, pieces, now) {
    if (!domain || !pieces || pieces.length === 0) return;
    const { stats } = ensureLoaded();

    let site = stats[domain];
    if (!site) {
      site = stats[domain] = {
        domain,
        totalTime: 0,
        visitCount: 0,
        lastVisited: 0,
        daily: {},
        sessions: []
      };
    }

    for (const { date, ms, visits = 0 } of pieces) {
      if (ms <= 0 && visits === 0) continue;
      const cell = site.daily[date] || { ms: 0, visits: 0 };
      cell.ms += ms;
      cell.visits += visits;
      site.daily[date] = cell;
      site.totalTime += ms;
      site.visitCount += visits;
    }
    site.lastVisited = now;
    dirty.add('stats');
  }

  /**
   * 记录一次已结束的会话（由 tracker 在段结算时调用）。
   * 只保留最近 MAX_SESSIONS 条；过旧自动淘汰。
   * @param {string} domain
   * @param {{start: number, end: number, ms: number}} session
   */
  function addSession(domain, session) {
    if (!domain || !session || !Number.isFinite(session.ms) || session.ms <= 0) return;
    const { stats } = ensureLoaded();
    const site = stats[domain];
    if (!site) return; // 防御：正常路径 addTime 已先创建站点
    if (!Array.isArray(site.sessions)) site.sessions = [];
    site.sessions.push(session);
    if (site.sessions.length > MAX_SESSIONS) {
      site.sessions.splice(0, site.sessions.length - MAX_SESSIONS);
    }
    dirty.add('stats');
  }

  /**
   * 单个网站详情（SKILL 34：Today / 7D / 30D / Total / 访问次数 / 平均会话 / 每日活动 / 最近会话）。
   * @param {string} domain
   * @param {string} todayKey 参考"今天"（本地），由调用方（background）以真实时间传入
   * @returns {object|null}
   */
  function getDetail(domain, todayKey) {
    const site = ensureLoaded().stats[domain];
    if (!site) return null;

    const cell = (date) => readCell(site.daily[date]);
    // 含首尾天的区间累计
    const rangeMs = (startDate, endDate) => {
      let ms = 0;
      let visits = 0;
      for (let k = startDate; ; ) {
        const c = cell(k);
        ms += c.ms;
        visits += c.visits;
        if (k === endDate) break;
        k = shiftDateKey(k, 1);
      }
      return { ms, visits };
    };

    const last7Start = shiftDateKey(todayKey, -6);
    const last30Start = shiftDateKey(todayKey, -29);
    const series = [];
    for (let i = 29; i >= 0; i--) {
      const date = shiftDateKey(todayKey, -i);
      series.push({ date, ms: cell(date).ms });
    }

    const sessions = Array.isArray(site.sessions) ? site.sessions : [];
    const avgSession = sessions.length
      ? Math.round(sessions.reduce((sum, s) => sum + s.ms, 0) / sessions.length)
      : (site.visitCount > 0 ? Math.round(site.totalTime / site.visitCount) : 0);

    return {
      domain,
      today: cell(todayKey),
      last7: rangeMs(last7Start, todayKey),
      last30: rangeMs(last30Start, todayKey),
      total: { ms: site.totalTime, visits: site.visitCount },
      avgSession,
      last7Start,
      last30Start,
      series,
      recentSessions: [...sessions].reverse().slice(0, 10)
    };
  }

  /** 某本地日期 0 点时间戳（YYYY-MM-DD → ms）。 */
  function dayStartMs(dateKeyStr) {
    const [y, m, d] = dateKeyStr.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  }

  /**
   * 清除某一天（本地日期）的全部统计数据：daily 记录、当天结束的会话；
   * 重算 totalTime / visitCount，并清理被清空的空壳站点。
   * @param {string} date YYYY-MM-DD
   */
  function clearDay(date) {
    const { stats } = ensureLoaded();
    const start = dayStartMs(date);
    const end = dayStartMs(shiftDateKey(date, 1));

    for (const domain of Object.keys(stats)) {
      const site = stats[domain];
      const cell = readCell(site.daily[date]);
      if (cell.ms > 0 || cell.visits > 0) {
        site.totalTime -= cell.ms;
        site.visitCount -= cell.visits;
        delete site.daily[date];
      }
      if (Array.isArray(site.sessions) && site.sessions.length) {
        const kept = site.sessions.filter((s) => s.end < start || s.end >= end);
        if (kept.length !== site.sessions.length) site.sessions = kept;
      }
      // 站点已无任何数据 → 移除空壳（避免脏数据留在 stats）
      if (site.totalTime <= 0 && site.visitCount <= 0 && (site.sessions?.length ?? 0) === 0) {
        delete stats[domain];
      }
    }
    dirty.add('stats');
  }

  /** 清除全部统计（保留 settings；current 由调用方 tracker.reset 处理）。 */
  function clearAll() {
    ensureLoaded().stats = {};
    dirty.add('stats');
  }

  /**
   * 从备份导入统计（覆盖当前 stats）。做结构校验 + 复用迁移清洗 + 站点字段归一，
   * 兼容旧格式备份（daily 为 number / 缺字段）。settings 与 current 不受影响。
   * @param {unknown} raw 期望为 { [domain]: WebsiteStat }
   * @returns {boolean} 是否成功导入
   */
  function importStats(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const stats = structuredClone(raw);
    migrateDaily(stats);
    for (const [domain, site] of Object.entries(stats)) {
      if (!site || typeof site !== 'object') {
        delete stats[domain];
        continue;
      }
      site.domain = (typeof site.domain === 'string' && site.domain) ? site.domain : domain;
      site.totalTime = Number.isFinite(site.totalTime) ? site.totalTime : 0;
      site.visitCount = Number.isFinite(site.visitCount) ? site.visitCount : 0;
      site.lastVisited = Number.isFinite(site.lastVisited) ? site.lastVisited : 0;
      if (!site.daily || typeof site.daily !== 'object' || Array.isArray(site.daily)) site.daily = {};
      if (!Array.isArray(site.sessions)) site.sessions = [];
      else if (site.sessions.length > MAX_SESSIONS) site.sessions = site.sessions.slice(-MAX_SESSIONS);
    }
    ensureLoaded().stats = stats;
    dirty.add('stats');
    return true;
  }

  /** 写入/清除当前未闭合活跃段。 */
  function setCurrent(segment) {
    ensureLoaded().current = segment ?? null;
    dirty.add('current');
  }

  /** 只把脏 key 写回后端；无变更时不产生写入。 */
  async function persist() {
    if (!cache || dirty.size === 0) return;
    const payload = {};
    for (const key of dirty) payload[key] = cache[key];
    await backend.set(payload);
    dirty.clear();
  }

  /**
   * 聚合某一天的各网站数据，按时长 DESC 排序。
   * @param {string} date YYYY-MM-DD
   * @returns {{date: string, total: number, rows: {domain: string, ms: number, visits: number}[]}}
   */
  function getDay(date) {
    const rows = [];
    for (const site of Object.values(ensureLoaded().stats)) {
      const { ms, visits } = readCell(site.daily[date]);
      if (ms > 0) rows.push({ domain: site.domain, ms, visits });
    }
    rows.sort((a, b) => b.ms - a.ms);
    return {
      date,
      total: rows.reduce((sum, row) => sum + row.ms, 0),
      rows
    };
  }

  /**
   * 聚合截止 endDate（含）的最近 days 天区间。
   * @param {string} endDate 区间最后一天 YYYY-MM-DD
   * @param {number} days 天数（1/7/30）
   */
  function getRange(endDate, days) {
    const keys = [];
    for (let i = days - 1; i >= 0; i--) keys.push(shiftDateKey(endDate, -i));
    const inRange = new Set(keys);
    const indexByDate = new Map(keys.map((date, i) => [date, i]));
    const series = keys.map((date) => ({ date, total: 0 }));
    const acc = new Map();

    for (const site of Object.values(ensureLoaded().stats)) {
      let ms = 0;
      let visits = 0;
      for (const [date, raw] of Object.entries(site.daily)) {
        if (!inRange.has(date)) continue;
        const cell = readCell(raw);
        ms += cell.ms;
        visits += cell.visits;
        series[indexByDate.get(date)].total += cell.ms;
      }
      if (ms > 0) acc.set(site.domain, { domain: site.domain, ms, visits });
    }

    const rows = [...acc.values()].sort((a, b) => b.ms - a.ms);
    const total = rows.reduce((sum, row) => sum + row.ms, 0);
    return {
      start: keys[0],
      end: keys[keys.length - 1],
      days,
      keys,
      total,
      activeSites: rows.length,
      averageDaily: Math.round(total / days),
      mostUsed: rows[0]?.domain ?? null,
      rows,
      series
    };
  }

  return {
    init,
    getState,
    getSettings,
    updateSettings,
    addTime,
    addSession,
    setCurrent,
    persist,
    getDay,
    getRange,
    getDetail,
    clearDay,
    clearAll,
    importStats
  };
}
