const crypto = require('node:crypto')
const { getUserStore } = require('./store')
const { logAction, logError } = require('./debug-log')

/**
 * corrections.js —— 纠错规则存储与 IPC(PLAN §4.7)
 *
 * corrections.json:{ version, rules: [{id, pattern, replacement, isRegex, scope, enabled}] }
 * scope:'global'(全部书籍)或 'book:<bookId>'(仅本书)。
 * 任何增删改都会使 version 自增 —— 渲染层把它计入合成缓存 key,规则变更即强制重合成。
 *
 * 通道:
 *  - correction:list   → {ok, version, rules}
 *  - correction:add    {pattern, replacement, isRegex, scope}   → {ok, rule, version}
 *  - correction:update {id, patch}                              → {ok, rule, version}
 *  - correction:remove {id}                                     → {ok, version}
 */

const CORRECTIONS_FILE = 'corrections.json'

const CORRECTION_CHANNELS = [
  'correction:list',
  'correction:add',
  'correction:update',
  'correction:remove',
]

function defaultDoc() {
  return { version: 1, rules: [] }
}

/** 读取文档(兼容损坏/历史格式) */
function loadDoc(store) {
  const raw = store.getRaw()
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return {
      version: Number.isFinite(raw.version) ? raw.version : 1,
      rules: Array.isArray(raw.rules) ? raw.rules : [],
    }
  }
  return defaultDoc()
}

/** 规则字段校验(新增与更新共用) */
function validateRule(rule) {
  const pattern = String(rule.pattern == null ? '' : rule.pattern)
  const replacement = String(rule.replacement == null ? '' : rule.replacement)
  if (!pattern.trim()) throw new Error('规则原文不能为空')
  if (!replacement.trim()) throw new Error('规则替换内容不能为空')
  if (rule.isRegex) {
    try {
      // 与渲染层一致,按全局替换语义编译
      new RegExp(pattern, 'g')
    } catch (err) {
      throw new Error(`正则表达式无效:${(err && err.message) || err}`)
    }
  }
  const scope = rule.scope || 'global'
  if (!/^(global|book:.+)$/.test(scope)) throw new Error('作用域不合法')
  rule.pattern = pattern
  rule.replacement = replacement
  rule.scope = scope
}

function createCorrectionsHandlers(deps = {}) {
  function getStore() {
    return deps.store || getUserStore(CORRECTIONS_FILE)
  }
  return {
    async 'correction:list'() {
      const doc = loadDoc(getStore())
      return { ok: true, version: doc.version, rules: doc.rules }
    },

    async 'correction:add'(payload = {}) {
      logAction('correction.add', `新增纠错规则「${payload.pattern}」→「${payload.replacement}」`)
      const rule = {
        id: crypto.randomUUID(),
        pattern: payload.pattern,
        replacement: payload.replacement,
        isRegex: !!payload.isRegex,
        scope: payload.scope || 'global',
        enabled: true,
      }
      validateRule(rule)
      const store = getStore()
      const doc = loadDoc(store)
      doc.rules.push(rule)
      doc.version += 1
      store.setRaw(doc)
      store.save()
      return { ok: true, rule, version: doc.version }
    },

    async 'correction:update'(payload = {}) {
      logAction('correction.update', `修改纠错规则 #${payload.id}`)
      const { id } = payload
      const patch = payload.patch || {}
      const store = getStore()
      const doc = loadDoc(store)
      const rule = doc.rules.find((r) => r && r.id === id)
      if (!rule) throw new Error('规则不存在')
      for (const key of ['pattern', 'replacement', 'isRegex', 'scope', 'enabled']) {
        if (key in patch) rule[key] = patch[key]
      }
      validateRule(rule)
      doc.version += 1
      store.setRaw(doc)
      store.save()
      return { ok: true, rule, version: doc.version }
    },

    async 'correction:remove'(payload = {}) {
      logAction('correction.remove', `删除纠错规则 #${payload.id}`)
      const { id } = payload
      const store = getStore()
      const doc = loadDoc(store)
      const before = doc.rules.length
      doc.rules = doc.rules.filter((r) => !r || r.id !== id)
      if (doc.rules.length === before) throw new Error('规则不存在')
      doc.version += 1
      store.setRaw(doc)
      store.save()
      return { ok: true, version: doc.version }
    },
  }
}

/** 统一错误包装(与 library/ipc.js 同语义) */
function wrapHandler(channel, handler) {
  return async (_event, payload) => {
    try {
      return await handler(payload || {})
    } catch (err) {
      const message = err && err.message ? err.message : String(err)
      logError('ipc:' + channel, err, `[corrections] ${channel} 失败:${message}`)
      return { ok: false, error: message }
    }
  }
}

/**
 * 注册纠错 IPC 通道(在 app.whenReady 中调用)
 * @param {{ipcMain?: object, store?: object}} [options]
 * @returns {string[]} 已注册的通道名
 */
function registerCorrectionsIpc(options = {}) {
  let ipc = options.ipcMain
  if (!ipc) {
    const electron = require('electron')
    ipc = electron && electron.ipcMain
  }
  if (!ipc || typeof ipc.handle !== 'function') {
    throw new Error('registerCorrectionsIpc 需要可用的 ipcMain')
  }
  const handlers = createCorrectionsHandlers({ store: options.store })
  for (const channel of CORRECTION_CHANNELS) {
    ipc.handle(channel, wrapHandler(channel, handlers[channel]))
  }
  return CORRECTION_CHANNELS
}

module.exports = {
  createCorrectionsHandlers,
  registerCorrectionsIpc,
  CORRECTION_CHANNELS,
}
