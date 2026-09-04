import type {
  BoardActionTag,
  BoardCycleFit,
  BoardWorkbench,
  BoardWorkbenchDetail,
  BoardWorkbenchItem,
  MainlineConsensusItem,
  ThemePhase,
} from '@stock-agent/shared';
import { cached } from '../lib/ttlCache';
import { shanghaiDateStr } from '../market/calendar';
import { buildMainlineConsensus } from '../breadth/consensus';
import { buildBreadthOverview } from '../breadth/service';
import { resolveBoardPicks } from './resolver';
import { computeBoardExposure } from './exposure';

// 板块主线作战台（唯一聚合产物，确定性只读，不下单/不调 LLM）：
// 包装 buildMainlineConsensus（以 breadth 新高宽度为确定性锚 ⋈ themes 多源协同 ⋈ radar 中线趋势），
// 投影为带操盘动作/周期/风险标签的决策卡片。不新造板块判断源——所有阶段/强度均源自共识产物，
// 以 boardCode 为跨源/跨页稳定键，保证首页、大盘、持仓、AI 各处板块口径一致。

/**
 * 派生操盘动作标签：以 breadth 阶段硬路由为准，themes/radar 只能在阶段许可范围内「降级」，不能越级放行。
 * 旧版直接用 themePhase/consensus 拼启发式，会出现「宽度锚已退幕但多源协同还在走强 → 标成加仓候选」这种越权。
 * 现在退幕一律回避、分歧一律只减不加，主升/酝酿内部再按协同强弱细分。
 */
function deriveActionTag(it: MainlineConsensusItem): BoardActionTag {
  const rising = it.themeTrend === 'rising';
  const hot = it.themePhase === '加速' || it.themePhase === '启动';
  switch (it.breadthAction) {
    case 'exit_only':
      return '回避';
    case 'hold_only':
      return '减仓';
    case 'lead':
      // 主升：允许追领涨；多源协同同时走强才提示加仓候选，否则只持有
      if (it.themePhase === '退潮' || it.consensus === 'diverge') return '减仓';
      return (rising || hot) && it.consensus === 'resonance' ? '加仓候选' : '持有';
    case 'probe':
      // 酝酿：最多小仓试错，任何情况下不给加仓候选
      if (it.themePhase === '退潮' || it.consensus === 'diverge') return '观察';
      return rising ? '试错' : '观察';
    default:
      return '等待';
  }
}

/** 派生周期视角（与生命周期阶段正交）：启动/加速偏短线，共振偏中线，其余波段 */
function deriveCycleFit(it: MainlineConsensusItem): BoardCycleFit {
  if (it.themePhase === '加速' || it.themePhase === '启动') return '短线';
  if (it.consensus === 'resonance') return '中线';
  return '波段';
}

/** 派生风险标签：退幕 / 核心股换血 / 退潮 / 分歧背离 / 强度走弱 / 拥挤（长期居首） */
function deriveRiskTags(it: MainlineConsensusItem): string[] {
  const tags: string[] = [];
  if (it.breadthStage === 'fading') tags.push('宽度退幕');
  // 核心股换了一批但新高数还在：典型的轮动噪声伪装成持续主线
  if (it.continuity && it.continuity.overlap != null && it.continuity.overlap < 0.5) {
    tags.push('核心股换血');
  }
  if (it.themePhase === '退潮') tags.push('退潮');
  if (it.consensus === 'diverge') tags.push('分歧背离');
  if (it.themeTrend === 'falling') tags.push('强度走弱');
  // ponytail: 拥挤用「居首天数≥5」近似（长期霸榜易过热），后续可接换手/拥挤度指标细化
  if ((it.topDays ?? 0) >= 5) tags.push('拥挤');
  return tags;
}

/** 组装板块作战台：共识产物 → 决策卡片投影（派生操盘标签）。 */
export async function buildBoardWorkbench(): Promise<BoardWorkbench> {
  const consensus = await buildMainlineConsensus();
  const items: BoardWorkbenchItem[] = consensus.items.map((it) => ({
    boardCode: it.boardCode,
    board: it.board,
    phase: (it.themePhase as ThemePhase | null) ?? null,
    strength: it.themeStrength,
    strengthTrend: it.themeTrend,
    consensus: it.consensus,
    stage: it.breadthStage,
    stageAction: it.breadthAction,
    etf: it.etf,
    actionTag: deriveActionTag(it),
    cycleFit: deriveCycleFit(it),
    riskTags: deriveRiskTags(it),
    evidenceNote: it.note,
  }));
  return {
    asOf: consensus.asOf,
    items,
    note: '板块作战台：由主线共识推出（板块创新高表现 + 多源协同 + 中线趋势），给出操盘动作/周期/风险标签，仅研判不下单，仅供参考。',
  };
}

/** 派生失效条件（研判级，非硬规则）：锚失效 / 强度转弱 / ETF 破位 */
function deriveInvalidators(item: BoardWorkbenchItem): string[] {
  const list = ['板块跌出「创新高表现」确认（主线基准失效）'];
  if (item.strengthTrend !== 'falling') list.push('多源协同强度转为走弱（rising/flat → falling）');
  if (item.etf) list.push(`${item.etf.name} 跌破关键均线（代表 ETF 趋势破位）`);
  return list;
}

/**
 * 组装板块详情（作战台下钻）：workbench 主干 + 龙头/补涨标的解析 + 持仓暴露 + 失效条件。
 * AI 行动建议（aiAction）为按需生成，此处置 null（由 board-detail kind 单独产出）。
 * @returns 找不到该 boardCode 的锚板块时返回 null（供路由 404）
 */
export async function buildBoardDetail(boardCode: string): Promise<BoardWorkbenchDetail | null> {
  const wb = await buildBoardWorkbench();
  const item = wb.items.find((it) => it.boardCode === boardCode);
  if (!item) return null;

  // boardCode → kind（东财成分接口按行业/概念区分），从 breadth 概览取
  const breadthOv = await cached('breadth:overview', 30 * 60_000, () => buildBreadthOverview()).catch(
    () => null,
  );
  const kind = (breadthOv?.items ?? []).find((b) => b.boardCode === boardCode)?.kind;

  const picks = kind
    ? await resolveBoardPicks(kind, item.board).catch(() => ({ leaders: [], laggards: [] }))
    : { leaders: [], laggards: [] };
  const expo = await computeBoardExposure(boardCode).catch(() => null);

  return {
    item,
    leaders: picks.leaders,
    laggards: picks.laggards,
    invalidators: deriveInvalidators(item),
    exposure: expo?.holdings ?? [],
    aiAction: null,
    snapshotDate: shanghaiDateStr(new Date()),
    note: '板块详情：龙头/补涨按规则排序，「我的持仓」取主线成分与持仓的交集，仅供参考不下单。',
  };
}
