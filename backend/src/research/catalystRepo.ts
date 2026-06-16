import { and, desc, eq, gte } from 'drizzle-orm';
import type { NewsCatalyst, NewsCatalystInput } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso, shanghaiToday } from '../util';

// 消息催化结构化记录 CRUD（情报研判写入 → 今日计划读取）。
// 按 theme 去重 upsert：已存在则递增 seenCount、刷新 lastSeenDate 与可选字段；新题材插入并记 firstSeenDate。
// 「未发酵」= fermented=false 且距首现天数少（起爆前埋伏的核心候选来源）。

type Row = typeof schema.newsCatalysts.$inferSelect;

function parseCodes(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
  } catch {
    return [];
  }
}

function rowToCatalyst(row: Row): NewsCatalyst {
  return {
    id: row.id,
    theme: row.theme,
    catalystType: row.catalystType ?? null,
    direction: row.direction ?? null,
    codes: parseCodes(row.codes),
    catalystWindow: row.catalystWindow ?? null,
    firstSeenDate: row.firstSeenDate,
    lastSeenDate: row.lastSeenDate,
    seenCount: row.seenCount,
    fermented: row.fermented,
    realizedPct: row.realizedPct ?? null,
    note: row.note ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 按 theme 去重 upsert 一条催化；返回写入后的记录 */
export function upsertCatalyst(input: NewsCatalystInput): NewsCatalyst {
  const theme = input.theme.trim();
  if (!theme) throw new Error('catalyst theme 不能为空');
  const today = shanghaiToday();
  const now = nowIso();
  const existing = db
    .select()
    .from(schema.newsCatalysts)
    .where(eq(schema.newsCatalysts.theme, theme))
    .get();

  if (existing) {
    db.update(schema.newsCatalysts)
      .set({
        catalystType: input.catalystType ?? existing.catalystType,
        direction: input.direction ?? existing.direction,
        // 标的并集（去重）
        codes: JSON.stringify(
          Array.from(new Set([...parseCodes(existing.codes), ...(input.codes ?? [])])),
        ),
        catalystWindow: input.catalystWindow ?? existing.catalystWindow,
        fermented: input.fermented ?? existing.fermented,
        realizedPct: input.realizedPct ?? existing.realizedPct,
        note: input.note ?? existing.note,
        lastSeenDate: today,
        // 同日重复上报不重复计数，跨日才 +1
        seenCount: existing.lastSeenDate === today ? existing.seenCount : existing.seenCount + 1,
        updatedAt: now,
      })
      .where(eq(schema.newsCatalysts.id, existing.id))
      .run();
    return rowToCatalyst(
      db.select().from(schema.newsCatalysts).where(eq(schema.newsCatalysts.id, existing.id)).get()!,
    );
  }

  const id = newId();
  db.insert(schema.newsCatalysts)
    .values({
      id,
      theme,
      catalystType: input.catalystType ?? null,
      direction: input.direction ?? null,
      codes: JSON.stringify(input.codes ?? []),
      catalystWindow: input.catalystWindow ?? null,
      firstSeenDate: today,
      lastSeenDate: today,
      seenCount: 1,
      fermented: input.fermented ?? false,
      realizedPct: input.realizedPct ?? null,
      note: input.note ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return rowToCatalyst(
    db.select().from(schema.newsCatalysts).where(eq(schema.newsCatalysts.id, id)).get()!,
  );
}

export interface ListCatalystOptions {
  /** 仅未发酵（起爆前埋伏候选）；默认 false 返回全部 */
  unfermentedOnly?: boolean;
  /** 仅返回最近 N 天内有更新的（按 lastSeenDate）；默认 7 */
  withinDays?: number;
  limit?: number;
}

/** 列出催化记录（默认近 7 天、按最近出现倒序） */
export function listCatalysts(opts: ListCatalystOptions = {}): NewsCatalyst[] {
  const withinDays = opts.withinDays ?? 7;
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  // 计算 withinDays 的起始日界（YYYY-MM-DD 字符串可直接做字典序比较）
  const since = new Date(Date.now() - withinDays * 86400000);
  const sinceStr = shanghaiToday(since);
  const conds = [gte(schema.newsCatalysts.lastSeenDate, sinceStr)];
  if (opts.unfermentedOnly) conds.push(eq(schema.newsCatalysts.fermented, false));
  const rows = db
    .select()
    .from(schema.newsCatalysts)
    .where(and(...conds))
    .orderBy(desc(schema.newsCatalysts.lastSeenDate), desc(schema.newsCatalysts.seenCount))
    .limit(limit)
    .all();
  return rows.map(rowToCatalyst);
}
