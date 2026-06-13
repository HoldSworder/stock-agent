<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { init, dispose, registerIndicator, CandleType, LineType, type Chart, type KLineData } from 'klinecharts';
import { storeToRefs } from 'pinia';
import { api } from '@/api';
import { useKlineStore } from '@/stores/kline';
import type { KlinePeriod, TrendPoint, TrendsResult } from '@stock-agent/shared';

/** 弹窗标签：分时 + 日/周/月 K 线 */
type Tab = 'trend' | KlinePeriod;

/** 分时数据点附加到 KLineData 上的字段（供自定义指标读取均价/昨收基线） */
interface TrendKLineData extends KLineData {
  avg: number;
  base: number;
}

// 分时自定义指标：在主图叠加「均价线」+「昨收基线」（仅注册一次）
registerIndicator({
  name: 'TS_LINES',
  shortName: '分时',
  figures: [
    { key: 'avg', title: '均价: ', type: 'line' },
    { key: 'base', title: '昨收: ', type: 'line' },
  ],
  calc: (dataList: KLineData[]) =>
    dataList.map((d) => ({
      avg: (d as TrendKLineData).avg,
      base: (d as TrendKLineData).base,
    })),
});

const store = useKlineStore();
const { visible, code, name, secid } = storeToRefs(store);

const chartEl = ref<HTMLDivElement | null>(null);
const tab = ref<Tab>('day');
const loading = ref(false);
const error = ref('');
// 当日分时原始数据（用于派生盘口数据条），切到非分时或关闭时置空
const trend = ref<TrendsResult | null>(null);

let chart: Chart | null = null;
// 自增 token：切换标的/周期时丢弃过期请求
let reqToken = 0;
// 实时轮询定时器（仅交易时段，刷新当前激活 tab：分时或各 K 线级别）
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_MS = 10_000;
// 独立副图的 pane id
const macdPaneId = 'macd_pane';
const bollPaneId = 'boll_pane';
// A 股一日分时点数（09:30-11:30 + 13:00-15:00 共 240 分钟），用于分时铺满全天框架
const SESSION_BARS = 240;
// 图表默认 bar 间距，从分时切回 K 线时还原
let defaultBarSpace = 6;

/** 是否处于 A 股交易时段（东八区工作日 09:30-11:30 / 13:00-15:00） */
function isTradingNow(): boolean {
  const sh = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const day = sh.getDay();
  if (day === 0 || day === 6) return false;
  const hm = sh.getHours() * 60 + sh.getMinutes();
  return (hm >= 570 && hm <= 690) || (hm >= 780 && hm <= 900);
}

function stopPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** 静默刷新当前激活 tab（分时或 K 线级别） */
function refreshCurrent(): void {
  if (tab.value === 'trend') void loadTrends(true);
  else void loadKline(true);
}

/** 交易时段内启动当前 tab 轮询；非交易时段不启动 */
function startPoll(): void {
  stopPoll();
  if (!isTradingNow()) return;
  pollTimer = setInterval(() => {
    if (visible.value && isTradingNow()) refreshCurrent();
    else stopPoll();
  }, POLL_MS);
}

// A股红涨绿跌 + 深色主题样式
const STYLES = {
  grid: {
    horizontal: { color: 'rgba(255,255,255,0.06)' },
    vertical: { color: 'rgba(255,255,255,0.06)' },
  },
  candle: {
    bar: {
      upColor: '#f0454a',
      downColor: '#12b886',
      noChangeColor: '#888888',
      upBorderColor: '#f0454a',
      downBorderColor: '#12b886',
      upWickColor: '#f0454a',
      downWickColor: '#12b886',
    },
    area: {
      lineColor: '#1f6feb',
      lineSize: 1,
      backgroundColor: [
        { offset: 0, color: 'rgba(31,111,235,0.18)' },
        { offset: 1, color: 'rgba(31,111,235,0.01)' },
      ],
    },
    priceMark: {
      high: { color: '#cfd3dc' },
      low: { color: '#cfd3dc' },
      last: { text: { color: '#ffffff' } },
    },
    tooltip: { text: { color: '#cfd3dc' } },
  },
  indicator: {
    tooltip: { text: { color: '#cfd3dc' } },
  },
  xAxis: { axisLine: { color: '#3a3f4b' }, tickLine: { color: '#3a3f4b' }, tickText: { color: '#8a909c' } },
  yAxis: { axisLine: { color: '#3a3f4b' }, tickLine: { color: '#3a3f4b' }, tickText: { color: '#8a909c' } },
  crosshair: {
    horizontal: { text: { backgroundColor: '#1f6feb' } },
    vertical: { text: { backgroundColor: '#1f6feb' } },
  },
};

function toKLineData(bar: { time: string; open: number; high: number; low: number; close: number; volume: number; amount: number }): KLineData {
  // 分钟级 time 形如 "YYYY-MM-DD HH:MM"，日/周/月为 "YYYY-MM-DD"
  const iso = bar.time.includes(' ')
    ? `${bar.time.replace(' ', 'T')}:00+08:00`
    : `${bar.time}T00:00:00+08:00`;
  return {
    timestamp: new Date(iso).getTime(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    turnover: bar.amount,
  };
}

/** 分时点 → KLineData：开高低收均取现价（area 模式只用 close 画线），附加均价/昨收基线供自定义指标读取 */
function toTrendKLineData(p: TrendPoint, prevClose: number, dateStr: string): TrendKLineData {
  return {
    timestamp: new Date(`${dateStr}T${p.time}:00+08:00`).getTime(),
    open: p.price,
    high: p.price,
    low: p.price,
    close: p.price,
    volume: p.volume,
    turnover: 0,
    avg: p.avg,
    base: prevClose,
  };
}

/** 分钟级 tab（数据量更大，limit 取 320）；日/周/月取 250 */
const MINUTE_TABS: Tab[] = ['5m', '15m', '30m', '60m', '120m'];

/** silent=true 用于轮询刷新：不显示 loading、失败不弹错、不清空已有图 */
async function loadKline(silent = false) {
  if (!chart || !code.value) return;
  const token = ++reqToken;
  if (!silent) {
    loading.value = true;
    error.value = '';
  }
  try {
    const period = tab.value === 'trend' ? 'day' : tab.value;
    const limit = MINUTE_TABS.includes(tab.value) ? 320 : 250;
    const bars = await api.getKline(code.value, period, limit, secid.value || undefined);
    if (token !== reqToken || !chart) return;
    chart.applyNewData(bars.map(toKLineData));
    if (silent) error.value = '';
  } catch (e) {
    if (token !== reqToken || silent) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (token === reqToken && !silent) loading.value = false;
  }
}

/** 分时铺满全天框架：按全天 240 点计算 bar 间距，右侧预留未到时段空白 */
function fitTrendFullDay(): void {
  if (!chart || !chartEl.value) return;
  const count = chart.getDataList().length;
  if (count === 0) return;
  const usable = chartEl.value.clientWidth - 60; // 约减去右侧 y 轴宽度
  const space = Math.max(1, usable / SESSION_BARS);
  chart.setBarSpace(space);
  chart.setOffsetRightDistance(Math.max(0, (SESSION_BARS - count) * space));
}

/** silent=true 用于轮询刷新：不显示 loading、失败不弹错、不清空已有图，避免抖动打断观看 */
async function loadTrends(silent = false) {
  if (!chart || !code.value) return;
  const token = ++reqToken;
  if (!silent) {
    loading.value = true;
    error.value = '';
  }
  try {
    const res = await api.getTrends(code.value, secid.value || undefined);
    if (token !== reqToken || !chart) return;
    if (res.points.length === 0) {
      trend.value = null;
      if (!silent) {
        chart.applyNewData([]);
        error.value = '该标的暂不支持分时';
      }
      return;
    }
    // 分时为当日数据，时间仅含 HH:MM，按东八区今日补全日期
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    chart.applyNewData(res.points.map((p) => toTrendKLineData(p, res.prevClose, dateStr)), false, fitTrendFullDay);
    trend.value = res; // 驱动盘口数据条（含轮询实时更新）
    if (silent) error.value = '';
  } catch (e) {
    if (token !== reqToken || silent) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (token === reqToken && !silent) loading.value = false;
  }
}

/** 按当前 tab 切换主图形态与叠加指标，并加载对应数据 */
function applyView() {
  if (!chart) return;
  if (tab.value === 'trend') {
    chart.setStyles({ candle: { type: CandleType.Area } });
    chart.removeIndicator('candle_pane', 'MA');
    chart.removeIndicator('candle_pane', 'TS_LINES');
    // 分时不显示 BOLL
    chart.removeIndicator(bollPaneId, 'BOLL');
    chart.createIndicator(
      {
        name: 'TS_LINES',
        styles: {
          lines: [
            { color: '#ffb000', size: 1, smooth: false, style: LineType.Solid, dashedValue: [2, 2] },
            { color: '#8a909c', size: 1, smooth: false, style: LineType.Dashed, dashedValue: [4, 3] },
          ],
        },
      },
      true,
      { id: 'candle_pane' },
    );
    // 分时也展示 MACD（按分钟收盘价计算）
    chart.createIndicator('MACD', false, { id: macdPaneId, height: 72 });
    // 分时锁定为全天框架：禁用缩放与拖动
    chart.setZoomEnabled(false);
    chart.setScrollEnabled(false);
    void loadTrends();
  } else {
    trend.value = null; // 离开分时清空盘口数据条
    chart.setStyles({ candle: { type: CandleType.CandleSolid } });
    chart.removeIndicator('candle_pane', 'TS_LINES');
    chart.removeIndicator('candle_pane', 'MA');
    chart.createIndicator('MA', false, { id: 'candle_pane' });
    // MACD + BOLL 独立副图（BOLL 在 MACD 下方一栏）
    chart.createIndicator('MACD', false, { id: macdPaneId, height: 72 });
    chart.createIndicator('BOLL', false, { id: bollPaneId, height: 72 });
    // K 线恢复缩放/拖动，并还原分时改动过的 bar 间距与右偏移
    chart.setZoomEnabled(true);
    chart.setScrollEnabled(true);
    chart.setBarSpace(defaultBarSpace);
    chart.setOffsetRightDistance(8);
    void loadKline();
  }
  startPoll();
}

function setupChart() {
  if (!chartEl.value) return;
  chart = init(chartEl.value);
  if (!chart) return;
  chart.setStyles(STYLES);
  defaultBarSpace = chart.getBarSpace(); // 记录默认 bar 间距，供 K 线视图还原
  chart.createIndicator('VOL', false, { id: 'vol_pane', height: 64 });
  applyView();
}

function teardownChart() {
  stopPoll();
  if (chartEl.value) dispose(chartEl.value);
  chart = null;
}

function onOpened() {
  // 弹窗动画结束后容器才有尺寸，此时再初始化
  void nextTick(setupChart);
}

function onClosed() {
  teardownChart();
  error.value = '';
  trend.value = null;
  tab.value = 'day';
}

const tipText = computed(() =>
  tab.value === 'trend' ? '当日分时 · 多源行情' : '前复权 · 多源行情',
);

/** 盘口数据条：从分时点位 + 昨收派生（仅分时 tab 展示） */
interface TrendStat {
  label: string;
  value: string;
  /** 涨跌方向，用于红涨绿跌着色；undefined 为中性 */
  dir?: 1 | 0 | -1;
}

const fmtPrice = (n: number): string => n.toFixed(2);
const fmtPct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const fmtSigned = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
/** 成交量（手）→ 万手 / 亿手 */
function fmtVol(hand: number): string {
  if (hand >= 1e8) return `${(hand / 1e8).toFixed(2)}亿手`;
  if (hand >= 1e4) return `${(hand / 1e4).toFixed(1)}万手`;
  return `${Math.round(hand)}手`;
}
const dirOf = (n: number): 1 | 0 | -1 => (n > 0 ? 1 : n < 0 ? -1 : 0);

const trendStats = computed<TrendStat[] | null>(() => {
  const t = trend.value;
  if (!t || t.points.length === 0 || t.prevClose <= 0) return null;
  const pts = t.points;
  const last = pts[pts.length - 1];
  const prev = t.prevClose;
  const prices = pts.map((p) => p.price).filter((p) => p > 0);
  if (prices.length === 0) return null;
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const chg = last.price - prev;
  const pct = (chg / prev) * 100;
  const amp = ((high - low) / prev) * 100;
  const vol = pts.reduce((s, p) => s + (p.volume || 0), 0);
  const d = dirOf(chg);
  return [
    { label: '现价', value: fmtPrice(last.price), dir: d },
    { label: '涨跌', value: fmtSigned(chg), dir: d },
    { label: '涨幅', value: fmtPct(pct), dir: d },
    { label: '均价', value: fmtPrice(last.avg) },
    { label: '最高', value: fmtPrice(high), dir: dirOf(high - prev) },
    { label: '最低', value: fmtPrice(low), dir: dirOf(low - prev) },
    { label: '振幅', value: `${amp.toFixed(2)}%` },
    { label: '成交量', value: fmtVol(vol) },
  ];
});

const showStats = computed(() => tab.value === 'trend' && trendStats.value !== null);

// 标签切换：切换主图形态并重载数据
watch(tab, () => applyView());

// 弹窗打开时若切换到另一标的，重载（指数 code 可能相同，故同时监听 secid）
watch([code, secid], () => {
  if (tab.value !== 'day') {
    tab.value = 'day'; // 触发 watch(tab) → applyView
    return;
  }
  if (visible.value && chart) applyView();
});
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="`${name || code} K线`"
    width="860px"
    top="6vh"
    append-to-body
    destroy-on-close
    class="kline-dialog"
    @opened="onOpened"
    @closed="onClosed"
  >
    <div class="kline-head">
      <span class="kline-code num">{{ code }}</span>
      <el-radio-group v-model="tab" size="small">
        <el-radio-button value="trend">分时</el-radio-button>
        <el-radio-button value="5m">5分</el-radio-button>
        <el-radio-button value="15m">15分</el-radio-button>
        <el-radio-button value="30m">30分</el-radio-button>
        <el-radio-button value="60m">60分</el-radio-button>
        <el-radio-button value="120m">120分</el-radio-button>
        <el-radio-button value="day">日K</el-radio-button>
        <el-radio-button value="week">周K</el-radio-button>
        <el-radio-button value="month">月K</el-radio-button>
      </el-radio-group>
      <span class="kline-tip">{{ tipText }}</span>
    </div>
    <div v-if="showStats" class="kline-quote">
      <div
        v-for="s in trendStats"
        :key="s.label"
        class="kline-quote__cell"
        :class="{
          'is-up': s.dir === 1,
          'is-down': s.dir === -1,
          'is-flat': s.dir === 0,
        }"
      >
        <span class="kline-quote__label">{{ s.label }}</span>
        <span class="kline-quote__value num">{{ s.value }}</span>
      </div>
    </div>
    <div v-loading="loading" class="kline-wrap">
      <div ref="chartEl" class="kline-chart" />
      <div v-if="error" class="kline-error">{{ error }}</div>
    </div>
  </el-dialog>
</template>

<style scoped>
.kline-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 14px;
  margin-bottom: 10px;
}
.kline-code {
  color: var(--text-2);
  font-size: 13px;
}
.kline-tip {
  margin-left: auto;
  color: var(--text-2);
  font-size: 12px;
}
/* 盘口数据条：cockpit 密度，细线分隔，无卡片盒子，红涨绿跌 */
.kline-quote {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  margin-bottom: 10px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  overflow: hidden;
}
.kline-quote__cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 0;
  min-width: 84px;
  padding: 8px 12px;
  border-left: 1px solid rgba(255, 255, 255, 0.06);
}
.kline-quote__cell:first-child {
  border-left: none;
}
.kline-quote__label {
  color: var(--text-2);
  font-size: 11px;
  line-height: 1;
}
.kline-quote__value {
  color: #cfd3dc;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.2;
}
/* 现价单元（首格）放大强调 */
.kline-quote__cell:first-child .kline-quote__value {
  font-size: 18px;
}
.kline-quote__cell.is-up .kline-quote__value {
  color: #f0454a;
}
.kline-quote__cell.is-down .kline-quote__value {
  color: #12b886;
}
.kline-quote__cell.is-flat .kline-quote__value {
  color: #cfd3dc;
}
.kline-wrap {
  position: relative;
}
.kline-chart {
  width: 100%;
  height: 600px;
}
.kline-error {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-color-danger);
  font-size: 13px;
}
</style>
