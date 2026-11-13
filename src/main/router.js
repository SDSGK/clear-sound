import { createRouter, createWebHashHistory } from 'vue-router'
import LibraryView from './views/LibraryView.vue'
import ReaderView from './views/ReaderView.vue'
import StatsView from './views/StatsView.vue'
import SettingsView from './views/SettingsView.vue'
import BookManageView from './views/BookManageView.vue'

/** 主窗路由:书架 / 阅读 / 章节管理 / 统计 / 设置 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'library', component: LibraryView },
    { path: '/reader/:bookId?', name: 'reader', component: ReaderView },
    { path: '/manage/:bookId', name: 'manage', component: BookManageView },
    { path: '/stats', name: 'stats', component: StatsView },
    { path: '/settings', name: 'settings', component: SettingsView },
  ],
})

export default router
