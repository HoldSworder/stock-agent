import type {
  EtfConfirm,
  EtfExecInstruction,
  EtfTrendStage,
  EtfWatchProbe,
  EtfWatchProbeAction,
  EtfWatchProbeBase,
  EtfWatchTfReadout,
  StreamEvent,
} from '@stock-agent/shared';
import * as gateway from '../agent/gateway';
import { getQuotes } from '../market/eastmoney';
import { buildEtfWatchContext } from './context';
import { getEtfWatchConfig } from './config';
import { isEtfCode } from './targets';
import { readDayContext, readTfMacd, type TfMacdReadout } from './macd';
import { getLayerState } from './store';
import {
  applyBuyGuardrails,
  computeTrendStage,
  confirmScoreDelta,
  formatConfirmForAgent,
  getEtfConfirm,
} from './confirm';
import { extractJsonObject } from './confidence';

// 手动检测：对单只 ETF 即时跑一遍多周期 MACD 读数 + 资金/量价确认 + AI 研判 + 执行指令。
// 全程只读：不落库（etf_watch_signals）、不推送 Telegram、不改层状态、不走 WS 信号流。

const TF_LABEL: Record<EtfWatchTfReadout['timeframe'], string> = {
  '30m': '30分钟',
  '60m': '60分钟',
  day: '日线',
  week: '周线',
};

const ACTIONS: EtfWatchProbeAction[] = ['建仓', '加仓', '观察', '减仓', '清仓', '放弃'];

function toReadout(tf: EtfWatchTfReadout['timeframe'], r: TfMacdReadout): EtfWatchTfReadout {
  return {
    timeframe: tf,
    state: r.state,
    dif: r.dif,
    dea: r.dea,
    bullish: r.bullish,
    aboveZero: r.aboveZero,
    barTime: r.barTime,
    close: r.close,
  };
}

/** 归一化 AI 返回的动作文本到枚举（无法识别回退「观察」） */
function normalizeAction(raw: unknown): EtfWatchProbeAction {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const hit = ACTIONS.find((a) => s.includes(a));
  if (hit) return hit;
  if (/买入|开仓/.test(s)) return '建仓';
  if (/卖出|止损|离场/.test(s)) return '减仓';
  if (/回避|不建议|看空/.test(s)) return '放弃';
  return '观察';
}

const numOr = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

interface AgentVerdict {
  action: EtfWatchProbeAction;
  confidence: number | null;
  advice: string;
  instruction: EtfExecInstruction;
  runId: string | null;
}

/** 确定性基线：每多一个周期多头 +12（最多 +36），零轴上方 +12，资金/量价确认增减，基线 40 */
function deterministicBase(resonance: number, aboveZero: boolean, confirm: EtfConfirm | null): number {
  let score = 40;
  score += Math.max(0, Math.min(3, resonance)) * 12;
  if (aboveZero) score += 12;
  score += confirmScoreDelta(confirm);
  return Math.max(0, Math.min(100, score));
}

/** 由 probe 动作 + agent 指令字段组装执行指令（建/加仓经买点护栏，减/清仓直出） */
function buildProbeInstruction(
  action: EtfWatchProbeAction,
  price: number,
  pct: number,
  heldPct: number,
  layer: number | null,
  ag: Partial<{
    entryLow: number;
    entryHigh: number;
    sizePct: number;
    stopLoss: number;
    invalidation: string;
    reason: string;
  }>,
  fallbackReason: string,
): EtfExecInstruction {
  const cfg = getEtfWatchConfig();
  const isAdd = action === '建仓' || action === '加仓';
  const isReduce = action === '减仓' || action === '清仓';
  const insAction: EtfExecInstruction['action'] = isAdd
    ? action
    : isReduce
      ? action
      : '观望';
  const sizePct = ag.sizePct ?? (isAdd ? 20 : isReduce ? (action === '清仓' ? heldPct : 20) : 0);
  const draft: EtfExecInstruction = {
    action: insAction,
    layer,
    entryLow: ag.entryLow ?? null,
    entryHigh: ag.entryHigh ?? null,
    sizePct: insAction === '观望' ? 0 : sizePct,
    totalAfterPct: isAdd ? heldPct + sizePct : isReduce ? Math.max(0, heldPct - sizePct) : heldPct,
    stopLoss: ag.stopLoss ?? null,
    invalidation: ag.invalidation || `日线收盘跌破 MA20 或跌破建仓价 ${cfg.hardStopPct}%`,
    reason: ag.reason || fallbackReason,
    guardrailNote: null,
  };
  if (!isAdd) return draft;
  return applyBuyGuardrails(draft, {
    price,
    dayPct: pct,
    heldPct,
    layerPct: sizePct,
    chaseGuardPct: cfg.chaseGuardPct,
    maxTotalPct: cfg.maxTotalPct,
    hardStopPct: cfg.hardStopPct,
  });
}

export async function aiVerdict(
  code: string,
  name: string,
  price: number,
  pct: number,
  heldLayers: number[],
  readouts: EtfWatchTfReadout[],
  resonance: number,
  confirm: EtfConfirm | null,
  opts?: { onEvent?: (e: StreamEvent) => void; signal?: AbortSignal },
): Promise<AgentVerdict> {
  const cfg = getEtfWatchConfig();
  let context = '';
  try {
    context = await buildEtfWatchContext();
  } catch {
    context = '（多源上下文暂不可用）';
  }
  const confirmText = confirm ? formatConfirmForAgent(confirm) : '（资金/量价确认暂不可用）';

  const tfLines = readouts
    .map(
      (r) =>
        `- ${TF_LABEL[r.timeframe]}：${r.state}，DIF ${r.dif} / DEA ${r.dea}，` +
        `${r.aboveZero ? '零轴上' : '零轴下'}，收盘 ${r.close}（bar ${r.barTime}）`,
    )
    .join('\n');
  const heldPct = heldLayers.reduce(
    (s, l) => s + (l === 1 ? cfg.layer1Pct : l === 2 ? cfg.layer2Pct : cfg.layer3Pct),
    0,
  );
  const heldText = heldLayers.length ? `已建第 ${heldLayers.join('/')} 层（约 ${heldPct}%）` : '当前空仓';

  const prompt =
    `ETF 多周期分层战法·手动检测，请基于多周期 MACD + 资金/量价确认 + 中长期主线/大盘/情绪，` +
    `判断这只 ETF 现在应采取的动作、置信度，并给出可闭眼照做的执行指令。\n` +
    `标的：${name}(${code})，现价 ${price}，当日${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%，${heldText}。\n` +
    `多周期读数：\n${tfLines}\n` +
    `30/60/日线多头共振数：${resonance}/3。\n` +
    `${confirmText}\n\n` +
    `判断要点（ETF 中线主升浪聚焦）：以上下文【中长期主线·板块新高宽度】为主依据，并与【ETF 综合研判·中线赛道轮动】交叉验证，` +
    `判断该 ETF 是否处于【中长期主线赛道】，再看【大盘/情绪】是否配合、【资金/量价确认】是否健康（背离/派发警惕则降权）；` +
    `若已持仓则结合死叉/破位/移动止盈判断是否减/清仓。必要时用 mx_finance_data 核验实时量价/资金流。\n\n` +
    `以下为系统各模块最新研判上下文（按时效自行降权）：\n${context}\n\n` +
    `【动作裁决】action 取：建仓 / 加仓 / 观察 / 减仓 / 清仓 / 放弃，务必与 advice 自洽。\n` +
    `【执行指令】给出 instruction：entryLow/entryHigh（建/加仓买入价区间）、sizePct（本次占总仓位%）、` +
    `stopLoss（止损价）、invalidation（失效条件一句话）、reason（一句话依据）。\n` +
    `【严格输出】只输出一个 JSON，无任何额外文字或代码围栏：\n` +
    `{"action":"建仓|加仓|观察|减仓|清仓|放弃","confidence":0到100的整数,"advice":"一句话结论+关键依据(竖排要点,禁用表格)",` +
    `"instruction":{"entryLow":数字,"entryHigh":数字,"sizePct":数字,"stopLoss":数字,"invalidation":"...","reason":"..."}}`;

  const res = await gateway.call({
    mode: 'agent',
    trigger: 'watch',
    purpose: 'watch-research',
    taskName: `ETF检测·${name}`,
    prompt,
    modelConfig: { thinking: false, maxSteps: 6 },
    timeoutSec: 150,
    onEvent: opts?.onEvent,
    signal: opts?.signal,
  });

  const det = deterministicBase(resonance, readouts.some((r) => r.aboveZero), confirm);
  const topLayer = heldLayers.length ? Math.max(...heldLayers) : heldLayers.length === 0 ? 1 : null;

  if (res.status !== 'success' || !res.outputText.trim()) {
    return {
      action: '观察',
      confidence: det,
      advice: '（agent 研判失败，仅供参考多周期读数）',
      instruction: buildProbeInstruction('观察', price, pct, heldPct, topLayer, {}, '（agent 研判失败）'),
      runId: res.runId,
    };
  }

  const obj = extractJsonObject(res.outputText) as Partial<{
    action: string;
    confidence: number;
    advice: string;
    instruction: Record<string, unknown>;
  }> | null;
  if (obj) {
    const conf = Number(obj.confidence);
    const agentConf = Number.isFinite(conf) ? Math.max(0, Math.min(100, conf)) : 50;
    const blended = Math.round(det * 0.5 + agentConf * 0.5);
    const action = normalizeAction(obj.action);
    const raw = (obj.instruction ?? {}) as Record<string, unknown>;
    const advice =
      typeof obj.advice === 'string' && obj.advice.trim() ? obj.advice.trim() : '（无研判正文）';
    return {
      action,
      confidence: Math.max(0, Math.min(100, blended)),
      advice,
      instruction: buildProbeInstruction(
        action,
        price,
        pct,
        heldPct,
        topLayer,
        {
          entryLow: numOr(raw.entryLow),
          entryHigh: numOr(raw.entryHigh),
          sizePct: numOr(raw.sizePct),
          stopLoss: numOr(raw.stopLoss),
          invalidation: typeof raw.invalidation === 'string' ? raw.invalidation.trim() : undefined,
          reason: typeof raw.reason === 'string' ? raw.reason.trim() : undefined,
        },
        advice,
      ),
      runId: res.runId,
    };
  }
  return {
    action: '观察',
    confidence: det,
    advice: res.outputText.trim(),
    instruction: buildProbeInstruction('观察', price, pct, heldPct, topLayer, {}, '研判解析失败'),
    runId: res.runId,
  };
}

/** 确定性检测：多周期读数 + 资金/量价确认 + 趋势阶段 + 取价 + 层状态（不调 AI，立即可得） */
export async function readEtfProbeBase(code: string): Promise<EtfWatchProbeBase> {
  const c = code.trim();
  if (!isEtfCode(c)) throw new Error(`非法 ETF 代码：${code}`);
  const cfg = getEtfWatchConfig();

  const [r30, r60, rWeek, day] = await Promise.all([
    readTfMacd(c, '30m', cfg.trailLookback),
    readTfMacd(c, '60m', cfg.trailLookback),
    readTfMacd(c, 'week', cfg.trailLookback),
    readDayContext(c, cfg.trailLookback),
  ]);
  if (!r30 || !r60 || !day) throw new Error('多周期 K 线数据不足，无法检测');

  const quotes = await getQuotes([c]).catch(() => []);
  const q = quotes.find((x) => x.code === c);
  const state = getLayerState(c);
  const name = q?.name || state?.name || c;
  const price = q?.price && q.price > 0 ? q.price : day.macd.close;
  const pct = q?.pct ?? 0;

  const readouts: EtfWatchTfReadout[] = [
    toReadout('30m', r30),
    toReadout('60m', r60),
    toReadout('day', day.macd),
  ];
  if (rWeek) readouts.push(toReadout('week', rWeek));

  const resonance = [r30.bullish, r60.bullish, day.macd.bullish].filter(Boolean).length;
  const confirm = await getEtfConfirm(c).catch(() => null);
  const trendStage: EtfTrendStage = computeTrendStage({
    close: day.macd.close,
    ma20: day.ma20,
    ma60: day.ma60,
    dayBullish: day.macd.bullish,
    dayAboveZero: day.macd.aboveZero,
  });

  return {
    code: c,
    name,
    price,
    pct,
    heldLayers: state?.heldLayers ?? [],
    layerEntryPrice: state?.layerEntryPrice ?? {},
    readouts,
    resonance,
    confirm,
    trendStage,
    at: new Date().toISOString(),
  };
}

/** 即时检测单只 ETF：多周期读数 + AI 研判 + 执行指令（只读，无副作用）。非流式兜底，流式走 WS。 */
export async function analyzeEtfTarget(code: string): Promise<EtfWatchProbe> {
  const base = await readEtfProbeBase(code);
  const verdict = await aiVerdict(
    base.code,
    base.name,
    base.price,
    base.pct,
    base.heldLayers,
    base.readouts,
    base.resonance,
    base.confirm,
  );
  return {
    ...base,
    confidence: verdict.confidence,
    action: verdict.action,
    advice: verdict.advice,
    confirm: base.confirm,
    trendStage: base.trendStage,
    instruction: verdict.instruction,
    runId: verdict.runId,
    at: new Date().toISOString(),
  };
}
