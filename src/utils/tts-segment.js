/**
 * tts-segment.js —— 句级分段器(渲染层)
 *
 * 依据 docs/PLAN.md §4.4「合成-播放流水线与进度同步」:
 *  分段是【高亮 / 歌词 / 进度 / 缓存】的最小单位,粒度为「句级」:
 *   1) 段内按句终符切句(。！？!?；;…… 与换行);
 *      引号后置句读(如 `“走吧”。`)归入前一句,不单独成句;
 *   2) 短句(< 8 字)不单独成段,并入相邻句(优先并入前一句);
 *   3) 累计合并结果不超过 120 字(合并上限;单句本身可更长);
 *   4) 单句超 200 字按标点 / 字数硬切;
 *  分段不跨段落 → 每段归属唯一 paraIdx(阅读器高亮定位用)。
 *
 * segIdx 为「全书章内连续」序号(整章从 0 开始连续编号),
 * 便于主进程/歌词窗按整章索引定位;paraIdx 记录该段所属段落序号。
 */

/** 段内合并上限(字)——累计合并结果不得超过此长度 */
export const MAX_SEG_CHARS = 120

/** 短句阈值:长度小于此值的句子不单独成段,必须并入相邻句 */
export const MIN_SEG_CHARS = 8

/** 单句硬切阈值:超过此长度的句子按标点 / 字数硬切 */
export const HARD_SPLIT_CHARS = 200

/** 句终符集合(不含 '.';句点需结合上下文判定,见 isSentenceEnderAt) */
const ENDER_SET = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n', '\r'])

/** 收尾符号(右引号 / 右括号)——句读后置时归入前一句 */
const CLOSER_SET = new Set([
  '”', '’', '"', "'",
  '」', '』', '）', ')', '》', '】', ']', '›', '»',
])

/** 硬切时可用的次级标点(从后往前找,越靠后越优先) */
const SOFT_BREAK_SET = new Set(['，', ',', '、', '；', ';', '：', ':', ' '])

/**
 * 常见英文缩写(句点后不切句)
 * 例:'Mr. Smith'、'etc.' 里的句点属于词内,不应作为句读
 */
const ABBREV_SET = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc',
  'fig', 'vol', 'ch', 'pp', 'no', 'al', 'inc', 'ltd', 'co', 'dept', 'est',
  'min', 'max', 'approx', 'eg', 'ie',
])

/**
 * 判断字符是否属于 CJK(含中文标点 / 全角 / 假名)
 * @param {string} ch 单字符
 * @returns {boolean}
 */
function isCjkChar(ch) {
  if (!ch) return false
  const code = ch.codePointAt(0)
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // 基本汉字
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x3000 && code <= 0x303f) || // CJK 标点
    (code >= 0xff00 && code <= 0xffef) || // 全角形式
    (code >= 0x3040 && code <= 0x30ff) // 假名 / 部分 CJK 符号
  )
}

/**
 * 拼接两段文本:中日韩文本直接相连,西文之间补一个空格
 * @param {string} a 前段
 * @param {string} b 后段
 * @returns {string}
 */
function joinPieces(a, b) {
  if (!a) return b
  if (!b) return a
  const last = a[a.length - 1]
  const first = b[0]
  if (isCjkChar(last) || isCjkChar(first)) return a + b
  return `${a} ${b}`
}

/**
 * 归一化空白:换行 / 制表符折叠为单个空格,首尾去白
 * @param {string} s 原始文本
 * @returns {string}
 */
function normalizeWs(s) {
  return String(s == null ? '' : s)
    .replace(/[\r\n\t ]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/**
 * 判断某位置是否为句终符
 * 英文句点 '.' 仅在其后为空白 / 结尾 / 收尾符号时才算句终(避免 3.14、Mr. 误切)
 * @param {string} s 全文
 * @param {number} i 位置
 * @returns {boolean}
 */
function isSentenceEnderAt(s, i) {
  const ch = s[i]
  if (ch === '.') {
    const next = s[i + 1]
    if (!(next === undefined || /\s/.test(next) || CLOSER_SET.has(next))) return false
    // 英文缩写(Mr. / etc.)的句点属于词内 → 不切句
    const m = /([A-Za-z]+)$/.exec(s.slice(0, i))
    if (m && ABBREV_SET.has(m[1].toLowerCase())) return false
    return true
  }
  return ENDER_SET.has(ch)
}

/**
 * 判断某位置是否为收尾符号(右引号 / 右括号)
 * @param {string} ch 单字符
 * @returns {boolean}
 */
function isCloserChar(ch) {
  return CLOSER_SET.has(ch)
}

/**
 * 从句终符之后连续吞掉收尾符号与句终符
 * (处理 `。”`、`？！`、`……”` 这类成组出现的句读)
 * @param {string} s 全文
 * @param {number} from 起始位置(已越过句终符)
 * @returns {number} 句子结束位置(不含)
 */
function consumeTail(s, from) {
  const len = s.length
  let end = from
  while (end < len) {
    const ch = s[end]
    if (isCloserChar(ch)) {
      end += 1
      continue
    }
    if (isSentenceEnderAt(s, end)) {
      end += 1
      continue
    }
    break
  }
  return end
}

/**
 * 把一段文字切成句子
 * @param {string} text 段落文本
 * @returns {string[]} 句子数组(已去空白,空句跳过)
 */
export function splitSentences(text) {
  const s = String(text == null ? '' : text)
  const out = []
  const len = s.length
  let start = 0
  let i = 0
  while (i < len) {
    const ch = s[i]
    let boundaryEnd = -1
    if (isSentenceEnderAt(s, i)) {
      // 句读收尾(引号后的句读)一并归入本句
      boundaryEnd = consumeTail(s, i + 1)
    } else if (isCloserChar(ch)) {
      // 收尾符号后紧跟句读 → 句读归入前一句(不在此处断句)
      let j = i
      while (j < len && isCloserChar(s[j])) j += 1
      if (j > i && j < len && isSentenceEnderAt(s, j)) {
        boundaryEnd = consumeTail(s, j + 1)
      }
    }
    if (boundaryEnd >= 0) {
      const piece = normalizeWs(s.slice(start, boundaryEnd))
      if (piece) out.push(piece)
      start = boundaryEnd
      i = boundaryEnd
    } else {
      i += 1
    }
  }
  const tail = normalizeWs(s.slice(start))
  if (tail) out.push(tail)
  return out
}

/**
 * 单句硬切:超长句按次级标点切,无标点则按字数硬切
 * @param {string} sentence 句子
 * @param {number} [limit] 单块上限
 * @returns {string[]} 切分结果
 */
export function hardSplit(sentence, limit = HARD_SPLIT_CHARS) {
  const s = String(sentence == null ? '' : sentence)
  const pieces = []
  let rest = s
  while (rest.length > limit) {
    let cut = -1
    for (let i = limit - 1; i > 0; i -= 1) {
      if (SOFT_BREAK_SET.has(rest[i])) {
        cut = i + 1
        break
      }
    }
    if (cut <= 0) cut = limit
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) pieces.push(rest)
  return pieces
}

/**
 * 句合并:短句并入相邻句,累计合并不超过 MAX_SEG_CHARS
 *
 * 规则:
 *  M1 当前句过短(< MIN) → 必须并入相邻句:
 *     优先并入前一组(合并后 ≤ 上限时);
 *     否则前向合并(另起一组,由下一轮「前组过短」规则吸收后续句);
 *     末句且无前向伙伴时并入前一组(溢出 ≤ 7 字,保证不出现孤立短段)。
 *  M2 前一组过短(< MIN) → 必须吸收当前句:
 *     合并后 ≤ 上限则合并;超限则拆分当前句使其适配(余下部分另起组)。
 *  两条都不触发时,当前句独立成组(句级粒度)。
 *
 * @param {string[]} sentences 句子数组
 * @returns {string[]} 合并后的分组
 */
export function mergeSentences(sentences) {
  const list = (Array.isArray(sentences) ? sentences : []).filter((s) => !!s)
  const groups = []
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i]
    if (groups.length === 0) {
      groups.push(s)
      continue
    }
    const prev = groups[groups.length - 1]
    const prevShort = prev.length < MIN_SEG_CHARS
    const curShort = s.length < MIN_SEG_CHARS
    if (!prevShort && !curShort) {
      groups.push(s)
      continue
    }
    if (prev.length + s.length <= MAX_SEG_CHARS) {
      groups[groups.length - 1] = joinPieces(prev, s)
      continue
    }
    if (prevShort) {
      // M2:前组过短 → 拆当前句以适配合并上限
      const room = Math.max(1, MAX_SEG_CHARS - prev.length - 1)
      const parts = hardSplit(s, room)
      groups[groups.length - 1] = joinPieces(prev, parts[0])
      for (let k = 1; k < parts.length; k += 1) groups.push(parts[k])
      continue
    }
    // M1:当前句过短且前组已很长 → 前向合并
    if (i + 1 < list.length) {
      groups.push(s)
      continue
    }
    groups[groups.length - 1] = joinPieces(prev, s)
  }
  // 收尾:末组仍过短且存在前组 → 并入前组,避免出现孤立短段
  // (允许最多 MIN-1 字溢出:「短句必须并入相邻句」优先于 120 字上限)
  if (groups.length >= 2) {
    const last = groups[groups.length - 1]
    if (last.length < MIN_SEG_CHARS) {
      groups[groups.length - 2] = joinPieces(groups[groups.length - 2], last)
      groups.pop()
    }
  }
  return groups
}

/**
 * 把一章的段落数组切成句级分段
 * @param {string[]} paragraphs 段落数组(章内顺序)
 * @returns {{segIdx: number, paraIdx: number, text: string}[]}
 *   segIdx 章内连续;paraIdx 所属段落序号;空段落 / 空句跳过
 */
export function segmentParagraphs(paragraphs) {
  const list = Array.isArray(paragraphs) ? paragraphs : []
  const out = []
  for (let paraIdx = 0; paraIdx < list.length; paraIdx += 1) {
    const raw = list[paraIdx]
    if (raw == null) continue
    const text = String(raw)
    if (!text.trim()) continue // 空段跳过
    const sentences = splitSentences(text)
    if (!sentences.length) continue
    // 逐句硬切(单句 > 200 字),再按短句规则合并
    const pieces = []
    for (const sentence of sentences) {
      for (const piece of hardSplit(sentence)) {
        if (piece) pieces.push(piece)
      }
    }
    const groups = mergeSentences(pieces)
    for (const group of groups) {
      const seg = group.trim()
      if (!seg) continue
      out.push({ segIdx: out.length, paraIdx, text: seg })
    }
  }
  return out
}

export default segmentParagraphs
