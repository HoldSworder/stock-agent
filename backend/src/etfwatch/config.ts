import { eq } from 'drizzle-orm';
import type { EtfWatchConfig } from '@stock-agent/shared';
import { db, schema } from '../db/client';

// ETF 多周期盯盘配置独立持久化：统一 etfwatch_* 键前缀，与个股盯盘 watch_* 完全隔离。

const PREFIX = 'etfwatch_';

/** 配置默认值（v2 战法：2:2:1 仓位、大周期+零轴过滤、硬止损、买点调 agent 给置信度） */
export const DEFAULT_CONFIG: EtfWatchConfig = {
  enabled: false,
  pollSec: 60,
  includePositions: true,
  includePool: true,
  extraCodes: '',
  layer1Pct: 40,
  layer2Pct: 40,
  layer3Pct: 20,
  zeroAxisFilter: true,
  higherTfFilter: true,
  hardStopPct: 7,
  trailLookback: 3,
  trailTakeProfitPct: 12,
  chaseGuardPct: 7,
  maxTotalPct: 100,
  agentConfirmBuy: true,
  minConfidence: 55,
  cooldownMin: 30,
  pushTelegram: true,
};

type NumKey =
  | 'pollSec'
  | 'layer1Pct'
  | 'layer2Pct'
  | 'layer3Pct'
  | 'hardStopPct'
  | 'trailLookback'
  | 'trailTakeProfitPct'
  | 'chaseGuardPct'
  | 'maxTotalPct'
  | 'minConfidence'
  | 'cooldownMin';
type BoolKey =
  | 'enabled'
  | 'includePositions'
  | 'includePool'
  | 'zeroAxisFilter'
  | 'higherTfFilter'
  | 'agentConfirmBuy'
  | 'pushTelegram';
type StrKey = 'extraCodes';

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
export function getEtfWatchConfig(): EtfWatchConfig {
  const cfg: EtfWatchConfig = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(DEFAULT_CONFIG) as Array<keyof EtfWatchConfig>) {
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

/** 增量更新配置，返回更新后的完整配置 */
export function updateEtfWatchConfig(patch: Partial<EtfWatchConfig>): EtfWatchConfig {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    if (!(k in DEFAULT_CONFIG)) continue;
    writeRaw(k, typeof v === 'boolean' ? String(v) : String(v));
  }
  return getEtfWatchConfig();
}
