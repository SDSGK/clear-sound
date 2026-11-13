import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import App from './App.vue'
import router from './router'
import i18n, { syncLocaleOnStartup } from '@/locales'
import '@/styles/main.css'
import '@/styles/theme'
import { installGlobalErrorCapture } from '@/utils/debug'
import { setCacheLimit } from '@/utils/tts-cache'

// 全局捕获渲染层错误(控制台报错 / 未处理 Promise),写入统一调试日志
installGlobalErrorCapture()

// 把当前语言同步给主进程(macOS 系统菜单栏不随应用语言自动变化)
syncLocaleOnStartup()

// 应用已保存的音频缓存上限
window.cs
  .invoke('settings:get', {})
  .then((res) => {
    const mb = res && res.settings && res.settings.cacheLimitMB
    if (mb) setCacheLimit(Number(mb) * 1048576)
  })
  .catch(() => {})

createApp(App).use(createPinia()).use(router).use(i18n).use(ElementPlus).mount('#app')
