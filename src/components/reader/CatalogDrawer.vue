<script setup>
/**
 * CatalogDrawer.vue —— 阅读器目录抽屉(薄壳)
 * 面板主体复用 ChapterListPanel(与章节管理页同一组件)。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { logAction } from '@/utils/debug'
import ChapterListPanel from './ChapterListPanel.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  chapters: { type: Array, default: () => [] },
  currentChapter: { type: Number, default: -1 },
  bookId: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue', 'chapter-select', 'chapter-remove', 'chapter-rename', 'refresh'])

const { t } = useI18n()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => {
    if (v !== props.modelValue) logAction('reader.catalog', v ? '打开目录抽屉' : '关闭目录抽屉')
    emit('update:modelValue', v)
  },
})
</script>

<template>
  <el-drawer v-model="visible" :title="t('reader.catalog')" direction="ltr" size="300px">
    <ChapterListPanel
      :chapters="chapters"
      :current-chapter="currentChapter"
      :book-id="bookId"
      @select="emit('chapter-select', $event)"
      @rename="emit('chapter-rename', $event)"
      @remove="emit('chapter-remove', $event)"
      @refresh="emit('refresh')"
    />
  </el-drawer>
</template>
