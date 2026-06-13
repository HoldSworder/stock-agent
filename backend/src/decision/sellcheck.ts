import type { DecisionResult, StreamEvent } from '@stock-agent/shared';
import { fetchRealPositions } from '../realPositions';
import { mapDecisionToVerdict, runDecisionBatch } from './service';

// 真实持仓「卖点检查」的共享程序化流程：逐只个股串行跑多 agent 辩论并汇总。
// 同时供 analyze kind（real-positions，前端持仓页弹窗）与决策模块卖点定时复用，避免重复逻辑（DRY）。

/** 仅个股（主板/创业板，前缀 0/3/6）；剔除 ETF/场内基金(前缀 1/5)，决策引擎仅适配 A 股个股 */
export function isIndividualStock(code: string): boolean {
  return /^[036]\d{5}$/.test(code);
}

/** 取可参与逐只辩论的真实股票持仓（剔除场外基金与 ETF） */
export async function loadDebatableStockPositions() {
  const pf = await fetchRealPositions();
  return pf.positions.filter((p) => isIndividualStock(p.code));
}

export interface SellCheckReport {
  /** 汇总研判正文（综合摘要 + 逐只辩论结论） */
  outputText: string;
  /** 各股决策原始结果 */
  results: DecisionResult[];
  /** 需重点处理（减/清仓）只数 */
  alertCount: number;
}

/**
 * 真实持仓卖点检查：逐只个股串行多 agent 辩论 → 汇总综合研判。
 * 无可辩论个股持仓时抛错（由调用方收口为前端错误或 cron 静默跳过）。
 */
export async function debateRealPositions(
  opts: { onEvent?: (e: StreamEvent) => void; signal?: AbortSignal } = {},
): Promise<SellCheckReport> {
  const stocks = await loadDebatableStockPositions();
  if (stocks.length === 0) {
    throw new Error('当前无可辩论的个股持仓（已剔除场外基金与 ETF），无需分析');
  }
  const results = await runDecisionBatch(
    stocks.map((p) => ({ code: p.code, name: p.name, context: '真实持仓卖点检查' })),
    { onEvent: opts.onEvent, signal: opts.signal, purpose: 'sellcheck' },
  );

  const verdicts = results.map((r) => ({ r, v: mapDecisionToVerdict(r) }));
  const alerts = verdicts.filter((x) => x.v.shouldAlert);
  const summaryLines = verdicts.map(
    ({ r, v }) => `- ${r.name}(${r.code})：${v.verdict}（置信度 ${r.confidence}）`,
  );
  const head =
    `# 真实持仓卖点检查（多 agent 辩论，共 ${results.length} 只）\n\n` +
    `## 处置概览\n${summaryLines.join('\n')}\n\n` +
    (alerts.length > 0
      ? `## 需重点处理（${alerts.length} 只）\n${alerts
          .map((x) => `- ${x.r.name}(${x.r.code})：${x.v.verdict}`)
          .join('\n')}\n\n`
      : '## 需重点处理\n暂无明确减/清仓信号，整体可持有观察。\n\n');
  const detail = results.map((r) => r.narrative).join('\n\n---\n\n');

  return {
    outputText: `${head}## 逐只辩论结论\n\n${detail}`,
    results,
    alertCount: alerts.length,
  };
}
