import { desc, eq } from 'drizzle-orm';
import type {
  MarketTheme,
  MarketThemeStatus,
  ThemeEvidence,
  ThemeSource,
  ThemesRefreshResult,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { getTodayDetail } from '../plan/service';
import { trending } from '../trendradar/service';
import { shanghaiDateStr } from '../market/calendar';
import { newId, nowIso } from '../util';

// 结构化市场主线聚合：把「复盘计划 focusSectors / 热点雷达 trending」等多源板块判断
// 按主线名归并到 market_themes，多源叠加强度、留证据痕迹，供计划/决策/中线雷达统一复用。
// 纯结构化沉淀，不调用 LLM。研报源预留同模式钩子（见 ingestFromResearch 注释）。

/** 退潮/归档的空闲天数阈值（按自然日近似交易日，足够区分新鲜度） */
const FADING_AFTER_DAYS = 5;
const ARCHIVE_AFTER_DAYS = 10;
/** 单条主线保留的证据上限（防膨胀） */
const MAX_EVIDENCE = 8;

const clamp = (v: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, v));

function rowToTheme(row: typeof schema.marketThemes.$inferSelect): MarketTheme {
  const parse = <T>(raw: string, fallback: T): T => {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: row.id,
    theme: row.theme,
    boardCode: row.boardCode ?? null,
    strength: row.strength,
    status: row.status as MarketThemeStatus,
    sources: parse<ThemeSource[]>(row.sources, []),
    evidence: parse<ThemeEvidence[]>(row.evidence, []),
    firstSeenDate: row.firstSeenDate,
    lastSeenDate: row.lastSeenDate,
    updatedAt: row.updatedAt,
  };
}

export function listThemes(includeArchived = false): MarketTheme[] {
  const rows = db
    .select()
    .from(schema.marketThemes)
    .orderBy(desc(schema.marketThemes.strength))
    .all()
    .map(rowToTheme);
  const ranked = includeArchived ? rows : rows.filter((t) => t.status !== 'archived');
  // active 优先，其次 fading，组内按强度降序
  const order: Record<MarketThemeStatus, number> = { active: 0, fading: 1, archived: 2 };
  return ranked.sort((a, b) => order[a.status] - order[b.status] || b.strength - a.strength);
}

export function setThemeStatus(id: string, status: MarketThemeStatus): MarketTheme | null {
  const row = db.select().from(schema.marketThemes).where(eq(schema.marketThemes.id, id)).get();
  if (!row) return null;
  db.update(schema.marketThemes)
    .set({ status, updatedAt: nowIso() })
    .where(eq(schema.marketThemes.id, id))
    .run();
  return rowToTheme({ ...row, status });
}

interface UpsertInput {
  theme: string;
  boardCode?: string | null;
  source: ThemeSource;
  /** 本源给出的强度提示 0-100 */
  strengthHint: number;
  /** 证据文本 */
  evidence: string;
  date: string;
}

/** 按主线名归并 upsert：多源叠加强度（新增来源 +8 协同加成），合并来源与证据 */
function upsertTheme(input: UpsertInput): void {
  const theme = input.theme.trim();
  if (!theme) return;
  const now = nowIso();
  const existing = db
    .select()
    .from(schema.marketThemes)
    .where(eq(schema.marketThemes.theme, theme))
    .get();

  const newEvidence: ThemeEvidence = { source: input.source, text: input.evidence, at: input.date };

  if (!existing) {
    db.insert(schema.marketThemes)
      .values({
        id: newId(),
        theme,
        boardCode: input.boardCode ?? null,
        strength: clamp(input.strengthHint),
        status: 'active',
        sources: JSON.stringify([input.source]),
        evidence: JSON.stringify([newEvidence]),
        firstSeenDate: input.date,
        lastSeenDate: input.date,
        updatedAt: now,
        createdAt: now,
      })
      .run();
    return;
  }

  const prev = rowToTheme(existing);
  const hasNewSource = !prev.sources.includes(input.source);
  const sources = hasNewSource ? [...prev.sources, input.source] : prev.sources;
  const strength = clamp(Math.max(prev.strength, input.strengthHint) + (hasNewSource ? 8 : 0));
  // 同源同日证据去重，新的置顶，保留最近 MAX_EVIDENCE 条
  const evidence = [
    newEvidence,
    ...prev.evidence.filter((e) => !(e.source === input.source && e.at === input.date)),
  ].slice(0, MAX_EVIDENCE);

  db.update(schema.marketThemes)
    .set({
      boardCode: input.boardCode ?? prev.boardCode,
      strength,
      status: 'active',
      sources: JSON.stringify(sources),
      evidence: JSON.stringify(evidence),
      lastSeenDate: input.date,
      updatedAt: now,
    })
    .where(eq(schema.marketThemes.id, prev.id))
    .run();
}

/** 复盘计划强度阶段文字 → 强度分 */
function reviewStrength(stage: string): number {
  const s = stage ?? '';
  if (/主线|龙头|核心/.test(s)) return 90;
  if (/启动|发酵|加速/.test(s)) return 75;
  if (/扩散|补涨|轮动/.test(s)) return 65;
  if (/分歧|高低切/.test(s)) return 50;
  if (/退潮|退坡|熄火|衰退/.test(s)) return 30;
  return 60;
}

/** 适配器①：复盘计划 focusSectors → 主线（最结构化的来源） */
function ingestFromPlan(date: string): number {
  const detail = getTodayDetail();
  const focusSectors = detail?.plan?.focusSectors;
  if (!Array.isArray(focusSectors)) return 0;
  let n = 0;
  for (const fs of focusSectors) {
    if (!fs.name) continue;
    upsertTheme({
      theme: fs.name,
      source: 'review',
      strengthHint: reviewStrength(fs.strength),
      evidence: `复盘[${fs.strength || '关注'}]：${fs.reason || fs.name}`,
      date,
    });
    n += 1;
  }
  return n;
}

/** 适配器②：热点雷达 trending → 主线候选（仅取有一定热度的，避免噪声） */
async function ingestFromHotspots(date: string): Promise<number> {
  let topics;
  try {
    topics = await trending(12, 'daily');
  } catch {
    return 0; // 热点源异常不影响其它来源
  }
  let n = 0;
  for (const t of topics) {
    if (!t.keyword || t.matchedNews < 2) continue; // 命中过少视为噪声
    const strengthHint = clamp(40 + t.matchedNews * 4 + (/rising|升/.test(t.trend) ? 10 : 0), 40, 72);
    upsertTheme({
      theme: t.keyword,
      source: 'hotspot',
      strengthHint,
      evidence: `热点：命中 ${t.matchedNews} 条·热度 ${Math.round(t.weightScore)}·${t.trend}`,
      date,
    });
    n += 1;
  }
  return n;
}

// 适配器③（预留）：研报主线 ingestFromResearch
// 研报产出按个股/行业维度散落在 ai_analyses，结构与本模块归并键（板块名）不直接对齐，
// 接入时在此新增 adapter 调 upsertTheme({ source: 'research', ... }) 即可，无需改其它逻辑。

/** 退潮/归档：依据 lastSeenDate 空闲天数推进状态（不删除，保留历史） */
function archiveStale(today: string): number {
  const todayMs = Date.parse(today);
  let changed = 0;
  for (const t of listThemes(true)) {
    if (t.status === 'archived') continue;
    const idleDays = Math.floor((todayMs - Date.parse(t.lastSeenDate)) / 86400000);
    let next: MarketThemeStatus | null = null;
    if (idleDays >= ARCHIVE_AFTER_DAYS) next = 'archived';
    else if (idleDays >= FADING_AFTER_DAYS && t.status === 'active') next = 'fading';
    if (next && next !== t.status) {
      db.update(schema.marketThemes)
        .set({ status: next, updatedAt: nowIso() })
        .where(eq(schema.marketThemes.id, t.id))
        .run();
      changed += 1;
    }
  }
  return changed;
}

/** 聚合刷新：跑全部来源适配器 + 推进退潮/归档，返回统计 */
export async function refreshThemes(): Promise<ThemesRefreshResult> {
  const date = shanghaiDateStr(new Date());
  const fromPlan = ingestFromPlan(date);
  const fromHot = await ingestFromHotspots(date);
  const archived = archiveStale(date);
  const activeTotal = listThemes(false).filter((t) => t.status === 'active').length;
  return { asOf: nowIso(), ingested: fromPlan + fromHot, archived, activeTotal };
}
