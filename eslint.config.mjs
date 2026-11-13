/**
 * ESLint 扁平配置(eslint 9)
 *
 * 定位:语法级校验工具——重点抓「定义了未使用」「未定义直接使用」两类问题
 * (esbuild 只做语法解析与 import 解析,这两类问题构建期抓不住,运行时才报错)。
 *
 * 使用:npm run lint(检查)/ npm run lint:fix(自动修复);
 * 不接入 vite 构建链,构建速度不受影响;提交前手动跑,报错即阻断。
 *
 * 说明:
 *  - 只启用语法正确性相关规则,不引入代码风格规则(引号/缩进/分号等)
 *  - 渲染层(src/)按 ESM + browser 全局检查;主进程(electron/)按 CommonJS
 *    + node 全局检查(require/module 由 sourceType: 'commonjs' 提供)
 *  - 渲染层通过 preload 暴露的 window.cs 是 window 属性,不触发 no-undef
 */
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

const syntaxRules = {
  // ===== 核心目标:未定义直接使用 =====
  'no-undef': 'error',
  "vue/no-undef-properties": "error",

  // ===== 核心目标:定义了未使用 =====
  // args: "after-used" —— 只报「最后一个使用位置之后」的参数,
  // 事件回调 (row, index) 只用 row 这类常见写法不误报;
  // ^_ 忽略占位参数/占位变量
  'no-unused-vars': [
    'error',
    {
      args: 'after-used',
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
    },
  ],
}

export default [
  // 忽略构建产物与非源码目录
  {
    ignores: ['dist/**', 'dist-electron/**', 'release/**', 'node_modules/**'],
  },

  // 源码检查:vue3 essential 规则(仅解析错误/真实缺陷,零风格规则)+ 语法正确性核心规则
  ...pluginVue.configs['flat/essential'],

  // 渲染层(主窗/歌词窗/托盘面板):ESM + browser 全局
  {
    files: ['src/**/*.{js,vue,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Vite 静态替换的构建期常量
        process: 'readonly',
      },
    },
    rules: syntaxRules,
  },

  // 主进程 + preload:CommonJS + node 全局
  {
    files: ['electron/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: syntaxRules,
  },
]
