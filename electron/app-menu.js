const { Menu } = require('electron')

/**
 * app-menu.js —— macOS/Windows 应用菜单(系统菜单栏,不是应用内顶栏)
 *
 * ## 为什么需要它
 *
 * Electron 未设置 application menu 时,macOS 菜单栏显示的是框架自带的默认英文菜单
 * (Electron / File / Edit / View / Window / Help)——**不随应用内语言切换**。
 * 用户看到的「顶部菜单还是英文的」正是这一栏(应用内的 el-menu 顶栏本来就跟随语言)。
 *
 * 这里构建一套中文/英文双语菜单,并在语言切换时重建。
 * 文案内置在本模块(主进程是 CommonJS,无法直接 import ESM 的 locales 文件),
 * 由渲染层通过 'app:set-locale' 通道告知当前语言。
 */

/** 应用品牌名(macOS 菜单栏首项) */
const APP_BRAND = '清声书坊'

/** 菜单文案(与 src/locales 的 appMenu 词条保持一致) */
const MENU_TEXT = {
  'zh-CN': {
    about: '关于清声书坊',
    hide: '隐藏清声书坊',
    hideOthers: '隐藏其他',
    unhide: '显示全部',
    quit: '退出清声书坊',
    file: '文件',
    closeWindow: '关闭窗口',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '拷贝',
    paste: '粘贴',
    selectAll: '全选',
    view: '视图',
    reload: '重新载入',
    actualSize: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    toggleFullScreen: '全屏',
    window: '窗口',
    minimize: '最小化',
    close: '关闭',
    help: '帮助',
  },
  'en-US': {
    about: 'About Clear Sound',
    hide: 'Hide Clear Sound',
    hideOthers: 'Hide Others',
    unhide: 'Show All',
    quit: 'Quit Clear Sound',
    file: 'File',
    closeWindow: 'Close Window',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    view: 'View',
    reload: 'Reload',
    actualSize: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    toggleFullScreen: 'Toggle Full Screen',
    window: 'Window',
    minimize: 'Minimize',
    close: 'Close',
    help: 'Help',
  },
}

/** 当前生效的语言(渲染层通过 IPC 告知) */
let currentLocale = 'zh-CN'

/**
 * 归一化语言标识
 * @param {unknown} locale
 * @returns {'zh-CN'|'en-US'}
 */
function normalizeLocale(locale) {
  const raw = String(locale || '').trim()
  if (raw.toLowerCase().startsWith('zh')) return 'zh-CN'
  return 'en-US'
}

/**
 * 构建并设置应用菜单
 * @param {unknown} [locale] 语言标识
 * @returns {string} 生效的语言
 */
function applyAppMenu(locale) {
  currentLocale = normalizeLocale(locale)
  const t = MENU_TEXT[currentLocale]
  const isMac = process.platform === 'darwin'

  /** @type {any[]} */
  const template = []

  if (isMac) {
    template.push({
      // 用品牌名而非 app.getName():dev(未打包)下 getName() 返回 'Electron'
      label: APP_BRAND,
      submenu: [
        { label: t.about, click: () => {} },
        { type: 'separator' },
        { label: t.hide, role: 'hide' },
        { label: t.hideOthers, role: 'hideOthers' },
        { label: t.unhide, role: 'unhide' },
        { type: 'separator' },
        { label: t.quit, role: 'quit' },
      ],
    })
  }

  template.push({
    label: t.file,
    submenu: isMac
      ? [{ label: t.closeWindow, role: 'close' }]
      : [
          { label: t.closeWindow, role: 'close' },
          { type: 'separator' },
          { label: t.quit, role: 'quit' },
        ],
  })

  template.push({
    label: t.edit,
    submenu: [
      { label: t.undo, role: 'undo' },
      { label: t.redo, role: 'redo' },
      { type: 'separator' },
      { label: t.cut, role: 'cut' },
      { label: t.copy, role: 'copy' },
      { label: t.paste, role: 'paste' },
      { label: t.selectAll, role: 'selectAll' },
    ],
  })

  template.push({
    label: t.view,
    submenu: [
      { label: t.reload, role: 'reload' },
      { label: t.actualSize, role: 'resetZoom' },
      { label: t.zoomIn, role: 'zoomIn' },
      { label: t.zoomOut, role: 'zoomOut' },
      { type: 'separator' },
      { label: t.toggleFullScreen, role: 'togglefullscreen' },
    ],
  })

  template.push({
    label: t.window,
    submenu: isMac
      ? [
          { label: t.minimize, role: 'minimize' },
          { label: t.close, role: 'close' },
        ]
      : [{ label: t.minimize, role: 'minimize' }],
  })

  template.push({
    label: t.help,
    submenu: [{ label: t.about, click: () => {} }],
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  return currentLocale
}

/**
 * 读取当前生效语言
 * @returns {string}
 */
function getLocale() {
  return currentLocale
}

module.exports = { applyAppMenu, getLocale, normalizeLocale, MENU_TEXT }
