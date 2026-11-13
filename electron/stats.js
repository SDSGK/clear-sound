const { getUserStore } = require('./store')
const { logError } = require('./debug-log')

/**
 * stats.js —— 使用统计(PLAN §4.9)
 *
 * stats.json:{ days: { 'YYYY-MM-DD': { listenSec, readSec, chars, plays } } }
 * 埋点(主进程心跳):
 *  - 应用前台聚焦时每秒 +1:播放中 → listenSec,否则 → readSec
 *    (近似语义:主窗聚焦即视为活跃;阅读器/听书精确区分依赖 player 状态)
 *  - 合成字符: tts 合成成功时 addChars(text.length)
 *
 * 通道:
 *  - stats:summary {range:'day'|'week'|'month'} → {ok, days:[{date,listenSec,readSec,chars,plays}]}
 *    day = 最近 7 天逐日;week = 最近 8 周聚合;month = 最近 12 月聚合
 *  - stats:today → {ok, today}
 */

const STATS_FILE = 'stats.json'

const STATS_CHANNELS = ['stats:summary', 'stats:today', 'stats:chapter-tick']

function pad(n) {
  return String(n).padStart(2, '0')
}

function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function emptyDay() {
  return { listenSec: 0, readSec: 0, chars: 0, plays: 0 }
}

/**
 * 读取文档(兼容损坏/历史格式)
 * 注意:必须保留 chapterTime(每章时长明细),否则统计累加会把它覆盖掉、
 * 目录页的每章时长也永远读不到。
 */
function loadDoc(store) {
  const raw = store.getRaw()
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.days) {
    return {
      days: raw.days,
      chapterTime: raw.chapterTime && typeof raw.chapterTime === 'object' ? raw.chapterTime : {},
    }
  }
  return { days: {}, chapterTime: {} }
}

/** 累计到今日桶(跨天自动切桶;save 走 JsonStore 30s 防抖) */
function addToToday(store, field, amount) {
  const doc = loadDoc(store)
  const key = dateKey(new Date())
  const day = doc.days[key] || emptyDay()
  day[field] = (day[field] || 0) + amount
  doc.days[key] = day
  store.setRaw(doc)
  store.save()
}

function createStatsHandlers(deps = {}) {
  function getStore() {
    return deps.store || getUserStore(STATS_FILE)
  }
  return {
    async 'stats:today'() {
      const doc = loadDoc(getStore())
      const key = dateKey(new Date())
      return { ok: true, date: key, today: doc.days[key] || emptyDay() }
    },

    /**
     * 每章时长埋点(player 节流调用):
     * {bookId, chapterIdx, sec, kind:'listen'|'read'} → 累计到
     * chapterTime['<bookId>|<idx>']:{listenSec, readSec, lastAt}
     */
    async 'stats:chapter-tick'(payload = {}) {
      const bookId = String(payload.bookId || '')
      const chapterIdx = Number(payload.chapterIdx)
      const sec = Number(payload.sec) || 0
      const kind = payload.kind === 'listen' ? 'listen' : 'read'
      if (!bookId || !Number.isInteger(chapterIdx) || chapterIdx < 0 || sec <= 0) {
        return { ok: true }
      }
      const store = getStore()
      const doc = loadDoc(store)
      const key = `${bookId}|${chapterIdx}`
      const entry = doc.chapterTime && doc.chapterTime[key]
        ? doc.chapterTime[key]
        : { listenSec: 0, readSec: 0, lastAt: '' }
      entry[kind === 'listen' ? 'listenSec' : 'readSec'] += sec
      entry.lastAt = new Date().toISOString()
      doc.chapterTime = doc.chapterTime || {}
      doc.chapterTime[key] = entry
      store.setRaw(doc)
      store.save()
      return { ok: true }
    },

    async 'stats:summary'(payload = {}) {
      const range = payload.range || 'day'
      const doc = loadDoc(getStore()).days
      const days = []
      const now = new Date()
      // 每章时长(bookId|idx → 秒),供目录/统计页明细展示
      const chapterTime = payload.bookId
        ? Object.entries(loadDoc(getStore()).chapterTime || {})
            .filter(([key]) => key.startsWith(`${payload.bookId}|`))
            .map(([key, v]) => ({ chapterIdx: Number(key.split('|')[1]), ...v }))
        : undefined

      if (range === 'week') {
        // 最近 8 周(以周一为一周起点)
        for (let w = 7; w >= 0; w -= 1) {
          const agg = emptyDay()
          const end = new Date(now)
          end.setDate(now.getDate() - w * 7)
          const endMonday = new Date(end)
          endMonday.setDate(end.getDate() - ((end.getDay() + 6) % 7))
          for (let d = 0; d < 7; d += 1) {
            const cur = new Date(endMonday)
            cur.setDate(endMonday.getDate() + d)
            const key = dateKey(cur)
            const day = doc[key]
            if (day) {
              agg.listenSec += day.listenSec || 0
              agg.readSec += day.readSec || 0
              agg.chars += day.chars || 0
              agg.plays += day.plays || 0
            }
          }
          days.push({ date: dateKey(endMonday), ...agg })
        }
      } else if (range === 'month') {
        // 最近 12 个月
        for (let m = 11; m >= 0; m -= 1) {
          const agg = emptyDay()
          const cur = new Date(now.getFullYear(), now.getMonth() - m, 1)
          const year = cur.getFullYear()
          const month = cur.getMonth()
          for (let day = 1; day <= 31; day += 1) {
            const key = dateKey(new Date(year, month, day))
            if (!key.startsWith(`${year}-${pad(month + 1)}`)) break
            const dayData = doc[key]
            if (dayData) {
              agg.listenSec += dayData.listenSec || 0
              agg.readSec += dayData.readSec || 0
              agg.chars += dayData.chars || 0
              agg.plays += dayData.plays || 0
            }
          }
          days.push({ date: `${year}-${pad(month + 1)}`, ...agg })
        }
      } else {
        // day:最近 7 天逐日
        for (let d = 6; d >= 0; d -= 1) {
          const cur = new Date(now)
          cur.setDate(now.getDate() - d)
          const key = dateKey(cur)
          const dayData = doc[key] || emptyDay()
          days.push({ date: key, ...dayData })
        }
      }
      const result = { ok: true, range, days }
      if (payload.bookId) result.chapterTime = chapterTime
      return result
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
      logError('ipc:' + channel, err, `[stats] ${channel} 失败:${message}`)
      return { ok: false, error: message }
    }
  }
}

/**
 * 注册统计 IPC 通道(在 app.whenReady 中调用)
 * @param {{ipcMain?: object, store?: object}} [options]
 * @returns {string[]} 已注册的通道名
 */
function registerStatsIpc(options = {}) {
  let ipc = options.ipcMain
  if (!ipc) {
    const electron = require('electron')
    ipc = electron && electron.ipcMain
  }
  if (!ipc || typeof ipc.handle !== 'function') {
    throw new Error('registerStatsIpc 需要可用的 ipcMain')
  }
  const handlers = createStatsHandlers({ store: options.store })
  for (const channel of STATS_CHANNELS) {
    ipc.handle(channel, wrapHandler(channel, handlers[channel]))
  }
  return STATS_CHANNELS
}

/**
 * 启动活动心跳(每秒):应用前台聚焦时累计时长。
 * 播放中 → listenSec;前台但未播放 → readSec(近似语义:主窗聚焦即活跃)。
 * @param {{getWindow: () => object, getPlayerState: () => string}} deps
 * @returns {() => void} 停止函数
 */
function startActivityTracking(deps) {
  const store = deps.store || getUserStore(STATS_FILE)
  const timer = setInterval(() => {
    const win = deps.getWindow ? deps.getWindow() : null
    const focused = !!(win && !win.isDestroyed() && win.isFocused() && win.isVisible())
    if (!focused) return
    const status = deps.getPlayerState ? deps.getPlayerState() : ''
    if (status === 'playing') {
      addToToday(store, 'listenSec', 1)
    } else if (status === 'paused' || status === 'idle' || status === 'loading' || status === '') {
      // 前台非播放 → 记为阅读(粗化语义:主窗活跃即阅读)
      addToToday(store, 'readSec', 1)
    }
    // error 状态不计入
  }, 1000)
  return () => clearInterval(timer)
}

module.exports = {
  registerStatsIpc,
  createStatsHandlers,
  startActivityTracking,
  addToToday,
  STATS_CHANNELS,
}
