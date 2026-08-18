import type { FastifyInstance } from 'fastify';
import { db, schema } from '../db/client';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { fetchDailyAdjusted, getQuotes } from './scheduler';
import {
  appendIntradayBars,
  getCacheStats,
  listCachedCodes,
  listCachedSymbols,
  prewarmDaily,
  pruneCache,
  PREWARM_BARS,
  type CacheSymbol,
} from './klineCache';
import { toSecid } from './codes';

// 日K缓存的定时与运维入口：盘前预热、盘中增量追加、每周全量重刷（推进复权基准日）。
// 挂 /api/datasource/kline-cache*，供数据源页展示覆盖情况与手动触发。

/**
 * 预热宇宙 = 关注 ∪ ETF 池 ∪ 真实持仓 ∪ 模拟持仓 ∪ 研究标的库 ∪ 已缓存过的标的。
 * ponytail: 不做「全市场非 ST 全量预热」——那是几千只，对自建 sidecar 压力过大且多数用不到。
 * 代价是首次访问陌生标的仍要回源一次（之后自动进入缓存宇宙）。要全市场覆盖需换更强的批量日线源。
 */
export function cacheUniverse(): CacheSymbol[] {
  // 以 (code, secid) 为身份去重：已缓存的标的按库里实际的 secid 参与，
  // 只有各名单表（只存 6 位代码）才退回默认映射，指数这类显式 secid 的行不会被漏刷或误删
  const bySymbol = new Map<string, CacheSymbol>();
  const add = (s: CacheSymbol): void => {
    bySymbol.set(`${s.code}|${s.secid}`, s);
  };
  for (const s of listCachedSymbols()) add(s);
  const push = (rows: { code: string }[]): void => {
    for (const r of rows) if (r.code) add({ code: r.code, secid: toSecid(r.code) });
  };
  push(db.select({ code: schema.watchlist.code }).from(schema.watchlist).all());
  push(db.select({ code: schema.etfPool.code }).from(schema.etfPool).all());
  push(db.select({ code: schema.researchUniverse.code }).from(schema.researchUniverse).all());
  push(db.selectDistinct({ code: schema.positions.code }).from(schema.positions).all());
  push(db.selectDistinct({ code: schema.simPositions.code }).from(schema.simPositions).all());
  return [...bySymbol.values()].sort((a, b) => (a.code === b.code ? (a.secid < b.secid ? -1 : 1) : a.code < b.code ? -1 : 1));
}

/**
 * 盘前预热：把缓存宇宙的最近 PREWARM_BARS 根前复权日线刷到本地。
 * 取数用 scheduler.fetchDailyAdjusted（不经缓存，避免预热时自己命中自己），
 * 它已含连续性修正，故落库的就是修正后的数据——本模块不得再自建 provider 遍历绕过它。
 */
export async function runPrewarm(full = false): Promise<{ total: number; ok: number; failed: number }> {
  const symbols = cacheUniverse();
  if (symbols.length === 0) return { total: 0, ok: 0, failed: 0 };
  const r = await prewarmDaily(symbols, fetchDailyAdjusted, { full });
  console.info(
    `[klineCache] ${full ? '全量重刷' : '盘前预热'}完成：${r.ok}/${r.total} 成功，复权基准 ${r.adjBase}`,
  );
  return { total: r.total, ok: r.ok, failed: r.failed };
}

/** 盘中增量：一次批量报价覆盖全宇宙的当日 bar */
export async function runIntradayAppend(): Promise<number> {
  const codes = listCachedCodes();
  if (codes.length === 0) return 0;
  // 批量报价单次请求上限保守取 200，分批发起
  let n = 0;
  for (let i = 0; i < codes.length; i += 200) {
    const batch = codes.slice(i, i + 200);
    try {
      n += appendIntradayBars(await getQuotes(batch));
    } catch (e) {
      console.warn('[klineCache] 盘中增量批次失败:', e instanceof Error ? e.message : e);
    }
  }
  return n;
}

export function registerKlineCacheModule(app: FastifyInstance): void {
  app.get('/api/datasource/kline-cache', () => ({ ok: true, data: getCacheStats() }));

  app.post<{ Body: { full?: boolean } }>('/api/datasource/kline-cache/prewarm', async (req, reply) => {
    try {
      return { ok: true, data: await runPrewarm(req.body?.full === true) };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  defineModuleSchedules({
    app,
    module: 'klinecache',
    jobs: [
      {
        id: 'klinecache.prewarm',
        label: `盘前预热日K（09:10 · 最近${PREWARM_BARS}根）`,
        defaultCron: '10 9 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          await runPrewarm(false);
        },
      },
      {
        id: 'klinecache.intraday',
        label: '盘中增量追加当日bar（每10分钟）',
        defaultCron: '*/10 9-14 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          await runIntradayAppend();
        },
      },
      {
        id: 'klinecache.close',
        label: '收盘后回填真实日线（15:10）',
        defaultCron: '10 15 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          await runPrewarm(false);
        },
      },
      {
        id: 'klinecache.fullrefresh',
        label: '每周全量重刷（周六 08:00 · 推进复权基准日）',
        defaultCron: '0 8 * * 6',
        defaultEnabled: true,
        skipHoliday: false,
        run: async () => {
          await runPrewarm(true);
          pruneCache();
        },
      },
    ],
  });
}
