// popup.js — 只负责展示：每 2s 向 background 请求一次实时数据（SKILL 第 26 节）。
// 所有动态文本走 textContent / DOM API，不用 innerHTML 拼接数据，避免 XSS。

import { formatDuration, makeDeltaLabel, sendMessage } from './utils.js';
import { t, isZh, uiDate, UI_LOCALE, applyI18n } from './i18n.js';
import { applyTheme } from './theme.js';

const REFRESH_MS = 2000;
const TOP_N = 5;
const deltaLabel = makeDeltaLabel(t);

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

function letterAvatar(domain) {
  const avatar = document.createElement('div');
  avatar.className = 'site-avatar';
  avatar.textContent = domain.charAt(0);
  return avatar;
}

// 优先后台捕获的真实图标，无缓存/加载失败回退首字母
function siteIconNode(domain, favicons) {
  const url = favicons?.[domain];
  if (url) {
    const img = document.createElement('img');
    img.className = 'site-favicon';
    img.alt = '';
    img.loading = 'lazy';
    img.src = url;
    img.addEventListener('error', () => img.replaceWith(letterAvatar(domain)), { once: true });
    return img;
  }
  return letterAvatar(domain);
}

function renderSites(rows, total, favicons) {
  el.siteList.textContent = '';
  const top = rows.slice(0, TOP_N);
  const maxMs = top[0]?.ms ?? 1;

  for (const row of top) {
    const share = total > 0 ? Math.round((row.ms / total) * 100) : 0;
    const barWidth = Math.max(4, Math.round((row.ms / maxMs) * 100));

    const item = document.createElement('div');
    item.className = 'site-row';

    const avatar = siteIconNode(row.domain, favicons);

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
  const { today, yesterdayTotal, current, settings } = resp;
  applyTheme(settings?.theme);
  const hasData = today.total > 0;

  el.totalTime.textContent = formatDuration(today.total, { locale: UI_LOCALE });
  el.delta.textContent = deltaLabel(today.total, yesterdayTotal);
  renderCurrent(current);

  el.emptyState.hidden = hasData;
  el.topSection.style.display = hasData ? '' : 'none';
  if (hasData) renderSites(today.rows, today.total, resp.favicons);
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

  // 打开独立设置页（新标签页）
  document.getElementById('openSettings').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
  });
}

init();
