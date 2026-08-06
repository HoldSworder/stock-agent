import type { CandidateCatalog, SymbolTechnicalContext } from '@stock-agent/shared';
import { PHASE_LABEL } from './phase';
import { VOLUME_STATE_LABEL } from './volumePrice';

// 给 LLM 的文本序列化（计划 7.1 的字符预算）。
// 硬约束：技术上下文常态 ≤3000 字符、硬上限 6000；候选目录常态 ≤4000、硬上限 6000。
// 都低于 tools.ts 里 preview() 的 8000 字符静默截断线，避免中段被吃掉。
// 一律不输出原始 K 线数组。

const CONTEXT_SOFT_LIMIT = 3000;
const CATALOG_SOFT_LIMIT = 4000;

/** 超软上限时按行裁尾并显式说明裁掉多少，不做头尾截断 */
function capLines(lines: string[], softLimit: number, what: string): string {
  let out = lines.join('\n');
  if (out.length <= softLimit) return out;
  const budget = softLimit - 80;
  const kept: string[] = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length + 1 > budget) {
      // 首行自身就超预算时不能直接 break——那样 kept 为空，整份内容只剩一行省略提示。
      // 首行是标的与 contextId 这类必需信息，宁可尾部截断也要保住。
      if (kept.length === 0) {
        kept.push(`${l.slice(0, Math.max(1, budget - 20))}…（本行过长已尾部截断）`);
        len += kept[0].length + 1;
      }
      break;
    }
    kept.push(l);
    len += l.length + 1;
  }
  const dropped = lines.length - kept.length;
  kept.push(`…（为控制上下文长度省略 ${dropped} 行${what}，需要完整内容请缩小查询范围）`);
  out = kept.join('\n');
  return out;
}

const n2 = (v: number | null | undefined): string => (v == null ? '—' : v.toFixed(2));
const n3 = (v: number | null | undefined): string => (v == null ? '—' : v.toFixed(3));

export interface ContextSnapshotLike {
  context: SymbolTechnicalContext;
  catalog: CandidateCatalog;
  risk: { structuralStop: number | null; executionStop: number | null; atrPct: number | null; suggestedPositionPct: number | null; maxAccountRiskPct: number; timeStopBars: number | null; gapRiskNote: string | null };
  execution: { chaseGuardAtr: number | null; maxPremiumPct: number | null; nextReviewAt: string };
  marketAction: string;
  primaryAction: string;
  actionReasons: string[];
}

/** 技术上下文 → 文本。每周期只一行读数，结构证据只给 id+时间+价格+确认状态。 */
export function formatTechnicalContext(snap: ContextSnapshotLike): string {
  const c = snap.context;
  const L: string[] = [];

  L.push(`【标的】${c.code} ${c.name}（${c.assetType}）｜数据截至 ${c.asOf}｜数据状态 ${c.dataStatus}`);
  L.push(`【contextId】${c.contextId}（后续取候选与提交计划必须带上）`);
  L.push(`【候选目录】价位 ${c.candidateSummary.levels} 个 / 条件 ${c.candidateSummary.conditions} 个｜catalogHash ${c.candidateSummary.catalogHash}`);

  L.push('【多周期读数】');
  for (const p of c.periods) {
    L.push(
      `- ${p.meta.period}：收 ${n3(p.close)}｜MA20 ${n3(p.ma20)}｜MA60 ${n3(p.ma60)}` +
        `${p.atr != null ? `｜ATR ${n3(p.atr)}(${n2(p.atrPct)}%)` : ''}｜${p.barCount} 根` +
        `｜${p.meta.completeBar ? '已收盘' : '未收完'}${p.meta.adjusted ? '' : '｜未复权'}`,
    );
  }

  if (c.dow) {
    L.push(`【道氏结构】${c.dow.state}`);
    for (const r of c.dow.rationale.slice(0, 3)) L.push(`- ${r}`);
    const sw = c.dow.swings.filter((s) => s.confirmed).slice(-4);
    if (sw.length > 0) {
      L.push(`- 近期确认摆动点：${sw.map((s) => `${s.id}@${n3(s.price)}`).join('，')}`);
    }
  }

  if (c.chan) {
    L.push(`【缠论候选结构】${c.chan.setup}（${c.chan.period}）`);
    for (const r of c.chan.rationale.slice(0, 2)) L.push(`- ${r}`);
    for (const p of c.chan.pivots) {
      L.push(`- 候选中枢 ${p.id}：${n3(p.low)}~${n3(p.high)}${p.active ? '（价格在中枢内）' : ''}`);
    }
    L.push('- 注意：缠论一律是候选，不得单独作为买卖依据，必须与量价确认同时成立');
  }

  if (c.volumePrice) {
    const v = c.volumePrice;
    L.push(
      `【量价】成交额比 ${n2(v.amountRatio20)}` +
        `${v.amountState ? `（${VOLUME_STATE_LABEL[v.amountState]}）` : '（未收完，不构成确认）'}` +
        `｜收盘位置 ${n2(v.closeLocation)}${v.turnoverRate != null ? `｜换手 ${n2(v.turnoverRate)}%` : ''}`,
    );
    L.push(`- ${v.verdict}`);
  }

  L.push(`【统一阶段】${PHASE_LABEL[c.phase.phase]}（${c.phase.phase}）`);
  if (c.phase.pendingPhase) {
    L.push(
      `- 候选阶段 ${PHASE_LABEL[c.phase.pendingPhase]} 已连续 ${c.phase.pendingBars}/${c.phase.requiredBars} 根，未达迁移门槛`,
    );
  }
  if (c.phase.intradayAlert) L.push(`- 盘中预警：${c.phase.intradayAlert}`);
  for (const e of c.phase.evidence.slice(0, 3)) L.push(`- ${e}`);

  if (c.relativeStrength.length > 0) {
    L.push('【相对强弱（超额收益%）】');
    for (const r of c.relativeStrength) {
      L.push(`- vs ${r.benchmarkName}：5日 ${n2(r.rs5)}｜20日 ${n2(r.rs20)}｜60日 ${n2(r.rs60)}｜${r.trend}`);
    }
  }

  if (c.breadth) {
    L.push(`【广度】${c.breadth.missing ? '未覆盖' : '可用'}：${c.breadth.note}`);
  }

  if (c.executionQuality.length > 0) {
    L.push('【执行质量】');
    for (const q of c.executionQuality) L.push(`- ${q.key}：${q.value}${q.missing ? '（未覆盖）' : ''}`);
  }
  if (c.eventRisks.length > 0) {
    L.push('【事件与阻断】');
    for (const e of c.eventRisks.slice(0, 5)) L.push(`- ${e.kind}：${e.note.slice(0, 120)}`);
  }

  // 仓位建议依赖账户权益。账户未接入/取数失败时 suggestedPositionPct 与 executionStop 恒为 null，
  // 此时绝不能沿用「已算定」口吻——那等于告诉 LLM「上限就是没有」，会诱导它按无约束仓位表述。
  const sizingCovered = snap.risk.suggestedPositionPct != null;
  L.push(
    `【后端已算定（你不能修改）】市场动作 ${snap.marketAction}｜账户动作 ${snap.primaryAction}｜` +
      `结构止损 ${n3(snap.risk.structuralStop)}｜执行止损 ${sizingCovered ? n3(snap.risk.executionStop) : '未覆盖'}｜` +
      `单笔风险上限 ${n2(snap.risk.maxAccountRiskPct)}%｜建议仓位上限 ${sizingCovered ? `${n2(snap.risk.suggestedPositionPct)}%` : '未覆盖'}｜` +
      `时间止损 ${snap.risk.timeStopBars ?? '—'} 根`,
  );
  if (!sizingCovered) {
    L.push(
      '- 账户未接入或实时持仓取数失败：建议仓位上限与执行止损本次未覆盖（不是「无上限」）。' +
        '计划正文不得给出具体仓位比例，只写触发/失效与结构止损。',
    );
  }
  for (const r of snap.actionReasons.slice(0, 4)) L.push(`- ${r}`);
  L.push(
    `【执行闸门】追涨保护 ${n2(snap.execution.chaseGuardAtr)}×ATR｜` +
      `折溢价上限 ${snap.execution.maxPremiumPct == null ? '不适用' : `${snap.execution.maxPremiumPct}%`}`,
  );

  if (c.marketRegimePhase || c.boardStage) {
    L.push(`【外部闸门】大盘 ${c.marketRegimePhase ?? '未知'}｜板块 ${c.boardStage ?? '未知'}（只能收紧不能放大）`);
  }
  if (c.activePlan) {
    L.push(`【已有计划】v${c.activePlan.version}（${c.activePlan.status}），本次生成将新增版本并把它置 superseded`);
  }
  L.push(`【图上已有标注】${c.existingMarkCount} 条`);

  if (c.warnings.length > 0) {
    L.push('【数据警告】');
    for (const w of Array.from(new Set(c.warnings)).slice(0, 6)) L.push(`- ${w}`);
  }

  L.push(
    '【下一步】用同一 contextId 调 list_symbol_plan_candidates（先 levels 再 conditions），' +
      '只从候选里挑 ID 组装计划，然后调 save_symbol_trade_plan。禁止自己写价格数字。',
  );

  return capLines(L, CONTEXT_SOFT_LIMIT, '技术上下文');
}

/** 候选目录 → 文本 */
export function formatCandidates(catalog: CandidateCatalog, which: 'levels' | 'conditions'): string {
  const L: string[] = [];
  L.push(`【${which === 'levels' ? '候选价位' : '候选条件'}】contextId ${catalog.contextId}｜catalogHash ${catalog.catalogHash}`);
  L.push(`（提交计划时必须原样带上 contextId、candidateModelVersion=${catalog.candidateModelVersion}、catalogHash）`);

  if (which === 'levels') {
    if (catalog.levels.length === 0) L.push('无候选价位，只能生成观察计划（不给可执行动作）');
    for (const l of catalog.levels) {
      L.push(
        `- ${l.candidateId}｜${n3(l.price)}${l.high > l.low ? `（区间 ${n3(l.low)}~${n3(l.high)}）` : ''}` +
          `｜可选角色 ${l.compatibleRoles.join('/')}｜评分 ${l.score.toFixed(3)}` +
          `${l.atrDistance != null ? `｜距现价 ${l.atrDistance.toFixed(2)}ATR` : ''}` +
          `${l.guaranteed ? '｜保底' : ''}｜${l.description}`,
      );
    }
  } else {
    if (catalog.conditions.length === 0) L.push('无候选条件，只能生成观察计划');
    for (const c of catalog.conditions) {
      // 打来源价位 id 而不是把价位标签整段抄进描述：同一标签在价位目录里已完整列出，
      // 抄第二遍会让条件目录逼近 CATALOG_SOFT_LIMIT，尾部候选被静默裁掉后 LLM 只能猜 id
      L.push(
        `- ${c.candidateId}｜${c.purpose}｜适用 ${c.suitableFor.join('/') || '（无）'}｜${c.timeframe}` +
          `${c.capability === 'live_only' ? '｜实时专用(不可回测)' : ''}` +
          // 不写这句的话，模型只看到「适用」里少了 invalidation，会以为目录漏了东西继续硬填
          `${c.alreadySatisfied ? '｜当前已成立，不可作失效条件' : ''}｜${c.description}` +
          `${c.fromLevelCandidateId ? `｜源 ${c.fromLevelCandidateId}` : ''}`,
      );
    }
  }

  const omitted = Object.entries(catalog.omittedCounts);
  if (omitted.length > 0) {
    L.push(`【已裁剪】${omitted.map(([k, v]) => `${k} ${v} 个`).join('，')}（按评分与上限裁剪，非静默丢弃）`);
  }
  if (catalog.warnings.length > 0) {
    for (const w of catalog.warnings) L.push(`【提示】${w}`);
  }
  L.push(`【有效期】${catalog.expiresAt} 之前有效，过期后需重新取上下文`);

  return capLines(L, CATALOG_SOFT_LIMIT, which === 'levels' ? '候选价位' : '候选条件');
}
