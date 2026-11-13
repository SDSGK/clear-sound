<script setup>
/**
 * ReaderView.vue —— 阅读器主视图
 *
 * 组成:
 *  - 顶栏:返回 / 书名 · 章名(进度)/ 目录 / Aa 样式 / 书签 / 听书
 *  - 主体:.reader-page(阅读主题 CSS 变量作用域,背景 --r-bg,独立于界面深浅色)
 *          内放 VirtualBook.vue(跨章虚拟滚动正文)
 *  - 侧边抽屉:CatalogDrawer(目录)、ReaderStylePanel(Aa 样式)
 *  - 右键菜单:ParagraphMenu(段落自绘菜单)
 *  - 语音模式底部控制条:PlayerBar(仅 status!=='idle' 时出现)
 *
 * 路由:/reader/:bookId?(src/main/router.js,不改)
 *      ?autoplay=1 → 书架「听书」入口:定位到上次位置后自动开始播放
 */

import { computed, nextTick, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useBooksStore } from '@/stores/books'
import { useBookmarksStore } from '@/stores/bookmarks'
import { usePlayerStore } from '@/stores/player'
import { applyReaderVars, loadSettings } from '@/utils/reader-settings'
import { logAction } from '@/utils/debug'
import { formatNumber, formatBytes } from '@/utils/format'
import { cleanBookTitle } from '@/utils/book-title'
import VirtualBook from '@/components/reader/VirtualBook.vue'
import ChapterListPanel from '@/components/reader/ChapterListPanel.vue'
import ReaderStyleBar from '@/components/reader/ReaderStyleBar.vue'
import ParagraphMenu from '@/components/reader/ParagraphMenu.vue'
import PlayerBar from '@/components/reader/PlayerBar.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useBooksStore()
const bookmarksStore = useBookmarksStore()
const player = usePlayerStore()

/** 当前书籍 id(来自路由) */
const bookId = computed(() => String(route.params.bookId || ''))

/** 当前书籍元数据 */
const book = computed(() => store.books.find((b) => b && b.id === bookId.value) || null)

/** 书名 */
const bookTitle = computed(() => cleanBookTitle(book.value && book.value.title))

/** 章节清单(由 VirtualBook 载入 manifest 后回传;null = 尚未加载) */
const chapters = ref(null)
/** 书是否还没有任何章节(空书 → 显示章节管理面板) */
const chaptersEmpty = computed(() => Array.isArray(chapters.value) && chapters.value.length === 0)
/** 当前章节下标 */
const currentChapter = ref(-1)

/**
 * 起始定位章节(章节管理页点某章进来时用)。
 * -1 = 不指定,VirtualBook 按上次进度恢复。
 */
const initialChapter = computed(() => {
  const ch = Number(route.query.ch)
  return Number.isInteger(ch) && ch >= 0 ? ch : -1
})
/** 当前章节标题 */
const currentChapterTitle = ref('')
/** 当前章节序号(1 起) */
const currentIndex = ref(0)
/** 章节总数 */
const chapterTotal = ref(0)

/** Aa 样式条是否展开(内嵌,非弹窗) */
const styleVisible = ref(false)
/** 右键菜单是否展开 */
const menuVisible = ref(false)
/** 右键菜单定位与内容 */
const menuState = ref({ x: 0, y: 0, text: '', chIdx: -1, pIdx: -1 })

/**
 * 书签抽屉「跳转」:定位到指定段落(跨章加载由 VirtualBook 内部处理)
 * @param {{chapterIdx: number, paraIdx: number}} target 书签位置
 * @returns {Promise<void>}
 */
async function onBookmarkJump(target) {
  const vb = virtualBook.value
  if (!vb || typeof vb.scrollToParagraph !== 'function') return
  try {
    await vb.scrollToParagraph(target.chapterIdx, target.paraIdx, 'center')
    logAction('bookmark.jump', `跳转书签 → 第 ${target.chapterIdx + 1} 章第 ${target.paraIdx + 1} 段`)
  } catch (err) {
    ElMessage.error((err && err.message) || t('common.error'))
    logAction('bookmark.jumpFailed', `书签跳转失败:${(err && err.message) || ''}`)
  }
}

/**
 * 阅读页无书时的「选书列表」(顶栏「阅读」菜单入口)。
 *
 * 此前该路由只渲染一句空状态文案,用户点「阅读」看到的是空白页,像是功能没做。
 * 这里直接列出书架里的书,点击即进入阅读,并标出上次读到的章节。
 */
const pickerBooks = computed(() => {
  const list = Array.isArray(store.books) ? store.books : []
  return list.filter((b) => b && b.id)
})

/**
 * 进入某本书的阅读(带上上次进度)
 * @param {object} book 书籍
 * @returns {void}
 */
function openBook(book) {
  if (!book || !book.id) return
  logAction('reader.open', `阅读页选书:《${book.title || book.id}》`)
  router.push({ path: `/reader/${book.id}`, query: { autoplay: '1' } })
}

/**
 * 书的「上次读到第几章」文案
 * @param {object} book 书籍
 * @returns {string}
 */
function lastReadLabel(book) {
  const idx = book && book.lastPosition ? Number(book.lastPosition.chapterIdx) : -1
  if (!Number.isFinite(idx) || idx < 0) return t('reader.neverRead')
  return t('reader.lastReadAt', { n: idx + 1 })
}

/**
 * 阅读区元素(CSS 变量作用域)
 */
const readerPage = ref(null)
/** VirtualBook 组件实例(用于跳转章节) */
const virtualBook = ref(null)

/** 阅读设置(单一数据源,持久化在 localStorage) */
const settings = ref(loadSettings())

/**
 * 书库是否已就绪。
 * VirtualBook 需要读 store.books 里的 lastPosition 来恢复进度,
 * 而子组件 onMounted 先于父组件 onMounted 执行,
 * 因此必须等 store.load() 结束后再挂载 VirtualBook,否则恢复进度永远读不到。
 */
const storeReady = ref(false)

/**
 * 语音模式是否开启(player.status !== 'idle')
 */
const voiceMode = computed(() => player.status !== 'idle')

/**
 * 听书按钮是否为「正在听」状态
 */
const isListening = computed(() => voiceMode.value)

/**
 * 听书按钮 title
 */
const listenTitle = computed(() => (isListening.value ? t('reader.listenOff') : t('reader.listenOn')))

/**
 * 听书按钮图标(播放中显示停止符)
 */
const listenIcon = computed(() => (isListening.value ? '■' : '▶'))

/**
 * 当前视口顶段位置(VirtualBook 定位完成后回报)
 */
const viewportPos = ref(null)

/**
 * 是否已按 autoplay 参数自动开播(只做一次)
 */
let autoplayDone = false

/**
 * 阅读区底部占位高度(控制条出现时避免遮挡正文)
 */
const PLAYER_BAR_HEIGHT = 44

/**
 * 把阅读设置写进 .reader-page 的 CSS 变量
 * @param {object} s 设置对象
 * @returns {void}
 */
function applyVars(s) {
  if (readerPage.value) applyReaderVars(readerPage.value, s)
}

/**
 * VirtualBook 报告当前章节变化 → 更新顶栏
 * @param {{chIdx: number, title: string, index: number, total: number}} info 章节信息
 * @returns {void}
 */
function onChapterChange(info) {
  if (!info) return
  currentChapter.value = info.chIdx
  currentChapterTitle.value = info.title
  currentIndex.value = info.index
  chapterTotal.value = info.total
}

/**
 * VirtualBook 载入 manifest → 回传章节清单(目录抽屉用)
 * @param {object[]} list 章节清单
 * @returns {void}
 */
function onManifest(list) {
  chapters.value = Array.isArray(list) ? list : []
}

/**
 * 目录点击某章 → 跳转
 * @param {number} idx 章节下标
 * @returns {void}
 */
function onChapterSelect(idx) {
  logAction('reader.chapter', `切换到第 ${idx + 1} 章`)
  if (virtualBook.value && typeof virtualBook.value.gotoChapter === 'function') {
    virtualBook.value.gotoChapter(idx, 'start')
  }
}

/**
 * 章节管理:删除某一章(OPFS 重排 + 主进程元数据覆写),并刷新渲染
 * @param {number} idx 章节下标
 * @returns {Promise<void>}
 */
async function onChapterRemove(idx) {
  try {
    await store.removeChapter(bookId.value, idx)
    if (virtualBook.value && typeof virtualBook.value.reload === 'function') {
      virtualBook.value.reload()
    }
  } catch (err) {
    ElMessage.error((err && err.message) || t('common.error'))
  }
}

/**
 * 章节管理:重命名某章(三处同步),刷新渲染与顶栏章名
 * @param {{idx: number, title: string}} payload 新标题与位置
 * @returns {Promise<void>}
 */
async function onChapterRename(payload) {
  try {
    await store.renameChapter(bookId.value, payload.idx, payload.title)
    if (virtualBook.value && typeof virtualBook.value.reload === 'function') {
      virtualBook.value.reload()
    }
  } catch (err) {
    ElMessage.error((err && err.message) || t('common.error'))
  }
}

/**
 * 段落右键 → 打开菜单
 * @param {{x: number, y: number, text: string, chIdx: number, pIdx: number}} payload 段落信息
 * @returns {void}
 */
function onParagraphContext(payload) {
  if (!payload) return
  menuState.value = {
    x: payload.x,
    y: payload.y,
    text: payload.text,
    chIdx: Number(payload.chIdx),
    pIdx: Number(payload.pIdx),
  }
  menuVisible.value = true
}

/**
 * 关闭右键菜单
 * @returns {void}
 */
function closeMenu() {
  menuVisible.value = false
}

/**
 * 样式变更 → 更新设置 + 热更 CSS 变量
 * @param {object} next 新设置
 * @returns {void}
 */
function onSettingsChange(next) {
  settings.value = { ...next }
  applyVars(settings.value)
  logAction('reader.style', `阅读样式:字体=${settings.value.fontFamily || '-'} 字号=${settings.value.fontSize || '-'} 主题=${settings.value.theme || '-'}`)
}

/**
 * 返回书架
 * @returns {void}
 */
/**
 * 返回:章节管理页进入的阅读器 → 回管理页;否则回书架
 */
function goBack() {
  if (String(route.query.from || '') === 'manage') {
    router.push(`/manage/${bookId.value}`)
    return
  }
  router.push('/')
}

/**
 * 顶栏「听书」按钮:进入 / 退出语音模式
 *
 * 未在听 → 拉取引擎列表,从当前视口顶段开始播放;
 * 在听 → 停止播放(进度保留)。
 * @returns {Promise<void>}
 */
async function toggleListen() {
  if (isListening.value) {
    logAction('player.stopListen', '退出听书')
    player.stop()
    return
  }
  // 优先用当前实时视口位置(滚动后位置会变),回落到最近一次定位时的位置
  const pos = currentViewportPosition() || viewportPos.value
  if (!pos) return
  try {
    await player.initEngines()
    await player.playFrom(bookId.value, pos.chIdx, pos.pIdx)
    // store 的 playFrom 会把失败转成 status='error' 而不是 throw。
    // 这里**不** stop():保留 error 状态,让控制条继续显示失败原因与「切换引擎重试」,
    // 同时弹提示告知用户(否则 stop 会让控制条消失,用户毫无反馈)。
    if (player.status === 'error') {
      ElMessage.error(t('reader.ttsFailed'))
    }
  } catch {
    ElMessage.error(t('reader.ttsFailed'))
    player.stop()
  }
}

/**
 * 取当前视口顶段位置(VirtualBook 未就绪时返回 null)
 * @returns {{chIdx: number, pIdx: number} | null}
 */
function currentViewportPosition() {
  const vb = virtualBook.value
  if (vb && typeof vb.viewportPosition === 'function') return vb.viewportPosition()
  return null
}

/**
 * VirtualBook 定位完成 → 记录起始位置;并尝试 autoplay
 * @param {{chIdx: number, pIdx: number}} pos 视口顶段位置
 * @returns {Promise<void>}
 */
async function onPositioned(pos) {
  viewportPos.value = pos
  await maybeAutoplay()
}

/**
 * autoplay=1(书架「听书」入口)→ 定位完成后自动开播
 * @returns {Promise<void>}
 */
async function maybeAutoplay() {
  if (autoplayDone) return
  const autoplay = String(route.query.autoplay || '')
  if (autoplay !== '1') return
  const pos = viewportPos.value || currentViewportPosition()
  if (!pos) return
  autoplayDone = true
  try {
    await player.initEngines()
    await player.playFrom(bookId.value, pos.chIdx, pos.pIdx)
    // store 的 playFrom 会把失败转成 status='error' 而不是 throw。
    // 同样**不** stop():保留 error 状态让控制条显示失败原因与「切换引擎重试」。
    if (player.status === 'error') {
      autoplayDone = false
      ElMessage.error(t('reader.ttsFailed'))
    }
  } catch {
    autoplayDone = false
    ElMessage.error(t('reader.ttsFailed'))
  }
}

/** 右侧栏:目录/书签(tab);sideOpen=false 收起(按钮再点一次即收起) */
const sideOpen = ref(false)
const sideTab = ref('catalog')

/** 目录/书签按钮:同 tab 再点 = 收起;否则打开并切到该 tab */
function toggleSidePanel(panel) {
  if (sideOpen.value && sideTab.value === panel) {
    sideOpen.value = false
    logAction('reader.panel', `收起侧栏:${panel}`)
  } else {
    sideOpen.value = true
    sideTab.value = panel
    logAction('reader.panel', `打开侧栏:${panel}`)
  }
}

/** 侧栏点章节/书签 → 跳转并收起侧栏 */
function onSideChapterSelect(idx) {
  onChapterSelect(idx)
  sideOpen.value = false
}

function onSideBookmarkJump(payload) {
  onBookmarkJump(payload)
  sideOpen.value = false
}


/**
 * 章节管理页「点某章」入口:?ch=<idx> → 定位到该章开头
 * (只做一次;与 autoplay 可叠加)
 */
let chJumpDone = false

async function jumpToQueryChapter() {
  if (chJumpDone) return
  const ch = Number(route.query.ch)
  if (!Number.isInteger(ch) || ch < 0) return
  // 等 manifest 载入完成:VirtualBook 的 chapterTotal 来自 manifest,
  // 未就绪时 chapterTotal=0 → scrollToParagraph 会因 chIdx >= chapterTotal
  // 静默返回,定位丢失(正文停在上一章/空白)。
  for (let i = 0; i < 60 && !chapters.value; i += 1) {
    await new Promise((r) => setTimeout(r, 100))
  }
  if (chapters.value && ch >= chapters.value.length) return
  chJumpDone = true
  await nextTick()
  if (virtualBook.value && typeof virtualBook.value.scrollToParagraph === 'function') {
    await virtualBook.value.scrollToParagraph(ch, 0, 'start')
  }
}

/**
 * KeepAlive 复用时(ReaderView 未卸载)重新定位到 query.ch 指定的章。
 *
 * init() 只在 bookId 变化时跑,同一本书内换章必须靠这里补跳。
 */
async function jumpToChapterByQuery() {
  const ch = Number(route.query.ch)
  if (!Number.isInteger(ch) || ch < 0) return
  // 等 manifest 就绪,否则 scrollToParagraph 会因 chapterTotal=0 静默返回
  for (let i = 0; i < 60 && !chapters.value; i += 1) {
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!chapters.value || ch >= chapters.value.length) return
  await nextTick()
  if (virtualBook.value && typeof virtualBook.value.scrollToParagraph === 'function') {
    await virtualBook.value.scrollToParagraph(ch, 0, 'start')
  }
}

function removeBookmark(bookmark) {
  logAction('bookmark.remove', `删除书签 #${bookmark.id}`)
  bookmarksStore
    .remove(bookmark.id)
    .catch((err) => ElMessage.error((err && err.message) || t('common.error')))
}

/**
 * 侧栏刷新(manifest/时长/书签)
 * @returns {Promise<void>}
 */
async function reloadBook() {
  await store.load().catch(() => {})
  await loadChapterMeta()
  if (virtualBook.value && typeof virtualBook.value.reload === 'function') {
    virtualBook.value.reload()
  }
}

/**
 * 每章时长(bookId 维度,stats:summary 返回)
 */
const chapterTimeMap = ref({})

async function loadChapterMeta() {
  try {
    const res = await window.cs.invoke('stats:summary', { range: 'day', bookId: bookId.value })
    const map = {}
    for (const item of res.chapterTime || []) map[item.chapterIdx] = item
    chapterTimeMap.value = map
  } catch {
    chapterTimeMap.value = {}
  }
}

onMounted(async () => {
  applyVars(settings.value)
  // 书库列表可能尚未载入(直接访问 /reader/:id 时),补一次
  if (!store.books.length) {
    try {
      await store.load()
    } catch {
      // 读不到书库时保持空状态,不打断阅读页
    }
  }
  await nextTick()
  applyVars(settings.value)
  // 书库就绪后再挂载正文(VirtualBook 需要 lastPosition 恢复进度)
  storeReady.value = true
  // 章节管理页「点某章」直达(query.ch)——等 VirtualBook 挂载并载入 manifest 后定位
  if (route.query.ch != null) {
    await nextTick()
    await jumpToQueryChapter()
  }
})

onDeactivated(() => {
  // KeepAlive:切到其他菜单(组件被缓存而非卸载)时同样要把进度刷给主进程,
  // 否则切回来时读到的进度是旧的。
  store.flushPositionNow()
  logAction('reader.deactivate', '阅读器切到其他菜单(已缓存)')
})

onBeforeUnmount(() => {
  // 退出阅读器时把待同步进度立刻刷给主进程
  store.flushPositionNow()
  // 【不在此 stop】网易云式「后台继续听书」:离开阅读器路由时**不**停播,
  // 播放继续,桌面歌词 / 托盘面板 / 状态栏照常跟随。
  // 副作用(预期):
  //  - VirtualBook 随组件卸载 → 段落高亮自然消失(仅高亮,不影响播放);
  //  - player.status 保持 playing/paused/error,下次进入阅读器时
  //    PlayerBar 仍显示当前播放状态,控制条可继续操作。
  // 显式停止只有一处:PlayerBar 的「退出听书」按钮(components/reader/PlayerBar.vue → onExit → player.stop())。
})

/** 设置变化 → 热更 */
watch(
  () => settings.value,
  (s) => applyVars(s),
  { deep: true },
)

/**
 * 路由 query.ch 变化 → 重新定位到该章
 *
 * ReaderView 被 KeepAlive 缓存:从章节管理页再次点某一章时组件不会重建,
 * onMounted 不再执行 → 定位逻辑不会跑,正文停在原处(看起来"点了没反应/正文空")。
 */
watch(
  () => route.query.ch,
  async (val, oldVal) => {
    if (val == null || val === oldVal) return
    chJumpDone = false
    await nextTick()
    await jumpToChapterByQuery()
  },
)

/**
 * 路由 query autoplay 变化 → 重新判定是否自动开播
 *
 * (同一路由仅 query 变化时组件不会重建,定位完成事件不会再次触发,
 *  因此这里补一次判定;书籍变化时 VirtualBook 会重新 init 并再发一次 positioned)
 */
watch(
  () => route.query.autoplay,
  async () => {
    autoplayDone = false
    await nextTick()
    await maybeAutoplay()
  },
)
</script>

<template>
  <!-- 无书籍 id → 选书列表(顶栏「阅读」入口,不再是空白页) -->
  <div v-if="!bookId" class="reader-picker h-full overflow-auto">
    <div class="picker-head">
      <h2 class="picker-title">{{ t('reader.pickBook') }}</h2>
      <p class="picker-hint">{{ t('reader.pickBookHint') }}</p>
    </div>
    <div v-if="!pickerBooks.length" class="picker-empty">
      <el-empty :description="t('reader.chooseBook')" />
    </div>
    <div v-else class="picker-grid">
      <button
        v-for="b in pickerBooks"
        :key="b.id"
        type="button"
        class="picker-card"
        @click="openBook(b)"
      >
        <span class="picker-card-title truncate">{{ cleanBookTitle(b.title) || t('common.unknown') }}</span>
        <span class="picker-card-meta">
          {{ t('reader.chapterCount', { n: (b.chapters || []).length }) }} ·
          {{ t('library.wordCount') }} {{ formatNumber(b.wordCount) }} ·
          {{ formatBytes(b.sizeBytes) || '—' }} ·
          {{ lastReadLabel(b) }}
        </span>
      </button>
    </div>
  </div>

  <!-- 阅读器主体:合并顶栏(书的操作靠标题侧 + App 菜单移右侧) -->
  <div v-else class="reader-shell h-full flex flex-col">
    <!-- 书内工具条:补充到 App 顶栏(logo 右侧),App 顶栏本身常驻不隐藏 -->
    <Teleport to="#topbar-extra">
      <div class="reader-extra flex items-center gap-2 min-w-0">
        <el-button text class="reader-back" @click="goBack">← {{ t('common.back') }}</el-button>
        <span class="reader-book-title truncate">{{ bookTitle }}</span>
        <span v-if="currentChapterTitle" class="reader-chapter-title truncate">· {{ currentChapterTitle }}</span>
        <span class="reader-progress">({{ t('reader.chapterProgress', { cur: currentIndex, total: chapterTotal }) }})</span>
        <el-button
          size="small"
          :type="sideOpen && sideTab === 'catalog' ? 'primary' : ''"
          @click="toggleSidePanel('catalog')"
        >
          {{ t('reader.catalog') }}
        </el-button>
        <el-button
          size="small"
          :type="sideOpen && sideTab === 'bookmarks' ? 'primary' : ''"
          @click="toggleSidePanel('bookmarks')"
        >
          🔖 {{ t('reader.bookmark') }}
        </el-button>
        <el-button size="small" :type="styleVisible ? 'primary' : ''" @click="styleVisible = !styleVisible">
          Aa {{ t('reader.style') }}
        </el-button>
        <el-button
          size="small"
          :class="{ 'is-listening': isListening }"
          :title="listenTitle"
          @click="toggleListen"
        >
          {{ listenIcon }} {{ t('reader.listen') }}
        </el-button>
      </div>
    </Teleport>

    <!-- 阅读区:左栏(目录/书签,内嵌不遮挡)+ 正文(背景 --r-bg 独立于界面主题) -->
    <div class="reader-body flex flex-1 min-h-0">
      <!-- 内嵌右侧栏:目录 / 书签(切换),不遮挡正文;带滑出过渡 -->
      <transition name="side-slide">
      <aside v-show="sideOpen" class="reader-side flex flex-col">
        <el-tabs v-model="sideTab" class="reader-side-tabs">
          <el-tab-pane :label="t('reader.catalog')" name="catalog">
            <ChapterListPanel
              :chapters="chapters || []"
              :current-chapter="currentChapter"
              :book-id="bookId"
              @select="onSideChapterSelect"
              @rename="onChapterRename"
              @remove="onChapterRemove"
              @refresh="reloadBook"
            />
          </el-tab-pane>
          <el-tab-pane :label="t('reader.bookmark')" name="bookmarks">
            <div class="side-bookmarks">
              <el-empty
                v-if="bookmarksStore.list.length === 0"
                :description="t('reader.noBookmarks')"
                :image-size="60"
              />
              <div
                v-for="bm in bookmarksStore.list"
                :key="bm.id"
                class="side-bookmark"
                role="button"
                tabindex="0"
                @click="onSideBookmarkJump({ chapterIdx: bm.chapterIdx, paraIdx: bm.paraIdx })"
              >
                <div class="side-bookmark-excerpt">{{ bm.excerpt || '…' }}</div>
                <div class="side-bookmark-meta">
                  <span>{{ bm.chapterIdx + 1 }} · {{ bm.paraIdx + 1 }}</span>
                  <el-button size="small" type="danger" link @click.stop="removeBookmark(bm)">
                    {{ t('common.delete') }}
                  </el-button>
                </div>
              </div>
            </div>
          </el-tab-pane>
        </el-tabs>
      </aside>
      </transition>

      <div class="reader-main flex flex-col flex-1 min-w-0">
        <!-- Aa 样式条(内嵌,非弹窗):调整时正文实时可见 -->
        <ReaderStyleBar v-if="styleVisible" :settings="settings" :target="readerPage" @update:settings="onSettingsChange" />

        <div
          ref="readerPage"
          class="reader-page flex-1 min-h-0"
          :class="{ 'has-player-bar': voiceMode }"
          :style="voiceMode ? { paddingBottom: `${PLAYER_BAR_HEIGHT}px` } : null"
        >
          <!-- 空书:章节管理面板(导入/删除/重命名在同侧目录栏) -->
          <div v-if="chaptersEmpty" class="reader-empty-manage">
            <el-empty :description="t('book.chaptersEmpty')">
              <el-button type="primary" @click="sideOpen = true; sideTab = 'catalog'">
                {{ t('library.addChapters') }}
              </el-button>
              <div class="empty-hint">{{ t('book.hintCatalogManage') }}</div>
            </el-empty>
          </div>
          <VirtualBook
            v-if="storeReady && !chaptersEmpty"
            ref="virtualBook"
            :book-id="bookId"
            :settings="settings"
            :initial-chapter="initialChapter"
            @chapter-change="onChapterChange"
            @paragraph-context="onParagraphContext"
            @manifest="onManifest"
            @positioned="onPositioned"
          />
          <!-- 语音模式底部控制条 -->
          <PlayerBar v-if="voiceMode" />
        </div>
      </div>
    </div>

    <!-- 段落右键菜单 -->
    <ParagraphMenu
      :visible="menuVisible"
      :x="menuState.x"
      :y="menuState.y"
      :text="menuState.text"
      :ch-idx="menuState.chIdx"
      :p-idx="menuState.pIdx"
      :book-id="bookId"
      @close="closeMenu"
    />
  </div>
</template>

<style scoped>
/* ===== 顶栏:跟随界面主题(--cs-*) ===== */
.reader-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--cs-bg);
  color: var(--cs-fg);
}
.reader-empty-manage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.empty-hint {
  margin-top: 10px;
  font-size: 12px;
  opacity: 0.55;
}
.reader-chapter-input {
  display: none;
}

.reader-topbar {
  flex: none;
  height: 52px;
  background: var(--cs-panel);
  border-bottom: 1px solid var(--cs-border);
}

.reader-back {
  color: var(--cs-fg);
}

.reader-title {
  flex: 1;
  overflow: hidden;
}

.reader-book-title {
  font-size: 14px;
  font-weight: 600;
}

.reader-chapter-title {
  font-size: 13px;
  opacity: 0.75;
}

.reader-progress {
  flex: none;
  font-size: 12px;
  opacity: 0.6;
}

/* ===== 阅读区:阅读主题(--r-*) ===== */
.reader-page {
  /* --r-bg / --r-fg 等由 applyReaderVars 写到本元素上 */
  position: relative;
  background: var(--r-bg, #f4ecd8);
  color: var(--r-fg, #5b4636);
  overflow: hidden;
}

/* 语音模式:底部预留控制条高度(由 :style 动态写入 padding-bottom),避免遮挡正文 */
.reader-page.has-player-bar {
  /* 控制条绝对定位在 bottom:0,落在 padding-bottom 预留的空位内 */
}

/* 听书按钮激活态 */
.reader-actions .is-listening {
  color: var(--el-color-primary, #409eff);
  font-weight: 600;
}

/* ===== 空状态 ===== */
.reader-empty {
  background: var(--cs-bg);
  color: var(--cs-fg);
}

/* ===== 阅读页选书列表(顶栏「阅读」入口) ===== */
.reader-picker {
  background: var(--cs-bg);
  color: var(--cs-fg);
  padding: 14px 16px;
}

.picker-head {
  margin-bottom: 14px;
}

.picker-title {
  margin: 0 0 4px;
  font-size: 17px;
  font-weight: 700;
}

.picker-hint {
  margin: 0;
  font-size: 12px;
  opacity: 0.55;
}

.picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.picker-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 11px 13px;
  text-align: left;
  border: 1px solid var(--cs-border, rgba(0, 0, 0, 0.08));
  border-radius: 8px;
  background: var(--cs-panel);
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: border-color 140ms ease, transform 140ms ease;
}

.picker-card:hover {
  border-color: var(--el-color-primary, #409eff);
  transform: translateY(-1px);
}

.picker-card-title {
  font-size: 14px;
  font-weight: 600;
}

.picker-card-meta {
  font-size: 11px;
  opacity: 0.55;
  /* 自然换行:选书页这段还含「上次读到第 X 章」,截断会丢掉该信息 */
  line-height: 1.6;
}

/* ===== 右侧栏(目录/书签):不遮挡正文,滑出过渡 ===== */
.reader-body {
  display: flex;
  flex-direction: row;
  overflow: hidden;
}
.reader-body .reader-main {
  order: 1;
}
.reader-body .reader-side {
  order: 2;
  flex: none;
  width: 300px;
  overflow: hidden;
  background: var(--cs-panel);
  border-left: 1px solid var(--cs-border);
  transition: width 0.25s ease, opacity 0.25s ease;
}
.side-slide-enter-active,
.side-slide-leave-active {
  transition: width 0.25s ease, opacity 0.25s ease;
}
.side-slide-enter-from,
.side-slide-leave-to {
  width: 0 !important;
  opacity: 0;
}
.reader-side-tabs {
  height: 100%;
}
.reader-side-tabs :deep(.el-tabs__content) {
  padding: 0 12px 12px;
  overflow: auto;
}

/* 书签条目:与目录条目同一套视觉 */
.side-bookmarks {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.side-bookmark {
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}
.side-bookmark:hover {
  background: color-mix(in srgb, var(--cs-fg, #333) 7%, transparent);
}
.side-bookmark-excerpt {
  font-size: 13px;
  line-height: 1.6;
  color: var(--cs-fg, #333);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
.side-bookmark-meta {
  margin-top: 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  opacity: 0.6;
}

</style>
