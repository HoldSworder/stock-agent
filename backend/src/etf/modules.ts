import { eq } from 'drizzle-orm';
import type { HomeModule } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { nowIso } from '../util';

// ETF 市场总览 Tab 的面板显隐配置。模块定义集中维护，配置以 JSON 存 settings 表，
// 不污染强类型的 AppSettings。单用户全局配置（自用），仿 market/modules。

const SETTING_KEY = 'etf_modules';

/** 模块定义（id + 展示名 + 默认是否开启）。顺序即总览渲染顺序。 */
export const MODULE_DEFS: ReadonlyArray<{ id: string; label: string; defaultOn: boolean }> = [
  { id: 'overviewStat', label: 'ETF 全市场概览', defaultOn: true },
  { id: 'broadStrip', label: '主流宽基行情条', defaultOn: true },
  { id: 'changeRank', label: '涨跌幅榜', defaultOn: true },
  { id: 'turnoverRank', label: '成交额榜', defaultOn: true },
  { id: 'aumRank', label: '规模榜', defaultOn: true },
  { id: 'moneyflow', label: '主力资金流榜', defaultOn: true },
  { id: 'themeCat', label: '主题赛道分类', defaultOn: true },
];

function readOverrides(): Record<string, boolean> {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, SETTING_KEY))
    .get();
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value) as Record<string, boolean>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 合并默认与已存配置，返回完整模块列表 */
export function getModules(): HomeModule[] {
  const overrides = readOverrides();
  return MODULE_DEFS.map((m) => ({
    id: m.id,
    label: m.label,
    enabled: m.id in overrides ? Boolean(overrides[m.id]) : m.defaultOn,
  }));
}

/** 落库模块显隐配置（仅接受已知模块 id） */
export function setModules(patch: Record<string, boolean>): HomeModule[] {
  const known = new Set(MODULE_DEFS.map((m) => m.id));
  const current = readOverrides();
  for (const [id, on] of Object.entries(patch)) {
    if (known.has(id)) current[id] = Boolean(on);
  }
  const now = nowIso();
  db.insert(schema.settings)
    .values({ key: SETTING_KEY, value: JSON.stringify(current), updatedAt: now })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: JSON.stringify(current), updatedAt: now },
    })
    .run();
  return getModules();
}
