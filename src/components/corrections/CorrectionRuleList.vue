<script setup>
/**
 * CorrectionRuleList.vue —— 纠错规则列表(新增 / 编辑 / 删除 / 启停 / 预览)
 *
 * 数据层:useCorrectionsStore(t14)。M4 作用域固定 'global'
 * (store/IPC 已支持 book:<id>,UI 入口后续扩展)。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { useCorrectionsStore } from '@/stores/corrections'
import { logAction } from '@/utils/debug'

const { t } = useI18n()
const correctionsStore = useCorrectionsStore()

const loading = ref(false)
const editorVisible = ref(false)
/** 编辑中的规则 id(null = 新增) */
const editingId = ref(null)
const form = ref({ pattern: '', replacement: '', isRegex: false })
const previewText = ref('')

/** 正则有效性(非正则模式恒有效) */
const regexValid = computed(() => {
  if (!form.value.isRegex) return true
  try {
    new RegExp(form.value.pattern, 'g')
    return true
  } catch {
    return false
  }
})

/** 预览结果(实时) */
const previewResult = computed(() => correctionsStore.applyCorrections(previewText.value, null))

function scopeLabel(rule) {
  return rule.scope && rule.scope.startsWith('book:')
    ? t('corrections.scopeBook')
    : t('corrections.scopeGlobal')
}

function openCreate() {
  editingId.value = null
  form.value = { pattern: '', replacement: '', isRegex: false }
  editorVisible.value = true
}

function openEdit(rule) {
  editingId.value = rule.id
  form.value = { pattern: rule.pattern, replacement: rule.replacement, isRegex: !!rule.isRegex }
  editorVisible.value = true
}

async function loadList() {
  loading.value = true
  try {
    await correctionsStore.load()
  } catch (err) {
    ElMessage.error((err && err.message) || t('common.error'))
  } finally {
    loading.value = false
  }
}

async function saveRule() {
  if (!form.value.pattern.trim() || !form.value.replacement.trim()) return
  if (!regexValid.value) {
    ElMessage.warning(t('corrections.invalidRegex'))
    return
  }
  try {
    if (editingId.value) {
      await correctionsStore.update(editingId.value, {
        pattern: form.value.pattern,
        replacement: form.value.replacement,
        isRegex: form.value.isRegex,
      })
    } else {
      await correctionsStore.add({
        pattern: form.value.pattern,
        replacement: form.value.replacement,
        isRegex: form.value.isRegex,
        scope: 'global',
      })
    }
    editorVisible.value = false
  } catch (err) {
    ElMessage.error((err && err.message) || t('common.error'))
  }
}

async function removeRule(rule) {
  try {
    await ElMessageBox.confirm(t('corrections.deleteConfirm'), t('common.confirm'), {
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    await correctionsStore.remove(rule.id)
  } catch (err) {
    ElMessage.error((err && err.message) || t('common.error'))
  }
}

function toggleEnabled(rule, value) {
  logAction('correction.toggle', `${value ? '启用' : '停用'}纠错规则「${rule.pattern}」`)
  correctionsStore
    .update(rule.id, { enabled: value === true })
    .catch((err) => ElMessage.error((err && err.message) || t('common.error')))
}

onMounted(loadList)
</script>

<template>
  <div class="rule-list" v-loading="loading">
    <div class="rule-toolbar">
      <el-button type="primary" size="small" @click="openCreate">
        {{ t('corrections.addRule') }}
      </el-button>
      <span class="rule-count">{{ t('corrections.ruleCount', { n: correctionsStore.rules.length }) }}</span>
      <span class="rule-version">{{ t('corrections.versionLabel') }}: v{{ correctionsStore.version }}</span>
    </div>

    <el-empty
      v-if="correctionsStore.rules.length === 0"
      :description="t('corrections.empty')"
      :image-size="72"
    />

    <div v-else class="rule-items">
      <div v-for="rule in correctionsStore.rules" :key="rule.id" class="rule-item">
        <div class="rule-body">
          <div class="rule-main" :class="{ 'is-disabled': !rule.enabled }">
            <span class="rule-pattern">{{ rule.pattern }}</span>
            <span class="rule-arrow">→</span>
            <span class="rule-replacement">{{ rule.replacement }}</span>
            <el-tag v-if="rule.isRegex" size="small" class="rule-tag">regex</el-tag>
            <el-tag size="small" class="rule-tag">{{ scopeLabel(rule) }}</el-tag>
          </div>
          <div class="rule-actions">
            <el-switch
              size="small"
              :model-value="rule.enabled"
              @update:model-value="(v) => toggleEnabled(rule, v)"
            />
            <el-button size="small" link @click="openEdit(rule)">{{ t('common.confirm') }}</el-button>
            <el-button size="small" type="danger" link @click="removeRule(rule)">
              {{ t('common.delete') }}
            </el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- 预览 -->
    <div class="rule-preview">
      <div class="preview-label">{{ t('corrections.preview') }}</div>
      <el-input
        v-model="previewText"
        :placeholder="t('corrections.previewInput')"
        type="textarea"
        :rows="2"
      />
      <div v-if="previewText" class="preview-compare">
        <div><span class="preview-key">{{ t('corrections.previewOriginal') }}:</span>{{ previewText }}</div>
        <div><span class="preview-key">{{ t('corrections.previewResult') }}:</span>{{ previewResult }}</div>
      </div>
    </div>

    <!-- 新增/编辑弹窗 -->
    <el-dialog
      v-model="editorVisible"
      :title="editingId ? t('corrections.title') : t('corrections.addRule')"
      width="480px"
      append-to-body
    >
      <div class="editor-form">
        <el-input
          v-model="form.pattern"
          :placeholder="t('corrections.patternPlaceholder')"
        >
          <template #prepend>{{ t('corrections.pattern') }}</template>
        </el-input>
        <el-input v-model="form.replacement" :placeholder="t('corrections.replacementPlaceholder')">
          <template #prepend>{{ t('corrections.replacement') }}</template>
        </el-input>
        <el-checkbox v-model="form.isRegex">{{ t('corrections.isRegex') }}</el-checkbox>
        <div v-if="form.isRegex && !regexValid" class="regex-error">
          {{ t('corrections.invalidRegex') }}
        </div>
      </div>
      <template #footer>
        <el-button @click="editorVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button
          type="primary"
          :disabled="!form.pattern.trim() || !form.replacement.trim() || (form.isRegex && !regexValid)"
          @click="saveRule"
        >
          {{ t('common.confirm') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.rule-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.rule-count,
.rule-version {
  font-size: 12px;
  opacity: 0.6;
}
.rule-items {
  max-height: 320px;
  overflow: auto;
}
.rule-item {
  border-bottom: 1px solid var(--cs-border, rgba(0, 0, 0, 0.06));
}
.rule-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 2px;
}
.rule-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
  word-break: break-all;
}
.rule-main.is-disabled {
  opacity: 0.45;
}
.rule-pattern {
  font-weight: 600;
}
.rule-arrow {
  opacity: 0.5;
}
.rule-replacement {
  color: #1d7a55;
}
.rule-tag {
  flex: none;
}
.rule-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.rule-preview {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--cs-border, rgba(0, 0, 0, 0.06));
}
.preview-label {
  font-size: 12px;
  opacity: 0.6;
  margin-bottom: 6px;
}
.preview-compare {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.7;
  word-break: break-all;
}
.preview-key {
  opacity: 0.55;
  margin-right: 6px;
}
.regex-error {
  color: #f56c6c;
  font-size: 12px;
}
.editor-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
