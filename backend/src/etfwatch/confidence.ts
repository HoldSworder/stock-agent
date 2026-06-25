import type {
  EtfConfirm,
  EtfExecInstruction,
  EtfWatchConfig,
  EtfWatchSignal,
} from '@stock-agent/shared';
import * as gateway from '../agent/gateway';
import { buildEtfWatchContext } from './context';
import {
  applyBuyGuardrails,
  confirmScoreDelta,
  formatConfirmForAgent,
  getEtfConfirm,
} from './confirm';

// 买点置信度：确定性子分打底（零轴 + 多周期共振 + 层级确定性 + 资金/量价确认）+ agent 结合主线/大盘/情绪/资金增信，
// 并由 agent 给出明确动作（建仓/观察/放弃）+ 可闭眼照做的执行指令；确定性护栏兜底改写。
// 卖点不走这里（确定性直发，保证执行果断）。

/** agent 对买点的明确动作裁决 */
export type BuyAction = '建仓' | '观察' | '放弃';

export interface ConfidenceResult {
  /** 0-100 混合置信度 */
  confidence: number;
  /** agent 动作裁决（无 agent 时按置信门给确定性默认） */
  action: BuyAction;
  /** 一句话研判（agent 增信结论；无 agent 为空） */
  advice: string;
  /** 资金/量价确认读数（确定性证据） */
  confirm: EtfConfirm | null;
  /** 可闭眼照做的执行指令（agent 主导 + 护栏兜底） */
  instruction: EtfExecInstruction;
  /** agent 运行 id（无 agent 为 null） */
  runId: string | null;
}

/**
 * 确定性子分（0-100）：零轴上方金叉 +20，多周期共振每多一个周期多头 +8（最多 +24），
 * 日线确认层 +12 / 60m 加仓层 +6（层级越高确定性越强），基线 40。
 */
export function deterministicScore(s: EtfWatchSignal, resonance: number): number {
  let score = 40;
  if (s.dif > 0) score += 20;
  score += Math.max(0, Math.min(3, resonance)) * 8;
  if (s.layer === 3) score += 12;
  else if (s.layer === 2) score += 6;
  return Math.max(0, Math.min(100, score));
}

interface AgentScore {
  confidence: number;
  action: BuyAction;
  advice: string;
  /** agent 给出的指令字段（部分，价位/仓位/止损/失效条件/依据） */
  ins: Partial<{
    entryLow: number;
    entryHigh: number;
    sizePct: number;
    stopLoss: number;
    invalidation: string;
    reason: string;
  }>;
}

/** 归一化 agent 返回的动作文本到三态枚举（缺省/无法识别回退「观察」） */
function normalizeAction(raw: unknown): BuyAction {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (/建仓|买入|加仓|开仓/.test(s)) return '建仓';
  if (/放弃|不建议|回避|观望放弃|不买|看空/.test(s)) return '放弃';
  return '观察';
}

const numOr = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * 在字符串字面量内把裸控制字符（换行/回车/制表）转义为合法 JSON 转义序列。
 * 模型常按「竖排要点」在 advice 里写真实换行，直接 JSON.parse 会因未转义控制字符报错，
 * 历史上导致裁决被静默回退成「观察」，必须先修复再解析。
 */
function escapeControlCharsInStrings(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * 抽取文本中所有顶层 {…} 平衡括号片段（按字符串/转义状态计数，不被字符串内括号或裸换行干扰）。
 * 返回顺序与出现顺序一致，便于优先取最后一个（通常是结论 JSON）。
 */
function balancedObjectSpans(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return spans;
}

const tryParseObject = (s: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * 从可能夹带推理正文 / markdown 表格 / 代码围栏 / 竖排换行的文本中提取结论 JSON 对象。
 * 多重兜底：①```json``` 围栏内容 ②全文平衡括号片段 ③整段裸文本；
 * 每个候选都先原样解析、失败再修复字符串内裸控制字符重试，最大化对模型不严格输出的鲁棒性。
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];

  // ① 围栏内 ```json ... ```（取全部，逐个尝试）
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const inner = m[1]?.trim();
    if (inner) candidates.push(inner);
  }

  // ② 全文平衡括号片段（结论 JSON 多在最后，优先逆序尝试）
  candidates.push(...balancedObjectSpans(text).reverse());

  // ③ 整段裸文本兜底
  candidates.push(text.trim());

  for (const c of candidates) {
    const direct = tryParseObject(c) ?? tryParseObject(escapeControlCharsInStrings(c));
    if (direct) return direct;
    // 候选里可能仍夹带说明文字，再从中抽平衡括号
    for (const span of balancedObjectSpans(c).reverse()) {
      const got = tryParseObject(span) ?? tryParseObject(escapeControlCharsInStrings(span));
      if (got) return got;
    }
  }
  return null;
}

function parseAgentScore(text: string, fallbackAdvice: string): AgentScore {
  const obj = extractJsonObject(text) as Partial<{
    confidence: number;
    action: string;
    advice: string;
    instruction: Record<string, unknown>;
  }> | null;
  if (obj) {
    const conf = Number(obj.confidence);
    const raw = (obj.instruction ?? {}) as Record<string, unknown>;
    return {
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(100, conf)) : 50,
      action: normalizeAction(obj.action),
      advice: typeof obj.advice === 'string' && obj.advice.trim() ? obj.advice.trim() : fallbackAdvice,
      ins: {
        entryLow: numOr(raw.entryLow),
        entryHigh: numOr(raw.entryHigh),
        sizePct: numOr(raw.sizePct),
        stopLoss: numOr(raw.stopLoss),
        invalidation: typeof raw.invalidation === 'string' ? raw.invalidation.trim() : undefined,
        reason: typeof raw.reason === 'string' ? raw.reason.trim() : undefined,
      },
    };
  }
  return { confidence: 50, action: '观察', advice: text.trim() || fallbackAdvice, ins: {} };
}

const TF_LABEL: Record<EtfWatchSignal['timeframe'], string> = {
  '30m': '30分钟',
  '60m': '60分钟',
  day: '日线',
};

/** 组装并经护栏校验的买点执行指令 */
function buildInstruction(
  s: EtfWatchSignal,
  cfg: EtfWatchConfig,
  heldPct: number,
  build: boolean,
  ag: AgentScore['ins'],
  fallbackReason: string,
): EtfExecInstruction {
  const isAdd = heldPct > 0;
  const draft: EtfExecInstruction = {
    action: build ? (isAdd ? '加仓' : '建仓') : '观望',
    layer: s.layer,
    entryLow: ag.entryLow ?? null,
    entryHigh: ag.entryHigh ?? null,
    sizePct: build ? (ag.sizePct ?? s.positionPct) : 0,
    totalAfterPct: build ? heldPct + (ag.sizePct ?? s.positionPct) : heldPct,
    stopLoss: ag.stopLoss ?? null,
    invalidation: ag.invalidation || `日线收盘跌破 MA20 或跌破建仓价 ${cfg.hardStopPct}%`,
    reason: ag.reason || fallbackReason,
    guardrailNote: null,
  };
  if (!build) return draft;
  return applyBuyGuardrails(draft, {
    price: s.price,
    dayPct: s.pct,
    heldPct,
    layerPct: s.positionPct,
    chaseGuardPct: cfg.chaseGuardPct,
    maxTotalPct: cfg.maxTotalPct,
    hardStopPct: cfg.hardStopPct,
  });
}

/** 对一条买点信号给出混合置信度 + 确认读数 + 执行指令（agentConfirmBuy 关闭时仅确定性） */
export async function confirmBuy(
  s: EtfWatchSignal,
  cfg: EtfWatchConfig,
  resonance: number,
  heldPct: number,
): Promise<ConfidenceResult> {
  const confirm = await getEtfConfirm(s.code).catch(() => null);
  const det = Math.max(
    0,
    Math.min(100, deterministicScore(s, resonance) + confirmScoreDelta(confirm)),
  );

  if (!cfg.agentConfirmBuy) {
    const pass = !(cfg.minConfidence > 0 && det < cfg.minConfidence);
    const action: BuyAction = pass ? '建仓' : '观察';
    const instruction = buildInstruction(s, cfg, heldPct, pass, {}, `${TF_LABEL[s.timeframe]}金叉确定性建层`);
    return { confidence: det, action, advice: '', confirm, instruction, runId: null };
  }

  let context = '';
  try {
    context = await buildEtfWatchContext();
  } catch {
    context = '（多源上下文暂不可用）';
  }
  const confirmText = confirm ? formatConfirmForAgent(confirm) : '（资金/量价确认暂不可用）';

  const prompt =
    `ETF 多周期分层战法买点触发，请结合中长期主线/大盘/情绪/资金给出该买点的置信度，并给出可闭眼照做的执行指令。\n` +
    `标的：${s.name}(${s.code})，现价 ${s.price}，当日${s.pct >= 0 ? '+' : ''}${s.pct.toFixed(2)}%，当前已建仓位约 ${heldPct}%。\n` +
    `触发：${TF_LABEL[s.timeframe]} MACD 金叉（DIF ${s.dif} / DEA ${s.dea}），拟建第 ${s.layer} 层（本层目标仓位 ${s.positionPct}%）。\n` +
    `确定性子分（系统已含资金/量价确认）：${det}/100。\n` +
    `${confirmText}\n\n` +
    `核心判断（ETF 中线主升浪聚焦）：以上下文【中长期主线·板块新高宽度】为主依据，并与【ETF 综合研判·中线赛道轮动】交叉验证，` +
    `判断这只 ETF 是否处于【中长期主线赛道】，再看【大盘/情绪】是否配合、【资金/量价确认】是否健康（背离/派发警惕则降权）。\n` +
    `仅当日冲上而中长期主线未确立的按「短期异动」降权。必要时用 mx_finance_data 核验实时量价/资金流。\n\n` +
    `以下为系统各模块最新研判上下文（按时效自行降权）：\n${context}\n\n` +
    `【动作裁决】action：建仓 / 观察 / 放弃，务必与 advice 自洽。\n` +
    `【执行指令】给出 instruction：entryLow/entryHigh（建议买入价区间）、sizePct（本次占总仓位%，参考本层目标 ${s.positionPct}%）、` +
    `stopLoss（止损价，必给）、invalidation（失效条件一句话）、reason（一句话依据）。放弃/观察时指令可留空价位但仍给 invalidation/reason。\n` +
    `【严格输出】只输出一个 JSON，无任何额外文字或代码围栏：\n` +
    `{"action":"建仓|观察|放弃","confidence":0到100的整数,"advice":"一句话结论+关键依据(竖排要点,禁用表格)",` +
    `"instruction":{"entryLow":数字,"entryHigh":数字,"sizePct":数字,"stopLoss":数字,"invalidation":"...","reason":"..."}}`;

  const res = await gateway.call({
    mode: 'agent',
    trigger: 'watch',
    purpose: 'watch-research',
    taskName: `ETF盯盘·${s.name}`,
    prompt,
    modelConfig: { thinking: false, maxSteps: 6 },
    timeoutSec: 150,
  });

  if (res.status !== 'success' || !res.outputText.trim()) {
    const pass = !(cfg.minConfidence > 0 && det < cfg.minConfidence);
    const action: BuyAction = pass ? '建仓' : '观察';
    const instruction = buildInstruction(s, cfg, heldPct, pass, {}, '（agent 研判失败，按确定性子分）');
    return {
      confidence: det,
      action,
      advice: '（agent 研判失败，按确定性子分）',
      confirm,
      instruction,
      runId: res.runId,
    };
  }

  const agent = parseAgentScore(res.outputText, '（无研判正文）');
  const blended = Math.round(det * 0.5 + agent.confidence * 0.5);
  const confidence = Math.max(0, Math.min(100, blended));
  const confidencePass = !(cfg.minConfidence > 0 && confidence < cfg.minConfidence);
  const build = agent.action === '建仓' && confidencePass;
  const instruction = buildInstruction(
    s,
    cfg,
    heldPct,
    build,
    agent.ins,
    agent.advice || `${TF_LABEL[s.timeframe]}金叉`,
  );

  return { confidence, action: agent.action, advice: agent.advice, confirm, instruction, runId: res.runId };
}
