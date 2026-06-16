import type {
  ScorePart,
  SentimentComponents,
  SentimentLevel,
  SentimentOverview,
  SentimentPhase,
  StrengthBreakdown,
} from '@stock-agent/shared';
import { nowIso, shanghaiToday } from '../util';
import { fetchSentimentComponents } from './data';
import { getPrevIndex, upsertSnapshot } from './repo';

// S1 市场情绪周期合成（确定性、规则化、零量化知识）：
// 把两源原始情绪指标按透明权重合成 0-100 情绪指数，再结合「水位高低 + 日间方向」判周期阶段，
// 给出白话仓位倾向。所有分项贡献可审计（breakdown），缺失分项按可用权重重归一，整体不阻断。

const clamp = (v: number, lo = 0, hi = 100): number => Math.min(Math.max(v, lo), hi);

/** 单个分项：原始 0-100 子分 + 权重 + 展示名（value=null 表示该源缺失，参与重归一时剔除） */
interface SubScore {
  label: string;
  value: number | null;
  weight: number;
}

/** 由原始构成算各分项子分（每项 0-100，含正向与反向惩罚项） */
function computeSubScores(c: SentimentComponents): SubScore[] {
  // 广度/赚钱效应：上涨家数占比
  let breadth: number | null = null;
  if (c.up != null && c.down != null) {
    const denom = c.up + c.down + (c.flat ?? 0);
    if (denom > 0) breadth = (c.up / denom) * 100;
  }

  // 涨停强度：真实涨停（缺失回退含一字涨停），120 只≈极热封顶
  const limitUpRaw = c.realLimitUp ?? c.limitUp;
  const limitUpStrength = limitUpRaw != null ? clamp((limitUpRaw / 120) * 100) : null;

  // 连板高度：最高连板，8 板封顶为满分
  const heightScore = c.maxStreak != null ? clamp((c.maxStreak / 8) * 100) : null;

  // 炸板率惩罚（反向）：炸板率越低越健康
  const brokenScore = c.brokenRate != null ? clamp(100 - c.brokenRate) : null;

  // 跌停恐慌惩罚（反向）：真实跌停（缺失回退跌停），40 只≈极度恐慌
  const limitDownRaw = c.realLimitDown ?? c.limitDown;
  const panicScore = limitDownRaw != null ? clamp(100 - (limitDownRaw / 40) * 100) : null;

  return [
    { label: '赚钱效应·上涨广度', value: breadth, weight: 30 },
    { label: '市场活跃度', value: c.activity != null ? clamp(c.activity) : null, weight: 15 },
    { label: '涨停强度', value: limitUpStrength, weight: 20 },
    { label: '连板高度', value: heightScore, weight: 15 },
    { label: '炸板率(反向)', value: brokenScore, weight: 10 },
    { label: '跌停恐慌(反向)', value: panicScore, weight: 10 },
  ];
}

/** 按可用分项权重重归一，合成 0-100 指数；返回指数 + 各分项对指数的贡献点数（可审计，合计≈指数） */
function synthesize(subs: SubScore[]): { index: number; breakdown: StrengthBreakdown } {
  const avail = subs.filter((s) => s.value != null);
  const totalWeight = avail.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) {
    return { index: 50, breakdown: { total: 50, parts: [{ label: '数据缺失·默认中性', value: 50 }] } };
  }
  const parts: ScorePart[] = subs.map((s) => {
    const contrib = s.value != null ? (s.value * s.weight) / totalWeight : 0;
    return {
      label: s.value != null ? s.label : `${s.label}（缺）`,
      value: Math.round(contrib * 10) / 10,
    };
  });
  const index = Math.round(avail.reduce((sum, s) => sum + (s.value as number) * s.weight, 0) / totalWeight);
  return { index, breakdown: { total: index, parts } };
}

/** 水位档位：仅按指数高低分档 */
function classifyLevel(index: number): SentimentLevel {
  if (index >= 80) return '高潮';
  if (index >= 60) return '活跃';
  if (index >= 40) return '平稳';
  if (index >= 20) return '低迷';
  return '冰点';
}

/** 周期阶段：高/低位优先定性，中间区间按日间方向（±3 阈值滤噪）判恢复/退潮/震荡 */
function classifyPhase(index: number, delta: number | null): SentimentPhase {
  if (index >= 80) return '高潮';
  if (index <= 20) return '冰点';
  if (delta != null && delta >= 3) return '恢复';
  if (delta != null && delta <= -3) return '退潮';
  return '震荡';
}

/** 白话仓位倾向（按周期阶段，零量化术语） */
function buildAdvice(phase: SentimentPhase): string {
  switch (phase) {
    case '高潮':
      return '情绪过热：谨慎追高，分批兑现盈利、严守纪律，新仓只打最确定的龙头，警惕高位炸板。';
    case '冰点':
      return '情绪冰点：以空仓/轻仓观望为主，等恢复信号（涨停回升、炸板率下降）出现再小仓试错。';
    case '恢复':
      return '情绪修复回暖：可小仓试错强势主线龙头，跟随趋势但快进快出，不重仓。';
    case '退潮':
      return '情绪退潮：逐步降低仓位、止盈兑现，避免逆势加仓，等下一轮启动。';
    default:
      return '情绪中性震荡：控制仓位、聚焦主线龙头，不追高也不恐慌，等待方向明朗。';
  }
}

/**
 * 组装市场情绪周期总览（确定性只读 + 落库当日快照供方向判定与历史趋势）。
 * @param persist 是否写入当日快照（GET 与收盘定时均写，按日 upsert 幂等）
 */
export async function buildSentimentOverview(persist = true): Promise<SentimentOverview> {
  const { components, stale } = await fetchSentimentComponents();
  const subs = computeSubScores(components);
  const { index, breakdown } = synthesize(subs);

  const tradeDate = shanghaiToday();
  const prevIndex = getPrevIndex(tradeDate);
  const delta = prevIndex != null ? index - prevIndex : null;

  const level = classifyLevel(index);
  const phase = classifyPhase(index, delta);
  const advice = buildAdvice(phase);

  if (persist) {
    upsertSnapshot({
      tradeDate,
      index,
      level,
      phase,
      activity: components.activity,
      maxStreak: components.maxStreak,
      breakdown,
      components,
    });
  }

  return {
    asOf: nowIso(),
    tradeDate,
    index,
    level,
    phase,
    prevIndex,
    delta: delta != null ? Math.round(delta * 10) / 10 : null,
    breakdown,
    components,
    advice,
    note:
      '市场情绪周期（S1 短线择时总开关，确定性合成，仅供参考，不构成投资建议）。' +
      (stale ? '⚠️ 部分数据源降级，指数为不完整估计。' : ''),
    stale,
  };
}

/** 情绪周期文本摘要（注入 agent 研判/今日计划的确定性底稿） */
export function formatForAgent(ov: SentimentOverview): string {
  const c = ov.components;
  const dir = ov.delta == null ? '—' : `${ov.delta >= 0 ? '+' : ''}${ov.delta}`;
  const parts = ov.breakdown.parts
    .filter((p) => !p.label.includes('缺'))
    .map((p) => `${p.label} ${p.value}`)
    .join('｜');
  return (
    `市场情绪周期（${ov.tradeDate}${ov.stale ? '·数据降级' : ''}）\n` +
    `情绪指数 ${ov.index}/100 ｜水位【${ov.level}】｜周期【${ov.phase}】｜较上一交易日 ${dir}\n` +
    `构成：${parts}\n` +
    `原始：上涨${c.up ?? '—'}/下跌${c.down ?? '—'}｜真实涨停${c.realLimitUp ?? c.limitUp ?? '—'}｜` +
    `真实跌停${c.realLimitDown ?? c.limitDown ?? '—'}｜最高${c.maxStreak ?? '—'}连板｜炸板率${c.brokenRate != null ? c.brokenRate.toFixed(1) + '%' : '—'}｜活跃度${c.activity != null ? c.activity + '%' : '—'}\n` +
    `仓位倾向：${ov.advice}`
  );
}
