// storage.js — 本地数据层。
//
// 设计：
// - 通过构造参数注入存储后端（生产环境传 chrome.storage.local，测试传内存 mock），
//   因此本模块不直接依赖 chrome.*，可在 Node 中断言数据模型与写入行为。
// - 顶层三个 key：settings / stats / current，各自独立脏标记，
//   persist() 只把发生变化的 key 写回（SKILL 第 27 节：不要每次全量写 storage）。
//
// 数据模型（SKILL 第 3 节，MVP 只按 domain 聚合，不保存 session / 完整 URL）：
//   settings: { idleThresholdSeconds: 60 }
//   stats[domain] = { domain, totalTime, visitCount, lastVisited, daily: { "YYYY-MM-DD": ms } }
//   current: 当前未闭合的活跃段（由 tracker 维护，store 只透传），无则为 null

export const DEFAULT_SETTINGS = Object.freeze({
  idleThresholdSeconds: 60
});

const STORAGE_KEYS = ['settings', 'stats', 'current'];

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

  /** 从后端载入全部数据到内存缓存，service worker 启动时调用一次。 */
  async function init() {
    const stored = await backend.get(STORAGE_KEYS);
    cache = {
      settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
      stats: stored.stats || {},
      current: stored.current || null
    };
    dirty.clear();
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
   * @param {{date: string, ms: number}[]} pieces 已按本地午夜切分的时间段
   * @param {number} now 段结束时间戳
   * @param {{countVisit?: boolean}} [opts] countVisit=true 时访问次数 +1
   */
  function addTime(domain, pieces, now, { countVisit = false } = {}) {
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

    for (const { date, ms } of pieces) {
      if (ms <= 0) continue;
      site.daily[date] = (site.daily[date] || 0) + ms;
      site.totalTime += ms;
    }
    site.lastVisited = now;
    if (countVisit) site.visitCount += 1;
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
   * @returns {{date: string, total: number, rows: {domain: string, ms: number}[]}}
   */
  function getDay(date) {
    const rows = [];
    for (const site of Object.values(ensureLoaded().stats)) {
      const ms = site.daily[date] || 0;
      if (ms > 0) rows.push({ domain: site.domain, ms });
    }
    rows.sort((a, b) => b.ms - a.ms);
    return {
      date,
      total: rows.reduce((sum, row) => sum + row.ms, 0),
      rows
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
    getDay
  };
}
