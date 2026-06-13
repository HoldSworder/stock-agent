import { desc, eq, sql } from 'drizzle-orm';
import type { EtfPoolItem } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { nowIso } from '../util';

// ETF 跟踪池 CRUD（按 code 幂等），仿 watchlist。独立于自选股，供 ETF 模块信号计算与今日计划取用。

/** 默认候选池（沿用旺财 ETF 任务内置候选，覆盖宽基/科技/半导体/红利等主流方向） */
const DEFAULT_POOL: ReadonlyArray<{ code: string; name: string; tags: string }> = [
  { code: '510300', name: '沪深300ETF', tags: '宽基' },
  { code: '510500', name: '中证500ETF', tags: '宽基' },
  { code: '588000', name: '科创50ETF', tags: '宽基,科技' },
  { code: '159949', name: '创业板50ETF', tags: '宽基,成长' },
  { code: '512760', name: '半导体ETF', tags: '科技,半导体' },
  { code: '159740', name: '恒生科技ETF', tags: '港股,科技' },
  { code: '561910', name: '电池ETF', tags: '新能源' },
  { code: '510880', name: '红利ETF', tags: '红利,防御' },
];

/** 全部跟踪池标的（按加入时间倒序） */
export function listPool(): EtfPoolItem[] {
  return db
    .select()
    .from(schema.etfPool)
    .orderBy(desc(schema.etfPool.addedAt))
    .all();
}

/** 新增 / 更新（按 code 幂等） */
export function addPool(input: {
  code: string;
  name: string;
  tags?: string | null;
  note?: string | null;
}): void {
  const at = nowIso();
  db.insert(schema.etfPool)
    .values({
      code: input.code,
      name: input.name,
      tags: input.tags ?? null,
      note: input.note ?? null,
      addedAt: at,
    })
    .onConflictDoUpdate({
      target: schema.etfPool.code,
      set: { name: input.name, tags: input.tags ?? null, note: input.note ?? null },
    })
    .run();
}

/** 更新标签 / 备注 */
export function updatePool(
  code: string,
  patch: { tags?: string | null; note?: string | null },
): void {
  const set: Record<string, string | null> = {};
  if (patch.tags !== undefined) set.tags = patch.tags;
  if (patch.note !== undefined) set.note = patch.note;
  if (Object.keys(set).length === 0) return;
  db.update(schema.etfPool).set(set).where(eq(schema.etfPool.code, code)).run();
}

/** 移除跟踪标的 */
export function removePool(code: string): void {
  db.delete(schema.etfPool).where(eq(schema.etfPool.code, code)).run();
}

/** 首次启动（池为空）写入默认候选池 */
export function seedEtfPoolIfEmpty(): void {
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(schema.etfPool)
    .get();
  if ((row?.c ?? 0) > 0) return;
  for (const e of DEFAULT_POOL) addPool({ code: e.code, name: e.name, tags: e.tags });
  console.log(`[seed] 已写入 ${DEFAULT_POOL.length} 只默认 ETF 跟踪池`);
}
