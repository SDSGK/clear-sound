/**
 * Microsoft Edge 在线 TTS 引擎(PLAN §4.3,免费但非官方接口,可能失效)。
 *
 * 实现:msedge-tts 包(CJS)
 *   new MsEdgeTTS() → setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
 *   → toStream(text, prosody) 收集 Readable 数据块 → Buffer(mime audio/mpeg)
 *
 * 注意:msedge-tts 的 SSML 模板会把文本直接嵌入 XML,故此处先做 XML 转义。
 *
 * 依赖注入:公共工具由 engines/index.js 注入(避免循环依赖 + 保证 rollup 静态内联)。
 */

const ENGINE_ID = 'edge'

/**
 * 静态常见中文神经音色(12 个,≥6)。在线接口的完整音色列表需联网查询,
 * 此处给出稳定可用的常见中文音色,避免 UI 空列表。
 */
const EDGE_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓(普通话·女)', lang: 'zh-CN' },
  { id: 'zh-CN-YunxiNeural', label: '云希(普通话·男)', lang: 'zh-CN' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊(普通话·女)', lang: 'zh-CN' },
  { id: 'zh-CN-YunjianNeural', label: '云健(普通话·男·新闻)', lang: 'zh-CN' },
  { id: 'zh-CN-YunyangNeural', label: '云扬(普通话·男·新闻)', lang: 'zh-CN' },
  { id: 'zh-CN-XiaochenNeural', label: '晓辰(普通话·女)', lang: 'zh-CN' },
  { id: 'zh-CN-XiaohanNeural', label: '晓涵(普通话·女)', lang: 'zh-CN' },
  { id: 'zh-CN-XiaomoNeural', label: '晓墨(普通话·女)', lang: 'zh-CN' },
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼(粤语·女)', lang: 'zh-HK' },
  { id: 'zh-HK-HiuGaaiNeural', label: '曉佳(粤语·女)', lang: 'zh-HK' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻(台湾国语·女)', lang: 'zh-TW' },
  { id: 'zh-TW-YunJheNeural', label: '雲哲(台湾国语·男)', lang: 'zh-TW' },
]

/**
 * XML 转义(文本会嵌入 SSML)
 * @param {string} text
 * @returns {string}
 */
function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 创建 Edge 引擎实例
 * @param {object} utils 公共工具集合
 * @returns {object} 引擎
 */
function createEdgeEngine(utils) {
  const { normalizeText, normalizeRate, normalizeVolume, normalizePitch, SYNTH_TIMEOUT_MS } = utils

  /**
   * 列出音色(静态列表)
   * @returns {Promise<{id: string, label: string, lang: string}[]>}
   */
  async function listVoices() {
    return EDGE_VOICES.map((voice) => ({ ...voice }))
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
    const voice =
      typeof options.voice === 'string' && options.voice.trim()
        ? options.voice.trim()
        : EDGE_VOICES[0].id

    // 延迟 require:msedge-tts 依赖 axios/ws,主进程启动时无需立即加载
    const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts')

    const tts = new MsEdgeTTS()
    let timer = null
    try {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)

      const buffer = await new Promise((resolve, reject) => {
        const chunks = []
        let settled = false

        timer = setTimeout(() => {
          if (settled) return
          settled = true
          try {
            tts.close()
          } catch {
            // 连接可能已断开
          }
          reject(new Error(`Edge TTS 合成超时(${SYNTH_TIMEOUT_MS}ms)`))
        }, SYNTH_TIMEOUT_MS)

        const finish = (fn, value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          timer = null
          fn(value)
        }

        let readable
        try {
          readable = tts.toStream(escapeXml(text), {
            rate,
            pitch: `${pitch >= 0 ? '+' : ''}${pitch}%`,
            volume: Math.round(volume * 100),
          })
        } catch (err) {
          const message = err && err.message ? err.message : String(err)
          finish(reject, new Error(`Edge TTS 启动失败:${message}`))
          return
        }

        readable.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        readable.on('end', () => {
          finish(resolve, Buffer.concat(chunks))
        })
        readable.on('error', (err) => {
          const message = err && err.message ? err.message : String(err)
          finish(reject, new Error(`Edge TTS 合成失败:${message}`))
        })
        readable.on('close', () => {
          finish(resolve, Buffer.concat(chunks))
        })
      })

      if (!buffer.length) throw new Error('Edge TTS 合成结果为空')
      return { buffer, mime: 'audio/mpeg' }
    } catch (err) {
      if (err && err.message && err.message.startsWith('Edge TTS')) throw err
      const message = err && err.message ? err.message : String(err)
      throw new Error(`Edge TTS 合成失败:${message}`)
    } finally {
      if (timer) clearTimeout(timer)
      try {
        tts.close()
      } catch {
        // 连接可能已断开
      }
    }
  }

  return {
    id: ENGINE_ID,
    label: 'Edge 在线语音(免费)',
    offline: false,
    needsKey: false,
    isAvailable() {
      return true
    },
    listVoices,
    synthesize,
  }
}

module.exports = createEdgeEngine
module.exports.EDGE_VOICES = EDGE_VOICES
module.exports.escapeXml = escapeXml
