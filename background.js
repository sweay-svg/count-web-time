// background.js — Manifest V3 service worker。
// 职责单一：把 Chrome 事件翻译成 tracker 状态机调用，并负责持久化节奏。
// 所有计时逻辑在 tracker.js / storage.js，本文件不做时间计算。

import { createStore } from './storage.js';
import { createTracker } from './tracker.js';
import { dateKey, shiftDateKey } from './utils.js';

const CHECKPOINT_ALARM = 'timetrack-checkpoint';
// 开发者模式下 alarm 最小周期为 30 秒；关键状态切换另有即时持久化。
const CHECKPOINT_PERIOD_MIN = 0.5;

const store = createStore(chrome.storage.local);
const tracker = createTracker(store);

// SW 顶层在冷启动与每次热唤醒时都会执行：载入数据、恢复内存段、设置 idle 阈值与 alarm。
// 这里不主动定位活动 tab：冷启动交给 onStartup（先 reset 再 reconcile），
// 热唤醒由触发它的事件或 checkpoint alarm 自然续算，
// 避免把"浏览器关闭到重新打开"之间的时间错误计入。
const ready = (async () => {
  await store.init();
  tracker.restore();
  chrome.idle.setDetectionInterval(store.getSettings().idleThresholdSeconds);
  const existing = await chrome.alarms.get(CHECKPOINT_ALARM);
  if (!existing) await chrome.alarms.create(CHECKPOINT_ALARM, { periodInMinutes: CHECKPOINT_PERIOD_MIN });
})();
ready.catch((err) => console.error('[TimeTrack] boot failed:', err));

// 包装事件监听：错误打日志而不是静默吞掉，也不让 rejection 中断 SW。
function safe(label, fn) {
  return (...args) => {
    fn(...args).catch((err) => console.error(`[TimeTrack] ${label}:`, err));
  };
}

async function queryActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ? { tabId: tab.id, url: tab.url } : null;
}

// 以浏览器真实状态重新定位当前计时对象（安装 / 浏览器冷启动后）。
async function reconcile() {
  tracker.track(await queryActiveTab());
}

// 失焦或 idle 后恢复：段已被 pause 清空时用 resume（同站回来不重复计 visit）；
// 若段仍残留（异常事件顺序），用 track 按真实活动 tab 纠偏。
async function refocus() {
  const tab = await queryActiveTab();
  if (tracker.getActiveSegment()) tracker.track(tab);
  else tracker.resume(tab);
}

// ---------- 标签页：切换 / 导航 / 关闭 ----------

chrome.tabs.onActivated.addListener(safe('onActivated', async ({ tabId }) => {
  await ready;
  try {
    const tab = await chrome.tabs.get(tabId);
    tracker.track({ tabId, url: tab.url });
  } catch (err) {
    // 事件到达时 tab 已被关闭：忽略，后续 removed/activated 事件会纠偏。
    console.warn('[TimeTrack] activated tab unavailable:', err?.message ?? err);
  }
  await store.persist();
}));

chrome.tabs.onUpdated.addListener(safe('onUpdated', async (tabId, changeInfo) => {
  if (!changeInfo.url) return; // 只在 URL 真正变化时处理（loading/complete 状态变化忽略）
  await ready;
  tracker.navigate(tabId, changeInfo.url);
  await store.persist();
}));

chrome.tabs.onRemoved.addListener(safe('onRemoved', async (tabId) => {
  await ready;
  tracker.removeTab(tabId);
  await store.persist();
}));

// ---------- 窗口焦点 ----------

chrome.windows.onFocusChanged.addListener(safe('onFocusChanged', async (windowId) => {
  await ready;
  if (windowId === chrome.windows.WINDOW_ID_NONE) tracker.pause();
  else await refocus();
  await store.persist();
}));

// ---------- 空闲检测 ----------

chrome.idle.onStateChanged.addListener(safe('onIdleState', async (state) => {
  await ready;
  if (state === 'active') await refocus();
  else tracker.pause(); // 'idle' 与 'locked' 都暂停
  await store.persist();
}));

// ---------- 周期兜底持久化 ----------

chrome.alarms.onAlarm.addListener(safe('onAlarm', async (alarm) => {
  if (alarm.name !== CHECKPOINT_ALARM) return;
  await ready;
  tracker.checkpoint();
  await store.persist();
}));

// ---------- 生命周期 ----------

chrome.runtime.onInstalled.addListener(safe('onInstalled', async () => {
  await ready;
  await reconcile();
  await store.persist();
}));

chrome.runtime.onStartup.addListener(safe('onStartup', async () => {
  await ready;
  tracker.reset(); // 丢弃浏览器关闭期间遗留的未闭合段，历史 stats 保留
  await store.persist();
  await reconcile();
  await store.persist();
}));

// ---------- popup / dashboard 取数消息 ----------

const RANGE_DAYS = new Set([1, 7, 30]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;
  if (type !== 'GET_DASH' && type !== 'GET_RANGE' && type !== 'GET_DETAIL') return false;
  ready
    .then(async () => {
      const todayKey = dateKey();
      const at = Date.now();
      if (type === 'GET_DASH') {
        sendResponse({
          today: tracker.liveDay(todayKey, at),
          yesterdayTotal: store.getDay(shiftDateKey(todayKey, -1)).total,
          current: tracker.getActiveSegment(),
          settings: store.getSettings()
        });
        return;
      }
      if (type === 'GET_RANGE') {
        // GET_RANGE：Dashboard 的 Today / 7D / 30D
        const days = RANGE_DAYS.has(message.days) ? message.days : 1;
        const endDate = typeof message.endDate === 'string' ? message.endDate : todayKey;
        sendResponse({
          today: todayKey,
          current: tracker.getActiveSegment(),
          range: tracker.liveRange(endDate, days, at)
        });
        return;
      }
      // GET_DETAIL：Website Detail（第三阶段）
      const domain = typeof message.domain === 'string' && message.domain ? message.domain : null;
      sendResponse({
        today: todayKey,
        current: tracker.getActiveSegment(),
        detail: domain ? tracker.liveDetail(domain, todayKey, at) : null
      });
    })
    .catch((err) => {
      console.error(`[TimeTrack] ${type}:`, err);
      sendResponse({ error: 'LOAD_FAILED' });
    });
  return true; // 异步 sendResponse
});
