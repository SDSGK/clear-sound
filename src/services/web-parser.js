/**
 * web-parser.js —— 网页正文抽取(渲染层)
 *
 * 依据 docs/PLAN.md §4.14「网页正文抓取导入」:
 * 主进程只当网络代理(follow redirect / UA / 超时),HTML 交渲染层
 * DOMParser + @mozilla/readability(Firefox 阅读模式同款)抽标题/正文 → 清洗 → 进入既有导入管线成书。
 *
 * 输出 { title, paragraphs:[string] }:
 *  - title:Readability 抽到的标题,失败时用调用方给的兜底标题
 *  - paragraphs:正文段落数组(已 trim、已丢弃过短行)
 */

import { Readability } from '@mozilla/readability'

/** 正文元素选择器:标题 + 段落类块级元素 */
const CONTENT_SELECTOR = 'h1,h2,h3,h4,p,li,blockquote'

/** 短于该长度的文本行视为噪声(导航残留/空壳元素),丢弃 */
const MIN_LINE_LENGTH = 6

/** 降级切分:连续空行(2 个及以上换行)视为段落边界 */
const FALLBACK_SPLIT_RE = /\n{2,}/

/** 有效正文的最少段落数,不足即判定抽取失败 */
const MIN_PARAGRAPHS = 3

/**
 * 清洗单行文本:压缩空白(含换行)为单个空格并 trim
 * @param {string} text 原始 textContent
 * @returns {string}
 */
function cleanLine(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 判定是否为有效正文行(非空且不短于阈值)
 * @param {string} text 已清洗的文本
 * @returns {boolean}
 */
function isUsableLine(text) {
  return !!text && text.length >= MIN_LINE_LENGTH
}

/**
 * 抽取元素集合中的文本行
 * @param {ParentNode} root 查询根节点
 * @returns {string[]} 清洗后的有效行
 */
function collectLines(root) {
  const lines = []
  if (!root) return lines
  const nodes = root.querySelectorAll(CONTENT_SELECTOR)
  nodes.forEach((node) => {
    const text = cleanLine(node.textContent)
    if (isUsableLine(text)) lines.push(text)
  })
  return lines
}

/**
 * 从 Readability 抽出的 article HTML 片段里取段落
 * @param {string} contentHtml article HTML
 * @returns {string[]}
 */
function paragraphsFromArticleHtml(contentHtml) {
  if (!contentHtml) return []
  const doc = new DOMParser().parseFromString(String(contentHtml), 'text/html')
  return collectLines(doc.body || doc.documentElement)
}

/**
 * 降级路径:整篇纯文本按空行切段
 * @param {string} text 纯文本
 * @returns {string[]}
 */
function paragraphsFromPlainText(text) {
  if (!text) return []
  return String(text)
    .split(FALLBACK_SPLIT_RE)
    .map((part) => cleanLine(part))
    .filter(isUsableLine)
}

/**
 * 解析网页 HTML,抽出标题与正文段落
 *
 * @param {string} html 页面 HTML
 * @param {string} [fallbackTitle] Readability 抽不到标题时的兜底标题
 * @returns {{ title: string, paragraphs: string[] }}
 * @throws {Error} 抽取不到有效正文时抛 READABILITY_EMPTY
 */
export function parseWebHtml(html, fallbackTitle = '') {
  const source = String(html == null ? '' : html)
  const doc = new DOMParser().parseFromString(source, 'text/html')

  let article = null
  try {
    article = new Readability(doc).parse()
  } catch {
    // Readability 对超大文档会直接抛错(如元素数超限),视为抽取失败走降级
    article = null
  }

  const rawTitle = article && article.title ? String(article.title).trim() : ''
  const title = rawTitle || String(fallbackTitle == null ? '' : fallbackTitle).trim()

  // 主路径:article.content 重新解析后按块级元素抽段落
  let paragraphs = paragraphsFromArticleHtml(article ? article.content : '')

  // 降级:article.textContent 按空行切段
  if (paragraphs.length < MIN_PARAGRAPHS) {
    paragraphs = paragraphsFromPlainText(article ? article.textContent : '')
  }

  if (paragraphs.length < MIN_PARAGRAPHS) {
    throw new Error('READABILITY_EMPTY')
  }

  return { title, paragraphs }
}

export default parseWebHtml
