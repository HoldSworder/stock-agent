import type { Strategy } from '@stock-agent/shared';
import { listStrategies } from '../strategy/sim';

// 尾盘套利战法解析：按名定位本地战法，避免硬编码 UUID（种子 seedStrategyProfiles 已按同名创建）。
export const WEIPAN_STRATEGY_NAME = '尾盘动能套利';

/** 解析尾盘套利本地战法（未归档 local，按名匹配）；找不到返回 null */
export function resolveWeipanStrategy(): Strategy | null {
  return (
    listStrategies(false).find((s) => s.kind === 'local' && s.name === WEIPAN_STRATEGY_NAME) ?? null
  );
}
