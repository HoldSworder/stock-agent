import type { DataSourceRoute, KlineBar, KlinePeriod, StockQuote } from '@stock-agent/shared';
import { QUOTE_PROVIDERS, KLINE_PROVIDERS } from './providers';
import { isSourceEnabled } from './registry';

// 行情类能力路由：按 启用+优先级 依次尝试 provider，成功即返回并记命中源，失败转下一个。
// 各模块经 market/eastmoney 的 getQuotes/getKline 薄委托进入此处，实现统一调度与多源故障转移。

const lastServed: { quote: string | null; kline: string | null } = { quote: null, kline: null };

/** 批量实时报价（东财 → 网易 自动兜底） */
export async function getQuotes(codes: string[]): Promise<StockQuote[]> {
  const errors: string[] = [];
  for (const p of QUOTE_PROVIDERS) {
    if (!isSourceEnabled(p.sourceId)) continue;
    try {
      const r = await p.fn(codes);
      lastServed.quote = p.sourceId;
      return r;
    } catch (e) {
      errors.push(`${p.sourceId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`报价取数全部数据源失败 → ${errors.join(' | ') || '无可用数据源'}`);
}

/** K 线（东财 → 腾讯 → 新浪 自动兜底，按周期能力降级） */
export async function getKline(
  code: string,
  period: KlinePeriod = 'day',
  limit = 250,
  secid?: string,
): Promise<KlineBar[]> {
  const errors: string[] = [];
  for (const p of KLINE_PROVIDERS) {
    if (!isSourceEnabled(p.sourceId)) continue;
    try {
      const r = await p.fn(code, period, limit, secid);
      lastServed.kline = p.sourceId;
      return r;
    } catch (e) {
      errors.push(`${p.sourceId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`K线取数全部数据源失败 → ${errors.join(' | ') || '无可用数据源'}`);
}

/** 当前各能力的生效调度链路与最近命中源（供「数据源」页展示） */
export function getRoutes(): DataSourceRoute[] {
  return [
    {
      capability: 'quote',
      label: '实时报价',
      providers: QUOTE_PROVIDERS.filter((p) => isSourceEnabled(p.sourceId)).map((p) => p.sourceId),
      lastServed: lastServed.quote,
    },
    {
      capability: 'kline',
      label: 'K 线',
      providers: KLINE_PROVIDERS.filter((p) => isSourceEnabled(p.sourceId)).map((p) => p.sourceId),
      lastServed: lastServed.kline,
    },
  ];
}
