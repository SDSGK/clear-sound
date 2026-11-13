const { contextBridge, ipcRenderer, webUtils } = require('electron')

/**
 * 渲染层可调用的 IPC 通道白名单(三向)。
 * 新增通道必须:1) 在对应表登记  2) 在 electron/ 主进程有对应 handler/listener
 */
// 渲染层 → 主进程(请求/响应)
const INVOKE_CHANNELS = [
  'window:show',
  'window:hide',
  'app:info',
  // 书库(M1/M4,handler 在 electron/library/ipc.js)
  'library:parse',
  'library:parse-from-path',
  'library:read-chapter',
  'library:append-chapters',
  'library:remove-chapter',
  'library:update-chapter',
  'library:fetch-page',
  'library:register',
  'library:list',
  'library:get-book',
  'library:remove',
  'library:update-position',
  // TTS(M2,handler 在 electron/tts/ipc.js)
  'tts:engines',
  'tts:synthesize',
  'lyric:tick',
  // 歌词/托盘(M3,handler 在 electron/tray.js 与 electron/index.js)
  'player:control',
  'lyric:set-locked',
  'lyric:toggle-desktop',
  'lyric:resize',
  'lyric:close',
  // 纠错(M4,handler 在 electron/corrections.js)
  'correction:list',
  'correction:add',
  'correction:update',
  'correction:remove',
  // 书签(M4,handler 在 electron/bookmarks.js)
  'bookmark:list',
  'bookmark:add',
  'bookmark:remove',
  // 配置导出导入 / 快捷键 / 数据目录(M6,handler 在 electron/index.js)
  'settings:export-file',
  'settings:import-file',
  'shortcut:set',
  'app:open-data-dir',
  'app:set-locale',
  // 调试日志(M6,handler 在 electron/index.js)
  'debug:log',
  'debug:get',
  'debug:clear',
  'debug:copy',
  // 统计与设置(M5,handler 在 electron/stats.js 与 electron/settings.js)
  'stats:summary',
  'stats:today',
  'stats:chapter-tick',
  'settings:get',
  'settings:set',
]
// 主进程 → 渲染层(main 主动推送,cs.on 订阅)
const PUSH_CHANNELS = [
  'lyric:tick-push',
  'player:state-push',
  'player:control-push',
  'reminder:eye-rest',
  'reminder:chime',
  'app:storage-error',
  // 全局快捷键:主进程注册 globalShortcut 后把动作转发到主窗(否则快捷键收不到)
  'player:shortcut',
]
// 渲染层 → 主进程(单向推送,cs.send;主窗播放器状态变化)
const SEND_CHANNELS = ['player:state']

contextBridge.exposeInMainWorld('cs', {
  /**
   * 调用主进程 IPC(带白名单校验)
   * @param {string} channel 通道名,如 'library:list'
   * @param {unknown} [payload] 参数
   * @returns {Promise<unknown>}
   */
  invoke(channel, payload) {
    if (!INVOKE_CHANNELS.includes(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload)
  },

  /**
   * 订阅主进程推送(main → renderer)
   * @param {string} channel PUSH_CHANNELS 之一
   * @param {(data: unknown) => void} cb 回调
   * @returns {() => void} 取消订阅函数
   */
  on(channel, cb) {
    if (!PUSH_CHANNELS.includes(channel)) {
      throw new Error(`IPC push channel not allowed: ${channel}`)
    }
    const listener = (_event, data) => cb(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  /**
   * 单向推送(renderer → main,无应答)
   * @param {string} channel SEND_CHANNELS 之一
   * @param {unknown} [payload] 参数
   */
  send(channel, payload) {
    if (!SEND_CHANNELS.includes(channel)) {
      throw new Error(`IPC send channel not allowed: ${channel}`)
    }
    ipcRenderer.send(channel, payload)
  },

  /**
   * 拖拽兜底:取拖拽文件的磁盘真实路径(Electron webUtils)。
   * Web File 读取受限(跨 App 拖拽 InvalidStateError)时,把路径交给主进程 fs 代读。
   * @param {File} file drop 事件里的 File 对象
   * @returns {string} 文件绝对路径(不可用时抛错)
   */
  getPathForFile(file) {
    return webUtils.getPathForFile(file)
  },
})
