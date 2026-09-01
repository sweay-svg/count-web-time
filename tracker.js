// tracker.js — 计时状态机（纯逻辑，不直接依赖 chrome.*，时钟可注入以便测试）。
//
// 核心规则（SKILL 第 5、27、38 节）：
// - 绝不用 setInterval 累加；所有时长都由结束时间戳 - 段开始时间戳得到。
// - 内存中最多只有一个"活跃段" seg，seg 存在即代表正在计时
//   （窗口聚焦 && 该 tab 激活 && 用户非 idle，三者由 background 翻译成事件）。
// - 每次状态翻转（切换/导航/失焦/idle）立即结算并落库；alarm 周期 checkpoint 兜底，
//   因此 service worker 被回收最多丢失一个 checkpoint 周期。
// - visit 在"段"上标记 isNewVisit，段结束时一次性计入，checkpoint/失焦恢复不重复计数。

import { normalizeDomain, splitDurationByLocalDay, dateKey } from './utils.js';

/**
 * @param {ReturnType<import('./storage.js').createStore>} store
 * @param {{now?: () => number}} [opts] 注入时钟，生产环境用默认 Date.now
 */
export function createTracker(store, { now: nowFn = Date.now } = {}) {
  // seg: { tabId:number, domain:string, startedAt:number, sessionStart:number, isNewVisit:boolean } | null
  // sessionStart 是本次"会话"（连续浏览段）的真实起点；startedAt 是最近一次结算的结转点，
  // checkpoint 只推进 startedAt 而保留 sessionStart，因此兜底保存不会把一次会话切成碎片。
  let seg = null;

  /** 把一次访问标记到最后一片（计入段结束当天），不改变时长。 */
  function stampVisit(pieces, isNewVisit) {
    if (isNewVisit && pieces.length > 0) pieces[pieces.length - 1].visits = 1;
    return pieces;
  }

  /** 结算当前活跃段：[startedAt, at) 按本地天拆分后累加，并记录一次会话；不主动改 current。 */
  function settle(at) {
    if (!seg) return;
    const pieces = stampVisit(
      splitDurationByLocalDay(seg.startedAt, at),
      seg.isNewVisit
    );
    store.addTime(seg.domain, pieces, at);
    const start = seg.sessionStart ?? seg.startedAt;
    if (at > start) store.addSession(seg.domain, { start, end: at, ms: at - start });
    seg = null;
  }

  /** 开一段新计时。domain 由调用方规范化好，isNewVisit 由调用场景决定。 */
  function open(tabId, domain, at, isNewVisit) {
    seg = { tabId, domain, startedAt: at, sessionStart: at, isNewVisit };
    store.setCurrent({ ...seg });
  }

  /**
   * 活动标签页变化（tabs.onActivated）、或首次定位到当前活动 tab。
   * @param {{tabId?: number, url?: string}|null} tab
   */
  function track(tab, at = nowFn()) {
    const domain = normalizeDomain(tab?.url);
    // 同一个 tab、同一个 domain：段连续（刷新/同域页面变化不重开）。
    if (seg && tab && seg.tabId === tab.tabId && seg.domain === domain) return;

    settle(at);
    if (domain && tab.tabId != null) {
      open(tab.tabId, domain, at, true);
    } else {
      store.setCurrent(null); // 切到特殊页面或拿不到 tab
    }
  }

  /**
   * 当前活动 tab 内部发生导航（tabs.onUpdated 的 url 变化）。
   * 非活动 tab 的导航与计时无关，直接忽略。
   */
  function navigate(tabId, url, at = nowFn()) {
    if (!seg || seg.tabId !== tabId) return;
    const domain = normalizeDomain(url);
    if (domain === seg.domain) return; // 同站不同页面：合并，段连续
    settle(at);
    if (domain) open(tabId, domain, at, true);
    else store.setCurrent(null);
  }

  /** 窗口失焦 / 用户进入 idle 或 locked：暂停结算。幂等。 */
  function pause(at = nowFn()) {
    if (!seg) return;
    settle(at);
    store.setCurrent(null);
  }

  /**
   * 窗口重新聚焦 / idle 恢复为 active。
   * 恢复同一个网站不算一次新访问（isNewVisit=false）。
   * @param {{tabId?: number, url?: string}|null} tab 当前查询到的活动 tab
   */
  function resume(tab, at = nowFn()) {
    if (seg) return; // 已在计时，幂等
    const domain = normalizeDomain(tab?.url);
    if (domain && tab?.tabId != null) open(tab.tabId, domain, at, false);
    else store.setCurrent(null);
  }

  /** 标签页被关闭（tabs.onRemoved）；关掉的不是当前段则忽略。 */
  function removeTab(tabId, at = nowFn()) {
    if (!seg || seg.tabId !== tabId) return;
    settle(at);
    store.setCurrent(null);
  }

  /**
   * 周期兜底：把当前段已产生的时长落库，然后原地开新段继续计时。
   * 不更换 domain；仅在当前段承载着一次新访问时计入一次 visit，
   * 之后的结转不再重复计数（chrome.alarms 每 30s 调用一次）。
   */
  function checkpoint(at = nowFn()) {
    if (!seg) return;
    const current = seg;
    // 消费当前段的 visit 标记：新访问在首次结转时入账，后续结转不再重复。
    const pieces = stampVisit(
      splitDurationByLocalDay(current.startedAt, at),
      current.isNewVisit
    );
    store.addTime(current.domain, pieces, at);
    seg = {
      tabId: current.tabId,
      domain: current.domain,
      startedAt: at,
      sessionStart: current.sessionStart ?? current.startedAt, // 会话延续，不重置
      isNewVisit: false
    };
    store.setCurrent({ ...seg });
  }

  /** 浏览器启动（runtime.onStartup）：丢弃上次遗留未闭合段，历史 stats 保留。 */
  function reset() {
    seg = null;
    store.setCurrent(null);
  }

  /**
   * service worker 热唤醒（浏览器一直开着、SW 被回收后重启）：
   * 从持久化的 current 恢复内存段，使后续事件能结算唤醒前的时长。
   */
  function restore() {
    const current = store.getState().current;
    seg = current ? { ...current } : null;
  }

  /** 当前活跃段副本（popup 显示"正在浏览"用）。 */
  function getActiveSegment() {
    return seg ? { ...seg } : null;
  }

  /**
   * 某日的实时统计 = 已落库数据 + 当前未结算段中属于该日的部分。
   * popup 每 1~5 秒调用，避免直接读未结算状态。
   * @param {string} [date] 默认今天（本地）
   */
  function liveDay(date = dateKey(new Date(nowFn())), at = nowFn()) {
    const day = store.getDay(date);
    if (seg) {
      for (const piece of splitDurationByLocalDay(seg.startedAt, at)) {
        if (piece.date !== date) continue;
        const row = day.rows.find((r) => r.domain === seg.domain);
        if (row) row.ms += piece.ms;
        else day.rows.push({ domain: seg.domain, ms: piece.ms, visits: 0 });
        day.total += piece.ms;
      }
      day.rows.sort((a, b) => b.ms - a.ms);
    }
    return day;
  }

  /**
   * 区间实时统计 = store.getRange + 当前未结算段（仅当落在区间日期内）。
   * Dashboard 的 Today/7D/30D 统一走这里，当前段不提前计 visit。
   */
  function liveRange(endDate, days, at = nowFn()) {
    const range = store.getRange(endDate, days);
    if (!seg) return range;

    const indexByDate = new Map(range.keys.map((date, i) => [date, i]));
    for (const piece of splitDurationByLocalDay(seg.startedAt, at)) {
      const dayIndex = indexByDate.get(piece.date);
      if (dayIndex === undefined) continue;
      let row = range.rows.find((r) => r.domain === seg.domain);
      if (!row) {
        row = { domain: seg.domain, ms: 0, visits: 0 };
        range.rows.push(row);
      }
      row.ms += piece.ms;
      range.total += piece.ms;
      range.series[dayIndex].total += piece.ms;
    }
    range.rows = range.rows.filter((r) => r.ms > 0).sort((a, b) => b.ms - a.ms);
    range.activeSites = range.rows.length;
    range.averageDaily = Math.round(range.total / range.days);
    range.mostUsed = range.rows[0]?.domain ?? null;
    return range;
  }

  /**
   * 单个网站详情实时统计 = store.getDetail + 当前未结算段（仅当正在浏览该 domain）。
   * 未结束的会话不提前计入 recentSessions / visits。
   */
  function liveDetail(domain, todayKey, at = nowFn()) {
    const detail = store.getDetail(domain, todayKey);
    if (!detail || !seg || seg.domain !== domain) return detail;

    for (const piece of splitDurationByLocalDay(seg.startedAt, at)) {
      if (piece.date === todayKey) detail.today.ms += piece.ms;
      if (piece.date >= detail.last30Start) {
        detail.last30.ms += piece.ms;
        if (piece.date >= detail.last7Start) detail.last7.ms += piece.ms;
      }
      detail.total.ms += piece.ms;
      const point = detail.series.find((p) => p.date === piece.date);
      if (point) point.ms += piece.ms;
    }
    return detail;
  }

  return {
    track,
    navigate,
    pause,
    resume,
    removeTab,
    checkpoint,
    reset,
    restore,
    getActiveSegment,
    liveDay,
    liveRange,
    liveDetail
  };
}
