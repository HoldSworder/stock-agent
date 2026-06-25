import type {
  EtfConfirm,
  EtfExecInstruction,
  EtfTrendStage,
} from '@stock-agent/shared';
import { callAkshare } from '../market/akshare';
import { getKline } from '../market/eastmoney';
import { cached } from '../lib/ttlCache';
import { shanghaiToday } from '../util';
import { listEtfShareDaily, upsertEtfShareDaily } from './store';

// 第1期·资金/量价确认层 + 第3期·趋势阶段/护栏（纯确定性，只读）。
// 数据：fund_etf_spot_em 全市场快照（量比/换手/份额/主力净流入，一次取全量缓存）+ 东财日线量价。
// 份额无历史接口，按日累积 etf_share_daily，趋势从上线起累积，冷启动为「数据不足」。

interface SpotRow {
  volRatio: number | null;
  turnover: number | null;
  mainNetInflow: number | null; // 亿元
  shares: number | null;
  close: number | null;
  pct: number | null;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

type RawSpot = Record<string, unknown>;

/** 全市场 ETF 实时快照（fund_etf_spot_em），90s 缓存：一次取全量，按 code 过滤 */
async function fetchSpotMap(): Promise<Map<string, SpotRow>> {
  const data = (await callAkshare('fund_etf_spot_em')) as RawSpot[] | null;
  const map = new Map<string, SpotRow>();
  if (!Array.isArray(data)) return map;
  for (const r of data) {
    const code = String(r['代码'] ?? '').trim();
    if (!code) continue;
    const mainYuan = num(r['主力净流入-净额']);
    map.set(code, {
      volRatio: num(r['量比']),
      turnover: num(r['换手率']),
      mainNetInflow: mainYuan == null ? null : mainYuan / 1e8,
      shares: num(r['最新份额']),
      close: num(r['最新价']),
      pct: num(r['涨跌幅']),
    });
  }
  return map;
}

function getEtfSpotMap(): Promise<Map<string, SpotRow>> {
  return cached('etfwatch:spot', 90_000, fetchSpotMap);
}

/** 把全市场快照里跟踪标的的份额/收盘/量按当日落库（幂等，冷启动累积份额趋势） */
export async function snapshotEtfShares(codes: string[]): Promise<void> {
  if (codes.length === 0) return;
  let spot: Map<string, SpotRow>;
  try {
    spot = await getEtfSpotMap();
  } catch {
    return; // 快照不可用则跳过，不影响盯盘主流程
  }
  const date = shanghaiToday();
  for (const code of codes) {
    const s = spot.get(code);
    if (!s || s.shares == null || s.shares <= 0) continue;
    upsertEtfShareDaily({
      code,
      date,
      shares: s.shares,
      close: s.close ?? 0,
      volume: 0,
    });
  }
}

/** 量价健康度子结论（基于多日日线收盘价 + 成交量） */
function volPriceVerdict(bars: { close: number; volume: number }[]): {
  delta: number;
  note: string;
  distribution: boolean;
  divergence: boolean;
} {
  if (bars.length < 3) {
    return { delta: 0, note: '量价数据不足', distribution: false, divergence: false };
  }
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const priceChg = prev.close > 0 ? (last.close - prev.close) / prev.close : 0;
  const prevVols = bars.slice(0, -1).map((b) => b.volume);
  const avgVol = prevVols.reduce((s, v) => s + v, 0) / Math.max(1, prevVols.length);
  const volChg = avgVol > 0 ? (last.volume - avgVol) / avgVol : 0;
  const pPct = (priceChg * 100).toFixed(2);
  const vPct = (volChg * 100).toFixed(0);
  if (priceChg > 0.002 && volChg > 0.05) {
    return { delta: 20, note: `价涨量增（价 ${pPct}% / 量 ${vPct}%），承接健康`, distribution: false, divergence: false };
  }
  if (priceChg > 0.002 && volChg <= 0.05) {
    return { delta: -8, note: `价涨量缩（价 ${pPct}% / 量 ${vPct}%），上涨缺承接，背离`, distribution: false, divergence: true };
  }
  if (priceChg <= 0.002 && volChg > 0.2) {
    return { delta: -22, note: `滞涨/下跌放量（价 ${pPct}% / 量 ${vPct}%），警惕派发`, distribution: true, divergence: false };
  }
  return { delta: 0, note: `缩量整理（价 ${pPct}% / 量 ${vPct}%），中性`, distribution: false, divergence: false };
}

/** 份额趋势子结论（基于已累积的日快照） */
function shareTrendVerdict(rows: { shares: number }[]): { delta: number; note: string } {
  const valid = rows.filter((r) => r.shares > 0);
  if (valid.length < 3) {
    return { delta: 0, note: '份额趋势累积中（数据不足）' };
  }
  const first = valid[0].shares;
  const last = valid[valid.length - 1].shares;
  const chg = first > 0 ? (last - first) / first : 0;
  const pct = (chg * 100).toFixed(2);
  if (chg > 0.01) return { delta: 15, note: `近 ${valid.length} 日份额增 ${pct}%，真资金进场` };
  if (chg < -0.01) return { delta: -15, note: `近 ${valid.length} 日份额减 ${pct}%，资金撤离` };
  return { delta: 0, note: `近 ${valid.length} 日份额基本持平（${pct}%）` };
}

/**
 * 资金/量价确认（确定性）：量价健康度 + 份额趋势 + 量比，合成 0-100 确认分与标签。
 * 取数全部 best-effort：任一不可用降级，整体为「数据不足」时 label 明示。
 */
export async function getEtfConfirm(code: string): Promise<EtfConfirm> {
  const asOf = new Date().toISOString();
  let spot: SpotRow | undefined;
  try {
    spot = (await getEtfSpotMap()).get(code);
  } catch {
    spot = undefined;
  }

  let bars: { close: number; volume: number }[] = [];
  try {
    // 复用 macd 同源的 getKline（限频+缓存）：与读数表共用当日日线缓存，避免直连被节流
    const kl = await getKline(code, 'day', 60);
    // 剔除盘中未走完的当根，量价以已收盘为准
    bars = (kl.length > 1 ? kl.slice(0, -1) : kl)
      .slice(-8)
      .map((b) => ({ close: b.close, volume: b.volume }));
  } catch {
    bars = [];
  }

  const shareRows = (() => {
    try {
      return listEtfShareDaily(code, 6);
    } catch {
      return [];
    }
  })();

  const vp = volPriceVerdict(bars);
  const st = shareTrendVerdict(shareRows);
  const volRatio = spot?.volRatio ?? null;

  let score = 50 + vp.delta + st.delta;
  let volRatioNote = '';
  if (volRatio != null) {
    if (volRatio < 0.7) {
      score -= 10;
      volRatioNote = `，量比 ${volRatio.toFixed(2)}（缩量乏力）`;
    } else if (volRatio > 1.5) {
      score += 5;
      volRatioNote = `，量比 ${volRatio.toFixed(2)}（放量活跃）`;
    } else {
      volRatioNote = `，量比 ${volRatio.toFixed(2)}`;
    }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  const dataInsufficient = bars.length < 3 && shareRows.length < 3;
  let label: EtfConfirm['label'];
  if (dataInsufficient) label = '数据不足';
  else if (vp.distribution) label = '派发警惕';
  else if (vp.divergence || score < 45) label = '背离';
  else label = '健康';

  return {
    score,
    label,
    volPriceNote: vp.note + volRatioNote,
    shareTrendNote: st.note,
    volRatio,
    turnover: spot?.turnover ?? null,
    mainNetInflow: spot?.mainNetInflow ?? null,
    shares: spot?.shares ?? null,
    asOf,
  };
}

/** 注入 agent 的确认证据底稿（确定性，供研判增信） */
export function formatConfirmForAgent(c: EtfConfirm): string {
  const lines = [`【资金/量价确认（确定性）】标签：${c.label}，确认分 ${c.score}/100`];
  lines.push(`- 量价：${c.volPriceNote}`);
  lines.push(`- 份额：${c.shareTrendNote}`);
  if (c.mainNetInflow != null)
    lines.push(`- 主力净流入：${c.mainNetInflow >= 0 ? '+' : ''}${c.mainNetInflow.toFixed(2)} 亿（东财口径，弱证据）`);
  if (c.turnover != null) lines.push(`- 换手率：${c.turnover.toFixed(2)}%`);
  return lines.join('\n');
}

/** 确认分对确定性子分的增减（健康加权 / 背离·派发降级） */
export function confirmScoreDelta(c: EtfConfirm | null): number {
  if (!c) return 0;
  if (c.label === '健康') return 8;
  if (c.label === '背离') return -10;
  if (c.label === '派发警惕') return -15;
  return 0;
}

// ===== 趋势阶段（确定性合成） =====

export interface TrendStageInput {
  close: number;
  ma20: number | null;
  ma60: number | null;
  dayBullish: boolean;
  dayAboveZero: boolean;
}

/** 由均线排列 + MACD 零轴/方向 + 收盘相对 MA60 位置确定性合成趋势阶段 */
export function computeTrendStage(i: TrendStageInput): EtfTrendStage {
  if (i.ma60 == null || i.close <= 0) return '未知';
  if (i.close < i.ma60) return '趋势破坏';
  const ext = (i.close - i.ma60) / i.ma60; // 相对 MA60 的乖离
  if (!i.dayBullish) {
    return ext > 0.12 ? '高位钝化' : '震荡';
  }
  // 日线多头：完整多头排列 + 零轴上 = 主升；否则视作趋势初期（刚站上 MA60、动能转强）
  if (i.ma20 != null && i.close > i.ma20 && i.ma20 > i.ma60 && i.dayAboveZero) {
    return '主升中';
  }
  return '趋势初期';
}

// ===== 买点执行指令护栏（确定性兜底，agent 主导后校验改写） =====

export interface BuyGuardrailCtx {
  /** 触发价（现价） */
  price: number;
  /** 当日涨跌幅 % */
  dayPct: number;
  /** 当前已建总仓位 % */
  heldPct: number;
  /** 本层目标仓位 %（确定性分层给出） */
  layerPct: number;
  /** 禁追高阈值 %（0=关闭） */
  chaseGuardPct: number;
  /** 最大总仓位 %（0=不限制） */
  maxTotalPct: number;
  /** 硬止损 %（用于补默认止损） */
  hardStopPct: number;
}

/**
 * 对 agent 产出的买点指令做确定性护栏校验（agent 主导、护栏兜底）：
 * - 禁追高：当日涨幅 ≥ 阈值 → 降级「观望」，sizePct 归零；
 * - 最大总仓位：削减 sizePct 使 totalAfter 不超上限；
 * - 必须带止损：缺失则按硬止损补默认。
 */
export function applyBuyGuardrails(
  ins: EtfExecInstruction,
  ctx: BuyGuardrailCtx,
): EtfExecInstruction {
  const out: EtfExecInstruction = { ...ins };
  const notes: string[] = [];

  // 止损兜底（建/加仓必给）
  if ((out.stopLoss == null || out.stopLoss <= 0) && ctx.hardStopPct > 0 && ctx.price > 0) {
    out.stopLoss = Number((ctx.price * (1 - ctx.hardStopPct / 100)).toFixed(3));
    notes.push(`补默认止损 -${ctx.hardStopPct}%`);
  }

  const isAdd = out.action === '建仓' || out.action === '加仓';
  if (isAdd) {
    // 禁追高
    if (ctx.chaseGuardPct > 0 && ctx.dayPct >= ctx.chaseGuardPct) {
      out.action = '观望';
      out.sizePct = 0;
      out.totalAfterPct = ctx.heldPct;
      notes.push(`当日涨幅 ${ctx.dayPct.toFixed(2)}% ≥ 禁追高阈值 ${ctx.chaseGuardPct}%，降级观望`);
    } else if (ctx.maxTotalPct > 0) {
      // 最大总仓位削减
      const room = Math.max(0, ctx.maxTotalPct - ctx.heldPct);
      if (out.sizePct > room) {
        out.sizePct = Number(room.toFixed(0));
        notes.push(`总仓位上限 ${ctx.maxTotalPct}%，本次削减至 ${out.sizePct}%`);
      }
      out.totalAfterPct = Math.min(ctx.maxTotalPct, ctx.heldPct + out.sizePct);
      if (out.sizePct <= 0) {
        out.action = '持有';
        notes.push('已达总仓位上限，改为持有');
      }
    }
  }

  if (notes.length) {
    out.guardrailNote = (out.guardrailNote ? out.guardrailNote + '；' : '') + notes.join('；');
  }
  return out;
}
