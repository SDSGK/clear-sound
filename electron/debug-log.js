const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

/**
 * debug-log.js —— 统一调试日志(PLAN §M6)
 *
 * 存储:userData/data/debug-log.json(数组,最多 MAX 条,超出自动淘汰最早的)
 * 内容:操作日志(导入/导出/编辑/删除/播放控制/设置变更)+ 控制台错误(渲染层 error/rejection 与主进程异常)
 * 用法:
 *   logAction('book.import', '文件 x.md 导入成功,3 章', 'renderer')
 *   logError('renderer', err)
 */

const MAX_ENTRIES = 60

/** 日志文件路径 */
function logFile() {
  return path.join(app.getPath('userData'), 'data', 'debug-log.json')
}

/** 读取全部条目(损坏时返回空数组) */
function readEntries() {
  try {
    const raw = fs.readFileSync(logFile(), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 写回(自动截断到 MAX 条,保留最新的) */
function writeEntries(entries) {
  const file = logFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2), 'utf8')
  } catch (err) {
    originalConsoleError('[debug-log] 写入失败:', err && err.message)
  }
}

// 原始 console.error 引用(包装后用于自举,避免递归)
const originalConsoleError = console.error.bind(console)

/** 启用开关缓存(settings.debug.enabled),带短 TTL 避免高频读盘 */
let enabledCache = { value: true, at: 0 }
const ENABLED_TTL_MS = 2000

/** 是否开启日志(设置项 settings.debug.enabled,默认开启) */
function isEnabled() {
  const now = Date.now()
  if (now - enabledCache.at < ENABLED_TTL_MS) return enabledCache.value
  let value = true
  try {
    const settingsPath = path.join(app.getPath('userData'), 'data', 'settings.json')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    if (settings && settings.debug && settings.debug.enabled === false) value = false
  } catch {
    /* 设置缺失/损坏 → 默认开启 */
  }
  enabledCache = { value, at: now }
  return value
}

/** 设置日志开关(由 settings:set 调用,立即生效) */
function setEnabled(value) {
  enabledCache = { value: value !== false, at: Date.now() }
}

/** 本地时间戳(YYYY-MM-DDTHH:mm:ss):toISOString 是 UTC,日志会比本地时间差时区(如快 8 小时) */
function localTimestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

/**
 * 追加一条日志(超出上限自动淘汰最早的)
 * @param {{level?: string, action: string, message?: string, detail?: string, source?: string}} entry
 * @returns {boolean} 是否写入
 */
function append(entry) {
  if (!isEnabled()) return false
  const item = {
    ts: localTimestamp(),
    level: entry.level || 'info',
    source: entry.source || 'main',
    action: entry.action || 'unknown',
    message: entry.message == null ? '' : String(entry.message),
    detail: entry.detail == null ? '' : String(entry.detail),
  }
  const entries = readEntries()
  entries.push(item)
  writeEntries(entries)
  return true
}

/**
 * 记录一次操作
 * @param {string} action 操作标识(如 book.import / settings.export)
 * @param {string} message 简短说明
 * @param {string} [source] 来源(renderer / main)
 * @returns {boolean} 是否写入
 */
function logAction(action, message, source = 'main') {
  return append({ level: 'info', action, message, source })
}

/**
 * 记录一次错误(控制台报错 / IPC 异常)
 *
 * 传入 terminalPrefix 时,额外用**原始** console.error 输出到终端,
 * 便于 IPC 处理器「一条错误 = 一条日志 + 一次终端输出」,不重复占用日志配额。
 * @param {string} source 出错来源
 * @param {unknown} err 错误对象或消息
 * @param {string} [terminalPrefix] 终端输出前缀(如 '[library] xxx 失败:xxx')
 * @returns {boolean} 是否写入
 */
function logError(source, err, terminalPrefix) {
  const message = err && err.message ? err.message : String(err)
  const detail = err && err.stack ? String(err.stack) : ''
  if (terminalPrefix) originalConsoleError(terminalPrefix)
  return append({ level: 'error', action: 'error', message, detail, source })
}

/**
 * 安装主进程错误捕获:
 *  - console.error / console.warn → 写入调试日志(保留原始输出)
 *  - process 未捕获异常 / 未处理 Promise 拒绝 → 写入调试日志
 * 需在 app ready 后调用一次(见 electron/index.js)
 * @returns {() => void} 卸载函数
 */
function installMainErrorCapture() {
  const originalError = console.error.bind(console)
  const originalWarn = console.warn.bind(console)

  console.error = (...args) => {
    try {
      logError('main.console', args.map((a) => (a && a.message ? a.message : typeof a === 'string' ? a : safeJson(a))).join(' '))
    } catch {
      /* 日志失败不影响主流程 */
    }
    originalError(...args)
  }

  console.warn = (...args) => {
    try {
      append({
        level: 'warn',
        action: 'main.warn',
        message: args.map((a) => (a && a.message ? a.message : typeof a === 'string' ? a : safeJson(a))).join(' '),
        source: 'main',
      })
    } catch {
      /* 日志失败不影响主流程 */
    }
    originalWarn(...args)
  }

  const onUncaught = (err) => {
    logError('main.uncaughtException', err)
  }
  const onRejection = (reason) => {
    logError('main.unhandledRejection', reason)
  }
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onRejection)

  return () => {
    console.error = originalError
    console.warn = originalWarn
    process.removeListener('uncaughtException', onUncaught)
    process.removeListener('unhandledRejection', onRejection)
  }
}

/** 安全 JSON 化(循环引用不抛错) */
function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 读取全部条目(新 → 旧) */
function getEntries() {
  return readEntries().slice().reverse()
}

/** 清空日志 */
function clear() {
  writeEntries([])
}

/**
 * 格式化为可复制的纯文本(供设置页「复制调试信息」)
 * @param {object[]} [entries] 指定条目,缺省取全部
 * @returns {string}
 */
function formatForClipboard(entries) {
  const list = entries || getEntries()
  const head = [
    '===== 清声书坊 调试信息 =====',
    `导出时间: ${new Date().toLocaleString()}`,
    `应用版本: ${app.getVersion()} | Electron: ${process.versions.electron}`,
    `平台: ${process.platform} ${process.arch}`,
    `记录条数: ${list.length} / ${MAX_ENTRIES}`,
    '',
  ]
  const body = list.map((e) => {
    const time = String(e.ts || '').replace('T', ' ').slice(0, 19)
    const level = e.level === 'error' ? 'ERROR' : e.level === 'warn' ? 'WARN ' : 'INFO '
    return `[${time}] ${level} [${e.source || '-'}] ${e.action}${e.message ? ' :: ' + e.message : ''}${e.detail ? '\n    ' + String(e.detail).split('\n').slice(0, 4).join('\n    ') : ''}`
  })
  return head.concat(body).join('\n')
}

module.exports = {
  MAX_ENTRIES,
  append,
  logAction,
  logError,
  getEntries,
  clear,
  formatForClipboard,
  readEntries,
  setEnabled,
  installMainErrorCapture,
}
