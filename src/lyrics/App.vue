<script setup>
/**
 * 桌面歌词窗(App.vue)—— 网易云风格悬浮歌词
 *
 * 依据 docs/DESIGN.md §4:
 *  - 当前句:渐变大字 + 描边(filter: drop-shadow),句变化时 200ms 渐入
 *  - 下一句:淡色小字(双行模式)
 *  - 整窗可拖(-webkit-app-region: drag),hover 显示右上角微型工具条
 *    [锁定] [样式] [关闭]
 *  - 锁定后主进程 setIgnoreMouseEvents(true) → 鼠标完全穿透
 *  - 样式可调:单行/双行 · 字体/字号 · 渐变起止色 · 背景条不透明度
 *
 * 数据来源:主进程广播 'lyric:tick-push'(electron/index.js broadcastTick)
 *   payload: {lineText, nextText, status, bookId, chapterIdx, segIdx}
 *
 * 本窗不接 vue-i18n(见 src/lyrics/index.js 说明),词条直接取 zh-CN 词条对象。
 * 样式仅本地渲染层生效:localStorage['cs.lyrics.style'](单条 JSON)。
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import zhCN from '@/locales/zh-CN'
import StylePanel from './style-panel.vue'

/** 词条(歌词窗未接 vue-i18n,直接引用 zh-CN 词条对象) */
const T = zhCN.lyrics
const BRAND = zhCN.app.brand

/** 样式持久化键(单条 JSON,便于整体读写与容错) */
const STYLE_KEY = 'cs.lyrics.style'

/** 各模式对应的窗口高度(主进程 lyric:resize 夹在 [48,160]) */
const HEIGHT_SINGLE = 52
const HEIGHT_DOUBLE = 96

/** 样式面板控件取值范围 */
const FONT_SIZE_MIN = 16
const FONT_SIZE_MAX = 36
const BG_OPACITY_MIN = 0
const BG_OPACITY_MAX = 0.6

/** 锁定提示角标展示时长(ms) */
const LOCK_BADGE_MS = 1500

/** 默认样式 */
const DEFAULT_STYLE = Object.freeze({
  lineMode: 'double', // 'single' | 'double'
  fontFamily: 'system', // 'system' | 'songti' | 'heiti' | 'kai'
  fontSize: 24,
  gradientFrom: '#ffb347',
  gradientTo: '#ff5e62',
  bgOpacity: 0.35,
})

/** 字体 value → CSS font-family */
const FONT_FAMILIES = Object.freeze({
  system: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', sans-serif",
  songti: "'Songti SC', 'SimSun', 'Noto Serif CJK SC', serif",
  heiti: "'Heiti SC', 'Microsoft YaHei', 'PingFang SC', sans-serif",
  kai: "'Kaiti SC', 'STKaiti', KaiTi, serif",
})

/** 样式面板的字体选项(中文标签 → value) */
const FONT_OPTIONS = Object.freeze([
  { value: 'system', label: '系统默认' },
  { value: 'songti', label: '宋体' },
  { value: 'heiti', label: '黑体' },
  { value: 'kai', label: '楷体' },
])

/**
 * 数值钳制
 * @param {unknown} value 原始值
 * @param {number} min 下界
 * @param {number} max 上界
 * @param {number} fallback 非法回退值
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  if (num < min) return min
  if (num > max) return max
  return num
}

/**
 * 归一化样式(非法字段回落到默认值)
 * @param {unknown} raw 原始样式
 * @returns {object} 归一化后的样式
 */
function normalizeStyle(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const d = DEFAULT_STYLE
  const lineMode = src.lineMode === 'single' || src.lineMode === 'double' ? src.lineMode : d.lineMode
  const fontFamily = Object.prototype.hasOwnProperty.call(FONT_FAMILIES, src.fontFamily)
    ? src.fontFamily
    : d.fontFamily
  const color = (v, fallback) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback)
  return {
    lineMode,
    fontFamily,
    fontSize: Math.round(clampNumber(src.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, d.fontSize)),
    gradientFrom: color(src.gradientFrom, d.gradientFrom),
    gradientTo: color(src.gradientTo, d.gradientTo),
    bgOpacity: Math.round(clampNumber(src.bgOpacity, BG_OPACITY_MIN, BG_OPACITY_MAX, d.bgOpacity) * 100) / 100,
  }
}

/**
 * 读取本地样式(localStorage 不可用/数据损坏 → 默认值)
 * @returns {object} 归一化后的样式
 */
function loadStyle() {
  try {
    const raw = localStorage.getItem(STYLE_KEY)
    if (!raw) return { ...DEFAULT_STYLE }
    return normalizeStyle(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_STYLE }
  }
}

/**
 * 写入本地样式(失败不抛,本次会话内仍生效)
 * @param {object} s 待写入样式
 * @returns {void}
 */
function persistStyle(s) {
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(normalizeStyle(s)))
  } catch {
    // 忽略写入失败(隐私模式/配额)
  }
}

/** 当前样式(响应式) */
const style = ref(loadStyle())
/** 当前句文本 */
const lineText = ref('')
/** 下一句文本 */
const nextText = ref('')
/** 当前句渲染 key(变化即重建节点 → 触发渐入动画) */
const currKey = ref(0)
/** 下一句渲染 key */
const nextKey = ref(0)
/** 播放状态(playing/paused,来自 tick payload) */
const playStatus = ref('')
/** 当前章下标(来自 tick payload,用于位置提示) */
const chapterIdx = ref(-1)
/** 当前段序号(句) */
const segIdx = ref(-1)
/** 当前句内的播放进度(0~1,来自 tick payload) */
const segRatio = ref(0)
/** 鼠标是否悬停在窗口上 */
const hovered = ref(false)
/** 样式面板是否展开 */
const panelOpen = ref(false)
/** 锁定成功后的短时角标提示 */
const lockBadge = ref(false)

/** 性能缓存:上一次收到的文本,用于避免高频 tick 触发 DOM 更新 */
let lastLine = ''
let lastNext = ''
/** 上一次请求过的窗口高度(避免重复 resize) */
let lastRequestedHeight = 0
/** 锁定角标定时器 */
let lockTimer = null

/** 是否有正在播放的歌词 */
const hasLine = computed(() => lineText.value.length > 0)

/**
 * 当前句「已播放」的字符数。
 *
 * TTS 引擎只给整段音频,没有词级时间戳;这里用句内进度比例
 * (segOffsetRatio)线性映射到字符数,做出**逐字推进**的高亮效果。
 * @returns {number}
 */
const playedCount = computed(() => {
  const total = Array.from(lineText.value).length
  if (total === 0) return 0
  const ratio = Math.min(1, Math.max(0, Number(segRatio.value) || 0))
  return Math.round(total * ratio)
})

/** 已播放部分(高亮) */
const playedText = computed(() => Array.from(lineText.value).slice(0, playedCount.value).join(''))

/** 未播放部分(暗色) */
const upcomingText = computed(() => Array.from(lineText.value).slice(playedCount.value).join(''))

/** 位置提示(第几章) */
const positionLabel = computed(() => {
  if (chapterIdx.value < 0) return ''
  return T.chapterAt ? T.chapterAt.replace('{n}', String(chapterIdx.value + 1)) : `第 ${chapterIdx.value + 1} 章`
})
/** 是否单行模式 */
const isSingle = computed(() => style.value.lineMode === 'single')
/** 状态标记(播放中 ▶ / 暂停 ⏸,对应 DESIGN §4 的当前句前缀) */
const statusMark = computed(() => {
  if (playStatus.value === 'playing') return '▶'
  if (playStatus.value === 'paused') return '⏸'
  return ''
})
/** 背景条样式( rgba(0,0,0,opacity) ) */
const cardStyle = computed(() => ({
  background: `rgba(0, 0, 0, ${style.value.bgOpacity})`,
  fontFamily: FONT_FAMILIES[style.value.fontFamily] || FONT_FAMILIES.system,
}))
/** 当前句样式(渐变 + 字号) */
const currStyle = computed(() => ({
  fontSize: `${style.value.fontSize}px`,
  backgroundImage: `linear-gradient(90deg, ${style.value.gradientFrom}, ${style.value.gradientTo})`,
}))

/**
 * 调用主进程 IPC(窗口未注入 window.cs 时静默跳过)
 * @param {string} channel 通道名
 * @param {unknown} [payload] 参数
 * @returns {Promise<unknown>}
 */
async function invoke(channel, payload) {
  const cs = typeof window !== 'undefined' ? window.cs : null
  if (!cs || typeof cs.invoke !== 'function') return null
  try {
    return await cs.invoke(channel, payload)
  } catch (err) {
    console.error(`[lyrics] invoke ${channel} 失败:`, err)
    return null
  }
}

/**
 * 请求窗口高度(窗口高度恒等于行模式高度:单行 52 / 双行 96)
 * @param {boolean} [force] 高度未变时是否仍然下发(行模式切换时用)
 * @returns {void}
 */
function requestHeight(force = false) {
  const height = isSingle.value ? HEIGHT_SINGLE : HEIGHT_DOUBLE
  if (!force && height === lastRequestedHeight) return
  lastRequestedHeight = height
  void invoke('lyric:resize', { height })
}

/**
 * 应用样式变更:更新渲染 + 持久化 + 必要时调整窗口高度
 * @param {object} patch 待合并的样式片段
 * @returns {void}
 */
function applyStyle(patch) {
  const next = normalizeStyle({ ...style.value, ...patch })
  const modeChanged = next.lineMode !== style.value.lineMode
  style.value = next
  persistStyle(next)
  if (modeChanged) requestHeight(true)
}

/**
 * 处理 tick 推送:仅在文本真正变化时更新 DOM(高频 tick 去抖)
 * @param {unknown} data tick 载荷
 * @returns {void}
 */
function handleTick(data) {
  const d = data && typeof data === 'object' ? data : {}
  const line = typeof d.lineText === 'string' ? d.lineText : ''
  const next = typeof d.nextText === 'string' ? d.nextText : ''
  if (typeof d.status === 'string' && d.status) playStatus.value = d.status
  const lineChanged = line !== lastLine
  const nextChanged = next !== lastNext
  // 位置与句内进度:即使文本没变也要更新(逐字高亮靠它推进)
  if (Number.isFinite(Number(d.chapterIdx))) chapterIdx.value = Number(d.chapterIdx)
  if (Number.isFinite(Number(d.segIdx))) segIdx.value = Number(d.segIdx)
  if (Number.isFinite(Number(d.segOffsetRatio))) segRatio.value = Number(d.segOffsetRatio)
  if (!lineChanged && !nextChanged) return
  lastLine = line
  lastNext = next
  if (lineChanged) {
    lineText.value = line
    currKey.value += 1
    // 注意:不要在这里把 segRatio 清零 —— 本次 tick 携带的 ratio 描述的正是**这句**
    // 的进度,清零会让逐字高亮永远停在开头(实测 playedLen 恒为 0)。
    // 只有本次载荷没带 ratio 时才归零。
    if (!Number.isFinite(Number(d.segOffsetRatio))) segRatio.value = 0
  }
  if (nextChanged) {
    nextText.value = next
    nextKey.value += 1
  }
}

/**
 * 处理播放状态推送(主进程 player:state-push)
 * @param {unknown} data 状态载荷
 * @returns {void}
 */
function handlePlayerState(data) {
  const d = data && typeof data === 'object' ? data : {}
  if (typeof d.status === 'string') playStatus.value = d.status
}

/** 展开样式面板(不改变窗口高度,高度只随行模式变化) */
function openPanel() {
  panelOpen.value = true
}

/** 收起样式面板 */
function closePanel() {
  panelOpen.value = false
}

/**
 * 锁定歌词(鼠标穿透;解锁走托盘面板/阅读器)
 * @returns {void}
 */
async function toggleLock() {
  const res = await invoke('lyric:set-locked', { locked: true })
  if (res === null) return
  hovered.value = false
  lockBadge.value = true
  if (lockTimer) clearTimeout(lockTimer)
  lockTimer = setTimeout(() => {
    lockBadge.value = false
  }, LOCK_BADGE_MS)
}

/**
 * 关闭桌面歌词窗
 * @returns {void}
 */
async function closeLyrics() {
  await invoke('lyric:toggle-desktop', { on: false })
}

/** tick 取消订阅句柄 */
let unlistenTick = null
/** 播放状态取消订阅句柄 */
let unlistenState = null

onMounted(() => {
  const cs = typeof window !== 'undefined' ? window.cs : null
  if (cs && typeof cs.on === 'function') {
    unlistenTick = cs.on('lyric:tick-push', handleTick)
    unlistenState = cs.on('player:state-push', handlePlayerState)
  }
  requestHeight()
})

onBeforeUnmount(() => {
  if (typeof unlistenTick === 'function') unlistenTick()
  if (typeof unlistenState === 'function') unlistenState()
  if (lockTimer) clearTimeout(lockTimer)
})
</script>

<template>
  <div
    class="lyrics-root"
    :class="{ 'is-single': isSingle, 'has-panel': panelOpen }"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <div class="lyrics-card" :style="cardStyle">
      <!-- 歌词正文(常驻 DOM:样式面板为叠加层,不卸载歌词) -->
      <div class="lyrics-texts" :class="{ 'is-hidden': panelOpen }">
        <div v-if="hasLine" class="lyrics-curr-row">
          <span v-if="statusMark" class="lyrics-mark">{{ statusMark }}</span>
          <p class="lyrics-curr" :key="currKey" :style="currStyle">
            <span class="lyrics-played">{{ playedText }}</span
            ><span class="lyrics-upcoming">{{ upcomingText }}</span>
          </p>
        </div>
        <p v-if="hasLine && positionLabel" class="lyrics-position">{{ positionLabel }}</p>
        <p v-else class="lyrics-curr lyrics-brand" :key="'brand'">{{ BRAND }}</p>
        <p v-if="!hasLine" class="lyrics-hint">{{ T.noPlayback }}</p>
        <p v-else-if="!isSingle && nextText" class="lyrics-next" :key="nextKey">{{ nextText }}</p>
      </div>

      <!-- 样式面板(叠加在歌词下方,不卸载歌词) -->
      <StylePanel
        v-if="panelOpen"
        :style="style"
        :font-options="FONT_OPTIONS"
        :font-size-min="FONT_SIZE_MIN"
        :font-size-max="FONT_SIZE_MAX"
        :bg-opacity-min="BG_OPACITY_MIN"
        :bg-opacity-max="BG_OPACITY_MAX"
        @update="applyStyle"
        @close="closePanel"
      />

      <!-- 右侧竖排微型工具条(hover 显示) -->
      <div class="lyrics-toolbar" :class="{ 'is-visible': hovered }">
        <button class="tb-btn" type="button" :title="T.lock" @click="toggleLock">锁定</button>
        <button class="tb-btn" type="button" :title="T.styleTitle" @click="openPanel">样式</button>
        <button class="tb-btn" type="button" :title="T.closeLyrics" @click="closeLyrics">关闭</button>
      </div>

      <!-- 锁定成功角标(短时提示;锁定后鼠标穿透,不影响操作) -->
      <span v-if="lockBadge" class="lyrics-lock-badge">🔒</span>
    </div>
  </div>
</template>

<style>
html,
body,
#app {
  background: transparent;
  margin: 0;
  height: 100%;
  overflow: hidden;
}

/* 根容器:整窗可拖(DESIGN §4) */
.lyrics-root {
  width: 100%;
  height: 100%;
  -webkit-app-region: drag;
  user-select: none;
  -webkit-user-select: none;
  cursor: move;
}

/* 背景条 */
.lyrics-card {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 6px 20px;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  overflow: hidden;
}

/* 正文区(为右侧工具条预留位置) */
.lyrics-texts {
  width: 100%;
  max-width: 100%;
  padding-right: 46px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  overflow: hidden;
  transition: opacity 160ms ease;
}

/* 样式面板展开时正文淡出(保持挂载,避免 DOM 抖动) */
.lyrics-texts.is-hidden {
  opacity: 0;
}

/* 当前句行(状态标记 + 渐变大字) */
.lyrics-curr-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  justify-content: center;
  overflow: hidden;
}

/* 播放状态标记 */
.lyrics-mark {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.75);
  flex: none;
}

/* 当前句:渐变大字 + 描边
   注意:描边不能用 text-shadow —— text-shadow 会画在 background-clip:text 的
   渐变文字「之上」,把渐变整个盖住(实测 Chromium 下只剩纯白字)。
   改用 filter: drop-shadow() 描边,drop-shadow 作用在已渲染的渐变字形上,
   既保留渐变又能得到描边/投影效果。 */
.lyrics-curr {
  margin: 0;
  max-width: 100%;
  font-weight: 700;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  filter: drop-shadow(1px 0 0 rgba(0, 0, 0, 0.75)) drop-shadow(-1px 0 0 rgba(0, 0, 0, 0.75))
    drop-shadow(0 1px 0 rgba(0, 0, 0, 0.75)) drop-shadow(0 -1px 0 rgba(0, 0, 0, 0.75))
    drop-shadow(0 2px 4px rgba(0, 0, 0, 0.7));
  transition: opacity 200ms ease, transform 200ms ease;
  animation: lyrics-fade-in 200ms ease;
}

/* 无播放时显示品牌名 */
.lyrics-brand {
  font-size: 22px;
  background-image: linear-gradient(90deg, #ffb347, #ff5e62);
}

/* 逐字高亮:已播放部分保持渐变,未播放部分降低不透明度 */
.lyrics-played {
  background: inherit;
  -webkit-background-clip: text;
  background-clip: text;
}

.lyrics-upcoming {
  opacity: 0.42;
}

/* 位置提示(第几章) */
.lyrics-position {
  margin: 1px 0 0;
  font-size: 11px;
  line-height: 1.3;
  color: rgba(255, 255, 255, 0.5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 下一句:淡色小字 */
.lyrics-next {
  margin: 0;
  max-width: 100%;
  font-size: 13px;
  line-height: 1.4;
  color: rgba(255, 255, 255, 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: opacity 200ms ease, transform 200ms ease;
  animation: lyrics-fade-in 200ms ease;
}

/* 无播放提示文案 */
.lyrics-hint {
  margin: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 工具条:右侧竖排(hover 显示) */
.lyrics-toolbar {
  position: absolute;
  top: 50%;
  right: 5px;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 3px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.55);
  -webkit-app-region: no-drag;
  opacity: 0;
  pointer-events: none;
  transition: opacity 160ms ease;
}

.lyrics-toolbar.is-visible {
  opacity: 1;
  pointer-events: auto;
}

.tb-btn {
  border: none;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-size: 11px;
  line-height: 1.6;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.tb-btn:hover {
  background: rgba(255, 255, 255, 0.3);
}

/* 锁定角标 */
.lyrics-lock-badge {
  position: absolute;
  left: 8px;
  top: 4px;
  font-size: 11px;
  opacity: 0.75;
  -webkit-app-region: no-drag;
}

@keyframes lyrics-fade-in {
  from {
    opacity: 0;
    transform: translateY(5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
