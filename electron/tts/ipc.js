const { listEngines, getEngine } = require('./engines')
const { logError } = require('../debug-log')

/**
 * TTS IPC 通道(PLAN §7 / §4.3 / §4.4)。
 *
 * 通道清单:
 *  - tts:engines    {}                                              → {ok, engines}
 *  - tts:synthesize {engineId, text, voice, rate, pitch?, volume?, apiKey?, baseURL?}
 *                                                             → {ok, audio(base64), mime} | {ok:false, error}
 *  - lyric:tick     {bookId, chapterIdx, segIdx, segOffsetRatio, lineText, nextText}
 *                                                                 → {ok:true}
 *
 * 统一返回 {ok:true, ...} 或 {ok:false, error:'可读错误'}。
 */

/** 本模块注册的全部通道(与 electron/preload.js 白名单对应) */
const TTS_CHANNELS = ['tts:engines', 'tts:synthesize', 'lyric:tick']

/**
 * 最近一次歌词 tick(M2 仅落模块级变量)。
 * M3 广播歌词窗/托盘:此处改为向歌词窗/托盘面板窗口广播。
 */
let lastTick = null

/**
 * 取最近一次 tick(调试/自测用)
 * @returns {object|null}
 */
function getLastTick() {
  return lastTick
}

/**
 * 创建全部通道的业务处理函数(与 Electron 解耦,便于自测)
 * @param {{engines?: object}} [deps]
 * @returns {Record<string, (payload: object) => Promise<object>>}
 */
function createTtsHandlers(deps = {}) {
  const registry = deps.engines || require('./engines')

  return {
    /** 列出全部引擎(含音色) */
    async 'tts:engines'() {
      const engines = await registry.listEngines()
      return { ok: true, engines }
    },

    /** 合成一段语音,返回 base64 音频 */
    async 'tts:synthesize'(payload) {
      const engineId = typeof payload.engineId === 'string' ? payload.engineId.trim() : ''
      if (!engineId) throw new Error('缺少 engineId')

      const engine = registry.getEngine(engineId)
      if (!engine) throw new Error(`未知的 TTS 引擎:${engineId}`)

      if (!engine.isAvailable()) {
        throw new Error(`引擎「${engine.label}」在当前系统不可用`)
      }

      if (engine.needsKey) {
        const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : ''
        if (!apiKey) throw new Error(`引擎「${engine.label}」需要 API Key,请先在设置中填写`)
      }

      const result = await engine.synthesize({
        text: payload.text,
        voice: payload.voice,
        rate: payload.rate,
        pitch: payload.pitch,
        volume: payload.volume,
        apiKey: payload.apiKey,
        baseURL: payload.baseURL,
        model: payload.model,
      })

      if (!result || !result.buffer || !result.buffer.length) {
        throw new Error('引擎未返回音频数据')
      }

      return {
        ok: true,
        audio: result.buffer.toString('base64'),
        mime: result.mime || 'audio/mpeg',
      }
    },

    /** 播放进度 tick(M2 暂存;M3 广播歌词窗/托盘) */
    async 'lyric:tick'(payload) {
      lastTick = {
        bookId: payload.bookId ?? null,
        chapterIdx: Number.isFinite(payload.chapterIdx) ? payload.chapterIdx : 0,
        segIdx: Number.isFinite(payload.segIdx) ? payload.segIdx : 0,
        segOffsetRatio: Number.isFinite(payload.segOffsetRatio) ? payload.segOffsetRatio : 0,
        lineText: typeof payload.lineText === 'string' ? payload.lineText : '',
        nextText: typeof payload.nextText === 'string' ? payload.nextText : '',
        at: Date.now(),
      }
      return { ok: true }
    },
  }
}

/**
 * 包装处理函数:统一错误 → {ok:false, error}
 * @param {string} channel
 * @param {(payload: object) => Promise<object>} handler
 * @returns {(event: unknown, payload: object) => Promise<object>}
 */
function wrapHandler(channel, handler) {
  return async (_event, payload) => {
    try {
      return await handler(payload || {})
    } catch (err) {
      const message = err && err.message ? err.message : String(err)
      logError('ipc:' + channel, err, `[tts] ${channel} 失败:${message}`)
      return { ok: false, error: message }
    }
  }
}

/**
 * 注册 TTS IPC 通道(在 app.whenReady 中调用)
 * @param {{ipcMain?: object, engines?: object}} [options]
 * @returns {string[]} 已注册的通道名
 */
function registerTtsIpc(options = {}) {
  let ipc = options.ipcMain
  if (!ipc) {
    const electron = require('electron')
    ipc = electron && electron.ipcMain
  }
  if (!ipc || typeof ipc.handle !== 'function') {
    throw new Error('registerTtsIpc 需要可用的 ipcMain')
  }

  const handlers = createTtsHandlers({ engines: options.engines })
  for (const channel of TTS_CHANNELS) {
    ipc.handle(channel, wrapHandler(channel, handlers[channel]))
  }
  return TTS_CHANNELS
}

module.exports = {
  registerTtsIpc,
  createTtsHandlers,
  wrapHandler,
  getLastTick,
  TTS_CHANNELS,
  listEngines,
  getEngine,
}
