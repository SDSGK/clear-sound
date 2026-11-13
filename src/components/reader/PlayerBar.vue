<script setup>
/**
 * PlayerBar.vue —— 阅读器底部听书控制条(语音模式)
 *
 * 依据 docs/DESIGN.md §3「语音模式底部控制条」:
 *   [⏮ 段-] [ ⏸ ] [段+ ⏭] ───●──────────  12:34 / 58:20
 *   引擎 edge-tts ▾ · 音色 晓晓 ▾ · 语速 1.0x ▾ · [歌词: 桌面● 状态栏●]
 *
 * 布局:
 *   左:上一句 / 播放暂停 / 下一句 / 退出听书
 *   中:进度文本(第 cur/total 句);error 态显示「语音合成失败 + 切换引擎重试」
 *   右:引擎 / 音色 / 语速 下拉 + 桌面歌词(占位)
 *
 * 数据源:player store(t06 产物)。本组件不落 localStorage —— 偏好由 store 统一持久化。
 */

import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { usePlayerStore } from '@/stores/player'

const { t } = useI18n()
const player = usePlayerStore()

/** 语速可选值(PLAN §4.3:0.5 ~ 2.0) */
const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]

/** 引擎 id → i18n 词条(未知引擎回落到引擎自带 label) */
const ENGINE_LABEL_KEYS = {
  say: 'reader.engineSay',
  sapi: 'reader.engineSapi',
  edge: 'reader.engineEdge',
  openai: 'reader.engineOpenai',
}

/**
 * 引擎显示名:已知 id 走 i18n,未知 id 用引擎自带 label
 * @param {{id: string, label?: string}} engine 引擎
 * @returns {string}
 */
function engineLabel(engine) {
  const key = ENGINE_LABEL_KEYS[engine && engine.id]
  if (key) return t(key)
  return (engine && engine.label) || String((engine && engine.id) || '')
}

/** 可选引擎(仅 available;needsKey 的仍列出但禁用,提示去设置填 Key) */
const availableEngines = computed(() =>
  (player.engines || []).filter((e) => e && e.available),
)

/** 当前引擎的音色列表(随引擎切换变化) */
const voices = computed(() => {
  const eng = (player.engines || []).find((e) => e && e.id === player.engineId)
  return eng && Array.isArray(eng.voices) ? eng.voices : []
})

/** 当前句序号(segIdx 从 0 起,展示 +1) */
const curSeg = computed(() => (Number.isFinite(player.segIdx) ? player.segIdx + 1 : 0))

/** 是否处于合成中 */
const isLoading = computed(() => player.status === 'loading')

/** 是否处于错误态 */
const isError = computed(() => player.status === 'error')

/** 播放/暂停图标:playing 显示暂停符,其余显示播放符 */
const playIcon = computed(() => (player.status === 'playing' ? '⏸' : '⏯'))

/**
 * 播放按钮 title
 *
 * playing→暂停、paused→继续播放、loading→合成中、error→重试,
 * 其余(idle)→开始播放。
 */
const playTitle = computed(() => {
  if (player.status === 'playing') return t('reader.paused')
  if (player.status === 'paused') return t('reader.playing')
  if (player.status === 'loading') return t('reader.ttsLoading')
  if (player.status === 'error') return t('reader.ttsFailed')
  return t('reader.listenOn')
})

/** 是否有可切换的引擎(available 且不需要 Key) */
const switchableEngines = computed(() =>
  (player.engines || []).filter((e) => e && e.available && !e.needsKey),
)

/**
 * 桌面歌词窗是否开启(本地乐观翻转,主进程 show/hide 为唯一真相)
 * @type {import('vue').Ref<boolean>}
 */
const desktopLyricsOn = ref(false)

/**
 * 切换桌面歌词窗显隐
 *
 * 走 preload 白名单通道 `lyric:toggle-desktop`(主进程 → 桌面歌词窗 show/hide);
 * 本地乐观翻转并按主进程返回的 visible 校正,失败回滚 + ElMessage 提示。
 * @returns {Promise<void>}
 */
async function onToggleDesktopLyrics() {
  const on = !desktopLyricsOn.value
  desktopLyricsOn.value = on
  if (typeof window === 'undefined' || !window.cs || typeof window.cs.invoke !== 'function') {
    desktopLyricsOn.value = !on
    ElMessage.error(t('reader.ttsFailed'))
    return
  }
  try {
    const res = await window.cs.invoke('lyric:toggle-desktop', { on })
    if (res && typeof res.visible === 'boolean') {
      desktopLyricsOn.value = res.visible
    }
    ElMessage.success(t(desktopLyricsOn.value ? 'lyrics.desktopOn' : 'lyrics.desktopOff'))
  } catch (err) {
    desktopLyricsOn.value = !on
    ElMessage.error(t('reader.ttsFailed'))
    console.error('[PlayerBar] lyric:toggle-desktop 失败:', err)
  }
}

/**
 * 上一句
 * @returns {void}
 */
function onPrev() {
  player.prevSeg()
}

/**
 * 下一句
 * @returns {void}
 */
function onNext() {
  player.nextSeg()
}

/**
 * 播放 / 暂停
 *
 * error 态不直接 resume(那会把 UI 置成假播放,却听不到声音),
 * 而是重播当前段(重新合成);
 * loading 态无音频可播,忽略点击(避免 resume 把状态提前置成 playing)。
 * @returns {void}
 */
function onTogglePlay() {
  if (player.status === 'playing') {
    player.pause()
    return
  }
  if (player.status === 'loading') {
    return
  }
  if (player.status === 'error') {
    // 合成失败后点播放 → 重播当前段(重新合成,相当于「重试」)
    if (player.chapterIdx >= 0 && player.segIdx >= 0) {
      player.seekSeg(player.chapterIdx, player.segIdx)
      return
    }
    // 没有可重播的位置(如空章 CHAPTER_EMPTY)→ 给出提示,而不是静默无反应
    ElMessage.error(t('reader.ttsFailed'))
    return
  }
  player.resume()
}

/**
 * 退出听书(停止播放,保留进度)
 * @returns {void}
 */
function onExit() {
  player.stop()
}

/**
 * 切换引擎:换到下一个 available 且不需要 Key 的引擎,并重播当前段
 * @returns {void}
 */
function onSwitchEngine() {
  const list = switchableEngines.value
  if (!list.length) return
  const idx = list.findIndex((e) => e.id === player.engineId)
  const next = list[(idx + 1) % list.length]
  if (!next) return
  player.setEngine(next.id)
  // 重播当前段(换引擎后缓存必然 miss → 重新合成)
  if (player.chapterIdx >= 0 && player.segIdx >= 0) {
    player.seekSeg(player.chapterIdx, player.segIdx)
    return
  }
  // 没有可重播的位置(如空章 CHAPTER_EMPTY)→ 给出提示,而不是静默无反应
  ElMessage.error(t('reader.ttsFailed'))
}

/**
 * 引擎下拉变更
 * @param {string} id 引擎 id
 * @returns {void}
 */
function onEngineChange(id) {
  if (!id) return
  player.setEngine(String(id))
}

/**
 * 音色下拉变更
 * @param {string} v 音色 id
 * @returns {void}
 */
function onVoiceChange(v) {
  if (!v) return
  player.setVoice(String(v))
}

/**
 * 语速下拉变更
 * @param {number | string} r 语速
 * @returns {void}
 */
function onRateChange(r) {
  const num = Number(r)
  if (!Number.isFinite(num)) return
  player.setRate(num)
}
</script>

<template>
  <div class="player-bar" role="toolbar" :aria-label="t('reader.listen')">
    <!-- 左:播放控制 -->
    <div class="pb-left flex items-center gap-1">
      <button class="pb-icon-btn" type="button" :title="t('reader.segPrev')" @click="onPrev">⏮</button>
      <button class="pb-icon-btn" type="button" :title="playTitle" :disabled="isLoading" @click="onTogglePlay">{{ playIcon }}</button>
      <button class="pb-icon-btn" type="button" :title="t('reader.segNext')" @click="onNext">⏭</button>
      <button class="pb-text-btn" type="button" :title="t('reader.listenOff')" @click="onExit">
        {{ t('reader.listenOff') }}
      </button>
    </div>

    <!-- 中:进度 / 状态 -->
    <div class="pb-mid flex items-center gap-2 min-w-0">
      <span class="pb-progress">{{ t('reader.segProgress', { cur: curSeg, total: player.segsTotal }) }}</span>
      <span v-if="isLoading" class="pb-status is-loading">{{ t('reader.ttsLoading') }}</span>
      <template v-if="isError">
        <span class="pb-status is-error">{{ t('reader.ttsFailed') }}</span>
        <button class="pb-text-btn is-warn" type="button" @click="onSwitchEngine">
          {{ t('reader.ttsSwitchEngine') }}
        </button>
      </template>
    </div>

    <!-- 右:引擎 / 音色 / 语速 / 桌面歌词 -->
    <div class="pb-right flex items-center gap-2">
      <label class="pb-field">
        <span class="pb-field-label">{{ t('reader.engine') }}</span>
        <el-select
          :model-value="player.engineId"
          size="small"
          class="pb-select"
          @change="onEngineChange"
        >
          <el-option
            v-for="e in availableEngines"
            :key="e.id"
            :label="engineLabel(e)"
            :value="e.id"
            :disabled="!!e.needsKey"
            :title="e.needsKey ? t('reader.needKey') : ''"
          />
        </el-select>
      </label>

      <label class="pb-field">
        <span class="pb-field-label">{{ t('reader.voice') }}</span>
        <el-select
          :model-value="player.voice"
          size="small"
          class="pb-select"
          @change="onVoiceChange"
        >
          <el-option v-for="v in voices" :key="v.id" :label="v.label || v.id" :value="v.id" />
        </el-select>
      </label>

      <label class="pb-field">
        <span class="pb-field-label">{{ t('reader.speed') }}</span>
        <el-select :model-value="player.rate" size="small" class="pb-select" @change="onRateChange">
          <el-option v-for="r in RATE_OPTIONS" :key="r" :label="`${r}x`" :value="r" />
        </el-select>
      </label>

      <button
        class="pb-text-btn"
        type="button"
        :class="{ 'is-on': desktopLyricsOn }"
        :title="t('reader.desktopLyrics')"
        @click="onToggleDesktopLyrics"
      >
        {{ t('reader.desktopLyrics') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 底部控制条:固定在阅读区底部,顶部一条细边框 */
.player-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 10px;
  background: var(--cs-panel, #fff);
  border-top: 1px solid var(--cs-border, rgba(0, 0, 0, 0.08));
  color: var(--cs-fg, #333);
  font-size: 13px;
}

.pb-left,
.pb-right {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.pb-mid {
  flex: 1;
  justify-content: center;
  overflow: hidden;
}

.pb-icon-btn {
  min-width: 30px;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--cs-border, rgba(0, 0, 0, 0.08));
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.pb-icon-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--cs-fg, #333) 8%, transparent);
}

.pb-icon-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.pb-text-btn {
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--cs-border, rgba(0, 0, 0, 0.08));
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}

.pb-text-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--cs-fg, #333) 8%, transparent);
}

.pb-text-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.pb-text-btn.is-warn {
  border-color: color-mix(in srgb, #e6a23c 60%, transparent);
  color: #e6a23c;
}

/* 桌面歌词开关:开启态高亮 */
.pb-text-btn.is-on {
  border-color: color-mix(in srgb, #e6a23c 70%, transparent);
  color: #e6a23c;
}

.pb-progress {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.pb-status {
  white-space: nowrap;
}

.pb-status.is-loading {
  color: var(--cs-fg, #333);
  opacity: 0.75;
}

.pb-status.is-error {
  color: #f56c6c;
}

.pb-field {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pb-field-label {
  opacity: 0.6;
  font-size: 12px;
  white-space: nowrap;
}

.pb-select {
  width: 132px;
}
</style>
