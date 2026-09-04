import type { CockpitAction } from '@stock-agent/shared';
import { getLastQuotes } from '../watch/engine';
import { getQuotes } from '../market/eastmoney';
import { nowIso } from '../util';

// 实时叠加：给日频判断补上「现在走到哪了」。
//
// 驾驶舱的动作大多建立在盘前或收盘的判断上——计划的触发价是昨晚定的死数字，
// 板块阶段是昨收算的。而当天的变数几乎全都体现在一个地方：
// 现价相对那些死数字走到哪了。
//
// 两条纪律：
// 1. 取不到就说取不到，绝不用旧价顶替。一个不标时间的旧价会让人以为还差得远，
//    或者以为已经破了——这比没有实时价更危险。
// 2. 越过价位只是展示，不改计划状态。「碰到了」和「确认触发」是两回事，
//    后者由盯盘引擎按确认规则判定，这里插手会凭空制造触发记录。

/** 盯盘引擎的报价超过这么久就不算实时，改为自己补取 */
const REUSE_MAX_AGE_MS = 60_000;

export interface LivePrice {
  price: number;
  changePct: number;
  at: string;
}

/**
 * 取这批代码的实时价。
 *
 * 优先复用盯盘引擎每 10 秒刷新的那份快照——它本来就在拉持仓与计划标的的行情，
 * 驾驶舱再打一次是重复开销。只有它没跑、数据太旧、或缺代码时才自己补。
 *
 * 返回的 Map 只包含真正取到的代码。批量接口可能只返回一部分，
 * 必须逐个判断有没有，不能因为请求整体成功就把全部当成拿到了。
 */
export async function fetchLivePrices(codes: string[]): Promise<Map<string, LivePrice>> {
  const out = new Map<string, LivePrice>();
  const want = [...new Set(codes.filter(Boolean))];
  if (want.length === 0) return out;

  try {
    const last = getLastQuotes();
    const ageMs = last.at ? Date.now() - new Date(last.at).getTime() : Number.POSITIVE_INFINITY;
    if (last.at && ageMs <= REUSE_MAX_AGE_MS) {
      for (const q of last.items) {
        if (!want.includes(q.code) || !(q.price > 0)) continue;
        out.set(q.code, { price: q.price, changePct: q.pct, at: last.at });
      }
    }
  } catch {
    /* 盯盘没跑就跳过，下面自己取 */
  }

  const missing = want.filter((c) => !out.has(c));
  if (missing.length === 0) return out;
  try {
    const quotes = await getQuotes(missing);
    const at = nowIso();
    for (const q of quotes) {
      if (!(q.price > 0)) continue;
      out.set(q.code, { price: q.price, changePct: q.pct ?? 0, at });
    }
  } catch {
    /* 整批失败：已拿到的那部分照常用，缺的那部分如实为空 */
  }
  return out;
}

/**
 * 距离百分比：正 = 还没到，负 = 已经越过。
 *
 * 必须按触发方向定符号。止损是**跌破**生效，所以价格在止损线下方就是「已越过」；
 * 突破买点是**涨过**生效，价格在买点上方才是「已越过」。
 * 只算数值差的话，一只已经跌破止损的票会显示「距止损线还有 13%」——
 * 读起来像「还早着呢」，而实际上此刻正该止损。
 */
function distance(price: number, target: number, cross: 'below' | 'above'): number {
  const raw = cross === 'below' ? (price - target) / target : (target - price) / target;
  return Math.round(raw * 1000) / 10;
}

/**
 * 把实时价与距离叠到动作上。
 *
 * 动作本身没带参照价位时（例如板块退潮）只补现价与涨跌，不编一个距离出来。
 */
export function applyLiveOverlay(
  actions: CockpitAction[],
  prices: Map<string, LivePrice>,
): CockpitAction[] {
  return actions.map((a) => {
    if (!a.code) return a;
    const live = prices.get(a.code) ?? null;
    if (!live) return { ...a, live: null, distancePct: null };
    return {
      ...a,
      live,
      distancePct: a.distanceTo
        ? distance(live.price, a.distanceTo.price, a.distanceTo.cross)
        : null,
    };
  });
}

// 距离措辞取自 shared 的 actionDistanceText：前后端必须逐字一致，
// 各写一份的结果就是后端说「已跌破」、界面说「已越过」
export { actionDistanceText as distanceText } from '@stock-agent/shared';
