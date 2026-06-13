import { eq } from 'drizzle-orm';
import type { WatchConfig } from '@stock-agent/shared';
import { db, schema } from '../db/client';

// 盯盘配置独立持久化：统一 watch_* 键前缀，自管读写默认值，
// 不扩 settings.ts 的 AppSettings / SettingsUpdate，保持模块解耦。

const PREFIX = 'watch_';

/** 配置默认值（保守阈值，避免盘中刷屏） */
export const DEFAULT_CONFIG: WatchConfig = {
  enabled: false,
  pollSec: 10,
  watchPositions: true,
  watchWatchlist: true,
  watchScan: false,
  watchGroup: '',
  drawdownPct: 4,
  surgeDropPct: 2,
  fastRisePct: 2,
  nearLimitPct: 1.5,
  sectorInflowYi: 8,
  cooldownMin: 30,
  cacheReuseMin: 20,
  maxConcurrent: 2,
  pushTelegram: true,
  adversarial: false,
  historyCompare: true,
  historyLookback: 3,
  reflection: true,
  minScore: 0,
  techContext: true,
  scanEverySec: 60,
  watchEverySec: 15,
  dailyDigest: true,
};

type NumKey =
  | 'pollSec'
  | 'drawdownPct'
  | 'surgeDropPct'
  | 'fastRisePct'
  | 'nearLimitPct'
  | 'sectorInflowYi'
  | 'cooldownMin'
  | 'cacheReuseMin'
  | 'maxConcurrent'
  | 'historyLookback'
  | 'minScore'
  | 'scanEverySec'
  | 'watchEverySec';
type BoolKey =
  | 'enabled'
  | 'watchPositions'
  | 'watchWatchlist'
  | 'watchScan'
  | 'pushTelegram'
  | 'adversarial'
  | 'historyCompare'
  | 'reflection'
  | 'techContext'
  | 'dailyDigest';
type StrKey = 'watchGroup';

function readRaw(key: string): string | undefined {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, PREFIX + key))
    .get();
  return row?.value;
}

function writeRaw(key: string, value: string): void {
  const now = new Date().toISOString();
  db.insert(schema.settings)
    .values({ key: PREFIX + key, value, updatedAt: now })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: now } })
    .run();
}

/** 读取盯盘配置（缺失项回退默认值） */
export function getWatchConfig(): WatchConfig {
  const cfg: WatchConfig = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(DEFAULT_CONFIG) as Array<keyof WatchConfig>) {
    const raw = readRaw(k);
    if (raw == null) continue;
    const def = DEFAULT_CONFIG[k];
    if (typeof def === 'boolean') {
      (cfg[k as BoolKey] as boolean) = raw === 'true' || raw === '1';
    } else if (typeof def === 'string') {
      (cfg[k as StrKey] as string) = raw;
    } else {
      const n = Number(raw);
      if (Number.isFinite(n)) (cfg[k as NumKey] as number) = n;
    }
  }
  return cfg;
}

/** 增量更新盯盘配置，返回更新后的完整配置 */
export function updateWatchConfig(patch: Partial<WatchConfig>): WatchConfig {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    if (!(k in DEFAULT_CONFIG)) continue;
    writeRaw(k, typeof v === 'boolean' ? String(v) : String(v));
  }
  return getWatchConfig();
}
