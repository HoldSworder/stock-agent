import type { DataSourceRoute, KlineBar, KlinePeriod, StockQuote } from '@stock-agent/shared';
import { QUOTE_PROVIDERS, KLINE_PROVIDERS_INTRADAY, KLINE_PROVIDERS_DAILY } from './providers';
import { isSourceEnabled } from './registry';
import { isMinutePeriod, frontAdjustMinute } from './adjust';

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

/** 原始取数：按 启用+优先级 依次尝试 provider，成功即返回（不做复权修正）。 */
async function fetchKlineRaw(
  code: string,
  period: KlinePeriod,
  limit: number,
  secid?: string,
): Promise<KlineBar[]> {
  const errors: string[] = [];
  // 分钟线走「不封IP的 mootdx 首选」链；日/周/月线走「前复权源首选」链（见 providers.ts 注释）
  const chain = isMinutePeriod(period) ? KLINE_PROVIDERS_INTRADAY : KLINE_PROVIDERS_DAILY;
  for (const p of chain) {
    if (!isSourceEnabled(p.sourceId)) continue;
    try {
      const raw = await p.fn(code, period, limit, secid);
      // 过滤无效 bar：收盘价 <= 0 多为源侧当日未定格/占位脏数据（如腾讯日线最新一根偶发返回 0），
      // 留着会污染日线指标，且作为分钟前复权锚时把当日清零。全部无效则视为本源失败，转下一源。
      const r = raw.filter((b) => b.close > 0);
      if (r.length === 0) throw new Error('返回数据全为无效(收盘<=0)');
      lastServed.kline = p.sourceId;
      return r;
    } catch (e) {
      errors.push(`${p.sourceId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`K线取数全部数据源失败 → ${errors.join(' | ') || '无可用数据源'}`);
}

/**
 * K 线（东财 → 腾讯 → 新浪 自动兜底，按周期能力降级）。
 * 分钟级额外做前复权修正：腾讯/新浪分钟接口返回不复权价，除权/份额折算日会造成假跳空→假死叉，
 * 故以日线前复权收盘为锚反推每日因子套到分钟线（已复权源 factor≈1，幂等安全）。日线取数失败则原样返回。
 */
export async function getKline(
  code: string,
  period: KlinePeriod = 'day',
  limit = 250,
  secid?: string,
): Promise<KlineBar[]> {
  const bars = await fetchKlineRaw(code, period, limit, secid);
  if (!isMinutePeriod(period) || bars.length === 0) return bars;
  // 记录分钟命中源：下面取日线锚点会再走一次 fetchKlineRaw 覆盖 lastServed.kline，
  // 故先存后还原，保证「数据源」页展示的是分钟实际命中源（如 astockdata），而非锚点源。
  const minuteServed = lastServed.kline;
  try {
    // 日线锚点需覆盖分钟序列的日历跨度：60m 约 limit/4 天、30m 约 limit/8 天，取 [300,800] 足够
    const dailyLimit = Math.min(800, Math.max(300, limit));
    const daily = await fetchKlineRaw(code, 'day', dailyLimit, secid);
    return frontAdjustMinute(bars, daily);
  } catch {
    return bars;
  } finally {
    lastServed.kline = minuteServed;
  }
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
      providers: KLINE_PROVIDERS_INTRADAY.filter((p) => isSourceEnabled(p.sourceId)).map(
        (p) => p.sourceId,
      ),
      lastServed: lastServed.kline,
    },
  ];
}
