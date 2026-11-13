/**
 * title.js —— 书名清洗(主进程 CJS 版)
 *
 * 导入的文件名常带「书名号」与装饰符号,例如:
 *   《遮天》（精校版全本）作者：辰东   ← 首字符是《,在书架/目录里很突兀
 *   【全集】红楼梦
 *
 * 这里把书名里的书名号与装饰符号去掉,只保留可读文字:
 *   《遮天》（精校版全本）作者：辰东 → 遮天（精校版全本）作者：辰东
 *
 * 成对符号连同内容一起移除;书名内部的正常标点(如「作者：辰东」)保留。
 *
 * 注意:渲染层有一份等价实现(src/utils/book-title.js,ESM),
 * 两份行为必须一致 —— 由 scripts 单测比对(见 docs/PLAN.md 的验收约定)。
 */

/** 成对的书名号/装饰符号(成对移除) */
const PAIRED_DECORATIONS = [
  ['《', '》'],
  ['〈', '〉'],
  ['【', '】'],
  ['〔', '〕'],
  ['〖', '〗'],
  ['「', '」'],
  ['『', '』'],
]

/** 首尾残留的单个书名号/装饰符号 */
const EDGE_DECORATION_RE = /^[《》〈〉【】〔〕〖〗「」『』\s]+/
const EDGE_DECORATION_RE_END = /[《》〈〉【】〔〕〖〗「」『』\s]+$/

/**
 * 清洗书名:去掉书名号与首尾装饰符号,压缩空白。
 * @param {unknown} raw 原始书名
 * @returns {string} 清洗后的书名(空则返回空串)
 */
function cleanBookTitle(raw) {
  if (raw == null) return ''
  let text = String(raw)
  for (const [open, close] of PAIRED_DECORATIONS) {
    text = text.split(open).join('').split(close).join('')
  }
  text = text.replace(EDGE_DECORATION_RE, '')
  text = text.replace(EDGE_DECORATION_RE_END, '')
  return text.replace(/\s{2,}/g, ' ').trim()
}

/**
 * 清洗书名,空则回落到默认名。
 * @param {unknown} raw 原始书名
 * @param {string} [fallback] 为空时的默认名
 * @returns {string}
 */
function cleanBookTitleOr(raw, fallback = '') {
  return cleanBookTitle(raw) || fallback
}

module.exports = { cleanBookTitle, cleanBookTitleOr, PAIRED_DECORATIONS }
