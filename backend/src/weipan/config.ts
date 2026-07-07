import { eq } from 'drizzle-orm';
import type { WeipanConfig } from '@stock-agent/shared';
import { db, schema } from '../db/client';

// 尾盘套利盯盘配置独立持久化：统一 weipan_* 键前缀，与个股盯盘 watch_* / ETF 盯盘 etfwatch_* 完全隔离。

const PREFIX = 'weipan_';

/** 配置默认值（默认关闭；卖点阈值口径复用 watch/strategyProfile 的 WEIPAN_PROFILE，不在此重复） */
export const DEFAULT_CONFIG: WeipanConfig = {
  enabled: false,
  pollSec: 20,
  perPositionPct: 30,
  cooldownMin: 10,
  pushTelegram: true,
};

type NumKey = 'pollSec' | 'perPositionPct' | 'cooldownMin';
type BoolKey = 'enabled' | 'pushTelegram';

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

/** 读取配置（缺失项回退默认值） */
export function getWeipanConfig(): WeipanConfig {
  const cfg: WeipanConfig = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(DEFAULT_CONFIG) as Array<keyof WeipanConfig>) {
    const raw = readRaw(k);
    if (raw == null) continue;
    const def = DEFAULT_CONFIG[k];
    if (typeof def === 'boolean') {
      (cfg[k as BoolKey] as boolean) = raw === 'true' || raw === '1';
    } else {
      const n = Number(raw);
      if (Number.isFinite(n)) (cfg[k as NumKey] as number) = n;
    }
  }
  return cfg;
}

/** 增量更新配置，返回更新后的完整配置 */
export function updateWeipanConfig(patch: Partial<WeipanConfig>): WeipanConfig {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    if (!(k in DEFAULT_CONFIG)) continue;
    writeRaw(k, String(v));
  }
  return getWeipanConfig();
}
