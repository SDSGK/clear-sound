<script>
/**
 * 当前在听的书 id(模块级单例)。
 *
 * 注意:必须放在并列的 <script> 块里 —— <script setup> 的顶层代码会
 * 在「每个组件实例」中执行一次,写在 setup 里的 ref() 并不共享。
 * 这里用模块级 ref 的原因:点击「听书」后路由跳到阅读器,LibraryView 会被卸载,
 * 组件级 ref 随之丢失,返回书架时卡片按钮无法保持「退出听书」态。
 * 与 BookCard.vue 的右键菜单状态采用同一模式。
 */
import { shallowRef } from 'vue'

/** 正在听书的书 id(null = 没有书在听) */
const listeningBookId = shallowRef(null)
</script>

<script setup>
/**
 * LibraryView.vue —— 书架页
 *
 * 结构:工具栏(搜索 / 导入本地文件 / 导入网页链接 / 排序)+ 卡片网格 + 空状态 + 底部状态栏
 * 数据:useBooksStore()(t02 交付)—— books / loading / load / importFiles / importUrl / refetch / remove
 * 听书入口:卡片「听书」按钮 / 右键菜单「听书」→ 跳转 /reader/:bookId?autoplay=1
 *           (阅读器侧由 t07 消费 autoplay 参数,本视图只负责发 query)
 */
import { computed, onMounted, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Link, Loading, Plus, Search } from '@element-plus/icons-vue'
import { useBooksStore } from '@/stores/books'
import readAsArrayBuffer from '@/utils/file-read'
import { logAction } from '@/utils/debug'
import { cleanBookTitle } from '@/utils/book-title'
import BookCard from '@/components/BookCard.vue'
import ImportUrlDialog from '@/components/ImportUrlDialog.vue'

const { t, locale } = useI18n()
const booksStore = useBooksStore()
const router = useRouter()

// ------------------------------ 界面状态 ------------------------------

/** 搜索关键字 */
const keyword = ref('')
/** 排序方式:'addedAt'(加入时间降序) / 'title'(书名) */
const sortBy = ref('addedAt')
/** 是否正在导入本地文件(全页 loading 遮罩) */
const importing = ref(false)
/** 文件选择器模式:'books'(每文件一本书)/ 'merge'(合并为一本)/ 'append'(追加章节) */
const pickerMode = ref('books')
/** 追加章节的目标书 id(pickerMode='append' 时使用) */
const appendTargetId = ref('')
/** 网页导入弹窗是否可见 */
const urlDialogVisible = ref(false)
/** 新建书弹窗 */
const createVisible = ref(false)
const createTitle = ref('')

async function confirmCreateBook() {
  try {
    const book = await booksStore.createBook(createTitle.value)
    createVisible.value = false
    ElMessage.success(t('book.created'))
    // 新建成功后自动进入该书的章节管理页(空书 → 面板内引导导入章节)
    if (book && book.id) router.push(`/manage/${book.id}`)
  } catch (err) {
    ElMessage.error(`${t('common.error')}: ${(err && err.message) || ''}`)
    logAction('book.createFailed', `新建书失败:${(err && err.message) || ''}`)
  }
}
/** 隐藏的文件选择 input */
const fileInputRef = useTemplateRef('fileInputRef')

/**
 * 排序选项文案。
 * 说明:src/locales 未提供 library.sort* 词条(写域限制不可改 locales),
 * 这里用 vue-i18n 的「key + 默认消息」机制,按当前 locale 给出回退文案。
 */
const sortLabels = computed(() => {
  if (locale.value === 'en-US') {
    return { addedAt: 'Recently added', title: 'Title' }
  }
  return { addedAt: '按加入时间', title: '按书名' }
})

// ------------------------------ 派生数据 ------------------------------

/** 时间戳归一化(兼容数字 / 数字字符串 / ISO 字符串) */
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

/** 书籍作者(可能不存在) */
function getAuthor(book) {
  if (!book) return ''
  if (typeof book.author === 'string') return book.author
  if (book.meta && typeof book.meta.author === 'string') return book.meta.author
  return ''
}

/** 搜索 + 排序后的可见书籍 */
const visibleBooks = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  const list = booksStore.books.filter((book) => {
    if (!query) return true
    const title = cleanBookTitle(book && book.title).toLowerCase()
    const author = getAuthor(book).toLowerCase()
    return title.includes(query) || author.includes(query)
  })
  if (sortBy.value === 'title') {
    return list.sort((a, b) =>
      cleanBookTitle(a && a.title).localeCompare(cleanBookTitle(b && b.title)),
    )
  }
  return list.sort((a, b) => toTimestamp(b && b.addedAt) - toTimestamp(a && a.addedAt))
})

/** 书架是否为空(无任何书籍) */
const isShelfEmpty = computed(() => booksStore.books.length === 0)

// ------------------------------ 行为 ------------------------------

/** 拉取书库列表 */
async function loadBooks() {
  try {
    await booksStore.load()
  } catch (err) {
    ElMessage.error(`${t('common.error')}: ${(err && err.message) || ''}`)
  }
}

/**
 * 触发文件选择器(每文件一本书)
 */
function openFilePicker() {
  pickerMode.value = 'books'
  const input = fileInputRef.value
  if (input) input.click()
}

/**
 * 触发文件选择器:多选章节文件合并为一本书
 */
function openMergePicker() {
  pickerMode.value = 'merge'
  const input = fileInputRef.value
  if (input) input.click()
}

/**
 * 触发文件选择器:向指定书追加章节文件
 * @param {string} bookId 目标书 id
 */
function openAppendPicker(bookId) {
  if (!bookId) return
  pickerMode.value = 'append'
  appendTargetId.value = String(bookId)
  const input = fileInputRef.value
  if (input) input.click()
}

/**
 * 合并导入为一本书
 * @param {File[]} files 文件列表
 * @returns {Promise<void>}
 */
async function importMerged(files) {
  importing.value = true
  try {
    const result = await booksStore.importMergedFiles(files)
    if (result.failed && result.failed.length > 0) {
      const detail = result.failed.map((f) => `${f.fileName}(${f.error})`).join('; ')
      ElMessage({ message: `${t('library.mergeFailed')}: ${detail}`, type: 'error', duration: 8000, showClose: true })
    } else if (result.book) {
      ElMessage.success(t('library.mergeDone', { n: files.length }))
      logAction('book.mergeImport', `合并导入 ${files.length} 个文件 → 《${result.book.title}》`)
    }
  } catch (err) {
    ElMessage({ message: `${t('library.mergeFailed')}: ${(err && err.message) || ''}`, type: 'error', duration: 8000, showClose: true })
  } finally {
    importing.value = false
  }
}

/**
 * 向已有书追加章节文件
 * @param {string} bookId 目标书 id
 * @param {File[]} files 文件列表
 * @returns {Promise<void>}
 */
async function appendToBook(bookId, files) {
  importing.value = true
  try {
    const result = await booksStore.appendFiles(bookId, files)
    if (result.failed && result.failed.length > 0) {
      const detail = result.failed.map((f) => `${f.fileName}(${f.error})`).join('; ')
      ElMessage({ message: `${t('library.appendFailed')}: ${detail}`, type: 'error', duration: 8000, showClose: true })
    } else {
      ElMessage.success(t('library.appendDone', { n: result.added }))
      logAction('book.appendChapters', `追加 ${result.added} 章到《${bookId}》`)
    }
  } catch (err) {
    ElMessage({ message: `${t('library.appendFailed')}: ${(err && err.message) || ''}`, type: 'error', duration: 8000, showClose: true })
  } finally {
    importing.value = false
  }
}

/**
 * 卡片拖拽追加(drop-files 事件):过滤支持格式后走 append
 * @param {{bookId: string, files: File[]}} payload 卡片拖下的文件
 * @returns {void}
 */
function onCardDropFiles({ bookId, files }) {
  const supported = (files || []).filter((f) => /\.(txt|md|epub)$/i.test(f.name))
  if (supported.length === 0) {
    ElMessage.warning(t('library.dropInvalid'))
    return
  }
  appendToBook(bookId, supported)
}

/**
 * 批量导入文件(文件选择器入口,File 对象在事件上下文内)
 * @param {File[]} files 文件列表
 */
async function importFileList(files) {
  importing.value = true
  try {
    const result = await booksStore.importFiles(files)
    if (result && result.failed && result.failed.length > 0) {
      // 带上每个文件的具体失败原因,便于定位(编码/解析/写入环节)
      const detail = result.failed.map((f) => `${f.fileName}(${f.error})`).join('; ')
      ElMessage({ message: `${t('library.importFailed')}: ${detail}`, type: 'error', duration: 8000, showClose: true })
    }
  } catch (err) {
    ElMessage({ message: `${t('library.importFailed')}: ${(err && err.message) || ''}`, type: 'error', duration: 8000, showClose: true })
  } finally {
    importing.value = false
  }
}

/**
 * 拖拽导入:必须在 drop 事件上下文内【立即读取】文件内容。
 * 跨 App 拖拽的 File 句柄在事件结束后可能失效(InvalidStateError),
 * 因此这里先读成 ArrayBuffer,读取失败时降级为「磁盘真实路径 → 主进程代读」,
 * 再把 { name, buffer } / { name, path } 交给导入链路。
 * @param {File[]} files 支持格式的文件列表
 */
/**
 * 拖拽导入:优先在 drop 事件上下文内读取内容;
 * Web File 读取失败(跨 App 拖拽句柄受限,InvalidStateError / 方法缺失)时,
 * 降级为「webUtils 取磁盘真实路径 → 主进程 fs 代读」,绕开 Web 层限制。
 * @param {File[]} files 支持格式的文件列表
 */
async function importDroppedFiles(files) {
  importing.value = true
  logAction('book.dropImport', `拖拽导入 ${files.length} 个文件`)
  try {
    const entries = []
    for (const file of files) {
      try {
        // readAsArrayBuffer:标准 arrayBuffer() 优先,残缺 File 对象降级 FileReader
        entries.push({ name: file.name, buffer: await readAsArrayBuffer(file) })
      } catch (readErr) {
        // 降级:取拖拽文件的真实磁盘路径,由主进程 fs 代读
        try {
          const filePath = window.cs.getPathForFile(file)
          if (!filePath) throw new Error('PATH_UNAVAILABLE')
          entries.push({ name: file.name, path: filePath })
        } catch (pathErr) {
          ElMessage({
            message: `${file.name}(${(pathErr && pathErr.message) || (readErr && readErr.message) || t('common.error')})`,
            type: 'error',
            duration: 8000,
            showClose: true,
          })
        }
      }
    }
    if (entries.length === 0) return
    const result = await booksStore.importFiles(entries)
    if (result && result.failed && result.failed.length > 0) {
      const detail = result.failed.map((f) => `${f.fileName}(${f.error})`).join('; ')
      ElMessage({ message: `${t('library.importFailed')}: ${detail}`, type: 'error', duration: 8000, showClose: true })
    }
  } catch (err) {
    ElMessage({ message: `${t('library.importFailed')}: ${(err && err.message) || ''}`, type: 'error', duration: 8000, showClose: true })
  } finally {
    importing.value = false
  }
}

/**
 * 文件选择器 change 事件
 * @param {Event} event input 的 change 事件
 */
function onFilesSelected(event) {
  const input = event.target
  const files = input && input.files ? Array.from(input.files) : []
  if (files.length === 0) {
    if (input) input.value = ''
    return
  }
  let task
  if (pickerMode.value === 'merge') {
    task = importMerged(files)
  } else if (pickerMode.value === 'append') {
    task = appendToBook(appendTargetId.value, files)
  } else {
    task = importFileList(files)
  }
  Promise.resolve(task).finally(() => {
    if (input) input.value = ''
  })
}

// ------------------------------ 拖拽导入 ------------------------------

/** 拖拽悬停深度(enter/leave 计数,避免子元素抖动) */
const dragDepth = ref(0)
/** 是否显示拖拽遮罩 */
const isDragOver = computed(() => dragDepth.value > 0)

function onDragEnter() {
  dragDepth.value += 1
}

/** dragover 必须阻止默认,否则允许放置判定不成立 */
function onDragOver(event) {
  event.preventDefault()
}

function onDragLeave() {
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}

/**
 * 放下文件:过滤支持的格式后在事件上下文内立即读取并导入
 * @param {DragEvent} event drop 事件
 */
function onDrop(event) {
  event.preventDefault()
  dragDepth.value = 0
  const dropped = event.dataTransfer ? Array.from(event.dataTransfer.files) : []
  const supported = dropped.filter((f) => /\.(txt|md|epub)$/i.test(f.name))
  if (supported.length === 0) {
    if (dropped.length > 0) ElMessage.warning(t('library.dropInvalid'))
    return
  }
  importDroppedFiles(supported)
}

/**
 * 重新抓取网页书正文
 * @param {object} book 书籍
 * @returns {Promise<void>}
 */
async function onRefetch(book) {
  if (!book || !book.id) return
  try {
    await booksStore.refetch(book.id)
    logAction('book.refetch', `重新抓取网页正文《${book.title || book.id}》`)
  } catch (err) {
    ElMessage({ message: `${t('library.importFailed')}: ${(err && err.message) || ''}`, type: 'error', duration: 8000, showClose: true })
  }
}

/**
 * 主体点击 → 打开【章节管理页】(先看章节列表,点章节才进阅读)
 * @param {object} book 书籍
 * @returns {void}
 */
function openManage(book) {
  const id = book && book.id
  if (!id) return
  logAction('book.openManage', `打开章节管理《${(book && book.title) || id}》`)
  router.push(`/manage/${id}`)
}

/**
 * 触发听书:跳转阅读器并携带 autoplay=1(阅读器侧据此从上次位置开播)
 * @param {string|number} bookId 书籍 id
 * @returns {Promise<void>}
 */
function handleListen(bookId) {
  const id = bookId === null || bookId === undefined ? '' : String(bookId)
  if (!id) return
  // 记录当前在听的书,用于卡片按钮的「退出听书」态切换
  listeningBookId.value = id
  logAction('player.listen', `进入听书《${id}》`)
  router.push({ path: `/reader/${id}`, query: { autoplay: '1' } })
}

/**
 * 移除书籍
 * @param {object} book 书籍
 * @returns {Promise<void>}
 */
async function onRemove(book) {
  if (!book || !book.id) return
  try {
    await booksStore.remove(book.id)
    logAction('book.remove', `移除书籍《${book.title || book.id}》`)
  } catch (err) {
    ElMessage.error(`${t('common.error')}: ${(err && err.message) || ''}`)
    logAction('book.removeFailed', `移除书籍失败:${(err && err.message) || ''}`)
  }
}

onMounted(loadBooks)
</script>

<template>
  <div
    class="library-view"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- 工具栏 -->
    <div class="library-toolbar">
      <el-input
        v-model="keyword"
        class="library-search"
        :placeholder="t('library.searchPlaceholder')"
        clearable
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>

      <div class="library-toolbar-actions">
        <el-button @click="createVisible = true">📚 {{ t('book.create') }}</el-button>
        <el-button type="primary" @click="openFilePicker">
          <el-icon class="mr-1"><Plus /></el-icon>
          {{ t('library.importLocal') }}
        </el-button>
        <el-button @click="openMergePicker" :title="t('library.mergeImport')">
          <el-icon class="mr-1"><Plus /></el-icon>
          {{ t('library.mergeImport') }}
        </el-button>
        <el-button @click="urlDialogVisible = true">
          <el-icon class="mr-1"><Link /></el-icon>
          {{ t('library.importUrl') }}
        </el-button>
        <el-select v-model="sortBy" class="library-sort">
          <el-option :label="sortLabels.addedAt" value="addedAt"></el-option>
          <el-option :label="sortLabels.title" value="title"></el-option>
        </el-select>
      </div>
    </div>

    <!-- 隐藏的文件选择 input -->
    <input
      ref="fileInputRef"
      type="file"
      multiple
      accept=".txt,.md,.epub"
      class="library-file-input"
      @change="onFilesSelected"
    />

    <!-- 书架内容 -->
    <div class="library-content">
      <el-empty v-if="isShelfEmpty" :description="t('library.emptyShelf')"></el-empty>

      <el-empty
        v-else-if="visibleBooks.length === 0"
        :description="t('library.emptyShelf')"
      ></el-empty>

      <div v-else class="library-grid">
        <BookCard
          v-for="book in visibleBooks"
          :key="book.id"
          :book="book"
          :listening-book-id="listeningBookId"
          @refetch="onRefetch"
          @remove="onRemove"
          @listen="handleListen"
          @add-chapters="openAppendPicker"
          @drop-files="onCardDropFiles"
          @open="openManage"
        ></BookCard>
      </div>
    </div>

    <!-- 底部状态栏 -->
    <div class="library-status">
      <span>{{ t('library.shelfCount', { n: booksStore.books.length }) }}</span>
    </div>

    <!-- 网页导入弹窗 -->
    <ImportUrlDialog v-model:visible="urlDialogVisible"></ImportUrlDialog>

    <!-- 新建书(空目录,先建壳再导入章节) -->
    <el-dialog v-model="createVisible" :title="t('book.create')" width="420px" append-to-body>
      <el-input
        v-model="createTitle"
        :placeholder="t('book.createPlaceholder')"
        maxlength="80"
        @keyup.enter="confirmCreateBook"
      />
      <template #footer>
        <el-button @click="createVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button
          type="primary"
          :disabled="!createTitle.trim()"
          @click="confirmCreateBook"
        >
          {{ t('book.create') }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 拖拽悬浮遮罩(导入进行中不显示,避免与导入弹窗叠加) -->
    <div v-if="isDragOver && !importing" class="drop-overlay">
      <div class="drop-overlay-card">{{ t('library.dropToImport') }}</div>
    </div>

    <!-- 导入进行中:全屏遮罩,期间禁止一切操作,直到导入真正完成才撤下。
         (否则用户会在导入尚未落盘时继续操作,误以为已导入完成) -->
    <div v-if="importing" class="import-overlay">
      <div class="import-overlay-card">
        <el-icon class="import-overlay-icon is-loading"><Loading /></el-icon>
        <span class="import-overlay-text">{{ t('library.importing') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.library-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  position: relative;
}

/* 拖拽悬浮遮罩 */
.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(29, 122, 85, 0.12);
  backdrop-filter: blur(1px);
}
.drop-overlay-card {
  padding: 32px 48px;
  border: 2px dashed #1d7a55;
  border-radius: 14px;
  background: var(--cs-panel);
  color: var(--cs-fg);
  font-size: 16px;
  font-weight: 600;
  pointer-events: none;
}

/* 导入进行中的全屏遮罩:挡住所有交互,直到导入真正完成才撤下 */
.import-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--cs-bg, #fff) 55%, transparent);
  backdrop-filter: blur(2px);
}

.import-overlay-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 28px 40px;
  border-radius: 14px;
  background: var(--cs-panel);
  border: 1px solid var(--cs-border, rgba(0, 0, 0, 0.08));
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
}

.import-overlay-icon {
  font-size: 30px;
  color: var(--el-color-primary, #409eff);
}

.import-overlay-text {
  font-size: 14px;
  font-weight: 600;
  color: var(--cs-fg, #333);
}

.library-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px 8px;
}
.library-search {
  max-width: 280px;
}
.library-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.library-sort {
  width: 140px;
}

.library-file-input {
  display: none;
}

.library-content {
  flex: 1;
  overflow: auto;
  padding: 4px 20px 16px;
}

.library-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(172px, 1fr));
  gap: 10px;
}

.library-status {
  padding: 8px 20px 12px;
  border-top: 1px solid var(--cs-border);
  font-size: 12px;
  opacity: 0.65;
}
</style>
