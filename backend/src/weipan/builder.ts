import { getRunDetail, listRuns } from '../screener/repo';
import { executeSimTrade, getStrategySnapshot } from '../strategy/sim';
import { shanghaiToday } from '../util';
import { getWeipanConfig } from './config';
import { resolveWeipanStrategy } from './resolve';

// 尾盘套利确定性建仓：读当日尾盘选股(screen_runs, weipan_momentum/cron)，按选出现价等权在尾盘战法建虚拟仓。
// 全确定性、无 LLM：选股(LLM)由既有 cron 完成，此处只把选出的 3 只机械落成持仓（次日交给盯盘卖出）。

/** 建仓成交理由前缀（幂等判定 + reason 展示用） */
export const BUILD_REASON_PREFIX = '尾盘建仓';

export interface WeipanBuildResult {
  built: number;
  skipped: string[];
  note: string;
}

/**
 * 建仓当日尾盘选出的标的（幂等：当日已建仓则跳过）。
 * 每只按「建仓时可用现金 × perPositionPct%」下单，向下取整到 100 股；
 * 涨停不可买/T+1/资金不足由 executeSimTrade 强校验，买不进的记入 skipped。
 */
export async function buildPositionsFromTodayPicks(): Promise<WeipanBuildResult> {
  const strategy = resolveWeipanStrategy();
  if (!strategy) return { built: 0, skipped: [], note: '未找到「尾盘动能套利」本地战法，跳过建仓' };

  const today = shanghaiToday();
  const run = listRuns(50).find(
    (r) =>
      r.strategyId === 'weipan_momentum' &&
      r.trigger === 'cron' &&
      shanghaiToday(new Date(r.createdAt)) === today,
  );
  if (!run) return { built: 0, skipped: [], note: `今日(${today})无尾盘选股记录，跳过建仓` };

  // 幂等：当日已由本模块建过仓则跳过（避免手动+定时重复建仓）
  const snap = await getStrategySnapshot(strategy.id, { skipSync: true });
  const alreadyBuilt = snap.trades.some(
    (t) => t.side === 'buy' && t.tradeDate === today && (t.reason ?? '').startsWith(BUILD_REASON_PREFIX),
  );
  if (alreadyBuilt) return { built: 0, skipped: [], note: `今日已建仓，跳过` };

  const picks = getRunDetail(run.id)?.picks ?? [];
  if (picks.length === 0) return { built: 0, skipped: [], note: '今日尾盘选股无有效标的' };

  const cfg = getWeipanConfig();
  const reason = `${BUILD_REASON_PREFIX}${run.context ? `·${run.context}` : ''}`;
  let built = 0;
  const skipped: string[] = [];

  for (const p of picks) {
    if (!(p.price > 0)) {
      skipped.push(`${p.name}(${p.code}) 无有效现价`);
      continue;
    }
    // 每只都按「当前可用现金」的比例下单（动态，避免逐笔买入后现金被高估导致超买）
    const fresh = await getStrategySnapshot(strategy.id, { skipSync: true });
    const budget = fresh.strategy.cash * (cfg.perPositionPct / 100);
    const qty = Math.floor(budget / p.price / 100) * 100;
    if (qty < 100) {
      skipped.push(`${p.name}(${p.code}) 可用资金不足一手`);
      continue;
    }
    try {
      await executeSimTrade({
        strategyId: strategy.id,
        side: 'buy',
        code: p.code,
        qty,
        price: p.price,
        reason,
        source: 'watch',
      });
      built++;
    } catch (e) {
      skipped.push(`${p.name}(${p.code}) ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    built,
    skipped,
    note: `建仓 ${built} 只${skipped.length ? `，跳过 ${skipped.length}（${skipped.join('；')}）` : ''}`,
  };
}
