import type { KlineBar, KlinePeriod, StockQuote } from '@stock-agent/shared';
import { getQuotesEastmoney, getKlineEastmoney } from '../market/eastmoney';
import { getKlineTencent } from '../market/tencent';
import { getKlineSina } from '../market/sina';
import { getQuotesNetease } from '../market/netease';

// 能力 → 有序 provider 适配器。scheduler 据此按 启用+优先级 选源与故障转移。
// 报价：东财（含换手/量比）为主，网易（UTF-8 feed，名称不乱码）兜底。
// K 线：东财 → 腾讯 → 新浪（按周期能力自动降级，不支持的源直接抛错跳过）。
// 注：腾讯/新浪实时报价为 GBK 接口（名称需 iconv 解码），故不纳入报价 provider，仅做 K 线兜底。

export interface QuoteProvider {
  sourceId: string;
  fn: (codes: string[]) => Promise<StockQuote[]>;
}

export interface KlineProvider {
  sourceId: string;
  fn: (code: string, period: KlinePeriod, limit: number, secid?: string) => Promise<KlineBar[]>;
}

export const QUOTE_PROVIDERS: QuoteProvider[] = [
  { sourceId: 'eastmoney', fn: getQuotesEastmoney },
  { sourceId: 'netease', fn: getQuotesNetease },
];

export const KLINE_PROVIDERS: KlineProvider[] = [
  { sourceId: 'eastmoney', fn: getKlineEastmoney },
  { sourceId: 'tencent', fn: getKlineTencent },
  { sourceId: 'sina', fn: getKlineSina },
];
