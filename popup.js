// popup.js — 只负责展示：每 2s 向 background 请求一次实时数据（SKILL 第 26 节）。
// 所有动态文本走 textContent / DOM API，不用 innerHTML 拼接数据，避免 XSS。

import { formatDuration, percentChange } from './utils.js';
import { t, isZh, uiDate, UI_LOCALE, applyI18n } from './i18n.js';

const REFRESH_MS = 2000;
const TOP_N = 5;

const el = {
  dateLabel: document.getElementById('dateLabel'),
  totalTime: document.getElementById('totalTime'),
  delta: document.getElementById('delta'),
  currentSite: document.getElementById('currentSite'),
  topSection: document.getElementById('topSection'),
  siteList: document.getElementById('siteList'),
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

function deltaLabel(total, yesterdayTotal) {
  const pct = percentChange(total, yesterdayTotal);
  if (pct === null) return total > 0 ? t('deltaFirst') : '';
  if (pct === 0) return t('deltaSame');
  return t(pct > 0 ? 'deltaUp' : 'deltaDown', String(Math.abs(pct)));
}

function renderCurrent(current) {
  el.currentSite.textContent = '';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const label = document.createElement('span');
  label.className = 'pp-current-domain';

  if (current?.domain) {
    el.currentSite.classList.add('is-active');
    label.textContent = current.domain;
  } else {
    el.currentSite.classList.remove('is-active');
    label.textContent = t('noActivePage');
  }
  el.currentSite.append(dot, label);
}

function renderSites(rows, total) {
  el.siteList.textContent = '';
  const top = rows.slice(0, TOP_N);
  const maxMs = top[0]?.ms ?? 1;

  for (const row of top) {
    const share = total > 0 ? Math.round((row.ms / total) * 100) : 0;
    const barWidth = Math.max(4, Math.round((row.ms / maxMs) * 100));

    const item = document.createElement('div');
    item.className = 'site-row';

    const avatar = document.createElement('div');
    avatar.className = 'site-avatar';
    avatar.textContent = row.domain.charAt(0);

    const main = document.createElement('div');
    main.className = 'site-main';

    const line = document.createElement('div');
    line.className = 'site-line';
    const domain = document.createElement('span');
    domain.className = 'site-domain';
    domain.textContent = row.domain;
    const time = document.createElement('span');
    time.className = 'site-time';
    time.textContent = formatDuration(row.ms, { locale: UI_LOCALE });
    line.append(domain, time);

    const bar = document.createElement('div');
    bar.className = 'site-bar';
    const fill = document.createElement('div');
    fill.className = 'site-bar-fill';
    fill.style.width = `${barWidth}%`;
    bar.append(fill);

    const meta = document.createElement('div');
    meta.className = 'site-meta';
    meta.textContent = t('shareToday', String(share));

    main.append(line, bar, meta);
    item.append(avatar, main);
    el.siteList.append(item);
  }
}

async function render() {
  const resp = await sendMessage({ type: 'GET_DASH' });
  if (!resp || resp.error) {
    el.errorState.hidden = false;
    el.topSection.style.display = 'none';
    el.emptyState.hidden = true;
    return;
  }

  el.errorState.hidden = true;
  const { today, yesterdayTotal, current } = resp;
  const hasData = today.total > 0;

  el.totalTime.textContent = formatDuration(today.total, { locale: UI_LOCALE });
  el.delta.textContent = deltaLabel(today.total, yesterdayTotal);
  renderCurrent(current);

  el.emptyState.hidden = hasData;
  el.topSection.style.display = hasData ? '' : 'none';
  if (hasData) renderSites(today.rows, today.total);
}

function init() {
  applyI18n();
  const dateStr = uiDate(new Date(), {
    weekday: 'short',
    month: isZh ? 'long' : 'short',
    day: 'numeric'
  });
  el.dateLabel.textContent = t('todayLabel', dateStr);
  render();
  const timer = setInterval(render, REFRESH_MS);
  window.addEventListener('unload', () => clearInterval(timer));

  // 在用户手势中打开 Side Panel Dashboard
  document.getElementById('openDashboard').addEventListener('click', async () => {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    window.close();
  });
}

init();
