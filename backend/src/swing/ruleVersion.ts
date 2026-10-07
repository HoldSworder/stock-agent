import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { nowIso, shanghaiToday } from '../util';
import { shiftTradingDays } from '../market/calendar';
import { DIVERGENCE_PARAMS } from './divergence';
import { JUDGE_PARAMS } from './judge';
import { SIZING_PARAMS } from './sizing';
import { ADVICE_PARAMS } from './advice';
import { CORE_HOLDING_PARAMS } from './coreHolding';
import { MIN_AMOUNT, MIN_FLOAT_CAP, MIN_BARS_FOR_STRUCTURE } from './universe';

// 规则存档与验收资格。
//
// 这套判定规则在通过前向验收之前只能给试探仓位，而
// **验收用的样本必须产生于规则定版之后** 是这件事唯一的防作弊约束。
// 少了它，任何人（包括我自己）都可以反复调参数直到历史数据好看，
// 再拿同一批数据宣布「验收通过」——那个胜率没有任何意义。
//
// 所以这里做成**自动升版**而不是人工登记：
// 参数一改，内容哈希就变，下一次运行自动建新版本、旧版标为已被取代，
// 并且**放大仓位的资格立刻失效、退回试探仓**。
// 人工升版靠的是记性，而记性正是这类约束最不该依赖的东西。

/** 规则版本前缀，便于人眼辨识 */
const VERSION_PREFIX = 'swing-v';

/**
 * 参与哈希的规则清单。
 *
 * 收录判据：**任何会改变信号、动作、仓位、退出结果或验收结果的东西**。
 * 界面文案、提示词、纯重构不进来——它们不改变任何一笔建议。
 * 漏收一项的后果是：那一项被偷偷改掉而版本号不变，
 * 于是改参数前后的样本被混在一起统计。
 */
export function buildRuleManifest(): Record<string, unknown> {
  return {
    divergence: DIVERGENCE_PARAMS,
    judge: JUDGE_PARAMS,
    sizing: SIZING_PARAMS,
    // 试探仓的动作规则
    advice: ADVICE_PARAMS,
    // 底仓（中长线赛道轮动）的动作规则。它与 advice 是**两套并列的规则**，
    // 同一笔头寸只能归其中一套管；收进同一份清单是因为两者都会改变实际动作，
    // 任一被改动都必须升版重新积累样本
    coreHolding: CORE_HOLDING_PARAMS,
    universe: {
      minAmount: MIN_AMOUNT,
      minFloatCap: MIN_FLOAT_CAP,
      minBarsForStructure: MIN_BARS_FOR_STRUCTURE,
    },
    gate: VALIDATION_GATE,
  };
}

/**
 * 阶段二放行门槛。**现在就定死，不留给将来调**。
 *
 * 为什么必须提前写死：用上两三个月、感觉「好像挺准」的时候，
 * 一定会很想把门槛调松一点好放大仓位。那时候调，
 * 等于用已经看过的数据反推一个能通过的标准。
 * 任何一项改动都会改变哈希从而升版、重新积累样本——这是刻意设置的摩擦。
 */
export const VALIDATION_GATE = {
  /** 只有二级信号的样本能决定是否放大；一级永远只拿试探仓 */
  upgradableGrades: ['turn_confirmed_bottom', 'turn_confirmed_top'] as const,
  /** 同代码同方向多少个交易日内只算一个独立事件 */
  eventDedupeTradeDays: 20,
  /** 每个方向最低独立事件数 */
  minEventsPerDirection: 60,
  /** 每个方向最低独立触发日期数 */
  minTradeDatesPerDirection: 30,
  /** 每个方向最低自然周分块数 */
  minBlocksPerDirection: 30,
  /** 每个真实事件配几个随机非信号日 */
  controlsPerEvent: 8,
  /** 观察窗口（交易日） */
  observeTradeDays: 20,
  /** 顺向目标 = 多少倍 ATR */
  targetAtrMult: 2,
  /** 反向失效 = 多少倍 ATR */
  invalidAtrMult: 1,
  /** 重采样次数 */
  bootstrapIterations: 10_000,
  /** 点估计至少领先多少个百分点 */
  minEdgePoints: 10,
  /** 95% 保守下界至少领先多少个百分点 */
  minEdgeLowerPoints: 5,
  /** 真实命中率至少多少 % */
  /** 旧考试赔率。不能单独当作试探仓有正期望，验收不再用它当通过条件。 */
  minRealRatePct: 45,
  /** 至少覆盖多少个赛道 */
  minTracks: 10,
  /** 每个市场阶段至少多少个事件（阶段用系统原生四档） */
  minEventsPerPhase: 10,
  /** 单一标的最多占样本比例 % */
  maxSingleCodeSharePct: 10,
} as const;

/** 稳定序列化：键排序，保证同样的参数always得出同样的哈希 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/** 规则清单的内容哈希。取前 12 位够辨识，全长在日志里没人看 */
export function ruleHashOf(manifest: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(manifest)).digest('hex').slice(0, 12);
}

export interface RuleVersionRow {
  version: string;
  ruleHash: string;
  ruleManifest: string;
  activatedAt: string;
  eligibleFromTradeDate: string;
  status: string;
}

/** 当前生效版本；没有则返回 null */
export function currentRuleVersion(): RuleVersionRow | null {
  const rows = db
    .select()
    .from(schema.swingRuleVersions)
    .where(eq(schema.swingRuleVersions.status, 'active'))
    .orderBy(desc(schema.swingRuleVersions.activatedAt))
    .all();
  return rows[0] ?? null;
}

/**
 * 确保当前参数已登记，必要时自动升版。
 *
 * 三种情形：
 *  1) 从没有版本 → 建 v1
 *  2) 当前生效版本的哈希与参数一致 → 原样返回
 *  3) 哈希不一致（参数被改过）→ 旧版标为已被取代、建新版
 *
 * 情形 3 会让放大仓位的资格立刻失效——新版本没有任何合格样本，
 * 于是自动退回试探仓。这是刻意的：改了规则就得重新证明它有效。
 */
export function ensureRuleVersion(now = new Date()): RuleVersionRow {
  const manifest = buildRuleManifest();
  const hash = ruleHashOf(manifest);
  const cur = currentRuleVersion();
  if (cur && cur.ruleHash === hash) return cur;

  const today = shanghaiToday(now);
  const row: RuleVersionRow = {
    // 版本号取序号，与哈希一起用。序号便于人读，哈希才是判据
    version: `${VERSION_PREFIX}${nextSeq()}`,
    ruleHash: hash,
    ruleManifest: JSON.stringify(manifest),
    activatedAt: nowIso(),
    // 定版当天的数据有一半产生在定版之前，不能用来给自己验收，
    // 故资格从下一个交易日起算
    eligibleFromTradeDate: shiftTradingDays(today, 1),
    status: 'active',
  };

  db.transaction((tx) => {
    if (cur) {
      tx.update(schema.swingRuleVersions)
        .set({ status: 'superseded' })
        .where(eq(schema.swingRuleVersions.version, cur.version))
        .run();
    }
    tx.insert(schema.swingRuleVersions).values(row).run();
  });

  console.warn(
    `[swing] 规则参数已变更，自动升版 ${cur?.version ?? '(无)'} → ${row.version}（哈希 ${hash}）。` +
      `放大仓位资格已失效，退回试探仓，验收样本从 ${row.eligibleFromTradeDate} 起重新积累。`,
  );
  return row;
}

/** 下一个版本序号 */
function nextSeq(): number {
  const rows = db.select().from(schema.swingRuleVersions).all();
  return rows.length + 1;
}

/**
 * 这条样本有没有资格进入验收统计。
 *
 * 五个条件全中才算：当前生效版本、live 运行、信号 K 线收盘于定版之后、
 * 数据日期不早于资格起始日、所属运行完整成功。
 * 任何一条不满足都只能当观察记录，不能计入胜率。
 */
export function isValidationEligible(input: {
  ruleVersion: string;
  ruleHash: string;
  mode: 'live' | 'replay';
  barTime: string | null;
  tradeDate: string;
  runStatus: string;
}): boolean {
  const cur = currentRuleVersion();
  if (!cur) return false;
  if (input.ruleVersion !== cur.version || input.ruleHash !== cur.ruleHash) return false;
  // 历史重放永久不得用于放行，只能提前否决
  if (input.mode !== 'live') return false;
  if (input.runStatus !== 'ok') return false;
  if (input.tradeDate < cur.eligibleFromTradeDate) return false;
  if (input.barTime != null && input.barTime.slice(0, 10) < cur.eligibleFromTradeDate) return false;
  return true;
}

/** 当前版本是否已通过某方向的验收（决定能否放大仓位） */
export function isDirectionPassed(direction: 'bottom' | 'top'): boolean {
  const cur = currentRuleVersion();
  if (!cur) return false;
  const rows = db
    .select()
    .from(schema.swingValidationResults)
    .where(
      and(
        eq(schema.swingValidationResults.ruleVersion, cur.version),
        eq(schema.swingValidationResults.ruleHash, cur.ruleHash),
        eq(schema.swingValidationResults.direction, direction),
        eq(schema.swingValidationResults.verdict, 'passed'),
      ),
    )
    .all();
  return rows.length > 0;
}
