// dashboard.js — Side Panel：Today / 7 Days / 30 Days 概览 + 单网站详情（Website Detail）。
// 所有动态节点用 DOM API / createElementNS 构建，不用 innerHTML 拼接数据。

import { formatDuration, dateKey, shiftDateKey, makeDeltaLabel, sendMessage } from './utils.js';
import { t, isZh, uiDate, UI_LOCALE, applyI18n } from './i18n.js';
import { applyTheme } from './theme.js';
import { renderBarChart, renderDonut, renderLineChart } from './charts.js';

const REFRESH_MS = 3000;
const deltaLabel = makeDeltaLabel(t);

const state = {
  view: 'list',          // 'list' | 'detail'
  activeDomain: null,
  days: 1,
  endDate: dateKey(),
  sortBy: 'time',
  today: dateKey(),
  favicons: {}           // domain → 网站图标 URL（后台从 tab.favIconUrl 捕获）
};

const el = {
  tabs: document.getElementById('rangeTabs'),
  listView: document.getElementById('listView'),
  detailView: document.getElementById('detailView'),
  prev: document.getElementById('prevDay'),
  next: document.getElementById('nextDay'),
  rangeLabel: document.getElementById('rangeLabel'),
  currentSite: document.getElementById('currentSite'),
  cTotal: document.getElementById('cTotal'),
  cTotalDelta: document.getElementById('cTotalDelta'),
  cSites: document.getElementById('cSites'),
  cAvg: document.getElementById('cAvg'),
  cAvgLabel: document.getElementById('cAvgLabel'),
  cAvgSub: document.getElementById('cAvgSub'),
  cMost: document.getElementById('cMost'),
  chartCard: document.getElementById('chartCard'),
  chartTitle: document.getElementById('chartTitle'),
  chart: document.getElementById('chart'),
  distributionCard: document.getElementById('distributionCard'),
  distributionChart: document.getElementById('distributionChart'),
  distributionLegend: document.getElementById('distributionLegend'),
  sortBy: document.getElementById('sortBy'),
  rankCard: document.getElementById('rankCard'),
  rankList: document.getElementById('rankList'),
  emptyState: document.getElementById('emptyState'),
  errorState: document.getElementById('errorState'),
  backBtn: document.getElementById('backBtn'),
  openSettings: document.getElementById('openSettings'),
  detailFav: document.getElementById('detailFav'),
  detailDomain: document.getElementById('detailDomain'),
  detailStatus: document.getElementById('detailStatus'),
  dToday: document.getElementById('dToday'),
  dTodayVisits: document.getElementById('dTodayVisits'),
  d7: document.getElementById('d7'),
  d7Visits: document.getElementById('d7Visits'),
  d30: document.getElementById('d30'),
  d30Visits: document.getElementById('d30Visits'),
  dTotal: document.getElementById('dTotal'),
  dTotalVisits: document.getElementById('dTotalVisits'),
  dAvg: document.getElementById('dAvg'),
  dVisits: document.getElementById('dVisits'),
  detailChart: document.getElementById('detailChart'),
  sessionList: document.getElementById('sessionList'),
  sessionsEmpty: document.getElementById('sessionsEmpty')
};

function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function shortDate(key) {
  return uiDate(parseKey(key), { month: isZh ? 'long' : 'short', day: 'numeric' });
}

function longDate(key) {
  return uiDate(parseKey(key), { weekday: 'short', month: isZh ? 'long' : 'short', day: 'numeric' });
}

function buildRangeLabel(range) {
  if (state.days === 1) {
    return state.endDate === state.today ? t('todayLabel', shortDate(state.endDate)) : longDate(state.endDate);
  }
  return `${shortDate(range.start)} – ${shortDate(range.end)}`;
}

// ---------- 网站排行 ----------

function letterFallback(domain) {
  const fallback = document.createElement('div');
  fallback.className = 'site-fallback';
  fallback.textContent = domain.charAt(0);
  return fallback;
}

function faviconNode(domain) {
  // 优先用后台捕获的网站真实图标；无缓存或加载失败时回退首字母方块
  const url = state.favicons?.[domain];
  if (url) {
    const img = document.createElement('img');
    img.className = 'site-favicon';
    img.width = 26;
    img.height = 26;
    img.alt = '';
    img.loading = 'lazy';
    img.src = url;
    img.addEventListener('error', () => img.replaceWith(letterFallback(domain)), { once: true });
    return img;
  }
  return letterFallback(domain);
}

function sortRows(rows) {
  const copy = [...rows];
  if (state.sortBy === 'visits') copy.sort((a, b) => b.visits - a.visits || b.ms - a.ms);
  else if (state.sortBy === 'alpha') copy.sort((a, b) => a.domain.localeCompare(b.domain));
  return copy;
}

function renderRanking(range) {
  el.rankList.textContent = '';
  const rows = sortRows(range.rows);
  const maxMs = range.rows[0]?.ms ?? 1;

  for (const row of rows) {
    const share = range.total > 0 ? Math.round((row.ms / range.total) * 100) : 0;
    const barWidth = Math.max(3, Math.round((row.ms / maxMs) * 100));

    const item = document.createElement('div');
    item.className = 'rank-row';
    item.title = t('openDetailTitle');
    item.addEventListener('click', () => showDetail(row.domain));
    item.append(faviconNode(row.domain));

    const main = document.createElement('div');
    main.className = 'rank-main';

    const line = document.createElement('div');
    line.className = 'rank-line';
    const domain = document.createElement('span');
    domain.className = 'rank-domain';
    domain.textContent = row.domain;
    const time = document.createElement('span');
    time.className = 'rank-time';
    time.textContent = formatDuration(row.ms, { locale: UI_LOCALE });
    line.append(domain, time);

    const bar = document.createElement('div');
    bar.className = 'rank-bar';
    const fill = document.createElement('div');
    fill.className = 'rank-bar-fill';
    fill.style.width = `${barWidth}%`;
    bar.append(fill);

    const meta = document.createElement('div');
    meta.className = 'rank-meta';
    const pct = document.createElement('span');
    pct.textContent = t('shareTotal', String(share));
    const visits = document.createElement('span');
    const n = row.visits;
    visits.textContent = (!isZh && n === 1)
      ? t('visitOne', String(n))
      : t('visits', String(n));
    meta.append(pct, visits);

    main.append(line, bar, meta);
    item.append(main);
    el.rankList.append(item);
  }
}

function renderCurrent(current) {
  el.currentSite.textContent = '';
  const pill = document.createElement('div');
  pill.className = 'db-current-pill';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const label = document.createElement('span');
  if (current?.domain) {
    pill.classList.add('is-active');
    label.textContent = current.domain;
  } else {
    label.textContent = t('noActivePage');
  }
  pill.append(dot, label);
  el.currentSite.append(pill);
}

// ---------- 详情视图 ----------

function visitsLabel(n) {
  return (!isZh && n === 1) ? t('visitOne', String(n)) : t('visits', String(n));
}

function renderDetail(detail, current) {
  el.detailFav.textContent = '';
  el.detailFav.append(faviconNode(detail.domain));
  el.detailDomain.textContent = detail.domain;

  const active = current?.domain === detail.domain;
  el.detailStatus.classList.toggle('is-active', active);
  el.detailStatus.textContent = '';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const statusLabel = document.createElement('span');
  statusLabel.textContent = active ? t('detailActive') : t('detailInactive');
  el.detailStatus.append(dot, statusLabel);

  const fmt = (ms) => formatDuration(ms, { locale: UI_LOCALE });
  el.dToday.textContent = fmt(detail.today.ms);
  el.dTodayVisits.textContent = visitsLabel(detail.today.visits);
  el.d7.textContent = fmt(detail.last7.ms);
  el.d7Visits.textContent = visitsLabel(detail.last7.visits);
  el.d30.textContent = fmt(detail.last30.ms);
  el.d30Visits.textContent = visitsLabel(detail.last30.visits);
  el.dTotal.textContent = fmt(detail.total.ms);
  el.dTotalVisits.textContent = visitsLabel(detail.total.visits);
  el.dAvg.textContent = fmt(detail.avgSession);
  el.dVisits.textContent = String(detail.total.visits);

  // 每日活动图：近 30 天折线图
  renderLineChart(
    el.detailChart,
    detail.series.map((p) => ({ date: p.date, total: p.ms }))
  );

  // 最近会话（最新在前）
  el.sessionList.textContent = '';
  const sessions = detail.recentSessions;
  el.sessionsEmpty.hidden = sessions.length > 0;
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'session-row';
    const time = document.createElement('span');
    time.className = 'session-time';
    time.textContent = uiDate(new Date(s.start), {
      month: isZh ? 'long' : 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    const dur = document.createElement('span');
    dur.className = 'session-dur';
    dur.textContent = fmt(s.ms);
    row.append(time, dur);
    el.sessionList.append(row);
  }
}

async function refreshDetail() {
  const resp = await sendMessage({ type: 'GET_DETAIL', domain: state.activeDomain });
  if (!resp || resp.error || !resp.detail) {
    el.errorState.hidden = false;
    el.detailView.hidden = true;
    return;
  }
  el.errorState.hidden = true;
  el.detailView.hidden = false;
  state.today = resp.today;
  state.favicons = resp.favicons ?? state.favicons;
  renderDetail(resp.detail, resp.current);
}

// ---------- 视图切换（详情为 hash 子路由） ----------

const DETAIL_HASH_PREFIX = '#/detail/';

function detailHash(domain) {
  return DETAIL_HASH_PREFIX + encodeURIComponent(domain);
}

function detailFromHash() {
  const h = location.hash;
  if (!h.startsWith(DETAIL_HASH_PREFIX)) return null;
  try {
    return decodeURIComponent(h.slice(DETAIL_HASH_PREFIX.length));
  } catch {
    return null;
  }
}

function setView(view) {
  state.view = view;
  el.listView.hidden = view !== 'list';
  el.detailView.hidden = view !== 'detail';
  el.tabs.style.display = view === 'list' ? '' : 'none';
}

// 依据当前 hash 同步视图（子路由入口；浏览器前进/后退也走这里）
function applyHash() {
  const domain = detailFromHash();
  if (domain) {
    if (state.view !== 'detail' || state.activeDomain !== domain) {
      state.activeDomain = domain;
      setView('detail');
      refreshDetail();
    }
  } else if (state.view !== 'list') {
    setView('list');
    refresh();
  }
}

function showDetail(domain) {
  const target = detailHash(domain);
  if (location.hash === target) {
    // 已在该子路由，直接渲染
    state.activeDomain = domain;
    setView('detail');
    refreshDetail();
  } else {
    location.hash = target; // 触发 hashchange → applyHash
  }
}

function showList() {
  if (location.hash) {
    location.hash = ''; // 触发 hashchange → applyHash 回到列表
  } else {
    setView('list');
    refresh();
  }
}

// ---------- 列表视图渲染 ----------

async function refreshList() {
  const resp = await sendMessage({ type: 'GET_RANGE', days: state.days, endDate: state.endDate });
  if (!resp || resp.error) {
    el.errorState.hidden = false;
    el.listView.hidden = true; // 错误时不显示占位/残留内容，避免与错误卡片并存
    return;
  }
  el.errorState.hidden = true;
  el.listView.hidden = false;
  state.today = resp.today;
  state.favicons = resp.favicons ?? {};
  const { range, current, prevDayTotal } = resp;

  el.rangeLabel.textContent = buildRangeLabel(range);
  el.cTotal.textContent = formatDuration(range.total, { locale: UI_LOCALE });
  el.cTotalDelta.textContent = state.days === 1 ? deltaLabel(range.total, prevDayTotal ?? 0) : '';
  el.cSites.textContent = String(range.activeSites);
  if (state.days === 1) {
    // 单日视图：日均=总时长（重复），改为"平均每小时访问时长"（分母=有记录的小时数）
    el.cAvgLabel.textContent = t('avgPerHour');
    const h = range.activeHours ?? 0;
    if (h > 0) {
      el.cAvg.textContent = formatDuration(Math.round(range.total / h), { locale: UI_LOCALE });
      el.cAvgSub.textContent = t('activeHours', String(h));
    } else {
      el.cAvg.textContent = '–';
      el.cAvgSub.textContent = '';
    }
  } else {
    el.cAvgLabel.textContent = t('dailyAverage');
    el.cAvg.textContent = formatDuration(range.averageDaily, { locale: UI_LOCALE });
    el.cAvgSub.textContent = '';
  }
  el.cMost.textContent = range.mostUsed ?? '–';
  renderCurrent(current);

  const isEmpty = range.total === 0;
  el.emptyState.hidden = !isEmpty;
  el.chartCard.style.display = isEmpty ? 'none' : '';
  el.rankCard.style.display = isEmpty ? 'none' : '';
  el.distributionCard.style.display = isEmpty ? 'none' : '';
  if (!isEmpty) {
    if (state.days === 1) {
      el.chartCard.hidden = true;
    } else {
      el.chartCard.hidden = false;
      el.chartTitle.textContent = state.days === 7 ? t('trend7') : t('trend30');
      renderBarChart(el.chart, range.series, state.days);
    }
    renderDonut(el.distributionChart, el.distributionLegend, range.rows, range.total);
    renderRanking(range);
  }

  // 历史不能翻到"未来"
  el.next.disabled = state.endDate >= state.today;
}

// ---------- 主渲染 ----------

async function refresh() {
  if (state.view === 'detail') {
    await refreshDetail();
    return;
  }
  await refreshList();
}

// ---------- 事件 ----------

el.tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg');
  if (!btn) return;
  state.days = Number(btn.dataset.days);
  el.tabs.querySelectorAll('.seg').forEach((b) => b.classList.toggle('is-active', b === btn));
  refresh();
});

el.prev.addEventListener('click', () => {
  state.endDate = shiftDateKey(state.endDate, -1);
  refresh();
});

el.next.addEventListener('click', () => {
  if (state.endDate >= state.today) return;
  state.endDate = shiftDateKey(state.endDate, 1);
  refresh();
});

el.sortBy.addEventListener('change', () => {
  state.sortBy = el.sortBy.value;
  refresh();
});

el.backBtn.addEventListener('click', showList);

// 打开独立设置页（新标签页）
el.openSettings.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
});

// 侧边栏不可见时暂停轮询，可见时立即刷新
applyI18n();
// 应用主题（settings.theme）
sendMessage({ type: 'GET_SETTINGS' }).then((resp) => {
  if (resp?.settings) applyTheme(resp.settings.theme);
});
let timer = setInterval(() => {
  if (!document.hidden) refresh();
}, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
window.addEventListener('hashchange', applyHash);

// 初始按 URL hash 决定进入列表还是详情子路由（浏览器恢复会话时同样适用）
if (detailFromHash()) {
  applyHash();
} else {
  refresh();
}
