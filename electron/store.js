const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/**
 * 主进程 JSON 存储(§4.12):
 *  - 内存单例 + 30s 防抖落盘 + 退出前 flush
 *  - 原子写:先写 <file>.tmp,再 rename 覆盖,避免半截文件写坏
 *  - 存储位置:userData/data/<fileName>
 */

/** 防抖时长:30s(PLAN §4.9/§4.12) */
const SAVE_DEBOUNCE_MS = 30 * 1000

/**
 * 解析 userData/data 目录;非 Electron 环境(自测脚本)退到临时目录,避免污染仓库
 *
 * 注意:主进程启动时已把 userData 固定为 appData/clear-sound(见 electron/data-dir.js),
 * 因此这里取到的就是稳定的用户数据目录 —— 不会再随启动环境在
 * Electron/clear-sound/temp 之间漂移,也不会因 temp 被系统清理而丢书。
 */
function resolveBaseDir() {
  try {
    const electron = require('electron')
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      return path.join(electron.app.getPath('userData'), 'data')
    }
  } catch {
    // 非 Electron 运行时:忽略
  }
  return path.join(os.tmpdir(), 'clear-sound-userdata', 'data')
}

/**
 * 单个 JSON 文件的读写器
 */
class JsonStore {
  /**
   * @param {string} fileName 文件名,如 'books.json'
   * @param {{baseDir?: string}} [options] baseDir 可覆盖数据目录(自测用)
   */
  constructor(fileName, options = {}) {
    if (!fileName) throw new Error('JsonStore 需要 fileName')
    this.fileName = fileName
    this.baseDir = options.baseDir || resolveBaseDir()
    this.filePath = path.join(this.baseDir, fileName)
    this.tmpPath = `${this.filePath}.tmp`
    /** @type {null|NodeJS.Timeout} */
    this._timer = null
    this._dirty = false
    this.data = this._read()
  }

  /** 读取磁盘内容;文件缺失返回空对象,JSON 损坏则备份为 .corrupt-* 后重建 */
  _read() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      return JSON.parse(raw)
    } catch (err) {
      const code = err && err.code
      if (code === 'ENOENT') return {}
      // JSON 解析失败:保留现场再从空数据开始
      // 注意:备份文件必须保留 —— 它是用户数据的唯一副本,不可再删。
      const backup = `${this.filePath}.corrupt-${Date.now()}`
      try {
        fs.renameSync(this.filePath, backup)
        console.error(`[store] ${this.fileName} JSON 损坏,已备份到 ${backup}(原文件已移走,请从备份恢复)`)
      } catch {
        // 备份失败也继续,不阻塞启动
        console.error(`[store] ${this.fileName} JSON 损坏且备份失败:${err && err.message}`)
      }
      return {}
    }
  }

  /**
   * 读取单个键
   * @param {string} key
   * @param {unknown} [defaultValue]
   * @returns {unknown}
   */
  get(key, defaultValue = undefined) {
    if (this.data && typeof this.data === 'object' && !Array.isArray(this.data)) {
      return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : defaultValue
    }
    return defaultValue
  }

  /**
   * 写入单个键(立即触发防抖落盘)
   * @param {string} key
   * @param {unknown} value
   * @returns {unknown} 写入后的值
   */
  set(key, value) {
    if (!this.data || typeof this.data !== 'object' || Array.isArray(this.data)) {
      this.data = {}
    }
    this.data[key] = value
    this.save()
    return value
  }

  /**
   * 整体读取(数组型文档用)
   * @returns {unknown}
   */
  getRaw() {
    return this.data
  }

  /**
   * 整体写入(数组型文档用),并触发防抖落盘
   * @param {unknown} value
   * @returns {unknown}
   */
  setRaw(value) {
    this.data = value
    this.save()
    return value
  }

  /**
   * 请求落盘(30s 防抖;连续调用只保留最后一次)。
   *
   * @param {{immediate?: boolean}} [options] immediate=true 时立刻落盘,
   *   用于「导入/删除书籍」这类用户明确期待立刻生效的关键写 —— 否则应用在
   *   防抖窗口内退出时,用户会看到「刚导入的书又没了」。
   * @returns {this}
   */
  save(options = {}) {
    this._dirty = true
    if (options && options.immediate) {
      if (this._timer) {
        clearTimeout(this._timer)
        this._timer = null
      }
      this._write()
      return this
    }
    if (this._timer) clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      this._timer = null
      this._write()
    }, SAVE_DEBOUNCE_MS)
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref()
    return this
  }

  /** 立即落盘(退出前 flush) */
  flushNow() {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this._write()
    return this
  }

  /** 原子写:tmp → rename */
  _write() {
    if (!this._dirty) return
    try {
      fs.mkdirSync(this.baseDir, { recursive: true })
      const payload = JSON.stringify(this.data, null, 2)
      const fd = fs.openSync(this.tmpPath, 'w')
      try {
        fs.writeFileSync(fd, payload, 'utf8')
        try {
          fs.fsyncSync(fd)
        } catch {
          // 某些文件系统不支持 fsync,忽略
        }
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(this.tmpPath, this.filePath)
      this._dirty = false
    } catch (err) {
      // 写盘失败:保留 _dirty(下次 save 会重试),并把错误抛给上层提示,
      // 不能静默丢弃 —— 否则用户会以为「导入成功了,刷新就没了」。
      this._dirty = true
      console.error(`[store] 写入失败 ${this.filePath}: ${err && err.message}`)
      if (typeof this.onWriteError === 'function') {
        try {
          this.onWriteError(err, this.filePath)
        } catch {
          /* 回调异常不影响主流程 */
        }
      }
      if (writeErrorHandler) {
        try {
          writeErrorHandler(err, this.filePath)
        } catch {
          /* 回调异常不影响主流程 */
        }
      }
    }
  }
}

/**
 * 全局写盘错误回调(由主进程注册)。
 *
 * 写盘失败必须让用户知道 —— 否则表现为「导入的书刷新就没了」,
 * 用户完全无从察觉数据其实没保存成功。
 * @type {null|((err: unknown, filePath: string) => void)}
 */
let writeErrorHandler = null

/**
 * 注册全局写盘错误回调
 * @param {null|((err: unknown, filePath: string) => void)} handler 回调
 * @returns {void}
 */
function setWriteErrorHandler(handler) {
  writeErrorHandler = typeof handler === 'function' ? handler : null
}

/** @type {Map<string, JsonStore>} */
const storeCache = new Map()

/**
 * 单例工厂:同名文件返回同一个 JsonStore 实例
 * @param {string} [fileName] 默认 'books.json'
 * @param {{baseDir?: string}} [options]
 * @returns {JsonStore}
 */
function getUserStore(fileName = 'books.json', options = {}) {
  const key = `${fileName}::${options.baseDir || ''}`
  if (!storeCache.has(key)) {
    storeCache.set(key, new JsonStore(fileName, options))
  }
  return storeCache.get(key)
}

/** 退出前把所有已缓存的 store 立即落盘 */
function flushAllStores() {
  for (const store of storeCache.values()) {
    try {
      store.flushNow()
    } catch (err) {
      console.error(`[store] flush 失败 ${store.filePath}: ${err && err.message}`)
    }
  }
}

module.exports = {
  JsonStore,
  getUserStore,
  flushAllStores,
  setWriteErrorHandler,
  SAVE_DEBOUNCE_MS,
}
