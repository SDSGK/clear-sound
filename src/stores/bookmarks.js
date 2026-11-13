/**
 * bookmarks.js —— 书签 Pinia store(渲染层,PLAN §4.8)
 *
 * 书签定位到段落:{ bookId, chapterIdx, paraIdx, excerpt }
 * 主进程同位置幂等(重复添加返回已有书签)。
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'
import { logAction } from '@/utils/debug'

/** 调用主进程 IPC;失败统一 throw Error */
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

export const useBookmarksStore = defineStore('bookmarks', () => {
  /** 当前书的书签列表(createdAt 降序) */
  const list = ref([])
  /** 列表当前对应的 bookId */
  const loadedBookId = ref('')

  /** 拉取某本书的书签 */
  async function load(bookId) {
    if (!bookId) {
      list.value = []
      loadedBookId.value = ''
      return
    }
    const res = await invoke('bookmark:list', { bookId })
    const items = Array.isArray(res.bookmarks) ? res.bookmarks : []
    items.sort((a, b) => String(b && b.createdAt).localeCompare(String(a && a.createdAt)))
    list.value = items
    loadedBookId.value = String(bookId)
  }

  /**
   * 添加书签(主进程同位置幂等)
   * @param {{bookId: string, chapterIdx: number, paraIdx: number, excerpt: string}} payload
   * @returns {Promise<object>} 书签
   */
  async function add(payload) {
    const res = await invoke('bookmark:add', payload)
    const bookmark = res.bookmark
    if (bookmark && loadedBookId.value === String(payload.bookId)) {
      // 本地插入并保持降序;已存在的场景不重复插入
      if (!res.existed && !list.value.some((b) => b && b.id === bookmark.id)) {
        list.value.unshift(bookmark)
      }
    }
    return bookmark
  }

  /** 删除书签(本地同步移除) */
  async function remove(id) {
    await invoke('bookmark:remove', { id })
    list.value = list.value.filter((b) => !b || b.id !== id)
    logAction('bookmark.remove', `删除书签 #${id}`)
  }

  return { list, loadedBookId, load, add, remove }
})

export default useBookmarksStore
