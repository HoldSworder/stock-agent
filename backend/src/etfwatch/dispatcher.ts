import type {
  EtfExecInstruction,
  EtfTrendStage,
  EtfWatchAlert,
  EtfWatchConfig,
  EtfWatchDisposition,
  EtfWatchSignal,
} from '@stock-agent/shared';
import { sendTelegram } from '../notify/telegram';
import { broadcastEtfWatch } from './bus';
import { confirmBuy } from './confidence';
import { insertEtfAlert, listEtfUndelivered, markEtfDelivered } from './store';

// ETF 盯盘信号分发：买点走置信度管道（agent 增信 + 置信门 + 护栏指令），卖点/硬止损纯确定性直发。
// 仅告警不下单。落库 → WS 广播 → Telegram 推送 + 死信重投。

// 同标的同类买点冷却：key=`${code}:${layer}` → 上次唤醒时间戳(ms)。卖点/硬止损不冷却（执行要果断）。
const buyCooldown = new Map<string, number>();

/** 引擎传入的本轮上下文（共振数 / 已建总仓位 / 趋势阶段） */
export interface ProcessOpts {
  resonance: number;
  heldPct: number;
  trendStage: EtfTrendStage | null;
}

function broadcastDisposition(s: EtfWatchSignal, disposition: EtfWatchDisposition): void {
  broadcastEtfWatch({ type: 'signal', signal: { ...s, disposition } });
}

const TF_LABEL: Record<EtfWatchSignal['timeframe'], string> = {
  '30m': '30分钟',
  '60m': '60分钟',
  day: '日线',
};

function signalTitle(s: EtfWatchSignal): string {
  if (s.type === 'buy_layer') return `建第${s.layer}层买点`;
  if (s.type === 'sell_layer') return `撤第${s.layer}层卖点`;
  return '硬止损';
}

/** 卖点/硬止损的确定性执行指令（直接照做，无 agent） */
function deterministicSellInstruction(s: EtfWatchSignal): EtfExecInstruction {
  return {
    action: s.type === 'hard_stop' ? '清仓' : '减仓',
    layer: s.layer,
    entryLow: null,
    entryHigh: null,
    sizePct: s.positionPct,
    totalAfterPct: null,
    stopLoss: null,
    invalidation: '离场信号已触发，按指令执行',
    reason: s.detail,
    guardrailNote: null,
  };
}

/** 水下/观察留痕的执行指令 */
function watchInstruction(s: EtfWatchSignal, reason: string): EtfExecInstruction {
  return {
    action: '观望',
    layer: s.layer,
    entryLow: null,
    entryHigh: null,
    sizePct: 0,
    totalAfterPct: null,
    stopLoss: null,
    invalidation: '等待信号确认',
    reason,
    guardrailNote: null,
  };
}

async function pushAlert(s: EtfWatchSignal, body: string): Promise<boolean> {
  const text = `【ETF多周期·${signalTitle(s)}】${s.name}(${s.code})\n触发：${s.detail}\n\n${body}`;
  try {
    const r = await sendTelegram(text);
    return r.ok;
  } catch {
    return false;
  }
}

/** 把执行指令拼成可直接照做的一段文本（Telegram / 死信兜底） */
function formatInstruction(ins: EtfExecInstruction): string {
  const parts = [`动作：${ins.action}${ins.layer ? ` L${ins.layer}` : ''}`];
  if (ins.entryLow != null && ins.entryHigh != null)
    parts.push(`价位：${ins.entryLow}-${ins.entryHigh}`);
  if (ins.sizePct > 0) parts.push(`仓位：${ins.sizePct}%${ins.totalAfterPct != null ? `（总仓→${ins.totalAfterPct}%）` : ''}`);
  if (ins.stopLoss != null) parts.push(`止损：${ins.stopLoss}`);
  if (ins.invalidation) parts.push(`失效：${ins.invalidation}`);
  if (ins.guardrailNote) parts.push(`护栏：${ins.guardrailNote}`);
  return parts.join('\n');
}

/**
 * 处理单条信号。返回 confirmed=是否构成「应跟随执行」的动作（引擎据此变更逻辑层状态）。
 * - 买点：positionPct=0 为水下观察（不确认）；置信度 < minConfidence / AI 否决 降级观察（不确认）；否则推送并确认。
 * - 卖点/硬止损：始终确认并推送。
 */
export async function processEtfSignal(
  s: EtfWatchSignal,
  cfg: EtfWatchConfig,
  opts: ProcessOpts,
): Promise<{ confirmed: boolean }> {
  const { resonance, heldPct, trendStage } = opts;
  if (s.type === 'buy_layer') {
    // 水下金叉降级观察：仅落库 + WS，不调 agent、不推送、不建层
    if (s.positionPct <= 0) {
      const alert = insertEtfAlert({
        ...toAlertInput(s),
        confidence: null,
        verdict: '观察',
        advice: '水下金叉（DIF<0），降级观察，不建议建仓',
        confirm: null,
        instruction: watchInstruction(s, '水下金叉（DIF<0），等待站上零轴'),
        trendStage,
        runId: null,
        delivered: false,
      });
      broadcastDisposition(s, 'emitted');
      broadcastEtfWatch({ type: 'alert', alert });
      return { confirmed: false };
    }

    // 买点冷却（防同层跨 bar 反复唤醒 agent）
    const key = `${s.code}:${s.layer}`;
    const last = buyCooldown.get(key);
    if (last != null && Date.now() - last < cfg.cooldownMin * 60_000) {
      broadcastDisposition(s, 'cooldown');
      return { confirmed: false };
    }
    buyCooldown.set(key, Date.now());

    const { confidence, action, advice, confirm, instruction, runId } = await confirmBuy(
      s,
      cfg,
      resonance,
      heldPct,
    );

    // 最终裁决：AI 否决（放弃/观察）或置信不达标 → 降级观察（落库留痕但不推送、不建层）。
    const confidencePass = !(cfg.minConfidence > 0 && confidence < cfg.minConfidence);
    const buildIt = action === '建仓' && confidencePass;

    if (!buildIt) {
      const verdict = action === '放弃' ? '放弃' : '观察';
      const reason =
        action === '建仓'
          ? `置信度 ${confidence} 低于门槛 ${cfg.minConfidence}，降级观察`
          : action === '放弃'
            ? 'AI 研判放弃，不建仓'
            : 'AI 研判观察，暂不建仓';
      const alert = insertEtfAlert({
        ...toAlertInput(s),
        confidence,
        verdict,
        advice: advice || reason,
        confirm,
        instruction,
        trendStage,
        runId,
        delivered: false,
      });
      broadcastDisposition(s, 'low_confidence');
      broadcastEtfWatch({ type: 'alert', alert });
      return { confirmed: false };
    }

    const body = `${formatInstruction(instruction)}\n置信度 ${confidence}/100。\n${advice}`.trim();
    const delivered = cfg.pushTelegram ? await pushAlert(s, body) : false;
    const alert = insertEtfAlert({
      ...toAlertInput(s),
      confidence,
      verdict: '建仓',
      advice: advice || null,
      confirm,
      instruction,
      trendStage,
      runId,
      delivered,
    });
    broadcastDisposition(s, 'to_ai');
    broadcastEtfWatch({ type: 'alert', alert });
    return { confirmed: true };
  }

  // 卖点 / 硬止损：纯确定性直发
  const instruction = deterministicSellInstruction(s);
  const body = `${formatInstruction(instruction)}`;
  const delivered = cfg.pushTelegram ? await pushAlert(s, body) : false;
  const alert = insertEtfAlert({
    ...toAlertInput(s),
    confidence: null,
    verdict: s.type === 'hard_stop' ? '硬止损' : '撤层',
    advice: null,
    confirm: null,
    instruction,
    trendStage,
    runId: null,
    delivered,
  });
  broadcastDisposition(s, 'emitted');
  broadcastEtfWatch({ type: 'alert', alert });
  return { confirmed: true };
}

function toAlertInput(s: EtfWatchSignal) {
  return {
    code: s.code,
    name: s.name,
    signalType: s.type,
    layer: s.layer,
    timeframe: s.timeframe,
    positionPct: s.positionPct,
    detail: s.detail,
    triggerPrice: s.price,
    dif: s.dif,
    dea: s.dea,
    barTime: s.barTime,
  };
}

/** 死信重投：重试应推送但未投递成功的告警（含层数 ≥1 的真实动作告警） */
export async function retryEtfUndelivered(cfg: EtfWatchConfig): Promise<void> {
  if (!cfg.pushTelegram) return;
  for (const a of listEtfUndelivered()) {
    if (!shouldRepush(a)) continue;
    const text = `【ETF多周期·补发】${a.name}(${a.code})\n触发：${a.detail}\n\n${a.advice ?? ''}`;
    try {
      const r = await sendTelegram(text);
      if (r.ok) markEtfDelivered(a.id);
    } catch {
      /* 下个周期再试 */
    }
  }
}

/** 仅重投真实推送动作（观察/低置信降级的留痕告警不补发） */
function shouldRepush(a: EtfWatchAlert): boolean {
  if (a.signalType !== 'buy_layer') return true;
  return a.positionPct > 0 && (a.confidence == null || a.confidence > 0);
}
