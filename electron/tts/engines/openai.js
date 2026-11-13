/**
 * OpenAI 兼容 TTS 引擎(PLAN §4.3,填 baseURL + key 即用)。
 *
 * 兼容 SiliconFlow / Groq / 自建网关等 OpenAI 兼容服务:
 *   POST `${baseURL}/v1/audio/speech`
 *   Authorization: Bearer <apiKey>
 *   { model, voice, input, speed, response_format:'mp3' }
 *
 * 依赖注入:公共工具由 engines/index.js 注入(避免循环依赖 + 保证 rollup 静态内联)。
 */

const ENGINE_ID = 'openai'

/** 默认服务地址 */
const DEFAULT_BASE_URL = 'https://api.openai.com'

/** 默认模型 */
const DEFAULT_MODEL = 'tts-1'

/** 静态音色列表 */
const OPENAI_VOICES = [
  { id: 'alloy', label: 'Alloy(中性·男)' },
  { id: 'echo', label: 'Echo(沉稳·男)' },
  { id: 'fable', label: 'Fable(叙事·男)' },
  { id: 'onyx', label: 'Onyx(低沉·男)' },
  { id: 'nova', label: 'Nova(明亮·女)' },
  { id: 'shimmer', label: 'Shimmer(柔和·女)' },
]

/**
 * 归一化 baseURL(去掉尾部斜杠)
 * @param {unknown} baseURL
 * @returns {string}
 */
function normalizeBaseURL(baseURL) {
  if (typeof baseURL !== 'string' || !baseURL.trim()) return DEFAULT_BASE_URL
  return baseURL.trim().replace(/\/+$/, '')
}

/**
 * 截取响应体摘要(用于错误信息)
 * @param {string} body
 * @returns {string}
 */
function summarizeBody(body) {
  const text = String(body || '').trim()
  if (!text) return '(空响应体)'
  const oneLine = text.replace(/\s+/g, ' ')
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine
}

/**
 * 创建 OpenAI 兼容引擎实例
 * @param {object} utils 公共工具集合
 * @returns {object} 引擎
 */
function createOpenaiEngine(utils) {
  const { normalizeText, normalizeRate, normalizeVolume, normalizePitch, SYNTH_TIMEOUT_MS } = utils

  /**
   * 列出音色(静态列表)
   * @returns {Promise<{id: string, label: string}[]>}
   */
  async function listVoices() {
    return OPENAI_VOICES.map((voice) => ({ ...voice }))
  }

  /**
   * 合成语音
   * @param {{text: string, voice?: string, rate?: number, pitch?: number, volume?: number, apiKey?: string, baseURL?: string, model?: string}} options
   * @returns {Promise<{buffer: Buffer, mime: string}>}
   */
  async function synthesize(options = {}) {
    const text = normalizeText(options.text)
    const rate = normalizeRate(options.rate)
    const volume = normalizeVolume(options.volume)
    const pitch = normalizePitch(options.pitch)
    const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : ''
    const baseURL = normalizeBaseURL(options.baseURL)
    const voice =
      typeof options.voice === 'string' && options.voice.trim()
        ? options.voice.trim()
        : OPENAI_VOICES[0].id
    const model =
      typeof options.model === 'string' && options.model.trim() ? options.model.trim() : DEFAULT_MODEL

    if (!apiKey) throw new Error('OpenAI 引擎缺少 API Key,请先在设置中填写')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SYNTH_TIMEOUT_MS)

    try {
      const response = await fetch(`${baseURL}/v1/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          voice,
          input: text,
          speed: rate,
          response_format: 'mp3',
          // volume/pitch 非 OpenAI 标准参数,仅在兼容网关支持时生效,不影响标准实现
          ...(pitch !== 0 ? { pitch } : {}),
          ...(volume !== 1 ? { volume } : {}),
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        if (response.status === 401 || response.status === 403) {
          throw new Error(`OpenAI Key 无效(HTTP ${response.status}):${summarizeBody(body)}`)
        }
        if (response.status === 400) {
          throw new Error(`参数被拒(HTTP 400):${summarizeBody(body)}`)
        }
        throw new Error(`OpenAI 合成失败(HTTP ${response.status}):${summarizeBody(body)}`)
      }

      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      if (!buffer.length) throw new Error('OpenAI 合成结果为空')
      return { buffer, mime: 'audio/mpeg' }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error(`OpenAI 合成超时(${SYNTH_TIMEOUT_MS}ms)`)
      }
      if (err && err.message && /^(OpenAI |参数被拒)/.test(err.message)) throw err
      const message = err && err.message ? err.message : String(err)
      throw new Error(`OpenAI 合成失败:${message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    id: ENGINE_ID,
    label: 'OpenAI 兼容语音',
    offline: false,
    needsKey: true,
    isAvailable() {
      return true
    },
    listVoices,
    synthesize,
  }
}

module.exports = createOpenaiEngine
module.exports.OPENAI_VOICES = OPENAI_VOICES
module.exports.normalizeBaseURL = normalizeBaseURL
module.exports.summarizeBody = summarizeBody
