import { desc, eq } from 'drizzle-orm';
import type {
  Playbook,
  PlaybookBacktest,
  PlaybookBacktestListItem,
  PlaybookBacktestMetrics,
  PlaybookEquityPoint,
  PlaybookHorizon,
  PlaybookSpec,
  PlaybookStatus,
  PlaybookTrade,
  PlaybookUpsert,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso } from '../util';

// 战法库持久层：主表除 spec 外与 DTO 一一对应；回测记录的 JSON 字段在出入口统一 (de)serialize。

type PlaybookRow = typeof schema.playbooks.$inferSelect;
type BacktestRow = typeof schema.playbookBacktests.$inferSelect;

function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const STATUSES: PlaybookStatus[] = ['collected', 'testing', 'adopted', 'retired'];
const HORIZONS: PlaybookHorizon[] = ['short', 'mid', 'long'];

function toApi(row: PlaybookRow): Playbook {
  return {
    ...row,
    horizon: HORIZONS.includes(row.horizon as PlaybookHorizon)
      ? (row.horizon as PlaybookHorizon)
      : null,
    status: STATUSES.includes(row.status as PlaybookStatus)
      ? (row.status as PlaybookStatus)
      : 'collected',
    spec: parse<PlaybookSpec | null>(row.spec, null),
  };
}

/** 全量列表，最近更新在前（搜索/筛选交给前端本地做） */
export function listPlaybooks(): Playbook[] {
  return db
    .select()
    .from(schema.playbooks)
    .orderBy(desc(schema.playbooks.updatedAt))
    .all()
    .map(toApi);
}

export function getPlaybook(id: string): Playbook | null {
  const row = db.select().from(schema.playbooks).where(eq(schema.playbooks.id, id)).get();
  return row ? toApi(row) : null;
}

/** 归一化入参：空串一律存 null，星级夹到 0-5，状态/周期非法值回落 */
function normalize(input: PlaybookUpsert) {
  const text = (v: string | null | undefined) => {
    const s = String(v ?? '').trim();
    return s === '' ? null : s;
  };
  return {
    name: String(input.name ?? '').trim(),
    summary: text(input.summary),
    category: text(input.category),
    tags: text(input.tags),
    horizon: HORIZONS.includes(input.horizon as PlaybookHorizon) ? input.horizon! : null,
    marketEnv: text(input.marketEnv),
    source: text(input.source),
    sourceUrl: text(input.sourceUrl),
    pickMd: text(input.pickMd),
    buyMd: text(input.buyMd),
    sellMd: text(input.sellMd),
    riskMd: text(input.riskMd),
    notesMd: text(input.notesMd),
    rating: Math.min(5, Math.max(0, Math.round(Number(input.rating ?? 0)) || 0)),
    status: STATUSES.includes(input.status) ? input.status : 'collected',
    spec: input.spec ? JSON.stringify(input.spec) : null,
  };
}

export function createPlaybook(input: PlaybookUpsert): Playbook {
  const now = nowIso();
  const id = newId();
  db.insert(schema.playbooks)
    .values({ id, ...normalize(input), createdAt: now, updatedAt: now })
    .run();
  return getPlaybook(id)!;
}

/** 单独保存回测规则（与详情表单解耦，规则编辑器可独立保存） */
export function setSpec(id: string, spec: PlaybookSpec | null): Playbook | null {
  if (!getPlaybook(id)) return null;
  db.update(schema.playbooks)
    .set({ spec: spec ? JSON.stringify(spec) : null, updatedAt: nowIso() })
    .where(eq(schema.playbooks.id, id))
    .run();
  return getPlaybook(id);
}

/** 全量覆盖更新；id 不存在返回 null 由路由层转 404 */
export function updatePlaybook(id: string, input: PlaybookUpsert): Playbook | null {
  if (!getPlaybook(id)) return null;
  db.update(schema.playbooks)
    .set({ ...normalize(input), updatedAt: nowIso() })
    .where(eq(schema.playbooks.id, id))
    .run();
  return getPlaybook(id);
}

/** 删战法及其回测记录；无外键级联，故用事务包住，避免中途失败留下孤儿回测行 */
export function removePlaybook(id: string): void {
  db.transaction((tx) => {
    tx.delete(schema.playbookBacktests).where(eq(schema.playbookBacktests.playbookId, id)).run();
    tx.delete(schema.playbooks).where(eq(schema.playbooks.id, id)).run();
  });
}

// ---- 回测记录 ----

function backtestToApi(row: BacktestRow): PlaybookBacktest {
  return {
    id: row.id,
    playbookId: row.playbookId,
    label: row.label,
    source: row.source === 'external' ? 'external' : 'system',
    range: row.range,
    poolSize: row.poolSize,
    metrics: parse<PlaybookBacktestMetrics>(row.metrics, {}),
    trades: parse<PlaybookTrade[]>(row.trades, []),
    equity: parse<PlaybookEquityPoint[]>(row.equity, []),
    notes: parse<string[]>(row.notes, []),
    spec: parse<PlaybookSpec | null>(row.spec, null),
    createdAt: row.createdAt,
  };
}

/** 列表：省去逐笔与权益曲线，避免列表接口塞满大 JSON */
export function listBacktests(playbookId: string): PlaybookBacktestListItem[] {
  return db
    .select()
    .from(schema.playbookBacktests)
    .where(eq(schema.playbookBacktests.playbookId, playbookId))
    .orderBy(desc(schema.playbookBacktests.createdAt))
    .all()
    .map((row) => {
      const { trades: _t, equity: _e, spec: _s, ...rest } = backtestToApi(row);
      return rest;
    });
}

export function getBacktest(id: string): PlaybookBacktest | null {
  const row = db
    .select()
    .from(schema.playbookBacktests)
    .where(eq(schema.playbookBacktests.id, id))
    .get();
  return row ? backtestToApi(row) : null;
}

export function addBacktest(
  playbookId: string,
  input: Omit<PlaybookBacktest, 'id' | 'playbookId' | 'createdAt'>,
): PlaybookBacktest {
  const id = newId();
  db.insert(schema.playbookBacktests)
    .values({
      id,
      playbookId,
      label: input.label,
      source: input.source,
      range: input.range ?? null,
      poolSize: input.poolSize ?? null,
      metrics: JSON.stringify(input.metrics ?? {}),
      trades: JSON.stringify(input.trades ?? []),
      equity: JSON.stringify(input.equity ?? []),
      notes: JSON.stringify(input.notes ?? []),
      spec: input.spec ? JSON.stringify(input.spec) : null,
      createdAt: nowIso(),
    })
    .run();
  return getBacktest(id)!;
}

export function removeBacktest(id: string): void {
  db.delete(schema.playbookBacktests).where(eq(schema.playbookBacktests.id, id)).run();
}
