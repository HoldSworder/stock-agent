import type {
  DecisionAction,
  DecisionResult,
  DecisionRiskDebate,
  DecisionTraderPlan,
  StreamEvent,
} from '@stock-agent/shared';
import * as gateway from '../agent/gateway';
import { miaoxiang } from '../miaoxiang/client';
import * as research from '../research/service';
import * as trendradar from '../trendradar/service';
import { buildOverview } from '../market/overview';
import type { KlineBar } from '@stock-agent/shared';
import {
  getKline,
  getQuoteWithLimits,
  getSectorMoneyFlow,
  getStockFundFlow,
  getStockIndustry,
  getTrends,
  searchBoard,
} from '../market/eastmoney';
import { getDragonTiger, getFinancialStatements, getLockupAndHolders, getStockValuation } from '../market/datacenter';
import { fetchRealPositions } from '../realPositions';
import { listReviews } from '../repo';
import { getValue } from '../settings';
import { newId } from '../util';
import {
  AGENT_KEYS,
  getEnabledAnalystKeys,
  getEngineConfig,
  getInstruction,
  resolveModels,
} from './agentConfig';
import { listLessons, recordDecision } from './memory';

// 多智能体辩论决策引擎（原生编排，非单 agent）：
// 数据预取（并行降级）→ 分析师层（并行 oneshot, 轻模型）→ 多空辩论 + 研究总监裁决
// → 风控博弈裁决 → 最终结构化决策。复用 gateway.call 统一计量，全程经 oneshot（recordRun=false）
// 仅落 llm_calls 成本、不刷屏运行抽屉；最终结果由调用方落 ai_analyses 历史。

/** 决策输入 */
export interface DecisionInput {
  /** 6 位股票代码 */
  code: string;
  /** 可选已知名称（缺省尽力解析） */
  name?: string;
  /** 可选调用场景说明（如「来自真实持仓卖点检查」），注入决策 prompt */
  context?: string;
}

/** 运行选项 */
export interface RunDecisionOptions {
  /** 流式进度事件回调（合成 tool_call/tool_result/token，复用 agentTrace 渲染） */
  onEvent?: (e: StreamEvent) => void;
  /** 中止信号 */
  signal?: AbortSignal;
  /** 计量用途分类（缺省 decision） */
  purpose?: string;
}

/** 决策可调参数（经 agentConfig 收口的 settings KV 运行时可配，中枢·智能体页可视化） */
interface DecisionConfig {
  /** 多空辩论轮数（默认 1） */
  rounds: number;
  /** 三方风险辩论轮数（默认 1，0 表示关闭风控层） */
  riskRounds: number;
  /** 是否启用风控博弈层（默认 true） */
  riskEnabled: boolean;
  /** 是否启用舆情/游资定向热点取数（默认 true） */
  targetedFetch: boolean;
  /**
   * 轻模型（quick）：分析师 / 多空研究员 / Trader / 风险辩手。
   * 默认 llmLightModel，回退主模型。
   */
  quickModel: string;
  /**
   * 重模型（deep）：研究总监 + 组合经理（最终决策）。
   * 默认主模型 llmModel。
   */
  deepModel: string;
}

function readConfig(): DecisionConfig {
  const cfg = getEngineConfig();
  const { quickModel, deepModel } = resolveModels();
  return {
    rounds: cfg.rounds,
    riskRounds: cfg.riskRounds,
    riskEnabled: cfg.riskEnabled,
    targetedFetch: cfg.targetedFetch,
    quickModel,
    deepModel,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 截断超长取数结果，避免注入 prompt 撑爆 token */
function clip(value: unknown, max = 2500): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length <= max ? s : `${s.slice(0, max)}\n...[已截断 ${s.length - max} 字符]`;
}

/** best-effort 取数：失败降级为占位文案，单点失败不拖垮整条流水线 */
async function safe(fn: () => Promise<unknown>, fallback: string, max = 2500): Promise<string> {
  try {
    return clip(await fn(), max);
  } catch {
    return fallback;
  }
}

/** 中止检查：抛出 AbortError 由上层收口 */
function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

// ===== K 线衍生指标工具（纯函数，供多日序列/相对强弱/板块/大盘块复用）=====

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** 带符号百分比文本，如 +1.23% */
const fmtPct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
/** 区间收益：last / closes[len-1-n] - 1，单位 %（数据不足返回 0） */
function pctReturn(closes: number[], n: number): number {
  if (closes.length <= n) return 0;
  const base = closes[closes.length - 1 - n];
  return base > 0 ? (closes[closes.length - 1] / base - 1) * 100 : 0;
}
/** 简单移动均值（取末 n 个） */
const maOf = (closes: number[], n: number): number => avg(closes.slice(-n));
/** 收盘价 → 日收益序列（%） */
function dailyReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    r.push(closes[i - 1] > 0 ? (closes[i] / closes[i - 1] - 1) * 100 : 0);
  }
  return r;
}
/** Beta：个股日收益对基准日收益的 cov/var（按末端对齐，长度不足返回 null） */
function betaOf(stockCloses: number[], idxCloses: number[]): number | null {
  const a = dailyReturns(stockCloses);
  const b = dailyReturns(idxCloses);
  const len = Math.min(a.length, b.length);
  if (len < 10) return null;
  const sa = a.slice(-len);
  const sb = b.slice(-len);
  const ma = avg(sa);
  const mb = avg(sb);
  let cov = 0;
  let varb = 0;
  for (let i = 0; i < len; i += 1) {
    cov += (sa[i] - ma) * (sb[i] - mb);
    varb += (sb[i] - mb) ** 2;
  }
  return varb > 0 ? cov / varb : null;
}

/** 沪深300 日线 secid（指数与个股撞码，须显式 secid） */
const CSI300_SECID = '1.000300';

interface KlineBundle {
  /** 实时 K 线衍生指标（MA20/区间/涨跌/量能），与原 klineNote 等价 */
  klineNote: string;
  /** 近 20 日逐日量价序列文本 */
  seriesNote: string;
  /** 相对沪深300强弱 + 均线排列 + 新高/回撤 + Beta */
  relStrengthNote: string;
  /** 大盘（沪深300）多日序列：近10日逐日涨跌 + 趋势 + 量能 */
  marketSeriesNote: string;
}

/**
 * 一次取齐 个股 + 沪深300 日线（块1/块3 共享），产出 4 段 K 线衍生文本。
 * 全程 best-effort：任一段失败置占位串，绝不抛出（不拖垮预取 Promise.all）。
 */
async function computeKlineBundle(code: string, _signal?: AbortSignal): Promise<KlineBundle> {
  const fallback: KlineBundle = {
    klineNote: 'K 线数据不可用。',
    seriesNote: '',
    relStrengthNote: '',
    marketSeriesNote: '',
  };
  let stock: KlineBar[] = [];
  let idx: KlineBar[] = [];
  try {
    [stock, idx] = await Promise.all([
      getKline(code, 'day', 60).catch(() => [] as KlineBar[]),
      getKline('000300', 'day', 60, CSI300_SECID).catch(() => [] as KlineBar[]),
    ]);
  } catch {
    return fallback;
  }
  if (stock.length < 5) return fallback;

  const last = stock[stock.length - 1];
  const closes = stock.map((b) => b.close);
  const vols = stock.map((b) => b.volume);
  const ma20 = maOf(closes, 20);
  const hi = Math.max(...stock.map((b) => b.high));
  const lo = Math.min(...stock.map((b) => b.low));
  const ret5 = pctReturn(closes, 5);
  const ret20 = pctReturn(closes, 20);
  const ret60 = pctReturn(closes, 60);
  const posInRange = hi > lo ? ((last.close - lo) / (hi - lo)) * 100 : 50;
  const avgVol20 = avg(vols.slice(-20));
  const volRatio = avgVol20 > 0 ? last.volume / avgVol20 : 1;

  // ---- klineNote（与原实现等价）----
  const klineNote = [
    `现价 ${last.close}（${last.time}）`,
    `MA20 ${ma20.toFixed(2)}，现价${last.close >= ma20 ? '站上' : '跌破'} MA20`,
    `60 日区间 [${lo.toFixed(2)}, ${hi.toFixed(2)}]，价格位置约 ${posInRange.toFixed(0)}%`,
    `近 5 日 ${fmtPct(ret5)}，近 20 日 ${fmtPct(ret20)}`,
    `量能：最新量/20 日均量 ≈ ${volRatio.toFixed(2)}`,
  ].join('\n');

  // ---- seriesNote：近 20 日逐日（用上一根真实收盘算涨跌幅）----
  const start = Math.max(1, stock.length - 20);
  const seriesRows: string[] = [];
  for (let i = start; i < stock.length; i += 1) {
    const b = stock[i];
    const prevClose = stock[i - 1].close;
    const pct = prevClose > 0 ? (b.close / prevClose - 1) * 100 : 0;
    const vr = avgVol20 > 0 ? b.volume / avgVol20 : 1;
    seriesRows.push(`${b.time.slice(5)} 收${b.close.toFixed(2)} ${fmtPct(pct)} 量比${vr.toFixed(2)}`);
  }
  const seriesNote = `近20日逐日（日期 收盘 涨跌幅 量比）：\n${seriesRows.join('\n')}`;

  // ---- relStrengthNote：均线排列 / 新高 / 回撤 / 相对沪深300 / Beta ----
  const ma5 = maOf(closes, 5);
  const ma10 = maOf(closes, 10);
  const ma60 = maOf(closes, 60);
  const maOrder = ma5 >= ma10 && ma10 >= ma20 && ma20 >= ma60 ? '多头排列' : ma5 <= ma10 && ma10 <= ma20 ? '空头排列' : '均线纠缠';
  const prevCloses = closes.slice(0, -1);
  const isNewHigh = prevCloses.length > 0 && last.close >= Math.max(...prevCloses);
  let peak = closes[0];
  let mdd = 0;
  for (const c of closes) {
    peak = Math.max(peak, c);
    if (peak > 0) mdd = Math.min(mdd, c / peak - 1);
  }
  // 连阳/连阴：从末端向前数同向根数
  let streak = 0;
  let dir = 0;
  for (let i = stock.length - 1; i >= 1; i -= 1) {
    const d = stock[i].close >= stock[i - 1].close ? 1 : -1;
    if (dir === 0) dir = d;
    if (d === dir) streak += 1;
    else break;
  }
  const streakDesc = streak >= 2 ? `${dir > 0 ? '连阳' : '连阴'} ${streak} 日` : '无明显连续';
  const relLines = [
    `均线：MA5 ${ma5.toFixed(2)} / MA10 ${ma10.toFixed(2)} / MA20 ${ma20.toFixed(2)} / MA60 ${ma60.toFixed(2)}（${maOrder}）`,
    `60 日${isNewHigh ? '创收盘新高' : '未创新高'}，区间最大回撤 ${(mdd * 100).toFixed(1)}%，当前${streakDesc}`,
  ];
  const idxCloses = idx.map((b) => b.close);
  if (idxCloses.length >= 21) {
    const ir5 = pctReturn(idxCloses, 5);
    const ir20 = pctReturn(idxCloses, 20);
    const ir60 = pctReturn(idxCloses, 60);
    const beta = betaOf(closes, idxCloses);
    relLines.push(
      `相对沪深300：近5日 ${fmtPct(ret5 - ir5)}，近20日 ${fmtPct(ret20 - ir20)}，近60日 ${fmtPct(ret60 - ir60)}（正=跑赢大盘）` +
        `${beta != null ? `；Beta≈${beta.toFixed(2)}` : ''}`,
    );
  } else {
    relLines.push('大盘基准（沪深300）不可用，相对强弱略。');
  }
  const relStrengthNote = relLines.join('\n');

  // ---- marketSeriesNote：大盘近10日逐日 + 趋势 + 量能 ----
  let marketSeriesNote = '大盘多日序列不可用。';
  if (idx.length >= 5) {
    const idxStart = Math.max(1, idx.length - 10);
    const mRows: string[] = [];
    for (let i = idxStart; i < idx.length; i += 1) {
      const prevClose = idx[i - 1].close;
      const pct = prevClose > 0 ? (idx[i].close / prevClose - 1) * 100 : 0;
      mRows.push(`${idx[i].time.slice(5)} ${fmtPct(pct)}`);
    }
    const ivols = idx.map((b) => b.volume);
    const volTrend = avg(ivols.slice(-20)) > 0 ? avg(ivols.slice(-5)) / avg(ivols.slice(-20)) : 1;
    marketSeriesNote = [
      `沪深300：近5日 ${fmtPct(pctReturn(idxCloses, 5))}，近20日 ${fmtPct(pctReturn(idxCloses, 20))}`,
      `近10日：${mRows.join('  ')}`,
      `量能：近5/20日均量 ≈ ${volTrend.toFixed(2)}`,
    ].join('\n');
  }

  return {
    klineNote: clip(klineNote, 1500),
    seriesNote: clip(seriesNote, 1500),
    relStrengthNote: clip(relStrengthNote, 1200),
    marketSeriesNote: clip(marketSeriesNote, 1200),
  };
}

/**
 * 标的所属板块多日走势 + 个股相对板块强弱 + 板块资金流。
 * 行业名经 searchBoard 解析 BK 代码 → 取板块 60 日线；资金流优先匹配 getSectorMoneyFlow（按 BK 代码命中），
 * 命中失败且妙想就绪则用 financeData 兜底。全程 best-effort，由外层 safe 收口异常。
 */
async function computeSectorNote(code: string, signal: AbortSignal | undefined, mxReady: boolean): Promise<string> {
  const industry = await getStockIndustry(code).catch(() => '');
  if (!industry) return '板块数据不可用（未取到所属行业）。';
  const boards = await searchBoard(industry, 5).catch(() => []);
  const board = boards[0];
  if (!board) return `所属行业：${industry}（未匹配到板块代码，无法取板块走势）。`;

  const lines: string[] = [`所属行业板块：${board.name}(${board.code})`];

  // 板块 60 日线 + 个股相对板块强弱（个股 K 线经 httpClient 15s 缓存去重，不额外打满）
  const [boardBars, stockBars] = await Promise.all([
    getKline(board.code, 'day', 60).catch(() => [] as KlineBar[]),
    getKline(code, 'day', 60).catch(() => [] as KlineBar[]),
  ]);
  if (boardBars.length >= 5) {
    const bc = boardBars.map((b) => b.close);
    const bret5 = pctReturn(bc, 5);
    const bret20 = pctReturn(bc, 20);
    const bhi = Math.max(...boardBars.map((b) => b.high));
    const blo = Math.min(...boardBars.map((b) => b.low));
    const bpos = bhi > blo ? ((boardBars[boardBars.length - 1].close - blo) / (bhi - blo)) * 100 : 50;
    lines.push(`板块近5日 ${fmtPct(bret5)}，近20日 ${fmtPct(bret20)}，60日区间位置约 ${bpos.toFixed(0)}%`);
    if (stockBars.length >= 21) {
      const sc = stockBars.map((b) => b.close);
      lines.push(
        `个股相对板块：近5日 ${fmtPct(pctReturn(sc, 5) - bret5)}，近20日 ${fmtPct(pctReturn(sc, 20) - bret20)}（正=跑赢板块）`,
      );
    }
  } else {
    lines.push('板块 K 线数据不足。');
  }

  // 板块主力资金：按 BK 代码在净流入/净流出榜中命中
  let flowDone = false;
  try {
    const [inflow, outflow] = await Promise.all([
      getSectorMoneyFlow('inflow', 50).catch(() => []),
      getSectorMoneyFlow('outflow', 50).catch(() => []),
    ]);
    const hit = [...inflow, ...outflow].find((s) => s.code === board.code);
    if (hit) {
      lines.push(
        `板块主力资金：净${hit.netInflow >= 0 ? '流入' : '流出'} ${Math.abs(hit.netInflow).toFixed(2)} 亿，板块涨跌 ${fmtPct(hit.pct)}`,
      );
      flowDone = true;
    }
  } catch {
    /* 资金榜失败：下方妙想兜底或省略 */
  }
  if (!flowDone && mxReady) {
    try {
      const mx = await miaoxiang.financeData(`${industry} 板块近5日主力资金净流入与板块涨跌幅`, signal);
      lines.push(`板块资金（妙想）：\n${clip(mx, 800)}`);
    } catch {
      /* 妙想兜底失败：仅保留价格走势 */
    }
  }

  return lines.join('\n');
}

/**
 * 当日分时/盘口（getTrends，腾讯优先东财兜底）：现价/涨跌、振幅、相对均价线、尾盘约30分钟强弱与量占比。
 * 对"真实持仓-1440-卖点检查"调用方价值最高（盘中尾盘是否还有承接）。空数据降级占位。
 */
async function computeIntradayNote(code: string): Promise<string> {
  const tr = await getTrends(code).catch(() => null);
  const pts = (tr?.points ?? []).filter((p) => p.price > 0);
  if (!tr || pts.length < 2) return '当日分时数据不可用。';
  const prev = tr.prevClose;
  const last = pts[pts.length - 1];
  const prices = pts.map((p) => p.price);
  const hi = Math.max(...prices);
  const lo = Math.min(...prices);
  const dayPct = prev > 0 ? (last.price / prev - 1) * 100 : 0;
  const amplitude = prev > 0 ? ((hi - lo) / prev) * 100 : 0;
  const vsAvg = last.avg > 0 ? (last.price / last.avg - 1) * 100 : 0;
  // 尾盘约 30 分钟（1 分钟级取末 30 点）强弱 + 量占全日
  const tail = pts.slice(-30);
  const tailRet = tail.length > 1 && tail[0].price > 0 ? (last.price / tail[0].price - 1) * 100 : 0;
  const totalVol = pts.reduce((a, p) => a + p.volume, 0);
  const tailVol = tail.reduce((a, p) => a + p.volume, 0);
  const tailVolShare = totalVol > 0 ? (tailVol / totalVol) * 100 : 0;
  return [
    `当日：现价 ${last.price.toFixed(2)}（${fmtPct(dayPct)}，${last.time}），昨收 ${prev.toFixed(2)}`,
    `分时区间 [${lo.toFixed(2)}, ${hi.toFixed(2)}]，振幅 ${amplitude.toFixed(2)}%，现价${vsAvg >= 0 ? '站上' : '跌破'}均价线（${fmtPct(vsAvg)}）`,
    `尾盘约30分钟 ${fmtPct(tailRet)}，尾盘量占全日 ${tailVolShare.toFixed(0)}%`,
  ].join('\n');
}

/**
 * 资金流多日趋势：主力/超大单近 6 日净流入逐日序列（东财 fflow，免 MX，always-on），
 * 已配置妙想时增补北向（沪深股通）趋势与两融余额方向（个股北向逐日明细 2024 已停披露，故走 MX 近似）。
 * 补足只看单点资金的短板，喂游资分析师判断吸筹/出货的「持续性」。
 */
async function computeFundFlowNote(
  code: string,
  name: string,
  signal: AbortSignal | undefined,
  mxReady: boolean,
): Promise<string> {
  const days = await getStockFundFlow(code, 6).catch(() => []);
  const parts: string[] = [];
  if (days.length) {
    const yi = (v: number): string => `${v / 1e8 >= 0 ? '+' : ''}${(v / 1e8).toFixed(2)}亿`;
    const cumMain = days.reduce((a, d) => a + d.main, 0) / 1e8;
    const posDays = days.filter((d) => d.main > 0).length;
    const lines = days.map(
      (d) =>
        `${d.date.slice(5)} 收${d.close.toFixed(2)}(${fmtPct(d.pct)}) ` +
        `主力${yi(d.main)}(占比${d.mainPct.toFixed(1)}%) 超大单${yi(d.superBig)}`,
    );
    parts.push(
      `近${days.length}日主力资金（东财）：累计净${cumMain >= 0 ? '+' : ''}${cumMain.toFixed(2)}亿，` +
        `净流入 ${posDays}/${days.length} 日\n${lines.join('\n')}`,
    );
  } else {
    parts.push('主力资金多日数据不可用。');
  }
  if (mxReady) {
    try {
      parts.push(
        '北向/两融（妙想）：\n' +
          clip(
            await miaoxiang.financeData(
              `${name}(${code}) 北向（沪深股通）资金近期净买入趋势，以及最新融资融券余额的变化方向`,
              signal,
            ),
            1200,
          ),
      );
    } catch {
      /* MX 增补失败：仅用东财主力资金序列 */
    }
  }
  return parts.join('\n\n');
}

/**
 * 估值：当前 PE(TTM)/PE(静)/PB/PEG/PS/PCF 快照（东财 datacenter，免 MX，always-on），
 * 已配置妙想时增补 PE/PB 近 3 年历史分位与所属行业中位数对比（东财该报表不含历史分位，故走 MX）。
 * 给基本面分析师的高估/低估判断提供锚点（替代只看当前绝对值）。
 */
async function computeValuationNote(
  code: string,
  name: string,
  signal: AbortSignal | undefined,
  mxReady: boolean,
): Promise<string> {
  const snapshot = await getStockValuation(code).catch(() => '');
  const parts: string[] = [snapshot && snapshot !== '暂无估值数据。' ? snapshot : '当前估值快照不可用。'];
  if (mxReady) {
    try {
      parts.push(
        '历史分位/同业（妙想）：\n' +
          clip(
            await miaoxiang.financeData(
              `${name}(${code}) 的PE(TTM)与PB在近3年的历史分位数（百分位，越低越便宜），并与所属行业中位数估值横向对比`,
              signal,
            ),
            1200,
          ),
      );
    } catch {
      /* MX 增补失败：仅用东财当前估值快照 */
    }
  }
  return parts.join('\n\n');
}

/**
 * 单步 LLM 调用：经统一门面 oneshot（recordRun=false：只计成本、不建运行）。
 * 同时合成 tool_call/tool_result 进度事件，让前端 agentTrace 以可折叠卡片展示各阶段。
 */
async function stage(
  label: string,
  prompt: string,
  model: string,
  opts: RunDecisionOptions,
  systemPrompt?: string,
): Promise<string> {
  ensureNotAborted(opts.signal);
  const id = newId();
  opts.onEvent?.({ type: 'tool_call', id, name: label, args: '' });
  const res = await gateway.call({
    mode: 'oneshot',
    recordRun: false,
    trigger: 'manual',
    purpose: opts.purpose ?? 'decision',
    taskName: label,
    model,
    systemPrompt,
    prompt,
    temperature: 0.3,
  });
  const text = res.status === 'success' ? res.outputText.trim() : `（${label}失败：${res.error ?? '未知错误'}）`;
  opts.onEvent?.({ type: 'tool_result', id, name: label, ok: res.status === 'success', preview: text.slice(0, 300) });
  return text;
}

/** 预取的标的上下文（注入各分析师） */
interface PrefetchContext {
  name: string;
  /** 是否在真实持仓中（影响 buy/add vs hold/reduce 措辞） */
  held: boolean;
  /** 持仓简述（现价/成本/盈亏/仓位），非持仓为空串 */
  positionNote: string;
  quoteNote: string;
  researchNote: string;
  /** 大盘环境（含 A 股指数 + 外盘 globalIndices + 期货 futures + 情绪/资金） */
  marketNote: string;
  newsNote: string;
  /** 龙虎榜上榜明细+席位资金（东财 datacenter 结构化，游资追踪） */
  dragonNote: string;
  /** 财报主表（营收/净利/毛利/EPS/现金流/ROE 及同比，东财 F10 结构化，基本面） */
  statementsNote: string;
  /** 限售解禁/大股东增减持/股权质押（东财 datacenter 结构化为主 + 妙想增补，A股特有供给冲击） */
  lockupNote: string;
  /** 行业政策/监管/窗口指导（政策市核心） */
  policyNote: string;
  /** TrendRadar 全网热点话题 + 按标的搜得的热榜新闻（舆情/游资） */
  hotspotNote: string;
  /** 实时 K 线衍生指标文本（MA20/区间位置/涨跌幅/量能） */
  klineNote: string;
  /** 近 20 日逐日量价序列文本（多日走势，技术/游资） */
  seriesNote: string;
  /** 相对沪深300强弱 + 均线排列 + 新高/回撤 + Beta（技术/政策） */
  relStrengthNote: string;
  /** 标的自身所属板块多日走势 + 个股相对板块强弱 + 板块资金流（技术/游资） */
  sectorNote: string;
  /** 当日分时/盘口：涨跌/振幅/均价线/尾盘强弱与量占比（技术/游资，尾盘卖点） */
  intradayNote: string;
  /** 资金流多日趋势（妙想）：主力近5日序列 + 北向趋势 + 两融方向（游资） */
  fundFlowNote: string;
  /** 估值分位 + 同业对比（妙想）：PE/PB/PEG + 近3年分位 + 行业中位数（基本面） */
  valuationNote: string;
  /** 大盘（沪深300）多日序列：近10日逐日涨跌 + 趋势 + 量能（政策/宏观） */
  marketSeriesNote: string;
  /** 最近一次大盘复盘结论（宏观背景） */
  marketStanceNote: string;
  /** 历史决策教训（已复盘记忆，仅注入研究总监/组合经理） */
  lessons: string[];
}

/** 并行预取标的数据（全部 best-effort 降级，不占辩论 step） */
async function prefetch(input: DecisionInput, opts: RunDecisionOptions): Promise<PrefetchContext> {
  ensureNotAborted(opts.signal);
  const id = newId();
  opts.onEvent?.({ type: 'tool_call', id, name: '数据预取', args: input.code });

  // 真实持仓：判定是否持有 + 取名称/成本（best-effort）
  let held = false;
  let positionNote = '';
  let nameFromPos = '';
  try {
    const pf = await fetchRealPositions();
    const p = pf.positions.find((x) => x.code === input.code);
    if (p) {
      held = true;
      nameFromPos = p.name;
      positionNote =
        `已持有：现价${p.price} 成本${p.avgCost} ${p.qty}股 ` +
        `持有盈亏${p.holdProfit.toFixed(0)}(${(p.holdRate * 100).toFixed(2)}%) ` +
        `当日${p.todayProfit.toFixed(0)}(${(p.todayRate * 100).toFixed(2)}%) 仓位${(p.positionRate * 100).toFixed(1)}%`;
    }
  } catch {
    /* 未配置同花顺 Cookie 或拉取失败：按未持有处理 */
  }

  const queryName = input.name || nameFromPos || input.code;
  // 妙想是否就绪：未配置 MX_APIKEY 时，消息/政策走 TrendRadar 兜底，整条流水线仍可跑
  const mxReady = !!getValue('mxApiKey');

  const [
    quoteNote,
    researchNote,
    marketNote,
    newsNote,
    dragonNote,
    statementsNote,
    lockupNote,
    policyNote,
    hotspotNote,
    marketStanceNote,
    sectorNote,
    intradayNote,
    fundFlowNote,
    valuationNote,
    klineBundle,
  ] = await Promise.all([
    safe(
      () =>
        miaoxiang.financeData(
          `${input.code} 的实时行情：现价、今日涨跌幅、涨停价、跌停价、换手率、量比、主力资金净流入、市盈率、市净率、所属行业与概念板块`,
          opts.signal,
        ),
      '妙想行情数据不可用（未配置 MX_APIKEY 或请求失败）。',
      3000,
    ),
    // 研报增强：个股研报（窗口放宽）+ best-effort 近期行业研报动态
    safe(async () => {
      const [stockReports, industryReports] = await Promise.all([
        research.listReports({ type: 'stock', code: input.code, days: 90, pageSize: 10 }).catch(() => []),
        research.listReports({ type: 'industry', days: 14, pageSize: 5 }).catch(() => []),
      ]);
      const parts: string[] = [];
      if (stockReports.length) {
        parts.push(
          '个股研报：\n' +
            stockReports
              .map((r) => {
                const tp = r.targetPriceHigh ?? r.targetPriceLow;
                return (
                  `${r.publishDate} [${r.orgName}] ${r.title}` +
                  `${r.rating ? `｜评级${r.rating}` : ''}${r.ratingChange ? `(${r.ratingChange})` : ''}` +
                  `${tp != null ? `｜目标价${tp}` : ''}`
                );
              })
              .join('\n'),
        );
      } else {
        parts.push('近 90 天无该股研报。');
      }
      if (industryReports.length) {
        parts.push(
          '近期行业研报动态：\n' +
            industryReports.map((r) => `${r.publishDate} [${r.orgName}] ${r.industryName ?? ''} ${r.title}`.trim()).join('\n'),
        );
      }
      return parts.join('\n\n');
    }, '研报数据不可用（研报模块未启用或请求失败）。', 3000),
    // 大盘环境：复用 buildOverview 已抓但此前被丢弃的 外盘(globalIndices) 与 期货(futures)
    safe(async () => {
      const ov = await buildOverview();
      return JSON.stringify({
        indices: ov.indices,
        globalIndices: ov.globalIndices?.slice(0, 12),
        futures: ov.futures?.slice(0, 12),
        turnoverTotal: ov.turnoverTotal,
        emotion: ov.emotion,
        hotIndustries: ov.hotIndustries?.slice(0, 6),
        hotConcepts: ov.hotConcepts?.slice(0, 6),
        moneyInflow: ov.moneyInflow?.slice(0, 6),
        moneyOutflow: ov.moneyOutflow?.slice(0, 6),
      });
    }, '大盘快照不可用。', 3000),
    // 消息面：主用 TrendRadar 热榜（免 MX）；已配置 MX 时增补妙想消息
    safe(async () => {
      const news = await trendradar.searchNews(queryName, 20).catch(() => []);
      const parts: string[] = [];
      if (news.length) {
        parts.push('热榜新闻：\n' + news.map((n) => `[${n.platformName || n.platform}] ${n.title}`).join('\n'));
      }
      if (mxReady) {
        try {
          parts.push('妙想消息面：\n' + clip(await miaoxiang.search(`${queryName} 最近的重要新闻、公告、机构观点`, opts.signal), 2000));
        } catch {
          /* MX 增补失败：仅用热榜 */
        }
      }
      return parts.join('\n\n') || '暂无消息面数据。';
    }, '消息面不可用。', 3000),
    // 龙虎榜（东财 datacenter，免 MX）：上榜明细 + 净买入/换手/上榜原因，喂 游资追踪
    safe(() => getDragonTiger(input.code, 5), '龙虎榜数据不可用。', 2000),
    // 财报主表（东财 F10，免 MX）：营收/净利/毛利/EPS/现金流/ROE 及同比，喂 基本面
    safe(() => getFinancialStatements(input.code), '财报数据不可用。', 2000),
    // 解禁/增减持/质押：东财 datacenter 结构化为主；已配置 MX 时附加妙想自然语言增补
    safe(async () => {
      const structured = await getLockupAndHolders(input.code);
      if (!mxReady) return structured;
      try {
        const mx = await miaoxiang.financeData(
          `${input.code} 近期限售股解禁安排（解禁日期与数量占比）、大股东增减持计划、股权质押比例`,
          opts.signal,
        );
        return `${structured}\n\n妙想增补：\n${clip(mx, 1500)}`;
      } catch {
        return structured;
      }
    }, '解禁/减持/质押数据不可用。', 2800),
    // 政策面：主用 TrendRadar 行业政策热榜（免 MX）；已配置 MX 时增补妙想政策
    safe(async () => {
      const news = await trendradar.searchNews(`${queryName} 行业 政策`, 15).catch(() => []);
      const parts: string[] = [];
      if (news.length) {
        parts.push('政策相关热榜：\n' + news.map((n) => `[${n.platformName || n.platform}] ${n.title}`).join('\n'));
      }
      if (mxReady) {
        try {
          parts.push(
            '妙想政策面：\n' +
              clip(await miaoxiang.search(`${queryName} 所属行业最新政策、监管动向、窗口指导与产业扶持/限制`, opts.signal), 2000),
          );
        } catch {
          /* MX 增补失败：仅用热榜 */
        }
      }
      return parts.join('\n\n') || '暂无政策面数据。';
    }, '政策面不可用。', 2500),
    // 全网热点（TrendRadar，免 MX）：高频话题 + 按标的搜得的热榜新闻，喂 舆情/游资
    safe(async () => {
      const [topics, news] = await Promise.all([
        trendradar.trending(15).catch(() => []),
        trendradar.searchNews(queryName, 20).catch(() => []),
      ]);
      const parts: string[] = [];
      if (topics.length) {
        parts.push('全网热点话题：' + topics.map((t) => `${t.keyword}(热度${t.frequency}/命中${t.matchedNews})`).join('  '));
      }
      if (news.length) {
        parts.push('相关热榜新闻：\n' + news.map((n) => `[${n.platformName || n.platform}] ${n.title}`).join('\n'));
      }
      return parts.join('\n\n') || '暂无热点数据。';
    }, 'TrendRadar 热点不可用。', 3000),
    // 最近一次大盘复盘结论（宏观背景）
    safe(async () => {
      const rows = listReviews(1);
      const text = rows[0]?.outputText;
      if (!text) return '暂无最近大盘复盘。';
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return '大盘复盘解析失败。';
      }
      const parts: string[] = [];
      if (typeof r.marketTrend === 'string' && r.marketTrend) parts.push(`大盘走势：${r.marketTrend}`);
      const cs = r.comprehensiveStance as { bias?: string; summary?: string } | null | undefined;
      if (cs && (cs.bias || cs.summary)) parts.push(`综合定调：${cs.bias ?? ''} ${cs.summary ?? ''}`.trim());
      const themes = Array.isArray(r.mainThemes) ? (r.mainThemes as Array<{ name?: string; strength?: string }>) : [];
      if (themes.length) parts.push('主线题材：' + themes.slice(0, 4).map((m) => `${m.name ?? ''}(${m.strength ?? ''})`).join('、'));
      return parts.join('\n') || '暂无大盘复盘要点。';
    }, '大盘复盘不可用。', 2000),
    // 块2 标的自身板块（东财，免 MX 即可跑；资金流可妙想兜底）：板块多日走势 + 个股相对板块强弱 + 板块资金
    safe(() => computeSectorNote(input.code, opts.signal, mxReady), '板块数据不可用。', 1500),
    // 当日分时/盘口（东财/腾讯，免 MX）：涨跌/振幅/均价线/尾盘强弱与量占比，喂技术/游资（尾盘卖点）
    safe(() => computeIntradayNote(input.code), '当日分时数据不可用。', 1000),
    // 资金流多日趋势（东财主力序列免MX + 妙想北向/两融增补）：喂游资（吸筹/出货持续性）
    safe(() => computeFundFlowNote(input.code, queryName, opts.signal, mxReady), '资金流多日数据不可用。', 1800),
    // 估值（东财当前PE/PB/PEG/PS/PCF免MX + 妙想历史分位/同业增补）：喂基本面（高估/低估锚点）
    safe(() => computeValuationNote(input.code, queryName, opts.signal, mxReady), '估值数据不可用。', 1800),
    // 块1+块3 K 线衍生：个股 + 沪深300 一次取齐，产出 kline/序列/相对强弱/大盘序列（never throw）
    computeKlineBundle(input.code, opts.signal),
  ]);
  const { klineNote, seriesNote, relStrengthNote, marketSeriesNote } = klineBundle;

  // 历史教训（已复盘记忆，best-effort）：仅注入研究总监/组合经理，限 token
  const lessons = listLessons(input.code, 3)
    .map((m) => `${m.decisionDate} ${ACTION_LABELS[m.action]}(${m.verdict ?? '中性'}, Alpha ${m.alpha ?? '—'}%)：${m.lesson ?? ''}`)
    .filter(Boolean);

  const name = queryName;
  opts.onEvent?.({
    type: 'tool_result',
    id,
    name: '数据预取',
    ok: true,
    preview: `已取齐 ${name}(${input.code}) 行情/K线(含20日序列+相对沪深300强弱)/分时盘口/板块多日/资金流多日/估值分位/研报/大盘(含外盘期货+多日序列)/热点/消息/政策/龙虎榜/三表/解禁/大盘复盘${held ? '/持仓' : ''}${lessons.length ? `，注入 ${lessons.length} 条历史教训` : ''}`,
  });

  return {
    name,
    held,
    positionNote,
    quoteNote,
    researchNote,
    marketNote,
    newsNote,
    dragonNote,
    statementsNote,
    lockupNote,
    policyNote,
    hotspotNote,
    klineNote,
    seriesNote,
    relStrengthNote,
    sectorNote,
    intradayNote,
    fundFlowNote,
    valuationNote,
    marketSeriesNote,
    marketStanceNote,
    lessons,
  };
}

// 7 分析师对齐 TradingAgents-astock：技术面 / 舆情 / 新闻 / 基本面 / 政策 / 游资追踪 / 解禁监控。
// dataKeys 标注该角色重点引用的预取数据块，buildAnalystPrompt 据此精简注入、控 token。
type AnalystDataKey =
  | 'quote'
  | 'research'
  | 'market'
  | 'news'
  | 'policy'
  | 'lockup'
  | 'hotspot'
  | 'kline'
  | 'series'
  | 'relStrength'
  | 'sector'
  | 'intraday'
  | 'fundFlow'
  | 'valuation'
  | 'marketSeries'
  | 'stance'
  | 'dragon'
  | 'statements';
// 角色元数据（key/中文名/dataKeys）静态固定；职责（focus）由 agentConfig.getInstruction(key)
// 运行时取生效值（覆盖优先，回退默认），dataKeys 与 ANALYST_KEYS 顺序一一对应。
interface AnalystMeta {
  key: string;
  role: string;
  dataKeys: AnalystDataKey[];
}
const ANALYST_ROLES: AnalystMeta[] = [
  { key: 'analyst.fundamental', role: '基本面分析师', dataKeys: ['statements', 'valuation', 'quote', 'research'] },
  { key: 'analyst.technical', role: '技术面分析师', dataKeys: ['kline', 'series', 'relStrength', 'intraday', 'quote'] },
  { key: 'analyst.capital', role: '游资情绪分析师', dataKeys: ['dragon', 'hotspot', 'fundFlow', 'series', 'sector', 'intraday', 'quote', 'news'] },
  { key: 'analyst.news', role: '新闻分析师', dataKeys: ['news', 'research'] },
  { key: 'analyst.policy', role: '政策分析师', dataKeys: ['policy', 'market', 'marketSeries', 'stance'] },
  { key: 'analyst.sentiment', role: '舆情分析师', dataKeys: ['hotspot', 'news', 'market'] },
  { key: 'analyst.lockup', role: '解禁监控师', dataKeys: ['lockup', 'quote'] },
];

/** 组装分析师 prompt：按角色 dataKeys 精简注入预取上下文，职责取自 agentConfig（覆盖优先），要求精炼聚焦 */
function buildAnalystPrompt(roleFocus: AnalystMeta, code: string, ctx: PrefetchContext): string {
  // note：各数据块原文；header：注入时的小标题。note 为空（取数降级占位空串）则整块不注入，避免空标题。
  const note: Record<AnalystDataKey, string> = {
    quote: ctx.quoteNote,
    research: ctx.researchNote,
    market: ctx.marketNote,
    news: ctx.newsNote,
    policy: ctx.policyNote,
    lockup: ctx.lockupNote,
    hotspot: ctx.hotspotNote,
    kline: ctx.klineNote,
    series: ctx.seriesNote,
    relStrength: ctx.relStrengthNote,
    sector: ctx.sectorNote,
    intraday: ctx.intradayNote,
    fundFlow: ctx.fundFlowNote,
    valuation: ctx.valuationNote,
    marketSeries: ctx.marketSeriesNote,
    stance: ctx.marketStanceNote,
    dragon: ctx.dragonNote,
    statements: ctx.statementsNote,
  };
  const header: Record<AnalystDataKey, string> = {
    quote: '=== 行情/资金/估值（妙想）===',
    research: '=== 研报一致预期 ===',
    market: '=== 大盘环境（含外盘/期货）===',
    news: '=== 消息面 ===',
    policy: '=== 行业政策面 ===',
    lockup: '=== 解禁/增减持/质押 ===',
    hotspot: '=== 全网热点/舆情（TrendRadar）===',
    kline: '=== 实时 K 线技术位（东财）===',
    series: '=== 近20日逐日量价序列（东财）===',
    relStrength: '=== 相对强弱/均线/新高回撤（vs沪深300）===',
    sector: '=== 所属板块多日走势/资金（东财）===',
    intraday: '=== 当日分时/盘口（东财）===',
    fundFlow: '=== 资金流多日趋势：主力/超大单（东财）+北向/两融（妙想）===',
    valuation: '=== 估值：当前PE/PB/PEG/PS/PCF（东财）+历史分位/同业（妙想）===',
    marketSeries: '=== 大盘多日序列（沪深300）===',
    stance: '=== 最近大盘复盘结论 ===',
    dragon: '=== 龙虎榜明细/席位资金（东财）===',
    statements: '=== 财报主表/盈利质量（东财 F10）===',
  };
  const data = roleFocus.dataKeys
    .map((k) => (note[k]?.trim() ? `${header[k]}\n${note[k]}` : ''))
    .filter(Boolean)
    .join('\n\n');
  return (
    `你是一名【${roleFocus.role}】，负责对 A 股 ${ctx.name}(${code}) 做单一维度研判。\n` +
    `只聚焦：${getInstruction(roleFocus.key)}。\n` +
    '基于下方已取好的数据，给出该维度结论，务必精炼（≤200 字），首行用「倾向：偏多/偏空/中性」表态，' +
    '其后分点列依据。禁止编造未出现的数字，数据缺失则明说。\n\n' +
    (ctx.positionNote ? `=== 我的持仓 ===\n${ctx.positionNote}\n\n` : '') +
    data
  );
}

/** 需要定向热点补充的分析师角色（舆情/游资）：题材关注度高度依赖实时热榜 */
const TARGETED_HOTSPOT_ROLES = new Set(['舆情分析师', '游资情绪分析师']);

/**
 * 按需定向取数（both 的轻量落地）：模型先给出最值得搜的关键词（1 次 quick oneshot），
 * 系统再执行 trendradar.searchNews 取回热榜，回灌给 舆情/游资 分析师。
 * 由 cfg.targetedFetch（中枢·智能体页可配，缺省开启）控制；全程不建 run。
 * 关键词与热点共用一份，避免 2 个分析师重复 LLM 调用。
 */
async function targetedHotspot(
  name: string,
  code: string,
  model: string,
  enabled: boolean,
  opts: RunDecisionOptions,
): Promise<string> {
  if (!enabled) return '';
  const kwText = await stage(
    '定向热点·关键词',
    `针对 A 股 ${name}(${code})，给出最值得在财经热榜上检索的 1-2 个关键词（题材/概念/事件，空格分隔）。` +
      '只输出关键词本身，不要任何解释或标点。',
    model,
    opts,
  );
  const kw = (kwText.split('\n')[0] ?? '').replace(/[，。、,.]/g, ' ').trim().slice(0, 40) || name;
  const news = await trendradar.searchNews(kw, 20).catch(() => []);
  if (!news.length) return '';
  const id = newId();
  opts.onEvent?.({ type: 'tool_call', id, name: '定向热点·检索', args: kw });
  const text = `（按「${kw}」定向搜得）\n` + news.map((n) => `[${n.platformName || n.platform}] ${n.title}`).join('\n');
  opts.onEvent?.({ type: 'tool_result', id, name: '定向热点·检索', ok: true, preview: text.slice(0, 300) });
  return text;
}

/** 解析最终决策 JSON（仿 review：截取首尾大括号兜底） */
function parseDecisionJson(text: string): Record<string, unknown> | null {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const ACTION_LABELS: Record<DecisionAction, string> = {
  buy: '买入',
  add: '加仓',
  hold: '持有',
  reduce: '减仓',
  sell: '卖出',
};

function asAction(v: unknown): DecisionAction {
  return v === 'buy' || v === 'add' || v === 'hold' || v === 'reduce' || v === 'sell' ? v : 'hold';
}

function asNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
}

/** A 股最小交易单位（手） */
const LOT = 100;

/**
 * 校验并标注交易方案（纯校验、不动账户）：复用 getQuoteWithLimits 取实时报价，
 * 套用与 sim.executeSimTrade 同款 A 股硬约束——手数向下取整到 100、涨停不可买/跌停不可卖、
 * 持有卖出给 T+1 锁定提示。取数失败则降级为仅做手数取整、warnings 标注数据缺失。
 */
async function validateTradePlan(
  code: string,
  side: 'buy' | 'sell' | 'hold',
  qty: number,
  price: number | null,
  held: boolean,
): Promise<DecisionTraderPlan> {
  const flooredQty = Math.max(0, Math.floor((Number.isFinite(qty) ? qty : 0) / LOT) * LOT);
  const warnings: string[] = [];
  if (side !== 'hold' && Number.isFinite(qty) && qty > 0 && flooredQty !== qty) {
    warnings.push(`手数已向下取整到 ${LOT} 整数倍：${qty} → ${flooredQty}`);
  }
  if (side === 'hold') {
    return { side, qty: 0, price: price ?? null, warnings, note: '维持现状，无买卖动作' };
  }
  if (flooredQty <= 0) warnings.push('拟操作股数不足 100 股，无法成交');

  let quote: Awaited<ReturnType<typeof getQuoteWithLimits>> | null = null;
  try {
    quote = await getQuoteWithLimits(code);
  } catch {
    warnings.push('实时行情取数失败，未能校验涨跌停/价位');
  }

  if (quote) {
    const execPrice = price != null && price > 0 ? price : quote.price;
    if (price != null && price > 0) {
      if (quote.limitUp > 0 && price > quote.limitUp) warnings.push(`限价 ${price} 高于涨停价 ${quote.limitUp}`);
      if (quote.limitDown > 0 && price < quote.limitDown) warnings.push(`限价 ${price} 低于跌停价 ${quote.limitDown}`);
    }
    if (side === 'buy' && quote.limitUp > 0 && execPrice >= quote.limitUp) {
      warnings.push(`${quote.name}(${code}) 已涨停（涨停价 ${quote.limitUp}），无法买入`);
    }
    if (side === 'sell' && quote.limitDown > 0 && execPrice <= quote.limitDown) {
      warnings.push(`${quote.name}(${code}) 已跌停（跌停价 ${quote.limitDown}），无法卖出`);
    }
    if (side === 'sell' && held) {
      warnings.push('T+1 提示：当日买入部分受锁定，卖出前须确认为非当日买入的可卖份额');
    }
    if (side === 'sell' && !held) warnings.push('当前无该标的持仓，卖出方案不可执行');
  }

  const sideLabel = side === 'buy' ? '买入' : '卖出';
  const priceLabel = price != null && price > 0 ? `@${price}` : '（市价）';
  return {
    side,
    qty: flooredQty,
    price: price ?? null,
    warnings,
    note: `${sideLabel} ${flooredQty} 股 ${priceLabel}`,
  };
}

// 三方风险辩论风格定义：风格立场（stance）由 agentConfig.getInstruction 取生效值（覆盖优先）。
// key 为 DecisionRiskDebate 字段名；agentKey 为注册表角色键。
const RISK_STYLES: {
  key: keyof Omit<DecisionRiskDebate, 'verdict'>;
  agentKey: string;
  role: string;
}[] = [
  { key: 'aggressive', agentKey: AGENT_KEYS.riskAggressive, role: '激进派风控' },
  { key: 'neutral', agentKey: AGENT_KEYS.riskNeutral, role: '中立派风控' },
  { key: 'conservative', agentKey: AGENT_KEYS.riskConservative, role: '保守派风控' },
];

/** 组装供人阅读 / 落历史的 Markdown 叙述 */
function buildNarrative(r: DecisionResult): string {
  const lines: string[] = [];
  lines.push(`## ${r.name}(${r.code}) 决策：${ACTION_LABELS[r.action]}（置信度 ${r.confidence}）`);
  const kv: string[] = [];
  if (r.targetPrice != null) kv.push(`目标价 ${r.targetPrice}`);
  if (r.stopLoss != null) kv.push(`止损 ${r.stopLoss}`);
  if (r.positionPct != null) kv.push(`建议仓位 ${r.positionPct}%`);
  if (kv.length) lines.push(kv.join(' ｜ '));
  lines.push('', `**核心逻辑**：${r.thesis}`);
  if (r.keyRisks.length) lines.push('', '**关键风险**', ...r.keyRisks.map((x) => `- ${x}`));
  lines.push('', '### 分析师研判');
  for (const a of r.analystReports) lines.push(`- **${a.role}（${a.stance}）**：${a.summary}`);
  lines.push('', '### 多空辩论', `**多头**：${r.bullView}`, '', `**空头**：${r.bearView}`, '', `**研究总监裁决**：${r.judgeView}`);
  if (r.traderPlan) {
    lines.push('', '### Trader 可执行方案', r.traderPlan.note);
    if (r.traderPlan.warnings.length) lines.push('**约束校验**', ...r.traderPlan.warnings.map((x) => `- ${x}`));
  }
  if (r.riskDebate) {
    lines.push(
      '',
      '### 三方风险辩论',
      `**激进派**：${r.riskDebate.aggressive}`,
      '',
      `**中立派**：${r.riskDebate.neutral}`,
      '',
      `**保守派**：${r.riskDebate.conservative}`,
      '',
      `**风控组长裁决**：${r.riskDebate.verdict}`,
    );
  }
  if (r.memoryUsed && r.memoryUsed.length) {
    lines.push('', '### 引用的历史教训', ...r.memoryUsed.map((x) => `- ${x}`));
  }
  return lines.join('\n');
}

/**
 * 运行一次多智能体辩论决策。永不裸抛业务错误（取数已降级）；abort 时抛 AbortError 由调用方收口。
 */
export async function runDecision(input: DecisionInput, opts: RunDecisionOptions = {}): Promise<DecisionResult> {
  const cfg = readConfig();
  const { code } = input;

  // 1) 数据预取
  const ctx = await prefetch(input, opts);

  // 2) 分析师层（启用的分析师并行，轻模型）：经中枢可启停，保持注册表顺序
  const enabledKeys = new Set(getEnabledAnalystKeys());
  const activeAnalysts = ANALYST_ROLES.filter((rf) => enabledKeys.has(rf.key));
  // 按需定向热点：先取一次（舆情/游资共用），再回灌这两个角色的 prompt
  const targetedBlock = await targetedHotspot(ctx.name, code, cfg.quickModel, cfg.targetedFetch, opts);
  const analystOutputs = await Promise.all(
    activeAnalysts.map((rf) => {
      let prompt = buildAnalystPrompt(rf, code, ctx);
      if (targetedBlock && TARGETED_HOTSPOT_ROLES.has(rf.role)) {
        prompt += `\n\n=== 定向热点补充 ===\n${targetedBlock}`;
      }
      return stage(rf.role, prompt, cfg.quickModel, opts);
    }),
  );
  const analystReports = activeAnalysts.map((rf, i) => {
    const out = analystOutputs[i];
    const firstLine = out.split('\n')[0] ?? '';
    const m = firstLine.match(/倾向[：:]\s*(偏多|偏空|中性|看多|看空)/);
    return { role: rf.role, stance: m?.[1] ?? '中性', summary: out };
  });

  const analystDigest = analystReports.map((a) => `【${a.role}】\n${a.summary}`).join('\n\n');

  // 历史教训片段（仅注入研究总监 + 组合经理两层，控 token）
  const lessonsBlock = ctx.lessons.length
    ? `\n\n=== 历史决策教训（同标的，需引以为戒）===\n${ctx.lessons.map((l) => `- ${l}`).join('\n')}`
    : '';

  // 3) 多空辩论（多轮，轻模型）
  let bullView = '';
  let bearView = '';
  let transcript = '';
  for (let round = 1; round <= cfg.rounds; round += 1) {
    const roundTag = cfg.rounds > 1 ? `（第${round}/${cfg.rounds}轮）` : '';
    bullView = await stage(
      `多头研究员${roundTag}`,
      `${getInstruction(AGENT_KEYS.bull)}\n标的：${ctx.name}(${code})` +
        (bearView ? `\n\n空头上一轮观点（需反驳）：\n${bearView}` : '') +
        `\n\n=== 分析师结论 ===\n${analystDigest}`,
      cfg.quickModel,
      opts,
    );
    bearView = await stage(
      `空头研究员${roundTag}`,
      `${getInstruction(AGENT_KEYS.bear)}\n标的：${ctx.name}(${code})` +
        `\n\n多头本轮观点（需反驳）：\n${bullView}` +
        `\n\n=== 分析师结论 ===\n${analystDigest}`,
      cfg.quickModel,
      opts,
    );
    transcript += `${roundTag || `第${round}轮`}\n多头：${bullView}\n空头：${bearView}\n\n`;
  }

  // 研究总监裁决（重模型，注入历史教训）
  const judgeView = await stage(
    '研究总监',
    `${getInstruction(AGENT_KEYS.judge)}\n标的：${ctx.name}(${code})` +
      `\n\n=== 多空辩论 ===\n${transcript}\n=== 分析师结论 ===\n${analystDigest}${lessonsBlock}`,
    cfg.deepModel,
    opts,
  );

  // 4) Trader 阶段（轻模型）：把研判转成可执行方案，再经硬约束校验标注
  const traderText = await stage(
    'Trader 拟单',
    `${getInstruction(AGENT_KEYS.trader)}` +
      (ctx.positionNote ? `\n我的持仓：${ctx.positionNote}` : '\n当前未持有该标的。') +
      (ctx.held
        ? '\n持仓中：side 可为 sell（减/清仓）或 hold（维持）；如需加仓用 buy。'
        : '\n未持仓：side 只能为 buy（建仓）或 hold（观望），不可 sell。') +
      '\n【严格输出】只输出一个合法 JSON：{"side":"buy|sell|hold","qty":股数整数,"price":数字或null,"note":"理由(≤40字)"}。' +
      'qty 为计划股数（系统会自动取整到 100 的整数倍）；price 为限价，市价则置 null。\n\n' +
      `=== 研究总监裁决 ===\n${judgeView}\n\n=== 行情参考 ===\n${ctx.quoteNote}`,
    cfg.quickModel,
    opts,
  );
  const traderJson = parseDecisionJson(traderText) ?? {};
  const rawSide = traderJson.side;
  const side: 'buy' | 'sell' | 'hold' =
    rawSide === 'buy' || rawSide === 'sell' || rawSide === 'hold' ? rawSide : 'hold';
  const traderPlan = await validateTradePlan(code, side, asNum(traderJson.qty) ?? 0, asNum(traderJson.price), ctx.held);
  if (typeof traderJson.note === 'string' && traderJson.note.trim()) {
    traderPlan.note = `${traderPlan.note}｜${traderJson.note.trim()}`;
  }

  // 5) 三方风险辩论 + 风控组长裁决（可关闭；轻模型）
  let riskDebate: DecisionRiskDebate | null = null;
  if (cfg.riskEnabled) {
    const views: Partial<Record<keyof Omit<DecisionRiskDebate, 'verdict'>, string>> = {};
    const positionLine = ctx.positionNote ? `我的持仓：${ctx.positionNote}` : '当前未持有该标的。';
    const planLine = `Trader 方案：${traderPlan.note}${traderPlan.warnings.length ? `（校验提示：${traderPlan.warnings.join('；')}）` : ''}`;
    for (let round = 1; round <= cfg.riskRounds; round += 1) {
      const roundTag = cfg.riskRounds > 1 ? `（第${round}/${cfg.riskRounds}轮）` : '';
      for (const s of RISK_STYLES) {
        const prior = RISK_STYLES.filter((x) => views[x.key])
          .map((x) => `${x.role}：${views[x.key]}`)
          .join('\n');
        views[s.key] = await stage(
          `${s.role}${roundTag}`,
          `你是【${s.role}】，风格：${getInstruction(s.agentKey)}。从仓位控制、回撤风险、盈亏比角度审查下方研判与交易方案，` +
            '给出你的风险立场与建议仓位/止损（≤140 字）。' +
            `\n\n${positionLine}\n${planLine}\n\n=== 研究总监裁决 ===\n${judgeView}` +
            (prior ? `\n\n=== 其他风控观点 ===\n${prior}` : ''),
          cfg.quickModel,
          opts,
        );
      }
    }
    const verdict = await stage(
      '风控组长裁决',
      `${getInstruction(AGENT_KEYS.riskChair)}` +
        `\n\n=== 三方风控观点 ===\n` +
        RISK_STYLES.map((s) => `【${s.role}】${views[s.key] ?? ''}`).join('\n') +
        `\n\n${planLine}`,
      cfg.quickModel,
      opts,
    );
    riskDebate = {
      aggressive: views.aggressive ?? '',
      neutral: views.neutral ?? '',
      conservative: views.conservative ?? '',
      verdict,
    };
  }

  // 6) 最终结构化决策（重模型，注入历史教训）
  const decisionText = await stage(
    '最终决策',
    `${getInstruction(AGENT_KEYS.pm)}\n标的：${ctx.name}(${code})` +
      (input.context ? `\n场景：${input.context}` : '') +
      (ctx.held ? '\n注意：该标的【已在持仓中】，动作应在 持有/加仓/减仓/卖出 中选择。' : '\n注意：该标的【当前未持有】，动作应在 买入/持有(观望) 中选择，不可给减仓/卖出。') +
      '\n【严格输出】只输出一个合法 JSON 对象（闭合所有括号），不要任何额外文字或 Markdown 围栏，结构如下：\n' +
      '{"action":"buy|add|hold|reduce|sell","confidence":0-100的整数,' +
      '"targetPrice":数字或null,"stopLoss":数字或null,"positionPct":0-100数字或null,' +
      '"thesis":"核心逻辑(≤80字)","keyRisks":["风险1","风险2"]}\n' +
      '价格类字段必须基于已确认的真实价位，无依据则置 null。\n\n' +
      `=== 研究总监裁决 ===\n${judgeView}\n\n` +
      `=== Trader 方案 ===\n${traderPlan.note}${traderPlan.warnings.length ? `\n校验提示：${traderPlan.warnings.join('；')}` : ''}\n\n` +
      (riskDebate ? `=== 风控组长裁决 ===\n${riskDebate.verdict}\n\n` : '') +
      `=== 行情参考 ===\n${ctx.quoteNote}${lessonsBlock}`,
    cfg.deepModel,
    opts,
  );

  const parsed = parseDecisionJson(decisionText) ?? {};
  const action = asAction(parsed.action);
  const confidenceNum = asNum(parsed.confidence);
  const result: DecisionResult = {
    code,
    name: ctx.name,
    action,
    confidence: confidenceNum != null ? Math.max(0, Math.min(100, Math.round(confidenceNum))) : 50,
    targetPrice: asNum(parsed.targetPrice),
    stopLoss: asNum(parsed.stopLoss),
    positionPct: asNum(parsed.positionPct),
    thesis: typeof parsed.thesis === 'string' && parsed.thesis ? parsed.thesis : judgeView.slice(0, 120),
    keyRisks: Array.isArray(parsed.keyRisks)
      ? (parsed.keyRisks as unknown[]).map((x) => String(x)).filter(Boolean).slice(0, 6)
      : [],
    analystReports,
    bullView,
    bearView,
    judgeView,
    traderPlan,
    riskDebate,
    memoryUsed: ctx.lessons,
    narrative: '',
  };
  result.narrative = buildNarrative(result);

  // 写入交易记忆（pending）：入场价优先取实时现价，失败回退目标价。失败不抛。
  let entryPrice: number | null = result.targetPrice ?? null;
  try {
    entryPrice = (await getQuoteWithLimits(code)).price || entryPrice;
  } catch {
    /* 取数失败：用目标价兜底 */
  }
  recordDecision(result, entryPrice);

  // 末尾合成 token 事件：把最终叙述推给前端实时态展示
  opts.onEvent?.({ type: 'token', text: `\n\n${result.narrative}` });
  await sleep(0);
  return result;
}

/**
 * 批量决策（逐只串行，避免并发烧 token；单股内部分析师层仍并行）。
 * 任一标的失败不拖垮整批：降级为 hold 占位结果，narrative 记失败原因。
 * abort 时抛 AbortError，由调用方收口。
 */
export async function runDecisionBatch(
  inputs: DecisionInput[],
  opts: RunDecisionOptions = {},
): Promise<DecisionResult[]> {
  const out: DecisionResult[] = [];
  for (const input of inputs) {
    ensureNotAborted(opts.signal);
    try {
      out.push(await runDecision(input, opts));
    } catch (e) {
      if (opts.signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) throw e;
      out.push({
        code: input.code,
        name: input.name || input.code,
        action: 'hold',
        confidence: 0,
        targetPrice: null,
        stopLoss: null,
        positionPct: null,
        thesis: `决策失败：${e instanceof Error ? e.message : String(e)}`,
        keyRisks: [],
        analystReports: [],
        bullView: '',
        bearView: '',
        judgeView: '',
        traderPlan: null,
        riskDebate: null,
        memoryUsed: [],
        narrative: `## ${input.name || input.code}(${input.code}) 决策失败\n${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return out;
}

/** 盯盘终审 verdict（与 watch/dispatcher 的 Verdict 同构） */
export interface DecisionVerdict {
  shouldAlert: boolean;
  verdict: string;
  advice: string;
}

/**
 * 把决策结果映射为盯盘终审 verdict：
 * action sell→清仓 / reduce→减仓 / 其余(buy/add/hold)→持有（盯盘卖点语境不触发买入侧执行）。
 * shouldAlert：方向性卖出动作（reduce/sell）值得提醒；其余沉默。advice 用完整叙述。
 */
export function mapDecisionToVerdict(r: DecisionResult): DecisionVerdict {
  const verdict = r.action === 'sell' ? '清仓' : r.action === 'reduce' ? '减仓' : '持有';
  return {
    shouldAlert: r.action === 'sell' || r.action === 'reduce',
    verdict,
    advice: r.narrative,
  };
}
