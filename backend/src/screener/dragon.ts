import { getDragonRanking } from '../market/eastmoney';
import type { ExtraFactorScores } from './scorer';

// S6 龙头分因子（涨停池横截面，单次取数）：把当日连板梯队的「龙头分」作为选股因子注入。
// 仅 dragon_leader 等显式启用 dragonRank 因子的策略才会触发，一次取齐涨停池、对候选 code 命中即赋分，
// 不在涨停池的候选记中性 50（由 scorer 处理）。无逐只取数压力（单次涨停池请求）。

/**
 * 为候选 code 列表补 dragonRank 因子分（命中当日涨停梯队者赋龙头分，否则缺省）。
 * best-effort：涨停池取数失败则返回空表（dragonRank 全员中性 50），不阻断选股。
 */
export async function enrichDragonFactors(codes: string[]): Promise<ExtraFactorScores> {
  const map: ExtraFactorScores = new Map();
  const ov = await getDragonRanking().catch(() => null);
  if (!ov) return map;
  const want = new Set(codes);
  for (const tier of ov.tiers) {
    for (const s of tier.stocks) {
      if (want.has(s.code)) map.set(s.code, { dragonRank: s.dragonScore });
    }
  }
  return map;
}
