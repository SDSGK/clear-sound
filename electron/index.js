const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, screen, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { registerLibraryIpc } = require('./library/ipc')
const { registerTtsIpc, createTtsHandlers, wrapHandler } = require('./tts/ipc')
const { registerCorrectionsIpc } = require('./corrections')
const { registerBookmarkIpc } = require('./bookmarks')
const { registerStatsIpc, addToToday, startActivityTracking } = require('./stats')
const { registerSettingsIpc, loadSettings } = require('./settings')
const { startReminders, stopReminders } = require('./reminders')
const { getUserStore, flushAllStores, setWriteErrorHandler } = require('./store')
const { initTray, stopTicker } = require('./tray')
const debugLog = require('./debug-log')
const { buildExportDoc, validateImportDoc, applyImportDoc } = require('./config-transfer')
const {
  selectDataRoot,
  legacyDataRoots,
  migrateLegacyData,
  repairOrphanChapterDirs,
  dedupeExistingBooks,
  normalizeBookMeta,
} = require('./data-dir')
const { applyAppMenu } = require('./app-menu')

// ============================================================
// 数据根目录:固定为 appData/clear-sound
//
// 此前用「多候选探测」决定 userData(dev 下是 .../Application Support/Electron,
// 兜底还会落到 temp/clear-sound-data)。探测结果随启动环境变化 → 数据散落在
// 多个目录,用户在书架上「书不见了」;temp 那一份还会被 macOS 定期清理 = 永久丢失。
//
// 现在固定用 appData/clear-sound(macOS: ~/Library/Application Support/clear-sound),
// 与 app 名、dev/打包、启动环境全部无关;并在启动时把旧目录的数据合并过来,
// 同时修复历史上 register 双 UUID 留下的孤儿章节目录。
// ============================================================
;(function ensureWritableUserData() {
  const previousUserData = (() => {
    try {
      return app.getPath('userData')
    } catch {
      return ''
    }
  })()
  // 稳定优先:优先沿用上次实际使用的目录(标记文件),保证跨启动一致 ——
  // 目录来回漂移正是「导入的书刷新就没了」的根因之一。
  const picked = selectDataRoot({ app })
  const root = picked.root
  app.setPath('userData', root)
  console.log(`[app] userData = ${root} (${picked.source}${picked.writable ? '' : ', 不可写!'})`)
  if (!picked.writable) {
    console.error(`[app] 数据目录不可写:${root} —— 本次改动可能无法保存,请检查目录权限`)
  }

  // 旧数据迁移 + 孤儿章节目录修复(幂等,失败不阻塞启动)
  try {
    const legacyRoots = legacyDataRoots({ app, previousUserData })
    const migrated = migrateLegacyData({ app, root, legacyRoots })
    const repaired = repairOrphanChapterDirs({ app, root })
    // 清理重复副本(同一本书被导入两次 → 书架上两本一模一样)
    const deduped = dedupeExistingBooks({ app, root })
    if (deduped.removed.length) {
      console.log('[app] 清理重复副本:', JSON.stringify(deduped.removed))
    }
    // 归一化既有书目:清洗书名(去书名号)+ 回填书的大小
    const normalized = normalizeBookMeta({ app, root })
    if (normalized.cleanedTitles.length || normalized.backfilledSizes.length) {
      console.log(
        '[app] 书目归一化:',
        JSON.stringify({
          cleanedTitles: normalized.cleanedTitles,
          backfilledSizes: normalized.backfilledSizes.length,
        }),
      )
    }
    if (migrated.merged.length || migrated.movedChapterDirs.length || repaired.repaired.length) {
      console.log(
        '[app] 数据迁移:',
        JSON.stringify({
          merged: migrated.merged,
          skippedDupes: migrated.skippedDupes,
          movedChapterDirs: migrated.movedChapterDirs.length,
          repaired: repaired.repaired,
          deduped: deduped.removed,
        }),
      )
    }
  } catch (err) {
    console.error(`[app] 数据迁移失败:${err && err.message}`)
  }
})()

// 捕获主进程报错(console.error / console.warn / 未捕获异常)→ 统一调试日志
debugLog.installMainErrorCapture()

// 写盘失败 → 通知渲染层(否则用户只会看到「导入的书刷新就没了」,毫无线索)
let storageErrorNotified = false
setWriteErrorHandler((err, filePath) => {
  const message = (err && err.message) || String(err)
  debugLog.logError('store.write', err, `[store] 写入失败 ${filePath}: ${message}`)
  // 同一问题只提示一次,避免连续写失败刷屏
  if (storageErrorNotified) return
  storageErrorNotified = true
  setTimeout(() => {
    storageErrorNotified = false
  }, 10000)
  sendTo(windows.main, 'app:storage-error', { filePath, message })
})

/**
 * M0 工程骨架:三窗口(主窗 / 桌面歌词窗 / 托盘面板窗)创建 + IPC 冒烟链路。
 * 后续里程碑按 docs/PLAN.md 逐步加入:windows/tray 拆分(M3)、TTS 调度(M2)、
 * 书库(M1)、纠错(M4)、统计与提醒(M5)。
 */

/** @type {{main: BrowserWindow|null, lyrics: BrowserWindow|null, trayPanel: BrowserWindow|null}} */
const windows = { main: null, lyrics: null, trayPanel: null }

/** dev 模式下由 vite-plugin-electron 注入的 dev server 地址 */
const DEV_URL = process.env.VITE_DEV_SERVER_URL

/**
 * lyric:tick 广播节流间隔(ms)。
 * DESIGN §9:「IPC lyric:tick → main 节流(≥200ms 间隔)」——播放 timeupdate 频率高,
 * 主进程只按 ≥200ms 的节奏向歌词窗 / 托盘面板 / 状态栏广播,避免渲染层频繁重绘。
 */
const TICK_BROADCAST_INTERVAL_MS = 200

/** 桌面歌词窗高度下限 / 上限(像素):仅允许拖拽条形区域 */
const LYRICS_MIN_HEIGHT = 48
const LYRICS_MAX_HEIGHT = 160

/** 状态栏 Tray 控制句柄(非 mac 为 null) */
let tray = null
/** 统计心跳停止函数(whenReady 内赋值,before-quit 调用) */
let stopStatsTracking = null

/** 最近一次广播的 tick 时间戳(节流用) */
let lastTickBroadcastAt = 0

/** 最近一次播放状态(主窗 player:state 推送) */
let lastPlayerState = { status: '' }

/** 桌面歌词窗是否处于锁定(鼠标穿透)状态 */
let lyricsLocked = false

/** 按入口 html 加载对应页面(开发走 dev server,打包走 dist 文件) */
function loadPage(win, page) {
  if (DEV_URL) {
    win.loadURL(`${DEV_URL}/${page}.html`)
  } else {
    win.loadFile(path.join(__dirname, '../dist', `${page}.html`))
  }
}

/** M0 窗口诊断:preload 失败 / 页面加载失败 / 加载完成时的真实尺寸与可见性 */
function attachDiagnostics(win, name) {
  win.webContents.on('preload-error', (_e, p, err) => {
    console.error(`[${name}] preload-error: ${p} :: ${err.message}`)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[${name}] did-fail-load: ${code} ${desc} ${url}`)
  })
  win.webContents.on('did-finish-load', () => {
    const [w, h] = win.getSize()
    console.log(`[${name}] page loaded, size ${w}x${h}, visible=${win.isVisible()}`)
  })
}

/** 渲染层共用 webPreferences */
function webPrefs() {
  return {
    // vite-plugin-electron simple 模式 preload 实际输出为 dist-electron/preload.js(CJS)
    preload: path.join(__dirname, 'preload.js'),
    // preload 以 ESM 输出(vite-plugin-electron 默认),需关闭 sandbox;
    // contextIsolation 保持开启,渲染层只能通过白名单 API(window.cs)访问主进程
    sandbox: false,
    contextIsolation: true,
    nodeIntegration: false,
  }
}

function createMainWindow() {
  windows.main = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'clear-sound',
    show: false,
    webPreferences: webPrefs(),
  })
  loadPage(windows.main, 'index')
  attachDiagnostics(windows.main, 'main')
  windows.main.once('ready-to-show', () => {
    if (windows.main) windows.main.show()
  })
  windows.main.on('closed', () => { windows.main = null })
}

function createLyricsWindow() {
  // 桌面歌词窗:透明无边框置顶,默认隐藏(M0 由设置页调试按钮控制,M3 接入正式开关)
  windows.lyrics = new BrowserWindow({
    width: 720,
    height: 96,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: webPrefs(),
  })
  windows.lyrics.setAlwaysOnTop(true, 'screen-saver')
  loadPage(windows.lyrics, 'lyrics')
  attachDiagnostics(windows.lyrics, 'lyrics')
  windows.lyrics.on('closed', () => { windows.lyrics = null })
}

function createTrayPanelWindow() {
  // 托盘面板窗(mac 状态栏点击弹出),失焦自动隐藏
  windows.trayPanel = new BrowserWindow({
    width: 260,
    height: 150,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    fullscreenable: false,
    // 置前:点击状态栏图标弹出的面板不能落到其他窗口后面
    // (macOS 上点击菜单栏图标会让本应用失焦,面板会被其他应用遮住)
    alwaysOnTop: true,
    webPreferences: webPrefs(),
  })
  windows.trayPanel.setAlwaysOnTop(true, 'floating')
  loadPage(windows.trayPanel, 'tray-panel')
  attachDiagnostics(windows.trayPanel, 'trayPanel')
  windows.trayPanel.on('blur', () => {
    if (windows.trayPanel && windows.trayPanel.isVisible()) windows.trayPanel.hide()
  })
  windows.trayPanel.on('closed', () => { windows.trayPanel = null })
}

// ===== M3 歌词中枢:tick 广播 / 播放控制转发 / 桌面歌词窗控制 =====

/**
 * 向指定窗口推送 IPC(窗口不存在或已销毁时静默跳过)
 * @param {BrowserWindow|null} win 目标窗口
 * @param {string} channel 通道名
 * @param {unknown} data 载荷
 * @returns {void}
 */
function sendTo(win, channel, data) {
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send(channel, data)
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    console.error(`[broadcast] ${channel} 推送失败:${message}`)
  }
}

/**
 * 归一化 tick 载荷(补齐字段 + 合并最近播放状态)
 * @param {object} payload lyric:tick 原始载荷
 * @returns {object} 广播用载荷
 */
function normalizeTickPayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  return {
    bookId: p.bookId ?? null,
    chapterIdx: Number.isFinite(p.chapterIdx) ? p.chapterIdx : 0,
    segIdx: Number.isFinite(p.segIdx) ? p.segIdx : 0,
    segOffsetRatio: Number.isFinite(p.segOffsetRatio) ? p.segOffsetRatio : 0,
    lineText: typeof p.lineText === 'string' ? p.lineText : '',
    nextText: typeof p.nextText === 'string' ? p.nextText : '',
    status: lastPlayerState.status || '',
  }
}

/**
 * tick 三路广播(DESIGN §9):歌词窗 / 托盘面板 / mac 状态栏 ticker。
 * 节流:两次广播间隔 ≥ TICK_BROADCAST_INTERVAL_MS。
 * @param {object} payload lyric:tick 原始载荷
 * @returns {void}
 */
function broadcastTick(payload) {
  const now = Date.now()
  if (now - lastTickBroadcastAt < TICK_BROADCAST_INTERVAL_MS) return
  lastTickBroadcastAt = now

  const data = normalizeTickPayload(payload)
  sendTo(windows.lyrics, 'lyric:tick-push', data)
  sendTo(windows.trayPanel, 'lyric:tick-push', data)
  if (tray) tray.setTick(data)
}

/**
 * 归一化播放状态(字符串 / 对象都兼容)
 * @param {unknown} state player:state 原始载荷
 * @returns {{status: string}} 归一化结果
 */
function normalizePlayerState(state) {
  if (typeof state === 'string') return { status: state }
  if (state && typeof state === 'object') {
    if (typeof state.status === 'string') return { ...state, status: state.status }
    if (typeof state.state === 'string') return { ...state, status: state.state }
    if (state.playing === true) return { ...state, status: 'playing' }
    if (state.paused === true) return { ...state, status: 'paused' }
    return { ...state, status: '' }
  }
  return { status: '' }
}

/**
 * 弹出托盘面板:右对齐状态栏托盘图标,置于图标下方,并夹紧到屏幕工作区内(防出屏)
 * @returns {void}
 */
function showTrayPanel() {
  const panel = windows.trayPanel
  if (!panel || panel.isDestroyed()) return

  const [panelW, panelH] = panel.getSize()
  const bounds = tray ? tray.getBounds() : null

  let x
  let y
  let display
  if (bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
    // 托盘图标右侧对齐,图标正下方
    x = Math.round(bounds.x + bounds.width - panelW)
    y = Math.round(bounds.y + bounds.height + 4)
    display = screen.getDisplayMatching(bounds)
  } else {
    // 无托盘(非 mac)时退化为鼠标位置附近
    const cursor = screen.getCursorScreenPoint()
    x = cursor.x - panelW
    y = cursor.y + 8
    display = screen.getDisplayNearestPoint({ x, y })
  }

  // 防出屏:夹到该屏幕工作区内
  const area = display.workArea
  x = Math.max(area.x, Math.min(x, area.x + area.width - panelW))
  y = Math.max(area.y, Math.min(y, area.y + area.height - panelH))

  panel.setPosition(x, y)
  panel.setAlwaysOnTop(true, 'floating')
  panel.show()
  panel.focus()
}

// ===== IPC 冒烟链路(白名单同步维护在 electron/preload.js)=====
ipcMain.handle('window:show', (_event, name) => {
  const win = windows[name]
  if (win) {
    win.show()
    win.focus()
  }
})

ipcMain.handle('window:hide', (_event, name) => {
  const win = windows[name]
  if (win) win.hide()
})

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  electron: process.versions.electron,
}))

// ===== M3 歌词中枢 IPC(白名单见 electron/preload.js)=====

/**
 * 播放控制反向通道:歌词窗 / 托盘面板 → 主窗播放器(DESIGN §9)。
 * 主进程只做透传,执行结果经下一次 tick 自然广播(单一数据流,无回环)。
 */
ipcMain.handle('player:control', (_event, payload) => {
  const action = payload && typeof payload.action === 'string' ? payload.action : ''
  sendTo(windows.main, 'player:control-push', { action })
  return { ok: true }
})

/**
 * 主窗 → 主进程:播放器状态变化(playing / paused …)
 * 主进程记录并广播给歌词窗 / 托盘面板,同时同步状态栏 ticker 前缀。
 */
ipcMain.on('player:state', (_event, state) => {
  const prevStatus = lastPlayerState && lastPlayerState.status
  lastPlayerState = normalizePlayerState(state)
  // 播放会话计数:新的一次开播(非暂停恢复)→ plays + 1
  if (lastPlayerState && lastPlayerState.status === 'playing' && prevStatus !== 'playing' && prevStatus !== 'paused') {
    try {
      addToToday(getUserStore('stats.json'), 'plays', 1)
    } catch {
      /* 统计失败不影响播放 */
    }
  }
  sendTo(windows.lyrics, 'player:state-push', lastPlayerState)
  sendTo(windows.trayPanel, 'player:state-push', lastPlayerState)
  if (tray) tray.setState(lastPlayerState)
})

/**
 * 桌面歌词窗显隐开关
 */
ipcMain.handle('lyric:toggle-desktop', (_event, payload) => {
  const win = windows.lyrics
  // 未指定 on → 取反(快捷键切换用);指定 → 按值设置
  const current = !!(win && !win.isDestroyed() && win.isVisible())
  const on = payload && typeof payload.on === 'boolean' ? payload.on : !current
  if (win && !win.isDestroyed()) {
    if (on) {
      win.show()
      // 锁定状态下保持鼠标穿透(DESIGN §4)
      if (lyricsLocked) win.setIgnoreMouseEvents(true, { forward: true })
    } else {
      win.hide()
    }
  }
  return { ok: true, visible: on }
})

/**
 * 桌面歌词窗锁定(鼠标完全穿透,仅托盘面板 / 快捷键可解锁)
 */
ipcMain.handle('lyric:set-locked', (_event, payload) => {
  const locked = !!(payload && payload.locked)
  lyricsLocked = locked
  const win = windows.lyrics
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(locked, { forward: true })
  }
  return { ok: true, locked }
})

/**
 * 桌面歌词窗高度调整(保持 x / y / 宽不变,仅改高,夹在 [48, 160])
 */
ipcMain.handle('lyric:resize', (_event, payload) => {
  const win = windows.lyrics
  const raw = payload && Number.isFinite(payload.height) ? payload.height : null
  if (win && !win.isDestroyed() && raw !== null) {
    const height = Math.max(LYRICS_MIN_HEIGHT, Math.min(LYRICS_MAX_HEIGHT, Math.round(raw)))
    const b = win.getBounds()
    win.setBounds({ x: b.x, y: b.y, width: b.width, height })
  }
  return { ok: true }
})

/**
 * 关闭桌面歌词窗(隐藏,保留窗口实例)
 */
ipcMain.handle('lyric:close', () => {
  const win = windows.lyrics
  if (win && !win.isDestroyed()) win.hide()
  return { ok: true }
})

app.whenReady().then(() => {
  // 书库 IPC(library:parse / parse-from-path / fetch-page / register / list / get-book / remove / update-position)
  registerLibraryIpc()
  // TTS IPC(tts:engines / tts:synthesize / lyric:tick)
  registerTtsIpc()
  // 纠错 IPC(correction:list / add / update / remove)
  registerCorrectionsIpc()
  // 书签 IPC(bookmark:list / add / remove)
  registerBookmarkIpc()
  // 统计 IPC(stats:summary / stats:today)
  registerStatsIpc()

  // ===== M6:配置导出 / 导入 / 全局快捷键 / 数据目录 =====
  ipcMain.handle('settings:export-file', async (_event, payload) => {
    const includeCorrections = !payload || payload.includeCorrections !== false
    const includeBookmarks = !payload || payload.includeBookmarks !== false
    const settingsStore = getUserStore('settings.json')
    // 脱敏与文档组装走纯逻辑模块(可脱离 Electron 单测)
    const { doc, keysOmitted } = buildExportDoc({
      settings: loadSettings(settingsStore),
      corrections: getUserStore('corrections.json').getRaw(),
      bookmarks: getUserStore('bookmarks.json').getRaw(),
      includeCorrections,
      includeBookmarks,
    })
    const stamp = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    // 显式指定路径时跳过对话框(脚本化导出 / 自动化验收);否则走保存对话框
    let filePath = payload && typeof payload.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) {
      const result = await dialog.showSaveDialog({
        title: '导出配置',
        defaultPath: `clear-sound-config-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}.json`,
        filters: [{ name: 'JSON 配置', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      filePath = result.filePath
    }
    try {
      fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8')
    } catch (err) {
      // 写盘失败(无权限/路径不存在)→ 可读错误,不让异常冒到渲染层
      const message = err && err.message ? err.message : String(err)
      debugLog.logError('settings.export', err, `[settings] 导出配置失败:${message}`)
      return { ok: false, error: message }
    }
    debugLog.logAction('settings.export', `导出配置 → ${filePath}(apiKey 脱敏 ${keysOmitted} 项)`)
    return { ok: true, path: filePath, keysOmitted }
  })

  ipcMain.handle('settings:import-file', async (_event, payload) => {
    // 显式指定路径时跳过对话框(脚本化导入 / 自动化验收);否则走打开对话框
    let filePath = payload && typeof payload.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) {
      const result = await dialog.showOpenDialog({
        title: '导入配置',
        properties: ['openFile'],
        filters: [{ name: 'JSON 配置', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: false, canceled: true }
      filePath = result.filePaths[0]
    }
    let doc = null
    try {
      doc = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
      throw new Error('配置文件不是合法 JSON')
    }
    // 校验走纯逻辑模块(可脱离 Electron 单测)
    validateImportDoc(doc)
    // 分区应用:settings / corrections / bookmarks
    const applied = applyImportDoc(doc, (kind, data) => {
      const store = getUserStore(
        kind === 'settings' ? 'settings.json' : kind === 'corrections' ? 'corrections.json' : 'bookmarks.json',
      )
      store.setRaw(data)
      store.save()
    })
    // 导入后即时生效:调试开关 / 缓存上限 / 全局快捷键
    const imported = doc.settings
    debugLog.setEnabled(!(imported && imported.debug && imported.debug.enabled === false))
    if (imported && imported.cacheLimitMB) {
      debugLog.logAction('settings.import', `导入配置应用缓存上限:${imported.cacheLimitMB}MB`)
    }
    if (imported && imported.shortcuts && Object.keys(imported.shortcuts).length) {
      applyShortcuts(imported.shortcuts)
      applied.push('shortcuts')
    }
    debugLog.logAction('settings.import', `导入配置 ← ${filePath}(应用:${applied.join(',')})`)
    return { ok: true, applied, path: filePath }
  })

  // 全局快捷键:先注销旧的,再按新配置注册;冲突返回失败明细
  const registeredShortcuts = {}
  function applyShortcuts(actions) {
    for (const accelerator of Object.values(registeredShortcuts)) {
      try {
        globalShortcut.unregister(accelerator)
      } catch {
        /* 忽略注销失败 */
      }
    }
    for (const key of Object.keys(registeredShortcuts)) delete registeredShortcuts[key]
    const failed = []
    for (const action of Object.keys(actions || {})) {
      const accelerator = actions[action]
      if (!accelerator) continue
      try {
        const ok = globalShortcut.register(accelerator, () => {
          if (windows.main && !windows.main.isDestroyed()) {
            windows.main.webContents.send('player:shortcut', { action })
          }
        })
        if (ok) {
          registeredShortcuts[action] = accelerator
        } else {
          failed.push({ action, accelerator, reason: '快捷键已被其他应用占用' })
        }
      } catch (err) {
        failed.push({ action, accelerator, reason: (err && err.message) || '注册失败' })
      }
    }
    debugLog.logAction(
      'shortcut.set',
      `设置快捷键 ${Object.keys(registeredShortcuts).length} 项${failed.length ? ',失败:' + failed.map((f) => f.action).join(',') : ''}`,
    )
    return { ok: failed.length === 0, registered: { ...registeredShortcuts }, failed }
  }
  ipcMain.handle('shortcut:set', (_event, payload) => applyShortcuts((payload && payload.actions) || {}))

  // 启动时应用已保存的快捷键
  try {
    const savedSettings = loadSettings(getUserStore('settings.json'))
    if (savedSettings.shortcuts && Object.keys(savedSettings.shortcuts).length) {
      applyShortcuts(savedSettings.shortcuts)
    }
  } catch {
    /* 设置缺失则不注册 */
  }

  ipcMain.handle('app:open-data-dir', () => {
    shell.openPath(app.getPath('userData'))
    return { ok: true }
  })

  // 应用内语言切换 → 重建系统菜单栏(macOS 菜单栏默认英文,不跟随应用语言)
  ipcMain.handle('app:set-locale', (_event, payload) => {
    const locale = applyAppMenu(payload && payload.locale)
    debugLog.logAction('app.locale', `系统菜单语言:${locale}`)
    return { ok: true, locale }
  })

  // 调试日志 IPC(统一本地存储,上限 60 条,设置页可复制/清空)
  ipcMain.handle('debug:log', (_event, payload) => {
    const data = payload || {}
    debugLog.append({
      level: data.level === 'error' ? 'error' : data.level === 'warn' ? 'warn' : 'info',
      action: data.action || 'unknown',
      message: data.message || '',
      detail: data.detail || '',
      source: data.source || 'renderer',
    })
    return { ok: true }
  })
  ipcMain.handle('debug:get', () => ({ ok: true, entries: debugLog.getEntries() }))
  ipcMain.handle('debug:clear', () => {
    debugLog.clear()
    return { ok: true }
  })
  ipcMain.handle('debug:copy', () => {
    const text = debugLog.formatForClipboard()
    clipboard.writeText(text)
    debugLog.logAction('debug.copy', `复制调试信息(${text.length} 字符)`, 'main')
    return { ok: true, length: text.length }
  })
  // 统计活动心跳(前台聚焦:播放→listenSec,否则→readSec)
  stopStatsTracking = startActivityTracking({
    getWindow: () => windows.main,
    getPlayerState: () => (lastPlayerState && lastPlayerState.status) || '',
  })
  // 设置 IPC(settings:get / settings:set)
  registerSettingsIpc()
  // 提醒调度:20-20-20 与整点提示(push 到主窗渲染层,配置存 settings.json)
  startReminders({
    getWindow: () => windows.main,
    getSettings: () => loadSettings(getUserStore('settings.json')),
    push: (channel, payload) => {
      if (windows.main && !windows.main.isDestroyed()) {
        windows.main.webContents.send(channel, payload)
      }
    },
  })
  const ttsHandlers = createTtsHandlers()
  // 合成字符累计:接管 tts:synthesize,成功后按文本长度计入今日统计
  ipcMain.removeHandler('tts:synthesize')
  ipcMain.handle('tts:synthesize', wrapHandler('tts:synthesize', async (payload) => {
    const result = await ttsHandlers['tts:synthesize'](payload)
    if (result && result.ok && payload && payload.text) {
      try {
        addToToday(getUserStore('stats.json'), 'chars', String(payload.text).length)
      } catch {
        /* 统计失败不影响合成 */
      }
    }
    return result
  }))
  ipcMain.removeHandler('lyric:tick')
  ipcMain.handle('lyric:tick', wrapHandler('lyric:tick', async (payload) => {
    const result = await ttsHandlers['lyric:tick'](payload)
    if (result && result.ok) broadcastTick(payload)
    return result
  }))
  // 系统菜单栏(默认是 Electron 自带的英文菜单,需显式构建并本地化)
  applyAppMenu('zh-CN')
  createMainWindow()
  createLyricsWindow()
  createTrayPanelWindow()
  // mac 状态栏 Tray(非 mac 返回 available:false,Windows 以桌面歌词为主)
  tray = initTray({
    onTogglePanel: () => showTrayPanel(),
    // 菜单栏控制按钮组:上一章/播放暂停/下一章/书签 → 转发渲染层播放器(与托盘面板同通道)
    onControl: (action) => sendTo(windows.main, 'player:control-push', { action }),
  })
})

// 退出前强制落盘 JSON 存储(30s 防抖的兜底)
app.on('before-quit', () => {
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* 忽略 */
  }
  stopTicker()
  stopReminders()
  if (stopStatsTracking) stopStatsTracking()
  flushAllStores()
})

app.on('activate', () => {
  // mac:点 Dock 图标时确保主窗可见
  if (!windows.main) createMainWindow()
  else windows.main.show()
})

app.on('window-all-closed', () => {
  // 阅读工具语义:关闭全部窗口即退出(简化处理,与 mac 常规惯例不同,后续可调)
  app.quit()
})
