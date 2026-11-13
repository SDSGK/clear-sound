import { createApp } from 'vue'
import App from './App.vue'
import '@/styles/main.css'

// 桌面歌词窗:轻量入口,不引 Element Plus。
// 注意:本窗不接 vue-i18n(窗体极小,少一层运行时);
// 词条在 App.vue 内以 `import zhCN from '@/locales/zh-CN'` 直接取用。
createApp(App).mount('#app')
