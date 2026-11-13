<script setup>
/**
 * ChapterListPanel.vue —— 章节列表面板(通用,分组折叠 + 章节管理 + 明细)
 *
 * 被 BookManageView(章节管理页)与 CatalogDrawer(阅读器目录抽屉)复用。
 * - 章节数 ≤ 100:平铺全显;> 100:按 100 章一组折叠,默认只展开当前章所在组
 *   (只渲染展开组的条目,数千章也不掉帧)
 * - 每章明细:本章时长(stats:chapter-tick 累计)、书签数
 * - 顶部单按钮「导入章节」:选文件(可多选)→ 逐文件解析:
 *    识别出章节名 → 直接添加;识别不出 → 弹窗输入;
 *    章节名重复 → 左右分屏对比(覆盖 / 跳过)
 * - 管理操作:点击章节(emit select)/ ✏ 重命名 / ✕ 删除
 *   底部:新建空章节(小入口)
 * - 操作完成后 emit('refresh') 由父级刷新正文渲染与 manifest
 */
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, RefreshRight } from '@element-plus/icons-vue'
import { useI18n } from 'vue-i18n'
import { useBookmarksStore } from '@/stores/bookmarks'
import readAsArrayBuffer from '@/utils/file-read'
import { logAction } from '@/utils/debug'
import ChapterCompareDialog from '@/components/corrections/ChapterCompareDialog.vue'

const props = defineProps({
  /** 章节清单:manifest.chapters → [{idx,title,paragraphCount,charCount}] */
  chapters: { type: Array, default: () => [] },
  /** 当前章节下标(高亮) */
  currentChapter: { type: Number, default: -1 },
  /** 书 id(章节管理:删除/追加/重命名/时长) */
  bookId: { type: String, default: '' },
  /**
   * 布局:'list'(侧栏列表,>100 章自动分组折叠)/ 'grid'(章节管理页网格)
   */
  layout: { type: String, default: 'list' },
  /** 上次读到的章节下标(该章标记「上次」,-1 = 无记录) */
  lastReadIdx: { type: Number, default: -1 },
})

const emit = defineEmits(['select', 'rename', 'remove', 'replace', 'refresh'])

const { t } = useI18n()
const bookmarksStore = useBookmarksStore()

const fileInputRef = ref(null)
const importing = ref(false)

// ===== 分组折叠(>100 章时启用,0~100 / 100~200 …) =====
const GROUP_SIZE = 100
const expandedGroup = ref(0)

/**
 * 规范化后的章节清单。
 *
 * 两个历史坑都在这里兜住:
 *  1) props.chapters 可能为 null(阅读器侧栏打开瞬间 chapters 还是 ref(null)),
 *     直接读 .length 会抛 "Cannot read properties of null (reading 'length')";
 *  2) 存量书库的章节没有 idx 字段(早期 buildBookFields 未落盘),
 *     `chapter.idx + 1` = NaN(目录显示 NaN),emit('select', undefined) 又让
 *     阅读器定位不到任何章节(正文空)。这里按下标补齐。
 */
const chapterList = computed(() => {
  const list = Array.isArray(props.chapters) ? props.chapters : []
  return list.map((c, i) => {
    if (!c) return c
    return Number.isInteger(c.idx) ? c : { ...c, idx: i }
  })
})

const groups = computed(() => {
  if (chapterList.value.length <= GROUP_SIZE) return null
  const arr = []
  for (let start = 0; start < chapterList.value.length; start += GROUP_SIZE) {
    arr.push({
      start,
      end: Math.min(start + GROUP_SIZE, chapterList.value.length) - 1,
      items: chapterList.value.slice(start, start + GROUP_SIZE),
    })
  }
  return arr
})

/**
 * 章节下标 → 所在组的**起始章号**。
 *
 * 注意:必须返回 group.start(起始章号)而不是组序号 —— expandedGroup 存的是
 * 起始章号,isGroupOpen 也拿 group.start 比较。若这里返回序号,
 * 两者语义不一致 → 永远匹配不上,所有分组都不展开(实测 openCellCount=0)。
 *
 * @param {number} chapterIdx 章节下标
 * @returns {number} 该组的起始章号
 */
function groupOf(chapterIdx) {
  if (!groups.value) return 0
  const gi = Math.min(Math.floor(chapterIdx / GROUP_SIZE), groups.value.length - 1)
  return groups.value[gi].start
}

function isGroupOpen(start) {
  if (!groups.value) return true
  const target = props.currentChapter >= 0 ? groupOf(props.currentChapter) : 0
  return expandedGroup.value === null ? start === target : expandedGroup.value === start
}

function toggleGroup(start) {
  expandedGroup.value = expandedGroup.value === start ? null : start
  logAction('catalog.group', `目录分组折叠/展开:第 ${start + 1} 章起`)
}

// ===== 折叠动画(Transition 的 JS 钩子) =====
// 纯 CSS 无法对 v-if 切换做高度过渡(元素瞬间出现/消失),
// 这里用 JS 测量实际高度后逐帧过渡,展开/收起都有动画。
function onFoldEnter(el, done) {
  el.style.height = '0px'
  el.style.opacity = '0'
  el.style.overflow = 'hidden'
  // 强制回流,让初始状态生效,再放开到实际高度
  void el.offsetHeight
  requestAnimationFrame(() => {
    el.style.height = `${el.scrollHeight}px`
    el.style.opacity = '1'
  })
  // transitionend 兜底:万一过渡未触发(如元素被隐藏/无 layout),
  // 也必须调用 done(),否则 Transition 永远等不到结束,元素卡在 DOM 里。
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    el.removeEventListener('transitionend', onEnd)
    clearTimeout(timer)
    done()
  }
  const onEnd = (e) => {
    if (e.target !== el || e.propertyName !== 'height') return
    finish()
  }
  el.addEventListener('transitionend', onEnd)
  const timer = setTimeout(finish, 400)
}

function onFoldAfterEnter(el) {
  el.style.height = ''
  el.style.opacity = ''
  el.style.overflow = ''
}

function onFoldLeave(el, done) {
  el.style.height = `${el.scrollHeight}px`
  el.style.overflow = 'hidden'
  void el.offsetHeight
  requestAnimationFrame(() => {
    el.style.height = '0px'
    el.style.opacity = '0'
  })
  // 同上:兜底保证 leave 一定结束(否则折叠后内容仍留在 DOM)
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    el.removeEventListener('transitionend', onEnd)
    clearTimeout(timer)
    done()
  }
  const onEnd = (e) => {
    if (e.target !== el || e.propertyName !== 'height') return
    finish()
  }
  el.addEventListener('transitionend', onEnd)
  const timer = setTimeout(finish, 400)
}

function onFoldAfterLeave(el) {
  el.style.height = ''
  el.style.opacity = ''
  el.style.overflow = ''
}

// 默认展开当前章所在组
// immediate:挂载时 props.currentChapter 已是最终值(如从「上次阅读」进入),
// 不加 immediate 则首次不会触发 → 默认停在第 1 组,用户看不到自己在读的那组。
watch(
  () => props.currentChapter,
  (idx) => {
    if (groups.value && idx >= 0) expandedGroup.value = groupOf(idx)
  },
  { immediate: true },
)

// ===== 每章明细:时长 / 书签数 =====
const chapterTime = ref({})
const bookmarkCountByIdx = ref({})

function formatDuration(sec) {
  const total = Math.max(0, Math.floor(sec || 0))
  const m = Math.floor(total / 60)
  if (m > 0) return t('stats.formatM', { m })
  return t('stats.formatS', { s: total })
}

async function loadChapterMeta() {
  if (!props.bookId) return
  try {
    const res = await window.cs.invoke('stats:summary', { range: 'day', bookId: props.bookId })
    const map = {}
    for (const item of res.chapterTime || []) map[item.chapterIdx] = item
    chapterTime.value = map
  } catch {
    chapterTime.value = {}
  }
  try {
    await bookmarksStore.load(props.bookId)
    const byChapter = {}
    for (const bm of bookmarksStore.list) {
      byChapter[bm.chapterIdx] = (byChapter[bm.chapterIdx] || 0) + 1
    }
    bookmarkCountByIdx.value = byChapter
  } catch {
    bookmarkCountByIdx.value = {}
  }
}

watch(
  // 用 chapterList 而非 props.chapters:后者在阅读器侧栏打开瞬间是 null,
  // 直接读 .length 会抛 "Cannot read properties of null (reading 'length')",
  // 连带打断同一 tick 的其它渲染(正文空白)。
  () => [props.bookId, chapterList.value.length],
  () => {
    loadChapterMeta()
  },
)

function timeOf(idx) {
  const item = chapterTime.value[idx]
  return item ? formatDuration(item.listenSec + item.readSec) : ''
}

function bookmarksIn(idx) {
  return bookmarkCountByIdx.value[idx] || 0
}

// ===== IPC 辅助 =====
async function invoke(channel, payload) {
  const res = await window.cs.invoke(channel, payload)
  if (!res || !res.ok) throw new Error((res && res.error) || `IPC_FAILED:${channel}`)
  return res
}

function stripExt(name) {
  return String(name || '').replace(/\.(txt|md|markdown|mdown|epub)$/i, '')
}

// ===== 重名覆盖对比(promise 化,等待用户决策) =====
const compare = ref({ visible: false, existing: null, incoming: null, resolve: null })

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

// ===== 顶部「导入章节」智能流程 =====
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
      const res = await invoke('library:parse', { fileName: file.name, buffer })
      const fileChapters = (res.bookData && res.bookData.chapters) || []

      // 多章文件:每章都有内容识别章题,全部直接追加
      if (fileChapters.length > 1) {
        await invoke('library:append-chapters', {
          bookId: props.bookId,
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
        }
      }

      // 章节名重复 → 分屏对比,等待用户覆盖 / 跳过
      const dup = chapterList.value.find((c) => c && c.title === title)
      if (dup) {
        const rd = await invoke('library:read-chapter', { bookId: props.bookId, idx: dup.idx })
        const decision = await askOverwrite(
          { title: dup.title, paragraphs: rd.data.paragraphs },
          { title, paragraphs: chapter.paragraphs || [] },
        )
        if (decision === 'overwrite') {
          await invoke('library:update-chapter', {
            bookId: props.bookId,
            idx: dup.idx,
            paragraphs: chapter.paragraphs || [],
          })
          overwritten += 1
        }
        continue
      }

      // 新章节 → 追加
      await invoke('library:append-chapters', {
        bookId: props.bookId,
        chapters: [{ title, paragraphs: chapter.paragraphs || [] }],
      })
      added += 1
    }
    if (added > 0) ElMessage.success(t('library.appendDone', { n: added }))
    if (overwritten > 0) ElMessage.success(t('catalog.overwriteDone', { n: overwritten }))
    logAction('book.importChapters', `导入章节:新增 ${added} 章,覆盖 ${overwritten} 章(《${props.bookId}》)`)
    emit('refresh')
    loadChapterMeta()
  } catch (err) {
    ElMessage.error(`${t('library.appendFailed')}: ${(err && err.message) || ''}`)
  } finally {
    importing.value = false
  }
}

// ===== 操作 =====
async function renameChapterDialog(chapter) {
  if (!chapter) return
  let value = ''
  try {
    const result = await ElMessageBox.prompt(t('book.renameChapterTitle'), t('book.rename'), {
      inputValue: chapter.title || '',
      inputPattern: /\S/,
      inputErrorMessage: t('common.error'),
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
    })
    value = String(result.value || '').trim()
  } catch {
    return
  }
  if (!value || value === chapter.title) return
  logAction('book.renameChapter', `重命名章节 #${chapter.idx} → 「${value}」`)
  emit('rename', { idx: chapter.idx, title: value })
  loadChapterMeta()
}

async function removeChapter(chapter) {
  if (!chapter) return
  try {
    await ElMessageBox.confirm(t('book.removeChapterConfirm'), t('common.confirm'), {
      type: 'warning',
    })
  } catch {
    return
  }
  logAction('book.removeChapter', `删除章节 #${chapter.idx}(《${props.bookId}》)`)
  emit('remove', chapter.idx)
  loadChapterMeta()
}

function openImportPicker() {
  const input = fileInputRef.value
  if (input) input.click()
}

// ===== 新建章节:粘贴新建弹窗(章节名 + 正文,正文可空 = 空章) =====
const createVisible = ref(false)
const createForm = ref({ title: '', content: '' })

function openCreateDialog() {
  createForm.value = { title: '', content: '' }
  createVisible.value = true
}

/** 正文按空行/换行切段 */
function confirmCreate() {
  const title = createForm.value.title.trim()
  if (!title) return
  const paragraphs = createForm.value.content
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  logAction('book.createChapter', `新建章节「${title}」(${paragraphs.length ? paragraphs.length + ' 段' : '空章'})`)
  emit('create', { title, paragraphs })
  createVisible.value = false
}
</script>

<template>
  <div class="clp-root">
    <!-- 平铺网格(章节管理页):每格约 140px,hover 显示操作图标 -->
    <!-- 网格布局(章节管理页):章数多时按 100 章一组手风琴,
         避免上千章一次性渲染拖垮界面 -->
    <div v-if="layout === 'grid'" class="clp-grid-wrap">
      <div v-if="!chapterList.length" class="cd-empty">{{ t('book.chaptersEmpty') }}</div>
      <template v-else-if="!groups">
        <div class="clp-grid">
          <div
            v-for="chapter in chapterList"
            :key="chapter.idx"
            class="clp-cell"
            :class="{ 'is-current': chapter.idx === currentChapter, 'is-last-read': chapter.idx === lastReadIdx }"
            role="button"
            tabindex="0"
            @click="emit('select', chapter.idx)"
          >
            <div class="clp-cell-index">{{ chapter.idx + 1 }}</div>
            <div class="clp-cell-title" :title="chapter.title">{{ chapter.title || `第 ${chapter.idx + 1} 章` }}</div>
            <div class="clp-cell-meta">
              <span v-if="chapter.idx === lastReadIdx" class="clp-last-read">{{ t('catalog.lastReadTag') }}</span>
              <span v-if="timeOf(chapter.idx)">{{ timeOf(chapter.idx) }}</span>
              <span v-if="bookmarksIn(chapter.idx)">🔖{{ bookmarksIn(chapter.idx) }}</span>
            </div>
            <div class="clp-cell-actions">
              <el-button link size="small" :title="t('book.rename')" @click.stop="renameChapterDialog(chapter)">
                <el-icon><Edit /></el-icon>
              </el-button>
              <el-button link size="small" :title="t('catalog.importReplace')" @click.stop="emit('replace', { idx: chapter.idx })">
                <el-icon><RefreshRight /></el-icon>
              </el-button>
              <el-button link size="small" type="danger" :title="t('common.delete')" @click.stop="removeChapter(chapter)">
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
          </div>
        </div>
      </template>
      <template v-else>
        <div v-for="group in groups" :key="group.start" class="clp-grid-group">
          <button type="button" class="cd-group-head" @click="toggleGroup(group.start)">
            <span>{{ t('catalog.groupRange', { a: group.start + 1, b: group.end + 1 }) }}</span>
            <span class="cd-group-arrow" :class="{ 'is-open': isGroupOpen(group.start) }">▸</span>
          </button>
          <Transition
            name="clp-fold"
            @enter="onFoldEnter"
            @after-enter="onFoldAfterEnter"
            @leave="onFoldLeave"
            @after-leave="onFoldAfterLeave"
          >
            <div v-if="isGroupOpen(group.start)" class="clp-grid">
            <div
              v-for="chapter in group.items"
              :key="chapter.idx"
              class="clp-cell"
              :class="{ 'is-current': chapter.idx === currentChapter, 'is-last-read': chapter.idx === lastReadIdx }"
              role="button"
              tabindex="0"
              @click="emit('select', chapter.idx)"
            >
              <div class="clp-cell-index">{{ chapter.idx + 1 }}</div>
              <div class="clp-cell-title" :title="chapter.title">{{ chapter.title || `第 ${chapter.idx + 1} 章` }}</div>
              <div class="clp-cell-meta">
                <span v-if="chapter.idx === lastReadIdx" class="clp-last-read">{{ t('catalog.lastReadTag') }}</span>
                <span v-if="timeOf(chapter.idx)">{{ timeOf(chapter.idx) }}</span>
                <span v-if="bookmarksIn(chapter.idx)">🔖{{ bookmarksIn(chapter.idx) }}</span>
              </div>
              <div class="clp-cell-actions">
                <el-button link size="small" :title="t('book.rename')" @click.stop="renameChapterDialog(chapter)">
                  <el-icon><Edit /></el-icon>
                </el-button>
                <el-button link size="small" :title="t('catalog.importReplace')" @click.stop="emit('replace', { idx: chapter.idx })">
                  <el-icon><RefreshRight /></el-icon>
                </el-button>
                <el-button link size="small" type="danger" :title="t('common.delete')" @click.stop="removeChapter(chapter)">
                  <el-icon><Delete /></el-icon>
                </el-button>
              </div>
            </div>
          </div>
          </Transition>
        </div>
      </template>
    </div>

    <!-- 列表模式(阅读器侧栏) -->
    <div v-else class="cd-list">
      <div v-if="!chapterList.length" class="cd-empty">{{ t('book.chaptersEmpty') }}</div>

      <template v-if="!groups">
        <div
          v-for="chapter in chapterList"
          :key="chapter.idx"
          class="cd-item"
          :class="{ 'is-current': chapter.idx === currentChapter }"
          role="button"
          tabindex="0"
          @click="emit('select', chapter.idx)"
        >
          <span class="cd-index">{{ chapter.idx + 1 }}</span>
          <span class="cd-title">{{ chapter.title || `第 ${chapter.idx + 1} 章` }}</span>
          <span class="cd-actions">
            <span v-if="chapter.idx === lastReadIdx" class="clp-last-read">{{ t('catalog.lastReadTag') }}</span>
            <span v-if="timeOf(chapter.idx)" class="cd-chip" :title="t('stats.listenTime')">{{ timeOf(chapter.idx) }}</span>
            <span v-if="bookmarksIn(chapter.idx)" class="cd-chip" :title="t('reader.bookmark')">🔖{{ bookmarksIn(chapter.idx) }}</span>
            <button type="button" class="cd-action" :title="t('book.rename')" @click.stop="renameChapterDialog(chapter)">✏</button>
            <button type="button" class="cd-action" :title="t('catalog.importReplace')" @click.stop="emit('replace', { idx: chapter.idx })">↥</button>
            <button type="button" class="cd-action" :title="t('common.delete')" @click.stop="removeChapter(chapter)">✕</button>
          </span>
        </div>
      </template>

      <template v-else>
        <div v-for="group in groups" :key="group.start" class="cd-group">
          <button type="button" class="cd-group-head" @click="toggleGroup(group.start)">
            <span>{{ t('catalog.groupRange', { a: group.start + 1, b: group.end + 1 }) }}</span>
            <span class="cd-group-arrow" :class="{ 'is-open': isGroupOpen(group.start) }">▸</span>
          </button>
          <Transition
            name="clp-fold"
            @enter="onFoldEnter"
            @after-enter="onFoldAfterEnter"
            @leave="onFoldLeave"
            @after-leave="onFoldAfterLeave"
          >
            <div v-if="isGroupOpen(group.start)" class="cd-group-items">
            <div
              v-for="chapter in group.items"
              :key="chapter.idx"
              class="cd-item"
              :class="{ 'is-current': chapter.idx === currentChapter }"
              role="button"
              tabindex="0"
              @click="emit('select', chapter.idx)"
            >
              <span class="cd-index">{{ chapter.idx + 1 }}</span>
              <span class="cd-title">{{ chapter.title || `第 ${chapter.idx + 1} 章` }}</span>
              <span class="cd-actions">
                <span v-if="timeOf(chapter.idx)" class="cd-chip">{{ timeOf(chapter.idx) }}</span>
                <span v-if="bookmarksIn(chapter.idx)" class="cd-chip">🔖{{ bookmarksIn(chapter.idx) }}</span>
                <button type="button" class="cd-action" :title="t('book.rename')" @click.stop="renameChapterDialog(chapter)">✏</button>
                <button type="button" class="cd-action" :title="t('catalog.importReplace')" @click.stop="emit('replace', { idx: chapter.idx })">↥</button>
                <button type="button" class="cd-action" :title="t('common.delete')" @click.stop="removeChapter(chapter)">✕</button>
              </span>
            </div>
            </div>
          </Transition>
        </div>
      </template>
    </div>

    <!-- 章节管理:导入章节(文件) / 新建章节(粘贴) -->
    <div class="cd-footer">
      <input
        ref="fileInputRef"
        type="file"
        multiple
        accept=".txt,.md,.epub"
        class="cd-file-input"
        @change="onImportFiles"
      />
      <div class="cd-footer-btns">
        <el-button size="small" @click="openImportPicker">📥 {{ t('catalog.importChapters') }}</el-button>
        <el-button size="small" @click="openCreateDialog">+ {{ t('catalog.newChapter') }}</el-button>
      </div>

      <!-- 新建章节:粘贴新建弹窗(章节名 + 正文,正文可空 = 空章) -->
      <el-dialog
        v-model="createVisible"
        :title="t('catalog.newChapter')"
        width="520px"
        append-to-body
        @open="createForm = { title: '', content: '' }"
      >
        <div class="create-form">
          <el-input
            v-model="createForm.title"
            :placeholder="t('catalog.chapterName')"
            maxlength="80"
          />
          <el-input
            v-model="createForm.content"
            type="textarea"
            :rows="10"
            :placeholder="t('catalog.pasteContent')"
          />
          <div class="create-hint">{{ t('catalog.pasteHint') }}</div>
        </div>
        <template #footer>
          <el-button @click="createVisible = false">{{ t('common.cancel') }}</el-button>
          <el-button
            type="primary"
            :disabled="!createForm.title.trim()"
            @click="confirmCreate"
          >
            {{ t('common.confirm') }}
          </el-button>
        </template>
      </el-dialog>
    </div>

    <!-- 章节重名:左右分屏对比 -->
    <ChapterCompareDialog
      :visible="compare.visible"
      :existing="compare.existing"
      :incoming="compare.incoming"
      @confirm="onCompareConfirm"
      @skip="onCompareSkip"
    />
  </div>
</template>

<style scoped>
.clp-root {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.clp-top {
  margin-bottom: 10px;
  display: flex;
}

.clp-import {
  flex: none;
}

.cd-footer-btns {
  display: flex;
  gap: 8px;
  justify-content: center;
}

.create-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.create-hint {
  font-size: 12px;
  opacity: 0.55;
  line-height: 1.6;
}

.cd-list {
  max-height: 46vh;
  overflow: auto;
}

.cd-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--cs-fg, #333);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.cd-item:hover {
  background: color-mix(in srgb, var(--cs-fg, #333) 7%, transparent);
}

.cd-item.is-current {
  background: color-mix(in srgb, var(--el-color-primary, #409eff) 16%, transparent);
  color: var(--el-color-primary, #409eff);
  font-weight: 600;
}

.cd-index {
  flex: none;
  min-width: 22px;
  font-size: 11px;
  opacity: 0.55;
  text-align: right;
}

.cd-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cd-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
}

.cd-item:hover .cd-actions {
  opacity: 0.75;
}

.cd-action {
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
}

.cd-action:hover {
  background: rgba(29, 122, 85, 0.16);
  color: #1d7a55;
}

.cd-chip {
  flex: none;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--cs-fg, #333) 8%, transparent);
  opacity: 0.75;
}

.cd-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 6px;
  background: color-mix(in srgb, var(--cs-fg, #333) 5%, transparent);
  color: var(--cs-fg, #333);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.cd-group-arrow {
  opacity: 0.6;
  /* 展开时旋转 90°(▸ → ▾),配合高度过渡形成连贯动画 */
  display: inline-block;
  transition: transform 0.2s ease;
}
.cd-group-arrow.is-open {
  transform: rotate(90deg);
}

/* 折叠过渡:高度 + 透明度 */
.clp-fold-enter-active,
.clp-fold-leave-active {
  transition: height 0.22s ease, opacity 0.18s ease;
}

.cd-empty {
  padding: 16px 8px;
  font-size: 13px;
  opacity: 0.6;
  text-align: center;
  color: var(--cs-fg, #333);
}

.cd-footer {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--cs-border, rgba(0, 0, 0, 0.06));
  text-align: center;
}

.cd-file-input {
  display: none;
}

/* 「上次读到」标记 */
.clp-last-read {
  color: var(--el-color-primary, #409eff);
  font-size: 11px;
  flex: none;
}

/* 网格布局的分组容器(手风琴) */
.clp-grid-group {
  margin-bottom: 8px;
}

.clp-cell.is-last-read {
  border-color: var(--el-color-primary, #409eff);
}

/* 平铺网格(章节管理页) */
.clp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 8px;
}
.clp-cell {
  position: relative;
  padding: 8px 10px;
  border: 1px solid var(--cs-border, rgba(0, 0, 0, 0.08));
  border-radius: 8px;
  background: var(--cs-panel);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.clp-cell:hover {
  border-color: #1d7a55;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
.clp-cell.is-current {
  border-color: var(--el-color-primary, #409eff);
}
.clp-cell-index {
  font-size: 18px;
  font-weight: 700;
  opacity: 0.75;
}
.clp-cell-title {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
.clp-cell-meta {
  margin-top: 6px;
  display: flex;
  gap: 8px;
  font-size: 11px;
  opacity: 0.6;
}
.clp-cell-actions {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s ease;
  background: var(--cs-panel);
  border-radius: 6px;
}
.clp-cell:hover .clp-cell-actions {
  opacity: 1;
}
</style>
