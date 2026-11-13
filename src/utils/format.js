/**
 * format.js —— 数字与体积格式化
 *
 * 千分位:大数字(6311062 → 6,311,062)直接读很吃力,统计页与书卡片都按千分位展示。
 */

/**
 * 千分位分隔数字
 * @param {unknown} value 数值
 * @param {number} [decimals] 小数位(默认 0)
 * @returns {string} 格式化后的字符串
 */
export function formatNumber(value, decimals = 0) {
  const num = Number(value)
  if (!Number.isFinite(num)) return '0'
  return num.toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/**
 * 字节数 → 人类可读体积(KB / MB / GB)
 * @param {unknown} bytes 字节数
 * @returns {string} 如「22.4 MB」
 */
export function formatBytes(bytes) {
  const num = Number(bytes)
  if (!Number.isFinite(num) || num <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = num
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const decimals = unitIndex === 0 ? 0 : value >= 100 ? 0 : 1
  return `${value.toFixed(decimals)} ${units[unitIndex]}`
}

export default { formatNumber, formatBytes }
