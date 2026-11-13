<script setup>
import { onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePlayerStore } from '@/stores/player'
import GlobalReminders from '@/components/GlobalReminders.vue'
import { logAction } from '@/utils/debug'
import { ElMessage } from 'element-plus'

const { t, locale } = useI18n()
const player = usePlayerStore()

// 全局快捷键:主进程注册后转发到主窗,在此执行
let offShortcut = null
// 写盘失败通知(数据没保存成功 → 必须让用户知道)
let offStorageError = null
onMounted(() => {
  if (!window.cs || typeof window.cs.on !== 'function') return
  offStorageError = window.cs.on('app:storage-error', (payload = {}) => {
    logAction('storage.error', `数据写入失败:${(payload && payload.message) || ''}`)
    ElMessage({
      message: `${t('common.saveFailed')}: ${(payload && payload.message) || ''}`,
      type: 'error',
      duration: 8000,
      showClose: true,
    })
  })
  offShortcut = window.cs.on('player:shortcut', ({ action } = {}) => {
    logAction('shortcut.trigger', `全局快捷键:${action || '-'}`)
    if (action === 'toggle') {
      if (player.status === 'playing') player.pause()
      else player.resume()
    } else if (action === 'next') {
      player.nextSeg()
    } else if (action === 'prev') {
      player.prevSeg()
    } else if (action === 'desktopLyrics') {
      window.cs.invoke('lyric:toggle-desktop', {}).catch(() => {})
    }
  })
})
onBeforeUnmount(() => {
  if (offShortcut) offShortcut()
  if (offStorageError) offStorageError()
})

// 全局阻止拖放默认行为:拖拽文件到书架以外区域(导航栏/统计页等)时,
// 防止 Electron 直接导航/打开该文件;书架区域的导入逻辑在其自身 drop 事件中处理
function preventDropDefaults(e) {
  e.preventDefault()
}
onMounted(() => {
  window.addEventListener('dragover', preventDropDefaults)
  window.addEventListener('drop', preventDropDefaults)
})
onBeforeUnmount(() => {
  window.removeEventListener('dragover', preventDropDefaults)
  window.removeEventListener('drop', preventDropDefaults)
})
</script>

<template>
  <el-container class="h-full app-shell">
    <el-header class="flex items-center gap-3 border-b app-header">
      <div class="flex items-baseline gap-2 select-none">
        <span class="brand-art">清声书坊</span>
        <span v-if="locale === 'en-US'" class="brand-sub">{{ t('app.brandSub') }}</span>
      </div>
      <!-- 书内工具条注入点(阅读器/章节管理页通过 Teleport 补充当前书信息与操作) -->
      <div id="topbar-extra" class="flex items-center gap-2 min-w-0 flex-1"></div>
      <el-menu mode="horizontal" router :default-active="$route.path" class="app-nav" :ellipsis="false">
        <el-menu-item index="/">{{ t('nav.library') }}</el-menu-item>
        <el-menu-item index="/reader">{{ t('nav.reader') }}</el-menu-item>
        <el-menu-item index="/stats">{{ t('nav.stats') }}</el-menu-item>
        <el-menu-item index="/settings">{{ t('nav.settings') }}</el-menu-item>
      </el-menu>
    </el-header>
    <el-main class="app-main">
      <!-- KeepAlive 缓存阅读器:切到统计/设置再切回来时,
           阅读器组件不卸载 → 滚动位置/当前章/播放进度原样保留,不会被「打断」 -->
      <router-view v-slot="{ Component }">
        <KeepAlive :include="['ReaderView']">
          <component :is="Component" />
        </KeepAlive>
      </router-view>
    </el-main>

    <!-- 全局提醒:护眼浮层 + 整点提示 -->
  </el-container>
  <GlobalReminders />
</template>

<style scoped>
.app-nav {
  margin-left: auto;
  /* el-menu 水平模式默认高 60px,而顶栏只有 46px → 菜单溢出栏外,
     表现为"菜单栏比整个栏还高"。与顶栏高度对齐。 */
  --el-menu-horizontal-height: 46px;
}
/* 菜单项文字在 46px 高度内垂直居中(默认 line-height 按 60px 设计) */
.app-nav :deep(.el-menu-item) {
  line-height: normal;
}
.app-shell {
  background: var(--cs-bg);
  color: var(--cs-fg);
}
.app-header {
  --el-header-height: 46px;
  background: var(--cs-panel);
  border-color: var(--cs-border);
}
/* 品牌艺术字:楷体系 + 绿金渐变,不随语言翻译 */
.brand-art {
  font-family: 'Kaiti SC', 'STKaiti', 'KaiTi', 'FZKaiTi', serif;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 3px;
  background: linear-gradient(118deg, #1d7a55 10%, #27965f 38%, #c79a3b 78%, #a8712d 95%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  padding-bottom: 2px;
}
.brand-sub {
  font-size: 12px;
  color: var(--cs-fg);
  opacity: 0.55;
}
</style>
