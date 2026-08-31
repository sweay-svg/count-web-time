// dashboard.js — Side Panel 完整视图：Today / 7 Days / 30 Days。
// 所有动态节点用 DOM API / createElementNS 构建，不用 innerHTML 拼接数据。

import { formatDuration, dateKey, shiftDateKey } from './utils.js';
import { t, isZh, uiDate, UI_LOCALE } from './i18n.js';

const REFRESH_MS = 3000;
const SVG_NS = 'http://www.w3.org/2000/svg';

const state = {
  days: 1,
  endDate: dateKey(),
  sortBy: 'time',
  today: dateKey()
};

const el = {
  tabs: document.getElementById('rangeTabs'),
  prev: document.getElementById('prevDay'),
  next: document.getElementById('nextDay'),
  rangeLabel: document.getElementById('rangeLabel'),
  currentSite: document.getElementById('currentSite'),
  cTotal: document.getElementById('cTotal'),
  cSites: document.getElementById('cSites'),
  cAvg: document.getElementById('cAvg'),
  cMost: document.getElementById('cMost'),
  chartCard: document.getElementById('chartCard'),
  chartTitle: document.getElementById('chartTitle'),
  chart: document.getElementById('chart'),
  sortBy: document.getElementById('sortBy'),
  rankCard: document.getElementById('rankCard'),
  rankList: document.getElementById('rankList'),
  emptyState: document.getElementById('emptyState'),
  errorState: document.getElementById('errorState')
};

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(response);
    });
  });
}

// ---------- 日期展示 ----------

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

// ---------- SVG 柱状图 ----------

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function renderChart(range) {
  el.chart.textContent = '';
  if (state.days === 1) {
    el.chartCard.hidden = true;
    return;
  }
  el.chartCard.hidden = false;
  el.chartTitle.textContent = state.days === 7 ? t('trend7') : t('trend30');

  const { series } = range;
  const n = series.length;
  const W = 320;
  const H = 140;
  const padX = 4;
  const top = 10;
  const axisH = 16;
  const plotH = H - top - axisH;
  const max = Math.max(1, ...series.map((s) => s.total));
  const slot = (W - padX * 2) / n;
  const barW = Math.max(2, Math.min(slot - 2, n === 7 ? 26 : 9));

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });

  series.forEach((point, i) => {
    const h = point.total > 0 ? Math.max(2, (point.total / max) * plotH) : 0;
    const x = padX + i * slot + (slot - barW) / 2;
    const y = top + plotH - h;
    const isLatest = i === n - 1;

    const bar = svgEl('rect', {
      x: x.toFixed(1),
      y: y.toFixed(1),
      width: barW.toFixed(1),
      height: h.toFixed(1),
      rx: 2,
      class: isLatest ? 'bar is-latest' : 'bar'
    });
    const tip = svgEl('title', {});
    tip.textContent = `${longDate(point.date)} · ${formatDuration(point.total, { locale: UI_LOCALE })}`;
    bar.append(tip);
    svg.append(bar);

    // 7 天全部标星期；30 天每 5 天 + 最后一天标日期数字
    const showLabel = n === 7 || i % 5 === 0 || i === n - 1;
    if (showLabel) {
      const label = svgEl('text', {
        x: (padX + i * slot + slot / 2).toFixed(1),
        y: H - 3,
        'text-anchor': 'middle',
        class: 'axis-label'
      });
      const d = parseKey(point.date);
      label.textContent = n === 7 ? uiDate(d, { weekday: 'short' }) : String(d.getDate());
      svg.append(label);
    }
  });

  el.chart.append(svg);
}

// ---------- 网站排行 ----------

function faviconNode(domain) {
  const img = document.createElement('img');
  img.className = 'site-favicon';
  img.width = 26;
  img.height = 26;
  img.alt = '';
  img.src = `chrome://favicon/size/18@1x/https://${domain}`;
  img.addEventListener('error', () => {
    const fallback = document.createElement('div');
    fallback.className = 'site-fallback';
    fallback.textContent = domain.charAt(0);
    img.replaceWith(fallback);
  }, { once: true });
  return img;
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

// ---------- 主渲染 ----------

async function refresh() {
  const resp = await sendMessage({ type: 'GET_RANGE', days: state.days, endDate: state.endDate });
  if (!resp || resp.error) {
    el.errorState.hidden = false;
    return;
  }
  el.errorState.hidden = true;
  state.today = resp.today;
  const { range, current } = resp;

  el.rangeLabel.textContent = buildRangeLabel(range);
  el.cTotal.textContent = formatDuration(range.total, { locale: UI_LOCALE });
  el.cSites.textContent = String(range.activeSites);
  el.cAvg.textContent = formatDuration(range.averageDaily, { locale: UI_LOCALE });
  el.cMost.textContent = range.mostUsed ?? '–';
  renderCurrent(current);

  const isEmpty = range.total === 0;
  el.emptyState.hidden = !isEmpty;
  el.chartCard.style.display = isEmpty ? 'none' : '';
  el.rankCard.style.display = isEmpty ? 'none' : '';
  if (!isEmpty) {
    renderChart(range);
    renderRanking(range);
  }

  // 历史不能翻到"未来"
  el.next.disabled = state.endDate >= state.today;
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

// 侧边栏不可见时暂停轮询，可见时立即刷新
let timer = setInterval(() => {
  if (!document.hidden) refresh();
}, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

refresh();
