<script setup>
/**
 * 托盘面板 App.vue —— mac 状态栏点击弹出的 260×150 深色播放面板
 *
 * 依据 docs/DESIGN.md §5「macOS 状态栏歌词 + 托盘面板」:
 *   ┌────────────────────────────────┐
 *   │  我要如何歌颂你,如何拥抱你      │ ← 当前行(高亮)
 *   │  那些年我们错过的雨季            │ ← 预告行(淡色)
 *   │  [⏮] [⏸] [⏭] [⏹ 退出听书]      │ ← 播放控制
 *   │  [桌面歌词已开启 ●] [锁定歌词]   │ ← 功能开关
 *   │  引擎 edge · 音色 晓晓 · 1.0x   │ ← 引擎/音色/语速(只读)
 *   └────────────────────────────────┘
 *
 * 数据流(t09 主进程广播,preload 白名单已就绪):
 *   - cs.on('lyric:tick-push')   → {lineText, nextText, status, ...}
 *   - cs.on('player:state-push') → {status, engineId, voice, rate, ...}
 *   - cs.invoke('player:control', {action:'prev'|'toggle'|'next'|'stop'})
 *   - cs.invoke('lyric:toggle-desktop', {on})
 *   - cs.invoke('lyric:set-locked', {locked})
 *
 * 高频推送优化(tick 最高 ~5 次/秒):所有展示字段收在**单个 shallowRef 快照**里,
 * 推送到达后逐字段比对,内容未变则不替换引用 → Vue 不触发重渲染。
 *
 * 轻量约束:本面板是独立窗口入口(src/tray-panel/index.js 不挂 vue-i18n),
 * 文案直接取词条表 zhCN(不引 Element Plus,纯手写按钮)。
 */

import { computed, onBeforeUnmount, onMounted, onUpdated, ref, shallowRef } from 'vue'
import zhCN from '@/locales/zh-CN'

/** 词条(歌词域 + 阅读域) */
const L = zhCN.lyrics
const R = zhCN.reader

/** 引擎 id → 中文名(与阅读器 PlayerBar 的映射一致;未知 id 回落到 id 本身) */
const ENGINE_LABEL_KEYS = {
  say: 'reader.engineSay',
  sapi: 'reader.engineSapi',
  edge: 'reader.engineEdge',
  openai: 'reader.engineOpenai',
}

/** 快照可被推送覆盖的字段 */
const SNAPSHOT_KEYS = [
  'lineText',
  'nextText',
  'status',
  'engineId',
  'voice',
  'rate',
  'chapterIdx',
  'segIdx',
  'segOffsetRatio',
]

/**
 * 展示快照(浅层响应式):tick / state 推送合并进这里
 * @type {import('vue').ShallowRef<{lineText: string, nextText: string, status: string, engineId: string, voice: string, rate: string}>}
 */
const snapshot = shallowRef({
  lineText: '',
  nextText: '',
  status: '',
  engineId: '',
  voice: '',
  rate: '',
  chapterIdx: -1,
  segIdx: -1,
  segOffsetRatio: 0,
})

/** 桌面歌词是否开启(本地乐观翻转) */
const desktopOn = ref(false)

/** 桌面歌词是否锁定(本地记录) */
const locked = ref(false)

/** 取消订阅句柄 */
let offTick = null
let offState = null

/** 组件更新计数(仅开发态调试钩子用,用于验收「文本不变不重渲染」) */
let renderCount = 0

/**
 * 合并推送字段到快照:逐字段比对,无变化则不替换引用(不触发重渲染)
 * @param {object} patch 推送字段(值为 undefined 的键视为「本次不携带」)
 * @returns {boolean} 是否真的发生变化
 */
function applyPatch(patch) {
  if (!patch || typeof patch !== 'object') return false
  const cur = snapshot.value
  const next = { ...cur }
  let changed = false
  for (const key of SNAPSHOT_KEYS) {
    const raw = patch[key]
    if (raw === undefined) continue
    const value = raw === null ? '' : String(raw)
    if (next[key] !== value) {
      next[key] = value
      changed = true
    }
  }
  if (!changed) return false
  snapshot.value = next
  return true
}

/**
 * 调用主进程 IPC(无 preload / 调用失败时返回 null,调用方负责回滚乐观值)
 * @param {string} channel 通道名
 * @param {object} payload 参数
 * @returns {Promise<object|null>}
 */
async function invokeCs(channel, payload) {
  if (typeof window === 'undefined' || !window.cs || typeof window.cs.invoke !== 'function') return null
  try {
    return await window.cs.invoke(channel, payload)
  } catch (err) {
    console.error(`[tray-panel] ${channel} 调用失败:`, err)
    return null
  }
}

/**
 * tick 推送回调:当前句 / 下一句 / 状态
 * @param {object} payload tick 载荷
 * @returns {void}
 */
function onTick(payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  applyPatch({
    lineText: p.lineText,
    nextText: p.nextText,
    // tick 的 status 可能为空(主进程未收到播放状态)→ 空值不覆盖已知状态
    status: p.status || undefined,
    chapterIdx: Number.isFinite(Number(p.chapterIdx)) ? Number(p.chapterIdx) : undefined,
    segIdx: Number.isFinite(Number(p.segIdx)) ? Number(p.segIdx) : undefined,
    segOffsetRatio: Number.isFinite(Number(p.segOffsetRatio)) ? Number(p.segOffsetRatio) : undefined,
  })
}

/**
 * state 推送回调:播放状态 / 引擎 / 音色 / 语速
 * @param {object} payload state 载荷
 * @returns {void}
 */
function onState(payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  applyPatch({
    status: p.status,
    engineId: p.engineId,
    voice: p.voice,
    rate: p.rate,
  })
}

/** 当前句 */
const lineText = computed(() => snapshot.value.lineText)

/** 下一句(预告行) */
const nextText = computed(() => snapshot.value.nextText)

/** 播放状态 */
const status = computed(() => snapshot.value.status)

/**
 * 当前句「已播放」的字符数。
 *
 * TTS 只给整段音频、没有词级时间戳,这里用句内进度比例线性映射到字符数,
 * 做出逐字推进的高亮效果。
 * @returns {number}
 */
const playedCount = computed(() => {
  const total = Array.from(snapshot.value.lineText || '').length
  if (total === 0) return 0
  const ratio = Math.min(1, Math.max(0, Number(snapshot.value.segOffsetRatio) || 0))
  return Math.round(total * ratio)
})

/** 已播放部分(高亮) */
const playedText = computed(() => Array.from(snapshot.value.lineText || '').slice(0, playedCount.value).join(''))

/** 未播放部分(暗色) */
const upcomingText = computed(() => Array.from(snapshot.value.lineText || '').slice(playedCount.value).join(''))

/** 位置提示(第几章) */
const positionLabel = computed(() => {
  const idx = Number(snapshot.value.chapterIdx)
  if (!Number.isFinite(idx) || idx < 0) return ''
  const tpl = L.chapterAt || '第 {n} 章'
  return tpl.replace('{n}', String(idx + 1))
})

/** 是否正在播放 */
const isPlaying = computed(() => status.value === 'playing')

/** 播放/暂停按钮图标 */
const playIcon = computed(() => (isPlaying.value ? '⏸' : '⏯'))

/** 播放按钮 title */
const playTitle = computed(() => (isPlaying.value ? R.paused : R.playing))

/** 是否有播放(有歌词行或状态非 idle) */
const hasPlayback = computed(() => Boolean(lineText.value) || (status.value && status.value !== 'idle'))

/**
 * 引擎 id → 中文名(与阅读器 PlayerBar 的映射一致;未知 id 回落到 id 本身)
 * @param {string} id 引擎 id
 * @returns {string}
 */
function engineLabel(id) {
  const key = ENGINE_LABEL_KEYS[id]
  if (!key) return id
  // key 形如 'reader.engineEdge' → 逐段取值
  const parts = key.split('.')
  let node = zhCN
  for (const seg of parts) {
    if (!node || typeof node !== 'object') return id
    node = node[seg]
  }
  return typeof node === 'string' && node ? node : id
}

/**
 * 语速展示格式化:1 → "1.0x";1.25 → "1.25x";非法 → "—"
 * @param {string} raw 原始语速字符串
 * @returns {string}
 */
function formatRate(raw) {
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return '—'
  return `${Number(num.toFixed(2))}x`
}

/** 引擎 · 音色 · 语速(只读小字) */
const engineInfo = computed(() => {
  const s = snapshot.value
  const parts = []
  parts.push(s.engineId ? `${R.engine} ${engineLabel(s.engineId)}` : `${R.engine} —`)
  parts.push(s.voice ? `${R.voice} ${s.voice}` : `${R.voice} —`)
  parts.push(`${R.speed} ${formatRate(s.rate)}`)
  return parts.join(' · ')
})

/**
 * 播放控制:上一句 / 播放暂停 / 下一句 / 退出听书
 * @param {'prev'|'toggle'|'next'|'stop'} action 控制动作
 * @returns {Promise<void>}
 */
async function sendControl(action) {
  await invokeCs('player:control', { action })
}

/**
 * 上一句
 * @returns {Promise<void>}
 */
function onPrev() {
  return sendControl('prev')
}

/**
 * 播放 / 暂停
 * @returns {Promise<void>}
 */
function onToggle() {
  return sendControl('toggle')
}

/**
 * 下一句
 * @returns {Promise<void>}
 */
function onNext() {
  return sendControl('next')
}

/**
 * 退出听书
 * @returns {Promise<void>}
 */
function onStop() {
  return sendControl('stop')
}

/**
 * 桌面歌词开关:本地乐观翻转,invoke 失败回滚
 * @returns {Promise<void>}
 */
async function toggleDesktop() {
  const on = !desktopOn.value
  desktopOn.value = on
  const res = await invokeCs('lyric:toggle-desktop', { on })
  if (!res) {
    desktopOn.value = !on
    return
  }
  if (typeof res.visible === 'boolean') desktopOn.value = res.visible
}

/**
 * 锁定歌词开关:本地翻转,invoke 失败回滚
 * @returns {Promise<void>}
 */
async function toggleLocked() {
  const next = !locked.value
  locked.value = next
  const res = await invokeCs('lyric:set-locked', { locked: next })
  if (!res) {
    locked.value = !next
    return
  }
  if (typeof res.locked === 'boolean') locked.value = res.locked
}

onMounted(() => {
  if (typeof window === 'undefined' || !window.cs || typeof window.cs.on !== 'function') return
  try {
    offTick = window.cs.on('lyric:tick-push', onTick)
    offState = window.cs.on('player:state-push', onState)
  } catch (err) {
    console.error('[tray-panel] 订阅推送失败:', err)
  }
  // 开发态调试钩子:验收「tick 文本不变不重渲染」需要观察更新次数
  if (import.meta.env && import.meta.env.DEV) {
    window.__csTrayPanel = {
      snapshot: () => ({ ...snapshot.value }),
      renderCount: () => renderCount,
    }
  }
})

onUpdated(() => {
  renderCount += 1
})

onBeforeUnmount(() => {
  if (typeof offTick === 'function') offTick()
  if (typeof offState === 'function') offState()
  offTick = null
  offState = null
})
</script>

<template>
  <div class="panel">
    <!-- 顶部两行歌词:当前句(高亮)+ 下一句(淡色) -->
    <div class="lyrics">
      <p class="line-curr" :title="lineText">
        <span class="line-played">{{ playedText }}</span
        ><span class="line-upcoming">{{ upcomingText }}</span>
      </p>
      <p class="line-next" :title="nextText">{{ nextText }}</p>
      <p v-if="positionLabel" class="line-position">{{ positionLabel }}</p>
    </div>

    <!-- 无播放提示 -->
    <p v-if="!hasPlayback" class="no-playback">{{ L.noPlayback }}</p>

    <!-- 控制行:上一句 / 播放暂停 / 下一句 / 退出听书 -->
    <div class="controls">
      <button class="btn" type="button" :title="R.segPrev" @click="onPrev">⏮</button>
      <button class="btn btn-main" type="button" :title="playTitle" @click="onToggle">{{ playIcon }}</button>
      <button class="btn" type="button" :title="R.segNext" @click="onNext">⏭</button>
      <button class="btn btn-stop" type="button" :title="R.listenOff" @click="onStop">⏹ {{ R.listenOff }}</button>
    </div>

    <!-- 功能行:桌面歌词开关 / 锁定歌词开关 -->
    <div class="features">
      <button
        class="btn btn-toggle"
        type="button"
        :class="{ 'is-on': desktopOn }"
        :title="desktopOn ? L.desktopOn : L.desktopOff"
        @click="toggleDesktop"
      >
        {{ desktopOn ? L.desktopOn : L.desktopOff }}
      </button>
      <button
        class="btn btn-toggle"
        type="button"
        :class="{ 'is-on': locked }"
        :title="locked ? L.lock : L.unlock"
        @click="toggleLocked"
      >
        {{ locked ? L.lock : L.unlock }}
      </button>
    </div>

    <!-- 引擎 / 音色 / 语速(只读) -->
    <p class="engine-info" :title="engineInfo">{{ engineInfo }}</p>
  </div>
</template>

<style>
html,
body,
#app {
  background: transparent;
  margin: 0;
  height: 100%;
}
.panel {
  height: 100%;
  padding: 10px 14px;
  box-sizing: border-box;
  background: rgba(28, 28, 30, 0.92);
  border-radius: 12px;
  color: #fff;
  user-select: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: hidden;
}

/* 顶部两行歌词 */
.lyrics {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.line-curr {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 逐字高亮:未播放部分降低不透明度 */
.line-upcoming {
  opacity: 0.45;
}

/* 位置提示(第几章) */
.line-position {
  margin: 0;
  font-size: 11px;
  line-height: 1.25;
  color: rgba(255, 255, 255, 0.5);
}

.line-next {
  margin: 0;
  font-size: 12px;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 无播放提示 */
.no-playback {
  margin: 0;
  font-size: 11px;
  line-height: 1.3;
  color: rgba(255, 255, 255, 0.45);
}

/* 控制行 */
.controls {
  flex: none;
  display: flex;
  gap: 8px;
  justify-content: center;
  align-items: center;
}
.features {
  flex: none;
  display: flex;
  gap: 8px;
  justify-content: center;
  align-items: center;
}

/* 纯手写按钮(不引 Element Plus) */
.btn {
  border: none;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1.2;
  font-family: inherit;
  transition: background 0.15s ease;
}
.btn:hover {
  background: rgba(255, 255, 255, 0.24);
}
.btn:active {
  background: rgba(255, 255, 255, 0.32);
}
.btn-main {
  background: rgba(255, 179, 71, 0.9);
}
.btn-main:hover {
  background: rgba(255, 179, 71, 1);
}
.btn-stop {
  font-size: 12px;
}
.btn-toggle {
  font-size: 11px;
  padding: 3px 8px;
  color: rgba(255, 255, 255, 0.78);
}
.btn-toggle.is-on {
  background: rgba(255, 179, 71, 0.9);
  color: #fff;
}

/* 引擎 / 音色 / 语速(只读小字) */
.engine-info {
  flex: none;
  margin: 0;
  font-size: 11px;
  line-height: 1.3;
  color: rgba(255, 255, 255, 0.5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
