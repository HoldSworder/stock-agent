// klinecharts 封装：K线（candle）与分时（area）两种图，暗色 + A股红涨绿跌。
// 复用前端 KlineDialog 同款样式与同版本库（vendored ESM，无需打包器）。
import { init, dispose } from './vendor/klinecharts.esm.js';

const UP = '#f0454a';
const DOWN = '#12b886';

const STYLES = {
  grid: {
    horizontal: { color: 'rgba(255,255,255,0.06)' },
    vertical: { color: 'rgba(255,255,255,0.06)' },
  },
  candle: {
    bar: {
      upColor: UP,
      downColor: DOWN,
      noChangeColor: '#888888',
      upBorderColor: UP,
      downBorderColor: DOWN,
      upWickColor: UP,
      downWickColor: DOWN,
    },
    priceMark: {
      high: { color: '#cfd3dc' },
      low: { color: '#cfd3dc' },
      last: { text: { color: '#ffffff' } },
    },
    tooltip: { showRule: 'follow_cross', text: { color: '#cfd3dc' } },
    area: {
      lineColor: '#1f6feb',
      lineSize: 1.5,
      value: 'close',
      backgroundColor: [
        { offset: 0, color: 'rgba(31,111,235,0.22)' },
        { offset: 1, color: 'rgba(31,111,235,0.01)' },
      ],
    },
  },
  indicator: {
    tooltip: { showRule: 'follow_cross', text: { color: '#cfd3dc' } },
  },
  xAxis: { axisLine: { color: '#3a3f4b' }, tickLine: { color: '#3a3f4b' }, tickText: { color: '#8a909c' } },
  yAxis: { axisLine: { color: '#3a3f4b' }, tickLine: { color: '#3a3f4b' }, tickText: { color: '#8a909c' } },
  crosshair: {
    horizontal: { text: { backgroundColor: '#1f6feb' } },
    vertical: { text: { backgroundColor: '#1f6feb' } },
  },
};

let chart = null;
let boundEl = null;

function reinit(el) {
  destroy();
  chart = init(el);
  if (!chart) return null;
  chart.setStyles(STYLES);
  boundEl = el;
  return chart;
}

export function destroy() {
  if (boundEl) dispose(boundEl);
  chart = null;
  boundEl = null;
}

// ===== K线 =====
function toBar(b) {
  return {
    timestamp: new Date(`${b.time}T00:00:00+08:00`).getTime(),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    turnover: b.amount,
  };
}

export function renderKline(el, bars) {
  if (!reinit(el)) return;
  chart.setStyles({ candle: { type: 'candle_solid' } });
  chart.createIndicator('MA', false, { id: 'candle_pane' });
  chart.createIndicator('VOL');
  chart.applyNewData(bars.map(toBar));
}

// ===== 分时 =====
function todayStr() {
  // 以东八区交易日为准
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function renderTrends(el, result) {
  if (!reinit(el)) return;
  const date = todayStr();
  const data = (result.points ?? []).map((p) => {
    const ts = new Date(`${date}T${p.time}:00+08:00`).getTime();
    return { timestamp: ts, open: p.price, high: p.price, low: p.price, close: p.price, volume: p.volume };
  });
  chart.setStyles({ candle: { type: 'area' } });
  chart.createIndicator('VOL');
  chart.applyNewData(data);
}
