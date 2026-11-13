/**
 * book-title.js —— 书名清洗
 *
 * 用户导入的文件名常带「书名号」与装饰符号,例如:
 *   《遮天》（精校版全本）作者：辰东   ← 首字符是《,在目录/书卡片里很突兀
 *   【全集】红楼梦
 *
 * 这里把书名里的**书名号与装饰符号**去掉,只保留可读文字:
 *   《遮天》（精校版全本）作者：辰东 → 遮天（精校版全本）作者：辰东
 *   【全集】红楼梦                  → 红楼梦
 *
 * 只处理书名号的**成对符号**与首尾装饰;书名内部的正常标点(如「作者：辰东」)保留。
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

/**
 * 清洗书名:去掉书名号与首尾装饰符号,压缩空白。
 *
 * @param {unknown} title 原始书名
 * @returns {string} 清洗后的书名(空则返回空串)
 */
export function cleanBookTitle(title) {
  if (title == null) return ''
  let text = String(title)

  // 成对符号:连同内部内容一起移除(如《遮天》→遮天)
  for (const [open, close] of PAIRED_DECORATIONS) {
    text = text.split(open).join('').split(close).join('')
  }

  // 首尾残留的单个书名号/装饰符号
  text = text.replace(/^[《》〈〉【】〔〕〖〗「」『』\s]+/, '')
  text = text.replace(/[《》〈〉【】〔〕〖〗「」『』\s]+$/, '')

  // 压缩多余空白
  text = text.replace(/\s{2,}/g, ' ').trim()

  return text
}

/**
 * 清洗书名,空则回落到给定默认名。
 * @param {unknown} title 原始书名
 * @param {string} [fallback] 为空时的默认名
 * @returns {string}
 */
export function cleanBookTitleOr(title, fallback = '') {
  const cleaned = cleanBookTitle(title)
  return cleaned || fallback
}

export default { cleanBookTitle, cleanBookTitleOr }
