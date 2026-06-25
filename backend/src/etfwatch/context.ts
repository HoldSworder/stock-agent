import { formatMidlineBreadthForEtf } from '../breadth/service';
import { buildPlanContext } from '../plan/context';

// ETF 多周期盯盘专属上下文：在今日计划全量上下文之外，追加「中长期主线·板块新高宽度」证据块，
// 让买点置信度/手动检测的 agent 以中长期主线（而非仅当日最强）作为主线判断的确定性依据。不侵入 plan 模块。

/** ETF 盯盘研判上下文 = 今日计划全量上下文 + 中长期主线块 */
export async function buildEtfWatchContext(): Promise<string> {
  const base = await buildPlanContext();
  return `${base}\n\n${formatMidlineBreadthForEtf()}`;
}
