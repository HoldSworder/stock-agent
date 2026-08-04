import type { ResearchModeDetail, ResearchModeListItem } from '@stock-agent/shared';
import {
  allOrderedDaily,
  getMode,
  listBacktests,
  listEvents,
  listFollowedSystemModes,
  listModes,
  recentDaily,
} from './repo';
import { runModeTracking } from './tracker';
import { evaluateModeGate, evaluateModeGateFromDaily } from './gate';

// 聚合读 + 批量每日跟踪。读路径轻量直读 DB（数据已结构化），不额外缓存。

export function getModeDetail(id: string): ResearchModeDetail | null {
  const mode = getMode(id);
  if (!mode) return null;
  return {
    mode,
    backtests: listBacktests(id),
    recentDaily: recentDaily(id),
    events: listEvents(id),
    gate: evaluateModeGate(id, mode.variantCount),
  };
}

/**
 * 模式列表 + 晋级门结论。收益曲线漂亮的模式很多，能扛住统计门槛的很少，
 * 列表上就要把「证据不足」标出来，否则选模式时只会被最高的那条收益吸引。
 */
export function listModesWithGate(): ResearchModeListItem[] {
  // 日跟踪一次批量取全，variantCount 直接用列表行上的值：原实现对每个模式各跑一次
  // recentDaily + getMode + orderedDaily(全历史)，是 N+1 叠全表读，落在列表接口上
  const dailyByMode = allOrderedDaily();
  return listModes().map((m) => {
    const days = dailyByMode.get(m.id) ?? [];
    return {
      ...m,
      // 无任何日跟踪 = 证据未开始积累，显式返回 null（不能当成「未通过」）
      gatePassed: days.length === 0 ? null : evaluateModeGateFromDaily(days, m.variantCount).passed,
    };
  });
}

/** 遍历所有「已关注 + system」模式跑当日跟踪（供定时任务与手动「全部跟踪」） */
export async function runAllFollowedTracking(): Promise<{
  ok: string[];
  failed: Array<{ id: string; error: string }>;
}> {
  const modes = listFollowedSystemModes();
  const ok: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const m of modes) {
    try {
      await runModeTracking(m.id);
      ok.push(m.id);
    } catch (e) {
      failed.push({ id: m.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok, failed };
}
