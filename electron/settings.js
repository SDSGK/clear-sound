const { getUserStore } = require('./store')
const { setEnabled } = require('./debug-log')

/**
 * settings.js —— 应用设置存取(M5 提醒配置先行,M6 整合其余)
 *
 * settings.json:
 * {
 *   reminder: {
 *     eye:  { enabled: true, intervalMin: 20, restSec: 20 },
 *     chime: { enabled: true, volume: 0.5 }
 *   }
 * }
 *
 * 通道:
 *  - settings:get  → {ok, settings}
 *  - settings:set  {patch} → {ok, settings}(浅层深合并)
 */

const SETTINGS_FILE = 'settings.json'

const SETTINGS_CHANNELS = ['settings:get', 'settings:set']

const DEFAULT_SETTINGS = {
  reminder: {
    eye: { enabled: true, intervalMin: 20, restSec: 20 },
    chime: { enabled: true, volume: 0.5 },
  },
}

function loadSettings(store) {
  const raw = store.getRaw()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
  }
  // 逐段补默认(结构升级时旧文件安全)
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    reminder: {
      ...DEFAULT_SETTINGS.reminder,
      ...(raw.reminder || {}),
      eye: { ...DEFAULT_SETTINGS.reminder.eye, ...((raw.reminder || {}).eye || {}) },
      chime: { ...DEFAULT_SETTINGS.reminder.chime, ...((raw.reminder || {}).chime || {}) },
    },
  }
}

/** 深合并(仅普通对象) */
function deepMerge(base, patch) {
  const out = { ...base }
  for (const key of Object.keys(patch || {})) {
    const value = patch[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(base[key] && typeof base[key] === 'object' ? base[key] : {}, value)
    } else {
      out[key] = value
    }
  }
  return out
}

function createSettingsHandlers(deps = {}) {
  function getStore() {
    return deps.store || getUserStore(SETTINGS_FILE)
  }
  return {
    async 'settings:get'() {
      return { ok: true, settings: loadSettings(getStore()) }
    },

    async 'settings:set'(payload = {}) {
      const store = getStore()
      const merged = deepMerge(loadSettings(store), payload.patch || {})
      store.setRaw(merged)
      store.save()
      // 调试日志开关即时生效
      if (merged && merged.debug) {
        setEnabled(merged.debug.enabled !== false)
      }
      return { ok: true, settings: merged }
    },
  }
}

/** 统一错误包装 */
function wrapHandler(channel, handler) {
  return async (_event, payload) => {
    try {
      return await handler(payload || {})
    } catch (err) {
      const message = err && err.message ? err.message : String(err)
      console.error(`[settings] ${channel} 失败:${message}`)
      return { ok: false, error: message }
    }
  }
}

/**
 * 注册设置 IPC 通道(在 app.whenReady 中调用)
 * @param {{ipcMain?: object, store?: object}} [options]
 * @returns {string[]} 已注册的通道名
 */
function registerSettingsIpc(options = {}) {
  let ipc = options.ipcMain
  if (!ipc) {
    const electron = require('electron')
    ipc = electron && electron.ipcMain
  }
  if (!ipc || typeof ipc.handle !== 'function') {
    throw new Error('registerSettingsIpc 需要可用的 ipcMain')
  }
  const handlers = createSettingsHandlers({ store: options.store })
  for (const channel of SETTINGS_CHANNELS) {
    ipc.handle(channel, wrapHandler(channel, handlers[channel]))
  }
  return SETTINGS_CHANNELS
}

module.exports = {
  registerSettingsIpc,
  loadSettings,
  SETTINGS_FILE,
}
