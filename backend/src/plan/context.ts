import type { MarketReviewResult, ResearchOpportunityReport } from '@stock-agent/shared';
import { listMarketReviews, listResearchReviews, listReviews, listTrendSummaries } from '../repo';
import { shanghaiToday } from '../util';

// 今日计划上下文聚合：严格读取热点雷达/研报/大盘/复盘四个模块【最新一次持久化的 AI 分析】，
// 作为盘前生成今日计划的基准。不在此处现场重跑任何重型分析（persist_only），
// 缺失/过期一律显式标注，由计划 agent 据时效自行降权，但不回退现场重算。

/** 容错截断：超长保留头部，避免注入 prompt 撑爆 token */
function clip(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length <= max ? s : `${s.slice(0, max)}\n...[已截断 ${s.length - max} 字符]`;
}

/** 从可能含多余文字的输出中抽取首个完整 JSON 对象并解析（与 service 容错口径一致） */
function parseJsonObject<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** 生成时效标注：当日产出无标注，非当日提示注意时效 */
function freshness(createdAt: string | null): string {
  if (!createdAt) return '（生成时间未知）';
  const date = createdAt.slice(0, 10);
  const today = shanghaiToday();
  return date === today ? `（${createdAt}）` : `（${createdAt}，非当日产出，注意时效）`;
}

/** 热点雷达：最新一次每日热点研判（优先 daily，回退最新一条） */
function buildHotspotBlock(): string {
  const list = listTrendSummaries(5);
  const latest = list.find((r) => r.reportType === 'daily') ?? list[0];
  if (!latest) return '【热点研判·最新】无持久化热点 AI 研判（热点雷达每日研判定时未启用或未产出）。';
  return `【热点研判·最新】${freshness(latest.createdAt)}\n${clip(latest.content, 3000)}`;
}

/** 研报：最新一次「研报机会」结构化分析 */
function buildResearchBlock(): string {
  const latest = listResearchReviews(1)[0];
  if (!latest) return '【研报机会·最新】无持久化研报机会分析（研报每日分析定时未启用或未产出）。';
  const obj = parseJsonObject<Partial<ResearchOpportunityReport>>(latest.outputText);
  if (!obj) return `【研报机会·最新】${freshness(latest.createdAt)}\n（结构化解析失败）\n${clip(latest.outputText, 2000)}`;
  const lines: string[] = [`【研报机会·最新】${freshness(latest.createdAt)}`];
  if (obj.marketDigest) lines.push(`概述：${obj.marketDigest}`);
  if (obj.themeSummary) lines.push(`主线归纳：${obj.themeSummary}`);
  if (obj.hotSectors?.length) {
    lines.push(
      '热门板块：' +
        obj.hotSectors
          .slice(0, 8)
          .map((s) => `${s.name}(研报${s.reportCount ?? 0}/上调${s.upgradeCount ?? 0})`)
          .join('、'),
    );
  }
  if (obj.opportunities?.length) {
    lines.push('个股机会：');
    for (const o of obj.opportunities.slice(0, 12)) {
      lines.push(
        `- ${o.name}(${o.code})[${o.sector || '—'}] ${o.rating || ''}${o.ratingChange ? '·' + o.ratingChange : ''}` +
          `${o.targetPrice ? ' 目标价' + o.targetPrice : ''}${o.reason ? ' 逻辑:' + o.reason : ''}`,
      );
    }
  }
  if (obj.risks?.length) {
    lines.push('风险：' + obj.risks.slice(0, 4).map((r) => r.title).filter(Boolean).join('、'));
  }
  return lines.join('\n');
}

/** 大盘：最新一次「大盘复盘点评」正文 */
function buildMarketBlock(): string {
  const latest = listMarketReviews(1)[0];
  if (!latest?.outputText) return '【大盘复盘点评·最新】无持久化大盘复盘点评（大盘模块定时未启用或未产出）。';
  return `【大盘复盘点评·最新】${freshness(latest.createdAt)}\n${clip(latest.outputText, 2500)}`;
}

/** 复盘：最新一次「一键复盘」综合方向/外围/主线/明日策略 */
function buildReviewBlock(): string {
  const latest = listReviews(3).find((r) => r.outputText);
  if (!latest) return '【一键复盘·最新】无持久化深度复盘（复盘定时未启用或未产出）。';
  const obj = parseJsonObject<Partial<MarketReviewResult>>(latest.outputText);
  if (!obj) return `【一键复盘·最新】${freshness(latest.createdAt)}\n（结构化解析失败）`;
  const lines: string[] = [`【一键复盘·最新】${freshness(latest.createdAt)}`];
  const cs = obj.comprehensiveStance;
  if (cs) {
    lines.push(`综合方向：${cs.bias} —— ${cs.summary ?? ''}`);
    if (cs.drivers?.length) lines.push('关键驱动：' + cs.drivers.join('；'));
  }
  if (obj.mainThemes?.length) {
    lines.push(
      '主线题材：' +
        obj.mainThemes.slice(0, 4).map((t) => `${t.name}(${t.strength})`).join('、'),
    );
  }
  if (obj.strongStocks?.length) {
    lines.push(
      '强势个股：' +
        obj.strongStocks.slice(0, 8).map((s) => `${s.name}(${s.code})`).join('、'),
    );
  }
  if (obj.overseasMarkets?.length) {
    lines.push(
      '外围：' +
        obj.overseasMarkets
          .slice(0, 6)
          .map((o) => `${o.name}(${o.region}) ${o.trend}→${o.impact}`)
          .join('  '),
    );
  }
  if (obj.tomorrowPlan) {
    const tp = obj.tomorrowPlan;
    if (tp.focus?.length) lines.push('次日重点：' + tp.focus.slice(0, 4).join('、'));
    if (tp.positionAdvice) lines.push('仓位建议：' + tp.positionAdvice);
  }
  return lines.join('\n');
}

/**
 * 聚合四源最新 AI 分析为单段文本，供今日计划 agent 一次性读取作为生成基准。
 * 顺序：热点研判 → 研报机会 → 大盘复盘点评 → 一键复盘综合方向。
 */
export function buildPlanContext(): string {
  return [
    `今日计划基准（${shanghaiToday()}）——以下为各模块【最新一次持久化 AI 分析】，缺失/非当日已标注，请据时效自行降权：`,
    buildHotspotBlock(),
    buildResearchBlock(),
    buildMarketBlock(),
    buildReviewBlock(),
  ].join('\n\n');
}
