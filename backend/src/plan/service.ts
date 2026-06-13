import type {
  DailyPlan,
  DailyPlanDetail,
  DailyPlanItem,
  MarketStance,
  PlanAssetType,
  PlanFocusSector,
  PlanItemStatus,
  PlanTrigger,
} from '@stock-agent/shared';
import { isIndividualStock } from '../decision/sellcheck';
import { mapDecisionToVerdict, runDecisionBatch } from '../decision/service';
import { shanghaiToday } from '../util';
import * as repo from './repo';

// 今日计划业务封装：按 Asia/Shanghai 推算当日，负责生成落库（save）、盘中读取/对照（get/update）、
// 收盘复盘回填（close），以及给 agent 看的纯文本格式化。

export const PLAN_GEN_TASK_NAME = '今日计划-0830-生成';
export const PLAN_REVIEW_TASK_NAME = '今日计划-1530-收盘复盘';

/** 盘前生成 prompt：以四模块最新持久化 AI 分析为基准，妙想筛选校验，落结构化计划 */
export const PLAN_GEN_PROMPT =
  '生成今日 A 股【作战计划】：以热点/研报/大盘/复盘四个模块【最新一次产出的 AI 分析】为基准，用妙想筛选并校验候选标的，串成一份可被盘中盯盘程序化执行的结构化计划。本任务仅研判规划，不下单。\n\n' +
  '交易日校验（默认放行）：仅周一至周五触发，默认按交易日执行；接口异常一律按交易日继续，不据此判休市。\n\n' +
  '第1步 读基准（核心）：调用 get_plan_context 一次性取四源最新 AI 分析——①热点研判 ②研报机会 ③大盘复盘点评 ④一键复盘（综合方向/外围/主线/次日策略，含「明日重点关注」「强势板块/个股候选」「风险清单」）。' +
  '严禁再现场重跑 trendradar_hotspots(summary) 或 research_reports(discover) 等重型分析；本计划以这四份已产出的分析为唯一基准。某源若标注缺失或非当日产出，照常使用但在 narrative 风险项注明时效。\n' +
  '第2步 提炼主线：综合四源，确定今日大环境方向(bias)、建议仓位、关键支撑/压力、重点主线与板块、隔夜外围与政策要点；把复盘「风险清单」并入今日计划风险提示。优先采纳复盘综合方向与研报机会主线的交集作为高确定性方向。\n' +
  '第3步 妙想列计划：基于第2步提炼的主线/板块及四源给出的个股候选（研报机会个股、复盘强势个股、热点受益方向），用 mx_screener 自然语言筛选今日候选标的（限定主板/创业板：60/000/001/002/003/300/301 开头，排除 ST、科创板 688/689、北交所 8/4 开头，结合量比/成交额/资金净流入/均线等量价条件）；' +
  '同时用 real_positions 读真实持仓（只读）、mx_self_select(get) 读自选股，把需要重点对照的持仓/自选标的一并纳入候选，标注其 source。\n' +
  '第4步 校验触发价：对候选标的用 mx_finance_data 批量校验现价/涨跌停价，据此为每只给出真实可执行的结构化触发价（买/卖/损/盈）；价位务必基于校验过的真实数据，不得凭空编造。\n' +
  '第4.5步 ETF 计划项：用 etf_signals(action=signals) 取 ETF 跟踪池量化信号（估值分位/折溢价/动量排名/网格水位/操作建议与结构化触发价）；把命中买入区（建议 buy/add）或减仓·止盈区（建议 reduce）的 ETF 一并纳入下方 items——direction 映射为 buy/hold/reduce/sell，source 填 other，并直接采用 etf_signals 返回的 buyTrigger/sellTrigger/stopLoss/takeProfit 作为结构化触发价（折溢价标注缺失的，可用 mx_finance_data 补 IOPV 再定夺追高风险）。处于持有/规避的 ETF 不必入计划。\n' +
  '第5步 综合落库：把上面信息综合成结构化计划，调用 save_today_plan 一次性落库——\n' +
  '  - marketStance：方向(bias)/建议仓位(positionPct)/关键支撑(support)/压力(resistance)/一句话定调(summary)；\n' +
  '  - focusSectors：今日重点板块（名称+强度阶段+理由）；\n' +
  '  - externalContext：隔夜外围与政策要点；\n' +
  '  - items：每只标的给 code/name/direction(buy/hold/reduce/sell/watch)/thesis(逻辑，注明来自热点/研报/复盘哪一源)/source(research/hotspot/sector/position/watchlist)/positionHint，' +
  '并尽量给结构化触发价 buyTrigger/sellTrigger/stopLoss/takeProfit（{type:"price|breakout|pullback", value:数字, note}），触发价务必用 mx_finance_data 校验过的真实价位；\n' +
  '  - narrative：给人看的完整作战图（Markdown，含大盘定调、板块主线、逐只标的计划、各源时效与风险提示）。\n' +
  '注意：个股只可选主板/创业板标的（60/000/001/002/003/300/301 开头），排除科创板(688/689)与北交所(8/4 开头)；ETF 跟踪池标的（基金代码，如 15/51/56/58 开头）不受此个股板块限制，按 etf_signals 信号纳入。落库后简要汇报计划概要即可，平台会自动推送 narrative。';

/** 旧版盘前生成 prompt（现场重跑各模块）：仅供种子迁移识别覆盖，勿用于运行 */
export const PLAN_GEN_PROMPT_LEGACY =
  '生成今日 A 股【作战计划】，把研报/热点/板块/持仓/大盘/外围串成一份可被盘中盯盘程序化执行的结构化计划。本任务仅研判规划，不下单。\n\n' +
  '交易日校验（默认放行）：仅周一至周五触发，默认按交易日执行；接口异常一律按交易日继续，不据此判休市。\n\n' +
  '第1步 大环境趋势 + 复盘继承：先用 get_latest_review_stance 取上一交易日复盘核心结论——' +
  '既作为大环境趋势基准（综合方向/定调/外围影响），也把其中的「明日重点关注」「强势板块/个股候选」「值得关注自选」作为今日计划的候选标的来源之一，' +
  '并把复盘「风险清单」并入今日计划的风险提示；' +
  '再用 trendradar_hotspots(action=summary 或 trending) 取隔夜美股/港股/政策与全网热点；结合二者提炼对今日 A 股的方向影响。\n' +
  '第2步 研报机会：用 research_reports(action=discover, days=1) 取当日新研报聚合，找出被密集上调/覆盖的板块与个股机会线索。\n' +
  '第3步 大盘与板块：用 market_snapshot 读大盘指数/成交额/情绪温度/涨停梯队/板块资金流与领涨领跌，定调今日方向与建议仓位。\n' +
  '第4步 持仓与自选：用 real_positions 读真实持仓（只读）、mx_self_select(get) 读自选股，标注需重点对照的标的。\n' +
  '第4.5步 ETF 计划项：用 etf_signals(action=signals) 取 ETF 跟踪池量化信号（估值分位/折溢价/动量排名/网格水位/操作建议与结构化触发价）；把命中买入区（建议 buy/add）或减仓·止盈区（建议 reduce）的 ETF 一并纳入下方 items——direction 映射为 buy/hold/reduce/sell，source 填 other，并直接采用 etf_signals 返回的 buyTrigger/sellTrigger/stopLoss/takeProfit 作为结构化触发价（折溢价标注缺失的，可用 mx_finance_data 补 IOPV 再定夺追高风险）。处于持有/规避的 ETF 不必入计划。\n' +
  '第5步 综合落库：把上面信息综合成结构化计划，调用 save_today_plan 一次性落库——\n' +
  '  - marketStance：方向(bias)/建议仓位(positionPct)/关键支撑(support)/压力(resistance)/一句话定调(summary)；\n' +
  '  - focusSectors：今日重点板块（名称+强度阶段+理由）；\n' +
  '  - externalContext：隔夜外围与政策要点；\n' +
  '  - items：每只标的给 code/name/direction(buy/hold/reduce/sell/watch)/thesis(逻辑)/source(research/hotspot/sector/position/watchlist)/positionHint，' +
  '并尽量给结构化触发价 buyTrigger/sellTrigger/stopLoss/takeProfit（{type:"price|breakout|pullback", value:数字, note}），触发价务必用 market_snapshot/mx_finance_data 校验过的真实价位；\n' +
  '  - narrative：给人看的完整作战图（Markdown，含大盘定调、板块主线、逐只标的计划、风险提示）。\n' +
  '注意：个股只可选主板/创业板标的（60/000/001/002/003/300/301 开头），排除科创板(688/689)与北交所(8/4 开头)；ETF 跟踪池标的（基金代码，如 15/51/56/58 开头）不受此个股板块限制，按 etf_signals 信号纳入。落库后简要汇报计划概要即可，平台会自动推送 narrative。';

/** 收盘复盘 prompt：计划 vs 实际，回填 + 闭环 */
export const PLAN_REVIEW_PROMPT =
  '对今日【作战计划】做收盘复盘闭环。本任务只复盘不下单。\n\n' +
  '交易日校验（默认放行）：仅周一至周五触发，默认按交易日执行；接口异常一律按交易日继续。\n\n' +
  '第1步 读计划：用 get_today_plan 读今日计划（含各标的方向/触发价/盘中已触发状态与备注）。若今日无计划，直接说明并结束。\n' +
  '第2步 读实际：用 real_positions 读真实持仓，用 market_snapshot 看收盘盘面；对计划内标的用 mx_finance_data 核验当日表现。\n' +
  '第3步 逐项评估：对每只计划标的判断「计划 vs 实际」——是否触发、是否兑现、结果对错；调用 update_plan_item(code, status, note) 回写：' +
  '已按计划完成/已了结=done，逻辑已破坏/全天未触发且失效=invalid，仍有效待续=保持 pending，note 写一句结果点评。\n' +
  '第4步 收盘归档：调用 close_today_plan(reviewSummary) 回填复盘总结。reviewSummary 用 Markdown 覆盖：①大盘与情绪小结 ②计划命中率与得失 ' +
  '③逐只标的结果 ④战法/打法改进建议 ⑤次日预案草稿（重点关注方向与应对）。\n' +
  '推送禁止 Markdown 表格，用竖排清单。';

/** 当日（Asia/Shanghai）计划主记录，无则 null */
export function getTodayPlan(): DailyPlan | null {
  return repo.getPlanByDate(shanghaiToday());
}

/** 当日生效计划的标的项（供盯盘引擎并池；非 active 或无计划返回空） */
export function getActivePlanItems(): DailyPlanItem[] {
  const plan = getTodayPlan();
  if (!plan || plan.status !== 'active') return [];
  return repo.listItems(plan.id);
}

/** 某日完整详情（计划+标的+事件） */
export function getDetailByDate(date: string): DailyPlanDetail | null {
  const plan = repo.getPlanByDate(date);
  if (!plan) return null;
  return { plan, items: repo.listItems(plan.id), events: repo.listEvents(plan.id) };
}

/** 当日完整详情 */
export function getTodayDetail(): DailyPlanDetail | null {
  return getDetailByDate(shanghaiToday());
}

/** 历史计划摘要列表（按计划日倒序，供历史抽屉） */
export function listSummaries(limit?: number) {
  return repo.listPlanSummaries(limit);
}

export interface SavePlanItemInput {
  code: string;
  name: string;
  assetType?: PlanAssetType;
  direction?: DailyPlanItem['direction'];
  thesis?: string;
  buyTrigger?: PlanTrigger | null;
  sellTrigger?: PlanTrigger | null;
  stopLoss?: PlanTrigger | null;
  takeProfit?: PlanTrigger | null;
  positionHint?: string;
  source?: DailyPlanItem['source'];
  priority?: number;
}

export interface SavePlanInput {
  marketStance?: MarketStance | null;
  focusSectors?: PlanFocusSector[];
  externalContext?: string;
  narrative?: string;
  items?: SavePlanItemInput[];
}

/** 盘前生成：按当日 upsert 计划主记录并全量替换标的项，记 created/regenerated 事件 */
export function savePlan(input: SavePlanInput, runId: string | null): DailyPlanDetail {
  const date = shanghaiToday();
  const existed = repo.getPlanByDate(date);
  const planId = repo.upsertPlan({
    planDate: date,
    status: 'active',
    marketStance: input.marketStance ?? null,
    focusSectors: input.focusSectors ?? [],
    externalContext: input.externalContext ?? '',
    narrative: input.narrative ?? '',
    runId,
  });
  if (input.items) repo.replaceItems(planId, input.items);
  repo.appendEvent({
    planId,
    kind: existed ? 'regenerated' : 'created',
    payload: { itemCount: input.items?.length ?? 0 },
    runId,
  });
  return getDetailByDate(date)!;
}

/**
 * 落库后增强：对当日计划中的【个股】候选（剔除 ETF）逐只串行跑多 agent 辩论（决策引擎），
 * 把辩论结论回写到对应 item（debateVerdict/debateConfidence/debateNote）并在 narrative 追加辩论摘要段。
 * 「始终自动」：计划生成完成后调用。无个股候选则直接返回 0。失败不抛（best-effort，不拖垮计划生成）。
 * 返回成功回写的标的数。
 */
export async function enrichTodayPlanWithDebate(runId: string | null): Promise<number> {
  const plan = getTodayPlan();
  if (!plan) return 0;
  const items = repo.listItems(plan.id);
  // 仅个股（剔除 ETF/场内基金）；方向不限（buy/hold/reduce/sell/watch 均做研判）；按 code 去重
  const seen = new Set<string>();
  const stocks = items.filter((it) => {
    if (it.assetType === 'etf' || !isIndividualStock(it.code) || seen.has(it.code)) return false;
    seen.add(it.code);
    return true;
  });
  if (stocks.length === 0) return 0;

  let results;
  try {
    results = await runDecisionBatch(
      stocks.map((it) => ({ code: it.code, name: it.name, context: '今日计划候选研判' })),
      { purpose: 'plan-debate' },
    );
  } catch (e) {
    console.warn('[plan] 候选辩论增强失败:', e instanceof Error ? e.message : e);
    return 0;
  }

  const byCode = new Map(results.map((r) => [r.code, r]));
  const lines: string[] = [];
  for (const it of stocks) {
    const r = byCode.get(it.code);
    if (!r) continue;
    const v = mapDecisionToVerdict(r);
    repo.updateItemDebate(plan.id, it.code, {
      verdict: v.verdict,
      confidence: r.confidence,
      note: r.thesis,
    });
    lines.push(`- ${it.name}(${it.code})：${v.verdict}（置信度 ${r.confidence}）— ${r.thesis}`);
  }
  if (lines.length === 0) return 0;

  // narrative 追加辩论摘要段（保留原作战图，附多 agent 结论）
  const section = `\n\n## 多 agent 辩论增强（落库后自动，共 ${lines.length} 只个股）\n${lines.join('\n')}`;
  repo.upsertPlan({ planDate: plan.planDate, narrative: (plan.narrative ?? '') + section });
  repo.appendEvent({ planId: plan.id, kind: 'note', payload: { debateEnriched: lines.length }, runId });
  return lines.length;
}

/** 盘中对照回写某标的状态/备注，记 note/trigger_hit 事件 */
export function updateItem(
  code: string,
  status: PlanItemStatus | undefined,
  note: string | null,
  runId: string | null,
): DailyPlanItem | null {
  const plan = getTodayPlan();
  if (!plan) return null;
  const item = repo.updateItemByCode(plan.id, code, { status, note });
  if (!item) return null;
  repo.appendEvent({
    planId: plan.id,
    itemId: item.id,
    kind: status === 'triggered' ? 'trigger_hit' : 'note',
    payload: { code, status, note },
    runId,
  });
  return item;
}

/** 盯盘命中回写：标记 triggered（仅当前为 pending）并记事件 */
export function recordWatchTrigger(
  code: string,
  signalType: string,
  note: string,
  runId: string | null,
): void {
  const plan = getTodayPlan();
  if (!plan) return;
  const items = repo.listItems(plan.id);
  const item = items.find((i) => i.code === code);
  if (!item) return;
  const nextStatus: PlanItemStatus = item.status === 'pending' ? 'triggered' : item.status;
  repo.updateItemByCode(plan.id, code, { status: nextStatus, note });
  repo.appendEvent({
    planId: plan.id,
    itemId: item.id,
    kind: 'trigger_hit',
    payload: { code, signalType, note },
    runId,
  });
}

/** 收盘归档：回填复盘总结并置 closed */
export function closeToday(reviewSummary: string, runId: string | null): boolean {
  const plan = getTodayPlan();
  if (!plan) return false;
  repo.closePlan(plan.id, reviewSummary);
  repo.appendEvent({ planId: plan.id, kind: 'review', payload: { length: reviewSummary.length }, runId });
  return true;
}

const DIR_LABEL: Record<DailyPlanItem['direction'], string> = {
  buy: '买入',
  hold: '持有',
  reduce: '减仓',
  sell: '卖出',
  watch: '观察',
};

const STATUS_LABEL: Record<PlanItemStatus, string> = {
  pending: '待触发',
  triggered: '已触发',
  done: '已完成',
  invalid: '已失效',
};

function fmtTrigger(label: string, t: PlanTrigger | null): string {
  if (!t) return '';
  return ` ${label}${t.value}${t.note ? `(${t.note})` : ''}`;
}

/** 给 agent 看的纯文本计划摘要（get_today_plan 工具输出） */
export function formatPlanForAgent(detail: DailyPlanDetail): string {
  const { plan, items } = detail;
  const lines: string[] = [`今日计划（${plan.planDate}，状态 ${plan.status}）`];
  if (plan.marketStance) {
    const m = plan.marketStance;
    const biasZh = m.bias === 'bull' ? '偏多' : m.bias === 'bear' ? '偏空' : '中性';
    lines.push(
      `大盘研判：${biasZh} | 建议仓位 ${m.positionPct}% | 支撑 ${m.support} | 压力 ${m.resistance}`,
      `定调：${m.summary}`,
    );
  }
  if (plan.focusSectors.length) {
    lines.push(
      '重点板块：' +
        plan.focusSectors.map((s) => `${s.name}(${s.strength})`).join('、'),
    );
  }
  if (plan.externalContext) lines.push(`外围：${plan.externalContext}`);
  lines.push(`标的 ${items.length} 只：`);
  for (const it of items) {
    const trg =
      fmtTrigger('买', it.buyTrigger) +
      fmtTrigger('卖', it.sellTrigger) +
      fmtTrigger('损', it.stopLoss) +
      fmtTrigger('盈', it.takeProfit);
    const typeLabel = it.assetType === 'etf' ? 'ETF' : '个股';
    lines.push(
      `- [${typeLabel}] ${it.name}(${it.code}) [${DIR_LABEL[it.direction]}/${STATUS_LABEL[it.status]}/${it.source}]` +
        `${trg}${it.positionHint ? ` 仓位${it.positionHint}` : ''}` +
        `${it.thesis ? ` 逻辑:${it.thesis}` : ''}` +
        `${it.lastNote ? ` 备注:${it.lastNote}` : ''}`,
    );
  }
  return lines.join('\n');
}
