<script setup>
/**
 * style-panel.vue —— 桌面歌词窗样式面板(轻量,不使用 Element Plus)
 *
 * 依据 docs/DESIGN.md §4「样式可调:单行/双行 · 字体/字号 · 渐变色 · 背景条透明度」
 * 与任务要求(当前句渐变起止色 / 背景不透明度 slider)。
 *
 * 布局:单行横向紧凑排布(高度 ≲ 34px),以便在单行模式(窗高 52)下也能完整显示;
 * 面板展开期间**不改变窗口高度**——窗口高度恒等于行模式高度(52 / 96),
 * 由 App.vue 在行模式切换时统一 invoke('lyric:resize')。
 *
 * 交互:所有控件「确认即生效」——每次变更立即 emit('update', patch),
 * 由 App.vue 归一化后写入 localStorage['cs.lyrics.style'] 并热更渲染层。
 */

const props = defineProps({
  /** 当前样式(只读快照,变更通过 update 事件回传) */
  style: { type: Object, required: true },
  /** 字体选项 [{value,label}] */
  fontOptions: { type: Array, default: () => [] },
  /** 字号下界 */
  fontSizeMin: { type: Number, default: 16 },
  /** 字号上界 */
  fontSizeMax: { type: Number, default: 36 },
  /** 背景不透明度下界 */
  bgOpacityMin: { type: Number, default: 0 },
  /** 背景不透明度上界 */
  bgOpacityMax: { type: Number, default: 0.6 },
})

const emit = defineEmits(['update', 'close'])

/**
 * 上报一项样式变更
 * @param {string} key 字段名
 * @param {unknown} value 字段值
 * @returns {void}
 */
function setField(key, value) {
  emit('update', { [key]: value })
}

/**
 * 字号滑杆事件(input 事件给出字符串,转数值)
 * @param {Event} e input 事件
 * @returns {void}
 */
function onFontSizeInput(e) {
  const v = Number(e.target.value)
  if (Number.isFinite(v)) setField('fontSize', v)
}

/**
 * 背景不透明度滑杆事件
 * @param {Event} e input 事件
 * @returns {void}
 */
function onOpacityInput(e) {
  const v = Number(e.target.value)
  if (Number.isFinite(v)) setField('bgOpacity', Math.round(v * 100) / 100)
}
</script>

<template>
  <div class="style-panel">
    <!-- 行模式 -->
    <div class="sp-group">
      <span class="sp-label">行模式</span>
      <div class="sp-inline">
        <button
          type="button"
          class="sp-chip"
          :class="{ 'is-active': props.style.lineMode === 'single' }"
          @click="setField('lineMode', 'single')"
        >
          单行
        </button>
        <button
          type="button"
          class="sp-chip"
          :class="{ 'is-active': props.style.lineMode === 'double' }"
          @click="setField('lineMode', 'double')"
        >
          双行
        </button>
      </div>
    </div>

    <!-- 字体 -->
    <div class="sp-group">
      <span class="sp-label">字体</span>
      <div class="sp-inline">
        <button
          v-for="opt in props.fontOptions"
          :key="opt.value"
          type="button"
          class="sp-chip"
          :class="{ 'is-active': props.style.fontFamily === opt.value }"
          @click="setField('fontFamily', opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <!-- 字号 -->
    <div class="sp-group">
      <span class="sp-label">字号</span>
      <div class="sp-inline">
        <input
          class="sp-slider"
          type="range"
          :min="props.fontSizeMin"
          :max="props.fontSizeMax"
          step="1"
          :value="props.style.fontSize"
          @input="onFontSizeInput"
        />
        <span class="sp-value">{{ props.style.fontSize }}px</span>
      </div>
    </div>

    <!-- 当前句渐变起止色 -->
    <div class="sp-group">
      <span class="sp-label">渐变</span>
      <div class="sp-inline">
        <label class="sp-color" title="起始色">
          <input
            type="color"
            :value="props.style.gradientFrom"
            @input="setField('gradientFrom', $event.target.value)"
          />
        </label>
        <label class="sp-color" title="结束色">
          <input
            type="color"
            :value="props.style.gradientTo"
            @input="setField('gradientTo', $event.target.value)"
          />
        </label>
      </div>
    </div>

    <!-- 背景不透明度 -->
    <div class="sp-group">
      <span class="sp-label">背景</span>
      <div class="sp-inline">
        <input
          class="sp-slider"
          type="range"
          :min="props.bgOpacityMin"
          :max="props.bgOpacityMax"
          step="0.05"
          :value="props.style.bgOpacity"
          @input="onOpacityInput"
        />
        <span class="sp-value">{{ Number(props.style.bgOpacity).toFixed(2) }}</span>
      </div>
    </div>

    <button class="sp-close" type="button" title="关闭" @click="emit('close')">✕</button>
  </div>
</template>

<style scoped>
.style-panel {
  /* 叠加在歌词窗底部(不挤压歌词正文);定位参照 .lyrics-card(position:relative) */
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 4px 10px 6px;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #fff;
  -webkit-app-region: no-drag;
  overflow: hidden;
}

.sp-group {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.sp-label {
  font-size: 10px;
  opacity: 0.7;
}

.sp-inline {
  display: flex;
  align-items: center;
  gap: 3px;
}

.sp-value {
  font-size: 10px;
  opacity: 0.8;
  min-width: 30px;
}

.sp-chip {
  border: none;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font-size: 10px;
  line-height: 1.7;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.sp-chip.is-active {
  background: rgba(255, 179, 71, 0.92);
  color: #221c14;
  font-weight: 600;
}

.sp-color {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
}

.sp-color input[type='color'] {
  width: 18px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.sp-slider {
  width: 58px;
  height: 12px;
  margin: 0;
  accent-color: #ffb347;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.sp-close {
  flex: none;
  border: none;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  width: 16px;
  height: 16px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
  -webkit-app-region: no-drag;
}
</style>
