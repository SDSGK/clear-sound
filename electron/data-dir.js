const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { cleanBookTitle } = require('./library/title')

/**
 * data-dir.js —— 确定性的数据根目录 + 旧数据迁移 + 孤儿章节目录修复
 *
 * ## 为什么要有这个模块
 *
 * 此前 electron/index.js 用「多候选探测」决定 userData:
 *   1) app.getPath('userData')          → dev 下常是 .../Application Support/Electron
 *   2) app.getPath('appData')/clear-sound
 *   3) app.getPath('temp')/clear-sound-data   ← 系统会清理,书会「凭空消失」
 *
 * 探测结果随启动环境变化 → 数据散落在多个目录,用户在书架上「书不见了」;
 * 落在 temp 的那一份还会被 macOS 定期清理,等于永久丢失。
 *
 * 现在改为:**固定使用 appData/clear-sound**(macOS: ~/Library/Application Support/clear-sound),
 * 与 app 名、dev/打包、启动环境全部无关;启动时把旧目录的数据合并过来,
 * 并修复历史上因 register 双 UUID 产生的孤儿章节目录。
 *
 * ## 幂等性
 *
 * 迁移与修复均幂等:重复启动不会重复合并、不会破坏已有数据;
 * 旧目录一律只读不删(用户可自行核对)。
 */

const APP_DIR_NAME = 'clear-sound'
const DATA_SUBDIR = 'data'
const CHAPTERS_SUBDIR = 'chapters'

/**
 * 一次性迁移标记文件(放在根目录下)。
 *
 * 迁移必须**只做一次**:每次启动都把旧目录的书合并回来,会让用户删掉的书
 * 「复活」,看起来像「重新导入后之前的书又出现了」。
 */
const MIGRATED_MARKER = '.migrated-v1'

/**
 * 环境变量覆盖数据根目录(自动化测试 / 调试隔离用)。
 *
 * 存在该变量时:
 *  - root = 变量指定目录(与真实用户数据完全隔离)
 *  - **不做旧目录迁移**(否则会把真实书库合并进测试目录,污染用户数据)
 *
 * 不设置时:root = appData/clear-sound,并执行旧目录迁移。
 */
const DATA_DIR_ENV = 'CLEAR_SOUND_DATA_DIR'

/**
 * 固定的数据根目录(appData/clear-sound)。
 * @param {{app: object}} deps
 * @returns {string} 绝对路径
 */
function resolveDataRoot(deps) {
  const override = process.env[DATA_DIR_ENV]
  if (override && override.trim()) return path.resolve(override.trim())
  const { app } = deps
  return path.join(app.getPath('appData'), APP_DIR_NAME)
}

/**
 * 是否处于隔离模式(测试/调试:不迁移真实数据)
 * @returns {boolean}
 */
function isIsolated() {
  const override = process.env[DATA_DIR_ENV]
  return !!(override && override.trim())
}

/**
 * 根目录选择标记文件(放在家目录下)。
 *
 * 为什么需要:数据根目录必须**跨启动保持一致**,否则每次启动可能落到不同目录,
 * 用户会看到「刚导入的书刷新就没了」。若首选目录不可写(受限环境),
 * 实际使用的目录记在这里,下次启动继续用它 —— 而不是每次重新探测、到处漂移。
 */
const ROOT_MARKER_DIR = '.clear-sound'
const ROOT_MARKER_FILE = 'data-root'

/**
 * 家目录下的标记文件路径
 * @returns {string}
 */
function rootMarkerPath() {
  return path.join(os.homedir(), ROOT_MARKER_DIR, ROOT_MARKER_FILE)
}

/**
 * 读取上次实际使用的数据根目录(为空表示没有记录)
 * @returns {string}
 */
function readRootMarker() {
  try {
    return fs.readFileSync(rootMarkerPath(), 'utf8').trim() || ''
  } catch {
    return ''
  }
}

/**
 * 记录本次实际使用的数据根目录(失败不影响启动)
 * @param {string} root 根目录
 * @returns {void}
 */
function writeRootMarker(root) {
  try {
    fs.mkdirSync(path.dirname(rootMarkerPath()), { recursive: true })
    fs.writeFileSync(rootMarkerPath(), root, 'utf8')
  } catch {
    /* 标记失败不影响主流程 */
  }
}

/**
 * 目录是否可写(实际写一个探针文件再删掉)
 * @param {string} dir 目录
 * @returns {boolean}
 */
function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.write-probe')
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 选择数据根目录:**稳定优先**,不可写才回退,且回退结果会被记住。
 *
 * 顺序:
 *  1) 上次实际使用的目录(标记文件)—— 保证跨启动一致,不会「刷新就没了」
 *  2) appData/clear-sound —— 默认位置
 *  3) appData/clear-sound-data —— 同级备选
 *  4) temp/clear-sound-data —— 最后兜底(会被系统清理,尽量避免)
 *
 * @param {{app: object}} deps
 * @returns {{root: string, writable: boolean, source: string}}
 */
function selectDataRoot(deps) {
  const { app } = deps
  const override = process.env[DATA_DIR_ENV]
  if (override && override.trim()) {
    const root = path.resolve(override.trim())
    return { root, writable: isWritable(root), source: 'env' }
  }

  const candidates = []
  const marked = readRootMarker()
  // 标记指向 temp 时不让位 —— temp 会被系统清理,数据放那里等于随时会丢;
  // 此时优先用 appData,启动迁移会把 temp 里的数据合并过来(appData 尚未标记迁移)。
  const markedIsTemp = marked ? /[\\/]T[\\/]|[\\/]tmp[\\/]|[\\/]temp[\\/]/.test(marked) : false
  if (marked && !markedIsTemp) candidates.push({ dir: marked, source: 'marker' })
  candidates.push({ dir: path.join(app.getPath('appData'), APP_DIR_NAME), source: 'appData' })
  candidates.push({ dir: path.join(app.getPath('appData'), `${APP_DIR_NAME}-data`), source: 'appData-alt' })
  try {
    candidates.push({ dir: path.join(app.getPath('temp'), `${APP_DIR_NAME}-data`), source: 'temp' })
  } catch {
    /* ignore */
  }

  for (const c of candidates) {
    if (isWritable(c.dir)) {
      if (c.source !== 'marker') writeRootMarker(c.dir)
      return { root: c.dir, writable: true, source: c.source }
    }
  }
  // 全部不可写:仍用首选目录,由上层给出明确提示
  const fallback = path.join(app.getPath('appData'), APP_DIR_NAME)
  return { root: fallback, writable: false, source: 'none' }
}

/**
 * 候选的旧数据目录(只读,用于合并历史数据)。
 * @param {{app: object, previousUserData?: string}} deps previousUserData = setPath 之前的 userData
 * @returns {string[]}
 */
function legacyDataRoots(deps) {
  const { app } = deps
  const out = []
  const push = (dir) => {
    if (dir && !out.includes(dir)) out.push(dir)
  }
  // 隔离模式:绝不迁移真实用户数据
  if (isIsolated()) return out
  // 旧 userData(dev 下通常是 Electron)
  if (deps.previousUserData) push(path.join(deps.previousUserData, DATA_SUBDIR))
  try {
    push(path.join(app.getPath('temp'), `${APP_DIR_NAME}-data`, DATA_SUBDIR))
  } catch {
    /* ignore */
  }
  return out
}

/**
 * 读取 JSON 文件(不存在或损坏返回 null)
 * @param {string} file
 * @returns {unknown|null}
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 把一个 JSON 文档规整成数组(兼容 {books:[...]} 包装)
 * @param {unknown} raw
 * @param {string} key 数组键名
 * @returns {unknown[]}
 */
function toArray(raw, key) {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object' && Array.isArray(raw[key])) return raw[key]
  return []
}

/**
 * 书名归一化(用于识别「同一本书的重复导入」)
 * @param {unknown} title
 * @returns {string}
 */
function normalizeTitle(title) {
  return String(title == null ? '' : title)
    .replace(/[《》「」\s]/g, '')
    .toLowerCase()
}

/**
 * 合并两个数组型文档(按 id 去重,addedAt 较新者胜)。
 * @param {unknown[]} base 已存在(新根目录)的条目
 * @param {unknown[]} incoming 旧目录的条目
 * @returns {unknown[]} 合并结果
 */
function mergeById(base, incoming) {
  const out = base.slice()
  const indexById = new Map()
  out.forEach((item, i) => {
    const id = item && item.id
    if (id) indexById.set(String(id), i)
  })
  for (const item of incoming) {
    if (!item || typeof item !== 'object') continue
    const id = item.id ? String(item.id) : null
    if (!id) {
      out.push(item)
      continue
    }
    const at = indexById.get(id)
    if (at === undefined) {
      indexById.set(id, out.length)
      out.push(item)
      continue
    }
    const oldTime = Date.parse(out[at].updatedAt || out[at].addedAt || '') || 0
    const newTime = Date.parse(item.updatedAt || item.addedAt || '') || 0
    if (newTime > oldTime) out[at] = item
  }
  return out
}

/**
 * 书籍的**内容指纹** —— 用于识别「同一本书的重复副本」。
 *
 * 为什么不用标题:同一本书可能因来源不同而标题不同(例如文件名导入是
 * 《遮天》（精校版全本）作者：辰东,网页导入是 遮天),按标题去重会漏掉,
 * 用户就会看到「导入一次后书架上出现两本一样的书」。
 *
 * 指纹取:章节数 + 段落总数 + 总字数 + 首章标题 + 末章标题。
 * 不同的书要同时满足这五项全等才会被误判,实际不会发生。
 *
 * @param {object} book 书籍
 * @returns {string} 指纹(无章节信息时返回空串 → 不参与去重)
 */
function contentFingerprint(book) {
  const chapters = book && Array.isArray(book.chapters) ? book.chapters : []
  if (chapters.length === 0) return ''
  let paragraphs = 0
  let chars = 0
  for (const c of chapters) {
    paragraphs += Number(c && c.paragraphCount) || 0
    chars += Number(c && c.charCount) || 0
  }
  const first = String((chapters[0] && chapters[0].title) || '')
  const last = String((chapters[chapters.length - 1] && chapters[chapters.length - 1].title) || '')
  return `${chapters.length}|${paragraphs}|${chars}|${first}|${last}`
}

/**
 * 合并书列表:按 id 去重,并合并**同一本书的重复副本**。
 *
 * 副本判定优先用内容指纹(标题不同但内容相同也算同一本);
 * 指纹缺失时回退到「归一化标题 + 章节数」。
 * 保留的条目优先取:有阅读进度 > 更新时间新。
 *
 * @param {unknown[]} base 已存在(新根目录)的条目
 * @param {unknown[]} incoming 旧目录的条目
 * @returns {{merged: unknown[], skippedDupes: string[]}}
 */
function mergeBooks(base, incoming) {
  const merged = mergeById(base, incoming)
  const seen = new Map()
  const skippedDupes = []
  const kept = []
  for (const book of merged) {
    if (!book || typeof book !== 'object') {
      kept.push(book)
      continue
    }
    const fp = contentFingerprint(book)
    const key = fp || `${normalizeTitle(book.title)}|${Array.isArray(book.chapters) ? book.chapters.length : 0}`
    const prevIndex = seen.get(key)
    if (prevIndex === undefined) {
      seen.set(key, kept.length)
      kept.push(book)
      continue
    }
    // 同一本书的两份 → 保留「有阅读进度 / 更新时间新」的那份
    const prev = kept[prevIndex]
    const prevPos = prev && prev.lastPosition ? Number(prev.lastPosition.chapterIdx) || 0 : 0
    const curPos = book.lastPosition ? Number(book.lastPosition.chapterIdx) || 0 : 0
    const prevTime = Date.parse(prev && prev.addedAt) || 0
    const curTime = Date.parse(book.addedAt) || 0
    if (curPos > prevPos || (curPos === prevPos && curTime > prevTime)) {
      kept[prevIndex] = book
      skippedDupes.push(`${prev.title || ''}(${prev.id})`)
    } else {
      skippedDupes.push(`${book.title || ''}(${book.id})`)
    }
  }
  return { merged: kept, skippedDupes }
}

/**
 * 把旧目录的数据迁移到新根目录。
 * - books.json / corrections.json / bookmarks.json:合并(books 额外去重同名同章数)
 * - chapters/:按 bookId 目录直接搬移(目标已存在则跳过)
 *
 * @param {{app: object, root: string, legacyRoots?: string[]}} deps
 * @returns {{merged: string[], skippedDupes: string[], movedChapterDirs: string[]}}
 */
function migrateLegacyData(deps) {
  const root = deps.root
  const dataDir = path.join(root, DATA_SUBDIR)
  const merged = []
  const skippedDupes = []
  const movedChapterDirs = []

  fs.mkdirSync(dataDir, { recursive: true })

  // 已迁移过:不再重复合并(否则已删除的书会被旧目录「复活」)
  const markerFile = path.join(root, MIGRATED_MARKER)
  if (fs.existsSync(markerFile)) {
    return { merged: [], skippedDupes: [], movedChapterDirs: [] }
  }

  const legacyRoots = deps.legacyRoots || legacyDataRoots(deps)

  for (const legacy of legacyRoots) {
    if (legacy === dataDir) continue
    if (!fs.existsSync(legacy)) continue

    // --- books.json ---
    const legacyBooks = path.join(legacy, 'books.json')
    if (fs.existsSync(legacyBooks)) {
      const incoming = toArray(readJson(legacyBooks), 'books')
      if (incoming.length > 0) {
        const targetFile = path.join(dataDir, 'books.json')
        const current = toArray(readJson(targetFile), 'books')
        const result = mergeBooks(current, incoming)
        if (result.merged.length !== current.length) {
          fs.writeFileSync(targetFile, JSON.stringify(result.merged, null, 2), 'utf8')
          merged.push('books.json')
        }
        skippedDupes.push(...result.skippedDupes)
      }
    }

    // --- corrections.json / bookmarks.json ---
    for (const [file, key] of [
      ['corrections.json', 'rules'],
      ['bookmarks.json', 'bookmarks'],
    ]) {
      const legacyFile = path.join(legacy, file)
      if (!fs.existsSync(legacyFile)) continue
      const incoming = toArray(readJson(legacyFile), key)
      if (incoming.length === 0) continue
      const targetFile = path.join(dataDir, file)
      const current = toArray(readJson(targetFile), key)
      const result = mergeById(current, incoming)
      if (result.length !== current.length) {
        fs.writeFileSync(targetFile, JSON.stringify(result, null, 2), 'utf8')
        merged.push(file)
      }
    }

    // --- 章节目录搬移 ---
    const legacyChapters = path.join(path.dirname(legacy), CHAPTERS_SUBDIR)
    if (!fs.existsSync(legacyChapters)) continue
    const targetChapters = path.join(root, CHAPTERS_SUBDIR)
    fs.mkdirSync(targetChapters, { recursive: true })
    for (const entry of fs.readdirSync(legacyChapters, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const from = path.join(legacyChapters, entry.name)
      const to = path.join(targetChapters, entry.name)
      if (fs.existsSync(to)) continue
      try {
        fs.renameSync(from, to)
        movedChapterDirs.push(entry.name)
      } catch {
        try {
          fs.cpSync(from, to, { recursive: true })
          movedChapterDirs.push(entry.name)
        } catch {
          /* 保留在旧目录,不影响启动 */
        }
      }
    }
  }

  // 标记迁移已完成(即使本次没有可迁移内容也要标记,避免以后反复扫描)
  try {
    fs.writeFileSync(markerFile, new Date().toISOString(), 'utf8')
  } catch {
    /* 标记失败则下次再迁移一次,不影响正确性 */
  }
  return { merged, skippedDupes, movedChapterDirs }
}

/**
 * 清理书库里**已存在的重复副本**(同一本书被导入两次 → 书架上两本一模一样)。
 *
 * 场景:用户重复导入同一本书,或旧目录合并时带进了同名副本 → 书架出现两本内容相同的书,
 * 且「再次导入后又把之前的显示了」。
 *
 * 保留规则:有阅读进度 > 更新时间新;被移除的那本的章节目录会一并删除
 * (仅当 manifest 内容与保留本一致时才删,避免误删不同内容的目录)。
 *
 * @param {{app: object, root: string}} deps
 * @returns {{removed: string[], kept: string[]}}
 */
function dedupeExistingBooks(deps) {
  const root = deps.root
  const booksFile = path.join(root, DATA_SUBDIR, 'books.json')
  const chaptersDir = path.join(root, CHAPTERS_SUBDIR)
  const removed = []
  const kept = []
  if (!fs.existsSync(booksFile)) return { removed, kept }

  const books = toArray(readJson(booksFile), 'books')
  if (books.length < 2) return { removed, kept }

  /** 内容指纹 → 该组保留下来的下标 */
  const groups = new Map()
  /** 内容指纹 → 全部候选 */
  const members = new Map()
  books.forEach((book, i) => {
    if (!book || typeof book !== 'object') return
    const fp = contentFingerprint(book)
    if (!fp) return
    if (!groups.has(fp)) groups.set(fp, i)
    if (!members.has(fp)) members.set(fp, [])
    members.get(fp).push(book)
  })

  const dropIndexes = new Set()
  for (const [fp, list] of members) {
    if (list.length < 2) continue
    const keepIndex = groups.get(fp)
    const keep = books[keepIndex]
    for (const book of list) {
      if (book === keep) continue
      // 保留有阅读进度 / 更新时间新的一份
      const keepPos = keep && keep.lastPosition ? Number(keep.lastPosition.chapterIdx) || 0 : 0
      const curPos = book.lastPosition ? Number(book.lastPosition.chapterIdx) || 0 : 0
      const keepTime = Date.parse(keep && keep.addedAt) || 0
      const curTime = Date.parse(book.addedAt) || 0
      if (curPos > keepPos || (curPos === keepPos && curTime > keepTime)) {
        // 当前这本更好 → 改为保留它,原来的 keep 变成待删
        dropIndexes.add(keepIndex)
        groups.set(fp, books.indexOf(book))
        continue
      }
      dropIndexes.add(books.indexOf(book))
    }
  }

  // 注意:即使书库里没有重复条目,也必须继续走孤儿目录清理 ——
  // 「书库里没这条记录、但 chapters/ 下留着内容完全相同的目录」正是
  // 导入中途进程重启留下的残留(用户会以为「书还在」,实际书架上已经没有它了)。
  const keepList = []
  books.forEach((book, i) => {
    if (dropIndexes.has(i)) {
      removed.push(`${book.title || ''}(${book.id})`)
      // 章节目录:manifest 一致才删(内容相同的副本)
      try {
        const dir = path.join(chaptersDir, String(book.id))
        const keepBook = books[[...dropIndexes].find((d) => d !== i) || i]
        const keepDir = keepBook ? path.join(chaptersDir, String(keepBook.id)) : ''
        const a = path.join(dir, 'manifest.json')
        const b = keepDir ? path.join(keepDir, 'manifest.json') : ''
        if (fs.existsSync(a) && b && fs.existsSync(b)
          && fs.readFileSync(a, 'utf8') === fs.readFileSync(b, 'utf8')) {
          fs.rmSync(dir, { recursive: true, force: true })
        }
      } catch {
        /* 目录删除失败不影响书库清理 */
      }
      return
    }
    keepList.push(book)
  })

  kept.push(...keepList.map((b) => b.id))
  if (dropIndexes.size > 0) {
    try {
      fs.writeFileSync(booksFile, JSON.stringify(keepList, null, 2), 'utf8')
    } catch (err) {
      console.error(`[data-dir] 重复副本清理后写回失败:${err && err.message}`)
      return { removed: [], kept }
    }
  }

  // 清理「孤儿重复目录」:目录存在但书库里已无对应条目,
  // 且其 manifest 与保留本完全一致 → 是同一次导入的残留副本(如导入中途重启)。
  removeOrphanDuplicateDirs(chaptersDir, keepList, removed)
  return { removed, kept }
}

/**
 * 删除孤儿重复章节目录:书库里没有对应书、且 manifest 与某本保留书完全一致。
 *
 * 场景:导入先写 1821 个章节文件、再写书库,若中途进程重启(dev 下改 electron/ 即触发),
 * 就会留下一个 22MB 的孤儿目录 —— 既占空间,又让用户以为「书还在」。
 * @param {string} chaptersDir 章节目录根
 * @param {unknown[]} keepList 保留的书
 * @param {string[]} _removedIds 已被移除的书 id(保留参数便于调用方传入上下文)
 * @returns {string[]} 已删除的孤儿目录名
 */
function removeOrphanDuplicateDirs(chaptersDir, keepList, _removedIds) {
  const cleaned = []
  if (!fs.existsSync(chaptersDir)) return cleaned
  const keptIds = new Set(keepList.map((b) => b && b.id).filter(Boolean))

  // 收集保留书的 manifest 指纹
  const keepManifests = new Set()
  for (const book of keepList) {
    const mf = path.join(chaptersDir, String(book && book.id), 'manifest.json')
    try {
      if (fs.existsSync(mf)) keepManifests.add(fs.readFileSync(mf, 'utf8'))
    } catch {
      /* ignore */
    }
  }
  if (keepManifests.size === 0) return cleaned

  for (const entry of fs.readdirSync(chaptersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dirName = entry.name
    if (keptIds.has(dirName)) continue
    // 刚被移除的那本书的目录:manifest 相同才删(内容一致的副本)
    const mf = path.join(chaptersDir, dirName, 'manifest.json')
    try {
      if (!fs.existsSync(mf)) continue
      const text = fs.readFileSync(mf, 'utf8')
      if (!keepManifests.has(text)) continue
      fs.rmSync(path.join(chaptersDir, dirName), { recursive: true, force: true })
      cleaned.push(dirName)
    } catch {
      /* 忽略删除失败 */
    }
  }
  return cleaned
}

/**
 * 归一化既有书目元数据:清洗书名 + 回填书的大小。
 *
 * 两类历史数据需要修正:
 *  1) 书名带书名号(如「《遮天》（精校版全本）作者：辰东」)→ 清洗为可读书名,
 *     否则书架与目录页顶部都显示成「《遮天》…」,首字符是「《」没法当名字用;
 *  2) 旧书导入时还没记录文件体积 → 按已落盘的章节文件总大小回填。
 *
 * 幂等:清洗后再次启动不会重复改动。
 *
 * @param {{app: object, root: string}} deps
 * @returns {{cleanedTitles: string[], backfilledSizes: string[]}}
 */
function normalizeBookMeta(deps) {
  const root = deps.root
  const booksFile = path.join(root, DATA_SUBDIR, 'books.json')
  const chaptersDir = path.join(root, CHAPTERS_SUBDIR)
  const cleanedTitles = []
  const backfilledSizes = []
  if (!fs.existsSync(booksFile)) return { cleanedTitles, backfilledSizes }

  const books = toArray(readJson(booksFile), 'books')
  if (books.length === 0) return { cleanedTitles, backfilledSizes }

  let changed = false
  for (const book of books) {
    if (!book || typeof book !== 'object') continue
    // 书名清洗
    const cleaned = cleanBookTitle(book.title)
    if (cleaned && cleaned !== book.title) {
      cleanedTitles.push(`${book.title} → ${cleaned}`)
      book.title = cleaned
      changed = true
    }
    // 体积回填(按章节文件总大小)
    if (!Number.isFinite(book.sizeBytes) || book.sizeBytes <= 0) {
      const size = sumDirSize(path.join(chaptersDir, String(book.id)))
      if (size > 0) {
        book.sizeBytes = size
        backfilledSizes.push(book.id)
        changed = true
      }
    }
  }
  if (changed) {
    try {
      fs.writeFileSync(booksFile, JSON.stringify(books, null, 2), 'utf8')
    } catch (err) {
      console.error(`[data-dir] 书目归一化写回失败:${err && err.message}`)
    }
  }
  return { cleanedTitles, backfilledSizes }
}

/**
 * 统计目录下所有文件的总字节数
 * @param {string} dir 目录
 * @returns {number} 字节数
 */
function sumDirSize(dir) {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      try {
        total += entry.isFile() ? fs.statSync(p).size : sumDirSize(p)
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
 * 修复「孤儿章节目录」。
 *
 * 历史 bug:library:register 新建模式生成了两次不同 UUID,
 * 正文写进 chapters/<uuidA>/,而 books.json 记录 <uuidB> →
 * 目录能识别但正文永远读不到。
 *
 * 修复规则:某本书的 chapters/<book.id> 不存在,而 chapters/ 下存在某个目录,
 * 其 manifest 章节数与该书一致 → 把目录改名为 book.id。
 *
 * @param {{app: object, root: string}} deps
 * @returns {{repaired: string[]}}
 */
function repairOrphanChapterDirs(deps) {
  const root = deps.root
  const chaptersDir = path.join(root, CHAPTERS_SUBDIR)
  const booksFile = path.join(root, DATA_SUBDIR, 'books.json')
  const repaired = []
  if (!fs.existsSync(chaptersDir) || !fs.existsSync(booksFile)) return { repaired }

  const books = toArray(readJson(booksFile), 'books')
  if (books.length === 0) return { repaired }

  const dirs = new Map()
  for (const entry of fs.readdirSync(chaptersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(chaptersDir, entry.name)
    const manifest = readJson(path.join(dir, 'manifest.json'))
    const count = Array.isArray(manifest && manifest.chapters) ? manifest.chapters.length : null
    dirs.set(entry.name, { dir, count, manifest })
  }

  for (const book of books) {
    if (!book || !book.id) continue
    const own = path.join(chaptersDir, String(book.id))
    if (fs.existsSync(own)) continue
    const expected = Array.isArray(book.chapters) ? book.chapters.length : null
    if (!expected) continue

    let candidate = null
    for (const [dirName, info] of dirs) {
      if (dirName === String(book.id)) continue
      if (info.count !== expected) continue
      const firstTitle = book.chapters[0] && book.chapters[0].title
      const manifestFirst = info.manifest && info.manifest.chapters[0] && info.manifest.chapters[0].title
      if (firstTitle && manifestFirst && firstTitle !== manifestFirst) continue
      candidate = dirName
      break
    }
    if (!candidate) continue

    try {
      fs.renameSync(path.join(chaptersDir, candidate), own)
      repaired.push(`${candidate} → ${book.id}`)
      dirs.delete(candidate)
    } catch {
      /* 改名失败则保持原状:不损坏数据 */
    }
  }

  return { repaired }
}

module.exports = {
  APP_DIR_NAME,
  DATA_SUBDIR,
  CHAPTERS_SUBDIR,
  MIGRATED_MARKER,
  resolveDataRoot,
  selectDataRoot,
  isWritable,
  readRootMarker,
  writeRootMarker,
  legacyDataRoots,
  migrateLegacyData,
  repairOrphanChapterDirs,
  mergeById,
  mergeBooks,
  contentFingerprint,
  dedupeExistingBooks,
  normalizeBookMeta,
  sumDirSize,
  removeOrphanDuplicateDirs,
  normalizeTitle,
}
