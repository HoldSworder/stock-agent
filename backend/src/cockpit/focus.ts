import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { nowIso } from '../util';

/** 驾驶舱关注标的持久化条目（不含实时报价） */
export type FocusRow = typeof schema.cockpitFocus.$inferSelect;

/** 全部关注标的（手动排序位优先，其次加入时间） */
export function listFocus(): FocusRow[] {
  return db
    .select()
    .from(schema.cockpitFocus)
    .orderBy(asc(schema.cockpitFocus.sortOrder), asc(schema.cockpitFocus.createdAt))
    .all();
}

/**
 * 新增关注标的（按 code 幂等：重复添加只刷新名称/备注，不重置加入时间与排序位）。
 * note 未带（undefined/null）时不进 set —— 与 updateFocus 的「未带字段视为不改」语义对齐；
 * 否则用户在已关注标的上再点一次「添加」（前端不填备注即传 null）会把原备注抹掉。
 */
export function addFocus(input: { code: string; name: string; note?: string | null }): void {
  const set: { name: string; note?: string | null } = { name: input.name };
  if (input.note != null) set.note = input.note;
  db.insert(schema.cockpitFocus)
    .values({
      code: input.code,
      name: input.name,
      note: input.note ?? null,
      sortOrder: 0,
      createdAt: nowIso(),
    })
    .onConflictDoUpdate({ target: schema.cockpitFocus.code, set })
    .run();
}

/** 更新备注 / 排序位 */
export function updateFocus(
  code: string,
  patch: { note?: string | null; sortOrder?: number },
): void {
  const set: Record<string, string | number | null> = {};
  if (patch.note !== undefined) set.note = patch.note;
  if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
  if (Object.keys(set).length === 0) return;
  db.update(schema.cockpitFocus).set(set).where(eq(schema.cockpitFocus.code, code)).run();
}

/** 移除关注标的 */
export function removeFocus(code: string): void {
  db.delete(schema.cockpitFocus).where(eq(schema.cockpitFocus.code, code)).run();
}
