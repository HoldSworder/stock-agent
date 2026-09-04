import { and, eq, gte } from 'drizzle-orm';
import {
  ASSERTION_TOLERANCE_BARS,
  type TurningCalendar,
  type TurningExpect,
  type TurningHitRate,
  type TurningLevel,
  type TurningSection,
  type TurningPointEntry,
  type TurningPointItem,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { wilsonLowerBound } from '../strategy/promotionGate';
import { prevTradingDay, shiftTradingDays } from '../market/calendar';
import { listFocus } from '../cockpit/focus';
import { INDEX_DEFS } from '../decision/indices';
import { shanghaiToday } from '../util';
import { accuracyBySource, SOURCE_LABEL } from './service';
import { isDeadTimeAssertion } from './extract';

// 转折日历：把账本里的时间断言按预测日摊开。
//
// 立项理由是一次实测复盘。系统在 2026-08-20 就冻结了「159516 预测 2026-08-25 走完当前浪」，
// 8/25 实际最低 0.682 正是那一波的低点——**日期是对的，但没有任何页面展示过它**。
// 能力一直在，缺的只是出口。
//
// 纪律：本模块只读 symbol_assertions，不产生新的技术计算。日期、方向、容差全部
// 取自冻结时落库的值，改这里的展示逻辑不会改写历史成绩。

/** 默认往后看多少个自然日 */
const DEFAULT_DAYS = 20;

/** 由当前浪方向推预期转折：向上推进的浪走完即见高，向下走完即见低 */
function expectOf(direction: string | null): TurningExpect {
  if (direction === 'up') return 'high';
  if (direction === 'down') return 'low';
  return 'unknown';
}

/**
 * 标的中文名：关注标的取备注名，指数走白名单，都没有就回退代码。
 *
 * 指数**后写、优先**，必须与 trackedCodes 的取舍一致。早先关注标的后写覆盖指数名，
 * 结果是：撞码时（000001 既是上证指数也是平安银行）账本里记的是带 secid 的指数，
 * 页面却显示「平安银行」——名字和数据对不上，比缺名字糟得多。
 */
function labelMap(): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of listFocus()) m.set(f.code, f.name);
  for (const d of INDEX_DEFS) m.set(d.secid.split('.')[1], d.name);
  return m;
}

/**
 * 连续指向天数：从最近一次冻结日往回数，相邻两次必须是相邻交易日才算连着。
 *
 * 不能简单数「有多少个冻结日提过这个窗口」。中间断掉说明系统改过口又绕回来，
 * 那和一路咬定同一个日期不是一回事，可信度差着量级。
 *
 * 导出是为了让体检脚本的分档统计用**同一个函数**。踩过一次：脚本那边用
 * `new Set(asOf).size`（出现过几天）跑出 20%/57%，界面显示的却是本函数的连续天数，
 * 等于拿 A 的统计给 B 定阈值、还把数字印在页面上。
 */
export function streakOf(asOfList: string[]): number {
  const days = [...new Set(asOfList)].sort().reverse();
  let n = 1;
  for (let i = 1; i < days.length; i += 1) {
    if (prevTradingDay(days[i - 1]) !== days[i]) break;
    n += 1;
  }
  return n;
}

/**
 * 时间位到目前为止的实测成绩，跟日历一起交出去。
 *
 * 不看未来窗口那批（它们还没到期），统计的是**全部已判定**的时间断言。
 * 剔除停产的 161.8% 档：那一档已经不再产出，把它算进来等于用一个不会再出现的
 * 坏样本压低现行口径的成绩。
 */
/** 把「命中数 / 样本数」包成一组统计 */
function hitRateOf(hit: number, settled: number): TurningHitRate {
  return {
    settled,
    hit,
    rate: settled > 0 ? hit / settled : null,
    lowerBound: settled > 0 ? wilsonLowerBound(hit, settled) : null,
  };
}

/**
 * @param period 只统计这个周期的成绩。不传则合计。
 *   **必须能分开算**：日线攒了两个多月、周线刚开始记，把它们并在一起，
 *   周线区块就会顶着日线的成绩显示，等于让一个还没有样本的档蹭别人的分。
 */
function reliabilityOf(asOf: string, period?: string): TurningCalendar['reliability'] {
  const settledRows = db
    .select({
      code: schema.symbolAssertions.code,
      period: schema.symbolAssertions.period,
      windowFrom: schema.symbolAssertions.windowFrom,
      asOf: schema.symbolAssertions.asOf,
      dueDate: schema.symbolAssertions.dueDate,
      outcome: schema.symbolAssertions.outcome,
      evidenceRef: schema.symbolAssertions.evidenceRef,
    })
    .from(schema.symbolAssertions)
    .where(eq(schema.symbolAssertions.kind, 'time'))
    .all()
    .filter(
      (r) =>
        (r.outcome === 'respected' || r.outcome === 'violated') &&
        /**
         * 回放时必须双重截断：冻结日在基准日之前**且到期日也已经走完**。
         *
         * 只卡冻结日不够——一条 7 月冻结、9 月才到期的记录，它的结局是 9 月才知道的。
         * 回放 7 月时把它算进成绩，等于拿后来的走势给当时的自己打分。
         */
        r.asOf <= asOf &&
        r.dueDate <= asOf &&
        (period == null || r.period === period) &&
        !isDeadTimeAssertion(r.evidenceRef),
    );

  /**
   * 事件级去重：同一标的、同一周期、对同一天的预测，连着记多少天都只算一次。
   *
   * 不去重的话证据量会被夸大——实测 141 条记录只对应 55 个独立预测。
   * 而且重复次数与「连续几天没改口」正相关，正是界面用来分强弱的那个指标，
   * 不去重就等于让强信号在统计里自己给自己加权。
   *
   * 同一预测在不同冻结日偶尔会判出不同结局（实测 55 个里有 5 个），
   * 取「只要有一次判对就算对」——那几次记的本来就是同一个判断。
   */
  const byEvent = new Map<string, boolean>();
  for (const r of settledRows) {
    const key = `${r.code}|${r.period}|${r.windowFrom}`;
    byEvent.set(key, (byEvent.get(key) ?? false) || r.outcome === 'respected');
  }

  return {
    events: hitRateOf([...byEvent.values()].filter(Boolean).length, byEvent.size),
    records: hitRateOf(
      settledRows.filter((r) => r.outcome === 'respected').length,
      settledRows.length,
    ),
  };
}

/** 每侧最多给几档。给太多会让人以为证据很厚，其实都是同一批算法的不同参数 */
const LEVELS_PER_SIDE = 2;

/** 两档价格贴到这个程度就算同一档，合并只留更靠前的那个来源 */
const SAME_LEVEL_PCT = 0.004;

/** 某标的各来源的历史成绩，取一次缓存复用 */
function sourceRates(code: string): Map<string, { rate: number | null; settled: number }> {
  const m = new Map<string, { rate: number | null; settled: number }>();
  for (const a of accuracyBySource(code)) m.set(a.key, { rate: a.rate, settled: a.settled });
  return m;
}

/**
 * 某标的在某个记录日附近的已知价位，按距当时收盘价由近及远，上下各取几档。
 *
 * 用当时的 `closeSnapshot` 分上下，**不用 direction**：道氏来源的方向按「前高/前低」写死，
 * 与它相对现价的位置无关，实测 16% 的道氏记录方向与实际位置相反。
 *
 * 数据全部取自已经记录下来的价位，本函数不做任何技术计算——这是本模块的纪律。
 */
function nearbyLevels(
  code: string,
  asOf: string,
  rates: Map<string, { rate: number | null; settled: number }>,
): { above: TurningLevel[]; below: TurningLevel[] } {
  const rows = db
    .select({
      price: schema.symbolAssertions.price,
      close: schema.symbolAssertions.closeSnapshot,
      source: schema.symbolAssertions.source,
      statement: schema.symbolAssertions.statement,
    })
    .from(schema.symbolAssertions)
    .where(
      and(
        eq(schema.symbolAssertions.code, code),
        eq(schema.symbolAssertions.asOf, asOf),
        eq(schema.symbolAssertions.kind, 'level'),
      ),
    )
    .all();
  const close = rows.find((r) => r.close != null)?.close ?? null;
  // 旧记录没存收盘价，分不出上下，宁可不给也不猜
  if (close == null || !(close > 0)) return { above: [], below: [] };

  const pick = (side: 'above' | 'below'): TurningLevel[] => {
    const cand = rows
      .filter((r) => r.price != null && (side === 'above' ? r.price > close : r.price < close))
      .sort((a, b) => (side === 'above' ? a.price! - b.price! : b.price! - a.price!));
    const out: TurningLevel[] = [];
    for (const r of cand) {
      // 几乎同价的两档不重复列：那不是两份独立证据，只会让人高估把握
      if (out.some((x) => Math.abs(x.price - r.price!) / close < SAME_LEVEL_PCT)) continue;
      const acc = rates.get(r.source);
      out.push({
        price: r.price!,
        source: SOURCE_LABEL[r.source as keyof typeof SOURCE_LABEL] ?? r.source,
        detail: r.statement,
        rate: acc?.rate ?? null,
        settled: acc?.settled ?? 0,
      });
      if (out.length >= LEVELS_PER_SIDE) break;
    }
    return out;
  };
  return { above: pick('above'), below: pick('below') };
}

/** 今天到目标日之间隔几个交易日；目标日在过去返回 0 */
function tradingGap(from: string, to: string): number {
  if (to <= from) return 0;
  let n = 0;
  let cur = from;
  // 上限与 DEFAULT_DAYS 同量级，够用且不会因脏数据空转
  while (cur < to && n < 400) {
    cur = shiftTradingDays(cur, 1);
    n += 1;
  }
  return n;
}

/**
 * 未来 days 个自然日内的转折日历。
 *
 * @param days 往后看多少个自然日
 * @param asOf 基准日，回放历史用（自检据此重现「8/20 那天系统说了什么」）
 */
export function buildCalendar(days = DEFAULT_DAYS, asOf = shanghaiToday()): TurningCalendar {
  const toDate = addDays(asOf, days);
  const rows = db
    .select()
    .from(schema.symbolAssertions)
    .where(
      and(
        eq(schema.symbolAssertions.kind, 'time'),
        gte(schema.symbolAssertions.windowFrom, asOf),
      ),
    )
    .all()
    .filter(
      (r) =>
        // 回放时必须滤掉基准日之后才冻结的记录，否则等于拿后来的判断回答「当时说了什么」
        r.asOf <= asOf &&
        r.windowFrom != null &&
        r.windowFrom <= toDate &&
        // 161.8% 档已在 extract 停止登记，但存量记录还躺在库里。
        // 不在这里一并滤掉的话，一个实测 26% 命中率的日期还会在日历上挂三周
        !isDeadTimeAssertion(r.evidenceRef),
    );

  const names = labelMap();
  /**
   * 每只标的截至基准日最后一次冻结是哪天。
   *
   * 用它判断一条预测是否已被改口：如果该标的后来又冻结过、而那次冻结里
   * 不再提这个日期，这条就是旧说法了。实测踩过——159516 同时挂在 8/26 与 9/1，
   * 8/26 那条早被当天的冻结取代，页面却还标着「已连续 2 天没改口」。
   *
   * 口径刻意取「**最新一次分析有没有再提它**」，而不是「有没有被新预测顶掉」。
   *
   * 两者的差别在周线上很要命：实测证券ETF天弘有一条周线预测最后更新停在 7/23，
   * 此后周线分析一直给不出结果。若按「同周期是否又产出过」判，它永远等不到被推翻，
   * 于是顶着「已连续 15 天没改口」的强信号在页面上挂了一个多月。
   * 而对读者来说，「系统改了口」和「系统这阵子算不出来」没有区别——都是没被重申。
   *
   * 另外两条：
   * 1. 必须从**完整记录**算，不能用上面那批已按 windowFrom 过滤过的 rows。否则最新预测
   *    一旦跳到展示窗口之外，这里看不见那次分析，旧预测会被继续当成活跃的。
   * 2. 不能只看 kind='time'。分析跑通但走势不清晰时那天一条时间预测都不产出——
   *    实测 159516 在 8/03~8/06 每天都写了 19~20 条、时间预测 0 条。那同样是没再提。
   */
  const lastFreezeOf = new Map<string, string>();
  for (const r of db
    .select({ code: schema.symbolAssertions.code, asOf: schema.symbolAssertions.asOf })
    .from(schema.symbolAssertions)
    .all()) {
    if (r.asOf > asOf) continue;
    const prev = lastFreezeOf.get(r.code);
    if (!prev || r.asOf > prev) lastFreezeOf.set(r.code, r.asOf);
  }

  /**
   * 按 (预测日, 标的, **周期**) 收拢。
   *
   * 周期不能漏：同一标的可能在同一天既有日线预测又有周线预测，两者是完全独立的判断，
   * 合并会把它们的连续天数、方向搅在一起。
   */
  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.windowFrom}|${r.code}|${r.period}`;
    const arr = byKey.get(key);
    if (arr) arr.push(r);
    else byKey.set(key, [r]);
  }

  const levelCache = new Map<string, ReturnType<typeof nearbyLevels>>();
  // 各来源的历史成绩按标的取一次就够，逐条查会打出上百次同步 SQL
  const accCache = new Map<string, Map<string, { rate: number | null; settled: number }>>();

  const byDate = new Map<string, TurningPointItem[]>();
  for (const [key, group] of byKey) {
    const [date, , period] = key.split('|');
    // 取最近一次记录的那条做展示：波浪编号会变，以系统最新的说法为准
    const latest = [...group].sort((a, b) => (a.asOf < b.asOf ? 1 : -1))[0];
    // 只有日线级附近才挂价位：这些价位的观察窗只有 20 天，绑不到一两个月后的周线日期
    const lvKey = `${latest.code}|${latest.asOf}`;
    if (period === 'day' && !levelCache.has(lvKey)) {
      if (!accCache.has(latest.code)) accCache.set(latest.code, sourceRates(latest.code));
      levelCache.set(lvKey, nearbyLevels(latest.code, latest.asOf, accCache.get(latest.code)!));
    }
    const lv = period === 'day' ? levelCache.get(lvKey) : undefined;
    const item: TurningPointItem = {
      code: latest.code,
      secid: latest.secid,
      period: latest.period as TurningPointItem['period'],
      label: names.get(latest.code) ?? latest.code,
      asOf: latest.asOf,
      statement: latest.statement,
      expect: expectOf(latest.direction),
      streak: streakOf(group.map((g) => g.asOf)),
      // 该标的后来又分析过、却没再提这个日期 = 最新一次分析没有重申它
      superseded: latest.asOf < (lastFreezeOf.get(latest.code) ?? latest.asOf),
      above: lv?.above ?? [],
      below: lv?.below ?? [],
    };
    const list = byDate.get(`${date}|${period}`);
    if (list) list.push(item);
    else byDate.set(`${date}|${period}`, [item]);
  }

  const built: Array<{ period: string; entry: TurningPointEntry }> = [...byDate.entries()]
    .map(([dateKey, items]) => {
      const [date, period] = dateKey.split('|');
      // 容差量纲随周期变：日线 ±3 个交易日，周线 ±3 根周线（约三周）
      const tolShift = (n: number): string =>
        period === 'day' ? shiftTradingDays(date, n) : addDays(date, n * 7);
      /**
       * 各标的对高低的判断取多数派，明细里保留各自的说法。
       *
       * 平票必须落回 unknown，不能让排序顺序替我们选一个。一高一低本来就是分歧，
       * 此时标题若言之凿凿写「见高点」，读的人不会去看明细，等于凭插入顺序编了个方向。
       */
      // 已被取代的条目不参与投票、也不抬高整条的可信度：它们只是留档
      const live = items.filter((i) => !i.superseded);
      const voters = live.length > 0 ? live : items;
      const votes = new Map<TurningExpect, number>();
      for (const it of voters) votes.set(it.expect, (votes.get(it.expect) ?? 0) + 1);
      const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
      const tied = ranked.length > 1 && ranked[0][1] === ranked[1][1];
      const expect: TurningExpect = tied ? 'unknown' : ranked[0]?.[0] ?? 'unknown';
      return {
        period,
        entry: {
          date,
          from: tolShift(-ASSERTION_TOLERANCE_BARS),
          to: tolShift(ASSERTION_TOLERANCE_BARS),
          inDays: tradingGap(asOf, date),
          expect,
          resonance: new Set(voters.map((i) => i.code)).size,
          maxStreak: Math.max(...voters.map((i) => i.streak)),
          superseded: live.length === 0,
          // 未被取代的排前面，其次连续天数多的
          items: items.sort(
            (a, b) => Number(a.superseded) - Number(b.superseded) || b.streak - a.streak,
          ),
        },
      };
    })
    .sort((a, b) => (a.entry.date < b.entry.date ? -1 : 1));

  const rel = reliabilityOf(asOf);
  /** 样本少于这个数就不给百分比：几次的比率只是噪声，摆出来反倒像个结论 */
  const MIN_EVENTS = 10;
  const section = (period: 'day' | 'week', title: string, scope: string): TurningSection => {
    const own = reliabilityOf(asOf, period);
    return {
      title,
      scope,
      toDate,
      entries: built.filter((b) => b.period === period).map((b) => b.entry),
      // 各档只报自己的成绩，绝不共用：周线刚开始记，共用就等于蹭日线两个多月攒下的分
      reliability: own,
      tooFewSamples: own.events.settled < MIN_EVENTS,
    };
  };

  return {
    asOf,
    reliability: rel,
    daily: section(
      'day',
      '短期观察（日线）',
      `未来 ${days} 天内日线级别可能出现转折的日子`,
    ),
    weekly: section(
      'week',
      '中期探索（周线）',
      '周线级别的转折，时间尺度以月计。刚开始记录，还没有成绩可供参考',
    ),
    note:
      built.length === 0
        ? '窗口内没有时间预测。波浪走势不清晰、或预测的日子都已经过去时属正常'
        : '可信度只看「连续几天没改口」——波浪编号常变、日期反而稳；' +
          '而「几只标的同时指向」实测区分不出准确率，所以不拿它当可信度',
  };
}

/** 自然日加减（窗口上界用，不涉判定口径） */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
