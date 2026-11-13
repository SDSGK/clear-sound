<script setup>
/**
 * GlobalReminders.vue —— 提醒展示(护眼浮层 + 整点提示音),挂在主窗 App 根部
 *
 * - reminder:eye-rest(main 推送):全屏遮罩浮层 + 倒计时(可跳过),不打断播放
 * - reminder:chime(main 推送):右下角轻提示 + Web Audio 提示音(音量可配)
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { logAction } from '@/utils/debug'

const { t } = useI18n()

// ===== 20-20-20 护眼浮层 =====
const eyeVisible = ref(false)
const eyeMin = ref(20)
const restLeft = ref(20)
let restTimer = null

function startEyeRest(payload) {
  logAction('reminder.eyeRest', `护眼提醒触发(${Number(payload.min) || 20} 分钟)`)
  eyeMin.value = Number(payload.min) || 20
  restLeft.value = Number(payload.restSec) || 20
  eyeVisible.value = true
  if (restTimer) clearInterval(restTimer)
  restTimer = setInterval(() => {
    restLeft.value -= 1
    if (restLeft.value <= 0) closeEyeRest()
  }, 1000)
}

function closeEyeRest() {
  logAction('reminder.eyeRestClose', '护眼浮层关闭')
  if (restTimer) {
    clearInterval(restTimer)
    restTimer = null
  }
  eyeVisible.value = false
}

// ===== 整点提示音(Web Audio 短音) =====
let audioCtx = null
let lastChimeTime = ''

function playChime(volume) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
    const ctx = audioCtx
    const gain = ctx.createGain()
    gain.gain.value = Math.max(0, Math.min(1, Number(volume) || 0.5))
    gain.connect(ctx.destination)
    // 两声叮咚(880Hz / 660Hz)
    ;[0, 0.28].forEach((start, i) => {
      const osc = ctx.createOscillator()
      osc.frequency.value = i === 0 ? 880 : 660
      osc.connect(gain)
      osc.start(ctx.currentTime + start)
      osc.stop(ctx.currentTime + start + 0.18)
    })
  } catch {
    /* 音频不可用静默跳过 */
  }
}

function onChime(payload) {
  const time = (payload && payload.time) || ''
  if (time && time === lastChimeTime) return // 去重
  lastChimeTime = time
  logAction('reminder.chime', `整点提示:${time || '-'}`)
  playChime(payload && payload.volume)
  ElMessage({
    message: t('reminder.chimeMessage', { time }),
    type: 'info',
    duration: 4000,
  })
}

let unlisteners = []

onMounted(() => {
  if (typeof window === 'undefined' || !window.cs || typeof window.cs.on !== 'function') return
  unlisteners = [
    window.cs.on('reminder:eye-rest', startEyeRest),
    window.cs.on('reminder:chime', onChime),
  ]
})

onBeforeUnmount(() => {
  if (restTimer) clearInterval(restTimer)
  unlisteners.forEach((off) => off())
  unlisteners = []
})

const countdownText = computed(() => t('reminder.restCountdown', { s: Math.max(0, restLeft.value) }))
</script>

<template>
  <!-- 护眼浮层:全屏半透明,倒计时结束自动关闭 -->
  <Teleport to="body">
    <Transition name="eye-fade">
      <div v-if="eyeVisible" class="eye-overlay">
        <div class="eye-card">
          <div class="eye-icon">👁</div>
          <div class="eye-title">{{ t('reminder.eyeTitle') }}</div>
          <div class="eye-message">{{ t('reminder.eyeMessage', { min: eyeMin }) }}</div>
          <div class="eye-countdown">{{ countdownText }}</div>
          <button class="eye-skip" type="button" @click="closeEyeRest">
            {{ t('reminder.skip') }}
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.eye-overlay {
  position: fixed;
  inset: 0;
  z-index: 5000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(10, 25, 18, 0.72);
  backdrop-filter: blur(2px);
}
.eye-card {
  text-align: center;
  color: #fff;
  padding: 26px 40px;
  border-radius: 16px;
  background: rgba(20, 40, 30, 0.9);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
}
.eye-icon {
  font-size: 40px;
}
.eye-title {
  margin-top: 10px;
  font-size: 20px;
  font-weight: 700;
}
.eye-message {
  margin-top: 10px;
  font-size: 14px;
  opacity: 0.85;
  max-width: 360px;
}
.eye-countdown {
  margin-top: 14px;
  font-size: 13px;
  opacity: 0.7;
}
.eye-skip {
  margin-top: 16px;
  padding: 6px 22px;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 999px;
  background: transparent;
  color: #fff;
  cursor: pointer;
  font-size: 13px;
}
.eye-skip:hover {
  background: rgba(255, 255, 255, 0.12);
}
.eye-fade-enter-active,
.eye-fade-leave-active {
  transition: opacity 0.3s;
}
.eye-fade-enter-from,
.eye-fade-leave-to {
  opacity: 0;
}
</style>
