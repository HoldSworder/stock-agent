import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SectorDef } from '@stock-agent/shared';

// 赛道资讯：12 大投资赛道（吸收 investment-news）。源清单 sources.json（feedId→{sector,name,url}）
// 已落库到 TrendRadar（feedId 以 iv_ 前缀），本系统经 TrendRadar RSS 工具按 feedId 取数，
// 赛道归属与展示名在此聚合。纯只读资讯，不荐股、不参与交易。

/** 单条源元数据 */
export interface SectorSource {
  sector: string;
  name: string;
  url: string;
}

/** 赛道展示名（顺序即前端展示顺序，对齐 investment-news 的 hint） */
const SECTOR_LABELS: Record<string, string> = {
  ai: 'AI / 大模型',
  semi: '半导体 / 芯片',
  robot: '机器人 / 自动化',
  auto: '汽车 / 新能源车',
  energy: '能源 / 新能源',
  bio: '生物医药 / 健康',
  space: '航天 / 太空',
  security: '网络安全',
  tech: '科技 / 互联网',
  consumer: '消费电子 / 数码',
  macro: '财经 / 宏观',
  science: '科学 / 前沿',
};

/** feedId → 源元数据 */
const SOURCES: Record<string, SectorSource> = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'sources.json'), 'utf-8'),
);

/** sector → feedId[] */
const FEEDS_BY_SECTOR: Record<string, string[]> = {};
for (const [feedId, src] of Object.entries(SOURCES)) {
  (FEEDS_BY_SECTOR[src.sector] ??= []).push(feedId);
}

/** 自检：sources.json 与赛道枚举一致，避免静默错配（启动即抛，符合 trust-boundary 校验） */
for (const sector of Object.keys(FEEDS_BY_SECTOR)) {
  if (!SECTOR_LABELS[sector]) throw new Error(`[sectorintel] 未知赛道 ${sector}，请同步 SECTOR_LABELS`);
}

/** 全部赛道（按 SECTOR_LABELS 顺序，仅含有源的赛道） */
export function listSectors(): SectorDef[] {
  return Object.entries(SECTOR_LABELS)
    .filter(([id]) => (FEEDS_BY_SECTOR[id]?.length ?? 0) > 0)
    .map(([id, label]) => ({ id, label, feedCount: FEEDS_BY_SECTOR[id].length }));
}

/** 某赛道的 feedId 列表（未知赛道返回空） */
export function feedsOf(sector: string): string[] {
  return FEEDS_BY_SECTOR[sector] ?? [];
}

/** 赛道是否存在 */
export function isSector(sector: string): boolean {
  return (FEEDS_BY_SECTOR[sector]?.length ?? 0) > 0;
}

/** 赛道中文名（缺省回退 id） */
export function sectorLabel(sector: string): string {
  return SECTOR_LABELS[sector] ?? sector;
}
