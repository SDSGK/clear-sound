/**
 * Windows SAPI 引擎(PLAN §4.3,系统兜底引擎,零网络零 Key)。
 *
 * 流程:PowerShell + System.Speech → SetOutputToWaveFile(<tmp>.wav) → Speak → 读 wav
 * 转义:脚本以 UTF-16LE + Base64 走 `powershell -EncodedCommand`,彻底避免引号/编码转义问题。
 *
 * 依赖注入:公共工具由 engines/index.js 注入(避免循环依赖 + 保证 rollup 静态内联)。
 */

const ENGINE_ID = 'sapi'

/** 音色列表缓存 */
let voicesCache = null

/**
 * 解析 System.Speech 音色列表输出(制表符分隔)
 * @param {string} stdout
 * @returns {{id: string, label: string, lang?: string}[]}
 */
function parseSapiVoices(stdout) {
  const voices = []
  const lines = String(stdout || '').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split('\t')
    const name = (parts[0] || '').trim()
    if (!name) continue
    const lang = (parts[1] || '').trim()
    const description = (parts[2] || '').trim()
    voices.push({
      id: name,
      label: description ? `${name}(${description})` : name,
      ...(lang ? { lang } : {}),
    })
  }
  return voices
}

/**
 * PowerShell 命令以 UTF-16LE Base64 编码(规避命令行转义与编码坑)
 * @param {string} script
 * @returns {string}
 */
function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * 构造 PowerShell 脚本(枚举已安装音色)
 * @returns {string}
 */
function buildVoiceListScript() {
  return [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    '$s.GetInstalledVoices() | ForEach-Object {',
    '  $i = $_.VoiceInfo;',
    '  [Console]::Out.WriteLine($i.Name + "`t" + $i.Culture.Name + "`t" + $i.Description)',
    '}',
  ].join('\n')
}

/**
 * 构造合成脚本
 * @param {{text: string, voice: string, rate: number, volume: number, pitch: number, outPath: string}} params
 * @returns {string}
 */
function buildSpeakScript(params) {
  const { text, voice, rate, volume, pitch, outPath } = params
  // 文本通过 Base64 传入,彻底规避引号/换行转义
  const textB64 = Buffer.from(text, 'utf8').toString('base64')
  return [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    `$v = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${textB64}'));`,
    `$s.Rate = ${rate};`,
    `$s.Volume = ${volume};`,
    `$s.Pitch = ${pitch};`,
    voice ? `$s.SelectVoice('${voice.replace(/'/g, "''")}');` : '',
    `$s.SetOutputToWaveFile('${outPath.replace(/'/g, "''")}');`,
    '$s.Speak($v);',
    '$s.Dispose();',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 创建 SAPI 引擎实例
 * @param {object} utils 公共工具集合
 * @returns {object} 引擎
 */
function createSapiEngine(utils) {
  const { normalizeText, normalizeRate, normalizeVolume, normalizePitch, makeTempPath, removeTempFiles, readFileBuffer, runProcess, SYNTH_TIMEOUT_MS } = utils

  /**
   * 列出系统音色(仅 Windows 可用)
   * @returns {Promise<{id: string, label: string, lang?: string}[]>}
   */
  async function listVoices() {
    if (voicesCache) return voicesCache
    if (process.platform !== 'win32') {
      voicesCache = []
      return voicesCache
    }
    try {
      const { stdout, code } = await runProcess(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(buildVoiceListScript())],
        { timeoutMs: 15000 }
      )
      voicesCache = code === 0 ? parseSapiVoices(stdout) : []
    } catch {
      voicesCache = []
    }
    return voicesCache
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

    const wavPath = makeTempPath('.wav')
    try {
      const script = buildSpeakScript({ text, voice, rate, volume, pitch, outPath: wavPath })
      const result = await runProcess(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)],
        { timeoutMs: SYNTH_TIMEOUT_MS }
      )
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-3).join(' ')
        throw new Error(`SAPI 合成失败${detail ? `:${detail}` : `(退出码 ${result.code})`}`)
      }

      const buffer = readFileBuffer(wavPath)
      if (!buffer.length) throw new Error('SAPI 合成结果为空')
      return { buffer, mime: 'audio/wav' }
    } finally {
      removeTempFiles(wavPath)
    }
  }

  return {
    id: ENGINE_ID,
    label: 'Windows 系统语音(SAPI)',
    offline: true,
    needsKey: false,
    isAvailable() {
      return process.platform === 'win32'
    },
    listVoices,
    synthesize,
  }
}

module.exports = createSapiEngine
module.exports.parseSapiVoices = parseSapiVoices
module.exports.encodeCommand = encodeCommand
module.exports.buildSpeakScript = buildSpeakScript
