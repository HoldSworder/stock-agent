import type {
  RunStatus,
  WatchAlert,
  WatchConfig,
  WatchDisposition,
  WatchSeverity,
  WatchSignal,
} from '@stock-agent/shared';
import * as gateway from '../agent/gateway';
import { mapDecisionToVerdict, runDecision } from '../decision/service';
import { getValue } from '../settings';
import { getActiveSkills } from '../strategy/skill';
import {
  StrategyError,
  executeSimTrade,
  getStrategy,
  getStrategySnapshot,
} from '../strategy/sim';
import { sendTelegram } from '../notify/telegram';
import { recordWatchTrigger } from '../plan/service';
import { broadcastWatch } from './bus';
import { screenSignal } from './screen';
import {
  findRecentAlertByCode,
  insertAlert,
  listAlertsByCode,
  listUndelivered,
  markDelivered,
} from './store';

// AI Path（Emergency 层）：冷却去重 + 优先级限流 + 缓存复用 + 分流双 prompt
// + runAgent 终审 shouldAlert + 落库 + WS 广播 + Telegram 死信重投。

// 同标的同类信号冷却：key=`${code}:${type}` → 上次唤醒时间戳(ms)
const cooldown = new Map<string, number>();

function cooldownKey(s: WatchSignal): string {
  return `${s.code}:${s.type}`;
}

/** 广播一条带去向标签的信号事件（纯展示，便于前端追溯信号管道落点） */
export function broadcastDisposition(s: WatchSignal, disposition: WatchDisposition): void {
  broadcastWatch({ type: 'signal', signal: { ...s, disposition } });
}

// severity 分级路由收口：把「按严重度差异化处理」统一在此，避免分散判断。
// - 冷却时长：high 更短（更快复盘关键变化），low 更长（更省 LLM）。
// - 是否绕过初筛门：high 直达深入研判（见 processSignal）。
const SEVERITY_COOLDOWN_FACTOR: Record<WatchSeverity, number> = {
  high: 0.5,
  medium: 1,
  low: 1.5,
};

/** 按 severity 分级的冷却毫秒（基准 cfg.cooldownMin） */
function cooldownMsFor(severity: WatchSeverity, cfg: WatchConfig): number {
  return cfg.cooldownMin * 60_000 * SEVERITY_COOLDOWN_FACTOR[severity];
}

/** 终审 JSON 结构 */
interface Verdict {
  shouldAlert: boolean;
  verdict: string;
  advice: string;
}

function parseVerdict(text: string): Verdict {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const obj = JSON.parse(cleaned) as Partial<Verdict>;
    return {
      shouldAlert: Boolean(obj.shouldAlert),
      verdict: typeof obj.verdict === 'string' ? obj.verdict : '',
      advice: typeof obj.advice === 'string' ? obj.advice : text.trim(),
    };
  } catch {
    // 解析失败：保守按「值得提示」处理，正文用原文
    return { shouldAlert: true, verdict: '', advice: text.trim() };
  }
}

/** 该标的近期研判历史摘要（用于对比，避免重复同一逻辑） */
function buildHistoryNote(code: string, lookback: number): string {
  const hist = listAlertsByCode(code, Math.max(1, lookback)).filter((a) => a.adviceText);
  if (hist.length === 0) return '';
  const outcomeLabel = (a: (typeof hist)[number]): string => {
    if (a.outcome === 'hit') return `｜事后:应验(${(a.outcomePct ?? 0).toFixed(1)}%)`;
    if (a.outcome === 'miss') return `｜事后:打脸(${(a.outcomePct ?? 0).toFixed(1)}%)`;
    if (a.outcome === 'flat') return '｜事后:基本持平';
    return '';
  };
  const lines = hist.map((a) => {
    const t = a.createdAt.slice(5, 16).replace('T', ' ');
    return `- ${t}｜结论:${a.verdict || '—'}｜触发:${a.detail}${outcomeLabel(a)}`;
  });
  return (
    '\n\n## 近期对该标的的研判历史（用于对比，勿重复同一逻辑；参考过往结论的事后应验情况，相比上次有变化要指出）\n' +
    lines.join('\n')
  );
}

/** 技术指标客观数据段（C，best-effort，缺失则空） */
function techLine(s: WatchSignal, cfg: WatchConfig): string {
  if (!cfg.techContext) return '';
  const parts: string[] = [];
  if (s.volumeRatio != null) parts.push(`量比 ${s.volumeRatio.toFixed(2)}`);
  if (s.turnoverRate != null) parts.push(`换手 ${s.turnoverRate.toFixed(2)}%`);
  return parts.length > 0 ? `盘中技术：${parts.join('、')}。\n` : '';
}

/** 战法信号触发类型的中文说明（点明本次为何种卖点） */
function triggerNote(type: WatchSignal['type']): string {
  switch (type) {
    case 'take_profit':
      return '本次为【止盈线触发】——浮盈已达战法止盈标准。';
    case 'eod_settle':
      return '本次为【尾盘了结触发】——临近尾盘，战法要求不过夜。';
    case 'strategy_stop':
      return '本次为【战法止损触发】——已跌破战法止损线。';
    case 'weekly_break':
      return '本次为【中线趋势破坏触发】——跌破周线均线或自周线高点明显回撤，中线持有逻辑可能已破坏，请按中线纪律评估是否离场（趋势不破不走、破位坚决走）。';
    case 'drawdown_from_high':
      return '本次为【冲高回落触发】——盘中自高点明显回撤。';
    case 'plan_buy':
      return '本次为【今日计划买点触发】——现价已命中盘前计划设定的买入触发价。';
    case 'plan_stop':
      return '本次为【今日计划止损/卖点触发】——已跌破盘前计划设定的止损或卖出价。';
    case 'plan_take_profit':
      return '本次为【今日计划止盈触发】——现价已达盘前计划设定的止盈价。';
    default:
      return '';
  }
}

/** 注入该战法现行卖出标准（任何带 strategyId 的持仓信号自动生效） */
function buildStrategySellNote(s: WatchSignal): string {
  if (!s.strategyId) return '';
  let sell;
  try {
    sell = getActiveSkills(s.strategyId).sell;
  } catch {
    return '';
  }
  if (!sell?.content?.trim()) return '';
  const note = triggerNote(s.type);
  return (
    `\n\n## 本战法卖出标准（${s.strategyName ?? '战法'} v${sell.version}，须据此研判）\n` +
    (note ? note + '\n' : '') +
    sell.content.trim()
  );
}

function buildPrompt(s: WatchSignal, cfg: WatchConfig): string {
  const head =
    `实时盯盘触发信号：${s.name}(${s.code}) 现价${s.price}，当日${s.pct >= 0 ? '+' : ''}${s.pct.toFixed(2)}%。\n` +
    `触发原因：${s.detail}。\n` +
    techLine(s, cfg) +
    `\n`;

  const adversarial = cfg.adversarial
    ? '研判时先在心里分别列出最强【看多理由】与最强【看空理由】再裁决（降低确认偏差），并把多空关键点体现在 advice 中。\n'
    : '';

  const history = cfg.historyCompare ? buildHistoryNote(s.code, cfg.historyLookback) : '';

  const common =
    '请用 mx_finance_data 核验实时量价/资金流/涨跌停价，必要时用 mx_search 查消息面，交叉验证后判断本次信号是否值得提醒我。\n' +
    adversarial +
    '【严格输出】最终只输出一个 JSON 对象，无任何额外文字或代码围栏：\n';

  // 加仓买点（plan_buy）即便落在持仓标的上，也按【买点研判】框架，避免被当卖点研判
  if (s.source === 'position' && s.type !== 'plan_buy') {
    // 战法持仓：结论会被盯盘自动执行模拟卖出，提示 AI 审慎给结论
    const autoExecNote = s.strategyId
      ? '\n注意：你的 verdict 将被用于自动模拟卖出——【减仓】=卖出当前可卖数量的一半，【清仓】=全部可卖；不卖请给【持有】或【观望】。请严格依据本战法卖出标准审慎决定。\n'
      : '';
    return (
      head +
      '这是我【持仓】标的的卖点信号，请做卖点研判。\n' +
      autoExecNote +
      common +
      '{"shouldAlert":布尔(是否值得推送提醒),"verdict":"持有|减仓|清仓|观望","advice":"一句话结论+关键依据+应对建议(竖排要点,禁用表格)"}' +
      buildStrategySellNote(s) +
      history
    );
  }
  // watch / scan 按买点研判；持仓 plan_buy 为「计划加仓买点」，明确这是已持仓标的的加仓机会
  const buyIntro =
    s.source === 'position'
      ? '这是我【已持仓】标的的计划加仓买点信号，请研判此刻是否宜按计划加仓。\n'
      : '这是我【自选/异动】标的的买点信号，请做买点研判。\n';
  return (
    head +
    buyIntro +
    common +
    '{"shouldAlert":布尔(是否值得推送提醒),"verdict":"关注|买入|跳过","advice":"一句话结论+关键依据+买点建议(竖排要点,禁用表格)"}' +
    history
  );
}

/** 卖出执行结果：附加到告警正文与推送 */
interface SellExecResult {
  /** 是否确有成交 */
  executed: boolean;
  /** 回执或跳过说明（拼入 advice） */
  note: string;
}

/**
 * 通用：本地战法持仓命中卖点且 AI 判减仓/清仓时，自动模拟卖出。
 * 市场规则（交易时段/涨跌停/T+1/100 股/可卖量）全部由 executeSimTrade 强校验。
 * 非本地战法持仓、或结论非减仓/清仓时返回 null（不执行）。
 */
async function maybeExecuteStrategySell(
  s: WatchSignal,
  verdict: Verdict,
  runId: string | null,
): Promise<SellExecResult | null> {
  if (s.source !== 'position' || !s.strategyId) return null;
  const action = verdict.verdict;
  if (action !== '减仓' && action !== '清仓') return null;
  const strategy = getStrategy(s.strategyId);
  if (!strategy || strategy.kind !== 'local') return null;

  // 取当前可卖量（skipSync：本地战法不触发任何外部同步）
  let sellable = 0;
  try {
    const snap = await getStrategySnapshot(s.strategyId, { skipSync: true });
    sellable = snap.positions.find((p) => p.code === s.code)?.sellableQty ?? 0;
  } catch (e) {
    return { executed: false, note: `自动卖出跳过：读取持仓失败（${e instanceof Error ? e.message : e}）` };
  }

  // 清仓=全部可卖；减仓=可卖一半；均向下取整到 100 股
  const qty =
    action === '清仓'
      ? Math.floor(sellable / 100) * 100
      : Math.floor(sellable / 2 / 100) * 100;
  if (qty < 100) {
    return {
      executed: false,
      note: `自动卖出跳过：可卖 ${sellable} 股不足以${action}（当日买入 T+1 锁定或持仓过小）`,
    };
  }

  try {
    const r = await executeSimTrade({
      strategyId: s.strategyId,
      side: 'sell',
      code: s.code,
      qty,
      price: null,
      reason: `盯盘自动卖出·${action}：${s.detail}`,
      runId,
      source: 'watch',
    });
    const t = r.trade;
    return {
      executed: true,
      note: `✅ 盯盘已自动${action}：${t.qty} 股 @ ${t.price.toFixed(2)}，金额 ${t.amount.toFixed(2)}${
        t.realizedProfit != null ? `，实现盈亏 ${t.realizedProfit.toFixed(2)}` : ''
      }`,
    };
  } catch (e) {
    // 市场规则不满足（跌停/非交易时段/可卖不足等）安全跳过
    const msg = e instanceof StrategyError ? e.message : e instanceof Error ? e.message : String(e);
    return { executed: false, note: `自动卖出跳过：${msg}` };
  }
}

/** 处理单条信号：缓存复用 → 唤醒 agent 终审 → 落库 → 广播 → 推送 */
async function processSignal(s: WatchSignal, cfg: WatchConfig): Promise<void> {
  // 近期已对该标的出过研判 → 复用，不再唤醒 LLM（控成本、防刷屏）
  const recent = findRecentAlertByCode(s.code, cfg.cacheReuseMin);
  if (recent) {
    broadcastDisposition(s, 'cache_reused');
    return;
  }

  // 初筛门：轻度模型先判断是否值得深入研判，不值得则落沉默告警直接返回。
  // 确定性兜底（heuristic-first）：severity=high 的信号（止盈/止损/急跌/炸板/计划止损止盈/
  // 大幅回撤等，由 rules.ts 自身阈值定级）直接绕过初筛门进入深入研判，
  // 避免校准偏差的便宜模型误杀关键信号。
  if (getValue('llmLightModel') && s.severity !== 'high') {
    const screen = await screenSignal(s, cfg);
    if (!screen.proceed) {
      const muted = insertAlert({
        code: s.code,
        name: s.name,
        source: s.source,
        signalType: s.type,
        severity: s.severity,
        detail: s.detail,
        runId: null,
        adviceText: screen.reason ? `初筛跳过：${screen.reason}` : '初筛判定不值得深入研判',
        verdict: '跳过(初筛)',
        shouldAlert: false,
        delivered: false,
        triggerPrice: s.price,
        strategyId: s.strategyId ?? null,
        strategyName: s.strategyName ?? null,
        execStatus: null,
        execNote: null,
      });
      broadcastWatch({ type: 'alert', alert: muted });
      return;
    }
  }

  // 终审：个股(主板/创业板，前缀 0/3/6)升级为多 agent 辩论引擎（五大分析师→多空辩论→风控博弈→组合经理裁决）；
  // ETF/场外等非个股标的(前缀 1/5)走原单 agent 终审（决策引擎仅适配 A 股个股）。盯盘只研判不下单。
  let runId: string | null;
  let status: RunStatus;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let verdict: Verdict;
  if (/^[036]\d{5}$/.test(s.code)) {
    // 多 agent 辩论终审：内部各 stage 经 gateway oneshot 计量（recordRun:false，无聚合 runId/token）。
    // runDecision 取数已降级、不裸抛业务错误，按 success 处理。
    const decision = await runDecision(
      { code: s.code, name: s.name, context: `实时盯盘触发：${triggerNote(s.type)}${s.detail}` },
      { purpose: 'watch-decision' },
    );
    runId = null;
    status = 'success';
    promptTokens = undefined;
    completionTokens = undefined;
    verdict = mapDecisionToVerdict(decision);
  } else {
    // 单 agent 终审走统一门面：恒建 run（运行管理）+ 调用记录由 gateway 接管。
    // 盯盘不传 strategy：天然不挂载 mx_trade / sim_trade，只研判不下单。
    const result = await gateway.call({
      mode: 'agent',
      trigger: 'watch',
      purpose: 'watch-research',
      taskName: `盯盘·${s.name}`,
      prompt: buildPrompt(s, cfg),
      modelConfig: { thinking: false, maxSteps: 8 },
      timeoutSec: 180,
    });
    runId = result.runId;
    status = result.status;
    promptTokens = result.promptTokens;
    completionTokens = result.completionTokens;
    // 硬失败（agent 抛错且无任何产出）：run 已被 gateway 记为 error，跳过落库告警
    if (status !== 'success' && !result.outputText.trim()) return;
    verdict = parseVerdict(result.outputText);
  }

  // 通用：本地战法持仓的卖点研判结论自动执行模拟卖出（市场规则由 executeSimTrade 强校验）
  let executed = false;
  let execStatus: 'executed' | 'skipped' | null = null;
  let execNote: string | null = null;
  if (status === 'success') {
    const sell = await maybeExecuteStrategySell(s, verdict, runId);
    if (sell) {
      executed = sell.executed;
      execStatus = sell.executed ? 'executed' : 'skipped';
      execNote = sell.note;
    }
  }

  // 默认沉默：终审认为不值得提醒则只落库不推送；但确有成交属账户动作，必推送
  // 推送正文附带自动卖出回执/跳过原因（落库 adviceText 保持纯研判，回执由 execNote 结构化展示）
  let delivered = false;
  if ((verdict.shouldAlert || executed) && cfg.pushTelegram && status === 'success') {
    const pushAdvice = execNote ? `${verdict.advice}\n${execNote}`.trim() : verdict.advice;
    delivered = await pushAlert(s, pushAdvice);
  }

  const alert: WatchAlert = insertAlert({
    code: s.code,
    name: s.name,
    source: s.source,
    signalType: s.type,
    severity: s.severity,
    detail: s.detail,
    runId,
    adviceText: verdict.advice || null,
    verdict: verdict.verdict || null,
    shouldAlert: verdict.shouldAlert,
    delivered,
    triggerPrice: s.price,
    promptTokens,
    completionTokens,
    strategyId: s.strategyId ?? null,
    strategyName: s.strategyName ?? null,
    execStatus,
    execNote,
  });
  broadcastWatch({ type: 'alert', alert });

  // 今日计划触发命中：回写计划标的状态(triggered)并记 trigger_hit 事件（仅研判，不下单）
  if (s.type === 'plan_buy' || s.type === 'plan_stop' || s.type === 'plan_take_profit') {
    try {
      recordWatchTrigger(s.code, s.type, verdict.advice || s.detail, runId);
    } catch (e) {
      console.warn('[watch] 计划触发回写失败:', e instanceof Error ? e.message : e);
    }
  }
}

/** 推送 Telegram，成功返回 true（失败留待死信重投） */
async function pushAlert(s: WatchSignal, advice: string): Promise<boolean> {
  const tag = s.source === 'position' ? '卖点' : '买点';
  const stratTag = s.strategyName ? `·${s.strategyName}` : '';
  const text = `【盯盘${tag}${stratTag}】${s.name}(${s.code})\n触发：${s.detail}\n\n${advice}`;
  try {
    const r = await sendTelegram(text);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 调度一批信号：按 score 降序，过冷却，限流取前 maxConcurrent，串行研判。
 * 其余信号本轮丢弃（若仍成立下轮会再次触发）。
 */
export async function dispatchSignals(signals: WatchSignal[], cfg: WatchConfig): Promise<void> {
  const now = Date.now();

  const passed = signals
    .filter((s) => {
      const last = cooldown.get(cooldownKey(s));
      if (last != null && now - last < cooldownMsFor(s.severity, cfg)) {
        broadcastDisposition(s, 'cooldown');
        return false;
      }
      return true;
    })
    // 确定性打分门：低于阈值直接沉默，仅广播信号不落库不唤醒（minScore=0 不拦截）
    .filter((s) => {
      if (cfg.minScore > 0 && s.score < cfg.minScore) {
        broadcastDisposition(s, 'low_score');
        return false;
      }
      return true;
    })
    .sort((a, b) => b.score - a.score);

  const limit = Math.max(1, cfg.maxConcurrent);
  const picked = passed.slice(0, limit);
  // 超限流的信号本轮丢弃，标注去向（下轮仍成立会再排）
  for (const s of passed.slice(limit)) broadcastDisposition(s, 'over_capacity');

  for (const s of picked) {
    cooldown.set(cooldownKey(s), now);
    broadcastDisposition(s, 'to_ai');
    try {
      await processSignal(s, cfg);
    } catch (e) {
      console.warn('[watch] 信号处理失败:', e instanceof Error ? e.message : e);
    }
  }
}

/** 死信重投：重试应推送但未投递成功的告警 */
export async function retryUndelivered(cfg: WatchConfig): Promise<void> {
  if (!cfg.pushTelegram) return;
  for (const a of listUndelivered()) {
    const tag = a.source === 'position' ? '卖点' : '买点';
    const text = `【盯盘${tag}·补发】${a.name}(${a.code})\n触发：${a.detail}\n\n${a.adviceText ?? ''}`;
    try {
      const r = await sendTelegram(text);
      if (r.ok) markDelivered(a.id);
    } catch {
      /* 下个周期再试 */
    }
  }
}
