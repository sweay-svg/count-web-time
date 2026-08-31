// i18n.js — 扩展页面共用的语言辅助（依赖 chrome.i18n，仅 popup/dashboard 使用）。
// 语言包位于 _locales/<locale>/messages.json，界面语言跟随浏览器 UI 语言，
// 未命中语言时回退 manifest.default_locale（zh_CN）。

export const UI_LOCALE = chrome.i18n.getUILanguage();
export const isZh = UI_LOCALE.toLowerCase().startsWith('zh');

/**
 * 取文案。substitutions 按 $1$、$2$ 顺序替换。
 * @param {string} key
 * @param {...string} substitutions
 */
export function t(key, ...substitutions) {
  return chrome.i18n.getMessage(key, substitutions.length ? substitutions : undefined) || key;
}

/** 跟随界面语言格式化日期。 */
export function uiDate(date, options) {
  return date.toLocaleDateString(isZh ? 'zh-CN' : 'en-US', options);
}
