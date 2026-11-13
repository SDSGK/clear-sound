const path = require('node:path')
const JSZip = require('jszip')
const { detectAndDecode } = require('./encoding')
const { cleanBookTitle } = require('./title')

/**
 * 书籍解析器(PLAN §4.1):txt / md / epub → 结构化章节段落。
 *
 * 统一输出:
 * {
 *   title: string,        // 文件名去扩展名
 *   format: 'txt'|'md'|'epub',
 *   encoding: string,
 *   chapters: [{ title: string, paragraphs: string[] }]  // 至少 1 章,段落均 trim 且非空
 * }
 */

/** 单章(无标题纯文本兜底)超过该字数按段落边界软分节 */
const SOFT_SECTION_CHARS = 8000

/** 中文数字 + 阿拉伯数字,用于「第 X 章」 */
const CN_NUM = '0-9０-９零〇一二三四五六七八九十百千万两'

/** txt 章节标题:第X章/回/卷/节/部/篇/集、Chapter n、CHAPTER n(大小写不敏感) */
const TXT_CHAPTER_RE = new RegExp(
  `^\\s*(?:第\\s*[${CN_NUM}]+\\s*[章回卷节部篇集]|(?:chapter)\\s*[0-9]+)`,
  'i',
)

/** md 章节标题:一级/二级标题 */
const MD_CHAPTER_RE = /^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/

/** HTML 常见命名实体 */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
}

/** 块级标签(切文本块用) */
const BLOCK_TAGS =
  'p|div|br|hr|h[1-6]|li|ul|ol|dl|dt|dd|tr|td|th|table|thead|tbody|tfoot|caption|section|article|aside|header|footer|nav|main|blockquote|pre|figure|figcaption|form|fieldset|address|dir|center'

// ============================================================
// 通用工具
// ============================================================

/**
 * 解码 HTML 实体(命名实体 + 十进制/十六进制数字实体)
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  if (!text) return ''
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code)
        } catch {
          return match
        }
      }
      return match
    }
    const key = body.toLowerCase()
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match
  })
}

/**
 * 合并段内多行:中文之间直接拼接,拉丁/数字之间补空格
 * @param {string[]} lines
 * @returns {string}
 */
function joinLines(lines) {
  let out = ''
  for (const line of lines) {
    const piece = line.trim()
    if (!piece) continue
    if (!out) {
      out = piece
      continue
    }
    const prevChar = out.charAt(out.length - 1)
    const nextChar = piece.charAt(0)
    const needSpace = /[A-Za-z0-9]/.test(prevChar) && /[A-Za-z0-9]/.test(nextChar)
    out += needSpace ? ` ${piece}` : piece
  }
  return out.trim()
}

/**
 * 按空行切段:连续空行切段,单换行合并到段内
 * @param {string} text
 * @returns {string[]}
 */
function splitParagraphs(text) {
  const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n+/)
  const out = []
  for (const block of blocks) {
    const paragraph = joinLines(block.split('\n'))
    if (paragraph) out.push(paragraph)
  }
  return out
}

/**
 * 去掉首尾装饰性括号
 * @param {string} text
 * @returns {string}
 */
function stripDecorativeBrackets(text) {
  return text
    .replace(/^[【〔「『(（《〈\s]+/, '')
    .replace(/[】〕」』)）》〉\s]+$/, '')
    .trim()
}

/**
 * epub 正文里的章节标记行:第X章 / 第X回 / 第X卷 …
 *
 * 不少 epub 是「单文件结构」——整本书塞在一个 xhtml 里(实测《遮天》epub
 * 就是 1 个 xhtml / 16 万段 / 632 万字),xhtml 里没有可用的 h1-h3 章题,
 * 真实章节名只以正文段落的形式出现(实测 1820 处「第002章 素问」这类)。
 * 按标记切分才能拿到真实章节名;只按字数软切只能得到「第 N 节(k/M)」。
 */
const EPUB_CHAPTER_RE = new RegExp(
  `^\\s*第\\s*[${CN_NUM}]+\\s*[章回卷节部篇集]\\s*[:：.．、,，\\-—]?\\s*(.*)$`,
)

/**
 * 按正文里的章节标记把段落切成章节。
 *
 * @param {string[]} paragraphs 该 xhtml 的全部正文段落
 * @returns {{title: string, paragraphs: string[]}[]|null} 切不出(标记 < 2 个)返回 null
 */
function splitEpubByChapterMarkers(paragraphs) {
  /** @type {{index: number, title: string}[]} */
  const marks = []
  paragraphs.forEach((p, index) => {
    const m = EPUB_CHAPTER_RE.exec(p)
    if (!m) return
    const rest = (m[1] || '').trim()
    // 标记后还跟着一大段文字 → 多半是正文里提到「第X章」的句子,不是章题
    if (rest.length > 40) return
    const title = p.trim().replace(/[:：.．、,，\s]+$/, '')
    marks.push({ index, title })
  })
  if (marks.length < 2) return null

  const chapters = []
  for (let k = 0; k < marks.length; k += 1) {
    const start = marks[k].index + 1
    const end = k + 1 < marks.length ? marks[k + 1].index : paragraphs.length
    const body = paragraphs.slice(start, end)
    if (body.length === 0) continue
    chapters.push({ title: marks[k].title, paragraphs: body })
  }
  if (chapters.length === 0) return null
  // 首个标记之前的内容(书名页/前言)并入第一章,避免凭空多出一章
  if (marks[0].index > 0) chapters[0].paragraphs = paragraphs.slice(0, marks[0].index).concat(chapters[0].paragraphs)
  return chapters
}

/**
 * epub 单章软切:章节正文过长时按段落边界切成多节,每节独立成文件。
 *
 * 背景:不少 epub 是「单文件结构」——整本书塞在一个 xhtml 里(实测《遮天》epub
 * 就是 1 个 xhtml / 16 万段 / 632 万字)。不切的话:
 *  1) 单个章节文件达 19MB,阅读时整文件 JSON.parse 会卡住主线程;
 *  2) 目录里只有一条,无法定位阅读位置。
 * 切分后每节独立成文件,读取轻快、目录可定位(对应 txt 路径的软分节行为)。
 *
 * @param {{title: string, paragraphs: string[]}} chapter 原始章节
 * @returns {{title: string, paragraphs: string[]}[]}
 */
function softSplitEpubChapter(chapter) {
  const parts = softSplitChapter(chapter)
  if (parts.length <= 1) return [chapter]
  const total = parts.length
  return parts.map((part, index) => ({
    title: `${chapter.title}(${index + 1}/${total})`,
    paragraphs: part.paragraphs,
  }))
}

/**
 * 从章节标题行提取标题:剔除「第X章 / Chapter n」等标题标记
 * @param {string} line 原始标题行
 * @param {string} marker 匹配到的标题标记前缀
 * @returns {string}
 */
function extractChapterTitle(line, marker) {
  const raw = line.trim()
  let rest = raw.slice(marker.length)
  rest = rest.replace(/^[\s:：.．、,，\-—~～·]+/u, '').trim()
  rest = rest.replace(/[。．.、,，:：]+$/u, '').trim()
  rest = stripDecorativeBrackets(rest)
  return rest || raw
}

/**
 * 章内总字数超阈值时按段落边界软分节
 * @param {{title: string, paragraphs: string[]}} chapter
 * @returns {{title: string, paragraphs: string[]}[]}
 */
function softSplitChapter(chapter) {
  const total = chapter.paragraphs.reduce((sum, p) => sum + p.length, 0)
  if (total <= SOFT_SECTION_CHARS || chapter.paragraphs.length === 0) return [chapter]
  const groups = []
  let current = []
  let currentLen = 0
  for (const paragraph of chapter.paragraphs) {
    if (currentLen > 0 && currentLen + paragraph.length > SOFT_SECTION_CHARS) {
      groups.push(current)
      current = []
      currentLen = 0
    }
    current.push(paragraph)
    currentLen += paragraph.length
  }
  if (current.length) groups.push(current)
  return groups.map((paragraphs, index) => ({ title: `第 ${index + 1} 节`, paragraphs }))
}

/**
 * 统一处理章节数组:trim/过滤空段 + 保证至少 1 章。
 *
 * 【修复】软分节不再在这里统一执行 —— 之前会把所有「识别出的章节」(含 md 标题章、
 * txt 第X章)按 2000 字再拆成「第 N 节」,导致正常章节被切碎。
 * 软分节只保留在 parseTxt 的「无标题纯文本单章兜底」分支内(那里没有章节结构,
 * 需要按阅读量切块);有明确章节标记的章保持原样,长章交给阅读器虚拟滚动处理。
 * @param {{title: string, paragraphs: string[]}[]} chapters
 * @returns {{title: string, paragraphs: string[]}[]}
 */
function finalizeChapters(chapters) {
  const result = []
  for (const chapter of chapters) {
    const paragraphs = (chapter.paragraphs || []).map((p) => String(p).trim()).filter(Boolean)
    if (paragraphs.length === 0) continue
    result.push({ title: chapter.title, paragraphs })
  }
  if (result.length === 0) result.push({ title: '正文', paragraphs: [] })
  return result
}

// ============================================================
// txt 解析
// ============================================================

/**
 * 解析纯文本
 * @param {string} text 解码后的正文
 * @param {string} bookTitle 书名(无扩展名)
 * @returns {{title: string, paragraphs: string[]}[]}
 */
function parseTxt(text, bookTitle) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')

  /** @type {{marker: string, line: string, lineIndex: number}[]} */
  const headings = []
  lines.forEach((line, lineIndex) => {
    const match = TXT_CHAPTER_RE.exec(line)
    if (match) headings.push({ marker: match[0], line, lineIndex })
  })

  // 识别 ≥2 章才分章,否则整本单章(无结构纯文本 → 按阅读量软分节)
  if (headings.length < 2) {
    return softSplitChapter({ title: bookTitle, paragraphs: splitParagraphs(text) })
  }

  const chapters = []
  for (let i = 0; i < headings.length; i += 1) {
    const start = headings[i].lineIndex + 1
    const end = i + 1 < headings.length ? headings[i + 1].lineIndex : lines.length
    const body = lines.slice(start, end).join('\n')
    chapters.push({
      title: extractChapterTitle(headings[i].line, headings[i].marker),
      paragraphs: splitParagraphs(body),
    })
  }

  // 首章之前的内容并入第一章,避免凭空多出一章
  const preamble = splitParagraphs(lines.slice(0, headings[0].lineIndex).join('\n'))
  if (preamble.length && chapters.length) {
    chapters[0].paragraphs = preamble.concat(chapters[0].paragraphs)
  }
  return chapters
}

// ============================================================
// md 解析
// ============================================================

/**
 * 剥离 markdown 标记(#、*、`、>、列表符、链接留文字)
 * @param {string} text
 * @returns {string}
 */
function stripMarkdown(text) {
  let out = String(text || '')

  // 代码围栏标记
  out = out.replace(/^\s*```.*$/gm, '')
  // 图片 → alt 文本
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 链接 → 链接文字
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 引用 / 列表 / 标题前缀
  out = out.replace(/^\s*>\s?/gm, '')
  out = out.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  // 分隔线
  out = out.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
  // 行内 HTML
  out = out.replace(/<\/?[a-z][^>]*>/gi, '')
  // 强调 / 删除线 / 行内代码
  out = out.replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
  out = out.replace(/~~([^~]*)~~/g, '$1')
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1')
  out = out.replace(/__([^_]+)__/g, '$1')
  out = out.replace(/\*([^*]+)\*/g, '$1')
  out = out.replace(/(^|[^\w])_([^_]+)_(?![^\w])/g, '$1$2')
  return out
}

/**
 * 解析 Markdown
 * @param {string} text
 * @param {string} bookTitle
 * @returns {{title: string, paragraphs: string[]}[]}
 */
function parseMarkdown(text, bookTitle) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')

  /** @type {{title: string, lineIndex: number}[]} */
  const headings = []
  lines.forEach((line, lineIndex) => {
    const match = MD_CHAPTER_RE.exec(line)
    if (match) headings.push({ title: stripDecorativeBrackets(match[1].trim()), lineIndex })
  })

  if (headings.length === 0) {
    return softSplitChapter({ title: bookTitle, paragraphs: splitParagraphs(stripMarkdown(text)) })
  }

  const chapters = []
  for (let i = 0; i < headings.length; i += 1) {
    const start = headings[i].lineIndex + 1
    const end = i + 1 < headings.length ? headings[i + 1].lineIndex : lines.length
    const body = stripMarkdown(lines.slice(start, end).join('\n'))
    chapters.push({ title: headings[i].title || `第 ${i + 1} 节`, paragraphs: splitParagraphs(body) })
  }

  const preamble = splitParagraphs(stripMarkdown(lines.slice(0, headings[0].lineIndex).join('\n')))
  if (preamble.length && chapters.length) {
    chapters[0].paragraphs = preamble.concat(chapters[0].paragraphs)
  }
  return chapters
}

// ============================================================
// epub 解析
// ============================================================

/**
 * 从 XHTML 中提取块级文本块
 * @param {string} html
 * @returns {string[]}
 */
function extractTextBlocks(html) {
  let source = String(html || '')
  source = source.replace(/<!--[\s\S]*?-->/g, ' ')
  source = source.replace(/<\?xml[\s\S]*?\?>/g, ' ')
  source = source.replace(/<!DOCTYPE[^>]*>/gi, ' ')
  source = source.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
  source = source.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
  source = source.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')
  // h1-h3 已单独作为章题提取,其内容不再重复进入正文块
  source = source.replace(/<h[1-3]\b[^>]*>[\s\S]*?<\/h[1-3]\s*>/gi, '\n')
  // 块级标签 → 换行,其余标签直接剥离
  source = source.replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
  source = source.replace(/<[^>]+>/g, '')
  source = decodeEntities(source)
  return source
    .split(/\n+/)
    .map((block) => block.replace(/[ \t 　]+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * 取 XHTML 中首个 h1-h3 作为章题
 * @param {string} html
 * @returns {string}
 */
function extractHeading(html) {
  const match = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/i.exec(String(html || ''))
  if (!match) return ''
  const text = decodeEntities(match[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  return stripDecorativeBrackets(text)
}

/**
 * 从 XML 属性中取值(兼容单/双引号)
 * @param {string} tag
 * @param {string} attr
 * @returns {string}
 */
function readAttr(tag, attr) {
  const re = new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')
  const match = re.exec(tag)
  if (!match) return ''
  return match[2] !== undefined ? match[2] : match[3] || ''
}

/**
 * 解析 epub
 * @param {Buffer} buffer epub 原始字节
 * @returns {Promise<{title: string, paragraphs: string[]}[]>}
 */
async function parseEpub(buffer) {
  const zip = await JSZip.loadAsync(buffer)

  // 1) container.xml → rootfile 路径
  const containerFile = zip.file('META-INF/container.xml')
  if (!containerFile) throw new Error('EPUB 缺少 META-INF/container.xml')
  const containerXml = await containerFile.async('string')
  const rootMatch = /<rootfile\b[^>]*>/i.exec(containerXml)
  if (!rootMatch) throw new Error('EPUB container.xml 中未找到 rootfile')
  const opfPath = decodeURIComponent(readAttr(rootMatch[0], 'full-path'))
  if (!opfPath) throw new Error('EPUB rootfile 缺少 full-path')

  // 2) opf → manifest + spine
  const opfFile = zip.file(opfPath)
  if (!opfFile) throw new Error(`EPUB 缺少 opf 文件:${opfPath}`)
  const opfXml = await opfFile.async('string')
  const opfDir = path.posix.dirname(opfPath)

  /** @type {Map<string, {href: string, type: string}>} */
  const manifest = new Map()
  const itemRe = /<item\b[^>]*>/gi
  let itemMatch = itemRe.exec(opfXml)
  while (itemMatch) {
    const tag = itemMatch[0]
    const id = readAttr(tag, 'id')
    const href = readAttr(tag, 'href')
    const type = readAttr(tag, 'media-type')
    if (id && href) manifest.set(id, { href, type })
    itemMatch = itemRe.exec(opfXml)
  }

  /** @type {string[]} */
  const spineOrder = []
  const refRe = /<itemref\b[^>]*>/gi
  let refMatch = refRe.exec(opfXml)
  while (refMatch) {
    const idref = readAttr(refMatch[0], 'idref')
    if (idref) spineOrder.push(idref)
    refMatch = refRe.exec(opfXml)
  }

  // 3) 组装阅读顺序:优先 spine,spine 为空则退回 manifest 顺序
  const ordered = []
  for (const idref of spineOrder) {
    const item = manifest.get(idref)
    if (item) ordered.push(item)
  }
  if (ordered.length === 0) {
    for (const item of manifest.values()) {
      if (/\.(x?html?|xml)$/i.test(item.href)) ordered.push(item)
    }
  }

  // 4) 逐个 xhtml 抽文本
  const chapters = []
  let index = 0
  for (const item of ordered) {
    index += 1
    const decodedHref = decodeURIComponent(item.href)
    const filePath = path.posix.normalize(path.posix.join(opfDir, decodedHref))
    const entry = zip.file(filePath) || zip.file(decodedHref)
    if (!entry) continue
    const html = await entry.async('string')
    const paragraphs = extractTextBlocks(html)
    if (paragraphs.length === 0) continue
    // 优先按正文里的章节标记切分(单文件 epub 的真实章节名只出现在正文段落中)
    const marked = splitEpubByChapterMarkers(paragraphs)
    if (marked) {
      chapters.push(...marked)
      continue
    }
    const title = extractHeading(html) || `第 ${index} 节`
    // 单文件 epub 的整本书会落在一章里 → 按段落边界切片,每节独立
    chapters.push(...softSplitEpubChapter({ title, paragraphs }))
  }

  if (chapters.length === 0) throw new Error('EPUB 未解析出任何正文')
  return chapters
}

// ============================================================
// 对外主入口
// ============================================================

/**
 * 由文件名推断格式
 * @param {string} fileName
 * @returns {'txt'|'md'|'epub'}
 */
function detectFormat(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase()
  if (ext === '.md' || ext === '.markdown' || ext === '.mdown') return 'md'
  if (ext === '.epub') return 'epub'
  return 'txt'
}

/**
 * 解析书籍
 * @param {{fileName?: string, buffer?: Buffer|Uint8Array|ArrayBuffer}} input
 * @returns {Promise<{title: string, format: string, encoding: string, chapters: {title: string, paragraphs: string[]}[]}>}
 */
async function parseBook(input = {}) {
  const fileName = String(input.fileName || '')
  const title = cleanBookTitle(path.basename(fileName, path.extname(fileName))) || '未知书籍'
  const format = detectFormat(fileName)

  let buffer
  if (input.buffer instanceof ArrayBuffer) buffer = Buffer.from(input.buffer)
  else if (ArrayBuffer.isView(input.buffer)) {
    buffer = Buffer.from(input.buffer.buffer, input.buffer.byteOffset, input.buffer.byteLength)
  } else buffer = Buffer.from(input.buffer || [])

  // 文件体积(字节):供书架展示「书的大小」
  const sizeBytes = buffer.length

  if (format === 'epub') {
    const chapters = await parseEpub(buffer)
    return {
      title,
      format: 'epub',
      encoding: 'UTF-8',
      sizeBytes,
      chapters: finalizeChapters(chapters),
    }
  }

  const { encoding, text } = detectAndDecode(buffer)
  const chapters = format === 'md' ? parseMarkdown(text, title) : parseTxt(text, title)
  return {
    title,
    format,
    encoding,
    sizeBytes,
    chapters: finalizeChapters(chapters),
  }
}

module.exports = {
  cleanBookTitle,
  softSplitEpubChapter,
  parseBook,
  parseTxt,
  parseMarkdown,
  parseEpub,
  decodeEntities,
  splitParagraphs,
  stripMarkdown,
  extractTextBlocks,
  SOFT_SECTION_CHARS,
}
