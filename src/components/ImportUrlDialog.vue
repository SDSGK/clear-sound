<script setup>
/**
 * ImportUrlDialog.vue —— 导入网页文章弹窗
 *
 * 流程:填写 URL → 校验 http(s):// → store.importUrl(url) → 成功关闭 / 失败提示
 * 依赖:useBooksStore().importUrl(渲染层书库 store,t02 交付)
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { useBooksStore } from '@/stores/books'

const visible = defineModel('visible', { type: Boolean, default: false })

const { t } = useI18n()
const booksStore = useBooksStore()

/** URL 输入值 */
const url = ref('')
/** 是否正在导入 */
const importing = ref(false)

/** 弹窗关闭时清空输入与错误态 */
watch(visible, (open) => {
  if (!open) {
    url.value = ''
    importing.value = false
  }
})

/**
 * 校验 URL 是否为 http(s) 协议
 * @param {string} raw 待校验的原始输入
 * @returns {boolean}
 */
function isValidHttpUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return false
  return /^https?:\/\/[^\s]+$/i.test(value)
}

/**
 * 确认导入
 * @returns {Promise<void>}
 */
async function onConfirm() {
  const target = url.value.trim()
  if (!isValidHttpUrl(target)) {
    ElMessage.error(t('library.importUrlPlaceholder'))
    return
  }
  importing.value = true
  try {
    await booksStore.importUrl(target)
    ElMessage.success(t('library.importUrlTitle'))
    visible.value = false
  } catch (err) {
    ElMessage.error(`${t('library.importFailed')}: ${(err && err.message) || ''}`)
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="t('library.importUrlTitle')"
    width="520px"
    :close-on-click-modal="false"
    append-to-body
  >
    <div class="import-url-body">
      <el-input
        v-model="url"
        :placeholder="t('library.importUrlPlaceholder')"
        clearable
        autofocus
        @keyup.enter="onConfirm"
      ></el-input>
      <p class="import-url-tip">{{ t('library.importUrlTip') }}</p>
    </div>

    <template #footer>
      <el-button :disabled="importing" @click="visible = false">
        {{ t('common.cancel') }}
      </el-button>
      <el-button type="primary" :loading="importing" @click="onConfirm">
        {{ importing ? t('library.importParsing') : t('common.confirm') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.import-url-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.import-url-tip {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.65;
}
</style>
