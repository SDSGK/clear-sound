<script setup>
/**
 * ParagraphMenu.vue —— 段落右键上下文菜单(自绘,不走 Element Plus)
 *
 * 交互(docs/DESIGN.md §3):
 *  - 右键正文段落 → 在鼠标位置弹出
 *  - 「从此处播放」:从右键所在段落开始朗读(M2 真实实现)
 *  - 「复制段落文本」:写剪贴板 → 成功提示
 *  - 点击菜单外部 / 按 Esc → 关闭
 *
 * 定位:fixed + left/top,靠近视口右/下边缘时自动翻转,避免菜单被裁掉。
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { usePlayerStore } from '@/stores/player'
import { useBookmarksStore } from '@/stores/bookmarks'

const props = defineProps({
  /** 菜单显示状态 */
  visible: { type: Boolean, default: false },
  /** 鼠标位置(视口坐标) */
  x: { type: Number, default: 0 },
  /** 鼠标位置(视口坐标) */
  y: { type: Number, default: 0 },
  /** 段落文本 */
  text: { type: String, default: '' },
  /** 段落所属章节下标 */
  chIdx: { type: Number, default: -1 },
  /** 段落下标 */
  pIdx: { type: Number, default: -1 },
  /** 书 id */
  bookId: { type: String, default: '' },
})

const emit = defineEmits(['close'])

const { t } = useI18n()
const player = usePlayerStore()
const bookmarksStore = useBookmarksStore()

/** 菜单尺寸(用于边缘翻转计算) */
const MENU_WIDTH = 168
const MENU_HEIGHT = 96
/** 视口边缘留白 */
const MARGIN = 8

/** 实际渲染位置 */
const pos = ref({ left: 0, top: 0 })

/** 是否已经算过一次位置 */
const positioned = ref(false)

/**
 * 计算菜单位置:靠近右/下边缘时向内翻转,负坐标也夹到视口内
 * @returns {void}
 */
function computePosition() {
  if (typeof window === 'undefined') return
  const vw = window.innerWidth || 1024
  const vh = window.innerHeight || 768
  let left = props.x
  let top = props.y
  // 右/下边缘:向内翻转
  if (left + MENU_WIDTH + MARGIN > vw) left = Math.max(MARGIN, vw - MENU_WIDTH - MARGIN)
  if (top + MENU_HEIGHT + MARGIN > vh) top = Math.max(MARGIN, vh - MENU_HEIGHT - MARGIN)
  // 负坐标(段落被滚到视口上方):夹回视口内,避免菜单完全不可见
  left = Math.max(MARGIN, Math.min(left, vw - MENU_WIDTH - MARGIN))
  top = Math.max(MARGIN, Math.min(top, vh - MENU_HEIGHT - MARGIN))
  pos.value = { left, top }
  positioned.value = true
}

/**
 * 「复制段落文本」:写剪贴板
 * @returns {Promise<void>}
 */
async function copyText() {
  const text = props.text || ''
  if (!text) return
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
    } else {
      // 剪贴板 API 不可用(非安全上下文等)→ 退回到 execCommand
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    ElMessage.success(t('reader.copied'))
  } catch {
    ElMessage.error(t('common.error'))
  } finally {
    emit('close')
  }
}

/**
 * 「从此处播放」:从右键所在段落开始朗读
 * @returns {Promise<void>}
 */
async function playFromHere() {
  emit('close')
  if (!props.bookId || props.chIdx < 0 || props.pIdx < 0) {
    ElMessage.error(t('reader.ttsFailed'))
    return
  }
  try {
    await player.initEngines()
    await player.playFrom(props.bookId, props.chIdx, props.pIdx)
    // store 的 playFrom 会把失败转成 status='error' 而不是 throw,
    // 所以必须看播放状态,否则合成失败也会提示「开始听书」
    if (player.status === 'error') {
      ElMessage.error(t('reader.ttsFailed'))
      return
    }
    ElMessage.success(t('reader.listenOn'))
  } catch {
    ElMessage.error(t('reader.ttsFailed'))
  }
}

/**
 * 「在此处添加书签」:记录段落位置与节选(主进程同位置幂等)
 * @returns {Promise<void>}
 */
async function addBookmark() {
  emit('close')
  if (!props.bookId || props.chIdx < 0 || props.pIdx < 0) return
  try {
    await bookmarksStore.add({
      bookId: props.bookId,
      chapterIdx: props.chIdx,
      paraIdx: props.pIdx,
      excerpt: (props.text || '').slice(0, 60),
    })
    ElMessage.success(t('bookmark.added'))
  } catch (err) {
    ElMessage.error(`${(err && err.message) || t('common.error')}`)
  }
}

/**
 * 点击页面其它位置 → 关闭菜单
 * @param {MouseEvent} event 鼠标事件
 * @returns {void}
 */
function onDocClick(event) {
  if (!props.visible) return
  const el = event.target
  if (el && typeof el.closest === 'function' && el.closest('.para-menu')) return
  emit('close')
}

/**
 * Esc → 关闭菜单
 * @param {KeyboardEvent} event 键盘事件
 * @returns {void}
 */
function onKeydown(event) {
  if (event.key === 'Escape' && props.visible) emit('close')
}

onMounted(() => {
  document.addEventListener('click', onDocClick, true)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true)
  document.removeEventListener('keydown', onKeydown)
})

/** 菜单样式(定位到鼠标处) */
const menuStyle = computed(() => ({
  left: `${pos.value.left}px`,
  top: `${pos.value.top}px`,
}))

// 菜单从隐藏变为显示时,按当前鼠标坐标定位(并做边缘翻转)
watch(
  () => props.visible,
  (v) => {
    if (v) {
      positioned.value = false
      computePosition()
    }
  },
)
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="para-menu" :style="menuStyle" role="menu">
      <button
        class="para-menu-item"
        type="button"
        :title="t('reader.playFromHere')"
        role="menuitem"
        @click="playFromHere"
      >
        <span class="para-menu-icon">▶</span>
        <span class="para-menu-label">{{ t('reader.playFromHere') }}</span>
      </button>
      <div class="para-menu-sep"></div>
      <button
        class="para-menu-item"
        type="button"
        :title="t('reader.bookmark')"
        role="menuitem"
        @click="addBookmark"
      >
        <span class="para-menu-icon">🔖</span>
        <span class="para-menu-label">{{ t('reader.bookmark') }}</span>
      </button>
      <div class="para-menu-sep"></div>
      <button class="para-menu-item" type="button" role="menuitem" @click="copyText">
        <span class="para-menu-icon">📋</span>
        <span class="para-menu-label">{{ t('reader.copyParagraph') }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
/* 右键菜单:fixed 定位到鼠标处,自绘样式(不依赖 Element Plus) */
.para-menu {
  position: fixed;
  z-index: 3000;
  min-width: 168px;
  padding: 4px;
  border-radius: 8px;
  background: var(--cs-panel, #fff);
  border: 1px solid var(--cs-border, rgba(0, 0, 0, 0.08));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
  color: var(--cs-fg, #333);
  font-size: 13px;
  user-select: none;
}

.para-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.para-menu-item:hover:not(.is-disabled) {
  background: color-mix(in srgb, var(--cs-fg, #333) 8%, transparent);
}

.para-menu-item.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.para-menu-icon {
  width: 16px;
  text-align: center;
  flex: none;
}

.para-menu-label {
  white-space: nowrap;
}

.para-menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--cs-border, rgba(0, 0, 0, 0.08));
}
</style>
