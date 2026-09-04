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
  TrendPoint,
  TrendsResult,
  StockIndicators,
  PriceLevels,
  VolumeReadout,
  SymbolPlanProjection,
  SymbolTradePlan,
  ElliottAnalysis,
  ElliottWaveCount,
  AssertionAccuracy,
} from '@stock-agent/shared';
import {
  ASSERTION_HORIZON_DAYS,
  ASSERTION_REACTION_BARS,
  BREAK_CONFIRM,
  ELLIOTT_MIN_TRUSTED_CONFIDENCE,
  elliottLevelName,
  elliottPassedWord,
  isPlanLineVisible,
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

/** overlay 的 extendData 载荷：文案 + 防重叠槽位 + 推演折线向右延伸几根 bar */
interface MarkExtend {
  text: string;
  slot: number;
  steps?: number;
}

/** 读 extendData（旧数据可能是裸字符串，兜底成 slot 0） */
function readExtend(raw: unknown): MarkExtend {
  if (raw && typeof raw === 'object' && 'text' in raw) {
    const e = raw as Partial<MarkExtend>;
    return {
      text: String(e.text ?? ''),
      slot: Number(e.slot ?? 0) || 0,
      steps: Number(e.steps ?? 0) || 0,
    };
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

/**
 * 波动率锥：从最后一根 bar 向右张开的 ±1σ / ±2σ 区间。
 *
 * 点位传法是「全部锚在最后一根 bar 的时间上，只借它算 y」，x 由 barSpace 自己推。
 * 不用未来时间戳：那要求图表能把不存在的时间映射成坐标，跨周期（尤其分钟线跨日）
 * 很容易算到收盘时段里去，画出来的锥会在右边莫名其妙地断一截。
 *
 * coordinates 约定：[0] 锚点，其后每 4 个一组对应第 n 步的 p2High/p1High/p1Low/p2Low。
 */
registerOverlay({
  name: 'SM_CONE',
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, barSpace }: OverlayCreateFiguresCallbackParams): OverlayFigure[] => {
    const anchor = coordinates[0];
    const n = Math.floor((coordinates.length - 1) / 4);
    if (!anchor || n < 1) return [];
    const xOf = (step: number): number => anchor.x + step * barSpace.bar;
    const band = (hiIdx: number, loIdx: number): Array<{ x: number; y: number }> => {
      const up: Array<{ x: number; y: number }> = [{ x: anchor.x, y: anchor.y }];
      const down: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < n; i += 1) {
        const base = 1 + i * 4;
        up.push({ x: xOf(i + 1), y: coordinates[base + hiIdx].y });
        down.unshift({ x: xOf(i + 1), y: coordinates[base + loIdx].y });
      }
      return [...up, ...down];
    };
    return [
      { type: 'polygon', attrs: { coordinates: band(0, 3) }, styles: { style: 'fill' } },
      { type: 'polygon', attrs: { coordinates: band(1, 2) }, styles: { style: 'fill' } },
    ];
  },
});

/** 情景折线：从现价斜拉到目标/失效位。刻意画成折线而不是蜡烛，一眼看出这是分支示意而非预测行情 */
registerOverlay({
  name: 'SM_PATH',
  totalStep: 3,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, barSpace, overlay }: OverlayCreateFiguresCallbackParams): OverlayFigure[] => {
    const [a, b] = coordinates;
    if (!a || !b) return [];
    const { text, steps } = readExtend(overlay.extendData);
    const x2 = a.x + Math.max(1, steps ?? 1) * barSpace.bar;
    return [
      { type: 'line', attrs: { coordinates: [{ x: a.x, y: a.y }, { x: x2, y: b.y }] } },
      {
        type: 'text',
        ignoreEvent: true,
        attrs: { x: x2, y: b.y - 2, text, align: 'right', baseline: 'bottom' },
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

/**
 * 波浪段：连线 + 终点浪标。
 *
 * 刻意不复用内置 simpleAnnotation：它只认字符串 extendData，且固定向上拉一根 50px 带箭头的杆，
 * 画在浪的低点上时指向是反的，一段 5 浪会插出五根方向错乱的杆。
 * 自己画则能按「终点是高点还是低点」把浪标放到线的外侧。
 */
registerOverlay({
  name: 'SM_WAVE_LEG',
  totalStep: 3,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, overlay }: OverlayCreateFiguresCallbackParams): OverlayFigure[] => {
    const [a, b] = coordinates;
    if (!a || !b) return [];
    const { text } = readExtend(overlay.extendData);
    // 终点比起点高 → 浪标画在终点上方，反之画下方，始终落在浪段外侧不压线
    const up = b.y < a.y;
    return [
      { type: 'line', attrs: { coordinates: [a, b] } },
      {
        type: 'text',
        ignoreEvent: true,
        attrs: {
          x: b.x,
          y: up ? b.y - 4 : b.y + 4,
          text,
          align: 'center',
          baseline: up ? 'bottom' : 'top',
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
// S10 点位测算（黄金分割/枢轴/均线/ATR），点位图层与「距现价 ATR」读数的数据源，跟随当前周期
const levels = ref<PriceLevels | null>(null);
// 波浪计数（多周期浪序 + 目标位 + 时间窗），波浪图层与结论区的数据源，跟随当前周期
const elliott = ref<ElliottAnalysis | null>(null);
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
/**
 * 计划页签空状态点「生成」：切到 Agent 页签跑同一套流程，
 * 让用户能看到取数与落库的完整轨迹，而不是对着一个转圈干等。
 */
async function onGeneratePlan(): Promise<void> {
  agentEverOpened.value = true;
  sideTab.value = 'agent';
  // 对话栏是懒挂载的，要等它渲染出来才拿得到实例
  await nextTick();
  await chatRef.value?.genPlan();
}

let chart: Chart | null = null;
// 自增 token：切换标的/周期时丢弃过期请求
let reqToken = 0;
// 非静默请求专用 token：spinner 只归「最新那一发非静默请求」管。
// 与 reqToken 共用会让先返回的旧请求熄掉仍在飞的新请求的 spinner（快速连切周期时用户看到空图不转圈），
// 完全不判又会在被抢占后永久转圈。
let loadingToken = 0;
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
  // 切到「资金面 / 筹码」时图表被 v-show 隐藏，继续每 10 秒打 fresh=1 回源纯属白烧上游配额
  if (viewMode.value !== 'chart') return;
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
  const myLoading = silent ? 0 : ++loadingToken;
  if (!silent) {
    loading.value = true;
    error.value = '';
  }
  try {
    const period = tab.value === 'trend' ? 'day' : tab.value;
    const limit = MINUTE_TABS.includes(tab.value) ? 320 : 250;
    // silent 即轮询刷新，此时强制后端回源：日线走本地缓存，10 分钟才换一次，
    // 且盘中那根是批量报价合成的近似 bar，不绕过就等于盯着一根不动且振幅失真的当日线。
    // 首屏（silent=false）仍走缓存，保证打开即出图。
    const bars = await api.getKline(code.value, period, limit, secid.value || undefined, silent);
    if (token !== reqToken || !chart) return;
    const next = bars.map(toKLineData);
    const cur = chart.getDataList();
    // applyNewData 的语义是「覆盖全量并重置滚动位置」，还会清空全部 overlay：
    // 盘中每 10 秒轮询走这条路，用户拖动/缩放看历史时会被反复弹回最新一根。
    // 盘中真正在变的只有最后一根，同长同首根时间戳就只 updateData 它。
    // 中位一根的 close 一并比对：除权除息后整段前复权价重算、数据源回补修正历史某根时，
    // 长度与首根都不变，只更新末根的话弹窗开着期间永远看不到这类改写。
    const mid = Math.floor(next.length / 2);
    const sameSeries =
      silent &&
      next.length > 0 &&
      next.length === cur.length &&
      next[0]?.timestamp === cur[0]?.timestamp &&
      next[mid]?.close === cur[mid]?.close;
    if (sameSeries) {
      chart.updateData(next[next.length - 1]!);
    } else {
      chart.applyNewData(next, false, renderOverlays);
    }
    if (silent) error.value = '';
  } catch (e) {
    if (token !== reqToken || silent) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    // 只有最新那一发非静默请求负责熄灭 spinner：被静默轮询抢走 reqToken 不影响（它不管 loading），
    // 被更新的非静默请求接管时也不能抢先熄灭，否则新请求还在飞就已经不转圈了。
    if (!silent && myLoading === loadingToken) loading.value = false;
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
/** 确定性点位（黄金分割/枢轴）单独一组：与计划标注互不清除，图层开关各自控制 */
const DET_GROUP = 'det_levels';
/** 走势推演（波动率锥 + 情景折线）单独一组：画在右侧留白，与实际行情严格分开 */
const PROJ_GROUP = 'projection';
/** 波浪（浪段连线 + 目标位 / 失效价）单独一组，图层开关各自控制 */
const WAVE_GROUP = 'elliott_waves';
/** 多源共振位单独一组 */
const CONFLUENCE_GROUP = 'confluence';
/** 共振位配色：用醒目的琥珀，与所有单源参考位（金/灰蓝/洋红）都拉开 */
const CONFLUENCE_COLOR = '#ffd04b';

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

/** 图层开关默认值。onClosed 要还原，故抽成函数而非字面量共用一个对象 */
function defaultLayers() {
  return {
    currentPlan: true,
    supportResistance: true,
    fib: false,
    pivot: false,
    manual: true,
    history: false,
    // 走势推演默认关：它画在图右侧的留白里，会挤掉一块看盘面积，且是推演不是行情
    projection: false,
    // 波浪默认关：浪段连线横跨大半张图，常态开着会盖住盘面
    elliott: false,
    // 共振位默认**开**：它是各技术层的交集，条数天然少（实测个位数），
    // 且正是「先看哪几个价」这个问题的答案，是唯一值得常驻的一层
    confluence: true,
  };
}

/**
 * 图层开关（计划 10.4）：默认只开当前计划与支撑压力，避免图上信息过载。
 * fib/pivot 是确定性点位测算（S10），默认关——一次全开有 14 条线会糊满主图。
 */
const layers = ref(defaultLayers());

/** 点位线配色：黄金分割走金色系、枢轴走冷灰蓝，与计划线（红/绿/蓝/橙/紫）明显区分 */
const FIB_COLOR = '#c9a227';
const FIB_EXT_COLOR = '#d9b45c';
const PIVOT_COLOR = '#6b7f9e';

/** 一条确定性点位线（不落库，纯前端按当前周期算出来画） */
interface DetLine {
  id: string;
  price: number;
  label: string;
  color: string;
  /** 清单分组用 */
  group: '黄金分割' | '枢轴' | '波浪';
  note: string;
}

/**
 * 由 S10 点位测算派生的水平线。
 * 均线刻意不画：主图已有 MA5/10/30/60 曲线，再画水平线是同一信息画两遍，
 * 只会挤占标签位；均线的支撑/压力读数放在清单里给。
 */
const detLines = computed<DetLine[]>(() => {
  const lv = levels.value;
  if (!lv || tab.value === 'trend') return [];
  const out: DetLine[] = [];
  const dir = lv.swing?.direction === 'down' ? '反弹' : '回撤';
  if (layers.value.fib) {
    for (const f of lv.fibRetracements) {
      out.push({
        id: `fib:r:${f.ratio}`,
        price: f.price,
        label: `${f.ratio} ${fmtPrice(f.price)}`,
        color: FIB_COLOR,
        group: '黄金分割',
        note: `${dir}位 ${f.ratio}`,
      });
    }
    for (const f of lv.fibExtensions) {
      out.push({
        id: `fib:e:${f.ratio}`,
        price: f.price,
        label: `扩展${f.ratio} ${fmtPrice(f.price)}`,
        color: FIB_EXT_COLOR,
        group: '黄金分割',
        note: `顺势扩展目标 ${f.ratio}`,
      });
    }
  }
  if (layers.value.pivot && lv.pivot) {
    const p = lv.pivot;
    const rows: Array<[string, number, string]> = [
      ['PP', p.pp, '枢轴中枢'],
      ['R1', p.r1, '枢轴压力1'],
      ['R2', p.r2, '枢轴压力2'],
      ['R3', p.r3, '枢轴压力3'],
      ['S1', p.s1, '枢轴支撑1'],
      ['S2', p.s2, '枢轴支撑2'],
      ['S3', p.s3, '枢轴支撑3'],
    ];
    for (const [k, v, note] of rows) {
      out.push({
        id: `pivot:${k}`,
        price: v,
        label: `${k} ${fmtPrice(v)}`,
        color: PIVOT_COLOR,
        group: '枢轴',
        note,
      });
    }
  }
  return out.filter((l) => Number.isFinite(l.price) && l.price > 0);
});

/**
 * 判定「这条金色分割线与那条计划线是同一条」的价格容差。
 * 取 0.15% 与 0.12 ATR 的较大者：纯百分比在高波动标的上会漏判，纯 ATR 在停牌后 ATR 塌缩时会失效。
 */
const LEVEL_MATCH_PCT = 0.0015;
const LEVEL_MATCH_ATR = 0.12;

/**
 * 确定性点位与计划价位线的重合匹配。
 *
 * 不做这一步的话，打开黄金分割图层后图上会出现两条几乎重合的线——一条金色虚线、一条计划实线，
 * 而用户无从判断计划采纳的正是这条 0.618，只会觉得线更多更乱。
 * 匹配上的金线不再单独画，改成把它的用途缀到计划线标签上（「触发线 13.45 · 0.618 回撤」），
 * 既去掉了视觉重影，又回答了「这条计划线是怎么来的」。
 *
 * 按价格匹配而不是靠后端给对应关系：计划价位是候选聚类后的中值，与前端按当前周期实时算出的
 * 分割价本就不会逐位相等，给不出精确的 id 对应；而是不是同一条线，看的本来也就是「画在不画得出区别的位置」。
 */
const detPlanMatch = computed(() => {
  const byDet = new Map<string, string>();
  const byMark = new Map<string, string[]>();
  const lv = levels.value;
  const tol = Math.max((lv?.close ?? 0) * LEVEL_MATCH_PCT, (lv?.atr ?? 0) * LEVEL_MATCH_ATR);
  if (!(tol > 0) || detLines.value.length === 0) return { byDet, byMark };
  const planLines = marks.value
    .filter(
      (m) => m.kind === 'price_line' && (m.status ?? 'active') === 'active' && isMarkVisible(m),
    )
    .map((m) => ({ id: m.id, price: horizontalMarkAnchor(m) ?? 0 }))
    .filter((p) => p.price > 0);
  for (const d of detLines.value) {
    let best: { id: string; diff: number } | null = null;
    for (const p of planLines) {
      const diff = Math.abs(p.price - d.price);
      if (diff <= tol && (best == null || diff < best.diff)) best = { id: p.id, diff };
    }
    if (!best) continue;
    byDet.set(d.id, best.id);
    const notes = byMark.get(best.id);
    if (notes) notes.push(d.note);
    else byMark.set(best.id, [d.note]);
  }
  return { byDet, byMark };
});

/** 计划线标签上的来源后缀（该线与哪几条确定性点位重合） */
function sourceSuffix(markId: string): string {
  const notes = detPlanMatch.value.byMark.get(markId);
  return notes && notes.length > 0 ? ` · ${notes.join(' / ')}` : '';
}

/**
 * 关键位距现价多少 ATR：最能说明「这条线够不够得到」，故只把这一个数补到线上。
 * 来源/触碰次数留在下方清单——标签越长越容易触发错位。
 */
function atrDistanceText(price: number): string {
  const lv = levels.value;
  if (!lv?.atr || lv.atr <= 0 || !(lv.close > 0)) return '';
  const d = (price - lv.close) / lv.atr;
  if (!Number.isFinite(d)) return '';
  return ` ${d >= 0 ? '+' : ''}${d.toFixed(1)}ATR`;
}

// 点位测算的自增 token：与标注同理，切标的/切周期后旧请求的结果不得画到新视图上
let levelsToken = 0;

/**
 * 拉取当前周期的确定性点位（失败静默）。
 * 无条件拉而不是等图层打开才拉：ATR 还要供计划线的「距现价」读数用，
 * 且预先拉好可让图层开关点了就立刻出线，不必等一次网络往返。
 */
async function loadLevels(): Promise<void> {
  const token = ++levelsToken;
  if (!code.value || tab.value === 'trend') {
    levels.value = null;
    return;
  }
  try {
    const data = await api.priceLevels(code.value, tab.value, secid.value || undefined);
    if (token !== levelsToken) return;
    levels.value = data;
  } catch {
    if (token !== levelsToken) return;
    levels.value = null;
  }
  renderOverlays();
}

// ===== 波浪计数 =====

/** 与点位同理的自增 token：切标的/切周期后旧请求的结果不得画到新视图上 */
let elliottToken = 0;

/**
 * 拉当前周期的波浪计数（失败静默）。
 * 与点位一样无条件拉、不等图层打开：结论区常驻展示，图层只决定画不画到图上。
 */
async function loadElliott(): Promise<void> {
  const token = ++elliottToken;
  if (!code.value || tab.value === 'trend') {
    elliott.value = null;
    return;
  }
  try {
    const data = await api.elliott(code.value, tab.value, secid.value || undefined);
    if (token !== elliottToken) return;
    elliott.value = data;
  } catch {
    if (token !== elliottToken) return;
    elliott.value = null;
  }
  renderOverlays();
}

/** 浪段与目标位配色：与计划线（红/绿/蓝/橙）、分割线（金）、枢轴（灰蓝）都拉开 */
const WAVE_COLOR = '#e06bd0';
const WAVE_TARGET_COLOR = '#b45ba6';
/** 已被走过的档位：褪成灰紫，读图时一眼分得出「还要去的」和「已经走过的」 */
const WAVE_TARGET_PASSED_COLOR = '#6d5a69';
/** 失效价用暖橙警示，与目标位区分——一个是想去的地方，一个是不能去的地方 */
const WAVE_INVALID_COLOR = '#ff8f3f';

/** 数字浪标转圈号，与 A/B/C letters 一起构成紧凑标签 */
const CIRCLED: Record<string, string> = { '1': '①', '2': '②', '3': '③', '4': '④', '5': '⑤' };
const waveGlyph = (label: string): string => CIRCLED[label] ?? label;

/**
 * 置信度门槛只用来决定文案措辞：后端在低于它时已经不产出 targets 了
 * （见 shared 里该常量的注释——门槛下沉到后端才能让 LLM 底稿与界面口径一致）。
 */
const WAVE_MIN_CONFIDENCE = ELLIOTT_MIN_TRUSTED_CONFIDENCE;

/** 当前周期是否支持波浪：分时没有 K 线时间轴，浪段无从落点 */
const canElliott = computed(() => tab.value !== 'trend' && !!code.value);

/** 主计数（当前级别）；置信度过低时视作不可用 */
const waveMain = computed<ElliottWaveCount | null>(() => {
  const c = elliott.value?.minor;
  if (!c || c.state === 'unclear') return null;
  return c;
});

/** 主计数是否可信到能报目标价 */
const waveTrusted = computed(() => (waveMain.value?.confidence ?? 0) >= WAVE_MIN_CONFIDENCE);

// ===== 多源共振（把各技术层指向同一价位的情况收敛成一条结论）=====

/** 各来源在该标的上的历史遵循率，挂到共振位旁边 */
const srcAccuracy = ref<AssertionAccuracy[]>([]);
let accuracyToken = 0;

async function loadAccuracy(): Promise<void> {
  const token = ++accuracyToken;
  if (!code.value || !/^\d{6}$/.test(code.value)) {
    srcAccuracy.value = [];
    return;
  }
  try {
    const list = await api.assertions.bySource(code.value);
    if (token !== accuracyToken) return;
    srcAccuracy.value = list;
  } catch {
    if (token !== accuracyToken) return;
    srcAccuracy.value = [];
  }
}

/** 断言来源 → 中文名，与战绩页同一套词 */
const SRC_NAME: Record<string, string> = {
  elliott: '波浪',
  fib: '黄金分割',
  pivot: '枢轴',
  ma: '均线',
  chan: '缠论中枢',
  dow: '前高前低',
};

/** 参与共振聚类的一个原始价位 */
interface RawLevel {
  price: number;
  source: keyof typeof SRC_NAME;
  detail: string;
}

/**
 * 从**前端已经持有的数据**里收集各来源价位。
 *
 * 后端的 candidateCatalog 也做同样的聚类，但它长在 agent 的重上下文里（prepareContext 要
 * 取多周期证据、广度、大盘阶段），为详情页拉一次不值。这里用的是 /levels 与 /elliott
 * 已经返回的同一批原始数据，聚出来的共振结论一致，且零新增请求。
 */
const rawLevels = computed<RawLevel[]>(() => {
  const out: RawLevel[] = [];
  const lv = levels.value;
  if (lv) {
    for (const f of lv.fibRetracements) out.push({ price: f.price, source: 'fib', detail: `回撤 ${f.ratio}` });
    for (const f of lv.fibExtensions) out.push({ price: f.price, source: 'fib', detail: `扩展 ${f.ratio}` });
    if (lv.pivot) {
      const p = lv.pivot;
      for (const [k, v] of [['PP', p.pp], ['R1', p.r1], ['R2', p.r2], ['S1', p.s1], ['S2', p.s2]] as Array<[string, number]>) {
        out.push({ price: v, source: 'pivot', detail: k });
      }
    }
    if (lv.ma?.supportMa) out.push({ price: lv.ma.supportMa.value, source: 'ma', detail: `MA${lv.ma.supportMa.period} 支撑` });
    if (lv.ma?.resistanceMa) out.push({ price: lv.ma.resistanceMa.value, source: 'ma', detail: `MA${lv.ma.resistanceMa.period} 压力` });
    if (lv.swing) {
      out.push({ price: lv.swing.high, source: 'dow', detail: `波段高 ${lv.swing.highTime}` });
      out.push({ price: lv.swing.low, source: 'dow', detail: `波段低 ${lv.swing.lowTime}` });
    }
  }
  const c = waveMain.value;
  if (c && waveTrusted.value) {
    for (const t of c.targets) out.push({ price: t.price, source: 'elliott', detail: `${c.currentLabel}浪 ${t.ratio}` });
    if (c.invalidationPrice != null) {
      out.push({ price: c.invalidationPrice, source: 'elliott', detail: '失效价' });
    }
  }
  return out.filter((l) => Number.isFinite(l.price) && l.price > 0);
});

/** 一簇共振位 */
interface Confluence {
  id: string;
  price: number;
  /** 参与的来源（去重） */
  sources: Array<keyof typeof SRC_NAME>;
  /** 每个来源具体是哪一档 */
  details: string[];
  /** 距现价多少 ATR，判断够不够得着 */
  atrDist: number | null;
}

/**
 * 把彼此贴得足够近的价位聚成一簇。
 * 容差直接复用计划线与分割线的那套（0.15% 与 0.12ATR 取大者）——
 * 「近到画在图上分不出两条线」正是共振该用的判据，没必要另立一个阈值。
 */
const confluences = computed<Confluence[]>(() => {
  const lv = levels.value;
  const tol = Math.max((lv?.close ?? 0) * LEVEL_MATCH_PCT, (lv?.atr ?? 0) * LEVEL_MATCH_ATR);
  const raw = [...rawLevels.value].sort((a, b) => a.price - b.price);
  if (!(tol > 0) || raw.length === 0) return [];
  const clusters: RawLevel[][] = [];
  for (const l of raw) {
    const last = clusters[clusters.length - 1];
    if (last && l.price - last[last.length - 1].price <= tol) last.push(l);
    else clusters.push([l]);
  }
  const atr = lv?.atr ?? 0;
  const close = lv?.close ?? 0;
  return clusters
    .map((c, i) => {
      const price = c.reduce((s, x) => s + x.price, 0) / c.length;
      const sources = [...new Set(c.map((x) => x.source))];
      return {
        id: `cf:${i}:${price.toFixed(3)}`,
        price,
        sources,
        details: c.map((x) => `${SRC_NAME[x.source]}${x.detail ? ` ${x.detail}` : ''}`),
        atrDist: atr > 0 && close > 0 ? (price - close) / atr : null,
      };
    })
    // 共振源多的排前面；同样多时离现价近的优先（先要面对的那个）
    .sort(
      (a, b) =>
        b.sources.length - a.sources.length ||
        Math.abs(a.atrDist ?? 99) - Math.abs(b.atrDist ?? 99),
    );
});

/**
 * 两套以上方法指向才算「强」。这个门槛只用于两件事：图上画不画、表里高不高亮。
 *
 * 表格本身**列全部价位**，不再过滤。早先默认只列强位时，速读卡挑出的最近阻力
 * 若恰好是单套方法给的，它在下方表里就找不到——数据没错，但两处口径不一致，
 * 看着像 bug。细节区已经整体折叠，多列几行不构成干扰，反倒省掉一个子开关。
 */
const MIN_CONFLUENCE = 2;
/** 图上只画强位：13 条线全画上去，图就没法看了 */
const strongConfluences = computed(() => confluences.value.filter((c) => c.sources.length >= MIN_CONFLUENCE));

/** 某来源的历史遵循率文案，取不到或样本不足时返回空串（不编） */
function srcRateText(source: string): string {
  const a = srcAccuracy.value.find((x) => x.key === source);
  if (!a || a.rate == null) return '';
  return `${(a.rate * 100).toFixed(0)}%`;
}

// ===== 速读卡片：只回答「现在在哪、上面撞哪、下面撑哪」=====

/** 速读卡片里的一档关键位 */
interface LeadLevel {
  price: string;
  /** 距现价百分比，如 '1.9%' */
  gapPct: string;
  atrDist: string;
  /** 几套方法同时指向 */
  sourceCount: number;
  sourceNames: string;
  /** 历史上这类位子挡住/撑住的比例，样本不足为空串 */
  rateText: string;
  /** 已判定样本数，为 0 表示这个比例是空的 */
  sampleN: number;
  /**
   * 历史遵循率偏低。
   *
   * 刻意不说「不如抛硬币」：判定口径是「摸到后 5 根内反向走出 ≥1 ATR」，
   * 它先验并不是五五开的二分类，没做同波动率随机对照之前，说它「劣于随机」
   * 是在编一个没验过的基线。能说的只是「历史上这类位子只有这么点比例真起了作用」。
   */
  weak: boolean;
  /** 价格已贴到这一档，值得把确认清单摊开看 */
  testing: boolean;
  /** 三条件清单，仅 testing 档铺开；量价数据缺失时为空数组 */
  conds: BreakCond[];
  /** 一句话结论：已确认 / 穿越了但没确认 / 还没碰 */
  breakVerdict: string;
  /** 未铺开时给的一行规则摘要 */
  ruleText: string;
}

/** 三条件里的一条：文案 + 今日实值 + 是否已满足 */
interface BreakCond {
  label: string;
  actual: string;
  ok: boolean;
  /** 该条取不到数（不是没满足）。未知不能当成不满足，否则会把「不知道」说成「不成立」 */
  unknown?: boolean;
}

/** 一层可达性档次：上下各一档 */
interface LeadTier {
  key: string;
  label: string;
  /** 该层的 ATR 距离范围文案 */
  range: string;
  resistance: LeadLevel | null;
  support: LeadLevel | null;
}

/**
 * 可达性分层的 ATR 边界。
 *
 * 用 ATR 倍数而不是百分比：同样是 ±2%，低波动标的要走一个月，
 * 半导体设备 ETF（日均振幅 6.4%）开盘半小时就穿了。ATR 是相对量，
 * 不同波动率的标的自动适配，不需要逐票调参。
 */
const TIER_BOUNDS: Array<{ key: string; label: string; range: string; max: number }> = [
  { key: 'intraday', label: '今天就可能碰到', range: '一天常见波动之内', max: 1 },
  { key: 'swing', label: '这几天可能碰到', range: '一到三天的波动距离', max: 3 },
  { key: 'mid', label: '更远的位置', range: '三天以上的波动距离', max: Infinity },
];

/** 低于这个遵循率的档位仍展示（日内要看），但打上警告 */
const WEAK_RATE = 0.5;

/**
 * 该簇的历史遵循率：各来源按**样本量加权**平均。
 *
 * 不用简单平均：一个只有 12 笔样本的来源和一个 600 笔的来源，简单平均会让前者
 * 与后者等权，几笔噪声就能把整簇的可信度拉高或拉低。样本不足的来源直接不参与，
 * 全都不足则整段不显示——宁可不给这个数，也不给一个凑出来的数。
 */
function clusterRate(sources: string[]): { rate: number | null; n: number } {
  let wsum = 0;
  let n = 0;
  for (const s of sources) {
    const a = srcAccuracy.value.find((x) => x.key === s);
    if (!a || a.rate == null || a.settled <= 0) continue;
    wsum += a.rate * a.settled;
    n += a.settled;
  }
  return n > 0 ? { rate: wsum / n, n } : { rate: null, n: 0 };
}

/**
 * 距现价多少 ATR 之内算「正在被测试」，值得把确认清单摊开。
 *
 * 用距离而不是「盘中是否触及」：卡片里的档位按定义就在现价上/下方，
 * 现价永远没穿过它，拿收盘价判触及恒为假。0.5 ATR 是半天振幅，
 * 落在这个范围内的档当天大概率会被摸到，正是需要看确认条件的时刻。
 */
const TESTING_ATR = 0.5;

/**
 * 这一次穿越算不算数。
 *
 * 与后端 symbolPlans/volumePrice 的 breakout_confirmed / heavy_down **共用同一套量能门槛**
 * （BREAK_CONFIRM，前端不自定阈值），但**结构条件是按档位替换过的**：后端问的是
 * 「有没有越过近 20 根最高收盘」，这里问的是「有没有越过你正在看的这一档」。
 * 这是刻意的改写而不是照搬——两者对同一根 K 线可能给出不同结论，别把这里的判定
 * 与后端的 pattern 字段混为一谈。
 *
 * 注意这与遵循率是**两个口径**：遵循率是回溯统计（摸到后 5 根内反不反向），
 * 这里是前瞻判据（今天收盘就能判）。模板上必须分开写。
 */
function breakConds(price: number, close: number, up: boolean, vp: PriceLevels['volumePrice']): BreakCond[] {
  const ratio = vp?.basis?.ratio ?? null;
  const loc = vp?.closeLocation ?? null;
  const minRatio = up ? BREAK_CONFIRM.upVolumeRatio : BREAK_CONFIRM.downVolumeRatio;
  const basisName = vp?.basis?.source === 'volume' ? '成交量比' : '成交额比';
  // 价格这一条永远算得出来，不能因为量能取不到就整份清单为空——
  // 早先那样写会让「价格已经穿过去了」被显示成「还没站上」，正好说反
  return [
    {
      label: up ? `收盘站上 ${fmtPrice(price)}` : `收盘跌破 ${fmtPrice(price)}`,
      actual: `今收 ${fmtPrice(close)}`,
      ok: up ? close > price : close < price,
    },
    {
      label: `${basisName}放大到平时的 ${minRatio} 倍以上（比近 20 天的中间水平）`,
      actual: ratio == null ? '数据不足' : `${ratio.toFixed(2)} 倍`,
      ok: ratio != null && ratio >= minRatio,
      unknown: ratio == null,
    },
    {
      label: up
        ? '收在当天波动区间的上沿附近（不是冲高回落）'
        : '收在当天波动区间的下沿附近（不是杀低反弹）',
      actual: loc == null ? '数据不足' : loc.toFixed(2),
      ok:
        loc != null &&
        (up ? loc >= BREAK_CONFIRM.upCloseLocation : loc <= BREAK_CONFIRM.downCloseLocation),
      unknown: loc == null,
    },
  ];
}

function toLeadLevel(c: Confluence, close: number, up: boolean, vp: PriceLevels['volumePrice']): LeadLevel {
  const { rate, n } = clusterRate(c.sources);
  const conds = breakConds(c.price, close, up, vp);
  const crossed = conds[0]?.ok ?? false;
  const allOk = conds.length > 0 && conds.every((x) => x.ok);
  const word = up ? '突破' : '跌破';
  /**
   * 未收盘时**绝不说「已确认」**。
   *
   * 收盘价与收盘位置这两条在收盘前都还会变，后端 computeVolumePrice 在
   * completeBar=false 时干脆把 pattern 置空、并写明「不构成确认」。
   * 早先这里照样先写「已确认突破」再补一句「仅盘中参考」，等于同一行里
   * 先下结论再撤回——盘中扫一眼只会看见前半句。
   */
  const closed = vp?.completeBar !== false;
  // 未知 ≠ 未满足：量能取不到时只能说「判不了」，说成「假突破嫌疑」是把不知道当成了不成立
  const anyUnknown = conds.some((c) => c.unknown);
  let breakVerdict = `还没${up ? '站上' : '跌破'}`;
  if (allOk) breakVerdict = closed ? `已确认${word}` : `盘中三条件暂时齐了，收盘不变才算数`;
  else if (crossed && anyUnknown) breakVerdict = `价格已穿越，但量价数据不足，暂时判不了`;
  else if (crossed) {
    breakVerdict = closed
      ? `穿过去了，但没获量能确认（假${word}嫌疑）`
      : `盘中已穿过去，量能还不够；收盘前都不算数`;
  } else if (!closed) breakVerdict += '（当日未收盘）';
  const minRatio = up ? BREAK_CONFIRM.upVolumeRatio : BREAK_CONFIRM.downVolumeRatio;
  return {
    price: fmtPrice(c.price),
    gapPct: `${(Math.abs(c.price - close) / close * 100).toFixed(1)}%`,
    atrDist: c.atrDist == null ? '' : `${c.atrDist >= 0 ? '+' : ''}${c.atrDist.toFixed(1)}ATR`,
    sourceCount: c.sources.length,
    sourceNames: c.sources.map((s) => SRC_NAME[s]).join('/'),
    rateText: rate == null ? '' : `${(rate * 100).toFixed(0)}%`,
    sampleN: n,
    weak: rate != null && rate < WEAK_RATE,
    testing: c.atrDist != null && Math.abs(c.atrDist) < TESTING_ATR,
    conds,
    breakVerdict,
    ruleText: `算数的${word}要三样齐：收盘穿过去、成交放大到平时 ${minRatio} 倍、收在当天${up ? '上' : '下'}沿`,
  };
}

/**
 * 同层内挑哪一档：先看历史遵循率，再看几套方法指向，最后才看远近。
 *
 * 刻意不是「离得最近的优先」。近处那一档往往是枢轴或均线给的——实测这两个来源
 * 在 600 笔样本上只有 44%，先撞到不等于值得看。层内已经按可达性圈定了范围，
 * 在这个范围里当然该挑最靠得住的那个。
 */
function pickInTier(list: Confluence[]): Confluence | null {
  if (list.length === 0) return null;
  return [...list].sort((a, b) => {
    const ra = clusterRate(a.sources).rate ?? 0;
    const rb = clusterRate(b.sources).rate ?? 0;
    return (
      rb - ra || b.sources.length - a.sources.length || Math.abs(a.atrDist ?? 99) - Math.abs(b.atrDist ?? 99)
    );
  })[0];
}

/**
 * 速读卡片。数据全部来自已加载的 levels 与 confluences，不新增任何请求。
 *
 * 上下各按可达性分三层给档，而不是只给最近的一档。只给最近那档时，高波动标的上
 * 拿到的永远是 ±0.2 ATR 的枢轴位——那是当天振幅的三分之一，必然被打破，
 * 看着像阈值其实是噪声。分层之后「今天就会碰的」与「真正的坎」一眼分得开。
 *
 * 遵循率偏低的档位照样展示（日内仍要看），但打上 weak 标记由模板显著警告。
 */
const leadCard = computed(() => {
  const lv = levels.value;
  const close = lv?.close ?? 0;
  if (!(close > 0) || tab.value === 'trend') return null;
  const all = confluences.value;
  const atr = lv?.atr ?? 0;
  const vp = lv?.volumePrice ?? null;

  // ATR 取不到就分不了层（距离没有量纲），退回单层「附近」，仍给上下各一档
  const tiers: LeadTier[] = [];
  if (atr > 0) {
    let lower = 0;
    for (const t of TIER_BOUNDS) {
      const inTier = (c: Confluence): boolean => {
        const d = Math.abs(c.atrDist ?? 0);
        return d >= lower && d < t.max;
      };
      const res = pickInTier(all.filter((c) => c.price > close && inTier(c)));
      const sup = pickInTier(all.filter((c) => c.price < close && inTier(c)));
      lower = t.max;
      if (!res && !sup) continue;
      tiers.push({
        key: t.key,
        label: t.label,
        range: t.range,
        resistance: res ? toLeadLevel(res, close, true, vp) : null,
        support: sup ? toLeadLevel(sup, close, false, vp) : null,
      });
    }
  } else {
    const res = all.filter((c) => c.price > close).sort((a, b) => a.price - b.price)[0];
    const sup = all.filter((c) => c.price < close).sort((a, b) => b.price - a.price)[0];
    if (res || sup) {
      tiers.push({
        key: 'near',
        label: '附近',
        range: '缺 ATR，无法分层',
        resistance: res ? toLeadLevel(res, close, true, vp) : null,
        support: sup ? toLeadLevel(sup, close, false, vp) : null,
      });
    }
  }

  // 区间位置仍按**最近的**上下一档算：它回答的是「眼下卡在哪」，与分层挑选无关
  const nearestUp = all.filter((c) => c.price > close).sort((a, b) => a.price - b.price)[0];
  const nearestDown = all.filter((c) => c.price < close).sort((a, b) => b.price - a.price)[0];
  const posPct =
    nearestUp && nearestDown && nearestUp.price > nearestDown.price
      ? Math.round(((close - nearestDown.price) / (nearestUp.price - nearestDown.price)) * 100)
      : null;

  return {
    close: fmtPrice(close),
    periodLabel: TAB_LABEL[tab.value] ?? tab.value,
    maAlignment: lv?.ma?.alignment ?? '',
    /** 1 ATR 的绝对值与百分比，卡片要用它解释「遵循」的幅度门槛 */
    atrText: atr > 0 ? `${fmtPrice(atr)}（${lv?.atrPct ?? '?'}%）` : '',
    tiers,
    nearestUp: nearestUp ? fmtPrice(nearestUp.price) : '',
    nearestDown: nearestDown ? fmtPrice(nearestDown.price) : '',
    posPct,
  };
});

/** 周期中文名，速读卡片的状态行用 */
const TAB_LABEL: Record<string, string> = {
  trend: '分时',
  '5m': '5分钟',
  '15m': '15分钟',
  '30m': '30分钟',
  '60m': '60分钟',
  '120m': '120分钟',
  day: '日线',
  week: '周线',
  month: '月线',
};

/** 折叠开关：默认只看速读卡片，细节按需展开 */
const showDetail = ref(false);

/**
 * 波浪派生的水平线：目标位 + 失效价。
 * 置信度不够时只留失效价——目标价是「往哪走」的猜测，失效价是「猜错了怎么知道」的判据，
 * 后者在结构不清晰时反而更该留着。
 */
const waveLines = computed<DetLine[]>(() => {
  const c = waveMain.value;
  if (!layers.value.elliott || !canElliott.value || !c) return [];
  const out: DetLine[] = [];
  if (waveTrusted.value) {
    const close = elliott.value?.close ?? 0;
    const up = c.currentDirection === 'up';
    const name = elliottLevelName(c.currentLabel, c.currentDirection);
    for (const t of c.targets) {
      // 已被走过的档位保留但降权：它不再是「可能停下的位置」，与仍有效的那条画得一样重会看不出区别
      const reached = close > 0 && (up ? close >= t.price : close <= t.price);
      out.push({
        id: `wave:t:${t.ratio}`,
        price: t.price,
        label:
          `${name} ${fmtPrice(t.price)}（${t.ratio}` +
          (reached ? `·${elliottPassedWord(c.currentDirection)}` : '') +
          '）',
        color: reached ? WAVE_TARGET_PASSED_COLOR : WAVE_TARGET_COLOR,
        group: '波浪',
        note: t.note,
      });
    }
  }
  if (c.invalidationPrice != null) {
    out.push({
      id: 'wave:inv',
      price: c.invalidationPrice,
      label: `波浪失效 ${fmtPrice(c.invalidationPrice)}`,
      color: WAVE_INVALID_COLOR,
      group: '波浪',
      note: `跌破/涨破此价则当前${waveGlyph(c.currentLabel ?? '')}浪计数作废`,
    });
  }
  return out.filter((l) => Number.isFinite(l.price) && l.price > 0);
});

// ===== 波浪解读（LLM，按需触发）=====

const waveText = ref('');
const waveTexting = ref(false);
const waveTextError = ref('');

/** 换标的/换周期后旧解读必须作废：它是对另一套计数说的话 */
function resetWaveText(): void {
  waveText.value = '';
  waveTextError.value = '';
}

/**
 * 请模型把计数翻成人话。后端按「标的+周期+最新 bar」缓存，
 * 同一根 bar 内重复点不会重复计费，所以这里不再自己做防重复，只挡并发。
 */
async function interpretWave(): Promise<void> {
  const reqTab = tab.value;
  // 分时没有 K 线时间轴，浪序无从谈起；这里显式排除也让 reqTab 收窄到 KlinePeriod
  if (waveTexting.value || !code.value || reqTab === 'trend') return;
  waveTexting.value = true;
  waveTextError.value = '';
  const reqCode = code.value;
  try {
    const res = await api.elliottInterpret(reqCode, reqTab, secid.value || undefined);
    // 请求期间用户可能已切标的或切周期，此时这段解读说的不是眼前这张图
    if (reqCode !== code.value || reqTab !== tab.value) return;
    waveText.value = res.text;
  } catch (e) {
    if (reqCode !== code.value || reqTab !== tab.value) return;
    waveTextError.value = e instanceof Error ? e.message : String(e);
  } finally {
    waveTexting.value = false;
  }
}

/** 结论区里一套计数的展示行 */
interface WaveRow {
  key: string;
  /** 级别名，如「周线级」 */
  degree: string;
  /** 主计数 / 备选计数 */
  role: string;
  /** 当前处于第几浪的描述 */
  position: string;
  confidence: number;
  /** 这一浪可能停下的位置该叫什么，如「反弹见顶位」，与图上标签同一来源 */
  levelName: string;
  /** 各档位；为空时看 targetsHint */
  targets: WaveTargetCell[];
  /** 没有档位时的说明（置信度不足 / 无理论依据 / 会自我证伪） */
  targetsHint: string;
  /** 首选参考（价位 + 预计日期）；给不出时为 null */
  primary: WavePrimaryCell | null;
  invalid: string;
  timeWindow: string;
  /** 进行中那一浪的子浪，如 Ba/Bb/Bc */
  subLegs: Array<{ key: string; label: string; range: string; running: boolean }>;
  /** 子浪口径说明 */
  subNote: string;
}

/** 结论区里的首选参考：一个可直接对照的价位与日期 */
interface WavePrimaryCell {
  price: string;
  ratio: string;
  date: string;
  title: string;
}

/** 结论区里的一个见顶/见底位 */
interface WaveTargetCell {
  key: string;
  /** 价格文案 */
  price: string;
  /** 斐波那契比例 */
  ratio: string;
  /** 价格已经走过这一档 */
  reached: boolean;
  /** 已走过时的说法：上行叫已突破、下行叫已跌破 */
  passedWord: string;
  /** 悬浮说明，交代这个比例是怎么算出来的 */
  title: string;
}

/**
 * 把后端给的比例位整理成「这一浪可能停下的位置」。
 *
 * 两件事必须在界面上说清楚，否则「为什么有两个价」是必然的疑问：
 * 1. 它们是**并列**的候选（浅、深两档），不是「先到 A 再到 B」的阶段目标；
 * 2. 价格常常已经越过靠近的那一档——它不再是有效的停步位，必须标出来。
 * 排序按当前浪的行进方向由近到远，让「下一个可能停下的位置」永远排在最后一个未走过项。
 */
function toTargetCells(c: ElliottWaveCount, close: number): WaveTargetCell[] {
  const up = c.currentDirection === 'up';
  const passedWord = elliottPassedWord(c.currentDirection);
  return [...c.targets]
    .sort((a, b) => (up ? a.price - b.price : b.price - a.price))
    .map((t) => ({
      key: t.ratio,
      price: fmtPrice(t.price),
      ratio: t.ratio,
      reached: close > 0 && (up ? close >= t.price : close <= t.price),
      passedWord,
      title: t.note,
    }));
}

/** 一套计数 → 展示行；unclear 的照样列出来，明说结构不清晰好过悄悄隐藏 */
function toWaveRow(
  c: ElliottWaveCount | null,
  key: string,
  role: string,
  close: number,
): WaveRow | null {
  if (!c) return null;
  const trusted = c.confidence >= WAVE_MIN_CONFIDENCE;
  const dir = c.currentDirection === 'up' ? '上行' : '回落';
  const position =
    c.state === 'unclear' || !c.currentLabel
      ? '结构不清晰'
      : /[ABC]/.test(c.currentLabel)
        ? `调整 ${c.currentLabel} 浪${dir}中`
        : `第 ${c.currentLabel} 浪${dir}中`;
  const targets = trusted ? toTargetCells(c, close) : [];
  const p = trusted ? c.primary : null;
  return {
    key,
    degree: c.degreeLabel,
    role,
    position,
    confidence: c.confidence,
    levelName: elliottLevelName(c.currentLabel, c.currentDirection),
    targets,
    targetsHint: !trusted ? '置信度偏低，不给参考位' : targets.length ? '' : '无可用参考位',
    primary:
      p && p.price != null
        ? {
            price: fmtPrice(p.price),
            ratio: p.ratio ?? '',
            date: p.date ?? '',
            title: p.note,
          }
        : null,
    invalid: c.invalidationPrice != null ? fmtPrice(c.invalidationPrice) : '—',
    timeWindow: c.timeWindow
      ? `${c.timeWindow.fromDate} ~ ${c.timeWindow.toDate}（约 ${c.timeWindow.bars} 根）`
      : '—',
    subLegs: (c.subdivision?.legs ?? []).map((l) => ({
      key: l.label,
      label: l.label,
      range: `${fmtPrice(l.fromPrice)} → ${fmtPrice(l.toPrice)}`,
      running: !l.completed,
    })),
    subNote: c.subdivision?.note ?? '',
  };
}

/** 结论区行：大级别 → 当前级别 → 高一度读法 → 备选计数 */
const waveRows = computed<WaveRow[]>(() => {
  const a = elliott.value;
  if (!a) return [];
  return [
    toWaveRow(a.major, 'major', '大级别', a.close),
    toWaveRow(a.minor, 'minor', '当前级别', a.close),
    toWaveRow(a.contextual, 'ctx', '高级别读法', a.close),
    toWaveRow(a.alternate, 'alt', '备选计数', a.close),
  ].filter((r): r is WaveRow => r !== null);
});

/**
 * 两种读法的差异说明。只在高一度读法真的产出 B 浪时才提示——
 * 这时它与「当前级别」指的是同一段走势、价位相同，唯一分歧在这一浪之后，
 * 不点破的话用户会以为界面给了两个互相打架的结论。
 */
const waveReadingLegend = computed(() => {
  const c = elliott.value?.contextual;
  const m = elliott.value?.minor;
  if (!c || c.currentLabel !== 'B' || !m?.currentLabel) return '';
  const down = c.legs[0] ? c.legs[0].toPrice < c.legs[0].fromPrice : true;
  // 字母浪不能套「第 X 浪」的说法，会读成「第 A 浪」
  const minorName = /[ABC]/.test(m.currentLabel) ? `${m.currentLabel} 浪` : `第 ${m.currentLabel} 浪`;
  const levelName = elliottLevelName(c.currentLabel, c.currentDirection);
  return (
    `「当前级别」与「高级别读法」说的是同一段走势，${levelName}完全相同，分歧只在这一浪之后：` +
    `按前者（${minorName}）后面还有一跌一涨、仍有${down ? '上行' : '下行'}空间；` +
    `按后者（B 浪）则本浪走完直接进 C 浪，有创新${down ? '低' : '高'}的含义。`
  );
});

/** 见顶/见底位的口径说明，只在确实列出了多档时才占一行 */
const waveTargetLegend = computed(() =>
  waveRows.value.some((r) => r.targets.length > 1)
    ? '见顶位／见底位 = 这一浪可能停下来的价位，按斐波那契比例算出浅、深两档，两档互为备选、不是先到一个再到另一个；' +
      '价格通常在其中某一档附近转向。标了「已突破／已跌破」的表示价格已经走过它，那一档不再是有效的停步位。'
    : '',
);

/**
 * 走势推演数据（计划 S5）。两层刻意分开：
 * cone 是纯算术的散布范围（不含方向判断），plan.scenarios 的概率是模型主观估计（未经校准）。
 * 概率在这里只用于折线标签文案，不参与任何坐标或阈值计算。
 */
const projection = ref<SymbolPlanProjection | null>(null);
const projectionPlan = ref<SymbolTradePlan | null>(null);
let projectionToken = 0;

/** 向右推演几根 bar。5 个交易日 = 一周，与计划面板「短期 = 本周内」同口径 */
const PROJECTION_STEPS = 5;

/** 推演只对日线口径有意义：σ 是按日收益估的，画到 60 分钟图上尺度对不上 */
const canProject = computed(() => tab.value === 'day' && !!code.value);

/** 拉推演数据（失败静默，图层自动空着而不是弹错打断看盘） */
async function loadProjection(): Promise<void> {
  const token = ++projectionToken;
  if (!layers.value.projection || !canProject.value) {
    projection.value = null;
    projectionPlan.value = null;
    return;
  }
  try {
    const [proj, plan] = await Promise.all([
      api.symbolPlans.projection(code.value, PROJECTION_STEPS, secid.value || undefined),
      api.symbolPlans.active(code.value),
    ]);
    if (token !== projectionToken) return;
    projection.value = proj;
    projectionPlan.value = plan;
  } catch {
    if (token !== projectionToken) return;
    projection.value = null;
    projectionPlan.value = null;
  }
  renderOverlays();
}

/** 推演区口径说明。锥是量级参考不是置信区间，情景概率是模型主观估计，两句都必须写明 */
const projectionNote = computed(() => {
  if (!canProject.value) return '走势推演按日线波动估算，仅在日 K 视图可用';
  const cone = projection.value?.cone;
  if (!cone) return '样本不足，未生成波动率锥';
  const pct = (cone.sigmaDaily * 100).toFixed(2);
  const paths = scenarioPaths.value.length;
  return (
    `未来 ${PROJECTION_STEPS} 个交易日波动率锥：按近 ${cone.sampleSize} 日波动（日 σ ${pct}%）张开，` +
    `内浅外深两层为 ±1σ / ±2σ，是量级参考而非置信区间` +
    (paths > 0 ? `；${paths} 条虚线为计划情景示意，所标概率为模型主观估计、未经校准` : '')
  );
});

/** 情景折线配色：主路径蓝、备选灰、风险橙，与计划线同一套语义 */
const PATH_COLOR: Record<'primary' | 'alternative' | 'risk', string> = {
  primary: '#1f6feb',
  alternative: '#8b93a7',
  risk: '#ffb000',
};

/**
 * 情景折线：从最后收盘价拉到该情景的目标位。
 * 概率只进标签文案；取不到目标位的情景不画——凭空给一条线的终点等于编一个目标价。
 */
const scenarioPaths = computed(() => {
  const plan = projectionPlan.value;
  const base = projection.value?.cone?.basePrice;
  if (!plan || !(base && base > 0)) return [];
  const pctById = new Map(projection.value?.scenarios.map((s) => [s.id, s.probabilityPct]) ?? []);
  const out: Array<{ id: string; from: number; to: number; text: string; color: string }> = [];
  for (const sc of plan.scenarios) {
    const lv = plan.levels.find((l) => sc.targetLevelIds.includes(l.id));
    const to = lv?.price ?? lv?.zoneHigh ?? lv?.zoneLow ?? null;
    if (to == null || !(to > 0)) continue;
    const pct = pctById.get(sc.id);
    out.push({
      id: sc.id,
      from: base,
      to,
      text: `${sc.name} ${fmtPrice(to)}${pct == null ? '' : ` · 模型主观 ${pct}%`}`,
      color: PATH_COLOR[sc.rank],
    });
  }
  return out;
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
  renderOverlays();
}

/** 标注是否应在当前视图渲染：图层开关 + 周期过滤 */
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
  // 分时图比任何 K 线周期都细，三层的位子在盘中都是有效参考，价位线全画；
  // 区间/趋势线等形态的坐标绑死在 K 线时间轴上，画到分时上是错的。
  // 这个判断必须在「无 timeframe 一律可见」之前，否则手工标注会漏过去。
  if (tab.value === 'trend') return m.kind === 'price_line';
  // 周期过滤。价位线按「本周期及更大周期都画、更小周期不画」：
  // 计划分周线/日线/60 分钟三层出位子后，若仍让价位线一律跨周期可见，
  // 周线图上会被一堆 60 分钟级触发线糊满；反过来 60 分钟图上仍需看到周线压力位这个边界。
  // 非价位线（区间、箭头等）语义绑死在所属周期，仍只在本周期画。
  if (!m.timeframe) return true;
  return m.kind === 'price_line'
    ? isPlanLineVisible(tab.value, m.timeframe)
    : m.timeframe === tab.value;
}

/**
 * 给水平标注分配标签横向槽位，价位靠得太近的往右错开一格。
 *
 * ponytail: 用「价差占当前数据价格跨度的比例」估算像素距离，而不是真的去查主图高度与缩放。
 * 天花板是缩放后估算偏保守（可能多错开一格）；要精确的话得改成在 overlay 的
 * createPointFigures 里拿真实 y 坐标做碰撞，那需要跨 overlay 共享状态。
 */
const LABEL_NEAR_RATIO = 0.025;

function assignLabelSlots(
  items: Array<{ id: string; price: number; priority: number }>,
): Map<string, number> {
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
  // 先按价格聚成「会互相压」的簇
  const sorted = [...items].sort((a, b) => a.price - b.price);
  const clusters: Array<typeof sorted> = [];
  let prev: number | null = null;
  for (const it of sorted) {
    if (prev != null && it.price - prev < near) clusters[clusters.length - 1].push(it);
    else clusters.push([it]);
    prev = it.price;
  }
  // 簇内按优先级发槽位：靠左（槽位 0）最不容易被夹出可视区，要留给计划线。
  // 若只按价格发，一条斐波那契线就能把更重要的计划线标签挤到右边甚至挤没。
  for (const c of clusters) {
    [...c]
      .sort((a, b) => a.priority - b.priority)
      .forEach((it, i) => slots.set(it.id, i));
  }
  return slots;
}

/**
 * 重绘图上全部 overlay：计划标注组 + 确定性点位组。
 * 两组必须同一个函数画，因为标签防重叠要跨组统一分槽——分开画各自算槽位，
 * 两组的标签就会互相压在一起。
 * 分时视图只叠加水平价位线：推演锥与确定性点位的坐标以 K 线时间轴为基准，
 * 画到分时上是错的；而计划的三层位子在盘中恰恰最需要看见。早先这里对 trend
 * 直接 early return，使 isMarkVisible 里为分时写的分支成了死代码——图上一条
 * 计划线都没有，下方只读清单却照 isMarkVisible 列了出来。
 */
function renderOverlays(): void {
  if (!chart) return;
  chart.removeOverlay({ groupId: MARK_GROUP });
  chart.removeOverlay({ groupId: DET_GROUP });
  chart.removeOverlay({ groupId: PROJ_GROUP });
  chart.removeOverlay({ groupId: WAVE_GROUP });
  chart.removeOverlay({ groupId: CONFLUENCE_GROUP });
  const isTrend = tab.value === 'trend';
  if (!isTrend) renderProjection();
  if (!isTrend) renderWaves();
  const visible = marks.value.filter(isMarkVisible);
  // 与计划线重合的点位不再单独画，其用途已缀到对应计划线的标签上（见 detPlanMatch）
  const dets = isTrend ? [] : detLines.value.filter((d) => !detPlanMatch.value.byDet.has(d.id));
  const waves = isTrend ? [] : waveLines.value;
  const cfs = isTrend || !layers.value.confluence ? [] : strongConfluences.value;
  // 只有水平线（价位线/价格带/点位线）会因价格接近而叠标签，其余按时间轴分散，无需错位
  // priority：计划线优先占左侧槽位，点位线与波浪线是参考背景，被挤到右边可以接受。
  // 波浪线必须与点位线一起分槽——分开算各自都以为自己在槽 0，标签正好压在一起。
  const slots = assignLabelSlots(
    [
      ...visible
        .filter((m) => m.kind === 'price_line')
        .map((m) => ({ id: m.id, price: horizontalMarkAnchor(m) ?? 0, priority: 0 })),
      ...dets.map((d) => ({ id: d.id, price: d.price, priority: 1 })),
      ...waves.map((w) => ({ id: w.id, price: w.price, priority: 1 })),
      // 共振位优先级与计划线同级：它是各层交集，被挤出可视区最可惜
      ...cfs.map((c) => ({ id: c.id, price: c.price, priority: 0 })),
    ].filter((it) => it.price > 0),
  );
  for (const c of cfs) {
    chart.createOverlay({
      name: 'SM_PRICE_LINE',
      groupId: CONFLUENCE_GROUP,
      points: [{ value: c.price }],
      lock: true,
      extendData: {
        text: `${c.sources.length}源共振 ${fmtPrice(c.price)}（${c.sources.map((s) => SRC_NAME[s]).join('+')}）`,
        slot: slots.get(c.id) ?? 0,
      } satisfies MarkExtend,
      styles: {
        // 实线且略粗：它是本图上最该先看的几条线，视觉权重要压过单源的参考位
        line: { color: CONFLUENCE_COLOR, size: 2, style: LineType.Solid },
        text: {
          color: CONFLUENCE_COLOR,
          size: 11,
          backgroundColor: 'rgba(20,24,33,0.88)',
          paddingLeft: 4,
          paddingRight: 4,
        },
      },
    });
  }
  for (const w of waves) {
    chart.createOverlay({
      name: 'SM_PRICE_LINE',
      groupId: WAVE_GROUP,
      points: [{ value: w.price }],
      lock: true,
      extendData: { text: w.label, slot: slots.get(w.id) ?? 0 } satisfies MarkExtend,
      styles: {
        line: { color: w.color, size: 1, style: LineType.Dashed },
        text: {
          color: w.color,
          size: 10,
          backgroundColor: 'rgba(20,24,33,0.7)',
          paddingLeft: 3,
          paddingRight: 3,
        },
      },
    });
  }
  for (const d of dets) {
    chart.createOverlay({
      name: 'SM_PRICE_LINE',
      groupId: DET_GROUP,
      points: [{ value: d.price }],
      lock: true,
      extendData: { text: d.label, slot: slots.get(d.id) ?? 0 } satisfies MarkExtend,
      // 一律细虚线 + 小号标签：它们是参考背景，不能在视觉上盖过计划结论
      styles: {
        line: { color: d.color, size: 1, style: LineType.Dashed },
        text: {
          color: d.color,
          size: 10,
          backgroundColor: 'rgba(20,24,33,0.7)',
          paddingLeft: 3,
          paddingRight: 3,
        },
      },
    });
  }
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
        // 补「距现价多少 ATR」：判断这条线够不够得到，比来源/触碰次数更即时可用
        text:
          `${m.label}${priceSuffix(m)}` +
          `${m.kind === 'price_line' ? atrDistanceText(horizontalMarkAnchor(m) ?? 0) : ''}` +
          `${sourceSuffix(m.id)}` +
          `${statusSuffix(m)}`,
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

/**
 * 画走势推演。放在最后一根 bar 右侧的留白区，并临时把右偏移撑开到容得下推演步数——
 * 不撑开的话锥会被挤在 y 轴外面，看起来像图表画崩了。
 * 关掉图层时把右偏移还原成 8，不留下一块莫名其妙的空白。
 */
function renderProjection(): void {
  if (!chart) return;
  const cone = projection.value?.cone;
  const on = layers.value.projection && canProject.value;
  const bars = chart.getDataList();
  const lastTs = bars[bars.length - 1]?.timestamp;
  if (!on || !cone || lastTs == null) {
    chart.setOffsetRightDistance(8);
    return;
  }
  // 留白 = 推演步数 × 当前 bar 宽 + 一点余量给标签。
  // 必须读实时 bar 宽而不是默认值：overlay 的 x 是按当前 barSpace 推的，
  // 用默认值算留白的话用户一缩放，锥就画到留白外面去了。
  // ponytail: 留白只在重绘时按当前 bar 宽算一次，缩放后不跟着变，锥可能压到边缘。
  // 要彻底跟手得订阅缩放事件重算留白，代价是每帧一次 setOffsetRightDistance。
  const space = chart.getBarSpace() || defaultBarSpace;
  chart.setOffsetRightDistance((PROJECTION_STEPS + 1) * space + 40);

  const conePoints = [{ timestamp: lastTs, value: cone.basePrice }];
  for (const s of cone.steps) {
    conePoints.push(
      { timestamp: lastTs, value: s.p2High },
      { timestamp: lastTs, value: s.p1High },
      { timestamp: lastTs, value: s.p1Low },
      { timestamp: lastTs, value: s.p2Low },
    );
  }
  chart.createOverlay({
    name: 'SM_CONE',
    groupId: PROJ_GROUP,
    points: conePoints,
    lock: true,
    // 两层都用同一个极淡的灰蓝：叠加处自然更深，正好表达「越靠中间越常见」，
    // 不用两种颜色是为了不让它看起来像在指方向
    styles: { polygon: { color: 'rgba(107,127,158,0.10)', borderColor: 'transparent' } },
  });

  for (const p of scenarioPaths.value) {
    chart.createOverlay({
      name: 'SM_PATH',
      groupId: PROJ_GROUP,
      points: [
        { timestamp: lastTs, value: p.from },
        { timestamp: lastTs, value: p.to },
      ],
      lock: true,
      extendData: { text: p.text, slot: 0, steps: PROJECTION_STEPS } satisfies MarkExtend,
      styles: {
        line: { color: p.color, size: 1, style: LineType.Dashed },
        text: {
          color: p.color,
          size: 10,
          backgroundColor: 'rgba(20,24,33,0.8)',
          paddingLeft: 3,
          paddingRight: 3,
        },
      },
    });
  }
}

/**
 * 画浪段连线。已完成的浪用实线粗一档，进行中那一浪用虚线——
 * 后者的终点是当前收盘价，会随行情一直动，视觉上必须和已经定格的浪区分开。
 */
function renderWaves(): void {
  if (!chart) return;
  const c = waveMain.value;
  if (!layers.value.elliott || !canElliott.value || !c) return;
  for (const leg of c.legs) {
    const from = markTimestamp(leg.fromTime);
    const to = markTimestamp(leg.toTime);
    if (from == null || to == null) continue;
    chart.createOverlay({
      name: 'SM_WAVE_LEG',
      groupId: WAVE_GROUP,
      points: [
        { timestamp: from, value: leg.fromPrice },
        { timestamp: to, value: leg.toPrice },
      ],
      lock: true,
      extendData: { text: waveGlyph(leg.label), slot: 0 } satisfies MarkExtend,
      styles: {
        line: {
          color: WAVE_COLOR,
          size: leg.completed ? 2 : 1,
          style: leg.completed ? LineType.Solid : LineType.Dashed,
        },
        text: {
          color: WAVE_COLOR,
          size: 12,
          backgroundColor: 'rgba(20,24,33,0.85)',
          paddingLeft: 4,
          paddingRight: 4,
        },
      },
    });
  }
}

/** 图下方只读清单的一行：形态标签 + 价位 + 距现价 + 说明 */
interface MarkRow {
  id: string;
  kindLabel: string;
  color: string;
  label: string;
  where: string;
  /** 距现价多少 ATR，与图上标签同一个数 */
  dist: string;
  note: string;
}

/** 计划标注行 */
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
      label: `${m.label}${sourceSuffix(m.id)}`,
      where,
      dist: m.kind === 'price_line' ? atrDistanceText(horizontalMarkAnchor(m) ?? 0).trim() : '',
      note: m.note || '',
    };
  }),
);

/**
 * 确定性点位行。与计划标注分开列，并在类型标签上写明分组，
 * 让人一眼看出这些是「算出来的参考位」而不是「计划给的结论」。
 */
const detRows = computed<MarkRow[]>(() =>
  detLines.value
    .filter((d) => !detPlanMatch.value.byDet.has(d.id))
    .map((d) => ({
      id: d.id,
      kindLabel: d.group,
      color: d.color,
      label: d.label,
      where: '',
      dist: atrDistanceText(d.price).trim(),
      note: d.note,
    })),
);

/** 清单最终渲染的行：计划标注在前、确定性点位在后（模板里不做 spread，免得每次渲染新建数组） */
const allRows = computed<MarkRow[]>(() => [...markRows.value, ...detRows.value]);

/** 均线支撑压力只进读数不上图（主图已有均线曲线），与波段锚点一起作为点位图层的说明行 */
const detSummary = computed<string>(() => {
  const lv = levels.value;
  if (!lv || (!layers.value.fib && !layers.value.pivot)) return '';
  const parts: string[] = [];
  if (lv.swing) {
    const dir = lv.swing.direction === 'up' ? '上行' : '下行';
    parts.push(`锚定${dir}波段 ${fmtPrice(lv.swing.low)}~${fmtPrice(lv.swing.high)}`);
  }
  if (lv.ma) {
    parts.push(`均线${lv.ma.alignment}`);
    if (lv.ma.supportMa) parts.push(`支撑 MA${lv.ma.supportMa.period} ${fmtPrice(lv.ma.supportMa.value)}`);
    if (lv.ma.resistanceMa) parts.push(`压力 MA${lv.ma.resistanceMa.period} ${fmtPrice(lv.ma.resistanceMa.value)}`);
  }
  if (lv.atr != null) parts.push(`ATR ${lv.atr}（${lv.atrPct ?? '—'}%）`);
  return parts.join(' · ');
});

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

/**
 * 分时数据所属交易日 YYYY-MM-DD。数据源不一定给得出 tradeDate，
 * 用可选读取 + 格式校验兜底，字段缺失或格式异常时才退回东八区当天。
 */
function tradeDateOf(res: TrendsResult): string {
  const d = (res as { tradeDate?: string | null }).tradeDate;
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

/** silent=true 用于轮询刷新：不显示 loading、失败不弹错、不清空已有图，避免抖动打断观看 */
async function loadTrends(silent = false) {
  if (!chart || !code.value) return;
  const token = ++reqToken;
  const myLoading = silent ? 0 : ++loadingToken;
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
    // 分时点的时间仅含 HH:MM，需补全日期。一律按「东八区今天」补会在周末/节假日
    // 把上一交易日的分时标成今天，tooltip 日期是错的；优先用后端返回的交易日。
    const dateStr = tradeDateOf(res);
    chart.applyNewData(res.points.map((p) => toTrendKLineData(p, res.prevClose, dateStr)), false, fitTrendFullDay);
    trend.value = res; // 驱动盘口数据条（含轮询实时更新）
    if (silent) error.value = '';
  } catch (e) {
    if (token !== reqToken || silent) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    // 与 loadKline 同理：spinner 只归最新那一发非静默请求管
    if (!silent && myLoading === loadingToken) loading.value = false;
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
    renderOverlays(); // 分时只叠加水平价位线，顺带清掉上一个视图的其余 overlay
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
  void loadLevels();
  void loadElliott();
  void loadAccuracy();
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
  // 关弹窗时可能正卡在一次未复位的加载里，不清就带着永久转圈重开
  loading.value = false;
  trend.value = null;
  indicators.value = null;
  marks.value = [];
  levels.value = null;
  // 推演属于上一个标的，重开前必清，并作废在飞请求
  projectionToken += 1;
  projection.value = null;
  projectionPlan.value = null;
  // 波浪同理：不作废 token 的话，旧标的的计数回来后会写进下一次打开的弹窗
  elliottToken += 1;
  elliott.value = null;
  resetWaveText();
  accuracyToken += 1;
  srcAccuracy.value = [];
  // 不重置的话，上次展开过细节此后每次打开都是满屏，速读卡片就白做了
  showDetail.value = false;
  layers.value = defaultLayers();
  // 停在「资金面/筹码」时关闭，重开后 setupChart 会在 display:none 的容器里初始化，
  // subPaneHeight() 拿到 0 高度退化成最小值，副图挤成一条线
  viewMode.value = 'chart';
  tab.value = 'day';
  // 不重置的话，只要打开过一次 Agent 页签，此后每次开弹窗都会立刻挂载对话栏、
  // 建 WS 并 find-or-create 会话，懒挂载从第二次起就失效了
  sideTab.value = 'plan';
  agentEverOpened.value = false;
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
    const HINT: Record<typeof v.basis, string> = {
      realtime: '盘中算法：东财实时量比（当前每分钟均量 ÷ 前 5 日每分钟均量，已按时间折算）',
      amount_median20: '收盘算法：当日成交额 ÷ 前 20 日成交额中位数（分母不含当日）',
      volume_median20:
        '收盘算法：当日成交量 ÷ 前 20 日成交量中位数（当前日线源不返回成交额，已退回用成交量算）',
    };
    cells.push({
      label: '量能',
      value: `${live ? '盘中 ' : ''}${v.ratio.toFixed(2)}×（${v.label}）${turnover}`,
      dir: volumeDir(v.state),
      hint: HINT[v.basis],
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

// 标签切换：切换主图形态并重载数据；点位测算按周期取（日线短期波段、周线中长期波段），需重拉
// 波浪同样按周期算（日线看日线级浪序、周线看周线级），且解读是对旧周期说的话，一并作废
watch(tab, () => {
  applyView();
  void loadLevels();
  resetWaveText();
  void loadElliott();
});

// 图层开关变化只需重绘，不必重取数据（点位已随周期预先拉好）。
// 推演是唯一例外：它按需取数，打开时才拉，避免每次开弹窗都白跑两个请求
watch(layers, () => renderOverlays(), { deep: true });
watch(
  () => layers.value.projection,
  () => void loadProjection(),
);
// 切周期后推演可能从「可用」变「不可用」（σ 是日线口径），重判一次
watch(tab, () => void loadProjection());

// 切到资金面/筹码再切回图表时容器尺寸变过，重算一次副图高度
watch(viewMode, (m) => {
  if (m === 'chart') void nextTick(applyPaneHeights);
});

// 弹窗打开时若切换到另一标的，重载（指数 code 可能相同，故同时监听 secid）
watch([code, secid], () => {
  viewMode.value = 'chart'; // 切标的回到图表视图
  marks.value = [];
  levels.value = null;
  // 与推演同理：切标的时 tab 若本就是 day，watch(tab) 不触发，旧标的的浪形会留在图上
  elliottToken += 1;
  elliott.value = null;
  resetWaveText();
  // 遵循率是按标的统计的，换标的必须重取，否则会把上一只的成绩挂到这一只的共振位上
  accuracyToken += 1;
  srcAccuracy.value = [];
  void loadAccuracy();
  // 推演也必须清：重取入口只有 watch(tab) 与图层开关，切标的时 tab 本就是 day
  // 的话两个 watch 都不触发，renderProjection 会把旧标的的 basePrice 与情景折线
  // 画到新标的的图上。清空之外还要作废在飞请求，否则旧标的的响应回来照样写进去。
  projectionToken += 1;
  projection.value = null;
  projectionPlan.value = null;
  if (visible.value && chart) void loadMarks();
  if (tab.value !== 'day') {
    tab.value = 'day'; // 触发 watch(tab) → applyView + loadLevels + loadProjection
    return;
  }
  if (visible.value && chart) {
    applyView();
    void loadLevels();
    void loadProjection();
  }
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
        <!--
          速读卡片：本弹窗默认唯一要读的一块，只回答三件事——现在在哪、上面撞哪、下面撑哪。
          其余所有区块收进下方「展开细节」，一条信息不删，但不再默认糊在脸上。
        -->
        <div v-if="viewMode === 'chart' && leadCard" class="lead">
          <div class="lead__top">
            <span class="lead__now num">现价 {{ leadCard.close }}</span>
            <span class="lead__state">
              {{ leadCard.periodLabel }}
              <template v-if="leadCard.maAlignment"> · 均线{{ leadCard.maAlignment }}</template>
              <template v-if="leadCard.atrText"> · 一天常见波动 {{ leadCard.atrText }}</template>
            </span>
          </div>

          <!-- 现价在最近上下两档之间的位置。贴上沿说明离阻力近、上攻空间小，反之亦然 -->
          <div class="lead__mid">
            <span class="lead__edge num">{{ leadCard.nearestDown || '—' }}</span>
            <div class="lead__bar">
              <div v-if="leadCard.posPct != null" class="lead__dot" :style="{ left: `${leadCard.posPct}%` }" />
            </div>
            <span class="lead__edge num">{{ leadCard.nearestUp || '—' }}</span>
            <span class="lead__pos">
              <template v-if="leadCard.posPct != null">
                卡在最近两档之间的 {{ leadCard.posPct }}% 处
              </template>
              <template v-else>上下缺一档，算不出区间位置</template>
            </span>
          </div>

          <!--
            按可达性分层给档。只给「最近一档」时，高波动标的上拿到的永远是
            ±0.2 ATR 的枢轴位，那是当天振幅的三分之一，看着像阈值其实是噪声。
          -->
          <div v-for="t in leadCard.tiers" :key="t.key" class="lead__tier">
            <div class="lead__tier-head">
              <span class="lead__tier-name">{{ t.label }}</span>
              <span class="lead__tier-range">{{ t.range }}</span>
            </div>
            <div v-for="side in (['res', 'sup'] as const)" :key="side" class="lead__lv" :class="`is-${side}`">
              <span class="lead__tag">{{ side === 'res' ? '上方' : '下方' }}</span>
              <template v-if="side === 'res' ? t.resistance : t.support">
                <template v-for="l in [side === 'res' ? t.resistance! : t.support!]" :key="l.price">
                  <span class="lead__price num">{{ l.price }}</span>
                  <span class="lead__gap num">
                    {{ side === 'res' ? '+' : '-' }}{{ l.gapPct }}
                    <i v-if="l.atrDist">{{ l.atrDist }}</i>
                  </span>
                  <span class="lead__src">
                    {{ l.sourceCount }} 套方法指向（{{ l.sourceNames }}）
                  </span>
                  <span
                    v-if="l.rateText"
                    class="lead__rate num"
                    :class="{ 'is-weak': l.weak }"
                    :title="`已经能判对错的有 ${l.sampleN} 次`"
                  >
                    <template v-if="l.weak">
                      只拦住过 {{ l.rateText }} · 多数时候没起作用，别单凭它下手
                    </template>
                    <template v-else>历史上拦住过 {{ l.rateText }}（{{ l.sampleN }} 次）</template>
                  </span>
                  <!--
                    价格贴到这一档才铺开三条件，其余只给一行规则。
                    六档全铺开就是十八行，反而没人看。
                  -->
                  <div v-if="l.testing && l.conds.length" class="lead__conds">
                    <div class="lead__conds-title">{{ l.breakVerdict }}</div>
                    <div
                      v-for="c in l.conds"
                      :key="c.label"
                      class="lead__cond"
                      :class="{ 'is-ok': c.ok, 'is-unknown': c.unknown }"
                    >
                      <span class="lead__cond-mark">{{ c.unknown ? '?' : c.ok ? '✓' : '✗' }}</span>
                      <span class="lead__cond-label">{{ c.label }}</span>
                      <span class="lead__cond-actual num">{{ c.actual }}</span>
                    </div>
                  </div>
                  <div v-else class="lead__rule">{{ l.ruleText }}</div>
                </template>
              </template>
              <span v-else class="lead__none">这个距离上没有价位</span>
            </div>
          </div>

          <!--
            必须写清口径。不写的话「遵循 84%」会被读成「守住了 84%」，
            而账本判的是「摸到后掉不掉头」，是两个完全不同的意思。
          -->
          <div class="lead__note">
            <b>「拦住过百分之多少」</b>说的是这类位子历史上管不管用：价格摸到它之后，
            {{ ASSERTION_REACTION_BARS }} 根 K 线内往回走的幅度够不够大<template
              v-if="leadCard.atrText"
            >（本标的要走够 {{ leadCard.atrText }}）</template>，够了才算它起了作用，
            观察 {{ ASSERTION_HORIZON_DAYS }} 天，只统计这只标的自己的历史。
            <b>下面那三个勾</b>答的是另一件事——今天这一次穿过去算不算数，当天收盘就能判，
            跟上面那个百分比没有关系。
          </div>
        </div>

        <div v-if="viewMode === 'chart'" class="lead-toggle">
          <el-button link size="small" @click="showDetail = !showDetail">
            {{ showDetail ? '收起细节' : '展开细节（图层开关 / 全部价位 / 波浪走势 / 标注清单）' }}
          </el-button>
        </div>

        <!--
          图层开关。计划相关的几档只在有标注时才有意义，故按 marks.length 显示；
          黄金分割/枢轴是算出来的，与有没有计划无关，只要在图表视图就常驻可选。
        -->
        <div v-show="showDetail" class="kline-detail">
        <div v-if="viewMode === 'chart' && tab !== 'trend'" class="kline-layers">
          <span class="kline-layers__label">图层</span>
          <template v-if="marks.length">
            <el-checkbox v-model="layers.currentPlan" size="small">当前计划</el-checkbox>
            <el-checkbox v-model="layers.supportResistance" size="small">支撑/压力</el-checkbox>
            <el-checkbox v-model="layers.manual" size="small">手工标注</el-checkbox>
            <el-checkbox v-model="layers.history" size="small">历史/失效</el-checkbox>
          </template>
          <el-checkbox v-model="layers.fib" size="small">黄金分割</el-checkbox>
          <el-checkbox v-model="layers.pivot" size="small">枢轴</el-checkbox>
          <el-checkbox v-model="layers.projection" :disabled="!canProject" size="small">
            走势推演
          </el-checkbox>
          <el-checkbox v-model="layers.elliott" :disabled="!canElliott" size="small">
            波浪
          </el-checkbox>
          <el-checkbox v-model="layers.confluence" size="small">共振位</el-checkbox>
        </div>
        <!-- 推演口径说明。措辞刻意不写「95% 概率落在」：锥是按历史波动外推的量级参考，不是置信区间 -->
        <div v-if="viewMode === 'chart' && layers.projection && projectionNote" class="kline-det-sum">
          {{ projectionNote }}
        </div>
        <!--
          多源共振区：各技术层指向同一价位时收敛成一条结论。
          放在所有单层读数之上——它回答的是「这么多线先看哪几个」，是本弹窗最该先读的一块。
        -->
        <div v-if="viewMode === 'chart' && tab !== 'trend' && confluences.length" class="kline-cf">
          <div class="kline-cf__head">
            <span class="kline-cf__title">关键价位</span>
            <span class="kline-cf__meta">
              同一个价位被越多套方法同时算出来，越可能是真的坎；方法名后的百分比是它在本标的历史上说准的比例。
              只有两套以上的会画到图上
            </span>
          </div>
          <div v-for="c in confluences" :key="c.id" class="kline-cf__row">
            <span class="kline-cf__n" :class="{ 'is-strong': c.sources.length >= MIN_CONFLUENCE }">
              {{ c.sources.length }} 套
            </span>
            <span class="kline-cf__price num">{{ fmtPrice(c.price) }}</span>
            <span v-if="c.atrDist != null" class="kline-cf__dist num">
              {{ c.atrDist >= 0 ? '+' : '' }}{{ c.atrDist.toFixed(1) }}ATR
            </span>
            <span class="kline-cf__srcs">
              <i v-for="s in c.sources" :key="s" class="kline-cf__src">
                {{ SRC_NAME[s] }}<em v-if="srcRateText(s)">{{ srcRateText(s) }}</em>
              </i>
            </span>
            <span class="kline-cf__detail" :title="c.details.join(' / ')">{{ c.details.join(' / ') }}</span>
          </div>
        </div>
        <!-- 点位测算说明：波段锚点 + 均线支撑压力 + ATR（均线只给读数，不上图） -->
        <div v-if="viewMode === 'chart' && detSummary" class="kline-det-sum">{{ detSummary }}</div>
        <!--
          波浪结论区。与图层开关无关，常驻展示——图层只决定画不画到图上，
          「当前处于第几浪」这个结论本身是打开弹窗就该看到的。
        -->
        <div v-if="viewMode === 'chart' && canElliott && elliott" class="kline-wave">
          <div class="kline-wave__head">
            <span class="kline-wave__title">波浪</span>
            <span class="kline-wave__summary">{{ elliott.summary }}</span>
            <el-button
              link
              type="primary"
              size="small"
              :loading="waveTexting"
              class="kline-wave__btn"
              @click="interpretWave"
            >
              {{ waveText ? '重新解读' : '解读' }}
            </el-button>
          </div>
          <div v-for="r in waveRows" :key="r.key" class="kline-wave__row">
            <span class="kline-wave__role">{{ r.role }}</span>
            <span class="kline-wave__degree">{{ r.degree }}</span>
            <span class="kline-wave__pos">{{ r.position }}</span>
            <span class="kline-wave__conf num" :class="{ 'is-weak': r.confidence < WAVE_MIN_CONFIDENCE }">
              置信 {{ r.confidence.toFixed(2) }}
            </span>
            <span v-if="r.primary" class="kline-wave__primary num" :title="r.primary.title">
              首选 {{ r.primary.price }}
              <em>{{ r.primary.ratio }}</em>
              <template v-if="r.primary.date"> · 预计 {{ r.primary.date }} 前后</template>
            </span>
            <span class="kline-wave__kv">
              {{ r.levelName }}
              <template v-if="r.targets.length">
                <i
                  v-for="t in r.targets"
                  :key="t.key"
                  class="num kline-wave__tgt"
                  :class="{ 'is-reached': t.reached }"
                  :title="t.title"
                >{{ t.price }}<em>{{ t.ratio }}{{ t.reached ? `·${t.passedWord}` : '' }}</em></i>
              </template>
              <i v-else class="num">{{ r.targetsHint }}</i>
            </span>
            <span class="kline-wave__kv" title="跌破/涨破此价则本套计数作废">
              失效 <i class="num">{{ r.invalid }}</i>
            </span>
            <span class="kline-wave__kv" title="按已完成同级浪的 bar 数中位数外推，是估算区间">
              时间窗 <i class="num">{{ r.timeWindow }}</i>
            </span>
            <span v-if="r.subLegs.length" class="kline-wave__kv kline-wave__sub" :title="r.subNote">
              子浪
              <i
                v-for="s in r.subLegs"
                :key="s.key"
                class="num kline-wave__subleg"
                :class="{ 'is-running': s.running }"
              >{{ s.label }}<em>{{ s.range }}</em></i>
            </span>
          </div>
          <div v-if="waveReadingLegend" class="kline-wave__legend">{{ waveReadingLegend }}</div>
          <div v-if="waveTargetLegend" class="kline-wave__legend">{{ waveTargetLegend }}</div>
          <div v-if="waveText" class="kline-wave__text">{{ waveText }}</div>
          <div v-if="waveTextError" class="kline-wave__err">解读失败：{{ waveTextError }}</div>
          <div class="kline-wave__note">{{ elliott.note }}</div>
        </div>
        <!-- 只读清单：上半是计划标注（增删改由对话中的 agent 完成），下半是确定性点位 -->
        <div v-if="viewMode === 'chart' && allRows.length" class="kline-marks">
          <div v-for="m in allRows" :key="m.id" class="kline-marks__row">
            <span class="kline-marks__kind" :style="{ color: m.color, borderColor: m.color }">
              {{ m.kindLabel }}
            </span>
            <span class="kline-marks__label">{{ m.label }}</span>
            <span v-if="m.where" class="kline-marks__where num">{{ m.where }}</span>
            <span v-if="m.dist" class="kline-marks__dist num">{{ m.dist }}</span>
            <span v-if="m.note" class="kline-marks__note">{{ m.note }}</span>
          </div>
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
            :code="code"
            :name="name"
            :secid="secid"
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
  /*
   * 定高 + 不滚：body 自己滚会把左右两栏当成一个整体带着走，
   * 右侧对话/计划一长就把左边的 K 线顶出可视区。滚动交给两栏各自负责。
   * 必须是定高而非 max-height，否则子级的 height:100% 无从解析，两栏拿不到可用高度。
   */
  height: calc(94vh - 60px);
  overflow: hidden;
}
</style>

<style scoped>
/* 左右分栏：左图表区自适应，右侧标的跟踪对话栏固定宽 */
.kline-body {
  display: flex;
  gap: 12px;
  align-items: stretch;
  /* 撑满定高的 body，两栏据此各自算可用高度 */
  height: 100%;
  min-height: 0;
}
.kline-main {
  flex: 1;
  min-width: 0;
  /*
   * 左栏独立内滚：矮视口下图表被 clamp 到下限后，左栏自然高度会超过可用高度，
   * 此时只滚左栏，不牵动右侧；反之右侧对话再长也带不动 K 线。
   * padding-right 给滚动条留位，避免压住图表右缘的价格轴。
   */
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}
.kline-side {
  width: 440px;
  flex-shrink: 0;
  /* 高度跟满定高的 body（flex stretch），不再写死，避免图表变高后两栏错位 */
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  /* 右栏自身不滚，滚动由内部面板（计划面板 tp__body / 对话列表）负责 */
  overflow: hidden;
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
.kline-marks__dist {
  flex-shrink: 0;
  color: var(--text-2);
  opacity: 0.85;
}
/* 速读卡片：默认视图里唯一要读的一块，视觉权重压过其余所有读数 */
.lead {
  margin-top: 10px;
  padding: 10px 14px 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
}
.lead__top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.lead__now {
  font-size: 20px;
  font-weight: 600;
  color: #cfd3dc;
}
.lead__state {
  color: var(--text-2);
  font-size: 12px;
}
/* 阻力行与支撑行 */
.lead__lv {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 5px 0;
  font-size: 13px;
}
.lead__tag {
  flex-shrink: 0;
  min-width: 56px;
  font-size: 11px;
}
/* A股红涨绿跌：阻力在上方用红、支撑在下方用绿 */
.lead__lv.is-res .lead__tag,
.lead__lv.is-res .lead__price {
  color: #f0454a;
}
.lead__lv.is-sup .lead__tag,
.lead__lv.is-sup .lead__price {
  color: #12b886;
}
.lead__price {
  flex-shrink: 0;
  min-width: 62px;
  font-size: 17px;
  font-weight: 600;
}
.lead__gap {
  flex-shrink: 0;
  color: var(--text-2);
  font-size: 12px;
}
.lead__gap i {
  margin-left: 4px;
  font-style: normal;
  opacity: 0.75;
}
.lead__src {
  color: var(--text-2);
  font-size: 12px;
}
.lead__rate {
  margin-left: auto;
  flex-shrink: 0;
  color: #ffd04b;
  font-size: 12px;
}
/* 遵循率偏低的档位：不隐藏（日内仍要看），但必须一眼看出它不能单独当依据 */
.lead__rate.is-weak {
  padding: 0 6px;
  border: 1px solid rgba(240, 69, 74, 0.45);
  border-radius: 3px;
  background: rgba(240, 69, 74, 0.1);
  color: #ff8a8d;
}
.lead__none {
  color: var(--text-2);
  font-size: 12px;
}
/* 三条件清单：只有价格贴上来的那一档才铺开，占满整行另起 */
.lead__conds {
  flex-basis: 100%;
  margin: 3px 0 2px 56px;
  padding: 5px 8px;
  border-left: 2px solid rgba(255, 208, 75, 0.4);
  background: rgba(255, 255, 255, 0.03);
}
.lead__conds-title {
  margin-bottom: 3px;
  color: #ffd04b;
  font-size: 12px;
}
.lead__cond {
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.7;
}
.lead__cond-mark {
  width: 10px;
  flex-shrink: 0;
  color: #f0454a;
}
.lead__cond.is-ok .lead__cond-mark {
  color: #12b886;
}
/* 取不到数的条目用中性色：它既不是满足也不是不满足 */
.lead__cond.is-unknown .lead__cond-mark {
  color: var(--text-2);
}
.lead__cond-actual {
  margin-left: auto;
  opacity: 0.9;
}
/* 未铺开时的一行规则摘要 */
.lead__rule {
  flex-basis: 100%;
  margin-left: 56px;
  color: var(--text-2);
  font-size: 11px;
  opacity: 0.7;
}
/* 可达性分层：把「今天就会碰的」与「真正的坎」在视觉上分开 */
.lead__tier {
  margin-top: 6px;
  padding-top: 5px;
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
}
.lead__tier-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.lead__tier-name {
  color: #cfd3dc;
  font-size: 12px;
  font-weight: 600;
}
.lead__tier-range {
  color: var(--text-2);
  font-size: 11px;
  opacity: 0.8;
}
/* 口径说明：不写清「遵循」的定义，百分比就会被读成「守住的比例」 */
.lead__note {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.6;
  opacity: 0.85;
}
/* 中间那条：现价卡在最近两档之间的哪个位置 */
.lead__mid {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 0 4px;
}
.lead__edge {
  flex-shrink: 0;
  color: var(--text-2);
  font-size: 11px;
}
.lead__bar {
  position: relative;
  flex: 1;
  height: 3px;
  border-radius: 2px;
  /* 下绿上红，与两侧标签同一套语义 */
  background: linear-gradient(90deg, rgba(18, 184, 134, 0.5), rgba(240, 69, 74, 0.5));
}
.lead__dot {
  position: absolute;
  top: -3px;
  width: 9px;
  height: 9px;
  margin-left: -4.5px;
  border-radius: 50%;
  background: #cfd3dc;
  box-shadow: 0 0 0 2px rgba(20, 24, 33, 0.9);
}
.lead__pos {
  flex-shrink: 0;
  color: var(--text-2);
  font-size: 11px;
}
.lead-toggle {
  margin-top: 6px;
}
/* 折叠区：展开后原样显示全部细节，一条不删 */
.kline-detail {
  margin-top: 2px;
}
/* 共振位：本弹窗最该先读的一块，边框与底色都比其余读数重一档 */
.kline-cf {
  margin-top: 10px;
  padding: 6px 10px 8px;
  border: 1px solid rgba(255, 208, 75, 0.28);
  border-radius: 6px;
  background: rgba(255, 208, 75, 0.04);
}
.kline-cf__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-bottom: 4px;
}
.kline-cf__title {
  flex-shrink: 0;
  padding: 1px 5px;
  border: 1px solid #ffd04b;
  border-radius: 3px;
  color: #ffd04b;
  font-size: 10px;
  line-height: 1.5;
}
.kline-cf__meta {
  flex: 1;
  min-width: 0;
  color: var(--text-2);
  font-size: 11px;
}
.kline-cf__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 0;
  font-size: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.kline-cf__n {
  flex-shrink: 0;
  min-width: 30px;
  color: var(--text-2);
  font-size: 11px;
}
.kline-cf__n.is-strong {
  color: #ffd04b;
  font-weight: 600;
}
.kline-cf__price {
  flex-shrink: 0;
  min-width: 56px;
  color: #cfd3dc;
  font-weight: 600;
}
.kline-cf__dist {
  flex-shrink: 0;
  color: var(--text-2);
  font-size: 11px;
}
.kline-cf__srcs {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  flex-shrink: 0;
}
.kline-cf__src {
  padding: 0 5px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 3px;
  font-style: normal;
  font-size: 11px;
  color: var(--text-2);
}
/* 历史遵循率紧跟来源名，一眼看出这个来源在本标的上靠不靠谱 */
.kline-cf__src em {
  margin-left: 3px;
  font-style: normal;
  font-size: 10px;
  color: #ffd04b;
}
.kline-cf__detail {
  flex: 1;
  min-width: 0;
  color: var(--text-2);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kline-cf__empty {
  padding: 6px 0 2px;
  color: var(--text-2);
  font-size: 11px;
}
/* 波浪结论区：与标注清单同密度，限高内滚，避免多套计数把弹窗撑出视口。
   限高要容得下四套计数（大级别/当前/高一度/备选）各自带子浪那一行，200px 会把最后一套挤进滚动区 */
.kline-wave {
  margin-top: 10px;
  padding: 6px 10px 8px;
  border: 1px solid rgba(224, 107, 208, 0.22);
  border-radius: 6px;
  max-height: 340px;
  overflow-y: auto;
}
.kline-wave__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-bottom: 4px;
}
.kline-wave__title {
  flex-shrink: 0;
  padding: 1px 5px;
  border: 1px solid #e06bd0;
  border-radius: 3px;
  color: #e06bd0;
  font-size: 10px;
  line-height: 1.5;
}
.kline-wave__summary {
  flex: 1;
  min-width: 0;
  color: #cfd3dc;
  font-size: 12px;
  font-weight: 600;
}
.kline-wave__btn {
  flex-shrink: 0;
}
.kline-wave__row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 5px 0;
  font-size: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.kline-wave__role {
  flex-shrink: 0;
  min-width: 52px;
  color: var(--text-2);
  font-size: 11px;
}
.kline-wave__degree {
  flex-shrink: 0;
  color: #cfd3dc;
  font-weight: 600;
}
.kline-wave__pos {
  flex-shrink: 0;
  color: #e06bd0;
}
.kline-wave__conf {
  flex-shrink: 0;
  color: var(--text-2);
}
/* 置信度不足时标红，提醒下方目标价已被抑制 */
.kline-wave__conf.is-weak {
  color: #ffb000;
}
.kline-wave__kv {
  color: var(--text-2);
  font-size: 11px;
}
.kline-wave__kv i {
  font-style: normal;
  color: #cfd3dc;
}
/* 候选转折位：价格为主、比例为辅，多档并列排开以体现「互为备选」而非先后 */
.kline-wave__tgt {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  margin-left: 6px;
  padding: 0 5px;
  border: 1px solid rgba(180, 91, 166, 0.45);
  border-radius: 3px;
}
.kline-wave__tgt em {
  font-style: normal;
  font-size: 10px;
  color: var(--text-2);
}
/* 已到达的档位降为灰色：它已经不是「还要去的地方」了 */
.kline-wave__tgt.is-reached {
  border-color: rgba(255, 255, 255, 0.12);
  color: var(--text-2);
  opacity: 0.7;
}
/* 首选：整块里唯一需要一眼抓到的数字，给底色强调 */
.kline-wave__primary {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 3px;
  background: rgba(224, 107, 208, 0.16);
  border: 1px solid rgba(224, 107, 208, 0.5);
  color: #f0a8e4;
  font-weight: 600;
}
.kline-wave__primary em {
  font-style: normal;
  font-weight: 400;
  font-size: 10px;
  opacity: 0.8;
}
/* 子浪：整行占满另起一行，避免与上面的键值对挤在一起 */
.kline-wave__sub {
  flex-basis: 100%;
}
.kline-wave__subleg {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  margin-left: 6px;
  padding: 0 5px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}
.kline-wave__subleg em {
  font-style: normal;
  font-size: 10px;
  color: var(--text-2);
}
/* 进行中的子浪就是「现在所处的位置」，必须比已走完的显眼 */
.kline-wave__subleg.is-running {
  border-color: rgba(224, 107, 208, 0.55);
  color: #f0a8e4;
}
.kline-wave__legend {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.6;
}
.kline-wave__text {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  color: #cfd3dc;
  font-size: 12px;
  line-height: 1.7;
}
.kline-wave__err {
  margin-top: 6px;
  color: var(--el-color-danger);
  font-size: 11px;
}
.kline-wave__note {
  margin-top: 6px;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.6;
}
/* 点位测算说明行：比清单更轻，作为图层的一句话交代 */
.kline-det-sum {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.6;
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
