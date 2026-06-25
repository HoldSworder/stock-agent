import type { EtfWatchConfig } from '@stock-agent/shared';
import { fetchRealPositions } from '../realPositions';
import { listPool } from '../etf/repo';

// 盯盘标的来源：真实持仓中的场内 ETF ∪ ETF 跟踪池 ∪ 额外白名单。去重，best-effort。

export interface EtfTarget {
  code: string;
  name: string;
}

/** 是否场内 ETF/基金代码（1/5 开头 6 位） */
export function isEtfCode(code: string): boolean {
  return /^[15]\d{5}$/.test(code);
}

/** 汇集本次盯盘标的（去重，取数失败的来源降级跳过） */
export async function collectTargets(cfg: EtfWatchConfig): Promise<EtfTarget[]> {
  const map = new Map<string, string>();

  if (cfg.includePositions) {
    try {
      const pf = await fetchRealPositions(false);
      for (const p of pf.positions) {
        if (p.qty > 0 && isEtfCode(p.code)) map.set(p.code, p.name);
      }
    } catch {
      /* 未配 Cookie 等降级跳过 */
    }
  }

  if (cfg.includePool) {
    try {
      for (const it of listPool()) {
        if (isEtfCode(it.code)) map.set(it.code, it.name);
      }
    } catch {
      /* 降级 */
    }
  }

  for (const raw of (cfg.extraCodes ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (isEtfCode(raw) && !map.has(raw)) map.set(raw, raw);
  }

  return [...map.entries()].map(([code, name]) => ({ code, name }));
}
