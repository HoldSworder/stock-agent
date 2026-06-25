import type { KlineBar, KlinePeriod, StockQuote } from '@stock-agent/shared';
import { getQuotesEastmoney, getKlineEastmoney } from '../market/eastmoney';
import { getKlineTencent } from '../market/tencent';
import { getKlineSina } from '../market/sina';
import { getQuotesNetease } from '../market/netease';
import { getKlineAstock, getQuotesAstock } from '../astock/market';

// 能力 → 有序 provider 适配器。scheduler 据此按 启用+优先级 选源与故障转移。
// 顺序依据 2026-06-25 在群晖生产网络(31 子网出口)实测：
//   - 报价：东财 push2 可用、最快(~37ms)、字段最全(名称/换手/量比)，故为主；网易兜底；
//     a-stock-data(mootdx) 末位兜底（无名称/换手，仅价，但 TCP 不封 IP）。
//   - K 线：东财 push2his 在该网络被封(0% 成功)，故 mootdx(通达信 TCP，不封 IP，100% 成功)为首选，
//     腾讯(可用，~60ms)次之，东财(被封时快速失败)再次，新浪末位。
// 注：腾讯/新浪实时报价为 GBK 接口（名称需 iconv 解码），故不纳入报价 provider，仅做 K 线兜底。
// a-stock-data 未配置 Base URL / sidecar 不可用时，对应 provider 会快速失败并转下一源，不影响调度。

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
  { sourceId: 'astockdata', fn: getQuotesAstock },
];

// K 线按周期分两条链（scheduler 据 isMinutePeriod 选择）：
// 分钟线：mootdx(通达信 TCP，不封 IP) 首选——其返回的是不复权价，但 scheduler 会以「日线前复权」为锚
//   做前复权修正(frontAdjustMinute)，故分钟首选可用不复权源；腾讯次之，东财(31子网被封→快速失败)再次，新浪末位。
export const KLINE_PROVIDERS_INTRADAY: KlineProvider[] = [
  { sourceId: 'astockdata', fn: getKlineAstock },
  { sourceId: 'tencent', fn: getKlineTencent },
  { sourceId: 'eastmoney', fn: getKlineEastmoney },
  { sourceId: 'sina', fn: getKlineSina },
];

// 日/周/月线：必须前复权——既是日线指标本身(MA/MACD)的正确性，也是分钟前复权修正的「锚」。
//   腾讯/东财为前复权(qfq)；mootdx(client.bars 默认不复权)仅作末位应急，避免除权日假跳空污染日线锚。
//   东财 push2his 在 31 子网被封→快速失败转下一源；实测腾讯日线 100% 可用、~60ms。
export const KLINE_PROVIDERS_DAILY: KlineProvider[] = [
  { sourceId: 'tencent', fn: getKlineTencent },
  { sourceId: 'eastmoney', fn: getKlineEastmoney },
  { sourceId: 'sina', fn: getKlineSina },
  { sourceId: 'astockdata', fn: getKlineAstock },
];

// 数据源页展示用（盯盘主路径为分钟线，故展示分钟链以体现 mootdx 首选）
export const KLINE_PROVIDERS = KLINE_PROVIDERS_INTRADAY;
