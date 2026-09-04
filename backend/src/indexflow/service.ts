import type { IndexFundFlow, IndexFundFlowResult } from '@stock-agent/shared';
import { fetchIndexFlows } from '../market/eastmoney';
import { canPersistSnapshot } from '../scheduling/snapshotWindow';
import { shanghaiToday } from '../util';
import { INDEX_FLOW_DEFS } from './defs';
import { latestFetchedAt, latestTradeDate, loadSeries, upsertRows, type FlowRow } from './repo';
import { buildSummary, computeStats, continuousTail } from './stats';

// 宽基指数资金流：收盘后落一次当日快照，页面只读表。
//
// 读写两端严格分开：写入端接受上游给的 1..N 行并逐行过闸，读取端只认表里的数据。
// 这样既不需要做双源合并，历史源哪天真通了也能直接把整段补进来。

/** 落库结果，供定时任务日志与自检 */
export interface SnapshotResult {
  /** 实际写入行数 */
  saved: number;
  /** 取到当日数据的指数个数 */
  fetched: number;
  /** 跳过原因（空串表示正常写入） */
  skipped: string;
}

/**
 * 抓当日资金流并落库。
 *
 * 三道闸门缺一不可：
 *   非交易日 / 未到收盘保存时刻 → 不写（`canPersistSnapshot` 与其余日频快照共用同一份判定）；
 *   上游返回的日期不等于上海当天 → 不写今天这行。手动触发不经过节假日判断，
 *   全靠这一道挡住「昨天的数据被当成今天存进去」；
 *   10 个指数里当日有效的不足半数 → 整批不写，避免表里留下残缺组让分组投票拿一半样本下判断。
 *
 * 早于今天的行不受第二道闸门约束——它们本来就是已收盘的历史，
 * 历史源哪天恢复了可以顺势把整段补齐。
 */
export async function snapshotIndexFlows(now: Date = new Date()): Promise<SnapshotResult> {
  const gate = canPersistSnapshot('indexFlow', now);
  if (!gate.ok) return { saved: 0, fetched: 0, skipped: gate.reason };

  const today = shanghaiToday(now);
  const fetched = await fetchIndexFlows(INDEX_FLOW_DEFS.map((d) => d.secid));
  const rows: FlowRow[] = [];
  let todayCount = 0;
  for (const f of fetched) {
    for (const r of f.rows) {
      if (!r.date || r.date > today) continue;
      if (r.date === today) todayCount += 1;
      rows.push({ secid: f.secid, tradeDate: r.date, main: r.main, pct: r.pct, source: f.host });
    }
  }
  const half = Math.ceil(INDEX_FLOW_DEFS.length / 2);
  if (todayCount < half) {
    return {
      saved: 0,
      fetched: todayCount,
      skipped: `只有 ${todayCount} 个指数取到今天的数据，不足 ${half} 个，本次不写入`,
    };
  }
  return { saved: upsertRows(rows), fetched: todayCount, skipped: '' };
}

/** 读表组装面板数据（纯本地，不触网） */
export function buildIndexFlowResult(): IndexFundFlowResult {
  const series = loadSeries();
  const items: IndexFundFlow[] = INDEX_FLOW_DEFS.map((def) => {
    const byDate = series.get(def.secid) ?? new Map();
    const days = continuousTail(byDate);
    return {
      code: def.code,
      name: def.name,
      secid: def.secid,
      group: def.group,
      days,
      stats: computeStats(days),
    };
  });
  return {
    dataDate: latestTradeDate(),
    // 用表里记的抓取时间，不是本次请求时间——否则缓存命中时旧数据会被标成刚取的
    fetchedAt: latestFetchedAt(),
    items,
    summary: buildSummary(items),
  };
}
