const { spawn } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

/**
 * TTS 引擎注册表 + 引擎公共工具(PLAN §4.3)。
 *
 * 排序策略:**系统兜底优先**(say / sapi)→ edge(免费在线)→ openai(需 Key)。
 * 依据 PLAN §4.3「默认引擎策略(兜底优先)」:出厂默认本地系统 TTS,零网络零 Key 永远可用。
 *
 * 引擎统一接口:
 *  - id / label / offline / needsKey
 *  - isAvailable(): boolean
 *  - listVoices(): Promise<Voice[]>,Voice = {id, label, lang?}
 *  - synthesize({text, voice, rate, pitch?, volume?, apiKey?, baseURL?}) → Promise<{buffer, mime}>
 *
 * 依赖结构(为打包正确性刻意设计):
 *  - 本文件**静态 require** 各引擎模块(字面量路径,rollup 可静态分析 → 实现会被内联进产物)
 *  - 各引擎模块导出**工厂函数** `createXxxEngine(utils)`,由本文件注入公共工具
 *  - 引擎模块**不反向 require 本文件**,因此不存在循环依赖
 */

// ===== 公共工具(注入给各引擎工厂)=====

/** 单次合成文本上限(字符) */
const MAX_TEXT_LENGTH = 5000

/** 单次合成超时(毫秒) */
const SYNTH_TIMEOUT_MS = 30000

/**
 * 校验并规范化文本
 * @param {unknown} text
 * @returns {string}
 */
function normalizeText(text) {
  if (typeof text !== 'string') throw new Error('合成文本为空或格式非法')
  const trimmed = text.trim()
  if (!trimmed) throw new Error('合成文本为空')
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw new Error(`合成文本过长(${trimmed.length} 字符,上限 ${MAX_TEXT_LENGTH})`)
  }
  return trimmed
}

/**
 * 规范化语速倍率(0.5 ~ 2,默认 1)
 * @param {unknown} rate
 * @returns {number}
 */
function normalizeRate(rate) {
  const value = Number(rate)
  if (!Number.isFinite(value) || value <= 0) return 1
  if (value < 0.5) return 0.5
  if (value > 2) return 2
  return value
}

/**
 * 规范化音量(0 ~ 1,默认 1)
 * @param {unknown} volume
 * @returns {number}
 */
function normalizeVolume(volume) {
  const value = Number(volume)
  if (!Number.isFinite(value) || value <= 0) return 1
  if (value > 1) return 1
  return value
}

/**
 * 规范化音调(相对值 -50 ~ 50,默认 0)
 * @param {unknown} pitch
 * @returns {number}
 */
function normalizePitch(pitch) {
  const value = Number(pitch)
  if (!Number.isFinite(value)) return 0
  if (value < -50) return -50
  if (value > 50) return 50
  return value
}

/**
 * 生成临时文件路径(独立子目录,便于批量清理)
 * @param {string} ext 扩展名,如 '.aiff'
 * @returns {string}
 */
function makeTempPath(ext) {
  const dir = path.join(os.tmpdir(), 'clear-sound-tts')
  fs.mkdirSync(dir, { recursive: true })
  const name = `cs-tts-${crypto.randomBytes(6).toString('hex')}${ext}`
  return path.join(dir, name)
}

/**
 * 尽力删除临时文件(忽略错误)
 * @param {string|string[]} targets
 */
function removeTempFiles(targets) {
  const list = Array.isArray(targets) ? targets : [targets]
  for (const target of list) {
    if (!target) continue
    try {
      fs.rmSync(target, { force: true })
    } catch {
      // 临时文件清理失败不影响主流程
    }
  }
}

/**
 * 读取文件为 Buffer
 * @param {string} filePath
 * @returns {Buffer}
 */
function readFileBuffer(filePath) {
  try {
    return fs.readFileSync(filePath)
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    throw new Error(`读取音频文件失败:${message}`)
  }
}

/**
 * 启动子进程并收集 stdout/stderr,支持超时强杀
 * @param {string} command
 * @param {string[]} args
 * @param {{input?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || SYNTH_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      const message = err && err.message ? err.message : String(err)
      reject(new Error(`启动 ${command} 失败:${message}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程可能已退出
      }
      settled = true
      reject(new Error(`${command} 合成超时(${timeoutMs}ms)`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const message = err && err.message ? err.message : String(err)
      reject(new Error(`执行 ${command} 失败:${message}`))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code === null ? -1 : code })
    })

    if (typeof options.input === 'string') {
      child.stdin.on('error', () => {
        // 子进程提前退出时忽略 EPIPE
      })
      child.stdin.end(options.input, 'utf8')
    } else {
      child.stdin.end()
    }
  })
}

/** 注入给各引擎工厂的公共工具集合 */
const UTILS = {
  MAX_TEXT_LENGTH,
  SYNTH_TIMEOUT_MS,
  normalizeText,
  normalizeRate,
  normalizeVolume,
  normalizePitch,
  makeTempPath,
  removeTempFiles,
  readFileBuffer,
  runProcess,
}

// ===== 引擎注册表 =====

// 静态 require(字面量路径)→ rollup/commonjs 插件可静态分析,实现会被内联进打包产物
const createSayEngine = require('./say')
const createSapiEngine = require('./sapi')
const createEdgeEngine = require('./edge')
const createOpenaiEngine = require('./openai')

/** 系统兜底引擎 id(排序时置前) */
const SYSTEM_FIRST = ['say', 'sapi']

/** 全部引擎实例(顺序即 UI 展示顺序:系统兜底优先 → edge → openai) */
const ENGINES = [
  createSayEngine(UTILS),
  createSapiEngine(UTILS),
  createEdgeEngine(UTILS),
  createOpenaiEngine(UTILS),
]

/**
 * 按优先级排序:系统引擎在前,其余保持注册顺序
 * @param {object[]} list
 * @returns {object[]}
 */
function sortEngines(list) {
  return [...list].sort((a, b) => {
    const aIndex = SYSTEM_FIRST.indexOf(a.id)
    const bIndex = SYSTEM_FIRST.indexOf(b.id)
    if (aIndex === -1 && bIndex === -1) return 0
    if (aIndex === -1) return 1
    if (bIndex === -1) return -1
    return aIndex - bIndex
  })
}

/**
 * 列出全部引擎(元信息,不含 voices)
 * @returns {{id: string, label: string, offline: boolean, needsKey: boolean, available: boolean}[]}
 */
function listEngineMetas() {
  return sortEngines(ENGINES).map((engine) => ({
    id: engine.id,
    label: engine.label,
    offline: engine.offline,
    needsKey: engine.needsKey,
    available: engine.isAvailable(),
  }))
}

/**
 * 列出全部引擎(含音色列表)
 * @returns {Promise<{id: string, label: string, offline: boolean, needsKey: boolean, available: boolean, voices: {id: string, label: string, lang?: string}[]}[]>}
 */
async function listEngines() {
  const metas = listEngineMetas()
  const results = await Promise.all(
    metas.map(async (meta) => {
      const engine = ENGINES.find((item) => item.id === meta.id)
      let voices = []
      if (engine && meta.available) {
        try {
          const list = await engine.listVoices()
          voices = Array.isArray(list) ? list : []
        } catch (err) {
          const message = err && err.message ? err.message : String(err)
          console.error(`[tts] 列出 ${meta.id} 音色失败:${message}`)
          voices = []
        }
      }
      return { ...meta, voices }
    })
  )
  return results
}

/**
 * 按 id 取引擎
 * @param {unknown} engineId
 * @returns {object|null}
 */
function getEngine(engineId) {
  if (typeof engineId !== 'string') return null
  return ENGINES.find((engine) => engine.id === engineId) || null
}

module.exports = {
  // 注册表
  ENGINES,
  SYSTEM_FIRST,
  listEngines,
  listEngineMetas,
  getEngine,
  sortEngines,
  // 公共工具(同时供引擎工厂使用)
  MAX_TEXT_LENGTH,
  SYNTH_TIMEOUT_MS,
  normalizeText,
  normalizeRate,
  normalizeVolume,
  normalizePitch,
  makeTempPath,
  removeTempFiles,
  readFileBuffer,
  runProcess,
}
