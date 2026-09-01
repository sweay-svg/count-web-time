// theme.js — 主题应用：把 settings.theme 映射到 <html data-theme>。
// 各页面 CSS 依据 data-theme 与 prefers-color-scheme 决定深浅色：
//   data-theme="light" → 恒浅色；data-theme="dark" → 恒深色；
//   data-theme="system"（或未设置）→ 跟随系统。

export function applyTheme(theme) {
  const value = theme === 'light' || theme === 'dark' ? theme : 'system';
  document.documentElement.dataset.theme = value;
}
