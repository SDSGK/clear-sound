<script setup>
/**
 * VirtualBook.vue —— 跨章虚拟滚动正文(阅读器核心)
 *
 * 设计要点(docs/PLAN.md §4.2 / docs/DESIGN.md §3):
 *
 * 1) 扁平化数据模型
 *    把「章节标题 + 段落」打平成一条 items 列表:
 *      { kind:'head', chIdx, pIdx:-1, title, loc }
 *      { kind:'para', chIdx, pIdx,    text,  loc }
 *    loc = `${chIdx}:${pIdx}`(段落)或 `${chIdx}:-1`(标题),既是 v-for 的 key,
 *    也是 DOM 上 data-loc 的值,便于 ResizeObserver 回调反查所属条目。
 *
 * 2) 高度估算 + 实测校正
 *    - 估算:章节标题 ≈ 2 行字高;段落 ≈ ceil(字符数 / 每行字数) × 行高 + 段间距。
 *      每行字数 ≈ 容器宽 / (字号 + 字距),容器宽随 ResizeObserver 变化重算。
 *    - 实测:ResizeObserver 观察已渲染条目的真实高度,与估算不符时用实测值覆盖,
 *      并重算前缀和(节流到一帧一次)。
 *
 * 3) 前缀和(prefix sum)与二分定位
 *    heights[i] = 第 i 项高度;prefix[i] = heights[0..i-1] 之和,prefix[0] = 0。
 *    已知 scrollTop 即可二分出「视口顶部落在第几项」,O(log n),十万级条目也不卡。
 *    总高度 = prefix[items.length],上下 spacer 直接用 prefix 值占位。
 *
 * 4) 跨章加载
 *    - 向下:距已加载尾部 < 1.2 视口高 → append 下一章(loadingChapters 防重复)。
 *    - 向上:距已加载头部 < 1.2 视口高 → prepend 上一章。
 *    - 锚点补偿(prepend 会把内容整体下移):prepend 前记录「视口顶部条目的 loc +
 *      它相对容器原点的像素偏移」,DOM 更新后把 scrollTop 重设回该锚点,
 *      视口内容保持不动(用户视角不跳动)。实测校正同样走这套锚点机制。
 *
 * 5) 进度记忆
 *    滚动节流 500ms → 视口顶部的第一个「段落」条目 (chIdx, pIdx) → store.savePosition。
 *    节流窗口内的多次滚动只保留最新位置(pendingPosition),不会丢更新。
 *
 * 6) 自动翻页
 *    rAF 循环按 autoScrollSpeed px/s 递增 scrollTop;到底且允许自动下一章时跳到
 *    下一章标题;用户滚轮/触摸时暂停 3 秒。
 *
 * 7) 听书集成(M2)
 *    - player.onTick({chapterIdx, paraIdx}) → 高亮当前朗读段(para-playing 类:
 *      左侧 3px 主题色呼吸点 + 背景微高亮),旧高亮自动清除。
 *    - followScroll 开启且目标段不在视口内 → 平滑滚动居中。
 *    - 朗读跨章(章不在已加载范围)→ 复用 appendChapter/prependChapter 加载该章。
 *    - 双击段落 → 从该段开始朗读(跳播语义,player.playFrom 天然支持)。
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { useBooksStore } from '@/stores/books'
import { usePlayerStore } from '@/stores/player'
import { loadSettings } from '@/utils/reader-settings'

const props = defineProps({
  /** 当前书籍 id */
  bookId: { type: String, default: '' },
  /** 阅读设置(由 ReaderView 持有,变化时重算高度估算) */
  settings: { type: Object, default: () => ({}) },
  /**
   * 初始定位章节(章节管理页点某章进来时传入;-1 = 不指定,用上次进度)。
   *
   * 必须在 init() 里就作为起始章,而不是载入后再 scrollToParagraph:
   * init 会 rebuildRange(上次进度章),事后定位与它并发,后完成者覆盖
   * items → 点第 3 章却停在第 1 章(正文看起来"没内容")。
   */
  initialChapter: { type: Number, default: -1 },
})

const emit = defineEmits(['chapter-change', 'paragraph-context', 'manifest', 'positioned'])

const { t } = useI18n()
const store = useBooksStore()
const player = usePlayerStore()

// ===== 常量 =====

/** 可视区上下各缓冲的屏数(PLAN §4.2:可视区 ±10 屏缓冲) */
const BUFFER_SCREENS = 10
/** 距已加载尾部/头部小于该视口高倍数时触发加载 */
const EDGE_RATIO = 1.2
/** 进度记忆节流(ms) */
const POSITION_SAVE_MS = 500
/** 章节标题估算行数 */
const HEAD_LINES = 2
/** 段落上下内边距合计(与 CSS .vb-para padding-block 对应) */
const PARA_GAP = 12
/** 标题上下内边距合计(与 CSS .vb-head padding-block 对应) */
const HEAD_GAP = 16
/** 标题字号相对正文的倍数 */
const HEAD_SCALE = 1.4
/** 用户滚动后暂停自动翻页的时长(ms) */
const AUTOSCROLL_PAUSE_MS = 3000

// ===== 响应式状态 =====

/** 章节清单(manifest.chapters) */
const manifestChapters = shallowRef([])
/** 扁平条目列表(浅响应:整表替换触发重渲染,避免逐项深度代理) */
const items = shallowRef([])
/** 与 items 等长的高度数组(估算值或实测值) */
const heights = shallowRef([])
/** 前缀和:prefix[i] = heights[0..i-1] 之和 */
const prefix = shallowRef([0])
/** loc → items 下标,测量/锚点反查用 */
const indexByLoc = new Map()
/**
 * 已实测的真实高度:loc → 高度(px)。
 *
 * 高度数组 = 实测值优先,缺失时才用估算值。
 * 若每次尺寸变化都整体重算估算,实测值会被丢弃,而估算天然偏高
 * (如标题至少按 2 行算,实测常为 1 行),前缀和随之偏大,
 * 边界处的「视口顶部属于哪一章」会判到上一章 → 顶栏章名不更新。
 */
const measuredHeights = new Map()
/** 章节缓存:chIdx → 该章的条目数组(来回跳转时免去重复读盘) */
const chapterCache = new Map()
/** 正在加载的章节(防重复请求) */
const loadingChapters = new Set()
/** 已加载区间 */
const firstLoadedCh = ref(0)
const lastLoadedCh = ref(-1)
/** 渲染窗口(绝对下标,闭区间) */
const windowStart = ref(0)
const windowEnd = ref(-1)
/** 视口顶部条目下标(用于当前章节判定与进度记忆) */
const viewportTopIndex = ref(0)
/** 当前章节下标(-1 表示尚未确定) */
const currentChapterIdx = ref(-1)
/** 加载中(首屏) */
const loading = ref(true)
/** 加载失败(manifest 缺失) */
const loadError = ref(false)
/** 正在朗读的段落标识(loc = `${chIdx}:${pIdx}`);空串表示无高亮 */
const playingLoc = ref('')

/** 滚动容器 */
const scrollEl = ref(null)
/** 容器内容宽度(用于每行字数估算) */
const viewportWidth = ref(600)
/** 容器上内边距(内容坐标原点相对滚动原点的偏移) */
const padTop = ref(0)
/** 容器左右内边距合计(内容宽度 = clientWidth - padInline) */
const padInline = ref(0)
/** ResizeObserver 观察到的元素:loc → element */
const observedEls = new Map()
/** ResizeObserver 实例 */
let resizeObserver = null

// ===== 派生设置(用于高度估算) =====

const fontSize = computed(() => {
  const n = Number(props.settings && props.settings.fontSize)
  return Number.isFinite(n) && n > 0 ? n : 18
})
const lineHeight = computed(() => {
  const n = Number(props.settings && props.settings.lineHeight)
  return Number.isFinite(n) && n > 0 ? n : 1.8
})
const letterSpacing = computed(() => {
  const n = Number(props.settings && props.settings.letterSpacing)
  return Number.isFinite(n) ? n : 0
})

// ===== 派生视图数据 =====

/** 渲染窗口内的条目(带绝对下标) */
const visibleItems = computed(() => {
  const arr = items.value
  const s = Math.max(0, windowStart.value)
  const e = Math.min(windowEnd.value, arr.length - 1)
  const out = []
  for (let i = s; i <= e; i += 1) {
    out.push({ item: arr[i], index: i })
  }
  return out
})

/** 上方占位高度 */
const topSpacer = computed(() => {
  const p = prefix.value
  if (p.length < 2) return 0
  const s = Math.max(0, Math.min(windowStart.value, p.length - 2))
  return p[s] || 0
})

/** 下方占位高度 */
const bottomSpacer = computed(() => {
  const p = prefix.value
  if (p.length < 2) return 0
  const e = Math.min(windowEnd.value, p.length - 2)
  const end = p[p.length - 1]
  return Math.max(0, end - (p[e + 1] || 0))
})

/** 章节总数 */
const chapterTotal = computed(() => manifestChapters.value.length)

// ===== 高度估算 =====

/**
 * 每行可容纳的字符数:(容器内容宽) / (字号 + 字距)
 *
 * 注意:el.clientWidth 含左右内边距,正文实际排版宽度要减去 2×padding,
 * 否则每行字数被高估 → 段落行数被低估 → 跨章累积误差可达数千像素
 * (目录跳转会落到目标章之前)。
 *
 * @returns {number}
 */
function charsPerLine() {
  const contentWidth = Math.max(1, viewportWidth.value - padInline.value)
  const perChar = fontSize.value + letterSpacing.value
  return Math.max(1, Math.floor(contentWidth / perChar))
}

/**
 * 估算某个条目的高度
 * @param {{kind: string, title?: string, text?: string}} item 条目
 * @returns {number} 像素高度
 */
function estimateHeight(item) {
  const lh = lineHeight.value
  const contentWidth = Math.max(1, viewportWidth.value - padInline.value)
  if (item.kind === 'head') {
    const headFs = fontSize.value * HEAD_SCALE
    const perLine = Math.max(1, Math.floor(contentWidth / (headFs + letterSpacing.value)))
    const lines = Math.max(1, Math.ceil((item.title || '').length / perLine))
    return Math.max(HEAD_LINES, lines) * headFs * lh + HEAD_GAP
  }
  const len = (item.text || '').length
  const lines = Math.max(1, Math.ceil(len / charsPerLine()))
  return lines * fontSize.value * lh + PARA_GAP
}

/**
 * 计算某个条目的高度(实测优先,否则估算)
 * @param {object} item 条目
 * @returns {number} 像素高度
 */
function heightOf(item) {
  const m = measuredHeights.get(item.loc)
  return m != null ? m : estimateHeight(item)
}

/**
 * 重算前缀和与 loc→下标索引
 * @returns {void}
 */
function rebuildPrefix() {
  const h = heights.value
  const p = new Array(h.length + 1)
  p[0] = 0
  for (let i = 0; i < h.length; i += 1) p[i + 1] = p[i] + h[i]
  prefix.value = p
  indexByLoc.clear()
  const arr = items.value
  for (let i = 0; i < arr.length; i += 1) indexByLoc.set(arr[i].loc, i)
}

/**
 * 二分定位:找出内容坐标 top 落在哪个条目上
 * @param {number} top 内容坐标(已扣除上内边距)
 * @returns {number} 条目下标(空列表返回 -1)
 */
function findIndexAt(top) {
  const p = prefix.value
  const n = items.value.length
  if (n === 0) return -1
  const target = Math.max(0, top)
  let lo = 0
  let hi = n - 1
  // 不变式:答案落在 [lo, hi],且 p[lo] <= target
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (p[mid] <= target) lo = mid
    else hi = mid - 1
  }
  return lo
}

// ===== 锚点(视口稳定) =====

/**
 * 记录当前视口顶部锚点:条目 loc + 该条目相对「内容坐标原点」的像素偏移。
 *
 * 内容坐标 = scrollTop - padTop(容器上内边距);前缀和 prefix[] 也是内容坐标。
 * prepend / 实测校正会改变上方内容高度,靠锚点把视口「钉」回原处。
 * 捕获与恢复必须用同一套坐标,否则会偏移 2×padTop。
 *
 * @returns {{key: string, offset: number} | null}
 */
function captureAnchor() {
  const el = scrollEl.value
  if (!el || items.value.length === 0) return null
  const contentTop = el.scrollTop - padTop.value
  const idx = findIndexAt(contentTop)
  if (idx < 0) return null
  const it = items.value[idx]
  if (!it) return null
  return { key: it.loc, offset: contentTop - prefix.value[idx] }
}

/**
 * 恢复锚点:把 scrollTop 重设到锚点条目原来的位置
 * @param {{key: string, offset: number} | null} anchor 锚点
 * @returns {void}
 */
function restoreAnchor(anchor) {
  const el = scrollEl.value
  if (!el || !anchor) return
  const idx = indexByLoc.get(anchor.key)
  if (idx == null) return
  // 内容坐标 → 滚动坐标:加回容器上内边距
  const target = prefix.value[idx] + anchor.offset + padTop.value
  if (Math.abs(el.scrollTop - target) > 0.5) el.scrollTop = Math.max(0, target)
}

// ===== 章节加载 =====

/**
 * 加载并缓存某章的条目(已缓存则直接返回)
 * @param {number} chIdx 章节下标
 * @returns {Promise<object[] | null>} 该章条目数组
 */
async function ensureChapter(chIdx) {
  if (chapterCache.has(chIdx)) return chapterCache.get(chIdx)
  if (loadingChapters.has(chIdx)) return null
  loadingChapters.add(chIdx)
  try {
    const data = await store.readChapter(props.bookId, chIdx)
    const meta = manifestChapters.value.find((c) => c && c.idx === chIdx)
    const title = (data && data.title) || (meta && meta.title) || ''
    const paragraphs = data && Array.isArray(data.paragraphs) ? data.paragraphs : []
    const arr = [{ kind: 'head', chIdx, pIdx: -1, title, paraCount: paragraphs.length, loc: `${chIdx}:-1` }]
    for (let i = 0; i < paragraphs.length; i += 1) {
      arr.push({ kind: 'para', chIdx, pIdx: i, text: String(paragraphs[i]), loc: `${chIdx}:${i}` })
    }
    chapterCache.set(chIdx, arr)
    return arr
  } catch {
    ElMessage.error(t('reader.loadFailed'))
    return null
  } finally {
    loadingChapters.delete(chIdx)
  }
}

/**
 * 以某个章节为起点重建渲染区间(用于目录跳转)
 * @param {number} startCh 起始章
 * @param {number} endCh 结束章
 * @returns {Promise<void>}
 */
async function rebuildRange(startCh, endCh) {
  for (let c = startCh; c <= endCh; c += 1) {
    await ensureChapter(c)
  }
  const list = []
  for (let c = startCh; c <= endCh; c += 1) {
    const arr = chapterCache.get(c)
    if (arr) list.push(...arr)
  }
  items.value = list
  heights.value = list.map((it) => heightOf(it))
  firstLoadedCh.value = startCh
  lastLoadedCh.value = endCh
  rebuildPrefix()
  pruneObserved()
  updateWindow()
}

/**
 * 向下追加一章
 * @param {number} chIdx 章节下标
 * @returns {Promise<void>}
 */
async function appendChapter(chIdx) {
  const arr = await ensureChapter(chIdx)
  if (!arr) return
  items.value = [...items.value, ...arr]
  heights.value = [...heights.value, ...arr.map((it) => heightOf(it))]
  lastLoadedCh.value = chIdx
  rebuildPrefix()
  // 追加后内容变高,必须同步刷新渲染窗口,否则底部会留白
  updateWindow()
  // 顶栏章节名要跟着更新(否则追加后仍显示旧章)
  updateCurrentChapter()
}

/**
 * 向上插入一章,并用锚点补偿 scrollTop,保证视口内容不跳动
 * @param {number} chIdx 章节下标
 * @returns {Promise<void>}
 */
async function prependChapter(chIdx) {
  const arr = await ensureChapter(chIdx)
  if (!arr) return
  const anchor = captureAnchor()
  items.value = [...arr, ...items.value]
  heights.value = [...arr.map((it) => heightOf(it)), ...heights.value]
  firstLoadedCh.value = chIdx
  rebuildPrefix()
  // DOM 需先按新总高度渲染,scrollTop 才有空间可设
  await nextTick()
  restoreAnchor(anchor)
  pruneObserved()
  updateWindow()
  // prepend 后视口所在章可能变了,顶栏章节名要同步
  updateCurrentChapter()
}

// ===== 渲染窗口 =====

/**
 * 依据当前 scrollTop 重算渲染窗口(可视区 ± BUFFER_SCREENS 屏)
 * @returns {void}
 */
function updateWindow() {
  const el = scrollEl.value
  if (!el || items.value.length === 0) return
  const padBottom = getPadBottom()
  const vh = Math.max(1, (el.clientHeight || 400) - padTop.value - padBottom)
  const top = el.scrollTop - padTop.value
  const buf = vh * BUFFER_SCREENS
  const s = findIndexAt(top - buf)
  const e = findIndexAt(top + vh + buf)
  windowStart.value = Math.max(0, s)
  windowEnd.value = Math.max(windowStart.value, e)
  viewportTopIndex.value = findIndexAt(top)
}

// ===== 实测高度校正 =====

/** 测量结果是否需要在下一帧统一处理 */
let measureDirty = false
/** 测量帧句柄 */
let measureFrame = 0
/**
 * 待定跳转目标(chIdx/pIdx/mode/expectedTop)。
 *
 * 跳转位置是用「估算高度」算出来的,而 ResizeObserver 的实测校正会逐步
 * 改写前缀和,导致真正该在的段落发生偏移。这里记住跳转目标,
 * 每次高度校正后按新的几何重新定位。
 *
 * expectedTop 记录程序化滚动后的位置:用来区分「我们自己的滚动」
 * 与「用户滚动」。用户滚动后必须放弃该目标,否则下一次高度校正
 * 会把用户拽回跳转目标(实测:目录跳转后再滚动,视口被拉回原处)。
 */
let pendingTarget = null

/**
 * 判断当前滚动是否为用户操作(是则放弃待定跳转目标)。
 *
 * 判据不是「与上次程序化滚动位置的偏差」,而是「与目标条目当前应处位置的偏差」:
 * 目标位置随实测校正不断变化,用固定基准比较会误判(把用户拽回目标)。
 * 现在用「目标在内容坐标中的当前位置」直接比,自校正、稳定。
 *
 * @param {HTMLElement} el 滚动容器
 * @returns {void}
 */
function detectUserScroll(el) {
  if (!pendingTarget || !el) return
  const loc = pendingTarget.pIdx >= 0 ? `${pendingTarget.chIdx}:${pendingTarget.pIdx}` : `${pendingTarget.chIdx}:-1`
  const idx = indexByLoc.get(loc)
  if (idx == null) return
  const want = prefix.value[idx] + padTop.value
  const threshold = Math.max(120, (el.clientHeight || 400) * 0.5)
  if (Math.abs(el.scrollTop - want) > threshold) {
    pendingTarget = null
  }
}

/**
 * 记录一次实测高度(与估算差异超过 0.5px 才算有效)
 * @param {string} loc 条目标识
 * @param {number} h 实测高度
 * @returns {boolean} 是否发生变化
 */
function recordMeasured(loc, h) {
  const idx = indexByLoc.get(loc)
  if (idx == null) return false
  const cur = heights.value[idx]
  if (!Number.isFinite(cur) || Math.abs(cur - h) < 0.5) return false
  const next = heights.value.slice()
  next[idx] = h
  heights.value = next
  measuredHeights.set(loc, h)
  return true
}

/**
 * 把累积的测量结果合并处理(节流到一帧):重算前缀和并用锚点保持视口稳定
 * @returns {void}
 */
function flushMeasure() {
  measureFrame = 0
  if (!measureDirty) return
  measureDirty = false
  // 先判是否用户已滚走:若用户主动滚动过,不能再把他拽回跳转目标
  const elNow = scrollEl.value
  if (elNow) detectUserScroll(elNow)
  const anchor = pendingTarget ? null : captureAnchor()
  rebuildPrefix()
  if (pendingTarget) {
    // 有待定跳转目标 → 按新前缀和重新定位到目标(比锚点更符合用户意图)
    applyPendingTarget()
  } else {
    restoreAnchor(anchor)
  }
  updateWindow()
  updateCurrentChapter()
}

/**
 * 请求一帧内处理测量结果(节流)
 * @returns {void}
 */
function scheduleMeasure() {
  if (measureFrame) return
  measureFrame = requestAnimationFrame(flushMeasure)
}

// ===== 进度记忆 =====

/** 进度保存节流计时器 */
let positionTimer = 0
/** 节流窗口内待保存的最新位置 */
let pendingPosition = null

/**
 * 找到视口顶部的第一个「段落」条目(跳过章节标题)
 * @param {number} fromIdx 起始下标
 * @returns {object | null}
 */
function firstParaAtOrAfter(fromIdx) {
  const arr = items.value
  for (let i = Math.max(0, fromIdx); i < arr.length; i += 1) {
    const it = arr[i]
    if (it && it.kind === 'para') return it
  }
  return null
}

/**
 * 当前视口顶部段落位置(听书按钮从这里开始播放)
 * @returns {{chIdx: number, pIdx: number} | null}
 */
function viewportPosition() {
  const para = firstParaAtOrAfter(viewportTopIndex.value)
  if (!para) return null
  return { chIdx: para.chIdx, pIdx: para.pIdx }
}

/**
 * 立即把待保存位置写进 store
 * @returns {void}
 */
function flushPosition() {
  positionTimer = 0
  if (!pendingPosition) return
  const pos = pendingPosition
  pendingPosition = null
  store.savePosition(props.bookId, pos.chIdx, pos.pIdx)
}

/**
 * 保存当前阅读位置(节流 500ms,窗口内只保留最新位置)
 * @param {boolean} [immediate] 是否立即保存(忽略节流)
 * @returns {void}
 */
function scheduleSavePosition(immediate = false) {
  const para = firstParaAtOrAfter(viewportTopIndex.value)
  if (!para) return
  pendingPosition = { chIdx: para.chIdx, pIdx: para.pIdx }
  if (immediate) {
    if (positionTimer) clearTimeout(positionTimer)
    flushPosition()
    return
  }
  if (positionTimer) return
  positionTimer = setTimeout(flushPosition, POSITION_SAVE_MS)
}

// ===== 自动翻页 =====

/** rAF 句柄 */
let autoFrame = 0
/** 上一帧时间戳 */
let lastFrameTs = 0
/** 用户手动滚动后的暂停截止时间 */
let autoPauseUntil = 0

/**
 * 自动翻页主循环:按 autoScrollSpeed px/s 递增 scrollTop
 * @param {number} ts rAF 时间戳
 * @returns {void}
 */
function autoScrollTick(ts) {
  autoFrame = 0
  const el = scrollEl.value
  if (!el || !props.settings || !props.settings.autoScroll) return
  const dt = lastFrameTs ? Math.min(0.1, (ts - lastFrameTs) / 1000) : 0
  lastFrameTs = ts
  if (Date.now() < autoPauseUntil) {
    scheduleAutoScroll()
    return
  }
  const speed = Number(props.settings.autoScrollSpeed) || 80
  el.scrollTop += speed * dt
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
  if (atBottom) {
    if (props.settings.autoScrollNext && lastLoadedCh.value + 1 < chapterTotal.value) {
      gotoChapter(lastLoadedCh.value + 1, 'start')
      scheduleAutoScroll()
      return
    }
  }
  scheduleAutoScroll()
}

/**
 * 启动/续接自动翻页循环
 * @returns {void}
 */
function scheduleAutoScroll() {
  if (autoFrame) return
  autoFrame = requestAnimationFrame(autoScrollTick)
}

/**
 * 用户手动滚动 → 暂停自动翻页 3 秒,并放弃待定跳转目标
 * (用户一旦自己滚动,就不应该再被校正逻辑拽回跳转目标)
 * @returns {void}
 */
function pauseAutoScroll() {
  autoPauseUntil = Date.now() + AUTOSCROLL_PAUSE_MS
  // 用户主动交互 → 放弃待定跳转目标
  pendingTarget = null
}

// ===== 滚动事件 =====

/**
 * 容器滚动:更新渲染窗口、检查跨章边界、保存进度
 * @returns {void}
 */
function onScroll() {
  const el = scrollEl.value
  if (el) detectUserScroll(el)
  updateWindow()
  checkEdges()
  updateCurrentChapter()
  scheduleSavePosition()
}

/**
 * 检查是否需要跨章加载(距已加载区间的头/尾 < 1.2 视口高)
 * @returns {void}
 */
function checkEdges() {
  const el = scrollEl.value
  if (!el || !chapterTotal.value) return
  const vh = el.clientHeight || 400
  const threshold = vh * EDGE_RATIO
  // 接近尾部 → 追加下一章
  if (el.scrollHeight - (el.scrollTop + vh) < threshold) {
    const next = lastLoadedCh.value + 1
    if (next >= 0 && next < chapterTotal.value && !loadingChapters.has(next)) {
      appendChapter(next)
    }
  }
  // 接近头部 → 前插上一章
  if (el.scrollTop < threshold) {
    const prev = firstLoadedCh.value - 1
    if (prev >= 0 && !loadingChapters.has(prev)) {
      prependChapter(prev)
    }
  }
}

/**
 * 判定视口顶部所处的章节。
 *
 * 以「视口顶部之上(含贴顶)最近的章节标题」为准,并允许 1px 容差:
 * 章节标题的亚像素位置(如 prefix 差 0.36px)会让 findIndexAt 判到
 * 上一章的末段,导致顶栏章名在翻章瞬间不更新。
 *
 * @param {number} contentTop 内容坐标(已扣除容器上内边距)
 * @returns {number} 章节下标
 */
function chapterAtTop(contentTop) {
  const arr = items.value
  if (!arr.length) return currentChapterIdx.value
  let idx = findIndexAt(contentTop)
  if (idx < 0) idx = 0
  // 从视口顶部条目向后回溯到最近的章节标题
  let headIdx = idx
  while (headIdx > 0 && arr[headIdx].kind !== 'head') headIdx -= 1
  const head = arr[headIdx]
  if (!head) return arr[idx].chIdx
  // 若下一章标题已贴到视口顶部(亚像素误差) → 算作已进入下一章
  const nextHeadIdx = indexByLoc.get(`${head.chIdx + 1}:-1`)
  if (nextHeadIdx != null && prefix.value[nextHeadIdx] <= contentTop + 1) {
    return head.chIdx + 1
  }
  return head.chIdx
}

/**
 * 更新当前章节并通知父组件(顶栏显示「书名 · 章名 (进度)」)
 * @returns {void}
 */
function updateCurrentChapter() {
  const el = scrollEl.value
  if (!el || !items.value.length) return
  const chIdx = chapterAtTop(el.scrollTop - padTop.value)
  if (chIdx === currentChapterIdx.value) return
  currentChapterIdx.value = chIdx
  const meta = manifestChapters.value.find((c) => c && c.idx === chIdx)
  emit('chapter-change', {
    chIdx,
    title: (meta && meta.title) || '',
    index: chIdx + 1,
    total: chapterTotal.value,
  })
}

// ===== 段落交互 =====

/**
 * 双击段落:从该段开始朗读(跳播语义)
 *
 * 播放中再双击其它段 = 跳播到该段(player.playFrom 天然支持 seek 语义)。
 * @param {MouseEvent} event 鼠标事件
 * @param {object} item 段落条目
 * @returns {Promise<void>}
 */
async function onParaDblClick(event, item) {
  if (!item || item.kind !== 'para') return
  try {
    await player.initEngines()
    await player.playFrom(props.bookId, item.chIdx, item.pIdx)
    // store 的 playFrom 会把失败转成 status='error' 而不是 throw
    if (player.status === 'error') {
      ElMessage.error(t('reader.ttsFailed'))
    }
  } catch {
    ElMessage.error(t('reader.ttsFailed'))
  }
}

/**
 * 右键段落:打开上下文菜单
 * @param {MouseEvent} event 鼠标事件
 * @param {object} item 段落条目
 * @returns {void}
 */
function onParaContextMenu(event, item) {
  emit('paragraph-context', {
    x: event.clientX,
    y: event.clientY,
    text: item.text,
    chIdx: item.chIdx,
    pIdx: item.pIdx,
  })
}

// ===== 听书集成(M2) =====

/** tick 取消订阅函数(组件卸载时调用) */
let unsubscribeTick = null

/**
 * 是否跟随朗读滚动。
 *
 * 优先读父组件下发的阅读设置(settings 来自 reader-settings.loadSettings()),
 * 父组件尚未就绪时回落到本地读取的设置。
 * @returns {boolean}
 */
function followScrollEnabled() {
  const fromProps = props.settings && props.settings.followScroll
  if (typeof fromProps === 'boolean') return fromProps
  try {
    return !!loadSettings().followScroll
  } catch {
    return true
  }
}

/**
 * 判断某个条目是否在可视区内(不含缓冲屏)
 * @param {string} loc 条目标识
 * @returns {boolean}
 */
function isInViewport(loc) {
  const el = scrollEl.value
  const node = findItemNode(loc)
  if (!el || !node) return false
  const er = el.getBoundingClientRect()
  const nr = node.getBoundingClientRect()
  return nr.bottom > er.top && nr.top < er.bottom
}

/**
 * 把某个段落平滑滚动到视口中央(不在视口内时才动)
 *
 * 目标段落尚未渲染(在虚拟滚动窗口之外)时,先用精确几何定位把窗口移过去;
 * 已在窗口内但不在视口内时,走 scrollIntoView 平滑居中。
 * @param {string} loc 条目标识
 * @returns {void}
 */
function scrollParaIntoView(loc) {
  const el = scrollEl.value
  if (!el) return
  const node = findItemNode(loc)
  if (!node) {
    // 目标还在渲染窗口之外 → 先把窗口移到目标(精确几何定位,避免累计误差)
    const idx = indexByLoc.get(loc)
    if (idx == null) return
    scrollToItemIndex(idx, 'center')
    return
  }
  if (isInViewport(loc)) return
  try {
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
  } catch {
    node.scrollIntoView()
  }
}

/**
 * 确保某章已被加载(不在已加载范围时复用 append/prepend 逻辑)
 * @param {number} chIdx 章节下标
 * @returns {Promise<void>}
 */
async function ensureChapterLoaded(chIdx) {
  if (!Number.isFinite(chIdx) || chIdx < 0 || chIdx >= chapterTotal.value) return
  if (chIdx >= firstLoadedCh.value && chIdx <= lastLoadedCh.value) return
  if (chIdx > lastLoadedCh.value) {
    // 向下:逐章追加(与滚动到底的跨章加载同一套逻辑)
    for (let c = Math.max(0, lastLoadedCh.value + 1); c <= chIdx; c += 1) {
      await appendChapter(c)
    }
    return
  }
  // 向上:逐章前插(锚点补偿在 prependChapter 内部完成)
  for (let c = firstLoadedCh.value - 1; c >= chIdx; c -= 1) {
    await prependChapter(c)
  }
}

/**
 * tick 回调:高亮当前朗读段 + (followScroll 时)平滑滚动居中
 * @param {{chapterIdx: number, paraIdx: number, segIdx: number}} payload tick 数据
 * @returns {Promise<void>}
 */
async function handleTick(payload) {
  if (!payload) return
  const chIdx = Number(payload.chapterIdx)
  const pIdx = Number(payload.paraIdx)
  if (!Number.isFinite(chIdx) || !Number.isFinite(pIdx)) return
  const loc = `${chIdx}:${pIdx}`
  // 朗读跨章 → 该章不在已加载范围时先加载
  if (chIdx < firstLoadedCh.value || chIdx > lastLoadedCh.value) {
    await ensureChapterLoaded(chIdx)
  }
  playingLoc.value = loc
  if (!followScrollEnabled()) return
  await nextTick()
  scrollParaIntoView(loc)
}

// ===== 跳转 =====

/**
 * 按当前几何重新定位到待定跳转目标
 * @returns {void}
 */
function applyPendingTarget() {
  if (!pendingTarget) return
  const el = scrollEl.value
  if (!el) return
  const loc = pendingTarget.pIdx >= 0 ? `${pendingTarget.chIdx}:${pendingTarget.pIdx}` : `${pendingTarget.chIdx}:-1`
  const idx = indexByLoc.get(loc)
  if (idx == null) return
  scrollToItemIndex(idx, pendingTarget.mode)
}

/**
 * 找到已渲染的条目 DOM(用于精确定位)
 * @param {string} loc 条目标识
 * @returns {HTMLElement | null}
 */
function findItemNode(loc) {
  const el = scrollEl.value
  if (!el || !loc) return null
  return el.querySelector(`[data-loc="${loc}"]`)
}

/**
 * 把某个条目精确定位到视口。
 *
 * 两步走:
 *  1) 先用「估算高度」把窗口移到目标附近,让目标进入渲染窗口(±10 屏缓冲内);
 *  2) 再用目标元素的真实 DOM 几何(相对滚动容器的内容偏移)算出精确 scrollTop。
 *
 * 关键:第 2 步用真实几何而非估算前缀和,否则跨章累计的估算误差
 * (每段少算/多算几像素 × 上千段)会让跳转落到目标之前/之后几千像素处。
 *
 * @param {number} idx 条目下标
 * @param {'start' | 'center'} mode 对齐方式
 * @returns {void}
 */
function scrollToItemIndex(idx, mode) {
  const el = scrollEl.value
  if (!el) return
  const target = items.value[idx]
  if (!target) return
  // 第 1 步:估算位置 → 让目标进入渲染窗口
  const est = prefix.value[idx] + padTop.value
  el.scrollTop = Math.max(0, mode === 'center' ? est - el.clientHeight / 2 : est)
  updateWindow()
  // 第 2 步:真实几何精确定位(此时目标应已渲染)
  const node = findItemNode(target.loc)
  if (!node) return
  const scrollerRect = el.getBoundingClientRect()
  const nodeRect = node.getBoundingClientRect()
  // 节点在滚动内容中的精确偏移(含容器 padding)
  const exact = nodeRect.top - scrollerRect.top + el.scrollTop
  const offset = mode === 'center' ? Math.max(0, (el.clientHeight - nodeRect.height) / 2) : 0
  el.scrollTop = Math.max(0, exact - offset)
  // 记录程序化滚动后的实际位置(供 detectUserScroll 区分用户操作)
  if (pendingTarget) pendingTarget.expectedTop = el.scrollTop
  updateWindow()
}

/**
 * 跳到某章的标题
 * @param {number} chIdx 章节下标
 * @param {'start' | 'center'} [mode] 对齐方式
 * @returns {Promise<void>}
 */
async function gotoChapter(chIdx, mode = 'start') {
  if (chIdx < 0 || chIdx >= chapterTotal.value) return
  // 目标章不在当前渲染区间 → 以它为起点重建区间
  if (chIdx < firstLoadedCh.value || chIdx > lastLoadedCh.value) {
    await rebuildRange(chIdx, chIdx)
    await nextTick()
  }
  const el = scrollEl.value
  if (!el) return
  const idx = indexByLoc.get(`${chIdx}:-1`)
  if (idx == null) return
  // 记下待定目标:实测校正后按新几何重新定位,直到用户交互才放弃
  pendingTarget = { chIdx, pIdx: -1, mode }
  scrollToItemIndex(idx, mode)
  await nextTick()
  scrollToItemIndex(idx, mode)
  updateCurrentChapter()
  scheduleSavePosition(true)
}

/**
 * 跳到某个具体段落(恢复进度用,居中显示)
 * @param {number} chIdx 章节下标
 * @param {number} pIdx 段落下标
 * @param {'center' | 'start'} [mode] 对齐方式
 * @returns {Promise<void>}
 */
async function scrollToParagraph(chIdx, pIdx, mode = 'center') {
  if (chIdx < 0 || chIdx >= chapterTotal.value) return false
  if (chIdx < firstLoadedCh.value || chIdx > lastLoadedCh.value) {
    await rebuildRange(chIdx, chIdx)
    await nextTick()
  }
  const el = scrollEl.value
  if (!el) return false
  const idx = indexByLoc.get(`${chIdx}:${pIdx}`)
  if (idx == null) return false
  // 记下待定目标:实测校正后按新几何重新定位
  pendingTarget = { chIdx, pIdx, mode }
  scrollToItemIndex(idx, mode)
  await nextTick()
  scrollToItemIndex(idx, mode)
  updateCurrentChapter()
  scheduleSavePosition(true)
  return true
}

// ===== 尺寸变化 =====

/**
 * 读取容器下内边距
 * @returns {number}
 */
function getPadBottom() {
  const el = scrollEl.value
  if (!el || typeof window === 'undefined' || !window.getComputedStyle) return 0
  const cs = window.getComputedStyle(el)
  return (parseFloat(cs.paddingBottom) || 0) - (parseFloat(cs.paddingTop) || 0)
}

/**
 * 读取容器上内边距(内容坐标原点相对滚动原点的偏移)
 * @returns {number}
 */
function readPadTop() {
  const el = scrollEl.value
  if (!el || typeof window === 'undefined' || !window.getComputedStyle) return 0
  return parseFloat(window.getComputedStyle(el).paddingTop) || 0
}

/**
 * 读取容器左右内边距合计
 * @returns {number}
 */
function readPadInline() {
  const el = scrollEl.value
  if (!el || typeof window === 'undefined' || !window.getComputedStyle) return 0
  const cs = window.getComputedStyle(el)
  return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
}

/**
 * 把 ResizeObserver 挂到滚动容器上。
 *
 * 注意:滚动容器在 loading=false 之前并不存在(模板走 v-if 分支),
 * 所以 onMounted 时 scrollEl.value 往往为 null —— 必须在容器真正渲染后
 * 再挂一次,否则容器尺寸变化永远收不到通知,宽度/内边距一直是初始兜底值。
 *
 * @returns {void}
 */
function attachResizeObserver() {
  const el = scrollEl.value
  if (!el) return
  if (!resizeObserver) resizeObserver = new ResizeObserver(onResizeEntries)
  resizeObserver.observe(el)
}

/**
 * 同步容器度量(宽度/内边距),必要时重算高度估算。
 *
 * 估算用的是「内容宽度」= clientWidth - 左右内边距;若宽度取错,
 * 每行字数会被高估 → 段落行数被低估 → 跨章累积误差可达数千像素,
 * 目录跳转就会落到目标章之前(实测:估算 206.4px/段 vs 实际 109.2px/段)。
 *
 * @param {boolean} [force] 无变化时也强制重算
 * @returns {void}
 */
function syncMetrics(force) {
  const el = scrollEl.value
  if (!el) return
  const w = el.clientWidth
  const pt = readPadTop()
  const pi = readPadInline()
  const changed = w !== viewportWidth.value || pt !== padTop.value || pi !== padInline.value
  viewportWidth.value = w
  padTop.value = pt
  padInline.value = pi
  if (!changed && !force) return
  const anchor = pendingTarget ? null : captureAnchor()
  heights.value = items.value.map((it) => heightOf(it))
  rebuildPrefix()
  if (pendingTarget) applyPendingTarget()
  else restoreAnchor(anchor)
  updateWindow()
}

/**
 * 容器尺寸变化:重算宽度相关的高度估算,并用锚点保持视口稳定
 * @returns {void}
 */
function handleResize() {
  syncMetrics(false)
}

// ===== 初始化 =====

/**
 * 载入清单与首章,并按 lastPosition 定位
 * @returns {Promise<void>}
 */
async function init() {
  loading.value = true
  loadError.value = false
  items.value = []
  heights.value = []
  prefix.value = [0]
  indexByLoc.clear()
  measuredHeights.clear()
  chapterCache.clear()
  loadingChapters.clear()
  firstLoadedCh.value = 0
  lastLoadedCh.value = -1
  windowStart.value = 0
  windowEnd.value = -1
  viewportTopIndex.value = 0
  currentChapterIdx.value = -1
  pendingPosition = null
  playingLoc.value = ''
  if (positionTimer) {
    clearTimeout(positionTimer)
    positionTimer = 0
  }
  if (!props.bookId) {
    loading.value = false
    return
  }
  try {
    const manifest = await store.getManifest(props.bookId)
    const chapters = manifest && Array.isArray(manifest.chapters) ? manifest.chapters : []
    if (!chapters.length) {
      loadError.value = true
      loading.value = false
      return
    }
    manifestChapters.value = chapters
    // 把章节清单上报父组件(目录抽屉需要)
    emit('manifest', chapters)
    const book = store.books.find((b) => b && b.id === props.bookId)
    const last = book && book.lastPosition ? book.lastPosition : null
    let startCh = 0
    let startPara = 0
    const initCh = Number(props.initialChapter)
    if (Number.isInteger(initCh) && initCh >= 0 && initCh < chapters.length) {
      // 指定了起始章(章节管理页点某章进来)→ 直接从该章开始
      startCh = initCh
    } else if (last && Number.isFinite(Number(last.chapterIdx))) {
      startCh = Math.max(0, Math.min(chapters.length - 1, Number(last.chapterIdx)))
      startPara = Math.max(0, Number(last.segIdx) || 0)
    }
    await rebuildRange(startCh, startCh)
    // 预读下一章,滚动到底时无停顿(PLAN §4.2「切章预读下一章」)
    if (startCh + 1 < chapters.length) {
      await ensureChapter(startCh + 1)
    }
    loading.value = false
    await nextTick()
    // 容器此时才真正挂载 → 挂上 ResizeObserver 并同步真实尺寸
    attachResizeObserver()
    syncMetrics(true)
    updateWindow()
    if (last && startPara > 0) {
      await scrollToParagraph(startCh, startPara, 'center')
    } else {
      const el = scrollEl.value
      if (el) el.scrollTop = 0
      updateWindow()
      updateCurrentChapter()
    }
    // 定位完成 → 告知父组件当前起始位置(书架「听书」入口 autoplay=1 用)
    const pos = viewportPosition()
    if (pos) emit('positioned', pos)
  } catch {
    loadError.value = true
    loading.value = false
  }
}

/**
 * 条目 ref 注册:交给 ResizeObserver 观察,实测其真实高度
 * @param {HTMLElement | null} el 元素
 * @param {string} loc 条目标识
 * @returns {void}
 */
function setItemRef(el, loc) {
  if (!el) return
  observedEls.set(loc, el)
  if (resizeObserver) resizeObserver.observe(el)
}

/**
 * ResizeObserver 回调:容器尺寸变化 → 重算估算;条目尺寸变化 → 记录实测高度
 * @param {ResizeObserverEntry[]} entries 观察条目
 * @returns {void}
 */
function onResizeEntries(entries) {
  const el = scrollEl.value
  for (const entry of entries) {
    const node = entry.target
    if (node === el) {
      handleResize()
      continue
    }
    const loc = node.getAttribute('data-loc')
    if (!loc) continue
    const rect = node.getBoundingClientRect()
    const h = rect.height
    if (!Number.isFinite(h) || h <= 0) continue
    if (recordMeasured(loc, h)) measureDirty = true
  }
  if (measureDirty) scheduleMeasure()
}

/**
 * 清理已从 DOM 移除的观察目标,避免 ResizeObserver 持有游离节点
 * @returns {void}
 */
function pruneObserved() {
  if (!observedEls.size) return
  for (const [loc, el] of observedEls) {
    if (!el.isConnected) {
      if (resizeObserver) resizeObserver.unobserve(el)
      observedEls.delete(loc)
    }
  }
}

// ===== 生命周期 =====

onMounted(() => {
  const el = scrollEl.value
  if (el) {
    viewportWidth.value = el.clientWidth || 600
    padTop.value = readPadTop()
    padInline.value = readPadInline()
    attachResizeObserver()
  }
  // 订阅播放 tick:高亮当前朗读段 + 跟随滚动
  unsubscribeTick = player.onTick((payload) => {
    handleTick(payload)
  })
  init()
})

onBeforeUnmount(() => {
  if (unsubscribeTick) {
    unsubscribeTick()
    unsubscribeTick = null
  }
  if (autoFrame) cancelAnimationFrame(autoFrame)
  autoFrame = 0
  if (measureFrame) cancelAnimationFrame(measureFrame)
  measureFrame = 0
  if (positionTimer) clearTimeout(positionTimer)
  positionTimer = 0
  if (resizeObserver) resizeObserver.disconnect()
  resizeObserver = null
  observedEls.clear()
  // 组件卸载时立刻把进度刷给主进程(节流窗口内也可能丢)
  scheduleSavePosition(true)
  store.flushPositionNow()
})

// ===== 侦听 =====

/** 书籍切换 → 重新初始化 */
watch(
  () => props.bookId,
  () => {
    init()
  },
)

/** 字号/行距/字距变化 → 旧实测值失效,清空后重算估算(交给 RO 重新测) */
watch(
  () => [fontSize.value, lineHeight.value, letterSpacing.value],
  () => {
    if (!items.value.length) return
    measuredHeights.clear()
    const anchor = captureAnchor()
    heights.value = items.value.map((it) => heightOf(it))
    rebuildPrefix()
    restoreAnchor(anchor)
    updateWindow()
  },
)

/** 页边距变化 → 容器内边距变化 → 重新测量 */
watch(
  () => props.settings && props.settings.margin,
  () => {
    nextTick(() => handleResize())
  },
)

/** 自动翻页开关/速度变化 → 重启 rAF 循环 */
watch(
  () => [props.settings && props.settings.autoScroll, props.settings && props.settings.autoScrollSpeed],
  () => {
    if (autoFrame) cancelAnimationFrame(autoFrame)
    autoFrame = 0
    lastFrameTs = 0
    if (props.settings && props.settings.autoScroll) scheduleAutoScroll()
  },
)

/** 渲染窗口变化后清理游离观察目标 */
watch(
  () => windowStart.value,
  () => {
    pruneObserved()
  },
)

/**
 * 停止听书(status 回到 idle)→ 清除当前段高亮
 */
watch(
  () => player.status,
  (s) => {
    if (s === 'idle') playingLoc.value = ''
  },
)

// ===== 对外暴露 =====

defineExpose({
  /** 跳到指定章节 */
  gotoChapter,
  /** 跳到指定段落 */
  scrollToParagraph,
  /** 当前视口顶部段落位置 */
  viewportPosition,
  /** 重新加载(例如书籍数据变更后) */
  reload: init,
})
</script>

<template>
  <div class="vb-root">
    <!-- 首屏加载 -->
    <div v-if="loading" class="vb-hint">{{ t('common.loading') }}</div>
    <!-- 加载失败 -->
    <div v-else-if="loadError" class="vb-hint">{{ t('reader.loadFailed') }}</div>
    <!-- 正文 -->
    <div
      v-else
      ref="scrollEl"
      class="vb-scroll"
      @scroll="onScroll"
      @wheel="pauseAutoScroll"
      @touchstart="pauseAutoScroll"
    >
      <!-- 上方占位:高度 = prefix[windowStart] -->
      <div class="vb-spacer" :style="{ height: `${topSpacer}px` }"></div>
      <!-- 仅渲染可视区 ± 10 屏 -->
      <div
        v-for="entry in visibleItems"
        :key="entry.item.loc"
        :ref="(el) => setItemRef(el, entry.item.loc)"
        :data-loc="entry.item.loc"
        class="vb-item"
      >
        <h2 v-if="entry.item.kind === 'head'" class="vb-head" :data-loc="entry.item.loc">
          {{ entry.item.title || `第 ${entry.item.chIdx + 1} 章` }}
          <span v-if="!entry.item.paraCount" class="vb-empty">{{ t('reader.emptyChapter') }}</span>
        </h2>
        <p
          v-else
          class="vb-para"
          :class="{ 'para-playing': entry.item.loc === playingLoc }"
          :data-loc="entry.item.loc"
          @dblclick="onParaDblClick($event, entry.item)"
          @contextmenu.prevent="onParaContextMenu($event, entry.item)"
        >
          {{ entry.item.text }}
        </p>
      </div>
      <!-- 下方占位:高度 = 总高 - prefix[windowEnd + 1] -->
      <div class="vb-spacer" :style="{ height: `${bottomSpacer}px` }"></div>
    </div>
  </div>
</template>

<style scoped>
/* 滚动容器:内部所有正文样式走 --r-* 变量(由 ReaderView.applyReaderVars 下发) */
.vb-root {
  position: relative;
  height: 100%;
  min-height: 0;
}

.vb-scroll {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  /* 页边距(--r-padding)由阅读设置下发 */
  padding: var(--r-padding, 48px);
  /* 滚动条跟随阅读主题 */
  scrollbar-width: thin;
  scrollbar-color: var(--r-fg, #333) transparent;
}

.vb-scroll::-webkit-scrollbar {
  width: 10px;
}

.vb-scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--r-fg, #333) 30%, transparent);
  border-radius: 5px;
}

.vb-spacer {
  width: 100%;
}

/* 章节标题 */
.vb-head {
  margin: 0;
  padding-block: 8px;
  font-size: calc(var(--r-font-size, 18px) * 1.4);
  line-height: var(--r-line-height, 1.8);
  letter-spacing: var(--r-letter-spacing, 0px);
  font-weight: 700;
  color: var(--r-fg, #333);
}

/* 正文段落 */
.vb-para {
  margin: 0;
  padding-block: 6px;
  font-family: var(--r-font-family, serif);
  font-size: var(--r-font-size, 18px);
  line-height: var(--r-line-height, 1.8);
  letter-spacing: var(--r-letter-spacing, 0px);
  color: var(--r-fg, #333);
  text-align: justify;
  word-break: break-word;
  cursor: text;
  user-select: text;
}

.vb-para:hover {
  background: color-mix(in srgb, var(--r-fg, #333) 6%, transparent);
}

/* 当前朗读段:左侧 3px 主题色呼吸点 + 背景微高亮(DESIGN §3) */
.vb-para.para-playing {
  position: relative;
  background: color-mix(in srgb, var(--r-fg, #333) 10%, transparent);
  border-radius: 3px;
}

.vb-para.para-playing::before {
  content: '';
  position: absolute;
  left: -8px;
  top: 0.4em;
  bottom: 0.4em;
  width: 3px;
  border-radius: 2px;
  background: var(--el-color-primary, #409eff);
  animation: cs-breathing 1.6s ease-in-out infinite;
}

/* 呼吸动画:透明度与缩放同步脉动 */
@keyframes cs-breathing {
  0%,
  100% {
    opacity: 0.35;
    transform: scaleY(0.7);
  }
  50% {
    opacity: 1;
    transform: scaleY(1);
  }
}

/* 空章节提示 */
.vb-empty {
  display: block;
  font-size: calc(var(--r-font-size, 18px) * 0.8);
  font-weight: 400;
  opacity: 0.6;
}

/* 居中提示 */
.vb-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--r-fg, #333);
  opacity: 0.7;
}
</style>
