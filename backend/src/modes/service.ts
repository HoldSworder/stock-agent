import type { ResearchModeDetail } from '@stock-agent/shared';
import {
  getMode,
  listBacktests,
  listEvents,
  listFollowedSystemModes,
  recentDaily,
} from './repo';
import { runModeTracking } from './tracker';

// 聚合读 + 批量每日跟踪。读路径轻量直读 DB（数据已结构化），不额外缓存。

export function getModeDetail(id: string): ResearchModeDetail | null {
  const mode = getMode(id);
  if (!mode) return null;
  return {
    mode,
    backtests: listBacktests(id),
    recentDaily: recentDaily(id),
    events: listEvents(id),
  };
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
