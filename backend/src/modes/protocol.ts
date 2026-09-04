import { createHash } from 'node:crypto';
import type { BacktestCosts, ModeProtocolMark, ModeSpec, ModeUniversePolicy } from '@stock-agent/shared';
import { resolveCosts, resolveEtfCosts, sideCostBps } from '../backtest/costs';
import { family, shortName } from './themeFirst';
import { researchPoolFor } from './researchPool';

// 模式引擎协议标记：把「哪一版引擎 / 哪个标的池 / 哪档成本」压成一个可比对的口径串。
//
// 为什么需要它：本轮修好了一条从未生效的 supertrend 离场，又给回放加上了真实成本，
// 同一份 spec 在新旧引擎下会跑出不同曲线。旧的 daily 行与回测记录不删不改，但必须能
// 一眼分辨「这条证据出自哪套口径」，否则新旧样本会被混进同一个晋级门判断里。
//
// 落库：research_mode_daily 的 protocol_* 列（跟踪路径）与 research_mode_backtests.engine_version
// （回测路径）。加列之前的历史行由迁移统一回填 v1-legacy。

/**
 * 引擎语义版本。任何会改变持仓/收益的规则改动都必须换号，仅重构不换。
 * v1 = supertrend 恒不触发、回放零成本的历史口径（旧 daily 行与旧回测均属 v1）。
 */
export const MODE_ENGINE_VERSION = 'v2-2026.08';

export type { ModeUniversePolicy };

/** 落库字段（ModeProtocolMark）+ 只给人看的口径说明 */
export interface ModeProtocol extends ModeProtocolMark {
  /** 人读的口径说明（含最低佣金、池不同源之类的告警），不落库 */
  note: string;
}

/** 模式默认成本档：ETF 跟踪池全是场内基金，免印花税、免过户费 */
export function modeCosts(input?: Partial<BacktestCosts>): BacktestCosts {
  return resolveEtfCosts(input);
}

/**
 * 场内基金代码段（ETF / LOF）：深市 15xxxx、16xxxx，沪市 51/52/56/58xxxx。
 * 个股是沪 60/68、深 00/30、北 8x/4x，都不在这几段里。
 */
const EXCHANGE_FUND_PREFIX = ['15', '16', '51', '52', '56', '58'];

/**
 * 是否场内基金。ETF 免印花税这档成本只对场内基金成立，而 etf_pool 表对 code 无品种校验，
 * 用户往「ETF 跟踪池」里加一只个股，卖出侧就会少扣 5bps 印花税（方向偏乐观）。
 */
export function isExchangeFund(code: string): boolean {
  return EXCHANGE_FUND_PREFIX.some((p) => code.startsWith(p));
}

/**
 * 池哈希：对**排序后的申报池**计算，且必须带上影响 family/theme 归类的规范化名称——
 * 只哈希代码列表的话，「同一批代码但名称截断规则变了」会导致主题分组变化却哈希不变。
 *
 * 为什么不用「今天取数成功的子集」：单只 ETF 瞬时取数失败就会换一个 hash，而晋级门
 * （gate.ts latestProtocolRun）只回溯到第一次口径变更为止，样本会被截断到当天，
 * MIN_TRADES/MIN_CLUSTERS 在反复截断下结构上永远攒不满，且不报任何错。
 */
export function universeHashOf(universe: ReadonlyArray<{ code: string; name: string }>): string {
  const lines = universe
    .map((u) => {
      const short = shortName(u.name);
      return `${u.code}|${short}|${family(short)}`;
    })
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/**
 * 计算某次跟踪/回测的协议标记。
 *
 * @param declared 申报池（listPool() 全量条目 / 研究基准池），决定 hash 与 protocolVersion；
 *   不能传「今天取数成功的子集」，否则口径键会随每日取数抖动。
 * @param opts.includedCount 今天实际纳入引擎的标的数，只作为 poolSize 元数据落库，不进口径键。
 */
export function modeProtocolOf(
  spec: ModeSpec,
  declared: ReadonlyArray<{ code: string; name: string }>,
  opts: {
    modeId?: string;
    policy: ModeUniversePolicy;
    costs?: BacktestCosts;
    engineVersion?: string;
    includedCount?: number;
  },
): ModeProtocol {
  // 混入个股的池不能套 ETF 免税档：品种判定失败时退回 A 股默认档，宁可高估成本
  const nonFund = declared.filter((u) => !isExchangeFund(u.code)).map((u) => u.code);
  const costs = opts.costs ?? (nonFund.length ? resolveCosts() : modeCosts());
  const engineVersion = opts.engineVersion ?? MODE_ENGINE_VERSION;
  const buy = sideCostBps(costs, 'buy');
  const sell = sideCostBps(costs, 'sell');
  const universeHash = universeHashOf(declared);
  const included = opts.includedCount ?? declared.length;

  let sameAsResearchPool: boolean | null = null;
  if (opts.modeId) {
    const research = researchPoolFor(opts.modeId);
    sameAsResearchPool = universeHashOf(research) === universeHash;
  }

  const kind = spec.kind ?? 'crossSection';
  const protocolVersion =
    `${engineVersion}|${kind}|univ=${opts.policy}:${universeHash}:${declared.length}` +
    `|cost=b${buy}/s${sell}bps`;

  const notes = [
    `引擎 ${engineVersion}`,
    `申报池 ${opts.policy}（${declared.length} 只，hash ${universeHash}）`,
    `今日实际纳入 ${included} 只`,
    `成本 买${buy}bps/卖${sell}bps（${nonFund.length ? '含非场内基金，按 A 股默认档计印花税' : 'ETF 免印花税与过户费'}）`,
    // 归一化回放按比例扣费，无法体现「每笔至少 5 元佣金」——小额本金下真实成本更高
    `未计最低佣金 ${costs.minCommission} 元（归一化回放无名义本金）`,
  ];
  if (nonFund.length) {
    notes.push(`标的池混了两类：含非场内基金 ${nonFund.join('、')}，费用按个股标准计`);
  }
  if (sameAsResearchPool === false) {
    notes.push('与该模式研究基准池不同源：站内跟踪结果不可与回测留档直接对比');
  }

  return {
    protocolVersion,
    engineVersion,
    universePolicy: opts.policy,
    universeHash,
    poolSize: included,
    costBps: { buyBps: buy, sellBps: sell },
    sameAsResearchPool,
    note: notes.join('；'),
  };
}

/** 统一的协议日志前缀，便于按 modeId grep 出某次跟踪的口径 */
export function logModeProtocol(modeId: string, p: ModeProtocol): void {
  console.log(`[modes] ${modeId} 协议 ${p.protocolVersion} — ${p.note}`);
}
