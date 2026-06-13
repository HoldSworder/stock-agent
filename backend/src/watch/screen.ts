import type { WatchConfig, WatchSignal } from '@stock-agent/shared';
import * as gateway from '../agent/gateway';
import { getValue } from '../settings';

// 便宜模型初筛门（多模型路由 pre-filter）：唤醒完整研判 agent 前，
// 用便宜模型一次性判断「该信号值不值得深入研判」，省下贵模型 + 多轮工具调用。
// 解析失败一律保守放行（proceed=true），避免误杀真实信号。

export interface ScreenResult {
  proceed: boolean;
  reason: string;
}

function parse(text: string): ScreenResult {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    const obj = JSON.parse(cleaned) as Partial<ScreenResult>;
    return {
      proceed: obj.proceed !== false, // 缺省视为放行
      reason: typeof obj.reason === 'string' ? obj.reason : '',
    };
  } catch {
    return { proceed: true, reason: '初筛解析失败，保守放行' };
  }
}

/**
 * 轻度模型初筛：仅在全局轻度模型（llmLightModel）非空时调用。
 * 单轮 chat、无工具、限小 token，仅判断是否值得深入研判。
 */
export async function screenSignal(s: WatchSignal, _cfg: WatchConfig): Promise<ScreenResult> {
  const light = getValue('llmLightModel');
  if (!light) return { proceed: true, reason: '未配置轻度模型' };

  const isPosition = s.source === 'position';
  const tag = isPosition ? '持仓卖点' : '自选/异动买点';

  // 按来源给「明确清单」而非模糊的「从严」：持仓卖点漏报代价远大于误报，默认放行，
  // 仅明显无风险的微小噪声才拦截；自选买点可适当从严过滤弱信号。
  const rubric = isPosition
    ? '判定规则（持仓卖点，宁可错放不可漏判）：\n' +
      '- 默认 proceed=true。仅当信号明显是「无风险的微小噪声」（如几乎贴近成本/高点的极小波动、量价无异常）才判 false。\n' +
      '- 关键纠偏：不得因「当日已大幅下跌/已大幅上涨」就把后续的回撤、破位、急跌、跌破成本判为「正常波动」。持仓在大跌途中恰恰更需要深入研判，越跌越要看，不能用大跌当作忽略后续弱化的理由。\n' +
      '- 止盈/止损/破位/急跌/炸板类一律 proceed=true。'
    : '判定规则（自选/异动买点）：\n' +
      '- 仅噪声/极弱、无量价配合的信号判 false；有明确动能、临近涨停、放量异动的判 true。';

  const examples =
    '判例：①持仓当日 -13%、从高点再回撤 3% → proceed=true（大跌中的持续走弱，必须研判）；' +
    '②持仓横盘、贴着高点上下抖动 0.5% → proceed=false（无风险微噪声）。';

  const prompt =
    `你是 A 股盯盘初筛助手。下面是一条${tag}信号，请判断「是否值得调用完整研究流程深入研判」。\n` +
    `标的：${s.name}(${s.code}) 现价${s.price} 当日${s.pct >= 0 ? '+' : ''}${s.pct.toFixed(2)}%\n` +
    `信号：${s.detail}（严重度 ${s.severity}）\n\n` +
    rubric +
    '\n' +
    examples +
    '\n\n只输出 JSON：{"proceed":布尔,"reason":"简短理由"}';

  // 初筛走统一门面：recordRun=false（高频、仅落调用记录、不进运行管理）
  const result = await gateway.call({
    mode: 'oneshot',
    recordRun: false,
    trigger: 'watch',
    purpose: 'watch-screen',
    taskName: '盯盘初筛',
    model: light,
    prompt,
    temperature: 0,
    maxTokens: 120,
  });
  if (result.status !== 'success') {
    // 初筛失败不阻断主流程：保守放行
    console.warn('[watch] 初筛门调用失败，保守放行:', result.error);
    return { proceed: true, reason: '初筛调用失败，保守放行' };
  }
  return parse(result.outputText);
}
