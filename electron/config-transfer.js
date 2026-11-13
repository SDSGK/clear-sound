/**
 * config-transfer.js —— 配置导出 / 导入的纯逻辑(可脱离 Electron 单测)
 *
 * PLAN §M6 验收标准:「配置导出 → 重装 → 导入可还原」。
 * 导出文档结构:
 * {
 *   app: 'clear-sound',
 *   schema: 1,
 *   exportedAt: ISO 时间,
 *   settings: { ...全部设置(引擎 apiKey 已脱敏) },
 *   corrections?: [...],   // 可选
 *   bookmarks?: [...]      // 可选
 * }
 *
 * 安全:导出的引擎 apiKey 一律置空(脱敏),导入后需用户在设置页重新填写;
 * 计数由 keysOmitted 返回,供 UI 提示「已省略 N 项密钥」。
 */

const APP_ID = 'clear-sound'
const SCHEMA_VERSION = 1

/**
 * 构造导出文档
 * @param {{settings?: object, corrections?: unknown[], bookmarks?: unknown[], includeCorrections?: boolean, includeBookmarks?: boolean}} input
 * @returns {{doc: object, keysOmitted: number}}
 */
function buildExportDoc(input = {}) {
  const settings = input.settings && typeof input.settings === 'object' ? input.settings : {}
  // 深拷贝,避免脱敏时污染内存中的设置对象
  const safeSettings = JSON.parse(JSON.stringify(settings))

  let keysOmitted = 0
  if (safeSettings.engines && typeof safeSettings.engines === 'object') {
    for (const key of Object.keys(safeSettings.engines)) {
      const engine = safeSettings.engines[key]
      if (engine && typeof engine === 'object' && engine.apiKey) {
        engine.apiKey = ''
        keysOmitted += 1
      }
    }
  }

  const doc = {
    app: APP_ID,
    schema: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: safeSettings,
  }
  if (input.includeCorrections !== false && Array.isArray(input.corrections)) {
    doc.corrections = JSON.parse(JSON.stringify(input.corrections))
  }
  if (input.includeBookmarks !== false && Array.isArray(input.bookmarks)) {
    doc.bookmarks = JSON.parse(JSON.stringify(input.bookmarks))
  }
  return { doc, keysOmitted }
}

/**
 * 校验导入文档(不是本应用的配置则抛错)
 * @param {unknown} doc 解析后的 JSON
 * @returns {object} 校验通过的文档
 */
function validateImportDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('不是「清声书坊」的配置文件')
  }
  if (doc.app !== APP_ID || !doc.settings || typeof doc.settings !== 'object') {
    throw new Error('不是「清声书坊」的配置文件')
  }
  return doc
}

/**
 * 把导入文档应用到各存储
 * @param {object} doc 已通过 validateImportDoc 的文档
 * @param {(kind: 'settings'|'corrections'|'bookmarks', data: unknown) => void} apply 写入回调
 * @returns {string[]} 已应用的分区名
 */
function applyImportDoc(doc, apply) {
  const applied = []
  if (typeof apply === 'function') {
    apply('settings', doc.settings)
    applied.push('settings')
    if (Array.isArray(doc.corrections)) {
      apply('corrections', doc.corrections)
      applied.push('corrections')
    }
    if (Array.isArray(doc.bookmarks)) {
      apply('bookmarks', doc.bookmarks)
      applied.push('bookmarks')
    }
  }
  return applied
}

module.exports = {
  APP_ID,
  SCHEMA_VERSION,
  buildExportDoc,
  validateImportDoc,
  applyImportDoc,
}
