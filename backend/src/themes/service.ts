import { desc, eq } from 'drizzle-orm';
import type {
  MarketReviewResult,
  MarketTheme,
  MarketThemeStatus,
  ThemeEvidence,
  ThemePhase,
  ThemeSource,
  ThemeVerdict,
  ThemesRefreshResult,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { getTodayDetail } from '../plan/service';
import { trending } from '../trendradar/service';
import { getSectorRanking, getSectorMoneyFlow } from '../market/eastmoney';
import { shanghaiDateStr } from '../market/calendar';
import { newId, nowIso } from '../util';

// 结构化市场主线聚合：以「东财真实板块（行业+概念涨幅榜 + 主力净流入）」为主源沉淀主线，
// 「复盘计划 focusSectors / 热点雷达 trending」作为证据 overlay（只增强已有板块主线、不凭关键词造噪声），
// 按主线名归并到 market_themes，多源叠加强度、留证据痕迹，供计划/决策/板块研判统一复用。
// 纯结构化沉淀，不调用 LLM。研报源预留同模式钩子（见 ingestFromResearch 注释）。

/** 退潮/归档的空闲天数阈值（按自然日近似交易日，足够区分新鲜度） */
const FADING_AFTER_DAYS = 5;
const ARCHIVE_AFTER_DAYS = 10;
/** 单条主线保留的证据上限（防膨胀） */
const MAX_EVIDENCE = 8;

const clamp = (v: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, v));

/** 单条强度历史快照 */
type StrengthPoint = { date: string; strength: number };
/** 强度历史保留上限（近 30 个交易/自然日） */
const MAX_STRENGTH_HISTORY = 30;
/** 趋势判定阈值（点） */
const TREND_DELTA = 5;

/** 主线持续天数：首次出现→最近出现（含端点） */
function calcDurationDays(firstSeen: string, lastSeen: string): number {
  const a = Date.parse(firstSeen);
  const b = Date.parse(lastSeen);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 1;
  return Math.floor((b - a) / 86400000) + 1;
}

/** 强度趋势：用历史末值与若干日前对比（旧→新序列） */
function calcStrengthTrend(history: StrengthPoint[]): MarketTheme['strengthTrend'] {
  if (history.length < 2) return 'flat';
  const last = history[history.length - 1].strength;
  const ref = history[Math.max(0, history.length - 4)].strength;
  const delta = last - ref;
  if (delta >= TREND_DELTA) return 'rising';
  if (delta <= -TREND_DELTA) return 'falling';
  return 'flat';
}

/** 追加/更新当日强度快照（同日覆盖，按日去重，保留近 MAX 条，旧→新） */
function appendStrengthHistory(prev: StrengthPoint[], date: string, strength: number): StrengthPoint[] {
  const filtered = prev.filter((p) => p.date !== date);
  filtered.push({ date, strength: Math.round(strength) });
  return filtered.slice(-MAX_STRENGTH_HISTORY);
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToTheme(row: typeof schema.marketThemes.$inferSelect): MarketTheme {
  const strengthHistory = parseJson<StrengthPoint[]>(row.strengthHistory ?? '[]', []);
  return {
    id: row.id,
    theme: row.theme,
    boardCode: row.boardCode ?? null,
    strength: row.strength,
    status: row.status as MarketThemeStatus,
    phase: (row.phase as ThemePhase) ?? '未知',
    sources: parseJson<ThemeSource[]>(row.sources, []),
    evidence: parseJson<ThemeEvidence[]>(row.evidence, []),
    firstSeenDate: row.firstSeenDate,
    lastSeenDate: row.lastSeenDate,
    durationDays: calcDurationDays(row.firstSeenDate, row.lastSeenDate),
    strengthTrend: calcStrengthTrend(strengthHistory),
    strengthHistory,
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
  /** 仅在主线已存在时增强（overlay 源用），避免凭关键词/复盘文字凭空造主线 */
  attachOnly?: boolean;
  /** 生命周期阶段（复盘验证源写入；缺省不改动既有 phase） */
  phase?: ThemePhase;
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
    if (input.attachOnly) return; // overlay 源：主线不存在则跳过，不造噪声
    const initStrength = clamp(input.strengthHint);
    db.insert(schema.marketThemes)
      .values({
        id: newId(),
        theme,
        boardCode: input.boardCode ?? null,
        strength: initStrength,
        status: 'active',
        phase: input.phase ?? '未知',
        sources: JSON.stringify([input.source]),
        evidence: JSON.stringify([newEvidence]),
        strengthHistory: JSON.stringify([{ date: input.date, strength: Math.round(initStrength) }]),
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
  const strengthHistory = appendStrengthHistory(prev.strengthHistory, input.date, strength);

  db.update(schema.marketThemes)
    .set({
      boardCode: input.boardCode ?? prev.boardCode,
      strength,
      status: 'active',
      phase: input.phase ?? prev.phase,
      sources: JSON.stringify(sources),
      evidence: JSON.stringify(evidence),
      strengthHistory: JSON.stringify(strengthHistory),
      lastSeenDate: input.date,
      updatedAt: now,
    })
    .where(eq(schema.marketThemes.id, prev.id))
    .run();
}

/** 适配器⓪（主源）：东财真实板块（行业 + 概念）涨幅榜 + 主力净流入 → 主线。
 * 强度由「涨幅排名分」叠加「主力净流入加成」合成，只收当日红盘板块，避免引入退潮板块。 */
async function ingestFromBoards(date: string): Promise<number> {
  let industries: Awaited<ReturnType<typeof getSectorRanking>> = [];
  let concepts: Awaited<ReturnType<typeof getSectorRanking>> = [];
  let midInd: Awaited<ReturnType<typeof getSectorRanking>> = [];
  let midCon: Awaited<ReturnType<typeof getSectorRanking>> = [];
  let inflow: Awaited<ReturnType<typeof getSectorMoneyFlow>> = [];
  try {
    // 今日涨幅榜 + 60日中线强势榜（f24）双口径并取，让持续型主线不因今日不热而漏沉淀
    [industries, concepts, midInd, midCon, inflow] = await Promise.all([
      getSectorRanking('industry', 15, 'today').catch(() => []),
      getSectorRanking('concept', 15, 'today').catch(() => []),
      getSectorRanking('industry', 15, 'mid60').catch(() => []),
      getSectorRanking('concept', 15, 'mid60').catch(() => []),
      getSectorMoneyFlow('inflow', 25).catch(() => []),
    ]);
  } catch {
    return 0; // 板块源整体异常不阻断 overlay 源
  }
  // 主力净流入按板块名建索引（亿），作为强度加成
  const inflowByName = new Map(inflow.map((s) => [s.name, s.netInflow]));

  let n = 0;
  // 今日榜按排名计基分；中线榜(60日)补充，按 ret60 计中线加成。两榜按板块代码去重，今日榜优先。
  const ingest = (
    todayList: typeof industries,
    midList: typeof industries,
    kind: '行业' | '概念',
  ): void => {
    const todayRank = new Map<string, number>();
    todayList.forEach((s, i) => {
      if (s.code) todayRank.set(s.code, i);
    });
    const seen = new Set<string>();
    for (const s of [...todayList, ...midList]) {
      if (!s.name || !s.code || seen.has(s.code)) continue;
      const ret60 = s.ret60 ?? null;
      const isTodayRed = (s.pct ?? 0) > 0;
      const isMidStrong = ret60 != null && ret60 > 0;
      // 收录：今日红盘，或 60日强势且今日未明显走弱（pct>-2，避免引入退潮板块）
      if (!isTodayRed && !(isMidStrong && (s.pct ?? 0) > -2)) continue;
      seen.add(s.code);
      const idx = todayRank.get(s.code);
      // 上今日榜：排名越前基分越高（70→42）；仅中线榜：给中性基分 46
      const rankScore = idx != null ? clamp(70 - idx * 2, 42, 70) : 46;
      const flow = inflowByName.get(s.name);
      const flowBonus = flow != null && flow > 0 ? clamp(flow * 1.5, 0, 22) : 0; // 净流入越大加成越高
      const midBonus = isMidStrong ? clamp((ret60 ?? 0) * 0.4, 0, 18) : 0; // 60日越强中线加成越高
      const rankText = idx != null ? `涨幅榜第${idx + 1}（+${(s.pct ?? 0).toFixed(2)}%）` : '60日中线榜';
      const midText = ret60 != null ? `·60日${ret60 >= 0 ? '+' : ''}${ret60.toFixed(1)}%` : '';
      const flowText = flow != null ? `·主力净流入${flow.toFixed(2)}亿` : '';
      const leadText = s.leadStock ? `·领涨${s.leadStock}` : '';
      upsertTheme({
        theme: s.name,
        boardCode: s.code || null,
        source: 'board',
        strengthHint: clamp(rankScore + flowBonus + midBonus, 42, 98),
        evidence: `板块[${kind}]：${rankText}${midText}${flowText}${leadText}`,
        date,
      });
      n += 1;
    }
  };
  ingest(industries, midInd, '行业');
  ingest(concepts, midCon, '概念');
  return n;
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

/** 适配器②（overlay）：热点雷达 trending → 仅为「已存在的板块主线」补消息面证据（attachOnly），
 * 不再凭新闻关键词凭空造主线，杜绝此前「市场主线不是想要的」噪声。 */
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
      attachOnly: true,
    });
    n += 1;
  }
  return n;
}

/** 复盘验证结论 verdict → 主线生命周期阶段 */
function verdictToPhase(v: ThemeVerdict): ThemePhase {
  switch (v) {
    case '加速':
      return '加速';
    case '延续':
      return '启动';
    case '分歧':
      return '分歧';
    case '退潮':
    case '证伪':
      return '退潮';
  }
}

/** verdict 缺失时从强度描述文字粗略推断（兜底，老复盘无 verdict 字段时仍能回流） */
function inferVerdict(strength?: string): ThemeVerdict | null {
  const s = strength ?? '';
  if (/退潮|退坡|熄火|衰退|证伪/.test(s)) return '退潮';
  if (/分歧|高低切/.test(s)) return '分歧';
  if (/加速|启动|发酵/.test(s)) return '加速';
  if (/主线|龙头|核心|延续/.test(s)) return '延续';
  return null;
}

/** 适配器③：复盘 mainThemes 的验证结论 → 回流共享主线（写 phase / 调整强度与退潮态）。
 * 闭合阶段 B「复盘验证 → 主线回流」：复盘逐条对照共享主线给 verdict，据此沉淀阶段与强弱。
 * 供 review 模块在 review.eod 成功后调用（onDeepReviewComplete）。返回处理条数。 */
export function ingestFromReview(jsonText: string): number {
  let obj: Partial<MarketReviewResult> | null = null;
  try {
    const start = jsonText.indexOf('{');
    const end = jsonText.lastIndexOf('}');
    if (start === -1 || end <= start) return 0;
    obj = JSON.parse(jsonText.slice(start, end + 1)) as Partial<MarketReviewResult>;
  } catch {
    return 0;
  }
  const themes = obj?.mainThemes;
  if (!Array.isArray(themes)) return 0;
  const date = shanghaiDateStr(new Date());
  let n = 0;
  for (const t of themes) {
    const name = (t.name ?? '').trim();
    if (!name) continue;
    const verdict = t.verdict ?? inferVerdict(t.strength);
    if (!verdict) continue;
    const phase = verdictToPhase(verdict);
    const existing = db
      .select()
      .from(schema.marketThemes)
      .where(eq(schema.marketThemes.theme, name))
      .get();
    const prevStrength = existing ? existing.strength : 55;
    const delta = verdict === '加速' ? 8 : verdict === '延续' ? 3 : verdict === '分歧' ? -6 : -14;
    upsertTheme({
      theme: name,
      source: 'review',
      strengthHint: clamp(prevStrength + delta),
      evidence: `复盘验证[${verdict}]：${t.reason || t.strength || name}`,
      date,
      phase,
    });
    // upsert 仅叠加强度（Math.max）且强制 active；负向 verdict 需直接下修强度，退潮/证伪并置 fading。
    if (delta < 0) {
      const row = db
        .select()
        .from(schema.marketThemes)
        .where(eq(schema.marketThemes.theme, name))
        .get();
      if (row) {
        db.update(schema.marketThemes)
          .set({
            strength: clamp(prevStrength + delta),
            status: verdict === '退潮' || verdict === '证伪' ? 'fading' : row.status,
            updatedAt: nowIso(),
          })
          .where(eq(schema.marketThemes.id, row.id))
          .run();
      }
    }
    n += 1;
  }
  return n;
}

// 适配器④（预留）：研报主线 ingestFromResearch
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
  // 主源先行（建立板块主线全集），再叠加 overlay 证据，最后推进退潮/归档
  const fromBoards = await ingestFromBoards(date);
  const fromPlan = ingestFromPlan(date);
  const fromHot = await ingestFromHotspots(date);
  const archived = archiveStale(date);
  const activeTotal = listThemes(false).filter((t) => t.status === 'active').length;
  return { asOf: nowIso(), ingested: fromBoards + fromPlan + fromHot, archived, activeTotal };
}

// ===== 板块主线研判（agent 过滤层）=====
// 确定性取数（market_board_strength 工具）先把行业/概念中线强弱 + 真实板块主线算出来，
// 再由 agent 识别过滤出可信主线 / 中线行业 / 噪声，成功后落 taskRun（taskName=板块主线研判），
// 供今日计划生成作为「板块/中线基准」第五源，以及大盘页两个 Tab 顶部展示结论。

export const BOARD_REVIEW_TASK_NAME = '板块主线研判';

export const BOARD_REVIEW_PROMPT =
  '基于确定性板块数据做「板块主线研判」，输出可供今日计划直接引用的板块/中线基准。只研判、不下单、不取个股交易动作。\n\n' +
  '交易日校验（默认放行）：仅周一至周五触发，默认按交易日执行；接口异常一律按交易日继续，不据此判休市。\n\n' +
  '第1步 取确定性底稿：调用 market_board_strength 一次，拿到「行业/概念按中线强度排序的强弱榜」+「真实板块归并的市场主线（含资金净流入/领涨/状态/来源数）」。这是你研判的事实基础，禁止凭空编造板块或强度。\n' +
  '第2步 佐证（可选，最多各一次）：用 get_latest_review_stance 看最新大盘复盘立场；必要时 research_reports(action=discover) 或 trendradar_hotspots(action=summary) 补行业景气/消息面。仅用于解释「为什么这条主线可信/存疑」，不引入底稿里没有的新板块当主线。\n' +
  '第3步 过滤研判：结合中线强度（均线/动量，非当日涨幅）+ 资金净流入持续性 + 来源数，区分：①确定性主线（强度高、资金净流入、多源印证、趋势多头/向上）②值得中线跟踪的行业/概念（趋势向上但尚未放量，潜伏）③应剔除的噪声/退潮（仅当日涨幅冲高但中线走弱、单源、资金流出）。\n\n' +
  '输出（竖排清单，禁止 Markdown 表格，控制在一屏内）：\n' +
  '🧭 板块主线研判（标注数据时间）\n' +
  '一、今日确定性主线（≤4 条）：主线名 ｜中线强度/趋势 ｜资金面 ｜领涨 ｜一句可信度理由\n' +
  '二、中线值得跟踪（≤4 条）：行业/概念 ｜趋势 ｜潜伏理由\n' +
  '三、剔除/退潮提示（≤3 条）：板块 ｜剔除原因（噪声/退潮/单源）\n' +
  '四、一句话结论：当前市场主线方向与中线风格（进攻/均衡/防守）。\n' +
  '⚠️ 确定性指标研判，仅供参考，不构成投资建议。';
