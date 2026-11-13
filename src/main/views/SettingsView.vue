<script setup>
/**
 * SettingsView.vue —— 设置(M6)
 *
 * 分组:外观 / 语音引擎 / 歌词 / 纠错规则 / 提醒 / 全局快捷键 / 存储与缓存 / 配置(导入导出) / 调试日志 / 关于
 *
 * - 配置导出:主进程写文件(dialog),apiKey 自动脱敏;导入:校验后覆盖设置/纠错/书签
 * - 快捷键:主进程 globalShortcut 注册,冲突会回传失败项
 * - 调试日志:统一落 userData/data/debug-log.json(上限 60 条),可复制/清空
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { setLocale } from '@/locales'
import { getTheme, setTheme } from '@/styles/theme'
import { useCorrectionsStore } from '@/stores/corrections'
import { cacheStats, clearAll, setCacheLimit } from '@/utils/tts-cache'
import { logAction, setDebugEnabled } from '@/utils/debug'
import CorrectionRuleList from '@/components/corrections/CorrectionRuleList.vue'

const { t, locale } = useI18n()
const correctionsStore = useCorrectionsStore()

// ===================== 外观 =====================
const theme = ref(getTheme())
function onThemeChange(val) {
  theme.value = val
  setTheme(val)
  logAction('settings.theme', `界面主题:${val}`)
}

function onLocaleChange(val) {
  setLocale(val)
  logAction('settings.locale', `界面语言:${val}`)
}

// ===================== 设置(主进程 settings.json) =====================
const settings = ref({
  reminder: { eye: { enabled: true, intervalMin: 20, restSec: 20 }, chime: { enabled: true, volume: 0.5 } },
  engines: {},
  shortcuts: {},
  lyrics: { desktop: true, statusBar: true },
  debug: { enabled: true },
})
const reminderSettings = computed(() => settings.value.reminder || { eye: {}, chime: {} })
const engineConfig = ref({ baseURL: '', apiKey: '', model: 'tts-1', voice: 'alloy' })

async function loadSettings() {
  try {
    const res = await window.cs.invoke('settings:get', {})
    if (res && res.ok && res.settings) {
      settings.value = res.settings
      const openai = (res.settings.engines && res.settings.engines.openai) || {}
      engineConfig.value = {
        baseURL: openai.baseURL || '',
        apiKey: openai.apiKey || '',
        model: openai.model || 'tts-1',
        voice: openai.voice || 'alloy',
      }
      setDebugEnabled((res.settings.debug || {}).enabled !== false)
      // 快捷键:回读已保存值(与默认值合并,缺项用默认)
      const savedShortcuts = res.settings.shortcuts || {}
      shortcuts.value = { ...shortcuts.value, ...savedShortcuts }
      // 缓存上限:读回落盘值并即时应用
      const limitMb = Number(res.settings.cacheLimitMB)
      if (Number.isFinite(limitMb) && limitMb >= 50) {
        cacheLimitMb.value = limitMb
        setCacheLimit(limitMb * 1048576)
      }
    }
  } catch {
    /* 读取失败保持默认 */
  }
}

async function patchSettings(patch, action, message) {
  try {
    const res = await window.cs.invoke('settings:set', { patch })
    if (res && res.ok && res.settings) settings.value = res.settings
    if (action) logAction(action, message || '')
    return true
  } catch (err) {
    ElMessage.error(`${t('common.error')}: ${(err && err.message) || ''}`)
    return false
  }
}

// ===================== 语音引擎 =====================
const engines = ref([])
const testing = ref(false)

async function loadEngines() {
  try {
    const res = await window.cs.invoke('tts:engines', {})
    if (res && res.ok) engines.value = res.engines || []
  } catch {
    engines.value = []
  }
}

async function saveEngine() {
  await patchSettings(
    { engines: { ...(settings.value.engines || {}), openai: { ...engineConfig.value } } },
    'settings.engine',
    `保存引擎配置(baseURL:${engineConfig.value.baseURL || '默认'}, model:${engineConfig.value.model})`,
  )
}

async function testEngine() {
  testing.value = true
  try {
    const res = await window.cs.invoke('tts:synthesize', {
      engineId: 'openai',
      text: '清声书坊,连接测试。',
      voice: engineConfig.value.voice || 'alloy',
      rate: 1,
      apiKey: engineConfig.value.apiKey,
      baseURL: engineConfig.value.baseURL,
    })
    if (res && res.ok) {
      ElMessage.success(t('settings.testOk'))
      logAction('settings.engineTest', '引擎连接测试成功')
    } else {
      ElMessage.error(`${t('settings.testFailed')}: ${(res && res.error) || ''}`)
    }
  } catch (err) {
    ElMessage.error(`${t('settings.testFailed')}: ${(err && err.message) || ''}`)
    logAction('settings.engineTest', `引擎连接测试失败:${(err && err.message) || ''}`)
  } finally {
    testing.value = false
  }
}

// ===================== 提醒 =====================
function onEyeEnabled(value) {
  settings.value.reminder.eye.enabled = value === true
  patchSettings({ reminder: { eye: { enabled: value === true } } }, 'settings.reminder', `护眼提醒:${value ? '开' : '关'}`)
}
function onEyeInterval(value) {
  const v = Number(value)
  if (!Number.isFinite(v) || v < 1) return
  settings.value.reminder.eye.intervalMin = Math.floor(v)
  patchSettings({ reminder: { eye: { intervalMin: Math.floor(v) } } }, 'settings.reminder', `护眼间隔:${Math.floor(v)} 分钟`)
}
function onChimeEnabled(value) {
  settings.value.reminder.chime.enabled = value === true
  patchSettings({ reminder: { chime: { enabled: value === true } } }, 'settings.reminder', `整点提示:${value ? '开' : '关'}`)
}
function onChimeVolume(value) {
  const v = Math.max(0, Math.min(1, Number(value) / 100))
  settings.value.reminder.chime.volume = v
  patchSettings({ reminder: { chime: { volume: v } } }, 'settings.reminder', `提示音音量:${Math.round(v * 100)}%`)
}

// ===================== 歌词 =====================
const lyricsSettings = computed(() => settings.value.lyrics || {})
function onDesktopLyrics(value) {
  settings.value.lyrics = { ...lyricsSettings.value, desktop: value === true }
  patchSettings({ lyrics: { desktop: value === true } }, 'settings.lyrics', `桌面歌词:${value ? '开' : '关'}`)
  window.cs.invoke('lyric:toggle-desktop', { on: value === true }).catch(() => {})
}
function onStatusBarLyrics(value) {
  settings.value.lyrics = { ...lyricsSettings.value, statusBar: value === true }
  patchSettings({ lyrics: { statusBar: value === true } }, 'settings.lyrics', `状态栏歌词:${value ? '开' : '关'}`)
}

// ===================== 全局快捷键 =====================
const shortcuts = ref({
  toggle: 'CommandOrControl+Shift+Space',
  next: 'CommandOrControl+Shift+Right',
  prev: 'CommandOrControl+Shift+Left',
  desktopLyrics: 'CommandOrControl+Shift+L',
})
const shortcutItems = computed(() => [
  { key: 'toggle', label: t('settings.shortcutToggle') },
  { key: 'next', label: t('settings.shortcutNext') },
  { key: 'prev', label: t('settings.shortcutPrev') },
  { key: 'desktopLyrics', label: t('settings.shortcutLyrics') },
])

async function saveShortcuts() {
  try {
    const res = await window.cs.invoke('shortcut:set', { actions: shortcuts.value })
    // 落盘(settings.json),重启后由主进程重新注册
    await patchSettings({ shortcuts: { ...shortcuts.value } }, 'settings.shortcuts', `保存快捷键 ${Object.keys(shortcuts.value).length} 项`)
    if (res && res.failed && res.failed.length) {
      const detail = res.failed.map((f) => `${f.action}(${f.reason})`).join('; ')
      ElMessage.warning(`${t('settings.shortcutFailed')}: ${detail}`)
    } else {
      ElMessage.success(t('settings.shortcutSaved'))
    }
  } catch (err) {
    ElMessage.error(`${t('common.error')}: ${(err && err.message) || ''}`)
  }
}

async function editShortcut(item) {
  let value = ''
  try {
    const result = await ElMessageBox.prompt(`${item.label}\n${t('settings.shortcutTip')}`, t('settings.shortcutEdit'), {
      inputValue: shortcuts.value[item.key] || '',
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
    })
    value = String(result.value || '').trim()
  } catch {
    return
  }
  if (!value) return
  shortcuts.value = { ...shortcuts.value, [item.key]: value }
  await saveShortcuts()
}

// ===================== 存储与缓存 =====================
const cache = ref({ count: 0, bytes: 0 })
const cacheLimitMb = ref(500)

function formatSize(bytes) {
  const mb = (Number(bytes || 0) / 1048576).toFixed(1)
  return `${mb} MB`
}

async function refreshCache() {
  cache.value = cacheStats()
}

async function onCacheLimit(value) {
  const mb = Number(value)
  if (!Number.isFinite(mb) || mb < 50) return
  cacheLimitMb.value = mb
  setCacheLimit(mb * 1048576)
  // 落盘(settings.json),重启后由主窗入口读回并应用
  await patchSettings({ cacheLimitMB: mb }, 'settings.cacheLimit', `缓存上限:${mb}MB`)
}

async function clearCache() {
  try {
    await ElMessageBox.confirm(t('settings.clearCacheConfirm'), t('common.confirm'), { type: 'warning' })
  } catch {
    return
  }
  const removed = await clearAll()
  await refreshCache()
  ElMessage.success(t('settings.cacheCleared', { n: removed }))
  logAction('settings.clearCache', `清空音频缓存 ${removed} 个文件`)
}

async function openDataDir() {
  await window.cs.invoke('app:open-data-dir', {})
  logAction('settings.openDataDir', '打开数据目录')
}

// ===================== 配置导入导出 =====================
const includeCorrections = ref(true)
const includeBookmarks = ref(true)

async function exportConfig() {
  try {
    const res = await window.cs.invoke('settings:export-file', {
      includeCorrections: includeCorrections.value,
      includeBookmarks: includeBookmarks.value,
    })
    if (res && res.ok) {
      ElMessage.success(t('settings.exportDone', { path: res.path }))
    }
  } catch (err) {
    ElMessage.error(`${t('common.error')}: ${(err && err.message) || ''}`)
  }
}

async function importConfig() {
  try {
    const res = await window.cs.invoke('settings:import-file', {})
    if (res && res.ok) {
      ElMessage.success(t('settings.importDone', { applied: (res.applied || []).join(',') }))
      await loadSettings()
      await loadEngines()
    }
  } catch (err) {
    ElMessage.error(`${t('common.error')}: ${(err && err.message) || ''}`)
  }
}

// ===================== 调试日志 =====================
const debugEntries = ref([])
const debugOpen = ref(false)

async function loadDebug() {
  try {
    const res = await window.cs.invoke('debug:get', {})
    if (res && res.ok) debugEntries.value = res.entries || []
  } catch {
    debugEntries.value = []
  }
}

async function copyDebug() {
  try {
    const res = await window.cs.invoke('debug:copy', {})
    if (res && res.ok) ElMessage.success(t('settings.debugCopied'))
  } catch (err) {
    ElMessage.error(`${t('common.error')}: ${(err && err.message) || ''}`)
  }
}

async function clearLog() {
  await window.cs.invoke('debug:clear', {})
  await loadDebug()
  ElMessage.success(t('settings.logCleared'))
  logAction('debug.clear', '清空调试日志')
}

async function onDebugEnabled(value) {
  settings.value.debug = { ...(settings.value.debug || {}), enabled: value === true }
  setDebugEnabled(value === true)
  await patchSettings({ debug: { enabled: value === true } }, 'settings.debug', `调试日志:${value ? '开' : '关'}`)
}

function formatLogTime(ts) {
  return String(ts || '').replace('T', ' ').slice(0, 19)
}

// ===================== 左侧锚点导航 =====================
/**
 * 分区锚点(左侧导航 → 右侧卡片)。
 * label 为 i18n 键,id 为对应卡片的 DOM id。
 */
const sections = [
  { id: 'sec-appearance', label: 'settings.appearance' },
  { id: 'sec-engines', label: 'settings.engines' },
  { id: 'sec-lyrics', label: 'settings.lyrics' },
  { id: 'sec-corrections', label: 'corrections.title' },
  { id: 'sec-reminders', label: 'settings.reminders' },
  { id: 'sec-shortcuts', label: 'settings.shortcuts' },
  { id: 'sec-storage', label: 'settings.storage' },
  { id: 'sec-config', label: 'settings.config' },
  { id: 'sec-debug', label: 'settings.debugSection' },
  { id: 'sec-about', label: 'settings.about' },
]

/** 当前视口内的分区(用于高亮左侧导航) */
const activeSection = ref(sections[0].id)

/**
 * 滚动到指定分区
 * @param {string} id 卡片 DOM id
 * @returns {void}
 */
function scrollToSection(id) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  activeSection.value = id
}

/**
 * 滚动时更新高亮项(取距顶部最近且已进入视口的卡片)
 * @returns {void}
 */
function syncActiveSection() {
  const root = document.querySelector('.settings-content')
  if (!root) return
  let best = sections[0].id
  let bestTop = Infinity
  for (const sec of sections) {
    const el = document.getElementById(sec.id)
    if (!el) continue
    const top = el.getBoundingClientRect().top
    if (top <= 120 && top < bestTop) {
      bestTop = top
      best = sec.id
    }
  }
  activeSection.value = best
}

// ===================== 关于 =====================
const appVersion = ref('')

onMounted(async () => {
  document.querySelector('.settings-content')?.addEventListener('scroll', syncActiveSection, { passive: true })
  await loadSettings()
  await loadEngines()
  await refreshCache()
  await loadDebug()
  try {
    const info = await window.cs.invoke('app:info', {})
    appVersion.value = (info && info.version) || ''
  } catch {
    appVersion.value = ''
  }
})
</script>

<template>
  <div class="settings-layout h-full">
    <!-- 左侧锚点导航 -->
    <aside class="settings-nav">
      <button
        v-for="sec in sections"
        :key="sec.id"
        type="button"
        class="settings-nav-item"
        :class="{ 'is-active': activeSection === sec.id }"
        @click="scrollToSection(sec.id)"
      >
        {{ t(sec.label) }}
      </button>
    </aside>

    <!-- 右侧卡片 -->
    <div class="settings-content">
    <!-- 外观 -->
    <el-card id="sec-appearance" :header="t('settings.appearance')">
      <div class="space-y-3">
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('settings.appearance') }}</span>
          <el-radio-group :model-value="theme" size="small" @update:model-value="onThemeChange">
            <el-radio-button value="auto">{{ t('settings.themeAuto') }}</el-radio-button>
            <el-radio-button value="light">{{ t('settings.themeLight') }}</el-radio-button>
            <el-radio-button value="dark">{{ t('settings.themeDark') }}</el-radio-button>
          </el-radio-group>
        </div>
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('settings.language') }}</span>
          <el-radio-group :model-value="locale" size="small" @update:model-value="onLocaleChange">
            <el-radio-button value="zh-CN">{{ t('settings.langZh') }}</el-radio-button>
            <el-radio-button value="en-US">{{ t('settings.langEn') }}</el-radio-button>
          </el-radio-group>
        </div>
      </div>
    </el-card>

    <!-- 语音引擎 -->
    <el-card id="sec-engines" :header="t('settings.engines')">
      <div class="space-y-3">
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('settings.defaultEngine') }}</span>
          <el-select size="small" class="w-64" :model-value="settings.defaultEngine || ''" @update:model-value="(v) => patchSettings({ defaultEngine: v }, 'settings.defaultEngine', `默认引擎:${v}`)">
            <el-option v-for="e in engines" :key="e.id" :label="e.label || e.id" :value="e.id" />
          </el-select>
        </div>
        <el-divider class="my-2" />
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('settings.openaiBase') }}</span>
          <el-input v-model="engineConfig.baseURL" size="small" class="w-96" placeholder="https://api.openai.com" />
        </div>
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('settings.openaiKey') }}</span>
          <el-input v-model="engineConfig.apiKey" size="small" class="w-96" type="password" show-password />
        </div>
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('settings.openaiModel') }}</span>
          <el-input v-model="engineConfig.model" size="small" class="w-96" placeholder="tts-1" />
        </div>
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('settings.openaiVoice') }}</span>
          <el-input v-model="engineConfig.voice" size="small" class="w-96" placeholder="alloy" />
        </div>
        <el-space>
          <el-button size="small" @click="saveEngine">{{ t('common.confirm') }}</el-button>
          <el-button size="small" type="primary" :loading="testing" @click="testEngine">
            {{ t('settings.testConnection') }}
          </el-button>
        </el-space>
      </div>
    </el-card>

    <!-- 歌词 -->
    <el-card id="sec-lyrics" :header="t('settings.lyrics')">
      <div class="space-y-3">
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('reader.desktopLyrics') }}</span>
          <el-switch :model-value="lyricsSettings.desktop !== false" @update:model-value="onDesktopLyrics" />
        </div>
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('reader.statusBarLyrics') }}</span>
          <el-switch :model-value="lyricsSettings.statusBar !== false" @update:model-value="onStatusBarLyrics" />
        </div>
      </div>
    </el-card>

    <!-- 纠错规则 -->
    <el-card id="sec-corrections" :header="t('corrections.title')">
      <div class="flex items-center gap-3 mb-1">
        <span class="text-sm">{{ t('corrections.displayCorrection') }}</span>
        <el-switch
          :model-value="correctionsStore.isDisplayCorrectionEnabled()"
          @update:model-value="(v) => correctionsStore.setDisplayCorrection(v)"
        />
      </div>
      <CorrectionRuleList />
    </el-card>

    <!-- 提醒 -->
    <el-card id="sec-reminders" :header="t('settings.reminders')">
      <div class="space-y-3">
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('reminder.eyeEnabled') }}</span>
          <el-switch :model-value="reminderSettings.eye && reminderSettings.eye.enabled" @update:model-value="onEyeEnabled" />
        </div>
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('reminder.eyeInterval') }}</span>
          <el-input-number
            :model-value="reminderSettings.eye && reminderSettings.eye.intervalMin"
            :min="1"
            :max="60"
            size="small"
            @update:model-value="onEyeInterval"
          />
        </div>
        <el-divider class="my-2" />
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('reminder.chimeEnabled') }}</span>
          <el-switch :model-value="reminderSettings.chime && reminderSettings.chime.enabled" @update:model-value="onChimeEnabled" />
        </div>
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('reminder.chimeVolume') }}</span>
          <el-slider
            class="flex-1"
            :model-value="Math.round(((reminderSettings.chime && reminderSettings.chime.volume) || 0) * 100)"
            :min="0"
            :max="100"
            @update:model-value="onChimeVolume"
          />
        </div>
      </div>
    </el-card>

    <!-- 全局快捷键 -->
    <el-card id="sec-shortcuts" :header="t('settings.shortcuts')">
      <div class="space-y-3">
        <div v-for="item in shortcutItems" :key="item.key" class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ item.label }}</span>
          <code class="shortcut-code">{{ shortcuts[item.key] || '—' }}</code>
          <el-button size="small" @click="editShortcut(item)">{{ t('settings.shortcutEdit') }}</el-button>
        </div>
        <p class="text-xs text-gray-400">{{ t('settings.shortcutTip') }}</p>
      </div>
    </el-card>

    <!-- 存储与缓存 -->
    <el-card id="sec-storage" :header="t('settings.storage')">
      <div class="space-y-3">
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('settings.cacheLimit') }}</span>
          <el-slider
            class="flex-1"
            :model-value="cacheLimitMb"
            :min="100"
            :max="2000"
            :step="100"
            @update:model-value="onCacheLimit"
          />
          <span class="w-20 text-right text-xs">{{ cacheLimitMb }} MB</span>
        </div>
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('settings.cacheUsage') }}</span>
          <span class="text-xs">{{ formatSize(cache.bytes) }} · {{ cache.count }} 个文件</span>
          <el-button size="small" @click="refreshCache">{{ t('common.confirm') }}</el-button>
          <el-button size="small" type="danger" plain @click="clearCache">{{ t('settings.clearCache') }}</el-button>
        </div>
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('settings.openDataDir') }}</span>
          <el-button size="small" @click="openDataDir">{{ t('settings.openDataDir') }}</el-button>
        </div>
      </div>
    </el-card>

    <!-- 配置导入导出 -->
    <el-card id="sec-config" :header="t('settings.config')">
      <div class="space-y-3">
        <div class="flex items-center gap-3">
          <el-checkbox v-model="includeCorrections">{{ t('settings.includeCorrections') }}</el-checkbox>
          <el-checkbox v-model="includeBookmarks">{{ t('settings.includeBookmarks') }}</el-checkbox>
        </div>
        <el-space>
          <el-button type="primary" size="small" @click="exportConfig">{{ t('settings.exportConfig') }}</el-button>
          <el-button size="small" @click="importConfig">{{ t('settings.importConfig') }}</el-button>
        </el-space>
      </div>
    </el-card>

    <!-- 调试日志 -->
    <el-card id="sec-debug" :header="t('settings.debugSection')">
      <div class="space-y-3">
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('settings.debugEnable') }}</span>
          <el-switch :model-value="(settings.debug || {}).enabled !== false" @update:model-value="onDebugEnabled" />
        </div>
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0">{{ t('settings.logCount', { n: debugEntries.length }) }}</span>
          <el-button size="small" type="primary" @click="copyDebug">{{ t('settings.copyDebug') }}</el-button>
          <el-button size="small" @click="loadDebug">{{ t('common.confirm') }}</el-button>
          <el-button size="small" type="danger" plain @click="clearLog">{{ t('settings.clearLog') }}</el-button>
        </div>
        <el-collapse v-model="debugOpen" @change="loadDebug">
          <el-collapse-item :title="t('settings.debugSection')">
            <div class="debug-list">
              <div v-if="!debugEntries.length" class="text-xs text-gray-400">{{ t('settings.noLog') }}</div>
              <div v-for="(entry, i) in debugEntries" :key="i" class="debug-row" :class="`is-${entry.level}`">
                <span class="debug-time">{{ formatLogTime(entry.ts) }}</span>
                <span class="debug-action">{{ entry.action }}</span>
                <span class="debug-msg">{{ entry.message }}</span>
              </div>
            </div>
          </el-collapse-item>
        </el-collapse>
      </div>
    </el-card>

    <!-- 关于 -->
    <el-card id="sec-about" :header="t('settings.about')">
      <div class="text-xs text-gray-500 space-y-1">
        <div>清声书坊 · {{ t('settings.version') }} {{ appVersion }}</div>
        <div>{{ t('app.brandSub') }}</div>
      </div>
    </el-card>
    </div>
  </div>
</template>

<style scoped>
/* ===== 布局:左侧锚点 + 右侧卡片 ===== */
.settings-layout {
  display: flex;
  height: 100%;
  overflow: hidden;
}

/* 左侧锚点导航(固定,不随右侧滚动) */
.settings-nav {
  flex: none;
  width: 124px;
  padding: 10px 6px 10px 10px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  border-right: 1px solid var(--cs-border, rgba(0, 0, 0, 0.06));
}

.settings-nav-item {
  border: 0;
  background: transparent;
  color: var(--cs-fg, #333);
  font: inherit;
  font-size: 13px;
  text-align: left;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
  /* 导航项不折行:「外观主题(夜间模式)」原本断成两行 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.settings-nav-item:hover {
  background: color-mix(in srgb, var(--cs-fg, #333) 6%, transparent);
}

.settings-nav-item.is-active {
  background: color-mix(in srgb, var(--el-color-primary, #409eff) 14%, transparent);
  color: var(--el-color-primary, #409eff);
  font-weight: 600;
}

/* 右侧卡片区(独立滚动) */
.settings-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 10px 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 卡片标题前的蓝色竖杠(标识这是个分组标题) */
.settings-content :deep(.el-card__header) {
  /* 左边距给竖杠留位:竖杆 → 文字 间距 6px(原来贴边 + 离文字 8px) */
  padding: 7px 11px 7px 16px;
  font-weight: 600;
  position: relative;
}

.settings-content :deep(.el-card__header::before) {
  content: '';
  position: absolute;
  /* 竖杆离卡片边框 7px,不再贴着边框 */
  left: 7px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 15px;
  border-radius: 2px;
  background: var(--el-color-primary, #409eff);
}

.settings-content :deep(.el-card) {
  /* el-card 默认 overflow:hidden → 其 min-height:auto 解析为 0,
     在 column flex 中会被压缩成"只剩标题"的细条(内容被裁切,设置页不可用)。
     固定不收缩:卡片高度由内容决定,超出交给 .settings-content 自身滚动。 */
  flex: none;
  scroll-margin-top: 12px;
}

/* 卡片内容内边距收紧(Element Plus 默认 20px 过宽) */
.settings-content :deep(.el-card__body) {
  padding: 12px 14px;
  /* 卡片高度已自适应内容,不再需要内部滚动条
     (内部滚动条会超出卡片底边,看起来像"栏高于栏目") */
  overflow: hidden;
}

.shortcut-code {
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--cs-fg, #333) 8%, transparent);
}
.debug-list {
  max-height: 320px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.7;
}
.debug-row {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  border-bottom: 1px dashed var(--cs-border, rgba(0, 0, 0, 0.06));
}
.debug-time {
  flex: none;
  opacity: 0.5;
}
.debug-action {
  flex: none;
  width: 130px;
  opacity: 0.75;
}
.debug-msg {
  flex: 1;
  word-break: break-all;
}
.debug-row.is-error .debug-msg {
  color: #f56c6c;
}
</style>
