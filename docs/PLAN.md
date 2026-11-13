# clear-sound 项目方案(PLAN)

> 一句话定位:跨平台「边读边听」TTS 阅读器 —— 本地书库 + 阅读器 + TTS 语音合成,
> 语音模式下提供网易云风格的**桌面歌词**与 **macOS 状态栏歌词**,文字进度与语音进度实时互驱。
>
> 背景痛点:现有软件要么只能「文字 → 音频文件」(配音工具,不能跟着读),
> 要么只能「看」(阅读器,没有语音跟随)。本项目把两者合一。

---

## 1. 需求清单与分级

| # | 需求 | 级别 | 说明 |
|---|------|------|------|
| 1 | 导入 txt 等多种格式 | MVP | txt / md / epub;自动识别编码(UTF-8 / GBK / GB18030 / BIG5);PDF 列入后续 |
| 2 | 阅读器样式自定义 | MVP | 字体、字号、行距、字距、页边距、背景主题(白/羊皮纸/护眼绿/暗黑/自定义色) |
| 3 | 自动翻页 | MVP | 纯阅读模式:按速度自动滚动;语音模式:跟随语音自动翻页 |
| 4 | TTS 引擎:本地(**默认**) | MVP | macOS `say`、Windows SAPI,零网络零 key,兜底开箱即用 |
| 5 | TTS 引擎:大模型/云端 | MVP | OpenAI 兼容接口(填 baseURL + key 即用,兼容 SiliconFlow/Groq/自建网关)、Azure Speech;edge-tts(免费无需 key)作为可选在线音色 |
| 6 | 语音进度跟随 | MVP | 当前句高亮 + 自动滚动居中;点击任意段落从该处开播 |
| 7 | 桌面歌词 | MVP | 透明置顶无边框窗口,可拖动/锁定,单双行,字体/渐变/描边/背景可调 |
| 8 | macOS 状态栏歌词 | MVP | 托盘标题滚动歌词(TickerTape)+ 点击弹出迷你控制面板;Windows 侧以桌面歌词为主 |
| 9 | 轻微级别纠错 | MVP | 错别字/多音字词级替换 + 用户自定义规则(纯文本/正则,全局或本书生效);显示与合成双通道独立开关 |
| 10 | 书签 | MVP | 任意段落位置书签,列表跳转;每书自动记忆阅读进度 |
| 11 | 使用统计 | MVP | 听书时长、阅读时长、合成字符数、连续使用天数;日/周/月视图 |
| 12 | 20-20-20 护眼提示 | MVP | 默认每 20 分钟提示休息 20 秒,间隔/时长/开关可配置,**默认开启** |
| 13 | 整点提示 | MVP | 整点轻提示 + 提示音,音量可调,**默认开启** |
| 14 | 大文件性能 | MVP | 流式导入、按章加载、虚拟滚动、TTS 分段惰性生成 + 缓存 |
| 15 | 配置导出/导入 | MVP | 设置(阅读偏好/TTS 引擎参数/歌词样式/提醒)、纠错规则、书签可一键导出为 config 文件,导入时校验+预览+冲突策略;详见 §4.13 |
| 16 | 全局快捷键 | P1 | 播放/暂停、上下段、桌面歌词开关等,可自定义 |
| 17 | 火山豆包/讯飞/MiniMax TTS | P1 | 引擎抽象已预留扩展位 |
| 18 | 在线书源/网页正文抓取 | P2 | **本方案默认不含**(见 §9 待确认),先做本地导入 |
| 19 | 导出音频文件 | P2 | 整章/全书合成为 mp3(纯配音工具模式) |
| 20 | 网页正文抓取导入 | MVP | 书架「网页导入」粘贴 URL → Readability 抽正文成书,支持重新抓取更新(见 §4.14);泛书源不做 |
| 21 | 多语言 + 品牌 | MVP | 中文/英文,设置内切换(vue-i18n,偏好存 localStorage,默认跟随系统语言);品牌名「清声书坊」艺术字渲染、不随语言翻译(见 §4.15) |
| 22 | 夜间模式 | MVP | 界面主题:跟随系统(默认)/浅色/深色,系统切换实时跟随;Element Plus dark 变量 + CSS 变量双通道;阅读背景主题独立于界面主题,见 §4.16 |

---

## 2. 技术选型(与参考项目对照)

| 层 | 选择 | 来源/理由 |
|----|------|-----------|
| 桌面框架 | Electron `^35` + vite-plugin-electron `^0.28` | gx-remote-desk 同款,dev 时 Vite 自动拉起主进程 |
| 前端框架 | Vue `^3.5` + Vite `^6` | gx-remote-ui 同款 |
| UI 组件 | Element Plus `^2.11` + @element-plus/icons-vue | gx-remote-ui 同款 |
| 样式 | Tailwind CSS `^4`(@tailwindcss/vite)+ scss | gx-remote-ui 同款 |
| 状态管理 | Pinia | Vue3 官方推荐(参考项目用 vuex,新项目不再引入) |
| 代码检查 | ESLint `^9` 扁平配置,**仅语法校验** | 照搬 gx-remote-ui 策略:只开 `no-undef` / `no-unused-vars`(error 级)+ eslint-plugin-vue flat/recommended;**无风格规则,不接构建链,手动 `npm run lint`**,不影响开发与构建速度 |
| 语言 | JavaScript + JSDoc 注释 | 与两个参考项目一致,不引入 TS |
| 数据存储 | 分层存储:主进程 JSON(原子写)+ 渲染层 IndexedDB + OPFS;localStorage 只存 UI 小数据 | 不引 SQLite 等原生模块;大内容走 OPFS、结构化索引走 IndexedDB、小配置走 JSON,详见 §4.12 |
| 图表 | ECharts(按需引入:core + BarChart/LineChart + Grid/Tooltip 组件) | 统计页日/周/月趋势;按需引入控制体积 |
| 打包 | electron-builder(dmg / nsis / AppImage) | gx-remote-desk 同款脚本体系 |
| 依赖补充 | iconv-lite + chardet(编码)、jszip + adm-zip(epub)、msedge-tts(edge 引擎)、vue-i18n(中/英多语言) | 均为纯 JS 依赖,无原生编译 |

### 渲染进程多入口(Vite 多页)

| 入口 | 窗口 | 用途 |
|------|------|------|
| `index.html` | 主窗口 | 书架 / 阅读器 / 统计 / 设置 |
| `lyrics.html` | 桌面歌词窗 | 透明置顶歌词悬浮窗 |
| `tray-panel.html` | 托盘面板窗 | mac 状态栏点击弹出的迷你控制面板 |

---

## 3. 总体架构

```
┌────────────────────────── Electron App ──────────────────────────┐
│                                                                  │
│  Main Process (electron/)                                        │
│  ├─ 窗口管理: 主窗 / 歌词窗 / 托盘面板窗                            │
│  ├─ Tray + 状态栏歌词 ticker (mac)                                │
│  ├─ GlobalShortcut 全局快捷键                                     │
│  ├─ TTS 调度器: 引擎抽象 / 队列 / 预合成 / 缓存                     │
│  ├─ 书库: 导入 / 解析 / 编码探测 / 分章                             │
│  ├─ 纠错规则引擎 / 统计聚合 / 提醒调度(20-20-20、整点)               │
│  └─ JSON 存储(books/settings/stats/...)                          │
│        │  IPC (contextBridge + preload,通道见 §7)                 │
│  ┌─────┼──────────────┬──────────────────┐                       │
│  ▼     ▼              ▼                  ▼                       │
│ 主窗渲染层      歌词窗渲染层        托盘面板渲染层   (均 Vue3 独立入口) │
│ 书架/阅读器/    歌词渲染/拖锁/样式   两行歌词+播放控制                 │
│ 统计/设置       <audio> 播放器(在主窗,进度经 main 广播)              │
└──────────────────────────────────────────────────────────────────┘
```

**职责划分原则**:凡是系统资源(文件、网络、托盘、快捷键、定时调度)都在主进程;
凡是 UI 渲染都在渲染层;`<audio>` 播放器放主窗渲染层(时间轴精度高),
进度事件经 main 汇聚后广播给歌词窗 / 托盘,单点驱动、多处跟随。

---

## 4. 关键技术方案

### 4.1 内容导入与解析

- 选择文件 → 读 Buffer → `chardet` 探测编码 → `iconv-lite` 解码(UTF-8 BOM 直读)
- 格式解析:
  - **txt**:章节正则识别(`第X章/卷/回`、`Chapter n`、`-- 分隔 --`,规则可在导入向导调整);无章节则整本单章按 ~2000 字自动软分节
  - **md**:按 `#`/`##` 标题切章
  - **epub**:解 zip 读 `opf` spine 顺序,抽取 xhtml 纯文本(html 标签剥离,保留段落)
- 文件**默认复制副本**到 `userData/library/<id>.<ext>`,防源文件移动/删除导致书库损坏
- 正文不落 JSON,只存元数据(章节数、字数、路径、进度)

### 4.2 阅读器

- 按章加载:打开书 → 目录树 → 进入章节才读该章文本,切章预读下一章
- 虚拟滚动:章节内按段落分块,只渲染可视区 ±10 屏缓冲;段落高度估算 + 实测校正,十万字级章节不掉帧
- 样式:CSS 变量驱动(font-family / font-size / line-height / letter-spacing / margin / 背景色),主题预设 + 自定义;设置即时热更
- 自动翻页(纯阅读):匀速滚动,速度(px/s)可调,滚到底自动下一章(可关)
- 语音模式:当前朗读段高亮(`playing` 类)且自动滚动居中(可关"跟随滚动")

### 4.3 TTS 引擎抽象

统一接口(主进程实现,渲染层无感知):

```
engineId / name / offline / needsKey
listVoices() -> Voice[]
synthesize(text, {voice, rate, pitch, volume}) -> { buffer, mime, durationMs }
```

| 引擎 | 离线 | Key | 实现方式 |
|------|------|-----|---------|
| macOS say(**默认**) | 离线 | 免 | spawn `say -o aiff` → `afconvert` 转 m4a;`say -v ?` 列音色(如 zh_CN Tingting) |
| Windows SAPI(**默认**) | 离线 | 免 | PowerShell `System.Speech` 输出 wav |
| edge-tts | 在线 | 免 | `msedge-tts`,微软 Edge 朗读接口;**非官方接口可能失效**,仅作免费音色增强选项 |
| OpenAI 兼容 | 在线 | 需 | POST `{baseURL}/v1/audio/speech`,填 key 即用,兼容 SiliconFlow/Groq/自建网关 |
| Azure Speech | 在线 | 需 | region + key,SSML 合成 |
| (扩展位) | — | — | 火山豆包 / 讯飞 / MiniMax,P1 按同接口接入 |

**默认引擎策略(兜底优先)**:出厂默认本地系统 TTS——零网络、零 key、永远可用,
先保证「能出声」;音色增强(edge-tts / 云端大模型)作为用户主动选择的升级项。

- key 存 `userData/data/settings.json`(明文,MVP;P1 迁移 macOS Keychain)
- 失败策略:单段重试 1 次 → 仍失败则暂停播放并提示,可一键切换引擎续播(文本从头重合成该段)

### 4.4 合成-播放流水线与进度同步(核心)

```
全书文本 --纠错/规范化--> 分段(句级,短句合并至 ≤120 字,超长硬切)
分段是【高亮 / 歌词 / 进度 / 缓存】的最小单位

播放时(main 调度):
  队列保证 [当前段, +3] 预合成完毕(缓存命中直接回,未命中调引擎)
  → audio-ready 事件(buffer base64 + durationMs)推给主窗 <audio>
  → 段播完无缝续播下一段(预合成掩盖合成延迟)
  → timeupdate 每 ~250ms 产生 tick(segIdx, 段内偏移, 当前句文本)
     main 汇聚 → 广播歌词窗 / 托盘 ticker / 状态栏面板
  → 阅读器收到 segIdx 变化:高亮新段 + 滚动居中

反向驱动(seek = 快进/快退):**双击任意段落** / 右键「从此处播放」/ 书签跳转
  → seek-seg(segIdx) → 从该段重排队列(单击仅选中,不触发播放)
缓存:key = md5(engine|voice|rate|pitch|correctionVersion|text)
     存 userData/cache/tts/,LRU 上限可配(默认 500MB),重复收听零成本
```

### 4.5 桌面歌词窗

- BrowserWindow:`transparent + frame:false + hasShadow:false + skipTaskbar + alwaysOnTop('screen-saver')`,尺寸约 720×96
- 拖动:CSS `-webkit-app-region: drag`;**锁定模式**:`setIgnoreMouseEvents(true, { forward: true })`,鼠标完全穿透,双击托盘面板按钮或快捷键解锁
- 样式:单行 / 双行(上句淡灰小字 + 当前句渐变大字描边),字体/字号/颜色/背景条透明度可调,网易云风格
- hover 显示微型工具条(锁定 / 样式 / 关闭),离开自动隐藏

### 4.6 macOS 状态栏歌词

- `Tray` 图标(播放状态符号)+ `Tray.setTitle()` 实现 TickerTape 滚动:每 ~300ms 左移一个全角字符,循环当前句
- 局限明示:状态栏文本无法自定义字体样式,过长自动截断——与网易云 mac 版形态一致
- 点击托盘 → 弹出 `tray-panel`(约 260×150):两行歌词 + 播放控制 + 桌面歌词开关
- Windows 无托盘标题能力 → 状态栏歌词标记为 mac 专属,Windows 用户以桌面歌词为主(设置页文案明示)

### 4.7 纠错(轻微级别,双通道)

```
原始文本 ─┬─ 显示通道(开关):应用规则后用于阅读器渲染(改正显示)
          └─ 合成通道(常开):TTS 前必经 —— 内置多音字/易错词词典 + 用户规则
规则结构: { pattern, replacement, isRegex, scope: global | book:<id>, enabled }
```

- 只做**词级替换**(轻微级别),不做 AI 校对
- `correctionVersion` 参与缓存 key:规则变更后自动重合成受影响段落
- 规则管理页支持预览:输入样例文本 → 显示替换前后对比

### 4.8 书签

- 任意段落添加:`{ bookId, chapterIdx, segIdx, 节选文字, createdAt }`
- 书签列表一键跳转(联动 seek);每书另存 `lastPosition` 自动续读

### 4.9 使用统计

- 主进程统一埋点(每秒心跳聚合):听书秒数 / 阅读活跃秒数(阅读器前台且无屏保)/ 合成字符数 / 播放次数
- 按日聚合:`stats.json = { days: { "2026-11-06": { listenSec, readSec, chars, plays } } }`
- 30s 防抖落盘 + 退出时强制落盘;统计页用 ECharts(按需引入)展示今日/本周/本月柱状趋势 + 汇总卡片

### 4.10 护眼与整点提醒(默认开启)

```
主进程计时器(active = 应用前台 且 [阅读器打开 或 播放中];最小化/暂停则挂起):
├─ 20-20-20: 累计 active 每 20 分钟(可配)→ 全屏遮罩浮层 20 秒倒计时(可跳过)
│             + 可选系统通知("看看 20 英尺外,休息 20 秒")
└─ 整点提示: 本地时间跨整点 → 右下角轻 toast + chime 提示音(音量可调,不打断播放)
设置: reminder.eye {enabled:true, intervalMin:20, restSec:20} / reminder.chime {enabled:true, volume:0.5}
```

### 4.11 全局快捷键(P1)

`播放/暂停`、`上一段/下一段`、`桌面歌词开关`、`歌词锁定切换`;冲突检测 + 自定义改键。

### 4.12 存储分层(渲染层 IndexedDB + OPFS,localStorage 只存小数据)

> 【M5 架构调整】章节正文存储已从渲染层 OPFS 迁回**主进程 userData/chapters/**(fs 管理):
> OPFS 在多窗口共享环境下持续出现 InvalidStateError(句柄状态失效),且打包 file:// 存在
> 兼容风险。章节正文读写经 IPC(read-chapter / append-chapters / remove-chapter),
> 主进程原子完成文件写、manifest 重排与 books.json 元数据同步。OPFS 现仅用于 TTS 音频缓存。

| 数据 | 位置 | 理由 |
|------|------|------|
| UI 偏好/最近打开/窗口位置 | **localStorage** | 只放小数据,同步读、零成本 |
| TTS 缓存索引(hash → 文件、大小、LRU 元数据) | **IndexedDB** | 结构化索引,异步事务,主窗/歌词窗共享 |
| TTS 合成音频 | **OPFS**(navigator.storage.getDirectory) | 大文件流式读写 |
| 书库元数据、书签、纠错规则、设置、统计 | **主进程 JSON**(userData/data/*.json) | 数据量小;需主进程调度(提醒/统计/托盘)与原子写保护 |
| **章节正文**(M5 起迁出 OPFS) | **主进程文件**(userData/chapters/<bookId>/) | fs 直读直写稳定可靠;单章文件小(KB 级),IPC 成本可忽略 |

- OPFS 读写封装为统一 `vfs.js`(渲染层),IndexedDB 只存指向 OPFS 文件的索引记录,二者生命周期绑定(删索引必删文件)
- JSON 侧:内存单例 + 30s 防抖 + 退出 flush,原子写(tmp + rename)防写坏

### 4.13 配置导出/导入

- **导出**:设置页一键导出,范围可选(☐ 全部设置 ☐ 纠错规则 ☐ 书签),生成带 schema 版本的 `clear-sound-config-YYYYMMDD.json`
- **导入**:选择文件 → schema/版本校验 → 预览差异(将被覆盖的项)→ 冲突策略(覆盖/跳过)→ 应用
- 即时生效:样式热更;纠错规则变更 → `correctionVersion` 变化 → 受影响段落自动重合成
- 安全:导出文件中 `apiKey` 类字段**默认脱敏**(留空),导入含 key 的文件时二次确认才写入

### 4.14 网页正文抓取导入(MVP)

- 入口:书架 [+ 导入 ▾] → 「网页链接」,粘贴 URL
- 抓取:**主进程 fetch**(跟随重定向、UA、10s 超时)——主进程只当网络代理,规避渲染层 CORS
- 抽取:HTML 交渲染层 `DOMParser` + **@mozilla/readability**(Firefox 阅读模式同款)抽标题/正文 → 清洗 → 进入既有导入管线成书(单章,段落软分节)
- 元数据记录 `sourceUrl`;书架右键「重新抓取」→ 拉最新内容覆盖正文,**阅读进度保留**
- 边界:泛书源(站点搜索+自定义规则)不做,反爬维护成本高;抓取失败(403/验证码)明确报错

### 4.15 多语言(中/英)与品牌

- vue-i18n,词条位于 `src/locales/{zh-CN,en-US}.js`;语言在设置页切换,偏好存 localStorage(UI 小数据,符合 §4.12 分层),默认跟随系统语言(zh 前缀 → zh-CN,否则 en-US)
- 品牌名「清声书坊」以艺术字渲染:楷体系字体栈(Kaiti SC / STKaiti)+ 渐变描色,作为品牌标识**不随语言翻译**;英文界面下品牌字保留,辅以副标 "Clear Sound"

### 4.16 界面主题(夜间模式)

- 三态:`auto(跟随系统,默认)/ light / dark`,偏好存 localStorage(UI 小数据)
- auto 模式渲染层用 `matchMedia('(prefers-color-scheme: dark)')` 监听系统切换实时跟随,无需主进程参与
- 实现:根节点 `html[data-theme="light|dark"]` + CSS 变量切换;Element Plus 引入官方 `dark/css-vars.css` 联动(`html.dark` 类)
- 阅读器背景主题(白/羊皮纸/护眼绿/暗黑/自定义)是**阅读内容主题**,与界面主题相互独立:界面深色时阅读区仍可白底(主流阅读软件行为)

---

## 5. 数据模型(分层存储)

```
── 主进程 userData/data/*.json(原子写 + 30s 防抖 + 退出 flush)──
books.json      [{ id, title, author?, format, filePath(OPFS 引用), encoding,
                   chapters: [{ idx, title, charOffset }],
                   wordCount, addedAt, lastPosition: {chapterIdx, segIdx} }]
bookmarks.json  [{ id, bookId, chapterIdx, segIdx, excerpt, createdAt }]
corrections.json [{ id, pattern, replacement, isRegex, scope, enabled }]
settings.json   { reader: { fontFamily, fontSize, lineHeight, letterSpacing,
                            margin, theme, autoScroll: {enabled, speed} },
                  tts: { engine, engines: { openai: {baseURL, apiKey, model, voice},
                                           azure: {region, apiKey, voice}, ... },
                         rate, pitch, volume, prefetch: 3 },
                  lyrics: { desktop: {enabled, style, position, locked},
                            statusBar: {enabled, tickerSpeed} },
                  reminder: { eye: {enabled, intervalMin, restSec},
                              chime: {enabled, volume} },
                  hotkeys: {...} }
stats.json      { days: { "YYYY-MM-DD": { listenSec, readSec, chars, plays } } }

── 渲染层 OPFS(大内容)+ IndexedDB(索引)──
opfs:library/<id>.<ext>      # 书籍原文副本
opfs:chapters/<bookId>/<chapterIdx>.json   # 章节解析后的段落数组缓存
opfs:tts/<hash>.<ext>        # 合成音频缓存
idb: segIndex    { key: bookId:chapterIdx → { segCount, file, updatedAt } }
idb: ttsIndex    { key: hash → { engine, voice, file, bytes, lastUsed } }  # LRU

── 渲染层 localStorage(仅小数据)──
ui-prefs / last-open / window-state
```

---

## 6. 目录结构(结合 gx-remote-ui + gx-remote-desk)

```
clear-sound/
├─ electron/                      # 主进程(vite-plugin-electron 编译到 dist-electron/)
│  ├─ index.js                    # 入口:app 生命周期、IPC 路由注册
│  ├─ windows.js                  # 主窗/歌词窗/托盘面板窗创建与关系
│  ├─ tray.js                     # 托盘 + 状态栏歌词 ticker(mac)
│  ├─ hotkeys.js                  # 全局快捷键
│  ├─ tts/
│  │  ├─ index.js                 # 调度器:队列/预合成/缓存/事件
│  │  └─ engines/                 # edge.js / say.js / sapi.js / openai.js / azure.js
│  ├─ library/                    # import.js / parser(txt|md|epub) / web-import.js / encoding.js / segment.js
│  ├─ corrections.js              # 纠错规则引擎(双通道)
│  ├─ stats.js                    # 使用统计聚合
│  ├─ reminders.js                # 20-20-20 / 整点调度
│  ├─ store.js                    # JSON 存储单例(原子写/防抖)
│  └─ preload.js                  # contextBridge 暴露类型化 API(gx-remote-desk 模式)
├─ src/
│  ├─ main/                       # 主窗入口(书架/阅读器/统计/设置 views)
│  ├─ lyrics/                     # 歌词窗入口
│  ├─ tray-panel/                 # 托盘面板入口
│  ├─ components/                 # 通用组件(播放控制条/虚拟滚动/主题…)
│  ├─ locales/                    # i18n 词条(zh-CN / en-US),语言偏好存 localStorage
│  ├─ stores/                     # Pinia(books/player/settings/stats)
│  ├─ utils/  └─ styles/
├─ index.html  lyrics.html  tray-panel.html   # 多页入口
├─ eslint.config.js               # 语法级校验(gx-remote-ui 策略)
├─ vite.config.js                 # 多页 + vite-plugin-electron
├─ electron-builder.json          # dmg / nsis / AppImage
└─ package.json                   # dev/build:mac|win|linux / lint
```

---

## 7. IPC 通道清单

| 前缀 | 方向 | 通道(举要) |
|------|------|-------------|
| library | R→M | import / import-url / refetch / list / remove / update-position |
| chapter | R→M | list(目录)/ read(chapterIdx → 段落数组) |
| tts | R→M | engines / voices / control(play·pause·next·prev·seekSeg·rate) |
| tts | M→R | audio-ready(segIdx, buffer, durationMs)/ error / state-changed |
| lyric | R→M | tick(播放进度,主窗发) |
| lyric | M→R | tick 广播 → 歌词窗 / 托盘面板;show / hide / setStyle / setLocked |
| tray | M→R | show-panel;R→M close-panel / toggle-desktop-lyrics |
| settings | R→M | get / set(部分字段即时生效:样式/歌词/提醒)/ export-config / import-config |
| bookmark | R→M | list / add / remove |
| correction | R→M | list / add / remove / preview |
| stats | R→M | summary / range |
| reminder | M→R | eye-rest / chime(触发浮层) |

安全:`contextIsolation: true`,`nodeIntegration: false`,preload 白名单暴露。

---

## 8. 里程碑计划(确认后按此推进)

| 阶段 | 内容 | 验收标准 |
|------|------|---------|
| M0 工程骨架 | 三窗口跑通、ESLint、vite-plugin-electron、打包链 | `npm run dev` 三窗齐开;`npm run lint` 可用 |
| M1 书库+阅读器 | 导入(txt/md/epub/网页 URL)、编码探测、目录、虚拟滚动、样式、自动翻页、进度记忆 | 10MB+ txt 导入流畅;网页 URL 成书;样式热更;重开续读 |
| M2 TTS 核心 | 引擎抽象、edge/say/openai、分段、预合成、播放同步高亮、缓存 | 播放时当前句高亮跟随;断句自然;二次播放命中缓存 |
| M3 歌词 | 桌面歌词窗(拖/锁/样式)、mac 状态栏 ticker + 面板、开关配置 | 歌词与语音进度同步;锁定后鼠标穿透 |
| M4 纠错+书签 | 规则管理、双通道、correctionVersion 缓存失效、书签 | 规则生效且重合成;书签跳转准确 |
| M5 统计+提醒 | 埋点、日/周/月视图、20-20-20、整点提示 | 时长统计准确;两提醒默认开、可关 |
| M6 设置+快捷键 | 设置面板整合、**配置导出/导入**、全局快捷键(P1)、引擎 key 管理 | 所有开关即时生效;配置导出→重装→导入可还原 |
| M7 打包打磨 | electron-builder 三平台、性能与文案打磨 | dmg 安装可用;文案清晰 |

每阶段完成后跑 `npm run lint` + 手动冒烟,再进入下一阶段。

### 9.1 M6 交付补充(2026-11)

**配置导出/导入**:导出文档 `{app,schema,exportedAt,settings,corrections?,bookmarks?}`,
引擎 `apiKey` 一律脱敏(导出计数提示「已省略 N 项密钥」),导入后即时生效
(调试开关 / 缓存上限 / 全局快捷键)。组装与校验抽到 `electron/config-transfer.js`
纯逻辑模块,便于脱离 Electron 单测。

**全局快捷键**:播放暂停 / 下一句 / 上一句 / 桌面歌词,快捷键存 `settings.json`,
主进程启动时重新注册,冲突返回失败明细。

**引擎 key 管理**:设置页填 baseURL / apiKey / model / voice,合成时随
`tts:synthesize` 下发(否则填了 key 也不生效)。

**调试日志**:统一落 `userData/data/debug-log.json`,**上限 60 条,超出自动淘汰最早的**;
记录操作日志(导入/导出/编辑/删除/播放/设置变更)+ 控制台报错(渲染层
`window error` / `unhandledrejection` / `console.error`;主进程 `console.error` /
`console.warn` / `uncaughtException` / `unhandledRejection`)。
设置页可**复制调试信息** / 清空 / 查看条数。日志开关 `settings.debug.enabled` 即时生效。

### 9.2 数据可靠性与界面修正(2026-11)

**数据目录固定**:新增 `electron/data-dir.js`,数据根目录固定为 `appData/clear-sound`。
此前用「多候选探测 + temp 回退」,探测结果随启动环境漂移 → 数据散落多个目录
(用户在书架上「书不见了」,落在 temp 的那一份还会被系统清理 = 永久丢失)。
现启动时自动迁移旧目录数据,并修复孤儿章节目录。

**register 双 UUID**:`library:register` 新建模式曾生成两次不同 UUID ——
正文写进 `chapters/<A>/`、书库记 `<B>` → 目录能识别但正文永远读不到。
现正文落盘与书库记录共用同一 `finalId`。

**应用菜单本地化**:新增 `electron/app-menu.js`。此前从未设置 application menu,
macOS 菜单栏一直是 Electron 默认英文菜单(不随应用语言变化)。
现按语言重建菜单,渲染层通过 `app:set-locale` 通知。

**阅读器 KeepAlive**:`router-view` 缓存 ReaderView,切到统计/设置再切回时
阅读进度与滚动位置不丢。

**目录手风琴**:章节管理页 >100 章时按 100 章一组折叠(0~100 / 100~200 …),
同一时刻只渲染一组,避免上千章一次性渲染拖垮界面。



---

## 9. 决策记录(已确认)

1. **内容源**:本地导入(txt/md/epub)+ **网页 URL 正文抓取导入**(MVP,需求 #20);泛书源不做(P2)。
2. **默认 TTS 引擎:本地系统 TTS**(mac say / win SAPI)——零网络零 key 开箱即用,兜底优先;edge-tts 为免费音色选项(非官方可能失效),OpenAI 兼容/Azure 填 key 高音质。
3. **语言**:JavaScript + JSDoc,不引入 TypeScript。
4. **key 明文存本地 JSON**(已确认接受);统计图表 **ECharts 按需引入**(已确认)。
5. Windows 状态栏歌词受系统限制,标注 mac 专属。
