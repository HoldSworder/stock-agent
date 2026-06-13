import { getQuotes } from '../market/eastmoney';
import { listPendingOutcomes, setOutcome } from './store';

// 结果反思（对标 TradingAgents reflection）：次交易日回看历史告警是否应验。
// 现价 vs 触发价，按 verdict 方向判 hit/miss/flat，回填后供 buildHistoryNote 注入。

const HIT_THRESHOLD = 1; // 涨跌幅 ±1% 以内视为持平

/** 按结论判断方向期望：涨/跌/中性 */
function expectDir(verdict: string | null): 'up' | 'down' | 'neutral' {
  switch (verdict) {
    case '买入':
    case '关注':
      return 'up';
    case '减仓':
    case '清仓':
      return 'down';
    default:
      return 'neutral';
  }
}

function judge(dir: 'up' | 'down' | 'neutral', pct: number): 'hit' | 'miss' | 'flat' {
  if (dir === 'neutral') return 'flat';
  if (Math.abs(pct) < HIT_THRESHOLD) return 'flat';
  if (dir === 'up') return pct > 0 ? 'hit' : 'miss';
  return pct < 0 ? 'hit' : 'miss';
}

/**
 * 回看所有「创建于今日之前且未回看」的告警，按当前现价回填应验结果。
 * 批量取价，单只失败不影响整体。今日（beforeDay 排除当日）确保已收盘隔日才评。
 */
export async function evaluateOutcomes(today: string): Promise<number> {
  const pending = listPendingOutcomes(today);
  if (pending.length === 0) return 0;

  // 仅对有效触发价的可回看；无价（如板块信号 price=0）直接标 flat
  const valued = pending.filter((a) => a.triggerPrice > 0);
  const codes = [...new Set(valued.map((a) => a.code))];
  let priceMap = new Map<string, number>();
  if (codes.length > 0) {
    try {
      const quotes = await getQuotes(codes);
      priceMap = new Map(quotes.map((q) => [q.code, q.price]));
    } catch (e) {
      console.warn('[watch] 反思回看取价失败:', e instanceof Error ? e.message : e);
      return 0;
    }
  }

  let evaluated = 0;
  for (const a of pending) {
    const now = priceMap.get(a.code);
    if (a.triggerPrice <= 0 || now == null || now <= 0) {
      setOutcome(a.id, 'flat', 0);
      evaluated += 1;
      continue;
    }
    const pct = ((now - a.triggerPrice) / a.triggerPrice) * 100;
    setOutcome(a.id, judge(expectDir(a.verdict), pct), Number(pct.toFixed(2)));
    evaluated += 1;
  }
  return evaluated;
}
