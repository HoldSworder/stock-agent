import { desc, eq, sql } from 'drizzle-orm';
import type { ResearchUniverseItem } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { nowIso } from '../util';

// 研究标的库 CRUD（按 code 幂等），镜像 etf/repo.ts 的 etf_pool，但独立于 ETF 关注列表，
// 供量化研究模式库与站内跟踪引擎取用。

/** 首启默认（与 ETF 跟踪池默认一致的主流方向；其余由 WebUI / codex 增补） */
const DEFAULT_UNIVERSE: ReadonlyArray<{ code: string; name: string; tags: string }> = [
  { code: '510300', name: '沪深300ETF', tags: '宽基' },
  { code: '510500', name: '中证500ETF', tags: '宽基' },
  { code: '588000', name: '科创50ETF', tags: '宽基,科技' },
  { code: '159949', name: '创业板50ETF', tags: '宽基,成长' },
  { code: '512760', name: '半导体ETF', tags: '科技,半导体' },
  { code: '159740', name: '恒生科技ETF', tags: '港股,科技' },
  { code: '561910', name: '电池ETF', tags: '新能源' },
  { code: '510880', name: '红利ETF', tags: '红利,防御' },
];

export function listUniverse(): ResearchUniverseItem[] {
  return db
    .select()
    .from(schema.researchUniverse)
    .orderBy(desc(schema.researchUniverse.addedAt))
    .all();
}

export function addUniverse(input: {
  code: string;
  name: string;
  tags?: string | null;
  note?: string | null;
}): void {
  db.insert(schema.researchUniverse)
    .values({
      code: input.code,
      name: input.name,
      tags: input.tags ?? null,
      note: input.note ?? null,
      addedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: schema.researchUniverse.code,
      set: { name: input.name, tags: input.tags ?? null, note: input.note ?? null },
    })
    .run();
}

export function updateUniverse(
  code: string,
  patch: { tags?: string | null; note?: string | null },
): void {
  const set: Record<string, string | null> = {};
  if (patch.tags !== undefined) set.tags = patch.tags;
  if (patch.note !== undefined) set.note = patch.note;
  if (Object.keys(set).length === 0) return;
  db.update(schema.researchUniverse).set(set).where(eq(schema.researchUniverse.code, code)).run();
}

export function removeUniverse(code: string): void {
  db.delete(schema.researchUniverse).where(eq(schema.researchUniverse.code, code)).run();
}

export function seedUniverseIfEmpty(): void {
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(schema.researchUniverse)
    .get();
  if ((row?.c ?? 0) > 0) return;
  for (const e of DEFAULT_UNIVERSE) addUniverse({ code: e.code, name: e.name, tags: e.tags });
  console.log(`[seed] 已写入 ${DEFAULT_UNIVERSE.length} 只默认研究标的库`);
}
