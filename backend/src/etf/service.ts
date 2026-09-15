import type {
  EtfAction,
  EtfGrid,
  EtfOverview,
  EtfPoolItem,
  EtfSignal,
  EtfSignalsResult,
  EtfStatus,
  EtfTrigger,
  NotifyChannel,
  RunTrigger,
} from '@stock-agent/shared';
import { getValue } from '../settings';
import { runTask, type RunTaskResult } from '../runner';
import { nowIso } from '../util';
import * as repo from './repo';
import {
  computeMetrics,
  fetchBroadStrip,
  fetchEtfMarketStat,
  fetchEtfQuote,
  fetchEtfRank,
  fetchThemeCategories,
  type EtfMetrics,
  type EtfQuoteRaw,
} from './data';

// ETF 买卖信号服务：把确定性指标层综合成可执行的操作建议 + 结构化触发价（对齐今日计划 PlanTrigger），
// 供 /api/etf/*、agent 工具 etf_signals 与今日计划生成共用。判定依据均线偏离/折溢价/双动量轮动
// 等公开方法，仅作研判参考，不构成投资建议、不触发任何下单。
//
// 关于「区间位置」这个指标的用法边界（见 data.ts 的 pricePercentile）：
// 它算的是现价落在近两年收盘区间的哪个位置，**不是基本面估值**。
// 这里曾把「位置 > 80」直接判成 reduce、文案写「已进入高估分位，分批止盈/减仓」，
// 结果是一只刚走出主升浪的赛道 ETF 越涨越被劝减仓——而中线主升浪的钱恰恰全在这一段。
// 现在它只作为「波动可能加大」的提示信息，不再单独触发任何减仓动作；
// 减仓/离场只认趋势走弱（绝对动量转负）。

// ===== 阈值（集中维护，便于调参） =====
const ZONE_POS_LOW = 20; // 现价处于近两年区间低位（买入区）
const ZONE_POS_HIGH = 80; // 现价处于近两年区间高位（仅提示波动，不触发减仓）
const MA_DEEP_DISCOUNT = -10; // 年线深度偏离（超跌捡漏）
const PREMIUM_WARN = 1; // 折溢价率 % 追高警戒线
const GRID_MIN_STEP = 1.5; // 网格最小间距 %
const GRID_MAX_STEP = 3; // 网格最大间距 %

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
/** ETF 价位保留 3 位小数 */
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** 模块状态：是否启用 + 池大小 */
export function status(): EtfStatus {
  return { enabled: getValue('etfEnabled') === 'true', poolSize: repo.listPool().length };
}

/** 网格水位：用年内区间 + 波动率定档距（约束 1.5%–3%），给当前档位与上下一档挂单价 */
function buildGrid(m: EtfMetrics): EtfGrid | null {
  const { price, yearLow, yearHigh, volatility } = m;
  if (price == null || yearLow == null || yearHigh == null || yearHigh <= yearLow) return null;
  // 波动率（年化%）→ 每格间距%：经验缩放后夹在 [1.5,3]
  const stepPct = clamp((volatility ?? 0) / 12, GRID_MIN_STEP, GRID_MAX_STEP);
  const step = (price * stepPct) / 100;
  if (step <= 0) return null;
  const gridCount = Math.max(1, Math.round((yearHigh - yearLow) / step));
  const level = clamp(Math.round((price - yearLow) / step), 0, gridCount);
  const nextBuy = r3(price - step);
  const nextSell = r3(price + step);
  return {
    low: r3(yearLow),
    high: r3(yearHigh),
    stepPct: r2(stepPct),
    level,
    gridCount,
    nextBuy: nextBuy > 0 ? nextBuy : null,
    nextSell,
  };
}

const trig = (type: EtfTrigger['type'], value: number, note: string): EtfTrigger => ({
  type,
  value: r3(value),
  note,
});

/** 综合指标 → 操作建议 + 触发价 + 要点（导出供 etfDecide.selfcheck.ts 钉住卖点来源） */
export function decide(
  m: EtfMetrics,
  premiumPct: number | null,
  grid: EtfGrid | null,
): Pick<
  EtfSignal,
  'action' | 'buyTrigger' | 'sellTrigger' | 'stopLoss' | 'takeProfit' | 'notes'
> {
  const notes: string[] = [];
  const price = m.price;
  const pct = m.pricePercentile;
  const dev = m.maDeviation;

  // 无基准价：无法给可执行建议
  if (price == null) {
    return {
      action: 'hold',
      buyTrigger: null,
      sellTrigger: null,
      stopLoss: null,
      takeProfit: null,
      notes: ['缺少行情现价，暂不给可执行触发价'],
    };
  }

  const inBuyZone = pct != null && (pct < ZONE_POS_LOW || (dev != null && dev < MA_DEEP_DISCOUNT));
  const premiumHigh = premiumPct != null && premiumPct > PREMIUM_WARN;

  if (pct != null) {
    notes.push(
      `现价在近两年区间的位置 ${pct.toFixed(0)}%（0% 是两年最低、100% 是两年最高，衡量的是位置高低，不是贵还是便宜）`,
    );
    if (pct > ZONE_POS_HIGH) notes.push('已在区间高位，波动会比平时大，但位置高本身不是卖出理由');
  }
  if (dev != null) notes.push(`年线偏离 ${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%`);
  if (m.momentum != null)
    notes.push(`动量 ${m.momentum >= 0 ? '+' : ''}${m.momentum.toFixed(1)}%（绝对动量${m.absMomentumPositive ? '正' : '负'}）`);
  if (premiumPct != null)
    notes.push(`折溢价 ${premiumPct >= 0 ? '+' : ''}${premiumPct.toFixed(2)}%`);

  let action: EtfAction;
  if (inBuyZone && m.absMomentumPositive) {
    action = 'buy';
    notes.push('价格在区间低位 + 趋势向上，右侧买入区');
  } else if (inBuyZone && !m.absMomentumPositive) {
    action = 'hold';
    notes.push('价格在区间低位但趋势未企稳，左侧观察、等右侧确认再分批');
  } else if (m.absMomentumPositive && m.momentum != null && m.momentum > 0) {
    action = 'add';
    notes.push('趋势延续，可顺势持有/逢回踩加');
  } else if (!m.absMomentumPositive) {
    action = 'avoid';
    notes.push('趋势走弱（绝对动量为负），规避追高');
  } else {
    action = 'hold';
  }

  // 折溢价过高：避免高溢价买入，买/加降级为观望
  if (premiumHigh && (action === 'buy' || action === 'add')) {
    action = 'hold';
    notes.push('折溢价偏高，避免高溢价买入，等折价回落');
  }

  // 触发价（基于网格水位 / 年线 / 现价兜底）。
  //
  // 这里全部是**新交易的参考价**：stopLoss 用的是 `现价 * 0.95` 这类跟着现价走的算法，
  // 只对「现在按这个价进场」有意义。它绝不能被当成已有持仓的有效止损——
  // 价格越跌这条线越低，实际亏损永远追不上它，止损就永不触发。
  // 持仓的有效止损锚定成本，在 positions/discipline.ts 里算。
  let buyTrigger: EtfTrigger | null = null;
  let sellTrigger: EtfTrigger | null = null;
  let stopLoss: EtfTrigger | null = null;
  let takeProfit: EtfTrigger | null = null;

  // 触发价必须有真实依据：网格水位或年线。两者都没有时**不给价**。
  //
  // 原先的兜底是 `现价 * 0.985`，而且贴的标签是「回踩支撑」——
  // 那不是支撑位，是「现价往下 1.5%」，一个凭空生成的数字穿着技术分析的外衣。
  // 止损同理：`现价 * 0.95` 被标成「破位止损参考价」，可那里并没有位可破。
  // 历史 K 线不足 60 根时年线一定算不出来，于是新上市的 ETF 拿到的全是这类假位。
  const level = grid?.nextBuy ?? m.ma250 ?? null;
  const levelSource = grid?.nextBuy != null ? '网格下一档低吸' : '回踩年线支撑';

  if (action === 'buy' || action === 'add' || action === 'hold') {
    if (level != null) {
      buyTrigger = trig('pullback', level, levelSource);
      stopLoss = trig('price', Math.min(level * 0.96, price * 0.95), '新进场的破位止损参考价');
    } else {
      notes.push(
        `历史数据只有 ${m.barCount} 根日 K（不足 60 根），算不出年线也没有网格水位，` +
          '这只不给买入价和止损价——凭现价往下打几个点编出来的位不是支撑位',
      );
    }
    // 止盈是「涨到目标就走」的规则，不依赖支撑阻力位，所以没有网格也能给，
    // 但标签要说实话：没有网格时它就是「现价 +8%」，不是什么阻力位
    takeProfit =
      grid?.nextSell != null
        ? trig('breakout', grid.nextSell, '网格上一档止盈')
        : trig('breakout', r3(price * 1.08), '按现价 +8% 的止盈目标（没有网格水位可依据）');
  }
  // 卖点只来自趋势走弱，不来自「涨得多」。原先此处挂在「区间高位」上，
  // 于是主升浪途中反复给减仓价；现在改挂 avoid（绝对动量转负）
  if (action === 'avoid') {
    sellTrigger =
      grid?.nextSell != null
        ? trig('price', grid.nextSell, '趋势已走弱，反弹到网格上一档减仓')
        : trig('price', price, '趋势已走弱，按现价减仓（没有网格水位，不是等反弹的价）');
  }

  return { action, buyTrigger, sellTrigger, stopLoss, takeProfit, notes };
}

/** 单只 ETF 信号（行情失败/降级时仍返回结构化结果，warning 标注原因） */
export async function computeSignal(item: EtfPoolItem): Promise<EtfSignal> {
  let quote: EtfQuoteRaw | null = null;
  const warnings: string[] = [];
  try {
    quote = await fetchEtfQuote(item.code);
  } catch {
    warnings.push('实时行情拉取失败');
  }
  const price = quote?.price ?? null;
  const metrics = await computeMetrics(item.code, price);
  if (metrics.barCount < 60) warnings.push('历史 K 线不足，区间位置/动量指标可能失真');

  const iopv = quote?.iopv ?? null;
  // 优先采用集思录权威折溢价率 discount_rt；缺失则用东财 IOPV 二次计算兜底
  const premiumPct =
    quote?.premiumPct != null
      ? quote.premiumPct
      : iopv != null && price != null && iopv > 0
        ? ((price - iopv) / iopv) * 100
        : null;
  if (premiumPct == null) warnings.push('IOPV/折溢价数据缺失（可用 mx_finance_data 补）');

  const grid = buildGrid(metrics);
  const d = decide(metrics, premiumPct, grid);

  return {
    code: item.code,
    name: quote?.name || item.name,
    price,
    prevClose: quote?.prevClose ?? null,
    pct: quote?.pct ?? null,
    iopv,
    premiumPct: premiumPct != null ? r2(premiumPct) : null,
    pricePercentile: metrics.pricePercentile != null ? Math.round(metrics.pricePercentile) : null,
    maDeviation: metrics.maDeviation != null ? r2(metrics.maDeviation) : null,
    ma20: metrics.ma20 != null ? r3(metrics.ma20) : null,
    ma60: metrics.ma60 != null ? r3(metrics.ma60) : null,
    ma250: metrics.ma250 != null ? r3(metrics.ma250) : null,
    momentum: metrics.momentum != null ? r2(metrics.momentum) : null,
    absMomentumPositive: metrics.absMomentumPositive,
    momentumRank: null, // 池内相对排名在 signals() 汇总后回填
    volatility: metrics.volatility != null ? r2(metrics.volatility) : null,
    grid,
    action: d.action,
    buyTrigger: d.buyTrigger,
    sellTrigger: d.sellTrigger,
    stopLoss: d.stopLoss,
    takeProfit: d.takeProfit,
    notes: d.notes,
    warning: warnings.length ? warnings.join('；') : null,
  };
}

/** 全池信号 + 双动量相对排名回填 */
export async function signals(): Promise<EtfSignalsResult> {
  const pool = repo.listPool();
  const list = await Promise.all(
    pool.map((it) =>
      computeSignal(it).catch(
        (e): EtfSignal => ({
          code: it.code,
          name: it.name,
          price: null,
          prevClose: null,
          pct: null,
          iopv: null,
          premiumPct: null,
          pricePercentile: null,
          maDeviation: null,
          ma20: null,
          ma60: null,
          ma250: null,
          momentum: null,
          absMomentumPositive: false,
          momentumRank: null,
          volatility: null,
          grid: null,
          action: 'hold',
          buyTrigger: null,
          sellTrigger: null,
          stopLoss: null,
          takeProfit: null,
          notes: [],
          warning: `信号计算失败：${e instanceof Error ? e.message : String(e)}`,
        }),
      ),
    ),
  );

  // 相对动量排名（仅对有动量数据者；绝对动量为负不参与排名但仍展示）
  const ranked = list
    .filter((s) => s.momentum != null && s.absMomentumPositive)
    .sort((a, b) => (b.momentum ?? 0) - (a.momentum ?? 0));
  ranked.forEach((s, i) => {
    s.momentumRank = i + 1;
  });

  return { asOf: nowIso(), signals: list };
}

const ACTION_LABEL: Record<EtfAction, string> = {
  buy: '买入',
  add: '加仓',
  hold: '持有/观望',
  reduce: '减仓/止盈',
  avoid: '规避',
};

const fmtTrig = (label: string, t: EtfTrigger | null): string =>
  t ? ` ${label}${t.value}${t.note ? `(${t.note})` : ''}` : '';

/** 给 agent 看的纯文本信号摘要（etf_signals 工具输出 / 喂给今日计划生成） */
export function formatForAgent(result: EtfSignalsResult): string {
  if (!result.signals.length) return 'ETF 跟踪池为空，请先在 ETF 页添加标的。';
  const lines: string[] = [
    `ETF 跟踪池买卖信号（${result.signals.length} 只，计算于 ${result.asOf}）`,
    '说明：区间位置<20%偏买（位置高不是卖出理由，卖点只看趋势走弱）；折溢价>1%警惕追高；动量/排名体现轮动强弱；触发价为程序化参考，仅研判不下单。',
  ];
  for (const s of result.signals) {
    const head =
      `- ${s.name}(${s.code}) [建议:${ACTION_LABEL[s.action]}]` +
      (s.price != null ? ` 现价${s.price}` : '') +
      (s.pct != null ? ` 涨跌${s.pct >= 0 ? '+' : ''}${s.pct}%` : '') +
      (s.premiumPct != null ? ` 折溢价${s.premiumPct >= 0 ? '+' : ''}${s.premiumPct}%` : '') +
      (s.pricePercentile != null ? ` 分位${s.pricePercentile}%` : '') +
      (s.maDeviation != null ? ` 年线偏离${s.maDeviation >= 0 ? '+' : ''}${s.maDeviation}%` : '') +
      (s.momentum != null
        ? ` 动量${s.momentum >= 0 ? '+' : ''}${s.momentum}${s.momentumRank ? `(排名${s.momentumRank})` : ''}`
        : '') +
      (s.volatility != null ? ` 波动${s.volatility}%` : '');
    const trgs =
      fmtTrig('买', s.buyTrigger) +
      fmtTrig('卖', s.sellTrigger) +
      fmtTrig('损', s.stopLoss) +
      fmtTrig('盈', s.takeProfit);
    const gridStr = s.grid
      ? ` | 网格档${s.grid.level}/${s.grid.gridCount}(间距${s.grid.stepPct}%)` +
        (s.grid.nextBuy ? ` 下买${s.grid.nextBuy}` : '') +
        (s.grid.nextSell ? ` 上卖${s.grid.nextSell}` : '')
      : '';
    const noteStr = s.notes.length ? ` | 要点:${s.notes.join('；')}` : '';
    const warnStr = s.warning ? ` | ⚠️${s.warning}` : '';
    lines.push(head + (trgs ? ` |${trgs}` : '') + gridStr + noteStr + warnStr);
  }
  return lines.join('\n');
}

// ===== ETF 市场总览（仿 market/overview，供 /api/etf/overview 与一键点评） =====

/** 单块失败不影响整体：失败置 fallback（仿 market/overview） */
async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

/** ETF 市场总览快照：全市场概览 + 多榜单 + 主流行情条 + 主题分类，单块失败降级 */
export async function buildOverview(): Promise<EtfOverview> {
  const [stat, broad, gainers, losers, turnover, aum, inflow, outflow, themes] = await Promise.all([
    safe(fetchEtfMarketStat(), null),
    safe(fetchBroadStrip(), []),
    safe(fetchEtfRank('gainers', 12), []),
    safe(fetchEtfRank('losers', 12), []),
    safe(fetchEtfRank('turnover', 12), []),
    safe(fetchEtfRank('aum', 12), []),
    safe(fetchEtfRank('inflow', 10), []),
    safe(fetchEtfRank('outflow', 10), []),
    safe(fetchThemeCategories(), []),
  ]);
  return {
    asOf: nowIso(),
    stat,
    broad,
    gainers,
    losers,
    turnover,
    aum,
    inflow,
    outflow,
    themes,
  };
}

/** ETF 市场点评 prompt（轻量单次 agent 运行），供按钮触发 */
/** ETF 市场点评 / 综合研判的统一任务名（手动按钮、REST、统一 AI 分析中心共用，历史按此过滤） */
export const ETF_REVIEW_TASK_NAME = 'ETF 市场点评';
export const ETF_ANALYZE_TASK_NAME = 'ETF 综合研判';

/**
 * ETF 综合研判 prompt（合并原「ETF 综合研判」+「ETF 行业轮动研判」为一次 agent 运行）：
 * 量化信号 + 持仓 + 消息面综合操作，叠加中线赛道轮动（进攻/回踩/回避）研判。
 * 供 REST /api/etf/analyze、定时（收盘后 15:45）与统一 AI 分析中心共用，并作为今日计划的 ETF 基准源。
 */
export const ETF_ANALYZE_PROMPT =
  '对 ETF 跟踪池做一次综合研判，把「操作信号」与「中线赛道轮动」合并为一份报告，供今日计划直接引用。只研判、不下单。\n\n' +
  '交易日校验（默认放行）：仅周一至周五触发，默认按交易日执行；接口异常一律按交易日继续，不据此判休市。\n\n' +
  '第1步 量化信号底座：用 etf_signals(action=signals) 取全池量化信号（区间位置/折溢价/动量排名/网格水位/操作建议与结构化触发价）。区间位置只说明现价在近两年区间的高低，不是估值，禁止据此说「高估该减仓」。\n' +
  '第2步 中线轮动底座：用 etf_rotation_strength 取「跟踪池 + 主题赛道代表 ETF 的轮动榜」——含 5 态（上升/回踩/加速/过热/破位）、相对沪深300强弱 RS、双动量、周线趋势、主力净流入、综合强度。这是中线赛道研判的事实基础，禁止凭空编造 ETF 或状态。\n' +
  '第3步 持仓与消息：用 real_positions 识别已持有 ETF，结合成本/盈亏；对动量排名靠前或处于买入区的候选，用 mx_finance_data 补折溢价/份额、mx_search 补板块消息（重点找有消息催化的强势赛道）。\n' +
  '纪律（中线右侧介入）：涨幅靠后≠该卖（看趋势与 RS，不看当日涨幅）；过热≠还能涨（过热应等回踩而非追高）；RS 跑赢基准才是真强；只做右侧不抄左侧（破位的不接飞刀）。\n\n' +
  '输出（竖排清单，禁止 Markdown 表格，标注数据时间）：\n' +
  '🟢 一、操作建议：最值得加仓/建仓的 ETF（附依据与挂单价）、需减仓/规避的 ETF。\n' +
  '🔄 二、中线赛道轮动：①该进攻赛道——右侧介入（≤4 条：ETF 名(代码)｜状态(上升/加速)+RS正+周线多头｜消息催化｜理由）②该等回踩（≤3 条：回踩位置｜右侧确认信号，如回踩不破关键均线后再放量/RS 重新转强）③该回避（≤3 条：过热/破位｜原因）。\n' +
  '🎯 三、一句话结论：当前中线赛道轮动方向与进攻/均衡/防守倾向，并点名当前最值得右侧介入的强势赛道。\n' +
  '⚠️ 基于按规则计算的指标做研判，仅供参考，不构成投资建议。';

/**
 * ETF 综合研判统一执行体：跑 agent（量化信号 + 中线轮动 + 持仓消息综合），落 taskRun（taskName=ETF 综合研判）。
 * 手动路由 / 定时 / 一键计划编排共用，避免复制 prompt/modelConfig。
 */
export async function runEtfAnalyze(opts: {
  trigger: RunTrigger;
  channels: NotifyChannel[];
}): Promise<RunTaskResult> {
  return runTask(
    {
      id: null,
      name: ETF_ANALYZE_TASK_NAME,
      prompt: ETF_ANALYZE_PROMPT,
      modelConfig: { thinking: false, maxSteps: 12 },
      notifyChannels: opts.channels,
      timeoutSec: 300,
      purpose: 'analyze',
    },
    opts.trigger,
  );
}

export function buildEtfReviewPrompt(ov: EtfOverview): string {
  const snapshot = {
    stat: ov.stat,
    broad: ov.broad,
    gainers: ov.gainers,
    losers: ov.losers,
    turnover: ov.turnover,
    aum: ov.aum,
    inflow: ov.inflow,
    outflow: ov.outflow,
    themes: ov.themes,
  };
  return (
    '以下是当前 A 股 ETF 市场快照（stat 全市场涨跌家数/平均涨幅/总成交额亿；broad 主流宽基代表 ETF；' +
    'gainers/losers 涨跌幅榜；turnover 成交额榜亿；aum 规模榜亿；inflow/outflow 主力净流入流出榜亿；themes 主题赛道平均涨幅与领涨代表），' +
    '请据此做一段 ETF 市场点评：总结当日 ETF 整体强弱与赚钱效应、强势/弱势主题赛道及轮动方向、主力资金流向（净流入流出集中在哪些方向）、' +
    '规模与成交额异动值得关注的品种，并给出一句偏多/中性/偏空的方向判断 + 理由。' +
    '必要时用 mx_search / mx_finance_data 补充消息面佐证。结论精炼、分点、给依据，禁止 Markdown 表格。\n\n' +
    JSON.stringify(snapshot)
  );
}
