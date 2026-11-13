<script setup>
/**
 * BookManageView.vue —— 章节管理页(/manage/:bookId)
 *
 * 交互(点书名/封面进入):先看到章节列表(分组折叠 + 每章时长/书签明细),
 * 点某个章节才进入阅读;也可「继续阅读」按上次进度直达。
 * 顶部「导入章节」单按钮:多选章节文件,逐个智能处理——
 *  识别出章节名直接添加;识别不出弹窗输入;重名分屏对比(覆盖/跳过)。
 * 管理操作:新建空章节 / 重命名 / 删除 / 单章内容替换。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { Loading } from '@element-plus/icons-vue'
import { useBooksStore } from '@/stores/books'
import ChapterListPanel from '@/components/reader/ChapterListPanel.vue'
import ChapterCompareDialog from '@/components/corrections/ChapterCompareDialog.vue'
import readAsArrayBuffer from '@/utils/file-read'
import { logAction } from '@/utils/debug'
import { formatNumber, formatBytes } from '@/utils/format'
import { cleanBookTitle } from '@/utils/book-title'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const booksStore = useBooksStore()

const bookId = computed(() => String(route.params.bookId || ''))
const book = computed(() => booksStore.books.find((b) => b && b.id === bookId.value) || null)
const chapters = computed(() => (book.value && book.value.chapters) || [])
const currentChapter = computed(() =>
  book.value && book.value.lastPosition ? book.value.lastPosition.chapterIdx : -1,
)

/** 上次读到的章节下标(-1 = 未读过) */
const lastReadIdx = computed(() => {
  const pos = book.value && book.value.lastPosition
  const idx = pos ? Number(pos.chapterIdx) : -1
  return Number.isFinite(idx) && idx >= 0 ? idx : -1
})

/** 上次读到的章节标题(标签已含「上次读到第 N 章」,这里只补章节名) */
const lastReadTitle = computed(() => {
  if (lastReadIdx.value < 0) return t('reader.neverRead')
  const ch = (book.value.chapters || [])[lastReadIdx.value]
  return (ch && ch.title) || t('reader.neverRead')
})

/** 书的大小(如 22.4 MB);无体积数据时不显示 */
const bookSize = computed(() => formatBytes(book.value && book.value.sizeBytes))

// ===== 导入章节(顶部单按钮,智能流程) =====
const importing = ref(false)
/** 导入循环中弹出模态交互(章节名输入/重名对比)时置 true:全屏遮罩撤下,让用户能操作弹窗。
 *  不撤下会死锁:遮罩 z-index 3000 盖住对话框,对话框又在等用户点选 → 互斥等待。 */
const importPaused = ref(false)
const importInputRef = ref(null)
/** 重名对比状态(promise 化,等待用户决策) */
const compare = ref({ visible: false, existing: null, incoming: null, resolve: null })

function stripExt(name) {
  return String(name || '').replace(/\.(txt|md|markdown|mdown|epub)$/i, '')
}

function askOverwrite(existing, incoming) {
  return new Promise((resolve) => {
    compare.value = { visible: true, existing, incoming, resolve }
  })
}

function onCompareConfirm() {
  if (compare.value.resolve) compare.value.resolve('overwrite')
  compare.value = { visible: false, existing: null, incoming: null, resolve: null }
}

function onCompareSkip() {
  if (compare.value.resolve) compare.value.resolve('skip')
  compare.value = { visible: false, existing: null, incoming: null, resolve: null }
}

async function ipcInvoke(channel, payload) {
  const res = await window.cs.invoke(channel, payload)
  if (!res || !res.ok) throw new Error((res && res.error) || `IPC_FAILED:${channel}`)
  return res
}

function openImportPicker() {
  const input = importInputRef.value
  if (input) input.click()
}

async function onImportFiles(event) {
  const input = event.target
  const files = input && input.files ? Array.from(input.files) : []
  if (input) input.value = ''
  if (files.length === 0 || importing.value) return
  importing.value = true
  let added = 0
  let overwritten = 0
  try {
    for (const file of files) {
      const buffer = await readAsArrayBuffer(file)
      const res = await ipcInvoke('library:parse', { fileName: file.name, buffer })
      const fileChapters = (res.bookData && res.bookData.chapters) || []

      // 多章文件:每章都有识别章题,全部直接追加
      if (fileChapters.length > 1) {
        await ipcInvoke('library:append-chapters', {
          bookId: bookId.value,
          chapters: fileChapters.map((c) => ({ title: c.title, paragraphs: c.paragraphs || [] })),
        })
        added += fileChapters.length
        continue
      }

      const chapter = fileChapters[0]
      if (!chapter) continue
      let title = String(chapter.title || '')
      const recognized = title && title !== stripExt(file.name)

      // 识别不出章节名 → 弹窗输入(默认文件名)
      if (!recognized) {
        // 弹窗期间撤下全屏遮罩(遮罩会挡住弹窗操作 → 死锁)
        importPaused.value = true
        try {
          const r = await ElMessageBox.prompt(t('catalog.chapterName'), file.name, {
            inputValue: stripExt(file.name),
            inputPattern: /\S/,
            inputErrorMessage: t('common.error'),
            confirmButtonText: t('common.confirm'),
            cancelButtonText: t('common.cancel'),
          })
          title = String(r.value || '').trim() || stripExt(file.name)
        } catch {
          continue // 用户取消 → 跳过此文件
        } finally {
          importPaused.value = false
        }
      }

      // 章节名重复 → 分屏对比,等待用户覆盖 / 跳过
      const dup = chapters.value.find((c) => c && c.title === title)
      if (dup) {
        const rd = await ipcInvoke('library:read-chapter', { bookId: bookId.value, idx: dup.idx })
        // 对比框期间撤下全屏遮罩(遮罩 z-index 3000 盖住对话框 → 用户无法选择 → 死锁)
        importPaused.value = true
        try {
          const decision = await askOverwrite(
            { title: dup.title, paragraphs: rd.data.paragraphs },
            { title, paragraphs: chapter.paragraphs || [] },
          )
          if (decision === 'overwrite') {
            await ipcInvoke('library:update-chapter', {
              bookId: bookId.value,
              idx: dup.idx,
              paragraphs: chapter.paragraphs || [],
            })
            overwritten += 1
          }
        } finally {
          importPaused.value = false
        }
        continue
      }

      // 新章节 → 追加
      await ipcInvoke('library:append-chapters', {
        bookId: bookId.value,
        chapters: [{ title, paragraphs: chapter.paragraphs || [] }],
      })
      added += 1
    }
    if (added > 0) ElMessage.success(t('library.appendDone', { n: added }))
    if (overwritten > 0) ElMessage.success(t('compare.overwritten', { n: overwritten }))
    logAction('book.importChapters', `导入章节:新增 ${added} 章,覆盖 ${overwritten} 章(《${bookId.value}》)`)
    await booksStore.load()
  } catch (err) {
    ElMessage.error(`${t('library.mergeFailed')}: ${(err && err.message) || ''}`)
  } finally {
    importing.value = false
  }
}

// ===== 章节操作(ChapterListPanel 事件) =====

function onSelectChapter(idx) {
  logAction('book.openChapter', `打开章节 #${idx}(《${bookId.value}》)`)
  router.push({ path: `/reader/${bookId.value}`, query: { ch: String(idx), from: 'manage' } })
}

/** 「继续阅读」:按上次进度直达(返回时也回管理页) */
function continueReading() {
  logAction('player.continue', `继续阅读《${bookId.value}》`)
  router.push({ path: `/reader/${bookId.value}`, query: { autoplay: '1', from: 'manage' } })
}

function onRename(payload) {
  logAction('book.renameChapter', `重命名章节 #${payload.idx} → 「${payload.title}」`)
  booksStore
    .updateChapter(bookId.value, payload.idx, { title: payload.title })
    .then(() => booksStore.load())
    .catch((err) => ElMessage.error((err && err.message) || t('common.error')))
}

function onRemove(idx) {
  logAction('book.removeChapter', `删除章节 #${idx}(《${bookId.value}》)`)
  booksStore
    .removeChapter(bookId.value, idx)
    .then(() => booksStore.load())
    .catch((err) => ElMessage.error((err && err.message) || t('common.error')))
}

function onCreate(payload) {
  logAction('book.createChapter', `新建章节「${payload.title}」(${payload.paragraphs && payload.paragraphs.length ? payload.paragraphs.length + ' 段' : '空章'})`)
  booksStore
    .newEmptyChapter(bookId.value, payload.title)
    .then(() => booksStore.load())
    .catch((err) => ElMessage.error((err && err.message) || t('common.error')))
}

function onAppend(files) {
  booksStore
    .appendFiles(bookId.value, files)
    .then((result) => {
      if (result.failed && result.failed.length > 0) {
        const detail = result.failed.map((f) => `${f.fileName}(${f.error})`).join('; ')
        ElMessage({ message: `${t('library.appendFailed')}: ${detail}`, type: 'error', duration: 8000, showClose: true })
      } else {
        ElMessage.success(t('library.appendDone', { n: result.added }))
      }
      return booksStore.load()
    })
    .catch((err) => ElMessage.error(`${t('library.appendFailed')}: ${(err && err.message) || ''}`))
}

const replaceIdx = ref(-1)
const replaceInputRef = ref(null)

/** 单章内容替换:打开文件选择(选中后解析替换该章正文) */
function openReplacePicker(payload) {
  replaceIdx.value = payload.idx
  const input = replaceInputRef.value
  if (input) input.click()
}

async function onReplaceFile(event) {
  const input = event.target
  const file = input && input.files ? input.files[0] : null
  if (input) input.value = ''
  if (!file || replaceIdx.value < 0) return
  try {
    const buffer = await readAsArrayBuffer(file)
    const res = await window.cs.invoke('library:parse', { fileName: file.name, buffer })
    const fileChapters = (res.bookData && res.bookData.chapters) || []
    const paragraphs =
      fileChapters.length === 1
        ? fileChapters[0].paragraphs || []
        : fileChapters.flatMap((c) => c.paragraphs || [])
    await booksStore.updateChapter(bookId.value, replaceIdx.value, { paragraphs })
    ElMessage.success(t('library.appendDone', { n: 1 }))
    logAction('book.replaceChapter', `替换章节 #${replaceIdx.value} 正文(${paragraphs.length} 段)`)
    await booksStore.load()
  } catch (err) {
    ElMessage.error(`${t('library.appendFailed')}: ${(err && err.message) || ''}`)
  }
}

function goBack() {
  router.push('/')
}

onMounted(() => {
  if (!booksStore.books.length) {
    booksStore.load().catch(() => {})
  }
})
</script>

<template>
  <div class="manage-shell h-full flex flex-col">
    <!-- 书内工具条:补充到 App 顶栏(logo 右侧) -->
    <Teleport to="#topbar-extra">
      <div class="manage-extra flex items-center gap-2 min-w-0">
        <el-button text class="manage-back" @click="goBack">← {{ t('common.back') }}</el-button>
        <span class="manage-book-name truncate">{{ book ? cleanBookTitle(book.title) : t('reader.chooseBook') }}</span>
        <span class="manage-sub">{{ t('reader.catalog') }}</span>
        <span v-if="book" class="manage-sub">{{ t('library.wordCount') }} {{ formatNumber(book.wordCount) }}</span>
        <span v-if="book && bookSize" class="manage-sub">{{ bookSize }}</span>
      </div>
    </Teleport>

    <header class="manage-topbar flex items-center gap-3 px-3">
      <div class="flex items-center gap-2 ml-auto">
        <!-- 导入章节(单按钮,识别/弹名/重复对比全流程) -->
        <el-button
          type="primary"
          size="small"
          :loading="importing"
          class="manage-import"
          @click="openImportPicker"
        >
          {{ importing ? t('library.importParsing') : t('catalog.importChapters') }}
        </el-button>
        <input
          ref="importInputRef"
          type="file"
          multiple
          accept=".txt,.md,.epub"
          class="hidden-input"
          @change="onImportFiles"
        />
        <el-button size="small" type="success" @click="continueReading">
          ▶ {{ t('library.continueReading') }}
        </el-button>
        <el-button size="small" @click="router.push({ path: `/reader/${bookId}`, query: { autoplay: '1', from: 'manage' } })">
          {{ t('library.listen') }}
        </el-button>

      </div>
    </header>

    <!-- 章节列表面板 -->
    <div class="flex-1 min-h-0 overflow-auto px-4 py-3">
      <!-- 上次阅读记录(点击书本进入目录时可见)。
           注意:必须独立成一条 v-if 链 —— 若插在下面 el-empty 与 el-alert 之间,
           会打断它们的 v-if/v-else-if/v-else 相邻关系,导致章节面板不再渲染。 -->
      <div v-if="book && lastReadIdx >= 0" class="manage-last-read">
        <span class="manage-last-read-label">{{ t('reader.lastReadAt', { n: lastReadIdx + 1 }) }}</span>
        <span class="manage-last-read-title truncate">{{ lastReadTitle }}</span>
      </div>

      <div v-if="!book" class="h-full flex items-center justify-center">
        <el-empty :description="t('reader.chooseBook')" />
      </div>
      <!-- 空书引导:新建的书还没有章节,提示先导入章节文件 -->
      <el-alert
        v-else-if="!chapters.length"
        class="manage-empty-hint"
        type="info"
        :closable="false"
        :title="t('book.hintImportChapters')"
        :description="t('book.hintCatalogManage')"
      />
      <ChapterListPanel
        v-else
        layout="grid"
        :chapters="chapters"
        :current-chapter="currentChapter"
        :last-read-idx="lastReadIdx"
        :book-id="bookId"
        @select="onSelectChapter"
        @rename="onRename"
        @remove="onRemove"
        @append="onAppend"
        @create="onCreate"
        @replace="openReplacePicker"
        @refresh="booksStore.load().catch(() => {})"
      />
      <input
        ref="replaceInputRef"
        type="file"
        accept=".txt,.md"
        class="hidden-input"
        @change="onReplaceFile"
      />
    </div>

    <!-- 章节重名:左右分屏对比 -->
    <ChapterCompareDialog
      :visible="compare.visible"
      :existing="compare.existing"
      :incoming="compare.incoming"
      @confirm="onCompareConfirm"
      @skip="onCompareSkip"
    />

    <!-- 导入进行中:全屏遮罩,期间禁止操作;弹出章节名输入/重名对比时让位(importPaused),避免遮罩挡住弹窗造成死锁 -->
    <div v-if="importing && !importPaused" class="import-overlay">
      <div class="import-overlay-card">
        <el-icon class="import-overlay-icon is-loading"><Loading /></el-icon>
        <span class="import-overlay-text">{{ t('library.importing') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.manage-shell {
  background: var(--cs-bg);
  color: var(--cs-fg);
}
.manage-topbar {
  flex: none;
  height: 44px;
  background: var(--cs-panel);
  border-bottom: 1px solid var(--cs-border);
}
.manage-book-name {
  font-size: 15px;
  font-weight: 700;
}
.manage-sub {
  font-size: 12px;
  opacity: 0.55;
  /* 顶栏空间有限:整段不折行,避免「字数 2,000」被拆成两行 */
  white-space: nowrap;
  flex: none;
}
.hidden-input {
  display: none;
}
.manage-empty-hint {
  margin-bottom: 12px;
}

/* 导入进行中的全屏遮罩(与书架页一致) */
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

/* 上次阅读记录条 */
.manage-last-read {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
  padding: 6px 10px;
  border-radius: 8px;
  border-left: 3px solid var(--el-color-primary, #409eff);
  background: color-mix(in srgb, var(--el-color-primary, #409eff) 8%, transparent);
  font-size: 12px;
}

.manage-last-read-label {
  color: var(--el-color-primary, #409eff);
  font-weight: 600;
  flex: none;
}

.manage-last-read-title {
  opacity: 0.75;
  min-width: 0;
}
.manage-extra {
  min-width: 0;
}
.manage-extra .manage-book-name {
  font-weight: 600;
}
.manage-extra .manage-sub {
  font-size: 12px;
  opacity: 0.6;
}
</style>
