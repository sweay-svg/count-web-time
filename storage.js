// storage.js — 本地数据层。
//
// 设计：
// - 通过构造参数注入存储后端（生产环境传 chrome.storage.local，测试传内存 mock），
//   因此本模块不直接依赖 chrome.*，可在 Node 中断言数据模型与写入行为。
// - 顶层三个 key：settings / stats / current，各自独立脏标记，
//   persist() 只把发生变化的 key 写回（SKILL 第 27 节：不要每次全量写 storage）。
//
// 数据模型（SKILL 第 3 节，按 domain 聚合，不保存完整 URL）：
//   settings: { idleThresholdSeconds: 60 }
//   stats[domain] = {
//     domain, totalTime(ms), visitCount(全周期), lastVisited,
//     daily: { "YYYY-MM-DD": { ms: number, visits: number } }
//   }
//   current: 当前未闭合的活跃段（由 tracker 维护，store 只透传），无则为 null

import { shiftDateKey } from './utils.js';

export const DEFAULT_SETTINGS = Object.freeze({
  idleThresholdSeconds: 60
});

const STORAGE_KEYS = ['settings', 'stats', 'current'];

// 旧版本 daily 直接存毫秒数，加载时就地迁移为 { ms, visits: 0 }。
function migrateDaily(stats) {
  let migrated = false;
  for (const site of Object.values(stats)) {
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
    cache = {
      settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
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

  function updateSettings(patch) {
    Object.assign(ensureLoaded().settings, patch);
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
        daily: {}
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
    setCurrent,
    persist,
    getDay,
    getRange
  };
}
