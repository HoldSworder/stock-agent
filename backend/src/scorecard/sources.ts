import type { ScorableSignal } from '@stock-agent/shared';
import { sqlite } from '../db/client';

// 信号来源注册表：哪些模块的产出可以被判分。
//
// 这张表就是「明码标价」的名册。规矩很简单：
// 一个模块想让自己的产出进操作台的建议区，就得在这里登记一个来源，
// 把它的观点表达成「标的 + 日期 + 方向」这种事后能判对错的形态。
// 登记不了的，说明它的产出无法被证伪，那它只能留在看图辅助那一层。
//
// 新增来源时只加一条 entry，不要在别处另写判分逻辑——
// 判分口径必须唯一，否则各模块各算一套，成绩之间没法比较。

export interface SignalSource {
  /** 稳定标识，形如 模块.信号类型 */
  id: string;
  /** 人读名称，会显示在成绩单上 */
  label: string;
  /** 看涨还是看跌。看跌信号的价值方向在判分时自动取反 */
  side: 'long' | 'short';
  /** 一句话说明这批信号是怎么产生的，供事后复查 */
  origin: string;
  load: () => ScorableSignal[];
}

/** ISO（UTC）→ 上海交易日 YYYY-MM-DD */
function shanghaiDate(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  return new Date(t + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * ETF 盯盘信号。
 *
 * 三类分开登记而不是合成一个来源：买点与卖出类的方向相反，
 * 混在一起会互相抵消，得出一个「大致持平」的假象——
 * 而实测这两侧的成绩差得很远（买点看不出本事，卖出类稳定有效）。
 */
function loadEtfWatch(signalType: string): ScorableSignal[] {
  const rows = sqlite
    .prepare(
      `select code, verdict, created_at from etf_watch_signals
       where signal_type = ? order by created_at`,
    )
    .all(signalType) as Array<{ code: string; verdict: string | null; created_at: string }>;
  const side = signalType === 'buy_layer' ? 'long' : 'short';
  return rows
    .map((r) => ({
      code: r.code,
      tradeDate: shanghaiDate(r.created_at),
      side: side as 'long' | 'short',
      tag: r.verdict ?? undefined,
    }))
    .filter((s) => s.tradeDate !== '');
}

export const SIGNAL_SOURCES: readonly SignalSource[] = [
  {
    id: 'etfwatch.buy',
    label: 'ETF 盯盘买点',
    side: 'long',
    origin: '多周期 MACD 金叉 + 均线过滤（etfwatch/engine.ts），ETF 主链目前唯一的买入依据',
    load: () => loadEtfWatch('buy_layer'),
  },
  {
    id: 'etfwatch.sell',
    label: 'ETF 盯盘减仓点',
    side: 'short',
    origin: '多周期 MACD 死叉 + 层位撤出（etfwatch/engine.ts）',
    load: () => loadEtfWatch('sell_layer'),
  },
  {
    id: 'etfwatch.stop',
    label: 'ETF 盯盘硬止损',
    side: 'short',
    origin: '固定比例硬止损（etfwatch/engine.ts）',
    load: () => loadEtfWatch('hard_stop'),
  },
];

export function findSource(id: string): SignalSource | undefined {
  return SIGNAL_SOURCES.find((s) => s.id === id);
}
