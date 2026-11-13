import { createI18n } from 'vue-i18n'
import zhCN from './zh-CN'
import enUS from './en-US'

/**
 * i18n 入口:语言偏好存 localStorage(UI 小数据,见 docs/PLAN.md §4.12),
 * 默认跟随系统语言(zh 前缀 → zh-CN,否则 en-US)。
 */
const LOCALE_KEY = 'cs.locale'

function detectLocale() {
  const saved = localStorage.getItem(LOCALE_KEY)
  if (saved === 'zh-CN' || saved === 'en-US') return saved
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
  },
})

/**
 * 把当前语言同步给主进程(重建 macOS 系统菜单栏)。
 *
 * 系统菜单栏与应用内顶栏是两套:Electron 默认菜单是英文的,不随应用语言变化,
 * 这里在切换语言时通知主进程重建为对应语言。
 * @param {string} locale 语言标识
 * @returns {void}
 */
function syncLocaleToMain(locale) {
  if (typeof window === 'undefined' || !window.cs || typeof window.cs.invoke !== 'function') return
  window.cs.invoke('app:set-locale', { locale }).catch(() => {})
}

/** 设置页切换语言并持久化 */
export function setLocale(locale) {
  i18n.global.locale.value = locale
  localStorage.setItem(LOCALE_KEY, locale)
  syncLocaleToMain(locale)
}

/** 启动时把已保存的语言同步给主进程(系统菜单栏) */
export function syncLocaleOnStartup() {
  syncLocaleToMain(i18n.global.locale.value)
}

export default i18n
