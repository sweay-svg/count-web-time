// settings.js — 设置页（独立标签页）。只通过消息与 background 交互，不直接写 storage。
// 所有动态文本走 textContent / DOM API，不用 innerHTML 拼接数据。
// 危险操作统一走 Modal 确认（不用浏览器 alert()）。

import { applyI18n, t } from './i18n.js';
import { dateKey } from './utils.js';
import { applyTheme } from './theme.js';

// 导入备份文件大小上限（8MB）：与 storage 侧 IMPORT_LIMITS 配套，防超大文件。
const IMPORT_FILE_MAX_BYTES = 8 * 1024 * 1024;

const el = {
  idle: document.getElementById('idleTimeout'),
  themeSeg: document.getElementById('themeSeg'),
  trackMedia: document.getElementById('trackMedia'),
  trackIncognito: document.getElementById('trackIncognito'),
  clearToday: document.getElementById('clearToday'),
  clearAll: document.getElementById('clearAll'),
  exportData: document.getElementById('exportData'),
  importData: document.getElementById('importData'),
  importFile: document.getElementById('importFile'),
  modalOverlay: document.getElementById('modalOverlay'),
  modalTitle: document.getElementById('modalTitle'),
  modalBody: document.getElementById('modalBody'),
  modalCancel: document.getElementById('modalCancel'),
  modalConfirm: document.getElementById('modalConfirm')
};

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(response);
    });
  });
}

// ---------- 统一弹窗（确认 / 提示共用同一 Modal） ----------

/** 弹出一个确认框，resolve(true/false)。每次调用挂载独立监听，关闭时清理。 */
function confirmDialog({ title, body, confirmText }) {
  return new Promise((resolve) => {
    el.modalTitle.textContent = title;
    el.modalBody.textContent = body;
    el.modalConfirm.textContent = confirmText;
    el.modalCancel.hidden = false;
    el.modalOverlay.hidden = false;

    const close = (ok) => {
      el.modalOverlay.hidden = true;
      el.modalConfirm.removeEventListener('click', onConfirm);
      el.modalCancel.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(ok);
    };
    const onConfirm = () => close(true);
    const onCancel = () => close(false);
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };

    el.modalConfirm.addEventListener('click', onConfirm);
    el.modalCancel.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

/** 提示弹窗（仅「确定」按钮），resolve()。 */
function notifyDialog({ title, body }) {
  return new Promise((resolve) => {
    el.modalTitle.textContent = title;
    el.modalBody.textContent = body;
    el.modalConfirm.textContent = t('ok');
    el.modalCancel.hidden = true;
    el.modalOverlay.hidden = false;

    const close = () => {
      el.modalOverlay.hidden = true;
      el.modalConfirm.removeEventListener('click', onOk);
      document.removeEventListener('keydown', onKey);
      resolve();
    };
    const onOk = () => close();
    const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') onOk(); };

    el.modalConfirm.addEventListener('click', onOk);
    document.addEventListener('keydown', onKey);
  });
}

/** 点击后短暂把按钮文案改为成功提示再恢复，作为操作反馈。 */
async function flashDone(btn, doneKey) {
  const original = btn.textContent;
  btn.textContent = t(doneKey);
  await new Promise((r) => setTimeout(r, 1500));
  btn.textContent = original;
}

// ---------- 读取并回填设置 ----------

async function loadSettings() {
  const resp = await sendMessage({ type: 'GET_SETTINGS' });
  if (!resp?.settings) return;
  el.idle.value = String(resp.settings.idleThresholdSeconds);
  applyTheme(resp.settings.theme);
  setThemeActive(resp.settings.theme);
  setSwitch(el.trackMedia, resp.settings.trackMediaPlayback);
  setSwitch(el.trackIncognito, resp.settings.trackIncognito);
}

// ---------- 开关 ----------

function setSwitch(btn, on) {
  btn.classList.toggle('is-on', Boolean(on));
  btn.setAttribute('aria-checked', String(Boolean(on)));
}

function bindSwitch(btn, key) {
  btn.addEventListener('click', async () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    setSwitch(btn, next);
    await sendMessage({ type: 'UPDATE_SETTINGS', patch: { [key]: next } });
  });
}

// ---------- 主题 ----------

function setThemeActive(theme) {
  el.themeSeg.querySelectorAll('.st-seg-btn').forEach((btn) => {
    const active = btn.dataset.themeVal === theme;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', String(active));
  });
}

el.themeSeg.addEventListener('click', async (e) => {
  const btn = e.target.closest('.st-seg-btn');
  if (!btn) return;
  const theme = btn.dataset.themeVal;
  applyTheme(theme);          // 立即切换本页
  setThemeActive(theme);
  await sendMessage({ type: 'UPDATE_SETTINGS', patch: { theme } });
});

bindSwitch(el.trackMedia, 'trackMediaPlayback');
bindSwitch(el.trackIncognito, 'trackIncognito');

// ---------- 事件 ----------

// Idle timeout 改变即保存（自动保存）
el.idle.addEventListener('change', async () => {
  const idleThresholdSeconds = Number(el.idle.value);
  const resp = await sendMessage({ type: 'UPDATE_SETTINGS', patch: { idleThresholdSeconds } });
  if (resp?.settings) el.idle.value = String(resp.settings.idleThresholdSeconds);
});

// Clear today：一次确认
el.clearToday.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: t('clearTodayTitle'),
    body: t('clearTodayBody'),
    confirmText: t('clearBtn')
  });
  if (!ok) return;
  await sendMessage({ type: 'CLEAR_DATA', scope: 'today' });
  flashDone(el.clearToday, 'done');
});

// Clear all：二次确认（SKILL：必须二次确认）
el.clearAll.addEventListener('click', async () => {
  const first = await confirmDialog({
    title: t('clearAllTitle'),
    body: t('clearAllBody'),
    confirmText: t('clearBtn')
  });
  if (!first) return;
  const second = await confirmDialog({
    title: t('clearAllTitle2'),
    body: t('clearAllBody2'),
    confirmText: t('clearBtn')
  });
  if (!second) return;
  await sendMessage({ type: 'CLEAR_DATA', scope: 'all' });
  flashDone(el.clearAll, 'done');
});

// Export：取备份 → 生成 JSON 文件下载
el.exportData.addEventListener('click', async () => {
  const resp = await sendMessage({ type: 'EXPORT_DATA' });
  if (!resp || resp.error) return;
  const blob = new Blob([JSON.stringify(resp, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `timetrack-backup-${dateKey()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  flashDone(el.exportData, 'doneExport');
});

// Import：选文件 → 解析校验 → 确认覆盖 → 交给 background 导入
el.importData.addEventListener('click', () => el.importFile.click());

el.importFile.addEventListener('change', async () => {
  const file = el.importFile.files?.[0];
  el.importFile.value = ''; // 允许再次选择同一文件
  if (!file) return;

  // 限制备份文件大小，避免超大文件占用内存 / 解析卡顿 / 撑爆 storage
  if (file.size > IMPORT_FILE_MAX_BYTES) {
    await notifyDialog({ title: t('importFailTitle'), body: t('importFailBody') });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    await notifyDialog({ title: t('invalidFileTitle'), body: t('invalidFileBody') });
    return;
  }
  const raw = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload.stats : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    await notifyDialog({ title: t('invalidBackupTitle'), body: t('invalidBackupBody') });
    return;
  }

  const ok = await confirmDialog({
    title: t('importTitle'),
    body: t('importBody'),
    confirmText: t('importBtn')
  });
  if (!ok) return;

  const resp = await sendMessage({ type: 'IMPORT_DATA', payload });
  if (resp?.error) {
    await notifyDialog({ title: t('importFailTitle'), body: t('importFailBody') });
    return;
  }
  flashDone(el.importData, 'doneImport');
});

applyI18n();
loadSettings();
