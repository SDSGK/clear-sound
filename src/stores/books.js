/**
 * books.js —— 书库 Pinia store(渲染层)
 *
 * 依据 docs/PLAN.md §4.12 / §4.14:
 *  - 书库元数据(标题/章节数/字数/进度)由主进程 JSON 承担 → IPC 'library:*'
 *  - 章节正文(段落数组)落 OPFS:'chapters/<bookId>/<idx>.json',主窗按需读取
 *
 * 对外约定:
 *  - 所有 IPC 调用失败一律 throw Error(带主进程返回的错误信息)
 *  - importFiles 单文件失败不中断其余,返回 { succeeded:[book], failed:[{ fileName, error }] }
 *  - savePosition 本地立即更新,IPC 侧节流 5s(leading + trailing 合并)
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { parseWebHtml } from '@/services/web-parser'
import readAsArrayBuffer from '@/utils/file-read'
import { logAction } from '@/utils/debug'
import { cleanBookTitle } from '@/utils/book-title'

/** 位置同步节流窗口(ms) */
const POSITION_THROTTLE_MS = 5000

/** 网页导入使用的格式标识 */
const WEB_FORMAT = 'web'

/** 网页导入使用的编码标识 */
const WEB_ENCODING = 'utf-8'

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
 * 统计一组段落的字符数
 * @param {string[]} paragraphs 段落数组
 * @returns {number}
 */
function countChars(paragraphs) {
  if (!Array.isArray(paragraphs)) return 0
  return paragraphs.reduce((sum, p) => sum + String(p == null ? '' : p).length, 0)
}

/**
 * 归一化时间戳(兼容数字 / 数字字符串 / ISO 字符串)
 * @param {unknown} value 原始时间
 * @returns {number} 毫秒时间戳(无法解析时为 0)
 */
function toTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const num = Number(value)
    if (Number.isFinite(num)) return num
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

/**
 * 归一化错误信息
 * @param {unknown} err 错误
 * @returns {string}
 */
function toMessage(err) {
  if (!err) return 'UNKNOWN_ERROR'
  if (typeof err === 'string') return err
  return err.message || String(err)
}

/**
 * 由章节数组组装 register 的 meta + wordCount
 * @param {{title?: string, format?: string, encoding?: string, author?: string, sourceUrl?: string}} base 基础字段
 * @param {{title: string, paragraphs: string[]}[]} chapters 章节数组
 * @returns {{ meta: object, wordCount: number }}
 */
function buildMeta(base, chapters) {
  const metaChapters = chapters.map((ch) => ({
    title: ch.title == null ? '' : String(ch.title),
    paragraphCount: Array.isArray(ch.paragraphs) ? ch.paragraphs.length : 0,
    charCount: countChars(ch.paragraphs),
  }))
  const wordCount = metaChapters.reduce((sum, c) => sum + c.charCount, 0)
  const meta = {
    title: cleanBookTitle(base.title),
    format: base.format || 'txt',
    encoding: base.encoding || WEB_ENCODING,
    chapters: metaChapters,
  }
  if (base.author) meta.author = String(base.author)
  if (base.sourceUrl) meta.sourceUrl = String(base.sourceUrl)
  // 文件体积(字节):书架展示「书的大小」
  if (Number.isFinite(base.sizeBytes) && base.sizeBytes > 0) meta.sizeBytes = base.sizeBytes
  return { meta, wordCount }
}

/**
 * 把章节正文交主进程落盘(userData/chapters/<bookId>/,manifest 一并更新)。
 * M5 架构调整:章节正文由主进程 fs 管理,渲染层不再写 OPFS
 * (OPFS 多窗口共享环境持续 InvalidStateError,详见 electron/library/ipc.js 注释)。
 */

export const useBooksStore = defineStore('books', () => {
  /** 书库列表(主进程 books.json 的内存副本) */
  const books = ref([])
  /** 是否正在加载 */
  const loading = ref(false)

  // ===== 位置同步节流状态 =====
  let positionTimer = null
  let pendingPosition = null
  let lastPositionSentAt = 0

  /**
   * 把待同步位置发给主进程
   * @returns {void}
   */
  function flushPosition() {
    if (!pendingPosition) return
    const payload = pendingPosition
    pendingPosition = null
    lastPositionSentAt = Date.now()
    invoke('library:update-position', {
      bookId: payload.bookId,
      lastPosition: { chapterIdx: payload.chapterIdx, segIdx: payload.segIdx },
    }).catch((err) => {
      // 位置同步失败不打断阅读;下次保存会覆盖
      console.warn('[books] update-position 失败:', toMessage(err))
    })
  }

  /**
   * 立即把待同步位置刷给主进程(窗口退出/组件卸载时调用)
   * @returns {void}
   */
  function flushPositionNow() {
    if (positionTimer) {
      clearTimeout(positionTimer)
      positionTimer = null
    }
    flushPosition()
  }

  /**
   * 从主进程拉取书库列表
   * @returns {Promise<void>}
   */
  async function load() {
    loading.value = true
    try {
      const res = await invoke('library:list')
      books.value = Array.isArray(res.books) ? res.books : []
    } finally {
      loading.value = false
    }
  }

  /**
   * 批量导入本地文件(txt/md/epub)
   * 条目支持两种形式:
   *  - File 对象(文件选择器路径,事件上下文内)
   *  - { name, buffer: ArrayBuffer }(拖拽路径,drop 上下文内已立即读取,
   *    规避跨 App 拖拽的 File 句柄延迟读取失效问题)
   * @param {Array<File|{name: string, buffer: ArrayBuffer}>} items 文件列表
   * @returns {Promise<{ succeeded: object[], failed: { fileName: string, error: string }[] }>}
   */
  async function importFiles(items) {
    const list = Array.from(items || [])
    const succeeded = []
    const failed = []
    for (const item of list) {
      const fileName = item && item.name ? item.name : 'unknown'
      try {
        // 三种条目:File(标准读取+FileReader 兜底)/ { name, buffer }(drop 内已读)/ { name, path }(Web 读取失败,主进程按路径代读)
        let res
        if (item && typeof item.path !== 'undefined' && item.path) {
          res = await invoke('library:parse-from-path', { filePath: item.path, fileName })
        } else {
          const buffer =
            item && typeof item.buffer !== 'undefined'
              ? item.buffer
              : await readAsArrayBuffer(item)
          res = await invoke('library:parse', { fileName, buffer })
        }
        const bookData = res.bookData || {}
        const chapters = Array.isArray(bookData.chapters) ? bookData.chapters : []
        const { meta, wordCount } = buildMeta(
          {
            title: bookData.title || fileName,
            format: bookData.format,
            encoding: bookData.encoding,
            author: bookData.author,
            sizeBytes: bookData.sizeBytes,
          },
          chapters,
        )
        const reg = await invoke('library:register', { meta, wordCount, chapters })
        if (reg.book) {
          succeeded.push(reg.book)
          logAction('book.import', `导入「${fileName}」→《${reg.book.title}》(${chapters.length} 章)`)
        }
      } catch (err) {
        failed.push({ fileName, error: toMessage(err) })
        logAction('book.importFailed', `导入「${fileName}」失败:${toMessage(err)}`)
      }
    }
    await load()
    return { succeeded, failed }
  }

  /** 文件名去扩展名 */
  function stripExt(name) {
    return String(name || '').replace(/\.(txt|md|markdown|mdown|epub)$/i, '')
  }

  /** 自然排序比较(第2章排在第10章之前) */
  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
  }

  /**
   * 合并导入:多个章节文件按文件名自然排序合并为【一本书】。
   * 每个文件解析一章(文件名即章题;文件内部有多章标记则继续拆分);
   * 全部成功才注册(任一失败即中止,返回 failed,不产生半成品)。
   * @param {Array<File|{name: string, buffer: ArrayBuffer}>} items 文件列表
   * @returns {Promise<{ book: object|null, failed: { fileName: string, error: string }[] }>}
   */
  async function importMergedFiles(items) {
    const list = Array.from(items || [])
    const failed = []
    if (list.length === 0) return { book: null, failed }
    const parsed = []
    for (const item of list) {
      const fileName = item && item.name ? item.name : 'unknown'
      try {
        const buffer =
          item && typeof item.buffer !== 'undefined'
            ? item.buffer
            : await readAsArrayBuffer(item)
        const res = await invoke('library:parse', { fileName, buffer })
        parsed.push({ fileName, bookData: res.bookData || {} })
      } catch (err) {
        failed.push({ fileName, error: toMessage(err) })
      }
    }
    if (parsed.length === 0) return { book: null, failed }
    parsed.sort((a, b) => naturalCompare(a.fileName, b.fileName))

    const chapters = []
    for (const item of parsed) {
      const fileChapters = Array.isArray(item.bookData.chapters) ? item.bookData.chapters : []
      // 单章兜底章题=书名(=文件名)时,用文件名做章题更直观
      if (
        fileChapters.length === 1 &&
        fileChapters[0].title === (item.bookData.title || stripExt(item.fileName))
      ) {
        chapters.push({
          title: stripExt(item.fileName),
          paragraphs: fileChapters[0].paragraphs || [],
        })
      } else {
        for (const ch of fileChapters) chapters.push(ch)
      }
    }
    if (chapters.length === 0) {
      failed.push({ fileName: parsed[0].fileName, error: 'NO_CONTENT' })
      return { book: null, failed }
    }

    const title = stripExt(parsed[0].fileName)
    const { meta, wordCount } = buildMeta(
      {
        title,
        format: parsed[0].bookData.format,
        encoding: parsed[0].bookData.encoding,
      },
      chapters,
    )
    const reg = await invoke('library:register', { meta, wordCount, chapters })
    logAction('book.mergeImport', `合并导入 ${parsed.length} 个文件 → 《${reg.book && reg.book.title}》(${chapters.length} 章)`)
    await load()
    return { book: reg.book, failed }
  }

  /**
   * 向已有书追加章节文件(一章一个文件,追加到末尾;阅读进度保留)。
   * @param {string} bookId 目标书 id
   * @param {Array<File|{name: string, buffer: ArrayBuffer}>} items 文件列表
   * @returns {Promise<{ added: number, failed: { fileName: string, error: string }[] }>}
   */
  async function appendFiles(bookId, items) {
    const list = Array.from(items || [])
    const failed = []
    const newChapters = []
    for (const item of list) {
      const fileName = item && item.name ? item.name : 'unknown'
      try {
        const buffer =
          item && typeof item.buffer !== 'undefined'
            ? item.buffer
            : await readAsArrayBuffer(item)
        const res = await invoke('library:parse', { fileName, buffer })
        const fileChapters = Array.isArray(res.bookData.chapters) ? res.bookData.chapters : []
        if (fileChapters.length === 1) {
          newChapters.push({
            title: stripExt(fileName),
            paragraphs: fileChapters[0].paragraphs || [],
          })
        } else {
          for (const ch of fileChapters) newChapters.push(ch)
        }
      } catch (err) {
        failed.push({ fileName, error: toMessage(err) })
      }
    }
    if (newChapters.length === 0) return { added: 0, failed }

    // 主进程统一追加(写文件/manifest/books.json 一次完成)
    const appendRes = await invoke('library:append-chapters', {
      bookId,
      chapters: newChapters.map((ch) => ({ title: ch.title, paragraphs: ch.paragraphs || [] })),
    })
    const targetBook = books.value.find((b) => b && b.id === bookId)
    logAction('book.appendChapters', `追加 ${appendRes.added} 章到《${targetBook ? targetBook.title : bookId}》`)
    await load()
    return { added: appendRes.added, failed }
  }

  /**
   * 导入网页文章(抓取 → Readability 抽正文 → 注册 → 写 OPFS)
   * @param {string} url 网页地址
   * @returns {Promise<object>} 注册后的 book
   */
  async function importUrl(url) {    const target = String(url == null ? '' : url).trim()
    if (!target) throw new Error('EMPTY_URL')
    const res = await invoke('library:fetch-page', { url: target })
    const { title, paragraphs } = parseWebHtml(res.html, target)
    const finalUrl = res.finalUrl || target
    const chapters = [{ title, paragraphs }]
    const { meta, wordCount } = buildMeta(
      { title: title || finalUrl, format: WEB_FORMAT, encoding: WEB_ENCODING, sourceUrl: finalUrl },
      chapters,
    )
    const reg = await invoke('library:register', { meta, wordCount, chapters })
    await load()
    return reg.book
  }

  /**
   * 新建空书(只有书名的目录):先建壳,再批量导入章节
   * @param {string} title 书名
   * @returns {Promise<object>} 新书(0 章)
   */
  async function createBook(title) {
    const name = String(title == null ? '' : title).trim()
    if (!name) throw new Error('EMPTY_TITLE')
    const reg = await invoke('library:register', {
      meta: { title: name, format: 'txt', encoding: 'UTF-8', chapters: [] },
      wordCount: 0,
    })
    const book = reg.book
    if (!book || !book.id) throw new Error('REGISTER_NO_BOOK_ID')
    books.value.unshift(book)
    logAction('book.create', `新建书《${name}》`)
    return book
  }

  /**
   * 删除某一章(主进程前移重排 + 元数据同步)
   * @param {string} bookId 书 id
   * @param {number} idx 章节序号
   * @returns {Promise<void>}
   */
  async function removeChapter(bookId, idx) {
    await invoke('library:remove-chapter', { bookId, idx })
    logAction('book.removeChapter', `删除章节 #${idx}(《${bookId}》)`)
    await load()
  }

  /**
   * 重命名某章(章节文件 / manifest / 书架元数据三处同步)
   * @param {string} bookId 书 id
   * @param {number} idx 章节下标
   * @param {string} title 新标题
   * @returns {Promise<void>}
   */
  /**
   * 更新某章:重命名 / 内容替换(可单选)
   * @param {string} bookId 书 id
   * @param {number} idx 章节下标
   * @param {{title?: string, paragraphs?: string[]}} patch 更新字段
   * @returns {Promise<void>}
   */
  async function updateChapter(bookId, idx, patch) {
    const payload = { bookId, idx }
    if (patch.title != null) payload.title = String(patch.title).trim()
    if (Array.isArray(patch.paragraphs)) payload.paragraphs = patch.paragraphs
    await invoke('library:update-chapter', payload)
    logAction('book.updateChapter', `修改章节 #${idx}${payload.title ? '(改名)' : '(内容替换)'}`)
    await load()
  }

  /**
   * 新建空章节(命名后可再「导入内容」替换该章正文)
   * @param {string} bookId 书 id
   * @param {string} title 章节标题
   * @returns {Promise<{ idx: number }>} 新章节下标
   */
  async function newEmptyChapter(bookId, title) {
    const name = String(title == null ? '' : title).trim()
    if (!name) throw new Error('EMPTY_TITLE')
    const manifest = await getManifest(bookId)
    const idx = manifest && Array.isArray(manifest.chapters) ? manifest.chapters.length : 0
    await invoke('library:append-chapters', {
      bookId,
      chapters: [{ title: name, paragraphs: [] }],
    })
    logAction('book.createChapter', `新建空章节「${name}」`)
    await load()
    return { idx }
  }

  /**
   * 重新抓取网页正文并覆盖(阅读进度保留)
   * @param {string} bookId 书 id
   * @returns {Promise<object>} 覆盖后的 book
   */
  async function refetch(bookId) {
    const book = books.value.find((b) => b && b.id === bookId)
    if (!book) throw new Error('BOOK_NOT_FOUND')
    if (!book.sourceUrl) throw new Error('BOOK_NO_SOURCE_URL')
    const res = await invoke('library:fetch-page', { url: book.sourceUrl })
    const { title, paragraphs } = parseWebHtml(res.html, book.title || book.sourceUrl)
    const chapters = [{ title, paragraphs }]
    const { meta, wordCount } = buildMeta(
      {
        title: title || book.title || book.sourceUrl,
        format: WEB_FORMAT,
        encoding: WEB_ENCODING,
        sourceUrl: book.sourceUrl,
      },
      chapters,
    )
    const reg = await invoke('library:register', { meta, wordCount, bookId, chapters })
    await load()
    return reg.book
  }

  /**
   * 移除书籍(主进程元数据 + OPFS 章节缓存)
   * @param {string} bookId 书 id
   * @returns {Promise<void>}
   */
  async function remove(bookId) {
    await invoke('library:remove', { bookId })
    logAction('book.remove', `移除书籍(${bookId})`)
    books.value = books.value.filter((b) => !b || b.id !== bookId)
  }

  /**
   * 读取某章正文段落
   * @param {string} bookId 书 id
   * @param {number} idx 章节序号
   * @returns {Promise<{ title: string, paragraphs: string[] }>}
   */
  async function readChapter(bookId, idx) {
    const res = await invoke('library:read-chapter', { bookId, idx })
    return res.data
  }

  /**
   * 读取章节清单
   * @param {string} bookId 书 id
   * @returns {Promise<{ chapters: { idx: number, title: string, paragraphCount: number, charCount: number }[] } | null>}
   */
  async function getManifest(bookId) {
    const res = await invoke('library:get-book', { bookId })
    const book = res.book
    if (!book) return null
    return {
      chapters: (book.chapters || []).map((c) => ({
        idx: c.idx,
        title: c.title,
        paragraphCount: c.paragraphCount,
        charCount: c.charCount,
      })),
    }
  }

  /**
   * 保存阅读位置(本地立即更新,主进程侧节流 5s)
   * @param {string} bookId 书 id
   * @param {number} chapterIdx 章节序号
   * @param {number} segIdx 段落序号
   * @returns {void}
   */
  function savePosition(bookId, chapterIdx, segIdx) {
    const book = books.value.find((b) => b && b.id === bookId)
    if (book) {
      book.lastPosition = { chapterIdx, segIdx }
    }
    pendingPosition = { bookId, chapterIdx, segIdx }
    const now = Date.now()
    const elapsed = now - lastPositionSentAt
    if (positionTimer) return
    if (elapsed >= POSITION_THROTTLE_MS) {
      flushPosition()
      return
    }
    positionTimer = setTimeout(() => {
      positionTimer = null
      flushPosition()
    }, POSITION_THROTTLE_MS - elapsed)
  }

  /** 书架列表(按加入时间降序的副本) */
  const shelfBooks = computed(() =>
    [...books.value].sort((a, b) => toTimestamp(b && b.addedAt) - toTimestamp(a && a.addedAt)),
  )

  return {
    books,
    loading,
    shelfBooks,
    load,
    importFiles,
    importMergedFiles,
    appendFiles,
    createBook,
    removeChapter,
    updateChapter,
    newEmptyChapter,
    importUrl,
    refetch,
    remove,
    readChapter,
    getManifest,
    savePosition,
    flushPositionNow,
  }
})

export default useBooksStore
