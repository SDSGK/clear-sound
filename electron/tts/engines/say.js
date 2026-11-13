/**
 * macOS `say` 引擎(PLAN §4.3,系统兜底引擎,零网络零 Key)。
 *
 * 流程:say(文本走 stdin,规避参数长度限制)→ AIFF → afconvert → m4a(aac)
 * 备注:macOS 14 上 `afconvert -f m4ff` 会报 ExtAudioFileCreateWithURL 失败,
 *      故先试 m4ff(规格指定格式),失败再退 m4af(Apple MPEG-4 Audio),仍失败则原样返回 AIFF。
 *
 * 依赖注入:公共工具由 engines/index.js 注入(避免与 index.js 形成循环依赖,
 * 同时保证 rollup 能静态分析并把实现内联进打包产物)。
 */

const ENGINE_ID = 'say'

/** 音色列表缓存(系统音色不会变,进程内缓存一次即可) */
let voicesCache = null

/**
 * 解析 `say -v '?'` 输出。
 * 行格式:`<Name><2+空格><lang><2+空格># <样本>`
 * 音色名可能含空格(如 `Bad News`、`Eddy (德语（德国）)`),故用 \s{2,} 切分。
 * @param {string} stdout
 * @returns {{id: string, label: string, lang: string}[]}
 */
function parseSayVoices(stdout) {
  const voices = []
  const lines = String(stdout || '').split(/\r?\n/)
  for (const line of lines) {
    const match = /^(.+?)\s{2,}([A-Za-z]{2,3}(?:[_-][A-Za-z0-9]+)*)\s+#\s/.exec(line)
    if (!match) continue
    const name = match[1].trim()
    const lang = match[2].trim()
    if (!name) continue
    voices.push({ id: name, label: name, lang })
  }
  return voices
}

/**
 * 系统语言码(如 zh-CN → zh)。
 * say 的音色列表按字母序返回,英文音色(Albert)排最前;默认选 voices[0] 会拿到
 * 英文音色,读中文会逐字拼读(有声音但不是正文内容,实测 20 字中文被读成 30 秒拼读)。
 * 故音色列表必须按系统语言重排:匹配语言优先,其余保持字母序。
 * @returns {string} 语言码,取不到返回空串
 */
function getRawSystemLocale() {
  try {
    // Electron 主进程:app.getLocale() 返回 OS 系统语言(macOS 偏好设置)。
    // Intl.DateTimeFormat 在 Node 里跟随 ICU/环境变量,实测返回 en-US,
    // 不反映系统真实语言 → 不能用它做音色排序依据。
    let locale = ''
    try {
      const { app } = require('electron')
      if (app && typeof app.getLocale === 'function') locale = app.getLocale()
    } catch {
      /* 非 Electron 环境(纯 node 测试)→ 走 Intl 兜底 */
    }
    if (!locale) {
      locale = new Intl.DateTimeFormat().resolvedOptions().locale
    }
    return String(locale || '')
  } catch {
    return ''
  }
}

/**
 * 系统语言码(如 zh-CN → zh)
 * @returns {string}
 */
function systemLangCode() {
  return getRawSystemLocale().split('-')[0].toLowerCase()
}

/**
 * 归一化系统 locale(如 zh-CN → zh_cn),用于精确匹配 zh_CN 音色
 * @returns {string}
 */
function systemLocaleCode() {
  return getRawSystemLocale().toLowerCase().replace(/-/g, '_')
}

/**
 * 音色排序分:精确 locale 匹配(简体中文 zh_CN)=0 < 同语言其他地区(zh_TW)=1 < 其他语言=2。
 * 只做语言级匹配会让 zh_TW(繁体)排在 zh_CN(简体)前(字母序),大陆用户默认音色不当。
 * @param {{id: string, lang?: string}} voice
 * @param {string} sysLocale 归一化系统 locale(如 zh_cn)
 * @param {string} sysLang 系统语言码(如 zh)
 * @returns {number}
 */
function voiceSortScore(voice, sysLocale, sysLang) {
  const vLocale = String((voice && voice.lang) || '').toLowerCase().replace(/-/g, '_')
  if (sysLocale && (vLocale === sysLocale || vLocale.startsWith(sysLocale + '_'))) return 0
  if (sysLang && voiceLangCode(voice) === sysLang) return 1
  return 2
}

/**
 * 音色语言码(zh_CN / zh-CN-XiaoxiaoNeural → zh)
 * @param {{id: string, lang?: string}} voice
 * @returns {string}
 */
function voiceLangCode(voice) {
  return String((voice && voice.lang) || '').split(/[-_]/)[0].toLowerCase()
}

/**
 * 创建 say 引擎实例
 * @param {object} utils 公共工具集合
 * @returns {object} 引擎
 */
function createSayEngine(utils) {
  const { normalizeText, normalizeRate, normalizeVolume, normalizePitch, makeTempPath, removeTempFiles, readFileBuffer, runProcess, SYNTH_TIMEOUT_MS } = utils

  /**
   * 列出系统音色
   * @returns {Promise<{id: string, label: string, lang: string}[]>}
   */
  async function listVoices() {
    if (voicesCache) return voicesCache
    try {
      const { stdout, code } = await runProcess('say', ['-v', '?'], { timeoutMs: 10000 })
      if (code !== 0) {
        voicesCache = []
        return voicesCache
      }
      const parsed = parseSayVoices(stdout)
      // 按系统语言重排:精确 locale(简体 zh_CN)> 同语言其他地区(zh_TW)> 其他语言
      // (否则 voices[0] 是英文音色,默认选它读中文会逐字拼读;
      //  只做语言级匹配又会让 zh_TW 排在 zh_CN 前,大陆用户默认音色不当)。
      // 稳定排序:同分音色保持原字母序。
      const sysLang = systemLangCode()
      const sysLocale = systemLocaleCode()
      if (sysLocale || sysLang) {
        const scored = parsed.map((v) => ({ v, s: voiceSortScore(v, sysLocale, sysLang) }))
        scored.sort((a, b) => a.s - b.s)
        voicesCache = scored.map((x) => x.v)
      } else {
        voicesCache = parsed
      }
    } catch {
      voicesCache = []
    }
    return voicesCache
  }

  /**
   * 语速倍率 → say 的「词/分钟」(say 默认 180 词/分)
   * @param {number} rate
   * @returns {number}
   */
  function rateToWordsPerMinute(rate) {
    const words = Math.round(180 * rate)
    if (words < 60) return 60
    if (words > 400) return 400
    return words
  }

  /**
   * 拼装 say 的嵌入式控制命令(音量/音调)
   * @param {number} volume 0 ~ 1
   * @param {number} pitch -50 ~ 50(相对百分比)
   * @returns {string}
   */
  function buildSayPrefix(volume, pitch) {
    const parts = []
    if (volume < 0.999) {
      const vol = Math.max(0, Math.min(1, volume))
      parts.push(`[[vol ${vol.toFixed(2)}]]`)
    }
    if (Math.abs(pitch) > 0.5) {
      const pbas = Math.round(50 + pitch)
      parts.push(`[[pbas ${Math.max(0, Math.min(100, pbas))}]]`)
    }
    return parts.length ? `${parts.join('')}\n` : ''
  }

  /**
   * 合成语音
   * @param {{text: string, voice?: string, rate?: number, pitch?: number, volume?: number}} options
   * @returns {Promise<{buffer: Buffer, mime: string}>}
   */
  async function synthesize(options = {}) {
    const text = normalizeText(options.text)
    const rate = normalizeRate(options.rate)
    const volume = normalizeVolume(options.volume)
    const pitch = normalizePitch(options.pitch)
    const voice = typeof options.voice === 'string' ? options.voice.trim() : ''

    const aiffPath = makeTempPath('.aiff')
    const m4aPath = makeTempPath('.m4a')
    try {
      const args = []
      if (voice) args.push('-v', voice)
      args.push('-r', String(rateToWordsPerMinute(rate)))
      args.push('--input-file=-')
      args.push('-o', aiffPath)

      const said = await runProcess('say', args, {
        input: buildSayPrefix(volume, pitch) + text,
        timeoutMs: SYNTH_TIMEOUT_MS,
      })
      if (said.code !== 0) {
        const detail = (said.stderr || said.stdout || '').trim().split(/\r?\n/).slice(-2).join(' ')
        throw new Error(`say 合成失败${detail ? `:${detail}` : `(退出码 ${said.code})`}`)
      }

      // afconvert:aac → m4a。macOS 14 的 m4ff 会失败,依次降级。
      const formats = ['m4ff', 'm4af']
      let converted = false
      let lastError = ''
      for (const format of formats) {
        const result = await runProcess('afconvert', ['-f', format, '-d', 'aac', aiffPath, m4aPath], {
          timeoutMs: SYNTH_TIMEOUT_MS,
        })
        if (result.code === 0) {
          converted = true
          break
        }
        lastError = (result.stderr || '').trim()
      }

      if (!converted) {
        // 转换彻底失败:退回 AIFF 原始音频(仍可播放)
        const buffer = readFileBuffer(aiffPath)
        return { buffer, mime: 'audio/aiff' }
      }

      const buffer = readFileBuffer(m4aPath)
      if (!buffer.length) throw new Error(`音频转换结果为空${lastError ? `:${lastError}` : ''}`)
      return { buffer, mime: 'audio/mp4' }
    } finally {
      removeTempFiles([aiffPath, m4aPath])
    }
  }

  return {
    id: ENGINE_ID,
    label: 'macOS 系统语音',
    offline: true,
    needsKey: false,
    isAvailable() {
      return process.platform === 'darwin'
    },
    listVoices,
    synthesize,
  }
}

module.exports = createSayEngine
module.exports.parseSayVoices = parseSayVoices
