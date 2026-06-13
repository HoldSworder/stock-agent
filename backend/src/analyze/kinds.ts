import { debateRealPositions, loadDebatableStockPositions } from '../decision/sellcheck';
import type { AnalysisRunCtx, AnalysisRunResult } from './registry';
import { registerKind } from './registry';

// 各分析能力的注册。新增模块的 AI 分析：在此 registerKind 即可被通用弹窗复用。

/**
 * 真实持仓卖点检查：逐只个股串行跑多 agent 辩论（五大分析师→多空辩论→风控博弈→组合经理裁决），
 * 汇总各股结论为综合研判。前端持仓页弹窗 kind 不变，自动升级为多 agent。共享流程见 decision/sellcheck。
 */
async function runRealPositionsDebate(
  _params: Record<string, unknown>,
  ctx: AnalysisRunCtx,
): Promise<AnalysisRunResult> {
  const report = await debateRealPositions({ onEvent: ctx.onEvent, signal: ctx.signal });
  return { outputText: report.outputText, refKey: null };
}

registerKind('real-positions', {
  taskName: '真实持仓研判',
  // buildPrompt 保留为兜底/类型完整；实际走 run（多 agent 辩论）
  buildPrompt: async () => '真实持仓卖点检查（多 agent 辩论）',
  preflight: async () => {
    const stocks = await loadDebatableStockPositions();
    if (stocks.length === 0) {
      throw new Error('当前无可辩论的个股持仓（已剔除场外基金与 ETF），无需分析');
    }
  },
  run: runRealPositionsDebate,
  modelConfig: { thinking: false, maxSteps: 12 },
  timeoutSec: 300,
});
