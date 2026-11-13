const chardet = require('chardet')
const iconv = require('iconv-lite')

/**
 * 编码探测与解码(PLAN §4.1):
 *  1. UTF-8 BOM → 快速路径,直接 utf8 解码
 *  2. 其余 → chardet 仅探测前 64KB,再用 iconv-lite 解码
 *  3. 解码异常 → 兜底 utf-8
 */

/** chardet 探测样本大小:64KB */
const DETECT_SAMPLE_BYTES = 64 * 1024

/** 允许使用的编码白名单(中英日 + utf8),超出则回落 utf-8 */
const ALLOWED_ENCODINGS = new Set([
  'UTF-8',
  'UTF8',
  'UTF-16LE',
  'UTF-16BE',
  'GB18030',
  'GBK',
  'GB-2312',
  'BIG5',
  'BIG-5',
  'EUC-JP',
  'SHIFT_JIS',
  'ISO-8859-1',
  'WINDOWS-1252',
  'ASCII',
])

/**
 * chardet 探测结果 → iconv-lite 可用的编码名
 * @param {string|null} detected chardet 返回的编码名
 * @returns {string}
 */
function normalizeEncoding(detected) {
  if (!detected) return 'UTF-8'
  const upper = String(detected).toUpperCase()
  if (upper === 'UTF-8' || upper === 'UTF8') return 'UTF-8'
  if (upper === 'GB18030') return 'GB18030'
  if (upper === 'GBK' || upper === 'GB-2312' || upper === 'GB2312') return 'GBK'
  if (upper === 'BIG5' || upper === 'BIG-5' || upper === 'BIG-FIVE') return 'BIG5'
  if (upper === 'UTF-16LE' || upper === 'UTF16LE') return 'UTF-16LE'
  if (upper === 'UTF-16BE' || upper === 'UTF16BE') return 'UTF-16BE'
  if (upper === 'ISO-8859-1' || upper === 'LATIN1' || upper === 'WINDOWS-1252') return 'ISO-8859-1'
  if (upper === 'ASCII') return 'UTF-8'
  if (upper === 'EUC-JP') return 'EUC-JP'
  if (upper === 'SHIFT_JIS' || upper === 'SHIFT-JIS' || upper === 'SJIS') return 'SHIFT_JIS'
  return 'UTF-8'
}

/**
 * 检测并解码缓冲区
 * @param {Buffer|Uint8Array|ArrayBuffer} input 原始字节
 * @returns {{encoding: string, text: string}} encoding 为归一化后的编码名
 */
function detectAndDecode(input) {
  let buffer
  if (input instanceof ArrayBuffer) buffer = Buffer.from(input)
  else if (ArrayBuffer.isView(input)) buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  else if (typeof input === 'string') buffer = Buffer.from(input, 'utf8')
  else buffer = Buffer.from(input || [])

  if (buffer.length === 0) {
    return { encoding: 'UTF-8', text: '' }
  }

  // 1. UTF-8 BOM 快速路径
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: 'UTF-8', text: buffer.slice(3).toString('utf8') }
  }
  // UTF-16 BOM 快速路径
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { encoding: 'UTF-16LE', text: buffer.slice(2).toString('utf16le') }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { encoding: 'UTF-16BE', text: swap16(buffer.slice(2)).toString('utf16le') }
  }

  // 2. chardet 探测(仅前 64KB)
  let detected = null
  try {
    const sample = buffer.length > DETECT_SAMPLE_BYTES ? buffer.slice(0, DETECT_SAMPLE_BYTES) : buffer
    detected = chardet.detect(sample)
  } catch {
    detected = null
  }

  const encoding = normalizeEncoding(detected)
  if (!ALLOWED_ENCODINGS.has(encoding)) {
    // 白名单外的探测结果统一回落 utf-8
    return decodeWith(encoding === 'UTF-8' ? 'UTF-8' : 'UTF-8', buffer)
  }

  return decodeWith(encoding, buffer)
}

/**
 * 按指定编码解码,异常兜底 utf-8
 * @param {string} encoding
 * @param {Buffer} buffer
 * @returns {{encoding: string, text: string}}
 */
function decodeWith(encoding, buffer) {
  try {
    if (encoding === 'UTF-8') {
      return { encoding: 'UTF-8', text: buffer.toString('utf8') }
    }
    if (!iconv.encodingExists(encoding)) {
      return { encoding: 'UTF-8', text: buffer.toString('utf8') }
    }
    return { encoding, text: iconv.decode(buffer, encoding) }
  } catch {
    return { encoding: 'UTF-8', text: buffer.toString('utf8') }
  }
}

/**
 * 交换每两个字节的高低位(UTF-16BE → UTF-16LE)
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function swap16(buf) {
  const out = Buffer.allocUnsafe(buf.length - (buf.length % 2))
  for (let i = 0; i + 1 < out.length; i += 2) {
    out[i] = buf[i + 1]
    out[i + 1] = buf[i]
  }
  return out
}

module.exports = { detectAndDecode, normalizeEncoding, DETECT_SAMPLE_BYTES }
