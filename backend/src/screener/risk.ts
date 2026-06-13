import type { ScoredRow } from './scorer';

// 规则风险标签 + 组合行业去集中：在 LLM 研判之外，补一层确定性的风险提示与分散约束，
// 避免 TopN 全压同一行业 / 全是高位涨停股。纯规则、零取数。

/** 基于快照的确定性风险标签（与 LLM riskTags 合并去重） */
export function ruleRiskTags(row: ScoredRow['row']): string[] {
  const tags: string[] = [];
  if (row.pct >= 9) tags.push('高位涨停');
  else if (row.pct >= 7) tags.push('当日大涨');
  if (row.pct <= -7) tags.push('当日暴跌');
  if (row.marketCap != null && row.marketCap < 30) tags.push('微盘股');
  if (row.pe != null && row.pe <= 0) tags.push('当前亏损');
  if (row.turnoverRate != null && row.turnoverRate > 30) tags.push('换手过热');
  return tags;
}

/**
 * 组合行业去集中：按已排序候选取 TopN，同一行业最多 maxPerIndustry 只，
 * 不足 N 时再回补被跳过的，保证产出数量。
 */
export function diversifyByIndustry(
  ranked: ScoredRow[],
  topN: number,
  maxPerIndustry = 3,
): ScoredRow[] {
  const out: ScoredRow[] = [];
  const skipped: ScoredRow[] = [];
  const count = new Map<string, number>();
  for (const c of ranked) {
    if (out.length >= topN) break;
    const ind = c.row.industry || '未知';
    const used = count.get(ind) ?? 0;
    if (used >= maxPerIndustry) {
      skipped.push(c);
      continue;
    }
    count.set(ind, used + 1);
    out.push(c);
  }
  // 数量不足，回补
  for (const c of skipped) {
    if (out.length >= topN) break;
    out.push(c);
  }
  return out;
}
