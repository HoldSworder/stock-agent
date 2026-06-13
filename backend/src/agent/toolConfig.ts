import { eq } from 'drizzle-orm';
import type { ToolConfigUpdate } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { nowIso } from '../util';

// Agent 工具覆盖配置：启停 + 描述覆盖。
// 仿 auth.ts 直接读写 settings 表的单行 JSON（key=tool_overrides），不污染 settings.ts 的 KEYS 映射。

const OVERRIDES_KEY = 'tool_overrides';

export interface ToolOverride {
  /** 是否启用（缺省视为 true） */
  enabled?: boolean;
  /** 覆盖下发给 LLM 的描述（缺省/空串=用代码默认） */
  description?: string;
  /** 覆盖是否为常驻核心工具（缺省=用代码默认 DEFAULT_CORE_TOOL_NAMES） */
  core?: boolean;
}

export type ToolOverrideMap = Record<string, ToolOverride>;

/** 读取全部工具覆盖配置；解析失败按空配置处理 */
export function getOverrides(): ToolOverrideMap {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, OVERRIDES_KEY))
    .get();
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as ToolOverrideMap) : {};
  } catch {
    return {};
  }
}

/** 写入指定工具的覆盖配置（合并更新）；description 传空串=清除覆盖回落默认 */
export function setOverride(name: string, patch: ToolConfigUpdate): ToolOverrideMap {
  const map = getOverrides();
  const cur: ToolOverride = map[name] ?? {};
  const next: ToolOverride = { ...cur };
  if (patch.enabled != null) next.enabled = patch.enabled;
  if (patch.description != null) {
    const trimmed = patch.description.trim();
    if (trimmed) next.description = trimmed;
    else delete next.description; // 空串=清除覆盖
  }
  if (patch.core != null) next.core = patch.core;
  // 全默认（启用、无描述覆盖、无核心覆盖）则不留垃圾键
  if (next.enabled !== false && !next.description && next.core == null) delete map[name];
  else map[name] = next;

  const value = JSON.stringify(map);
  const now = nowIso();
  db.insert(schema.settings)
    .values({ key: OVERRIDES_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: now } })
    .run();
  return map;
}
