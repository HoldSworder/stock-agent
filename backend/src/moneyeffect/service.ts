import type { MoneyEffectOverview } from '@stock-agent/shared';
import { nowIso } from '../util';
import { getMeta, setMeta } from '../settings';
import { isTradingDay, shanghaiDateStr, shanghaiTimeStr } from '../market/calendar';
import { fetchMoneyEffectSeries, type MoneyEffectBar } from '../strategy/moneyEffectSignal';

// 首板赚钱效应总览（同花顺 883994「昨日打首板表现」= 首板隔日溢价累积指数）。
// 纯只读、best-effort：与影子战法同源（fetchMoneyEffectSeries），信号口径一致——
// 站上 MA5 且 MA5 向上 → 升温(满)，否则退潮(空)，全用截至最新一日的收盘，无未来函数。
// 驾驶舱秒开：buildMoneyEffectOverview(persist) 落一条 meta 快照，getMoneyEffectSummary 纯本地读。

/** 持久化到 settings 的快照键（供驾驶舱秒开读取，不触网） */
const LATEST_META = 'money_effect_latest';

/**
 * 最小序列长度：MA10 需要 10 根。不足时若照算，closes.slice(-10) 会把 3 根的均值当 MA10 输出，
 * 且 MA5 斜率无从判定——那是编造数据，宁可整体报错走上层降级。
 */
const MIN_BARS = 10;

/** 收盘落库时刻（Asia/Shanghai）：早于此时今日日线尚未定盘，不能要求快照已含今日 */
const CLOSE_HHMM = '15:10';

/** 末 n 个数的简单均值，空返回 0 */
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 「最近应有数据的交易日」：今日是交易日且已过收盘落库时刻则为今日，否则往前找最近交易日。
 * 用它与 tradeDate 比对判定数据是否陈旧（ttlCache 的 serve-stale-on-error 会静默回退旧值，
 * 只有比对交易日历才能把这次降级显性化）。
 */
function lastExpectedTradeDate(now: Date = new Date()): string {
  const cursor = new Date(now);
  if (!(isTradingDay(cursor) && shanghaiTimeStr(cursor) >= CLOSE_HHMM)) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  // 连休最长 8 天，10 步足够回退到最近交易日
  for (let i = 0; i < 10; i += 1) {
    if (isTradingDay(cursor)) return shanghaiDateStr(cursor);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return shanghaiDateStr(cursor);
}

/** tradeDate 落后于最近应有交易日即为降级数据 */
export function isStaleTradeDate(tradeDate: string, now: Date = new Date()): boolean {
  return tradeDate < lastExpectedTradeDate(now);
}

/**
 * 由已取好的序列组装总览（纯函数，供自检复算）。
 * 序列不足 MIN_BARS 直接抛错——照算会把 3 根的均值当 MA10 输出，属于编造数据。
 */
export function composeMoneyEffectOverview(
  series: MoneyEffectBar[],
  now: Date = new Date(),
): MoneyEffectOverview {
  if (series.length < MIN_BARS) {
    throw new Error(`883994 序列数据不足（需 ${MIN_BARS} 根，实得 ${series.length} 根）`);
  }
  const closes = series.map((b) => b.close);
  const n = closes.length;
  const close = closes[n - 1];
  const prevClose = closes[n - 2];
  const ma5 = mean(closes.slice(-5));
  const ma5Prev = mean(closes.slice(-6, -1)); // 前一日 MA5（斜率对比）
  const ma10 = mean(closes.slice(-10));
  const aboveMa5 = close >= ma5;
  const ma5SlopeUp = ma5 > ma5Prev;
  const signal: '升温' | '退潮' = aboveMa5 && ma5SlopeUp ? '升温' : '退潮';
  const tradeDate = series[n - 1].date;
  const overview: MoneyEffectOverview = {
    asOf: nowIso(),
    tradeDate,
    close: r2(close),
    ma5: r2(ma5),
    ma10: r2(ma10),
    prevClose: r2(prevClose),
    aboveMa5,
    ma5SlopeUp,
    signal,
    delta: prevClose > 0 ? r2((close / prevClose - 1) * 100) : null,
    series: series.slice(-60).map((b) => ({ date: b.date, close: r2(b.close) })),
    stale: isStaleTradeDate(tradeDate, now),
    note: '首板赚钱效应(同花顺·昨日打首板表现)，按规则计算的指标，仅供参考，不构成投资建议。',
  };
  return overview;
}

/**
 * 抓取并组装 883994 首板赚钱效应总览。
 * @param persist 为 true 时落一条 meta 快照（收盘定时 + GET 均落，供驾驶舱秒开）。
 * 取数失败抛错（GET 由 cached 回退上次成功值 / 定时由调度器 catch），不阻断其它模块。
 */
export async function buildMoneyEffectOverview(persist = false): Promise<MoneyEffectOverview> {
  const overview = composeMoneyEffectOverview(await fetchMoneyEffectSeries());
  if (persist) {
    try {
      setMeta(LATEST_META, JSON.stringify(overview));
    } catch {
      /* 落快照失败不影响返回 */
    }
  }
  return overview;
}

/**
 * 驾驶舱秒开：读最近一次 meta 快照（纯本地、不触网）；无/损坏返回 null。
 * 快照是落库当时的判断，读出时按当下交易日历重新判定 stale——
 * 定时任务连挂几天时快照会原地不动，不补标就会以「新鲜数据」的面目出现在驾驶舱。
 */
export function getMoneyEffectSummary(): MoneyEffectOverview | null {
  const raw = getMeta(LATEST_META);
  if (!raw) return null;
  try {
    const ov = JSON.parse(raw) as MoneyEffectOverview;
    return { ...ov, stale: ov.stale || isStaleTradeDate(ov.tradeDate) };
  } catch {
    return null;
  }
}

/** AI 研判确定性底稿：一段中文摘要，供「大盘与板块研判」注入 */
export function formatMoneyEffectForAgent(ov: MoneyEffectOverview): string {
  const d = ov.delta == null ? '—' : `${ov.delta >= 0 ? '+' : ''}${ov.delta}%`;
  return (
    `首板赚钱效应（昨日打首板表现，${ov.tradeDate}${ov.stale ? '·数据没取全' : ''}）\n` +
    `收盘 ${ov.close}｜MA5 ${ov.ma5}(${ov.ma5SlopeUp ? '向上' : '走平/向下'})｜MA10 ${ov.ma10}｜较昨 ${d}\n` +
    `信号【${ov.signal}】（${ov.aboveMa5 ? '站上' : '跌破'}MA5 且 MA5${ov.ma5SlopeUp ? '向上' : '未向上'}）——` +
    `升温=打板追涨赚钱效应转强、题材短线情绪回暖；退潮=首板隔日溢价走弱、短线宜降频降仓。作短线情绪择时参考，非唯一买卖依据。`
  );
}
