/**
 * player.js —— 播放器 Pinia store(渲染层)
 *
 * 依据 docs/PLAN.md §4.4「合成-播放流水线与进度同步(核心)」:
 *   分段(句级)是【高亮 / 歌词 / 进度 / 缓存】的最小单位;
 *   队列保证 [当前段, +3] 预合成完毕(缓存命中直接回,未命中调引擎),
 *   段播完无缝续播下一段;timeupdate 每 ~250ms 产生 tick(segIdx、段内偏移、当前句文本);
 *   缓存 key = hash(engine|voice|rate|correctionVersion|text),重复收听零成本。
 *
 * 状态机(status):
 *   idle ──playFrom/startCurrent──> loading ──音频就绪──> playing
 *     ▲                                │                      │
 *     │                                │                      ├─pause──> paused
 *     └────────────stop───────────────┴──────────────────────┘
 *   合成失败(重试 1 次后仍失败)──> error(lastError 可读)
 *
 * 内部非响应式模块级状态(不参与 Vue 响应式):
 *   - audio 单例:全局复用一个 HTMLAudioElement(换 src 而非新建,避免内存膨胀)
 *   - queue:Map(segKey → Promise) 合成任务去重(同段并发只合成一次)
 *   - tickListeners:tick 订阅回调集合(VirtualBook 等 UI 订阅高亮/歌词)
 *   - chapterSegs:当前章的分段数组
 *
 * IPC 契约(主进程 t05 实现,签名不变):
 *   - 'tts:engines'    → {ok, engines:[{id,label,offline,needsKey,available,voices:[{id,label,lang?}]}]}
 *   - 'tts:synthesize' {engineId, text, voice, rate} → {ok, audio:base64, mime} | {ok:false, error}
 *   - 'lyric:tick'     {bookId, chapterIdx, segIdx, segOffsetRatio, lineText, nextText} → {ok}
 *
 * 与歌词中枢的双向联动(t12,DESIGN §9):
 *   - 上行(本 store → 主进程):'player:state' 推送
 *     {status, bookId, chapterIdx, segIdx, lineText, nextText, engineId, voice, rate}
 *     主进程据此广播给歌词窗 / 托盘面板 / mac 状态栏 ticker。
 *   - 下行(主进程 → 本 store):'player:control-push' {action:'toggle'|'next'|'prev'|'stop'}
 *     托盘面板 / 全局入口的控制指令由主进程转发,在此驱动播放器。
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'
import { useBooksStore } from '@/stores/books'
import { useBookmarksStore } from '@/stores/bookmarks'
import { logAction } from '@/utils/debug'
import { ElMessage } from 'element-plus'
import i18n from '@/locales'
import { useCorrectionsStore } from '@/stores/corrections'
import { segmentParagraphs } from '@/utils/tts-segment'
import { cleanForSpeech } from '@/utils/speech-text'
import { cacheKey, evictIfNeeded, get as cacheGet, initCache, put as cachePut, remove as cacheRemove } from '@/utils/tts-cache'

/** localStorage 键:播放器偏好(engineId / voice / rate)—— UI 小数据,符合 §4.12 分层 */
export const PLAYER_PREFS_KEY = 'cs.player'

/** 预合成前视段数:队列保证 [当前段, 当前段+N] 预合成完毕;8 段覆盖合成速度抖动 */
export const PREFETCH_AHEAD = 8

/** tick 节流窗口(ms):timeupdate 频率高于此则跳过本次 tick */
export const TICK_THROTTLE_MS = 250

/** 播放状态推送节流窗口(ms):状态/进度变化过于频繁时按此节流 */
export const STATE_PUSH_THROTTLE_MS = 500

// ===== 内部非响应式模块级状态 =====
/** HTMLAudioElement 单例(主播放元素) */
let audioEl = null
/** 备用 audio 元素:当前段播放期间预加载下一段,ended 时无缝交接(gapless) */
let standbyEl = null
/** 预合成完成的段音频(章内段下标 → {blob, mime}):无缝切换零 IO 直取 */
const prefetchBlobs = new Map()
/** 合成任务去重表:segKey → Promise<{blob, mime}> */
const queue = new Map()
/** tick 订阅回调集合 */
const tickListeners = new Set()
/** 当前章的分段数组 */
let chapterSegs = []
/** 当前播放的 objectURL(切段时 revoke) */
let currentObjectUrl = ''
/** 上次 tick 时间戳(节流) */
let lastTickAt = 0
/** 当前段是否已重试过(音频 error 时只重试 1 次) */
let retriedKey = ''
/** 播放令牌:每次新的播放请求 +1;await 回来后令牌不一致说明已被新请求取代(丢弃过期结果) */
let playToken = 0
/** 是否已订阅主进程下发的播放控制指令(模块级 once:避免重复订阅导致一次点击触发多次动作) */
let controlSubscribed = false
/** 控制订阅失败是否已告警过(避免每次 store 初始化都刷屏) */
let controlSubscribeWarned = false
/** 控制指令处理函数(store 初始化时注册) */
let controlHandlerRef = null
/** 上次推送播放状态的时间戳(节流) */
let lastStatePushAt = 0
/** 节流窗口内暂存的最新载荷(窗口结束时补发一次,保证最终一致) */
let pendingStatePayload = null
/** 节流窗口结束定时器(trailing 补发) */
let pendingStateTimer = null

/**
 * 调用主进程 IPC;失败统一 throw Error
 * @param {string} channel 通道名
 * @param {unknown} [payload] 参数
 * @returns {Promise<object>} IPC 返回体(已保证 ok)
 */
async function invoke(channel, payload) {
  if (typeof window === 'undefined' || !window.cs || typeof window.cs.invoke !== 'function') {
    throw new Error(`IPC_UNAVAILABLE:${channel}`)
  }
  const res = await window.cs.invoke(channel, payload)
  if (!res || !res.ok) {
    const detail = (res && (res.error || res.message)) || ''
    throw new Error(detail ? `${detail}` : `IPC_FAILED:${channel}`)
  }
  return res
}

/**
 * 把播放状态载荷推给主进程(主进程再广播给歌词窗 / 托盘面板 / 状态栏)。
 * 纯浏览器环境(无 preload)静默跳过;通道不在白名单等异常同样不打断播放。
 * @param {object} payload 状态载荷
 * @returns {void}
 */
function sendStateToMain(payload) {
  const cs = typeof window === 'undefined' ? null : window.cs
  if (!cs || typeof cs.send !== 'function') return
  try {
    cs.send('player:state', payload)
  } catch {
    // 推送失败不打断播放
  }
}

/**
 * 订阅主进程下发的播放控制指令(DESIGN §9 反向控制:托盘面板 / 全局入口 → 主窗播放器)。
 *
 * 模块级 once 标记:同一渲染进程只订阅一次(重复订阅会让一次点击触发多次动作);
 * window.cs 不存在(纯浏览器)时静默跳过。
 * @returns {void}
 */
function ensureControlSubscription() {
  if (controlSubscribed) return
  const cs = typeof window === 'undefined' ? null : window.cs
  if (!cs || typeof cs.on !== 'function') return
  try {
    cs.on('player:control-push', (payload) => {
      const action = payload && typeof payload.action === 'string' ? payload.action : ''
      const handler = controlHandlerRef
      if (typeof handler === 'function') handler(action)
    })
    controlSubscribed = true
  } catch (err) {
    // preload 白名单未放行该通道 → 静默降级(播放本身不受影响)
    if (!controlSubscribeWarned) {
      controlSubscribeWarned = true
      console.warn('[player] 订阅 player:control-push 失败(通道未放行):', err)
    }
  }
}

/**
 * 错误信息归一化
 * @param {unknown} err 错误
 * @returns {string}
 */
function toMessage(err) {
  if (!err) return 'UNKNOWN_ERROR'
  if (typeof err === 'string') return err
  return err.message || String(err)
}

/**
 * base64 → ArrayBuffer
 * @param {string} b64 base64 字符串
 * @returns {ArrayBuffer}
 */
function base64ToArrayBuffer(b64) {
  const binary = atob(String(b64 || ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/**
 * 生成合成任务去重 key(含引擎/音色/语速:换引擎后旧任务不再复用)
 * @param {string} bid 书 id
 * @param {number} chIdx 章节序号
 * @param {number} sIdx 段序号
 * @param {string} eng 引擎 id
 * @param {string} vo 音色 id
 * @param {number} rt 语速
 * @returns {string}
 */
function makeSegKey(bid, chIdx, sIdx, eng, vo, rt) {
  return `${bid}:${chIdx}:${sIdx}:${eng}:${vo}:${rt}`
}

export const usePlayerStore = defineStore('player', () => {
  // ===== 状态 =====
  /** 可用 TTS 引擎列表 */
  const engines = ref([])
  /** 当前引擎 id */
  const engineId = ref('')
  /** 当前音色 id */
  const voice = ref('')
  /** 语速 */
  const rate = ref(1)
  /** 播放状态机 */
  const status = ref('idle')
  /** 当前书 id */
  const bookId = ref(null)
  /** 当前章节序号 */
  const chapterIdx = ref(-1)
  /** 当前段序号(章内) */
  const segIdx = ref(-1)
  /** 当前章段总数 */
  const segsTotal = ref(0)
  /** 最近一次错误信息(可读) */
  const lastError = ref('')

  /** 引擎列表是否已拉取过 */
  let enginesLoaded = false
  /** 缓存索引是否已初始化 */
  let cacheReady = false
  /** 播放中的段(用于 tick 取 text / paraIdx) */
  let currentSeg = null
  /** 引擎私有配置(OpenAI 的 baseURL / apiKey / model)—— 来自 settings.json */
  const engineConfig = ref({ baseURL: '', apiKey: '', model: '' })

  // ===== 歌词中枢联动(t12,DESIGN §9)=====

  /**
   * 取当前段文本与下一句文本(来自当前章 segs 数组,不重复请求数据源)
   * @returns {{lineText: string, nextText: string}}
   */
  function currentTexts() {
    const idx = segIdx.value
    const cur = idx >= 0 && idx < chapterSegs.length ? chapterSegs[idx] : null
    const next = idx >= 0 && idx + 1 < chapterSegs.length ? chapterSegs[idx + 1] : null
    return {
      lineText: cur && typeof cur.text === 'string' ? cur.text : '',
      nextText: next && typeof next.text === 'string' ? next.text : '',
    }
  }

  /**
   * 组装播放状态载荷
   * @returns {{status: string, bookId: string|null, chapterIdx: number, segIdx: number, lineText: string, nextText: string, engineId: string, voice: string, rate: number}}
   */
  function buildStatePayload() {
    const { lineText, nextText } = currentTexts()
    return {
      status: status.value,
      bookId: bookId.value,
      chapterIdx: chapterIdx.value,
      segIdx: segIdx.value,
      lineText,
      nextText,
      engineId: engineId.value,
      voice: voice.value,
      rate: rate.value,
    }
  }

  /**
   * 推送播放状态给主进程(带 500ms 节流)
   *
   * 节流语义(标准 throttle:leading + trailing):
   *   - 距上次发送 ≥ STATE_PUSH_THROTTLE_MS → 立即发送(leading);
   *   - 窗口内的后续调用**不立即发送**,只暂存最新载荷;
   *   - 窗口结束时用最新载荷补发一次(trailing)——保证「暂停」这类窗口内的
   *     状态变更最终也能送达歌词窗 / 托盘,不会永久丢失;
   *   - immediate=true(stop / error 等关键状态)→ 跳过节流立即发送。
   *
   * @param {object} [opts] 选项
   * @param {boolean} [opts.immediate] 立即发送(跳过节流),用于 stop / error 等关键状态
   * @returns {void}
   */
  function pushState(opts) {
    const immediate = !!(opts && opts.immediate)
    // preload 就绪较晚时补一次订阅尝试(幂等:成功后不再重复)
    ensureControlSubscription()
    const payload = buildStatePayload()
    const now = Date.now()
    const elapsed = now - lastStatePushAt

    if (immediate) {
      // 关键状态:取消待补发,立刻发当前状态
      if (pendingStateTimer) {
        clearTimeout(pendingStateTimer)
        pendingStateTimer = null
      }
      pendingStatePayload = null
      lastStatePushAt = now
      sendStateToMain(payload)
      return
    }

    if (elapsed >= STATE_PUSH_THROTTLE_MS) {
      // 窗口已过:发当前载荷(leading);取消可能的待补发定时器
      if (pendingStateTimer) {
        clearTimeout(pendingStateTimer)
        pendingStateTimer = null
      }
      pendingStatePayload = null
      lastStatePushAt = now
      sendStateToMain(payload)
      return
    }

    // 窗口内:本次不发送(500ms 节流),只保留最新载荷,窗口结束时补发
    pendingStatePayload = payload
    if (pendingStateTimer) return
    pendingStateTimer = setTimeout(() => {
      pendingStateTimer = null
      const pending = pendingStatePayload
      pendingStatePayload = null
      if (!pending) return
      lastStatePushAt = Date.now()
      sendStateToMain(pending)
    }, STATE_PUSH_THROTTLE_MS - elapsed)
  }

  /**
   * 处理主进程下发的播放控制指令(DESIGN §9 反向控制;菜单栏按钮组同样经此通道)
   * @param {string} action 'toggle' | 'next' | 'prev' | 'stop' | 'bookmark'
   * @returns {void}
   */
  function handleControlAction(action) {
    switch (action) {
      case 'toggle':
        if (status.value === 'playing') {
          pause()
        } else {
          resume()
        }
        break
      case 'next':
        nextSeg()
        break
      case 'prev':
        prevSeg()
        break
      case 'stop':
        stop()
        break
      case 'bookmark':
        bookmarkCurrent()
        break
      default:
        // 未知动作 → 忽略
        break
    }
  }

  /**
   * 菜单栏书签按钮:给当前播放位置加一条书签(重复位置主进程幂等返回已存在书签)
   * @returns {Promise<void>}
   */
  async function bookmarkCurrent() {
    const seg = currentSeg
    if (!seg || !bookId.value) {
      ElMessage.warning(i18n.global.t('reader.bookmarkNeedPlaying'))
      return
    }
    try {
      const bookmarks = useBookmarksStore()
      await bookmarks.add({
        bookId: bookId.value,
        chapterIdx: chapterIdx.value,
        paraIdx: seg.paraIdx,
        excerpt: String(seg.text || '').slice(0, 60),
      })
      ElMessage.success(i18n.global.t('reader.bookmarkAdded'))
      logAction('player.bookmark', `菜单栏书签:第 ${chapterIdx.value + 1} 章第 ${seg.paraIdx + 1} 段`)
    } catch (err) {
      ElMessage.error(`${i18n.global.t('common.error')}: ${toMessage(err)}`)
    }
  }

  // 注册控制指令处理器 + 订阅(模块级 once,避免重复订阅)
  controlHandlerRef = handleControlAction
  ensureControlSubscription()

  // ===== 偏好持久化(localStorage:UI 小数据) =====
  /**
   * 读取播放器偏好
   * @returns {{engineId?: string, voice?: string, rate?: number}|null}
   */
  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PLAYER_PREFS_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * 写入播放器偏好(失败不抛:偏好存不下不应阻断播放)
   * @returns {void}
   */
  function savePrefs() {
    try {
      localStorage.setItem(
        PLAYER_PREFS_KEY,
        JSON.stringify({ engineId: engineId.value, voice: voice.value, rate: rate.value }),
      )
    } catch {
      // 忽略写入失败(隐私模式 / 配额)
    }
  }

  // 启动即恢复语速(引擎/音色需等引擎列表回来后校验)
  const bootPrefs = loadPrefs()
  if (bootPrefs && Number.isFinite(Number(bootPrefs.rate)) && Number(bootPrefs.rate) > 0) {
    rate.value = Number(bootPrefs.rate)
  }

  /**
   * 确保缓存索引已初始化(扫描 OPFS 重建 LRU 索引)
   * @returns {Promise<void>}
   */
  async function ensureCacheReady() {
    if (cacheReady) return
    await initCache()
    cacheReady = true
  }

  /**
   * 拉取引擎列表并确定默认引擎/音色
   * @returns {Promise<void>}
   */
  async function initEngines() {
    if (enginesLoaded) return
    const res = await invoke('tts:engines')
    const list = Array.isArray(res.engines) ? res.engines : []
    engines.value = list
    enginesLoaded = true

    // 引擎私有配置(baseURL / apiKey / model)—— 合成时下发
    await loadEngineConfig()

    // 纠错规则就绪(合成前应用;加载失败不阻断,按无规则处理)
    try {
      const corrections = useCorrectionsStore()
      await corrections.load()
    } catch {
      /* 规则加载失败时合成通道按原文本处理 */
    }

    // 默认引擎:第一个 available 且 !needsKey(PLAN §4.3「兜底优先」)
    const fallback =
      list.find((e) => e && e.available && !e.needsKey) ||
      list.find((e) => e && e.available) ||
      list[0] ||
      null

    const prefs = loadPrefs()
    // 优先用已保存的引擎(仍在列表中才有效)
    let chosen = fallback
    if (prefs && prefs.engineId) {
      const saved = list.find((e) => e && e.id === prefs.engineId)
      if (saved) chosen = saved
    }
    engineId.value = chosen ? String(chosen.id) : ''

    // 默认音色:优先语言匹配界面语言的音色(voices[0] 按字母序常是英文音色,
    // 英文音色读中文会逐字拼读);已保存音色仍有效则沿用,
    // 但若保存音色语言不匹配且存在匹配音色(旧版默认逻辑残留的英文音色)→ 纠偏
    const voices = chosen && Array.isArray(chosen.voices) ? chosen.voices : []
    let chosenVoice = pickDefaultVoice(voices)
    if (prefs && prefs.voice) {
      const savedVoice = voices.find((v) => v && String(v.id) === String(prefs.voice))
      if (savedVoice) {
        const matchedVoice = voices.find((v) => voiceMatchesLocale(v))
        chosenVoice =
          matchedVoice && !voiceMatchesLocale(savedVoice) ? String(matchedVoice.id) : String(savedVoice.id)
      }
    }
    voice.value = chosenVoice
    savePrefs()
  }

  /**
   * 拉取引擎私有配置(OpenAI 的 baseURL / apiKey / model)
   * 引擎配置存在主进程 settings.json(PLAN §4.12),合成时必须随请求下发,
   * 否则用户在设置页填的 key 不会生效。
   * @returns {Promise<void>}
   */
  async function loadEngineConfig() {
    try {
      const res = await invoke('settings:get', {})
      const openai = (res && res.settings && res.settings.engines && res.settings.engines.openai) || {}
      engineConfig.value = {
        baseURL: String(openai.baseURL || ''),
        apiKey: String(openai.apiKey || ''),
        model: String(openai.model || ''),
      }
    } catch {
      /* 配置读取失败按未配置处理(引擎会给出可读错误) */
    }
  }

  /**
   * 取某段音频:先查缓存 → miss 则合成 → 写入缓存
   *
   * 合成失败重试 1 次(PLAN §4.3「单段重试 1 次 → 仍失败则暂停播放并提示」);
   * 重试仍失败 → throw,由调用方置 status='error' + lastError。
   * @param {{segIdx: number, paraIdx: number, text: string}} seg 分段
   * @returns {Promise<{blob: Blob, mime: string}>}
   */
  async function fetchOrSynthesize(seg) {
    await ensureCacheReady()
    // 合成通道纠错(PLAN §4.7):替换后文本参与合成与缓存 key
    const corrections = useCorrectionsStore()
    // 朗读清洗:移除引号/书名号/括号/markdown 残留/装饰符号(部分引擎会把符号读成名称),
    // 清洗后文本参与合成与缓存 key → 含符号读法的旧缓存自动失效重合成
    const synthText = cleanForSpeech(corrections.applyCorrections(seg.text, bookId.value || ''))
    const hash = await cacheKey(engineId.value, voice.value, rate.value, synthText, corrections.version)
    // 缓存命中 → 直接回(重复收听零成本)
    const cached = await cacheGet(hash)
    if (cached) return cached
    // 缓存 miss → 调引擎合成(失败重试 1 次)
    let res = null
    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        res = await invoke('tts:synthesize', {
          engineId: engineId.value,
          text: synthText,
          voice: voice.value,
          rate: rate.value,
          // 需要 key 的引擎(OpenAI 兼容):下发设置页配置的 baseURL / apiKey / model
          apiKey: engineConfig.value.apiKey || undefined,
          baseURL: engineConfig.value.baseURL || undefined,
          model: engineConfig.value.model || undefined,
        })
        lastErr = null
        break
      } catch (err) {
        lastErr = err
      }
    }
    if (lastErr) throw lastErr
    const buffer = base64ToArrayBuffer(res.audio)
    const mime = res.mime || 'audio/mpeg'
    await cachePut(hash, buffer, mime)
    // 缓存写满时按 LRU 淘汰
    await evictIfNeeded()
    return { blob: new Blob([buffer], { type: mime }), mime }
  }

  /**
   * 取某段音频(带并发去重:同段并发只合成一次)
   * @param {{segIdx: number, paraIdx: number, text: string}} seg 分段
   * @param {string} key 去重 key
   * @returns {Promise<{blob: Blob, mime: string}>}
   */
  function ensureAudio(seg, key) {
    const inflight = queue.get(key)
    if (inflight) return inflight
    const task = fetchOrSynthesize(seg)
    queue.set(key, task)
    const cleanup = () => {
      if (queue.get(key) === task) queue.delete(key)
    }
    task.then(cleanup, cleanup)
    return task
  }

  /**
   * 取(或创建)全局 audio 单例,并绑定事件
   * @returns {HTMLAudioElement}
   */
  function getAudio() {
    if (!audioEl) {
      audioEl = new Audio()
      audioEl.preload = 'auto'
      audioEl.addEventListener('timeupdate', handleTimeUpdate)
      audioEl.addEventListener('ended', handleEnded)
      audioEl.addEventListener('error', handleAudioError)
    }
    return audioEl
  }

  /**
   * 取备用 audio 单例:当前段播放期间静默预载下一段(gapless 无缝切换)。
   * 备用元素只 load 不 play;ended 后与主元素交换身份,预载内容立即出声。
   * @returns {HTMLAudioElement}
   */
  function getStandby() {
    if (!standbyEl) {
      standbyEl = new Audio()
      standbyEl.preload = 'auto'
      standbyEl.dataset.segIdx = ''
      // gapless 切换后备用元素会与主元素交换身份、成为主播放元素,
      // 必须绑定与主元素完全相同的事件,否则第二段播完 ended 无人监听 → 卡住不续播
      standbyEl.addEventListener('timeupdate', handleTimeUpdate)
      standbyEl.addEventListener('ended', handleEnded)
      standbyEl.addEventListener('error', handleAudioError)
    }
    return standbyEl
  }

  /**
   * 把下一段音频预加载到备用元素(无缝切换的前提):
   * blob 已预合成 → 直接建 URL 加载;还在合成 → 完成后补加载。
   * @returns {void}
   */
  function primeNext() {
    if (!standbyEl) getStandby()
    const nextIdx = segIdx.value + 1
    const next = chapterSegs[nextIdx]
    if (!next) return
    if (standbyEl.dataset.segIdx === String(nextIdx) && standbyEl.src) return
    const ready = prefetchBlobs.get(nextIdx)
    if (ready) {
      standbyEl.dataset.segIdx = String(nextIdx)
      standbyEl.src = URL.createObjectURL(ready.blob)
      standbyEl.load()
      return
    }
    // 未就绪 → 与 startCurrent 的预合成共用同一 inflight,完成后补加载
    ensureAudio(next, makeSegKey(bookId.value, chapterIdx.value, nextIdx, engineId.value, voice.value, rate.value))
      .then((audio) => {
        prefetchBlobs.set(nextIdx, audio)
        // 用户可能已 seek/换章:仍指向同一段才预载
        if (standbyEl && segIdx.value + 1 === nextIdx && chapterSegs[nextIdx] === next) {
          standbyEl.dataset.segIdx = String(nextIdx)
          standbyEl.src = URL.createObjectURL(audio.blob)
          standbyEl.load()
        }
      })
      .catch(() => {})
  }

  /**
   * 播放某段音频(换 src 复用 audio 单例)
   * @param {{segIdx: number, paraIdx: number, text: string}} seg 分段
   * @param {{blob: Blob, mime: string}} audio 音频数据
   * @returns {void}
   */
  function playAudio(seg, audio) {
    const el = getAudio()
    currentSeg = seg
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl)
      currentObjectUrl = ''
    }
    currentObjectUrl = URL.createObjectURL(audio.blob)
    el.src = currentObjectUrl
    el.currentTime = 0
    status.value = 'playing'
    pushState()
    const p = el.play()
    // 自动播放策略拒绝时不算致命错误:状态仍为 playing,由用户手势恢复
    if (p && typeof p.catch === 'function') p.catch(() => {})
    // 播放期间把下一段预载到备用元素(段切换无缝衔接)
    primeNext()
  }

  /**
   * 启动当前段:并发预合成 [cur, cur+3],当前段就绪即播放
   * @returns {Promise<void>}
   */
  async function startCurrent() {
    const seg = chapterSegs[segIdx.value]
    if (!seg) {
      status.value = 'idle'
      return
    }
    const token = (playToken += 1)
    status.value = 'loading'
    const bid = bookId.value
    const chIdx = chapterIdx.value
    const key = (i) => makeSegKey(bid, chIdx, i, engineId.value, voice.value, rate.value)

    // 清理已被播过的过期预取(seek 后 Map 里可能残留旧段)
    for (const k of prefetchBlobs.keys()) {
      if (k < segIdx.value) prefetchBlobs.delete(k)
    }
    // 当前段(等待)+ 后续 N 段(后台并发预合成,完成后进 prefetchBlobs 供无缝切换)
    const curPromise = ensureAudio(seg, key(segIdx.value))
    for (let i = 1; i <= PREFETCH_AHEAD; i += 1) {
      const nextIdx = segIdx.value + i
      const next = chapterSegs[nextIdx]
      if (!next) break
      // 预合成失败不打断当前播放(下一段真正需要时再报错)
      ensureAudio(next, key(nextIdx))
        .then((audio) => {
          // 换章/重排后旧预取作废:只收录仍指向同一段的
          if (chapterSegs[nextIdx] === next) prefetchBlobs.set(nextIdx, audio)
        })
        .catch(() => {})
    }

    try {
      const audio = await curPromise
      // 等待期间可能已切段/换引擎:令牌不一致 → 丢弃过期结果
      if (token !== playToken) return
      playAudio(seg, audio)
    } catch (err) {
      if (token !== playToken) return
      status.value = 'error'
      lastError.value = toMessage(err)
      pushState({ immediate: true })
    }
  }

  /**
   * 发出一次 tick:推给主进程(歌词) + 通知订阅者(阅读器高亮)+ 同步阅读进度
   * @returns {void}
   */
  async function emitTick() {
    const seg = currentSeg
    if (!seg) return
    const idx = seg.segIdx
    const nextSegObj = chapterSegs[idx + 1] || null
    const el = audioEl
    const duration = el && Number.isFinite(el.duration) ? el.duration : 0
    const currentTime = el ? el.currentTime : 0
    const ratio = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0

    // 1) 推给主进程 → 歌词窗 / 托盘 / 状态栏(M2 调用,M3 消费)
    invoke('lyric:tick', {
      bookId: bookId.value,
      chapterIdx: chapterIdx.value,
      segIdx: seg.segIdx,
      segOffsetRatio: ratio,
      lineText: seg.text,
      nextText: nextSegObj ? nextSegObj.text : '',
    }).catch(() => {
      // 歌词推送失败不打断播放
    })

    // 2) 通知本 store 的订阅者(阅读器高亮 / 滚动居中)
    const payload = {
      bookId: bookId.value,
      chapterIdx: chapterIdx.value,
      paraIdx: seg.paraIdx,
      segIdx: seg.segIdx,
      segOffsetRatio: ratio,
      lineText: seg.text,
    }
    for (const cb of [...tickListeners]) {
      try {
        cb(payload)
      } catch {
        // 单个订阅者异常不影响其他订阅者
      }
    }

    // 3) 听书进度 = 阅读进度(同步到书库 store)
    try {
      const books = useBooksStore()
      books.savePosition(bookId.value, chapterIdx.value, seg.paraIdx)
    } catch {
      // 位置同步失败不打断播放
    }

    // 4) 每章时长埋点(播放中 → listen):5 秒一个刻度
    try {
      await invoke('stats:chapter-tick', {
        bookId: bookId.value,
        chapterIdx: chapterIdx.value,
        sec: 5,
        kind: 'listen',
      })
    } catch {
      // 埋点失败不打断播放
    }
  }

  /**
   * timeupdate 处理器(≥250ms 节流)
   * @returns {void}
   */
  function handleTimeUpdate() {
    const now = Date.now()
    if (now - lastTickAt < TICK_THROTTLE_MS) return
    lastTickAt = now
    // async 函数:内部 await 的失败已被各自 try/catch 消化
    emitTick()
  }

  /**
   * 段播完 → 下一段
   * @returns {void}
   */
  function handleEnded() {
    // 无缝优先:备用元素已预载下一段 → 交换元素立即续播
    // (间隙 <10ms,替代原「换 src + 重新解码」的 ~150ms 静默——听感的"段落间停顿")
    const nextIdx = segIdx.value + 1
    const next = chapterSegs[nextIdx]
    if (next && standbyEl && standbyEl.dataset.segIdx === String(nextIdx) && standbyEl.src) {
      const finishedEl = audioEl
      const staleUrl = currentObjectUrl
      audioEl = standbyEl
      standbyEl = finishedEl
      currentObjectUrl = audioEl.src
      finishedEl.pause()
      finishedEl.removeAttribute('src')
      if (staleUrl) setTimeout(() => URL.revokeObjectURL(staleUrl), 1000)
      segIdx.value = nextIdx
      currentSeg = chapterSegs[nextIdx]
      status.value = 'playing'
      pushState()
      const p = audioEl.play()
      if (p && typeof p.catch === 'function') p.catch(() => {})
      emitTick()
      primeNext()
      return
    }
    nextSeg()
  }

  /**
   * 音频错误 → 重试 1 次,仍失败则 status='error'
   * @returns {void}
   */
  function handleAudioError() {
    const seg = currentSeg
    if (!seg) {
      status.value = 'error'
      lastError.value = 'AUDIO_ERROR'
      pushState({ immediate: true })
      return
    }
    const key = makeSegKey(
      bookId.value,
      chapterIdx.value,
      segIdx.value,
      engineId.value,
      voice.value,
      rate.value,
    )
    if (retriedKey === key) {
      status.value = 'error'
      lastError.value = 'AUDIO_ERROR'
      pushState({ immediate: true })
      return
    }
    retriedKey = key
    // 重试:删除可能损坏的缓存条目,强制重新合成该段(绕过合成去重表)
    status.value = 'loading'
    const token = (playToken += 1)
    ;(async () => {
      try {
        const hash = await cacheKey(engineId.value, voice.value, rate.value, seg.text)
        await cacheRemove(hash)
        const audio = await fetchOrSynthesize(seg)
        if (token !== playToken) return
        retriedKey = ''
        playAudio(seg, audio)
      } catch (err) {
        if (token !== playToken) return
        status.value = 'error'
        lastError.value = toMessage(err)
        pushState({ immediate: true })
      }
    })()
  }

  /**
   * 载入某章并切到指定段
   * @param {string} bid 书 id
   * @param {number} chIdx 章节序号
   * @param {number} targetSegIdx 目标段序号(章内)
   * @returns {Promise<void>}
   */
  async function loadChapterAt(bid, chIdx, targetSegIdx) {
    const books = useBooksStore()
    const chapter = await books.readChapter(bid, chIdx)
    const segs = segmentParagraphs((chapter && chapter.paragraphs) || [])
    chapterSegs = segs
    // 换章后旧章预取作废:standby 复位,等 startCurrent→primeNext 重新预载
    prefetchBlobs.clear()
    if (standbyEl) {
      standbyEl.removeAttribute('src')
      standbyEl.dataset.segIdx = ''
    }
    bookId.value = bid
    chapterIdx.value = chIdx
    segsTotal.value = segs.length
    if (!segs.length) {
      status.value = 'error'
      lastError.value = 'CHAPTER_EMPTY'
      pushState({ immediate: true })
      return
    }
    const idx = Math.min(Math.max(0, targetSegIdx), segs.length - 1)
    segIdx.value = idx
    await startCurrent()
  }

  /**
   * 从某章某段开始播放(阅读器「从此处播放」/ 双击段落 / 书签跳转入口)
   * @param {string} bid 书 id
   * @param {number} chIdx 章节序号
   * @param {number} paraIdx 段落序号(定位到首个 paraIdx ≥ paraIdx 的段)
   * @returns {Promise<void>}
   */
  async function playFrom(bid, chIdx, paraIdx) {
    try {
      await initEngines()
      const books = useBooksStore()
      const chapter = await books.readChapter(bid, chIdx)
      const segs = segmentParagraphs((chapter && chapter.paragraphs) || [])
      chapterSegs = segs
      bookId.value = bid
      chapterIdx.value = chIdx
      segsTotal.value = segs.length
      if (!segs.length) {
        status.value = 'error'
        lastError.value = 'CHAPTER_EMPTY'
        pushState({ immediate: true })
        return
      }
      // 定位:首个 paraIdx ≥ 目标段落号的段;都小于则取最后一段
      let idx = segs.findIndex((s) => s.paraIdx >= paraIdx)
      if (idx < 0) idx = segs.length - 1
      segIdx.value = idx
      await startCurrent()
    } catch (err) {
      status.value = 'error'
      lastError.value = toMessage(err)
      pushState({ immediate: true })
    }
  }

  /**
   * 下一段(章尾自动跨章)
   * @returns {Promise<void>}
   */
  async function nextSeg() {
    const next = segIdx.value + 1
    if (next < chapterSegs.length) {
      segIdx.value = next
      await startCurrent()
      return
    }
    // 章尾 → 下一章(读不到就是全书结束)
    const bid = bookId.value
    const nxt = chapterIdx.value + 1
    try {
      await loadChapterAt(bid, nxt, 0)
    } catch {
      status.value = 'idle'
      pushState()
    }
  }

  /**
   * 上一段(章首自动跨章反向)
   * @returns {Promise<void>}
   */
  async function prevSeg() {
    const prev = segIdx.value - 1
    if (prev >= 0 && chapterSegs.length) {
      segIdx.value = prev
      await startCurrent()
      return
    }
    const bid = bookId.value
    const prv = chapterIdx.value - 1
    if (prv < 0) {
      // 本章第一段 → 回到本章开头
      if (chapterSegs.length) {
        segIdx.value = 0
        await startCurrent()
      }
      return
    }
    try {
      const books = useBooksStore()
      const chapter = await books.readChapter(bid, prv)
      const segs = segmentParagraphs((chapter && chapter.paragraphs) || [])
      if (!segs.length) {
        status.value = 'error'
        lastError.value = 'CHAPTER_EMPTY'
        pushState({ immediate: true })
        return
      }
      chapterSegs = segs
      chapterIdx.value = prv
      segsTotal.value = segs.length
      segIdx.value = segs.length - 1
      await startCurrent()
    } catch {
      status.value = 'idle'
      pushState()
    }
  }

  /**
   * 跳转到指定章 / 段
   * @param {number} chIdx 章节序号
   * @param {number} sIdx 段序号(章内)
   * @returns {Promise<void>}
   */
  async function seekSeg(chIdx, sIdx) {
    try {
      await loadChapterAt(bookId.value, chIdx, sIdx)
    } catch (err) {
      status.value = 'error'
      lastError.value = toMessage(err)
      pushState({ immediate: true })
    }
  }

  /**
   * 暂停
   * @returns {void}
   */
  function pause() {
    logAction('player.pause', '暂停播放')
    if (!audioEl) return
    audioEl.pause()
    if (status.value === 'playing') status.value = 'paused'
    pushState()
  }

  /**
   * 继续播放
   * @returns {void}
   */
  function resume() {
    logAction('player.resume', '继续播放')
    const el = getAudio()
    const p = el.play()
    status.value = 'playing'
    pushState()
    if (p && typeof p.catch === 'function') p.catch(() => {})
  }

  /**
   * 停止播放(保留当前位置)
   * @returns {void}
   */
  function stop() {
    logAction('player.stop', '停止播放(退出听书)')
    if (audioEl) {
      audioEl.pause()
      audioEl.removeAttribute('src')
      audioEl.load()
    }
    if (standbyEl) {
      standbyEl.pause()
      standbyEl.removeAttribute('src')
      standbyEl.load()
      standbyEl.dataset.segIdx = ''
    }
    prefetchBlobs.clear()
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl)
      currentObjectUrl = ''
    }
    currentSeg = null
    status.value = 'idle'
    // stop 是关键状态 → 立即推送(不受 500ms 节流限制)
    pushState({ immediate: true })
  }

  // ===== 音色语言匹配(默认音色选择) =====

  /**
   * 音色语言是否与界面语言匹配(zh_CN / zh-CN-x → zh ↔ navigator.language=zh-CN)。
   * @param {{id: string, lang?: string}} voice
   * @returns {boolean}
   */
  function voiceMatchesLocale(voice) {
    const sys = String(navigator.language || '').split('-')[0].toLowerCase()
    if (!sys) return false
    const lang = String((voice && voice.lang) || '').split(/[-_]/)[0].toLowerCase()
    return lang === sys
  }

  /**
   * 默认音色:优先选语言与界面语言匹配的音色。
   * say 等系统引擎的音色列表按字母序返回,voices[0] 常是英文音色(Albert),
   * 英文音色读中文会逐字拼读(有声音但不是正文内容)。
   * @param {{id: string, lang?: string}[]} voices
   * @returns {string} 音色 id(无匹配时回落 voices[0])
   */
  function pickDefaultVoice(voices) {
    if (!Array.isArray(voices) || voices.length === 0) return ''
    // 精确 locale 匹配优先(zh-CN ↔ zh_CN),避免 zh_TW(繁体)排在 zh_CN(简体)前
    const sysLocale = String(navigator.language || '').toLowerCase().replace(/-/g, '_')
    if (sysLocale) {
      const exact = voices.find((v) => {
        const vl = String((v && v.lang) || '').toLowerCase().replace(/-/g, '_')
        return vl === sysLocale || vl.startsWith(sysLocale + '_')
      })
      if (exact) return String(exact.id)
    }
    const matched = voices.find((v) => voiceMatchesLocale(v))
    return String((matched || voices[0]).id)
  }

  /**
   * 换引擎:当前段起重排队列(缓存 key 自动 miss → 重新合成)
   * @param {string} id 引擎 id
   * @returns {void}
   */
  function setEngine(id) {
    logAction('player.setEngine', `切换引擎:${id}`)
    if (!id || id === engineId.value) return
    engineId.value = String(id)
    // 新引擎可能没有旧音色 → 回落到该引擎第一个音色
    const eng = engines.value.find((e) => e && e.id === engineId.value)
    const voices = eng && Array.isArray(eng.voices) ? eng.voices : []
    if (voices.length && !voices.some((v) => v && String(v.id) === String(voice.value))) {
      voice.value = pickDefaultVoice(voices)
    }
    savePrefs()
    pushState()
    restartIfActive()
  }

  /**
   * 换音色:当前段起重排队列
   * @param {string} v 音色 id
   * @returns {void}
   */
  function setVoice(v) {
    logAction('player.setVoice', `切换音色:${v}`)
    if (!v || v === voice.value) return
    voice.value = String(v)
    savePrefs()
    pushState()
    restartIfActive()
  }

  /**
   * 改语速:当前段起重排队列(缓存 key 含 rate → 自动 miss)
   * @param {number} r 语速
   * @returns {void}
   */
  function setRate(r) {
    logAction('player.setRate', `语速:${r}x`)
    const num = Number(r)
    if (!Number.isFinite(num) || num <= 0 || num === rate.value) return
    rate.value = num
    savePrefs()
    pushState()
    restartIfActive()
  }

  /**
   * 播放中变更引擎/音色/语速 → 从当前段起重排队列
   * @returns {void}
   */
  function restartIfActive() {
    if (status.value !== 'playing' && status.value !== 'paused' && status.value !== 'loading') return
    // 引擎/音色/语速变了 → 预取的旧引擎音频全部作废,standby 复位
    prefetchBlobs.clear()
    if (standbyEl) {
      standbyEl.removeAttribute('src')
      standbyEl.dataset.segIdx = ''
    }
    startCurrent()
  }

  /**
   * 订阅 tick(阅读器高亮 / 歌词跟随)
   * @param {(payload: {bookId: string, chapterIdx: number, paraIdx: number, segIdx: number, segOffsetRatio: number, lineText: string}) => void} cb 回调
   * @returns {() => void} 取消订阅函数
   */
  function onTick(cb) {
    if (typeof cb !== 'function') return () => {}
    tickListeners.add(cb)
    return () => {
      tickListeners.delete(cb)
    }
  }

  return {
    // 状态
    engines,
    engineId,
    voice,
    rate,
    status,
    bookId,
    chapterIdx,
    segIdx,
    segsTotal,
    lastError,
    // 动作
    initEngines,
    playFrom,
    pause,
    resume,
    stop,
    nextSeg,
    prevSeg,
    seekSeg,
    setEngine,
    setVoice,
    setRate,
    onTick,
  }
})

export default usePlayerStore
