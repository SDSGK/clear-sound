/**
 * tts-cache.js —— TTS 合成音频缓存(渲染层,OPFS + LRU)
 *
 * 依据 docs/PLAN.md §4.4 / §4.12:
 *  - TTS 合成音频属「大文件」→ 存 OPFS(navigator.storage.getDirectory),
 *    主进程零参与(不经 IPC 传大 buffer,只有 base64 往返一次)。
 *  - 缓存 key:PLAN 原文为 md5(engine|voice|rate|pitch|correctionVersion|text);
 *    本实现改用 **SHA-256**(crypto.subtle 内置,无需第三方包,抗碰撞更强、效果等同):
 *      参与串 = [engineId, voice, String(rate), 'v0', text].join('|')
 *      'v0' = correctionVersion 预留位(纠错规则版本;后续接入规则引擎时升级版本号
 *      即可让受影响的旧缓存自动失效并重合成)。
 *    注意:PLAN 里的 pitch 本版未开放(音调由引擎侧参数承载),故参与串不含 pitch。
 *
 * 存储布局(OPFS 内):
 *   tts/<hash>            音频二进制
 *   tts/<hash>.meta.json  { mime, bytes, mtime } —— 索引元数据,供 initCache 重建内存索引
 *
 * 内存索引 Map(hash → {bytes, lastUsed}) 用于 LRU 统计与淘汰;
 * lastUsed 在 get 命中时 touch 更新(访问即刷新,「最近最少使用」被淘汰)。
 */

import { ensureDir, listDir, readJSON, removeEntry, writeJSON } from '@/utils/vfs'

/** OPFS 内的缓存根目录 */
export const CACHE_DIR = 'tts'

/** 缓存上限(字节)—— 默认 500MB,超出按 LRU 淘汰 */
export const DEFAULT_CACHE_LIMIT_BYTES = 500 * 1024 * 1024

/** 纠错规则版本预留位(参与缓存 key) */
export const CORRECTION_VERSION = 'v0'

/** meta 文件后缀 */
const META_SUFFIX = '.meta.json'

/**
 * 内存索引:hash → { bytes, lastUsed }
 * (模块级,非响应式;跨 store 共享同一份缓存视图)
 * @type {Map<string, {bytes: number, lastUsed: number}>}
 */
const index = new Map()

/** 上限字节数(可调) */
let limitBytes = DEFAULT_CACHE_LIMIT_BYTES

/** 是否已初始化(避免重复扫描 OPFS) */
let initialized = false

/**
 * 把字节数组转成十六进制字符串
 * @param {Uint8Array} bytes 字节数组
 * @returns {string}
 */
function bytesToHex(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

/**
 * 计算缓存 key(SHA-256 hex)
 * @param {string} engineId 引擎 id
 * @param {string} voice 音色 id
 * @param {number|string} rate 语速
 * @param {string} text 合成文本(纠错应用后的文本)
 * @param {number|string} [correctionVersion] 纠错规则版本(默认 CORRECTION_VERSION 占位;
 *   M4 起由 player 传入真实版本,规则变更即强制重合成)
 * @returns {Promise<string>} 64 位十六进制 hash
 */
export async function cacheKey(engineId, voice, rate, text, correctionVersion = CORRECTION_VERSION) {
  const payload = [engineId, voice, String(rate), String(correctionVersion), text].join('|')
  const bytes = new TextEncoder().encode(payload)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return bytesToHex(new Uint8Array(digest))
}

/**
 * 音频文件在 OPFS 内的路径
 * @param {string} hash 缓存 hash
 * @returns {string}
 */
function audioPath(hash) {
  return `${CACHE_DIR}/${hash}`
}

/**
 * meta 文件在 OPFS 内的路径
 * @param {string} hash 缓存 hash
 * @returns {string}
 */
function metaPath(hash) {
  return `${CACHE_DIR}/${hash}${META_SUFFIX}`
}

/**
 * 取缓存目录句柄(目录不存在 → 抛 NotFoundError)
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function cacheDirHandle() {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(CACHE_DIR, { create: false })
}

/**
 * 读取某个缓存条目的音频二进制
 * @param {string} hash 缓存 hash
 * @returns {Promise<ArrayBuffer>} 不存在则抛错(由调用方兜底)
 */
async function readAudioBytes(hash) {
  const dir = await cacheDirHandle()
  const fileHandle = await dir.getFileHandle(hash, { create: false })
  const file = await fileHandle.getFile()
  return file.arrayBuffer()
}

/**
 * 写音频二进制到 OPFS
 * @param {string} hash 缓存 hash
 * @param {ArrayBuffer|Blob} data 音频数据
 * @returns {Promise<number>} 写入字节数
 */
async function writeAudio(hash, data) {
  const dir = await ensureDir(CACHE_DIR)
  const fileHandle = await dir.getFileHandle(hash, { create: true })
  const writable = await fileHandle.createWritable()
  let bytes = 0
  try {
    if (data instanceof Blob) {
      bytes = data.size
      await writable.write(data)
    } else {
      bytes = data.byteLength
      await writable.write(data)
    }
  } finally {
    await writable.close()
  }
  return bytes
}

/**
 * 初始化缓存:扫描 OPFS tts/ 目录的 .meta.json 重建内存索引
 * @returns {Promise<{count: number, bytes: number}>} 当前索引概况
 */
export async function initCache() {
  index.clear()
  const entries = await listDir(CACHE_DIR)
  for (const entry of entries) {
    if (!entry || entry.kind !== 'file') continue
    const name = entry.name
    if (!name.endsWith(META_SUFFIX)) continue
    const hash = name.slice(0, -META_SUFFIX.length)
    const meta = await readJSON(metaPath(hash))
    if (!meta) continue
    const bytes = Number(meta.bytes) || 0
    const lastUsed = Number(meta.mtime) || 0
    index.set(hash, { bytes, lastUsed })
  }
  initialized = true
  return cacheStats()
}

/**
 * 写入缓存(音频 + meta)
 * @param {string} hash 缓存 hash
 * @param {ArrayBuffer|Blob} data 音频二进制
 * @param {string} mime MIME 类型
 * @returns {Promise<void>}
 */
export async function put(hash, data, mime) {
  if (!hash) throw new Error('CACHE_INVALID_HASH')
  const bytes = await writeAudio(hash, data)
  const now = Date.now()
  await writeJSON(metaPath(hash), { mime: mime || 'audio/mpeg', bytes, mtime: now })
  index.set(hash, { bytes, lastUsed: now })
  initialized = true
}

/**
 * 读取缓存(命中时 touch 刷新 LRU 时间)
 * @param {string} hash 缓存 hash
 * @returns {Promise<{blob: Blob, mime: string}|null>} 未命中返回 null
 */
export async function get(hash) {
  if (!hash) return null
  let buffer = null
  try {
    buffer = await readAudioBytes(hash)
  } catch {
    // 文件缺失 / OPFS 未初始化 → 视为未命中
    buffer = null
  }
  if (!buffer) return null
  const meta = await readJSON(metaPath(hash))
  const mime = (meta && meta.mime) || 'audio/mpeg'
  const blob = new Blob([buffer])
  const now = Date.now()
  // 命中 → touch 刷新 LRU 时间(内存索引 + meta.mtime 持久化)
  index.set(hash, { bytes: blob.size, lastUsed: now })
  if (meta) {
    await writeJSON(metaPath(hash), { ...meta, mtime: now }).catch(() => {})
  }
  return { blob, mime }
}

/**
 * 删除某个缓存条目(音频 + meta)
 * @param {string} hash 缓存 hash
 * @returns {Promise<boolean>} 是否实际删除
 */
export async function remove(hash) {
  index.delete(hash)
  const a = await removeEntry(audioPath(hash))
  const m = await removeEntry(metaPath(hash))
  return a || m
}

/**
 * 统计缓存概况
 * @returns {{count: number, bytes: number}}
 */
export function cacheStats() {
  let bytes = 0
  for (const entry of index.values()) bytes += entry.bytes || 0
  return { count: index.size, bytes }
}

/**
 * 清空全部音频缓存(删除缓存目录下的所有文件)
 * @returns {Promise<number>} 已删除的文件数
 */
export async function clearAll() {
  const entries = await listDir(CACHE_DIR)
  let removed = 0
  for (const entry of entries) {
    if (entry.kind !== 'file') continue
    await removeEntry(`${CACHE_DIR}/${entry.name}`)
    removed += 1
  }
  index.clear()
  return removed
}

/**
 * 设置缓存上限字节数
 * @param {number} bytes 上限(字节)
 * @returns {number} 生效的上限
 */
export function setCacheLimit(bytes) {
  const num = Number(bytes)
  if (Number.isFinite(num) && num > 0) limitBytes = num
  return limitBytes
}

/**
 * LRU 淘汰:超上限时按 lastUsed 升序删除(最久未使用优先)
 * @param {number} [limit] 可选覆盖上限(字节)
 * @returns {Promise<{removed: number, freed: number}>} 本次淘汰结果
 */
export async function evictIfNeeded(limit) {
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : limitBytes
  let removed = 0
  let freed = 0
  let total = 0
  for (const entry of index.values()) total += entry.bytes || 0
  const entries = [...index.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  for (const [hash, meta] of entries) {
    if (total <= cap) break
    total -= meta.bytes || 0
    freed += meta.bytes || 0
    removed += 1
    index.delete(hash)
    await removeEntry(audioPath(hash)).catch(() => {})
    await removeEntry(metaPath(hash)).catch(() => {})
  }
  return { removed, freed }
}

/**
 * 是否已初始化过缓存索引
 * @returns {boolean}
 */
export function isCacheInitialized() {
  return initialized
}

export default {
  cacheKey,
  put,
  get,
  remove,
  initCache,
  evictIfNeeded,
  cacheStats,
  clearAll,
  setCacheLimit,
  isCacheInitialized,
}
