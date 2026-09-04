import type {
  IndexFlowGroup,
  IndexFlowGroupVerdict,
  IndexFlowLevel,
  IndexFlowSampleTier,
  IndexFundFlow,
  IndexFundFlowDay,
  IndexFundFlowStats,
  IndexFundFlowSummary,
} from '@stock-agent/shared';
import { prevTradingDay } from '../market/calendar';
import { GROUP_LABEL } from './defs';

// 资金流统计：把一段「连续且已收盘」的日序列压成强弱档位，再按组投票出一句话结论。
// 全部按规则计算，不经大模型。

/** rank5 分档边界：>=70 偏强 / <=30 偏弱 / 其余中性 */
const STRONG_AT = 70;
const WEAK_AT = 30;
/** 给正常结论的最低连续记录天数 */
const FULL_DAYS = 40;
/** 给「暂时」结论的最低连续记录天数，低于此只显示数值 */
const TENTATIVE_DAYS = 20;
/** 滚动窗口长度 */
const WINDOW = 5;
/** 浮点等值容差：全部数值相同（例如整段为零）时要判成并列，而不是被浮点误差拆成大小关系 */
const EPS = 1e-9;

/**
 * 从最新一条记录往回取**连续交易日**，遇到缺口即停。
 *
 * 不能直接把表里的行按日期排一排就用：快照漏跑会留下缺口，跨过缺口拼出来的
 * 「近 5 日」可能横跨两周，拿它去比历史等于拿不同长度的东西作比较。
 *
 * @param byDate 交易日 → 当日读数
 * @returns 升序（旧→新）的连续段；无记录返回空数组
 */
export function continuousTail(byDate: Map<string, IndexFundFlowDay>): IndexFundFlowDay[] {
  const dates = [...byDate.keys()].sort();
  const newest = dates[dates.length - 1];
  if (!newest) return [];
  const out: IndexFundFlowDay[] = [];
  let cursor = newest;
  // 上限防呆：连续 400 个交易日已超过一年半，再往前对结论没有影响
  for (let i = 0; i < 400; i += 1) {
    const day = byDate.get(cursor);
    if (!day) break;
    out.push(day);
    cursor = prevTradingDay(cursor);
  }
  return out.reverse();
}

/** 样本档：天数决定结论能说到多满 */
function tierOf(days: number): IndexFlowSampleTier {
  if (days >= FULL_DAYS) return 'full';
  if (days >= TENTATIVE_DAYS) return 'tentative';
  return 'insufficient';
}

/** 连续净流入(正)/净流出(负)天数；最近一日为零时返回 0 */
function streakOf(days: IndexFundFlowDay[]): number {
  const last = days[days.length - 1];
  if (!last || last.main === 0) return 0;
  const positive = last.main > 0;
  let n = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const v = days[i].main;
    if (v === 0 || v > 0 !== positive) break;
    n += 1;
  }
  return positive ? n : -n;
}

/**
 * 最近 5 日累计值在全部可比较 5 日区间中的相对位置 0-100。
 *
 * 用中位排名法（并列各算一半）而不是「有多少个比它小」：整段数值相同时
 * 后者会给出 0 或 100 这种极端读数，实际含义却是「毫无差别」。
 * 分母包含当前区间自身——要回答的是它在自己历史里排第几，剔除自身在小样本下更不稳。
 *
 * @returns m 个区间不足时返回 null
 */
function rankOfLast5(days: IndexFundFlowDay[]): number | null {
  const m = days.length - WINDOW + 1;
  if (m < 1) return null;
  const sums: number[] = [];
  for (let i = 0; i + WINDOW <= days.length; i += 1) {
    let s = 0;
    for (let k = 0; k < WINDOW; k += 1) s += days[i + k].main;
    sums.push(s);
  }
  const cur = sums[sums.length - 1];
  let less = 0;
  let equal = 0;
  for (const s of sums) {
    if (Math.abs(s - cur) <= EPS) equal += 1;
    else if (s < cur) less += 1;
  }
  return ((less + equal / 2) / sums.length) * 100;
}

/** 末 n 项求和；不足 n 项返回 null */
function tailSum(days: IndexFundFlowDay[], n: number): number | null {
  if (days.length < n) return null;
  let s = 0;
  for (let i = days.length - n; i < days.length; i += 1) s += days[i].main;
  return s;
}

/** 由连续已收盘序列算出单个指数的全部统计量；空序列返回 null */
export function computeStats(days: IndexFundFlowDay[]): IndexFundFlowStats | null {
  if (days.length === 0) return null;
  const n = days.length;
  const tier = tierOf(n);
  // 不足 20 日不给任何档位：此时排名本身算得出来，但拿 3 个区间排出的「第 1 名」
  // 去说资金偏强，是把噪声当结论
  const rank5 = tier === 'insufficient' ? null : rankOfLast5(days);
  const level: IndexFlowLevel =
    rank5 == null ? 'unknown' : rank5 >= STRONG_AT ? 'strong' : rank5 <= WEAK_AT ? 'weak' : 'neutral';
  return {
    latest: days[n - 1].main,
    sum5: tailSum(days, 5),
    sum20: tailSum(days, 20),
    days: n,
    windows: Math.max(0, n - WINDOW + 1),
    rank5,
    level,
    tier,
    streak: streakOf(days),
  };
}

/** 样本档强弱序，用于取组内最低档 */
const TIER_ORDER: Record<IndexFlowSampleTier, number> = {
  insufficient: 0,
  tentative: 1,
  full: 2,
};

function lowerTier(a: IndexFlowSampleTier, b: IndexFlowSampleTier): IndexFlowSampleTier {
  return TIER_ORDER[a] <= TIER_ORDER[b] ? a : b;
}

/**
 * 组内投票。中性不计票，但仍算作「有档位的有效指数」。
 *
 * 两道门槛缺一不可：
 *   有档位的指数少于 2 个 → 数据不全，不判；
 *   方向票（强+弱）少于 2 张 → 方向不明。少了这道，「1 个偏强 + 3 个中性」
 *   会被判成整组偏强，而那根本不是多数。
 */
export function voteGroup(items: IndexFundFlow[], group: IndexFlowGroup): IndexFlowGroupVerdict {
  const rated = items.filter((it) => it.group === group && it.stats && it.stats.level !== 'unknown');
  const strong = rated.filter((it) => it.stats!.level === 'strong').length;
  const weak = rated.filter((it) => it.stats!.level === 'weak').length;
  // 组级结论只能说到组内最弱那一档：混了 20-39 日的指数就整体只能说「暂时」
  const tier = rated.reduce<IndexFlowSampleTier>(
    (acc, it) => lowerTier(acc, it.stats!.tier),
    rated.length > 0 ? 'full' : 'insufficient',
  );
  let level: IndexFlowLevel = 'unknown';
  if (rated.length >= 2 && strong + weak >= 2) {
    // 平票即方向不明，不设任何 tie-breaker——尤其不能比金额，
    // 这几个指数成分大量重叠，把它们的净流入相加等于把同一批成交算好几遍
    if (strong > weak) level = 'strong';
    else if (weak > strong) level = 'weak';
  }
  return { group, strong, weak, rated: rated.length, level, tier };
}

/** 「暂时」前缀：组级样本档只到 tentative 时，所有说法都要降级 */
function hedge(tier: IndexFlowSampleTier): string {
  return tier === 'tentative' ? '暂时' : '';
}

function groupPhrase(v: IndexFlowGroupVerdict): string {
  const label = GROUP_LABEL[v.group];
  if (v.rated < 2) return `${label}数据不全，暂不判断`;
  if (v.level === 'unknown') return `${label}方向不明`;
  const dir = v.level === 'strong' ? '偏强' : v.level === 'weak' ? '偏弱' : '不强不弱';
  return `${label}${hedge(v.tier)}${dir}`;
}

/**
 * 拼出驾驶舱那一行。
 *
 * 说法必须跟得住样本：不足 20 日一个字的方向都不能给，
 * 20-39 日只能说「暂时」，两组都判出方向才允许出现「钱更愿意进哪边」这种对比。
 */
export function buildSummary(items: IndexFundFlow[]): IndexFundFlowSummary {
  const maxDays = items.reduce((m, it) => Math.max(m, it.stats?.days ?? 0), 0);
  const large = voteGroup(items, 'large');
  const small = voteGroup(items, 'small');
  const groups = [large, small];

  if (maxDays < TENTATIVE_DAYS) {
    const text =
      maxDays === 0
        ? '还没有记录，今天收盘后开始逐日累积；满 20 个交易日才会给方向'
        : `已连续记录 ${maxDays} 个交易日，满 20 个后才开始给方向；现在只看数值，不作为买卖依据`;
    return { text, groups, maxDays, actionable: false };
  }

  const bothKnown = large.level !== 'unknown' && small.level !== 'unknown';
  const suffix = `（已连续记录 ${maxDays} 个交易日）`;
  if (!bothKnown) {
    return {
      text: `${groupPhrase(large)}；${groupPhrase(small)}${suffix}`,
      groups,
      maxDays,
      actionable: false,
    };
  }

  // 对比句同样继承两组中较低的一档
  const h = hedge(lowerTier(large.tier, small.tier));
  let body: string;
  if (large.level === small.level) {
    body =
      large.level === 'strong'
        ? `大盘蓝筹和中小盘的大单都${h}比自己近期偏多`
        : large.level === 'weak'
          ? `两边的大单都${h}比自己近期偏少，别把资金面当成加仓理由`
          : '两边都不强不弱，资金面今天给不出倾向';
  } else if (large.level === 'strong' || small.level === 'weak') {
    body = `钱${h}更愿意进大盘蓝筹，中小盘相对更弱`;
  } else {
    body = `钱${h}更愿意进中小盘，大盘蓝筹相对更弱`;
  }
  return {
    text: `${body}${suffix}`,
    groups,
    maxDays,
    // 只有两组都判出方向、且不是双中性，才算给出了可用的倾向
    actionable: large.level !== 'neutral' || small.level !== 'neutral',
  };
}
