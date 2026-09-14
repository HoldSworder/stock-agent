import { fetchRealPositions } from '../realPositions';
import { listWatch } from '../watchlist';
import { listPool } from '../etf/repo';
import { isEtfCode } from '../etfwatch/targets';
import { fetchEtfSpot, pickRepresentatives, type TrackRepresentative, type TrackGap } from './universe';

// 波段扫描的标的池。
//
// 为什么不复用 etfwatch/targets.ts 的 collectTargets：
// 那个函数里有 isEtfCode 过滤且**不读自选表**，只收「持仓中的 ETF ∪ ETF 池 ∪ 白名单」。
// 拿它当标的池会静默漏掉持仓里的个股和全部自选——
// 而「我的持仓和自选都要出细化提示」是本模块明确要满足的诉求。
//
// 场内代码之外的一律不纳入：场外基金（蚂蚁财富那类）没有分时 K 线，
// 分型、区间、止损全都算不出来，硬塞进来只会产出一堆「数据不足」。

/** 一个待扫描标的 */
export interface SwingTarget {
  code: string;
  name: string;
  assetType: 'etf' | 'stock';
  /** 赛道名；持仓/自选标的为空串 */
  track: string;
  /** 是否作为某赛道的代表被扫（用 ETF 代看板块时页面要标注） */
  isTrackProxy: boolean;
  /** 同赛道候选只数 */
  peerCount: number;
  /** 来源，用于页面分组与排序 */
  origin: 'track' | 'position' | 'watchlist' | 'etfPool';
  /** 该标的真实持仓占总资产 %；无持仓为 0 */
  realPct: number;
}

/** 场内 A 股/ETF 6 位代码 */
function isOnMarketCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** 个股还是 ETF：ETF 走 1/5 开头，其余场内 6 位按个股处理 */
function assetTypeOf(code: string): 'etf' | 'stock' {
  return isEtfCode(code) ? 'etf' : 'stock';
}

export interface CollectResult {
  targets: SwingTarget[];
  /** 赛道代表（含未持仓的），供页面按赛道分组 */
  representatives: TrackRepresentative[];
  /** 暂无可交易标的的赛道，页面须如实标注 */
  gaps: TrackGap[];
  /** 账户总资产；取不到为 null，此时禁止给建仓建议 */
  totalEquity: number | null;
  /** 各来源的取数失败说明，页面须如实展示而非静默漏掉 */
  failures: Array<{ source: string; reason: string }>;
}

/**
 * 汇集本轮要扫的标的。
 *
 * 去重规则：同一代码只保留一条，来源优先级 持仓 > 自选 > 赛道代表 > ETF 池。
 * 持仓优先是因为它带真实仓位，而仓位直接影响可执行增量的计算。
 *
 * 任何来源取数失败都记入 failures 并继续，不整轮失败——
 * 但**总资产取不到是硬约束**，调用方须据此禁止给建仓建议（见 sizing 的说明）。
 */
export async function collectSwingTargets(): Promise<CollectResult> {
  const failures: Array<{ source: string; reason: string }> = [];
  const map = new Map<string, SwingTarget>();
  let totalEquity: number | null = null;

  // --- 真实持仓（含个股）---
  const realPctByCode = new Map<string, number>();
  try {
    const pf = await fetchRealPositions(false);
    // 总资产在报价缺失时会退回成本价估值，所以「拿到了数」不等于数据完整。
    // 这里只要求它为正数；更细的完整性判断由 sizing 侧按需要处理
    totalEquity = pf.totalAsset > 0 ? pf.totalAsset : null;
    for (const p of pf.positions) {
      if (p.qty <= 0 || !isOnMarketCode(p.code)) continue;
      realPctByCode.set(p.code, p.positionRate);
      map.set(p.code, {
        code: p.code,
        name: p.name,
        assetType: assetTypeOf(p.code),
        track: '',
        isTrackProxy: false,
        peerCount: 1,
        origin: 'position',
        realPct: p.positionRate,
      });
    }
  } catch (e) {
    failures.push({
      source: '真实持仓',
      reason: e instanceof Error ? e.message : String(e),
    });
  }

  // --- 自选 ---
  try {
    for (const w of listWatch()) {
      if (!isOnMarketCode(w.code) || map.has(w.code)) continue;
      map.set(w.code, {
        code: w.code,
        name: w.name,
        assetType: assetTypeOf(w.code),
        track: '',
        isTrackProxy: false,
        peerCount: 1,
        origin: 'watchlist',
        realPct: realPctByCode.get(w.code) ?? 0,
      });
    }
  } catch (e) {
    failures.push({ source: '自选', reason: e instanceof Error ? e.message : String(e) });
  }

  // --- 赛道代表 ---
  let representatives: TrackRepresentative[] = [];
  let gaps: TrackGap[] = [];
  try {
    const spot = await fetchEtfSpot();
    const picked = pickRepresentatives(spot);
    representatives = picked.representatives;
    gaps = picked.gaps;
    for (const r of representatives) {
      const exist = map.get(r.code);
      if (exist) {
        // 已在持仓/自选里：补上赛道信息，但保留原来源
        exist.track = r.track;
        exist.peerCount = r.peerCount;
        exist.isTrackProxy = true;
        continue;
      }
      map.set(r.code, {
        code: r.code,
        name: r.name,
        assetType: 'etf',
        track: r.track,
        isTrackProxy: true,
        peerCount: r.peerCount,
        origin: 'track',
        realPct: realPctByCode.get(r.code) ?? 0,
      });
    }
  } catch (e) {
    failures.push({ source: '赛道代表', reason: e instanceof Error ? e.message : String(e) });
  }

  // --- ETF 跟踪池 ---
  try {
    for (const it of listPool()) {
      if (!isOnMarketCode(it.code) || map.has(it.code)) continue;
      map.set(it.code, {
        code: it.code,
        name: it.name,
        assetType: assetTypeOf(it.code),
        track: '',
        isTrackProxy: false,
        peerCount: 1,
        origin: 'etfPool',
        realPct: realPctByCode.get(it.code) ?? 0,
      });
    }
  } catch (e) {
    failures.push({ source: 'ETF 跟踪池', reason: e instanceof Error ? e.message : String(e) });
  }

  return {
    targets: [...map.values()],
    representatives,
    gaps,
    totalEquity,
    failures,
  };
}
