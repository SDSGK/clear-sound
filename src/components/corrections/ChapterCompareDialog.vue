<script setup>
/**
 * ChapterCompareDialog.vue —— 章节重名覆盖对比(左右分屏)
 *
 * 导入的章节与现有章节同名时弹出:左侧现有内容、右侧导入内容,
 * 由用户决定「覆盖此章」或「跳过」。
 * 正文各截断显示(防大文本卡顿),覆盖以完整段落为准。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  visible: { type: Boolean, default: false },
  /** 现有章节:{idx, title, paragraphs} */
  existing: { type: Object, default: null },
  /** 导入章节:{title, paragraphs} */
  incoming: { type: Object, default: null },
})

const emit = defineEmits(['update:visible', 'confirm', 'skip'])

const { t } = useI18n()

const MAX_SHOW = 4000

function textOf(ch) {
  if (!ch || !Array.isArray(ch.paragraphs)) return ''
  const full = ch.paragraphs.join('\n')
  return full.length > MAX_SHOW ? `${full.slice(0, MAX_SHOW)}\n…(截断)` : full
}

const existingText = computed(() => textOf(props.existing))
const incomingText = computed(() => textOf(props.incoming))

function close() {
  emit('update:visible', false)
}

function confirmOverwrite() {
  emit('confirm')
  close()
}

function skipThis() {
  emit('skip')
  close()
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="t('compare.title')"
    width="88%"
    top="4vh"
    append-to-body
    @update:model-value="emit('update:visible', $event)"
  >
    <div class="cmp-body">
      <div class="cmp-pane">
        <div class="cmp-head">{{ t('compare.existing') }}:{{ existing ? existing.title : '' }}</div>
        <div class="cmp-text">{{ existingText }}</div>
      </div>
      <div class="cmp-pane">
        <div class="cmp-head">{{ t('compare.incoming') }}:{{ incoming ? incoming.title : '' }}</div>
        <div class="cmp-text">{{ incomingText }}</div>
      </div>
    </div>
    <template #footer>
      <el-button @click="skipThis">{{ t('compare.skipThis') }}</el-button>
      <el-button type="primary" @click="confirmOverwrite">{{ t('compare.overwrite') }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.cmp-body {
  display: flex;
  gap: 14px;
}
.cmp-pane {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--cs-border, rgba(0, 0, 0, 0.08));
  border-radius: 8px;
  overflow: hidden;
}
.cmp-head {
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  background: color-mix(in srgb, var(--cs-fg, #333) 6%, transparent);
}
.cmp-text {
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.7;
  max-height: 52vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
