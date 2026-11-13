/**
 * debug.js —— 渲染层调试日志(M6)
 *
 * 统一写入主进程(userData/data/debug-log.json,上限 60 条,超出自动淘汰最早的)。
 * 记录三类内容:
 *  1) 操作日志(导入/导出/编辑/删除/播放控制/设置变更…)
 *  2) 控制台报错(window error / unhandledrejection / console.error)
 *  3) 主进程与 IPC 异常(主进程侧记录,经 debug:log 合并)
 */

const enabled = { value: true }

/** 发送到主进程(失败静默,日志不能影响主流程) */
function send(payload) {
  if (typeof window === 'undefined' || !window.cs || typeof window.cs.invoke !== 'function') return
  window.cs.invoke('debug:log', payload).catch(() => {})
}

/**
 * 记录一次操作
 * @param {string} action 操作标识(如 book.import / settings.export)
 * @param {string} message 简短说明
 * @param {string} [detail] 详细信息
 */
export function logAction(action, message, detail = '') {
  if (!enabled.value) return
  send({ level: 'info', action, message, detail, source: 'renderer' })
}

/**
 * 记录一次错误
 * @param {string} source 出错来源
 * @param {unknown} err 错误对象或消息
 */
export function logError(source, err) {
  if (!enabled.value) return
  const message = err && err.message ? err.message : String(err)
  const detail = err && err.stack ? String(err.stack) : ''
  send({ level: 'error', action: 'error', message, detail, source })
}

/** 设置日志开关(与主进程 settings.debug.enabled 同步) */
export function setDebugEnabled(value) {
  enabled.value = value !== false
}

/** 读取日志开关 */
export function isDebugEnabled() {
  return enabled.value
}

/**
 * 安装全局错误捕获:window error / unhandledrejection / console.error
 * 需在应用启动时调用一次(见 src/main/index.js)
 */
export function installGlobalErrorCapture() {
  if (typeof window === 'undefined') return
  window.addEventListener('error', (event) => {
    logError('renderer', event.error || event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    logError('renderer', event.reason)
  })
  const originalError = console.error
  console.error = (...args) => {
    const text = args
      .map((a) => (a && a.message ? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
    logError('console.error', text)
    originalError.apply(console, args)
  }
}

export default { logAction, logError, installGlobalErrorCapture, setDebugEnabled, isDebugEnabled }
