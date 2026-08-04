import type { KlineBar, MarketRegimeHmm } from '@stock-agent/shared';
import { callAstock } from '../astock/client';
import { mapMootdxBars } from '../astock/market';

// 大盘阶段·等权口径取数：全A等权指数（通达信 880008）经 a-stock-data sidecar 的 mootdx_index 端点取。
// 880008 是「一股一权」的全A等权，能剥离市值加权大指数（上证/沪深300）被权重股护盘的失真，
// 且 mootdx_index 返回自带 up_count/down_count 成分股涨跌家数，可直接读等权宽度。
// 纯只读、best-effort：取数失败由服务层回退到宽度代理，不阻断大盘阶段合成。

/** 全A等权（880008）通达信自建指数代码 */
const TDX_ALL_A_EQUAL_WEIGHT = '880008';

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 全A等权日线 + 最新成分股涨跌家数（等权宽度） */
export interface EqualWeightSeries {
  /** 日线（升序），供均线/趋势/波段计算 */
  bars: KlineBar[];
  /** 最新一日成分股上涨家数（缺失为 null） */
  upCount: number | null;
  /** 最新一日成分股下跌家数（缺失为 null） */
  downCount: number | null;
}

/**
 * 取全A等权（880008）日线序列。frequency=9 为日 K（mootdx index 口径）。
 * 短超时 + 单次尝试：sidecar 未接/不可用时快速失败，服务层回退宽度代理。
 */
export async function getAllAEqualWeight(limit = 260): Promise<EqualWeightSeries> {
  const rows = (await callAstock(
    'mootdx_index',
    { symbol: TDX_ALL_A_EQUAL_WEIGHT, frequency: 9, offset: Math.min(Math.max(limit, 1), 800) },
    undefined,
    'astockdata',
    12_000,
    1,
  )) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('全A等权(880008) K线为空');
  }
  // 复用 mootdx 统一映射（含 vol「股/手」自校准）：本文件与 astock/market 各写一套解析
  // 正是单位口径分叉的入口——880008 这边曾把未归一的「股」直接当「手」用
  const bars: KlineBar[] = mapMootdxBars(rows, {
    intraday: false,
    limit,
    // 指数不做单位自校准：反推靠「amount ÷ 均价 ÷ vol」，而 880008 的 close 是点位不是每股价格。
    // 该序列下游只取 close（regime/service 的等权均线），量的口径不参与判定。
    calibrate: false,
  });
  const last = rows[rows.length - 1] ?? {};
  const upRaw = last.up_count;
  const downRaw = last.down_count;
  return {
    bars,
    upCount: upRaw == null ? null : num(upRaw),
    downCount: downRaw == null ? null : num(downRaw),
  };
}

/**
 * 取大盘阶段 HMM 影子信号（全A等权 880008 上现训 GaussianHMM）。
 * 与 getAllAEqualWeight 同款 best-effort：sidecar 未接/样本不足时抛错，
 * 服务层 catch 后降级隐藏 HMM 视角（不阻断规则四态结论）。
 * @param window trailing 训练窗口（交易日数，默认 750≈3 年）
 */
export async function getRegimeHmm(window = 750): Promise<MarketRegimeHmm> {
  const res = (await callAstock(
    'regime_hmm',
    { symbol: '880008', n_states: 3, window },
    undefined,
    'astockdata',
    15_000,
    1,
  )) as unknown as Partial<MarketRegimeHmm> | null;
  if (!res || typeof res !== 'object' || !res.state || !res.probs) {
    throw new Error('regime_hmm 返回结构异常');
  }
  return res as MarketRegimeHmm;
}
