import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { SHARES_PER_LOT, type KlineBar, type StockQuote } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { nowIso, shanghaiToday, isAShareTradingTime } from '../util';
import { isTradingDay } from '../market/calendar';
import { toSecid } from './codes';
import { SPLIT_GAP, frontAdjustDaily } from './adjust';

// 全市场日K本地缓存：盘前预热 + 盘中增量追加 + 每周全量重刷，替代「每次都实时回源」。
// 解决两个老问题：一是 sidecar/东财慢或超时导致板块宽度、情绪、纪律体检等模块整块降级；
// 二是同一根日线在一次请求里被多个模块重复拉取。
//
// 复权口径（不可省的那条）：前复权价会随每次分红送股整体变动。只做增量追加的话，
// 老行是旧基准、新行是新基准，拼在一起的序列会出现假跳空，回测/ATR/结构止损全部跟着漂。
// 故每行记 adjBase，读取时若同一标的存在多个基准就只认最新那批；每周全量重刷统一推进基准日。
//
// 缓存主键含 secid（不只是 6 位代码）：上证指数 000001 与平安银行 000001 撞码，
// 只按 code 做键会让两者互相覆盖——大盘阶段可能拿平安银行算 MA60，纪律体检可能拿指数算 ATR。

/** 缓存元信息存 settings 表的这个键（沿用 sched_<module> 的存法，不污染强类型 AppSettings） */
const META_KEY = 'kline_cache_meta';
/** 盘中允许的最大陈旧度：超过则回源补当日 bar */
const INTRADAY_MAX_AGE_MS = 10 * 60_000;
/** 预热保留的日线根数（够算 MA60/ATR14/60日跳空分位） */
export const PREWARM_BARS = 120;
/** 历史保留自然日数（pruneCache 默认值），全量重刷的抓取根数据此折算 */
export const PRUNE_KEEP_DAYS = 400;
/**
 * 每周全量重刷的抓取根数：按 PRUNE_KEEP_DAYS 自然日折算成交易日（每周 5/7）。
 * 复用 PREWARM_BARS=120 会让每次全量重刷把所有标的历史硬截断到 120 根，MA120/回测直接没数据。
 */
const FULL_REFRESH_BARS = Math.ceil((PRUNE_KEEP_DAYS * 5) / 7);
/** 交易时段（含午休）的分钟区间：09:30 开盘 ~ 15:00 收盘 */
const OPEN_MINUTE = 9 * 60 + 30;
const CLOSE_MINUTE = 15 * 60;

export interface KlineCacheMeta {
  /** 当前生效的复权基准日 */
  adjBase: string;
  /** 最近一次盘前预热完成时间 */
  lastPrewarmAt: string | null;
  /** 最近一次预热覆盖的标的数 */
  lastPrewarmCodes: number;
  /** 最近一次全量重刷完成时间 */
  lastFullRefreshAt: string | null;
  /** 最近一次盘中增量追加时间 */
  lastIntradayAt: string | null;
  /** 最近一次运行的错误摘要（成功则为 null） */
  lastError: string | null;
}

const DEFAULT_META: KlineCacheMeta = {
  adjBase: '',
  lastPrewarmAt: null,
  lastPrewarmCodes: 0,
  lastFullRefreshAt: null,
  lastIntradayAt: null,
  lastError: null,
};

export function readMeta(): KlineCacheMeta {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, META_KEY)).get();
  if (!row?.value) return { ...DEFAULT_META };
  try {
    return { ...DEFAULT_META, ...(JSON.parse(row.value) as Partial<KlineCacheMeta>) };
  } catch {
    return { ...DEFAULT_META };
  }
}

function writeMeta(patch: Partial<KlineCacheMeta>): KlineCacheMeta {
  const next = { ...readMeta(), ...patch };
  const now = nowIso();
  const value = JSON.stringify(next);
  db.insert(schema.settings)
    .values({ key: META_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: now } })
    .run();
  return next;
}

/** 当前生效的复权基准日；从未重刷过则以今天为基准 */
function currentAdjBase(): string {
  const meta = readMeta();
  return meta.adjBase || shanghaiToday();
}

/**
 * 缓存是否还新鲜。分三种情形，避免「收盘后拿到昨天的线」和「盘中拿到十点的线」：
 *  - 写入时间是今天：盘中允许 10 分钟内陈旧，非盘中（含收盘后）当天写的都算新鲜；
 *  - 写入时间是往日：仅当此刻尚未开盘（09:30 前）才继续可用；
 *  - 其余一律回源。
 *
 * @param provisional 该行是否盘中用实时报价合成的临时 bar。临时 bar 不是当日收盘线，
 *   非交易时段一律判不新鲜强制回源——否则 15:00~15:10（收盘回填之前）会把盘中合成的
 *   半根 bar 当成当日完整日线返回，下游按「完整日线」口径解读它的量价。
 */
export function isFresh(updatedAt: string, now = new Date(), provisional = false): boolean {
  const today = shanghaiToday(now);
  const writtenDay = shanghaiToday(new Date(updatedAt));
  if (writtenDay === today) {
    if (provisional) {
      if (!inTradingSession(now)) return false;
      return now.getTime() - new Date(updatedAt).getTime() < INTRADAY_MAX_AGE_MS;
    }
    if (!inTradingSession(now)) return true;
    return now.getTime() - new Date(updatedAt).getTime() < INTRADAY_MAX_AGE_MS;
  }
  return !inTradingSession(now) && shanghaiClockMinutes(now) < OPEN_MINUTE;
}

/**
 * 是否真的处在连续竞价中：交易日 且 落在 09:30-11:30 / 13:00-15:00。
 * 只用 isAShareTradingTime 不够——它不判节假日，于是国庆整周都被当成「盘中」，
 * 缓存每 10 分钟对全市场整体失效，休市日反而把上游打满。与 isIntradayWindow 同口径。
 */
function inTradingSession(now: Date): boolean {
  return isTradingDay(now) && isAShareTradingTime(now);
}

/**
 * 是否处于「当日已开盘、尚未收盘」的窗口（含 11:30-13:00 午休）。
 * 与 symbolPlans/sessionClock.isBarUnclosed 同口径：日期必须是交易日 + 时钟落在 09:30~15:00。
 * 盘中增量追加只在此窗口内允许——09:00 的报价 price 就是昨收，写进去等于伪造一根当日 bar。
 */
export function isIntradayWindow(now = new Date()): boolean {
  if (!isTradingDay(now)) return false;
  const m = shanghaiClockMinutes(now);
  return m >= OPEN_MINUTE && m < CLOSE_MINUTE;
}

/** Asia/Shanghai 当前时刻的分钟数（0-1439） */
function shanghaiClockMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const [h, m] = parts.split(':').map(Number);
  return h * 60 + m;
}

interface CachedRow extends KlineBar {
  adjBase: string;
  updatedAt: string;
  /** 1 = 盘中合成的临时 bar */
  provisional: number;
}

/**
 * 读某标的最近 limit 根缓存日线（老→新）；只返回最新复权基准那一批，混基准的老行直接丢弃。
 * @param secid 东财 secid（如 1.000001 上证指数 / 0.000001 平安银行），与 code 共同构成来源身份
 */
export function readCachedDaily(code: string, secid: string, limit: number): CachedRow[] {
  const rows = db
    .select()
    .from(schema.klineDaily)
    .where(and(eq(schema.klineDaily.code, code), eq(schema.klineDaily.secid, secid)))
    .orderBy(desc(schema.klineDaily.tradeDate))
    .limit(Math.max(1, limit))
    .all();
  if (rows.length === 0) return [];
  // 同一标的可能残留上一轮基准的行；以最新一行的基准为准，只认同基准的连续段
  const base = rows[0].adjBase;
  const same = rows.filter((r) => r.adjBase === base);
  return same
    .map((r) => ({
      time: r.tradeDate,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      amount: r.amount,
      adjBase: r.adjBase,
      updatedAt: r.updatedAt,
      provisional: r.provisional,
    }))
    .sort((a, b) => (a.time < b.time ? -1 : 1));
}

/** 批量写入日线（按 (code, secid, tradeDate) 覆盖）；provisional 标记盘中合成的临时当日 bar */
export function writeCachedDaily(
  code: string,
  secid: string,
  bars: KlineBar[],
  opts: { adjBase?: string; provisional?: boolean } = {},
): void {
  if (bars.length === 0) return;
  const adjBase = opts.adjBase ?? currentAdjBase();
  const provisional = opts.provisional === true ? 1 : 0;
  const now = nowIso();
  db.transaction((tx) => {
    for (const b of bars) {
      tx
        .insert(schema.klineDaily)
        .values({
          code,
          secid,
          tradeDate: b.time,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
          amount: b.amount,
          adjBase,
          provisional,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.klineDaily.code, schema.klineDaily.secid, schema.klineDaily.tradeDate],
          set: {
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
            amount: b.amount,
            adjBase,
            provisional,
            updatedAt: now,
          },
        })
        .run();
    }
  });
}

/**
 * 带缓存的日线读取：命中且新鲜则直接返回，否则回源并落库。
 * @param secid 来源身份（指数与同码个股靠它区分），缓存命中与写入都以 (code, secid) 为准
 * @param fetcher 回源函数（由 scheduler 传入原始多源链路，避免本模块反向依赖 providers）
 * @param opts.fresh 跳过新鲜度判定强制回源。给前台看盘用：INTRADAY_MAX_AGE_MS 是 10 分钟，
 *   而盘中那根 bar 又是 appendIntradayBars 用批量报价合成的近似值（open 取昨收、
 *   high/low 取 max/min(现价,参考价)、量由成交额反推）。K 线弹窗 10 秒轮询一次却拿同一份缓存，
 *   看到的就是一根十分钟不动且振幅失真的当日线。强制回源拿的是上游真实 OHLC，
 *   且成功后照常 writeCachedDaily 写回——缓存没被绕坏，反而被真实 bar 刷热。
 *   只应由前台单只标的的轮询触发，批量取数路径不要带，否则缓存等于没有。
 */
export async function getDailyCached(
  code: string,
  secid: string,
  limit: number,
  fetcher: () => Promise<KlineBar[]>,
  opts: { fresh?: boolean } = {},
): Promise<KlineBar[]> {
  const cached = readCachedDaily(code, secid, limit);
  const newest = cached[cached.length - 1];
  if (
    !opts.fresh &&
    hasEnoughCached(code, secid, cached.length, limit) &&
    newest &&
    isFresh(newest.updatedAt, new Date(), newest.provisional === 1)
  ) {
    // 命中路径也要走同一道临时 bar 剔除：收盘回填失败时当日行会停在 provisional=1，
    // 次日开盘前 isFresh 的跨日分支判它新鲜，于是那根合成的假 bar 会从这里原样交出去。
    return fallbackFromCache(cached, new Date(), code);
  }
  try {
    const fetched = await fetcher();
    if (fetched.length > 0) {
      lastFetchedCount.set(cacheKeyOf(code, secid), { requested: limit, got: fetched.length });
      writeCachedDaily(code, secid, fetched);
      return fetched;
    }
  } catch (e) {
    // 回源失败时，有旧缓存就先顶上（这正是本模块要消灭的整块降级），无缓存才继续抛
    if (cached.length > 0) return fallbackFromCache(cached, new Date(), code);
    throw e;
  }
  if (cached.length > 0) return fallbackFromCache(cached, new Date(), code);
  return [];
}

const cacheKeyOf = (code: string, secid: string): string => `${code}|${secid}`;

/**
 * 上次回源的「请求根数」与「实际拿到根数」（key = code|secid）。
 *
 * 必须同时记住 requested：只记 got 无法区分「上游只有这么多」与「上次只要了这么多」。
 * 同一只标的在全仓被以差异极大的 limit 请求（盯盘 3 根、regime 260 根、ETF 500 根），
 * 只比 got 会让「上次要 260 拿到 260」被误判成「历史只有 260 根」，
 * 之后 500 根的请求永久命中 260 行的短缓存，静默返回被截断的历史——
 * 而 MA120／回测／ETF 这类消费方拿到短序列不会报错，只会算出偏短窗口的指标。
 *
 * ponytail: 进程内 Map，重启后第一次读会多回源一次即重新学到，故不落库。
 * 上限是缓存宇宙的标的数，不会随请求量增长。
 */
const lastFetchedCount = new Map<string, { requested: number; got: number }>();

/**
 * 缓存深度是否够用。不能只判 cached.length >= limit：新上市几个月的标的历史本就不足
 * 250 根（getKline 默认 limit），那样它永远命中不了缓存、每次都全量回源，
 * 恰恰丢掉了「上游一慢就整块降级」的防护。
 *
 * 放宽的唯一依据是「上次回源被上游截断」（got < requested），即已经触达该标的历史起点；
 * 拿满的那次说明不到起点，不能作为放宽依据。判据与当前 limit 无关。
 */
function hasEnoughCached(code: string, secid: string, cachedLen: number, limit: number): boolean {
  if (cachedLen >= limit) return true;
  const rec = lastFetchedCount.get(cacheKeyOf(code, secid));
  return rec != null && rec.got < rec.requested && cachedLen >= rec.got;
}

/**
 * 回源失败/取空时的缓存兜底：非交易时段遇到末根 provisional 一律剔除那一根。
 *
 * 临时 bar 的 high/low/close 由 max/min(参考价, 现价) 合成，三者必然共线，
 * 下游（如 symbolPlans/volumePrice 的收盘位置）会把它当成已收盘完整日线解读，
 * 算出恒为 1.0 或 0.0 的「突破获量能确认」——那是一个被确定性伪造的信号。
 * 少一根完整日线远好过多一根假的；盘中读取临时 bar 的既有行为不受影响。
 */
function fallbackFromCache(rows: CachedRow[], now = new Date(), code?: string): KlineBar[] {
  if (dropsTrailingProvisional(rows[rows.length - 1], now)) {
    return adjustedFromCache(rows.slice(0, -1), code);
  }
  return adjustedFromCache(rows, code);
}

/** 兜底返回时末根该不该丢：非交易时段的临时 bar 一律丢（判据见 fallbackFromCache） */
export function dropsTrailingProvisional(
  newest: { provisional: number } | undefined,
  now = new Date(),
): boolean {
  return newest?.provisional === 1 && !inTradingSession(now);
}

/**
 * 缓存行 → KlineBar，并补一次静默的连续性修正。
 *
 * 写入路径（scheduler.fetchDailyAdjusted）已经修正过，但收盘回填只覆盖最近 PREWARM_BARS 根：
 * 某标的折算后，更早的历史仍停在折算前价位，而 adj_base 没变、最新行又是新鲜的不触发回源，
 * 于是 limit > PREWARM_BARS 的读取（getKline 默认 250、回测/MA120）会在 120 根处看到假跳空，
 * 一直持续到周六全量重刷。frontAdjustDaily 幂等（无跳空时空转），这里兜一次只花一次 O(n) 扫描。
 * 不传 label：这是每次读都会走的路径，打日志会随图表轮询刷屏。
 */
function adjustedFromCache(rows: CachedRow[], code?: string): KlineBar[] {
  // 带上 code：判据按板别收紧后，主板 -25% 这类跳空才认得出来（见 adjust.splitGapOf）
  return frontAdjustDaily(rows.map(stripMeta), undefined, { code });
}

function stripMeta(r: CachedRow): KlineBar {
  return {
    time: r.time,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    amount: r.amount,
  };
}

/** 缓存覆盖情况（供数据源页展示） */
export interface KlineCacheStats extends KlineCacheMeta {
  /** 已缓存的标的数 */
  codeCount: number;
  /** 总行数 */
  rowCount: number;
  /** 最新交易日 */
  latestDate: string | null;
  /** 覆盖到最新交易日的标的数 */
  freshCodeCount: number;
}

export function getCacheStats(): KlineCacheStats {
  const agg = db
    .select({
      codes: sql<number>`count(distinct ${schema.klineDaily.code})`,
      rows: sql<number>`count(*)`,
      latest: sql<string | null>`max(${schema.klineDaily.tradeDate})`,
    })
    .from(schema.klineDaily)
    .get();
  const latestDate = agg?.latest ?? null;
  const freshCodeCount = latestDate
    ? (db
        .select({ n: sql<number>`count(distinct ${schema.klineDaily.code})` })
        .from(schema.klineDaily)
        .where(eq(schema.klineDaily.tradeDate, latestDate))
        .get()?.n ?? 0)
    : 0;
  return {
    ...readMeta(),
    codeCount: agg?.codes ?? 0,
    rowCount: agg?.rows ?? 0,
    latestDate,
    freshCodeCount,
  };
}

/** 已缓存的全部标的代码（盘中批量报价以此为宇宙，避免为不关心的标的白拉数据） */
export function listCachedCodes(): string[] {
  return [...new Set(listCachedSymbols().map((s) => s.code))];
}

/** 缓存里的一个标的身份：code 单独不足以定位（上证指数 000001 与平安银行 000001 撞码） */
export interface CacheSymbol {
  code: string;
  secid: string;
}

/** 已缓存的全部 (code, secid) 对；预热宇宙必须按对来，否则显式 secid 的指数会被漏掉或误删 */
export function listCachedSymbols(): CacheSymbol[] {
  return (
    db
      .selectDistinct({ code: schema.klineDaily.code, secid: schema.klineDaily.secid })
      .from(schema.klineDaily)
      .orderBy(asc(schema.klineDaily.code))
      .all()
      // 历史脏行（code 为空、只有 secid）必须挡在这里：它们取数必然失败，
      // 会让每一轮预热都固定报一批 failed，把真正需要关注的失败淹掉。
      .filter((r) => !!r.code?.trim())
  );
}

/** 并发受限 map（与 breadth 同口径，控制对上游的瞬时压力） */
export async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const idx = cursor;
        cursor += 1;
        await fn(items[idx]);
      }
    }),
  );
}

export interface PrewarmResult {
  total: number;
  ok: number;
  failed: number;
  adjBase: string;
}

/**
 * 预热：为给定标的批量拉取前复权日线并落库（预热 PREWARM_BARS 根，全量重刷 FULL_REFRESH_BARS 根）。
 *
 * 标的身份必须是 (code, secid) 对而非纯 code：旧实现对所有标的一律 toSecid(code)，
 * 只为个股写了新基准行，而全量重刷的旧行清理又只按 code 过滤——
 * 上证指数（1.000001，显式 secid）与平安银行（0.000001）撞码，指数历史每周被整段删空。
 * 纯字符串入参仍兼容（按 toSecid 默认映射），方便调用方与自检逐步迁移。
 *
 * @param full 全量重刷：推进复权基准日并覆盖全部历史行（每周一次，防前复权口径漂移）
 */
export async function prewarmDaily(
  symbols: Array<string | CacheSymbol>,
  fetcher: (code: string, secid: string, limit: number) => Promise<KlineBar[]>,
  opts: { full?: boolean; concurrency?: number } = {},
): Promise<PrewarmResult> {
  const full = opts.full === true;
  const adjBase = full ? shanghaiToday() : currentAdjBase();
  const bars = full ? FULL_REFRESH_BARS : PREWARM_BARS;
  const targets: CacheSymbol[] = symbols.map((s) =>
    typeof s === 'string' ? { code: s, secid: toSecid(s) } : s,
  );
  let failed = 0;
  const errors: string[] = [];
  const okSymbols: CacheSymbol[] = [];
  await mapLimit(targets, opts.concurrency ?? 4, async ({ code, secid }) => {
    try {
      const fresh = await fetcher(code, secid, bars);
      if (fresh.length === 0) throw new Error('返回空日线');
      writeCachedDaily(code, secid, fresh, { adjBase });
      okSymbols.push({ code, secid });
    } catch (e) {
      failed += 1;
      if (errors.length < 3) errors.push(`${code}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  const ok = okSymbols.length;
  if (full && okSymbols.length > 0) {
    // 基准推进后清掉旧基准残留行，避免同一标的混两套复权口径。
    // 只清「本轮成功写入新基准」的 (code, secid) 对：只按 code 删会连带清空同码不同 secid 的标的；
    // 本轮取数失败的标的没有新行，无条件按基准删会清空它的全部历史。
    const bySecid = new Map<string, string[]>();
    for (const s of okSymbols) {
      const list = bySecid.get(s.secid) ?? [];
      list.push(s.code);
      bySecid.set(s.secid, list);
    }
    for (const [secid, codes] of bySecid) {
      for (let i = 0; i < codes.length; i += 400) {
        db.delete(schema.klineDaily)
          .where(
            and(
              eq(schema.klineDaily.secid, secid),
              inArray(schema.klineDaily.code, codes.slice(i, i + 400)),
              sql`${schema.klineDaily.adjBase} <> ${adjBase}`,
            ),
          )
          .run();
      }
    }
  }
  writeMeta({
    adjBase,
    lastPrewarmAt: nowIso(),
    lastPrewarmCodes: ok,
    lastError: failed > 0 ? `${failed} 只失败：${errors.join(' | ')}` : null,
    ...(full ? { lastFullRefreshAt: nowIso() } : {}),
  });
  return { total: targets.length, ok, failed, adjBase };
}

/**
 * 盘中增量追加：用一次批量实时报价覆盖当日那根 bar，只对已预热过的标的生效。
 * 相比逐只回源日线，这里 1 次批量报价即可刷新全市场，是盘中保持缓存新鲜的主路径。
 *
 * 只在「当日已开盘、尚未收盘」的窗口内生效（见 isIntradayWindow）：每 10 分钟的定时表达式
 * 覆盖 9-14 点整段，会在 09:00/09:10/09:20 触发，那时报价的 price 就是昨收，写进去等于伪造一根当日 bar。
 *
 * ponytail: StockQuote 只有现价/昨收/成交额，没有当日 OHLC 与成交量。当日 bar 的 open 用昨收近似
 * （除权日的未除权昨收会被弃用，见 intradayOpenRef）、high/low 由历次采样的 max/min 累积
 * （见 mergeIntradayBar，两次采样之间的极值仍会漏掉），volume 由成交额反推，故临时 bar 的振幅仍偏窄、
 * 量能是估算值（不是撮合真实手数）。该行 provisional=1，收盘后预热会用真实日线整行覆盖。
 * 要精确盘中 OHLC/量能需换带这些字段的报价源。
 */
/**
 * 盘中临时 bar 的开盘参考价：正常取昨收；昨收相对现价高出 SPLIT_GAP 以上则弃用，改取现价。
 *
 * 除权/份额折算当日部分报价源给的仍是未除权昨收（159516 折算日 prevClose=1.945 / price=0.905），
 * 直接当 open 会造出一根 open 1.945 / close 0.905 的假 K：当日振幅、ATR、摆动点全部失真，
 * 且跳空被抹进 bar 内部——它落在 open 与 close 之间，frontAdjustDaily 的
 * 「open_t / close_{t-1}」判据在折算当天恒等于 1，必然漏判，之后再修也救不回来。
 * 改取现价后当日 bar 退化成一个点（振幅缺失，收盘回填时由真实日线整行覆盖），
 * 但跳空回到 bar 边界上，折算当天即可被正常识别。
 *
 * 选这条而不是「给 frontAdjustDaily 加 provisional 判据」：后者要把 provisional 标记
 * 一路带进纯函数，且只治检测、治不了那根假 K 本身。
 * 只拦下跌方向，与 SPLIT_GAP 同理：向上的大跳空可能是无涨跌幅限制新股的真实暴涨。
 */
export function intradayOpenRef(prevClose: number, price: number): number {
  if (!(prevClose > 0)) return price;
  return price / prevClose < 1 - SPLIT_GAP ? price : prevClose;
}

/**
 * 合成当日临时 bar：库里已有当日行时在其上累积，没有才从报价凭空造一根。
 *
 * 为什么必须累积而不是整行覆盖：K 线弹窗的 fresh=1 已把上游真实当日 OHLC 写进这一行，
 * 十分钟后本任务用 max/min(参考价, 现价) 整行盖掉，真实最高/最低就被抹成两点之间的直线，
 * 当日振幅与 ATR 被系统性低估。对上一轮自己写的临时行同样累积——它记的是历次采样的极值，
 * 比单点快照更接近真实振幅。
 *
 * 例外是除权/份额折算日：折算前写下的那行仍停在旧价位，累积会把旧高点带进新价位的 bar
 * （正是 intradayOpenRef 要避免的假 K），故现价相对旧行 open 跌破 SPLIT_GAP 时整行弃用重造。
 *
 * @param prev 库里当日那一行（无则 undefined）
 */
export function mergeIntradayBar(
  prev: KlineBar | undefined,
  next: KlineBar,
): KlineBar {
  const usable = prev && prev.open > 0 && next.close / prev.open >= 1 - SPLIT_GAP;
  if (!usable) return next;
  // 成交额是当日累计值、真正单调，取 max 防某一轮报价滞后把读数打回去。
  const amount = Math.max(prev.amount, next.amount);
  return {
    time: next.time,
    open: prev.open,
    high: Math.max(prev.high, next.high),
    low: Math.min(prev.low, next.low),
    close: next.close,
    // volume 不能同样取 max：它不是上游给的累计量，而是由 amount ÷ 现价 ÷ 每手股数估算出来的
    // （见 appendIntradayBars）。分母随价格波动，价格上行时同一份成交额会推出更小的手数，
    // 取 max 会把当日量能永久钉在「价格最低那一刻算出的最大估值」上、再也回不来，
    // 直接抬高量比与放量确认。改为与合并后的 amount 同源重算，保证两者口径一致。
    volume: next.close > 0 ? Math.round(amount / next.close / SHARES_PER_LOT) : next.volume,
    amount,
  };
}

export function appendIntradayBars(quotes: StockQuote[], now = new Date()): number {
  if (!isIntradayWindow(now)) return 0;
  const today = shanghaiToday(now);
  const adjBase = currentAdjBase();
  let n = 0;
  for (const q of quotes) {
    if (!q.code || !(q.price > 0)) continue;
    // 成交额缺失时不落行：volume 只能由成交额反推，填 0 会让下游量比/放量确认直接读出「今天零成交」，
    // 那是一个确定错误的读数，宁可这一轮不更新当日 bar（下一轮报价带上成交额自会补）
    const amountYuan = (q.amount ?? 0) * 1e8; // StockQuote.amount 单位是亿元，KlineBar.amount 是元
    if (!(amountYuan > 0)) continue;
    const secid = toSecid(q.code);
    const newest = readCachedDaily(q.code, secid, 1)[0];
    if (!newest) continue; // 未预热过的标的不凭空建行
    const ref = intradayOpenRef(q.prevClose, q.price);
    const synthesized: KlineBar = {
      time: today,
      open: ref,
      high: Math.max(ref, q.price),
      low: Math.min(ref, q.price),
      close: q.price,
      volume: Math.round(amountYuan / q.price / SHARES_PER_LOT), // 估算手数：成交额 ÷ 现价 ÷ 每手股数
      amount: amountYuan,
    };
    const bar = mergeIntradayBar(newest.time === today ? newest : undefined, synthesized);
    // 仍标 provisional：这根终究不是收盘定格的日线，收盘后必须回源刷成真实行
    writeCachedDaily(q.code, secid, [bar], { adjBase, provisional: true });
    n += 1;
  }
  if (n > 0) writeMeta({ lastIntradayAt: nowIso() });
  return n;
}

/** 清理超期历史（早于 keepDays 天的行整体删除，控制库体积） */
export function pruneCache(keepDays = PRUNE_KEEP_DAYS): number {
  const cutoffDate = shanghaiToday(new Date(Date.now() - keepDays * 86_400_000));
  const res = db
    .delete(schema.klineDaily)
    .where(sql`${schema.klineDaily.tradeDate} < ${cutoffDate}`)
    .run();
  return res.changes ?? 0;
}
