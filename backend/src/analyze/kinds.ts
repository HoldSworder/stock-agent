import type { AiAnalysisHistoryItem } from '@stock-agent/shared';
import { debateRealPositions, loadDebatableStockPositions } from '../decision/sellcheck';
import {
  listEtfAnalyzeReviews,
  listIntelReviews,
  listMarketBoardReviews,
  listReviews,
} from '../repo';
import { buildDeepReviewPrompt, DEEP_REVIEW_TASK_NAME, onDeepReviewComplete } from '../review/service';
import { buildMarketBoardPrompt, buildOverview, MARKET_BOARD_TASK_NAME } from '../market/overview';
import { ETF_ANALYZE_PROMPT, ETF_ANALYZE_TASK_NAME } from '../etf/service';
import { INTEL_PROMPT, INTEL_TASK_NAME } from '../research/service';
import { listWatch } from '../watchlist';
import type { AnalysisRunCtx, AnalysisRunResult } from './registry';
import { registerKind } from './registry';

// 各分析能力的注册。统一 AI 分析中心（驾驶舱）+ 各业务页弹窗皆据此 kind 复用同一基建。
// 设计要点：
//   - 散文型分析（板块主线/ETF/研报/大盘点评等）走默认 buildPrompt → gateway.agent，
//     由 gateway 落 task_runs（taskName 不变，今日计划照常读取）。
//   - skipAutoSave + loadHistory 用于「外部已持久化」型：历史读 task_runs / trend_summaries，
//     不再双写 ai_analyses，保住今日计划六源读取口径。
//   - onSuccess 承接副作用钩子（如复盘验证回流共享主线）。

/** task_runs 行 → 统一 AI 分析历史条目（仅最终正文，全局作用域 refKey=null） */
function taskRunHistory(
  kind: string,
  rows: Array<{ id: string; createdAt: string; outputText: string | null }>,
): AiAnalysisHistoryItem[] {
  return rows
    .filter((r) => r.outputText)
    .map((r) => ({
      id: r.id,
      kind,
      refKey: null,
      title: null,
      content: r.outputText ?? '',
      createdAt: r.createdAt,
    }));
}

// ===== 持仓：真实持仓多 agent 辩论（已就绪，补 title/group） =====

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
  title: '真实持仓研判',
  group: '持仓',
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
  scheduleRef: { module: 'decision', jobId: 'decision.sellcheck.eod' },
});

// ===== 复盘：一键深度复盘（结构化 JSON，前端用 ReviewResultView 富渲染） =====

registerKind('review', {
  taskName: DEEP_REVIEW_TASK_NAME,
  title: '一键复盘',
  group: '复盘',
  buildPrompt: () => buildDeepReviewPrompt(),
  modelConfig: { thinking: false, maxSteps: 8, maxTokens: 16000 },
  timeoutSec: 420,
  purpose: 'review',
  skipAutoSave: true,
  loadHistory: (limit) => taskRunHistory('review', listReviews(limit)),
  // 复盘验证结论回流共享主线（写 phase/强度/退潮态），与定时复盘共用回调，best-effort
  onSuccess: (text) => onDeepReviewComplete(text),
  scheduleRef: { module: 'review', jobId: 'review.eod' },
});

// ===== 大盘：大盘与板块研判（合并原「大盘复盘点评」+「板块主线研判」） =====
// 一次 agent 同时做大盘复盘点评（据盘面快照）与板块主线研判（取 market_board_strength 确定性底稿），
// 产出一份两段式报告，作为今日计划「大盘 + 板块/中线」基准源。历史 union 旧两源（保历史不丢）。
registerKind('market-board', {
  taskName: MARKET_BOARD_TASK_NAME,
  title: '大盘与板块研判',
  group: '大盘',
  buildPrompt: async () => await buildMarketBoardPrompt(await buildOverview()),
  modelConfig: { thinking: false, maxSteps: 12, maxTokens: 14000 },
  timeoutSec: 600,
  purpose: 'market-review',
  skipAutoSave: true,
  loadHistory: (limit) => taskRunHistory('market-board', listMarketBoardReviews(limit)),
  scheduleRef: { module: 'market', jobId: 'market.boardReview' },
});

// ===== ETF：综合研判（合并原「综合研判」+「行业轮动研判」为单一计划源） =====
// 量化信号 + 持仓 + 消息面操作建议，叠加中线赛道轮动（进攻/回踩/回避）。历史 union 旧轮动/市场点评。
registerKind('etf-analyze', {
  taskName: ETF_ANALYZE_TASK_NAME,
  title: 'ETF 综合研判',
  group: 'ETF',
  buildPrompt: () => ETF_ANALYZE_PROMPT,
  modelConfig: { thinking: false, maxSteps: 14, maxTokens: 14000 },
  timeoutSec: 600,
  purpose: 'analyze',
  skipAutoSave: true,
  loadHistory: (limit) => taskRunHistory('etf-analyze', listEtfAnalyzeReviews(limit)),
  scheduleRef: { module: 'etf', jobId: 'etf.analyze' },
});

// ===== 情报：情报研判（合并原「研报机会」+「全网热点研判」） =====
// 一次 agent 用 research_reports(discover) + trendradar_hotspots(summary) 合成「研报机会 + 全网热点」综合情报，
// 走 runTask 落 task_runs（taskName=情报研判），作为今日计划「情报」基准源。历史 union 旧研报机会。
registerKind('intel', {
  taskName: INTEL_TASK_NAME,
  title: '情报研判',
  group: '情报',
  buildPrompt: () => INTEL_PROMPT,
  modelConfig: { thinking: false, maxSteps: 14, maxTokens: 16000 },
  timeoutSec: 600,
  purpose: 'research',
  skipAutoSave: true,
  loadHistory: (limit) => taskRunHistory('intel', listIntelReviews(limit)),
  scheduleRef: { module: 'research', jobId: 'research.dailyAnalysis' },
});

// ===== 自选：单只研判（perStock）+ 组合轮动研判（global） =====
// 原 server.ts 内联 POST /api/watchlist/:code/analyze 与 /api/watchlist/analyze 两条同步路由收编为统一 kind，
// 复用 /ws/analyze 流式轨迹 + /api/analyses 历史，server.ts 瘦身。默认路径自动落 ai_analyses（按 refKey 作用域）。

/** 自选单只研判 prompt：命中自选则带标签/备注，否则按通用个股研判。 */
function buildWatchlistStockPrompt(params: Record<string, unknown>): string {
  const code = String(params.code ?? '').trim();
  if (!code) throw new Error('缺少标的代码');
  const item = listWatch().find((i) => i.code === code);
  const name = item?.name ?? code;
  return (
    `请对关注标的 ${name}(${code}) 做个股研判：` +
    '用 mx_finance_data 查实时量价/资金流/估值与涨跌停价，用 mx_search 查最新消息面与公告，' +
    (item?.tags ? `结合标签【${item.tags}】所属主线，` : '') +
    (item?.note ? `参考我的备注【${item.note}】，` : '') +
    '给出：当前所处位置与趋势、关键支撑/压力位、买卖点建议、主要风险提示。' +
    '结论精炼、分点、给依据，禁止 Markdown 表格。'
  );
}

registerKind('watchlist-stock', {
  taskName: '自选个股研判',
  title: '自选个股研判',
  group: '持仓',
  scope: 'perStock',
  buildPrompt: buildWatchlistStockPrompt,
  preflight: (p) => {
    if (!String(p.code ?? '').trim()) throw new Error('缺少标的代码');
  },
  deriveRefKey: (p) => String(p.code ?? '').trim() || null,
  modelConfig: { thinking: false, maxSteps: 10 },
  timeoutSec: 300,
});

/** 自选组合轮动研判 prompt：取全部关注标的做组合层面研判。 */
function buildWatchlistComboPrompt(): string {
  const items = listWatch();
  if (items.length === 0) throw new Error('关注列表为空');
  const list = items
    .map((i) => `${i.name}(${i.code})${i.tags ? ` [${i.tags}]` : ''}`)
    .join('、');
  return (
    `以下是我的关注标的清单：${list}。` +
    '请逐只用 mx_finance_data 查实时量价/资金/估值，必要时用 mx_search 补充消息面，' +
    '做一次组合层面的轮动研判：逐只给当前位置与买卖点倾向，再综合排序当前最值得关注/最该回避的标的及理由，并给风险提示。' +
    '结论精炼、分点、给依据，禁止 Markdown 表格。'
  );
}

registerKind('watchlist-combo', {
  taskName: '自选组合研判',
  title: '自选组合研判',
  group: '持仓',
  buildPrompt: buildWatchlistComboPrompt,
  preflight: () => {
    if (listWatch().length === 0) throw new Error('关注列表为空');
  },
  modelConfig: { thinking: false, maxSteps: 12 },
  timeoutSec: 300,
});

// ===== 决策：仅入目录（perStock）。发起仍走 /ws/decision 自有结构化落库，中心只读其 ai_analyses 历史 =====

registerKind('decision', {
  taskName: '多智能体辩论决策',
  title: '多智能体辩论决策',
  group: '决策',
  scope: 'perStock',
  // 决策需个股代码，不在中心一键发起；此处 buildPrompt 仅兜底，正式发起走 /ws/decision。
  // 历史按 refKey（个股代码）作用域读 ai_analyses，沿用默认 listAnalyses（不设 loadHistory）。
  buildPrompt: () => {
    throw new Error('决策分析需指定个股，请到决策页发起');
  },
});
