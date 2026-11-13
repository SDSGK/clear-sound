/**
 * corrections.js —— 纠错规则 Pinia store(渲染层,PLAN §4.7)
 *
 * 双通道语义:
 *  - 合成通道(player):ensureAudio 合成前用 applyCorrections 替换文本,
 *    替换后文本参与 tts:synthesize 与缓存 key —— 规则变更自动重合成;
 *  - 显示通道(VirtualBook 消费):同一函数,由「显示纠错」开关控制是否应用于渲染。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { logAction } from '@/utils/debug'

/** 单条规则替换(正则失败静默跳过该规则,不阻断链) */
function applyOne(text, rule) {
  try {
    if (rule.isRegex) {
      return text.replace(new RegExp(rule.pattern, 'g'), rule.replacement)
    }
    // 字面替换:split/join 天然规避 $ 系列特殊字符
    return text.split(rule.pattern).join(rule.replacement)
  } catch {
    return text
  }
}

/**
 * 调用主进程 IPC;失败统一 throw Error
 */
async function invoke(channel, payload) {
  if (typeof window === 'undefined' || !window.cs || typeof window.cs.invoke !== 'function') {
    throw new Error(`IPC_UNAVAILABLE:${channel}`)
  }
  const res = await window.cs.invoke(channel, payload)
  if (!res || !res.ok) {
    const detail = (res && (res.error || res.message)) || ''
    throw new Error(detail ? `${detail}` : `IPC_FAILED:${channel}`)
  }
  return res
}

export const useCorrectionsStore = defineStore('corrections', () => {
  /** 规则版本(主进程维护,任何增删改 +1) */
  const version = ref(0)
  /** 规则全量列表(含 disabled) */
  const rules = ref([])
  /** 是否已从主进程拉取过 */
  const loaded = ref(false)

  /** 从主进程拉取规则与版本 */
  async function load() {
    const res = await invoke('correction:list')
    version.value = Number(res.version) || 0
    rules.value = Array.isArray(res.rules) ? res.rules : []
    loaded.value = true
  }

  async function add(rule) {
    const res = await invoke('correction:add', {
      pattern: rule.pattern,
      replacement: rule.replacement,
      isRegex: !!rule.isRegex,
      scope: rule.scope || 'global',
    })
    version.value = Number(res.version) || version.value + 1
    if (res.rule) rules.value.push(res.rule)
    logAction('correction.add', `新增纠错规则「${rule.pattern}」→「${rule.replacement}」`)
    return res.rule
  }

  async function update(id, patch) {
    const res = await invoke('correction:update', { id, patch })
    version.value = Number(res.version) || version.value
    const idx = rules.value.findIndex((r) => r && r.id === id)
    if (res.rule && idx >= 0) rules.value[idx] = res.rule
    logAction('correction.update', `修改纠错规则 #${id}`)
    return res.rule
  }

  async function remove(id) {
    const res = await invoke('correction:remove', { id })
    version.value = Number(res.version) || version.value
    rules.value = rules.value.filter((r) => !r || r.id !== id)
    logAction('correction.remove', `删除纠错规则 #${id}`)
  }

  /** 启用中的规则 */
  const enabledRules = computed(() => rules.value.filter((r) => r && r.enabled))

  /**
   * 应用纠错(按规则顺序链式替换)
   * @param {string} text 原始文本
   * @param {string} bookId 当前书 id(scope 匹配 'global' 或 'book:<id>')
   * @returns {string} 替换后文本
   */
  function applyCorrections(text, bookId) {
    let out = String(text == null ? '' : text)
    if (!out || enabledRules.value.length === 0) return out
    const scopeBook = `book:${bookId || ''}`
    for (const rule of enabledRules.value) {
      if (rule.scope !== 'global' && rule.scope !== scopeBook) continue
      out = applyOne(out, rule)
    }
    return out
  }

  /** 显示纠错偏好(UI 小数据,localStorage) */
  function isDisplayCorrectionEnabled() {
    try {
      return localStorage.getItem('cs.corrections.display') === 'true'
    } catch {
      return false
    }
  }

  function setDisplayCorrection(enabled) {
    try {
      localStorage.setItem('cs.corrections.display', enabled ? 'true' : 'false')
    } catch {
      /* 忽略 */
    }
  }

  return {
    version,
    rules,
    loaded,
    enabledRules,
    load,
    add,
    update,
    remove,
    applyCorrections,
    isDisplayCorrectionEnabled,
    setDisplayCorrection,
  }
})

export default useCorrectionsStore
