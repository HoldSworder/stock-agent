import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { ResearchModeBacktestInput, ResearchModeUpsert } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { addBacktest, deleteBacktests, upsertMode } from '../modes/repo';

// 研究模式库种子：从 research-modes-seed.json（由 mode/export_modes_seed.py 解析 mode/ 生成，
// 置于 src/seeds 下随镜像 COPY、被 git 跟踪）灌入。库为空才执行，幂等。
// 系统是事实源；后续 codex/cursor 经写 API 增改，与种子不冲突。

interface SeedEntry {
  mode: ResearchModeUpsert;
  backtests: ResearchModeBacktestInput[];
}

function readSeed(): SeedEntry[] | null {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), 'research-modes-seed.json');
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as SeedEntry[];
  } catch (e) {
    console.warn('[seed] 研究模式种子读取失败:', e instanceof Error ? e.message : e);
    return null;
  }
}

function importEntries(entries: SeedEntry[], replaceBacktests: boolean): { modes: number; backtests: number } {
  let m = 0;
  let b = 0;
  for (const e of entries) {
    if (!e?.mode?.id || !e.mode.name) continue;
    // upsertMode 保留 followed 与 createdAt，不影响关注状态。
    upsertMode(e.mode);
    if (replaceBacktests) deleteBacktests(e.mode.id);
    m += 1;
    for (const bt of e.backtests ?? []) {
      if (!bt?.label) continue;
      addBacktest(e.mode.id, bt);
      b += 1;
    }
  }
  return { modes: m, backtests: b };
}

export function seedResearchModesIfEmpty(): void {
  const row = db.select({ c: sql<number>`count(*)` }).from(schema.researchModes).get();
  if ((row?.c ?? 0) > 0) return;
  const entries = readSeed();
  if (!entries) return;
  const r = importEntries(entries, false);
  console.log(`[seed] 已导入 ${r.modes} 个研究模式 / ${r.backtests} 条回测`);
}

/**
 * 从最新种子强制刷新所有模式的元数据与回测（含复利/非复利收益），覆盖回测版本，
 * 但保留关注状态与每日跟踪/事件。用于种子更新后让已建库的现网立即生效。
 */
export function reseedResearchModes(): { modes: number; backtests: number } {
  const entries = readSeed();
  if (!entries) return { modes: 0, backtests: 0 };
  const r = importEntries(entries, true);
  console.log(`[reseed] 已刷新 ${r.modes} 个研究模式 / ${r.backtests} 条回测`);
  return r;
}
