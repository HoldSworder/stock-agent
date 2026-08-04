<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  init,
  dispose,
  registerIndicator,
  registerOverlay,
  CandleType,
  LineType,
  TooltipShowRule,
  TooltipShowType,
  CandleTooltipRectPosition,
  type Chart,
  type KLineData,
  type TooltipLegend,
  type CandleTooltipCustomCallbackData,
  type OverlayCreateFiguresCallbackParams,
  type OverlayFigure,
} from 'klinecharts';
import { storeToRefs } from 'pinia';
import { api } from '@/api';
import { useKlineStore } from '@/stores/kline';
import { isTradingNow } from '@/composables/tradingHours';
import CapitalPanel from '@/components/CapitalPanel.vue';
import ChipPanel from '@/components/ChipPanel.vue';
import SymbolChatPanel from '@/components/SymbolChatPanel.vue';
import SymbolTradePlanPanel from '@/components/SymbolTradePlanPanel.vue';
import type {
  KlinePeriod,
  SymbolMark,
  SymbolMarkKind,
  SymbolPlanHorizon,
  TrendPoint,
  TrendsResult,
  StockIndicators,
  VolumeReadout,
} from '@stock-agent/shared';

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

// 标注 overlay：内置只有点位（simpleAnnotation）与线段（segment），
// 「贯穿全宽的价位线（带标签）」与「时间区间矩形」需自注册（仅注册一次）。
/** 标签横向错位的槽宽（px）：靠得太近的价位线把标签逐个右移一格，避免文字互相遮挡 */
const LABEL_SLOT_PX = 108;
/** 标签起始横向留白 */
const LABEL_X0 = 6;

/**
 * 槽位 → 标签起始 x。必须按容器宽度夹住：一簇里线太多时无限右移会把标签整条推出可视区，
 * 那比互相遮挡更糟——遮挡至少还能看见最上面一条，推出去就是彻底看不见。
 * 夹到边界后退化为重叠，是可接受的最坏情况。
 */
function labelX(slot: number, width: number): number {
  return Math.max(LABEL_X0, Math.min(LABEL_X0 + slot * LABEL_SLOT_PX, width - LABEL_SLOT_PX));
}

/** overlay 的 extendData 载荷：文案 + 防重叠槽位 */
interface MarkExtend {
  text: string;
  slot: number;
}

/** 读 extendData（旧数据可能是裸字符串，兜底成 slot 0） */
function readExtend(raw: unknown): MarkExtend {
  if (raw && typeof raw === 'object' && 'text' in raw) {
    const e = raw as Partial<MarkExtend>;
    return { text: String(e.text ?? ''), slot: Number(e.slot ?? 0) || 0 };
  }
  return { text: String(raw ?? ''), slot: 0 };
}

registerOverlay({
  name: 'SM_PRICE_LINE',
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates, bounding, overlay }: OverlayCreateFiguresCallbackParams): OverlayFigure[] => {
    const y = coordinates[0]?.y;
    if (y == null) return [];
    const { text, slot } = readExtend(overlay.extendData);
    return [
      { type: 'line', attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] } },
      {
        type: 'text',
        ignoreEvent: true,
        attrs: { x: labelX(slot, bounding.width), y: y - 2, text, baseline: 'bottom' },
      },
    ];
  },
});

/** 价格带最小可见高度：上下沿贴太近时仍要能看出这是一条带而不是一根线 */
const BAND_MIN_PX = 3;

registerOverlay({
  name: 'SM_PRICE_BAND',
  totalStep: 3,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates, bounding, overlay }: OverlayCreateFiguresCallbackParams): OverlayFigure[] => {
    const y0 = coordinates[0]?.y;
    const y1 = coordinates[1]?.y;
    if (y0 == null || y1 == null) return [];
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    const height = Math.max(BAND_MIN_PX, bottom - top);
    const { text, slot } = readExtend(overlay.extendData);
    return [
      {
        type: 'polygon',
        attrs: {
          coordinates: [
            { x: 0, y: top },
            { x: bounding.width, y: top },
            { x: bounding.width, y: top + height },
            { x: 0, y: top + height },
          ],
        },
        styles: { style: 'stroke_fill' },
      },
      {
        type: 'text',
        ignoreEvent: true,
        attrs: { x: labelX(slot, bounding.width), y: top - 2, text, baseline: 'bottom' },
      },
    ];
  },
});

registerOverlay({
  name: 'SM_RANGE',
  totalStep: 3,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, overlay }: OverlayCreateFiguresCallbackParams): OverlayFigure[] => {
    const [a, b] = coordinates;
    if (!a || !b) return [];
    return [
      {
        type: 'polygon',
        attrs: {
          coordinates: [
            { x: a.x, y: a.y },
            { x: b.x, y: a.y },
            { x: b.x, y: b.y },
            { x: a.x, y: b.y },
          ],
        },
        styles: { style: 'stroke_fill' },
      },
      {
        type: 'text',
        ignoreEvent: true,
        attrs: {
          x: (a.x + b.x) / 2,
          y: Math.min(a.y, b.y) - 2,
          text: String(overlay.extendData ?? ''),
          align: 'center',
          baseline: 'bottom',
        },
      },
    ];
  },
});

const store = useKlineStore();
const { visible, code, name, secid } = storeToRefs(store);

const chartEl = ref<HTMLDivElement | null>(null);
const tab = ref<Tab>('day');
// 视图模式：图表（K线/分时）｜资金面（S7 龙虎榜）｜筹码（S8 筹码分布）。后两者仅 A 股个股可用
const viewMode = ref<'chart' | 'capital' | 'chip'>('chart');
const isStock = computed(() => /^\d{6}$/.test(code.value || '') && !secid.value);
const loading = ref(false);
const error = ref('');
// 当日分时原始数据（用于派生盘口数据条），切到非分时或关闭时置空
const trend = ref<TrendsResult | null>(null);
// S9 技术指标读数（MACD/KDJ/RSI/BOLL 状态条），仅 K 线视图展示
const indicators = ref<StockIndicators | null>(null);
// agent 打在图上的标注（价位线/点位/区间/趋势线），K 线视图叠加展示，只读
const marks = ref<SymbolMark[]>([]);
// 右侧页签：交易计划为默认，Agent 对话保留
const sideTab = ref<'plan' | 'agent'>('plan');
// 对话栏懒挂载标记：首次切到 Agent 页签才建 WS 与会话
const agentEverOpened = ref(false);
watch(sideTab, (t) => {
  if (t === 'agent') agentEverOpened.value = true;
});
// 自增用作计划面板的 key：agent 一轮结束后 bump 一次让它重挂载并重取最新版本
const planKey = ref(0);
/** agent 一轮结束：既可能打了标注，也可能生成了新计划版本，两者都刷新 */
function onAgentDone(): void {
  void loadMarks();
  planKey.value += 1;
}
const chatRef = ref<InstanceType<typeof SymbolChatPanel> | null>(null);
// 计划面板的车道由弹窗持有：面板被 planKey 重挂后车道不至于被重置回下一交易日
const planHorizon = ref<SymbolPlanHorizon>('next_session');
/**
 * 计划页签空状态点「生成」：切到 Agent 页签跑同一套流程，
 * 让用户能看到取数与落库的完整轨迹，而不是对着一个转圈干等。
 */
async function onGeneratePlan(horizon: SymbolPlanHorizon): Promise<void> {
  // 记住这次生成的车道，跑完切回计划页签直接落在对应那条上
  planHorizon.value = horizon;
  agentEverOpened.value = true;
  sideTab.value = 'agent';
  // 对话栏是懒挂载的，要等它渲染出来才拿得到实例
  await nextTick();
  await chatRef.value?.genPlan(horizon);
}

let chart: Chart | null = null;
// 自增 token：切换标的/周期时丢弃过期请求
let reqToken = 0;
// 实时轮询定时器（仅交易时段，刷新当前激活 tab：分时或各 K 线级别）
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_MS = 10_000;
// 独立副图的 pane id
const macdPaneId = 'macd_pane';
const bollPaneId = 'boll_pane';
const kdjPaneId = 'kdj_pane';
const rsiPaneId = 'rsi_pane';
// A 股一日分时点数（09:30-11:30 + 13:00-15:00 共 240 分钟），用于分时铺满全天框架
const SESSION_BARS = 240;
// 图表默认 bar 间距，从分时切回 K 线时还原
let defaultBarSpace = 6;

/**
 * 副图总占比：K 线视图有 VOL/MACD/BOLL/KDJ/RSI 五个副图，
 * 五个平分 45% 高度，主图拿走剩下的 55%，保证主图始终是最高的一格。
 * 早先给副图写死 62px，容器一大主图就独占、容器一小副图又挤成一条线。
 */
const SUB_PANE_TOTAL_RATIO = 0.53;
/** x 轴与内边距的预留高度，不参与比例分配 */
const AXIS_RESERVE_PX = 30;
/** 副图最小可读高度：低于这个值指标线和刻度就糊成一团 */
const MIN_SUB_PANE_PX = 88;
/** K 线视图的副图个数：VOL / MACD / BOLL / KDJ / RSI */
const SUB_PANE_COUNT = 5;

let resizeObserver: ResizeObserver | null = null;

/**
 * 单个副图的像素高度：按 K 线视图的 5 格布局分配，各 tab 统一用这个值。
 * 分时视图只有 VOL + MACD 两格，用同一高度时主图自然更大，无需另算比例。
 */
function subPaneHeight(): number {
  const h = chartEl.value?.clientHeight ?? 0;
  if (h <= 0) return MIN_SUB_PANE_PX;
  const usable = Math.max(0, h - AXIS_RESERVE_PX);
  return Math.max(MIN_SUB_PANE_PX, Math.floor((usable * SUB_PANE_TOTAL_RATIO) / SUB_PANE_COUNT));
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

// A股红涨绿跌配色（图表 + tooltip 共用）
const UP_COLOR = '#f0454a';
const DOWN_COLOR = '#12b886';
const FLAT_COLOR = '#cfd3dc';
const colorOf = (n: number): string => (n > 0 ? UP_COLOR : n < 0 ? DOWN_COLOR : FLAT_COLOR);

/** 悬浮明细 tooltip：中文字段 + 该 K 线至今收益（取图表最新收盘价计算），红涨绿跌着色 */
function candleTooltip(data: CandleTooltipCustomCallbackData): TooltipLegend[] {
  const c = data.current;
  const time = c.timestamp
    ? new Date(c.timestamp).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        ...(tab.value === 'trend' || MINUTE_TABS.includes(tab.value)
          ? { hour: '2-digit', minute: '2-digit' }
          : {}),
      })
    : '--';
  const grey = '#8a909c';
  const row = (title: string, text: string, color = FLAT_COLOR): TooltipLegend => ({
    title: { text: title, color: grey },
    value: { text, color },
  });

  if (tab.value === 'trend') {
    const base = (c as TrendKLineData).base;
    const avg = (c as TrendKLineData).avg;
    const chg = base > 0 ? ((c.close - base) / base) * 100 : 0;
    return [
      row('时间', time),
      row('价格', fmtPrice(c.close), colorOf(c.close - base)),
      row('均价', avg > 0 ? fmtPrice(avg) : '--'),
      row('涨幅', base > 0 ? fmtPct(chg) : '--', colorOf(chg)),
    ];
  }

  const dayChg = c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0;
  const latest = chart?.getDataList().at(-1)?.close ?? c.close;
  const hold = c.close > 0 ? ((latest - c.close) / c.close) * 100 : 0;
  return [
    row('时间', time),
    row('开盘', fmtPrice(c.open), colorOf(c.open - (data.prev?.close ?? c.open))),
    row('最高', fmtPrice(c.high), UP_COLOR),
    row('最低', fmtPrice(c.low), DOWN_COLOR),
    row('收盘', fmtPrice(c.close), colorOf(c.close - c.open)),
    row('涨跌幅', fmtPct(dayChg), colorOf(dayChg)),
    row('成交量', fmtVol(c.volume ?? 0)),
    row('此K线至今收益', fmtPct(hold), colorOf(hold)),
  ];
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
    tooltip: {
      showRule: TooltipShowRule.FollowCross,
      showType: TooltipShowType.Rect,
      custom: candleTooltip,
      rect: {
        position: CandleTooltipRectPosition.Pointer,
        color: 'rgba(20,24,33,0.92)',
        borderColor: 'rgba(255,255,255,0.14)',
        borderRadius: 6,
      },
      text: { color: '#cfd3dc' },
    },
  },
  indicator: {
    // MACD 水上(正值)红、水下(负值)绿；VOL 同理红涨绿跌
    bars: [
      {
        upColor: UP_COLOR,
        downColor: DOWN_COLOR,
        noChangeColor: FLAT_COLOR,
      },
    ],
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
    // applyNewData 会清空图上 overlay，数据落地后再重绘标注
    chart.applyNewData(bars.map(toKLineData), false, renderMarks);
    if (silent) error.value = '';
  } catch (e) {
    if (token !== reqToken || silent) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (token === reqToken && !silent) loading.value = false;
  }
}

// ===== agent K 线标注 =====

/** 标注 kind → overlay 名与默认配色 */
const MARK_OVERLAY: Record<SymbolMarkKind, { overlay: string; color: string; label: string }> = {
  price_line: { overlay: 'SM_PRICE_LINE', color: '#ffb000', label: '价位线' },
  point: { overlay: 'simpleAnnotation', color: '#1f6feb', label: '点位' },
  range: { overlay: 'SM_RANGE', color: '#9b6dff', label: '区间' },
  trend_line: { overlay: 'segment', color: '#12b886', label: '趋势线' },
};

/** 同一组 groupId，便于整组清除后重画 */
const MARK_GROUP = 'symbol_marks';

/**
 * 价格文案（标注与分时盘口共用）：低价标的（ETF、低价股）两位小数分不出档位，
 * 0.620 / 0.630 / 0.640 三档会被压成同一个数，统一按 10 元为界切三位。
 */
function fmtPrice(p: number): string {
  return p < 10 ? p.toFixed(3) : p.toFixed(2);
}

/** 水平标注的价格文案：单点是一个价，两点是区间 */
function priceSuffix(m: SymbolMark): string {
  if (m.kind !== 'price_line') return '';
  const prices = m.points.map((p) => p.price).filter((p): p is number => p != null);
  if (prices.length === 0) return '';
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return hi > lo ? ` ${fmtPrice(lo)}~${fmtPrice(hi)}` : ` ${fmtPrice(lo)}`;
}

/** 水平标注用于排布标签的锚价：带取上沿（标签画在带顶部） */
function horizontalMarkAnchor(m: SymbolMark): number | null {
  const prices = m.points.map((p) => p.price).filter((p): p is number => p != null);
  return prices.length ? Math.max(...prices) : null;
}

/** 标注状态后缀：失效与历史线保留在图上但标明状态 */
function statusSuffix(m: SymbolMark): string {
  const status = m.status ?? 'active';
  if (status === 'active') return '';
  if (status === 'invalid') return '（已失效）';
  return `（v${m.planVersion ?? '?'} 历史）`;
}

/**
 * 标注时间字符串 → 时间戳。
 * 裸日期/裸时间（不带时区）按东八区解释；带 Z 或 ±HH:mm 的完整 ISO 串交给 Date 解析。
 * 后端只校验 time 非空、不校验格式，所以两种都可能入库，不能只认一种。
 */
function markTimestamp(time?: string | null): number | undefined {
  if (!time) return undefined;
  const raw = time.trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(raw);
  const ts = m
    ? new Date(`${m[1]}T${m[2] ?? '00:00'}:${m[3] ?? '00'}+08:00`).getTime()
    : Date.parse(raw);
  if (Number.isNaN(ts)) {
    console.warn('[kline] 无法解析标注时间:', time);
    return undefined;
  }
  return ts;
}

/** 图层开关（计划 10.4）：默认只开当前计划与支撑压力，避免图上信息过载 */
const layers = ref({
  currentPlan: true,
  supportResistance: true,
  structure: false,
  manual: true,
  history: false,
});

// 标注独立于 K 线数据的自增 token：切标的时旧标的的标注若后到，不能画到新标的的图上
let marksToken = 0;

/** 拉取该标的的标注（失败静默，不影响图表主流程） */
async function loadMarks(): Promise<void> {
  const token = ++marksToken;
  if (!code.value) {
    marks.value = [];
    return;
  }
  try {
    const list = await api.symbolMarks.list(code.value);
    if (token !== marksToken) return;
    marks.value = list;
  } catch {
    if (token !== marksToken) return;
    marks.value = [];
  }
  renderMarks();
}

/** 标注是否应在当前视图渲染：图层开关 + 周期过滤（price_line 可跨周期） */
function isMarkVisible(m: SymbolMark): boolean {
  const status = m.status ?? 'active';
  const isPlan = !!m.planId;
  if (isPlan) {
    if (status === 'active' && !layers.value.currentPlan) return false;
    if (status !== 'active' && !layers.value.history) return false;
  } else if (!layers.value.manual) {
    return false;
  }
  // 支撑压力单独一层，便于只看关键位
  if (isPlan && (m.role === 'support' || m.role === 'resistance') && !layers.value.supportResistance) {
    return false;
  }
  if (m.role === 'structure' && !layers.value.structure) return false;
  // 周期过滤：价位线跨周期可见，其余只在所属周期
  if (m.kind !== 'price_line' && m.timeframe && m.timeframe !== tab.value) return false;
  return true;
}

/**
 * 给水平标注分配标签横向槽位，价位靠得太近的往右错开一格。
 *
 * ponytail: 用「价差占当前数据价格跨度的比例」估算像素距离，而不是真的去查主图高度与缩放。
 * 天花板是缩放后估算偏保守（可能多错开一格）；要精确的话得改成在 overlay 的
 * createPointFigures 里拿真实 y 坐标做碰撞，那需要跨 overlay 共享状态。
 */
const LABEL_NEAR_RATIO = 0.025;

function assignLabelSlots(items: Array<{ id: string; price: number }>): Map<string, number> {
  const slots = new Map<string, number>();
  if (items.length === 0) return slots;
  const data = chart?.getDataList() ?? [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of data) {
    if (d.low < lo) lo = d.low;
    if (d.high > hi) hi = d.high;
  }
  for (const it of items) {
    if (it.price < lo) lo = it.price;
    if (it.price > hi) hi = it.price;
  }
  const span = hi - lo;
  const near = span > 0 ? span * LABEL_NEAR_RATIO : 0;
  const sorted = [...items].sort((a, b) => a.price - b.price);
  let slot = 0;
  let prev: number | null = null;
  for (const it of sorted) {
    if (prev != null && it.price - prev < near) slot += 1;
    else slot = 0;
    slots.set(it.id, slot);
    prev = it.price;
  }
  return slots;
}

/** 按当前 marks 重绘 overlay；分时视图不叠加标注（点位坐标以 K 线为基准） */
function renderMarks(): void {
  if (!chart) return;
  chart.removeOverlay({ groupId: MARK_GROUP });
  if (tab.value === 'trend') return;
  const visible = marks.value.filter(isMarkVisible);
  // 只有水平标注（价位线/价格带）会因价格接近而叠标签，其余按时间轴分散，无需错位
  const slots = assignLabelSlots(
    visible
      .filter((m) => m.kind === 'price_line')
      .map((m) => ({ id: m.id, price: horizontalMarkAnchor(m) ?? 0 }))
      .filter((it) => it.price > 0),
  );
  for (const m of visible) {
    const cfg = MARK_OVERLAY[m.kind];
    if (!cfg) continue;
    const points = m.points.map((p) => ({
      timestamp: markTimestamp(p.time),
      value: p.price ?? undefined,
    }));
    if (points.length === 0) continue;
    // price_line 只用 value 定位，其余形态依赖时间轴：缺 timestamp 会被画到默认位置，
    // 画错时间点比不画更有误导性，直接整条跳过
    if (m.kind !== 'price_line' && points.some((p) => p.timestamp === undefined)) {
      console.warn('[kline] 标注缺少可解析的时间，已跳过:', m.id);
      continue;
    }
    const status = m.status ?? 'active';
    // 当前计划实线，历史与失效线降透明度并转虚线，不删除（计划 10.4）
    const active = status === 'active';
    const color = active ? m.color || cfg.color : '#6b7280';
    // 价位线带两个点时是价格带（区间型关键位），换成带状 overlay
    const isBand = m.kind === 'price_line' && points.length >= 2;
    chart.createOverlay({
      name: isBand ? 'SM_PRICE_BAND' : cfg.overlay,
      groupId: MARK_GROUP,
      points,
      // 只读展示：锁定禁止拖动，标注的增删改统一由 agent 在对话中完成
      lock: true,
      extendData: {
        text: `${m.label}${priceSuffix(m)}${statusSuffix(m)}`,
        slot: slots.get(m.id) ?? 0,
      } satisfies MarkExtend,
      styles: {
        line: { color, size: 1, style: active ? LineType.Solid : LineType.Dashed },
        // 价格带跟价位线用同一套降级语义：历史/失效转虚线，只变灰不够明显
        polygon: {
          color: `${color}22`,
          borderColor: color,
          borderSize: 1,
          borderStyle: active ? LineType.Solid : LineType.Dashed,
        },
        text: {
          color,
          size: 11,
          backgroundColor: 'rgba(20,24,33,0.85)',
          paddingLeft: 4,
          paddingRight: 4,
        },
      },
    });
  }
}

/** 标注清单（图表下方只读列表）：形态标签 + 点位描述 */
interface MarkRow {
  id: string;
  kindLabel: string;
  color: string;
  label: string;
  where: string;
  note: string;
}
const markRows = computed<MarkRow[]>(() =>
  marks.value.filter(isMarkVisible).map((m) => {
    const cfg = MARK_OVERLAY[m.kind];
    // 价位线的两个点是同一条价格带的上下沿，写成区间；其余形态才是「A → B」的两个位置
    const where =
      m.kind === 'price_line'
        ? priceSuffix(m).trim()
        : m.points
            .map((p) =>
              [p.time, p.price != null ? fmtPrice(p.price) : null].filter(Boolean).join(' '),
            )
            .join(' → ');
    return {
      id: m.id,
      kindLabel: cfg?.label ?? m.kind,
      color: m.color || cfg?.color || FLAT_COLOR,
      label: m.label,
      where,
      note: m.note || '',
    };
  }),
);

/** 加载 S9 技术指标读数（仅 A 股个股；失败静默，不影响图表） */
async function loadIndicators(): Promise<void> {
  indicators.value = null;
  if (!isStock.value || !code.value) return;
  try {
    indicators.value = await api.stockIndicators(code.value);
  } catch {
    indicators.value = null;
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
    // 分时不显示 BOLL / KDJ / RSI（仅 K 线视图有意义）
    chart.removeIndicator(bollPaneId, 'BOLL');
    chart.removeIndicator(kdjPaneId, 'KDJ');
    chart.removeIndicator(rsiPaneId, 'RSI');
    indicators.value = null; // 分时不展示指标读数条
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
    // 分时也展示 MACD（按分钟收盘价计算）。只有一个副图，给它整份副图配额
    chart.createIndicator('MACD', false, { id: macdPaneId, height: subPaneHeight() });
    // 分时锁定为全天框架：禁用缩放与拖动
    chart.setZoomEnabled(false);
    chart.setScrollEnabled(false);
    renderMarks(); // 分时不叠加标注，此处即清除上一个视图的 overlay
    void loadTrends();
  } else {
    trend.value = null; // 离开分时清空盘口数据条
    chart.setStyles({ candle: { type: CandleType.CandleSolid } });
    chart.removeIndicator('candle_pane', 'TS_LINES');
    chart.removeIndicator('candle_pane', 'MA');
    chart.createIndicator('MA', false, { id: 'candle_pane' });
    // MACD + BOLL + KDJ + RSI 独立副图（S9 技术指标库），高度按容器比例分配
    const h = subPaneHeight();
    chart.createIndicator('MACD', false, { id: macdPaneId, height: h });
    chart.createIndicator('BOLL', false, { id: bollPaneId, height: h });
    chart.createIndicator('KDJ', false, { id: kdjPaneId, height: h });
    chart.createIndicator('RSI', false, { id: rsiPaneId, height: h });
    void loadIndicators();
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
  chart.createIndicator('VOL', false, { id: 'vol_pane', height: subPaneHeight() });
  applyView();
  void loadMarks();
  observeResize();
}

/** 窗口尺寸变化时重算副图高度并让图表重绘，避免拉伸窗口后比例失衡 */
function applyPaneHeights(): void {
  if (!chart) return;
  const h = subPaneHeight();
  // 分时视图只保留 VOL + MACD，其余三个副图此时已被移除，不去设它们的高度
  const ids =
    tab.value === 'trend'
      ? ['vol_pane', macdPaneId]
      : ['vol_pane', macdPaneId, bollPaneId, kdjPaneId, rsiPaneId];
  for (const id of ids) chart.setPaneOptions({ id, height: h });
  chart.resize();
}

function observeResize(): void {
  if (!chartEl.value || resizeObserver) return;
  // 弹窗高度用 vh 计算，视口一变副图比例就得跟着重算
  resizeObserver = new ResizeObserver(() => applyPaneHeights());
  resizeObserver.observe(chartEl.value);
}

function teardownChart() {
  stopPoll();
  resizeObserver?.disconnect();
  resizeObserver = null;
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
  indicators.value = null;
  marks.value = [];
  tab.value = 'day';
  // 不重置的话，只要打开过一次 Agent 页签，此后每次开弹窗都会立刻挂载对话栏、
  // 建 WS 并 find-or-create 会话，懒挂载从第二次起就失效了
  sideTab.value = 'plan';
  agentEverOpened.value = false;
  planHorizon.value = 'next_session';
}

const tipText = computed(() =>
  tab.value === 'trend' ? '当日分时 · 多源行情' : '前复权 · 多源行情',
);

/** S9 技术指标读数条单元（dir：1 偏多红 / -1 偏空绿 / 0 中性） */
interface IndCell {
  label: string;
  value: string;
  dir: 1 | 0 | -1;
  /** 悬浮说明，用于交代读数口径 */
  hint?: string;
}

/**
 * 量能强弱着色：放量红、缩量绿。
 * 注意这里的红绿是「量能强弱」不是涨跌方向——放量下跌同样是红，别按涨跌语义改。
 */
function volumeDir(state: VolumeReadout['state']): 1 | 0 | -1 {
  if (state === 'mild_expand' || state === 'clear_expand' || state === 'extreme_expand') return 1;
  if (state === 'mild_shrink' || state === 'clear_shrink' || state === 'extreme_shrink') return -1;
  return 0;
}
const indicatorCells = computed<IndCell[]>(() => {
  const ind = indicators.value;
  if (!ind) return [];
  const cells: IndCell[] = [];
  if (ind.macd) {
    const dir = ind.macd.state === '金叉' || ind.macd.state === '多头' ? 1 : -1;
    cells.push({ label: 'MACD', value: `${ind.macd.state}（DIF ${ind.macd.dif}/DEA ${ind.macd.dea}）`, dir });
  }
  if (ind.kdj) {
    const dir = ind.kdj.signal === '超买' ? 1 : ind.kdj.signal === '超卖' ? -1 : 0;
    cells.push({ label: 'KDJ', value: `K${ind.kdj.k} D${ind.kdj.d} J${ind.kdj.j}（${ind.kdj.signal}）`, dir });
  }
  if (ind.rsi) {
    const dir = ind.rsi.signal === '超买' ? 1 : ind.rsi.signal === '超卖' ? -1 : 0;
    cells.push({ label: 'RSI', value: `6:${ind.rsi.rsi6} 12:${ind.rsi.rsi12} 24:${ind.rsi.rsi24}`, dir });
  }
  if (ind.boll) {
    const dir = ind.boll.pos === '上轨上方' ? 1 : ind.boll.pos === '下轨下方' ? -1 : 0;
    cells.push({ label: 'BOLL', value: `${ind.boll.pos}（%B ${ind.boll.pctB}）`, dir });
  }
  if (ind.volume) {
    const v = ind.volume;
    const live = v.basis === 'realtime';
    const turnover = v.turnoverRate != null ? ` 换手 ${v.turnoverRate}%` : '';
    cells.push({
      label: '量能',
      value: `${live ? '盘中 ' : ''}${v.ratio.toFixed(2)}×（${v.label}）${turnover}`,
      dir: volumeDir(v.state),
      hint: live
        ? '盘中口径：东财实时量比（当前每分钟均量 ÷ 前 5 日每分钟均量，已按时间折算）'
        : '收盘口径：当日成交额 ÷ 前 20 日成交额中位数（分母不含当日）',
    });
  }
  return cells;
});

/** 盘口数据条：从分时点位 + 昨收派生（仅分时 tab 展示） */
interface TrendStat {
  label: string;
  value: string;
  /** 涨跌方向，用于红涨绿跌着色；undefined 为中性 */
  dir?: 1 | 0 | -1;
}

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

// 图层开关变化只需重绘，不必重取数据
watch(layers, () => renderMarks(), { deep: true });

// 切到资金面/筹码再切回图表时容器尺寸变过，重算一次副图高度
watch(viewMode, (m) => {
  if (m === 'chart') void nextTick(applyPaneHeights);
});

// 弹窗打开时若切换到另一标的，重载（指数 code 可能相同，故同时监听 secid）
watch([code, secid], () => {
  viewMode.value = 'chart'; // 切标的回到图表视图
  marks.value = [];
  if (visible.value && chart) void loadMarks();
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
    width="min(1680px, 96vw)"
    top="3vh"
    append-to-body
    destroy-on-close
    class="kline-dialog"
    @opened="onOpened"
    @closed="onClosed"
  >
    <div class="kline-body">
      <div class="kline-main">
        <div class="kline-head">
          <span class="kline-code num">{{ code }}</span>
          <el-radio-group v-if="isStock" v-model="viewMode" size="small">
            <el-radio-button value="chart">图表</el-radio-button>
            <el-radio-button value="capital">资金面</el-radio-button>
            <el-radio-button value="chip">筹码</el-radio-button>
          </el-radio-group>
          <el-radio-group v-show="viewMode === 'chart'" v-model="tab" size="small">
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
          <span v-show="viewMode === 'chart'" class="kline-legend">
            <i class="kline-legend__dot is-up" />红涨
            <i class="kline-legend__dot is-down" />绿跌
          </span>
          <span v-show="viewMode === 'chart'" class="kline-tip">{{ tipText }}</span>
        </div>
        <div v-if="showStats && viewMode === 'chart'" class="kline-quote">
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
        <div v-if="viewMode === 'chart' && indicatorCells.length" class="kline-ind">
          <div
            v-for="c in indicatorCells"
            :key="c.label"
            class="kline-ind__cell"
            :class="{ 'is-up': c.dir === 1, 'is-down': c.dir === -1 }"
            :title="c.hint"
          >
            <span class="kline-ind__label">{{ c.label }}</span>
            <span class="kline-ind__value num">{{ c.value }}</span>
          </div>
        </div>
        <div v-show="viewMode === 'chart'" v-loading="loading" class="kline-wrap">
          <div ref="chartEl" class="kline-chart" />
          <div v-if="error" class="kline-error">{{ error }}</div>
        </div>
        <!-- 图层开关：默认只开当前计划与支撑压力 -->
        <div v-if="viewMode === 'chart' && marks.length" class="kline-layers">
          <span class="kline-layers__label">图层</span>
          <el-checkbox v-model="layers.currentPlan" size="small">当前计划</el-checkbox>
          <el-checkbox v-model="layers.supportResistance" size="small">支撑/压力</el-checkbox>
          <el-checkbox v-model="layers.structure" size="small">结构</el-checkbox>
          <el-checkbox v-model="layers.manual" size="small">手工标注</el-checkbox>
          <el-checkbox v-model="layers.history" size="small">历史/失效</el-checkbox>
        </div>
        <!-- 标注清单（只读；增删改由对话中的 agent 完成） -->
        <div v-if="viewMode === 'chart' && markRows.length" class="kline-marks">
          <div v-for="m in markRows" :key="m.id" class="kline-marks__row">
            <span class="kline-marks__kind" :style="{ color: m.color, borderColor: m.color }">
              {{ m.kindLabel }}
            </span>
            <span class="kline-marks__label">{{ m.label }}</span>
            <span class="kline-marks__where num">{{ m.where }}</span>
            <span v-if="m.note" class="kline-marks__note">{{ m.note }}</span>
          </div>
        </div>
        <CapitalPanel v-if="viewMode === 'capital'" :code="code" class="kline-capital" />
        <ChipPanel v-if="viewMode === 'chip'" :code="code" class="kline-capital" />
      </div>
      <div class="kline-side">
        <el-radio-group v-model="sideTab" size="small" class="kline-side__tabs">
          <el-radio-button value="plan">交易计划</el-radio-button>
          <el-radio-button value="agent">Agent</el-radio-button>
        </el-radio-group>
        <div class="kline-side__body">
          <SymbolTradePlanPanel
            v-if="sideTab === 'plan'"
            :key="planKey"
            v-model:horizon="planHorizon"
            :code="code"
            :name="name"
            @generate="onGeneratePlan"
          />
          <!--
            懒挂载：v-show 会让对话栏在弹窗一打开就建 WS 并 find-or-create 会话，
            只想看 K 线的用户也要付这笔开销。首次切到 Agent 页签后才挂载，之后用 v-show 保住对话状态。
          -->
          <SymbolChatPanel
            v-if="agentEverOpened"
            ref="chatRef"
            v-show="sideTab === 'agent'"
            :code="code"
            :name="name"
            @marks-changed="onAgentDone"
          />
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<!--
  弹窗根元素经 append-to-body 传送出去，不带 scoped 的 data-v 属性，
  scoped 规则（含 :deep）都够不到它，因此这里必须用非 scoped 样式块。
-->
<style>
.kline-dialog .el-dialog__body {
  /* 图表放大后给 body 一个上限并允许内滚，避免标注多时把弹窗撑出视口 */
  max-height: calc(94vh - 60px);
  overflow-y: auto;
}
</style>

<style scoped>
/* 左右分栏：左图表区自适应，右侧标的跟踪对话栏固定宽 */
.kline-body {
  display: flex;
  gap: 12px;
  align-items: stretch;
}
.kline-main {
  flex: 1;
  min-width: 0;
}
.kline-side {
  width: 440px;
  flex-shrink: 0;
  /* 高度跟随左侧图表区（flex stretch），不再写死，避免图表变高后两栏错位 */
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.kline-side__tabs {
  flex-shrink: 0;
}
.kline-side__body {
  flex: 1;
  min-height: 0;
}
.kline-side__body > * {
  height: 100%;
}
/* 图层开关 */
.kline-layers {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 10px;
  padding: 6px 10px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
}
.kline-layers__label {
  color: var(--text-2);
  font-size: 11px;
  font-weight: 600;
}
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
.kline-legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-2);
  font-size: 12px;
}
.kline-legend__dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  margin-left: 8px;
}
.kline-legend__dot:first-child {
  margin-left: 0;
}
.kline-legend__dot.is-up {
  background: #f0454a;
}
.kline-legend__dot.is-down {
  background: #12b886;
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
/* S9 技术指标读数条 */
.kline-ind {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.kline-ind__cell {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 150px;
  padding: 5px 10px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
}
.kline-ind__label {
  color: var(--text-2);
  font-size: 11px;
  font-weight: 600;
}
.kline-ind__value {
  font-size: 12px;
  color: #cfd3dc;
}
.kline-ind__cell.is-up .kline-ind__value {
  color: #f0454a;
}
.kline-ind__cell.is-down .kline-ind__value {
  color: #12b886;
}
.kline-wrap {
  position: relative;
}
/*
 * 图表高度跟随视口：主图 55% + 五个副图各 9%，容器越高每一格越舒展。
 * 减去的是弹窗头、头部工具条、指标读数条、图层开关与标注清单的占位。
 */
.kline-chart {
  width: 100%;
  /*
   * 下限取 460px 而非固定放大值：矮视口（13 寸笔记本视口高约 700px）下
   * body 可用高度不足以容纳更高的图表，硬撑只会把最下面的 RSI/KDJ 挤到滚动区外。
   */
  height: clamp(460px, calc(94vh - 290px), 1100px);
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
/* 标注清单：与指标读数条同密度，只读。
   它是左栏唯一的可变高元素，必须限高内滚，否则标注一多就把弹窗撑出视口 */
.kline-marks {
  margin-top: 10px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  max-height: 132px;
  overflow-y: auto;
}
.kline-marks__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.kline-marks__row:first-child {
  border-top: none;
}
.kline-marks__kind {
  flex-shrink: 0;
  padding: 1px 5px;
  border: 1px solid;
  border-radius: 3px;
  font-size: 10px;
  line-height: 1.5;
}
.kline-marks__label {
  flex-shrink: 0;
  color: #cfd3dc;
  font-weight: 600;
}
.kline-marks__where {
  flex-shrink: 0;
  color: var(--text-2);
}
.kline-marks__note {
  flex: 1;
  min-width: 0;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
