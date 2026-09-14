import { eq } from 'drizzle-orm';
import type {
  RotationBoard,
  RotationBoardCandidate,
  RotationBoardHolding,
  RotationSwap,
  SwingReading,
  SwingRunStatus,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { nowIso, shanghaiToday } from '../util';
import { fetchRealPositions } from '../realPositions';
import { isEtfPosition } from '../positions/discipline';
import { readLatestSnapshot } from './runner';
import { toReading } from './index';
import { buildOpportunities } from './opportunities';
import { buildMarketStance } from './marketStance';
import { getRegimeSummaryForCockpit } from '../regime/service';
import {
  archiveCoreHolding,
  evaluateCoreHolding,
  pickStructureLine,
  type CoreHoldingState,
} from './coreHolding';
import { currentRuleVersion } from './ruleVersion';

// 赛道轮动看板：驾驶舱首屏那三问。
//
//  1) 我手上这几只赛道 ETF 现在在哪一段
//  2) 有没有该走的
//  3) 有没有该进的
//
// 判断层复用 swing 的快照（背驰定级 + 关注价位），动作层走 coreHolding 的底仓规则，
// 而**不是** advice.ts 的试探仓规则——后者两周不涨就撤、赚一倍风险就减半，
// 拿它管八成仓的中线底仓等于把主升浪亲手切掉。
//
// 只读最近一份完整快照，不在请求里现场重算：一轮扫描要几分钟，
// 而且每次打开结果都不一样的话，「今天该不该动」就没有答案了。
//
// 一条底线：**默认状态是「继续拿着，什么都不用做」，并且必须被明确写出来。**
// 一年只有几次动作的打法，绝大多数天数这块都应该是空的；
// 显示成空白或「暂无数据」会让人以为系统没算，然后去别处找答案。

/** 日线为主判断：60 分钟线噪声大，看板上只用日线定动作 */
const BOARD_PERIOD = 'day';

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const r1 = (n: number): number => Math.round(n * 10) / 10;

/** 底部信号：这两级才算「该进的候选」 */
function isBottomSignal(grade: SwingReading['grade']): boolean {
  return grade === 'risk_easing_bottom' || grade === 'turn_confirmed_bottom';
}

// ===== 结构线存档的读写 =====

function readCoreState(code: string): CoreHoldingState | null {
  const row = db
    .select()
    .from(schema.swingCoreHoldings)
    .where(eq(schema.swingCoreHoldings.code, code))
    .get();
  if (!row) return null;
  return {
    structureLine: row.structureLine,
    structureBasis: row.structureBasis,
    archivedAt: row.archivedAt,
  };
}

/**
 * 落库结构线。
 *
 * 只在**线真的上移了**或首次存档时写，不是每天刷一遍——
 * 每天覆写会把 raised_at 变成「今天」，于是看不出这条线到底多久没动过。
 */
function saveCoreState(
  code: string,
  name: string,
  track: string,
  state: CoreHoldingState,
  raised: boolean,
): void {
  const now = nowIso();
  const ruleVersion = currentRuleVersion()?.version ?? '';
  db.insert(schema.swingCoreHoldings)
    .values({
      code,
      name,
      track,
      structureLine: state.structureLine,
      structureBasis: state.structureBasis,
      archivedAt: state.archivedAt,
      raisedAt: raised ? state.archivedAt : null,
      ruleVersion,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.swingCoreHoldings.code,
      set: {
        name,
        track,
        structureLine: state.structureLine,
        structureBasis: state.structureBasis,
        raisedAt: raised ? state.archivedAt : undefined,
        ruleVersion,
        updatedAt: now,
      },
    })
    .run();
}

/** 清掉已不在持仓里的存档，避免卖掉的标的留着一条线继续出现在看板上 */
function pruneCoreStates(heldCodes: Set<string>): void {
  const rows = db.select().from(schema.swingCoreHoldings).all();
  for (const row of rows) {
    if (!heldCodes.has(row.code)) {
      db.delete(schema.swingCoreHoldings).where(eq(schema.swingCoreHoldings.code, row.code)).run();
    }
  }
}

// ===== 看板拼装 =====

function toCandidate(r: SwingReading): RotationBoardCandidate {
  return {
    code: r.code,
    name: r.name,
    track: r.track,
    peerCount: r.peerCount,
    isTrackProxy: r.isTrackProxy,
    grade: r.grade,
    close: r.close,
    zone: r.zone,
    initialStop: r.initialStop,
    rationale: r.rationale,
    counterEvidence: r.counterEvidence,
  };
}

/**
 * 一只持仓的看板行。
 *
 * 没有对应快照读数时**不静默跳过**：那只票照样在账户里承担风险，
 * 漏掉它会让页面看起来「所有持仓都没问题」。这种情况给出 blockedReason。
 */
function buildHolding(
  pos: { code: string; name: string; positionRate: number; holdRate: number; price: number },
  reading: SwingReading | undefined,
  tradeDate: string,
): RotationBoardHolding {
  const base = {
    code: pos.code,
    name: pos.name,
    track: reading?.track ?? '',
    realPct: r1(pos.positionRate * 100),
    holdRatePct: r1(pos.holdRate * 100),
    close: reading?.close ?? pos.price,
  };

  if (!reading) {
    return {
      ...base,
      grade: 'none',
      structureLine: null,
      structureBasis: null,
      distanceToLinePct: null,
      action: 'hold',
      reason: '这只这轮没扫到',
      nextTrigger: '等下一轮扫描给出关注价位',
      blockedReason:
        '最近一轮扫描里没有这只，所以今天没给它算保护价。它仍在账户里，不代表没有风险',
    };
  }

  if (reading.unavailableReason) {
    return {
      ...base,
      grade: reading.grade,
      structureLine: null,
      structureBasis: null,
      distanceToLinePct: null,
      action: 'hold',
      reason: reading.unavailableReason,
      nextTrigger: '等数据齐了再判',
      blockedReason: reading.unavailableReason,
    };
  }

  // 首次纳入管理时存档结构线；已有存档则推进一步
  const existing = readCoreState(pos.code);
  if (!existing) {
    const archived = archiveCoreHolding(reading.watchLevels, reading.close, tradeDate);
    if (!archived) {
      return {
        ...base,
        grade: reading.grade,
        structureLine: null,
        structureBasis: null,
        distanceToLinePct: null,
        action: 'hold',
        reason: '现价下方还没走出可用的低点，给不出保护价',
        nextTrigger: '等它走出一个回踩低点，再据此定保护价',
        blockedReason: '现价下方没有可用的摆动低点，这只暂时没有保护价',
      };
    }
    saveCoreState(pos.code, pos.name, reading.track, archived, true);
    return {
      ...base,
      grade: reading.grade,
      structureLine: archived.structureLine,
      structureBasis: archived.structureBasis,
      distanceToLinePct: r1(((reading.close - archived.structureLine) / reading.close) * 100),
      action: 'hold',
      reason: `首次纳入管理，保护价定在 ${r3(archived.structureLine)}（${archived.structureBasis}）`,
      nextTrigger: `收盘跌破 ${r3(archived.structureLine)} 就该走`,
      blockedReason: null,
    };
  }

  const decision = evaluateCoreHolding({
    state: existing,
    // 快照存的是已收盘那一根的收盘价，这里补齐状态机需要的最低价字段。
    // 用收盘价当最低价是保守的：底仓跌破按收盘判定，本来就不看最低价
    bar: {
      time: reading.barTime ?? tradeDate,
      open: reading.close,
      high: reading.close,
      low: reading.close,
      close: reading.close,
      volume: 0,
      amount: 0,
    },
    grade: reading.grade,
    watchLevels: reading.watchLevels,
    tradeDate,
  });

  const raised = decision.next.structureLine > existing.structureLine;
  if (raised) saveCoreState(pos.code, pos.name, reading.track, decision.next, true);

  return {
    ...base,
    grade: reading.grade,
    structureLine: decision.next.structureLine,
    structureBasis: decision.next.structureBasis,
    distanceToLinePct: r1(((reading.close - decision.next.structureLine) / reading.close) * 100),
    action: decision.action,
    reason: decision.reason,
    nextTrigger: decision.nextTrigger,
    blockedReason: decision.blockedReason,
  };
}

/**
 * 换仓配对：把「该走的」和「该进的」凑成一组，并把资金先后依赖写在脸上。
 *
 * 不写先后的话，两条建议看起来可以同时执行，而账户里并没有那么多钱——
 * 到时候要么买不进，要么被迫市价卖。
 *
 * 配对刻意按顺序一对一，不做组合优化：一次换仓本来就只该动一只，
 * 同时换三只的调度复杂度换不来收益。
 */
function buildSwaps(
  exits: RotationBoardHolding[],
  entries: RotationBoardCandidate[],
  cash: RotationBoard['cash'],
): RotationSwap[] {
  const swaps: RotationSwap[] = [];
  const n = Math.min(exits.length, entries.length);
  for (let i = 0; i < n; i += 1) {
    const out = exits[i];
    const into = entries[i];
    const freedAmount =
      cash != null ? Math.round((out.realPct / 100) * cash.totalAsset) : 0;
    // 现金够买一手就不必等卖出。够不够按「这只的现价 × 100 份」估，
    // 而不是按打算买多少——后者还没定，拿它判断会得出「够」的错觉
    const needsSaleFirst = cash == null || cash.available < into.close * 100;
    swaps.push({
      out,
      into,
      freedAmount,
      needsSaleFirst,
      note: needsSaleFirst
        ? `先卖 ${out.name}，钱到账（当天卖出的钱可以当天买）之后再买 ${into.name}。` +
          `${cash == null ? '现在读不到账户现金，所以按「必须先卖」处理。' : ''}` +
          `如果卖完 ${into.name} 已经不在买入区，就拿着现金等，不用勉强换一只`
        : `现金够直接买 ${into.name}，不必等 ${out.name} 卖出；` +
          '但「买得起」不等于「该同时拿两只」，先卖再买仍是更干净的顺序',
    });
  }
  return swaps;
}

/**
 * 拼装看板。
 *
 * 取数失败一律记入 failures 并继续，不整块失败；
 * 但账户读不到时**不得按空仓处理**——那会让页面给出建仓建议，而你可能正满仓。
 */
export async function buildRotationBoard(): Promise<RotationBoard> {
  const failures: Array<{ source: string; reason: string }> = [];
  const { run, rows, running } = readLatestSnapshot();

  let runStatus: SwingRunStatus | null = null;
  if (run) {
    let runFailures: Array<{ code: string; reason: string }> = [];
    try {
      runFailures = JSON.parse(run.failures) as typeof runFailures;
    } catch {
      runFailures = [];
    }
    runStatus = {
      runId: run.id,
      tradeDate: run.tradeDate,
      mode: run.mode as SwingRunStatus['mode'],
      status: run.status as SwingRunStatus['status'],
      targetCount: run.targetCount,
      okCount: run.okCount,
      failures: runFailures,
      dataAsOf: run.dataAsOf,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  } else {
    failures.push({
      source: '波段扫描',
      reason: '还没有可用的扫描快照，先去波段观察页跑一轮',
    });
  }

  const tradeDate = run?.tradeDate ?? shanghaiToday();
  const readings = rows.filter((r) => r.period === BOARD_PERIOD).map(toReading);
  const byCode = new Map(readings.map((r) => [r.code, r]));

  // --- 持仓 ---
  let holdings: RotationBoardHolding[] = [];
  let cash: RotationBoard['cash'] = null;
  /** 账户实际总仓位 %，用于和大盘建议区间对照；读不到保持 null，不得按空仓算 */
  let actualPositionPct: number | null = null;
  const heldCodes = new Set<string>();
  try {
    const pf = await fetchRealPositions(false);
    if (pf.totalAsset > 0) {
      cash = {
        available: pf.cash,
        totalAsset: pf.totalAsset,
        cashPct: r1((pf.cash / pf.totalAsset) * 100),
      };
      // 总仓位含场外基金：对照大盘建议区间时问的是「这个账户整体压了多少」，
      // 只算场内会低估，从而把「已经偏重」说成「还能加」
      actualPositionPct = r1((pf.totalMarketValue / pf.totalAsset) * 100);
    }
    // 只管场内 ETF：这套打法就是赛道 ETF 轮动，个股不在其中，
    // 而把个股混进来会让它套上 ETF 的保护价口径
    const etfs = pf.positions.filter((p) => p.qty > 0 && isEtfPosition(p.code, p.name));
    for (const p of etfs) heldCodes.add(p.code);
    pruneCoreStates(heldCodes);
    holdings = etfs.map((p) => buildHolding(p, byCode.get(p.code), tradeDate));
    const stocks = pf.positions.filter((p) => p.qty > 0 && !isEtfPosition(p.code, p.name));
    if (stocks.length > 0) {
      failures.push({
        source: '个股持仓',
        reason:
          `账户里还有 ${stocks.length} 只个股（${stocks.map((s) => s.name).join('、')}），` +
          '这块看板只管赛道 ETF，它们请到持仓与自选页看',
      });
    }
  } catch (e) {
    failures.push({
      source: '真实持仓',
      reason:
        `账户数据没取到（${e instanceof Error ? e.message : String(e)}）。` +
        '持仓情况未知，不要当成空仓',
    });
  }

  // 该走的：按仓位从大到小，仓位越大越该先处理
  const exits = holdings
    .filter((h) => h.action !== 'hold')
    .sort((a, b) => b.realPct - a.realPct);

  // --- 机会清单：带数量的完整操作指引 ---
  // 用**全部周期**的读数（日线 + 60 分钟），由 opportunities 内部合成，一只标的一条
  const allReadings = rows.map(toReading);
  const { items: opportunities, omitted: opportunitiesOmitted } = await buildOpportunities({
    readings: allReadings,
    heldCodes,
    totalEquity: cash?.totalAsset ?? null,
  });

  // --- 换入候选：换仓配对用的简版。只取日线信号的赛道代表，
  //     因为换仓是真金白银的动作，不能凭 60 分钟的提前量就把底仓换掉 ---
  const entries = readings
    .filter((r) => r.isTrackProxy && !heldCodes.has(r.code) && isBottomSignal(r.grade))
    .sort((a, b) => (b.divergenceStrength ?? 0) - (a.divergenceStrength ?? 0))
    .map(toCandidate);

  return {
    run: runStatus,
    scanning: running,
    market: buildMarketStance(readRegimeSafely(failures), actualPositionPct),
    holdings,
    exits,
    opportunities,
    opportunitiesOmitted,
    entries,
    swaps: buildSwaps(exits, entries, cash),
    cash,
    failures,
  };
}

/** 大盘快照读失败不拖垮整块看板：记一条说明，其余照常 */
function readRegimeSafely(failures: Array<{ source: string; reason: string }>): ReturnType<
  typeof getRegimeSummaryForCockpit
> {
  try {
    return getRegimeSummaryForCockpit();
  } catch (e) {
    failures.push({
      source: '大盘阶段',
      reason: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** 导出给自检用：看板的纯逻辑部分（不碰 DB、不取数） */
export const __testables = { buildSwaps, isBottomSignal, pickStructureLine };
