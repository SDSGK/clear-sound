const { Tray, nativeImage } = require('electron')

/**
 * macOS 状态栏歌词 + 托盘(PLAN §4.6 / DESIGN §5)。
 *
 * 形态:
 *  - 仅 macOS(darwin)创建 Tray;Windows 无状态栏标题能力,以桌面歌词为主
 *    (DESIGN §5 明示「状态栏歌词为 mac 专属」)
 *  - Tray 图标用 nativeImage.createEmpty() 的「纯文字模式」,状态栏文字由 setTitle 提供
 *  - 标题 = 状态前缀(▶ 播放 / ⏸ 暂停) + 当前句滚动窗口
 *  - 滚动窗口:每 300ms 左移一个字符,循环播放当前句(DESIGN §5「每 ~300ms 左移一个全角字符」)
 *  - 点击托盘 → onTogglePanel()(由 electron/index.js 弹出托盘面板)
 *
 * 纯逻辑(滚动窗口切片 / 状态归一)抽为纯函数,不依赖 Electron,可脱离运行时单测。
 */

/** ticker 刷新间隔(ms):每拍左移一个字符 */
const TICKER_INTERVAL_MS = 300
/** 滚动窗口宽度(字符位):用户需要单屏看到约 15 个汉字 → 取 30 全角位 */
const TICKER_WINDOW_WIDTH = 30
/** 状态栏标题的固定显示宽度(全角位):窗口内容 + 状态前缀合计,超出则截断 */
const TICKER_TITLE_WIDTH = 33
/** 无歌词/未播放时的状态栏标题 */
const APP_TITLE = '清声书坊'

/**
 * 字符显示宽度(全角/中文/日文假名 = 2,其余 = 1)。
 *
 * macOS 状态栏标题宽度按**显示宽度**计算,若直接用字符数截断,
 * 中文句子会明显比英文句子占位更宽 → 状态栏项宽度随内容跳动。
 * 这里统一按显示宽度切片与填充,保证状态栏项宽度恒定。
 *
 * @param {string} text 文本
 * @returns {number} 显示宽度
 */
function displayWidth(text) {
  let width = 0
  for (const ch of Array.from(typeof text === 'string' ? text : '')) {
    const cp = ch.codePointAt(0)
    // CJK 统一表意文字 / 全角符号 / 假名
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0x3000 && cp <= 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    width += wide ? 2 : 1
  }
  return width
}

/**
 * 把文本填充到固定显示宽度(不足补空格,超出截断)。
 * 用于让 macOS 状态栏歌词项宽度恒定 —— 否则宽度会随歌词长度来回跳动。
 *
 * @param {string} text 文本
 * @param {number} width 目标显示宽度
 * @returns {string}
 */
function padToWidth(text, width) {
  const src = typeof text === 'string' ? text : ''
  const target = Math.max(1, Math.floor(width))
  let out = ''
  let used = 0
  for (const ch of Array.from(src)) {
    const w = displayWidth(ch)
    if (used + w > target) break
    out += ch
    used += w
  }
  // 尾部用全角空格补足到目标宽度。不能用普通空格:macOS 状态栏会裁剪
  // 尾部半角空白(实测短文本+23 个半角空格的 bounds 与无填充相同),
  // 全角空格则保留实际宽度 → 状态栏项宽度恒定不随文本长度变化。
  let remain = target - used
  while (remain >= 2) {
    out += '\u3000'
    remain -= 2
  }
  if (remain === 1) out += ' '
  return out
}

/**
 * 归一化播放状态 → 'playing' | 'paused' | ''(未知)
 *
 * 兼容多种入参形态:
 *  - 字符串:'playing' / 'paused' / 'idle' / 'stopped' / 'finished'
 *  - 对象:{ status } / { state } / { playing: true } / { paused: true }
 *
 * @param {unknown} state 原始状态
 * @returns {'playing'|'paused'|''} 归一化结果('' = 无法识别,调用方保留原状态)
 */
function normalizeStatus(state) {
  let raw = ''
  if (typeof state === 'string') {
    raw = state
  } else if (state && typeof state === 'object') {
    if (typeof state.status === 'string') raw = state.status
    else if (typeof state.state === 'string') raw = state.state
    else if (state.playing === true) raw = 'playing'
    else if (state.paused === true) raw = 'paused'
  }
  const s = raw.trim().toLowerCase()
  if (s === 'playing') return 'playing'
  if (s === 'paused' || s === 'idle' || s === 'stopped' || s === 'finished') return 'paused'
  return ''
}

/**
 * 状态前缀:playing → ▶,paused → ⏸,未知 → ''(不加前缀)
 * @param {string} status 归一化状态
 * @returns {string} 前缀字符
 */
function statusPrefix(status) {
  if (status === 'playing') return '▶'
  if (status === 'paused') return '⏸'
  return ''
}

/**
 * 半角标点/空格 → 全角:混宽文本会让 ticker 窗口的显示宽度奇偶不齐
 * (半角 1 位/全角 2 位),同一段话滚动时宽度 ±1 位跳动。
 * 归一后窗口按全角步进切分,显示宽度恒定。
 * @param {string} text 文本
 * @returns {string}
 */
function normalizeFullWidth(text) {
  const map = {
    ',': '，',
    '.': '。',
    ':': '：',
    ';': '；',
    '?': '？',
    '!': '！',
    '(': '（',
    ')': '）',
    ' ': '　',
  }
  return String(text || '').replace(/[,.:;?!() ]/g, (ch) => map[ch] || ch)
}

/**
 * 计算状态栏 ticker 的滚动窗口(纯函数)。
 *
 * 语义:
 *  - 源文本按「字符」切分(Array.from 拆码点,规避代理对被截半),每个字符占 1 个位,
 *    近似 mac 状态栏的「全角位」计数
 *  - offset = 当前窗口在源文本中的起点(字符下标),超出文本长度时按取模回绕(循环滚动)
 *  - width = 窗口宽度(位),默认 14
 *  - 窗口没能覆盖到文本末尾时(文本被截断),末尾追加 '…' 提示后续仍有内容
 *
 * @param {string} lineText 当前句文本
 * @param {number} offset 窗口起点(字符下标)
 * @param {number} [width] 窗口宽度(位)
 * @returns {{ text: string, offset: number, truncated: boolean, total: number }}
 *   text=带省略号的窗口文本;offset=归一化后的起点;truncated=是否发生截断;total=文本字符数
 */
function sliceTickerWindow(lineText, offset, width = TICKER_WINDOW_WIDTH) {
  const chars = Array.from(typeof lineText === 'string' ? lineText : '')
  const total = chars.length
  if (total === 0) return { text: '', offset: 0, truncated: false, total: 0 }
  const w = Math.max(1, Math.floor(width))
  const raw = Math.floor(Number.isFinite(offset) ? offset : 0)
  const start = ((raw % total) + total) % total
  // 循环拼接:从 offset 起取满 width 位,越过文本尾回绕到头部,
  // 接缝处插入两个全角空格作为循环分隔。每拍窗口显示宽度恒等于 width ——
  // 旧实现绕回后窗口变短,尾部填充空格又被 macOS 裁剪,实测宽度在 124~230px 间跳动。
  const GAP = '\u3000\u3000'
  const gapW = displayWidth(GAP)
  let slice = ''
  let used = 0
  let wrapped = false
  for (let k = 0; used < w && k < total + w + 2; k += 1) {
    const pos = start + k
    if (pos >= total && !wrapped) {
      if (used + gapW <= w) {
        slice += GAP
        used += gapW
      }
      wrapped = true
    }
    const ch = chars[pos % total]
    const cw = displayWidth(ch)
    if (used + cw > w) break
    slice += ch
    used += cw
  }
  // 补满窗口宽度(全角步进,奇余补一个半角空格——出现在中部不会被状态栏裁剪)
  while (used + 2 <= w) {
    slice += '\u3000'
    used += 2
  }
  if (used < w) {
    slice += ' '
    used += 1
  }
  return {
    text: slice,
    offset: start,
    truncated: total > w,
    total,
  }
}

/**
 * 计算下一拍的窗口起点(纯函数):左移一个字符,到末尾后回到 0(循环)
 * @param {number} offset 当前起点
 * @param {number} total 文本字符数
 * @returns {number} 下一拍起点
 */
function nextTickerOffset(offset, total) {
  if (!Number.isFinite(total) || total <= 1) return 0
  const cur = ((Math.floor(offset) % total) + total) % total
  return (cur + 1) % total
}

/** 模块级 ticker 状态(便于 stopTicker 与调试读取) */
const tickerState = { lineText: '', nextText: '', status: '', offset: 0 }

/** @type {import('electron').Tray|null} */
let trayInstance = null
/** 播放/暂停按钮 Tray(字符随播放状态切换:⏸ 播放中可暂停 / ▶ 暂停中可播放) */
let toggleTrayRef = null
/** @type {NodeJS.Timeout|null} */
let tickerTimer = null

/**
 * 把当前 ticker 状态渲染到状态栏标题
 * @returns {void}
 */
function renderTitle() {
  if (!trayInstance) return
  const { status, offset } = tickerState
  const prefix = statusPrefix(status)
  if (!tickerState.lineText) {
    // 无歌词时也保持同样的固定宽度,避免状态栏项宽度跳动
    trayInstance.setTitle(padToWidth(prefix + APP_TITLE, TICKER_TITLE_WIDTH))
    return
  }
  // 放得下的整段静态展示(用户要求:一段话就是一段话,不持续变化);
  // 只有超出窗口宽度的长文本才走循环拼接的滚动窗口
  const scrolling = !!tickerTimer
  const win = scrolling
    ? sliceTickerWindow(tickerState.lineText, offset, TICKER_WINDOW_WIDTH)
    : { text: tickerState.lineText }
  // 状态前缀 + 窗口文本 → 整体填充到固定显示宽度
  const body = padToWidth(prefix + win.text, TICKER_TITLE_WIDTH)
  trayInstance.setTitle(body)
}

/**
 * 启动 ticker 定时器(300ms 一拍,左移一个字符)
 * @returns {void}
 */
function startTicker() {
  stopTicker()
  tickerTimer = setInterval(() => {
    if (!trayInstance) return
    const total = Array.from(tickerState.lineText).length
    tickerState.offset = nextTickerOffset(tickerState.offset, total)
    renderTitle()
  }, TICKER_INTERVAL_MS)
  if (tickerTimer && typeof tickerTimer.unref === 'function') tickerTimer.unref()
}

/**
 * 停止 ticker 定时器(app 退出清理)
 * @returns {void}
 */
function stopTicker() {
  if (tickerTimer) {
    clearInterval(tickerTimer)
    tickerTimer = null
  }
}

/**
 * 初始化状态栏 Tray(mac 专属)。
 *
 * @param {{ onTogglePanel?: () => void }} [options] onTogglePanel:点击托盘图标时回调(index.js 弹出面板)
 * @returns {{ available: boolean, setTick: (data: unknown) => void, setState: (state: unknown) => void, getBounds: () => object|null }}
 *   available=false 表示当前平台不支持(Windows);此时 setTick/setState 为空实现
 */
function initTray(options = {}) {
  const onTogglePanel = typeof options.onTogglePanel === 'function' ? options.onTogglePanel : () => {}
  // 菜单栏控制按钮组的动作回调:上一章/播放暂停/下一章/书签(index.js 转发渲染层播放器)
  const onControl = typeof options.onControl === 'function' ? options.onControl : () => {}

  // 非 macOS:状态栏歌词是 mac 专属能力,Windows 以桌面歌词为主(DESIGN §5)
  if (process.platform !== 'darwin') {
    return {
      available: false,
      setTick() {},
      setState() {},
      getBounds() { return null },
    }
  }

  if (!trayInstance) {
    // 纯文字模式:空图标 + setTitle 文字(dev 环境无图标告警属预期)
    trayInstance = new Tray(nativeImage.createEmpty())
    trayInstance.on('click', () => {
      onTogglePanel()
    })
    // 控制按钮组:macOS 无单条多按钮能力,以独立文字 Tray 充当按钮(全角空格垫宽点击区)
    const mkButton = (title, action) => {
      const t = new Tray(nativeImage.createEmpty())
      t.setTitle(title)
      t.on('click', () => onControl(action))
      return t
    }
    mkButton('　⏮　', 'prev')
    toggleTrayRef = mkButton('　⏸　', 'toggle')
    mkButton('　⏭　', 'next')
    mkButton('　♡　', 'bookmark')
    console.log('[tray] created')
    // ticker 由 setTick 按需启动(文本超出显示宽度才滚动)
    renderTitle()
  }

  return {
    available: true,

    /**
     * 写入一次歌词 tick(缓存文本 + 状态)
     * @param {unknown} data lyric:tick 载荷 { lineText, nextText, status }
     * @returns {void}
     */
    setTick(data) {
      const payload = data && typeof data === 'object' ? data : {}
      const lineText = typeof payload.lineText === 'string' ? payload.lineText : ''
      const nextText = typeof payload.nextText === 'string' ? payload.nextText : ''
      const status = normalizeStatus(payload.status)
      // 文本未变化时保持滚动位置(tick 高频到达,重置会让 ticker 卡住)
      const normalized = normalizeFullWidth(lineText)
      const changed = normalized !== tickerState.lineText
      tickerState.lineText = normalized
      tickerState.nextText = normalizeFullWidth(nextText)
      if (status) tickerState.status = status
      if (changed) tickerState.offset = 0
      // 只有文本超出显示宽度才滚动跑马灯;放得下的整段静态展示,不再持续跳动
      const needScroll = displayWidth(normalized) > TICKER_WINDOW_WIDTH
      if (needScroll && !tickerTimer) startTicker()
      if (!needScroll && tickerTimer) {
        stopTicker()
        tickerState.offset = 0
      }
      renderTitle()
    },

    /**
     * 写入播放状态(playing / paused)
     * @param {unknown} state 播放状态
     * @returns {void}
     */
    setState(state) {
      const status = normalizeStatus(state)
      if (status) tickerState.status = status
      // 播放/暂停按钮字符跟随状态:播放中显示 ⏸(点击暂停),否则 ▶(点击播放)
      if (toggleTrayRef) {
        toggleTrayRef.setTitle(status === 'playing' ? '　⏸　' : '　▶　')
      }
      renderTitle()
    },

    /**
     * 托盘图标在屏幕上的矩形(index.js 用于定位托盘面板)
     * @returns {object|null}
     */
    getBounds() {
      if (!trayInstance) return null
      try {
        return trayInstance.getBounds()
      } catch {
        return null
      }
    },
  }
}

module.exports = {
  initTray,
  stopTicker,
  sliceTickerWindow,
  nextTickerOffset,
  normalizeStatus,
  statusPrefix,
  displayWidth,
  padToWidth,
  normalizeFullWidth,
  TICKER_INTERVAL_MS,
  TICKER_WINDOW_WIDTH,
  TICKER_TITLE_WIDTH,
  APP_TITLE,
}
