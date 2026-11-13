import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'

const r = (p) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), p)

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    electron({
      // 主进程:electron/index.js(CJS)→ dist-electron/index.js
      main: {
        entry: 'electron/index.js',
        vite: {
          build: {
            // 关键:vite 的 @rollup/plugin-commonjs 默认只处理 node_modules,
            // 源码里的 CJS require('./library/ipc') 会被原样透传进产物,
            // 导致 dist-electron/ 运行时找不到模块 → 把 electron/ 纳入转换范围
            commonjsOptions: {
              include: [/node_modules/, /electron/],
            },
            rollupOptions: {
              // ws(msedge-tts 依赖)的可选加速依赖:必须保持 external,
              // 否则 commonjs 插件把 try{require('bufferutil')} 提升为静态 import,
              // 未安装该包的机器产物加载即崩
              external: ['bufferutil', 'utf-8-validate'],
            },
          },
        },
      },
      // 预加载:contextBridge 白名单 API → dist-electron/preload.mjs
      preload: {
        input: r('electron/preload.js'),
      },
    }),
  ],
  resolve: {
    alias: {
      '@': r('src'),
    },
  },
  build: {
    // 多窗口多入口:主窗 / 桌面歌词窗 / 托盘面板窗
    rollupOptions: {
      input: {
        main: r('index.html'),
        lyrics: r('lyrics.html'),
        trayPanel: r('tray-panel.html'),
      },
    },
  },
  server: {
    port: 5173,
  },
})
