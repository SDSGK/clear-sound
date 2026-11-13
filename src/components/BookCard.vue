<script>
/**
 * 模块级单例:全局唯一右键菜单状态。
 *
 * 注意:必须放在并列的 <script> 块里 —— <script setup> 的顶层代码会
 * 在「每个组件实例」中执行一次,写在 setup 里的 reactive() 并不共享,
 * 会导致右键第二张卡片时第一张的菜单仍留在页面上。
 */
import { reactive } from 'vue'
import { logAction } from '@/utils/debug'
import { formatNumber, formatBytes } from '@/utils/format'
import { cleanBookTitle } from '@/utils/book-title'

/** 全局唯一右键菜单状态 */
const menuState = reactive({
  /** 菜单是否展开 */
  visible: false,
  /** 所属卡片 id */
  bookId: null,
  /** 菜单定位 */
  left: 0,
  top: 0,
})

/** 菜单 DOM 查询选择器 */
const MENU_SELECTOR = '.book-menu'

/** 菜单尺寸估计值(用于视口边缘修正) */
const MENU_WIDTH = 168
const MENU_HEIGHT = 168

/** 全局监听器是否已绑定(避免多实例重复绑定) */
let listenersBound = false

/** 关闭所有右键菜单 */
function closeMenu() {
  menuState.visible = false
  menuState.bookId = null
}

/** 点击菜单外部时关闭 */
function onDocumentMouseDown(event) {
  const menu = document.querySelector(MENU_SELECTOR)
  if (menu && menu.contains(event.target)) return
  closeMenu()
}

/** Escape 关闭菜单 */
function onDocumentKeydown(event) {
  if (event.key === 'Escape') closeMenu()
}

/**
 * 绑定全局监听器(仅首次)
 * @returns {void}
 */
function bindGlobalListeners() {
  if (listenersBound) return
  listenersBound = true
  document.addEventListener('mousedown', onDocumentMouseDown)
  document.addEventListener('keydown', onDocumentKeydown)
  window.addEventListener('resize', closeMenu)
  window.addEventListener('scroll', closeMenu, true)
}

bindGlobalListeners()
</script>

<script setup>
/**
 * BookCard.vue —— 书架卡片
 *
 * 结构:封面渐变块 → 书名(两行截断) → 元信息 → 进度条 → 操作按钮 → 自绘右键菜单
 * 交互:
 *  - [阅读] 跳转阅读器(/reader/:bookId)
 *  - [听书] 触发听书(由父级 LibraryView 负责跳转并附带 autoplay 参数),
 *    当父级传入的 listeningBookId 命中本书时,按钮切换为「退出听书」语义
 *  - 右键卡片弹出菜单:继续阅读 / 继续收听 / 重新抓取(仅网页书) / 移除
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ElMessageBox } from 'element-plus'
import { Headset, VideoPause } from '@element-plus/icons-vue'

const props = defineProps({
  /** 书籍数据(id/title/chapters/lastPosition/sourceUrl…) */
  book: {
    type: Object,
    required: true,
  },
  /** 正在听书的书 id(由父级传入;命中本书时按钮显示「退出听书」语义) */
  listeningBookId: {
    type: [String, Number],
    default: null,
  },
})

const emit = defineEmits(['refetch', 'remove', 'open', 'listen', 'add-chapters', 'drop-files'])

/** 拖拽悬停高亮(拖到卡片 = 追加章节) */
const dropHover = ref(false)

const router = useRouter()
const { t } = useI18n()

// ------------------------------ 封面渐变板 ------------------------------

/** 8 色渐变板,按书籍 id 的哈希取色 */
const COVER_GRADIENTS = [
  ['#2f6f4e', '#43a06d'],
  ['#7a4b2a', '#b9793f'],
  ['#2f4f7a', '#4b7fb9'],
  ['#6b3a5b', '#9c5b8a'],
  ['#3f6b3f', '#6b9e5e'],
  ['#7a2f3a', '#b05566'],
  ['#3a6b6b', '#5f9e9e'],
  ['#5a5a2f', '#8f8f52'],
]

/**
 * 字符串哈希(djb2 变体,取绝对值)
 * @param {string} str 待哈希字符串
 * @returns {number}
 */
function hashString(str) {
  let hash = 0
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

/** 封面渐变背景 */
const coverBackground = computed(() => {
  const id = String(props.book && props.book.id ? props.book.id : '')
  const pair = COVER_GRADIENTS[hashString(id) % COVER_GRADIENTS.length]
  return `linear-gradient(135deg, ${pair[0]} 0%, ${pair[1]} 100%)`
})

/** 展示用书名:去掉书名号(《》等),首字符才是可读书名 */
const displayTitle = computed(() => cleanBookTitle(props.book && props.book.title))

/** 封面大字:书名首字(用清洗后的书名,避免首字符是「《」) */
const coverInitial = computed(() => {
  const chars = Array.from(displayTitle.value.trim())
  return chars.length ? chars[0] : '?'
})

/** 书的大小(如 22.4 MB);无体积数据时不显示 */
const sizeLabel = computed(() => formatBytes(props.book && props.book.sizeBytes))

// ------------------------------ 进度与元信息 ------------------------------

/** 章节总数 */
const chapterTotal = computed(() => {
  const chapters = props.book && props.book.chapters
  return Array.isArray(chapters) ? chapters.length : 0
})

/** 当前章节序号(0 基) */
const currentChapter = computed(() => {
  const pos = props.book && props.book.lastPosition
  const idx = pos && Number(pos.chapterIdx)
  return Number.isFinite(idx) && idx > 0 ? idx : 0
})

/** 阅读进度百分比(0~100) */
const progress = computed(() => {
  if (!chapterTotal.value) return 0
  const value = Math.round((currentChapter.value / chapterTotal.value) * 100)
  return Math.min(100, Math.max(0, value))
})

/** 进度条文案:0 = 未开始,100 = 已读完,中间显示百分比 */
function progressFormat(percentage) {
  if (percentage >= 100) return t('library.finished')
  if (percentage <= 0) return t('library.notStarted')
  return `${percentage}%`
}

/** 章节数文案 */
const chapterLabel = computed(() => t('library.chapterCount', { n: chapterTotal.value }))

/** 是否为网页书(可重新抓取) */
const canRefetch = computed(() => !!(props.book && props.book.sourceUrl))

// ------------------------------ 右键菜单 ------------------------------

/**
 * 打开右键菜单(全局单例:打开新卡片菜单时自动收起旧菜单)
 * @param {MouseEvent} event 鼠标事件
 * @returns {void}
 */
function onContextMenu(event) {
  const x = Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 8)
  const y = Math.min(event.clientY, window.innerHeight - MENU_HEIGHT - 8)
  menuState.left = Math.max(8, x)
  menuState.top = Math.max(8, y)
  menuState.bookId = props.book ? props.book.id : null
  menuState.visible = true
}

/** 本卡片是否持有当前菜单 */
const ownsMenu = computed(() => menuState.visible && menuState.bookId === (props.book && props.book.id))

/**
 * 本书是否正在听书(父级传入的 listeningBookId 命中本书)
 * @returns {boolean}
 */
const isListening = computed(() => {
  const listeningId = props.listeningBookId
  if (listeningId === null || listeningId === undefined || listeningId === '') return false
  const id = props.book ? props.book.id : null
  if (id === null || id === undefined) return false
  return String(listeningId) === String(id)
})

// ------------------------------ 行为 ------------------------------

/**
 * 打开阅读器
 * @returns {void}
 */
/**
 * 主体点击(封面/书名/卡片)→ 进入【章节管理页】:先看到章节列表,点章节才进阅读
 * @returns {void}
 */
function openBook() {
  closeMenu()
  const id = props.book && props.book.id
  if (!id) return
  logAction('book.open', `打开《${(props.book && props.book.title) || id}》`)
  emit('open', props.book)
}

/**
 * 「阅读」按钮 → 跳过管理页,按上次进度直接进入阅读器
 * @returns {void}
 */
function readNow() {
  closeMenu()
  const id = props.book && props.book.id
  if (!id) return
  logAction('reader.open', `直接阅读《${(props.book && props.book.title) || id}》`)
  router.push(`/reader/${id}`)
}

/**
 * 触发听书:由父级(LibraryView)负责跳转阅读器并携带 autoplay 参数
 * @returns {void}
 */
function onListen() {
  closeMenu()
  const id = props.book ? props.book.id : null
  if (id === null || id === undefined) return
  emit('listen', id)
}

/**
 * 重新抓取网页正文
 * @returns {void}
 */
function onRefetch() {
  closeMenu()
  emit('refetch', props.book)
}

/**
 * 右键菜单「添加章节文件」:由父级打开文件选择并追加到本书
 * @returns {void}
 */
function onAddChapters() {
  closeMenu()
  emit('add-chapters', props.book ? props.book.id : null)
}

/**
 * 拖拽文件到卡片 → 追加为本书章节(阻止冒泡,避免触发书架级"新书导入")
 * @param {DragEvent} event drop 事件
 */
function onCardDrop(event) {
  event.preventDefault()
  event.stopPropagation()
  const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : []
  if (files.length === 0 || !props.book) return
  emit('drop-files', { bookId: props.book.id, files })
}

/**
 * 移除书籍(二次确认)
 * @returns {Promise<void>}
 */
async function onRemove() {
  closeMenu()
  try {
    await ElMessageBox.confirm(t('library.confirmRemove'), t('library.remove'), {
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
      type: 'warning',
    })
  } catch {
    return
  }
  emit('remove', props.book)
}
</script>

<template>
  <div
    class="book-card"
    :class="{ 'is-drop-target': dropHover }"
    @click="openBook"
    @contextmenu.prevent="onContextMenu"
    @dragover.prevent="dropHover = true"
    @dragleave="dropHover = false"
    @drop="onCardDrop"
  >
    <!-- 封面 -->
    <div class="book-cover" :style="{ background: coverBackground }">
      <span class="book-cover-initial">{{ coverInitial }}</span>
    </div>

    <!-- 书名(已去书名号) -->
    <div class="book-title" :title="displayTitle">{{ displayTitle }}</div>

    <!-- 元信息:章节数 · 字数(千分位) · 大小;每段内部不折行,整行放不下时整体换行 -->
    <div class="book-meta">
      <span class="book-meta-item">{{ chapterLabel }}</span>
      <span class="book-meta-item"><span class="book-meta-dot">·</span>{{ t('library.wordCount') }} {{ formatNumber(book.wordCount) }}</span>
      <span v-if="sizeLabel" class="book-meta-item"><span class="book-meta-dot">·</span>{{ sizeLabel }}</span>
    </div>

    <!-- 进度 -->
    <el-progress
      class="book-progress"
      :percentage="progress"
      :format="progressFormat"
      :stroke-width="6"
      :show-text="true"
    />

    <!-- 操作 -->
    <div class="book-actions" @click.stop>
      <el-button type="primary" size="small" class="book-action" @click="readNow">
        {{ t('library.read') }}
      </el-button>
      <el-button
        size="small"
        class="book-action"
        :title="isListening ? t('reader.listenOff') : t('reader.listenOn')"
        @click="onListen"
      >
        <el-icon class="mr-1">
          <component :is="isListening ? VideoPause : Headset" />
        </el-icon>
        {{ isListening ? t('reader.listenOff') : t('library.listen') }}
      </el-button>
    </div>
  </div>

  <!-- 自绘右键菜单(Teleport 到 body,避免被网格容器裁剪;全局单例,同一时间只显示一个) -->
  <Teleport to="body">
    <div
      v-if="ownsMenu"
      class="book-menu"
      :style="{ left: `${menuState.left}px`, top: `${menuState.top}px` }"
      @click.stop
    >
      <button type="button" class="book-menu-item" @click="readNow">
        {{ t('library.continueReading') }}
      </button>
      <button type="button" class="book-menu-item" @click="openBook">
        {{ t('reader.catalog') }}
      </button>
      <button type="button" class="book-menu-item" @click="onListen">
        {{ t('library.listen') }}
      </button>
      <button
        v-if="canRefetch"
        type="button"
        class="book-menu-item"
        @click="onRefetch"
      >
        {{ t('library.refetch') }}
      </button>
      <button type="button" class="book-menu-item" @click="onAddChapters">
        {{ t('library.addChapters') }}
      </button>
      <div class="book-menu-separator"></div>
      <button type="button" class="book-menu-item book-menu-item--danger" @click="onRemove">
        {{ t('library.remove') }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.book-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--cs-border);
  border-radius: 12px;
  background: var(--cs-panel);
  color: var(--cs-fg);
  transition: box-shadow 0.18s ease, transform 0.18s ease, border-color 0.18s ease;
}

/* 拖拽悬停:拖到卡片 = 追加章节 */
.book-card.is-drop-target {
  border-color: #1d7a55;
  box-shadow: 0 0 0 2px rgba(29, 122, 85, 0.35);
}
.book-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.12);
}

.book-cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 148px;
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
  overflow: hidden;
}
.book-cover::after {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 10px;
  background: rgba(0, 0, 0, 0.16);
}
.book-cover-initial {
  font-family: 'Kaiti SC', 'STKaiti', 'KaiTi', serif;
  font-size: 56px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.94);
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
  line-height: 1;
}

.book-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  min-height: 2.8em;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.book-meta {
  display: flex;
  align-items: center;
  /* 整行放不下时整体换行(而不是把每段压到段内折行) */
  flex-wrap: wrap;
  gap: 0 6px;
  font-size: 12px;
  opacity: 0.62;
}
.book-meta-item {
  display: inline-flex;
  align-items: center;
  /* 数字与单位不拆行:「1 章」「18.6 MB」不会被断成两行 */
  white-space: nowrap;
  flex: none;
}
.book-meta-dot {
  opacity: 0.6;
  margin-right: 4px;
}

.book-progress {
  margin: 2px 0;
}

.book-actions {
  display: flex;
  gap: 8px;
  margin-top: 2px;
}
.book-action {
  flex: 1;
  margin-left: 0;
}

/* 右键菜单(挂在 body 下,样式需用非 scoped 选择器) */
:global(.book-menu) {
  position: fixed;
  z-index: 3000;
  min-width: 152px;
  padding: 4px;
  border: 1px solid var(--cs-border);
  border-radius: 8px;
  background: var(--cs-panel);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.22);
}
:global(.book-menu-item) {
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--cs-fg);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
:global(.book-menu-item:hover) {
  background: rgba(64, 158, 255, 0.14);
}
:global(.book-menu-item--danger) {
  color: #f56c6c;
}
:global(.book-menu-item--danger:hover) {
  background: rgba(245, 108, 108, 0.14);
}
:global(.book-menu-separator) {
  height: 1px;
  margin: 4px 6px;
  background: var(--cs-border);
}
</style>
