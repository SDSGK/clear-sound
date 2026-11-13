/**
 * reader-settings.js —— 阅读器样式设置(渲染层,纯前端)
 *
 * 依据 docs/PLAN.md §4.2 / docs/DESIGN.md §3:
 *  - 阅读偏好(字体/字号/行距/字距/边距/背景主题/自动翻页)存 localStorage,
 *    属「UI 小数据」,不进主进程 JSON(见 PLAN §4.12)。
 *  - 所有视觉项通过 CSS 变量(--r-*)下发到 .reader-page 作用域,
 *    实现「设置即时热更」:改一个变量即可全局生效,无需重渲染正文。
 *
 * 注意:阅读主题(背景/前景)与界面主题(--cs-*,html[data-theme])彼此独立,
 * 即界面处于夜间模式时,阅读区仍可保持羊皮纸/素白。
 */

/** localStorage 键名(单条 JSON,便于整体读写与容错) */
export const SETTINGS_KEY = 'cs.reader.settings'

/** 默认阅读设置(不冻结:调用方可能基于它做局部覆盖) */
export const DEFAULT_SETTINGS = {
  fontFamily: 'system',
  fontSize: 18,
  lineHeight: 1.8,
  letterSpacing: 0,
  margin: 'medium',
  theme: 'sepia',
  customBg: '',
  autoScroll: false,
  autoScrollSpeed: 80,
  autoScrollNext: true,
  followScroll: true,
}

/** 字体族映射:设置项 value → CSS font-family */
export const FONT_FAMILIES = Object.freeze({
  serif: "'Songti SC', 'SimSun', 'Noto Serif CJK SC', serif",
  sans: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  kai: "'Kaiti SC', 'STKaiti', KaiTi, serif",
  system: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', sans-serif",
})

/** 页边距映射:设置项 value → 内边距(px) */
export const MARGIN_PADDING = Object.freeze({
  narrow: 24,
  medium: 48,
  wide: 80,
})

/**
 * 背景主题映射:设置项 value → { bg, fg }
 * custom 走 customBg,前景统一深色(#333333)
 */
export const THEMES = Object.freeze({
  white: { bg: '#ffffff', fg: '#333333' },
  sepia: { bg: '#f4ecd8', fg: '#5b4636' },
  green: { bg: '#cce8cf', fg: '#2e4a3a' },
  dark: { bg: '#1a1a1c', fg: '#b8b8bc' },
})

/** 自定义主题的默认前景色 */
const CUSTOM_FG = '#333333'

/**
 * 数值区间钳制(vue-i18n 无关的小工具)
 * @param {unknown} value 原始值
 * @param {number} min 下界
 * @param {number} max 上界
 * @param {number} fallback 非法时的回退值
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  if (num < min) return min
  if (num > max) return max
  return num
}

/**
 * 归一化一段设置:非法字段回落到默认值,保证下游拿到的是安全结构
 * @param {unknown} raw 原始设置对象
 * @returns {typeof DEFAULT_SETTINGS} 归一化后的设置
 */
export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const d = DEFAULT_SETTINGS
  const fontFamily = Object.prototype.hasOwnProperty.call(FONT_FAMILIES, src.fontFamily)
    ? src.fontFamily
    : d.fontFamily
  const margin = Object.prototype.hasOwnProperty.call(MARGIN_PADDING, src.margin) ? src.margin : d.margin
  let theme = Object.prototype.hasOwnProperty.call(THEMES, src.theme) ? src.theme : d.theme
  // 'custom' 是合法主题名,但需要单独的颜色来源
  if (src.theme === 'custom') theme = 'custom'
  const customBg = typeof src.customBg === 'string' ? src.customBg.trim() : ''
  return {
    fontFamily,
    fontSize: clampNumber(src.fontSize, 12, 32, d.fontSize),
    lineHeight: clampNumber(src.lineHeight, 1.4, 2.4, d.lineHeight),
    letterSpacing: clampNumber(src.letterSpacing, 0, 4, d.letterSpacing),
    margin,
    theme,
    customBg,
    autoScroll: typeof src.autoScroll === 'boolean' ? src.autoScroll : d.autoScroll,
    autoScrollSpeed: clampNumber(src.autoScrollSpeed, 30, 300, d.autoScrollSpeed),
    autoScrollNext: typeof src.autoScrollNext === 'boolean' ? src.autoScrollNext : d.autoScrollNext,
    followScroll: typeof src.followScroll === 'boolean' ? src.followScroll : d.followScroll,
  }
}

/**
 * 读取阅读设置;localStorage 不可用/数据损坏 → 回退默认值
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw)
    return normalizeSettings(parsed)
  } catch {
    // JSON 损坏或 localStorage 不可用(隐私模式等)→ 默认值
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * 写入阅读设置;失败不抛(阅读不该因为存不进去而崩)
 * @param {object} settings 设置对象
 * @returns {object} 实际落盘(归一化后)的设置
 */
export function saveSettings(settings) {
  const normalized = normalizeSettings(settings)
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized))
  } catch {
    // 忽略写入失败(配额/隐私模式),设置在本次会话内仍生效
  }
  return normalized
}

/**
 * 解析主题对应的背景/前景色
 * @param {object} s 设置对象
 * @returns {{ bg: string, fg: string }}
 */
export function resolveThemeColors(s) {
  const theme = s && s.theme ? s.theme : DEFAULT_SETTINGS.theme
  if (theme === 'custom') {
    const bg = s && typeof s.customBg === 'string' ? s.customBg.trim() : ''
    return { bg: bg || THEMES.sepia.bg, fg: CUSTOM_FG }
  }
  return THEMES[theme] || THEMES.sepia
}

/**
 * 把设置写进元素的 CSS 变量(--r-*),供 .reader-page 内的样式消费
 * @param {HTMLElement} el 目标元素
 * @param {object} s 设置对象
 * @returns {void}
 */
export function applyReaderVars(el, s) {
  if (!el || !el.style || typeof el.style.setProperty !== 'function') return
  const settings = normalizeSettings(s)
  const { bg, fg } = resolveThemeColors(settings)
  const padding = MARGIN_PADDING[settings.margin] ?? MARGIN_PADDING.medium
  const fontFamily = FONT_FAMILIES[settings.fontFamily] || FONT_FAMILIES.system
  el.style.setProperty('--r-bg', bg)
  el.style.setProperty('--r-fg', fg)
  el.style.setProperty('--r-font-family', fontFamily)
  el.style.setProperty('--r-font-size', `${settings.fontSize}px`)
  el.style.setProperty('--r-line-height', String(settings.lineHeight))
  el.style.setProperty('--r-letter-spacing', `${settings.letterSpacing}px`)
  el.style.setProperty('--r-padding', `${padding}px`)
}
