import type { KlineBar, KlinePeriod, StockQuote } from '@stock-agent/shared';
import { getQuotesEastmoney, getKlineEastmoney } from '../market/eastmoney';
import { getKlineTencent } from '../market/tencent';
import { getKlineSina } from '../market/sina';
import { getQuotesNetease } from '../market/netease';
import { getKlineAstock, getQuotesAstock } from '../astock/market';

// 能力 → 有序 provider 适配器。scheduler 据此按 启用+优先级 选源与故障转移。
//
// 报价顺序 2026-09-05 重排（原顺序为 东财 → 网易 → mootdx，依据是 2026-06-25 实测「东财最快、字段最全」）。
// 重排原因是当天在 stock-agent 容器内逐域名复测，发现结论已经过期：
//   - push2.eastmoney.com 与 push2his.eastmoney.com 均 TLS 握手完成后被对端关闭（源站反爬封了本出口 IP），
//     而 push2delay / push2ex / datacenter-web 仍 200。也就是说东财报价并没有整体失败，
//     而是被 eastmoney.ts 的 host 兜底静默切到了 push2delay —— 那是**延迟行情**。
//     盯盘拿延迟价判急跌与炸板是错的，故不能再让它排第一。
//   - mootdx 走通达信 TCP，不受 HTTP 反爬影响，且是唯一返回**五档盘口与当日最高/最低**的源
//     （mootdx_quote 46 字段）。这两项此前被误判为「无数据源」，见 symbolPlans/capability.ts。
// 代价：mootdx 不返回个股名称与换手/量比。名称由 scheduler 回填，换手/量比缺失的消费方本就按可选处理。
//
// K 线顺序不变：分钟线 mootdx 首选（同样因不封 IP），日线经 fetchDailyAdjusted 统一复权修正后按数据完整度排。
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
  { sourceId: 'astockdata', fn: getQuotesAstock },
  { sourceId: 'eastmoney', fn: getQuotesEastmoney },
  { sourceId: 'netease', fn: getQuotesNetease },
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

// 日/周/月线复权口径（2026-08-04 实测校正）：
//   腾讯 qfq / 东财 fqt=1 名义上前复权，但腾讯的 qfq 不处理 ETF 份额折算；
//   新浪与 mootdx 本身就是不复权。也就是说这条链上没有一个源能保证序列连续，
//   故日/周/月线一律经 scheduler.fetchDailyAdjusted 这唯一出口跑 frontAdjustDaily 自修正
//   （用价格自身重建复权因子）；日K缓存的预热/回填/重刷也走同一出口，故落库的已是修正后数据。
//   有了这层兜底，排序不再以「是否复权」为准，而是看数据完整度与可用性。
// 顺序理由：
//   - 腾讯/东财优先，它们的复权已覆盖个股分红送股，自修正只需补 ETF 折算这类漏网；
//   - mootdx 排第三而非末位：它是本链上唯一同时返回成交额(amount)的可用源，
//     而成交额是量比/量能读数的分母；新浪日线 amount 恒为 0，只能退化到成交量口径；
//   - 新浪末位兜底：无成交额、也不复权，仅保证「有价可用」。
export const KLINE_PROVIDERS_DAILY: KlineProvider[] = [
  { sourceId: 'tencent', fn: getKlineTencent },
  { sourceId: 'eastmoney', fn: getKlineEastmoney },
  { sourceId: 'astockdata', fn: getKlineAstock },
  { sourceId: 'sina', fn: getKlineSina },
];

// 数据源页展示用（盯盘主路径为分钟线，故展示分钟链以体现 mootdx 首选）
export const KLINE_PROVIDERS = KLINE_PROVIDERS_INTRADAY;
