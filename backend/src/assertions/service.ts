import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type {
  AssertionAccuracy,
  AssertionAccuracyReport,
  AssertionKind,
  AssertionSliceDim,
  AssertionSource,
  KlineBar,
  KlinePeriod,
  SymbolAssertion,
} from '@stock-agent/shared';
import {
  ASSERTION_HORIZON_DAYS,
  ASSERTION_REACTION_BARS,
  ASSERTION_TOLERANCE_BARS,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { getKline } from '../market/eastmoney';
import { buildAnalysis } from '../market/elliott';
import { computeLevels } from '../market/levels';
import { computeChanStructure, detectSwings } from '../symbolPlans/structure';
import { listFocus } from '../cockpit/focus';
import { resolveIndex } from '../decision/indices';
import { wilsonLowerBound } from '../strategy/promotionGate';
import { newId, nowIso, shanghaiToday } from '../util';
import { collectAssertions } from './extract';
import { barsAfter, judgeLevel, judgeTime } from './judge';

// 技术断言账本的冻结、结算与统计。
//
// 立项理由：系统每天都在算波浪见顶位、斐波回撤、枢轴、中枢边界，但从没记录过
// 「后来价格到底认不认这些位子」。不记录就永远不知道哪套工具在哪只票上有用，
// 所有技术判断都停留在「看起来挺像那么回事」。
//
// 纪律：
// 1. 本模块只写 symbol_assertions，绝不回写计划、仓位、告警或标注。
// 2. 判定参数随记录冻结，日后调参不改写历史成绩。
// 3. 冻结全程走已有的确定性算法，零 token。

// 判定参数统一取自 shared：界面要逐字说清遵循率的口径，两边各留一份必然会说谎
/** 观察窗口（自然日）。超过还没触及即判 untouched */
const HORIZON_DAYS = ASSERTION_HORIZON_DAYS;
/** 点位触及后给多少根 bar 观察反应 */
const REACTION_BARS = ASSERTION_REACTION_BARS;
/** 时间断言的容差（bar 数） */
const TOLERANCE_BARS = ASSERTION_TOLERANCE_BARS;
/** 冻结用的周期。日线是决策主周期，先只做这一档，攒够样本再谈扩展 */
const FREEZE_PERIOD: KlinePeriod = 'day';
/** 取多少根线做冻结与结算 */
const BARS_LIMIT = 260;

/**
 * 报遵循率所需的最小样本。低于此数只显示计数不显示比率——
 * Wilson 下界虽然已经能压住小样本的虚高，但 3 笔 3 胜显示「100%（下界 44%）」
 * 仍会先入为主，不如干脆不给比率。
 */
export const MIN_SAMPLE = 10;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 常驻跟踪的大盘指数。
 *
 * 加进来有两个理由。其一，判大盘是判个股的前提——先定大盘节奏再看板块，
 * 是这套打法本来的顺序，只跟三只 ETF 等于把定调那一层整个漏掉。
 * 其二，共振假说（多个标的的时间位指向同一窗口更可信）**必须有足够多的独立标的才检验得了**：
 * 实测只跟 3 只时，111 条已判定断言里几乎全被归为「共振」，单标的只剩 3 条，比不出差异。
 *
 * secid 必须显式给。指数 6 位码与个股撞码（000001 既是上证指数也是平安银行），
 * 而取数链首位的 mootdx 忽略 secid、只把 code 当 symbol——靠 code 解析必然取错标的。
 * 定义复用 decision/indices.ts 的白名单，不另起一张表。
 */
const TRACKED_INDEX_KEYS = ['SSEC', 'SZSE', 'CHINEXT', 'CSI1000'] as const;

/**
 * 跟踪范围：常驻大盘指数 + 驾驶舱关注标的。
 *
 * 刻意不含 watchlist（自选镜像实测 487 条，是全量同步不是精选池），也不含活跃计划标的。
 * 试过放宽：351 只标的回补 60 天就产出 14.8 万条断言，收盘任务每天要打近千次上游，
 * 攒出来的统计还全是你根本不跟的票。样本量不是这个账本的瓶颈，可维护性才是。
 */
export function trackedCodes(): Array<{ code: string; secid: string | null }> {
  const focus = listFocus()
    // 板块仍不纳入：BKxxxx 的 secid 来源不统一，冻结时拿不到就只能记成 unjudgeable
    .filter((f) => /^\d{6}$/.test(f.code))
    .map((f) => ({ code: f.code, secid: null as string | null }));
  const indices = TRACKED_INDEX_KEYS.map((key) => {
    const def = resolveIndex(key);
    // 白名单里查不到就直接跳过，绝不退回 secid=null——那会撞成同码个股，
    // 把平安银行的 K 线记成上证指数的断言，比缺数据更糟
    return def ? { code: def.secid.split('.')[1], secid: def.secid } : null;
  }).filter((x): x is { code: string; secid: string } => x !== null);
  const indexCodes = new Set(indices.map((i) => i.code));
  return [...indices, ...focus.filter((f) => !indexCodes.has(f.code))];
}

/**
 * 被指数挤掉的关注标的（正常为空）。
 *
 * 指数 6 位码与个股撞码，最现实的一例是 000001——既是上证指数也是平安银行。
 * 账本的语义唯一索引是 (code, as_of, period, source, kind, evidence_ref)，**不含 secid**，
 * 两个标的没法共存在同一个 code 下；更麻烦的是按 code 切片的遵循率会把两者混成一个统计。
 * 所以 trackedCodes 让指数优先、丢掉同码的关注标的——两害相权，但**绝不能是静默的**：
 * 用户明明把平安银行加进了关注，账本里却一条都没有，不给出口就只能靠猜。
 *
 * 要真正同时跟踪两者，得把 secid 并入那个唯一索引，那是另一件事。
 */
export function shadowedFocusCodes(): string[] {
  const indexCodes = new Set(
    TRACKED_INDEX_KEYS.map((k) => resolveIndex(k)?.secid.split('.')[1]).filter(Boolean),
  );
  return listFocus()
    .filter((f) => indexCodes.has(f.code))
    .map((f) => `${f.code}（${f.name}）`);
}

/** 大级别周期，供波浪的两层计数用 */
const MAJOR_PERIOD: KlinePeriod = 'week';

/**
 * 从**已取好的 K 线**算出当日的全部待冻结断言。纯函数，不取数。
 *
 * 拆出来是为了让历史回补能「每只标的只取一次线，再按日切片重算」——
 * 直接循环 freezeOne 会变成「标的数 × 天数 × 每次 4~5 次取数」，
 * 实测 3 只标的回补 15 天就跑了十分钟还没完，上游也扛不住。
 *
 * 刻意不给波浪传子浪细分数据：断言只用到见顶/见底位、失效价与时间位，
 * 细分结果一条断言都不产出，为它多取一次线纯属浪费。
 */
export function computeDrafts(input: {
  code: string;
  bars: KlineBar[];
  majorBars: KlineBar[];
}): { drafts: ReturnType<typeof collectAssertions>; atr: number | null; close: number | null } {
  const { code, bars, majorBars } = input;
  if (bars.length < 30) return { drafts: [], atr: null, close: null };
  const elliott = buildAnalysis(
    code,
    bars,
    FREEZE_PERIOD,
    majorBars.length ? majorBars : null,
    majorBars.length ? MAJOR_PERIOD : null,
  );
  const levels = computeLevels(code, bars, FREEZE_PERIOD);
  const chan = computeChanStructure(bars, FREEZE_PERIOD);
  const swings = detectSwings(bars, FREEZE_PERIOD);
  return {
    drafts: collectAssertions({ elliott, levels, chan, swings, period: FREEZE_PERIOD, bars }),
    atr: levels.atr,
    close: levels.close || null,
  };
}

/** 把一批草稿冻结落库，返回写入条数 */
export function persistDrafts(
  code: string,
  secid: string | null,
  asOf: string,
  drafts: ReturnType<typeof collectAssertions>,
  atr: number | null,
  close: number | null,
): number {
  // 没有 ATR 就没有反应幅度的判据，整批放弃好过记一堆判不了的
  if (!atr || atr <= 0) return 0;
  const now = nowIso();
  const dueDate = addDays(asOf, HORIZON_DAYS);
  let written = 0;
  // 整批包一个事务：逐条 insert 会各自触发一次 fsync，回补上万条时这是数量级的差别
  db.transaction(() => {
    for (const d of drafts) {
      db.insert(schema.symbolAssertions)
        .values({
        id: newId(),
        code,
        secid,
        asOf,
        // 逐条落各自的周期：结算侧靠它决定取哪套 K 线，一律填主周期就会拿日线判周线
        period: d.period ?? FREEZE_PERIOD,
        kind: d.kind,
        source: d.source,
        statement: d.statement,
        price: d.price,
        priceHigh: d.priceHigh,
        windowFrom: d.windowFrom,
        windowTo: d.windowTo,
        direction: d.direction,
        atrSnapshot: atr,
        closeSnapshot: close,
        reactionBars: REACTION_BARS,
        toleranceBars: TOLERANCE_BARS,
        // 时间断言自带到期日（要等窗口 + 容差 + 确认根数走完），点位断言走统一观察窗
        dueDate: d.dueDate ?? dueDate,
        outcome: null,
        settledAt: null,
        settleNote: null,
        evidenceRef: d.evidenceRef,
          createdAt: now,
        })
        // 同日重跑不灌重：唯一索引 (code, asOf, period, source, kind, evidenceRef)
        .onConflictDoNothing()
        .run();
      written += 1;
    }
  });
  return written;
}

/** 取一只标的的日线与周线（供冻结与回补共用） */
export async function fetchSeries(
  code: string,
  secid: string | null,
): Promise<{ bars: KlineBar[]; majorBars: KlineBar[] }> {
  // 带 secid 时 code 不能一起送进取数：astockdata 忽略 secid、只认 code，
  // 会让指数命中同码个股（与 market/elliott.ts、market/levels.ts 同一条约定）
  const fetchCode = secid ? '' : code;
  const [bars, majorBars] = await Promise.all([
    getKline(fetchCode, FREEZE_PERIOD, BARS_LIMIT, secid ?? undefined).catch(() => [] as KlineBar[]),
    getKline(fetchCode, MAJOR_PERIOD, BARS_LIMIT, secid ?? undefined).catch(() => [] as KlineBar[]),
  ]);
  return { bars, majorBars };
}

/** 冻结一只标的当日的全部断言，返回写入条数 */
export async function freezeOne(
  code: string,
  secid: string | null,
  asOf: string,
): Promise<number> {
  const { bars, majorBars } = await fetchSeries(code, secid);
  const { drafts, atr, close } = computeDrafts({ code, bars, majorBars });
  return persistDrafts(code, secid, asOf, drafts, atr, close);
}

/** 冻结全部跟踪标的 */
export async function freezeAll(asOf = shanghaiToday()): Promise<{
  codes: number;
  written: number;
  failed: number;
}> {
  const targets = trackedCodes();
  let written = 0;
  let failed = 0;
  for (const t of targets) {
    try {
      written += await freezeOne(t.code, t.secid, asOf);
    } catch {
      failed += 1;
    }
  }
  return { codes: targets.length, written, failed };
}

/**
 * 历史回补：每只标的只取一次线，按日切片重算。
 *
 * 切片而不是重新取数，是这个函数存在的全部理由——账本刚建时一条样本都没有，
 * 光看空表判断不了统计是否可信，而逐日重新取数慢到不可用。
 */
export async function backfill(
  days: string[],
  onProgress?: (msg: string) => void,
  codes?: Array<{ code: string; secid: string | null }>,
): Promise<{ codes: number; written: number }> {
  const targets = codes ?? trackedCodes();
  let written = 0;
  for (const t of targets) {
    const { bars, majorBars } = await fetchSeries(t.code, t.secid);
    if (bars.length < 30) {
      onProgress?.(`${t.code} K 线不足，跳过`);
      continue;
    }
    for (const day of days) {
      // 切到「该交易日收盘时能看到的数据」，绝不能带上未来的 bar——
      // 那等于拿后来的走势去生成当时的判断，回补出来的成绩全是作弊
      const slice = bars.filter((b) => b.time.slice(0, 10) <= day);
      const majorSlice = majorBars.filter((b) => b.time.slice(0, 10) <= day);
      if (slice.length < 30) continue;
      const { drafts, atr, close } = computeDrafts({ code: t.code, bars: slice, majorBars: majorSlice });
      written += persistDrafts(t.code, t.secid, day, drafts, atr, close);
    }
    onProgress?.(`${t.code} 回补完成，累计写入 ${written} 条`);
  }
  return { codes: targets.length, written };
}

/** 未判定的断言 */
function listPending() {
  return db
    .select()
    .from(schema.symbolAssertions)
    .where(isNull(schema.symbolAssertions.outcome))
    .all();
}

/** 结算全部到期或已走出结果的断言 */
export async function settleDue(): Promise<{
  checked: number;
  settled: Record<string, number>;
}> {
  const pending = listPending();
  const today = shanghaiToday();
  const settled: Record<string, number> = {
    respected: 0,
    violated: 0,
    untouched: 0,
    unjudgeable: 0,
  };
  // 同一标的的多条断言共用一份 K 线，逐条取会把一天几十条变成几十次回源
  const barsOf = new Map<string, KlineBar[] | null>();
  // 判定结果先攒着最后一次性写：逐条 update 各自 fsync，回补出的上万条会跑到天荒地老
  const writes: Array<{ id: string; outcome: string }> = [];
  for (const a of pending) {
    /**
     * 缓存键必须带上周期。
     *
     * 取线用的是 `a.period`，键却只有 code+secid 的话，同一标的第一条断言取到什么周期，
     * 后面所有条就共用那套 K 线——日线断言拿周线判、或者反过来。
     * 目前全部断言都是日线所以没暴露，一旦引入周线断言当天就会静默判错。
     */
    const key = `${a.code}|${a.secid ?? ''}|${a.period}`;
    if (!barsOf.has(key)) {
      try {
        const fetchCode = a.secid ? '' : a.code;
        barsOf.set(
          key,
          await getKline(fetchCode, a.period as KlinePeriod, BARS_LIMIT, a.secid ?? undefined),
        );
      } catch {
        barsOf.set(key, null);
      }
    }
    const all = barsOf.get(key);
    // 空数组同样是「这次取不到数」：放过去会让判定窗为空、到期即判 untouched，
    // 把一次上游故障记成「价格没走到」
    if (!all || all.length === 0) continue;
    const bars = barsAfter(all, a.asOf);
    if (bars.length === 0) continue;

    let outcome: ReturnType<typeof judgeLevel> = null;
    if (a.kind === 'level') {
      if (a.price == null || a.direction == null || !a.atrSnapshot) {
        markUnjudgeable(a.id, '缺价位/方向/ATR 快照，判不了');
        settled.unjudgeable += 1;
        continue;
      }
      outcome = judgeLevel(
        bars,
        a.price,
        a.direction as 'up' | 'down',
        a.atrSnapshot,
        a.reactionBars ?? REACTION_BARS,
        a.dueDate,
        today,
      );
    } else {
      if (!a.windowFrom || !a.windowTo) {
        markUnjudgeable(a.id, '缺预测窗口，判不了');
        settled.unjudgeable += 1;
        continue;
      }
      outcome = judgeTime(
        bars,
        a.period as KlinePeriod,
        a.windowFrom,
        a.windowTo,
        a.toleranceBars ?? TOLERANCE_BARS,
        a.dueDate,
        today,
      );
    }
    if (!outcome) continue;
    writes.push({ id: a.id, outcome });
    settled[outcome] = (settled[outcome] ?? 0) + 1;
  }
  if (writes.length > 0) {
    const at = nowIso();
    db.transaction(() => {
      for (const w of writes) {
        db.update(schema.symbolAssertions)
          .set({ outcome: w.outcome, settledAt: at })
          .where(eq(schema.symbolAssertions.id, w.id))
          .run();
      }
    });
  }
  return { checked: pending.length, settled };
}

function markUnjudgeable(id: string, note: string): void {
  db.update(schema.symbolAssertions)
    .set({ outcome: 'unjudgeable', settledAt: nowIso(), settleNote: note })
    .where(eq(schema.symbolAssertions.id, id))
    .run();
}

// ===== 统计 =====

export const SOURCE_LABEL: Record<AssertionSource, string> = {
  elliott: '波浪',
  fib: '黄金分割',
  pivot: '枢轴',
  chan: '缠论中枢',
  ma: '均线',
  dow: '道氏前高前低',
  plan: 'AI 计划情景',
};

/**
 * 由计数合成一组遵循率。
 *
 * respected + violated 才是分母：untouched 是「价格没走到那儿」，
 * 它说明不了判断对错，计进去会让远端位子被系统性判差；
 * unjudgeable 是「我们判不了」，更不该算到工具头上。
 */
function accuracyOf(
  key: string,
  label: string,
  counts: { recorded: number; respected: number; violated: number; untouched: number },
): AssertionAccuracy {
  const settled = counts.respected + counts.violated;
  const rate = settled > 0 ? counts.respected / settled : null;
  return {
    key,
    label,
    recorded: counts.recorded,
    settled,
    respected: counts.respected,
    violated: counts.violated,
    untouched: counts.untouched,
    // 样本不足时连点估计都不给：3 笔 3 胜显示 100% 会先入为主，
    // 哪怕旁边标着下界 44% 也拦不住第一眼的印象
    rate: settled >= MIN_SAMPLE ? rate : null,
    lowerBound: settled >= MIN_SAMPLE ? wilsonLowerBound(counts.respected, settled) : null,
  };
}

/** 按某一维度分组统计 */
function sliceBy(dim: AssertionSliceDim, sinceDate: string): AssertionAccuracy[] {
  const col =
    dim === 'source'
      ? schema.symbolAssertions.source
      : dim === 'kind'
        ? schema.symbolAssertions.kind
        : dim === 'code'
          ? schema.symbolAssertions.code
          : schema.symbolAssertions.period;
  const rows = db
    .select({
      key: col,
      recorded: sql<number>`count(*)`,
      respected: sql<number>`sum(case when outcome = 'respected' then 1 else 0 end)`,
      violated: sql<number>`sum(case when outcome = 'violated' then 1 else 0 end)`,
      untouched: sql<number>`sum(case when outcome = 'untouched' then 1 else 0 end)`,
    })
    .from(schema.symbolAssertions)
    .where(gte(schema.symbolAssertions.asOf, sinceDate))
    .groupBy(col)
    .all();
  return rows
    .map((r) =>
      accuracyOf(String(r.key), labelOf(dim, String(r.key)), {
        recorded: Number(r.recorded ?? 0),
        respected: Number(r.respected ?? 0),
        violated: Number(r.violated ?? 0),
        untouched: Number(r.untouched ?? 0),
      }),
    )
    // 有比率的排前面并按下界降序：下界才是「保守估计有多好」，按点估计排会让 3 笔 3 胜排第一
    .sort((a, b) => (b.lowerBound ?? -1) - (a.lowerBound ?? -1) || b.settled - a.settled);
}

function labelOf(dim: AssertionSliceDim, key: string): string {
  if (dim === 'source') return SOURCE_LABEL[key as AssertionSource] ?? key;
  if (dim === 'kind') return key === 'level' ? '点位' : '时间';
  return key;
}

/** AI 计划情景预测的统计，口径与断言不同（hit/miss/timeout），故单列 */
function scenarioStats(sinceDate: string) {
  const r = db
    .select({
      recorded: sql<number>`count(*)`,
      settled: sql<number>`sum(case when outcome in ('hit','miss','timeout') then 1 else 0 end)`,
      hit: sql<number>`sum(case when outcome = 'hit' then 1 else 0 end)`,
    })
    .from(schema.symbolPlanForecasts)
    .where(gte(schema.symbolPlanForecasts.createdAt, sinceDate))
    .get();
  const settled = Number(r?.settled ?? 0);
  const hit = Number(r?.hit ?? 0);
  return {
    recorded: Number(r?.recorded ?? 0),
    settled,
    hit,
    rate: settled >= MIN_SAMPLE ? hit / settled : null,
    lowerBound: settled >= MIN_SAMPLE ? wilsonLowerBound(hit, settled) : null,
  };
}

/** 战绩总览 */
export function buildReport(sinceDate: string): AssertionAccuracyReport {
  const range = db
    .select({
      from: sql<string>`min(as_of)`,
      to: sql<string>`max(as_of)`,
      recorded: sql<number>`count(*)`,
      respected: sql<number>`sum(case when outcome = 'respected' then 1 else 0 end)`,
      violated: sql<number>`sum(case when outcome = 'violated' then 1 else 0 end)`,
      untouched: sql<number>`sum(case when outcome = 'untouched' then 1 else 0 end)`,
    })
    .from(schema.symbolAssertions)
    .where(gte(schema.symbolAssertions.asOf, sinceDate))
    .get();
  return {
    fromDate: range?.from ?? null,
    toDate: range?.to ?? null,
    overall: accuracyOf('overall', '全部判断', {
      recorded: Number(range?.recorded ?? 0),
      respected: Number(range?.respected ?? 0),
      violated: Number(range?.violated ?? 0),
      untouched: Number(range?.untouched ?? 0),
    }),
    slices: {
      source: sliceBy('source', sinceDate),
      kind: sliceBy('kind', sinceDate),
      code: sliceBy('code', sinceDate),
      period: sliceBy('period', sinceDate),
    },
    scenario: scenarioStats(sinceDate),
    note:
      `价位类与时间类分开看：前者问「这条线管不管用」，后者问「转折是不是落在预测的那几天」，合成一个数会互相拖累。` +
      `说准率分母只含已判定的记录（触及并观察完反应），没走到和判不了的不计入。` +
      `样本满 ${MIN_SAMPLE} 笔才给比率，并同时给出 Wilson 95% 置信下界——` +
      `点估计在小样本下极不可靠，下界才是「保守估计至少有多好」。`,
  };
}

/**
 * 某个来源在某只标的上的历史成绩。供详情页把统计挂到具体价位旁边，
 * 以及第三期回流到候选排序时取权重。
 *
 * `kind` 必须能过滤。波浪这个来源同时产出点位断言与时间断言，两者衡量的完全是两件事
 * （「这个价位管不管用」对「转折是否落在预测的那几天」）。不过滤就会混在一起：
 * 实测波浪来源 level 219 笔 48.4%、time 171 笔 43.9%，而详情页把这个混合数挂在价位旁边，
 * 说的其实不是那条线准不准。其余来源没有时间断言，加不加过滤都一样。
 */
export function accuracyOfSource(
  source: AssertionSource,
  code?: string,
  kind?: AssertionKind,
): AssertionAccuracy {
  const conds = [eq(schema.symbolAssertions.source, source)];
  if (code) conds.push(eq(schema.symbolAssertions.code, code));
  if (kind) conds.push(eq(schema.symbolAssertions.kind, kind));
  const r = db
    .select({
      recorded: sql<number>`count(*)`,
      respected: sql<number>`sum(case when outcome = 'respected' then 1 else 0 end)`,
      violated: sql<number>`sum(case when outcome = 'violated' then 1 else 0 end)`,
      untouched: sql<number>`sum(case when outcome = 'untouched' then 1 else 0 end)`,
    })
    .from(schema.symbolAssertions)
    .where(and(...conds))
    .get();
  return accuracyOf(source, SOURCE_LABEL[source] ?? source, {
    recorded: Number(r?.recorded ?? 0),
    respected: Number(r?.respected ?? 0),
    violated: Number(r?.violated ?? 0),
    untouched: Number(r?.untouched ?? 0),
  });
}

/** 全部来源在某标的上的遵循率，供详情页一次取齐 */
/**
 * 各来源在某标的上的历史成绩。
 *
 * 固定只统计**点位**断言：这个函数的两个消费方（详情页把百分比挂在价位旁边、
 * agent 提示行）问的都是「这条价位线管不管用」，把时间断言混进来答的是另一个问题。
 */
export function accuracyBySource(code?: string): AssertionAccuracy[] {
  return (Object.keys(SOURCE_LABEL) as AssertionSource[])
    .filter((s) => s !== 'plan')
    .map((s) => accuracyOfSource(s, code, 'level'));
}

/**
 * 给 agent 的一行历史遵循率提示（第三期回流的 prompt 层）。
 *
 * 只回流到「提示」这一层，不动候选排序：排序加权会让统计直接改变决策链路，
 * 而这套账本自己的样本量目前还不足以承担那个角色。样本不足的来源直接不写，
 * 让模型看到「没数据」而不是一个虚高的比率。
 */
export function accuracyHintLine(code: string): string {
  const parts = accuracyBySource(code)
    .filter((a) => a.rate != null)
    .map((a) => `${a.label} ${(a.rate! * 100).toFixed(0)}%(${a.settled}笔)`);
  if (parts.length === 0) return '';
  return (
    `【本标的各技术层历史说准率】${parts.join(' / ')}` +
    `（算法：该层给出的价位被触及后，是否在 5 根 K 线内走出 ≥1ATR 的反向反应；仅供挑候选时权衡，不改变候选评分）`
  );
}

/** 下钻：列出断言明细 */
export function listAssertions(filter: {
  code?: string;
  source?: string;
  kind?: string;
  /** 必须支持：战绩页按周期维度下钻会传它，不认的话会返回全量却标着该周期的名字 */
  period?: string;
  outcome?: string;
  limit?: number;
}): SymbolAssertion[] {
  const conds = [];
  if (filter.period) conds.push(eq(schema.symbolAssertions.period, filter.period));
  if (filter.code) conds.push(eq(schema.symbolAssertions.code, filter.code));
  if (filter.source) conds.push(eq(schema.symbolAssertions.source, filter.source));
  if (filter.kind) conds.push(eq(schema.symbolAssertions.kind, filter.kind));
  if (filter.outcome) conds.push(eq(schema.symbolAssertions.outcome, filter.outcome));
  const rows = db
    .select()
    .from(schema.symbolAssertions)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.symbolAssertions.asOf), desc(schema.symbolAssertions.createdAt))
    .limit(Math.min(500, Math.max(1, filter.limit ?? 100)))
    .all();
  return rows as unknown as SymbolAssertion[];
}
