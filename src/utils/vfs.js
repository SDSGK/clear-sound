/**
 * vfs.js —— OPFS(Origin Private File System)封装(渲染层)
 *
 * 【M5 架构调整】章节正文已从 OPFS 迁回主进程 userData/chapters/
 * (fs 管理,见 electron/library/ipc.js 的 read-chapter/append-chapters/
 * remove-chapter 通道)—— OPFS 在多窗口共享环境下持续出现
 * InvalidStateError(句柄状态失效),且打包 file:// 存在兼容风险。
 * 本模块现仅服务于 TTS 合成音频缓存(PLAN §4.12 缓存部分)。
 *
 * 路径约定:以 '/' 分隔、相对 OPFS 根目录的路径,例如:
 *   'chapters/<bookId>/manifest.json'
 * 根目录写作 '/'。所有 API 均返回 Promise。
 */

/** 浏览器/渲染层是否支持 OPFS */
function opfsSupported() {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === 'function'
  )
}

/** 把路径切成片段(去掉空段,兼容首尾 '/') */
function toSegments(path) {
  if (typeof path !== 'string') return []
  return path
    .split('/')
    .map((seg) => seg.trim())
    .filter(Boolean)
}

/** 是否为「不存在」类错误 */
function isNotFound(err) {
  return !!err && (err.name === 'NotFoundError' || err.code === 8)
}

/** 取 OPFS 根目录句柄 */
async function getRoot() {
  if (!opfsSupported()) throw new Error('OPFS_UNSUPPORTED')
  return navigator.storage.getDirectory()
}

/**
 * 取某路径所在目录的句柄 + 最后一段名字
 * @param {string} path 相对路径
 * @returns {Promise<{dir: FileSystemDirectoryHandle, name: string|null}>} name 为 null 表示路径本身是根
 */
async function resolveParent(path) {
  const segs = toSegments(path)
  if (segs.length === 0) return { dir: await getRoot(), name: null }
  let dir = await getRoot()
  for (let i = 0; i < segs.length - 1; i += 1) {
    dir = await dir.getDirectoryHandle(segs[i], { create: false })
  }
  return { dir, name: segs[segs.length - 1] }
}

/**
 * 确保目录存在(逐级创建)
 * @param {string} dirPath 目录路径,如 'chapters/abc'
 * @returns {Promise<FileSystemDirectoryHandle>} 目录句柄
 */
export async function ensureDir(dirPath) {
  const segs = toSegments(dirPath)
  let dir = await getRoot()
  for (const seg of segs) {
    dir = await dir.getDirectoryHandle(seg, { create: true })
  }
  return dir
}

/** 判断是否为 OPFS 状态失效类错误(句柄/缓存状态过期,常见于高频写入竞态) */
function isInvalidState(err) {
  return (
    !!err &&
    (err.name === 'InvalidStateError' ||
      /state (had|has) changed since it was read from disk/i.test(String(err && err.message)))
  )
}

/**
 * 写文本文件(父目录自动创建,内容整体覆盖)。
 * OPFS 的 createWritable 在高频/跨窗口写入时偶发 InvalidStateError
 * (state had changed since it was read from disk),按退避重试 3 次。
 * @param {string} path 文件路径
 * @param {string} str 文本内容
 * @returns {Promise<string>} 实际写入的路径
 */
export async function writeText(path, str) {
  const segs = toSegments(path)
  if (segs.length === 0) throw new Error('VFS_INVALID_PATH')
  const dir = await ensureDir(segs.slice(0, -1).join('/'))
  const fileHandle = await dir.getFileHandle(segs[segs.length - 1], { create: true })
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const writable = await fileHandle.createWritable()
      try {
        await writable.write(str == null ? '' : String(str))
      } finally {
        await writable.close()
      }
      return path
    } catch (err) {
      lastErr = err
      if (!isInvalidState(err)) throw err
      await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)))
    }
  }
  throw lastErr
}

/**
 * 读文本文件
 * @param {string} path 文件路径
 * @returns {Promise<string|null>} 不存在返回 null
 */
export async function readText(path) {
  const segs = toSegments(path)
  if (segs.length === 0) return null
  try {
    const { dir, name } = await resolveParent(path)
    const fileHandle = await dir.getFileHandle(name)
    const file = await fileHandle.getFile()
    return await file.text()
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

/**
 * 写 JSON 文件
 * @param {string} path 文件路径
 * @param {unknown} obj 可序列化对象
 * @returns {Promise<string>} 实际写入的路径
 */
export async function writeJSON(path, obj) {
  return writeText(path, JSON.stringify(obj))
}

/**
 * 读 JSON 文件
 * @param {string} path 文件路径
 * @returns {Promise<object|null>} 不存在或内容损坏返回 null
 */
export async function readJSON(path) {
  const text = await readText(path)
  if (text == null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 取某路径「本身」的目录句柄(路径不存在则抛 NotFoundError)
 * @param {string} path 相对路径(空串或 '/' 表示根目录)
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function resolveDir(path) {
  const segs = toSegments(path)
  let dir = await getRoot()
  for (const seg of segs) {
    dir = await dir.getDirectoryHandle(seg, { create: false })
  }
  return dir
}

/**
 * 列出某目录下的直接子项
 * @param {string} path 目录路径(相对 OPFS 根;'' 或 '/' 表示根目录)
 * @returns {Promise<Array<{name: string, kind: 'file'|'dir'}>>}
 *   目录不存在 → 返回空数组
 */
export async function listDir(path) {
  let dir
  try {
    dir = await resolveDir(path)
  } catch (err) {
    // 目录不存在(还没建过)→ 空列表;其他错误上抛
    if (isNotFound(err)) return []
    throw err
  }
  const entries = []
  // entries() 返回异步迭代器 [name, handle];个别实现只有 values(),此时用 handle.name 兜底
  const iterator = typeof dir.entries === 'function' ? dir.entries() : dir.values()
  for await (const item of iterator) {
    const name = Array.isArray(item) ? item[0] : item && item.name ? item.name : ''
    const handle = Array.isArray(item) ? item[1] : item
    const rawKind = handle && typeof handle.kind === 'string' ? handle.kind : 'file'
    entries.push({ name, kind: rawKind === 'directory' ? 'dir' : 'file' })
  }
  return entries
}

/**
 * 删除文件或目录(目录递归删除)
 * @param {string} path 路径
 * @returns {Promise<boolean>} 是否实际删除了东西(目标不存在返回 false)
 */
export async function removeEntry(path) {
  const segs = toSegments(path)
  if (segs.length === 0) return false // 根目录不可删除
  try {
    const { dir, name } = await resolveParent(path)
    await dir.removeEntry(name, { recursive: true })
    return true
  } catch (err) {
    if (isNotFound(err)) return false
    throw err
  }
}

/**
 * 判断路径是否存在(文件或目录)
 * @param {string} path 路径
 * @returns {Promise<boolean>}
 */
export async function exists(path) {
  const segs = toSegments(path)
  if (segs.length === 0) return true
  try {
    const { dir, name } = await resolveParent(path)
    try {
      await dir.getFileHandle(name)
      return true
    } catch (err) {
      // 目标是目录:Chromium 抛 TypeMismatchError
      if (err && err.name === 'TypeMismatchError') return true
      if (!isNotFound(err)) throw err
    }
    try {
      await dir.getDirectoryHandle(name)
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  } catch (err) {
    if (isNotFound(err)) return false
    throw err
  }
}

export default {
  ensureDir,
  writeText,
  readText,
  writeJSON,
  readJSON,
  removeEntry,
  exists,
  listDir,
}
