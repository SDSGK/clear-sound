/**
 * speech-text.js —— TTS 朗读文本清洗
 *
 * 背景:书正文常含引号/书名号/括号/markdown 残留/装饰符号,
 * 部分 TTS 引擎会把符号读成名称(如 " 读成「双引号」)。
 * 清洗只作用于合成文本:阅读器显示保留原文,朗读读干净。
 *
 * 注意:清洗必须在缓存 key 计算之前 —— key 用清洗后文本,
 * 含符号读法的旧缓存自动失效并重合成。
 */

/** 引号类(全角/半角/中文直角/法文):移除,对白语气由上下文承担 */
const QUOTES_RE = /["'\u2018\u2019\u201c\u201d\u300c\u300d\u300e\u300f\u00ab\u00bb]/g

/** 书名号与括号类:移除符号,保留括起来的内容 */
const BRACKETS_RE = /[\u300a\u300b\u3008\u3009\u3010\u3011\u3014\u3015\uff08\uff09()]/g

/** markdown 残留:行首标记(标题/引用/列表符) */
const MD_LINE_RE = /^[ \t]{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+)/gm

/** markdown 残留:成对强调与行内代码标记 */
const MD_INLINE_RE = /[*_`]+/g

/** 带圈数字(①-⑳)→ 普通数字 */
const CIRCLED_RE = /[\u2460-\u2473]/g

/** 装饰符号与 emoji 区段(不含中文标点区 3000-303F) */
const DECOR_RE = /[\u2600-\u27bf\u2b00-\u2bff\u2190-\u21ff\u2300-\u23ff\u25a0-\u25ff\ufe30-\ufe4f\u{1f000}-\u{1faff}]/gu

/**
 * 清洗朗读文本:移除引号/书名号/括号/markdown 残留/装饰符号,
 * 保留汉字、字母、数字与自然停顿标点(，。！？：；、…—)。
 * @param {string} text 原文本
 * @returns {string} 清洗后的合成文本
 */
export function cleanForSpeech(text) {
  let s = String(text || '')
  if (!s) return ''
  s = s.replace(MD_LINE_RE, '')
  s = s.replace(MD_INLINE_RE, '')
  s = s.replace(QUOTES_RE, '')
  s = s.replace(BRACKETS_RE, '')
  s = s.replace(CIRCLED_RE, (ch) => String(ch.charCodeAt(0) - 0x2460 + 1))
  s = s.replace(DECOR_RE, '')
  return s.replace(/[ \t]+/g, ' ').trim()
}

export default { cleanForSpeech }
