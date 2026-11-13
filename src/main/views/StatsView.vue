<script setup>
/**
 * StatsView.vue —— 使用统计(M5,PLAN §4.9)
 *
 * ECharts 按需引入(core + BarChart + Grid/Tooltip/Legend + CanvasRenderer):
 *  - 日:最近 7 天逐日(听书/阅读堆叠柱状,单位分钟)
 *  - 周:最近 8 周聚合;月:最近 12 月聚合
 *  - 今日汇总卡片(stats:today)
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { logAction } from '@/utils/debug'
import { formatNumber } from '@/utils/format'

echarts.use([BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

const { t, locale } = useI18n()

const range = ref('day')
const loading = ref(false)
const days = ref([])
const today = ref({ listenSec: 0, readSec: 0, chars: 0, plays: 0 })
const chartRef = ref(null)
let chart = null
let resizeHandler = null

const rangeOptions = computed(() => [
  { value: 'day', label: t('stats.rangeDay') },
  { value: 'week', label: t('stats.rangeWeek') },
  { value: 'month', label: t('stats.rangeMonth') },
])

/** 秒 → 人性化时长 */
function formatDuration(sec) {
  const total = Math.max(0, Math.floor(sec || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${t('stats.formatH', { h })} ${t('stats.formatM', { m })}`
  if (m > 0) return t('stats.formatM', { m })
  return t('stats.formatS', { s: total })
}

/** 横轴短标签 */
function shortDate(date) {
  if (!date) return ''
  if (date.length === 7) return date.slice(2) // YYYY-MM → YY-MM(月视图)
  return date.slice(5) // MM-DD
}

async function loadSummary() {
  loading.value = true
  logAction('stats.view', `查看统计:${range.value}`)
  try {
    const res = await window.cs.invoke('stats:summary', { range: range.value })
    days.value = Array.isArray(res.days) ? res.days : []
  } catch (err) {
    ElMessage.error((err && err.message) || t('common.error'))
  } finally {
    loading.value = false
  }
  renderChart()
}

async function loadToday() {
  try {
    const res = await window.cs.invoke('stats:today', {})
    if (res && res.ok && res.today) today.value = res.today
  } catch {
    /* 统计读取失败不影响页面 */
  }
}

function renderChart() {
  if (!chartRef.value) return
  if (!chart) chart = echarts.init(chartRef.value)
  const styles = getComputedStyle(document.documentElement)
  const fg = (styles.getPropertyValue('--cs-fg') || '').trim() || '#333'
  const border = 'rgba(128, 128, 128, 0.18)'
  chart.setOption(
    {
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => `${v} min`,
      },
      legend: { textStyle: { color: fg } },
      grid: { left: 52, right: 18, top: 40, bottom: 30 },
      xAxis: {
        type: 'category',
        data: days.value.map((d) => shortDate(d.date)),
        axisLabel: { color: fg },
        axisLine: { lineStyle: { color: border } },
      },
      yAxis: {
        type: 'value',
        name: 'min',
        nameTextStyle: { color: fg },
        axisLabel: { color: fg },
        splitLine: { lineStyle: { color: border } },
      },
      series: [
        {
          name: t('stats.listenTime'),
          type: 'bar',
          stack: 'time',
          itemStyle: { color: '#1d976c' },
          data: days.value.map((d) => Math.round((d.listenSec || 0) / 60)),
        },
        {
          name: t('stats.readTime'),
          type: 'bar',
          stack: 'time',
          itemStyle: { color: '#c79a3b' },
          data: days.value.map((d) => Math.round((d.readSec || 0) / 60)),
        },
      ],
    },
    true,
  )
}

function onResize() {
  if (chart) chart.resize()
}

watch(range, loadSummary)
// 主题/语言切换后刷新图表配色与文案
watch(locale, () => renderChart())

onMounted(() => {
  loadSummary()
  loadToday()
  resizeHandler = onResize
  window.addEventListener('resize', resizeHandler)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeHandler)
  if (chart) {
    chart.dispose()
    chart = null
  }
})
</script>

<template>
  <div class="h-full overflow-auto p-4 space-y-3">
    <!-- 今日汇总卡片 -->
    <div class="today-cards">
      <el-card class="today-card">
        <div class="card-label">{{ t('stats.todayListen') }}</div>
        <div class="card-value">{{ formatDuration(today.listenSec) }}</div>
      </el-card>
      <el-card class="today-card">
        <div class="card-label">{{ t('stats.todayRead') }}</div>
        <div class="card-value">{{ formatDuration(today.readSec) }}</div>
      </el-card>
      <el-card class="today-card">
        <div class="card-label">{{ t('stats.totalChars') }}</div>
        <div class="card-value">{{ formatNumber(today.chars) }}</div>
      </el-card>
      <el-card class="today-card">
        <div class="card-label">{{ t('stats.plays') }}</div>
        <div class="card-value">{{ today.plays }}</div>
      </el-card>
    </div>

    <!-- 趋势图 -->
    <el-card :header="t('stats.title')">
      <div class="chart-toolbar">
        <el-radio-group v-model="range" size="small">
          <el-radio-button v-for="opt in rangeOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </el-radio-button>
        </el-radio-group>
        <span class="chart-legend-hint">
          🟢 {{ t('stats.listenTime') }} · 🟡 {{ t('stats.readTime') }}(min)
        </span>
      </div>
      <div v-loading="loading" class="chart-wrap">
        <div ref="chartRef" class="chart"></div>
        <el-empty
          v-if="!loading && days.every((d) => !d.listenSec && !d.readSec)"
          :description="t('stats.noData')"
          :image-size="64"
          class="chart-empty"
        />
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.today-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 14px;
}
.today-card :deep(.el-card__body) {
  padding: 14px 18px;
}
.card-label {
  font-size: 12px;
  opacity: 0.6;
}
.card-value {
  margin-top: 6px;
  font-size: 20px;
  font-weight: 700;
}
.chart-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.chart-legend-hint {
  font-size: 12px;
  opacity: 0.6;
}
.chart-wrap {
  position: relative;
  height: 320px;
}
.chart {
  height: 100%;
  width: 100%;
}
.chart-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
</style>
