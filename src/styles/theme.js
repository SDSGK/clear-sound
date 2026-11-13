/**
 * 界面主题(夜间模式):auto(跟随系统,默认)/ light / dark。
 * 偏好存 localStorage(UI 小数据,见 docs/PLAN.md §4.12);
 * auto 模式经 matchMedia 监听系统深浅色实时切换,无需主进程参与。
 * 实现:html[data-theme] + CSS 变量(main.css)与 Element Plus dark 变量(html.dark)双通道。
 */
const THEME_KEY = 'cs.theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')

function applyTheme(mode) {
  const dark = mode === 'dark' || (mode === 'auto' && media.matches)
  const root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  root.classList.toggle('dark', dark)
}

export function getTheme() {
  const saved = localStorage.getItem(THEME_KEY)
  return saved === 'light' || saved === 'dark' ? saved : 'auto'
}

export function setTheme(mode) {
  localStorage.setItem(THEME_KEY, mode)
  applyTheme(mode)
}

// auto 模式下系统深浅色变化实时跟随
media.addEventListener('change', () => {
  if (getTheme() === 'auto') applyTheme('auto')
})

// 模块加载即应用,避免挂载后闪色
applyTheme(getTheme())
