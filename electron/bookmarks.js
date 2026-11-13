const crypto = require('node:crypto')
const { getUserStore } = require('./store')
const { logAction, logError } = require('./debug-log')

/**
 * bookmarks.js —— 书签存储与 IPC(PLAN §4.8)
 *
 * bookmarks.json:数组 [{id, bookId, chapterIdx, paraIdx, excerpt, createdAt}]
 * 同一本书同一位置幂等(重复添加返回已有书签)。
 *
 * 通道:
 *  - bookmark:list   {bookId?}                          → {ok, bookmarks}
 *  - bookmark:add    {bookId, chapterIdx, paraIdx, excerpt} → {ok, bookmark, existed?}
 *  - bookmark:remove {id}                               → {ok}
 */

const BOOKMARKS_FILE = 'bookmarks.json'

const BOOKMARK_CHANNELS = ['bookmark:list', 'bookmark:add', 'bookmark:remove']

/** 书签节选最大长度(字符) */
const EXCERPT_MAX = 60

/** 读取书签数组 */
function loadList(store) {
  const raw = store.getRaw()
  return Array.isArray(raw) ? raw : []
}

function truncateExcerpt(excerpt) {
  const text = String(excerpt == null ? '' : excerpt).trim()
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX)}…` : text
}

function createBookmarkHandlers(deps = {}) {
  function getStore() {
    return deps.store || getUserStore(BOOKMARKS_FILE)
  }
  return {
    async 'bookmark:list'(payload = {}) {
      const bookId = payload && payload.bookId
      const list = loadList(getStore())
      return {
        ok: true,
        bookmarks: bookId ? list.filter((b) => b && b.bookId === bookId) : list,
      }
    },

    async 'bookmark:add'(payload = {}) {
      logAction('bookmark.add', `新增书签 第 ${Number(payload && payload.chapterIdx) + 1} 章第 ${Number(payload && payload.paraIdx) + 1} 段`)
      const bookId = String((payload && payload.bookId) || '')
      if (!bookId) throw new Error('缺少 bookId')
      const chapterIdx = Number(payload && payload.chapterIdx)
      const paraIdx = Number(payload && payload.paraIdx)
      if (!Number.isInteger(chapterIdx) || chapterIdx < 0) throw new Error('chapterIdx 不合法')
      if (!Number.isInteger(paraIdx) || paraIdx < 0) throw new Error('paraIdx 不合法')

      const store = getStore()
      const list = loadList(store)
      const existing = list.find(
        (b) => b && b.bookId === bookId && b.chapterIdx === chapterIdx && b.paraIdx === paraIdx,
      )
      if (existing) return { ok: true, bookmark: existing, existed: true }

      const bookmark = {
        id: crypto.randomUUID(),
        bookId,
        chapterIdx,
        paraIdx,
        excerpt: truncateExcerpt(payload && payload.excerpt),
        createdAt: new Date().toISOString(),
      }
      list.push(bookmark)
      store.setRaw(list)
      store.save()
      return { ok: true, bookmark }
    },

    async 'bookmark:remove'(payload = {}) {
      logAction('bookmark.remove', `删除书签 #${payload.id}`)
      const { id } = payload
      const store = getStore()
      const list = loadList(store)
      const before = list.length
      const next = list.filter((b) => !b || b.id !== id)
      if (next.length === before) throw new Error('书签不存在')
      store.setRaw(next)
      store.save()
      return { ok: true }
    },
  }
}

/** 统一错误包装 */
function wrapHandler(channel, handler) {
  return async (_event, payload) => {
    try {
      return await handler(payload || {})
    } catch (err) {
      const message = err && err.message ? err.message : String(err)
      logError('ipc:' + channel, err, `[bookmarks] ${channel} 失败:${message}`)
      return { ok: false, error: message }
    }
  }
}

/**
 * 注册书签 IPC 通道(在 app.whenReady 中调用)
 * @param {{ipcMain?: object, store?: object}} [options]
 * @returns {string[]} 已注册的通道名
 */
function registerBookmarkIpc(options = {}) {
  let ipc = options.ipcMain
  if (!ipc) {
    const electron = require('electron')
    ipc = electron && electron.ipcMain
  }
  if (!ipc || typeof ipc.handle !== 'function') {
    throw new Error('registerBookmarkIpc 需要可用的 ipcMain')
  }
  const handlers = createBookmarkHandlers({ store: options.store })
  for (const channel of BOOKMARK_CHANNELS) {
    ipc.handle(channel, wrapHandler(channel, handlers[channel]))
  }
  return BOOKMARK_CHANNELS
}

module.exports = {
  createBookmarkHandlers,
  registerBookmarkIpc,
  BOOKMARK_CHANNELS,
}
