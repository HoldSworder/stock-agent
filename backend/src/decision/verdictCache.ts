import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  DecisionHorizon,
  DecisionResult,
  DecisionScenario,
  DecisionVerdictCache,
} from '@stock-agent/shared';
import { db } from '../db/client';
import { decisionVerdicts } from '../db/schema';
import { newId, nowIso } from '../util';

// 决策裁决缓存：把一次多智能体辩论的结构化裁决按 (code,scenario,horizon) 落库，
// 交易判断只认本表（带过期/场景/输入指纹/失效条件校验），过期或不一致必须重跑。
// 取代「读 ai_analyses markdown latest 当交易缓存」的旧做法（markdown 仅供人读历史）。

type VerdictRow = typeof decisionVerdicts.$inferSelect;

/** 各场景默认缓存时长（分钟）：短线时效短、中线可放宽 */
const DEFAULT_TTL_MIN: Record<DecisionHorizon, number> = {
  short: 90,
  mid: 1440,
};

/** 计算输入指纹：场景/视角/context/引擎配置变化即令缓存失效 */
export function computeInputHash(parts: {
  code: string;
  scenario: DecisionScenario;
  horizon: DecisionHorizon;
  context?: string;
  configSig?: string;
}): string {
  const raw = [parts.code, parts.scenario, parts.horizon, parts.context ?? '', parts.configSig ?? ''].join('|');
  return createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/** 由决策结果派生默认失效条件（价格越界锚点 + 通用时效说明） */
function deriveInvalidators(result: DecisionResult): string[] {
  const out: string[] = ['超过有效期（expiresAt）即失效，须重跑', '交易日切换或盘面环境突变须重跑'];
  if (result.stopLoss != null) out.push(`现价跌破止损 ${result.stopLoss} 即失效`);
  if (result.targetPrice != null) out.push(`现价升破目标价 ${result.targetPrice} 须复核（兑现/超预期）`);
  return out;
}

function rowToCache(row: VerdictRow, fresh: boolean): DecisionVerdictCache {
  let result: DecisionResult;
  try {
    result = JSON.parse(row.verdictJson) as DecisionResult;
  } catch {
    result = {
      code: row.code,
      name: row.name,
      action: row.action as DecisionResult['action'],
      confidence: row.confidence,
      thesis: '',
      keyRisks: [],
      analystReports: [],
      bullView: '',
      bearView: '',
      judgeView: '',
      narrative: '',
    };
  }
  let invalidators: string[] = [];
  try {
    invalidators = JSON.parse(row.invalidators) as string[];
  } catch {
    /* 解析失败留空 */
  }
  return {
    code: row.code,
    name: row.name,
    scenario: row.scenario as DecisionScenario,
    horizon: row.horizon as DecisionHorizon,
    action: row.action as DecisionResult['action'],
    confidence: row.confidence,
    dataAsOf: row.dataAsOf,
    expiresAt: row.expiresAt,
    inputHash: row.inputHash,
    invalidators,
    result,
    fresh,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 价格是否触发了缓存裁决的失效条件（越过止损/目标价） */
function priceInvalidates(result: DecisionResult, price: number | null | undefined): boolean {
  if (price == null || !Number.isFinite(price)) return false;
  if (result.stopLoss != null && price < result.stopLoss) return true;
  if (result.targetPrice != null && price > result.targetPrice) return true;
  return false;
}

/**
 * 写入/更新某 (code,scenario,horizon) 的裁决缓存。always upsert（覆盖旧的最新裁决）。失败不抛。
 */
export function putVerdict(params: {
  result: DecisionResult;
  scenario: DecisionScenario;
  horizon: DecisionHorizon;
  inputHash: string;
  ttlMinutes?: number;
}): void {
  try {
    const now = nowIso();
    const ttl = params.ttlMinutes ?? DEFAULT_TTL_MIN[params.horizon];
    const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();
    const invalidators = deriveInvalidators(params.result);
    const existing = db
      .select({ id: decisionVerdicts.id, createdAt: decisionVerdicts.createdAt })
      .from(decisionVerdicts)
      .where(
        and(
          eq(decisionVerdicts.code, params.result.code),
          eq(decisionVerdicts.scenario, params.scenario),
          eq(decisionVerdicts.horizon, params.horizon),
        ),
      )
      .get();
    const values = {
      code: params.result.code,
      name: params.result.name,
      scenario: params.scenario,
      horizon: params.horizon,
      action: params.result.action,
      confidence: params.result.confidence,
      dataAsOf: now,
      expiresAt,
      inputHash: params.inputHash,
      verdictJson: JSON.stringify(params.result),
      invalidators: JSON.stringify(invalidators),
      updatedAt: now,
    };
    if (existing) {
      db.update(decisionVerdicts).set(values).where(eq(decisionVerdicts.id, existing.id)).run();
    } else {
      db.insert(decisionVerdicts)
        .values({ id: newId(), createdAt: now, ...values })
        .run();
    }
  } catch (e) {
    console.warn('[decision] 裁决缓存写入失败:', e instanceof Error ? e.message : e);
  }
}

/**
 * 读取仍然有效的裁决缓存：未过期 + 输入指纹一致（若提供）+ 现价未触发失效条件（若提供）才返回 result。
 * 任一不满足返回 null → 调用方必须重跑。
 */
export function getValidVerdict(
  code: string,
  scenario: DecisionScenario,
  horizon: DecisionHorizon,
  opts: { inputHash?: string; price?: number | null } = {},
): DecisionVerdictCache | null {
  try {
    const row = db
      .select()
      .from(decisionVerdicts)
      .where(
        and(
          eq(decisionVerdicts.code, code),
          eq(decisionVerdicts.scenario, scenario),
          eq(decisionVerdicts.horizon, horizon),
        ),
      )
      .get();
    if (!row) return null;
    const cache = rowToCache(row, true);
    const expired = Date.now() >= new Date(row.expiresAt).getTime();
    const hashMismatch = opts.inputHash != null && opts.inputHash !== row.inputHash;
    const priceTripped = priceInvalidates(cache.result, opts.price);
    if (expired || hashMismatch || priceTripped) return null;
    return cache;
  } catch {
    return null;
  }
}

/** 读取某 (code,scenario,horizon) 缓存（含失效，fresh 字段标注是否仍有效），供 UI/排查 */
export function peekVerdict(
  code: string,
  scenario: DecisionScenario,
  horizon: DecisionHorizon,
): DecisionVerdictCache | null {
  try {
    const row = db
      .select()
      .from(decisionVerdicts)
      .where(
        and(
          eq(decisionVerdicts.code, code),
          eq(decisionVerdicts.scenario, scenario),
          eq(decisionVerdicts.horizon, horizon),
        ),
      )
      .get();
    if (!row) return null;
    const fresh = Date.now() < new Date(row.expiresAt).getTime();
    return rowToCache(row, fresh);
  } catch {
    return null;
  }
}

/** 列出最近缓存（默认全部场景，可按 code 过滤），按更新时间倒序，供 UI 总览 */
export function listVerdicts(codes?: string[], limit = 100): DecisionVerdictCache[] {
  try {
    const base = db.select().from(decisionVerdicts);
    const rows = (
      codes && codes.length
        ? base.where(inArray(decisionVerdicts.code, codes))
        : base
    )
      .orderBy(desc(decisionVerdicts.updatedAt))
      .limit(limit)
      .all();
    const now = Date.now();
    return rows.map((r) => rowToCache(r, now < new Date(r.expiresAt).getTime()));
  } catch {
    return [];
  }
}
