import { desc, eq, sql } from 'drizzle-orm';
import type { WatchItem } from '@stock-agent/shared';
import { db, schema } from './db/client';
import { nowIso } from './util';

/** 全部关注标的（按加入时间倒序） */
export function listWatch(): WatchItem[] {
  return db
    .select()
    .from(schema.watchlist)
    .orderBy(desc(schema.watchlist.addedAt), desc(sql`rowid`))
    .all();
}

/** 新增 / 更新关注标的（按 code 幂等） */
export function addWatch(input: {
  code: string;
  name: string;
  tags?: string | null;
  note?: string | null;
  addedAt?: string;
}): void {
  const set: Record<string, string | null> = {
    name: input.name,
    tags: input.tags ?? null,
    note: input.note ?? null,
  };
  // 仅当显式传入 addedAt 时才在冲突更新里重打时间戳（保持 WebUI 手动新增默认行为不变）
  if (input.addedAt !== undefined) set.addedAt = input.addedAt;
  db.insert(schema.watchlist)
    .values({
      code: input.code,
      name: input.name,
      tags: input.tags ?? null,
      note: input.note ?? null,
      addedAt: input.addedAt ?? nowIso(),
    })
    .onConflictDoUpdate({
      target: schema.watchlist.code,
      set,
    })
    .run();
}

/** 更新标签 / 备注 / 加入时间 */
export function updateWatch(
  code: string,
  patch: { tags?: string | null; note?: string | null; addedAt?: string },
): void {
  const set: Record<string, string | null> = {};
  if (patch.tags !== undefined) set.tags = patch.tags;
  if (patch.note !== undefined) set.note = patch.note;
  if (patch.addedAt !== undefined) set.addedAt = patch.addedAt;
  if (Object.keys(set).length === 0) return;
  db.update(schema.watchlist).set(set).where(eq(schema.watchlist.code, code)).run();
}

/** 移除关注标的 */
export function removeWatch(code: string): void {
  db.delete(schema.watchlist).where(eq(schema.watchlist.code, code)).run();
}

/** 从所有标的中剥离某个分组 tag；剥离后无 tag 的标的保留（仅去分组，不删标的）。返回受影响数量 */
export function removeTagFromAll(tag: string): number {
  let affected = 0;
  for (const item of listWatch()) {
    const tags = (item.tags ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!tags.includes(tag)) continue;
    const rest = tags.filter((t) => t !== tag);
    updateWatch(item.code, { tags: rest.length > 0 ? rest.join(',') : null });
    affected += 1;
  }
  return affected;
}
