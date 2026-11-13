/**
 * 网页正文抓取代理(PLAN §4.14):
 * 主进程只当网络代理,规避渲染层 CORS。
 *  - 仅允许 http/https
 *  - 跟随重定向
 *  - UA 伪装桌面 Chrome
 *  - 10s 超时(AbortController)
 *  - 响应体上限 30MB
 *  - 失败抛可读错误
 */

/** 请求超时:10s */
const REQUEST_TIMEOUT_MS = 10 * 1000

/** 响应体上限:30MB */
const MAX_RESPONSE_BYTES = 30 * 1024 * 1024

/** 桌面 Chrome UA(避免站点对默认 UA 拦截) */
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 跟随重定向时的最大跳数 */
const MAX_REDIRECTS = 5

/** 允许的协议 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * 校验并规范化 URL
 * @param {string} url 原始 URL
 * @returns {URL}
 */
function normalizeUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) throw new Error('URL 不能为空')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`URL 格式非法:${raw}`)
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`仅支持 http/https 链接,当前为:${parsed.protocol}`)
  }
  return parsed
}

/**
 * 按字符集解码响应体(优先 UTF-8,其次 GB18030)
 * @param {Buffer} buffer
 * @param {string|null} contentType
 * @returns {string}
 */
function decodeBody(buffer, contentType) {
  const charsetMatch = /charset=["']?([\w-]+)/i.exec(String(contentType || ''))
  const charset = charsetMatch ? charsetMatch[1].toLowerCase() : ''
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    try {
      const iconv = require('iconv-lite')
      if (iconv.encodingExists(charset)) return iconv.decode(buffer, charset)
    } catch {
      // iconv 不可用则回落 utf-8
    }
  }
  return buffer.toString('utf8')
}

/**
 * 抓取网页正文 HTML
 * @param {string} url 目标 URL
 * @returns {Promise<{html: string, finalUrl: string}>}
 */
async function fetchPage(url) {
  const target = normalizeUrl(url)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(target.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': DESKTOP_CHROME_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
      },
    })

    if (!response.ok) {
      throw new Error(`抓取失败:HTTP ${response.status} ${response.statusText || ''}`.trim())
    }

    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new Error(
        `页面过大:${(contentLength / 1024 / 1024).toFixed(1)}MB,超过 ${MAX_RESPONSE_BYTES / 1024 / 1024}MB 上限`,
      )
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_RESPONSE_BYTES) {
      throw new Error(
        `页面过大:${(buffer.length / 1024 / 1024).toFixed(1)}MB,超过 ${MAX_RESPONSE_BYTES / 1024 / 1024}MB 上限`,
      )
    }

    const html = decodeBody(buffer, response.headers.get('content-type'))
    return { html, finalUrl: response.url || target.toString() }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`抓取超时:${REQUEST_TIMEOUT_MS / 1000}s 未响应(${target.host})`)
    }
    if (err && err.message && err.message.startsWith('抓取')) throw err
    throw new Error(`抓取失败:${err && err.message ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
}

module.exports = {
  fetchPage,
  normalizeUrl,
  REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_REDIRECTS,
  DESKTOP_CHROME_UA,
}
