const crypto = require('node:crypto')
const fs = require('node:fs')
const nodePath = require('node:path')
const { parseBook } = require('./parser')
const { fetchPage } = require('./web-fetch')
const { getUserStore } = require('../store')
const { logAction, logError } = require('../debug-log')
const { cleanBookTitle } = require('./title')

/**
 * 书库 IPC 通道(PLAN §7):
 *  全部 ipcMain.handle 统一返回 {ok: true, ...} 或 {ok: false, error: '可读错误'}
 *
 * 通道清单:
 *  - library:parse         {fileName, buffer(ArrayBuffer)} → {ok, bookData}
 *  - library:parse-from-path {filePath, fileName?}          → {ok, bookData}(拖拽文件 Web 读取受限时由主进程代读)
 *  - library:register      {meta, wordCount, bookId?, chapters?} → {ok, book}(chapters 提供时由主进程落盘正文)
 *  - library:read-chapter  {bookId, idx}                  → {ok, data:{title, paragraphs}}
 *  - library:append-chapters {bookId, chapters}            → {ok, added, chapters}(追加到末尾并重排 manifest)
 *  - library:remove-chapter {bookId, idx}                  → {ok, chapters}(删除该章,后续前移)
 *  - library:fetch-page    {url}                         → {ok, html, finalUrl}
 *  - library:register      {meta, wordCount, bookId?}     → {ok, book}
 *  - library:list                                          → {ok, books}
 *  - library:get-book      {bookId}                      → {ok, book}
 *  - library:remove        {bookId}                      → {ok}
 *  - library:update-position {bookId, lastPosition}       → {ok}
 */

/** 本模块注册的全部通道(供 preload 白名单对齐参考) */
const LIBRARY_CHANNELS = [
  'library:parse',
  'library:parse-from-path',
  'library:read-chapter',
  'library:append-chapters',
  'library:remove-chapter',
  'library:update-chapter',
  'library:fetch-page',
  'library:register',
  'library:list',
  'library:get-book',
  'library:remove',
  'library:update-position',
]

/** 书目默认进度 */
function defaultLastPosition() {
  return { chapterIdx: 0, segIdx: 0 }
}

// ============================================================
// 章节正文文件存储(userData/chapters/<bookId>/,主进程 fs 管理)
// M5 起:章节正文从渲染层 OPFS 迁回主进程 —— OPFS 在多窗口共享环境下
// 持续出现 InvalidStateError(句柄状态失效),且打包 file:// 存在兼容风险;
// fs 直读直写稳定可靠,单章文件小(KB 级),IPC 传输成本可忽略。
// ============================================================

/** 某书章节目录(userData/chapters/<bookId>) */
function chapterDir(bookId) {
  const { app } = require('electron')
  return nodePath.join(app.getPath('userData'), 'chapters', String(bookId))
}

function ensureChapterDir(bookId) {
  const dir = chapterDir(bookId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 写章节文件(idx 从 startIdx 起) */
function writeChapterFiles(bookId, startIdx, chapters) {
  const dir = ensureChapterDir(bookId)
  chapters.forEach((ch, i) => {
    const idx = startIdx + i
    fs.writeFileSync(
      nodePath.join(dir, `${idx}.json`),
      JSON.stringify({ title: String(ch.title || ''), paragraphs: Array.isArray(ch.paragraphs) ? ch.paragraphs : [] }),
    )
  })
}

/** 读 manifest(不存在返回 {chapters: []}) */
function readManifestFile(bookId) {
  const p = nodePath.join(chapterDir(bookId), 'manifest.json')
  if (!fs.existsSync(p)) return { chapters: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    return parsed && Array.isArray(parsed.chapters) ? parsed : { chapters: [] }
  } catch {
    return { chapters: [] }
  }
}

/** 写 manifest */
function writeManifestFile(bookId, manifestChapters) {
  const dir = ensureChapterDir(bookId)
  fs.writeFileSync(nodePath.join(dir, 'manifest.json'), JSON.stringify({ chapters: manifestChapters }))
}

/** 删除整本书的章节目录 */
function removeChapterDir(bookId) {
  const dir = chapterDir(bookId)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

/**
 * 读取书库数组(books.json 顶层为数组)
 * @param {import('../store').JsonStore} store
 * @returns {object[]}
 */
function loadBooks(store) {
  const raw = store.getRaw()
  return Array.isArray(raw) ? raw : []
}

/**
 * 章节下标自愈:补齐存量书库里缺失的 idx。
 *
 * 早期 buildBookFields 未把 idx 落盘,导致存量书的章节没有 idx:
 * 渲染层 `chapter.idx + 1` = NaN(目录整片显示 NaN),
 * emit('select', undefined) 又让阅读器定位不到章节(正文空)。
 *
 * @param {object[]} books 书库数组(原地修改)
 * @returns {boolean} 是否发生了补齐(调用方据此决定是否落盘)
 */
function healChapterIdx(books) {
  let changed = false
  for (const book of books) {
    if (!book || !Array.isArray(book.chapters)) continue
    book.chapters.forEach((chapter, index) => {
      if (!chapter || typeof chapter !== 'object') return
      if (Number.isInteger(chapter.idx)) return
      chapter.idx = index
      changed = true
    })
  }
  return changed
}

/**
 * 写回书库数组
 * @param {import('../store').JsonStore} store
 * @param {object[]} books
 */
/**
 * 保存书库。
 *
 * 导入/追加/重命名/删除章节/删书都是用户明确期待「立刻生效」的操作,
 * 必须**立即落盘** —— 否则应用在防抖窗口(30s)内重启(dev 下改 electron/ 即重启主进程),
 * 用户会看到「刚导入的书刷新就没了」。
 *
 * 阅读进度是高频写(每几秒一次),保持防抖,避免频繁全量写盘。
 *
 * @param {import('../store').JsonStore} store 书库 store
 * @param {unknown[]} books 书籍数组
 * @param {{immediate?: boolean}} [options] immediate=false 时走防抖(默认 true)
 * @returns {void}
 */
function saveBooks(store, books, options = {}) {
  const immediate = options.immediate !== false
  store.setRaw(books)
  store.save({ immediate })
}

/**
 * 从 meta 构造书籍记录的可写字段
 * @param {object} meta
 * @param {number} wordCount
 * @returns {object}
 */
function buildBookFields(meta, wordCount) {
  const source = meta || {}
  const chapters = Array.isArray(source.chapters)
    ? source.chapters.map((chapter, index) => {
        const item = chapter || {}
        return {
          // 章节下标必须落盘:渲染层用 chapter.idx 取序号与跳转目标,
          // 缺失时 `chapter.idx + 1` = NaN(目录显示 NaN),
          // emit('select', undefined) 又会让阅读器定位不到任何章节(正文空)。
          idx: index,
          title: typeof item.title === 'string' && item.title ? item.title : `第 ${index + 1} 节`,
          paragraphCount: Number.isFinite(item.paragraphCount) ? item.paragraphCount : 0,
          charCount: Number.isFinite(item.charCount) ? item.charCount : 0,
        }
      })
    : []

  const fields = {
    // 书名清洗:去掉《》等书名号(存储层统一处理,任何注册路径都干净)
    title: cleanBookTitle(source.title) || '未知书籍',
    format: typeof source.format === 'string' && source.format ? source.format : 'txt',
    encoding: typeof source.encoding === 'string' && source.encoding ? source.encoding : 'UTF-8',
    chapters,
    wordCount: Number.isFinite(wordCount) ? wordCount : 0,
  }

  if (typeof source.author === 'string' && source.author) fields.author = source.author
  if (typeof source.sourceUrl === 'string' && source.sourceUrl) fields.sourceUrl = source.sourceUrl
  // 文件体积(字节):书架展示「书的大小」
  if (Number.isFinite(source.sizeBytes) && source.sizeBytes > 0) fields.sizeBytes = source.sizeBytes
  return fields
}

/**
 * 统计某本书的章节文件占用体积(字节)。
 * @param {string} bookId 书 id
 * @returns {number} 字节数(取不到返回 0)
 */
function computeBookSizeBytes(bookId) {
  const dir = chapterDir(String(bookId))
  let total = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      try {
        total += fs.statSync(nodePath.join(dir, entry.name)).size
      } catch {
        /* 单个文件取不到就跳过 */
      }
    }
  } catch {
    return 0
  }
  return total
}

/**
 * 为缺少 sizeBytes 的旧书补算体积(一次性,写回 books.json)。
 *
 * 旧书导入时还没记录文件大小,这里按已落盘的章节文件总大小回填,
 * 书架就能显示「书的大小」而无需重新导入。
 * @returns {boolean} 是否发生变更
 */
function backfillBookSizes() {
  const store = getUserStore('books.json')
  const books = loadBooks(store)
  let changed = false
  for (const book of books) {
    if (!book || !book.id) continue
    if (Number.isFinite(book.sizeBytes) && book.sizeBytes > 0) continue
    const size = computeBookSizeBytes(book.id)
    if (size > 0) {
      book.sizeBytes = size
      changed = true
    }
  }
  if (changed) saveBooks(store, books)
  return changed
}

/**
 * 创建全部通道的业务处理函数(与 Electron 解耦,便于自测)
 * @param {{store?: import('../store').JsonStore}} [deps]
 * @returns {Record<string, (payload: object) => Promise<object>>}
 */
function createLibraryHandlers(deps = {}) {
  /** 取书库 store(注入优先,否则用单例) */
  function getStore() {
    if (deps.store) return deps.store
    return getUserStore('books.json')
  }

  return {
    /** 解析文件正文(渲染层拿到后自行写 OPFS) */
    async 'library:parse'(payload) {
      logAction('library.parse', `解析文件:${(payload && payload.fileName) || '-'}`)
      const fileName = typeof payload.fileName === 'string' ? payload.fileName : ''
      if (!fileName) throw new Error('缺少 fileName')
      const buffer = payload.buffer
      if (!buffer) throw new Error('缺少 buffer')
      const bookData = await parseBook({ fileName, buffer })
      return {
        ok: true,
        bookData: {
          title: bookData.title,
          format: bookData.format,
          encoding: bookData.encoding,
          sizeBytes: bookData.sizeBytes,
          chapters: bookData.chapters.map((chapter) => ({
            title: chapter.title,
            paragraphs: chapter.paragraphs,
          })),
        },
      }
    },

    /**
     * 按磁盘路径代读并解析(拖拽兜底)。
     * 跨 App 拖拽的 Web File 对象在渲染层可能无法读取(InvalidStateError /
     * 方法缺失),此通道用主进程 fs 直读磁盘文件,绕开 Web 层限制。
     */
    async 'library:parse-from-path'(payload) {
      logAction('library.parseFromPath', `主进程代读文件:${(payload && (payload.filePath || payload.fileName)) || '-'}`)
      const filePath = String((payload && payload.filePath) || '')
      if (!filePath) throw new Error('缺少 filePath')
      const fileName =
        typeof payload.fileName === 'string' && payload.fileName
          ? payload.fileName
          : nodePath.basename(filePath)
      let stat
      try {
        stat = await fs.promises.stat(filePath)
      } catch {
        throw new Error('文件不存在或无法访问')
      }
      if (!stat.isFile()) throw new Error('目标不是文件')
      if (stat.size > 100 * 1024 * 1024) throw new Error('文件超过 100MB 上限')
      const buffer = await fs.promises.readFile(filePath)
      const bookData = await parseBook({ fileName, buffer })
      return {
        ok: true,
        bookData: {
          title: bookData.title,
          format: bookData.format,
          encoding: bookData.encoding,
          sizeBytes: bookData.sizeBytes,
          chapters: bookData.chapters.map((chapter) => ({
            title: chapter.title,
            paragraphs: chapter.paragraphs,
          })),
        },
      }
    },

    /** 抓取网页(主进程网络代理) */
    async 'library:fetch-page'(payload) {
      logAction('library.fetchPage', `抓取网页:${(payload && payload.url) || '-'}`)
      const url = typeof payload.url === 'string' ? payload.url : ''
      const result = await fetchPage(url)
      return { ok: true, html: result.html, finalUrl: result.finalUrl }
    },

    /** 读某章正文(主进程 userData/chapters) */
    async 'library:read-chapter'(payload) {
      const bookId = String((payload && payload.bookId) || '')
      const idx = Number(payload && payload.idx)
      if (!bookId || !Number.isInteger(idx) || idx < 0) throw new Error('参数不合法')
      const p = nodePath.join(chapterDir(bookId), `${idx}.json`)
      if (!fs.existsSync(p)) throw new Error('CHAPTER_MISSING')
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      return {
        ok: true,
        data: { title: String(data.title || ''), paragraphs: Array.isArray(data.paragraphs) ? data.paragraphs : [] },
      }
    },

    /** 追加章节(写到末尾,manifest/books.json 同步更新) */
    async 'library:append-chapters'(payload) {
      logAction('library.appendChapters', `追加章节:${((payload && payload.chapters) || []).length} 章`)
      const bookId = String((payload && payload.bookId) || '')
      if (!bookId) throw new Error('缺少 bookId')
      const chapters = Array.isArray(payload.chapters) ? payload.chapters : []
      if (chapters.length === 0) return { ok: true, added: 0, chapters: [] }

      const store = getStore()
      const manifestChapters = readManifestFile(bookId).chapters
      const startIdx = manifestChapters.length
      writeChapterFiles(bookId, startIdx, chapters)
      chapters.forEach((ch, i) => {
        manifestChapters.push({
          idx: startIdx + i,
          title: String(ch.title || ''),
          paragraphCount: Array.isArray(ch.paragraphs) ? ch.paragraphs.length : 0,
          charCount: (ch.paragraphs || []).reduce((s, p) => s + String(p == null ? '' : p).length, 0),
        })
      })
      writeManifestFile(bookId, manifestChapters)
      // 同步 books.json 的章节数据与字数
      const books = loadBooks(store)
      const book = books.find((b) => b && b.id === bookId)
      if (book) {
        book.chapters = manifestChapters.map((c) => ({
          idx: c.idx,
          title: c.title,
          paragraphCount: c.paragraphCount,
          charCount: c.charCount,
        }))
        book.wordCount = manifestChapters.reduce((s, c) => s + (c.charCount || 0), 0)
        saveBooks(store, books)
      }
      return {
        ok: true,
        added: chapters.length,
        chapters: manifestChapters.map((c) => ({
          idx: c.idx,
          title: c.title,
          paragraphCount: c.paragraphCount,
          charCount: c.charCount,
        })),
      }
    },

    /**
     * 更新某章(重命名 / 内容替换,可单选):
     * title 提供 → 改标题;paragraphs 提供 → 替换正文与字数
     * 章节文件 / manifest / books.json 三处同步
     */
    async 'library:update-chapter'(payload) {
      logAction('library.updateChapter', `修改章节 #${Number(payload && payload.idx)}(${payload && payload.title ? '改名' : '内容替换'})`)
      const bookId = String((payload && payload.bookId) || '')
      const idx = Number(payload && payload.idx)
      const title = payload.title != null ? String(payload.title).trim() : null
      const paragraphs = Array.isArray(payload.paragraphs) ? payload.paragraphs : null
      if (!bookId || !Number.isInteger(idx) || idx < 0) throw new Error('参数不合法')
      if (title === null && paragraphs === null) throw new Error('缺少要更新的字段')
      const p = nodePath.join(chapterDir(bookId), `${idx}.json`)
      if (!fs.existsSync(p)) throw new Error('章节不存在')
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (title !== null) data.title = title
      if (paragraphs !== null) data.paragraphs = paragraphs
      fs.writeFileSync(p, JSON.stringify(data))
      const manifestChapters = readManifestFile(bookId).chapters
      if (manifestChapters[idx]) {
        if (title !== null) manifestChapters[idx].title = title
        if (paragraphs !== null) {
          manifestChapters[idx].paragraphCount = paragraphs.length
          manifestChapters[idx].charCount = paragraphs.reduce((s, pp) => s + String(pp == null ? '' : pp).length, 0)
        }
      }
      writeManifestFile(bookId, manifestChapters)
      const store = getStore()
      const books = loadBooks(store)
      const book = books.find((b) => b && b.id === bookId)
      if (book && Array.isArray(book.chapters) && book.chapters[idx]) {
        if (title !== null) book.chapters[idx].title = title
        if (paragraphs !== null) {
          book.chapters[idx].paragraphCount = paragraphs.length
          book.chapters[idx].charCount = manifestChapters[idx].charCount
        }
        saveBooks(store, books)
      }
      return { ok: true, chapters: manifestChapters }
    },

    /** 删除某章(后续章节前移重排,books.json 同步更新) */
    async 'library:remove-chapter'(payload) {
      logAction('library.removeChapter', `删除章节 #${Number(payload && payload.idx)}`)
      const bookId = String((payload && payload.bookId) || '')
      const idx = Number(payload && payload.idx)
      if (!bookId || !Number.isInteger(idx) || idx < 0) throw new Error('参数不合法')
      const chapterList = readManifestFile(bookId).chapters
      if (idx >= chapterList.length) throw new Error('章节不存在')

      // 读后续章节 → 删除目标及后续文件 → 前移重写
      const dir = chapterDir(bookId)
      const following = []
      for (let i = idx + 1; i < chapterList.length; i += 1) {
        const p = nodePath.join(dir, `${i}.json`)
        if (fs.existsSync(p)) {
          following.push(JSON.parse(fs.readFileSync(p, 'utf8')))
        }
        fs.rmSync(p, { force: true })
      }
      fs.rmSync(nodePath.join(dir, `${idx}.json`), { force: true })
      following.forEach((data, i) => {
        fs.writeFileSync(nodePath.join(dir, `${idx + i}.json`), JSON.stringify(data))
      })

      const kept = chapterList.filter((_, i) => i !== idx)
      const manifestChapters = kept.map((c, i) => ({
        idx: i,
        title: c.title,
        paragraphCount: c.paragraphCount,
        charCount: c.charCount,
      }))
      writeManifestFile(bookId, manifestChapters)

      // books.json 同步
      const store = getStore()
      const books = loadBooks(store)
      const book = books.find((b) => b && b.id === bookId)
      if (book) {
        book.chapters = manifestChapters.map((c) => ({
          idx: c.idx,
          title: c.title,
          paragraphCount: c.paragraphCount,
          charCount: c.charCount,
        }))
        book.wordCount = manifestChapters.reduce((s, c) => s + (c.charCount || 0), 0)
        // 阅读进度夹紧到有效范围
        if (book.lastPosition && book.lastPosition.chapterIdx >= manifestChapters.length) {
          book.lastPosition = {
            chapterIdx: Math.max(0, manifestChapters.length - 1),
            segIdx: 0,
          }
        }
        saveBooks(store, books)
      }
      return { ok: true, chapters: manifestChapters }
    },

    /** 登记书籍元数据(新建 / 覆写);chapters 提供时由主进程落盘正文文件 */
    async 'library:register'(payload) {
      logAction('library.register', `登记书籍:《${(payload && payload.meta && payload.meta.title) || '-'}》`)
      const store = getStore()
      const books = loadBooks(store)
      const fields = buildBookFields(payload.meta, payload.wordCount)
      const bookId = typeof payload.bookId === 'string' && payload.bookId ? payload.bookId : ''
      const existingIndex = bookId
        ? books.findIndex((book) => book && book.id === bookId)
        : -1

      // 最终 id 只能生成一次:正文目录(chapters/<id>/)与 books.json 记录必须是同一个 id,
      // 否则会出现「目录能识别、正文读不到」(历史双 UUID bug)。
      const finalId = existingIndex >= 0 ? books[existingIndex].id : bookId || crypto.randomUUID()

      // 正文落盘:chapters 提供时主进程直接写章节文件与 manifest(渲染层零 OPFS 依赖)
      const chapters = Array.isArray(payload.chapters) ? payload.chapters : null
      if (chapters) {
        writeChapterFiles(finalId, 0, chapters)
        writeManifestFile(
          finalId,
          chapters.map((ch, i) => ({
            idx: i,
            title: String(ch.title || ''),
            paragraphCount: Array.isArray(ch.paragraphs) ? ch.paragraphs.length : 0,
            charCount: (ch.paragraphs || []).reduce((s, p) => s + String(p == null ? '' : p).length, 0),
          })),
        )
      }

      let book
      if (existingIndex >= 0) {
        // 覆写模式:保留原 id / addedAt / lastPosition,其余字段完全以新 meta 为准
        // (新 meta 未提供的可选字段如 author / sourceUrl 会被清除,不残留旧值)
        const previous = books[existingIndex]
        book = {
          ...fields,
          id: previous.id,
          addedAt: previous.addedAt,
          lastPosition:
            previous.lastPosition && typeof previous.lastPosition === 'object'
              ? previous.lastPosition
              : defaultLastPosition(),
        }
        books[existingIndex] = book
      } else {
        // 新建模式(id 与正文目录共用 finalId)
        book = {
          id: finalId,
          ...fields,
          addedAt: new Date().toISOString(),
          lastPosition: defaultLastPosition(),
        }
        books.push(book)
      }

      saveBooks(store, books)
      return { ok: true, book }
    },

    /** 列出全部书籍 */
    async 'library:list'() {
      const store = getStore()
      const books = loadBooks(store)
      // 存量书库的章节缺 idx → 自愈并落盘(目录显示 NaN / 点章节定位不到)
      if (healChapterIdx(books)) saveBooks(store, books)
      return { ok: true, books }
    },

    /** 按 id 取书籍 */
    async 'library:get-book'(payload) {
      const store = getStore()
      const bookId = typeof payload.bookId === 'string' ? payload.bookId : ''
      const books = loadBooks(store)
      // 存量书库的章节缺 idx → 自愈并落盘
      // (阅读器用 chapter.idx 匹配章节,缺 idx 会导致标题为空、正文定位不到)
      if (healChapterIdx(books)) saveBooks(store, books)
      const book = books.find((item) => item && item.id === bookId)
      if (!book) throw new Error(`未找到书籍:${bookId || '(空 id)'}`)
      return { ok: true, book }
    },

    /** 删除书籍(同步删除章节正文目录) */
    async 'library:remove'(payload) {
      logAction('library.remove', `移除书籍:${(payload && payload.bookId) || '-'}`)
      const store = getStore()
      const bookId = typeof payload.bookId === 'string' ? payload.bookId : ''
      const books = loadBooks(store)
      const index = books.findIndex((item) => item && item.id === bookId)
      if (index < 0) throw new Error(`未找到书籍:${bookId || '(空 id)'}`)
      books.splice(index, 1)
      saveBooks(store, books)
      removeChapterDir(bookId)
      return { ok: true }
    },

    /** 更新阅读进度 */
    async 'library:update-position'(payload) {
      const store = getStore()
      const bookId = typeof payload.bookId === 'string' ? payload.bookId : ''
      const books = loadBooks(store)
      const index = books.findIndex((item) => item && item.id === bookId)
      if (index < 0) throw new Error(`未找到书籍:${bookId || '(空 id)'}`)
      const position = payload.lastPosition || {}
      books[index] = {
        ...books[index],
        lastPosition: {
          chapterIdx: Number.isFinite(position.chapterIdx) ? position.chapterIdx : 0,
          segIdx: Number.isFinite(position.segIdx) ? position.segIdx : 0,
        },
      }
      // 阅读进度是高频写 → 保持防抖,避免每次都全量落盘
      saveBooks(store, books, { immediate: false })
      return { ok: true }
    },
  }
}

/**
 * 包装处理函数:统一错误 → {ok:false, error}
 * @param {string} channel
 * @param {(payload: object) => Promise<object>} handler
 * @returns {(event: unknown, payload: object) => Promise<object>}
 */
function wrapHandler(channel, handler) {
  return async (_event, payload) => {
    try {
      return await handler(payload || {})
    } catch (err) {
      const message = err && err.message ? err.message : String(err)
      logError('ipc:' + channel, err, `[library] ${channel} 失败:${message}`)
      return { ok: false, error: message }
    }
  }
}

/**
 * 注册书库 IPC 通道(在 app.whenReady 中调用)
 * @param {{ipcMain?: object, store?: import('../store').JsonStore}} [options]
 * @returns {string[]} 已注册的通道名
 */
function registerLibraryIpc(options = {}) {
  let ipc = options.ipcMain
  if (!ipc) {
    const electron = require('electron')
    ipc = electron && electron.ipcMain
  }
  if (!ipc || typeof ipc.handle !== 'function') {
    throw new Error('registerLibraryIpc 需要可用的 ipcMain')
  }

  const handlers = createLibraryHandlers({ store: options.store })
  for (const channel of LIBRARY_CHANNELS) {
    ipc.handle(channel, wrapHandler(channel, handlers[channel]))
  }
  return LIBRARY_CHANNELS
}

module.exports = {
  registerLibraryIpc,
  computeBookSizeBytes,
  backfillBookSizes,
  buildBookFields,
  createLibraryHandlers,
  wrapHandler,
  LIBRARY_CHANNELS,
}
