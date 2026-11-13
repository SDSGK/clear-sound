<script setup>
/**
 * ReaderStyleBar.vue —— Aa 阅读样式条(内嵌横条,非弹窗)
 *
 * 放在阅读区顶部,调整时正文实时可见(布局推挤,不遮挡)。
 * 控件与 ReaderStylePanel 相同:字体/字号/行距/字距/主题(含自定义)/自动翻页。
 * 每次变更立即:① 更新本地设置 ② saveSettings() 落 localStorage
 *              ③ applyReaderVars() 写 --r-* CSS 变量(热更)
 */
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { applyReaderVars, saveSettings } from '@/utils/reader-settings'
import { logAction } from '@/utils/debug'

const props = defineProps({
  /** 当前阅读设置(单向数据源,由 ReaderView 持有) */
  settings: { type: Object, default: () => ({}) },
  /** CSS 变量的作用目标(阅读区 .reader-page 元素) */
  target: { type: Object, default: null },
})

const emit = defineEmits(['update:settings'])

const { t } = useI18n()

/** 本地可编辑副本(与 props.settings 双向同步) */
const local = reactive({ ...props.settings })

watch(
  () => props.settings,
  (s) => {
    if (!s) return
    Object.assign(local, s)
  },
  { deep: true },
)

/** 应用一次变更:写 CSS 变量 + 落盘 + 通知父组件 */
function commit() {
  const snapshot = { ...local }
  saveSettings(snapshot)
  const el = props.target || (typeof document !== 'undefined' ? document.documentElement : null)
  if (el) applyReaderVars(el, snapshot)
  emit('update:settings', snapshot)
}

function setField(key, value) {
  local[key] = value
  commit()
  logAction('reader.style', `调整样式:${key}=${value}`)
}

function setTheme(theme) {
  local.theme = theme
  commit()
  logAction('reader.style', `切换阅读主题:${theme}`)
}

function setCustomColor(color) {
  if (!color) return
  local.customBg = color
  local.theme = 'custom'
  commit()
}

const themeOptions = computed(() => [
  { value: 'white', label: t('reader.themeWhite'), bg: '#ffffff', fg: '#333333' },
  { value: 'sepia', label: t('reader.themeSepia'), bg: '#f4ecd8', fg: '#5b4636' },
  { value: 'green', label: t('reader.themeGreen'), bg: '#cce8cf', fg: '#2e4a3a' },
  { value: 'dark', label: t('reader.themeDark'), bg: '#1a1a1c', fg: '#b8b8bc' },
])

const fontOptions = computed(() => [
  { value: 'system', label: t('reader.fontSystem') },
  { value: 'serif', label: t('reader.fontSerif') },
  { value: 'sans', label: t('reader.fontSans') },
  { value: 'kai', label: t('reader.fontKai') },
])

const themeSwatches = computed(() => themeOptions.value.filter((o) => o.value !== 'custom'))
</script>

<template>
  <div class="style-bar">
    <!-- 字体 -->
    <el-select size="small" :model-value="local.fontFamily" class="sb-font" @update:model-value="(v) => setField('fontFamily', v)">
      <el-option v-for="opt in fontOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
    </el-select>

    <!-- 字号 -->
    <div class="sb-group">
      <span class="sb-label">A</span>
      <el-slider
        size="small"
        class="sb-slider"
        :model-value="local.fontSize"
        :min="12"
        :max="32"
        @update:model-value="(v) => setField('fontSize', v)"
      />
      <span class="sb-value">{{ local.fontSize }}</span>
    </div>

    <!-- 行距 -->
    <div class="sb-group">
      <span class="sb-label">{{ t('reader.lineHeight') }}</span>
      <el-slider
        size="small"
        class="sb-slider"
        :model-value="local.lineHeight"
        :min="1.4"
        :max="2.4"
        :step="0.1"
        @update:model-value="(v) => setField('lineHeight', v)"
      />
      <span class="sb-value">{{ local.lineHeight }}</span>
    </div>

    <!-- 主题色块 -->
    <div class="sb-group">
      <button
        v-for="opt in themeSwatches"
        :key="opt.value"
        type="button"
        class="sb-swatch"
        :class="{ 'is-active': local.theme === opt.value }"
        :style="{ background: opt.bg }"
        :title="opt.label"
        @click="setTheme(opt.value)"
      ></button>
      <el-color-picker
        size="small"
        :model-value="local.theme === 'custom' ? local.customBg : ''"
        @update:model-value="setCustomColor"
      />
    </div>

    <!-- 自动翻页 -->
    <div class="sb-group">
      <el-switch
        size="small"
        :model-value="local.autoScroll"
        @update:model-value="(v) => setField('autoScroll', v)"
      />
      <span class="sb-label">{{ t('reader.autoScroll') }}</span>
    </div>
  </div>
</template>

<style scoped>
.style-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  background: var(--cs-panel);
  border-bottom: 1px solid var(--cs-border);
  overflow-x: auto;
}
.sb-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.sb-label {
  font-size: 12px;
  opacity: 0.65;
  white-space: nowrap;
}
.sb-slider {
  width: 90px;
}
.sb-value {
  font-size: 11px;
  opacity: 0.6;
  min-width: 28px;
}
.sb-font {
  width: 120px;
}
.sb-swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--cs-border, rgba(0, 0, 0, 0.1));
  cursor: pointer;
  padding: 0;
}
.sb-swatch.is-active {
  box-shadow: 0 0 0 2px var(--el-color-primary, #409eff);
}
</style>
