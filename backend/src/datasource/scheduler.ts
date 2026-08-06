import type { DataSourceRoute, KlineBar, KlinePeriod, StockQuote } from '@stock-agent/shared';
import { QUOTE_PROVIDERS, KLINE_PROVIDERS_INTRADAY, KLINE_PROVIDERS_DAILY } from './providers';
import { isSourceEnabled } from './registry';
import { isMinutePeriod, frontAdjustDaily, frontAdjustMinute } from './adjust';
import { getDailyCached } from './klineCache';
import { toSecid } from './codes';

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

/** 原始取数：按 启用+优先级 依次尝试 provider，成功即返回（不做任何复权修正）。 */
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
 * 日/周/月线的唯一取数出口：多源取数 + 连续性修正（frontAdjustDaily）。
 * 名义上前复权的源也会漏除权（腾讯 qfq 不处理 ETF 份额折算），故一律补修正。
 *
 * 修正收在这里而不是读缓存出口：09:10 预热、15:10 收盘回填、周六全量重刷与按需回源
 * 都经本函数，写进 kline_daily 的就已是修正后的数据，直接读 readCachedDaily 的模块
 * 也不会拿到假跳空；读出口因此不再重复修正（省掉每次读的重算与重复告警）。
 * ponytail: 代价是折算当日盘中那段（临时 bar 与历史行分处折算前后两套价格）要等 15:10
 * 回填才彻底对齐；要盘中就对齐得按公告因子实时复权。
 *
 * @param secid 必须原样透传到 provider——它是缓存主键的一半（指数与同码个股靠它区分）
 * @param opts.period 仅限日/周/月线；分钟线不走本函数（它的修正是 frontAdjustMinute）
 * @param opts.quiet 不打印除权点日志。分钟线取日线锚点会随图表轮询反复调本函数，打了会刷屏。
 */
export async function fetchDailyAdjusted(
  code: string,
  secid: string | undefined,
  limit: number,
  opts: { period?: KlinePeriod; quiet?: boolean } = {},
): Promise<KlineBar[]> {
  const period = opts.period ?? 'day';
  const bars = await fetchKlineRaw(code, period, limit, secid);
  // 周线额外开 bar 内检测：除权发生在周中时跳空被吸收进那根 bar 内部，跨 bar 看不到，
  // 不补这一条周线波段锚点会取到折算前的高点，黄金分割整套失真（详见 INTRABAR_SPLIT_GAP）。
  //
  // 月线**不开**：INTRABAR_SPLIT_GAP=0.45 的物理依据是「一周 5 个交易日按 ±10% 算最多跌 41%，
  // 跌破 45% 只可能是除权」，这条推理对 20 个交易日的月线完全不成立——连续跌停的个股
  // 单月跌 45% 是真实行情。在月线上开等于把一次暴跌误判成折算，把那之前的全部历史整体缩放。
  // 月线漏掉月中折算只影响月线图这一个视图（PLAN_PERIODS 不含月线），代价远小于污染历史。
  return frontAdjustDaily(bars, opts.quiet ? undefined : `${lastServed.kline ?? '未知源'} ${code}`, {
    intrabar: period === 'week',
  });
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
  opts: { fresh?: boolean } = {},
): Promise<KlineBar[]> {
  // 日线走本地缓存（盘前预热 + 盘中增量）：命中即秒回，回源失败时用旧缓存顶住，
  // 避免上游一慢就让板块宽度/情绪/纪律体检等模块整块降级。分钟线不缓存（量大且时效强）。
  if (period === 'day') {
    // 缓存身份必须带 secid：大盘指数与同码个股（如 1.000001 上证指数 / 0.000001 平安银行）
    // 若共用 code 做键会互相覆盖，读出来的可能根本不是这只标的的 K 线。
    // 回源走 fetchDailyAdjusted，写进缓存的即修正后数据，故读出口不再重复修正
    return getDailyCached(
      code,
      secid ?? toSecid(code),
      limit,
      () => fetchDailyAdjusted(code, secid, limit),
      opts,
    );
  }
  // 非日线本就不缓存，fresh 对它们天然是空操作，不必再分支
  // 周/月线不缓存，取数后与日线共用同一条修正出口
  if (!isMinutePeriod(period)) return fetchDailyAdjusted(code, secid, limit, { period });
  const bars = await fetchKlineRaw(code, period, limit, secid);
  if (bars.length === 0) return bars;
  // 记录分钟命中源：下面取日线锚点会再走一次取数覆盖 lastServed.kline，
  // 故先存后还原，保证「数据源」页展示的是分钟实际命中源（如 astockdata），而非锚点源。
  const minuteServed = lastServed.kline;
  try {
    // 日线锚点需覆盖分钟序列的日历跨度：60m 约 limit/4 天、30m 约 limit/8 天，取 [300,800] 足够
    const dailyLimit = Math.min(800, Math.max(300, limit));
    const daily = await fetchDailyAdjusted(code, secid, dailyLimit, { quiet: true });
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
