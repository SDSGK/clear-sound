/**
 * reminders.js —— 护眼(20-20-20)与整点提示调度(PLAN §4.10,默认开启)
 *
 * 每秒心跳:应用前台聚焦时累计活跃秒;
 *  - 每 intervalMin(默认 20)分钟 → push('reminder:eye-rest', {min, restSec})
 *  - 本地时间跨整点 → push('reminder:chime', {time:'HH:00'})
 * push 由 index.js 注入(转发主窗渲染层,渲染层负责浮层/提示音)。
 */

let timer = null
let activeSec = 0
let lastChimeHour = -1

/** 归一化提醒配置(缺省兜底) */
function normalizeSettings(settings) {
  const reminder = (settings && settings.reminder) || {}
  const eye = reminder.eye || {}
  const chime = reminder.chime || {}
  return {
    eye: {
      enabled: eye.enabled !== false,
      intervalMin: Number.isFinite(eye.intervalMin) && eye.intervalMin > 0 ? eye.intervalMin : 20,
      restSec: Number.isFinite(eye.restSec) && eye.restSec > 0 ? eye.restSec : 20,
    },
    chime: {
      enabled: chime.enabled !== false,
      volume: Number.isFinite(chime.volume) ? chime.volume : 0.5,
    },
  }
}

/**
 * 启动提醒调度
 * @param {{getWindow: () => object, push: (channel: string, payload: object) => void, getSettings: () => object}} deps
 */
function startReminders(deps) {
  stopReminders()
  timer = setInterval(() => {
    let settings
    try {
      settings = normalizeSettings(deps.getSettings ? deps.getSettings() : null)
    } catch {
      settings = normalizeSettings(null)
    }
    const win = deps.getWindow ? deps.getWindow() : null
    // 活跃判定:主窗前台聚焦且可见(最小化/关闭窗口则挂起,不做无意义提醒)
    const active = !!(win && win.isFocused() && win.isVisible())
    if (!active) return
    activeSec += 1

    // 20-20-20:每 intervalMin 分钟触发(可配 interval/restSec)
    const eye = settings.eye
    const intervalSec = eye.intervalMin * 60
    if (eye.enabled && intervalSec > 0 && activeSec > 0 && activeSec % intervalSec === 0) {
      deps.push('reminder:eye-rest', { min: eye.intervalMin, restSec: eye.restSec })
    }

    // 整点提示:本地时间分钟==0 且该小时未提示过
    const now = new Date()
    if (now.getMinutes() === 0 && now.getHours() !== lastChimeHour) {
      lastChimeHour = now.getHours()
      if (settings.chime.enabled) {
        deps.push('reminder:chime', { time: `${String(now.getHours()).padStart(2, '0')}:00`, volume: settings.chime.volume })
      }
    }
  }, 1000)
}

/** 重置活跃累计(用户手动跳过后可调用) */
function resetActiveSeconds() {
  activeSec = 0
}

function stopReminders() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

module.exports = { startReminders, stopReminders, resetActiveSeconds }
